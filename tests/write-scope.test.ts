import { describe, expect, it } from 'vitest';
import type { Application } from '../src/application/index.js';
import { writeScopesOverlap } from '../src/runtime/scope.js';
import { fixture } from './helpers.js';

function operation(app: Application, runId: string, name: string, args: Record<string, unknown>) {
  return app.store.transaction(() => {
    const run = app.store.run(runId);
    return app.coordinator.mailbox.execute(run, name, name, app.coordinator.mailbox.validate(run, name, JSON.stringify(args))) as Record<string, unknown>;
  });
}

describe('write scope conflicts between live children', () => {
  it('treats a directory as overlapping the files under it, but not sibling names', () => {
    expect(writeScopesOverlap({ write: ['test'] }, { write: ['test/retry.ts'] })).toBe(true);
    expect(writeScopesOverlap({ write: ['test/retry.ts'] }, { write: ['./test'] })).toBe(true);
    expect(writeScopesOverlap({ write: ['test'] }, { write: ['tests'] })).toBe(false);
    expect(writeScopesOverlap({ write: ['src/a.ts'] }, { write: ['src/b.ts'] })).toBe(false);
    expect(writeScopesOverlap({}, { write: ['src'] })).toBe(true);
    expect(writeScopesOverlap({ write: [] }, { write: ['src'] })).toBe(false);
  });

  it('rejects an overlapping scope with the holder, allows disjoint scopes and frees the scope after the holder ends', () => {
    const { app, runId } = fixture();
    const holder = operation(app, runId, 'spawn_agent', { objective: 'Change the test directory', scope: { write: ['test'] } }) as { id: string };
    let conflict: unknown;
    try { operation(app, runId, 'spawn_agent', { objective: 'Change one test', scope: { write: ['test/retry.ts'] } }); }
    catch (error) { conflict = error; }
    expect(conflict).toMatchObject({ code: 'WRITE_SCOPE_CONFLICT', message: expect.stringContaining(`overlaps child ${holder.id}`) });
    expect((conflict as Error).message).toContain('holds write scope ["test"]');
    expect(operation(app, runId, 'spawn_agent', { objective: 'Change source', scope: { write: ['source'] } })).toHaveProperty('id');
    // Read-only children claim nothing.
    expect(operation(app, runId, 'spawn_agent', { objective: 'Review tests', permissions: ['read'], scope: { write: [] } })).toHaveProperty('id');
    app.coordinator.cancel(holder.id);
    expect(operation(app, runId, 'spawn_agent', { objective: 'Change one test', scope: { write: ['test/retry.ts'] } })).toHaveProperty('id');
  });

  it('frees the scope once the holder is terminal', () => {
    const { app, runId } = fixture();
    const holder = operation(app, runId, 'spawn_agent', { objective: 'Change docs', scope: { write: ['docs'] } }) as { id: string };
    app.store.updateRun(holder.id, { status: 'completed' });
    expect(operation(app, runId, 'spawn_agent', { objective: 'Change docs again', scope: { write: ['docs/guide.md'] } })).toHaveProperty('id');
  });
});
