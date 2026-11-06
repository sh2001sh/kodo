import { errorText, KodoError } from '../runtime/types.js';
import type { ToolBoundary, ToolContext, ToolPlugin } from '../plugins/tool.js';
import type { CoreToolCall, ToolRequest, ToolSpec } from './types.js';

/** Finds the plugin that owns a tool name and calls it, through the boundary when one is set. */
export class ToolDispatcher {
  private readonly owners = new Map<string, ToolPlugin>();
  constructor(private readonly boundary?: ToolBoundary) {}
  add(plugin: ToolPlugin): void {
    for (const tool of plugin.tools) {
      const owner = this.owners.get(tool.name);
      if (owner) throw new KodoError('TOOL_CONFLICT', `tool ${tool.name} is provided by both ${owner.name} and ${plugin.name}`);
    }
    for (const tool of plugin.tools) this.owners.set(tool.name, plugin);
  }
  /** Model-visible schemas only; policy fields stay host-side. Unavailable tools are omitted. */
  specs(): ToolSpec[] {
    return [...this.owners.entries()].map(([name, plugin]) => plugin.tools.find(tool => tool.name === name)!)
      .filter(tool => tool.available !== false).map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
  /** Never throws for tool faults: unknown tools, bad JSON and tool errors become failed calls. */
  async dispatch(request: ToolRequest, context: Omit<ToolContext, 'markEffectStarted'>): Promise<CoreToolCall> {
    const base = { runId: context.runId, id: request.id, name: request.name };
    let args: unknown;
    try { args = request.arguments ? JSON.parse(request.arguments) : {}; }
    catch { return { ...base, arguments: request.arguments, status: 'failed', result: undefined, error: 'INVALID_ARGUMENTS: tool arguments are not valid JSON' }; }
    const plugin = this.owners.get(request.name);
    if (!plugin) return { ...base, arguments: args, status: 'failed', result: undefined, error: `TOOL_NOT_FOUND: ${request.name}` };
    const definition = plugin.tools.find(tool => tool.name === request.name)!;
    const invoke = async (inner: ToolContext): Promise<unknown> => await plugin.execute(request.name, args, inner);
    const bare: ToolContext = { ...context, markEffectStarted: () => {} };
    try { return { ...base, arguments: args, status: 'succeeded', result: await (this.boundary ? this.boundary.execute({ plugin, definition, args, context: bare }, invoke) : invoke(bare)) }; }
    catch (error) {
      context.signal.throwIfAborted();
      return { ...base, arguments: args, status: 'failed', result: undefined, error: errorText(error) };
    }
  }
}
