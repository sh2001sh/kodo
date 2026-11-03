# 从描述或历史任务创建 Agent

`kodo agent create` 用自然语言生成 Agent 草稿，不需要手写 `AGENT.md`。`kodo agent save` 使用本地已完成运行的实际工具证据提炼做法。两者只生成待审阅的能力包源文件，不注册工具、不执行生成代码、不自动启用或采用版本。

```sh
kodo agent create "检查源码中的技术陈述，给出证据，并标明无法确认的部分" \
  --id local/source-review --version 0.1.0 --output ./source-review \
  --source-url https://example.org/my-project --license MIT \
  --tools file.read,file.list,file.search --archive ./source-review.zip

kodo agent save RUN_ID --session SESSION_ID \
  --description "可复用的源码审查方法" --id local/source-review \
  --version 0.2.0 --output ./source-review-v2 \
  --source-url https://example.org/my-project --archive ./source-review-v2.zip
```

示例 URL 需要替换为能力包真实来源。输出目录的父目录必须已经存在，输出目录本身必须不存在。每次修改使用新版本和新目录，已有文件与 ZIP 不会被覆盖。

模型配置沿用 `KODO_MODEL`、`KODO_BASE_URL`、`KODO_PROTOCOL`、`KODO_API_KEY` 或 `OPENAI_API_KEY`，也可通过 `--model`、`--base-url`、`--protocol`、`--api-key-env` 显式指定。创建和保存各调用一次模型；工具调用被禁止，响应必须通过严格 JSON 结构、能力白名单和私密内容检查。模型出错、返回无效结构或请求额外工具时直接失败，不会悄悄切换到模板。

没有模型时，可以显式使用 `agent create ... --template` 生成离线起步模板。模板明确写明没有分析历史运行，也没有验证通用方法；`agent save` 不接受模板模式。草稿包含输入要求、具体步骤、验收检查及宿主权限边界，尚不能证明换输入后仍然有效。应通过任务案例运行和新旧版本比较后再采用。

产物是 `AGENT.md` 和 `declaration.json`；声明只将 `AGENT.md` 列为可分发文件，不附带本地状态或原始任务记录。可通过 `--archive` 直接生成 ZIP，或复用现有导出入口：

```sh
kodo package export ./source-review --manifest ./source-review/declaration.json --output ./source-review.zip
kodo package inspect ./source-review.zip
kodo package import ./source-review.zip
```

当前作者入口生成仅含方法提示的能力包，可以引用原生工具及包系统支持的内核能力。它不会凭空生成自定义工具实现、技能或 MCP 配置；引用未随包提供的宿主扩展会在写入前拒绝。卡片列出的工具也不构成运行时执行或写入授权。

## 行为提醒

行为提醒默认关闭。需要在连续读取、尚未开始修改或执行命令时收到一次进度建议，可在 `AGENT.md` 的 YAML 顶层显式设置：

```yaml
nudges: true
```

省略该字段或设置 `nudges: false` 均不发送这类提醒。提醒使用带来源标记的运行时附件，不作为用户新指令，也不会改变工具或写入权限。交付物检查、调用错误、重复读取诊断仍按各自契约运行。旧的宿主 `exploreNudge` 显式开关保留兼容，用于独立控制委派建议，默认同样关闭。

## 保存临时配置

子代理用 `configuration` 临时组合过方法与工具后，可以把这次实际使用的配置保存为新卡片版本，不调用模型：

```sh
kodo agent save-config CHILD_RUN_ID --session SESSION_ID \
  --id local/pager-review --version 0.1.0 --output ./pager-review \
  --source-url https://example.org/my-project --archive ./pager-review.zip
```

卡片内容就是记录在该运行上的提示与工具集合，因此导入新环境后按同一方法和工具运行。规则：

- 只接受本会话中已完成、且使用了临时配置的运行；直接使用注册卡片的运行已有可导出版本，会被拒绝。
- 带 Skill 或宿主扩展工具的配置会被拒绝，不会悄悄去掉；这类依赖需作为能力包资源打包。
- 工作目录、状态目录、环境凭据和 `privateValues` 中的值出现在方法里时直接失败，不做替换。
- 基底卡片、来源运行与验收状态只出现在本地返回的 `origin` 中（`evidence: single-run`），不写入分发卡片。卡片正文注明一次运行只是单次证据。
- 输出目录和版本不覆盖；修改使用新版本。嵌入宿主可直接调用 `saveConfigurationDraft`，再交给 `writeAgentDraft`。

嵌入宿主可以使用 `createAgentDraft`、`saveAgentMethod` 和 `writeAgentDraft`。前两个返回未激活的结构化草稿，后者要求显式来源和许可证并排他写入新目录。`saveAgentMethod` 必须指定授权会话，拒绝其他会话或未完成运行；证据包含原有验收状态，`completed` 不会被当作质量通过。最多读取前 100 个调用，每项请求、结果及总证据都有限额，截断会在返回元数据中明确标记。

保存前会去除工作目录、状态目录、已知环境凭据、可识别密钥、绝对路径及工具请求中的本次文件名。宿主可以通过 `privateValues` 补充客户名、标识符等任务专属内容；这些值会在调用模型前替换，并禁止出现在生成草稿中。这是有明确匹配范围的过滤，无法识别任意个人信息或判断所有语义上的过度拟合；发布前仍需审阅草稿，运行不同输入的案例。源运行标识和验收状态只存在于本地返回元数据，不写进分发卡片。
