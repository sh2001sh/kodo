import { Application } from '../../dist/application/index.js';
import path from 'node:path';
import process from 'node:process';
import { setInterval } from 'node:timers';

const root = process.argv[2];
const provider = {
  async complete() {
    return {
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'write-before-crash', name: 'file.apply_patch', arguments: JSON.stringify({ path: 'external-effect.txt', expectedHash: null, content: 'written once' }) }] },
      finishReason: 'tool_calls', usage: { input: 10, output: 10 },
    };
  },
};
const app = new Application(path.join(root, 'state'), provider);
const run = app.createRun({ objective: 'controlled crash experiment', workspace: root, permissions: ['read', 'write'], binding: { model: 'local-fixture', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_TEST_KEY', limits: { context: 256000, output: 8192 } } });
await app.coordinator.tools.execute(run.id, 'todo.write', { expectedRevision: 0, items: [{ id: 'write', content: 'Write the controlled evidence file once and verify its outcome', status: 'in_progress' }] }, new globalThis.AbortController().signal);
const original = app.coordinator.tools.execute.bind(app.coordinator.tools);
app.coordinator.tools.execute = async (...args) => {
  const uncommitted = { ...args[5] };
  delete uncommitted.settle;
  const result = await original(...args.slice(0, 5), uncommitted);
  // Test-only failure barrier: file changed, but the runtime has not saved the tool result.
  process.stdout.write(JSON.stringify({ runId: run.id, effectApplied: true }) + '\n');
  await new Promise(() => { setInterval(() => {}, 1000); });
  return result;
};
await app.coordinator.wake(run.id);
