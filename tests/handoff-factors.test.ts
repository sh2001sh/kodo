import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { initialContext } from '../src/runtime/context.js';
import { mainRole } from '../src/runtime/system-prompt.js';
import { simpleDefaultCard } from '../src/agents/card.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { answer, binding, fullToolCard, scripted, temp } from './helpers.js';

const forbidden = /explore|exploration\.plan|followup_task|send_message|list_agents|interrupt_agent/u;

describe('fresh-child review guidance', () => {
  it('keeps the default main and child kernels free of removed collaboration tools', () => {
    for (const identity of [{ id: 'main' }, { id: 'child', parentId: 'main' }]) {
      const context = initialContext('workspace', ['read'], simpleDefaultCard, 'objective', identity);
      for (const message of context) expect(message.content ?? '').not.toMatch(forbidden);
    }
    expect(mainRole).not.toMatch(forbidden);
    expect(mainRole).toContain('start a fresh child with the artifacts and acceptance checks, not your conclusions');
  });

  it('exposes exactly the five collaboration operations plus task, and update_progress as a native tool', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Inspect a bounded task.', workspace: root, binding });
      expect(app.coordinator.mailbox.specs(run).map(spec => spec.name)).toEqual(['spawn_agent', 'inspect_run', 'wait_for_events', 'ask_user', 'cancel_agent']);
      const native = toolSpecs(app.coordinator, run, app.store.session(run.sessionId)).map(spec => spec.name);
      // update_progress is a native tool, deliberately hidden in the default card view; other cards keep it.
      expect(native).not.toContain('update_progress');
      for (const removed of ['send_message', 'followup_task', 'explore', 'exploration.plan', 'agent.derive', 'report.submit', 'list_agents', 'interrupt_agent']) expect(native).not.toContain(removed);
    } finally { await app.shutdown(); }
    const fullApp = new Application(path.join(root, '.state-full'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = fullApp.createRun({ objective: 'Inspect a bounded task.', workspace: root, binding, card: fullToolCard });
      expect(fullApp.coordinator.mailbox.specs(run).map(spec => spec.name)).not.toContain('update_progress');
      expect(toolSpecs(fullApp.coordinator, run, fullApp.store.session(run.sessionId)).map(spec => spec.name)).toContain('update_progress');
    } finally { await fullApp.shutdown(); }
  });
});
