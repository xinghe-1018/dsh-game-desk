// 书库列表（左侧列表 + 顶部筛片 + 资料夹标签）——从 app.js 搬出来的纯渲染层。
// 只搬不改：DOM 通过 deps.$ 拿，书库状态 deps.state 是 app.js 里同一个对象（引用共享，不复制）。
// 依赖 util.js / packview.js 的纯函数照旧 import（静态服务只认 .js，别写 .mjs）。
import { esc, playersLabel, caseNo } from './util.js'
import { metaLine, scanBadge, packTags, orderPacks } from './packview.js'

export function createListview(deps) {
  var $ = deps.$
  var API = deps.API
  var doc = deps.doc
  var refreshActiveScreen = deps.refreshActiveScreen
  var reloadListQuiet = deps.reloadListQuiet
  var select = deps.select
  var state = deps.state
  var tableSave = deps.tableSave
  var toast = deps.toast

  // ---------- 本子清单 ----------

  function haystack(c) {
    var bits = [c.title, c.id, c.folder, c.genre, (c.tags || []).join(' ')]
    if (c.kind === 'pack') bits.push((c.files || []).map(function (f) { return f.name }).join(' '))
    return bits.join(' ').toLowerCase()
  }

  function visible() {
    var q = state.q.trim().toLowerCase()
    return orderPacks(state.cases.filter(function (c) {
      if (state.filter !== 'all' && String(c.players) !== String(state.filter)) return false
      if (!q) return true
      return haystack(c).indexOf(q) >= 0
    }))
  }
  function renderChips() {
    var box = $('chips')
    if (!box) return
    var seen = {}
    var nums = []
    state.cases.forEach(function (c) {
      var n = Number(c.players)
      if (!(n > 0) || seen[n]) return
      seen[n] = 1
      nums.push(n)
    })
    nums.sort(function (a, b) { return a - b })
    Array.prototype.forEach.call(box.querySelectorAll('.chip[data-dyn]'), function (el) { el.parentNode.removeChild(el) })
    var prev = box.querySelector('.chip[data-filter="all"]') || null
    nums.forEach(function (n) {
      var b = doc.createElement('button')
      b.className = 'chip'
      b.setAttribute('type', 'button')
      b.setAttribute('data-filter', String(n))
      b.setAttribute('data-dyn', '1')
      b.textContent = playersLabel(n)
      if (prev) box.insertBefore(b, prev.nextSibling)
      else box.appendChild(b)
      prev = b
    })
    // 当前筛选的 chip 不在了（换书库等）就回「全部」；在就保持 is-on
    if (state.filter !== 'all' && !box.querySelector('.chip[data-filter="' + state.filter + '"]')) state.filter = 'all'
    Array.prototype.forEach.call(box.querySelectorAll('.chip'), function (el) {
      el.classList.toggle('is-on', el.getAttribute('data-filter') === state.filter)
    })
  }
  // ---------- 资料夹体检标签（用户 m01363，2026-11-19） ----------
  // 数据来自 /api/cases 里每条 pack 的 meta（宿主读 ~/.dsh/game-desk/pack-meta/<key>.json 一次性带回，
  // 不按行发请求）。没有 meta = 文字还没抽完、或抽在标签钩子上线之前 → 灰「未体检」并排到最后。
  // 样式写在 app.js 里：本单不许动 web/style.css / library.css。
  function ensurePackCss() {
    if (doc.getElementById('pack-tag-css')) return
    var st = doc.createElement('style')
    st.id = 'pack-tag-css'
    st.textContent = [
      '.pack-tags{display:contents}',
      '.pack-chip{display:inline-block;font-family:var(--mono);font-size:8.5px;letter-spacing:0.1em;padding:1px 4px;border:1px solid currentColor;border-radius:1px;opacity:0.7;white-space:nowrap}',
      '.pack-chip.is-full{color:var(--gold);opacity:1}',
      '.pack-chip.is-miss{border-style:dashed;opacity:0.55}',
      '.pack-chip.is-pvp{color:var(--stamp)}',
      '.pack-chip.is-pve{color:#2f7a55}',
      '.pack-chip.is-none{opacity:0.4}'
    ].join('\n')
    doc.head.appendChild(st)
  }
  // 「重算标签」：标签钩子上线前就扫完的旧本，一次性补算（后端只读文本缓存：不重抽、不启 OCR）。
  function recomputePackMeta() {
    var btn = $('btn-packmeta')
    if (!btn || btn.disabled) return
    var old = btn.textContent
    btn.disabled = true
    btn.textContent = '重算中…'
    fetch(API + '/packs/meta', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: state.root }),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '重算失败')
        toast('已给 ' + j.counted + ' 本打上标签' + (j.skipped && j.skipped.length ? '，' + j.skipped.length + ' 本还没抽出文字（跳过）' : ''), 3600)
        return reloadListQuiet().then(function () { return refreshActiveScreen() })
      })
      .catch(function (e) { toast('重算标签失败：' + e.message, 4200) })
      .then(function () { btn.disabled = false; btn.textContent = old })
  }
  // 顶栏不许多改（index.html 是别人在动的文件），按钮用 JS 插在「刷新」右边。
  function ensurePackTools() {
    ensurePackCss()
    var host = $('btn-refresh')
    if (!host || !host.parentNode || $('btn-packmeta')) return
    var b = doc.createElement('button')
    b.className = 'ghost sm'
    b.id = 'btn-packmeta'
    b.type = 'button'
    b.title = '给已经抽出文字的资料夹补算体检标签：只读文本缓存，不重新抽、不启 OCR。抽完文字的书会自己打标，这里只用于标签上线前就扫完的旧本。'
    b.textContent = '重算标签'
    b.addEventListener('click', recomputePackMeta)
    host.parentNode.insertBefore(b, host.nextSibling)
  }
  var LIST_KEY = ''
  function listKeyOf(list) {
    return String(state.root || '') + '|' + String(state.filter) + '|' +
      list.map(function (c) { return String(c.folder) }).join('\u0001')
  }
  function renderList() {
    var list = visible()
    var box = $('cases')
    var key = listKeyOf(list)
    if (key === LIST_KEY) {
      // 同一份列表：只切选中态，不重建 —— 每键一次 innerHTML 会把滚动位置和焦点一起冲掉
      Array.prototype.forEach.call(box.querySelectorAll('.case'), function (el) {
        el.classList.toggle('is-on', !!(state.active && state.active.folder === el.getAttribute('data-folder')))
      })
      $('count').textContent = list.length + ' / ' + state.cases.length + ' 项'
      if (list.length === 0 || box.firstChild) return
    }
    var keepTop = box.scrollTop
    if (list.length === 0) {
      box.innerHTML = '<div class="empty" style="margin:26px 8px;text-align:left"><p class="empty-k" style="font-size:16px">这里没有本子</p>' +
        '<p class="empty-l">换一个筛选，或点「＋ 目录」把别处的本子合辑加进来。</p></div>'
    } else {
      box.innerHTML = list.map(function (c) {
        return '<button class="case' + (state.active && state.active.folder === c.folder ? ' is-on' : '') + '" data-folder="' + esc(c.folder) + '" type="button" aria-label="打开本子：' + esc(c.title) + '">' +
          '<span class="case-no">' + esc(caseNo(c, state.root, state.cases)) + '</span>' +
          '<span class="case-body"><span class="case-title">' + esc(c.title) + '</span>' +
          '<span class="case-meta">' + ((c.warnings && c.warnings.length) ? '<span class="case-warn"></span>' : '') +
          '<span class="badge ' + (c.kind === 'pack' ? 'badge-pack' : (c.imported ? 'badge-import' : 'badge-case')) + '">' + (c.kind === 'pack' ? '资料夹' : (c.imported ? '导入本' : '本子')) + '</span>' +
          scanBadge(c) + packTags(c) +
          esc(metaLine(c)) + (tableSave(c) ? ' · 对局中' : '') + '</span></span>' +
          '</button>'
      }).join('')
    }
    LIST_KEY = key
    $('count').textContent = list.length + ' / ' + state.cases.length + ' 项'
    // 底栏跟随当前书库根：state.dir 从来没赋过值，恒显示字面量 undefined
    $('dirpath').textContent = state.root
    $('dirpath').title = state.root
    Array.prototype.forEach.call(box.querySelectorAll('.case'), function (el) {
      el.addEventListener('click', function () { select(el.getAttribute('data-folder')) })
    })
    // 重画完把滚动位置放回去（搜索时列表在脚下重组，视口不能跳回顶部）
    box.scrollTop = keepTop
  }
  return {
    render: renderList,
    renderChips: renderChips,
    visible: visible,
    listKeyOf: listKeyOf,
    ensurePackCss: ensurePackCss,
    recomputePackMeta: recomputePackMeta,
    ensurePackTools: ensurePackTools
  }
}
