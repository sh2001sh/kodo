import { KodoError } from '../runtime/types.js';
import type { Run } from '../runtime/types.js';
import { builtinToolNames } from './index.js';

interface ToolBindings { bindingSnapshot(allowed: string[], skillIds?: readonly string[]): Record<string, string> }

/** Refuse to reinterpret persisted calls under a different host capability contract. */
export function assertRunCapabilities(run: Run, tools: ToolBindings): void {
  const current = tools.bindingSnapshot(run.card.tools, run.card.skills ?? []);
  const exposed = new Set([...run.card.tools, 'history.read']);
  for (const name of exposed) {
    if (!Object.hasOwn(current, name)) throw new KodoError('CAPABILITY_CHANGED', `tool ${name} is no longer installed; restore its original host registration or start a new run`);
  }
  if (run.toolBindings === undefined) {
    // Pre-extension databases contained only builtin tools. Never silently approve
    // an unpinned extension when opening a historical run.
    const legacy = new Set(builtinToolNames.filter(name => name !== 'shell.exec' && name !== 'image.read'));
    for (const name of Object.keys(current)) if (!legacy.has(name)) throw new KodoError('CAPABILITY_CHANGED', `historical tool ${name} has no pinned host contract; start a new run`);
    return;
  }
  for (const [name, fingerprint] of Object.entries(current)) {
    if (!Object.hasOwn(run.toolBindings, name) || run.toolBindings[name] !== fingerprint) throw new KodoError('CAPABILITY_CHANGED', `tool ${name} differs from the pinned host contract; restore its original registration or start a new run`);
  }
}
