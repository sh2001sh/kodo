import { KodoError } from '../runtime/types.js';
import type { ModelBinding } from '../runtime/types.js';
import { object } from './errors.js';
import { modelApiBaseURL, validateModelBinding } from './model-limits.js';
import { abortable } from '../runtime/step-host.js';

export interface ProviderModel { id: string; name?: string }

const maxBytes = 4 * 1024 * 1024;
const maxPages = 20;
const maxModels = 10_000;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/\p{Cc}/u.test(value);
const malformed = (): KodoError => new KodoError('MODEL_LIST_FORMAT', 'Provider returned an invalid model list. Enter a model ID manually with /model or check the provider configuration.');

async function readPage(response: Response, remainingBytes: number, signal: AbortSignal): Promise<{ body: unknown; bytes: number }> {
  if (!response.body) throw malformed();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      // Cancellation of fetch does not itself guarantee its pending body read
      // settles promptly. Observe the overall listing deadline independently.
      const chunk = await abortable(() => reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > remainingBytes) throw new KodoError('MODEL_LIST_LIMIT', 'Provider model list exceeds 4 MiB. Enter a model ID manually with /model.');
      chunks.push(chunk.value);
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw malformed(); }
    return { body, bytes };
  } finally {
    // An aborted Node fetch can leave cancel() pending behind the stalled body.
    // The request signal closes the transport; cleanup must not extend the deadline.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Fetch only advertised model IDs; never generate probe completions or follow provider-supplied URLs. */
export async function listProviderModels(binding: ModelBinding, signal?: AbortSignal): Promise<ProviderModel[]> {
  signal?.throwIfAborted();
  try { validateModelBinding({ ...binding, model: binding.model.trim() || 'model-list' }); }
  catch { throw new KodoError('MODEL_LIST_CONFIG', 'Invalid provider connection. Use HTTPS or loopback HTTP and configure a valid credential environment variable and protocol.'); }
  const headers: Record<string, string> = { accept: 'application/json' };
  const key = process.env[binding.apiKeyEnv];
  if (binding.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (key) headers['x-api-key'] = key;
  } else if (key) headers.authorization = `Bearer ${key}`;
  const endpoint = `${modelApiBaseURL(binding)}/models`;
  const timeout = AbortSignal.timeout(8000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const models = new Map<string, ProviderModel>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  let entries = 0;
  try {
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(endpoint);
      if (cursor) url.searchParams.set('after_id', cursor);
      const response = await fetch(url, { headers, signal: requestSignal, redirect: 'error' });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        const auth = response.status === 401 || response.status === 403;
        throw new KodoError(auth ? 'MODEL_LIST_AUTH' : 'MODEL_LIST_HTTP', `Provider model list failed (HTTP ${response.status}). ${auth ? 'Check credentials with kodo config.' : 'Check the provider URL or enter a model ID manually with /model.'}`);
      }
      const result = await readPage(response, maxBytes - bytes, requestSignal);
      bytes += result.bytes;
      const body = result.body;
      if (!object(body) || !Array.isArray(body.data) || (body.has_more !== undefined && typeof body.has_more !== 'boolean')) throw malformed();
      entries += body.data.length;
      if (entries > maxModels) throw new KodoError('MODEL_LIST_LIMIT', 'Provider returned more than 10000 model entries. Enter a model ID manually with /model.');
      for (const entry of body.data) {
        if (!object(entry) || !validId(entry.id)) throw malformed();
        const label = entry.display_name ?? entry.name;
        const name = typeof label === 'string' && label.trim() && label.length <= 512 && !/\p{Cc}/u.test(label) ? label.trim() : undefined;
        const previous = models.get(entry.id);
        if (!previous || !previous.name && name) models.set(entry.id, { id: entry.id, ...(name ? { name } : {}) });
      }
      if (!body.has_more) {
        if (!models.size) throw new KodoError('MODEL_LIST_EMPTY', 'Provider returned no models. Check account access or enter a model ID manually with /model.');
        return [...models.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      }
      if (!body.data.length || !validId(body.last_id) || cursors.has(body.last_id)) throw malformed();
      cursor = body.last_id;
      cursors.add(cursor);
    }
    throw new KodoError('MODEL_LIST_LIMIT', 'Provider model list exceeds 20 pages. Enter a model ID manually with /model.');
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new KodoError('MODEL_LIST_TIMEOUT', 'Fetching provider models timed out after 8 seconds. Retry /model or enter a model ID manually.');
    if (error instanceof KodoError) throw error;
    throw new KodoError('MODEL_LIST_UNAVAILABLE', 'Could not fetch provider models. Check the provider connection in kodo config or enter a model ID manually with /model.');
  }
}
