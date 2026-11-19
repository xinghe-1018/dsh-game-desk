/* 对局室：不开新会话，就在这一页把本子铺开（座位 / 正文 / 线索 / 笔记）。
   数据全部来自 /api/case 已经取回的那份对象，状态存 localStorage。 */
(function () {
  'use strict'

  var API = '/game-desk/api'
  var KEY = 'gd:table:'
  var S = null          // { root, folder, act, dealt: [], note, t0, seat, tab }
  var M = null          // 本子的桌面上摆法
  var tick = null

  function $(id) { return document.getElementById(id) }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] }) }
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
  function open(payload) {
    var c = payload.case || payload
    // key() 要用 root/folder，先把它们放到 S 上再读存档：否则 S 还是 null，key() 抛错被 catch 吞掉，读档全落空
    S = { root: payload.root || '', folder: c.folder || '' }
    S = Object.assign(S, load())
    if (typeof S.running === 'undefined') S.running = true
    if (typeof S.accMs !== 'number') S.accMs = 0
    // 「开/继续这一局」永远落在对局页签 —— 旧存档里被误写进 tab 的 roles 在这里一并洗掉
    S.tab = 'play'
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
  }

  function close() {
    // 收桌 = 停表：用时定格进存档，下次回来还是静止的，点计时器才继续走
    if (S && S.running !== false) { S.accMs = elapsedMs(); S.running = false }
    var host = $('table')
    if (host) { host.hidden = true; host.innerHTML = '' }
    document.body.classList.remove('is-table')
    if (tick) { clearInterval(tick); tick = null }
    save()
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
    if (c.genre) foot.push(c.genre)
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
        return '<div class="seatbtn' + (S.seat === i ? ' is-on' : '') + (mine ? ' is-mine' : '') + '" data-seat="' + i + '">' +
          '<b>' + esc(s.name) + '</b>' +
          '<em>' + (mine ? '你' : 'AI') + '</em>' +
          '<button class="seat-mine" data-mine="' + i + '" type="button">' + (mine ? '你在演' : '我演这个') + '</button>' +
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
        S.me = Number(b.getAttribute('data-mine'))
        S.seat = S.me
        // 换演谁不跳页签：正在对局就留在对局，DM 下一句按新席位来
        save()
        paintChrome()
        renderSeats()
        renderMain()
        if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('你现在演：' + M.seats[S.me].name)
      })
    })
  }

  /* ---------- 渲染：页签 ---------- */
  var TABS = [
    { id: 'play', label: '对局' },
    { id: 'intro', label: '引子' },
    { id: 'body', label: '正文' },
    { id: 'roles', label: '人物剧本' },
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

  /* ---------- 页内对局（宿主 llm 当 DM，不回会话） ---------- */
  var CHAT_BUSY = false
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
    fetch(API + '/dm/health', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (j) {
      if (!j || !j.llm || !j.model) {
        var n = $('tbl-chat-note')
        if (n) n.textContent = '没探到宿主的模型服务 —— 页内对局开不了；可以先用「引子 / 正文 / 人物剧本」自己主持。'
      } else if ($('tbl-chat-model') && !(S.chat || []).length) {
        $('tbl-chat-model').textContent = '模型 ' + j.model
      }
    }).catch(function () { /* 探不到就算了，发送时自然报错 */ })
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
        if (n3) n3.textContent = 'DM 没接上：' + (j && j.error ? j.error : '未知错误')
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
      if (n4) n4.textContent = 'DM 没接上：' + (e && e.message ? e.message : e)
    })
  }

  function renderMain() {
    renderTabs()
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
          S.me = S.seat
          save()
          renderSeats()
          renderMain()
          if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('你现在演：' + s.name)
        })
        bindUnlock()
        return
      }
      box.innerHTML = '<div class="readhint">' + esc(s.name) + ' · ' + (mineNow ? '你演这个' : 'AI 演这个') +
        (mineNow ? '' : ' <button class="ghost sm" id="tbl-mine" type="button">我演这个</button>') +
        '</div><div id="tbl-doc"></div>'
      if ($('tbl-mine')) $('tbl-mine').addEventListener('click', function () {
        S.me = S.seat
        save()
        renderSeats()
        renderMain()
        if (window.GameDeskBridge && GameDeskBridge.toast) GameDeskBridge.toast('你现在演：' + s.name)
      })
      loadDoc(s.file, $('tbl-doc'))
      return
    }
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

  window.GameTable = { open: open, close: close }
})()
