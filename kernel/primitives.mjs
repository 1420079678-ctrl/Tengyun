/**
 * Shared primitives for tools and capabilities.
 *
 * Path safety, bounded reads, command execution and diff generation live here so that a
 * capability module can use them without importing tools.mjs (which imports capabilities —
 * that would be a cycle). Every helper that touches the filesystem goes through checkedPath.
 */
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const MAX_CONTENT_BYTES = 1024 * 1024
export const MAX_OUTPUT_CHARS = 64 * 1024
export const MAX_COMMAND_MS = 600_000
export const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.tengyun-backups'])

export class ToolError extends Error {
  constructor(code, message) { super(message); this.name = 'ToolError'; this.code = code }
}

export const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })
export const string = description => ({ type: 'string', description })

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new ToolError('CANCELLED', 'Operation cancelled')
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Resolve a workspace path and reject every junction or symbolic link in it. */
export async function checkedPath(workspace, input = '.', { missing = false, directory = false } = {}) {
  if (!workspace || !path.isAbsolute(workspace)) throw new ToolError('WORKSPACE_REQUIRED', 'An absolute workspace path is required')
  if (typeof input !== 'string' || input.includes('\0')) throw new ToolError('INVALID_PATH', 'Invalid file path')
  if (process.platform === 'win32' && /[<>:"|?*]/.test(path.isAbsolute(input) ? input.slice(path.parse(input).root.length) : input)) throw new ToolError('INVALID_PATH', 'Unsupported Windows file path')
  const workspacePath = path.resolve(workspace)
  const workspaceStat = await fs.lstat(workspacePath)
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) throw new ToolError('UNSAFE_PATH', 'Workspace must be a real directory')
  const root = await fs.realpath(workspacePath)
  const target = path.resolve(root, input)
  if (!inside(root, target)) throw new ToolError('PATH_ESCAPE', 'Path is outside the selected workspace')
  const parts = path.relative(root, target).split(path.sep).filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    let stat
    try { stat = await fs.lstat(current) }
    catch (error) { if (missing && error.code === 'ENOENT') break; throw error }
    if (stat.isSymbolicLink()) throw new ToolError('SYMLINK_DENIED', 'Symbolic links and junctions are not permitted')
    if (index < parts.length - 1 && !stat.isDirectory()) throw new ToolError('INVALID_PATH', 'A parent path is not a directory')
    const actual = await fs.realpath(current)
    if (!inside(root, actual)) throw new ToolError('PATH_ESCAPE', 'Resolved path is outside the selected workspace')
  }
  if (directory && !(await fs.stat(target)).isDirectory()) throw new ToolError('INVALID_PATH', 'A directory is required')
  return { root, target, relative: path.relative(root, target) || '.' }
}

export function number(value, fallback, min, max) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) throw new ToolError('INVALID_ARGUMENT', `Expected integer from ${min} to ${max}`)
  return value
}

export async function walk(workspace, start, { maxDepth = 8, maxFiles = 10000, signal } = {}) {
  const entries = []
  const queue = [{ directory: start, depth: 0 }]
  let truncated = false
  while (queue.length) {
    throwIfAborted(signal)
    const { directory, depth } = queue.shift()
    await checkedPath(workspace, directory, { directory: true })
    const children = await fs.readdir(directory, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const fullPath = path.join(directory, child.name)
      const stat = await fs.lstat(fullPath)
      if (stat.isSymbolicLink()) continue
      if (child.isDirectory() && SKIP_DIRECTORIES.has(child.name)) continue
      entries.push({ path: path.relative(workspace, fullPath), type: child.isDirectory() ? 'directory' : 'file', size: stat.size })
      if (entries.length >= maxFiles) { truncated = true; return { entries, truncated } }
      if (child.isDirectory() && depth < maxDepth) queue.push({ directory: fullPath, depth: depth + 1 })
    }
  }
  return { entries, truncated }
}

export async function readText(target) {
  const stat = await fs.stat(target)
  if (!stat.isFile()) throw new ToolError('INVALID_PATH', 'A regular file is required')
  if (stat.size > MAX_CONTENT_BYTES) throw new ToolError('FILE_TOO_LARGE', 'File is larger than the 1 MB text limit')
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const content = await handle.readFile('utf8')
    if (content.includes('\0')) throw new ToolError('BINARY_FILE', 'This file is not a text file')
    return content
  } finally { await handle.close() }
}

/** Line-level diff. Falls back to a whole-file replacement when LCS would be too costly. */
export function diffLines(a, b) {
  const n = a.length, m = b.length
  if (n * m > 4_000_000) return null
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const ops = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++ }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push(['-', a[i++]])
    } else { ops.push(['+', b[j++]]) }
  }
  while (i < n) ops.push(['-', a[i++]])
  while (j < m) ops.push(['+', b[j++]])
  return ops
}

/** Build a git-compatible unified diff the review panel can render line by line. */
export function unifiedDiff(oldText, newText, filePath) {
  const a = oldText === null || oldText === undefined ? [] : String(oldText).split('\n')
  const b = String(newText ?? '').split('\n')
  const from = oldText === null || oldText === undefined ? '/dev/null' : `a/${filePath}`
  const to = newText === null || newText === undefined ? '/dev/null' : `b/${filePath}`
  const head = `--- ${from}\n+++ ${to}`
  const ops = diffLines(a, b)
  if (!ops) {
    return [`${head}`, `@@ -1,${a.length} +1,${b.length} @@`,
      ...a.map(line => `-${line}`), ...b.map(line => `+${line}`)].join('\n')
  }
  if (!ops.some(([kind]) => kind !== ' ')) return ''
  const context = 3
  const changed = ops.map(([kind]) => kind !== ' ')
  const blocks = []
  let index = 0
  while (index < ops.length) {
    if (!changed[index]) { index++; continue }
    let end = index
    while (end + 1 < ops.length && (changed[end + 1] || (end + 2 < ops.length && changed[end + 2]))) end++
    blocks.push([Math.max(0, index - context), Math.min(ops.length - 1, end + context)])
    index = end + 1
  }
  const merged = []
  for (const range of blocks) {
    const last = merged.at(-1)
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
    else merged.push(range)
  }
  const lines = []
  let oldLine = 1, newLine = 1
  let cursor = 0
  for (const [from2, to2] of merged) {
    while (cursor < from2) {
      if (ops[cursor][0] !== '+') oldLine++
      if (ops[cursor][0] !== '-') newLine++
      cursor++
    }
    const oldStart = oldLine, newStart = newLine
    let oldCount = 0, newCount = 0
    const body = []
    while (cursor <= to2) {
      const [kind, text] = ops[cursor]
      if (kind === ' ') { oldCount++; newCount++ }
      else if (kind === '-') { oldCount++ }
      else { newCount++ }
      body.push(kind + text)
      cursor++
    }
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body)
  }
  return [head, ...lines].join('\n')
}

export function globToRegExp(pattern) {
  const text = String(pattern)
  let out = ''
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '*') {
      if (text[index + 1] === '*') { out += '.*'; index++ } else out += '[^/\\\\]*'
    } else if (char === '?') out += '[^/\\\\]'
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + out + '$', 'i')
}

export function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

export async function fetchText(url, maxBytes, signal) {
  const target = new URL(url)
  if (target.protocol !== 'https:') throw new ToolError('INVALID_ARGUMENT', 'Only https URLs are allowed')
  if (target.username || target.password) throw new ToolError('INVALID_ARGUMENT', 'Credentials in URLs are not allowed')
  const response = await fetch(target.href, { signal, redirect: 'follow' })
  if (!response.ok) throw new ToolError('NETWORK_ERROR', `HTTP ${response.status}`)
  const raw = (await response.text()).slice(0, maxBytes)
  return { url: target.href, status: response.status, contentType: response.headers.get('content-type') || '', text: raw }
}

async function stopTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      const timer = setTimeout(() => { killer.kill(); resolve() }, 5000)
      killer.once('error', () => { clearTimeout(timer); child.kill(); resolve() })
      killer.once('close', () => { clearTimeout(timer); resolve() })
    })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL') }
  }
}

/**
 * Run a shell command with bounded, streamed output.
 * `context.onOutput(text)` receives ~250 ms batches; a dead observer must not kill the child.
 */
export function executeCommand(args, context) {
  if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000) throw new ToolError('INVALID_ARGUMENT', 'A command of 1–16000 characters is required')
  return checkedPath(context.workspace, args.cwd ?? '.', { directory: true })
    .then(({ target: cwd }) => new Promise((resolve, reject) => {
      const timeoutMs = number(args.timeoutMs, 60000, 100, MAX_COMMAND_MS)
      throwIfAborted(context.signal)
      const started = Date.now()
      const isWindows = process.platform === 'win32'
      const environment = Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !/(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
      const child = spawn(isWindows ? 'powershell.exe' : '/bin/sh',
        isWindows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command] : ['-c', args.command],
        { cwd, env: environment, windowsHide: true, detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', truncated = false, timedOut = false, cancelled = false, completed = false, stopping
      let streamBuffer = '', streamTimer = null
      const pushStream = text => {
        if (typeof context.onOutput !== 'function' || !text) return
        streamBuffer += text
        if (streamTimer) return
        streamTimer = setTimeout(() => {
          streamTimer = null
          const chunk = streamBuffer
          streamBuffer = ''
          if (chunk) { try { context.onOutput(chunk) } catch (error) { /* A dead observer must not kill the command. */ } }
        }, 250)
      }
      const flushStream = () => {
        if (streamTimer) { clearTimeout(streamTimer); streamTimer = null }
        if (streamBuffer) {
          const chunk = streamBuffer
          streamBuffer = ''
          try { context.onOutput(chunk) } catch (error) { /* ignored */ }
        }
      }
      const append = (kind, chunk) => {
        const text = chunk.toString('utf8')
        const available = Math.max(0, MAX_OUTPUT_CHARS - stdout.length - stderr.length)
        if (text.length > available) truncated = true
        if (kind === 'stdout') stdout += text.slice(0, available)
        else stderr += text.slice(0, available)
        pushStream(text)
      }
      child.stdout.on('data', chunk => append('stdout', chunk))
      child.stderr.on('data', chunk => append('stderr', chunk))
      const stop = reason => {
        if (completed || stopping) return
        timedOut = reason === 'timeout'; cancelled = reason === 'cancelled'
        stopping = stopTree(child)
      }
      const abort = () => stop('cancelled')
      context.signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => stop('timeout'), timeoutMs)
      const cleanup = () => { completed = true; clearTimeout(timer); context.signal?.removeEventListener('abort', abort) }
      child.once('error', error => { cleanup(); reject(new ToolError('COMMAND_FAILED', error.message)) })
      child.once('close', async (exitCode, signal) => {
        flushStream()
        cleanup()
        await stopping
        resolve({ exitCode, signal, stdout, stderr, truncated, timedOut, cancelled, durationMs: Date.now() - started, command: args.command.slice(0, 400) })
      })
      if (context.signal?.aborted) abort()
    }))
}
