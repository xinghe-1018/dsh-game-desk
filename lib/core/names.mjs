// lib/core/names.mjs —— 抽取产物命名：相对路径 → 稳定文件名，含旧名兼容与撞名裁决。
// 只依赖 node:crypto 与 core/util 的 kindOf；不读盘。
import { createHash } from 'node:crypto'
import { kindOf } from './util.mjs'

/* ---------- 文本缓存文件名（2026-11-20 P0-1） ----------
   旧规则（legacyOutNameOf）：剥掉扩展名、路径分隔换成 __，于是 X.jpg 与 X.pdf 都落成 X.txt，
   后写覆盖先写 —— 一份源文件的文本永久不存在（实证：双人本-双生探案 22 个文件只有 20 条索引）。
   新规则（outNameOf）：保留完整 rel（含扩展名）+ rel 的 8 位 sha1，不同 rel 数学上不可能同名，
   名字仍可人读（人物剧本__普朗克.pdf.7f3a2b19.txt），纯函数、无外部依赖。
   兼容是硬要求：24 本里 400+ 份 txt 是旧名，读取一律「新名 → 旧名」逐级回落，写入一律新名。 */
export const TXT_NAME_EXT_RE = /\.(pdf|txt|md|jpe?g|png|webp|gif)$/i

export function outNameOf(rel) {
  const s = String(rel)
  const h = createHash('sha1').update(s).digest('hex').slice(0, 8)
  return s.replace(/[\\/]/g, '__') + '.' + h + '.txt'
}

export function legacyOutNameOf(rel) {
  return String(rel).replace(/[\\/]/g, '__').replace(TXT_NAME_EXT_RE, '') + '.txt'
}

/** 这一本里每个 rel 该认哪份缓存（纯函数）：{ byRel: Map, legacyOwner: Map, ambiguous: Set }。
 *  优先级：新名在盘上 → 新名；否则旧名在盘上 → 旧名，但同一个旧名被多个 rel 共享时只认一个占位者
 *  （优先非图片、再按 rel 排序），其余 rel 算没有缓存 —— 它们正是当年被覆盖掉的那几份，必须重抽。
 *  present = store 目录里非空 txt 名字的 Set。 */
export function txtNamePlan(rels, present) {
  const byRel = new Map()
  const groups = new Map()
  for (const rel of rels || []) {
    const fresh = outNameOf(rel)
    if (present.has(fresh)) { byRel.set(rel, fresh); continue }
    const lg = legacyOutNameOf(rel)
    if (!groups.has(lg)) groups.set(lg, [])
    groups.get(lg).push(rel)
  }
  const legacyOwner = new Map()
  const ambiguous = new Set()
  for (const [lg, list] of groups) {
    if (!present.has(lg)) continue
    list.sort((a, b) => {
      const ai = kindOf(a) === 'image' ? 1 : 0
      const bi = kindOf(b) === 'image' ? 1 : 0
      return ai - bi || String(a).localeCompare(String(b), 'en')
    })
    byRel.set(list[0], lg)
    legacyOwner.set(lg, list[0])
    for (const rel of list.slice(1)) ambiguous.add(rel)
  }
  return { byRel, legacyOwner, ambiguous }
}
