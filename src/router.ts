/**
 * 守卫调度路由（无 cordis 依赖，可独立单测）。
 *
 * 职责：把「工具名 + 参数形态 → 守卫动作」的判定收敛为纯函数。
 * 挂点（src/index.ts）只负责接线：解析路径、执行转换、调用官方工具；
 * 是否桥接读 / 桥接写 / 新建归一 / 放行，全部由本模块决定。
 *
 * 设计说明：
 * - 参数形态按工具分派：内置 read/write/edit 从 `args.file_path` 提取，
 *   `str_replace_editor` 从 `args.path` 提取；`filePath` 为挂点解析后的绝对路径，
 *   传入后用于二进制扩展名判定（与旧挂点对 `absPath` 判定的行为一致）。
 * - `write` / `str_replace_editor create` 的新建归一依赖目标文件当前是否已存在，
 *   因此 `exists` 作为可选输入；`str_replace_editor view` 的目录豁免依赖 `isDirectory`。
 * - 二进制扩展名豁免在路由层判定，保证新增通道时不需要在挂点重复维护黑名单。
 */
import path from 'node:path'
import { BINARY_EXTENSIONS } from './bridge.js'

export type GuardAction =
  | { kind: 'bridge-read' }
  | { kind: 'bridge-write' }
  | { kind: 'new-file-normalize' }
  | { kind: 'pass' }

export interface GuardRouteInput {
  /** 工具名（内置 read / write / edit / str_replace_editor；未知工具一律放行）。 */
  tool: string
  /** 工具原始参数（挂点透传 `exec.arguments`）。 */
  args: Record<string, unknown>
  /** 已解析的目标绝对路径；提供时优先用于二进制扩展名判定。 */
  filePath?: string
  /** 目标文件当前是否已存在；`write` / `str_replace_editor create` 新建归一判定需要。缺省 undefined=未知（write 按已存在、create 按不存在处理）。 */
  exists?: boolean
  /** 目标路径是否解析为目录；`str_replace_editor view` 的目录豁免判定需要。 */
  isDirectory?: boolean
}

/** 按工具形态取路径参数：内置工具取 file_path；str_replace_editor 取 path。 */
export function toolPathArg(tool: string, args: Record<string, unknown>): unknown {
  return tool === 'str_replace_editor' ? args.path : args.file_path
}

export function routeGuardAction(input: GuardRouteInput): GuardAction {
  const { tool, args, filePath, exists, isDirectory } = input
  const rawPath = toolPathArg(tool, args)
  if (typeof rawPath !== 'string' || rawPath === '') return { kind: 'pass' }
  const targetPath = filePath ?? rawPath
  if (BINARY_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) return { kind: 'pass' }

  if (tool === 'str_replace_editor') {
    switch (args.command) {
      case 'view':
        // 目录 view 只列路径，不读文件内容：编码无关通道，直接放行。
        return isDirectory === true ? { kind: 'pass' } : { kind: 'bridge-read' }
      case 'create':
        // create 是新建语义；目标已存在时放行给官方工具报错，避免先转码已有文件。
        return exists === true ? { kind: 'pass' } : { kind: 'new-file-normalize' }
      case 'str_replace':
      case 'insert':
        return { kind: 'bridge-write' }
      default:
        return { kind: 'pass' }
    }
  }

  switch (tool) {
    case 'read':
      return { kind: 'bridge-read' }
    case 'write':
      return exists === false ? { kind: 'new-file-normalize' } : { kind: 'bridge-write' }
    case 'edit':
      return { kind: 'bridge-write' }
    default:
      return { kind: 'pass' }
  }
}
