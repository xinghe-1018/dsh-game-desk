/* 案卷台的纯工具函数：从 web/app.js 原样拆出（函数体逐字未改），只依赖入参 ——
   不读 DOM、不碰页面 state、不发请求、不 toast。import 它即可，页面行为与拆分前一致。 */

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}
export function bytes(n) {
  if (!n) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}
export function baseName(p) {
  var parts = String(p || '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(p || '')
}

// 宿主回的错误码一律先过这张表（与 table.js 的房间条同一套口径）：
// 英文码直接上屏等于没翻译 —— 用户只会看到 'no-text' 这种东西。
export var ERR_CN = {
  'no-text': '这份没抽出可读的文字',
  'no-map': '宿主没有这本的档案映射',
  'forbidden': '没有权限（这一步只有房主能做）',
  'not-found': '路径不存在',
  'folder-not-allowed': '这个资料夹不在允许的书库里',
  'route-not-allowed': '这一步只有房主能做（远程/访客页）',
  'owner-only': '这一步只有房主能做（远程/访客页）',
  'room-idle': '房间还没开',
  'room-waiting': '房间还没开局',
  'remote-off': '远程访问没开',
  'remote-quota': '远程额度用完了',
  'remote-daily': '远程每日额度用完了',
  'case-not-ready': '这本还没准备好',
  'paddle-unavailable': '本机 OCR（Paddle）没跑起来',
  'cuda-unavailable': 'CUDA 不可用',
  'engine-unavailable': '解析引擎不可用',
  'keys-required': '要先填密钥',
  'too-many-keys': '密钥太多，只留一个',
  'bad-key': '密钥不对',
  'tunnel-timeout': '公网隧道没起来（超时）'
}
// 认不出的码给一句人话，码留在括号里（排障还要它）；中文错误原样透出。
export function errCn(code, fallback) {
  if (code == null || code === '') return fallback || '未知错误'
  if (typeof code === 'object') return fallback || '未知错误'
  var k = String(code).trim()
  if (!k) return fallback || '未知错误'
  var hit = ERR_CN[k] || ERR_CN[k.toLowerCase()]
  if (hit) return hit
  if (/[\u4e00-\u9fa5]/.test(k)) return k
  return (fallback ? fallback + '：' : '') + '未知错误（' + k + '）'
}
// 带原码的中文错误：屏幕上只读中文，悬停能看到码
export function errHtml(code, fallback) {
  return '<span title="' + esc(String(code == null ? '' : code)) + '">' + esc(errCn(code, fallback)) + '</span>'
}

export var GENRE = { deduction: '推理', drama: '戏剧', emotion: '情感', horror: '恐怖', comedy: '喜剧', suspense: '悬疑', mystery: '本格', imported: '未标注', unknown: '未标注', 未标注: '未标注' }
export var DIFF = { beginner: '新手', easy: '轻松', normal: '标准', standard: '进阶', hard: '硬核', expert: '老手' }
// 与 table.js 的 genreCn 同一口径：认不出的英文键不透出去，一律「未标注」/「未知」，
// 原文留在 title 里（rawTick 交给 fact 的第三参）。
export function genreName(g) {
  var s = String(g == null ? '' : g).trim()
  if (!s) return '未标注'
  if (/[\u4e00-\u9fa5]/.test(s)) return s
  return GENRE[s] || GENRE[s.toLowerCase()] || '未标注'
}
export function diffName(d) {
  var s = String(d == null ? '' : d).trim()
  if (!s) return '未知'
  if (/[\u4e00-\u9fa5]/.test(s)) return s
  return DIFF[s] || DIFF[s.toLowerCase()] || '未知'
}
// 认不出时返回原文（挂 title 用）；认得出来就别重复显示
export function rawTick(v, table) {
  var s = String(v == null ? '' : v).trim()
  if (!s || /[\u4e00-\u9fa5]/.test(s)) return ''
  if (table[s] || table[s.toLowerCase()]) return ''
  return s
}
export function genreOf(c) { return genreName(c && c.genre) }
export function diffOf(c) { return diffName(c && c.difficulty) }

// ---------- 人数 chips：按库里实际存在的 players 动态生成（缺陷2：双人本以前没得筛） ----------
export var CN_NUM = ['', '一人', '双人', '三人', '四人', '五人', '六人', '七人', '八人', '九人', '十人']
export function playersLabel(n) {
  return (n >= 1 && n <= 10) ? CN_NUM[n] : (n + '人')
}
// 人数：/api/cases 的 c.players 可能是 "1-4" 这种区间字符串（正文算出来的 meta.players 只有单个数）。
// 区间给「A–B 人」，单数给「N 人」，已经是中文的就别再加「人」。
export function playersText(v) {
  var s = String(v == null ? '' : v).trim()
  if (!s) return ''
  var m = /^(\d+)\s*[-\u2013\u2014~\uff5e\u81f3]\s*(\d+)$/.exec(s)
  if (m) return m[1] + '\u2013' + m[2] + ' 人'
  if (/^\d+$/.test(s)) return s + ' 人'
  return s
}
export function playersRange(v) {
  return /^(\d+)\s*[-\u2013\u2014~\uff5e\u81f3]\s*(\d+)$/.test(String(v == null ? '' : v).trim())
}

// 列表序号（用户口径：同一库内稳定、不随筛选变化）：
// pack 本的文件夹名多以「1-4人本-」「双人本-」开头，前缀数字恒为 1 —— 以前整列全是「1」；
// 改成「按 folder 排序后的库内序号」两位补零（01…24）。结构化本子自己有 01…09 前缀，保留原样。
export var CASE_NO = { key: '', map: {} }
export function caseNoBase(folder, id) {
  var m = /^(\d+)/.exec(String(folder || ''))
  if (m && m[1]) return m[1].length < 2 ? ('0' + m[1]) : m[1]
  return String(id || '·')
}
export function packNoMap(root, cases) {
  var key = String(root || '') + '|' + (cases || []).length
  if (CASE_NO.key === key && CASE_NO.map) return CASE_NO.map
  var folders = (cases || []).filter(function (c) { return c.kind === 'pack' })
    .map(function (c) { return String(c.folder || '') })
  folders.sort(function (a, b) { return a.localeCompare(b, 'zh') })
  var w = String(folders.length).length
  if (w < 2) w = 2
  var map = {}
  folders.forEach(function (f, i) {
    var n = String(i + 1)
    while (n.length < w) n = '0' + n
    map[f] = n
  })
  CASE_NO = { key: key, map: map }
  return map
}
export function caseNo(c, root, cases) {
  if (c && c.kind === 'pack') {
    var hit = packNoMap(root, cases)[String(c.folder || '')]
    if (hit) return hit
  }
  return caseNoBase(c && c.folder, c && c.id)
}

export function fmtAt(at) {
  if (!at) return ''
  var d = new Date(at)
  if (isNaN(d.getTime())) return ''
  function p2(n) { return n < 10 ? '0' + n : '' + n }
  return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
}

// 房间条上的类型：书库资料夹给的是中文（硬核/还原），导入本 case.yml 里常是英文键（deduction/drama），
// 访客看不懂英文键，统一在这里翻一遍；认不出的原样显示，不藏信息。
export var RB_GENRE = {
  deduction: '推理', mystery: '悬疑', suspense: '悬疑', drama: '剧情', emotion: '情感',
  horror: '恐怖', thriller: '惊悚', comedy: '欢乐', joy: '欢乐', mechanism: '机制',
  camp: '阵营', interactive: '互动', healing: '治愈', scifi: '科幻', 'sci-fi': '科幻',
  spy: '谍战', dark: '暗黑', ancient: '古风', hardcore: '硬核'
}
export function genreCn(g) {
  var s = String(g == null ? '' : g).trim()
  if (s === '') return ''
  if (/[\u4e00-\u9fa5]/.test(s)) return s
  var hit = RB_GENRE[s.toLowerCase()]
  return hit || s
}
