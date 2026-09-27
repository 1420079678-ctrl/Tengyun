/**
 * Office document capability — ported from the dsh-office-docs plugin.
 *
 * The real engine is a deterministic Python script (reportlab / pdfplumber / pypdf / pypdfium2 /
 * python-docx / python-pptx / openpyxl / pandoc). Rather than reimplementing it, this module
 * keeps that engine verbatim and wraps it:
 *   - the script is extracted out of app.asar into the data dir, because an external
 *     interpreter cannot open a path inside an asar archive
 *   - every path the engine touches is resolved through the workspace guard first, so the
 *     model cannot read or write outside the selected directory
 *   - the whole tool requires approval, because most actions write files
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolError, object, string, checkedPath, number, throwIfAborted } from '../primitives.mjs'

export const tags = ['office', 'documents']

const ACTIONS = [
  'pdf_build', 'pdf_extract', 'pdf_render',
  'docx_build', 'docx_extract', 'docx_append',
  'pptx_build', 'pptx_extract',
  'xlsx_build', 'xlsx_extract',
  'convert',
]
/** Actions whose `path` argument must already exist. The rest create it. */
const NEEDS_EXISTING = new Set(['pdf_extract', 'pdf_render', 'docx_extract', 'docx_append', 'pptx_extract', 'xlsx_extract'])
const ENGINE_TIMEOUT_MS = 240_000

const block = {
  type: 'object', additionalProperties: false,
  properties: {
    type: { type: 'string', description: 'heading | para | table | image | spacer' },
    text: { type: 'string' },
    level: { type: 'integer', minimum: 1, maximum: 6 },
    bold: { type: 'boolean' },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    width: { type: 'number' },
    ratio: { type: 'number' },
    height: { type: 'number' },
  },
}

export const definitions = [
  {
    name: 'office_docs',
    description: [
      'Create, read and edit Office documents inside the workspace.',
      'pdf_build/pdf_extract/pdf_render (PDF), docx_build/docx_extract/docx_append (Word),',
      'pptx_build/pptx_extract (PowerPoint), xlsx_build/xlsx_extract (Excel), convert (pandoc between formats).',
      'Build actions take `path` plus content: blocks=[{type:heading|para|table|image|spacer, text, level, bold, rows}] for PDF/Word,',
      'slides=[{title, bullets:[str]}] for PowerPoint, sheets=[{name, rows:[[value]]}] for Excel.',
      'Extract actions take only `path`. pdf_render also takes `outdir` and `scale`. convert takes `input`, `output`, `from`, `to`.',
      'Requires Python 3 with the document libraries installed; report a clear error instead of guessing if it is missing.',
    ].join(' '),
    requiresApproval: true,
    parameters: object({
      action: { type: 'string', enum: ACTIONS, description: 'Which document operation to run' },
      path: string('Document path relative to the workspace (input for extract/append/render, output for build)'),
      output: string('Destination path for convert'),
      input: string('Source path for convert'),
      from: string('Source format for convert, e.g. md'),
      to: string('Target format for convert, e.g. docx'),
      standalone: { type: 'boolean', description: 'convert: emit a standalone document' },
      outdir: string('pdf_render: directory for the rendered PNG pages'),
      scale: { type: 'number', description: 'pdf_render: render scale, default 1.5' },
      blocks: { type: 'array', items: block, maxItems: 200 },
      slides: {
        type: 'array', maxItems: 200,
        items: {
          type: 'object', additionalProperties: false,
          properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' }, maxItems: 50 } },
        },
      },
      sheets: {
        type: 'array', maxItems: 50,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string' },
            rows: { type: 'array', maxItems: 20000, items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
          },
        },
      },
    }, ['action']),
  },
]

const ENGINE_SOURCE = fileURLToPath(new URL('./office/engine.py', import.meta.url))

/** Copy the engine out of the archive so an external interpreter can run it. */
async function ensureEngine(dataDir) {
  if (!dataDir) throw new ToolError('NO_DATA_DIR', 'This session has no data directory for the document engine')
  const directory = path.join(dataDir, 'tools')
  const target = path.join(directory, 'office_docs.py')
  const source = await fs.readFile(ENGINE_SOURCE, 'utf8')
  await fs.mkdir(directory, { recursive: true })
  let current = null
  try { current = await fs.readFile(target, 'utf8') } catch { current = null }
  if (current !== source) await fs.writeFile(target, source, 'utf8')
  return target
}

let cachedPython = null

function tryPython(candidate) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(candidate, ['-c', 'import sys;sys.stdout.write(str(sys.version_info[0]))'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { return resolve(false) }
    let out = ''
    const timer = setTimeout(() => { child.kill(); resolve(false) }, 8000)
    child.stdout.on('data', chunk => { out += chunk })
    child.once('error', () => { clearTimeout(timer); resolve(false) })
    child.once('close', () => { clearTimeout(timer); resolve(out.trim() === '3') })
  })
}

async function findPython() {
  if (cachedPython) return cachedPython
  for (const candidate of ['python', 'python3', 'py']) {
    if (await tryPython(candidate)) { cachedPython = candidate; return candidate }
  }
  throw new ToolError('PYTHON_MISSING', 'Python 3 was not found on PATH; install Python 3 with reportlab, pdfplumber, pypdf, pypdfium2, python-docx, python-pptx and openpyxl to use document tools')
}

/** Absolute-path resolution stays in JavaScript so the workspace guard always applies. */
async function resolvePaths(action, args, workspace) {
  const resolved = { ...args }
  delete resolved.action
  const mustExist = NEEDS_EXISTING.has(action)
  if (typeof resolved.path === 'string' && resolved.path) {
    resolved.path = (await checkedPath(workspace, resolved.path, { missing: !mustExist })).target
  } else if (!mustExist && action !== 'convert') {
    // Default output location, matching the engine's own fallback but anchored to the workspace.
    const stem = { pdf: 'output.pdf', docx: 'output.docx', pptx: 'output.pptx', xlsx: 'output.xlsx' }[action.split('_')[0]]
    resolved.path = (await checkedPath(workspace, stem, { missing: true })).target
  }
  if (typeof resolved.input === 'string' && resolved.input) {
    resolved.input = (await checkedPath(workspace, resolved.input)).target
  }
  if (typeof resolved.output === 'string' && resolved.output) {
    resolved.output = (await checkedPath(workspace, resolved.output, { missing: true })).target
  }
  if (typeof resolved.outdir === 'string' && resolved.outdir) {
    resolved.outdir = (await checkedPath(workspace, resolved.outdir, { missing: true })).target
  }
  if (action === 'pdf_render' && resolved.scale !== undefined) {
    resolved.scale = number(resolved.scale, 1.5, 0.2, 6)
  }
  return resolved
}

function runEngine(python, engine, action, payload, context) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [engine, action], {
      cwd: context.workspace,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    let stdout = '', stderr = ''
    let settled = false
    const finish = fn => { if (!settled) { settled = true; clearTimeout(timer); context.signal?.removeEventListener('abort', abort); fn() } }
    const abort = () => { child.kill(); finish(() => reject(new ToolError('CANCELLED', 'Document operation cancelled'))) }
    const timer = setTimeout(() => { child.kill(); finish(() => reject(new ToolError('TIMEOUT', 'Document operation exceeded its time limit'))) }, ENGINE_TIMEOUT_MS)
    context.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => finish(() => reject(new ToolError('ENGINE_FAILED', error.message))))
    child.once('close', code => finish(() => {
      if (code !== 0) return reject(new ToolError('ENGINE_FAILED', (stderr || stdout).trim().slice(0, 1500) || `engine exited with ${code}`))
      try { resolve(JSON.parse(stdout)) }
      catch { reject(new ToolError('ENGINE_FAILED', `engine returned non-JSON output: ${stdout.slice(0, 300)}`)) }
    }))
    child.stdin.on('error', () => { /* the engine may exit before reading all input */ })
    child.stdin.end(JSON.stringify(payload), 'utf8')
  })
}

export async function run(name, args, context) {
  if (name !== 'office_docs') throw new ToolError('UNKNOWN_TOOL', `Unknown capability: ${name}`)
  const action = args.action
  if (!ACTIONS.includes(action)) {
    throw new ToolError('INVALID_ARGUMENT', `action must be one of: ${ACTIONS.join(', ')}`)
  }
  throwIfAborted(context.signal)
  const payload = await resolvePaths(action, args, context.workspace)
  const engine = await ensureEngine(context.dataDir)
  const python = await findPython()
  const result = await runEngine(python, engine, action, payload, context)
  return { action, ...result }
}
