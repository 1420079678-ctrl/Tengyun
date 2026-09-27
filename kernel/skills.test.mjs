import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillRegistry, parseSkill, readSnapshotSkill, skillPrompt } from './skills.mjs'
import { createTools } from './tools.mjs'
import { createStore } from './store.mjs'
import { AgentEngine } from './agent.mjs'

const skill = (name = 'test-skill', body = 'Read the project and verify findings.') => `---\nname: ${name}\ndescription: Use when reviewing test fixtures.\n---\n${body}\n`
const config = { baseUrl: 'http://localhost:1234/v1', model: 'fixture', maxSteps: 8, streaming: false }
const call = (name, args) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (content, tool_calls = []) => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: tool_calls.length ? 'tool_calls' : 'stop' }] }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tengyun-skills-'))
  const workspace = join(root, 'workspace'), dataDir = join(root, 'data')
  await mkdir(workspace); await mkdir(dataDir)
  return { root, workspace, dataDir, registry: createSkillRegistry(dataDir), tools: createTools({ dataDir }), store: createStore(dataDir) }
}
async function enabled(f) {
  const s = await f.registry.save({ content: skill() })
  await f.registry.setEnabled({ id: s.id, expectedRevision: s.revision, enabled: true })
  return s
}

test('skills validate frontmatter, names, unsupported extensions and bounded content', () => {
  assert.equal(parseSkill(skill()).name, 'test-skill')
  assert.equal(parseSkill('---\nname: block\ndescription: >\n  first line\n  second line\n---\nWork').description, 'first line second line')
  assert.throws(() => parseSkill(skill('../escape')))
  assert.throws(() => parseSkill(skill('con')))
  assert.throws(() => parseSkill(skill().replace('description:', 'context: fork\ndescription:')), /扩展/)
  assert.throws(() => parseSkill(skill('huge', 'x'.repeat(24001))), /24 KB/)
  assert.throws(() => parseSkill('not a skill'), /SKILL.md/)
})

test('skills lifecycle preserves snapshots, disables edits, guards stale revisions and survives restart', async () => {
  const f = await fixture()
  const saved = await f.registry.save({ content: skill() })
  assert.equal(saved.enabled, false)
  assert.equal((await f.registry.snapshot()).length, 0)
  await f.registry.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision })
  const snapshot = await f.registry.snapshot()
  assert.equal(snapshot.length, 1)
  assert.match(skillPrompt(snapshot, '/test-skill review'), /Explicitly requested enabled skills: \["test-skill"\]/)
  assert.match(skillPrompt([], '$missing'), /Unavailable requests: \["missing"\]/)
  const revised = await f.registry.save({ id: saved.id, expectedRevision: saved.revision, content: skill('test-skill', 'New procedure') })
  assert.equal(revised.enabled, false)
  assert.match(readSnapshotSkill(snapshot, { id: saved.id }).content, /Read the project/)
  assert.equal((await f.registry.snapshot()).length, 0)
  await assert.rejects(f.registry.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision }), /更新/)
  await assert.rejects(f.registry.save({ content: skill() }), /同名/)
  assert.match((await createSkillRegistry(f.dataDir).get(saved.id)).content, /New procedure/)
  await f.registry.remove({ id: saved.id, expectedRevision: revised.revision })
  assert.equal((await f.registry.list()).skills.length, 0)
  assert.ok((await readdir(join(f.dataDir, 'skills'))).some(n => n.endsWith('.bak')))
})

test('skill imports preserve resources but cannot traverse paths, follow junctions or execute scripts', async () => {
  const f = await fixture(), directory = join(f.root, 'package')
  await mkdir(join(directory, 'references'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), skill())
  await writeFile(join(directory, 'references', 'check.md'), 'Expected result: PASS')
  await writeFile(join(directory, 'script.js'), 'throw new Error("must never execute")')
  const imported = await f.registry.importDirectory(directory)
  assert.equal(imported.enabled, false)
  assert.equal(await f.registry.resource(imported.id, 'references/check.md'), 'Expected result: PASS')
  await assert.rejects(f.registry.resource(imported.id, '../settings.json'), /path/)
  await assert.rejects(f.registry.resource(imported.id, '__proto__'), /not found/)
  await symlink(f.workspace, join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.registry.importDirectory(directory), /Symbolic|junction/)
})

test('tampered and malformed skill packages are excluded with visible diagnostics', async () => {
  const f = await fixture(); await enabled(f)
  const path = join(f.dataDir, 'skills', 'test-skill.json')
  const record = JSON.parse(await readFile(path, 'utf8'))
  record.files['SKILL.md'] += '\nInjected content'
  await writeFile(path, JSON.stringify(record))
  const list = await f.registry.list()
  assert.equal(list.skills.length, 0); assert.equal(list.errors.length, 1)
  assert.equal((await f.registry.snapshot()).length, 0)
})

test('skill draft tool enforces approval, redacts secrets and never enables the new skill', async () => {
  const f = await fixture()
  await assert.rejects(f.tools.execute('skill_draft', { content: skill() }, { workspace: f.workspace }), /approval/)
  f.tools.setSecrets(['private-fixture-secret'])
  await f.tools.execute('skill_draft', { content: skill('draft', 'private-fixture-secret') }, { workspace: f.workspace, approved: true })
  const draft = await f.registry.get('draft')
  assert.equal(draft.enabled, false); assert.doesNotMatch(draft.content, /private-fixture-secret/)
  await assert.rejects(f.tools.execute('skill_read', { id: 'draft' }, { workspace: f.workspace }), /未启用/)
})

test('engine advertises enabled skills, loads resources, records revision and separates progress', async () => {
  const f = await fixture(), saved = await enabled(f)
  let turn = 0
  const engine = new AgentEngine({ ...f, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); turn++
    assert.match(body.messages[0].content, /test-skill/)
    if (turn === 1) return response(null, [call('skill_read', { id: saved.id })])
    if (turn === 2) {
      assert.equal(JSON.parse(body.messages.at(-1).content).data.revision, saved.revision)
      return response(null, [call('progress_update', { text: '已经读取技能，正在核对结果。' })])
    }
    return response('检查完成。')
  } })
  const result = await engine.run({ input: '/test-skill review', workspace: f.workspace, config })
  assert.equal(result.status, 'completed')
  const run = await f.store.getRun(result.id)
  assert.equal(run.events.find(e => e.type === 'run:skills').skills[0].revision, saved.revision)
  assert.ok(run.events.some(e => e.type === 'run:progress'))
  assert.equal(result.output, '检查完成。')
})

test('reasoning effort is optional and retries a rejected parameter using provider default', async () => {
  const f = await fixture(); const requests = []
  const engine = new AgentEngine({ ...f, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return requests.length === 1 ? { ok: false, status: 400 } : response('ok')
  } })
  const result = await engine.run({ input: 'test', workspace: f.workspace, config: { ...config, reasoningEffort: 'high' } })
  assert.equal(result.status, 'completed')
  assert.equal(requests[0].reasoning_effort, 'high')
  assert.equal(requests[1].reasoning_effort, undefined)
})

test('parallel specialists are isolated, cannot mutate or recursively delegate, and return audited results', async () => {
  const f = await fixture(); let parentTurn = 0, concurrent = 0, peak = 0
  const childTurns = new Map()
  const engine = new AgentEngine({ ...f, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body), request = body.messages.find(m => m.role === 'user').content
    if (request.startsWith('Role:')) {
      const names = body.tools.map(t => t.function.name)
      assert.ok(!names.includes('file_write')); assert.ok(!names.includes('run_command')); assert.ok(!names.includes('agent_delegate')); assert.ok(!names.includes('skill_draft'))
      assert.doesNotMatch(JSON.stringify(body.messages), /PARENT_PRIVATE_CONTEXT/)
      const count = (childTurns.get(request) || 0) + 1; childTurns.set(request, count)
      concurrent++; peak = Math.max(peak, concurrent)
      await new Promise(r => setTimeout(r, 30)); concurrent--
      if (count === 1) return response(null, [call('file_write', { path: 'forbidden.txt', content: 'no' })])
      assert.equal(JSON.parse(body.messages.at(-1).content).ok, false)
      return response('Read-only findings, no edits.')
    }
    parentTurn++
    if (parentTurn === 1) return response(null, [call('agent_delegate', { tasks: [{ role: 'explore', task: 'Inspect entry points' }, { role: 'review', task: 'Review risks' }] })])
    const results = JSON.parse(body.messages.at(-1).content).agents
    assert.equal(results.length, 2); assert.ok(results.every(r => r.status === 'completed'))
    return response('Combined findings.')
  } })
  const result = await engine.run({ input: 'PARENT_PRIVATE_CONTEXT', workspace: f.workspace, config: { ...config, agentsEnabled: true } })
  assert.equal(result.status, 'completed'); assert.equal(peak, 2)
  assert.deepEqual(await readdir(f.workspace), [])
  const children = (await f.store.listRuns()).filter(r => r.agentParentId === result.id)
  assert.equal(children.length, 2)
  const events = (await f.store.getRun(result.id)).events
  assert.equal(events.filter(e => e.type === 'agent:start').length, 2)
  assert.equal(events.filter(e => e.type === 'agent:complete').length, 2)
})

test('cancelling coordinator cancels active child model requests and settles their records', async () => {
  const f = await fixture(); const started = Promise.withResolvers()
  const engine = new AgentEngine({ ...f, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.messages.find(m => m.role === 'user').content.startsWith('Role:')) {
      started.resolve()
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    }
    return response(null, [call('agent_delegate', { tasks: [{ role: 'plan', task: 'Inspect the project' }] })])
  } })
  const running = engine.run({ id: 'parent', input: 'delegate', workspace: f.workspace, config: { ...config, agentsEnabled: true } })
  await started.promise; engine.cancel('parent')
  assert.equal((await running).status, 'cancelled')
  const records = await f.store.listRuns()
  assert.equal(records.find(r => r.agentParentId === 'parent').status, 'cancelled')
})
