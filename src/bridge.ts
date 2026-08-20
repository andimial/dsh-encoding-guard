/**
 * 磁盘编码桥（无 cordis 依赖，可独立测试）。
 *
 * 职责：
 *  - 流式检测 detectEncodingFile：与 encoding.detectEncoding 共用 decideFromScan 单一判定源；
 *  - 流式原子转换 recodeFile：iconv 流式管道 → 临时文件 → rename，失败不落半截；
 *  - 磁盘桥 ensureUtf8OnDisk / restoreAll：read/write/edit 前的原地转码与轮末恢复（账本驱动）；
 *  - 内存解码 peekFile / grepFiles：eb_peek / eb_grep 的只读补位路径（零磁盘副作用）；
 *  - convertFile：eb_convert 的显式转换（默认进账本轮末恢复；persist:true 持久转换）。
 *
 * 尺寸分层：≤ IN_MEMORY_LIMIT 走整缓冲路径（行为与旧版一致）；
 * ≤ MAX_SCAN_BYTES 走流式路径；超过 MAX_SCAN_BYTES 自动桥跳过（eb_convert 显式报错）。
 */
import { createReadStream, createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PassThrough, Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import iconv from 'iconv-lite'
import {
  decideFromScan,
  bomLength,
  baseEncoding,
  detectEncoding,
  decodeToText,
  encodeFromText,
  type DetectedEncoding,
  type EncodingScan,
} from './encoding.js'
import { EncodingLedger, type LedgerEntry } from './ledger.js'

/** 整缓冲路径上限：≤ 此值沿用旧行为（一次性读入、内存判定与转换）。 */
export const IN_MEMORY_LIMIT = 5 * 1024 * 1024
/** 自动桥硬上限：超过此值不做检测转换（防误伤大文件）。 */
export const MAX_SCAN_BYTES = 50 * 1024 * 1024

const CHUNK_SIZE = 1 << 16

/** 各基础编码的 BOM 字节（目标为 -bom 形态时注入；gb18030 无 BOM 形态）。 */
const BOM_BYTES: Record<'utf8' | 'utf16le' | 'utf16be' | 'gb18030', Buffer | null> = {
  utf8: Buffer.from([0xEF, 0xBB, 0xBF]),
  utf16le: Buffer.from([0xFF, 0xFE]),
  utf16be: Buffer.from([0xFE, 0xFF]),
  gb18030: null,
}

// ── 流式扫描：累积 EncodingScan，判定交给 decideFromScan ─────────────────────

class StreamScanner {
  length = 0
  zeroEven = 0
  zeroOdd = 0
  head: Buffer = Buffer.alloc(0)
  utf8Valid = true
  gb18030Valid = true
  private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly gbDecoder = iconv.getDecoder('gb18030')

  push(chunk: Buffer): void {
    if (this.head.length < 4) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, 4 - this.head.length)])
    }
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0) {
        if ((this.length + i) % 2 === 0) this.zeroEven++
        else this.zeroOdd++
      }
    }
    this.length += chunk.length
    if (this.utf8Valid) {
      try {
        this.utf8Decoder.decode(chunk, { stream: true })
      } catch {
        this.utf8Valid = false
      }
    }
    if (this.gb18030Valid) {
      const text = this.gbDecoder.write(chunk)
      if (text.includes('\uFFFD')) this.gb18030Valid = false
    }
  }

  finish(): EncodingScan {
    if (this.utf8Valid) {
      try {
        this.utf8Decoder.decode()
      } catch {
        this.utf8Valid = false
      }
    }
    if (this.gb18030Valid) {
      const tail = this.gbDecoder.end() ?? ''
      if (tail.includes('\uFFFD')) this.gb18030Valid = false
    }
    return {
      length: this.length,
      head: this.head,
      zeroEven: this.zeroEven,
      zeroOdd: this.zeroOdd,
      utf8Valid: this.utf8Valid,
      gb18030Valid: this.gb18030Valid,
    }
  }
}

/** 流式扫描文件。读取失败时 reject（调用方决定放行或报错）。 */
export function scanFile(absPath: string): Promise<EncodingScan> {
  return new Promise((resolve, reject) => {
    const scanner = new StreamScanner()
    const stream = createReadStream(absPath, { highWaterMark: CHUNK_SIZE })
    stream.on('data', (chunk: Buffer) => scanner.push(chunk))
    stream.on('error', (error) => {
      stream.destroy()
      reject(error)
    })
    stream.on('end', () => resolve(scanner.finish()))
  })
}

/** 流式检测文件编码；不存在/不可读返回 undefined（交由官方工具给出规范错误）。 */
export async function detectEncodingFile(absPath: string): Promise<DetectedEncoding | undefined> {
  try {
    return decideFromScan(await scanFile(absPath))
  } catch {
    return undefined
  }
}

// ── 流式原子转换：iconv 流式管道 → 临时文件 → rename，失败不落半截 ─────────────

/** Transform：吞掉流头部 n 字节（源 BOM 剥离）。 */
class StripPrefix extends Transform {
  private remaining: number
  constructor(n: number) {
    super()
    this.remaining = n
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.remaining > 0) {
      if (chunk.length <= this.remaining) {
        this.remaining -= chunk.length
        return cb()
      }
      chunk = chunk.subarray(this.remaining)
      this.remaining = 0
    }
    cb(null, chunk)
  }
}

/** Transform：在流头注入固定字节（目标 BOM 补回）。 */
class InjectPrefix extends Transform {
  private pending: Buffer | undefined
  constructor(prefix: Buffer) {
    super()
    this.pending = prefix
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (this.pending !== undefined) {
      const head = this.pending
      this.pending = undefined
      return cb(null, Buffer.concat([head, chunk]))
    }
    cb(null, chunk)
  }
}

/**
 * 把文件从 from 编码流式转码为 to 编码（原地替换）。
 * - BOM 形态按源剥离 / 按目标补回；字符序列（含行尾）保持不变；
 * - 写入同目录临时文件 `.ebtmp` 后 rename 原子替换；rename 失败（Windows 外部占用等）
 *   回退为读临时文件内容原地覆盖，保证语义达成；
 * - 任何失败：删除临时文件、原文件字节不动。
 */
export async function recodeFile(absPath: string, from: DetectedEncoding, to: DetectedEncoding): Promise<void> {
  const fromBom = bomLength(from)
  const toBom = bomLength(to)
  const tempPath = `${absPath}.ebtmp`
  try {
    await pipeline(
      createReadStream(absPath, { highWaterMark: CHUNK_SIZE }),
      fromBom > 0 ? new StripPrefix(fromBom) : new PassThrough(),
      iconv.decodeStream(baseEncoding(from)),
      iconv.encodeStream(baseEncoding(to)),
      // toBom>0 ⇒ 目标必为 -bom 形态，基础编码不可能是 gb18030（无 BOM 形态）
      toBom > 0 ? new InjectPrefix(BOM_BYTES[baseEncoding(to)]!) : new PassThrough(),
      createWriteStream(tempPath, { highWaterMark: CHUNK_SIZE }),
    )
    try {
      await fsp.rename(tempPath, absPath)
    } catch {
      // rename 失败回退：临时内容原地覆盖（外部进程持有句柄场景）
      const bytes = await fsp.readFile(tempPath)
      await fsp.writeFile(absPath, bytes)
    }
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {})
    throw error
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {})
  }
}

export type EnsureOutcome = 'converted' | 'already' | 'skipped'

/** 检测某文件并按需转 UTF-8（账本幂等：已记账直接 already）。 */
async function detectForBridge(absPath: string, size: number): Promise<DetectedEncoding | undefined> {
  if (size <= IN_MEMORY_LIMIT) {
    try {
      return detectEncoding(await fsp.readFile(absPath))
    } catch {
      return undefined
    }
  }
  return detectEncodingFile(absPath)
}

/**
 * 磁盘桥入口：确保磁盘文件为 UTF-8 no BOM，必要时原地转码并记账。
 * ≤ IN_MEMORY_LIMIT 整缓冲路径；≤ MAX_SCAN_BYTES 流式路径；更大或不可判定跳过。
 */
export async function ensureUtf8OnDisk(
  absPath: string,
  ledger: EncodingLedger,
  sessionId: string,
): Promise<EnsureOutcome> {
  const key = absPath.toLowerCase()
  if (ledger.has(key)) {
    ledger.touch(key)
    return 'already'
  }
  let size: number
  try {
    size = (await fsp.stat(absPath)).size
  } catch {
    return 'skipped' // 不存在/不可读：交给官方工具给出规范错误
  }
  if (size === 0 || size > MAX_SCAN_BYTES) return 'skipped'
  const enc = await detectForBridge(absPath, size)
  if (enc === undefined || enc === 'utf8' || enc === 'empty' || enc === 'binary') return 'skipped'
  if (size <= IN_MEMORY_LIMIT) {
    const text = decodeToText(await fsp.readFile(absPath), enc)
    await fsp.writeFile(absPath, Buffer.from(text, 'utf8'))
  } else {
    await recodeFile(absPath, enc, 'utf8')
  }
  ledger.record(key, { path: absPath, encoding: enc, sessionId, touchedAt: Date.now() })
  return 'converted'
}

export type RestoreOutcome = 'restored' | 'gone' | 'external' | 'failed'

/** 恢复单个账本文件为原编码（当前内容重新编码；字符序列不变）。 */
export async function restoreOne(ledger: EncodingLedger, key: string, entry: LedgerEntry): Promise<RestoreOutcome> {
  let size: number
  try {
    size = (await fsp.stat(entry.path)).size
  } catch {
    ledger.delete(key) // 文件已不存在：账本自然清空
    return 'gone'
  }
  const current = size <= IN_MEMORY_LIMIT
    ? detectEncoding(await fsp.readFile(entry.path))
    : await detectEncodingFile(entry.path)
  if (current !== 'utf8' && current !== 'utf8-bom') {
    // 磁盘已非 UTF-8 状态（外部改动或已被恢复）：视为已了结
    ledger.delete(key)
    return 'external'
  }
  try {
    if (size <= IN_MEMORY_LIMIT) {
      const text = decodeToText(await fsp.readFile(entry.path), current)
      await fsp.writeFile(entry.path, encodeFromText(text, entry.encoding))
    } else {
      await recodeFile(entry.path, current, entry.encoding)
    }
    ledger.delete(key)
    return 'restored'
  } catch (error) {
    entry.restoreFailed = String(error)
    return 'failed'
  }
}

/** 恢复账本中的全部文件（轮末/会话结束/卸载兜底共用）。 */
export async function restoreAll(ledger: EncodingLedger): Promise<string[]> {
  const report: string[] = []
  for (const key of ledger.allKeys()) {
    const entry = ledger.get(key)
    if (!entry) continue
    const outcome = await ledger.withLock(key, () => restoreOne(ledger, key, entry))
    report.push(`${entry.path}: ${outcome}`)
  }
  return report
}

// ── 内存解码只读路径（eb_peek / eb_grep）：零磁盘副作用 ───────────────────────

/** 明确的二进制扩展名：直接放行，不做检测转换（index 层拦截与 grep 遍历共用）。 */
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.avif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz', '.zst',
  '.exe', '.dll', '.so', '.dylib', '.obj', '.lib', '.bin', '.class', '.jar', '.war',
  '.wasm', '.o', '.a', '.pyc', '.pyo', '.node', '.msi', '.apk', '.ipa',
  '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.wav', '.flac', '.ogg', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.sqlite', '.db', '.mdb', '.accdb', '.ldf', '.mdf',
  '.onnx', '.pt', '.gguf', '.safetensors', '.h5', '.pkl', '.parquet', '.arrow',
])

export interface PeekLine {
  number: number
  text: string
}

export interface PeekResult {
  encoding: DetectedEncoding
  lines: PeekLine[]
}

export interface PeekOptions {
  /** 1-based 起始行（与官方 read 对齐）。 */
  offset?: number
  /** 返回行数上限。 */
  limit?: number
}

/** 内存解码整文件并按行窗口返回；不写磁盘、不进账本（ADR 0003）。 */
export async function peekFile(absPath: string, opts: PeekOptions = {}): Promise<PeekResult> {
  const bytes = await fsp.readFile(absPath)
  if (bytes.length > MAX_SCAN_BYTES) {
    throw new Error(`文件超过 eb_peek 上限（${MAX_SCAN_BYTES} 字节）：${absPath}`)
  }
  const enc = detectEncoding(bytes)
  if (enc === 'binary' || enc === 'empty') return { encoding: enc, lines: [] }
  const text = decodeToText(bytes, enc)
  const all = text.split('\n')
  if (all.length > 0 && all[all.length - 1] === '') all.pop() // 尾随换行不产生空行
  for (let i = 0; i < all.length; i++) {
    if (all[i].endsWith('\r')) all[i] = all[i].slice(0, -1)
  }
  const start = Math.max(1, opts.offset ?? 1)
  const limit = opts.limit ?? all.length
  const lines: PeekLine[] = []
  for (let i = start - 1; i < all.length && lines.length < limit; i++) {
    lines.push({ number: i + 1, text: all[i] })
  }
  return { encoding: enc, lines }
}

export interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

export interface GrepOptions {
  /** 正则（JS RegExp 语法，非 ripgrep）。 */
  pattern: string
  /** 文件或目录。 */
  target: string
  /** 目录遍历时的文件名过滤（支持 * / ** / ? 的简化 glob）。 */
  include?: string
  /** 内联命中上限，缺省 200。 */
  maxMatches?: number
}

/** 简化 glob → RegExp：** 跨分隔符，* 不跨分隔符，? 单字符，其余按字面量。 */
function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++
        re += '.*'
      } else {
        re += '[^/\\\\]*'
      }
    } else if (c === '?') {
      re += '.'
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/** 目录 DFS 收集文件（确定性排序；跳过二进制扩展名与超限文件）。 */
async function collectFiles(dir: string, includeRe: RegExp | undefined, out: string[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(full, includeRe, out)
      continue
    }
    if (!entry.isFile()) continue
    if (includeRe !== undefined && !includeRe.test(entry.name)) continue
    if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    try {
      if ((await fsp.stat(full)).size > MAX_SCAN_BYTES) continue
    } catch {
      continue
    }
    out.push(full)
  }
}

/** 内存解码检索：target 为文件或目录；命中行来自解码后文本（ripgrep 对旧编码中文漏配的补位）。 */
export async function grepFiles(opts: GrepOptions): Promise<GrepMatch[]> {
  const maxMatches = opts.maxMatches ?? 200
  const re = new RegExp(opts.pattern)
  const includeRe = opts.include !== undefined ? globToRegExp(opts.include) : undefined
  const stat = await fsp.stat(opts.target)
  const files: string[] = []
  if (stat.isFile()) {
    files.push(opts.target)
  } else if (stat.isDirectory()) {
    await collectFiles(opts.target, includeRe, files)
  } else {
    return []
  }
  const matches: GrepMatch[] = []
  for (const file of files) {
    let peek: PeekResult
    try {
      peek = await peekFile(file)
    } catch {
      continue // 不可读/超限：跳过该文件
    }
    const rel = stat.isFile() ? file : path.relative(opts.target, file)
    for (const line of peek.lines) {
      if (re.test(line.text)) {
        matches.push({ path: rel, lineNumber: line.number, line: line.text })
        if (matches.length >= maxMatches) return matches
      }
    }
  }
  return matches
}

// ── 显式转换（eb_convert）：默认进账本（会话视图），persist 持久转换 ───────────

export type ConvertOutcome =
  | { kind: 'converted'; persist: boolean; encoding: string }
  | { kind: 'already-utf8' }
  | { kind: 'ledger-cleared' }
  | { kind: 'error'; message: string }

export async function convertFile(
  absPath: string,
  persist: boolean,
  ledger: EncodingLedger,
  sessionId: string,
): Promise<ConvertOutcome> {
  const key = absPath.toLowerCase()
  let size: number
  try {
    size = (await fsp.stat(absPath)).size
  } catch {
    return { kind: 'error', message: `无法访问 ${absPath}` }
  }
  if (size > MAX_SCAN_BYTES) {
    return { kind: 'error', message: `文件超过 eb_convert 上限（${MAX_SCAN_BYTES} 字节）：${absPath}` }
  }
  const enc = await detectForBridge(absPath, size)
  if (enc === undefined) return { kind: 'error', message: `无法读取或检测：${absPath}` }
  if (enc === 'binary') return { kind: 'error', message: `检测为二进制，不做文本编码转换：${absPath}` }

  // persist 且已在账本（磁盘为转换态 UTF-8）：清账即持久
  let cleared = false
  if (persist && ledger.has(key)) {
    ledger.delete(key)
    cleared = true
  }
  if (enc === 'utf8' || enc === 'empty') {
    return cleared ? { kind: 'ledger-cleared' } : { kind: 'already-utf8' }
  }
  if (size <= IN_MEMORY_LIMIT) {
    const text = decodeToText(await fsp.readFile(absPath), enc)
    await fsp.writeFile(absPath, Buffer.from(text, 'utf8'))
  } else {
    await recodeFile(absPath, enc, 'utf8')
  }
  if (persist) {
    return { kind: 'converted', persist: true, encoding: enc }
  }
  ledger.record(key, { path: absPath, encoding: enc, sessionId, touchedAt: Date.now() })
  return { kind: 'converted', persist: false, encoding: enc }
}
