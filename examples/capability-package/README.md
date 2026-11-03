# 文本统计能力包

这是无第三方依赖的完整示例：固定入口 `AGENT.md`、按需加载的 Skill、JSON 工具描述、在操作系统沙箱中运行的 JavaScript 工具、来源与许可证、三个可执行验收例子。

从仓库根目录运行：

```powershell
npm run build
node scripts/demo-capability-package.mjs
```

演示会导出真正的 ZIP，分别导入两个独立的本地登记目录，再从第一个登记目录重新导出并校验内容摘要一致。之后显式启用第二个目录的包，运行空输入、ASCII 多行、Unicode 与 CRLF 的验收，最后通过真实执行循环调用工具。没有模型服务和网络依赖。

完整演示需要本机可用的操作系统沙箱。`--archive-only` 只执行无代码加载的归档往返，不代表工具已通过运行验收。输出文件保存在打印的临时目录中。

`declaration.json` 仅用于源目录导出，列明每个允许分发的文件。导出器生成带 SHA-256 与长度的 `CAPABILITY.json`，不会将整个源目录打包。示例 README 与导出声明自身均未声明为分发资源。接受端只需要 ZIP，无需原仓库。

定义、API 与安全边界见 [能力包文档](../../docs/capability-packages.md)。
