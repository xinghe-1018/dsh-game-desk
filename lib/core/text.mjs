// lib/core/text.mjs —— 文本小工具：压平空白、段落整理、中文数字、人名/人数猜测。
// 纯函数，无 IO、无插件状态。


/** 去掉换行做跨行匹配（中文换行不需要空格；英文单词之间补一个）。 */
export function flatText(s) {
  return String(s)
    .replace(/\r/g, '')
    .replace(/([A-Za-z0-9])\n([A-Za-z0-9])/g, '$1 $2')
    .replace(/\n/g, '')
}

/** 把被 PDF 抽成碎行的一段拼回段落：上一行没有句末标点就继续接。 */
export function tidyParagraph(s) {
  const lines = String(s).replace(/\r/g, '').split('\n').map((x) => x.trim()).filter((x) => x !== '')
  const out = []
  for (const line of lines) {
    const last = out[out.length - 1]
    if (last !== undefined && !/[。！？；：…」』）)\]】]$/.test(last)) out[out.length - 1] = last + line
    else out.push(line)
  }
  return out.join('\n').trim()
}

export const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 「十四条」「4」这类都读成数字。 */
export function cnNumber(raw) {
  const t = String(raw).trim()
  if (/^\d+$/.test(t)) return Number(t)
  if (t === '十') return 10
  if (t.includes('十')) {
    const [a, b] = t.split('十')
    return (a === '' ? 1 : (CN_DIGIT[a] ?? 0)) * 10 + (b === '' ? 0 : (CN_DIGIT[b] ?? 0))
  }
  let n = 0
  for (const ch of t) n = n * 10 + (CN_DIGIT[ch] ?? 0)
  return n
}

/** 目录名去掉编号与「1-4人本」这类前缀，剩下的才是本名。 */
export function humanName(folder) {
  const s = String(folder)
  const a = s.replace(/^\d+\s*[-–—]\s*\d+\s*人本\s*[-_、.．]?\s*/, '')
  const cn = a.replace(/^[单双两三四五六七八九十\d]+\s*人本\s*[-_、.．]?\s*/, '')
  const b = cn.replace(/^\d+\s*人本\s*[-_、.．]?\s*/, '')
  const c = b.replace(/^\d+\s*[-_、.．]\s*/, '')
  return (c.trim() || s)
}

export function playersGuess(folder) {
  const two = /(\d+)\s*[-–—]\s*(\d+)\s*人本/.exec(String(folder))
  if (two) return { min: Number(two[1]), max: Number(two[2]) }
  const cnOne = /([单双两三四五六七八九十\d]+)\s*人本/.exec(String(folder))
  if (cnOne) {
    const map = { 单: 1, 双: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
    const raw = cnOne[1]
    const n = /^\d+$/.test(raw) ? Number(raw) : map[raw] || 0
    if (n) return { min: n, max: n }
  }
  const one = /(\d+)\s*人本/.exec(String(folder))
  if (one) return { min: Number(one[1]), max: Number(one[1]) }
  return null
}
