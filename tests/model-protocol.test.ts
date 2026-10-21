import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import type { ModelProtocol } from '../src/runtime/types.js';
import { mockServer, delta, sendStream } from './http-server.js';
import { temp } from './helpers.js';

afterEach(() => { delete process.env.KODO_ROUTER_TEST_KEY; });

it.each(['chat-completions', 'responses', 'anthropic'] as const)('routes built CLI %s bindings and persists the protocol', async protocol => {
  let requests = 0;
  const baseURL = await mockServer((body, response, request) => {
    requests++;
    expect(body.model).toBe('router-fixture');
    expect(request.url).toBe(`/v1/${protocol === 'chat-completions' ? 'chat/completions' : protocol === 'responses' ? 'responses' : 'messages'}`);
    if (protocol === 'chat-completions') sendStream(response, [delta({ content: 'protocol-verified' }), delta({}, 'stop')]);
    else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = protocol === 'responses' ? [{ type: 'response.completed', response: { id: 'response-1', status: 'completed', output: [{ id: 'message-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'protocol-verified' }] }], usage: { input_tokens: 10, output_tokens: 3 } } }] : [
        { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'protocol-verified' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    }
  });
  const workspace = temp();
  const data = path.join(workspace, 'state');
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli/index.js', 'run', 'Reply with protocol-verified.', '--json', '--workspace', workspace, '--data-dir', data, '--base-url', baseURL, '--model', 'router-fixture', '--max-context-tokens', '256000', '--max-output-tokens', '8192', ...(protocol === 'anthropic' ? [] : ['--protocol', protocol])], {
      windowsHide: true, env: { ...process.env, KODO_API_KEY: 'router-local-fixture', KODO_PROTOCOL: protocol === 'anthropic' ? protocol : '', OPENAI_API_KEY: '' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  expect(result.code, result.stderr || result.stdout).toBe(0);
  expect(requests).toBe(1);
  const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as { type: string; data: { result?: { text: string } } });
  expect(events.find(event => event.type === 'run.completed')?.data.result?.text).toBe('protocol-verified');
  const app = new Application(data);
  try { expect(app.store.listRuns()[0]?.binding.protocol).toBe(protocol); } finally { app.close(); }
});

it('rejects unknown protocols before recording a run or sending requests', () => {
  const workspace = temp();
  const app = new Application(path.join(workspace, 'state'));
  try {
    expect(() => app.createRun({ objective: 'test', workspace, binding: { model: 'test', baseURL: 'https://example.com/v1', apiKeyEnv: 'UNUSED', protocol: 'typo' as ModelProtocol } })).toThrow('protocol must be');
    expect(app.store.listRuns()).toHaveLength(0);
  } finally { app.close(); }
});
