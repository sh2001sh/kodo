---
id: example/text-statistics
description: 解释文本统计工具的 Unicode、UTF-8、空白分词及换行规则。
---
调用 text.stats 时把原始文本放在 text 字段。

- codePoints 是 Unicode 码点数，使用 JavaScript 字符串迭代器计数；组合字符与表情序列可能包含多个码点。
- utf8Bytes 是原始文本的 UTF-8 字节数。
- whitespaceWords 是非空白片段数，不是中文分词或语言学意义上的词数。
- lines 对空文本为 0；其他文本按 CRLF、单独 CR 或 LF 分隔。末尾换行会增加一个空行。

例如 `alpha beta\nalpha` 的结果为 16 码点、16 UTF-8 字节、3 个非空白片段、2 行。
输入上限是 65,536 UTF-8 字节；超过上限应明确报错，不截断输入。
