/**
 * 编码检测与转换（纯函数，无 cordis 依赖）。
 *
 * 支持的原编码（读取时统一转 UTF-8 no BOM 输出，轮次结束再转回）：
 *   utf8-bom / utf16le(-bom) / utf16be(-bom) / gb18030（GBK 超集）
 * 检测顺序：BOM → NUL/UTF-16 无 BOM 启发式 → 严格 UTF-8 验证 → GB18030 验证 → binary（不处理）。
 * 转换只动编码字节：字符序列（含行尾）在往返转换中保持不变。
 */
import iconv from 'iconv-lite'

export type DetectedEncoding =
  | 'empty'
  | 'utf8'
  | 'utf8-bom'
  | 'utf16le'
  | 'utf16le-bom'
  | 'utf16be'
  | 'utf16be-bom'
  | 'gb18030'
  | 'binary'

const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF])
const UTF16LE_BOM = Buffer.from([0xFF, 0xFE])
const UTF16BE_BOM = Buffer.from([0xFE, 0xFF])

function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** GB18030 解码无 U+FFFD 即认为合法（GBK 是其子集，round-trip 安全）。 */
function isValidGb18030(bytes: Buffer): boolean {
  const text = iconv.decode(bytes, 'gb18030')
  return !text.includes('\uFFFD')
}

/** 无 BOM UTF-16 启发式：长度为偶且零字节集中在高字节位置（LE 集中在奇数下标，BE 在偶数下标）。 */
function detectBareUtf16(bytes: Buffer): DetectedEncoding | undefined {
  if (bytes.length % 2 !== 0 || bytes.length < 4) return undefined
  const pairs = bytes.length / 2
  let zeroEven = 0
  let zeroOdd = 0
  for (let i = 0; i < bytes.length; i += 2) if (bytes[i] === 0) zeroEven++
  for (let i = 1; i < bytes.length; i += 2) if (bytes[i] === 0) zeroOdd++
  const rEven = zeroEven / pairs
  const rOdd = zeroOdd / pairs
  if (rOdd > 0.3 && rOdd - rEven > 0.2) return 'utf16le'
  if (rEven > 0.3 && rEven - rOdd > 0.2) return 'utf16be'
  return undefined
}

export function detectEncoding(bytes: Buffer): DetectedEncoding {
  if (bytes.length === 0) return 'empty'
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf8-bom'
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf16le-bom'
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf16be-bom'
  let hasNul = false
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) { hasNul = true; break }
  }
  if (hasNul) return detectBareUtf16(bytes) ?? 'binary'
  if (isValidUtf8(bytes)) return 'utf8'
  if (isValidGb18030(bytes)) return 'gb18030'
  return 'binary'
}

/** 按检测结果解码为字符串（BOM 剥离；字符序列保持不变）。 */
export function decodeToText(bytes: Buffer, enc: DetectedEncoding): string {
  switch (enc) {
    case 'utf8-bom':
      return iconv.decode(bytes.subarray(UTF8_BOM.length), 'utf8')
    case 'utf16le-bom':
      return iconv.decode(bytes.subarray(UTF16LE_BOM.length), 'utf16le')
    case 'utf16be-bom':
      return iconv.decode(bytes.subarray(UTF16BE_BOM.length), 'utf16be')
    case 'utf16le':
    case 'utf16be':
    case 'gb18030':
      return iconv.decode(bytes, enc)
    default:
      return bytes.toString('utf8')
  }
}

/** 按原编码把字符串编码回字节（带 BOM 的形态恢复时补回 BOM）。
 * 目标编码无法表示某些字符时 iconv-lite 会抛错，调用方负责降级（保留 UTF-8）。 */
export function encodeFromText(text: string, enc: DetectedEncoding): Buffer {
  switch (enc) {
    case 'utf8-bom':
      return Buffer.concat([UTF8_BOM, Buffer.from(text, 'utf8')])
    case 'utf16le-bom':
      return Buffer.concat([UTF16LE_BOM, iconv.encode(text, 'utf16le')])
    case 'utf16be-bom':
      return Buffer.concat([UTF16BE_BOM, iconv.encode(text, 'utf16be')])
    case 'utf16le':
    case 'utf16be':
    case 'gb18030':
      return iconv.encode(text, enc)
    default:
      return Buffer.from(text, 'utf8')
  }
}
