#!/usr/bin/env node
// Independent acceptance checks for the pager repair task.
//
// This file is part of the fixture and is PROTECTED: it must not be modified by
// the agent under test. It only uses Node built-ins. It exits 0 when every
// acceptance check passes and exits 1 (after printing explicit FAIL: lines) when
// the workspace is still in its seeded, broken state.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paginate } from './src/pager.mjs';
import { MAX_PAGE_SIZE, PAGE_DEFAULT } from './src/legacy.js';

let checks = 0;
const failures = [];

function check(name, run) {
  checks += 1;
  try {
    run();
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error && error.message ? String(error.message).split('\n')[0] : String(error);
    console.log(`FAIL: ${name} - ${message}`);
  }
}

const values = (count) => Array.from({ length: count }, (_, index) => index + 1);
const show = (value) => JSON.stringify(value);

// --- Frozen legacy contract -------------------------------------------------
check('legacy MAX_PAGE_SIZE is 37', () => assert.equal(MAX_PAGE_SIZE, 37, 'src/legacy.js must keep MAX_PAGE_SIZE = 37'));
check('legacy PAGE_DEFAULT is 10', () => assert.equal(PAGE_DEFAULT, 10, 'src/legacy.js must keep PAGE_DEFAULT = 10'));
check('src/pager.mjs imports its page limit from ./legacy.js', () => {
  const source = readFileSync(new URL('./src/pager.mjs', import.meta.url), 'utf8');
  assert.match(source, /from\s+['"]\.\/legacy\.js['"]/, "src/pager.mjs must contain an import from './legacy.js'");
  assert.match(source, /\bMAX_PAGE_SIZE\b/, 'src/pager.mjs must use MAX_PAGE_SIZE from src/legacy.js instead of a local copy');
});

// --- Empty / beyond-end behavior -------------------------------------------
check('empty input returns []', () => {
  const actual = paginate([], 1, 10);
  assert.deepEqual(actual, [], `paginate([], 1, 10) returned ${show(actual)} but must return []`);
});
check('page beyond the end returns []', () => {
  const actual = paginate(values(10), 2, 10);
  assert.deepEqual(actual, [], `paginate(values(10), 2, 10) returned ${show(actual)} but must return []`);
});
check('page far beyond the end returns []', () => {
  const actual = paginate(values(5), 7, 3);
  assert.deepEqual(actual, [], `paginate(values(5), 7, 3) returned ${show(actual)} but must return []`);
});

// --- MAX_PAGE_SIZE enforcement ---------------------------------------------
check('requested page size above MAX_PAGE_SIZE clamps to 37', () => {
  const page = paginate(values(100), 1, 1000);
  assert.equal(page.length, MAX_PAGE_SIZE, `paginate(values(100), 1, 1000).length is ${page.length} but must clamp to ${MAX_PAGE_SIZE}`);
  assert.deepEqual(page, values(100).slice(0, MAX_PAGE_SIZE), `paginate(values(100), 1, 1000) must be the first ${MAX_PAGE_SIZE} rows`);
});
check('pageSize 100 clamps to 37 instead of failing', () => {
  const page = paginate(values(100), 1, 100);
  assert.equal(page.length, 37, `paginate(values(100), 1, 100).length is ${page.length} but must be 37`);
});
check('a clamped second page starts exactly MAX_PAGE_SIZE rows later', () => {
  const page = paginate(values(100), 2, 1000);
  assert.equal(page.length, MAX_PAGE_SIZE, `second clamped page length is ${page.length} but must be ${MAX_PAGE_SIZE}`);
  assert.equal(page[0], 38, `second clamped page starts at ${show(page[0])} but must start at 38`);
});

// --- Default size / default page semantics ---------------------------------
check('omitted pageSize uses PAGE_DEFAULT', () => {
  const page = paginate(values(100), 1);
  assert.equal(page.length, PAGE_DEFAULT, `paginate(values(100), 1) returned ${page.length} rows but the default page size is ${PAGE_DEFAULT}`);
});
check('undefined pageSize uses PAGE_DEFAULT', () => {
  const actual = paginate(values(20), 1, undefined);
  assert.deepEqual(actual, values(10), `paginate(values(20), 1, undefined) returned ${show(actual)} but must be ${show(values(10))}`);
});
check('omitted page addresses the first page', () => {
  const actual = paginate(values(15));
  assert.deepEqual(actual, values(10), `paginate(values(15)) returned ${show(actual)} but must be the first ${PAGE_DEFAULT} rows`);
});

// --- Page addressing (the rule documented in docs/04-behavior.md) ----------
check('first page starts with the first row', () => {
  const actual = paginate(values(10), 1, 3);
  assert.deepEqual(actual, [1, 2, 3], `paginate(values(10), 1, 3) returned ${show(actual)} but must return [1,2,3]`);
});
check('second page starts after pageSize rows', () => {
  const actual = paginate(values(10), 2, 3);
  assert.deepEqual(actual, [4, 5, 6], `paginate(values(10), 2, 3) returned ${show(actual)} but must return [4,5,6]`);
});
check('last full page', () => {
  const actual = paginate(values(9), 3, 3);
  assert.deepEqual(actual, [7, 8, 9], `paginate(values(9), 3, 3) returned ${show(actual)} but must return [7,8,9]`);
});
check('page 0 returns []', () => {
  const actual = paginate(values(10), 0, 3);
  assert.deepEqual(actual, [], `paginate(values(10), 0, 3) returned ${show(actual)} but page 0 is invalid and must return []`);
});
check('negative page returns []', () => {
  const actual = paginate(values(10), -1, 3);
  assert.deepEqual(actual, [], `paginate(values(10), -1, 3) returned ${show(actual)} but a negative page must return []`);
});
check('fractional page returns []', () => {
  const actual = paginate(values(10), 1.5, 3);
  assert.deepEqual(actual, [], `paginate(values(10), 1.5, 3) returned ${show(actual)} but a non-integer page must return []`);
});
check('non-numeric page returns []', () => {
  const actual = paginate(values(10), 'abc', 3);
  assert.deepEqual(actual, [], `paginate(values(10), 'abc', 3) returned ${show(actual)} but a non-numeric page must return []`);
});

// --- String/integer handling and invalid sizes -----------------------------
check('integer strings for page and pageSize are accepted', () => {
  const actual = paginate(values(10), '2', '3');
  assert.deepEqual(actual, [4, 5, 6], `paginate(values(10), '2', '3') returned ${show(actual)} but must behave like (2, 3) and return [4,5,6]`);
});
check('pageSize 0 returns []', () => {
  const actual = paginate(values(10), 1, 0);
  assert.deepEqual(actual, [], `paginate(values(10), 1, 0) returned ${show(actual)} but a zero page size must return []`);
});
check('negative pageSize returns []', () => {
  const actual = paginate(values(10), 1, -3);
  assert.deepEqual(actual, [], `paginate(values(10), 1, -3) returned ${show(actual)} but a negative page size must return []`);
});
check('non-numeric pageSize returns []', () => {
  const actual = paginate(values(10), 1, 'three');
  assert.deepEqual(actual, [], `paginate(values(10), 1, 'three') returned ${show(actual)} but a non-numeric page size must return []`);
});
check('fractional pageSize returns []', () => {
  const actual = paginate(values(10), 1, 2.5);
  assert.deepEqual(actual, [], `paginate(values(10), 1, 2.5) returned ${show(actual)} but a non-integer page size must return []`);
});

// --- Return contract -------------------------------------------------------
check('final partial page returns the remaining rows', () => {
  const actual = paginate(values(25), 3, 10);
  assert.deepEqual(actual, values(25).slice(20), `paginate(values(25), 3, 10) returned ${show(actual)} but must return the remaining rows ${show(values(25).slice(20))}`);
});
check('input array is not mutated and a new array is returned', () => {
  const source = values(10);
  const page = paginate(source, 1, 3);
  assert.notEqual(page, source, 'paginate must return a new array instead of a reference to the input');
  assert.deepEqual(source, values(10), `paginate mutated the input array to ${show(source)}`);
});
check('non-array input throws TypeError', () => {
  assert.throws(() => paginate('not-an-array', 1, 3), TypeError, 'paginate must throw TypeError when items is not an array');
});

if (failures.length > 0) {
  console.log('');
  console.log(`FAILED: ${failures.length} of ${checks} acceptance checks failed.`);
  console.log('Fix src/pager.mjs (only source files may change) until every check passes.');
  process.exitCode = 1;
} else {
  console.log('');
  console.log(`PASS: all ${checks} acceptance checks passed. Exit code 0 means the task is accepted.`);
  process.exitCode = 0;
}
