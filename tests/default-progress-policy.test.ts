import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { legacySimpleDefaultCard, simpleDefaultCard } from '../src/agents/card.js';
import { Application } from '../src/application/index.js';
import type { Message } from '../src/runtime/types.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

describe('versioned default progress policy', () => {
  it('keeps the frozen simple card version and enables advice only in the new version', () => {
    expect(legacySimpleDefaultCard).toMatchObject({ id: 'builtin/general-simple', version: '1.2.0' });
    expect(legacySimpleDefaultCard.nudges).toBeUndefined();
    expect(simpleDefaultCard).toMatchObject({ id: legacySimpleDefaultCard.id, version: '1.3.0', nudges: true, tools: legacySimpleDefaultCard.tools, prompt: legacySimpleDefaultCard.prompt });
    expect(simpleDefaultCard.digest).not.toBe(legacySimpleDefaultCard.digest);
  });

  it.each([false, true])('delivers progress advice through the actual default coordinator (memory=%s)', async memory => {
    const root = temp();
    writeFileSync(path.join(root, 'a.txt'), Array.from({ length: 8 }, (_, index) => `line ${index}`).join('\n'));
    let finalContext: Message[] = [];
    const app = new Application(path.join(root, '.state'), scripted(
      ...Array.from({ length: 8 }, (_, index) => calls(call('file.read', { path: 'a.txt', offset: index + 1, limit: 1 }, `read-${index}`))),
      async request => { finalContext = request.messages; return answer('Analysis complete.'); },
    ), undefined, { instructions: { global: false }, memory });
    try {
      const run = app.createRun({ objective: 'Inspect the file and report the line structure without editing it.', workspace: root, binding, permissions: ['read', 'write'], budget: { maxModelCalls: 20, maxTokens: 1_000_000 } });
      expect(run.card).toMatchObject({ version: '1.3.0', nudges: true });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      const notices = app.store.events(run.id, { types: ['progress.write_nudged'] });
      expect(notices).toHaveLength(1);
      expect(notices[0]!.data.readCalls).toBe(8);
      expect(finalContext.some(message => message.role === 'user' && message.content.includes('Runtime progress check:'))).toBe(true);
    } finally { await app.shutdown(); }
  });

  it('reopens old sessions without rewriting their card while new sessions use the new policy', async () => {
    const root = temp(), directory = path.join(root, '.state');
    const original = new Application(directory, scripted(answer()), undefined, { instructions: { global: false }, agentFactors: { A: false } });
    const oldRun = original.createRun({ objective: 'Continue a saved session.', workspace: root, binding, card: legacySimpleDefaultCard });
    await original.shutdown();
    const upgraded = new Application(directory, scripted(answer()), undefined, { instructions: { global: false }, agentFactors: { A: false } });
    try {
      const current = upgraded.createRun({ objective: 'Use the default policy.', workspace: root, binding });
      expect(current.card).toEqual(simpleDefaultCard);
      expect(upgraded.store.run(oldRun.id).card).toEqual(legacySimpleDefaultCard);
      expect(upgraded.store.card(legacySimpleDefaultCard.id, '1.2.0')).toEqual(legacySimpleDefaultCard);
      const result = await upgraded.run(oldRun.id);
      expect(result.status, result.error).toBe('completed');
      expect(upgraded.store.run(oldRun.id).card.nudges).toBeUndefined();
    } finally { await upgraded.shutdown(); }
  });
});
