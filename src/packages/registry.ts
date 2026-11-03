import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSandbox } from '../sandbox/execute.js';
import { validateSandboxResources } from '../sandbox/policy.js';
import type { SandboxResources } from '../sandbox/index.js';
import { KodoError } from '../runtime/types.js';
import { exportPackage, importPackage, inspectInstalledPackage, inspectPackage } from './archive.js';
import type { InstalledPackage } from './schema.js';
import { activatePackage, missingPackageBindings, packageToolDescriptors, packageCompatibility, validatePackageBindings, preparedTreeDigest } from './runtime.js';
import type { PackageActivationOptions, PackageBindings, PackageHost } from './runtime.js';
import type { Card } from '../runtime/types.js';
import { compareCaseRuns } from '../cases/runner.js';
import type { CaseRunStore, CaseRun } from '../cases/store.js';
export { validatePackageBindings } from './runtime.js';

export type PackageStatus = 'imported' | 'needs_configuration' | 'incompatible' | 'ready';
export interface PackageDiagnostic { status: PackageStatus; reasons: string[]; installed: InstalledPackage; preparedRoot?: string; preparedDigest?: string }
export interface PackagePointer { version: string; digest: string; previous?: { version: string; digest: string }; adoptedAt: string; verification?: { runIds: string[]; comparedRunIds: string[]; conditionsDigest: string } }
export interface VerifiedAdoptionOptions { store: CaseRunStore; runIds: string[]; conditionsDigest?: string; requiredCases?: { id: string; version: string }[] }
export interface PackageProvenance { importedAt: string; digest: string; source: { url: string; revision?: string }; archiveName: string }
const failure = (message: string): KodoError => new KodoError('PACKAGE_REGISTRY', message);
const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function identity(id: string, version?: string): void {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(id) || (version !== undefined && !/^\d+\.\d+\.\d+$/.test(version))) throw failure('invalid package identity');
}
async function readJson(file: string): Promise<unknown> { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw failure('invalid local package metadata'); } }
async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
/** Distribution storage is inert. Adopting changes a local pointer, never a running agent. */
export class PackageRegistry {
  readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }
  private packageRoot(id: string, version: string): string { identity(id, version); return path.join(this.root, 'packages', id, version); }
  private metadata(id: string, version: string, name: string): string { identity(id, version); return path.join(this.root, 'local', id, version, `${name}.json`); }
  async import(archivePath: string): Promise<InstalledPackage> {
    const incoming = await inspectPackage(archivePath);
    const pinned = await readJson(this.metadata(incoming.card.id, incoming.card.version, 'provenance'));
    if (pinned !== undefined && (!record(pinned) || pinned.digest !== incoming.digest)) throw failure('immutable package version conflicts with its pinned provenance');
    const installed = await importPackage(archivePath, this.root);
    const file = this.metadata(installed.card.id, installed.card.version, 'provenance');
    if (!(await readJson(file))) await atomicJson(file, { importedAt: new Date().toISOString(), digest: installed.digest, source: installed.manifest.source, archiveName: path.basename(archivePath) } satisfies PackageProvenance);
    return installed;
  }
  async inspect(id: string, version: string): Promise<InstalledPackage> {
    const installed = await inspectInstalledPackage(this.packageRoot(id, version));
    const provenance = await readJson(this.metadata(id, version, 'provenance'));
    if (installed.card.id !== id || installed.card.version !== version || !record(provenance) || provenance.digest !== installed.digest) throw failure('installed package conflicts with its pinned identity or provenance');
    return installed;
  }
  async list(): Promise<InstalledPackage[]> {
    const result: InstalledPackage[] = [];
    const entries = async (dir: string): Promise<string[]> => { try { return (await readdir(dir, { withFileTypes: true })).filter(item => item.isDirectory() && !item.isSymbolicLink()).map(item => item.name).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } };
    const base = path.join(this.root, 'packages');
    for (const author of await entries(base)) for (const name of await entries(path.join(base, author))) for (const version of await entries(path.join(base, author, name))) result.push(await this.inspect(`${author}/${name}`, version));
    return result;
  }
  async provenance(id: string, version: string): Promise<PackageProvenance | undefined> { return await readJson(this.metadata(id, version, 'provenance')) as PackageProvenance | undefined; }
  async bindings(id: string, version: string): Promise<PackageBindings> {
    const bindings = await readJson(this.metadata(id, version, 'bindings')) ?? {};
    validatePackageBindings(bindings); return bindings;
  }
  async configure(id: string, version: string, bindings: PackageBindings): Promise<void> { await this.inspect(id, version); validatePackageBindings(bindings); await atomicJson(this.metadata(id, version, 'bindings'), bindings); }
  async current(id: string): Promise<PackagePointer | undefined> {
    identity(id); const pointer = await readJson(path.join(this.root, 'adopted', `${id}.json`));
    if (pointer === undefined) return undefined;
    if (!record(pointer) || typeof pointer.version !== 'string' || typeof pointer.digest !== 'string') throw failure('invalid adopted package pointer');
    const installed = await this.inspect(id, pointer.version);
    if (installed.digest !== pointer.digest) throw failure('adopted package identity changed');
    return pointer as unknown as PackagePointer;
  }
  async adopt(id: string, version: string): Promise<PackagePointer> {
    const installed = await this.inspect(id, version); const previous = await this.current(id);
    if (previous?.digest === installed.digest) return previous;
    const pointer: PackagePointer = { version, digest: installed.digest, ...(previous ? { previous: { version: previous.version, digest: previous.digest } } : {}), adoptedAt: new Date().toISOString() };
    await atomicJson(path.join(this.root, 'adopted', `${id}.json`), pointer); return pointer;
  }
  /** Evidence-based host operation; import/adopt never executes a package or its case commands. */
  async adoptVerified(id: string, version: string, options: VerifiedAdoptionOptions): Promise<PackagePointer> {
    const installed = await this.inspect(id, version); const previous = await this.current(id);
    if (!options.runIds.length || options.runIds.length > 100 || new Set(options.runIds).size !== options.runIds.length) throw failure('verified adoption requires 1..100 distinct case runs');
    const candidates = options.runIds.map(runId => options.store.get(runId));
    const conditions = options.conditionsDigest ?? candidates[0]!.conditionsDigest;
    const cases = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.status !== 'passed' || candidate.target.id !== id || candidate.target.version !== version || candidate.target.digest !== installed.digest || candidate.target.cardDigest !== installed.card.digest || candidate.conditionsDigest !== conditions) throw failure('candidate evidence failed or package digest, card or execution conditions differ');
      const key = `${candidate.case.id}@${candidate.case.version}`;
      if (cases.has(key)) throw failure('provide one candidate run for each case identity');
      cases.add(key);
    }
    for (const required of options.requiredCases ?? []) if (!cases.has(`${required.id}@${required.version}`)) throw failure('required case evidence is missing');
    const history: CaseRun[] = []; let after = 0;
    for (;;) { const page = options.store.list({ targetId: id, after, limit: 1000 }); history.push(...page.items); if (page.next === null) break; after = page.next; }
    for (const candidate of candidates) {
      const latest = history.filter(run => run.target.digest === installed.digest && run.caseDigest === candidate.caseDigest && run.conditionsDigest === conditions).at(-1);
      if (latest?.id !== candidate.id) throw failure('candidate evidence is superseded; use the latest case run, including failures');
    }
    const comparedRunIds: string[] = [];
    if (previous && previous.digest !== installed.digest) {
      const current = await this.inspect(id, previous.version);
      const baselines = new Map<string, CaseRun>();
      for (const run of history) if (run.target.digest === current.digest && run.target.cardDigest === current.card.digest && run.conditionsDigest === conditions) baselines.set(`${run.case.id}@${run.case.version}`, run);
      if (!baselines.size) throw failure('current version requires comparable baseline cases before verified adoption');
      for (const [key, baseline] of baselines) {
        const candidate = candidates.find(run => `${run.case.id}@${run.case.version}` === key);
        if (!candidate || !compareCaseRuns(baseline, candidate).passed) throw failure('candidate case coverage is missing, not comparable or regressed');
        comparedRunIds.push(baseline.id);
      }
    }
    const pointer: PackagePointer = { version, digest: installed.digest, ...(previous && previous.digest !== installed.digest ? { previous: { version: previous.version, digest: previous.digest } } : previous?.previous ? { previous: previous.previous } : {}), adoptedAt: new Date().toISOString(), verification: { runIds: candidates.map(run => run.id), comparedRunIds, conditionsDigest: conditions } };
    await atomicJson(path.join(this.root, 'adopted', `${id}.json`), pointer); return pointer;
  }
  async rollbackVerified(id: string, options: VerifiedAdoptionOptions): Promise<PackagePointer> {
    const current = await this.current(id);
    if (!current?.previous) throw failure('no previously adopted version exists');
    return await this.adoptVerified(id, current.previous.version, options);
  }
  async rollback(id: string): Promise<PackagePointer> {
    const pointer = await this.current(id);
    if (!pointer?.previous) throw failure('no previously adopted version exists');
    const installed = await this.inspect(id, pointer.previous.version);
    if (installed.digest !== pointer.previous.digest) throw failure('previous package identity changed');
    return await this.adopt(id, pointer.previous.version);
  }
  async export(id: string, version: string, destination: string): Promise<void> { const installed = await this.inspect(id, version); await exportPackage(installed.root, installed.manifest, destination); }
  async diagnose(id: string, version: string): Promise<PackageDiagnostic> {
    const installed = await this.inspect(id, version); const incompatible = packageCompatibility(installed);
    if (incompatible.length) return { installed, status: 'incompatible', reasons: incompatible };
    await packageToolDescriptors(installed);
    const bindings = await this.bindings(id, version); const reasons = missingPackageBindings(installed, bindings);
    const prepared = await readJson(this.metadata(id, version, 'dependencies'));
    let preparedRoot: string | undefined;
    if (record(prepared) && prepared.digest === installed.digest && prepared.root === path.join(this.root, 'prepared', installed.digest) && typeof prepared.treeDigest === 'string') {
      if (await preparedTreeDigest(prepared.root as string) !== prepared.treeDigest) throw failure('prepared dependency content changed after verification');
      preparedRoot = prepared.root as string;
    }
    if (Object.keys(installed.manifest.requirements?.dependencies ?? {}).length && !preparedRoot) reasons.push('dependencies require explicit preparation');
    const verification = await readJson(this.metadata(id, version, 'verification'));
    if (installed.manifest.examples?.length && (!record(verification) || verification.digest !== installed.digest || verification.bindings !== hash(JSON.stringify(bindings)))) reasons.push('examples require verification at activation');
    const configured = await readJson(this.metadata(id, version, 'bindings')) !== undefined;
    return { installed, status: reasons.length ? (configured ? 'needs_configuration' : 'imported') : 'ready', reasons, ...(preparedRoot ? { preparedRoot, preparedDigest: (prepared as Record<string, unknown>).treeDigest as string } : {}) };
  }
  async activate(host: PackageHost, id: string, version: string, options: Omit<PackageActivationOptions, 'bindings' | 'preparedRoot' | 'preparedDigest'> & { reuseVerification?: boolean }): Promise<Card> {
    const hostResources = host.packageResources;
    validateSandboxResources(hostResources); validateSandboxResources(options.resources); validateSandboxResources(options.stdio?.resources);
    const resources: SandboxResources = {};
    for (const key of ['memoryBytes', 'maxProcesses'] as const) {
      const limits = [hostResources?.[key], options.resources?.[key], options.stdio?.resources?.[key]].filter((limit): limit is number => limit !== undefined);
      if (limits.length) resources[key] = Math.min(...limits);
    }
    options = { ...options, ...(Object.keys(resources).length ? { resources } : {}) };
    const diagnostic = await this.diagnose(id, version);
    if (diagnostic.status === 'incompatible') throw failure(diagnostic.reasons.join('; '));
    const bindings = await this.bindings(id, version);
    const context = hash(JSON.stringify({ workspace: await realpath(options.workspace), scope: options.scope ?? null, deny: options.deny ?? [], privatePaths: options.privatePaths ?? [], stdio: options.stdio ?? null, ...(Object.keys(resources).length ? { resources } : {}) }));
    const bindingsDigest = hash(JSON.stringify(bindings));
    const verificationName = `verification-${hash(JSON.stringify({ context, digest: diagnostic.installed.digest, bindings: bindingsDigest, preparedDigest: diagnostic.preparedDigest ?? null }))}`;
    const { reuseVerification, ...executionOptions } = options;
    let verifier = options.verifyExamples;
    if (reuseVerification && diagnostic.installed.manifest.examples?.length) {
      const previous = await readJson(this.metadata(id, version, verificationName));
      if (!record(previous) || previous.digest !== diagnostic.installed.digest || previous.bindings !== bindingsDigest || previous.context !== context || previous.preparedDigest !== (diagnostic.preparedDigest ?? null) || typeof previous.evidence !== 'string' || !previous.evidence.trim()) throw failure('the original package verification is missing or changed; explicitly verify the package before resuming');
      const previousEvidence = previous.evidence;
      verifier = () => ({ passed: true, evidence: previousEvidence });
    }
    let evidence: string | undefined;
    const activation: PackageActivationOptions = { ...executionOptions, bindings, ...(diagnostic.preparedRoot ? { preparedRoot: diagnostic.preparedRoot, preparedDigest: diagnostic.preparedDigest } : {}), ...(verifier ? { verifyExamples: async input => { const result = await verifier(input); if (result.passed) evidence = result.evidence; return result; } } : {}) };
    const card = await (host.activatePackage ? host.activatePackage(diagnostic.installed, activation) : activatePackage(host, diagnostic.installed, activation));
    if (evidence && !reuseVerification) {
      const verification = { digest: diagnostic.installed.digest, bindings: bindingsDigest, context, preparedDigest: diagnostic.preparedDigest ?? null, evidence: evidence.slice(0, 8000), verifiedAt: new Date().toISOString() };
      await atomicJson(this.metadata(id, version, verificationName), verification);
      await atomicJson(this.metadata(id, version, 'verification'), verification);
    }
    return card;
  }
  /** Explicit dependency preparation; never called by import, inspect, adopt or activation. */
  async prepareDependencies(id: string, version: string, options: { npmCli?: string; signal?: AbortSignal; onProgress?: (progress: { phase: 'validating' | 'dependencies' | 'verifying' | 'committing' }) => void } = {}): Promise<string> {
    options.onProgress?.({ phase: 'validating' });
    const installed = await this.inspect(id, version);
    const incompatible = packageCompatibility(installed); if (incompatible.length) throw failure(incompatible.join('; '));
    const declared = installed.manifest.requirements?.dependencies ?? {};
    if (!Object.keys(declared).length) throw failure('package declares no dependencies to prepare');
    let packageJson: unknown; let lock: unknown;
    try { packageJson = JSON.parse(await readFile(path.join(installed.root, 'package.json'), 'utf8')); lock = JSON.parse(await readFile(path.join(installed.root, 'package-lock.json'), 'utf8')); } catch { throw failure('dependency preparation requires declared package.json and package-lock.json'); }
    if (!record(packageJson) || packageJson.workspaces || !record(packageJson.dependencies) || JSON.stringify(Object.entries(packageJson.dependencies).sort()) !== JSON.stringify(Object.entries(declared).sort()) || packageJson.devDependencies || packageJson.optionalDependencies || !record(lock) || ![2, 3].includes(lock.lockfileVersion as number) || !record(lock.packages)) throw failure('dependency declarations and modern npm lockfile must agree');
    for (const [name, dependency] of Object.entries(lock.packages)) {
      if (!record(dependency)) throw failure('invalid locked dependency');
      if (!name) continue;
      if (!name.startsWith('node_modules/') || name.includes('..') || dependency.link || typeof dependency.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(dependency.version) || typeof dependency.resolved !== 'string' || typeof dependency.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(dependency.integrity)) throw failure('all dependencies must be immutable registry artifacts with SHA-512 integrity');
      const resolved = new URL(dependency.resolved);
      if (resolved.protocol !== 'https:' || resolved.hostname !== 'registry.npmjs.org' || resolved.username || resolved.password || resolved.search || resolved.hash) throw failure('only HTTPS registry.npmjs.org dependency artifacts are allowed');
    }
    const derived = path.join(this.root, 'prepared', installed.digest); const temporary = `${derived}.${randomUUID()}.tmp`;
    await mkdir(temporary, { recursive: true });
    try {
      for (const file of installed.manifest.files) { const target = path.join(temporary, file.path); await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(installed.root, file.path), target); }
      const npmCli = options.npmCli ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!(await lstat(npmCli)).isFile()) throw failure('provide a trusted npm CLI module path');
      options.onProgress?.({ phase: 'dependencies' });
      const sandbox = createSandbox({ workspace: temporary, write: true, network: 'allow', readOnlyPaths: [path.dirname(path.dirname(npmCli))] });
      const output = await sandbox.run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--cache', path.join(temporary, '.npm-cache')], { cwd: temporary, env: { npm_config_userconfig: path.join(temporary, '.empty-npmrc'), npm_config_globalconfig: path.join(temporary, '.empty-global-npmrc') }, ...(options.signal ? { signal: options.signal } : {}) });
      if (output.exitCode !== 0 || output.cancelled || output.signal || output.outputLimitExceeded) throw new KodoError('PACKAGE_DEPENDENCIES', `sandboxed npm ci --ignore-scripts failed (exit ${output.exitCode}, signal ${output.signal ?? 'none'})${output.stderr ? `: ${output.stderr.slice(0, 4000)}` : ''}`);
      options.onProgress?.({ phase: 'verifying' });
      for (const file of installed.manifest.files) if (hash(await readFile(path.join(temporary, file.path))) !== file.sha256) throw failure('dependency preparation changed a distributed source file');
      await rm(path.join(temporary, '.npm-cache'), { recursive: true, force: true });
      const treeDigest = await preparedTreeDigest(temporary);
      // Never replace a live prepared tree. Reuse only an exactly matching verified copy.
      options.onProgress?.({ phase: 'committing' });
      try { await rename(temporary, derived); } catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') || await preparedTreeDigest(derived) !== treeDigest) throw failure('an existing prepared dependency tree differs from the verified result'); }
      await atomicJson(this.metadata(id, version, 'dependencies'), { root: derived, digest: installed.digest, treeDigest, lockHash: hash(JSON.stringify(lock)), preparedAt: new Date().toISOString() });
      return derived;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}
