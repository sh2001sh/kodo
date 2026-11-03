# -*- coding: utf-8 -*-
"""Generate materials + reference deliverables for data-03-periodic-report.

Run from the case directory:  python verify/gen-data.py

Outputs:
  workspace/materials/daily_ledger.csv
  verify/reference/deliverables/monthly-report.md
  verify/expected-data-03.json

Monthly totals / MoM percentages / top category are computed from the generated
CSV with pandas and cross-checked with exact Decimal arithmetic.
"""
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
import csv
import json
import random
from pathlib import Path

import pandas as pd

CASE = Path(__file__).resolve().parent.parent
MAT = CASE / "workspace" / "materials"
REF = CASE / "verify" / "reference" / "deliverables"
VERIFY = CASE / "verify"

START = date(2026, 7, 1)
N_DAYS = 90
PER_DAY = 2
CATEGORIES = ["办公用品", "差旅", "技术服务", "市场推广", "其他"]
CATEGORY_WEIGHT = [0.34, 0.22, 0.2, 0.16, 0.08]
MONTHS = ["2026-07", "2026-08", "2026-09"]
CENT = Decimal("0.01")


def q2(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def fmt2(value: Decimal) -> str:
    return f"{q2(Decimal(value)):.2f}"


def fmt_pct(value: Decimal) -> str:
    return f"{q2(Decimal(value)):.2f}%"


def build_materials() -> None:
    rng = random.Random(20261103)
    rows = []
    sequence = 1
    for day_offset in range(N_DAYS):
        day = START + timedelta(days=day_offset)
        for _ in range(PER_DAY):
            category = rng.choices(CATEGORIES, weights=CATEGORY_WEIGHT, k=1)[0]
            amount = q2(Decimal(str(round(rng.uniform(80, 3200), 2))))
            rows.append(
                {
                    "entry_id": f"E{sequence:04d}",
                    "date": day.strftime("%Y-%m-%d"),
                    "category": category,
                    "amount": fmt2(amount),
                }
            )
            sequence += 1
    MAT.mkdir(parents=True, exist_ok=True)
    with (MAT / "daily_ledger.csv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["entry_id", "date", "category", "amount"], lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def compute_expected() -> dict:
    raw = pd.read_csv(MAT / "daily_ledger.csv", dtype=str, keep_default_na=False)
    df = raw.assign(amount=raw["amount"].map(Decimal), month=raw["date"].str[:7])

    # pandas aggregation, cross-checked against exact Decimal sums below
    grouped = df.groupby("month")["amount"].apply(lambda values: sum(values, Decimal("0")))
    pandas_sums = {
        month: fmt2(grouped[month]) for month in MONTHS
    }

    totals = {month: Decimal(pandas_sums[month]) for month in MONTHS}
    for month in MONTHS:
        exact = sum((value for value in df.loc[df["month"] == month, "amount"]), Decimal("0"))
        assert fmt2(exact) == pandas_sums[month], (month, exact, pandas_sums[month])

    category_totals_exact = {
        category: sum((value for value in df.loc[df["category"] == category, "amount"]), Decimal("0"))
        for category in CATEGORIES
    }
    category_totals_pandas = df.groupby("category")["amount"].apply(
        lambda values: sum(values, Decimal("0"))
    )
    category_totals = {}
    for category in CATEGORIES:
        assert fmt2(category_totals_exact[category]) == fmt2(category_totals_pandas[category]), category
        category_totals[category] = fmt2(category_totals_exact[category])

    pct = {}
    for index, month in enumerate(MONTHS):
        if index == 0:
            pct[month] = "—"
            continue
        previous = totals[MONTHS[index - 1]]
        change = (totals[month] - previous) / previous * Decimal(100)
        pct[month] = fmt_pct(change)
        # guard: no half-cent rounding ambiguity in the MoM percentage
        third_decimal = (change - q2(change)) * Decimal(1000)
        assert abs(third_decimal) > Decimal("0.0001"), f"percentage rounding tie: {month} {change}"

    top_category = max(CATEGORIES, key=lambda c: Decimal(category_totals[c]))
    grand_total = sum(totals.values(), Decimal("0"))
    row_count = len(df)
    day_count = df["date"].nunique()

    # sanity: exactly 3 months x 30 days
    assert day_count == N_DAYS and row_count == N_DAYS * PER_DAY

    return {
        "rows": row_count,
        "days": int(day_count),
        "months": MONTHS,
        "monthlyTotals": {month: fmt2(totals[month]) for month in MONTHS},
        "momPercent": pct,
        "categoryTotals": category_totals,
        "topCategory": top_category,
        "topCategoryTotal": category_totals[top_category],
        "grandTotal": fmt2(grand_total),
    }


def write_reference(expected: dict) -> None:
    REF.mkdir(parents=True, exist_ok=True)
    totals = expected["monthlyTotals"]
    pct = expected["momPercent"]
    lines = [
        "# 2026 年第三季度费用月度报告",
        "",
        f"数据来源：materials/daily_ledger.csv，共 {expected['rows']} 条记账记录，覆盖 {expected['days']} 天（{expected['months'][0]} 至 {expected['months'][-1]}，每天 2 条）。全季度费用合计 {expected['grandTotal']}。",
        "",
        "## 一、每月合计与环比",
        "",
        "| 月份 | 合计 | 环比 |",
        "| --- | --- | --- |",
    ]
    for month in expected["months"]:
        lines.append(f"| {month} | {totals[month]} | {pct[month]} |")
    lines += [
        "",
        "## 二、类别构成",
        "",
        "| 类别 | 合计 |",
        "| --- | --- |",
    ]
    ordered_categories = sorted(expected["categoryTotals"], key=lambda c: Decimal(expected["categoryTotals"][c]), reverse=True)
    for category in ordered_categories:
        lines.append(f"| {category} | {expected['categoryTotals'][category]} |")
    lines += [
        "",
        "## 三、最大类别与解读",
        "",
        f"全季度金额最大的类别是{expected['topCategory']}，合计 {expected['topCategoryTotal']}，占季度总费用的"
        f" {float(Decimal(expected['topCategoryTotal']) / Decimal(expected['grandTotal']) * 100):.2f}%。",
        "",
        f"从月度趋势看，{expected['months'][1]}较{expected['months'][0]}环比变化 {pct[expected['months'][1]]}，"
        f"{expected['months'][2]}较{expected['months'][1]}环比变化 {pct[expected['months'][2]]}。"
        f"建议结合{expected['topCategory']}的明细继续拆分预算，控制季度内波动。",
        "",
    ]
    (REF / "monthly-report.md").write_text("\n".join(lines), encoding="utf-8", newline="\n")


def main() -> None:
    build_materials()
    expected = compute_expected()
    write_reference(expected)
    payload = {"case": "data-03-periodic-report", **expected}
    (VERIFY / "expected-data-03.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print("materials bytes:", (MAT / "daily_ledger.csv").stat().st_size)
    print("report bytes:", (REF / "monthly-report.md").stat().st_size)


if __name__ == "__main__":
    main()
