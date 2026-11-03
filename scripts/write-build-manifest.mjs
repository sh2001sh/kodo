import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const BUILD_MANIFEST_PATH = 'dist/.kodo-build-manifest.json';

const toPosix = value => value.split(path.sep).join('/');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function walk(root, relative = '') {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...walk(root, next));
    else if (entry.isFile()) files.push(toPosix(next));
  }
  return files;
}

export function contentManifest(repository, files) {
  const hashes = {};
  for (const relative of [...new Set(files)].sort()) {
    const absolute = path.join(repository, relative);
    if (!existsSync(absolute)) throw new Error(`manifest input is missing: ${relative}`);
    hashes[relative] = sha256(readFileSync(absolute));
  }
  return { digest: sha256(JSON.stringify(hashes)), count: Object.keys(hashes).length, files: hashes };
}

export function buildInputFiles(repository) {
  return [
    ...walk(path.join(repository, 'src')).filter(file => !file.startsWith('sandbox/windows/build/') && /\.(?:ts|cjs|cs|cc|h|gyp)$/.test(file)).map(file => `src/${file}`),
    ...['package.json', 'tsconfig.json', 'tsconfig.build.json', 'scripts/build-windows-pipes.mjs'].filter(file => existsSync(path.join(repository, file))),
  ];
}

export function buildOutputFiles(repository) {
  return walk(path.join(repository, 'dist'))
    .map(file => `dist/${file}`)
    .filter(file => file !== BUILD_MANIFEST_PATH && /\.(?:js|d\.ts|map|node)$/.test(file));
}

export function createBuildManifest(repository) {
  return {
    version: 1,
    buildCommand: 'npm run build',
    builtAt: new Date().toISOString(),
    node: process.version,
    source: contentManifest(repository, buildInputFiles(repository)),
    dist: contentManifest(repository, buildOutputFiles(repository)),
  };
}

export function verifyBuildManifest(repository) {
  const manifestPath = path.join(repository, BUILD_MANIFEST_PATH);
  if (!existsSync(manifestPath)) throw new Error(`build manifest is missing: ${BUILD_MANIFEST_PATH}; run npm run build`);
  const recorded = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const source = contentManifest(repository, buildInputFiles(repository));
  const dist = contentManifest(repository, buildOutputFiles(repository));
  const problems = [];
  if (recorded?.source?.digest !== source.digest) problems.push(`source digest changed (${recorded?.source?.digest ?? 'missing'} != ${source.digest})`);
  if (recorded?.dist?.digest !== dist.digest) problems.push(`dist digest changed (${recorded?.dist?.digest ?? 'missing'} != ${dist.digest})`);
  return { ok: problems.length === 0, problems, recorded, current: { source, dist } };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const repository = path.resolve(import.meta.dirname, '..');
  const manifest = createBuildManifest(repository);
  writeFileSync(path.join(repository, BUILD_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`build manifest: source=${manifest.source.digest} dist=${manifest.dist.digest}\n`);
}
