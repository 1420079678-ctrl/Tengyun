/**
 * Capability registry.
 *
 * Built-in file/command/memory tools keep their bespoke safety checks inside tools.mjs.
 * Everything else is a *capability*: a module exporting a `definitions` array and a
 * `run(name, args, context)` function, registered here. Imports are static on purpose —
 * dynamic import of a relative path inside app.asar is not reliable under Electron's ESM loader.
 *
 * To add a capability: drop the module in this folder, add one import and one array entry.
 * The dispatch in tools.mjs needs no change.
 */
import * as code from './code.mjs'
import * as git from './git.mjs'
import * as office from './office.mjs'
import * as web from './web.mjs'

const modules = [code, git, office, web]

let cached = null

/**
 * Load and validate every capability module once. A malformed module is skipped and reported
 * rather than taking the whole toolset down.
 */
export async function loadCapabilities({ onError } = {}) {
  if (cached) return cached
  const names = new Set()
  const loaded = []
  for (const module of modules) {
    const list = Array.isArray(module.definitions) ? module.definitions : []
    for (const definition of list) {
      if (!definition?.name || typeof module.run !== 'function') { onError?.(new Error('capability definition is malformed')); continue }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(definition.name)) { onError?.(new Error(`invalid capability name: ${definition.name}`)); continue }
      if (definition.parameters?.type !== 'object' || definition.parameters.additionalProperties !== false) {
        onError?.(new Error(`capability ${definition.name} must declare an object schema with additionalProperties:false`))
        continue
      }
      if (names.has(definition.name)) { onError?.(new Error(`duplicate capability: ${definition.name}`)); continue }
      names.add(definition.name)
      loaded.push({ definition, run: module.run.bind(module), tags: module.tags ?? [] })
    }
  }
  cached = loaded
  return loaded
}

export async function capabilityNames() {
  return (await loadCapabilities()).map(item => item.definition.name)
}

/** Test seam: drop the cache so a test can reload after changing the module list. */
export function resetCapabilityCache() { cached = null }
