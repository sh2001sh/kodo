import { KodoError } from '../runtime/types.js';
import type { Budget, ModelBinding, ModelLimits, ResolvedModelLimits } from '../runtime/types.js';
import { object } from './errors.js';
import { resolveModelLimits, validateModelBinding } from './model-limits.js';

const responseLimit = 8 * 1024 * 1024;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const first = (...values: unknown[]): number | undefined => values.find(positive) as number | undefined;

/** Only consume advertised numeric capabilities, never descriptions, model names or training windows. */
function advertisedLimits(value: Record<string, unknown>): Partial<ModelLimits> {
  const limit = object(value.limit) ? value.limit : object(value.limits) ? value.limits : {};
  const top = object(value.top_provider) ? value.top_provider : {};
  const meta = object(value.meta) ? value.meta : {};
  const context = first(meta.n_ctx, top.context_length, limit.context, value.context_length, value.context_window, value.max_model_len, value.max_context_length, value.contextWindow);
  const output = first(top.max_completion_tokens, limit.output, value.max_output_tokens, value.max_output_length, value.max_completion_tokens, value.maxTokens);
  const input = first(limit.input, value.max_input_tokens);
  return { ...(context !== undefined && context >= 2 ? { context } : {}), ...(output !== undefined ? { output } : {}), ...(input !== undefined ? { input } : {}) };
}

function selectedModel(body: unknown, model: string): Record<string, unknown> | undefined {
  if (!object(body)) return;
  if (Array.isArray(body.data)) {
    const matching = body.data.filter(value => object(value) && value.id === model);
    // An ambiguous list cannot identify the endpoint's active model configuration.
    return matching.length === 1 && object(matching[0]) ? matching[0] : undefined;
  }
  const entry = object(body.data) ? body.data : body;
  return entry.id === model ? entry : undefined;
}

async function readMetadata(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { headers, signal, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    throw new KodoError('MODEL_METADATA', `metadata HTTP ${response.status}`);
  }
  if (!response.body) throw new KodoError('MODEL_METADATA', 'metadata response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > responseLimit) throw new KodoError('MODEL_METADATA', 'metadata response exceeds 8 MiB');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Read-only, bounded discovery; never generate paid probe completions or follow redirects. */
export async function discoverModelLimits(binding: ModelBinding, overrides: Partial<Budget> = {}, signal?: AbortSignal): Promise<ResolvedModelLimits> {
  validateModelBinding(binding);
  signal?.throwIfAborted();
  const fallback = resolveModelLimits(binding, overrides);
  if (binding.limits || fallback.source === 'catalog' || (overrides.maxContextTokens !== undefined && overrides.maxOutputTokens !== undefined)) return fallback;
  const headers: Record<string, string> = { accept: 'application/json' };
  const key = process.env[binding.apiKeyEnv];
  if (key) {
    if (binding.protocol === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
    else headers.authorization = `Bearer ${key}`;
  }
  const base = binding.baseURL.replace(/\/+$/, '');
  const url = new URL(base);
  const routes = url.hostname === 'openrouter.ai' || url.hostname.endsWith('.openrouter.ai') ? ['models/user', 'models'] : ['models'];
  routes.push(`models/${encodeURIComponent(binding.model)}`);
  const timeout = AbortSignal.timeout(3000);
  const discoverySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const issues: string[] = [];
  let limits: Partial<ModelLimits> = {};
  for (const route of routes) {
    try {
      const body = await readMetadata(`${base}/${route}`, headers, discoverySignal);
      const selected = selectedModel(body, binding.model);
      if (selected) {
        // The first matching response wins each field (e.g. OpenRouter's key-specific limits).
        const advertised = advertisedLimits(selected);
        limits = { ...advertised, ...limits };
        if (limits.context !== undefined && limits.output !== undefined) break;
      }
    } catch (error) {
      signal?.throwIfAborted();
      issues.push(timeout.aborted ? 'metadata discovery timed out' : error instanceof KodoError ? error.message : 'metadata request unavailable or invalid');
      if (timeout.aborted) break;
    }
  }
  signal?.throwIfAborted();
  if (limits.context !== undefined || limits.output !== undefined) {
    const context = limits.context ?? fallback.context;
    const output = limits.output ?? Math.min(fallback.output, context - 1);
    const input = limits.input !== undefined && limits.input <= context ? limits.input : undefined;
    const missing = [limits.context === undefined ? 'context' : '', limits.output === undefined ? 'output' : ''].filter(Boolean);
    return { context, output, ...(input !== undefined ? { input } : {}), source: 'api', ...(missing.length ? { warning: `API metadata did not report ${missing.join(' / ')} limits; those fields use ${fallback.source === 'fallback' ? 'provisional defaults' : 'model catalog values'}, not verified server capabilities.` } : {}) };
  }
  const reason = issues.length ? [...new Set(issues)].join('; ') : 'API metadata did not advertise limits for the exact model ID';
  return { ...fallback, warning: `${fallback.warning ?? ''} ${reason}.`.trim() };
}
