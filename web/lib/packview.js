/* 资料夹体检标签 / 缺项复核 / AI 补全那一批「纯 HTML 构造 + 纯排序」。
   原来长在 web/app.js 的 IIFE 里，2026-11-20 原样搬出来（渲染结果逐字不变）。
   唯一的行为参数化：LAST_REVIEW 与 state.root 不在模块作用域里，改成显式入参
   —— reviewOf(meta, folder, lastReview, root)、packReviewHtml/packAiFillHtml(c, meta, ctx)，
   ctx = { lastReview, root }。其余函数都是纯函数：同样的入参 → 同样的字符串。 */
import { esc, genreOf, diffOf, playersText, playersRange, fmtAt } from './util.js'

export function metaLine(c) {
  var bits = []
  // 有体检标签时人数由 .pack-tags 的 chip 出，这里不重复；抽不出人数（meta.players=0）仍回落到文件夹名里的人数
  // 区间（"1-4"）优先显示区间：那才是文件夹名/正文里真正写的人数范围
  if (c.players && (playersRange(c.players) || !(c.kind === 'pack' && c.meta && Number(c.meta.players) > 0))) bits.push(playersText(c.players))
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

// 扫描完成度小标（用户 m01290）：分子=缓存目录里非空 txt 数，分母=文档类全量，都算在宿主 scanned 里。
// 全扫完=实心「已扫描」，部分=灰「扫描 x/y」，0=不加标（列表别太吵）。pack 没有 caseDir，这里只给 title 提示；
// 补扫走档案页（导入本）的「识图补齐」按钮。
export function scanBadge(c) {
  if (c.kind !== 'pack' || !c.scanned || !c.scanned.total) return ''
  var d = c.scanned.done, t = c.scanned.total
  if (d >= t) return '<span class="badge badge-scanned">已扫描</span>'
  if (d > 0) return '<span class="badge badge-scan-part" title="本机识图已抽出 ' + d + '/' + t + ' 份文字；剩下抽不出字的，导入成本子后在档案页点「识图补齐」">扫描 ' + d + '/' + t + '</span>'
  return ''
}

// 一枚 chip 一句短文案；缺项清单不进行内（会挤爆），全塞进 title 属性（用户口径：用 title + 短文案）。
export function packTags(c) {
  // pack = 扫描资料夹；case = 导入本（2026-11-20 起宿主的 withPackMeta 也会给有 verdict/gaps 的导入本挂 meta）
  if (c.kind !== 'pack' && !(c.kind === 'case' && c.meta)) return ''
  var m = c.meta
  if (!m) {
    return '<span class="pack-tags"><span class="pack-chip is-none" title="这本还没有体检数据：文字还没抽完，或抽在「标签钩子」上线之前。抽完会自己打标；已扫完的旧本点书库栏「重算标签」补一次。">未体检</span></span>'
  }
  var out = []
  // 区间（c.players 形如 "1-4"）优先：区间是文件夹名/正文里的真值，meta.players 只是算出来的单数
  if (playersRange(c.players)) out.push('<span class="pack-chip" title="玩家人数区间（取自文件夹名 / 正文，和剧本杀页的人数筛选同一套判据）">' + esc(playersText(c.players)) + '</span>')
  else if (Number(m.players) > 0) out.push('<span class="pack-chip" title="玩家人数（取自原文 / 文件夹名，和剧本杀页的人数筛选同一套判据）">' + esc(m.players + ' 人') + '</span>')
  if (m.genre) out.push('<span class="pack-chip" title="类型取自原文的「剧本类型 / 题材」字段">' + esc(m.genre) + '</span>')
  // PVP/PVE 只对扫描资料夹有判定口径；导入本的 case.yml 里没有这一栏，别显示成「未标注」骗人。
  if (c.kind === 'pack') {
    if (m.pvp === 'pvp') out.push('<span class="pack-chip is-pvp" title="' + esc(m.pvpWhy || 'PVP') + '">PVP</span>')
    else if (m.pvp === 'pve') out.push('<span class="pack-chip is-pve" title="' + esc(m.pvpWhy || 'PVE') + '">PVE</span>')
    else out.push('<span class="pack-chip is-none" title="' + esc(m.pvpWhy || '原文没写 PVP/PVE，机制词也推不出来') + '">未标注</span>')
  } else if (m.genre === null || m.genre === undefined) {
    // 导入本至少给一句「这本为什么没类型」，否则标签看起来像缺了一块
    out.push('<span class="pack-chip is-none" title="case.yml 里没写类型；原文里有「剧本类型/题材」的话重导一次会补上">未标注类型</span>')
  }
  // 缺几项一律按宿主的 effective 算（AI 补过的不算缺，用户 2026-11-19）；旧回包由 packCompleteState 退回 missing。
  var st = packCompleteState(m)
  var aiN = st.aiN
  if (st.complete) {
    // 补全过的本子不能只写「全要素」：读者得知道这「全」里有几项不是原稿（用户 2026-11-19）。
    if (st.aiStyled) {
      out.push('<span class="pack-chip is-aifill" title="' + esc((aiN ? aiN + ' 项' : '有项') + '由 AI 补全，非原稿 —— 档案页的缺项那一栏能逐条撤销') + '">全要素(AI补)</span>')
    } else {
      out.push('<span class="pack-chip is-full" title="七条判据全过：可读文本 / 有手册 / 人数可判定 / 剧本对位 / 引子 / 线索 / 真相复盘">全要素</span>')
    }
  } else {
    var why = st.missEff.map(function (k) { return (k && (k.label || k.key) || '?') + (k && k.detail ? '：' + k.detail : '') }).join('；')
    if (why.length > 260) why = why.slice(0, 256) + '…'
    var leftTip = '缺 ' + st.left + ' 项' + (aiN ? '（另有 ' + aiN + ' 项已由 AI 补上，不算缺）' : '') + (why ? ' — ' + why : '')
    out.push('<span class="pack-chip is-miss" title="' + esc(leftTip) + '">缺 ' + st.left + ' 项</span>')
    if (aiN) out.push('<span class="pack-chip is-aifill" title="' + esc(aiN + ' 项由 AI 补全，非原稿 —— 档案页的缺项那一栏能逐条撤销') + '">AI 补 ' + aiN + ' 项</span>')
  }
  return '<span class="pack-tags">' + out.join('') + '</span>'
}

// 排序（用户 m01363）：全要素顶置 → 缺得越少越前 → 文件夹名兜底；没体检的沉底。
// 缺项数走 effective（用户 2026-11-19）：AI 补完之后这本当场往前挪。
export function packRank(c) {
  if (!c.meta) return [1, 0]
  return [0, missEffOf(c.meta).length]
}
// 只把 pack 自己占的槽位重排，剧本（case）行的相对顺序一个也不动（任务书：剧本区只按导入顺序/名称）。
export function orderPacks(list) {
  var slots = []
  var packs = []
  list.forEach(function (c, i) {
    if (c.kind === 'pack') { slots.push(i); packs.push(c) }
  })
  if (packs.length < 2) return list
  packs.sort(function (a, b) {
    var ra = packRank(a)
    var rb = packRank(b)
    return (ra[0] - rb[0]) || (ra[1] - rb[1]) || String(a.folder).localeCompare(String(b.folder), 'zh')
  })
  var out = list.slice()
  for (var i = 0; i < slots.length; i++) out[slots[i]] = packs[i]
  return out
}

export function aiFillItems(meta) {
  var f = meta && meta.aiFill
  var items = f && f.items && typeof f.items === 'object' ? f.items : null
  return items || {}
}
export function aiFillCount(meta) {
  var items = aiFillItems(meta)
  var n = 0
  for (var k in items) if (Object.prototype.hasOwnProperty.call(items, k)) n++
  return n
}
// 「还缺几项」与「算不算全要素」的口径统一走宿主的 effective（AI 补过的不算缺，用户 2026-11-19）。
// 旧回包没有 missingEffective / completeEffective 时退回 missing / complete，保证不白屏、不乱报缺。
export function missEffOf(meta) {
  if (!meta) return []
  if (Array.isArray(meta.missingEffective)) return meta.missingEffective
  return Array.isArray(meta.missing) ? meta.missing : []
}
export function packCompleteState(meta) {
  var m = meta || {}
  var missEff = missEffOf(m)
  var aiN = aiFillCount(m)
  var aiKeys = Array.isArray(m.aiFilledKeys) ? m.aiFilledKeys : []
  // 宿主的 aiComplete 语义是「没有有效缺项」（missingEffective.length === 0），跟 AI 一点关系都没有：
  // 拿它当「补过」的证据会把原稿齐全的本子标成「AI 补」（实测 1-4人本-不死之徒）。
  // 「全要素」的充分条件只认 completeEffective / complete；AI 样式只在真有补全条目时加。
  var complete = m.completeEffective === true || m.complete === true || (m.aiComplete === true && missEff.length === 0 && aiKeys.length === 0)
  var aiStyled = complete && (aiKeys.length > 0 || aiN > 0)
  return { complete: complete, aiStyled: aiStyled, missEff: missEff, left: missEff.length, aiN: aiN }
}
// 复核结果：优先用刚拿到的回包，其次读 meta.review（宿主写进去的，刷新后仍在）。
// reallyMissing 口径与宿主一致：只要不是 present 就算还得补（拿不准的也补）。
export function reviewOf(meta, folder, lastReview, root) {
  var memo = folder && lastReview ? lastReview[root + '|' + folder] : null
  if (memo && memo.verdicts) return memo
  var r = meta && meta.review
  if (!r || !Array.isArray(r.verdicts)) return null
  var rm = []
  var ps = []
  r.verdicts.forEach(function (v) {
    if (!v || !v.key) return
    if (v.verdict === 'present') ps.push(v.key)
    else rm.push(v.key)
  })
  return { at: r.at || '', model: r.model || '', verdicts: r.verdicts, reallyMissing: rm, present: ps, note: '' }
}
export function gdChip(v) {
  if (v === 'present') return '<span class="gd-vd is-present">原文里有</span>'
  if (v === 'missing') return '<span class="gd-vd is-missing">真缺</span>'
  return '<span class="gd-vd is-unclear">拿不准</span>'
}

// 缺项清单（资料夹本原本没有这一栏：packTags 只把条数塞进 title）。带 AI 补全徽标 + 撤销按钮。
export function packMissHtml(c, meta) {
  var miss = meta && Array.isArray(meta.missing) ? meta.missing : []
  if (!miss.length) return ''
  var items = aiFillItems(meta)
  var aiN = aiFillCount(meta)
  var rows = miss.map(function (m) {
    if (!m || !m.key) return ''
    var key = String(m.key)
    var filled = items[key] || null
    var cls = m.level === 'fail' ? ' is-fail' : (m.level === 'warn' ? ' is-warn' : '')
    var tail = filled
      ? '<div class="gd-tail"><span class="gd-ai" title="' +
          esc('AI 补全：' + (filled.file || '') + (filled.at ? ' · ' + fmtAt(filled.at) : '') + (filled.chars ? ' · ' + filled.chars + ' 字' : '') + '；不是原稿') +
          '">AI 补全</span>' +
        '<button class="gd-mini" type="button" data-gd-act="undo" data-gd-folder="' + esc(c.folder) + '" data-gd-key="' + esc(key) + '" data-gd-label="' + esc(m.label || key) + '" title="删掉 _ai_fill 里这一份，原稿不动">撤销</button></div>'
      : ''
    return '<div class="gap' + cls + '"><b>' + esc(m.label || key) + '</b>' +
      (m.detail ? '<span>' + esc(m.detail) + '</span>' : '<span></span>') + tail + '</div>'
  }).join('')
  // 清单照旧列全量（每行要靠 items[key] 画「AI 补全」徽标 + 撤销），只有「缺 N 项」这个数字走 effective。
  var left = missEffOf(meta).length
  var sub = ''
  if (left !== miss.length) sub = '<span class="gd-sub">清单 ' + miss.length + ' 条 · 已补 ' + (miss.length - left) + ' 条不算缺</span>'
  else if (aiN) sub = '<span class="gd-sub">其中 ' + aiN + ' 项是 AI 补的</span>'
  return '<div class="gaplist gd-miss" id="gd-miss"><div class="gaplist-k">缺项 <em>' + left + '</em>' + sub + '</div>' + rows + '</div>'
}

// 复核结果正文（刚跑完和读 meta.review 走同一套画法）。
export function reviewResultHtml(c, meta, r) {
  if (!r) return ''
  var folder = esc(c.folder)
  var head = '<div class="gd-rhead">' +
    (r.at ? '上次复核 ' + esc(fmtAt(r.at)) + (r.model ? ' · ' + esc(r.model) : '') : '刚复核完') + '</div>'
  var vs = r.verdicts || []
  if (!vs.length) {
    return head + '<p class="gd-line">体检现在没有缺项，不用复核。</p>'
  }
  var rows = vs.map(function (v) {
    var ev = v && v.evidence ? '<span class="gd-ev">「' + esc(v.evidence) + '」</span>' : ''
    return '<div class="gd-rrow">' +
      '<div class="gd-rline"><b>' + esc((v && (v.label || v.key)) || '') + '</b>' + gdChip(v && v.verdict) +
      (v && v.why ? '<span class="gd-why">' + esc(v.why) + '</span>' : '') + '</div>' + ev + '</div>'
  }).join('')
  var np = (r.present || []).length
  var keys = r.reallyMissing || []
  var nm = keys.length
  var unclear = vs.filter(function (v) { return v && v.verdict === 'unclear' }).length
  var after = ''
  if (np) {
    after += '<div class="gd-after"><button class="ghost sm" type="button" data-gd-act="recompute" data-gd-folder="' + folder + '">按复核结果重算标签</button>' +
      '<span class="gd-hint">有 ' + np + ' 项其实原文里就有 —— 重算只读文本缓存，不重抽、不启 OCR。</span></div>'
  }
  if (nm) {
    // 补全不再是「一个按钮补 M 项」：复核块只负责把人带到下面那张逐项表（用户 2026-11-19）。
    after += '<div class="gd-after"><button class="ghost sm" type="button" data-gd-act="gotofill" data-gd-folder="' + folder + '">到下面逐项补</button>' +
      '<span class="gd-hint">有 ' + nm + ' 项待补 —— 一次补一项、每项一次模型调用，写完立刻打「AI 补全」标记，可单独撤销；内容写到 <code>_ai_fill/</code>，不改原稿' +
      (unclear ? '（其中 ' + unclear + ' 项拿不准，也一起列进待补）' : '') + '。</span></div>'
  }
  return head + rows + after
}

export function packReviewHtml(c, meta, ctx) {
  if (!meta || meta.complete !== false) return ''
  var miss = Array.isArray(meta.missing) ? meta.missing : []
  if (!miss.length) return ''
  var aiN = aiFillCount(meta)
  var ai = meta.aiFill
  var aiLine = aiN
    ? '<div class="gd-aiinfo">已有 ' + aiN + ' 项 AI 补全' + (ai && ai.at ? '（' + esc(fmtAt(ai.at)) + '）' : '') +
      '，文件在资料夹 <code>_ai_fill/</code> 里；缺项那一栏能逐条撤销。</div>'
    : ''
  return '<div class="gaps-out gd-review" id="gd-review">' +
    '<div class="gd-head"><span class="gd-k">缺项复核</span>' +
      '<span class="gd-note">体检说缺不等于真缺：让模型对着原文核一遍，再决定要不要补。</span></div>' +
    aiLine +
    '<div class="gd-act"><button class="primary sm" type="button" data-gd-act="review" data-gd-folder="' + esc(c.folder) + '">AI 复核缺项</button>' +
      '<span class="gd-hint">会花一次模型调用；结果存进体检数据，下次进来直接看。</span></div>' +
    '<div class="gd-out" id="gd-review-out">' + reviewResultHtml(c, meta, reviewOf(meta, c.folder, ctx && ctx.lastReview, ctx && ctx.root)) + '</div>' +
    '</div>'
}

// 逐项补（用户 2026-11-19「AI 补全要逐项分开执行」）。
// 一项一个入口：点「补这项」只补这一项，写完立刻单独打「AI 补全」标记，可单独撤销。
// 并发策略：点下去先把整组「补这项」全部 disabled（一次只补一项，别让人连点把模型并发打满 / 重复计费）；
//   成功回来整页重画、按钮自然恢复，失败在 packFill 的 catch 里把整组恢复成可点。
// 缺项清单（packMissHtml）已经逐条画了「已补项」的徽标 + 撤销，所以缺项还在时这里只列待补项，
//   不重复画已补项；缺项全清掉之后（缺项清单整个不渲染）才由这里接手「已补 N 项 · 逐条撤销」。
export function packAiFillHtml(c, meta, ctx) {
  var items = aiFillItems(meta)
  var ks = Object.keys(items)
  var miss = meta && Array.isArray(meta.missing) ? meta.missing : []
  var folder = esc(c.folder)
  // 待补 = 缺项里还没补过的，再排掉「复核认定原文里就有」的那些 —— 补它们是白花一次模型调用；
  // 先把复核块里那颗「按复核结果重算标签」点了，它们就不算缺了（用户 2026-11-19 拍板）。
  var rev = reviewOf(meta, c.folder, ctx && ctx.lastReview, ctx && ctx.root)
  var present = rev && Array.isArray(rev.present) ? rev.present : []
  var todo = miss.filter(function (m) { return m && m.key && !items[m.key] })
  var pend = todo.filter(function (m) { return present.indexOf(String(m.key)) < 0 })
  var skipped = todo.length - pend.length
  var skipHint = skipped
    ? '<span class="gd-sub">复核说原文里有 ' + skipped + ' 项 —— 先点「按复核结果重算标签」就不用补它们了</span>'
    : ''
  if (pend.length) {
    var rows = pend.map(function (m) {
      var key = String(m.key)
      var label = m.label || key
      var d = m.detail ? String(m.detail) : ''
      if (d.length > 64) d = d.slice(0, 62) + '…'
      return '<div class="gap is-pend"><b>' + esc(label) + '</b><span>' + esc(d) + '</span>' +
        '<div class="gd-tail"><button class="gd-mini is-fill" type="button" data-gd-act="fill-one" data-gd-folder="' + folder +
          '" data-gd-key="' + esc(key) + '" data-gd-label="' + esc(label) +
          '" title="只补这一项：一次模型调用，写进 _ai_fill/，不改原稿">补这项</button></div></div>'
    }).join('')
    return '<div class="gaplist gd-aifill" id="gd-aifill"><div class="gaplist-k">逐项补 <em>' + pend.length + '</em>' +
      '<span class="gd-sub">一次一项，写完立刻打「AI 补全」标记，可单独撤销</span></div>' +
      (skipped ? ('<div class="gd-sub-line">' + skipHint + '</div>') : '') + rows + '</div>'
  }
  if (skipped) {
    // 剩下的待补项全被复核认定「原文里就有」：别留一块空白，也别再怂恿人去补。
    return '<div class="gaplist gd-aifill" id="gd-aifill"><div class="gaplist-k">逐项补 <em>0</em>' +
      '<span class="gd-sub">这本暂时没有需要补的项（复核说原文里都有）</span></div>' +
      '<div class="gap is-rest"><b>不用补</b><span>复核说剩下的 ' + skipped +
      ' 项原文里都有 —— 点复核块里的「按复核结果重算标签」，体检就会按原文重新算。</span></div></div>'
  }
  // 缺项清单还在（说明有已补项但还有别的缺项）时不重复画，撤销按钮在缺项那一栏里。
  if (miss.length || !ks.length) return ''
  var filled = ks.map(function (k) {
    var it = items[k] || {}
    var label = it.label || k
    return '<div class="gap is-ai"><b>' + esc(label) + '</b><span>' + esc(it.file || '') +
      (it.chars ? ' · ' + it.chars + ' 字' : '') + (it.at ? ' · ' + esc(fmtAt(it.at)) : '') + '</span>' +
      '<div class="gd-tail"><span class="gd-ai">AI 补全</span>' +
      '<button class="gd-mini" type="button" data-gd-act="undo" data-gd-folder="' + folder + '" data-gd-key="' + esc(k) + '" data-gd-label="' + esc(label) + '" title="删掉 _ai_fill 里这一份，原稿不动">撤销</button></div></div>'
  }).join('')
  return '<div class="gaplist gd-aifill" id="gd-aifill"><div class="gaplist-k">AI 补全 <em>' + ks.length + '</em>' +
    '<span class="gd-sub">不是原稿 · 存在资料夹 _ai_fill/</span></div>' + filled + '</div>'
}

// AI 试玩（用户 2026-11-20）：体检答「要素齐不齐」，这里答「这局开不开得起来」。
// 口径写死在宿主提示词里：缺项 ≠ 不能玩，六门里只要没有 broken 就算能玩（thin 只是「薄」）。
// op = { running, stale }：running 只画进行中那一行（别把旧结论留在屏幕上当新结果）。
var PT_CHIP = { playable: '能玩', risky: '能玩，但薄', unplayable: '开不起来了' }
export function playtestHtml(c, pt, op) {
  op = op || {}
  var folder = esc(c && c.folder)
  function head(extra) {
    return '<div class="pt-head"><span class="pt-k">AI 试玩</span>' + extra + '</div>'
  }
  if (op.running) return head('<span class="pt-now">正在替你把这一局走一遍…</span>')
  if (!pt) {
    return head('<span class="pt-chip">还没试玩</span>') +
      '<p class="pt-line">体检只说要素齐不齐；这里让它按「开本 → 发剧本 → 搜证 → 指认 → 复盘」走一遍，回答这局现在能不能开。缺项只要不卡流程，仍算能玩。</p>' +
      '<div class="pt-act"><button class="ghost sm" type="button" data-gd-act="playtest" data-gd-folder="' + folder + '">让 AI 试玩一遍</button>' +
      '<span class="pt-hint">一次模型调用；结论存进体检数据，材料没变就不再重复跑。</span></div>'
  }
  var v = (pt.verdict === 'playable' || pt.verdict === 'risky' || pt.verdict === 'unplayable')
    ? pt.verdict : (pt.canPlay ? 'risky' : 'unplayable')
  var chip = '<span class="pt-chip is-' + v + '">' + PT_CHIP[v] + '</span>'
  var stale = op.stale ? '<span class="pt-meta is-stale">体检内容变过，这是旧结论</span>' : ''
  var meta = '<span class="pt-meta">' + esc(fmtAt(pt.at)) + (pt.model ? ' · ' + esc(pt.model) : '') +
    (pt.missingN ? ' · 体检缺 ' + pt.missingN + ' 项' : '') + '</span>'
  var btn = '<button class="gd-mini" type="button" data-gd-act="playtest" data-gd-folder="' + folder +
    '" data-gd-force="1" title="强制再走一遍（材料没变时不会自动重跑）">重新试玩</button>'
  var gates = (pt.gates || []).map(function (g) {
    var st = (g && (g.state === 'ok' || g.state === 'broken')) ? g.state : 'thin'
    return '<span class="pt-gate is-' + st + '" title="' + esc((g && g.note) || '') + '">' +
      '<b>' + esc((g && (g.label || g.key)) || '') + '</b>' +
      (g && g.note ? '<i>' + esc(g.note) + '</i>' : '') + '</span>'
  }).join('')
  var blockers = (pt.blockers || []).map(function (b) {
    return '<div class="pt-block"><b>' + esc(b.what || '') + '</b>' +
      (b.need ? '<span>' + esc(b.need) + '</span>' : '') + '</div>'
  }).join('')
  var tips = (pt.tips || []).map(function (t) { return '<div class="pt-tip">' + esc(t) + '</div>' }).join('')
  return head(chip + stale + meta + btn) +
    '<p class="pt-line">' + esc(pt.why || '') + '</p>' +
    (gates ? '<div class="pt-gates">' + gates + '</div>' : '') +
    blockers + tips +
    '<div class="pt-hint">缺项不挡流程就算能玩：没标人数/难度/作者、线索没标条数，都只算「薄」。</div>'
}

// 第三参是可选的 title：认不出的 genre/difficulty 原文挂在上面，屏幕上看中文、悬停看原值
export function fact(k, v, t) {
  return '<div class="fact"><span>' + esc(k) + '</span><strong' + (t ? ' title="' + esc(t) + '"' : '') + '>' + esc(v || '—') + '</strong></div>'
}
