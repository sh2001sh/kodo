import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareRunOutput, runOutputDirectory } from '../src/runtime/run-output.js';
import { prepareSandboxCommand, sandboxEnvironment } from '../src/sandbox/index.js';
import { checkVersion } from '../src/runtime/check-hint.js';
import { runProcess } from '../src/tools/index.js';
import type { ProcessOutput } from '../src/tools/index.js';
import { binding, fixture, temp } from './helpers.js';

const directories = new Set<string>();
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});
const remember = (directory: string): string => { directories.add(directory); return directory; };

describe('fixed run output', () => {
  it('keeps output across setup calls and separates runs and stores', async () => {
    const store = { directory: temp() };
    const predicted = runOutputDirectory(store, 'a');
    await expect(stat(predicted)).rejects.toMatchObject({ code: 'ENOENT' });
    const a = await prepareRunOutput(store, 'a'); remember(a.directory);
    const b = await prepareRunOutput(store, 'b'); remember(b.directory);
    const other = await prepareRunOutput({ directory: temp() }, 'a'); remember(other.directory);
    await writeFile(path.join(a.directory, 'result'), 'kept');
    expect((await prepareRunOutput(store, 'a')).directory).toBe(a.directory);
    expect(await readFile(path.join(a.directory, 'result'), 'utf8')).toBe('kept');
    expect(new Set([a.directory, b.directory, other.directory]).size).toBe(3);
    expect(await stat(predicted)).toBeDefined();
    await expect(prepareRunOutput(store, '../other')).rejects.toMatchObject({ code: 'RUN_OUTPUT' });
  });

  it('uses coverage defaults but preserves explicit environment overrides', async () => {
    const store = { directory: temp() };
    vi.stubEnv('COVERAGE_FILE', undefined);
    const defaults = await prepareRunOutput(store, 'a'); remember(defaults.directory);
    expect(defaults.env.COVERAGE_FILE).toBe(path.join(defaults.directory, '.coverage'));
    expect(defaults.env.KODO_RUN_OUTPUT_DIR).toBe(defaults.directory);
    vi.stubEnv('COVERAGE_FILE', 'host-coverage');
    expect((await prepareRunOutput(store, 'a')).env.COVERAGE_FILE).toBe('host-coverage');
    expect((await prepareRunOutput(store, 'a', { COVERAGE_FILE: 'explicit-coverage' })).env.COVERAGE_FILE).toBe('explicit-coverage');
  });

  it('keeps pytest selection and plugin options while providing an overridable cache default', async () => {
    const store = { directory: temp() };
    vi.stubEnv('PYTEST_ADDOPTS', '-q -k "selected or other" -p custom_plugin');
    const host = await prepareRunOutput(store, 'pytest'); remember(host.directory);
    expect(host.env.PYTEST_ADDOPTS).toBe('-o cache_dir=$KODO_RUN_OUTPUT_DIR/.pytest_cache -q -k "selected or other" -p custom_plugin');
    const explicit = await prepareRunOutput(store, 'pytest', { PYTEST_ADDOPTS: '-o "cache_dir=explicit cache" -m fast', CUSTOM_ENV: 'kept' });
    expect(explicit.env.PYTEST_ADDOPTS).toBe('-o cache_dir=$KODO_RUN_OUTPUT_DIR/.pytest_cache -o "cache_dir=explicit cache" -m fast');
    expect(explicit.env.CUSTOM_ENV).toBe('kept');
    expect(sandboxEnvironment(explicit.env).PYTEST_ADDOPTS).toBe(explicit.env.PYTEST_ADDOPTS);
    expect(sandboxEnvironment(explicit.env).KODO_RUN_OUTPUT_DIR).toBe(explicit.directory);
  });

  it('real pytest expands output paths with spaces and honors explicit cache and selection options', async context => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    if (spawnSync(python, ['-c', 'import pytest'], { windowsHide: true }).status !== 0) { context.skip(); return; }
    const workspace = remember(temp());
    const output = await prepareRunOutput({ directory: workspace }, 'pytest'); remember(output.directory);
    const spacedOutput = path.join(output.directory, 'space and apostrophe\'s output');
    await mkdir(spacedOutput);
    await writeFile(path.join(workspace, 'pytest.ini'), '[pytest]\nfilterwarnings = error\n');
    await writeFile(path.join(workspace, 'test_output.py'), 'import os\nfrom pathlib import Path\ndef test_selected(pytestconfig):\n    assert pytestconfig.cache._cachedir == Path(os.environ["EXPECTED_CACHE"])\ndef test_unselected():\n    assert False\n');
    for (const explicit of ['', '-o "cache_dir=explicit cache"']) {
      const selected = await prepareRunOutput({ directory: workspace }, 'pytest', { PYTEST_ADDOPTS: `-q -k selected ${explicit}` });
      const expected = explicit ? path.join(workspace, 'explicit cache') : path.join(spacedOutput, '.pytest_cache');
      const result = spawnSync(python, ['-m', 'pytest', '-k', 'test_selected'], { cwd: workspace, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, ...selected.env, KODO_RUN_OUTPUT_DIR: spacedOutput, EXPECTED_CACHE: expected, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' } });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('1 passed, 1 deselected');
      expect(await stat(expected)).toBeDefined();
    }
    await expect(stat(path.join(workspace, '.pytest_cache'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shares output across real tool commands without adding workspace files', async () => {
    vi.stubEnv('COVERAGE_FILE', undefined);
    const { app, root, runId } = fixture(undefined, ['read', 'write', 'exec']);
    execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, '.gitignore'), '.state/\n');
    await writeFile(path.join(root, 'source.txt'), 'source');
    const version = checkVersion(app.store, root);
    expect(version).not.toBeNull();
    remember(runOutputDirectory(app.store, runId));
    const execute = (source: string) => app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', source] }, AbortSignal.timeout(30_000)) as Promise<ProcessOutput>;
    const first = await execute('require("node:fs").writeFileSync(process.env.COVERAGE_FILE,"coverage-result")');
    expect(first.exitCode, first.stderr).toBe(0);
    expect(checkVersion(app.store, root)).toBe(version);
    const second = await execute('require("node:fs").appendFileSync(process.env.COVERAGE_FILE,"-updated"); console.log(require("node:fs").readFileSync(process.env.COVERAGE_FILE,"utf8")); console.log(process.env.KODO_RUN_OUTPUT_DIR)');
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout).toContain('coverage-result-updated');
    expect(second.stdout).toContain(runOutputDirectory(app.store, runId));
    await expect(readFile(path.join(root, '.coverage'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(checkVersion(app.store, root)).toBe(version);
    await writeFile(path.join(root, 'source.txt'), 'changed source');
    expect(checkVersion(app.store, root)).not.toBe(version);
  });

  it('requires a separate output directory without expanding workspace scope', async () => {
    const workspace = temp();
    await expect(prepareSandboxCommand(process.execPath, [], { workspace, outputDirectory: workspace })).rejects.toMatchObject({ code: 'SANDBOX_CONFIG' });
    await expect(prepareSandboxCommand(process.execPath, [], { workspace, outputDirectory: path.dirname(workspace) })).rejects.toMatchObject({ code: 'SANDBOX_CONFIG' });
  });
});

describe.skipIf(!['win32', 'linux'].includes(process.platform))('sandboxed fixed run output', () => {
  it('preserves only the current run output across commands and native host verification', async () => {
    vi.stubEnv('COVERAGE_FILE', undefined);
    const { app, root, runId } = fixture(undefined, ['read', 'exec'], {
      sandbox: {},
      verification: { enabled: true, approved: true, backend: 'native', program: process.execPath,
        args: ['-e', 'if(require("node:fs").readFileSync(process.env.COVERAGE_FILE,"utf8")!=="kept") process.exit(1); console.log("ok 1 - preserved output")'], parser: 'tap' },
    });
    const own = remember(runOutputDirectory(app.store, runId));
    const peer = app.createRun({ objective: 'Independent output', workspace: root, binding, permissions: ['read', 'exec'] });
    const peerOutput = await prepareRunOutput(app.store, peer.id); remember(peerOutput.directory);
    await writeFile(path.join(peerOutput.directory, 'peer'), 'peer');
    const execute = (source: string) => app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', source] }, AbortSignal.timeout(30_000)) as Promise<ProcessOutput>;
    const first = await execute('require("node:fs").writeFileSync(process.env.COVERAGE_FILE,"kept")');
    expect(first.exitCode, first.stderr).toBe(0);
    const output = await prepareRunOutput(app.store, runId);
    const readOnly = await runProcess(process.execPath, ['-e', `const f=require('node:fs'); let denied=false; try { f.appendFileSync(process.env.COVERAGE_FILE,'changed'); } catch { denied=true; } console.log(JSON.stringify({value:f.readFileSync(process.env.COVERAGE_FILE,'utf8'),outputValue:f.readFileSync(require('node:path').join(process.env.KODO_RUN_OUTPUT_DIR,'.coverage'),'utf8'),denied}));`], root, '', AbortSignal.timeout(30_000), { env: output.env, sandbox: { workspace: root, write: false, readOnlyPaths: [output.directory] } });
    expect(readOnly.exitCode, readOnly.stderr).toBe(0);
    expect(JSON.parse(readOnly.stdout)).toEqual({ value: 'kept', outputValue: 'kept', denied: true });
    expect(await readFile(path.join(own, '.coverage'), 'utf8')).toBe('kept');
    const overridden = await runProcess(process.execPath, ['-e', 'console.log(process.env.COVERAGE_FILE)'], root, '', AbortSignal.timeout(30_000), { env: { ...output.env, COVERAGE_FILE: 'explicit-host-coverage' }, sandbox: { workspace: root, write: false, readOnlyPaths: [output.directory] } });
    expect(overridden.exitCode, overridden.stderr).toBe(0);
    expect(overridden.stdout.trim()).toBe('explicit-host-coverage');
    const second = await execute(`const f=require('node:fs'); f.appendFileSync(process.env.COVERAGE_FILE,''); const denied=p=>{try{f.writeFileSync(p,'bad');return false}catch{return true}}; console.log(JSON.stringify({value:f.readFileSync(process.env.COVERAGE_FILE,'utf8'),root:process.env.KODO_RUN_OUTPUT_DIR,workspaceDenied:denied('no-write'),peerDenied:denied(${JSON.stringify(path.join(peerOutput.directory, 'peer'))})}));`);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ value: 'kept', root: own, workspaceDenied: true, peerDenied: true });
    const run = app.store.run(runId);
    app.store.updateRun(runId, { card: { ...run.card, tools: [...run.card.tools, 'verify.run'] } });
    const verified = await app.coordinator.tools.execute(runId, 'verify.run', {}, AbortSignal.timeout(30_000));
    expect(verified).toMatchObject({ passed: true, complete: true });
  }, 60_000);
});
