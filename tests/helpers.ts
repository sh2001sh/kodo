import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach } from 'vitest';
import { Application } from '../src/application/index.js';
import type { ModelResponse, Permission, Provider, ToolRequest } from '../src/runtime/types.js';

export const binding = { model: 'test-model', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_TEST_KEY', limits: { context: 256_000, output: 8192 } };
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
export function temp(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'kodo-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
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
export function fixture(provider: Provider = scripted(answer()), permissions: Permission[] = ['read', 'write']): { app: Application; root: string; runId: string } {
  const root = temp();
  const app = new Application(path.join(root, '.state'), provider);
  cleanup.push(() => app.close());
  const run = app.createRun({ objective: 'Inspect the project and provide evidence.', workspace: root, binding, permissions });
  return { app, root, runId: run.id };
}
