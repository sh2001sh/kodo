import { describe, expect, it, vi } from 'vitest';
import type { Application } from '../src/application/index.js';
import { reviewAgentDrafts } from '../src/cli/agent-review.js';
import type { RetentionDraft } from '../src/cli/agent-review.js';

function fixture() {
  const draft = {
    id: 'draft-1', draftId: 'draft-1', digest: 'a'.repeat(64), status: 'draft', silent: false,
    name: 'Workspace reader', sourceRun: 'child-1', sessionId: 'session-1',
    evidence: { reportCompleteness: { status: 'not_required' }, hostAcceptance: { status: 'not_checked' }, mainAcceptance: { status: 'not_recorded' } },
  } as RetentionDraft;
  const approve = vi.fn(); const decide = vi.fn();
  const edit = vi.fn((_id: string, _digest: string, metadata: { name: string }) => ({ ...draft, ...metadata, digest: 'b'.repeat(64) }));
  const app = { retention: { list: () => [draft], approve, decide, edit } } as unknown as Application;
  return { app, draft, approve, decide, edit };
}

describe('terminal agent retention', () => {
  it('only lists drafts in JSON and noninteractive modes', async () => {
    for (const options of [{ json: true, interactive: true }, { interactive: false }]) {
      const { app, approve, decide } = fixture(); const output = vi.fn(); const question = vi.fn();
      await reviewAgentDrafts(app, 'session-1', { ...options, output, question });
      expect(question).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ type: 'agent.drafts', drafts: [{ id: 'draft-1' }] });
    }
  });
  it('requires another explicit choice after editing and approves the new digest', async () => {
    const { app, approve, edit } = fixture();
    const question = vi.fn().mockResolvedValueOnce('e').mockResolvedValueOnce('{"name":"Edited reader"}').mockResolvedValueOnce('y');
    await reviewAgentDrafts(app, 'session-1', { interactive: true, question, output: vi.fn() });
    expect(question).toHaveBeenCalledTimes(3);
    expect(edit).toHaveBeenCalledWith('draft-1', 'a'.repeat(64), { name: 'Edited reader' });
    expect(approve).toHaveBeenCalledWith('draft-1', 'b'.repeat(64), { source: 'cli', userEventId: expect.any(String) });
  });
  it('leaves silent drafts available without presenting another question', async () => {
    const { app, draft, approve, decide } = fixture(); draft.silent = true;
    const question = vi.fn();
    await reviewAgentDrafts(app, 'session-1', { interactive: true, question, output: vi.fn() });
    expect(question).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled();
  });
});
