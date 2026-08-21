/**
 * 守卫调度路由（无 cordis 依赖，可独立单测）。
 *
 * 职责：把「工具名 + 参数形态 → 守卫动作」的判定收敛为纯函数。
 * 挂点（src/index.ts）只负责接线：解析路径、执行转换、调用官方工具；
 * 是否桥接读 / 桥接写 / 新建归一 / 放行，全部由本模块决定。
 *
 * 设计说明：
 * - 参数形态从 `args.file_path` 提取；`filePath` 为挂点解析后的绝对路径，
 *   传入后用于二进制扩展名判定（与旧挂点对 `absPath` 判定的行为一致）。
 * - `write` 的新建归一依赖目标文件当前是否已存在，因此 `exists` 作为可选输入；
 *   缺省视为「已存在」，与旧挂点默认行为一致。
 * - 二进制扩展名豁免在路由层判定，保证新增通道时不需要在挂点重复维护黑名单。
 */
import path from 'node:path';
import { BINARY_EXTENSIONS } from './bridge.js';
export function routeGuardAction(input) {
    const { tool, args, filePath, exists } = input;
    const rawPath = args.file_path;
    if (typeof rawPath !== 'string' || rawPath === '')
        return { kind: 'pass' };
    const targetPath = filePath ?? rawPath;
    if (BINARY_EXTENSIONS.has(path.extname(targetPath).toLowerCase()))
        return { kind: 'pass' };
    switch (tool) {
        case 'read':
            return { kind: 'bridge-read' };
        case 'write':
            return exists === false ? { kind: 'new-file-normalize' } : { kind: 'bridge-write' };
        case 'edit':
            return { kind: 'bridge-write' };
        default:
            return { kind: 'pass' };
    }
}
//# sourceMappingURL=router.js.map