import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { Application, PackageRegistry, exportPackage, inspectPackage, verifyToolExamples } from '../dist/application/index.js';

const { values } = parseArgs({ options: { 'archive-only': { type: 'boolean', default: false } } });
const source = fileURLToPath(new URL('../examples/capability-package/', import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-package-demo-'));
const workspace = path.join(root, 'workspace');
await mkdir(workspace);
const declaration = JSON.parse(await readFile(path.join(source, 'declaration.json'), 'utf8'));
const scope = { read: [], write: [] };
let app;
try {
  const archive = path.join(root, 'text-statistics.zip');
  const exported = await exportPackage(source, declaration, archive);
  assert.deepEqual(await inspectPackage(archive), exported);
  const sender = new PackageRegistry(path.join(root, 'sender-registry'));
  const receiver = new PackageRegistry(path.join(root, 'receiver-registry'));
  const installedSender = await sender.import(archive);
  const relayed = path.join(root, 'relayed.zip');
  await sender.export(installedSender.card.id, installedSender.card.version, relayed);
  const installed = await receiver.import(relayed);
  assert.equal(installed.digest, exported.digest);
  assert.equal(installed.card.digest, exported.card.digest);
  assert.notEqual(installed.root, installedSender.root);
  assert.equal((await receiver.list()).length, 1);
  assert.equal((await receiver.diagnose(installed.card.id, installed.card.version)).status, 'imported');
  console.log(`PASS archive: explicit files -> ZIP -> sender registry -> ZIP -> independent receiver; SHA-256 ${installed.digest}`);
  if (values['archive-only']) {
    console.log('PASS archive-only mode; no package tools, dependency installers, MCP servers or models were started');
  } else {
    const text = '你好 world 👋\r\n';
    const expected = { codePoints: 12, utf8Bytes: 19, whitespaceWords: 3, lines: 2 };
    let step = 0;
    const provider = { async complete(request, signal) {
      signal.throwIfAborted();
      const next = step++;
      const tool = (name, args) => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: `package-demo-${next}`, name, arguments: JSON.stringify(args) }] }, finishReason: 'tool_calls', usage: { input: 100, output: 20 } });
      if (next === 0) return tool('skill.load', { id: 'example/text-statistics' });
      if (next === 1) return tool('text.stats', { text: 42 });
      if (next === 2) {
        const last = request.messages.filter(message => message.role === 'tool').at(-1);
        assert(last && JSON.parse(last.content).error, 'invalid input must fail at the actual tool boundary');
        return tool('text.stats', { text });
      }
      const last = request.messages.filter(message => message.role === 'tool').at(-1);
      assert(last, 'the model must receive actual tool evidence');
      assert.deepEqual(JSON.parse(last.content), expected);
      return { message: { role: 'assistant', content: `Verified: ${JSON.stringify(expected)}` }, finishReason: 'stop', usage: { input: 100, output: 20 } };
    } };
    app = new Application(path.join(root, 'runtime-data'), provider);
    const card = await receiver.activate(app, installed.card.id, installed.card.version, {
      workspace, scope, verifyExamples: verifyToolExamples({ workspace, scope, permissions: ['read'] }),
    });
    assert.equal((await receiver.diagnose(card.id, card.version)).status, 'ready');
    const pointer = await receiver.adopt(card.id, card.version);
    assert.equal(pointer.digest, installed.digest);
    console.log('PASS activation: all three examples passed through native OS-sandboxed workers; local adoption recorded');
    const run = app.createRun({
      objective: `统计原始文本 ${JSON.stringify(text)}。先加载统计口径，然后使用 text.stats；演示时先提交一次无效输入以验证失败路径。`,
      workspace, scope, permissions: ['read'], card,
      binding: { model: 'capability-package-scripted', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'UNUSED_DEMO_KEY', limits: { context: 256000, output: 8192 } },
    });
    app.setCompletionValidator(run.id, () => {
      const calls = app.store.calls(run.id);
      const success = calls.find(call => call.name === 'text.stats' && call.status === 'succeeded');
      const failed = calls.find(call => call.name === 'text.stats' && call.status === 'failed');
      assert(success && failed, 'both rejected arguments and successful worker execution must be persisted');
      assert.deepEqual(app.store.readBlob(success.resultRef), expected);
      return { passed: true, evidence: { successCallId: success.id, rejectedCallId: failed.id, packageDigest: installed.digest } };
    });
    const result = await app.run(run.id);
    assert.equal(result.status, 'completed', result.error);
    const final = app.store.readBlob(result.resultRef);
    assert.equal(final.quality.status, 'passed');
    await writeFile(path.join(root, 'evidence.json'), `${JSON.stringify({ packageDigest: installed.digest, runId: run.id, final, calls: app.store.calls(run.id).map(call => ({ name: call.name, status: call.status, resultRef: call.resultRef })) }, null, 2)}\n`, 'utf8');
    console.log('PASS runtime: on-demand Skill, rejected invalid arguments, isolated tool result, persisted host validation');
    console.log(`PASS capability-package demo; evidence: ${path.join(root, 'evidence.json')}`);
  }
} catch (error) {
  console.error(`FAIL capability-package demo: ${error.message}`);
  process.exitCode = 1;
} finally {
  await app?.shutdown();
  console.log(`Artifacts preserved: ${root}`);
}
