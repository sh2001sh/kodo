// Case discovery, validation and matrix planning for the golden evaluations.
// Validates case.json (§3), the optional grading block (§3.1) and rubric.json (§4;
// unknown check kinds are rejected here, before any paid cell starts).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { GoldenError } from './errors.mjs';
import { validateRubric } from './score.mjs';

export const CATEGORIES = Object.freeze(['literature', 'data', 'report', 'coding']);
export const DEFAULT_LIMITS = Object.freeze({
  contextTokens: 1_048_576, outputTokens: 393_216, maxOutputTokens: 16_384,
  maxModelCalls: 100, maxTokens: 3_000_000, maxToolCalls: 300, maxDurationMs: 2_700_000,
});
export const DEFAULT_SMOKE = Object.freeze({ minModelCalls: 1, minToolCalls: 1, requireEventPrefixes: [] });
const LIMIT_FIELDS = Object.keys(DEFAULT_LIMITS);
const PERMISSIONS = ['read', 'write', 'exec'];

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;
const isNonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = value => Number.isSafeInteger(value) && value > 0;

function normalizeRelative(value, label) {
  if (!isNonEmptyString(value)) throw new GoldenError('CASE_SCHEMA', `${label} must be a non-empty relative path`);
  let normalized = value.replace(/\\/gu, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/u, '');
  if (!normalized) return '.';
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) throw new GoldenError('CASE_SCHEMA', `${label} must be relative to the case/workspace, got ${value}`);
  if (normalized.split('/').some(segment => segment === '..')) throw new GoldenError('CASE_SCHEMA', `${label} must not escape its root, got ${value}`);
  return normalized;
}

function validateLimits(limits) {
  if (!isRecord(limits)) throw new GoldenError('CASE_SCHEMA', 'case.json limits must be an object');
  const result = {};
  for (const field of LIMIT_FIELDS) {
    const value = limits[field] ?? DEFAULT_LIMITS[field];
    if (!isPositiveInteger(value)) throw new GoldenError('CASE_SCHEMA', `case.json limits.${field} must be a positive integer`);
    result[field] = value;
  }
  for (const [field, value] of Object.entries(limits)) {
    if (LIMIT_FIELDS.includes(field) || isPositiveInteger(value)) continue;
    throw new GoldenError('CASE_SCHEMA', `case.json limits.${field} must be a positive integer`);
  }
  if (result.maxOutputTokens > result.outputTokens) throw new GoldenError('CASE_SCHEMA', `limits.maxOutputTokens (${result.maxOutputTokens}) must not exceed limits.outputTokens (${result.outputTokens})`);
  if (result.contextTokens < 2) throw new GoldenError('CASE_SCHEMA', 'limits.contextTokens must be at least 2');
  return result;
}

function validateSmoke(smoke) {
  const value = smoke ?? {};
  if (!isRecord(value)) throw new GoldenError('CASE_SCHEMA', 'case.json smoke must be an object');
  const result = { ...DEFAULT_SMOKE };
  if (value.minModelCalls !== undefined) {
    if (!isNonNegativeInteger(value.minModelCalls)) throw new GoldenError('CASE_SCHEMA', 'smoke.minModelCalls must be a nonnegative integer');
    result.minModelCalls = value.minModelCalls;
  }
  if (value.minToolCalls !== undefined) {
    if (!isNonNegativeInteger(value.minToolCalls)) throw new GoldenError('CASE_SCHEMA', 'smoke.minToolCalls must be a nonnegative integer');
    result.minToolCalls = value.minToolCalls;
  }
  if (value.requireEventPrefixes !== undefined) {
    if (!Array.isArray(value.requireEventPrefixes) || value.requireEventPrefixes.some(prefix => !isNonEmptyString(prefix))) throw new GoldenError('CASE_SCHEMA', 'smoke.requireEventPrefixes must be an array of non-empty strings');
    result.requireEventPrefixes = [...value.requireEventPrefixes];
  }
  return result;
}

function validateGrading(grading) {
  if (grading === undefined || grading === null) return { restore: [], stage: [] };
  if (!isRecord(grading)) throw new GoldenError('CASE_SCHEMA', 'case.json grading must be an object');
  const restore = grading.restore ?? [];
  if (!Array.isArray(restore)) throw new GoldenError('CASE_SCHEMA', 'grading.restore must be an array of workspace-relative paths');
  const stage = grading.stage ?? [];
  if (!Array.isArray(stage)) throw new GoldenError('CASE_SCHEMA', 'grading.stage must be an array of {from,to} entries');
  return {
    restore: restore.map((value, index) => normalizeRelative(value, `grading.restore[${index}]`)),
    stage: stage.map((entry, index) => {
      if (!isRecord(entry)) throw new GoldenError('CASE_SCHEMA', `grading.stage[${index}] must be an object`);
      return {
        from: normalizeRelative(entry.from, `grading.stage[${index}].from`),
        to: normalizeRelative(entry.to, `grading.stage[${index}].to`),
      };
    }),
  };
}

/** Validate and normalize one case.json. `dirName` must equal the declared id. */
export function validateCase(caseData, { dirName } = {}) {
  if (!isRecord(caseData)) throw new GoldenError('CASE_SCHEMA', 'case.json must be an object');
  if (caseData.schemaVersion !== undefined && caseData.schemaVersion !== 1) throw new GoldenError('CASE_SCHEMA', `unsupported case schemaVersion ${JSON.stringify(caseData.schemaVersion)}`);
  const id = caseData.id;
  if (!isNonEmptyString(id)) throw new GoldenError('CASE_SCHEMA', 'case.json needs a non-empty id');
  if (dirName !== undefined && id !== dirName) throw new GoldenError('CASE_SCHEMA', `case.json id ${id} must match its directory name ${dirName}`);
  if (!CATEGORIES.includes(caseData.category)) throw new GoldenError('CASE_SCHEMA', `case.json category must be one of ${CATEGORIES.join(', ')}`);
  if (!isNonEmptyString(caseData.title)) throw new GoldenError('CASE_SCHEMA', 'case.json needs a non-empty title');
  if (!isNonEmptyString(caseData.objective)) throw new GoldenError('CASE_SCHEMA', 'case.json needs a non-empty objective');
  if (caseData.objective.length > 32_000) throw new GoldenError('CASE_SCHEMA', `case.json objective is ${caseData.objective.length} characters; the runtime accepts at most 32000`);
  const permissions = caseData.permissions ?? ['read', 'write', 'exec'];
  if (!Array.isArray(permissions) || !permissions.length || permissions.some(permission => !PERMISSIONS.includes(permission))) throw new GoldenError('CASE_SCHEMA', `case.json permissions must be a subset of ${PERMISSIONS.join(', ')}`);
  if (new Set(permissions).size !== permissions.length) throw new GoldenError('CASE_SCHEMA', 'case.json permissions must not repeat');
  const materialsGlobs = caseData.materialsGlobs ?? [];
  if (!Array.isArray(materialsGlobs) || materialsGlobs.some(glob => !isNonEmptyString(glob))) throw new GoldenError('CASE_SCHEMA', 'case.json materialsGlobs must be an array of non-empty globs');
  return {
    schemaVersion: 1,
    id,
    category: caseData.category,
    title: caseData.title,
    objective: caseData.objective,
    limits: validateLimits(caseData.limits),
    permissions: [...permissions],
    deliverableDir: normalizeRelative(caseData.deliverableDir ?? '.', 'deliverableDir'),
    smoke: validateSmoke(caseData.smoke),
    materialsGlobs: [...materialsGlobs],
    grading: validateGrading(caseData.grading),
    notes: typeof caseData.notes === 'string' ? caseData.notes : '',
  };
}

const readJson = (file, label) => {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { throw new GoldenError('CASE_IO', `cannot read ${label}: ${error.message}`); }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try { return JSON.parse(text); }
  catch (error) { throw new GoldenError('CASE_JSON', `${label} is not valid JSON: ${error.message}`); }
};

/** Load one case directory (case.json + rubric.json + workspace/). */
export function loadCase(caseDir) {
  const directory = path.resolve(caseDir);
  const dirName = path.basename(directory);
  const caseFile = path.join(directory, 'case.json');
  const rubricFile = path.join(directory, 'rubric.json');
  if (!existsSync(caseFile)) throw new GoldenError('CASE_IO', `${directory} has no case.json`);
  if (!existsSync(rubricFile)) throw new GoldenError('CASE_IO', `${directory} has no rubric.json`);
  const caseData = validateCase(readJson(caseFile, `${dirName}/case.json`), { dirName });
  const rubric = validateRubric(readJson(rubricFile, `${dirName}/rubric.json`));
  const workspaceDir = path.join(directory, 'workspace');
  if (!existsSync(workspaceDir) || !statSync(workspaceDir).isDirectory()) throw new GoldenError('CASE_IO', `${directory} has no workspace/ directory`);
  const verifyDir = path.join(directory, 'verify');
  return {
    id: caseData.id,
    caseDir: directory,
    workspaceDir,
    verifyDir: existsSync(verifyDir) && statSync(verifyDir).isDirectory() ? verifyDir : null,
    caseData,
    rubric,
  };
}

/** All case directories under `casesDir`, sorted by id; directories without case.json are ignored. */
export function loadCases(casesDir) {
  const root = path.resolve(casesDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new GoldenError('CASE_IO', `cases directory does not exist: ${root}`);
  const cases = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (!existsSync(path.join(directory, 'case.json'))) continue;
    cases.push(loadCase(directory));
  }
  if (!cases.length) throw new GoldenError('CASE_IO', `no case directories with case.json under ${root}`);
  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

function mulberry32(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

/**
 * Ordered matrix cells: repeat-major (repeat 1 for every case, then repeat 2...).
 * `--seed <n>` deterministically shuffles the case order inside each repeat; the
 * matrix's smoke gate is always the first cell of this plan.
 */
export function buildPlan(cases, { repeats = 3, seed } = {}) {
  if (!isPositiveInteger(repeats)) throw new GoldenError('PLAN', 'repeats must be a positive integer');
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    let ordered = cases;
    if (seed !== undefined && seed !== null) {
      if (!Number.isSafeInteger(seed)) throw new GoldenError('PLAN', 'seed must be an integer');
      ordered = shuffle(cases, mulberry32(seed + repeat - 1));
    }
    for (const item of ordered) plan.push({ key: `${item.id}:r${repeat}`, caseId: item.id, repeat, case: item });
  }
  return plan;
}
