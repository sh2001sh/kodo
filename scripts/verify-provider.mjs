import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { Application } from '../dist/application/index.js';

if (!process.env.KODO_MODEL || !(process.env.KODO_API_KEY || process.env.OPENAI_API_KEY)) {
  console.error('NOT VERIFIED: set KODO_MODEL and KODO_API_KEY (or OPENAI_API_KEY) for the real-provider check.');
  process.exitCode = 2;
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-provider-'));
  let app;
  try {
    await writeFile(path.join(root, 'input.txt'), 'Release candidate: kodo-probe-7421.\n', 'utf8');
    app = new Application(path.join(root, 'data'));
    const run = app.createRun({ workspace: root,
      objective: 'Complete this small protocol check yourself, without delegating or asking the user. Read input.txt using file.read. Save an artifact containing its exact release candidate identifier. Then read that artifact using artifact.read and report the identifier. All three tool operations must succeed before finishing. Do not guess file contents.',
      binding: { model: process.env.KODO_MODEL, apiKeyEnv: process.env.KODO_API_KEY ? 'KODO_API_KEY' : 'OPENAI_API_KEY', baseURL: process.env.KODO_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', protocol: process.env.KODO_PROTOCOL ?? 'chat-completions' },
      permissions: ['read', 'write'], budget: { maxModelCalls: 6, maxTokens: 64_000, maxOutputTokens: 768 },
    });
    const result = await app.run(run.id);
    const successful = app.store.calls(run.id).filter(x => x.kind === 'tool' && x.status === 'succeeded');
    const names = successful.map(x => x.name);
    const text = result.resultRef ? app.store.readBlob(result.resultRef).text : '';
    const written = successful.find(x => x.name === 'artifact.write');
    const artifactId = written ? app.store.readBlob(written.resultRef).id : undefined;
    const artifact = artifactId ? app.store.readArtifact(run.id, artifactId) : undefined;
    if (result.status !== 'completed' || !['file.read', 'artifact.write', 'artifact.read'].every(x => names.includes(x)) || !text.includes('kodo-probe-7421') || !artifact?.content.includes('kodo-probe-7421')) throw new Error(`real-provider tool/evidence acceptance failed: ${JSON.stringify({ status: result.status, error: result.error, successfulTools: names })}`);
    console.log('PASS real provider: file read, artifact write/read, and final evidence verified');
    console.log(JSON.stringify({ model: run.binding.model, usage: app.store.session(run.sessionId).tokens, estimated: app.store.session(run.sessionId).usageEstimated }));
    const truncated = app.createRun({ workspace: root, objective: 'Read input.txt using file.read and provide the full release candidate identifier with evidence.', binding: run.binding, permissions: ['read', 'write'], budget: { maxModelCalls: 1, maxOutputTokens: 1 } });
    const failed = await app.coordinator.wake(truncated.id);
    if (failed.status !== 'failed' || !failed.error?.includes('MODEL_INCOMPLETE') || app.store.calls(truncated.id).some(x => x.kind === 'tool')) throw new Error('real-provider truncation acceptance failed');
    console.log('PASS real provider: truncated response rejected without executing any tool');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await app?.shutdown(); await rm(root, { recursive: true, force: true }); }
}
