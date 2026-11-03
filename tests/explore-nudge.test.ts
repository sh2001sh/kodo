import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { attachmentBody, attachmentKind } from '../src/runtime/attachments.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message, Provider } from '../src/runtime/types.js';
import { answer, binding, call, calls, temp } from './helpers.js';

type Request = Parameters<Provider['complete']>[0];
const nudgeText = 'Runtime delegation check';
/** Nudges arrive as kernel `nudge` blocks, never as plain user text. */
const isNudge = (message: Message): boolean => attachmentKind(message) === 'nudge' && attachmentBody(message).startsWith(nudgeText);
const nudges = (request: Request): number => request.messages.filter(isNudge).length;

/** Main reads one file per step for `reads` steps, then answers; records every main request. */
function reader(reads: number, firstStep?: () => ReturnType<typeof calls>) {
  const requests: Request[] = [];
  let step = 0;
  const provider: Provider = { async complete(request) {
    requests.push(request);
    const index = step++;
    if (index === 0 && firstStep) return firstStep();
    // Distinct files keep the stall guard out of the way.
    if (index < reads) return calls(call('file.read', { path: `f${index}.txt` }, `read-${index}`));
    return answer('finished');
  } };
  return { provider, requests };
}

function setup(provider: Provider, options: ConstructorParameters<typeof Application>[3] = {}) {
  const root = temp();
  for (let index = 0; index < 8; index++) writeFileSync(path.join(root, `f${index}.txt`), `file ${index}\n`);
  const app = new Application(path.join(root, '.state'), provider, undefined, options);
  const run = app.createRun({ objective: 'Survey the project.', workspace: root, binding, permissions: ['read'] });
  return { app, runId: run.id };
}

describe('runtime explore nudge', () => {
  it('injects one suggestion after the threshold of direct reads and records it once', async () => {
    const { provider, requests } = reader(6);
    const { app, runId } = setup(provider, { exploreNudge: 3 });
    try {
      const done = await app.run(runId);
      expect(done.status, done.error).toBe('completed');
      // Requests 0-2 precede the third successful read; request 3 is the first to see the nudge.
      expect(requests.slice(0, 3).map(nudges)).toEqual([0, 0, 0]);
      expect(requests.slice(3).every(request => nudges(request) === 1)).toBe(true);
      const events = app.store.events(runId).filter(event => event.type === 'delegation.nudged');
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toMatchObject({ readCalls: 3, threshold: 3, step: 2 });
      const context = app.store.readBlob<Message[]>(app.store.run(runId).contextRef);
      expect(context.filter(isNudge)).toHaveLength(1);
    } finally { await app.shutdown(); }
  });

  it('stays silent below the threshold, when disabled, or after the run already delegated', async () => {
    const below = reader(3);
    const quiet = setup(below.provider, { exploreNudge: 5 });
    const off = reader(6);
    const disabled = setup(off.provider, { exploreNudge: false });
    const delegated = reader(6, () => calls(call('explore', { tasks: [{ prompt: 'Map the project' }] }, 'explore')));
    // Explore children reuse the provider; give them a direct answer so only the main is scripted.
    const childAware: Provider = { async complete(request, signal, onText) {
      const system = request.messages.find(message => message.role === 'system')?.content ?? '';
      const id = /Run ID: ([^. ]+)\./u.exec(system)?.[1];
      if (id && withExplore.app.store.run(id).parentId) return answer('Report: f0.txt holds file 0.');
      return delegated.provider.complete(request, signal, onText);
    } };
    const withExplore = setup(childAware, { exploreNudge: 2 });
    try {
      for (const { app, runId } of [quiet, disabled, withExplore]) {
        expect((await app.run(runId)).status).toBe('completed');
        expect(app.store.events(runId).some(event => event.type === 'delegation.nudged')).toBe(false);
      }
      expect(withExplore.app.store.calls(withExplore.runId).find(call => call.name === 'explore')?.status).toBe('succeeded');
      expect(withExplore.app.store.listRuns(withExplore.app.store.run(withExplore.runId).sessionId).filter(run => run.parentId === withExplore.runId)).toHaveLength(1);
      for (const request of [...below.requests, ...off.requests, ...delegated.requests]) expect(nudges(request)).toBe(0);
    } finally { for (const { app } of [quiet, disabled, withExplore]) await app.shutdown(); }
  });

  it('is off by default, so a host that does not opt in never sees the nudge', async () => {
    const { provider, requests } = reader(8);
    const { app, runId } = setup(provider);
    try {
      expect((await app.run(runId)).status).toBe('completed');
      expect(requests.every(request => nudges(request) === 0)).toBe(true);
      expect(app.store.events(runId).some(event => event.type === 'delegation.nudged')).toBe(false);
    } finally { await app.shutdown(); }
  });

  it('rejects an invalid threshold at construction', () => {
    const root = temp();
    for (const value of [0, -1, 1.5]) {
      expect(() => new Application(path.join(root, `.state-${String(value)}`), reader(0).provider, undefined, { exploreNudge: value })).toThrow(KodoError);
    }
  });
});
