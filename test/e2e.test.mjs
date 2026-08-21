// 端到端模拟测试：真实文件 + 真实 bridge（lib/bridge.js）+ 真实账本
// node test/e2e.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'
import { detectEncoding, decodeToText, encodeFromText } from '../lib/encoding.js'
import { ensureUtf8OnDisk, normalizeCrlfToLf, restoreAll } from '../lib/bridge.js'
import { routeGuardAction } from '../lib/router.js'
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
    await fsp.writeFile(file, Buffer.from(normalizeCrlfToLf(text), 'utf8'))
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

test('e2e: str_replace_editor view→str_replace 往返恢复原编码', async () => {
  const file = fileOf('sre-gbk.txt')
  const original = iconv.encode('第一行：中文注释\r\nsecond line\r\n', 'gb18030')
  await fsp.writeFile(file, original)

  const h = await makeHarness()
  // view（文件）→ bridge-read → 转换
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'view', path: file } }), { kind: 'bridge-read' })
  assert.equal(await h.ensureUtf8(file), 'converted')
  assert.equal((await fsp.readFile(file)).toString('utf8'), '第一行：中文注释\r\nsecond line\r\n')

  // str_replace → bridge-write → 官方工具在 UTF-8 视图上做匹配与写回
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'str_replace', path: file, old_str: 'second line', new_str: '第二行 line' } }), { kind: 'bridge-write' })
  const text = (await fsp.readFile(file)).toString('utf8')
  await fsp.writeFile(file, Buffer.from(text.replace('second line', '第二行 line'), 'utf8'))

  // 轮次结束：恢复 GBK
  await h.restoreAll()
  const restored = await fsp.readFile(file)
  assert.equal(detectEncoding(restored), 'gb18030')
  assert.equal(decodeToText(restored, 'gb18030'), '第一行：中文注释\r\n第二行 line\r\n')
  assert.equal(h.entries.size, 0)
})

test('e2e: str_replace_editor create 新建落地 UTF-8 no BOM + LF 归一', async () => {
  const file = fileOf('sre-create.txt')
  const h = await makeHarness()
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'create', path: file, file_text: 'x' }, exists: false }), { kind: 'new-file-normalize' })
  // 模拟官方 create 落地模型给的 CRLF 内容
  assert.equal(await h.ensureUtf8(file), 'skipped') // 不存在：交给官方工具创建
  await fsp.writeFile(file, Buffer.from('新建文件\r\n第二行\r\n', 'utf8'))
  // 插件后处理：CRLF → LF
  const bytes = await fsp.readFile(file)
  const text = bytes.toString('utf8')
  if (text.includes('\r\n')) {
    await fsp.writeFile(file, Buffer.from(normalizeCrlfToLf(text), 'utf8'))
  }
  const final = await fsp.readFile(file)
  assert.equal(detectEncoding(final), 'utf8')
  assert.equal(final.toString('utf8'), '新建文件\n第二行\n')
  assert.equal(h.entries.size, 0)
})

test('e2e: str_replace_editor view 目录放行——磁盘不动、账本为空', async () => {
  const dir = path.join(tmp, 'sre-dir')
  await fsp.mkdir(dir, { recursive: true })
  const sample = path.join(dir, 'gbk.txt')
  const original = iconv.encode('目录下文件\r\n', 'gb18030')
  await fsp.writeFile(sample, original)

  const h = await makeHarness()
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'view', path: dir }, isDirectory: true }), { kind: 'pass' })
  // 目录 view 不触达任何文件：磁盘不动、账本为空
  assert.equal(h.entries.size, 0)
  assert.ok(Buffer.compare(await fsp.readFile(sample), original) === 0)
  await h.restoreAll()
  assert.equal(h.entries.size, 0)
})

test('e2e: str_replace_editor 二进制扩展名豁免且重复触达幂等', async () => {
  const binary = fileOf('sre-data.bin')
  const original = iconv.encode('伪装成二进制扩展名的文本\r\n', 'gb18030')
  await fsp.writeFile(binary, original)

  const h = await makeHarness()
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'view', path: binary } }), { kind: 'pass' })
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'str_replace', path: binary, old_str: 'x', new_str: 'y' } }), { kind: 'pass' })
  assert.equal(h.entries.size, 0)
  assert.ok(Buffer.compare(await fsp.readFile(binary), original) === 0)

  // 同一文本文件经多命令重复触达：账本不重复登记
  const textFile = fileOf('sre-twice.txt')
  await fsp.writeFile(textFile, iconv.encode('内容\r\n', 'gb18030'))
  assert.equal(await h.ensureUtf8(textFile), 'converted')
  assert.equal(await h.ensureUtf8(textFile), 'already')
  assert.equal(h.entries.size, 1)
  await h.restoreAll()
  assert.equal(detectEncoding(await fsp.readFile(textFile)), 'gb18030')
})

// 清理
test('cleanup', async () => { await fsp.rm(tmp, { recursive: true, force: true }) })
