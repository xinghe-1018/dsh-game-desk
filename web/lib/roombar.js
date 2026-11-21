/* 房间条 UI（第二轮前端模块化：从 app.js 逐字搬出来的一整套，逻辑零改动）。
   = 房间条本体（房间条绘制 / 昵称行 / 开房·关房·房间链接 / 在场名册）
   + 它依赖的两块「房间设置」弹层内容（局域网、公网隧道）与弹层里的房间块。

   依赖注入工厂：模块自己不碰 localStorage / fetch / location / 页面私有变量 —— 需要什么全由 app.js 传进来
   （deps 清单见 createRoombar 开头）。app.js 那边只留 createRoombar({...}) 与几个同名薄委托。 */
import { esc, genreCn, playersText } from './util.js'

export function createRoombar(deps) {
  // ---- 注入的东西 ----
  var $ = deps.$                      // DOM 查询（app.js 的 getElementById 包装）
  var api = deps.api                  // fetch 封装：URL 前缀 API 留在 app.js，模块不自己拼
  var toast = deps.toast
  var state = deps.state              // 只读：state.active / state.cases / state.root

  // ---- 下面到文件尾是原 app.js 里的房间条整套代码（逐字搬移，只把跨域引用改成 deps.xxx）----

  // ---------- 局域网 ----------
  // 房间条的 idle 提示要按「局域网到底开没开」说话（lead 2026-11-19 实证：本机 /api/lan enabled:true、
  // 公网隧道却是关的，用户认知里的「开房」和真实 running 不是一回事）。所以把状态单独存一份给房间条用：
  // lanPaint 只在「房间设置」弹层打开时才会跑，不能指望它，于是另有一个只取状态、不碰弹层 DOM 的探针。
  var LAN_ON = null      // null = 还没探到；true/false = /api/lan 的 enabled
  var LAN_PORT = 0
  var LAN_PROBING = false
  function lanProbe() {
    if (LAN_PROBING) return
    LAN_PROBING = true
    api('/lan', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        LAN_PROBING = false
        if (!(j && j.ok && j.lan)) return
        LAN_ON = !!j.lan.enabled
        LAN_PORT = Number(j.lan.port) || 0
        // 探到以后提示文案会变，拿上次快照原地重画一次（别等 15 秒心跳）
        if (RB_LAST) roombarPaint(RB_LAST.r, RB_LAST.via, true)
      })
      .catch(function () { LAN_PROBING = false })   // 探不到就当「不知道」，提示里不提局域网
  }
  function lanPaint(st) {
    LAN_ON = !!st.enabled
    LAN_PORT = Number(st.port) || 0
    var en = $('l-enable')
    if (en) en.value = st.enabled ? 'on' : 'off'
    var port = $('l-port')
    if (port) port.value = st.port || 5288
    $('l-key').textContent = st.key || '——'
    var box = $('l-urls')
    // 虚拟网卡（VMware / VirtualBox / Hyper-V / Tailscale 之类）的地址手机根本连不上，
    // 列出来只会让人复制错链接：默认剔掉，全被剔光时才退回前 3 条兜底。
    var list = (st.urls || []).filter(function (u) {
      var nm = typeof u === 'string' ? '' : String(u.label || '')
      return !/VMware|VirtualBox|Hyper-V|vEthernet|Tailscale|ZeroTier|Loopback|Bluetooth|Npcap|Wintun|TAP-|VMnet/i.test(nm)
    })
    if (!list.length) list = (st.urls || []).slice(0, 3)
    if (st.enabled && list.length) {
      box.innerHTML = list.map(function (u, i) {
        var url = typeof u === 'string' ? u : u.url
        var label = typeof u === 'string' ? '' : (u.label || '')
        return '<div class="lan-url"><span>' + esc(url) + (label ? '<em>' + esc(label) + '</em>' : '') + '</span><button type="button" class="ghost sm" data-copy="' + i + '">复制</button></div>'
      }).join('')
      Array.prototype.forEach.call(box.querySelectorAll('[data-copy]'), function (b) {
        b.addEventListener('click', function () {
          var u = list[Number(b.getAttribute('data-copy'))]
          deps.copyText(typeof u === 'string' ? u : u.url, '链接已复制，发到手机就能开')
        })
      })
    } else if (st.enabled) {
      box.innerHTML = '<div class="lan-none">服务起来了，但没查到局域网 IPv4 —— 这台机器可能没连 Wi-Fi / 网线。</div>'
    } else {
      box.innerHTML = '<div class="lan-none">关着。拨到「开」，同一 Wi-Fi 的设备就能用链接进来。</div>'
    }
    if (st.error) box.innerHTML += '<div class="lan-none is-bad">' + esc(String(st.error)) + '</div>'
  }

  function loadLan() {
    api('/lan', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) { if (j && j.ok) lanPaint(j.lan) })
      .catch(function () { toast('局域网接口没应答') })
  }

  function lanSet(body, okMsg) {
    api('/lan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.ok) { lanPaint(j.lan); if (okMsg) toast(okMsg) }
        else toast('没改成：' + ((j && j.error) || '未知'))
      })
      .catch(function () { toast('局域网接口没应答') })
  }

  // ---------- 公网房间（cloudflared 隧道）----------
  var T_POLL = 0
  var T_FAILS = 0     // 隧道状态连续取不到的次数：断了要接着排，但给个上限，别无限转（80 次 ≈ 400 秒）
  var T_LAST = null   // 最近一次的隧道快照：房间条的「房间链接」要拿它的 link 去复制
  // 后端把失败分成几类（errorKind），这里给每一类一句人话；认不出的才退回原始报错。
  var T_ERR = {
    'cloudflared-not-installed': '没找到 cloudflared —— 装到 ~/.local/bin/cloudflared.exe 或 PATH 里再开',
    'lan-not-running': '局域网服务没起来，隧道接不上 —— 先把上面的局域网开关拨到「开」',
    'tunnel-timeout': '25 秒没拿到公网地址 —— 已自动换协议重试；连着几轮都不成就基本是这台机器出不去 Cloudflare',
    'api-timeout': 'Cloudflare 换域名的接口没在超时内应答（网络抖一下）—— 已自动重试',
    'no-network': '连不上 Cloudflare（DNS 或出口断了）—— 已自动重试',
    'edge-fail': '连不上 Cloudflare 边缘 —— 已自动换协议重试',
    'closed': '隧道被 Cloudflare 那边断开了 —— 已自动重连',
  }
  function tunnelPaint(t) {
    T_LAST = t || null
    // 房间条上的「正在开房…」跟着隧道状态收尾：只要不在 starting 就得撤忙态 —— 起来了重拉房间快照（切到 running）；
    // 报错、或既没 running 也没 error 的空快照同理，否则 RB_OPENING 卡住、「开房」按钮永久 disabled。
    // retrying 也是忙态：两次尝试之间 starting 是 false，若按旧条件收忙态，「开房」会中途变可点、弹层里还会闪一句报错。
    if (RB_OPENING && !(t && (t.starting || t.retrying))) {
      RB_OPENING = ''
      if (t.running) { try { deps.loadRoomBar() } catch (e) { /* 下一跳心跳也会补上 */ } }
      else if (RB_LAST) { try { roombarPaint(RB_LAST.r, RB_LAST.via, true) } catch (e) {} }
    }
    var en = $('t-enable')
    if (en) en.value = (t.running || t.starting || t.retrying) ? 'on' : 'off'
    roomPaint(t.room)
    var box = $('t-urls')
    var warn = $('t-warn')
    // 轮询必须和「房间设置」弹层是否渲染解耦：房间条上那颗「开房」根本不打开弹层，
    // 原来这里一 `if (!box) return` 就把 tunnelPoll() 跳过去了 → 房间条会永远停在「正在开房…」。
    if (t.starting || t.retrying) tunnelPoll()
    if (!box) return
    if (t.starting || t.retrying) {
      var tries = Number(t.tries || 4)
      var cur = Number(t.tryNo || 0) || (Number(t.attempts || 0) + 1)
      // starting 时 tryNo 就是「这一次」；两次尝试之间的退避期里，下一次还没开始，得 +1
      var nth = Math.max(1, Math.min(tries, t.starting ? cur : cur + 1))
      var proto = t.protocol === 'http2' ? 'HTTP/2' : 'QUIC'
      // 一轮 4 次；一轮用完还没成，后端会隔 30 秒再开一轮（最多 3 轮），这里要把「第几轮」说清楚，
      // 不然用户看到次数从 4 又跳回 1 会以为在死循环。
      var rounds = Number(t.rounds || 3)
      var rd = Number(t.round || 0)
      var roundTag = rd > 0 ? '（第 ' + (rd + 1) + ' / ' + rounds + ' 轮）' : ''
      var line = t.starting
        ? (nth > 1 ? '第 ' + nth + ' / ' + tries + ' 次连接（' + proto + '）…' + roundTag : '正在拉起隧道（cloudflared 连 Cloudflare 边缘，通常十几秒）…' + roundTag)
        : ('这次没成（' + (T_ERR[t.errorKind] || '连接失败') + '），' + Math.max(1, Math.ceil(Number(t.retryInMs || 0) / 1000)) + ' 秒后自动重试第 ' + nth + ' / ' + tries + ' 次' + roundTag)
      box.innerHTML = '<div class="lan-none">' + esc(line) + '</div>'
      if (warn) { warn.className = 't-warn'; warn.textContent = '' }
      return
    }
    if (t.running && t.link) {
      box.innerHTML = '<div class="lan-url"><span>' + esc(t.link) + '<em>公网 · HTTPS</em></span><button type="button" class="ghost sm" id="t-copy">复制</button></div>'
      $('t-copy').addEventListener('click', function () { deps.copyText(t.link, '公网链接已复制 —— 发给谁，谁就能进这间房') })
      if (warn) {
        warn.className = 't-warn'
        warn.textContent = '随开随换：关掉再开就是新地址。公网只认 16 位长钥匙（局域网短钥匙在公网无效）。拿到链接的人能用你的模型额度请 DM —— 别把链接发到公开场合。'
      }
    } else {
      box.innerHTML = '<div class="lan-none">关着。开了会用本机 cloudflared 出一条只出不进的 HTTPS 隧道，局域网外的设备凭长钥匙进。</div>'
      if (warn) {
        warn.className = 't-warn' + (t.error ? ' is-bad' : '')
        warn.textContent = t.error ? (T_ERR[String(t.errorKind)] || T_ERR[String(t.error)] || String(t.error)) : ''
        if (warn && t.error) warn.title = String(t.detail || t.error)
      }
    }
  }
  // 一轮请求失败就永久停摆，会把「正在开房…」和 disabled 的「开房」一起钉死（只能刷新页面）：
  // 取不到就 5 秒后再排；阈值按「3 轮 × 4 次 + 两段 30 秒轮间」≈ 3 分钟留余量（80 次 ≈ 400 秒），
  // 过了才放弃并撤忙态，让人能再点一次。
  function tunnelPoll(delay) {
    clearTimeout(T_POLL)
    T_POLL = setTimeout(function () {
      function again() {
        T_FAILS++
        // 一轮「开房」最多 4 次尝试（25 秒 + 退避），前端留 40 次 × 5 秒 ≈ 200 秒的观察窗
        if (T_FAILS >= 40) {
          T_FAILS = 0
          if (RB_OPENING) {
            RB_OPENING = ''
            toast('开房超时，再点一次', 5600)
            if (RB_LAST) { try { roombarPaint(RB_LAST.r, RB_LAST.via, true) } catch (e) {} }
          }
          return
        }
        tunnelPoll(5000)
      }
      api('/tunnel', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          // ok:false（隧道只认本机 / 接口报错）也算一次失败：同样要重排，否则忙态一样撤不掉。
          if (!j || !j.ok) { again(); return }
          T_FAILS = 0
          tunnelPaint(j.tunnel)
        })
        .catch(again)
    }, delay || 1500)
  }
  function loadTunnel() {
    api('/tunnel', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.ok) tunnelPaint(j.tunnel)
        else if (j && j.error === 'tunnel-host-only') {
          var box = $('t-urls')
          if (box) box.innerHTML = '<div class="lan-none">公网房间只能在这台电脑上管理。</div>'
        }
      })
      .catch(function () {})
  }
  function tunnelSet(body, okMsg, done) {
    api('/tunnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.ok) { tunnelPaint(j.tunnel); if (okMsg) toast(okMsg) }
        else toast('没改成：' + ((j && j.error) || '未知'))
        if (typeof done === 'function') { try { done(!!(j && j.ok), (j && j.error) || '') } catch (e) {} }
      })
      .catch(function () { toast('隧道接口没应答') })
  }

  function roomPaint(r) {
    var box = $('t-room')
    if (!box) return
    if (!r || !r.running) { box.hidden = true; box.innerHTML = ''; return }
    var total = r.guests + (r.host ? 1 : 0)
    var txt
    if (r.state === 'playing') txt = (r.force ? '已强行开局' : '已开局') + ' · 在场 ' + total + ' 人'
    else if (r.state === 'empty') txt = '人都离场了 · 约 1 分钟后自动关房'
    else if (r.expect > 0) txt = '等待玩家 ' + r.guests + '/' + r.expect + '（房主' + (rbHostHere(r) ? '在场' : '页面未开') + ' + 访客 ' + r.guests + ' 位）'
    else txt = '等待第一位玩家进来 · 进来就能开打'
    box.hidden = false
    box.innerHTML = '<span class="t-room-k">房间</span> ' + esc(txt) +
      (r.state === 'waiting' && !r.force ? ' <button type="button" class="ghost sm" id="t-force">强行开局</button>' : '')
    var fb = $('t-force')
    if (fb) fb.addEventListener('click', function () {
      api('/room/force', { method: 'POST' })
        .then(function (rr) { return rr.json() })
        .then(function (j) { if (j && j.ok) { roomPaint(j.room); toast('已强行开局，访客可以玩了') } else toast('强行开局只能房主页面上点') })
        .catch(function () { toast('接口没应答') })
    })
  }

  // ---------- 房间条（访客一进来就该看见：有没有房 / 哪一本 / 什么要素）----------
  // 数据全来自宿主 /api/room 与心跳回包：房主页面把「当前选中的本子」随心跳报上去，
  // 宿主按书库查一次（标题/人数/类型/PVP/要素缺项）缓存 20 秒，访客拿到的是同一份。
  var RB_VIA = 'local'
  function rbChips(c) {
    var out = []
    // 房间快照里的 players 可能是 "1-4" 区间，也可能是数字：统一走 playersText
    if (c.players) out.push(playersText(c.players))
    if (c.genre) out.push(genreCn(c.genre))
    if (c.pvp) out.push(String(c.pvp).toUpperCase())
    if (c.kind === 'pack') {
      if (c.complete === true) out.push('全要素')
      else if (c.complete === false) out.push('缺 ' + ((c.missing || []).length) + ' 项')
      else out.push('未体检')
    }
    return out.map(function (x) { return '<span class="rb-chip">' + esc(String(x)) + '</span>' }).join('')
  }
  // 房间条上「这本」的信息：服务端快照给的是 {title,players,genre,pvp,complete,missing}（没有 kind），
  // 补一个 kind='pack' 让 rbChips 能画出「全要素 / 缺 N 项」那枚；本机兜底那条记录本来就有 kind。
  function rbCaseView(x) {
    if (!x) return null
    var v = {
      title: x.title || '', players: x.players, genre: x.genre, pvp: x.pvp,
      complete: x.complete, missing: x.missing, kind: x.kind, folder: x.folder,
    }
    if (!v.kind && (x.complete === true || x.complete === false || (Array.isArray(x.missing) && x.missing.length))) v.kind = 'pack'
    return v
  }
  // 服务端还没把 caseFolder 解析成快照时，用本机选中的那一条兜底 —— 房间条上别出现空白标题
  //（用户 2026-11-19「选好进入剧本之后没有看到房间」：进了本子就得看见「准备开：某本」）。
  function rbLocalCase() {
    var a = state.active
    if (!a || !a.folder) return null
    var m = deps.caseMetaOf(a) || {}
    return rbCaseView({
      title: a.title || a.folder,
      folder: a.folder,
      players: m.players || a.players,
      genre: m.genre || a.genre,
      pvp: m.pvp || a.pvp,
      complete: m.complete,
      missing: m.missing,
      kind: a.kind,
    })
  }
  // ---------- 昵称编辑（房主与访客都能改；不用 prompt/confirm，就在房间条里展开一行）----------
  var NICK_EDIT = false
  var NICK_DRAFT = ''
  var RB_LAST = null        // 最近一次房间快照：改昵称时先存着，存完照它重画
  var RB_PENDING = null
  function nickBtnHtml() {
    return '<button type="button" class="ghost sm rb-nick" id="rb-nick" title="改你在这一局里的名字：座位与在场名册都用它">昵称 · ' +
      esc(deps.nick()) + '</button>'
  }
  function nickRowHtml() {
    return '<div class="rb-nickrow" id="rb-nickrow">' +
      '<span class="rb-k">昵称</span>' +
      '<input id="rb-nick-inp" type="text" maxlength="12" autocomplete="off" value="' + esc(NICK_DRAFT) + '" />' +
      '<button type="button" class="ghost sm" id="rb-nick-save">保存</button>' +
      '<button type="button" class="ghost sm" id="rb-nick-cancel">取消</button>' +
      '</div>'
  }
  // 「房间设置」按钮：idle 与 running 两条分支都可能有它，绑一次就够（没这颗按钮时静默跳过）。
  function rbLanBind() {
    var lb = $('rb-lan')
    if (!lb) return
    lb.addEventListener('click', function () { $('lan-sheet').hidden = false; loadLan(); loadTunnel(); deps.loadRemote() })
  }
  // 「开房」= 起公网隧道。和「房间设置 → 局域网弹层 → 公网隧道」是同一个开关（tunnelSet({enabled:true})），
  // 所以两处的状态天然一致：那边拨开、这边也显示已开房。别在这里另写 fetch。
  var RB_OPENING = ''    // 非空 = 正在开房，房间条正文先显示它
  function rbOpenRoom(btn) {
    if (RB_OPENING) return
    RB_OPENING = '正在开房…（起隧道 3–10 秒）'
    T_FAILS = 0   // 新一轮开房从零计失败次数，别让上一次残留的计数一上来就判超时
    deps.setBtnBusy(btn, true, '正在开房…')
    try { roombarPaint(RB_LAST ? RB_LAST.r : null, RB_LAST ? RB_LAST.via : RB_VIA, true) } catch (e) {}
    tunnelSet({ enabled: true }, '房间开好了 —— 把「房间链接」发给要进来的人', function (ok, err) {
      if (ok) return   // 隧道是异步起的（starting），tunnelPaint 轮询到 running 后自己收尾
      RB_OPENING = ''
      try { roombarPaint(RB_LAST ? RB_LAST.r : null, RB_LAST ? RB_LAST.via : RB_VIA, true) } catch (e) {}
      if (err && T_ERR[String(err)]) toast(T_ERR[String(err)], 6000)
    })
  }
  function rbCloseRoom(btn) {
    deps.setBtnBusy(btn, true, '正在关房…')
    // 关房 = 停隧道（服务端 stop 是即时的）；关完拉一次快照，房间条自己回 idle「还没开房」
    tunnelSet({ enabled: false }, '房间关了 —— 链接立刻失效', function () {
      try { deps.loadRoomBar() } catch (e) { /* 下一跳心跳会补上 */ }
    })
  }
  function rbCopyLink() {
    var link = (T_LAST && T_LAST.link) || ''
    if (!link) { try { loadTunnel() } catch (e) {} toast('还没拿到房间链接 —— 隧道起来后这里就能复制，稍等一下再点', 5000); return }
    deps.copyText(link, '链接已复制 —— 发给谁，谁就能进这间房')
  }
  // 对局室（#match）是不是正开着：房间条用它决定要不要补一句「现在只有本机在玩」
  function matchOpen() {
    var m = $('match')
    if (!m || m.hidden) return false
    return true
  }
  // 房间条上所有按钮一次绑完（每次重画都要重新绑，因为 innerHTML 换掉了）
  function rbBindActs() {
    rbLanBind()
    var ob = $('rb-open-room')
    if (ob) ob.addEventListener('click', function () { rbOpenRoom(ob) })
    var cb = $('rb-close-room')
    if (cb) cb.addEventListener('click', function () { rbCloseRoom(cb) })
    var lk = $('rb-link')
    if (lk) lk.addEventListener('click', function () { rbCopyLink() })
  }
  function bindNick() {
    var b = $('rb-nick')
    if (b) b.addEventListener('click', function () {
      NICK_EDIT = true
      NICK_DRAFT = deps.nick()
      repaintRoomBar()
    })
    var inp = $('rb-nick-inp')
    if (!inp) return
    inp.addEventListener('input', function () { NICK_DRAFT = inp.value })
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); saveNick() }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelNick() }
    })
    var sv = $('rb-nick-save')
    if (sv) sv.addEventListener('click', saveNick)
    var cn = $('rb-nick-cancel')
    if (cn) cn.addEventListener('click', cancelNick)
    try { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length) } catch (e) { /* 不让 focus 就算了 */ }
  }
  function saveNick() {
    var v = deps.setNick(NICK_DRAFT)
    if (!v) { toast('昵称不能空着'); return }
    NICK_EDIT = false
    repaintRoomBar()
    toast('昵称改成：' + v)
    deps.reClaimMySeat()
  }
  function cancelNick() { NICK_EDIT = false; repaintRoomBar() }
  function repaintRoomBar() {
    var keep = RB_PENDING || RB_LAST
    RB_PENDING = null
    // 第三个参数 force：进/出编辑态是我们自己主动重画，必须穿透「编辑中不重画」的守卫
    if (keep) roombarPaint(keep.r, keep.via, true)
    else deps.loadRoomBar()
  }

  // ---------- 在场名册（能看到几个人，但看不到谁在哪个房间）----------
  // 房主是谁只认服务端的 room.hostWho（用户 2026-11-19「从 dsh 进去之后房主不是我」）：
  // 规则是「本机 + 正挂着某本的那个客户端」，非 local 永不，房主离开由下一个本机接任。
  // 老后端 / 房主还没定下来时 hostWho 是 ''，只有这一条兜底路径才退回旧规则
  // 「present 里第一个 via==='local'」—— 有 hostWho 就完全按它标，两套规则不会同时生效。
  function rbHostWho(r) {
    var who = (r && r.hostWho) || ''
    if (who) return String(who)
    var p = (r && r.present) || []
    for (var i = 0; i < p.length; i++) {
      if (p[i] && p[i].via === 'local' && p[i].who) return p[i].who
    }
    return ''
  }
  // 房主在不在场：hostWho 定下来了就看它是否在 present 里；没定才沿用旧的 r.host。
  function rbHostHere(r) {
    var who = (r && r.hostWho) || ''
    if (!who) return !!(r && r.host)
    var p = (r && r.present) || []
    for (var i = 0; i < p.length; i++) if (p[i] && p[i].who === who) return true
    return false
  }
  function rbPersonOne(x, hostWho) {
    var roomName = x && x.room === 'arcade' ? '游戏厅' : '剧本杀'
    // 同一台机器开两个窗口时两个人都是 via==='local'：这时只有服务端点名的那位才是房主
    var tail = roomName + (hostWho && x && x.who === hostWho ? '·房主' : '')
    var nm = (x && x.name) || ('玩家' + String((x && x.who) || '').slice(0, 4))
    var self = !!(x && x.who && x.who === deps.seatWho())
    return (self ? '我 ' : '') + esc(nm) + '（' + esc(tail) + '）'
  }
  function rbPeopleHtml(r) {
    var p = (r && r.present) || []
    var cnt = (r && r.counts) || {}
    var total = Number(cnt.total) || 0
    if (!total && p.length) total = p.length
    var head = '在场 ' + total + ' 人'
    if (Number(cnt.jubensha)) head += ' · 剧本杀 ' + Number(cnt.jubensha)
    if (Number(cnt.arcade)) head += ' · 游戏厅 ' + Number(cnt.arcade)
    // 房主只标一个：服务端给的 hostWho（老回包没有它时 rbHostWho 内部才退回「第一个 local」）
    var hostWho = rbHostWho(r)
    var list = p.slice(0, 6).map(function (x) { return rbPersonOne(x, hostWho) })
    if (p.length > 6) list.push('等 ' + (p.length - 6) + ' 人')
    return '<span class="rb-people" id="rb-people"><span class="rb-people-n">' + esc(head) + '</span>' +
      list.map(function (t) { return '<span class="rb-people-i">' + t + '</span>' }).join('') + '</span>'
  }

  var RB_FP = '' // 房间条上一次画的内容指纹（没变就不重建、不重绑）
  function roombarPaint(r, via, force) {
    var box = $('roombar')
    if (!box) return
    RB_LAST = { r: r, via: via }
    // 正在改昵称：15 秒一次的心跳不许把输入框冲掉（force=true 的自主动重画可以穿透）
    if (NICK_EDIT && !force) { RB_PENDING = RB_LAST; return }
    // 谁是房主只认服务端判定（回包里的 you.via），入参只是兜底：之前访客页面上冒出
    // 「强行开局 / 房间设置」，就是这里的身份来源不够硬。
    var seen = (r && r.you && r.you.via) || via
    if (seen) RB_VIA = seen
    var local = RB_VIA === 'local'
    box.setAttribute('data-via', RB_VIA)
    // 15 秒一次的心跳以前无条件重建整条：焦点、滚动、昵称框全被冲掉。
    // 指纹没变就直接返回；会变的东西（在场名册、人数、缺项、局域网状态、昵称编辑态）都必须在指纹里。
    var fp = JSON.stringify([
      r && r.state, r && r.running, r && r.guests, r && r.expect, r && r.force, r && r.host,
      r && r.hostWho, r && r.you, r && r.case && r.case.folder, r && r.case && r.case.title,
      r && r.case && r.case.missing, r && r.present, r && r.counts,
      RB_VIA, local, NICK_EDIT, RB_OPENING, LAN_ON, LAN_PORT
    ])
    if (!force && fp === RB_FP) return
    RB_FP = fp
    var running = !!(r && r.running)
    var c = (r && r.case) || null
    if (!running) {
      // idle 永远可见（用户 2026-11-19「选好进入剧本之后没有看到房间」）：
      // 房主还没开房时这条就是「房间在哪、下一步点哪」的唯一入口 —— 藏起来人就找不到房间了。
      box.hidden = false
      // 本：服务端快照（room.case）优先；宿主还没把 caseFolder 解析成快照时，退回本机选中的那条，
      // 这样「进了某个剧本 / 资料夹」房间条上立刻就有「准备开：某本」。
      var ic = local ? (rbCaseView(c) || rbLocalCase()) : null
      var idleTitle = local
        ? (ic && ic.title ? '准备开：' + ic.title + ' · 还没开房' : '还没开房')
        : '现在没有开着的房间'
      var idleHint
      if (!local) idleHint = '等房主在这台电脑上开房——开好以后这里会变成「房间在等：某本」'
      else {
        // 局域网到底开没开，问 /api/lan（lead 2026-11-19：不许写死「局域网开着」）
        if (LAN_ON === null) lanProbe()
        var hintBits = []
        // 局域网和公网是两条路：局域网开着，同 WiFi 直接进；只有要给不在同一 WiFi 的人开，才需要「开房」
        if (LAN_ON === true) {
          hintBits.push('局域网开着（端口 ' + (LAN_PORT || 5288) + '）—— 同 WiFi 的人直接用局域网链接就能进来')
          hintBits.push('要让不在同一 WiFi 的人进来，点「开房」起公网隧道（3–10 秒）')
        } else if (LAN_ON === false) {
          hintBits.push('局域网关着 —— 点「开房」起公网隧道让别人进来（3–10 秒），也可以去「房间设置」先把局域网打开')
        } else {
          hintBits.push('点「开房」让别人能进来（起公网隧道 3–10 秒）')
        }
        if (!(ic && ic.title)) hintBits.push('还没选本 —— 也可以先点书库里某一本下面的「开这一局」')
        // 对局室已经铺开、房间却还没开：这时候最容易以为「已经开房了」，明说一句
        if (matchOpen()) hintBits.push('这一局现在只有本机在玩 —— 想让别人进来点右边「开房」')
        idleHint = hintBits.join(' ')
        if (RB_OPENING) idleHint = RB_OPENING
      }
      // 右侧：idle 给「开房」（主按钮）+「房间设置」；没开局就没有可强行开局的东西，所以不画它
      var idleActs = [nickBtnHtml()]
      if (local) {
        idleActs.push('<button type="button" class="primary sm" id="rb-open-room"' + (RB_OPENING ? ' disabled' : '') + '>' + (RB_OPENING ? '正在开房…' : '开房') + '</button>')
        idleActs.push('<button type="button" class="ghost sm" id="rb-lan">房间设置</button>')
      }
      box.innerHTML = '<div class="rb-row"><span class="rb-k">房间</span>' +
        '<span class="rb-title" title="' + esc(idleTitle) + '">' + esc(idleTitle) + '</span>' +
        (ic ? '<span class="rb-chips">' + rbChips(ic) + '</span>' : '') +
        '<span class="rb-state">' + esc(idleHint) + '</span>' +
        rbPeopleHtml(r) +
        '<span class="rb-acts">' + idleActs.join('') + '</span></div>' +
        (NICK_EDIT ? nickRowHtml() : '')
      bindNick()
      rbBindActs()
      return
    }
    var total = (Number(r.guests) || 0) + (r.host ? 1 : 0)
    var stateTxt
    if (r.state === 'playing') stateTxt = '已开房 · ' + (r.force ? '已强行开局' : '已开局') + ' · 在场 ' + total + ' 人 · 可以开打'
    else if (r.state === 'empty') stateTxt = '已开房 · 人都离场了 · 约 1 分钟后自动关房'
    else if (c) stateTxt = '已开房 · 等待玩家 ' + (Number(r.guests) || 0) + (Number(r.expect) ? '/' + Number(r.expect) : '') + '（房主' + (rbHostHere(r) ? '在场' : '不在') + '）'
    else stateTxt = '已开房 · 房主还没选本'
    var miss = (c && c.missing && c.missing.length) ? c.missing : []
    // 房间开着、服务端还没把 caseFolder 解析成快照时，标题退回本机选中的那条 —— 别让人看到「（还没选本）」
    var rv = c ? rbCaseView(c) : rbLocalCase()
    // 标题被 CSS 省略号截断，原文明文要挂在 title 上，否则长本名永远看不全
    var rTitleRaw = c ? String(c.title || '') : (rv && rv.title ? '准备开：' + rv.title : '（还没选本）')
    var rTitle = esc(rTitleRaw)
    // 右侧顺序（房主）：昵称 → 房间链接 → 看这本 → 强行开局 → 房间设置 → 关房。
    // 「房间链接」是谁都能拷的（访客要转发给别人），所以不分 local。
    var acts = []
    acts.push(nickBtnHtml())
    acts.push('<button type="button" class="ghost sm" id="rb-link" title="复制公网房间链接，发给要进来的人">房间链接</button>')
    if (c) acts.push('<button type="button" class="ghost sm" id="rb-open">看这本</button>')
    if (local && r.state !== 'playing') acts.push('<button type="button" class="ghost sm" id="rb-force">强行开局</button>')
    if (local) acts.push('<button type="button" class="ghost sm" id="rb-lan">房间设置</button>')
    if (local) acts.push('<button type="button" class="ghost sm" id="rb-close-room">关房</button>')
    box.hidden = false
    box.innerHTML = '<div class="rb-row"><span class="rb-k">房间</span>' +
      '<span class="rb-title" title="' + esc(rTitleRaw) + '">' + rTitle + '</span>' +
      '<span class="rb-chips">' + (rv ? rbChips(rv) : '') + '</span>' +
      '<span class="rb-state">' + esc(stateTxt) + '</span>' +
      rbPeopleHtml(r) +
      '<span class="rb-acts">' + acts.join('') + '</span></div>' +
      (miss.length ? '<div class="rb-miss">缺：' + miss.map(function (m) {
        // 宿主 level 的值域是 ok/fail/warn（'missing' 永远不成立，等于这一列从来不是硬缺项）
        return '<span class="rb-miss-i' + (m.level === 'fail' ? ' is-hard' : '') + '">' + esc(m.label || m.key || '?') + '</span>'
      }).join('') + '</div>' : '') +
      (NICK_EDIT ? nickRowHtml() : '')
    var ob = $('rb-open')
    if (ob && c) ob.addEventListener('click', function () {
      var hit = state.cases.filter(function (x) { return x.folder === c.folder })[0]
      if (hit) { deps.select(c.folder); return }
      deps.loadCases(c.root, false).then(function () {
        if (state.cases.some(function (x) { return x.folder === c.folder })) deps.select(c.folder)
        else toast('这本不在书库里了：' + c.title)
      })
    })
    var fb = $('rb-force')
    if (fb) fb.addEventListener('click', function () {
      api('/room/force', { method: 'POST' })
        .then(function (rr) { return rr.json() })
        .then(function (j) {
          if (j && j.ok) { roombarPaint(j.room, RB_VIA); roomPaint(j.room); toast('已强行开局，来访的人现在就能玩') }
          else toast('强行开局只能房主点')
        })
        .catch(function () { toast('接口没应答') })
    })
    rbBindActs()
    bindNick()
  }

  // 房间里所有按钮一次绑完 / 拿上一次快照（给 loadRoomBar 与 select 用）
  function bind() { rbBindActs(); bindNick() }
  function current() { return { last: RB_LAST, r: RB_LAST ? RB_LAST.r : null, via: RB_LAST ? RB_LAST.via : RB_VIA } }

  return {
    // ---- 给 app.js 的调用面（越小越好）----
    paint: roombarPaint,              // app.js: roombarPaint(r, via, force) 薄委托
    bind: bind,                       // 显式重绑一次交互（paint 内部本来就会自己绑）
    current: current,                 // { last, r, via }：调用方要「拿上一次快照重画」时用
    nickEditing: function () { return NICK_EDIT },   // /room 回包要不要穿透「编辑中不重画」
    roomPaint: roomPaint,             // 弹层里的房间块（app.js roomBeat 用）
    loadLan: loadLan,                 // app.js: loadLan() 薄委托
    lanSet: lanSet,                   // app.js: lanSet(body, okMsg) 薄委托
    loadTunnel: loadTunnel,           // app.js: loadTunnel() 薄委托
    tunnelSet: tunnelSet,             // app.js: tunnelSet(body, okMsg, done) 薄委托
    // 只给 ../tmp/rbmod-parity.mjs 做逐函数对照用，业务代码不要调
    testables: {
      rbChips: rbChips, rbCaseView: rbCaseView, rbLocalCase: rbLocalCase,
      rbHostWho: rbHostWho, rbHostHere: rbHostHere,
      rbPersonOne: rbPersonOne, rbPeopleHtml: rbPeopleHtml,
      nickBtnHtml: nickBtnHtml, nickRowHtml: nickRowHtml,
    },
  }
}
