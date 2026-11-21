// lib/services/usage.mjs —— 模型用量账本（$DSH_HOME/game-desk/model-usage.json）：记账 + 当日汇总。
// 无模块级可变状态、无插件单例：路径来自 core/paths 的 modelUsageFile，写盘走 tmp+rename 原子替换。
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { modelUsageFile } from '../core/paths.mjs'

export function todayLocal() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

export function recordModelUsage(source, sel, usage) {
  if (!usage) return null
  const input = Number(usage.inputTokens) || 0
  const output = Number(usage.outputTokens) || 0
  const total = Number(usage.totalTokens) || (input + output)
  const rec = { at: Date.now(), source, model: (sel && sel.provider ? sel.provider + '/' + sel.model : ''), input, output, total }
  if (usage.cacheReadTokens) rec.cacheRead = Number(usage.cacheReadTokens)
  let ledger = []
  try {
    const j = JSON.parse(readFileSync(modelUsageFile(), 'utf8'))
    if (!Array.isArray(j)) throw new Error('usage-ledger-not-array')
    ledger = j
  } catch (e) {
    // 2026-11-20（P2）：读失败不能一律当空账重写 —— ENOENT 才是真空账；
    // 解析失败/不是数组说明账本坏了：先把坏文件备份走再重置，别让一次坏读把历史用量抹掉。
    const code = String((e && e.code) || '')
    if (code !== 'ENOENT') {
      try {
        const bak = modelUsageFile() + '.bad-' + Date.now()
        copyFileSync(modelUsageFile(), bak)
        console.info('[game-desk] 模型用量账本读不出，已备份到 ' + bak + '：' + String((e && e.message) || e))
      } catch { /* 备份不成也只能重置，但至少留了日志 */ }
    }
    ledger = []
  }
  ledger.push(rec)
  if (ledger.length > 300) ledger = ledger.slice(-300)
  // 原子写（照 writePackMeta）：先写 .tmp 再 rename，别让半截 JSON 被下一次读成空账
  const file = modelUsageFile()
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(ledger), 'utf8')
    renameSync(tmp, file)
  } catch {
    try { rmSync(tmp, { force: true }) } catch { /* 清不掉就留着 */ }
  }
  return rec
}

/** 今日（本地日）合计：{ total, calls, bySource }。账本 ≤300 条，直接读。 */
export function todayModelUsage() {
  let ledger = []
  try { ledger = JSON.parse(readFileSync(modelUsageFile(), 'utf8')) || [] } catch { ledger = [] }
  if (!Array.isArray(ledger)) ledger = []
  const d = new Date(); d.setHours(0, 0, 0, 0)
  const from = d.getTime()
  const out = { total: 0, calls: 0, cacheRead: 0, bySource: {} }
  for (const r of ledger) {
    if (!r || Number(r.at) < from) continue
    out.total += Number(r.total) || 0
    out.cacheRead += Number(r.cacheRead) || 0
    out.calls += 1
    const k = String(r.source || '?')
    out.bySource[k] = (out.bySource[k] || 0) + (Number(r.total) || 0)
  }
  return out
}
