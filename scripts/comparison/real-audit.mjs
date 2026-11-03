import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { summarizeTrials } from './real-scorecard.mjs';
import { auditEvidence } from './real-evidence.mjs';

export function regressionPassed(acceptance, task, requiredTestPresent) {
  return acceptance.regression.code === 0
    && /Tests\s+\d+ passed/.test(stripVTControlCharacters(acceptance.regression.stdout))
    && (task !== 'package-versions' || requiredTestPresent);
}

export function companionTypeExportOnly(before, after, registry) {
  before = before.replaceAll('\r\n', '\n');
  after = after.replaceAll('\r\n', '\n');
  const pattern = /export type \{([^}]+)\} from '\.\.\/packages\/registry\.js';/g;
  const original = [...before.matchAll(pattern)];
  const changed = [...after.matchAll(pattern)];
  if (original.length !== 1 || changed.length !== 1) return false;
  if (before.replace(pattern, '') !== after.replace(pattern, '')) return false;
  const names = text => text.split(',').map(name => name.trim()).filter(Boolean);
  const oldNames = names(original[0][1]), newNames = names(changed[0][1]);
  return oldNames.every(name => newNames.includes(name)) && newNames.length > oldNames.length
    && newNames.filter(name => !oldNames.includes(name)).every(name => /^[A-Za-z_]\w*$/.test(name)
      && new RegExp(`export (?:interface|type) ${name}\\b`).test(registry));
}

export function applyIsolationReview(row, review) {
  if (!review || typeof review.passed !== 'boolean') throw new Error(`Project boundary has not been reviewed: ${row.id}`);
  const criteria = [...row.acceptance.criteria, { name: 'solution source and evaluator boundaries respected', passed: review.passed }];
  return { ...row, artifactAcceptance: row.acceptance, isolation: review,
    acceptance: { ...row.acceptance, criteria, passed: criteria.every(check => check.passed), coverage: criteria.filter(check => check.passed).length / criteria.length } };
}

// Derive corrections from the same saved artifacts; never modify or rerun an attempt.
export async function auditResults(root) {
  root = path.resolve(root);
  const { results } = JSON.parse(await readFile(path.join(root, 'results.json'), 'utf8'));
  const reports = JSON.parse(await readFile(path.join(root, 'report-audit.json'), 'utf8'));
  const boundaries = JSON.parse(await readFile(path.join(root, 'boundary-audit.json'), 'utf8'));
  const evidence = await auditEvidence(root);
  const corrected = [];
  for (const row of results) {
    const original = row.acceptance;
    if (row.task === 'onboarding') {
      const review = reports.reviews.find(item => item.id === row.id);
      if (!review) throw new Error(`Report has not been manually reviewed: ${row.id}`);
      const criteria = original.criteria.map(check => ({ ...check, passed: review.criteriaChanges[check.name] ?? check.passed }));
      if (review.passed !== criteria.every(check => check.passed)) throw new Error(`Report review criteria disagree: ${row.id}`);
      const score = criteria.slice(0, 6).filter(check => check.passed).length * 10 + Number(criteria[6].passed) * 20 + Number(criteria[7].passed) * 10 + Number(criteria[8].passed) * 10;
      const coverage = criteria.filter(check => check.passed).length / criteria.length;
      if (review.score !== score || Math.abs(review.coverage - coverage) > 1e-10) throw new Error(`Report review arithmetic disagrees: ${row.id}`);
      corrected.push({ ...row, acceptance: { ...original, ...review, criteria, reviewSource: 'report-audit.json' }, rawScore: original.score, rawPassed: original.passed });
      continue;
    }
    const requiredTestPresent = original.changed.includes('tests/package-versions.test.ts')
      && existsSync(path.join(root, row.id, 'independent-workspace/tests/package-versions.test.ts'));
    const testPassed = regressionPassed(original, row.task, requiredTestPresent);
    const databaseFiles = evidence.rows.find(item => item.id === row.id).fixtureDatabaseFiles;
    let companionExport = false;
    if (row.task === 'package-versions' && original.changed.includes('src/application/index.ts')) {
      const allowed = new Set(['src/packages/registry.ts', 'src/cli/packages.ts', 'docs/capability-packages.md', 'src/application/index.ts']);
      const permitted = original.changed.every(file => allowed.has(file) || /^tests\/[^/]+\.test\.ts$/.test(file) && !existsSync(path.join(root, 'source', file)));
      companionExport = permitted && companionTypeExportOnly(
        await readFile(path.join(root, 'source/src/application/index.ts'), 'utf8'),
        await readFile(path.join(root, row.id, 'workspace/src/application/index.ts'), 'utf8'),
        await readFile(path.join(root, row.id, 'workspace/src/packages/registry.ts'), 'utf8'));
    }
    let delta = 0;
    const criteria = original.criteria.map(check => {
      if (check.name === 'existing and required tests pass') {
        delta += (Number(testPassed) - Number(check.passed)) * 10;
        return { ...check, passed: testPassed };
      }
      if (check.name === 'CLI is inert and leaves pointer unchanged' && databaseFiles.length) {
        delta -= Number(check.passed) * 60 / original.oracle.checks.length;
        return { ...check, passed: false, error: `Supplementary inspection found runtime data: ${databaseFiles.join(', ')}` };
      }
      if (check.name === 'only permitted files changed' && companionExport) {
        delta += Number(!check.passed) * 10;
        return { ...check, passed: true, adjudication: 'Only additional change is exporting the new registry type from the public entry point. The task did not state the internal production-file allowlist; this is a related type-only change.' };
      }
      return check;
    });
    corrected.push({ ...row, rawScore: original.score, rawPassed: original.passed,
      acceptance: { ...original, criteria, score: original.score + delta, passed: criteria.every(check => check.passed), coverage: criteria.filter(check => check.passed).length / criteria.length,
        correction: 'Strip ANSI controls from saved test stdout; inspect the real kodo.sqlite in existing fixtures; accept a related public type-only export omitted by the hidden allowlist. No model reruns.' },
    });
  }
  const eligible = corrected.map(row => applyIsolationReview(row, boundaries.reviews.find(item => item.id === row.id)));
  return { results: eligible, summary: summarizeTrials(eligible), artifactSummary: summarizeTrials(corrected), evidence,
    disclosure: 'Post-hoc source audit and deterministic corrections are separate from results.json. The raw evaluator rejects colored passing output, checks the wrong database filename and has a hidden file allowlist narrower than the task wording. Tool-action review additionally checks the pre-existing prohibition on parent solution-source/evaluator reads. Artifact scores remain visible, but contaminated attempts cannot count as eligible successes. All trials use the same corrections; raw outcomes, tokens, time and costs are retained.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/comparison/real-audit.mjs <evidence-root>');
  process.stdout.write(JSON.stringify(await auditResults(process.argv[2]), null, 2) + '\n');
}
