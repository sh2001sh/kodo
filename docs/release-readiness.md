# 本地发布演练

项目采用 MIT 许可证（版权主体 CodeGo AI）。公开包名、官网和反馈地址由维护者另行提供；当前没有发布 npm 包，也没有部署网站。不能把本地演练通过等同于公开发布完成。

先运行 `npm run build`，再运行：

```powershell
node 'scripts/verify-installation.mjs'
```

脚本从实际 npm tarball 开始，在操作系统临时目录内使用隔离的安装前缀，执行生产依赖安装、CLI 版本、可执行入口、原生 SQLite 和存储诊断，然后升级、回退。不会修改用户的全局安装，也不会发布包。默认使用当前候选 tarball 和明确标注的合成旧版本；这验证安装替换机制，不代表两个历史正式版本已经兼容。

已有两个发布候选归档时，使用真实版本演练：

```powershell
node 'scripts/verify-installation.mjs' --candidate 'C:\releases\candidate.tgz' --previous 'C:\releases\previous.tgz'
```

两个归档必须具有相同包名、不同版本并包含 MIT 许可证。旧版→新版→旧版共用同一个本地存储目录，可发现不可回退的存储变化。演练需要 Node.js 24、npm、tar，以及能够安装生产依赖的网络或 npm 缓存；安装脚本失败会使演练失败。资源目录和安装前缀仅在该临时目录内创建与删除。

发布前仍需维护者确定包名和公开地址，并进行 npm 名称可用性、账号权限及实际注册表安装验证。许可证、可打包文件和本地演练入口已具备；公开地址不得使用虚构链接填充。

Windows／Node.js 24 本地真实执行的原始输出：

```text
PASS clean production install: kodo-local@0.0.0-installation-fixture; CLI version, bin, production native SQLite, storage doctor
PASS upgrade: kodo-local@0.1.0-alpha.0; CLI version, bin, production native SQLite, storage doctor
PASS rollback: kodo-local@0.0.0-installation-fixture; CLI version, bin, production native SQLite, storage doctor
PASS installation rehearsal (synthetic previous-version packaging fixture); isolated prefix only; no registry publish
```

这里的两个版本都源自当前实现，只是归档版本不同；证明了生产安装、版本替换、共用存储与回退机制。真实历史版本间的行为和数据迁移兼容性，需要提供相应发布归档后再执行第二种命令。
