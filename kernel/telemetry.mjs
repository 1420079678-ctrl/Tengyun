/**
 * Autonomic Reflex Telemetry & Diagnostic Classifier for Tengyun.
 * Provides System 1 zero-token environment sensing and automated self-healing fault attribution.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

/**
 * Perform instant, zero-token environment sensing for the workspace.
 * Gathers Git status, toolchain capabilities, and project manifests.
 */
export function collectWorkspaceTelemetry(workspace) {
  if (!workspace || !existsSync(workspace)) {
    return { valid: false, workspace }
  }

  const telemetry = {
    valid: true,
    workspace,
    timestamp: new Date().toISOString(),
    git: null,
    projectType: 'generic',
    manifests: [],
    scripts: {},
    toolchain: {},
  }

  // 1. Git Status Detection
  try {
    const gitDir = join(workspace, '.git')
    if (existsSync(gitDir)) {
      let branch = 'unknown'
      try {
        branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspace, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      } catch {
        // Fallback: read .git/HEAD directly
        try {
          const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
          if (head.startsWith('ref: refs/heads/')) branch = head.replace('ref: refs/heads/', '')
        } catch {}
      }

      let dirtyCount = 0
      try {
        const status = execSync('git status --porcelain', { cwd: workspace, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        dirtyCount = status ? status.split('\n').filter(Boolean).length : 0
      } catch {}

      telemetry.git = { branch, dirty: dirtyCount > 0, modifiedFiles: dirtyCount }
    }
  } catch {}

  // 2. Project Manifest & Type Detection
  try {
    if (existsSync(join(workspace, 'package.json'))) {
      telemetry.manifests.push('package.json')
      telemetry.projectType = 'node/javascript'
      try {
        const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'))
        if (pkg.scripts) telemetry.scripts = { ...pkg.scripts }
        if (pkg.dependencies?.electron || pkg.devDependencies?.electron) telemetry.projectType = 'electron/node'
        else if (pkg.dependencies?.react || pkg.devDependencies?.react) telemetry.projectType = 'react/node'
        else if (pkg.dependencies?.vue || pkg.devDependencies?.vue) telemetry.projectType = 'vue/node'
      } catch {}
    }
    if (existsSync(join(workspace, 'pyproject.toml')) || existsSync(join(workspace, 'requirements.txt')) || existsSync(join(workspace, 'setup.py'))) {
      telemetry.manifests.push(existsSync(join(workspace, 'pyproject.toml')) ? 'pyproject.toml' : 'requirements.txt')
      telemetry.projectType = telemetry.projectType === 'generic' ? 'python' : `${telemetry.projectType}+python`
    }
    if (existsSync(join(workspace, 'Cargo.toml'))) {
      telemetry.manifests.push('Cargo.toml')
      telemetry.projectType = 'rust'
    }
    if (existsSync(join(workspace, 'go.mod'))) {
      telemetry.manifests.push('go.mod')
      telemetry.projectType = 'go'
    }
    if (existsSync(join(workspace, 'pom.xml')) || existsSync(join(workspace, 'build.gradle'))) {
      telemetry.manifests.push(existsSync(join(workspace, 'pom.xml')) ? 'pom.xml' : 'build.gradle')
      telemetry.projectType = 'java'
    }
  } catch {}

  // 3. Fast toolchain detection
  const probe = (cmd, args = '--version') => {
    try {
      const out = execSync(`${cmd} ${args}`, { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      return out.split('\n')[0].slice(0, 40)
    } catch {
      return null
    }
  }

  const nodeVer = probe('node')
  if (nodeVer) telemetry.toolchain.node = nodeVer
  const gitVer = probe('git')
  if (gitVer) telemetry.toolchain.git = gitVer
  const pythonVer = probe('python') || probe('py')
  if (pythonVer) telemetry.toolchain.python = pythonVer

  return telemetry
}

/**
 * Format telemetry into a clean markdown block for the System Prompt.
 */
export function formatTelemetryPrompt(telemetry) {
  if (!telemetry || !telemetry.valid) return ''

  const lines = ['[AUTONOMIC REFLEX TELEMETRY - Workspace Environment State]']
  if (telemetry.git) {
    lines.push(`- Git: on branch '${telemetry.git.branch}' (${telemetry.git.dirty ? `${telemetry.git.modifiedFiles} modified file(s)` : 'clean tree'})`)
  }
  lines.push(`- Project Type: ${telemetry.projectType} (manifests: ${telemetry.manifests.join(', ') || 'none'})`)
  if (Object.keys(telemetry.scripts).length > 0) {
    const scriptKeys = Object.keys(telemetry.scripts).slice(0, 8).join(', ')
    lines.push(`- Available Scripts: ${scriptKeys}`)
  }
  const toolchainParts = Object.entries(telemetry.toolchain).map(([name, ver]) => `${name} (${ver})`)
  if (toolchainParts.length > 0) {
    lines.push(`- Host Toolchain: ${toolchainParts.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Automated Self-Healing Diagnostic Classifier (DeepSeek Harness / SWE-bench Grade).
 * Analyzes command output or tool errors to extract root causes and prescribe remedies.
 */
export function diagnoseFailure(toolName, args, result, error) {
  const combined = [
    error?.message || '',
    typeof result === 'string' ? result : '',
    result?.error || '',
    result?.stderr || '',
    result?.stdout || '',
  ].filter(Boolean).join('\n')

  if (!combined.trim()) return null

  // 1. Syntax Error / Parser Crash
  const syntaxMatch = /(?:SyntaxError|ParseError):\s*([^\n]+)/i.exec(combined) ||
    /Syntax error:\s*([^\n]+)/i.exec(combined) ||
    /error:\s*could not compile|unexpected token\s*([^\n]+)/i.exec(combined)
  if (syntaxMatch) {
    const fileLineMatch = /([a-zA-Z0-9_\-./\\]+\.[a-z]{1,6}):(\d+)(?::(\d+))?/i.exec(combined)
    return {
      fault: 'SYNTAX_ERROR',
      target: fileLineMatch ? `${fileLineMatch[1]} (line ${fileLineMatch[2]})` : 'code file',
      attribution: `Syntax or parse error detected: ${syntaxMatch[1].trim()}`,
      prescription: fileLineMatch
        ? `Re-read ${fileLineMatch[1]} around line ${fileLineMatch[2]} with file_read, then apply a corrected patch with apply_patch.`
        : 'Inspect the modified file around the failure point and fix formatting or syntax.',
    }
  }

  // 2. Missing Module / Dependency
  const missingModuleMatch = /Cannot find module ['"]([^'"]+)['"]/i.exec(combined) ||
    /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/i.exec(combined) ||
    /ImportError:\s*cannot import name ['"]([^'"]+)['"]/i.exec(combined)
  if (missingModuleMatch) {
    const mod = missingModuleMatch[1]
    return {
      fault: 'MISSING_DEPENDENCY',
      target: mod,
      attribution: `Missing dependency or unresolvable module: '${mod}'`,
      prescription: `Check package manifest or install/import path. If '${mod}' is a local file, verify relative path; if third-party, check installation.`,
    }
  }

  // 3. Test Assertion Failure
  const assertMatch = /(?:AssertionError(?:\s*\[[^\]]+\])?|Assertion failure|assert\s+failed|Assertion\s+error|expected.*to equal|FAILED|FAIL\s+test)/i.exec(combined)
  if (assertMatch) {
    return {
      fault: 'TEST_ASSERTION_FAILURE',
      attribution: `Test assertion failed: ${assertMatch[0].trim().slice(0, 180)}`,
      prescription: 'Examine test expectations vs actual return value in test logs. Adjust the implementation to satisfy the assertion.',
    }
  }

  // 4. File Not Found (ENOENT)
  const enoentMatch = /ENOENT:\s*no such file or directory[,\s]*([^\n]*)/i.exec(combined) ||
    /FileNotFoundError:\s*\[Errno 2\] No such file or directory:\s*['"]?([^'"\n]+)['"]?/i.exec(combined)
  if (enoentMatch) {
    return {
      fault: 'PATH_NOT_FOUND',
      target: enoentMatch[1].trim(),
      attribution: `Referenced file or path does not exist: ${enoentMatch[1].trim()}`,
      prescription: 'Use list_files or search_files to confirm the real path and file name before executing.',
    }
  }

  // 5. Permission / Access Denied
  if (/EACCES|permission denied|Access is denied/i.test(combined)) {
    return {
      fault: 'PERMISSION_DENIED',
      attribution: 'Access denied or permission restricted.',
      prescription: 'Check file locks, administrative requirements, or read-only flags.',
    }
  }

  return {
    fault: 'EXECUTION_ERROR',
    attribution: `Command or tool failed with exit code ${result?.exitCode ?? 'non-zero'}.`,
    prescription: 'Review the stdout/stderr diagnostic traces above and verify your assumptions before retrying.',
  }
}
