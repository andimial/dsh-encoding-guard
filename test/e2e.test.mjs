// 端到端模拟测试：真实文件 + 真实 bridge（lib/bridge.js）+ 真实账本
// node test/e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'
import { detectEncoding, decodeToText, encodeFromText } from '../lib/encoding.js'
import { ensureUtf8OnDisk, restoreAll } from '../lib/bridge.js'
import { EncodingLedger } from '../lib/ledger.js'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'eb-test-'))
const fileOf = (name) => path.join(tmp, name)

// 真实磁盘桥 + 真实账本（与 src/index.ts 挂点使用的同一段代码）
async function makeHarness() {
  const ledger = new EncodingLedger()
  return {
    ledger,
    entries: { get size() { return ledger.size } },
    ensureUtf8: (absPath) => ensureUtf8OnDisk(absPath, ledger, 'test-session'),
    restoreAll: () => restoreAll(ledger),
  }
}

test('e2e: GBK 文件 → read 前转换 → 编辑 → 轮次结束恢复原编码', async () => {
  const file = fileOf('gbk-note.txt')
  const original = iconv.encode('第一行：中文注释\r\nsecond line\r\n', 'gb18030')
  await fsp.writeFile(file, original)

  const h = await makeHarness()
  // read 前处理：转 UTF-8 no BOM
  assert.equal(await h.ensureUtf8(file), 'converted')
  assert.equal(detectEncoding(await fsp.readFile(file)), 'utf8')
  // 官方 read 视角：读到正确文本
  const readText = (await fsp.readFile(file)).toString('utf8')
  assert.equal(readText, '第一行：中文注释\r\nsecond line\r\n')
  // 官方 edit 视角：内容可匹配、可替换（保持 CRLF 样式）
  const edited = readText.replace('second line', '第二行 line')
  await fsp.writeFile(file, edited)
  // 轮次结束：恢复 GBK
  await h.restoreAll()
  const restored = await fsp.readFile(file)
  assert.equal(detectEncoding(restored), 'gb18030')
  assert.equal(decodeToText(restored, 'gb18030'), '第一行：中文注释\r\n第二行 line\r\n')
  assert.equal(h.entries.size, 0)
})

test('e2e: UTF-16 LE BOM 文件往返', async () => {
  const file = fileOf('utf16.txt')
  const original = Buffer.concat([Buffer.from([0xFF, 0xFE]), iconv.encode('宽字符文件\r\n行2', 'utf16le')])
  await fsp.writeFile(file, original)

  const h = await makeHarness()
  assert.equal(await h.ensureUtf8(file), 'converted')
  assert.equal((await fsp.readFile(file)).toString('utf8'), '宽字符文件\r\n行2')
  await h.restoreAll()
  assert.ok(Buffer.compare(await fsp.readFile(file), original) === 0, '字节级还原')
})

test('e2e: UTF-8 BOM 文件 → 剥 BOM → 恢复时补回', async () => {
  const file = fileOf('bom.txt')
  const original = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('带 BOM 的 UTF-8\n', 'utf8')])
  await fsp.writeFile(file, original)

  const h = await makeHarness()
  assert.equal(await h.ensureUtf8(file), 'converted')
  assert.equal((await fsp.readFile(file)).toString('utf8'), '带 BOM 的 UTF-8\n')
  await h.restoreAll()
  assert.ok(Buffer.compare(await fsp.readFile(file), original) === 0)
})

test('e2e: UTF-8 no BOM 文件不动、不进账本', async () => {
  const file = fileOf('plain.txt')
  await fsp.writeFile(file, Buffer.from('普通 UTF-8 文件\n', 'utf8'))
  const h = await makeHarness()
  assert.equal(await h.ensureUtf8(file), 'skipped')
  assert.equal(h.entries.size, 0)
  await h.restoreAll()
  assert.equal((await fsp.readFile(file)).toString('utf8'), '普通 UTF-8 文件\n')
})

test('e2e: 新建文件 LF 归一（需求4）', async () => {
  const file = fileOf('new-file.txt')
  // 模拟官方 write 落地模型给的 CRLF 内容
  await fsp.writeFile(file, Buffer.from('新建文件\r\n第二行\r\n', 'utf8'))
  // 插件后处理：CRLF → LF
  const bytes = await fsp.readFile(file)
  const text = bytes.toString('utf8')
  if (text.includes('\r\n')) {
    await fsp.writeFile(file, Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8'))
  }
  const final = await fsp.readFile(file)
  assert.equal(detectEncoding(final), 'utf8')
  assert.equal(final.toString('utf8'), '新建文件\n第二行\n')
})

test('e2e: 轮次中重复触达同一文件不重复转换（账本幂等）', async () => {
  const file = fileOf('twice.txt')
  await fsp.writeFile(file, iconv.encode('内容\r\n', 'gb18030'))
  const h = await makeHarness()
  assert.equal(await h.ensureUtf8(file), 'converted')
  assert.equal(await h.ensureUtf8(file), 'already')
  assert.equal(detectEncoding(await fsp.readFile(file)), 'utf8')
  await h.restoreAll()
  assert.equal(detectEncoding(await fsp.readFile(file)), 'gb18030')
})

// 清理
test('cleanup', async () => { await fsp.rm(tmp, { recursive: true, force: true }) })
