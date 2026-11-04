import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { repairResponse } from '../src/runtime/response-repair.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

describe('response repair', () => {
  it('maps unmapped provider wire names back to logical tools and leaves unknown names alone', () => {
    const response = calls(call('file_search', { pattern: 'x' }, 'a'), call('file.read', { path: 'a' }, 'b'), call('not_a_tool', {}, 'c'));
    const repaired = repairResponse(response, ['file.read', 'file.search'], false);
    expect(repaired.response.message.tool_calls!.map(item => item.name)).toEqual(['file.search', 'file.read', 'not_a_tool']);
    expect(repaired.renamed).toEqual([{ from: 'file_search', to: 'file.search' }]);
  });

  it('executes a repaired wire name under its logical tool with every tool still offered', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'notes.txt'), 'timeout notes\n');
    const offered: string[][] = [];
    const app = new Application(path.join(root, '.state'), scripted(
      async request => { offered.push(request.tools.map(tool => tool.name)); return calls(call('file_search', { path: '.', query: 'timeout' }, 'wire')); },
      async request => { offered.push(request.tools.map(tool => tool.name)); return calls(call('file.apply_patch', { path: 'REPORT.md', expectedHash: null, content: 'report\n' }, 'save')); },
      async () => answer('Saved REPORT.md.'),
    ));
    try {
      const run = app.createRun({ objective: 'Save REPORT.md and reply.', workspace: root, binding, permissions: ['read', 'write'], budget: { maxTokens: 200_000, maxModelCalls: 3 } });
      const final = await app.run(run.id);
      expect(final.status, final.error).toBe('completed');
      expect(offered.every(names => names.includes('file.search') && names.includes('file.apply_patch'))).toBe(true);
      const repaired = app.store.calls(run.id).find(item => item.kind === 'tool' && item.id.endsWith(':wire'))!;
      expect(repaired).toMatchObject({ name: 'file.search', effect: 'read', status: 'succeeded' });
      expect(app.store.events(run.id).find(event => event.type === 'model.response_repaired')?.data.renamed).toEqual([{ from: 'file_search', to: 'file.search' }]);
      expect(readFileSync(path.join(root, 'REPORT.md'), 'utf8')).toBe('report\n');
    } finally { await app.shutdown(); }
  });

  it('reports the current hash on a save conflict so the run can correct it without another read', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'DELIVERY.md'), '');
    let conflict = '';
    const app = new Application(path.join(root, '.state'), scripted(
      calls(call('file.read', { path: 'DELIVERY.md' }, 'read-before-edit')),
      calls(call('file.apply_patch', { path: 'DELIVERY.md', expectedHash: null, content: 'report\n' }, 'stale')),
      async request => { conflict = request.messages.findLast(message => message.role === 'tool')!.content; return answer('Reported the conflict.'); },
    ));
    try {
      const run = app.createRun({ objective: 'Save DELIVERY.md and reply.', workspace: root, binding, permissions: ['read', 'write'] });
      await app.run(run.id);
      expect(conflict).toContain('FILE_CONFLICT');
      expect(conflict).toContain(`current hash is ${createHash('sha256').update('').digest('hex')}`);
    } finally { await app.shutdown(); }
  });
});
