// lib/services/textstore.mjs —— 文本仓（$DSH_HOME/game-desk/text/<hash>/）+ 目录遍历 + 可抽取判定。
// 状态（TTL 与 store 名 memo）归本服务实例所有，由 createTextStoreService({ ttlMs, storeNamesMemo }) 注入；
// 其它依赖（textStore / dirWake / cloneData / kindOf / txtNamePlan）来自 lib/core，纯函数无副作用。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { textStore } from '../core/paths.mjs'
import { dirWake, cloneData, kindOf } from '../core/util.mjs'
import { txtNamePlan } from '../core/names.mjs'

export function createTextStoreService({ ttlMs = 2500, storeNamesMemo } = {}) {
// ---- 注入的模块级状态（原 index.js 顶层的 memo / TTL，现在归本服务实例所有）
/* ---------- 进程内扫描缓存（2026-11-20 性能 P0-1/3/4/5） ----------
   用户的抱怨是「越来越钝」：书库 24 本 + 412 份文件、411 份文本缓存，而 /api/cases 每来一次就
   逐目录 readdir + 每文件 stat + 每本读一次文本/体检缓存；页面切根、房间心跳、轮询都会打它。
   这套 memo 只做「短命读缓存」：
   - 唤醒键 = 目标目录自身的 mtime/ctime（增删改名立刻失效；覆盖写不动 mtime，靠 TTL 兜底）
   - TTL 2.5 秒
   - 命中一律返回副本（调用方随便改，污染不到缓存） */
const SCAN_TTL_MS = ttlMs
const STORE_NAMES_MEMO = storeNamesMemo ?? new Map() // storeDir -> { at, wake, names:Set }

// 注入：SCAN_TTL_MS / STORE_NAMES_MEMO 由工厂参数给（默认 2500 / 空 Map）；同族的 SCAN_MEMO 在 services/library.mjs。

/** store 目录里非空 txt 的名字集合（列不出来 = 一份没扫）。 */
function storeTxtNames(dir) {
  // 2026-11-20 P0-4：调用方是 scanRoot —— 24 本各一次，每次都要给 412 份 txt 逐个 stat（Dirent 不带 size，
  // 判「非空」躲不掉 stat），所以只能把整轮结论记下来：key = 目录路径，唤醒键 = 目录自身 mtime/ctime。
  const key = String(dir ?? '')
  const wake = dirWake(key)
  const now = Date.now()
  const memo = STORE_NAMES_MEMO.get(key)
  if (memo && memo.wake === wake && now - memo.at < SCAN_TTL_MS) return { names: new Set(memo.names) }
  const names = new Set()
  try {
    for (const n of readdirSync(dir)) {
      if (!/\.txt$/i.test(n)) continue
      try { if (statSync(join(dir, n)).size > 0) names.add(n) } catch { /* 读不到不算 */ }
    }
  } catch { /* 没有缓存目录 = 一份没扫 */ }
  STORE_NAMES_MEMO.set(key, { at: now, wake, names: new Set(names) })
  if (STORE_NAMES_MEMO.size > 256) STORE_NAMES_MEMO.clear()
  return { names }
}
/** rel 在「内部目录」里吗（_ai_fill / _text / 任何 _ 前缀的中间层）：不是原稿，不参与可抽进度。 */
function inInternalDir(rel) {
  return String(rel).split('/').slice(0, -1).some((p) => p.startsWith('_'))
}
/** rel 是不是 AI 补全目录（_ai_fill/）里的生成件：那里的 md 是模型事后补写，不是原稿。
 *  2026-11-20 P0-6：readStoreTexts / packTextMaterial 用它过滤 —— 否则复核/补全会把自己上一轮
 *  写的「补全稿」当原文读，字数与缺项统计一起虚高。 */
function isAiFillRel(rel) {
  return String(rel).split('/').slice(0, -1).includes('_ai_fill')
}
/** 哪些文件本该抽出文本：排除内部目录与 doc/docx/other —— extractPack 只抽 pdf 与文本类。 */
function extractableFile(f) {
  const rel = String((f && f.rel) || '')
  if (rel === '' || inInternalDir(rel)) return false
  const kind = (f && f.kind) || kindOf(rel)
  return kind !== 'doc' && kind !== 'other'
}
/** 扫描完成度：本资料夹里「可抽取的文件」已经有多少份落下了非空 txt。
 *  2026-11-20 P1-1：分母不再含 _ai_fill/（AI 事后生成、永不抽取）与 doc/docx（从不抽）——
 *  它们过去把分母撑大，导致「可抽的全抽完」也到不了 100%（失魂 5/6、无形之刃 28/29…）。
 *  分子按 rel 逐份认缓存（新名 → 旧名，撞了旧名的只认占位者），分母里每份抽完就是满格。 */
function scanProgress(root, folder, files) {
  const all = files || []
  const store = textStore(root, folder)
  const have = storeTxtNames(store.dir)
  const eligible = all.filter((f) => extractableFile(f))
  const plan = txtNamePlan(eligible.map((f) => f.rel), have.names)
  let done = 0
  for (const f of eligible) if (plan.byRel.has(f.rel)) done += 1
  return { done, total: eligible.length, unsupported: all.length - eligible.length, totalAll: all.length }
}
/** 递归扫一棵树，返回 { files, incomplete, errors }（2026-11-20 P0-2）。
 *  旧实现 readdir 失败时 catch { return acc } 静默吞掉：调用方把「这棵树没读全」当成「就这么几个文件」，
 *  于是残缺索引、残缺体检都被当成全量。现在失败逐条记进 errors（EACCES/EBUSY/ENOENT/stat 失败），
 *  incomplete 由调用方决定怎么处置。兼容：walkFiles() 仍返回数组（老调用点太多）。 */
function walkFilesEx(dir, base = '', depth = 0, acc = [], errors = [], opts = {}) {
  if (depth > 3) return { files: acc, incomplete: errors.length > 0, errors }
  let ents = []
  try {
    ents = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    errors.push({ rel: base || '.', code: String((e && e.code) || 'EUNKNOWN'), error: String((e && e.message) || e) })
    return { files: acc, incomplete: true, errors }
  }
  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue
    const rel = base === '' ? ent.name : base + '/' + ent.name
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === '_text') continue
      // 2026-11-20 P0-6：把一棵树当「原稿」扫时（导入、抽文本），_ 前缀的内部目录（_ai_fill/ 等）
      // 不是原稿 —— 它们是 AI 事后写进来的，算进原稿会让文件数/体检分母/索引一起虚高。
      // 语义与 inInternalDir 一致（判的是 rel 里的中间层，这里多看目录名自己那一层）；
      // _source 例外：本库抽过文本的本子，原文都在 _source/ 下，跳过它等于把原稿丢了。
      if (opts.skipInternal && ent.name !== '_source' && inInternalDir(rel + '/_')) continue
      walkFilesEx(abs, rel, depth + 1, acc, errors, opts)
      continue
    }
    let st = null
    try {
      st = statSync(abs)
    } catch (e) {
      errors.push({ rel, code: String((e && e.code) || 'ESTAT'), error: String((e && e.message) || e) })
    }
    acc.push({ rel, name: ent.name, ext: extname(ent.name).toLowerCase(), kind: kindOf(ent.name), bytes: st ? st.size : 0 })
  }
  return { files: acc, incomplete: errors.length > 0, errors }
}
function walkFiles(dir, base = '', depth = 0, acc = [], opts = {}) {
  return walkFilesEx(dir, base, depth, acc, [], opts).files
}
function readTextStore(root, folder) {
  const s = textStore(root, folder)
  try {
    const j = JSON.parse(readFileSync(s.index, 'utf8'))
    return { dir: s.dir, files: Array.isArray(j.files) ? j.files : [] }
  } catch {
    return { dir: s.dir, files: [] }
  }
}

return { SCAN_TTL_MS, STORE_NAMES_MEMO, storeTxtNames, inInternalDir, isAiFillRel, extractableFile, scanProgress, walkFilesEx, walkFiles, readTextStore }
}

export const textStoreService = createTextStoreService()
export const { SCAN_TTL_MS, STORE_NAMES_MEMO, storeTxtNames, inInternalDir, isAiFillRel, extractableFile, scanProgress, walkFilesEx, walkFiles, readTextStore } = textStoreService
