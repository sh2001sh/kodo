import { modelCatalog } from './model-catalog.js';
import { KodoError } from '../runtime/types.js';
import type { Budget, ModelBinding, ModelLimits, ResolvedModelLimits } from '../runtime/types.js';

function validate(limits: ModelLimits): void {
  if (![limits.context, limits.output, ...(limits.input === undefined ? [] : [limits.input])].every(value => Number.isSafeInteger(value) && value > 0) || limits.context < 2 || (limits.input !== undefined && limits.input > limits.context)) throw new KodoError('MODEL_LIMITS', 'model context, output and optional input limits must be positive safe integers; input must fit context');
}

/** Validate before sending credentials to a configured metadata or inference endpoint. */
export function validateModelBinding(binding: ModelBinding): void {
  const url = new URL(binding.baseURL);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new KodoError('MODEL_URL', 'use HTTPS or loopback HTTP without embedded credentials, query or fragment');
  if (!binding.model.trim() || binding.model.length > 512 || /[\p{Cc}\p{Cf}]/u.test(binding.model) || !/^[A-Z_][A-Z0-9_]*$/i.test(binding.apiKeyEnv)) throw new KodoError('MODEL_BINDING', 'model name (1-512 characters without controls) and credential environment reference are required');
  if (binding.protocol !== undefined && !['chat-completions', 'responses', 'anthropic'].includes(binding.protocol)) throw new KodoError('MODEL_PROTOCOL', 'protocol must be chat-completions, responses or anthropic');
  if (binding.promptCache !== undefined && !['off', 'session'].includes(binding.promptCache)) throw new KodoError('MODEL_CACHE', 'promptCache must be off or session; enable only for a provider that supports these cache hints');
  if (binding.provider !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(binding.provider)) throw new KodoError('MODEL_BINDING', 'provider must be a configured provider identity');
  if (binding.fallbacks !== undefined) {
    if (!Array.isArray(binding.fallbacks) || binding.fallbacks.length > 7) throw new KodoError('MODEL_BINDING', 'a model binding allows at most seven provider alternatives');
    for (const candidate of binding.fallbacks) {
      if (!candidate || typeof candidate !== 'object' || candidate.fallbacks !== undefined || candidate.model !== binding.model || (candidate.protocol ?? 'chat-completions') !== (binding.protocol ?? 'chat-completions')) throw new KodoError('MODEL_BINDING', 'provider alternatives must be flat and use the same model and protocol');
      validateModelBinding(candidate);
    }
  }
}

/** Anthropic user configuration uses the host root; legacy /v1 bindings remain valid. */
export function modelApiBaseURL(binding: Pick<ModelBinding, 'baseURL' | 'protocol'>): string {
  const base = binding.baseURL.replace(/\/+$/u, '');
  if (binding.protocol !== 'anthropic') return base;
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/u, '');
  if (/(?:^|\/)v\d+(?:\/|$)/iu.test(path)) return base;
  url.pathname = `${path}/v1`.replace(/^\/+/u, '/');
  return url.toString();
}

/** Model capabilities are independent of optional session spending/stopping limits. */
export function resolveModelLimits(binding: ModelBinding, overrides: Partial<Budget> = {}): ResolvedModelLimits {
  validateModelBinding(binding);
  for (const value of [overrides.maxContextTokens, overrides.maxOutputTokens]) if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new KodoError('BUDGET', 'context/output limits must be positive safe integers');
  if (overrides.maxContextTokens !== undefined && overrides.maxContextTokens < 2) throw new KodoError('BUDGET', 'context must be at least 2 tokens to leave room for input and output');
  let found: ResolvedModelLimits | undefined;
  if (binding.limits) {
    validate(binding.limits);
    found = { ...binding.limits, source: 'binding' };
  } else {
    const candidates = modelCatalog.filter(entry => entry.model === binding.model);
    const normalized = binding.baseURL.replace(/\/+$/, '');
    const exact = candidates.find(entry => entry.baseURL.replace(/\/+$/, '') === normalized);
    const limits = (entry: typeof modelCatalog[number]): ModelLimits => ({ context: entry.context, output: entry.output, ...(entry.input === undefined ? {} : { input: entry.input }) });
    if (exact) found = { ...limits(exact), source: 'catalog' };
    else if (candidates.length && candidates.every(entry => JSON.stringify(limits(entry)) === JSON.stringify(limits(candidates[0]!)))) {
      found = { ...limits(candidates[0]!), source: 'model-name', warning: 'Using native model limits for a custom endpoint. A relay may impose smaller limits; override the context/output limits if needed.' };
    }
  }
  if (!found && overrides.maxContextTokens !== undefined && overrides.maxOutputTokens !== undefined) {
    found = { context: overrides.maxContextTokens, output: overrides.maxOutputTokens, source: 'explicit' };
  }
  if (!found) {
    const context = overrides.maxContextTokens ?? 128_000;
    found = { context, output: overrides.maxOutputTokens ?? Math.min(16_384, context - 1), source: 'fallback', warning: 'Model capabilities are unknown. Using provisional limits (128000 context / 16384 output unless explicitly configured); these are not verified server capabilities. Use API metadata discovery or declare binding.limits to replace them.' };
  }
  validate(found);
  return found;
}

/** Leave room for a complete tool round without reserving the model's entire possible output. */
export function contextOutputReserve(budget: Budget): number {
  return Math.min(budget.maxOutputTokens, Math.max(1, Math.min(Math.floor(budget.maxContextTokens / 2), Math.max(16_384, Math.floor(budget.maxContextTokens * 0.15)))));
}
