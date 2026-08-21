export type GuardAction = {
    kind: 'bridge-read';
} | {
    kind: 'bridge-write';
} | {
    kind: 'new-file-normalize';
} | {
    kind: 'pass';
};
export interface GuardRouteInput {
    /** 工具名（内置 read / write / edit / str_replace_editor；未知工具一律放行）。 */
    tool: string;
    /** 工具原始参数（挂点透传 `exec.arguments`）。 */
    args: Record<string, unknown>;
    /** 已解析的目标绝对路径；提供时优先用于二进制扩展名判定。 */
    filePath?: string;
    /** 目标文件当前是否已存在；`write` / `str_replace_editor create` 新建归一判定需要。缺省 undefined=未知（write 按已存在、create 按不存在处理）。 */
    exists?: boolean;
    /** 目标路径是否解析为目录；`str_replace_editor view` 的目录豁免判定需要。 */
    isDirectory?: boolean;
}
/** 按工具形态取路径参数：内置工具取 file_path；str_replace_editor 取 path。 */
export declare function toolPathArg(tool: string, args: Record<string, unknown>): unknown;
export declare function routeGuardAction(input: GuardRouteInput): GuardAction;
