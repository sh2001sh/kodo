import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout, clearTimeout } from 'node:timers';

const repository = path.resolve(import.meta.dirname, '../..');
export const piEntry = path.join(repository, '.kodo/competitor-sources/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
export function childEnvironment() {
  const names = ['SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
  return Object.fromEntries(names.filter(name => process.env[name]).map(name => [name, process.env[name]]));
}
export async function runPiNative({ workspace, directory, objective, baseURL, model, contextWindowTokens, maxOutputTokens, timeoutMs, trace = () => {} }) {
  await mkdir(directory, { recursive: true });
  const agentDirectory = path.join(directory, 'agent');
  await mkdir(agentDirectory);
  await writeFile(path.join(agentDirectory, 'models.json'), JSON.stringify({ providers: { benchmark: {
    baseUrl: baseURL, api: 'openai-completions', apiKey: 'fixture-relay-key',
    models: [{ id: model, name: model, reasoning: true, input: ['text'], contextWindow: contextWindowTokens, maxTokens: maxOutputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_completion_tokens' } }],
  } } }, null, 2));
  await writeFile(path.join(agentDirectory, 'settings.json'), JSON.stringify({ transport: 'sse', retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 }, cacheWarming: { enabled: false } }));
  const args = [piEntry, '--print', '--mode', 'json', '--provider', 'benchmark', '--model', model, '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--session-dir', path.join(directory, 'sessions'), '--tools', 'read,bash,powershell,edit,write,grep,find,ls', '--', objective];
  const events = []; const otherLines = []; const decoder = new StringDecoder('utf8');
  let pending = ''; let stderr = ''; let timedOut = false; let spawnError;
  const started = Date.now();
  const child = spawn(process.execPath, args, { cwd: workspace, env: { ...childEnvironment(), PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: '1', PI_TELEMETRY: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const line = value => {
    if (!value.trim()) return;
    try { const event = JSON.parse(value); events.push(event); trace('pi.event', event); }
    catch { otherLines.push(value); }
  };
  child.stdout.on('data', chunk => {
    pending += decoder.write(chunk);
    let index;
    while ((index = pending.indexOf('\n')) >= 0) { line(pending.slice(0, index).replace(/\r$/, '')); pending = pending.slice(index + 1); }
  });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  }, timeoutMs);
  const exit = await new Promise(resolve => {
    child.once('error', error => { spawnError = error.message; resolve({ code: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); pending += decoder.end(); if (pending) line(pending);
  const messages = events.filter(event => event.type === 'message_end').map(event => event.message);
  const final = messages.findLast(message => message?.role === 'assistant');
  const text = (final?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const error = spawnError ?? (timedOut ? 'Native Pi timed out' : undefined) ?? (exit.code !== 0 ? `Native Pi exit ${exit.code}` : undefined) ?? (!final || ['error', 'aborted', 'length', 'toolUse'].includes(final.stopReason) ? final?.errorMessage ?? `Incomplete final message: ${final?.stopReason}` : undefined);
  const result = { status: error ? 'failed' : 'completed', error, text, events, executionMs: Date.now() - started, nativeOutcome: { ...exit, timedOut }, otherLines };
  await writeFile(path.join(directory, 'native-events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(path.join(directory, 'native-stderr.log'), stderr);
  await writeFile(path.join(directory, 'native-result.json'), JSON.stringify(result, null, 2));
  return result;
}
