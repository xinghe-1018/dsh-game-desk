// 给 dsh-xgame 0.1.2 的 dist 打「跨剧本硬编码」补丁（幂等：已打过的锚点会报 SKIP）
// 用法：node patch-xgame.cjs [--dry]
// 目标：node_modules/dsh-xgame/dist/index.js
// 注意：dist 里中文字面量多为 \uXXXX 转义，锚点必须写转义形态（本文件里以 \\u 表示）
//
// ⚠ 写入权限：node_modules 在 DSH 工作区保护之下，Low IL 子进程（agent 的 pwsh 工具）写不进去，
//   会报 EPERM。请用下面任一路径落地：
//   1) 在用户自己的普通终端（Medium IL）里跑本脚本；
//   2) 或用宿主文件工具（write/edit 工具）按本脚本的 9 个锚点手工替换。
//   升级 dsh-xgame 之后 dist 会被覆盖，重跑本脚本即可。当前 0.1.2 已打过（2026-11-20）。
const fs = require('fs')

const DRY = process.argv.includes('--dry')
const DIST = 'C:/Users/OMEN/.dsh/profiles/desktop/node_modules/dsh-xgame/dist/index.js'

let src = fs.readFileSync(DIST, 'utf8')
const before = src.length
const report = []

function sub(name, from, to) {
  const n = src.split(from).length - 1
  if (n === 0) {
    const m = src.split(to).length - 1
    if (m >= 1) { report.push('SKIP  ' + name + '（已是补丁后的样子）'); return }
    throw new Error('锚点未命中：' + name + '\n---\n' + from + '\n---')
  }
  if (n !== 1) throw new Error('锚点命中 ' + n + ' 次（应为 1）：' + name)
  src = src.replace(from, to)
  report.push('PATCH ' + name)
}

// ---------- 1. 战败回城：不再写死 frostpine ----------
sub('defeat-home-region',
  '  state.regionId = "frostpine";\n  state.combat = null;',
  '  state.regionId = homeId;\n  state.combat = null;')

sub('defeat-home-const',
  'function handleDefeat(script, state) {\n  const lost = Math.floor(state.character.gold * 0.1);',
  'function handleDefeat(script, state) {\n  const homeId = (script && script.startRegion) || (script && script.regions && script.regions[0] && script.regions[0].id) || state.regionId;\n  const homeRegion = (script && script.regions && script.regions.find((r) => r.id === homeId)) || null;\n  const lost = Math.floor(state.character.gold * 0.1);')

// ---------- 2. 战败文案：旅店名跟着剧本走 ----------
sub('defeat-text',
  '\\u5DF2\\u8EBA\\u5728\\u677E\\u9488\\u65C5\\u5E97\\u7684\\u5E8A\\u4E0A',
  '${homeRegion ? homeRegion.name : "旅店"}的床上')

// ---------- 3. 交还道具：不再硬写 obj_mold / 「铁匠的模具」 ----------
sub('give-helper',
  'function useItem2(script, state, itemKey) {',
  'function giveObjectiveOf(script, state, npc, item) {\n' +
  '  const open = [];\n' +
  '  for (const q of script.quests) {\n' +
  '    for (const o of q.objectives) {\n' +
  '      if (!state.questDone.includes(o.id)) open.push({ q, o });\n' +
  '    }\n' +
  '  }\n' +
  '  const hit = open.find(({ o }) => {\n' +
  '    const d = String(o.desc || "");\n' +
  '    return d.includes(npc.name) || d.includes(item.name);\n' +
  '  });\n' +
  '  return hit || open.find(({ q }) => q.type === "side") || null;\n' +
  '}\n' +
  'function useItem2(script, state, itemKey) {')

sub('give-questdone',
  '    state.questDone.push("obj_mold");',
  '    const gave = giveObjectiveOf(script, state, npc, item);\n    if (gave !== null) state.questDone.push(gave.o.id);')

sub('give-text',
  '    return `${item.use.text}(\\u83B7\\u5F97 20 \\u91D1\\u5E01;\\u4EFB\\u52A1\\u300C\\u94C1\\u5320\\u7684\\u6A21\\u5177\\u300D\\u5B8C\\u6210)`;',
  '    return `${item.use.text}(获得 20 金币${gave !== null ? `；任务「${gave.q.title}」完成` : ""})`;')

// ---------- 4. 跑团开场提示：不再写死「松针旅店的黄昏」 ----------
sub('brief7-start-region',
  'function buildBrief7(script, state) {\n  const regions = script.regions.map((r) => `- ${r.name}:${r.desc}`).join("\\n");',
  'function buildBrief7(script, state) {\n  const regions = script.regions.map((r) => `- ${r.name}:${r.desc}`).join("\\n");\n  const startPlace = (script.regions.find((r) => r.id === (script.startRegion || state.regionId)) || { name: script.title }).name;')

sub('brief7-prompt',
  '\\u7528\\u4E24\\u4E09\\u53E5 DM \\u53E3\\u543B\\u7684\\u5F00\\u573A\\u767D\\u63CF\\u8FF0\\u677E\\u9488\\u65C5\\u5E97\\u7684\\u9EC4\\u660F',
  '用两三句 DM 口吻的开场白描述${startPlace}的此刻')

// ---------- 5. 换皮：谜题名也要换（否则 solve 报「没有这个谜题」） ----------
sub('applySkin-puzzle-name',
  'const puzzles = scenario.puzzles.map((p) => ({ ...p, prompt: repl(p.prompt),',
  'const puzzles = scenario.puzzles.map((p) => ({ ...p, name: repl(p.name), prompt: repl(p.prompt),')

if (src.length === before) {
  console.log(report.join('\n'))
  console.log('NOCHANGE')
  process.exit(0)
}
if (DRY) {
  console.log(report.join('\n'))
  console.log('DRY-RUN ok, bytes ' + before + ' -> ' + src.length)
  process.exit(0)
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const bak = DIST + '.bak-xgamepatch-' + stamp
fs.copyFileSync(DIST, bak)
fs.writeFileSync(DIST, src)
console.log(report.join('\n'))
console.log('WROTE ' + DIST + '  bytes ' + before + ' -> ' + src.length)
console.log('BACKUP ' + bak)