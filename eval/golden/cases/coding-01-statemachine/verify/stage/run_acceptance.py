"""Run the held-out acceptance suite and write machine-readable results.

Called by the golden-eval runner from the evaluated workspace root after the
pristine ``tests/`` tree has been restored and this staging directory copied to
``_verify/``.

Output: ``_verify/acceptance.json``::

    {"collected": 11, "returncode": 0, "tests": {"test_x": true, ...},
     "failed": ["test_y"]}

Exit code is 0 whenever the report was written; the rubric reads the JSON.
A missing report (for example an import-time crash of the runner itself) is
reported by the caller as a scoring error.
"""

import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    verify = Path(__file__).resolve().parent
    report = verify / "acceptance.json"
    junit = verify / "junit.xml"
    result = {"collected": 0, "returncode": None, "tests": {}, "failed": []}
    command = [
        sys.executable,
        "-m",
        "pytest",
        "-o",
        "addopts=",
        "-p",
        "no:cacheprovider",
        "--tb=no",
        "-q",
        str(verify / "test_state_data_scoping.py"),
        f"--junitxml={junit}",
    ]
    completed = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=600)
    result["returncode"] = completed.returncode
    if junit.exists():
        tree = ET.parse(junit)
        for case in tree.iter("testcase"):
            name = (case.get("name") or "").split("[", 1)[0]
            failed = any(child.tag in {"failure", "error", "skipped"} for child in case)
            result["tests"][name] = not failed
            result["collected"] += 1
            if failed:
                result["failed"].append(name)
    report.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
