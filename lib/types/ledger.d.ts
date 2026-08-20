/**
 * 转码账本 + 文件级互斥锁。
 *
 * 账本条目 = 一个已在磁盘上被转换为 UTF-8 no BOM、等待恢复原编码的文件。
 * key 用小写绝对路径（Windows 不区分大小写；Linux 极端大小写冲突可接受）。
 * 锁是 per-path promise 链：转换 / 恢复 / 工具调用前处理全部串行化，
 * 防止并行工具调用与轮次结束恢复之间的读写竞争。
 */
import type { DetectedEncoding } from './encoding.js';
export interface LedgerEntry {
    /** 规范绝对路径（保留原始大小写，用于恢复写回）。 */
    readonly path: string;
    /** 原编码（恢复目标）。 */
    readonly encoding: DetectedEncoding;
    /** 首次触发转换的会话 id（轮次/会话结束恢复的归属）。 */
    readonly sessionId: string;
    /** 最近一次被工具触达的时间戳（ms）。 */
    touchedAt: number;
    /** 恢复失败原因（保留 UTF-8 不动，等待人工处理）。 */
    restoreFailed?: string;
}
export declare class EncodingLedger {
    private readonly entries;
    private readonly locks;
    get size(): number;
    has(key: string): boolean;
    get(key: string): LedgerEntry | undefined;
    record(key: string, entry: LedgerEntry): void;
    touch(key: string): void;
    delete(key: string): void;
    keysBySession(sessionId: string): string[];
    allKeys(): string[];
    list(): LedgerEntry[];
    /** per-path 互斥：fn 与同 key 的其他 withLock 调用严格串行。 */
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
