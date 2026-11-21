/* 游戏厅 · 材料局：按导入资料开的一局。主持人不是 dsh-xgame 引擎，
   是宿主里的模型本身（POST /api/arcade/ask），资料 = 内容库里这一本的 _text。
   与 arcade.js 的引擎房互不相干；每本的状态存 localStorage 'gd:mroom:<root>|<folder>'（旧的无 root 键会自动搬一次）。
   浏览器原生 ES module：纯渲染块搬到 ./lib/roomui.js；末尾仍写 window.GameRoom 兼容垫片。 */

import { HINTS, titleOf, logListHtml, chipsHtml } from './lib/roomui.js'

var API = '/game-desk/api'

var ERRS = {
  'remote-off': '机主没开放公网材料局（这一局要耗模型额度）',
  'remote-quota': '今天公网的额度用完了，明天再来',
  'remote-throttle': '慢一点，一秒一问',
  'remote-owner-only': '这一局只能在机主电脑上开',
  'owner-only': '这一局只能在机主电脑上开',
  'room-waiting': '还没开局：等玩家到齐（房主可在局域网弹层点「强行开局」）',
  'room-empty': '房间里现在没人：链接还灵，进来一个人就能开这一局',
  'room-idle': '房间没开：让房主把「公网房间」拨到开',
}

var ENTRY = null
var S = null
var BUSY = false
var MODEL = ''

// 存档按「书库 root + 资料夹」分：只按 folder 的话，不同书库的同名资料夹会共用同一局（日志和开局状态互相污染）
function key() { return 'gd:mroom:' + ((ENTRY && ENTRY.root) || '') + '|' + ((ENTRY && ENTRY.folder) || '') }
// 旧键没有 root 段：新键读不到而旧键有数据时搬一次家（读旧 -> 写新 -> 删旧），任何一步失败都静默，旧局仍留在原处
function migrateFromLegacy() {
  try {
    var old = 'gd:mroom:' + ((ENTRY && ENTRY.folder) || '')
    if (old === key()) return null
    var raw = localStorage.getItem(old)
    if (raw == null) return null
    localStorage.setItem(key(), raw)
    localStorage.removeItem(old)
    return raw
  } catch (e) { return null }
}
function fresh() { return { log: [], started: false } }
function load() {
  try {
    var raw = localStorage.getItem(key())
    if (raw == null) raw = migrateFromLegacy()
    return JSON.parse(raw || '') || fresh()
  } catch (e) { return fresh() }
}
function save() {
  try { localStorage.setItem(key(), JSON.stringify(S)) } catch (e) { /* 存下存不下都不拦对局 */ }
}

function shell() {
  var el = document.getElementById('mroom')
  if (el) return el
  el = document.createElement('section')
  el.id = 'mroom'
  el.className = 'mr'
  el.hidden = true
  el.setAttribute('aria-label', '材料局')
  el.innerHTML =
    '<div class="mr-page">' +
    '<header class="mr-bar">' +
    '<span class="mr-k">材料局</span>' +
    '<h2 class="mr-title" id="mr-title">——</h2>' +
    '<span class="mr-players" id="mr-players"></span>' +
    '<span class="mr-model" id="mr-model"></span>' +
    '<span class="mr-spacer"></span>' +
    '<button class="ghost sm" id="mr-case" type="button" title="回案卷台（剧本杀）">剧本杀</button>' +
    '<button class="ghost sm" id="mr-restart" type="button">重新开局</button>' +
    '<button class="ghost sm" id="mr-close" type="button">返回</button>' +
    '</header>' +
    '<div class="mr-log" id="mr-log"></div>' +
    '<div class="mr-dock">' +
    '<div class="mr-chips" id="mr-chips"></div>' +
    '<div class="mr-form"><textarea id="mr-input" rows="2" placeholder="说 / 做 —— 回车送出，Shift+回车换行"></textarea>' +
    '<button class="primary mr-go" id="mr-send" type="button">送出</button></div>' +
    '</div></div>'
  document.body.appendChild(el)
  el.addEventListener('click', function (e) { if (e.target === el) close() })
  document.getElementById('mr-close').addEventListener('click', close)
  document.getElementById('mr-case').addEventListener('click', function () { if (window.GameDeskBridge) window.GameDeskBridge.gotoRoom('jubensha') })
  document.getElementById('mr-restart').addEventListener('click', function () {
    if (!window.confirm('推倒这一局，按同一份资料重新开局？')) return
    S = fresh()
    save()
    renderLog()
    ask('', true)
  })
  document.getElementById('mr-send').addEventListener('click', function () { send() })
  document.getElementById('mr-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })
  document.getElementById('mr-chips').addEventListener('click', function (e) {
    var c = e.target.closest ? e.target.closest('.mr-chip') : null
    if (!c) return
    var box = document.getElementById('mr-input')
    box.value = c.getAttribute('data-t')
    box.focus()
  })
  return el
}

function renderLog() {
  var box = document.getElementById('mr-log')
  if (!box) return
  box.innerHTML = logListHtml(S.log) || '<p class="mr-empty">按这份资料开的一局 —— 主持人在读资料，马上开场。</p>'
  box.scrollTop = box.scrollHeight
  var h = (ENTRY && HINTS[ENTRY.scheme]) || []
  document.getElementById('mr-chips').innerHTML = chipsHtml(h)
}

function send() {
  var box = document.getElementById('mr-input')
  var t = (box.value || '').trim()
  if (t === '' || BUSY) return
  box.value = ''
  S.log.push({ who: 'me', text: t, at: Date.now() })
  save()
  ask(t, false)
}

function ask(input, open) {
  if (!ENTRY || BUSY) return
  BUSY = true
  renderLog()
  var hist = S.log.filter(function (m) { return m.who === 'me' || m.who === 'dm' }).slice(-20)
  fetch(API + '/arcade/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folder: ENTRY.folder, input: input || '', open: !!open, history: hist })
  })
    .then(function (r) { return r.json() })
    .then(function (j) {
      BUSY = false
      if (j && j.ok) {
        MODEL = j.model || MODEL
        var mm = document.getElementById('mr-model')
        if (mm) mm.textContent = MODEL
        S.log.push({ who: 'dm', text: j.text, at: Date.now() })
        S.started = true
        save()
        renderLog()
        return
      }
      var err = (j && j.error) || '主持人没应答'
      var msg = ERRS[err] || (err === '没有这一本' || err === '内容库里没有这一本' ? '内容库里没有这一本（可能已删除）' : err)
      if (j && j.code === 422) msg = '这份资料还没抽出文字：回游戏厅删掉这本重导一次（等抽字进度走完）'
      S.log.push({ who: 'sys', text: msg, at: Date.now() })
      save()
      renderLog()
    })
    .catch(function (e) {
      BUSY = false
      S.log.push({ who: 'sys', text: '接口没应答：' + (e && e.message ? e.message : e), at: Date.now() })
      save()
      renderLog()
    })
}

export function open(it) {
  var src = it || {}
  // root 由 app.js 在 open 前补上，可能缺失：缺了就按空串算，绝不抛错。
  // 拷一份而不是直接持有 it：外面若复用同一个对象改 folder，key() 会跟着变，一局就串到另一本去了。
  ENTRY = {
    folder: src.folder == null ? '' : String(src.folder),
    root: src.root == null ? '' : String(src.root),
    title: src.title == null ? '' : String(src.title),
    scheme: src.scheme == null ? '' : String(src.scheme),
    players: src.players == null ? '' : String(src.players)
  }
  S = load()
  var el = shell()
  el.hidden = false
  document.getElementById('mr-title').textContent = titleOf(ENTRY)
  var mp = document.getElementById('mr-players')
  if (mp) mp.textContent = ENTRY.players || '人数未标'
  document.getElementById('mr-model').textContent = MODEL
  renderLog()
  if (!S.started || S.log.length === 0) { ask('', true); return }
  var box = document.getElementById('mr-input')
  if (box) box.focus()
}

export function close() {
  var el = document.getElementById('mroom')
  if (el) el.hidden = true
}

// 兼容垫片：app.js 仍按 window.GameRoom 用它，一行都不用改。
if (typeof window !== 'undefined') window.GameRoom = { open: open, close: close }
