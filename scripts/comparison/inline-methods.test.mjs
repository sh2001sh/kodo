import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess, cells, main, task } from './inline-methods.mjs';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

test('comparison freezes opportunity count and rotates run order', () => {
  assert.equal(task.opportunities.length, 2);
  assert.deepEqual(cells(2).map(cell => cell.arm), ['resident', 'skill', 'implicit', 'skill', 'implicit', 'resident']);
  assert.throws(() => cells(0));
});
test('acceptance checks both procurement eligibility and budget arithmetic', () => {
  const correct = { supplier: 'Birch', purchaseTotal: 1940, contingency: 97, budgetTotal: 2037, withinBudget: true, evidence: 'quotes.json; Oak is late' };
  assert.equal(assess(JSON.stringify(correct)).passed, true);
  assert.equal(assess(JSON.stringify({ ...correct, supplier: 'Oak' })).passed, false);
  assert.equal(assess(JSON.stringify({ ...correct, contingency: 0, budgetTotal: 1940 })).passed, false);
  assert.equal(assess('Finished the work.').passed, false);
});

test('three-arm runner uses isolated synthetic responses and does not count host lifecycle as adoption', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kodo-inline-scripted-'));
  const previous = process.env.KODO_HOME;
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ id: 'isolated-synthetic-response', object: 'chat.completion.chunk', model: 'gpt-4.1', choices: [{ index: 0, finish_reason: 'stop', delta: { role: 'assistant', content: JSON.stringify({ supplier: 'Birch', purchaseTotal: 1940, contingency: 97, budgetTotal: 2037, withinBudget: true, evidence: 'quotes.json' }) } }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.KODO_HOME = root;
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ defaultProvider: 'scripted', providers: { scripted: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'gpt-4.1', protocol: 'chat-completions', apiKey: 'isolated-synthetic-test-key' } } }), 'utf8');
    const output = path.join(root, 'output');
    await main(['--run', '--output', output]);
    const { results } = JSON.parse(readFileSync(path.join(output, 'results.json'), 'utf8'));
    assert.equal(results.length, 3);
    assert.deepEqual(results.map(result => result.status), ['completed', 'completed', 'completed'], JSON.stringify(results.map(result => result.error)));
    assert.equal(requests.length, 3);
    const added = new Set(['knowledge_publish', 'knowledge_browse', 'knowledge_search', 'knowledge_read', 'task']);
    assert.deepEqual(requests[1].tools, requests[2].tools.filter(tool => !added.has(tool.function.name)));
    assert.equal(requests[2].tools.some(tool => tool.function.name === 'task'), true);
    assert.equal(results.every(result => result.evaluation.passed), true);
    assert.deepEqual(results[1].adoption, { numerator: 0, denominator: 2 });
    assert.deepEqual(results[2].adoption, { numerator: 0, denominator: 2 });
    assert.equal(results[2].usage.billedCost, null);
    assert.equal(results[2].lifecycle.length, 0);
  } finally {
    if (previous === undefined) delete process.env.KODO_HOME; else process.env.KODO_HOME = previous;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
