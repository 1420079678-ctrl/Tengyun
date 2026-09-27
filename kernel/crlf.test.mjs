import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools } from './tools.mjs'

test('apply_patch seamlessly handles Windows CRLF vs AI LF and preserves file EOL', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'crlf-ws-'))
  const data = await mkdtemp(join(tmpdir(), 'crlf-data-'))
  const tools = createTools({ dataDir: data })

  // File on Windows with CRLF
  await writeFile(join(ws, 'hello.js'), 'function greet() {\r\n  const msg = "world";\r\n  return msg;\r\n}\r\n')

  // AI model emits plain LF
  const result = await tools.execute('apply_patch', {
    path: 'hello.js',
    oldText: '  const msg = "world";\n',
    newText: '  const msg = "universe";\n',
  }, { workspace: ws, dataDir: data, approvalGranted: true })

  assert.equal(result.replaced, 1)
  const after = await readFile(join(ws, 'hello.js'), 'utf8')
  assert.ok(after.includes('"universe"'))
  assert.ok(after.includes('\r\n'), 'Original CRLF line endings were preserved')
})

test('apply_patch handles trailing whitespace tolerance gracefully', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'ws-ws-'))
  const data = await mkdtemp(join(tmpdir(), 'ws-data-'))
  const tools = createTools({ dataDir: data })

  // File has trailing space on one line
  await writeFile(join(ws, 'app.py'), 'def run():   \n    return 42\n')

  // AI model omitted the trailing space in oldText
  const result = await tools.execute('apply_patch', {
    path: 'app.py',
    oldText: 'def run():\n    return 42\n',
    newText: 'def run():\n    return 100\n',
  }, { workspace: ws, dataDir: data, approvalGranted: true })

  assert.equal(result.replaced, 1)
  const after = await readFile(join(ws, 'app.py'), 'utf8')
  assert.ok(after.includes('100'))
})

test('code_symbols accurately extracts functions, classes, and types', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'sym-ws-'))
  const data = await mkdtemp(join(tmpdir(), 'sym-data-'))
  const tools = createTools({ dataDir: data })

  await writeFile(join(ws, 'service.ts'), `
export class PaymentService {
  constructor() {}
  async processPayment(amount: number) {
    return true;
  }
}

export function calculateTax(rate: number) {
  return rate * 0.1;
}

export interface PaymentReceipt {
  id: string;
  total: number;
}
`)

  const res = await tools.execute('code_symbols', { path: 'service.ts' }, { workspace: ws, dataDir: data })
  assert.equal(res.symbols.length, 3)
  assert.equal(res.symbols[0].name, 'PaymentService')
  assert.equal(res.symbols[0].kind, 'class')
  assert.equal(res.symbols[1].name, 'calculateTax')
  assert.equal(res.symbols[1].kind, 'function')
  assert.equal(res.symbols[2].name, 'PaymentReceipt')
  assert.equal(res.symbols[2].kind, 'type')
})

