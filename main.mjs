/** Tengyun desktop owns model credentials, task execution and all privileged IPC. */
import { app, BrowserWindow, dialog, ipcMain, safeStorage, Menu, nativeTheme } from 'electron'
import { mkdirSync, existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createStore } from './kernel/store.mjs'
import { createTools } from './kernel/tools.mjs'
import { AgentEngine } from './kernel/agent.mjs'

const source = dirname(fileURLToPath(import.meta.url))
const installation = app.isPackaged ? dirname(process.execPath) : source
const home = process.env.TENGYUN_HOME || join(installation, 'data')
if (!isAbsolute(home)) throw new Error('TENGYUN_HOME must be an absolute path')
mkdirSync(home, { recursive: true })
mkdirSync(join(home, 'electron-profile'), { recursive: true })
let workspace = join(installation, 'workspace')
mkdirSync(workspace, { recursive: true })
app.setName('Tengyun')
app.setAppUserModelId('com.tengyun.agent')
app.setPath('userData', join(home, 'electron-profile'))
let window
let engine
let store
let tools
let activeRun
let activePromise
let stopping = false
let settings
const approvals = new Map()
const uiUrl = pathToFileURL(join(source, 'ui/index.html')).href
const defaultSettings = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', maxSteps: 60, approval: 'always', streaming: true }
const APPROVAL_MODES = new Set(['always', 'session', 'never'])
const MAX_STEP_LIMIT = 200

function publicSettings() {
  return { baseUrl: settings.baseUrl, model: settings.model, maxSteps: settings.maxSteps,
    approval: settings.approval ?? 'always', streaming: settings.streaming !== false,
    appearance: settings.appearance ?? 'dark', hasApiKey: Boolean(settings.encryptedApiKey), workspace }
}
function secret() {
  if (!settings.encryptedApiKey) return ''
  return safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, 'base64'))
}
function send(event) {
  if (window && !window.isDestroyed()) window.webContents.send('tengyun:event', event)
}
function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
    throw new Error('Rejected IPC sender')
  }
}
function handle(name, callback) {
  ipcMain.handle('tengyun:' + name, async (event, value) => { trusted(event); return callback(value) })
}
async function saveSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('模型配置格式不正确')
  const baseUrl = String(input.baseUrl ?? settings.baseUrl).trim().replace(/\/+$/, '')
  const url = new URL(baseUrl)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址需要 HTTPS；本地模型可以使用 localhost HTTP')
  }
  const model = String(input.model ?? settings.model).trim()
  const maxSteps = Number(input.maxSteps ?? settings.maxSteps)
  const approval = String(input.approval ?? settings.approval ?? 'always')
  if (!model || model.length > 200 || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEP_LIMIT) {
    throw new Error(`请填写模型名称；执行轮数应为 1–${MAX_STEP_LIMIT}`)
  }
  if (!APPROVAL_MODES.has(approval)) throw new Error('未知的确认模式')
  const next = { ...settings, baseUrl, model, maxSteps, approval, streaming: input.streaming === undefined ? settings.streaming !== false : Boolean(input.streaming) }
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，未保存 API Key')
    next.encryptedApiKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64')
  }
  await store.writeSettings(next)
  settings = next
  return publicSettings()
}
function requestApproval(request) {
  const approvalId = randomUUID()
  return new Promise(resolve => {
    const finish = approved => {
      approvals.delete(approvalId)
      request.signal?.removeEventListener('abort', abort)
      resolve(approved)
    }
    const abort = () => finish(false)
    if (request.signal?.aborted) return resolve(false)
    approvals.set(approvalId, { runId: request.runId, finish })
    request.signal?.addEventListener('abort', abort, { once: true })
    const { signal: _signal, ...details } = request
    send({ ...details, type: 'approval:request', approvalId })
  })
}

async function start() {
  store = createStore(home)
  settings = { ...defaultSettings, ...await store.readSettings() }
  nativeTheme.themeSource = (settings.appearance ?? 'dark') === 'light' ? 'light' : 'dark'
  if (settings.workspace && existsSync(settings.workspace)) workspace = realpathSync(settings.workspace)
  // One-time local migration can pass a credential in the child environment; erase it before tools run.
  const imported = process.env.TENGYUN_IMPORT_SETTINGS
  delete process.env.TENGYUN_IMPORT_SETTINGS
  if (imported && !settings.encryptedApiKey) await saveSettings(JSON.parse(imported))
  // A killed process leaves records visible as interrupted, never as completed.
  for (const run of await store.listRuns()) {
    if (['running', 'pending', 'waiting_approval'].includes(run.status)) await store.updateRun(run.id, { status: 'interrupted' })
  }
  tools = createTools({ dataDir: home })
  engine = new AgentEngine({ store, tools })
  handle('info', () => ({ name: 'Tengyun', version: app.getVersion(), home, workspace, settings: publicSettings() }))
  handle('saveSettings', saveSettings)
  handle('setTheme', async value => {
    if (!['light', 'dark'].includes(value)) throw new Error('Invalid theme')
    nativeTheme.themeSource = value
    settings.appearance = value
    await store.writeSettings(settings)
    window?.setBackgroundColor(value === 'dark' ? '#0c0c0d' : '#ffffff')
    return value
  })
  handle('chooseWorkspace', async () => {
    if (activeRun) throw new Error('任务执行期间不能切换工作目录')
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], defaultPath: workspace })
    if (result.canceled) return null
    workspace = realpathSync(result.filePaths[0])
    settings.workspace = workspace
    await store.writeSettings(settings)
    return workspace
  })
  handle('listRuns', () => store.listRuns())
  handle('getRun', id => { if (typeof id !== 'string') throw new Error('Invalid task id'); return store.getRun(id) })
  handle('run', input => {
    if (activeRun) throw new Error('当前任务仍在执行')
    if (typeof input?.input !== 'string' || !input.input.trim() || input.input.length > 100000) throw new Error('请输入任务，最长 100000 字符')
    const url = new URL(settings.baseUrl)
    if (!settings.encryptedApiKey && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('请先在模型设置中保存 API Key')
    const id = randomUUID()
    activeRun = id
    // Only the native directory picker can authorize a new workspace.
    const config = { ...publicSettings(), apiKey: secret() }
    store.setSecrets([config.apiKey])
    tools.setSecrets([config.apiKey])
    setImmediate(async () => {
      if (stopping || activeRun !== id) return
      // Continuing a task reuses the prior run's conversation, plan and recent tool results.
      let priorRun = null
      if (typeof input.parentId === 'string' && input.parentId) {
        try { priorRun = await store.getRun(input.parentId) } catch (error) { priorRun = null }
      }
      activePromise = engine.run({ id, input: input.input.trim(), workspace, config, priorRun, requestApproval, onEvent: send })
        .catch(error => send({ type: 'run:error', runId: id, error: String(error.message).replaceAll(config.apiKey || '\0', '[redacted]') }))
        .finally(() => {
          activeRun = undefined
          activePromise = undefined
          for (const pending of approvals.values()) if (pending.runId === id) pending.finish(false)
          send({ type: 'run:settled', runId: id })
        })
    })
    return { id }
  })
  handle('cancel', id => { if (id === activeRun) engine.cancel(id); return true })
  handle('approve', value => {
    if (typeof value?.approvalId !== 'string' || typeof value.approved !== 'boolean') throw new Error('Invalid approval')
    const pending = approvals.get(value.approvalId)
    if (!pending || pending.runId !== activeRun) throw new Error('操作确认已失效')
    pending.finish(value.approved)
    return true
  })
  Menu.setApplicationMenu(null)
  window = new BrowserWindow({ width: 1480, height: 960, minWidth: 1000, minHeight: 680, title: 'Tengyun',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0c0d' : '#ffffff', icon: join(process.resourcesPath, 'icon.png'),
    webPreferences: { preload: join(source, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault() })
  window.on('page-title-updated', event => event.preventDefault())
  window.on('closed', () => {
    if (activeRun) engine.cancel(activeRun)
    for (const pending of approvals.values()) pending.finish(false)
    window = undefined
  })
  await window.loadURL(uiUrl)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    stopping = true
    if (activeRun) engine?.cancel(activeRun)
    for (const pending of approvals.values()) pending.finish(false)
    if (activePromise) {
      event.preventDefault()
      void activePromise.finally(() => app.quit())
    }
  })
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('Tengyun 启动失败', String(error.message)); app.exit(1) })
}
