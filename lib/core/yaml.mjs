// lib/core/yaml.mjs —— 只认本插件那几种形态的轻量 YAML 解析/写出（case.yml 的 meta / scene / roles / gaps）。
// 纯函数；写出侧 yamlScalar / blockScalar 与解析侧 stripQuotes / scalar 必须成对使用。


/** 只挑本库需要的两个字段，其余原样交给页面（页面自己决定怎么展示）。
 *  2026-11-20 数据一致性修复（P0-3）：写侧 yamlScalar 把反斜杠写成两个、把双引号写成 \"，
 *  读侧过去完全不解转义，于是 source_root 读回来是 D:\Baidu... 的双反斜杠，参与 sha1(root|folder)
 *  算出幽灵 store（实证：cases\09-陶宅夜话 算出 cda31410a485f546，真 key 是 f58f245be6a7510b）。
 *  读写必须对称：能按 JSON 解就按 JSON 解，解不了再退化成只认 \\ 与 \" 的扫描器。 */
export function stripQuotes(v) {
  const s = String(v).trim()
  const q = s.length >= 2 ? s.charAt(0) : ''
  if ((q === '"' || q === "'") && s.charAt(s.length - 1) === q) {
    const inner = s.slice(1, -1)
    if (q === "'") return inner.replace(/''/g, "'")
    try {
      const j = JSON.parse(s)
      if (typeof j === 'string') return j
    } catch { /* 手写的半截转义（如 "D:\Baidu"）：下面的扫描器救回来 */ }
    return inner.replace(/\\(["\\])/g, '$1')
  }
  return s
}

export function scalar(v) {
  const s = stripQuotes(v)
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map((x) => stripQuotes(x)).filter((x) => x !== '')
  }
  if (/^\d+$/.test(s)) return Number(s)
  if (s === 'true') return true
  if (s === 'false') return false
  return s
}

/**
 * 只认本子库要用的那几处：meta.*（id / title / players / genre / difficulty / tags）、
 * scene.setup 的第一段、scene.victim.name、roles 的座位表。
 * 不引 yaml 依赖，是因为这里只需读到「列表卡片上那几个字」，真正的校验留给 jubensha_case load。
 */
export function parseCase(text) {
  const out = { meta: {}, roles: [], gaps: [], brief: '', premise: '', victim: '', warnings: [] }
  const lines = String(text).split(/\r?\n/)
  let section = ''
  let inBlock = ''
  let blockIndent = 0
  const block = []
  const flush = () => {
    if (inBlock === 'scene.setup') out.brief = block.join('\n').trim()
    if (inBlock === 'scene.premise') out.premise = block.join('\n').trim()
    inBlock = ''
    block.length = 0
  }
  for (const raw of lines) {
    if (raw.trim() === '' ) { if (inBlock) block.push(''); continue }
    const indent = raw.length - raw.replace(/^\s+/, '').length
    if (inBlock) {
      if (indent > blockIndent) { block.push(raw.trim()); continue }
      flush()
    }
    const top = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(raw)
    if (top && indent === 0) { section = top[1]; continue }
    if (section === 'meta') {
      const kv = /^\s{1,4}([A-Za-z_][\w]*):\s*(.*)$/.exec(raw)
      if (kv) out.meta[kv[1]] = scalar(kv[2])
      continue
    }
    if (section === 'scene') {
      const setup = /^\s{1,4}setup:\s*\|\s*$/.exec(raw)
      if (setup) { inBlock = 'scene.setup'; blockIndent = indent; continue }
      const premise = /^\s{1,4}premise:\s*\|\s*$/.exec(raw)
      if (premise) { inBlock = 'scene.premise'; blockIndent = indent; continue }
      const victim = /^\s{2,6}name:\s*(.+)$/.exec(raw)
      if (victim && /victim:/.test(lines[lines.indexOf(raw) - 1] || '')) out.victim = stripQuotes(victim[1])
      continue
    }
    if (section === 'roles') {
      const id = /^\s*-\s*id:\s*(.+)$/.exec(raw)
      if (id) { out.roles.push({ id: stripQuotes(id[1]), name: '', player: 'ai' }); continue }
      const nm = /^\s{2,6}name:\s*(.+)$/.exec(raw)
      if (nm && out.roles.length > 0) { out.roles[out.roles.length - 1].name = stripQuotes(nm[1]); continue }
      const pl = /^\s{2,6}player:\s*(.+)$/.exec(raw)
      if (pl && out.roles.length > 0) { out.roles[out.roles.length - 1].player = stripQuotes(pl[1]); continue }
      continue
    }
    if (section === 'gaps') {
      const gid = /^\s*-\s*id:\s*(.+)$/.exec(raw)
      if (gid) { out.gaps.push({ id: stripQuotes(gid[1]), label: '', level: 'warn', detail: '' }); continue }
      const gk = /^\s{2,6}(label|level|detail):\s*(.+)$/.exec(raw)
      if (gk && out.gaps.length) { out.gaps[out.gaps.length - 1][gk[1]] = stripQuotes(gk[2]); continue }
    }
  }
  if (inBlock) flush()
  if (!out.meta.title) out.warnings.push('meta.title 缺失')
  if (out.roles.length === 0) out.warnings.push('roles 为空')
  return out
}

export function yamlScalar(v) {
  // 2026-11-20 P0-3：改用 JSON 写法（YAML 双引号串的转义集合包含 JSON 那一套，JSON 串本身就是合法 YAML），
  // 读侧 stripQuotes 按 JSON.parse 还原 —— 写读对称；旧 case.yml 里的双反斜杠也能正确解回单反斜杠。
  return JSON.stringify(String(v === undefined || v === null ? '' : v))
}

export function blockScalar(text, indent) {
  return String(text).replace(/\r/g, '').split('\n').map((l) => (l === '' ? indent + '  ' : indent + l)).join('\n')
}
