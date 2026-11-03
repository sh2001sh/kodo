import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultCard } from '../src/agents/card.js';
import { spawnAgentSpec } from '../src/messaging/spawn-spec.js';
import { followUpContext, initialContext, rebuildSummaryPrefix } from '../src/runtime/context.js';
import { attachment, attachmentKind } from '../src/runtime/attachments.js';
import { normalizeAgentFactors } from '../src/runtime/agent-factors.js';
import { splitContextLayers } from '../src/runtime/context-inspection.js';
import { initialInstructions, instructionMessage, prepareInstructionContext, refreshInstructions } from '../src/runtime/instruction-layer.js';
import { estimateTextTokens } from '../src/runtime/context-tokens.js';
import { withEnvironment } from '../src/runtime/state-frame.js';
import { answer, binding, fixture, temp } from './helpers.js';
import { Application } from '../src/application/index.js';
import type { Provider } from '../src/runtime/types.js';
import type { Message } from '../src/runtime/types.js';

const instructionMessageTokens = (message?: Message): number => message ? estimateTextTokens(JSON.stringify(message)) : 0;

describe('agent context factors', () => {
  it('keeps the complete R0 provider request byte-identical to a persisted legacy session', async () => {
    const root = temp(), state = path.join(root, 'seed');
    writeFileSync(path.join(root, 'AGENTS.md'), 'Use the project formatter and preserve public names.');
    const off = { A: false, B: false, C: false, D: false, E: false };
    const seed = new Application(state, undefined, undefined, { taskProtocol: 1, toolProfile: 'full', agentFactors: off, exploration: false, instructions: { global: false } });
    const run = seed.createRun({ objective: 'Read the project and summarize.', workspace: root, binding, permissions: ['read', 'write'] });
    await seed.shutdown();
    const requests: Parameters<Provider['complete']>[0][] = [];
    for (const legacy of [false, true]) {
      const directory = path.join(root, legacy ? 'legacy' : 'R0');
      cpSync(state, directory, { recursive: true });
      const app = new Application(directory, { async complete(request) { requests.push(structuredClone(request)); return answer(); } }, undefined, { agentFactors: off, exploration: false, instructions: { global: false } });
      try {
        if (legacy) {
          const session = app.store.session(run.sessionId);
          delete session.agentFactors;
          app.store.putSession(session);
          const rules = initialInstructions(root, { global: false, capacityBytes: 16_384 });
          app.store.updateRun(run.id, { contextRef: app.store.blob(initialContext(root, session.permissions, run.card, run.objective, run, instructionMessage(rules.chain))) });
        }
        expect((await app.run(run.id)).status).toBe('completed');
      } finally { await app.shutdown(); }
    }
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).toBe(JSON.stringify(requests[1]));
    expect(requests[0]!.tools.find(tool => tool.name === 'spawn_agent')!.parameters.properties).not.toHaveProperty('agent');
    expect(requests[0]!.tools.find(tool => tool.name === 'artifact.write')!.parameters.properties).not.toHaveProperty('kind');
    expect(requests[0]!.tools.some(tool => tool.name === 'agent.derive')).toBe(false);
  });

  it('preserves the legacy prompt bytes with all factors disabled and changes independent clauses', () => {
    const baseline = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' });
    const off = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, undefined, { factors: { A: false, B: false, C: false } });
    expect(JSON.stringify(off)).toBe(JSON.stringify(baseline));
    expect(normalizeAgentFactors()).toEqual({ A: false, B: false, C: false, D: false, E: false });
    const b = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, undefined, { factors: { B: true } });
    expect(b[0]!.content).toContain('Start each request with a brief plan of the steps and their dependencies.');
    expect(b[0]!.content).toContain('You are the team lead.');
    expect(b[0]!.content).toContain('After acceptance, finish');
    expect(b[0]!.content).toContain('Keep one main phase in_progress');
    expect(b[0]!.content).toContain('Have each owner deliver the implementation and actual check-call references together.');
    // 1d: the base main text carries the fresh/fork guidance; no removed collaboration tool is named.
    expect(b[0]!.content).toContain('fork_of continues a settled child with its exact context');
    for (const removed of ['followup_task', 'send_message', 'Use explore', 'todoId', 'executor main or agent', 'do small tasks directly', 'three or more files', 'Use spawn_agent only to change']) expect(b[0]!.content).not.toContain(removed);
    expect(b.slice(2)).toEqual(baseline.slice(2));
    // Factor C is an independent paragraph of the assembled (task protocol >= 2) policy.
    const structured = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, undefined, { taskProtocol: 2 });
    const c = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, undefined, { factors: { C: true }, taskProtocol: 2 });
    expect(structured[0]!.content).not.toContain('inherit your card and permissions');
    expect(c[0]!.content).toContain('Delegate whole independent outcomes to children that inherit your card and permissions; they may only narrow them.');
    expect(c[0]!.content).toContain('Use a fresh child for independent black-box review.');
    expect(c[0]!.content).not.toContain('named input slots');
    expect(c.slice(1)).toEqual(structured.slice(1));
  });

  it('keeps team-lead responsibilities out of child prompts', () => {
    const context = initialContext('workspace', ['read'], defaultCard, 'Find the parser entry point.', { id: 'child', parentId: 'main' }, undefined, { factors: { A: true, B: true, C: true } });
    const text = context.map(message => message.content).join('\n');
    expect(text).toContain('You cannot spawn children, cancel runs or ask the user');
    expect(text).not.toContain('Start each request with a brief plan');
    expect(text).not.toContain('You are the team lead');
    expect(text).not.toContain('Delegate substantive investigation');
    expect(text).not.toContain('followup_task');
  });

  it.each([
    { A: false, B: true, C: false },
    { A: true, B: true, C: true },
    { A: true, B: false, C: true },
  ])('delivers consistent role and dispatch guidance across main follow-ups with %j', async factors => {
    const requests: Parameters<Provider['complete']>[0][] = [];
    const { app, runId } = fixture({ async complete(request) {
      requests.push(structuredClone(request));
      return answer('Acknowledged the current task.');
    } }, undefined, { agentFactors: factors });
    await app.run(runId);
    const next = app.submitInput(runId, 'Explain the next project phase.');
    await app.run(next.id);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.messages[0]!.content!.includes('You are the team lead.')).toBe(factors.B);
      const spawn = request.tools.find(tool => tool.name === 'spawn_agent')!;
      // 1d: the spawn description no longer varies with agent factors.
      expect(spawn.description.startsWith(spawnAgentSpec.description)).toBe(true);
      for (const removed of ['Choose delegation', 'explore', 'followup_task', 'continue your independent work']) expect(spawn.description).not.toContain(removed);
      if (factors.B) expect(request.messages[0]!.content).toContain('Have each owner deliver the implementation and actual check-call references together');
      // The roster selectors are gone for every card and factor combination.
      expect(Object.hasOwn(spawn.parameters.properties as object, 'agent')).toBe(false);
      expect(Object.hasOwn(spawn.parameters.properties as object, 'slots')).toBe(false);
      expect(request.tools.some(tool => tool.name === 'file.patch')).toBe(true);
    }
  });

  it('keeps B/C-only project instruction bytes identical to R0', () => {
    const { app, root, runId } = fixture(undefined, undefined, { agentFactors: { A: false, B: false, C: false }, instructions: { global: false } });
    writeFileSync(path.join(root, 'AGENTS.md'), 'Use the project formatter.');
    const run = app.store.run(runId), session = app.store.session(run.sessionId);
    const baseline = prepareInstructionContext(app.store, run, session, { global: false });
    for (const factors of [{ B: true }, { C: true }]) {
      const candidate = prepareInstructionContext(app.store, run, { ...session, agentFactors: factors }, { global: false });
      expect(candidate.messages.slice(2)).toEqual(baseline.messages.slice(2));
      expect(candidate.instructions).toEqual(baseline.instructions);
    }
  });

  it('orders L3 project instructions ahead of the environment without a roster layer', () => {
    const messages = withEnvironment(initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, attachment('project-instructions', 'rules'), { factors: { A: true } }), attachment('environment', 'env'));
    expect(messages.map(attachmentKind)).toEqual([undefined, undefined, 'project-instructions', 'environment', undefined]);
    const layers = splitContextLayers(messages);
    expect(layers.L2).toHaveLength(1);
    expect(layers.L2[0]!.content).toContain('Agent method configuration');
    expect(layers.L5).toEqual([{ role: 'user', content: 'objective' }]);
    const child = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'child', parentId: 'main' }, undefined, { factors: { A: true } });
    expect(child.some(message => attachmentKind(message) === 'agents')).toBe(false);
  });

  it('keeps the objective across a same-session follow-up without a roster attachment', () => {
    const { app, runId } = fixture();
    const source = app.store.run(runId);
    const next = { ...source, id: 'next', historyFrom: source.id, contextRef: '', objective: 'Continue with the next task.' };
    const context = followUpContext(app.store, source, next);
    expect(context.some(message => attachmentKind(message) === 'agents')).toBe(false);
    expect(context.at(-1)?.content).toBe(next.objective);
  });

  it('loads actual card rule files and includes under a rendered token budget', () => {
    const root = temp();
    mkdirSync(path.join(root, 'rules'));
    writeFileSync(path.join(root, 'rules', 'style.md'), 'Use the local formatter.\n@details.md');
    writeFileSync(path.join(root, 'rules', 'details.md'), 'Keep exported names stable.');
    const result = initialInstructions(root, { global: false, capacityBytes: 16_384, capacityTokens: 500, cardRules: ['rules/style.md'] });
    expect(result.chain.text).toContain('Use the local formatter.');
    expect(result.chain.text).toContain('Keep exported names stable.');
    expect(result.state.cardRules).toEqual(['rules/style.md']);
    expect(result.state.sources?.['rules/details.md']).toMatch(/^[a-f0-9]{64}$/);
    expect(instructionMessageTokens(instructionMessage(result.chain, 'initial'))).toBeLessThanOrEqual(500);
    const empty = initialInstructions(root, { global: false, capacityBytes: 16_384, capacityTokens: 0, cardRules: ['rules/style.md'] });
    expect(instructionMessage(empty.chain)).toBeUndefined();
  });

  it('rejects an oversized mandatory method instead of exceeding the shared instruction allowance', () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    const oversized = { ...run, card: { ...run.card, prompt: 'Mandatory method details. '.repeat(10_000) } };
    expect(() => prepareInstructionContext(app.store, oversized, session, { global: false })).toThrow('shared instruction allowance');
  });

  it('preserves card rules and instructions through instruction refresh and summary rebuild', () => {
    const { app, root, runId } = fixture();
    writeFileSync(path.join(root, 'card-rule.md'), 'Initial rule.');
    const run = app.store.run(runId);
    run.card = { ...run.card, constraints: { rules: ['card-rule.md'] } };
    const prepared = prepareInstructionContext(app.store, run, app.store.session(run.sessionId), { global: false });
    app.store.updateRun(run.id, { card: run.card, contextRef: app.store.blob(prepared.messages), instructions: prepared.instructions });
    writeFileSync(path.join(root, 'card-rule.md'), 'Updated rule.');
    const delta = refreshInstructions(app.store, app.store.run(run.id), app.store.session(run.sessionId));
    expect(delta?.content).toContain('Updated rule.');
    const rebuilt = rebuildSummaryPrefix(app.store, app.store.run(run.id), [...prepared.messages, ...(delta ? [delta] : [])]);
    expect(rebuilt.instructions?.state.cardRules).toEqual(['card-rule.md']);
    expect(rebuilt.messages.find(message => attachmentKind(message) === 'project-instructions')?.content).toContain('Updated rule.');
  });
});
