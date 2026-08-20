# dsh-encoding-guard

DSH 插件：内置 read/write/edit 的转换桥 + `eb_*` 补位工具族。

## 文档地图

- **CONTEXT.md** — 术语表（转换桥 / 账本 / 自愈 / 会话视图 / 绕过 / 实用一致）。判定保障边界、给新概念起名时读。
- **docs/adr/** — 已接受的架构决策（0001 实用一致；0002 轮末恢复 + 自愈；0003 `eb_*` 语义）。改恢复时机、补位工具语义、承诺级别前，先读对应篇的 Consequences。
- **README.md** — 用户可见行为、通道边界表、安装方式。改动行为后按它逐条核对。

## 改动流程

改 `src/` 后依次过闸，每步判据达成才进下一步：

1. `npm run build`：编译 src → lib，重建 peer 依赖 junction。判据：tsc 零错误退出。
2. `npm test`：测试 import 的是 `lib/` 编译产物，先 build 后 test——跳过 build 测的是旧代码。判据：三套 `test/*.test.mjs` 全部通过。新测试按层落位：编码检测 → `encoding`，磁盘桥/流式转换 → `bridge`，端到端往返 → `e2e`。
3. 挂点改动（`src/index.ts`：tools/execute 拦截、事件恢复、工具注册）额外在线验证——自动化测试覆盖不到它。已注入环境用 `dev_reload_package {"packageName":"dsh-encoding-guard"}` 热重载，用 GBK/BOM 样本文件走 read → edit，等轮次结束。判据：磁盘回原编码、`eb_status` 账本为空、host 日志出现"轮次结束恢复"。
4. 行为或边界有变：同步 README.md 的行为清单与边界表。判据：README 每条与实际行为一致。

发布：`package.json` 版本 +1 → `dev_build_plugin` 出 tgz → `dev_release_plugin`（等价于 `npm pack` + `gh release create`）。判据：GitHub Release 出现新版本与 tgz 附件。

## 坑位

- `ctx.effect(() => ctx.tools.register(def), 'label')`：label 是 effect 的第二参，register 只收一个工具定义。
- defineTool 参数 `required` 只接受 true；可省字段直接省略。
- `ctx.fs` 类型靠 `import type {} from '@deepseek-ai/dsh-fs'` 模块增强提供，删这行类型即丢。
- 编译产物为 ESM，`__dirname` 取不到；定位插件目录文件用 `import.meta.url` + `new URL()`。
- agent 事件 payload 自动附带 `agent` 字段；`session/disposed` 回调参数直接是 sessionId 字符串。
- 恢复一律 `restoreAll()` 账本全集；按 sessionId 过滤在多会话同文件场景会漏恢复（ADR 0002）。
- `scripts/build.sh` 幂等：junction 断链或丢失，重跑即重建。

## Agent skills

### Issue tracker

GitHub Issues（andimial/dsh-encoding-guard），经 `gh` CLI 读写。See `docs/agents/issue-tracker.md`.

### Triage labels

默认五角色标签（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文：根 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
