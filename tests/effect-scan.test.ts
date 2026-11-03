import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureEffects, reconcileEffects } from '../src/tools/effect-scan.js';

const limits = { entries: 1000, ms: 2000, quietMs: 20 };
function workspace(): string { return mkdtempSync(path.join(tmpdir(), 'kodo-effect-scan-')); }

describe('process effect reconciliation', () => {
  it('compares the pre-dispatch baseline with stable post-exit metadata', async () => {
    const root = workspace();
    try {
      writeFileSync(path.join(root, 'removed.txt'), 'old');
      writeFileSync(path.join(root, 'edited.txt'), 'before');
      mkdirSync(path.join(root, '.state'));
      const excluded = [path.join(root, '.state')];
      const before = await captureEffects(root, [root], excluded, true, limits);
      unlinkSync(path.join(root, 'removed.txt'));
      writeFileSync(path.join(root, 'edited.txt'), 'after with different size');
      writeFileSync(path.join(root, 'new.txt'), 'new');
      writeFileSync(path.join(root, '.state', 'db'), 'private');
      const evidence = await reconcileEffects(root, [root], before, excluded, true, limits);
      expect(evidence).toMatchObject({ verified: true, outcome: 'applied', changed: ['edited.txt', 'new.txt', 'removed.txt'], changedCount: 3, exitConfirmation: 'process-tree' });
      expect(evidence.verified && evidence.beforeHash).not.toBe(evidence.verified && evidence.afterHash);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('settles an unchanged scope as not_applied', async () => {
    const root = workspace();
    try {
      writeFileSync(path.join(root, 'existing.txt'), 'keep');
      const before = await captureEffects(root, [root], [], true, limits);
      expect(await reconcileEffects(root, [root], before, [], true, limits)).toMatchObject({ verified: true, outcome: 'not_applied', changed: [], changedCount: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not claim a complete observation when isolation is absent', async () => {
    const root = workspace();
    try {
      const before = await captureEffects(root, [root], [], false, limits);
      expect(before.complete).toBe(false);
      expect(await reconcileEffects(root, [root], before, [], false, limits)).toMatchObject({ verified: false, reason: expect.stringMatching(/no OS sandbox/) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('without isolation, settles from entries changed since the command started', async () => {
    const root = workspace();
    try {
      writeFileSync(path.join(root, 'old.txt'), 'untouched');
      mkdirSync(path.join(root, 'nested'));
      const past = new Date(Date.now() - 60_000);
      const { utimesSync } = await import('node:fs');
      for (const entry of ['old.txt', 'nested', '.']) utimesSync(path.join(root, entry), past, past);
      const startedAt = Date.now() + 5_000;
      const before = await captureEffects(root, [root], [], false, limits);
      // ctime cannot be set backwards, so a start time after setup stands in for an older run.
      expect(await reconcileEffects(root, [root], before, [], false, limits, startedAt)).toMatchObject({ verified: true, outcome: 'not_applied', changedCount: 0, basis: 'workspace-change-time', unobserved: 'outside-roots' });
      // utimes refreshed ctime; wait past the timestamp slack so old.txt predates the command.
      await new Promise(resolve => setTimeout(resolve, 2_200));
      const started = Date.now();
      writeFileSync(path.join(root, 'nested', 'new.txt'), 'created');
      const evidence = await reconcileEffects(root, [root], before, [], false, limits, started);
      expect(evidence).toMatchObject({ verified: true, outcome: 'applied', basis: 'workspace-change-time', changed: expect.arrayContaining([path.join('nested', 'new.txt')]) });
      expect(evidence.verified && evidence.changed).not.toContain('old.txt');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports a write root created after the baseline', async () => {
    const root = workspace();
    try {
      const target = path.join(root, 'created');
      const before = await captureEffects(root, [target], [], true, limits);
      mkdirSync(target);
      expect(await reconcileEffects(root, [target], before, [], true, limits)).toMatchObject({ verified: true, outcome: 'applied', changed: ['created'] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('leaves an incomplete baseline unsettled when the entry budget is exceeded', async () => {
    const root = workspace();
    try {
      for (let index = 0; index < 5; index++) writeFileSync(path.join(root, `file-${index}.txt`), 'x');
      const bounded = { ...limits, entries: 3 };
      const before = await captureEffects(root, [root], [], true, bounded);
      expect(await reconcileEffects(root, [root], before, [], true, bounded)).toMatchObject({ verified: false, reason: expect.stringMatching(/reconciliation budget/) });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});