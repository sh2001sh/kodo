# Kodo 沙箱真实项目预检：2026-10-31

结果：`infra_invalid`，尚未启动模型任务。请求数和模型费用均为 0。真实项目在普通宿主环境通过全套测试，但在当前断网沙箱中失败；子任务快照也被项目已有符号链接阻断。因此本次不能产生模型任务墙钟、费用、补丁质量或委派加速结论。

任务沿用 Frontier Harness Eval 的 `python-statemachine-state-data-scoping`，基线提交为 `8d17ba9f6ba8420cf05fddb94013bc221ed9a222`。预检只运行项目原有测试，没有修改项目源码或测试期待，没有将外部验收内容提供给代理。

## 环境与执行

现有 agent 镜像为 `kodo-frontier-trial-statemachine:20261031`，镜像 ID 保存在 `environment.json`。Docker 默认运行环境没有 bubblewrap，并且普通用户命名空间启动返回 `unshare: unshare failed: Operation not permitted`。没有更改 Docker 权限政策；改用之前验证过的 WSL Ubuntu bubblewrap 后端。

项目与已安装的 Python 包从该 agent 镜像提取。Python 从镜像的 3.12.12 改为 WSL 的 3.12.3，依赖包文件保持来自原镜像。专用运行环境位于 `/usr/local/lib/kodo-statemachine-20261031-r1`，项目位于 `/tmp/kodo-real-statemachine-20261031-r1/app`。虚拟环境的 Python 使用普通可执行文件，避免解析可执行文件符号链接后丢失虚拟环境上下文。

这不是原 Docker 环境的等价性能对照；本次只检查同一 WSL 环境中启用沙箱前后的功能兼容性。预检没有应用正式任务的容器 CPU/内存配额，下面的时长仅为测试原始输出，不用来估算并行收益。

Windows 文件系统直接接收 Docker 项目目录时无法创建符号链接，因此正式输入改为 `original.tar`，在 Linux 解包并保留原有链接。`original-windows-partial` 仅是失败复制的残留，不是实验输入。最终检查项目 Git HEAD 与基线一致，工作区无跟踪或未跟踪改动。

## 原始结果

基础检查 `python -m pytest -n 4 -q tests/test_state.py` 在宿主与沙箱内均为 8 项通过。

全套命令为 `python -m pytest -n 4 -q`：

```text
宿主：
1404 passed, 143 skipped, 44 xfailed in 22.36s

沙箱（network=none）：
39 failed, 883 passed, 143 skipped, 44 xfailed, 279 warnings, 482 errors in 21.90s
```

两个进程都自然退出，没有超时或取消。宿主退出码为 0，沙箱退出码为 1。跳过项和预期失败保留原样，不计为通过。

日志中的重复故障路径是 Python asyncio 初始化事件循环时调用匿名 `socket.socketpair()`，被当前沙箱过滤器拒绝，产生 `PermissionError: [Errno 1] Operation not permitted`。现有 `network=none` 同时禁止 socket、connect、socketpair 与 io_uring 创建。普通 Node 定时子进程能运行，不能证明依赖本地进程通信的异步 Python 项目兼容；这次预检补出了上一轮合成测试没有覆盖的实际限制。

独立的快照预检返回：

```text
EXECUTION_FILE: snapshot supports regular files only: CLAUDE.md
```

原项目中 `CLAUDE.md -> AGENTS.md`。这会阻断快照式子代理启动；检查版本也使用同一份文件清单逻辑。当前代码尚未支持这一输入，不应靠改动项目指令文件掩盖该兼容性问题。

## 后续运行条件

正式模型实验需先解决匿名进程内通信与断网政策的兼容性、快照对项目符号链接的兼容性，并在原项目上重新通过宿主和沙箱的功能预检。外部网络、受保护路径和独立检出边界仍需保留。

全部证据位于 [实验目录](E:/sh/Coding/agent-harness/.kodo/sandbox-real-statemachine-20261031-r1)：

- `preflight-full-host.log`、`preflight-full-sandbox.log`：完整测试输出和错误栈。
- `preflight-results.json`、`preflight-full-results.json`：退出状态、快照失败、模型请求数。
- `environment.json`、`requirements-frozen.txt`、`original.tar`：环境与输入来源。
- `runtime-dist/`：本次真正执行的 Kodo 编译产物。
- `prepare.mjs`、`preflight.mjs`：准备和执行脚本。
- `evidence-sha256.json`：文件校验清单。

没有 relay/SSE 或模型交互日志，因为本轮未启动模型或 relay；这些文件的缺失不是记录失败。本轮没有修改 Kodo 产品代码，没有提交。

## 后续修复与实测（追加，2026-10-31）

r2 已修复匿名 AF_UNIX socketpair 与快照保留有效相对符号链接的兼容性问题，原项目在宿主和断网沙箱内均恢复为 1404 passed、143 skipped、44 xfailed，快照预检通过。之后真实模型任务正常结束，两个子代理完成并集成；独立验收旧行为 1286/1286、新增要求 67/72，reward 为 0。完整结果与限制见 [r2 实测报告](./kodo-sandbox-statemachine-real-20261031-r2.md)。本节不改变以上历史预检结论。
