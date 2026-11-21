/* 案卷台页面逻辑：一个书库可以指向任意资料夹；本子有 case.yml 按结构化读，没有就按资料夹读。
   开局把指令交回客户端半填进对话输入框。 */
// 纯工具函数在 ./lib/util.js（本文件拆分出去的，渲染结果逐字不变）
import {
  esc, bytes, baseName, errCn, errHtml,
  GENRE, DIFF, genreOf, diffOf, rawTick,
  playersLabel, playersText, playersRange,
  caseNo, fmtAt, genreCn
} from './lib/util.js'

import {
  metaLine, scanBadge, packTags, orderPacks,
  aiFillItems, packMissHtml, reviewResultHtml, packReviewHtml,
  packAiFillHtml, fact
} from './lib/packview.js'

import { createRoombar } from './lib/roombar.js'
import { createListview } from './lib/listview.js'
import { createPackDossier } from './lib/packdossier.js'

(function () {
  'use strict'

  var API = '/game-desk/api'
  var params = new URLSearchParams(location.search)
  var panel = params.get('panel') === 'arcade' ? 'arcade' : 'jubensha'
  var theme = params.get('theme')

  var state = { cases: [], roots: [], root: '', active: null, filter: 'all', q: '' }

  function $(id) { return document.getElementById(id) }
  // 接口前缀只留在这一处：模块拿到的 api(path, opts) 自己不能拼 API
  function api(path, opts) { return fetch(API + path, opts) }


  // ---------- 主题：跟随宿主 ----------
  function applyTheme(name) {
    if (name === 'dark' || name === 'light') document.documentElement.setAttribute('data-theme', name)
  }
  function hostTheme() {
    try {
      var doc = window.parent && window.parent !== window ? window.parent.document : document
      var el = doc.documentElement
      var t = (el && (el.getAttribute('data-theme') || el.getAttribute('data-color-scheme'))) || ''
      if (t) return /dark/i.test(t) ? 'dark' : 'light'
      if (window.parent && window.parent.matchMedia) {
        return window.parent.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
    } catch (e) { /* 跨域就退回自己的判断 */ }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  applyTheme(theme || hostTheme())
  try {
    var phtml = window.parent.document.documentElement
    new MutationObserver(function () { applyTheme(hostTheme()) })
      .observe(phtml, { attributes: true, attributeFilter: ['data-theme', 'data-color-scheme', 'class'] })
  } catch (e) { /* 跨域就算了 */ }

  // ---------- toast ----------
  var toastTimer = 0
  function toast(text, ms) {
    var el = $('toast')
    el.textContent = text
    el.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { el.hidden = true }, ms || 2600)
  }

  // 导入完成提示：导入是本地抽取（pdf/OCR 不走模型），本次模型用量恒为 0；
  // 另取案卷台今日合计（/api/usage），把真实花过的 token 一并报出来。
  function importDoneToast(folder, updated, job) {
    var used = (job && typeof job.modelUsage === 'number') ? job.modelUsage : 0
    var base = (updated ? '已刷新：' : '已导入：') + folder + ' · 本次模型用量 ' + used + ' token'
    if (!used) base += '（导入是本地抽取，不走模型）'
    fetch(API + '/usage', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        var t = j && j.ok && j.today ? Number(j.today.total) : null
        toast(base + (t === null ? '' : ' · 案卷台今日 ' + t + ' token（' + j.today.calls + ' 次模型调用）'), 5600)
      })
      .catch(function () { toast(base, 5200) })
  }

  function copyText(text, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg) }, function () { toast(text, 5000) })
    } else {
      toast(text, 5000)
    }
  }

  // ---------- 把话交给宿主 ----------
  var PENDING_FILL = null

  function handOver(text, submit) {
    var canPost = window.parent && window.parent !== window
    if (canPost) {
      window.parent.postMessage({ source: 'game-desk', type: 'fill', text: text, submit: submit !== false }, location.origin)
      toast('已经写进对话输入框，正在发出…')
      return
    }
    copyText(text, '开局指令已复制，粘到对话里发出去')
  }

  /** 复制但不把整段指令倒进 toast（指令很长，toast 会糊满屏）。 */
  function copyQuiet(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast('不在应用里：指令已复制，粘到对话里发出去', 4200) },
        function () { toast('不在应用里：没法送进对话，复制也没成', 4200) }
      )
      return
    }
    toast('不在应用里：没法送进对话', 4200)
  }

  /** 交给宿主填进对话并发出去，等回执（客户端半填完会回一条 filled）。 */
  function handOverRaw(text, submit) {
    return new Promise(function (resolve) {
      if (!(window.parent && window.parent !== window)) {
        copyQuiet(text)
        resolve({ ok: false, why: 'no-host' })
        return
      }
      var id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      PENDING_FILL = { id: id, resolve: resolve }
      window.parent.postMessage({
        source: 'game-desk', type: 'fill', id: id, ack: true,
        text: text, submit: submit !== false
      }, location.origin)
      setTimeout(function () {
        if (PENDING_FILL && PENDING_FILL.id === id) {
          PENDING_FILL = null
          resolve({ ok: false, why: 'no-ack' })
        }
      }, 2000)
    })
  }

  function goConversation() {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source: 'game-desk', type: 'show-conversation' }, location.origin)
      toast('已切到对话')
      return
    }
    toast('在应用里点左侧「对话」就能看到这一局')
  }

  // ---------- 开局指令 ----------
  function openingText(c) {
    var seats = (c.roles || []).map(function (r) { return r.id })
    var mineIdx = tableMe(c)
    var human = (c.roles || []).filter(function (r, i) { return mineIdx >= 0 ? i === mineIdx : r.player === 'human' }).map(function (r) { return r.id })
    var ai = (c.roles || []).filter(function (r, i) { return mineIdx >= 0 ? i !== mineIdx : r.player !== 'human' }).map(function (r) { return r.id })
    var lines = [
      '开一局《' + c.title + '》（case ' + c.id + '）——这一局要用团队模式。',
      '',
      '① 取本子（先 load，它会顺带报出格式问题）：',
      '   jubensha_case —— action="load", dir="' + c.dir + '"',
      '',
    ]
    if (c.imported) {
      lines.push('   （导入本：可读正文在 _text\\ 下的 txt，原始资料在 _source\\ —— 先读 txt，别去解析扫描件 PDF。）', '')
    }
    lines.push(
      '② 开局：',
      '   jubensha_state —— action="start", caseId="' + c.id + '", title="' + c.title + '", seats=' + JSON.stringify(seats) + ', humanSeat="' + (human[0] || '') + '"',
    )
    if (ai.length > 0) {
      lines.push('', '③ 让 ' + ai.join('、') + ' 上桌（jubensha_player spawn，需要 agent-team 服务）。一座一份：用 jubensha_case action="book" 取那个座位的引用，原样填进 roleBook，别转述、别换座位。')
    }
    return lines.join('\n')
  }

  function packOpeningText(c) {
    var pdfs = c.files.filter(function (x) { return x.kind === 'pdf' })
    var imgs = c.files.filter(function (x) { return x.kind === 'image' })
    var groups = Object.keys(c.groups || {})
    var lines = [
      '开一局《' + c.title + '》——这是一份外置资料夹，没有 case.yml。',
      '',
      '资料位置：' + c.dir,
      '文件：' + c.files.length + ' 个（PDF ' + pdfs.length + ' · 图片 ' + imgs.length + '），分组：' + groups.join('、'),
    ]
    if (c.hasText) {
      lines.push('已抽出纯文本：' + c.dir + '\\_text\\ 下的 txt（直接用这些读本，别去解析 PDF）。')
    } else {
      lines.push('还没有纯文本：先在案卷台点「抽出文字」，或在对话里让我抽。')
    }
    lines.push(
      '',
      '这一局你直接当 DM，不走 jubensha_case load：',
      '① 先读正文与人物剧本，摸清真相、时间线、每个人的秘密；',
      '② 我确认坐哪一座后开场，其余座位你来推进（要 AI 玩家就 jubensha_player spawn，没有就你代述）；',
      '③ 线索图在' + (groups.indexOf('线索') >= 0 ? '「线索」' : '图片') + '里，按轮次发放，别一次全给。',
      '',
      '本子里的原文优先于你的常识；没写的细节不要替本子补。'
    )
    return lines.join('\n')
  }

  function arcadeText(m) {
    return '用 dsh-xgame 开一局「' + m.name + '」：scheme=' + m.id + '，难度 1。直接调 game_start，然后按开局简报以主持人身份开场。'
  }



  // 这一本有没有未完的对局：和 table.js 用同一个存档键，有对白/有幕次/有笔记就算开着
  function tableSave(c) {
    try {
      var raw = localStorage.getItem('gd:table:' + state.root + '|' + c.folder)
      if (!raw) return null
      var s = JSON.parse(raw)
      if (!s) return null
      var turns = (s.chat || []).length
      if (!turns && (Number(s.act) || 1) <= 1 && !(s.dealt || []).length && !String(s.note || '').trim()) return null
      return { act: Number(s.act) || 1, turns: turns, running: s.running !== false }
    } catch (e) { return null }
  }

  var LAST_REVIEW = {} // root|folder → 刚拿到的复核回包（宿主 meta 还没刷新时也照样画得出结果与按钮）

  // ---------- 复核 / 补全 / 撤销 三个动作 ----------
  function postJson(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return null }).then(function (j) { return { status: r.status, body: j } })
    })
  }
  function setBtnBusy(btn, busy, text) {
    if (!btn) return
    if (busy) {
      if (btn.__gdOld == null) btn.__gdOld = btn.textContent
      btn.disabled = true
      btn.textContent = text
      return
    }
    btn.disabled = false
    if (btn.__gdOld != null) { btn.textContent = btn.__gdOld; btn.__gdOld = null }
  }
  var listDebounce = 0

  // 对局室里选过谁，档案页的座位 chips 跟着走（localStorage 与 table.js 同一个键）
  function tableMe(c) {
    try {
      var raw = localStorage.getItem('gd:table:' + state.root + '|' + c.folder)
      var got = raw ? JSON.parse(raw) : null
      if (got && typeof got.me === 'number' && got.me >= 0) return got.me
    } catch (e) { /* 读不到就按本子的 human 标记 */ }
    return -1
  }

  // ---------- 昵称：座位、在场名册、DM 台词都用这个名字 ----------
  function nick() {
    try {
      var v = localStorage.getItem('gd-nick')
      if (v) return v
      v = '玩家' + Math.random().toString(36).slice(2, 6)
      localStorage.setItem('gd-nick', v)
      return v
    } catch (e) { return '玩家' + Math.random().toString(36).slice(2, 6) }
  }
  function setNick(v) {
    var s = String(v == null ? '' : v).trim().slice(0, 12)
    if (!s) return ''
    try { localStorage.setItem('gd-nick', s) } catch (e) { /* 存不下就只在这一次生效 */ }
    return s
  }

  // ---------- 座位认领：同一本书的席位存在服务端，谁的浏览器都不独占 ----------
  var SEAT_MAP = {}   // key = root|folder → 服务端回的 seats 列表
  function seatWho() {
    try {
      var w = localStorage.getItem('gd-who')
      if (w) return w
    } catch (e) { /* 私密模式读不到 localStorage，就退回启动时生成的 WHO */ }
    return typeof WHO === 'string' ? WHO : ''
  }
  function seatKeyOf(c) { return state.root + '|' + c.folder }
  function seatsCached(c) { return SEAT_MAP[seatKeyOf(c)] || [] }
  function seatLabelOf(s) { return (s && s.name) || ((s && s.via) === 'local' ? '房主' : '另一位玩家') }
  function mySeatOf(c) {
    var arr = seatsCached(c)
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].mine === true) return Number(arr[i].seat)
    }
    return tableMe(c)
  }
  function postClaim(c, idx, name, done) {
    fetch(API + '/seats/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: state.root, folder: c.folder, seat: idx, who: seatWho(), name: name == null ? nick() : name })
    })
      .then(function (r) {
        return r.json().catch(function () { return {} }).then(function (j) { return { status: r.status, j: j || {} } })
      })
      .then(function (got) { if (typeof done === 'function') done(got.j, got.status) })
      .catch(function () { if (typeof done === 'function') done(null, 0) })
  }
  function loadSeats(c, cb) {
    var u = API + '/seats?root=' + encodeURIComponent(state.root) + '&folder=' + encodeURIComponent(c.folder) +
      '&who=' + encodeURIComponent(seatWho())
    fetch(u, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.ok) SEAT_MAP[seatKeyOf(c)] = j.seats || []
        if (typeof cb === 'function') cb()
      })
      .catch(function () { /* 拉不到座位就当没人占，不挡人玩 */ })
  }
  function seatRowHtml(c, mineIdx) {
    var taken = {}
    var srvMine = -1
    seatsCached(c).forEach(function (s) {
      if (!s) return
      if (s.mine === false) taken[Number(s.seat)] = s
      else if (s.mine === true) srvMine = Number(s.seat)
    })
    var mySeat = srvMine >= 0 ? srvMine : mineIdx
    return (c.roles || []).map(function (r, i) {
      var mine = mySeat >= 0 ? i === mySeat : r.player === 'human'
      var s = taken[i]
      if (s && !mine) {
        var label = seatLabelOf(s)
        return '<button class="seat is-taken" data-me="' + i + '" type="button" disabled title="这一席已经被「' +
          esc(label) + '」选了"><b>' + esc(r.name || r.id) + '</b><em>（' + esc(label) + '）</em></button>'
      }
      // 自己真认领了的席写昵称；只按 case 的 human 标记高亮的那一席仍写「你」
      var em = mine ? '你' : 'AI'
      if (mySeat >= 0 && i === mySeat) em = '（' + esc(nick()) + '）'
      return '<button class="seat' + (mine ? ' is-human' : '') + '" data-me="' + i + '" type="button" title="' +
        (mine ? '你现在演这个' : '选他当你演的角色') + '"><b>' + esc(r.name || r.id) + '</b><em>' + em + '</em></button>'
    }).join('')
  }
  function paintSeatRow(c) {
    if (!c) return
    // 档案页可能已经翻到别的本了 —— 只重画当前这本的座位
    if (!state.active || state.active.folder !== c.folder) return
    var row = $('dossier') && $('dossier').querySelector('.seat-row')
    if (!row) return
    row.innerHTML = seatRowHtml(c, tableMe(c))
    Array.prototype.forEach.call(row.querySelectorAll('.seat[data-me]'), function (el) {
      el.addEventListener('click', function () { pickSeat(c, Number(el.getAttribute('data-me'))) })
    })
  }
  var SEAT_POLL = null
  function startSeatPoll() {
    if (SEAT_POLL) clearInterval(SEAT_POLL)
    // 12 秒一次：页开着就等于给自己的席位续期（GET 顺带保鲜 2 分钟），也顺手把别人的占位刷出来
    SEAT_POLL = setInterval(function () {
      var c = state.active
      if (!c) return
      // 对局室开着时由 table.js 自己那份 12 秒轮询负责（它还要停/起），这边让位，别双跑同一份请求
      var tbl = $('table')
      if (tbl && !tbl.hidden) return
      if (!$('dossier') || !$('dossier').querySelector('.seat-row')) return
      loadSeats(c, function () { paintSeatRow(c) })
    }, 12000)
  }

  // 在档案页直接点座位换人（对局室打开时读的是同一份存档）
  function pickSeat(c, idx) {
    var taken = {}
    seatsCached(c).forEach(function (s) { if (s && s.mine === false) taken[Number(s.seat)] = s })
    if (taken[idx] && taken[idx].mine !== true) {
      toast('这一席已经被「' + seatLabelOf(taken[idx]) + '」选了，换一个')
      return
    }
    postClaim(c, idx, nick(), function (j, status) {
      if (j && j.ok === true) {
        SEAT_MAP[seatKeyOf(c)] = j.seats || []
        var k = 'gd:table:' + state.root + '|' + c.folder
        var st = { act: 1, dealt: [], note: '', t0: Date.now(), seat: idx, tab: 'roles', me: idx }
        try { var raw = localStorage.getItem(k); if (raw) st = JSON.parse(raw) } catch (e) { /* 坏档就重开 */ }
        st.me = idx
        st.seat = idx
        try { localStorage.setItem(k, JSON.stringify(st)) } catch (e) { /* 存不下不致命 */ }
        // 只重画座位那一排：renderCase 会把 #dossier 整页换掉（滚动位置清零、正文闪一下）
        paintSeatRow(c)
        toast('你现在演：' + (((c.roles || [])[idx] || {}).name || ('座位 ' + idx)))
        return
      }
      if (status === 409 || (j && j.error === 'seat-taken')) {
        toast('这一席已经被「' + seatLabelOf(j && j.holder) + '」选了，换一个')
        loadSeats(c, function () { paintSeatRow(c) })
        return
      }
      if (status === 0) toast('选座位没成功，网络不通')
      else toast('选座位没成功，再点一次')
    })
  }

  var GAPS_AUTO = {}

  // 手机端：档案页里的「返回列表」
  $('dossier').addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('.backlink') : null
    if (!b) return
    document.body.classList.remove('is-detail')
    var on = $('cases').querySelector('.case.is-on')
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' })
  })

  // 缺项复核 / 按复核结果重算 / AI 补全 / 撤销：档案页里按 data-gd-act 分派（事件委托，不写 inline onclick）。
  $('dossier').addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-gd-act]') : null
    if (!el) return
    var act = el.getAttribute('data-gd-act')
    var folder = el.getAttribute('data-gd-folder') || (state.active && state.active.folder) || ''
    if (!folder) return
    if (act === 'review') runPackReview(folder, el)
    else if (act === 'recompute') packRecompute(folder, el)
    else if (act === 'fill-one') packFill(folder, el, el.getAttribute('data-gd-key') || '')
    else if (act === 'gotofill') gotoAiFill()
    else if (act === 'undo') packUndo(folder, el.getAttribute('data-gd-key') || '', el.getAttribute('data-gd-label') || '', el)
    else if (act === 'playtest') runPackPlaytest(folder, el, el.getAttribute('data-gd-force') === '1')
  })

  // ---------- 选中 ----------
  function select(folder) {
    var hit = state.cases.filter(function (c) { return c.folder === folder })[0]
    if (!hit) return
    state.active = hit
    document.body.classList.add('is-detail')
    // 选好这本就立刻重画房间条（拿上一次的快照重画，不等心跳回包）：标题当场变成
    // 「准备开：某本 · 还没开房」，chips 也立刻换成这本的。
    try { var rbc0 = rb.current(); roombarPaint(rbc0.r, rbc0.via, true) } catch (e) { /* 画不出来不碍事 */ }
    try { roomBeat() } catch (e) { /* 心跳失败不碍事 */ }
    renderList()
    fetch(API + '/case?root=' + encodeURIComponent(state.root) + '&folder=' + encodeURIComponent(folder), { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '读取失败')
        if (j.case.kind === 'pack') renderPack(j.case)
        else renderCase(j.case)
      })
      .catch(function (e) { toast('读不出这本：' + e.message) })
  }

  // ---------- 书库 ----------
  function renderLibSelect() {
    var sel = $('lib')
    sel.innerHTML = state.roots.map(function (r, i) {
      var label = i === 0 ? '本子库' : baseName(r)
      return '<option value="' + esc(r) + '"' + (r === state.root ? ' selected' : '') + ' title="' + esc(r) + '">' + esc(label) + '</option>'
    }).join('')
    var dl = $('i-paths')
    if (dl) dl.innerHTML = state.roots.map(function (r) { return '<option value="' + esc(r) + '"></option>' }).join('')
  }

  function loadCases(root, keepActive) {
    var qs = root ? '?root=' + encodeURIComponent(root) : ''
    return fetch(API + '/cases' + qs, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '读取失败')
        state.roots = j.roots && j.roots.length ? j.roots : [j.dir]
        state.root = j.dir
        state.cases = j.cases || []
        renderLibSelect()
        var wanted = keepActive && state.active ? state.active.folder : (state.cases[0] && state.cases[0].folder)
        if (state.roots.length > 1) state.filter = state.filter
        renderChips()
        renderList()
        if (state.cases.length === 0) {
          state.active = null
          $('dossier').innerHTML = '<article class="empty"><p class="empty-k">这个书库还是空的</p><p class="empty-l">' +
            '根目录：<code>' + esc(state.root) + '</code><br />一个本子一个子目录；有 <code>case.yml</code> 就按结构化读，没有就按资料夹读。<br />' +
            '也可以点左上「＋ 目录」把别处的本子合辑加进来。</p>' +
            '<button class="primary" id="empty-new" type="button">新建第一本</button></article>'
          $('empty-new').addEventListener('click', openSheet)
          return
        }
        if (wanted) select(wanted)
        return state.cases
      })
      .catch(function (e) {
        $('cases').innerHTML = '<div class="empty" style="text-align:left;margin:24px 8px"><p class="empty-k" style="font-size:16px">读不到书库</p><p class="empty-l">' + esc(e.message) + '</p></div>'
        toast('读不到书库：' + e.message)
      })
  }

  // 只刷清单、不重选：抽取/体检收尾后把新落的 meta（标签 + 排序）捞回来，别打断正在看的档案页。
  function reloadListQuiet() {
    var qs = state.root ? '?root=' + encodeURIComponent(state.root) : ''
    return fetch(API + '/cases' + qs, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) return null
        state.roots = j.roots && j.roots.length ? j.roots : [j.dir]
        state.root = j.dir
        state.cases = j.cases || []
        if (state.active) {
          var hit = state.cases.filter(function (x) { return x.folder === state.active.folder })[0]
          if (hit) state.active = hit
        }
        renderLibSelect()
        renderChips()
        renderList()
        return state.cases
      })
      .catch(function () { return null })
  }

  function addRoot() {
    var hint = state.root
    var given = window.prompt('把书库根目录的完整路径粘进来（里面一个本子一个子目录）：', hint || 'D:\\')
    if (given == null) return
    var v = given.trim()
    if (v === '') return
    fetch(API + '/roots', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: v }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '加不进来')
        toast('已加入书库：' + baseName(j.root), 3000)
        return loadCases(j.root, false)
      })
      .catch(function (e) { toast('加不进来：' + e.message, 4200) })
  }

  // ---------- 游戏厅 ----------
  var ARC_MODES = null
  var ARC_ITEMS = null
  var A_LAST = null
  var A_POLL = null

  function arcTag(it) {
    return esc((Number(it.chars) > 0 ? '已读 ' + Number(it.chars) + ' 字 · ' + it.files + ' 文件' : '还没抽出文字') + (it.players ? ' · ' + it.players : ''))
  }

  // 玩法 id → 中文名（导入弹层的提示与 toast 用；未知 id 原样显示）
  var ARC_SCHEME_CN = {
    soup: '海龟汤',
    detective: '侦探推理',
    escape: '密室逃脱',
    party: '剧本杀·反转',
    loop: '时间循环',
    council: '王国议会',
    trpg: '单人跑团'
  }
  var A_TAB = 'folder'

  function renderArcade(modes) {
    ARC_MODES = modes
    // 内容卡不再铺进网格（2026-11-20 需求）：归到某一档玩法的都收进那张卡右下角的「更多 N」，
    // 网格只留玩法卡 + 没归类的散装内容 + 「导入内容」。一份几条、几个文本文件、多少字，点开「更多」一次看清。
    var allItems = ARC_ITEMS || []
    var known = {}
    modes.forEach(function (m) { known[m.id] = 1 })
    var looseItems = allItems.filter(function (x) { return !known[x.scheme] })
    // button 里不能嵌 button：每张玩法卡包一层 .mode-wrap，把「＋导入」放在旁边做绝对定位。
    $('modes').innerHTML = modes.map(function (m) {
      return '<div class="mode-wrap">' +
        '<button class="mode" data-id="' + esc(m.id) + '" type="button">' +
        '<span class="mode-no">' + esc(m.no) + ' / ' + esc(m.id) + '</span>' +
        '<span class="mode-name">' + esc(m.name) + '</span>' +
        '<span class="mode-line">' + esc(m.line) + '</span>' +
        '<span class="mode-tag">' + esc(m.tag + (m.players ? ' · ' + m.players : '')) + '</span>' +
        '</button>' +
        '<button class="mode-imp" type="button" data-imp="' + esc(m.id) + '" title="往「' + esc(m.name) + '」里加一份内容">＋导入</button>' +
        (function () {
          var mine = allItems.filter(function (x) { return x.scheme === m.id })
          if (!mine.length) return ''
          var files = 0
          mine.forEach(function (x) { files += Number(x.files) || 0 })
          return '<button class="mode-more" type="button" data-more="' + esc(m.id) + '" title="看「' + esc(m.name) + '」里的 ' + mine.length + ' 份内容 / ' + files + ' 个文本文件">更多 ' + mine.length + '</button>'
        })() +
        '</div>'
    }).join('') +
      looseItems.map(contentCard).join('') +
      '<div class="mode is-add" role="button" tabindex="0" title="导入一个资料夹到内容库">' +
      '<span class="mode-plus">＋</span><span class="mode-name">导入内容</span>' +
      '<span class="mode-line">案例集 / 小说 / 设定集 → 材料局</span></div>'
    Array.prototype.forEach.call($('modes').querySelectorAll('button.mode'), function (el) {
      el.addEventListener('click', function () {
        var m = modes.filter(function (x) { return x.id === el.getAttribute('data-id') })[0]
        if (m && window.GameArcade && m.actions && m.actions.length) { window.GameArcade.open(m); return }
        if (m) startGame('「' + m.name + '」', arcadeText(m), '游戏厅的开局也留在这张卡片上，不跳走。')
      })
    })
  }

  function loadCatalog() {
    fetch(API + '/catalog', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) { if (j && j.ok) { renderArcade(j.modes); loadArcadeExtra() } else throw new Error((j && j.error) || '读取失败') })
      .catch(function (e) { $('modes').innerHTML = '<div class="empty" style="text-align:left"><p class="empty-l">玩法目录读不到：' + esc(e.message) + '</p></div>' })
  }

  function loadArcadeExtra() {
    fetch(API + '/arcade', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.ok) { ARC_ITEMS = j.items || []; if (ARC_MODES) renderArcade(ARC_MODES); refreshArcMore() }
      })
      .catch(function () { /* 内容库读不到就只列七种玩法 */ })
  }

  function arcadeSplit(folder, btn) {
    // 拆包：把「一个条目里装了多份汤」的合集按场景拆成一条一碗汤（后端 /api/arcade/split）
    if (!folder) return
    var label = btn ? btn.textContent : ''
    if (btn) { btn.disabled = true; btn.textContent = '拆分中…' }
    var done = function (msg, ms) {
      if (btn) { btn.disabled = false; btn.textContent = label || '拆分' }
      toast(msg, ms || 5200)
    }
    fetch(API + '/arcade/split', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folder: folder })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j } }) })
      .then(function (x) {
        if (!x.ok || !x.j || !x.j.ok) { done('拆分失败：' + ((x.j && x.j.error) || '未知错误')); return }
        var made = x.j.made || []
        var names = made.slice(0, 3).map(function (m) { return m.title }).join('、')
        done('已拆出 ' + made.length + ' 条：' + names + (made.length > 3 ? ' 等' : '') + '（原条目保留，可自己删）', 7000)
        loadArcadeExtra()
      })
      .catch(function (e) { done('拆分失败：' + e.message) })
  }

  function deleteArcade(folder) {
    if (!window.confirm('把「' + folder + '」从内容库移除？原件资料夹不动。')) return
    fetch(API + '/arcade/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder: folder }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '删不掉')
        toast('已从内容库移除：' + folder)
        loadArcadeExtra()
      })
      .catch(function (e) { toast('删不掉：' + e.message) })
  }

  // ---------- 游戏厅 · 导入内容 ----------
  // 两个页签：资料夹（抽字后登记）/ 手写一条（不建资料夹，直接落一段正文）。
  // 玩法下拉与人数是两边共用的同一个控件（#a-scheme / #a-players），不重复 id。
  function arcadeTab(which) {
    A_TAB = which === 'hand' ? 'hand' : 'folder'
    var hand = A_TAB === 'hand'
    var folder = $('a-pane-folder')
    var pane = $('a-pane-hand')
    if (folder) folder.hidden = hand
    if (pane) pane.hidden = !hand
    Array.prototype.forEach.call(document.querySelectorAll('#arcade-sheet .arcade-tab'), function (el) {
      var on = el.getAttribute('data-atab') === A_TAB
      el.classList.toggle('is-on', on)
      el.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    // 两个页签各有一个主按钮：资料夹=扫描并抽字，手写=保存这条
    var scan = $('arcade-scan')
    var save = $('a-hand-save')
    if (scan) scan.hidden = hand
    if (save) save.hidden = !hand
  }
  // scheme 给了（点了某张玩法卡的「＋导入」）= 预选该玩法 + 顶部提示；soup 默认落到手写页签。
  // 从顶栏「导入内容」或「导入内容」卡进来时没有 scheme，保持老行为：不预选、资料夹页签。
  function openArcadeImport(scheme) {
    var sid = typeof scheme === 'string' ? scheme : ''
    $('arcade-sheet').hidden = false
    $('arcade-result').hidden = true
    $('arcade-result').innerHTML = ''
    A_LAST = null
    stopArcadePoll()
    var hint = $('a-hint')
    if (sid !== '' && ARC_SCHEME_CN[sid]) {
      $('a-scheme').value = sid
      if (hint) { hint.textContent = '这份会归到「' + ARC_SCHEME_CN[sid] + '」'; hint.hidden = false }
      arcadeTab(sid === 'soup' ? 'hand' : 'folder')
    } else {
      if (hint) { hint.textContent = ''; hint.hidden = true }
      arcadeTab('folder')
    }
    var first = A_TAB === 'hand' ? $('a-hand-title') : $('a-path')
    if (first && first.focus) { try { first.focus() } catch (e) { /* 焦点抢不到不算错 */ } }
  }
  function closeArcadeImport() { $('arcade-sheet').hidden = true; stopArcadePoll() }
  // 轮询已从 setInterval 改成 setTimeout 退避，两种都要清
  function stopArcadePoll() {
    if (A_POLL) { clearInterval(A_POLL); clearTimeout(A_POLL); A_POLL = null }
  }
  function arcadePaint(pct, label, busy) {
    var box = $('arcade-result')
    box.hidden = false
    var pc = Math.max(2, Math.min(100, Math.round(pct)))
    box.innerHTML = '<div class="progress"><div class="progress-top"><div class="progress-bar"><i class="' + (busy ? 'is-wait' : '') + '" style="width:' + pc + '%"></i></div>' +
      '<span class="progress-pct">' + pc + '%</span></div>' +
      '<span class="progress-l">' + esc(label) + '</span></div>'
  }
  function arcadeReady(msg) {
    if (!A_LAST) return
    var box = $('arcade-result')
    box.hidden = false
    if (box.querySelector('#a-add')) return
    box.insertAdjacentHTML('beforeend',
      '<p class="peek-hint">' + esc(msg || '抽字没跑完也能先登记；没文字的本子开了局主持人也读不到东西。') + '</p>' +
      '<div class="importbar"><span class="peek-k">' + esc(baseName(A_LAST.root) + ' \ ' + A_LAST.folder) + '</span>' +
      '<button class="primary" id="a-add" type="button">登记进内容库</button></div>')
    var btn = $('a-add')
    if (btn) btn.addEventListener('click', function () { arcadeAdd(btn) })
  }
  // 进度轮询：一次丢包不再永久停（退避 800→1600→3200ms，最多 10 次）；
  // 「登记进内容库」按钮与轮询解耦 —— done / error / 放弃三条路都会调 arcadeReady，
  // 以前只有轮询成功路径调，轮询一死这个按钮就永不出现。
  var A_FAILS = 0
  function arcadeWatch(root, folder) {
    stopArcadePoll()
    A_FAILS = 0
    var q = '?root=' + encodeURIComponent(root) + '&folder=' + encodeURIComponent(folder)
    function again(ms) {
      if (A_POLL) { clearInterval(A_POLL); clearTimeout(A_POLL) }
      A_POLL = setTimeout(tick, ms)
    }
    function stopWithText(txt) {
      if (A_POLL) { clearInterval(A_POLL); clearTimeout(A_POLL); A_POLL = null }
      arcadePaint(0, txt, false)
      arcadeReady('')
    }
    function lost() {
      if (A_FAILS < 10) {
        A_FAILS++
        again(800 * Math.pow(2, Math.min(2, A_FAILS - 1)))
        return
      }
      stopWithText('进度接口一直没应答（已重试 ' + A_FAILS + ' 次），可先用「登记进内容库」手动登记')
    }
    function tick() {
      fetch(API + '/extract/status' + q, { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || j.ok === false) {
            // 接口答话了、但明确说不行（访客页 / 没权限 / 这本没见过）：给文案并停，别落到「排队中」
            A_FAILS = 0
            stopWithText('看不到抽取进度：' + errCn(j && j.error, '接口没应答'))
            return
          }
          A_FAILS = 0
          var st = (j && j.extracting) || { state: 'idle' }
          if (j && j.ocr) st.ocr = j.ocr
          var done = Number(st.done) || 0
          var total = Number(st.total) || 0
          if (st.state === 'running') {
            var img = st.phase === 'image'
            var base = img ? 60 : 8
            var span = img ? 30 : 52
            var pct = total ? base + (done / total) * span : base
            var rel = String(st.rel || '').split('/').pop() || ''
            arcadePaint(pct, (img ? '认图（扫描件走 OCR，慢）' : '抽文字') +
              (total ? ' ' + done + ' / ' + total : '') +
              (rel ? ' · ' + baseName(rel) : '') +
              ' · ' + Math.round((Number(st.elapsedMs) || 0) / 1000) + ' 秒' +
              (st.ocr && st.ocr.queued ? ' · 队列等 ' + st.ocr.queued + '（串行）' : ''), true)
          } else if (st.state === 'idle') {
            arcadePaint(5, '排队中…前面还有 OCR 活（串行）', true)
          } else if (st.state === 'error') {
            arcadePaint(30, '抽取出了错，仍可登记（多半没文字）', false)
            arcadeReady('')
            return
          } else {
            arcadePaint(88, st.cached ? '这本之前抽过，已有文字' : '文字抽取完成', false)
            arcadeReady('')
            return
          }
          again(900)
        }, lost)
        .catch(lost)
    }
    A_POLL = setTimeout(tick, 900)
  }
  function arcadeDirs(j) {
    var box = $('arcade-result')
    box.hidden = false
    box.innerHTML = '<p class="peek-k">这一层是合集：点一个资料夹再抽字。</p><div class="peek-dirs">' +
      j.items.map(function (d) {
        return '<button class="peek-dir" type="button" data-folder="' + esc(d.folder) + '"><span class="peek-dir-n">' + esc(d.title || d.folder) + '</span>' +
          '<span class="peek-dir-m">' + d.files + ' 个文件' + (d.hasCase ? ' · 有 case.yml' : '') + '</span></button>'
      }).join('') + '</div>'
    Array.prototype.forEach.call(box.querySelectorAll('.peek-dir'), function (el) {
      el.addEventListener('click', function () {
        $('a-path').value = j.root + '\\' + el.getAttribute('data-folder')
        arcadeScan()
      })
    })
  }
  function arcadeScan() {
    var v = ($('a-path').value || '').trim().replace(/^"|"$/g, '')
    if (v === '') { toast('先填资料夹路径'); return }
    stopArcadePoll()
    A_LAST = null
    arcadePaint(3, '清点文件…', true)
    fetch(API + '/peek', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: v }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '扫描失败')
        if (j.kind === 'dirs') { arcadeDirs(j); return }
        A_LAST = { root: j.root, folder: j.folder }
        if (j.kind === 'case') { arcadePaint(88, '结构化本子：文字就在 case.yml 里', false); arcadeReady('可以直接登记。'); return }
        if (j.extracted) { arcadePaint(88, '文字已就绪', false); arcadeReady('这本之前抽过字，直接登记就行。') }
        else if (j.extracting && j.extracting.state === 'error') { arcadePaint(30, '抽取出了错', false); arcadeReady('') }
        else arcadeWatch(j.root, j.folder)
      })
      .catch(function (e) { arcadePaint(0, '扫描失败：' + e.message, false) })
  }
  var A_AUTO_POLL = 0
  function arcadeAutoStop() { if (A_AUTO_POLL) { clearTimeout(A_AUTO_POLL); A_AUTO_POLL = 0 } }
  // 自动整理导入（m05164）：一个子资料夹算一篇 —— 后端识文字（图片/扫描件走 OCR）后逐篇建条目，
  // 这里只负责起任务 + 轮询进度。生成完就能在玩法卡上点「随机」每次换一篇。
  function arcadeAutoImport(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '整理中…' }
    arcadePaint(4, '自动整理：正在识文字并拆成一篇一篇…', true)
    var reset = function () { if (btn) { btn.disabled = false; btn.textContent = '登记进内容库' } }
    fetch(API + '/arcade/auto', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      root: A_LAST.root, folder: A_LAST.folder, scheme: ($('a-scheme') && $('a-scheme').value) || ''
    }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '启动失败')
        tick()
      })
      .catch(function (e) { toast('自动整理启动失败：' + e.message, 5200); reset() })
    function tick() {
      fetch(API + '/arcade/auto/status', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          var a = (j && j.auto) || {}
          var total = Number(a.total) || 0
          var done = Number(a.done) || 0
          var pct = total ? Math.min(96, Math.round(done / total * 100)) : 6
          var label = a.phase === 'ocr'
            ? ('识文字：' + (a.rel || '') + '（' + Math.min(done + 1, total) + '/' + total + '）')
            : ('整理中：' + (a.rel || '') + '（' + Math.min(done + 1, total) + '/' + total + '）')
          arcadePaint(pct, label, true)
          if (a.running) { A_AUTO_POLL = setTimeout(tick, 1400); return }
          A_AUTO_POLL = 0
          if (a.error) { arcadePaint(0, '整理失败：' + a.error, false); toast('自动整理失败：' + a.error, 6200); reset(); return }
          var made = (a.made || []).length
          var bad = (a.failed || []).length
          arcadePaint(100, '已整理成 ' + made + ' 篇' + (bad ? '（失败 ' + bad + '）' : ''), false)
          toast('已整理成 ' + made + ' 篇' + (bad ? '（失败 ' + bad + '）' : '') + '：玩法卡右下角点「随机」，每次换一篇', 7600)
          closeArcadeImport()
          loadArcadeExtra()
        })
        .catch(function () { A_AUTO_POLL = setTimeout(tick, 2200) })
    }
  }

  // 随机挑一篇（m05164）：按玩法从内容库随机取一条并直接开材料局 —— 「每次重开换一篇」。
  function arcadeRandom(scheme) {
    if (!scheme) return
    fetch(API + '/arcade/random', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scheme: scheme }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '没有可随机的内容')
        var it = j.entry
        if (it && window.GameRoom) { it.root = state.root; window.GameRoom.open(it); toast('随机开：' + it.title, 3600) }
        else if (it) toast('房间脚本没加载')
      })
      .catch(function (e) { toast('随机开失败：' + e.message, 5200) })
  }

  // ---------- 游戏厅 · 某一档的「更多」 ----------
  // 内容卡不铺网格之后，一档玩法里到底有几份、几个文本文件，靠这个弹层交代。
  var ARC_MORE = ''
  function schemeItems(scheme) {
    return (ARC_ITEMS || []).filter(function (x) { return x.scheme === scheme })
  }
  function moreRow(it) {
    return '<div class="am-row" data-open="' + esc(it.folder) + '" role="button" tabindex="0" title="按这份资料开一局">' +
      '<div class="am-t">' + esc(it.title) + '</div>' +
      '<div class="am-m">' + arcTag(it) + '</div>' +
      '<div class="am-acts">' +
      (it.scheme === 'soup' && Number(it.files) >= 4
        ? '<button class="am-b" type="button" data-amsplit="' + esc(it.folder) + '" title="按场景拆成一条一碗汤（合集用）">拆分</button>'
        : '') +
      '<button class="am-b" type="button" data-amkill="' + esc(it.folder) + '" title="从内容库移除">移除</button>' +
      '</div></div>'
  }
  function openArcMore(scheme) {
    var list = schemeItems(scheme)
    var cn = ARC_SCHEME_CN[scheme] || scheme
    if (!list.length) { toast('「' + cn + '」里还没有内容：点卡片上的「＋导入」加一份'); return }
    ARC_MORE = scheme
    var files = 0
    var chars = 0
    list.forEach(function (x) { files += Number(x.files) || 0; chars += Number(x.chars) || 0 })
    $('arc-more-title').textContent = cn + ' · 内容库'
    $('arc-more-sum').textContent = '共 ' + list.length + ' 份内容 · ' + files + ' 个文本文件 · ' + chars +
      ' 字；点任意一条按它开一局。'
    $('arc-more-list').innerHTML = list.map(moreRow).join('')
    $('arc-more').hidden = false
  }
  function closeArcMore() { $('arc-more').hidden = true; ARC_MORE = '' }
  // 内容库变了（拆分/移除/新登记）就照着新数据重画；画完空了直接把弹层收起。
  function refreshArcMore() {
    if (!$('arc-more') || $('arc-more').hidden) return
    if (!schemeItems(ARC_MORE).length) { closeArcMore(); return }
    openArcMore(ARC_MORE)
  }

  function arcadeAdd(btn) {
    if (!A_LAST) return
    if ($('a-auto') && $('a-auto').checked) { arcadeAutoImport(btn); return }
    if (btn) { btn.disabled = true; btn.textContent = '登记中…' }
    fetch(API + '/arcade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      root: A_LAST.root, folder: A_LAST.folder, scheme: $('a-scheme').value, title: ($('a-title').value || '').trim(), players: ($('a-players').value || '').trim()
    }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '登记失败')
        toast((j.entry && j.entry.updated ? '已刷新：' : '已登记：') + j.entry.title + '（' + j.entry.scheme + '）')
        closeArcadeImport()
        loadArcadeExtra()
      })
      .catch(function (e) {
        toast('登记失败：' + e.message)
        if (btn) { btn.disabled = false; btn.textContent = '登记进内容库' }
      })
  }
  // 手写一条：不碰资料夹、不抽字，直接 POST {scheme,title,text,truth,players}（body 里不能带 folder，
  // 后端靠 folder === undefined 认这条新形态）。本地先校验，免得白跑一趟拿 400。
  function arcadeHandSave() {
    var btn = $('a-hand-save')
    var scheme = $('a-scheme').value
    var title = (($('a-hand-title') && $('a-hand-title').value) || '').trim()
    var text = (($('a-hand-body') && $('a-hand-body').value) || '').trim()
    var truth = (($('a-hand-truth') && $('a-hand-truth').value) || '').trim()
    var players = (($('a-players') && $('a-players').value) || '').trim()
    if (title === '') { toast('先给它起个名字（1~30 字）'); if ($('a-hand-title')) $('a-hand-title').focus(); return }
    if (title.length > 30) { toast('名字最多 30 字'); return }
    if (text.length < 10) { toast('材料正文至少 10 字，先把汤面写清楚'); if ($('a-hand-body')) $('a-hand-body').focus(); return }
    if (truth.length > 20000) { toast('汤底最多 20000 字'); return }
    if (btn) { btn.disabled = true; btn.textContent = '保存中…' }
    fetch(API + '/arcade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      scheme: scheme, title: title, text: text, truth: truth, players: players
    }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '保存失败')
        var saved = (j.entry && j.entry.title) || title
        toast('已加到「' + (ARC_SCHEME_CN[scheme] || scheme) + '」：' + saved)
        if ($('a-hand-title')) $('a-hand-title').value = ''
        if ($('a-hand-body')) $('a-hand-body').value = ''
        if ($('a-hand-truth')) $('a-hand-truth').value = ''
        if (btn) { btn.disabled = false; btn.textContent = '保存这条' }
        closeArcadeImport()
        loadArcadeExtra()
      })
      .catch(function (e) {
        toast(e.message)
        if (btn) { btn.disabled = false; btn.textContent = '保存这条' }
      })
  }

  // ---------- 公网额度（机主面） ----------
  function loadRemote() {
    fetch(API + '/remote', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        var used = $('r-used')
        if (!used) return
        if (!j || !j.ok || !j.remote) {
          used.textContent = '公网额度只能在机主电脑上管'
          return
        }
        $('r-mode').value = j.remote.mode
        $('r-daily').value = String(j.remote.daily)
        used.textContent = '今天已耗 ' + j.remote.used + ' / ' + j.remote.daily + ' 次 · 来自 ' + j.remote.byIp + ' 个来源'
      })
      .catch(function () { var u = $('r-used'); if (u) u.textContent = '额度接口没应答' })
  }
  function remoteSave() {
    var body = { mode: $('r-mode').value }
    var d = ($('r-daily').value || '').trim()
    if (d !== '') body.daily = Number(d)
    fetch(API + '/remote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '存不下')
        toast('公网额度策略已保存')
        loadRemote()
      })
      .catch(function (e) { toast('存不下：' + e.message) })
  }

  // ---------- 新建 ----------
  function openSheet() { $('sheet').hidden = false; $('f-title').focus() }
  function closeSheet() { $('sheet').hidden = true; $('f-title').value = '' }

  function createCase() {
    var title = $('f-title').value.trim()
    if (title === '') { toast('先给本子取个名字'); return }
    var body = { title: title, players: Number($('f-players').value), genre: $('f-genre').value, root: state.root }
    fetch(API + '/case', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '建不出来')
        closeSheet()
        toast('已建好骨架：' + j.folder)
        return loadCases(state.root, false)
      })
      .catch(function (e) { toast('建不出来：' + e.message) })
  }

  // ---------- 对局室：把本子铺在页内（table.js 负责这一屏） ----------
  function openTable(c) {
    if (window.GameTable) {
      window.GameTable.open({ case: c, root: state.root })
      return
    }
    // 老页面（缓存了旧 app.js）没有 table.js 时退回原来那张开场卡
    startGame('《' + c.title + '》', c.kind === 'pack' ? packOpeningText(c) : openingText(c), '这条是旧版本的开场卡。')
  }

  // ---------- 开局：留在页内的对局视图（游戏厅与兜底用） ----------
  function matchSteps(list) {
    $('match-steps').innerHTML = list.map(function (s) {
      return '<li class="step is-' + esc(s.state) + '"><span class="step-dot"></span>' +
        '<span class="step-l">' + esc(s.label) + '</span>' +
        '<span class="step-d">' + esc(s.detail || '') + '</span></li>'
    }).join('')
    var done = list.filter(function (s) { return s.state === 'done' }).length
    var running = list.some(function (s) { return s.state === 'run' })
    var bar = $('match-bar')
    bar.style.width = Math.max(6, Math.round((done / list.length) * 100)) + '%'
    bar.className = running ? 'is-wait' : ''
  }

  function startGame(title, text, note) {
    var steps = [
      { key: 'load', label: '装载本子', detail: '', state: 'run' },
      { key: 'compose', label: '组装开局指令', detail: '', state: 'wait' },
      { key: 'send', label: '写进对话并发出', detail: '', state: 'wait' },
      { key: 'hand', label: '交给会话接手', detail: '', state: 'wait' }
    ]
    $('match-title').textContent = title
    $('match-sub').textContent = note || ''
    $('match-note').textContent = ''
    $('match-actions').innerHTML = ''
    $('match-text').textContent = text
    $('match').hidden = false
    matchSteps(steps)

    function set(key, state, detail) {
      steps.forEach(function (s) { if (s.key === key) { s.state = state; if (detail != null) s.detail = detail } })
      matchSteps(steps)
    }

    setTimeout(function () {
      set('load', 'done', '已就位')
      set('compose', 'run')
      setTimeout(function () {
        set('compose', 'done', text.length + ' 字')
        set('send', 'run', '正在填进输入框…')
        handOverRaw(text, true).then(function (r) {
          if (r.ok) {
            set('send', 'done', '已发出')
            set('hand', 'run', '等会话回第一句')
            $('match-bar').style.width = '86%'
            $('match-note').textContent = '会话在后台跑：先 load 一遍本子，再 start 开局。你可以留在这里，也可以切过去看它逐句推进。'
            $('match-actions').innerHTML =
              '<button class="primary" id="match-go" type="button">切到对话</button>' +
              '<button class="ghost" id="match-keep" type="button">留在这一页</button>'
            $('match-go').addEventListener('click', goConversation)
            $('match-keep').addEventListener('click', function () { $('match').hidden = true })
            setTimeout(function () {
              set('hand', 'done', '已接手，去对话里看')
              $('match-bar').style.width = '100%'
            }, 2800)
            return
          }
          if (r.why === 'no-ack') {
            set('send', 'warn', '没等到回执')
            $('match-note').textContent = '客户端没回话（多半是跑的还是旧版客户端 —— 它会自动切到对话）。指令应该已经发出去了，切过去看看。'
            $('match-actions').innerHTML = '<button class="primary" id="match-go" type="button">切到对话</button>'
            $('match-go').addEventListener('click', goConversation)
            return
          }
          if (r.why === 'no-host') {
            set('send', 'warn', '不在应用里')
            $('match-note').textContent = '这一页是单独打开的，送不进对话 —— 指令在右边，复制走或直接在应用里点「开这一局」。'
            $('match-actions').innerHTML =
              '<button class="primary" id="match-copy" type="button">复制指令</button>' +
              '<button class="ghost" id="match-retry" type="button">重试</button>'
            $('match-copy').addEventListener('click', function () { copyText(text, '开局指令已复制'); })
            $('match-retry').addEventListener('click', function () { startGame(title, text, note) })
            return
          }
          set('send', 'fail', '填不进去')
          $('match-note').textContent = '找不到对话输入框（可能正在生成回复）。等它停下来，点重试。'
          $('match-actions').innerHTML = '<button class="primary" id="match-retry" type="button">重试</button>'
          $('match-retry').addEventListener('click', function () { startGame(title, text, note) })
        })
      }, 260)
    }, 240)
  }

  // ---------- 导入剧本（路径 → 体检 → 导入） ----------
  var PEEK = null
  var peekPoll = null

  function openImport() {
    $('import-sheet').hidden = false
    $('import-result').hidden = true
    $('import-result').innerHTML = ''
    PEEK = null
    $('i-path').focus()
  }

  function closeImport() {
    $('import-sheet').hidden = true
    if (peekPoll) { clearTimeout(peekPoll); peekPoll = null }
  }

  function peekFiles(entry) {
    var files = entry.files || []
    var rows = files.slice(0, 12).map(function (x) {
      var ext = (x.rel.split('.').pop() || '').toLowerCase()
      return '<div class="peek-file"><span class="file-kind">' + esc(ext) + '</span>' +
        '<span class="file-name">' + esc(x.name || x.rel) + '</span>' +
        '<span class="file-size">' + (x.size ? esc(bytes(x.size)) : '') + '</span></div>'
    }).join('')
    return rows + (files.length > 12 ? '<div class="peek-more">还有 ' + (files.length - 12) + ' 个文件…</div>' : '')
  }

  function renderPeekDirs(j) {
    var box = $('import-result')
    box.hidden = false
    box.innerHTML =
      '<div class="peek-k">这个目录下有 ' + j.items.length + ' 个资料夹 <em>选一个继续</em></div>' +
      '<div class="peek-dirs">' + j.items.map(function (it) {
        return '<button class="peek-dir" data-folder="' + esc(it.folder) + '" type="button">' +
          '<span class="peek-dir-n">' + esc(it.title) + '</span>' +
          '<span class="peek-dir-m">' + it.files + ' 个文件' + (it.players ? ' · ' + it.players + ' 人本' : '') +
          (it.hasCase ? ' · 已有档案' : '') + '</span></button>'
      }).join('') + '</div>'
    Array.prototype.forEach.call(box.querySelectorAll('.peek-dir'), function (el) {
      el.addEventListener('click', function () {
        $('i-path').value = String(j.root).replace(/[\\/]+$/, '') + '\\' + el.getAttribute('data-folder')
        scanPath(false)
      })
    })
  }

  function renderPeekPack(j) {
    PEEK = j
    var s = j.screen || { verdict: 'partial', checks: [] }
    var v = VERDICT[s.verdict] || VERDICT.partial
    var checks = s.checks || []
    var okN = checks.filter(function (x) { return x.level === 'ok' }).length
    var nFiles = (j.entry && j.entry.files) ? j.entry.files.length : 0
    var busy = !!(j.extracting && j.extracting.state === 'running')
    var banner = busy
      ? '<div class="verdict is-busy"><b>正在体检</b><span>先把这本的字读出来（扫描件走 OCR，一本几分钟）；抽完自动重判。</span>' +
        '<em>' + nFiles + ' 个文件</em></div>'
      : '<div class="verdict is-' + esc(v.k) + '"><b>' + esc(v.label) + '</b><span>' + esc(v.line) + '</span>' +
        '<em>' + okN + ' / ' + checks.length + ' 项通过</em></div>'
    var checksHtml = busy ? '' : '<div class="checks">' + checks.map(function (x) {
      return '<div class="check"><span class="dot is-' + esc(x.level) + '"></span>' +
        '<span class="check-l">' + esc(x.label) + '</span>' +
        '<span class="check-d">' + esc(x.detail) + '</span></div>'
    }).join('') + '</div>'
    var box = $('import-result')
    box.hidden = false
    box.innerHTML =
      '<div class="peek-k">' + esc(j.folder) + ' <em>' + nFiles + ' 个文件</em></div>' +
      banner +
      '<div class="progress" id="peek-progress" hidden><div class="progress-top"><div class="progress-bar"><i id="peek-pbar"></i></div>' +
        '<span class="progress-pct" id="peek-ppct">0%</span></div>' +
        '<div class="progress-l" id="peek-plabel"></div></div>' +
      checksHtml +
      '<div class="peek-files">' + peekFiles(j.entry || {}) + '</div>' +
      '<div class="importbar"><button class="primary" id="btn-peek-import" type="button">' +
        (s.verdict === 'blocked' ? '强行导入' : '导入成本子') + '</button>' +
        '<button class="ghost sm" id="btn-peek-case" type="button">只看这一本</button>' +
        '<span class="import-hint">导入会把原始文件拷进本子库的 _source/，抽出的文字在 _text/。</span></div>'
    $('btn-peek-import').addEventListener('click', function () {
      if (s.verdict === 'blocked') {
        if (!window.confirm('这一本一份可读文字都没抽出来。仍然导入吗？导入后 AI 读不到正文。')) return
        importPeek(true)
        return
      }
      importPeek(false)
    })
    $('btn-peek-case').addEventListener('click', function () {
      var root = j.root
      closeImport()
      loadCases(root, false).then(function () { select(j.folder) })
    })
    if (j.extracting && j.extracting.state === 'running') {
      var hold = $('btn-peek-import')
      if (hold) { hold.disabled = true; hold.textContent = '先抽字…' }
      var hint = box.querySelector('.import-hint')
      if (hint) hint.textContent = '正在把这本的字读出来（扫描件走 OCR，一本几分钟）。抽完会自动重判，进度见上面的条。'
      watchPeek(j.root, j.folder)
    }
  }

  function peekPct(st) {
    if (!st || st.state === 'idle') return 0
    if (st.state === 'done') return 100
    if (st.phase === 'scan') return 4
    if (st.phase === 'text' || st.phase === 'image') {
      var t1 = st.total || 0
      return t1 ? 6 + Math.min(48, Math.round(48 * (st.done || 0) / t1)) : 10
    }
    if (st.phase === 'copy') {
      var t2 = st.total || 0
      return t2 ? 56 + Math.min(36, Math.round(36 * (st.done || 0) / t2)) : 60
    }
    if (st.phase === 'write') return 96
    return 8
  }

  function peekLabel(st) {
    var sec = Math.round(((st && st.elapsedMs) || 0) / 1000)
    var cnt = st && st.total ? ' ' + (st.done || 0) + ' / ' + st.total : ''
    var at = st && st.rel ? ' · ' + baseName(st.rel) : ''
    var ocr = (st && st.ocr) || null
    var wait = ocr && ocr.queued > 0 ? ' · OCR ' + (ocr.parallel ? '并行' : '串行') + '排队 ' + ocr.queued : ''
    if (!st || st.state === 'idle') return ''
    if (st.state === 'done') return '做完了 · ' + sec + ' 秒'
    if (st.phase === 'scan') return '清点文件…'
    if (st.phase === 'text') return '抽文字' + cnt + at + ' · ' + sec + ' 秒' + wait
    if (st.phase === 'image') return '认图（扫描件走 OCR，慢）' + cnt + at + ' · ' + sec + ' 秒' + wait
    if (st.phase === 'copy') return '拷贝原始资料' + cnt + at
    if (st.phase === 'write') return '写 case.yml…'
    return '准备中…'
  }

  function paintPeek(st) {
    var el = $('peek-pbar')
    var lb = $('peek-plabel')
    var box = $('peek-progress')
    if (box) box.hidden = false
    var pc = peekPct(st)
    if (el) {
      el.className = st && st.state === 'running' ? 'is-wait' : ''
      el.style.width = pc + '%'
    }
    var pn = $('peek-ppct')
    if (pn) pn.textContent = pc + '%'
    if (lb) lb.textContent = peekLabel(st)
  }

  function watchPeek(root, folder) {
    var box = $('peek-progress')
    if (box) box.hidden = false
    function tick(st) {
      var el = $('peek-pbar')
      var lb = $('peek-plabel')
      if (!el) return true
      var sec = Math.round((st.elapsedMs || 0) / 1000)
      if (st.state === 'running') {
        paintPeek({ state: 'running', phase: st.phase || 'text', done: st.done || 0, total: st.total || 0, rel: st.rel || '', elapsedMs: st.elapsedMs || 0, ocr: st.ocr || null })
        return false
      }
      el.className = ''
      el.style.width = '100%'
      var pn = $('peek-ppct')
      if (pn) pn.textContent = '100%'
      if (st.state === 'done') {
        lb.textContent = '抽完：成功 ' + (st.made || 0) + ' 份' + (st.failed ? '，失败 ' + st.failed + ' 份' : '') +
          (st.cached ? '（用的本地缓存）' : '') + '，' + sec + ' 秒'
      } else if (st.state === 'error') {
        lb.textContent = '抽取出错：' + errCn(st.error, '未知')
      } else {
        lb.textContent = '没有可抽的文件'
      }
      return true
    }
    function loop() {
      fetch(API + '/extract/status?root=' + encodeURIComponent(root) + '&folder=' + encodeURIComponent(folder), { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          // 以前这里 !ok 直接 return：不重排、不报错、不画 —— 进度条永久冻在上一格，用户只能当它坏了。
          if (!j || j.ok === false) {
            var bar = $('peek-pbar')
            var lab = $('peek-plabel')
            var code = String((j && j.error) || '')
            if (bar) bar.className = ''
            if (/^(route-not-allowed|owner-only|forbidden)$/.test(code)) {
              // 访客/远程页永远看不到房主那台机器的抽取进度：说清楚，别装作在跑
              if (lab) lab.textContent = '这一步只有房主能做（远程/访客页）'
              toast('抽取进度只有房主这台机器看得到', 4200)
              return
            }
            var why = errCn(code, '进度接口没应答')
            if (lab) lab.textContent = '抽取出错：' + why
            toast('抽取出错：' + why, 4400)
            return
          }
          var ex = j.extracting || {}
          ex.ocr = j.ocr || null
          if (tick(ex)) { setTimeout(function () { scanPath(true) }, 400); return }
          peekPoll = setTimeout(loop, 900)
        })
        .catch(function () { peekPoll = setTimeout(loop, 1600) })
    }
    loop()
  }

  function scanPath(quiet) {
    var p = ($('i-path').value || '').trim()
    if (p === '') { toast('先填一个路径'); return }
    var btn = $('import-scan')
    var box = $('import-result')
    if (!quiet) {
      if (peekPoll) { clearTimeout(peekPoll); peekPoll = null }
      btn.disabled = true
      btn.textContent = '正在看…'
      box.hidden = false
      box.innerHTML = '<div class="peek-hint">正在读这个路径…</div>'
      PEEK = null
    }
    fetch(API + '/peek', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: p })
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j } }) })
      .then(function (out) {
        btn.disabled = false
        btn.textContent = '扫描并体检'
        var j = out.body
        if (!j || !j.ok) throw new Error(errCn(j && j.error, '读不到这个路径（HTTP ' + out.status + '）'))
        if (j.kind === 'case') {
          box.hidden = false
          box.innerHTML = '<div class="peek-k">这本已经有 <code>case.yml</code> <em>不用导入</em></div>' +
            '<div class="peek-hint">' + esc(j.title || j.folder) + '</div>' +
            '<div class="importbar"><button class="primary" id="btn-peek-open" type="button">在档案页打开</button></div>'
          $('btn-peek-open').addEventListener('click', function () {
            closeImport()
            loadCases(j.root, false).then(function () { select(j.folder) })
          })
          return
        }
        if (j.kind === 'dirs') { renderPeekDirs(j); return }
        renderPeekPack(j)
      })
      .catch(function (e) {
        btn.disabled = false
        btn.textContent = '扫描并体检'
        box.hidden = false
        box.innerHTML = '<div class="peek-hint is-bad">' + esc(e.message) + '</div>'
      })
  }

  function importPeek(force) {
    if (!PEEK) return
    var job = PEEK
    var btn = $('btn-peek-import')
    if (btn) { btn.disabled = true; btn.textContent = '正在导入…' }
    paintPeek({ state: 'running', phase: 'scan', elapsedMs: 0 })
    if (peekPoll) { clearTimeout(peekPoll); peekPoll = null }
    fetch(API + '/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: job.root, folder: job.folder, force: force === true })
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j } }) })
      .then(function (out) {
        var j = out.body
        if (!j || !j.ok) throw new Error((j && j.error) || ('导入没起来（HTTP ' + out.status + '）'))
        pollImport(job.root, job.folder, force === true)
      })
      .catch(function (e) {
        toast('导入失败：' + e.message, 4600)
        if (btn) { btn.disabled = false; btn.textContent = '导入成本子' }
        paintPeek({ state: 'idle' })
      })
  }

  // ui 可选（档案页「导入成本子」也走这条轮询）：{btn, quiet, idleText, again, onDone}
  // 不传 = 原来的弹层流程（importPeek → 这里），行为一字没变。
  function pollImport(root, folder, forced, ui) {
    var u = ui || {}
    function setBtn(txt, disabled) {
      var btn = u.btn || $('btn-peek-import')
      if (!btn) return
      btn.disabled = disabled === true
      btn.textContent = txt
    }
    function giveUp(msg) {
      setBtn(u.idleText || '导入成本子', false)
      if (msg) toast(msg, 5200)
    }
    function paint(st) { if (!u.quiet) paintPeek(st) }
    var idleTries = 0
    function loop() {
      fetch(API + '/import/status?root=' + encodeURIComponent(root) + '&folder=' + encodeURIComponent(folder), { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          var st = (j && j.importing) || { state: 'idle' }
          if (st.state === 'running') { st.ocr = j.ocr || null; paint(st); peekPoll = setTimeout(loop, 700); return }
          if (st.state === 'done' && st.cancelled === true) {
            // 取消后「跑完当前文件」也会进 done（宿主带 cancelled + error）：别显示成绿色的已完成
            paint({ state: 'idle' })
            giveUp('已取消：' + errCn(st.error, '跑完当前文件就停了'))
            return
          }
          if (st.state === 'done') {
            paint({ state: 'done', phase: 'done', elapsedMs: st.elapsedMs, done: st.total, total: st.total })
            var res = st.result || {}
            importDoneToast(res.folder || folder, res.updated, res)
            if (u.onDone) { u.onDone(res.folder || folder); return }
            setTimeout(closeImport, 900)
            // 用这个任务自己的 root（参数 root），别退回第一个书库
            loadCases(root, false).then(function () { select(res.folder || folder) })
            return
          }
          if (st.state === 'error') {
            var out = st.result || {}
            if (out.code === 422 && !forced) {
              if (window.confirm('体检没过：' + errCn(st.error, '没有可读文字') + '\n\n仍然把整包拷进本子库吗？')) {
                if (u.again) u.again(folder)
                else importPeek(true)
                return
              }
              paint({ state: 'idle' })
              giveUp('')
              return
            }
            paint({ state: 'error' })
            giveUp('导入失败：' + errCn(st.error, ''))
            return
          }
          // 一直 idle：任务可能被宿主重启清掉，或上一轮早就收尾了 —— 12 轮（约 15 秒）后放手，按钮别永远转
          idleTries++
          if (idleTries > 12) { paint({ state: 'idle' }); giveUp('没等到导入任务（宿主可能重启过）；再点一次') ; return }
          peekPoll = setTimeout(loop, 1200)
        })
        .catch(function () { peekPoll = setTimeout(loop, 1500) })
    }
    loop()
  }

  // ---------- 识图补齐（功能A，用户 m01150）：只对用户在档案页点出来的这一本跑，boot/后台永不主动 ----------
  // 202 起后台任务后绝不 await 长请求；照 pollImport 的 700ms 轮询形态拿进度。
  function runCaseOcr(folder, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '排队识图…' }
    function restore(label) {
      var b = $('btn-ocr')
      if (b) { b.disabled = false; b.textContent = label || '识图补齐' }
    }
    fetch(API + '/case/ocr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: state.root, folder: folder })
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j } }) })
      .then(function (out) {
        var j = out.body
        if (!j || !j.ok) { restore(); toast((j && j.error) || ('识图没起来（HTTP ' + out.status + '）'), 4600); return }
        if (j.note) toast(j.note, 5600)
        pollCaseOcr(folder, restore)
      })
      .catch(function (e) { restore(); toast('识图没起来：' + (e && e.message ? e.message : e), 4200) })
  }

  function pollCaseOcr(folder, restore) {
    var tries = 0
    function loop() {
      fetch(API + '/case/ocr/status?root=' + encodeURIComponent(state.root) + '&folder=' + encodeURIComponent(folder), { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          var st = (j && j.state) || 'idle'
          if (st === 'running') {
            var b = $('btn-ocr')
            if (b) b.textContent = '识图 ' + (j.done || 0) + '/' + (j.total || 0)
            // 全局 FIFO 闸：排在别人的大批抽取后面也正常，20 分钟起给个"后台仍在跑"的台阶
            if (++tries > 1700) { restore('识图仍在后台跑'); return }
            setTimeout(loop, 700)
            return
          }
          var made = (j && j.made ? j.made.length : 0)
          var failed = (j && j.failed) || []
          var names = failed.slice(0, 3).join('、') + (failed.length > 3 ? ' 等' + failed.length + ' 份' : '')
          if (st === 'error') {
            restore()
            toast('识图出错：' + ((j && j.error) || '未知') + (made ? '（已成 ' + made + ' 份）' : ''), 5600)
          } else if (failed.length) {
            restore()
            toast('识图完成 ' + made + ' 份，失败 ' + failed.length + ' 份（' + names + '）', 5600)
          } else if (st === 'done') {
            restore()
            toast('识图完成 ' + made + ' 份，失败 0 份', 4200)
          } else {
            restore()
          }
          // 体检/缺件/「抽出的文字」随这次重渲染自然刷新
          loadCases(state.root, false).then(function () { select(folder) })
        })
        .catch(function () { if (++tries < 40) setTimeout(loop, 1500); else restore() })
    }
    loop()
  }

  // ---------- 全局导入进度条（缺陷1：页面关了再进来，找回还在跑的导入） ----------
  // 宿主 IMPORT_JOBS 里任务照跑；这里只是把 UI 接回来。弹层开着时让位给弹层内的进度条。
  var stripPoll = null
  var stripHidden = false // 点 × 只收起本轮显示，不打断任务；下一次阶段变化会再亮
  var stripHideKey = ''    // 点 × 那一刻的 phase|done：变了就说明任务往前走了，条子该重新出现
  var STRIP_LAST = null    // 最近一次画上去的任务快照（× 时用来记 key）
  var importStripActive = false
  var ocrPollTimer = null
  var ocrWasActive = false

  function stripPhase(st) {
    var ph = (st && st.phase) || ''
    var name = ph === 'scan' ? '清点文件' : ph === 'text' ? '抽字' : ph === 'image' ? '抽字(OCR)' : ph === 'copy' ? '拷贝' : ph === 'write' ? '写档案' : '准备中'
    var cnt = st && st.total ? ' ' + (st.done || 0) + '/' + st.total : ''
    return name + cnt
  }

  function stripSheetOpen() {
    var sheet = $('import-sheet')
    return !!(sheet && !sheet.hidden)
  }

  function stripKeyOf(st) { return String((st && st.phase) || '') + '|' + String((st && st.done) || 0) }
  // × 只隐藏到下一次 job 阶段变化：以前 stripHidden 一置真就「本轮再也不显示」，
  // 用户关掉一次就彻底失去可见性。现在 phase/done 一变就重新亮。
  function stripHiddenNow(st) {
    if (stripSheetOpen()) return true
    if (!stripHidden) return false
    if (stripHideKey && stripKeyOf(st) !== stripHideKey) { stripHidden = false; stripHideKey = ''; return false }
    return true
  }

  function setStripPct(pct) {
    var p = $('imp-strip-pct')
    if (!p) return
    var v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)))
    p.textContent = v + '%'
  }

  function paintStrip(st, folder, ocr) {
    var el = $('imp-strip')
    if (!el) return
    STRIP_LAST = st || null
    if (stripHiddenNow(st)) { el.hidden = true; return }
    el.hidden = false
    var bar = $('imp-strip-bar')
    var pc = peekPct(st)
    if (bar) bar.style.width = pc + '%'
    setStripPct(pc)
    var lb = $('imp-strip-text')
    if (lb) {
      var wait = ocr && ocr.queued > 0 ? ' · OCR排队 ' + ocr.queued : ''
      lb.textContent = '正在导入：' + folder + ' · 阶段 ' + stripPhase(st) + wait + '（关掉不影响导入）'
    }
  }

  function stopStrip() {
    if (stripPoll) { clearTimeout(stripPoll); stripPoll = null }
  }

  function restoreImportStrip() {
    fetch(API + '/import/status', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        var st = (j && j.importing) || { state: 'idle' }
        var folder = (j && j.job && j.job.folder) || ''
        if (st.state === 'running') {
          stripHidden = false
          importStripActive = true
          paintStrip(st, folder, j.ocr)
          pollStrip()
          return
        }
        if (st.state === 'done' || st.state === 'error') {
          // 刚结束的（3 分钟窗口内）不打扰，只在 console 记一笔
          console.log('[game-desk] 导入任务' + (st.state === 'done' ? '刚完成' : '出错收场') + '：' + folder)
        }
      })
      .catch(function () {})
  }

  function pollStrip() {
    stopStrip()
    function loop() {
      fetch(API + '/import/status', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          var st = (j && j.importing) || { state: 'idle' }
          var folder = (j && j.job && j.job.folder) || ''
          if (st.state === 'running') {
            importStripActive = true
            paintStrip(st, folder, j.ocr)
            stripPoll = setTimeout(loop, 800)
            return
          }
          importStripActive = false
          stopStrip()
          var el = $('imp-strip')
          if (el) el.hidden = true
          if (st.state === 'done') {
            if (stripSheetOpen()) return // 弹层开着：它的 pollImport 负责 toast 与刷新，别报两遍
            var res = st.result || {}
            importDoneToast(res.folder || folder, res.updated, res)
            // 用服务端带回的任务 root（j.job.root），刷新完还留在导入时那个书库
            loadCases((j.job && j.job.root) || state.root, false)
          } else if (st.state === 'error') {
            if (!stripSheetOpen()) toast('导入失败：' + errCn(st.error, '未知'), 5200)
          }
        })
        .catch(function () { stripPoll = setTimeout(loop, 1600) })
    }
    stripPoll = setTimeout(loop, 800)
  }

  // ---------- 后台解析条（OCR/抽取任务，复用同一条 #imp-strip） ----------
  // 数据源 GET /api/ocr 的 jobs[]（EXTRACT_JOBS/IMPORT_JOBS 里 running 的）+ current[]（OCR 闸口台账）。
  // 热重载会丢在途任务的可见性（子进程继续跑、结果仍进缓存），这里查不到就安静地不显示，不谎报。
  function paintOcrStrip(snap) {
    var el = $('imp-strip')
    if (!el) return
    var job = snap.jobs && snap.jobs.length ? snap.jobs[0] : null
    var cur = snap.current && snap.current.length ? snap.current[0] : null
    STRIP_LAST = job || null
    // 没有在途 job、也没有 OCR 台账：后台其实什么都没跑。
    // 以前这里照样把条子显示出来写「后台解析：OCR 0%」，看着像永远卡在 0。
    if (!job && !OCR_SCAN.total && !cur) { el.hidden = true; return }
    if (stripHiddenNow(job || {})) { el.hidden = true; return }
    el.hidden = false
    var bar = $('imp-strip-bar')
    var pct = 0
    var txt = '后台解析：'
    if (job && job.total) {
      // 抽字已到 total、OCR 批次还在收尾时（实测会出现 19/19 挂两分钟），给 99% 而不是死钉 95%
      pct = (job.done >= job.total) ? 99 : Math.min(95, Math.round((job.done / job.total) * 100))
      // 识图补齐的 job.folder 是 caseDir 全路径，条上只给末段；再标一下这是哪个功能
      txt += (job.kind === 'case-ocr' ? '识图补齐 · ' : '') + baseName(job.folder || '') + ' · ' + stripPhase(job)
    } else if (OCR_SCAN.total) {
      // 同步抽取路径（POST /api/extract 不在 IMPORT_JOBS 里）没有单本 job：用整个书库的已扫/总量算百分比
      pct = Math.max(1, Math.min(99, Math.round((OCR_SCAN.done / OCR_SCAN.total) * 100)))
      txt += 'OCR · 书库已扫 ' + OCR_SCAN.done + '/' + OCR_SCAN.total
    } else {
      txt += 'OCR'
    }
    if (bar) bar.style.width = pct + '%'
    setStripPct(pct)
    var lb = $('imp-strip-text')
    if (!lb) return
    if (cur && cur.file) txt += '（当前 ' + baseName(cur.file) + '）'
    if (snap.jobs && snap.jobs.length > 1) txt += ' 等' + snap.jobs.length + '本'
    if (snap.queued > 0) txt += ' · OCR排队 ' + snap.queued
    lb.textContent = txt + '（关掉不影响后台）'
  }

  var OCR_SCAN = { done: 0, total: 0, at: 0 }

  function scanTotalsFrom(list) {
    var d = 0
    var t = 0
    ;(list || []).forEach(function (c) {
      if (!c || c.kind !== 'pack' || !c.scanned || !c.scanned.total) return
      d += Number(c.scanned.done) || 0
      t += Number(c.scanned.total) || 0
    })
    return { done: d, total: t, at: Date.now() }
  }

  // 书库扫描完成度：逐个 root 取 /api/cases（不带 root 只回 roots[0]，本子库里没有 pack）
  function scanTotalsAll() {
    var roots = (state.roots || []).slice()
    if (!roots.length) return Promise.resolve({ done: 0, total: 0, at: Date.now() })
    var done = 0
    var total = 0
    var chain = Promise.resolve()
    roots.forEach(function (r) {
      chain = chain.then(function () {
        return fetch(API + '/cases?root=' + encodeURIComponent(r), { cache: 'no-store' })
          .then(function (x) { return x.json() })
          .then(function (cj) {
            if (!cj || !cj.ok || !cj.cases) return
            var sc = scanTotalsFrom(cj.cases)
            done += sc.done
            total += sc.total
          })
          .catch(function () {})
      })
    })
    return chain.then(function () { return { done: done, total: total, at: Date.now() } })
  }

  function ocrPollTick() {
    if (importStripActive || stripSheetOpen()) return // 导入条优先、弹层内进度优先
    fetch(API + '/ocr', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        var snap = (j && j.ocr) || {}
        var active = (snap.jobs && snap.jobs.length) || snap.running > 0 || (snap.current && snap.current.length)
        if (active) {
          if (!ocrWasActive) { ocrWasActive = true; stripHidden = false } // 新一轮活动，× 的收起不跨轮
          if ((snap.jobs && snap.jobs.length) || Date.now() - OCR_SCAN.at < 4000) {
            paintOcrStrip(snap)
            return
          }
          scanTotalsAll().then(function (sc) {
            if (sc.total) OCR_SCAN = sc
            paintOcrStrip(snap)
          })
        } else if (ocrWasActive) {
          ocrWasActive = false
          var el = $('imp-strip')
          if (el) el.hidden = true
          reloadListQuiet() // 后台抽完一轮：把新落的体检标签与排序捞回来（用户 m01363）
        }
      })
      .catch(function () {})
  }

  function startOcrPoll() {
    if (ocrPollTimer) return
    ocrPollTimer = setInterval(ocrPollTick, 5000)
  }

  // ---------- 房间在场（任务4：心跳 + 在场条 + 强行开局）----------
  var WHO = ''
  try {
    WHO = localStorage.getItem('gd-who') || ''
    if (!WHO) { WHO = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('gd-who', WHO) }
  } catch (e) { WHO = Math.random().toString(36).slice(2, 10) }
  function roomExpect() {
    if (panel !== 'jubensha' || !state.active) return 0
    var n = (state.active.roles || []).length || Number(state.active.players) || 0
    return Math.max(0, Math.min(8, n))
  }

  // ---------- 书库列表 / 档案页：UI 已搬进 ./lib/listview.js 与 ./lib/packdossier.js ----------
  // 只搬不改：DOM（$）与书库状态（state）从 deps 注入，是这里同一个对象引用；LAST_REVIEW / GAPS_AUTO
  // 仍在这里声明，模块通过 getter 拿到同一份引用（对象内写回照旧生效）。
  // 下面是①工厂装配（依赖逐条显式列出）②同名薄委托 —— 页面里原来的调用点一行都不用改。
  var pd = createPackDossier({
    $: $,                        // 所有 DOM 查询都走它
    API: API,                    // /file /text /reveal 等直拼 URL 的地方
    state: state,                // 书库状态（同一个对象，读 root/cases/active）
    toast: toast,                // 操作失败/成功的提示
    select: select,              // 导入成本子后跳过去
    loadCases: loadCases,        // 复核/补全/撤销之后重取标签
    reloadListQuiet: reloadListQuiet,
    tableSave: tableSave,        // 座位、跑团桌状态的落盘
    openTable: openTable,
    copyText: copyText,
    pickSeat: pickSeat,
    seatRowHtml: seatRowHtml,
    paintSeatRow: paintSeatRow,
    loadSeats: loadSeats,
    tableMe: tableMe,
    runCaseOcr: runCaseOcr,
    pollImport: pollImport,
    postJson: postJson,
    setBtnBusy: setBtnBusy,
    arcTag: arcTag,              // 内容卡右上角的「已读 N 字」标签
    getLastReview: function () { return LAST_REVIEW },
    getGapsAuto: function () { return GAPS_AUTO }
  })
  // 体检结论文案表（ready/partial/blocked）在模块里那份是唯一来源：导入预览 renderPeekPack 还要用，取回来。
  var VERDICT = pd.VERDICT
  var lv = createListview({
    $: $,
    API: API,
    state: state,
    doc: document,               // ensurePackCss 要插 <style>，走注入的 document
    toast: toast,
    select: select,
    tableSave: tableSave,
    reloadListQuiet: reloadListQuiet,
    refreshActiveScreen: refreshActiveScreen   // 重算标签后把档案页的体检块拉新
  })

  function renderChips() { return lv.renderChips() }
  function renderList() { return lv.render() }
  function ensurePackTools() { return lv.ensurePackTools() }
  function caseMetaOf(c) { return pd.caseMetaOf(c) }
  function renderCase(c) { return pd.renderCase(c) }
  function renderPack(c) { return pd.renderPack(c) }
  function refreshActiveScreen() { return pd.refreshActiveScreen() }
  function runPackReview(folder, btn) { return pd.runPackReview(folder, btn) }
  function packRecompute(folder, btn) { return pd.packRecompute(folder, btn) }
  function packFill(folder, btn, oneKey) { return pd.packFill(folder, btn, oneKey) }
  function packUndo(folder, key, label, btn) { return pd.packUndo(folder, key, label, btn) }
  function runPackPlaytest(folder, btn, force) { return pd.runPackPlaytest(folder, btn, force) }
  function gotoAiFill() { return pd.gotoAiFill() }
  function contentCard(it) { return pd.contentCard(it) }
  function preview(c, rel, kind) { return pd.preview(c, rel, kind) }
  function previewUrl(url, name, isImage, text) { return pd.previewUrl(url, name, isImage, text) }
  function closeViewer() { return pd.closeViewer() }
  function reveal(path) { return pd.reveal(path) }


  // ---------- 房间条 / 房间设置：整套 UI 已搬进 ./lib/roombar.js（依赖注入工厂）----------
  // 这里只剩两件事：① 工厂装配（依赖一条条显式列出，为什么需要写在后面对应的行上）
  // ② 同名薄委托 —— 页面里原来那些调用点（roombarPaint / roomPaint / loadLan / lanSet /
  //    loadTunnel / tunnelSet）一行都不用改。
  // 留在 app.js 的是页面域与后端域：昵称读写（localStorage）、席位认领、心跳 roomBeat、/room 拉取、
  // 本子选择（select / loadCases / caseMetaOf）、远程开关（loadRemote）。
  var rb = createRoombar({
    $: $,                        // 所有 DOM 查询都走它，模块里不出现 document
    api: api,                    // 所有请求都走它，URL 前缀 API 不外泄
    toast: toast,                // 复制成功/失败、开房失败这些提示
    state: state,                // 只读：state.active（本机兜底那本）/ state.cases（「看这本」够不够得着）
    select: select,              // 「看这本」：本子已在书库里就直接选中
    loadCases: loadCases,        // 「看这本」：不在已载列表里时补拉一次再选
    caseMetaOf: caseMetaOf,      // 服务端还没解析 caseFolder 时，用本机这条的要素兜底
    nick: nick,                  // 昵称按钮显示的当前名（localStorage 在 app.js 里）
    setNick: setNick,            // 保存昵称（localStorage 写回，只在 app.js 里做）
    seatWho: seatWho,            // 在场名册里标「我」用的是同一台机器的 who
    copyText: copyText,          // 「房间链接」与弹层里的复制按钮
    setBtnBusy: setBtnBusy,      // 开房/关房按钮的忙态
    loadRoomBar: loadRoomBar,    // 隧道起来/关房后要重拉一次 /room
    loadRemote: loadRemote,      // 「房间设置」弹层打开时顺带拉远程开关
    reClaimMySeat: reClaimMySeat, // 改完昵称要让服务端席位名跟着变（席位域留在 app.js）
  })

  // 薄委托：调用点保持原名原签名（搬走后页面里 0 处调用点需要改）
  function roombarPaint(r, via, force) { return rb.paint(r, via, force) }
  function roomPaint(r) { return rb.roomPaint(r) }
  function loadLan() { return rb.loadLan() }
  function lanSet(body, okMsg) { return rb.lanSet(body, okMsg) }
  function loadTunnel() { return rb.loadTunnel() }
  function tunnelSet(body, okMsg, done) { return rb.tunnelSet(body, okMsg, done) }

  // 昵称改了要让服务端记的席位名字跟着变：这一本已经选了席，就再认领一次
  function reClaimMySeat() {
    var c = state.active
    if (!c) return
    var idx = mySeatOf(c)
    if (!(idx >= 0)) return
    postClaim(c, idx, nick(), function (j) {
      if (j && j.ok === true) {
        SEAT_MAP[seatKeyOf(c)] = j.seats || []
        paintSeatRow(c)
      }
    })
  }

  function loadRoomBar() {
    // 一进来先把这条画出来（r=null → 「还没开房」/「现在没有开着的房间」），不等 /room 回包：
    // 用户 2026-11-19「没有看到房间」—— 房间条一旦藏着，人既不知道房间在哪也不知道下一步点哪；
    // 服务端一答话，下面的 roombarPaint 立刻按真快照覆盖。
    var cur = rb.current()
    if (!cur.last) roombarPaint(null, cur.via, true)
    api('/room', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        // 编辑昵称时这一支也要穿透「编辑中不重画」的守卫（第三参 = 编辑中），否则输入框被冲掉
        if (j && j.ok) roombarPaint(j.room, j.room && j.room.you && j.room.you.via, rb.nickEditing())
      })
      .catch(function () {})
  }

  // 是不是 DSH 窗口里的嵌入页（页面 URL 带 ?panel=…）：只有嵌入页能接管房主，心跳把这个标记报给服务端，
  // 服务端据此判「谁该被点名为房主」——选了某一本（caseFolder）不再参与抢房主。
  // 每次现算，不用文件顶部那个 URLSearchParams 快照（页面内换 panel 也能跟上）。
  function embedFlag() { return (typeof location !== 'undefined' && /[?&]panel=/.test(location.search)) ? 1 : 0 }
  function roomBeat(extra) {
    var body = { room: panel, who: WHO, name: nick(), expect: roomExpect(), embed: embedFlag() }
    if (state.active && state.root) { body.caseFolder = state.active.folder; body.caseRoot = state.root }
    if (extra) { for (var k in extra) body[k] = extra[k] }
    try {
      fetch(API + '/room/beat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) return
          roombarPaint(j.room, j.room && j.room.you && j.room.you.via)
          var sheet = $('lan-sheet')
          if (sheet && !sheet.hidden) roomPaint(j.room)
        })
        .catch(function () {})
    } catch (e) { /* 心跳打不出去不碍事，下一轮再补 */ }
  }
  setInterval(roomBeat, 15000)
  setTimeout(roomBeat, 1200)
  window.addEventListener('beforeunload', function () {
    try {
      // 带上当前这本：服务端只清这一本的席位（不带的话老逻辑会清掉这个人在别的书里的座位）
   navigator.sendBeacon(API + '/room/beat', new Blob([JSON.stringify({ room: panel, who: WHO, bye: 1, embed: embedFlag(), caseRoot: state.root || '', caseFolder: (state.active && state.active.folder) || '' })], { type: 'application/json' }))
    } catch (e) { /* 发不掉也没关系，服务端 60 秒窗口会兜住 */ }
  })

  // ---------- 装配 ----------
  function setRoom(p) {
    panel = p === 'arcade' ? 'arcade' : 'jubensha'
    var arcade = panel === 'arcade'
    $('stage-jubensha').hidden = arcade
    $('stage-arcade').hidden = !arcade
    document.title = (arcade ? '游戏厅' : '剧本杀') + ' · 案卷台'
    $('room-jubensha').className = 'room-tab' + (arcade ? '' : ' is-on')
    $('room-arcade').className = 'room-tab' + (arcade ? ' is-on' : '')
    $('btn-new').hidden = arcade
    $('btn-import-case').hidden = arcade
    $('btn-import-arcade').hidden = !arcade
    var pmb = $('btn-packmeta')
    if (pmb) pmb.hidden = arcade // 标签只在剧本杀（资料夹区）语义下有意义
    if (arcade) { loadCatalog() } else if (!CASES_LOADED) {
      CASES_LOADED = true
      loadCases('', false)
    }
  }
  ensurePackTools()
  var CASES_LOADED = panel !== 'arcade'
  setRoom(panel)
  if (panel !== 'arcade') {
    var deepRoot = params.get('root') || ''
    var deepCase = params.get('case') || ''
    loadCases(deepRoot, false).then(function () {
      if (deepCase && state.cases.some(function (c) { return c.folder === deepCase })) select(deepCase)
    })
  }
  restoreImportStrip()
  startOcrPoll()
  loadRoomBar()
  startSeatPoll()

  $('lib').addEventListener('change', function (e) {
    state.active = null
    loadCases(e.target.value, false)
  })
  $('btn-addroot').addEventListener('click', addRoot)
  $('btn-refresh').addEventListener('click', function () { loadCases(state.root, true) })
  $('room-jubensha').addEventListener('click', function () { setRoom('jubensha') })
  $('room-arcade').addEventListener('click', function () { setRoom('arcade') })
  $('btn-lan').addEventListener('click', function () { $('lan-sheet').hidden = false; loadLan(); loadTunnel(); loadRemote() })
  $('lan-close').addEventListener('click', function () { $('lan-sheet').hidden = true })
  $('l-enable').addEventListener('change', function () {
    var on = $('l-enable').value === 'on'
    lanSet({ enabled: on }, on ? '局域网已开：把链接发到手机' : '局域网已关，端口释放')
  })
  $('l-saveport').addEventListener('click', function () {
    var n = Number(($('l-port').value || '').trim())
    if (!(n >= 1024 && n <= 65535)) { toast('端口要在 1024–65535'); return }
    lanSet({ port: n }, '端口已存；开着的话会重挂到新端口')
  })
  $('l-rotate').addEventListener('click', function () { lanSet({ rotate: true }, '换了把新钥匙：旧链接全部作废') })
  $('t-enable').addEventListener('change', function () {
    var on = $('t-enable').value === 'on'
    tunnelSet({ enabled: on }, on ? '隧道拉起中…' : '公网房间已关：链接立刻失效')
  })
  $('t-rotatekey').addEventListener('click', function () { tunnelSet({ rotate: true }, '公网钥匙已换：旧链接立刻作废') })
  $('btn-dir').addEventListener('click', function () { reveal(state.root) })
  $('btn-new').addEventListener('click', openSheet)
  $('btn-import-case').addEventListener('click', openImport)
  $('import-cancel').addEventListener('click', closeImport)
  $('import-scan').addEventListener('click', function () { scanPath(false) })
  $('import-sheet').addEventListener('click', function (e) { if (e.target === $('import-sheet')) closeImport() })
  $('i-path').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); scanPath(false) } })
  $('btn-import-arcade').addEventListener('click', openArcadeImport)
  $('arcade-cancel').addEventListener('click', closeArcadeImport)
  $('arcade-scan').addEventListener('click', arcadeScan)
  $('a-hand-save').addEventListener('click', arcadeHandSave)
  Array.prototype.forEach.call(document.querySelectorAll('#arcade-sheet .arcade-tab'), function (el) {
    el.addEventListener('click', function () { arcadeTab(el.getAttribute('data-atab')) })
  })
  $('arcade-sheet').addEventListener('click', function (e) { if (e.target === $('arcade-sheet')) closeArcadeImport() })
  // 某一档的「更多」弹层：点背板收起；行内按钮先拦（拆分 / 移除），剩下的点行就开材料局
  $('arc-more').addEventListener('click', function (e) { if (e.target === $('arc-more')) closeArcMore() })
  $('arc-more-close').addEventListener('click', function () { closeArcMore() })
  $('arc-more-rand').addEventListener('click', function () { var s = ARC_MORE; closeArcMore(); arcadeRandom(s) })
  $('arc-more-imp').addEventListener('click', function () { var s = ARC_MORE; closeArcMore(); openArcadeImport(s) })
  $('arc-more-list').addEventListener('click', function (e) {
    var kill = e.target.closest ? e.target.closest('[data-amkill]') : null
    if (kill) { e.stopPropagation(); deleteArcade(kill.getAttribute('data-amkill')); return }
    var sp = e.target.closest ? e.target.closest('[data-amsplit]') : null
    if (sp) { e.stopPropagation(); arcadeSplit(sp.getAttribute('data-amsplit'), sp); return }
    var row = e.target.closest ? e.target.closest('[data-open]') : null
    if (!row) return
    var f = row.getAttribute('data-open')
    var it = (ARC_ITEMS || []).filter(function (x) { return x.folder === f })[0]
    if (it && window.GameRoom) { it.root = state.root; closeArcMore(); window.GameRoom.open(it) }
    else if (it) toast('房间脚本没加载')
  })
  $('a-path').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); arcadeScan() } })
  $('r-mode').addEventListener('change', function () { remoteSave() })
  $('r-daily').addEventListener('change', function () { remoteSave() })
  $('modes').addEventListener('click', function (e) {
    var t = e.target
    // 玩法卡右上角的「＋导入」：只开弹层并预选该玩法，不启动游戏，所以先拦在这里
    // 玩法卡右下角的「更多 N」：这一档的内容全在弹层里列出来（不铺网格），顺手给随机 / 再加一份
    var more = t.closest ? t.closest('.mode-more') : null
    if (more) { e.stopPropagation(); openArcMore(more.getAttribute('data-more')); return }
    var imp = t.closest ? t.closest('.mode-imp') : null
    if (imp) { e.stopPropagation(); openArcadeImport(imp.getAttribute('data-imp')); return }
    var sp = t.closest ? t.closest('.ar-split') : null
    if (sp) { e.stopPropagation(); arcadeSplit(sp.getAttribute('data-split'), sp); return }
    var kill = t.closest ? t.closest('.ar-kill') : null
    if (kill) { e.stopPropagation(); deleteArcade(kill.getAttribute('data-kill')); return }
    var add = t.closest ? t.closest('.is-add') : null
    if (add) { openArcadeImport(); return }
    var card = t.closest ? t.closest('.is-content') : null
    if (card) {
      var f = card.getAttribute('data-folder')
      var it = (ARC_ITEMS || []).filter(function (x) { return x.folder === f })[0]
      // 把 root 一起交给房间：材料局存档按 root|folder 建键（room.js 读取 ENTRY.root，可能为空串）
      if (it && window.GameRoom) { it.root = state.root; window.GameRoom.open(it) }
      else if (it) toast('房间脚本没加载')
    }
  })
  $('match-close').addEventListener('click', function () { $('match').hidden = true })
  $('match').addEventListener('click', function (e) { if (e.target === $('match')) $('match').hidden = true })
  window.addEventListener('message', function (ev) {
    // 只收同源回执：本文件自己发消息用的就是 location.origin，别让别的窗口/框架塞一条假「filled」进来
    if (ev.origin !== location.origin) return
    var d = ev.data
    if (!d || d.source !== 'dsh-game-desk' || d.type !== 'filled') return
    if (PENDING_FILL) {
      var p = PENDING_FILL
      PENDING_FILL = null
      p.resolve({ ok: !!d.ok, why: d.ok ? 'ok' : 'fill-failed' })
    }
  })
  $('sheet-cancel').addEventListener('click', closeSheet)
  $('sheet-ok').addEventListener('click', createCase)
  $('sheet').addEventListener('click', function (e) { if (e.target === $('sheet')) closeSheet() })
  $('viewer-close').addEventListener('click', closeViewer)
  $('viewer').addEventListener('click', function (e) { if (e.target === $('viewer')) closeViewer() })
  // 每个键都同步重建列表 = 打字时列表在抖、滚动位置归零；压 120ms 去抖，停下来再画
  $('q').addEventListener('input', function (e) {
    state.q = e.target.value
    if (listDebounce) clearTimeout(listDebounce)
    listDebounce = setTimeout(function () { listDebounce = 0; renderList() }, 120)
  })
  // chips 是动态生成的，绑定必须走 #chips 容器委托（逐个绑会漏掉后加的）
  $('chips').addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('.chip') : null
    if (!el) return
    state.filter = el.getAttribute('data-filter')
    Array.prototype.forEach.call($('chips').querySelectorAll('.chip'), function (x) { x.classList.toggle('is-on', x === el) })
    renderList()
  })
  $('imp-strip-x').addEventListener('click', function () {
    // 记住点下去那一刻的阶段：任务往下走一步（phase/done 变）条子会自己回来
    stripHideKey = stripKeyOf(STRIP_LAST)
    stripHidden = true
    $('imp-strip').hidden = true
  })
  // 对局室要用的几件东西（table.js 通过它回话）
  function gotoRoom(p) {
    if (window.GameTable) { try { window.GameTable.close() } catch (e) {} }
    if (window.GameRoom) { try { window.GameRoom.close() } catch (e) {} }
    if (window.GameArcade) { try { window.GameArcade.close() } catch (e) {} }
    document.body.classList.remove('is-detail')
    setRoom(p)
  }
  window.GameDeskBridge = {
    gotoRoom: gotoRoom,
    send: handOverRaw,
    toConversation: goConversation,
    preview: previewUrl,
    opening: openingText,
    packOpening: packOpeningText,
    toast: toast
  }

  // 编辑态（输入框/文本域/下拉/可编辑区）不接管按键：否则在导入路径、笔记、提问框里打「/」
  // 会被全局搜索快捷键吞掉、焦点被抢到左侧搜索框。
  function isEditing(el) {
    if (!el) return false
    var tag = String(el.tagName || '').toUpperCase()
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
  }
  document.addEventListener('keydown', function (e) {
    var editing = isEditing(e.target || document.activeElement)
    // 编辑态一律让路（Esc 例外：它只关弹层、不吞输入，输入框里按 Esc 关层是既有行为，别顺手改掉）
    if (editing && e.key !== 'Escape') return
    if (e.key === 'Escape') { closeSheet(); closeImport(); closeViewer(); closeArcadeImport(); closeArcMore(); $('lan-sheet').hidden = true; $('match').hidden = true; if (window.GameTable) window.GameTable.close(); if (window.GameRoom) window.GameRoom.close(); return }
    if (e.key === '/') { e.preventDefault(); $('q').focus() }
  })
})()
