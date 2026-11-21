// 档案页（本子 / 资料夹两种视图 + 体检块 + 导入 + 预览 + 抽字 + 报告）——从 app.js 搬出来的渲染层。
// 只搬不改：可变状态 LAST_REVIEW / GAPS_AUTO 仍住在 app.js，这里通过 deps.getLastReview() / deps.getGapsAuto()
// 拿到同一个对象引用（对象内写回照旧生效，不复制语义）。书库状态 deps.state 同理。
import { esc, bytes, errCn, errHtml, GENRE, DIFF, genreOf, diffOf, rawTick, playersText, caseNo, fmtAt } from './util.js'
import { aiFillItems, packMissHtml, reviewResultHtml, packReviewHtml, packAiFillHtml, playtestHtml, fact } from './packview.js'

export function createPackDossier(deps) {
  var $ = deps.$
  var API = deps.API
  var GAPS_AUTO = deps.getGapsAuto()
  var LAST_REVIEW = deps.getLastReview()
  var arcTag = deps.arcTag
  var copyText = deps.copyText
  var loadCases = deps.loadCases
  var loadSeats = deps.loadSeats
  var openTable = deps.openTable
  var paintSeatRow = deps.paintSeatRow
  var pickSeat = deps.pickSeat
  var pollImport = deps.pollImport
  var postJson = deps.postJson
  var reloadListQuiet = deps.reloadListQuiet
  var runCaseOcr = deps.runCaseOcr
  var seatRowHtml = deps.seatRowHtml
  var select = deps.select
  var setBtnBusy = deps.setBtnBusy
  var state = deps.state
  var tableMe = deps.tableMe
  var tableSave = deps.tableSave
  var toast = deps.toast

  function reviewKeyOf(folder, root) { return (root || state.root) + '|' + folder }


  // 档案页拿的是 /api/case 的 pack 回包（带 meta）；老宿主不带时退回书库列表里那一条，都没有就当没体检。
  function caseMetaOf(c) {
    if (c && c.meta) return c.meta
    var folder = c && c.folder
    if (!folder) return null
    var hit = (state.cases || []).filter(function (x) { return x.kind === 'pack' && x.folder === folder })[0]
    return (hit && hit.meta) || null
  }
  // 页面上这一组「补这项」按钮（单 key 也是一次模型调用，点了先整组禁用）。
  function fillOneButtons() {
    var root = $('dossier')
    if (!root) return []
    return Array.prototype.slice.call(root.querySelectorAll('[data-gd-act="fill-one"]'))
  }
  // 失败时把整组恢复：成功那条路径会整页重画，不用管；这里只动还挂在文档上的节点。
  function fillGroupReset(grp, btn, oldText) {
    (grp || []).forEach(function (b) { if (b && b.isConnected) b.disabled = false })
    if (btn && btn.isConnected) {
      btn.disabled = false
      if (oldText != null) btn.textContent = oldText
    }
  }
  // 复核块里的「到下面逐项补」：只滚动定位，不发任何模型调用。
  function gotoAiFill() {
    var el = $('gd-aifill')
    if (!el) { toast('这本现在没有待补的项（缺项都补上了，或还没复核）', 3600); return }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('is-flash')
    setTimeout(function () { el.classList.remove('is-flash') }, 1200)
  }
  function packHttpErr(res) {
    var st = res && res.status
    var code = String(((res && res.body) || {}).error || '')
    if (code === 'root-not-allowed') return '这个书库不在允许范围里，先去书库栏换一个'
    if (code === 'folder-required') return '没带资料夹名（内部错误，刷新页面再试）'
    if (code === 'pack-not-found') return '找不到这个资料夹了，刷新一下书库'
    if (code === 'no-text') return '这本还没抽出文字，先点下面的「抽出文字」'
    if (code === 'keys-required' || code === 'bad-key') return '要补的项对不上体检记录，先重算一次标签'
    if (code === 'too-many-keys') return '一次最多 3 项'
    if (code === 'meta-write-failed') return '体检数据写不进去（资料夹可能只读）'
    if (code === 'too-long' || code === 'text-too-long') return '原文太长，模型装不下'
    if (st === 401) return '登录状态过期了，刷新页面再试'
    if (st === 403) return '没有权限做这个操作'
    if (st === 502) return '模型没回话' + (code ? '：' + code : '') + '，过一会儿再试'
    if (st === 503) return '没有可用的模型' + (code ? '：' + code : '')
    if (st === 422) return '这本没有可用的原文' + (code ? '：' + code : '')
    return 'HTTP ' + st + (code ? '：' + code : '')
  }
  function runPackReview(folder, btn) {
    if (btn && btn.disabled) return
    var memoRoot = state.root   // 回包要等模型，记键用发起时的书库，别按回调时切换过的 state.root 归错库
    setBtnBusy(btn, true, '复核中…')
    var box = $('gd-review-out')
    if (box) box.innerHTML = '<p class="gd-line is-wait">正在对着原文逐项核（一次模型调用，十来秒）…</p>'
    postJson('/packs/review', { root: state.root, folder: folder })
      .then(function (res) {
        var j = res.body || {}
        if (res.status !== 200 || !j.ok) throw new Error(packHttpErr(res))
        var rec = {
          at: j.at || new Date().toISOString(),
          model: j.model || '',
          verdicts: j.verdicts || [],
          reallyMissing: j.reallyMissing || [],
          present: j.present || [],
          note: j.note || '',
        }
        LAST_REVIEW[reviewKeyOf(folder, memoRoot)] = rec
        // 宿主已把 review 写进 meta；这里同步一份，重渲染时读得到
        var meta = (state.active && caseMetaOf(state.active)) || {}
        if (!meta.review) meta.review = { at: rec.at, model: rec.model, verdicts: rec.verdicts }
        var out = $('gd-review-out')
        if (out) out.innerHTML = reviewResultHtml({ folder: folder }, meta, rec)
        var np = rec.present.length
        var nm = rec.reallyMissing.length
        toast(np ? ('复核完：' + np + ' 项其实原文里就有') : (nm ? ('复核完：' + nm + ' 项确实缺') : '复核完：没有要补的'), 3400)
      })
      .catch(function (e) {
        var out = $('gd-review-out')
        if (out) out.innerHTML = '<p class="gd-line is-bad">复核没成：' + esc(e.message) + '</p>'
        toast('复核失败：' + e.message, 4400)
      })
      .then(function () { setBtnBusy(btn, false) })
  }

  // 重算只动体检标签（只读文本缓存）；复核/补全/撤销之后都走这一条把档案页拉到最新。
  function packRecompute(folder, btn) {
    if (btn && btn.disabled) return
    var memoRoot = state.root   // 同上：失效哪一份 memo 按发起时的书库算
    setBtnBusy(btn, true, '重算中…')
    postJson('/packs/meta', { root: state.root, folder: folder })
      .then(function (res) {
        var j = res.body || {}
        if (res.status !== 200 || !j.ok) throw new Error(packHttpErr(res))
        var hit = (j.metas || [])[0] || null
        // 「还缺几项」也走 effective：AI 补过的不算缺（旧回包缺字段时按 old 口径退回）。
        var left = 0
        if (hit) {
          if (Array.isArray(hit.missingEffective)) left = hit.missingEffective.length
          else if (Array.isArray(hit.missing)) left = hit.missing.length
          else left = Number(hit.missing) || 0
        }
        toast(hit ? ('标签已重算：还缺 ' + left + ' 项') : '这本没有可重算的文字（先抽出文字）', 3600)
        delete LAST_REVIEW[reviewKeyOf(folder, memoRoot)]
        return loadCases(state.root, true).then(function () { return refreshActiveScreen() })
      })
      .catch(function (e) { toast('重算标签失败：' + e.message, 4200); setBtnBusy(btn, false) })
  }

  // 一次只补一项（用户 2026-11-19：不要合成「补这 M 项」，逐项分开执行）。
  // 单 key 不弹原生 confirm —— 点「补这项」本身就是那次确认；批量入口已删（复核块改成滚到这张逐项表）。
  // 补完只做两件事：重取书库标签（重画右侧、人不跳页）+ 重拉一次体检（「N/M 项通过」与逐行标记当场变）。
  function packFill(folder, btn, oneKey) {
    if (btn && btn.disabled) return
    var key = String(oneKey || '')
    if (!key) { toast('没指明要补哪一项（刷新页面再试）', 4200); return }
    var meta = (state.active && caseMetaOf(state.active)) || {}
    if (aiFillItems(meta)[key]) { toast('这一项已经补过了，要重来先在缺项那一栏撤销', 3600); return }
    var label = (btn && btn.getAttribute('data-gd-label')) || key
    var grp = fillOneButtons()
    var oldText = btn ? btn.textContent : null
    grp.forEach(function (b) { b.disabled = true })
    if (btn) btn.textContent = '正在补…'
    var memoRoot = state.root   // 失效哪一份 memo 按发起时的书库算（回调里 state.root 可能已经切走）
    postJson('/packs/fill', { root: state.root, folder: folder, keys: [key] })
      .then(function (res) {
        var j = res.body || {}
        // 502「模型没返回」也可能已经写出了这一项：有 made 就当成成功收尾。
        if (res.status !== 200 && !(j.made && j.made.length)) throw new Error(packHttpErr(res))
        var m0 = (j.made && j.made[0]) || null
        if (!m0) throw new Error((j.failed && j.failed[0] && j.failed[0].error) || '模型没返回内容')
        delete LAST_REVIEW[reviewKeyOf(folder, memoRoot)]
        var who = m0.label || label
        toast('已补「' + who + '」，写在 _ai_fill/' + (m0.file || '') +
          (m0.chars ? '（' + m0.chars + ' 字）' : '') + '，体检这一项已打「AI 补全」', 5400)
        return loadCases(state.root, true)
          .then(function () { return refreshActiveScreen() })
          .catch(function () { /* 刷新失败不影响已经写好的补全，下次刷新页面即见 */ })
      })
      .catch(function (e) {
        toast('补全失败：' + e.message, 4600)
        fillGroupReset(grp, btn, oldText)
      })
  }

  // AI 试玩（用户 2026-11-20）：体检完让它按流程走一遍，回答「这局现在能不能开」。
  // 缺项不挡流程就算能玩 —— 口径在宿主提示词里；这里只负责跑、画、失败恢复。
  var PT_DONE = {} // root|folder → 这一页会话已经自动试玩过（同一份材料不重复烧模型）
  function runPackPlaytest(c, btn, force) {
    var box = $('gd-pt')
    if (!box) return
    if (btn && btn.disabled) return
    setBtnBusy(btn, true, '试玩中…')
    box.innerHTML = playtestHtml(c, null, { running: true })
    postJson('/packs/playtest', { root: state.root, folder: c.folder, force: force === true })
      .then(function (res) {
        var j = res.body || {}
        if (res.status !== 200 || !j.ok) throw new Error(packHttpErr(res))
        var pt = j.playtest || null
        box.innerHTML = playtestHtml(c, pt, {})
        // 本机那份 meta 也顺手更新：切走再回来不用再跑一遍
        if (c.meta && pt) c.meta.playtest = pt
        var msg = !pt ? '试玩没拿到结论'
          : (pt.canPlay
            ? (pt.verdict === 'risky' ? '能玩：有几处偏薄，DM 现场补一句就行' : '能玩：六个环节都读得通')
            : ('开不起来：' + (pt.blockers || []).length + ' 处卡住'))
        toast(msg + (j.cached ? '（材料没变，用的上次结论）' : ''), 4600)
      })
      .catch(function (e) {
        box.innerHTML = '<div class="pt-head"><span class="pt-k">AI 试玩</span></div>' +
          '<p class="gd-line is-bad">试玩没成：' + esc(e.message) + '</p>'
        toast('试玩失败：' + e.message, 4400)
      })
      .then(function () { setBtnBusy(btn, false) })
  }
  function packUndo(folder, key, label, btn) {
    if (btn && btn.disabled) return
    if (!window.confirm('撤销「' + (label || key) + '」的 AI 补全？只删 _ai_fill 里那一份，原稿不动。')) return
    var memoRoot = state.root   // 同上：按发起时的书库清 memo
    setBtnBusy(btn, true, '撤销中…')
    postJson('/packs/fill/undo', { root: state.root, folder: folder, keys: [key] })
      .then(function (res) {
        var j = res.body || {}
        if (res.status !== 200 || !j.ok) throw new Error(packHttpErr(res))
        var n = Array.isArray(j.removed) ? j.removed.length : 0
        toast(n ? ('已撤销「' + (label || key) + '」的补全') : '这项本来就没有 AI 补全', 3600)
        delete LAST_REVIEW[reviewKeyOf(folder, memoRoot)]
        return loadCases(state.root, true)
      })
      .then(function () { return refreshActiveScreen() })
      .catch(function (e) { toast('撤销失败：' + e.message, 4400); setBtnBusy(btn, false) })
  }
  function renderCase(c) {
    // 重画前记住档案页的滚动位置，画完放回去（点座位/切本不再跳回顶部）
    var dbox0 = $('dossier')
    var dscroll0 = dbox0 ? dbox0.scrollTop : 0
    var mineIdx = tableMe(c)
    var seats = seatRowHtml(c, mineIdx)
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
          '<button class="ghost sm" id="btn-ocr" type="button" title="对 _source 里抽不出字的扫描件跑本机 OCR（rapid 走 CPU；vl 与生图显存互斥，先停生图）">识图补齐</button>' +
        '</div>'
      : ''
    var gapRows = (imported && Array.isArray(c.gaps) && c.gaps.length)
      ? '<div class="gaplist"><div class="gaplist-k">体检没认出的项 · ' + c.gaps.length + ' 项 —— 没认出 ≠ 原文没有：先在 _text/ 里按关键词搜一遍，确实没有再补</div>' +
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
        '<div class="eyebrow">case ' + esc(caseNo(c, state.root, state.cases)) + (c.victim ? ' · 死者 ' + esc(c.victim) : '') + (imported ? ' · 导入本' : '') + '</div>' +
        '<h1 class="title">' + esc(c.title) + '</h1>' +
        '<div class="tags">' + tags + '</div>' +
        importBlock + gapRows + '<div class="gaps-out" id="gaps-out" hidden></div>' +
        '<div class="facts">' + fact('人数', c.players ? playersText(c.players) : ((c.roles || []).length + ' 人')) + fact('座位', (c.roles || []).length + ' 席') +
          fact('类型', genreOf(c), rawTick(c.genre, GENRE)) + fact('难度', diffOf(c), rawTick(c.difficulty, DIFF)) + '</div>' +
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
    // 服务端有更准的占位就把座位重画一遍（拉不到就保持上面按本地存档画的）
    loadSeats(c, function () { paintSeatRow(c) })
    $('btn-case-file').addEventListener('click', function () { copyText(c.file || c.dir, '本子路径已复制') })
    $('btn-open-dir').addEventListener('click', function () { reveal(c.dir) })
    var gb = $('btn-gaps')
    if (gb) gb.addEventListener('click', function () { gapsReport(state.root, c.folder, gb, $('gaps-out')) })
    var ob = $('btn-ocr')
    if (ob) ob.addEventListener('click', function () { runCaseOcr(c.folder, ob) })
    Array.prototype.forEach.call($('dossier').querySelectorAll('.file'), function (el) {
      el.addEventListener('click', function () { preview(c, el.getAttribute('data-rel'), el.getAttribute('data-kind')) })
    })
    Array.prototype.forEach.call($('dossier').querySelectorAll('.thumb'), function (el) {
      el.addEventListener('click', function () { preview(c, el.getAttribute('data-rel'), 'image') })
    })
    var dbox1 = $('dossier')
    if (dbox1) dbox1.scrollTop = dscroll0
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

    // 缺项复核这一组只对「体检说还缺」的资料夹本出现；补全状态则只要有过补全就一直显示。
    var pmeta = caseMetaOf(c)
    var gdMiss = packMissHtml(c, pmeta)
    var gdReview = packReviewHtml(c, pmeta, { lastReview: LAST_REVIEW, root: state.root })
    var gdAiFill = packAiFillHtml(c, pmeta, { lastReview: LAST_REVIEW, root: state.root })

    $('dossier').innerHTML =
      '<div class="dossier-inner">' +
        '<button class="backlink" type="button">← 返回列表</button>' +
        '<div class="eyebrow">pack · ' + (c.players ? esc(playersText(c.players)) + '本 · ' : '') + c.files.length + ' 个文件</div>' +
        '<h1 class="title">' + esc(c.title) + '</h1>' +
        '<div class="tags"><span class="tag">资料夹</span>' +
          (c.counts.pdf ? '<span class="tag">PDF ' + c.counts.pdf + '</span>' : '') +
          (c.counts.image ? '<span class="tag">图片 ' + c.counts.image + '</span>' : '') +
          (c.counts.doc ? '<span class="tag">文档 ' + c.counts.doc + '</span>' : '') +
        '</div>' +
        gdMiss + gdReview + gdAiFill +
        '<div class="facts">' + fact('人数', c.players ? playersText(c.players) : '未标注') + fact('文件', c.files.length + ' 个') +
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
    if (!box) return Promise.resolve(null)
    return fetch(API + '/screen?root=' + encodeURIComponent(state.root) + '&folder=' + encodeURIComponent(c.folder), { cache: 'no-store' })
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
  // 补全 / 撤销 / 重算之后，「N / M 项通过」与逐行标记要当场变（用户 2026-11-19）。
  // 档案页停在 pack 视图时重拉一次 /screen（进页面那次是 renderPack 末尾的 loadScreen(c)）。
  function refreshActiveScreen() {
    var c = state.active
    if (!c || c.kind !== 'pack') return Promise.resolve(null)
    if (!$('screen')) return Promise.resolve(null)
    return loadScreen(c)
  }
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
          out.innerHTML = '<p class="peek-hint is-bad">' + errHtml(j && j.error, '接口没应答') + '</p>'
          return
        }
        var rows = String(j.text).split('\n').map(function (x) { return x.replace(/^[-\u2022\s]+/, '').trim() }).filter(Boolean)
        out.innerHTML = '<div class="gaps-k">缺件总结 · 全文检索+抽样，只按材料，不补充</div><ul class="gaps-list">' +
          rows.map(function (x) { return '<li>' + esc(x) + '</li>' }).join('') + '</ul>' +
          '<p class="peek-k">' + esc((j.model || '') + (j.ms ? ' · ' + Math.round(j.ms / 1000) + ' 秒' : '')) + '</p>'
      })
      .catch(function (e) {
        btn.disabled = false
        btn.textContent = '看看缺什么'
        out.innerHTML = '<p class="peek-hint is-bad">' + esc(e.message) + '</p>'
      })
  }
  // 体检行上的「AI 补全」标记（用户 2026-11-19：补全的项目在体检处也要打上标记）。
  // 宿主已经把这类 check 的 level 改成 ok、detail 写成「AI 补全（N 字）…」，这里只加可见标记，detail 一字不动。
  function aiBadgeTitle(x) {
    var t = 'AI 补全：原稿没有这一项，是按已有正文补写的，不是原文'
    if (x && x.aiChars) t += '（' + x.aiChars + ' 字）'
    if (x && x.aiAt) t += ' · ' + fmtAt(x.aiAt)
    return t
  }
  function renderScreen(c, s) {
    var box = $('screen')
    if (!box) return
    s = s || {}
    var checks = Array.isArray(s.checks) ? s.checks : []
    var v = VERDICT[s.verdict] || VERDICT.partial
    var okN = checks.filter(function (x) { return x && x.level === 'ok' }).length
    // K = 宿主算好的补全条数（s.aiFill.count）；旧回包没有 aiFill 时按行上的 x.ai 逐条数。
    var aiMarked = checks.filter(function (x) { return x && x.ai === true }).length
    var aiN = ((s.aiFill && Number(s.aiFill.count) > 0) ? Number(s.aiFill.count) : 0) || aiMarked
    var rows = checks.map(function (x) {
      x = x || {}
      var isAi = x.ai === true
      return '<div class="check' + (isAi ? ' is-ai' : '') + '">' +
        '<span class="dot is-' + esc(x.level || 'warn') + (isAi ? ' is-ai' : '') + '"></span>' +
        '<span class="check-l">' + esc(x.label) +
          (isAi ? '<span class="chk-ai" title="' + esc(aiBadgeTitle(x)) + '">AI 补全</span>' : '') +
        '</span>' +
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
      // 结论只留一处：上面这行小标只写「体检」，判定文字由下面的 .verdict 出
      '<div class="screen-k">体检</div>' +
      '<div class="verdict is-' + esc(v.k) + (aiN ? ' is-aifill' : '') + '"><b>' + esc(v.label) + '</b><span>' + esc(v.line) + '</span>' +
        '<span class="verdict-nums"><em>' + okN + ' / ' + checks.length + ' 项通过</em>' +
          (aiN ? '<em class="verdict-ai" title="' + esc('其中 ' + aiN + ' 项原稿里没有，是按已有正文补写的 —— 档案页缺项那一栏能逐条撤') + '">含 ' + aiN + ' 项 AI 补全</em>' : '') +
        '</span></div>' +
      (bits.length ? '<div class="spec-line">' + esc(bits.join(' · ')) + '</div>' : '') +
      // AI 试玩：体检结论下面紧跟一句「这局开不开得起来」（结果过期时标 stale）
      '<div class="gaps-out ptbox" id="gd-pt">' + playtestHtml(c, s.playtest, { stale: s.playtestStale === true }) + '</div>' +
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
    // 键一律 root|folder（与 seatKeyOf 同一套拼法）：两个书库各有一本同名资料夹时，
    // A 书自动体检过不该让 B 书跳过自动体检。
    var gapsKey = state.root + '|' + c.folder
    if ((s.verdict === 'partial' || s.verdict === 'blocked') && !GAPS_AUTO[gapsKey]) {
      GAPS_AUTO[gapsKey] = 1
      if (gp) gapsReport(state.root, c.folder, gp, $('gaps-out-pack'))
    }
    // 体检有正文就自动试玩一次（同一页会话只跑一次；有旧结论但材料变了会重跑一次）。
    // 没正文（chars=0）不跑：那本来就是把材料读光的情况，跑了也只是让模型说不知道。
    if (!s.already && Number(s.chars) > 0 && !PT_DONE[gapsKey] && (!s.playtest || s.playtestStale === true)) {
      PT_DONE[gapsKey] = 1
      runPackPlaytest(c, null, s.playtestStale === true)
    }
  }
  function doImport(c, force) {
    var btn = $('btn-import')
    if (btn) { btn.disabled = true; btn.textContent = '正在拷…' }
    // 同步等同一次长请求：一本扫描件要抽几分钟，隧道/页面先断了就只剩「导入失败」。
    // 改成后台任务（202）+ 轮询 /api/import/status；422 的确认分支在 pollImport 里，别绕过它。
    fetch(API + '/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: state.root, folder: c.folder, force: force === true, wait: false })
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
          throw new Error(errCn(j && j.error, '导入没起来（HTTP ' + out.status + '）'))
        }
        // 202：任务在宿主后台跑，进度由 pollImport 轮（同一个状态接口，422 确认也走它）
        pollImport(state.root, c.folder, force === true, {
          btn: btn,
          quiet: true,
          idleText: '导入成本子',
          again: function (folder) { doImport(c, true) },
          onDone: function (folder) {
            // 用当前书库（state.root）：roots[0] 会让导入完成后跳回第一个书库，刚导入那本当场消失
            loadCases(state.root, false).then(function () { select(folder || c.folder) })
          }
        })
      })
      .catch(function (e) {
        toast('导入失败：' + errCn(e.message, '导入失败'), 4600)
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
    if (kind !== 'text' && kind !== 'txt' && kind !== 'md') {
      // doc/docx/xls/xlsx/ppt 是二进制：以前 fetch().text() 按 UTF-8 解，屏幕上就是乱码。
      // 交给浏览器自己认（认不了再点「打开文件夹」用 Word / WPS 打开原件）。
      $('viewer-name').textContent = rel
      $('viewer-raw').href = url
      $('viewer-body').innerHTML = '<iframe class="viewer-frame" src="' + esc(url) + '" title="' + esc(rel) + '"></iframe>' +
        '<p class="viewer-fallback">打不开是正常的（这类格式浏览器多半不认）—— 点右边按钮用 Word / WPS 打开原件：' +
        '<button class="ghost sm" id="viewer-open-dir" type="button">打开文件夹</button></p>'
      $('viewer').hidden = false
      var ob = $('viewer-open-dir')
      if (ob) ob.addEventListener('click', function () { reveal(c.dir) })
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
  // 抽字是长任务（扫描件一本几分钟）：同步等一次 fetch 会被隧道/页面超时掐断，
  // 用户看到的是「失败」而宿主其实还在跑。改成后台任务（202）+ 轮询 /api/extract/status。
  var EX_POLL = null
  function stopExtractPoll() { if (EX_POLL) { clearTimeout(EX_POLL); EX_POLL = null } }
  function extractBtnText(c) { return c && c.hasText ? '重新抽出文字' : '抽出文字' }
  function extract(c) {
    var btn = $('btn-extract')
    if (btn) { btn.disabled = true; btn.textContent = '正在抽…' }
    stopExtractPoll()
    fetch(API + '/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: state.root, folder: c.folder, background: true }),
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j } }) })
      .then(function (out) {
        var j = out.body
        if (!j || !j.ok) throw new Error(errCn(j && j.error, '抽不出文字（HTTP ' + out.status + '）'))
        extractPoll(c, 0)
      })
      .catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = extractBtnText(c) }
        toast('抽出失败：' + errCn(e.message, '抽出失败'), 4600)
      })
  }
  function extractPoll(c, tries) {
    var n = Number(tries) || 0
    var btn = $('btn-extract')
    fetch(API + '/extract/status?root=' + encodeURIComponent(state.root) + '&folder=' + encodeURIComponent(c.folder), { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || j.ok === false) {
          stopExtractPoll()
          if (btn) { btn.disabled = false; btn.textContent = extractBtnText(c) }
          toast('抽不出文字：' + errCn(j && j.error, '进度接口没应答'), 4600)
          return
        }
        var st = j.extracting || {}
        var done = Number(st.done) || 0
        var total = Number(st.total) || 0
        var sec = Math.round((Number(st.elapsedMs) || 0) / 1000)
        if (st.state === 'running') {
          if (btn) btn.textContent = (st.phase === 'image' ? '正在认图 ' : '正在抽 ') + (total ? done + ' / ' + total : '…') + ' · ' + sec + ' 秒'
          EX_POLL = setTimeout(function () { extractPoll(c, n + 1) }, 900)
          return
        }
        // 刚提交时上一次任务的状态可能还没翻成 running：多问几次再下结论
        if (n < 3 && (st.state === 'done' || !st.state)) {
          EX_POLL = setTimeout(function () { extractPoll(c, n + 1) }, 400)
          return
        }
        stopExtractPoll()
        if (btn) { btn.disabled = false; btn.textContent = extractBtnText(c) }
        if (st.state === 'error') { toast('抽出失败：' + errCn(st.error, '抽不出来'), 4800); return }
        // 宿主区分「这次抽的」和「以前就有的缓存」：cached 时 made/failed 是 null，不能报「没有可抽的 PDF」
        if (st.cached === true) {
          var nf = Number(j.files) || 0
          toast('这本之前抽过，直接用现成文本' + (nf ? '（' + nf + ' 份）' : ''), 3600)
          reloadListQuiet().then(function () { return select(c.folder) })
          return
        }
        if (st.state !== 'done') { toast('没等到抽取结果（宿主可能刚重启过），再点一次试试', 4600); return }
        var made = Number(st.made) || 0
        var failed = Number(st.failed) || 0
        var note = st.note ? '（' + String(st.note).slice(0, 40) + '）' : ''
        if (!made) { toast('没有可抽的 PDF' + (failed ? '（失败 ' + failed + ' 份）' : '') + note, 4200); return }
        toast('已抽出 ' + made + ' 份文本' + (failed ? '，' + failed + ' 份失败' : '') + note, 3200)
        reloadListQuiet().then(function () { return select(c.folder) })
      })
      .catch(function () {
        // 单次丢包不算失败：接着轮，连续 40 次才认输（之前一次丢包就 toast 失败）
        if (n >= 40) {
          stopExtractPoll()
          if (btn) { btn.disabled = false; btn.textContent = extractBtnText(c) }
          toast('抽文字：进度接口没应答（已试 ' + n + ' 次）；抽完的那份会自己出现在列表里', 5200)
          return
        }
        EX_POLL = setTimeout(function () { extractPoll(c, n + 1) }, 1200)
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
  // 玩法中文名：本地小表，不从 util.js 引别的东西（那会牵动别的模块）；未知玩法原样显示 id。
  var SCHEME_CN = {
    soup: '海龟汤',
    detective: '侦探推理',
    escape: '密室逃脱',
    party: '剧本杀·反转',
    loop: '时间循环',
    council: '王国议会',
    trpg: '单人跑团'
  }
  function schemeCn(scheme) {
    var k = String(scheme == null ? '' : scheme).trim()
    return SCHEME_CN[k] || k
  }
  function contentCard(it) {
    return '<div class="mode is-content" data-folder="' + esc(it.folder) + '" role="button" tabindex="0" title="按这份资料开一局材料局">' +
      '<button class="ar-kill" type="button" data-kill="' + esc(it.folder) + '" title="从内容库移除">×</button>' +
      (it.scheme === 'soup' && Number(it.files) >= 4
        ? '<button class="ar-split" type="button" data-split="' + esc(it.folder) + '" title="按场景拆成一条一碗汤（合集用）">拆分</button>'
        : '') +
      '<span class="mode-no">材料 ' + esc(it.id) + ' / ' + esc(schemeCn(it.scheme)) + '</span>' +
      '<span class="mode-name">' + esc(it.title) + '</span>' +
      '<span class="mode-line">' + esc(it.note || '主持人照这份资料现编现裁') + '</span>' +
      '<span class="mode-tag" title="' + arcTag(it) + '">' + arcTag(it) + '</span>' +
      '</div>'
  }
  return {
    renderCase: renderCase,
    renderPack: renderPack,
    renderScreen: renderScreen,
    refreshActiveScreen: refreshActiveScreen,
    contentCard: contentCard,
    caseMetaOf: caseMetaOf,
    runPackReview: runPackReview,
    packRecompute: packRecompute,
    packFill: packFill,
    packUndo: packUndo,
    runPackPlaytest: runPackPlaytest,
    gotoAiFill: gotoAiFill,
    preview: preview,
    previewUrl: previewUrl,
    closeViewer: closeViewer,
    reveal: reveal,
    loadScreen: loadScreen,
    VERDICT: VERDICT
  }
}
