// encoding 模块单元测试：node --test test/encoding.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import iconv from 'iconv-lite'
import { detectEncoding, decodeToText, encodeFromText } from '../lib/encoding.js'

const chinese = '你好，世界！Hello, World! 第二行\r\n第三行\t制表符 😀 emoji'

test('detectEncoding: UTF-8 no BOM', () => {
  assert.equal(detectEncoding(Buffer.from(chinese, 'utf8')), 'utf8')
  assert.equal(detectEncoding(Buffer.from('plain ascii')), 'utf8')
  assert.equal(detectEncoding(Buffer.alloc(0)), 'empty')
})

test('detectEncoding: UTF-8 BOM', () => {
  const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(chinese, 'utf8')])
  assert.equal(detectEncoding(bytes), 'utf8-bom')
})

test('detectEncoding: GB18030 (GBK)', () => {
  const bytes = iconv.encode(chinese.replace(' 😀 emoji', ''), 'gb18030')
  assert.equal(detectEncoding(bytes), 'gb18030')
})

test('detectEncoding: UTF-16 LE with BOM', () => {
  const bytes = iconv.encode(chinese, 'utf16le')
  const withBom = Buffer.concat([Buffer.from([0xFF, 0xFE]), bytes])
  assert.equal(detectEncoding(withBom), 'utf16le-bom')
})

test('detectEncoding: UTF-16 BE with BOM', () => {
  const text = '大端编码 test'
  const withBom = Buffer.concat([Buffer.from([0xFE, 0xFF]), iconv.encode(text, 'utf16be')])
  assert.equal(detectEncoding(withBom), 'utf16be-bom')
})

test('detectEncoding: bare UTF-16 LE (English-heavy, no BOM)', () => {
  const bytes = iconv.encode('Hello UTF-16 world without BOM', 'utf16le')
  assert.equal(detectEncoding(bytes), 'utf16le')
})

test('detectEncoding: binary (NUL, not UTF-16 shaped)', () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFF])
  assert.equal(detectEncoding(bytes), 'binary')
})

test('round-trip: utf8-bom 字节级还原（含 BOM 与 CRLF）', () => {
  const original = Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from('中文内容\r\nline2\r\n', 'utf8'),
  ])
  assert.equal(detectEncoding(original), 'utf8-bom')
  const text = decodeToText(original, 'utf8-bom')
  assert.equal(text, '中文内容\r\nline2\r\n')
  assert.ok(Buffer.compare(encodeFromText(text, 'utf8-bom'), original) === 0)
})

test('round-trip: gb18030 字节级还原（含 CRLF）', () => {
  const original = iconv.encode('第一行\r\n第二行 中文 OK', 'gb18030')
  assert.equal(detectEncoding(original), 'gb18030')
  const text = decodeToText(original, 'gb18030')
  assert.equal(text, '第一行\r\n第二行 中文 OK')
  assert.ok(Buffer.compare(encodeFromText(text, 'gb18030'), original) === 0)
})

test('round-trip: utf16le-bom 字节级还原', () => {
  const body = iconv.encode('宽字符\r\n文本', 'utf16le')
  const original = Buffer.concat([Buffer.from([0xFF, 0xFE]), body])
  assert.equal(detectEncoding(original), 'utf16le-bom')
  const text = decodeToText(original, 'utf16le-bom')
  assert.equal(text, '宽字符\r\n文本')
  assert.ok(Buffer.compare(encodeFromText(text, 'utf16le-bom'), original) === 0)
})

test('round-trip: 编辑后新增内容也能转回 gb18030', () => {
  const original = iconv.encode('旧内容', 'gb18030')
  const text = decodeToText(original, 'gb18030') + '新增中文'
  const back = encodeFromText(text, 'gb18030')
  assert.equal(decodeToText(back, 'gb18030'), text)
})

test('round-trip: gb18030 覆盖全 Unicode（emoji 也能无损转回）', () => {
  const text = '新增 emoji 😀 与生僻字 𠀀'
  const back = encodeFromText(text, 'gb18030')
  assert.equal(decodeToText(back, 'gb18030'), text)
})

test('round-trip: 孤立代理对 encode 不崩溃（iconv 内部替换，restoreFailed 为纯防御分支）', () => {
  const back = encodeFromText('前缀\uD800后缀', 'gb18030')
  assert.ok(back.length > 0)
  assert.ok(decodeToText(back, 'gb18030').includes('前缀'))
})
