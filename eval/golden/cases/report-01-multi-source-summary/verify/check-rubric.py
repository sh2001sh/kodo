# -*- coding: utf-8 -*-
"""One-shot self-check for a Kodo golden case.

Verifies, without the real scoring engine, that:

  1. case.json / rubric.json satisfy the schema in
     docs/kodo-golden-eval-design-20261103.md (basic structural validation);
  2. the reference solution (verify/reference/) passes every mechanical check
     in rubric.json with score 1.0 and zero rule violations;
  3. an empty output workspace fails (score below passThreshold / violations).

The script never ships to the model: it lives under verify/.
Only the check kinds used by the data/report samples are implemented; an
unknown kind raises (per design doc: unimplemented kind is an engine error,
not a sample failure).

Usage, from the case directory:
    python verify/check-rubric.py              # runs both modes, asserts both
    python verify/check-rubric.py --mode reference
    python verify/check-rubric.py --mode empty
"""
from __future__ import annotations

import argparse
import csv
import fnmatch
import json
import re
import shutil
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


# --------------------------------------------------------------------------
# loading / validation
# --------------------------------------------------------------------------
def load_json(path: Path):
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise AssertionError(f"{path.name}: UTF-8 BOM is not allowed")
    return json.loads(raw.decode("utf-8"))


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
    if not (CASE / "workspace" / "materials").is_dir():
        errors.append("workspace/materials/ is missing")
    if not (CASE / "workspace" / "deliverables").is_dir():
        errors.append("workspace/deliverables/ is missing")

    if rubric.get("schemaVersion") != 1:
        errors.append("rubric.json: schemaVersion must be 1")
    threshold = rubric.get("passThreshold")
    if not isinstance(threshold, (int, float)) or not 0 < threshold <= 1:
        errors.append("rubric.json: passThreshold must be a number in (0, 1]")
    checks = rubric.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("rubric.json: checks must be a non-empty array")
        checks = []
    seen = set()
    for check in checks:
        cid = check.get("id")
        if not cid or cid in seen:
            errors.append(f"rubric.json: check id missing or duplicated: {cid!r}")
        seen.add(cid)
        if check.get("kind") not in CHECK_KINDS:
            errors.append(f"rubric.json: check {cid}: unknown kind {check.get('kind')!r}")
        if not isinstance(check.get("weight"), (int, float)) or check["weight"] <= 0:
            errors.append(f"rubric.json: check {cid}: weight must be positive")
        for rel in _paths_of(check):
            if not rel.startswith("deliverables/") and not rel.startswith("materials/"):
                errors.append(f"rubric.json: check {cid}: path {rel!r} must live under deliverables/") 
    for rule in rubric.get("rules") or []:
        if rule.get("kind") not in CHECK_KINDS:
            errors.append(f"rubric.json: rule {rule.get('id')}: unknown kind {rule.get('kind')!r}")

    if errors:
        raise AssertionError("metadata validation failed:\n  - " + "\n  - ".join(errors))


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


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def read_text(root: Path, rel: str) -> str | None:
    path = root / rel
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def read_csv_rows(root: Path, rel: str) -> tuple[list[str], list[dict]] | None:
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


# --------------------------------------------------------------------------
# check evaluators: each returns (ok, detail)
# --------------------------------------------------------------------------
def eval_file_exists(root: Path, params: dict):
    rel = params["path"]
    min_bytes = int(params.get("minBytes") or 1)
    if any(ch in rel for ch in "*?"):
        matches = [p for p in root.glob(rel) if p.is_file()]
        if not matches:
            return False, f"no file matches {rel}"
        small = [p for p in matches if p.stat().st_size < min_bytes]
        return (not small), f"matched {len(matches)} file(s)" + (f"; too small: {[p.name for p in small]}" if small else "")
    path = root / rel
    if not path.is_file():
        return False, f"missing file {rel}"
    size = path.stat().st_size
    if size < min_bytes:
        return False, f"{rel} is {size}B < minBytes {min_bytes}"
    return True, f"{rel} exists ({size}B)"


def _contains_report(text: str, params: dict):
    low = text
    missing_all = [needle for needle in params.get("all") or [] if needle not in low]
    any_list = params.get("any") or []
    hit_any = (not any_list) or any(needle in low for needle in any_list)
    found_none = [needle for needle in params.get("none") or [] if needle in low]
    details = []
    if missing_all:
        details.append(f"missing all-of {missing_all}")
    if not hit_any:
        details.append(f"none of {any_list} present")
    if found_none:
        details.append(f"forbidden strings present {found_none}")
    return (not details), "; ".join(details) if details else "ok"


def eval_file_contains(root: Path, params: dict):
    path = params["path"]
    text = read_text(root, path)
    if text is None:
        return False, f"missing file {path}"
    ok, detail = _contains_report(text, params)
    return ok, detail


def eval_final_contains(root: Path, params: dict):  # pragma: no cover - unused by samples
    raise NotImplementedError("final-contains needs the final answer text; not used by this sample")


def eval_final_regex(root: Path, params: dict):  # pragma: no cover - unused by samples
    raise NotImplementedError("final-regex needs the final answer text; not used by this sample")


def eval_csv_columns(root: Path, params: dict):
    path = params["path"]
    loaded = read_csv_rows(root, path)
    if loaded is None:
        return False, f"missing file {path}"
    header, _ = loaded
    missing = [col for col in params.get("required") or [] if col not in header]
    if missing:
        return False, f"header {header} missing {missing}"
    return True, f"header ok ({len(header)} columns)"


def eval_csv_rows(root: Path, params: dict):
    path = params["path"]
    loaded = read_csv_rows(root, path)
    if loaded is None:
        return False, f"missing file {path}"
    _, rows = loaded
    count = len(rows)
    lo = int(params["minRows"])
    hi = params.get("maxRows")
    if count < lo:
        return False, f"{count} data rows < minRows {lo}"
    if hi is not None and count > int(hi):
        return False, f"{count} data rows > maxRows {hi}"
    return True, f"{count} data rows"


def eval_csv_cell(root: Path, params: dict):
    path = params["path"]
    loaded = read_csv_rows(root, path)
    if loaded is None:
        return False, f"missing file {path}"
    _, rows = loaded
    where = params.get("where") or {}
    expect = params.get("expect") or {}
    tolerance = float(params.get("tolerance") or 0.0)
    matches = [
        row
        for row in rows
        if all(str(row.get(col, "")).strip() == str(value).strip() for col, value in where.items())
    ]
    if not matches:
        return False, f"no row matching {where}"
    bad = []
    for col, wanted in expect.items():
        actual = matches[0].get(col)
        if not eq_value(actual, wanted, tolerance):
            bad.append(f"{col}: got {actual!r}, want {wanted!r} (tol {tolerance})")
    if bad:
        return False, "; ".join(bad)
    return True, f"row {where} matched {len(matches)} time(s)"


def _split_md_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def markdown_tables(text: str) -> list[list[list[str]]]:
    """Return parsed tables as [rows][cells]; separator rows are dropped."""
    lines = text.splitlines()
    tables, block, i = [], [], 0
    while i < len(lines):
        stripped = lines[i].strip()
        if stripped.startswith("|"):
            block.append(stripped)
            i += 1
            continue
        if block:
            tables.append(block)
            block = []
        i += 1
    if block:
        tables.append(block)

    parsed = []
    for raw in tables:
        rows = [_split_md_row(line) for line in raw]
        rows = [
            row
            for row in rows
            if not all(re.fullmatch(r":?-{2,}:?", cell.replace(" ", "")) for cell in row)
        ]
        if rows:
            parsed.append(rows)
    return parsed


def eval_markdown_table(root: Path, params: dict):
    path = params["path"]
    text = read_text(root, path)
    if text is None:
        return False, f"missing file {path}"
    required = params.get("requiredHeaders") or []
    min_rows = int(params.get("minRows") or 1)
    candidates = [
        rows
        for rows in markdown_tables(text)
        if rows and all(header in rows[0] for header in required)
    ]
    if not candidates:
        return False, f"no markdown table with headers {required}"
    best = max(candidates, key=len)
    data_rows = len(best) - 1
    if data_rows < min_rows:
        return False, f"table has {data_rows} data rows < minRows {min_rows}"
    return True, f"table with headers {required}, {data_rows} data rows"


def eval_json_values(root: Path, params: dict):
    path = params["path"]
    raw = read_text(root, path)
    if raw is None:
        return False, f"missing file {path}"
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
        if eq_value(node, wanted, float(params.get("tolerance") or 0.0)) is False:
            return False, f"{dotted}: got {node!r}, want {wanted!r}"
    return True, "json values ok"


def eval_artifact_count(root: Path, params: dict):
    directory = root / params["dir"]
    if not directory.is_dir():
        return False, f"missing directory {params['dir']}"
    count = sum(1 for p in directory.glob(params.get("glob") or "*") if p.is_file())
    if count < int(params["min"]):
        return False, f"{count} artifacts < min {params['min']}"
    return True, f"{count} artifacts"


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
    path = params["path"]
    text = read_text(root, path)
    if text is None:
        return False, f"missing file {path}"
    allowed_roots = params.get("allowedRoots") or ["materials"]
    root_pattern = "|".join(re.escape(r) for r in allowed_roots)
    pattern = re.compile(
        r"(?<![\w./-])(" + root_pattern + r"/[A-Za-z0-9_\-./\u4e00-\u9fff]+\.[A-Za-z0-9]+)"
    )
    problems = []
    for match in pattern.finditer(text):
        rel = match.group(1).rstrip(".,;:")
        if not (root / rel).is_file():
            problems.append(f"cited source does not exist: {rel}")
    if problems:
        return False, "; ".join(problems)

    if params.get("requireExcerpt"):
        material_texts = _material_texts(root, allowed_roots)
        excerpts = re.findall(r"“([^”]+)”", text) + re.findall(r'"([^"\n]+)"', text)
        excerpts = [exc.strip() for exc in excerpts if len(exc.strip()) >= 10]
        missing = [exc for exc in excerpts if not any(exc in source for source in material_texts)]
        if missing:
            preview = [exc[:40] + ("…" if len(exc) > 40 else "") for exc in missing]
            return False, f"quoted excerpts not found verbatim in {allowed_roots}: {preview}"
    return True, f"citations ok; excerpts verified={bool(params.get('requireExcerpt'))}"


def eval_command(root: Path, params: dict):  # pragma: no cover - unused by samples
    raise NotImplementedError("command checks are executed by the real scoring engine; not used by this sample")


def eval_protected_unchanged(root: Path, params: dict):  # pragma: no cover - unused by samples
    raise NotImplementedError("protected-unchanged is prepared by the runner; not used by this sample")


def eval_human(root: Path, params: dict):
    return None  # excluded from scoring until a human fills human.json


EVALUATORS = {
    "file-exists": eval_file_exists,
    "file-contains": eval_file_contains,
    "final-contains": eval_final_contains,
    "final-regex": eval_final_regex,
    "csv-columns": eval_csv_columns,
    "csv-rows": eval_csv_rows,
    "csv-cell": eval_csv_cell,
    "markdown-table": eval_markdown_table,
    "json-values": eval_json_values,
    "citation-sources": eval_citation_sources,
    "protected-unchanged": eval_protected_unchanged,
    "command": eval_command,
    "artifact-count": eval_artifact_count,
    "human": eval_human,
}


def evaluate(root: Path, rubric: dict) -> dict:
    results, violations = [], []
    for check in rubric["checks"]:
        outcome = EVALUATORS[check["kind"]](root, check.get("params") or {})
        if outcome is None:
            results.append({"id": check["id"], "kind": check["kind"], "status": "pending", "detail": "human pending"})
            continue
        ok, detail = outcome
        results.append(
            {
                "id": check["id"],
                "kind": check["kind"],
                "status": "pass" if ok else "fail",
                "detail": detail,
            }
        )
    for rule in rubric.get("rules") or []:
        outcome = EVALUATORS[rule["kind"]](root, rule.get("params") or {})
        if outcome is None:
            continue
        ok, detail = outcome
        if not ok:
            violations.append({"id": rule.get("id"), "kind": rule["kind"], "detail": detail})

    scored = [item for item in results if item["status"] != "pending"]
    total_weight = sum(
        check["weight"] for check, item in zip(rubric["checks"], results) if item["status"] != "pending"
    )
    passed_weight = sum(
        check["weight"]
        for check, item in zip(rubric["checks"], results)
        if item["status"] == "pass"
    )
    score = (passed_weight / total_weight) if total_weight else 0.0
    passed = not violations and score >= float(rubric["passThreshold"])
    return {
        "results": results,
        "violations": violations,
        "score": round(score, 6),
        "passed": passed,
        "humanPending": any(item["status"] == "pending" for item in results),
    }


# --------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------
def prepare_workspace(mode: str) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix=f"kodo-golden-check-{CASE.name}-"))
    shutil.copytree(WORKSPACE, tmp, dirs_exist_ok=True)
    if mode == "reference":
        if not REFERENCE.is_dir():
            raise SystemExit(f"missing reference directory: {REFERENCE}")
        shutil.copytree(REFERENCE, tmp, dirs_exist_ok=True)
    return tmp


def run_mode(mode: str) -> dict:
    root = prepare_workspace(mode)
    try:
        rubric = load_json(RUBRIC_PATH)
        report = evaluate(root, rubric)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\n=== mode: {mode} ===")
    for item in report["results"]:
        print(f"  [{item['status'].upper():7}] {item['id']:4} {item['kind']:16} {item['detail']}")
    for violation in report["violations"]:
        print(f"  [VIOLATION] {violation['id']} {violation['kind']}: {violation['detail']}")
    print(
        f"  score={report['score']:.4f} threshold={rubric['passThreshold']} "
        f"passed={report['passed']} violations={len(report['violations'])} humanPending={report['humanPending']}"
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["both", "reference", "empty"], default="both")
    args = parser.parse_args()

    print(f"case: {CASE.name}")
    validate_metadata()
    print("metadata validation: OK")

    ok = True
    if args.mode in ("both", "reference"):
        reference = run_mode("reference")
        reference_ok = (
            reference["passed"] and not reference["violations"] and reference["score"] == 1.0
        )
        print(f"expectation reference: 100% pass, 0 violations (got passed={reference['passed']}, "
              f"score={reference['score']}, violations={len(reference['violations'])})")
        if not reference_ok:
            ok = False
            print("SELF-CHECK FAILED: reference solution does not pass the rubric with 100% score")
    if args.mode in ("both", "empty"):
        empty = run_mode("empty")
        print(f"expectation empty: not passed (got passed={empty['passed']})")
        if empty["passed"]:
            ok = False
            print("SELF-CHECK FAILED: empty output passes the rubric")

    print("\nSELF-CHECK OK" if ok else "\nSELF-CHECK FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
