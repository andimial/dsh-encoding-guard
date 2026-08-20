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

/** 各基础编码的 BOM 字节（gb18030 无 BOM 形态）。注入目标 BOM 的唯一字节源（bridge.InjectPrefix 共用）。 */
export const BOM_BYTES: Record<'utf8' | 'utf16le' | 'utf16be' | 'gb18030', Buffer | null> = {
  utf8: UTF8_BOM,
  utf16le: UTF16LE_BOM,
  utf16be: UTF16BE_BOM,
  gb18030: null,
}

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
function bareUtf16FromScan(scan: EncodingScan): DetectedEncoding | undefined {
  if (scan.length % 2 !== 0 || scan.length < 4) return undefined
  const pairs = scan.length / 2
  const rEven = scan.zeroEven / pairs
  const rOdd = scan.zeroOdd / pairs
  if (rOdd > 0.3 && rOdd - rEven > 0.2) return 'utf16le'
  if (rEven > 0.3 && rEven - rOdd > 0.2) return 'utf16be'
  return undefined
}

/**
 * 单一判定源：整缓冲扫描与流式扫描累积出同构的 EncodingScan，
 * 检测决策只在 decideFromScan 一处，保证两条路径行为一致。
 */
export interface EncodingScan {
  /** 总字节数。 */
  length: number
  /** 头部至多 4 字节（BOM 判定）。 */
  head: Uint8Array
  /** 偶数下标的 NUL 计数。 */
  zeroEven: number
  /** 奇数下标的 NUL 计数。 */
  zeroOdd: number
  /** 全体字节通过严格 UTF-8 验证。 */
  utf8Valid: boolean
  /** 全体字节 GB18030 解码无 U+FFFD。 */
  gb18030Valid: boolean
}

/** 对整块缓冲做一次性扫描。 */
export function scanBuffer(bytes: Buffer): EncodingScan {
  let zeroEven = 0
  let zeroOdd = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) zeroEven++
      else zeroOdd++
    }
  }
  return {
    length: bytes.length,
    head: bytes.subarray(0, 4),
    zeroEven,
    zeroOdd,
    utf8Valid: isValidUtf8(bytes),
    gb18030Valid: isValidGb18030(bytes),
  }
}

/** 由扫描结果判定编码（BOM → NUL/UTF-16 启发式 → 严格 UTF-8 → GB18030 → binary）。 */
export function decideFromScan(scan: EncodingScan): DetectedEncoding {
  if (scan.length === 0) return 'empty'
  if (scan.length >= 3 && scan.head[0] === 0xEF && scan.head[1] === 0xBB && scan.head[2] === 0xBF) return 'utf8-bom'
  if (scan.length >= 2 && scan.head[0] === 0xFF && scan.head[1] === 0xFE) return 'utf16le-bom'
  if (scan.length >= 2 && scan.head[0] === 0xFE && scan.head[1] === 0xFF) return 'utf16be-bom'
  if (scan.zeroEven + scan.zeroOdd > 0) return bareUtf16FromScan(scan) ?? 'binary'
  if (scan.utf8Valid) return 'utf8'
  if (scan.gb18030Valid) return 'gb18030'
  return 'binary'
}

export function detectEncoding(bytes: Buffer): DetectedEncoding {
  return decideFromScan(scanBuffer(bytes))
}

/** 带形态编码的 BOM 字节长度（无 BOM 形态为 0）。 */
export function bomLength(enc: DetectedEncoding): number {
  switch (enc) {
    case 'utf8-bom': return UTF8_BOM.length
    case 'utf16le-bom': return UTF16LE_BOM.length
    case 'utf16be-bom': return UTF16BE_BOM.length
    default: return 0
  }
}

/** 解码用的基础编码名（剥离 -bom 形态）。 */
export function baseEncoding(enc: DetectedEncoding): 'utf8' | 'utf16le' | 'utf16be' | 'gb18030' {
  switch (enc) {
    case 'utf8-bom': return 'utf8'
    case 'utf16le-bom': return 'utf16le'
    case 'utf16be-bom': return 'utf16be'
    default: return enc as 'utf8' | 'utf16le' | 'utf16be' | 'gb18030'
  }
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
    case 'utf16le-bom':
    case 'utf16be-bom': {
      const base = baseEncoding(enc)
      const body = base === 'utf8' ? Buffer.from(text, 'utf8') : iconv.encode(text, base)
      return Buffer.concat([BOM_BYTES[base]!, body])
    }
    case 'utf16le':
    case 'utf16be':
    case 'gb18030':
      return iconv.encode(text, enc)
    default:
      return Buffer.from(text, 'utf8')
  }
}
