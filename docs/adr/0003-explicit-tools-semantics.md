---
status: accepted
---

# 补位工具族语义：内存解码读路径；eb_convert 进账本且可选持久转换

绕过补位工具族（eb_grep / eb_peek / eb_convert，见 ADR 0001）不写磁盘、不进账本：走"读字节 → 检测 → 解码 → 返回"的内存解码。被拒方案是复用磁盘转换桥（ensureUtf8NoBom）——一次 grep 扇出会临时改写大量文件，恢复窗口内 git/IDE/同步盘都观察到假状态，违背最小惊讶；代价是与磁盘桥并存两套读路径，可接受，因为 write/edit 语义仍由磁盘桥独占保证。

eb_convert（显式转换大文件）默认遵循会话视图：转换进账本、轮末恢复原编码；`persist: true` 时不进账本、轮末不恢复——文件从此就是 UTF-8 no BOM（迁移语义，显式承担后果）。

## Consequences

- eb_grep / eb_peek 对磁盘零副作用，可与并行工具调用安全并发。
- eb_convert 存在两种结果形态，使用者必须意识到默认会"转回去"；需要永久迁移时显式传 persist。
- 与磁盘桥的两套读路径意味着 read（磁盘桥）与 eb_peek（内存）对同一文件返回的字符序列一致，但 mtime 副作用不同——这是设计差异，不是缺陷。
