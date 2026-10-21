import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { parseArgs } from 'node:util';
import { Application, ModelProvider, parseCard } from '../dist/application/index.js';

const { values } = parseArgs({ options: { protocol: { type: 'string' } } });
const protocols = ['chat-completions', 'responses', 'anthropic'].filter(name => !values.protocol || name === values.protocol);
if (!protocols.length) throw new Error('protocol must be chat-completions, responses or anthropic');
if (!process.env.KODO_MODEL || !process.env.KODO_BASE_URL || !(process.env.KODO_API_KEY || process.env.OPENAI_API_KEY)) throw new Error('NOT VERIFIED: configure KODO_MODEL, KODO_BASE_URL and KODO_API_KEY (or OPENAI_API_KEY); no scripted fallback.');
const output = path.resolve('.kodo', `protocol-verification-${Date.now()}-${randomUUID().slice(0, 8)}`);
await mkdir(output, { recursive: true });
const rows = [];
for (const protocol of protocols) {
  const directory = path.join(output, protocol);
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const identifier = `kodo-api-${randomUUID()}`;
  await writeFile(path.join(workspace, 'input.txt'), `Release candidate: ${identifier}\n`, 'utf8');
  const binding = { protocol, model: process.env.KODO_MODEL, baseURL: process.env.KODO_BASE_URL, apiKeyEnv: process.env.KODO_API_KEY ? 'KODO_API_KEY' : 'OPENAI_API_KEY' };
  const card = parseCard(`---\nschema_version: 1\nid: verification/${protocol}\nversion: 1.0.0\nname: Protocol verification\ndescription: Verify real tool result round trips.\ncapabilities:\n  tools: [file.read, artifact.write, artifact.read]\n---\nComplete the task using actual tool results. Never guess file content. Keep output concise. Do not delegate or ask questions.\n`);
  const app = new Application(path.join(directory, 'state'));
  const started = Date.now();
  let row;
  try {
    const run = app.createRun({ workspace, binding, card, permissions: ['read', 'write'],
      objective: 'Read input.txt using file.read. Save an artifact containing the exact release candidate identifier from the file. Read that saved artifact with artifact.read, then report its identifier. All three tool operations must succeed before finishing. Do not delegate or ask the user.',
      budget: { maxTokens: 160_000, maxModelCalls: 10, maxOutputTokens: 4096, maxContextChars: 64_000, maxConcurrentModels: 1, maxDurationMs: 180_000 },
    });
    console.log(JSON.stringify({ type: 'verification.started', protocol, runId: run.id }));
    const final = await app.run(run.id);
    const calls = app.store.calls(run.id);
    const success = calls.filter(call => call.kind === 'tool' && call.status === 'succeeded');
    const names = success.map(call => call.name);
    const finalText = final.resultRef ? app.store.readBlob(final.resultRef).text : '';
    const written = success.find(call => call.name === 'artifact.write');
    const artifactId = written ? app.store.readBlob(written.resultRef).id : undefined;
    const artifact = artifactId ? app.store.readArtifact(run.id, artifactId) : undefined;
    const read = success.find(call => call.name === 'artifact.read' && JSON.parse(app.store.readBlob(call.requestRef).arguments).id === artifactId);
    const toolEvidence = final.status === 'completed' && ['file.read', 'artifact.write', 'artifact.read'].every(name => names.includes(name)) && finalText.includes(identifier) && artifact?.content.includes(identifier) && Boolean(read);
    // A deliberately invalid fixture credential checks the remote rejection path, without tools.
    let authenticationError;
    try {
      process.env.KODO_PROTOCOL_NEGATIVE_KEY = 'kodo-invalid-credential-fixture';
      await new ModelProvider().complete({ binding: { ...binding, apiKeyEnv: 'KODO_PROTOCOL_NEGATIVE_KEY' }, messages: [{ role: 'user', content: 'Protocol negative control.' }], tools: [], maxOutputTokens: 16 }, globalThis.AbortSignal.timeout(30_000), () => {});
    } catch (error) { authenticationError = error.code; }
    finally { delete process.env.KODO_PROTOCOL_NEGATIVE_KEY; }
    const rejectedInvalidCredential = authenticationError === 'MODEL_AUTH';
    row = { protocol, model: binding.model, baseURL: binding.baseURL, passed: Boolean(toolEvidence && rejectedInvalidCredential), runStatus: final.status, error: final.error, checks: { toolEvidence: Boolean(toolEvidence), rejectedInvalidCredential }, authenticationError, elapsedMs: Date.now() - started, identifier, finalText, artifact, snapshot: app.snapshot(run.id), calls };
  } catch (error) { row = { protocol, passed: false, error: error.code ?? 'VERIFICATION_ERROR', elapsedMs: Date.now() - started }; }
  finally { await app.shutdown(); }
  const file = path.join(directory, 'result.json');
  await writeFile(file, JSON.stringify(row, null, 2), 'utf8');
  rows.push({ protocol, passed: row.passed, checks: row.checks, runStatus: row.runStatus, error: row.error, elapsedMs: row.elapsedMs, resultFile: file });
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ model: binding.model, baseURL: binding.baseURL, rows }, null, 2), 'utf8');
  console.log(JSON.stringify({ type: 'verification.assessed', ...rows.at(-1) }));
}
console.log(`${rows.filter(row => row.passed).length}/${rows.length} real protocol checks passed; evidence: ${path.join(output, 'results.json')}`);
if (rows.some(row => !row.passed)) process.exitCode = 1;
