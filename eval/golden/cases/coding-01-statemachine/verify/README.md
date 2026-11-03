# coding-01-statemachine 验收资产

- `stage/test_state_data_scoping.py`：从任务规格编写的基础层 held-out 验收用例。模型不可见；评分时复制到运行工作区的 `_verify/`。
- `stage/run_acceptance.py`：运行上面的用例并写 `_verify/acceptance.json`（`tests.<name>: true/false`），rubric 用 `json-values` 读取。
- `case.json.grading.restore = ["tests", "conftest.py"]`：评分前用样例工作区的原始文件覆盖运行工作区里的 `tests/` 与 `conftest.py`，防止改测试作弊，同时保证既有测试是新代码下的回归。
- `R1` 跑 5 个既有测试文件（115 条）作为“旧行为不翻转”的硬规则。
- `R2` 校验 `tests/` 与 `conftest.py` 未被修改。

自检记录（2026-11-03，未实现该特性的基线上）：

```text
python -m pytest -o addopts= -p no:cacheprovider tests/test_state.py tests/test_statechart_history.py tests/test_callbacks.py tests/test_statemachine.py tests/test_state_callbacks.py -q
=> 115 passed in 1.18s
python -m pytest -o addopts= -p no:cacheprovider -q _verify/test_state_data_scoping.py
=> 10 failed（全部因 DataVar/get_state_data 等新 API 尚不存在）
```

后续层（未纳入本基线）：层级数据合并与遮蔽、并行区域隔离、history 深/浅恢复、SCXML datamodel 解析、图示标注。
