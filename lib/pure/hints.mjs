/**
 * dsh-game-desk · 提示层纯函数
 *
 * 从 lib/index.js 机械搬出（批次 2），函数体一字未改，只加了 export。
 * 口径：只给「名字」（地点 / NPC / 物件 / 顾问），绝不带 fact.text、auditKeywords、solution、trap 等真相字段；
 * 不读盘、不碰全局状态。读盘的 xgameHints 仍在 lib/index.js，由它 import { HINT_MAP, hStr, hSections }。
 *
 * 依赖：./clues.mjs 的 gList（与线索卡层同源）。
 */
import { gList } from './clues.mjs'
export const HINT_LABELS = { investigate: '可以深查', talk: '可以问', go: '可以去', search: '可以勘查', take: '可以拿' }
export const HINT_MAX = 30
// 与 dsh-xgame 的 HIDDEN_LABEL 对齐（朝局四灾）；调查它们要花 2 金。
export const HINT_DISASTERS = ['瘟疫潜伏', '朝堂贪腐', '外敌威胁', '饥荒压力']

export const hStr = (v) => (v == null ? '' : String(v)).trim()
export const hId = (v) => (v && typeof v === 'object' ? hStr(v.id) : hStr(v))
/** 名字容忍四种形态：纯字符串 / {name} / {label} / {title}；都没有就用 id 兜底。 */
export function hName(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v !== 'object') return ''
  return hStr(v.name) || hStr(v.label) || hStr(v.title) || hStr(v.id)
}
/** 一条提示：sub 只在真有话说时才放（契约要求省略而不是 null）。 */
export function hItem(name, sub) {
  const n = hStr(name)
  if (n === '') return null
  const it = { name: n }
  const s = hStr(sub)
  if (s !== '') it.sub = s
  return it
}
/** 段组装：同名只留第一条、丢空条目、截到 30 条；空段整段不出（前端整段不渲染）。
 *  占位条目（it.ph）不按名字去重 —— 整段方块长得一样，靠序号各自成条。 */
export function hSection(key, items) {
  const seen = Object.create(null)
  const out = []
  for (const it of gList(items)) {
    if (!it || hStr(it.name) === '') continue
    const k = it.ph ? '#' + out.length : String(it.name)
    if (seen[k]) continue
    seen[k] = 1
    out.push(it)
    if (out.length >= HINT_MAX) break
  }
  if (!out.length) return null
  return { key: key, label: HINT_LABELS[key], items: out }
}
/** 占位方块：没发现的东西只报「还有几样」，不给名字（用户 2026-11-20 要求）。 */
export const HINT_PH = '·'
export const HINT_PH_MAX = 4
export function hPh(n) {
  const total = Math.max(0, Math.floor(Number(n) || 0))
  const list = []
  const shown = Math.min(total, HINT_PH_MAX)
  for (let i = 0; i < shown; i++) list.push({ name: HINT_PH, ph: 1 })
  if (total > shown) list.push({ name: HINT_PH, ph: 1, sub: '还有 ' + (total - shown) + ' 样没发现' })
  return list
}
export const hSections = (list) => gList(list).filter(Boolean)
/** 地点/区域表容忍字符串与对象两种写法，统一成 {id, name}。 */
export function hPlaces(v) {
  const out = []
  for (const x of gList(v)) {
    const nm = hName(x)
    if (nm === '') continue
    out.push({ id: x && typeof x === 'object' && x.id != null ? String(x.id) : '', name: nm })
  }
  return out
}
/** where：按 id 找，找不到再按名字找，都找不到就原样回 id（不编名字）。 */
export function hWhere(id, places) {
  const key = hStr(id)
  if (key === '') return null
  const list = gList(places)
  const hit = list.find((p) => p.id === key) || list.find((p) => p.name === key) || null
  return { id: key, name: hit ? hit.name : key }
}
/** 时间循环的「谁在这儿」：location/locationId/at → schedule[slice] → home → 没有地点字段=常驻。 */
export function hLoopNpcHere(n, st) {
  if (!n || typeof n !== 'object') return false
  const direct = hStr(n.location) || hStr(n.locationId) || hStr(n.at)
  if (direct !== '') return direct === hStr(st.location)
  const sch = gList(n.schedule)
  if (sch.length) {
    const slice = Number(st.slice)
    // 同一时间片写了几条就按最后一条算（引擎的排期就是这么写的）
    const hit = sch.filter((x) => x && Number(x.slice) === slice).slice(-1)[0]
    return hit ? (hStr(hit.location) || hStr(hit.locationId)) === hStr(st.location) : false
  }
  const home = hStr(n.home) || hStr(n.homeId)
  if (home !== '') return home === hStr(st.location)
  return true
}

/** 发现制开关（用户 2026-11-20 要求，其它玩法照密室的做法）：
 *  引擎在这个玩法里记了 examined 字段才启用；旧存档没有该键 ⇒ 退回老行为（全列）。
 *  kind 缺省时只看「有对象且至少有这一格」，具体格由调用方自己判。 */
export function hTracked(st, key) {
  if (!st || typeof st !== 'object') return false
  if (!Object.prototype.hasOwnProperty.call(st, 'examined')) return false
  const box = st.examined
  if (!box || typeof box !== 'object') return false
  if (key == null) return true
  return Array.isArray(box[key])
}
export function hSeenSet(st, key) {
  const box = st && st.examined
  const arr = box && Array.isArray(box[key]) ? box[key] : []
  return new Set(arr.map(String))
}

/** 时间循环：当前地点 × 当前时间片的可深查对象、在场 NPC、能去哪。 */
export function hintLoop(tr, st) {
  const locs = hPlaces(tr.locations)
  const here = hId(st.location)
  const slice = Number(st.slice)
  const facts = gList(st.facts).map(String)
  const trackT = hTracked(st, 'targets')
  const seenT = hSeenSet(st, 'targets')
  const trackP = hTracked(st, 'places')
  const seenP = hSeenSet(st, 'places')
  let missT = 0
  let missP = 0
  const inv = []
  for (const e of gList(tr.events)) {
    if (!e || !e.investigate) continue
    if (hStr(e.location) !== here) continue
    const from = Number(e.slice)
    const to = e.sliceTo == null ? from : Number(e.sliceTo)
    // slice 缺失就不按时间片过滤（老存档容忍），有就照「先知道，才拿得到」那段窗口判
    if (Number.isFinite(slice) && Number.isFinite(from)) {
      if (!(from <= slice && slice <= (Number.isFinite(to) ? to : from))) continue
    }
    const req = gList(e.investigate.requires).map(String)
    const needMore = req.length > 0 && !req.every((k) => facts.indexOf(k) >= 0)
    const target = hName(e.investigate.target)
    if (trackT && !seenT.has(here + '|' + target)) { missT += 1; continue }
    inv.push(hItem(target, needMore ? '可能需要先查到相关线索' : ''))
  }
  const go = []
  for (const p of locs) {
    if (p.id === here || p.name === here) continue
    if (trackP && !seenP.has(p.id || p.name)) { missP += 1; continue }
    go.push(hItem(p.name))
  }
  for (const x of hPh(missT)) inv.push(x)
  for (const x of hPh(missP)) go.push(x)
  const talk = []
  for (const n of gList(tr.npcs)) {
    const nm = hName(n)
    if (nm === '' || !hLoopNpcHere(n, st)) continue
    talk.push(hItem(nm))
  }
  return { where: hWhere(here, locs), sections: hSections([hSection('investigate', inv), hSection('talk', talk), hSection('go', go)]) }
}

/** 王国议会：能调查＝顾问 + 四灾（四灾要花 2 金），能问＝只有顾问。 */
export function hintCouncil(tr, st) {
  const adv = []
  for (const a of gList(tr.advisors)) {
    const nm = hName(a)
    if (nm !== '') adv.push(nm)
  }
  const talk = adv.map((n) => hItem(n))
  // 「调查」只在议会开着（state.pending 存在）时可用：decide 之后引擎会回「本季尚未开启议会」
  if (!(st && st.pending)) return { where: null, sections: hSections([hSection('talk', talk)]) }
  const exposed = gList(st.exposed).map(String)
  const trackA = hTracked(st, 'advisors')
  const seenA = hSeenSet(st, 'advisors')
  const trackD = hTracked(st, 'disasters')
  const seenD = hSeenSet(st, 'disasters')
  let missA = 0
  let missD = 0
  const inv = []
  for (const a of gList(tr.advisors)) {
    const nm = hName(a)
    const fid = String((a && a.agendaFact) || '')
    if (nm === '' || (fid !== '' && exposed.indexOf(fid) >= 0)) continue
    const aid = String((a && a.id) || nm)
    if (trackA && !seenA.has(aid)) { missA += 1; continue }
    inv.push(hItem(nm, trackA ? '已查过' : ''))
  }
  for (const x of hPh(missA)) inv.push(x)
  for (const d of HINT_DISASTERS) {
    if (trackD && !seenD.has(d)) { missD += 1; continue }
    inv.push(hItem(d, trackD && seenD.has(d) ? '已查过 · 花 2 金' : '花 2 金'))
  }
  for (const x of hPh(missD)) inv.push(x)
  return { where: null, sections: hSections([hSection('investigate', inv), hSection('talk', talk)]) }
}

/** 侦探推理 / 剧本杀：能勘查＝地点（给出「还有 N 处没查」），能问＝嫌疑人。 */
export function hintCase(tr, st) {
  const places = hPlaces(tr.locations)
  const clues = gList(tr.clues)
  const found = gList(st.discoveredClues).map(String)
  const byPlace = Object.create(null)
  for (const c of clues) {
    if (!c) continue
    const pn = hName(c.location)
    if (pn === '') continue
    const key = String(pn)
    if (!byPlace[key]) byPlace[key] = []
    byPlace[key].push(String(c.id))
  }
  // 线索里出现、地点表里没写的地点也放进来（地点表缺失的那份照样能用）
  for (const k of Object.keys(byPlace)) {
    if (!places.some((p) => p.name === k || p.id === k)) places.push({ id: '', name: k })
  }
  const trackP = hTracked(st, 'places')
  const seenRaw = hSeenSet(st, 'places')
  const seenP = new Set(Array.from(seenRaw).map((x) => x.toLowerCase()))
  const hasSeen = (p) => seenP.has(String(p.name).toLowerCase()) || (p.id !== '' && seenP.has(String(p.id).toLowerCase()))
  let missP = 0
  const items = []
  for (const p of places) {
    if (trackP && !hasSeen(p)) { missP += 1; continue }          // 没搜过的地方只报方块，不点名（用户 2026-11-20 要求）
    if (!clues.length) { items.push(hItem(p.name)); continue }   // 没有线索表 ⇒ 算不出 N，只给名字
    const ids = byPlace[p.name] || byPlace[p.id] || []
    if (!ids.length) continue                                    // 这个地点没有线索记录 ⇒ N=0，跳过
    const left = ids.filter((id) => found.indexOf(id) < 0).length
    if (left <= 0) continue                                      // 全查完了就别再提示
    items.push(hItem(p.name, '还有 ' + left + ' 处没查'))
  }
  for (const x of hPh(missP)) items.push(x)
  const talk = []
  for (const s of gList(tr.suspects)) {
    const nm = hName(s)
    if (nm !== '') talk.push(hItem(nm))
  }
  return { where: null, sections: hSections([hSection('search', items), hSection('talk', talk)]) }
}

/** 密室逃脱：where＝当前房间，能勘查＝本房间的 props + 走得出去的门。
 *  发现制（用户 2026-11-20 要求）：只列玩家真的碰过的对象 —— 引擎 examine 会把命中的
 *  prop/item/door 的 id 记进 state.examined = { props, items, doors }（dsh-xgame 2026-11-20 补丁）。
 *  没碰过的只给占位方块 + 「还有 N 样没发现」，不再把房间清单摊开当剧透。
 *  旧存档里根本没有 examined 字段 ⇒ 退回老行为（全列），免得老局突然全是方块。 */
export function hintEscape(tr, st) {
  const rid = hId(st.room) || hId(st.currentRoom) || hId(st.roomId) || hId(st.location)
  if (rid === '') return { where: null, sections: [] }
  const rooms = gList(tr.rooms)
  const room = rooms.find((r) => r && String(r.id) === rid) || null
  const where = { id: rid, name: (room ? hName(room) : '') || rid }
  const tracking = Object.prototype.hasOwnProperty.call(st, 'examined')
  const box = tracking && st.examined && typeof st.examined === 'object' ? st.examined : null
  const setOf = (v) => {
    const s = Object.create(null)
    for (const x of gList(v)) s[String(x)] = 1
    return s
  }
  const seenProps = setOf(box && box.props)
  const seenItems = setOf(box && box.items)
  const seenDoors = setOf(box && box.doors)
  const bag = setOf(st.inventory)
  const opened = setOf(st.openDoors)
  const items = []
  let missProps = 0
  for (const p of gList(tr.props)) {
    if (!p || String(p.roomId) !== rid) continue
    if (!tracking || seenProps[String(p.id)]) items.push(hItem(hName(p)))
    else missProps += 1
  }
  const takes = []
  let missItems = 0
  for (const it of gList(tr.items)) {
    if (!it || typeof it !== 'object') continue
    if (hStr(it.roomId) !== rid) continue
    if (bag[hStr(it.id)]) continue                       // 已经拿在手上，不该再出现在「可以拿」
    if (!tracking || seenItems[hStr(it.id)]) takes.push(hItem(hName(it)))
    else missItems += 1
  }
  const doors = gList(tr.doors).filter((d) => d && typeof d === 'object')
  // 门：优先 from === 当前房间（走得出去的）；整份 doors 压根没有 from 字段时才退回全给
  const hasFrom = doors.some((d) => hStr(d.from) !== '')
  let missDoors = 0
  for (const d of doors) {
    if (hasFrom && hStr(d.from) !== rid) continue
    if (tracking && !seenDoors[hStr(d.id)] && !opened[hStr(d.id)]) { missDoors += 1; continue }
    const nm = hName(d)
    items.push(hItem(nm !== '' ? nm : (hStr(d.to) !== '' ? hStr(d.to) + ' 的门' : '')))
  }
  for (const x of hPh(missProps + missDoors)) items.push(x)
  for (const x of hPh(missItems)) takes.push(x)
  return { where: where, sections: hSections([hSection('take', takes), hSection('search', items)]) }
}

/** 单人跑团：where＝当前区域，能问＝本区域活着的 NPC，能去＝其它区域。 */
export function hintTrpg(tr, st) {
  const rid = hId(st.region) || hId(st.regionId)
  if (rid === '') return { where: null, sections: [] }
  const regions = hPlaces(tr.regions)
  const alive = st.npcAlive && typeof st.npcAlive === 'object' ? st.npcAlive : {}
  const talk = []
  for (const n of gList(tr.npcs)) {
    if (!n || hStr(n.regionId) !== rid) continue
    if (alive[String(n.id)] === false) continue
    const nm = hName(n)
    if (nm !== '') talk.push(hItem(nm))
  }
  const cur = gList(tr.regions).find((r) => r && (hId(r) === rid || hName(r) === rid)) || null
  const adj = cur ? gList(cur.adjacent).map(String) : []
  const go = []
  for (const p of regions) {
    if (p.id === rid || p.name === rid) continue
    // 有相邻表就只列相邻；老存档没有相邻表时退回全列
    if (adj.length && adj.indexOf(String(p.id)) < 0) continue
    go.push(hItem(p.name))
  }
  return { where: hWhere(rid, regions), sections: hSections([hSection('talk', talk), hSection('go', go)]) }
}

export const HINT_MAP = {
  loop: hintLoop,
  council: hintCouncil,
  detective: hintCase,
  party: hintCase,
  escape: hintEscape,
  trpg: hintTrpg,
}
