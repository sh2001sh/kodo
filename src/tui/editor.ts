import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KodoError } from '../runtime/types.js';

/** Accept a complete executable path, or a small quoted argv syntax, never shell expressions. */
export function editorArguments(environment: NodeJS.ProcessEnv = process.env): string[] {
  const encoded = environment.KODO_EDITOR_JSON;
  if (encoded) {
    let parsed: unknown;
    try { parsed = JSON.parse(encoded); } catch { throw new KodoError('EDITOR_CONFIG', 'KODO_EDITOR_JSON must be a JSON array containing the executable and arguments.'); }
    if (!Array.isArray(parsed) || !parsed.length || parsed.some(value => typeof value !== 'string' || !value || value.includes('\0'))) throw new KodoError('EDITOR_CONFIG', 'KODO_EDITOR_JSON must be an array of non-empty string arguments.');
    return parsed as string[];
  }
  const source = environment.VISUAL ?? environment.EDITOR;
  if (!source) return [process.platform === 'win32' ? 'notepad.exe' : 'vi'];
  // An absolute Windows executable path may contain unquoted spaces.
  if (/^(?:[a-z]:[\\/]|\\\\).+\.(?:exe|com)$/iu.test(source.trim())) return [source.trim()];
  if (/[;&|<>`\r\n]/u.test(source)) throw new KodoError('EDITOR_CONFIG', 'Editor configuration does not support shell expressions. Set KODO_EDITOR_JSON or use /paste.');
  const result: string[] = [];
  let value = '', quote = '';
  for (const character of source.trim()) {
    if (quote) { if (character === quote) quote = ''; else value += character; }
    else if (character === '"' || character === "'") quote = character;
    else if (/\s/u.test(character)) { if (value) { result.push(value); value = ''; } }
    else value += character;
  }
  if (quote) throw new KodoError('EDITOR_CONFIG', 'Unclosed editor quote. Use KODO_EDITOR_JSON.');
  if (value) result.push(value);
  if (!result.length || result.some(argument => argument.includes('\0'))) throw new KodoError('EDITOR_CONFIG', 'Editor executable cannot be empty.');
  return result;
}

export async function editDraft(text: string, options: { environment?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<string> {
  const [program, ...args] = editorArguments(options.environment);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-editor-'));
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('kodo-editor-')) throw new KodoError('EDITOR_PATH', 'Unexpected editor temporary directory location.');
  const file = path.join(directory, 'message.md');
  try {
    await writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(program!, [...args, file], { stdio: 'inherit', shell: false, windowsHide: false, signal: options.signal });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new KodoError('EDITOR_EXIT', `Editor exit code ${code ?? 'unknown'}; the original draft was kept.`)));
    });
    const content = await readFile(file, 'utf8');
    if (Buffer.byteLength(content) > 128_000) throw new KodoError('EDITOR_SIZE', 'Editor content exceeds 128 KB; the original draft was kept.');
    return content;
  } finally {
    // Only the freshly created private temp directory is removed.
    await rm(resolved, { recursive: true, force: true });
  }
}
