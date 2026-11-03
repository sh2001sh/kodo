import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { attachmentKind } from '../src/runtime/attachments.js';
import { discoverInstructions } from '../src/runtime/project-instructions.js';
import type { Message, Provider, Run } from '../src/runtime/types.js';
import { answer, binding, call, calls, temp } from './helpers.js';

type Request = Parameters<Provider['complete']>[0];
const write = (root: string, file: string, text: string): void => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text, 'utf8');
};
const discover = (root: string, directories: string[] = [], maxBytes = 16 * 1024) => discoverInstructions({ workspace: root, directories, includeRoot: true, global: false, loaded: new Set(), maxBytes });
const kinds = (messages: Message[]) => messages.map(message => attachmentKind(message) ?? message.role);
function app(root: string, provider: Provider, global: string | false = false): Application {
  const created = new Application(path.join(root, '.state'), provider, undefined, { instructions: { global }, agentFactors: { D: false, E: false, B: false } });
  return created;
}

describe('project instruction discovery', () => {
  it('reads AGENTS.md before CLAUDE.md, overlays AGENTS.local.md and orders nearer directories last', () => {
    const root = temp();
    write(root, 'AGENTS.md', 'ROOT-AGENTS');
    write(root, 'CLAUDE.md', 'ROOT-CLAUDE');
    write(root, 'AGENTS.local.md', 'ROOT-LOCAL');
    write(root, 'pkg/CLAUDE.md', 'PKG-CLAUDE');
    write(root, 'pkg/lib/AGENTS.md', 'LIB-AGENTS');
    const chain = discover(root, ['pkg/lib']);
    expect(chain.files.map(file => file.path)).toEqual(['AGENTS.md', 'AGENTS.local.md', 'pkg/CLAUDE.md', 'pkg/lib/AGENTS.md']);
    expect(chain.text).not.toContain('ROOT-CLAUDE');
    const order = ['ROOT-AGENTS', 'ROOT-LOCAL', 'PKG-CLAUDE', 'LIB-AGENTS'].map(text => chain.text.indexOf(text));
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(0);
    expect(chain.files[0]).toMatchObject({ bytes: 11, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('refuses files and includes that resolve outside the workspace and bounds include depth and cycles', () => {
    const base = temp();
    const root = path.join(base, 'workspace');
    const outside = path.join(base, 'outside');
    write(outside, 'AGENTS.md', 'OUTSIDE-SECRET');
    write(root, 'AGENTS.md', ['ROOT', '@../outside/AGENTS.md', '@docs/one.md', '@docs/cycle.md'].join('\n'));
    write(root, 'docs/one.md', 'ONE\n@two.md');
    write(root, 'docs/two.md', 'TWO\n@three.md');
    write(root, 'docs/three.md', 'THREE\n@four.md');
    write(root, 'docs/four.md', 'FOUR-TOO-DEEP');
    write(root, 'docs/cycle.md', 'CYCLE\n@cycle.md');
    symlinkSync(outside, path.join(root, 'linked'), 'junction');
    const chain = discover(root, ['linked']);
    expect(chain.text).not.toContain('OUTSIDE-SECRET');
    expect(chain.text).toContain('THREE');
    expect(chain.text).not.toContain('FOUR-TOO-DEEP');
    expect(chain.text.match(/CYCLE/g)).toHaveLength(1);
    expect(chain.notes.join('\n')).toMatch(/linked\/AGENTS\.md: refused, resolves outside the workspace/);
    expect(chain.notes.join('\n')).toMatch(/depth limit 3/);
    expect(chain.notes.join('\n')).toMatch(/include cycle skipped/);
    expect(chain.files.map(file => file.path)).toEqual(['AGENTS.md', 'docs/one.md', 'docs/two.md', 'docs/three.md', 'docs/cycle.md']);
  });

  it('keeps the nearest files within the chain budget and states what was cut', () => {
    const root = temp();
    write(root, 'AGENTS.md', 'R'.repeat(20_000));
    write(root, 'pkg/AGENTS.md', 'NEAR-RULE');
    const chain = discover(root, ['pkg']);
    expect(chain.text).toContain('NEAR-RULE');
    expect(chain.bytes).toBeLessThanOrEqual(16 * 1024 + 512);
    expect(chain.files.find(file => file.path === 'AGENTS.md')).toMatchObject({ truncated: true });
    expect(chain.text).toMatch(/AGENTS\.md: truncated to the instruction budget/);
  });

  it('loads path rules only when a matching file is touched', () => {
    const root = temp();
    write(root, '.kodo/rules/tests.md', '---\npaths: ["tests/**/*.ts"]\n---\nTEST-RULE');
    write(root, '.kodo/rules/always.md', 'ALWAYS-RULE');
    expect(discover(root).text).toContain('ALWAYS-RULE');
    expect(discover(root).text).not.toContain('TEST-RULE');
    const touched = discoverInstructions({ workspace: root, directories: [], includeRoot: false, touched: ['tests/unit/a.ts'], global: false, loaded: new Set(), maxBytes: 16_384 });
    expect(touched.text).toContain('TEST-RULE');
    expect(touched.text).not.toContain('ALWAYS-RULE');
  });
});

describe('layered context', () => {
  it('freezes L1-L5, appends touch and decision deltas to history and sends an unstored state frame last', async () => {
    const root = temp();
    write(root, 'AGENTS.md', 'Use two-space indentation.');
    write(root, 'sub/AGENTS.md', 'Sub tests run with npm run sub.');
    write(root, 'sub/a.txt', 'alpha');
    const requests: Request[] = [];
    let runId = '';
    const kodo = app(root, { async complete(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) return calls(call('file.read', { path: 'sub/a.txt' }, 'read'));
      if (requests.length === 2) {
        kodo.submitInput(runId, 'Never touch generated files', { decision: true });
        return answer('done');
      }
      return answer('done after decision');
    } });
    try {
      const run = kodo.createRun({ objective: 'Read sub/a.txt.', workspace: root, binding, permissions: ['read'], budget: { maxTokens: 1_000_000 } });
      runId = run.id;
      expect(kodo.store.events(run.id).find(event => event.type === 'context.instructions_loaded')?.data).toMatchObject({ trigger: 'initial', files: [{ path: 'AGENTS.md', bytes: 26 }] });
      expect((await kodo.run(run.id)).status).toBe('completed');
      const [first, second, third] = requests.map(request => request.messages);
      expect(kinds(first!)).toEqual(['system', 'system', 'project-instructions', 'environment', 'user', 'state']);
      expect(first![0]!.content).toContain('User-role <kodo-runtime> blocks come from the kernel');
      expect(first![1]!.content).toContain('Agent method configuration');
      expect(first!.find(message => attachmentKind(message) === 'project-instructions')!.content).toContain('Use two-space indentation.');
      expect(first!.find(message => attachmentKind(message) === 'environment')!.content).toContain(`Workspace: ${kodo.store.session(run.sessionId).workspace}`);
      // The frozen prefix is byte-identical across steps; everything new is appended.
      const prefix = first!.slice(0, -1);
      expect(second!.slice(0, prefix.length)).toEqual(prefix);
      expect(second!.filter(message => message.role === 'system')).toHaveLength(2);
      const read = kodo.store.calls(run.id).find(operation => operation.name === 'file.read')!;
      expect(read.status, JSON.stringify(kodo.store.readBlob(read.resultRef!))).toBe('succeeded');
      expect(kinds(second!.slice(prefix.length))).toEqual(['assistant', 'tool', 'project-instructions', 'state']);
      const delta = second!.slice(prefix.length).find(message => attachmentKind(message) === 'project-instructions')!;
      expect(delta.content).toContain('trigger="touch"');
      expect(delta.content).toContain('Sub tests run with npm run sub.');
      expect(delta.content).not.toContain('two-space');
      // A decision changes L4: the new environment is appended, the frozen prefix stays.
      expect(third!.slice(0, prefix.length)).toEqual(prefix);
      const environments = third!.filter(message => attachmentKind(message) === 'environment');
      expect(environments).toHaveLength(2);
      expect(environments[1]!.content).toContain('Never touch generated files');
      expect(kinds(third!.slice(-2))).toEqual(['environment', 'state']);
      expect(second!.at(-1)!.content).toMatch(/^<kodo-runtime kind="state">\n\{/);
      const stored = kodo.store.readBlob<Message[]>(kodo.store.run(run.id).contextRef);
      expect(stored.some(message => attachmentKind(message) === 'state')).toBe(false);
      expect(kodo.store.run(run.id).instructions?.loaded).toEqual(['AGENTS.md', 'sub/AGENTS.md']);
      expect(kodo.store.events(run.id).filter(event => event.type === 'context.instructions_loaded').map(event => event.data.trigger)).toEqual(['initial', 'touch']);
    } finally { await kodo.shutdown(); }
  });

  it('bounds the state frame to five unsettled calls plus a count', async () => {
    const root = temp();
    const requests: Request[] = [];
    const kodo = app(root, { async complete(request) {
      requests.push(structuredClone(request));
      return requests.length === 1 ? calls(...Array.from({ length: 7 }, (_, index) => call('file.read', { path: `missing-${index}.txt` }, `read-${index}`))) : answer('done');
    } });
    try {
      const run = kodo.createRun({ objective: 'Probe files.', workspace: root, binding, permissions: ['read'], budget: { maxTokens: 1_000_000 } });
      expect((await kodo.run(run.id)).status).toBe('completed');
      const state = JSON.parse(requests[1]!.messages.at(-1)!.content!.split('\n')[1]!) as { calls: unknown[]; moreCalls: number };
      expect(state.calls).toHaveLength(5);
      expect(state.moreCalls).toBe(2);
    } finally { await kodo.shutdown(); }
  });

  it('gives a child the parent chain plus its own write-scope directories', () => {
    const root = temp();
    write(root, 'AGENTS.md', 'ROOT-RULE');
    write(root, 'sub/AGENTS.md', 'SUB-RULE');
    write(root, 'pkg/AGENTS.md', 'PKG-RULE');
    const kodo = app(root, { async complete() { return answer(); } });
    try {
      const main = kodo.createRun({ objective: 'Coordinate.', workspace: root, binding, permissions: ['read', 'write'] });
      kodo.store.updateRun(main.id, { instructions: { ...main.instructions!, loaded: [...main.instructions!.loaded, 'sub/AGENTS.md'] } });
      const spawned = kodo.store.transaction(() => kodo.coordinator.mailbox.execute(kodo.store.run(main.id), 'spawn', 'spawn_agent', { objective: 'Change pkg', scope: { write: ['pkg'] } }) as { id: string });
      const child: Run = kodo.store.run(spawned.id);
      const block = kodo.store.readBlob<Message[]>(child.contextRef).find(message => attachmentKind(message) === 'project-instructions')!.content!;
      expect(block.indexOf('ROOT-RULE')).toBeLessThan(block.indexOf('SUB-RULE'));
      expect(block.indexOf('SUB-RULE')).toBeLessThan(block.indexOf('PKG-RULE'));
      expect(child.instructions?.loaded).toEqual(['AGENTS.md', 'sub/AGENTS.md', 'pkg/AGENTS.md']);
      expect(kodo.store.events(child.id).find(event => event.type === 'context.instructions_loaded')?.data).toMatchObject({ trigger: 'inherited' });
    } finally { void kodo.shutdown(); }
  });

  it('uses the global file only when configured and records it for children', () => {
    const root = temp();
    const home = temp();
    write(home, 'AGENTS.md', 'GLOBAL-RULE');
    write(root, 'AGENTS.md', 'ROOT-RULE');
    const kodo = app(root, { async complete() { return answer(); } }, path.join(home, 'AGENTS.md'));
    try {
      const main = kodo.createRun({ objective: 'Coordinate.', workspace: root, binding, permissions: ['read'] });
      const block = kodo.store.readBlob<Message[]>(main.contextRef).find(message => attachmentKind(message) === 'project-instructions')!.content!;
      expect(block.indexOf('GLOBAL-RULE')).toBeLessThan(block.indexOf('ROOT-RULE'));
      expect(main.instructions?.loaded).toEqual(['global:AGENTS.md', 'AGENTS.md']);
    } finally { void kodo.shutdown(); }
  });
});
