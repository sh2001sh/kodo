import { randomUUID } from 'node:crypto';
import { KodoError } from '../runtime/types.js';
import type { CoreRun, Message } from './types.js';

/** In-memory run table. Callers receive copies; only `update` changes a record. */
export class RunTable {
  private readonly runs = new Map<string, CoreRun>();
  create(sessionId: string, messages: Message[]): CoreRun {
    const run: CoreRun = { id: randomUUID(), sessionId, status: 'queued', messages, step: 0, usage: { input: 0, output: 0 } };
    this.runs.set(run.id, run);
    return this.get(run.id);
  }
  get(id: string): CoreRun {
    const run = this.runs.get(id);
    if (!run) throw new KodoError('RUN_NOT_FOUND', `unknown run ${id}`);
    return { ...run, messages: [...run.messages], usage: { ...run.usage } };
  }
  update(id: string, patch: Partial<Omit<CoreRun, 'id' | 'sessionId'>>): CoreRun {
    this.runs.set(id, { ...this.get(id), ...patch });
    return this.get(id);
  }
  list(sessionId?: string): CoreRun[] {
    return [...this.runs.keys()].map(id => this.get(id)).filter(run => sessionId === undefined || run.sessionId === sessionId);
  }
}
