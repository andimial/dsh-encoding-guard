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
    /** 工具名（内置 read / write / edit；未知工具一律放行）。 */
    tool: string;
    /** 工具原始参数（挂点透传 `exec.arguments`）。 */
    args: Record<string, unknown>;
    /** 已解析的目标绝对路径；提供时优先用于二进制扩展名判定。 */
    filePath?: string;
    /** 目标文件当前是否已存在；`write` 新建归一判定需要。缺省 undefined=未知（按已存在处理）。 */
    exists?: boolean;
}
export declare function routeGuardAction(input: GuardRouteInput): GuardAction;
