---
status: accepted
---

# 保证级别取"实用一致"，不追求强一致

绕过路径调研（见 `docs/research-bypass-paths.md`）确认：glob/read_image 与编码无关；grep 由独立 ripgrep 进程直读磁盘（ASCII 模式仍可命中 GBK 文件）；shell 通道进程外无法透明拦截。若追求所有模型可见通道字节级强一致，必须在搜索型操作前对搜索范围内全部文本文件做原地转码——mtime 噪声、git 工作区污染与观察策略失配的代价远超收益。决定采用"实用一致"：read/write/edit 完全正确；其余通道保证 ASCII 可命中 + 提示词指导 + read 自愈，另提供编码感知的显式工具（eb_grep / eb_peek / eb_convert）补位。

## Considered Options

- **强一致**（拒绝）：搜索前大面积原地改写磁盘，违背最小惊讶。
- **检测式警告**（拒绝）：多一轮模型往返，收益低于 read 自愈。

## Consequences

- grep 对非 ASCII 模式在旧编码文件上漏配是已知边界，由 eb_grep 补位。
- shell 读文件为文档化边界，由 eb_peek 与提示词指导补位。
- >5MB（后续放宽至 50MB 流式）以上的自动转换豁免由 eb_convert 显式补位。
