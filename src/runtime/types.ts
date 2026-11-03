export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type Permission = 'read' | 'write' | 'exec';
/** Relative directory/file roots; an omitted list is unrestricted and an empty list denies access. */
export interface FileScope { read?: string[]; write?: string[] }
export type ModelProtocol = 'chat-completions' | 'responses' | 'anthropic';
export interface ModelLimits { context: number; output: number; input?: number }
export interface ModelBinding {
  model: string; baseURL: string; apiKeyEnv: string; protocol?: ModelProtocol; promptCache?: 'off' | 'session'; limits?: ModelLimits;
  /** User-configured physical provider identity; never a credential value. */
  provider?: string;
  /** Ordered host-approved alternatives for the same model and protocol; nested alternatives are invalid. */
  fallbacks?: ModelBinding[];
}
export interface ResolvedModelLimits extends ModelLimits { source: 'binding' | 'catalog' | 'model-name' | 'explicit' | 'api' | 'fallback'; warning?: string }
export interface Budget {
  maxTokens: number | null;
  maxModelCalls: number | null;
  maxToolCalls: number | null;
  maxDurationMs: number | null;
  maxOutputTokens: number;
  maxContextChars: number | null;
  maxContextTokens: number;
  toolTimeoutMs: number;
  /** Optional cumulative child-run cap, including completed runs and follow-ups. */
  maxChildren: number | null;
  /** Concurrent unfinished child-task cap; absent in legacy sessions. */
  maxActiveChildren?: number;
  maxConcurrentModels: number;
  /** Percent (0–100) of cache-read input charged against `maxTokens`; absent means 100 (raw volume). */
  cacheReadCostPercent?: number;
}
export const defaultBudget: Omit<Budget, 'maxOutputTokens' | 'maxContextTokens'> = {
  maxTokens: null, maxModelCalls: null, maxToolCalls: null, maxDurationMs: null, maxContextChars: null,
  toolTimeoutMs: 120_000, maxChildren: null, maxActiveChildren: 8, maxConcurrentModels: 2,
};
export interface ToolRequest { id: string; name: string; arguments: string }
/** Validated local image bytes; file/tool text cannot create model attachments. */
export interface ModelImage { mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export type Message =
  | { role: 'system' | 'user'; content: string; images?: ModelImage[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolRequest[]; providerData?:
    { protocol: 'chat-completions'; reasoningContent: string } |
    { protocol: 'responses'; output: Record<string, unknown>[] } |
    { protocol: 'anthropic'; blocks: Record<string, unknown>[] } }
  | { role: 'tool'; content: string; tool_call_id: string; images?: ModelImage[] };
export interface ModelResponse {
  message: Extract<Message, { role: 'assistant' }>;
  finishReason: 'stop' | 'tool_calls';
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface Provider {
  complete(request: { binding: ModelBinding; messages: Message[]; tools: ToolSpec[]; maxOutputTokens: number; cacheKey?: string; toolChoice?: 'none' },
    signal: AbortSignal, onText: (text: string) => void): Promise<ModelResponse>;
}
export type CardMode = 'read' | 'review' | 'write';
export type CardModelRole = 'fast' | 'standard' | 'strong';
export interface CardReference { id: string; version: string; digest: string }
export interface CardInput { name: string; kind: 'text' | 'paths' | 'artifact'; required: boolean; description?: string }
export interface CardReportField { name: string; kind: 'text' | 'paths' | 'calls' | 'list'; required: boolean; description?: string }
export interface CardMcp { server: string; tools: string[] }
export interface Card {
  id: string; version: string; name: string; prompt: string; digest: string; tools: string[];
  description?: string;
  skills?: string[];
  /** Omitted for legacy v1 cards so their persisted and model-visible representations stay unchanged. */
  schemaVersion?: 1 | 2;
  catalog?: { path: string; aliases?: string[] };
  routing?: { use_when: string[]; not_for?: string[]; mode: CardMode };
  inputs?: CardInput[];
  report?: CardReportField[];
  mcp?: CardMcp[];
  constraints?: { permissions?: Permission[]; scope?: FileScope; rules?: string[] };
  model?: { role: CardModelRole };
  derivation?: { allowed: boolean };
  members?: CardReference[];
  /** Explicitly opt in to advisory progress nudges; omitted is off. */
  nudges?: boolean;
  /** Set on unregistered ad-hoc configurations: the immutable registered card they narrow. */
  derivedFrom?: { id: string; version: string; digest: string };
}
export interface Session {
  id: string; workspace: string; permissions: Permission[]; budget: Budget;
  tokens: number; modelCalls: number; toolCalls: number; usageEstimated: boolean; createdAt: string;
  decisionVersion?: number;
  activeMs?: number;
  /** Durable start of the currently uncheckpointed shared execution interval. */
  activeSince?: number;
  verificationCommand?: { program: string; args: string[] };
  modelLimits?: ResolvedModelLimits;
  /** Explicit host ceilings, distinct from the main model's default capacity. */
  modelBudgetCeilings?: { maxContextTokens?: number; maxOutputTokens?: number };
  /** Host/project variables such as project.tests, resolved to relative path roots when freezing the roster. */
  projectRoots?: Record<string, string[]>;
  /** Card role names map to host-owned model binding aliases, never to model-selected credentials. */
  modelRoles?: Partial<Record<CardModelRole, string>>;
  /** Freeze the approved child-model range and its short user descriptions for this session. */
  modelBindings?: Record<string, ModelBinding>;
  modelBindingDescriptions?: Record<string, string>;
  /** Independent model-visible delegation experiments; omitted retains the host's default selection. */
  agentFactors?: import('./agent-factors.js').AgentFactors;
  /** Frozen task semantics: absent/1 is legacy, 2 adds parallel dependencies, 3 adds atomic graph updates. */
  taskProtocol?: 1 | 2 | 3;
  /** Frozen model-visible tool profile; absent preserves the original card view. */
  toolProfile?: 'compact-v1' | 'compact-v2' | 'full' | 'lean-solo';
}
export interface Run {
  id: string; sessionId: string; objective: string; status: RunStatus; card: Card;
  binding: ModelBinding; contextRef: string; step: number; stepCallId?: string;
  resultRef?: string; error?: string; cancelRequested: boolean; continuationOf?: string; createdAt: string;
  /** A resumable current-turn pause, distinct from cancellation and crash recovery. */
  interruptRequested?: boolean;
  parentId?: string;
  permissions?: Permission[]; inputCursor?: number; waitId?: string;
  scope?: FileScope;
  /** Host-approved binding alias; model limits belong to each run, spending remains session-wide. */
  modelBindingId?: string;
  modelLimits?: ResolvedModelLimits;
  /** Ordinary follow-up history grant, distinct from recovery mailbox ownership. */
  historyFrom?: string;
  /** Persisted capability contracts prevent restoring a run against changed host registrations. */
  toolBindings?: Record<string, string>;
  decisionVersion?: number; activeMs?: number;
  requiresValidation?: boolean;
  /** Hosts may explicitly allow silent or artifact-only completion; legacy runs require text. */
  finalResponse?: 'required' | 'optional';
  /** Host-enforced text generation, including suppression of implicit collaboration tools. */
  toolChoice?: 'none';
  /** Host-declared workspace deliverables checked against actual files when the model stops. */
  deliverables?: Deliverable[];
  /** Missing deliverables accepted after the bounded turn-end continuations; recorded, never hidden. */
  deliveryIncomplete?: string[];
  /** Project instruction files already in this run's context (labels), their rendered bytes and the global file used. */
  instructions?: {
    loaded: string[]; bytes: number; global?: string; memory?: boolean; sources?: Record<string, string>;
    cardRules?: string[]; tokenBudget?: number; tokens?: number; reservedTokens?: number;
  };
}
/** A relative path (trailing `/` = any file below), or an object with a path or glob pattern and optional checks. */
export type Deliverable = string | { path?: string; pattern?: string; exclude?: string[]; minBytes?: number; changed?: boolean };
export interface Call {
  id: string; runId: string; step: number; kind: 'model' | 'tool'; name: string;
  status: 'planned' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  effect: 'read' | 'write'; requestRef: string; resultRef?: string; reservedTokens: number;
  /** The model's own call when the session's tool view renamed it; requestRef then holds the canonical kernel call. */
  modelRequestRef?: string;
  /** A physical provider attempt points back to the immutable approved route set. */
  logicalRequestRef?: string;
  routeIndex?: number;
  /** Bounded model-visible projection when the durable result is larger than the tool limit. */
  modelResultRef?: string;
  /** Required grant for disclosing tool evidence, pinned independently of effect and later registrations. */
  evidencePermission?: Permission;
  /** Auxiliary model calls share spending but never own a business step. */
  purpose?: 'compaction';
  decisionVersion?: number;
  /** Internal effect and its result share the same database transaction. */
  effectAtomic?: boolean;
  /** Persisted before external IO. Absent on legacy calls, whose effects remain uncertain. */
  effectState?: 'not_started' | 'started';
  /** Observed side-effect settlement, independent of command success or failure. */
  effectOutcome?: 'applied' | 'not_applied' | 'unknown';
  /** Canonical absolute roots this write could touch; absent on legacy calls, which cover the whole workspace. */
  effectRoots?: string[];
}
export interface Envelope {
  seq: number; id: string; sessionId: string; from: string; to: string;
  kind: 'question' | 'answer' | 'notice' | 'input' | 'decision' | 'event';
  content: string; replyTo?: string; artifacts?: string[];
}
export interface Wait {
  id: string; runId: string; questionIds: string[]; runIds: string[];
  mode: 'any' | 'all'; deadline: number; status: 'registered' | 'settled';
  reason?: string;
  /** Internal polling deadline renews without generating a model wake. */
  eventDriven?: boolean;
}
export interface RuntimeEvent {
  seq: number; sessionId: string; runId: string; type: string; time: string;
  version: 1; data: Record<string, unknown>;
}
export type StepOutcome = { kind: 'continue' } | { kind: 'complete'; resultRef: string; workspaceStamp?: string }
  | { kind: 'wait'; waitId: string } | { kind: 'fail'; error: string } | { kind: 'cancelled' };
export const terminal = (status: RunStatus): boolean => ['completed', 'failed', 'cancelled'].includes(status);

export interface CompletionCheck { passed: boolean; feedback?: string; evidence?: Record<string, unknown> }
export interface ToolRecoveryCheck {
  outcome: 'succeeded' | 'not_applied' | 'failed' | 'unknown';
  evidence: string;
  result?: unknown;
}
export type ToolRecoveryVerifier = (input: { run: Run; call: Call; request: ToolRequest; signal: AbortSignal }) => ToolRecoveryCheck | Promise<ToolRecoveryCheck>;
export type CompletionValidator = (input: { run: Run; response: ModelResponse; signal: AbortSignal }) => CompletionCheck | Promise<CompletionCheck>;
/**
 * outputLimit marks a stop at the output token cap; such a response is discarded and may be retried once.
 * usage carries counters the provider already reported for a failed attempt: an unusable response can still have an exact bill.
 * partialResponse marks any received response content, including private reasoning and partial tools; it forbids provider failover.
 * incompleteStream marks a missing terminal completion, not an explicit stop or refusal; permits one same-endpoint retry before visible output.
 */
export interface ModelErrorMetadata { status?: number; retryAfterMs?: number; usageKnownZero?: boolean; outputLimit?: boolean; incompleteStream?: boolean; usage?: ModelResponse['usage']; partialResponse?: boolean; timeoutPhase?: 'first_byte' | 'stream_idle' | 'content_idle'; timeoutMs?: number }

/** Who requested a cancellation; `by` is the requesting run and `callId` the cancel_agent call, when known. */
export interface CancelOrigin { initiator: 'user' | 'agent' | 'parent' | 'decision' | 'runtime' | 'shutdown'; by?: string; callId?: string }

export class KodoError extends Error {
  constructor(public code: string, message: string, public readonly metadata?: ModelErrorMetadata) { super(message); this.name = 'KodoError'; }
}
const absolutePath = /(?:[A-Za-z]:[\\/]|\\\\|(?<![\w.~-])\/(?=[^\s/]+\/))[^\s'"`<>|]*/g;
const secretLike = /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9_-]{32,})\b/g;
/** Redacts absolute paths (keeping the last segment) and token-like strings from internal error text. */
export function redactErrorMessage(message: string, limit = 300): string {
  const redacted = message
    .replace(absolutePath, match => `<path>/${match.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''}`)
    .replace(secretLike, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length > limit ? `${redacted.slice(0, limit - 1)}…` : redacted;
}
export function errorText(error: unknown): string {
  if (error instanceof KodoError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `INTERNAL: ${error.name}: ${redactErrorMessage(error.message) || 'no message'}`;
  return `INTERNAL: ${redactErrorMessage(String(error)) || 'unknown error'}`;
}
