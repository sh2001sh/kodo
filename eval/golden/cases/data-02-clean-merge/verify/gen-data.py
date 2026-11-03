# -*- coding: utf-8 -*-
"""Generate materials + reference deliverables for data-02-clean-merge.

Run from the case directory:  python verify/gen-data.py

Outputs:
  workspace/materials/orders.csv
  workspace/materials/customers.csv
  workspace/materials/products.csv
  verify/reference/deliverables/merged.csv
  verify/reference/deliverables/data-quality.md
  verify/expected-data-02.json

The cleaning pipeline implemented here is the intended reference solution; all
counts and spot-check values are computed with pandas and cross-checked with
Decimal arithmetic before being emitted.
"""
from datetime import datetime, timedelta
from decimal import Decimal
import csv
import json
import random
import re
from pathlib import Path

import pandas as pd

CASE = Path(__file__).resolve().parent.parent
MAT = CASE / "workspace" / "materials"
REF = CASE / "verify" / "reference" / "deliverables"
VERIFY = CASE / "verify"

SURNAMES = "张王李赵刘陈杨黄周吴徐孙马朱胡郭何高林罗"
GIVEN = ["伟", "敏", "静", "磊", "洋", "勇", "艳", "杰", "涛", "明",
         "超", "霞", "平", "刚", "丽", "强", "军", "芳", "娜", "辉"]
CITIES = ["上海", "北京", "深圳", "杭州", "成都", "武汉", "南京", "苏州"]
CATEGORY_PRODUCTS = {
    "办公设备": ["激光打印机", "碎纸机", "投影仪", "会议平板", "扫描仪", "显示器"],
    "打印耗材": ["硒鼓", "墨盒", "打印纸", "碳粉", "色带", "标签纸"],
    "软件服务": ["协同办公套餐", "云盘扩容", "安全审计服务", "数据备份服务", "在线培训", "虚拟专用网络服务"],
    "配件": ["键鼠套装", "扩展坞", "电源适配器", "网线", "收纳箱", "摄像头", "台式机"],
}

N_CUSTOMERS = 40
N_PRODUCTS = 25
N_UNIQUE_ORDERS = 300
N_DUPLICATES = 12
N_BLANK_ORDER = 8
N_ROWS = N_UNIQUE_ORDERS + N_DUPLICATES + N_BLANK_ORDER  # 320

DATE_KINDS = [0, 1, 2, 3]  # 0: YYYY-MM-DD, 1: MM/DD/YYYY, 2: YYYYMMDD, 3: YYYY/M/D

# canonical rows whose foreign keys are broken (dropped at step 4)
BLANK_CUSTOMER = [3, 17, 29, 44, 58, 71, 86, 93, 120]
UNKNOWN_CUSTOMER = [40, 77, 110, 150, 199]
BLANK_PRODUCT = [12, 53, 88, 130, 166, 204, 241]
UNKNOWN_PRODUCT = [60, 97, 143, 188]
INVALID_INDEXES = set(BLANK_CUSTOMER + UNKNOWN_CUSTOMER + BLANK_PRODUCT + UNKNOWN_PRODUCT)
# duplicate order ids: canonical row is replaced by a later row (keep latest)
DUP_INDEXES = [5, 24, 39, 66, 90, 118, 142, 175, 208, 230, 262, 288]
assert len(INVALID_INDEXES) == 25 and len(DUP_INDEXES) == 12
assert not (set(DUP_INDEXES) & INVALID_INDEXES)


def fmt2(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01')):.2f}"


def format_date(day, kind: int) -> str:
    if kind == 0:
        return day.strftime("%Y-%m-%d")
    if kind == 1:
        return day.strftime("%m/%d/%Y")
    if kind == 2:
        return day.strftime("%Y%m%d")
    return f"{day.year}/{day.month}/{day.day}"


def parse_date(text: str) -> str:
    """Reference parser for the four allowed order_date formats."""
    text = text.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return datetime.strptime(text, "%Y-%m-%d").strftime("%Y-%m-%d")
    if re.fullmatch(r"\d{2}/\d{2}/\d{4}", text):
        return datetime.strptime(text, "%m/%d/%Y").strftime("%Y-%m-%d")
    if re.fullmatch(r"\d{8}", text):
        return datetime.strptime(text, "%Y%m%d").strftime("%Y-%m-%d")
    if re.fullmatch(r"\d{4}/\d{1,2}/\d{1,2}", text):
        year, month, day = (int(part) for part in text.split("/"))
        return datetime(year, month, day).strftime("%Y-%m-%d")
    raise ValueError(f"unsupported order_date: {text!r}")


def build_materials() -> tuple[dict, dict, dict]:
    rng = random.Random(20261103)

    customers = []
    for i in range(N_CUSTOMERS):
        customers.append(
            {
                "customer_id": f"C{i + 1:03d}",
                "customer_name": f"{SURNAMES[i % len(SURNAMES)]}{GIVEN[(i * 7) % len(GIVEN)]}",
                "city": CITIES[i % len(CITIES)],
                "signup_date": f"2025-{((i * 5) % 12) + 1:02d}-{((i * 3) % 27) + 1:02d}",
            }
        )

    products = []
    flat = [(category, name) for category, names in CATEGORY_PRODUCTS.items() for name in names]
    for i in range(N_PRODUCTS):
        category, name = flat[i]
        products.append(
            {
                "product_id": f"P{i + 1:02d}",
                "product_name": name,
                "category": category,
                "unit_price": f"{Decimal(str(round(rng.uniform(15, 2500), 2))):.2f}",
            }
        )
    prod_price = {row["product_id"]: row["unit_price"] for row in products}

    start = datetime(2026, 1, 1)
    canonical = []
    kept_date_kind = {}
    for i in range(N_UNIQUE_ORDERS):
        order_id = f"O{i + 1:04d}"
        day = start + timedelta(days=rng.randrange(0, 90))
        kind = DATE_KINDS[i % 4]
        kept_date_kind[order_id] = kind
        updated = datetime(2026, 1, 1, 8, 0, 0) + timedelta(minutes=rng.randrange(0, 60 * 24 * 90))
        row = {
            "order_id": order_id,
            "order_date": format_date(day, kind),
            "customer_id": f"C{rng.randrange(1, N_CUSTOMERS + 1):03d}",
            "product_id": f"P{rng.randrange(1, N_PRODUCTS + 1):02d}",
            "quantity": str(rng.randrange(1, 21)),
            "updated_at": updated.strftime("%Y-%m-%d %H:%M:%S"),
        }
        if i in BLANK_CUSTOMER:
            row["customer_id"] = ""
        elif i in UNKNOWN_CUSTOMER:
            row["customer_id"] = f"C9{rng.randrange(10, 99):02d}"
        if i in BLANK_PRODUCT:
            row["product_id"] = ""
        elif i in UNKNOWN_PRODUCT:
            row["product_id"] = f"P9{rng.randrange(10, 99):02d}"
        canonical.append(row)

    duplicates = []
    for offset, index in enumerate(DUP_INDEXES):
        base = canonical[index]
        later = datetime.strptime(base["updated_at"], "%Y-%m-%d %H:%M:%S") + timedelta(
            hours=6 + offset, minutes=7 * offset
        )
        day = start + timedelta(days=rng.randrange(0, 90))
        kind = DATE_KINDS[(index + 1) % 4]
        kept_date_kind[base["order_id"]] = kind
        duplicates.append(
            {
                "order_id": base["order_id"],
                "order_date": format_date(day, kind),
                "customer_id": f"C{rng.randrange(1, N_CUSTOMERS + 1):03d}",
                "product_id": f"P{rng.randrange(1, N_PRODUCTS + 1):02d}",
                "quantity": str(rng.randrange(1, 21)),
                "updated_at": later.strftime("%Y-%m-%d %H:%M:%S"),
            }
        )

    blank_rows = []
    for i in range(N_BLANK_ORDER):
        day = start + timedelta(days=rng.randrange(0, 90))
        blank_rows.append(
            {
                "order_id": "",
                "order_date": format_date(day, DATE_KINDS[i % 4]),
                "customer_id": f"C{rng.randrange(1, N_CUSTOMERS + 1):03d}",
                "product_id": f"P{rng.randrange(1, N_PRODUCTS + 1):02d}",
                "quantity": str(rng.randrange(1, 21)),
                "updated_at": (start + timedelta(minutes=rng.randrange(0, 1000))).strftime(
                    "%Y-%m-%d %H:%M:%S"
                ),
            }
        )

    all_rows = canonical + duplicates + blank_rows
    rng.shuffle(all_rows)

    MAT.mkdir(parents=True, exist_ok=True)
    with (MAT / "orders.csv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=["order_id", "order_date", "customer_id", "product_id", "quantity", "updated_at"],
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(all_rows)
    with (MAT / "customers.csv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=["customer_id", "customer_name", "city", "signup_date"], lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(customers)
    with (MAT / "products.csv").open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=["product_id", "product_name", "category", "unit_price"], lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(products)

    return kept_date_kind, prod_price, {"customers": len(customers), "products": len(products)}


def clean_and_merge(kept_date_kind: dict, prod_price: dict) -> dict:
    raw = pd.read_csv(MAT / "orders.csv", dtype=str, keep_default_na=False)
    customers = pd.read_csv(MAT / "customers.csv", dtype=str, keep_default_na=False)
    products = pd.read_csv(MAT / "products.csv", dtype=str, keep_default_na=False)

    n_raw = len(raw)
    with_order_id = raw[raw["order_id"].str.strip() != ""].copy()
    n_blank_order_id = n_raw - len(with_order_id)

    with_order_id["_updated"] = pd.to_datetime(with_order_id["updated_at"], format="%Y-%m-%d %H:%M:%S")
    deduped = (
        with_order_id.sort_values("_updated").drop_duplicates(subset=["order_id"], keep="last").copy()
    )
    n_duplicate = len(with_order_id) - len(deduped)

    # pandas cross-check of the hand-written date parser with mixed-format parsing
    parsed_reference = deduped["order_date"].map(parse_date).reset_index(drop=True)
    parsed_pandas = (
        pd.to_datetime(deduped["order_date"], format="mixed", dayfirst=False)
        .dt.strftime("%Y-%m-%d")
        .reset_index(drop=True)
    )
    bad = parsed_reference[parsed_reference != parsed_pandas]
    assert bad.empty, f"date parsers disagree: {list(zip(bad.index, bad, parsed_pandas[bad.index]))[:3]}"

    deduped["order_date"] = parsed_reference.values
    deduped["customer_id"] = deduped["customer_id"].str.strip()
    deduped["product_id"] = deduped["product_id"].str.strip()
    deduped["quantity"] = deduped["quantity"].astype(int)

    merged = deduped.merge(customers, on="customer_id", how="left", validate="many_to_one")
    n_missing_customer = int(merged["customer_name"].isna().sum())
    merged = merged[merged["customer_name"].notna()].copy()
    merged = merged.merge(products, on="product_id", how="left", validate="many_to_one")
    n_missing_product = int(merged["product_name"].isna().sum())
    merged = merged[merged["product_name"].notna()].copy()

    n_invalid_fk = n_missing_customer + n_missing_product
    merged["unit_price"] = merged["unit_price"].map(lambda value: Decimal(value))
    merged["total_amount"] = [
        fmt2(Decimal(int(q)) * price)
        for q, price in zip(merged["quantity"], merged["unit_price"])
    ]
    merged["unit_price"] = merged["unit_price"].map(fmt2)
    merged["total_amount_decimal"] = merged["total_amount"].map(Decimal)
    merged = merged.sort_values("order_id").reset_index(drop=True)

    assert len(merged) == n_raw - n_blank_order_id - n_duplicate - n_invalid_fk
    assert merged["order_id"].is_unique

    REF.mkdir(parents=True, exist_ok=True)
    out_cols = [
        "order_id",
        "order_date",
        "customer_id",
        "customer_name",
        "product_id",
        "product_name",
        "category",
        "quantity",
        "unit_price",
        "total_amount",
    ]
    merged[out_cols].to_csv(REF / "merged.csv", index=False, encoding="utf-8", lineterminator="\n")

    # Decimal cross-check that pandas-written text round-trips to the same cents.
    check = pd.read_csv(REF / "merged.csv", dtype=str, keep_default_na=False)
    assert len(check) == len(merged)
    for expected, actual in zip(merged["total_amount"], check["total_amount"]):
        assert fmt2(Decimal(expected)) == fmt2(Decimal(actual))

    def row_of(order_id: str) -> dict:
        row = merged[merged["order_id"] == order_id].iloc[0]
        return {
            "order_id": order_id,
            "order_date": row["order_date"],
            "customer_name": row["customer_name"],
            "total_amount": fmt2(Decimal(row["total_amount"])),
        }

    # spot checks: one row for each normalized date-format family + two rows
    # resolved through the keep-latest dedupe rule.
    spot_ids = []
    for kind in DATE_KINDS:
        candidates = [
            order_id
            for order_id in merged["order_id"]
            if kept_date_kind.get(order_id) == kind
        ]
        spot_ids.append(candidates[0])
    for index in DUP_INDEXES:
        spot_ids.append(f"O{index + 1:04d}")
    spot_checks = [row_of(order_id) for order_id in dict.fromkeys(spot_ids)]

    summary = {
        "inputRows": n_raw,
        "blankOrderIdRows": n_blank_order_id,
        "duplicateRows": n_duplicate,
        "invalidForeignKeyRows": n_invalid_fk,
        "missingCustomerRows": n_missing_customer,
        "missingProductRows": n_missing_product,
        "finalRows": len(merged),
        "spotChecks": spot_checks,
    }
    return summary


def write_quality_report(summary: dict) -> None:
    text = f"""# 数据质量报告

## 处理概览

| 项目 | 行数 |
| --- | --- |
| orders.csv 原始行数 | {summary['inputRows']} |
| order_id 为空而剔除 | {summary['blankOrderIdRows']} |
| order_id 重复而移除（保留 updated_at 最新一行） | {summary['duplicateRows']} |
| customer_id / product_id 缺失或无法关联（无效外键）而剔除 | {summary['invalidForeignKeyRows']} |
| 清洗合并后最终行数 | {summary['finalRows']} |

## 剔除原因说明

1. `order_id` 为空白的记录无法标识订单，直接剔除 {summary['blankOrderIdRows']} 行。
2. 同一 `order_id` 出现多次时，按 `updated_at` 保留最新的一条，其余 {summary['duplicateRows']} 行移除。
3. `customer_id` 为空或在 customers.csv 中不存在（{summary['missingCustomerRows']} 行）、`product_id` 为空或在 products.csv 中不存在（{summary['missingProductRows']} 行），合计 {summary['invalidForeignKeyRows']} 行；这类记录无法关联客户或商品主数据，无法计算可靠的成交金额，因此剔除。

## 统一规则

- `order_date` 的四种输入格式（YYYY-MM-DD、MM/DD/YYYY、YYYYMMDD、YYYY/M/D）已统一为 YYYY-MM-DD。
- `unit_price` 取自 products.csv，`total_amount = quantity × unit_price`，四舍五入保留两位小数。
- 输出按 `order_id` 升序排列，共 {summary['finalRows']} 行。

## 数据校验

- 原始 {summary['inputRows']} 行 = order_id 为空 {summary['blankOrderIdRows']} 行 + 重复移除 {summary['duplicateRows']} 行 + 无效外键 {summary['invalidForeignKeyRows']} 行 + 最终 {summary['finalRows']} 行。
"""
    (REF / "data-quality.md").write_text(text, encoding="utf-8", newline="\n")


def main() -> None:
    kept_date_kind, prod_price, meta = build_materials()
    summary = clean_and_merge(kept_date_kind, prod_price)
    write_quality_report(summary)
    payload = {"case": "data-02-clean-merge", **meta, **summary}
    (VERIFY / "expected-data-02.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    for name in ("orders.csv", "customers.csv", "products.csv"):
        print(name, (MAT / name).stat().st_size)
    for name in ("merged.csv", "data-quality.md"):
        print(name, (REF / name).stat().st_size)


if __name__ == "__main__":
    main()
