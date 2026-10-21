import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp } from './helpers.js';

describe('built kernel recovery demonstration', () => {
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
