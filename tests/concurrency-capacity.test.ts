import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import type { Provider } from '../src/runtime/types.js';
import { answer, binding, temp } from './helpers.js';

describe('default and expanded concurrency capacity', () => {
  it.each([
    { maxConcurrentModels: 2, maxActiveChildren: 8 },
    { maxConcurrentModels: 8, maxActiveChildren: 16 },
  ])('admits the configured model slots and bounds active children: %j', async budget => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0, peak = 0;
    const provider: Provider = { async complete() {
      active++; peak = Math.max(peak, active);
      try { await gate; return answer('Independent assigned work completed.'); }
      finally { active--; }
    } };
    const root = temp();
    const app = new Application(path.join(root, '.state'), provider, undefined, { instructions: { global: false } });
    try {
      const main = app.createRun({ objective: 'Collect independent results.', workspace: root, binding, permissions: ['read'], budget });
      const children = Array.from({ length: budget.maxActiveChildren }, (_, index) => app.spawnAgent(main.sessionId, { objective: `Independent task ${index}` }));
      expect(() => app.spawnAgent(main.sessionId, { objective: 'One task beyond active capacity' })).toThrow('active child limit reached');
      expect(app.store.listRuns(main.sessionId).filter(run => run.parentId)).toHaveLength(budget.maxActiveChildren);
      const pending = Promise.all(children.map(child => app.coordinator.wake(child.id)));
      await vi.waitFor(() => expect(active).toBe(budget.maxConcurrentModels), { timeout: 5000 });
      // Keep the admitted calls blocked while the other wake requests reach admission.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(active).toBe(budget.maxConcurrentModels);
      expect(peak).toBe(budget.maxConcurrentModels);
      release();
      expect((await pending).every(run => run.status === 'completed')).toBe(true);
      const next = app.spawnAgent(main.sessionId, { objective: 'Reuse a released active-child slot' });
      expect((await app.coordinator.wake(next.id)).status).toBe('completed');
      expect(app.store.session(main.sessionId).modelCalls).toBe(budget.maxActiveChildren + 1);
    } finally { release(); await app.shutdown(); }
  });
});
