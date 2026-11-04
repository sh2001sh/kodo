import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleDefaultCard as defaultCard } from '../src/agents/card.js';
import { spawnAgentSpec } from '../src/messaging/spawn-spec.js';
import { followUpContext, initialContext, rebuildSummaryPrefix, sharedKernelRules } from '../src/runtime/context.js';
import { attachment, attachmentKind } from '../src/runtime/attachments.js';
import { mainGuidance } from '../src/runtime/main-guidance.js';
import { splitContextLayers } from '../src/runtime/context-inspection.js';
import { initialInstructions, instructionMessage, prepareInstructionContext, refreshInstructions } from '../src/runtime/instruction-layer.js';
import { estimateTextTokens } from '../src/runtime/context-tokens.js';
import { withEnvironment } from '../src/runtime/state-frame.js';
import { answer, fixture, temp } from './helpers.js';
import type { Provider } from '../src/runtime/types.js';
import type { Message } from '../src/runtime/types.js';

const instructionMessageTokens = (message?: Message): number => message ? estimateTextTokens(JSON.stringify(message)) : 0;

describe('agent context', () => {
  it('assembles every default main policy paragraph without rewriting the card method', () => {
    const main = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' });
    expect(main[0]!.content!.startsWith(`${sharedKernelRules} ${mainGuidance} Workspace: workspace.`)).toBe(true);
    expect(main[0]!.content).toContain('Delegate whole independent outcomes to children that inherit your card and permissions; they may only narrow them.');
    expect(main[0]!.content).toContain('Use a fresh child for independent black-box review.');
    // The factor-B text rewrite and the removed collaboration tools are gone from the main prompt.
    for (const removed of ['You are the team lead', 'named input slots', 'followup_task', 'send_message', 'Use explore', 'todoId', 'executor main or agent', 'do small tasks directly', 'three or more files', 'Use spawn_agent only to change']) expect(main[0]!.content).not.toContain(removed);
    expect(main[1]!.content).toBe(`Agent method configuration (subordinate to host rules and user task):
${defaultCard.prompt}`);
  });

  it('keeps team-lead responsibilities out of child prompts', () => {
    const context = initialContext('workspace', ['read'], defaultCard, 'Find the parser entry point.', { id: 'child', parentId: 'main' });
    const text = context.map(message => message.content).join('\n');
    expect(text).toContain('You cannot spawn children, cancel runs or ask the user');
    expect(text).not.toContain('Start each request with a brief plan');
    expect(text).not.toContain('You are the team lead');
    expect(text).not.toContain('Delegate substantive investigation');
    expect(text).not.toContain(mainGuidance);
    expect(text).not.toContain('followup_task');
  });

  it('delivers consistent role and dispatch guidance across main follow-ups', async () => {
    const requests: Parameters<Provider['complete']>[0][] = [];
    const { app, runId } = fixture({ async complete(request) {
      requests.push(structuredClone(request));
      return answer('Acknowledged the current task.');
    } });
    await app.run(runId);
    const next = app.submitInput(runId, 'Explain the next project phase.');
    await app.run(next.id);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.messages[0]!.content).toContain(mainGuidance);
      expect(request.messages[0]!.content).not.toContain('You are the team lead.');
      const spawn = request.tools.find(tool => tool.name === 'spawn_agent')!;
      expect(spawn.description.startsWith(spawnAgentSpec.description)).toBe(true);
      for (const removed of ['Choose delegation', 'explore', 'followup_task', 'continue your independent work']) expect(spawn.description).not.toContain(removed);
      // The roster selectors are gone.
      expect(Object.hasOwn(spawn.parameters.properties as object, 'agent')).toBe(false);
      expect(Object.hasOwn(spawn.parameters.properties as object, 'slots')).toBe(false);
      expect(request.tools.some(tool => tool.name === 'file.patch')).toBe(true);
    }
  });

  it('orders L3 project instructions ahead of the environment without a roster layer', () => {
    const messages = withEnvironment(initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'main' }, attachment('project-instructions', 'rules')), attachment('environment', 'env'));
    expect(messages.map(attachmentKind)).toEqual([undefined, undefined, 'project-instructions', 'environment', undefined]);
    const layers = splitContextLayers(messages);
    expect(layers.L2).toHaveLength(1);
    expect(layers.L2[0]!.content).toContain('Agent method configuration');
    expect(layers.L5).toEqual([{ role: 'user', content: 'objective' }]);
    const child = initialContext('workspace', ['read'], defaultCard, 'objective', { id: 'child', parentId: 'main' });
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
