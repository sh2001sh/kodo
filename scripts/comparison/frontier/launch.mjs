// CLI-only adapters; no agent implementation, prompt, or tool is replaced.
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';

/** New trials choose isolation explicitly; old frozen launch configs keep their original meaning. */
export function selectKodoSandbox(profile, enabled = false, disabled = false) {
  if (enabled && disabled) throw new Error('Choose only one of --kodo-sandbox and --kodo-no-sandbox');
  return enabled || (!disabled && profile === 'lean-team');
}

/** Runs before any provider/relay request. A failed isolation probe never falls back. */
export async function sandboxPreflight(executable, cli, cwd, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [cli, 'doctor', '--sandbox', '--json', ...(env.KODO_HOME ? ['--data-dir', path.join(env.KODO_HOME, 'sandbox-preflight')] : [])], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0) { reject(new Error(`Kodo sandbox preflight failed (${timedOut ? 'timeout' : code}): ${stderr.slice(-2000)}`)); return; }
      try {
        const result = JSON.parse(stdout);
        if (result.sandbox?.passed !== true) throw new Error('Sandbox probe did not confirm isolation');
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

export function kodoConcurrencyArgs(config = {}) {
  const args = [];
  for (const [field, flag] of [['maxConcurrentModels', '--max-concurrent-models'], ['maxActiveChildren', '--max-active-children']]) {
    if (config[field] === undefined) continue;
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(`Invalid Kodo concurrency ${field}`);
    args.push(flag, String(config[field]));
  }
  return args;
}

export function kodoSandboxArgs(enabled) {
  if (enabled === undefined || enabled === false) return [];
  if (enabled !== true) throw new Error('Invalid frozen Kodo sandbox selection');
  return ['--sandbox'];
}

/** Preserve cancellation through the container-local hop, not only the recording relay. */
export function createLocalRelay({ hostname = 'fh-relay', port = 4010 } = {}) {
  return createServer((incoming, outgoing) => {
    const remote = httpRequest({ hostname, port, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
      if (outgoing.destroyed) { response.destroy(); return; }
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.on('error', () => outgoing.destroy());
      response.pipe(outgoing);
    });
    outgoing.on('close', () => { if (!outgoing.writableFinished) remote.destroy(); });
    incoming.on('aborted', () => remote.destroy());
    incoming.on('error', error => remote.destroy(error));
    remote.on('error', error => {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) { outgoing.destroy(error); return; }
      outgoing.writeHead(502); outgoing.end(String(error.message));
    });
    incoming.pipe(remote);
  });
}

async function launch() {
  const config = JSON.parse(await readFile('/fh-config/trial.json', 'utf8'));
  const { harness, model, contextTokens, outputTokens, timeoutSec, kodoAblation, kodoFactors, kodoToolProfile } = config;
  const objective = await readFile('/fh-config/instruction.md', 'utf8');
  const baseURL = 'http://127.0.0.1:4011/v1';
  const state = '/fh-state';
  await mkdir(state, { recursive: true });
  const env = { ...process.env, HOME: '/root', FH_RELAY_KEY: 'frontier-relay-stub', KODO_HOME: `${state}/kodo-home`, PI_CODING_AGENT_DIR: `${state}/pi`, PI_OFFLINE: '1', PI_TELEMETRY: '0', DSH_HOME: `${state}/dsh`, DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'danger-full-access',
    PATH: `/opt/fh/bin:${process.env.PATH}`, ...(kodoAblation ? { KODO_ABLATION: kodoAblation } : {}) };
  if (harness === 'kodo' && kodoSandboxArgs(config.kodoSandbox).length) {
    try {
      const probe = await sandboxPreflight('/opt/fh/bin/node', '/opt/fh/kodo/dist/cli/index.js', '/app', env);
      await writeFile(`${state}/sandbox-preflight.json`, JSON.stringify(probe, null, 2));
    } catch (error) {
      await writeFile(`${state}/sandbox-preflight.json`, JSON.stringify({ sandbox: { passed: false }, error: String(error) }, null, 2));
      throw error;
    }
  }
  const localRelay = createLocalRelay();
  await new Promise(resolve => localRelay.listen(4011, '127.0.0.1', resolve));
  let executable = '/opt/fh/bin/node'; let args;
  if (harness === 'kodo') {
    args = ['/opt/fh/kodo/dist/cli/index.js', 'run', objective, '--json', '--workspace', '/app', '--data-dir', `${state}/kodo`, '--allow-write', '--allow-exec', '--shell-program', '/bin/bash', '--model', model, '--base-url', baseURL, '--protocol', 'chat-completions', '--api-key-env', 'FH_RELAY_KEY', '--max-context-tokens', String(contextTokens), '--max-output-tokens', String(outputTokens), '--timeout-ms', String(timeoutSec * 1000), '--tool-timeout-ms', '120000'];
    if (kodoFactors !== undefined) {
      if (typeof kodoFactors !== 'string' || !/^(?:none|[ABCDE](?:,[ABCDE])*)$/u.test(kodoFactors)) throw new Error('Invalid frozen Kodo factor selection');
      args.push('--agent-factors', kodoFactors);
    }
    if (kodoToolProfile !== undefined) {
      if (!['compact-v1', 'compact-v2', 'full', 'lean-solo', 'lean-team'].includes(kodoToolProfile)) throw new Error('Invalid frozen Kodo tool profile');
      args.push('--tool-profile', kodoToolProfile);
    }
    args.push(...kodoConcurrencyArgs(config.kodoConcurrency));
    args.push(...kodoSandboxArgs(config.kodoSandbox));
    if (config.kodoMethodArm) args = ['/fh-config/method-worker.mjs'];
  } else if (harness === 'pi') {
    await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
    await writeFile(path.join(env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { benchmark: { baseUrl: baseURL, api: 'openai-completions', apiKey: 'frontier-relay-stub', models: [{ id: model, name: model, reasoning: true, input: ['text'], contextWindow: contextTokens, maxTokens: outputTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_completion_tokens' } }] } } }));
    await writeFile(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ transport: 'sse', cacheWarming: { enabled: false } }));
    args = ['/opt/fh/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', '--print', '--mode', 'json', '--provider', 'benchmark', '--model', model, '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--session-dir', `${state}/pi-sessions`, '--', objective];
  } else if (harness === 'opencode') {
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: `benchmark/${model}`, small_model: `benchmark/${model}`, enabled_providers: ['benchmark'], provider: { benchmark: { npm: '@ai-sdk/openai-compatible', env: ['FH_RELAY_KEY'], options: { baseURL, timeout: false, headerTimeout: false, chunkTimeout: false }, models: { [model]: { name: model, tool_call: true, limit: { context: contextTokens, output: outputTokens } } } } }, permission: 'allow', autoupdate: false, share: 'disabled', plugin: [] });
    for (const name of ['MODELS_FETCH', 'PROJECT_CONFIG', 'DEFAULT_PLUGINS', 'EXTERNAL_SKILLS', 'CLAUDE_CODE', 'LSP_DOWNLOAD', 'AUTOUPDATE']) env[`OPENCODE_DISABLE_${name}`] = '1';
    env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(outputTokens);
    env.OPENCODE_TEST_HOME = `${state}/opencode/home`;
    for (const name of ['DATA', 'CACHE', 'CONFIG', 'STATE']) env[`XDG_${name}_HOME`] = `${state}/opencode/${name.toLowerCase()}`;
    executable = '/opt/fh/opencode/node_modules/opencode-linux-x64/bin/opencode';
    args = ['run', '--format', 'json', '--model', `benchmark/${model}`, '--title', `FrontierHarness ${config.task}`, '--', objective];
  } else if (harness === 'dsh') {
    const patch = [
      { id: 'agent-default-model', config: { provider: 'benchmark', model } },
      { id: 'llm-pi-ai', config: { providers: { benchmark: { apiKeyEnv: 'FH_RELAY_KEY', api: 'openai-completions', baseURL, defaultContextWindow: contextTokens, defaultMaxTokens: outputTokens, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_completion_tokens', thinkingFormat: 'deepseek' }, models: [{ id: model, name: model, contextWindow: contextTokens, maxTokens: outputTokens, reasoning: true, input: ['text'] }] } } } },
    ];
    await writeFile(`${state}/dsh-route.yml`, JSON.stringify(patch));
    args = ['/opt/fh/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'headless', '--patch', `${state}/dsh-route.yml`, '--json', objective];
  } else throw new Error(`Unknown harness ${harness}`);
  await writeFile(`${state}/launch.json`, JSON.stringify({ executable, args, environment: Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'PATH' && /^(KODO_|PI_|DSH_|OPENCODE_|XDG_)/u.test(name))) }, null, 2));
  const child = spawn(executable, args, { cwd: '/app', env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 127; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); localRelay.close(); });

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await launch();
