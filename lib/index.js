/**
 * dsh-game-desk（案卷台）—— 把「剧本杀」与「游戏厅」两个入口放进左侧入口栏，
 * 并在内容区给它们一个共用的壳：本子库 + 选本 + 一键开局。
 *
 * 形态：
 * - 宿主半只干两件事：① 管那个放本子的文件夹（扫描 / 读 / 新建 / 打开资源管理器）；
 *   ② 把 web/ 下的静态页挂到 /game-desk/app（客户端那半把它塞进 main 面板的 iframe）。
 * - 开局不是宿主半做的：页面把一段开局指令 postMessage 给客户端半，由它走
 *   document.execCommand('insertText') 填进对话输入框 —— 那条路是 React 收得到的
 *   （见 @max-null/dsh-jubensha 的 fillComposer），宿主半没有"往会话里说话"的口子。
 *
 * 零 core 依赖：只用 node 内置 + cordis 鸭型契约（name / inject / apply）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { basename, dirname, join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn, execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'

export const name = 'game-desk'
export const inject = ['webServer']
export const ROUTE = '/game-desk'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = resolve(HERE, '..', 'web')

const DEFAULTS = {
  /** 本子库根目录；'' = $DSH_HOME/game-desk/cases */
  casesDir: '',
  /** 首次加载时把 jubensha 自带的 7 个本子拷进来 */
  seedFromJubensha: true,
  /** 额外的书库根目录（任意文件夹，里面一个本子一个子目录；没有 case.yml 就按资料夹展示） */
  libraryRoots: [],
  /** OCR：'auto' = PDF 抽不出字时先用 rapid，仍空再用 vl；'off' = 完全不 OCR */
  ocrEngine: 'auto',
  /** 兜底用 Qwen3-VL-2B（慢，占显存）；关掉就只用 RapidOCR */
  ocrVlFallback: true,
  /** 整本几乎没字时，把线索图也 OCR 一遍 */
  ocrImages: true,
}

/** 七种玩法的目录（与 dsh-xgame 的 /game new 对齐）。 */
const CATALOG = [
  { id: 'soup', no: '01', name: '海龟汤', command: '/game new soup', tag: '十分钟', players: '1人 + AI', line: '一个说不通的结局，靠问是/否把汤底捞出来。', note: '问题有次数限制，猜中即揭底。' },
  { id: 'detective', no: '02', name: '侦探推理', command: '/game new detective', tag: '单人', players: '1人 + AI', line: '现场有六处可查，凶手只有一个，证据链自己拼。', note: '可搜查、可审讯、可出示证物；真相封在插件里。' },
  { id: 'escape', no: '03', name: '密室逃脱', command: '/game new escape', tag: '机关', players: '1人', line: '一间锁着的屋子，几件能拿的东西，一个只能推一次的机关。', note: '观察、拿取、组合、使用，全由状态机裁决。' },
  { id: 'party', no: '04', name: '剧本杀·反转', command: '/game new party', tag: '多人', players: '1人 + AI 侦探团', line: '你是凶手，要在质询轮里守住那套公开说辞。', note: '嫌疑度只有引擎能改，搜证与陈述都算数。' },
  { id: 'loop', no: '05', name: '时间循环', command: '/game new loop', tag: '因果', players: '1人 + AI', line: '同一日重复到 19:00，只有你的元知识能带走。', note: '切断因果边，把悲剧改成完美一日。' },
  { id: 'council', no: '06', name: '王国议会', command: '/game new council', tag: '二十季', players: '1人 + AI 顾问', line: '四位顾问各怀立场，你要在账本与信任之间拍板。', note: '决策会引爆隐藏祸患，顾问也会记仇。' },
  { id: 'trpg', no: '07', name: '单人跑团', command: '/game new trpg', tag: '骰子', players: '1人 + AI 队友', line: '一格一格走，遇敌掷骰，休整三次。', note: '技能检定由种子骰裁决，剧情由主持人渲染。' },
]

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
}

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

function caseRoot(cfg) {
  return cfg.casesDir && cfg.casesDir.trim() !== '' ? resolve(cfg.casesDir) : join(dshHome(), 'game-desk', 'cases')
}

/** 只挑本库需要的两个字段，其余原样交给页面（页面自己决定怎么展示）。 */
function stripQuotes(v) {
  const s = String(v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

function scalar(v) {
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
function parseCase(text) {
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

/* ------------------------------------------------------------------ *
 * 书库：不要求本子是 case.yml —— 从别处拿来的 PDF 资料夹也照样能读
 * ------------------------------------------------------------------ */

/** 书库根目录：① 本子库 ② 配置里声明的 ③ 页面上添加过并落到 library.json 的。 */
function libraryFile() {
  return join(dshHome(), 'game-desk', 'library.json')
}

function readLibrary() {
  try {
    const j = JSON.parse(readFileSync(libraryFile(), 'utf8'))
    return Array.isArray(j.roots) ? j.roots.filter((x) => typeof x === 'string' && x.trim() !== '') : []
  } catch {
    return []
  }
}

function writeLibrary(roots) {
  try {
    mkdirSync(dirname(libraryFile()), { recursive: true })
    writeFileSync(libraryFile(), JSON.stringify({ roots }, null, 2), 'utf8')
  } catch {
    /* 落盘失败不致命：这一次仍然按内存里的根目录工作 */
  }
}

function rootsFor(cfg) {
  const out = []
  const push = (p) => {
    if (typeof p !== 'string') return
    const v = p.trim()
    if (v === '') return
    const abs = resolve(v)
    if (!out.includes(abs)) out.push(abs)
  }
  push(caseRoot(cfg))
  for (const p of Array.isArray(cfg.libraryRoots) ? cfg.libraryRoots : []) push(p)
  for (const p of readLibrary()) push(p)
  return out
}

function kindOf(name) {
  const ext = extname(String(name)).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) return 'image'
  if (['.doc', '.docx', '.rtf', '.odt'].includes(ext)) return 'doc'
  if (['.txt', '.md', '.yml', '.yaml', '.json', '.csv'].includes(ext)) return 'text'
  return 'other'
}

/** 目录名去掉编号与「1-4人本」这类前缀，剩下的才是本名。 */
function humanName(folder) {
  const s = String(folder)
  const a = s.replace(/^\d+\s*[-–—]\s*\d+\s*人本\s*[-_、.．]?\s*/, '')
  const cn = a.replace(/^[单双两三四五六七八九十\d]+\s*人本\s*[-_、.．]?\s*/, '')
  const b = cn.replace(/^\d+\s*人本\s*[-_、.．]?\s*/, '')
  const c = b.replace(/^\d+\s*[-_、.．]\s*/, '')
  return (c.trim() || s)
}

function playersGuess(folder) {
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

function walkFiles(dir, base = '', depth = 0, acc = []) {
  if (depth > 3) return acc
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue
    const rel = base === '' ? ent.name : base + '/' + ent.name
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === '_text') continue
      walkFiles(abs, rel, depth + 1, acc)
      continue
    }
    const st = (() => { try { return statSync(abs) } catch { return null } })()
    acc.push({ rel, name: ent.name, ext: extname(ent.name).toLowerCase(), kind: kindOf(ent.name), bytes: st ? st.size : 0 })
  }
  return acc
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
  const out = []
  if (!existsSync(root)) return out
  let ents = []
  try { ents = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue
    const dir = join(root, ent.name)
    if (existsSync(join(dir, 'case.yml'))) {
      const hit = scanCases(root).find((c) => c.folder === ent.name)
      if (hit) out.push({ ...hit, kind: 'case' })
      continue
    }
    const files = walkFiles(dir)
    if (files.length === 0) continue
    const entry = packEntry(ent.name, dir, files)
    const store = readTextStore(root, ent.name)
    entry.hasText = store.files.length > 0
    entry.textDir = store.dir
    out.push(entry)
  }
  out.sort((a, b) => (Number(a.id) - Number(b.id)) || String(a.title).localeCompare(String(b.title), 'zh'))
  return out
}

function packDetail(entry, only) {
  const files = only ? entry.files.filter((f) => f.kind === only) : entry.files
  return { ...entry, files }
}

/** 图片与 PDF 直接从磁盘回给页面（只允许读当前本子目录里的文件）。 */
function serveFile(res, dir, rel) {
  const base = resolve(dir)
  const file = resolve(base, rel)
  if (!(file === base || file.startsWith(base + sep))) return json(res, 403, { ok: false, error: 'forbidden' })
  if (!existsSync(file)) return json(res, 404, { ok: false, error: 'not-found' })
  try {
    const buf = readFileSync(file)
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    })
    res.end(buf)
  } catch (e) {
    json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
  }
}

/**
 * 递归复制一棵目录树。
 * 不用 fs.cpSync：本机 Node 24.14 上对中文目录名（cases/01-拾光照相馆）会原生崩掉
 * （进程 exit -1073740791 / STATUS_STACK_BUFFER_OVERRUN，无 JS 异常），手写这份等价且可观测。
 */
function copyTree(from, to, onFile, prefix = '') {
  mkdirSync(to, { recursive: true })
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, ent.name)
    const d = join(to, ent.name)
    const rel = prefix === '' ? ent.name : prefix + '/' + ent.name
    if (ent.isDirectory()) {
      copyTree(s, d, onFile, rel)
    } else {
      copyFileSync(s, d)
      if (typeof onFile === 'function') {
        try { onFile(rel) } catch { /* 进度回调出错不挡拷贝 */ }
      }
    }
  }
}

/** 把 jubensha 自带的 7 个本子拷进本子库（只拷缺的）。 */
function seed(root) {
  if (existsSync(root) && readdirSync(root).length > 0) return 0
  const home = dshHome()
  const candidates = [
    join(home, 'profiles', 'desktop', 'node_modules', '@max-null', 'dsh-jubensha', 'cases'),
    join(home, 'profiles', 'web', 'node_modules', '@max-null', 'dsh-jubensha', 'cases'),
  ]
  let copied = 0
  for (const src of candidates) {
    if (!existsSync(src)) continue
    let names = []
    try { names = readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { continue }
    for (const n of names) {
      const to = join(root, n)
      if (existsSync(to)) continue
      try { copyTree(join(src, n), to); copied += 1 } catch { /* 单个失败不影响别的 */ }
    }
    if (copied > 0) break
  }
  return copied
}

function serveStatic(res, rel) {
  const file = resolve(WEB, rel)
  if (!file.startsWith(resolve(WEB)) || !existsSync(file)) return json(res, 404, { ok: false, error: 'not-found' })
  try {
    const buf = readFileSync(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(buf)
  } catch (e) {
    json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
  }
}

function trusted(req, trustedHosts) {
  const host = String(req.headers.host ?? '')
  const name = host.split(':')[0]
  if (name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1') return true
  return Array.isArray(trustedHosts) && trustedHosts.includes(host)
}

async function readBody(req) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > 262144) throw new Error('请求体过大（>256KB）')
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new Error('请求体不是合法 JSON') }
}

/* ---------- 访问面分级：本机 / 局域网 / 公网 ----------
   用户 2026-11-19 定：公网链接「只能玩，但不许烧机主的模型额度」。
   - local（回环）：全功能。
   - lan（局域网钥匙进来的）：全功能 —— 同一屋檐下，默认信。
   - remote（*.trycloudflare.com 进来的）：管理面一律 403 owner-only；
     模型面（页内 DM、引擎、转述、材料局）受 remoteMode 闸门：
       off   默认 —— 公网只能浏览，任何要模型的动静一律 403 remote-off；
       quota —— 每日总额 remoteDaily（默认 40）+ 每来源 1.5 秒节流；
       allow —— 放开（确实信任来的人，才勾这个）。
   计数落 game-desk/remote-usage.json，按本地日期滚动。 */
const GATE_RULES = {
  peek: 'owner', import: 'owner', 'import/status': 'owner', extract: 'owner', 'extract/status': 'owner',
  roots: 'owner', restart: 'owner', 'reload-client': 'owner', bootgraph: 'owner', beats: 'owner',
  ocr: 'owner', remote: 'owner', lan: 'any', tunnel: 'any', reveal: 'any',
  'case/gaps': 'owner',
  case: (m) => (m === 'GET' ? '' : 'owner'),
  arcade: (m) => (m === 'GET' ? '' : 'owner'),
  'arcade/delete': 'owner',
  dm: 'model', 'xgame/narrate': 'model', 'arcade/ask': 'model',
}
function viaOf(req, trustedHosts) {
  const host = String(req.headers.host || '').toLowerCase()
  if (host.indexOf('.trycloudflare.com') >= 0) return 'remote'
  return trusted(req, trustedHosts) ? 'local' : 'lan'
}
function remoteIp(req) {
  return String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '?')
}
function usageFile() { return join(dshHome(), 'game-desk', 'remote-usage.json') }
function todayLocal() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
/** 放行则计数 +1（带剩余）；拦下返回 { code, error }。只在 quota 模式下记账。 */
function remoteGate(req) {
  const cur = readSettings()
  const mode = String(cur.remoteMode || 'off')
  if (mode === 'allow') return { ok: true }
  if (mode !== 'quota') return { ok: false, code: 403, error: 'remote-off' }
  const daily = Math.max(1, Math.min(2000, Number(cur.remoteDaily) || 40))
  let u = {}
  try { u = JSON.parse(readFileSync(usageFile(), 'utf8')) || {} } catch { u = {} }
  const day = todayLocal()
  const rec = u.date === day ? u : { date: day, calls: 0, ips: {} }
  const ip = remoteIp(req)
  const last = Number(rec.ips[ip] && rec.ips[ip].t) || 0
  if (Date.now() - last < 1500) return { ok: false, code: 429, error: 'remote-throttle' }
  if (Number(rec.calls) >= daily) return { ok: false, code: 429, error: 'remote-quota' }
  rec.calls = Number(rec.calls) + 1
  rec.ips[ip] = { n: (Number(rec.ips[ip] && rec.ips[ip].n) || 0) + 1, t: Date.now() }
  try { writeFileSync(usageFile(), JSON.stringify(rec), 'utf8') } catch { /* 计数存不下宁可放行 */ }
  return { ok: true, left: Math.max(0, daily - rec.calls) }
}
function remoteInfo() {
  const cur = readSettings()
  let u = {}
  try { u = JSON.parse(readFileSync(usageFile(), 'utf8')) || {} } catch { u = {} }
  const day = todayLocal()
  const rec = u.date === day ? u : { date: day, calls: 0, ips: {} }
  return {
    mode: String(cur.remoteMode || 'off'),
    daily: Number(cur.remoteDaily) || 40,
    used: Number(rec.calls) || 0,
    byIp: Object.keys(rec.ips || {}).length,
  }
}
/** dispatch 顶部的统一闸门：非本机流量先过这里。返回拦截用的 {code,error} 或 null。 */
function gateFor(req, res2, method, path, trustedHosts) {
  const via = viaOf(req, trustedHosts)
  if (via === 'local') return null
  const seg = path.startsWith(ROUTE + '/api/') ? path.slice(ROUTE.length + 5) : ''
  const rule0 = GATE_RULES[seg]
  if (!rule0) return null
  const rule = typeof rule0 === 'function' ? rule0(method) : rule0
  if (rule === 'owner' || rule === 'any') return { code: 403, error: via === 'remote' ? 'remote-owner-only' : 'owner-only' }
  if (rule === 'model' && via === 'remote') {
    const g = remoteGate(req)
    if (!g.ok) return { code: g.code, error: g.error }
  }
  return null
}

/** 新建一个本子的骨架（够 jubensha_case load 认得，细节留给写本子的人补）。 */
function templateCase({ title, players, genre, id }) {
  const n = Math.max(2, Math.min(8, Number(players) || 4))
  const seats = []
  for (let i = 0; i < n; i += 1) {
    seats.push(['  - id: p' + i, '    name: 待定角色' + (i + 1), '    player: ' + (i === 0 ? 'human' : 'ai'), '    age: 30', '    identity: 一句话身份', '    now: 此刻在做什么', '    secret: 只有他知道的事'].join('\n'))
  }
  return [
    '# ' + title + ' —— 由案卷台新建的骨架。把每个字段替换成真内容再删掉这行。',
    'meta:',
    '  id: "' + id + '"',
    '  title: ' + title,
    '  players: ' + n,
    '  human_slots: 1',
    '  est_rounds: [10, 20]',
    '  difficulty: beginner',
    '  genre: ' + (genre || 'deduction'),
    '  tags: []',
    '',
    'scene:',
    '  place: 待定地点',
    '  setup: |',
    '    这里写发现尸体的那一段：谁、什么时候、怎么发现的。',
    '  premise: 一句话说清现在这个房间里为什么是这几个人。',
    '  victim:',
    '    name: 待定死者',
    '    age: 50',
    '    cause: 待定死因',
    '    time_window: ["21:30", "22:30"]',
    '',
    'roles:',
    seats.join('\n'),
    '',
  ].join('\n')
}


/* ------------------------------------------------------------------ *
 * 导入与评判：把「从别处拿来的资料夹」（PDF / 图片 / 文档）拆成一本结构化本子
 *
 * 评判不猜内容：只从抽出的文字里认「人数 / 类型 / 难度 / 时长 / 角色行 / 引子 /
 * 线索数」这几件能指回原文的事，认不出就如实标 warn —— 页面把每条判据与出处
 * 摆给用户看，用户再决定导不导。
 * ------------------------------------------------------------------ */

/** 去掉换行做跨行匹配（中文换行不需要空格；英文单词之间补一个）。 */
function flatText(s) {
  return String(s)
    .replace(/\r/g, '')
    .replace(/([A-Za-z0-9])\n([A-Za-z0-9])/g, '$1 $2')
    .replace(/\n/g, '')
}

/** 把被 PDF 抽成碎行的一段拼回段落：上一行没有句末标点就继续接。 */
function tidyParagraph(s) {
  const lines = String(s).replace(/\r/g, '').split('\n').map((x) => x.trim()).filter((x) => x !== '')
  const out = []
  for (const line of lines) {
    const last = out[out.length - 1]
    if (last !== undefined && !/[。！？；：…」』）)\]】]$/.test(last)) out[out.length - 1] = last + line
    else out.push(line)
  }
  return out.join('\n').trim()
}

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 「十四条」「4」这类都读成数字。 */
function cnNumber(raw) {
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

/** 从抽出的文字里认「基本面」。认不出的字段留空，不编。 */
function detectSpec(texts, folder) {
  const all = texts.map((t) => t.text).join('\n')
  const flat = flatText(all)
  const spec = { title: humanName(folder), players: 0, playersDetail: '', genre: '', difficulty: '', duration: '', typeText: '', roles: [], premise: '', clueCount: 0, organizer: 0 }

  const players = /(\d+)\s*名玩家/.exec(flat) || /玩家人数[：:]\s*(\d+)\s*人?/.exec(flat)
  if (players) spec.players = Number(players[1])
  if (!spec.players) {
    const guess = playersGuess(folder)
    if (guess) {
      spec.players = guess.max
      if (guess.min !== guess.max) spec.playersDetail = guess.min + '–' + guess.max + ' 人（按资料夹名猜的）'
    }
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

  // 角色行：只认「名字（27 岁，55kg）」这种有据可查的写法
  const roles = []
  const roleRe = /^(.{2,12}?)[（(]\s*(\d{1,2})\s*岁\s*[，,]\s*(\d{1,3})\s*(?:kg|KG|公斤)\s*[）)]/gm
  let m
  while ((m = roleRe.exec(all)) !== null) {
    const name = m[1].trim().replace(/^[0-9.\s、]+/, '')
    if (name === '' || roles.some((r) => r.name === name)) continue
    roles.push({ name, age: Number(m[2]), weight: Number(m[3]), script: '', scriptText: false })
  }
  spec.roles = roles

  const bg = /故事背景[：:]([\s\S]*?)(?=剧本类型[：:]|玩家人数[：:]|剧本时长[：:]|剧本道具[：:]|$)/.exec(all)
  if (bg) spec.premise = tidyParagraph(bg[1])

  const clueLines = /共有\s*([一二三四五六七八九十\d]+)\s*条/.exec(flat)
  if (clueLines) spec.clueCount = cnNumber(clueLines[1])
  const clueCards = /线索卡[（(]\s*(\d+)\s*张\s*[）)]/.exec(flat)
  if (clueCards) spec.clueCards = Number(clueCards[1])

  if (texts.some((t) => /组织者|主持人|手册|gm/i.test(t.rel)) || /组织者须知|主持人手册|组织者手册/.test(flat)) spec.organizer = 1
  return spec
}

function readStoreTexts(store) {
  return store.files.map((f) => {
    let text = ''
    try { text = readFileSync(join(store.dir, f.txt), 'utf8') } catch { text = '' }
    return { rel: f.rel, txt: f.txt, chars: text.length, text }
  })
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

  const checks = []
  const add = (id, label, ok, detail, hard) => checks.push({ id, label, level: ok ? 'ok' : (hard ? 'fail' : 'warn'), detail })
  add('text', '抽出了可读文字', chars >= 800, chars === 0 ? '一份也没抽出来（扫描件或字体加密）' : chars + ' 字', true)
  add('manual', '有组织者手册', Boolean(spec.organizer), spec.organizer ? '认出「组织者须知 / 主持人手册」' : '没认出组织者手册：规则得靠人讲', false)
  add('players', '人数可判定', spec.players > 0, spec.players > 0 ? spec.players + ' 人' + (spec.playersDetail ? '（' + spec.playersDetail + '）' : '') : '没找到「N 名玩家」', false)
  add('roles', '角色可拆解', spec.roles.length >= 2, spec.roles.length >= 2 ? spec.roles.map((r) => r.name).join(' / ') + (spec.rolesFrom === 'files' ? '（按文件名认出）' : '') : '没读到「名字（N 岁，M kg）」这种角色行，文件名也没认出', false)
  add('premise', '引子可提取', spec.premise !== '', spec.premise === '' ? '没有「故事背景」段' : '已提取 ' + spec.premise.length + ' 字', false)
  add('scripts', '人物剧本可对位', readable > 0, readable > 0 ? readable + ' 份对上了角色且抽得出字' : (paired > 0 ? paired + ' 份文件名对上了，但 PDF 抽不出文字（扫描件 / 字体加密）' : '没找到带角色名的人物剧本'), false)
  const clueFiles = entry.files.filter((f) => /线索|clue/i.test(f.rel)).length
  const clueDetail = spec.clueCount > 0
    ? spec.clueCount + ' 条线索' + (spec.clueCards ? '（' + spec.clueCards + ' 张卡）' : '')
    : (clueFiles > 0 ? clueFiles + ' 个线索文件，条数未标注' : (spec.clueCards ? spec.clueCards + ' 张线索卡' : '没找到线索'))
  add('clues', '线索有下落', spec.clueCount > 0 || clueFiles > 0 || spec.clueCards > 0, clueDetail, false)

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

function yamlScalar(v) {
  return '"' + String(v === undefined || v === null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

function blockScalar(text, indent) {
  return String(text).replace(/\r/g, '').split('\n').map((l) => (l === '' ? indent + '  ' : indent + l)).join('\n')
}

/** 评判结果 + 原文 → 一份 case.yml（字段全部指得回原文，没有新增设定）。 */
function importCaseYml({ id, title, spec, screen, folder, root, fileCount }) {
  // 认不出角色就不编座位：宁可空着（gaps 里会写「角色可拆解」没过），也不造假人
  const roles = spec.roles.length > 0
    ? spec.roles
    : (Number(spec.players) >= 2 ? Array.from({ length: Number(spec.players) }, (_, i) => ({ name: '角色' + (i + 1), age: 0, weight: 0, script: '', scriptText: false })) : [])
  const tags = ['导入']
  if (spec.players) tags.push(spec.players + '人')
  if (spec.genre && spec.genre !== 'imported' && spec.genre !== 'unknown') tags.push(spec.genre)
  if (spec.difficulty && spec.difficulty !== 'unknown' && spec.difficulty !== 'imported') tags.push(spec.difficulty)
  const lines = []
  lines.push('# 由案卷台从资料夹导入（' + new Date().toISOString() + '）')
  lines.push('# 原始文件在 _source/，抽出的文字在 _text/。字段只取自原文；认不出的地方留白。')
  lines.push('meta:')
  lines.push('  id: ' + yamlScalar(id))
  lines.push('  title: ' + yamlScalar(title))
  lines.push('  players: ' + (Number(spec.players) || roles.length))
  lines.push('  human_slots: 1')
  lines.push('  genre: ' + yamlScalar(spec.genre || '未标注'))
  lines.push('  difficulty: ' + yamlScalar(spec.difficulty || '未标注'))
  if (spec.duration) lines.push('  duration: ' + yamlScalar(spec.duration))
  lines.push('  tags: [' + tags.join(', ') + ']')
  lines.push('  imported: true')
  lines.push('  source_kind: pack')
  lines.push('  source_root: ' + yamlScalar(root))
  lines.push('  source_folder: ' + yamlScalar(folder))
  lines.push('  source_files: ' + fileCount)
  lines.push('  verdict: ' + yamlScalar(screen.verdict))
  lines.push('')
  lines.push('scene:')
  lines.push('  place: ""')
  lines.push('  premise: |')
  lines.push(blockScalar(spec.premise || '（原文没有「故事背景」段，见 _text/）', '    '))
  lines.push('  setup: |')
  lines.push('    从「' + folder + '」导入：原始资料在 _source/，抽出的文字在 _text/。')
  lines.push('')
  lines.push('roles:')
  roles.forEach((r, i) => {
    lines.push('  - id: p' + i)
    lines.push('    name: ' + yamlScalar(r.name))
    lines.push('    player: ' + (i === 0 ? 'human' : 'ai'))
    if (r.age) lines.push('    age: ' + r.age)
    if (r.weight) lines.push('    weight: ' + r.weight)
    if (r.script) lines.push('    script: ' + yamlScalar('_source/' + r.script))
  })
  lines.push('')
  const gaps = ((screen && screen.checks) || []).filter((k) => k && k.level && k.level !== 'ok')
  if (gaps.length) {
    lines.push('# 导入体检没过的项 —— 补齐原文后在案卷台重导同一资料夹，这一栏会刷新')
    lines.push('gaps:')
    gaps.forEach((k) => {
      lines.push('  - id: ' + String(k.id))
      lines.push('    label: ' + yamlScalar(k.label || ''))
      lines.push('    level: ' + String(k.level))
      lines.push('    detail: ' + yamlScalar(k.detail || ''))
    })
    lines.push('')
  }
  return lines.join('\n')
}

/** 资料夹 → 本子库里的一个本子：拷原始文件、拷抽出文本、写 case.yml。 */
async function importPack(cfg, root, folder, opts = {}) {
  const job = opts.job || null
  const stage = (phase, patch) => {
    if (!job) return
    job.phase = phase
    if (patch) Object.assign(job, patch)
  }
  const packDir = join(root, folder)
  if (!existsSync(packDir)) return { ok: false, code: 404, error: '资料夹不存在：' + packDir }
  stage('scan', { done: 0, total: 0, rel: '' })
  const files = walkFiles(packDir)
  const pack = packEntry(folder, packDir, files)
  let store = readTextStore(root, folder)
  if (store.files.length === 0 && opts.extract !== false) {
    try {
      await extractPack(root, folder, {
        onProgress: (p) => stage(p.phase === 'image' ? 'image' : 'text', { done: p.done || 0, total: p.total || 0, rel: p.rel || '' }),
      })
    } catch { /* 抽不出就按没文字评判 */ }
    store = readTextStore(root, folder)
  }
  const screen = screenPack(root, folder, pack, store)
  if (screen.verdict === 'blocked' && opts.force !== true) {
    return { ok: false, code: 422, error: '没有可读文字，先补文字版（或强制导入）', screen }
  }
  const libRoot = caseRoot(cfg)
  const existing = scanCases(libRoot)
  // 同一来源再导一次 = 刷新那一本，不再多出一本一样的
  const twin = existing.find((c) => String(c.sourceFolder || '') === folder)
  const used = new Set(existing.map((c) => String(c.id)))
  let n = 1
  if (!twin) {
    while (used.has(String(n).padStart(2, '0'))) n += 1
  }
  const id = twin ? String(twin.id) : String(n).padStart(2, '0')
  const title = humanName(screen.title || folder)
  const caseFolder = twin ? twin.folder : (id + '-' + title.replace(/[\\/:*?"<>|]/g, '').slice(0, 24))
  const caseDir = join(libRoot, caseFolder)
  try {
    mkdirSync(caseDir, { recursive: true })
    if (twin) {
      rmSync(join(caseDir, '_source'), { recursive: true, force: true })
      rmSync(join(caseDir, '_text'), { recursive: true, force: true })
    }
    stage('copy', { done: 0, total: files.length, rel: '' })
    let copied = 0
    copyTree(packDir, join(caseDir, '_source'), (rel) => {
      copied += 1
      stage('copy', { done: copied, total: files.length, rel })
    })
    stage('write', { done: copied, total: files.length, rel: 'case.yml' })
    const textOut = join(caseDir, '_text')
    mkdirSync(textOut, { recursive: true })
    for (const f of store.files) {
      try { copyFileSync(join(store.dir, f.txt), join(textOut, f.txt)) } catch { /* 单份失败不挡整本 */ }
    }
    writeFileSync(join(caseDir, 'case.yml'), importCaseYml({ id, title, spec: screen.spec, screen, folder, root, fileCount: files.length }), 'utf8')
  } catch (e) {
    return { ok: false, code: 500, error: String(e && e.message ? e.message : e) }
  }
  return { ok: true, id, folder: caseFolder, dir: caseDir, file: join(caseDir, 'case.yml'), screen, updated: Boolean(twin) }
}


/* ---------- OCR 闸门：默认串行，一次只让一份文件过 ----------
   用户 2026-11-19 定：OCR 一律串行，必要时才并行；页面给一个「并行」开关。
   并行的代价很实在：CPU 抢核 + 显存只够一个 VL 实例，同时跑两份反而更慢。 */
const OCR_GATE = { parallel: false, running: 0, queue: [] }

function ocrLimit() { return OCR_GATE.parallel ? 2 : 1 }

function ocrSlot() {
  if (OCR_GATE.running < ocrLimit()) {
    OCR_GATE.running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => { OCR_GATE.queue.push(resolve) })
}

function ocrRelease() {
  const next = OCR_GATE.queue.shift()
  if (next) { next(); return }               // 名额直接转交，running 不变
  OCR_GATE.running = Math.max(0, OCR_GATE.running - 1)
}

function ocrSnapshot() {
  return { parallel: OCR_GATE.parallel, running: OCR_GATE.running, queued: OCR_GATE.queue.length }
}

function settingsFile() { return join(dshHome(), 'game-desk', 'settings.json') }

function readSettings() {
  try { return JSON.parse(readFileSync(settingsFile(), 'utf8')) || {} } catch { return {} }
}

function writeSettings(patch) {
  const cur = readSettings()
  const next = { ...cur, ...(patch || {}) }
  try {
    mkdirSync(join(dshHome(), 'game-desk'), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
  } catch { /* 存不下就只在本进程生效 */ }
  return next
}

/* ---------- OCR：扫描件 PDF / 线索图的兜底 ----------
   两条引擎都留着（用户 2026-11-19 定）：
   - rapid = RapidOCR（onnxruntime，CPU，快，中文印刷体够用）跑在 whisper-venv；
   - vl    = Qwen3-VL-2B-Instruct（torch+CUDA）跑在 gsv-venv，慢但认得手写/花体/版式。
   CLI 在 tools/ocr.py，约定：--engine --in [--out] [--json]，出错非 0 退出。 */
const PLUGIN_ROOT = resolve(HERE, '..')
const OCR_SCRIPT = join(PLUGIN_ROOT, 'tools', 'ocr.py')
const OCR_PY = {
  rapid: join(homedir(), '.dsh', 'tools', 'whisper-venv', 'Scripts', 'python.exe'),
  vl: join(homedir(), '.dsh', 'tools', 'gsv-venv', 'Scripts', 'python.exe'),
}

const execFileAsync = promisify(execFile)

function ocrAvailable(engine) {
  try { return existsSync(OCR_SCRIPT) && existsSync(OCR_PY[engine]) } catch { return false }
}

/** 全局串行闸：抽取/导入是按 root|folder 分任务的，多任务并行时曾同时跑 3 个 OCR
 *  （各 ~1.1GB 提交内存 + 合计 7~10 核，16GB 机器直接换页卡顿，2026-11-19 实测）。
 *  排队等待不计入单份超时——execFile 的 timeout 从真正起跑才算。 */
let OCR_QUEUE = Promise.resolve()
function ocrToText(file, engine, timeoutMs) {
  const run = OCR_QUEUE.then(() => ocrToTextNow(file, engine, timeoutMs))
  OCR_QUEUE = run.catch(() => {})
  return run
}

/** 跑一次 OCR；返回纯文本（失败返回 ''，原因打到 stderr 日志）。
 *  用异步 execFile：OCR 动辄一分钟，同步版会把宿主事件循环焊死（2026-11-19 实测导致整轮会话卡死）。 */
async function ocrToTextNow(file, engine, timeoutMs) {
  if (!ocrAvailable(engine)) return ''
  await ocrSlot()
  try {
    // 单份文件的上限：rapid 3 分钟、vl 5 分钟。实测一份大扫描件能跑十几分钟，
    // 那样导入的进度条会长时间不动；超时就当这份抽不出来，整本继续往下走。
    const cap = timeoutMs || (engine === 'vl' ? 300000 : 180000)
    const { stdout } = await execFileAsync(OCR_PY[engine], [OCR_SCRIPT, '--engine', engine, '--in', file, '--json'], {
      maxBuffer: 128 * 1024 * 1024, windowsHide: true, timeout: cap,
    })
    const raw = String(stdout || '')
    // --json 是「每行一个文档对象」（JSONL），不是单个对象。
    const docs = []
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try { docs.push(JSON.parse(t)) } catch { /* 跳过坏行 */ }
    }
    if (docs.length) {
      return docs
        .map((d) => (Array.isArray(d.pages) ? d.pages.map((p) => String((p && p.text) || '')).join('\n\f\n') : String(d.text || '')))
        .filter((s) => s.trim() !== '')
        .join('\n\f\n')
    }
    const start = raw.indexOf('{')
    if (start >= 0) {
      try {
        const j = JSON.parse(raw.slice(start))
        if (Array.isArray(j.pages)) return j.pages.map((p) => String((p && p.text) || '')).join('\n\f\n')
      } catch { /* 落到下面 */ }
    }
    return raw.trim()
  } catch (e) {
    console.info('[game-desk] OCR 失败 ' + file + ' (' + engine + '): ' + String(e && e.message ? e.message : e).slice(0, 300))
    return ''
  } finally {
    ocrRelease()
  }
}

/** 用本机的 python + pypdf 把一份 PDF 抽成纯文本；没有 python 就返回空串（页面会提示）。 */
let pdfScript = ''
async function pdfToText(file) {
  if (pdfScript === '') {
    pdfScript = join(dshHome(), 'tmp', 'game-desk-pdf.py')
    const code = [
      'import sys',
      "sys.stdout.reconfigure(encoding='utf-8')",
      'path = sys.argv[1]',
      "text = ''",
      'try:',
      '    from pypdf import PdfReader',
      "    text = '\\n\\f\\n'.join((page.extract_text() or '') for page in PdfReader(path).pages)",
      'except Exception as err:',
      "    sys.stderr.write('pypdf: %s\\n' % err)",
      "if text.strip() == '':",
      '    try:',
      '        import fitz',
      "        text = '\\n\\f\\n'.join(page.get_text() for page in fitz.open(path))",
      '    except Exception as err:',
      "        sys.stderr.write('fitz: %s\\n' % err)",
      'sys.stdout.write(text)',
    ].join('\n')
    try {
      mkdirSync(dirname(pdfScript), { recursive: true })
      writeFileSync(pdfScript, code, 'utf8')
    } catch {
      pdfScript = 'skip'
    }
  }
  if (pdfScript === 'skip') return ''
  for (const exe of ['python', 'py']) {
    try {
      const { stdout } = await execFileAsync(exe, [pdfScript, file], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 180000 })
      return String(stdout || '')
    } catch (e) {
      console.info('[game-desk] pdf 抽取失败 ' + file + ' (' + exe + '): ' + String(e && e.message ? e.message : e))
    }
  }
  return ''
}


/* 抽出来的文本不写进来源目录（那可能是网盘只读/受保护目录），
   统一缓存在 $DSH_HOME/game-desk/text/<root|folder 的哈希>/ 下。 */
function textStore(root, folder) {
  const key = createHash('sha1').update(String(root) + '|' + String(folder)).digest('hex').slice(0, 16)
  const dir = join(dshHome(), 'game-desk', 'text', key)
  return { dir, index: join(dir, 'index.json') }
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

/** apply 时的生效配置（OCR 开关这类要给抽取函数看，才不必层层传参）。 */
const CONF = { ...DEFAULTS }

/** 抽取任务表：key = root|folder。宿主不能同步等 OCR，页面改成轮询这里的状态。 */
const EXTRACT_JOBS = new Map()
const extractKey = (root, folder) => String(root) + '|' + String(folder)

function extractStatus(root, folder) {
  const job = EXTRACT_JOBS.get(extractKey(root, folder))
  if (job && job.state === 'running') return { state: 'running', startedAt: job.startedAt, elapsedMs: Date.now() - job.startedAt, phase: job.phase || 'text', done: job.done || 0, total: job.total || 0, rel: job.rel || '' }
  if (job && job.state === 'done') return { state: 'done', made: job.made.length, failed: job.failed.length, ocr: job.ocr.length, elapsedMs: job.endedAt - job.startedAt, done: job.done || 0, total: job.total || 0 }
  if (job && job.state === 'error') return { state: 'error', error: job.error, elapsedMs: job.endedAt - job.startedAt }
  const store = readTextStore(root, folder)
  return store.files.length ? { state: 'done', cached: true } : { state: 'idle' }
}

/** 起一次后台抽取（不 await），立刻返回任务快照。 */
function startExtract(root, folder) {
  const key = extractKey(root, folder)
  const cur = EXTRACT_JOBS.get(key)
  if (cur && cur.state === 'running') return extractStatus(root, folder)
  const job = { state: 'running', startedAt: Date.now(), endedAt: 0, made: [], failed: [], ocr: [], error: '', phase: 'text', done: 0, total: 0, rel: '' }
  EXTRACT_JOBS.set(key, job)
  extractPack(root, folder, {
    onProgress: (p) => { job.phase = p.phase || 'text'; job.done = p.done || 0; job.total = p.total || 0; job.rel = p.rel || '' },
  }).then((out) => {
    job.state = 'done'
    job.endedAt = Date.now()
    job.made = out.made || []
    job.failed = out.failed || []
    job.ocr = out.ocr || []
  }).catch((error) => {
    job.state = 'error'
    job.endedAt = Date.now()
    job.error = String(error && error.message ? error.message : error)
  })
  return extractStatus(root, folder)
}

/** 导入任务表：导入要拷几十上百个文件 + 可能抽一遍字，不能同步等，页面轮询 /api/import/status。 */
const IMPORT_JOBS = new Map()

function importStatus(root, folder) {
  const job = IMPORT_JOBS.get(extractKey(root, folder))
  if (!job) return { state: 'idle', phase: '', done: 0, total: 0, rel: '' }
  const out = {
    state: job.state, phase: job.phase, done: job.done || 0, total: job.total || 0, rel: job.rel || '',
    startedAt: job.startedAt, elapsedMs: (job.endedAt || Date.now()) - job.startedAt,
  }
  if (job.state === 'done') out.result = job.result
  if (job.state === 'error') { out.error = job.error; out.result = job.result || null }
  return out
}

/** 起一次后台导入（不 await），立刻返回任务快照。 */
function startImport(cfg, root, folder, opts = {}) {
  const key = extractKey(root, folder)
  const cur = IMPORT_JOBS.get(key)
  if (cur && cur.state === 'running') return importStatus(root, folder)
  const job = { state: 'running', phase: 'scan', startedAt: Date.now(), endedAt: 0, done: 0, total: 0, rel: '', result: null, error: '' }
  IMPORT_JOBS.set(key, job)
  importPack(cfg, root, folder, { ...opts, job }).then((out) => {
    job.endedAt = Date.now()
    job.result = out
    if (out && out.ok) {
      job.state = 'done'
      job.phase = 'done'
      job.done = job.total || 1
    } else {
      job.state = 'error'
      job.phase = 'error'
      job.error = (out && out.error) || ('导入失败（' + String(out && out.code ? out.code : '?') + '）')
    }
  }).catch((error) => {
    job.endedAt = Date.now()
    job.state = 'error'
    job.error = String(error && error.message ? error.message : error)
  })
  return importStatus(root, folder)
}

/** 把一本资料夹里的 PDF / 文本抽成缓存文本（评判与导入都走它）。 */
async function extractPack(root, folder, opts = {}) {
  const say = (phase, patch) => {
    if (typeof opts.onProgress !== 'function') return
    try { opts.onProgress({ phase, ...(patch || {}) }) } catch { /* 回调出错不影响抽取 */ }
  }
  const dir = join(root, folder)
  const store = textStore(root, folder)
  mkdirSync(store.dir, { recursive: true })
  const made = []
  const failed = []
  const index = []
  const ocrLog = []
  const files = walkFiles(dir)
  const put = (rel, text) => {
    const clean = text.replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, '').replace(/^\s+/, '')
    if (clean.trim() === '') return 0
    const nameOut = rel.replace(/[\\/]/g, '__').replace(/\.(pdf|txt|md|jpe?g|png|webp|gif)$/i, '') + '.txt'
    try {
      writeFileSync(join(store.dir, nameOut), clean, 'utf8')
      made.push(nameOut)
      index.push({ rel, txt: nameOut, chars: clean.length })
      return clean.length
    } catch { return 0 }
  }
  const readable = files.filter((f) => f.kind === 'pdf' || f.kind === 'text')
  const images = files.filter((f) => f.kind === 'image')
  let step = 0
  say('text', { done: 0, total: readable.length })
  for (const item of readable) {
    step += 1
    say('text', { done: step, total: readable.length, rel: item.rel })
    const abs = join(dir, item.rel)
    let text = ''
    if (item.kind === 'text') {
      try { text = readFileSync(abs, 'utf8') } catch { text = '' }
    } else {
      text = await pdfToText(abs)
      if (text.trim() === '' && CONF.ocrEngine !== 'off') {
        text = await ocrToText(abs, 'rapid')
        if (text.trim() !== '') ocrLog.push({ rel: item.rel, engine: 'rapid', chars: text.length })
        else if (CONF.ocrVlFallback && ocrAvailable('vl')) {
          text = await ocrToText(abs, 'vl')
          if (text.trim() !== '') ocrLog.push({ rel: item.rel, engine: 'vl', chars: text.length })
        }
      }
    }
    if (put(item.rel, text) === 0) failed.push(item.rel)
  }
  // 图片（线索卡之类）：只有整本几乎没字时才去 OCR，免得为几张小图等半天。
  if (CONF.ocrImages && CONF.ocrEngine !== 'off') {
    const charsSoFar = index.reduce((n, f) => n + f.chars, 0)
    if (charsSoFar < 800 && images.length) {
      const imgList = images.slice(0, 24)
      let imgDone = 0
      say('image', { done: 0, total: imgList.length })
      for (const item of imgList) {
        say('image', { done: imgDone, total: imgList.length, rel: item.rel })
        imgDone += 1
        const text = await ocrToText(join(dir, item.rel), 'rapid')
        if (text.trim() === '') { failed.push(item.rel); continue }
        ocrLog.push({ rel: item.rel, engine: 'rapid', chars: text.length })
        if (put(item.rel, text) === 0) failed.push(item.rel)
      }
    }
  }
  try {
    writeFileSync(store.index, JSON.stringify({ root, folder, at: new Date().toISOString(), files: index }, null, 2), 'utf8')
  } catch (e) {
    console.info('[game-desk] 文本索引写不进去：' + String(e && e.message ? e.message : e))
  }
  return { dir: store.dir, made, failed, ocr: ocrLog }
}

/** 启动自检：apply 走到哪一步、哪一步出错，都落一份 boot.json（宿主的 stdout 我们读不到）。 */
/** 客户端半的排障心跳（页面每次 apply / 注册行都会打一条），只在内存里留最近 60 条。 */
const CLIENT_BEATS = []

/** 客户端插件表（dsh-client-modules 的 clientModules 服务）；到这里问「我这半有没有被编进浏览器那一侧」。 */
let CLIENT_REG = null

function bootStatus(stage, extra) {
  try {
    mkdirSync(join(dshHome(), 'game-desk'), { recursive: true })
    writeFileSync(join(dshHome(), 'game-desk', 'boot.json'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, stage, ...(extra || {}) }, null, 2), 'utf8')
  } catch { /* 诊断写不进去不影响主流程 */ }
}

/* ---------------- 页内 DM（直接走宿主 llm 服务，不回会话） ----------------
 *
 * 对局室里点「对局」页签就是在这里开的一局：宿主把本子全文喂给默认模型，
 * 模型同时当 DM 和所有 AI 角色。插件不 import 任何 @deepseek-ai 包（解析链
 * 上没有那棵树），消息对象按 dsh-llm 的 createUserMessage 运行时形态手拼。
 */

function readCap(p, cap) {
  try {
    const s = readFileSync(p, 'utf8').replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, '')
    return s.length > cap ? s.slice(0, cap) + '\n……（这部分截到这儿）' : s
  } catch {
    return ''
  }
}

/** 给 DM 看的内部资料（含真相与各角色秘密）。只进模型上下文，不回页面。 */
function dmContext(root, folder, titleHint) {
  const dir = join(root, folder)
  const parts = []
  let title = String(titleHint || folder)
  const yml = join(dir, 'case.yml')
  if (existsSync(yml)) {
    const raw = readCap(yml, 24000)
    if (raw) {
      try {
        const parsed = parseCase(raw)
        if (parsed && parsed.meta && parsed.meta.title) title = String(parsed.meta.title)
      } catch { /* 标题解析失败不挡资料 */ }
      parts.push('【本子资料 case.yml】\n' + raw)
    }
    try {
      for (const n of readdirSync(dir)) {
        if (!/\.(md|txt)$/i.test(n)) continue
        if (!/handbook|手册|主持|组织者|dm/i.test(n)) continue
        const s = readCap(join(dir, n), 12000)
        if (s) parts.push('【' + n + '】\n' + s)
        break
      }
    } catch { /* 读目录失败不挡 */ }
    try {
      const rd = join(dir, 'roles')
      if (existsSync(rd)) {
        let k = 0
        for (const n of readdirSync(rd)) {
          if (k >= 8) break
          if (!/\.(md|txt)$/i.test(n)) continue
          const s = readCap(join(rd, n), 6000)
          if (s) { parts.push('【角色剧本 ' + n + '】\n' + s); k += 1 }
        }
      }
    } catch { /* 没有 roles 目录也行 */ }
  }
  if (parts.length === 0) {
    // 导入本 / 资料夹本：优先本子目录里的 _text，再退抽取缓存
    const cand = []
    try {
      const td = join(dir, '_text')
      if (existsSync(td)) {
        for (const n of readdirSync(td)) if (/\.txt$/i.test(n)) cand.push(join(td, n))
      }
    } catch { /* 忽略 */ }
    let capped = cand.slice(0, 6)
    if (capped.length === 0) {
      const store = readTextStore(root, folder)
      capped = store.files.slice(0, 6).map((f) => join(store.dir, f.txt))
    }
    for (const abs of capped) {
      const s = readCap(abs, 12000)
      if (s) parts.push('【' + basename(abs) + '】\n' + s)
    }
    if (parts.length === 0 && existsSync(yml)) parts.push('【case.yml】\n' + readCap(yml, 24000))
  }
  return { title, text: parts.join('\n\n') }
}

async function dmAsk(ctx, body) {
  const llm = ctx.get ? ctx.get('llm', false) : false
  if (!llm || typeof llm.prepareCall !== 'function') return { ok: false, code: 503, error: '宿主没有可用的 llm 服务' }
  const adm = ctx.get ? ctx.get('agentDefaultModel', false) : false
  const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
  if (!sel || !sel.provider || !sel.model) return { ok: false, code: 503, error: '没有探测到默认模型（agentDefaultModel）' }
  const root = String(body.root || '')
  const folder = String(body.folder || '')
  const pack = dmContext(root, folder, body.title)
  if (pack.text.trim() === '') {
    return { ok: false, code: 422, error: '这本还没有能读的文字：先在「导入/详情」里抽字（扫描件走 OCR），或把 case.yml 放进本子库再开局' }
  }
  const meName = String(body.meName || '玩家')
  const act = Math.max(1, Number(body.act) || 1)
  const aiNames = (Array.isArray(body.aiNames) ? body.aiNames : []).map(String).filter((x) => x !== '').slice(0, 8)
  const system = [
    '你是剧本杀《' + pack.title + '》的主持人（DM），同时扮演除「' + meName + '」以外的所有角色' + (aiNames.length ? '（' + aiNames.join('、') + '）' : '') + '。',
    '当前是第 ' + act + ' 幕。',
    '下面是本子的全部内部资料（含真相与各角色的秘密）。这是你的底稿：绝不允许原文念给玩家，也不许把没写的设定编出来。',
    '<case>',
    pack.text,
    '</case>',
    '主持规矩：',
    '1. 一次只推进一小步，跟着玩家的行动走；玩家要线索时你决定给哪条、什么时候给。',
    '2. AI 角色说话用「名字：台词」的格式，每人每次不超过两句；你的旁白不加前缀。',
    '3. 不预先剧透真相；玩家逼问时按角色的人设应付，角色自己也不知道的事说「不清楚」。',
    '4. 回复不超过 350 字，结尾给玩家留一个钩子或问题。',
  ].join('\n')
  const hist = Array.isArray(body.history) ? body.history.slice(-20) : []
  const lines = []
  for (const h of hist) {
    if (!h) continue
    const who = h.who === 'dm' ? 'DM' : meName
    const t = String(h.text || '').slice(0, 800).trim()
    if (t !== '') lines.push(who + '：' + t)
  }
  const input = String(body.input || '').slice(0, 2000)
  const userText = (lines.length ? '【已经发生的对局】\n' + lines.join('\n') + '\n\n' : '') +
    (body.open === true
      ? '请以 DM 身份开场：把场景立起来，让每个角色各一两句亮相，然后停下等玩家行动。不要替玩家说话。'
      : '【玩家「' + meName + '」现在说/做】\n' + (input || '（继续推进）') + '\n\n请以 DM 身份继续。')
  const t0 = Date.now()
  const signal = AbortSignal.timeout(150000)
  try {
    const call = await llm.prepareCall({ provider: sel.provider, model: sel.model, maxTokens: 1200 }, signal)
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'game-desk-dm' },
      id: randomUUID(),
    }]
    let text = ''
    let finish = null
    for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
      if (chunk && chunk.type === 'text-delta') text += String(chunk.text || '')
      else if (chunk && chunk.type === 'finish') finish = chunk.reason
    }
    if (finish && finish.kind === 'error') {
      return { ok: false, code: 502, error: '模型报错：' + (finish.failure && finish.failure.message ? finish.failure.message : '未知') }
    }
    text = text.trim()
    if (text === '') return { ok: false, code: 502, error: '模型回了一段空文本，再发一次试试' }
    return { ok: true, text, model: sel.provider + '/' + sel.model, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, code: 500, error: String(e && e.message ? e.message : e) }
  }
}

  // ---------- 游戏厅 · 外来内容库（材料局） ----------
  // 七种玩法的内容由 dsh-xgame 随机生成，引擎不收外部资料。这一层补第二个入口：
  // 一份资料夹 = 一局「材料局」—— 主持人不是引擎，是模型本身（和页内 DM 同一条 llm 路），
  // 按导入的资料现编现裁。抽字复用「导入剧本」的 peek/抽取链，这里只管登记与开聊。

  const SCHEME_IDS = new Set(CATALOG.map((c) => c.id))

  function arcadeRoot() {
    const dir = join(dshHome(), 'game-desk', 'arcade')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  function arcadeYml(o) {
    return [
      'meta:',
      '  id: ' + yamlScalar(o.id),
      '  title: ' + yamlScalar(o.title),
      '  scheme: ' + yamlScalar(o.scheme),
      '  note: ' + yamlScalar(o.note),
      ...(o.players ? ['  players: ' + yamlScalar(o.players)] : []),
      '  source_root: ' + yamlScalar(o.root),
      '  source_folder: ' + yamlScalar(o.folder),
      '  created: ' + yamlScalar(new Date().toISOString()),
    ].join('\n') + '\n'
  }

  function readArcadeMeta(file) {
    try {
      const parsed = parseCase(readFileSync(file, 'utf8'))
      const m = parsed && parsed.meta
      if (!m || !m.title) return null
      return m
    } catch {
      return null
    }
  }

  function arcadeTextDir(dir) {
    // 材料优先 _text；结构化本导入时文字在 _source/_text 里
    for (const td of [join(dir, '_text'), join(dir, '_source', '_text')]) {
      const out = []
      try {
        if (!existsSync(td)) continue
        for (const n of readdirSync(td)) if (/\.txt$/i.test(n)) out.push(join(td, n))
      } catch { /* 读不到当没有 */ }
      if (out.length) return out
    }
    return []
  }

  function arcadeChars(dir) {
    let chars = 0
    for (const abs of arcadeTextDir(dir)) {
      try { chars += statSync(abs).size } catch { /* 不计 */ }
    }
    if (chars === 0) {
      try {
        const y = join(dir, '_source', 'case.yml')
        if (existsSync(y)) chars = statSync(y).size
      } catch { /* 0 就 0 */ }
    }
    return chars
  }

  function scanArcade() {
    const items = []
    let names = []
    try {
      names = readdirSync(arcadeRoot(), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
    } catch { return items }
    for (const folder of names) {
      const dir = join(arcadeRoot(), folder)
      const m = readArcadeMeta(join(dir, 'arcade.yml'))
      if (!m) continue
      items.push({
        folder,
        id: String(m.id || ''),
        title: String(m.title || folder),
        scheme: SCHEME_IDS.has(String(m.scheme)) ? String(m.scheme) : 'escape',
        note: String(m.note || ''),
        players: String(m.players || ''),
        source_folder: String(m.source_folder || ''),
        chars: arcadeChars(dir),
        files: walkFiles(dir).length,
      })
    }
    items.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
    return items
  }

  /** 从名字与文件名里猜人数：「1-4人本」「双人本」「3人本」都认。猜不出回空串，前端显示「人数未标」。 */
  function guessPlayers(text) {
    const s = String(text || '')
    let m = s.match(/([0-9０-９一二三四五六七八九十两]{1,3})\s*[-–~至]\s*([0-9０-９一二三四五六七八九十两]{1,3})\s*人/)
    if (m) return m[1] + '-' + m[2] + ' 人'
    m = s.match(/([0-9０-９一二三四五六七八九十两]{1,3})\s*人\s*本/)
    if (m) return m[1] + ' 人'
    if (/双人/.test(s)) return '2 人'
    if (/单人/.test(s)) return '1 人'
    return ''
  }

  /** 把一份（多半已抽好字的）资料夹登记进游戏厅库。拷贝是本地毫秒级，同步跑。 */
  function arcadeImportPack(root, folder, scheme, titleHint, playersHint) {
    if (!SCHEME_IDS.has(scheme)) return { ok: false, code: 400, error: 'scheme 不在七种玩法里：' + scheme }
    const packDir = resolve(join(root, folder))
    if (!existsSync(packDir) || !statSync(packDir).isDirectory()) return { ok: false, code: 404, error: '资料夹不存在：' + packDir }
    const existing = scanArcade()
    const twin = existing.find((x) => x.source_folder === String(folder))
    let id
    if (twin) id = twin.id || ''
    else {
      const used = new Set(existing.map((x) => String(x.id)))
      let n = 1
      while (used.has(String(n).padStart(2, '0'))) n += 1
      id = String(n).padStart(2, '0')
    }
    const title = (String(titleHint || '').trim() || humanName(folder)).slice(0, 30)
    const players = String(playersHint || '').trim() ||
      guessPlayers(folder + ' ' + title + ' ' + walkFiles(packDir).map((f) => f.rel).join(' '))
    const safe = title.replace(/[\\/:*?"<>|]/g, '') || '未命名'
    const caseFolder = twin ? twin.folder : id + '-' + safe
    const dir = join(arcadeRoot(), caseFolder)
    try {
      mkdirSync(dir, { recursive: true })
      rmSync(join(dir, '_source'), { recursive: true, force: true })
      rmSync(join(dir, '_text'), { recursive: true, force: true })
      copyTree(packDir, join(dir, '_source'))
      const store = readTextStore(root, folder)
      if (store.files.length) {
        const td = join(dir, '_text')
        mkdirSync(td, { recursive: true })
        for (const f of store.files) {
          try {
            const srcAbs = join(store.dir, f.txt)
            if (!existsSync(srcAbs)) continue
            const nm = String(f.rel || f.txt).replace(/[\\/:*?"<>|]/g, '_').replace(/\.[A-Za-z0-9]+$/, '') + '.txt'
            copyFileSync(srcAbs, join(td, nm))
          } catch { /* 单份失败不挡整本 */ }
        }
      }
      writeFileSync(join(dir, 'arcade.yml'), arcadeYml({ id, title, scheme, players, note: '导入自 ' + folder, root, folder }), 'utf8')
      return { ok: true, entry: { folder: caseFolder, id, title, scheme, players, note: '导入自 ' + folder, chars: arcadeChars(dir), files: walkFiles(dir).length, updated: !!twin } }
    } catch (e) {
      return { ok: false, code: 500, error: String(e && e.message ? e.message : e) }
    }
  }

  function arcadeMaterial(dir) {
    const parts = []
    for (const abs of arcadeTextDir(dir).slice(0, 6)) {
      const s = readCap(abs, 12000)
      if (s) parts.push('【' + basename(abs) + '】\n' + s)
    }
    if (parts.length === 0) {
      const y = join(dir, '_source', 'case.yml')
      if (existsSync(y)) {
        const s = readCap(y, 20000)
        if (s) parts.push('【case.yml】\n' + s)
      }
      if (parts.length === 0) {
        try {
          let k = 0
          for (const f of walkFiles(join(dir, '_source'))) {
            if (k >= 4) break
            if (f.kind !== 'text') continue
            const s = readCap(join(dir, '_source', f.rel), 8000)
            if (s) { parts.push('【' + f.rel + '】\n' + s); k += 1 }
          }
        } catch { /* 没材料就没材料 */ }
      }
    }
    return parts.join('\n\n').slice(0, 60000)
  }

  const ARCADE_RULES = {
    soup: [
      '玩法：海龟汤。先从资料里改编出一碗汤底（真相，压在你心里，绝不外泄），再端出一碗说不通的汤面（一个反常的结局片段）。',
      '玩家提问，你只回「是 / 否 / 无关（碰不到汤底）」再加一句引导；裁决以你改编的汤底为准，前后不许改口。',
      '玩家自己把故事串通了就宣布还原成功并把汤底讲完；连着五问跑偏，给一次软提示。',
    ],
    detective: [
      '玩法：侦探推理。从资料里立一桩案子：死者、时刻、地点、至多四个嫌疑人、真凶与动机 —— 关键设定全部取自资料，资料没有的不要硬编。',
      '玩家可以勘查地点、找人交谈、出示证据；你按已经立好的真相裁决，每处勘查给一条新线索，别一次抖空。',
      '玩家正式指控时按真相判对错，判完把整条证据链复述一遍收尾。',
    ],
    escape: [
      '玩法：密室逃脱。把资料改写成一间锁着的屋子：五到七个机关/物件、三到五件能拿的东西、一条唯一的逃脱路径；机关逻辑记死，别临场改。',
      '玩家观察、拿取、组合、使用；观察给细节，操作给后果；背包里有什么、哪扇门开着，以已发生的对局为准。',
      '最后一道机关解开就写明「逃出去了」，两三句收尾。',
    ],
    party: [
      '玩法：剧本杀（玩家座）。从资料里挑一个人物给玩家扮演，其余人物由你演；你手里压着资料里的真相与人物间的秘密。',
      '玩家可以交谈、搜证、当众发言；每条秘密按「谁可能知道」放出来，没人能知道的事别摆上桌。',
      '时机到了引导玩家指控或表决，按真相判定，再逐条揭底。',
    ],
    loop: [
      '玩法：时间循环。从资料里找一场「本可以不发生」的事故，定为这天必然重演的悲剧。',
      '玩家在一日里走动、交谈、动手；每个动作消耗时间。切断一条因果边，悲剧就少一格；到终局时刻结算：悲剧照旧，或完美一日。',
      '元知识规则：玩家上一轮知道的事这一轮仍然知道，NPC 不记得。',
    ],
    council: [
      '玩法：王国议会。资料里的人物分成几派立场，玩家是拍板的人；每一季给一个议题、两到三个选项，选项各有各的后果。',
      '你扮演全体顾问按立场发言；玩家可追问、可花本钱调查。决策的后果下一季显形，记仇要记牢。',
      '国库、民心、信任几个数每季报一次，只按已发生的决策加减。',
    ],
    trpg: [
      '玩法：单人跑团。用资料搭一段可走的地图（三到六个地点）和一个目标；NPC、怪物、道具都从资料取材。',
      '玩家报行动，要运气的事你替他掷骰（写明 d20 结果与难度），成功失败都有后果；HP、物品、任务进度逐条记账，回复里带一句现状。',
      '到达目标或 HP 归零就收束本局。',
    ],
  }

  const ARCADE_TAIL = [
    '—— 主持规矩 ——',
    '1. 资料是这一局的唯一底稿：名词、人名、情节要重新组织后出现，不许原文照念；资料没有的关键设定不要凭空补。',
    '2. 一次只推进一小步，跟着玩家的行动走，不替玩家说话、不替玩家做选择。',
    '3. NPC 台词用「名字：台词」的格式，每人每次不超过两句；旁白不加前缀。',
    '4. 真相压住，玩家逼问才按上面的玩法一层层放；状态（谁在场、拿到什么、机关/时刻/账本）以前文为准，不许漂移。',
    '5. 回复不超过 350 字，最后一句给玩家留一个钩子或问题。',
  ]

  async function arcadeAsk(ctx, body) {
    const folder = String(body.folder || '')
    if (!/^[^./\\][^/\\]{0,79}$/.test(folder)) return { ok: false, code: 400, error: 'folder 不合法' }
    const dir = join(arcadeRoot(), folder)
    const m = readArcadeMeta(join(dir, 'arcade.yml'))
    if (!m) return { ok: false, code: 404, error: '内容库里没有这一本' }
    const scheme = SCHEME_IDS.has(String(m.scheme)) ? String(m.scheme) : 'escape'
    const cat = CATALOG.find((c) => c.id === scheme)
    const material = arcadeMaterial(dir)
    if (material.trim() === '') return { ok: false, code: 422, error: '这份内容还没有能读的文字：导入前先把资料抽字（扫描件走 OCR）' }
    const llm = ctx.get ? ctx.get('llm', false) : false
    if (!llm || typeof llm.prepareCall !== 'function') return { ok: false, code: 503, error: '宿主没有可用的 llm 服务' }
    const adm = ctx.get ? ctx.get('agentDefaultModel', false) : false
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
    if (!sel || !sel.provider || !sel.model) return { ok: false, code: 503, error: '没有探测到默认模型（agentDefaultModel）' }
    const title = String(m.title || folder)
    const system = [
      '你是游戏厅「' + (cat ? cat.name : scheme) + '《' + title + '》」的主持人，一个人带这一局。',
      ...(ARCADE_RULES[scheme] || ARCADE_RULES.escape),
      ...ARCADE_TAIL,
      '<doc>',
      material,
      '</doc>',
    ].join('\n')
    const hist = Array.isArray(body.history) ? body.history.slice(-20) : []
    const lines = []
    for (const h of hist) {
      if (!h) continue
      const who = h.who === 'dm' ? '主持人' : '玩家'
      const t = String(h.text || '').slice(0, 800).trim()
      if (t !== '') lines.push(who + '：' + t)
    }
    const input = String(body.input || '').slice(0, 2000)
    const userText = (lines.length ? '【已经发生】\n' + lines.join('\n') + '\n\n' : '') +
      (body.open === true
        ? '请开局：按上面的玩法把场面立起来（汤面 / 案发 / 房间 / 这一天……），然后停下等玩家。不要替玩家说话。'
        : '【玩家现在说/做】\n' + (input || '（继续推进）') + '\n\n请以主持人身份继续。')
    const t0 = Date.now()
    const signal = AbortSignal.timeout(150000)
    try {
      const call = await llm.prepareCall({ provider: sel.provider, model: sel.model, maxTokens: 1200 }, signal)
      const messages = [{
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'game-desk-arcade-content' },
        id: randomUUID(),
      }]
      let text = ''
      let finish = null
      for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
        if (chunk && chunk.type === 'text-delta') text += String(chunk.text || '')
        else if (chunk && chunk.type === 'finish') finish = chunk.reason
      }
      if (finish && finish.kind === 'error') {
        return { ok: false, code: 502, error: '模型报错：' + (finish.failure && finish.failure.message ? finish.failure.message : '未知') }
      }
      text = text.trim()
      if (text === '') return { ok: false, code: 502, error: '模型回了一段空文本，再发一次试试' }
      return { ok: true, text, model: sel.provider + '/' + sel.model, ms: Date.now() - t0 }
    } catch (e) {
      return { ok: false, code: 500, error: String(e && e.message ? e.message : e) }
    }
  }

  // ---------- 案卷台 · 缺件总结（用户 2026-11-19：读内容、只总结缺什么，不许替本子编造补充） ----------
  async function caseGaps(ctx, root, folder) {
    const dir = join(root, folder)
    if (!existsSync(dir)) return { ok: false, code: 404, error: '找不到这一本：' + folder }
    const store = readTextStore(root, folder)
    let texts = arcadeTextDir(dir)
    let list = []
    try {
      const srcDir = join(dir, '_source')
      list = (existsSync(srcDir) ? walkFiles(srcDir) : walkFiles(dir))
        .map((f) => f.rel)
        .filter((r) => r !== 'case.yml' && r !== 'arcade.yml' && r.indexOf('_text/') !== 0)
    } catch { /* 列不出来就只靠正文 */ }
    if (!texts.length && store.files.length) {
      texts = store.files.map((f) => join(store.dir, f.txt)).filter((p) => existsSync(p))
      if (!list.length) list = store.files.map((f) => String(f.rel || f.txt))
    }
    const parts = []
    for (const abs of texts.slice(0, 6)) {
      const s = readCap(abs, 8000)
      if (s) parts.push('【' + basename(abs) + '】\n' + s)
    }
    if (!parts.length && existsSync(join(dir, 'case.yml'))) {
      const s = readCap(join(dir, 'case.yml'), 16000)
      if (s) parts.push('【case.yml】\n' + s)
    }
    const material = parts.join('\n\n').slice(0, 48000)
    if (material.trim() === '') return { ok: false, code: 422, error: '这一本现在读不到正文：先在体检处把抽字跑完（扫描件走 OCR），再来总结缺件' }
    const llm = ctx.get ? ctx.get('llm', false) : false
    if (!llm || typeof llm.prepareCall !== 'function') return { ok: false, code: 503, error: '宿主没有可用的 llm 服务' }
    const adm = ctx.get ? ctx.get('agentDefaultModel', false) : false
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
    if (!sel || !sel.provider || !sel.model) return { ok: false, code: 503, error: '没有探测到默认模型（agentDefaultModel）' }
    const system = [
      '你是剧本库存档员。下面是一本剧本（游戏资料）的文件清单与正文摘录，请只根据这些材料，整理「这一本要开一局还缺什么」。',
      '规则：',
      '- 只总结材料里看得见、明确没有的东西（组织者手册、人物剧本份数、线索卡、真相或结局、答案……）；材料里看不出来的，不要虚构，也不要替它补写内容；',
      '- 判断不了就写「材料里看不出来」；不评价质量，不复述剧情；',
      '- 最多 8 行，每行以「- 」开头，格式「缺什么：材料里的依据」；',
      '- 如果材料看着是齐的，只回一行「材料齐全，没看出缺件」。',
    ].join('\n')
    const userText = '【这本】' + folder + '\n【文件清单（前 200 项）】\n' + list.slice(0, 200).join('\n') + '\n【正文摘录】\n' + material
    const t0 = Date.now()
    const signal = AbortSignal.timeout(120000)
    try {
      const call = await llm.prepareCall({ provider: sel.provider, model: sel.model, maxTokens: 700 }, signal)
      const messages = [{
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'game-desk-case-gaps' },
        id: randomUUID(),
      }]
      let text = ''
      let finish = null
      for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
        if (chunk && chunk.type === 'text-delta') text += String(chunk.text || '')
        else if (chunk && chunk.type === 'finish') finish = chunk.reason
      }
      if (finish && finish.kind === 'error') {
        return { ok: false, code: 502, error: '模型报错：' + (finish.failure && finish.failure.message ? finish.failure.message : '未知') }
      }
      text = text.trim()
      if (text === '') return { ok: false, code: 502, error: '模型回了一段空文本，再试一次' }
      return { ok: true, text, model: sel.provider + '/' + sel.model, ms: Date.now() - t0 }
    } catch (e) {
      return { ok: false, code: 500, error: String(e && e.message ? e.message : e) }
    }
  }

// ---------- 游戏厅：页内直接驱动 dsh-xgame 引擎 ----------
// xgame 的工具引擎按「会话标识」存对局状态（storages/dsh-xgame/<sid>/）。
// 案卷台给它一个专用标识 game-desk-<scheme>，用 tools 服务的 executable()
// 拿到工具定义后直接 execute(args, exec)，exec 里塞一个最小 agent：
//   agent.session.id → 状态目录；agent.options.provider/model → 引擎内部裁决用的模型路由。
// 这样游戏厅的每一手都留在页面里，不回会话。

const XGAME_PREFIX = 'game-desk-'

const XGAME_ACTIONS = {
  soup: [
    { label: '提问', tool: 'soup_ask', fields: [{ k: 'question', label: '是/否问题', ph: '死者生前认识凶手吗？' }] },
    { label: '猜汤底', tool: 'soup_guess', fields: [{ k: 'answer', label: '完整还原', type: 'area', ph: '把整个故事讲一遍…' }] },
  ],
  detective: [
    { label: '勘查', tool: 'detective_examine', fields: [{ k: 'target', label: '地点', ph: '书房 / 温室 / 湖边…' }] },
    { label: '交谈', tool: 'detective_talk', fields: [{ k: 'npc', label: '对象', ph: '简报里的相关人士名字' }, { k: 'text', label: '你说', ph: '昨晚九点你在哪儿？' }] },
    { label: '出示线索', tool: 'detective_show', fields: [{ k: 'npc', label: '给谁', ph: '人名' }, { k: 'clue_id', label: '线索关键词', ph: '已发现的线索，简短几个字' }] },
    { label: '提交推理报告', tool: 'detective_submit_theory', end: true, fields: [{ k: 'report', label: '完整报告（凶手/手法/动机/证据链）', type: 'area' }] },
    { label: '正式指控', tool: 'detective_accuse', end: true, fields: [{ k: 'npc', label: '凶手是', ph: '人名' }] },
  ],
  escape: [
    { label: '观察', tool: 'escape_examine', fields: [{ k: 'target', label: '对象', ph: '壁炉 / 镜子 / 通往书房的门…' }] },
    { label: '拿取', tool: 'escape_take', fields: [{ k: 'item', label: '物品', ph: '一盒火柴' }] },
    { label: '使用', tool: 'escape_use', fields: [{ k: 'item', label: '物品', ph: '铜钥匙' }, { k: 'on', label: '用在哪', ph: '通往书房的门' }] },
    { label: '组合', tool: 'escape_combine', fields: [{ k: 'a', label: '物品一', ph: '火柴' }, { k: 'b', label: '物品二', ph: '冻住的铜钥匙' }] },
    { label: '操作机关', tool: 'escape_manipulate', fields: [{ k: 'target', label: '机关', ph: '壁炉' }, { k: 'action', label: '动作', ph: '点火 / 转动 / 推开' }] },
    { label: '解题', tool: 'escape_solve', fields: [{ k: 'puzzle', label: '谜题', ph: '西洋钟' }, { k: 'answer', label: '答案', ph: '指针指向的时刻' }] },
  ],
  party: [
    { label: '交谈', tool: 'party_talk', fields: [{ k: 'npc', label: '对象', ph: '角色名' }, { k: 'text', label: '你说', ph: '自由发挥' }] },
    { label: '搜证', tool: 'party_search', fields: [{ k: 'scene', label: '场景', ph: '书房 / 餐厅 / 花园…' }] },
    { label: '公开发言', tool: 'party_discuss', fields: [{ k: 'statement', label: '发言', type: 'area', ph: '陈述 / 质问 / 抛出线索' }] },
    { label: '出示证据', tool: 'party_show', fields: [{ k: 'npc', label: '给谁', ph: '角色名（当众写 当众）' }, { k: 'clue_id', label: '证据关键词' }] },
    { label: '陈述辩解', tool: 'party_defend', fields: [{ k: 'statement', label: '本轮陈述', type: 'area', ph: '反转模式：守住你的公开说辞' }] },
    { label: '正式指控', tool: 'party_accuse', end: true, fields: [{ k: 'npc', label: '凶手是', ph: '角色名' }] },
    { label: '请求裁决', tool: 'party_verdict', end: true, fields: [] },
  ],
  loop: [
    { label: '观察', tool: 'loop_observe', fields: [] },
    { label: '前往', tool: 'loop_move', fields: [{ k: 'to', label: '地点', type: 'select', options: ['镇公所大厅', '集市广场', '旧图书馆', '旧钟楼'] }] },
    { label: '行动', tool: 'loop_act', fields: [{ k: 'action', label: '做什么', ph: '用铜钥匙拆下断裂铆钉' }] },
    { label: '深查', tool: 'loop_investigate', fields: [{ k: 'target', label: '对象', ph: '档案箱 / 挎包 / 炭盆…' }] },
    { label: '对话', tool: 'loop_talk', fields: [{ k: 'npc', label: '对象', type: 'select', options: ['沈培元', '老周', '林薇'] }, { k: 'text', label: '你说', ph: '自由发挥' }] },
    { label: '快进', tool: 'loop_fast_forward', fields: [{ k: 'plan', label: '计划（时间+地点+动作）', type: 'area', ph: '12:00 图书馆翻档案箱 → 15:00 集市摸挎包' }] },
    { label: '提交完美一日', tool: 'loop_submit_plan', end: true, fields: [{ k: 'plan', label: '全天方案', type: 'area' }] },
  ],
  council: [
    { label: '开启本季议会', tool: 'council_consult', fields: [] },
    { label: '听顾问发言', tool: 'council_speak', fields: [] },
    { label: '追问顾问', tool: 'council_question', fields: [{ k: 'adviser', label: '顾问', type: 'select', options: ['沈万钧', '霍震霆', '玄尘子', '顾长风'] }, { k: 'text', label: '你问', ph: '自由发挥' }] },
    { label: '花 2 金调查', tool: 'council_investigate', fields: [{ k: 'target', label: '对象', ph: '顾问名字，或 瘟疫潜伏/朝堂贪腐/外敌威胁/饥荒压力' }] },
    { label: '拍板决策', tool: 'council_decide', fields: [{ k: 'option', label: '选项 id', ph: '见议会清单里的选项 id' }] },
  ],
  trpg: [
    { label: '前往', tool: 'trpg_move', fields: [{ k: 'to', label: '区域', ph: '简报里列出的区域名' }] },
    { label: '检查', tool: 'trpg_examine', fields: [{ k: 'target', label: '对象', ph: '商队残骸 / 内厅门…' }] },
    { label: '对话', tool: 'trpg_talk', fields: [{ k: 'npc', label: '对象', ph: '在场人物（引擎会提示可选谁）' }, { k: 'text', label: '你说', ph: '自由发挥' }] },
    { label: '使用物品', tool: 'trpg_use', fields: [{ k: 'item', label: '物品', ph: '治疗药水' }] },
    { label: '攻击', tool: 'trpg_attack', fields: [{ k: 'target', label: '敌人', ph: '在场敌人名字' }] },
    { label: '检定', tool: 'trpg_check', fields: [{ k: 'skill', label: '技能', ph: 'stealth / athletics / persuasion…' }, { k: 'dc', label: '难度 5-25', ph: '12' }, { k: 'description', label: '动作描述', ph: '摸到哨塔背后' }] },
    { label: '休整', tool: 'trpg_rest', fields: [] },
    { label: '逃跑', tool: 'trpg_flee', fields: [] },
  ],
}

const XGAME_TOOLS = new Set(['game_start'])
for (const list of Object.values(XGAME_ACTIONS)) {
  for (const a of list) XGAME_TOOLS.add(a.tool)
}

// 玩家可能想「推倒重来」：xgame 内存里也缓存对局，删目录不够，
// 所以 sid 由前端生成（每局一个），reset 只负责清旧目录。
function pickSid(body) {
  const s = String(body.sid || '')
  if (/^[a-z][a-z0-9-]{1,47}$/.test(s)) return s
  return xgameSid(body.scheme)
}

function xgameSid(scheme) {
  const s = String(scheme || '')
  return /^[a-z][a-z0-9]*$/.test(s) ? XGAME_PREFIX + s : null
}

async function xgameCall(ctx, body) {
  const tool = String(body.tool || '')
  const sid = pickSid(body)
  if (!sid) return { ok: false, code: 400, error: 'scheme 不合法' }
  if (!XGAME_TOOLS.has(tool)) return { ok: false, code: 404, error: 'tool 不在游戏厅白名单：' + tool }
  const toolsSvc = ctx.get ? ctx.get('tools', false) : null
  if (!toolsSvc || typeof toolsSvc.executable !== 'function') return { ok: false, code: 503, error: '宿主没有 tools 服务' }
  const def = toolsSvc.executable(tool)
  if (!def || typeof def.execute !== 'function') return { ok: false, code: 503, error: 'dsh-xgame 没挂载，或工具 ' + tool + ' 不在' }
  const adm = ctx.get ? ctx.get('agentDefaultModel', false) : null
  const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
  if (!sel || !sel.provider || !sel.model) return { ok: false, code: 503, error: '拿不到默认模型档位（引擎内部裁决要用）' }
  const exec = {
    agent: { session: { id: sid }, options: { provider: String(sel.provider), model: String(sel.model) } },
    signal: AbortSignal.timeout(180000),
  }
  try {
    const args = body.args && typeof body.args === 'object' ? body.args : {}
    const result = await def.execute(args, exec)
    return { ok: true, result, sid, model: String(sel.provider) + '/' + String(sel.model) }
  } catch (error) {
    return { ok: false, code: 500, error: String(error && error.message ? error.message : error) }
  }
}

/** game_start 的简报是写给「会话里当 DM 的模型」看的；页内把它转述给玩家。 */
async function xgameNarrate(ctx, body) {
  const text = String(body.text || '').slice(0, 6000)
  const name = String(body.name || '游戏')
  const soup = body.soup === true
  const verdict = String(body.verdict || '')
  if (text === '') return { ok: false, code: 400, error: 'text 必填' }
  const llm = ctx.get ? ctx.get('llm', false) : null
  if (!llm || typeof llm.prepareCall !== 'function') return { ok: false, code: 503, error: '宿主没有可用的 llm 服务' }
  const adm = ctx.get ? ctx.get('agentDefaultModel', false) : null
  const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
  if (!sel || !sel.provider || !sel.model) return { ok: false, code: 503, error: '拿不到默认模型档位' }
  const sayVerdict = verdict === 'yes' ? '是' : verdict === 'no' ? '否' : verdict === 'irrelevant' ? '无关（这个问题碰不到汤底）' : verdict === 'unclear' ? '说不清' : '按简报里的裁决'
  const system = soup
    ? [
        '你是海龟汤「' + name + '」的主持人。引擎的裁决是：' + sayVerdict + '。',
        '只告诉玩家这一条裁决，再加一句引导（换个角度问）。',
        '简报里那段话含汤底与真相 —— 其中任何一个具体名词、人物、情节都不许出现在你的话里；',
        '宁可空泛，不可泄底。不超过 60 字。',
      ].join('\n')
    : [
        '你是游戏厅「' + name + '」的对局室主持人。',
        '下面是游戏引擎刚发出的输出（开局简报或最新裁决/台词）。',
        '把玩家该听到的内容转述出来：NPC 台词与裁决保持原意，去掉写给主持人的指令；',
        '保留引擎给出的全部数字与状态，不添加引擎没有的事实；口语、克制，不超过 240 字。',
      ].join('\n')
  const signal = AbortSignal.timeout(90000)
  try {
    const call = await llm.prepareCall({ provider: String(sel.provider), model: String(sel.model), maxTokens: 500 }, signal)
    const messages = [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'game-desk-arcade' }, id: randomUUID() }]
    let acc = ''
    for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
      if (chunk.type === 'text-delta') acc += String(chunk.text || '')
    }
    acc = acc.trim()
    if (acc === '') return { ok: false, code: 502, error: '转述是空的' }
    return { ok: true, text: acc }
  } catch (error) {
    return { ok: false, code: 500, error: String(error && error.message ? error.message : error) }
  }
}

export function apply(ctx, rowConfig) {
  bootStatus('apply-enter')
  try {
    return applyInner(ctx, rowConfig)
  } catch (error) {
    bootStatus('apply-fail', { error: String(error && error.stack ? error.stack : error).slice(0, 800) })
    throw error
  }
}

function applyInner(ctx, rowConfig) {
  // cordis 里 ctx.config 必须先 inject 'config' 才可读；行配置由 apply 的第二个参数直接给。
  const patchCfg = rowConfig || {}
  try {
    ctx.inject(['clientModules'], (scope) => {
      CLIENT_REG = scope.get('clientModules')
      bootStatus('client-modules', 'present')
    })
  } catch (error) {
    bootStatus('client-modules', 'inject-fail: ' + String(error && error.message ? error.message : error))
  }
  const cfg = { ...DEFAULTS, ...patchCfg }
  Object.assign(CONF, cfg)
  // 串行是默认；页面上的开关存 settings.json，插件配置里也能硬开。
  OCR_GATE.parallel = readSettings().ocrParallel === true || cfg.ocrParallel === true
  const root = caseRoot(cfg)
  try { mkdirSync(root, { recursive: true }) } catch { /* 目录建不出来就让后面的 API 报错 */ }
  if (cfg.seedFromJubensha) {
    try {
      const n = seed(root)
      if (n > 0) console.info('[game-desk] 已把 ' + String(n) + ' 个本子拷进 ' + root)
    } catch { /* 播种失败不是致命错 */ }
  }

  bootStatus('before-effect', { root })
  ctx.effect(() => {
    const server = ctx.get ? ctx.get('webServer') : undefined
    if (!server || typeof server.register !== 'function') {
      bootStatus('no-webServer-service')
      return () => {}
    }
    try {
      return server.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const trustedHosts = ctx.get('webStartup', false)?.trustedHosts
      if (!trusted(req, trustedHosts)) return json(res, 403, { ok: false, error: 'forbidden' })
      return dispatch(req, res)
    },
      })
    } catch (error) {
      bootStatus('route-fail', { error: String(error && error.message ? error.message : error) })
      return () => {}
    }
  }, 'dsh-game-desk: /game-desk')

  /** 共用的请求派发：宿主回环路由与局域网服务都走这一份。 */
  const dispatch = async (req, res) => {
      const url = new URL(String(req.url ?? '/'), 'http://dsh.internal')
      const path = url.pathname
      const method = String(req.method ?? 'GET').toUpperCase()
      const blocked = gateFor(req, res, method, path, ctx.get('webStartup', false)?.trustedHosts)
      if (blocked) return json(res, blocked.code, { ok: false, error: blocked.error })
      try {
        if (method === 'GET' && (path === ROUTE + '/app' || path === ROUTE + '/app/' || path === ROUTE + '/app/index.html')) {
          return serveStatic(res, 'index.html')
        }
        if (method === 'GET' && path.startsWith(ROUTE + '/app/')) {
          return serveStatic(res, path.slice((ROUTE + '/app/').length))
        }
        if (method === 'GET' && path === ROUTE + '/api/cases') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const cases = scanRoot(active)
          return json(res, 200, { ok: true, dir: active, roots, cases })
        }
        if (method === 'GET' && path === ROUTE + '/api/case') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          const hit = scanRoot(active).find((c) => c.folder === folder)
          if (!hit) return json(res, 404, { ok: false, error: 'case-not-found' })
          if (hit.kind === 'pack') {
            const store = readTextStore(active, folder)
            return json(res, 200, { ok: true, case: { ...hit, texts: store.files, textDir: store.dir } })
          }
          let text = ''
          try { text = readFileSync(hit.file, 'utf8') } catch { /* 读不到就给空 */ }
          const parsed = parseCase(text)
          const files = walkFiles(hit.dir)
          try {
            const textDir = join(hit.dir, '_text')
            if (existsSync(textDir)) {
              for (const n of readdirSync(textDir)) {
                if (!/\.txt$/i.test(n)) continue
                files.push({ rel: '_text/' + n, name: n, ext: '.txt', kind: 'text', bytes: (() => { try { return statSync(join(textDir, n)).size } catch { return 0 } })() })
              }
            }
          } catch { /* 没有 _text 就算了 */ }
          return json(res, 200, { ok: true, case: { ...hit, brief: parsed.premise || parsed.brief, premise: parsed.premise, text, files } })
        }
        if (method === 'GET' && path === ROUTE + '/api/file') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          const rel = url.searchParams.get('rel') ?? ''
          if (folder === '' || rel === '') return json(res, 400, { ok: false, error: 'folder/rel 必填' })
          return serveFile(res, join(active, folder), rel)
        }
        if (method === 'POST' && path === ROUTE + '/api/extract') {
          const roots = rootsFor(cfg)
          const body = await readBody(req)
          const active = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '')
          if (!existsSync(join(active, folder))) return json(res, 404, { ok: false, error: 'case-not-found' })
          try {
            return json(res, 200, { ok: true, ...(await extractPack(active, folder)) })
          } catch (e) {
            return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
        }
        if (method === 'GET' && path === ROUTE + '/api/extract/status') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          if (folder === '') return json(res, 400, { ok: false, error: '缺 folder' })
          const store = readTextStore(active, folder)
          return json(res, 200, { ok: true, extracting: extractStatus(active, folder), files: store.files.length, ocr: ocrSnapshot() })
        }
        if (method === 'POST' && path === ROUTE + '/api/peek') {
          // 「导入剧本」：给一个任意路径，回「这本资料夹的体检」或「这个目录下有哪些本子」。
          const body = await readBody(req)
          const raw = String(body.path ?? '').trim().replace(/^["']+|["']+$/g, '')
          if (raw === '') return json(res, 400, { ok: false, error: '缺 path' })
          const abs = resolve(raw)
          if (!existsSync(abs)) return json(res, 404, { ok: false, error: '路径不存在：' + abs })
          const isDir = statSync(abs).isDirectory()
          const dir = isDir ? abs : dirname(abs)
          const root = dirname(dir)
          const folder = basename(dir)
          if (existsSync(join(dir, 'case.yml'))) {
            const hit = scanRoot(root).find((c) => c.folder === folder)
            return json(res, 200, { ok: true, kind: 'case', root, folder, title: hit ? hit.title : folder, dir })
          }
          const files = walkFiles(dir)
          if (files.length > 0) {
            const stored = readLibrary()
            if (!stored.includes(root)) { stored.push(root); writeLibrary(stored) }
            const pack = packEntry(folder, dir, files)
            let store = readTextStore(root, folder)
            let extracting = extractStatus(root, folder)
            if (store.files.length === 0 && (pack.counts.pdf > 0 || pack.counts.text > 0 || pack.counts.image > 0)) {
              extracting = startExtract(root, folder)
            }
            return json(res, 200, {
              ok: true, kind: 'pack', root, folder, dir, extracted: false, extracting,
              entry: { counts: pack.counts, bytes: pack.bytes, players: pack.players, files: pack.files.slice(0, 40).map((f) => ({ rel: f.rel, name: f.name, kind: f.kind, size: f.size })) },
              screen: screenPack(root, folder, pack, store),
            })
          }
          const items = []
          for (const d of readdirSync(dir, { withFileTypes: true })) {
            if (!d.isDirectory() || d.name.startsWith('.') || d.name === '_text') continue
            const sub = join(dir, d.name)
            const found = walkFiles(sub)
            items.push({ folder: d.name, title: humanName(d.name), files: found.length, hasCase: existsSync(join(sub, 'case.yml')), players: playersGuess(d.name) })
          }
          items.sort((a, b) => a.folder.localeCompare(b.folder, 'zh'))
          return json(res, 200, { ok: true, kind: 'dirs', root: dir, items: items.slice(0, 300) })
        }
        if (method === 'GET' && path === ROUTE + '/api/screen') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          if (folder === '') return json(res, 400, { ok: false, error: '缺 folder' })
          const dir = join(active, folder)
          if (!existsSync(dir)) return json(res, 404, { ok: false, error: 'case-not-found' })
          if (existsSync(join(dir, 'case.yml'))) {
            const hit = scanRoot(active).find((c) => c.folder === folder)
            return json(res, 200, { ok: true, screen: { folder, title: hit ? hit.title : folder, verdict: 'ready', checks: [], spec: {}, chars: 0, fileCount: 0, already: 'case' } })
          }
          const pack = packEntry(folder, dir, walkFiles(dir))
          let store = readTextStore(active, folder)
          let extracting = extractStatus(active, folder)
          if (store.files.length === 0 && (pack.counts.pdf > 0 || pack.counts.text > 0)) {
            extracting = startExtract(active, folder)
          }
          return json(res, 200, { ok: true, screen: screenPack(active, folder, pack, store), extracting })
        }
        if (method === 'POST' && path === ROUTE + '/api/import') {
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const active = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '')
          if (folder === '') return json(res, 400, { ok: false, error: '缺 folder' })
          if (body.wait === true) {
            const out = await importPack(cfg, active, folder, { force: body.force === true })
            return json(res, out.ok ? 200 : (out.code || 500), out)
          }
          const status = startImport(cfg, active, folder, { force: body.force === true })
          return json(res, 202, { ok: true, started: status.state === 'running', status })
        }
        if (method === 'GET' && path === ROUTE + '/api/ocr') {
          return json(res, 200, { ok: true, ocr: ocrSnapshot() })
        }
        if (method === 'POST' && path === ROUTE + '/api/ocr') {
          const body = await readBody(req)
          if (typeof body.parallel === 'boolean') {
            OCR_GATE.parallel = body.parallel
            writeSettings({ ocrParallel: body.parallel })
          }
          return json(res, 200, { ok: true, ocr: ocrSnapshot() })
        }
        if (method === 'GET' && path === ROUTE + '/api/import/status') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          if (folder === '') return json(res, 400, { ok: false, error: '缺 folder' })
          return json(res, 200, { ok: true, importing: importStatus(active, folder), ocr: ocrSnapshot() })
        }
        if (method === 'GET' && path === ROUTE + '/api/text') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          const rel = url.searchParams.get('rel') ?? ''
          const store = readTextStore(active, folder)
          const hit = store.files.find((x) => x.rel === rel || x.txt === rel)
          if (!hit) return json(res, 404, { ok: false, error: 'text-not-extracted' })
          try {
            const buf = readFileSync(join(store.dir, hit.txt))
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
            res.end(buf)
          } catch (e) {
            json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          return
        }
        if (method === 'POST' && path === ROUTE + '/api/roots') {
          const body = await readBody(req)
          const given = String(body.root ?? '').trim()
          if (given === '') return json(res, 400, { ok: false, error: '缺 root' })
          const abs = resolve(given)
          if (!existsSync(abs)) return json(res, 404, { ok: false, error: '目录不存在：' + abs })
          const roots = rootsFor(cfg)
          if (!roots.includes(abs)) {
            const stored = readLibrary()
            stored.push(abs)
            writeLibrary(stored)
          }
          return json(res, 200, { ok: true, roots: rootsFor(cfg), root: abs })
        }
        if (method === 'POST' && path === ROUTE + '/api/beat') {
          const body = await readBody(req)
          CLIENT_BEATS.push({ at: Number(body.at) || Date.now(), stage: String(body.stage ?? '').slice(0, 60), detail: String(body.detail ?? '').slice(0, 300) })
          while (CLIENT_BEATS.length > 60) CLIENT_BEATS.shift()
          return json(res, 200, { ok: true })
        }
        if (method === 'GET' && path === ROUTE + '/api/beats') {
          return json(res, 200, { ok: true, beats: CLIENT_BEATS })
        }
        if (method === 'GET' && path === ROUTE + '/api/restart-probe') {
          try {
            const { createRequire } = await import('node:module')
            const localRequire = createRequire(import.meta.url)
            let electron = null
            try { electron = localRequire('electron') } catch { electron = null }
            const app = electron && electron.app
            return json(res, 200, {
              ok: true,
              hasApp: !!app,
              procType: process.type ?? null,
              requireKind: electron ? typeof electron : 'null',
              name: app && typeof app.getName === 'function' ? app.getName() : null,
              version: app && typeof app.getVersion === 'function' ? app.getVersion() : null,
              relaunch: !!(app && typeof app.relaunch === 'function'),
              pid: process.pid,
              electron: (process.versions && process.versions.electron) || null,
            })
          } catch (error) {
            return json(res, 500, { ok: false, error: String(error && error.message ? error.message : error), pid: process.pid })
          }
        }
        if (method === 'POST' && path === ROUTE + '/api/restart') {
          try {
            const { createRequire } = await import('node:module')
            const localRequire = createRequire(import.meta.url)
            let electron = null
            try { electron = localRequire('electron') } catch { electron = null }
            const app = electron && electron.app
            if (!app || typeof app.relaunch !== 'function') return json(res, 500, { ok: false, error: 'electron app 不可用', pid: process.pid })
            json(res, 200, { ok: true, relaunching: true, pid: process.pid })
            setTimeout(() => {
              try { app.relaunch({ args: process.argv.slice(1) }) } catch { app.relaunch() }
              try { app.exit(0) } catch { process.exit(0) }
            }, 600)
            return
          } catch (error) {
            return json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        }
        if (method === 'POST' && path === ROUTE + '/api/reload-client') {
          if (!CLIENT_REG || typeof CLIENT_REG.rebuilt !== 'function') return json(res, 200, { ok: false, registry: 'absent' })
          try {
            const rev = CLIENT_REG.rebuilt('dsh-game-desk')
            return json(res, 200, { ok: rev !== undefined, rev: rev === undefined ? null : String(rev) })
          } catch (error) {
            return json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        }
        if (method === 'GET' && path === ROUTE + '/api/bootgraph') {
          if (!CLIENT_REG || typeof CLIENT_REG.graph !== 'function') return json(res, 200, { ok: true, registry: 'absent' })
          try {
            const g = CLIENT_REG.graph()
            const rows = (g.entries || []).map((e) => ({ id: e.id, url: String(e.url || ''), initialUrl: String(e.initialUrl || ''), rev: e.rev, immediately: !!e.immediately, inject: e.inject || [] }))
            return json(res, 200, {
              ok: true,
              registry: 'present',
              rev: g.rev,
              count: rows.length,
              hasGameDesk: rows.some((r) => r.id === 'dsh-game-desk'),
              ids: rows.map((r) => r.id),
              rows: rows.filter((r) => /game-desk|qwen-image/.test(r.id)),
            })
          } catch (error) {
            return json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        }
        if (method === 'GET' && path === ROUTE + '/api/catalog') {
          return json(res, 200, { ok: true, modes: CATALOG.map((m) => ({ ...m, actions: XGAME_ACTIONS[m.id] || [] })) })
        }
        if (method === 'POST' && path === ROUTE + '/api/reveal') {
          // 弹资源管理器只在这台电脑上才有意义，也防远程刷窗口
          const hosts3 = ctx.get('webStartup', false)?.trustedHosts
          if (!trusted(req, hosts3)) return json(res, 403, { ok: false, error: 'reveal-host-only' })
          const body = await readBody(req)
          const target = String(body.path ?? '') !== '' ? resolve(String(body.path)) : root
          try {
            spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
          } catch (e) {
            return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          return json(res, 200, { ok: true, dir: target })
        }
        if (method === 'POST' && path === ROUTE + '/api/case') {
          const body = await readBody(req)
          const title = String(body.title ?? '').trim()
          if (title === '') return json(res, 400, { ok: false, error: '缺标题' })
          const roots = rootsFor(cfg)
          const targetRoot = String(body.root ?? '') !== '' ? resolve(String(body.root)) : root
          if (!roots.includes(targetRoot)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const existing = scanCases(targetRoot)
          const used = new Set(existing.map((c) => String(c.id)))
          const usedFolders = new Set(existing.map((c) => String(c.folder)))
          let id = String(body.id ?? '').trim()
          if (id === '') {
            let i = 1
            while (used.has(String(i).padStart(2, '0'))) i += 1
            id = String(i).padStart(2, '0')
          }
          const folder = (body.folder && String(body.folder).trim() !== '') ? String(body.folder).trim() : (id + '-' + title.replace(/[\\/:*?"<>|]/g, '').slice(0, 20))
          if (usedFolders.has(folder)) return json(res, 409, { ok: false, error: '同名目录已存在：' + folder, folder })
          const dir = join(targetRoot, folder)
          try { mkdirSync(dir, { recursive: true }) } catch (e) {
            return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          const text = typeof body.text === 'string' && body.text.trim() !== ''
            ? body.text
            : templateCase({ title, players: body.players, genre: body.genre, id })
          try { writeFileSync(join(dir, 'case.yml'), text, 'utf8') } catch (e) {
            return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          return json(res, 200, { ok: true, folder, file: join(dir, 'case.yml'), dir })
        }
        if (method === 'POST' && path === ROUTE + '/api/case/gaps') {
          // 缺件总结：读这一本的文件清单 + 正文摘录，让模型只列「缺什么」。机主面，公网一律 403。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const targetRoot = String(body.root ?? '') !== '' ? resolve(String(body.root)) : root
          if (!roots.includes(targetRoot)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const out = await caseGaps(ctx, targetRoot, String(body.folder ?? ''))
          return json(res, out.ok ? 200 : (out.code || 500), out)
        }
        if (method === 'GET' && path === ROUTE + '/api/dm/health') {
          const llm = ctx.get ? ctx.get('llm', false) : false
          const adm = ctx.get ? ctx.get('agentDefaultModel', false) : false
          const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
          return json(res, 200, {
            ok: true,
            llm: !!(llm && typeof llm.prepareCall === 'function'),
            provider: sel ? String(sel.provider) : null,
            model: sel ? String(sel.model) : null,
          })
        }
        if (method === 'POST' && path === ROUTE + '/api/dm') {
          // 页内 DM：对局室「对局」页签的每一句话都走这里，不回会话。
          const roots = rootsFor(cfg)
          const body = await readBody(req)
          const active = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const out = await dmAsk(ctx, { ...body, root: active })
          return json(res, out.ok ? 200 : (out.code || 500), out)
        }
        if (method === 'POST' && path === ROUTE + '/api/xgame') {
          // 游戏厅页内引擎：案卷台代页面调 dsh-xgame 的工具，不回会话。
          const body = await readBody(req)
          const out = await xgameCall(ctx, body)
          return json(res, out.ok ? 200 : (out.code || 500), out)
        }
        if (method === 'POST' && path === ROUTE + '/api/xgame/narrate') {
          const body = await readBody(req)
          const out2 = await xgameNarrate(ctx, body)
          return json(res, out2.ok ? 200 : (out2.code || 500), out2)
        }
        if (method === 'POST' && path === ROUTE + '/api/xgame/reset') {
          const body = await readBody(req)
          const sid = pickSid(body)
          if (!sid) return json(res, 400, { ok: false, error: 'scheme 不合法' })
          try {
            rmSync(join(dshHome(), 'storages', 'dsh-xgame', sid), { recursive: true, force: true })
          } catch (e) {
            return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          return json(res, 200, { ok: true, sid })
        }
        if (method === 'GET' && path === ROUTE + '/api/arcade') {
          // 游戏厅 · 外来内容库清单（公网访客也能列，读不了管理面）
          return json(res, 200, { ok: true, items: scanArcade() })
        }
        if (method === 'POST' && path === ROUTE + '/api/arcade') {
          // 导入内容：{root, folder, scheme, title?}。抽字要先行（peek 链在跑）。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const active = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '')
          if (folder === '') return json(res, 400, { ok: false, error: '缺 folder' })
          const out = arcadeImportPack(active, folder, String(body.scheme ?? ''), body.title, String(body.players ?? ''))
          if (out.ok) {
            const st = extractStatus(active, folder)
            out.needsText = !(st.state === 'done' || st.state === 'idle')
          }
          return json(res, out.ok ? 200 : (out.code || 500), out)
        }
        if (method === 'POST' && path === ROUTE + '/api/arcade/delete') {
          const body = await readBody(req)
          const folder = String(body.folder ?? '')
          if (!/^[^./\\][^/\\]{0,79}$/.test(folder)) return json(res, 400, { ok: false, error: 'folder 不合法' })
          const dir = join(arcadeRoot(), folder)
          if (!existsSync(join(dir, 'arcade.yml'))) return json(res, 404, { ok: false, error: '内容库里没有这一本' })
          try { rmSync(dir, { recursive: true, force: true }) } catch (e) {
            return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          // 留一条删除痕迹：内容库条目凭空消失过一次（13:40），没日志只能靠猜。
          console.error('[game-desk] arcade entry deleted:', folder, new Date().toISOString())
          return json(res, 200, { ok: true })
        }
        if (method === 'POST' && path === ROUTE + '/api/arcade/ask') {
          // 材料局主持人：按资料开局的模型主持；公网流量在这道闸上受 remoteMode 管制。
          const body = await readBody(req)
          const out = await arcadeAsk(ctx, body)
          return json(res, out.ok ? 200 : (out.code || 500), out)
        }
        if (method === 'GET' && path === ROUTE + '/api/remote') {
          return json(res, 200, { ok: true, remote: remoteInfo() })
        }
        if (method === 'POST' && path === ROUTE + '/api/remote') {
          const body = await readBody(req)
          const patch = {}
          if (body.mode === 'off' || body.mode === 'quota' || body.mode === 'allow') patch.remoteMode = body.mode
          if (body.daily !== undefined && body.daily !== null && body.daily !== '') patch.remoteDaily = Math.max(1, Math.min(2000, Number(body.daily) || 40))
          if (Object.keys(patch).length) writeSettings(patch)
          return json(res, 200, { ok: true, remote: remoteInfo() })
        }
        if (path === ROUTE + '/api/lan' && method === 'GET') {
          return json(res, 200, { ok: true, lan: lanStatus() })
        }
        if (path === ROUTE + '/api/lan' && method === 'POST') {
          // 开关只在回环侧给改：局域网设备能玩，不能把门拆了
          const hosts2 = ctx.get('webStartup', false)?.trustedHosts
          if (!trusted(req, hosts2)) return json(res, 403, { ok: false, error: 'lan-toggle-host-only' })
          const body = await readBody(req)
          const patch = {}
          if (typeof body.enabled === 'boolean') patch.lanEnabled = body.enabled
          const pnum = Number(body.port)
          if (pnum >= 1024 && pnum <= 65535) patch.lanPort = pnum
          if (body.rotate) patch.lanKey = randomBytes(3).toString('hex')
          if (Object.keys(patch).length) writeSettings(patch)
          if (readSettings().lanEnabled === true) {
            try { startLan() } catch (e) { LAN.error = String(e && e.message ? e.message : e) }
          } else {
            stopLan()
          }
          return json(res, 200, { ok: true, lan: lanStatus() })
        }
        if (path === ROUTE + '/api/tunnel' && method === 'GET') {
          const hostsT = ctx.get('webStartup', false)?.trustedHosts
          if (!trusted(req, hostsT)) return json(res, 403, { ok: false, error: 'tunnel-host-only' })
          return json(res, 200, { ok: true, tunnel: tunnelStatus() })
        }
        if (path === ROUTE + '/api/tunnel' && method === 'POST') {
          const hostsT2 = ctx.get('webStartup', false)?.trustedHosts
          if (!trusted(req, hostsT2)) return json(res, 403, { ok: false, error: 'tunnel-host-only' })
          const body = await readBody(req)
          if (body && body.rotate === true) writeSettings({ lanRemoteKey: randomBytes(8).toString('hex') })
          if (body && body.enabled === true) startTunnel()
          else if (body && body.enabled === false) stopTunnel()
          return json(res, 200, { ok: true, tunnel: tunnelStatus() })
        }
        return json(res, 404, { ok: false, error: 'not-found', path })
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
  }

  // ---------- 局域网（同 Wi-Fi 的手机/平板也能开案卷台）----------
  const LAN = { server: null, port: 0, error: '' }

  // 撞钥匙计数：来源 ip -> { n 次数, t 窗口起点 }
  const KEY_FAILS = new Map()

  function lanKey() {
    const cur = readSettings()
    if (cur.lanKey) return String(cur.lanKey)
    return String(writeSettings({ lanKey: randomBytes(3).toString('hex') }).lanKey)
  }

  function lanUrls(port) {
    const out = []
    try {
      const ifaces = networkInterfaces()
      for (const nm of Object.keys(ifaces)) {
        for (const ni of ifaces[nm] || []) {
          if (ni.family !== 'IPv4' || ni.internal) continue
          if (String(ni.address).indexOf('169.254.') === 0) continue // 没拿到 DHCP 的自动私有地址，别的设备进不来
          out.push({ url: 'http://' + ni.address + ':' + port + ROUTE + '/app/?k=' + lanKey(), label: String(nm) })
        }
      }
    } catch { /* 拿不到网卡就算了 */ }
    return out
  }

  function lanStatus() {
    const cur = readSettings()
    return {
      enabled: cur.lanEnabled === true,
      running: !!LAN.server,
      port: LAN.port || Number(cur.lanPort) || 5288,
      key: lanKey(),
      urls: LAN.port ? lanUrls(LAN.port) : [],
      error: LAN.error,
    }
  }

  function stopLan() {
    if (LAN.server) { try { LAN.server.close() } catch { /* 关不掉就算了 */ } }
    LAN.server = null
    LAN.port = 0
  }

  function startLan() {
    stopLan()
    LAN.error = ''
    const cur = readSettings()
    const port = Number(cur.lanPort) || 5288
    const server = createServer((req, res) => {
      const u = new URL(String(req.url ?? '/'), 'http://lan.local')
      if (u.pathname === '/') { res.writeHead(302, { Location: ROUTE + '/app/' }); res.end(); return }
      const cookie = String(req.headers.cookie || '')
      // 公网隧道进来的流量 Host 是 *.trycloudflare.com —— 那边只认长钥匙；局域网设备仍用短钥匙
      const viaTunnel = String(req.headers.host || '').toLowerCase().indexOf('.trycloudflare.com') >= 0
      const key = viaTunnel ? remoteKey() : lanKey()
      const ip = String((req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress)) || '?')
      if (cookie.indexOf('gdlan=' + key) >= 0) {
        KEY_FAILS.delete(ip)
        dispatch(req, res).catch(() => { try { res.writeHead(500); res.end() } catch { /* 已断 */ } })
        return
      }
      if (u.searchParams.get('k') === key) {
        KEY_FAILS.delete(ip)
        res.writeHead(302, { Location: u.pathname, 'Set-Cookie': 'gdlan=' + key + '; Path=/; HttpOnly; SameSite=Lax' })
        res.end()
        return
      }
      // 撞钥匙闸门：同一来源 60 秒内错 20 次以上直接吃 429
      const f = KEY_FAILS.get(ip)
      if (f && f.n > 20 && Date.now() - f.t < 60000) {
        json(res, 429, { ok: false, error: 'lan-throttled' })
        return
      }
      if (f && Date.now() - f.t < 60000) KEY_FAILS.set(ip, { n: f.n + 1, t: f.t })
      else KEY_FAILS.set(ip, { n: 1, t: Date.now() })
      if (u.pathname.indexOf(ROUTE + '/app') === 0) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('<!doctype html><meta charset="utf-8"><title>案卷台 · 局域网</title><body style="font-family:Songti SC,SimSun,serif;background:#f4eee2;color:#1a1710;display:flex;min-height:100vh;align-items:center;justify-content:center"><form style="border:1px solid #d8cfba;background:#fbf7ee;padding:26px 30px;max-width:340px" method="get" action="' + ROUTE + '/app/"><div style="letter-spacing:.3em;font-size:11px;color:#8a8070">CASE DESK · LAN</div><h3 style="margin:8px 0 14px">局域网钥匙</h3><input name="k" placeholder="钥匙" autocomplete="off" style="width:100%;padding:8px;font-size:15px;border:1px solid #d8cfba;background:#fff"><button style="margin-top:12px;padding:7px 18px;border:1px solid #a63a2b;background:#a63a2b;color:#fff;cursor:pointer">进案卷台</button></form></body>')
        return
      }
      json(res, 403, { ok: false, error: viaTunnel ? 'remote-key' : 'lan-key' })
    })
    server.on('error', (e) => {
      LAN.error = String(e && e.code ? e.code : (e && e.message ? e.message : e))
      LAN.server = null
      LAN.port = 0
    })
    server.listen(port, '0.0.0.0')
    LAN.server = server
    LAN.port = port
  }

  if (readSettings().lanEnabled === true) {
    try { startLan() } catch (e) { LAN.error = String(e && e.message ? e.message : e) }
  }

  ctx.effect(() => () => stopLan(), 'dsh-game-desk: lan stop')

  // ---------- 公网房间（cloudflared quick tunnel：局域网外的朋友也能进）----------
  const TUNNEL = { child: null, url: '', error: '', starting: false }

  function remoteKey() {
    const cur = readSettings()
    if (cur.lanRemoteKey) return String(cur.lanRemoteKey)
    return String(writeSettings({ lanRemoteKey: randomBytes(8).toString('hex') }).lanRemoteKey)
  }

  function tunnelExe() {
    const local = join(homedir(), '.local', 'bin', 'cloudflared.exe')
    if (existsSync(local)) return local
    return 'cloudflared'
  }

  function tunnelStatus() {
    const rk = remoteKey()
    return {
      running: !!TUNNEL.child,
      starting: !!TUNNEL.starting,
      url: TUNNEL.url,
      error: TUNNEL.error,
      remoteKey: rk,
      link: TUNNEL.url ? TUNNEL.url + ROUTE + '/app/?k=' + rk : '',
    }
  }

  function stopTunnel() {
    if (TUNNEL.child) { try { TUNNEL.child.kill() } catch { /* 杀不掉就算了 */ } }
    TUNNEL.child = null
    TUNNEL.url = ''
    TUNNEL.starting = false
  }

  function startTunnel() {
    if (TUNNEL.child || TUNNEL.starting) return tunnelStatus()
    if (!LAN.server) {
      try { startLan() } catch { /* 起不来下面报错 */ }
      if (!LAN.server) { TUNNEL.error = 'lan-not-running'; return tunnelStatus() }
    }
    TUNNEL.error = ''
    TUNNEL.starting = true
    let child
    try {
      child = spawn(tunnelExe(), ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + LAN.port], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      TUNNEL.starting = false
      TUNNEL.error = String(e && e.message ? e.message : e)
      return tunnelStatus()
    }
    TUNNEL.child = child
    const onData = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (m && !TUNNEL.url) { TUNNEL.url = m[0]; TUNNEL.starting = false }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (e) => {
      if (TUNNEL.child === child) {
        TUNNEL.child = null; TUNNEL.url = ''; TUNNEL.starting = false
        TUNNEL.error = e && e.code === 'ENOENT' ? 'cloudflared-not-installed' : String(e && e.message ? e.message : e)
      }
    })
    child.on('exit', (code) => {
      if (TUNNEL.child === child) {
        TUNNEL.child = null; TUNNEL.url = ''; TUNNEL.starting = false
        if (code !== 0 && code !== null && !TUNNEL.error) TUNNEL.error = 'cloudflared-exited-' + String(code)
      }
    })
    setTimeout(() => {
      if (TUNNEL.starting && TUNNEL.child === child) {
        TUNNEL.error = 'tunnel-timeout'
        stopTunnel()
      }
    }, 45000)
    return tunnelStatus()
  }

  ctx.effect(() => () => stopTunnel(), 'dsh-game-desk: tunnel stop')


  bootStatus('route-registered', { root })
  console.info('[game-desk] 案卷台已挂载：' + ROUTE + '/app ，本子库 ' + root)
}
