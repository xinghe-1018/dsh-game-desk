#!/usr/bin/env node
/**
 * dsh-xgame 0.1.2 补丁：把「发现制」信号补到 detective / party / loop / council。
 *
 * 背景（2026-11-20，用户 m04715「不仅仅是密室逃脱，其他的也都这么做」）：
 *   游戏厅右侧「能查什么」面板原来把当前可交互对象全列出来 —— 没找到的东西也提前点名，
 *   等于替玩家剧透。密室逃脱已改成：引擎记录玩家真正碰过的对象，插件的 hint* 只列已发现的，
 *   其余给占位方块。这个脚本给另外四个玩法补上同样的记录点（插件侧 lib/pure/hints.mjs 已改）。
 *
 * 用法：
 *   node tools/patches/patch-xgame-discovered.cjs            # 只检查（默认 dry-run）
 *   node tools/patches/patch-xgame-discovered.cjs --apply    # 真正写盘（自动备份）
 *   node tools/patches/patch-xgame-discovered.cjs --apply --file <dist/index.js>
 *
 * 注意：agent 会话里的 pwsh 子进程是 Low IL，写 node_modules 会 EPERM —— 用普通终端跑，
 *       或用宿主文件工具按同样锚点手改。引擎升级（dsh-xgame 版本变化）后需重跑本脚本。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const fileArg = args.indexOf('--file')
const TARGET = fileArg >= 0
  ? args[fileArg + 1]
  : path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-xgame', 'dist', 'index.js')

/** 1 个 helper + 4 处 state 初始化 + 6 处记录点（锚点全为纯 ASCII，引擎里中文是 \uXXXX 转义） */
const EDITS = [
  {
    name: 'noteDiscovered-helper',
    find: 'function noteSeen(state, kind, id) {',
    repl: [
      'function noteDiscovered(state, kind, key) {',
      '  const k = String(key ?? "");',
      '  if (k === "") return;',
      '  if (state.examined === void 0 || state.examined === null || typeof state.examined !== "object") state.examined = {};',
      '  if (!Array.isArray(state.examined[kind])) state.examined[kind] = [];',
      '  if (!state.examined[kind].includes(k)) state.examined[kind].push(k);',
      '}',
      'function noteSeen(state, kind, id) {'
    ].join('\n')
  },
  {
    name: 'init-detective',
    find: 'theoryText: null,',
    repl: 'theoryText: null,\n      examined: { places: [] },'
  },
  {
    name: 'init-party',
    find: 'discussion: [],',
    repl: 'discussion: [],\n      examined: { places: [] },'
  },
  {
    name: 'init-council',
    find: 'bestChoices: 0',
    repl: 'bestChoices: 0,\n      examined: { advisors: [], disasters: [] }'
  },
  {
    name: 'init-loop',
    find: 'observed: [],',
    repl: 'observed: [],\n    examined: { places: [], targets: [] },'
  },
  {
    name: 'record-detective-place',
    find: 'if (location) {\n          const fresh = caseData.clues.filter((c) => c.location === location && !state.discoveredClues.includes(c.id));',
    repl: 'if (location) {\n          noteDiscovered(state, "places", location);\n          const fresh = caseData.clues.filter((c) => c.location === location && !state.discoveredClues.includes(c.id));'
  },
  {
    name: 'record-party-place',
    find: 'const fresh = caseData.clues.filter((c) => c.location === location && !state.discoveredClues.includes(c.id));\n        state.discoveredClues.push(...fresh.map((c) => c.id));\n        state.turns += 1;\n        await manager.update(game.sessionId, state);',
    repl: 'noteDiscovered(state, "places", location);\n        const fresh = caseData.clues.filter((c) => c.location === location && !state.discoveredClues.includes(c.id));\n        state.discoveredClues.push(...fresh.map((c) => c.id));\n        state.turns += 1;\n        await manager.update(game.sessionId, state);'
  },
  {
    name: 'record-loop-place',
    find: 'state.location = target.id;',
    repl: 'state.location = target.id;\n  noteDiscovered(state, "places", target.id);'
  },
  {
    name: 'record-loop-target',
    find: 'const lines = [inv.text];',
    repl: 'const lines = [inv.text];\n  noteDiscovered(state, "targets", state.location + "|" + inv.target);'
  },
  {
    name: 'record-council-advisor',
    find: 'const fact2 = script.facts.find((f) => f.id === factId);',
    repl: 'const fact2 = script.facts.find((f) => f.id === factId);\n    noteDiscovered(state, "advisors", advisor.id);'
  },
  {
    name: 'record-council-disaster',
    find: 'const prev = state.lastHidden[hiddenKey] ?? current;',
    repl: 'const prev = state.lastHidden[hiddenKey] ?? current;\n    noteDiscovered(state, "disasters", HIDDEN_LABEL[hiddenKey]);'
  }
]

function main () {
  if (!fs.existsSync(TARGET)) {
    console.error('找不到 ' + TARGET)
    process.exit(2)
  }
  const raw = fs.readFileSync(TARGET, 'utf8')
  const before = Buffer.byteLength(raw)
  let next = raw
  const report = []
  for (const e of EDITS) {
    if (next.includes(e.repl)) { report.push(['SKIP   ', e.name, '已打过']); continue }
    const hits = next.split(e.find).length - 1
    if (hits !== 1) { report.push(['FAIL   ', e.name, '锚点命中 ' + hits + ' 次（应为 1）']); process.exitCode = 1; return finish(report) }
    next = next.replace(e.find, e.repl)
    report.push(['PATCH  ', e.name, '已替换'])
  }
  if (process.exitCode) return finish(report)
  const changed = next !== raw
  for (const r of report) console.log(r[0] + ' ' + r[1] + ' — ' + r[2])
  if (!changed) { console.log('ALREADY-PATCHED'); return }
  console.log('dry-run: ' + before + ' -> ' + Buffer.byteLength(next) + ' bytes（加 --apply 才写盘）')
  if (!APPLY) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = TARGET + '.bak-discovered-' + stamp
  fs.copyFileSync(TARGET, bak)
  const tmp = TARGET + '.tmp-discovered-' + process.pid
  fs.writeFileSync(tmp, next, 'utf8')
  fs.renameSync(tmp, TARGET)
  console.log('written. backup = ' + bak)
}

function finish (report) {
  for (const r of report) console.log(r[0] + ' ' + r[1] + ' — ' + r[2])
  console.log('ABORTED（有锚点不唯一，未写盘）')
}

main()