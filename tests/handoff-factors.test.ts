import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { initialContext } from '../src/runtime/context.js';
import { applyAgentFactors, parallelMainGuidance, reviewGuidance } from '../src/runtime/agent-factors.js';
import { defaultCard } from '../src/agents/card.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import { answer, binding, scripted, temp } from './helpers.js';

const forbidden = /explore|exploration\.plan|followup_task|send_message|list_agents|interrupt_agent/u;

describe('fresh-child review guidance', () => {
  it('keeps the default kernel and factor guidance free of removed collaboration tools', () => {
    const context = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' });
    for (const message of context) expect(message.content ?? '').not.toMatch(forbidden);
    for (const factors of [{}, { A: true }, { B: true }, { C: true }, { D: true }, { E: true }]) {
      for (const taskProtocol of [1, 2, 3] as const) {
        for (const toolProfile of ['compact-v1', 'compact-v2', 'full'] as const) {
          expect(parallelMainGuidance(factors, taskProtocol, toolProfile)).not.toMatch(forbidden);
        }
      }
    }
    expect(parallelMainGuidance({}, 2, 'compact-v2')).toContain('fresh');
    expect(reviewGuidance).toContain('fresh child');
    expect(reviewGuidance).toContain('not the implementer');
  });

  it('rewrites legacy main prompts to fresh black-box review without growing the default identity', () => {
    const legacy = `${defaultCard.prompt} Use send_message for peer updates and followup_task for reuse.`;
    const rewritten = applyAgentFactors(legacy, { B: true, C: true, D: true });
    expect(rewritten).not.toMatch(/send_message|followup_task/u);
    expect(rewritten).toContain('fresh child');
    // The published card itself is unchanged by rendering-time factors.
    expect(defaultCard.prompt).not.toMatch(/fork_of/u);
  });

  it('exposes exactly the five collaboration operations plus task, and update_progress as a native tool', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Inspect a bounded task.', workspace: root, binding });
      expect(app.coordinator.mailbox.specs(run).map(spec => spec.name)).toEqual(['spawn_agent', 'inspect_run', 'wait_for_events', 'ask_user', 'cancel_agent']);
      const native = toolSpecs(app.coordinator, run, app.store.session(run.sessionId)).map(spec => spec.name);
      expect(native).toContain('update_progress');
      for (const removed of ['send_message', 'followup_task', 'explore', 'exploration.plan', 'agent.derive', 'report.submit', 'list_agents', 'interrupt_agent']) expect(native).not.toContain(removed);
    } finally { await app.shutdown(); }
  });
});
