/**
 * Git capabilities: inspect the working tree, and commit after approval.
 * Both shell out through the shared bounded command runner, so output limits, timeouts,
 * process-tree kill and streamed output behave exactly like run_command.
 */
import { ToolError, object, executeCommand } from '../primitives.mjs'

export const tags = ['vcs', 'code']

export const definitions = [
  {
    name: 'git_diff',
    description: 'Show working tree changes as a unified diff. Read-only, never needs approval.',
    parameters: object({
      staged: { type: 'boolean' },
      timeoutMs: { type: 'integer', minimum: 100, maximum: 300000 },
    }, []),
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and create a commit after user approval.',
    requiresApproval: true,
    parameters: object({
      message: string_('Commit message'),
      timeoutMs: { type: 'integer', minimum: 100, maximum: 300000 },
    }, ['message']),
  },
]

function string_(description) { return { type: 'string', description } }

async function git(args, command, context) {
  const result = await executeCommand({ command, timeoutMs: args.timeoutMs ?? 120000 }, context)
  return { ...result, ok: result.exitCode === 0 }
}

async function diff(args, context) {
  const result = await git(args, `git diff ${args.staged ? '--cached ' : ''}--no-color`, context)
  if (result.exitCode !== 0 && /not a git repository/i.test(result.stderr)) {
    throw new ToolError('NOT_A_REPO', 'This workspace is not a Git repository')
  }
  const files = [...result.stdout.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map(match => match[2])
  return { ...result, files, changed: Boolean(result.stdout.trim()) }
}

async function commit(args, context) {
  if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 400) {
    throw new ToolError('INVALID_ARGUMENT', 'message must contain 1–400 characters')
  }
  const message = args.message.replace(/"/g, "'")
  const add = await executeCommand({ command: 'git add -A', timeoutMs: args.timeoutMs ?? 120000 }, context)
  if (add.exitCode !== 0) {
    throw new ToolError('GIT_FAILED', `git add failed: ${(add.stderr || add.stdout).trim().slice(0, 400)}`)
  }
  const result = await executeCommand({ command: `git commit -m "${message}"`, timeoutMs: args.timeoutMs ?? 120000 }, context)
  return { ...result, ok: result.exitCode === 0 }
}

const handlers = { git_diff: diff, git_commit: commit }

export async function run(name, args, context) {
  const handler = handlers[name]
  if (!handler) throw new ToolError('UNKNOWN_TOOL', `Unknown capability: ${name}`)
  return handler(args, context)
}
