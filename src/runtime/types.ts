export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type Permission = 'read' | 'write' | 'exec';
export type ModelProtocol = 'chat-completions' | 'responses' | 'anthropic';
export interface ModelLimits { context: number; output: number; input?: number }
export interface ModelBinding { model: string; baseURL: string; apiKeyEnv: string; protocol?: ModelProtocol; promptCache?: 'off' | 'session'; limits?: ModelLimits }
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
  maxChildren: number;
  maxConcurrentModels: number;
}
export const defaultBudget: Omit<Budget, 'maxOutputTokens' | 'maxContextTokens'> = {
  maxTokens: null, maxModelCalls: null, maxToolCalls: null, maxDurationMs: null, maxContextChars: null,
  toolTimeoutMs: 120_000, maxChildren: 8, maxConcurrentModels: 2,
};
export interface ToolRequest { id: string; name: string; arguments: string }
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolRequest[]; providerData?:
    { protocol: 'chat-completions'; reasoningContent: string } |
    { protocol: 'responses'; output: Record<string, unknown>[] } |
    { protocol: 'anthropic'; blocks: Record<string, unknown>[] } }
  | { role: 'tool'; content: string; tool_call_id: string };
export interface ModelResponse {
  message: Extract<Message, { role: 'assistant' }>;
  finishReason: 'stop' | 'tool_calls';
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface Provider {
  complete(request: { binding: ModelBinding; messages: Message[]; tools: ToolSpec[]; maxOutputTokens: number; cacheKey?: string },
    signal: AbortSignal, onText: (text: string) => void): Promise<ModelResponse>;
}
export interface Card {
  id: string; version: string; name: string; prompt: string; digest: string; tools: string[];
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
}
export interface Run {
  id: string; sessionId: string; objective: string; status: RunStatus; card: Card;
  binding: ModelBinding; contextRef: string; step: number; stepCallId?: string;
  resultRef?: string; error?: string; cancelRequested: boolean; continuationOf?: string; createdAt: string;
  parentId?: string; permissions?: Permission[]; inputCursor?: number; waitId?: string;
  decisionVersion?: number; activeMs?: number;
  requiresValidation?: boolean;
  /** Hosts may explicitly allow silent or artifact-only completion; legacy runs require text. */
  finalResponse?: 'required' | 'optional';
}
export interface Call {
  id: string; runId: string; step: number; kind: 'model' | 'tool'; name: string;
  status: 'planned' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  effect: 'read' | 'write'; requestRef: string; resultRef?: string; reservedTokens: number;
  decisionVersion?: number;
  /** Internal effect and its result share the same database transaction. */
  effectAtomic?: boolean;
  /** Persisted before external IO. Absent on legacy calls, whose effects remain uncertain. */
  effectState?: 'not_started' | 'started';
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
}
export interface RuntimeEvent {
  seq: number; sessionId: string; runId: string; type: string; time: string;
  version: 1; data: Record<string, unknown>;
}
export type StepOutcome = { kind: 'continue' } | { kind: 'complete'; resultRef: string; workspaceStamp?: string }
  | { kind: 'wait'; waitId: string } | { kind: 'fail'; error: string } | { kind: 'cancelled' };
export const terminal = (status: RunStatus): boolean => ['completed', 'failed', 'cancelled'].includes(status);

export interface CompletionCheck { passed: boolean; feedback?: string; evidence?: Record<string, unknown> }
export type CompletionValidator = (input: { run: Run; response: ModelResponse; signal: AbortSignal }) => CompletionCheck | Promise<CompletionCheck>;
export interface ModelErrorMetadata { status?: number; retryAfterMs?: number; usageKnownZero?: boolean }

export class KodoError extends Error {
  constructor(public code: string, message: string, public readonly metadata?: ModelErrorMetadata) { super(message); this.name = 'KodoError'; }
}
export function errorText(error: unknown): string {
  return error instanceof KodoError ? `${error.code}: ${error.message}` : 'INTERNAL: operation failed; inspect local state before retrying';
}
