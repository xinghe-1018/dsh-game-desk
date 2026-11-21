/* 对局室：不开新会话，就在这一页把本子铺开（座位 / 正文 / 线索 / 笔记）。
   数据全部来自 /api/case 已经取回的那份对象，状态存 localStorage。
   浏览器原生 ES module：末尾仍写 window.GameTable 兼容垫片，app.js 一行都不用改。 */

var API = '/game-desk/api'
var KEY = 'gd:table:'
var S = null          // { root, folder, act, dealt: [], note, t0, seat, tab }
var M = null          // 本子的桌面上摆法
var tick = null

function $(id) { return document.getElementById(id) }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] }) }
function enc(s) { return encodeURIComponent(String(s == null ? '' : s)) }
function strip(rel) { return String(rel || '').replace(/^_source\//, '') }
function baseName(rel) { var s = strip(rel); var i = s.lastIndexOf('/'); var b = i >= 0 ? s.slice(i + 1) : s; return b.replace(/\.[^.]+$/, '') }
function groupOf(rel) { var s = strip(rel); var i = s.indexOf('/'); return i > 0 ? s.slice(0, i) : '' }
function isPdf(f) { return /\.pdf$/i.test(String(f.rel)) }
function isImg(f) { return f.kind === 'image' || /\.(png|jpe?g|webp|gif)$/i.test(String(f.rel)) }
function isTextFile(f) { return /\.(md|markdown|txt|csv|json|ya?ml)$/i.test(String(f.rel)) }

function fileUrl(rel) {
  return API + '/file?root=' + enc(S.root) + '&folder=' + enc(S.folder) + '&rel=' + enc(rel)
}
function textUrl(rel) {
  return API + '/text?root=' + enc(S.root) + '&folder=' + enc(S.folder) + '&rel=' + enc(rel)
}
function getText(url) {
  return fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null }).catch(function () { return null })
}

/* 对局页里的错误码 → 玩家读得懂的一句话（与 arcade.js 顶部那张表同风格）。
   宿主/引擎回的是 remote-quota / room-idle 这种英文码，原样摆上来等于没说话；
   认不出的码也不直接丢出去 —— 统一包成「未知错误（码）」，码留着排障。 */
var ROOM_ERRS = {
  'room-idle': '房主还没开局',
  'room-waiting': '人还没到齐（或有人刚掉线）',
  'remote-off': '房主没开公网房间',
  'remote-quota': '今天的公网额度用完了',
  'remote-owner-only': '这一手只能房主来做',
  'no-game': '这一局还没开局',
  'no-text': '这本还没抽出文字',
  'forbidden': '没有权限',
}
function roomErr(code) {
  if (code == null || code === '') return '未知错误'
  if (typeof code === 'object') return '未知错误'      // j.error 偶尔是对象：别拼出 [object Object]
  var k = String(code)
  return ROOM_ERRS[k] || ('未知错误（' + k + '）')
}

/* ---------- 把本子读成「桌上该摆什么」 ---------- */
function buildModel(c) {
  var files = (c.files || []).slice(0)
  var roles = c.roles || []
  var seats = []
  if (roles.length) {
    seats = roles.map(function (r) {
      return { name: String(r.name || r.id || ''), meta: r.player === 'human' ? '你' : 'AI', role: r }
    })
  } else {
    files.forEach(function (f) {
      var g = groupOf(f.rel)
      if (!/人物|角色|剧本|剧本本/.test(g)) return
      if (!/\.(pdf|docx?|txt|md)$/i.test(String(f.rel))) return
      seats.push({ name: baseName(f.rel), meta: '' })
    })
  }
  function pickScript(s) {
    var name = s && s.name ? String(s.name) : ''
    var rid = s && s.role && s.role.id ? String(s.role.id) : ''
    if (!name && !rid) return null
    var hit = null
    files.forEach(function (f) {
      if (isImg(f) || /线索|clue/i.test(strip(f.rel))) return
      var bn = baseName(f.rel).toLowerCase()
      var ok = (name && baseName(f.rel).indexOf(name) >= 0) || (rid && bn.indexOf(rid.toLowerCase()) >= 0)
      if (!ok) return
      if (!hit || (isPdf(f) && !isPdf(hit))) hit = f
    })
    return hit
  }
  seats.forEach(function (s) { s.file = pickScript(s) })

  var manual = null
  files.forEach(function (f) {
    if (!/\.(pdf|docx?|txt|md)$/i.test(String(f.rel))) return
    if (/手册|组织者|主持|host|规则|说明|handbook|dm/i.test(baseName(f.rel))) { if (!manual) manual = f }
  })
  if (!manual) {
    files.forEach(function (f) {
      if (!/\.(pdf|docx?|txt|md)$/i.test(String(f.rel))) return
      if (/线索|clue|人物|角色/i.test(strip(f.rel))) return
      if (!manual || (f.bytes || 0) > (manual.bytes || 0)) manual = f
    })
  }
  var clues = files.filter(function (f) { return /线索|clue/i.test(strip(f.rel)) })
  clues.sort(function (a, b) { return strip(a.rel).localeCompare(strip(b.rel), 'zh') })
  return { c: c, files: files, seats: seats, manual: manual, clues: clues, texts: c.texts || [] }
}

/* ---------- 状态 ---------- */
function key() { return KEY + S.root + '|' + S.folder }
function load() {
  var base = { act: 1, dealt: [], note: '', t0: Date.now(), accMs: 0, running: true, seat: 0, tab: 'play', me: -1, chat: [], mode: 'player' }
  try {
    var raw = localStorage.getItem(key())
    if (raw) {
      var got = JSON.parse(raw)
      for (var k in got) if (Object.prototype.hasOwnProperty.call(got, k)) base[k] = got[k]
    } else {
      localStorage.setItem(key(), JSON.stringify(base))
    }
  } catch (e) { /* 私密模式读不到就用默认值 */ }
  return base
}
function save() {
  if (S) S.lastSeen = Date.now()
  try { localStorage.setItem(key(), JSON.stringify(S)) } catch (e) { /* 存不下不致命 */ }
}

/* ---------- 时钟（收桌停表；点计时器走表/停表） ---------- */
function elapsedMs() {
  var acc = Number(S && S.accMs) || 0
  if (!S || S.running === false) return Math.max(0, acc)
  return acc + Math.max(0, Date.now() - (Number(S.t0) || Date.now()))
}
function fmtMs(ms) {
  var sec = Math.floor(ms / 1000)
  var m = Math.floor(sec / 60), s = sec % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}
function clockPaint() {
  var el = $('tbl-clock')
  if (!el || !S) return
  el.textContent = fmtMs(elapsedMs())
  if (S.running === false) { el.classList.add('is-paused'); el.title = '计时已停 · 点一下继续走表' }
  else { el.classList.remove('is-paused'); el.title = '对局计时中 · 点一下停表' }
}
function startClock() {
  if (tick) clearInterval(tick)
  clockPaint()
  tick = setInterval(function () { if (S && S.running !== false) clockPaint() }, 1000)
}
function toggleClock() {
  if (!S) return
  if (S.running === false) { S.t0 = Date.now(); S.running = true } else { S.accMs = elapsedMs(); S.running = false }
  save()
  clockPaint()
  var b = window.GameDeskBridge
  if (b && b.toast) b.toast(S.running === false ? '停表 · 本局已用 ' + fmtMs(S.accMs) : '继续走表')
}

/* ---------- 渲染：外壳 ---------- */
export function open(payload) {
  var c = payload.case || payload
  // key() 要用 root/folder，先把它们放到 S 上再读存档：否则 S 还是 null，key() 抛错被 catch 吞掉，读档全落空
  S = { root: payload.root || '', folder: c.folder || '' }
  S = Object.assign(S, load())
  if (typeof S.running === 'undefined') S.running = true
  if (typeof S.accMs !== 'number') S.accMs = 0
  // 「开/继续这一局」永远落在对局页签 —— 旧存档里被误写进 tab 的 roles 在这里一并洗掉
  S.tab = 'play'
  // 白板/表格按本子另存，不塞进 S：换一本要重新读，画的东西也不会跟着 S 一起被写坏
  WB = null
  GRIDS = null
  // 计时只算对局室真正开着的时间：上次离开到这次回来之间的空档不进表
  if (S.running !== false) {
    var ls = Number(S.lastSeen) || 0
    var t0o = Number(S.t0) || 0
    if (ls > t0o) S.accMs += ls - t0o
    S.t0 = Date.now()
  }
  M = buildModel(c)
  if (M.seats.length) {
    if (!(S.me >= 0 && S.me < M.seats.length)) {
      S.me = 0
      M.seats.forEach(function (s, i) { if (s.role && s.role.player === 'human') S.me = i })
    }
    if (!(S.seat >= 0 && S.seat < M.seats.length)) S.seat = S.me
  } else {
    S.me = -1
  }
  document.body.classList.add('is-table')
  var host = $('table')
  host.hidden = false
  host.innerHTML =
    '<div class="tbl-page">' +
      '<div class="tbl-bar">' +
        '<div class="tbl-id"><span class="tbl-k">对局室</span><b>' + esc(c.title || c.folder) + '</b></div>' +
        '<button class="tbl-clock" id="tbl-clock" type="button" title="对局计时中 · 点一下停表">00:00</button>' +
        '<div class="tbl-tools">' +
          '<button class="ghost sm" id="tbl-prev" type="button">上一幕</button>' +
          '<span class="tbl-act" id="tbl-act">第 1 幕</span>' +
          '<button class="ghost sm" id="tbl-next" type="button">下一幕</button>' +
          '<button class="ghost sm" id="tbl-mode" type="button" title="玩家视角锁着别人的本与手册；主持视角全开">玩家视角</button>' +
          '<button class="ghost sm" id="tbl-arcade" type="button" title="去游戏厅">游戏厅</button>' +
          '<button class="ghost sm" id="tbl-send" type="button" title="就在本页让 AI 主持开局，不回会话">交给 AI 主持</button>' +
          '<button class="ghost sm" id="tbl-back" type="button">收桌</button>' +
        '</div>' +
      '</div>' +
      '<div class="tbl-grid">' +
        '<aside class="tbl-seats" id="tbl-seats"></aside>' +
        '<main class="tbl-main">' +
          '<nav class="tbl-tabs" id="tbl-tabs"></nav>' +
          '<div id="tbl-body"></div>' +
        '</main>' +
        '<aside class="tbl-side">' +
          '<div class="tbl-k2">线索</div>' +
          '<div class="clue-progress" id="tbl-cprog"></div>' +
          '<div class="clue-deal"><button class="ghost sm" id="tbl-deal" type="button">发下一条</button><button class="ghost sm" id="tbl-deal-all" type="button">全发</button></div>' +
          '<div class="clue-deck" id="tbl-clues"></div>' +
          '<div class="tbl-k2">笔记</div>' +
          '<textarea class="tbl-note" id="tbl-note" placeholder="记下这一刻谁在哪儿、哪句对不上…"></textarea>' +
          '<div class="tbl-foot"><span id="tbl-foot-l"></span><span>本页自动存</span></div>' +
        '</aside>' +
      '</div>' +
    '</div>'
  $('tbl-back').addEventListener('click', close)
  $('tbl-prev').addEventListener('click', function () { step(-1) })
  $('tbl-next').addEventListener('click', function () { step(1) })
  $('tbl-deal').addEventListener('click', dealNext)
  $('tbl-deal-all').addEventListener('click', dealAll)
  $('tbl-send').addEventListener('click', sendToAgent)
  $('tbl-arcade').addEventListener('click', function () { if (window.GameDeskBridge) window.GameDeskBridge.gotoRoom('arcade') })
  $('tbl-clock').addEventListener('click', toggleClock)
  $('tbl-mode').addEventListener('click', function () { setMode(S.mode === 'host' ? 'player' : 'host') })
  var note = $('tbl-note')
  note.value = S.note || ''
  var st = null
  note.addEventListener('input', function () {
    S.note = note.value
    if (st) clearTimeout(st)
    st = setTimeout(save, 250)
  })
  startClock()
  paintChrome()
  renderAll()
  // 第一次画完后跟服务端对齐一次占位（拉不到就保持现在的样子，不挡人玩）
  loadSeatTaken(function () { if ($('tbl-seats')) renderSeats() })
  // 之后每 12 秒对齐一次：别人后来占的席要变灰，页开着也算给自己续期（close 里停）
  startSeatPoll()
}

export function close() {
  // 收桌 = 停表：用时定格进存档，下次回来还是静止的，点计时器才继续走
  if (S && S.running !== false) { S.accMs = elapsedMs(); S.running = false }
  var host = $('table')
  if (host) { host.hidden = true; host.innerHTML = '' }
  document.body.classList.remove('is-table')
  if (tick) { clearInterval(tick); tick = null }
  stopSeatPoll()   // 收桌就别再轮询占位了，也别再给自己续期
  if (WB) wbSave()
  if (GRIDS) gSave()
  save()
}

/* ---------- 文案：类型键翻中文（对局室底栏；与 app.js 的 RB_GENRE 同表） ---------- */
// case.yml 里的 genre 常是英文键（deduction/drama），底栏直接显示会把英文漏给访客；
// 认得出就翻，认不出（含写成中文的）也给一个人话标记，绝不把 null/英文原值摆到界面上。
var GENRE_CN = {
  deduction: '推理', mystery: '悬疑', suspense: '悬疑', drama: '剧情', emotion: '情感',
  horror: '恐怖', thriller: '惊悚', comedy: '欢乐', joy: '欢乐', mechanism: '机制',
  camp: '阵营', interactive: '互动', healing: '治愈', scifi: '科幻', 'sci-fi': '科幻',
  spy: '谍战', dark: '暗黑', ancient: '古风', hardcore: '硬核', imported: '未标注', unknown: '未标注'
}
function genreCn(g) {
  var s = String(g == null ? '' : g).trim()
  if (!s) return '未标注'
  if (/[一-龥]/.test(s)) return s           // 已经是中文（硬核 / 还原）就原样
  var hit = GENRE_CN[s.toLowerCase()]
  return hit || '未标注'                     // 认不出的英文键不原样漏英文
}

function paintChrome() {
  $('tbl-act').textContent = '第 ' + S.act + ' 幕'
  var mb = $('tbl-mode')
  if (mb) {
    mb.textContent = S.mode === 'host' ? '主持视角' : '玩家视角'
    if (S.mode === 'host') mb.classList.add('is-host'); else mb.classList.remove('is-host')
  }
  var dealt = (S.dealt || []).length
  $('tbl-cprog').innerHTML = '已发 <b>' + dealt + '</b> / ' + M.clues.length + ' 条'
  var foot = []
  var c = M.c
  if (c.players) foot.push(c.players + ' 人')
  if (c.duration) foot.push(c.duration)
  if (c.genre) foot.push(genreCn(c.genre))
  $('tbl-foot-l').textContent = foot.join(' · ') || (M.files.length + ' 个文件')
}

/* ---------- 剧透保护 ---------- */
function ownRel() { var s = M.seats[S.me]; return s && s.file ? s.file.rel : '' }
function isTruth(rel) { return /case\.yml|handbook|手册|主持|组织者|复盘|真相|结局|dm/i.test(String(rel)) }
function isRole(rel) { return /roles[\/\\]|人物剧本|角色剧本|人物|角色/i.test(String(rel)) }
function isClue(rel) { return /线索|clue/i.test(String(rel)) }
function otherRoleName(rel) {
  var n = baseName(rel)
  for (var i = 0; i < M.seats.length; i++) {
    if (i !== S.me && M.seats[i].name && n.indexOf(M.seats[i].name) >= 0) return true
  }
  return false
}
function playerLock() { return S.mode !== 'host' }
function lockCard(text) {
  return '<div class="lockcard"><div class="lock-k">剧透保护 · 玩家视角</div><p>' + esc(text) + '</p>' +
    '<div class="lock-act"><button class="ghost sm" id="tbl-unlock" type="button">切到主持视角</button>' +
    '<span class="lock-hint">主持视角会摊开所有人的本和手册 —— 自己带本时用，屏幕别让同桌看见。</span></div></div>'
}
function bindUnlock() {
  var b = $('tbl-unlock')
  if (b) b.addEventListener('click', function () { setMode('host') })
}
function setMode(m) {
  S.mode = m
  save()
  paintChrome()
  renderSeats()
  renderMain()
  if (window.GameDeskBridge && GameDeskBridge.toast) {
    GameDeskBridge.toast(m === 'host' ? '主持视角：所有人的本和手册都摊开了' : '玩家视角：别人的本与手册重新锁上')
  }
}

/* ---------- 座位认领 + 昵称（同一房间的人不许占同一席） ---------- */
var SEAT_TAKEN = {}   // seat → 别人占着的席位（服务端 mine === false 的那些）
var SEAT_POLL = null  // 12 秒一次的对齐轮询（open 起、close 停）
var SEAT_CLAIMING = 0 // 正在飞的认领请求数：>0 时轮询跳过本轮，别拿旧表盖掉忙态
function takenMapOf(arr) {   // 服务端回的 seats 表 → 「席位号 → 别人占着的那个」
  var next = {}
  var list = arr || []
  list.forEach(function (s) { if (s && s.mine === false) next[Number(s.seat)] = s })
  return next
}
function startSeatPoll() {
  stopSeatPoll()   // 防重入：已有的定时器先清掉，绝不留两个
  // 页开着就等于给自己的席位续期（GET 带 touch），也顺手把别人后来占的席刷出来
  SEAT_POLL = setInterval(function () {
    if (!S || !$('tbl-seats')) { stopSeatPoll(); return }              // 已经收桌：轮询自己停
    if (SEAT_CLAIMING > 0) return                                       // 认领在飞：这一轮让路
    loadSeatTaken(function () {
      if (SEAT_CLAIMING > 0) return                                     // 回包前又有人点了认领：别盖
      if ($('tbl-seats')) renderSeats()
    })
  }, 12000)
}
function stopSeatPoll() { if (SEAT_POLL) { clearInterval(SEAT_POLL); SEAT_POLL = null } }
function seatMineBtn(idx) {
  var box = $('tbl-seats')
  return box ? box.querySelector('.seat-mine[data-mine="' + idx + '"]') : null
}
// 认领按钮的忙态：在飞时禁用并写「选座中…」；成功 / 失败 / 断网三条路都必须还回去
function seatBusy(idx, on) {
  var b = seatMineBtn(idx)
  if (!b) return
  if (on) {
    b.setAttribute('data-label', b.textContent)   // 记下原标签，失败时原样还回去
    b.textContent = '选座中…'
    b.disabled = true
    return
  }
  // 关忙态只认「同一个按钮」（带着 data-label）：期间被 poll / 点座位重画过，就交给重画的结果 ——
  // 否则会把重画后「已被别人占了」的 disabled 强行改回可点。
  var lb = b.getAttribute('data-label')
  if (lb == null) return
  b.textContent = lb
  b.removeAttribute('data-label')
  b.disabled = false
  b.removeAttribute('aria-disabled')
}
function claimDone(idx) {   // 认领收尾：计数复位 + 按钮复位（重画过就只复位计数）
  if (SEAT_CLAIMING > 0) SEAT_CLAIMING -= 1
  seatBusy(idx, false)
}
function nick() {
  try {
    var v = localStorage.getItem('gd-nick')
    if (v) return v
    v = '玩家' + Math.random().toString(36).slice(2, 6)
    localStorage.setItem('gd-nick', v)
    return v
  } catch (e) { return '玩家' + Math.random().toString(36).slice(2, 6) }
}
function seatWho() {
  try { var w = localStorage.getItem('gd-who'); if (w) return w } catch (e) { /* 私密模式读不到 */ }
  return ''
}
function seatLabelOf(s) { return (s && s.name) || ((s && s.via) === 'local' ? '房主' : '另一位玩家') }
function toastTxt(t) { if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast(t) }
function loadSeatTaken(cb) {
  if (!S) { if (typeof cb === 'function') cb(); return }
  var u = API + '/seats?root=' + enc(S.root) + '&folder=' + enc(S.folder) + '&who=' + enc(seatWho())
  fetch(u, { cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (j) {
      if (j && j.ok) SEAT_TAKEN = takenMapOf(j.seats)   // 服务端回的整表：别人占的席都在这
      if (typeof cb === 'function') cb()
    })
    .catch(function () { /* 后端没起来就当没人占，不挡人玩 */ })
}
function applySeat(idx) {
  S.me = idx
  S.seat = idx
  // 换演谁不跳页签：正在对局就留在对局，DM 下一句按新席位来
  save()
  paintChrome()
  renderSeats()
  renderMain()
  toastTxt('你现在演：' + M.seats[S.me].name)
}
function claimSeat(idx) {
  var who = seatWho()
  if (!who) { applySeat(idx); return }   // localStorage 被禁用：没有身份可报，先本地换
  if (SEAT_CLAIMING > 0) return          // 上一个认领还在飞：别叠请求，也别让两次回包互相盖
  SEAT_CLAIMING += 1
  seatBusy(idx, true)
  fetch(API + '/seats/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: S.root, folder: S.folder, seat: idx, who: who, name: nick() })
  })
    .then(function (r) {
      return r.json().catch(function () { return {} }).then(function (j) { return { status: r.status, j: j || {} } })
    })
    .then(function (got) {
      var j = got.j
      if (j && j.ok === true) {
        // 服务端记下了才算数；顺手用回包里的整表刷新，别人占的席立刻变灰
        if (j.seats) SEAT_TAKEN = takenMapOf(j.seats)
        claimDone(idx)
        applySeat(idx)
        return
      }
      if (got.status === 409 || (j && j.error === 'seat-taken')) {
        claimDone(idx)
        toastTxt('这一席已经被「' + seatLabelOf(j && j.holder) + '」选了，换一个')
        loadSeatTaken(function () { if ($('tbl-seats')) renderSeats() })
        return
      }
      // 其它失败（400 / 404 / 500 / 宿主重载窗口）：服务端没有任何记录，绝不能本地生效 ——
      // 本地一换就会「两个人都以为自己在演同一角色」。S.me 保持原样，按钮还回去让人重试。
      claimDone(idx)
      toastTxt('选座位没同步上服务端，再点一次')
      if ($('tbl-seats')) renderSeats()   // 认领期间可能已经收桌了，别对着空壳重画
    })
    .catch(function () {
      claimDone(idx)
      toastTxt('选座位没同步上服务端（网络不通），再点一次')
      if ($('tbl-seats')) renderSeats()   // 同上：收桌后别再碰已经拆掉的座位区
    })
}

/* ---------- 渲染：座位 ---------- */
function renderSeats() {
  var box = $('tbl-seats')
  if (!M.seats.length) {
    box.innerHTML = '<div class="tbl-k2">座位</div><p class="readhint">这本没标座位 —— 人物剧本在「资料」里。</p>'
    return
  }
  box.innerHTML = '<div class="tbl-k2">座位</div>' +
    '<p class="tbl-tiphint">点名字看他的本（对局里点座位不打断对局；玩家视角里别人的锁着），点「我演这个」换人 —— 谁也不许替你选。</p>' +
    M.seats.map(function (s, i) {
      var mine = S.me === i
      var taken = !mine && SEAT_TAKEN[i]
      // 被占的席不能写「我演这个」当诱饵：按钮直接说清是谁占了，并且是 disabled
      var btnTxt = mine ? '你在演' : (taken ? '「' + seatLabelOf(taken) + '」选了这一席' : '我演这个')
      return '<div class="seatbtn' + (S.seat === i ? ' is-on' : '') + (mine ? ' is-mine' : '') + (taken ? ' is-taken' : '') + '" data-seat="' + i + '">' +
        '<b>' + esc(s.name) + '</b>' +
        '<em>' + (mine ? '（' + esc(nick()) + '）' : (taken ? '（' + esc(seatLabelOf(taken)) + '）' : 'AI')) + '</em>' +
        '<button class="seat-mine" data-mine="' + i + '" type="button"' + (taken ? ' disabled aria-disabled="true"' : '') + '>' + esc(btnTxt) + '</button>' +
        '</div>'
    }).join('')
  Array.prototype.forEach.call(box.querySelectorAll('.seatbtn'), function (b) {
    b.addEventListener('click', function () {
      S.seat = Number(b.getAttribute('data-seat'))
      // 对局进行中点座位 = 只是在看谁，不许把页签从对局带走
      if (S.tab !== 'play') S.tab = 'roles'
      save()
      paintChrome()
      renderSeats()
      renderMain()
    })
  })
  Array.prototype.forEach.call(box.querySelectorAll('.seat-mine'), function (b) {
    b.addEventListener('click', function (ev) {
      // 这是座位卡里的按钮：不挡住外层「点名字看他的本」就不会留在当前页签
      if (ev && ev.stopPropagation) ev.stopPropagation()
      claimSeat(Number(b.getAttribute('data-mine')))
    })
  })
}

/* ---------- 渲染：页签 ---------- */
var TABS = [
  { id: 'play', label: '对局' },
  { id: 'intro', label: '引子' },
  { id: 'body', label: '正文' },
  { id: 'roles', label: '人物剧本' },
  { id: 'flow', label: '流程' },
  { id: 'board', label: '白板' },
  { id: 'grids', label: '表格' },
  { id: 'files', label: '资料' }
]
function renderTabs() {
  $('tbl-tabs').innerHTML = TABS.map(function (t) {
    return '<button class="tbl-tab' + (S.tab === t.id ? ' is-on' : '') + '" data-tab="' + t.id + '" type="button">' + t.label + '</button>'
  }).join('')
  Array.prototype.forEach.call($('tbl-tabs').querySelectorAll('.tbl-tab'), function (b) {
    b.addEventListener('click', function () { S.tab = b.getAttribute('data-tab'); save(); renderTabs(); renderMain() })
  })
}

/* ---------- 渲染：正文 ---------- */
function introHtml() {
  var c = M.c
  var bits = []
  var prem = c.premise || c.brief || ''
  if (prem) bits.push('<pre class="read">' + esc(prem) + '</pre>')
  else bits.push('<p class="readhint">这本没有引子字段 —— 去「资料」里翻手册。</p>')
  bits.push('<p class="readhint">座位在左栏 —— 「我演这个」定你的角色；别人的本和 DM 手册在玩家视角锁着，要全开就切上方「主持视角」。</p>')
  return bits.join('')
}

function loadDoc(file, holder) {
  if (!file) { holder.innerHTML = '<p class="readhint">这一页没有对应文件。</p>'; return }
  var name = baseName(file.rel)
  holder.innerHTML = '<p class="readhint">正在取「' + esc(name) + '」…</p>'
  // 1) 结构化本子：_text 下的同名字幕
  var txt = null
  M.files.forEach(function (f) {
    if (f.rel.indexOf('_text/') !== 0) return
    if (baseName(f.rel).indexOf(name) >= 0) { if (!txt) txt = f }
  })
  var done = function (text) {
    if (text) {
      var shown = String(text).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*\*/g, '').replace(/__([^_]+)__/g, '$1')
      holder.innerHTML = '<div class="readhint">' + esc(name) + (file.bytes ? ' · ' + Math.round(file.bytes / 1024) + ' KB' : '') + '</div>' +
        '<pre class="read">' + esc(shown) + '</pre>'
      return true
    }
    if (isImg(file)) {
      holder.innerHTML = '<figure class="figure"><img alt="' + esc(name) + '" src="' + esc(fileUrl(file.rel)) + '" /></figure>'
      return true
    }
    if (isPdf(file)) {
      holder.innerHTML = '<div class="readhint">' + esc(name) + ' · 直接看原件（扫描件抽不出文字）</div>' +
        '<iframe class="frame" title="' + esc(name) + '" src="' + esc(fileUrl(file.rel)) + '"></iframe>'
      return true
    }
    holder.innerHTML = '<p class="readhint">这份取不出正文：' + esc(name) + '</p>'
    return true
  }
  var tries = []
  if (isTextFile(file)) tries.push(function () { return getText(fileUrl(file.rel)) })
  if (txt) tries.push(function () { return getText(fileUrl(txt.rel)) })
  tries.push(function () { return getText(textUrl(file.rel)) })
  var i = 0
  function next() {
    if (i >= tries.length) { done(null); return }
    tries[i++]().then(function (t) { if (t && t.trim() !== '') done(t); else next() })
  }
  next()
}

/* ---------- 人物剧本：按幕给（2026-11-20，用户 m00504） ----------
   以前这里 loadDoc 一把摊开整份（PDF 直接 iframe）。导入本的角色本自带「第 N 幕」，
   所以改问 /api/script：只取当前这一幕的页，页由宿主渲成图（/api/page）。
   切不开幕的（扫描件还没抽字 / 没有幕标题）也不退回 PDF 阅读器：宿主把整份按页渲成图（whole:true），照旧是图；只有 md/txt 切不开、或连页都渲不出时才退回 loadDoc。 */
function actLabel(n) { return '第 ' + n + ' 幕' }
function chineseMsg(s) { return /[一-龥]/.test(String(s || '')) }
function flowErrText(j) {
  var s = j && j.error
  if (s == null || s === '') return '未知错误'
  if (typeof s === 'object') return '未知错误'
  return chineseMsg(s) ? String(s) : roomErr(s)
}
function loadScript(seat, holder) {
  var file = seat && seat.file
  if (!file) { holder.innerHTML = '<p class="readhint">这一席没有对应的人物剧本文件。</p>'; return }
  var name = baseName(file.rel)
  holder.innerHTML = '<p class="readhint">正在取「' + esc(name) + '」…</p>'
  var url = API + '/script?root=' + enc(S.root) + '&folder=' + enc(S.folder) + '&rel=' + enc(file.rel) + '&act=' + (Number(S.act) || 1)
  fetch(url, { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (j) {
    var pages = (j && j.pages) || []
    var whole = !!(j && j.ok === true && j.source === 'pdf' && j.split !== true && pages.length)
    if (!j || j.ok !== true || (j.split !== true && !whole)) {
      loadDoc(file, holder)
      if (j && j.note && window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast(j.note)
      return
    }
    var head = whole
      ? '<div class="actdoc-head">' +
        '<span class="actdoc-k">整份</span>' +
        '<b>' + esc(name) + '</b>' +
        '<span class="actdoc-m">' + pages.length + ' 页</span>' +
        '</div>'
      : '<div class="actdoc-head">' +
        '<span class="actdoc-k">' + esc(actLabel(j.act)) + ' / ' + esc(String(j.actCount)) + ' 幕</span>' +
        '<b>' + esc(name) + '</b>' +
        '<span class="actdoc-m">' + (j.source === 'pdf' ? pages.length + ' 页' : '本幕正文') + '</span>' +
        '</div>'
    var note = j.note ? '<p class="readhint">' + esc(j.note) + '</p>' : ''
    var body = ''
    if (j.source === 'pdf') {
      body = pages.map(function (pg) {
        return '<figure class="pg"><img alt="' + esc(name + ' 第 ' + pg.page + ' 页') + '" loading="lazy" src="' + esc(pg.url) + '" />' +
          '<figcaption>第 ' + esc(String(pg.page)) + ' 页</figcaption></figure>'
      }).join('')
    } else {
      var shown = String(j.text || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*\*/g, '')
      body = shown.trim() !== '' ? '<pre class="read">' + esc(shown) + '</pre>' : '<p class="readhint">这一幕没取到文字。</p>'
    }
    var hint = whole
      ? (j.note ? '' : '<p class="readhint">这份剧本切不开幕，整份按页给你 —— 往下翻就是后面的页。</p>')
      : '<p class="readhint">按幕开放：这里只有当前这一幕 —— 用上方「第 N 幕」往后翻，下一幕才会开。</p>'
    holder.innerHTML = head + note + hint + body
  }).catch(function (e) {
    loadDoc(file, holder)
    if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('按幕取不到（' + (e && e.message ? e.message : '网络不通') + '），先看整份原件')
  })
}

/* ---------- 带本流程（2026-11-20，用户 m00610） ----------
   本子导入库后先让 AI 排一份「游玩顺序」：每一幕做什么、在哪停下等玩家讨论、
   真相手册什么时候发。只给主持视角 —— 这份大纲里写着真相口径。 */
var FLOW_BUSY = false
function flowRow(k, v) {
  if (!v) return ''
  return '<div class="flow-row"><span class="flow-k">' + esc(k) + '</span><div class="flow-v">' + esc(v) + '</div></div>'
}
function flowActsHtml(flow) {
  var cur = Number(S.act) || 1
  return (flow.acts || []).map(function (a, i) {
    var n = i + 1
    var steps = (a.steps || []).length
      ? '<ol class="flow-steps">' + a.steps.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + '</ol>'
      : ''
    return '<section class="flow-card' + (n === cur ? ' is-now' : '') + '">' +
      '<div class="flow-h"><span class="flow-n">' + ('0' + n).slice(-2) + '</span><b>' + esc(a.label || actLabel(n)) + '</b>' +
      (n === cur ? '<span class="flow-now">当前这一幕</span>' : '') + '</div>' +
      flowRow('这一幕要做什么', a.goal) + steps +
      flowRow('在哪停下等讨论', a.pause) +
      flowRow('这一幕可发', a.hand) +
      flowRow('真相口径', a.truth) +
      '</section>'
  }).join('')
}
function flowBodyHtml(j) {
  var flow = j && j.flow
  if (!flow) {
    return '<div class="flow-empty"><p class="readhint">这本还没排过游玩顺序。</p>' +
      '<p class="flow-p">让 AI 先读一遍这本的资料（手册、规则、线索、各角色本的幕结构），排出一份带本大纲：每一幕做什么、在哪停下来等玩家讨论、真相手册什么时候发。生成一次约半分钟，之后存在本子里；本子改了会提示重排。</p>' +
      '<div class="flow-bar"><button class="ghost sm" id="flow-gen" type="button">生成游玩顺序</button>' +
      '<span class="flow-note" id="flow-note"></span></div></div>'
  }
  var when = j.at ? new Date(j.at).toLocaleString() : ''
  var badge = j.stale ? '<span class="flow-stale">本子资料变了，建议重排</span>' : ''
  return '<div class="flow-head"><b>' + esc(flow.title || j.title || '这场游戏的游玩顺序') + '</b>' +
    '<span class="flow-meta">' + esc(String((flow.acts || []).length)) + ' 幕 · ' + esc(when) + (j.model ? ' · ' + esc(j.model) : '') + '</span>' + badge + '</div>' +
    '<p class="readhint">按幕带：当前第 ' + esc(String(Number(S.act) || 1)) + ' 幕高亮 —— 上方「第 N 幕」翻页，这里跟着换。</p>' +
    flowActsHtml(flow) +
    (flow.final ? '<section class="flow-card flow-final"><div class="flow-h"><b>收尾</b></div>' +
      flowRow('真相怎么给', flow.final.truth) + flowRow('复盘怎么收', flow.final.debrief) + '</section>' : '') +
    ((flow.notes || []).length ? '<section class="flow-card flow-notes"><div class="flow-h"><b>提醒</b></div><ul class="flow-steps">' +
      flow.notes.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + '</ul></section>' : '') +
    '<div class="flow-bar"><button class="ghost sm" id="flow-gen" data-force="1" type="button">重新生成</button>' +
    '<span class="flow-note" id="flow-note"></span></div>'
}
function flowGenerate(force) {
  if (FLOW_BUSY) return
  FLOW_BUSY = true
  var btn = $('flow-gen')
  var note = $('flow-note')
  if (btn) { btn.disabled = true; btn.textContent = '正在排…（约半分钟）' }
  if (note) note.textContent = '模型正在读这本的资料，别关这一页。'
  fetch(API + '/flow', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: S.root, folder: S.folder, force: !!force })
  }).then(function (r) { return r.json() }).then(function (j) {
    FLOW_BUSY = false
    if (!j || j.ok !== true) {
      if (note) note.textContent = '没排出来：' + flowErrText(j)
      if (btn) { btn.disabled = false; btn.textContent = force ? '重新生成' : '生成游玩顺序' }
      return
    }
    renderMain()
    if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('游玩顺序排好了')
  }).catch(function (e) {
    FLOW_BUSY = false
    if (note) note.textContent = '没排出来：' + (e && e.message ? e.message : '网络不通')
    if (btn) { btn.disabled = false; btn.textContent = force ? '重新生成' : '生成游玩顺序' }
  })
}
function bindFlowBtn() {
  var b = $('flow-gen')
  if (!b) return
  b.addEventListener('click', function () { flowGenerate(b.getAttribute('data-force') === '1') })
}
function boxFlow(box) {
  if (playerLock()) {
    box.innerHTML = lockCard('「流程」是带本大纲，写着每一幕什么时候发真相 —— 玩家视角不摊开。')
    bindUnlock()
    return
  }
  box.innerHTML = '<p class="readhint">正在取游玩顺序…</p>'
  fetch(API + '/flow?root=' + enc(S.root) + '&folder=' + enc(S.folder), { cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (j) {
      if (!j || j.ok !== true) {
        box.innerHTML = '<p class="readhint">取不到流程：' + esc(flowErrText(j)) + '</p>'
        return
      }
      box.innerHTML = flowBodyHtml(j)
      bindFlowBtn()
    })
    .catch(function (e) {
      box.innerHTML = '<p class="readhint">取不到流程：' + esc(e && e.message ? e.message : '网络不通') + '</p>'
    })
}

/* ---------- 页内对局（宿主 llm 当 DM，不回会话） ---------- */
var CHAT_BUSY = false
/* 探活（GET /dm/health）：对局页签每画一次就会问一遍 —— 切页签、点座位、「交给 AI 主持」都会重画，
   连着切几下就是几个请求。60 秒内只用上一次的结果，只省请求、不改提示语义（2026-11-20）。
   三种结果分开处理：
     200 + ok/llm/model  → 可用，标模型名；
     403                 → 探活是 owner-only 闸门，局域网/公网访客本来就看不了；但模型面（/dm）对局域网放行，
                           所以这**不是**「没有模型服务」，静默跳过，一个字都不提示；
     其它失败（500/断网/超时）→ 照旧给「没探到宿主的模型服务」那句。 */
var HEALTH_TTL = 60000
var HEALTH_AT = 0
var HEALTH_VIEW = null   // null = 还没探到；{ hidden:true } = 403 静默；{ note:'…' } = 探活失败；{ model:'…' } = 可用
var HEALTH_DOWN = '没探到宿主的模型服务 —— 页内对局开不了；可以先用「引子 / 正文 / 人物剧本」自己主持。'

function paintHealth(view) {
  view = view || HEALTH_VIEW
  if (!view) return
  var note = $('tbl-chat-note')
  var model = $('tbl-chat-model')
  if (note && view.note) note.textContent = view.note
  // 页头模型名只由探活结果决定：以前带了 !(S.chat||[]).length，这一局只要聊过天就再也不写，页头永远空白
  if (model && view.model) model.textContent = '模型 ' + view.model
}

function probeHealth() {
  if (HEALTH_VIEW && Date.now() - HEALTH_AT < HEALTH_TTL) { paintHealth(); return }
  fetch(API + '/dm/health', { cache: 'no-store' }).then(function (r) {
    if (r.status === 403) return { hidden: true }
    if (!r.ok) return { note: HEALTH_DOWN }
    return r.json().then(function (j) {
      return (j && j.llm && j.model) ? { model: String(j.model) } : { note: HEALTH_DOWN }
    }, function () { return { note: HEALTH_DOWN } })
  }, function () { return { note: HEALTH_DOWN } }).then(function (view) {
    // 失败不记缓存：下次重画还能再探一遍（保持原来「随时能重试」的手感）；403 与可用才记 60 秒。
    if (view.note) HEALTH_VIEW = null
    else { HEALTH_VIEW = view; HEALTH_AT = Date.now() }
    paintHealth(view)
  })
}

function boxPlay() {
  var box = $('tbl-body')
  box.innerHTML =
    '<div class="chat-top"><button class="ghost sm" id="tbl-chat-open" type="button">请 DM 开场</button><span class="chat-model" id="tbl-chat-model"></span></div>' +
    '<div class="chat" id="tbl-chat"></div>' +
    '<div class="chat-input"><textarea id="tbl-chat-in" rows="2" placeholder="你要说什么 / 做什么…（Enter 发送，Shift+Enter 换行）"></textarea><button class="primary sm" id="tbl-chat-send" type="button">说</button></div>' +
    '<p class="readhint" id="tbl-chat-note"></p>'
  $('tbl-chat-open').addEventListener('click', function () { chatSend('', true) })
  $('tbl-chat-send').addEventListener('click', function () { chatSend($('tbl-chat-in').value, false) })
  $('tbl-chat-in').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); chatSend(ev.target.value, false) }
  })
  renderChatLog()
  probeHealth()
}
function renderChatLog() {
  var list = $('tbl-chat')
  if (!list) return
  var msgs = S.chat || []
  if (!msgs.length) {
    list.innerHTML = '<p class="readhint">还没有对局 —— 点「请 DM 开场」。DM 会立起场景、让每个角色亮相，然后停下等你行动。</p>'
    return
  }
  var meName = (M.seats[S.me] && M.seats[S.me].name) || '你'
  if (M.seats[S.me]) meName += '（' + nick() + '）'
  list.innerHTML = msgs.map(function (m) {
    var who = m.who === 'dm' ? 'DM' : meName
    var body = String(m.text).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*\*/g, '').replace(/__([^_]+)__/g, '$1')
    return '<div class="msg ' + (m.who === 'dm' ? 'msg-dm' : 'msg-me') + '"><b>' + esc(who) + '</b><span>' + esc(body) + '</span></div>'
  }).join('')
  list.scrollTop = list.scrollHeight
}
function chatSend(input, openFlag) {
  if (CHAT_BUSY) return
  if (!Array.isArray(S.chat)) S.chat = []
  var inp = ''
  if (!openFlag) {
    inp = String(input || '').trim()
    if (inp === '') return
    S.chat.push({ who: 'me', text: inp })
    var ta = $('tbl-chat-in')
    if (ta) ta.value = ''
  }
  save()
  renderChatLog()
  CHAT_BUSY = true
  var sendBtn = $('tbl-chat-send')
  if (sendBtn) sendBtn.disabled = true
  var note = $('tbl-chat-note')
  if (note) note.textContent = 'DM 正在想…'
  var meName = (M.seats[S.me] && M.seats[S.me].name) || '玩家'
  if (M.seats[S.me]) meName += '（' + nick() + '）'
  var aiNames = []
  M.seats.forEach(function (s, i) { if (i !== S.me && s.name) aiNames.push(s.name) })
  fetch(API + '/dm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      root: S.root, folder: S.folder, title: M.c.title || S.folder,
      meName: meName, aiNames: aiNames, act: S.act,
      open: !!openFlag, input: openFlag ? '' : inp,
      history: openFlag ? S.chat : S.chat.slice(0, -1),
    }),
  }).then(function (r) { return r.json() }).then(function (j) {
    CHAT_BUSY = false
    if (sendBtn) sendBtn.disabled = false
    if (j && j.ok) {
      S.chat.push({ who: 'dm', text: j.text })
      save()
      renderChatLog()
      var n2 = $('tbl-chat-note')
      if (n2) n2.textContent = ''
      var mm = $('tbl-chat-model')
      if (mm && j.model) mm.textContent = j.model + ' · ' + Math.round((j.ms || 0) / 100) / 10 + 's'
      var ta2 = $('tbl-chat-in')
      if (ta2) ta2.focus()
    } else {
      if (!openFlag) {
        S.chat.pop()
        save()
        var ta3 = $('tbl-chat-in')
        if (ta3) { ta3.value = inp; ta3.focus() }
        renderChatLog()
      }
      var n3 = $('tbl-chat-note')
      if (n3) n3.textContent = 'DM 没接上：' + roomErr(j && j.error)
    }
  }).catch(function (e) {
    CHAT_BUSY = false
    if (sendBtn) sendBtn.disabled = false
    if (!openFlag) {
      S.chat.pop()
      save()
      var ta4 = $('tbl-chat-in')
      if (ta4) ta4.value = inp
      renderChatLog()
    }
    var n4 = $('tbl-chat-note')
    // 断网时 e.message 是「Failed to fetch」这类英文，同样不能原样上屏
    if (n4) n4.textContent = 'DM 没接上：' + (e && e.message && !/fetch|network|load failed|timeout|abort/i.test(e.message) ? e.message : '网络不通或宿主没应答')
  })
}

function renderMain() {
  renderTabs()
  /* 白板 / 表格把这一页放宽：对局室里中间那栏本来就窄，画板缩在 676px 里没法用。 */
  var pg = document.querySelector('.tbl-page')
  if (pg) pg.classList.toggle('is-wide', S.tab === 'board' || S.tab === 'grids')
  var box = $('tbl-body')
  if (S.tab === 'play') { boxPlay(); return }
  if (S.tab === 'intro') { box.innerHTML = introHtml(); return }
  if (S.tab === 'body') {
    if (playerLock()) {
      box.innerHTML = lockCard('「正文」是主持人手册' + (M.manual ? '（' + baseName(M.manual.rel) + '）' : '') + '，里面写着真相与复盘 —— 玩家视角不摊开。')
      bindUnlock()
      return
    }
    box.innerHTML = '<div id="tbl-doc"></div>'
    loadDoc(M.manual, $('tbl-doc'))
    return
  }
  if (S.tab === 'roles') {
    var s = M.seats[S.seat]
    if (!s) { box.innerHTML = '<p class="readhint">没有标座位 —— 去「资料」里找人物剧本。</p>'; return }
    var mineNow = S.me === S.seat
    if (playerLock() && !mineNow) {
      box.innerHTML = '<div class="readhint">' + esc(s.name) + ' · AI 演这个 <button class="ghost sm" id="tbl-mine" type="button">我演这个</button></div>' +
        lockCard('《' + s.name + '》的人物剧本锁着 —— 玩家视角只看得到自己的本。')
      if ($('tbl-mine')) $('tbl-mine').addEventListener('click', function () {
        // 换角必须由服务端认领：ok 时 claimSeat 内部的 applySeat 已经 save + renderSeats + renderMain + toast，
        // 这里不再重复渲染；409 / 500 / 断网时 S.me 与页签都不动，只让 claimSeat 的 toast 说话。
        claimSeat(S.seat)
      })
      bindUnlock()
      return
    }
    box.innerHTML = '<div class="readhint">' + esc(s.name) + ' · ' + (mineNow ? '你演这个' : 'AI 演这个') +
      (mineNow ? '' : ' <button class="ghost sm" id="tbl-mine" type="button">我演这个</button>') +
      '</div><div id="tbl-doc"></div>'
    if ($('tbl-mine')) $('tbl-mine').addEventListener('click', function () {
      // 同上：主持视角里「把这一席给我」也走服务端认领，成功才由 applySeat 改 S.me 并重画。
      claimSeat(S.seat)
    })
    loadScript(s, $('tbl-doc'))
    return
  }
  if (S.tab === 'flow') { boxFlow(box); return }
  if (S.tab === 'board') { boxBoard(); return }
  if (S.tab === 'grids') { boxGrids(); return }
  var vis = M.files
  var hiddenNote = ''
  if (playerLock()) {
    var own = ownRel()
    var mStem = M.manual ? baseName(M.manual.rel).replace(/\.[^.]+$/, '') : ''
    vis = M.files.filter(function (f) {
      if (f.rel === own) return true
      if (isTruth(f.rel) || isRole(f.rel) || isClue(f.rel)) return false
      if (mStem && String(f.rel).indexOf(mStem) >= 0) return false
      if (otherRoleName(f.rel)) return false
      return true
    })
    var hid = M.files.length - vis.length
    if (hid) hiddenNote = '<p class="readhint">玩家视角藏起了 ' + hid + ' 份资料（别人的本、手册、复盘、线索原件）—— 切上方「主持视角」全开。</p>'
  }
  box.innerHTML = '<div class="readhint">这一本的全部文件</div>' + hiddenNote + '<div class="files">' + vis.map(function (f) {
    return '<button class="file" data-rel="' + esc(f.rel) + '" data-kind="' + esc(f.kind) + '" type="button">' +
      '<span class="file-kind">' + esc(String(f.ext || '').replace('.', '') || 'file') + '</span>' +
      '<span class="file-name">' + esc(strip(f.rel)) + '</span>' +
      '<span class="file-size">' + esc(f.bytes ? Math.round(f.bytes / 1024) + ' KB' : '') + '</span></button>'
  }).join('') + '</div>'
  Array.prototype.forEach.call(box.querySelectorAll('.file'), function (b) {
    b.addEventListener('click', function () {
      var rel = b.getAttribute('data-rel')
      var hit = M.files.filter(function (f) { return f.rel === rel })[0]
      box.innerHTML = '<div class="readhint"><button class="ghost sm" id="tbl-fileback" type="button">← 回到列表</button></div><div id="tbl-doc"></div>'
      $('tbl-fileback').addEventListener('click', renderMain)
      loadDoc(hit, $('tbl-doc'))
    })
  })
}

/* ---------- 渲染：线索 ---------- */
function renderClues() {
  var box = $('tbl-clues')
  if (!M.clues.length) {
    box.innerHTML = '<p class="readhint">这本没带线索卡文件。</p>'
    return
  }
  box.innerHTML = M.clues.map(function (f, i) {
    var open = (S.dealt || []).indexOf(f.rel) >= 0
    return '<button class="clue' + (open ? ' is-open' : '') + '" data-clue="' + esc(f.rel) + '" type="button">' +
      '<b>' + ('0' + (i + 1)).slice(-2) + '</b><span>' + esc(open ? baseName(f.rel) : '未发') + '</span></button>'
  }).join('')
  Array.prototype.forEach.call(box.querySelectorAll('.clue'), function (b) {
    b.addEventListener('click', function () {
      var rel = b.getAttribute('data-clue')
      var open = (S.dealt || []).indexOf(rel) >= 0
      if (!open) { S.dealt.push(rel); save(); paintChrome(); renderClues(); return }
      var f = M.clues.filter(function (x) { return x.rel === rel })[0]
      if (f && window.GameDeskBridge && window.GameDeskBridge.preview) {
        window.GameDeskBridge.preview(fileUrl(rel), baseName(rel), isImg(f), '')
      }
    })
  })
}

function renderAll() { renderSeats(); renderMain(); renderClues() }

function dealNext() {
  for (var i = 0; i < M.clues.length; i++) {
    var rel = M.clues[i].rel
    if ((S.dealt || []).indexOf(rel) < 0) { S.dealt.push(rel); save(); paintChrome(); renderClues(); return }
  }
  if (window.GameDeskBridge && window.GameDeskBridge.toast) window.GameDeskBridge.toast('线索已经全发出去了')
}
function dealAll() {
  S.dealt = M.clues.map(function (f) { return f.rel })
  save(); paintChrome(); renderClues()
}
function step(n) {
  S.act = Math.max(1, (Number(S.act) || 1) + n)
  save(); paintChrome()
  // 人物剧本与流程都是「按幕」的：翻幕就得重画，否则停在上一幕的页/高亮上（2026-11-20）
  if (S.tab === 'roles' || S.tab === 'flow') renderMain()
  if (window.GameDeskBridge && window.GameDeskBridge.toast) window.GameDeskBridge.toast('现在是第 ' + S.act + ' 幕 —— 页内对局里 DM 会跟着这一幕推进')
}

/* ---------- 交给 AI 主持：就在本页，不回会话 ---------- */
function sendToAgent() {
  var b = window.GameDeskBridge
  S.tab = 'play'
  save(); renderTabs(); renderMain()
  if ((S.chat || []).length) {
    if (b && b.toast) b.toast('就在这一页继续 —— DM 接着上文往下带，输入框里说话即可')
    return
  }
  if (b && b.toast) b.toast('AI 就在本页开这一局')
  chatSend('', true)
}

/* ---------- 白板：自由画板 + 思维导图，两样在同一张纸上（2026-11-20，用户 m01037 / m01053） ----------
   线下那张白板：想画就画，想贴卡片就贴卡片。所以这里不是两个页面，是一块画布两种手：
     draw 模式 —— 笔/颜色/粗细/橡皮，落笔即画，按本子存笔画（存点，不存图片，换屏幕也不糊）；
     map  模式 —— 双击空白出卡片、拖动摆位置、「连线」把两张卡连起来，双击卡片改字。
   卡片与笔画共用一张 2400×1500 的世界坐标，画布可平移缩放；卡片存世界像素，旧数据打开时换算一次。
   存储：localStorage 的 gd:board:<root|folder> —— 不塞进 S，画一笔不会把整份桌档重写一遍。 */
var BKEY = 'gd:board:'
var WB = null
var WB_T = null
var WB_DRAW = null
var WB_LASTPAN = 0
var WB_COLORS = ['#1a1710', '#a63a2b', '#a9843c', '#3d5a4a', '#2f4d7a']
var WB_WIDTHS = [{ v: 2, t: '细' }, { v: 4.5, t: '中' }, { v: 8, t: '粗' }]
/* 无限画布的世界尺寸：节点存的是世界像素（px/py/pw/ph），跟窗口大小解耦。
   旧数据（x/y/w 是 0..1 的比例）在打开时按当时的画布尺寸换算成像素，只迁一次。 */
var WB_W = 2400, WB_H = 1500
var WB_NK = [
  { k: '', t: '默认' },
  { k: 'red', t: '红' },
  { k: 'orange', t: '橙' },
  { k: 'yellow', t: '黄' },
  { k: 'green', t: '绿' },
  { k: 'cyan', t: '青' },
  { k: 'purple', t: '紫' }
]
var WB_NK_BG = { red: '#f3d9d4', orange: '#f5e5cf', yellow: '#f3eece', green: '#dce9da', cyan: '#d6e7e9', purple: '#e5dcee' }

function wbKey() { return BKEY + S.root + '|' + S.folder }
function wbLoad() {
  var d = { mode: 'draw', color: '#1a1710', width: 4.5, eraser: false, pan: false, nodeK: '', strokes: [], nodes: [], links: [], view: null }
  try {
    var raw = localStorage.getItem(wbKey())
    if (raw) {
      var g = JSON.parse(raw)
      for (var k in g) if (Object.prototype.hasOwnProperty.call(g, k)) d[k] = g[k]
    }
  } catch (e) { /* 读不到就当空白板 */ }
  if (!Array.isArray(d.strokes)) d.strokes = []
  if (!Array.isArray(d.nodes)) d.nodes = []
  if (!Array.isArray(d.links)) d.links = []
  if (d.mode !== 'map') d.mode = 'draw'
  d.nodes.forEach(function (n) { if (!n.k) n.k = '' })
  return d
}
function wbSave() { if (!WB) return; try { localStorage.setItem(wbKey(), JSON.stringify(WB)) } catch (e) { /* 存不下不致命 */ } }
function wbSaveSoon() { if (WB_T) clearTimeout(WB_T); WB_T = setTimeout(function () { WB_T = null; wbSave() }, 350) }
function wbNodeById(id) {
  for (var i = 0; i < WB.nodes.length; i++) if (WB.nodes[i].id === id) return WB.nodes[i]
  return null
}
function wbNewId() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) }

/* 旧数据迁移：把 x/y/w（比例）按当前画布尺寸换成世界像素，卡片高度给个默认值。只跑一次。 */
function wbMigrate() {
  if (!WB || WB._px) return
  var el = $('wb')
  var r = el ? el.getBoundingClientRect() : null
  var vw = (r && r.width) || 900, vh = (r && r.height) || 560
  WB.nodes.forEach(function (n) {
    if (n.px == null) {
      n.px = Math.max(0, (Number(n.x) || 0) * vw)
      n.py = Math.max(0, (Number(n.y) || 0) * vh)
      n.pw = Math.max(120, (Number(n.w) || 0.19) * vw)
      n.ph = n.h ? Math.max(60, n.h * vh) : 124
    }
    delete n.x; delete n.y; delete n.w; delete n.h
  })
  WB._px = true
  wbSave()
}

function wbToolsHtml() {
  var m = WB.mode
  var h = '<div class="wb-tools">'
  h += '<span class="wb-grp">' +
    '<button class="ghost sm' + (m === 'draw' ? ' is-on' : '') + '" data-wbm="draw" type="button">✎ 自由画板</button>' +
    '<button class="ghost sm' + (m === 'map' ? ' is-on' : '') + '" data-wbm="map" type="button">▦ 白板</button></span>'
  if (m === 'draw') {
    h += '<span class="wb-grp">' + WB_COLORS.map(function (c) {
      return '<button class="wb-swatch' + (!WB.eraser && WB.color === c ? ' is-on' : '') + '" data-wbc="' + c + '" type="button" title="' + c + '" style="background:' + c + '"></button>'
    }).join('') + '</span>'
    h += '<span class="wb-grp">' + WB_WIDTHS.map(function (w) {
      return '<button class="ghost sm wb-w' + (WB.width === w.v ? ' is-on' : '') + '" data-wbw="' + w.v + '" type="button">' + w.t + '</button>'
    }).join('') + '</span>'
    h += '<button class="ghost sm' + (WB.eraser ? ' is-on' : '') + '" id="wb-eraser" type="button">橡皮</button>'
    h += '<button class="ghost sm" id="wb-undo" type="button">撤销</button>'
    h += '<button class="ghost sm" id="wb-clear" type="button" title="清空全部笔画">清空</button>'
  h += '<button class="ghost sm' + (WB.pan ? ' is-on' : '') + '" id="wb-pan" type="button" title="切到拖动：画布可以拖着走，光标恢复正常">' + (WB.pan ? '✎ 画笔' : '✋ 拖动') + '</button>'
  } else {
    h += '<button class="ghost sm" id="wb-add" type="button">＋ 卡片</button>'
    h += '<button class="ghost sm' + (WB.linkMode ? ' is-on' : '') + '" id="wb-link" type="button">连线</button>'
    h += '<button class="ghost sm" id="wb-del" type="button">删除选中</button>'
    h += '<span class="wb-grp wb-nk">' + WB_NK.map(function (c) {
      var on = (WB.sel ? (wbNodeById(WB.sel) || {}).k : WB.nodeK) === c.k
      return '<button class="wb-swatch wb-swatch-sq' + (on ? ' is-on' : '') + '" data-wbnk="' + c.k + '" type="button" title="' + c.t + '" style="background:' + (WB_NK_BG[c.k] || 'var(--paper)') + '"></button>'
    }).join('') + '</span>'
    h += '<button class="ghost sm" id="wb-clearmap" type="button">清空白板</button>'
  }
  h += '<button class="ghost sm" id="wb-export" type="button">导出 PNG</button>'
  h += '</div>'
  return h
}

function boxBoard() {
  if (!WB) WB = wbLoad()
  var box = $('tbl-body')
  var hint = WB.mode === 'draw'
    ? (WB.pan ? '现在是指针模式：拖空白平移画布，卡片也能拖、能改大小、能拖连线（和白板一样），但左键不画画。点「✎ 画笔」继续画。' : '按住拖动画线；滚轮缩放，右键拖动平移，也可以点「✋ 拖动」把左键换成拖动。画的东西按本子自动存，下次开这一本还在。')
    : '双击空白出卡片；拖卡片移动，拖右下角改大小；悬停卡片四边的圆点拖出连线。滚轮缩放、拖空白处平移（右键拖动也可以）。'
  box.innerHTML = wbToolsHtml() +
    '<div class="wb" id="wb" data-mode="' + WB.mode + '" data-pan="' + (WB.pan ? '1' : '0') + '">' +
      '<div class="wb-world" id="wb-world">' +
        '<canvas class="wb-cv" id="wb-cv"></canvas>' +
        '<div class="wb-nodes" id="wb-nodes"></div>' +
      '</div>' +
      '<div class="wb-zoom">' +
        '<button type="button" data-wbz="out" title="缩小">−</button>' +
        '<button type="button" data-wbz="fit" id="wb-zoom-l" title="适应窗口">100%</button>' +
        '<button type="button" data-wbz="in" title="放大">＋</button>' +
      '</div>' +
    '</div>' +
    '<p class="readhint wb-hint">' + hint + '</p>'
  wbBind()
  wbSize()
  wbMigrate()
  wbRender()
  if (!WB.view) wbFit(); else wbApplyView()
}

function wbViewEl() { return $('wb-world') }
function wbViewport() { var el = $('wb'); return el ? el.getBoundingClientRect() : null }
function wbApplyView() {
  var el = wbViewEl()
  if (!el || !WB) return
  var v = WB.view = WB.view || { x: 0, y: 0, z: 1 }
  el.style.transform = 'translate(' + v.x.toFixed(2) + 'px,' + v.y.toFixed(2) + 'px) scale(' + v.z.toFixed(4) + ')'
  var zl = $('wb-zoom-l')
  if (zl) zl.textContent = Math.round(v.z * 100) + '%'
}
/* 适应窗口：有卡片就框住所有卡片（空板才框整张 2400×1500），否则一进来 26% 字小到看不清。 */
function wbFit() {
  var vp = wbViewport()
  if (!vp || !vp.width || !WB) return
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  (WB.nodes || []).forEach(function (n) {
    x0 = Math.min(x0, n.px); y0 = Math.min(y0, n.py)
    x1 = Math.max(x1, n.px + (n.pw || 220)); y1 = Math.max(y1, n.py + (n.ph || 132))
  });
  (WB.strokes || []).forEach(function (s) {
    (s.pts || []).forEach(function (p) {
      x0 = Math.min(x0, p[0] * WB_W); y0 = Math.min(y0, p[1] * WB_H)
      x1 = Math.max(x1, p[0] * WB_W); y1 = Math.max(y1, p[1] * WB_H)
    })
  })
  var has = isFinite(x0) && isFinite(y0) && x1 > x0 && y1 > y0
  var z, w, h
  if (!has) {
    /* 空板：别为了框住整张 2400×1500 缩到 37%，按 100% 摆在世界中间，落笔大小才正常。 */
    z = 1; w = vp.width; h = vp.height; x0 = (WB_W - w) / 2; y0 = (WB_H - h) / 2
  } else {
    var pad = 90
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    w = Math.max(120, x1 - x0); h = Math.max(90, y1 - y0)
    z = Math.max(0.18, Math.min(1.6, Math.min((vp.width - 30) / w, (vp.height - 30) / h)))
  }
  WB.view = { x: (vp.width - w * z) / 2 - x0 * z, y: (vp.height - h * z) / 2 - y0 * z, z: z }
  wbApplyView(); wbSaveSoon()
}
function wbZoomAt(cx, cy, z2) {
  var vp = wbViewport()
  if (!vp || !WB) return
  var v = WB.view = WB.view || { x: 0, y: 0, z: 1 }
  z2 = Math.max(0.2, Math.min(3, z2))
  var px = cx - vp.left, py = cy - vp.top
  var wx = (px - v.x) / v.z, wy = (py - v.y) / v.z
  v.x = px - wx * z2
  v.y = py - wy * z2
  v.z = z2
  wbApplyView(); wbSaveSoon()
}
function wbCenterPos() {
  var vp = wbViewport()
  var v = (WB && WB.view) || { x: 0, y: 0, z: 1 }
  if (!vp) return { x: 0.5, y: 0.5 }
  return { x: ((vp.width / 2 - v.x) / v.z) / WB_W, y: ((vp.height / 2 - v.y) / v.z) / WB_H }
}

/* canvas 固定按世界尺寸 × dpr 建一次，所有笔画用世界像素画；缩放交给外层 transform。 */
function wbSize() {
  var cv = $('wb-cv')
  if (!cv) return null
  var dpr = Math.min(2, window.devicePixelRatio || 1)
  var w = Math.round(WB_W * dpr), h = Math.round(WB_H * dpr)
  if (cv.width !== w || cv.height !== h) {
    cv.width = w; cv.height = h
    cv.style.width = WB_W + 'px'; cv.style.height = WB_H + 'px'
  }
  var ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { w: WB_W, h: WB_H, ctx: ctx }
}

function wbStrokeOn(ctx, s, W, H) {
  var pts = s.pts || []
  if (!pts.length) return
  var lw = Math.max(1, (Number(s.w) || 0.004) * W)
  ctx.save()
  ctx.globalCompositeOperation = s.e ? 'destination-out' : 'source-over'
  ctx.strokeStyle = s.c || '#1a1710'
  ctx.fillStyle = s.c || '#1a1710'
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (pts.length === 1) {
    ctx.beginPath()
    ctx.arc(pts[0][0] * W, pts[0][1] * H, lw / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.moveTo(pts[0][0] * W, pts[0][1] * H)
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * W, pts[i][1] * H)
    ctx.stroke()
  }
  ctx.restore()
}

function wbPaint() {
  var z = wbSize()
  if (!z) return
  var ctx = z.ctx
  ctx.clearRect(0, 0, z.w, z.h)
  WB.strokes.forEach(function (s) { wbStrokeOn(ctx, s, z.w, z.h) })
  wbPaintLinks(ctx, z.w, z.h)
  wbPaintDrag(ctx)
}

/* 连线落点：沿两张卡中心的连线，各自求与卡片矩形边框的交点 —— 边到边，线不会从卡片中心穿出来，
   也不会为了绕开而鼓出一大圈。2026-11-21 用户对着 Obsidian Canvas 说「就用那种类型的」，改成这种干净的直线。 */
function wbEdge(cx, cy, hw, hh, tx, ty) {
  var dx = tx - cx, dy = ty - cy
  if (!dx && !dy) return { x: cx, y: cy }
  var sx = dx ? hw / Math.abs(dx) : Infinity
  var sy = dy ? hh / Math.abs(dy) : Infinity
  var t = Math.min(sx, sy)
  return { x: cx + dx * t, y: cy + dy * t }
}
function wbArrow(ctx, fx, fy, tx, ty) {
  var dx = tx - fx, dy = ty - fy
  var len = Math.hypot(dx, dy) || 1
  dx /= len; dy /= len
  var ah = 8, aw = 4.6
  var bx = tx - dx * ah, by = ty - dy * ah
  ctx.beginPath()
  ctx.moveTo(tx, ty)
  ctx.lineTo(bx - dy * aw, by + dx * aw)
  ctx.lineTo(bx + dy * aw, by - dx * aw)
  ctx.closePath()
  ctx.fill()
}
/* 一条直的连线，只有终点带箭头（起点卡 → 终点卡）。 */
function wbLinkDraw(ctx, p1, p2) {
  ctx.beginPath()
  ctx.moveTo(p1.x, p1.y)
  ctx.lineTo(p2.x, p2.y)
  ctx.stroke()
  wbArrow(ctx, p1.x, p1.y, p2.x, p2.y)
}
/* 连线画在 canvas 上（世界像素），卡片位置直接读 offset*，不受缩放影响。 */
function wbPaintLinks(ctx) {
  if (!WB.links.length) return
  var layer = $('wb-nodes')
  if (!layer) return
  WB.links.forEach(function (l) {
    var ea = layer.querySelector('.wb-node[data-id="' + l.a + '"]')
    var eb = layer.querySelector('.wb-node[data-id="' + l.b + '"]')
    if (!ea || !eb) return
    var ax = ea.offsetLeft + ea.offsetWidth / 2, ay = ea.offsetTop + ea.offsetHeight / 2
    var bx = eb.offsetLeft + eb.offsetWidth / 2, by = eb.offsetTop + eb.offsetHeight / 2
    var p1 = wbEdge(ax, ay, ea.offsetWidth / 2, ea.offsetHeight / 2, bx, by)
    var p2 = wbEdge(bx, by, eb.offsetWidth / 2, eb.offsetHeight / 2, ax, ay)
    ctx.save()
    ctx.strokeStyle = 'rgba(120, 96, 58, 0.62)'
    ctx.fillStyle = 'rgba(120, 96, 58, 0.8)'
    ctx.lineWidth = 1.5
    wbLinkDraw(ctx, p1, p2)
    ctx.restore()
  })
}

function wbRenderNodes() {
  var layer = $('wb-nodes')
  if (!layer) return
  layer.innerHTML = WB.nodes.map(function (n) {
    var cls = 'wb-node' + (WB.sel === n.id ? ' is-sel' : '') + (WB.linkFrom === n.id ? ' is-from' : '') + (n.k ? ' k-' + n.k : '')
    var w = Math.max(110, Number(n.pw) || 200), h = Math.max(56, Number(n.ph) || 124)
    return '<div class="' + cls + '" data-id="' + n.id + '" style="left:' + Math.round(n.px) + 'px;top:' + Math.round(n.py) + 'px;width:' + Math.round(w) + 'px;height:' + Math.round(h) + 'px">' +
      '<span class="wb-node-t">' + esc(n.text || '新想法') + '</span>' +
      '<span class="wb-hdl" data-side="n" title="拖到另一张卡连线"></span>' +
      '<span class="wb-hdl" data-side="s" title="拖到另一张卡连线"></span>' +
      '<span class="wb-hdl" data-side="w" title="拖到另一张卡连线"></span>' +
      '<span class="wb-hdl" data-side="e" title="拖到另一张卡连线"></span>' +
      '<span class="wb-rz" title="拖动改大小"></span></div>'
  }).join('')
  wbBindNodes()
}
function wbRender() { wbRenderNodes(); wbPaint() }

/* 指针 → 世界像素（顺带给归一化坐标，画笔笔画仍按 0..1 存）。 */
function wbPos(ev) {
  var el = wbViewEl()
  if (!el) return { x: 0, y: 0, w: WB_W, h: WB_H, z: 1 }
  var r = el.getBoundingClientRect()
  var z = (WB && WB.view && WB.view.z) || 1
  var x = (ev.clientX - r.left) / (r.width || 1)
  var y = (ev.clientY - r.top) / (r.height || 1)
  return {
    x: Math.max(-0.5, Math.min(1.5, x)),
    y: Math.max(-0.5, Math.min(1.5, y)),
    w: WB_W,
    h: WB_H,
    z: z
  }
}

function wbAddNode(x, y) {
  if (!WB) return null
  var pw = 220, ph = 132
  var n = {
    id: wbNewId(),
    px: Math.max(0, Math.min(WB_W - pw, x * WB_W - pw / 2)),
    py: Math.max(0, Math.min(WB_H - ph, y * WB_H - ph / 2)),
    pw: pw, ph: ph,
    k: WB.nodeK || '',
    text: '新想法'
  }
  WB.nodes.push(n)
  WB.sel = n.id
  wbSave()
  wbRender()
  return n
}

/* 连线：去重、禁自连。方向 = 起点卡 → 终点卡（先点谁谁就是起点，拖拽时按下的是起点）。 */
function wbLinkAdd(a, b) {
  if (!a || !b || a === b) return false
  var dup = WB.links.some(function (l) {
    return (l.a === a && l.b === b) || (l.a === b && l.b === a)
  })
  if (dup) return false
  WB.links.push({ a: a, b: b })
  wbSave()
  return true
}
function wbNodeClick(n) {
  if (WB.linkMode) {
    if (WB.skipClick) { WB.skipClick = false; return }
    if (!WB.linkFrom) { WB.linkFrom = n.id }
    else if (WB.linkFrom !== n.id) {
      wbLinkAdd(WB.linkFrom, n.id)
      WB.linkFrom = null
    }
    wbPaintSel()
    return
  }
  WB.sel = n.id
  wbSaveSoon()
  wbPaintSel()
}

/* 选中态只改 class，不重建 DOM（重建会让紧接着的 dblclick 落在被丢弃的旧元素上）。 */
function wbPaintSel() {
  var layer = $('wb-nodes')
  if (!layer) return
  Array.prototype.forEach.call(layer.querySelectorAll('.wb-node'), function (el) {
    var id = el.getAttribute('data-id')
    if (WB.sel === id) el.classList.add('is-sel'); else el.classList.remove('is-sel')
    if (WB.linkFrom === id) el.classList.add('is-from'); else el.classList.remove('is-from')
  })
  wbPaint()
}

function wbEditNode(el, n) {
  var t = el.querySelector('.wb-node-t')
  if (!t) return
  t.contentEditable = 'true'
  t.focus()
  try {
    var rng = document.createRange()
    rng.selectNodeContents(t)
    var sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(rng)
  } catch (e) {}
  function done() {
    t.contentEditable = 'false'
    n.text = (t.textContent || '').replace(/\s+/g, ' ').trim() || '新想法'
    t.textContent = n.text
    t.removeEventListener('blur', done)
    t.removeEventListener('keydown', onkey)
    wbSave()
    /* 这里不要 wbRenderNodes()：blur 常常发生在 pointerdown 的捕获阶段，重建卡片 DOM 会把
       正在被按下的那个元素换掉，后续 pointermove/pointerup 找不到它 → 看着像「选了但拖不动」。 */
    wbPaint()
  }
  function onkey(ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); t.blur() } }
  t.addEventListener('blur', done)
  t.addEventListener('keydown', onkey)
}

/* 卡片只在白板模式里能碰；画板模式点「✋ 拖动」后也一样（此时左键不画画，卡片照白板的手势用）。 */
function wbCardOn() { return WB.mode === 'map' || !!WB.pan }

function wbBindNodes() {
  var layer = $('wb-nodes')
  if (!layer) return
  var zNow = function () { return (WB.view && WB.view.z) || 1 }
  Array.prototype.forEach.call(layer.querySelectorAll('.wb-node'), function (el) {
    var n = wbNodeById(el.getAttribute('data-id'))
    if (!n) return
    el.addEventListener('pointerdown', function (ev) {
      if (!wbCardOn()) return
      if (ev.target && ev.target.classList && ev.target.classList.contains('wb-rz')) return
      ev.preventDefault(); ev.stopPropagation()
      if (WB.linkMode) {
        var lx = ev.clientX, ly = ev.clientY, dragged = false
        function lm(e) {
          if (!dragged && (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly)) > 3) dragged = true
        }
        function lu(e) {
          document.removeEventListener('pointermove', lm)
          document.removeEventListener('pointerup', lu)
          if (!dragged) {
            wbNodeClick(n)
            WB.skipClick = true
            setTimeout(function () { WB.skipClick = false }, 0)
            return
          }
          var hit = document.elementFromPoint(e.clientX, e.clientY)
          var card = hit && hit.closest ? hit.closest('.wb-node') : null
          var to = card ? card.getAttribute('data-id') : null
          if (to && to !== n.id) {
            wbLinkAdd(n.id, to)
            WB.linkFrom = null
            WB.skipClick = true
            wbPaintSel()
            wbPaint()
          }
        }
        document.addEventListener('pointermove', lm)
        document.addEventListener('pointerup', lu)
        return
      }
      var sx = ev.clientX, sy = ev.clientY, ox = n.px, oy = n.py, moved = false
      function mv(e) {
        var dx = e.clientX - sx, dy = e.clientY - sy
        if (!moved && (Math.abs(dx) + Math.abs(dy)) > 3) moved = true
        if (!moved) return
        var z = zNow()
        n.px = Math.max(0, Math.min(WB_W - n.pw, ox + dx / z))
        n.py = Math.max(0, Math.min(WB_H - n.ph, oy + dy / z))
        el.style.left = Math.round(n.px) + 'px'
        el.style.top = Math.round(n.py) + 'px'
        wbPaint()
      }
      function up() {
        document.removeEventListener('pointermove', mv)
        document.removeEventListener('pointerup', up)
        if (moved) { wbSaveSoon(); wbRenderNodes(); wbPaint() }
        else wbNodeClick(n)
      }
      document.addEventListener('pointermove', mv)
      document.addEventListener('pointerup', up)
    })
    Array.prototype.forEach.call(el.querySelectorAll('.wb-hdl'), function (h) {
      h.addEventListener('pointerdown', function (ev) {
        if (!wbCardOn()) return
        ev.preventDefault(); ev.stopPropagation()
        var side = h.getAttribute('data-side')
        var cx = el.offsetLeft + el.offsetWidth / 2, cy = el.offsetTop + el.offsetHeight / 2
        var sx = cx, sy = cy
        if (side === 'n') { sx = cx; sy = el.offsetTop }
        if (side === 's') { sx = cx; sy = el.offsetTop + el.offsetHeight }
        if (side === 'w') { sx = el.offsetLeft; sy = cy }
        if (side === 'e') { sx = el.offsetLeft + el.offsetWidth; sy = cy }
        WB.linkFrom = n.id
        WB.linkDrag = { x: sx, y: sy, tx: sx, ty: sy }
        wbPaintSel(); wbPaint()
        function mv(e) {
          var p = wbPos(e)
          WB.linkDrag.tx = p.x * WB_W
          WB.linkDrag.ty = p.y * WB_H
          wbMarkDrop(e.clientX, e.clientY, n.id)
          wbPaint()
        }
        function up(e) {
          document.removeEventListener('pointermove', mv)
          document.removeEventListener('pointerup', up)
          var hit = document.elementFromPoint(e.clientX, e.clientY)
          var card = hit && hit.closest ? hit.closest('.wb-node') : null
          var to = card ? card.getAttribute('data-id') : null
          WB.linkDrag = null
          wbMarkDrop(-1, -1, null)
          if (to && to !== n.id) wbLinkAdd(n.id, to)
          WB.linkFrom = null
          WB.skipClick = true
          setTimeout(function () { WB.skipClick = false }, 0)
          wbRender()
        }
        document.addEventListener('pointermove', mv)
        document.addEventListener('pointerup', up)
      })
    })
    Array.prototype.forEach.call(el.querySelectorAll('.wb-rz'), function (rz) {
      rz.addEventListener('pointerdown', function (ev) {
        if (!wbCardOn()) return
        ev.preventDefault(); ev.stopPropagation()
        var sx = ev.clientX, sy = ev.clientY, ow = n.pw, oh = n.ph
        function mv(e) {
          var z = zNow()
          n.pw = Math.max(120, Math.min(720, ow + (e.clientX - sx) / z))
          n.ph = Math.max(64, Math.min(520, oh + (e.clientY - sy) / z))
          el.style.width = Math.round(n.pw) + 'px'
          el.style.height = Math.round(n.ph) + 'px'
          wbPaint()
        }
        function up() {
          document.removeEventListener('pointermove', mv)
          document.removeEventListener('pointerup', up)
          wbSaveSoon(); wbRenderNodes(); wbPaint()
        }
        document.addEventListener('pointermove', mv)
        document.addEventListener('pointerup', up)
      })
    })
    el.addEventListener('dblclick', function (ev) {
      if (!wbCardOn()) return
      ev.preventDefault(); ev.stopPropagation()
      wbEditNode(el, n)
    })
  })
}

function wbMarkDrop(cx, cy, selfId) {
  var layer = $('wb-nodes')
  if (!layer) return
  var hit = cx >= 0 ? document.elementFromPoint(cx, cy) : null
  var card = hit && hit.closest ? hit.closest('.wb-node') : null
  var id = card ? card.getAttribute('data-id') : null
  Array.prototype.forEach.call(layer.querySelectorAll('.wb-node'), function (el) {
    if (id && id !== selfId && el.getAttribute('data-id') === id) el.classList.add('is-drop')
    else el.classList.remove('is-drop')
  })
}
/* 半途的连线：从起手那个圆点拉一条虚线到指针处，并画一个小圆点跟着走 */
function wbPaintDrag(ctx) {
  var d = WB.linkDrag
  if (!d) return
  ctx.save()
  ctx.strokeStyle = 'rgba(166, 58, 43, 0.55)'
  ctx.fillStyle = 'rgba(166, 58, 43, 0.65)'
  ctx.lineWidth = 1.3 / ((WB.view && WB.view.z) || 1) * 1.2
  ctx.setLineDash([5, 4])
  ctx.beginPath()
  ctx.moveTo(d.x, d.y)
  ctx.lineTo(d.tx, d.ty)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.arc(d.tx, d.ty, 3, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function wbBind() {
  var cv = $('wb-cv')
  var box = $('tbl-body')
  Array.prototype.forEach.call(box.querySelectorAll('[data-wbm]'), function (b) {
    b.addEventListener('click', function () {
      WB.mode = b.getAttribute('data-wbm') === 'map' ? 'map' : 'draw'
      WB.linkMode = false
      WB.linkFrom = null
      wbSave()
      boxBoard()
    })
  })
  Array.prototype.forEach.call(box.querySelectorAll('[data-wbc]'), function (b) {
    b.addEventListener('click', function () { WB.color = b.getAttribute('data-wbc'); WB.eraser = false; wbSave(); boxBoard() })
  })
  Array.prototype.forEach.call(box.querySelectorAll('[data-wbw]'), function (b) {
    b.addEventListener('click', function () { WB.width = Number(b.getAttribute('data-wbw')) || 4.5; WB.eraser = false; wbSave(); boxBoard() })
  })
  Array.prototype.forEach.call(box.querySelectorAll('[data-wbnk]'), function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-wbnk') || ''
      var n = WB.sel ? wbNodeById(WB.sel) : null
      if (n) n.k = k
      else WB.nodeK = k
      wbSave()
      wbRender()
    })
  })
  Array.prototype.forEach.call(box.querySelectorAll('[data-wbz]'), function (b) {
    b.addEventListener('click', function () {
      var act = b.getAttribute('data-wbz')
      if (act === 'fit') { wbFit(); return }
      var vp = wbViewport()
      if (!vp) return
      wbZoomAt(vp.left + vp.width / 2, vp.top + vp.height / 2, ((WB.view && WB.view.z) || 1) * (act === 'in' ? 1.25 : 0.8))
    })
  })
  function on(id, fn) { var b = $(id); if (b) b.addEventListener('click', fn) }
  on('wb-eraser', function () { WB.eraser = !WB.eraser; wbSave(); boxBoard() })
  on('wb-undo', function () {
    if (!WB.strokes.length) { if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('没有可撤销的笔画'); return }
    WB.strokes.pop(); wbSave(); wbPaint()
  })
  on('wb-clear', function () {
    if (!WB.strokes.length) return
    if (!window.confirm('清掉白板上的全部笔画？（卡片和连线不动）')) return
    WB.strokes = []; wbSave(); wbPaint()
  })
  on('wb-pan', function () { WB.pan = !WB.pan; WB_DRAW = null; wbSave(); boxBoard() })
  on('wb-add', function () { var c = wbCenterPos(); wbAddNode(c.x, c.y) })
  on('wb-link', function () {
    WB.linkMode = !WB.linkMode
    WB.linkFrom = null
    wbSave(); boxBoard()
  })
  on('wb-del', function () {
    if (!WB.sel) { if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('先点一张卡片选中它'); return }
    WB.nodes = WB.nodes.filter(function (n) { return n.id !== WB.sel })
    WB.links = WB.links.filter(function (l) { return l.a !== WB.sel && l.b !== WB.sel })
    WB.sel = null
    wbSave(); wbRender()
  })
  on('wb-clearmap', function () {
    if (!WB.nodes.length) return
    if (!window.confirm('清掉全部卡片和连线？（画笔笔画不动）')) return
    WB.nodes = []; WB.links = []; WB.sel = null; WB.linkFrom = null
    wbSave(); wbRender()
  })
  on('wb-export', wbExport)
  var wbEl = $('wb')
  if (wbEl) {
    /* 点画布/别的卡片时把正在改字的卡片收工：canvas 的 pointerdown 会 preventDefault，焦点不会自己走，
       不显式 blur 就会一直停留在 contenteditable 里（文字保持全选高亮，继续打字还在改那张卡）。 */
    wbEl.addEventListener('pointerdown', function (ev) {
      var ae = document.activeElement
      if (!ae || !ae.isContentEditable) return
      var t = ev.target
      if (t === ae || (t && t.closest && t.closest('.wb-node-t') === ae)) return
      ae.blur()
    }, true)
    /* 卡片文字被选中后按住会起原生拖拽（dragstart），pointermove 就不再来了 —— 拖画布会变成拖文字。 */
    wbEl.addEventListener('dragstart', function (ev) { ev.preventDefault() })
    wbEl.addEventListener('contextmenu', function (ev) { ev.preventDefault() })
    wbEl.addEventListener('wheel', function (ev) {
      ev.preventDefault()
      var z = (WB.view && WB.view.z) || 1
      var f = Math.exp(-ev.deltaY * 0.0016)
      wbZoomAt(ev.clientX, ev.clientY, z * f)
    }, { passive: false })
  }
  if (!cv) return
  /* 手势挂在整个取景框上，不是只挂 canvas：世界 2400×1500，平移到世界外面时那块是 .wb 的空白，
     挂在 canvas 上就只有世界范围内能拖，于是「最边上那张卡以外的画布拖不动」。 */
  var frame = $('wb') || cv
  frame.addEventListener('pointerdown', function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest('.wb-zoom')) return
    // 画板模式左键 = 画；白板模式左键空白 = 平移；两种模式都可以右键/中键拖动平移
    var draw = WB.mode === 'draw' && ev.button === 0 && !WB.pan
    if (draw) {
      ev.preventDefault()
      var p = wbPos(ev)
      var px0 = Math.max(0, Math.min(1, p.x)), py0 = Math.max(0, Math.min(1, p.y))
      WB_DRAW = { c: WB.color, w: Math.max(0.0006, (WB.eraser ? 18 : WB.width) / WB_W), e: !!WB.eraser, pts: [[px0, py0]] }
      WB.strokes.push(WB_DRAW)
      try { cv.setPointerCapture(ev.pointerId) } catch (e) {}
      wbPaint()
      return
    }
    if (ev.button !== 0 && ev.button !== 1 && ev.button !== 2) return
    ev.preventDefault()
    var wbEl2 = $('wb')
    if (wbEl2) wbEl2.classList.add('is-drag')
    var v = WB.view = WB.view || { x: 0, y: 0, z: 1 }
    var vx = v.x, vy = v.y, sx = ev.clientX, sy = ev.clientY, moved = false
    function pm(e) {
      var dx = e.clientX - sx, dy = e.clientY - sy
      if (!moved && (Math.abs(dx) + Math.abs(dy)) > 3) moved = true
      if (!moved) return
      v.x = vx + dx; v.y = vy + dy
      wbApplyView()
    }
    function pu() {
      document.removeEventListener('pointermove', pm)
      document.removeEventListener('pointerup', pu)
      if (wbEl2) wbEl2.classList.remove('is-drag')
      if (moved) { WB_LASTPAN = Date.now(); wbSaveSoon() }
      else if (WB.mode === 'map') { WB.sel = null; wbPaintSel() }
    }
    document.addEventListener('pointermove', pm)
    document.addEventListener('pointerup', pu)
  })
  cv.addEventListener('pointermove', function (ev) {
    if (!WB_DRAW) return
    var p = wbPos(ev)
    var last = WB_DRAW.pts[WB_DRAW.pts.length - 1]
    var dx = (p.x - last[0]) * WB_W, dy = (p.y - last[1]) * WB_H
    if (dx * dx + dy * dy < 4) return
    WB_DRAW.pts.push([Math.max(0, Math.min(1, p.x)), Math.max(0, Math.min(1, p.y))])
    wbPaint()
  })
  cv.addEventListener('pointerup', wbEndStroke)
  cv.addEventListener('pointercancel', wbEndStroke)
  cv.addEventListener('pointerleave', function (ev) { if (WB_DRAW && ev.buttons === 0) wbEndStroke() })
  frame.addEventListener('dblclick', function (ev) {
    if (WB.mode !== 'map') return
    if (ev.target && ev.target.closest && ev.target.closest('.wb-zoom')) return
    if (Date.now() - WB_LASTPAN < 320) return
    ev.preventDefault()
    var p = wbPos(ev)
    wbAddNode(p.x, p.y)
  })
}
function wbEndStroke() { if (!WB_DRAW) return; WB_DRAW = null; wbSaveSoon() }

/* 导出：白底 + 笔画 + 卡片 + 连线，1600×1000（世界是 2400×1500，等比缩）。 */
function wbExport() {
  var W = 1600, H = 1000, k = W / WB_W
  var cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  var ctx = cv.getContext('2d')
  var bg = '#f7f2e7'
  try {
    var cs = getComputedStyle(document.documentElement)
    var pv = (cs.getPropertyValue('--paper') || '').trim()
    if (/^#|^rgb/.test(pv)) bg = pv
  } catch (e) {}
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  var layer = document.createElement('canvas')
  layer.width = W; layer.height = H
  var lctx = layer.getContext('2d')
  WB.strokes.forEach(function (s) { wbStrokeOn(lctx, s, W, H) })
  ctx.drawImage(layer, 0, 0)
  WB.links.forEach(function (l) {
    var a = wbNodeById(l.a), b = wbNodeById(l.b)
    if (!a || !b) return
    var ax = (a.px + a.pw / 2) * k, ay = (a.py + a.ph / 2) * k
    var bx = (b.px + b.pw / 2) * k, by = (b.py + b.ph / 2) * k
    var p1 = wbEdge(ax, ay, a.pw * k / 2, a.ph * k / 2, bx, by)
    var p2 = wbEdge(bx, by, b.pw * k / 2, b.ph * k / 2, ax, ay)
    ctx.save()
    ctx.strokeStyle = 'rgba(120, 96, 58, 0.62)'
    ctx.fillStyle = 'rgba(120, 96, 58, 0.8)'
    ctx.lineWidth = 1.6
    wbLinkDraw(ctx, p1, p2)
    ctx.restore()
  })
  WB.nodes.forEach(function (n) {
    var x = n.px * k, y = n.py * k, w = n.pw * k, h = n.ph * k
    ctx.fillStyle = WB_NK_BG[n.k] || 'rgba(255, 252, 244, 0.94)'
    ctx.strokeStyle = 'rgba(26, 23, 16, 0.35)'
    ctx.lineWidth = 1.6
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 4); else ctx.rect(x, y, w, h)
    ctx.fill(); ctx.stroke()
    ctx.save()
    ctx.beginPath(); ctx.rect(x + 6, y + 6, w - 12, h - 12); ctx.clip()
    ctx.fillStyle = '#1a1710'
    ctx.font = '18px "Songti SC", "Noto Serif SC", serif'
    var txt = String(n.text || '新想法')
    var chars = Math.max(4, Math.floor((w - 22) / 18))
    for (var i = 0, line = 0; i < txt.length && line < Math.floor((h - 24) / 26); i += chars, line++) {
      ctx.fillText(txt.slice(i, i + chars), x + 11, y + 26 + line * 26)
    }
    ctx.restore()
  })
  var name = (M && M.c && (M.c.title || M.c.folder) ? String(M.c.title || M.c.folder) : '白板')
  var a = document.createElement('a')
  a.download = '白板-' + name + '.png'
  a.href = cv.toDataURL('image/png')
  document.body.appendChild(a)
  a.click()
  setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a) }, 0)
  if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('白板已导出 PNG')
}

/* ---------- 表格：自己建、表头自己填（2026-11-20，用户 m01037） ----------
   线下白板上那张「几点 · 谁 · 在哪儿 · 做什么」的表，这里给一张空纸自己画格子：
   表头、行、列都由玩家现填，没有预置内容（只有「时间线」「空白」两个起点）。
   同样按本子另存：gd:grids:<root|folder>。 */
var GKEY = 'gd:grids:'
var GRIDS = null
var G_T = null

function gridsKey() { return GKEY + S.root + '|' + S.folder }
function gridsLoad() {
  var d = { grids: [] }
  try {
    var raw = localStorage.getItem(gridsKey())
    if (raw) {
      var g = JSON.parse(raw)
      if (g && Array.isArray(g.grids)) d = g
    }
  } catch (e) {}
  if (!Array.isArray(d.grids)) d.grids = []
  return d
}
function gSave() { if (!GRIDS) return; try { localStorage.setItem(gridsKey(), JSON.stringify(GRIDS)) } catch (e) {} }
function gSaveSoon() { if (G_T) clearTimeout(G_T); G_T = setTimeout(function () { G_T = null; gSave() }, 300) }
function gridById(id) {
  if (!GRIDS) return null
  for (var i = 0; i < GRIDS.grids.length; i++) if (GRIDS.grids[i].id === id) return GRIDS.grids[i]
  return null
}
function gridNew(kind) {
  var id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  var g
  if (kind === 'time') {
    g = { id: id, title: '时间线', cols: ['时间', '人物', '地点', '做什么'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] }
  } else {
    g = { id: id, title: '新表', cols: ['', '', ''], rows: [['', '', ''], ['', '', ''], ['', '', '']] }
  }
  GRIDS.grids.push(g)
  gSave()
  boxGrids()
}

function gridHtml(g) {
  var h = '<section class="gd-grid" data-gid="' + g.id + '">'
  h += '<div class="gd-grid-head"><input class="gd-grid-title" data-gid="' + g.id + '" value="' + esc(g.title || '') + '" aria-label="表格名字" />' +
    '<button class="gd-x" data-gact="del-grid" data-gid="' + g.id + '" type="button" title="删掉这张表">删表</button></div>'
  h += '<div class="gd-scroll"><table><thead><tr>'
  g.cols.forEach(function (c, i) {
    h += '<th><span class="gd-th" contenteditable="true" data-gid="' + g.id + '" data-col="' + i + '">' + esc(c) + '</span>' +
      '<button class="gd-x gd-colx" data-gact="del-col" data-gid="' + g.id + '" data-col="' + i + '" type="button" title="删这一列">×</button></th>'
  })
  h += '<th class="gd-addth"><button class="gd-x" data-gact="add-col" data-gid="' + g.id + '" type="button" title="加一列">＋列</button></th>'
  h += '</tr></thead><tbody>'
  g.rows.forEach(function (r, ri) {
    h += '<tr>'
    g.cols.forEach(function (c, ci) {
      h += '<td contenteditable="true" data-gid="' + g.id + '" data-r="' + ri + '" data-c="' + ci + '">' + esc(r[ci] || '') + '</td>'
    })
    h += '<td class="gd-xcell"><button class="gd-x" data-gact="del-row" data-gid="' + g.id + '" data-row="' + ri + '" type="button" title="删这一行">×</button></td>'
    h += '</tr>'
  })
  h += '</tbody></table></div>'
  h += '<div class="gd-grid-foot"><button class="ghost sm" data-gact="add-row" data-gid="' + g.id + '" type="button">＋ 行</button>' +
    '<span class="gd-tip">' + g.rows.length + ' 行 × ' + g.cols.length + ' 列</span></div></section>'
  return h
}

function boxGrids() {
  if (!GRIDS) GRIDS = gridsLoad()
  var box = $('tbl-body')
  var h = '<div class="gd-tools">' +
    '<button class="ghost sm" id="gd-add-time" type="button">＋ 时间线表</button>' +
    '<button class="ghost sm" id="gd-add-blank" type="button">＋ 空白表</button>' +
    '<span class="gd-tip">表头点一下就能改；每一格都是空的，自己填</span></div>'
  if (!GRIDS.grids.length) {
    h += '<p class="readhint">还没有表。线下那张白板怎么用，这里就怎么建：画一张「时间 / 人物 / 地点 / 做什么」，边玩边填。</p>'
  }
  h += GRIDS.grids.map(gridHtml).join('')
  box.innerHTML = h
  bindGrids()
}

function bindGrids() {
  var box = $('tbl-body')
  var at = $('gd-add-time'), ab = $('gd-add-blank')
  if (at) at.addEventListener('click', function () { gridNew('time') })
  if (ab) ab.addEventListener('click', function () { gridNew('blank') })
  // 绑定只做一次：#tbl-body 是常驻元素，每画一次都 addEventListener 会让「＋列」一次加四列（e2e 抓到过）
  if (box.getAttribute('data-gbound') === '1') return
  box.setAttribute('data-gbound', '1')
  // 输入：标题、表头、格子都靠 input 事件回写；debounce 存，打到一半崩了也只丢最后半秒
  box.addEventListener('input', function (ev) {
    var t = ev.target
    if (!t || !t.getAttribute) return
    var g = gridById(t.getAttribute('data-gid'))
    if (!g) return
    if (t.tagName === 'INPUT') { g.title = t.value; gSaveSoon(); return }
    // contenteditable 粘进来的可能是 <div>/<br>，收成纯文本再写回，别把 HTML 存进 local
    var v = t.textContent || ''
    if (/<[a-z][^>]*>/i.test(t.innerHTML || '')) t.textContent = v
    if (t.hasAttribute('data-col')) g.cols[Number(t.getAttribute('data-col'))] = v
    else if (t.hasAttribute('data-r')) {
      var ri = Number(t.getAttribute('data-r'))
      if (!g.rows[ri]) return
      g.rows[ri][Number(t.getAttribute('data-c'))] = v
    }
    gSaveSoon()
  })
  box.addEventListener('paste', function (ev) {
    var t = ev.target
    if (!t || !t.isContentEditable) return
    ev.preventDefault()
    var txt = (ev.clipboardData && ev.clipboardData.getData('text/plain')) || ''
    if (document.execCommand) document.execCommand('insertText', false, txt)
  })
  box.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-gact]') : null
    if (!b) return
    var g = gridById(b.getAttribute('data-gid'))
    if (!g) return
    var act = b.getAttribute('data-gact')
    if (act === 'add-row') {
      var row = []
      g.cols.forEach(function () { row.push('') })
      g.rows.push(row)
    } else if (act === 'del-row') {
      if (g.rows.length <= 1) { if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('至少留一行'); return }
      g.rows.splice(Number(b.getAttribute('data-row')), 1)
    } else if (act === 'add-col') {
      g.cols.push('')
      g.rows.forEach(function (r) { r.push('') })
    } else if (act === 'del-col') {
      if (g.cols.length <= 1) { if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('至少留一列'); return }
      var ci = Number(b.getAttribute('data-col'))
      g.cols.splice(ci, 1)
      g.rows.forEach(function (r) { r.splice(ci, 1) })
    } else if (act === 'del-grid') {
      if (!window.confirm('删掉「' + (g.title || '这张表') + '」？')) return
      GRIDS.grids = GRIDS.grids.filter(function (x) { return x.id !== g.id })
    } else return
    gSave()
    boxGrids()
  })
}

// 兼容垫片：app.js 仍按 window.GameTable 用它，一行都不用改。
if (typeof window !== 'undefined') window.GameTable = { open: open, close: close }
