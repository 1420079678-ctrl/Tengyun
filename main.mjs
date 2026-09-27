import { fetchModels, fetchBalance, providerUrl } from './kernel/provider-info.mjs'
/** Tengyun desktop owns model credentials, task execution and all privileged IPC. */
import { app, BrowserWindow, dialog, ipcMain, safeStorage, Menu, nativeTheme, protocol, net } from 'electron'
import { mkdirSync, existsSync, realpathSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, basename, extname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { createStore } from './kernel/store.mjs'
import { createTools } from './kernel/tools.mjs'
import { AgentEngine } from './kernel/agent.mjs'
import { collectWorkspaceTelemetry } from './kernel/telemetry.mjs'

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
const activeRuns = new Map()
let stopping = false
let settings
const approvals = new Map()
const uiUrl = pathToFileURL(join(source, 'ui/index.html')).href

// A dedicated scheme lets the renderer show the wallpaper without shipping megabytes of base64
// through IPC (a CSS custom property that large is dropped silently by the style engine).
protocol.registerSchemesAsPrivileged([
  { scheme: 'tengyun-wallpaper', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const PRESET_PROVIDERS = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek 官方',
    type: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    description: 'DeepSeek-V3 快速推理与 R1 深度推演',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow (硅基流动)',
    type: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-Coder-32B-Instruct'],
    description: '超高并发极速中继，全尺寸开源模型',
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    models: ['gpt-4o', 'o1', 'o3-mini', 'gpt-4o-mini'],
    description: 'OpenAI 全系列商业旗舰与推理模型',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    description: '超长百万 Token 上下文与多模态极速推理',
  },
  {
    id: 'ollama',
    name: 'Ollama / 本地私有化',
    type: 'local',
    baseUrl: 'http://localhost:11434/v1',
    model: 'deepseek-r1:latest',
    models: ['deepseek-r1:latest', 'qwen2.5-coder:latest'],
    description: '本地完全离线私有化模型，零网络依赖',
  },
  {
    id: 'custom',
    name: '自定义端点 (Custom API)',
    type: 'custom',
    baseUrl: 'https://api.openai.com/v1',
    model: 'custom-model',
    models: ['custom-model'],
    description: '兼容 OpenAI Chat Completions 协议的任意端点',
  },
]

const defaultSettings = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  maxSteps: 0,
  approval: 'always',
  streaming: true,
  appearance: 'light',
}
const APPROVAL_MODES = new Set(['always', 'session', 'never'])

/** Appearance: light, dark, or a user wallpaper behind translucent panels. */
const APPEARANCES = new Set(['light', 'dark', 'wallpaper'])
const WALLPAPER_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }
const MAX_WALLPAPER_BYTES = 12 * 1024 * 1024

function providerSecret(provider) {
  if (!provider?.encryptedApiKey) return ''
  try {
    return safeStorage.decryptString(Buffer.from(provider.encryptedApiKey, 'base64'))
  } catch { return '' }
}

function activeSecret() {
  const active = (settings.providers || []).find(p => p.id === settings.activeProviderId)
  if (active?.encryptedApiKey) return providerSecret(active)
  if (settings.encryptedApiKey) return secret()
  return ''
}

function publicSettings() {
  const activeProvider = (settings.providers || []).find(p => p.id === settings.activeProviderId) || settings.providers?.[0]
  const currentBaseUrl = activeProvider ? activeProvider.baseUrl : settings.baseUrl
  const currentModel = activeProvider ? activeProvider.model : settings.model
  const hasKey = activeProvider ? Boolean(activeProvider.encryptedApiKey) : Boolean(settings.encryptedApiKey)

  const providersList = (settings.providers || []).map(p => ({
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    model: p.model,
    models: p.models || [p.model],
    hasApiKey: Boolean(p.encryptedApiKey),
    active: p.id === (settings.activeProviderId || 'deepseek-official'),
    description: p.description || '',
  }))

  const projectsList = (settings.projects || []).map(p => ({
    ...p,
    active: p.path === workspace,
  }))

  return {
    baseUrl: currentBaseUrl,
    model: currentModel,
    maxSteps: settings.maxSteps,
    approval: settings.approval ?? 'always',
    streaming: settings.streaming !== false,
    reasoningEffort: settings.reasoningEffort || 'default',
    agentsEnabled: settings.agentsEnabled === true,
    showReasoning: settings.showReasoning !== false,
    appearance: settings.appearance ?? 'light',
    wallpaperName: settings.wallpaper ?? null,
    hasApiKey: hasKey,
    workspace,
    providers: providersList,
    activeProviderId: settings.activeProviderId || 'deepseek-official',
    projects: projectsList,
    cognitiveRoles: settings.cognitiveRoles || { planner: null, coder: null, fallbackProviderId: null },
  }
}

/**
 * Describe the chosen wallpaper for the renderer.
 */
function wallpaperPayload() {
  const name = settings.wallpaper
  if (!name) return null
  const file = join(home, 'wallpaper', name)
  if (!existsSync(file)) return null
  const mime = WALLPAPER_TYPES[name.split('.').pop()?.toLowerCase()]
  if (!mime) return null
  try {
    const bytes = statSync(file).size
    if (bytes > MAX_WALLPAPER_BYTES) return null
    return { name, mime, bytes, url: `tengyun-wallpaper://current/${encodeURIComponent(name)}?v=${bytes}` }
  } catch { return null }
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
  const maxSteps = Number(input.maxSteps ?? settings.maxSteps ?? 0)
  const approval = String(input.approval ?? settings.approval ?? 'always')
  if (!model || model.length > 200 || !Number.isInteger(maxSteps) || maxSteps < 0) {
    throw new Error('请填写模型名称；执行轮数应为 0（不限制）或更大的整数')
  }
  if (!APPROVAL_MODES.has(approval)) throw new Error('未知的确认模式')
  const appearance = String(input.appearance ?? settings.appearance ?? 'light')
  if (!APPEARANCES.has(appearance)) throw new Error('未知的界面风格')
  const next = { ...settings, baseUrl, model, maxSteps, approval, appearance, streaming: input.streaming === undefined ? settings.streaming !== false : Boolean(input.streaming) }
  
  const effort = input.reasoningEffort ?? settings.reasoningEffort ?? 'default'
  if (!['default', 'low', 'medium', 'high'].includes(effort)) throw new Error('未知的推理强度')
  next.reasoningEffort = effort
  next.agentsEnabled = input.agentsEnabled === undefined ? settings.agentsEnabled === true : input.agentsEnabled === true
  next.showReasoning = input.showReasoning === undefined ? settings.showReasoning !== false : input.showReasoning === true
  let newEncryptedKey = null
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用，未保存 API Key')
    newEncryptedKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64')
    next.encryptedApiKey = newEncryptedKey
  }

  // Also sync active provider
  const activeId = next.activeProviderId || 'deepseek-official'
  next.providers = (next.providers || []).map(p => {
    if (p.id === activeId) {
      return {
        ...p,
        baseUrl,
        model,
        encryptedApiKey: newEncryptedKey || p.encryptedApiKey || next.encryptedApiKey,
      }
    }
    return p
  })

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

/** Project-level instructions the user keeps beside their code, loaded like AGENTS.md. */
const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'TENGYUN.md']
const MAX_INSTRUCTION_BYTES = 24 * 1024

function readProjectInstructions() {
  for (const name of PROJECT_INSTRUCTION_FILES) {
    const file = join(workspace, name)
    try {
      if (!existsSync(file)) continue
      const stat = statSync(file)
      if (!stat.isFile() || stat.size > MAX_INSTRUCTION_BYTES) continue
      const content = readFileSync(file, 'utf8').trim()
      if (content) return { name, content }
    } catch { /* unreadable instruction must not stop task */ }
  }
  return null
}

async function readMemory() {
  try {
    const entries = await store.readMemory()
    return Array.isArray(entries) ? entries.slice(-200) : []
  } catch { return [] }
}

/**
 * Every file a run changed, in the order it first touched them, with the backup that undoes it.
 * The earliest record per path is the one that matters: restoring it unwinds all of that run's
 * edits to the file, whereas the newest backup would only undo the last one.
 */
async function collectRunChanges(runId) {
  const run = await store.getRun(runId)
  if (!run) throw new Error('未找到该任务')
  const byPath = new Map()
  for (const event of run.events ?? []) {
    if (event.type !== 'tool:result') continue
    const data = event.data
    if (!data || typeof data.path !== 'string' || !data.path) continue
    if (data.replaced === undefined && !data.backupPath) continue
    const existing = byPath.get(data.path)
    if (existing) {
      if (typeof data.diff === 'string' && data.diff) existing.latestDiff = data.diff
      continue
    }
    byPath.set(data.path, {
      path: data.path,
      created: data.replaced === false,
      backupPath: typeof data.backupPath === 'string' ? data.backupPath : null,
      diff: typeof data.diff === 'string' ? data.diff : '',
      latestDiff: typeof data.diff === 'string' ? data.diff : '',
      tool: typeof event.name === 'string' ? event.name : '',
      at: event.time ?? null,
      undoable: data.replaced === false || Boolean(data.backupPath),
    })
  }
  return [...byPath.values()]
}

/** Undo a run's changes inside the workspace. Anything outside the workspace root is refused. */
async function revertRunChanges(runId, onlyPaths) {
  const changes = await collectRunChanges(runId)
  const wanted = Array.isArray(onlyPaths) && onlyPaths.length ? new Set(onlyPaths) : null
  const root = realpathSync(workspace)
  const files = []
  for (const change of changes) {
    if (wanted && !wanted.has(change.path)) continue
    const target = resolve(root, change.path)
    if (target !== root && !target.startsWith(root + sep)) {
      files.push({ path: change.path, ok: false, error: '路径不在当前工作目录内' })
      continue
    }
    try {
      if (change.created) {
        if (existsSync(target)) rmSync(target, { force: true })
        files.push({ path: change.path, ok: true, action: 'deleted' })
      } else if (change.backupPath && existsSync(change.backupPath)) {
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(change.backupPath, target)
        files.push({ path: change.path, ok: true, action: 'restored' })
      } else {
        files.push({ path: change.path, ok: false, error: '没有可用的备份' })
      }
    } catch (error) {
      files.push({ path: change.path, ok: false, error: error instanceof Error ? error.message : '回滚失败' })
    }
  }
  return { runId, requested: files.length, reverted: files.filter(item => item.ok).length, files }
}

async function start() {
  store = createStore(home)
  settings = { ...defaultSettings, ...await store.readSettings() }

  // Normalize multi-project registry
  if (settings.workspace && existsSync(settings.workspace)) workspace = realpathSync(settings.workspace)
  if (!Array.isArray(settings.projects) || !settings.projects.length) {
    const telemetry = collectWorkspaceTelemetry(workspace)
    settings.projects = [{
      id: randomUUID(),
      name: basename(workspace) || 'workspace',
      path: workspace,
      active: true,
      branch: telemetry.git?.branch || null,
      type: telemetry.projectType || 'generic',
      addedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    }]
  } else {
    // Ensure active workspace corresponds to an active project
    const active = settings.projects.find(p => p.active)
    if (active && existsSync(active.path)) {
      workspace = realpathSync(active.path)
    } else {
      settings.projects[0].active = true
      workspace = realpathSync(settings.projects[0].path)
    }
  }

  // Normalize multi-provider registry
  if (!Array.isArray(settings.providers) || !settings.providers.length) {
    settings.providers = PRESET_PROVIDERS.map(p => ({
      ...p,
      encryptedApiKey: p.id === 'deepseek-official' ? (settings.encryptedApiKey || null) : null,
      active: p.id === 'deepseek-official',
    }))
    settings.activeProviderId = 'deepseek-official'
  } else {
    // Ensure all presets exist in settings.providers
    for (const preset of PRESET_PROVIDERS) {
      if (!settings.providers.some(p => p.id === preset.id)) {
        settings.providers.push({ ...preset, encryptedApiKey: null, active: false })
      }
    }
    if (!settings.activeProviderId) settings.activeProviderId = settings.providers[0].id
  }

  protocol.handle('tengyun-wallpaper', request => {
    const name = settings.wallpaper
    if (!name) return new Response('no wallpaper selected', { status: 404 })
    const requested = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
    if (requested !== name) return new Response('not found', { status: 404 })
    const file = join(home, 'wallpaper', name)
    if (!existsSync(file)) return new Response('missing file', { status: 404 })
    return net.fetch(pathToFileURL(file).href)
  })

  nativeTheme.themeSource = (settings.appearance ?? 'light') === 'dark' ? 'dark' : 'light'
  
  const imported = process.env.TENGYUN_IMPORT_SETTINGS
  delete process.env.TENGYUN_IMPORT_SETTINGS
  if (imported && !settings.encryptedApiKey) await saveSettings(JSON.parse(imported))

  for (const run of await store.listRuns()) {
    if (['running', 'pending', 'waiting_approval'].includes(run.status)) await store.updateRun(run.id, { status: 'interrupted' })
  }

  tools = createTools({ dataDir: home })
  engine = new AgentEngine({ store, tools })

  // Core IPC Handlers
  handle('info', () => ({
    name: 'Tengyun', version: app.getVersion(), home, workspace,
    localAccount: (() => { try { return userInfo().username } catch { return '本机用户' } })(),
    settings: publicSettings(), wallpaper: wallpaperPayload(),
  }))
  handle('saveSettings', saveSettings)
  handle('skills:list', () => tools.skills.list())
  handle('skills:get', id => tools.skills.get(id))
  handle('skills:resource', value => tools.skills.resource(value.id, value.path))
  handle('skills:save', value => tools.skills.save({ id: value.id, content: value.content, expectedRevision: value.expectedRevision, source: 'editor' }))
  handle('skills:enable', value => tools.skills.setEnabled(value))
  handle('skills:remove', value => tools.skills.remove(value))
  handle('skills:import', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择包含 SKILL.md 的技能文件夹', properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    return tools.skills.importDirectory(result.filePaths[0])
  })
  handle('setTheme', async value => {
    if (!APPEARANCES.has(value)) throw new Error('Invalid appearance')
    nativeTheme.themeSource = value === 'dark' ? 'dark' : 'light'
    settings.appearance = value
    await store.writeSettings(settings)
    window?.setBackgroundColor(value === 'dark' ? '#0c0c0d' : '#f4f4f6')
    return value
  })
  handle('chooseWallpaper', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '选择壁纸图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: Object.keys(WALLPAPER_TYPES) }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    const picked = result.filePaths[0]
    const extension = picked.split('.').pop()?.toLowerCase() ?? ''
    if (!WALLPAPER_TYPES[extension]) throw new Error('请选择 PNG、JPG、WEBP、GIF 或 BMP 图片')
    const size = statSync(picked).size
    if (size > MAX_WALLPAPER_BYTES) throw new Error('图片超过 12 MB，请换一张更小的')
    const directory = join(home, 'wallpaper')
    mkdirSync(directory, { recursive: true })
    const name = `wallpaper.${extension}`
    copyFileSync(picked, join(directory, name))
    settings.wallpaper = name
    settings.appearance = 'wallpaper'
    await store.writeSettings(settings)
    nativeTheme.themeSource = 'light'
    window?.setBackgroundColor('#f4f4f6')
    return { wallpaper: wallpaperPayload(), settings: publicSettings() }
  })
  handle('clearWallpaper', async () => {
    const directory = join(home, 'wallpaper')
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
    delete settings.wallpaper
    if (settings.appearance === 'wallpaper') settings.appearance = 'light'
    await store.writeSettings(settings)
    return { wallpaper: null, settings: publicSettings() }
  })
  handle('chooseWorkspace', async () => {
    if (activeRuns.size > 0) throw new Error('任务执行期间不能切换工作目录')
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], defaultPath: workspace })
    if (result.canceled || !result.filePaths[0]) return null
    const picked = realpathSync(result.filePaths[0])
    workspace = picked
    settings.workspace = workspace
    // Update or register in projects
    let proj = (settings.projects || []).find(p => p.path === picked)
    const telemetry = collectWorkspaceTelemetry(picked)
    if (!proj) {
      proj = {
        id: randomUUID(),
        name: basename(picked),
        path: picked,
        active: true,
        branch: telemetry.git?.branch || null,
        type: telemetry.projectType || 'generic',
        addedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      }
      settings.projects = [proj, ...(settings.projects || []).map(p => ({ ...p, active: false }))]
    } else {
      settings.projects = (settings.projects || []).map(p => ({
        ...p,
        active: p.id === proj.id,
        lastUsedAt: p.id === proj.id ? new Date().toISOString() : p.lastUsedAt,
      }))
    }
    await store.writeSettings(settings)
    return workspace
  })

  // Multi-Project Handlers
  handle('projects:list', async () => {
    return { projects: settings.projects || [], activeWorkspace: workspace }
  })
  handle('projects:add', async targetPath => {
    if (activeRuns.size > 0) throw new Error('任务执行期间不能添加或切换项目')
    let picked = targetPath
    if (!picked) {
      const result = await dialog.showOpenDialog(window, {
        title: '选择要添加的项目目录',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: workspace,
      })
      if (result.canceled || !result.filePaths[0]) return null
      picked = result.filePaths[0]
    }
    const resolvedPath = realpathSync(picked)
    const projectName = basename(resolvedPath)
    const telemetry = collectWorkspaceTelemetry(resolvedPath)
    let project = (settings.projects || []).find(p => p.path === resolvedPath)
    if (!project) {
      project = {
        id: randomUUID(),
        name: projectName,
        path: resolvedPath,
        active: true,
        branch: telemetry.git?.branch || null,
        type: telemetry.projectType || 'generic',
        addedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      }
      settings.projects = [project, ...(settings.projects || []).map(p => ({ ...p, active: false }))]
    } else {
      settings.projects = (settings.projects || []).map(p => ({
        ...p,
        active: p.id === project.id,
        lastUsedAt: p.id === project.id ? new Date().toISOString() : p.lastUsedAt,
      }))
    }
    workspace = resolvedPath
    settings.workspace = resolvedPath
    await store.writeSettings(settings)
    return { project, projects: settings.projects, workspace }
  })
  handle('projects:switch', async projectIdOrPath => {
    if (activeRuns.size > 0) throw new Error('任务执行期间不能切换工作目录')
    const project = (settings.projects || []).find(p => p.id === projectIdOrPath || p.path === projectIdOrPath)
    if (!project || !existsSync(project.path)) throw new Error('目标项目不存在或已被移除')
    workspace = realpathSync(project.path)
    settings.workspace = workspace
    settings.projects = (settings.projects || []).map(p => ({
      ...p,
      active: p.id === project.id,
      lastUsedAt: p.id === project.id ? new Date().toISOString() : p.lastUsedAt,
    }))
    await store.writeSettings(settings)
    return { activeProject: project, projects: settings.projects, workspace }
  })
  handle('projects:remove', async projectId => {
    if (activeRuns.size > 0) throw new Error('任务执行期间不能移除项目')
    const remaining = (settings.projects || []).filter(p => p.id !== projectId)
    if (!remaining.length) throw new Error('至少需要保留一个项目')
    if (!remaining.some(p => p.active)) {
      remaining[0].active = true
      workspace = realpathSync(remaining[0].path)
      settings.workspace = workspace
    }
    settings.projects = remaining
    await store.writeSettings(settings)
    return { projects: remaining, activeWorkspace: workspace }
  })
  handle('projects:current', async () => {
    return collectWorkspaceTelemetry(workspace)
  })

  // Multi-Provider Handlers
  handle('providers:list', async () => {
    return (settings.providers || []).map(p => ({
      id: p.id,
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      model: p.model,
      models: p.models || [p.model],
      hasApiKey: Boolean(p.encryptedApiKey),
      active: p.id === (settings.activeProviderId || 'deepseek-official'),
      description: p.description || '',
    }))
  })
  handle('providers:save', async input => {
    if (!input || !input.id) throw new Error('缺少服务商标识')
    const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '')
    const url = new URL(baseUrl)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('接口地址需要 HTTPS；本地模型可以使用 localhost HTTP')
    }
    let encrypted = null
    if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用')
      encrypted = safeStorage.encryptString(input.apiKey.trim()).toString('base64')
    }

    let found = false
    settings.providers = (settings.providers || []).map(p => {
      if (p.id === input.id) {
        found = true
        return {
          ...p,
          name: input.name || p.name,
          baseUrl,
          model: input.model || p.model,
          models: Array.isArray(input.models) && input.models.length ? input.models : p.models,
          encryptedApiKey: encrypted !== null ? encrypted : p.encryptedApiKey,
        }
      }
      return p
    })
    if (!found) {
      settings.providers.push({
        id: input.id,
        name: input.name || '自定义服务商',
        type: input.type || 'custom',
        baseUrl,
        model: input.model || 'default-model',
        models: Array.isArray(input.models) && input.models.length ? input.models : [input.model || 'default-model'],
        encryptedApiKey: encrypted,
      })
    }

    if (settings.activeProviderId === input.id) {
      const active = settings.providers.find(p => p.id === input.id)
      settings.baseUrl = active.baseUrl
      settings.model = active.model
      if (active.encryptedApiKey) settings.encryptedApiKey = active.encryptedApiKey
    }
    await store.writeSettings(settings)
    return publicSettings()
  })
  handle('providers:setActive', async input => {
    const id = typeof input === 'string' ? input : input?.id
    const targetModel = input?.model
    const target = (settings.providers || []).find(p => p.id === id)
    if (!target) throw new Error('未找到指定的服务商')
    settings.activeProviderId = id
    if (targetModel) target.model = targetModel
    settings.baseUrl = target.baseUrl
    settings.model = target.model
    if (target.encryptedApiKey) settings.encryptedApiKey = target.encryptedApiKey
    await store.writeSettings(settings)
    return publicSettings()
  })
  handle('providers:remove', async id => {
    if (PRESET_PROVIDERS.some(preset => preset.id === id)) {
      throw new Error('预设服务商不能删除')
    }
    settings.providers = (settings.providers || []).filter(p => p.id !== id)
    if (settings.activeProviderId === id) {
      settings.activeProviderId = 'deepseek-official'
      const active = settings.providers.find(p => p.id === 'deepseek-official')
      settings.baseUrl = active.baseUrl
      settings.model = active.model
      if (active.encryptedApiKey) settings.encryptedApiKey = active.encryptedApiKey
    }
    await store.writeSettings(settings)
    return publicSettings()
  })
  const balanceCache = new Map()
  handle('providers:models', async input => {
    const provider = (settings.providers || []).find(p => p.id === input?.id)
    const baseUrl = providerUrl(input?.baseUrl || provider?.baseUrl)
    const sameEndpoint = provider && baseUrl === providerUrl(provider.baseUrl)
    const key = input?.apiKey?.trim() || (sameEndpoint ? providerSecret(provider) : '')
    if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) throw new Error('请填写此接口的 API Key；修改接口地址后不会自动发送原密钥')
    return fetchModels(baseUrl, key, net.fetch.bind(net))
  })
  handle('providers:balance', async input => {
    const provider = (settings.providers || []).find(p => p.id === input?.id)
    if (!provider) throw new Error('提供商不存在')
    const cacheKey = provider.id + '|' + provider.baseUrl + '|' + (provider.encryptedApiKey || '')
    const cached = balanceCache.get(cacheKey)
    if (cached && Date.now() - cached.time < (input.force ? 5000 : 60000)) return cached.promise
    const promise = fetchBalance(provider.baseUrl, providerSecret(provider), net.fetch.bind(net))
    balanceCache.set(cacheKey, { time: Date.now(), promise })
    if (balanceCache.size > 100) balanceCache.delete(balanceCache.keys().next().value)
    return promise
  })
  handle('providers:test', async id => {
    const provider = (settings.providers || []).find(p => p.id === id)
    if (!provider) throw new Error('服务商未找到')
    const key = providerSecret(provider)
    const testUrl = `${provider.baseUrl.replace(/\/+$/, '')}/models`
    try {
      const resp = await net.fetch(testUrl, {
        headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      return { ok: true, status: resp.status }
    } catch (e) {
      // Fallback: try chat completions with 1 token
      try {
        const compUrl = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
        const resp2 = await net.fetch(compUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(8000),
        })
        if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`)
        return { ok: true, status: resp2.status }
      } catch (err) {
        throw new Error(`连接失败: ${err.message}`)
      }
    }
  })
  handle('providers:setCognitiveRoles', async roles => {
    settings.cognitiveRoles = {
      planner: roles?.planner || null,
      coder: roles?.coder || null,
      fallbackProviderId: roles?.fallbackProviderId || null,
    }
    await store.writeSettings(settings)
    return publicSettings()
  })

  // Task & Run Handlers
  // Task & Run Handlers
  handle('listRuns', async () => {
    const runs = await store.listRuns()
    return runs.filter(r => !r.agentParentId).map(r => ({
      ...r,
      status: activeRuns.has(r.id) ? 'running' : r.status,
    }))
  })
  handle('getRun', id => { if (typeof id !== 'string') throw new Error('Invalid task id'); return store.getRun(id) })

  /**
   * Change ledger + undo. Every file_write and apply_patch already keeps a backup; this exposes
   * that as a one-click rollback so a bad run is recoverable instead of merely regrettable.
   */
  handle('runChanges', async id => {
    if (typeof id !== 'string' || !id) throw new Error('Invalid task id')
    return collectRunChanges(id)
  })
  handle('revertRun', async value => {
    const id = typeof value === 'string' ? value : value?.id
    if (typeof id !== 'string' || !id) throw new Error('Invalid task id')
    if (activeRuns.has(id)) throw new Error('任务仍在执行，先停止再回滚')
    return revertRunChanges(id, value?.paths)
  })
  handle('deleteRun', async id => {
    if (typeof id !== 'string' || !id) throw new Error('Invalid task id')
    if (activeRuns.has(id)) {
      activeRuns.get(id)?.controller?.abort()
      engine.cancel(id)
      await activeRuns.get(id)?.promise?.catch(() => {})
      activeRuns.delete(id)
    }
    for (const child of await store.listRuns({ limit: 1000 })) { if (child.agentParentId === id) await store.deleteRun(child.id) }
    await store.deleteRun(id)
    return { ok: true, id }
  })
  handle('chooseFiles', async options => {
    const result = await dialog.showOpenDialog(window, {
      title: options?.title || '选择要上传的图片或文件',
      properties: ['openFile', 'multiSelections'],
      filters: options?.filters || [
        { name: '所有支持的文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'rs', 'go', 'html', 'css', 'yml', 'yaml', 'toml', 'log', 'csv', 'sql', 'sh', 'bat', 'ps1', 'pdf'] },
        { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] },
        { name: '代码与文本文件', extensions: ['txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'rs', 'go', 'html', 'css', 'yml', 'yaml', 'toml', 'log', 'csv', 'sql', 'sh', 'bat', 'ps1'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePaths.length) return []
    const files = []
    for (const filePath of result.filePaths) {
      try {
        const fileStat = await stat(filePath)
        const name = basename(filePath)
        const ext = extname(filePath).toLowerCase().replace(/^\./, '')
        const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)
        const isText = ['txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'rs', 'go', 'html', 'css', 'yml', 'yaml', 'toml', 'log', 'csv', 'sql', 'sh', 'bat', 'ps1'].includes(ext)
        let dataUrl = ''
        let textContent = ''
        if (isImage) {
          const buf = await readFile(filePath)
          const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
          dataUrl = `data:${mime};base64,${buf.toString('base64')}`
        } else if (isText && fileStat.size < 2 * 1024 * 1024) {
          textContent = await readFile(filePath, 'utf8')
        }
        files.push({ path: filePath, name, size: fileStat.size, ext, isImage, dataUrl, textContent })
      } catch (err) {
        console.error('Failed reading selected file:', filePath, err)
      }
    }
    return files
  })
  handle('run', async input => {
    if (typeof input?.input !== 'string' || !input.input.trim() || input.input.length > 100000) throw new Error('请输入任务，最长 100000 字符')

    const conversationId = typeof input?.conversationId === 'string' && input.conversationId.trim() ? input.conversationId.trim() : null
    let priorRun = null
    if (conversationId) {
      try { priorRun = await store.getRun(conversationId) } catch { priorRun = null }
    } else if (typeof input?.parentId === 'string' && input.parentId) {
      try { priorRun = await store.getRun(input.parentId) } catch { priorRun = null }
    }

    const isContinuation = Boolean(conversationId && priorRun)
    const id = isContinuation ? conversationId : randomUUID()

    if (activeRuns.has(id)) throw new Error('该任务正在执行中，请先等待或停止')

    const activeProvider = (settings.providers || []).find(p => p.id === settings.activeProviderId)
    const activeKey = activeSecret()
    const activeBaseUrl = activeProvider ? activeProvider.baseUrl : settings.baseUrl
    const url = new URL(activeBaseUrl)
    if (!activeKey && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('请先在模型设置中保存 API Key')

    activeRuns.set(id, { runId: id, controller: new AbortController() })

    // Collect all secrets across providers for redaction
    const allSecrets = (settings.providers || []).map(p => providerSecret(p)).filter(Boolean)
    if (activeKey) allSecrets.push(activeKey)
    store.setSecrets([...new Set(allSecrets)])
    tools.setSecrets([...new Set(allSecrets)])

    // Dynamic fallback cascade config
    let fallbackConfig = {}
    if (settings.cognitiveRoles?.fallbackProviderId) {
      const fallbackProvider = (settings.providers || []).find(p => p.id === settings.cognitiveRoles.fallbackProviderId)
      if (fallbackProvider) {
        fallbackConfig = {
          fallbackEndpoint: new URL(`${fallbackProvider.baseUrl.replace(/\/$/, '')}/chat/completions`).href,
          fallbackModel: fallbackProvider.model,
          fallbackApiKey: providerSecret(fallbackProvider),
        }
      }
    }

    // Cognitive planner role config
    let plannerConfig = {}
    if (settings.cognitiveRoles?.planner?.providerId) {
      const plannerProvider = (settings.providers || []).find(p => p.id === settings.cognitiveRoles.planner.providerId)
      if (plannerProvider) {
        plannerConfig = {
          plannerEndpoint: new URL(`${plannerProvider.baseUrl.replace(/\/$/, '')}/chat/completions`).href,
          plannerModel: settings.cognitiveRoles.planner.model || plannerProvider.model,
          plannerApiKey: providerSecret(plannerProvider),
        }
      }
    }

    const config = {
      ...publicSettings(),
      apiKey: activeKey,
      baseUrl: activeBaseUrl,
      model: activeProvider ? activeProvider.model : settings.model,
      ...fallbackConfig,
      ...plannerConfig,
    }

    // Collect telemetry
    const telemetry = collectWorkspaceTelemetry(workspace)

    const attachments = Array.isArray(input?.attachments) ? input.attachments : []
    if (attachments.length && workspace) {
      const attachDir = join(workspace, '.tengyun', 'attachments')
      try {
        mkdirSync(attachDir, { recursive: true })
        for (const item of attachments) {
          if (item.dataUrl && item.isImage) {
            const match = item.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              const ext = item.ext || 'png'
              const safeName = (item.name || `image-${Date.now()}.${ext}`).replace(/[^a-zA-Z0-9_.-]/g, '_')
              const targetPath = join(attachDir, safeName)
              writeFileSync(targetPath, Buffer.from(match[2], 'base64'))
              item.savedPath = targetPath
            }
          } else if (item.textContent) {
            const safeName = (item.name || `file-${Date.now()}.txt`).replace(/[^a-zA-Z0-9_.-]/g, '_')
            const targetPath = join(attachDir, safeName)
            writeFileSync(targetPath, item.textContent, 'utf8')
            item.savedPath = targetPath
          }
        }
      } catch (err) {
        console.error('Failed saving attachments to workspace:', err)
      }
    }

    setImmediate(async () => {
      if (stopping || !activeRuns.has(id)) return
      const runEntry = activeRuns.get(id)
      const runPromise = (async () => engine.run({
        id, input: input.input.trim(), attachments, workspace, config, priorRun, isContinuation, requestApproval, onEvent: send, signal: runEntry.controller.signal,
        projectInstructions: readProjectInstructions(),
        memory: await readMemory(),
        telemetry,
        projects: settings.projects || [],
      }))()
      const entry = activeRuns.get(id)
      if (entry) entry.promise = runPromise
      runPromise
        .catch(error => send({ type: 'run:error', runId: id, error: String(error.message).replaceAll(config.apiKey || '\0', '[redacted]') }))
        .finally(() => {
          activeRuns.delete(id)
          for (const [appId, pending] of approvals.entries()) {
            if (pending.runId === id) {
              pending.finish(false)
              approvals.delete(appId)
            }
          }
          send({ type: 'run:settled', runId: id })
        })
    })
    return { id }
  })

  handle('cancel', id => {
    if (id && activeRuns.has(id)) {
      activeRuns.get(id)?.controller?.abort()
      engine.cancel(id)
    } else {
      for (const [runId, entry] of activeRuns) { entry.controller?.abort(); engine.cancel(runId) }
    }
    return true
  })
  handle('approve', value => {
    if (typeof value?.approvalId !== 'string' || typeof value.approved !== 'boolean') throw new Error('Invalid approval')
    const pending = approvals.get(value.approvalId)
    if (!pending || !activeRuns.has(pending.runId)) throw new Error('操作确认已失效')
    pending.finish(value.approved)
    approvals.delete(value.approvalId)
    return true
  })

  Menu.setApplicationMenu(null)
  window = new BrowserWindow({
    width: 1480, height: 960, minWidth: 1000, minHeight: 680, title: 'Tengyun',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0c0d' : '#ffffff', icon: join(process.resourcesPath, 'icon.png'),
    webPreferences: { preload: join(source, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault() })
  window.on('page-title-updated', event => event.preventDefault())
  window.on('closed', () => {
    for (const [runId, entry] of activeRuns) { entry.controller?.abort(); engine.cancel(runId) }
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
    for (const [runId, entry] of activeRuns) { entry.controller?.abort(); engine?.cancel(runId) }
    for (const pending of approvals.values()) pending.finish(false)
    const runningPromises = [...activeRuns.values()].map(e => e.promise).filter(Boolean)
    if (runningPromises.length) {
      event.preventDefault()
      void Promise.allSettled(runningPromises).finally(() => app.quit())
    }
  })
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('Tengyun 启动失败', String(error.message)); app.exit(1) })
}
