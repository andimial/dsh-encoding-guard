export type DetectedEncoding = 'empty' | 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16le-bom' | 'utf16be' | 'utf16be-bom' | 'gb18030' | 'binary';
/**
 * 单一判定源：整缓冲扫描与流式扫描累积出同构的 EncodingScan，
 * 检测决策只在 decideFromScan 一处，保证两条路径行为一致。
 */
export interface EncodingScan {
    /** 总字节数。 */
    length: number;
    /** 头部至多 4 字节（BOM 判定）。 */
    head: Uint8Array;
    /** 偶数下标的 NUL 计数。 */
    zeroEven: number;
    /** 奇数下标的 NUL 计数。 */
    zeroOdd: number;
    /** 全体字节通过严格 UTF-8 验证。 */
    utf8Valid: boolean;
    /** 全体字节 GB18030 解码无 U+FFFD。 */
    gb18030Valid: boolean;
}
/** 对整块缓冲做一次性扫描。 */
export declare function scanBuffer(bytes: Buffer): EncodingScan;
/** 由扫描结果判定编码（BOM → NUL/UTF-16 启发式 → 严格 UTF-8 → GB18030 → binary）。 */
export declare function decideFromScan(scan: EncodingScan): DetectedEncoding;
export declare function detectEncoding(bytes: Buffer): DetectedEncoding;
/** 带形态编码的 BOM 字节长度（无 BOM 形态为 0）。 */
export declare function bomLength(enc: DetectedEncoding): number;
/** 解码用的基础编码名（剥离 -bom 形态）。 */
export declare function baseEncoding(enc: DetectedEncoding): 'utf8' | 'utf16le' | 'utf16be' | 'gb18030';
/** 按检测结果解码为字符串（BOM 剥离；字符序列保持不变）。 */
export declare function decodeToText(bytes: Buffer, enc: DetectedEncoding): string;
/** 按原编码把字符串编码回字节（带 BOM 的形态恢复时补回 BOM）。
 * 目标编码无法表示某些字符时 iconv-lite 会抛错，调用方负责降级（保留 UTF-8）。 */
export declare function encodeFromText(text: string, enc: DetectedEncoding): Buffer;
