// lib/services/packs.mjs —— 本子元数据（pack-meta JSON）：读写、AI 补全落地、规格 / 筛检 / 构建。
// 依赖 core（paths / text / util）+ services/textstore + services/library（两个服务实例可注入）；
// PACKMETA_MEMO 归本服务实例所有，由 createPacksService({ packMetaMemo, textstore, library }) 注入。
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { packMetaKey, packMetaDir, packMetaFile } from '../core/paths.mjs'
import { cloneData } from '../core/util.mjs'
import { flatText, tidyParagraph, cnNumber, humanName, playersGuess } from '../core/text.mjs'
import { textStoreService } from './textstore.mjs'
import { libraryService } from './library.mjs'

/* ---------- 资料夹体检标签（用户 m01363，2026-11-19） ----------
   每本 pack 抽完文字顺手落一份 pack-meta：人数 / 类型 / PVP·PVE / 是否全要素 / 缺哪几条 / 判据计数。
   口径（用户 m01367）：只在「用户自己发起的抽取收尾」或「手动重算」时算，boot 不主动补算、不重跑 OCR。
   落盘 ~/.dsh/game-desk/pack-meta/<sha1(root|folder) 前 16 位>.json —— key 与文本缓存（textStore）同一套，
   所以「有 text 缓存 = 有 meta 的候选」，反过来没 meta 就是没抽过/抽在钩子上线之前。 */

export function createPacksService({ packMetaMemo, textstore = textStoreService, library = libraryService } = {}) {
// ---- 注入的模块级状态（原 index.js 顶层的 memo / TTL，现在归本服务实例所有）
const PACKMETA_MEMO = packMetaMemo ?? new Map() // root|folder -> { wake, meta } // root|folder -> { wake, meta }

// 注入：文本仓读取与目录遍历来自 textstore，条目构造来自 library（默认都用它们的默认实例）。
const { readTextStore, walkFiles, isAiFillRel } = textstore
const { packEntry } = library

const PVP_LITERAL = ['对抗本', '阵营本']
const PVE_LITERAL = ['协作本', '合作本']
const PVP_MECH = ['对抗', '阵营', '内奸', '背叛', '竞技', '互相', '凶手在玩家中', '指认']
const PVE_MECH = ['协作', '合作', '共同', '一起逃出', '合力', '团队', '联手']
const GENRE_WORDS = ['硬核', '还原', '推理', '机制', '情感', '恐怖', '欢乐', '阵营', '互动', '悬疑', '惊悚', '本格', '变格', '古风', '民国', '校园', '搞笑', '治愈', '科幻', '谍战', '欢乐向', '暗黑']
/** 给 pack 条目挂体检标签（用户 m01363）：列表接口一次带回，前端不按行发请求。
    meta 只读、不存在就是 null（前端据此标「未体检」并排到最后），不报错、不影响扫目录。 */
function withPackMeta(root, cases) {
  return cases.map((c) => {
    if (c.kind === 'pack') return { ...c, meta: withAiFillMeta(readPackMeta(root, c.folder)) }
    const m = structMetaOf(root, c)
    return m ? { ...c, meta: m } : c
  })
}
/** 导入本（结构化本子）没有 pack-meta 文件，体检结论就写在 case.yml 的 verdict / gaps 里。
 *  这里把它折成与 pack-meta 同形的 meta，好让列表里那套标签（缺 N 项 / 全要素）也用上。
 *  verdict 与 gaps 都空的内置模板本返回 null —— 它们没跑过体检，别凭空宣称「全要素」。 */
function structMetaOf(root, c) {
  const gaps = (Array.isArray(c.gaps) ? c.gaps : []).filter((g) => g && (g.level === 'missing' || g.level === 'warn'))
  const verdict = String(c.verdict || '')
  if (!verdict && gaps.length === 0) return null
  const missing = gaps
    .map((g) => ({
      key: String((g && (g.id ?? g.key)) || ''),
      label: String((g && g.label) || ''),
      level: String((g && g.level) || 'warn'),
      detail: String((g && g.detail) || ''),
    }))
    .filter((g) => g.key)
  const warn = missing.filter((g) => g.level === 'warn').length
  const genre = c.genre && !['未标注', 'imported', 'unknown'].includes(String(c.genre)) ? String(c.genre) : null
  return {
    source: 'case',
    at: Number(c.mtime) || 0,
    root,
    folder: c.folder,
    title: c.title,
    players: Number(c.players) || 0,
    genre,
    pvp: null,
    pvpWhy: '',
    complete: missing.length === 0,
    missing,
    checksSummary: { ok: 0, warn, fail: missing.length - warn, ai: 0, total: missing.length },
    verdict,
    chars: 0,
    fileCount: 0,
  }
}
/** 读不到就当没体检过（不报错、不影响列表）。 */
function readPackMeta(root, folder) {
  // 2026-11-20 P0-3：/api/cases 每次要给 24 本各读一次 meta（readFileSync + JSON.parse）。
  // 唤醒键用文件自身 mtime/ctime/size：写侧是 tmp+rename，rename 后 mtime 必变，不会读到旧标签。
  const key = packMetaKey(root, folder)
  const file = packMetaFile(root, folder)
  let wake = ''
  try {
    const st = statSync(file)
    wake = st.mtimeMs + '|' + st.ctimeMs + '|' + st.size
  } catch { return null }
  const memo = PACKMETA_MEMO.get(key)
  // 命中返回副本：packReview/packFill 会原地改拿到的 meta 再写回去，别让缓存跟着被改脏
  if (memo && memo.wake === wake) return cloneData(memo.meta)
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (!j || typeof j !== 'object' || typeof j.at !== 'string') return null
    PACKMETA_MEMO.set(key, { wake, meta: cloneData(j) })
    if (PACKMETA_MEMO.size > 512) PACKMETA_MEMO.clear()
    return j
  } catch { return null }
}
/** 先写 .tmp 再 rename：列表随时可能读，别让半截 JSON 被读成「没体检」。 */
function writePackMeta(root, folder, meta) {
  const file = packMetaFile(root, folder)
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  try {
    mkdirSync(packMetaDir(), { recursive: true })
    writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
    try { PACKMETA_MEMO.delete(packMetaKey(root, folder)) } catch { /* 清不掉最坏是读回上一份标签，下一次写就换唤醒键了 */ }
    renameSync(tmp, file)
    return meta
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 清不掉就留着，下次覆盖 */ }
    console.info('[game-desk] 体检标签没写成：' + String(e && e.message ? e.message : e))
    return null
  }
}
/** 取出 meta.aiFill.items（只保留对象项）；没有补全记录时返回 {}（不是 null，调用方少判一层）。 */
function aiFillItemsOf(meta) {
  const f = meta && meta.aiFill && typeof meta.aiFill === 'object' ? meta.aiFill : null
  const items = f && f.items && typeof f.items === 'object' ? f.items : null
  const out = {}
  if (!items) return out
  for (const k of Object.keys(items)) {
    const it = items[k]
    if (it && typeof it === 'object') out[String(k)] = it
  }
  return out
}
/** 体检结果按 AI 补全改写（原地补字段并返回 screen；screen 每次都是新造的，不会污染缓存）：
 *  命中项 ai=true / aiChars / aiAt，level 改判 ok（补全之后这一项就算过了），
 *  detail 明确写「AI 补全、不是原稿」并把原体检描述接在后面；verdict 与 checksSummary 一起重算。 */
function applyAiFillToScreen(screen, meta) {
  if (!screen || !Array.isArray(screen.checks)) return screen
  const items = aiFillItemsOf(meta)
  const filled = Object.keys(items)
  let hitN = 0
  let sum = 0
  let latest = ''
  const keys = {}
  for (const c of screen.checks) {
    if (!c || typeof c !== 'object') continue
    const it = items[String(c.id)]
    if (!it) continue
    const chars = Number(it.chars) || 0
    const at = String(it.at || '')
    const oldDetail = String(c.detail || '')
    c.ai = true
    c.aiChars = chars
    c.aiAt = at
    c.level = 'ok'
    c.detail = 'AI 补全（' + chars + ' 字）：原稿没有这一项，是按已有正文补写的，文件在 _ai_fill/，不是原稿' +
      (oldDetail ? '；原体检描述：' + oldDetail : '')
    hitN++
    sum += chars
    if (at > latest) latest = at
    keys[String(c.id)] = { chars, at }
  }
  // 没补过 → null；补过但一项都没对上体检（items 非空、命中 0）→ {count:0,…}，前端据此能区分两者
  screen.aiFill = filled.length > 0 ? { count: hitN, chars: sum, at: latest, keys } : null
  const oks = screen.checks.filter((c) => c && c.level === 'ok').length
  const warns = screen.checks.filter((c) => c && c.level === 'warn').length
  const fails = screen.checks.filter((c) => c && c.level === 'fail').length
  screen.verdict = fails > 0 ? 'blocked' : (warns > 0 ? 'partial' : 'ready')
  screen.checksSummary = { ok: oks, warn: warns, fail: fails, ai: hitN }
  return screen
}
/** 派生「算上 AI 补全」的口径：missing 保持原样（原始缺项，语义不动），另给三项派生字段。
 *  meta 为 null 直接回 null；返回的是浅拷贝，只给前端看，别拿去写盘。
 *  2026-11-20 P1-4：aiComplete 是派生量（= missing 是否已被 aiFill 覆盖完），在这里现算。
 *  以前它被当状态字段搬运，磁盘上留下 aiComplete:true + complete:false + missing:[scripts] 的自相矛盾，
 *  前端 web/app.js:415 又把 aiComplete 当「完成」的充分条件 ⇒ 直接误报补全到位（实证 5de6c77e424c6225）。 */
function withAiFillMeta(meta) {
  if (!meta || typeof meta !== 'object') return null
  const aiFilledKeys = Object.keys(aiFillItemsOf(meta))
  const missing = (Array.isArray(meta.missing) ? meta.missing : []).filter((m) => m && m.key)
  const missingEffective = missing.filter((m) => !aiFilledKeys.includes(String(m.key)))
  return {
    ...meta,
    aiFilledKeys,
    missingEffective,
    completeEffective: missingEffective.length === 0,
    // 现算，覆盖磁盘上可能残留的旧值（readPackMeta 带出来的 aiComplete 一律不可信）
    aiComplete: missingEffective.length === 0,
  }
}
/** 重算/重抽会整份覆盖 pack-meta：aiFill / review 是本子的状态记录、不是体检结论，
 *  丢一次用户的补全账就没了（2026-11-19 核过：refreshPackMeta 与 extractPack 收尾都走整份写）。
 *  只补 next 里没写的字段（next 显式给了就听 next，补全/撤销路由因此不受影响）。
 *  2026-11-20 P1-4：aiComplete 不在这里 —— 它是派生量，由 withAiFillMeta 按 missing 与 aiFill 现算。
 *  2026-11-20 AI 试玩：playtest 也是本子状态记录（一次模型调用的结论），重算/重抽同样不许丢。 */
const META_STATE_FIELDS = ['aiFill', 'review', 'playtest']
function preserveMetaState(root, folder, next) {
  if (!next || typeof next !== 'object') return next
  const old = readPackMeta(root, folder)
  if (!old) return next
  for (const k of META_STATE_FIELDS) {
    if (next[k] === undefined && old[k] !== undefined) next[k] = old[k]
  }
  return next
}

/** 试玩评测的「材料指纹」：正文规模 + 七条判据各自结论拼成的短串。
 *  体检内容一变（重抽文字、补全、复核重算），指纹就变 ⇒ 缓存下来的试玩结论自动算 stale，
 *  免得拿旧结论去说一本已经改过的本子（2026-11-20 AI 试玩）。 */
function screenStamp(screen) {
  if (!screen || !Array.isArray(screen.checks)) return ''
  const rows = screen.checks.map((c) => String(c && c.id) + ':' + String(c && c.level)).join(',')
  return [String(Number(screen.chars) || 0), String(Number(screen.fileCount) || 0), rows].join('|')
}
/** 把 meta.playtest 挂到体检回包上（只给前端看，不回写）：playtestStale=true 表示
 *  「这份结论对应的材料已经不是现在这份了」，前端据此提示重跑（不是错误，只是过期）。 */
function attachPlaytest(screen, meta) {
  if (!screen) return screen
  const p = meta && meta.playtest && typeof meta.playtest === 'object' ? meta.playtest : null
  screen.playtest = p
  screen.playtestStale = p ? String(p.stamp || '') !== screenStamp(screen) : true
  return screen
}
/** 文本里最先出现的那个词（同位置取长的）。 */
function firstWord(text, words) {
  const t = String(text || '')
  let best = ''
  let at = -1
  for (const w of words) {
    const i = t.indexOf(w)
    if (i < 0) continue
    if (at < 0 || i < at || (i === at && w.length > best.length)) { best = w; at = i }
  }
  return best
}
/** PVP/PVE：字面优先 → 机制词推断 → 两边都命中或都不命中就 null（未标注，不硬猜）。 */
function detectSide(flat) {
  const t = String(flat || '')
  const up = t.toUpperCase()
  const litPvp = up.indexOf('PVP') >= 0 || PVP_LITERAL.some((w) => t.indexOf(w) >= 0)
  const litPve = up.indexOf('PVE') >= 0 || PVE_LITERAL.some((w) => t.indexOf(w) >= 0)
  if (litPvp || litPve) {
    if (litPvp && litPve) return { pvp: null, why: '原文里 PVP 与 PVE 字面都出现了，不硬猜' }
    if (litPvp) return { pvp: 'pvp', why: '原文写明了 PVP / 对抗本 / 阵营本' }
    return { pvp: 'pve', why: '原文写明了 PVE / 协作本 / 合作本' }
  }
  const hp = PVP_MECH.filter((w) => t.indexOf(w) >= 0)
  const he = PVE_MECH.filter((w) => t.indexOf(w) >= 0)
  if (hp.length && he.length) return { pvp: null, why: '没有字面；机制词两边都命中（' + hp.join('、') + ' ↔ ' + he.join('、') + '），不硬猜' }
  if (hp.length) return { pvp: 'pvp', why: '没有字面，按机制词推断：' + hp.join('、') }
  if (he.length) return { pvp: 'pve', why: '没有字面，按机制词推断：' + he.join('、') }
  return { pvp: null, why: '原文既没有 PVP/PVE 字面，也没有可用的机制词' }
}
/** 类型：只认原文「剧本类型 / 游戏类型 / 题材 / 类型：」字段里的第一个类型词；取不到退回体检认出的 genre，再没有就 null。 */
function detectGenre(all, spec) {
  const t = String(all || '')
  const re = /(?:剧本类型|游戏类型|题材|类型)[ \t]*[：:][ \t]*([\s\S]{0,120}?)(?=玩家人数|游戏人数|剧本人数|剧本时长|游戏时长|剧本道具|开本准备|难度|$)/g
  let m
  while ((m = re.exec(t)) !== null) {
    const g = firstWord(flatText(m[1]), GENRE_WORDS)
    if (g) return g
    if (re.lastIndex === m.index) re.lastIndex += 1
  }
  const fromSpec = firstWord(String((spec && spec.genre) || ''), GENRE_WORDS)
  return fromSpec || null
}
function readStoreTexts(store) {
  return (store.files || []).filter((f) => !isAiFillRel(f.rel)).map((f) => {
    let text = ''
    try { text = readFileSync(join(store.dir, f.txt), 'utf8') } catch { text = '' }
    return { rel: f.rel, txt: f.txt, chars: text.length, text }
  })
}
/** 从抽出的文字里认「基本面」。认不出的字段留空，不编。 */
function detectSpec(texts, folder) {
  const all = texts.map((t) => t.text).join('\n')
  const flat = flatText(all)
  const spec = { title: humanName(folder), players: 0, playersDetail: '', genre: '', difficulty: '', duration: '', typeText: '', roles: [], premise: '', clueCount: 0, clueCards: 0, clueInline: 0, organizer: 0 }

  // 人数：合集/杂志页会夹别本的「游戏人数：N」——收集全部命中，多值不一致时信资料夹名
  const pVals = []
  const pRe = /(?:(\d{1,2})\s*名玩家|玩家人数[：:]\s*(\d{1,2})|游戏人数[：:]\s*(\d{1,2})|适合\s*(\d{1,2})\s*(?:名|个)?\s*(?:玩家|人))/g
  let pmm
  while ((pmm = pRe.exec(flat)) !== null) { const v = Number(pmm[1] || pmm[2] || pmm[3] || pmm[4]); if (v >= 1 && v <= 12) pVals.push(v) }
  const guess = playersGuess(folder)
  if (pVals.length) {
    const uniq = [...new Set(pVals)]
    if (uniq.length === 1) spec.players = uniq[0]
    else if (guess && uniq.includes(guess.max)) spec.players = guess.max
    else spec.players = uniq[0]
    if (uniq.length > 1) spec.playersDetail = '文本里有 ' + uniq.join('/') + ' 人多个数（可能混了别本的简介）'
  }
  if (!spec.players && guess) {
    spec.players = guess.max
    if (guess.min !== guess.max) spec.playersDetail = guess.min + '–' + guess.max + ' 人（按资料夹名猜的）'
  }
  const split = /(\d+)\s*男\s*(\d+)\s*女/.exec(flat)
  if (split) spec.playersDetail = split[1] + '男' + split[2] + '女'

  const typeLine = /剧本类型[：:]([\s\S]{0,160}?)(?=玩家人数[：:]|剧本时长[：:]|剧本道具[：:]|开本准备|$)/.exec(all)
  if (typeLine) {
    spec.typeText = flatText(typeLine[1]).slice(0, 90)
    const genre = /(硬核还原|还原|推理|机制|情感|恐怖|欢乐|阵营|互动|PVE|PVP)/.exec(spec.typeText)
    if (genre) spec.genre = genre[1]
  }
  const diff = /难度(新手友好|新手|简单|中等偏下|中等偏上|中等|进阶|困难|硬核)/.exec(flat)
  if (diff) spec.difficulty = diff[1]
  const dur = /剧本时长[：:]\s*([0-9][0-9\s\-—~～至到]{0,10}小时)/.exec(flat)
  if (dur) spec.duration = flatText(dur[1]).replace(/\s+/g, '')

  // 角色行：认多种有据可查的写法（「名字（N岁，Mkg）」「名字（性别，N岁）」「名字，性别，N岁」行首）
  const roles = []
  const pushRole = (rawName, age, weight) => {
    const n = String(rawName || '').trim().replace(/^[0-9.\s、:：-]+/, '')
    if (n.length < 2 || n.length > 12 || roles.some((r) => r.name === n)) return
    if (/^(故事|背景|简介|线索|真相|答案|流程|规则|说明|准备|结局|复盘|玩家|组织者|主持人|角色|人物|姓名|性别|年龄|任务|第一|第二|第三|一幕|二幕|三幕|游戏)/.test(n)) return
    roles.push({ name: n, age: Number(age) || 0, weight: Number(weight) || 0, script: '', scriptText: false })
  }
  let m
  const roleRe = /^(.{2,12}?)[（(]\s*(\d{1,2})\s*岁\s*[，,]\s*(\d{1,3})\s*(?:kg|KG|公斤)\s*[）)]/gm
  while ((m = roleRe.exec(all)) !== null) pushRole(m[1], m[2], m[3])
  if (!roles.length) {
    const roleRe2 = /^(.{2,12}?)[（(]\s*(?:男|女)\s*[，,、]?\s*(\d{1,2})\s*岁[^）)]*[）)]/gm
    while ((m = roleRe2.exec(all)) !== null) pushRole(m[1], m[2], 0)
  }
  if (!roles.length) {
    const roleRe3 = /^([^\s，。,；;：:]{2,8}?)[，,]\s*(?:男|女)[，,]\s*(\d{1,2})\s*岁/gm
    while ((m = roleRe3.exec(all)) !== null) pushRole(m[1], m[2], 0)
  }
  spec.roles = roles

  // 引子：多种标题都认（故事背景/简介/开场白/楔子），取第一段像样的
  const bgRe = /(?:故事背景|背景故事|故事简介|剧情简介|内容简介|开场白|楔子)[：:]?\s*([\s\S]*?)(?=剧本类型|玩家人数|游戏人数|剧本时长|剧本道具|开本准备|流程|搜证|$)/g
  let bg
  while ((bg = bgRe.exec(all)) !== null) {
    const p = tidyParagraph(bg[1])
    if (p.length >= 20) { spec.premise = p.slice(0, 4000); break }
  }

  const clueLines = /共有\s*([一二三四五六七八九十\d]+)\s*条/.exec(flat)
  if (clueLines) spec.clueCount = cnNumber(clueLines[1])
  let clueMax = 0
  const clueRe = /线索卡\s*(?:共|共有)?\s*[（(]?\s*(?:[x×]\s*(\d{1,3})|([一二三四五六七八九十\d]+)\s*[）)]?\s*[张条])/g
  let cmm
  while ((cmm = clueRe.exec(flat)) !== null) { const n = cmm[1] ? Number(cmm[1]) : cnNumber(cmm[2]); if (n > clueMax) clueMax = n }
  if (clueMax) spec.clueCards = clueMax
  const clueInline = (flat.match(/线索[一二三四五六七八九十\d]{1,3}[：:、]/g) || []).length
  if (clueInline) spec.clueInline = clueInline

  if (texts.some((t) => /(组织者|主持人|手册|dm|gm)/i.test(t.rel) && !/(玩家|人物|角色)[\s\S]{0,2}手册/.test(t.rel)) || /组织者须知|主持人(?:手册|指南)|组织者手册|DM\s?手册|GM\s?手册|游戏手册|真相手册|上帝视角/.test(flat)) spec.organizer = 1
  return spec
}
/** 评判一本资料夹：七条判据 + 一个结论（ready / partial / blocked）。 */
function screenPack(root, folder, entry, store) {
  const texts = readStoreTexts(store)
  const spec = detectSpec(texts, folder)
  const chars = texts.reduce((n, t) => n + t.chars, 0)
  const extractedRels = new Set(texts.filter((t) => t.chars > 0).map((t) => t.rel))

  // 文件名即角色名的形态（顶层散放：程希.pdf / 陶苏.pdf）——手册/线索/答题这类先排掉
  const NON_ROLE = /手册|组织者|主持|真相|规则|说明|准备|答题|答案|线索|复盘|结局|正文|流程|简介|封面|目录|dm|handbook|clue|guide|rule/i
  if (!spec.roles.length) {
    const stemOf = (f) => String(f.rel).split('/').pop().replace(/\.[^.]+$/, '').replace(/^\d+\s*[-_.、]\s*/, '')
    const titleish = humanName(folder)
    const uniq = []
    for (const f of entry.files) {
      if (f.kind !== 'pdf' && f.kind !== 'doc' && f.kind !== 'text') continue
      if (NON_ROLE.test(f.rel)) continue
      const n = stemOf(f)
      if (n.length < 2 || n.length > 12 || n === titleish || titleish.includes(n)) continue
      if (!uniq.some((u) => u.name === n)) uniq.push({ name: n, age: 0, weight: 0, script: '', scriptText: false })
    }
    if (uniq.length >= 2) { spec.roles = uniq; spec.rolesFrom = 'files' }
  }
  // 人物剧本对位：角色名能对上文件名的那份 PDF（分组散放都收）
  const scriptFiles = entry.files.filter((f) => f.kind === 'pdf' && !NON_ROLE.test(f.rel))
  for (const r of spec.roles) {
    const hit = scriptFiles.find((f) => f.name.includes(r.name)) || null
    r.script = hit ? hit.rel : ''
    r.scriptText = hit ? extractedRels.has(hit.rel) : false
  }
  const paired = spec.roles.filter((r) => r.script !== '').length
  const readable = spec.roles.filter((r) => r.scriptText).length
  const unread = spec.roles.filter((r) => r.script && !r.scriptText).map((r) => r.name)
  // 没独立文件的角色：在正文里找角色小节（「X剧本 / X的剧本 / 你是X / 【X】」）——有就别喊缺
  const flatAll = flatText(texts.map((t) => t.text).join('\n'))
  const escName = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let inlineN = 0
  for (const r of spec.roles) {
    if (r.script) continue
    const n = escName(r.name)
    const re = new RegExp(n + '(?:的)?剧本|剧本[：:]?\\s*' + n + '|【\\s*' + n + '\\s*】|你是' + n)
    r.scriptInline = re.test(flatAll)
    if (r.scriptInline) inlineN++
  }
  const totalRoles = spec.roles.length
  const haveScripts = readable + inlineN

  const checks = []
  const add = (id, label, ok, detail, hard) => checks.push({ id, label, level: ok ? 'ok' : (hard ? 'fail' : 'warn'), detail })
  add('text', '抽出了可读文字', chars >= 800, chars === 0 ? '一份也没抽出来（扫描件或字体加密）' : chars + ' 字', true)
  add('manual', '有组织者手册', Boolean(spec.organizer), spec.organizer ? '认出「组织者须知 / 主持人手册 / 游戏手册 / 真相手册」' : '没认出组织者手册——也可能写法不同，到 _text/ 搜「手册/须知/真相」再定', false)
  add('players', '人数可判定', spec.players > 0, spec.players > 0 ? spec.players + ' 人' + (spec.playersDetail ? '（' + spec.playersDetail + '）' : '') : '没找到「N名玩家 / 玩家人数 / 游戏人数 / 适合N人」', false)
  add('roles', '角色可拆解', spec.roles.length >= 2, spec.roles.length >= 2 ? spec.roles.map((r) => r.name).join(' / ') + (spec.rolesFrom === 'files' ? '（按文件名认出）' : '') : '没认出角色行（「名字（N岁，Mkg）」「名字（性别，N岁）」「名字，性别，N岁」），文件名也没认出——写法可能不同，翻 _text/ 找找', false)
  add('premise', '引子可提取', spec.premise !== '', spec.premise === '' ? '没认出「故事背景/简介/开场白/楔子」类标题——引子可能就写在人物剧本开头，翻 _text/ 看看' : '已提取 ' + spec.premise.length + ' 字', false)
  add('scripts', '人物剧本可对位', totalRoles > 0 && haveScripts >= totalRoles,
    totalRoles === 0 ? '先过「角色可拆解」这关'
      : haveScripts >= totalRoles ? (inlineN === 0 ? totalRoles + ' 份都有独立文件且抽得出字' : readable + ' 份有独立文件，' + inlineN + ' 份在正文里找到角色小节（没独立文件，不算缺）')
        : unread.length ? totalRoles + ' 份里 ' + readable + ' 份抽出了字；抽不出字的：' + unread.join('、') + '（多半是扫描件——先跑 OCR 再重导，不是缺件）'
          : (paired > 0 ? paired + ' 份文件名对上了，但 PDF 抽不出文字（扫描件 / 字体加密）' : '没找到带角色名的人物剧本，正文里也没搜到角色小节'),
    false)
  const clueFiles = entry.files.filter((f) => /线索|clue/i.test(f.rel)).length
  const clueDetail = spec.clueCount > 0 || spec.clueCards > 0
    ? (spec.clueCount || spec.clueCards) + ' 条线索' + (spec.clueCount && spec.clueCards && spec.clueCount !== spec.clueCards ? '（另标 ' + spec.clueCards + ' 张卡）' : '')
      : (clueFiles > 0 ? clueFiles + ' 个线索文件，条数未标注'
        : ((spec.clueInline || 0) >= 3 ? '正文里有 ' + spec.clueInline + ' 处线索小节（没独立文件）' : '没找到线索：文件名、条数标注、正文小节都没——也可能写法不同，到 _text/ 搜「线索」'))
  add('clues', '线索有下落', spec.clueCount > 0 || clueFiles > 0 || spec.clueCards > 0 || (spec.clueInline || 0) >= 3, clueDetail, false)

  const fails = checks.filter((c) => c.level === 'fail').length
  const warns = checks.filter((c) => c.level === 'warn').length
  const verdict = fails > 0 ? 'blocked' : (warns > 0 ? 'partial' : 'ready')
  return {
    folder,
    title: spec.title,
    verdict,
    checks,
    spec,
    chars,
    fileCount: entry.files.length,
    texts: texts.map((t) => ({ rel: t.rel, txt: t.txt, chars: t.chars })),
  }
}
/** 一本 pack 的体检标签（纯函数：只读传进来的 store，不写盘）。 */
function buildPackMeta(root, folder, entry, store) {
  const screen = screenPack(root, folder, entry, store)
  const texts = readStoreTexts(store)
  const all = texts.map((x) => x.text).join('\n')
  const spec = screen.spec || {}
  const checks = screen.checks || []
  const side = detectSide(flatText(all))
  const missing = checks
    .filter((c) => c.level !== 'ok')
    .map((c) => ({ key: c.id, label: c.label, level: c.level, detail: String(c.detail || '').slice(0, 160) }))
  return {
    at: new Date().toISOString(),
    root,
    folder,
    title: screen.title,
    players: Number(spec.players) || 0,
    genre: detectGenre(all, spec),
    pvp: side.pvp,
    pvpWhy: side.why,
    complete: missing.length === 0,
    missing,
    checksSummary: {
      ok: checks.filter((c) => c.level === 'ok').length,
      warn: checks.filter((c) => c.level === 'warn').length,
      missing: checks.filter((c) => c.level === 'fail').length,
      total: checks.length,
    },
    verdict: screen.verdict,
    chars: screen.chars,
    fileCount: screen.fileCount,
  }
}
/** 只读文本缓存重算一本（不启 OCR、不碰 text store）。没抽出过字就返回 null（不写空标签）。 */
function refreshPackMeta(root, folder, entry) {
  const store = readTextStore(root, folder)
  const files = (store.files || []).filter((f) => {
    try { return statSync(join(store.dir, f.txt)).size > 0 } catch { return false }
  })
  if (files.length === 0) return null
  const pack = entry || packEntry(folder, join(root, folder), walkFiles(join(root, folder)))
  const next = buildPackMeta(root, folder, pack, { dir: store.dir, files })
  // 重算只更新体检结论；aiFill / review 是补全账与复核记录，必须从旧 meta 带过来
  // （2026-11-19：原来这里直接整份覆盖，点一次「重算标签」补全记录就全丢了）。
  return writePackMeta(root, folder, preserveMetaState(root, folder, next))
}

return { PACKMETA_MEMO, PVP_LITERAL, PVE_LITERAL, PVP_MECH, PVE_MECH, GENRE_WORDS, withPackMeta, readPackMeta, writePackMeta, aiFillItemsOf, applyAiFillToScreen, withAiFillMeta, META_STATE_FIELDS, preserveMetaState, screenStamp, attachPlaytest, firstWord, detectSide, detectGenre, readStoreTexts, detectSpec, screenPack, buildPackMeta, refreshPackMeta }
}

export const packsService = createPacksService()
export const { PACKMETA_MEMO, PVP_LITERAL, PVE_LITERAL, PVP_MECH, PVE_MECH, GENRE_WORDS, withPackMeta, readPackMeta, writePackMeta, aiFillItemsOf, applyAiFillToScreen, withAiFillMeta, META_STATE_FIELDS, preserveMetaState, screenStamp, attachPlaytest, firstWord, detectSide, detectGenre, readStoreTexts, detectSpec, screenPack, buildPackMeta, refreshPackMeta } = packsService
