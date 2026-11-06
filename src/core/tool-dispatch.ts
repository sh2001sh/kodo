import { errorText, KodoError } from '../runtime/types.js';
import type { ToolContext, ToolPlugin } from '../plugins/tool.js';
import type { CoreToolCall, ToolRequest, ToolSpec } from './types.js';

/** Finds the plugin that owns a tool name and calls it. Owns nothing else. */
export class ToolDispatcher {
  private readonly owners = new Map<string, ToolPlugin>();
  add(plugin: ToolPlugin): void {
    for (const tool of plugin.tools) {
      const owner = this.owners.get(tool.name);
      if (owner) throw new KodoError('TOOL_CONFLICT', `tool ${tool.name} is provided by both ${owner.name} and ${plugin.name}`);
    }
    for (const tool of plugin.tools) this.owners.set(tool.name, plugin);
  }
  specs(): ToolSpec[] {
    return [...this.owners.entries()].map(([name, plugin]) => plugin.tools.find(tool => tool.name === name)!);
  }
  /** Never throws for tool faults: unknown tools, bad JSON and tool errors become failed calls. */
  async dispatch(request: ToolRequest, context: ToolContext): Promise<CoreToolCall> {
    const base = { runId: context.runId, id: request.id, name: request.name };
    let args: unknown;
    try { args = request.arguments ? JSON.parse(request.arguments) : {}; }
    catch { return { ...base, arguments: request.arguments, status: 'failed', result: undefined, error: 'INVALID_ARGUMENTS: tool arguments are not valid JSON' }; }
    const plugin = this.owners.get(request.name);
    if (!plugin) return { ...base, arguments: args, status: 'failed', result: undefined, error: `TOOL_NOT_FOUND: ${request.name}` };
    try { return { ...base, arguments: args, status: 'succeeded', result: await plugin.execute(request.name, args, context) }; }
    catch (error) {
      context.signal.throwIfAborted();
      return { ...base, arguments: args, status: 'failed', result: undefined, error: errorText(error) };
    }
  }
}
