// Pure scoring engine for the Kodo golden evaluations.
//
// Implements docs/kodo-golden-eval-design-20261103.md §4: every rubric kind in
// §4.1, weighted `checks`, hard `rules` (violations), `human` checks read from
// runs/<case>/r<n>/human.json, and the §3.1 protection semantics. This module
// performs no I/O: the runner injects `readFile`, `listFiles` and `statFile`,
// plus pre-computed results for the two checks that need the host:
//   - `command` results come from the runner (spawnSync after grading restore/stage),
//   - `protected-unchanged` comparisons are computed by the runner before
//     restore/stage overwrite the model's workspace evidence.
// An unknown kind, an invalid rubric or a missing host result throws GoldenError:
// it is an evaluation-infrastructure error, never a sample failure (§4, §7).

import { GoldenError } from './errors.mjs';

/** Every implemented check kind (§4.1). The table must stay in sync with evaluateCheck. */
export const CHECK_KINDS = Object.freeze([
  'file-exists', 'file-contains', 'final-contains', 'final-regex',
  'csv-columns', 'csv-rows', 'csv-cell', 'markdown-table', 'json-values',
  'citation-sources', 'protected-unchanged', 'command', 'artifact-count', 'human',
]);
/** Rules are hard constraints; a human verdict cannot be a rule. */
export const RULE_KINDS = Object.freeze(CHECK_KINDS.filter(kind => kind !== 'human'));

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value.length > 0;
const isNonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = value => Number.isSafeInteger(value) && value > 0;
const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const isNonEmptyStringArray = value => Array.isArray(value) && value.length > 0 && value.every(item => isNonEmptyString(item));

/** Workspace-relative posix path; rejects absolute paths and escapes. */
export function normalizeRel(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim()) throw new GoldenError('RUBRIC_PATH', `${label} must be a non-empty workspace-relative path`);
  let normalized = value.replace(/\\/gu, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/u, '');
  if (!normalized) return '.';
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) throw new GoldenError('RUBRIC_PATH', `${label} must be workspace-relative, got ${value}`);
  if (normalized.split('/').some(segment => segment === '..')) throw new GoldenError('RUBRIC_PATH', `${label} must not escape the workspace, got ${value}`);
  return normalized;
}

// ---------------------------------------------------------------------------
// Globs: `*` (one path segment), `**` (any depth), `?` (one character).
// ---------------------------------------------------------------------------

export const hasGlob = pattern => /[*?]/u.test(pattern);

export function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') { index++; source += '(?:.*/)?'; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(character)) source += `\\${character}`;
    else source += character;
  }
  return new RegExp(`${source}$`, 'u');
}

/** True when `value` matches the glob as a whole path (both workspace-relative, posix). */
export function matchGlob(pattern, value) {
  return globToRegExp(pattern).test(value);
}

// ---------------------------------------------------------------------------
// Small parsers shared by the CSV / Markdown / JSON checks.
// ---------------------------------------------------------------------------

/** RFC4180-ish CSV parser: quotes, doubled quotes, CRLF, BOM. Returns rows of strings. */
export function parseCsv(text) {
  const source = String(text).replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let fieldStart = true;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; fieldStart = false; }
      } else field += character;
      continue;
    }
    if (character === '"' && fieldStart) { quoted = true; continue; }
    if (character === ',') { row.push(field); field = ''; fieldStart = true; continue; }
    if (character === '\r') { continue; }
    if (character === '\n') { row.push(field); rows.push(row); row = []; field = ''; fieldStart = true; continue; }
    field += character;
    fieldStart = false;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const trimCell = value => String(value ?? '').trim();
const rowIsEmpty = row => row.every(cell => trimCell(cell) === '');

/** Normalized markdown header cell: no emphasis/backticks, collapsed whitespace, lowercase. */
export function normalizeHeaderCell(cell) {
  return trimCell(cell)
    .replace(/`/gu, '')
    .replace(/\*+/gu, '')
    .replace(/_+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
}

function splitTableRow(line) {
  let inner = line.trim();
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  return inner.split('|').map(cell => cell.trim());
}

// GFM tables do not require leading or trailing pipes, so a row is any non-empty
// line with at least one pipe; the separator row below a header decides whether
// the block really is a table, and the header's cell count bounds its rows.
const isTableRow = line => line.includes('|') && line.trim().length > 0;
const isSeparatorRow = line => /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/u.test(line);

/** Every markdown table as {headers, rows, line}; formatting-only header normalization. */
export function parseMarkdownTables(text) {
  const lines = String(text).replace(/\r\n?/gu, '\n').split('\n');
  const tables = [];
  for (let index = 0; index + 1 < lines.length; index++) {
    if (!isTableRow(lines[index]) || !isSeparatorRow(lines[index + 1])) continue;
    const headers = splitTableRow(lines[index]).map(normalizeHeaderCell);
    const width = splitTableRow(lines[index]).length;
    if (splitTableRow(lines[index + 1]).length !== width) continue;
    const rows = [];
    let cursor = index + 2;
    for (; cursor < lines.length && isTableRow(lines[cursor]); cursor++) {
      // A row with a different cell count ends the table instead of swallowing
      // following prose that merely contains a pipe.
      if (splitTableRow(lines[cursor]).length !== width) break;
      const cells = splitTableRow(lines[cursor]);
      if (!rowIsEmpty(cells)) rows.push(cells);
    }
    tables.push({ headers, rows, line: index + 1 });
    index = cursor - 1;
  }
  return tables;
}

/** Resolve a dot path (`a.b.0.c`) inside a JSON value; returns {found, value}. */
export function resolveDotPath(value, dotPath) {
  const segments = String(dotPath).split('.');
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
      current = current[segment];
    } else return { found: false };
  }
  return { found: true, value: current };
}

export function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'number') return Number.isNaN(left) && Number.isNaN(right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

const jsonPreview = value => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 120 ? `${text.slice(0, 117)}...` : text;
  } catch { return String(value); }
};

// ---------------------------------------------------------------------------
// Rubric validation.
// ---------------------------------------------------------------------------

const PARAM_VALIDATORS = {
  'file-exists': params => {
    if (!isNonEmptyString(params.path)) return 'path';
    if (params.minBytes !== undefined && !isNonNegativeInteger(params.minBytes)) return 'minBytes';
    return null;
  },
  'file-contains': params => containsValidator('path', params),
  'final-contains': params => containsValidator(undefined, params),
  'final-regex': params => {
    if (!Array.isArray(params.patterns) || !params.patterns.length) return 'patterns';
    for (const pattern of params.patterns) {
      const plain = isNonEmptyString(pattern);
      const object = isRecord(pattern) && isNonEmptyString(pattern.pattern) && (pattern.flags === undefined || typeof pattern.flags === 'string');
      if (!plain && !object) return 'patterns';
      try { new RegExp(plain ? pattern : pattern.pattern, plain ? '' : pattern.flags ?? ''); }
      catch (error) { throw new GoldenError('RUBRIC_REGEX', `invalid final-regex pattern ${jsonPreview(pattern)}: ${error.message}`); }
    }
    return null;
  },
  'csv-columns': params => {
    if (!isNonEmptyString(params.path)) return 'path';
    if (!isNonEmptyStringArray(params.required)) return 'required';
    return null;
  },
  'csv-rows': params => {
    if (!isNonEmptyString(params.path)) return 'path';
    if (!isNonNegativeInteger(params.minRows)) return 'minRows';
    if (params.maxRows !== undefined && (!isNonNegativeInteger(params.maxRows) || params.maxRows < params.minRows)) return 'maxRows';
    return null;
  },
  'csv-cell': params => {
    if (!isNonEmptyString(params.path)) return 'path';
    if (!isRecord(params.where) || !Object.keys(params.where).length) return 'where';
    if (!isRecord(params.expect) || !Object.keys(params.expect).length) return 'expect';
    const scalar = value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (!Object.values(params.where).every(scalar)) return 'where';
    if (!Object.values(params.expect).every(scalar)) return 'expect';
    if (params.tolerance !== undefined && (typeof params.tolerance !== 'number' || !Number.isFinite(params.tolerance) || params.tolerance < 0)) return 'tolerance';
    return null;
  },
  'markdown-table': params => {
    if (!isNonEmptyString(params.path)) return 'path';
    if (!isNonEmptyStringArray(params.requiredHeaders)) return 'requiredHeaders';
    if (!isNonNegativeInteger(params.minRows)) return 'minRows';
    return null;
  },
  'json-values': params => {
    if (!isNonEmptyString(params.path)) return 'path';
    if (!isRecord(params.expect) || !Object.keys(params.expect).length) return 'expect';
    return null;
  },
  'citation-sources': params => {
    if (!isNonEmptyString(params.path)) return 'path';
    if (!isNonEmptyStringArray(params.allowedRoots)) return 'allowedRoots';
    if (params.requireExcerpt !== undefined && typeof params.requireExcerpt !== 'boolean') return 'requireExcerpt';
    return null;
  },
  'protected-unchanged': params => {
    if (!isNonEmptyStringArray(params.paths)) return 'paths';
    // Optional glob list for run-generated artefacts that are not source changes
    // (for example Python bytecode caches under a protected tests/ tree).
    if (params.ignore !== undefined && !isStringArray(params.ignore)) return 'ignore';
    // §3.1: beforeDigest is no longer required; a legacy value is accepted and ignored.
    return null;
  },
  command: params => {
    if (!isNonEmptyString(params.program)) return 'program';
    if (params.args !== undefined && !isStringArray(params.args)) return 'args';
    if (params.cwd !== undefined && !isNonEmptyString(params.cwd)) return 'cwd';
    if (params.expectExit !== undefined && !Number.isSafeInteger(params.expectExit)) return 'expectExit';
    if (params.timeoutMs !== undefined && !isPositiveInteger(params.timeoutMs)) return 'timeoutMs';
    return null;
  },
  'artifact-count': params => {
    if (typeof params.dir !== 'string' || !params.dir.trim()) return 'dir';
    if (!isNonEmptyString(params.glob)) return 'glob';
    if (!isNonNegativeInteger(params.min)) return 'min';
    return null;
  },
  human: params => (isNonEmptyString(params.question) ? null : 'question'),
};

function containsValidator(pathField, params) {
  if (pathField && !isNonEmptyString(params.path)) return pathField;
  const lists = ['all', 'any', 'none'];
  let constrained = false;
  for (const name of lists) {
    if (params[name] === undefined) continue;
    if (!isStringArray(params[name]) || params[name].some(item => item.length === 0)) return name;
    constrained = true;
  }
  if (!constrained) return 'all|any|none';
  return null;
}

function validateEntry(entry, scope, index, ids) {
  if (!isRecord(entry)) throw new GoldenError('RUBRIC_ENTRY', `${scope}[${index}] must be an object`);
  const id = entry.id;
  if (!isNonEmptyString(id)) throw new GoldenError('RUBRIC_ENTRY', `${scope}[${index}] needs a non-empty id`);
  if (ids.has(id)) throw new GoldenError('RUBRIC_ENTRY', `duplicate rubric id ${id}`);
  ids.add(id);
  const kind = entry.kind;
  if (typeof kind !== 'string' || !CHECK_KINDS.includes(kind)) {
    throw new GoldenError('RUBRIC_UNKNOWN_KIND', `${scope} ${id} uses unknown check kind ${jsonPreview(kind)}; implement it in scripts/golden/score.mjs instead of editing the case`);
  }
  if (scope === 'rules' && kind === 'human') throw new GoldenError('RUBRIC_RULE', `rule ${id} cannot be a human check`);
  const params = entry.params ?? {};
  if (!isRecord(params)) throw new GoldenError('RUBRIC_PARAMS', `${scope} ${id} params must be an object`);
  const invalid = PARAM_VALIDATORS[kind](params);
  if (invalid) throw new GoldenError('RUBRIC_PARAMS', `${scope} ${id} (${kind}) is missing or has an invalid ${invalid}`);
  let weight = 1;
  if (scope === 'checks') {
    weight = entry.weight ?? 1;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) throw new GoldenError('RUBRIC_PARAMS', `check ${id} weight must be a positive number`);
  }
  return { id, kind, weight, params };
}

/** Validate and normalize a rubric; throws GoldenError on schema/infrastructure errors. */
export function validateRubric(rubric) {
  if (!isRecord(rubric)) throw new GoldenError('RUBRIC_SCHEMA', 'rubric must be an object');
  if (rubric.schemaVersion !== undefined && rubric.schemaVersion !== 1) throw new GoldenError('RUBRIC_SCHEMA', `unsupported rubric schemaVersion ${jsonPreview(rubric.schemaVersion)}`);
  const passThreshold = rubric.passThreshold ?? 0.9;
  if (typeof passThreshold !== 'number' || !Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 1) throw new GoldenError('RUBRIC_SCHEMA', 'rubric passThreshold must be a number from 0 to 1');
  const rawChecks = rubric.checks ?? [];
  const rawRules = rubric.rules ?? [];
  if (!Array.isArray(rawChecks)) throw new GoldenError('RUBRIC_SCHEMA', 'rubric checks must be an array');
  if (!Array.isArray(rawRules)) throw new GoldenError('RUBRIC_SCHEMA', 'rubric rules must be an array');
  if (!rawChecks.length && !rawRules.length) throw new GoldenError('RUBRIC_SCHEMA', 'rubric has neither checks nor rules');
  const ids = new Set();
  const checks = rawChecks.map((entry, index) => validateEntry(entry, 'checks', index, ids));
  const rules = rawRules.map((entry, index) => validateEntry(entry, 'rules', index, ids));
  if (!checks.length) throw new GoldenError('RUBRIC_SCHEMA', 'rubric needs at least one scored check; put hard constraints in rules');
  return { schemaVersion: 1, passThreshold, checks, rules };
}

/**
 * Host work the runner must do before evaluating: grading commands (declaration
 * order: rules first, then checks) and the protected paths to compare before
 * restore/stage overwrite the model's evidence.
 */
export function collectRequirements(rubric) {
  const normalized = validateRubric(rubric);
  const commands = [];
  const protectedChecks = [];
  for (const scope of ['rules', 'checks']) {
    for (const entry of normalized[scope]) {
      if (entry.kind === 'command') commands.push({ id: entry.id, scope, params: { ...entry.params } });
      if (entry.kind === 'protected-unchanged') protectedChecks.push({ id: entry.id, scope, paths: entry.params.paths.map((path, index) => normalizeRel(path, `protected-unchanged ${entry.id} paths[${index}]`)), ignore: (entry.params.ignore ?? []).map((pattern, index) => normalizeRel(pattern, `protected-unchanged ${entry.id} ignore[${index}]`)) });
    }
  }
  return { commands, protectedChecks, rubric: normalized };
}

/**
 * Compare the run workspace against the seeded case workspace for all protected
 * paths (§3.1): an added, removed or modified file under any declared path fails.
 * `seed` and `run` are `{files: {rel: sha256}, missing: [entry]}` snapshots of the
 * same declared path list, as produced by protectedSnapshot() in v3-eval-ledger.
 * `ignore` globs drop run-generated artefacts (bytecode caches, build output)
 * before comparing; an ignored file still has to be absent from both sides to
 * count as unchanged.
 */
export function compareProtected(seed, run, ignore = []) {
  const patterns = ignore.map(pattern => normalizeRel(pattern, 'protected-unchanged ignore'));
  const keep = file => !patterns.some(pattern => matchGlob(pattern, file));
  const seedFiles = Object.fromEntries(Object.entries(seed?.files ?? {}).filter(([file]) => keep(file)));
  const runFiles = Object.fromEntries(Object.entries(run?.files ?? {}).filter(([file]) => keep(file)));
  const added = Object.keys(runFiles).filter(file => !(file in seedFiles)).sort();
  const removed = Object.keys(seedFiles).filter(file => !(file in runFiles)).sort();
  const modified = Object.keys(seedFiles).filter(file => file in runFiles && seedFiles[file] !== runFiles[file]).sort();
  const seedMissing = [...new Set(seed?.missing ?? [])].sort();
  const runMissing = [...new Set(run?.missing ?? [])].sort();
  return {
    ok: added.length === 0 && removed.length === 0 && modified.length === 0,
    added, removed, modified,
    seedMissing, runMissing,
  };
}

function protectedReasons(comparison) {
  const reasons = [];
  if (comparison.added.length) reasons.push(`added: ${comparison.added.slice(0, 8).join(', ')}${comparison.added.length > 8 ? ` (+${comparison.added.length - 8})` : ''}`);
  if (comparison.removed.length) reasons.push(`removed: ${comparison.removed.slice(0, 8).join(', ')}${comparison.removed.length > 8 ? ` (+${comparison.removed.length - 8})` : ''}`);
  if (comparison.modified.length) reasons.push(`modified: ${comparison.modified.slice(0, 8).join(', ')}${comparison.modified.length > 8 ? ` (+${comparison.modified.length - 8})` : ''}`);
  if (comparison.ok && comparison.runMissing.length) reasons.push(`protected paths absent after the run: ${comparison.runMissing.join(', ')}`);
  return reasons;
}

// ---------------------------------------------------------------------------
// Evaluation.
// ---------------------------------------------------------------------------

const outcome = (pass, reasons = [], detail = undefined) => ({ pass, reasons, ...(detail === undefined ? {} : { detail }) });

function requireFile(context, relativePath, label) {
  const text = context.read(relativePath);
  if (text === null || text === undefined) return { missing: true, text: null, reasons: [`${label} missing: ${relativePath}`] };
  return { missing: false, text, reasons: [] };
}

function checkFileExists(params, context) {
  const pattern = normalizeRel(params.path, 'file-exists path');
  const minBytes = params.minBytes ?? 1;
  const matches = hasGlob(pattern)
    ? context.list().filter(file => matchGlob(pattern, file))
    : (context.stat(pattern) ? [pattern] : []);
  if (!matches.length) return outcome(false, [`no file matches ${pattern}`]);
  const sized = matches.map(file => ({ file, size: context.stat(file)?.size ?? 0 }));
  const accepted = sized.filter(entry => entry.size >= minBytes);
  if (!accepted.length) return outcome(false, [`${sized.length} match(es) for ${pattern} but none reaches minBytes ${minBytes}: ${sized.slice(0, 5).map(entry => `${entry.file}=${entry.size}`).join(', ')}`], { matches: sized });
  return outcome(true, [], { matches: sized });
}

function containsOutcome(text, params, label) {
  const reasons = [];
  for (const needle of params.all ?? []) if (!text.includes(needle)) reasons.push(`${label} missing required text ${jsonPreview(needle)}`);
  if (params.any?.length && !params.any.some(needle => text.includes(needle))) reasons.push(`${label} misses every any-text: ${params.any.map(jsonPreview).join(', ')}`);
  for (const needle of params.none ?? []) if (text.includes(needle)) reasons.push(`${label} contains forbidden text ${jsonPreview(needle)}`);
  return outcome(reasons.length === 0, reasons);
}

function checkFileContains(params, context) {
  const relativePath = normalizeRel(params.path, 'file-contains path');
  const file = requireFile(context, relativePath, 'file');
  if (file.missing) return outcome(false, file.reasons);
  return containsOutcome(file.text, params, `file ${relativePath}`);
}

function checkFinalContains(params, context) {
  if (!context.finalText.trim()) return outcome(false, ['final reply is empty']);
  return containsOutcome(context.finalText, params, 'final reply');
}

function checkFinalRegex(params, context) {
  if (!context.finalText.trim()) return outcome(false, ['final reply is empty']);
  const reasons = [];
  for (const pattern of params.patterns) {
    const source = typeof pattern === 'string' ? pattern : pattern.pattern;
    const flags = typeof pattern === 'string' ? '' : pattern.flags ?? '';
    const regex = new RegExp(source, flags);
    regex.lastIndex = 0;
    if (!regex.test(context.finalText)) reasons.push(`final reply does not match ${jsonPreview(source)}${flags ? ` (flags ${flags})` : ''}`);
  }
  return outcome(reasons.length === 0, reasons);
}

function readCsvFile(params, context, label) {
  const relativePath = normalizeRel(params.path, `${label} path`);
  const file = requireFile(context, relativePath, 'file');
  if (file.missing) return { ...file, relativePath };
  return { ...file, relativePath, rows: parseCsv(file.text) };
}

function checkCsvColumns(params, context) {
  const csv = readCsvFile(params, context, 'csv-columns');
  if (csv.missing) return outcome(false, csv.reasons);
  if (!csv.rows.length) return outcome(false, [`${csv.relativePath} is empty`]);
  const headers = csv.rows[0].map(trimCell);
  const missing = params.required.map(trimCell).filter(required => !headers.includes(required));
  return missing.length
    ? outcome(false, [`${csv.relativePath} missing columns: ${missing.join(', ')}; header is ${jsonPreview(headers)}`])
    : outcome(true, [], { headers });
}

function checkCsvRows(params, context) {
  const csv = readCsvFile(params, context, 'csv-rows');
  if (csv.missing) return outcome(false, csv.reasons);
  const dataRows = csv.rows.slice(1).filter(row => !rowIsEmpty(row));
  const reasons = [];
  if (dataRows.length < params.minRows) reasons.push(`${csv.relativePath} has ${dataRows.length} data rows, needs >= ${params.minRows}`);
  if (params.maxRows !== undefined && dataRows.length > params.maxRows) reasons.push(`${csv.relativePath} has ${dataRows.length} data rows, needs <= ${params.maxRows}`);
  return outcome(reasons.length === 0, reasons, { rows: dataRows.length });
}

const scalarText = value => trimCell(value);
const numeric = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = trimCell(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

function checkCsvCell(params, context) {
  const csv = readCsvFile(params, context, 'csv-cell');
  if (csv.missing) return outcome(false, csv.reasons);
  if (!csv.rows.length) return outcome(false, [`${csv.relativePath} is empty`]);
  const headers = csv.rows[0].map(trimCell);
  const whereEntries = Object.entries(params.where);
  for (const [columnName] of whereEntries) {
    if (!headers.includes(columnName)) return outcome(false, [`${csv.relativePath} has no column ${columnName} (headers: ${jsonPreview(headers)})`]);
  }
  const dataRows = csv.rows.slice(1).filter(row => !rowIsEmpty(row));
  for (const row of dataRows) {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));
    const whereMatches = whereEntries.every(([column, expected]) => scalarText(record[column]) === scalarText(expected));
    if (!whereMatches) continue;
    const reasons = [];
    for (const [column, expected] of Object.entries(params.expect)) {
      if (!headers.includes(column)) { reasons.push(`${csv.relativePath} has no column ${column}`); continue; }
      const actual = record[column];
      if (params.tolerance !== undefined) {
        const left = numeric(actual);
        const right = numeric(expected);
        if (left !== null && right !== null) {
          if (Math.abs(left - right) > params.tolerance + 1e-9) reasons.push(`${column}: expected ${jsonPreview(right)} +/- ${params.tolerance}, got ${jsonPreview(actual)}`);
          continue;
        }
      }
      if (scalarText(actual) !== scalarText(expected)) reasons.push(`${column}: expected ${jsonPreview(scalarText(expected))}, got ${jsonPreview(scalarText(actual))}`);
    }
    return outcome(reasons.length === 0, reasons, { row: record });
  }
  return outcome(false, [`${csv.relativePath} has no row where ${whereEntries.map(([column, expected]) => `${column}=${jsonPreview(expected)}`).join(' and ')}`]);
}

function checkMarkdownTable(params, context) {
  const relativePath = normalizeRel(params.path, 'markdown-table path');
  const file = requireFile(context, relativePath, 'file');
  if (file.missing) return outcome(false, file.reasons);
  const tables = parseMarkdownTables(file.text);
  if (!tables.length) return outcome(false, [`${relativePath} contains no markdown table`]);
  const required = params.requiredHeaders.map(normalizeHeaderCell);
  const reasons = [];
  for (const table of tables) {
    const missing = required.filter(header => !table.headers.includes(header));
    if (missing.length) { reasons.push(`table at line ${table.line} missing headers: ${missing.join(', ')}`); continue; }
    if (table.rows.length < params.minRows) { reasons.push(`table at line ${table.line} has ${table.rows.length} rows, needs >= ${params.minRows}`); continue; }
    return outcome(true, [], { line: table.line, rows: table.rows.length, headers: table.headers });
  }
  return outcome(false, reasons.length ? reasons : ['no markdown table satisfies the required headers']);
}

function checkJsonValues(params, context) {
  const relativePath = normalizeRel(params.path, 'json-values path');
  const file = requireFile(context, relativePath, 'file');
  if (file.missing) return outcome(false, file.reasons);
  let parsed;
  try { parsed = JSON.parse(file.text.charCodeAt(0) === 0xFEFF ? file.text.slice(1) : file.text); }
  catch (error) { return outcome(false, [`${relativePath} is not valid JSON: ${error.message}`]); }
  const reasons = [];
  for (const [dotPath, expected] of Object.entries(params.expect)) {
    const resolved = resolveDotPath(parsed, dotPath);
    if (!resolved.found) { reasons.push(`${dotPath}: missing from ${relativePath}`); continue; }
    if (!deepEqual(resolved.value, expected)) reasons.push(`${dotPath}: expected ${jsonPreview(expected)}, got ${jsonPreview(resolved.value)}`);
  }
  return outcome(reasons.length === 0, reasons);
}

const QUOTE_PATTERN = /[“"]([^”"\n]+)[”"]/gu;
const MIN_EXCERPT_LENGTH = 10;

/** Normalize whitespace so a quoted excerpt can still match a source wrapped by the deliverable. */
const collapseWhitespace = value => value.replace(/\s+/gu, ' ').trim();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Extract workspace-relative paths under `allowedRoots` from deliverable text (§4.2 item 1). */
export function extractCitedPaths(text, allowedRoots) {
  const roots = allowedRoots.map(root => normalizeRel(root, 'citation-sources allowedRoots[]'));
  if (!roots.length || !String(text).trim()) return [];
  // Chinese punctuation (、。，；：！？) commonly separates or terminates ASCII paths in
  // model-written deliverables; include it in both the boundary and stop classes.
  // Full-width brackets also terminate a path: `materials/x.md（说明）`.
  const prefixed = new RegExp(`(?:^|[\\s"'“”‘’(（\\[【,，、;；:：])((?:${roots.map(escapeRegExp).join('|')})/[^\\s"'“”‘’)\\]）】,，、;；:：<>。！？》」』〉（【〔]+)`, 'gu');
  const found = [];
  for (const match of String(text).matchAll(prefixed)) {
    let candidate = match[1].replace(/[.,;:!?、。！？]+$/u, '');
    if (candidate.endsWith('/')) candidate = candidate.slice(0, -1);
    if (candidate) found.push(candidate);
  }
  return [...new Set(found)];
}

/** Quoted snippets that must be found verbatim when requireExcerpt is on (> = 10 characters). */
export function extractQuotedExcerpts(text) {
  const excerpts = [];
  for (const match of String(text).matchAll(QUOTE_PATTERN)) {
    const excerpt = collapseWhitespace(match[1]);
    if (excerpt.length >= MIN_EXCERPT_LENGTH) excerpts.push(excerpt);
  }
  return [...new Set(excerpts)];
}

function checkCitationSources(params, context) {
  const relativePath = normalizeRel(params.path, 'citation-sources path');
  const file = requireFile(context, relativePath, 'deliverable');
  if (file.missing) return outcome(false, file.reasons);
  const roots = params.allowedRoots.map(root => normalizeRel(root, 'citation-sources allowedRoots[]'));
  const paths = context.list();
  const files = new Set(paths);
  const reasons = [];
  const cited = extractCitedPaths(file.text, roots);
  for (const citedPath of cited) if (!files.has(citedPath)) reasons.push(`cited source does not exist: ${citedPath}`);
  const sourceFiles = paths.filter(candidate => roots.some(root => candidate === root || candidate.startsWith(`${root}/`)));
  const excerpts = params.requireExcerpt ? extractQuotedExcerpts(file.text) : [];
  if (excerpts.length && !sourceFiles.length) reasons.push(`no source files found under ${roots.join(', ')} to verify excerpts`);
  const sourceTexts = [];
  for (const sourceFile of sourceFiles) {
    const text = context.read(sourceFile);
    if (text === null || text === undefined) continue;
    sourceTexts.push({ file: sourceFile, exact: text, collapsed: collapseWhitespace(text) });
  }
  let missingExcerpts = 0;
  for (const excerpt of excerpts) {
    const found = sourceTexts.some(source => source.exact.includes(excerpt) || source.collapsed.includes(excerpt));
    if (!found) { missingExcerpts++; reasons.push(`quoted excerpt not found verbatim in any source: ${excerpt.length > 60 ? `${excerpt.slice(0, 57)}...` : excerpt}`); }
  }
  return outcome(reasons.length === 0, reasons, { cited: cited.length, excerpts: excerpts.length, sourceFiles: sourceFiles.length, missingExcerpts });
}

function checkProtectedUnchanged(params, context, id) {
  const comparison = context.protectedResults?.[id];
  if (!comparison || typeof comparison.ok !== 'boolean') throw new GoldenError('SCORE_UNPREPARED_CHECK', `protected-unchanged ${id} needs the runner-computed comparison before restore/stage; the check cannot be evaluated from files alone`);
  const reasons = protectedReasons(comparison);
  return outcome(comparison.ok, comparison.ok ? [] : reasons, comparison);
}

function checkCommand(params, context, id) {
  const result = context.commandResults?.[id];
  if (!result) throw new GoldenError('SCORE_UNPREPARED_CHECK', `command ${id} needs a runner-executed result; the scorer performs no process execution`);
  const expectExit = params.expectExit ?? 0;
  const reasons = [];
  if (result.timedOut) reasons.push(`command timed out after ${result.durationMs ?? '?'}ms: ${params.program} ${(params.args ?? []).join(' ')}`);
  else if (result.exitCode !== expectExit) reasons.push(`command exited ${result.exitCode ?? 'null'} (expected ${expectExit}): ${params.program} ${(params.args ?? []).join(' ')}`);
  if (reasons.length) {
    const stderr = String(result.stderr ?? '').trim();
    const stdout = String(result.stdout ?? '').trim();
    if (stderr) reasons.push(`stderr: ${stderr.slice(-600)}`);
    else if (stdout) reasons.push(`stdout: ${stdout.slice(-600)}`);
    if (result.error) reasons.push(`spawn: ${result.error}`);
  }
  return outcome(reasons.length === 0, reasons, { exitCode: result.exitCode ?? null, timedOut: Boolean(result.timedOut), durationMs: result.durationMs ?? null });
}

function checkArtifactCount(params, context) {
  const directory = normalizeRel(params.dir, 'artifact-count dir');
  const files = context.list();
  const matches = [];
  for (const file of files) {
    let relative;
    if (directory === '.') relative = file;
    else if (file === directory) continue;
    else if (file.startsWith(`${directory}/`)) relative = file.slice(directory.length + 1);
    else continue;
    if (matchGlob(params.glob, relative)) matches.push(file);
  }
  return matches.length >= params.min
    ? outcome(true, [], { count: matches.length })
    : outcome(false, [`${directory}: ${matches.length} file(s) match ${params.glob}, needs >= ${params.min}`]);
}

function checkHuman(params, context, id) {
  const verdict = context.human?.[id];
  if (typeof verdict !== 'boolean') return { status: 'pending', reasons: [`human verdict pending: write {"${id}": true|false} to runs/.../human.json and rescore`], detail: { question: params.question } };
  return { status: verdict ? 'passed' : 'failed', reasons: verdict ? [] : [`human verdict is false: ${params.question}`], detail: { question: params.question } };
}

function evaluateCheck(entry, context) {
  const { kind, params } = entry;
  switch (kind) {
    case 'file-exists': return checkFileExists(params, context);
    case 'file-contains': return checkFileContains(params, context);
    case 'final-contains': return checkFinalContains(params, context);
    case 'final-regex': return checkFinalRegex(params, context);
    case 'csv-columns': return checkCsvColumns(params, context);
    case 'csv-rows': return checkCsvRows(params, context);
    case 'csv-cell': return checkCsvCell(params, context);
    case 'markdown-table': return checkMarkdownTable(params, context);
    case 'json-values': return checkJsonValues(params, context);
    case 'citation-sources': return checkCitationSources(params, context);
    case 'protected-unchanged': return checkProtectedUnchanged(params, context, entry.id);
    case 'command': return checkCommand(params, context, entry.id);
    case 'artifact-count': return checkArtifactCount(params, context);
    default:
      // validateRubric rejects unknown kinds first; this guard keeps the failure loud if a kind
      // is added to CHECK_KINDS without an implementation.
      throw new GoldenError('RUBRIC_UNKNOWN_KIND', `check kind ${jsonPreview(kind)} has no implementation in score.mjs`);
  }
}

/**
 * Score one run. Pure: all file and process evidence is injected.
 *
 * @returns {{
 *   passed: boolean, score: number|null, passThreshold: number, humanPending: boolean,
 *   evaluatedWeight: number, passedWeight: number, violations: object[],
 *   rules: object[], checks: object[], counts: object
 * }}
 */
export function evaluateRubric({ rubric, caseData = {}, finalText = '', human = {}, protectedResults = {}, commandResults = {}, readFile, listFiles, statFile }) {
  const normalized = validateRubric(rubric);
  if (typeof readFile !== 'function') throw new GoldenError('SCORE_CONTEXT', 'evaluateRubric requires readFile(relativePath)');
  if (typeof listFiles !== 'function') throw new GoldenError('SCORE_CONTEXT', 'evaluateRubric requires listFiles()');
  if (typeof statFile !== 'function') throw new GoldenError('SCORE_CONTEXT', 'evaluateRubric requires statFile(relativePath)');
  const context = {
    caseData, finalText: String(finalText ?? ''), human: human ?? {},
    protectedResults: protectedResults ?? {}, commandResults: commandResults ?? {},
    read: readFile, list: () => listFiles() ?? [], stat: statFile,
  };

  const rules = [];
  const violations = [];
  for (const rule of normalized.rules) {
    const result = evaluateCheck(rule, context);
    const status = result.pass ? 'passed' : 'failed';
    const entry = { id: rule.id, kind: rule.kind, status, reasons: result.reasons ?? [] };
    rules.push(entry);
    if (status === 'failed') violations.push({ id: rule.id, kind: rule.kind, reasons: entry.reasons });
  }

  const checks = [];
  let evaluatedWeight = 0;
  let passedWeight = 0;
  let humanPending = false;
  let passedChecks = 0;
  let failedChecks = 0;
  for (const check of normalized.checks) {
    if (check.kind === 'human') {
      const result = checkHuman(check.params, context, check.id);
      const entry = { id: check.id, kind: check.kind, weight: check.weight, status: result.status, reasons: result.reasons, detail: result.detail };
      checks.push(entry);
      if (result.status === 'pending') { humanPending = true; continue; }
      evaluatedWeight += check.weight;
      if (result.status === 'passed') { passedWeight += check.weight; passedChecks++; } else failedChecks++;
      continue;
    }
    const result = evaluateCheck(check, context);
    const status = result.pass ? 'passed' : 'failed';
    const entry = { id: check.id, kind: check.kind, weight: check.weight, status, reasons: result.reasons ?? [] };
    if (result.detail !== undefined) entry.detail = result.detail;
    checks.push(entry);
    evaluatedWeight += check.weight;
    if (status === 'passed') { passedWeight += check.weight; passedChecks++; } else failedChecks++;
  }

  const score = evaluatedWeight > 0 ? passedWeight / evaluatedWeight : null;
  const passed = violations.length === 0 && score !== null && score >= normalized.passThreshold;
  return {
    passed, score, passThreshold: normalized.passThreshold, humanPending,
    evaluatedWeight, passedWeight, violations, rules, checks,
    counts: { passed: passedChecks, failed: failedChecks, pending: checks.length - passedChecks - failedChecks, rules: rules.length, violations: violations.length },
  };
}
