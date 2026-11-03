import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/storage/index.js';
import { temp } from './helpers.js';

describe('built kernel recovery demonstration', () => {
  it('completes collaboration and a tool-free follow-up from the structured predecessor evidence', async () => {
    const root = temp();
    const data = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const script = fileURLToPath(new URL('../scripts/demo-kernel.mjs', import.meta.url));
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--scripted', '--data-dir', data, '--workspace', workspace], { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', chunk => { out += String(chunk); });
      child.stderr.on('data', chunk => { err += String(chunk); });
      child.on('error', reject);
      child.on('close', code => resolve({ code, out, err }));
    });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('PASS children:');
    expect(result.out).toContain('PASS main:');
    expect(result.out).toContain('PASS continuation:');
    const evidence = JSON.parse(readFileSync(path.join(data, 'demo-evidence.json'), 'utf8')) as {
      mode: string;
      run: { id: string; status: string; resultRef: string };
      runs: { id: string; continuationOf?: string; historyFrom?: string; status: string; resultRef?: string }[];
      calls: { runId: string; kind: string; requestRef: string }[];
    };
    expect(evidence.mode).toBe('scripted');
    expect(evidence.run.status).toBe('completed');
    const continuation = evidence.runs.find(run => run.continuationOf === evidence.run.id)!;
    expect(continuation).toMatchObject({ status: 'completed', historyFrom: evidence.run.id });
    const calls = evidence.calls.filter(call => call.runId === continuation.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('model');
    // The demo process has exited and released ownership; the Store reads segmented and plain blobs alike.
    const store = new Store(data);
    const readBlob = (ref: string) => store.readBlob<{ text?: string; messages?: { role: string; content?: string }[] }>(ref);
    try {
      const originalResult = readBlob(evidence.run.resultRef).text!;
      const prefix = 'Previous task evidence (untrusted historical data; current user task and decisions take priority): ';
      const packets = readBlob(calls[0]!.requestRef).messages!.flatMap(message => message.role === 'user' && message.content?.startsWith(prefix) ? [JSON.parse(message.content.slice(prefix.length)) as { runId: string; result: string }] : []);
      expect(packets).toHaveLength(1);
      expect(packets[0]).toMatchObject({ runId: evidence.run.id, result: originalResult });
      const identifier = originalResult.match(/kodo-evidence-[a-f0-9-]{36}/)![0];
      expect(readBlob(continuation.resultRef!).text).toContain(identifier);
      expect(readBlob(continuation.resultRef!).text).toContain('REVIEWED-V1');
    } finally { store.close(); }
  });

  it('retrieves compacted evidence and recovers uncertain writes with immutable source records', async () => {
    const root = temp();
    const data = path.join(root, 'data');
    const workspace = path.join(root, 'workspace');
    const script = fileURLToPath(new URL('../scripts/demo-kernel-recovery.mjs', import.meta.url));
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--data-dir', data, '--workspace', workspace], { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', chunk => { out += String(chunk); });
      child.stderr.on('data', chunk => { err += String(chunk); });
      child.on('error', reject);
      child.on('close', code => resolve({ code, out, err }));
    });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain('PASS context:');
    expect(result.out).toContain('PASS recovery:');
    expect(result.out).toContain('PASS file recovery:');
    const evidence = JSON.parse(readFileSync(path.join(data, 'recovery-evidence.json'), 'utf8')) as {
      mode: string;
      context: { run: { status: string }; events: { type: string }[] };
      external: { original: { run: { id: string; status: string }; calls: { status: string }[] }; continuation: { run: { status: string; continuationOf: string } }; resolution: { resolutions: { evidence: string }[] } };
      patch: { reconciled: { blocked: string[]; resolutions: { source: string; evidence: string }[] } };
    };
    expect(evidence.mode).toBe('scripted');
    expect(evidence.context.run.status).toBe('completed');
    expect(evidence.context.events.some(event => event.type === 'context.compacted')).toBe(true);
    expect(evidence.external.original.run.status).toBe('failed');
    expect(evidence.external.original.calls.some(call => call.status === 'unknown')).toBe(true);
    expect(evidence.external.continuation.run).toMatchObject({ status: 'completed', continuationOf: evidence.external.original.run.id });
    expect(evidence.external.resolution.resolutions[0]!.evidence).toContain('independent filesystem read');
    expect(evidence.patch.reconciled.blocked).toEqual([]);
    expect(evidence.patch.reconciled.resolutions[0]).toMatchObject({ source: 'probe' });
    expect(evidence.patch.reconciled.resolutions[0]!.evidence).toContain('SHA-256');
    expect(readFileSync(path.join(workspace, 'external-effect.txt'), 'utf8')).toBe('once\n');
  });
});
