/**
 * Code capabilities: batch reading, verbatim block patching.
 * Both operate strictly inside the selected workspace through the shared path checks.
 */
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ToolError, object, string, checkedPath, number, readText, unifiedDiff, throwIfAborted, MAX_CONTENT_BYTES } from '../primitives.mjs'

export const tags = ['code', 'files']

export const definitions = [
  {
    name: 'read_many',
    description: 'Read several files in one call to save round trips. Each result is truncated independently; a missing or unreadable file reports its own error instead of failing the batch.',
    parameters: object({
      paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      maxLines: { type: 'integer', minimum: 1, maximum: 800 },
    }, ['paths']),
  },
  {
    name: 'apply_patch',
    description: 'Replace an exact block of lines inside an existing file after user approval. Use when only part of a file must change. Returns a unified diff for review.',
    requiresApproval: true,
    parameters: object({
      path: string('Path relative to workspace'),
      oldText: string('Exact existing text to replace, including indentation'),
      newText: string('Replacement text'),
      replaceAll: { type: 'boolean' },
    }, ['path', 'oldText', 'newText']),
  },
]

async function readMany(args, context) {
  const maxLines = number(args.maxLines, 300, 1, 800)
  const files = []
  for (const requested of args.paths) {
    throwIfAborted(context.signal)
    try {
      const { target, relative } = await checkedPath(context.workspace, requested)
      const lines = (await readText(target)).split(/\r?\n/)
      files.push({
        path: relative,
        totalLines: lines.length,
        content: lines.slice(0, maxLines).join('\n'),
        truncated: lines.length > maxLines,
      })
    } catch (error) {
      files.push({ path: requested, error: error instanceof Error ? error.message : 'unreadable' })
    }
  }
  return { files }
}

async function applyPatch(args, context) {
  if (typeof args.oldText !== 'string' || !args.oldText) throw new ToolError('INVALID_ARGUMENT', 'oldText must be nonempty exact text')
  if (typeof args.newText !== 'string') throw new ToolError('INVALID_ARGUMENT', 'newText must be a string')
  if (!context.dataDir) throw new ToolError('NO_BACKUP_STORE', 'No backup directory is configured for this session')
  const { target, relative } = await checkedPath(context.workspace, args.path)
  const before = await readText(target)
  const occurrences = before.split(args.oldText).length - 1
  if (occurrences === 0) throw new ToolError('PATCH_MISS', 'oldText was not found verbatim; read the file again and copy the exact block')
  if (occurrences > 1 && args.replaceAll !== true) throw new ToolError('PATCH_AMBIGUOUS', `oldText appears ${occurrences} times; add more context or set replaceAll`)
  const after = args.replaceAll === true ? before.split(args.oldText).join(args.newText) : before.replace(args.oldText, args.newText)
  if (after === before) throw new ToolError('PATCH_NOOP', 'The replacement did not change the file')

  const directory = path.join(context.dataDir, 'backups', randomUUID())
  await fs.mkdir(directory, { recursive: true })
  const backupPath = path.join(directory, path.basename(target))
  await fs.copyFile(target, backupPath, constants.COPYFILE_EXCL)

  const temporary = path.join(path.dirname(target), `.tengyun-${randomUUID()}.tmp`)
  let handle
  try {
    throwIfAborted(context.signal)
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(after, 'utf8')
    await handle.sync()
    await handle.close(); handle = undefined
    await checkedPath(context.workspace, args.path)
    throwIfAborted(context.signal)
    await fs.rename(temporary, target)
  } finally { await handle?.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}) }
  return { path: relative, replaced: occurrences, backupPath, diff: unifiedDiff(before, after, relative) }
}

const handlers = { read_many: readMany, apply_patch: applyPatch }

export async function run(name, args, context) {
  const handler = handlers[name]
  if (!handler) throw new ToolError('UNKNOWN_TOOL', `Unknown capability: ${name}`)
  return handler(args, context)
}
