/* 游戏厅对局室的纯渲染块：从 web/arcade.js 原样搬出（字符串拼装逐字未改），只吃入参 ——
   不读 DOM、不碰页面 state、不发请求、不 toast。参数 S / MODE 就是页面里的那份对局状态
   与玩法对象：原函数直接读模块级同名变量，搬出后改成同名入参，函数体因此可以逐字不动。 */
import { esc } from './util.js'

// 每种玩法的辅助面：笔记全都有，表格按玩法定列
export var AUX = {
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

export function tablesOf(MODE) { return AUX[MODE ? MODE.id : ''] || [] }

export function resultText(tool, r) {
  if (!r || typeof r !== 'object') return String(r == null ? '（引擎没有返回）' : r)
  if (Array.isArray(r.lines) && r.lines.length) return r.lines.join('\n')
  if (typeof r.text === 'string' && r.text !== '') return r.text
  if (typeof r.result === 'string' && r.result !== '') return r.result
  try { return JSON.stringify(r, null, 1) } catch (e) { return '（返回看不懂）' }
}

export function metaOf(tool, r) {
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

export function logHtml(log) {
  if (!log.length) {
    return '<div class="ar-wait">正在开局……引擎在牌堆里摸一张命运。</div>'
  }
  return log.map(function (e) {
    var t = e.at ? new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''
    if (e.kind === 'me') return '<div class="ar-me"><b>' + esc(e.label) + '</b><span>' + esc(e.text) + '</span></div>'
    if (e.kind === 'sys') return '<div class="ar-sys"><span>' + esc(e.text) + '</span></div>'
    return '<div class="ar-eng"><div class="ar-eng-h">' + esc(e.label || '引擎') + ' <em>' + esc(t) + (e.meta ? ' · ' + esc(e.meta) : '') + '</em></div><p>' + esc(e.text) + '</p></div>'
  }).join('')
}

export function chipsHtml(S, MODE, ACT) {
  if (S.ended) {
    return '<div class="ar-end">这一局结束了 —— 上面有引擎的终局结算。想再来，点上方「重新开一局」。</div>'
  }
  if (!S.started) { return '<div class="ar-end">开局指令发出去了，等引擎把简报摊开……</div>' }
  var acts = MODE.actions || []
  var chips = acts.map(function (a, i) {
    return '<button type="button" class="ar-chip' + (i === ACT ? ' is-on' : '') + (a.end ? ' is-end' : '') + '" data-act="' + i + '">' + esc(a.label) + '</button>'
  }).join('')
  return '<div class="ar-chips">' + chips + '</div><div class="ar-form" id="ar-form"></div>'
}

// 一个字段算不算「真下拉」：type=select 且 options 是非空数组。渲染与提交共用这一套判断。
// 背景：宿主以前把某一局的地名写死在 options 里，选项和玩法对不上（「上面下面没对上」）。
export function selectOpts(f) {
  if (!f || f.type !== 'select' || !Array.isArray(f.options)) return []
  return f.options.filter(function (o) { return o != null && String(o) !== '' })
}
export function isSelectField(f) { return selectOpts(f).length > 0 }

export function formHtml(a) {
  if (!a) return ''
  var fields = (a.fields || []).map(function (f) {
    // 只有 options 非空才画原生 select；缺/空的 select 落到下面那条文本输入（占位写「输入名称」）
    if (isSelectField(f)) {
      return '<label class="ar-field"><span>' + esc(f.label) + '</span><select class="ar-in" data-k="' + esc(f.k) + '">' +
        selectOpts(f).map(function (o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>' }).join('') + '</select></label>'
    }
    if (f.type === 'area') {
      return '<label class="ar-field wide"><span>' + esc(f.label) + '</span><textarea class="ar-in" rows="3" data-k="' + esc(f.k) + '" placeholder="' + esc(f.ph || '') + '"></textarea></label>'
    }
    // 其余全走文本输入：被降级的 select 没有 ph 时给一句「输入名称」，别留空占位
    return '<label class="ar-field"><span>' + esc(f.label) + '</span><input class="ar-in" type="text" data-k="' + esc(f.k) + '" placeholder="' + esc(f.ph || (f.type === 'select' ? '输入名称' : '')) + '" /></label>'
  }).join('')
  return fields +
    '<div class="ar-go"><button type="button" class="' + (a.end ? 'primary is-end' : 'primary') + '" id="ar-send"' + (a.end ? ' data-confirm="1"' : '') + '>' + esc(a.label) + '</button>' +
    (a.end ? '<span class="ar-endhint">终局动作：交出去就收不回来</span>' : '') + '</div>'
}

export var HINT_LIMIT = 24

export function hintSections(S) {
  var h = S && S.hints
  return h && Array.isArray(h.sections) ? h.sections : []
}
export function hintTotal(S) {
  var n = 0
  hintSections(S).forEach(function (s) { if (s && Array.isArray(s.items)) n += s.items.length })
  return n
}

// 汤面块（只海龟汤有）：汤面是谜面，摆右侧一进来就能看到，不用在对话里翻
export function soupBlock(S, MODE) {
  if (!MODE || MODE.id !== 'soup' || !S) return ''
  var s = S.clues && S.clues.surface ? String(S.clues.surface) : ''
  var st = S.cluesState || 'idle'
  var body
  if (s) body = '<div class="ar-soup-t">' + esc(s) + '</div>'
  else if (st === 'fail') body = '<div class="ar-soup-t ar-soup-empty">汤面还没取到 —— 点下面的「刷新提示」再试</div>'
  else body = '<div class="ar-soup-t ar-soup-empty">正在取这局的汤面…</div>'
  return '<div class="ar-soup">' +
    '<div class="ar-table-h"><b>汤面</b><em>要还原的故事</em>' +
    '<button type="button" class="ar-hint-refresh">刷新提示</button></div>' +
    body +
    '<div class="ar-soup-k">问「是/否」问题；命中汤底才会点亮下面的线索。串通了就点「猜汤底」。</div>' +
    '</div>'
}

// 提示块：idle/loading 一行灰字，fail 一行灰字（重点右边刷新），ok 且没有条目时整块不出现
export function hintBlock(S, MODE) {
  if (!MODE || !S) return ''
  var st = S.hintsState || 'idle'
  var total = hintTotal(S)
  if (st === 'ok' && !total) return ''      // 宿主不认这一档 / 这局没有可查的：整块不渲染
  var html = '<div class="ar-hints">' +
    '<div class="ar-table-h"><b>能查什么</b><button type="button" class="ar-hint-refresh">刷新提示</button></div>'
  if (st === 'ok') {
    var w = S.hints && S.hints.where
    var wn = w && (w.name || w.id) ? String(w.name || w.id) : ''
    if (wn) html += '<div class="ar-hint-where">你现在在：' + esc(wn) + '</div>'
    var left = HINT_LIMIT
    hintSections(S).forEach(function (s) {
      if (!s || !Array.isArray(s.items) || !s.items.length || left <= 0) return
      var chips = s.items.slice(0, left).map(function (it) {
        if (!it) return ''
        var nm = String(it.name == null ? '' : it.name)
        var sub = it.sub == null ? '' : String(it.sub)
        left--
        // 占位条目 = 还没发现的东西：只画方块、不给名字、不可点（点了也没法填进输入框）
        if (it.ph) {
          return '<span class="ar-hint-chip is-ph" aria-hidden="true">' +
            '<span class="ar-hint-name">' + esc(nm) + '</span>' +
            (sub ? '<span class="ar-hint-sub">' + esc(sub) + '</span>' : '') +
            '</span>'
        }
        return '<button type="button" class="ar-hint-chip" data-k="' + esc(s.key || '') + '" data-name="' + esc(nm) + '" title="' + esc(sub || nm) + '">' +
          '<span class="ar-hint-name">' + esc(nm) + '</span>' +
          (sub ? '<span class="ar-hint-sub">' + esc(sub) + '</span>' : '') +
          '</button>'
      }).join('')
      if (!chips) return
      html += '<div class="ar-hint-row"><span class="ar-hint-label">' + esc(s.label || '') + '</span>' + chips + '</div>'
    })
    if (total > HINT_LIMIT) html += '<div class="ar-hint-more">…还有 ' + (total - HINT_LIMIT) + ' 个</div>'
  } else if (st === 'fail') {
    html += '<div class="ar-hint-row ar-hint-wait">提示取不到（点右边刷新）</div>'
  } else {
    html += '<div class="ar-hint-row ar-hint-wait">正在看这局能查什么…</div>'
  }
  return html + '</div>'
}

// 线索卡片区：标题 / 卡片 / 终局物名全部来自宿主响应，前端零玩法分支、绝不自造卡文案
export function clueBlock(S) {
  var c = S.clues
  // 没数据也要占一块：以前直接 return ''，整块从面板上消失，用户分不清「正在取」「取不到」「这本没有线索卡」
  if (!c || !Array.isArray(c.cards)) {
    var bad = S.cluesState === 'fail'
    return '<div class="ar-clues"><div class="ar-table-h"><b>线索卡</b></div>' +
      '<div class="ar-clue-empty">' + (bad ? '线索卡取不到（点「辅助面板」重试）' : '线索卡正在取…') + '</div></div>'
  }
  var lit = typeof c.lit === 'number' ? c.lit : c.cards.filter(function (k) { return k && k.on }).length
  var total = typeof c.total === 'number' ? c.total : c.cards.length
  var html = '<div class="ar-clues">' +
    '<div class="ar-table-h"><b>' + esc(c.title) + '</b><em>已点亮 ' + lit + '/' + total + '</em></div>' +
    '<div class="ar-clue-list">' + c.cards.map(function (k, i) {
      if (k && k.on) return '<div class="ar-clue is-on">' + esc(k.text) + '</div>'
      return '<div class="ar-clue">线索 ' + (i + 1) + '（未发现）</div>'
    }).join('') + '</div>'
  if (c.complete && !S.unlocked) html += '<button type="button" class="ghost sm ar-unlock">🔓 ' + esc(c.endTitle || '揭晓结局') + '</button>'
  if (S.unlocked && S.ending) html += '<div class="ar-ending">' + esc(S.ending) + '</div>'
  return html + '</div>'
}

export function tablesHtml(list) {
  return list.map(function (t) {
    var rows = t.rows
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
}

export function sideBodyHtml(S, MODE, tables) {
  return '<div class="ar-side-k">辅助 · ' + esc(MODE ? MODE.name : '') + '</div>' +
    '<div class="ar-note-k">笔记 · 记事情（自动存）</div>' +
    '<div class="ar-note-slot"></div>' +
    hintBlock(S, MODE) +
    soupBlock(S, MODE) +
    clueBlock(S) +
    tablesHtml(tables)
}
