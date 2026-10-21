import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { tasks, prepareTask, assessTask } from './autonomy-fixtures.mjs';
import { contractTask } from './autonomy-audit.mjs';

const reference = {
  independent: {
    'cache.mjs': `export class Cache {
constructor(clock=Date.now){this.clock=clock;this.entries=new Map()}
set(k,v,ttl){if(ttl!==undefined&&(!Number.isFinite(ttl)||ttl<0))throw new RangeError('ttl');this.entries.set(k,{value:v,deadline:ttl===undefined?Infinity:this.clock()+ttl});return this}
live(k){const e=this.entries.get(k);if(e&&this.clock()>=e.deadline){this.entries.delete(k);return undefined}return e}
get(k){return this.live(k)?.value}has(k){return this.live(k)!==undefined}
sweep(){let n=0;for(const k of this.entries.keys())if(!this.live(k))n++;return n}size(){this.sweep();return this.entries.size}}
`,
    'ledger.mjs': `export function summarize(rows){const ids=new Set(),groups=new Map();for(const r of rows){if(!r||typeof r.id!=='string'||!r.id||typeof r.account!=='string'||!r.account.trim()||!Number.isFinite(r.amount)||r.amount<0||!['credit','debit'].includes(r.kind)||ids.has(r.id))continue;ids.add(r.id);const a=r.account.trim().toLowerCase();let v=groups.get(a);if(!v){v={account:a,credits:0,debits:0,count:0};groups.set(a,v)}v[r.kind==='credit'?'credits':'debits']+=r.amount;v.count++}return [...groups.values()].map(v=>({...v,balance:v.credits-v.debits}))}
`,
  },
  contract: {
    'keys.mjs': `export function canonicalKey(v){return typeof v==='string'?(v.trim().normalize('NFKC').toLowerCase()||null):null}
`,
    'catalog.mjs': `import {canonicalKey}from './keys.mjs';export function mergeCatalog(rows){const m=new Map();for(const row of rows){const key=canonicalKey(row?.key);if(key!==null&&!m.has(key))m.set(key,{...row,key})}return [...m.values()]}
`,
    'lookup.mjs': `import {canonicalKey}from './keys.mjs';export function lookup(rows,q){const key=canonicalKey(q);if(key===null)return undefined;return rows.find(r=>canonicalKey(r?.key)===key)}
`,
  },
  small: { 'config.mjs': `export function parsePort(v){if(v===undefined||v==='')return 8080;if(typeof v==='string'&&/^\\s*[0-9]+\\s*$/.test(v))v=Number(v);if(typeof v!=='number'||!Number.isInteger(v)||v<1||v>65535)throw new RangeError('port');return v}
` },
};

for (const task of tasks) test(`hidden ${task.id} oracle rejects original defects and accepts a contract-compliant implementation`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-autonomy-oracle-'));
  try {
    const workspace = path.join(directory, 'workspace');
    await prepareTask(workspace, task);
    const negativeDirectory = path.join(directory, 'negative'); await mkdir(negativeDirectory);
    assert.equal((await assessTask(workspace, task, negativeDirectory)).passed, false);
    for (const [name, content] of Object.entries(reference[task.id])) await writeFile(path.join(workspace, name), content, 'utf8');
    const positiveDirectory = path.join(directory, 'positive'); await mkdir(positiveDirectory);
    const result = await assessTask(workspace, task, positiveDirectory);
    assert.equal(result.passed, true, result.stderr);
    assert.equal(result.scopeRespected, true);
    assert.match(result.stdout, /ACCEPTANCE PASS [1-9]\d*/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('contract audit accepts lazy expiration cleanup and invalid-TTL TypeError while still rejecting original defects', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-expiration-contract-'));
  try {
    const task = contractTask(tasks.find(task => task.id === 'independent'));
    const workspace = path.join(directory, 'workspace');
    await prepareTask(workspace, task);
    const negative = path.join(directory, 'negative'); await mkdir(negative);
    assert.equal((await assessTask(workspace, task, negative)).passed, false);
    for (const [name, content] of Object.entries(reference.independent)) await writeFile(path.join(workspace, name), name === 'cache.mjs' ? content.replace('this.entries.delete(k);return undefined', 'return undefined').replace('if(!this.live(k))n++', 'if(!this.live(k)){this.entries.delete(k);n++}').replace("new RangeError('ttl')", "new TypeError('ttl')").replace('size(){this.sweep();return this.entries.size}', 'size(){return [...this.entries.values()].filter(e=>this.clock()<e.deadline).length}') : content, 'utf8');
    const positive = path.join(directory, 'positive'); await mkdir(positive);
    const result = await assessTask(workspace, task, positive);
    assert.equal(result.passed, true, result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
