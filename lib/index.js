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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, renameSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { basename, dirname, join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn, execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
// 纯函数层（lib/pure/）：代码与原来写在本文里时逐字一致，只搬了位置。
// 本文件自身用到的是 CLUE_MAP / gList（线索卡）与 HINT_MAP / hStr / hSections（提示）；
// 其余名字一并 import 进来，是为了不改变「本文件作用域里有哪些符号」——tmp 下的自检脚本
// 会读本文件原文、末尾 append 一行 `export { … }` 直接调内部函数（如 gd-hints-test.mjs 导出 hintLoop / HINT_MAX）。
import { gNamed, gShingles, gNorm, gList, gHit, gCard, CLUE_MAP } from './pure/clues.mjs'
import { HINT_LABELS, HINT_MAX, HINT_DISASTERS, hStr, hId, hName, hItem, hSection, hSections, hPlaces, hWhere, hLoopNpcHere, hintLoop, hintCouncil, hintCase, hintEscape, hintTrpg, HINT_MAP } from './pure/hints.mjs'
import { pickHostWho, hostAfterRelease } from './pure/room.mjs'
// IO / 领域服务层（lib/core/*、lib/services/*）：按域抽出，函数正文逐字未改，只搬了位置并显式注入依赖。
// 用同名 import 而不是薄委托：全文件调用点一行未改，tmp 探针末尾的 export { … } 也照旧可用
// （ESM 允许 re-export 导入的绑定）。模块内不 import 本文件，依赖方向 core → services 单向，无环。
import {
  dirWake, cloneData, backupStamp, kindOf,
} from './core/util.mjs'
import {
  dshHome, caseRoot, libraryFile, usageFile, modelUsageFile, packMetaKey, packMetaDir, packMetaFile, textStore,
} from './core/paths.mjs'
import {
  flatText, tidyParagraph, CN_DIGIT, cnNumber, humanName, playersGuess,
} from './core/text.mjs'
import {
  stripQuotes, scalar, parseCase, yamlScalar, blockScalar,
} from './core/yaml.mjs'
import {
  TXT_NAME_EXT_RE, outNameOf, legacyOutNameOf, txtNamePlan,
} from './core/names.mjs'
import {
  SCAN_TTL_MS, STORE_NAMES_MEMO, storeTxtNames, inInternalDir, isAiFillRel, extractableFile, scanProgress, walkFilesEx, walkFiles, readTextStore,
} from './services/textstore.mjs'
import {
  SCAN_MEMO, scanCases, packEntry, scanRoot,
} from './services/library.mjs'
import {
  PACKMETA_MEMO, PVP_LITERAL, PVE_LITERAL, PVP_MECH, PVE_MECH, GENRE_WORDS, withPackMeta, readPackMeta, writePackMeta, aiFillItemsOf, applyAiFillToScreen, withAiFillMeta, META_STATE_FIELDS, preserveMetaState, screenStamp, attachPlaytest, firstWord, detectSide, detectGenre, readStoreTexts, detectSpec, screenPack, buildPackMeta, refreshPackMeta,
} from './services/packs.mjs'
import {
  todayLocal, recordModelUsage, todayModelUsage,
} from './services/usage.mjs'
import { splitPages, parseActMarks, buildActs, actAt, sliceActText } from './services/scriptacts.mjs'

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
  /** OCR 引擎：'auto'（默认）= rapid-cuda（GPU 推理）；'rapid' = CPU 版 RapidOCR；'vl' = Qwen3-VL（要显式点名）；
   *  'off' = 完全不 OCR。运行期覆盖写 ~/.dsh/game-desk/settings.json 的 ocrEngine（POST /api/ocr 也行）。 */
  ocrEngine: 'auto',
  /** 兜底用 Qwen3-VL-2B（慢，占显存）；关掉就只用 RapidOCR */
  ocrVlFallback: true,
  /** 整本几乎没字时，把线索图也 OCR 一遍 */
  ocrImages: true,
  // 图片（线索卡）识别策略：'all' 每本都认；'sparse' 只有整本几乎没字时才认（老行为）。
  // 2026-11-19 用户拍板改成 all——有字的书里那些线索卡 jpg 否则永远不会进文本。
  ocrImagesMode: 'all',
  ocrImageMax: 80,
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







/* ------------------------------------------------------------------ *
 * 书库：不要求本子是 case.yml —— 从别处拿来的 PDF 资料夹也照样能读
 * ------------------------------------------------------------------ */


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










/* ---------- 书库条目校验（2026-11-20 安全修复 · 审计 C） ----------
   历史漏洞：/api/file?root=<库根>&folder=..\.. 把 base 挪到库的祖先目录，库外任意文件可读
   （实测 README.md 200 / 70314 字节）；/api/text、/api/import、/api/case 等同一类。
   规矩：凡是用「客户端给的 folder 去 join(root, ...)」的地方，都必须先过这里 ——
   folder 只能是从书库根真实扫出来的那一条，不能是路径、不能带 ..、不能换根。 */

/** 书库根 → 当前真实条目名集合（3 秒记忆：/api/screen 轮询不至于每帧重扫目录）。
 *  fresh=true 绕过记忆（新建/刚导入的本子要立刻能用；被拒时也重扫一次，宁慢不放）。 */
const FOLDER_MEMO = new Map()
const FOLDER_MEMO_MS = 3000
function folderNamesOf(root, fresh) {
  const rootPath = resolve(String(root ?? ''))
  // 2026-11-20 P0-5：记忆键必须带根目录唤醒键 —— 旧键只有 root，新建/导入后 3 秒内新条目看不见
  // （fresh=true 能绕，但 /api/screen 的轮询走的是记忆路径）。目录 mtime 一变就换键 = 立刻失效。
  const memoKey = rootPath + '|' + dirWake(rootPath)
  const now = Date.now()
  const rec = FOLDER_MEMO.get(memoKey)
  if (!fresh && rec && now - rec.at < FOLDER_MEMO_MS) return new Set(rec.names)
  const names = new Set(scanRoot(rootPath).map((c) => String(c.folder)))
  FOLDER_MEMO.set(memoKey, { at: now, names: new Set(names) })
  if (FOLDER_MEMO.size > 32) FOLDER_MEMO.clear()
  return names
}

/** folder 不合格时抛的错：带 code/error，路由层照抄成 JSON。 */
function folderBad(code, why) {
  const e = new Error('folder-not-allowed：' + why)
  e.code = code
  e.error = 'folder-not-allowed'
  return e
}

/** 把客户端给的 folder 校验成「书库里的真实条目」。返回 { root, folder }（root 用的是配置里的规范路径），
 *  不合格抛 { code, error:'folder-not-allowed' }。规则：
 *    1) 去首尾空白与尾部分隔符；空、含 '..'、含 '/' 或 '\'、以盘符开头 ⇒ 400（形如路径，不是条目名）。
 *    2) root 必须落在 rootsFor(CONF) 里（否则拿任意目录当 root 也白名单化不了）⇒ 否则 403。
 *    3) folder 必须是 scanRoot(root) 的条目 ⇒ 否则 403；「已导入本子」的名字（cases 根下的条目）也算，
 *       这是「刚导入的本子」在库里点开的那条路径，join 出来仍受各路由自己的存在性检查。
 *  注意 ScanRoot 是同步的，本函数保留 async 形态是为了调用侧统一 await（也留出将来改异步的余地）。 */
async function requireLibraryFolder(root, folder) {
  const want = String(folder ?? '').trim().replace(/[\\/]+$/, '')
  if (!want) throw folderBad(400, '空 folder')
  if (want.indexOf('..') >= 0) throw folderBad(400, '不得含 ..')
  if (/[\\/]/.test(want)) throw folderBad(400, '不得含路径分隔符')
  if (/^[A-Za-z]:/.test(want)) throw folderBad(400, '不得是盘符路径')
  const base = resolve(String(root ?? ''))
  const roots = rootsFor(CONF).map((r) => resolve(r))
  // Windows 路径大小写不敏感：先精确匹配，再退一步忽略大小写。
  const hit = roots.find((r) => r === base) || roots.find((r) => r.toLowerCase() === base.toLowerCase())
  if (!hit) throw folderBad(403, 'root 不在书库根里')
  if (folderNamesOf(hit, false).has(want)) return { root: hit, folder: want }
  if (folderNamesOf(hit, true).has(want)) return { root: hit, folder: want }
  // 兜底：已导入本子（落在 cases 根里的那条）。只在主判据失败后才扫，正常请求不多付代价。
  let imported = false
  try {
    const cr = resolve(caseRoot(CONF))
    if (cr !== hit) imported = folderNamesOf(cr, true).has(want)
  } catch { imported = false }
  if (!imported) throw folderBad(403, '不是书库里的条目')
  return { root: hit, folder: want }
}

/** 路由里用的一行式版本：校验失败时把 4xx 直接写给客户端并返回 null（调用侧 `if (!f) return`）。 */
async function checkLibraryFolder(res, root, folder) {
  try {
    return await requireLibraryFolder(root, folder)
  } catch (e) {
    json(res, Number(e && e.code) || 403, { ok: false, error: (e && e.error) || 'folder-not-allowed' })
    return null
  }
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
function copyTree(from, to, onFile, prefix = '', opts = {}) {
  mkdirSync(to, { recursive: true })
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    // 2026-11-20 P0-6：_ai_fill/（以及 _text/ 这类内部目录）不是原稿，别跟着拷进新本的 _source/
    if (opts.skipAiFill && ent.name !== '_source' && ent.name.startsWith('_')) continue
    const s = join(from, ent.name)
    const d = join(to, ent.name)
    const rel = prefix === '' ? ent.name : prefix + '/' + ent.name
    if (ent.isDirectory()) {
      copyTree(s, d, onFile, rel, opts)
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

/** 回环地址判定（纯函数，只看 socket 层事实，不看任何头）。
 *  Node 给的是 '127.0.0.1' / '::1' / '::ffff:127.0.0.1'（IPv4-mapped）这几种形态。 */
function isLoopbackAddr(addr) {
  const a = String(addr ?? '').trim().toLowerCase()
  if (!a) return false
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true
  if (a.startsWith('::ffff:')) return /^::ffff:(127\.|7f00:)/.test(a)
  return /^127\./.test(a)
}
/** 从 Host 头取「主机名」（去端口，纯函数）。'[::1]:5288' → '[::1]'，'::1' 原样。 */
function hostNameOf(host) {
  const h = String(host ?? '').trim().toLowerCase()
  if (!h) return ''
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end > 0 ? h.slice(0, end + 1) : h
  }
  const first = h.indexOf(':')
  return first >= 0 && first === h.lastIndexOf(':') ? h.slice(0, first) : h
}
/** 本机请求判定。
 *  2026-11-20 安全修复（审计 A）：旧实现只看 req.headers.host —— 局域网服务把客户端 Host 原样转给
 *  dispatch，「任何持局域网钥匙的设备发 Host: 127.0.0.1」就被判成 local，owner 闸门全体失效。
 *  现在的判据是 socket 层事实：对端必须是回环地址，且 Host 是回环/trustedHosts 之一；
 *  显式来源标记 req.__via（局域网/隧道服务在 dispatch 前打的）优先于两者，Host 只作展示与白名单。
 *  语义：true = 本机（全功能）；false = 非本机（lan/remote，走 GATE_RULES）。 */
function trusted(req, trustedHosts) {
  if (!req) return false
  const tagged = req.__via
  if (tagged === 'local') return true
  if (tagged === 'lan' || tagged === 'remote') return false
  const sock = req.socket ?? req.connection
  if (!isLoopbackAddr(sock && sock.remoteAddress)) return false
  const host = String(req.headers?.host ?? '')
  const name = hostNameOf(host)
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
   计数落 game-desk/remote-usage.json，按本地日期滚动。

   2026-11-20 安全修复（审计 B）：这张表从「黑名单」翻成「白名单」——未登记的路由一律 403
   route-not-allowed（以前未登记 = 放行，新加路由忘了登记就等于对客人敞开）。
   所以新增任何 /api/ 路由时，必须在这里显式写一行，否则连局域网客人也访问不到。 */
const GATE_RULES = {
  /* —— 客人（lan/remote）也能用：只读、无害、以及「他们自己的席位」 ——
     file/text/screen 只读库内已知资料夹（folder 由 requireLibraryFolder 把关）；
     seats/release 只放自己的席位（seatRelease 按 who+via 校验，见那里的注释）。 */
  cases: 'any', case: (m) => (m === 'GET' ? 'any' : 'owner'),
  file: 'any', text: 'any', screen: 'any', catalog: 'any', beat: 'any',
  // 人物剧本按幕给（script/page）：只读库内文件，页图是同一份 PDF 渲染出来的，客人也能看自己的本。
  script: 'any', page: 'any',
  room: 'any', 'room/beat': 'any',
  seats: 'any', 'seats/claim': 'any', 'seats/release': 'any',
  arcade: (m) => (m === 'GET' ? 'any' : 'owner'),
  /* —— 只给机主：烧模型额度、动磁盘、暴露本机信息、改运行状态 —— */
  peek: 'owner', import: 'owner', 'import/status': 'owner', 'import/cancel': 'owner',
  extract: 'owner', 'extract/status': 'owner', 'extract/cancel': 'owner',
  // 缺项复核/补全会烧模型额度、还会往资料夹里落文件，只给机主；公网一律 403。
  'packs/meta': 'owner', 'packs/review': 'owner', 'packs/playtest': 'owner', 'packs/fill': 'owner', 'packs/fill/undo': 'owner',
  // 流程大纲里写着「这一幕之后发真相」，是整本最剧透的一份东西：只给机主。
  flow: 'owner',
  roots: 'owner', restart: 'owner', 'restart-probe': 'owner', 'reload-client': 'owner',
  bootgraph: 'owner', beats: 'owner',
  ocr: 'owner', remote: 'owner', usage: 'owner', 'dm/health': 'owner',
  // 房间控制面（强行开局）与剧透揭示：只给机主。
  'room/force': 'owner', reveal: 'owner',
  // 局域网钥匙与隧道地址本身只给机主看（客人已在里面，不需要再读钥匙）。
  lan: 'owner', tunnel: 'owner',
  'case/gaps': 'owner', 'case/ocr': 'owner', 'case/ocr/status': 'owner', 'case/ocr/cancel': 'owner',
  'arcade/delete': 'owner',
  /* —— 模型面：局域网放行；公网再受房间 + remoteMode 闸门 —— */
  dm: 'model', 'xgame/narrate': 'model', 'arcade/ask': 'model',
  xgame: 'model', 'xgame/reset': 'model', 'xgame/clues': 'model', 'xgame/unlock': 'model', 'xgame/hints': 'model',
}
function viaOf(req, trustedHosts) {
  // 显式来源标记优先（startLan 在 dispatch 前打 req.__via）：这样判来源不依赖任何可伪造的头。
  const tagged = req && req.__via
  if (tagged === 'remote' || tagged === 'lan' || tagged === 'local') return tagged
  const host = String(req.headers.host || '').toLowerCase()
  if (host.indexOf('.trycloudflare.com') >= 0) return 'remote'
  return trusted(req, trustedHosts) ? 'local' : 'lan'
}
function remoteIp(req) {
  return String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '?')
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

/** dispatch 顶部的统一闸门：非本机流量先过这里。返回拦截用的 {code,error} 或 null。
 *  2026-11-20 安全修复（审计 B）：默认拒绝 —— 未列入 GATE_RULES 的路由一律 403 route-not-allowed。
 *  规则值语义（只对非本机流量生效，via === 'local' 在这里直接放行）：
 *    'any'   客人可用；
 *    'owner' 只给机主（403）；
 *    'model' 局域网放行，公网再过房间闸门 + remoteMode；
 *    ''      兼容旧写法，等同 'any'。 */
function gateFor(req, res2, method, path, trustedHosts) {
  const via = viaOf(req, trustedHosts)
  if (via === 'local') return null
  const seg = path.startsWith(ROUTE + '/api/') ? path.slice(ROUTE.length + 5) : ''
  // 静态页（ROUTE + '/app...'）与不在 /api/ 下的路径不进这套表：交给 dispatch 自己 404。
  if (seg === '') return null
  const rule0 = Object.prototype.hasOwnProperty.call(GATE_RULES, seg) ? GATE_RULES[seg] : undefined
  if (rule0 === undefined) return { code: 403, error: 'route-not-allowed' }
  const rule = typeof rule0 === 'function' ? rule0(method) : rule0
  if (rule === 'owner') return { code: 403, error: via === 'remote' ? 'remote-owner-only' : 'owner-only' }
  if (rule === '' || rule === 'any') return null
  if (rule === 'model') {
    if (via !== 'remote') return null
    // 房间闸门（任务4）：没开局就不放烧模型的流量过去 —— 公网链接顶多「在场等开局」
    const rs = roomSnapshot()
    if (rs.state !== 'playing') return { code: 403, error: 'room-' + rs.state, room: rs }
    const g = remoteGate(req)
    if (!g.ok) return { code: g.code, error: g.error }
    return null
  }
  // 认不出的规则值也按拒绝处理（宁可拦错，不可放错）。
  return { code: 403, error: 'route-not-allowed' }
}

// ---------- 房间在场与生命周期（任务4：房主开门、人到齐才开打、人走自动关）----------
// 单独一层：不碰隧道/局域网自身的代码，只经 ROOM.ref（插件主体注册好后注入）读隧道、关隧道。
// 前端页面每 15 秒 POST /api/room/beat {room,who,expect}；60 秒没心跳算「离场」。三条规矩：
//   1) 隧道开着而在场人数为 0（房主页 + 全部访客都不在）→ 自动关房；
//   2) 公网进来的模型面（dm/引擎/转述/材料局）多一道闸：房间没「开局」一律 403 room-waiting；
//   3) 期望人数 = 房主页当前选中本子的席位数（0=没选本子，进来一个人就能开打）；房主可「强行开局」绕过。
const ROOM = { clients: new Map(), force: false, autoClosedAt: 0, ref: null, caseRoot: '', caseFolder: '', hostWho: '', hostAt: 0 }
const ROOM_WINDOW = 60000
/** 把「房主离场」落到 ROOM 上：只清房主身份，房间状态机保持原样（隧道还开着，等下一个本机客户端接任）。 */
function applyHostRelease(who) {
  const next = hostAfterRelease(ROOM.hostWho, who)
  if (next === ROOM.hostWho) return false
  ROOM.hostWho = next
  ROOM.hostAt = 0
  return true
}
function roomBeat(body, via) {
  const who = String((body && body.who) || '').slice(0, 40)
  if (!who) return { ok: false, code: 400, error: 'room-who-required' }
  const room = body.room === 'arcade' ? 'arcade' : 'jubensha'
  if (body.bye === true || body.bye === 1 || body.bye === '1') {
    ROOM.clients.delete(who)
    // 离场同时放掉他占的座位：关页面后席位立即空出来，不必干等 2 分钟 TTL 过期。
    // 只清「这一次在看的那一本」（2026-11-20 修）：以前不带 root/folder，同一个人在别的书里的
    // 席位会被一起抹掉。前端 bye 现在带 caseRoot/caseFolder；没带的老客户端仍退回清全部。
    const byeRoot = body.caseRoot === undefined ? undefined : String(body.caseRoot || '').slice(0, 400)
    const byeFolder = body.caseFolder === undefined ? undefined : String(body.caseFolder || '').slice(0, 200)
    seatReleaseWho(who, byeFolder === undefined ? undefined : byeRoot, byeFolder, via === 'local' ? undefined : via)
    // 走的正好是房主就放开房主身份：房间不因此关门，下一个本机客户端会自动接任。
    applyHostRelease(who)
    // 回包里的 you.via 是前端判断「我是不是房主」的唯一依据：这里漏传 via 会让访客页面上
    // 冒出「强行开局/房间设置」（2026-11-19 实测 bug）。
    return { ok: true, room: roomSnapshot(via, who) }
  }
  const prev = ROOM.clients.get(who) || {}
  let expect = Number(prev.expect) || 0
  if (via === 'local') expect = Math.max(0, Math.min(8, Number(body.expect) || 0))
  if (via === 'local' && body.caseFolder !== undefined) {
    ROOM.caseRoot = String(body.caseRoot || '').slice(0, 400)
    ROOM.caseFolder = String(body.caseFolder || '').slice(0, 200)
  }
  // 定房主：只有 DSH 嵌入页（body.embed，页面 URL 带 ?panel=…）能从别人手里接管房主；
  // 随手开的浏览器标签即使选了本子（caseFolder）也不算 —— caseFolder 只用来记「准备开哪一本」。
  // 换人时记 hostAt；同一位房主每轮心跳（带 embed 那条）也续一次，前端可显示「房主在线」。
  const embed = body.embed === true || body.embed === 1 || body.embed === '1'
  const nextHost = pickHostWho(ROOM.hostWho, who, via, embed, ROOM.clients)
  if (nextHost !== ROOM.hostWho) ROOM.hostAt = nextHost ? Date.now() : 0
  else if (nextHost && nextHost === who && embed) ROOM.hostAt = Date.now()
  ROOM.hostWho = nextHost
  // 昵称不分 via：房主与访客都能改自己的昵称；前端改完立刻再补发一次 beat，这里直接覆盖旧值。
  const nick = String((body && body.name) || '').slice(0, 20)
  ROOM.clients.set(who, { room, via, expect, name: nick, embed, at: Date.now() })
  return { ok: true, room: roomSnapshot(via, who) }
}
/** 在场名册（展示用）：同一台机器（via === 'local'）只算一个玩家 —— 用户实测「同一个 IP 再开一个页面
 *  就多出第三个玩家」。多开本机窗口时，优先用 DSH 嵌入页（embed）那条当代表，否则用最近心跳那条；
 *  被折叠掉的条目**不从 ROOM.clients 删**：它们还在心跳，仍参与房主判定、expect 与过期清理。
 *  merged = 这台机器上有几个本机窗口（只有 > 1 时才带，前端将来可以用）。 */
function roomPresent() {
  const now = Date.now()
  const out = []
  let slot = -1
  let best = null
  let locals = 0
  for (const [who, c] of Array.from(ROOM.clients.entries())) {
    if (now - c.at > ROOM_WINDOW) {
      ROOM.clients.delete(who)
      // 过期离场同样释放房主身份（roomSweep 也走这里清理；房间状态机不动，隧道该怎么开还怎么开）。
      applyHostRelease(who)
      continue
    }
    if (c.via !== 'local') {
      out.push({ who, room: c.room, via: c.via, name: c.name || '', at: c.at })
      continue
    }
    locals += 1
    const item = { who, room: c.room, via: c.via, name: c.name || '', at: c.at, embed: c.embed === true }
    if (!best || (item.embed && !best.embed) || (item.embed === best.embed && item.at > best.at)) best = item
    if (slot < 0) { slot = out.length; out.push(null) }
  }
  if (best) {
    const rep = { who: best.who, room: best.room, via: best.via, name: best.name, at: best.at }
    if (locals > 1) rep.merged = locals
    out[slot] = rep
  }
  return out
}
const ROOM_CASE_CACHE = new Map()
/** 房间里的「是哪一本、什么要素」：房主页面每轮心跳报当前选中的本子，这里按需扫一次书库并缓存 20 秒。
 *  只读；没挂本 / 查不到 → null（前端显示「房主还没选本」）。访客据此看到房主正在开的到底是哪一本。 */
function roomCaseInfo(root, folder) {
  const fol = String(folder || '')
  if (!fol) return null
  const key = String(root || '') + '|' + fol
  const now = Date.now()
  const hit = ROOM_CASE_CACHE.get(key)
  if (hit && now - hit.at < 20000) return hit.info
  let info = null
  try {
    const roots = rootsFor(CONF)
    const at = String(root || '') !== '' && roots.includes(resolve(root)) ? resolve(root) : roots[0]
    const c = scanRoot(at).find((x) => x.folder === fol)
    if (c) {
      const meta = c.kind === 'pack' ? readPackMeta(at, fol) : null
      const miss = meta && Array.isArray(meta.missing) ? meta.missing : []
      info = {
        root: at,
        folder: c.folder,
        title: String(c.title || c.folder),
        kind: String(c.kind || 'pack'),
        players: Number(c.players) || (meta && Number(meta.players)) || 0,
        genre: String(c.genre || (meta && meta.genre) || ''),
        pvp: meta && meta.pvp ? String(meta.pvp) : '',
        complete: meta ? meta.complete !== false : null,
        missing: miss
          .filter((m) => m && typeof m === 'object')
          // 2026-11-20 P0-12 复核：这里只透传 pack-meta 的原始 level（值域 ok/fail/warn，由 screenPack 的
          // checks.add 落的）；String(m.level || 'warn') 只在缺值时兜底，不会把 fail 改写成 warn。
          .map((m) => ({ key: String(m.key || ''), label: String(m.label || ''), level: String(m.level || 'warn') }))
          .slice(0, 8),
      }
    }
  } catch { info = null }
  ROOM_CASE_CACHE.set(key, { at: now, info })
  if (ROOM_CASE_CACHE.size > 80) {
    for (const k of Array.from(ROOM_CASE_CACHE.keys())) {
      ROOM_CASE_CACHE.delete(k)
      if (ROOM_CASE_CACHE.size <= 60) break
    }
  }
  return info
}
function roomSnapshot(via, who) {
  const running = !!(ROOM.ref && ROOM.ref.running())
  const present = roomPresent()
  const guests = present.filter((p) => p.via !== 'local').length
  const host = present.some((p) => p.via === 'local')
  // 名册计数：按折叠后的 present 算（同一台机器开多个本机窗口不重复计数）。
  // 前端要能直接显示「剧本杀几个人 / 游戏厅几个人」，不必自己再数一遍 present。
  const counts = { jubensha: 0, arcade: 0, total: 0 }
  for (const p of present) {
    if (p.room === 'arcade') counts.arcade += 1
    else counts.jubensha += 1
    counts.total += 1
  }
  let expect = 0
  for (const p of present) {
    if (p.via === 'local') { const c = ROOM.clients.get(p.who); if (c) expect = Number(c.expect) || 0 }
  }
  let state = 'idle'
  if (running) {
    if (ROOM.force) state = 'playing'
    else if (!host && guests === 0) state = 'empty'
    else if (expect > 0) state = guests >= expect ? 'playing' : 'waiting'
    else state = guests >= 1 ? 'playing' : 'waiting'
  }
  return { state, running, host, guests, expect, force: ROOM.force, autoClosedAt: ROOM.autoClosedAt, hostWho: ROOM.hostWho, hostAt: ROOM.hostAt, present, counts, case: roomCaseInfo(ROOM.caseRoot, ROOM.caseFolder), you: { via: via || 'local', host: !!(String(who || '') !== '' && ROOM.hostWho === String(who || '')) } }
}
function roomSweep() {
  if (!ROOM.ref || !ROOM.ref.running()) return
  if (roomPresent().length === 0) {
    ROOM.force = false
    ROOM.autoClosedAt = Date.now()
    try { ROOM.ref.stop() } catch { /* 关不掉下一轮再试 */ }
  }
}

// ---------- 座位占用（服务端席位表：谁先认领算谁的）----------
// 前端身份是每个浏览器一个随机 id（localStorage['gd-who']），经 body.who 传进来，与 /api/room/beat 同一套。
// 只放内存：进程重启自然清空；2 分钟没被页面轮询续期就当作空席（关页面时由 bye 分支即时释放）。
const SEATS = new Map()
const SEAT_TTL = 120000
/** 把「这本书的根目录」归一到唯一真路径（纯函数，服务端说了算）：
 *  前端会从不同入口把 root 传成空串 / 本子库路径 / 合集路径 / 带尾空格……
 *  只要差一个字符，seatKey 就是另一个桶，于是三个人能坐同一席（2026-11-19 实测）。
 *  顺序：客户端给的真路径 → 与已知根比对（Windows 路径大小写不敏感）→ 按 folder 在已知根里反查。
 *  都找不到就原样返回（导入本这类边缘情况不阻断认领）。 */
function canonSeatRoot(root, folder) {
  const f = String(folder || '').trim()
  let want = String(root || '').trim()
  if (!f) return want
  const known = []
  for (const r of rootsFor(CONF) || []) {
    const t = String(r || '').trim()
    if (t && known.indexOf(t) < 0) known.push(t)
  }
  const ok = (r) => { try { return existsSync(join(r, f)); } catch { return false; } }
  // 第一优先：按 folder 在服务端已知根里反查。同一本书只落一个桶 —— 客户端传空串 / 本子库 / 合集 /
  // 尾空格都改不了归属，这一层才是真正防「三个人坐同一席」的地方（客户端给的真路径可能只是同一本书的另一个副本）。
  for (const r of known) if (ok(r)) return r
  // 已知根里都没有这本书（本子放在别处 / 临时导入）→ 退回客户端给的真路径，统一成绝对路径写法。
  if (want) {
    try { want = resolve(want); } catch { /* 保留原值 */ }
  }
  return want                                  // 都找不到就原样，不阻断认领
}
function seatKey(root, folder) {
  return canonSeatRoot(root, folder) + '|' + String(folder || '').trim()
}
function seatPrune(map) {
  const now = Date.now()
  for (const [i, v] of Array.from(map.entries())) {
    if (now - v.at > SEAT_TTL) map.delete(i)
  }
}
/** 读一本的席位表。touch=true 时给 who 自己的席位续期（页面轮询即续期，不必另发心跳）。 */
function seatsOf(root, folder, who, touch) {
  // seatKey 内部先做 canonSeatRoot：查询与认领/释放必须落在同一个桶（root 写法不同不算不同书）。
  const key = seatKey(root, folder)
  const bucket = SEATS.get(key)
  if (!bucket) return []
  seatPrune(bucket)
  const now = Date.now()
  const out = []
  for (const [i, v] of Array.from(bucket.entries())) {
    if (touch && who && v.who === who) v.at = now
    out.push({ seat: Number(i), who: v.who, name: v.name, via: v.via, at: v.at, mine: !!(who && v.who === who) })
  }
  // 清空后连带删掉 bucket，SEATS 不会随着换本子一路涨。
  if (bucket.size === 0) SEATS.delete(key)
  return out.sort((a, b) => a.seat - b.seat)
}
function seatClaim(body, via) {
  const who = String((body && body.who) || '').slice(0, 40)
  if (!who) return { ok: false, code: 400, error: 'seat-who-required' }
  const rootRaw = String((body && body.root) || '')
  const folder = String((body && body.folder) || '').trim().slice(0, 200)
  const seat = Math.trunc(Number(body && body.seat))
  if (!folder || !(seat >= 0 && seat < 64)) return { ok: false, code: 400, error: 'seat-bad-request' }
  // 桶键由服务端归一：客户端传什么写法（空串/本子库/合集/尾空格）都落同一个桶，认领才拦得住第二个人。
  const root = canonSeatRoot(rootRaw, folder)
  const key = seatKey(root, folder)
  let bucket = SEATS.get(key)
  if (!bucket) {
    bucket = new Map()
    SEATS.set(key, bucket)
  }
  seatPrune(bucket)
  const held = bucket.get(seat)
  if (held && held.who !== who) {
    // 别人先坐下了：把现占者和整本座位表都回给前端，前端好提示「这一席被谁坐了」并让他另选。
    return { ok: false, code: 409, error: 'seat-taken', seat, holder: { name: held.name, who: held.who, via: held.via }, seats: seatsOf(root, folder, who, false) }
  }
  // 同一 who 的其它席位先删掉：换席自动释放旧席，一个人不会占两把椅子。
  for (const [i, v] of Array.from(bucket.entries())) {
    if (v.who === who && i !== seat) bucket.delete(i)
  }
  bucket.set(seat, { who, name: String((body && body.name) || '').slice(0, 60), via: via || '', at: Date.now() })
  return { ok: true, seat, seats: seatsOf(root, folder, who, false) }
}
/** 释放某人的席位：给了 root+folder 就只清那一本，否则清这个 who 在所有本子里的席位。
 *  via 给定且不是 'local' 时，只清「同一来源」的席位（2026-11-20 审计 D：客人不能靠 body.who 踢别人）。
 *  不给 via（内部清理，如 roomBeat 的 bye 分支）则不按来源过滤。 */
function seatReleaseWho(who, root, folder, via) {
  const id = String(who || '')
  if (!id) return
  const filterVia = typeof via === 'string' && via !== '' && via !== 'local'
  const onlyThisBook = root !== undefined && root !== null && folder !== undefined && folder !== null
  // 指定了书就按归一后的桶键清（root 写法不同也认同一本）；否则清这个 who 的所有席位。
  const keys = onlyThisBook ? [seatKey(root, folder)] : Array.from(SEATS.keys())
  for (const key of keys) {
    const bucket = SEATS.get(key)
    if (!bucket) continue
    for (const [i, v] of Array.from(bucket.entries())) {
      if (v.who !== id) continue
      if (filterVia && v.via !== via) continue
      bucket.delete(i)
    }
    if (bucket.size === 0) SEATS.delete(key)
  }
}
/** 数一下「将要被释放」的席位数（计数口径必须与 seatReleaseWho 的过滤完全一致，否则 released 会说谎）。 */
function seatCountFor(who, root, folder, via) {
  const id = String(who || '')
  if (!id) return 0
  const filterVia = typeof via === 'string' && via !== '' && via !== 'local'
  const onlyThisBook = folder !== ''
  const keys = onlyThisBook ? [seatKey(root, folder)] : Array.from(SEATS.keys())
  let n = 0
  for (const key of keys) {
    const bucket = SEATS.get(key)
    if (!bucket) continue
    for (const v of bucket.values()) {
      if (v.who !== id) continue
      if (filterVia && v.via !== via) continue
      n += 1
    }
  }
  return n
}
/** 释放席位（/api/seats/release 用）。
 *  2026-11-20 审计 D 修复：以前只按 body.who 释放 —— 而 /api/seats 公开每席的 who，
 *  于是任何客人拿别人的 who 就能把人踢下线。现在只释放「who 对得上、且来源（via）也对得上」的席位；
 *  本机（via === 'local'）是房主，可释放任意席（who 为空 = 清这一本的整张表，做管理用）。
 *  返回 released = 实际释放的数量。 */
function seatRelease(body, via) {
  const who = String((body && body.who) || '').slice(0, 40)
  const rootRaw = String((body && body.root) || '')
  const folder = String((body && body.folder) || '').trim().slice(0, 200)
  const root = canonSeatRoot(rootRaw, folder)
  const from = typeof via === 'string' ? via : ''
  const local = from === 'local'
  if (who === '' && !local) {
    // 非本机：空 who 不再当「清所有」，直接拒（旧行为=静默清掉整个 who='' 的桶，容易误伤也说不清）。
    return { ok: false, code: 400, error: 'seat-who-required', seats: seatsOf(root, folder, '', false) }
  }
  if (who === '' && local) {
    // 房主清场：给了 folder 就清这一本，否则清全部。
    const keys = folder ? [seatKey(root, folder)] : Array.from(SEATS.keys())
    let n = 0
    for (const key of keys) {
      const bucket = SEATS.get(key)
      if (!bucket) continue
      n += bucket.size
      SEATS.delete(key)
    }
    return { ok: true, released: n, seats: [] }
  }
  const released = seatCountFor(who, root, folder, local ? '' : from)
  // 不给 folder 就当「这本没指定」→ 清他在所有本子里的席位（换本子后残留的旧席也一起收掉）。
  seatReleaseWho(who, folder ? root : undefined, folder ? folder : undefined, local ? undefined : from)
  return { ok: true, released, seats: seatsOf(root, folder, who, false) }
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
 * 评判不猜内容：从抽出的文字里认「人数 / 类型 / 难度 / 时长 / 角色行 / 引子 /
 * 线索数」这几件能指回原文的事，每样都认多种常见写法；认不出标 warn 但措辞是
 * 「没认出」不是「没有」——写法不同会误报，detail 里给搜索提示，用户再决定导不导。
 * ------------------------------------------------------------------ */












/* ---------- AI 补全感知（用户 2026-11-19） ----------
   需求原话：「补全缺少的项目之后在体检处没更新，补全的项目在体检处也要打上标记」。
   补全记录在 pack-meta 的 aiFill.items（key 与体检 check 的 id 同源：premise / scripts / clues …），
   但体检本身是「原稿」的判据，screenPack 不能改写（重算标签要靠它算原始缺项）——
   所以这里做纯函数：一个给体检结果打标记，一个给 meta 加派生字段，一个保住重算时会被覆盖的补全账。 */












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
    lines.push('# 导入体检没认出的项 —— 没认出 ≠ 原文没有：先在 _text/ 里按关键词搜一遍，写法不同会误报；确实没有再补原文，重导同一资料夹会刷新')
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


/** 覆盖 case.yml 之前留一份 case.yml.bak-<时间戳>；同一本最多留最近 5 份（多的按名字序删最旧）。
 *  2026-11-20 P0-7：重导不再是无备份覆盖 —— case.yml 里是人工/质检攒出来的 meta（角色、缺项、结论），
 *  一次误重导就把它们抹了。备份失败不挡导入（备份是后悔药，不是前置条件）。 */
function backupCaseYml(file) {
  if (!existsSync(file)) return ''
  const bak = file + '.bak-' + backupStamp()
  try { copyFileSync(file, bak) } catch { return '' }
  try {
    const dir = dirname(file)
    const head = basename(file) + '.bak-'
    const olds = readdirSync(dir).filter((n) => n.startsWith(head)).sort()
    while (olds.length > 5) {
      const drop = olds.shift()
      try { rmSync(join(dir, drop), { force: true }) } catch { /* 删不掉就留着，下次再删 */ }
    }
  } catch { /* 清理失败不影响备份本身 */ }
  return bak
}
/** 资料夹 → 本子库里的一个本子：拷原始文件、拷抽出文本、写 case.yml。 */
async function importPack(cfg, root, folder, opts = {}) {
  const job = opts.job || null
  // 2026-11-20 审计 C（纵深防御）：调用侧 /api/import 已经验过库内条目，这里再兜一次 ——
  // importPack 会往 packDir 里落 _text/ 与 meta，folder 绝不许是路径。
  {
    const bad = String(folder ?? '').trim()
    if (!bad || bad.indexOf('..') >= 0 || /[\\/]/.test(bad) || /^[A-Za-z]:/.test(bad)) {
      return { ok: false, code: 400, error: 'folder-not-allowed' }
    }
  }
  const stage = (phase, patch) => {
    if (!job) return
    job.phase = phase
    if (patch) Object.assign(job, patch)
  }
  const packDir = join(root, folder)
  if (!existsSync(packDir)) return { ok: false, code: 404, error: '资料夹不存在：' + packDir }
  stage('scan', { done: 0, total: 0, rel: '' })
  const files = walkFiles(packDir, '', 0, [], { skipInternal: true })
  const pack = packEntry(folder, packDir, files)
  let store = readTextStore(root, folder)
  if (store.files.length === 0 && opts.extract !== false) {
    try {
      const ex = await extractPack(root, folder, {
        cancelRef: job,
        onProgress: (p) => stage(p.phase === 'image' ? 'image' : 'text', { done: p.done || 0, total: p.total || 0, rel: p.rel || '' }),
      })
      if (job && ex) {
        job.engine = ex.engine || ''
        job.provider = ex.provider || ''
        if (ex.engineError) job.engineError = ex.engineError
      }
      // CUDA 起不来：不拿 CPU 掉下来的文本凑合评判，直接把原因交回去。
      if (ex && ex.engineError) return { ok: false, code: 503, error: ocrErrorText(ex.engineError), engineError: ex.engineError }
    } catch { /* 抽不出就按没文字评判 */ }
    store = readTextStore(root, folder)
  }
  if (job && job.cancelled) return { ok: false, code: 499, error: '导入已取消（没开始拷贝）' }
  const screen = screenPack(root, folder, pack, store)
  if (screen.verdict === 'blocked' && opts.force !== true) {
    return { ok: false, code: 422, error: '没有可读文字，先补文字版（或强制导入）', screen }
  }
  const libRoot = caseRoot(cfg)
  const existing = scanCases(libRoot)
  // 同一来源再导一次 = 刷新那一本，不再多出一本一样的
  // 2026-11-20 P0-8：同一来源的判据必须是「同一来源根 + 同一来源文件夹」。
  // 只比 folder 时，从别的库导入的同名资料夹会被认成 twin，把人家那一本的 _source/_text 清掉改写。
  // source_root 归一：存量 case.yml 里有双反斜杠旧值（旧 yamlScalar 写成两个），比较前先压成单个。
  const BS = String.fromCharCode(92)
  const normRoot = (p) => {
    let s = String(p ?? '').trim()
    while (s.indexOf(BS + BS) >= 0) s = s.split(BS + BS).join(BS)
    if (s === '') return ''
    try { return resolve(s) } catch { return s }
  }
  const twin = existing.find((c) => String(c.sourceFolder || '') === folder && normRoot(c.sourceRoot) === normRoot(root))
  const used = new Set(existing.map((c) => String(c.id)))
  let n = 1
  if (!twin) {
    while (used.has(String(n).padStart(2, '0'))) n += 1
  }
  const id = twin ? String(twin.id) : String(n).padStart(2, '0')
  const title = humanName(screen.title || folder)
  const caseFolder = twin ? twin.folder : (id + '-' + title.replace(/[\\/:*?"<>|]/g, '').slice(0, 24))
  const caseDir = join(libRoot, caseFolder)
  // 2026-11-20 P0-7：重导不许「先删后写」。
  // 旧 _source/_text 先改名成同名 .bak-<时间戳>（同盘 rename，原子的），新内容全部写完再删备份；
  // case.yml 覆盖前另存 case.yml.bak-<时间戳>。
  // 中途失败：删掉本轮写了一半的新目录、把备份 rename 回原名 —— 任何一刻磁盘上都有完整的一份。
  const ts = backupStamp()
  const textCount = Array.isArray(store.files) ? store.files.length : 0
  const parked = []
  const park = (name) => {
    const from = join(caseDir, name)
    if (!existsSync(from)) return
    const to = from + '.bak-' + ts
    try { renameSync(from, to) } catch { return /* 挪不动就原地留着，后面按覆盖写处理 */ }
    parked.push({ from, to })
  }
  try {
    mkdirSync(caseDir, { recursive: true })
    if (twin) {
      park('_source')
      // 这一轮没有文本可写（opts.extract === false，或抽不出字）时别动旧 _text：
      // 旧代码是「删掉再拷」，store 一空就等于把上一轮的缓存文本抹掉。
      if (textCount > 0) park('_text')
    }
    stage('copy', { done: 0, total: files.length, rel: '' })
    let copied = 0
    copyTree(packDir, join(caseDir, '_source'), (rel) => {
      copied += 1
      stage('copy', { done: copied, total: files.length, rel })
    }, '', { skipAiFill: true })
    stage('write', { done: copied, total: files.length, rel: 'case.yml' })
    const textOut = join(caseDir, '_text')
    mkdirSync(textOut, { recursive: true })
    for (const f of store.files) {
      try { copyFileSync(join(store.dir, f.txt), join(textOut, f.txt)) } catch { /* 单份失败不挡整本 */ }
    }
    const ymlFile = join(caseDir, 'case.yml')
    backupCaseYml(ymlFile)
    writeFileSync(ymlFile, importCaseYml({ id, title, spec: screen.spec, screen, folder, root, fileCount: files.length }), 'utf8')
  } catch (e) {
    // 回滚：先清掉本轮可能写了一半的新目录，再把备份 rename 回原名
    for (const mv of parked) {
      try { rmSync(mv.from, { recursive: true, force: true }) } catch { /* 清不掉就留着，备份还在 */ }
      try { renameSync(mv.to, mv.from) } catch { /* 回滚失败照实报错，别吞 */ }
    }
    return { ok: false, code: 500, error: String(e && e.message ? e.message : e) }
  }
  // 新内容已经落盘写全，这时才删备份
  for (const mv of parked) {
    try { rmSync(mv.to, { recursive: true, force: true }) } catch { /* 删不掉就留着，下次重导再覆盖 */ }
  }
  return { ok: true, id, folder: caseFolder, dir: caseDir, file: join(caseDir, 'case.yml'), screen, updated: Boolean(twin) }
}


/* ---------- OCR 闸门：默认串行，一次只让一份文件过 ----------
   用户 2026-11-19 定：OCR 一律串行，必要时才并行；页面给一个「并行」开关。
   并行的代价很实在：CPU 抢核 + 显存只够一个 VL 实例，同时跑两份反而更慢。 */
const OCR_GATE = { parallel: false, running: 0, queue: [] }
/** 正在跑 OCR 的文件台账（闸口层，跨抽取/导入共用）。热重载会清零这张表——在途子进程照常跑完、结果照常进缓存，但这里看不见，属已知代价。 */
const OCR_ACTIVE = []

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
  const jobs = []
  const collect = (map, kind) => {
    map.forEach((job, key) => {
      if (!job || job.state !== 'running') return
      const i = key.lastIndexOf('|')
      jobs.push({
        kind,
        root: i > 0 ? key.slice(0, i) : key,
        folder: i > 0 ? key.slice(i + 1) : key,
        state: job.state,
        phase: job.phase || 'text',
        done: job.done || 0,
        total: job.total || 0,
        rel: job.rel || '',
        startedAt: job.startedAt || 0,
        elapsedMs: Date.now() - (job.startedAt || Date.now()),
        cancelled: Boolean(job.cancelled),
      })
    })
  }
  collect(EXTRACT_JOBS, 'extract')
  collect(IMPORT_JOBS, 'import')
  collect(CASE_OCR_JOBS, 'case-ocr')
  return {
    parallel: OCR_GATE.parallel,
    running: OCR_GATE.running,
    queued: OCR_GATE.queue.length,
    jobs,
    current: OCR_ACTIVE.map((a) => ({ file: a.file, startedAt: a.startedAt })),
    // 引擎口径（用户 2026-11-19 要的「状态可观测」）：实际生效哪个引擎、是否已停用、CUDA 证据、批处理计数。
    engine: resolveOcrEngine(),
    engineSetting: ocrSettingRaw(),
    engineDefault: OCR_DEFAULT_ENGINE,
    engineError: ocrEngineError(),
    providers: { active: OCR_ENGINE_STATE.provider, evidence: OCR_ENGINE_STATE.evidence, at: OCR_ENGINE_STATE.at },
    batch: { ...OCR_ENGINE_STATE.batch },
  }
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

/* ---------- OCR：扫描件 PDF / 线索图（默认 paddle，按批处理） ----------
   引擎（用户 2026-11-19 20:04：「以后把这个换成默认的」）：
   - rapid-cuda = RapidOCR + onnxruntime CUDA，跑在 gsv-venv。推理在 GPU，PDF 渲染与预处理仍在 CPU，
     所以 GPU 档的天花板是 CPU 预处理（实测数字见 README）。
   - rapid      = RapidOCR CPU，跑在 whisper-venv。只有用户显式 settings.ocrEngine='rapid' 才走这条。
   - vl         = Qwen3-VL-2B（torch+CUDA），慢、吃显存；只有显式点名（body.engine='vl' 或设置里写 vl）
     才用，不进默认链。
   批处理：一趟 python 进程收多份文件（--in f1 ... f6），模型只加载一次；stdout 是 JSONL，每行一份文档。
   CUDA 不可用（provider 拿不到 / exit 2 缺依赖 / exit 4 显存）**不静默回落 CPU**：任务就此停下并报
   engineError='cuda-unavailable'；要 CPU 只能用户自己把 settings.ocrEngine 设成 'rapid'。
   CLI 在 tools/ocr.py，约定：--engine --in <多个路径> --json，出错非 0 退出（单份失败不杀整批）。 */
const PLUGIN_ROOT = resolve(HERE, '..')
const OCR_SCRIPT = join(PLUGIN_ROOT, 'tools', 'ocr.py')
const OCR_PY = {
  'rapid-cuda': join(homedir(), '.dsh', 'tools', 'gsv-venv', 'Scripts', 'python.exe'),
  rapid: join(homedir(), '.dsh', 'tools', 'whisper-venv', 'Scripts', 'python.exe'),
  vl: join(homedir(), '.dsh', 'tools', 'gsv-venv', 'Scripts', 'python.exe'),
  paddle: join(homedir(), '.dsh', 'tools', 'paddle-venv', 'Scripts', 'python.exe'),
}
/** paddle 有自己的 CLI（PP-OCRv5，tools/paddle_ocr.py），其余引擎共用 tools/ocr.py；契约完全一致。 */
const OCR_SCRIPT_BY_ENGINE = { paddle: join(PLUGIN_ROOT, 'tools', 'paddle_ocr.py') }
function ocrScriptFor(engine) { return OCR_SCRIPT_BY_ENGINE[engine] || OCR_SCRIPT }

/** 一批几份。6 是「把冷启摊薄」与「进度条别停太久」的折中：6 份 16 页扫描件在 GPU 档约一分钟级。 */
const OCR_BATCH_SIZE = 6
/** 单份超时（毫秒）；整批超时 = 份数 × 单份，封顶 15 分钟（6 份 vl 也够跑）。 */
const OCR_TIMEOUT_PER_FILE = { 'rapid-cuda': 240000, rapid: 180000, vl: 300000, paddle: 300000 }
const OCR_TIMEOUT_CAP = 900000
/** 默认引擎 = GPU 档；插件配置里的 'auto' 就落到它身上。 */
const OCR_DEFAULT_ENGINE = 'paddle'

const execFileAsync = promisify(execFile)

function ocrAvailable(engine) {
  try { return existsSync(ocrScriptFor(engine)) && existsSync(OCR_PY[engine]) } catch { return false }
}

/** OCR 引擎的运行期记账（只在本进程里）：最近一次实际生效的 provider + 证据行，以及「起不来」的原因。 */
const OCR_ENGINE_STATE = {
  provider: '',   // 'cuda' | 'cpu' | ''
  evidence: '',   // 判定依据（ocr.py stderr 原文），给 /api/ocr 核对
  at: 0,
  error: null,    // { code, reason, at, latched } —— 非 null 表示这套引擎起不来
  batch: { size: OCR_BATCH_SIZE, batches: 0, files: 0, failed: 0 },
}

/** 用户在 settings.json 里写的引擎优先（运行期可改；POST /api/ocr {engine} 也写这里），没写就看插件配置。 */
function ocrSettingRaw() {
  const s = readSettings()
  if (typeof s.ocrEngine === 'string' && s.ocrEngine.trim() !== '') return s.ocrEngine.trim().toLowerCase()
  return String(CONF.ocrEngine || 'auto').trim().toLowerCase()
}

/** 生效引擎：'off' 关掉；'rapid'/'vl' 是用户显式点名；其余（auto / 空 / 写错）一律默认 rapid-cuda。 */
function resolveOcrEngine() {
  const raw = ocrSettingRaw()
  if (raw === 'off') return 'off'
  if (raw === 'vl') return 'vl'
  if (raw === 'rapid') return 'rapid'
  if (raw === 'paddle') return 'paddle'
  if (raw === 'rapid-cuda') return 'rapid-cuda'
  // auto / 空 / 写错 → 默认 paddle（PP-OCRv5，实测 0.35-0.42 秒/页，约为 rapid-cuda 的 8 倍速）；
  // paddle 没装好才退 GPU 档 rapid-cuda，再退 CPU 档 rapid。
  if (OCR_DEFAULT_ENGINE === 'paddle') {
    if (ocrAvailable('paddle')) return 'paddle'
    if (ocrAvailable('rapid-cuda')) return 'rapid-cuda'
    return 'rapid'
  }
  return OCR_DEFAULT_ENGINE
}

function ocrEngineError() { return OCR_ENGINE_STATE.error ? { ...OCR_ENGINE_STATE.error } : null }

function ocrClearEngineError() {
  if (OCR_ENGINE_STATE.error) console.info('[game-desk] OCR 引擎错误记录已清（换引擎或显式重试）')
  OCR_ENGINE_STATE.error = null
}

/** 一句话报错文案：直接进任务状态/接口响应，页面上照抄就能知道下一步干嘛。 */
function ocrErrorText(err) {
  const e = err || {}
  if (e.code === 'cuda-unavailable') return 'CUDA 不可用：' + (e.reason || '没拿到 CUDAExecutionProvider') + '（不回落 CPU；要 CPU 请把 settings.ocrEngine 设成 rapid）'
  if (e.code === 'paddle-unavailable') return 'PaddleOCR 没出结果：' + (e.reason || '未知原因') + '（可以 POST /api/ocr {engine:"rapid-cuda"} 换回 GPU 档）'
  if (e.code === 'engine-unavailable') return 'OCR 引擎不可用：' + (e.reason || '缺解释器或 OCR 脚本')
  return 'OCR 失败：' + (e.reason || '未知原因')
}

/** JSONL 里 source 是绝对路径；Windows 上大小写/斜杠写法可能不一致，比较前统一（resolve 会把 / 规整成 \）。 */
function ocrKey(p) { return String(resolve(String(p))).toLowerCase() }

/** 从 ocr.py 的 stderr 里抠 provider 证据：ort.get_available_providers()、session.get_providers()、回落说明。 */
const OCR_PROVIDER_HINT = /provider=|get_providers|CUDAExecutionProvider|回落 CPU/
function ocrProviderEvidence(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter((l) => l !== '' && OCR_PROVIDER_HINT.test(l))
  let provider = ''
  if (lines.some((l) => /provider=cuda/.test(l))) provider = 'cuda'
  else if (lines.some((l) => /provider=cpu/.test(l) || /回落 CPU/.test(l))) provider = 'cpu'
  return { provider, lines, evidence: lines.slice(-2).join(' | ') }
}

function ocrLastLine(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter((l) => l !== '')
  return (lines[lines.length - 1] || '').slice(0, 300)
}

/** 记下本次实际用的 provider（硬证据）；CUDA 真生效时顺手把上次的错误记录清掉。 */
function ocrNoteProvider(engine, ev, docs) {
  let provider = ev ? ev.provider : ''
  let evidence = ev ? ev.evidence : ''
  if (provider === '' && docs && typeof docs.values === 'function') {
    // stderr 被 ocr.py 的 re-exec 吃掉了也不怕：JSONL 每份文档都带 provider 字段。
    for (const d of docs.values()) {
      if (d && d.provider) { provider = d.provider; evidence = evidence || ('JSONL provider=' + d.provider); break }
    }
  }
  if (provider === '') return
  OCR_ENGINE_STATE.provider = provider
  OCR_ENGINE_STATE.evidence = String(evidence || '').slice(0, 500)
  OCR_ENGINE_STATE.at = Date.now()
  console.info('[game-desk] OCR provider=' + provider + '（engine=' + engine + '）证据：' + OCR_ENGINE_STATE.evidence)
  if (provider === 'cuda') OCR_ENGINE_STATE.error = null
}

/** 这一批是不是「引擎本身起不来」：缺依赖(exit 2) / CUDA provider 没生效（ocr.py 已悄悄回落 CPU）/ 显存(exit 4)。
 *  判据只用 ocr.py 自己吐的东西（stderr 原文 + JSONL 的 provider 字段），不猜。 */
function ocrEngineFailure(engine, res) {
  const ev = ocrProviderEvidence(res.stderr)
  if (engine === 'paddle') {
    if (res.code === 0 || res.docs.size > 0) return null
    return { code: 'paddle-unavailable', reason: 'paddle 引擎没出结果（exit ' + res.code + '）：' + ocrLastLine(res.stderr), latched: false }
  }
  const docs = res.docs ? Array.from(res.docs.values()) : []
  const sawCuda = docs.some((d) => d.provider === 'cuda')
  const sawCpuOnly = docs.length > 0 && docs.every((d) => d.provider !== 'cuda')
  const cudaHint = /cuda|cudnn|onnxruntime|provider|显存|out of memory/i.test(String(res.stderr || ''))
  if (engine === 'rapid-cuda') {
    if (sawCuda) return null
    if (res.code === 2) return { code: 'cuda-unavailable', reason: 'ocr.py exit 2（引擎缺依赖）：' + ocrLastLine(res.stderr), latched: true }
    if (ev.provider === 'cpu' || sawCpuOnly) return { code: 'cuda-unavailable', reason: 'CUDA 未生效，ocr.py 回落 CPU：' + (ev.evidence || ocrLastLine(res.stderr)), latched: true }
    if (res.code === 4 && cudaHint) return { code: 'cuda-unavailable', reason: 'exit 4（显存/内存不足）：' + ocrLastLine(res.stderr), latched: false }
    if (res.code === 1 && docs.length === 0 && cudaHint) return { code: 'cuda-unavailable', reason: 'exit 1 且无输出：' + ocrLastLine(res.stderr), latched: false }
    return null
  }
  if (res.code === 2 || (res.code !== 0 && docs.length === 0)) return { code: 'engine-unavailable', reason: 'ocr.py exit ' + res.code + '：' + ocrLastLine(res.stderr), latched: res.code === 2 }
  return null
}

function ocrRecordEngineFailure(engine, fail) {
  const prev = OCR_ENGINE_STATE.error
  const next = { code: fail.code || 'cuda-unavailable', reason: String(fail.reason || '').slice(0, 400), at: Date.now(), latched: Boolean(fail.latched) }
  // 永久性原因（缺依赖 / CUDA provider 拿不到）留在记账本里，后面别再一份份去试；exit 4 显存是可恢复的，不记。
  OCR_ENGINE_STATE.error = (next.latched || !prev) ? next : prev
  console.info('[game-desk] OCR 引擎停用（' + engine + '）：' + next.reason)
}

/** JSONL → Map。--json 是「每行一个文档对象」，坏行只跳过（一行坏不杀其他行）。 */
function ocrParseJsonl(raw) {
  const docs = new Map()
  let bad = 0
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim()
    if (t.startsWith('{') === false) continue
    let doc = null
    try { doc = JSON.parse(t) } catch { bad += 1; continue }
    const src = doc && doc.source
    if (typeof src !== 'string' || src === '') { bad += 1; continue }
    const text = Array.isArray(doc.pages)
      ? doc.pages.map((p) => String((p && p.text) || '')).join('\n\f\n')
      : String(doc.text || '')
    docs.set(ocrKey(src), { text, engine: String(doc.engine || ''), provider: String(doc.provider || ''), ms: Number(doc.ms) || 0, source: src })
  }
  return { docs, bad }
}

/** 跑一批：一次 python 进程吃 files 里所有文件。返回 { docs, code, stderr, timedOut }。
 *  用异步 execFile：OCR 动辄一分钟，同步版会把宿主事件循环焊死（2026-11-19 实测导致整轮会话卡死）。 */
async function ocrBatchRun(files, engine, opts = {}) {
  const per = Number(opts.perFileTimeout) || OCR_TIMEOUT_PER_FILE[engine] || 180000
  const cap = Math.min(per * Math.max(1, files.length), OCR_TIMEOUT_CAP)
  const act = { file: files.length > 1 ? (files[0] + ' 等 ' + files.length + ' 份（同批）') : files[0], startedAt: Date.now() }
  OCR_ACTIVE.push(act)
  if (OCR_ACTIVE.length > 3) OCR_ACTIVE.splice(3) // 台账只留最早 3 条（正在跑/最先排队的就是显示用的）
  await ocrSlot()
  let code = 0
  let stdout = ''
  let stderr = ''
  let timedOut = false
  try {
    // 取消检查放在拿到名额之后、起子进程之前：排到队了但任务已被取消的，不再白跑一份。
    if (opts.cancelRef && opts.cancelRef.cancelled) return { cancelled: true, docs: new Map(), code: 0, stderr: '', timedOut: false }
    try {
      const { stdout: so, stderr: se } = await execFileAsync(OCR_PY[engine], [ocrScriptFor(engine), '--engine', engine, '--in', ...files, '--json'], {
        maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: cap,
      })
      stdout = String(so || '')
      stderr = String(se || '')
    } catch (e) {
      // exit 1「部分文件失败」、exit 4「显存不足或整批失败」都走这里，但**已经吐出来的 JSONL 行仍要收**；
      // 只有连一行都没有才算进程级失败（那才由 ocrMany 决定要不要逐份重试）。
      stdout = String((e && e.stdout) || '')
      stderr = String((e && e.stderr) || (e && e.message) || '')
      const c = Number(e && e.code)
      code = Number.isFinite(c) ? c : -1
      timedOut = Boolean(e && e.killed) && !stdout.trim()
      if (!stdout.trim()) console.info('[game-desk] OCR 整批无输出（' + engine + '，' + files.length + ' 份，exit ' + code + '）：' + ocrLastLine(stderr))
    }
    const parsed = ocrParseJsonl(stdout)
    return { cancelled: false, docs: parsed.docs, bad: parsed.bad, code, stdout, stderr, timedOut }
  } finally {
    const ai = OCR_ACTIVE.indexOf(act)
    if (ai >= 0) OCR_ACTIVE.splice(ai, 1)
    ocrRelease()
  }
}

/** 一批一批地跑完 files：单份失败只记这一份、不杀整批；整批一滴输出都没有（崩溃/超时）才逐份各重试一次。
 *  返回 { texts, engine, provider, engineError, failed }；engineError 非空 = 这一轮别再往下跑了。 */
async function ocrMany(files, engine, opts = {}) {
  const list = (files || []).map(String).filter((f) => f !== '')
  const texts = new Map()
  const out = { texts, engine, provider: '', engineError: null, failed: [] }
  const done = () => { out.failed = list.filter((f) => !texts.has(ocrKey(f))); out.provider = OCR_ENGINE_STATE.provider; return out }
  if (list.length === 0 || engine === 'off') return done()
  // 已经记着这台机器的 CUDA 起不来（缺依赖 / provider 拿不到）：直接报错，不再一份份试，更不偷偷用 CPU。
  const latchedErr = ocrEngineError()
  if (engine === 'rapid-cuda' && latchedErr && latchedErr.latched) { out.engineError = latchedErr; return done() }
  if (!ocrAvailable(engine)) {
    const reason = '缺解释器或 OCR 脚本：' + String(OCR_PY[engine] || '') + ' / ' + String(ocrScriptFor(engine) || '')
    if (engine === 'rapid-cuda') {
      out.engineError = { code: 'cuda-unavailable', reason, at: Date.now(), latched: false }
      ocrRecordEngineFailure(engine, out.engineError)
    } else {
      out.engineError = { code: 'engine-unavailable', reason, at: Date.now(), latched: false }
    }
    return done()
  }
  try {
    for (let i = 0; i < list.length; i += OCR_BATCH_SIZE) {
      if (opts.cancelRef && opts.cancelRef.cancelled) break
      const batch = list.slice(i, i + OCR_BATCH_SIZE)
      OCR_ENGINE_STATE.batch.batches += 1
      OCR_ENGINE_STATE.batch.files += batch.length
      if (typeof opts.onBatchStart === 'function') { try { opts.onBatchStart(batch, i) } catch { /* 进度回调出错不影响 OCR */ } }
      const res = await ocrBatchRun(batch, engine, opts)
      if (res.cancelled) break
      ocrNoteProvider(engine, ocrProviderEvidence(res.stderr), res.docs)
      const fail = ocrEngineFailure(engine, res)
      if (fail) {
        // CUDA 起不来：ocr.py 可能已经按 CPU 把这几份跑完并吐了行 —— 那些文本**不采纳**（用户要的是 GPU 档），
        // 后面的批也不再跑。任务就停在这儿，原因回给调用方写进任务状态。
        ocrRecordEngineFailure(engine, fail)
        out.engineError = { ...fail, at: Date.now() }
        break
      }
      for (const f of batch) {
        const hit = res.docs.get(ocrKey(f))
        if (hit && hit.text.trim() !== '') texts.set(ocrKey(f), hit)
      }
      if (res.docs.size === 0 && res.bad === 0 && res.code !== 0) {
        // 整批一滴 JSONL 都没吐（进程崩了/超时）：降级成逐份各试一次，别让一份的锅背到整批上。
        console.info('[game-desk] OCR 整批无输出，逐份重试 ' + batch.length + ' 份（' + engine + '，exit ' + res.code + '）')
        for (const f of batch) {
          if (opts.cancelRef && opts.cancelRef.cancelled) break
          const one = await ocrBatchRun([f], engine, opts)
          if (one.cancelled) break
          ocrNoteProvider(engine, ocrProviderEvidence(one.stderr), one.docs)
          const oneFail = ocrEngineFailure(engine, one)
          if (oneFail) { ocrRecordEngineFailure(engine, oneFail); out.engineError = { ...oneFail, at: Date.now() }; break }
          const hit = one.docs.get(ocrKey(f))
          if (hit && hit.text.trim() !== '') texts.set(ocrKey(f), hit)
        }
        if (out.engineError) break
      }
    }
  } finally {
    OCR_ENGINE_STATE.batch.failed += list.filter((f) => !texts.has(ocrKey(f))).length
  }
  return done()
}

/** 单份的旧接口（保留给零散调用）：内部走批处理，返回纯文本（失败返回 ''）。 */
function ocrToText(file, engine, timeoutMs, cancelRef) {
  if (cancelRef && cancelRef.cancelled) return Promise.resolve('')
  return ocrMany([file], engine, { cancelRef, perFileTimeout: timeoutMs }).then((r) => {
    const hit = r.texts.get(ocrKey(file))
    return hit ? hit.text : ''
  })
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




/** apply 时的生效配置（OCR 开关这类要给抽取函数看，才不必层层传参）。 */
const CONF = { ...DEFAULTS }

/** 抽取任务表：key = root|folder。宿主不能同步等 OCR，页面改成轮询这里的状态。 */
const EXTRACT_JOBS = new Map()
const extractKey = (root, folder) => String(root) + '|' + String(folder)

/** 目录没读全时的说明（P0-2）：状态里带出去让页面能显示，不破坏原有字段。 */
function incompleteNote(job) {
  if (!job || !job.incomplete) return ''
  const n = Array.isArray(job.walkErrors) ? job.walkErrors.length : 0
  return '目录没读全（' + n + ' 处读不了）：索引只写了并集、体检标签没更新，稍后重扫一次'
}
function extractStatus(root, folder) {
  const job = EXTRACT_JOBS.get(extractKey(root, folder))
  const note = incompleteNote(job)
  const extra = note ? { incomplete: true, note } : {}
  if (job && job.state === 'running') return { state: 'running', startedAt: job.startedAt, elapsedMs: Date.now() - job.startedAt, phase: job.phase || 'text', done: job.done || 0, total: job.total || 0, rel: job.rel || '', cancelled: Boolean(job.cancelled), ...extra }
  if (job && job.state === 'done') return { state: 'done', made: job.made.length, failed: job.failed.length, ocr: job.ocr.length, engine: job.engine || '', provider: job.provider || '', engineError: job.engineError || null, elapsedMs: job.endedAt - job.startedAt, done: job.done || 0, total: job.total || 0, cancelled: Boolean(job.cancelled), ...(job.cancelled ? { error: '已取消（跑完当前文件即停）' } : {}), ...extra }
  if (job && job.state === 'error') return { state: 'error', error: job.error, engine: job.engine || '', provider: job.provider || '', engineError: job.engineError || null, made: (job.made || []).length, failed: (job.failed || []).length, elapsedMs: job.endedAt - job.startedAt, ...extra }
  const store = readTextStore(root, folder)
  // 2026-11-20 P0-11：没有 job 但缓存已有文本 = 「之前抽过」，不是这次的战果。补齐 made/failed 为 null，
  // 前端据此走另一套文案（cached 分支），别把历史缓存显示成「刚抽完 N 份」。
  return store.files.length ? { state: 'done', cached: true, made: null, failed: null, cancelled: false } : { state: 'idle' }
}

/** 起一次后台抽取（不 await），立刻返回任务快照。 */
function startExtract(root, folder) {
  const key = extractKey(root, folder)
  const cur = EXTRACT_JOBS.get(key)
  if (cur && cur.state === 'running') return extractStatus(root, folder)
  const job = { state: 'running', startedAt: Date.now(), endedAt: 0, made: [], failed: [], ocr: [], error: '', phase: 'text', done: 0, total: 0, rel: '', cancelled: false }
  EXTRACT_JOBS.set(key, job)
  extractPack(root, folder, {
    cancelRef: job,
    onProgress: (p) => { job.phase = p.phase || 'text'; job.done = p.done || 0; job.total = p.total || 0; job.rel = p.rel || '' },
  }).then((out) => {
    job.endedAt = Date.now()
    job.made = out.made || []
    job.failed = out.failed || []
    job.ocr = out.ocr || []
    job.engine = out.engine || ''
    job.provider = out.provider || ''
    // P0-2：目录没读全（EACCES/EBUSY…）时索引只写并集、体检标签不动；状态里如实带出去
    job.incomplete = Boolean(out.incomplete)
    job.walkErrors = Array.isArray(out.walkErrors) ? out.walkErrors : []
    // CUDA 起不来时任务就停在这儿：不回落 CPU，也不装成「跑完了」
    if (out.engineError) {
      job.state = 'error'
      job.engineError = out.engineError
      job.error = ocrErrorText(out.engineError)
    } else {
      job.state = 'done'
      if (job.cancelled) job.error = '已取消（跑完当前文件即停）'
    }
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
    cancelled: Boolean(job.cancelled),
    startedAt: job.startedAt, elapsedMs: (job.endedAt || Date.now()) - job.startedAt,
  }
  if (job.engine) out.engine = job.engine
  if (job.provider) out.provider = job.provider
  if (job.engineError) out.engineError = job.engineError
  if (job.state === 'done') {
    out.result = job.result
    // 2026-11-20 P0-11：取消后跑完当前文件也会进 done，但这不是「成功」—— 带上 cancelled 与原因，
    // 页面按取消那套文案走，别显示成绿色的「已完成」。
    if (job.cancelled) {
      out.cancelled = true
      out.error = '已取消（跑完当前文件即停）'
      out.done = job.done || 0
      out.total = job.total || 0
    }
  }
  if (job.state === 'error') { out.error = job.error; out.result = job.result || null }
  // 2026-11-20 P0-10：这里的 0 是真的 0，不是漏记 —— 导入链路（walkFiles → extractPack 的
  // pypdf/OCR 抽字 → screenPack 正则判据 → 拷文件写 case.yml）全程没有模型调用；
  // 会烧模型的是 AI 复核/补全（packReview / packFill，走 packModelOnce → recordModelUsage）。
  out.modelUsage = Number(job.modelUsage) || 0
  return out
}

/** 起一次后台导入（不 await），立刻返回任务快照。 */
function startImport(cfg, root, folder, opts = {}) {
  const key = extractKey(root, folder)
  const cur = IMPORT_JOBS.get(key)
  if (cur && cur.state === 'running') return importStatus(root, folder)
  const job = { state: 'running', phase: 'scan', startedAt: Date.now(), endedAt: 0, done: 0, total: 0, rel: '', result: null, error: '', modelUsage: 0, cancelled: false }
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

/** 识图补齐任务表（功能A，用户 m01150）：key = caseDir（本子文件夹绝对路径）。
 *  只由用户在档案页点「识图补齐」触发——boot 与后台都不主动跑（用户 m01367 定）。
 *  空文本严禁落盘：一份假 txt 等于告诉体检「这有字」，污染 _source vs _text 反查。 */
const CASE_OCR_JOBS = new Map()

function caseOcrTextHave(dir) {
  // 与 caseGaps 的 noText 同口径：_text（或 _source/_text）现有 txt 的基名（去 .txt）
  const have = new Set()
  for (const td of [join(dir, '_text'), join(dir, '_source', '_text')]) {
    try {
      if (!existsSync(td)) continue
      for (const n of readdirSync(td)) if (/\.txt$/i.test(n)) have.add(n.replace(/\.txt$/i, ''))
    } catch { /* 列不出来当没有，宁可重跑 */ }
  }
  return have
}

function caseOcrPendingRels(dir, force) {
  const srcDir = join(dir, '_source')
  if (!existsSync(srcDir)) return []
  const have = caseOcrTextHave(dir)
  return walkFiles(srcDir).map((f) => f.rel).filter((r) => {
    const key = String(r).replace(/\.[^.]+$/, '').replace(/\\/g, '/').replace(/\//g, '__')
    // docx 剔除：ocr.py 见 docx 直接 exit 6；识图对象只有 pdf/jpg/png
    return /\.(pdf|jpe?g|png)$/i.test(r) && (force === true || !have.has(key))
  })
}

function caseSourceMeta(dir) {
  try {
    const parsed = parseCase(readFileSync(join(dir, 'case.yml'), 'utf8'))
    const m = parsed && parsed.meta
    if (m && m.source_root && m.source_folder) {
      // 2026-11-20 P0-3：解析出来的 root 归一成绝对路径（幂等，已是正常路径的不变）。
      // 老 case.yml 里 source_root 是双反斜杠文本，读侧解转义后还要 resolve 一次：
      // 不归一就算出与真 store 不同的幽灵 key，抽取守卫与识图回写全落到空目录。
      return { root: resolve(String(m.source_root)), folder: String(m.source_folder) }
    }
  } catch { /* 没 meta 就只写 _text，不同步来源缓存 */ }
  return null
}

function caseOcrStatus(root, folder) {
  const job = CASE_OCR_JOBS.get(join(root, folder))
  if (!job) return { ok: true, state: 'idle', phase: '', done: 0, total: 0, rel: '', made: [], failed: [], ocr: ocrSnapshot() }
  const out = {
    ok: true, state: job.state, phase: job.phase, engine: job.engine,
    done: job.done || 0, total: job.total || 0, rel: job.rel || '',
    made: job.made.slice(), failed: job.failed.slice(),
    cancelled: Boolean(job.cancelled),
    skipped: Number(job.skipped) || 0,
    startedAt: job.startedAt, elapsedMs: (job.endedAt || Date.now()) - job.startedAt,
  }
  if (job.error) out.error = job.error
  if (job.engineError) out.engineError = job.engineError
  out.provider = job.provider || OCR_ENGINE_STATE.provider
  out.ocr = ocrSnapshot()
  return out
}

/** 起一次后台识图（不 await），立刻返回 {ok,state,total,engine}。body: {rels?,engine?,force?}。 */
function startCaseOcr(root, folder, body = {}) {
  // 2026-11-20 审计 C（纵深防御）：路由侧已验过「库内条目」，这里再拒一次路径形态的 folder ——
  // 本函数会往 join(root,folder) 下的 _text/ 落盘。
  const name = String(folder ?? '').trim()
  if (!name || name.indexOf('..') >= 0 || /[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) {
    return { ok: false, code: 400, error: 'folder-not-allowed' }
  }
  const dir = join(root, name)
  if (!existsSync(dir)) return { ok: false, code: 404, error: '找不到这一本：' + name }
  const cur = CASE_OCR_JOBS.get(dir)
  if (cur && cur.state === 'running') return { ok: false, code: 409, error: '这一本已有识图任务在跑' }
  // 引擎优先级：body.engine（显式点名）→ settings.json 的 ocrEngine → 默认 rapid-cuda。
  // vl 只有显式点名才用，不进默认链；off = 用户关了 OCR，直接拒。
  const want = String(body.engine || '').trim().toLowerCase()
  const engine = want === 'vl' || want === 'rapid' || want === 'rapid-cuda' || want === 'paddle' ? want : resolveOcrEngine()
  if (engine === 'off') return { ok: false, code: 400, error: 'OCR 已关（settings.ocrEngine=off），先打开再来识图' }
  const src = caseSourceMeta(dir)
  if (src) {
    // 同来源的抽取/导入收尾时会全量重写 index.json；它们在跑就别抢
    if (extractStatus(src.root, src.folder).state === 'running' || importStatus(src.root, src.folder).state === 'running')
      return { ok: false, code: 409, error: '这一本的抽取/导入还在跑（会撞 index.json），等收尾再识图' }
  }
  let rels = (Array.isArray(body.rels) ? body.rels : []).map((r) => String(r)).filter((r) => r !== '')
  const textDir = join(dir, '_text')
  const srcDir = join(dir, '_source')
  // 2026-11-20 审计 C：body.rels 是客户端给的「相对 _source 的路径」。逐个解析后必须仍在 _source 里，
  // 越界的（..\..\..\Users\...\x.pdf）直接丢弃、记 skipped，不整单 400（好项照跑）。
  let skipped = 0
  if (rels.length) {
    const srcAbs = resolve(srcDir)
    rels = rels.filter((r) => {
      const abs = resolve(srcDir, r)
      const inside = abs === srcAbs || abs.startsWith(srcAbs + sep)
      if (!inside) skipped += 1
      return inside
    })
    if (!rels.length) return { ok: false, code: 400, error: 'rels 全部越界，已丢弃', skipped }
  }
  if (!rels.length) rels = caseOcrPendingRels(dir, body.force === true)
  if (!rels.length) return { ok: false, code: 400, error: '没有待识图的文件（都抽出过字，或 _source 不在）', skipped }
  const job = { state: 'running', phase: 'ocr', engine, provider: '', engineError: null, startedAt: Date.now(), endedAt: 0, done: 0, total: rels.length, rel: '', made: [], failed: [], error: '', cancelled: false, skipped }
  CASE_OCR_JOBS.set(dir, job)
  const store = src ? textStore(src.root, src.folder) : null
  ;(async () => {
    try {
      mkdirSync(textDir, { recursive: true })
      if (store) mkdirSync(store.dir, { recursive: true })
    } catch (e) { job.error = String(e && e.message ? e.message : e) }
    // 先攒齐 todo（源文件存在），再进 OCR 段——将来换「一次多文件批调用」（agent-9b 2026-11-19 已把下面这段换成 ocrMany 分批），记账不动
    const todo = []
    for (const rel of rels) {
      if (!existsSync(join(srcDir, rel))) { job.done += 1; job.failed.push(rel); continue } // 缺源文件：直接记失败，不起 python
      todo.push(rel)
    }
    // 批处理：todo 每 6 份塞进一次 python 进程（见 ocrMany）。单份失败只记失败、不杀整批；
    // CUDA 起不来则整轮停在这里（engineError 上报，不回落 CPU）。
    const ocrRes = todo.length
      ? await ocrMany(todo.map((rel) => join(srcDir, rel)), engine, {
        cancelRef: job,
        perFileTimeout: 0,
        onBatchStart: (batch) => { job.rel = batch[0] || '' },
      })
      : { texts: new Map(), engine, engineError: null, provider: '' }
    job.provider = ocrRes.provider || OCR_ENGINE_STATE.provider || ''
    if (ocrRes.engineError) {
      job.engineError = ocrRes.engineError
      job.error = ocrErrorText(ocrRes.engineError)
    }
    for (const rel of todo) {
      if (job.cancelled) break
      job.rel = rel
      const hit = ocrRes.texts.get(ocrKey(join(srcDir, rel)))
      const raw = hit ? hit.text : ''
      const clean = String(raw || '').replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, '').replace(/^\s+/, '')
      job.done += 1
      // 空文本不落盘（失败/超时/白页同路）：宁可这份还挂着「抽不出字」，不造假「有字」
      if (clean.trim() === '') { job.failed.push(rel); continue }
      try {
        // _text/ 下这份是「这一本的识图稿」，名字只要本目录内唯一，沿用旧规则即可（不参与 store 缓存命名）
        const nameOut = legacyOutNameOf(rel)
        writeFileSync(join(textDir, nameOut), clean, 'utf8')
        job.made.push(nameOut)
        if (store) caseOcrPutStoreText(store, src.root, src.folder, rel, clean)
      } catch { job.failed.push(rel) }
    }
    job.endedAt = Date.now()
    if (job.cancelled) { job.state = 'error'; job.error = '已取消（跑完当前文件即停）' }
    else if (job.error) job.state = 'error'
    else job.state = 'done'
  })()
  return { ok: true, state: 'running', engine, total: rels.length, skipped }
}

/** 把 (rel,text) 补写进来源缓存（仿 extractPack 的 put：清洗控制字符、按 rel 替换旧条目、全量重写 index）。 */
function caseOcrPutStoreText(store, srcRoot, srcFolder, rel, clean) {
  // P0-1：写入一律新名（rel 全名 + 短 hash）；旧名只在读取侧回落
  const nameOut = outNameOf(rel)
  let files = []
  try {
    const j = JSON.parse(readFileSync(store.index, 'utf8'))
    if (Array.isArray(j.files)) files = j.files.filter((f) => String(f && f.rel) !== rel)
  } catch { /* 没索引就从零开始 */ }
  // P0-1-3：同名覆盖告警 —— 新规则下同一个 txt 名只属于同一个 rel，撞上说明还有别的东西在写它
  const owner = files.find((f) => String((f && f.txt) || '') === nameOut)
  if (owner && String(owner.rel) !== String(rel)) console.info('[game-desk] txt 覆盖告警', rel, nameOut, '已存在：' + String(owner.rel))
  files.push({ rel, txt: nameOut, chars: clean.length })
  try {
    writeFileSync(join(store.dir, nameOut), clean, 'utf8')
    writeFileSync(store.index, JSON.stringify({ root: srcRoot, folder: srcFolder, at: new Date().toISOString(), files }, null, 2), 'utf8')
  } catch (e) {
    console.info('[game-desk] 识图缓存索引写不进：' + String(e && e.message ? e.message : e))
  }
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
  // 断点续跑（2026-11-19）：已有非空 txt 就是抽过的，直接复用、不重烧 OCR。
  // 口径同 scanProgress：信 .txt 实体，不信 index.json（它跑完才整体落盘）。
  // 2026-11-20 P0-1：缓存名改成「新名 → 旧名」逐级回落（txtNamePlan）—— 老 store 里 400+ 份旧名 txt
  // 依然命中（命中打一条 legacy-hit），跟别人撞了旧名的 rel 只有占位者能复用，其余必须重抽。
  const have0 = storeTxtNames(store.dir)
  // 2026-11-20 P0-6：抽文本也是在「当原稿扫」——_ai_fill/ 里的生成件不参与抽取
  const walk = walkFilesEx(dir, '', 0, [], [], { skipInternal: true })
  const plan = txtNamePlan(walk.files.map((f) => f.rel), have0.names)
  const cachedChars = new Map()
  const charsOf = (name) => {
    if (cachedChars.has(name)) return cachedChars.get(name)
    let chars = 0
    try { chars = readFileSync(join(store.dir, name), 'utf8').trim().length } catch { chars = 0 }
    cachedChars.set(name, chars)
    return chars
  }
  const legacyLogged = new Set()
  const legacyHits = []
  /** 这个 rel 已有什么缓存名（'' = 没有，得抽）：新名优先，旧名回落。 */
  const cachedOf = (rel) => {
    const name = plan.byRel.get(rel) || ''
    if (name === '' || charsOf(name) === 0) return ''
    if (name !== outNameOf(rel)) {
      legacyHits.push(rel)
      if (!legacyLogged.has(rel)) {
        legacyLogged.add(rel)
        console.info('[game-desk] legacy-hit', rel, name)
      }
    }
    return name
  }
  const files = walk.files
  const made = []
  const failed = []
  const index = []
  const ocrLog = []
  // 旧索引（上一轮跑完的那份全量）：收尾时与本轮取并集再写，取消/读不全都不会让索引变小（P0-2）
  const oldIndex = (() => {
    try {
      const j = JSON.parse(readFileSync(store.index, 'utf8'))
      return Array.isArray(j.files) ? j.files.filter((f) => f && f.rel && f.txt) : []
    } catch { return [] }
  })()
  const claimedBy = new Map()
  for (const f of oldIndex) claimedBy.set(String(f.txt), String(f.rel))
  const put = (rel, text) => {
    const clean = text.replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, '').replace(/^\s+/, '')
    if (clean.trim() === '') return 0
    const nameOut = outNameOf(rel)
    // P0-1-3：同名覆盖告警 —— 新规则下同一个 txt 名只属于同一个 rel，撞上说明还有别的东西在写它
    if (claimedBy.has(nameOut) && claimedBy.get(nameOut) !== String(rel)) console.info('[game-desk] txt 覆盖告警', rel, nameOut, '已存在：' + String(claimedBy.get(nameOut)))
    try {
      writeFileSync(join(store.dir, nameOut), clean, 'utf8')
      made.push(nameOut)
      index.push({ rel, txt: nameOut, chars: clean.length })
      claimedBy.set(nameOut, String(rel))
      return clean.length
    } catch { return 0 }
  }
  const readable = files.filter((f) => f.kind === 'pdf' || f.kind === 'text')
  const images = files.filter((f) => f.kind === 'image')
  const cancelled = () => Boolean(opts.cancelRef && opts.cancelRef.cancelled)
  const wantOcr = CONF.ocrEngine !== 'off' && resolveOcrEngine() !== 'off'
  const engine = wantOcr ? resolveOcrEngine() : 'off'
  // 第一遍：文本文件直接读，PDF 先试本机 pypdf；抽不出字的先攒着——攒成一批一次进程，才省得掉冷启动。
  const needOcr = []
  let scanned = 0
  say('text', { done: 0, total: readable.length })
  for (const item of readable) {
    if (cancelled()) break // 取消：当前这份跑完就收，剩下的不再排队
    const hitName = cachedOf(item.rel)
    if (hitName !== '') {
      index.push({ rel: item.rel, txt: hitName, chars: charsOf(hitName) })
      scanned += 1
      say('text', { done: scanned, total: readable.length, rel: item.rel })
      continue
    }
    scanned += 1
    say('text', { done: scanned, total: readable.length, rel: item.rel })
    const abs = join(dir, item.rel)
    if (item.kind === 'text') {
      let text = ''
      try { text = readFileSync(abs, 'utf8') } catch { text = '' }
      if (put(item.rel, text) === 0) failed.push(item.rel)
      continue
    }
    const text = await pdfToText(abs)
    if (text.trim() === '' && wantOcr) { needOcr.push({ rel: item.rel, abs }); continue }
    if (put(item.rel, text) === 0) failed.push(item.rel)
  }
  // 图片的已有缓存（含旧名命中）也补进索引：索引要对得上磁盘上每一份 txt，否则进度与材料缺这几份（P0-1）
  for (const it of images) {
    const hit = cachedOf(it.rel)
    if (hit !== '') index.push({ rel: it.rel, txt: hit, chars: charsOf(hit) })
  }
  // 第二遍：待 OCR 的按 OCR_BATCH_SIZE 一批地过（ocrMany）。单份失败只记这一份；
  // CUDA 起不来则整轮停在这儿（engineError 回给任务状态，不拿 CPU 一份份磨）。
  let ocrEngineError = null
  const ocrPut = (rel, hit, eng) => {
    const text = hit ? String(hit.text || '') : ''
    if (text.trim() === '') { failed.push(rel); return false }
    if (put(rel, text) > 0) {
      ocrLog.push({ rel, engine: eng, chars: text.length, provider: (hit && hit.provider) || '' })
      return true
    }
    failed.push(rel)
    return false
  }
  if (needOcr.length) {
    const res = await ocrMany(needOcr.map((x) => x.abs), engine, {
      cancelRef: opts.cancelRef,
      onBatchStart: (batch) => say('text', { done: scanned, total: readable.length, rel: batch[0] || '' }),
    })
    ocrEngineError = res.engineError || null
    for (const x of needOcr) ocrPut(x.rel, res.texts.get(ocrKey(x.abs)), res.engine)
    // vl 兜底：只在「引擎没停」且有失败时补一轮。vl 也是 GPU 模型，引擎停用后再换一个 engine 只会掩盖错误。
    if (!ocrEngineError && !cancelled() && CONF.ocrVlFallback && failed.length) {
      const retry = needOcr.filter((x) => failed.indexOf(x.rel) >= 0)
      if (retry.length) {
        const vres = await ocrMany(retry.map((x) => x.abs), 'vl', { cancelRef: opts.cancelRef })
        for (const x of retry) {
          const hit = vres.texts.get(ocrKey(x.abs))
          if (!hit || String(hit.text || '').trim() === '') continue
          const at = failed.indexOf(x.rel)
          if (at >= 0) failed.splice(at, 1)
          if (put(x.rel, hit.text) > 0) ocrLog.push({ rel: x.rel, engine: 'vl', chars: String(hit.text).length, provider: '' })
          else failed.push(x.rel)
        }
        // 兜底轮的引擎错误不往上抛（2026-11-19：paddle 认成 0 字的空白扫描件 + vl 起不来 →
        // 整本被判 engine-unavailable 中断）。失败文件已在 failed 里，这里只留日志。
        if (vres.engineError) console.info('[game-desk] vl 兜底没起来：' + String(vres.engineError.reason || vres.engineError.code || ''))
      }
    }
  }
  // 图片（线索卡之类）：只有整本几乎没字时才去 OCR，免得为几张小图等半天；同样攒成一批。
  if (!cancelled() && CONF.ocrImages && wantOcr && !ocrEngineError) {
    const charsSoFar = index.reduce((n, f) => n + f.chars, 0)
    const sparseOnly = CONF.ocrImagesMode !== 'all'
    if ((!sparseOnly || charsSoFar < 800) && images.length) {
      const cap = Number(CONF.ocrImageMax) > 0 ? Number(CONF.ocrImageMax) : 80
      const imgList = images.filter((it) => cachedOf(it.rel) === '').slice(0, cap)
      say('image', { done: 0, total: imgList.length })
      const imgRes = await ocrMany(imgList.map((item) => join(dir, item.rel)), engine, {
        cancelRef: opts.cancelRef,
        onBatchStart: (batch) => say('image', { done: 0, total: imgList.length, rel: batch[0] || '' }),
      })
      ocrEngineError = imgRes.engineError || null
      for (const item of imgList) {
        const hit = imgRes.texts.get(ocrKey(join(dir, item.rel)))
        if (!hit || String(hit.text || '').trim() === '') { failed.push(item.rel); continue }
        if (put(item.rel, String(hit.text)) > 0) ocrLog.push({ rel: item.rel, engine: imgRes.engine, chars: String(hit.text).length, provider: hit.provider || '' })
        else failed.push(item.rel)
      }
      say('image', { done: imgList.length, total: imgList.length })
    }
  }
  // P0-2：索引与上一轮取并集再写 —— 取消或被中断时本轮只处理了一部分，
  // 直接覆盖会把上一轮跑全的条目挤掉（实证：消失的子弹磁盘 6 份 txt 只留 3 条索引）。
  // 并集保证「索引只增不减」：旧条目保留，本轮重抽的同 rel 条目覆盖旧值。
  // 并集按 txt 名去重：缓存文件才是实体，一份 txt 只能属于一个 rel。
  // 旧索引里有些条目 rel 少了扩展名（更早的版本 strip 过），按 txt 归并时会被本轮的正式 rel 顶掉，
  // 既不重复计入字数码，也不会留下指向同一份文件的僵尸条目。
  const merged = new Map()
  for (const f of oldIndex) merged.set(String(f.txt), { rel: String(f.rel), txt: String(f.txt), chars: Number(f.chars) || 0 })
  for (const f of index) merged.set(String(f.txt), f)
  // 2026-11-20 P0-9：索引过去只增不减 —— 原稿删了/改名了、或者以前被当成原稿收进来的
  // _ai_fill/ 生成件，条目会永远留在 index.json 里（字数、进度、AI 材料一起虚高）。
  // 本轮真读全（walk.incomplete === false）才裁：按「rel 映射出的 txt 名」判活（新名与旧名都算），
  // 这样「已缓存、这一轮没重抽」的条目不会被误删；读不全时保留并集语义，绝不因为读不到就删。
  if (!walk.incomplete) {
    const aliveTxt = new Set()
    for (const f of files) {
      aliveTxt.add(outNameOf(f.rel))
      aliveTxt.add(legacyOutNameOf(f.rel))
    }
    const prunedRels = []
    for (const [txt, v] of merged) {
      if (aliveTxt.has(String(txt))) continue
      merged.delete(txt)
      prunedRels.push(String(v.rel))
    }
    if (prunedRels.length > 0) {
      console.info('[game-desk] index pruned ' + prunedRels.length + ' stale entries: ' + folder + ' ← ' + prunedRels.slice(0, 8).join(', '))
    }
  }
  const indexBody = { root, folder, at: new Date().toISOString(), files: Array.from(merged.values()) }
  if (walk.incomplete) {
    // 目录都没读全：这份索引一定不是全量，标出来让进度与后续抽取都看得见
    indexBody.incomplete = true
    indexBody.walkErrors = walk.errors.slice(0, 20)
    console.info('[game-desk] 目录没读全，索引只写并集：' + folder + '（' + walk.errors.length + ' 处）')
  }
  try {
    writeFileSync(store.index, JSON.stringify(indexBody, null, 2), 'utf8')
  } catch (e) {
    console.info('[game-desk] 文本索引写不进去：' + String(e && e.message ? e.message : e))
  }
  // extract 完成 → 顺手落体检标签（用户 m01363；上面这行是原先 agent-7 留的钩子位）。
  // 口径（用户 m01367）：只在用户自己发起的抽取收尾时算一次，boot 不主动补算、不重跑 OCR。
  // 取消/中断的不落：那本还没扫全，标签会长期停在「缺项多」的假状态；重跑 extract 会覆盖。
  // 已扫完但当时还没有本钩子的旧本，用 POST /api/packs/meta 一次性补（只读文本缓存）。
  // P0-2：取消、目录没读全都不写体检标签 —— 那种 meta 是拿残缺材料算出来的，会把假结论长期写进状态。
  if (!cancelled() && !walk.incomplete) {
    try {
      const meta = buildPackMeta(root, folder, packEntry(folder, dir, files), { dir: store.dir, files: Array.from(merged.values()) })
      // 重抽也走整份写：把旧的补全账/复核记录带过来（2026-11-19，别让一次重抽抹掉 aiFill）
      writePackMeta(root, folder, preserveMetaState(root, folder, meta))
    } catch (e) {
      console.info('[game-desk] 体检标签没算成：' + String(e && e.message ? e.message : e))
    }
  }
  return { dir: store.dir, made, failed, ocr: ocrLog, engine: wantOcr ? engine : 'off', provider: OCR_ENGINE_STATE.provider, engineError: ocrEngineError, incomplete: walk.incomplete, walkErrors: walk.errors.slice(0, 20), legacyHits }
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
  // system 只放整局不变的东西（角色 / 整包资料 / 带本规矩）：前缀缓存按字节命中，
  // 幕号与带本流程一旦写在这里，换一幕整段前缀就失效（2026-11-20 23:45）。
  const system = [
    '你是剧本杀《' + pack.title + '》的主持人（DM），同时扮演除「' + meName + '」以外的所有角色' + (aiNames.length ? '（' + aiNames.join('、') + '）' : '') + '。',
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
  // 幕与带本流程放在这一轮的用户消息里（玩家原话之前），system 逐字节不动。
  const userText = dmActBlock(root, folder, act) + '\n\n' +
    (lines.length ? '【已经发生的对局】\n' + lines.join('\n') + '\n\n' : '') +
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
    let usage = null
    for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
      if (chunk && chunk.type === 'text-delta') text += String(chunk.text || '')
      else if (chunk && chunk.type === 'usage') usage = chunk.usage
      else if (chunk && chunk.type === 'finish') finish = chunk.reason
    }
    if (finish && finish.kind === 'error') {
      return { ok: false, code: 502, error: '模型报错：' + (finish.failure && finish.failure.message ? finish.failure.message : '未知') }
    }
    text = text.trim()
    if (text === '') return { ok: false, code: 502, error: '模型回了一段空文本，再发一次试试' }
    recordModelUsage('dm', sel, usage)
    return { ok: true, text, model: sel.provider + '/' + sel.model, ms: Date.now() - t0, usage }
  } catch (e) {
    return { ok: false, code: 500, error: String(e && e.message ? e.message : e) }
  }
}

/* ---------- 角色剧本按幕开放（2026-11-20，用户 m00504） ----------
   对局室的「人物剧本」页签以前一次把整份角色本摊开（文字或 PDF iframe）；导入本的角色本
   其实自带「第 N 幕」结构，所以改成按幕切：当前第 N 幕只给这一幕的页，后续幕推进到才开。
   - PDF：页文本来自抽字缓存（pypdf 按页用 "\n\f\n" 拼），幕界由 services/scriptacts.mjs 算，
     每一页交给 lib/script-pages.py（paddle-venv 里的 PyMuPDF）渲成 JPEG，落盘缓存；
   - md/txt：按同一套幕界切一段文字（原生本子本来就没有「页」）。
   切不开幕的 PDF（扫描件还没抽字 / 没有幕标题）不退回 PDF 阅读器：
   照样把整份按页渲成图给出去（whole:true），只是不声称按幕切了。 */
const SCRIPT_DPI = 130
// PNG 把扫描页存成 3.0MB/页（130dpi A4 实测），五页一本就是 15MB —— 隧道那头读一页要等很久。
// JPEG q88 同一页 300KB 上下，小字仍然清楚，所以缓存格式定成 jpg（2026-11-20）。
const SCRIPT_FMT = 'jpg'
function insideCaseDir(dir, rel) {
  const base = resolve(String(dir || ''))
  const abs = resolve(base, String(rel || ''))
  if (!(abs === base || abs.startsWith(base + sep))) return ''
  return abs
}
function scriptStem(rel) {
  return basename(String(rel || '')).replace(/\.[^.]+$/, '')
}
function pageCacheDir(root, folder, rel) {
  const key = createHash('sha1').update(String(root) + '|' + String(folder) + '|' + String(rel)).digest('hex').slice(0, 16)
  return join(dshHome(), 'game-desk', 'pages', key)
}
function pageUrlOf(root, folder, rel, page) {
  return ROUTE + '/api/page?root=' + encodeURIComponent(String(root)) +
    '&folder=' + encodeURIComponent(String(folder)) +
    '&rel=' + encodeURIComponent(String(rel)) + '&page=' + page
}
/** PDF 总页数（缓存，按 mtime 失效）：切不开幕时要靠它把整份按页给出去。 */
const PDF_TOTAL = new Map()
async function pdfPageCount(abs) {
  let mtime = 0
  try { mtime = statSync(abs).mtimeMs } catch { return 0 }
  const hit = PDF_TOTAL.get(abs)
  if (hit && hit.mtime === mtime && hit.total > 0) return hit.total
  try {
    const { stdout } = await execFileAsync(pagePython(), [join(HERE, 'script-pages.py'), abs, '--info'], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true })
    const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''
    const j = JSON.parse(line)
    const total = j && j.ok ? Number(j.total) || 0 : 0
    if (total > 0) PDF_TOTAL.set(abs, { mtime, total })
    return total
  } catch { return 0 }
}
/** 渲染 PDF 页用的 python：paddle-venv 里有 PyMuPDF 2.1（2026-11-20 实测）；没有就退回 PATH 上的 python。 */
function pagePython() {
  const cands = [OCR_PY.paddle, join(homedir(), '.dsh', 'tools', 'gsv-venv', 'Scripts', 'python.exe')]
  for (const c of cands) { try { if (existsSync(c)) return c } catch { /* 试下一个 */ } }
  return 'python'
}
async function renderPdfPages(abs, outdir, pages) {
  const py = pagePython()
  const args = [join(HERE, 'script-pages.py'), abs, outdir, String(SCRIPT_DPI), pages.join(',')]
  const { stdout } = await execFileAsync(py, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  const line = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''
  let j = null
  try { j = JSON.parse(line) } catch { j = null }
  if (!j || !j.ok) return { ok: false, error: (j && j.error) || 'render-failed' }
  return j
}
/** 一个本子里能当文字读的东西：导入本放在 <本子>/_text/*.txt，原生本子放在抽字缓存里。
 *  两条都要看 —— 只看缓存的话，导入本（09/10）一个字都读不到，按幕切会直接判成「没抽字」。 */
function caseTextList(root, folder) {
  const dir = join(root, folder)
  const list = []
  const seen = new Set()
  const push = (rel, abs) => {
    if (!abs || seen.has(abs)) return
    seen.add(abs)
    list.push({ rel, abs })
  }
  try {
    const td = join(dir, '_text')
    if (existsSync(td)) {
      for (const n of readdirSync(td)) if (/\.txt$/i.test(n)) push('_text/' + n, join(td, n))
    }
  } catch { /* 没有 _text 就只靠抽字缓存 */ }
  try {
    const store = readTextStore(root, folder)
    for (const f of store.files || []) push(String(f.rel || f.txt), join(store.dir, f.txt))
  } catch { /* 没有缓存也不致命 */ }
  return list
}
/** 角色本的整份文本：md/txt 直接读，其余（PDF/docx）按文件名的词干找回抽出来的那篇。 */
function scriptTextOf(root, folder, rel, abs, ext) {
  if (/\.(md|markdown|txt)$/i.test(ext)) {
    try { return readFileSync(abs, 'utf8') } catch { return '' }
  }
  const stem = scriptStem(rel)
  for (const t of caseTextList(root, folder)) {
    if (scriptStem(t.rel) !== stem) continue
    try { return readFileSync(t.abs, 'utf8') } catch { /* 换下一份 */ }
  }
  return ''
}
/** GET /api/script 的全部判断都收在这里：给定本子里的一个文件与「当前第几幕」。 */
async function scriptInfo(root, folder, rel, actWanted) {
  const dir = join(root, folder)
  const abs = insideCaseDir(dir, rel)
  if (!abs || !existsSync(abs)) return { ok: false, code: 404, error: 'not-found' }
  const ext = extname(abs).toLowerCase()
  const pdf = ext === '.pdf'
  const raw = scriptTextOf(root, folder, rel, abs, ext)
  const pages = splitPages(raw)
  const acts = buildActs(parseActMarks(pages), pdf ? pages.length : 1)
  const split = acts.length > 1 && String(raw).trim() !== ''
  const wanted = Math.max(1, Number(actWanted) || 1)
  const hit = actAt(acts, wanted)
  const name = scriptStem(rel)
  const base = {
    ok: true, rel, name, source: pdf ? 'pdf' : 'text', split,
    act: hit.index, actCount: acts.length,
    acts: acts.map((a) => ({ n: a.n, label: a.label, from: a.from, to: a.to })),
    note: wanted > acts.length ? '这本只有 ' + acts.length + ' 幕，已经是最后一幕' : '',
    textMissing: String(raw).trim() === '',
  }
  if (!split) {
    // 切不开幕。PDF 也不退回阅读器：先问总页数，整份按页给图（用户要的是图，不是 PDF 嵌页）。
    if (pdf) {
      const total = await pdfPageCount(abs)
      if (total > 0) {
        const list = []
        for (let pg = 1; pg <= total; pg += 1) list.push({ page: pg, url: pageUrlOf(root, folder, rel, pg) })
        base.note = base.note || (base.textMissing
          ? '这份剧本还没抽出文字，按幕切不开 —— 先把整份按页给你（' + total + ' 页）'
          : '这份剧本里没找到「第 N 幕」标题，整份按页给你（' + total + ' 页）')
        return { ...base, whole: true, pages: list }
      }
    }
    // md/txt 没有幕标题：整份文字交给前端 loadDoc。
    base.note = base.note || (base.textMissing
      ? '这份剧本还没抽出文字，也渲不出页 —— 先看整份原件，抽完字再回来'
      : '这份剧本里没找到「第 N 幕」标题，整份给你')
    return base
  }
  if (pdf) {
    const list = []
    for (let pg = hit.act.from; pg <= hit.act.to; pg += 1) list.push({ page: pg, url: pageUrlOf(root, folder, rel, pg) })
    return { ...base, pages: list }
  }
  return { ...base, pages: [], text: sliceActText(raw, acts, hit.index) }
}

/* ---------- 带本流程大纲（2026-11-20，用户 m00610） ----------
   用户口径：本子导入库后，让 AI 生成这场游戏的游玩顺序 —— 在哪停下来等玩家讨论、
   何时把真相手册的内容给出去，先有一份大纲，带本时才不会前后断线。
   落地：~/.dsh/game-desk/flows/<sha1(root|folder) 前 16 位>.json，
   与 pack-meta 同一套缓存习惯（指纹 = 喂给模型的资料哈希；资料没变就回缓存）。
   流程只给机主（GATE_RULES 里 flow: 'owner'）；页内 DM 每回合自动带上当前幕那一段。 */
const FLOW_LLM_TIMEOUT = 180000
function flowKey(root, folder) {
  return createHash('sha1').update(String(root) + '|' + String(folder)).digest('hex').slice(0, 16)
}
function flowPath(root, folder) {
  return join(dshHome(), 'game-desk', 'flows', flowKey(root, folder) + '.json')
}
function readFlowCache(root, folder) {
  try {
    const rec = JSON.parse(readFileSync(flowPath(root, folder), 'utf8'))
    if (!rec || !rec.flow || !Array.isArray(rec.flow.acts) || !rec.flow.acts.length) return null
    return rec
  } catch { return null }
}
function writeFlowCache(root, folder, rec) {
  try {
    mkdirSync(dirname(flowPath(root, folder)), { recursive: true })
    writeFileSync(flowPath(root, folder), JSON.stringify(rec, null, 2), 'utf8')
  } catch { /* 落盘失败不挡这次返回 */ }
}
/** 喂给模型的资料：case.yml + 手册/真相 + 规则 + 线索摘要 + 各角色本的幕骨架。
 *  故意只给角色本的幕标题、不给正文 —— 流程需要结构，不需要把每份秘密再念一遍。 */
function flowMaterial(root, folder) {
  const dir = join(root, folder)
  const parts = []
  let title = String(folder)
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
  }
  // 导入本的 _text 与原生本子的抽字缓存都要看（见 caseTextList）；_ai_fill 是上一轮模型补的稿子，不算资料。
  const texts = caseTextList(root, folder).filter((t) => !isAiFillRel(t.rel))
  const readT = (h, cap) => { try { return readCap(h.abs, cap) } catch { return '' } }
  // 1) 手册 / 真相 / 主持本：流程里的「什么时候发真相」全靠它
  let handbook = 0
  for (const h of texts) {
    if (handbook >= 1) break
    if (!/手册|真相|主持|组织者|复盘|结局|handbook|dm/i.test(String(h.rel) + ' ' + String(h.txt))) continue
    const s = readT(h, 12000)
    if (s) { parts.push('【' + basename(h.rel) + '】\n' + s); handbook += 1 }
  }
  // 2) 规则 / 准备 / 玩法说明
  let rules = 0
  for (const h of texts) {
    if (rules >= 1) break
    if (!/规则|准备|说明|玩法|介绍|intro|readme/i.test(String(h.rel) + ' ' + String(h.txt))) continue
    const s = readT(h, 6000)
    if (s) { parts.push('【' + basename(h.rel) + '】\n' + s); rules += 1 }
  }
  // 3) 线索：只给文件名 + 开头一小段（够判断这是哪一轮的哪类线索）
  let clues = 0
  const clueNames = []
  for (const h of texts) {
    if (!/线索|clue/i.test(String(h.rel))) continue
    clueNames.push(basename(String(h.rel)))
    if (clues >= 8) continue
    const s = readT(h, 1200)
    if (s) { parts.push('【线索 ' + basename(h.rel) + '】\n' + s); clues += 1 }
  }
  if (clueNames.length) parts.push('【线索文件清单】\n' + clueNames.slice(0, 40).join('\n'))
  // 4) 角色本的幕骨架
  const roleSkeleton = []
  for (const h of texts) {
    if (/线索|clue|手册|真相|主持|组织者|复盘|答题/i.test(String(h.rel))) continue
    const s = readT(h, 60000)
    if (!s) continue
    const ps = splitPages(s)
    const acts = buildActs(parseActMarks(ps), ps.length)
    if (acts.length > 1) roleSkeleton.push(scriptStem(String(h.rel)) + '：' + acts.map((a) => a.label).join(' / '))
  }
  if (roleSkeleton.length) parts.push('【角色本的幕结构】\n' + roleSkeleton.join('\n'))
  const text = parts.join('\n\n')
  return { title, text, stamp: createHash('sha1').update(text).digest('hex').slice(0, 16) }
}

function flowPrompt(material) {
  const system = [
    '你是剧本杀的带本教练。用户已经把一本剧本导入本子库，现在要给这一场排一份「游玩顺序」大纲，',
    '让主持人（可能是第一次带这本）知道每一幕先做什么、在哪里停下来等玩家讨论、什么时候把真相手册的内容给出去。',
    '硬要求：',
    '1. 只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要注释。',
    '2. 幕数以资料里角色本的幕结构为准（资料最后有「角色本的幕结构」）；没有幕结构就按线索轮次/游戏准备卡分幕。',
    '3. 每一步都要能直接照着做：先做什么、发什么、什么时候停。不要写「根据情况推进」这种空话。',
    '4. 停下来讨论是流程的一部分，不是可选项：每一幕都写清「在哪停、停多久、让玩家讨论什么」。',
    '5. 真相手册不要一次性全发：按资料里的真相解析结构，写清每一幕后发哪一段、最终复盘点在哪里。',
    'JSON 形状：',
    '{"title":"本子名","actCount":3,"acts":[{"label":"第一幕","goal":"这一幕玩家要搞清什么",' +
      '"steps":["开场怎么带","第一轮搜证怎么发","..."],"pause":"在哪停下来让玩家讨论、讨论什么",' +
      '"hand":"这一幕发哪些线索/答题卡/道具","truth":"这一幕结束后要不要发真相、发哪段（不发就写空串）"}],' +
      '"final":{"truth":"最后什么时候、怎么把真相手册给玩家","debrief":"复盘怎么收尾"},"notes":["提醒主持人的坑"]}',
  ].join('\n')
  const userText = '【本子资料】\n' + material.text + '\n\n请按上面的 JSON 形状输出这场游戏的游玩顺序大纲。'
  return { system, userText }
}

/** 模型回的文本 → 流程对象；剥围栏、花括号配对，解析失败返回 null（不要半截大纲）。 */
function parseFlow(text) {
  let s = String(text == null ? '' : text).trim()
  s = s.replace(/^\u0060\u0060\u0060(?:json)?\s*/i, '').replace(/\u0060\u0060\u0060\s*$/, '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let end = -1
  for (let i = start; i < s.length; i += 1) {
    const c = s[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return null
  let j = null
  try { j = JSON.parse(s.slice(start, end + 1)) } catch { return null }
  if (!j || !Array.isArray(j.acts) || !j.acts.length) return null
  const str = (v, n) => String(v == null ? '' : v).slice(0, n).trim()
  const acts = j.acts.slice(0, 12).map((a, idx) => ({
    n: idx + 1,
    label: str(a.label || '第' + (idx + 1) + '幕', 20),
    goal: str(a.goal, 240),
    steps: (Array.isArray(a.steps) ? a.steps : []).map((x) => str(x, 240)).filter(Boolean).slice(0, 10),
    pause: str(a.pause, 500),
    hand: str(a.hand, 400),
    truth: str(a.truth, 500),
  }))
  return {
    title: str(j.title, 80),
    actCount: acts.length,
    acts,
    final: j.final && typeof j.final === 'object'
      ? { truth: str(j.final.truth, 700), debrief: str(j.final.debrief, 700) }
      : null,
    notes: (Array.isArray(j.notes) ? j.notes : []).map((x) => str(x, 240)).filter(Boolean).slice(0, 8),
  }
}

/** 生成（或回缓存）一份流程大纲。和 dmAsk 同一条 llm 路，只是 system 换成了「带本教练」。 */
async function flowAsk(ctx, root, folder, opts) {
  const llm = ctx.get ? ctx.get('llm', false) : false
  if (!llm || typeof llm.prepareCall !== 'function') return { ok: false, code: 503, error: '宿主没有可用的 llm 服务' }
  const adm = ctx.get ? ctx.get('agentDefaultModel', false) : false
  const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
  if (!sel || !sel.provider || !sel.model) return { ok: false, code: 503, error: '没有探测到默认模型（agentDefaultModel）' }
  const material = flowMaterial(root, folder)
  if (String(material.text).trim() === '') {
    return { ok: false, code: 422, error: '这本还没有能读的文字：先在「导入/详情」里抽字，再生成流程' }
  }
  const force = !!(opts && opts.force)
  const cache = readFlowCache(root, folder)
  if (cache && !force && cache.stamp === material.stamp) {
    return { ok: true, cached: true, flow: cache.flow, at: cache.at, model: cache.model, title: cache.title, stale: false }
  }
  const { system, userText } = flowPrompt(material)
  const t0 = Date.now()
  const signal = AbortSignal.timeout(FLOW_LLM_TIMEOUT)
  try {
    const call = await llm.prepareCall({ provider: sel.provider, model: sel.model, maxTokens: 1800 }, signal)
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'game-desk-flow' },
      id: randomUUID(),
    }]
    let text = ''
    let finish = null
    let usage = null
    for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
      if (chunk && chunk.type === 'text-delta') text += String(chunk.text || '')
      else if (chunk && chunk.type === 'usage') usage = chunk.usage
      else if (chunk && chunk.type === 'finish') finish = chunk.reason
    }
    if (finish && finish.kind === 'error') {
      return { ok: false, code: 502, error: '模型报错：' + (finish.failure && finish.failure.message ? finish.failure.message : '未知') }
    }
    const flow = parseFlow(text)
    if (!flow) return { ok: false, code: 502, error: '模型这次没给出能解析的 JSON 大纲，再生成一次试试', raw: String(text).slice(0, 900) }
    const rec = { at: Date.now(), model: sel.provider + '/' + sel.model, stamp: material.stamp, title: material.title, flow }
    writeFlowCache(root, folder, rec)
    recordModelUsage('flow', sel, usage)
    return { ok: true, cached: false, flow, at: rec.at, model: rec.model, title: rec.title, ms: Date.now() - t0, usage }
  } catch (e) {
    return { ok: false, code: 500, error: String(e && e.message ? e.message : e) }
  }
}

  /** 页内 DM 每轮的动态段：当前幕 + 这一幕的带本流程。它必须进「用户消息」而不是 system ——
   *  system 整局逐字节不变，前缀缓存才按字节命中；没生成过大纲时也给幕号，模型照样知道打到第几幕。
   *  （以前叫 dmFlowBlock，直接拼在 system 末尾；2026-11-20 挪出来，函数改名为 dmActBlock。） */
  function dmActBlock(root, folder, act) {
    const rec = readFlowCache(root, folder)
    const acts = rec && rec.flow && Array.isArray(rec.flow.acts) ? rec.flow.acts : []
    const want = Math.max(1, Number(act) || 1)
    // 幕号越过大纲末尾时按最后一幕给：大纲 3 幕而页面停在 9，不能报「第 9 幕」却配第 3 幕的流程。
    const i = acts.length ? Math.min(acts.length, want) - 1 : -1
    const n = i >= 0 ? i + 1 : want
    const lines = ['【本轮带本流程 · 第 ' + n + ' 幕】', '当前是第 ' + n + ' 幕。']
    const s = i >= 0 ? acts[i] : null
    if (!s) {
      lines.push('（这一本还没有生成流程大纲：照本子资料正常带，不要自己编幕。）')
      return lines.join('\n')
    }
    if (s.goal) lines.push('这一幕的目标：' + s.goal)
    if (s.steps && s.steps.length) lines.push('按这个顺序带：' + s.steps.join(' → '))
    if (s.pause) lines.push('该停就停：' + s.pause)
    if (s.hand) lines.push('这一幕可发的资料/线索：' + s.hand)
    if (s.truth) lines.push('真相口径：' + s.truth)
    lines.push('（流程是底稿，不是剧本：玩家跳出顺序时先接住他，再回到流程。）')
    return lines.join('\n')
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
    // 手写导入（2026-11-20）的条目没有 _text，正文只落 _source/main.md：字数不能因此报 0。
    // 只认这个名字，老资料夹条目的字数口径不受影响。
    if (chars === 0) {
      try {
        const hand = join(dir, '_source', 'main.md')
        if (existsSync(hand)) chars = statSync(hand).size
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

  /**
   * 手写导入一条内容（2026-11-20）：不建资料夹、不抽字，直接把正文（和可选的汤底/真相）
   * 落成一条游戏厅条目 —— 海龟汤这种「一碗汤面 + 一碗汤底」的小东西走这条路。
   * body = { scheme, title, text, truth?, players? }；校验口径与落盘结构见 README。
   * 参数不合规一律 { ok:false, code:400 }，写盘炸了才 500。
   */
  function arcadeCreateHand(body) {
    const scheme = String(body.scheme || '').trim()
    if (!SCHEME_IDS.has(scheme)) return { ok: false, code: 400, error: 'scheme 不在七种玩法里：' + scheme }
    const title = String(body.title || '').trim().slice(0, 30)
    if (!title) return { ok: false, code: 400, error: 'title 必填' }
    const text = String(body.text || '').trim().slice(0, 60000)
    if (text.trim().length < 10) return { ok: false, code: 400, error: '内容太短（至少 10 字）' }
    const truth = String(body.truth || '').trim().slice(0, 20000)
    const players = String(body.players || '').trim()
    // id：与 scanArcade 同一套「两位数字递增、取最小空号」。注意 scanArcade 读回来的 id 是
    // 归一过的（yaml 里的 "01" 会被 scalar 变成 1，页面上显示 "1"），所以这里按数字比较，
    // 不能拿字符串比 —— 否则 01 与 1 会被当成两个空号，撞出重号。
    const existing = scanArcade()
    const used = new Set()
    for (const x of existing) {
      const k = Number(x.id)
      if (Number.isFinite(k) && k > 0) used.add(k)
    }
    const safe = title.replace(/[\\/:*?"<>|]/g, '').replace(/[\s.]+$/, '') || '未命名'
    let n = 1
    let id = ''
    let caseFolder = ''
    for (;;) {
      id = String(n).padStart(2, '0')
      caseFolder = id + '-' + safe
      // 目录撞名也算被占：库里可能留着没写 arcade.yml 的残留目录，scanArcade 看不见它。
      if (used.has(n) || existsSync(join(arcadeRoot(), caseFolder))) { n += 1; continue }
      break
    }
    const dir = join(arcadeRoot(), caseFolder)
    const now = new Date().toISOString()
    // 正文与汤底写同一份文件：arcadeMaterial 整份读它（上限 60000 字），所以这份文件必须
    // 落在 60000 字以内，否则截断会砍在尾部 —— 先把材料按预算截掉，汤底永远完整保留。
    const head = '# ' + title + '\n（玩法：' + scheme + ' · 手写导入 · ' + now + '）\n\n## 材料\n\n'
    const truthSec = truth ? '\n\n## 汤底 / 真相（主持人专用：不得原样透给玩家）\n\n' + truth : ''
    const budget = 60000 - head.length - truthSec.length - 8
    const mat = text.length > budget ? text.slice(0, budget > 0 ? budget : 0) : text
    const doc = head + mat + truthSec + '\n'
    try {
      mkdirSync(join(dir, '_source'), { recursive: true })
      writeFileSync(join(dir, '_source', 'main.md'), doc, 'utf8')
      writeFileSync(join(dir, 'arcade.yml'), arcadeYml({
        id, title, scheme, players, note: '手写导入',
        // 来源资料夹留空：这条不是从书架导入的，没有 root / folder
        root: '', folder: '',
      }), 'utf8')
      return {
        ok: true,
        entry: {
          folder: caseFolder, id, title, scheme, players, note: '手写导入',
          chars: arcadeChars(dir), files: walkFiles(dir).length, updated: false,
        },
      }
    } catch (e) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 半截目录删不掉就留着 */ }
      return { ok: false, code: 500, error: String(e && e.message ? e.message : e) }
    }
  }

/**
   * 拆包（2026-11-20，m05055）：一个条目里装了多份内容时（典型是海龟汤合集——每个场景一对
   * 「<场景>_汤面.txt / <场景>_汤底.txt」），按场景拆成独立条目：汤面（+ _额外补充）作材料，
   * 汤底（可能有多份，如 _汤底2）合并作 truth。落盘复用 arcadeCreateHand，口径与手写导入一致。
   * body: { folder, scheme?, remove? }；remove=true 时只在拆出至少一条之后才删原条目。
   */
  function arcadeSplit(body) {
    const folder = String(body.folder ?? '')
    if (!/^[^./\\][^/\\]{0,79}$/.test(folder)) return { ok: false, code: 400, error: 'folder 不合法' }
    const dir = join(arcadeRoot(), folder)
    if (!existsSync(join(dir, 'arcade.yml'))) return { ok: false, code: 404, error: '内容库里没有这一本' }
    const meta = readArcadeMeta(join(dir, 'arcade.yml')) || {}
    const scheme = String(body.scheme || meta.scheme || 'soup')
    const files = arcadeTextDir(dir)
    const scenes = new Map()
    for (const abs of files) {
      const m = /^(.*)_汤面\d*\.txt$/i.exec(basename(abs))
      if (!m) continue
      const key = m[1].trim()
      if (!key) continue
      const row = scenes.get(key) || { key, surface: [], truth: [], extra: [] }
      row.surface.push(abs)
      scenes.set(key, row)
    }
    if (!scenes.size) return { ok: false, code: 400, found: 0, error: '没有可拆的场景（_text 里没有「*_汤面.txt」）' }
    for (const abs of files) {
      const name = basename(abs)
      for (const row of scenes.values()) {
        if (!name.startsWith(row.key + '_')) continue
        const tail = name.slice(row.key.length)
        if (/^_汤底/i.test(tail)) row.truth.push(abs)
        else if (/^_额外补充/i.test(tail)) row.extra.push(abs)
      }
    }
    const readOne = (abs) => { try { return readFileSync(abs, 'utf8').trim() } catch { return '' } }
    // 可重复点：已经拆过的场景不再重复建条目（否则每点一次就多一套重名卡）
    const seenTitles = new Set()
    try { for (const x of scanArcade()) { const t = String((x && x.title) || '').trim(); if (t) seenTitles.add(t) } } catch { /* 读不到就当空 */ }
    const made = []
    const skipped = []
    for (const row of scenes.values()) {
      const title = row.key.replace(/\s+sasili\s*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 30)
      const surf = row.surface.map(readOne).filter(Boolean)
      const extras = row.extra.map(readOne).filter(Boolean)
      const truth = row.truth.map(readOne).filter(Boolean)
      let text = surf.join('\n\n')
      if (extras.length) text += '\n\n## 额外补充\n\n' + extras.join('\n\n')
      if (seenTitles.has(title)) { skipped.push({ title, error: '内容库里已经有同名条目，跳过' }); continue }
      const one = arcadeCreateHand({ scheme, title, text, truth: truth.join('\n\n'), players: meta.players })
      if (one && one.ok) { made.push({ folder: one.entry.folder, title: one.entry.title, chars: one.entry.chars, truthFiles: truth.length }); seenTitles.add(title) }
      else skipped.push({ title, error: (one && one.error) || '未知错误' })
    }
    if (body.remove === true && made.length) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 删不掉就留着 */ }
    }
    return { ok: true, source: folder, found: scenes.size, made, skipped, already: made.length === 0 }
  }

  /**
   * 自动整理导入（2026-11-20，m05164）：把「一份内容一个子资料夹」的资料夹（海龟汤合集的形态：
   * 每碗汤一个夹子，里面是 汤面*.jpg / 汤底*.jpg）自动 ①识文字（图片/PDF 走 OCR；已有文字缓存直接用）
   * ②拆成一篇一条目。异步任务，进度看 GET /api/arcade/auto/status。
   */
  const ARCADE_AUTO = { running: false, phase: '', done: 0, total: 0, rel: '', made: [], failed: [], skipped: [], error: '', startedAt: 0, endedAt: 0, scheme: '', folder: '' }

  function arcadeAutoStatus() {
    return {
      running: ARCADE_AUTO.running, phase: ARCADE_AUTO.phase, done: ARCADE_AUTO.done, total: ARCADE_AUTO.total,
      rel: ARCADE_AUTO.rel, error: ARCADE_AUTO.error, startedAt: ARCADE_AUTO.startedAt, endedAt: ARCADE_AUTO.endedAt,
      scheme: ARCADE_AUTO.scheme, folder: ARCADE_AUTO.folder,
      made: ARCADE_AUTO.made.slice(), failed: ARCADE_AUTO.failed.slice(), skipped: ARCADE_AUTO.skipped.slice(),
    }
  }

  function arcadeListFiles(dir, depth = 0) {
    const out = []
    if (depth > 6) return out
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
    for (const e of ents) {
      const abs = join(dir, e.name)
      if (e.isDirectory()) out.push(...arcadeListFiles(abs, depth + 1))
      else out.push(abs)
    }
    return out
  }

  function arcadeAutoPieces(srcDir) {
    // 一份内容 = 一个子资料夹（汤面/汤底都在同一个夹子里）；没有子资料夹时整包算一份。
    let subs = []
    try { subs = readdirSync(srcDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { subs = [] }
    const real = subs.filter((n) => !/^[_.[]/.test(n))
    if (real.length >= 2) return real.map((n) => ({ title: n, dir: join(srcDir, n) }))
    return [{ title: basename(srcDir), dir: srcDir }]
  }

  function arcadeAutoTitle(raw) {
    return String(raw || '').replace(/\s+sasili\s*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 30)
  }

  function arcadeAutoScheme(schemeIn, folder) {
    const s = String(schemeIn || '')
    if (SCHEME_IDS.has(s)) return s
    if (/汤|海龟|soup/i.test(folder)) return 'soup'
    if (/侦探|推理|detective/i.test(folder)) return 'detective'
    return 'soup'
  }

  async function arcadeAutoRun(root, folder, schemeIn) {
    const srcDir = resolve(join(root, folder))
    const scheme = arcadeAutoScheme(schemeIn, folder)
    ARCADE_AUTO.scheme = scheme
    ARCADE_AUTO.folder = folder
    // 复用已有的文字缓存（这本书在剧本杀/游戏厅抽过字就不必再 OCR）
    const cache = new Map()
    try {
      const store = readTextStore(root, folder)
      for (const f of store.files || []) {
        try { cache.set(String(f.rel || '').replace(/\\/g, '/'), readFileSync(join(store.dir, f.txt), 'utf8')) } catch { /* 单份读不到当没有 */ }
      }
    } catch { /* 没有缓存就走 OCR */ }
    const pieces = arcadeAutoPieces(srcDir)
    ARCADE_AUTO.total = pieces.length
    ARCADE_AUTO.made = []
    ARCADE_AUTO.failed = []
    ARCADE_AUTO.skipped = []
    // 已经有同名条目就跳过：重导同一批不会再生成一套重复卡
    const seenTitles = new Set()
    try { for (const x of scanArcade()) { const t = String((x && x.title) || '').trim(); if (t) seenTitles.add(t) } } catch { /* 读不到就当空 */ }
    const IMG = /\.(jpe?g|png|webp|bmp)$/i
    const DOC = /\.pdf$/i
    const engine = resolveOcrEngine()
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i]
      ARCADE_AUTO.done = i
      ARCADE_AUTO.rel = arcadeAutoTitle(piece.title)
      const files = arcadeListFiles(piece.dir)
      const texts = new Map()
      const todo = []
      for (const abs of files) {
        const rel = String(abs).slice(srcDir.length + 1).replace(/\\/g, '/')
        const hit = cache.get(rel)
        if (hit !== undefined) { texts.set(abs, hit); continue }
        if (/\.txt$/i.test(abs)) { try { texts.set(abs, readFileSync(abs, 'utf8')) } catch { /* 读不到当没有 */ } ; continue }
        if (IMG.test(abs) || DOC.test(abs)) todo.push(abs)
      }
      if (todo.length) {
        ARCADE_AUTO.phase = 'ocr'
        const got = await ocrMany(todo, engine, {})
        for (const abs of todo) {
          const v = got.texts.get(ocrKey(abs))
          if (v && v.text) texts.set(abs, v.text)
        }
        if (got.engineError) {
          ARCADE_AUTO.error = ocrErrorText(got.engineError) || String(got.engineError.code || '')
          break
        }
      }
      const surf = []
      const truth = []
      const extra = []
      for (const abs of files) {
        const t = (texts.get(abs) || '').trim()
        if (!t) continue
        const nm = basename(abs)
        if (/汤底|真相|答案|解答|复盘/.test(nm)) truth.push(t)
        else if (/额外|补充/.test(nm)) extra.push(t)
        else surf.push(t)
      }
      let body = surf.join('\n\n')
      if (extra.length) body += '\n\n## 额外补充\n\n' + extra.join('\n\n')
      const title = arcadeAutoTitle(piece.title) || ('第 ' + (i + 1) + ' 份')
      if (seenTitles.has(title)) { ARCADE_AUTO.skipped.push({ title, reason: '已有同名条目' }); continue }
      const one = arcadeCreateHand({ scheme, title, text: body, truth: truth.join('\n\n'), players: '' })
      if (one && one.ok) { ARCADE_AUTO.made.push({ folder: one.entry.folder, title: one.entry.title, chars: one.entry.chars }); seenTitles.add(title) }
      else ARCADE_AUTO.failed.push({ title, error: (one && one.error) || '未知错误' })
    }
    ARCADE_AUTO.done = pieces.length
  }

  function startArcadeAuto(rootRaw, folderRaw, schemeIn) {
    if (ARCADE_AUTO.running) return { ok: false, code: 409, error: '已经有一个自动整理任务在跑', status: arcadeAutoStatus() }
    const root = resolve(String(rootRaw || ''))
    const folder = String(folderRaw || '').trim()
    if (!folder) return { ok: false, code: 400, error: 'folder 必填' }
    const srcDir = resolve(join(root, folder))
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) return { ok: false, code: 404, error: '资料夹不存在：' + srcDir }
    ARCADE_AUTO.running = true
    ARCADE_AUTO.phase = 'scan'
    ARCADE_AUTO.done = 0
    ARCADE_AUTO.total = 0
    ARCADE_AUTO.rel = ''
    ARCADE_AUTO.made = []
    ARCADE_AUTO.failed = []
    ARCADE_AUTO.skipped = []
    ARCADE_AUTO.error = ''
    ARCADE_AUTO.startedAt = Date.now()
    ARCADE_AUTO.endedAt = 0
    arcadeAutoRun(root, folder, schemeIn)
      .catch((e) => { ARCADE_AUTO.error = String((e && e.message) || e) })
      .finally(() => {
        ARCADE_AUTO.running = false
        ARCADE_AUTO.phase = ARCADE_AUTO.error ? 'error' : 'done'
        ARCADE_AUTO.endedAt = Date.now()
        console.info('[game-desk] arcade auto 结束：made=' + ARCADE_AUTO.made.length + ' failed=' + ARCADE_AUTO.failed.length + (ARCADE_AUTO.error ? ' error=' + ARCADE_AUTO.error : ''))
      })
    return { ok: true, status: arcadeAutoStatus() }
  }


  function arcadeMaterial(dir) {
    const parts = []
    for (const abs of arcadeTextDir(dir).slice(0, 6)) {
      const s = readCap(abs, 12000)
      if (s) parts.push('【' + basename(abs) + '】\n' + s)
    }
    if (parts.length === 0) {
      // 手写导入（2026-11-20）：正文和汤底在同一份 _source/main.md 里，按材料上限整份读。
      // 汤底必须进 system prompt（主持人知道真相才判得对），不能被通用回退的 8000 字截掉 ——
      // 那个回退按文件顺序取前 4 份、每份 8000 字，正好会砍在 main.md 尾部。
      const hand = join(dir, '_source', 'main.md')
      if (existsSync(hand)) {
        const s = readCap(hand, 60000)
        if (s) parts.push(s)
      }
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
      const dmSide = h.role === 'dm' || h.role === 'assistant' || h.who === 'dm' || h.who === 'assistant'
      const who = dmSide ? '主持人' : '玩家'
      const t = String(h.text || '').slice(0, 800).trim()
      if (t !== '') lines.push(who + '：' + t)
    }
    // 文档口径是 text，页内历史上传 input —— 两个都认（2026-11-20 端到端测试发现的契约漂移）
    const input = String(body.input || body.text || '').slice(0, 2000)
    if (body.open !== true && input.trim() === '') return { ok: false, code: 400, error: 'input 必填（这一轮要说什么/做什么）' }
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
      let usage = null
      for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
        if (chunk && chunk.type === 'text-delta') text += String(chunk.text || '')
        else if (chunk && chunk.type === 'usage') usage = chunk.usage
        else if (chunk && chunk.type === 'finish') finish = chunk.reason
      }
      if (finish && finish.kind === 'error') {
        return { ok: false, code: 502, error: '模型报错：' + (finish.failure && finish.failure.message ? finish.failure.message : '未知') }
      }
      text = text.trim()
      if (text === '') return { ok: false, code: 502, error: '模型回了一段空文本，再发一次试试' }
      recordModelUsage('arcade-content', sel, usage)
      return { ok: true, text, model: sel.provider + '/' + sel.model, ms: Date.now() - t0, usage }
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
    // 全文读一遍做关键词检索：缺不缺不能靠抽样猜——正文里有的东西，摘录没截到不等于缺
    const full = []
    for (const abs of texts.slice(0, 24)) {
      let s = ''
      try { s = readFileSync(abs, 'utf8') } catch { /* 读不到就跳过 */ }
      if (s) full.push({ name: basename(abs).replace(/\.txt$/i, ''), s })
    }
    const parts = []
    for (const f of full.slice(0, 10)) {
      parts.push('【' + f.name + '｜开头】\n' + f.s.slice(0, 2600) + (f.s.length > 2600 ? '\n……（截到这儿）' : ''))
      if (f.s.length > 6000) parts.push('【' + f.name + '｜结尾（真相/解析常在这）】\n……（前面略）\n' + f.s.slice(-2600))
    }
    if (!parts.length && existsSync(join(dir, 'case.yml'))) {
      const s = readCap(join(dir, 'case.yml'), 16000)
      if (s) parts.push('【case.yml】\n' + s)
    }
    const material = parts.join('\n\n').slice(0, 48000)
    if (material.trim() === '') return { ok: false, code: 422, error: '这一本现在读不到正文：先在体检处把抽字跑完（扫描件走 OCR），再来总结缺件' }
    const GAP_CATS = [
      ['组织者/游戏手册', /组织者须知|主持人|游戏手册|DM\s?手册|GM\s?手册|真相手册|上帝视角/],
      ['人物剧本', /角色剧本|人物剧本|你的任务|你扮演/],
      ['线索', /线索/],
      ['真相/解析/复盘/答案', /真相|解析|复盘|答案/],
      ['故事背景/引子', /故事背景|背景故事|故事简介|剧情简介|开场白|楔子|引子/],
      ['答题卡', /答题卡/],
    ]
    const digest = GAP_CATS.map(([label, re]) => {
      const per = []
      let n = 0
      for (const f of full) {
        const hits = f.s.match(new RegExp(re.source, 'g'))
        if (hits && hits.length) { per.push(f.name + ' ' + hits.length + '处'); n += hits.length }
      }
      return label + '：' + (n ? '全文命中 ' + n + ' 处（' + per.slice(0, 8).join('，') + '）' : '全文零命中')
    }).join('\n')
    let noText = []
    try {
      const srcDir = join(dir, '_source')
      if (existsSync(srcDir)) {
        const have = new Set(full.map((f) => f.name))
        noText = walkFiles(srcDir).map((f) => f.rel).filter((r) => {
          const key = String(r).replace(/\.[^.]+$/, '').replace(/\\/g, '/').replace(/\//g, '__')
          return /\.(pdf|docx?|jpe?g|png)$/i.test(r) && !have.has(key)
        })
      }
    } catch { /* 列不出来就少一段证据 */ }
    const llm = ctx.get ? ctx.get('llm', false) : false
    if (!llm || typeof llm.prepareCall !== 'function') return { ok: false, code: 503, error: '宿主没有可用的 llm 服务' }
    const adm = ctx.get ? ctx.get('agentDefaultModel', false) : false
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
    if (!sel || !sel.provider || !sel.model) return { ok: false, code: 503, error: '没有探测到默认模型（agentDefaultModel）' }
    const system = [
      '你是剧本库存档员。下面是一本剧本（游戏资料）的文件清单、全文关键词检索结果与正文抽样（每份抽出文本的开头与结尾），请只根据这些材料，整理「这一本要开一局还缺什么」。',
      '规则：',
      '- 「全文关键词检索」是在全部抽出文字里数出来的命中：某类命中大于 0 就不能说它缺——最多写「有痕迹（哪些文件几处），抽样没展开」；',
      '- 「还没抽出字的文件」是扫描件没跑 OCR 或抽取失败：要说「这些文件还没抽出字，先跑抽取/OCR」，不能说资料缺失；',
      '- 只有检索零命中、文件清单里也看不出有这类东西，才列成「缺」；判断不了就写「材料里看不出来」；不替本子补写内容；',
      '- 不评价质量，不复述剧情；',
      '- 最多 8 行，每行以「- 」开头，格式「结论：材料里的依据」；',
      '- 如果材料看着是齐的，只回一行「材料齐全，没看出缺件」。',
    ].join('\n')
    const userText = '【这本】' + folder + '\n【文件清单（前 200 项）】\n' + list.slice(0, 200).join('\n') +
      '\n【全文关键词检索】\n' + digest +
      (noText.length ? '\n【还没抽出字的文件（不代表缺件）】\n' + noText.slice(0, 20).join('\n') : '') +
      '\n【正文抽样】\n' + material
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
      let usage = null
      for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
        if (chunk && chunk.type === 'text-delta') text += String(chunk.text || '')
        else if (chunk && chunk.type === 'usage') usage = chunk.usage
        else if (chunk && chunk.type === 'finish') finish = chunk.reason
      }
      if (finish && finish.kind === 'error') {
        return { ok: false, code: 502, error: '模型报错：' + (finish.failure && finish.failure.message ? finish.failure.message : '未知') }
      }
      text = text.trim()
      if (text === '') return { ok: false, code: 502, error: '模型回了一段空文本，再试一次' }
      recordModelUsage('case-gaps', sel, usage)
      return { ok: true, text, model: sel.provider + '/' + sel.model, ms: Date.now() - t0, usage }
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
    { label: '前往', tool: 'loop_move', fields: [{ k: 'to', label: '地点', ph: '这一局引擎里的地名（先点「观察」看它给哪些地方）' }] },
    { label: '行动', tool: 'loop_act', fields: [{ k: 'action', label: '做什么', ph: '用铜钥匙拆下断裂铆钉' }] },
    { label: '深查', tool: 'loop_investigate', fields: [{ k: 'target', label: '对象', ph: '档案箱 / 挎包 / 炭盆…' }] },
    { label: '对话', tool: 'loop_talk', fields: [{ k: 'npc', label: '对象', ph: '在场的人名（引擎会提示可选谁）' }, { k: 'text', label: '你说', ph: '自由发挥' }] },
    { label: '快进', tool: 'loop_fast_forward', fields: [{ k: 'plan', label: '计划（时间+地点+动作）', type: 'area', ph: '12:00 图书馆翻档案箱 → 15:00 集市摸挎包' }] },
    { label: '提交完美一日', tool: 'loop_submit_plan', end: true, fields: [{ k: 'plan', label: '全天方案', type: 'area' }] },
  ],
  council: [
    { label: '开启本季议会', tool: 'council_consult', fields: [] },
    { label: '听顾问发言', tool: 'council_speak', fields: [] },
    { label: '追问顾问', tool: 'council_question', fields: [{ k: 'adviser', label: '顾问', ph: '议会里那位顾问的名字' }, { k: 'text', label: '你问', ph: '自由发挥' }] },
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

// ---------- 重大线索解锁（功能B，用户 m01167）：纯读盘，零模型调用 ----------
// 引擎（dsh-xgame）每次工具调用后把对局真相与进度原子落盘 storages/dsh-xgame/<sid>/
// {truth.json,state.json}；sid 由前端生成、pickSid 原样采用 ⇒ 目录名==sid。
// 线索卡 = truth 全集 × state 已获得；没点亮的卡 text 恒为 null（防泄底）。
// 字段名以磁盘样例核对过（2026-11-19）；对不上的玩法回 no-map，前端静默不显卡片。
function xgameDir(sid) { return join(dshHome(), 'storages', 'dsh-xgame', sid) }

function readGameJson(sid, name) {
  try { return JSON.parse(readFileSync(join(xgameDir(sid), name), 'utf8')) || null } catch { return null }
}

function schemeOfSid(sid) {
  const rest = String(sid || '').slice(XGAME_PREFIX.length)
  const m = /^[a-z][a-z0-9]*/.exec(rest)
  return m ? m[0] : ''
}

function xgameClues(sid, schemeIn) {
  if (!existsSync(join(xgameDir(sid), 'state.json'))) return { ok: false, error: 'no-game' }
  const st = readGameJson(sid, 'state.json')
  const tr = readGameJson(sid, 'truth.json')
  if (!st || !tr) return { ok: false, error: 'no-game' }
  // 玩法优先取请求里的 scheme（前端必带），sid 前缀推导只兜底——sid 命名不掺玩法时也不误伤
  const scheme = /^[a-z][a-z0-9]{1,15}$/.test(String(schemeIn || '')) ? String(schemeIn) : schemeOfSid(sid)
  const map = CLUE_MAP[scheme]
  if (!map || typeof map.cards !== 'function') return { ok: false, error: 'no-map' }
  let cards = []
  try { cards = map.cards(tr, st) || [] } catch { return { ok: false, error: 'no-map' } }
  // 汤面（谜面）本身可以公开：它是玩家要猜的那个反常片段，汤底才是答案
  const surface = scheme === 'soup' ? String(tr.surface || '').trim().slice(0, 4000) : ''
  // 海龟汤即便没有 core 线索卡也要把汤面端出来，所以只有非 soup 才算 no-map
  if (!cards.length && scheme !== 'soup') return { ok: false, error: 'no-map' }
  const lit = cards.filter((c) => c && c.on).length
  const total = cards.length
  const complete = typeof map.complete === 'function' ? map.complete(cards, lit, total) : total > 0 && lit === total
  return { ok: true, title: map.title, endTitle: map.endTitle, cards, total, lit, complete, surface }
}

function xgameUnlock(sid, schemeIn) {
  const j = xgameClues(sid, schemeIn)
  if (!j.ok) return { ok: false, error: j.error }
  if (!j.complete) return { ok: false, error: 'clues-not-complete' }
  const scheme = /^[a-z][a-z0-9]{1,15}$/.test(String(schemeIn || '')) ? String(schemeIn) : schemeOfSid(sid)
  const map = CLUE_MAP[scheme]
  let ending = ''
  try { ending = String(map.ending(readGameJson(sid, 'truth.json'), readGameJson(sid, 'state.json')) || '') } catch { ending = '' }
  if (ending.trim() === '') return { ok: false, error: 'no-map' }
  return { ok: true, ending }
}

// ---------- 提示（这局现在能深查 / 能勘查 / 能问 / 能去哪）：纯读盘，零模型调用 ----------
// 与线索卡同源（truth × state），口径相反：线索卡点亮了才给正文，提示只给「名字」——
// 地点名 / NPC 名 / 物件名 / 顾问名，绝不带 fact.text、auditKeywords、solution、trap 之类真相字段。
// 所以这里一律只从 locations / events[].investigate.target / npcs / advisors / rooms / props /
// doors / regions / suspects 里取名字，读都不读 facts 的正文（facts 只当「元知识 id 集合」用）。

/** 只读 state.json / truth.json 算提示。没有对局 → no-game；这档没得提示 → ok + sections:[]。 */
function xgameHints(sid, schemeIn) {
  const st = readGameJson(sid, 'state.json')
  const tr = readGameJson(sid, 'truth.json')
  if (!st || !tr) return { ok: false, error: 'no-game' }
  // 玩法以 state.json 为准（body.scheme 与它不一致时也听 state 的，回包里的 scheme 同源）；
  // state 没写 scheme 才回落到请求参数、再回落 sid 前缀。
  let scheme = hStr(st.scheme)
  if (scheme === '') scheme = /^[a-z][a-z0-9]{1,15}$/.test(hStr(schemeIn)) ? hStr(schemeIn) : schemeOfSid(sid)
  const fn = HINT_MAP[scheme]
  const title = hStr(tr.title) || hStr(tr.name)
  if (typeof fn !== 'function') return { ok: true, scheme: scheme, title: title, where: null, sections: [] }
  const phase0 = hStr(st.phase)
  const ended = ['solved', 'given_up', 'ended', 'finished'].indexOf(phase0) >= 0
  // 终局只读投影一律 200，但不再给「还能去哪、还能查哪」——这句谎话玩家一看就知道对不上
  if (ended) return { ok: true, scheme: scheme, title: title, where: null, ended: true, sections: [] }
  let out = {}
  // 存档形状不认识（events 为 null、locations 不是数组…）就当「没得提示」，绝不 500/抛错
  try { out = fn(tr, st) || {} } catch { out = {} }
  return { ok: true, scheme: scheme, title: title, where: out.where || null, sections: hSections(out.sections) }
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
  const schemeIn = String(body.scheme || '')
  const knownSchemes = Object.keys(XGAME_ACTIONS)
  if (schemeIn !== '' && knownSchemes.indexOf(schemeIn) < 0) {
    return { ok: false, code: 400, error: 'scheme 不合法（只能是 ' + knownSchemes.join('、') + '）' }
  }
  // sid 必须由调用方给：以前缺省会回落成常量 game-desk-<scheme>，多开同玩法必互相覆盖
  const rawSid = String(body.sid || '')
  if (!/^[a-z][a-z0-9-]{1,47}$/.test(rawSid)) {
    return { ok: false, code: 400, error: 'sid 必填（每局一个，形如 game-desk-soup-ab12cd34）' }
  }
  const sid = rawSid
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
    // 引擎的 loop_move 对空串会静默传送到 locations[0] 并扣一个时间片；原地「前往」也白扣一格 ⇒ 这两类先拦
    if (tool === 'escape_solve') {
      const pz = String(args.puzzle == null ? '' : args.puzzle).trim()
      const tr0 = readGameJson(sid, 'truth.json') || {}
      const list = gList(tr0.puzzles)
      const hitPz = list.find((p) => p && String(p.name || '') === pz)
      if (pz !== '' && !hitPz && list.length === 1 && list[0] && String(list[0].name || '') !== '') {
        args.puzzle = String(list[0].name)
        args.__aliasedFrom = pz
      }
    }
    if (tool === 'loop_move') {
      const to = String(args.to == null ? '' : args.to).trim()
      if (to === '') return { ok: false, code: 400, error: 'to 必填（这一局引擎里的地名，先点「提示」看能去哪）' }
      const st0 = readGameJson(sid, 'state.json') || {}
      const tr0 = readGameJson(sid, 'truth.json') || {}
      const hereId = String(st0.location || '')
      const hereLoc = gList(tr0.locations).find((l) => l && String(l.id) === hereId) || null
      const hereName = hereLoc ? String(hereLoc.name || hereId) : hereId
      if (to === hereName || to === hereId) {
        return { ok: false, code: 409, error: '你已经在「' + hereName + '」了，换一个地方（不扣时间片）' }
      }
    }
    const result = await def.execute(args, exec)
    // 2026-11-20 P1-13：引擎工具的模型用量在 xgame 内部，这里拿不到 —— 明确标 usageKnown:false，
    // 不假装记一笔 0（假 0 会让「今天用了多少」偏低且看不出来）。
    return { ok: true, result, sid, model: String(sel.provider) + '/' + String(sel.model), usageKnown: false }
  } catch (error) {
    const msg = String(error && error.message ? error.message : error)
    // 以前一律 500：正常业务状态（本局已结束）与参数错误都被当成服务器故障（端到端测试 D2/D3）
    const code = /已结束|开新局/.test(msg) ? 409
      : /没有进行中的游戏|没有进行中的一局/.test(msg) ? 404
        : /invalid arguments|missing required|不能为空|必填|不合法|没有这位人士|没有识别出|没有这个地方|没有这个谜题|不是反转模式/.test(msg) ? 400
          : 500
    return { ok: false, code, error: msg }
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
    let usage = null
    for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
      if (chunk.type === 'text-delta') acc += String(chunk.text || '')
      else if (chunk && chunk.type === 'usage') usage = chunk.usage
    }
    acc = acc.trim()
    if (acc === '') return { ok: false, code: 502, error: '转述是空的' }
    recordModelUsage('narrate', sel, usage)
    return { ok: true, text: acc, usage }
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
  // 引擎口径落一行日志：默认 rapid-cuda（GPU），只有用户在 settings.json 里显式写 rapid/vl/off 才改。
  try {
    const eff = resolveOcrEngine()
    console.info('[game-desk] OCR 引擎=' + eff + '（settings.ocrEngine=' + ocrSettingRaw() + '，默认 ' + OCR_DEFAULT_ENGINE + '）')
    if (eff !== 'off' && !ocrAvailable(eff)) console.info('[game-desk] OCR 引擎=' + eff + ' 但缺解释器或 CLI：' + String(OCR_PY[eff] || ''))
  } catch { /* 日志失败不影响启动 */ }
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

  // ---------- 缺项 AI 复核与补全（用户 2026-11-19） ----------
  // 体检有两处会误报缺：正则没认出写法（写法不同就判零命中）、模型只看了部分文本。
  // 所以缺项先让 AI 对照原文复核，真缺再让 AI 补全；补全只落 _ai_fill/ 新文件并在 pack-meta 记账，
  // 绝不改用户原稿。口径：复核只信原文，拿不准算「未复核成」（reallyMissing 里含 unclear）。

  /** 取参与复核/补全的正文材料：每份开头 1200 + 结尾 2600，总预算约 24000 字符。
   *  头尾都要，是因为引子常在最前、真相/复盘常在最后；只截开头会把后半段的要素误判成缺。 */
  function packTextMaterial(root, folder, budget = 24000) {
    const store = readTextStore(root, folder)
    const parts = []
    let used = 0
    let files = 0
    for (const f of store.files || []) {
      // 2026-11-20 P0-6：_ai_fill/ 里是模型上一轮补写的稿子，不是原稿 —— 当材料喂回去会自我强化
      if (isAiFillRel(f.rel)) continue
      if (used >= budget) break
      let s = ''
      try { s = readFileSync(join(store.dir, f.txt), 'utf8') } catch { s = '' }
      if (!s.trim()) continue
      const name = String(f.rel || f.txt || '')
      let seg = '【' + name + '｜开头】\n' + s.slice(0, 1200)
      if (s.length > 1200) seg += '\n……（中间略）……\n【' + name + '｜结尾（真相/解析常在这）】\n' + s.slice(-2600)
      if (used + seg.length > budget) seg = seg.slice(0, Math.max(0, budget - used))
      if (!seg.trim()) continue
      parts.push(seg)
      used += seg.length
      files += 1
    }
    return { text: parts.join('\n\n'), files, chars: used }
  }

  /** 取模型（与 caseGaps 同一套取法）：llm seam + agentDefaultModel 当前选择。 */
  function packLlm() {
    const llm = ctx.get ? ctx.get('llm', false) : false
    if (!llm || typeof llm.prepareCall !== 'function') return { error: '宿主没有可用的 llm 服务' }
    const adm = ctx.get ? ctx.get('agentDefaultModel', false) : false
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null
    if (!sel || !sel.provider || !sel.model) return { error: '没有探测到默认模型（agentDefaultModel）' }
    return { llm, sel, model: sel.provider + '/' + sel.model }
  }

  /** 一次模型调用（姿势照抄 caseGaps）：收 text-delta / usage / finish，收尾记账。 */
  async function packModelOnce(pick, { system, userText, maxTokens, usageSource, sourceKind, timeoutMs }) {
    const signal = AbortSignal.timeout(timeoutMs || 120000)
    try {
      const call = await pick.llm.prepareCall({ provider: pick.sel.provider, model: pick.sel.model, maxTokens }, signal)
      const messages = [{ role: 'user', content: [{ type: 'text', text: userText }], source: { kind: sourceKind }, id: randomUUID() }]
      let text = ''
      let finish = null
      let usage = null
      for await (const chunk of call.stream({ ...call.config, messages, system, signal })) {
        if (chunk && chunk.type === 'text-delta') text += String(chunk.text || '')
        else if (chunk && chunk.type === 'usage') usage = chunk.usage
        else if (chunk && chunk.type === 'finish') finish = chunk.reason
      }
      if (finish && finish.kind === 'error') return { ok: false, code: 502, error: '模型没返回' }
      text = text.trim()
      if (text === '') return { ok: false, code: 502, error: '模型没返回' }
      recordModelUsage(usageSource, pick.sel, usage)
      return { ok: true, text, usage }
    } catch {
      // 不把底层异常原文回给页面：口径统一成「模型没返回」，细节已进日志之外的调用栈
      return { ok: false, code: 502, error: '模型没返回' }
    }
  }

  /** 从模型回包里抠 JSON：允许 ```json 围栏与前后废话，只认第一个 { 到最后一个 }。 */
  function parseJsonLoose(text) {
    let s = String(text || '').trim()
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s)
    if (fence) s = fence[1].trim()
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
  }

  /** 多次调用的 usage 相加（字段名与 recordModelUsage 读的一致）。 */
  function mergeUsage(acc, u) {
    if (!u) return acc
    const out = acc || { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    const input = Number(u.inputTokens) || 0
    const output = Number(u.outputTokens) || 0
    out.inputTokens += input
    out.outputTokens += output
    out.totalTokens += Number(u.totalTokens) || (input + output)
    if (u.cacheReadTokens) out.cacheReadTokens = (Number(out.cacheReadTokens) || 0) + (Number(u.cacheReadTokens) || 0)
    return out
  }

  /** aiFill 文件名：key 来自体检 id（premise/scripts/clues…），仍做一次白名单清洗，防路径穿越。 */
  function aiFillKey(key) {
    return String(key).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'item'
  }

  /** 复核：只让模型对着原文判「缺项到底在不在」，结果写 meta.review；拿不准一律算没复核成。 */
  async function packReview(root, folder) {
    const entry = scanRoot(root).find((c) => c.kind === 'pack' && c.folder === folder)
    if (!entry) return { ok: false, code: 404, error: 'pack-not-found' }
    let meta = readPackMeta(root, folder)
    // 没体检标签就先造一份（只读文本缓存，不重抽、不启 OCR）
    if (!meta) meta = refreshPackMeta(root, folder, entry)
    if (!meta) return { ok: false, code: 422, error: 'no-text' }
    // 用户 m0xxxx：warn 也是缺（buildPackMeta 的 complete 就是把 warn 一起算进去的），所以不分 level，最多前 8 项
    const missing = (Array.isArray(meta.missing) ? meta.missing : [])
      .filter((m) => m && m.key)
      .slice(0, 8)
      .map((m) => ({ key: String(m.key), label: String(m.label || m.key), level: String(m.level || ''), detail: String(m.detail || '') }))
    if (missing.length === 0) return { ok: true, verdicts: [], reallyMissing: [], present: [], note: 'no-missing' }
    const material = packTextMaterial(root, folder)
    if (!material.text.trim()) return { ok: false, code: 422, error: 'no-text' }
    const pick = packLlm()
    if (pick.error) return { ok: false, code: 503, error: pick.error }
    const list = missing.map((m, i) => (i + 1) + '. key=' + m.key + '｜' + m.label + (m.detail ? '｜体检描述：' + m.detail : '')).join('\n')
    const system = [
      '你是剧本库的核对员。下面给出一本剧本（资料夹版）的「体检缺项」与正文材料（每份抽出的文字只取开头与结尾）。',
      '请逐项判断：这些项在原文里到底有没有。',
      '规则：',
      '- 只有正文材料里确实能找到对应内容，才判 present，并在 evidence 里抄一段支撑它的原文（不超过 80 字，必须是原文片段，不许改写、不许编造）；',
      '- 材料里确实找不到对应内容（连痕迹都没有），判 missing；',
      '- 能看出一点痕迹但不足以确认完整，或材料恰好没覆盖到那部分，判 unclear；拿不准一律 unclear；',
      '- 不要因为体检说缺就跟着说缺，以你看到的原文为准；',
      '- 只输出严格 JSON，不要解释、不要 Markdown 围栏：',
      '{"items":[{"key":"<照抄我给的 key>","verdict":"missing|present|unclear","evidence":"<=80字原文片段（present 必须有）","why":"<=60字理由"}]}',
      '- items 必须覆盖我给的每一个 key，key 一字不改。',
    ].join('\n')
    const userText = '【这一本】' + folder + '\n【待复核的缺项】\n' + list + '\n【正文材料】\n' + material.text
    const out = await packModelOnce(pick, { system, userText, maxTokens: 1200, usageSource: 'pack-review', sourceKind: 'game-desk-pack-review' })
    if (!out.ok) return out
    const parsed = parseJsonLoose(out.text)
    if (!parsed || !Array.isArray(parsed.items)) return { ok: false, code: 502, error: '模型回包不是 JSON' }
    const byKey = new Map()
    for (const it of parsed.items) {
      if (!it || typeof it !== 'object') continue
      byKey.set(String(it.key || ''), it)
    }
    const verdicts = missing.map((m) => {
      const it = byKey.get(m.key) || {}
      let verdict = String(it.verdict || '').toLowerCase()
      if (verdict !== 'missing' && verdict !== 'present' && verdict !== 'unclear') verdict = 'unclear'
      // 换行压成空格：证据是「原文里的一句话」，前端按一行引用显示，带 \n 会把版面撑坏
      const evidence = String(it.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 80)
      const why = String(it.why || '').replace(/\s+/g, ' ').trim().slice(0, 60)
      // present 必须带原文证据：没给证据说明模型其实没找到，保守降为 unclear（不信口头结论）
      if (verdict === 'present' && evidence.trim() === '') verdict = 'unclear'
      return { key: m.key, label: m.label, verdict, evidence, why }
    })
    // 2026-11-20（P2）：开头读的 meta 是模型调用之前的快照，模型要跑几十秒，这期间抽取收尾可能整份重写 meta。
    // 写回前重读，只覆盖自己负责的字段（review），其余字段用新读到的 —— 别拿旧快照盖掉别人的更新。
    const fresh = readPackMeta(root, folder) || meta
    fresh.review = { at: new Date().toISOString(), model: pick.model, verdicts }
    if (!writePackMeta(root, folder, fresh)) return { ok: false, code: 500, error: 'meta-write-failed' }
    return {
      ok: true,
      folder,
      model: pick.model,
      verdicts,
      reallyMissing: verdicts.filter((v) => v.verdict !== 'present').map((v) => v.key),
      present: verdicts.filter((v) => v.verdict === 'present').map((v) => v.key),
      usage: out.usage,
    }
  }

  /** 试玩的六个环节：顺序固定，模型只填空、不增删，前端照这个顺序画。 */
  const PLAYTEST_GATES = [
    ['open', '开本'],
    ['roles', '角色'],
    ['scripts', '人物剧本'],
    ['clues', '线索'],
    ['truth', '真相 / 复盘'],
    ['host', '主持'],
  ]
  /** 压成一行（前端每条只占一行，多行会把版面撑坏）。 */
  function oneLine(v, n) {
    return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n)
  }
  /** 把模型回包规整成 meta.playtest：state 只认 ok|thin|broken（认不出按 thin），
   *  canPlay 一律由 gates 现算 —— 模型自己填的 canPlay 不算数，免得 why 说能玩、gates 全是 broken。 */
  function normalizePlaytest(raw, model, stamp, meta) {
    const r = raw && typeof raw === 'object' ? raw : {}
    const byKey = new Map()
    for (const it of Array.isArray(r.gates) ? r.gates : []) {
      if (!it || typeof it !== 'object') continue
      byKey.set(String(it.key || ''), it)
    }
    const gates = PLAYTEST_GATES.map(([key, label]) => {
      const it = byKey.get(key) || {}
      let state = String(it.state || '').toLowerCase()
      if (state !== 'ok' && state !== 'thin' && state !== 'broken') state = 'thin'
      return { key, label, state, note: oneLine(it.note, 60) }
    })
    const broken = gates.filter((g) => g.state === 'broken')
    const thin = gates.filter((g) => g.state === 'thin').length
    const canPlay = broken.length === 0
    const blockers = (Array.isArray(r.blockers) ? r.blockers : []).map((b) => {
      if (!b || typeof b !== 'object') return null
      const what = oneLine(b.what, 40)
      if (!what) return null
      return { what, need: oneLine(b.need, 40) }
    }).filter(Boolean).slice(0, 6)
    const tips = (Array.isArray(r.tips) ? r.tips : [])
      .map((t) => oneLine(typeof t === 'string' ? t : (t && t.text), 60))
      .filter(Boolean)
      .slice(0, 4)
    return {
      at: new Date().toISOString(),
      model,
      stamp,
      canPlay,
      verdict: !canPlay ? 'unplayable' : (thin > 0 ? 'risky' : 'playable'),
      why: oneLine(r.why, 80),
      gates,
      // 能玩就不列「卡在哪」（模型偶尔把缺项写进 blockers）；缺项一律进 tips
      blockers: canPlay ? [] : blockers,
      tips,
      missingN: (Array.isArray(meta && meta.missing) ? meta.missing : []).length,
      chars: Number(meta && meta.chars) || 0,
    }
  }

  /** AI 试玩评测（用户 2026-11-20）：「体检」只回答要素齐不齐，开不开得起来得让 DM 走一遍流程。
   *  判据不是「缺没缺项」，而是「一个没读过这本的 DM，拿这些材料能不能把一局跑完」——
   *  缺项只要不卡流程（没标人数/难度/作者、线索没标条数）仍算能玩，写进 tips 让人现场处理。
   *  结论存 meta.playtest（带材料指纹）；材料没变就不重复烧模型。 */
  async function packPlaytest(root, folder, force) {
    const entry = scanRoot(root).find((c) => c.kind === 'pack' && c.folder === folder)
    if (!entry) return { ok: false, code: 404, error: 'pack-not-found' }
    let meta = readPackMeta(root, folder)
    // 没体检标签就先造一份（只读文本缓存，不重抽、不启 OCR）
    if (!meta) meta = refreshPackMeta(root, folder, entry)
    if (!meta) return { ok: false, code: 422, error: 'no-text' }
    const store = readTextStore(root, folder)
    const screen = applyAiFillToScreen(screenPack(root, folder, entry, store), meta)
    const stamp = screenStamp(screen)
    const prev = meta.playtest && typeof meta.playtest === 'object' ? meta.playtest : null
    // 同一份材料跑过就直接回上次结论（点「重新试玩」才带 force）
    if (!force && prev && String(prev.stamp || '') === stamp) {
      return { ok: true, folder, cached: true, playtest: prev, usage: null }
    }
    const material = packTextMaterial(root, folder, 26000)
    if (!material.text.trim()) return { ok: false, code: 422, error: 'no-text' }
    const pick = packLlm()
    if (pick.error) return { ok: false, code: 503, error: pick.error }
    const checks = Array.isArray(screen.checks) ? screen.checks : []
    const miss = checks.filter((c) => c && c.level !== 'ok')
    const list = miss.length
      ? miss.map((c) => '- ' + String(c.label || c.id) + (c.detail ? '：' + String(c.detail) : '')).join('\n')
      : '（体检没有缺项）'
    const system = [
      '你是剧本杀的资深 DM。这次不是挑毛病，而是回答一个问题：这本「资料夹版」的本子，现在能不能开一局。',
      '你会看到体检结论、体检列出的缺项，以及每份文件抽出的文字（只有开头与结尾，中间省略）。',
      '照着流程在心里走一遍：开本 → 发人物剧本 → 第一幕 → 搜证 → 指认/投票 → 复盘。',
      '判断口径（重要）：',
      '- 缺项 ≠ 不能玩。没标人数、没标难度、没写作者、线索没标条数、没有独立线索卡但正文里有线索小节——这些都只是「薄」，不是「断」，仍然算能玩，写进 tips 告诉 DM 现场怎么处理。',
      '- 只有真正卡死才断：没人能读到自己的人物剧本 / 完全没有线索可搜 / 找不到真相或结局（复盘讲不清谁、怎么做、为什么）/ 角色与材料对不上导致有人空手。',
      '- 材料只抽了头尾，看不见某段正文时不要判断；按「薄」处理，并说明你没看到什么。',
      '- 材料里没看到就写「材料里没看到」，不要拿剧本杀的常识替它补。',
      'gates 必须给全这六个环节，key 一字不改：open（开本流程）、roles（角色表）、scripts（人物剧本）、clues（线索）、truth（真相/复盘）、host（主持）；state 取 ok|thin|broken，broken 必须写清卡在哪。',
      'canPlay 由 gates 决定：没有 broken 就能玩，别写反。',
      '只输出严格 JSON，不要解释、不要 Markdown 围栏：',
      '{"canPlay":true,"why":"<=60字一句话结论","gates":[{"key":"open","state":"ok|thin|broken","note":"<=40字"}],"blockers":[{"what":"<=30字卡在哪","need":"<=30字补什么才能开"}],"tips":["<=40字，最多3条：DM 现场怎么处理"]}',
    ].join('\n')
    const spec = [meta.players ? (String(meta.players) + ' 人') : '', meta.genre ? String(meta.genre) : ''].filter(Boolean).join(' · ')
    const userText = '【这一本】' + folder +
      '\n【体检】' + String(meta.verdict || '') + '（' + checks.filter((c) => c && c.level === 'ok').length + '/' + checks.length + ' 项通过，' +
      String(Number(meta.chars) || 0) + ' 字 / ' + String(Number(meta.fileCount) || 0) + ' 份）' +
      '\n【体检缺项】\n' + list +
      (spec ? '\n【标称】' + spec : '') +
      '\n【正文材料】\n' + material.text
    const out = await packModelOnce(pick, { system, userText, maxTokens: 1600, usageSource: 'pack-playtest', sourceKind: 'game-desk-pack-playtest' })
    if (!out.ok) return out
    const parsed = parseJsonLoose(out.text)
    if (!parsed) return { ok: false, code: 502, error: '模型回包不是 JSON' }
    const pt = normalizePlaytest(parsed, pick.model, stamp, meta)
    // 模型要跑几十秒，期间抽取收尾可能整份重写 meta：写回前重读，只覆盖自己负责的 playtest
    const fresh = readPackMeta(root, folder) || meta
    fresh.playtest = pt
    if (!writePackMeta(root, folder, fresh)) return { ok: false, code: 500, error: 'meta-write-failed' }
    return { ok: true, folder, model: pick.model, playtest: pt, usage: out.usage }
  }

  /** 补全：一项一次模型调用（失败只影响一项），落 _ai_fill/<key>.md 并写 meta.aiFill；
   *  aiComplete 是派生量（missing 与 items 现算），不再写进 meta（2026-11-20 P1-4）。 */
  async function packFill(root, folder, keys) {
    const raw = Array.isArray(keys) ? keys.map((k) => String(k || '').trim()).filter((k) => k !== '') : []
    const uniq = []
    for (const k of raw) if (!uniq.includes(k)) uniq.push(k)
    if (uniq.length === 0) return { ok: false, code: 400, error: 'keys-required' }
    if (uniq.length > 3) return { ok: false, code: 400, error: 'too-many-keys' }
    const entry = scanRoot(root).find((c) => c.kind === 'pack' && c.folder === folder)
    if (!entry) return { ok: false, code: 404, error: 'pack-not-found' }
    let meta = readPackMeta(root, folder)
    if (!meta) meta = refreshPackMeta(root, folder, entry)
    if (!meta) return { ok: false, code: 422, error: 'no-text' }
    // 与 review 同口径：warn 也算缺项，只要在 meta.missing 里就允许补
    const missingAll = (Array.isArray(meta.missing) ? meta.missing : []).filter((m) => m && m.key)
    const byKey = new Map(missingAll.map((m) => [String(m.key), m]))
    if (uniq.some((k) => !byKey.has(k))) return { ok: false, code: 400, error: 'bad-key' }
    const material = packTextMaterial(root, folder)
    if (!material.text.trim()) return { ok: false, code: 422, error: 'no-text' }
    const pick = packLlm()
    if (pick.error) return { ok: false, code: 503, error: pick.error }
    const packDir = join(root, folder)
    const fillDir = join(packDir, '_ai_fill')
    const made = []
    const failed = []
    let usage = null
    for (const key of uniq) {
      const item = byKey.get(key)
      const system = [
        '你是剧本杀的排版员。下面给出一本剧本（资料夹版）的正文材料（每份只取开头与结尾）与一个「体检缺项」。',
        '请按这一项在原剧本里通常应有的格式，写一份可以直接放进本子的中文 markdown 正文。',
        '硬性要求：',
        '- 只写正文本身；不要复述要求，不要写「以下是我生成的」「希望有帮助」这类开场与收尾；',
        '- 不许编造与正文材料冲突的设定：人名、关系、时间线、凶案手法要与材料一致；材料没提到的地方保持通用、不要下断言；',
        '- 长度控制在 800–2500 字；',
        '- 如果这一项是「线索」，按条给（每条一小节，含编号与一句可读的线索文本），最多 30 条，总长仍不超过 2500 字；',
        '- 用中文 markdown：小标题用 ## / ###，列表用 -，不要放代码块。',
      ].join('\n')
      const userText = '【这一本】' + folder +
        '\n【要补的项】' + item.label + '（key=' + key + '）' +
        '\n【体检怎么说】' + (item.detail || '（没有更细的描述）') +
        '\n【正文材料（每份开头+结尾）】\n' + material.text
      const out = await packModelOnce(pick, { system, userText, maxTokens: 4000, usageSource: 'pack-fill', sourceKind: 'game-desk-pack-fill', timeoutMs: 180000 })
      if (!out.ok) { failed.push({ key, error: out.error || '模型没返回' }); continue }
      // 只剥掉模型偶尔自带的整段围栏，不动正文结构
      let body = out.text
      const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(body.trim())
      if (fence) body = fence[1].trim()
      const rel = '_ai_fill/' + aiFillKey(key) + '.md'
      const at = new Date().toISOString()
      const header = '# AI 补全：' + item.label + '\n' +
        '> 由 AI 生成，不是原稿；生成于 ' + at + '；依据 ' + material.files + ' 份文本。\n' +
        '> 想核对可对照原 PDF/图片；删掉本文件并把 pack-meta 的 aiFill 清掉即可撤销。'
      try {
        mkdirSync(fillDir, { recursive: true })
        writeFileSync(join(packDir, rel), header + '\n\n' + body + '\n', 'utf8')
      } catch (e) {
        failed.push({ key, error: '写文件失败：' + String(e && e.message ? e.message : e) })
        continue
      }
      made.push({ key, label: item.label, file: rel, chars: body.length })
      usage = mergeUsage(usage, out.usage)
    }
    // 2026-11-20（P2）：模型调用窗口里抽取收尾可能重写过 meta。写回前重读，只覆盖 aiFill 一项，
    // 其余（missing / checksSummary / review …）用新读到的，别拿旧快照盖掉。
    let aiComplete = false
    if (made.length) {
      const fresh = readPackMeta(root, folder) || meta
      const old = fresh.aiFill && typeof fresh.aiFill === 'object' ? fresh.aiFill : null
      const items = old && old.items && typeof old.items === 'object' ? { ...old.items } : {}
      const at = new Date().toISOString()
      for (const m of made) items[m.key] = { file: m.file, at, chars: m.chars }
      fresh.aiFill = { at, model: pick.model, items }
      // aiComplete 现算（P1-4）：拿刚重读的 missing 与 items 比，不再把它当状态字段写盘
      const missingNow = (Array.isArray(fresh.missing) ? fresh.missing : missingAll).filter((m) => m && m.key)
      aiComplete = missingNow.every((m) => Boolean(items[String(m.key)]))
      if (!writePackMeta(root, folder, fresh)) {
        return { ok: false, code: 500, error: 'meta-write-failed', made, failed, model: pick.model, usage, aiComplete }
      }
    }
    if (!made.length) return { ok: false, code: 502, error: '模型没返回', made, failed, model: pick.model, usage, aiComplete }
    return { ok: true, made, failed, model: pick.model, usage, aiComplete }
  }

  /** 撤销补全：删 _ai_fill 文件 + 从 meta.aiFill 摘掉，重算 aiComplete；不动原稿。 */
  async function packFillUndo(root, folder, keys) {
    const entry = scanRoot(root).find((c) => c.kind === 'pack' && c.folder === folder)
    if (!entry) return { ok: false, code: 404, error: 'pack-not-found' }
    const packDir = join(root, folder)
    const raw = Array.isArray(keys) ? keys.map((k) => String(k || '').trim()).filter((k) => k !== '') : []
    const wanted = raw.length ? Array.from(new Set(raw)) : null
    const meta = readPackMeta(root, folder)
    if (!meta) {
      // meta 没了也允许收尾：整目录删掉（只有插件会往这里写）
      if (!wanted) { try { rmSync(join(packDir, '_ai_fill'), { recursive: true, force: true }) } catch { /* 删不掉就留着 */ } }
      return { ok: true, removed: [] }
    }
    const old = meta.aiFill && typeof meta.aiFill === 'object' ? meta.aiFill : null
    const items0 = old && old.items && typeof old.items === 'object' ? { ...old.items } : {}
    const removed = []
    const dropOne = (key) => {
      const rel = String((items0[key] && items0[key].file) || '_ai_fill/' + aiFillKey(key) + '.md')
      // 只允许删 _ai_fill/ 下的文件，别让 meta 里的脏路径把别处删了
      if (rel.indexOf('_ai_fill/') === 0) {
        try { rmSync(join(packDir, rel), { force: true }) } catch { /* 删不掉也不报错，如实列进 removed */ }
        removed.push({ key, file: rel })
      }
      delete items0[key]
    }
    if (!wanted) {
      for (const key of Object.keys(items0)) dropOne(key)
      try { rmSync(join(packDir, '_ai_fill'), { recursive: true, force: true }) } catch { /* 同上 */ }
    } else {
      for (const key of wanted) dropOne(key)
    }
    // 2026-11-20（P2）：删文件之后重读 meta，只动 aiFill；aiComplete 不再落盘（派生量，P1-4）
    const fresh = readPackMeta(root, folder) || meta
    const freshOld = fresh.aiFill && typeof fresh.aiFill === 'object' ? fresh.aiFill : null
    const items = freshOld && freshOld.items && typeof freshOld.items === 'object' ? { ...freshOld.items } : {}
    for (const key of (wanted || Object.keys(items0))) delete items[key]
    const at = new Date().toISOString()
    fresh.aiFill = { at, model: freshOld ? String(freshOld.model || '') : (old ? String(old.model || '') : ''), items }
    if (!writePackMeta(root, folder, fresh)) return { ok: false, code: 500, error: 'meta-write-failed', removed }
    return { ok: true, removed }
  }

  /** 回包：状态码用内部的 code，但 body 里不塞 code —— 三条补全路由的字段是跟前端定死的，多一个都不给。 */
  function packReply(res, out) {
    const { code, ...body } = out
    return json(res, out.ok ? 200 : (code || 500), body)
  }

  /** 共用的请求派发：宿主回环路由与局域网服务都走这一份。 */
  const dispatch = async (req, res) => {
      const url = new URL(String(req.url ?? '/'), 'http://dsh.internal')
      const path = url.pathname
      const method = String(req.method ?? 'GET').toUpperCase()
      const blocked = gateFor(req, res, method, path, ctx.get('webStartup', false)?.trustedHosts)
      if (blocked) return json(res, blocked.code, { ok: false, error: blocked.error, room: blocked.room })
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
          const cases = withPackMeta(active, scanRoot(active))
          return json(res, 200, { ok: true, dir: active, roots, cases })
        }
        if (method === 'POST' && path === ROUTE + '/api/packs/meta') {
          // 一次性手动重算（用户 m01363 + m01367：不重跑抽取、不启 OCR）。
          // 只给「文本缓存里真有非空 txt」的资料夹补标签——没抽过字的跳过，绝不写空标签。
          // body 可空 = 当前书库全部；给 folder 就只算那一本；给 root 换书库。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const wanted = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(wanted)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const only = String(body.folder ?? '')
          const packs = scanRoot(wanted).filter((c) => c.kind === 'pack' && (only === '' || c.folder === only))
          const done = []
          const skipped = []
          for (const p of packs) {
            const meta = refreshPackMeta(wanted, p.folder, p)
            if (meta) {
              // 重算后的回包也带「算上 AI 补全」的派生口径（aiFill 已由 refreshPackMeta 保住）
              const d = withAiFillMeta(meta)
              done.push({
                folder: p.folder, players: meta.players, genre: meta.genre, pvp: meta.pvp,
                complete: meta.complete, missing: meta.missing.length,
                completeEffective: d.completeEffective,
                missingEffective: d.missingEffective.length,
                aiFilledKeys: d.aiFilledKeys,
              })
            } else skipped.push(p.folder)
          }
          return json(res, 200, { ok: true, dir: wanted, counted: done.length, skipped, metas: done })
        }
        if (method === 'GET' && path === ROUTE + '/api/packs/meta') {
          // 只读一本的体检标签，带 AI 补全派生的三项（aiFilledKeys / missingEffective / completeEffective）。
          // 参数走 query（?root=&folder=）；query 没给 folder 时再试一次 GET body {root, folder}，
          // 兼容习惯把参数塞 body 的调用方 —— 两边都没给就 400。
          let qRoot = url.searchParams.get('root') ?? ''
          let qFolder = url.searchParams.get('folder') ?? ''
          if (qFolder === '') {
            try {
              const b = await readBody(req)
              if (b && typeof b === 'object') {
                if (qRoot === '' && b.root !== undefined && b.root !== null) qRoot = String(b.root)
                if (b.folder !== undefined && b.folder !== null) qFolder = String(b.folder)
              }
            } catch { /* body 不是 JSON 就按 query 走 */ }
          }
          const roots = rootsFor(cfg)
          const wanted = qRoot !== '' ? resolve(qRoot) : roots[0]
          if (!roots.includes(wanted)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          if (qFolder === '') return json(res, 400, { ok: false, error: 'folder-required' })
          const meta = withAiFillMeta(readPackMeta(wanted, qFolder))
          return json(res, 200, { ok: true, root: wanted, folder: qFolder, meta })
        }
        if (method === 'POST' && path === ROUTE + '/api/packs/review') {
          // 体检说缺 ≠ 真缺：先让 AI 对着原文复核一遍再决定要不要补（用户 2026-11-19）。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const wanted = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(wanted)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '').trim()
          if (folder === '') return json(res, 400, { ok: false, error: 'folder-required' })
          const out = await packReview(wanted, folder)
          return packReply(res, out)
        }
        if (method === 'POST' && path === ROUTE + '/api/packs/playtest') {
          // 体检完让 AI 走一遍流程（用户 2026-11-20）：缺项不挡流程就算能玩；同一份材料不重复烧模型。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const wanted = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(wanted)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '').trim()
          if (folder === '') return json(res, 400, { ok: false, error: 'folder-required' })
          const out = await packPlaytest(wanted, folder, body.force === true)
          return packReply(res, out)
        }
        if (method === 'POST' && path === ROUTE + '/api/packs/fill') {
          // 真缺才补，一次最多 3 项（每项一次模型调用，控成本也控失败面）。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const wanted = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(wanted)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '').trim()
          if (folder === '') return json(res, 400, { ok: false, error: 'folder-required' })
          const out = await packFill(wanted, folder, body.keys)
          return packReply(res, out)
        }
        if (method === 'POST' && path === ROUTE + '/api/packs/fill/undo') {
          // 撤销：删 _ai_fill 下的生成件并摘账，原稿一个字节都不碰。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const wanted = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(wanted)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '').trim()
          if (folder === '') return json(res, 400, { ok: false, error: 'folder-required' })
          const out = await packFillUndo(wanted, folder, body.keys)
          return packReply(res, out)
        }
        if (method === 'GET' && path === ROUTE + '/api/case') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          // 2026-11-20 审计 C：folder 必须是库内真实条目（以前任意字符串都能进）
          const f = await checkLibraryFolder(res, active, folder)
          if (!f) return
          const hit = scanRoot(f.root).find((c) => c.folder === f.folder)
          if (!hit) return json(res, 404, { ok: false, error: 'case-not-found' })
          if (hit.kind === 'pack') {
            const store = readTextStore(f.root, f.folder)
            // 档案页要看体检/复核/补全状态，所以把 pack-meta 一起带上（读不到就给 null）；
            // 派生口径（aiFilledKeys / missingEffective / completeEffective）由 withAiFillMeta 统一挂。
            const meta = withAiFillMeta(readPackMeta(f.root, f.folder))
            return json(res, 200, { ok: true, case: { ...hit, meta, texts: store.files, textDir: store.dir } })
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
          // 2026-11-20 审计 C（实洞）：以前直接 join(active, folder)，folder='..\..' 就把 base
          // 挪到库的祖先目录，库外任意文件 200（实测 README.md 70314 字节）。现在先验条目。
          const f = await checkLibraryFolder(res, active, folder)
          if (!f) return
          return serveFile(res, join(f.root, f.folder), rel)
        }
        if (method === 'POST' && path === ROUTE + '/api/extract') {
          const roots = rootsFor(cfg)
          const body = await readBody(req)
          const active = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '')
          // 2026-11-20 审计 C：folder 必须是库内真实条目（以前只 existsSync，'..\..' 也能过）
          const f = await checkLibraryFolder(res, active, folder)
          if (!f) return
          if (!existsSync(join(f.root, f.folder))) return json(res, 404, { ok: false, error: 'case-not-found' })
          if (body.background === true) {
            // 长书（41 份扫描件都 OCR 过 10 分钟）不能同步等：HTTP 侧 5 分钟就会把连接掐了，
            // 掐断还会让 OCR 闸口名额漏放（2026-11-19 实测卡死）。后台跑 + 轮询 /api/extract/status。
            const st = startExtract(f.root, f.folder)
            return json(res, 202, { ok: true, started: st.state === 'running', root: f.root, folder: f.folder, extracting: st })
          }
          try {
            const out = await extractPack(f.root, f.folder)
            if (out.engineError) return json(res, 503, { ok: false, error: ocrErrorText(out.engineError), ...out })
            return json(res, 200, { ok: true, ...out })
          } catch (e) {
            return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
        }
        if (method === 'POST' && path === ROUTE + '/api/extract/cancel') {
          // 最小取消面：置 job.cancelled；抽取循环每份文件头检查，OCR 排队到名额后也检查，
          // 语义是「跑完当前这份就停」——正在 execFile 的子进程不硬杀（结果照常进缓存，不浪费）。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const active = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '')
          if (folder === '') return json(res, 400, { ok: false, error: '缺 folder' })
          const job = EXTRACT_JOBS.get(extractKey(active, folder))
          if (!job || job.state !== 'running') return json(res, 200, { ok: true, cancelled: false, state: job ? job.state : 'idle' })
          job.cancelled = true
          return json(res, 200, { ok: true, cancelled: true, state: 'running', note: '跑完当前文件即停' })
        }
        if (method === 'POST' && path === ROUTE + '/api/import/cancel') {
          // 同款取消面给导入：抽取阶段逐份检查同上；拷贝阶段是同步 copyTree，拦在中途做不到，
          // 但拷贝只有几十毫秒到几秒，可接受；抽完字还没拷贝时取消 = 整个不导。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const active = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '')
          if (folder === '') return json(res, 400, { ok: false, error: '缺 folder' })
          const job = IMPORT_JOBS.get(extractKey(active, folder))
          if (!job || job.state !== 'running') return json(res, 200, { ok: true, cancelled: false, state: job ? job.state : 'idle' })
          job.cancelled = true
          return json(res, 200, { ok: true, cancelled: true, state: 'running', note: '跑完当前文件即停' })
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
          // 2026-11-20 审计 C：folder 必须是库内真实条目。也正因为先验过，
          // 下面的 startExtract（会起 OCR、占闸口名额）才允许被这个请求触发。
          const f = await checkLibraryFolder(res, active, folder)
          if (!f) return
          const dir = join(f.root, f.folder)
          if (!existsSync(dir)) return json(res, 404, { ok: false, error: 'case-not-found' })
          if (existsSync(join(dir, 'case.yml'))) {
            const hit = scanRoot(f.root).find((c) => c.folder === f.folder)
            return json(res, 200, { ok: true, screen: { folder: f.folder, title: hit ? hit.title : f.folder, verdict: 'ready', checks: [], spec: {}, chars: 0, fileCount: 0, already: 'case' } })
          }
          const pack = packEntry(f.folder, dir, walkFiles(dir))
          let store = readTextStore(f.root, f.folder)
          let extracting = extractStatus(f.root, f.folder)
          if (store.files.length === 0 && (pack.counts.pdf > 0 || pack.counts.text > 0)) {
            extracting = startExtract(f.root, f.folder)
          }
          // 体检要认 AI 补全（用户 2026-11-19「补全的项目在体检处也要打上标记」）：
          // 命中项判过（level→ok）并挂 ai / aiChars / aiAt，verdict 与 checksSummary 一起重算。
          // 2026-11-20 AI 试玩：体检回包顺带带上 playtest（没有就是 null，stale 表示材料已变）。
          const meta = readPackMeta(f.root, f.folder)
          const screen = attachPlaytest(applyAiFillToScreen(screenPack(f.root, f.folder, pack, store), meta), meta)
          return json(res, 200, { ok: true, screen, extracting })
        }
        if (method === 'POST' && path === ROUTE + '/api/import') {
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const active = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = String(body.folder ?? '')
          if (folder === '') return json(res, 400, { ok: false, error: '缺 folder' })
          // 2026-11-20 审计 C：folder 必须是库内真实条目（importPack 里 join(root,folder) 会落盘）
          const f = await checkLibraryFolder(res, active, folder)
          if (!f) return
          if (body.wait === true) {
            const out = await importPack(cfg, f.root, f.folder, { force: body.force === true })
            return json(res, out.ok ? 200 : (out.code || 500), out)
          }
          const status = startImport(cfg, f.root, f.folder, { force: body.force === true })
          return json(res, 202, { ok: true, started: status.state === 'running', status })
        }
        if (method === 'GET' && path === ROUTE + '/api/usage') {
          return json(res, 200, { ok: true, today: todayModelUsage(), remote: remoteInfo() })
        }
        if (method === 'GET' && path === ROUTE + '/api/ocr') {
          return json(res, 200, { ok: true, ocr: ocrSnapshot() })
        }
        if (method === 'POST' && path === ROUTE + '/api/ocr') {
          // 两个开关都在这儿：parallel = 并行闸；engine = 手动切引擎（auto 回默认 rapid-cuda、
          // rapid 切 CPU、vl 走 VL、off 关 OCR）。写 settings.json，重载/重启后仍然生效。
          const body = await readBody(req)
          if (typeof body.parallel === 'boolean') {
            OCR_GATE.parallel = body.parallel
            writeSettings({ ocrParallel: body.parallel })
          }
          if (typeof body.engine === 'string' && body.engine.trim() !== '') {
            const wantEng = body.engine.trim().toLowerCase()
            const okEngines = ['auto', 'rapid-cuda', 'rapid', 'paddle', 'vl', 'off']
            if (!okEngines.includes(wantEng)) return json(res, 400, { ok: false, error: 'engine 只能是 ' + okEngines.join(' / ') })
            writeSettings({ ocrEngine: wantEng })
            ocrClearEngineError() // 用户手动改引擎 = 一次显式重试，清掉上次记下的「CUDA 起不来」
            console.info('[game-desk] OCR 引擎切到 ' + wantEng + '（实际生效：' + resolveOcrEngine() + '）')
          }
          return json(res, 200, { ok: true, ocr: ocrSnapshot() })
        }
          if (method === 'GET' && path === ROUTE + '/api/import/status') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          if (folder === '') {
            // 不带 folder = 全局查询：页面关掉再进来时用它找回正在跑的导入。
            // 优先 running（多个取 startedAt 最新）；没有 running 则看 3 分钟内收尾的 done/error，让前端知道「刚导完」。
            let pick = null
            for (const [key, job] of IMPORT_JOBS) {
              if (job.state !== 'running') continue
              if (!pick || (job.startedAt || 0) > (pick.job.startedAt || 0)) pick = { key, job }
            }
            if (!pick) {
              const cutoff = Date.now() - 3 * 60 * 1000
              for (const [key, job] of IMPORT_JOBS) {
                if (job.state !== 'done' && job.state !== 'error') continue
                if (!job.endedAt || job.endedAt < cutoff) continue
                if (!pick || job.endedAt > pick.job.endedAt) pick = { key, job }
              }
            }
            if (!pick) return json(res, 200, { ok: true, importing: { state: 'idle' } })
            // key = root|folder；Windows 路径不含 '|'，按最后一个 '|' 拆即可。
            const bar = pick.key.lastIndexOf('|')
            const jobRoot = bar >= 0 ? pick.key.slice(0, bar) : pick.key
            const jobFolder = bar >= 0 ? pick.key.slice(bar + 1) : ''
            return json(res, 200, { ok: true, importing: importStatus(jobRoot, jobFolder), job: { root: jobRoot, folder: jobFolder }, ocr: ocrSnapshot() })
          }
          return json(res, 200, { ok: true, importing: importStatus(active, folder), ocr: ocrSnapshot() })
        }
        if (method === 'GET' && path === ROUTE + '/api/text') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          const rel = url.searchParams.get('rel') ?? ''
          // 2026-11-20 审计 C：文本库的键是 sha1(root|folder)，folder 决定读哪一份 ⇒ 必须是库内条目
          const f = await checkLibraryFolder(res, active, folder)
          if (!f) return
          const store = readTextStore(f.root, f.folder)
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
        if (method === 'GET' && path === ROUTE + '/api/script') {
          // 人物剧本按幕开放（用户 m00504）：只给「当前第 N 幕」的页；切不开发 split:false，前端退回整份。
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          const rel = url.searchParams.get('rel') ?? ''
          if (folder === '' || rel === '') return json(res, 400, { ok: false, error: 'folder/rel 必填' })
          const f = await checkLibraryFolder(res, active, folder)
          if (!f) return
          const out = await scriptInfo(f.root, f.folder, rel, url.searchParams.get('act'))
          return json(res, out.ok ? 200 : (out.code || 500), out)
        }
        if (method === 'GET' && path === ROUTE + '/api/page') {
          // 剧本页图（每页一张 PNG）。缓存两件事：PDF 的 mtime（原文件被替换就整目录重渲）+ DPI。
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const folder = url.searchParams.get('folder') ?? ''
          const rel = url.searchParams.get('rel') ?? ''
          const page = Math.floor(Number(url.searchParams.get('page')) || 0)
          if (folder === '' || rel === '' || page < 1) return json(res, 400, { ok: false, error: 'folder/rel/page 必填' })
          const f = await checkLibraryFolder(res, active, folder)
          if (!f) return
          const caseDir = join(f.root, f.folder)
          const abs = insideCaseDir(caseDir, rel)
          if (!abs || !existsSync(abs)) return json(res, 404, { ok: false, error: 'not-found' })
          if (extname(abs).toLowerCase() !== '.pdf') return json(res, 400, { ok: false, error: 'only-pdf' })
          let mtime = 0
          try { mtime = statSync(abs).mtimeMs } catch { return json(res, 404, { ok: false, error: 'not-found' }) }
          const outdir = pageCacheDir(f.root, f.folder, rel)
          const stampFile = join(outdir, 'src.json')
          let stamp = null
          try { stamp = JSON.parse(readFileSync(stampFile, 'utf8')) } catch { stamp = null }
          if (!stamp || stamp.mtime !== mtime || stamp.dpi !== SCRIPT_DPI || stamp.fmt !== SCRIPT_FMT) {
            try { rmSync(outdir, { recursive: true, force: true }) } catch { /* 删不掉就让下面重渲 */ }
          }
          try { mkdirSync(outdir, { recursive: true }) } catch { /* 建不出来下面渲染会报 */ }
          const file = join(outdir, 'p' + page + '.' + SCRIPT_FMT)
          if (!existsSync(file)) {
            let out = null
            try {
              out = await renderPdfPages(abs, outdir, [page])
            } catch (e) {
              out = { ok: false, error: String(e && e.message ? e.message : e) }
            }
            if (!out || !out.ok) {
              return json(res, 503, { ok: false, error: '页面渲染失败：' + String((out && out.error) || '未知'), page })
            }
            if (!existsSync(file)) return json(res, 404, { ok: false, error: 'page-out-of-range', page })
            try { writeFileSync(stampFile, JSON.stringify({ mtime, dpi: SCRIPT_DPI, fmt: SCRIPT_FMT, at: Date.now() }), 'utf8') } catch { /* 缓存记账失败不影响这页 */ }
          }
          try {
            const buf = readFileSync(file)
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' })
            res.end(buf)
          } catch (e) {
            json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
          }
          return
        }
        if (method === 'GET' && path === ROUTE + '/api/flow') {
          // 带本流程大纲（用户 m00610）：读缓存；stale = 资料变了（改了本子/补了手册），提示重生成。
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const f = await checkLibraryFolder(res, active, url.searchParams.get('folder') ?? '')
          if (!f) return
          const rec = readFlowCache(f.root, f.folder)
          if (!rec) return json(res, 200, { ok: true, flow: null })
          let stale = false
          try { stale = flowMaterial(f.root, f.folder).stamp !== rec.stamp } catch { stale = false }
          return json(res, 200, { ok: true, flow: rec.flow, at: rec.at, model: rec.model, title: rec.title, stale })
        }
        if (method === 'POST' && path === ROUTE + '/api/flow') {
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const active = String(body.root ?? '') !== '' ? resolve(String(body.root)) : roots[0]
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const f = await checkLibraryFolder(res, active, String(body.folder ?? ''))
          if (!f) return
          const out = await flowAsk(ctx, f.root, f.folder, { force: body.force === true })
          return json(res, out.ok ? 200 : (out.code || 500), out)
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
          // 2026-11-20 审计 C：目录名只许普通名字（判据同 /api/arcade/delete），
          // 且最终 dir 必须落在 targetRoot 里 —— 否则 folder='..\..' 能把本子写到库外。
          if (!/^[^./\\][^/\\]{0,79}$/.test(folder)) return json(res, 400, { ok: false, error: 'folder-not-allowed' })
          if (usedFolders.has(folder)) return json(res, 409, { ok: false, error: '同名目录已存在：' + folder, folder })
          const dir = join(targetRoot, folder)
          if (!resolve(dir).startsWith(resolve(targetRoot) + sep)) return json(res, 400, { ok: false, error: 'folder-not-allowed' })
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
        if (method === 'POST' && path === ROUTE + '/api/case/ocr') {
          // 识图补齐：抽不出字的扫描件用本机 OCR 再认一遍（机主面，公网 403）。202 起后台，轮询 status。
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const targetRoot = String(body.root ?? '') !== '' ? resolve(String(body.root)) : root
          if (!roots.includes(targetRoot)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          // 2026-11-20 审计 C：folder 必须是库内条目（body.rels 的越界过滤在 startCaseOcr 里）
          const f = await checkLibraryFolder(res, targetRoot, String(body.folder ?? ''))
          if (!f) return
          const out = startCaseOcr(f.root, f.folder, body)
          if (!out.ok) return json(res, out.code || 500, out)
          const note = out.engineError ? ocrErrorText(out.engineError)
            : (out.engine === 'vl' ? 'vl 与 ComfyUI 生图显存互斥，大概率 exit 4，先停生图'
              : (out.engine === 'rapid-cuda' ? 'rapid-cuda 走 GPU；生图模型驻留显存时可能 exit 4（会报 cuda-unavailable 并停下，不回落 CPU）'
                : (out.engine === 'paddle' ? 'paddle 走 GPU（默认档）；生图模型驻留显存时可能 OOM，先停生图'
                  : 'CPU 档（settings.ocrEngine=rapid）')))
          return json(res, 202, { ...out, note })
        }
        if (method === 'GET' && path === ROUTE + '/api/case/ocr/status') {
          const roots = rootsFor(cfg)
          const wanted = url.searchParams.get('root') ?? ''
          const active = wanted !== '' ? resolve(wanted) : root
          if (!roots.includes(active)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          return json(res, 200, caseOcrStatus(active, url.searchParams.get('folder') ?? ''))
        }
        if (method === 'POST' && path === ROUTE + '/api/case/ocr/cancel') {
          const body = await readBody(req)
          const roots = rootsFor(cfg)
          const targetRoot = String(body.root ?? '') !== '' ? resolve(String(body.root)) : root
          if (!roots.includes(targetRoot)) return json(res, 403, { ok: false, error: 'root-not-allowed' })
          const job = CASE_OCR_JOBS.get(join(targetRoot, String(body.folder ?? '')))
          if (!job || job.state !== 'running') return json(res, 404, { ok: false, error: 'no-running-job' })
          job.cancelled = true
          return json(res, 200, { ok: true, state: 'cancelling' })
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
          // 2026-11-20 审计 C：folder 决定 dmContext 读哪一本（join(root,folder)）⇒ 必须是库内条目；
          // 正在开局的那一本（ROOM.caseFolder）例外，房主/客人都得能接着问。
          const dmFolder = String(body.folder ?? '').trim()
          let dmRoot = active
          if (dmFolder !== '' && dmFolder !== String(ROOM.caseFolder || '')) {
            const f = await checkLibraryFolder(res, active, dmFolder)
            if (!f) return
            dmRoot = f.root
          }
          const out = await dmAsk(ctx, { ...body, root: dmRoot, folder: dmFolder })
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
        if (method === 'POST' && path === ROUTE + '/api/xgame/clues') {
          // 重大线索卡：纯读盘（truth × state），零模型调用；灰卡 text 恒 null 防泄底。
          // 一律 200：no-game/no-map 也要把 JSON 送回前端，让它清掉卡片区而不是留旧卡。
          const body = await readBody(req)
          const sid = pickSid(body)
          if (!sid) return json(res, 400, { ok: false, error: 'scheme 不合法' })
          return json(res, 200, xgameClues(sid, body.scheme))
        }
        if (method === 'POST' && path === ROUTE + '/api/xgame/hints') {
          // 提示：这局现在能深查 / 能勘查 / 能问 / 能去哪。纯读盘（truth × state），零模型调用。
          // 回包只有名字（地点/NPC/物件/顾问），真相正文一律不出现；没有对局回 no-game，前端只认 ok:false。
          // 一律 200：no-game 也要把 JSON 送回去，让前端把「提示取不到」清掉。
          const body = await readBody(req)
          const sid = pickSid(body)
          if (!sid) return json(res, 400, { ok: false, error: 'scheme 不合法' })
          return json(res, 200, xgameHints(sid, body.scheme))
        }
        if (method === 'POST' && path === ROUTE + '/api/xgame/unlock') {
          const body = await readBody(req)
          const sid = pickSid(body)
          if (!sid) return json(res, 400, { ok: false, error: 'scheme 不合法' })
          const out = xgameUnlock(sid, body.scheme)
          if (out.ok) return json(res, 200, out)
          return json(res, out.error === 'clues-not-complete' ? 409 : 404, out)
        }
        if (method === 'GET' && path === ROUTE + '/api/arcade') {
          // 游戏厅 · 外来内容库清单（公网访客也能列，读不了管理面）
          return json(res, 200, { ok: true, items: scanArcade() })
        }
        if (method === 'POST' && path === ROUTE + '/api/arcade') {
          // 导入内容：{root, folder, scheme, title?}。抽字要先行（peek 链在跑）。
          const body = await readBody(req)
          // 手写导入（2026-11-20）：没有 folder、带正文 text 的请求走这条，不碰资料夹也不抽字；
          // 老请求体一定带 folder，所以下面那条链路的行为一字不改。
          if (body.folder === undefined && typeof body.text === 'string') {
            const hand = arcadeCreateHand(body)
            return json(res, hand.ok ? 200 : (hand.code || 500), hand)
          }
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
        if (method === 'POST' && path === ROUTE + '/api/arcade/auto') {
          // 自动整理导入：一份内容一个子资料夹的资料夹 → 自动识文字 + 拆成一篇一条目（202 起后台任务）
          const body = await readBody(req)
          const out = startArcadeAuto(body.root, body.folder, body.scheme)
          return json(res, out.ok ? 202 : (out.code || 400), out)
        }
        if (path === ROUTE + '/api/arcade/auto/status' && method === 'GET') {
          return json(res, 200, { ok: true, auto: arcadeAutoStatus() })
        }
        if (method === 'POST' && path === ROUTE + '/api/arcade/random') {
          // 随机挑一篇：按玩法从内容库里随机取一条（「每次重开换一篇」用）
          const body = await readBody(req)
          const scheme = String(body.scheme || '')
          let pool = scanArcade()
          if (scheme && SCHEME_IDS.has(scheme)) pool = pool.filter((x) => x.scheme === scheme)
          if (!pool.length) return json(res, 404, { ok: false, error: '内容库里还没有这一类的条目' })
          const pick = pool[Math.floor(Math.random() * pool.length)]
          return json(res, 200, { ok: true, entry: pick, pool: pool.length })
        }
        if (method === 'POST' && path === ROUTE + '/api/arcade/split') {
          const body = await readBody(req)
          const out = arcadeSplit(body)
          return json(res, out.ok ? 200 : (out.code || 400), out)
        }
        if (method === 'POST' && path === ROUTE + '/api/arcade/ask') {
          // 材料局主持人：按资料开局的模型主持；公网流量在这道闸上受 remoteMode 管制。
          const body = await readBody(req)
          const out = await arcadeAsk(ctx, body)
          return json(res, out.ok ? 200 : (out.code || 500), out)
        }
        if (path === ROUTE + '/api/room/beat' && method === 'POST') {
          // 心跳不设闸：在场记录本身不花钱，公网访客也必须打得进来
          const body = await readBody(req)
          const out = roomBeat(body, viaOf(req, ctx.get('webStartup', false)?.trustedHosts))
          return json(res, out.ok ? 200 : (out.code || 500), out)
        }
        if (path === ROUTE + '/api/room' && method === 'GET') {
          return json(res, 200, { ok: true, room: roomSnapshot(viaOf(req, ctx.get('webStartup', false)?.trustedHosts)) })
        }
        if (path === ROUTE + '/api/room/force' && method === 'POST') {
          const hostsR = ctx.get('webStartup', false)?.trustedHosts
          if (!trusted(req, hostsR)) return json(res, 403, { ok: false, error: 'room-force-host-only' })
          ROOM.force = true
          return json(res, 200, { ok: true, room: roomSnapshot(viaOf(req, hostsR)) })
        }
        // 座位三条路由都不设闸：和 /api/room/beat 同理 —— 认领座位不花模型钱，公网/局域网访客必须打得进来。
        if (path === ROUTE + '/api/seats' && method === 'GET') {
          const root = url.searchParams.get('root') || ''
          const folder = url.searchParams.get('folder') || ''
          const who = url.searchParams.get('who') || ''
          // touch=true：页面轮询顺带给自家席位续期
          return json(res, 200, { ok: true, seats: seatsOf(root, folder, who, true) })
        }
        if (path === ROUTE + '/api/seats/claim' && method === 'POST') {
          const body = await readBody(req)
          const out = seatClaim(body, viaOf(req, ctx.get('webStartup', false)?.trustedHosts))
          return json(res, out.ok ? 200 : (out.code || 500), out)
        }
        if (path === ROUTE + '/api/seats/release' && method === 'POST') {
          const body = await readBody(req)
          // 2026-11-20 审计 D：把「本次来源」交给 seatRelease —— 客人只能放掉自己来源的席位。
          const out = seatRelease(body, viaOf(req, ctx.get('webStartup', false)?.trustedHosts))
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
        // 显式标来源（2026-11-20 审计 A）：dispatch 的 trusted()/viaOf() 优先读这个标记，
        // 不再靠客户端可伪造的 Host —— 局域网设备发 Host: 127.0.0.1 也不会被判成本机。
        req.__via = viaTunnel ? 'remote' : 'lan'
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
  // attempts = 已经失败过几次（也决定下一次换哪条协议）；want = 用户要它开着，自动重试只跟着这个走
  const TUNNEL = {
    child: null, url: '', error: '', starting: false,
    attempts: 0, tried: 0, want: false, protocol: '', retryAt: 0, retryTimer: null, errorKind: '', detail: '', round: 0,
  }
  const TUNNEL_TRIES = 4                      // 点一次「开房」最多连 4 次
  const TUNNEL_BACKOFF = [2000, 5000, 10000]  // 每次失败后隔多久再连
  const TUNNEL_TRY_MS = 25000                 // 单次给 25 秒（正常 2–4 秒就拿到地址）
  // 一整轮（4 次）都撞在坏窗口里也是可能的：2026-11-20 用户点一次报错、隔一分钟手动再点就好。
  // 所以「点一次」= 最多 3 轮，轮间歇 30 秒，总共约 3 分钟；用户关掉或成功就停。
  const TUNNEL_ROUNDS = 3
  const TUNNEL_ROUND_GAP = 30000

  // quick tunnel 每次启动都要先 POST https://api.trycloudflare.com/tunnel 换一个随机域名。这条请求偶尔会撞上
  // Cloudflare 侧十几秒不应答（cloudflared 自己的 HTTP 客户端先超时），报出来的就是
  // 「failed to request quick Tunnel: ... context deadline exceeded」——不是这台机器出不去公网：
  // 2026-11-20 实测同一时刻 curl 打这个端点 3/3 都是 200（3.5–4.5 秒），三种协议各起一条隧道也都在 2 秒内连上。
  // 能治的只有两件事：多试几次，以及每次换一条路。
  // 第 1 次默认（QUIC）→ 第 2 次 --protocol http2（UDP 7844 被掐时 QUIC 会一直卡在连边）
  // → 第 3 次起再钉 --edge-ip-version 4（有 AAAA 但走不通的网络会耗在 happy eyeballs 上）。
  function tunnelArgs() {
    const args = ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + LAN.port, '--retries', '10']
    // tried = 「这一次是第几次尝试」（从 1 起）：第 2 次换 HTTP/2，第 3 次起再钉 IPv4
    if (TUNNEL.tried >= 2) args.push('--protocol', 'http2')
    if (TUNNEL.tried >= 3) args.push('--edge-ip-version', '4')
    return args
  }

  function quickUrl(text) {
    const all = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g) || []
    for (const u of all) {
      if (/^https:\/\/api\./.test(u) || /^https:\/\/www\./.test(u)) continue
      return u
    }
    return ''
  }

  function tunnelKind(why, exitCode) {
    const s = String(why || '')
    if (/context deadline exceeded|Client\.Timeout|awaiting headers|TLS handshake timeout/i.test(s)) return 'api-timeout'
    if (/network is unreachable|no such host|i\/o timeout|dial tcp/i.test(s)) return 'no-network'
    if (/quic|edge|handshake|connection/i.test(s)) return 'edge-fail'
    return 'exited-' + String(exitCode)
  }

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
      errorKind: TUNNEL.errorKind,
      detail: TUNNEL.detail,
      // 重试窗口：starting=false 但 retrying=true 表示「上一次没成，正等着下一跳」——前端要当忙态处理
      retrying: !!(TUNNEL.want && !TUNNEL.child && !TUNNEL.starting && TUNNEL.retryAt > 0),
      retryInMs: TUNNEL.retryAt ? Math.max(0, TUNNEL.retryAt - Date.now()) : 0,
      attempts: TUNNEL.attempts,
      tryNo: TUNNEL.tried,
      round: TUNNEL.round,
      rounds: TUNNEL_ROUNDS,
      tries: TUNNEL_TRIES,
      protocol: TUNNEL.protocol,
      remoteKey: rk,
      link: TUNNEL.url ? TUNNEL.url + ROUTE + '/app/?k=' + rk : '',
      room: roomSnapshot(),
    }
  }

  function stopTunnel() {
    TUNNEL.want = false
    if (TUNNEL.retryTimer) { clearTimeout(TUNNEL.retryTimer); TUNNEL.retryTimer = null }
    TUNNEL.retryAt = 0
    if (TUNNEL.child) { try { TUNNEL.child.kill() } catch { /* 杀不掉就算了 */ } }
    TUNNEL.child = null
    TUNNEL.url = ''
    TUNNEL.starting = false
    TUNNEL.attempts = 0
    TUNNEL.tried = 0
    TUNNEL.protocol = ''
    TUNNEL.round = 0
  }

  function startTunnel(auto) {
    if (TUNNEL.child || TUNNEL.starting) return tunnelStatus()
    if (!auto) {
      TUNNEL.attempts = 0
      TUNNEL.tried = 0
      TUNNEL.round = 0
      TUNNEL.want = true
      TUNNEL.retryAt = 0
      TUNNEL.error = ''
      TUNNEL.detail = ''
      TUNNEL.errorKind = ''
      ROOM.force = false
      ROOM.autoClosedAt = 0
    }
    if (!TUNNEL.want) return tunnelStatus()
    if (!LAN.server) {
      try { startLan() } catch { /* 起不来下面报错 */ }
      if (!LAN.server) { TUNNEL.error = 'lan-not-running'; return tunnelStatus() }
    }
    if (TUNNEL.retryTimer) { clearTimeout(TUNNEL.retryTimer); TUNNEL.retryTimer = null }
    TUNNEL.retryAt = 0
    TUNNEL.error = ''
    TUNNEL.detail = ''
    TUNNEL.errorKind = ''
    TUNNEL.starting = true
    TUNNEL.tried = Number(TUNNEL.tried || 0) + 1
    TUNNEL.attempts = Math.max(0, TUNNEL.tried - 1)
    TUNNEL.protocol = TUNNEL.tried >= 2 ? 'http2' : 'quic'
    let child
    try {
      child = spawn(tunnelExe(), tunnelArgs(), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      TUNNEL.starting = false
      TUNNEL.error = String(e && e.message ? e.message : e)
      return tunnelStatus()
    }
    TUNNEL.child = child
    // cloudflared 报错时也会写 https://api.trycloudflare.com/tunnel —— 那是「换域名」的接口地址，不是隧道。
    // 旧正则只看 *.trycloudflare.com，一撞上这句报错就当「隧道已就绪」：url 被塞成 api 域名、重试计数被清零，
    // 于是永久停在第一次尝试（2026-11-20 实测：三次 spawn 全是 quic，报错一闪就被「成功」覆盖）。
    const onData = (d) => {
      const u = quickUrl(d)
      if (u && !TUNNEL.url) {
        TUNNEL.url = u
        TUNNEL.starting = false
        TUNNEL.tried = 0
        TUNNEL.attempts = 0
        TUNNEL.round = 0
        TUNNEL.error = ''
        TUNNEL.detail = ''
        TUNNEL.errorKind = ''
      }
    }
    let errTail = ''
    const onErr = (d) => { errTail = (errTail + String(d)).slice(-600); onData(d) }
    child.stdout.on('data', onData)
    child.stderr.on('data', onErr)
    child.on('error', (e) => {
      if (TUNNEL.child === child) {
        TUNNEL.child = null; TUNNEL.url = ''; TUNNEL.starting = false
        TUNNEL.error = e && e.code === 'ENOENT' ? 'cloudflared-not-installed' : String(e && e.message ? e.message : e)
      }
    })
    child.on('exit', (code) => { tunnelDown(child, errTail, code) })
    setTimeout(() => {
      if (TUNNEL.child === child && TUNNEL.starting) tunnelDown(child, '', 'timeout')
    }, TUNNEL_TRY_MS)
    return tunnelStatus()
  }

  // 一条隧道退下来的统一出口：记错误、决定还试不试、隔多久、换哪条协议。
  // 旧版只重试一次、且 exit 后立刻把错误写给页面 —— 用户看到的是「报错 + 再也不动」。
  function tunnelDown(child, errTail, exitCode) {
    if (TUNNEL.child !== child) return
    try { child.kill() } catch { /* 可能已经自己退了 */ }
    TUNNEL.child = null
    TUNNEL.url = ''
    TUNNEL.starting = false
    TUNNEL.protocol = ''
    if (exitCode === 'timeout') {
      TUNNEL.error = 'tunnel-timeout'
      TUNNEL.errorKind = 'timeout'
      TUNNEL.detail = ''
    } else {
      const last = String(errTail || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(-1)[0] || ''
      TUNNEL.errorKind = exitCode === 0 ? 'closed' : tunnelKind(last, exitCode)
      TUNNEL.error = exitCode === 0
        ? 'tunnel-closed'
        : 'cloudflared-exited-' + String(exitCode) + (last ? '：' + last.slice(0, 200) : '')
      TUNNEL.detail = last.slice(0, 400)
    }
    if (!TUNNEL.want) { TUNNEL.attempts = 0; TUNNEL.tried = 0; TUNNEL.round = 0; TUNNEL.retryAt = 0; return }
    // 次数由 startTunnel 在每次拉起时累加（tried），这里只看还有没有额度 —— 不再依赖「失败次数」自己数
    if (TUNNEL.tried < TUNNEL_TRIES) {
      const wait = TUNNEL_BACKOFF[Math.min(Math.max(0, TUNNEL.tried - 1), TUNNEL_BACKOFF.length - 1)]
      retryTunnelLater(wait)
      return
    }
    // 一轮用完了：只要用户还开着，就再来一轮（清零本次轮的次数，保留错误给页面看）
    if (Number(TUNNEL.round || 0) < TUNNEL_ROUNDS - 1) {
      TUNNEL.round = Number(TUNNEL.round || 0) + 1
      TUNNEL.tried = 0
      retryTunnelLater(TUNNEL_ROUND_GAP)
      return
    }
    TUNNEL.retryAt = 0
  }

  // 隔 wait 毫秒再拉起一次；wait 由调用方决定（轮内退避 / 轮间 30 秒）
  function retryTunnelLater(wait) {
    TUNNEL.retryAt = Date.now() + wait
    if (TUNNEL.retryTimer) clearTimeout(TUNNEL.retryTimer)
    TUNNEL.retryTimer = setTimeout(() => {
      TUNNEL.retryTimer = null
      TUNNEL.retryAt = 0
      if (TUNNEL.want) startTunnel(true)
    }, wait)
    if (TUNNEL.retryTimer.unref) TUNNEL.retryTimer.unref()
  }

  ctx.effect(() => () => stopTunnel(), 'dsh-game-desk: tunnel stop')

  // 房间层接线：经这个 ref 读隧道、关隧道；巡检 20 秒一轮（任务4：全员离场自动关房）
  // 重试间隙（retrying）也算「房间在」，否则房间快照会闪成 idle、巡检还可能把正在重连的隧道关掉
  ROOM.ref = { running: () => !!TUNNEL.child || !!TUNNEL.starting || !!(TUNNEL.want && TUNNEL.retryAt > 0), stop: stopTunnel }
  const ROOM_TIMER = setInterval(roomSweep, 20000)
  ctx.effect(() => () => { clearInterval(ROOM_TIMER); ROOM.ref = null }, 'dsh-game-desk: room sweep')


  bootStatus('route-registered', { root })
  console.info('[game-desk] 案卷台已挂载：' + ROUTE + '/app ，本子库 ' + root)
}