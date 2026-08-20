import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { detectEncoding, decodeToText, encodeFromText } from './encoding.js';
import { EncodingLedger } from './ledger.js';
export const name = 'dsh-encoding-guard';
export const inject = ['fs', 'tools'];
/** 拦截的目标工具（dsh-tool-fs 的模型面工具名）。 */
const TARGET_TOOLS = new Set(['read', 'write', 'edit']);
/** 明确的二进制扩展名：直接放行，不做检测转换。 */
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.avif',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
    '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz', '.zst',
    '.exe', '.dll', '.so', '.dylib', '.obj', '.lib', '.bin', '.class', '.jar', '.war',
    '.wasm', '.o', '.a', '.pyc', '.pyo', '.node', '.msi', '.apk', '.ipa',
    '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wav', '.flac', '.ogg', '.webm',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    '.sqlite', '.db', '.mdb', '.accdb', '.ldf', '.mdf',
    '.onnx', '.pt', '.gguf', '.safetensors', '.h5', '.pkl', '.parquet', '.arrow',
]);
/** 超过此大小的文件不做检测转换（防误伤大文件；官方 read 自有流式与上限）。 */
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
export function apply(ctx) {
    const ledger = new EncodingLedger();
    function log(level, message) {
        try {
            ctx.logger[level](`[encoding-guard] ${message}`);
        }
        catch { /* logger 不可用也静默 */ }
    }
    /** 确保磁盘文件为 UTF-8 no BOM：必要时原地转码并记账。 */
    async function ensureUtf8NoBom(absPath, key, sessionId, signal) {
        if (ledger.has(key)) {
            ledger.touch(key);
            return 'already';
        }
        let bytes;
        try {
            bytes = await fsp.readFile(absPath, { signal });
        }
        catch {
            return 'skipped'; // 不存在/不可读：交给官方工具给出规范错误
        }
        if (bytes.length === 0 || bytes.length > MAX_SCAN_BYTES)
            return 'skipped';
        const enc = detectEncoding(bytes);
        if (enc === 'utf8' || enc === 'empty' || enc === 'binary')
            return 'skipped';
        const text = decodeToText(bytes, enc);
        await fsp.writeFile(absPath, Buffer.from(text, 'utf8'), { signal });
        ledger.record(key, { path: absPath, encoding: enc, sessionId, touchedAt: Date.now() });
        log('info', `转码 → UTF-8 no BOM：${absPath}（原编码 ${enc}）`);
        return 'converted';
    }
    /** 恢复单个账本文件为原编码（当前内容重新编码；字符序列不变）。 */
    async function restoreOne(key, entry) {
        let bytes;
        try {
            bytes = await fsp.readFile(entry.path);
        }
        catch {
            ledger.delete(key); // 文件已不存在：账本自然清空
            return 'gone';
        }
        const current = detectEncoding(bytes);
        if (current !== 'utf8' && current !== 'utf8-bom') {
            // 磁盘已非 UTF-8 状态（外部改动或已被恢复）：视为已了结
            ledger.delete(key);
            return 'external';
        }
        const text = decodeToText(bytes, current);
        try {
            const out = encodeFromText(text, entry.encoding);
            await fsp.writeFile(entry.path, out);
            ledger.delete(key);
            log('info', `恢复 ${entry.encoding}：${entry.path}`);
            return 'restored';
        }
        catch (error) {
            entry.restoreFailed = String(error);
            log('warn', `恢复 ${entry.encoding} 失败（保留 UTF-8）：${entry.path} — ${String(error)}`);
            return 'failed';
        }
    }
    /** 恢复某会话账本中的全部文件。 */
    async function restoreSession(sessionId) {
        const report = [];
        for (const key of ledger.keysBySession(sessionId)) {
            const entry = ledger.get(key);
            if (!entry)
                continue;
            const outcome = await ledger.withLock(key, () => restoreOne(key, entry));
            report.push(`${entry.path}: ${outcome}`);
        }
        return report;
    }
    /** 恢复全部账本文件（插件卸载兜底 / eb_restore）。 */
    async function restoreAll() {
        const report = [];
        for (const key of ledger.allKeys()) {
            const entry = ledger.get(key);
            if (!entry)
                continue;
            const outcome = await ledger.withLock(key, () => restoreOne(key, entry));
            report.push(`${entry.path}: ${outcome}`);
        }
        return report;
    }
    /** 解析工具参数里的 file_path 为绝对路径（复用 ctx.fs 的会话 cwd 语义）。 */
    async function resolveToolPath(filePath, exec) {
        const e = exec;
        const cwd = e.agent?.session?.header?.cwd;
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
            await ensureUtf8NoBom(absPath, key, sessionId, signal).catch((error) => {
                log('warn', `转码失败（放行原文件）：${absPath} — ${String(error)}`);
            });
        });
    }
    // ── 核心拦截：tools/execute around-wrapper（与 timeout-policy 同一挂点） ──────────
    ctx.on('tools/execute', async (exec, next) => {
        if (!TARGET_TOOLS.has(exec?.name))
            return next();
        const filePath = exec.arguments?.file_path;
        if (typeof filePath !== 'string' || filePath === '')
            return next();
        const absPath = await resolveToolPath(filePath, exec);
        if (!absPath)
            return next();
        if (BINARY_EXTENSIONS.has(path.extname(absPath).toLowerCase()))
            return next();
        const key = absPath.toLowerCase();
        const sessionId = exec.agent?.session?.id ?? 'unknown';
        if (exec.name === 'read') {
            await guardConvert(absPath, key, sessionId, exec.signal);
            return next();
        }
        // write / edit
        let existed = true;
        try {
            await fsp.stat(absPath);
        }
        catch {
            existed = false;
        }
        await guardConvert(absPath, key, sessionId, exec.signal);
        const result = await next();
        // 需求 4：write 新建的文件落地为 UTF-8 no BOM + LF 行尾（仅在内容含 CRLF 时归一）
        if (exec.name === 'write' && !existed && result && result.isError !== true) {
            try {
                const bytes = await fsp.readFile(absPath);
                const text = bytes.toString('utf8');
                if (bytes.length <= MAX_SCAN_BYTES && text.includes('\r\n')) {
                    await fsp.writeFile(absPath, Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8'));
                }
            }
            catch {
                /* 归一失败不影响写结果 */
            }
        }
        return result;
    });
    // ── 轮次结束：恢复账本文件（serial 事件，await 完成才结束轮次） ──────────────────
    // 已实测验证：不按 sessionId 过滤——单 host 进程内账本即全集；
    // 另一会话再触达同文件会重新转换并自愈，跨会话恢复安全。
    ctx.on('agent/turn-stopping', async () => {
        try {
            const report = await restoreAll();
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
            const report = await restoreAll();
            if (report.length > 0)
                log('info', `会话结束兜底恢复 ${report.length} 个文件`);
        }
        catch (error) {
            log('warn', `会话结束兜底恢复失败：${String(error)}`);
        }
    });
    // ── 插件卸载：全部恢复（尽力而为；宿主强杀则依赖下次 eb_restore） ────────────────
    ctx.effect(() => () => {
        void restoreAll().catch((error) => {
            try {
                console.error('[encoding-guard] unload restore failed:', error);
            }
            catch { /* ignore */ }
        });
    });
    // ── 模型面小工具：查账本 / 手动恢复（描述保持一行，控制工具目录 prefill 成本） ────
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
                const outcome = await ledger.withLock(key, () => restoreOne(key, entry));
                return `${absPath}: ${outcome}`;
            }
            const report = await restoreAll();
            return report.length > 0 ? report.join('\n') : '账本为空：没有待恢复的文件。';
        },
    })), 'dsh-encoding-guard: eb_restore');
}
//# sourceMappingURL=index.js.map