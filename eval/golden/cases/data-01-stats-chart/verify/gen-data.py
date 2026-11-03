# -*- coding: utf-8 -*-
"""Generate materials + reference deliverables for data-01-stats-chart.

Run from the case directory:  python verify/gen-data.py
Outputs:
  workspace/materials/sales.csv
  verify/reference/deliverables/summary.csv
  verify/reference/deliverables/chart.png
  verify/reference/deliverables/report.md
  verify/expected-data-01.json   (expected values for rubric / README)

All expected numbers are computed from the generated CSV with pandas and
cross-checked with Decimal (exact rational cents) before being emitted.
"""
from decimal import Decimal
import csv
import json
import random
from pathlib import Path

import pandas as pd

CASE = Path(__file__).resolve().parent.parent
WS = CASE / "workspace"
MAT = WS / "materials"
REF = CASE / "verify" / "reference" / "deliverables"
VERIFY = CASE / "verify"

REGIONS = ["华东", "华北", "华南", "西部"]
MONTHS = [f"2026-{m:02d}" for m in range(1, 7)]
BASE = {"华东": 1280.0, "华北": 860.0, "华南": 640.0, "西部": 470.0}
N_ROWS = 240
# 12 blank + 2 non-numeric = 14 invalid rows
BLANK_IDX = [7, 23, 51, 78, 99, 124, 137, 166, 189, 205, 217, 233]
BAD_IDX = [41, 152]


def fmt2(value) -> str:
    return f"{Decimal(str(value)).quantize(Decimal('0.01')):.2f}"


def build_materials() -> None:
    rng = random.Random(20261103)
    rows = []
    for i in range(N_ROWS):
        region = REGIONS[i % 4]
        month = MONTHS[(i * 7) % 6]
        amount = round(BASE[region] * rng.uniform(0.55, 1.65), 2)
        rows.append(
            {
                "order_id": f"SO-{1001 + i}",
                "region": region,
                "month": month,
                "sales_amount": f"{amount:.2f}",
            }
        )
    for idx in BLANK_IDX:
        rows[idx]["sales_amount"] = ""
    for idx in BAD_IDX:
        rows[idx]["sales_amount"] = "N/A"

    MAT.mkdir(parents=True, exist_ok=True)
    out = MAT / "sales.csv"
    with out.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=["order_id", "region", "month", "sales_amount"], lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(rows)


def compute_expected() -> dict:
    raw = pd.read_csv(MAT / "sales.csv", dtype={"order_id": "string", "region": "string", "month": "string", "sales_amount": "string"})
    amount = pd.to_numeric(raw["sales_amount"], errors="coerce")
    valid = raw.assign(amount=amount).dropna(subset=["amount"])

    grouped = (
        valid.groupby("region")["amount"]
        .agg(total_sales="sum", mean_sales="mean", median_sales="median", order_count="count")
        .reindex(sorted(REGIONS))
    )

    # Exact Decimal cross-check of pandas aggregation (amounts have <=2 decimals).
    by_region = {r: [] for r in REGIONS}
    for value, region in zip(valid["amount"], valid["region"]):
        by_region[region].append(Decimal(str(value)))
    expected = {}
    for region, values in by_region.items():
        values_sorted = sorted(values)
        total = sum(values_sorted, Decimal("0"))
        mean = total / Decimal(len(values_sorted))
        n = len(values_sorted)
        if n % 2:
            median = values_sorted[n // 2]
        else:
            median = (values_sorted[n // 2 - 1] + values_sorted[n // 2]) / Decimal(2)
        row = grouped.loc[region]
        expected[region] = {
            "total_sales": fmt2(row["total_sales"]),
            "mean_sales": fmt2(row["mean_sales"]),
            "median_sales": fmt2(row["median_sales"]),
            "order_count": int(row["order_count"]),
        }
        # Decimal cross-check must agree with pandas to the cent.
        assert fmt2(total) == expected[region]["total_sales"], (region, total, row["total_sales"])
        assert fmt2(mean) == expected[region]["mean_sales"], (region, mean, row["mean_sales"])
        assert fmt2(median) == expected[region]["median_sales"], (region, median, row["median_sales"])
        assert int(n) == expected[region]["order_count"], (region, n, row["order_count"])

    total_rows = int(len(raw))
    valid_rows = int(len(valid))
    ranked = sorted(REGIONS, key=lambda r: Decimal(expected[r]["total_sales"]), reverse=True)
    top_region = ranked[0]
    return {
        "input_rows": total_rows,
        "invalid_rows": total_rows - valid_rows,
        "valid_rows": valid_rows,
        "regions": expected,
        "top_region": top_region,
        "top_region_total": expected[top_region]["total_sales"],
        "bottom_region": ranked[-1],
        "bottom_region_total": expected[ranked[-1]]["total_sales"],
        "ranked_regions": ranked,
    }


def write_reference(expected: dict) -> None:
    REF.mkdir(parents=True, exist_ok=True)
    summary = REF / "summary.csv"
    with summary.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(["region", "total_sales", "mean_sales", "median_sales", "order_count"])
        for region in sorted(REGIONS):
            row = expected["regions"][region]
            writer.writerow(
                [region, row["total_sales"], row["mean_sales"], row["median_sales"], row["order_count"]]
            )

    # --- chart.png -------------------------------------------------------
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    for candidate in ("Microsoft YaHei", "SimHei", "SimSun"):
        if any(f.name == candidate for f in font_manager.fontManager.ttflist):
            matplotlib.rcParams["font.sans-serif"] = [candidate, "DejaVu Sans"]
            break
    matplotlib.rcParams["axes.unicode_minus"] = False

    labels = sorted(REGIONS)
    totals = [float(expected["regions"][r]["total_sales"]) for r in labels]
    fig, ax = plt.subplots(figsize=(8, 5))
    bars = ax.bar(labels, totals, color=["#2f6f9f", "#4c9f70", "#c98a2e", "#a25a5a"])
    ax.set_title("Total Sales by Region (2026 H1)")
    ax.set_ylabel("Sales amount")
    ax.bar_label(bars, fmt="%.2f", padding=2, fontsize=8)
    ax.margins(y=0.12)
    fig.tight_layout()
    fig.savefig(REF / "chart.png", dpi=110)
    plt.close(fig)

    top = expected["top_region"]
    second = expected["ranked_regions"][1]
    bottom = expected["bottom_region"]
    total_all = sum(Decimal(expected["regions"][r]["total_sales"]) for r in REGIONS)
    top_row = expected["regions"][top]
    from decimal import Decimal as D

    counts_text = "、".join(
        f"{r}{expected['regions'][r]['order_count']}单" for r in expected["ranked_regions"]
    )
    report = f"""# 区域销售统计结论

本报告基于 materials/sales.csv 的 {expected['input_rows']} 条原始记录，剔除 {expected['invalid_rows']} 条销售额缺失或无法解析的无效记录后，得到 {expected['valid_rows']} 条有效记录。按区域汇总的结果显示，销售额最高的区域是{top}，销售总额为 {top_row['total_sales']}，其平均销售额为 {top_row['mean_sales']}、中位数为 {top_row['median_sales']}；销售额最低的区域是{bottom}，销售总额为 {expected['bottom_region_total']}。四个区域合计销售额为 {total_all:.2f}，{top}占比约 {float(D(top_row['total_sales']) / total_all * 100):.1f}%，区域之间的差距较为明显。

从订单量看，{counts_text}，各区域有效订单数接近，说明总额差距主要来自单笔订单金额与客单价结构，而不是订单数量。中位数与均值的对比也显示，{top}的高销售额并非由少数超大订单拉动，整体客单价水平更高。

因此建议后续销售资源向{top}倾斜，同时针对{bottom}制定专项增长方案。更细的数值见 deliverables/summary.csv，区域对比图见 deliverables/chart.png。
"""
    (REF / "report.md").write_text(report, encoding="utf-8", newline="\n")


def main() -> None:
    build_materials()
    expected = compute_expected()
    write_reference(expected)
    payload = {
        "case": "data-01-stats-chart",
        "inputRows": expected["input_rows"],
        "invalidRows": expected["invalid_rows"],
        "validRows": expected["valid_rows"],
        "topRegion": expected["top_region"],
        "regions": expected["regions"],
    }
    (VERIFY / "expected-data-01.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    print("material bytes:", (MAT / "sales.csv").stat().st_size)
    print("chart bytes:", (REF / "chart.png").stat().st_size)
    print("summary bytes:", (REF / "summary.csv").stat().st_size)
    print("report bytes:", (REF / "report.md").stat().st_size)


if __name__ == "__main__":
    main()
