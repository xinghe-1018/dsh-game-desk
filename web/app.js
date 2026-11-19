/* 案卷台页面逻辑：一个书库可以指向任意资料夹；本子有 case.yml 按结构化读，没有就按资料夹读。
   开局把指令交回客户端半填进对话输入框。 */
(function () {
  'use strict'

  var API = '/game-desk/api'
  var params = new URLSearchParams(location.search)
  var panel = params.get('panel') === 'arcade' ? 'arcade' : 'jubensha'
  var theme = params.get('theme')

  var state = { cases: [], roots: [], root: '', active: null, filter: 'all', q: '' }

  function $(id) { return document.getElementById(id) }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  function bytes(n) {
    if (!n) return '—'
    if (n < 1024) return n + ' B'
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
    return (n / 1048576).toFixed(1) + ' MB'
  }
  function baseName(p) {
    var parts = String(p || '').split(/[\\/]/).filter(Boolean)
    return parts.length ? parts[parts.length - 1] : String(p || '')
  }

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

  // ---------- 本子清单 ----------
  var GENRE = { deduction: '推理', drama: '戏剧', emotion: '情感', horror: '恐怖', comedy: '喜剧', suspense: '悬疑', mystery: '本格', imported: '未标注', unknown: '未标注', 未标注: '未标注' }
  var DIFF = { beginner: '新手', easy: '轻松', normal: '标准', standard: '进阶', hard: '硬核', expert: '老手' }
  function genreOf(c) { return GENRE[c.genre] || c.genre || '' }
  function diffOf(c) { return DIFF[c.difficulty] || c.difficulty || '' }

  function metaLine(c) {
    var bits = []
    if (c.players) bits.push(c.players + ' 人')
    if (c.kind === 'pack') {
      if (c.counts.pdf) bits.push('PDF ' + c.counts.pdf)
      if (c.counts.image) bits.push('图 ' + c.counts.image)
      if (!c.counts.pdf && !c.counts.image) bits.push(c.counts.all + ' 个文件')
    } else {
      if (c.genre) bits.push(genreOf(c))
      if (c.difficulty) bits.push(diffOf(c))
    }
    return bits.join(' · ') || (c.kind === 'pack' ? '资料夹' : '本子')
  }

  function haystack(c) {
    var bits = [c.title, c.id, c.folder, c.genre, (c.tags || []).join(' ')]
    if (c.kind === 'pack') bits.push((c.files || []).map(function (f) { return f.name }).join(' '))
    return bits.join(' ').toLowerCase()
  }

  function visible() {
    var q = state.q.trim().toLowerCase()
    return state.cases.filter(function (c) {
      if (state.filter === '4' && String(c.players) !== '4') return false
      if (state.filter === '6' && String(c.players) !== '6') return false
      if (!q) return true
      return haystack(c).indexOf(q) >= 0
    })
  }

  function caseNo(c) {
    var m = /^(\d+)/.exec(String(c.folder || ''))
    return (m && m[1]) || String(c.id || '·')
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

  function renderList() {
    var list = visible()
    var box = $('cases')
    if (list.length === 0) {
      box.innerHTML = '<div class="empty" style="margin:26px 8px;text-align:left"><p class="empty-k" style="font-size:16px">这里没有本子</p>' +
        '<p class="empty-l">换一个筛选，或点「＋ 目录」把别处的本子合辑加进来。</p></div>'
    } else {
      box.innerHTML = list.map(function (c) {
        return '<button class="case' + (state.active && state.active.folder === c.folder ? ' is-on' : '') + '" data-folder="' + esc(c.folder) + '" type="button">' +
          '<span class="case-no">' + esc(caseNo(c)) + '</span>' +
          '<span class="case-body"><span class="case-title">' + esc(c.title) + '</span>' +
          '<span class="case-meta">' + ((c.warnings && c.warnings.length) ? '<span class="case-warn"></span>' : '') +
          '<span class="badge ' + (c.kind === 'pack' ? 'badge-pack' : (c.imported ? 'badge-import' : 'badge-case')) + '">' + (c.kind === 'pack' ? '资料夹' : (c.imported ? '导入本' : '本子')) + '</span>' +
          esc(metaLine(c)) + (tableSave(c) ? ' · 对局中' : '') + '</span></span>' +
          '</button>'
      }).join('')
    }
    $('count').textContent = list.length + ' / ' + state.cases.length + ' 项'
    $('dirpath').textContent = state.dir
    $('dirpath').title = state.dir
    Array.prototype.forEach.call(box.querySelectorAll('.case'), function (el) {
      el.addEventListener('click', function () { select(el.getAttribute('data-folder')) })
    })
  }

  function fact(k, v) { return '<div class="fact"><span>' + esc(k) + '</span><strong>' + esc(v || '—') + '</strong></div>' }

  // 对局室里选过谁，档案页的座位 chips 跟着走（localStorage 与 table.js 同一个键）
  function tableMe(c) {
    try {
      var raw = localStorage.getItem('gd:table:' + state.root + '|' + c.folder)
      var got = raw ? JSON.parse(raw) : null
      if (got && typeof got.me === 'number' && got.me >= 0) return got.me
    } catch (e) { /* 读不到就按本子的 human 标记 */ }
    return -1
  }

  // 在档案页直接点座位换人（对局室打开时读的是同一份存档）
  function pickSeat(c, idx) {
    var k = 'gd:table:' + state.root + '|' + c.folder
    var st = { act: 1, dealt: [], note: '', t0: Date.now(), seat: idx, tab: 'roles', me: idx }
    try { var raw = localStorage.getItem(k); if (raw) st = JSON.parse(raw) } catch (e) { /* 坏档就重开 */ }
    st.me = idx
    st.seat = idx
    try { localStorage.setItem(k, JSON.stringify(st)) } catch (e) { /* 存不下不致命 */ }
    renderCase(c)
    toast('你现在演：' + (((c.roles || [])[idx] || {}).name || ('座位 ' + idx)))
  }

  function renderCase(c) {
    var mineIdx = tableMe(c)
    var seats = (c.roles || []).map(function (r, i) {
      var mine = mineIdx >= 0 ? i === mineIdx : r.player === 'human'
      return '<button class="seat' + (mine ? ' is-human' : '') + '" data-me="' + i + '" type="button" title="' +
        (mine ? '你现在演这个' : '选他当你演的角色') + '"><b>' + esc(r.name || r.id) + '</b><em>' +
        (mine ? '你' : 'AI') + '</em></button>'
    }).join('')
    var warns = (c.warnings && c.warnings.length)
      ? '<div class="warn">格式提醒：' + esc(c.warnings.join('；')) + '。开局时 <code>jubensha_case</code> 会再报一次，改本子时一并补。</div>'
      : ''
    var seen = {}
    var tags = [genreOf(c), diffOf(c)].concat(c.tags || []).filter(function (t) {
      if (!t || seen[t]) return false
      seen[t] = 1
      return true
    }).map(function (t) { return '<span class="tag">' + esc(t) + '</span>' }).join('')
    var imported = c.imported === true
    var srcFiles = (c.files || []).filter(function (f) { return f.rel.indexOf('_source/') === 0 })
    var textFiles = (c.files || []).filter(function (f) { return f.rel.indexOf('_text/') === 0 })
    var importBlock = imported
      ? '<div class="srcbar"><span class="tag tag-import">导入</span>' +
          '<span class="src-line">原始资料：' + esc(c.sourceFolder || '（未记录来源）') + '</span>' +
          (c.verdict && VERDICT[c.verdict]
            ? '<span class="vchip is-' + esc(c.verdict) + '">体检 ' + esc(VERDICT[c.verdict].label) + '</span>'
            : '') +
          '<button class="ghost sm" id="btn-gaps" type="button" title="让模型读一遍这本，只列缺什么，不替它编">看看缺什么</button>' +
        '</div>'
      : ''
    var gapRows = (imported && Array.isArray(c.gaps) && c.gaps.length)
      ? '<div class="gaplist"><div class="gaplist-k">体检缺项 · ' + c.gaps.length + ' 项 —— 不是拆不出来，是原文里就没这些</div>' +
          c.gaps.map(function (k) {
            return '<div class="gap is-' + (k.level === 'fail' ? 'fail' : 'warn') + '"><b>' + esc(k.label || k.id || '') + '</b>' +
              '<span>' + esc(k.detail || '') + '</span></div>'
          }).join('') +
          '<p class="gapfix">补法：把缺的文件补进原资料夹；人物剧本也可以让 AI 按已有正文补写。补齐后回案卷台重新导入同一资料夹，这一栏随体检刷新。</p>' +
        '</div>'
      : ''
    var sourceSections = ''
    if (imported && srcFiles.length) {
      sourceSections += '<div class="files"><div class="files-k">原始资料 <em>' + srcFiles.length + '</em></div>' +
        srcFiles.map(function (x) {
          return '<button class="file" data-rel="' + esc(x.rel) + '" data-kind="' + esc(x.kind) + '" type="button">' +
            '<span class="file-kind">' + esc(x.ext.replace('.', '') || 'file') + '</span>' +
            '<span class="file-name">' + esc(x.rel.replace('_source/', '')) + '</span>' +
            '<span class="file-size">' + esc(bytes(x.bytes)) + '</span></button>'
        }).join('') + '</div>'
    }
    if (imported && textFiles.length) {
      sourceSections += '<div class="files"><div class="files-k">抽出的文字 <em>' + textFiles.length + '</em></div>' +
        textFiles.map(function (x) {
          return '<button class="file" data-rel="' + esc(x.rel) + '" data-kind="text" type="button">' +
            '<span class="file-kind">txt</span>' +
            '<span class="file-name">' + esc(x.rel.replace('_text/', '')) + '</span>' +
            '<span class="file-size">' + esc(bytes(x.bytes)) + '</span></button>'
        }).join('') + '</div>'
    }
    $('dossier').innerHTML =
      '<div class="dossier-inner">' +
        '<button class="backlink" type="button">← 返回列表</button>' +
        '<div class="eyebrow">case ' + esc(caseNo(c)) + (c.victim ? ' · 死者 ' + esc(c.victim) : '') + (imported ? ' · 导入本' : '') + '</div>' +
        '<h1 class="title">' + esc(c.title) + '</h1>' +
        '<div class="tags">' + tags + '</div>' +
        importBlock + gapRows + '<div class="gaps-out" id="gaps-out" hidden></div>' +
        '<div class="facts">' + fact('人数', (c.players || (c.roles || []).length) + ' 人') + fact('座位', (c.roles || []).length + ' 席') +
          fact('类型', genreOf(c)) + fact('难度', diffOf(c)) + '</div>' +
        warns +
        (c.brief && c.brief.indexOf('（原文没有') !== 0 ? '<div class="brief"><div class="brief-k">引子</div>' + esc(c.brief) + '</div>' : '') +
        (seats ? '<div class="seats"><div class="seats-k">座位</div><div class="seat-row">' + seats + '</div></div>' : '') +
        sourceSections +
        '<div class="actions">' +
          '<button class="primary" id="btn-open" type="button">开这一局</button>' +
          '<button class="ghost" id="btn-case-file" type="button">复制本子路径</button>' +
          '<button class="ghost" id="btn-open-dir" type="button">打开文件夹</button>' +
        '</div>' +
        '<p class="hint">「开这一局」在这张案卷上铺开对局室：座位、正文、线索、笔记都在这一页，不跳去会话。对局室里的「交给 AI 主持」也是在本页开局 —— DM 直接带这一局。</p>' +
      '</div>'
    var ts = tableSave(c)
    if (ts) {
      $('btn-open').textContent = '继续这一局'
      var hp1 = $('dossier').querySelector('.hint')
      if (hp1) hp1.textContent = hp1.textContent + '（这一页存着未完的对局：第 ' + ts.act + ' 幕 · ' + ts.turns + ' 句对白 · ' + (ts.running ? '计时在走' : '已停表') + '）'
    }
    $('btn-open').addEventListener('click', function () { openTable(c) })
    Array.prototype.forEach.call($('dossier').querySelectorAll('.seat[data-me]'), function (el) {
      el.addEventListener('click', function () { pickSeat(c, Number(el.getAttribute('data-me'))) })
    })
    $('btn-case-file').addEventListener('click', function () { copyText(c.file || c.dir, '本子路径已复制') })
    $('btn-open-dir').addEventListener('click', function () { reveal(c.dir) })
    var gb = $('btn-gaps')
    if (gb) gb.addEventListener('click', function () { gapsReport(state.root, c.folder, gb, $('gaps-out')) })
    Array.prototype.forEach.call($('dossier').querySelectorAll('.file'), function (el) {
      el.addEventListener('click', function () { preview(c, el.getAttribute('data-rel'), el.getAttribute('data-kind')) })
    })
    Array.prototype.forEach.call($('dossier').querySelectorAll('.thumb'), function (el) {
      el.addEventListener('click', function () { preview(c, el.getAttribute('data-rel'), 'image') })
    })
  }

  function fileUrl(c, rel) {
    return API + '/file?root=' + encodeURIComponent(state.root) + '&folder=' + encodeURIComponent(c.folder) + '&rel=' + encodeURIComponent(rel)
  }

  var GROUP_ORDER = ['正文', '人物剧本', '线索', '剧本', '手册', '其它']

  function groupOf(rel) {
    var i = rel.indexOf('/')
    return i < 0 ? '正文' : rel.slice(0, i)
  }

  function renderPack(c) {
    var byGroup = {}
    c.files.forEach(function (x) {
      var g = groupOf(x.rel)
      ;(byGroup[g] = byGroup[g] || []).push(x)
    })
    var keys = Object.keys(byGroup).sort(function (a, b) {
      var ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b)
      if (ia < 0) ia = 99
      if (ib < 0) ib = 99
      return ia - ib || a.localeCompare(b, 'zh')
    })
    var textSection = (c.texts && c.texts.length)
      ? '<div class="files"><div class="files-k">已抽出的文本 <em>' + c.texts.length + '</em></div>' +
          c.texts.map(function (t) {
            return '<button class="file" data-txt="' + esc(t.rel) + '" type="button">' +
              '<span class="file-kind">txt</span>' +
              '<span class="file-name">' + esc(t.txt) + '</span>' +
              '<span class="file-size">' + (t.chars ? (t.chars / 1000).toFixed(1) + 'k 字' : '') + '</span>' +
              '</button>'
          }).join('') +
        '</div>'
      : ''
    var sections = keys.map(function (g) {
      var items = byGroup[g]
      var imgs = items.filter(function (x) { return x.kind === 'image' })
      var docs = items.filter(function (x) { return x.kind !== 'image' })
      var rows = docs.map(function (x) {
        return '<button class="file" data-rel="' + esc(x.rel) + '" data-kind="' + esc(x.kind) + '" type="button">' +
          '<span class="file-kind">' + esc(x.ext.replace('.', '') || 'file') + '</span>' +
          '<span class="file-name">' + esc(x.name) + '</span>' +
          '<span class="file-size">' + esc(bytes(x.bytes)) + '</span>' +
          '</button>'
      }).join('')
      var thumbs = imgs.length
        ? '<div class="thumbs">' + imgs.map(function (x) {
            return '<button class="thumb" data-rel="' + esc(x.rel) + '" type="button" title="' + esc(x.name) + '">' +
              '<img loading="lazy" alt="' + esc(x.name) + '" src="' + esc(fileUrl(c, x.rel)) + '" /></button>'
          }).join('') + '</div>'
        : ''
      return '<div class="files"><div class="files-k">' + esc(g) + ' <em>' + items.length + '</em></div>' + rows + thumbs + '</div>'
    }).join('')

    var warns = (c.warnings && c.warnings.length)
      ? '<div class="warn">' + esc(c.warnings.join('；')) + '</div>'
      : ''
    var missing = (c.counts.pdf || 0) - ((c.texts || []).length)
    var note = c.hasText
      ? '<div class="pack-note is-ok">已抽出纯文本，缓存在 <code>' + esc(c.textDir || '') + '</code>（DM 读这一份，不必再解析 PDF；来源目录不会被写入）' +
        (missing > 0 ? '<br />另有 ' + missing + ' 份 PDF 抽不出文字（多为扫描件或字体加密），直接点开 PDF 看。' : '') + '</div>'
      : '<div class="pack-note">这本没有 <code>case.yml</code>，按资料夹展示。开局前建议先「抽出文字」，把 PDF 变成可直接读的 txt。</div>'

    $('dossier').innerHTML =
      '<div class="dossier-inner">' +
        '<button class="backlink" type="button">← 返回列表</button>' +
        '<div class="eyebrow">pack · ' + (c.players ? esc(String(c.players)) + ' 人本 · ' : '') + c.files.length + ' 个文件</div>' +
        '<h1 class="title">' + esc(c.title) + '</h1>' +
        '<div class="tags"><span class="tag">资料夹</span>' +
          (c.counts.pdf ? '<span class="tag">PDF ' + c.counts.pdf + '</span>' : '') +
          (c.counts.image ? '<span class="tag">图片 ' + c.counts.image + '</span>' : '') +
          (c.counts.doc ? '<span class="tag">文档 ' + c.counts.doc + '</span>' : '') +
        '</div>' +
        '<div class="facts">' + fact('人数', c.players ? c.players + ' 人' : '未标注') + fact('文件', c.files.length + ' 个') +
          fact('PDF', c.counts.pdf || 0) + fact('体积', bytes(c.bytes)) + '</div>' +
        warns + note +
        '<div class="screen" id="screen"><div class="screen-k">体检 <em>导入前先看这一栏</em></div>' +
          '<div class="screen-body">正在体检这本…</div></div>' +
        textSection + sections +
        '<div class="actions">' +
          '<button class="primary" id="btn-open" type="button">开这一局</button>' +
          '<button class="ghost" id="btn-extract" type="button">' + (c.hasText ? '重新抽出文字' : '抽出文字') + '</button>' +
          '<button class="ghost" id="btn-open-dir" type="button">打开文件夹</button>' +
          '<button class="ghost" id="btn-copy-path" type="button">复制路径</button>' +
        '</div>' +
        '<p class="hint">资料夹本没有结构化档案：「开这一局」把原件摊在对局室里 —— 先读手册，再按座位发人物剧本和线索。原文优先于模型常识。</p>' +
      '</div>'

    var ts2 = tableSave(c)
    if (ts2) {
      $('btn-open').textContent = '继续这一局'
      var hp2 = $('dossier').querySelector('.hint')
      if (hp2) hp2.textContent = hp2.textContent + '（未完对局：第 ' + ts2.act + ' 幕 · ' + ts2.turns + ' 句对白 · ' + (ts2.running ? '计时在走' : '已停表') + '）'
    }
    $('btn-open').addEventListener('click', function () { openTable(c) })
    $('btn-open-dir').addEventListener('click', function () { reveal(c.dir) })
    $('btn-copy-path').addEventListener('click', function () { copyText(c.dir, '路径已复制') })
    $('btn-extract').addEventListener('click', function () { extract(c) })
    loadScreen(c)
    Array.prototype.forEach.call($('dossier').querySelectorAll('.file'), function (el) {
      el.addEventListener('click', function () { preview(c, el.getAttribute('data-rel'), el.getAttribute('data-kind')) })
    })
    Array.prototype.forEach.call($('dossier').querySelectorAll('.thumb'), function (el) {
      el.addEventListener('click', function () { preview(c, el.getAttribute('data-rel'), 'image') })
    })
    Array.prototype.forEach.call($('dossier').querySelectorAll('[data-txt]'), function (el) {
      el.addEventListener('click', function () {
        var rel = el.getAttribute('data-txt')
        var url = API + '/text?root=' + encodeURIComponent(state.root) + '&folder=' + encodeURIComponent(c.folder) + '&rel=' + encodeURIComponent(rel)
        var name = rel.replace(/\.pdf$/i, '.txt')
        fetch(url, { cache: 'no-store' })
          .then(function (r) { return r.text() })
          .then(function (t) { previewUrl(url, name, false, t) },
            function () { previewUrl(url, name, false, '读不出来：' + url) })
      })
    })
  }

  // ---------- 体检与导入 ----------
  var VERDICT = {
    ready: { k: 'ready', label: '可以直接导入', line: '关键项都认得出来：文字、人数、角色、引子、线索都有下落。' },
    partial: { k: 'partial', label: '有缺项', line: '能导入，但不全 —— 缺的那几项下面标出来了。' },
    blocked: { k: 'blocked', label: '不建议导入', line: '一份可读的文字都没抽出来；导入后只会多一个读不了的资料夹。' }
  }

  function loadScreen(c) {
    var box = $('screen')
    if (!box) return
    fetch(API + '/screen?root=' + encodeURIComponent(state.root) + '&folder=' + encodeURIComponent(c.folder), { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '体检失败')
        renderScreen(c, j.screen)
      })
      .catch(function (e) {
        box.innerHTML = '<div class="screen-k">体检</div>' +
          '<div class="check"><span class="dot is-warn"></span><span class="check-l">体检没跑起来</span>' +
          '<span class="check-d">' + esc(e.message) + '</span></div>'
      })
  }

  var GAPS_AUTO = {}

  function gapsReport(root, folder, btn, out) {
    if (!root || !folder || !out) return
    btn.disabled = true
    btn.textContent = '在读这本…'
    out.hidden = false
    out.innerHTML = '<p class="peek-k">模型在通读这一本的文件与正文（约一分钟）。它只总结材料里看得见的缺件，不会替本子编内容。</p>'
    fetch(API + '/case/gaps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: root, folder: folder })
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        btn.disabled = false
        btn.textContent = '看看缺什么'
        if (!j || !j.ok) {
          out.innerHTML = '<p class="peek-hint is-bad">' + esc((j && j.error) || '接口没应答') + '</p>'
          return
        }
        var rows = String(j.text).split('\n').map(function (x) { return x.replace(/^[-\u2022\s]+/, '').trim() }).filter(Boolean)
        out.innerHTML = '<div class="gaps-k">缺件总结 · 只按材料，不补充</div><ul class="gaps-list">' +
          rows.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + '</ul>' +
          '<p class="peek-k">' + esc((j.model || '') + (j.ms ? ' · ' + Math.round(j.ms / 1000) + ' 秒' : '')) + '</p>'
      })
      .catch(function (e) {
        btn.disabled = false
        btn.textContent = '看看缺什么'
        out.innerHTML = '<p class="peek-hint is-bad">' + esc(e.message) + '</p>'
      })
  }

  function renderScreen(c, s) {
    var box = $('screen')
    if (!box) return
    var v = VERDICT[s.verdict] || VERDICT.partial
    var okN = s.checks.filter(function (x) { return x.level === 'ok' }).length
    var rows = s.checks.map(function (x) {
      return '<div class="check"><span class="dot is-' + esc(x.level) + '"></span>' +
        '<span class="check-l">' + esc(x.label) + '</span>' +
        '<span class="check-d">' + esc(x.detail) + '</span></div>'
    }).join('')
    var bits = []
    if (s.spec && s.spec.players) bits.push(s.spec.players + ' 人')
    if (s.spec && s.spec.playersDetail) bits.push(s.spec.playersDetail)
    if (s.spec && s.spec.genre) bits.push(s.spec.genre)
    if (s.spec && s.spec.difficulty) bits.push(s.spec.difficulty)
    if (s.spec && s.spec.duration) bits.push(s.spec.duration)
    if (s.chars) bits.push((s.chars / 1000).toFixed(1) + 'k 字')
    var hint = s.verdict === 'blocked'
      ? '体检没过：先补一份能抽出文字的正文再导入。只想留个档，也可以强制导入。'
      : '导入会把原始文件拷进本子库的 _source/，抽出的文字一起带过去（_text/），然后在档案页按本子读。'
    box.innerHTML =
      '<div class="screen-k">体检 <em>' + esc(v.label) + '</em></div>' +
      '<div class="verdict is-' + esc(v.k) + '"><b>' + esc(v.label) + '</b><span>' + esc(v.line) + '</span>' +
        '<em>' + okN + ' / ' + s.checks.length + ' 项通过</em></div>' +
      (bits.length ? '<div class="spec-line">' + esc(bits.join(' · ')) + '</div>' : '') +
      '<div class="checks">' + rows + '</div>' +
      '<div class="importbar"><button class="primary" id="btn-import" type="button">' +
        (s.verdict === 'blocked' ? '强行导入' : '导入成本子') + '</button>' +
        '<button class="ghost sm" id="btn-gaps-pack" type="button">看看缺什么</button>' +
        '<span class="import-hint">' + esc(hint) + '</span></div>' +
      '<div class="gaps-out" id="gaps-out-pack" hidden></div>'
    $('btn-import').addEventListener('click', function () {
      if (s.verdict === 'blocked') {
        var go = window.confirm('这本一份文字都没抽出来（' + s.fileCount + ' 个文件，' +
          (s.checks.filter(function (x) { return x.level === 'fail'; }).length) + ' 项没过）。\n\n仍然导入吗？导入后只有原始资料，AI 读不到正文。')
        if (!go) return
        doImport(c, true)
        return
      }
      doImport(c, false)
    })
    var gp = $('btn-gaps-pack')
    if (gp) gp.addEventListener('click', function () { gapsReport(state.root, c.folder, gp, $('gaps-out-pack')) })
    if ((s.verdict === 'partial' || s.verdict === 'blocked') && !GAPS_AUTO[c.folder]) {
      GAPS_AUTO[c.folder] = 1
      if (gp) gapsReport(state.root, c.folder, gp, $('gaps-out-pack'))
    }
  }

  function doImport(c, force) {
    var btn = $('btn-import')
    if (btn) { btn.disabled = true; btn.textContent = '正在拷…' }
    fetch(API + '/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: state.root, folder: c.folder, force: force === true })
    })
      .then(function (r) {
        return r.json().then(function (j) { return { status: r.status, body: j } })
      })
      .then(function (out) {
        var j = out.body
        if (!j || !j.ok) {
          if (out.status === 422) {
            var go = window.confirm('体检没过：' + (j.error || '没有可读文字') + '\n\n仍然把整包拷进本子库吗？（会生成一本只有原始资料的档案）')
            if (go) return doImport(c, true)
            if (btn) { btn.disabled = false; btn.textContent = '导入成本子' }
            return
          }
          throw new Error((j && j.error) || '导入失败')
        }
        toast((j.updated ? '已刷新：' : '已导入：') + j.folder + '（原始资料在 _source/，文字在 _text/）', 4600)
        return loadCases(state.roots[0], false).then(function () {
          if (j.folder) select(j.folder)
        })
      })
      .catch(function (e) {
        toast('导入失败：' + e.message, 4600)
        if (btn) { btn.disabled = false; btn.textContent = '导入成本子' }
      })
  }

  // ---------- 预览 ----------
  function preview(c, rel, kind) {
    var url = fileUrl(c, rel)
    if (kind === 'image') {
      previewUrl(url, rel, true)
      return
    }
    if (kind === 'pdf') {
      $('viewer-name').textContent = rel
      $('viewer-raw').href = url
      $('viewer-body').innerHTML = '<iframe class="viewer-frame" src="' + esc(url) + '" title="' + esc(rel) + '"></iframe>'
      $('viewer').hidden = false
      return
    }
    // 文本类（txt/md）：直接取回、当等宽正文看，不要塞 iframe
    fetch(url, { cache: 'no-store' }).then(function (r) { return r.text() }).then(function (t) {
      previewUrl(url, rel, false, t)
    }, function () { previewUrl(url, rel, false, '读不出来：' + url) })
  }

  function previewUrl(url, name, isImage, text) {
    $('viewer-name').textContent = name
    $('viewer-raw').href = url
    if (isImage) {
      $('viewer-body').innerHTML = '<img class="viewer-img" src="' + esc(url) + '" alt="' + esc(name) + '" />'
    } else if (typeof text === 'string') {
      $('viewer-body').innerHTML = '<pre class="viewer-text">' + esc(text) + '</pre>'
    } else {
      $('viewer-body').innerHTML = '<iframe class="viewer-frame" src="' + esc(url) + '" title="' + esc(name) + '"></iframe>'
    }
    $('viewer').hidden = false
  }
  function closeViewer() {
    $('viewer').hidden = true
    $('viewer-body').innerHTML = ''
  }

  function extract(c) {
    var btn = $('btn-extract')
    btn.disabled = true
    btn.textContent = '正在抽…'
    fetch(API + '/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: state.root, folder: c.folder }),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '抽不出来')
        if (!j.made || j.made.length === 0) throw new Error('没有可抽的 PDF' + (j.failed && j.failed.length ? '（失败：' + j.failed.join('、') + '）' : ''))
        toast('已抽出 ' + j.made.length + ' 份文本' + (j.failed && j.failed.length ? '，' + j.failed.length + ' 份失败' : ''), 3200)
        return select(c.folder)
      })
      .catch(function (e) {
        toast('抽出失败：' + e.message, 4200)
        btn.disabled = false
        btn.textContent = c.hasText ? '重新抽出文字' : '抽出文字'
      })
  }

  function reveal(path) {
    fetch(API + '/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) {
          var code = (j && j.error) || '打不开'
          throw new Error(code === 'reveal-host-only' ? '「打开文件夹」只能在那台电脑上点' : code)
        }
        toast('已在资源管理器里打开', 2600)
      })
      .catch(function (e) { toast('打不开文件夹：' + e.message) })
  }

  // 手机端：档案页里的「返回列表」
  $('dossier').addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('.backlink') : null
    if (!b) return
    document.body.classList.remove('is-detail')
    var on = $('cases').querySelector('.case.is-on')
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' })
  })

  // ---------- 选中 ----------
  function select(folder) {
    var hit = state.cases.filter(function (c) { return c.folder === folder })[0]
    if (!hit) return
    state.active = hit
    document.body.classList.add('is-detail')
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
        renderList()
        if (state.cases.length === 0) {
          state.active = null
          $('dossier').innerHTML = '<article class="empty"><p class="empty-k">这个书库还是空的</p><p class="empty-l">' +
            '根目录：<code>' + esc(state.dir) + '</code><br />一个本子一个子目录；有 <code>case.yml</code> 就按结构化读，没有就按资料夹读。<br />' +
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

  function contentCard(it) {
    return '<div class="mode is-content" data-folder="' + esc(it.folder) + '" role="button" tabindex="0" title="按这份资料开一局材料局">' +
      '<button class="ar-kill" type="button" data-kill="' + esc(it.folder) + '" title="从内容库移除">×</button>' +
      '<span class="mode-no">材料 ' + esc(it.id) + ' / ' + esc(it.scheme) + '</span>' +
      '<span class="mode-name">' + esc(it.title) + '</span>' +
      '<span class="mode-line">' + esc(it.note || '主持人照这份资料现编现裁') + '</span>' +
      '<span class="mode-tag">' + (Number(it.chars) > 0 ? '已读 ' + Number(it.chars) + ' 字 · ' + it.files + ' 文件' : '还没抽出文字') + (it.players ? ' · ' + esc(it.players) : '') + '</span>' +
      '</div>'
  }

  function renderArcade(modes) {
    ARC_MODES = modes
    $('modes').innerHTML = modes.map(function (m) {
      return '<button class="mode" data-id="' + esc(m.id) + '" type="button">' +
        '<span class="mode-no">' + esc(m.no) + ' / ' + esc(m.id) + '</span>' +
        '<span class="mode-name">' + esc(m.name) + '</span>' +
        '<span class="mode-line">' + esc(m.line) + '</span>' +
        '<span class="mode-tag">' + esc(m.tag + (m.players ? ' · ' + m.players : '')) + '</span>' +
        '</button>'
    }).join('') +
      (ARC_ITEMS || []).map(contentCard).join('') +
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
        if (j && j.ok) { ARC_ITEMS = j.items || []; if (ARC_MODES) renderArcade(ARC_MODES) }
      })
      .catch(function () { /* 内容库读不到就只列七种玩法 */ })
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
  function openArcadeImport() {
    $('arcade-sheet').hidden = false
    $('arcade-result').hidden = true
    $('arcade-result').innerHTML = ''
    A_LAST = null
    stopArcadePoll()
    $('a-path').focus()
  }
  function closeArcadeImport() { $('arcade-sheet').hidden = true; stopArcadePoll() }
  function stopArcadePoll() { if (A_POLL) { clearInterval(A_POLL); A_POLL = null } }
  function arcadePaint(pct, label, busy) {
    var box = $('arcade-result')
    box.hidden = false
    box.innerHTML = '<div class="progress"><div class="progress-bar"><i class="' + (busy ? 'is-wait' : '') + '" style="width:' + Math.max(2, Math.min(100, Math.round(pct))) + '%"></i></div>' +
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
  function arcadeWatch(root, folder) {
    stopArcadePoll()
    var q = '?root=' + encodeURIComponent(root) + '&folder=' + encodeURIComponent(folder)
    A_POLL = setInterval(function () {
      fetch(API + '/extract/status' + q, { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
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
          } else {
            arcadePaint(88, '文字抽取完成', false)
            arcadeReady('')
          }
        })
        .catch(function () { stopArcadePoll(); arcadePaint(0, '进度接口没应答', false) })
    }, 900)
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
  function arcadeAdd(btn) {
    if (!A_LAST) return
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
      '<div class="progress" id="peek-progress" hidden><div class="progress-bar"><i id="peek-pbar"></i></div>' +
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
    if (el) {
      el.className = st && st.state === 'running' ? 'is-wait' : ''
      el.style.width = peekPct(st) + '%'
    }
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
      if (st.state === 'done') {
        lb.textContent = '抽完：成功 ' + (st.made || 0) + ' 份' + (st.failed ? '，失败 ' + st.failed + ' 份' : '') +
          (st.cached ? '（用的本地缓存）' : '') + '，' + sec + ' 秒'
      } else if (st.state === 'error') {
        lb.textContent = '抽取出错：' + (st.error || '未知')
      } else {
        lb.textContent = '没有可抽的文件'
      }
      return true
    }
    function loop() {
      fetch(API + '/extract/status?root=' + encodeURIComponent(root) + '&folder=' + encodeURIComponent(folder), { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          if (!j || !j.ok) return
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
        if (!j || !j.ok) throw new Error((j && j.error) || ('读不到这个路径（HTTP ' + out.status + '）'))
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

  function pollImport(root, folder, forced) {
    function giveUp(msg) {
      var btn = $('btn-peek-import')
      if (btn) { btn.disabled = false; btn.textContent = '导入成本子' }
      if (msg) toast(msg, 5200)
    }
    function loop() {
      fetch(API + '/import/status?root=' + encodeURIComponent(root) + '&folder=' + encodeURIComponent(folder), { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) {
          var st = (j && j.importing) || { state: 'idle' }
          if (st.state === 'running') { st.ocr = j.ocr || null; paintPeek(st); peekPoll = setTimeout(loop, 700); return }
          if (st.state === 'done') {
            paintPeek({ state: 'done', phase: 'done', elapsedMs: st.elapsedMs, done: st.total, total: st.total })
            var res = st.result || {}
            toast((res.updated ? '已刷新：' : '已导入：') + (res.folder || folder), 4200)
            setTimeout(closeImport, 900)
            loadCases(state.roots[0], false).then(function () { select(res.folder || folder) })
            return
          }
          if (st.state === 'error') {
            var out = st.result || {}
            if (out.code === 422 && !forced) {
              if (window.confirm('体检没过：' + (st.error || '没有可读文字') + '\n\n仍然把整包拷进本子库吗？')) { importPeek(true); return }
              paintPeek({ state: 'idle' })
              giveUp('')
              return
            }
            paintPeek({ state: 'error' })
            giveUp('导入失败：' + (st.error || '未知'))
            return
          }
          peekPoll = setTimeout(loop, 1200)
        })
        .catch(function () { peekPoll = setTimeout(loop, 1500) })
    }
    loop()
  }

  // ---------- 局域网 ----------
  function lanPaint(st) {
    var en = $('l-enable')
    if (en) en.value = st.enabled ? 'on' : 'off'
    var port = $('l-port')
    if (port) port.value = st.port || 5288
    $('l-key').textContent = st.key || '——'
    var box = $('l-urls')
    if (st.enabled && st.urls && st.urls.length) {
      box.innerHTML = st.urls.map(function (u, i) {
        var url = typeof u === 'string' ? u : u.url
        var label = typeof u === 'string' ? '' : (u.label || '')
        return '<div class="lan-url"><span>' + esc(url) + (label ? '<em>' + esc(label) + '</em>' : '') + '</span><button type="button" class="ghost sm" data-copy="' + i + '">复制</button></div>'
      }).join('')
      Array.prototype.forEach.call(box.querySelectorAll('[data-copy]'), function (b) {
        b.addEventListener('click', function () {
          var u = st.urls[Number(b.getAttribute('data-copy'))]
          copyText(typeof u === 'string' ? u : u.url, '链接已复制，发到手机就能开')
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
    fetch(API + '/lan', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) { if (j && j.ok) lanPaint(j.lan) })
      .catch(function () { toast('局域网接口没应答') })
  }

  function lanSet(body, okMsg) {
    fetch(API + '/lan', {
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
  var T_ERR = {
    'cloudflared-not-installed': '没找到 cloudflared —— 装到 ~/.local/bin/cloudflared.exe 或 PATH 里再开',
    'lan-not-running': '局域网服务没起来，隧道接不上 —— 先把上面的局域网开关拨到「开」',
    'tunnel-timeout': '45 秒没连上 Cloudflare 边缘 —— 这台机器可能出不去公网',
  }
  function tunnelPaint(t) {
    var en = $('t-enable')
    if (en) en.value = (t.running || t.starting) ? 'on' : 'off'
    var box = $('t-urls')
    var warn = $('t-warn')
    if (!box) return
    if (t.starting) {
      box.innerHTML = '<div class="lan-none">正在拉起隧道（cloudflared 连 Cloudflare 边缘，通常十几秒）…</div>'
      if (warn) { warn.className = 't-warn'; warn.textContent = '' }
      tunnelPoll()
      return
    }
    if (t.running && t.link) {
      box.innerHTML = '<div class="lan-url"><span>' + esc(t.link) + '<em>公网 · HTTPS</em></span><button type="button" class="ghost sm" id="t-copy">复制</button></div>'
      $('t-copy').addEventListener('click', function () { copyText(t.link, '公网链接已复制 —— 发给谁，谁就能进这间房') })
      if (warn) {
        warn.className = 't-warn'
        warn.textContent = '随开随换：关掉再开就是新地址。公网只认 16 位长钥匙（局域网短钥匙在公网无效）。拿到链接的人能用你的模型额度请 DM —— 别把链接发到公开场合。'
      }
    } else {
      box.innerHTML = '<div class="lan-none">关着。开了会用本机 cloudflared 出一条只出不进的 HTTPS 隧道，局域网外的设备凭长钥匙进。</div>'
      if (warn) {
        warn.className = 't-warn' + (t.error ? ' is-bad' : '')
        warn.textContent = t.error ? (T_ERR[String(t.error)] || String(t.error)) : ''
      }
    }
  }
  function tunnelPoll() {
    clearTimeout(T_POLL)
    T_POLL = setTimeout(function () {
      fetch(API + '/tunnel', { cache: 'no-store' })
        .then(function (r) { return r.json() })
        .then(function (j) { if (j && j.ok) tunnelPaint(j.tunnel) })
        .catch(function () {})
    }, 1500)
  }
  function loadTunnel() {
    fetch(API + '/tunnel', { cache: 'no-store' })
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
  function tunnelSet(body, okMsg) {
    fetch(API + '/tunnel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.ok) { tunnelPaint(j.tunnel); if (okMsg) toast(okMsg) }
        else toast('没改成：' + ((j && j.error) || '未知'))
      })
      .catch(function () { toast('隧道接口没应答') })
  }


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
    if (arcade) { loadCatalog() } else if (!CASES_LOADED) {
      CASES_LOADED = true
      loadCases('', false)
    }
  }
  var CASES_LOADED = panel !== 'arcade'
  setRoom(panel)
  if (panel !== 'arcade') {
    var deepRoot = params.get('root') || ''
    var deepCase = params.get('case') || ''
    loadCases(deepRoot, false).then(function () {
      if (deepCase && state.cases.some(function (c) { return c.folder === deepCase })) select(deepCase)
    })
  }

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
  $('arcade-sheet').addEventListener('click', function (e) { if (e.target === $('arcade-sheet')) closeArcadeImport() })
  $('a-path').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); arcadeScan() } })
  $('r-mode').addEventListener('change', function () { remoteSave() })
  $('r-daily').addEventListener('change', function () { remoteSave() })
  $('modes').addEventListener('click', function (e) {
    var t = e.target
    var kill = t.closest ? t.closest('.ar-kill') : null
    if (kill) { e.stopPropagation(); deleteArcade(kill.getAttribute('data-kill')); return }
    var add = t.closest ? t.closest('.is-add') : null
    if (add) { openArcadeImport(); return }
    var card = t.closest ? t.closest('.is-content') : null
    if (card) {
      var f = card.getAttribute('data-folder')
      var it = (ARC_ITEMS || []).filter(function (x) { return x.folder === f })[0]
      if (it && window.GameRoom) window.GameRoom.open(it)
      else if (it) toast('房间脚本没加载')
    }
  })
  $('match-close').addEventListener('click', function () { $('match').hidden = true })
  $('match').addEventListener('click', function (e) { if (e.target === $('match')) $('match').hidden = true })
  window.addEventListener('message', function (ev) {
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
  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderList() })
  Array.prototype.forEach.call($('chips').querySelectorAll('.chip'), function (el) {
    el.addEventListener('click', function () {
      Array.prototype.forEach.call($('chips').querySelectorAll('.chip'), function (x) { x.classList.remove('is-on') })
      el.classList.add('is-on')
      state.filter = el.getAttribute('data-filter')
      renderList()
    })
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

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeSheet(); closeImport(); closeViewer(); closeArcadeImport(); $('lan-sheet').hidden = true; $('match').hidden = true; if (window.GameTable) window.GameTable.close(); if (window.GameRoom) window.GameRoom.close() }
    if (e.key === '/' && document.activeElement !== $('q')) { e.preventDefault(); $('q').focus() }
  })
})()
