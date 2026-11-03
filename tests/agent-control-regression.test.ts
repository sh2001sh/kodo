import { describe, expect, it } from 'vitest';
import { answer, fixture } from './helpers.js';

describe('ordinary agent control and context handoff', () => {
  it('records a durable CONTEXT_LIMIT handoff when required input exceeds the host budget', async () => {
    let providerCalls = 0;
    const { app, runId } = fixture({ async complete() { providerCalls++; return answer(); } });
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxContextChars: 512 } });
    const stopped = await app.run(runId);
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toContain('CONTEXT_LIMIT');
    expect(providerCalls).toBe(0);
    const handoff = app.store.latestEvent(runId, { types: ['run.handoff'] });
    expect(handoff?.data).toMatchObject({ code: 'CONTEXT_LIMIT', reportRef: expect.any(String) });
    const report = app.store.readBlob<{ text: string }>(handoff!.data.reportRef as string);
    expect(report.text).toContain('Runtime handoff report: CONTEXT_LIMIT');
    expect(report.text).toContain(run.objective);
    expect(app.store.countEvents(runId, { types: ['run.handoff'] })).toBe(1);
  });
});
