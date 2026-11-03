# 数据质量报告

## 处理概览

| 项目 | 行数 |
| --- | --- |
| orders.csv 原始行数 | 320 |
| order_id 为空而剔除 | 8 |
| order_id 重复而移除（保留 updated_at 最新一行） | 12 |
| customer_id / product_id 缺失或无法关联（无效外键）而剔除 | 25 |
| 清洗合并后最终行数 | 275 |

## 剔除原因说明

1. `order_id` 为空白的记录无法标识订单，直接剔除 8 行。
2. 同一 `order_id` 出现多次时，按 `updated_at` 保留最新的一条，其余 12 行移除。
3. `customer_id` 为空或在 customers.csv 中不存在（14 行）、`product_id` 为空或在 products.csv 中不存在（11 行），合计 25 行；这类记录无法关联客户或商品主数据，无法计算可靠的成交金额，因此剔除。

## 统一规则

- `order_date` 的四种输入格式（YYYY-MM-DD、MM/DD/YYYY、YYYYMMDD、YYYY/M/D）已统一为 YYYY-MM-DD。
- `unit_price` 取自 products.csv，`total_amount = quantity × unit_price`，四舍五入保留两位小数。
- 输出按 `order_id` 升序排列，共 275 行。

## 数据校验

- 原始 320 行 = order_id 为空 8 行 + 重复移除 12 行 + 无效外键 25 行 + 最终 275 行。
