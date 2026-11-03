import { describe, expect, it } from 'vitest';
import { parseAgentScope, parseAgentSlots } from '../src/cli/agent-input.js';
import { cliAgentPolicy, validateAgentPolicy } from '../src/cli/host-state.js';

describe('agent CLI task data', () => {
  it('preserves text and decodes path arrays without splitting commas inside a path', () => {
    expect(parseAgentSlots(['requirement=add a page', 'entry_files=["web/a,b.ts","web/index.ts"]', 'contract=artifact-1']))
      .toEqual({ requirement: 'add a page', entry_files: ['web/a,b.ts', 'web/index.ts'], contract: 'artifact-1' });
    expect(parseAgentScope('{"read":["web"],"write":[]}')).toEqual({ read: ['web'], write: [] });
    expect(parseAgentScope(undefined)).toBeUndefined();
  });
  it('reports invalid and repeated slots before opening storage', () => {
    for (const slots of [['name'], ['name='], ['name=[]'], ['name=[42]'], ['name=a', 'name=b']]) expect(() => parseAgentSlots(slots)).toThrow();
    expect(() => parseAgentScope('{"write":"web"}')).toThrow();
  });
});

describe('agent CLI policies', () => {
  it('expresses each factor independently and preserves explicit all-off', () => {
    expect(cliAgentPolicy({ 'agent-factors': 'B', 'agent-retention': 'off' })).toEqual({ agentFactors: { A: false, B: true, C: false, D: false, E: false }, agentRetention: 'off' });
    expect(cliAgentPolicy({ 'agent-factors': 'none' })).toEqual({ agentFactors: { A: false, B: false, C: false, D: false, E: false } });
    expect(cliAgentPolicy({})).toBeUndefined();
    expect(cliAgentPolicy({ 'agent-factors': 'A,B,C,D,E' })).toEqual({ agentFactors: { A: true, B: true, C: true, D: true, E: true } });
  });
  it('validates configured path roots and rejects unknown policies', () => {
    expect(() => validateAgentPolicy({ projectRoots: { 'project.tests': ['tests', 'packages/ui/tests'] } })).not.toThrow();
    expect(() => cliAgentPolicy({ 'agent-retention': 'auto' })).toThrow();
    expect(() => cliAgentPolicy({ 'agent-factors': 'F' })).toThrow();
    expect(() => validateAgentPolicy({ projectRoots: { 'project.tests': ['tests/*.ts'] } })).toThrow();
  });
});
