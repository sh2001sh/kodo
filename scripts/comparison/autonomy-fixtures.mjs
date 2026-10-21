import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const execute = promisify(execFile);
const independent = {
  'cache.mjs': `export class Cache {
  constructor(clock = Date.now) { this.clock = clock; this.entries = new Map(); }
  set(key, value, ttl) {
    if (ttl < 0) throw new RangeError('ttl');
    this.entries.set(key, { value, deadline: ttl ? this.clock() + ttl : Infinity });
    return this;
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.deadline < this.clock()) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
  has(key) { return this.get(key) !== undefined; }
  sweep() { let count = 0; for (const key of this.entries.keys()) if (!this.has(key)) count++; return count; }
  size() { this.sweep(); return this.entries.size; }
}
`,
  'ledger.mjs': `export function summarize(rows) {
  const seen = new Set();
  const groups = {};
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (!Number.isFinite(row.amount) || row.amount < 0) continue;
    const key = row.account.trim().toLowerCase();
    const current = groups[key] || { account: key, credits: 0, debits: 0, count: 0 };
    if (row.kind === 'credit') current.credits += row.amount;
    else current.debits += row.amount;
    current.count++;
    groups[key] = current;
  }
  return Object.values(groups).map(row => ({ ...row, balance: row.credits - row.debits }));
}
`,
  'smoke.test.mjs': `import { test } from 'node:test'; import assert from 'node:assert/strict';
import { Cache } from './cache.mjs'; import { summarize } from './ledger.mjs';
test('basic cache', () => { const c = new Cache(() => 0); c.set('a', 1, 5); assert.equal(c.get('a'), 1); });
test('basic ledger', () => assert.equal(summarize([{id:'1',account:'A',kind:'credit',amount:2}])[0].balance,2));
`,
};
const contract = {
  'keys.mjs': `export function canonicalKey(value) { return String(value).trim().toLowerCase(); }
`,
  'catalog.mjs': `import { canonicalKey } from './keys.mjs';
export function mergeCatalog(rows) {
  const byKey = new Map();
  for (const row of rows) byKey.set(canonicalKey(row.key), row);
  return [...byKey.values()];
}
`,
  'lookup.mjs': `import { canonicalKey } from './keys.mjs';
export function lookup(rows, key) { return rows.find(row => canonicalKey(row.key) === canonicalKey(key)); }
`,
  'smoke.test.mjs': `import { test } from 'node:test'; import assert from 'node:assert/strict';
import { canonicalKey } from './keys.mjs'; import { lookup } from './lookup.mjs';
test('ordinary key',()=>assert.equal(canonicalKey(' A '),'a'));
test('ordinary lookup',()=>assert.equal(lookup([{key:' A ',label:'yes'}],'a').label,'yes'));
`,
};
export const tasks = [
  { id: 'independent', files: independent, allowed: ['cache.mjs', 'ledger.mjs', 'smoke.test.mjs'], opportunity: 'Two modules have separate contracts and no imports between them; implementation or independent adversarial verification can be split without shared writes.',
    objective: '修复 cache.mjs 和 ledger.mjs 中违反 SPEC.md 的行为，并补充回归测试。两个模块互不依赖。保持公开导出不变，不引入依赖；执行测试，交付实际修改与验证结果。',
    spec: `Cache: accepts any Map key and value including undefined. ttl must be a finite nonnegative number, omitted means Infinity. ttl=0 expires immediately. Entry is expired when now>=deadline. has distinguishes stored undefined from missing. sweep deletes expired entries and returns the number deleted, never counts live undefined entries. size counts live entries. Reject invalid ttl before overwriting an existing entry. No serialization of values.
Ledger: summarize(rows) must not mutate input. Accept only rows with a nonempty string id, nonempty string account (after trim), finite nonnegative numeric amount and kind exactly credit/debit. Skip invalid rows before consuming id. Deduplicate globally by the original case-sensitive id: first VALID row wins. Account is trim().toLowerCase(); any string including __proto__ and constructor is valid. Return groups in first valid account appearance order with {account,credits,debits,count,balance}. Empty input returns [].
`,
    oracle: `const {Cache}=await import(candidate('cache.mjs')); const {summarize}=await import(candidate('ledger.mjs'));
let now=10; const c=new Cache(()=>now); c.set('a',1,0); check(c.get('a'),undefined); c.set('b',undefined,5); check(c.has('b'),true); check(c.sweep(),0); now=15; check(c.has('b'),false); check(c.size(),0);
c.set('u',undefined); now=999999; check(c.has('u'),true); c.set('e',2,1); now++; check(c.sweep(),1); check(c.size(),1);
for(const ttl of [-1,NaN,Infinity,'2',null]) { let threw=false; try{c.set('u','bad',ttl)}catch(e){threw=e instanceof RangeError} check(threw,true);check(c.has('u'),true);check(c.get('u'),undefined); }
const key={};c.set(key,{v:3});check(c.get(key),{v:3});check(c.get({}),undefined);
const rows=[{id:'x',account:'A',amount:8,kind:'typo'},{id:'x',account:' A ',amount:3,kind:'credit'},{id:'x',account:'B',amount:100,kind:'debit'},{id:'y',account:'__proto__',amount:2,kind:'debit'},{id:'z',account:'constructor',amount:0,kind:'credit'},{id:'q',account:'a',amount:1,kind:'debit'}];
const before=JSON.stringify(rows);check(summarize(rows),[{account:'a',credits:3,debits:1,count:2,balance:2},{account:'__proto__',credits:0,debits:2,count:1,balance:-2},{account:'constructor',credits:0,debits:0,count:1,balance:0}]);check(JSON.stringify(rows),before);check(summarize([]),[]);
for(const row of [null,{}, {id:'',account:'a',amount:1,kind:'credit'}, {id:1,account:'a',amount:1,kind:'credit'}, {id:'a',account:' ',amount:1,kind:'credit'}, {id:'a',account:2,amount:1,kind:'credit'}, {id:'a',account:'a',amount:NaN,kind:'credit'}, {id:'a',account:'a',amount:'1',kind:'credit'}, {id:'a',account:'a',amount:-1,kind:'debit'}]) check(summarize([row]),[]);
check(summarize([{id:'x',account:'2',kind:'credit',amount:1},{id:'y',account:'1',kind:'credit',amount:1}]).map(x=>x.account),['2','1']);
` },
  { id: 'contract', files: contract, allowed: ['keys.mjs', 'catalog.mjs', 'lookup.mjs', 'smoke.test.mjs'], opportunity: 'The canonical key contract comes first; catalog integration, lookup integration or test design can then proceed independently with an explicit shared contract.',
    objective: '按 SPEC.md 更新统一键语义，使 keys.mjs、catalog.mjs、lookup.mjs 行为一致。修复实现并补充覆盖三个模块的测试，保持导出函数签名，无外部依赖；执行验证并报告结果。',
    spec: `canonicalKey(value): only string input; trim, Unicode NFKC normalize, toLowerCase; if resulting string is empty return null; all non-string values return null without stringification or throwing. Whitespace inside a key is preserved.
mergeCatalog(rows): skip null/malformed rows and keys canonicalizing to null. Return NEW objects { ...firstRow, key: canonicalKey(firstRow.key) }, preserving first valid canonical key order; first row wins for duplicates. Do not mutate input.
lookup(rows,key): invalid query returns undefined; skip malformed/invalid rows and return original first matching row (identity retained). All modules must use the same canonicalKey contract. Include Unicode compatibility, invalid values and duplicate precedence in tests.
`,
    oracle: `const {canonicalKey:k}=await import(candidate('keys.mjs')); const {mergeCatalog:m}=await import(candidate('catalog.mjs'));const {lookup:l}=await import(candidate('lookup.mjs'));
for(const [input,want] of [[' A ','a'],['Ａ','a'],[' K ','k'],[' A  B ','a  b'],['',null],['   ',null],[null,null],[undefined,null],[4,null],[{},null],[['A'],null]])check(k(input),want);
const first={key:' Ａ ',label:'first',nested:{x:1}}, duplicate={key:'a',label:'last'}, second={key:'B',label:'b'};const rows=[null,{}, {key:4},first,duplicate,second];const before=JSON.stringify(rows);
check(m(rows),[{...first,key:'a'},{...second,key:'b'}]);check(JSON.stringify(rows),before);check(m(rows)[0]===first,false);check(l(rows,'A')===first,true);check(l(rows,'Ｂ')===second,true);
for(const key of [null,undefined,4,{},'  ','missing'])check(l(rows,key),undefined);check(m([]),[]);check(l([], 'a'),undefined);
` },
  { id: 'small', files: { 'config.mjs': `export function parsePort(value) { return Number(value) || 8080; }\n`, 'smoke.test.mjs': `import { test } from 'node:test';import assert from 'node:assert/strict';import {parsePort} from './config.mjs';test('normal port',()=>assert.equal(parsePort('3000'),3000));\n` }, allowed: ['config.mjs', 'smoke.test.mjs'], opportunity: 'One small isolated function; coordination is unlikely to pay for itself.',
    objective: '修复 config.mjs 的 parsePort：undefined 或空字符串使用默认 8080；其它值只接受 1..65535 的整数或只含十进制数字的字符串（可有首尾空白）。其它输入抛 RangeError，不使用隐式对象转换。补充边界测试并运行，保持改动精简。', spec: 'One isolated function; preserve export parsePort(value). No dependencies.',
    oracle: `const {parsePort:p}=await import(candidate('config.mjs')); for(const [v,w] of [[undefined,8080],['',8080],[1,1],[65535,65535],[' 3000 ',3000],['0001',1]])check(p(v),w);for(const v of [null,false,true,0,65536,1.1,-1,NaN,Infinity,{},[], ' ', '0','-1','1.0','1e3','0x10','a']){let threw=false;try{p(v)}catch(e){threw=e instanceof RangeError}check(threw,true);}` },
];

export async function prepareTask(directory, task) {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries({ ...task.files, 'SPEC.md': task.spec })) await writeFile(path.join(directory, name), content, 'utf8');
}
export async function assessTask(workspace, task, outputDirectory) {
  const file = path.join(outputDirectory, 'acceptance.mjs');
  await writeFile(file, `import assert from 'node:assert/strict';\nlet count=0;const check=(a,b)=>{assert.deepEqual(a,b);count++};const candidate=name=>${JSON.stringify(pathToFileURL(workspace + path.sep).href)}+name;\n${task.oracle}\nconsole.log('ACCEPTANCE PASS '+count);`, 'utf8');
  let output;
  try { const result = await execute(process.execPath, [file], { cwd: outputDirectory, env: { SystemRoot: process.env.SystemRoot }, maxBuffer: 1024 * 1024 }); output = { passed: true, ...result }; }
  catch (error) { output = { passed: false, exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; }
  const changed = [];
  for (const [name, source] of Object.entries({ ...task.files, 'SPEC.md': task.spec })) {
    let content; try { content = await readFile(path.join(workspace, name), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (content !== source) changed.push(name);
  }
  // Scope also includes newly created files; hidden tests stay outside this workspace.
  const { readdir } = await import('node:fs/promises');
  const unexpected = (await readdir(workspace)).filter(name => ![...Object.keys(task.files), 'SPEC.md'].includes(name));
  return { ...output, changed, unexpected, scopeRespected: changed.every(name => task.allowed.includes(name)) && !unexpected.length };
}
