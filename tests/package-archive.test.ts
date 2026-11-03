import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { exportPackage, importPackage, inspectPackage, inspectInstalledPackage } from '../src/packages/archive.js';
import { assertManifest, validatePackagePath, PACKAGE_MANIFEST } from '../src/packages/schema.js';
import type { PackageDeclaration, PackageManifest } from '../src/packages/schema.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 20 }); });
async function directory(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-package-')); roots.push(root); return root; }
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const card = (body = 'Work carefully.', tools = 'file.read'): string => `---\nschema_version: 1\nid: test/archive\nversion: 1.0.0\nname: Archive\ndescription: Distribution fixture\ncapabilities:\n  tools: [${tools}]\n---\n${body}\n`;
const declaration = (files = ['AGENT.md']): PackageDeclaration => ({ schema_version: 1, license: 'MIT', source: { url: 'https://example.test/archive', revision: 'abc123' }, files: files.map(name => ({ path: name, distributable: true })) });
function manifest(payloads: Record<string, string | Buffer>): PackageManifest { return { ...declaration(), files: Object.entries(payloads).map(([name, value]) => ({ path: name, size: Buffer.byteLength(value), sha256: sha(value), distributable: true })) }; }
async function zip(file: string, entries: { name: string; value: string | Buffer; mode?: number }[], compress = true): Promise<void> {
  const archive = new ZipFile(); const done = pipeline(archive.outputStream, createWriteStream(file));
  for (const entry of entries) archive.addBuffer(Buffer.from(entry.value), entry.name, { ...(entry.mode === undefined ? {} : { mode: entry.mode }), compress });
  archive.end(); await done;
}
async function packageZip(file: string, payloads: Record<string, string | Buffer>, metadata: unknown = manifest(payloads), extras: { name: string; value: string }[] = []): Promise<void> {
  await zip(file, [{ name: PACKAGE_MANIFEST, value: JSON.stringify(metadata) }, ...Object.entries(payloads).map(([name, value]) => ({ name, value })), ...extras]);
}

describe('capability package archives', () => {
  it('exports only explicit distributable files, verifies hashes, and imports without project leakage', async () => {
    const root = await directory(); const source = path.join(root, 'source'); await mkdir(source);
    await writeFile(path.join(source, 'AGENT.md'), card());
    await writeFile(path.join(source, '.env'), 'PRIVATE=local-only');
    await writeFile(path.join(source, 'private.txt'), 'not distributable');
    const exported = await exportPackage(source, declaration(), path.join(root, 'package.zip'));
    expect(exported.card).toMatchObject({ id: 'test/archive', version: '1.0.0' });
    expect(exported.manifest.files.map(file => file.path)).toEqual(['AGENT.md']);
    expect((await inspectPackage(path.join(root, 'package.zip'))).digest).toBe(exported.digest);
    const installed = await importPackage(path.join(root, 'package.zip'), path.join(root, 'registry'));
    expect(installed.root).toBe(path.join(root, 'registry', 'packages', 'test', 'archive', '1.0.0'));
    expect(await readFile(path.join(installed.root, 'AGENT.md'), 'utf8')).toBe(card());
    expect(existsSync(path.join(installed.root, '.env'))).toBe(false);
    expect(existsSync(path.join(installed.root, 'private.txt'))).toBe(false);
    expect((await importPackage(path.join(root, 'package.zip'), path.join(root, 'registry'))).digest).toBe(exported.digest);
    await writeFile(path.join(installed.root, 'AGENT.md'), card('Tampered'));
    await expect(inspectInstalledPackage(installed.root)).rejects.toThrow('SHA-256');
  });

  it('has a stable semantic digest across ZIP order, compression and JSON property order', async () => {
    const root = await directory(); const payloads = { 'AGENT.md': card(), 'README.md': 'hello', 'empty.txt': '' };
    const metadata = manifest(payloads);
    await packageZip(path.join(root, 'one.zip'), payloads, metadata);
    const reversed = Object.fromEntries(Object.entries(metadata).reverse()); reversed.files = [...metadata.files].reverse();
    await zip(path.join(root, 'two.zip'), [...Object.entries(payloads).reverse().map(([name, value]) => ({ name, value })), { name: PACKAGE_MANIFEST, value: JSON.stringify(reversed, null, 2) }], false);
    expect((await inspectPackage(path.join(root, 'one.zip'))).digest).toBe((await inspectPackage(path.join(root, 'two.zip'))).digest);
  });

  it('refuses changed content at the same immutable identity and preserves the installed version', async () => {
    const root = await directory(); const registry = path.join(root, 'registry');
    await packageZip(path.join(root, 'one.zip'), { 'AGENT.md': card() });
    const first = await importPackage(path.join(root, 'one.zip'), registry);
    await packageZip(path.join(root, 'two.zip'), { 'AGENT.md': card('Different prompt') });
    await expect(importPackage(path.join(root, 'two.zip'), registry)).rejects.toThrow('different content');
    expect((await inspectInstalledPackage(first.root)).digest).toBe(first.digest);
  });

  it('rejects missing, undeclared, altered and duplicate files before making an installation', async () => {
    const root = await directory(); const archive = path.join(root, 'bad.zip');
    const good = { 'AGENT.md': card() }; const metadata = manifest(good);
    for (const [payloads, meta, extras] of [
      [{}, metadata, []],
      [good, metadata, [{ name: 'extra.txt', value: 'undeclared' }]],
      [{ 'AGENT.md': card('Changed') }, metadata, []],
      [good, metadata, [{ name: 'AGENT.md', value: card() }]],
      [good, { ...metadata, grantEverything: true }, []],
    ] as [Record<string, string>, unknown, { name: string; value: string }[]][]) {
      await packageZip(archive, payloads, meta, extras);
      await expect(importPackage(archive, path.join(root, 'registry'))).rejects.toThrow();
      expect(existsSync(path.join(root, 'registry'))).toBe(false);
    }
  });

  it('rejects duplicate JSON keys rather than allowing ambiguous authority metadata', async () => {
    const root = await directory(); const metadata = JSON.stringify(manifest({ 'AGENT.md': card() }));
    await zip(path.join(root, 'bad.zip'), [{ name: PACKAGE_MANIFEST, value: metadata.replace('"schema_version":1', '"schema_version":1,"schema_version":1') }, { name: 'AGENT.md', value: card() }]);
    await expect(inspectPackage(path.join(root, 'bad.zip'))).rejects.toThrow('duplicate keys');
  });

  it.each(['../outside', '/absolute', 'C:/drive', 'C:relative', '\\server\\share', 'path\\file', 'file:stream', 'a/../b', './file', 'file.', 'file ', 'CON', 'aux.txt', 'com¹.txt', 'a//b', '.git/config', '.env', 'nested/.env.local', 'private.key', '.ssh/id_rsa'])('rejects unsafe or private portable path %s', value => {
    expect(() => validatePackagePath(value)).toThrow();
  });

  it('rejects file, directory and case-folding collisions', () => {
    for (const names of [['AGENT.md', 'agent.md'], ['AGENT.md', 'a', 'a/b'], ['AGENT.md', 'Dir/a', 'dir/b'], ['AGENT.md', 'CAPABILITY.json/nested']]) {
      expect(() => assertManifest(manifest(Object.fromEntries(names.map(name => [name, name === 'AGENT.md' ? card() : 'data']))))).toThrow();
    }
  });

  it('rejects traversal ZIP entries and unix symbolic links', async () => {
    const root = await directory(); const unsafe = path.join(root, 'bad.zip');
    await zip(unsafe, [{ name: 'safe0file', value: 'outside' }]);
    const encoded = await readFile(unsafe);
    for (let index = 0; index < encoded.length - 8; index++) if (encoded.subarray(index, index + 9).equals(Buffer.from('safe0file'))) Buffer.from('../escape').copy(encoded, index);
    await writeFile(unsafe, encoded);
    await expect(inspectPackage(unsafe)).rejects.toThrow();
    await zip(unsafe, [{ name: 'linked', value: '/outside', mode: 0o120777 }]);
    await expect(inspectPackage(unsafe)).rejects.toThrow();
    expect(existsSync(path.join(root, 'escape'))).toBe(false);
  });

  it('rejects payload inflation and excessive entry counts while streaming', async () => {
    const root = await directory(); const archive = path.join(root, 'bomb.zip');
    await zip(archive, [{ name: 'big.txt', value: Buffer.alloc(16 * 1024 * 1024 + 1) }]);
    await expect(inspectPackage(archive)).rejects.toThrow('resource limits');
    await zip(archive, Array.from({ length: 2050 }, (_, index) => ({ name: `${index}.txt`, value: '' })));
    await expect(inspectPackage(archive)).rejects.toThrow('resource limits');
  });

  it('rejects source hardlinks, directory junctions and recognizable private keys', async () => {
    const root = await directory(); await writeFile(path.join(root, 'AGENT.md'), card());
    await link(path.join(root, 'AGENT.md'), path.join(root, 'linked.md'));
    await expect(exportPackage(root, declaration(), path.join(root, 'no.zip'))).rejects.toThrow('without links');
    await rm(path.join(root, 'linked.md'));
    const target = path.join(root, 'real'); await mkdir(target); await writeFile(path.join(target, 'data.txt'), 'payload');
    await symlink(target, path.join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(exportPackage(root, declaration(['AGENT.md', 'junction/data.txt']), path.join(root, 'no.zip'))).rejects.toThrow('symbolic links');
    await writeFile(path.join(root, 'secret.txt'), '-----BEGIN PRIVATE KEY-----\nconfidential\n-----END PRIVATE KEY-----');
    await expect(exportPackage(root, declaration(['AGENT.md', 'secret.txt']), path.join(root, 'no.zip'))).rejects.toThrow('private credential');
  });

  it('requires all referenced resources and environment references without literal credentials', () => {
    const metadata = manifest({ 'AGENT.md': card() });
    expect(() => assertManifest({ ...metadata, resources: { skills: [{ id: 'review', entry: 'SKILL.md' }] } })).toThrow('undeclared');
    expect(() => assertManifest({ ...metadata, resources: { tools: [{ name: 'x.run', descriptor: 'x.json', entry: 'x.mjs' }] } })).toThrow('undeclared');
    expect(() => assertManifest({ ...metadata, resources: { mcp: [{ id: 'remote', transport: 'http', url: 'https://example.test', headers: { Authorization: 'secret' }, tools: {} }] } })).toThrow('manifest');
    expect(() => assertManifest({ ...metadata, source: { url: 'https://user:secret@example.test' } })).toThrow('credentials');
  });

  it('imports executable resources as inert bytes without loading code or installing dependencies', async () => {
    const root = await directory(); const marker = path.join(root, 'executed.txt');
    const payloads = {
      'AGENT.md': card('Use the packaged tool.', 'custom.probe'),
      'tool.json': JSON.stringify({ format: 'kodo-tool/v1', name: 'custom.probe', description: 'Probe', parameters: { type: 'object', properties: {} }, permission: 'read', effect: 'read' }),
      'tool.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default () => ({});`,
    };
    const metadata = { ...manifest(payloads), resources: { tools: [{ name: 'custom.probe', descriptor: 'tool.json', entry: 'tool.mjs' }] }, requirements: { dependencies: { nonexistent: '1.0.0' } } };
    await packageZip(path.join(root, 'code.zip'), payloads, metadata);
    const installed = await importPackage(path.join(root, 'code.zip'), path.join(root, 'registry'));
    expect(installed.card.tools).toEqual(['custom.probe']);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(installed.root, 'node_modules'))).toBe(false);
  });

  it('rejects forged skills and invalid tool schemas before extraction', async () => {
    const root = await directory(); const file = path.join(root, 'invalid-resource.zip');
    const payloads = { 'AGENT.md': card(), 'SKILL.md': '---\nid: different\ndescription: Wrong identity\n---\nInstructions' };
    await packageZip(file, payloads, { ...manifest(payloads), resources: { skills: [{ id: 'review', entry: 'SKILL.md' }] } });
    await expect(importPackage(file, path.join(root, 'registry'))).rejects.toThrow('identity');
    const tools = { 'AGENT.md': card('Use tool', 'custom.probe'), 'tool.json': JSON.stringify({ format: 'kodo-tool/v1', name: 'custom.probe', description: 'Invalid', parameters: { type: 'array' }, permission: 'read', effect: 'write' }), 'tool.mjs': 'export default () => ({});' };
    await packageZip(file, tools, { ...manifest(tools), resources: { tools: [{ name: 'custom.probe', descriptor: 'tool.json', entry: 'tool.mjs' }] } });
    await expect(importPackage(file, path.join(root, 'registry'))).rejects.toThrow('valid capability');
    expect(existsSync(path.join(root, 'registry'))).toBe(false);
  });

  it('validates installed trees before reuse and rejects injected undeclared files', async () => {
    const root = await directory(); const archive = path.join(root, 'package.zip');
    await packageZip(archive, { 'AGENT.md': card() });
    const installed = await importPackage(archive, path.join(root, 'registry'));
    await writeFile(path.join(installed.root, 'injected.mjs'), 'throw new Error("injected")');
    await expect(inspectInstalledPackage(installed.root)).rejects.toThrow('undeclared');
    await expect(importPackage(archive, path.join(root, 'registry'))).rejects.toThrow('undeclared');
  });

  it('does not overwrite an existing output and rejects stale pinned source hashes', async () => {
    const root = await directory(); await writeFile(path.join(root, 'AGENT.md'), card());
    const output = path.join(root, 'existing.zip'); await writeFile(output, 'original');
    await expect(exportPackage(root, declaration(), output)).rejects.toThrow();
    expect(await readFile(output, 'utf8')).toBe('original');
    const pinned = declaration(); pinned.files[0]!.sha256 = 'a'.repeat(64);
    await expect(exportPackage(root, pinned, path.join(root, 'new.zip'))).rejects.toThrow('pinned');
  });
});
