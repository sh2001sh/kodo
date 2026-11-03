import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { parseCard } from '../src/agents/card.js';
import type { Message, ToolSpec } from '../src/runtime/types.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

const names = (tools: ToolSpec[]): string[] => tools.map(tool => tool.name);

describe('progress guard', () => {
  it('returns a stop with unsaved deliverables to the model with every tool still offered', async () => {
    const root = temp();
    const offered: string[][] = [];
    const seen: Message[][] = [];
    const app = new Application(path.join(root, '.state'), scripted(
      async request => { offered.push(names(request.tools)); return answer('Done.'); },
      async request => { offered.push(names(request.tools)); seen.push(request.messages); return calls(call('file.apply_patch', { path: 'REPORT.md', expectedHash: null, content: 'report\n' }, 'save')); },
      async request => { offered.push(names(request.tools)); return answer('Saved REPORT.md.'); },
    ), undefined, { agentFactors: { D: false, E: false, B: false } });
    try {
      const run = app.createRun({ objective: 'Save REPORT.md and reply.', workspace: root, binding, permissions: ['read', 'write'], deliverables: ['REPORT.md'] });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(offered.every(tools => tools.includes('file.read') && tools.includes('file.apply_patch'))).toBe(true);
      expect(seen[0]!.some(message => message.role === 'user' && message.content?.includes('REPORT.md: missing'))).toBe(true);
      expect(app.store.events(run.id).filter(event => event.type === 'delivery.audit_requested')).toHaveLength(1);
      expect(final.deliveryIncomplete).toBeUndefined();
      expect(readFileSync(path.join(root, 'REPORT.md'), 'utf8')).toBe('report\n');
    } finally { await app.shutdown(); }
  });

  it('audits at most twice in a row, then completes and records the incomplete deliverables', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'DELIVERY.md'), 'tiny');
    const app = new Application(path.join(root, '.state'), scripted(answer('Done.'), answer('Still done.'), answer('Really done.')), undefined, { agentFactors: { D: false, E: false, B: false } });
    try {
      const run = app.createRun({ objective: 'Save DELIVERY.md and a test, then reply.', workspace: root, binding, permissions: ['read', 'write'], deliverables: [{ path: 'DELIVERY.md', minBytes: 200 }, { pattern: 'test/**/*.ts', exclude: ['**/tmp-*'] }] });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(app.store.events(run.id).filter(event => event.type === 'delivery.audit_requested')).toHaveLength(2);
      expect(final.deliveryIncomplete).toEqual(['DELIVERY.md: too small (4 bytes; needs at least 200)', 'test/**/*.ts: missing']);
      expect(app.store.readBlob<{ delivery: { incompleteDeliverables?: string[] } }>(final.resultRef!).delivery.incompleteDeliverables).toHaveLength(2);
      expect(app.store.events(run.id).some(event => event.type === 'delivery.incomplete')).toBe(true);
    } finally { await app.shutdown(); }
  });

  it('ignores excluded scratch files and rejects deliverables outside the workspace', async () => {
    const root = temp();
    mkdirSync(path.join(root, 'test'));
    const app = new Application(path.join(root, '.state'), scripted(
      calls(call('file.apply_patch', { path: 'test/tmp-probe.ts', expectedHash: null, content: 'scratch\n' }, 'scratch')),
      answer('Done.'),
      calls(call('file.apply_patch', { path: 'test/real.test.ts', expectedHash: null, content: 'real\n' }, 'real')),
      answer('Saved test/real.test.ts.'),
    ), undefined, { agentFactors: { D: false, E: false, B: false } });
    try {
      expect(() => app.createRun({ objective: 'x', workspace: root, binding, deliverables: ['../outside.md'] })).toThrow('without ..');
      expect(() => app.createRun({ objective: 'x', workspace: root, binding, deliverables: ['a.md', './a.md'] })).toThrow('distinct');
      const run = app.createRun({ objective: 'Write a test, then reply.', workspace: root, binding, permissions: ['read', 'write'], deliverables: [{ pattern: 'test/**/*.ts', exclude: ['**/tmp-*'] }] });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(app.store.events(run.id).filter(event => event.type === 'delivery.audit_requested')).toHaveLength(1);
      expect(final.deliveryIncomplete).toBeUndefined();
    } finally { await app.shutdown(); }
  });

  it.each([true, false, undefined])('only nudges a writable run after many reads when card.nudges is true (value=%s)', async nudges => {
    const root = temp();
    writeFileSync(path.join(root, 'a.txt'), Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n'));
    const seen: Message[][] = [];
    const reads = Array.from({ length: 31 }, (_, index) => calls(call('file.read', { path: 'a.txt', offset: index + 1, limit: 1 }, `r${index}`)));
    const app = new Application(path.join(root, '.state'), scripted(
      ...reads.map(response => async (request: { messages: Message[] }) => { seen.push(request.messages); return response; }),
      async request => { seen.push(request.messages); return answer('done'); },
    ), undefined, { taskProtocol: 1, agentFactors: { D: false, E: false, B: false } });
    try {
      const card = { ...app.defaultCard };
      delete card.nudges;
      const run = app.createRun({ objective: 'Inspect and reply.', workspace: root, binding, permissions: ['read', 'write'], card: { ...card, ...(nudges === undefined ? {} : { nudges }) }, budget: { maxTokens: 5_000_000, maxModelCalls: 60 } });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      const events = app.store.events(run.id).filter(event => event.type === 'progress.write_nudged');
      expect(events.map(event => event.data.readCalls)).toEqual(nudges === true ? [30] : []);
      const notice = (messages: Message[]) => messages.some(message => message.role === 'user' && message.content.includes('no edit or command yet'));
      expect(notice(seen[29]!)).toBe(false);
      expect(notice(seen[30]!)).toBe(nudges === true);
    } finally { await app.shutdown(); }
  });

  it('flags alternating re-reads of the same unchanged range that the consecutive stall check misses', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
    writeFileSync(path.join(root, 'b.txt'), 'beta\n');
    const order = ['a.txt', 'b.txt', 'a.txt', 'b.txt', 'a.txt'];
    let afterThird: Message[] = [];
    const app = new Application(path.join(root, '.state'), scripted(
      ...order.map((file, index) => calls(call('file.read', { path: file }, `r${index}`))),
      async request => { afterThird = request.messages; return answer('done'); },
    ), undefined, { agentFactors: { D: false, E: false, B: false } });
    try {
      const run = app.createRun({ objective: 'Inspect files and reply.', workspace: root, binding, permissions: ['read'], budget: { maxTokens: 2_000_000, maxModelCalls: 40 } });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      const warnings = app.store.events(run.id).filter(event => event.type === 'tool.reread_warning');
      expect(warnings.map(event => event.data.paths)).toEqual([['a.txt']]);
      expect(afterThird.some(message => message.role === 'user' && message.content.includes('a.txt was read 3 or more times'))).toBe(true);
      expect(app.store.events(run.id).some(event => event.type === 'tool.stalled')).toBe(false);
    } finally { await app.shutdown(); }
  });

  it('nudges actual compound shell reading in protocol 3 and accepts an analysis-only completion', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'a.txt'), Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n'));
    let messages: Message[] = [];
    const app = new Application(path.join(root, '.state'), scripted(
      ...Array.from({ length: 8 }, (_, index) => calls(call('shell.exec', { command: `cd . && sed -n '${index + 1}p' a.txt` }, `read-${index}`))),
      async request => { messages = request.messages; return answer('The requested lines have been inspected.'); },
    ), undefined, { taskProtocol: 3, toolProfile: 'full', agentFactors: { D: false, E: false, B: false } });
    try {
      const run = app.createRun({ objective: 'Read the lines and report your analysis without changing files.', workspace: root, binding, permissions: ['read', 'write', 'exec'], card: { ...app.defaultCard, nudges: true } });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(app.store.calls(run.id).filter(value => value.name === 'shell.exec').map(value => value.status)).toEqual(Array(8).fill('succeeded'));
      expect(app.store.events(run.id).filter(event => event.type === 'progress.write_nudged').map(event => event.data.readCalls)).toEqual([8]);
      expect(messages.some(message => message.role === 'user' && message.content.includes('deliver the analysis'))).toBe(true);
      expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe(Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n'));
    } finally { await app.shutdown(); }
  });

  it('flags repeated inline node read scripts that bypass file.read', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'a.txt'), 'alpha\n');
    writeFileSync(path.join(root, 'b.txt'), 'beta\n');
    const script = (file: string) => ['-e', `const fs=require('fs');console.log(fs.readFileSync('${file}','utf8'))`];
    const order = ['a.txt', 'b.txt', 'a.txt', 'b.txt', 'a.txt'];
    let afterThird: Message[] = [];
    const app = new Application(path.join(root, '.state'), scripted(
      ...order.map((file, index) => calls(call('process.exec', { program: process.execPath, args: script(file) }, `x${index}`))),
      async request => { afterThird = request.messages; return answer('done'); },
    ), undefined, { toolProfile: 'full', agentFactors: { D: false, E: false, B: false } });
    try {
      const run = app.createRun({ objective: 'Inspect files and reply.', workspace: root, binding, permissions: ['read', 'exec'], budget: { maxTokens: 2_000_000, maxModelCalls: 40 } });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(app.store.calls(run.id).filter(value => value.name === 'process.exec').map(value => value.status)).toEqual(order.map(() => 'succeeded'));
      const warnings = app.store.events(run.id).filter(event => event.type === 'tool.reread_warning');
      expect(warnings.map(event => event.data.paths)).toEqual([['a.txt (via process.exec)']]);
      expect(afterThird.some(message => message.role === 'user' && message.content.includes('a.txt (via process.exec) was read 3 or more times'))).toBe(true);
    } finally { await app.shutdown(); }
  });

  it('counts inline read scripts as investigation, while writing scripts still count as action', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'a.txt'), Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n'));
    const reads = Array.from({ length: 29 }, (_, index) => calls(call('file.read', { path: 'a.txt', offset: index + 1, limit: 1 }, `r${index}`)));
    const scriptRead = calls(call('process.exec', { program: process.execPath, args: ['-e', "console.log(require('fs').readFileSync('a.txt','utf8').length)"] }, 'x'));
    const scriptWrite = calls(call('process.exec', { program: process.execPath, args: ['-e', "require('fs').writeFileSync('out.txt','x')"] }, 'w'));
    const make = (last: ReturnType<typeof calls>) => new Application(path.join(temp(), '.state'), scripted(...reads, last, answer('done')), undefined, { taskProtocol: 1, toolProfile: 'full', agentFactors: { D: false, E: false, B: false } });
    for (const [response, expected] of [[scriptRead, [30]], [scriptWrite, []]] as const) {
      const app = make(response);
      try {
        const run = app.createRun({ objective: 'Inspect and reply.', workspace: root, binding, permissions: ['read', 'write', 'exec'], card: { ...app.defaultCard, nudges: true }, budget: { maxTokens: 5_000_000, maxModelCalls: 60 } });
        const final = await app.run(run.id);
        expect(final.status, final.error).toBe('completed');
        expect(app.store.calls(run.id).filter(value => value.name === 'process.exec').map(value => value.status)).toEqual(['succeeded']);
        expect(app.store.events(run.id).filter(event => event.type === 'progress.write_nudged').map(event => event.data.readCalls)).toEqual(expected);
      } finally { await app.shutdown(); }
    }
  });

  it('parses and serializes the explicit boolean card option while omitted means off', () => {
    const source = (option = '') => `---\nschema_version: 1\nid: test/nudges\nversion: 1.0.0\nname: Nudge policy\ndescription: Checks explicit advisory policy.\n${option}capabilities:\n  tools: [file.read]\n---\nInspect the requested file.`;
    expect(parseCard(source()).nudges).toBeUndefined();
    for (const value of [true, false]) expect(JSON.parse(JSON.stringify(parseCard(source(`nudges: ${value}\n`))))).toMatchObject({ nudges: value });
    expect(() => parseCard(source('nudges: sometimes\n'))).toThrow('unsupported or invalid card fields');
  });
});
