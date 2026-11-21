// 游戏厅对局室：直接驱动宿主 /api/xgame（案卷台代打 dsh-xgame 工具），不回会话。
// 浏览器原生 ES module：纯 HTML 拼装已搬到 ./lib/arcadeui.js；末尾仍写 window.GameArcade 兼容垫片，app.js 一行都不用改。

import { tablesOf, logHtml, chipsHtml, formHtml, isSelectField, sideBodyHtml, resultText, metaOf } from './lib/arcadeui.js'

var API = '/game-desk/api'
var MODE = null
var S = null
var BUSY = false
var MODEL = ''
var ACT = 0

var ROOM_ERRS = {
  'room-waiting': '还没开局：等玩家到齐（房主可在局域网弹层点「强行开局」）',
  'room-empty': '房间里现在没人：链接还灵，进来一个人就能开这一局',
  'room-idle': '房间没开：让房主把「公网房间」拨到开',
  'remote-off': '机主没开放公网游玩（这一步要耗模型额度）',
  'remote-quota': '今天公网的额度用完了，明天再来',
  'remote-throttle': '慢一点，一秒一问',
}

var END_TOOLS = {
  detective_accuse: 1, detective_submit_theory: 1,
  party_accuse: 1, party_verdict: 1,
  loop_submit_plan: 1,
}

function rowsOf(tid) {
  if (!S.tables[tid]) {
    var t = tablesOf(MODE).filter(function (x) { return x.id === tid })[0]
    S.tables[tid] = t && t.seed ? t.seed.map(function (r) { return r.slice() }) : []
  }
  return S.tables[tid]
}
function autoRow(tid, cells) {
  var t = tablesOf(MODE).filter(function (x) { return x.id === tid })[0]
  if (!t) return
  rowsOf(tid).push(cells.slice(0, t.cols.length))
}
function debounce(fn, ms) {
  var timer
  return function () { clearTimeout(timer); timer = setTimeout(fn, ms) }
}

function $(id) { return document.getElementById(id) }

function key() { return 'gd:arcade:' + (MODE ? MODE.id : '') }
function fresh() { return { sid: '', scheme: MODE ? MODE.id : '', log: [], started: false, ended: false, diff: 1, note: '', tables: {}, side: true, clues: null, cluesState: 'idle', hints: null, hintsState: 'idle', unlocked: false, ending: null } }
function newSid(modeId) { return 'game-desk-' + modeId + '-' + Date.now().toString(36) }
function load() {
  try { var r = JSON.parse(localStorage.getItem(key()) || 'null'); return r && Array.isArray(r.log) ? r : null } catch (e) { return null }
}
function save() { try { localStorage.setItem(key(), JSON.stringify(S)) } catch (e) {} }

function shell() {
  var el = $('aroom')
  if (el) return el
  el = document.createElement('section')
  el.id = 'aroom'
  el.className = 'ar'
  el.hidden = true
  el.setAttribute('aria-label', '游戏厅对局室')
  el.innerHTML =
    '<div class="ar-page">' +
    '<header class="ar-bar">' +
    '<span class="ar-k">对局室</span><h2 id="ar-name"></h2><span class="ar-model" id="ar-model"></span><span class="ar-players" id="ar-players"></span>' +
    '<span class="ar-spacer"></span>' +
    '<button type="button" class="ghost sm" id="ar-side-btn">辅助面板</button>' +
    '<button type="button" class="ghost sm" id="ar-restart">重新开一局</button>' +
    '<button type="button" class="ghost sm" id="ar-to-case" title="回案卷台（剧本杀）">剧本杀</button>' +
    '<button type="button" class="ghost sm" id="ar-close">返回游戏厅</button>' +
    '</header>' +
    '<div class="ar-body">' +
    '<div class="ar-col">' +
    '<div class="ar-log" id="ar-log"></div>' +
    '<div class="ar-dock" id="ar-dock">' +
    '<div class="ar-chips" id="ar-chips"></div>' +
    '<div class="ar-form" id="ar-form"></div>' +
    '</div>' +
    '</div>' +
    '<aside class="ar-side" id="ar-side"></aside>' +
    '</div>' +
    '</div>'
  document.body.appendChild(el)
  $('ar-close').addEventListener('click', close)
  $('ar-to-case').addEventListener('click', function () { if (window.GameDeskBridge) window.GameDeskBridge.gotoRoom('jubensha') })
  $('ar-restart').addEventListener('click', restart)
  $('ar-side-btn').addEventListener('click', function () {
    S.side = S.side === false
    save()
    // 面板从收起变展开、线索卡正处 fail：这一下点击就当「重试」（用户动作，不是自动打接口）
    if (S.side !== false && S.cluesState === 'fail' && S.started) refreshClues()
    renderSide()
  })
  return el
}

function renderLog() {
  var box = $('ar-log')
  box.innerHTML = logHtml(S.log)
  box.scrollTop = box.scrollHeight
}

function renderChips() {
  var dock = $('ar-dock')
  dock.innerHTML = chipsHtml(S, MODE, ACT)
  if (S.ended || !S.started) return
  Array.prototype.forEach.call(dock.querySelectorAll('.ar-chip'), function (el) {
    el.addEventListener('click', function () { ACT = Number(el.getAttribute('data-act')); renderChips() })
  })
  renderForm()
}

function renderForm() {
  var form = $('ar-form')
  var a = (MODE.actions || [])[ACT]
  if (!a) { form.innerHTML = ''; return }
  form.innerHTML = formHtml(a)
  var btn = $('ar-send')
  btn.addEventListener('click', function () { submit(a) })
  Array.prototype.forEach.call(form.querySelectorAll('input.ar-in'), function (el) {
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); submit(a) } })
  })
  var first = form.querySelector('.ar-in')
  if (first && !('ontouchstart' in window)) first.focus()
}

function submit(a) {
  if (BUSY) return
  var args = {}
  var missing = false
  ;(a.fields || []).forEach(function (f) {
    var el = document.querySelector('#ar-form [data-k="' + f.k + '"]')
    var v = el ? String(el.value || '').trim() : ''
    if (v === '' && !isSelectField(f)) missing = true   // 降级成文本的 select 也必须填
    if (v !== '') args[f.k] = v
  })
  if (missing) { toast('先把空着的填上'); return }
  if (a.end && !window.confirm('「' + a.label + '」是终局动作，交出去这局就结算了。确定？')) return
  var brief = Object.keys(args).length ? Object.keys(args).map(function (k) { return args[k] }).join(' ｜ ') : '（直接执行）'
  S.log.push({ kind: 'me', label: a.label, text: brief, at: Date.now() })
  save(); renderLog()
  call(a.tool, args, a.label)
}

// 重大线索卡：宿主按 sid 记账；灰卡 text 恒 null，前端只回放宿主给的文案，绝不自造。
// 走轻量通道：不进 call()（那套带 narrate 副作用），照它的 fetch+json 模式单写。
/* 线索卡区也有状态：idle（还没取）/ loading（在飞）/ ok（拿到了）/ fail（取不到）。
   以前失败是静默 return，界面上「还没取到」「取不到」「这本没线索卡」三种情况长得一模一样。
   fail 只摆字、不自动重试打接口 —— 要再试由玩家点「辅助面板」，那一下是用户动作。 */
function setCluesState(st) {
  if (!S || S.cluesState === st) return
  S.cluesState = st
  save()
  renderSide()
}
function refreshClues() {
  if (!MODE || !S || !S.sid) return
  var scheme = MODE.id, sid = S.sid
  setCluesState('loading')
  fetch(API + '/xgame/clues', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scheme: scheme, sid: sid }),
  })
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (j) {
      if (!S || S.sid !== sid || !MODE || MODE.id !== scheme) return   // 已经换局：旧回包不许改新局
      if (!j) { setCluesState('fail'); return }                        // 非 200 / 空回包
      if (!j.ok) {
        // no-game / no-map：引擎侧这局不在了（或这本没有线索图）→ 卡片区清空并记 fail
        if (j.error === 'no-game' || j.error === 'no-map') { S.clues = null; save() }
        setCluesState('fail')
        return
      }
      if (!Array.isArray(j.cards)) { setCluesState('fail'); return }
      S.clues = j
      setCluesState('ok')
    })
    .catch(function () { setCluesState('fail') })
}

/* ---------- 提示：这局能查什么 / 能问谁 / 能去哪 ----------
   宿主给事实（where / label / sub 全是它给的），前端只负责列出来，并在玩家点一条时把它填进
   当前的快捷动作表单 —— 绝不替玩家提交动作（深查、勘查都会烧模型调用）。
   不轮询、不自动重试；同一档里 700ms 内的重复触发合成一次（call 成功后与手动点会撞在一起）。 */
var HINTS_AT = 0

// 提示 key → 该填进哪一类动作。关键词命中动作的 label / tool / id 任意一处即可。
var HINT_KW = {
  investigate: /(investigate|deep.?check|深查|调查)/i,
  search: /(examine|search|勘查|查看)/i,
  talk: /(talk|对话|交谈|问)/i,
  go: /(move|前往|移动)/i,
  take: /(take|拿取|拾取|拿起|拿)/i,
}

function setHintsState(st) {
  if (!S || S.hintsState === st) return
  S.hintsState = st
  save()
  renderSide()
}

// 轻量通道：不进 call()（那套带 narrate 副作用），照 refreshClues 的写法单开一条
function refreshHints() {
  if (!MODE || !S || !S.sid) return
  // 在飞的那一次 700ms 内不再重开；回包落定（ok / fail）后手动刷新随时可用
  if (S.hintsState === 'loading' && Date.now() - HINTS_AT < 700) return
  HINTS_AT = Date.now()
  var scheme = MODE.id, sid = S.sid
  setHintsState('loading')
  fetch(API + '/xgame/hints', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scheme: scheme, sid: sid }),
  })
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (j) {
      if (!S || S.sid !== sid || !MODE || MODE.id !== scheme) return   // 已经换局：旧回包不许改新局
      if (!j || j.ok !== true) { S.hints = null; save(); setHintsState('fail'); return }
      // 宿主回的 scheme 必须就是这一档：不一致就丢弃，别把别的玩法的提示摆到这局来
      if (j.scheme != null && j.scheme !== (S.scheme || scheme)) { setHintsState('fail'); return }
      S.hints = j
      setHintsState('ok')
    })
    .catch(function () { if (S && S.sid === sid) setHintsState('fail') })
}

// 提示 key 该落到哪个动作上：-1 = 这一档没有同类动作
function actIndexFor(k) {
  var re = HINT_KW[k]
  if (!re || !MODE) return -1
  var acts = MODE.actions || []
  for (var i = 0; i < acts.length; i++) {
    var a = acts[i] || {}
    if (re.test(String(a.label || '') + ' ' + String(a.tool || '') + ' ' + String(a.id || ''))) return i
  }
  return -1
}
function hintFieldEls() {
  var f = $('ar-form')
  if (!f || !f.querySelectorAll) return []
  return Array.prototype.slice.call(f.querySelectorAll('input, select, textarea'))
}
function fillHintInto(el, name) {
  if (!el) return false
  var tag = String(el.tagName || '').toUpperCase()
  if (tag === 'SELECT') {
    var opts = el.options || []
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i]
      if (o && (String(o.value) === name || String(o.textContent) === name)) { el.value = String(o.value); return true }
    }
    return false
  }
  if (!el || !('value' in el)) return false
  el.value = name
  if (el.focus) el.focus()
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center' })
  return true
}
/* 玩家点一条提示：把它写进当前动作表单的第一个文本格子（select 就选中同名项）。
   填不进去（没选动作 / 这档没有对应动作）才退化成「toast + 复制名字」，绝不自动提交。 */
function applyHint(k, name) {
  name = String(name == null ? '' : name)
  if (!name) return false
  var idx = actIndexFor(k)
  if (idx >= 0 && idx !== ACT) { ACT = idx; renderChips() }   // 只切表单，不发请求
  var fields = hintFieldEls()
  var textEl = null, selEl = null
  fields.forEach(function (el) {
    var tag = String(el.tagName || '').toUpperCase()
    if (!textEl && (tag === 'INPUT' || tag === 'TEXTAREA') && String(el.type || 'text') !== 'hidden') textEl = el
    if (!selEl && tag === 'SELECT') selEl = el
  })
  var done = textEl ? fillHintInto(textEl, name) : false
  if (!done && selEl) done = fillHintInto(selEl, name)
  if (done) return true
  toast('先在上面选一个动作，再点一次这条提示')
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(name)
  } catch (e) {}
  return false
}
function bindHintBtns(side) {
  Array.prototype.forEach.call(side.querySelectorAll('.ar-soup .ar-hint-refresh'), function (b) {
    b.addEventListener('click', function () { refreshClues(); refreshHints() })
  })
  // 占位方块（.is-ph）不是按钮、没有 data-name，别给它绑点击（否则会把 null 填进输入框）
  Array.prototype.forEach.call(side.querySelectorAll('.ar-hint-chip:not(.is-ph)'), function (b) {
    b.addEventListener('click', function () { applyHint(b.getAttribute('data-k'), b.getAttribute('data-name')) })
  })
  Array.prototype.forEach.call(side.querySelectorAll('.ar-hint-refresh'), function (b) {
    b.addEventListener('click', function () { refreshHints() })
  })
}

function call(tool, args, label, onFail) {
  BUSY = true
  var dock = $('ar-dock')
  if (dock) { var b = document.getElementById('ar-send'); if (b) { b.disabled = true; b.textContent = '引擎思考中…' } }
  fetch(API + '/xgame', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: tool, scheme: MODE.id, sid: S.sid, args: args }),
  })
    .then(function (r) { return r.json() })
    .then(function (j) {
      BUSY = false
      if (j && j.ok) {
        if (j.model) MODEL = j.model
        if (tool === 'game_start') S.started = true
        if (END_TOOLS[tool]) S.ended = true
        if (tool === 'soup_guess' && j.result && j.result.solved) S.ended = true
        // 密室通关：引擎回 result.result==='success' 且文案里有「逃出/结算」
        if (tool === 'escape_use' && j.result && String(j.result.result || '') === 'success' &&
          /逃出|逃脱|结算|你赢/.test(String(j.result.text || ''))) S.ended = true
        if (tool === 'soup_ask' && j.result) {
          var vd = ({ yes: '是', no: '否', irrelevant: '无关', unclear: '说不清' })[j.result.verdict] || '？'
          autoRow('ask', [String(args.question || '').slice(0, 60), vd,
            typeof j.result.questions_left === 'number' ? '剩 ' + j.result.questions_left : '',
            j.result.red_herring ? '偏了' : ''])
        }
        if (tool === 'soup_guess' && j.result && typeof j.result.solved === 'boolean') {
          autoRow('ask', ['（猜汤底）' + String(args.answer || '').slice(0, 40), j.result.solved ? '还原成功' : '没还原', '', ''])
        }
        save(); renderAll()
        refreshClues()
        refreshHints()
        narrate(tool, label, resultText(tool, j.result), metaOf(tool, j.result), j.result && j.result.verdict)
      } else {
        var msg = ROOM_ERRS[j && j.error] || (j && j.error ? '未知错误（' + j.error + '）' : '引擎没应答')
        if (tool === 'game_start' && /进行中/.test(msg)) {
          S.started = true
        } else {
          S.log.push({ kind: 'sys', text: msg, at: Date.now() })
        }
        if (onFail) onFail(msg)
      }
      save(); renderAll()
    })
    .catch(function (e) {
      BUSY = false
      S.log.push({ kind: 'sys', text: '送不到引擎：' + e.message, at: Date.now() })
      save(); renderAll()
    })
}

function bindUnlockBtns(side) {
  Array.prototype.forEach.call(side.querySelectorAll('.ar-unlock'), function (b) {
    b.addEventListener('click', function () {
      if (b.disabled) return
      var scheme = MODE.id, sid = S.sid
      b.disabled = true
      b.textContent = '正在解锁…'
      fetch(API + '/xgame/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheme: scheme, sid: sid }),
      })
        .then(function (r) {
          return r.json().then(function (j) { return { code: r.status, j: j } }, function () { return { code: r.status, j: null } })
        })
        .then(function (res) {
          if (!S || S.sid !== sid || !MODE || MODE.id !== scheme) return
          var j = res.j
          if (j && j.ok && typeof j.ending === 'string') {
            S.unlocked = true
            S.ending = j.ending
            S.log.push({ kind: 'sys', text: j.ending, at: Date.now() })
            save(); renderAll()
            return
          }
          if (res.code === 409 || (j && j.error === 'clues-not-complete')) toast('线索还没集齐')
          else toast((j && j.error) || '解锁没应答')
          renderSide()
        })
        .catch(function () {
          toast('解锁没成功')
          if (S && S.sid === sid && MODE && MODE.id === scheme) renderSide()
        })
    })
  })
}

// 笔记框跨渲染只留一个节点、一个 debounce：整块 innerHTML 重填会把正在打的字、光标、输入法组态一起丢掉
var commitNote = debounce(function () {
  var t = $('ar-note')
  if (!t || !S || t.getAttribute('data-sid') !== String(S.sid || '')) return
  S.note = t.value
  save()
}, 250)

function noteBox() {
  var t = document.createElement('textarea')
  t.className = 'ar-note'
  t.id = 'ar-note'
  t.rows = 5
  t.placeholder = '推理事件、时间点、谁在说谎、下一手想试什么……'
  t.value = S.note || ''
  t.setAttribute('data-sid', String(S.sid || ''))
  t.addEventListener('input', commitNote)
  return t
}

function renderSide() {
  var side = $('ar-side')
  var btn = $('ar-side-btn')
  var show = S.side !== false
  side.hidden = !show
  if (btn) btn.classList.toggle('is-on', show)
  if (!show) return
  var ts = tablesOf(MODE)
  // 笔记框不跟着重填：它可能正是焦点所在，换掉节点就丢字、丢光标、丢输入法组态
  var note = $('ar-note')
  if (note && note.getAttribute('data-sid') === String(S.sid || '')) {
    S.note = note.value // 还没到 250ms 的那截字先并回状态，免得别的 save() 把它盖掉
  } else {
    note = noteBox() // 换了一局 / 刚进来：重建一个，值取自 S.note
  }
  var wrap = document.createElement('div')
  wrap.innerHTML = sideBodyHtml(S, MODE, ts.map(function (t) { return { id: t.id, title: t.title, cols: t.cols, auto: t.auto, rows: rowsOf(t.id) } }))
  // 只换兄弟节点，textarea 原地不动（动它就会 blur、丢光标，还可能打断中文输入法的组态）
  var slot = wrap.querySelector('.ar-note-slot')
  var before = []
  var after = []
  var hit = false
  Array.prototype.slice.call(side.childNodes).forEach(function (n) {
    if (n !== note) side.removeChild(n)
  })
  if (note.parentNode !== side) side.appendChild(note)
  while (wrap.firstChild) {
    var n = wrap.firstChild
    wrap.removeChild(n)
    if (n === slot) { hit = true; continue }
    if (hit) after.push(n)
    else before.push(n)
  }
  before.forEach(function (n) { side.insertBefore(n, note) })
  after.forEach(function (n) { side.appendChild(n) })
  Array.prototype.forEach.call(side.querySelectorAll('.ar-addrow'), function (b) {
    b.addEventListener('click', function () {
      var tid = b.getAttribute('data-add')
      var t = tablesOf(MODE).filter(function (x) { return x.id === tid })[0]
      rowsOf(tid).push(t.cols.map(function () { return '' }))
      save(); renderSide()
    })
  })
  Array.prototype.forEach.call(side.querySelectorAll('.ar-grid tbody'), function (tb) {
    var tid = tb.parentNode.parentNode.getAttribute('data-t')
    tb.addEventListener('input', function (ev) {
      var td = ev.target && ev.target.closest ? ev.target.closest('td[data-c]') : null
      if (!td) return
      var ri = Number(td.parentNode.getAttribute('data-r'))
      var ci = Number(td.getAttribute('data-c'))
      var rows = rowsOf(tid)
      if (rows[ri]) { rows[ri][ci] = td.textContent; save() }
    })
    tb.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('button[data-del]') : null
      if (!b) return
      rowsOf(tid).splice(Number(b.getAttribute('data-del')), 1)
      save(); renderSide()
    })
  })
  bindUnlockBtns(side)
  bindHintBtns(side)
}

function renderAll() {
  $('ar-name').textContent = MODE ? MODE.name : ''
  $('ar-model').textContent = MODEL ? '引擎 ' + MODEL : ''
  $('ar-players').textContent = MODE ? (MODE.players || '1人 + AI') : ''
  renderLog()
  renderChips()
  renderSide()
}

// 引擎输出是写给主持人模型的，页内先转述成玩家能读的一段话
function narrate(tool, label, raw, meta, verdict) {
  var name = MODE ? MODE.name : '游戏'
  var title = tool === 'game_start' ? '主持人' : (label || '引擎')
  var soup = MODE && MODE.id === 'soup'
  fetch(API + '/xgame/narrate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: raw, name: name, soup: soup, verdict: verdict || '' }),
  })
    .then(function (r) { return r.json() })
    .then(function (n) {
      var entry = (n && n.ok)
        ? { kind: 'eng', label: title, text: n.text, meta: meta || '转述自引擎', at: Date.now() }
        : { kind: 'eng', label: title + '（原文）', text: raw, meta: meta, at: Date.now() }
      S.log.push(entry)
      save(); renderAll()
    })
    .catch(function () {
      S.log.push({ kind: 'eng', label: title + '（原文）', text: raw, meta: meta, at: Date.now() })
      save(); renderAll()
    })
}

function start() {
  // 剧本杀卡面就是「反转」玩法（你是凶手），引擎只有 difficulty===3 才是反转
  var diff = Number(S.diff) || 1
  if (MODE.id === 'party' && diff < 3) diff = 3
  call('game_start', { scheme: MODE.id, difficulty: diff }, '开一局', function (msg) {
    if (/进行中/.test(msg)) {
      S.log.push({ kind: 'sys', text: '引擎里这一局还没散 —— 上面的动作直接接着玩就行；想推倒重来点「重新开一局」。', at: Date.now() })
      save(); renderAll()
    }
  })
}

function restart() {
  if (!window.confirm('重新开一局？现在这局的引擎状态会被清掉。')) return
  fetch(API + '/xgame/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scheme: MODE.id, sid: S.sid }),
  })
    .then(function (r) { return r.json() })
    .then(function () {
      S = fresh()
      S.sid = newSid(MODE.id)
      ACT = 0
      save()
      S.log.push({ kind: 'sys', text: '牌桌已清空，重新发牌。', at: Date.now() })
      renderAll()
      start()
    })
    .catch(function () { toast('重置没成功') })
}

export function open(mode) {
  MODE = mode
  var freshQ = /[?&]fresh=1/.test(location.search)
  if (freshQ) { try { localStorage.removeItem(key()) } catch (err) {} }
  S = (freshQ ? null : load()) || fresh()
  if (!S.sid) S.sid = newSid(MODE.id)
  if (typeof S.note !== 'string') S.note = ''
  if (!S.tables || typeof S.tables !== 'object') S.tables = {}
  if (typeof S.side === 'undefined') S.side = true
  if (!S.clues || !Array.isArray(S.clues.cards)) S.clues = null
  // 刷新页面时残留的 "loading" 必须洗掉：没有请求在飞，留着就永远停在「线索卡正在取…」
  if (S.clues) S.cluesState = 'ok'
  else if (S.cluesState !== 'fail') S.cluesState = 'idle'
  if (!S.scheme) S.scheme = MODE.id
  if (S.hints && !Array.isArray(S.hints.sections)) S.hints = null
  // 同理：刷新后残留的 loading 洗掉，有缓存就算 ok
  if (S.hints) S.hintsState = 'ok'
  else if (S.hintsState !== 'fail') S.hintsState = 'idle'
  S.unlocked = S.unlocked === true
  if (typeof S.ending !== 'string') S.ending = null
  ACT = 0
  shell().hidden = false
  renderAll()
  if (!S.started && !BUSY) start()
  if (S.started) { refreshClues(); refreshHints() }
}

export function close() {
  var el = $('aroom')
  if (el) el.hidden = true
}

function toast(text) {
  if (window.GameDeskBridge && window.GameDeskBridge.toast) { window.GameDeskBridge.toast(text); return }
}

// 兼容垫片：app.js 仍按 window.GameArcade 用它，一行都不用改。
if (typeof window !== 'undefined') window.GameArcade = { open: open, close: close }
