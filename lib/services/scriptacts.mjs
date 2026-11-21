// lib/services/scriptacts.mjs —— 角色剧本「按幕切」的纯函数（2026-11-20，用户 m00504）。
// 不读磁盘、不发请求：输入是抽好的文本，输出是「第 N 幕 = 哪几页 / 哪一段」。
// 幕标题的实际情况（09 陶宅夜话 / 10 归途 实测）：角色本里有「第一幕」「第一幕任务」
// 「第二幕」「第二幕完成前，请先不要翻开下一页」这几种行；「任务 / 完成前」都是在幕内，
// 不能当新幕起点，所以按「同一幕号只认第一次出现、且跳过含『完成前』的行」来取界。

/** 抽字助手把 PDF 页按 "\n\f\n" 拼起来（lib/index.js 的 pypdf 链路），
 *  这里按同一口径切回页；没有换页符就是单页（md/txt 本子）。 */
export function splitPages(text) {
  const s = String(text == null ? '' : text)
  if (s.indexOf('\f') < 0) return [s]
  return s.split(/\n?\f\n?/).map((p) => p.replace(/\r\n/g, '\n'))
}

/** 每页在整份文本里的起始字符偏移；抽幕里的「第 N 幕」要靠它换算成文本切片。 */
export function pageOffsets(pages) {
  const out = []
  let acc = 0
  for (const p of pages) {
    out.push(acc)
    acc += String(p).length + 3 // 拼回去时每页之间还有一个 "\n\f\n"
  }
  return out
}

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
/** 「三」→3、「十二」→12、「3」→3；认不出返回 0。 */
export function cnNum(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (/^\d{1,4}$/.test(s)) return Number(s)
  if (!s) return 0
  let n = 0
  let cur = 0
  for (const ch of s) {
    if (ch === '十') { cur = (cur || 1) * 10; n += cur; cur = 0 }
    else if (ch === '百') { cur = (cur || 1) * 100; n += cur; cur = 0 }
    else if (Object.prototype.hasOwnProperty.call(CN_DIGIT, ch)) cur = CN_DIGIT[ch]
    else return 0
  }
  return n + cur
}

/** 一行是不是幕标题：行首「第 X 幕」，整行不超过 maxLen 字（正文里顺口提到「第三幕时」不算）。 */
const ACT_LINE = /^第\s*([一二三四五六七八九十百零〇两0-9]{1,4})\s*幕/
export function parseActMarks(pages, opts) {
  const maxLen = (opts && Number(opts.maxLen)) || 24
  const offs = pageOffsets(pages)
  const marks = []
  pages.forEach((p, pi) => {
    const lines = String(p).split('\n')
    let rel = 0
    for (const ln of lines) {
      const t = ln.trim()
      const m = ACT_LINE.exec(t)
      if (m && t.length <= maxLen) {
        marks.push({ n: cnNum(m[1]), page: pi + 1, o: offs[pi] + rel + (ln.length - ln.trimStart().length), text: t })
      }
      rel += ln.length + 1
    }
  })
  return marks
}

/** 幕标题清洗：只留「第 X 幕」这一段 —— 原文常写成「第二幕任务」「第三幕真相解析」，
 *  整行当标签会让三幕看起来不是一套（实测 陶苏 / 真相手册 都这样）。 */
function labelOf(mark) {
  const t = String(mark.text || '').replace(/[【】\[\]]/g, '')
  const m = /第\s*[一二三四五六七八九十百零〇两0-9]{1,4}\s*幕/.exec(t)
  return m ? m[0].replace(/\s+/g, '') : t.slice(0, 16)
}

/** 幕标记 → 幕表。返回 [{ n, label, from, to, o }]（页号 1 起）。
 *  - 同一幕号只认第一次出现（「第一幕任务」不会把第一幕切成两幕）；
 *  - 含「完成前」的行是翻页提示，不当界；
 *  - 第一幕从第 1 页开始（封面/角色简介也算本幕）；
 *  - 没有任何幕标题 ⇒ 一整本算第 1 幕（label「全本」），前端据此退回整份渲染。 */
export function buildActs(marks, pageCount) {
  const total = Math.max(1, Number(pageCount) || 1)
  const first = new Map()
  for (const mk of marks || []) {
    if (!mk || !mk.n || mk.n < 1) continue
    if (/完成前/.test(mk.text || '')) continue
    if (!first.has(mk.n)) first.set(mk.n, mk)
  }
  const ns = Array.from(first.keys()).sort((a, b) => a - b)
  if (ns.length === 0) {
    return [{ n: 1, label: '全本', from: 1, to: total, o: 0 }]
  }
  const acts = []
  for (let i = 0; i < ns.length; i += 1) {
    const mk = first.get(ns[i])
    const from = i === 0 ? 1 : Math.max(1, Math.min(total, mk.page))
    const next = i + 1 < ns.length ? first.get(ns[i + 1]) : null
    let to = next ? Math.max(1, Math.min(total, next.page - 1)) : total
    if (to < from) to = from // 两幕同页：宁可重复这一页，也不给空幕
    acts.push({ n: i + 1, label: labelOf(mk), from, to, o: i === 0 ? 0 : mk.o })
  }
  return acts
}

/** 取第 n 幕（1 起）；越界钳到最后一幕。 */
export function actAt(acts, n) {
  const list = Array.isArray(acts) && acts.length ? acts : [{ n: 1, label: '全本', from: 1, to: 1, o: 0 }]
  const i = Math.max(1, Math.min(list.length, Number(n) || 1)) - 1
  return { act: list[i], index: i + 1, count: list.length }
}

/** 纯文本本子（md/txt）按幕切一段：从本幕起点到下一幕起点。 */
export function sliceActText(text, acts, n) {
  const s = String(text == null ? '' : text)
  const list = Array.isArray(acts) && acts.length ? acts : [{ n: 1, label: '全本', from: 1, to: 1, o: 0 }]
  const i = Math.max(1, Math.min(list.length, Number(n) || 1)) - 1
  const start = Math.max(0, Math.min(s.length, list[i].o || 0))
  const end = i + 1 < list.length ? Math.max(start, Math.min(s.length, list[i + 1].o || s.length)) : s.length
  return s.slice(start, end)
}
