import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const queues = new Map()
const SENSITIVE = /^(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|password|secret|credentials)$/i
const MAX_EVENT_BYTES = 4 * 1024 * 1024

function serial(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  queues.set(key, next)
  return next.finally(() => { if (queues.get(key) === next) queues.delete(key) })
}

/** Replace known credentials before text can enter a run log or memory. */
export function redactSecrets(value, secrets = []) {
  if (typeof value === 'string') {
    let result = value.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) result = result.split(secret).join('[REDACTED]')
    return result
  }
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, secrets))
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE.test(key)) result[key] = '[REDACTED]'
      else result[key] = redactSecrets(item, secrets)
    }
    return result
  }
  return value
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, file)
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

function validId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error('Invalid run id')
  return id
}

function transcriptFrom(events) {
  const messages = []
  for (const event of events) {
    const message = event.message ?? event.data?.message
    if (message && typeof message.role === 'string') messages.push(message)
    else if (event.type === 'message' && typeof event.role === 'string') messages.push({ role: event.role, content: event.content ?? event.text ?? '' })
    else if (['user', 'assistant', 'tool'].includes(event.type)) messages.push({ role: event.type, content: event.content ?? event.text ?? event.data?.content ?? '' })
  }
  return messages
}

/** Independent local storage. Settings may contain encrypted credentials only. */
export function createStore(dataDir) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('dataDir must be an absolute path')
  const root = path.resolve(dataDir)
  const runsRoot = path.join(root, 'runs')
  const settingsFile = path.join(root, 'settings.json')
  const memoryFile = path.join(root, 'memory.json')
  let secrets = []
  const sanitize = value => redactSecrets(value, secrets)
  const runDir = id => path.join(runsRoot, validId(id))
  const metadataFile = id => path.join(runDir(id), 'run.json')
  const eventsFile = id => path.join(runDir(id), 'events.jsonl')

  async function loadEvents(id) {
    let raw
    try { raw = await fs.readFile(eventsFile(id), 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const lines = raw.split('\n')
    const events = []
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue
      try { events.push(JSON.parse(lines[index])) }
      catch (error) {
        // An interrupted append may leave one incomplete final line.
        if (index === lines.length - 1 && !raw.endsWith('\n')) break
        throw new Error(`Run ${id} has an invalid event at line ${index + 1}`, { cause: error })
      }
    }
    return events
  }

  return {
    dataDir: root,
    setSecrets(values) { secrets = [...new Set((values ?? []).filter(value => typeof value === 'string' && value.length >= 4))] },
    sanitize,
    async readSettings() { return readJson(settingsFile, {}) },
    async writeSettings(settings) {
      // Main encrypts its API key with Electron safeStorage before calling this.
      for (const [key, value] of Object.entries(settings)) {
        if (SENSITIVE.test(key) && value && value !== '[REDACTED]') throw new Error(`Plaintext credential field is not allowed in settings: ${key}`)
      }
      return serial(settingsFile, async () => { await atomicJson(settingsFile, settings); return settings })
    },
    async readMemory() { return readJson(memoryFile, []) },
    async writeMemory(value) {
      return serial(memoryFile, async () => { const clean = sanitize(value); await atomicJson(memoryFile, clean); return clean })
    },
    async addMemory(entry) {
      return serial(memoryFile, async () => {
        const memory = await readJson(memoryFile, [])
        if (!Array.isArray(memory)) throw new Error('Memory storage must be an array')
        const clean = sanitize({ ...entry, id: entry.id ?? randomUUID(), createdAt: entry.createdAt ?? new Date().toISOString() })
        memory.push(clean)
        await atomicJson(memoryFile, memory)
        return clean
      })
    },
    async createRun(record = {}) {
      const id = validId(record.id ?? randomUUID())
      return serial(metadataFile(id), async () => {
        const directory = runDir(id)
        await fs.mkdir(runsRoot, { recursive: true })
        await fs.mkdir(directory)
        const clean = sanitize({ ...record, id, createdAt: record.createdAt ?? new Date().toISOString(), updatedAt: record.updatedAt ?? new Date().toISOString() })
        await atomicJson(metadataFile(id), clean)
        return clean
      })
    },
    async appendEvent(id, event) {
      return serial(eventsFile(id), async () => {
        if (!await readJson(metadataFile(id), null)) throw new Error(`Run not found: ${id}`)
        const clean = sanitize(event)
        const line = `${JSON.stringify(clean)}\n`
        if (Buffer.byteLength(line) > MAX_EVENT_BYTES) throw new Error('Run event exceeds the 4 MB limit')
        const handle = await fs.open(eventsFile(id), 'a', 0o600)
        try { await handle.writeFile(line); await handle.sync() }
        finally { await handle.close() }
        return clean
      })
    },
    async updateRun(id, patch) {
      return serial(metadataFile(id), async () => {
        const current = await readJson(metadataFile(id), null)
        if (!current) throw new Error(`Run not found: ${id}`)
        const clean = sanitize({ ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: new Date().toISOString() })
        await atomicJson(metadataFile(id), clean)
        return clean
      })
    },
    async getRun(id) {
      const record = await readJson(metadataFile(id), null)
      if (!record) return null
      const events = await loadEvents(id)
      return { ...record, events, transcript: record.transcript ?? record.messages ?? transcriptFrom(events) }
    },
    async listRuns({ limit = 100 } = {}) {
      let entries
      try { entries = await fs.readdir(runsRoot, { withFileTypes: true }) }
      catch (error) { if (error.code === 'ENOENT') return []; throw error }
      const records = []
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,120}$/.test(entry.name)) continue
        const record = await readJson(metadataFile(entry.name), null)
        if (!record) continue
        const { messages, transcript, ...summary } = record
        records.push(summary)
      }
      return records.sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt))).slice(0, Math.max(1, Math.min(limit, 1000)))
    },
  }
}
