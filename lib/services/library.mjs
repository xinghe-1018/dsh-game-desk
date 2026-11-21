// lib/services/library.mjs —— 本子库扫描：目录 → 本子条目（含短命 memo 缓存与 TTL）。
// 依赖 services/textstore（遍历 / 文本仓，默认实例可注入）与 core（parseCase / humanName / playersGuess）；
// 缓存 SCAN_MEMO 归本服务实例所有，由 createLibraryService({ ttlMs, scanMemo, textstore }) 注入。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseCase } from '../core/yaml.mjs'
import { humanName, playersGuess } from '../core/text.mjs'
import { cloneData, dirWake } from '../core/util.mjs'
import { textStoreService, SCAN_TTL_MS as __TEXTSTORE_TTL } from './textstore.mjs'

export function createLibraryService({ ttlMs, scanMemo, textstore = textStoreService } = {}) {
// ---- 注入的模块级状态（原 index.js 顶层的 memo / TTL，现在归本服务实例所有）
const SCAN_MEMO = scanMemo ?? new Map() // root -> { at, wake, entries } // root -> { at, wake, entries }

// 注入：textstore 提供遍历/读取（默认 = services/textstore.mjs 的默认实例）。
const { walkFiles, readTextStore, scanProgress } = textstore
const SCAN_TTL_MS = ttlMs ?? __TEXTSTORE_TTL

/** 扫一层子目录（每个本子一个目录，里面 case.yml）。 */
function scanCases(root) {
  const list = []
  if (!existsSync(root)) return list
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return list }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const file = join(root, ent.name, 'case.yml')
    if (!existsSync(file)) continue
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const parsed = parseCase(text)
    const st = (() => { try { return statSync(file) } catch { return null } })()
    // 编号以目录名为准（01-… / 02-…）：case.yml 里 meta.id 常常只写 1、2，按它排会给新本子撞号。
    const pref = /^(\d+)/.exec(ent.name)
    list.push({
      folder: ent.name,
      file,
      dir: join(root, ent.name),
      id: pref ? pref[1].padStart(2, '0') : String(parsed.meta.id ?? ent.name),
      title: String(parsed.meta.title ?? ent.name),
      players: Number(parsed.meta.players ?? parsed.roles.length ?? 0),
      genre: String(parsed.meta.genre ?? ''),
      difficulty: String(parsed.meta.difficulty ?? ''),
      tags: Array.isArray(parsed.meta.tags) ? parsed.meta.tags.map(String) : [],
      victim: parsed.victim,
      premise: parsed.premise,
      imported: parsed.meta.imported === true,
      sourceFolder: String(parsed.meta.source_folder ?? ''),
      // 2026-11-20 P0-8：twin 判据要用来源根；只读 source_folder 时跨库同名资料夹会被当成同一本
      sourceRoot: String(parsed.meta.source_root ?? ''),
      verdict: String(parsed.meta.verdict ?? ''),
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      duration: String(parsed.meta.duration ?? ''),
      roles: parsed.roles,
      warnings: parsed.warnings,
      bytes: st ? st.size : 0,
      mtime: st ? st.mtimeMs : 0,
    })
  }
  list.sort((a, b) => (Number(a.id) - Number(b.id)) || String(a.id).localeCompare(String(b.id), 'zh'))
  return list
}
function packEntry(folder, dir, files) {
  const guess = playersGuess(folder)
  const count = (k) => files.filter((f) => f.kind === k).length
  const top = (rel) => (rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '')
  const groups = {}
  for (const f of files) {
    const g = top(f.rel) || '正文'
    groups[g] = (groups[g] || 0) + 1
  }
  return {
    kind: 'pack',
    folder,
    dir,
    id: (String(folder).match(/^(\d+)/) || [])[1] || '',
    title: humanName(folder),
    players: guess ? (guess.min === guess.max ? guess.min : guess.min + '-' + guess.max) : 0,
    files,
    groups,
    counts: { pdf: count('pdf'), image: count('image'), doc: count('doc'), text: count('text'), all: files.length },
    hasText: false,
    textDir: '',
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    warnings: [],
  }
}
/** 一个根目录下的所有本子：有 case.yml 的按剧本杀结构化本，没有的按资料夹。 */
function scanRoot(root) {
  const rootPath = String(root ?? '')
  // 2026-11-20 P0-1：这个函数是 /api/cases、folderNamesOf、房间心跳的共同底座，之前完全没有缓存。
  // 命中返回深拷贝：调用方（含 withPackMeta 派生层）改不到缓存里的那一份。
  const wake = dirWake(rootPath)
  const now = Date.now()
  const memo = SCAN_MEMO.get(rootPath)
  if (memo && memo.wake === wake && now - memo.at < SCAN_TTL_MS) return cloneData(memo.entries)
  const out = []
  if (!existsSync(rootPath)) return out
  let ents = []
  try { ents = readdirSync(rootPath, { withFileTypes: true }) } catch { return out }
  // 2026-11-20 P0-2：case.yml 解析只做一次 —— 旧实现在循环里对每个 case 目录调一次 scanCases(root)，
  // 9 个结构化本子 = 9 次全目录扫描 + 81 次 case.yml 读取/解析。
  const allCase = scanCases(rootPath)
  for (const ent of ents) {
    if (!ent.isDirectory()) continue
    const dir = join(rootPath, ent.name)
    if (existsSync(join(dir, 'case.yml'))) {
      const hit = allCase.find((c) => c.folder === ent.name)
      if (hit) out.push({ ...hit, kind: 'case' })
      continue
    }
    // 资料夹的「原稿」不含内部目录（_ai_fill/ 等）：文件数/分组不该把 AI 补写的 md 算进去
    const files = walkFiles(dir, '', 0, [], { skipInternal: true })
    if (files.length === 0) continue
    const entry = packEntry(ent.name, dir, files)
    const store = readTextStore(rootPath, ent.name)
    entry.hasText = store.files.length > 0
    entry.textDir = store.dir
    entry.scanned = scanProgress(rootPath, ent.name, files)
    out.push(entry)
  }
  out.sort((a, b) => (Number(a.id) - Number(b.id)) || String(a.title).localeCompare(String(b.title), 'zh'))
  // miss 也存一份拷贝：交出去的那份数组可能被调用方改（派生层是新建对象，但别赌未来）
  SCAN_MEMO.set(rootPath, { at: now, wake, entries: cloneData(out) })
  if (SCAN_MEMO.size > 32) SCAN_MEMO.clear()
  return out
}

return { SCAN_MEMO, scanCases, packEntry, scanRoot }
}

export const libraryService = createLibraryService()
export const { SCAN_MEMO, scanCases, packEntry, scanRoot } = libraryService
