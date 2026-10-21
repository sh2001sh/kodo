import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

export const editable = ['src/providers/anthropic.ts', 'src/providers/responses.ts'];
export const addedTests = ['tests/anthropic-framing.test.ts', 'tests/responses-consistency.test.ts'];
export function assessDelivery(result) {
  const checks = { runCompleted: result.status === 'completed', artifactAccepted: result.verification?.passed === true, mainVerification: result.verificationEvidence?.passed === true,
    finalResponsePresent: typeof result.finalText === 'string' && result.finalText.trim().length > 0 };
  return { passed: Object.values(checks).every(Boolean), checks };
}
export const spec = `# 两个独立的真实协议加固工作

在这份 Kodo 源码快照实现以下两项需求。它们没有共享实现或接口修改，各自有现成协议测试。保留已有功能与失败分类，不改公共 API、依赖、测试配置或已有测试。

## A. Anthropic Messages SSE 分帧
阅读 src/providers/anthropic.ts、src/providers/errors.ts、tests/anthropic.test.ts 和 tests/model-protocol.test.ts。
支持 LF、CRLF 和单独 CR 三种合法行结束符，以及同一流中混用。网络块可以在任意 UTF-8 字节、CR/LF 之间断开；CRLF 只算一次行结束。保持 SSE 注释、可选空格、多行 data 拼接的语义。只在空行处分派事件；EOF 前没有空行结束的 message_stop 不构成完整消息。非法 UTF-8、无效 JSON、未闭合内容块、缺失 message_stop、异常停止原因仍须拒绝，不能返回可执行工具。保留文本回调、工具名映射、usage、签名思考与历史回放。测试应包含成功和截断/非法输入，写入 tests/anthropic-framing.test.ts。

## B. Responses 完成证据一致性
阅读 src/providers/responses.ts、src/providers/errors.ts、tests/responses.test.ts 和 tests/model-protocol.test.ts。
response.completed 是唯一成功终态。兼容只发送 completed 的网关，也允许仅对部分条目发送 output_item.done。
若收到 response.output_item.done：output_index 必须为非负安全整数、索引不可重复，item 必须为非空 ID 的 message/function_call/reasoning。保留 completion-only 网关省略最终 item.id 的现有兼容性；最终项若提供 ID 则必须为非空字符串且在数组中唯一。已观察的 done 索引必须在最终数组范围内，对应最终项必须提供与 done 相同的 ID 和 type。无 done 不能免除已提供 ID 的合法性/唯一性检查。
比较 done 与最终项的已完成语义：function_call 的 call_id、name、arguments 字符串完全相同；message 的 role、phase、完整 content 结构相同（对象字段顺序不重要，数组顺序重要）；reasoning 的 summary 结构相同。不要把 added、delta 等未完成事件当成 done 证据。仅 reasoning.encrypted_content 可以在最终项中缺失/null/空串，此时从匹配的 done 条目补入；两边均有非空值但不相等则拒绝。补入不能覆盖最终条目的其他字段（例如最终 status、summary、phase 或额外元数据）。任何矛盾以 MODEL_PROTOCOL 拒绝整次响应，不返回工具。保留现有 tool call 校验、usage、加密回放、错误/截断处理和原条目顺序。测试写入 tests/responses-consistency.test.ts。

## 交付与验证
只修改以上两个源码文件、新增以上两份测试；SPEC.md 和已有文件不得修改。无需新增抽象层或第三个实现文件。不得访问工作目录外的任务资产或凭据；node_modules 是预装的只读依赖链接。
两个子模块均需测试，最后完整执行：
1. node node_modules/typescript/bin/tsc -p tsconfig.build.json
2. node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
3. node node_modules/eslint/bin/eslint.js src tests scripts
4. node node_modules/vitest/vitest.mjs run tests/anthropic.test.ts tests/responses.test.ts tests/model-protocol.test.ts tests/provider-hardening.test.ts tests/anthropic-framing.test.ts tests/responses-consistency.test.ts --maxWorkers 2
使用任务中给出的 Node 可执行文件代替 node。保持退出码证据；失败应修复并重跑。最终说明修改及实际验证结果。不要用运行 completed 代替验收通过。
`;

// Never copied into model workspaces. Anthropic uses deterministic byte chunks at fetch; Responses uses loopback HTTP.
export const oracle = `import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { ResponsesProvider } from '../src/providers/responses.js';
import { mockServer } from './http-server.js';
type Obj = Record<string, unknown>;
afterEach(() => { delete process.env.KODO_BENEFIT_FIXTURE; });
const req = (baseURL: string) => ({ binding: { baseURL, model: 'fixture', apiKeyEnv: 'KODO_BENEFIT_FIXTURE' }, messages: [{ role: 'user' as const, content: 'test' }], tools: [], maxOutputTokens: 100 });
const start = { type: 'message_start', message: { role: 'assistant', content: [], usage: { input_tokens: 12, output_tokens: 0 } } };
const text = [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好🙂' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
function frame(events: Obj[], ending: string, multiline = false): string {
 return events.map(e => ': heartbeat' + ending + 'event: ' + e.type + ending + 'data: ' + (multiline ? JSON.stringify(e, null, 2).split('\\n').join(ending + 'data: ') : JSON.stringify(e)) + ending + ending).join('');
}
async function anthropic(bytes: Uint8Array, size = 1) {
 process.env.KODO_BENEFIT_FIXTURE = 'fixture';
 let offset = 0;
 const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.subarray(offset, offset + size)); offset += size; } } }), { headers: { 'content-type': 'text/event-stream' } }));
 try { const seen: string[] = []; const result = await new AnthropicProvider().complete(req('http://127.0.0.1:1/v1'), new AbortController().signal, t => seen.push(t)); return { result, seen: seen.join('') }; }
 finally { transport.mockRestore(); }
}
const tool = { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'artifact_write', arguments: '{"content":"ok"}', status: 'completed' };
const message = { type: 'message', id: 'm1', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ok', annotations: [] }], status: 'completed' };
const reasoning = { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'brief' }], encrypted_content: 'opaque', status: 'completed' };
const done = (item: Obj, output_index: unknown = 0) => ({ type: 'response.output_item.done', output_index, item });
async function responses(output: Obj[], prior: Obj[] = []) {
 process.env.KODO_BENEFIT_FIXTURE = 'fixture';
 const url = await mockServer((_body, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(frame([...prior, { type: 'response.completed', response: { id: 'resp1', status: 'completed', output, usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } } } }], '\\n')); });
 return new ResponsesProvider().complete(req(url), new AbortController().signal, () => {});
}
describe('Anthropic public framing contract', () => {
 for (const [name, ending] of [['LF', '\\n'], ['CRLF', '\\r\\n'], ['CR', '\\r']]) for (const size of [1, 7]) it(name + ' byte chunks ' + size, async () => {
  const { result, seen } = await anthropic(Buffer.from(frame(text, ending!, true)), size);
  expect(result.message.content).toBe('你好🙂'); expect(seen).toBe('你好🙂'); expect(result.usage).toEqual({ input: 12, output: 5 });
 });
 it('mixes all legal endings', async () => { const bytes = text.map((e, i) => frame([e], ['\\r', '\\n', '\\r\\n'][i % 3]!)).join(''); expect((await anthropic(Buffer.from(bytes))).result.message.content).toBe('你好🙂'); });
 it('does not dispatch EOF without an empty separator', async () => { await expect(anthropic(Buffer.from(frame(text, '\\r').slice(0, -1)))).rejects.toMatchObject({ code: 'MODEL_INCOMPLETE' }); });
 it('rejects missing message_stop', async () => { await expect(anthropic(Buffer.from(frame(text.slice(0, -1), '\\r')))).rejects.toMatchObject({ code: 'MODEL_INCOMPLETE' }); });
 it('rejects malformed JSON with CR framing', async () => { await expect(anthropic(Buffer.from('data: {broken}\\r\\r'))).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 it('rejects invalid UTF8 rather than returning tools', async () => { await expect(anthropic(Buffer.concat([Buffer.from(frame([start], '\\r')), Buffer.from([255]), Buffer.from('\\r\\r')]))).rejects.toBeDefined(); });
 it('rejects tool response with missing stop separator', async () => {
  const events = [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'artifact_write', input: { content: 'x' } } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }, { type: 'message_stop' }];
  await expect(anthropic(Buffer.from(frame(events, '\\r\\n').slice(0, -2)))).rejects.toMatchObject({ code: 'MODEL_INCOMPLETE' });
 });
});
describe('Responses public completion evidence contract', () => {
 it('permits completion-only and preserves usage', async () => { const result = await responses([message, tool]); expect(result.message.tool_calls?.[0]?.id).toBe('call1'); expect(result.usage).toEqual({ input: 8, output: 2, cacheRead: 3 }); });
 it('preserves completion-only gateways without item IDs', async () => { const item: Obj = { ...message }; delete item.id; expect((await responses([item])).message.content).toBe('ok'); });
 it('permits sparse consistent done', async () => { expect((await responses([message, tool], [done(tool, 1)])).finishReason).toBe('tool_calls'); });
 it('ignores unfinished added items as evidence', async () => { expect((await responses([tool], [{ type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '' } }])).finishReason).toBe('tool_calls'); });
 it('compares object structure without key-order restrictions', async () => { const permuted = { ...message, content: [{ annotations: [], text: 'ok', type: 'output_text' }] }; expect((await responses([message], [done(permuted)])).message.content).toBe('ok'); });
 for (const field of ['id', 'call_id', 'name', 'arguments', 'type']) it('rejects conflicting tool ' + field, async () => { await expect(responses([tool], [done({ ...tool, [field]: field === 'type' ? 'message' : 'different' })])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 for (const index of [-1, 0.5, '0', 2, Number.MAX_SAFE_INTEGER + 1]) it('rejects bad done index ' + index, async () => { await expect(responses([tool], [done(tool, index)])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 it('rejects duplicate done indexes', async () => { await expect(responses([tool], [done(tool), done(tool)])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 it('rejects repeated final item IDs', async () => { await expect(responses([message, { ...message }])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 it('rejects absent final item ID', async () => { await expect(responses([{ ...message, id: '' }])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 it('rejects empty done ID', async () => { await expect(responses([tool], [done({ ...tool, id: '' })])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 it('rejects unsupported done item type', async () => { await expect(responses([tool], [done({ id: 'fc1', type: 'image' })])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 for (const field of ['role', 'phase', 'content']) it('rejects message ' + field + ' mismatch', async () => { await expect(responses([message], [done({ ...message, [field]: field === 'content' ? [{ type: 'output_text', text: 'wrong', annotations: [] }] : 'different' })])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 it('rejects reasoning summary mismatch', async () => { await expect(responses([reasoning], [done({ ...reasoning, summary: [] })])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 it('rejects encrypted reasoning contradiction', async () => { await expect(responses([reasoning], [done({ ...reasoning, encrypted_content: 'other' })])).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' }); });
 for (const encrypted_content of [null, '', undefined]) it('fills only omitted encryption ' + String(encrypted_content), async () => {
  const final = { ...reasoning, encrypted_content, final_only: 'retain', status: 'completed', phase: 'final' };
  const result = await responses([final], [done({ ...reasoning, status: 'completed', done_only: 'do-not-copy', phase: 'old' })]);
  expect(result.message.providerData).toMatchObject({ protocol: 'responses', output: [{ ...final, encrypted_content: 'opaque' }] });
  const data = result.message.providerData; if (data?.protocol === 'responses') expect(data.output[0]).not.toHaveProperty('done_only');
 });
});
`;

export const sha = value => createHash('sha256').update(value).digest('hex');
export async function manifest(workspace) {
  const result = {};
  async function walk(relative) {
    for (const entry of await readdir(path.join(workspace, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (['node_modules', 'dist', '.git', '.kodo'].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) result[name] = sha(await readFile(path.join(workspace, name)));
      else result[name] = 'unexpected-symlink';
    }
  }
  await walk('');
  return result;
}
export async function prepare(workspace, snapshot, dependencies) {
  await mkdir(workspace, { recursive: false });
  for (const name of ['src', 'tests', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'eslint.config.mjs', 'vitest.config.mjs']) await cp(path.join(snapshot, name), path.join(workspace, name), { recursive: true, filter: source => !['provider-benefit.mjs', 'test-collaboration-benefit.mjs', 'collaboration-benefit.test.mjs'].includes(path.basename(source)) });
  const { symlink } = await import('node:fs/promises');
  await symlink(dependencies, path.join(workspace, 'node_modules'), 'junction');
  await writeFile(path.join(workspace, 'SPEC.md'), spec, 'utf8');
  return manifest(workspace);
}
export async function execute(args, cwd, log) {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', error => resolve({ code: null, error: error.message, stdout, stderr }));
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  await writeFile(log, JSON.stringify({ args, ...result }, null, 2), 'utf8');
  return result;
}
export async function assess(workspace, directory, before, dependencies) {
  const after = await manifest(workspace);
  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]);
  const scopeRespected = changes.every(name => [...editable, ...addedTests].includes(name)) && addedTests.every(name => after[name]);
  const isolated = path.join(directory, 'acceptance');
  await mkdir(isolated);
  for (const name of ['src', 'tests', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'eslint.config.mjs', 'vitest.config.mjs']) await cp(path.join(workspace, name), path.join(isolated, name), { recursive: true });
  const { symlink } = await import('node:fs/promises');
  await symlink(dependencies, path.join(isolated, 'node_modules'), 'junction');
  await writeFile(path.join(isolated, 'tests/benefit-oracle.test.ts'), oracle, 'utf8');
  const build = await execute(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], isolated, path.join(directory, 'build.json'));
  const hidden = await execute(['node_modules/vitest/vitest.mjs', 'run', 'tests/benefit-oracle.test.ts', '--maxWorkers', '2'], isolated, path.join(directory, 'hidden.json'));
  const existing = await execute(['node_modules/vitest/vitest.mjs', 'run', 'tests/anthropic.test.ts', 'tests/responses.test.ts', 'tests/model-protocol.test.ts', 'tests/provider-hardening.test.ts', ...addedTests.filter(name => after[name]), '--maxWorkers', '2'], isolated, path.join(directory, 'regression.json'));
  const types = await execute(['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], isolated, path.join(directory, 'types.json'));
  const lint = await execute(['node_modules/eslint/bin/eslint.js', 'src', 'tests', 'scripts'], isolated, path.join(directory, 'lint.json'));
  return { passed: scopeRespected && [hidden, existing, build, types, lint].every(r => r.code === 0), scopeRespected, changes, hidden, existing, build, types, lint };
}
