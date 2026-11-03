import type { ModelResponse } from './types.js';

/** Provider wire names replace dots with underscores; tools hidden from a request lose their reverse mapping. */
const wireName = (name: string): string => name.replaceAll('.', '_');

export interface ResponseRepair {
  response: ModelResponse;
  renamed: { from: string; to: string }[];
  droppedToolCalls: number;
}

/**
 * Restores logical tool names for calls the provider could not map back
 * (tools absent from this request) and, for tool-less final-response requests,
 * removes tool calls so the reply is judged on its text instead of failing the
 * whole run with a protocol error.
 */
export function repairResponse(response: ModelResponse, knownTools: readonly string[], toolsForbidden: boolean): ResponseRepair {
  const calls = response.message.tool_calls ?? [];
  if (!calls.length) return { response, renamed: [], droppedToolCalls: 0 };
  if (toolsForbidden) {
    const message = { ...response.message };
    delete message.tool_calls;
    return { response: { ...response, message, finishReason: response.finishReason === 'tool_calls' ? 'stop' : response.finishReason }, renamed: [], droppedToolCalls: calls.length };
  }
  const known = new Set(knownTools);
  const byWire = new Map<string, string>();
  for (const name of knownTools) if (!byWire.has(wireName(name))) byWire.set(wireName(name), name);
  const renamed: { from: string; to: string }[] = [];
  const repaired = calls.map(call => {
    if (known.has(call.name)) return call;
    const logical = byWire.get(call.name);
    if (!logical) return call;
    renamed.push({ from: call.name, to: logical });
    return { ...call, name: logical };
  });
  return renamed.length ? { response: { ...response, message: { ...response.message, tool_calls: repaired } }, renamed, droppedToolCalls: 0 } : { response, renamed, droppedToolCalls: 0 };
}
