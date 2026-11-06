import type { Message, ModelBinding, ModelResponse, Provider, ToolRequest, ToolSpec } from '../runtime/types.js';

/**
 * Layer 1 types. The core reuses the existing provider contract so every adapter in
 * `src/providers` drives it unchanged; everything else here is deliberately small.
 */
export type { Message, ModelBinding, ModelResponse, Provider, ToolRequest, ToolSpec };

export type CoreRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export const isTerminal = (status: CoreRunStatus): boolean => status === 'completed' || status === 'failed' || status === 'cancelled';

export interface CoreSession { id: string; createdAt: number; binding: ModelBinding; metadata: Record<string, unknown> }
export interface CoreRun {
  id: string; sessionId: string; status: CoreRunStatus;
  /** The model-visible transcript, including the system prompt and tool results. */
  messages: Message[];
  /** Completed model rounds. */
  step: number;
  /** Final assistant text when completed. */
  result?: string;
  error?: string;
  usage: { input: number; output: number };
}
/** One dispatched tool call and its outcome, as passed to `afterToolResult`. */
export interface CoreToolCall { runId: string; id: string; name: string; arguments: unknown; status: 'succeeded' | 'failed'; result: unknown; error?: string }
