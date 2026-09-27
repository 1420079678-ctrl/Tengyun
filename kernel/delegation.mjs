export const READ_ONLY_TOOLS = new Set(['file_read', 'read_many', 'list_files', 'search_files', 'code_symbols', 'git_diff', 'skill_list', 'skill_read'])
export const PROGRESS_TOOL = {
  name: 'progress_update', description: 'Send a brief factual progress update, separate from the final answer. Report findings and the next step; not private reasoning.',
  parameters: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 600 } } },
}
export const DELEGATE_TOOL = {
  name: 'agent_delegate', description: 'Run 1–3 independent read-only specialists in parallel and collect their results. Each has isolated context, a 12-turn/120-second limit and cannot run commands, edit files, delegate again or enable skills. Main agent owns edits and verifies their conclusions. At most 6 specialists per user turn.',
  parameters: { type: 'object', additionalProperties: false, required: ['tasks'], properties: {
    tasks: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['role', 'task'], properties: {
      role: { type: 'string', enum: ['explore', 'plan', 'review'] }, task: { type: 'string', minLength: 1, maxLength: 6000 },
    } } },
  } },
}
export const ROLE_INSTRUCTIONS = {
  explore: 'Inspect relevant files and locate concrete entry points, dependencies and behavior. Return file/line evidence and unknowns.',
  plan: 'Inspect the project and propose a concise implementation plan, dependencies, tradeoffs and verification. Do not implement changes.',
  review: 'Independently review the requested code for specific defects. Cite file/line evidence, impact and reproducible conditions. Do not invent findings.',
}

/** Enforce worker capabilities in the dispatcher, not only in model instructions. */
export function specialistTools(tools, snapshot) {
  return {
    allowDelegation: false,
    definitions: tools.definitions.filter(d => READ_ONLY_TOOLS.has(d.name)),
    async allDefinitions() {
      const all = tools.allDefinitions ? await tools.allDefinitions() : tools.definitions
      return all.filter(d => READ_ONLY_TOOLS.has(d.name) && !d.requiresApproval)
    },
    skillSnapshot: async () => snapshot,
    async execute(name, args, context) {
      if (!READ_ONLY_TOOLS.has(name)) throw new Error('Specialists are read-only; tool refused')
      return tools.execute(name, args, { ...context, approved: false, approvalGranted: false })
    },
  }
}
