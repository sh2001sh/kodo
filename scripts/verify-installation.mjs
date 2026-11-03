import { spawnSync } from 'node:child_process';
import { access, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath, URL } from 'node:url';

const source = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const options = process.argv.slice(2);
function option(name) { const index = options.indexOf(name); if (index < 0) return undefined; if (!options[index + 1] || options[index + 1].startsWith('--')) throw new Error(`${name} requires a .tgz path`); return path.resolve(options[index + 1]); }
const candidateOption = option('--candidate');
const previousOption = option('--previous');
if (options.some((value, index) => index % 2 === 0 && !['--candidate', '--previous'].includes(value)) || (previousOption && !candidateOption)) throw new Error('Usage: node scripts/verify-installation.mjs [--candidate candidate.tgz --previous previous.tgz]');

let npmCli;
for (const candidate of [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean)) {
  try { await access(candidate); npmCli = candidate; break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!npmCli) throw new Error('Cannot locate npm-cli.js; run via npm run or install npm beside Node.js');
const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-installation-'));
function run(program, args, cwd, extra = {}) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...extra });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0]} failed (${result.status}): ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result.stdout;
}
async function pack(directory, destination) {
  await mkdir(destination, { recursive: true });
  const output = run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', destination], directory);
  const lines = output.trim().split('\n');
  const jsonStart = lines.findIndex(line => line.trim() === '[');
  const packed = JSON.parse(lines.slice(jsonStart).join('\n'))[0];
  return path.join(destination, packed.filename);
}
async function inspect(archive, target) {
  await mkdir(target, { recursive: true });
  run('tar', ['-xf', archive, '-C', target], root);
  const directory = path.join(target, 'package');
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (!manifest.name || !manifest.version || manifest.license !== 'MIT') throw new Error('Tarball must contain a named, versioned MIT package');
  await access(path.join(directory, 'LICENSE'));
  return { directory, manifest };
}
try {
  const candidate = candidateOption ?? await pack(source, path.join(root, 'candidate'));
  const candidateInfo = await inspect(candidate, path.join(root, 'candidate-inspect'));
  let previous = previousOption;
  let previousInfo;
  let mode = 'release archives';
  if (previous) previousInfo = await inspect(previous, path.join(root, 'previous-inspect'));
  else {
    // Exercise the installer with two distinct versions without inventing a
    // historical release. The synthetic fixture is explicitly reported below.
    mode = 'synthetic previous-version packaging fixture';
    const staging = path.join(root, 'previous-source');
    await cp(candidateInfo.directory, staging, { recursive: true });
    const manifest = { ...candidateInfo.manifest, version: '0.0.0-installation-fixture', scripts: {} };
    await writeFile(path.join(staging, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    previous = await pack(staging, path.join(root, 'previous'));
    previousInfo = { directory: staging, manifest };
  }
  if (previousInfo.manifest.name !== candidateInfo.manifest.name || previousInfo.manifest.version === candidateInfo.manifest.version) throw new Error('Upgrade rehearsal requires the same package name and two distinct versions');
  const prefix = path.join(root, 'installation');
  await mkdir(prefix);
  await writeFile(path.join(prefix, 'package.json'), JSON.stringify({ private: true }), 'utf8');
  async function install(archive, manifest, stage) {
    run(process.execPath, [npmCli, 'install', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false', archive], prefix);
    const installed = path.join(prefix, 'node_modules', ...manifest.name.split('/'));
    const actual = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
    if (actual.version !== manifest.version) throw new Error(`${stage}: installed manifest has the wrong version`);
    const bin = typeof actual.bin === 'string' ? actual.bin : actual.bin?.kodo;
    if (!bin) throw new Error('Installed package has no kodo executable');
    const entry = path.join(installed, bin);
    const output = run(process.execPath, [entry, '--version'], prefix).trim();
    if (output !== manifest.version) throw new Error(`${stage}: executable version ${output} differs from installed version ${manifest.version}`);
    const stub = path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'kodo.cmd' : 'kodo');
    await access(stub, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    const doctor = JSON.parse(run(process.execPath, [entry, 'doctor', '--data-dir', path.join(root, 'state')], prefix));
    if (doctor.sqlite !== 'ok') throw new Error(`${stage}: storage doctor failed`);
    console.log(`PASS ${stage}: ${manifest.name}@${manifest.version}; CLI version, bin, production native SQLite, storage doctor`);
  }
  await install(previous, previousInfo.manifest, 'clean production install');
  await install(candidate, candidateInfo.manifest, 'upgrade');
  await install(previous, previousInfo.manifest, 'rollback');
  console.log(`PASS installation rehearsal (${mode}); isolated prefix only; no registry publish`);
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
