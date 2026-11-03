import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, stat, link, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import * as yauzl from 'yauzl';
import { ZipFile } from 'yazl';
import { parseDocument } from 'yaml';
import { parseCard } from '../agents/card.js';
import { builtinToolNames } from '../tools/index.js';
import { hostToolNames } from '../tools/catalog.js';
import { ToolRegistry } from '../tools/registry.js';
import { PACKAGE_LIMITS, PACKAGE_MANIFEST, assertManifest, packageError, validatePackagePath } from './schema.js';
import type { InstalledPackage, PackageDeclaration, PackageInspection, PackageManifest } from './schema.js';

const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function canonicalManifest(manifest: PackageManifest): PackageManifest {
  return canonical({ ...manifest, files: [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }) as PackageManifest;
}
function json(buffer: Buffer): unknown {
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw packageError('package metadata must contain valid UTF-8'); }
  try {
    const value: unknown = JSON.parse(source);
    // JSON.parse alone silently accepts duplicate keys, which can change the
    // meaning of a manifest between independent consumers.
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) throw new Error();
    return value;
  } catch { throw packageError('package metadata must contain JSON without duplicate keys'); }
}
function rejectSecrets(buffer: Buffer): void {
  const content = buffer.toString('utf8');
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(content) || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(content) || /\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(content) || /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/.test(content)) throw packageError('package contains a recognizable private credential');
}

/** All metadata and payload hashes are checked before this returns. No code is loaded. */
function inspectFiles(files: Map<string, Buffer>): PackageInspection {
  const encoded = files.get(PACKAGE_MANIFEST);
  if (!encoded || encoded.length > PACKAGE_LIMITS.manifestBytes) throw packageError('package needs a bounded CAPABILITY.json manifest');
  rejectSecrets(encoded);
  const value = json(encoded); assertManifest(value);
  const manifest = canonicalManifest(value);
  if (files.size !== manifest.files.length + 1) throw packageError('archive contains undeclared or missing files');
  let bytes = 0;
  for (const file of manifest.files) {
    const content = files.get(file.path);
    if (!content || content.length !== file.size || hash(content) !== file.sha256) throw packageError('package file size or SHA-256 does not match its declaration');
    rejectSecrets(content); bytes += content.length;
  }
  const names = [...(manifest.resources?.tools ?? []).map(tool => tool.name), ...(manifest.resources?.mcp ?? []).flatMap(server => Object.keys(server.tools).map(name => `mcp.${server.id}.${name}`)), ...hostToolNames];
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(files.get('AGENT.md')!); }
  catch { throw packageError('AGENT.md must contain valid UTF-8'); }
  const card = parseCard(source, { toolNames: names, skillIds: (manifest.resources?.skills ?? []).map(skill => skill.id) });
  for (const skill of manifest.resources?.skills ?? []) {
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(files.get(skill.entry)!).replaceAll('\r\n', '\n'); }
    catch { throw packageError('packaged skill must contain valid UTF-8'); }
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
    if (!match || Buffer.byteLength(content) > 128_000 || content.includes('\0') || !content.slice(match[0].length).trim()) throw packageError('packaged skill needs bounded front matter and instructions');
    const document = parseDocument(match[1]!, { uniqueKeys: true });
    if (document.errors.length) throw packageError('packaged skill contains invalid front matter');
    const meta: unknown = document.toJS({ maxAliasCount: 20 });
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw packageError('packaged skill contains invalid front matter');
    const fields = meta as Record<string, unknown>;
    if ((fields.id ?? fields.name) !== skill.id || typeof fields.description !== 'string' || !fields.description.trim() || fields.description.length > 2000) throw packageError('skill identity or description does not match its declaration');
  }
  const tools = new ToolRegistry([...builtinToolNames, ...hostToolNames]);
  for (const tool of manifest.resources?.tools ?? []) {
    const descriptor = json(files.get(tool.descriptor)!);
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || (descriptor as Record<string, unknown>).format !== 'kodo-tool/v1' || (descriptor as Record<string, unknown>).name !== tool.name) throw packageError('tool descriptor identity does not match its resource declaration');
    const fields = descriptor as Record<string, unknown>;
    if (Object.keys(fields).some(name => !['format', 'name', 'description', 'parameters', 'permission', 'effect', 'version'].includes(name))) throw packageError('tool descriptor contains unsupported fields');
    try {
      tools.register({ name: tool.name, description: fields.description as string, parameters: fields.parameters as Record<string, unknown>, permission: fields.permission as 'read' | 'write' | 'exec', effect: fields.effect as 'read' | 'write', ...(fields.version === undefined ? {} : { version: fields.version as string }), execute: () => null });
    } catch { throw packageError('packaged tool descriptor does not define a valid capability'); }
  }
  // A semantic hash excludes ZIP order, timestamps and compression differences.
  return { manifest, card, digest: hash(JSON.stringify(manifest)), bytes };
}

async function readArchive(archivePath: string): Promise<Map<string, Buffer>> {
  const info = await lstat(archivePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > PACKAGE_LIMITS.archiveBytes) throw packageError('archive must be a regular bounded file without links');
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error, zip) => {
      if (error || !zip) { reject(packageError('cannot read ZIP archive')); return; }
      const files = new Map<string, Buffer>(); const folded = new Set<string>();
      let total = 0; let count = 0; let settled = false;
      const fail = (): void => { if (!settled) { settled = true; zip.close(); reject(packageError('ZIP is corrupt, unsafe, or exceeds resource limits')); } };
      zip.on('error', fail);
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          validatePackagePath(entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          const maximum = entry.fileName === PACKAGE_MANIFEST ? PACKAGE_LIMITS.manifestBytes : PACKAGE_LIMITS.fileBytes;
          // Permit only regular files. Unix symlinks, device files and directory
          // entries are rejected, as are encrypted payloads and unsupported codecs.
          if (++count > PACKAGE_LIMITS.files + 1 || (mode !== 0 && mode !== 0x8000) || (entry.externalFileAttributes & 0x10) !== 0 || (entry.generalPurposeBitFlag & 1) !== 0 || ![0, 8].includes(entry.compressionMethod) || entry.uncompressedSize > maximum || entry.compressedSize > PACKAGE_LIMITS.archiveBytes || folded.has(entry.fileName.toLowerCase())) throw packageError('unsafe ZIP entry');
          folded.add(entry.fileName.toLowerCase());
          const stream = await new Promise<Readable>((accept, decline) => zip.openReadStream(entry, (err, input) => err || !input ? decline(err ?? packageError('missing ZIP stream')) : accept(input)));
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            size += bytes.length; total += bytes.length;
            if (size > maximum || total > PACKAGE_LIMITS.totalBytes + PACKAGE_LIMITS.manifestBytes) { stream.destroy(); throw packageError('ZIP expands beyond the allowed limit'); }
            chunks.push(bytes);
          }
          if (size !== entry.uncompressedSize) throw packageError('ZIP entry size is inconsistent');
          files.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        })().catch(fail);
      });
      zip.on('end', () => { if (!settled) { settled = true; zip.close(); resolve(files); } });
      zip.readEntry();
    });
  });
}

/** Inspect an untrusted ZIP without extracting it, loading modules or installing dependencies. */
export async function inspectPackage(archivePath: string): Promise<PackageInspection> { return inspectFiles(await readArchive(archivePath)); }

/** Assert every existing component is a real directory rather than a link. */
async function safeDirectory(directory: string, create = false): Promise<string> {
  const absolute = path.resolve(directory); const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw packageError('package directories must not contain symbolic links');
  }
  return realpath(absolute);
}

async function readSource(root: string, relative: string, maximum = PACKAGE_LIMITS.fileBytes): Promise<Buffer> {
  validatePackagePath(relative);
  const target = path.join(root, ...relative.split('/'));
  await safeDirectory(path.dirname(target));
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw packageError('package payload must be a regular bounded file without links');
  const handle = await open(target, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximum || await realpath(target) !== target) throw packageError('package source changed or follows a link');
    const content = await handle.readFile(); const after = await handle.stat();
    if (content.length > maximum || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw packageError('package file changed while being read');
    return content;
  } finally { await handle.close(); }
}

/** Export only explicitly distributable declarations; never walk the source project. */
export async function exportPackage(sourceDirectory: string, declaration: PackageDeclaration, outputPath: string): Promise<PackageInspection> {
  const root = await safeDirectory(sourceDirectory);
  if (!declaration || !Array.isArray(declaration.files) || declaration.files.length > PACKAGE_LIMITS.files) throw packageError('explicit package files are required');
  const files = new Map<string, Buffer>(); let total = 0;
  for (const file of declaration.files) {
    if (file.distributable !== true) throw packageError('every exported file requires distributable: true');
    const content = await readSource(root, file.path);
    if ((file.size !== undefined && file.size !== content.length) || (file.sha256 !== undefined && file.sha256 !== hash(content))) throw packageError('source does not match the pinned file declaration');
    files.set(file.path, content); total += content.length;
    if (total > PACKAGE_LIMITS.totalBytes) throw packageError('package exceeds the payload limit');
  }
  const manifest = { ...declaration, files: declaration.files.map(file => ({ path: file.path, sha256: hash(files.get(file.path)!), size: files.get(file.path)!.length, distributable: file.distributable })) };
  assertManifest(manifest);
  const canonical = canonicalManifest(manifest);
  files.set(PACKAGE_MANIFEST, Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8'));
  const inspection = inspectFiles(files);
  const output = path.resolve(outputPath); await safeDirectory(path.dirname(output));
  const temporary = path.join(path.dirname(output), `.kodo-export-${randomUUID()}.tmp`);
  try {
    const zip = new ZipFile();
    const pending = pipeline(zip.outputStream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    for (const [name, content] of [...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) zip.addBuffer(content, name, { mtime: new Date('1980-01-01T00:00:00Z'), mode: 0o100644 });
    zip.end(); await pending;
    if ((await stat(temporary)).size > PACKAGE_LIMITS.archiveBytes) throw packageError('compressed archive exceeds the output limit');
    // Exclusive publication never overwrites an existing archive supplied by the host.
    await link(temporary, output);
    return inspection;
  } finally { await rm(temporary, { force: true }); }
}

/** Validate an installed tree against its original manifest before every activation. */
export async function inspectInstalledPackage(directory: string): Promise<InstalledPackage> {
  const root = await safeDirectory(directory);
  const encoded = await readSource(root, PACKAGE_MANIFEST, PACKAGE_LIMITS.manifestBytes);
  const value = json(encoded); assertManifest(value);
  const files = new Map<string, Buffer>([[PACKAGE_MANIFEST, encoded]]);
  for (const file of value.files) files.set(file.path, await readSource(root, file.path));
  const declared = new Set(files.keys()); let count = 0;
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (++count > PACKAGE_LIMITS.files * 2 + 1) throw packageError('installed tree contains too many entries');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw packageError('installed package contains a link');
      if (entry.isDirectory()) await walk(name);
      else if (!entry.isFile() || !declared.has(name)) throw packageError('installed package contains undeclared files');
    }
  };
  await walk('');
  return { ...inspectFiles(files), root };
}

/** Validate completely, then atomically install. Import performs no executable work. */
export async function importPackage(archivePath: string, registryDirectory: string): Promise<InstalledPackage> {
  const files = await readArchive(archivePath); const inspection = inspectFiles(files);
  const registry = await safeDirectory(registryDirectory, true);
  const packages = await safeDirectory(path.join(registry, 'packages'), true);
  const final = path.join(packages, ...inspection.card.id.split('/'), inspection.card.version);
  await safeDirectory(path.dirname(final), true);
  const existing = async (): Promise<InstalledPackage | undefined> => {
    try { await lstat(final); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const installed = await inspectInstalledPackage(final);
    if (installed.card.id !== inspection.card.id || installed.card.version !== inspection.card.version || installed.digest !== inspection.digest) throw packageError('an installed package already owns this identity and version with different content');
    return installed;
  };
  const found = await existing(); if (found) return found;
  const temporary = path.join(packages, `.install-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const [name, content] of files) {
      const target = path.join(temporary, ...name.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    }
    try { await rename(temporary, final); }
    catch (error) { const raced = await existing(); if (raced) return raced; throw error; }
    return { ...inspection, root: final };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
