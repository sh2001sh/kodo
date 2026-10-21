import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Application, parseCard } from '../../dist/application/index.js';
import { runPiCore } from './pi-core.mjs';

test('Pi preserves private Chat thinking across a real tool round without exposing it in final text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-pi-thinking-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace);
  const app = new Application(path.join(directory, 'data'));
  const card = parseCard('---\nschema_version: 1\nid: test/pi-thinking\nversion: 1.0.0\nname: Test\ndescription: Test replay\ncapabilities:\n  tools: [file.list]\n---\nInspect files.\n');
  const run = app.createRun({ objective: 'Inspect workspace then finish', workspace, card, binding: { model: 'fixture', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'UNUSED_FIXTURE', limits: { context: 1_000_000, output: 8192 } } });
  app.coordinator.mailbox.specs = () => [];
  let calls = 0;
  try {
    const result = await runPiCore({ app, run, maxContextChars: Number.MAX_SAFE_INTEGER, contextWindowTokens: 1000000,
      requestComplete: async messages => {
        if (++calls === 1) return { finishReason: 'tool_calls', message: { role: 'assistant', content: null, providerData: { protocol: 'chat-completions', reasoningContent: 'private fixture reasoning' }, tool_calls: [{ id: 'inspect', name: 'file.list', arguments: '{"path":"."}' }] } };
        assert.equal(messages.findLast(message => message.role === 'assistant').providerData.reasoningContent, 'private fixture reasoning');
        assert.equal(messages.at(-1).role, 'tool');
        return { finishReason: 'stop', message: { role: 'assistant', content: 'done' } };
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'done');
    assert.equal(result.stats.toolCalls, 1);
  } finally { await app.shutdown(); await rm(directory, { recursive: true, force: true }); }
});
