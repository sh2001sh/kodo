import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { digest } from '../src/storage/index.js';
import { attachmentBody, attachmentKind } from '../src/runtime/attachments.js';
import { createInputTokenEstimator } from '../src/runtime/context-tokens.js';
import { readHistory } from '../src/runtime/history.js';
import { Application } from '../src/application/index.js';
import { buildContext, validateAssemblyPolicy } from '../src/runtime/context.js';
import type { ContextBuild } from '../src/runtime/context.js';
import type { Message, Provider } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, fullToolCard, scripted, temp } from './helpers.js';

// Keep one evidence round below the 1.6k-token test budget, while two rounds
// still exceed it so selection order and hiding remain observable.
const body = (label: string): string => `${label} evidence `.repeat(100);

function round(id: string, path: string): Message[] {
  return [
    { role: 'assistant', content: `Inspect ${path}`, tool_calls: [{ id, name: 'file.read', arguments: JSON.stringify({ path }) }] },
    { role: 'tool', tool_call_id: id, content: JSON.stringify({ path, hash: id.padEnd(64, 'a').slice(0, 64), content: body(path) }) },
  ];
}

function append(app: Application, runId: string, messages: Message[]): void {
  const run = app.store.run(runId);
  app.store.updateRun(runId, { contextRef: app.store.blob([...app.store.readBlob<Message[]>(run.contextRef), ...messages]) });
}

function assemble(app: Application, runId: string, evidenceInputTokens = 1_600): ContextBuild {
  return buildContext(app.store, app.store.run(runId), null, [], {
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
    assembly: { strategy: 'deterministic', workInputTokens: 65_536, evidenceInputTokens },
  });
}

describe('deterministic context assembly', () => {
  it('reaches a fixed projection for ten installed assemblies without new information', () => {
    const f = fixture();
    append(f.app, f.runId, [
      ...round('alpha', 'src/alpha-empty-list.ts'), ...round('beta', 'src/beta-pagination.ts'),
      ...round('gamma', 'src/gamma-report.ts'), ...round('recent-one', 'src/recent-one.ts'),
      ...round('recent-two', 'src/recent-two.ts'), { role: 'user', content: 'Focus on src/alpha-empty-list.ts.' },
    ]);
    const first = assemble(f.app, f.runId);
    expect(first.assembly?.selectedGroups).toBe(1);
    const identities = (messages: Message[]) => messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, digest(message.content)]);
    f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(first.messages) });
    f.app.store.event(f.runId, 'context.assembled', { ...first.assembly! });
    for (let index = 0; index < 10; index++) {
      const next = assemble(f.app, f.runId);
      expect(next.assembly).toBeUndefined();
      expect(identities(next.messages)).toEqual(identities(first.messages));
      expect(next.estimatedInputTokens).toBe(first.estimatedInputTokens);
      expect(next.messages).toEqual(first.messages);
      f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(next.messages) });
    }
  });

  it.each(['head', 'middle', 'tail'].flatMap(position => ['src/platform-restrictions.ts', '平台限制'].map(term => ({ position, term }))))('selects $term at the $position of a goal exceeding the term limit', ({ position, term }) => {
    const f = fixture();
    const noise = Array.from({ length: 800 }, (_, index) => `noise_${index}`);
    const at = position === 'head' ? 0 : position === 'middle' ? 400 : noise.length;
    noise.splice(at, 0, term);
    const objective = noise.join(' ');
    f.app.store.updateRun(f.runId, { objective });
    const important = round('important', term === '平台限制' ? 'docs/limits.md' : term);
    important[1] = { role: 'tool', tool_call_id: 'important', content: body(term) };
    append(f.app, f.runId, [
      ...important, ...round('beta', 'src/beta-pagination.ts'), ...round('gamma', 'src/gamma-report.ts'),
      ...round('recent-one', 'src/recent-one.ts'), ...round('recent-two', 'src/recent-two.ts'),
      { role: 'user', content: objective },
    ]);
    const built = assemble(f.app, f.runId);
    expect(built.assembly?.selectedGroups).toBe(1);
    expect(built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'important')?.content).toBe(body(term));
  });

  it.each(['original', 'pointer'].flatMap(state => [-1, 0, 1].map(delta => ({ state, delta }))))('enforces the exact evidence boundary in $state state with delta=$delta', ({ state, delta }) => {
    const f = fixture();
    const target = round('beta', 'src/beta-pagination.ts');
    append(f.app, f.runId, [
      ...round('alpha', 'src/alpha-empty-list.ts'), ...target, ...round('gamma', 'src/gamma-report.ts'),
      ...round('recent-one', 'src/recent-one.ts'), ...round('recent-two', 'src/recent-two.ts'),
      { role: 'user', content: 'Focus on src/alpha-empty-list.ts.' },
    ]);
    if (state === 'pointer') {
      const hidden = assemble(f.app, f.runId);
      f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(hidden.messages) });
      f.app.store.event(f.runId, 'context.assembled', { ...hidden.assembly! });
    }
    f.app.store.updateRun(f.runId, { objective: 'src/beta-pagination.ts' });
    append(f.app, f.runId, [{ role: 'user', content: 'Only src/beta-pagination.ts.' }]);
    const estimator = createInputTokenEstimator(f.app.store, f.app.store.run(f.runId), []);
    const cost = estimator.estimate(target) - estimator.estimate([]);
    const built = assemble(f.app, f.runId, cost + delta);
    const content = built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content;
    if (delta >= 0) {
      expect(content).toContain('beta-pagination.ts evidence');
      expect(built.assembly?.usedEvidenceTokens).toBe(cost);
      expect(built.assembly?.restoredOffsets.length).toBe(state === 'pointer' ? 1 : 0);
    } else {
      expect(built.assembly?.restoredOffsets ?? []).toEqual([]);
      if (state === 'pointer') expect(content).toContain('"contextHidden":true');
      // Other smaller candidates may fit; the target must never enter via a cheap pointer.
      if (built.assembly) {
        expect(built.assembly.usedEvidenceTokens).toBeLessThanOrEqual(cost + delta);
        expect(content).toContain('"contextHidden":true');
      }
    }
  });

  it.each(['foreign', 'read-revoked', 'scope-revoked'])('does not restore a %s archive', kind => {
    const f = fixture();
    append(f.app, f.runId, [
      ...round('alpha', 'src/alpha-empty-list.ts'), ...round('beta', 'src/beta-pagination.ts'),
      ...round('gamma', 'src/gamma-report.ts'), ...round('recent-one', 'src/recent-one.ts'),
      ...round('recent-two', 'src/recent-two.ts'), { role: 'user', content: 'Focus on src/alpha-empty-list.ts.' },
    ]);
    const first = assemble(f.app, f.runId);
    const betaOffset = first.messages.findIndex(message => message.role === 'tool' && message.tool_call_id === 'beta');
    let ref = first.assembly!.archivedRef;
    if (kind === 'foreign') {
      const foreign = f.app.createRun({ objective: 'Private evidence', workspace: f.root, binding, permissions: ['read'] });
      ref = f.app.store.blob({ version: 1, runId: foreign.id, sessionId: foreign.sessionId, messages: round('beta', 'src/beta-pagination.ts') });
      f.app.store.event(foreign.id, 'context.assembled', { archivedRef: ref });
    }
    const projected = first.messages.map(message => {
      if (kind !== 'foreign' || message.role !== 'tool' || message.tool_call_id !== 'beta') return message;
      const value = JSON.parse(message.content) as { read: { args: { ref: string; offset: number } } };
      value.read.args = { ref, offset: 1 };
      return { ...message, content: JSON.stringify(value) };
    });
    f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(projected), ...(kind === 'read-revoked' ? { permissions: ['write'] } : {}), ...(kind === 'scope-revoked' ? { scope: { read: [] } } : {}) });
    f.app.store.event(f.runId, 'context.assembled', { ...first.assembly! });
    append(f.app, f.runId, [{ role: 'user', content: 'Now focus on src/beta-pagination.ts.' }]);
    expect(() => readHistory(f.app.store, f.runId, { ref })).toThrow();
    const built = assemble(f.app, f.runId, 5_000);
    expect(built.assembly?.restoredOffsets ?? []).not.toContain(betaOffset);
    expect(built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('"contextHidden":true');
  });

  it('restores immutable historical evidence without pretending it is current file content', () => {
    const f = fixture();
    writeFileSync(path.join(f.root, 'version.txt'), 'old source');
    const recorded: Message[] = [
      { role: 'assistant', content: 'Read version.txt', tool_calls: [call('file.read', { path: 'version.txt' }, 'version')] },
      { role: 'tool', tool_call_id: 'version', content: JSON.stringify({ path: 'version.txt', hash: digest('old source'), content: body('old source') }) },
    ];
    append(f.app, f.runId, [...recorded, ...round('alpha', 'src/alpha-empty-list.ts'), ...round('gamma', 'src/gamma-report.ts'), ...round('recent-one', 'src/recent-one.ts'), ...round('recent-two', 'src/recent-two.ts'), { role: 'user', content: 'Focus on src/alpha-empty-list.ts.' }]);
    const first = assemble(f.app, f.runId);
    const pointer = JSON.parse(first.messages.find(message => message.role === 'tool' && message.tool_call_id === 'version')!.content!) as { coverage: string; read: { args: { ref: string; offset: number } } };
    f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(first.messages) });
    f.app.store.event(f.runId, 'context.assembled', { ...first.assembly! });
    writeFileSync(path.join(f.root, 'version.txt'), 'new source');
    const historical = readHistory(f.app.store, f.runId, { ...pointer.read.args, limit: 1 });
    expect(historical.source.freshness).toBe('unknown');
    expect(pointer.coverage).toBe('recorded-message');
    append(f.app, f.runId, [{ role: 'user', content: 'Now inspect version.txt.' }]);
    const restored = assemble(f.app, f.runId, 5_000);
    expect(restored.messages.find(message => message.role === 'tool' && message.tool_call_id === 'version')).toEqual(recorded[1]);
    expect(readFileSync(path.join(f.root, 'version.txt'), 'utf8')).toBe('new source');
  });

  it.each([false, true])('saves, confirms and replies within two explicit calls (assembly=%s)', async enabled => {
    const root = temp();
    const content = '# Required report\nEvidence saved; optional checks were not run.\n';
    const app = new Application(path.join(root, '.state'), scripted(
      async () => {
        return calls(call('file.apply_patch', { path: 'REPORT.md', expectedHash: null, content }, 'save'), call('file.read', { path: 'REPORT.md' }, 'confirm'));
      },
      async request => {
        const confirmation = request.messages.find(message => message.role === 'tool' && message.tool_call_id === 'confirm');
        expect(confirmation?.content).toContain('Evidence saved');
        return answer('Saved REPORT.md and confirmed its contents. Optional checks were not run.');
      },
    ), undefined, { ...(enabled ? { assembly: { strategy: 'deterministic' as const } } : {}) });
    try {
      const run = app.createRun({ objective: 'Save REPORT.md, confirm it and reply.', workspace: root, binding, permissions: ['read', 'write'], budget: { maxTokens: 100_000, maxModelCalls: 2 } });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(readFileSync(path.join(root, 'REPORT.md'), 'utf8')).toBe(content);
      expect(app.store.readBlob<{ text: string }>(final.resultRef!).text).toContain('Saved REPORT.md');
      expect(app.store.calls(run.id).filter(item => item.kind === 'model')).toHaveLength(2);
      expect(app.store.calls(run.id).filter(item => item.kind === 'tool').map(item => item.status)).toEqual(['succeeded', 'succeeded']);
    } finally { await app.shutdown(); }
  });

  it.each([false, true])('reuses a failed write body, corrects its path and completes the delivery chain (assembly=%s)', async enabled => {
    const root = temp();
    const content = '# Recovered report\nThe original model response already contained this body.\n';
    const absolute = path.join(path.dirname(root), 'outside-report.md');
    const requests: { messages: Message[]; tools: { name: string }[]; toolChoice?: 'none' }[] = [];
    const app = new Application(path.join(root, '.state'), scripted(
      async request => {
        requests.push(request);
        return calls(call('file.apply_patch', { path: absolute, expectedHash: null, content }, 'bad-path'));
      },
      async request => {
        requests.push(request);
        return calls(call('file.apply_patch', { path: 'REPORT.md', expectedHash: null, content }, 'save'));
      },
      async request => {
        requests.push(request);
        return calls(call('file.read', { path: 'REPORT.md' }, 'confirm'));
      },
      async request => {
        requests.push(request);
        return answer('Saved REPORT.md after correcting the path and confirmed its contents.');
      },
    ), undefined, { ...(enabled ? { assembly: { strategy: 'deterministic' as const } } : {}) });
    try {
      const run = app.createRun({ objective: 'Save REPORT.md, confirm it and reply.', workspace: root, binding, permissions: ['read', 'write'], budget: { maxTokens: 50_000, maxModelCalls: 10 } });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(readFileSync(path.join(root, 'REPORT.md'), 'utf8')).toBe(content);
      expect(requests[1]!.messages.find(message => message.role === 'tool' && message.tool_call_id === 'bad-path')?.content).toContain('path is outside the workspace');
      expect(requests[1]!.messages.some(message => message.role === 'user' && message.content.includes('Reuse the existing tool arguments and body'))).toBe(true);
      expect(requests[1]!.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(toolCall => (JSON.parse(toolCall.arguments) as { content?: string }).content === content))).toBe(true);
      expect(requests[2]!.messages.find(message => message.role === 'tool' && message.tool_call_id === 'save')?.content).toContain('REPORT.md');
      expect(requests[3]!.messages.find(message => message.role === 'tool' && message.tool_call_id === 'confirm')?.content).toContain('Recovered report');
      expect(app.store.calls(run.id).filter(item => item.kind === 'tool').map(item => item.status)).toEqual(['failed', 'succeeded', 'succeeded']);
    } finally { await app.shutdown(); }
  });

  it('keeps every granted tool available on the last call an explicit cap allows', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(
      async request => {
        expect(request.tools.map(tool => tool.name)).toContain('process.exec');
        expect(request.toolChoice).toBeUndefined();
        return answer('Delivered without hidden tool restrictions.');
      },
    ));
    try {
      const run = app.createRun({ objective: 'Finish the current deliverable.', workspace: root, binding, permissions: ['read', 'write', 'exec'], budget: { maxTokens: 200_000, maxModelCalls: 1 }, card: fullToolCard });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(app.store.events(run.id).some(event => event.type.startsWith('delivery.finalization'))).toBe(false);
    } finally { await app.shutdown(); }
  });

  it.each([false, true])('preserves a saved artifact and reports failure when no final call remains (assembly=%s)', async enabled => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(calls(call('file.apply_patch', { path: 'REPORT.md', expectedHash: null, content: 'Partial deliverable' }))), undefined, { ...(enabled ? { assembly: { strategy: 'deterministic' as const } } : {}) });
    try {
      const run = app.createRun({ objective: 'Save a report and reply.', workspace: root, binding, permissions: ['read', 'write'], budget: { maxTokens: 100_000, maxModelCalls: 1 } });
      const final = await app.run(run.id);
      expect(final.status).toBe('failed');
      expect(final.error).toContain('MODEL_BUDGET');
      expect(final.resultRef).toBeUndefined();
      expect(readFileSync(path.join(root, 'REPORT.md'), 'utf8')).toBe('Partial deliverable');
    } finally { await app.shutdown(); }
  });

  it.each([false, true])('does not replay a timed-out unsandboxed write and reports its scanned effect (assembly=%s)', async enabled => {
    const root = temp();
    const requests: Parameters<Provider['complete']>[0][] = [];
    const script = scripted(calls(call('process.exec', {
      program: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync('REPORT.md', 'partial before timeout'); setInterval(() => {}, 1000)"],
    })), answer('the process is still running in the background'), answer('REPORT.md holds partial output from the stopped process; the write was not repeated.'));
    const app = new Application(path.join(root, '.state'), { complete: (request, signal, onText) => { requests.push(request); return script.complete(request, signal, onText); } }, undefined, { ...(enabled ? { assembly: { strategy: 'deterministic' as const } } : {}) });
    try {
      const run = app.createRun({ objective: 'Save a report and reply.', workspace: root, binding, permissions: ['read', 'write', 'exec'], budget: { maxTokens: 1_000_000, maxModelCalls: 10, toolTimeoutMs: 600 }, card: fullToolCard });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(readFileSync(path.join(root, 'REPORT.md'), 'utf8')).toBe('partial before timeout');
      const write = app.store.calls(run.id).find(item => item.name === 'process.exec')!;
      // Without a sandbox the stopped process is settled from a post-stop scan; the partial write is reported, not hidden.
      expect(write).toMatchObject({ status: 'cancelled', effectState: 'started', effectOutcome: 'applied' });
      expect(app.store.readBlob(write.resultRef!)).toMatchObject({ effects: { verified: true, outcome: 'applied', basis: 'workspace-change-time', unobserved: 'outside-roots', changed: expect.arrayContaining(['REPORT.md']) } });
      expect(app.store.events(run.id).filter(item => item.type === 'tool.started')).toHaveLength(1);
      expect(app.store.unresolvedWrites(root)).toEqual([]);
      expect(JSON.stringify(requests[1]!.messages.filter(message => message.role === 'tool'))).toContain('process.read');
      // The notice after the stop names the changed file so the model can inspect it instead of repeating the write.
      const notice = JSON.stringify(requests[2]!.messages.filter(message => attachmentKind(message) === 'task-notification'));
      expect(notice).toContain('Reconciled effects');
      expect(notice).toContain('REPORT.md');
    } finally { await app.shutdown(); }
  });

  it('keeps a bounded preview of an important long source while preserving short sources and legal recovery', () => {
    const f = fixture();
    const topics = ['kernel', 'distribution', 'dependencies', 'mcp', 'sandbox', 'recovery'];
    const rounds = topics.flatMap((topic, index) => {
      const group = round(topic, `src/${topic}.ts`);
      if (index === 0) group[1] = { role: 'tool', tool_call_id: topic, content: body(`critical ${topic}`).repeat(20) };
      return group;
    });
    append(f.app, f.runId, [...rounds, ...round('recent-one', 'src/recent-one.ts'), ...round('recent-two', 'src/recent-two.ts'), { role: 'user', content: `critical kernel ${topics.map(topic => `src/${topic}.ts`).join(' ')}` }]);
    const built = assemble(f.app, f.runId, 6_553);
    expect(built.assembly!.usedEvidenceTokens).toBeLessThanOrEqual(6_553);
    const kernel = built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'kernel')?.content ?? '';
    expect(kernel).toContain('"contextPreview":true');
    expect(kernel).toContain('critical kernel evidence');
    expect(topics.slice(1).filter(topic => built.messages.some(message => message.role === 'tool' && message.tool_call_id === topic && !message.content.includes('"contextHidden":true'))).length).toBeGreaterThanOrEqual(4);
    f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(built.messages) });
    f.app.store.event(f.runId, 'context.assembled', { ...built.assembly! });
    const pointer = JSON.parse(built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'kernel')!.content!) as { read: { args: { ref: string; offset: number } } };
    const recovered = readHistory(f.app.store, f.runId, { ...pointer.read.args, limit: 1, maxChars: 256 });
    expect(recovered.fragments[0]!.text).toContain('kernel evidence');
    expect(recovered.fragments[0]!.text.length).toBeLessThanOrEqual(256);
    expect(recovered.next?.contentOffset).toBe(256);
  });

  it('validates the experimental policy without accepting unknown fields', () => {
    expect(() => validateAssemblyPolicy({ strategy: 'deterministic', workInputTokens: 65_536, evidenceInputTokens: 6_553 })).not.toThrow();
    expect(() => validateAssemblyPolicy({ strategy: 'deterministic', evidenceInputTokens: 1 } )).toThrow('evidenceInputTokens');
    expect(() => validateAssemblyPolicy({ strategy: 'model' } as never)).toThrow('deterministic');
  });

  it('keeps relevant evidence and recent rounds while replacing unrelated old bodies with exact read pointers', () => {
    const f = fixture();
    append(f.app, f.runId, [
      ...round('alpha', 'src/alpha-empty-list.ts'),
      ...round('beta', 'src/beta-pagination.ts'),
      ...round('gamma', 'src/gamma-report.ts'),
      ...round('recent-one', 'src/recent-one.ts'),
      ...round('recent-two', 'src/recent-two.ts'),
      { role: 'user', content: 'Focus on src/alpha-empty-list.ts and the empty list failure.' },
    ]);
    const beforeCalls = f.app.store.session(f.app.store.run(f.runId).sessionId).modelCalls;
    const built = assemble(f.app, f.runId);
    expect(built.assembly).toBeDefined();
    expect(built.assembly!.selectedGroups).toBeGreaterThan(0);
    expect(built.assembly!.usedEvidenceTokens).toBeLessThanOrEqual(built.assembly!.evidenceInputTokens);
    expect(built.assembly!.selectedSourceIds).toHaveLength(1);
    expect(built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'alpha')?.content).toContain('alpha-empty-list');
    expect(built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('"contextHidden":true');
    expect(built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'recent-one')?.content).toContain('src/recent-one.ts evidence');
    expect(f.app.store.session(f.app.store.run(f.runId).sessionId).modelCalls).toBe(beforeCalls);
  });

  it('restores newly relevant evidence from an indexed assembly archive after the task focus changes', () => {
    const f = fixture();
    f.app.store.updateRun(f.runId, { objective: 'Only investigate src/alpha-empty-list.ts.' });
    append(f.app, f.runId, [
      ...round('alpha', 'src/alpha-empty-list.ts'),
      ...round('beta', 'src/beta-pagination.ts'),
      ...round('gamma', 'src/gamma-report.ts'),
      ...round('recent-one', 'src/recent-one.ts'),
      ...round('recent-two', 'src/recent-two.ts'),
      { role: 'user', content: 'Only investigate src/alpha-empty-list.ts.' },
    ]);
    const first = assemble(f.app, f.runId);
    expect(first.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('"contextHidden":true');
    f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(first.messages) });
    f.app.store.event(f.runId, 'context.assembled', { ...first.assembly! });
    append(f.app, f.runId, [{ role: 'user', content: 'The goal changed: inspect src/beta-pagination.ts now.' }]);
    const second = assemble(f.app, f.runId);
    expect(second.assembly?.restoredOffsets.length).toBeGreaterThan(0);
    expect(second.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('beta-pagination.ts evidence');
  });

  it('uses stable source contents for scoring and charges restored originals to the evidence budget', () => {
    const f = fixture();
    append(f.app, f.runId, [
      ...round('alpha', 'src/alpha-empty-list.ts'),
      ...round('beta', 'src/beta-pagination.ts'),
      ...round('gamma', 'src/gamma-report.ts'),
      ...round('recent-one', 'src/recent-one.ts'),
      ...round('recent-two', 'src/recent-two.ts'),
      { role: 'user', content: 'Focus on src/alpha-empty-list.ts.' },
    ]);
    const first = assemble(f.app, f.runId);
    f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(first.messages) });
    f.app.store.event(f.runId, 'context.assembled', { ...first.assembly! });

    append(f.app, f.runId, [{ role: 'user', content: 'The goal changed to src/beta-pagination.ts.' }]);
    const tooSmall = assemble(f.app, f.runId, 256);
    expect(tooSmall.assembly).toBeUndefined();
    expect(tooSmall.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('"contextHidden":true');

    const restored = assemble(f.app, f.runId, 5_000);
    expect(restored.assembly?.usedEvidenceTokens).toBeLessThanOrEqual(5_000);
    expect(restored.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('beta-pagination.ts evidence');
    f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(restored.messages) });
    f.app.store.event(f.runId, 'context.assembled', { ...restored.assembly! });
    const repeated = assemble(f.app, f.runId, 5_000);
    expect(repeated.assembly).toBeUndefined();
    expect(repeated.messages).toEqual(restored.messages);
  });

  it('keeps an unavailable archive pointer without claiming that its source was restored', () => {
    const f = fixture();
    append(f.app, f.runId, [
      ...round('alpha', 'src/alpha-empty-list.ts'),
      ...round('beta', 'src/beta-pagination.ts'),
      ...round('gamma', 'src/gamma-report.ts'),
      ...round('recent-one', 'src/recent-one.ts'),
      ...round('recent-two', 'src/recent-two.ts'),
      { role: 'user', content: 'Focus on src/alpha-empty-list.ts.' },
    ]);
    const first = assemble(f.app, f.runId);
    let unavailableOffset = -1;
    const unavailable = first.messages.map(message => {
      if (message.role !== 'tool' || message.tool_call_id !== 'beta') return message;
      const pointer = JSON.parse(message.content) as { read: { args: { ref: string; offset: number } } };
      unavailableOffset = pointer.read.args.offset;
      pointer.read.args.ref = 'unavailable-archive-ref';
      return { ...message, content: JSON.stringify(pointer) };
    });
    f.app.store.updateRun(f.runId, { contextRef: f.app.store.blob(unavailable) });
    f.app.store.event(f.runId, 'context.assembled', { ...first.assembly! });
    append(f.app, f.runId, [{ role: 'user', content: 'Now inspect src/beta-pagination.ts.' }]);
    const second = assemble(f.app, f.runId, 5_000);
    // The only newly relevant source is unavailable, so the projection may stay as installed.
    expect(second.assembly?.restoredOffsets ?? []).not.toContain(unavailableOffset);
    expect(second.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('unavailable-archive-ref');
    expect(second.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('"contextHidden":true');
  });

  it('skips an oversized high-scoring candidate so smaller relevant evidence remains available', () => {
    const f = fixture();
    const oversized = round('alpha', 'src/alpha-empty-list.ts');
    const result = oversized.find(message => message.role === 'tool')!;
    if (result.role !== 'tool') throw new Error('missing oversized tool fixture');
    result.content = JSON.stringify({ path: 'src/alpha-empty-list.ts', content: 'alpha empty list evidence '.repeat(5_000) });
    append(f.app, f.runId, [
      ...oversized,
      ...round('beta', 'src/beta-pagination.ts'),
      ...round('gamma', 'src/gamma-report.ts'),
      ...round('recent-one', 'src/recent-one.ts'),
      ...round('recent-two', 'src/recent-two.ts'),
      { role: 'user', content: 'Compare src/alpha-empty-list.ts with src/beta-pagination.ts.' },
    ]);
    const built = assemble(f.app, f.runId, 5_000);
    expect(built.assembly?.usedEvidenceTokens).toBeLessThanOrEqual(5_000);
    expect(built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'alpha')?.content).toContain('"contextHidden":true');
    expect(built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('beta-pagination.ts evidence');
  });

  it('retains tail focus terms and does not assemble early without a post-tool user change', () => {
    const f = fixture();
    append(f.app, f.runId, [
      ...round('alpha', 'src/alpha-empty-list.ts'),
      ...round('beta', 'src/beta-pagination.ts'),
      ...round('gamma', 'src/gamma-report.ts'),
      ...round('recent-one', 'src/recent-one.ts'),
      ...round('recent-two', 'src/recent-two.ts'),
    ]);
    const unchanged = assemble(f.app, f.runId);
    expect(unchanged.assembly).toBeUndefined();
    append(f.app, f.runId, [{ role: 'user', content: `${Array.from({ length: 300 }, (_, index) => `prefix_term_${index}`).join(' ')} finally inspect src/beta-pagination.ts` }]);
    const selected = assemble(f.app, f.runId);
    expect(selected.messages.find(message => message.role === 'tool' && message.tool_call_id === 'beta')?.content).toContain('beta-pagination.ts evidence');
    expect(selected.messages.find(message => message.role === 'tool' && message.tool_call_id === 'alpha')?.content).toContain('"contextHidden":true');
  });

  it('records assembly separately and makes no auxiliary model request in the coordinator path', async () => {
    const provider = scripted(answer('assembled delivery'));
    const root = temp();
    const app = new Application(path.join(root, '.state'), provider, undefined, { assembly: { strategy: 'deterministic', workInputTokens: 65_536, evidenceInputTokens: 1_600 } });
    try {
      const run = app.createRun({ objective: 'Inspect src/alpha-empty-list.ts.', workspace: root, binding, permissions: ['read'] });
      append(app, run.id, [
        ...round('alpha', 'src/alpha-empty-list.ts'),
        ...round('beta', 'src/beta-pagination.ts'),
        ...round('gamma', 'src/gamma-report.ts'),
        ...round('recent-one', 'src/recent-one.ts'),
        ...round('recent-two', 'src/recent-two.ts'),
        { role: 'user', content: 'Focus on src/alpha-empty-list.ts.' },
      ]);
      const final = await app.run(run.id);
      expect(final.status).toBe('completed');
      expect(app.store.events(run.id).map(event => event.type)).toContain('context.assembled');
      const modelCalls = app.store.calls(run.id).filter(call => call.kind === 'model');
      expect(modelCalls).toHaveLength(1);
      expect(modelCalls.some(call => call.purpose === 'compaction')).toBe(false);
      expect(app.coordinator.contextSnapshot(run.id).latestAssembly).toMatchObject({
        usedEvidenceTokens: expect.any(Number),
        selectedSourceIds: expect.arrayContaining([expect.stringMatching(/^history:/)]),
      });
    } finally { await app.shutdown(); }
  });

  it('exposes the real tool limit and remaining explicit tokens without a finalization phase', async () => {
    const states: Record<string, unknown>[] = [];
    const capture = async (request: { messages: Message[] }) => {
      // The state frame is the last message of every request.
      const marker = request.messages.at(-1);
      if (!marker || attachmentKind(marker) !== 'state') throw new Error('missing kernel state frame');
      states.push(JSON.parse(attachmentBody(marker)) as Record<string, unknown>);
      return answer('budget-aware delivery');
    };
    const root = temp();
    const near = new Application(path.join(root, 'near'), scripted(capture));
    try {
      const nearRun = near.createRun({ objective: 'Finish the required artifact.', workspace: root, binding, budget: { maxTokens: 500_000, maxModelCalls: 2, toolTimeoutMs: 3_210 } });
      await near.run(nearRun.id);
      expect(states[0]).toMatchObject({ toolTimeoutMs: 3_210, remainingTokens: 500_000 });
      for (const key of ['finalizationRequired', 'finalizationInstruction', 'deliveryPhase', 'deliveryReserve', 'remainingModelCalls']) expect(states[0]).not.toHaveProperty(key);
    } finally { await near.shutdown(); }
  });

  it('stays disabled by default and rejects conflicting explicit work budgets', async () => {
    const f = fixture();
    try {
      append(f.app, f.runId, [
        ...round('alpha', 'src/alpha-empty-list.ts'),
        ...round('beta', 'src/beta-pagination.ts'),
        ...round('gamma', 'src/gamma-report.ts'),
      ]);
      const run = f.app.store.run(f.runId);
      const original = f.app.store.readBlob<Message[]>(run.contextRef);
      const built = buildContext(f.app.store, run, null, [], { maxContextTokens: 131_072, maxOutputTokens: 8_192 });
      expect(built.assembly).toBeUndefined();
      expect(built.messages).toEqual(original);
      expect(() => new Application(path.join(f.root, '.conflict'), undefined, undefined, {
        assembly: { strategy: 'deterministic', workInputTokens: 65_536 },
        compaction: { strategy: 'hybrid', workInputTokens: 32_768 },
      })).toThrow('same explicit workInputTokens');
    } finally { await f.app.shutdown(); }
  });
});
