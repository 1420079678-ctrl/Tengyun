import test from 'node:test'
import assert from 'node:assert/strict'
import { collectWorkspaceTelemetry, formatTelemetryPrompt, diagnoseFailure } from './telemetry.mjs'

test('collectWorkspaceTelemetry captures toolchains and project metadata', async () => {
  const telemetry = collectWorkspaceTelemetry(process.cwd())
  assert.ok(telemetry)
  assert.ok(telemetry.workspace)
  assert.ok(telemetry.toolchain)
  assert.ok(telemetry.manifests)
  assert.ok(Array.isArray(telemetry.manifests))
  
  const prompt = formatTelemetryPrompt(telemetry)
  assert.ok(prompt.includes('AUTONOMIC REFLEX TELEMETRY'))
  assert.ok(prompt.includes('Project Type:'))
})

test('diagnoseFailure attributes test assertion failures', () => {
  const diagnostic = diagnoseFailure('run_command', { command: 'npm test' }, {
    exitCode: 1,
    stdout: 'AssertionError [ERR_ASSERTION]: Expected 42 to equal 43\n  at Context.<anonymous> (test.js:12:5)',
    stderr: '',
  })
  assert.ok(diagnostic)
  assert.equal(diagnostic.fault, 'TEST_ASSERTION_FAILURE')
  assert.ok(diagnostic.attribution.includes('AssertionError'))
})

test('diagnoseFailure attributes missing dependencies and syntax errors', () => {
  const depDiag = diagnoseFailure('run_command', { command: 'node index.js' }, {
    exitCode: 1,
    stdout: '',
    stderr: 'Error: Cannot find module "express"\nRequire stack:\n- /app/index.js',
  })
  assert.ok(depDiag)
  assert.equal(depDiag.fault, 'MISSING_DEPENDENCY')
  assert.equal(depDiag.target, 'express')
  assert.ok(depDiag.attribution.includes('Missing dependency'))

  const syntaxDiag = diagnoseFailure('run_command', { command: 'python app.py' }, {
    exitCode: 1,
    stdout: '',
    stderr: 'SyntaxError: invalid syntax on line 42',
  })
  assert.ok(syntaxDiag)
  assert.equal(syntaxDiag.fault, 'SYNTAX_ERROR')
  assert.ok(syntaxDiag.attribution.includes('Syntax or parse error'))
})
