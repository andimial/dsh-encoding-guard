// router 模块单测：node --test test/router.test.mjs
// 覆盖：内置 read / write / edit × 桥接读 / 桥接写 / 新建归一 / 放行各形态
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeGuardAction } from '../lib/router.js'

// ── read：桥接读 / 放行 ──────────────────────────────────────────────────────
test('read：有 file_path → bridge-read', () => {
  assert.deepEqual(routeGuardAction({ tool: 'read', args: { file_path: 'a.txt' } }), { kind: 'bridge-read' })
})

test('read：无 file_path → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'read', args: {} }), { kind: 'pass' })
})

test('read：file_path 为空字符串 → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'read', args: { file_path: '' } }), { kind: 'pass' })
})

test('read：file_path 非字符串 → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'read', args: { file_path: 42 } }), { kind: 'pass' })
})

test('read：原始路径非二进制、解析后为二进制 → 按解析后判定 pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'read', args: { file_path: 'a.txt' }, filePath: 'a.png' }), { kind: 'pass' })
})

test('read：二进制扩展名 → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'read', args: { file_path: 'a.png' } }), { kind: 'pass' })
})

test('read：大写二进制扩展名 → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'read', args: { file_path: 'A.PNG' } }), { kind: 'pass' })
})

// ── write：桥接写 / 新建归一 / 放行 ──────────────────────────────────────────
test('write：已存在 → bridge-write', () => {
  assert.deepEqual(routeGuardAction({ tool: 'write', args: { file_path: 'a.txt' }, exists: true }), { kind: 'bridge-write' })
})

test('write：不存在 → new-file-normalize', () => {
  assert.deepEqual(routeGuardAction({ tool: 'write', args: { file_path: 'a.txt' }, exists: false }), { kind: 'new-file-normalize' })
})

test('write：exists 缺省（未知）→ bridge-write（与旧挂点默认一致）', () => {
  assert.deepEqual(routeGuardAction({ tool: 'write', args: { file_path: 'a.txt' } }), { kind: 'bridge-write' })
})

test('write：无 file_path → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'write', args: { content: 'x' } }), { kind: 'pass' })
})

test('write：二进制扩展名 → pass（即使 exists=false）', () => {
  assert.deepEqual(routeGuardAction({ tool: 'write', args: { file_path: 'a.zip' }, exists: false }), { kind: 'pass' })
})

// ── edit：桥接写 / 放行 ──────────────────────────────────────────────────────
test('edit：有 file_path → bridge-write', () => {
  assert.deepEqual(routeGuardAction({ tool: 'edit', args: { file_path: 'a.txt', old_string: 'x', new_string: 'y' } }), { kind: 'bridge-write' })
})

test('edit：无 file_path → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'edit', args: { old_string: 'x', new_string: 'y' } }), { kind: 'pass' })
})

test('edit：二进制扩展名 → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'edit', args: { file_path: 'a.exe' } }), { kind: 'pass' })
})

// ── str_replace_editor：命令语义映射 ─────────────────────────────────────────
test('str_replace_editor：view 文件 → bridge-read', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'view', path: 'a.txt' } }), { kind: 'bridge-read' })
})

test('str_replace_editor：view 目录 → pass（编码无关）', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'view', path: 'a-dir' }, isDirectory: true }), { kind: 'pass' })
})

test('str_replace_editor：view 解析后为目录 → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'view', path: 'a.txt' }, filePath: 'a-dir', isDirectory: true }), { kind: 'pass' })
})

test('str_replace_editor：create 不存在 → new-file-normalize', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'create', path: 'a.txt', file_text: 'x' }, exists: false }), { kind: 'new-file-normalize' })
})

test('str_replace_editor：create 已存在 → pass（官方工具报错）', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'create', path: 'a.txt', file_text: 'x' }, exists: true }), { kind: 'pass' })
})

test('str_replace_editor：create exists 缺省 → new-file-normalize', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'create', path: 'a.txt', file_text: 'x' } }), { kind: 'new-file-normalize' })
})

test('str_replace_editor：str_replace → bridge-write', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'str_replace', path: 'a.txt', old_str: 'x', new_str: 'y' } }), { kind: 'bridge-write' })
})

test('str_replace_editor：insert → bridge-write', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'insert', path: 'a.txt', insert_line: 1, new_str: 'x' } }), { kind: 'bridge-write' })
})

test('str_replace_editor：未知命令 → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'delete', path: 'a.txt' } }), { kind: 'pass' })
})

test('str_replace_editor：缺 path → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'view' } }), { kind: 'pass' })
})

test('str_replace_editor：path 非字符串 → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'view', path: 42 } }), { kind: 'pass' })
})

test('str_replace_editor：二进制扩展名 → pass（各命令）', () => {
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'view', path: 'a.png' } }), { kind: 'pass' })
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'create', path: 'a.zip' }, exists: false }), { kind: 'pass' })
  assert.deepEqual(routeGuardAction({ tool: 'str_replace_editor', args: { command: 'str_replace', path: 'a.exe' } }), { kind: 'pass' })
})

// ── 未知工具：一律放行 ───────────────────────────────────────────────────────
test('未知工具：有 file_path 也 → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'grep', args: { file_path: 'a.txt' } }), { kind: 'pass' })
})

test('未知工具：无 file_path → pass', () => {
  assert.deepEqual(routeGuardAction({ tool: 'other', args: {} }), { kind: 'pass' })
})
