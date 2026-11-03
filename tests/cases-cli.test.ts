import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { caseCommand } from '../src/cases/cli.js';
import { PackageRegistry } from '../src/packages/registry.js';
import { exportPackage } from '../src/packages/archive.js';
import { delta, sendStream } from './http-server.js';

const cleanup: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); process.exitCode = 0; delete process.env.KODO_CASE_CLI_FIXTURE_KEY; for (const directory of cleanup.splice(0)) await rm(directory, { force: true, recursive: true }); });
async function directory(): Promise<string> { const result = await mkdtemp(path.join(os.tmpdir(), 'kodo-case-cli-')); cleanup.push(result); return result; }
describe('case CLI', () => {
  it('runs an imported package against frozen inputs, lists and inspects evidence, then adopts it', async () => {
    const source = await directory(); const data = await directory();
    await writeFile(path.join(source, 'AGENT.md'), '---\nschema_version: 1\nid: example/cli\nversion: 1.0.0\nname: CLI fixture\ndescription: Return JSON for a case.\ncapabilities:\n  tools: []\n---\nReturn a JSON object with answer 42.\n');
    const archive = path.join(source, 'fixture.zip');
    await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.com' }, files: [{ path: 'AGENT.md', distributable: true }] }, archive);
    await new PackageRegistry(path.join(data, 'capabilities')).import(archive);
    const file = path.join(source, 'case.json');
    await writeFile(file, JSON.stringify({ schema_version: 1, id: 'cli/json', version: '1.0.0', name: 'CLI JSON', objective: 'Return answer as JSON.', inputs: { files: [], data: { answer: 42 } }, assertions: [{ type: 'json', source: 'output', pointer: '/answer', equals: 42 }] }));
    const server = createServer((request, response) => { request.resume(); sendStream(response, [delta({ content: '{"answer":42}' }), delta({}, 'stop')]); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    process.env.KODO_CASE_CLI_FIXTURE_KEY = 'fixture-key';
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await caseCommand(['run', file, '--package', 'example/cli@1.0.0', '--data-dir', data, '--model', 'fixture', '--base-url', `http://127.0.0.1:${address.port}/v1`, '--api-key-env', 'KODO_CASE_CLI_FIXTURE_KEY', '--json']);
      const result = JSON.parse(output.mock.calls.at(-1)![0] as string) as { id: string; status: string; workspace: string; error?: string };
      cleanup.push(result.workspace);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe('passed');
      await caseCommand(['list', '--data-dir', data, '--json']);
      expect(JSON.parse(output.mock.calls.at(-1)![0] as string)).toMatchObject({ items: [{ id: result.id, status: 'passed' }], next: null });
      await caseCommand(['inspect', result.id, '--data-dir', data, '--json']);
      expect(JSON.parse(output.mock.calls.at(-1)![0] as string).id).toBe(result.id);
      await caseCommand(['compare', result.id, result.id, '--data-dir', data, '--json']);
      expect(JSON.parse(output.mock.calls.at(-1)![0] as string).passed).toBe(true);
      await caseCommand(['adopt', 'example/cli@1.0.0', '--runs', result.id, '--data-dir', data, '--json']);
      expect(JSON.parse(output.mock.calls.at(-1)![0] as string).verification.runIds).toEqual([result.id]);
      expect(output.mock.calls.map(call => call[0]).join('')).not.toContain('fixture-key');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('rejects irrelevant execution grants and invalid pagination rather than silently ignoring them', async () => {
    await expect(caseCommand(['list', '--allow-exec'])).rejects.toThrow('only valid');
    await expect(caseCommand(['compare', 'one'])).rejects.toThrow('target count');
    await expect(caseCommand(['list', '--data-dir', await directory(), '--limit', 'NaN'])).rejects.toThrow('limit');
  });
});
