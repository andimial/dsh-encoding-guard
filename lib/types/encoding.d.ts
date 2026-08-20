export type DetectedEncoding = 'empty' | 'utf8' | 'utf8-bom' | 'utf16le' | 'utf16le-bom' | 'utf16be' | 'utf16be-bom' | 'gb18030' | 'binary';
export declare function detectEncoding(bytes: Buffer): DetectedEncoding;
/** 按检测结果解码为字符串（BOM 剥离；字符序列保持不变）。 */
export declare function decodeToText(bytes: Buffer, enc: DetectedEncoding): string;
/** 按原编码把字符串编码回字节（带 BOM 的形态恢复时补回 BOM）。
 * 目标编码无法表示某些字符时 iconv-lite 会抛错，调用方负责降级（保留 UTF-8）。 */
export declare function encodeFromText(text: string, enc: DetectedEncoding): Buffer;
