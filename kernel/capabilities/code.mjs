/**
 * Code capabilities: batch reading, verbatim block patching.
 * Both operate strictly inside the selected workspace through the shared path checks.
 */
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ToolError, object, string, checkedPath, number, readText, walk, unifiedDiff, throwIfAborted, MAX_CONTENT_BYTES } from '../primitives.mjs'

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
  {
    name: 'code_symbols',
    description: 'Scan code files across the workspace or a specific directory to locate declarations of functions, classes, methods, and types. Use this to find where symbols are defined without grep guessing.',
    parameters: object({
      query: { type: 'string', description: 'Symbol name or substring to search for; empty string lists top symbols' },
      path: { type: 'string', description: 'Optional relative path to file or directory to inspect; defaults to workspace root' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
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

function normalizeEol(text) {
  return String(text).replaceAll('\r\n', '\n');
}

function findPatchOccurrences(content, oldText) {
  // 1. Direct match on raw content
  let count = content.split(oldText).length - 1;
  if (count > 0) return { mode: 'exact', count, matchStr: oldText };

  // 2. CRLF-normalized match
  const normContent = normalizeEol(content);
  const normOld = normalizeEol(oldText);
  count = normContent.split(normOld).length - 1;
  if (count > 0) return { mode: 'normalized_eol', count, normContent, normOld };

  // 3. Line-ending & trailing whitespace tolerant match
  const contentLines = normContent.split('\n');
  const oldLines = normOld.split('\n');
  if (oldLines.length > 0 && oldLines.length <= contentLines.length) {
    const matches = [];
    const trimmedOld = oldLines.map(l => l.trimEnd());
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let allMatch = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (contentLines[i + j].trimEnd() !== trimmedOld[j]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) matches.push(i);
    }
    if (matches.length > 0) {
      return { mode: 'line_trimmed', count: matches.length, matchLineIndices: matches, contentLines, oldLines };
    }
  }

  return { mode: 'none', count: 0 };
}

function applyReplacement(before, matchInfo, oldText, newText, replaceAll) {
  const isCrlf = before.includes('\r\n');
  const eol = isCrlf ? '\r\n' : '\n';

  if (matchInfo.mode === 'exact') {
    return replaceAll === true ? before.split(oldText).join(newText) : before.replace(oldText, newText);
  }

  if (matchInfo.mode === 'normalized_eol') {
    const normNew = normalizeEol(newText);
    const replacedNorm = replaceAll === true
      ? matchInfo.normContent.split(matchInfo.normOld).join(normNew)
      : matchInfo.normContent.replace(matchInfo.normOld, normNew);
    return isCrlf ? replacedNorm.replaceAll('\n', '\r\n') : replacedNorm;
  }

  if (matchInfo.mode === 'line_trimmed') {
    const normNew = normalizeEol(newText);
    const newLines = normNew.split('\n');
    const lines = [...matchInfo.contentLines];
    const indices = replaceAll === true ? [...matchInfo.matchLineIndices].reverse() : [matchInfo.matchLineIndices[0]];
    for (const startIdx of indices) {
      lines.splice(startIdx, matchInfo.oldLines.length, ...newLines);
    }
    const joined = lines.join('\n');
    return isCrlf ? joined.replaceAll('\n', '\r\n') : joined;
  }

  return before;
}

async function applyPatch(args, context) {
  if (typeof args.oldText !== 'string' || !args.oldText) throw new ToolError('INVALID_ARGUMENT', 'oldText must be nonempty exact text');
  if (typeof args.newText !== 'string') throw new ToolError('INVALID_ARGUMENT', 'newText must be a string');
  if (!context.dataDir) throw new ToolError('NO_BACKUP_STORE', 'No backup directory is configured for this session');
  const { target, relative } = await checkedPath(context.workspace, args.path);
  const before = await readText(target);

  const matchInfo = findPatchOccurrences(before, args.oldText);
  if (matchInfo.count === 0) {
    throw new ToolError('PATCH_MISS', `oldText was not found in ${relative}; read the file again to inspect current lines`);
  }
  if (matchInfo.count > 1 && args.replaceAll !== true) {
    throw new ToolError('PATCH_AMBIGUOUS', `oldText matches ${matchInfo.count} locations in ${relative}; add more context or set replaceAll`);
  }

  const after = applyReplacement(before, matchInfo, args.oldText, args.newText, args.replaceAll);
  if (after === before) throw new ToolError('PATCH_NOOP', 'The replacement did not change the file');

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
  return { path: relative, replaced: matchInfo.count, backupPath, diff: unifiedDiff(before, after, relative) }
}

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rs', '.go', '.java', '.cs', '.cpp', '.c', '.h', '.hpp', '.rb', '.php',
]);

function extractSymbolsFromLine(line, lineNum, file) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return null;
  }
  let match = /(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z0-9_$]+)/.exec(line);
  if (match) return { name: match[1], kind: 'class', line: lineNum, file, preview: trimmed.slice(0, 120) };

  match = /(?:export\s+)?(?:interface|type)\s+([a-zA-Z0-9_$]+)/.exec(line);
  if (match) return { name: match[1], kind: 'type', line: lineNum, file, preview: trimmed.slice(0, 120) };

  match = /^\s*class\s+([a-zA-Z0-9_]+)/.exec(line);
  if (match) return { name: match[1], kind: 'class', line: lineNum, file, preview: trimmed.slice(0, 120) };

  match = /(?:pub\s+)?(?:struct|enum|trait|impl)\s+([a-zA-Z0-9_]+)/.exec(line);
  if (match) return { name: match[1], kind: 'struct', line: lineNum, file, preview: trimmed.slice(0, 120) };

  match = /^type\s+([a-zA-Z0-9_]+)\s+(?:struct|interface)/.exec(line);
  if (match) return { name: match[1], kind: 'type', line: lineNum, file, preview: trimmed.slice(0, 120) };

  match = /(?:export\s+)?(?:async\s+)?function\s*([a-zA-Z0-9_$]+)/.exec(line);
  if (match) return { name: match[1], kind: 'function', line: lineNum, file, preview: trimmed.slice(0, 120) };

  match = /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/.exec(line);
  if (match) return { name: match[1], kind: 'function', line: lineNum, file, preview: trimmed.slice(0, 120) };

  match = /^\s*def\s+([a-zA-Z0-9_]+)/.exec(line);
  if (match) return { name: match[1], kind: 'function', line: lineNum, file, preview: trimmed.slice(0, 120) };

  match = /^func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)/.exec(line);
  if (match) return { name: match[1], kind: 'function', line: lineNum, file, preview: trimmed.slice(0, 120) };

  match = /(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z0-9_]+)/.exec(line);
  if (match) return { name: match[1], kind: 'function', line: lineNum, file, preview: trimmed.slice(0, 120) };

  return null;
}

async function codeSymbols(args, context) {
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const limit = number(args.limit, 60, 1, 200);
  const targetPath = args.path ? String(args.path).trim() : '.';
  const { root, target, relative } = await checkedPath(context.workspace, targetPath);

  const symbols = [];
  const stat = await fs.lstat(target);

  const scanFile = async (filePath, rel) => {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) return;
      const content = await readText(filePath);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        throwIfAborted(context.signal);
        const item = extractSymbolsFromLine(lines[i], i + 1, rel);
        if (item) {
          if (!query || item.name.toLowerCase().includes(query)) {
            symbols.push(item);
            if (symbols.length >= limit) return;
          }
        }
      }
    } catch {}
  };

  if (stat.isFile()) {
    await scanFile(target, relative);
  } else {
    const listing = await walk(root, target, { maxDepth: 6, maxFiles: 400, signal: context.signal });
    for (const item of listing.entries) {
      if (symbols.length >= limit) break;
      if (item.type !== 'file') continue;
      const full = path.join(root, item.path);
      await scanFile(full, item.path);
    }
  }

  return { symbols, total: symbols.length, truncated: symbols.length >= limit };
}

const handlers = { read_many: readMany, apply_patch: applyPatch, code_symbols: codeSymbols }

export async function run(name, args, context) {
  const handler = handlers[name]
  if (!handler) throw new ToolError('UNKNOWN_TOOL', `Unknown capability: ${name}`)
  return handler(args, context)
}
