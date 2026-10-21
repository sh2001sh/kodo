import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.join(repository, '.kodo/competitor-sources/opencode/runtime/node_modules/opencode-windows-x64/bin/opencode.exe');
const environmentKeys = ['SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];

function environment(directory, config, unrestricted = false, maxOutputTokens = 3072) {
  const env = Object.fromEntries(environmentKeys.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  const state = path.join(directory, 'state');
  return {
    ...env,
    KODO_API_KEY: 'fixture-relay-key',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...(unrestricted ? { OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: String(maxOutputTokens) } : {}),
    OPENCODE_TEST_HOME: path.join(state, 'home'),
    XDG_DATA_HOME: path.join(state, 'data'),
    XDG_CACHE_HOME: path.join(state, 'cache'),
    XDG_CONFIG_HOME: path.join(state, 'config'),
    XDG_STATE_HOME: path.join(state, 'state'),
  };
}

function configuration(baseURL, model, maxModelCalls, maxOutputTokens = 3072, singleAgent = false, contextWindowTokens = 256000, unrestricted = false) {
  return {
    model: `codego/${model}`,
    small_model: `codego/${model}`,
    enabled_providers: ['codego'],
    provider: {
      codego: {
        npm: '@ai-sdk/openai-compatible', env: ['KODO_API_KEY'],
        options: { baseURL, ...(unrestricted ? { timeout: false, headerTimeout: false, chunkTimeout: false } : { timeout: 120000 }) },
        models: { [model]: { name: model, tool_call: true, limit: { context: contextWindowTokens, output: maxOutputTokens } } },
      },
    },
    agent: { build: { steps: maxModelCalls } },
    permission: singleAgent ? { '*': 'allow', task: 'deny' } : 'allow', autoupdate: false, share: 'disabled', plugin: [],
  };
}

async function execute(args, { cwd, env, timeoutMs, stdoutFile, stderrFile, onLine }) {
  const stderr = await open(stderrFile, 'w');
  const stdoutChunks = [];
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let timedOut = false;
  let spawnError;
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', stderr.fd] });
  child.stdout.on('data', (chunk) => {
    stdoutChunks.push(chunk);
    const value = decoder.write(chunk);
    pending += value;
    let index;
    while ((index = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      onLine?.(line);
    }
  });
  const timer = timeoutMs == null ? undefined : setTimeout(() => {
    timedOut = true;
    spawn(path.join(env.SystemRoot ?? env.WINDIR ?? 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }, timeoutMs);
  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error.message; resolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  pending += decoder.end();
  if (pending) onLine?.(pending);
  await writeFile(stdoutFile, Buffer.concat(stdoutChunks));
  await stderr.close();
  return { ...outcome, timedOut, ...(spawnError ? { spawnError } : {}) };
}

export async function runOpenCode({ workspace, directory, objective, baseURL, model, maxModelCalls = 26, timeoutMs = 240000, maxOutputTokens = 3072, singleAgent = false, contextWindowTokens = 256000, unrestricted = false, trace = () => {} }) {
  directory = path.resolve(directory);
  workspace = path.resolve(workspace);
  await mkdir(directory, { recursive: true });
  const config = configuration(baseURL, model, maxModelCalls, maxOutputTokens, singleAgent, contextWindowTokens, unrestricted);
  const env = environment(directory, config, unrestricted, maxOutputTokens);
  await writeFile(path.join(directory, 'native-config.json'), JSON.stringify(config, null, 2));
  const events = [];
  const startedAt = Date.now();
  const outcome = await execute(['run', '--pure', '--format', 'json', '--model', `codego/${model}`, '--agent', 'build', '--title', 'Harness comparison', '--dir', workspace, objective], {
    cwd: workspace, env, timeoutMs,
    stdoutFile: path.join(directory, 'native-events.jsonl'), stderrFile: path.join(directory, 'native-stderr.log'),
    onLine(line) {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        events.push(event);
        trace('opencode.event', event);
      } catch {
        trace('opencode.non_json_stdout', { line });
      }
    },
  });
  const executionMs = Date.now() - startedAt;
  const sessionId = events.find((event) => typeof event.sessionID === 'string')?.sessionID;
  let session;
  let exportOutcome;
  if (sessionId) {
    exportOutcome = await execute(['export', sessionId, '--pure'], {
      cwd: workspace, env, timeoutMs: 30000,
      stdoutFile: path.join(directory, 'native-session.json'), stderrFile: path.join(directory, 'native-export-stderr.log'),
    });
    if (exportOutcome.code === 0) {
      try { session = JSON.parse(await readFile(path.join(directory, 'native-session.json'), 'utf8')); }
      catch (error) { exportOutcome.parseError = error.message; }
    }
  }
  const toolEvents = events.filter((event) => event.type === 'tool_use');
  const completedTools = toolEvents.map((event) => event.part).filter((part) => part?.state?.status === 'completed');
  const reads = [...new Set(completedTools.filter((part) => part.tool === 'read').map((part) => part.state.input.filePath).filter((value) => typeof value === 'string'))];
  const reports = [...new Set(completedTools.filter((part) => ['write', 'edit'].includes(part.tool)).map((part) => part.state.input.filePath).filter((value) => typeof value === 'string' && /\.md$/i.test(value) && path.basename(value).toLowerCase() !== 'readme.md'))];
  const processEvidence = toolEvents.map((event) => event.part).filter((part) => part?.tool === 'bash').map((part) => ({
    command: part.state.input.command, workdir: part.state.input.workdir ?? workspace,
    status: part.state.status, exitCode: part.state.metadata?.exit,
    output: part.state.output ?? '', error: part.state.error,
  }));
  const messages = session?.messages ?? [];
  const lastAssistant = messages.findLast((message) => message.info?.role === 'assistant');
  const text = lastAssistant
    ? lastAssistant.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    : events.filter((event) => event.type === 'text').map((event) => event.part.text).join('\n');
  const emittedError = events.find((event) => event.type === 'error')?.error;
  const exportFailed = Boolean(sessionId && (exportOutcome?.code !== 0 || exportOutcome?.parseError));
  const incomplete = !lastAssistant?.info?.time?.completed || !lastAssistant.info.finish || ['tool-calls', 'unknown', 'length'].includes(lastAssistant.info.finish);
  const error = outcome.spawnError ?? (outcome.timedOut ? 'Native process timed out' : undefined) ?? emittedError ?? lastAssistant?.info?.error ?? (exportFailed ? 'Native session export failed' : undefined) ?? (outcome.code !== 0 ? `Native exit ${outcome.code}` : undefined) ?? (incomplete ? 'No completed final assistant message' : undefined);
  const toolParts = session ? messages.flatMap(message => message.parts ?? []).filter(part => part.type === 'tool') : undefined;
  const result = { status: error ? 'failed' : 'completed', ...(error ? { error } : {}), text, reads, reports, processEvidence, sessionId, events, toolParts, executionMs, nativeOutcome: outcome, exportOutcome };
  await writeFile(path.join(directory, 'native-result.json'), JSON.stringify(result, null, 2));
  return result;
}

export async function smokeOpenCode(directory) {
  directory = path.resolve(directory);
  await mkdir(directory, { recursive: true });
  const env = environment(directory, configuration('http://127.0.0.1:1/v1', 'glm-5.3', 26));
  const result = {};
  for (const [name, args] of [['version', ['--version']], ['help', ['run', '--help']], ['config', ['debug', 'config', '--pure']], ['models', ['models', 'codego', '--pure']]]) {
    result[name] = await execute(args, { cwd: repository, env, timeoutMs: 30000, stdoutFile: path.join(directory, `${name}.stdout.log`), stderrFile: path.join(directory, `${name}.stderr.log`) });
  }
  return result;
}
