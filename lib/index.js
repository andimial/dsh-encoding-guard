import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { EncodingLedger } from './ledger.js';
import { IN_MEMORY_LIMIT, ensureUtf8OnDisk, normalizeCrlfToLf, restoreAll, restoreOne, peekFile, grepFiles, convertFile, } from './bridge.js';
import { routeGuardAction, toolPathArg } from './router.js';
export const name = 'dsh-encoding-guard';
export const inject = ['fs', 'tools', 'systemPrompt'];
export function apply(ctx) {
    const ledger = new EncodingLedger();
    function log(level, message) {
        try {
            ctx.logger[level](`[encoding-guard] ${message}`);
        }
        catch { /* logger 不可用也静默 */ }
    }
    /** 从工具执行上下文取会话 cwd（exec→session 消息链的唯一出口）。 */
    function sessionCwdOf(exec) {
        return exec?.agent?.session?.header?.cwd;
    }
    /** 从工具执行上下文取会话 id（缺省 unknown）。 */
    function sessionIdOf(exec) {
        return exec?.agent?.session?.id ?? 'unknown';
    }
    /** 解析工具参数里的 file_path / path 为绝对路径（复用 ctx.fs 的会话 cwd 语义）。 */
    async function resolveToolPath(filePath, exec) {
        const e = exec;
        const cwd = sessionCwdOf(exec);
        try {
            const target = await ctx.fs.resolve(filePath, { cwd, signal: e.signal });
            return ctx.fs.processPath(target);
        }
        catch {
            return undefined; // 解析失败：放行给官方工具报错
        }
    }
    function guardConvert(absPath, key, sessionId, signal) {
        return ledger.withLock(key, async () => {
            await ensureUtf8OnDisk(absPath, ledger, sessionId).catch((error) => {
                log('warn', `转码失败（放行原文件）：${absPath} — ${String(error)}`);
            });
            void signal;
        });
    }
    // ── 核心拦截：tools/execute around-wrapper ────────────────────────────────────
    ctx.on('tools/execute', async (exec, next) => {
        const rawArgs = (exec.arguments ?? {});
        // 第一轮纯路由：先做参数形态/工具名/二进制扩展名放行判定，避免无谓路径解析
        const preliminary = routeGuardAction({ tool: exec.name, args: rawArgs });
        if (preliminary.kind === 'pass')
            return next();
        // 路径参数按工具形态分派：内置工具取 file_path；str_replace_editor 取 path
        const pathArg = toolPathArg(exec.name, rawArgs);
        // str_replace_editor 官方工具强制绝对路径；相对路径直接放行给官方报错，避免先转码造成磁盘副作用
        if (exec.name === 'str_replace_editor' && typeof pathArg === 'string' && !path.isAbsolute(pathArg))
            return next();
        const absPath = await resolveToolPath(pathArg, exec);
        if (!absPath)
            return next();
        // 解析后先按绝对路径做一次二进制/未知工具放行判定，避免对二进制 write 做无谓 stat
        const resolvedAction = routeGuardAction({ tool: exec.name, args: rawArgs, filePath: absPath });
        if (resolvedAction.kind === 'pass')
            return next();
        // write / str_replace_editor 需要知道是否新建或目录 view 以决定归一 / 豁免；
        // read/edit 不需要（edit 视为已存在）
        let existed;
        let isDirectory;
        if (exec.name === 'write' || exec.name === 'str_replace_editor') {
            try {
                const st = await fsp.stat(absPath);
                existed = true;
                isDirectory = st.isDirectory();
            }
            catch {
                existed = false;
            }
        }
        // 最终纯路由：以解析后的绝对路径、exists、isDirectory 精化动作（桥接读 / 桥接写 / 新建归一 / 放行）
        const action = routeGuardAction({
            tool: exec.name,
            args: rawArgs,
            filePath: absPath,
            exists: existed,
            isDirectory,
        });
        if (action.kind === 'pass')
            return next();
        const key = absPath.toLowerCase();
        const sessionId = sessionIdOf(exec);
        if (action.kind === 'bridge-read') {
            await guardConvert(absPath, key, sessionId, exec.signal);
            return next();
        }
        // bridge-write / new-file-normalize：写前同样转码（新建时 ensure 为 no-op）
        await guardConvert(absPath, key, sessionId, exec.signal);
        const result = await next();
        // 新建语义（write / str_replace_editor create）：落地为 UTF-8 no BOM + LF 行尾（仅在内容含 CRLF 时归一）
        if (action.kind === 'new-file-normalize' && result && result.isError !== true) {
            try {
                const bytes = await fsp.readFile(absPath);
                const text = bytes.toString('utf8');
                if (bytes.length <= IN_MEMORY_LIMIT && text.includes('\r\n')) {
                    await fsp.writeFile(absPath, Buffer.from(normalizeCrlfToLf(text), 'utf8'));
                }
            }
            catch {
                /* 归一失败不影响写结果 */
            }
        }
        return result;
    });
    // ── 提示词指导（ADR 0001：grep 非 ASCII 漏配与 shell 旁路的文档化边界） ────────
    ctx.systemPrompt.section({
        name: 'encoding-guard:grep-hint',
        order: 105,
        text: 'grep 由 ripgrep 直读磁盘字节：非 ASCII 模式（如中文关键词）对 GBK/GB18030/UTF-16 等旧编码文件会漏配；ASCII 模式对 GBK/GB18030 文件仍可命中，但 UTF-16 文件任何模式都会漏配（NUL 字节交错）。需要跨编码中文检索时改用 eb_grep，或用 read 触达后自愈。',
    });
    ctx.systemPrompt.section({
        name: 'encoding-guard:shell-hint',
        order: 106,
        text: 'shell（pwsh/bash）直接读磁盘原始字节，不经编码桥：旧编码文本文件在 shell 里会乱码。shell 场景需要查看旧编码文件内容时，先用 eb_peek（内存解码，不动磁盘）或 read（透明转码）。',
    });
    // ── 轮次结束：恢复账本文件（serial 事件，await 完成才结束轮次） ──────────────────
    // 已实测验证：不按 sessionId 过滤——单 host 进程内账本即全集；
    // 另一会话再触达同文件会重新转换并自愈，跨会话恢复安全（ADR 0002）。
    ctx.on('agent/turn-stopping', async () => {
        try {
            const report = await restoreAll(ledger);
            if (report.length > 0)
                log('info', `轮次结束恢复 ${report.length} 个文件`);
        }
        catch (error) {
            log('warn', `轮次结束恢复失败：${String(error)}`);
        }
    });
    // ── 会话结束：兜底检查（漏恢复的一律恢复） ──────────────────────────────────────
    ctx.on('session/disposed', async () => {
        try {
            const report = await restoreAll(ledger);
            if (report.length > 0)
                log('info', `会话结束兜底恢复 ${report.length} 个文件`);
        }
        catch (error) {
            log('warn', `会话结束兜底恢复失败：${String(error)}`);
        }
    });
    // ── 插件卸载：全部恢复（尽力而为；宿主强杀则依赖下次 eb_restore） ────────────────
    ctx.effect(() => () => {
        void restoreAll(ledger).catch((error) => {
            try {
                console.error('[encoding-guard] unload restore failed:', error);
            }
            catch { /* ignore */ }
        });
    });
    // ── 模型面工具（描述保持一行，控制工具目录 prefill 成本） ────────────────────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'eb_status',
        description: '编码守卫账本：列出已转为 UTF-8 no BOM、待恢复原编码的文件。',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute() {
            const list = ledger.list();
            if (list.length === 0)
                return '账本为空：没有待恢复原编码的文件。';
            return list
                .map((entry) => {
                const failed = entry.restoreFailed ? `（恢复失败：${entry.restoreFailed}）` : '';
                return `- ${entry.path} → ${entry.encoding}${failed}`;
            })
                .join('\n');
        },
    })), 'dsh-encoding-guard: eb_status');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'eb_restore',
        description: '立即把账本中的文件恢复为原编码（缺省全部；可指定单个 file_path）。',
        parameters: {
            file_path: { type: 'string', description: '只恢复该文件；缺省恢复全部' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
            if (args.file_path) {
                const absPath = await resolveToolPath(args.file_path, {});
                if (!absPath)
                    return `ERROR: 无法解析路径 ${args.file_path}`;
                const key = absPath.toLowerCase();
                const entry = ledger.get(key);
                if (!entry)
                    return `账本中没有 ${absPath}（未转换过，或已恢复）。`;
                const outcome = await ledger.withLock(key, () => restoreOne(ledger, key, entry));
                return `${absPath}: ${outcome}`;
            }
            const report = await restoreAll(ledger);
            return report.length > 0 ? report.join('\n') : '账本为空：没有待恢复的文件。';
        },
    })), 'dsh-encoding-guard: eb_restore');
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
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
            try {
                const absPath = await resolveToolPath(args.file_path, exec);
                if (!absPath)
                    return `ERROR: 无法解析路径 ${args.file_path}`;
                const result = await peekFile(absPath, { offset: args.offset, limit: args.limit });
                if (result.encoding === 'binary')
                    return `binary：${absPath}（非文本文件）`;
                if (result.encoding === 'empty')
                    return `(empty)：${absPath}`;
                const body = result.lines.map((l) => `${String(l.number).padStart(6)}\t${l.text}`).join('\n');
                return `编码: ${result.encoding}（内存解码，磁盘未动）\n${body}`;
            }
            catch (error) {
                return `ERROR: ${String(error)}`;
            }
        },
    })), 'dsh-encoding-guard: eb_peek');
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
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
            try {
                const target = args.path ?? sessionCwdOf(exec);
                if (!target)
                    return 'ERROR: 缺少 path 且无法确定会话工作区';
                const absPath = await resolveToolPath(target, exec);
                if (!absPath)
                    return `ERROR: 无法解析路径 ${target}`;
                const matches = await grepFiles({ pattern: args.pattern, target: absPath, include: args.include });
                if (matches.length === 0)
                    return 'No matches';
                return matches.map((m) => `${m.path}:${m.lineNumber}: ${m.line}`).join('\n');
            }
            catch (error) {
                return `ERROR: ${String(error)}`;
            }
        },
    })), 'dsh-encoding-guard: eb_grep');
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'eb_convert',
        description: '显式把文本文件转为 UTF-8 no BOM（自动检测原编码；默认轮末恢复原编码，persist:true 持久转换不恢复）。',
        parameters: {
            file_path: { type: 'string', description: '要转换的文件路径', required: true },
            persist: { type: 'boolean', description: 'true=持久转换（轮末不恢复，迁移语义）；缺省 false（会话视图，轮末恢复）' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
            try {
                const absPath = await resolveToolPath(args.file_path, exec);
                if (!absPath)
                    return `ERROR: 无法解析路径 ${args.file_path}`;
                const sessionId = sessionIdOf(exec);
                const outcome = await ledger.withLock(absPath.toLowerCase(), () => convertFile(absPath, args.persist === true, ledger, sessionId));
                switch (outcome.kind) {
                    case 'converted':
                        return `${absPath}: 已转 UTF-8 no BOM（原编码 ${outcome.encoding}${outcome.persist ? '，持久转换，轮末不恢复' : '，已进账本，轮末恢复'}）`;
                    case 'already-utf8':
                        return `${absPath}: 已是 UTF-8 no BOM，无需转换。`;
                    case 'ledger-cleared':
                        return `${absPath}: 账本条目已清除（此前已转 UTF-8），轮末不再恢复 → 持久转换生效。`;
                    case 'error':
                        return `ERROR: ${outcome.message}`;
                }
            }
            catch (error) {
                return `ERROR: ${String(error)}`;
            }
        },
    })), 'dsh-encoding-guard: eb_convert');
}
//# sourceMappingURL=index.js.map