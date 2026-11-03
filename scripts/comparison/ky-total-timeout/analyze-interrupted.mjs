// Offline-only analysis for a trial whose runner was forcibly stopped.

import console from 'node:console';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { auditWorkspace } from './oracle.mjs';
import { protectedSnapshot } from './fixture.mjs';
import { finalText, sessionUsage, writeJson } from '../v3-eval-common.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outputArg = process.argv[2];
const cell = process.argv[3];
if (!outputArg || !cell) throw new Error('usage: analyze-interrupted.mjs <matrix-output> <cell>');
const output = path.resolve(outputArg);
const directory = path.join(output, cell);
const state = path.join(directory, 'state');
const workspace = path.join(directory, 'workspace');
if (!existsSync(path.join(state, 'kodo.sqlite')) || !existsSync(workspace)) throw new Error('interrupted cell state or workspace is missing');

const database = new Database(path.join(state, 'kodo.sqlite'), { readonly: true });
const persistedRuns = database.prepare('select data from runs').all().map(row => JSON.parse(row.data));
database.close();
const mainRecord = persistedRuns.find(run => !run.parentId);
if (!mainRecord) throw new Error('main run is missing');

const analysisRoot = mkdtempSync(path.join(tmpdir(), 'kodo-ky-interrupted-analysis-'));
const analysisState = path.join(analysisRoot, 'state');
cpSync(state, analysisState, { recursive: true });
rmSync(path.join(analysisState, 'owner.lock'), { force: true });
const { Application } = await import('../../../dist/application/index.js');
const app = new Application(analysisState, undefined, undefined, { exploration: false });
let report;
try {
  const main = app.store.run(mainRecord.id);
  const runs = app.store.listRuns(main.sessionId);
  const events = runs.flatMap(run => app.store.events(run.id));
  const calls = runs.flatMap(run => app.store.calls(run.id));
  const text = finalText(app.store, main);
  const audit = await auditWorkspace({ workspace, finalText: text });
  const base = protectedSnapshot(path.join(repoRoot, '.kodo', 'research', 'ky-total-timeout', 'base-template'));
  const current = protectedSnapshot(workspace);
  const protectedChanges = {
    added: Object.keys(current.files).filter(file => !(file in base.files)),
    removed: Object.keys(base.files).filter(file => !(file in current.files)),
    modified: Object.keys(base.files).filter(file => file in current.files && base.files[file] !== current.files[file]),
  };
  const wire = path.join(directory, 'wire');
  const requestFiles = readdirSync(wire).filter(name => /^request-\d+\.json$/u.test(name));
  const responseFiles = readdirSync(wire).filter(name => /^response-\d+\.sse$/u.test(name));
  report = {
    cell, interrupted: true, main: { id: main.id, status: main.status, step: main.step, error: main.error ?? null },
    runs: runs.map(run => ({ id: run.id, parentId: run.parentId ?? null, status: run.status, step: run.step, error: run.error ?? null, objective: run.objective })),
    usage: sessionUsage(app.store, main.sessionId),
    calls: { total: calls.length, model: calls.filter(call => call.kind === 'model').length, tool: calls.filter(call => call.kind === 'tool').length, running: calls.filter(call => call.status === 'running').length, unknown: calls.filter(call => call.status === 'unknown').length },
    wire: { requests: requestFiles.length, responses: responseFiles.length, completePairs: requestFiles.filter(name => responseFiles.includes(name.replace('request-', 'response-').replace('.json', '.sse'))).length },
    delegation: { children: runs.filter(run => run.parentId).length, childStatuses: runs.filter(run => run.parentId).map(run => run.status) },
    compaction: Object.fromEntries(['context.summary.started', 'context.summary.installed', 'context.summary.failed', 'context.summary.skipped', 'context.summary.disabled'].map(type => [type, events.filter(event => event.type === type).length])),
    audit, protectedChanges, finalText: text,
    note: 'Offline reconstruction after forced runner termination. Unknown calls are not priced as zero; this is not a completed matrix cell.',
  };
} finally { await app.shutdown(); rmSync(analysisRoot, { recursive: true, force: true }); }

await writeJson(path.join(directory, 'interrupted-report.json'), report, undefined);
console.log(JSON.stringify({ cell, main: report.main, usage: report.usage, calls: report.calls, wire: report.wire, delegation: report.delegation, compaction: report.compaction, auditPassed: report.audit.passed, protectedChanges: report.protectedChanges }, null, 2));

