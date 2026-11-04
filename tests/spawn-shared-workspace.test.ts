import { describe, expect, it } from 'vitest';
import type { Application } from '../src/application/index.js';
import { parseCard, simpleDefaultCard } from '../src/agents/card.js';
import { builtinToolNames } from '../src/tools/index.js';
import { fixture, fullToolCard } from './helpers.js';

function operation(app: Application, runId: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return app.store.transaction(() => {
    const run = app.store.run(runId);
    return app.coordinator.mailbox.execute(run, name, name, app.coordinator.mailbox.validate(run, name, JSON.stringify(args))) as Record<string, unknown>;
  });
}

function caught(action: () => unknown): unknown {
  try { void action(); return undefined; } catch (error) { return error; }
}

describe('spawn shared-workspace default path', () => {
  it('creates children in the session workspace without an execution descriptor', () => {
    const { app, root, runId } = fixture(undefined, ['read', 'write', 'exec']);
    const session = app.store.session(app.store.run(runId).sessionId);
    const result = operation(app, runId, 'spawn_agent', { objective: 'Change one module', scope: { write: ['src/module-a'] } });
    expect(result).not.toHaveProperty('execution');
    const child = app.store.run(result.id as string) as unknown as Record<string, unknown> & { sessionId: string };
    expect(child.execution).toBeUndefined();
    expect(child.executionPending).toBeUndefined();
    expect(app.store.session(child.sessionId).workspace).toBe(root);
    expect(app.store.session(child.sessionId).workspace).toBe(session.workspace);
  });

  it('rejects the removed isolated execution option at the tool schema', () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec']);
    expect(caught(() => operation(app, runId, 'spawn_agent', { objective: 'Change one module', scope: { write: ['src/module-a'] }, execution: 'isolated' })))
      .toMatchObject({ code: 'TOOL_ARGUMENTS', message: expect.stringMatching(/arguments do not match the spawn_agent schema/) });
  });

  it('keeps the shared write-conflict admission semantics from the kernel fix', () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec']);
    const holder = operation(app, runId, 'spawn_agent', { objective: 'Hold a slice', scope: { write: ['src/shared'] } });
    expect(caught(() => operation(app, runId, 'spawn_agent', { objective: 'Overlap the slice', scope: { write: ['src/shared/other.ts'] } })))
      .toMatchObject({ code: 'WRITE_SCOPE_CONFLICT', message: expect.stringContaining('overlaps child') });
    expect(holder.id).toBeTruthy();
    expect(operation(app, runId, 'spawn_agent', { objective: 'Independent slice', scope: { write: ['src/independent'] } })).toHaveProperty('id');
  });
});

describe('card tool surface after the delivery-tool removal', () => {
  it('default cards no longer declare workspace.commit or workspace.integrate', () => {
    for (const card of [simpleDefaultCard, fullToolCard]) {
      expect(card.tools).not.toContain('workspace.commit');
      expect(card.tools).not.toContain('workspace.integrate');
    }
    expect(simpleDefaultCard.version).toBe('2.0.0');
  });

  it('fails fast for a card that still declares a removed delivery tool', () => {
    const toolNames = [...fullToolCard.tools];
    expect(caught(() => parseCard(`---
schema_version: 2
id: legacy/isolated-writer
version: 1.0.0
name: Legacy isolated writer
description: Card from the removed isolated-checkout generation.
capabilities:
  tools: [file.read, file.patch, workspace.commit]
---
Write files in the checkout.
`, { toolNames }))).toMatchObject({ code: 'CARD_SCHEMA' });
    const { app } = fixture();
    expect(caught(() => app.registerCard({ ...fullToolCard, id: 'legacy/registered', tools: [...fullToolCard.tools, 'workspace.integrate'] })))
      .toMatchObject({ code: expect.stringMatching(/CARD_SCHEMA|CARD_UNAVAILABLE|CAPABILITY_CHANGED/) });
  });

  it('removed delivery tools are no longer executable or advertised', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec']);
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    const names = app.coordinator.tools.specs(run.card.tools, session).map(spec => spec.name);
    expect(names).not.toContain('workspace.commit');
    expect(names).not.toContain('workspace.integrate');
    expect(builtinToolNames).not.toContain('workspace.commit');
    expect(builtinToolNames).not.toContain('workspace.integrate');
    expect(app.coordinator.tools.availableNames()).toContain('workspace.git');
    await expect(app.coordinator.tools.execute(runId, 'workspace.commit', { message: 'x' }, new AbortController().signal)).rejects.toMatchObject({ code: 'TOOL_DENIED' });
  });
});
