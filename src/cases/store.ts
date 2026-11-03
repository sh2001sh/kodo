import type { Store } from '../storage/index.js';
import type { CaseRecords } from '../storage/case-records.js';
import { KodoError } from '../runtime/types.js';
import type { FileScope, ModelBinding, Permission } from '../runtime/types.js';
import { caseDigest, canonicalJson, freezeCase } from './schema.js';
import type { CaseDefinition } from './schema.js';

export interface CaseTarget { id: string; version: string; digest: string; cardDigest: string }
export interface CaseConditions {
  model: Omit<ModelBinding, 'apiKeyEnv'>;
  environment: { platform: string; arch: string; node: string; label?: string };
  permissions: Permission[]; scope?: FileScope; policyDigest: string;
}
export interface AssertionEvidence { index: number; passed: boolean; detail: string; actualDigest?: string }
export interface CaseRun {
  id: string; case: CaseDefinition; caseDigest: string; inputDigest: string; target: CaseTarget;
  conditions: CaseConditions; conditionsDigest: string; workspace: string;
  status: 'running' | 'passed' | 'failed' | 'interrupted'; startedAt: string; completedAt?: string;
  execution?: { runId?: string; status: string; outputDigest: string };
  assertions: AssertionEvidence[]; error?: string;
}
export interface CaseRunList { targetId?: string; version?: string; status?: CaseRun['status']; after?: number; limit?: number }
/** Evidence lives in the application's database; failed and interrupted runs remain inspectable. */
export class CaseRunStore {
  private readonly records: CaseRecords;
  constructor(store: Store) {
    this.records = store.cases;
    this.records.ensure();
  }
  start(run: CaseRun): void {
    if (run.status !== 'running' || run.completedAt || run.assertions.length) throw new KodoError('CASE_EVIDENCE', 'case evidence must start before execution');
    this.validate(run);
    const data = canonicalJson(run);
    this.records.start({ id: run.case.id, version: run.case.version, digest: run.caseDigest },
      { id: run.id, targetId: run.target.id, targetVersion: run.target.version, caseDigest: run.caseDigest, conditionsDigest: run.conditionsDigest, status: run.status, data, evidenceDigest: caseDigest(run) },
      previous => { if (previous && previous !== run.caseDigest) throw new KodoError('CASE_CONFLICT', 'case version is immutable; increment the version when inputs or assertions change'); });
  }
  finish(run: CaseRun): void {
    const previous = this.get(run.id);
    if (previous.status !== 'running' || run.status === 'running' || !run.completedAt || canonicalJson({ ...previous, status: run.status, completedAt: run.completedAt, assertions: run.assertions, ...(run.execution ? { execution: run.execution } : {}), ...(run.error ? { error: run.error } : {}) }) !== canonicalJson(run)) throw new KodoError('CASE_EVIDENCE', 'only a running case may acquire final execution evidence');
    this.validate(run);
    if (!this.records.finish(run.id, run.status, canonicalJson(run), caseDigest(run))) throw new KodoError('CASE_EVIDENCE', 'case evidence changed while finalizing');
  }
  /** Link before driving a model run so crashes and deadlines retain its original evidence. */
  attachExecution(id: string, runId: string): CaseRun {
    const previous = this.get(id);
    if (previous.status !== 'running' || previous.execution || !runId || runId.length > 200) throw new KodoError('CASE_EVIDENCE', 'a running case may attach one execution identity before completion');
    const run: CaseRun = { ...previous, execution: { runId, status: 'running', outputDigest: caseDigest('') } };
    this.validate(run);
    if (!this.records.replaceRunning(id, canonicalJson(run), caseDigest(run), caseDigest(previous))) throw new KodoError('CASE_EVIDENCE', 'case evidence changed while attaching execution');
    return run;
  }
  get(id: string): CaseRun {
    const row = this.records.get(id);
    if (!row) throw new KodoError('CASE_NOT_FOUND', 'case run does not exist');
    return this.decode(row);
  }
  list(options: CaseRunList = {}): { items: CaseRun[]; next: number | null } {
    const { limit = 100, after = 0 } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(after) || after < 0) throw new KodoError('CASE_BOUNDS', 'case pagination requires limit 1..1000 and nonnegative after');
    const rows = this.records.list({ targetId: options.targetId, version: options.version, status: options.status, after, fetch: limit + 1 });
    return { items: rows.slice(0, limit).map(row => this.decode(row)), next: rows.length > limit ? rows[limit - 1]!.seq : null };
  }
  /** The host calls this only after establishing that the prior process is no longer running. */
  interruptRunning(): number {
    let after = 0; let changed = 0;
    for (;;) {
      const page = this.list({ status: 'running', after, limit: 1000 });
      for (const run of page.items) { this.finish({ ...run, status: 'interrupted', completedAt: new Date().toISOString(), error: 'execution ended without final evidence; rerun explicitly' }); changed++; }
      if (page.next === null) return changed;
      after = page.next;
    }
  }
  private decode(row: { data: string; evidence_digest: string }): CaseRun {
    const run = JSON.parse(row.data) as CaseRun;
    if (caseDigest(run) !== row.evidence_digest) throw new KodoError('CASE_EVIDENCE', 'stored case evidence digest does not match');
    this.validate(run); return run;
  }
  private validate(run: CaseRun): void {
    const frozen = freezeCase(run.case);
    if (frozen.digest !== run.caseDigest || frozen.inputDigest !== run.inputDigest || caseDigest(run.conditions) !== run.conditionsDigest) throw new KodoError('CASE_EVIDENCE', 'case definition, inputs or execution conditions changed');
    if (!/^[a-f0-9]{64}$/.test(run.target.digest) || !/^[a-f0-9]{64}$/.test(run.target.cardDigest) || !/^[a-f0-9]{64}$/.test(run.conditions.policyDigest)) throw new KodoError('CASE_EVIDENCE', 'package, card and policy digests are required');
    if (run.status === 'passed' && (!run.execution || run.execution.status !== 'completed' || run.error || run.assertions.length !== run.case.assertions.length || run.assertions.some((item, index) => item.index !== index || !item.passed))) throw new KodoError('CASE_EVIDENCE', 'passed evidence requires completed execution and all assertions');
  }
}
