import type { Application, CreateRunOptions } from '../application/index.js';
import type { PackageRegistry } from '../packages/registry.js';
import type { Budget, Card, CompletionValidator, ModelBinding, Permission, Run } from '../runtime/types.js';
import type { CaseCommand } from '../cases/runner.js';
import type { AgentAuthoringHost } from './agent-authoring.js';
import type { AgentCaseHost } from './agent-cases.js';

export interface TuiItem { id: string; label: string; detail?: string; command?: string; input?: string; disabled?: boolean }
export interface TuiPanel { title: string; lines: string[]; items?: TuiItem[]; hint?: string }
export interface TuiEntry { id: string; kind: 'user' | 'assistant' | 'tool' | 'error' | 'notice'; text: string; title?: string; status?: string; details?: string[] }
export interface TuiTask { id: string; kind: 'agent' | 'process'; label: string; status: string; detail?: string; command?: string }
export type TuiPermissionMode = 'ask' | 'yolo';
export interface TuiSnapshot {
  workspace: string; model: string; status: string; runId?: string; sessionId?: string;
  entries: TuiEntry[]; tasks: TuiTask[]; questions: { id: string; content: string }[];
  queue: { id: string; content: string }[]; panel?: TuiPanel; usage: string;
  notice?: string; busy: boolean; quitting: boolean; permissionMode?: TuiPermissionMode;
}
export interface TuiOptions {
  app: Application; workspace: string; binding: ModelBinding; permissions: Permission[];
  permissionMode?: TuiPermissionMode;
  modelConfig?: {
    path: string;
    provider?: string;
    providers: { id: string; model?: string; members?: string[] }[];
    listModels(provider: string | undefined, signal: AbortSignal): Promise<{ id: string; name?: string; provider?: string; sources?: string[] }[]>;
    select(provider: string | undefined, model: string): ModelBinding | Promise<ModelBinding>;
    selectProvider?(provider: string): ModelBinding | Promise<ModelBinding>;
    mergeProviders?(name: string, members: string[]): void | Promise<void>;
    lastModelWarnings?: string[];
  };
  budget?: Partial<Budget>; card?: Card; registry: PackageRegistry; initial?: Run;
  rates?: { input: number; output: number };
  completionValidator?: (runId: string) => CompletionValidator | undefined;
  beforeRun?: (runId: string) => void | Promise<void>;
  createRun?: (options: CreateRunOptions, operation?: { purpose?: 'authoring' | 'case' }) => Run | Promise<Run>;
  hostPolicyDigest?: string;
  caseCommands?: Record<string, CaseCommand>;
  /** Reattach the original host configuration before a historical run can execute. */
  restore?: (run: Run) => void | Promise<void>;
  activatePackage?: (id: string, version: string) => Promise<Card>;
  activatePackageAt?: (id: string, version: string, workspace: string, signal: AbortSignal) => Promise<Card>;
}
export interface TuiActions {
  snapshot(): TuiSnapshot;
  /** Read-only file name completion; never opens a panel or reads file bodies. */
  completeFiles?(query: string): Promise<TuiItem[]>;
  subscribe(listener: () => void): () => void;
  submit(text: string, options?: { literal?: boolean }): Promise<void>;
  dismissPanel(): void;
  interrupt(): Promise<void>;
  quit(confirmed?: boolean): Promise<void>;
  onText(runId: string, text: string): void;
  close(): Promise<void>;
}
export interface AgentCommandContext {
  app: Application; registry: PackageRegistry; workspace: string; runId?: string;
  activatePackage?: TuiOptions['activatePackage'];
  authoringHost?: AgentAuthoringHost;
  caseHost?: AgentCaseHost;
  /** Starts the primary task flow for /agents authoring or case operations. */
  startTask: (objective: string) => Promise<void>;
  wake: (runId: string) => void;
}
