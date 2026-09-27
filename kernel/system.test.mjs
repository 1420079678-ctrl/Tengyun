import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from './store.mjs'
import { createTools } from './tools.mjs'
import { AgentEngine } from './agent.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tengyun-test-'))
  const workspace = join(root, 'workspace'), dataDir = join(root, 'data')
  await mkdir(workspace); await mkdir(dataDir)
  return { root, workspace, dataDir, store: createStore(dataDir), tools: createTools({ dataDir }) }
}
const call = (name, args, id = crypto.randomUUID()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (content, calls = []) => ({ ok: true, json: async () => ({ choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }] }) })
const config = { baseUrl: 'http://localhost:1234/v1', model: 'test-model', maxSteps: 12 }
const task = (status = 'running', evidence = []) => ({ id: 'fix', title: '修复求和并运行验证', dependsOn: [], status, evidence })

test('full coding loop writes a fix, runs a real check and persists evidence and backup', async () => {
  const f = await fixture()
  await writeFile(join(f.workspace, 'add.cjs'), 'module.exports = (a,b) => a-b;\n')
  let turn = 0
  const approvals = [], events = []
  const engine = new AgentEngine({ ...f, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    turn++
    if (turn === 1) return response(null, [call('plan_update', { tasks: [task()] })])
    if (turn === 2) return response(null, [call('file_read', { path: 'add.cjs' })])
    if (turn === 3) return response(null, [call('file_write', { path: 'add.cjs', content: 'module.exports = (a,b) => a+b;\n' })])
    if (turn === 4) return response(null, [call('run_command', { command: 'node -e "if(require(\'./add.cjs\')(2,3)!==5)process.exit(1);console.log(\'PASS\')"' })])
    if (turn === 5) {
      const last = JSON.parse(body.messages.filter(item => item.role === 'tool').at(-1).content)
      assert.equal(last.ok, true); assert.match(last.data.stdout, /PASS/)
      return response(null, [call('plan_update', { tasks: [task('completed', [last.evidenceId])] })])
    }
    return response('已修复并通过求和检查。')
  } })
  const result = await engine.run({ input: '修复加法', workspace: f.workspace, config,
    requestApproval: async request => { approvals.push(request.name); return true }, onEvent: event => events.push(event) })
  assert.equal(result.status, 'completed')
  assert.deepEqual(approvals, ['file_write', 'run_command'])
  assert.match(await readFile(join(f.workspace, 'add.cjs'), 'utf8'), /a\+b/)
  assert.equal(result.evidence.filter(item => item.ok).length, 3)
  const reopened = await createStore(f.dataDir).getRun(result.id)
  assert.equal(reopened.status, 'completed')
  assert.equal(reopened.events.at(-1).type, 'run:complete')
  const backup = (await readdir(join(f.dataDir, 'backups')))[0]
  assert.match(await readFile(join(f.dataDir, 'backups', backup, 'add.cjs'), 'utf8'), /a-b/)
})

test('denied write never modifies a file', async () => {
  const f = await fixture(); let turn = 0
  const engine = new AgentEngine({ ...f, fetchImpl: async () => {
    turn++
    if (turn === 1) return response(null, [call('plan_update', { tasks: [task()] })])
    if (turn === 2) return response(null, [call('file_write', { path: 'denied.txt', content: 'must not exist' })])
    return response('用户拒绝，尚未修改。')
  } })
  const result = await engine.run({ input: '测试拒绝', workspace: f.workspace, config, requestApproval: async () => false })
  assert.equal(result.status, 'incomplete')
  assert.deepEqual(await readdir(f.workspace), [])
})

test('tools reject traversal, junction escape, and missing mutation approval', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'outside.txt'), 'private')
  await assert.rejects(f.tools.execute('file_read', { path: '../outside.txt' }, f), /outside/)
  await symlink(f.root, join(f.workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.tools.execute('file_read', { path: 'escape/outside.txt' }, f), /Symbolic|junction/)
  await assert.rejects(f.tools.execute('file_write', { path: 'no.txt', content: 'no' }, f), /approval/)
  await assert.rejects(f.tools.execute('run_command', { command: 'echo no' }, f), /approval/)
})

test('command timeout is recorded separately from process exit', async () => {
  const f = await fixture()
  const result = await f.tools.execute('run_command', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20', timeoutMs: 500 }, { ...f, approved: true })
  assert.equal(result.timedOut, true)
  assert.equal(result.cancelled, false)
  assert.ok(result.durationMs < 15000)
})

test('cancel aborts a pending model request and persists cancelled state', async () => {
  const f = await fixture(); const started = Promise.withResolvers()
  const engine = new AgentEngine({ ...f, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    started.resolve(); signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  }) })
  const run = engine.run({ id: 'cancel-test', input: 'wait', workspace: f.workspace, config })
  await started.promise; assert.equal(engine.cancel('cancel-test'), true)
  assert.equal((await run).status, 'cancelled')
  assert.equal((await f.store.getRun('cancel-test')).status, 'cancelled')
})

test('failed commands cannot be cited as successful completion evidence', async () => {
  const f = await fixture(); let turn = 0
  const engine = new AgentEngine({ ...f, fetchImpl: async (_url, options) => {
    turn++
    if (turn === 1) return response(null, [call('plan_update', { tasks: [task()] })])
    if (turn === 2) return response(null, [call('run_command', { command: 'exit 7' })])
    if (turn === 3) {
      const last = JSON.parse(JSON.parse(options.body).messages.at(-1).content)
      return response(null, [call('plan_update', { tasks: [task('completed', [last.evidenceId])] })])
    }
    return response('检查失败，需要继续修复。')
  } })
  const result = await engine.run({ input: 'check', workspace: f.workspace, config, requestApproval: async () => true })
  assert.equal(result.status, 'incomplete')
  assert.equal(result.evidence[0].ok, false)
  const run = await f.store.getRun(result.id)
  assert.ok(run.events.some(event => event.type === 'tool:result' && /failed evidence/.test(event.error ?? '')))
})

test('store redacts credentials and can recover a truncated final event', async () => {
  const f = await fixture()
  f.store.setSecrets(['my-private-key-value'])
  const run = await f.store.createRun({ input: 'hello' })
  await f.store.appendEvent(run.id, { type: 'test', content: 'my-private-key-value', apiKey: 'something' })
  const file = join(f.dataDir, 'runs', run.id, 'events.jsonl')
  await writeFile(file, await readFile(file, 'utf8') + '{"partial":')
  const restored = await f.store.getRun(run.id)
  assert.equal(restored.events.length, 1)
  assert.equal(restored.events[0].content, '[REDACTED]')
  await assert.rejects(f.store.writeSettings({ apiKey: 'not-encrypted' }), /Plaintext/)
})

test('multi-turn continuation preserves history and appends to the same run', async () => {
  const f = await fixture()
  let turn = 0
  const engine = new AgentEngine({ ...f, fetchImpl: async (_url, options) => {
    turn++
    const body = JSON.parse(options.body)
    if (turn === 1) return response('第一轮回答：我已经就绪。')
    // On continuation, history should contain the prior messages
    const hasPriorAssistant = body.messages.some(m => m.role === 'assistant' && m.content.includes('第一轮回答'))
    assert.ok(hasPriorAssistant, 'Continuation request must include prior assistant turn')
    return response('第二轮回答：继续为您服务。')
  } })

  // Turn 1
  const run1 = await engine.run({ input: '第一轮提问', workspace: f.workspace, config })
  assert.equal(run1.status, 'completed')
  const saved1 = await f.store.getRun(run1.id)
  assert.ok(saved1.events.length > 0)

  // Turn 2: Continuation
  const run2 = await engine.run({
    id: run1.id,
    input: '第二轮提问',
    workspace: f.workspace,
    config,
    priorRun: saved1,
    isContinuation: true,
  })
  assert.equal(run2.id, run1.id, 'Continuation must maintain the same conversation ID')
  assert.equal(run2.status, 'completed')

  const saved2 = await f.store.getRun(run1.id)
  const userMessages = saved2.events.filter(e => e.type === 'run:message' && e.role === 'user')
  assert.equal(userMessages.length, 2, 'Should have both user turns in the same event log')
  const assistantMessages = saved2.events.filter(e => e.type === 'run:message' && e.role === 'assistant')
  assert.equal(assistantMessages.length, 2, 'Should have both assistant responses in the same event log')
})

test('concurrent parallel tasks run simultaneously without interference', async () => {
  const f = await fixture()
  const engine = new AgentEngine({ ...f, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    const userPrompt = body.messages.find(m => m.role === 'user')?.content || ''
    // Simulate slight async delay
    await new Promise(r => setTimeout(r, 20))
    return response(`处理完成: ${userPrompt}`)
  } })

  const [p1, p2] = await Promise.all([
    engine.run({ input: '任务A', workspace: f.workspace, config }),
    engine.run({ input: '任务B', workspace: f.workspace, config }),
  ])

  assert.notEqual(p1.id, p2.id, 'Parallel runs must have distinct IDs')
  assert.equal(p1.status, 'completed')
  assert.equal(p2.status, 'completed')
  assert.match(p1.output, /任务A/)
  assert.match(p2.output, /任务B/)
})

test('store.deleteRun safely removes task directory and history', async () => {
  const f = await fixture()
  const runRecord = await f.store.createRun({ input: '待删除任务' })
  await f.store.appendEvent(runRecord.id, { type: 'run:message', role: 'user', content: '测试内容' })

  const listBefore = await f.store.listRuns()
  assert.ok(listBefore.some(r => r.id === runRecord.id))

  const delResult = await f.store.deleteRun(runRecord.id)
  assert.equal(delResult.ok, true)
  assert.equal(delResult.id, runRecord.id)

  const listAfter = await f.store.listRuns()
  assert.ok(!listAfter.some(r => r.id === runRecord.id), 'Deleted run must not be present in listRuns')

  const fetched = await f.store.getRun(runRecord.id)
  assert.equal(fetched, null, 'Deleted run must return null on getRun')
})

test('AgentEngine.run processes attachments and passes multimodal image_url and file previews', async () => {
  const f = await fixture()
  let capturedBody = null
  const engine = new AgentEngine({
    ...f,
    fetchImpl: async (_url, options) => {
      capturedBody = JSON.parse(options.body)
      return response('已成功分析上传的图片与代码文件。')
    },
  })

  const fakeAttachments = [
    { name: 'mockup.png', size: 10240, ext: 'png', isImage: true, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
    { name: 'config.json', size: 512, ext: 'json', isImage: false, textContent: '{\n  "version": "1.0.0"\n}' },
  ]

  const run = await engine.run({
    input: '请根据原型图和配置文件进行开发',
    workspace: f.workspace,
    config,
    attachments: fakeAttachments,
  })

  assert.equal(run.status, 'completed')
  assert.ok(capturedBody, 'Model call must have been made')

  // Check last user message content
  const lastUserMsg = capturedBody.messages[capturedBody.messages.length - 1]
  assert.ok(Array.isArray(lastUserMsg.content), 'Multimodal request must send content array')
  const textItem = lastUserMsg.content.find(c => c.type === 'text')
  assert.ok(textItem.text.includes('mockup.png'))
  assert.ok(textItem.text.includes('config.json'))
  assert.ok(textItem.text.includes('"version": "1.0.0"'))

  const imageItem = lastUserMsg.content.find(c => c.type === 'image_url')
  assert.ok(imageItem, 'Multimodal request must include image_url object')
  assert.equal(imageItem.image_url.url, fakeAttachments[0].dataUrl)

  // Verify attachments are persisted in run events
  const savedRun = await f.store.getRun(run.id)
  const userMsgEvent = savedRun.events.find(e => e.type === 'run:message' && e.role === 'user')
  assert.ok(userMsgEvent.attachments && userMsgEvent.attachments.length === 2, 'Attachments must be stored in run message event')
})

