import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

if (process.platform === 'win32') {
  const require = createRequire(import.meta.url);
  const root = path.resolve(import.meta.dirname, '..');
  const native = path.join(root, 'src', 'sandbox', 'windows');
  const result = spawnSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--release', '--directory', native], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows pipe adapter build failed (${result.signal ?? result.status}); install MSVC C++ build tools and the Windows SDK`);
  const output = path.join(root, 'dist', 'sandbox', 'windows');
  mkdirSync(output, { recursive: true });
  copyFileSync(path.join(native, 'build', 'Release', 'kodo_node_pipes.node'), path.join(output, 'node-pipes.node'));
}
