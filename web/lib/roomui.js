/* 材料局的纯渲染块：从 web/room.js 原样搬出（字符串拼装逐字未改），只吃入参 ——
   不读 DOM、不碰页面 state、不发请求、不 toast。表与函数原来读模块级变量，
   搬出后改成入参（titleOf 吃那一本的 entry、msgHtml 吃一条消息、chipsHtml 吃提示数组）。 */
import { esc } from './util.js'

export var SCHEME_NAME = { soup: '海龟汤', detective: '侦探推理', escape: '密室逃脱', party: '剧本杀', loop: '时间循环', council: '王国议会', trpg: '单人跑团' }
export var HINTS = {
  soup: ['这事跟家里人有关吗？', '他死之前见过谁？', '我猜汤底是……'],
  detective: ['勘查现场', '找嫌疑人谈谈', '我大概知道是谁了'],
  escape: ['环顾四周', '检查门锁', '翻翻桌面'],
  party: ['当众说清我的不在场证明', '私下找TA谈谈', '要求搜证'],
  loop: ['先去出事的地方看看', '今天我要拦住TA', '把知道的记下来'],
  council: ['国库现在有多少？', '这项提案谁反对？', '本季就按这个办'],
  trpg: ['潜行接近', '检查装备和状态', '找人打听目标'],
}

// 页头标题：两段都可能是空（材料局没起名 / scheme 认不出）。先收集非空段再 join，
// 否则会剩下一个孤零零的「·」。全空时给一句「材料局」。
export function titleOf(it) {
  var segs = []
  var t = it && it.title ? String(it.title) : ''
  var raw = it && it.scheme ? String(it.scheme) : ''
  var s = raw ? (SCHEME_NAME[raw] || raw) : ''
  if (t) segs.push(t)
  if (s) segs.push(s)
  return segs.join(' · ') || '材料局'
}

export function msgHtml(m) {
  var who = m.who === 'me' ? '你' : (m.who === 'sys' ? '系统' : '主持人')
  return '<div class="mr-msg is-' + esc(m.who) + '"><span class="mr-who">' + who + '</span><div class="mr-text' + (m.wait ? ' is-wait' : '') + '">' + esc(m.text) + '</div></div>'
}

export function logListHtml(list) {
  return list.map(function (m) { return msgHtml(m) }).join('')
}

export function chipsHtml(h) {
  return h.map(function (t) {
  return '<button class="mr-chip" type="button" data-t="' + esc(t) + '">' + esc(t) + '</button>'
  }).join('')
}
