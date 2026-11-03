import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { cliVerificationPolicy, readHostState, writeHostState } from '../src/cli/host-state.js';
import { createVerificationTool } from '../src/tools/verify.js';
import { temp } from './helpers.js';

describe('optional CLI runtime configuration', () => {
  it('defaults to no backend and keeps an unapproved backend unavailable', () => {
    expect(cliVerificationPolicy({})).toBeUndefined();
    const directory = temp();
    const file = path.join(directory, 'verify.json');
    writeFileSync(file, JSON.stringify({ enabled: true, approved: false, backend: 'wsl', program: process.execPath, args: ['--version'] }), 'utf8');
    const policy = cliVerificationPolicy({ 'verification-config': file });
    expect(policy?.approved).toBe(false);
    expect(createVerificationTool(policy).available).toBe(false);
  });

  it('persists the complete host invocation and optional switches without depending on the source file', () => {
    const directory = temp();
    const file = path.join(directory, 'verify.json');
    const verification = { enabled: true, approved: true, backend: 'container' as const, program: process.execPath, args: ['--version'], repeatLimit: 2, parser: 'exit-code' as const };
    writeFileSync(file, JSON.stringify(verification), 'utf8');
    const original = { sessionId: 'session', runIds: ['run'], questionIds: [], memory: true, lazyTools: true, verification: cliVerificationPolicy({ 'verification-config': file }) };
    writeHostState(directory, [original]);
    writeFileSync(file, '{}', 'utf8');
    expect(readHostState(directory)).toEqual([original]);
    expect(readHostState(directory)[0]?.verification).toEqual(verification);
  });

  it('accepts legacy state and rejects malformed optional settings before execution', () => {
    const directory = temp();
    const state = { sessionId: 'session', runIds: ['run'], questionIds: [] };
    writeHostState(directory, [state]);
    expect(readHostState(directory)).toEqual([state]);
    for (const legacy of [{ inlineMethods: true }, { inlineMethods: false }, { methodUnloading: true }, { methodToolView: 'stable' }]) {
      writeFileSync(path.join(directory, 'cli-host.json'), JSON.stringify([{ ...state, ...legacy }]), 'utf8');
      expect(() => readHostState(directory)).toThrow(expect.objectContaining({ code: 'CLI_HOST_STATE', message: expect.stringContaining('inline-method policy') }));
    }
    writeFileSync(path.join(directory, 'cli-host.json'), JSON.stringify([{ ...state, memory: 'enabled' }]), 'utf8');
    expect(() => readHostState(directory)).toThrow('must be booleans');
    const file = path.join(directory, 'verify.json');
    writeFileSync(file, JSON.stringify({ enabled: true, approved: true, backend: 'wsl', program: process.execPath, args: [], repeatLimit: 11 }), 'utf8');
    expect(() => cliVerificationPolicy({ 'verification-config': file })).toThrow('bounded time/repeats');
  });
});
