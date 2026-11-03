import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { Application } from '../src/application/index.js';
import { agentDraftCommand } from '../src/cli/agent-drafts.js';
import { readHostState, writeHostState } from '../src/cli/host-state.js';
import type { RetentionDraft } from '../src/agents/retention.js';
import { answer, binding, temp } from './helpers.js';

describe('offline agent draft commands', () => {
  it('lists persisted drafts, edits metadata and approves the current digest without a model', async () => {
    const root = temp(); const directory = path.join(root, 'state');
    const app = new Application(directory, { async complete() { return answer(); } }, undefined, { agentFactors: { D: false, E: false, A: false, B: false, C: false } });
    let draft: RetentionDraft;
    let sessionId: string;
    try {
      const main = app.createRun({ workspace: root, objective: 'Read workspace.', binding, permissions: ['read'], card: { id: 'test/reader', version: '1.0.0', name: 'Reader', digest: 'test-reader', prompt: 'Read the requested files.', tools: ['file.read'] } });
      sessionId = main.sessionId;
      const child = app.spawnAgent(main.sessionId, { objective: 'Read the entry point.' });
      await app.run(child.id);
      draft = app.retention.propose(main.sessionId, { run_id: child.id, name: 'Saved reader' });
      writeHostState(directory, [{ sessionId, runIds: [main.id, child.id], questionIds: [], agents: { agentRetention: 'review', agentFactors: { A: false, B: false, C: false }, projectRoots: { 'project.tests': ['tests'] } } }]);
    } finally { await app.shutdown(); }
    const outputs: string[] = [];
    const output = (text: string): void => { outputs.push(text); };
    await agentDraftCommand(['drafts', '--session', sessionId, '--data-dir', directory, '--json'], { output });
    expect(JSON.parse(outputs.pop()!).drafts).toEqual(expect.arrayContaining([expect.objectContaining({ id: draft.id, status: 'draft' })]));
    const metadata = path.join(root, 'metadata.json'); writeFileSync(metadata, JSON.stringify({ name: 'Edited reader' }), 'utf8');
    await agentDraftCommand(['edit', draft.id, '--digest', draft.digest, '--metadata', metadata, '--data-dir', directory, '--json'], { output });
    const updated = JSON.parse(outputs.pop()!) as RetentionDraft;
    expect(updated.status).toBe('draft'); expect(updated.digest).not.toBe(draft.digest);
    await agentDraftCommand(['approve', draft.id, '--digest', updated.digest, '--data-dir', directory, '--json'], { output });
    expect(JSON.parse(outputs.pop()!)).toMatchObject({ name: 'Edited reader', status: 'approved' });
    expect(readHostState(directory)[0]?.agents).toMatchObject({ agentFactors: { A: false, B: false, C: false }, projectRoots: { 'project.tests': ['tests'] } });
  });
});
