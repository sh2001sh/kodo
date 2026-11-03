import path from 'node:path';
import { afterEach } from 'vitest';
import { Store } from '../src/storage/index.js';
import { defaultBudget } from '../src/runtime/types.js';
import type { Run, Session } from '../src/runtime/types.js';
import type { TaskDispatchHost } from '../src/runtime/task-dispatch.js';
import type { TaskCheckout } from '../src/runtime/task-graph.js';
import { temp } from './helpers.js';

const stores: Store[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });

/** A store with one session and one main run that owns the task graph. */
export function taskStore(directory = path.join(temp(), '.state'), seed = true): { store: Store; ownerId: string; directory: string } {
  const store = new Store(directory);
  stores.push(store);
  const createdAt = new Date().toISOString();
  const session: Session = { id: 'session', workspace: directory, permissions: ['read', 'write'], budget: { ...defaultBudget, maxOutputTokens: 2048, maxContextTokens: 100_000 }, taskProtocol: 3, tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, createdAt };
  if (seed) {
    store.putSession(session);
    store.putRun(mainRun(store, 'main', createdAt));
  }
  return { store, ownerId: 'main', directory };
}

export function reopen(store: Store, directory: string): Store {
  stores.splice(stores.indexOf(store), 1);
  store.close();
  return taskStore(directory, false).store;
}

function mainRun(store: Store, id: string, createdAt: string, parentId?: string): Run {
  return { id, sessionId: 'session', objective: 'Coordinate the task graph.', status: 'queued', card: { id: 'test/main', version: '1.0.0', name: 'main', prompt: 'p', digest: 'd', tools: [] },
    binding: { model: 'test', baseURL: 'http://localhost', apiKeyEnv: 'TEST_KEY' }, contextRef: store.blob([]), step: 0, cancelRequested: false, createdAt, ...(parentId ? { parentId } : {}) };
}

/** Deterministic in-memory checkout host; `checkouts` is the set of directories that exist "on disk". */
export function fakeHost(store: Store, quota = 8, options: { integrated?: Set<string>; failCheckout?: Set<string> } = {}) {
  const checkouts = new Set<string>(), log: string[] = [];
  let counter = 0;
  const host: TaskDispatchHost & { checkouts: Set<string>; log: string[] } = {
    quota, checkouts, log,
    ...(options.integrated ? { isIntegrated: node => options.integrated!.has(node.id) } : {}),
    allocateRunId: node => `child-${node.id}-g${node.generation}-${++counter}`,
    checkoutFor: (node, runId): TaskCheckout => ({ snapshotRef: `refs/kodo/${runId}`, path: `checkouts/${runId}` }),
    ensureCheckout(preparation) {
      if (options.failCheckout?.has(preparation.nodeId)) throw new Error('clone failed');
      log.push(`ensure:${preparation.checkout.path}`);
      checkouts.add(preparation.checkout.path);
    },
    discardCheckout(checkout) { log.push(`discard:${checkout.path}`); checkouts.delete(checkout.path); },
    startRun(preparation) {
      log.push(`start:${preparation.runId}`);
      store.putRun({ ...mainRun(store, preparation.runId, new Date().toISOString(), 'main'), objective: preparation.nodeId });
    },
    runExists: runId => store.listRuns('session').some(run => run.id === runId),
  };
  return host;
}
