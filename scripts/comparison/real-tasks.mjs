import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { childEnvironment } from './pi-native.mjs';
import { companionTypeExportOnly } from './real-audit.mjs';

export const tasks = [
  { id: 'onboarding', name: '当前仓库上手与运行边界说明', allowed: ['REPORT.md'],
    objective: '请根据当前副本真实源码，为新加入项目的开发者编写 REPORT.md：说明当前内核、能力包分发、依赖准备、MCP、操作系统沙箱和写入恢复的实际行为；给出至少三条可用的运行或验证命令；说明默认行为、授权要求、平台验证范围和至少三个具体限制。引用至少六个真实文件路径，其中至少三个是源码。区分已经实现和计划中的能力，不要照抄旧评测的结论。最后简洁汇报报告位置。' },
  { id: 'pagination', name: '历史原文游标回归修复', allowed: ['src/runtime/history.ts'],
    objective: 'history.read 读取长历史消息后，使用 next 游标继续请求会重复开头，无法还原完整原文。请定位并修复真实源码，保持现有参数和跨会话权限检查。只修改 src/runtime/history.ts，不修改现有测试、依赖、配置。运行 tests/context.test.ts 和 tests/history.test.ts 中存在的相关测试；若不存在其中某文件，不要假称已运行。最后汇报根因、修改和实际验证结果。' },
  { id: 'package-versions', name: '包管理版本查询 API 与 CLI', allowed: ['src/packages/registry.ts', 'src/cli/packages.ts', 'docs/capability-packages.md', 'src/application/index.ts'], allowNewTests: true,
    objective: '请为包管理实现一个真实可用的只读版本查询功能：PackageRegistry.versions(id: string) 返回该 author/name 的已安装版本数组，每项仅含 {version,digest}，按三段数字版本倒序排序（如 10.0.0 > 2.10.0 > 2.9.0）。无安装或不存在的合法 ID 返回 []；非法 ID 拒绝；其他包不混入结果；继续验证包的不可变摘要与 provenance，已篡改的目标版本应明确失败。增加 kodo package versions <author/name>，支持 --data-dir 和 --json，无需模型凭据、不得启动包代码、不创建运行时数据库、不改变采用指针。更新 docs/capability-packages.md，并新增 tests/package-versions.test.ts 覆盖正常与失败路径。仅允许修改 src/packages/registry.ts、src/cli/packages.ts、docs/capability-packages.md，及新增 tests/*.test.ts；src/application/index.ts 仅允许增加 registry 中已声明的相关公开类型导出，保留既有导出且不改变运行时行为。请独立完成并运行新增测试和现有包管理相关测试，不修改任何现有测试、依赖或配置。最后简洁汇报修改和实际验证结果。' },
];
const omittedScripts = new Set(['comparison', 'compare-harnesses.mjs', 'benchmark-real-tasks.mjs', 'test-collaboration-benefit.mjs', 'evaluate-tasks.mjs']);
export const rootFiles = ['src', 'tests', 'docs', 'examples', '.github', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.mjs', 'eslint.config.mjs', 'README.md', 'LICENSE'];
const hash = value => createHash('sha256').update(value).digest('hex');
export async function treeManifest(root, prefix = '') {
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!prefix && ['dist', 'node_modules', '.kodo'].includes(entry.name)) continue;
    const name = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) entries.push(...await treeManifest(path.join(root, entry.name), name));
    else if (entry.isFile()) entries.push([name, hash(await readFile(path.join(root, entry.name)))]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
export async function freezeSource(repository, target) {
  await mkdir(target, { recursive: true });
  for (const name of rootFiles) await cp(path.join(repository, name), path.join(target, name), { recursive: true,
    filter: file => path.resolve(file) !== path.resolve(repository, 'docs/real-task-harness-comparison.md') });
  await mkdir(path.join(target, 'scripts'));
  for (const entry of await readdir(path.join(repository, 'scripts'))) if (!omittedScripts.has(entry)) await cp(path.join(repository, 'scripts', entry), path.join(target, 'scripts', entry), { recursive: true });
  return treeManifest(target);
}
export async function prepareTask(source, workspace, task, repository) {
  await cp(source, workspace, { recursive: true });
  if (task.id === 'pagination') {
    const file = path.join(workspace, 'src/runtime/history.ts'); const original = await readFile(file, 'utf8');
    const mutated = original.replace('position = end; break;', 'position = 0; break;');
    if (original === mutated) throw new Error('Pagination regression no longer matches the actual source');
    await writeFile(file, mutated);
  }
  await writeFile(path.join(workspace, 'START_HERE.md'), `# 本地任务条件\n\n先阅读任务目标并检查源码。仅操作当前副本，不读取其他试验、父目录源码、宿主个人配置或评测程序；不要联网安装依赖。必要的依赖已由祖先目录提供。\n\n以下命令可以在当前副本执行，路径不是源码位置：\n\n- 构建：node ${JSON.stringify(path.join(repository, 'node_modules/typescript/bin/tsc'))} -p tsconfig.build.json\n- 类型检查：node ${JSON.stringify(path.join(repository, 'node_modules/typescript/bin/tsc'))} --noEmit -p tsconfig.json\n- 测试：node ${JSON.stringify(path.join(repository, 'node_modules/vitest/vitest.mjs'))} run <测试路径>\n- 静态检查：node ${JSON.stringify(path.join(repository, 'node_modules/eslint/bin/eslint.js'))} src tests scripts\n\n宿主对每次工具调用的真实上限是 120 秒；不要申请更长的单次超时。预计较慢的验证应按测试文件或检查类型拆分，并在预算接近耗尽前先保存任务要求的产物。\n\nCLI 先构建后运行 node dist/cli/index.js。无需调用模型、安装依赖或公开发布。所有验收须真实执行；不存在的测试文件不能视为已执行。只有任务明确允许的生产文件、文档和新测试可以修改。\n`);
}

export function supportedVerificationCommands(text) {
  const commands = ['npm run check', 'npm test', 'npm run demo:package', 'npm run demo:kernel', 'npm run build'].filter(command => text.includes(command));
  const direct = [
    ['direct TypeScript build', /\bnode\s+(?:"[^"]+"|'[^']+'|\S*typescript[\\/]bin[\\/]tsc)\s+-p\s+tsconfig\.build\.json\b/],
    ['direct TypeScript check', /\bnode\s+(?:"[^"]+"|'[^']+'|\S*typescript[\\/]bin[\\/]tsc)\s+--noEmit\s+-p\s+tsconfig\.json\b/],
    ['direct Vitest run', /\bnode\s+(?:"[^"]+"|'[^']+'|\S*vitest[\\/]vitest\.mjs)\s+run(?:\s|$)/],
    ['direct ESLint run', /\bnode\s+(?:"[^"]+"|'[^']+'|\S*eslint[\\/]bin[\\/]eslint\.js)\s+src\s+tests\s+scripts\b/],
  ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return [...commands, ...direct];
}
export async function execute(program, args, cwd, log, timeoutMs = 120000) {
  const started = Date.now();
  const outcome = await new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false;
    const child = spawn(program, args, { cwd, env: childEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-1000000); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1000000); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, error: error.message, stdout, stderr, timedOut }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
  const result = { ...outcome, elapsedMs: Date.now() - started };
  if (log) await writeFile(log, JSON.stringify({ program, args, cwd, ...result }, null, 2));
  return result;
}
export const paginationOracle = `const app = new api.Application(path.join(root,'state'));
try {
 const run=app.createRun({objective:'Held-out history check',workspace:root,binding:{model:'unused',baseURL:'http://127.0.0.1:1/v1',apiKeyEnv:'UNUSED',limits:{context:256000,output:8192}}});
 const messages=[{role:'user',content:'original'},{role:'assistant',content:null,tool_calls:[{id:'one',name:'file.read',arguments:'{}'}]},{role:'tool',tool_call_id:'one',content:('中文😀"\\\\'+randomUUID()).repeat(97)},{role:'assistant',content:'done'}];
 const ref=app.store.blob({version:1,runId:run.id,sessionId:run.sessionId,messages}); app.store.event(run.id,'context.compacted',{archivedRef:ref});
 await check('lossless Unicode reconstruction and strictly advancing continuation',()=>{const recovered=new Map();let cursor={ref};let pages=0;while(cursor){assert.ok(++pages<500);const page=readHistory(app.store,run.id,{...cursor,maxChars:257,limit:1});for(const message of page.messages)recovered.set(page.offset,JSON.stringify(message));for(const part of page.fragments){const prior=recovered.get(part.messageIndex)||'';assert.equal(prior.length,part.start);recovered.set(part.messageIndex,prior+part.text);}if(page.next)assert.ok(page.next.offset>(cursor.offset??0)||(page.next.offset===(cursor.offset??0)&&page.next.contentOffset>(cursor.contentOffset??0)));cursor=page.next;}assert.deepEqual([...recovered.values()].map(x=>JSON.parse(x)),messages);});
 await check('invalid page bounds rejected',()=>assert.throws(()=>readHistory(app.store,run.id,{ref,maxChars:0})));
 await check('foreign session reference refused',()=>{const other=app.createRun({objective:'Other session',workspace:root,binding:run.binding});assert.throws(()=>readHistory(app.store,other.id,{ref}));});
}finally{await app.shutdown();}`;
export const versionsOracle = `const registry=new api.PackageRegistry(path.join(root,'registry'));
const id='benchmark/versions';const source=path.join(root,'package-source');await mkdir(source,{recursive:true});
const install=async(version,identity=id)=>{await writeFile(path.join(source,'AGENT.md'),'---\\nschema_version: 1\\nid: '+identity+'\\nversion: '+version+'\\nname: Version fixture\\ndescription: Held-out fixture\\ncapabilities:\\n  tools: []\\n---\\nNever execute code.\\n');const archive=path.join(root,randomUUID()+'.zip');await api.exportPackage(source,{schema_version:1,license:'MIT',source:{url:'https://example.com/versions'},files:[{path:'AGENT.md',distributable:true}]},archive);for(let attempt=0;;attempt++){try{return await registry.import(archive);}catch(error){if(attempt>=2||!['EPERM','EBUSY'].includes(error.code))throw error;fixtureRetries++;await delay(50);}}};
await check('empty registry returns []',async()=>assert.deepEqual(await registry.versions(id),[]));
const installed=[];for(const version of ['2.9.0','10.0.0','2.10.0','2.10.11','2.10.2','0.0.0'])installed.push(await install(version));await install('99.0.0','benchmark/other');
let expected=installed.map(item=>({version:item.card.version,digest:item.digest})).sort((a,b)=>{const x=a.version.split('.').map(Number),y=b.version.split('.').map(Number);return y[0]-x[0]||y[1]-x[1]||y[2]-x[2];});
await registry.adopt(id,'2.9.0');const pointer=JSON.stringify(await registry.current(id));
await check('numeric version ordering and exact metadata',async()=>assert.deepEqual(await registry.versions(id),expected));
await check('other and missing package IDs excluded',async()=>assert.deepEqual(await registry.versions('benchmark/missing'),[]));
await check('invalid IDs rejected',async()=>{for(const bad of ['../escape','benchmark/versions@1.0.0','invalid','Benchmark/versions','benchmark/../escape'])await assert.rejects(async()=>registry.versions(bad));});
await check('lookup leaves adoption unchanged',async()=>{await registry.versions(id);assert.equal(JSON.stringify(await registry.current(id)),pointer);});
const cli=path.join(workspace,'dist/cli/index.js');const data=path.join(root,'cli-data');await mkdir(data);await cp(registry.root,path.join(data,'capabilities'),{recursive:true});
const run=async(...args)=>{const r=await runCommand(process.execPath,[cli,...args,'--data-dir',data,'--json'],workspace);return r;};
await check('CLI returns versions without credentials',async()=>{const r=await run('package','versions',id);assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),expected);});
await check('CLI missing ID returns []',async()=>{const r=await run('package','versions','benchmark/missing');assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),[]);});
await check('CLI invalid ID fails',async()=>assert.notEqual((await run('package','versions','../escape')).code,0));
await check('CLI is inert and leaves pointer unchanged',async()=>{assert.deepEqual((await readdir(data)).filter(name=>/^(?:kodo|runtime)\\.sqlite(?:-.*)?$|^owner\\.lock$/.test(name)),[]);const copied=new api.PackageRegistry(path.join(data,'capabilities'));assert.equal(JSON.stringify(await copied.current(id)),pointer);});
await writeFile(path.join(installed[0].root,'AGENT.md'),'tampered');
await check('tampered installed version rejected',async()=>assert.rejects(async()=>registry.versions(id)));
await check('user documentation includes versions command',async()=>assert.match(await readFile(path.join(workspace,'docs/capability-packages.md'),'utf8'),/package versions/));`;
export async function runOracle(workspace, directory, task) {
  const source = `import assert from 'node:assert/strict'; import {cp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises'; import {randomUUID} from 'node:crypto'; import {setTimeout as delay} from 'node:timers/promises'; import path from 'node:path'; import process from 'node:process';
import * as api from ${JSON.stringify(pathToFileURL(path.join(workspace, 'dist/application/index.js')).href)};
import {readHistory} from ${JSON.stringify(pathToFileURL(path.join(workspace, 'dist/runtime/history.js')).href)};
import {execute as runCommand} from ${JSON.stringify(import.meta.url)};
const root=${JSON.stringify(path.join(directory, 'oracle-data-' + randomUUID().slice(0, 8)))}; const workspace=${JSON.stringify(workspace)}; await mkdir(root,{recursive:true}); let fixtureRetries=0; const checks=[];async function check(name,fn){try{await fn();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:error.message});}}
${task.id === 'pagination' ? paginationOracle : versionsOracle}
console.log(JSON.stringify({checks,fixtureRetries}));`;
  const file = path.join(directory, 'held-out.mjs'); await writeFile(file, source);
  const result = await execute(process.execPath, [file], workspace, path.join(directory, 'held-out-process.json'));
  let observed = [];
  try { observed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).checks; } catch { /* Aborted oracle leaves every unobserved requirement failed. */ }
  const required = [...(task.id === 'pagination' ? paginationOracle : versionsOracle).matchAll(/await check\('([^']+)'/g)].map(match => match[1]);
  const checks = required.map(name => observed.find(item => item.name === name) ?? { name, passed: false, error: result.stderr || result.error || 'Oracle did not complete this check' });
  return { ...result, checks };
}
export async function evaluateTrial({ repository, source, workspace, directory, task, before, outcome }) {
  const after = new Map(await treeManifest(workspace)); const baseline = new Map(before);
  const changed = [...new Set([...baseline.keys(), ...after.keys()])].filter(file => baseline.get(file) !== after.get(file));
  const typeExportOk = task.id !== 'package-versions' || !changed.includes('src/application/index.ts') || after.has('src/application/index.ts') && after.has('src/packages/registry.ts') && companionTypeExportOnly(
    await readFile(path.join(source, 'src/application/index.ts'), 'utf8'),
    await readFile(path.join(workspace, 'src/application/index.ts'), 'utf8'),
    await readFile(path.join(workspace, 'src/packages/registry.ts'), 'utf8'));
  const scopeOk = typeExportOk && changed.every(file => task.allowed.includes(file) || (task.allowNewTests && !baseline.has(file) && /^tests\/[^/]+\.test\.ts$/.test(file)));
  const completed = outcome.status === 'completed' && Boolean(outcome.text?.trim());
  if (task.id === 'onboarding') {
    const text = await readFile(path.join(workspace, 'REPORT.md'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const rules = [
      ['implemented package distribution', /(?:ZIP|zip)/.test(text) && /CAPABILITY\.json/.test(text) && /(?:导入|import)/.test(text)],
      ['inert import and explicit dependency preparation', /ignore-scripts/.test(text) && /(?:导入[^。\n]{0,100}(?:不|不会)[^。\n]{0,60}(?:执行|启动|安装)|(?:不|不会)[^。\n]{0,60}(?:执行|启动|安装)[^。\n]{0,80}导入)/.test(text)],
      ['native sandbox backends and explicit activation', /AppContainer|LPAC/.test(text) && /bubblewrap|bwrap/.test(text) && /sandbox-exec/.test(text) && /--sandbox/.test(text)],
      ['platform limits and validation scope', /(?:一个|单个|仅一|唯一|single)[^。\n]{0,40}(?:写|writer)|(?:写[^。\n]{0,40}(?:互斥|一个|单个|仅一|唯一))/.test(text) && /(?:macOS|Mac)[^。\n]{0,100}(?:禁止|不允许)[^。\n]{0,40}(?:子进程|派生|fork)/.test(text) && /(?:Linux|macOS)[^。\n]{0,120}(?:未|尚未|没有)[^。\n]{0,30}(?:验证|实测)/.test(text)],
      ['write permission and unknown-write recovery', /--allow-write|write.*授权|写.*权限/.test(text) && /UNKNOWN_WRITE|未知写入|不确定写入/.test(text) && /reconcile|resolve|核实/.test(text)],
      ['remote MCP credentials and immutable running version', /(?:凭据|环境变量)/.test(text) && /(?:绑定|bind)/.test(text) && /(?:回滚|rollback|adopt)/.test(text) && /(?:旧|已有|现有|正在)[^。\n]{0,45}(?:运行|实例)/.test(text)],
    ];
    const references = [...new Set(text.match(/(?:src|docs|examples)\/[A-Za-z0-9_./-]+\.(?:ts|md|json|cs|mjs)/g) ?? [])];
    const validReferences = references.filter(file => after.has(file));
    const citations = validReferences.length >= 6 && validReferences.filter(file => file.startsWith('src/')).length >= 3;
    const commands = supportedVerificationCommands(text);
    const criteria = [...rules.map(([name, passed]) => ({ name, passed })), { name: 'six valid source references including three code files', passed: citations }, { name: 'three supported verification commands', passed: commands.length >= 3 }, { name: 'scope unchanged except report', passed: scopeOk }, { name: 'completed nonempty final delivery', passed: completed }];
    const automaticPassed = criteria.every(item => item.passed);
    return { passed: automaticPassed, automaticPassed, score: rules.filter(([, passed]) => passed).length * 10 + Number(citations) * 20 + Number(commands.length >= 3) * 10 + Number(scopeOk) * 10, coverage: criteria.filter(item => item.passed).length / criteria.length, criteria, changed, references: validReferences, commands, manualFactualReviewRequired: true };
  }
  // Rebuild from frozen dependencies/config/tests and only accepted implementation changes.
  // Model-edited test runners and evaluator files cannot turn a wrong implementation green.
  const isolated = path.join(directory, 'independent-workspace'); await cp(source, isolated, { recursive: true });
  for (const file of changed.filter(file => task.allowed.includes(file) || (task.allowNewTests && !baseline.has(file) && /^tests\/[^/]+\.test\.ts$/.test(file)))) {
    if (after.has(file)) await cp(path.join(workspace, file), path.join(isolated, file));
  }
  const build = await execute(process.execPath, [path.join(repository, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], isolated, path.join(directory, 'independent-build.json'));
  const oracle = build.code === 0 ? await runOracle(isolated, directory, task) : { checks: [...(task.id === 'pagination' ? paginationOracle : versionsOracle).matchAll(/await check\('([^']+)'/g)].map(match => ({ name: match[1], passed: false, error: 'Independent build failed' })) };
  const filter = task.id === 'pagination' ? ['tests/context.test.ts', 'tests/context-hardening.test.ts'] : ['tests/package-archive.test.ts', 'tests/package-runtime.test.ts', 'tests/application-packages.test.ts', 'tests/cli-packages.test.ts', 'tests/package-versions.test.ts'];
  const regression = await execute(process.execPath, [path.join(repository, 'node_modules/vitest/vitest.mjs'), 'run', ...filter], isolated, path.join(directory, 'independent-tests.json'));
  const typecheck = await execute(process.execPath, [path.join(repository, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json'], isolated, path.join(directory, 'independent-typecheck.json'));
  const lint = await execute(process.execPath, [path.join(repository, 'node_modules/eslint/bin/eslint.js'), 'src', 'tests', 'scripts'], isolated, path.join(directory, 'independent-lint.json'));
  const newTests = !task.allowNewTests || after.has('tests/package-versions.test.ts') && !baseline.has('tests/package-versions.test.ts');
  const criteria = [...oracle.checks, { name: 'existing and required tests pass', passed: regression.code === 0 && /Tests\s+\d+ passed/.test(stripVTControlCharacters(regression.stdout)) && newTests }, { name: 'typecheck and lint pass', passed: typecheck.code === 0 && lint.code === 0 }, { name: 'only permitted files changed', passed: scopeOk }, { name: 'completed nonempty final delivery', passed: completed }];
  return { passed: criteria.every(item => item.passed), score: 60 * oracle.checks.filter(item => item.passed).length / oracle.checks.length + Number(criteria.at(-4).passed) * 10 + Number(criteria.at(-3).passed) * 10 + Number(scopeOk) * 10 + Number(completed) * 10,
    coverage: criteria.filter(item => item.passed).length / criteria.length, criteria, changed, oracle, build, regression, typecheck, lint, isolatedWorkspace: isolated };
}
