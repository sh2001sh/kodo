# sub-01-parallel-vendor-review 评分说明

- `stage/check-review.mjs`：held-out 验收脚本，运行后复制到 `workspace/_verify/` 执行。核对四家供应商的最终总价、交付周期、SLA、数据驻留、是否满足判断，`## 推荐` 必须推荐星衡科技，`review.md` 每家一个小节且带逐字引文与来源路径。
- `reference/`：一份满分参考交付物（不进入模型工作区）。
- `negative-controls.mjs`：参考交付物必须通过，10 个陷阱变异（作废报价 128、B 不含运维、C 只算一期、D 判为境内、推荐错误供应商、复核缺小节/缺引文等）必须全部被拒。
- rubric 的 `S01 run-shape` 要求至少 4 个完成的子运行：主 Agent 不派生子 Agent、自己做完会被判不合格。这正是阶段 1 删减协作子系统时需要守住的行为。
