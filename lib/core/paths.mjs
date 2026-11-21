// lib/core/paths.mjs —— 落盘路径的唯一出口：$DSH_HOME、本子库、账本、pack-meta、文本仓。
// 只依赖 node:os / node:path / node:crypto 与 process.env；要配置的地方用显式参数（caseRoot(cfg)）。
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

export function caseRoot(cfg) {
  return cfg.casesDir && cfg.casesDir.trim() !== '' ? resolve(cfg.casesDir) : join(dshHome(), 'game-desk', 'cases')
}

/** 书库根目录：① 本子库 ② 配置里声明的 ③ 页面上添加过并落到 library.json 的。 */
export function libraryFile() {
  return join(dshHome(), 'game-desk', 'library.json')
}

export function usageFile() { return join(dshHome(), 'game-desk', 'remote-usage.json') }

/** 模型用量账本（导入完成提示用）：每次走 llm seam 的调用收尾记一条，留最近 300 条。
 *  注意：导入本身是本地抽取（pdf 解析与 OCR 都走本机 python），不经模型 —— 所以「本次导入」恒为 0；
 *  账本负责诚实报「案卷台今天到目前为止用了多少」。 */
export function modelUsageFile() { return join(dshHome(), 'game-desk', 'model-usage.json') }

/** 体检标签的缓存键（与 packMetaFile 的 sha1 键分开：这个只活在进程内存里）。 */
export function packMetaKey(root, folder) {
  return String(root ?? '') + '|' + String(folder ?? '')
}

export function packMetaDir() {
  return join(dshHome(), 'game-desk', 'pack-meta')
}

export function packMetaFile(root, folder) {
  const key = createHash('sha1').update(String(root) + '|' + String(folder)).digest('hex').slice(0, 16)
  return join(packMetaDir(), key + '.json')
}

/* 抽出来的文本不写进来源目录（那可能是网盘只读/受保护目录），
   统一缓存在 $DSH_HOME/game-desk/text/<root|folder 的哈希>/ 下。 */
export function textStore(root, folder) {
  const key = createHash('sha1').update(String(root) + '|' + String(folder)).digest('hex').slice(0, 16)
  const dir = join(dshHome(), 'game-desk', 'text', key)
  return { dir, index: join(dir, 'index.json') }
}
