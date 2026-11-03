import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Application } from '../application/index.js';
import type { PackagePointer, PackageRegistry, PackageStatus } from '../packages/registry.js';
import type { InstalledPackage } from '../packages/schema.js';
import type { RunStatus } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';

/** Host switches supplied by `LocalServerOptions.packages` (see docs/web-experience-batch2.md §4.1). */
export interface PackagePanelOptions {
  /** Explicitly expose the capability-package panel; omitting `packages` yields `enabled:false`. */
  enabled?: boolean;
  /** Installed-package registry root (absolute path) or a host-constructed registry for tests/embedders. */
  registry?: string | PackageRegistry;
  /** Package version enabled by the host for new Web tasks; displayed for run-version comparison only. */
  runtime?: { id: string; version: string; digest: string };
  /** Allow the browser to run sandboxed npm dependency preparation. */
  prepare?: boolean;
  /** Trusted npm CLI module path used for preparation; omitted means the registry default. */
  npmCli?: string;
  /** Allow the browser to switch the default-version pointer (adopt/rollback). */
  adopt?: boolean;
}

export interface PackageVersionView {
  version: string;
  digest: string;
  card: { id: string; version: string; digest: string; name: string; description: string; tools: string[]; skills: string[] };
  status: PackageStatus;
  reasons: string[];
  requirements: { node?: string; platforms?: string[]; arch?: string[]; dependencies?: Record<string, string> };
  resources: { tools: number; skills: number; mcp: number };
  examples: number;
  prepared: { ready: boolean; treeDigest: string | null };
  bindingsConfigured: boolean;
  provenance: { importedAt: string; source: { url: string; revision?: string }; archiveName: string } | null;
}

export interface PackageGroupView {
  id: string;
  defaultVersion: string | null;
  previousVersion: string | null;
  adoptedAt: string | null;
  versions: PackageVersionView[];
}

export interface RunningPackageRunView {
  runId: string;
  sessionId: string;
  role: 'main' | 'child';
  objective: string;
  status: RunStatus;
  cardId: string;
  cardVersion: string;
  cardDigest: string;
  /** Digest of the card installed for the same package version; null when that version is no longer installed. */
  installedDigest: string | null;
  stale: boolean;
  createdAt: string;
  lastEventAt: string;
}

export interface PrepareJobView {
  id: string;
  packageId: string;
  version: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  phase: 'queued' | 'validating' | 'dependencies' | 'verifying' | 'committing' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface PackageOverview {
  enabled: boolean;
  actions: { prepare: boolean; adopt: boolean };
  runtime: { id: string; version: string; digest: string } | null;
  packages: PackageGroupView[];
  running: RunningPackageRunView[];
  prepareJobs: PrepareJobView[];
  errors: string[];
}

interface MutableJob {
  view: PrepareJobView;
  controller: AbortController;
  promise?: Promise<void>;
}

const PACKAGE_IDENTITY = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+$/;
const IDENTITY_MESSAGE = 'package identity must be author/name and version x.y.z';

function assertPackageId(id: string): void {
  if (typeof id !== 'string' || !PACKAGE_IDENTITY.test(id)) throw new KodoError('ARGUMENTS', IDENTITY_MESSAGE);
}
function assertIdentity(id: string, version: string): void {
  if (typeof id !== 'string' || !PACKAGE_IDENTITY.test(id) || typeof version !== 'string' || !PACKAGE_VERSION.test(version)) throw new KodoError('ARGUMENTS', IDENTITY_MESSAGE);
}
/** Installed-package lookups surface a missing tree as a raw ENOENT; translate it to the HTTP not-found contract. */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
const compareVersions = (left: string, right: string): number => {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * Read-only capability-package projection plus the host-gated preparation queue.
 * It never exposes registry paths, local bindings, credentials or package code.
 */
export class PackagePanel {
  readonly #registry: PackageRegistry;
  readonly #runtime: { id: string; version: string; digest: string } | undefined;
  readonly #prepareEnabled: boolean;
  readonly #adoptEnabled: boolean;
  readonly #npmCli: string | undefined;
  readonly #jobs = new Map<string, MutableJob>();
  readonly #queue: MutableJob[] = [];
  #active: MutableJob | undefined;
  #closed = false;

  constructor(options: {
    registry: PackageRegistry;
    runtime?: { id: string; version: string; digest: string };
    prepare?: boolean;
    npmCli?: string;
    adopt?: boolean;
  }) {
    this.#registry = options.registry;
    this.#runtime = options.runtime ? { id: options.runtime.id, version: options.runtime.version, digest: options.runtime.digest } : undefined;
    this.#prepareEnabled = options.prepare === true;
    this.#adoptEnabled = options.adopt === true;
    this.#npmCli = options.npmCli;
  }

  /** One installed package version without any host-local binding contents or registry paths. */
  async #versionView(installed: InstalledPackage, errors: string[]): Promise<PackageVersionView | null> {
    const id = installed.card.id; const version = installed.card.version;
    let diagnostic;
    try { diagnostic = await this.#registry.diagnose(id, version); }
    catch { errors.push(`${id}@${version}: diagnostic failed`); return null; }
    let provenance: PackageVersionView['provenance'] = null;
    try {
      const value = await this.#registry.provenance(id, version);
      if (value) provenance = { importedAt: value.importedAt, source: { url: value.source.url, ...(value.source.revision === undefined ? {} : { revision: value.source.revision }) }, archiveName: value.archiveName };
    } catch { errors.push(`${id}@${version}: provenance is unreadable`); }
    const bindingsConfigured = await this.#registry.bindings(id, version).then(() => true, () => false);
    const manifest = installed.manifest; const requirements = manifest.requirements;
    return {
      version,
      digest: installed.digest,
      card: {
        id: installed.card.id, version: installed.card.version, digest: installed.card.digest,
        name: installed.card.name, description: installed.card.description ?? '',
        tools: [...installed.card.tools], skills: [...(installed.card.skills ?? [])],
      },
      status: diagnostic.status,
      reasons: [...diagnostic.reasons],
      requirements: {
        ...(requirements?.node === undefined ? {} : { node: requirements.node }),
        ...(requirements?.platforms === undefined ? {} : { platforms: [...requirements.platforms] }),
        ...(requirements?.arch === undefined ? {} : { arch: [...requirements.arch] }),
        ...(requirements?.dependencies === undefined ? {} : { dependencies: { ...requirements.dependencies } }),
      },
      resources: {
        tools: manifest.resources?.tools?.length ?? 0,
        skills: manifest.resources?.skills?.length ?? 0,
        mcp: manifest.resources?.mcp?.length ?? 0,
      },
      examples: manifest.examples?.length ?? 0,
      prepared: diagnostic.preparedRoot === undefined ? { ready: false, treeDigest: null } : { ready: true, treeDigest: diagnostic.preparedDigest ?? null },
      bindingsConfigured,
      provenance,
    };
  }

  /** Enumerate installed versions; one unreadable package is reported but cannot collapse the projection. */
  async #installedPackages(errors: string[]): Promise<InstalledPackage[]> {
    try { return await this.#registry.list(); }
    catch {
      const result: InstalledPackage[] = [];
      try {
        const root = this.#registry.root;
        const directories = async (directory: string): Promise<string[]> => {
          const entries = await readdir(directory, { withFileTypes: true });
          return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort();
        };
        const base = path.join(root, 'packages');
        for (const author of await directories(base)) for (const name of await directories(path.join(base, author))) for (const version of await directories(path.join(base, author, name))) {
          try { result.push(await this.#registry.inspect(`${author}/${name}`, version)); }
          catch { errors.push(`${author}/${name}@${version}: installed package is unreadable`); }
        }
      } catch { errors.push('installed capability packages are unreadable'); }
      return result;
    }
  }

  /** Read-only diagnostics, default pointers and fixed run cards. Never returns binding values or host paths. */
  async overview(app: Application, allowedSession: (sessionId: string) => boolean): Promise<PackageOverview> {
    const errors: string[] = [];
    const installed = await this.#installedPackages(errors);
    const groups = new Map<string, InstalledPackage[]>();
    for (const item of installed) { const list = groups.get(item.card.id); if (list) list.push(item); else groups.set(item.card.id, [item]); }
    const cardDigests = new Map<string, string>();
    for (const item of installed) cardDigests.set(`${item.card.id}@${item.card.version}`, item.card.digest);
    const packages: PackageGroupView[] = [];
    for (const id of [...groups.keys()].sort()) {
      const versions: PackageVersionView[] = [];
      const items = groups.get(id)!;
      items.sort((left, right) => compareVersions(left.card.version, right.card.version));
      for (const item of items) { const view = await this.#versionView(item, errors); if (view) versions.push(view); }
      let pointer: PackagePointer | undefined;
      try { pointer = await this.#registry.current(id); }
      catch { errors.push(`${id}: adopted version pointer is invalid`); }
      packages.push({
        id,
        defaultVersion: pointer?.version ?? null,
        previousVersion: pointer?.previous?.version ?? null,
        adoptedAt: pointer?.adoptedAt ?? null,
        versions,
      });
    }
    const running: RunningPackageRunView[] = [];
    try {
      for (const run of app.store.listRuns()) {
        if (!allowedSession(run.sessionId) || !groups.has(run.card.id)) continue;
        const installedDigest = cardDigests.get(`${run.card.id}@${run.card.version}`) ?? null;
        running.push({
          runId: run.id, sessionId: run.sessionId, role: run.parentId ? 'child' : 'main', objective: run.objective,
          status: run.status, cardId: run.card.id, cardVersion: run.card.version, cardDigest: run.card.digest,
          installedDigest, stale: installedDigest !== null && run.card.digest !== installedDigest,
          createdAt: run.createdAt, lastEventAt: this.#lastEventAt(app, run.id, run.createdAt),
        });
      }
    } catch { errors.push('run records are unreadable'); }
    running.sort((left, right) => left.createdAt === right.createdAt ? (left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0) : (left.createdAt < right.createdAt ? 1 : -1));
    return {
      enabled: true,
      actions: { prepare: this.#prepareEnabled, adopt: this.#adoptEnabled },
      runtime: this.#runtime ? { ...this.#runtime } : null,
      packages,
      running: running.slice(0, 200),
      prepareJobs: [...this.#jobs.values()].map(job => ({ ...job.view })),
      errors,
    };
  }

  #lastEventAt(app: Application, runId: string, fallback: string): string {
    try {
      return app.store.latestEvent(runId)?.time ?? fallback;
    } catch { return fallback; }
  }

  /** Queue one dependency preparation; a queued/running job for the same version is reused. */
  prepare(id: string, version: string): { jobId: string } {
    assertIdentity(id, version);
    if (this.#closed) throw new KodoError('NOT_FOUND', 'the capability-package panel is closed');
    if (!this.#prepareEnabled) throw new KodoError('NOT_FOUND', 'dependency preparation is disabled by the host');
    for (const job of this.#jobs.values()) {
      if (job.view.packageId === id && job.view.version === version && (job.view.status === 'queued' || job.view.status === 'running')) return { jobId: job.view.id };
    }
    const job: MutableJob = {
      view: { id: randomUUID(), packageId: id, version, status: 'queued', phase: 'queued', startedAt: null, finishedAt: null, error: null },
      controller: new AbortController(),
    };
    this.#jobs.set(job.view.id, job);
    this.#queue.push(job);
    this.#drain();
    return { jobId: job.view.id };
  }

  /** Synchronous view of a retained job; unknown IDs return undefined (mapped to 404 by the HTTP adapter). */
  job(jobId: string): PrepareJobView | undefined {
    const job = this.#jobs.get(jobId);
    return job ? { ...job.view } : undefined;
  }

  /** Whether the exact installed version can be addressed (used for the prepare route's 404 gate). */
  async has(id: string, version: string): Promise<boolean> {
    assertIdentity(id, version);
    try { await this.#registry.inspect(id, version); return true; }
    catch { return false; }
  }

  /** Switch the default-version pointer only; running tasks and their fixed cards are untouched. */
  async adopt(id: string, version: string): Promise<PackagePointer> {
    assertIdentity(id, version);
    if (!this.#adoptEnabled) throw new KodoError('NOT_FOUND', 'switching the default package version is disabled by the host');
    return await this.#translated(() => this.#registry.adopt(id, version));
  }

  async rollback(id: string): Promise<PackagePointer> {
    assertPackageId(id);
    if (!this.#adoptEnabled) throw new KodoError('NOT_FOUND', 'switching the default package version is disabled by the host');
    try { return await this.#registry.rollback(id); }
    catch (error) {
      if (isMissing(error)) throw new KodoError('PACKAGE_NOT_FOUND', 'package version is not installed');
      // A missing package reports "no previous version"; keep the real business error for installed packages.
      if (!(error instanceof KodoError) || error.code !== 'PACKAGE_REGISTRY' || error.message !== 'no previously adopted version exists') throw error;
      let installed = true;
      try { installed = (await this.#registry.list()).some(item => item.card.id === id); }
      catch { /* keep the original business error when installed packages cannot be enumerated */ }
      if (!installed) throw new KodoError('PACKAGE_NOT_FOUND', 'package version is not installed');
      throw error;
    }
  }

  async #translated<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (isMissing(error)) throw new KodoError('PACKAGE_NOT_FOUND', 'package version is not installed');
      throw error;
    }
  }

  #drain(): void {
    if (this.#active || this.#closed) return;
    const job = this.#queue.shift();
    if (!job) return;
    this.#active = job;
    job.view.status = 'running'; job.view.phase = 'validating'; job.view.startedAt = new Date().toISOString();
    job.promise = this.#execute(job);
  }

  async #execute(job: MutableJob): Promise<void> {
    try {
      await this.#registry.prepareDependencies(job.view.packageId, job.view.version, {
        signal: job.controller.signal,
        ...(this.#npmCli === undefined ? {} : { npmCli: this.#npmCli }),
        onProgress: progress => { if (job.view.status === 'running') job.view.phase = progress.phase; },
      });
      job.view.status = 'succeeded'; job.view.phase = 'done';
      try { await this.#registry.diagnose(job.view.packageId, job.view.version); }
      catch { /* The prepared tree is durable; a failed refresh only means the next overview reports it. */ }
    } catch (error) {
      job.view.status = 'failed'; job.view.phase = 'failed';
      job.view.error = job.controller.signal.aborted ? 'dependency preparation was cancelled' : this.#safeError(error);
    } finally {
      job.view.finishedAt = new Date().toISOString();
      this.#active = undefined;
      this.#drain();
    }
  }

  /** Failure text stays local: registry roots and absolute paths are never sent to the browser. */
  #safeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : 'dependency preparation failed';
    const redacted = raw
      .replaceAll(this.#registry.root, '[package-registry]')
      .replace(/[A-Za-z]:[\\/][^\s"'<>|]*/g, '[path]')
      .replace(/(^|[\s("'=])\/[^\s"'<>|]+/g, '$1[path]');
    return redacted.slice(0, 400);
  }

  #cancelQueued(): void {
    while (this.#queue.length) {
      const job = this.#queue.shift()!;
      job.view.status = 'failed'; job.view.phase = 'failed';
      job.view.error = 'dependency preparation was cancelled';
      job.view.finishedAt = new Date().toISOString();
    }
  }

  /** Abort an in-flight preparation and wait for it to settle; retained job views remain readable. */
  async close(): Promise<void> {
    if (this.#closed) { await this.#active?.promise; return; }
    this.#closed = true;
    this.#cancelQueued();
    const active = this.#active;
    if (active) { active.controller.abort(); await active.promise; }
  }
}
