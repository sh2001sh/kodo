import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Application } from '../src/application/index.js';
import { simpleDefaultCard } from '../src/agents/card.js';
import { initialContext } from '../src/runtime/context.js';
import { childRole, mainRole, systemRules } from '../src/runtime/system-prompt.js';
import type { Provider } from '../src/runtime/types.js';

type ModelRequest = Parameters<Provider['complete']>[0];
import { answer, binding, call, calls, temp } from './helpers.js';

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
    // Route by role: the main run spawns once and then waits; the child answers.
    const main: ModelRequest[] = [];
    const child: ModelRequest[] = [];
    const provider = { async complete(request: ModelRequest) {
      const isChild = String(request.messages[0]!.content).includes('Main run ID:');
      (isChild ? child : main).push(structuredClone(request));
      if (isChild) return answer('The first line is a title.');
      return main.length === 1 ? calls(call('spawn_agent', { objective: 'Read README.md and report its first line.', scope: { write: [] } }, 'spawn')) : calls(call('wait_for_events', { run_ids: [childId()], mode: 'all' }, 'wait'));
    } };
    const childId = (): string => app.store.listRuns().find(item => item.parentId)!.id;
    const app = new Application(path.join(root, '.state'), provider, undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Summarize the project for a new contributor.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
      await app.coordinator.wake(run.id);
      await app.coordinator.wake(childId());
      expect(main.length).toBeGreaterThanOrEqual(1);
      expect(child.length).toBeGreaterThanOrEqual(1);
      expect(String(main[0]!.messages[0]!.content)).not.toContain('Main run ID:');
      const snapshot = normalize({ main: { messages: main[0]!.messages, tools: main[0]!.tools }, child: { messages: child[0]!.messages, tools: child[0]!.tools } }, root);
      if (process.env.KODO_UPDATE_DEFAULT_REQUEST === '1' || !existsSync(fixtureFile)) writeFileSync(fixtureFile, `${JSON.stringify(snapshot, null, 2)}\n`);
      expect(snapshot).toEqual(JSON.parse(readFileSync(fixtureFile, 'utf8')));
    } finally { await app.shutdown(); }
  });
});

describe('system prompt identity (phase 1f)', () => {
  it('opens every run with the same general-assistant rules and no retired experiment wording', () => {
    const card = simpleDefaultCard;
    const main = initialContext('/one', ['read'], card, 'Task one.', { id: 'run-a' })[0]!.content!;
    const other = initialContext('/two', ['read', 'write', 'exec'], card, 'Task two.', { id: 'run-b', finalResponse: 'optional', scope: { write: ['out'] } })[0]!.content!;
    const child = initialContext('/one', ['read'], card, 'Child task.', { id: 'run-c', parentId: 'run-a' })[0]!.content!;
    for (const text of [main, other, child]) expect(text.startsWith(`${systemRules} `)).toBe(true);
    expect(systemRules).toContain('You are Kodo, a general work assistant.');
    expect(main).toContain(mainRole);
    expect(child).toContain(childRole);
    expect(child).not.toContain(mainRole);
    for (const retired of ['send_message', 'followup_task', 'explore', 'task graph', 'team lead', 'coding agent', 'local task agent', 'KODO_RUN_OUTPUT_DIR', 'Workers check modules', 'todoId', 'dependsOn']) {
      expect(main).not.toContain(retired);
      expect(child).not.toContain(retired);
    }
    expect(card.prompt).not.toMatch(/fork_of|fresh child|coding work/u);
  });
});
