import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { assessReportContent, latestReportArtifacts, hasCompleteTestSummary } from './assessment.mjs';
import { historyCatalogTask, prepareHistoryCatalog, oracleHistoryCatalog } from './complex-history.mjs';

export const projectFiles = ['src', 'tests', 'docs', 'examples', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.mjs', 'eslint.config.mjs', 'README.md'];

// Reuses the established task mutations and held-out behavioral oracle unchanged.
export function createFixtures(repository, sourceSnapshot, { autonomous = false } = {}) {
const assetsDirectory = process.env.KODO_COMPLEX_ASSETS;
const vitest = path.join(repository, 'node_modules', 'vitest', 'vitest.mjs');
const tsc = path.join(repository, 'node_modules', 'typescript', 'bin', 'tsc');
const definitions = [
  { id: 'repository-report', name: '真实仓库试用报告', mutations: [], tests: [], files: [], objective: '请根据当前仓库的代码与文档，为刚加入项目的同事编写试用说明。说明目前能做什么、上下文与写入恢复如何工作、哪些产品能力尚未实现，并给出至少三条当前项目确实支持的运行或验证命令。列出至少两个使用限制，引用对应的真实文件路径。请保存一份可读取的报告产物，最后简洁汇报交付结果。请自行检查事实，不要向用户提问。', tools: ['file.read', 'file.list', 'file.search', 'artifact.write', 'artifact.read'] },
  { id: 'pagination-repair', name: '真实源码分页回归修复', mutations: ['pagination'], tests: ['tests/context.test.ts'], files: ['src/runtime/history.ts'], objective: '有同事反馈：history.read 读取很长的历史消息时，照返回的 next 游标继续请求，会反复拿到开头，无法还原完整原文。tests/context.test.ts 的分片回归也失败。请定位并修复这个问题，保持权限边界和其余行为，运行相关测试并汇报真实结果。请独立完成，无需子代理，不要向用户提问。不要修改现有测试、依赖或配置来绕过失败。', tools: ['file.read', 'file.list', 'file.search', 'file.apply_patch', 'process.exec', 'artifact.write', 'artifact.read'] },
  { id: 'collaborative-repair', name: '双缺陷协作修复', mutations: ['pagination', 'newlines'], tests: ['tests/context.test.ts', 'tests/card-newlines.test.ts'], files: ['src/runtime/history.ts', 'src/agents/card.ts'], objective: '请组织两个子代理并行处理两个独立反馈，然后由主代理验收并交付：一，history.read 对长消息按 next 游标翻页会重复开头，不能完整还原；二，同一份 AGENT.md 只把 LF 换成 Windows CRLF 就得到不同 digest，触发同版本卡片冲突。相关回归分别是 tests/context.test.ts 与 tests/card-newlines.test.ts。请让两个子任务分别排查、修改和验证，避免相互覆盖文件。主代理需要检查最终结果并汇总实际测试证据。不要改现有测试、依赖或配置绕过失败，不需要询问用户。', tools: ['file.read', 'file.list', 'file.search', 'file.apply_patch', 'process.exec', 'artifact.write', 'artifact.read'] },
  { id: 'focused-report', name: '小上下文定向说明（诊断）', diagnostic: true, mutations: [], tests: [], files: [], objective: '请只依据 package.json 与 src/runtime/history.ts，保存一份简短的 history.read 使用说明产物，列出至少三条 package.json 真实支持的 npm 运行或验证命令，解释长消息的 offset/contentOffset/next 游标，写明 maxChars 合法范围与跨会话权限限制，引用这两个源文件。最后汇报产物。无需阅读其他文件或向用户提问。', tools: ['file.read', 'artifact.write', 'artifact.read'] },
  { id: 'targeted-newline-repair', name: '小上下文定向修复（诊断）', diagnostic: true, mutations: ['newlines'], tests: ['tests/card-newlines.test.ts'], files: ['src/agents/card.ts'], objective: '同一份 AGENT.md 从 LF 改为 CRLF 后 digest 不一致。请检查 src/agents/card.ts 并修复，让换行方式不影响身份，其他文本变化仍应改变 digest，保留原有参数校验。相关回归是 tests/card-newlines.test.ts，START_HERE.md 提供可直接使用的测试程序与参数。请只修改这个源文件并实际运行回归，最后说明结果。无需子代理或向用户提问。', tools: ['file.read', 'file.apply_patch', 'process.exec', 'artifact.write', 'artifact.read'] },
].filter(item => !item.diagnostic);
definitions.push(historyCatalogTask({ autonomous }));
const hash = value => createHash('sha256').update(value).digest('hex');
async function manifest(directory, prefix = '') {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);
    if (!prefix && ['dist', 'node_modules', '.kodo'].includes(item.name)) continue;
    if (item.isDirectory()) entries.push(...await manifest(path.join(directory, item.name), relative));
    else if (item.isFile()) entries.push([relative, hash(await readFile(path.join(directory, item.name)))]);
  }
  return entries;
}
async function execute(program, args, cwd, log, timeoutMs = 60_000) {
  const result = await new Promise(resolve => {
    const child = spawn(program, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-500_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-500_000); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, error: error.message, stdout, stderr, timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
  await writeFile(log, JSON.stringify({ program, args, cwd, ...result }, null, 2), 'utf8');
  return result;
}
const cardSource = '---\nschema_version: 1\nid: eval/newlines\nversion: 1.0.0\nname: Newline regression\ndescription: Equivalent text keeps identity across platforms.\ncapabilities:\n  tools: []\n---\nInspect evidence.\nKeep user constraints.\n';
async function prepare(workspace, definition) {
  await mkdir(workspace, { recursive: true });
  for (const name of projectFiles) await cp(path.join(sourceSnapshot, name), path.join(workspace, name), { recursive: true });
  if (definition.mutations.includes('pagination')) {
    const file = path.join(workspace, 'src/runtime/history.ts');
    const source = await readFile(file, 'utf8');
    const changed = source.replace('position = end; break;', 'position = 0; break;');
    if (changed === source) throw new Error('Pagination mutation no longer matches source');
    await writeFile(file, changed, 'utf8');
  }
  if (definition.mutations.includes('newlines')) {
    const file = path.join(workspace, 'src/agents/card.ts');
    const source = await readFile(file, 'utf8');
    const changed = source.replace("digest(content.replaceAll('\\r\\n', '\\n'))", 'digest(content)');
    if (changed === source) throw new Error('Newline mutation no longer matches source');
    await writeFile(file, changed, 'utf8');
    await writeFile(path.join(workspace, 'tests/card-newlines.test.ts'), `import { expect, it } from 'vitest';\nimport { parseCard } from '../src/agents/card.js';\nit('keeps the same card digest for LF and CRLF', () => {\n const source = ${JSON.stringify(cardSource)};\n expect(parseCard(source.replaceAll('\\n', '\\r\\n')).digest).toBe(parseCard(source).digest);\n});\n`, 'utf8');
  }
  await writeFile(path.join(workspace, 'START_HERE.md'), `这是当前 Kodo 仓库的独立副本，依赖使用宿主已安装的同版本模块，无需安装。\n\n相关测试的 process.exec 调用：\n${JSON.stringify({ program: process.execPath, args: [vitest, 'run', ...definition.tests] }, null, 2)}\n\n只在本副本内修改和验证。请先读必要代码；file.apply_patch 使用 file.read 返回的 expectedHash，content 是文件的完整新内容。process.exec 的程序与参数是分开的，不支持 shell 字符串。\n`, 'utf8');
  if (definition.id === 'history-catalog') {
    await prepareHistoryCatalog(workspace, { autonomous });
    const commands = { build: { program: process.execPath, args: [tsc, '-p', 'tsconfig.build.json'] },
      typecheck: { program: process.execPath, args: [tsc, '--noEmit', '-p', 'tsconfig.json'] },
      lint: { program: process.execPath, args: [path.join(repository, 'node_modules/eslint/bin/eslint.js'), 'src', 'tests', 'scripts'] } };
    const start = await readFile(path.join(workspace, 'START_HERE.md'), 'utf8');
    await writeFile(path.join(workspace, 'START_HERE.md'), `${start}\n必须先读 HISTORY_CATALOG_TASK.md 完整契约。以下build、typecheck、lint均需实际执行并成功：\n${JSON.stringify(commands, null, 2)}\n两份新测试由你编写。完整运行所列五份测试，不要使用筛选、跳过或截断输出。\n`, 'utf8');
  }
}

// This independent oracle is never supplied in the task context or copied into the task workspace.
// It imports the candidate's freshly compiled implementation and checks behavior, not patch spelling.
async function oracle(workspace, directory, definition, prefix) {
  if (definition.id === 'history-catalog') return oracleHistoryCatalog({ workspace, directory, repository, prefix, assetsDirectory });
  const build = await execute(process.execPath, [tsc, '-p', 'tsconfig.build.json'], workspace, path.join(directory, `${prefix}-build.json`));
  if (build.code !== 0) return { passed: false, build, checks: null };
  const script = `import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Application } from ${JSON.stringify(pathToFileURL(path.join(workspace, 'dist/application/index.js')).href)};
import { readHistory } from ${JSON.stringify(pathToFileURL(path.join(workspace, 'dist/runtime/history.js')).href)};
import { parseCard } from ${JSON.stringify(pathToFileURL(path.join(workspace, 'dist/agents/card.js')).href)};
const checks = [];
${definition.mutations.includes('newlines') ? `const source = ${JSON.stringify(cardSource)};
assert.equal(parseCard(source).digest, parseCard(source.replaceAll('\\n', '\\r\\n')).digest); checks.push('LF/CRLF identity');
assert.notEqual(parseCard(source).digest, parseCard(source + 'Changed method').digest); checks.push('changed prompt changes identity');
assert.throws(() => parseCard(source.replace('schema_version: 1', 'schema_version: 9'))); checks.push('invalid schema rejected');` : ''}
${definition.mutations.includes('pagination') ? `const app = new Application(${JSON.stringify(path.join(directory, `${prefix}-oracle-data`))});
try {
 const run = app.createRun({ objective: 'Independent pagination acceptance', workspace: ${JSON.stringify(workspace)}, binding: {model:'unused',baseURL:'http://127.0.0.1:1/v1',apiKeyEnv:'UNUSED',limits:{context:256000,output:8192}} });
 const messages = [{role:'user',content:'original'}, {role:'assistant',content:null,tool_calls:[{id:'tool',name:'file.read',arguments:'{}'}]}, {role:'tool',tool_call_id:'tool',content:('中文😀"\\\\' + randomUUID()).repeat(130)}, {role:'assistant',content:'done'}];
 const ref = app.store.blob({version:1,runId:run.id,sessionId:run.sessionId,messages}); app.store.event(run.id,'context.compacted',{archivedRef:ref});
 const recovered = new Map(); let cursor={ref}; let pages=0;
 while(cursor) {
  assert.ok(++pages < 1000, 'pagination did not terminate');
  const page = readHistory(app.store,run.id,{...cursor,maxChars:257,limit:1});
  for(const message of page.messages) recovered.set(page.offset, JSON.stringify(message));
  for(const part of page.fragments) {const previous=recovered.get(part.messageIndex)||''; assert.equal(previous.length,part.start,'page repeats or skips source characters'); recovered.set(part.messageIndex,previous+part.text);}
  if(page.next) assert.ok(page.next.offset>(cursor.offset??0) || (page.next.offset===(cursor.offset??0)&&page.next.contentOffset>(cursor.contentOffset??0)), 'cursor did not advance');
  cursor=page.next;
 }
 assert.deepEqual([...recovered.values()].map(value=>JSON.parse(value)),messages); checks.push('lossless Unicode JSON pagination');
 assert.throws(()=>readHistory(app.store,run.id,{ref,maxChars:0})); checks.push('invalid page bound rejected');
 const foreign=app.createRun({objective:'Foreign session',workspace:${JSON.stringify(workspace)},binding:run.binding}); assert.throws(()=>readHistory(app.store,foreign.id,{ref})); checks.push('foreign history denied');
} finally {app.close();}` : ''}
console.log(JSON.stringify({passed:true,checks}));`;
  const file = path.join(directory, `${prefix}-oracle.mjs`);
  await writeFile(file, script, 'utf8');
  const checks = await execute(process.execPath, [file], workspace, path.join(directory, `${prefix}-oracle.json`));
  return { passed: checks.code === 0, build, checks };
}
async function complexControls() {
  if (!assetsDirectory) throw new Error('Set KODO_COMPLEX_ASSETS to independently verified complex-task assets');
  const controls = await readFile(path.join(assetsDirectory, 'controls.json'));
  if (JSON.parse(controls.toString('utf8')).controlsValid !== true) throw new Error('Complex-task positive/negative controls are invalid');
  return { assetsDirectory, controlsValid: true, controlsSha256: hash(controls), oracleSha256: hash(await readFile(path.join(assetsDirectory, 'oracle.mjs'))) };
}

async function verifyImplementation(verification, directory, definition) {
  if (verification.build.code !== 0) return { passed: false, reason: 'Independent build failed' };
  const workspace = verification.isolatedWorkspace;
  const missingTests = [];
  for (const test of definition.tests) {
    try { await readFile(path.join(directory, 'workspace', test)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; missingTests.push(test); }
  }
  if (missingTests.length) return { passed: false, reason: 'Required test files are missing; Vitest filename filters alone do not prove they ran', missingTests };
  for (const name of ['tests', 'scripts', 'docs', 'examples', 'README.md', 'package-lock.json', 'vitest.config.mjs', 'eslint.config.mjs']) {
    await cp(path.join(directory, 'workspace', name), path.join(workspace, name), { recursive: true });
  }
  const tests = await execute(process.execPath, [vitest, 'run', ...definition.tests], workspace, path.join(directory, 'independent-tests.json'), 90000);
  const typecheck = await execute(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], workspace, path.join(directory, 'independent-typecheck.json'), 90000);
  const lint = await execute(process.execPath, [path.join(repository, 'node_modules/eslint/bin/eslint.js'), 'src', 'tests', 'scripts'], workspace, path.join(directory, 'independent-lint.json'), 90000);
  return { passed: [tests, typecheck, lint].every(result => result.code === 0 && !result.timedOut) && hasCompleteTestSummary(tests.stdout), tests, typecheck, lint };
}
async function assessReport(app, run, calls, definition) {
  const written = calls.filter(call => call.name === 'artifact.write' && call.status === 'succeeded');
  const artifactVersions = written.map(call => app.store.readArtifact(run.id, app.store.readBlob(call.resultRef).id));
  const artifacts = latestReportArtifacts(artifactVersions);
  const text = artifacts.map(value => value.content).join('\n');
  const scripts = JSON.parse(await readFile(path.join(sourceSnapshot, 'package.json'), 'utf8')).scripts;
  const reads = [...new Set(calls.filter(call => call.name === 'file.read' && call.status === 'succeeded').map(call => JSON.parse(app.store.readBlob(call.requestRef).arguments).path))];
  return { ...assessReportContent({ text, reads, scripts, definitionId: definition.id }), artifacts, artifactVersions };
}


return { definitions, manifest, execute, prepare, oracle, assessReport, complexControls, verifyImplementation };
}
