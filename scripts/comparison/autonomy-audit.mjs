import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { tasks, assessTask } from './autonomy-fixtures.mjs';

// Keep the experiment's original outputs and hashes. Correct only the external
// oracle: get()/has()/size() need not physically remove expired entries under SPEC.md.
export function contractTask(task) {
  if (task.id !== 'independent') return task;
  const before = "check(c.get('a'),undefined); c.set('b'";
  if (!task.oracle.includes(before)) throw new Error('original oracle mismatch');
  // Invalid TTL must be rejected, but SPEC does not mandate an Error subclass.
  return { ...task, oracle: task.oracle.replace(before, "check(c.get('a'),undefined); c.sweep(); c.set('b'").replace('check(c.size(),0);', 'check(c.size(),0); c.sweep();').replace('threw=e instanceof RangeError', 'threw=true') };
}

export async function audit(root) {
  const rows = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    let row;
    try { row = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const task = tasks.find(task => task.id === row.task);
    if (!task) continue;
    const auditDirectory = path.join(directory, 'contract-audit');
    await mkdir(auditDirectory, { recursive: true });
    const verification = await assessTask(path.join(directory, 'workspace'), contractTask(task), auditDirectory);
    // User asked for additional tests without restricting them to smoke.test.mjs.
    const unexpected = verification.unexpected.filter(name => !/^[\w.-]+\.test\.mjs$/.test(name));
    verification.scopeRespected = verification.changed.every(name => task.allowed.includes(name)) && !unexpected.length;
    verification.unexpected = unexpected;
    const record = { group: row.group, repeat: row.repeat, task: row.task, originalPassed: row.passed, passed: row.status === 'completed' && verification.passed && verification.scopeRespected && row.testsRunByAgent, verification, reason: 'SPEC does not require eager deletion by get/has/size or a particular invalid-TTL Error subclass; explicitly sweep expired setup entries before testing the next deletion count. New *.test.mjs files are legitimate requested regression tests. No model reruns or original evidence edits.' };
    await writeFile(path.join(auditDirectory, 'result.json'), JSON.stringify(record, null, 2), 'utf8');
    rows.push(record);
  }
  await writeFile(path.join(root, 'contract-audit.json'), JSON.stringify(rows, null, 2), 'utf8');
  return rows;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const rows = await audit(path.resolve(process.argv[2]));
  console.log(JSON.stringify({ audited: rows.length, passed: rows.filter(row => row.passed).length, corrections: rows.filter(row => row.passed !== row.originalPassed).map(row => `${row.task}/${row.group}/${row.repeat}`) }));
}
