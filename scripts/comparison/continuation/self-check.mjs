// Zero-model-cost self-check for the continuation fixtures.
//
// For every fixture it seeds a throwaway workspace in the OS temp directory,
// asserts the seeded acceptance failure, the protected-file expansion, the
// documentation token window and the dry-run read plan, then applies a
// reference repair in the same throwaway copy to prove the acceptance script
// can reach exit code 0. Nothing outside the temp directory is written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import console from 'node:console';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fixtures, dryRunFileName, seedWorkspace } from './fixtures.mjs';

let estimateTextTokens;
try {
  ({ estimateTextTokens } = await import('../../../dist/runtime/context-tokens.js'));
} catch (error) {
  console.error('FAIL: dist/runtime/context-tokens.js is missing or not built; run `npm run build` first.');
  console.error(`      ${error.message}`);
  process.exit(1);
}

// Pre-registered values. These are intentionally duplicated here so that a
// change to fixtures.mjs cannot silently widen the acceptance windows.
const DOC_TOKEN_RANGES = {
  'task-a': [20000, 28000],
  'task-b': [38000, 50000],
};
const TASK_TOTALS = {
  'task-a': { docs: 9, expectedMinCompactions: 1 },
  'task-b': { docs: 15, expectedMinCompactions: 2 },
};
const WORK_INPUT_TOKENS = 16384;
const VERIFY_COMMAND = ['node', 'verify.mjs'];
const PROTECTED = ['verify.mjs', 'docs', 'src/legacy.js'];
const REQUIRED_PROTECTED_FILES = ['verify.mjs', 'docs/legacy-contract.md', 'src/legacy.js'];
const FILE_READ_MAX_CHARS = 8000;
const FILE_READ_MAX_LINES = 200;

// Reference repair used only in the throwaway copy. It is the intended shape of
// a passing solution; the real agent under test has to derive it from the docs.
const REFERENCE_PAGER = `import { MAX_PAGE_SIZE, PAGE_DEFAULT } from './legacy.js';

function toInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[+-]?\\d+$/.test(trimmed)) return Number(trimmed);
  }
  return null;
}

export function paginate(items, page, pageSize) {
  if (!Array.isArray(items)) throw new TypeError('paginate: items must be an array');
  if (items.length === 0) return [];
  const current = toInteger(page === undefined ? 1 : page);
  const requested = toInteger(pageSize === undefined ? PAGE_DEFAULT : pageSize);
  if (current === null || current < 1) return [];
  if (requested === null || requested < 1) return [];
  const limit = Math.min(requested, MAX_PAGE_SIZE);
  const start = (current - 1) * limit;
  if (start >= items.length) return [];
  return items.slice(start, start + limit);
}
`;

let checks = 0;
let failed = 0;

function report(ok, name, detail) {
  checks += 1;
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
    if (detail) console.error(`     ${String(detail).split('\n').join('\n     ')}`);
  }
}

function reportThrows(name, run) {
  try {
    run();
    report(true, name);
  } catch (error) {
    report(false, name, error && error.message ? error.message : String(error));
  }
}

function hashFile(absolutePath) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

function hashProtected(workspaceDir, protectedFiles) {
  const hashes = new Map();
  for (const relative of protectedFiles) hashes.set(relative, hashFile(path.join(workspaceDir, relative)));
  return hashes;
}

function walkFiles(rootDirectory, relativePrefix = '') {
  const files = [];
  for (const entry of readdirSync(rootDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = relativePrefix ? path.posix.join(relativePrefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(path.join(rootDirectory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function runVerify(workspaceDir) {
  // VERIFY_COMMAND is the literal ['node', 'verify.mjs']; run it with the
  // current Node executable and the command tail so the check is portable.
  return spawnSync(process.execPath, VERIFY_COMMAND.slice(1), { cwd: workspaceDir, encoding: 'utf8', timeout: 60_000, windowsHide: true });
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

// ---------------------------------------------------------------------------
// Fixture-level interface assertions
// ---------------------------------------------------------------------------
report(fixtures.length === 2, `fixtures exports exactly two fixtures (got ${fixtures.length})`);
const expectedIds = ['task-a', 'task-b'];
report(
  fixtures.length === 2 && fixtures[0].id === expectedIds[0] && fixtures[1].id === expectedIds[1],
  `fixture ids are ${expectedIds.join(', ')} in order`,
  fixtures.map((fixture) => fixture.id).join(', '),
);

for (const fixture of fixtures) {
  const expected = TASK_TOTALS[fixture.id];
  report(
    expected !== undefined && fixture.workInputTokens === WORK_INPUT_TOKENS,
    `${fixture.id} workInputTokens is ${WORK_INPUT_TOKENS}`,
    fixture.workInputTokens,
  );
  report(
    expected !== undefined && fixture.expectedMinCompactions === expected.expectedMinCompactions,
    `${fixture.id} expectedMinCompactions is ${expected && expected.expectedMinCompactions}`,
    fixture.expectedMinCompactions,
  );
  reportThrows(`${fixture.id} verifyCommand is ${JSON.stringify(VERIFY_COMMAND)}`, () => {
    assert.deepEqual(fixture.verifyCommand, VERIFY_COMMAND);
  });
  reportThrows(`${fixture.id} protected entries are ${JSON.stringify(PROTECTED)}`, () => {
    assert.deepEqual(fixture.protected, PROTECTED);
  });
  report(typeof fixture.title === 'string' && fixture.title.length > 0, `${fixture.id} title is a non-empty string`);
  report(path.isAbsolute(fixture.assetsDir), `${fixture.id} assetsDir is an absolute path`);
  report(existsSync(fixture.assetsDir), `${fixture.id} assetsDir exists`, fixture.assetsDir);
  const objective = typeof fixture.objective === 'string' ? fixture.objective : '';
  report(
    ['docs/', 'node verify.mjs', 'verify.mjs', 'src/legacy.js', 'summary'].every((needle) => objective.includes(needle)),
    `${fixture.id} objective mentions docs/, node verify.mjs, verify.mjs, src/legacy.js and a summary`,
  );
  report(
    !objective.includes('MAX_PAGE_SIZE') && !objective.includes('PAGE_DEFAULT') && !/\b37\b/.test(objective),
    `${fixture.id} objective does not leak the frozen legacy values`,
  );
  report(
    Array.isArray(fixture.dryRunReadFiles) && fixture.dryRunReadFiles.length === expected.docs,
    `${fixture.id} dryRunReadFiles lists all ${expected.docs} docs`,
    fixture.dryRunReadFiles && fixture.dryRunReadFiles.length,
  );
  report(
    fixture.dryRunReadFiles.length >= 2 && fixture.dryRunReadFiles[0] === 'docs/README.md' && fixture.dryRunReadFiles[1] === 'docs/legacy-contract.md',
    `${fixture.id} dry run reads README.md first and legacy-contract.md second`,
  );
  reportThrows(`${fixture.id} dryRunFileName returns the indexed entry`, () => {
    assert.equal(dryRunFileName(fixture, 0), fixture.dryRunReadFiles[0]);
    assert.equal(dryRunFileName(fixture, fixture.dryRunReadFiles.length - 1), fixture.dryRunReadFiles[fixture.dryRunReadFiles.length - 1]);
    assert.throws(() => dryRunFileName(fixture, -1), RangeError);
    assert.throws(() => dryRunFileName(fixture, fixture.dryRunReadFiles.length), RangeError);
    assert.throws(() => dryRunFileName(fixture, 0.5), TypeError);
  });
}

// Type-level guard for the documented return shape.
reportThrows('seedWorkspace rejects a missing fixture', () => {
  assert.throws(() => seedWorkspace(undefined, path.join(os.tmpdir(), 'unused-seed-workspace')), TypeError);
});

// ---------------------------------------------------------------------------
// Per-fixture temp-workspace checks
// ---------------------------------------------------------------------------
for (const fixture of fixtures) {
  const expected = TASK_TOTALS[fixture.id];
  let workspaceDir;
  try {
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), `kodo-continuation-${fixture.id}-`));
    const seeded = seedWorkspace(fixture, workspaceDir);
    const protectedFiles = seeded.protectedFiles;
    report(Array.isArray(protectedFiles) && protectedFiles.length > 0, `${fixture.id} seedWorkspace returns a non-empty protectedFiles list`);
    report(
      REQUIRED_PROTECTED_FILES.every((required) => protectedFiles.includes(required)),
      `${fixture.id} protectedFiles includes ${REQUIRED_PROTECTED_FILES.join(', ')}`,
      protectedFiles.join(', '),
    );
    report(
      protectedFiles.every((entry) => entry === entry.split(path.sep).join('/') && !entry.includes('\\')),
      `${fixture.id} protectedFiles are POSIX-style relative paths`,
    );
    reportThrows(`${fixture.id} protectedFiles is sorted and contains no duplicates`, () => {
      assert.deepEqual(protectedFiles, [...protectedFiles].sort());
      assert.equal(new Set(protectedFiles).size, protectedFiles.length);
    });

    const docsDirectory = path.join(workspaceDir, 'docs');
    const docsFiles = walkFiles(docsDirectory);
    report(
      docsFiles.length === expected.docs,
      `${fixture.id} workspace docs tree has ${expected.docs} files`,
      String(docsFiles.length),
    );
    const readPlan = new Set(fixture.dryRunReadFiles);
    report(
      fixture.dryRunReadFiles.every((file) => docsFiles.includes(file.replace(/^docs\//, ''))) && docsFiles.every((file) => readPlan.has(`docs/${file}`)),
      `${fixture.id} dryRunReadFiles covers exactly the docs tree`,
    );
    report(
      fixture.dryRunReadFiles.every((file) => existsSync(path.join(workspaceDir, file))),
      `${fixture.id} every dryRunReadFiles path exists in the seeded workspace`,
    );

    let docsTokens = 0;
    let oversized = [];
    for (const file of docsFiles) {
      const text = readFileSync(path.join(docsDirectory, file), 'utf8');
      docsTokens += estimateTextTokens(text);
      const lines = text.split('\n').length;
      if (text.length > FILE_READ_MAX_CHARS || lines > FILE_READ_MAX_LINES) {
        oversized.push(`${file}: ${text.length} chars, ${lines} lines`);
      }
    }
    const [rangeMin, rangeMax] = DOC_TOKEN_RANGES[fixture.id];
    report(
      docsTokens >= rangeMin && docsTokens <= rangeMax,
      `${fixture.id} docs total ${docsTokens} estimated tokens within ${rangeMin}-${rangeMax}`,
      `actual ${docsTokens}`,
    );
    console.log(`     ${fixture.id} docs total: ${docsTokens} estimated tokens across ${docsFiles.length} files`);
    report(
      oversized.length === 0,
      `${fixture.id} every document fits one default file.read page (${FILE_READ_MAX_CHARS} chars / ${FILE_READ_MAX_LINES} lines)`,
      oversized.join('; '),
    );

    // Every protected file must be covered by the expanded list (docs tree included).
    for (const file of docsFiles) {
      if (!protectedFiles.includes(`docs/${file}`)) {
        report(false, `${fixture.id} protectedFiles covers docs/${file}`);
      }
    }

    const beforeHashes = hashProtected(workspaceDir, protectedFiles);
    const seedRun = runVerify(workspaceDir);
    const seedOutput = combinedOutput(seedRun);
    report(seedRun.error === undefined, `${fixture.id} seeded verify run starts without a spawn error`, seedRun.error && seedRun.error.message);
    report(seedRun.status === 1, `${fixture.id} seeded verify exits 1 (got ${seedRun.status})`);
    report(seedOutput.includes('FAIL:'), `${fixture.id} seeded verify prints explicit FAIL: lines`);
    report(!/^PASS:/m.test(seedOutput), `${fixture.id} seeded verify does not claim PASS`);
    const seedFailLines = seedOutput.split('\n').filter((line) => line.startsWith('FAIL:')).length;
    report(seedFailLines >= 5, `${fixture.id} seeded verify reports multiple failures (${seedFailLines} FAIL lines)`);
    console.log(`     ${fixture.id} seeded failure sample: ${seedOutput.split('\n').filter((line) => line.startsWith('FAIL:')).slice(0, 3).join(' || ')}`);

    const afterSeedHashes = hashProtected(workspaceDir, protectedFiles);
    report(
      [...beforeHashes].every(([relative, hash]) => afterSeedHashes.get(relative) === hash),
      `${fixture.id} protected hashes unchanged by the seeded verify run`,
    );

    // Reference repair: only a source file changes, then acceptance must pass.
    writeFileSync(path.join(workspaceDir, 'src', 'pager.mjs'), REFERENCE_PAGER, 'utf8');
    const fixedRun = runVerify(workspaceDir);
    const fixedOutput = combinedOutput(fixedRun);
    report(fixedRun.status === 0, `${fixture.id} reference repair makes verify exit 0 (got ${fixedRun.status})`, fixedOutput.slice(-1200));
    report(/^PASS:/m.test(fixedOutput), `${fixture.id} reference repair prints PASS`);
    const afterFixedHashes = hashProtected(workspaceDir, protectedFiles);
    report(
      [...beforeHashes].every(([relative, hash]) => afterFixedHashes.get(relative) === hash),
      `${fixture.id} protected hashes unchanged by the repair run`,
    );

    // Tamper detection: any protected-file edit must be visible to the hash map.
    const legacyPath = path.join(workspaceDir, 'src', 'legacy.js');
    const originalLegacy = readFileSync(legacyPath);
    writeFileSync(legacyPath, `${originalLegacy.toString('utf8')}// tampered\n`, 'utf8');
    const tamperedHashes = hashProtected(workspaceDir, protectedFiles);
    report(
      tamperedHashes.get('src/legacy.js') !== beforeHashes.get('src/legacy.js'),
      `${fixture.id} hash map detects a protected-file edit`,
    );
    writeFileSync(legacyPath, originalLegacy);
  } catch (error) {
    report(false, `${fixture.id} fixture checks completed without an unexpected error`, error && error.stack ? error.stack : String(error));
  } finally {
    if (workspaceDir && existsSync(workspaceDir)) {
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
      } catch (error) {
        report(false, `${fixture.id} temp workspace cleanup`, error.message);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
if (failed > 0) {
  console.error(`FAILED: ${failed} of ${checks} self-check assertions failed.`);
  process.exitCode = 1;
} else {
  console.log(`PASS: all ${checks} self-check assertions passed (no model or network calls).`);
  process.exitCode = 0;
}

