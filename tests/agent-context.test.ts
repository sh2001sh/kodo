import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultCard } from '../src/agents/card.js';
import type { RosterSnapshot } from '../src/agents/roster.js';
import { followUpContext, initialContext, rebuildSummaryPrefix } from '../src/runtime/context.js';
import { attachment, attachmentBody, attachmentKind } from '../src/runtime/attachments.js';
import { normalizeAgentFactors } from '../src/runtime/agent-factors.js';
import { splitContextLayers } from '../src/runtime/context-inspection.js';
import { initialInstructions, instructionMessage, prepareInstructionContext, refreshInstructions } from '../src/runtime/instruction-layer.js';
import { instructionMessageTokens, renderRoster } from '../src/runtime/roster-context.js';
import { withEnvironment } from '../src/runtime/state-frame.js';
import { answer, binding, fixture, temp } from './helpers.js';
import { Application } from '../src/application/index.js';
import type { Provider } from '../src/runtime/types.js';
import { childCard, delegationGuidance, teamDelegationGuidance } from '../src/agents/child-card.js';

function snapshot(count = 12): RosterSnapshot {
  return { sessionId: 'session', digest: 'f'.repeat(64), ordering: 'catalog.path,id,numeric-version', warnings: [], catalogDescriptions: {},
    members: Array.from({ length: count }, (_, index) => ({ card: { ...defaultCard, id: `member/${index}`, name: `Member ${index}`, prompt: 'PRIVATE METHOD', tools: ['file.read'], constraints: { rules: ['private-rules.md'] } }, catalogPath: `area${index}/work`, source: 'builtin', availability: 'available', reasons: [], ...(index < 2 ? { fixedOrder: 1 - index } : {}) })) };
}

describe('agent context factors and frozen roster', () => {
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

  it('removes all main-only agent tools from child views without changing the registered card', () => {
    const card = { ...defaultCard, tools: [...defaultCard.tools, 'agent.propose', 'agent.retain'] };
    const child = childCard(card);
    expect(child.tools.some(name => name.startsWith('agent.'))).toBe(false);
    expect(child.digest).toBe(card.digest);
    expect(card.tools).toContain('agent.retain');
  });
  it('preserves the legacy prompt bytes with all factors disabled and changes independent clauses', () => {
    const baseline = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' });
    const off = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, undefined, { factors: { A: false, B: false, C: false }, roster: attachment('agents', 'ignored') });
    expect(JSON.stringify(off)).toBe(JSON.stringify(baseline));
    expect(normalizeAgentFactors()).toEqual({ A: false, B: false, C: false, D: false, E: false });
    const b = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, undefined, { factors: { B: true } });
    expect(b[0]!.content).toContain('Start each request with a brief plan of the steps and their dependencies.');
    expect(b[0]!.content).toContain('You are the team lead.');
    expect(b[0]!.content).toContain('Choose delegation when parallel work, specialist expertise or a separate context outweighs handoff and acceptance costs.');
    expect(b[0]!.content).toContain('Execute small bounded tasks directly, including implementation and verification');
    expect(b[0]!.content).toContain('After acceptance, finish');
    expect(b[0]!.content).toContain('If delegation is blocked, explain the constraint');
    expect(b[0]!.content).not.toContain('do small tasks directly');
    expect(b[0]!.content).toContain('Reuse a suitable idle teammate with followup_task');
    expect(b[0]!.content).toContain('Keep one main phase in_progress');
    expect(b[0]!.content).not.toContain('three or more files');
    expect(b[0]!.content).not.toContain('Use spawn_agent only to change');
    expect(b[0]!.content).toContain('give each child objective, inputs, constraints and acceptance checks');
    expect(b[1]!.content).toContain(teamDelegationGuidance);
    expect(b[1]!.content).not.toContain(delegationGuidance);
    expect(defaultCard.prompt).toContain(delegationGuidance);
    expect(b.slice(2)).toEqual(baseline.slice(2));
    const c = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, undefined, { factors: { C: true } });
    expect(c[0]!.content).toContain('Use spawn_agent only to change independent modules');
    expect(c[0]!.content).toContain('named input slots');
  });

  it('keeps team-lead responsibilities out of child prompts', () => {
    const card = childCard(defaultCard);
    const context = initialContext('workspace', ['read'], card, 'Find the parser entry point.', { id: 'child', parentId: 'main' }, undefined, { factors: { A: true, B: true, C: true } });
    const text = context.map(message => message.content).join('\n');
    expect(text).toContain('You cannot spawn agents');
    expect(text).not.toContain('Start each request with a brief plan');
    expect(text).not.toContain('You are the team lead');
    expect(text).not.toContain('Delegate substantive investigation');
    expect(text).not.toContain('followup_task');
    expect(text).not.toContain(teamDelegationGuidance);
    expect(text).not.toContain(delegationGuidance);
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
      expect(spawn.description.includes('Choose delegation when its benefit exceeds handoff and acceptance costs')).toBe(factors.B);
      if (factors.B) {
        expect(spawn.description).not.toContain('For read-only investigation use explore instead.');
        expect(spawn.description).not.toContain('continue your independent work');
        expect(request.messages[0]!.content).toContain('Have each owner deliver the implementation and actual check-call references together');
      }
      expect(Object.hasOwn(spawn.parameters.properties as object, 'agent')).toBe(factors.A || factors.C);
      expect(request.tools.some(tool => tool.name === 'file.patch')).toBe(true);
    }
  });

  it('fits rendered token budgets, prioritizes fixed members, and excludes private and unavailable metadata', () => {
    const frozen = snapshot();
    frozen.members[11]!.availability = 'unavailable';
    const full = renderRoster(frozen, 100_000);
    const body = JSON.parse(attachmentBody(full.message!));
    expect(body.members.slice(0, 2).map((member: { id: string }) => member.id)).toEqual(['member/1', 'member/0']);
    expect(full.message!.content).not.toContain('PRIVATE METHOD');
    expect(full.message!.content).not.toContain('private-rules.md');
    expect(body.members).toHaveLength(11);
    expect(renderRoster(frozen, 0)).toMatchObject({ tokens: 0, degraded: 'empty', hiddenMembers: 11 });
    for (const budget of [60, 120, 300, 600, 1200]) {
      const view = renderRoster(frozen, budget);
      expect(view.tokens).toBeLessThanOrEqual(budget);
      expect(view.tokens).toBe(instructionMessageTokens(view.message));
      if (view.message) expect(() => JSON.parse(attachmentBody(view.message!))).not.toThrow();
    }
    expect(renderRoster(frozen, 100_000)).toEqual(full);
  });

  it('uses a virtual root or paging-only entry when category descriptions consume the allowance', () => {
    const frozen = snapshot(1);
    delete frozen.members[0]!.fixedOrder;
    frozen.catalogDescriptions.area0 = 'Long category description. '.repeat(2000);
    const root = renderRoster(frozen, 500);
    expect(root.degraded).toBe('root');
    expect(JSON.parse(attachmentBody(root.message!)).root).toEqual({ path: '/', categories: 1, members: 1 });
    const paging = renderRoster(frozen, 100);
    expect(paging.degraded).toBe('paging');
    expect(JSON.parse(attachmentBody(paging.message!)).directory).toContain('agent.directory');
  });

  it('distinguishes inline-only methods from children and preserves the catalog budget', () => {
    const frozen = snapshot(3);
    frozen.members[0]!.card.execution = { modes: ['inline'] };
    frozen.members[1]!.card.execution = { modes: ['inline', 'child'] };
    const off = JSON.parse(attachmentBody(renderRoster(frozen, 10000).message!));
    expect(off.members.map((member: { id: string }) => member.id)).not.toContain('member/0');
    expect(off.members.every((member: { inline_method?: unknown }) => !member.inline_method)).toBe(true);
    const on = JSON.parse(attachmentBody(renderRoster(frozen, 10000, true).message!));
    expect(on.members.find((member: { id: string }) => member.id === 'member/0')).toMatchObject({ execution_modes: ['inline'], inline_method: { load: 'skill.load', availability_check: 'skill.list' } });
    expect(on.members.find((member: { id: string }) => member.id === 'member/2')).not.toHaveProperty('inline_method');
    for (const budget of [0, 100, 300, 1000]) {
      const view = renderRoster(frozen, budget, true);
      expect(view.tokens).toBeLessThanOrEqual(budget);
      expect(view.tokens).toBe(instructionMessageTokens(view.message));
      expect(view.message?.content ?? '').not.toContain('PRIVATE METHOD');
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

  it('orders and measures the roster as L2 ahead of instructions and environment', () => {
    const roster = renderRoster(snapshot(2), 10_000).message!;
    const messages = withEnvironment(initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, attachment('project-instructions', 'rules'), { factors: { A: true }, roster }), attachment('environment', 'env'));
    expect(messages.map(attachmentKind)).toEqual([undefined, undefined, 'agents', 'project-instructions', 'environment', undefined]);
    const layers = splitContextLayers(messages);
    expect(layers.L2).toHaveLength(2);
    expect(layers.L5).toEqual([{ role: 'user', content: 'objective' }]);
    const child = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'child', parentId: 'main' }, undefined, { factors: { A: true }, roster });
    expect(child.some(message => attachmentKind(message) === 'agents')).toBe(false);
  });

  it('carries the same frozen roster into a same-session follow-up', () => {
    const { app, runId } = fixture();
    const source = app.store.run(runId);
    const original = app.store.readBlob<Parameters<typeof splitContextLayers>[0]>(source.contextRef);
    const roster = original.find(message => attachmentKind(message) === 'agents');
    expect(roster).toBeDefined();
    const next = { ...source, id: 'next', historyFrom: source.id, contextRef: '', objective: 'Continue with the next task.' };
    const context = followUpContext(app.store, source, next);
    expect(context.find(message => attachmentKind(message) === 'agents')).toEqual(roster);
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

  it('preserves card rules and frozen roster through instruction refresh and summary rebuild', () => {
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
    expect(rebuilt.messages.find(message => attachmentKind(message) === 'agents')).toEqual(prepared.messages.find(message => attachmentKind(message) === 'agents'));
  });
});
