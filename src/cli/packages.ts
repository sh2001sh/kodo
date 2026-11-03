import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import os from 'node:os';
import { KodoError } from '../runtime/types.js';
import { PackageRegistry } from '../packages/registry.js';
import { exportPackage, inspectPackage } from '../packages/archive.js';
import { PACKAGE_MANIFEST } from '../packages/schema.js';
import type { PackageBindings } from '../packages/runtime.js';
import type { PackageDeclaration } from '../packages/schema.js';
import { Application } from '../application/index.js';
import { verifyToolExamples } from '../packages/runtime.js';
import type { Permission } from '../runtime/types.js';
import { validateSandboxResources } from '../sandbox/policy.js';
import type { SandboxPolicy } from '../sandbox/index.js';

export function cliDataDirectory(value?: string): string {
  return path.resolve(value ?? process.env.KODO_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'kodo'));
}
export function packageIdentity(value: string): { id: string; version: string } {
  const match = /^([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d+)$/.exec(value);
  if (!match) throw new KodoError('ARGUMENTS', 'package identity must be author/name@1.2.3');
  return { id: match[1]!, version: match[2]! };
}
const packageHelp = `kodo package export <source-directory|author/name@version> --output file.zip [--manifest declaration.json]
kodo package inspect <file.zip|author/name@version>
kodo package import <file.zip>
kodo package list
kodo package diagnose <author/name@version>
kodo package configure <author/name@version> --bindings file.json
kodo package prepare <author/name@version> [--npm-cli path]
kodo package verify <author/name@version> --workspace path [--allow-write] [--allow-exec] [--sandbox-resources JSON_FILE]
kodo package adopt <author/name@version>
kodo package rollback <author/name>
kodo case --help (execute frozen cases and adopt/rollback with comparison evidence)
Options: --data-dir path --json. Source export reads CAPABILITY.json with an explicit distributable file list.
Import, inspection and adoption never execute package code. Package adopt/rollback are low-level pointer operations; use case adopt/rollback for evidence checks. Preparation runs npm ci --ignore-scripts inside the OS sandbox.`;

/** Package management dispatches before opening the model runtime or reading model credentials. */
export async function packageCommand(args: string[]): Promise<void> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new KodoError('CANCELLED', 'package operation cancelled'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try { await executePackageCommand(args, controller.signal); }
  catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
async function executePackageCommand(args: string[], signal: AbortSignal): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args, allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, 'data-dir': { type: 'string' }, output: { type: 'string' }, manifest: { type: 'string' }, bindings: { type: 'string' }, 'npm-cli': { type: 'string' }, workspace: { type: 'string' }, 'allow-write': { type: 'boolean' }, 'allow-exec': { type: 'boolean' }, 'sandbox-resources': { type: 'string' } } }); }
  catch { throw new KodoError('ARGUMENTS', 'invalid package options; use package --help'); }
  const { values, positionals } = parsed;
  if (values.help || !positionals.length) { console.log(packageHelp); return; }
  const [command, argument] = positionals;
  if (!['export', 'inspect', 'import', 'list', 'diagnose', 'configure', 'prepare', 'verify', 'adopt', 'rollback'].includes(command!)) throw new KodoError('ARGUMENTS', 'unknown package command; use package --help');
  if (positionals.length !== (command === 'list' ? 1 : 2)) throw new KodoError('ARGUMENTS', 'package command requires exactly one target (list accepts none)');
  for (const [option, owner] of [['output', 'export'], ['manifest', 'export'], ['bindings', 'configure'], ['npm-cli', 'prepare']] as const) if (values[option] !== undefined && command !== owner) throw new KodoError('ARGUMENTS', `--${option} is only valid for package ${owner}`);
  if (command !== 'verify' && ['workspace', 'allow-write', 'allow-exec', 'sandbox-resources'].some(option => values[option] !== undefined)) throw new KodoError('ARGUMENTS', '--workspace, permission and resource options are only valid for package verify');
  const directory = cliDataDirectory(values['data-dir'] as string | undefined);
  const registry = new PackageRegistry(path.join(directory, 'capabilities'));
  let result: unknown;
  if (command === 'list') result = (await registry.list()).map(item => ({ id: item.card.id, version: item.card.version, digest: item.digest }));
  else if (command === 'import') result = await registry.import(path.resolve(argument!));
  else if (command === 'rollback') result = await registry.rollback(argument!);
  else if (command === 'export' && !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@\d+\.\d+\.\d+$/.test(argument!)) {
    if (typeof values.output !== 'string') throw new KodoError('ARGUMENTS', 'package export requires --output');
    const source = path.resolve(argument!);
    let declaration: PackageDeclaration;
    try { declaration = JSON.parse(await readFile(typeof values.manifest === 'string' ? path.resolve(values.manifest) : path.join(source, PACKAGE_MANIFEST), 'utf8')) as PackageDeclaration; }
    catch { throw new KodoError('ARGUMENTS', 'source package requires a valid CAPABILITY.json declaration'); }
    result = await exportPackage(source, declaration, path.resolve(values.output));
  } else if (command === 'inspect' && !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@\d+\.\d+\.\d+$/.test(argument!)) result = await inspectPackage(path.resolve(argument!));
  else {
    const { id, version } = packageIdentity(argument!);
    if (command === 'inspect') result = await registry.inspect(id, version);
    else if (command === 'diagnose') result = await registry.diagnose(id, version);
    else if (command === 'adopt') result = await registry.adopt(id, version);
    else if (command === 'export') {
      if (values.manifest !== undefined) throw new KodoError('ARGUMENTS', '--manifest is only valid when exporting a source directory');
      if (typeof values.output !== 'string') throw new KodoError('ARGUMENTS', 'package export requires --output');
      await registry.export(id, version, path.resolve(values.output)); result = { id, version, output: path.resolve(values.output) };
    } else if (command === 'configure') {
      if (typeof values.bindings !== 'string') throw new KodoError('ARGUMENTS', 'package configure requires --bindings file.json (environment references, never secret values)');
      let bindings: PackageBindings;
      try { bindings = JSON.parse(await readFile(path.resolve(values.bindings), 'utf8')) as PackageBindings; }
      catch { throw new KodoError('ARGUMENTS', 'invalid bindings JSON file'); }
      await registry.configure(id, version, bindings); result = await registry.diagnose(id, version);
    } else if (command === 'prepare') result = { id, version, preparedRoot: await registry.prepareDependencies(id, version, { signal, ...(typeof values['npm-cli'] === 'string' ? { npmCli: path.resolve(values['npm-cli']) } : {}) }) };
    else if (command === 'verify') {
      if (typeof values.workspace !== 'string') throw new KodoError('ARGUMENTS', 'package verify requires --workspace');
      if (!(await registry.inspect(id, version)).manifest.examples?.length) throw new KodoError('PACKAGE_VERIFICATION', 'package declares no executable examples to verify');
      const workspace = path.resolve(values.workspace);
      let resources: SandboxPolicy['resources'];
      if (typeof values['sandbox-resources'] === 'string') {
        let value: unknown;
        try { value = JSON.parse(await readFile(path.resolve(values['sandbox-resources']), 'utf8')); }
        catch { throw new KodoError('ARGUMENTS', 'sandbox resources require a readable JSON file'); }
        validateSandboxResources(value); resources = value;
      }
      const permissions: Permission[] = ['read', ...(values['allow-write'] ? ['write' as const] : []), ...(values['allow-exec'] ? ['exec' as const] : [])];
      const app = new Application(directory);
      try {
        await registry.activate(app, id, version, { workspace, stdio: { write: Boolean(values['allow-write']), network: 'none', ...(resources ? { resources } : {}) }, verifyExamples: verifyToolExamples({ workspace, permissions }), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
        result = { id, version, verified: true, diagnostic: await registry.diagnose(id, version) };
      } finally { await app.shutdown(); }
    }
  }
  signal.throwIfAborted();
  console.log(JSON.stringify(result, null, values.json ? undefined : 2));
}
