import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach } from 'vitest';
import { Application } from '../src/application/index.js';
import type { ApplicationOptions } from '../src/application/index.js';
import type { ModelResponse, Permission, Provider, ToolRequest } from '../src/runtime/types.js';

export const binding = { model: 'test-model', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_TEST_KEY', limits: { context: 256_000, output: 8192 } };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  while (cleanup.length) {
    try { await cleanup.pop()!(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'test cleanup failed');
});
export function temp(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kodo-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}
export const answer = (content = 'done'): ModelResponse => ({ message: { role: 'assistant', content }, finishReason: 'stop', usage: { input: 60, output: 20 } });
export const calls = (...requests: ToolRequest[]): ModelResponse => ({ message: { role: 'assistant', content: null, tool_calls: requests }, finishReason: 'tool_calls', usage: { input: 60, output: 20 } });
export const call = (name: string, args: unknown, id = name): ToolRequest => ({ id, name, arguments: JSON.stringify(args) });
export function scripted(...responses: (ModelResponse | ((request: Parameters<Provider['complete']>[0], signal: AbortSignal) => Promise<ModelResponse>))[]): Provider {
  return { async complete(request, signal) {
    const next = responses.shift();
    if (!next) throw new Error('unexpected model request');
    return typeof next === 'function' ? await next(request, signal) : next;
  } };
}
export function fixture(provider: Provider = scripted(answer()), permissions: Permission[] = ['read', 'write'], options: ApplicationOptions = {}): { app: Application; root: string; runId: string } {
  const root = temp();
  // Scripted runtime fixtures exercise explicit legacy tool access; role and scheduling tests opt in.
  const app = new Application(path.join(root, '.state'), provider, undefined, { taskProtocol: 1, toolProfile: 'full', ...options, agentFactors: { B: false, D: false, E: false, ...options.agentFactors } });
  cleanup.push(() => app.shutdown());
  const run = app.createRun({ objective: 'Inspect the project and provide evidence.', workspace: root, binding, permissions });
  return { app, root, runId: run.id };
}
