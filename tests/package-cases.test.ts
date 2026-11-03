import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PackageRegistry } from '../src/packages/registry.js';
import { exportPackage } from '../src/packages/archive.js';
import { Store } from '../src/storage/index.js';
import { CaseRunStore, caseDigest, runCase } from '../src/cases/index.js';
import type { CaseDefinition, CaseRun, RunCaseOptions } from '../src/cases/index.js';

const cleanup: string[] = []; const stores: Store[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const directory of cleanup.splice(0)) await rm(directory, { force: true, recursive: true }); });
async function directory(): Promise<string> { const result = await mkdtemp(path.join(os.tmpdir(), 'kodo-package-cases-')); cleanup.push(result); return result; }
const definition: CaseDefinition = { schema_version: 1, id: 'quality/output', version: '1.0.0', name: 'Output check', objective: 'Return verified.', inputs: { files: [] }, assertions: [{ type: 'output', equals: 'verified' }] };
async function fixture(): Promise<{ registry: PackageRegistry; evidence: CaseRunStore; run: (version: string, options?: Partial<RunCaseOptions>) => Promise<CaseRun> }> {
  const registry = new PackageRegistry(await directory());
  for (const version of ['1.0.0', '2.0.0']) {
    const source = await directory();
    await writeFile(path.join(source, 'AGENT.md'), `---\nschema_version: 1\nid: example/verified\nversion: ${version}\nname: Verified agent\ndescription: Case verification fixture.\ncapabilities:\n  tools: []\n---\nReturn verified.\n`);
    const archive = path.join(await directory(), 'package.zip');
    await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.com/verified' }, files: [{ path: 'AGENT.md', distributable: true }] }, archive);
    await registry.import(archive);
  }
  const storage = new Store(await directory()); stores.push(storage); const evidence = new CaseRunStore(storage);
  return { registry, evidence, run: async (version, overrides = {}) => {
    const installed = await registry.inspect('example/verified', version);
    return await runCase({ store: evidence, definition, target: { id: installed.card.id, version, digest: installed.digest, cardDigest: installed.card.digest }, binding: { model: 'fixture', baseURL: 'http://localhost', apiKeyEnv: 'UNUSED' }, permissions: ['read'], hostPolicyDigest: caseDigest('fixture'), workspace: await directory(), execute: async () => ({ status: 'completed', output: 'verified' }), ...overrides });
  } };
}
describe('case evidence based package adoption', () => {
  it('adopts a first verified version, compares the candidate and uses new passing runs for verified rollback', async () => {
    const { registry, evidence, run } = await fixture();
    const first = await run('1.0.0');
    expect((await registry.adoptVerified('example/verified', '1.0.0', { store: evidence, runIds: [first.id], requiredCases: [{ id: definition.id, version: definition.version }] })).verification?.runIds).toEqual([first.id]);
    const next = await run('2.0.0');
    const pointer = await registry.adoptVerified('example/verified', '2.0.0', { store: evidence, runIds: [next.id] });
    expect(pointer.previous?.version).toBe('1.0.0'); expect(pointer.verification?.comparedRunIds).toEqual([first.id]);
    const checkedAgain = await run('1.0.0');
    expect((await registry.rollbackVerified('example/verified', { store: evidence, runIds: [checkedAgain.id] })).version).toBe('1.0.0');
  });
  it('rejects missing, failed, mismatched model and forged package/card evidence', async () => {
    const { registry, evidence, run } = await fixture();
    await expect(registry.adoptVerified('example/verified', '1.0.0', { store: evidence, runIds: [] })).rejects.toThrow('requires');
    const failed = await run('1.0.0', { execute: async () => ({ status: 'completed', output: 'incorrect' }) });
    await expect(registry.adoptVerified('example/verified', '1.0.0', { store: evidence, runIds: [failed.id] })).rejects.toThrow('failed');
    const first = await run('1.0.0'); await registry.adoptVerified('example/verified', '1.0.0', { store: evidence, runIds: [first.id] });
    const differentModel = await run('2.0.0', { binding: { model: 'different', baseURL: 'http://localhost', apiKeyEnv: 'UNUSED' } });
    await expect(registry.adoptVerified('example/verified', '2.0.0', { store: evidence, runIds: [differentModel.id], conditionsDigest: first.conditionsDigest })).rejects.toThrow('conditions differ');
    await expect(registry.adoptVerified('example/verified', '2.0.0', { store: evidence, runIds: [differentModel.id] })).rejects.toThrow('baseline');
    const forged = await run('2.0.0', { target: { id: 'example/verified', version: '2.0.0', digest: caseDigest('forged'), cardDigest: caseDigest('forged card') } });
    await expect(registry.adoptVerified('example/verified', '2.0.0', { store: evidence, runIds: [forged.id] })).rejects.toThrow('digest');
    expect((await registry.current('example/verified'))?.version).toBe('1.0.0');
  });
  it('rejects regressions and prevents selecting old passing evidence after a newer failure', async () => {
    const { registry, evidence, run } = await fixture();
    const first = await run('1.0.0'); await registry.adoptVerified('example/verified', '1.0.0', { store: evidence, runIds: [first.id] });
    const next = await run('2.0.0');
    await run('2.0.0', { execute: async () => ({ status: 'completed', output: 'regressed' }) });
    await expect(registry.adoptVerified('example/verified', '2.0.0', { store: evidence, runIds: [next.id] })).rejects.toThrow('superseded');
    expect((await registry.current('example/verified'))?.version).toBe('1.0.0');
  });
  it('requires coverage of the current version cases and rejects changed case identities/conditions', async () => {
    const { registry, evidence, run } = await fixture();
    const first = await run('1.0.0');
    await run('1.0.0', { definition: { ...definition, id: 'quality/extra' } });
    await registry.adopt('example/verified', '1.0.0');
    const next = await run('2.0.0');
    await expect(registry.adoptVerified('example/verified', '2.0.0', { store: evidence, runIds: [next.id] })).rejects.toThrow('coverage');
    await expect(registry.adoptVerified('example/verified', '2.0.0', { store: evidence, runIds: [next.id], requiredCases: [{ id: 'quality/missing', version: '1.0.0' }] })).rejects.toThrow('required');
    const changed = await run('2.0.0', { definition: { ...definition, version: '2.0.0' } });
    await expect(registry.adoptVerified('example/verified', '2.0.0', { store: evidence, runIds: [changed.id] })).rejects.toThrow('coverage');
    expect(first.inputDigest).toBe(next.inputDigest);
  });
  it('rechecks imported package bytes before moving the pointer', async () => {
    const { registry, evidence, run } = await fixture(); const candidate = await run('1.0.0');
    const installed = await registry.inspect('example/verified', '1.0.0');
    await writeFile(path.join(installed.root, 'AGENT.md'), 'tampered source');
    await expect(registry.adoptVerified('example/verified', '1.0.0', { store: evidence, runIds: [candidate.id] })).rejects.toThrow();
  });
});
