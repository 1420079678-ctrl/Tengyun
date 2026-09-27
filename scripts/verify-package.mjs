/** Real packaged Electron smoke with a local model fixture, no paid API calls. */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let playwright
try { playwright = createRequire(join(source, 'package.json'))('playwright') }
catch { playwright = createRequire(join(source, '../app/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/package.json'))('playwright') }
const executable = resolve(process.argv[2] ?? 'D:/Tengyun/Tengyun.exe')
const root = await mkdtemp(join(tmpdir(), 'tengyun-desktop-test-'))
const home = join(root, 'data'), workspace = join(root, 'workspace')
await mkdir(home); await mkdir(workspace)
await writeFile(join(home, 'settings.json'), JSON.stringify({ workspace }))
const toolCall = (name, args) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
const task = (status = 'running', evidence = []) => ({ id: 'write', title: '创建验证文件', dependsOn: [], status, evidence })
let turn = 0
const server = createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk
  const body = JSON.parse(text)
  turn++
  let calls = [], content = null
  if (turn === 1) calls = [toolCall('plan_update', { tasks: [task()] })]
  else if (turn === 2) calls = [toolCall('file_write', { path: 'verified.txt', content: 'Tengyun packaged app verified\n' })]
  else if (turn === 3) calls = [toolCall('plan_update', { tasks: [task('completed', [JSON.parse(body.messages.at(-1).content).evidenceId])] })]
  else content = '已创建 verified.txt，操作结果已记录。'
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } }] }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const environment = { ...process.env, TENGYUN_HOME: home }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.TENGYUN_IMPORT_SETTINGS
let electron
try {
  electron = await playwright._electron.launch({ executablePath: executable, env: environment, timeout: 30000 })
  const page = await electron.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const info = await page.evaluate(() => window.tengyun.info())
  assert.equal(info.name, 'Tengyun')
  assert.equal(info.home, home)
  const security = await electron.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox }
  })
  assert.deepEqual(security, { nodeIntegration: false, contextIsolation: true, sandbox: true })
  await page.evaluate(async ({ port }) => {
    await window.tengyun.saveSettings({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'local-test', maxSteps: 12 })
    window.testEvents = []
    window.tengyun.onEvent(event => {
      window.testEvents.push(event)
      if (event.type === 'approval:request') window.tengyun.approve({ approvalId: event.approvalId, approved: true })
    })
    await window.tengyun.run({ input: '创建 verified.txt，内容为 Tengyun packaged app verified' })
  }, { port })
  await page.waitForFunction(() => window.testEvents.some(event => event.type === 'run:settled'), { timeout: 30000 })
  const events = await page.evaluate(() => window.testEvents)
  const result = events.find(event => event.type === 'run:complete')
  assert.equal(result?.status, 'completed', JSON.stringify(events.filter(event => event.type === 'run:error')))
  assert.equal(await readFile(join(workspace, 'verified.txt'), 'utf8'), 'Tengyun packaged app verified\n')
  assert.ok(events.some(event => event.type === 'approval:request'))
  const runs = await page.evaluate(() => window.tengyun.listRuns())
  assert.equal(runs[0].status, 'completed')
  await page.screenshot({ path: join(root, 'desktop.png') })
  console.log(JSON.stringify({ passed: true, executable, modelCalls: turn, evidenceCount: result.evidence.length, security, screenshot: join(root, 'desktop.png'), testHome: home }, null, 2))
} finally {
  await electron?.close()
  await new Promise(resolve => server.close(resolve))
}
