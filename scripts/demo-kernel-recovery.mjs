import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { parseArgs } from 'node:util';
import { Application, parseCard } from '../dist/application/index.js';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, workspace: { type: 'string' } } });
const root = path.resolve('.kodo', `kernel-recovery-demo-${Date.now()}-${randomUUID().slice(0, 8)}`);
const dataDir = path.resolve(values['data-dir'] ?? path.join(root, 'data'));
const workspace = path.resolve(values.workspace ?? path.join(root, 'workspace'));
const binding = { model: 'kernel-recovery-scripted', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_TEST_KEY', limits: { context: 256000, output: 8192 } };
const proof = `original-evidence-${randomUUID()}`;
const evidence = { mode: 'scripted', workspace, dataDir };
let app;
let stage = 'setup';
let callId = 0;
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const call = (name, args) => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: `demo-recovery-${++callId}`, name, arguments: JSON.stringify(args) }] }, finishReason: 'tool_calls', usage: { input: 100, output: 20 } });
const answer = content => ({ message: { role: 'assistant', content }, finishReason: 'stop', usage: { input: 100, output: 20 } });
const snapshot = id => ({ ...app.snapshot(id), calls: app.store.calls(id) });

// This provider sees only its supplied context. The random proof is discovered from
// history.read results after its original file.read round has been compacted.
function contextProvider() {
  let step = 0;
  let readingOriginal = false;
  return { async complete(request, signal) {
    signal.throwIfAborted();
    if (step < 9) return call('file.read', { path: `context-${step++}.txt` });
    const result = request.messages.findLast(message => message.role === 'tool');
    if (readingOriginal) {
      const original = JSON.parse(result.content);
      const identifier = JSON.stringify(original.messages).match(/original-evidence-[a-f0-9-]{36}/)?.[0];
      expect(identifier, 'verbatim history did not return the original random identifier');
      return answer(`Recovered original evidence from durable history: ${identifier}`);
    }
    const page = result && JSON.parse(result.content);
    if (page?.ref && Array.isArray(page.messages)) {
      if (page.previousRef) return call('history.read', { ref: page.previousRef, offset: 0, limit: 1 });
      readingOriginal = true;
      return call('history.read', { ref: page.ref, offset: 5, limit: 1 });
    }
    const marker = request.messages.find(message => message.role === 'user' && message.content.startsWith('Context archive ('));
    expect(marker, 'long context was not compacted');
    const archive = JSON.parse(marker.content.slice(marker.content.indexOf(': ') + 2));
    expect(!JSON.stringify(request.messages).includes('original-evidence-'), 'the original evidence was still live instead of retrieved from history');
    return call('history.read', { ref: archive.ref, offset: 0, limit: 1 });
  } };
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  stage = 'context compaction and original history';
  for (let index = 0; index < 9; index++) await writeFile(path.join(workspace, `context-${index}.txt`), index === 0 ? `Original identifier: ${proof}\n${'original evidence '.repeat(130)}` : `Later evidence ${index}: ${'bounded supporting detail '.repeat(100)}`, 'utf8');
  const card = parseCard(`---
schema_version: 1
id: demo/context-history
version: 0.1.0
name: Context history demonstration
description: Read bounded evidence and retrieve original history.
capabilities:
  tools: [file.read, history.read]
---
Read the evidence files, then retrieve the original identifier through history.read after compaction.
`);
  app = new Application(dataDir, contextProvider());
  const contextRun = app.createRun({ objective: 'Read nine evidence files and retrieve the original evidence from compacted history.', workspace, binding, card, budget: { maxTokens: 300_000, maxContextChars: 16_000, maxModelCalls: 30 } });
  const contextResult = await app.run(contextRun.id);
  expect(contextResult.status === 'completed', `context demonstration failed: ${contextResult.status}:${contextResult.error ?? ''}`);
  const compactions = app.store.events(contextRun.id).filter(event => event.type === 'context.compacted');
  expect(compactions.length > 0 && compactions.every(event => event.data.omittedMessages > 0), 'no inspectable compaction event');
  expect(app.store.calls(contextRun.id).some(item => item.name === 'history.read' && item.status === 'succeeded'), 'history.read was not executed');
  expect(app.store.readBlob(contextResult.resultRef).text.includes(proof), 'final result did not recover exact original identifier');
  evidence.context = snapshot(contextRun.id);
  console.log('PASS context: bounded compaction, protocol-complete rounds, and verbatim original history retrieval');
  await app.shutdown(); app = undefined;

  stage = 'uncertain external write and verified continuation';
  let modelCalls = 0;
  app = new Application(dataDir, { async complete(request) {
    if (modelCalls++ === 0) return call('process.exec', { program: process.execPath, args: ['-e', "require('node:fs').appendFileSync('external-effect.txt','once\\n')"] });
    expect(JSON.stringify(request.messages).includes('Verified external-effect.txt'), 'continuation did not receive verified recovery evidence');
    return answer('External effect verified; completed without replay.');
  } });
  const external = app.createRun({ objective: 'Apply one external effect and report.', workspace, binding, permissions: ['read', 'exec'], budget: { maxTokens: 200_000 } });
  const execute = app.coordinator.tools.execute.bind(app.coordinator.tools);
  app.coordinator.tools.execute = async (...args) => { const result = await execute(...args); if (args[1] === 'process.exec') throw new Error('demo fault injection: effect occurred but result recording failed'); return result; };
  const failed = await app.run(external.id);
  expect(failed.status === 'failed' && failed.error.startsWith('UNKNOWN_WRITE:'), 'unknown effect did not block execution');
  const originalRun = JSON.stringify(app.store.run(external.id));
  const originalCalls = JSON.stringify(app.store.calls(external.id));
  const unknown = app.store.calls(external.id).find(item => item.status === 'unknown');
  expect(unknown, 'unknown call record is missing');
  const blocked = await app.reconcile(external.id);
  expect(blocked.blocked.includes(unknown.id), 'external process effect was guessed instead of blocked');
  let refused = false;
  try { await app.recover(external.id); } catch (error) { refused = error.code === 'UNKNOWN_WRITE'; }
  expect(refused, 'unverified effect was resumed');
  const observed = await readFile(path.join(workspace, 'external-effect.txt'), 'utf8');
  expect(observed === 'once\n', 'external effect differs from expected one-time write');
  const resolution = app.resolveCall(external.id, unknown.id, { outcome: 'succeeded', evidence: 'Verified external-effect.txt with an independent filesystem read; it contains exactly one once line.' });
  const continued = await app.recover(external.id);
  expect(continued.status === 'completed' && continued.continuationOf === external.id && continued.id !== external.id, 'failed source did not produce a recovery continuation');
  expect(JSON.stringify(app.store.run(external.id)) === originalRun && JSON.stringify(app.store.calls(external.id)) === originalCalls, 'original terminal execution records were mutated');
  expect(await readFile(path.join(workspace, 'external-effect.txt'), 'utf8') === 'once\n', 'uncertain external effect was replayed');
  evidence.external = { blocked, resolution, original: snapshot(external.id), continuation: snapshot(continued.id) };
  console.log('PASS recovery: unknown external effect blocked, independent evidence recorded, continuation resumed, original terminal immutable, no replay');
  await app.shutdown(); app = undefined;

  stage = 'automatic file hash reconciliation';
  let patchModels = 0;
  let patchExecutions = 0;
  app = new Application(dataDir, { async complete() { return patchModels++ === 0 ? call('file.apply_patch', { path: 'patch-effect.txt', expectedHash: null, content: 'verified patch effect' }) : answer('Patch hash verified; completed without replay.'); } });
  const patch = app.createRun({ objective: 'Create one patch and report.', workspace, binding, permissions: ['read', 'write'], budget: { maxTokens: 200_000 } });
  const patchExecute = app.coordinator.tools.execute.bind(app.coordinator.tools);
  app.coordinator.tools.execute = async (...args) => { const result = await patchExecute(...args); if (args[1] === 'file.apply_patch') { patchExecutions++; throw new Error('demo fault injection after atomic patch'); } return result; };
  const patchFailed = await app.run(patch.id);
  expect(patchFailed.status === 'failed' && patchFailed.error.startsWith('UNKNOWN_WRITE:'), 'patch fault did not yield an unknown effect');
  const patchOriginal = JSON.stringify(app.store.run(patch.id));
  const reconciled = await app.reconcile(patch.id);
  expect(reconciled.blocked.length === 0 && reconciled.resolutions.some(item => item.source === 'probe' && item.outcome === 'succeeded' && item.evidence.includes('SHA-256')), 'file patch was not verified by hash');
  const patchContinued = await app.recover(patch.id);
  expect(patchContinued.status === 'completed' && patchExecutions === 1, 'verified file patch was replayed');
  expect(JSON.stringify(app.store.run(patch.id)) === patchOriginal, 'original failed patch run was reopened');
  evidence.patch = { reconciled, original: snapshot(patch.id), continuation: snapshot(patchContinued.id) };
  console.log('PASS file recovery: observed before/after SHA-256, automatic reconciliation, and no patch replay');
  await writeFile(path.join(dataDir, 'recovery-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`PASS kernel recovery demo (scripted); evidence: ${path.join(dataDir, 'recovery-evidence.json')}`);
} catch (error) {
  console.error(`FAIL kernel recovery demo at ${stage}: ${error.message}`);
  process.exitCode = 1;
  try { await writeFile(path.join(dataDir, 'recovery-evidence.json'), JSON.stringify({ ...evidence, failedStage: stage, error: error.message }, null, 2), 'utf8'); }
  catch (saveError) { console.error(`Could not preserve recovery evidence: ${saveError.message}`); }
} finally { await app?.shutdown(); }
