import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assess, definition, objective } from './method-discovery.mjs';

test('the independent convention check rejects generic output and a stale version', () => {
  const valid = { project: 'FastAPI', version: '0.1.2', rehearsal_protocol: 'kodo-release-r7', compatibility: 'No API behavior changes; metadata rehearsal only.' };
  assert.equal(assess(JSON.stringify(valid), '0.1.2').passed, true);
  assert.equal(assess(JSON.stringify({ version: '0.1.2', compatibility: 'Compatible' }), '0.1.2').passed, false);
  assert.equal(assess(JSON.stringify(valid), '0.2.0').passed, false);
  assert.equal(assess('not JSON', '0.1.2').passed, false);
  assert.equal((objective + definition.description).includes('kodo-release-r7'), false);
  assert.match(definition.content, /kodo-release-r7/u);
});
