/* 游戏厅 · 材料局：按导入资料开的一局。主持人不是 dsh-xgame 引擎，
   是宿主里的模型本身（POST /api/arcade/ask），资料 = 内容库里这一本的 _text。
   与 arcade.js 的引擎房互不相干；每本的状态存 localStorage 'gd:mroom:<folder>'。 */
;(function () {
  var API = '/game-desk/api'

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }

  var SCHEME_NAME = { soup: '海龟汤', detective: '侦探推理', escape: '密室逃脱', party: '剧本杀', loop: '时间循环', council: '王国议会', trpg: '单人跑团' }
  var HINTS = {
    soup: ['这事跟家里人有关吗？', '他死之前见过谁？', '我猜汤底是……'],
    detective: ['勘查现场', '找嫌疑人谈谈', '我大概知道是谁了'],
    escape: ['环顾四周', '检查门锁', '翻翻桌面'],
    party: ['当众说清我的不在场证明', '私下找TA谈谈', '要求搜证'],
    loop: ['先去出事的地方看看', '今天我要拦住TA', '把知道的记下来'],
    council: ['国库现在有多少？', '这项提案谁反对？', '本季就按这个办'],
    trpg: ['潜行接近', '检查装备和状态', '找人打听目标'],
  }
  var ERRS = {
    'remote-off': '机主没开放公网材料局（这一局要耗模型额度）',
    'remote-quota': '今天公网的额度用完了，明天再来',
    'remote-throttle': '慢一点，一秒一问',
    'remote-owner-only': '这一局只能在机主电脑上开',
    'owner-only': '这一局只能在机主电脑上开',
  }

  var ENTRY = null
  var S = null
  var BUSY = false
  var MODEL = ''

  function key() { return 'gd:mroom:' + (ENTRY ? ENTRY.folder : '') }
  function fresh() { return { log: [], started: false } }
  function load() {
    try { return JSON.parse(localStorage.getItem(key()) || '') || fresh() } catch (e) { return fresh() }
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
    var html = S.log.map(function (m) {
      var who = m.who === 'me' ? '你' : (m.who === 'sys' ? '系统' : '主持人')
      return '<div class="mr-msg is-' + esc(m.who) + '"><span class="mr-who">' + who + '</span><div class="mr-text' + (m.wait ? ' is-wait' : '') + '">' + esc(m.text) + '</div></div>'
    }).join('')
    box.innerHTML = html || '<p class="mr-empty">按这份资料开的一局 —— 主持人在读资料，马上开场。</p>'
    box.scrollTop = box.scrollHeight
    var h = (ENTRY && HINTS[ENTRY.scheme]) || []
    document.getElementById('mr-chips').innerHTML = h.map(function (t) {
      return '<button class="mr-chip" type="button" data-t="' + esc(t) + '">' + esc(t) + '</button>'
    }).join('')
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

  function open(entry) {
    ENTRY = entry
    S = load()
    var el = shell()
    el.hidden = false
    document.getElementById('mr-title').textContent = entry.title + ' · ' + (SCHEME_NAME[entry.scheme] || entry.scheme)
    var mp = document.getElementById('mr-players')
    if (mp) mp.textContent = entry.players ? entry.players : '人数未标'
    document.getElementById('mr-model').textContent = MODEL
    renderLog()
    if (!S.started || S.log.length === 0) { ask('', true); return }
    var box = document.getElementById('mr-input')
    if (box) box.focus()
  }

  function close() {
    var el = document.getElementById('mroom')
    if (el) el.hidden = true
  }

  window.GameRoom = { open: open, close: close }
})()
