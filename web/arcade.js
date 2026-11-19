;(function () {
  'use strict'
  // 游戏厅对局室：直接驱动宿主 /api/xgame（案卷台代打 dsh-xgame 工具），不回会话。
  var API = '/game-desk/api'
  var MODE = null
  var S = null
  var BUSY = false
  var MODEL = ''
  var ACT = 0

  var END_TOOLS = {
    detective_accuse: 1, detective_submit_theory: 1,
    party_accuse: 1, party_verdict: 1,
    loop_submit_plan: 1,
  }

  // 每种玩法的辅助面：笔记全都有，表格按玩法定列
  var AUX = {
    soup: [
      { id: 'ask', title: '提问记录', cols: ['问题', '裁决', '剩余', '备注'], auto: true },
    ],
    detective: [
      { id: 'suspect', title: '嫌疑人', cols: ['人', '不在场证明', '动机', '我的判断'] },
      { id: 'clue', title: '线索', cols: ['线索', '哪里得到', '指向谁'] },
    ],
    escape: [
      { id: 'item', title: '背包', cols: ['物品', '哪里拿到', '用途 / 组合', '状态'] },
      { id: 'gate', title: '机关与门', cols: ['对象', '试过什么', '结果'] },
    ],
    party: [
      { id: 'evi', title: '侦探团搜到的证据', cols: ['证据', '第几轮', '威胁'] },
      { id: 'say', title: '我的说辞', cols: ['话题', '我咬死怎么说', '效果'] },
    ],
    loop: [
      { id: 'meta', title: '元知识（先知道才拿得到）', cols: ['知识', '哪轮拿到的', '用在何时'] },
      { id: 'plan', title: '完美一日排期', cols: ['时间', '地点', '动作', '状态'] },
    ],
    council: [
      { id: 'season', title: '季度账本', cols: ['季度', '拍板了什么', '结果 / 国库', '备注'] },
      { id: 'adviser', title: '顾问信任', cols: ['顾问', '主张', '信任', '可疑议程'],
        seed: [['沈万钧', '', '', ''], ['霍震霆', '', '', ''], ['玄尘子', '', '', ''], ['顾长风', '', '', '']] },
    ],
    trpg: [
      { id: 'inv', title: '背包', cols: ['物品', '数量', '备注'] },
      { id: 'quest', title: '任务', cols: ['任务', '进展', '状态'] },
      { id: 'battle', title: '战斗记录', cols: ['敌人', '骰 / 伤害', '结果'] },
    ],
  }
  function tablesOf() { return AUX[MODE ? MODE.id : ''] || [] }
  function rowsOf(tid) {
    if (!S.tables[tid]) {
      var t = tablesOf().filter(function (x) { return x.id === tid })[0]
      S.tables[tid] = t && t.seed ? t.seed.map(function (r) { return r.slice() }) : []
    }
    return S.tables[tid]
  }
  function autoRow(tid, cells) {
    var t = tablesOf().filter(function (x) { return x.id === tid })[0]
    if (!t) return
    rowsOf(tid).push(cells.slice(0, t.cols.length))
  }
  function debounce(fn, ms) {
    var timer
    return function () { clearTimeout(timer); timer = setTimeout(fn, ms) }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }
  function $(id) { return document.getElementById(id) }

  function key() { return 'gd:arcade:' + (MODE ? MODE.id : '') }
  function fresh() { return { sid: '', log: [], started: false, ended: false, diff: 1, note: '', tables: {}, side: true } }
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
      renderSide()
    })
    return el
  }

  function resultText(tool, r) {
    if (!r || typeof r !== 'object') return String(r == null ? '（引擎没有返回）' : r)
    if (Array.isArray(r.lines) && r.lines.length) return r.lines.join('\n')
    if (typeof r.text === 'string' && r.text !== '') return r.text
    if (typeof r.result === 'string' && r.result !== '') return r.result
    try { return JSON.stringify(r, null, 1) } catch (e) { return '（返回看不懂）' }
  }

  function metaOf(tool, r) {
    if (!r || typeof r !== 'object') return ''
    if (tool === 'soup_ask') {
      var bits = []
      if (r.verdict) bits.push('裁决：' + ({ yes: '是', no: '否', irrelevant: '无关', unclear: '说不清', unknown: '说不清' })[r.verdict] || r.verdict)
      if (typeof r.questions_left === 'number') bits.push('剩 ' + r.questions_left + ' 问')
      if (r.red_herring) bits.push('这问偏了')
      return bits.join(' · ')
    }
    if (tool === 'soup_guess' && typeof r.solved === 'boolean') return r.solved ? '汤底还原成功' : '还没还原，继续问'
    if (r.model) return String(r.model)
    return ''
  }

  function renderLog() {
    var box = $('ar-log')
    if (!S.log.length) {
      box.innerHTML = '<div class="ar-wait">正在开局……引擎在牌堆里摸一张命运。</div>'
      return
    }
    box.innerHTML = S.log.map(function (e) {
      var t = e.at ? new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''
      if (e.kind === 'me') return '<div class="ar-me"><b>' + esc(e.label) + '</b><span>' + esc(e.text) + '</span></div>'
      if (e.kind === 'sys') return '<div class="ar-sys"><span>' + esc(e.text) + '</span></div>'
      return '<div class="ar-eng"><div class="ar-eng-h">' + esc(e.label || '引擎') + ' <em>' + esc(t) + (e.meta ? ' · ' + esc(e.meta) : '') + '</em></div><p>' + esc(e.text) + '</p></div>'
    }).join('')
    box.scrollTop = box.scrollHeight
  }

  function renderChips() {
    var dock = $('ar-dock')
    if (S.ended) {
      dock.innerHTML = '<div class="ar-end">这一局结束了 —— 上面有引擎的终局结算。想再来，点上方「重新开一局」。</div>'
      return
    }
    if (!S.started) { dock.innerHTML = '<div class="ar-end">开局指令发出去了，等引擎把简报摊开……</div>'; return }
    var acts = MODE.actions || []
    var chips = acts.map(function (a, i) {
      return '<button type="button" class="ar-chip' + (i === ACT ? ' is-on' : '') + (a.end ? ' is-end' : '') + '" data-act="' + i + '">' + esc(a.label) + '</button>'
    }).join('')
    dock.innerHTML = '<div class="ar-chips">' + chips + '</div><div class="ar-form" id="ar-form"></div>'
    Array.prototype.forEach.call(dock.querySelectorAll('.ar-chip'), function (el) {
      el.addEventListener('click', function () { ACT = Number(el.getAttribute('data-act')); renderChips() })
    })
    renderForm()
  }

  function renderForm() {
    var form = $('ar-form')
    var a = (MODE.actions || [])[ACT]
    if (!a) { form.innerHTML = ''; return }
    var fields = (a.fields || []).map(function (f) {
      if (f.type === 'select') {
        return '<label class="ar-field"><span>' + esc(f.label) + '</span><select class="ar-in" data-k="' + esc(f.k) + '">' +
          (f.options || []).map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>' }).join('') + '</select></label>'
      }
      if (f.type === 'area') {
        return '<label class="ar-field wide"><span>' + esc(f.label) + '</span><textarea class="ar-in" rows="3" data-k="' + esc(f.k) + '" placeholder="' + esc(f.ph || '') + '"></textarea></label>'
      }
      return '<label class="ar-field"><span>' + esc(f.label) + '</span><input class="ar-in" type="text" data-k="' + esc(f.k) + '" placeholder="' + esc(f.ph || '') + '" /></label>'
    }).join('')
    form.innerHTML = fields +
      '<div class="ar-go"><button type="button" class="' + (a.end ? 'primary is-end' : 'primary') + '" id="ar-send"' + (a.end ? ' data-confirm="1"' : '') + '>' + esc(a.label) + '</button>' +
      (a.end ? '<span class="ar-endhint">终局动作：交出去就收不回来</span>' : '') + '</div>'
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
      if (v === '' && f.type !== 'select') missing = true
      if (v !== '') args[f.k] = v
    })
    if (missing) { toast('先把空着的填上'); return }
    if (a.end && !window.confirm('「' + a.label + '」是终局动作，交出去这局就结算了。确定？')) return
    var brief = Object.keys(args).length ? Object.keys(args).map(function (k) { return args[k] }).join(' ｜ ') : '（直接执行）'
    S.log.push({ kind: 'me', label: a.label, text: brief, at: Date.now() })
    save(); renderLog()
    call(a.tool, args, a.label)
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
          narrate(tool, label, resultText(tool, j.result), metaOf(tool, j.result), j.result && j.result.verdict)
        } else {
          var msg = (j && j.error) || '引擎没应答'
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

  function renderSide() {
    var side = $('ar-side')
    var btn = $('ar-side-btn')
    var show = S.side !== false
    side.hidden = !show
    if (btn) btn.classList.toggle('is-on', show)
    if (!show) return
    var ts = tablesOf()
    side.innerHTML =
      '<div class="ar-side-k">辅助 · ' + esc(MODE ? MODE.name : '') + '</div>' +
      '<div class="ar-note-k">笔记 · 记事情（自动存）</div>' +
      '<textarea class="ar-note" id="ar-note" rows="5" placeholder="推理事件、时间点、谁在说谎、下一手想试什么……">' + esc(S.note || '') + '</textarea>' +
      ts.map(function (t) {
        var rows = rowsOf(t.id)
        return '<div class="ar-table" data-t="' + t.id + '">' +
          '<div class="ar-table-h"><b>' + esc(t.title) + '</b>' + (t.auto ? '<em>引擎自动记</em>' : '') + '</div>' +
          '<table class="ar-grid"><thead><tr>' +
          t.cols.map(function (c) { return '<th>' + esc(c) + '</th>' }).join('') + '<th></th></tr></thead><tbody>' +
          (rows.length ? rows.map(function (r, ri) {
            return '<tr data-r="' + ri + '">' +
              t.cols.map(function (c, ci) { return '<td contenteditable="true" data-c="' + ci + '">' + esc(r[ci] || '') + '</td>' }).join('') +
              '<td class="ar-del"><button type="button" data-del="' + ri + '" title="删掉这行">×</button></td></tr>'
          }).join('') : '<tr class="ar-emptyrow"><td colspan="' + (t.cols.length + 1) + '">还没记 —— 点下面「＋ 记一行」</td></tr>') +
          '</tbody></table>' +
          '<button type="button" class="ghost sm ar-addrow" data-add="' + t.id + '">＋ 记一行</button>' +
          '</div>'
      }).join('')
    var note = $('ar-note')
    var commit = debounce(function () { S.note = note.value; save() }, 250)
    note.addEventListener('input', commit)
    Array.prototype.forEach.call(side.querySelectorAll('.ar-addrow'), function (b) {
      b.addEventListener('click', function () {
        var tid = b.getAttribute('data-add')
        var t = tablesOf().filter(function (x) { return x.id === tid })[0]
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
    call('game_start', { scheme: MODE.id, difficulty: Number(S.diff) || 1 }, '开一局', function (msg) {
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

  function open(mode) {
    MODE = mode
    var freshQ = /[?&]fresh=1/.test(location.search)
    if (freshQ) { try { localStorage.removeItem(key()) } catch (err) {} }
    S = (freshQ ? null : load()) || fresh()
    if (!S.sid) S.sid = newSid(MODE.id)
    if (typeof S.note !== 'string') S.note = ''
    if (!S.tables || typeof S.tables !== 'object') S.tables = {}
    if (typeof S.side === 'undefined') S.side = true
    ACT = 0
    shell().hidden = false
    renderAll()
    if (!S.started && !BUSY) start()
  }

  function close() {
    var el = $('aroom')
    if (el) el.hidden = true
  }

  function toast(text) {
    if (window.GameDeskBridge && window.GameDeskBridge.toast) { window.GameDeskBridge.toast(text); return }
  }

  window.GameArcade = { open: open, close: close }
})()