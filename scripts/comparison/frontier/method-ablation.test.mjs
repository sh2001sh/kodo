import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { plan, limits, runnerArgs } from './method-ablation.mjs';
import { arms, configureMethods, methods, validateArm } from './method-worker.mjs';

test('historical task matrix keeps model geometry and rotates five treatments', () => {
  const cells = plan();
  assert.equal(cells.length, 10);
  assert.deepEqual(cells.slice(0, 5).map(cell => cell.arm), ['resident', 'skill', 'marking', 'checkpoint', 'active']);
  assert.deepEqual(cells.slice(5).map(cell => cell.arm), ['skill', 'marking', 'checkpoint', 'active', 'resident']);
  assert.deepEqual(limits, { contextTokens: 1048576, outputTokens: 393216, timeoutSec: 5400 });
  for (const cell of cells) {
    const args = runnerArgs(cell, '/evidence');
    assert.equal(args[args.indexOf('--task') + 1], cell.task);
    assert.equal(args[args.indexOf('--kodo-method-arm') + 1], cell.arm);
    assert.equal(args.includes('--instruction-suffix'), false);
  }
  assert.throws(() => plan(['fastapi', 'fastapi']));
  assert.throws(() => validateArm('unknown'));
});
test('all treatments use the same three generic methods without benchmark answers', () => {
  assert.equal(methods.length, 3);
  assert.equal(new Set(methods.map(method => method.id)).size, 3);
  assert.equal(methods.some(method => /fastapi|statemachine|deprecation|state.data/i.test(method.content)), false);
});

test('the frozen adapter actually exposes and loads all three methods in every treatment', async () => {
  const [{ Application }, { serializeCard }, { methodSkillId }, { roleAllows }] = await Promise.all([
    import('../../../dist/application/index.js'), import('../../../dist/agents/card.js'), import('../../../dist/extensions/methods.js'), import('../../../dist/runtime/role-view.js'),
  ]);
  for (const arm of arms) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-method-adapter-'));
    const inline = ['marking', 'checkpoint', 'active'].includes(arm);
    const app = new Application(path.join(root, 'state'), undefined, undefined, { toolProfile: 'compact-v2', skills: [], ...(inline ? { inlineMethods: true } : {}) });
    try {
      const { cards, card } = configureMethods(app, arm, { serializeCard, methodSkillId, roleAllows });
      const run = app.createRun({ workspace: root, objective: 'Isolated adapter configuration check.', card, permissions: ['read', 'write', 'exec'], binding: { model: 'synthetic-unused', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'UNUSED_TEST_KEY' } });
      const catalog = await app.coordinator.tools.execute(run.id, 'skill.list', {}, new globalThis.AbortController().signal);
      assert.deepEqual(catalog.skills.map(skill => skill.id).sort(), cards.map(methodSkillId).sort(), arm);
      assert.equal(catalog.unavailableMethods?.length ?? 0, 0, arm);
      for (const method of cards) {
        const loaded = await app.coordinator.tools.execute(run.id, 'skill.load', { id: methodSkillId(method) }, new globalThis.AbortController().signal);
        assert.equal(loaded.content, method.prompt, arm);
      }
    } finally { await app.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
});
