/** Diagnose a blank renderer: dump console output, exceptions and a DOM census. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const store = 'D:/DeepSeekHarness/app/node_modules/.pnpm'
const electronDir = join(store, readdirSync(store).find(entry => entry.startsWith('electron@')), 'node_modules', 'electron', 'dist')
const PORT = 9337
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const appDir = process.argv[2] || 'D:/Tengyun/source'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
if (process.env.DIAG_HOME) env.TENGYUN_HOME = process.env.DIAG_HOME
const app = spawn(join(electronDir, 'electron.exe'), [appDir, `--remote-debugging-port=${PORT}`, '--no-sandbox'], { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true })
let stderr = ''
app.stderr.on('data', chunk => { stderr += chunk })
app.stdout.on('data', chunk => { stderr += chunk })
await sleep(5000)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find(item => item.type === 'page')
if (!page) { console.log('NO PAGE TARGET', stderr.slice(-1500)); process.exit(1) }
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let id = 0
const pending = new Map()
const events = []
socket.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.method) {
    if (message.method === 'Runtime.exceptionThrown') events.push('EXCEPTION ' + (message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text))
    if (message.method === 'Runtime.consoleAPICalled') events.push(message.params.type.toUpperCase() + ' ' + message.params.args.map(a => a.value ?? a.description ?? '').join(' '))
    if (message.method === 'Log.entryAdded') events.push('LOG[' + message.params.entry.level + '] ' + message.params.entry.text + ' @ ' + (message.params.entry.url || ''))
    return
  }
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

await send('Runtime.enable')
await send('Log.enable')
await sleep(1200)
console.log('URL', page.url)
console.log('DOM', JSON.stringify(await evaluate(`(() => ({
  ready: document.readyState,
  bodyLen: document.body.innerHTML.length,
  sidebar: Boolean(document.querySelector('.sidebar')),
  review: Boolean(document.querySelector('.review')),
  composer: Boolean(document.querySelector('#task-form')),
  guide: Boolean(document.querySelector('.guide')),
  theme: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.body).backgroundColor,
}))()`)))
console.log('CONSOLE')
for (const line of events.slice(-25)) console.log(' ', line)
if (stderr.trim()) { console.log('MAIN'); console.log(stderr.split('\n').slice(-12).join('\n')) }
app.kill()
await sleep(300)
process.exit(0)
