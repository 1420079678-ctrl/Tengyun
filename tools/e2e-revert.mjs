/**
 * End-to-end test of the run rollback: drive a real task that writes a file, then press the
 * panel's revert button and assert the file on disk is back to its pre-run content and the
 * run's own creation is removed.
 *
 * Usage: node tools/e2e-revert.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildE2eSettings } from './e2e-settings.mjs'

const require = createRequire(import.meta.url)
const ROOT = 'D:/Tengyun'
const HOME = join(ROOT, 'e2e-revert-home')
const WORKSPACE = join(ROOT, 'e2e-revert-workspace')
const STUB_PORT = 13509
const DEBUG_PORT = 9344
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const ORIGINAL = '# 旧文档\n\n第一行：原始内容。\n第二行：将被替换。\n第三行：保持不变。\n'
const NEW_FILE = join(WORKSPACE, 'CREATED.md')

rmSync(HOME, { recursive: true, force: true })
rmSync(WORKSPACE, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })
writeFileSync(join(WORKSPACE, 'NOTES.md'), ORIGINAL)
writeFileSync(join(HOME, 'settings.json'), JSON.stringify(
  buildE2eSettings({ stubPort: STUB_PORT, workspace: WORKSPACE.replace(/\//g, '/') }), null, 2))

const store = 'D:/DeepSeekHarness/app/node_modules/.pnpm'
const electronDir = join(store, readdirSync(store).find(entry => entry.startsWith('electron@')), 'node_modules', 'electron', 'dist')

// A stub that reads NOTES.md, rewrites it, and creates CREATED.md — two different undo paths.
const stub = spawn(process.execPath, [join(ROOT, 'tools/stub-model.mjs'), String(STUB_PORT), '--mode', 'revert'], { stdio: 'ignore', windowsHide: true })
await sleep(700)

const env = { ...process.env, TENGYUN_HOME: HOME, TENGYUN_DEBUG: '' }
delete env.ELECTRON_RUN_AS_NODE
const app = spawn(join(electronDir, 'electron.exe'), [join(ROOT, 'source'), `--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox'], { stdio: 'ignore', env, windowsHide: true })

async function findPage(retries = 40) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      const page = list.find(item => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('no debuggable page')
}

const page = await findPage()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let id = 0
const pending = new Map()
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const next = ++id
  pending.set(next, { resolve, reject })
  socket.send(JSON.stringify({ id: next, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed')
  return result.result?.value
}

await sleep(2500)
const task = '请改写 NOTES.md，并新建 CREATED.md。'
await evaluate(`(() => {
  const input = document.getElementById('task-input')
  input.value = ${JSON.stringify(task)}
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.getElementById('task-form').requestSubmit()
  return true
})()`)

let approvals = 0
for (let tick = 0; tick < 120; tick++) {
  await sleep(500)
  const state = await evaluate(`(() => ({
    dialog: document.getElementById('approval-dialog').open,
    idle: document.getElementById('cancel-run').hidden,
    changes: document.querySelectorAll('.changes-row').length,
    revertVisible: !document.getElementById('change-actions').hidden,
    reject: document.getElementById('approval-deny') ? 1 : 0,
  }))()`)
  if (state.dialog) {
    approvals += 1
    await evaluate(`(() => { document.getElementById('approval-approve')?.click() || document.getElementById('approval-dialog').querySelector('button.primary')?.click(); return true })()`)
    await sleep(200)
  }
  if (state.idle && tick > 4) break
}

console.log('approvals:', approvals)
console.log('NOTES.md after run:', JSON.stringify(readFileSync(join(WORKSPACE, 'NOTES.md'), 'utf8').slice(0, 60)))
console.log('CREATED.md exists after run:', existsSync(NEW_FILE))

const panel = await evaluate(`(() => ({
  rows: document.querySelectorAll('.changes-row').length,
  revertVisible: !document.getElementById('change-actions').hidden,
  note: document.getElementById('revert-note').textContent,
}))()`)
console.log('panel:', JSON.stringify(panel))

// Press the real button, with the confirm dialog auto-accepted.
await evaluate(`(() => { window.confirm = () => true; return true })()`)
await evaluate(`(() => { document.getElementById('revert-run').click(); return true })()`)
await sleep(2500)

const after = {
  notes: readFileSync(join(WORKSPACE, 'NOTES.md'), 'utf8'),
  created: existsSync(NEW_FILE),
}
console.log('NOTES.md after revert:', JSON.stringify(after.notes.slice(0, 60)))
console.log('CREATED.md exists after revert:', after.created)
console.log('NOTES restored:', after.notes === ORIGINAL)
console.log('creation undone:', after.created === false)

app.kill()
stub.kill()
await sleep(400)
const pass = after.notes === ORIGINAL && after.created === false
console.log(pass ? 'RESULT: rollback verified' : 'RESULT: rollback FAILED')
process.exit(pass ? 0 : 1)
