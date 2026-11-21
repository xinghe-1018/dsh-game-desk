#!/usr/bin/env node
/**
 * dsh-xgame 补丁：密室逃脱的「发现制」记录（2026-11-20）
 *
 * 干什么：examine 命中 prop / item / door 时把 id 记进 state.examined = { props, items, doors }，
 * 新建对局的初始 state 也带这个字段。插件侧 lib/pure/hints.mjs 的 hintEscape 据此只列
 * 「玩家真的碰过」的东西，没碰过的只给占位方块（用户 2026-11-20 要求别把房间清单当剧透摊开）。
 *
 * 用法：node patch-xgame-seen.cjs [--dry] [--file <dist/index.js>]
 *   --dry   只校验锚点，不写盘（默认行为，写盘要显式 --apply）
 *   --apply 真的改文件（改了会先备份 index.js.bak-seen-<时间戳>）
 * 幂等：已经打过就报 ALREADY-PATCHED 并退出 0。
 * 注意：agent 的 pwsh 子进程是 Low IL，写 node_modules 会 EPERM —— 用普通终端或宿主文件工具跑。
 */
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const dry = !args.includes("--apply");
const fi = args.indexOf("--file");
const file = fi >= 0 ? args[fi + 1] : path.join(process.env.USERPROFILE || "", ".dsh", "profiles", "desktop", "node_modules", "dsh-xgame", "dist", "index.js");

const PATCHES = [
  {
    id: "noteSeen-helper",
    anchor: "function examine(scenario, state, target) {",
    repl: [
      "function noteSeen(state, kind, id) {",
      '  const key = String(id ?? "");',
      '  if (key === "") return;',
      '  if (state.examined === void 0 || state.examined === null || typeof state.examined !== "object") state.examined = { props: [], items: [], doors: [] };',
      "  const box = state.examined;",
      "  if (!Array.isArray(box[kind])) box[kind] = [];",
      "  if (!box[kind].includes(key)) box[kind].push(key);",
      "}",
      "function examine(scenario, state, target) {",
    ].join("\n"),
  },
  {
    id: "seen-prop",
    anchor: "if (props.length === 1) {\n    const prop = props[0];",
    repl: 'if (props.length === 1) {\n    const prop = props[0];\n    noteSeen(state, "props", prop.id);',
  },
  {
    id: "seen-item",
    anchor: 'if (items.length === 1) {\n    return { result: "success", text: `${items[0].name}:${items[0].desc}',
    repl: 'if (items.length === 1) {\n    noteSeen(state, "items", items[0].id);\n    return { result: "success", text: `${items[0].name}:${items[0].desc}',
  },
  {
    id: "seen-door",
    anchor: "const door = doors[0];\n    const open = state.openDoors.includes(door.id);",
    repl: 'const door = doors[0];\n    noteSeen(state, "doors", door.id);\n    const open = state.openDoors.includes(door.id);',
  },
  {
    id: "init-escapeEngine",
    anchor: "      puzzleHints: {}\n    };",
    repl: "      puzzleHints: {},\n      examined: { props: [], items: [], doors: [] }\n    };",
  },
  {
    id: "init-other",
    anchor: "    puzzleHints: {}\n  };",
    repl: "    puzzleHints: {},\n    examined: { props: [], items: [], doors: [] }\n  };",
  },
];

if (!fs.existsSync(file)) {
  console.error("找不到 dist：" + file);
  process.exit(2);
}
let src = fs.readFileSync(file, "utf8");
const before = Buffer.byteLength(src, "utf8");
const done = [];
const skip = [];
for (const p of PATCHES) {
  if (src.includes(p.repl)) { skip.push(p.id); continue; }
  const n = src.split(p.anchor).length - 1;
  if (n !== 1) { console.error(`[${p.id}] 锚点命中 ${n} 次（要求恰好 1）—— 引擎版本变了，别硬打`); process.exit(3); }
  src = src.replace(p.anchor, p.repl);
  done.push(p.id);
}
const after = Buffer.byteLength(src, "utf8");
console.log("file      :", file);
console.log("applied   :", done.length ? done.join(", ") : "(无)");
console.log("skipped   :", skip.length ? skip.join(", ") : "(无)");
console.log("bytes     :", before, "->", after);
if (done.length === 0) { console.log("ALREADY-PATCHED"); process.exit(0); }
if (dry) { console.log("dry-run：不写盘（加 --apply 才改）"); process.exit(0); }
const bak = file + ".bak-seen-" + new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync(file, bak);
fs.writeFileSync(file, src, "utf8");
console.log("backup    :", bak);
console.log("PATCHED");
