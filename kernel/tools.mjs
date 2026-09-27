import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStore, redactSecrets } from './store.mjs'
import { loadCapabilities } from './capabilities/index.mjs'
import {
  ToolError, object, string, checkedPath, number, walk, readText, unifiedDiff, globToRegExp,
  executeCommand, throwIfAborted, MAX_CONTENT_BYTES,
} from './primitives.mjs'

export { ToolError }
export { unifiedDiff }

/** Tools that carry their own path and approval rules. Capabilities live beside these. */
export const definitions = [
  { name: 'file_read', description: 'Read a text file inside the selected workspace. Symlinks and paths outside the workspace are rejected. Reports start/end line and total line count so you can cite exact lines.', parameters: object({ path: string('Path relative to workspace'), startLine: { type: 'integer', minimum: 1 }, maxLines: { type: 'integer', minimum: 1, maximum: 2000 } }, ['path']) },
  { name: 'file_write', description: 'Create or replace a UTF-8 file inside the workspace after user approval. Replacing a file saves a backup and returns a unified diff for review.', requiresApproval: true, parameters: object({ path: string('Path relative to workspace'), content: string('Complete new UTF-8 file content') }, ['path', 'content']) },
  { name: 'list_files', description: 'List files inside the workspace without following symlinks. Dependency and Git directories are skipped.', parameters: object({ path: string('Relative directory; use . for workspace'), maxDepth: { type: 'integer', minimum: 0, maximum: 8 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } }, ['path']) },
  { name: 'search_files', description: 'Search text files inside the workspace. Supports a literal string, a regular expression, or a glob over file names. Does not follow symlinks or scan dependencies.', parameters: object({ path: string('Relative directory; use . for workspace'), query: string('Literal text, regular expression, or file-name glob when glob=true'), regex: { type: 'boolean' }, glob: { type: 'boolean' }, caseSensitive: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 400 } }, ['path', 'query']) },
  { name: 'run_command', description: 'Run a shell command after explicit user approval, with a workspace working directory and bounded streaming output. Commands can modify files; explain the intended action in the command.', requiresApproval: true, parameters: object({ command: string('Shell command: PowerShell on Windows, sh elsewhere'), cwd: string('Working directory relative to workspace; use . by default'), timeoutMs: { type: 'integer', minimum: 100, maximum: 600000 } }, ['command']) },
  { name: 'memory_save', description: 'Save a concise reusable fact to this app’s independent local memory after user approval. Never save credentials.', requiresApproval: true, parameters: object({ text: string('Fact to remember'), tags: { type: 'array', items: { type: 'string' }, maxItems: 20 } }, ['text']) },
  { name: 'memory_search', description: 'Search previously saved local memory.', parameters: object({ query: string('Literal search text; empty returns recent entries'), limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query']) },
]

/**
 * Workspace tools plus the capability registry.
 * `definitions` stays the built-in list for cheap inspection; `allDefinitions()` is what the
 * engine offers to the model, so a new capability needs no change in tools.mjs.
 */
export function createTools({ dataDir, secrets = [] } = {}) {
  const store = createStore(dataDir)
  store.setSecrets(secrets)
  let capabilities = null
  const load = async () => {
    if (!capabilities) capabilities = await loadCapabilities()
    return capabilities
  }
  const builtins = new Set(definitions.map(item => item.name))
  return {
    definitions,
    async allDefinitions() {
      const loaded = await load()
      return [...definitions, ...loaded.map(item => item.definition)]
    },
    async capabilityNames() { return (await load()).map(item => item.definition.name) },
    setSecrets(values) { secrets = values ?? []; store.setSecrets(secrets) },
    async execute(name, args = {}, context = {}) {
      if (name === 'command_execute') name = 'run_command'
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('INVALID_ARGUMENT', 'Tool arguments must be an object')
      throwIfAborted(context.signal)

      const loaded = await load()
      const definition = [...definitions, ...loaded.map(item => item.definition)].find(item => item.name === name)
      if (!definition) throw new ToolError('UNKNOWN_TOOL', `Unknown tool: ${name}`)
      // Approval is enforced here for every tool, so a capability cannot opt out of it.
      if (definition.requiresApproval && context.approvalGranted !== true && context.approved !== true) {
        throw new ToolError('APPROVAL_REQUIRED', 'This action requires explicit user approval')
      }
      const capability = loaded.find(item => item.definition.name === name)
      if (capability) return redactSecrets(await capability.run(name, args, { ...context, dataDir }), secrets)

      let result
      if (name === 'run_command') result = await executeCommand(args, context)
      else if (name === 'memory_save') {
        if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 10000) throw new ToolError('INVALID_ARGUMENT', 'Memory text must contain 1–10000 characters')
        const tags = args.tags ?? []
        if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || tag.length > 100)) throw new ToolError('INVALID_ARGUMENT', 'Invalid memory tags')
        result = await store.addMemory({ text: args.text, tags })
      } else if (name === 'memory_search') {
        if (typeof args.query !== 'string') throw new ToolError('INVALID_ARGUMENT', 'query must be a string')
        const limit = number(args.limit, 20, 1, 100)
        const query = args.query.toLowerCase()
        result = { entries: (await store.readMemory()).filter(entry => `${entry.text}\n${(entry.tags ?? []).join(' ')}`.toLowerCase().includes(query)).slice(-limit).reverse() }
      } else if (name === 'file_read') {
        const { target, relative } = await checkedPath(context.workspace, args.path)
        const content = await readText(target)
        const lines = content.split(/\r?\n/)
        const startLine = number(args.startLine, 1, 1, Number.MAX_SAFE_INTEGER)
        const maxLines = number(args.maxLines, 400, 1, 2000)
        result = { path: relative, content: lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n'), startLine, endLine: Math.min(lines.length, startLine + maxLines - 1), totalLines: lines.length }
      } else if (name === 'file_write') {
        if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MAX_CONTENT_BYTES) throw new ToolError('INVALID_ARGUMENT', 'content must be text smaller than 1 MB')
        const { target, relative } = await checkedPath(context.workspace, args.path, { missing: true })
        if (relative === '.') throw new ToolError('INVALID_PATH', 'Cannot replace the workspace directory')
        await fs.mkdir(path.dirname(target), { recursive: true })
        await checkedPath(context.workspace, args.path, { missing: true })
        let backupPath = null, original, previousText = null
        try { original = await fs.lstat(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (original && !original.isFile()) throw new ToolError('INVALID_PATH', 'Only regular files can be replaced')
        if (original) {
          try { previousText = await readText(target) } catch (error) { previousText = null }
          const directory = path.join(dataDir, 'backups', randomUUID())
          await fs.mkdir(directory, { recursive: true })
          backupPath = path.join(directory, path.basename(target))
          await fs.copyFile(target, backupPath, constants.COPYFILE_EXCL)
        }
        const temporary = path.join(path.dirname(target), `.tengyun-${randomUUID()}.tmp`)
        let handle
        try {
          throwIfAborted(context.signal)
          handle = await fs.open(temporary, 'wx', original?.mode ?? 0o600)
          await handle.writeFile(args.content, 'utf8')
          await handle.sync()
          await handle.close(); handle = undefined
          await checkedPath(context.workspace, args.path, { missing: true })
          throwIfAborted(context.signal)
          await fs.rename(temporary, target)
        } finally { await handle?.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}) }
        result = { path: relative, bytes: Buffer.byteLength(args.content), replaced: Boolean(original), backupPath, diff: unifiedDiff(previousText, args.content, relative) }
      } else if (name === 'list_files') {
        const { root, target } = await checkedPath(context.workspace, args.path ?? '.', { directory: true })
        result = await walk(root, target, { maxDepth: number(args.maxDepth, 2, 0, 8), maxFiles: number(args.limit, 500, 1, 2000), signal: context.signal })
      } else if (name === 'search_files') {
        if (typeof args.query !== 'string' || !args.query || args.query.length > 1000) throw new ToolError('INVALID_ARGUMENT', 'query must contain 1–1000 characters')
        const { root, target } = await checkedPath(context.workspace, args.path ?? '.', { directory: true })
        const limit = number(args.limit, 120, 1, 400)
        const matches = []
        const listing = await walk(root, target, { signal: context.signal })
        let truncated = listing.truncated
        if (args.glob === true) {
          const pattern = globToRegExp(args.query)
          for (const entry of listing.entries) {
            if (entry.type === 'file' && pattern.test(entry.path.split(path.sep).join('/'))) matches.push({ path: entry.path, line: 0, text: `${entry.size} bytes` })
            if (matches.length >= limit) { truncated = true; break }
          }
          result = { mode: 'glob', matches, truncated }
        } else {
          let test
          if (args.regex === true) {
            try { test = new RegExp(args.query, args.caseSensitive ? 'g' : 'gi') }
            catch (error) { throw new ToolError('INVALID_ARGUMENT', `Invalid regular expression: ${error.message}`) }
          } else {
            const needle = args.caseSensitive ? args.query : args.query.toLowerCase()
            test = { exec: line => (args.caseSensitive ? line : line.toLowerCase()).includes(needle) ? [needle] : null }
          }
          for (const entry of listing.entries) {
            throwIfAborted(context.signal)
            if (entry.type !== 'file' || entry.size > MAX_CONTENT_BYTES) continue
            const checked = await checkedPath(root, entry.path)
            let content
            try { content = await readText(checked.target) }
            catch (error) { if (error.code === 'BINARY_FILE' || error.code === 'FILE_TOO_LARGE') continue; throw error }
            const lines = content.split(/\r?\n/)
            for (let index = 0; index < lines.length; index++) {
              test.lastIndex = 0
              if (test.exec(lines[index])) matches.push({ path: entry.path, line: index + 1, text: lines[index].slice(0, 2000) })
              if (matches.length >= limit) { truncated = true; break }
            }
            if (matches.length >= limit) break
          }
          result = { mode: args.regex === true ? 'regex' : 'literal', matches, truncated }
        }
      }
      return redactSecrets(result, secrets)
    },
  }
}
