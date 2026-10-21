import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { Application } from '../src/application/index.js';
import { delta, mockServer, sendStream } from './http-server.js';
import { call, calls, scripted, temp } from './helpers.js';

const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
function fixtureLimits(args: string[]): string[] {
  return [...(args.includes('--max-context-tokens') ? [] : ['--max-context-tokens', '256000']), ...(args.includes('--max-output-tokens') ? [] : ['--max-output-tokens', '8192'])];
}
function chat(args: string[], env: Record<string, string> = {}) {
  args = [...args, ...fixtureLimits(args)];
  const child = spawn(process.execPath, [entry, 'chat', ...args], { env: { ...process.env, KODO_API_KEY: 'fixture', OPENAI_API_KEY: '', ...env }, windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', chunk => { out += String(chunk); });
  child.stderr.on('data', chunk => { err += String(chunk); });
  const result = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
  afterEach(() => { if (child.exitCode === null) child.kill(); });
  return { child, result, async waitFor(text: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!(out + err).includes(text)) {
      if (Date.now() >= deadline || child.exitCode !== null) throw new Error(`missing ${text}; stdout=${out}; stderr=${err}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  } };
}
async function cli(args: string[], env: Record<string, string> = {}, declareFixture = true): Promise<{ code: number | null; out: string; err: string }> {
  if (declareFixture && ['run', 'chat'].includes(args[0]!)) args = [...args, ...fixtureLimits(args)];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, KODO_API_KEY: '', OPENAI_API_KEY: '', KODO_MODEL: '', ...env }, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.stderr.on('data', chunk => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
}
describe('built CLI end to end', () => {
  it('uses catalog capabilities for a known model on a relay without budget options', async () => {
    const root = temp();
    let requests = 0;
    const url = await mockServer((body, response, request) => {
      if (request.method === 'GET') { response.writeHead(404).end(); return; }
      requests++;
      expect(body.max_completion_tokens).toBe(131_072);
      sendStream(response, [delta({ content: 'done' }), delta({}, 'stop')]);
    });
    const result = await cli(['run', 'task', '--json', '--data-dir', root, '--workspace', root, '--model', 'glm-5.3', '--base-url', url, '--input-price', '2', '--output-price', '8'], { KODO_API_KEY: 'fixture' }, false);
    expect(result.code, result.err).toBe(0);
    const info = JSON.parse(result.out.trim().split(/\r?\n/)[0]!);
    expect(info).toMatchObject({ type: 'budget.info', data: { limits: { maxContextTokens: 1_000_000, maxOutputTokens: 131_072, maxTokens: null, maxModelCalls: null, maxToolCalls: null, maxDurationMs: null, maxContextChars: null }, modelLimits: { source: 'model-name', warning: expect.stringContaining('relay') }, costUpperBoundUSD: null } });
    expect(requests).toBe(1);
  });

  it('allows unknown models with provisional limits when metadata is unavailable', async () => {
    const root = temp();
    let requests = 0;
    const url = await mockServer((_body, response, request) => {
      if (request.method === 'GET') { response.writeHead(404).end(); return; }
      requests++;
      sendStream(response, [delta({ content: 'done' }), delta({}, 'stop')]);
    });
    const args = ['run', 'task', '--json', '--data-dir', root, '--workspace', root, '--model', 'private-alias', '--base-url', url];
    for (const flags of [[], ['--max-context-tokens', '64000']]) {
      const provisional = await cli([...args, ...flags], { KODO_API_KEY: 'fixture' }, false);
      expect(provisional.code, provisional.err).toBe(0);
      expect(JSON.parse(provisional.out.trim().split(/\r?\n/)[0]!)).toMatchObject({ data: { modelLimits: { source: 'fallback', warning: expect.stringContaining('not verified') } } });
    }
    expect(requests).toBe(2);
    const declared = await cli([...args, '--max-context-tokens', '64000', '--max-output-tokens', '12000'], { KODO_API_KEY: 'fixture' }, false);
    expect(declared.code, declared.err).toBe(0);
    expect(JSON.parse(declared.out.trim().split(/\r?\n/)[0]!)).toMatchObject({ data: { modelLimits: { source: 'explicit', context: 64000, output: 12000 } } });
    expect(requests).toBe(3);
    const preset = await cli([...args, '--budget', 'long'], { KODO_API_KEY: 'fixture' }, false);
    expect(preset.code).toBe(1);
    expect(preset.err).toContain('ARGUMENTS');
  }, 15_000);

  it('discovers and persists an unknown relay model window without manual limits', async () => {
    const root = temp();
    let reads = 0;
    let completions = 0;
    const url = await mockServer((body, response, request) => {
      if (request.method === 'GET') {
        reads++;
        expect(request.url).toBe('/v1/models');
        expect(request.headers.authorization).toBe('Bearer fixture');
        response.end(JSON.stringify({ data: [{ id: 'relay-private-model', context_length: 32000, max_output_length: 6000 }] }));
      } else {
        completions++;
        expect(body.max_completion_tokens).toBe(6000);
        sendStream(response, [delta({ content: 'done' }), delta({}, 'stop')]);
      }
    });
    const result = await cli(['run', 'task', '--json', '--data-dir', root, '--workspace', root, '--model', 'relay-private-model', '--base-url', url], { KODO_API_KEY: 'fixture' }, false);
    expect(result.code, result.err).toBe(0);
    const info = JSON.parse(result.out.trim().split(/\r?\n/)[0]!);
    expect(info).toMatchObject({ type: 'budget.info', data: { modelLimits: { source: 'api', context: 32000, output: 6000 }, limits: { maxContextTokens: 32000, maxOutputTokens: 6000 } } });
    const inspected = await cli(['inspect', info.runId, '--json', '--data-dir', root]);
    expect(JSON.parse(inspected.out)).toMatchObject({ session: { modelLimits: { source: 'api', context: 32000, output: 6000 } } });
    expect({ reads, completions }).toEqual({ reads: 1, completions: 1 });
  });

  it('prints budget projections, discovers runs, and exposes maintenance without credentials', async () => {
    const root = temp();
    const url = await mockServer((_body, response) => sendStream(response, [delta({ content: 'done' }), delta({}, 'stop')]));
    const result = await cli(['run', 'task', '--json', '--data-dir', root, '--workspace', root, '--model', 'test', '--base-url', url, '--max-tokens', '100000', '--input-price', '2', '--output-price', '8'], { KODO_API_KEY: 'fixture' });
    expect(result.code).toBe(0);
    const events = result.out.trim().split(/\r?\n/).map(line => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: 'budget.info', data: { costUpperBoundUSD: 0.8, limits: { maxTokens: 100000 } } });
    const runs = await cli(['runs', '--json', '--data-dir', root]);
    expect(JSON.parse(runs.out)).toMatchObject([{ id: events[0].runId, status: 'completed' }]);
    expect((await cli(['list', '--json', '--data-dir', root])).code).toBe(0);
    const gc = await cli(['gc', '--vacuum', '--data-dir', root]);
    expect(gc.code).toBe(0);
    expect(JSON.parse(gc.out)).toHaveProperty('removedBlobs');
    expect((await cli(['gc', '--older-than-days', '0', '--data-dir', root])).err).toContain('GC_RETENTION');
  }, 20000);

  it.each([0, 1])('executes a host verification command with exit %s and records its evidence', async exitCode => {
    const root = temp();
    const url = await mockServer((_body, response) => sendStream(response, [delta({ content: 'candidate' }), delta({}, 'stop')]));
    const argv = JSON.stringify([process.execPath, '-e', `console.log('verification evidence'); process.exit(${exitCode})`]);
    const result = await cli(['run', 'task', '--json', '--data-dir', root, '--workspace', root, '--model', 'test', '--base-url', url, '--verify-command', argv], { KODO_API_KEY: 'fixture' });
    const events = result.out.trim().split(/\r?\n/).map(line => JSON.parse(line));
    expect(events.some(event => event.type === 'completion.checked' && event.data.passed === (exitCode === 0))).toBe(true);
    expect(result.code).toBe(exitCode);
    if (exitCode === 0) expect(events.at(-1)).toMatchObject({ type: 'run.completed', data: { result: { quality: { status: 'passed' } } } });
    else expect(events.at(-1)).toMatchObject({ type: 'run.failed' });
  });

  it('combines successful command verification with required final text', async () => {
    const root = temp();
    let requests = 0;
    const url = await mockServer((_body, response) => sendStream(response, [delta({ content: ++requests === 1 ? ' ' : 'Implemented and checked.' }), delta({}, 'stop')]));
    const argv = JSON.stringify([process.execPath, '-e', "require('node:fs').appendFileSync('checks.txt','check\\n')"]);
    const result = await cli(['run', 'task', '--json', '--data-dir', path.join(root, 'state'), '--workspace', root, '--model', 'test', '--base-url', url, '--verify-command', argv], { KODO_API_KEY: 'fixture' });
    expect(result.code, result.err).toBe(0);
    expect(requests).toBe(2);
    expect(readFileSync(path.join(root, 'checks.txt'), 'utf8')).toBe('check\ncheck\n');
    const events = result.out.trim().split(/\r?\n/).map(line => JSON.parse(line));
    expect(events.find(e => e.type === 'completion.checked')).toMatchObject({ data: { passed: false, deliveryPassed: false, qualityPassed: true } });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', data: { result: { text: 'Implemented and checked.', quality: { status: 'passed' } } } });
  });

  it('accepts explicitly silent CLI delivery without claiming quality acceptance', async () => {
    const root = temp();
    const url = await mockServer((_body, response) => sendStream(response, [delta({}, 'stop')]));
    const result = await cli(['run', 'silent task', '--allow-empty-response', '--json', '--data-dir', root, '--workspace', root, '--model', 'test', '--base-url', url], { KODO_API_KEY: 'fixture' });
    expect(result.code, result.err).toBe(0);
    const events = result.out.trim().split(/\r?\n/).map(line => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', data: { result: { text: '', delivery: { status: 'not_required' }, quality: { status: 'not_checked' } } } });
  });

  it('filters model terminal controls and clearly labels unchecked completions', async () => {
    const root = temp();
    const url = await mockServer((_body, response) => sendStream(response, [delta({ content: '\u001b[2Jverified\u001b]0;spoof\u0007' }), delta({}, 'stop')]));
    const result = await cli(['run', 'task', '--data-dir', root, '--workspace', root, '--model', 'test', '--base-url', url], { KODO_API_KEY: 'fixture' });
    expect(result.code).toBe(0);
    expect(result.out + result.err).not.toContain('\u001b');
    expect(result.out).toContain('verified');
    expect(result.err).toContain('未被验收');
  });

  it('shows version and storage diagnostics from the built entry', async () => {
    expect((await cli(['--version'])).out.trim()).toBe('0.1.0-alpha.0');
    const root = temp();
    const result = await cli(['doctor', '--data-dir', root]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ sqlite: 'ok', chineseTrigram: true, credentialConfigured: false });
    expect(result.out + result.err).not.toContain('local-fixture-key');
  });
  it('fails clearly when credentials or arguments are missing', async () => {
    const root = temp();
    const result = await cli(['run', 'task', '--model', 'test', '--data-dir', root]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('MODEL_CREDENTIAL');
    expect(result.out).toBe('');
    expect((await cli(['unknown'])).code).toBe(1);
  });
  it('rejects misplaced options and malformed numeric limits', async () => {
    for (const args of [['run', 'task', '--follow-up'], ['inspect', 'id', '--model', 'ignored'], ['inspect', 'id', '--protocol', 'responses'], ['run', 'task', '--text', 'ignored'], ['answer', 'question'], ['chat', 'task', '--json'], ['doctor', 'extra'], ['run', 'task', '--unknown'], ['resolve', 'id'], ['resolve', 'id', '--call-id', 'call', '--outcome', 'force', '--evidence', 'checked'], ['resolve', 'id', '--call-id', 'call', '--outcome', 'succeeded', '--evidence', ' '], ['resolve', 'id', '--call-id', 'call', '--outcome', 'not_applied', '--evidence', 'verified file is absent'], ['resolve', 'id', '--call-id', 'call', '--outcome', 'succeeded', '--evidence', 'verified file exists', '--retry'], ['reconcile', 'id', '--evidence', 'ignored'], ['resume', 'id', '--force']]) {
      const result = await cli([...args, '--data-dir', temp()]);
      expect(result.code).toBe(1);
      expect(result.err).toContain('ARGUMENTS');
    }
    const result = await cli(['run', 'task', '--model', 'test', '--max-children', '1.5', '--data-dir', temp()], { KODO_API_KEY: 'fixture' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('BUDGET');
  }, 15_000);
  it('validates the token window and opt-in cache policy before making requests', async () => {
    const invalid = [
      { args: ['--max-context-tokens', '4096', '--max-output-tokens', '4096'], error: 'BUDGET' },
      { args: ['--max-context-tokens', '0'], error: 'BUDGET' },
      { args: ['--prompt-cache', 'automatic'], error: 'MODEL_CACHE' },
    ];
    for (const item of invalid) {
      const result = await cli(['run', 'task', '--model', 'test', '--data-dir', temp(), ...item.args], { KODO_API_KEY: 'fixture' });
      expect(result.code).toBe(1);
      expect(result.err).toContain(item.error);
    }
    expect((await cli(['resume', 'missing', '--max-context-tokens', '256000', '--data-dir', temp()])).err).toContain('ARGUMENTS');
    expect((await cli(['resume', 'missing', '--prompt-cache', 'session', '--data-dir', temp()])).err).toContain('ARGUMENTS');
    const url = await mockServer((body, response) => {
      expect(body.prompt_cache_key).toBeTypeOf('string');
      sendStream(response, [delta({ content: 'configured' }), delta({}, 'stop')]);
    });
    const root = temp();
    const result = await cli(['run', 'task', '--json', '--workspace', root, '--data-dir', path.join(root, 'state'), '--model', 'test', '--base-url', url, '--max-context-tokens', '256000', '--max-context-chars', '9007199254740991', '--max-tokens', '200000'], { KODO_API_KEY: 'fixture', KODO_PROMPT_CACHE: 'session' });
    expect(result.code, result.err).toBe(0);
    const runId = JSON.parse(result.out.trim().split(/\r?\n/).at(-1)!).runId as string;
    const inspected = JSON.parse((await cli(['inspect', runId, '--json', '--data-dir', path.join(root, 'state')])).out);
    expect(inspected.run.binding.promptCache).toBe('session');
    expect(inspected.session.budget.maxContextTokens).toBe(256000);
  }, 15_000);
  it('persists a user question, exits 2, and resumes from an answer in another process', async () => {
    let requests = 0;
    const url = await mockServer((body, response) => {
      requests++;
      if (requests === 1) sendStream(response, [delta({ tool_calls: [{ index: 0, id: 'ask', function: { name: 'ask_user', arguments: '{"question":"请选择报告语言"}' } }] }), delta({}, 'tool_calls')]);
      else {
        expect(JSON.stringify(body.messages)).toContain('中文');
        sendStream(response, [delta({ content: '中文报告已完成' }), delta({}, 'stop')]);
      }
    });
    const root = temp();
    const data = path.join(root, 'state');
    const first = await cli(['run', '报告', '--json', '--data-dir', data, '--workspace', root, '--model', 'test', '--base-url', url, '--max-tokens', '200000'], { KODO_API_KEY: 'fixture' });
    expect(first.code).toBe(2);
    const required = JSON.parse(first.out.trim().split(/\r?\n/).at(-1)!) as { type: string; runId: string; questions: { id: string; content: string }[] };
    expect(required.type).toBe('input.required');
    expect(required.questions[0]!.content).toBe('请选择报告语言');
    const queued = await cli(['input', required.runId, '--text', '后续报告', '--follow-up', '--json', '--data-dir', data], { KODO_API_KEY: 'fixture' });
    expect(queued.code).toBe(2);
    expect(JSON.parse(queued.out.trim().split(/\r?\n/).at(-1)!)).toMatchObject({ type: 'input.required', questions: [{ id: required.questions[0]!.id }] });
    const resumed = await cli(['answer', required.questions[0]!.id, '--text', '中文', '--json', '--data-dir', data], { KODO_API_KEY: 'fixture' });
    expect(resumed.code).toBe(0);
    expect(JSON.parse(resumed.out.trim().split(/\r?\n/).at(-1)!)).toMatchObject({ type: 'run.completed', runId: required.runId, data: { result: { text: '中文报告已完成' } } });
    expect(requests).toBe(2);
  });
  it('accepts Chinese multiline paste and answers a live question', async () => {
    let requests = 0;
    const url = await mockServer((body, response) => {
      requests++;
      if (requests === 1) sendStream(response, [delta({ tool_calls: [{ index: 0, id: 'ask', function: { name: 'ask_user', arguments: '{"question":"请补充两行要求"}' } }] }), delta({}, 'tool_calls')]);
      else {
        const messages = body.messages as { content: string }[];
        expect(messages.some(message => typeof message.content === 'string' && message.content.includes('第一行\\n第二行\\n/quit'))).toBe(true);
        sendStream(response, [delta({ content: '已按中文多行要求完成' }), delta({}, 'stop')]);
      }
    });
    const root = temp();
    const session = chat(['任务', '--workspace', root, '--data-dir', path.join(root, 'state'), '--model', 'test', '--base-url', url, '--max-tokens', '200000']);
    await session.waitFor('请补充两行要求');
    session.child.stdin.end('/status\n/paste\n第一行\n第二行\n/quit\n/send\n');
    const result = await session.result;
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('已按中文多行要求完成');
    expect(result.err).toContain('"questions"');
    expect(requests).toBe(2);
  });
  it('runs queued follow-ups in order after the active task without requiring more input', async () => {
    let requests = 0;
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const firstRequest = new Promise<void>(resolve => { started = resolve; });
    const url = await mockServer(async (body, response) => {
      requests++;
      if (requests === 1) await new Promise<void>(resolve => { release = resolve; started!(); });
      else expect(JSON.stringify(body.messages)).toContain(requests === 2 ? '后续甲' : '后续乙');
      sendStream(response, [delta({ content: `已完成任务${requests}` }), delta({}, 'stop')]);
    });
    const root = temp();
    const session = chat(['首次任务', '--workspace', root, '--data-dir', path.join(root, 'state'), '--model', 'test', '--base-url', url, '--max-tokens', '200000']);
    await session.waitFor('model.started');
    session.child.stdin.write('/next 后续甲\n/next 后续乙\n');
    await session.waitFor('后续任务已排队');
    await firstRequest;
    session.child.stdin.end();
    release!();
    const result = await session.result;
    expect(result.code).toBe(0);
    expect(requests).toBe(3);
    expect(result.out).toContain('已完成任务3');
  });
  it('quit cancels the active task and queued follow-ups without sending another model request', async () => {
    let requests = 0;
    const url = await mockServer(() => { requests++; });
    const root = temp();
    const data = path.join(root, 'state');
    const session = chat(['等待中的任务', '--workspace', root, '--data-dir', data, '--model', 'test', '--base-url', url, '--max-tokens', '200000']);
    await session.waitFor('model.started');
    session.child.stdin.end('/next 不应执行\n/quit\n');
    const result = await session.result;
    expect(result.code).toBe(130);
    expect(requests).toBeLessThanOrEqual(1);
    expect(result.out).not.toContain('run.completed');
    const queued = /后续任务已排队：([^\r\n]+)/.exec(result.err)?.[1];
    expect(queued).toBeTruthy();
    const inspection = await cli(['inspect', queued!, '--json', '--data-dir', data]);
    expect(JSON.parse(inspection.out)).toMatchObject({ run: { status: 'cancelled' } });
  });
  it('cancel stops the active task and proceeds to its submitted follow-up', async () => {
    let requests = 0;
    let started: (() => void) | undefined;
    const firstRequest = new Promise<void>(resolve => { started = resolve; });
    const url = await mockServer((_body, response) => {
      requests++;
      if (requests === 1) { started!(); return; }
      sendStream(response, [delta({ content: '取消后完成下一项' }), delta({}, 'stop')]);
    });
    const root = temp();
    const session = chat(['取消此任务', '--workspace', root, '--data-dir', path.join(root, 'state'), '--model', 'test', '--base-url', url, '--max-tokens', '200000']);
    await firstRequest;
    session.child.stdin.end('/next 下一项\n/cancel\n');
    const result = await session.result;
    expect(result.code, result.err).toBe(0);
    expect(requests).toBe(2);
    expect(result.out).toContain('取消后完成下一项');
    expect(result.err).toContain('run.cancelled');
  });
  it('runs a real SDK tool round-trip through JSONL and persists inspectable evidence', async () => {
    let requests = 0;
    const url = await mockServer((_body, response) => {
      requests++;
      sendStream(response, requests === 1 ? [
        delta({ tool_calls: [{ index: 0, id: 'report-call', function: { name: 'artifact_write', arguments: '{"name":"report","content":"actual tool evidence"}' } }] }),
        delta({}, 'tool_calls'),
      ] : [delta({ content: 'done from local protocol fixture' }), delta({}, 'stop')]);
    });
    const root = temp();
    const result = await cli(['run', 'create report', '--json', '--allow-write', '--data-dir', path.join(root, 'state'), '--workspace', root, '--model', 'local-test', '--base-url', url], { KODO_API_KEY: 'local-fixture-key' });
    expect(result.code).toBe(0);
    const events = result.out.trim().split(/\r?\n/).map(line => JSON.parse(line) as { type: string; runId: string; seq?: number });
    expect(events.map(x => x.type)).toContain('text.delta');
    expect(events.at(-1)?.type).toBe('run.completed');
    const durable = events.filter(x => x.seq !== undefined);
    expect(durable.map(x => x.seq)).toEqual([...durable.map(x => x.seq)].sort((a, b) => a! - b!));
    expect(result.out + result.err).not.toContain('local-fixture-key');
    const inspection = await cli(['inspect', events[0]!.runId, '--json', '--data-dir', path.join(root, 'state')]);
    expect(inspection.code).toBe(0);
    expect(JSON.parse(inspection.out)).toMatchObject({ run: { status: 'completed' } });
    expect(requests).toBe(2);
  });
  it('exits with failure on an incomplete provider stream', async () => {
    const url = await mockServer((_body, response) => sendStream(response, [delta({ content: 'incomplete' })], false));
    const root = temp();
    const result = await cli(['run', 'task', '--json', '--data-dir', path.join(root, 'state'), '--workspace', root, '--model', 'local-test', '--base-url', url], { KODO_API_KEY: 'local-fixture-key' });
    expect(result.code).toBe(1);
    const final = JSON.parse(result.out.trim().split(/\r?\n/).at(-1)!) as { type: string; data: { error: string } };
    expect(final.type).toBe('run.failed');
    expect(final.data.error).toContain('MODEL_INCOMPLETE');
  });
  it('blocks replay after a real process crash between file write and result commit', async () => {
    const root = temp();
    const worker = fileURLToPath(new URL('./fixtures/crash-writer.mjs', import.meta.url));
    const child = spawn(process.execPath, [worker, root], { windowsHide: true });
    let runId = '';
    await new Promise<void>((resolve, reject) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`worker did not reach crash barrier: ${err}`)); }, 5000);
      child.stderr.on('data', chunk => { err += String(chunk); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => {
        out += String(chunk);
        if (out.includes('\n') && !runId) {
          runId = (JSON.parse(out.trim()) as { runId: string }).runId;
          child.kill('SIGKILL');
        }
      });
      child.on('close', () => { clearTimeout(timer); if (runId) resolve(); else reject(new Error(`worker failed before writing: ${err}`)); });
    });
    expect(readFileSync(path.join(root, 'external-effect.txt'), 'utf8')).toBe('written once');
    expect(existsSync(path.join(root, 'state', 'owner.lock'))).toBe(true);
    const unlocked = await cli(['doctor', '--unlock', '--data-dir', path.join(root, 'state')]);
    expect(unlocked.code).toBe(0);
    expect(JSON.parse(unlocked.out).interruptedRuns).toContain(runId);
    const resumed = await cli(['resume', runId, '--json', '--data-dir', path.join(root, 'state')]);
    expect(resumed.code).toBe(1);
    expect(resumed.err).toContain('UNKNOWN_WRITE');
    const inspected = await cli(['inspect', runId, '--json', '--data-dir', path.join(root, 'state')]);
    expect(JSON.parse(inspected.out).calls.some((call: { status: string; kind: string }) => call.kind === 'tool' && call.status === 'unknown')).toBe(true);
    expect(readFileSync(path.join(root, 'external-effect.txt'), 'utf8')).toBe('written once');
  });
  it('requires verified evidence to resume an uncertain external write and preserves its failed record', async () => {
    const url = await mockServer((body, response) => {
      expect(JSON.stringify(body.messages)).toContain('operator verified');
      sendStream(response, [delta({ content: 'recovered without replay' }), delta({}, 'stop')]);
    });
    const root = temp();
    const data = path.join(root, 'state');
    const app = new Application(data, scripted(calls(call('process.exec', { program: process.execPath, args: ['-e', "require('node:fs').appendFileSync('effect.txt','once\\n')"] }))));
    const run = app.createRun({ objective: 'append exactly once and report evidence', workspace: root, permissions: ['read', 'exec'], binding: { model: 'fixture', baseURL: url, apiKeyEnv: 'KODO_API_KEY', limits: { context: 256000, output: 8192 } }, budget: { maxTokens: 200_000 } });
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, verificationCommand: { program: process.execPath, args: ['-e', 'console.log("recovery verification")'] } });
    app.setCompletionValidator(run.id, () => ({ passed: true }));
    let original: string;
    let uncertainCall: string;
    try {
      const execute = app.coordinator.tools.execute.bind(app.coordinator.tools);
      app.coordinator.tools.execute = async (...args) => { await execute(...args); throw new Error('test: result persistence lost after external effect'); };
      const failed = await app.run(run.id);
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('UNKNOWN_WRITE');
      original = JSON.stringify(failed);
      uncertainCall = app.store.calls(run.id).find(item => item.status === 'unknown')!.id;
    } finally { await app.shutdown(); }
    const refused = await cli(['resume', run.id, '--data-dir', data]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('UNKNOWN_WRITE');
    const unresolved = await cli(['reconcile', run.id, '--json', '--data-dir', data]);
    expect(unresolved.code).toBe(0);
    expect(unresolved.out).toContain(uncertainCall);
    const resolved = await cli(['resolve', run.id, '--call-id', uncertainCall, '--outcome', 'succeeded', '--evidence', 'operator verified effect.txt contains exactly one once line', '--json', '--data-dir', data]);
    expect(resolved.code, resolved.err).toBe(0);
    expect(resolved.out).toContain('operator verified');
    expect(resolved.out).toContain(uncertainCall);
    const resumed = await cli(['resume', run.id, '--json', '--data-dir', data], { KODO_API_KEY: 'fixture' });
    expect(resumed.code, resumed.err).toBe(0);
    const completed = JSON.parse(resumed.out.trim().split(/\r?\n/).at(-1)!) as { type: string; runId: string; data: { result: { text: string } } };
    expect(completed.type).toBe('run.completed');
    expect(completed.runId).not.toBe(run.id);
    expect(completed.data.result.text).toBe('recovered without replay');
    expect(completed).toMatchObject({ data: { result: { quality: { status: 'passed' } } } });
    const inspected = JSON.parse((await cli(['inspect', run.id, '--json', '--data-dir', data])).out) as { run: unknown; calls: { id: string; status: string }[] };
    expect(JSON.stringify(inspected.run)).toBe(original);
    expect(inspected.calls.find(item => item.id === uncertainCall)?.status).toBe('unknown');
    expect(readFileSync(path.join(root, 'effect.txt'), 'utf8')).toBe('once\n');
  }, 15_000);
  it('retries an effect exactly once only after not_applied evidence and explicit retry authorization', async () => {
    const url = await mockServer((_body, response) => sendStream(response, [delta({ content: 'controlled retry completed' }), delta({}, 'stop')]));
    const root = temp();
    const data = path.join(root, 'state');
    const app = new Application(data, scripted(calls(call('process.exec', { program: process.execPath, args: ['-e', "require('node:fs').appendFileSync('retry.txt','once\\n')"] }))));
    const run = app.createRun({ objective: 'apply controlled effect', workspace: root, permissions: ['read', 'exec'], binding: { model: 'fixture', baseURL: url, apiKeyEnv: 'KODO_API_KEY', limits: { context: 256000, output: 8192 } }, budget: { maxTokens: 200_000 } });
    let uncertainCall: string;
    try {
      app.coordinator.tools.execute = async (_id, _name, _args, _signal, onEffectStart) => { onEffectStart?.(); throw new Error('test uncertainty after external execution begins'); };
      expect((await app.run(run.id)).status).toBe('failed');
      uncertainCall = app.store.calls(run.id).find(item => item.status === 'unknown')!.id;
    } finally { await app.shutdown(); }
    expect(existsSync(path.join(root, 'retry.txt'))).toBe(false);
    const short = await cli(['resolve', run.id, '--call-id', uncertainCall, '--outcome', 'not_applied', '--evidence', 'absent', '--retry', '--json', '--data-dir', data]);
    expect(short.code).toBe(1);
    expect(short.err).toContain('RECOVERY_EVIDENCE');
    const resolved = await cli(['resolve', run.id, '--call-id', uncertainCall, '--outcome', 'not_applied', '--evidence', 'Independently checked retry.txt is absent and the program never started.', '--retry', '--json', '--data-dir', data]);
    expect(resolved.code, resolved.err).toBe(0);
    expect(JSON.parse(resolved.out)).toMatchObject({ originalCalls: expect.arrayContaining([expect.objectContaining({ id: uncertainCall, status: 'unknown' })]), resolutions: [expect.objectContaining({ retryAuthorized: true, outcome: 'not_applied' })] });
    const resumed = await cli(['resume', run.id, '--data-dir', data], { KODO_API_KEY: 'fixture' });
    expect(resumed.code, resumed.err).toBe(0);
    expect(resumed.out).toContain('controlled retry completed');
    expect(readFileSync(path.join(root, 'retry.txt'), 'utf8')).toBe('once\n');
    const repeated = await cli(['resume', run.id, '--data-dir', data], { KODO_API_KEY: 'fixture' });
    expect(repeated.code).toBe(1);
    expect(readFileSync(path.join(root, 'retry.txt'), 'utf8')).toBe('once\n');
  });
});
