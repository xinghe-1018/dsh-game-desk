/**
 * dsh-game-desk · 线索卡纯函数层
 *
 * 从 lib/index.js 机械搬出（批次 1），函数体一字未改，只加了 export。
 * 纯计算：引擎 id → 人话、问句二元字组、命中判定、CLUE_MAP（六种玩法的卡表与结局文案）。
 * 不读盘、不碰 ROOM / SEATS / 全局缓存；读盘的 xgameClues / xgameUnlock 仍在 lib/index.js，
 * 由它 import { CLUE_MAP } 与 { gList }。
 */
/** 引擎内部 id 换成人话：房间名、物品名；出口这种内部标记（__outside）单独给词。 */
export function gNamed(list, id) {
  const key = String(id == null ? '' : id)
  const hit = gList(list).find((x) => x && String(x.id) === key)
  if (hit) return String(hit.name || hit.id || key)
  if (key === '' ) return '?'
  if (key === '__outside') return '屋外'
  return key
}
/** 做「问句里到底碰到了这条事实多少」用：CJK 取二字滑窗，英文按词，太小/重复的丢掉。 */
export function gShingles(text) {
  const t = gNorm(text)
  const out = []
  const cjk = t.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i + 2 <= cjk.length; i++) {
    const g = cjk.slice(i, i + 2)
    if (out.indexOf(g) < 0) out.push(g)
  }
  const words = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
  for (const w of words) if (out.indexOf(w) < 0) out.push(w)
  return out
}
export const gNorm = (v) => String(v == null ? '' : v).toLowerCase().replace(/\s+/g, '').replace(/[?？!！,。.、]/g, '')
export const gList = (v) => (Array.isArray(v) ? v : [])
export const gHit = (list, id) => gList(list).map(String).includes(String(id))
export const gCard = (id, on, text) => ({ id: String(id), on: Boolean(on), text: on ? String(text == null ? '' : text) : null })

export const CLUE_MAP = {
  soup: {
    title: '重大线索 · 汤底解锁', endTitle: '解锁汤底',
    cards: (t, s) => {
      const qs = gList(s.questions).map((q) => (q && typeof q === 'object' ? q : { q: q }))
      const asked = qs.map((q) => gNorm(q.q))
      const yesAsked = qs.filter((q) => String(q.verdict || '') === 'yes').map((q) => gShingles(q.q))
      return gList(t.factPoints).filter((p) => p && p.core === true).map((p) => {
        const text = String(p.text || '')
        const head2 = gNorm(text.slice(0, 8))
        // ①引擎记账优先；②问句里原样带了事实前八字；③「答是」的问题与这条事实至少有 2 个二元字组重合
        //   —— 引擎有 4 张卡（hospital-light / funeral / desert-match / seaweed）的规则抢在过账之前命中，
        //      核心事实结构上永不入 coreHits；不兜底就是「问对了也永远解不开」（2026-11-20 端到端实测）
        const sh = gShingles(text)
        let on = gHit(s.coreHits, p.key)
        if (!on && head2 !== '' && asked.some((q) => q.includes(head2))) on = true
        if (!on && sh.length) {
          on = yesAsked.some((qs2) => {
            let hit = 0
            for (const g of sh) if (qs2.indexOf(g) >= 0) hit++
            return hit >= 2
          })
        }
        return gCard(p.key, on, p.text)
      })
    },
    ending: (t) => [String(t.surface || ''), '', '—— 汤底 ——', '', String(t.truth || '')].join('\n'),
  },
  detective: {
    title: '重大线索 · 结案解锁', endTitle: '解锁真相',
    cards: (t, s) => gList(t.clues).map((c) => gCard(c.id, gHit(s.discoveredClues, c.id), (c.location ? c.location + '：' : '') + String(c.description || ''))),
    ending: (t) => {
      const sol = t.solution || {}
      return '凶手：' + String(t.murderer || '?') + '\n手法：' + String(sol.means || '?') + '\n动机：' + String(sol.motive || '?') + '\n机会：' + String(sol.opportunity || '?')
    },
  },
  party: {
    title: '重大线索 · 结案解锁', endTitle: '解锁真相',
    cards: (t, s) => gList(t.clues).map((c) => gCard(c.id, gHit(s.discoveredClues, c.id), (c.location ? c.location + '：' : '') + String(c.description || ''))),
    ending: (t) => {
      const sol = t.solution || {}
      return '凶手：' + String(t.murderer || '?') + '\n手法：' + String(sol.means || '?') + '\n动机：' + String(sol.motive || '?') + '\n机会：' + String(sol.opportunity || '?')
    },
  },
  escape: {
    title: '重大线索 · 逃脱解锁', endTitle: '解锁谜底',
    cards: (t, s) => {
      const cards = gList(t.puzzles).map((p) => gCard('puzzle:' + p.id, gHit(s.solved, p.id), String(p.name || p.id) + ' 的谜底：' + String(p.answer || '')))
      for (const d of gList(t.doors)) cards.push(gCard('door:' + d.id, gHit(s.openDoors, d.id), String(d.name || d.id) + '（通往 ' + gNamed(t.rooms, d.to) + '）已开'))
      return cards
    },
    // 门是进度展示，解锁只看谜底是否全开
    complete: (cards) => {
      const pz = cards.filter((c) => String(c.id).indexOf('puzzle:') === 0)
      return pz.length > 0 && pz.every((c) => c.on)
    },
    ending: (t) => {
      const lines = gList(t.puzzles).map((p) => String(p.name || p.id) + '：' + String(p.answer || ''))
      const chain = gList(t.doors).map((d) => {
        const lb = d.lockedBy || {}
        const lock = lb.item ? '用「' + gNamed(t.items, lb.item) + '」开' : lb.hint ? String(lb.hint) : '直接可开'
        return gNamed(t.rooms, d.from) + ' → ' + gNamed(t.rooms, d.to) + '（' + String(d.name || d.id) + '）：' + lock
      })
      return '各谜底：\n' + lines.join('\n') + '\n\n出口链：\n' + chain.join('\n')
    },
  },
  loop: {
    title: '重大线索 · 真相解锁', endTitle: '解锁因果',
    // 元知识在 state.facts（"先知道，才拿得到"）；cutEdges 每轮回零，不能用
    cards: (t, s) => gList(t.facts).map((f) => gCard(f.id, gHit(s.facts, f.id), String(f.text || ''))),
    complete: (cards, lit, total) => total > 0 && lit / total >= 0.7,
    ending: (t) => {
      const notes = t.edgeNotes && typeof t.edgeNotes === 'object' ? t.edgeNotes : {}
      const lines = gList(t.causalEdges).map((e) => String(e.from || '?') + ' → ' + String(e.to || '?') + '：' + String(e.note || notes[String(e.id || '')] || ''))
      for (const k of Object.keys(notes)) if (!gList(t.causalEdges).some((e) => String(e.id || '') === k)) lines.push(String(k) + '：' + String(notes[k]))
      return '因果边全表：\n' + lines.join('\n')
    },
  },
  council: {
    title: '重大线索 · 朝局解锁', endTitle: '解锁隐祸',
    cards: (t, s) => {
      const facts = gList(t.facts)
      const byId = Object.create(null)
      for (const f of facts) if (f && f.id) byId[String(f.id)] = f
      const out = []
      for (const a of gList(t.advisors)) {
        const fid = String((a && a.agendaFact) || '')
        if (fid === '' || !byId[fid]) continue
        out.push(gCard(fid, gHit(s.exposed, fid), String(byId[fid].text || '')))
      }
      // f_spy_enemy / f_spy_court / f_spy_loyal 互斥，本局只会曝光其中一条 ⇒ 只按顾问藏的那条出卡
      if (out.length) return out
      return facts.map((f) => gCard(f.id, gHit(s.exposed, f.id), String(f.text || '')))
    },
    ending: (t, s) => {
      const N = { plague: '瘟疫', corruption: '朝堂贪腐', threat: '外敌', famine: '饥荒' }
      const hid = (s && s.hidden) || {}
      const ex = gList(s && s.exploded).map((x) => String(x && x.kind ? x.kind : x))
      return '四灾真值：\n' + Object.keys(N).map((k) => N[k] + '：终局压力 ' + Math.round(Number(hid[k] || 0) * 100) + '%' + (ex.includes(k) ? '（已引爆）' : '（未引爆）')).join('\n')
    },
  },
  trpg: {
    title: '重大线索 · 主线解锁', endTitle: '解锁主线',
    cards: (t, s) => gList(t.quests).map((q) => {
      const obj = gList(q.objectives).map((o) => String(o && typeof o === 'object' ? o.id : o))
      const on = obj.length ? obj.every((id) => gHit(s.questDone, id)) : gHit(s.questDone, q.id)
      return gCard(q.id, on, String(q.title || q.id))
    }),
    ending: (t) => '主线全貌：\n' + gList(t.quests).map((q) => {
      const obj = gList(q.objectives).map((o) => '  - ' + String(o.desc || o.id)).join('\n')
      const rw = q.reward ? '（奖励：金 ' + String(q.reward.gold) + ' · XP ' + String(q.reward.xp) + '）' : ''
      return '【' + String(q.title || q.id) + '｜' + String(q.type || '') + '】' + rw + '\n' + obj
    }).join('\n\n'),
  },
}
