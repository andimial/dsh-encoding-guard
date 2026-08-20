// bridge 模块测试：node --test test/bridge.test.mjs
// 覆盖：流式检测等价性、流式原子转换、磁盘桥上限、内存解码（peek/grep）、convert persist 语义
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'
import { detectEncoding } from '../lib/encoding.js'
import {
  detectEncodingFile,
  recodeFile,
  ensureUtf8OnDisk,
  restoreAll,
  peekFile,
  grepFiles,
  convertFile,
  MAX_SCAN_BYTES,
  IN_MEMORY_LIMIT,
} from '../lib/bridge.js'
import { EncodingLedger } from '../lib/ledger.js'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'eb-bridge-'))
const fileOf = (name) => path.join(tmp, name)

const chinese = '你好，世界！Hello, World! 第二行\r\n第三行\t制表符'

// ── Slice A：流式检测与 detectEncoding 行为等价 ──────────────────────────────
const corpus = [
  ['utf8', Buffer.from(chinese, 'utf8')],
  ['utf8-bom', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(chinese, 'utf8')])],
  ['gb18030', iconv.encode(chinese, 'gb18030')],
  ['utf16le-bom', Buffer.concat([Buffer.from([0xFF, 0xFE]), iconv.encode(chinese, 'utf16le')])],
  ['utf16be-bom', Buffer.concat([Buffer.from([0xFE, 0xFF]), iconv.encode('大端编码 test', 'utf16be')])],
  ['bare-utf16le', iconv.encode('Hello UTF-16 world without BOM', 'utf16le')],
  ['binary', Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFF])],
  ['empty', Buffer.alloc(0)],
]

for (const [name, bytes] of corpus) {
  test(`detectEncodingFile 等价 detectEncoding：${name}`, async () => {
    const file = fileOf(`detect-${name}.bin`)
    await fsp.writeFile(file, bytes)
    assert.equal(await detectEncodingFile(file), detectEncoding(bytes))
  })
}

test('detectEncodingFile：>5MB GBK 文件流式检测为 gb18030', async () => {
  const file = fileOf('detect-big.txt')
  // 生成约 6MB 的 GBK 文本（跨过 IN_MEMORY_LIMIT，走流式路径），单次写入
  const line = iconv.encode('这一行是中文内容用于填充大文件 second part\r\n', 'gb18030')
  const repeat = Math.ceil((6 * 1024 * 1024) / line.length)
  await fsp.writeFile(file, Buffer.concat(Array(repeat).fill(line)))
  assert.ok((await fsp.stat(file)).size > IN_MEMORY_LIMIT)
  assert.equal(await detectEncodingFile(file), 'gb18030')
  await fsp.rm(file)
})

test('detectEncodingFile：不存在的文件返回 undefined（交由官方工具报错）', async () => {
  assert.equal(await detectEncodingFile(path.join(tmp, 'nope.txt')), undefined)
})

// ── Slice B：recodeFile 流式原子转换 ─────────────────────────────────────────
test('recodeFile：gb18030 → utf8（小文件，含 CRLF），无临时文件残留', async () => {
  const file = fileOf('recode-small.txt')
  const original = iconv.encode('第一行：中文\r\nsecond line\r\n', 'gb18030')
  await fsp.writeFile(file, original)
  await recodeFile(file, 'gb18030', 'utf8')
  assert.equal((await fsp.readFile(file)).toString('utf8'), '第一行：中文\r\nsecond line\r\n')
  const leftovers = (await fsp.readdir(tmp)).filter((n) => n.includes('.ebtmp'))
  assert.deepEqual(leftovers, [])
})

test('recodeFile：utf8-bom → utf8 剥 BOM；utf8 → utf16le-bom 补 BOM', async () => {
  const file = fileOf('recode-bom.txt')
  await fsp.writeFile(file, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('带 BOM\n', 'utf8')]))
  await recodeFile(file, 'utf8-bom', 'utf8')
  assert.equal((await fsp.readFile(file)).toString('utf8'), '带 BOM\n')
  await recodeFile(file, 'utf8', 'utf16le-bom')
  const back = await fsp.readFile(file)
  assert.equal(back[0], 0xFF)
  assert.equal(back[1], 0xFE)
  assert.equal(iconv.decode(back.subarray(2), 'utf16le'), '带 BOM\n')
})

test('recodeFile：>5MB gb18030 → utf8 流式往返字节级还原', async () => {
  const file = fileOf('recode-big.txt')
  const line = iconv.encode('大文件流式转换测试行 big file streaming\r\n', 'gb18030')
  const repeat = Math.ceil((6 * 1024 * 1024) / line.length)
  const original = Buffer.concat(Array(repeat).fill(line))
  await fsp.writeFile(file, original)
  await recodeFile(file, 'gb18030', 'utf8')
  assert.ok((await fsp.stat(file)).size > IN_MEMORY_LIMIT)
  assert.equal(await detectEncodingFile(file), 'utf8')
  await recodeFile(file, 'utf8', 'gb18030')
  assert.ok(Buffer.compare(await fsp.readFile(file), original) === 0, '字节级还原')
  const leftovers = (await fsp.readdir(tmp)).filter((n) => n.includes('.ebtmp'))
  assert.deepEqual(leftovers, [])
  await fsp.rm(file)
})

test('recodeFile：未知目标编码抛错，原文件字节不动、无残留', async () => {
  const file = fileOf('recode-fail.txt')
  const original = Buffer.from('plain ascii\n', 'utf8')
  await fsp.writeFile(file, original)
  await assert.rejects(() => recodeFile(file, 'utf8', 'nope-enc'))
  assert.ok(Buffer.compare(await fsp.readFile(file), original) === 0)
  const leftovers = (await fsp.readdir(tmp)).filter((n) => n.includes('.ebtmp'))
  assert.deepEqual(leftovers, [])
})

// ── Slice C：磁盘桥 ensureUtf8OnDisk / restoreAll（真实账本） ─────────────────
test('磁盘桥：GBK 小文件 → converted 进账本 → restoreAll 恢复且账本清空', async () => {
  const file = fileOf('bridge-small.txt')
  const original = iconv.encode('第一行：中文注释\r\nsecond line\r\n', 'gb18030')
  await fsp.writeFile(file, original)
  const ledger = new EncodingLedger()
  assert.equal(await ensureUtf8OnDisk(file, ledger, 's1'), 'converted')
  assert.ok(ledger.has(file.toLowerCase()))
  assert.equal(await detectEncodingFile(file), 'utf8')
  // 编辑视角：UTF-8 内容可写回
  await fsp.writeFile(file, Buffer.from('第一行：中文注释\r\n第二行 line\r\n', 'utf8'))
  const report = await restoreAll(ledger)
  assert.equal(report.length, 1)
  assert.ok(report[0].includes('restored'))
  const restored = await fsp.readFile(file)
  assert.equal(await detectEncodingFile(file), 'gb18030')
  assert.equal(iconv.decode(restored, 'gb18030'), '第一行：中文注释\r\n第二行 line\r\n')
  assert.equal(ledger.size, 0)
})

test('磁盘桥：>5MB GBK 文件走流式转换，restore 字节级还原', async () => {
  const file = fileOf('bridge-big.txt')
  const line = iconv.encode('大文件磁盘桥测试 bridge big\r\n', 'gb18030')
  const repeat = Math.ceil((6 * 1024 * 1024) / line.length)
  const original = Buffer.concat(Array(repeat).fill(line))
  await fsp.writeFile(file, original)
  const ledger = new EncodingLedger()
  assert.equal(await ensureUtf8OnDisk(file, ledger, 's1'), 'converted')
  assert.equal(await detectEncodingFile(file), 'utf8')
  await restoreAll(ledger)
  assert.ok(Buffer.compare(await fsp.readFile(file), original) === 0)
  await fsp.rm(file)
})

test('磁盘桥：>50MB 文件 skipped（MAX_SCAN_BYTES 硬上限）', async () => {
  const file = fileOf('bridge-huge.txt')
  const line = iconv.encode('超限文件测试 over limit\r\n', 'gb18030')
  const repeat = Math.ceil((MAX_SCAN_BYTES + 1024 * 1024) / line.length)
  await fsp.writeFile(file, Buffer.concat(Array(repeat).fill(line)))
  assert.ok((await fsp.stat(file)).size > MAX_SCAN_BYTES)
  const before = await fsp.readFile(file)
  const ledger = new EncodingLedger()
  assert.equal(await ensureUtf8OnDisk(file, ledger, 's1'), 'skipped')
  assert.ok(Buffer.compare(await fsp.readFile(file), before) === 0)
  assert.equal(ledger.size, 0)
  await fsp.rm(file)
})

test('磁盘桥：UTF-8 文件 skipped 不进账本；重复触达 already', async () => {
  const file = fileOf('bridge-plain.txt')
  await fsp.writeFile(file, Buffer.from('普通 UTF-8\n', 'utf8'))
  const ledger = new EncodingLedger()
  assert.equal(await ensureUtf8OnDisk(file, ledger, 's1'), 'skipped')
  const gbk = fileOf('bridge-twice.txt')
  await fsp.writeFile(gbk, iconv.encode('内容\r\n', 'gb18030'))
  assert.equal(await ensureUtf8OnDisk(gbk, ledger, 's1'), 'converted')
  assert.equal(await ensureUtf8OnDisk(gbk, ledger, 's1'), 'already')
  await restoreAll(ledger)
  assert.equal(await detectEncodingFile(gbk), 'gb18030')
})

test('磁盘桥：外部把文件改回非 UTF-8 后恢复视为 external 并弃账', async () => {
  const file = fileOf('bridge-external.txt')
  const original = iconv.encode('外部修改场景\r\n', 'gb18030')
  await fsp.writeFile(file, original)
  const ledger = new EncodingLedger()
  await ensureUtf8OnDisk(file, ledger, 's1')
  // 外部进程（shell 等）直接把文件写回 GBK
  await fsp.writeFile(file, original)
  const report = await restoreAll(ledger)
  assert.ok(report[0].includes('external'))
  assert.ok(Buffer.compare(await fsp.readFile(file), original) === 0)
  assert.equal(ledger.size, 0)
})

test('磁盘桥：文件被删除后恢复视为 gone', async () => {
  const file = fileOf('bridge-gone.txt')
  await fsp.writeFile(file, iconv.encode('待删除\r\n', 'gb18030'))
  const ledger = new EncodingLedger()
  await ensureUtf8OnDisk(file, ledger, 's1')
  await fsp.rm(file)
  const report = await restoreAll(ledger)
  assert.ok(report[0].includes('gone'))
  assert.equal(ledger.size, 0)
})

// ── Slice D：peekFile 内存解码（零磁盘副作用） ───────────────────────────────
test('peekFile：GBK 文件读出正确中文，磁盘字节与 mtime 不变', async () => {
  const file = fileOf('peek-gbk.txt')
  await fsp.writeFile(file, iconv.encode('第一行 中文\r\nsecond line\r\n第三行\r\n', 'gb18030'))
  const before = await fsp.readFile(file)
  const statBefore = await fsp.stat(file)
  const result = await peekFile(file)
  assert.equal(result.encoding, 'gb18030')
  assert.deepEqual(result.lines.map((l) => l.text), ['第一行 中文', 'second line', '第三行'])
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(Buffer.compare(await fsp.readFile(file), before) === 0)
  assert.equal((await fsp.stat(file)).mtimeMs, statBefore.mtimeMs)
})

test('peekFile：offset/limit 行窗口（1-based）', async () => {
  const file = fileOf('peek-window.txt')
  await fsp.writeFile(file, iconv.encode('一\r\n二\r\n三\r\n四\r\n', 'gb18030'))
  const r1 = await peekFile(file, { offset: 2, limit: 2 })
  assert.deepEqual(r1.lines.map((l) => l.number), [2, 3])
  const r2 = await peekFile(file, { offset: 10 })
  assert.deepEqual(r2.lines, [])
})

test('peekFile：binary 返回标记，不抛错', async () => {
  const file = fileOf('peek.bin')
  await fsp.writeFile(file, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFF]))
  const r = await peekFile(file)
  assert.equal(r.encoding, 'binary')
  assert.deepEqual(r.lines, [])
})

// ── Slice E：grepFiles 内存检索 ──────────────────────────────────────────────
test('grepFiles：GBK 目录中文命中（ripgrep 漏配场景），include 过滤，跳过二进制', async () => {
  const dir = path.join(tmp, 'grep-dir')
  const sub = path.join(dir, 'sub')
  await fsp.mkdir(sub, { recursive: true })
  await fsp.writeFile(path.join(dir, 'a.txt'), iconv.encode('这里有中文关键词 target\r\nascii only line\r\n', 'gb18030'))
  await fsp.writeFile(path.join(sub, 'b.txt'), Buffer.from('utf8 文件也含 中文关键词\r\n', 'utf8'))
  await fsp.writeFile(path.join(dir, 'c.md'), iconv.encode('中文关键词 in md\r\n', 'gb18030'))
  await fsp.writeFile(path.join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFF]))

  const matches = await grepFiles({ pattern: '中文关键词', target: dir, include: '*.txt' })
  assert.equal(matches.length, 2)
  assert.ok(matches.some((m) => m.path === path.join('a.txt') && m.lineNumber === 1))
  assert.ok(matches.some((m) => m.path === path.join('sub', 'b.txt') && m.lineNumber === 1))

  const noFilter = await grepFiles({ pattern: '中文关键词', target: dir })
  assert.equal(noFilter.length, 3) // a.txt + sub/b.txt + c.md；img.png 跳过

  const capped = await grepFiles({ pattern: '中文关键词', target: dir, maxMatches: 1 })
  assert.equal(capped.length, 1)
})

test('grepFiles：单文件 target 直接检索', async () => {
  const file = fileOf('grep-single.txt')
  await fsp.writeFile(file, iconv.encode('needle 在这里\r\nnothing\r\nneedle again\r\n', 'gb18030'))
  const matches = await grepFiles({ pattern: 'needle', target: file })
  assert.deepEqual(matches.map((m) => m.lineNumber), [1, 3])
  assert.equal(matches[0].path, file)
})

// ── Slice F：convertFile persist 语义 ────────────────────────────────────────
test('convertFile：默认进账本，restoreAll 后回原编码', async () => {
  const file = fileOf('convert-ledger.txt')
  const original = iconv.encode('会话视图：转了要回去\r\n', 'gb18030')
  await fsp.writeFile(file, original)
  const ledger = new EncodingLedger()
  const r = await convertFile(file, false, ledger, 's1')
  assert.equal(r.kind, 'converted')
  assert.equal(r.encoding, 'gb18030')
  assert.ok(ledger.has(file.toLowerCase()))
  await restoreAll(ledger)
  assert.ok(Buffer.compare(await fsp.readFile(file), original) === 0)
})

test('convertFile：persist=true 持久转换，不进账本、轮末不恢复', async () => {
  const file = fileOf('convert-persist.txt')
  await fsp.writeFile(file, iconv.encode('持久转换：转了不回去\r\n', 'gb18030'))
  const ledger = new EncodingLedger()
  const r = await convertFile(file, true, ledger, 's1')
  assert.equal(r.kind, 'converted')
  assert.equal(r.persist, true)
  assert.equal(ledger.size, 0)
  assert.equal(await detectEncodingFile(file), 'utf8')
  const report = await restoreAll(ledger)
  assert.deepEqual(report, [])
  assert.equal(await detectEncodingFile(file), 'utf8')
})

test('convertFile：已是 UTF-8 no BOM → already-utf8；utf8-bom 剥 BOM 算转换', async () => {
  const plain = fileOf('convert-plain.txt')
  await fsp.writeFile(plain, Buffer.from('plain\n', 'utf8'))
  const ledger = new EncodingLedger()
  assert.equal((await convertFile(plain, false, ledger, 's1')).kind, 'already-utf8')

  const bom = fileOf('convert-bom.txt')
  await fsp.writeFile(bom, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('带BOM\n', 'utf8')]))
  const r = await convertFile(bom, true, ledger, 's1')
  assert.equal(r.kind, 'converted')
  assert.equal((await fsp.readFile(bom)).toString('utf8'), '带BOM\n')
})

test('convertFile：账本内文件 persist=true → ledger-cleared，轮末不再恢复', async () => {
  const file = fileOf('convert-clear.txt')
  const original = iconv.encode('先转换后决定持久\r\n', 'gb18030')
  await fsp.writeFile(file, original)
  const ledger = new EncodingLedger()
  await ensureUtf8OnDisk(file, ledger, 's1')
  assert.ok(ledger.has(file.toLowerCase()))
  const r = await convertFile(file, true, ledger, 's1')
  assert.equal(r.kind, 'ledger-cleared')
  assert.equal(ledger.size, 0)
  await restoreAll(ledger)
  assert.equal(await detectEncodingFile(file), 'utf8')
})

test('convertFile：不存在的文件 → error；超过上限 → error', async () => {
  const ledger = new EncodingLedger()
  const r = await convertFile(path.join(tmp, 'nope.txt'), false, ledger, 's1')
  assert.equal(r.kind, 'error')
  const big = fileOf('convert-big.txt')
  const line = iconv.encode('超限 over\r\n', 'gb18030')
  const repeat = Math.ceil((MAX_SCAN_BYTES + 1024 * 1024) / line.length)
  await fsp.writeFile(big, Buffer.concat(Array(repeat).fill(line)))
  const r2 = await convertFile(big, false, ledger, 's1')
  assert.equal(r2.kind, 'error')
  await fsp.rm(big)
})

test('cleanup', async () => { await fsp.rm(tmp, { recursive: true, force: true }) })
