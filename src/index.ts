/**
 * dsh-encoding-guard — 文件编码守卫。
 *
 * 对内置 read/write/edit 工具做透明编码桥接：
 *  1. 读取前：磁盘文件非 UTF-8 no BOM（utf8-bom / gb18030 / utf16le / utf16be）时，
 *     先原地把字符内容转码为 UTF-8 no BOM（字符序列与行尾不变），官方 read 因此总能读到文本；
 *  2. 编写前：同样先转 UTF-8 no BOM，官方 write/edit 正常工作；
 *     write 新建文件落地为 UTF-8 no BOM 且行尾 LF；
 *  3. 轮次结束（agent/turn-stopping）：把账本中的文件恢复为原编码；
 *     会话结束（session/disposed）与插件卸载兜底检查，未恢复的一律恢复。
 *
 * 磁盘桥逻辑（检测/转换/账本恢复）在 src/bridge.ts（无 cordis 依赖，可独立测试）；
 * 本文件只做挂点接线与模型面工具。绕过补位工具族（ADR 0001/0003）：
 *  - eb_peek / eb_grep：内存解码只读路径（零磁盘副作用）；
 *  - eb_convert：显式转换（默认进账本轮末恢复；persist:true 持久转换）。
 *
 * 设计要点：
 *  - 转换会改变文件字节 → FsVersion（size/mtimeNs/ctimeNs）随之变化。会话期间文件
 *    保持 UTF-8 no BOM，观察策略（read-before-write 版本守卫）全程一致；恢复发生在
 *    轮次之间，下一轮首个 edit 若版本过期会收到 FS_STALE_VERSION，re-read 即自愈。
 *  - 恢复 = 把当前 UTF-8 内容重新编码为原编码。编辑后引入原编码无法表示的字符时，
 *    iconv-lite 抛错 → 保留 UTF-8 并在账本标记 restoreFailed（eb_status 可查）。
 *  - node:fs 直写绕过 fs 沙箱（恢复需写非 UTF-8 字节，ctx.fs.writeText 做不到）；
 *    danger-full-access 部署下无影响。
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { EncodingLedger } from './ledger.js'
import {
  BINARY_EXTENSIONS,
  IN_MEMORY_LIMIT,
  ensureUtf8OnDisk,
  restoreAll,
  restoreOne,
  peekFile,
  grepFiles,
  convertFile,
} from './bridge.js'

export const name = 'dsh-encoding-guard'
export const inject = ['fs', 'tools', 'systemPrompt']

/** 拦截的目标工具（dsh-tool-fs 的模型面工具名）。 */
const TARGET_TOOLS = new Set(['read', 'write', 'edit'])

export function apply(ctx: Context): void {
  const ledger = new EncodingLedger()

  function log(level: 'info' | 'warn' | 'error', message: string): void {
    try { ctx.logger[level](`[encoding-guard] ${message}`) } catch { /* logger 不可用也静默 */ }
  }

  /** 解析工具参数里的 file_path 为绝对路径（复用 ctx.fs 的会话 cwd 语义）。 */
  async function resolveToolPath(filePath: string, exec: unknown): Promise<string | undefined> {
    const e = exec as { agent?: { session?: { header?: { cwd?: string } } }, signal?: AbortSignal }
    const cwd = e.agent?.session?.header?.cwd
    try {
      const target = await ctx.fs.resolve(filePath, { cwd, signal: e.signal })
      return ctx.fs.processPath(target)
    } catch {
      return undefined // 解析失败：放行给官方工具报错
    }
  }

  function guardConvert(absPath: string, key: string, sessionId: string, signal?: AbortSignal): Promise<void> {
    return ledger.withLock(key, async () => {
      await ensureUtf8OnDisk(absPath, ledger, sessionId).catch((error) => {
        log('warn', `转码失败（放行原文件）：${absPath} — ${String(error)}`)
      })
      void signal
    })
  }

  // ── 核心拦截：tools/execute around-wrapper ────────────────────────────────────
  ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
    if (!TARGET_TOOLS.has(exec?.name)) return next()
    const filePath: unknown = exec.arguments?.file_path
    if (typeof filePath !== 'string' || filePath === '') return next()
    const absPath = await resolveToolPath(filePath, exec)
    if (!absPath) return next()
    if (BINARY_EXTENSIONS.has(path.extname(absPath).toLowerCase())) return next()
    const key = absPath.toLowerCase()
    const sessionId: string = exec.agent?.session?.id ?? 'unknown'

    if (exec.name === 'read') {
      await guardConvert(absPath, key, sessionId, exec.signal)
      return next()
    }

    // write / edit
    let existed = true
    try {
      await fsp.stat(absPath)
    } catch {
      existed = false
    }
    await guardConvert(absPath, key, sessionId, exec.signal)
    const result = await next()
    // 需求 4：write 新建的文件落地为 UTF-8 no BOM + LF 行尾（仅在内容含 CRLF 时归一）
    if (exec.name === 'write' && !existed && result && result.isError !== true) {
      try {
        const bytes = await fsp.readFile(absPath)
        const text = bytes.toString('utf8')
        if (bytes.length <= IN_MEMORY_LIMIT && text.includes('\r\n')) {
          await fsp.writeFile(absPath, Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8'))
        }
      } catch {
        /* 归一失败不影响写结果 */
      }
    }
    return result
  })

  // ── 提示词指导（ADR 0001：grep 非 ASCII 漏配与 shell 旁路的文档化边界） ────────
  ctx.systemPrompt.section({
    name: 'encoding-guard:grep-hint',
    order: 105,
    text: 'grep 由 ripgrep 直读磁盘字节：非 ASCII 模式（如中文关键词）对 GBK/GB18030/UTF-16 等旧编码文件可能漏配。ASCII 模式不受影响。需要跨编码中文检索时改用 eb_grep，或用 read 触达后自愈。',
  })
  ctx.systemPrompt.section({
    name: 'encoding-guard:shell-hint',
    order: 106,
    text: 'shell（pwsh/bash）直接读磁盘原始字节，不经编码桥：旧编码文本文件在 shell 里会乱码。shell 场景需要查看旧编码文件内容时，先用 eb_peek（内存解码，不动磁盘）或 read（透明转码）。',
  })

  // ── 轮次结束：恢复账本文件（serial 事件，await 完成才结束轮次） ──────────────────
  // 已实测验证：不按 sessionId 过滤——单 host 进程内账本即全集；
  // 另一会话再触达同文件会重新转换并自愈，跨会话恢复安全（ADR 0002）。
  ctx.on('agent/turn-stopping', async () => {
    try {
      const report = await restoreAll(ledger)
      if (report.length > 0) log('info', `轮次结束恢复 ${report.length} 个文件`)
    } catch (error) {
      log('warn', `轮次结束恢复失败：${String(error)}`)
    }
  })

  // ── 会话结束：兜底检查（漏恢复的一律恢复） ──────────────────────────────────────
  ctx.on('session/disposed', async () => {
    try {
      const report = await restoreAll(ledger)
      if (report.length > 0) log('info', `会话结束兜底恢复 ${report.length} 个文件`)
    } catch (error) {
      log('warn', `会话结束兜底恢复失败：${String(error)}`)
    }
  })

  // ── 插件卸载：全部恢复（尽力而为；宿主强杀则依赖下次 eb_restore） ────────────────
  ctx.effect(() => () => {
    void restoreAll(ledger).catch((error) => {
      try { console.error('[encoding-guard] unload restore failed:', error) } catch { /* ignore */ }
    })
  })

  // ── 模型面工具（描述保持一行，控制工具目录 prefill 成本） ────────────────────────
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'eb_status',
    description: '编码守卫账本：列出已转为 UTF-8 no BOM、待恢复原编码的文件。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      const list = ledger.list()
      if (list.length === 0) return '账本为空：没有待恢复原编码的文件。'
      return list
        .map((entry) => {
          const failed = entry.restoreFailed ? `（恢复失败：${entry.restoreFailed}）` : ''
          return `- ${entry.path} → ${entry.encoding}${failed}`
        })
        .join('\n')
    },
  })), 'dsh-encoding-guard: eb_status')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'eb_restore',
    description: '立即把账本中的文件恢复为原编码（缺省全部；可指定单个 file_path）。',
    parameters: {
      file_path: { type: 'string', description: '只恢复该文件；缺省恢复全部' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { file_path?: string }) {
      if (args.file_path) {
        const absPath = await resolveToolPath(args.file_path, {})
        if (!absPath) return `ERROR: 无法解析路径 ${args.file_path}`
        const key = absPath.toLowerCase()
        const entry = ledger.get(key)
        if (!entry) return `账本中没有 ${absPath}（未转换过，或已恢复）。`
        const outcome = await ledger.withLock(key, () => restoreOne(ledger, key, entry))
        return `${absPath}: ${outcome}`
      }
      const report = await restoreAll(ledger)
      return report.length > 0 ? report.join('\n') : '账本为空：没有待恢复的文件。'
    },
  })), 'dsh-encoding-guard: eb_restore')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'eb_peek',
    description: '经内存解码读取文本文件（GBK/GB18030/UTF-16 等自动识别；零磁盘副作用，不转码不进账本）。',
    parameters: {
      file_path: { type: 'string', description: '要读取的文件路径', required: true },
      offset: { type: 'number', description: '1-based 起始行，缺省 1' },
      limit: { type: 'number', description: '返回行数上限' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { file_path: string, offset?: number, limit?: number }, exec: unknown) {
      try {
        const absPath = await resolveToolPath(args.file_path, exec)
        if (!absPath) return `ERROR: 无法解析路径 ${args.file_path}`
        const result = await peekFile(absPath, { offset: args.offset, limit: args.limit })
        if (result.encoding === 'binary') return `binary：${absPath}（非文本文件）`
        if (result.encoding === 'empty') return `(empty)：${absPath}`
        const body = result.lines.map((l) => `${String(l.number).padStart(6)}\t${l.text}`).join('\n')
        return `编码: ${result.encoding}（内存解码，磁盘未动）\n${body}`
      } catch (error) {
        return `ERROR: ${String(error)}`
      }
    },
  })), 'dsh-encoding-guard: eb_peek')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'eb_grep',
    description: '内存解码版 grep：跨编码（GBK/GB18030/UTF-16）正则检索，弥补内置 grep 非 ASCII 模式漏配；支持目录与 include 过滤。',
    parameters: {
      pattern: { type: 'string', description: 'JS RegExp 正则（非 ripgrep 语法）', required: true },
      path: { type: 'string', description: '文件或目录；缺省会话工作区' },
      include: { type: 'string', description: '目录遍历时的文件名 glob 过滤（如 "*.txt"）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { pattern: string, path?: string, include?: string }, exec: unknown) {
      try {
        const e = exec as { agent?: { session?: { header?: { cwd?: string } } } }
        const target = args.path ?? e.agent?.session?.header?.cwd
        if (!target) return 'ERROR: 缺少 path 且无法确定会话工作区'
        const absPath = await resolveToolPath(target, exec)
        if (!absPath) return `ERROR: 无法解析路径 ${target}`
        const matches = await grepFiles({ pattern: args.pattern, target: absPath, include: args.include })
        if (matches.length === 0) return 'No matches'
        return matches.map((m) => `${m.path}:${m.lineNumber}: ${m.line}`).join('\n')
      } catch (error) {
        return `ERROR: ${String(error)}`
      }
    },
  })), 'dsh-encoding-guard: eb_grep')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'eb_convert',
    description: '显式把文本文件转为 UTF-8 no BOM（自动检测原编码；默认轮末恢复原编码，persist:true 持久转换不恢复）。',
    parameters: {
      file_path: { type: 'string', description: '要转换的文件路径', required: true },
      persist: { type: 'boolean', description: 'true=持久转换（轮末不恢复，迁移语义）；缺省 false（会话视图，轮末恢复）' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { file_path: string, persist?: boolean }, exec: unknown) {
      try {
        const absPath = await resolveToolPath(args.file_path, exec)
        if (!absPath) return `ERROR: 无法解析路径 ${args.file_path}`
        const e = exec as { agent?: { session?: { id?: string } } }
        const sessionId = e.agent?.session?.id ?? 'unknown'
        const outcome = await ledger.withLock(absPath.toLowerCase(), () =>
          convertFile(absPath, args.persist === true, ledger, sessionId))
        switch (outcome.kind) {
          case 'converted':
            return `${absPath}: 已转 UTF-8 no BOM（原编码 ${outcome.encoding}${outcome.persist ? '，持久转换，轮末不恢复' : '，已进账本，轮末恢复'}）`
          case 'already-utf8':
            return `${absPath}: 已是 UTF-8 no BOM，无需转换。`
          case 'ledger-cleared':
            return `${absPath}: 账本条目已清除（此前已转 UTF-8），轮末不再恢复 → 持久转换生效。`
          case 'error':
            return `ERROR: ${outcome.message}`
        }
      } catch (error) {
        return `ERROR: ${String(error)}`
      }
    },
  })), 'dsh-encoding-guard: eb_convert')
}
