# -*- coding: utf-8 -*-
"""One-shot self-check for a Kodo golden case.

Verifies, without the real scoring engine, that:

  1. case.json / rubric.json satisfy the schema in the design doc plus the
     hardening rules from the independent rubric review:
       - passThreshold >= 0.95 (P0-1),
       - a protected-unchanged rule covering materials/ (P0-2),
       - at least one human check,
       - every grading.stage/restore source exists;
  2. the reference solution (verify/reference/) passes every check in
     rubric.json with score 1.0 and zero rule violations;
  3. an empty output workspace fails;
  4. a reference run whose materials/ were tampered with fails the
     protected-unchanged rule (negative control for P0-2).

Host work mirrors scripts/golden/run.mjs: protected snapshots are compared
first, grading.stage assets are copied from the case dir into the staged
workspace, and `command` checks run with cwd = workspace root.

Usage, from the case directory:
    python verify/check-rubric.py                 # all three modes
    python verify/check-rubric.py --mode reference
    python verify/check-rubric.py --mode empty
    python verify/check-rubric.py --mode tampered
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CASE = Path(__file__).resolve().parent.parent
WORKSPACE = CASE / "workspace"
REFERENCE = CASE / "verify" / "reference"
RUBRIC_PATH = CASE / "rubric.json"
CASE_JSON_PATH = CASE / "case.json"

DEFAULT_LIMITS = {
    "contextTokens": 1048576,
    "outputTokens": 393216,
    "maxOutputTokens": 16384,
    "maxModelCalls": 100,
    "maxTokens": 3000000,
    "maxToolCalls": 300,
    "maxDurationMs": 2700000,
}
CATEGORIES = {"literature", "data", "report", "coding"}
CHECK_KINDS = {
    "file-exists",
    "file-contains",
    "final-contains",
    "final-regex",
    "csv-columns",
    "csv-rows",
    "csv-cell",
    "markdown-table",
    "json-values",
    "citation-sources",
    "protected-unchanged",
    "command",
    "artifact-count",
    "human",
}
DEFAULT_COMMAND_TIMEOUT_MS = 600_000


# --------------------------------------------------------------------------
# loading / validation
# --------------------------------------------------------------------------
def load_json(path: Path):
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise AssertionError(f"{path.name}: UTF-8 BOM is not allowed")
    return json.loads(raw.decode("utf-8"))


def _paths_of(check) -> list[str]:
    params = check.get("params") or {}
    out = []
    for key in ("path", "dir"):
        value = params.get(key)
        if isinstance(value, str) and not any(ch in value for ch in "*?"):
            out.append(value)
    for rel in params.get("paths") or []:
        if isinstance(rel, str):
            out.append(rel)
    return out


def validate_metadata() -> None:
    errors = []
    case = load_json(CASE_JSON_PATH)
    rubric = load_json(RUBRIC_PATH)

    expected_id = CASE.name
    if case.get("schemaVersion") != 1:
        errors.append("case.json: schemaVersion must be 1")
    if case.get("id") != expected_id:
        errors.append(f"case.json: id must equal directory name ({expected_id})")
    if case.get("category") not in CATEGORIES:
        errors.append(f"case.json: category must be one of {sorted(CATEGORIES)}")
    if not isinstance(case.get("title"), str) or not case["title"].strip():
        errors.append("case.json: title must be a non-empty string")
    objective = case.get("objective", "")
    if not isinstance(objective, str) or len(objective) < 50:
        errors.append("case.json: objective must be a self-contained prompt (>=50 chars)")
    if "materials/" not in objective or "deliverables/" not in objective:
        errors.append("case.json: objective must mention materials/ and deliverables/")
    if case.get("limits") != DEFAULT_LIMITS:
        errors.append("case.json: limits must equal the contract defaults (design doc section 3)")
    if case.get("permissions") != ["read", "write", "exec"]:
        errors.append('case.json: permissions must be ["read", "write", "exec"]')
    if case.get("deliverableDir") != "deliverables":
        errors.append('case.json: deliverableDir must be "deliverables"')
    smoke = case.get("smoke") or {}
    for key in ("minModelCalls", "minToolCalls", "requireEventPrefixes"):
        if key not in smoke:
            errors.append(f"case.json: smoke.{key} is required")
    if case.get("materialsGlobs") != ["materials/**/*"]:
        errors.append('case.json: materialsGlobs must be ["materials/**/*"]')
    if not (WORKSPACE / "materials").is_dir():
        errors.append("workspace/materials/ is missing")
    if not (WORKSPACE / "deliverables").is_dir():
        errors.append("workspace/deliverables/ is missing")

    # grading: every restore/stage source must exist (mirrors run.mjs applyGrading).
    grading = case.get("grading")
    if grading is not None and not isinstance(grading, dict):
        errors.append("case.json: grading must be an object")
    elif isinstance(grading, dict):
        for rel in grading.get("restore") or []:
            if not (WORKSPACE / str(rel)).exists():
                errors.append(f"case.json: grading.restore source missing: {rel!r}")
        for entry in grading.get("stage") or []:
            if not isinstance(entry, dict) or "from" not in entry or "to" not in entry:
                errors.append(f"case.json: invalid grading.stage entry: {entry!r}")
                continue
            if not (CASE / str(entry["from"])).exists():
                errors.append(f"case.json: grading.stage.from source missing: {entry['from']!r}")

    if rubric.get("schemaVersion") != 1:
        errors.append("rubric.json: schemaVersion must be 1")
    threshold = rubric.get("passThreshold")
    if not isinstance(threshold, (int, float)) or not 0 < threshold <= 1:
        errors.append("rubric.json: passThreshold must be a number in (0, 1]")
    elif threshold < 0.95:
        errors.append("rubric.json: passThreshold must be >= 0.95 (P0-1 from the rubric review)")
    checks = rubric.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("rubric.json: checks must be a non-empty array")
        checks = []
    rules = rubric.get("rules") or []
    if not isinstance(rules, list):
        errors.append("rubric.json: rules must be an array")
        rules = []
    seen = set()
    for check in checks + rules:
        cid = check.get("id")
        if not cid or cid in seen:
            errors.append(f"rubric.json: check id missing or duplicated: {cid!r}")
        seen.add(cid)
        if check.get("kind") not in CHECK_KINDS:
            errors.append(f"rubric.json: entry {cid}: unknown kind {check.get('kind')!r}")
        if not isinstance(check.get("weight", 1), (int, float)) or check.get("weight", 1) <= 0:
            errors.append(f"rubric.json: check {cid}: weight must be positive")
    for rule in rules:
        if rule.get("kind") == "human":
            errors.append(f"rubric.json: rule {rule.get('id')} cannot be a human check")
    for check in checks:
        for rel in _paths_of(check):
            if not rel.startswith("deliverables/") and not rel.startswith("materials/"):
                errors.append(f"rubric.json: check {check.get('id')}: path {rel!r} must live under deliverables/")

    # P0-2: materials must be protected by a hard rule; P1: one human fallback.
    protected_materials = False
    for rule in rules:
        if rule.get("kind") != "protected-unchanged":
            continue
        paths = (rule.get("params") or {}).get("paths") or []
        for path in paths:
            normalized = str(path).replace("\\", "/").rstrip("/")
            if normalized == "materials" or normalized.startswith("materials/"):
                protected_materials = True
    if not protected_materials:
        errors.append('rubric.json: a protected-unchanged rule covering "materials" is required (P0-2)')
    if not any(check.get("kind") == "human" for check in checks):
        errors.append("rubric.json: at least one human check is required (P1)")

    if errors:
        raise AssertionError("metadata validation failed:\n  - " + "\n  - ".join(errors))


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def read_text(root: Path, rel: str) -> str | None:
    path = root / rel
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def read_csv_rows(root: Path, rel: str):
    path = root / rel
    if not path.is_file():
        return None
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        rows = [dict(row) for row in reader]
        return list(reader.fieldnames or []), rows


def as_number(value):
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def eq_value(actual, expected, tolerance: float) -> bool:
    number = as_number(expected)
    if number is not None:
        return as_number(actual) is not None and abs(as_number(actual) - number) <= tolerance + 1e-12
    return str(actual).strip() == str(expected).strip()


def collapse_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


# --------------------------------------------------------------------------
# protected snapshots (mirror scripts/comparison/v3-eval-ledger.mjs)
# --------------------------------------------------------------------------
def snapshot_paths(root: Path, entries: list[str]) -> dict:
    files: dict[str, str] = {}
    missing: list[str] = []
    for entry in entries:
        rel = str(entry).replace("\\", "/")
        absolute = root / rel if rel else root
        if not absolute.exists():
            missing.append(entry)
            continue
        if absolute.is_dir():
            for path in sorted(absolute.rglob("*")):
                if path.is_file():
                    key = path.relative_to(root).as_posix()
                    files[key] = hashlib.sha256(path.read_bytes()).hexdigest()
        else:
            files[rel] = hashlib.sha256(absolute.read_bytes()).hexdigest()
    return {"files": files, "missing": missing}


def compare_protected(seed: dict, run: dict) -> dict:
    seed_files = seed["files"]
    run_files = run["files"]
    added = sorted(set(run_files) - set(seed_files))
    removed = sorted(set(seed_files) - set(run_files))
    modified = sorted(key for key in seed_files.keys() & run_files.keys() if seed_files[key] != run_files[key])
    return {
        "ok": not added and not removed and not modified,
        "added": added,
        "removed": removed,
        "modified": modified,
        "seedMissing": sorted(set(seed["missing"])),
        "runMissing": sorted(set(run["missing"])),
    }


# --------------------------------------------------------------------------
# command checks (mirror run.mjs executeCommand)
# --------------------------------------------------------------------------
def execute_command(params: dict, root: Path) -> dict:
    program = params["program"]
    if program in ("node", "node.exe"):
        resolved = shutil.which("node")
        if resolved is None:
            return {"exitCode": None, "timedOut": False, "stdout": "", "stderr": "node executable not found on PATH"}
        program = resolved
    cwd = root / str(params["cwd"]) if params.get("cwd") else root
    timeout_seconds = (params.get("timeoutMs") or DEFAULT_COMMAND_TIMEOUT_MS) / 1000
    environment = dict(
        os.environ,
        GOLDEN_CASE_DIR=str(CASE),
        GOLDEN_VERIFY_DIR=str(CASE / "verify"),
    )
    try:
        completed = subprocess.run(
            [program, *(params.get("args") or [])],
            cwd=str(cwd),
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
        )
    except FileNotFoundError:
        return {"exitCode": None, "timedOut": False, "stdout": "", "stderr": f"program not found: {params['program']}"}
    except subprocess.TimeoutExpired as exc:
        return {
            "exitCode": None,
            "timedOut": True,
            "stdout": (exc.stdout or "") if isinstance(exc.stdout, str) else "",
            "stderr": (exc.stderr or "") if isinstance(exc.stderr, str) else "",
        }
    return {"exitCode": completed.returncode, "timedOut": False, "stdout": completed.stdout, "stderr": completed.stderr}


# --------------------------------------------------------------------------
# check evaluators: each returns (ok, detail) or None for pending human checks
# --------------------------------------------------------------------------
def eval_file_exists(root: Path, params: dict):
    rel = params["path"]
    min_bytes = int(params.get("minBytes") or 1)
    if any(ch in rel for ch in "*?"):
        matches = [p for p in root.glob(rel) if p.is_file()]
        if not matches:
            return False, f"no file matches {rel}"
        accepted = [p for p in matches if p.stat().st_size >= min_bytes]
        return (bool(accepted), f"matched {len(matches)} file(s)" if accepted else f"no match reaches minBytes {min_bytes}")
    path = root / rel
    if not path.is_file():
        return False, f"missing file {rel}"
    size = path.stat().st_size
    if size < min_bytes:
        return False, f"{rel} is {size}B < minBytes {min_bytes}"
    return True, f"{rel} exists ({size}B)"


def _contains_report(text: str, params: dict):
    missing_all = [needle for needle in params.get("all") or [] if needle not in text]
    any_list = params.get("any") or []
    hit_any = (not any_list) or any(needle in text for needle in any_list)
    found_none = [needle for needle in params.get("none") or [] if needle in text]
    details = []
    if missing_all:
        details.append(f"missing all-of {missing_all}")
    if not hit_any:
        details.append(f"none of {any_list} present")
    if found_none:
        details.append(f"forbidden strings present {found_none}")
    return (not details), "; ".join(details) if details else "ok"


def eval_file_contains(root: Path, params: dict):
    text = read_text(root, params["path"])
    if text is None:
        return False, f"missing file {params['path']}"
    return _contains_report(text, params)


def eval_csv_columns(root: Path, params: dict):
    loaded = read_csv_rows(root, params["path"])
    if loaded is None:
        return False, f"missing file {params['path']}"
    header, _ = loaded
    missing = [col for col in params.get("required") or [] if col not in header]
    return (False, f"header {header} missing {missing}") if missing else (True, f"header ok ({len(header)} columns)")


def eval_csv_rows(root: Path, params: dict):
    loaded = read_csv_rows(root, params["path"])
    if loaded is None:
        return False, f"missing file {params['path']}"
    count = len(loaded[1])
    lo = int(params["minRows"])
    hi = params.get("maxRows")
    if count < lo:
        return False, f"{count} data rows < minRows {lo}"
    if hi is not None and count > int(hi):
        return False, f"{count} data rows > maxRows {hi}"
    return True, f"{count} data rows"


def eval_csv_cell(root: Path, params: dict):
    loaded = read_csv_rows(root, params["path"])
    if loaded is None:
        return False, f"missing file {params['path']}"
    _, rows = loaded
    where = params.get("where") or {}
    expect = params.get("expect") or {}
    tolerance = float(params.get("tolerance") or 0.0)
    matches = [
        row for row in rows
        if all(str(row.get(col, "")).strip() == str(value).strip() for col, value in where.items())
    ]
    if not matches:
        return False, f"no row matching {where}"
    bad = []
    for col, wanted in expect.items():
        actual = matches[0].get(col)
        if not eq_value(actual, wanted, tolerance):
            bad.append(f"{col}: got {actual!r}, want {wanted!r} (tol {tolerance})")
    return (False, "; ".join(bad)) if bad else (True, f"row {where} matched {len(matches)} time(s)")


def _split_md_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def markdown_tables(text: str) -> list[list[list[str]]]:
    lines = text.splitlines()
    tables, block, index = [], [], 0
    while index < len(lines):
        if lines[index].strip().startswith("|"):
            block.append(lines[index].strip())
            index += 1
            continue
        if block:
            tables.append(block)
            block = []
        index += 1
    if block:
        tables.append(block)
    parsed = []
    for raw in tables:
        rows = [_split_md_row(line) for line in raw]
        rows = [row for row in rows if not all(re.fullmatch(r":?-{2,}:?", cell.replace(" ", "")) for cell in row)]
        if rows:
            parsed.append(rows)
    return parsed


def eval_markdown_table(root: Path, params: dict):
    text = read_text(root, params["path"])
    if text is None:
        return False, f"missing file {params['path']}"
    required = params.get("requiredHeaders") or []
    min_rows = int(params.get("minRows") or 1)
    candidates = [rows for rows in markdown_tables(text) if rows and all(header in rows[0] for header in required)]
    if not candidates:
        return False, f"no markdown table with headers {required}"
    best = max(candidates, key=len)
    data_rows = len(best) - 1
    if data_rows < min_rows:
        return False, f"table has {data_rows} data rows < minRows {min_rows}"
    return True, f"table with headers {required}, {data_rows} data rows"


def eval_json_values(root: Path, params: dict):
    raw = read_text(root, params["path"])
    if raw is None:
        return False, f"missing file {params['path']}"
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        return False, f"invalid JSON: {exc}"
    for dotted, wanted in (params.get("expect") or {}).items():
        node = doc
        for part in dotted.split("."):
            if isinstance(node, dict) and part in node:
                node = node[part]
            elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
                node = node[int(part)]
            else:
                return False, f"path {dotted} not found"
        if not eq_value(node, wanted, float(params.get("tolerance") or 0.0)):
            return False, f"{dotted}: got {node!r}, want {wanted!r}"
    return True, "json values ok"


def _material_texts(root: Path, allowed_roots: list[str]) -> list[str]:
    texts = []
    for allowed in allowed_roots:
        base = root / allowed
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if path.is_file():
                try:
                    texts.append(path.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    continue
    return texts


def eval_citation_sources(root: Path, params: dict):
    text = read_text(root, params["path"])
    if text is None:
        return False, f"missing file {params['path']}"
    allowed_roots = params.get("allowedRoots") or ["materials"]
    root_pattern = "|".join(re.escape(r) for r in allowed_roots)
    pattern = re.compile(r"(?<![\w./-])(" + root_pattern + r"/[A-Za-z0-9_\-./\u4e00-\u9fff]+\.[A-Za-z0-9]+)")
    problems = []
    for match in pattern.finditer(text):
        rel = match.group(1).rstrip(".,;:")
        if not (root / rel).is_file():
            problems.append(f"cited source does not exist: {rel}")
    if problems:
        return False, "; ".join(problems)
    if params.get("requireExcerpt"):
        texts = _material_texts(root, allowed_roots)
        excerpts = re.findall(r"“([^”]+)”", text) + re.findall(r'"([^"\n]+)"', text)
        excerpts = [exc.strip() for exc in excerpts if len(exc.strip()) >= 10]
        missing = [exc for exc in excerpts if not any(exc in source or collapse_whitespace(exc) in collapse_whitespace(source) for source in texts)]
        if missing:
            preview = [exc[:40] + ("…" if len(exc) > 40 else "") for exc in missing]
            return False, f"quoted excerpts not found verbatim in {allowed_roots}: {preview}"
    return True, f"citations ok; excerpts verified={bool(params.get('requireExcerpt'))}"


def eval_artifact_count(root: Path, params: dict):
    directory = root / params["dir"]
    if not directory.is_dir():
        return False, f"missing directory {params['dir']}"
    count = sum(1 for p in directory.glob(params.get("glob") or "*") if p.is_file())
    return (False, f"{count} artifacts < min {params['min']}") if count < int(params["min"]) else (True, f"{count} artifacts")


# --------------------------------------------------------------------------
# scoring (rules first, then weighted checks; human checks excluded while pending)
# --------------------------------------------------------------------------
def evaluate(root: Path, rubric: dict) -> dict:
    protected_results: dict[str, dict] = {}
    command_results: dict[str, dict] = {}
    for scope in ("rules", "checks"):
        for entry in rubric.get(scope) or []:
            kind = entry.get("kind")
            params = entry.get("params") or {}
            if kind == "protected-unchanged":
                paths = [str(path) for path in params.get("paths") or []]
                protected_results[entry["id"]] = compare_protected(
                    snapshot_paths(WORKSPACE, paths), snapshot_paths(root, paths)
                )
            elif kind == "command":
                command_results[entry["id"]] = execute_command(params, root)

    def eval_protected(params: dict, entry_id: str):
        result = protected_results.get(entry_id)
        if result is None:
            raise AssertionError(f"protected-unchanged {entry_id} was not prepared")
        if result["ok"]:
            return True, "protected paths unchanged"
        reasons = []
        for key in ("added", "removed", "modified"):
            if result[key]:
                reasons.append(f"{key}: {result[key][:5]}")
        return False, "; ".join(reasons)

    def eval_command(params: dict, entry_id: str):
        result = command_results.get(entry_id)
        if result is None:
            raise AssertionError(f"command {entry_id} was not executed")
        expected = params.get("expectExit", 0)
        if result["timedOut"]:
            return False, f"command timed out: {params.get('program')} {' '.join(params.get('args') or [])}"
        if result["exitCode"] != expected:
            stderr = (result.get("stderr") or "").strip()
            stdout = (result.get("stdout") or "").strip()
            return False, f"command exit {result['exitCode']} != {expected}: {(stderr or stdout)[-400:]}"
        return True, f"command exit {result['exitCode']}"

    evaluators = {
        "file-exists": eval_file_exists,
        "file-contains": eval_file_contains,
        "csv-columns": eval_csv_columns,
        "csv-rows": eval_csv_rows,
        "csv-cell": eval_csv_cell,
        "markdown-table": eval_markdown_table,
        "json-values": eval_json_values,
        "citation-sources": eval_citation_sources,
        "artifact-count": eval_artifact_count,
    }

    def evaluate_entry(entry: dict):
        kind = entry.get("kind")
        params = entry.get("params") or {}
        if kind == "human":
            return None
        if kind == "protected-unchanged":
            return eval_protected(params, entry["id"])
        if kind == "command":
            return eval_command(params, entry["id"])
        if kind in evaluators:
            return evaluators[kind](root, params)
        raise NotImplementedError(f"check kind {kind!r} is not implemented in this self-check (engine-only kinds: final-*, protected host data)")

    results = []
    for check in rubric["checks"]:
        outcome = evaluate_entry(check)
        if outcome is None:
            results.append({"id": check["id"], "kind": check["kind"], "status": "pending", "detail": "human pending"})
            continue
        ok, detail = outcome
        results.append({"id": check["id"], "kind": check["kind"], "status": "pass" if ok else "fail", "detail": detail})

    violations = []
    for rule in rubric.get("rules") or []:
        outcome = evaluate_entry(rule)
        if outcome is None:
            continue
        ok, detail = outcome
        if not ok:
            violations.append({"id": rule.get("id"), "kind": rule["kind"], "detail": detail})

    scored = [r for r in results if r["status"] != "pending"]
    total_weight = sum(
        check["weight"] for check, result in zip(rubric["checks"], results) if result["status"] != "pending"
    )
    passed_weight = sum(
        check["weight"] for check, result in zip(rubric["checks"], results) if result["status"] == "pass"
    )
    score = (passed_weight / total_weight) if total_weight else 0.0
    passed = not violations and score >= float(rubric["passThreshold"])
    return {
        "results": results,
        "violations": violations,
        "score": round(score, 6),
        "passed": passed,
        "humanPending": any(r["status"] == "pending" for r in results),
    }


# --------------------------------------------------------------------------
# workspace staging (mirror run.mjs applyGrading) and modes
# --------------------------------------------------------------------------
def apply_grading(root: Path) -> None:
    case = load_json(CASE_JSON_PATH)
    grading = case.get("grading") or {}
    for relative in grading.get("restore") or []:
        source = WORKSPACE / str(relative)
        target = root / str(relative)
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)
    stages = grading.get("stage") or []
    if not stages and (CASE / "verify").is_dir():
        stages = [{"from": "verify", "to": "verify"}]
    for entry in stages:
        source = CASE / str(entry["from"])
        target = root / str(entry["to"])
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target)


def prepare_workspace(mode: str) -> Path:
    root = Path(tempfile.mkdtemp(prefix=f"kodo-golden-check-{CASE.name}-"))
    shutil.copytree(WORKSPACE, root, dirs_exist_ok=True)
    if mode in ("reference", "tampered"):
        if not REFERENCE.is_dir():
            raise SystemExit(f"missing reference directory: {REFERENCE}")
        shutil.copytree(REFERENCE, root, dirs_exist_ok=True)
    if mode == "tampered":
        material_files = sorted(path for path in (root / "materials").rglob("*") if path.is_file())
        if not material_files:
            raise SystemExit("tampered mode needs at least one material file")
        with material_files[0].open("a", encoding="utf-8", newline="\n") as handle:
            handle.write("\nTAMPERED-BY-SELF-CHECK\n")
    apply_grading(root)
    return root


def run_mode(mode: str) -> dict:
    root = prepare_workspace(mode)
    try:
        rubric = load_json(RUBRIC_PATH)
        report = evaluate(root, rubric)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n=== mode: {mode} ===")
    for item in report["results"]:
        print(f"  [{item['status'].upper():7}] {item['id']:4} {item['kind']:18} {item['detail']}")
    for violation in report["violations"]:
        print(f"  [VIOLATION] {violation['id']} {violation['kind']}: {violation['detail']}")
    print(
        f"  score={report['score']:.4f} threshold={load_json(RUBRIC_PATH)['passThreshold']} "
        f"passed={report['passed']} violations={len(report['violations'])} humanPending={report['humanPending']}"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["all", "reference", "empty", "tampered"], default="all")
    args = parser.parse_args()

    print(f"case: {CASE.name}")
    validate_metadata()
    print("metadata validation: OK (threshold>=0.95, materials protected, human fallback, grading sources exist)")

    ok = True
    if args.mode in ("all", "reference"):
        reference = run_mode("reference")
        reference_ok = (
            reference["passed"]
            and not reference["violations"]
            and reference["score"] == 1.0
            and reference["humanPending"]
        )
        print(
            f"expectation reference: 100% pass, 0 violations (got passed={reference['passed']}, "
            f"score={reference['score']}, violations={len(reference['violations'])}, humanPending={reference['humanPending']})"
        )
        if not reference_ok:
            ok = False
            print("SELF-CHECK FAILED: reference solution does not pass every check with score 1.0")
    if args.mode in ("all", "empty"):
        empty = run_mode("empty")
        print(f"expectation empty: not passed (got passed={empty['passed']})")
        if empty["passed"]:
            ok = False
            print("SELF-CHECK FAILED: empty output passes the rubric")
    if args.mode in ("all", "tampered"):
        tampered = run_mode("tampered")
        protected_violation = any(violation["kind"] == "protected-unchanged" for violation in tampered["violations"])
        print(
            f"expectation tampered materials: not passed with a protected-unchanged violation "
            f"(got passed={tampered['passed']}, protectedViolation={protected_violation})"
        )
        if tampered["passed"] or not protected_violation:
            ok = False
            print("SELF-CHECK FAILED: tampered materials are not detected by the protected-unchanged rule")

    print("\nSELF-CHECK OK" if ok else "\nSELF-CHECK FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
