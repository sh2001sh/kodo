import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Application } from '../src/application/index.js';
import type { Provider } from '../src/runtime/types.js';

type ModelRequest = Parameters<Provider['complete']>[0];
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

/**
 * The single-default guardrail (phase 1e): the first main request and the first
 * child request of a default session, byte for byte after normalizing paths, IDs
 * and timestamps. Convergence batches must leave it unchanged; an intended prompt
 * change (1f) regenerates it with KODO_UPDATE_DEFAULT_REQUEST=1 and is reviewed.
 */
const fixtureFile = path.join(import.meta.dirname, 'fixtures', 'default-request.json');

function normalize(value: unknown, workspace: string): unknown {
  const escaped = [workspace, workspace.replaceAll('\\', '\\\\'), workspace.replaceAll('\\', '/')];
  let text = JSON.stringify(value);
  for (const form of escaped) text = text.split(JSON.stringify(form).slice(1, -1)).join('<WORKSPACE>');
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, '<ID>');
  text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, '<TIME>');
  return JSON.parse(text);
}

describe('default request invariants', () => {
  it('keeps the default main and child requests byte-stable', async () => {
    const root = temp();
    const requests: ModelRequest[] = [];
    const record = (response: ReturnType<typeof answer>) => async (request: ModelRequest) => { requests.push(structuredClone(request)); return response; };
    const provider = scripted(
      record(calls(call('spawn_agent', { objective: 'Read README.md and report its first line.', scope: { write: [] } }, 'spawn'))),
      record(answer('The first line is a title.')),
    );
    const app = new Application(path.join(root, '.state'), provider, undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Summarize the project for a new contributor.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
      await app.coordinator.wake(run.id);
      const child = app.store.listRuns(run.sessionId).find(item => item.parentId === run.id)!;
      await app.coordinator.wake(child.id);
      expect(requests).toHaveLength(2);
      const snapshot = normalize({ main: { messages: requests[0]!.messages, tools: requests[0]!.tools }, child: { messages: requests[1]!.messages, tools: requests[1]!.tools } }, root);
      if (process.env.KODO_UPDATE_DEFAULT_REQUEST === '1' || !existsSync(fixtureFile)) writeFileSync(fixtureFile, `${JSON.stringify(snapshot, null, 2)}\n`);
      expect(snapshot).toEqual(JSON.parse(readFileSync(fixtureFile, 'utf8')));
    } finally { await app.shutdown(); }
  });
});
