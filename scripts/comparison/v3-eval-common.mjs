// Shared plumbing for the compaction-v3 and delegation-explore T8 evaluations.
// Credentials come from KODO_API_KEY/KODO_BASE_URL or an explicitly named
// --provider-config file; there is no implicit default credential path. The real
// key only reaches the loopback budget relay, never the harness binding.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { createBudgetRelay } from './relay.mjs';
import { usageLedger } from './v3-eval-ledger.mjs';

export const RELAY_KEY_ENV = 'KODO_V3_EVAL_RELAY_KEY';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const errorText = error => (error instanceof Error ? error.message : String(error));
export const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/** Parse `--name value`, `--name=value` and boolean flags against a declared option table. */
export function parseArgs(argv, options) {
  const values = Object.fromEntries(Object.entries(options).map(([name, spec]) => [name, spec.default]));
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const [rawName, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const name = rawName.replace(/^--/, '');
    const spec = options[name];
    if (!rawName.startsWith('--') || !spec) throw new Error(`unknown option ${arg}`);
    if (spec.kind === 'boolean') { values[name] = true; continue; }
    const value = inline ?? argv[++index];
    if (value === undefined || value === '') throw new Error(`--${name} requires a value`);
    if (spec.kind === 'integer') {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${name} requires a nonnegative integer`);
      values[name] = parsed;
    } else if (spec.kind === 'list') values[name] = value.split(',').map(item => item.trim()).filter(Boolean);
    else values[name] = value;
  }
  if (values['dry-run'] === values.run) throw new Error('exactly one of --dry-run or --run is required');
  return values;
}

export async function resolveCredentials({ providerConfig, provider }) {
  let key = process.env.KODO_API_KEY ?? process.env.OPENAI_API_KEY;
  let upstream = process.env.KODO_BASE_URL;
  if ((!key || !upstream) && providerConfig) {
    const config = JSON.parse(await readFile(path.resolve(providerConfig), 'utf8'));
    const options = config?.provider?.[provider]?.options;
    key ||= options?.apiKey;
    upstream ||= options?.baseURL;
  }
  if (!key || !upstream) throw new Error('no credentials: set KODO_API_KEY and KODO_BASE_URL, or pass --provider-config <file> --provider <id>; never put a key on the command line');
  const url = new URL(upstream);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('provider URL must be http(s) without embedded credentials');
  return { key, upstream, host: url.host };
}

/** Start a per-run relay and return a Kodo binding that points at it. */
export async function relayBinding({ directory, credentials, model, maxCalls, maxTokens, maxOutputTokens, contextTokens, cacheReadCostPercent = 100, unrestricted = false }) {
  process.env[RELAY_KEY_ENV] = 'v3-eval-relay';
  const relay = await createBudgetRelay({ directory, upstream: credentials.upstream, key: credentials.key, model, maxCalls, maxTokens, maxOutputTokens, maxContextChars: Number.MAX_SAFE_INTEGER, cacheReadCostPercent, unrestricted });
  return { relay, binding: { protocol: 'chat-completions', model, baseURL: relay.baseURL, apiKeyEnv: RELAY_KEY_ENV, limits: { context: contextTokens, output: maxOutputTokens } } };
}

export const dryBinding = (model, contextTokens, output) => ({ protocol: 'chat-completions', model, baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_V3_EVAL_DRY_UNUSED', limits: { context: contextTokens, output } });

/**
 * Spending of a whole session from persisted model calls, as the per-role
 * ledger in v3-eval-ledger.mjs. Unknown usage is counted, never added as zero.
 */
export const sessionUsage = (store, sessionId) => usageLedger(store, sessionId);

export function eventCounts(store, runId, prefix) {
  const counts = {};
  for (const event of store.events(runId)) if (event.type.startsWith(prefix)) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

export function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Write JSON with the credential redacted wherever it might have leaked. */
export async function writeJson(file, value, secret) {
  let text = JSON.stringify(value, null, 2);
  if (secret) text = text.replaceAll(secret, '[REDACTED]');
  await writeFile(file, `${text}\n`, 'utf8');
}

export function finalText(store, run) {
  return run.resultRef ? store.readBlob(run.resultRef)?.text ?? '' : '';
}
