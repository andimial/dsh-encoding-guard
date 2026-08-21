import { type DetectedEncoding, type EncodingScan } from './encoding.js';
import { EncodingLedger, type LedgerEntry } from './ledger.js';
/** 整缓冲路径上限：≤ 此值沿用旧行为（一次性读入、内存判定与转换）。 */
export declare const IN_MEMORY_LIMIT: number;
/** 自动桥硬上限：超过此值自动桥不做检测转换（防误伤大文件）；eb_convert 显式补位，无上限。 */
export declare const MAX_SCAN_BYTES: number;
/** CRLF → LF 归一（仅内容含 CRLF 时替换，保持其余字符不变）。 */
export declare function normalizeCrlfToLf(text: string): string;
/** 流式扫描文件。读取失败时 reject（调用方决定放行或报错）。 */
export declare function scanFile(absPath: string): Promise<EncodingScan>;
/** 流式检测文件编码；不存在/不可读返回 undefined（交由官方工具给出规范错误）。 */
export declare function detectEncodingFile(absPath: string): Promise<DetectedEncoding | undefined>;
/**
 * rename 失败后的回退覆盖：读临时内容 → 备份原字节 → 原地覆盖。
 * - 临时文件读不了：原文件未动，直接抛（外层清理临时文件）；
 * - 覆盖失败（如 ENOSPC 截断）：回写备份，尽力保住「原字节不动」，再抛原错误
 *   （备份回写也失败时保留原错误，不掩盖）；回退路径罕见，大文件时短暂双份内存可接受。
 * 临时文件清理由调用方负责。
 */
export declare function overwriteInPlace(tempPath: string, absPath: string): Promise<void>;
/**
 * 把文件从 from 编码流式转码为 to 编码（原地替换）。
 * - BOM 形态按源剥离 / 按目标补回；字符序列（含行尾）保持不变；
 * - 写入同目录临时文件 `.ebtmp` 后 rename 原子替换；rename 失败（Windows 外部占用等）
 *   回退 overwriteInPlace 原地覆盖（覆盖前备份，写失败回写），保证语义达成；
 * - 任何失败：删除临时文件、原文件字节不动。
 */
export declare function recodeFile(absPath: string, from: DetectedEncoding, to: DetectedEncoding): Promise<void>;
export type EnsureOutcome = 'converted' | 'already' | 'skipped';
/**
 * 磁盘桥入口：确保磁盘文件为 UTF-8 no BOM，必要时原地转码并记账。
 * ≤ IN_MEMORY_LIMIT 整缓冲路径；≤ MAX_SCAN_BYTES 流式路径；更大或不可判定跳过。
 */
export declare function ensureUtf8OnDisk(absPath: string, ledger: EncodingLedger, sessionId: string): Promise<EnsureOutcome>;
export type RestoreOutcome = 'restored' | 'gone' | 'external' | 'failed';
/** 判定错误是否意味着「文件已确定不在该路径上」：
 * 路径消失（ENOENT）、路径某环节非目录（ENOTDIR）、路径已是目录（EISDIR）。
 * 其余（EBUSY/EACCES/EPERM 等暂时性不可读写）不算：恢复须保留账本条目，下轮重试。 */
export declare function isDefinitivelyGone(error: unknown): boolean;
/** 恢复单个账本文件为原编码（当前内容重新编码；字符序列不变）。
 * 错误分流：确定消失（isDefinitivelyGone）→ gone 清账；暂时不可读写（被占用/权限等）
 * → failed 保留条目并标记 restoreFailed，下轮恢复重试——文件停留 UTF-8，不丢原编码信息。 */
export declare function restoreOne(ledger: EncodingLedger, key: string, entry: LedgerEntry): Promise<RestoreOutcome>;
/** 恢复账本中的全部文件（轮末/会话结束/卸载兜底共用）。 */
export declare function restoreAll(ledger: EncodingLedger): Promise<string[]>;
/** 明确的二进制扩展名：直接放行，不做检测转换（index 层拦截与 grep 遍历共用）。 */
export declare const BINARY_EXTENSIONS: Set<string>;
export interface PeekLine {
    number: number;
    text: string;
}
export interface PeekResult {
    encoding: DetectedEncoding;
    lines: PeekLine[];
}
export interface PeekOptions {
    /** 1-based 起始行（与官方 read 对齐）。 */
    offset?: number;
    /** 返回行数上限。 */
    limit?: number;
}
/** 内存解码整文件并按行窗口返回；不写磁盘、不进账本（ADR 0003）。 */
export declare function peekFile(absPath: string, opts?: PeekOptions): Promise<PeekResult>;
export interface GrepMatch {
    path: string;
    lineNumber: number;
    line: string;
}
export interface GrepOptions {
    /** 正则（JS RegExp 语法，非 ripgrep）。 */
    pattern: string;
    /** 文件或目录。 */
    target: string;
    /** 目录遍历时的文件名过滤（支持 * / ** / ? 的简化 glob）。 */
    include?: string;
    /** 内联命中上限，缺省 200。 */
    maxMatches?: number;
}
/** 内存解码检索：target 为文件或目录；命中行来自解码后文本（ripgrep 对旧编码中文漏配的补位）。 */
export declare function grepFiles(opts: GrepOptions): Promise<GrepMatch[]>;
export type ConvertOutcome = {
    kind: 'converted';
    persist: boolean;
    encoding: DetectedEncoding;
} | {
    kind: 'already-utf8';
} | {
    kind: 'ledger-cleared';
} | {
    kind: 'error';
    message: string;
};
export declare function convertFile(absPath: string, persist: boolean, ledger: EncodingLedger, sessionId: string): Promise<ConvertOutcome>;
