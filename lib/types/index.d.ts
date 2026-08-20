/**
 * dsh-encoding-guard — 文件编码守卫。
 *
 * 对内置 read/write/edit 工具做透明编码桥接：
 *  1. 读取前：磁盘文件非 UTF-8 no BOM（utf8-bom / gb18030 / utf16le / utf16be）时，
 *     先原地把字符内容转码为 UTF-8 no BOM（字符序列与行尾不变），官方 read 因此总能读到文本；
 *  2. 编写前：同样先转 UTF-8 no BOM，官方 write/edit 正常工作；
 *     write 新建文件落地为 UTF-8 no BOM 且行尾 LF；
 *  3. 轮次结束（agent/turn-stopping）：把账本中的文件恢复为原编码；
 *     会话结束（session/disposed）与插件卸载兜底检查，未恢复的一律恢复。
 *
 * 磁盘桥逻辑（检测/转换/账本恢复）在 src/bridge.ts（无 cordis 依赖，可独立测试）；
 * 本文件只做挂点接线与模型面工具。绕过补位工具族（ADR 0001/0003）：
 *  - eb_peek / eb_grep：内存解码只读路径（零磁盘副作用）；
 *  - eb_convert：显式转换（默认进账本轮末恢复；persist:true 持久转换）。
 *
 * 设计要点：
 *  - 转换会改变文件字节 → FsVersion（size/mtimeNs/ctimeNs）随之变化。会话期间文件
 *    保持 UTF-8 no BOM，观察策略（read-before-write 版本守卫）全程一致；恢复发生在
 *    轮次之间，下一轮首个 edit 若版本过期会收到 FS_STALE_VERSION，re-read 即自愈。
 *  - 恢复 = 把当前 UTF-8 内容重新编码为原编码。编辑后引入原编码无法表示的字符时，
 *    iconv-lite 抛错 → 保留 UTF-8 并在账本标记 restoreFailed（eb_status 可查）。
 *  - node:fs 直写绕过 fs 沙箱（恢复需写非 UTF-8 字节，ctx.fs.writeText 做不到）；
 *    danger-full-access 部署下无影响。
 */
import type { Context } from 'cordis';
export declare const name = "dsh-encoding-guard";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
