# dsh-encoding-guard

文件编码守卫——DSH 内置 `read` / `write` / `edit` 工具的透明 UTF-8 no BOM 转码桥。

## 解决什么问题

内置文件工具只认 UTF-8 文本：GBK/GB18030、UTF-16、带 BOM 的文件要么读出来乱码、要么被 `FS_NOT_TEXT` 拒绝；直接编辑又会把文件悄悄改成 UTF-8，破坏原编码约定。本插件在工具执行层做透明桥接，磁盘上的文件编码最终保持原样。

## 行为

1. **读取前**（`read` 工具触发）：检测磁盘文件编码；非 UTF-8 no BOM（`utf8-bom` / `gb18030`(含 GBK) / `utf16le` / `utf16be`，带或不带 BOM）时先把文件原地转为 UTF-8 no BOM（**字符序列与行尾完全不变**），官方 `read` 因此总能读到正确文本。
2. **编写前**（`write` / `edit` 工具触发）：同样先转 UTF-8 no BOM，官方工具正常读写；**编写后不立即恢复**——会话期间文件保持 UTF-8 no BOM，保证 read-before-write 版本守卫（`FsVersion` 含 size/mtimeNs）全程一致，连续编辑不会被 `FS_STALE_VERSION` 打断。
3. **轮次结束恢复**（`agent/turn-stopping`）：把本轮会话账本中的文件恢复为原编码（当前内容重新编码，字符序列不变）。下一轮若继续编辑同一文件，插件会再次转为 UTF-8 no BOM；首个 `edit` 可能因版本过期被拒，re-read 一次即自愈。
4. **会话结束兜底**（`session/disposed`）与**插件卸载兜底**（fiber dispose）：漏恢复的一律恢复。
5. **新建文件**（`write` 落地不存在的路径）：UTF-8 no BOM 且行尾 LF（内容含 CRLF 时自动归一）。

## 恢复语义

- 恢复 = 把当前 UTF-8 内容重新编码为原编码。GB18030 覆盖全部 Unicode（含 emoji），中文场景实质无损；行尾在往返转换中保持不变（需求：文本内容样式不能改变）。
- 文件被删除/外部改动：账本自动清空，不产生副作用。
- 极端编码失败（如孤立代理对）：保留 UTF-8 并在账本标记 `restoreFailed`，可用 `eb_status` 查询、人工处理。
- 原文件是 GBK 而编辑后新增了 GBK 区外字符（如 emoji）：恢复为 GB18030 四字节序列（唯一无损选择），严格 GBK-only 的旧工具可能读不了该字符。

## 模型面工具

| 工具 | 说明 |
|---|---|
| `eb_status` | 查看账本：待恢复原编码的文件清单（原编码 / 所属会话 / 失败原因）。 |
| `eb_restore` | 立即恢复（缺省全部；可指定单个 `file_path`）。 |

## 已知边界

- **只拦截工具面**：模型通过 `pwsh`/`bash` 直接操作文件的编码不受管理。
- **node:fs 直写**：转换/恢复写回非 UTF-8 字节（`ctx.fs.writeText` 做不到），因此绕过 fs 沙箱；danger-full-access 部署无影响。
- **大小上限**：超过 5 MiB 的文件不做检测转换（防误伤大文件）。
- **二进制扩展名黑名单**：png/zip/exe 等直接放行。
- **多会话同文件**：账本按首个转换的会话归属；轮次结束恢复后另一会话再次触达会重新转换并自愈。
- **宿主强杀**：dispose 兜底是尽力而为；异常退出后文件可能停留在 UTF-8 no BOM，用 `eb_restore` 或手动转回。

## 构建与安装

```bash
npm install                 # 安装 typescript / @types/node / iconv-lite
npm run build               # bash scripts/build.sh；Windows 无 bash 时按其逻辑手动 junction + tsc
# DSH_CHECKOUT 可指向源码 checkout 或 npm 安装的 @deepseek-ai/dsh
dsh plugin --profile web add F:/dsh-encoding-guard   # 本地目录安装（pnpm 解析为 link:，改代码即时生效）
dsh --profile web --dump-config                       # 验证：组合树出现 id: encoding-guard 行
```

原理：`package.json` 声明 `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`，`cordis.patch.yml` 以
`insert` 把插件挂进组合树；`dsh plugin add` 安装后自动把包名追加进 `dsh.profile.bundles`。
裸包名从 profile 目录解析（pnpm hoisted 的 `iconv-lite` + `~/.dsh/profiles/node_modules` 兜底的
`@deepseek-ai/dsh-tools`）。重新打包分发时 `files` 白名单必须包含 `cordis.patch.yml`，否则
bundle 层加载会因缺失 patch 文件而 fail loud。安装后需重启对应 profile 才生效。

## 测试

```bash
node --test test/encoding.test.mjs   # 编码检测与字节级 round-trip
```
