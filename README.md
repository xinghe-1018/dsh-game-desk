# 案卷台 · dsh-game-desk

[![license: MIT](https://img.shields.io/badge/license-MIT-a63a2b.svg)](LICENSE)
[![dsh plugin](https://img.shields.io/badge/DSH-0.2.x-1a1710.svg)](package.json)

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 插件：把**剧本杀**和**游戏厅**搬进左侧入口栏。
选本、带本、按幕发人物剧本、AI 主持、白板复盘、局域网／公网同房，都在一个页面里完成。

> A DSH plugin that turns a folder of 剧本杀 (murder-mystery) cases into a playable table:
> per-act scenario pages, an AI host, an Obsidian-Canvas-style whiteboard, and LAN/public rooms.

---

## 它长什么样

左侧入口栏多出两行：

- **剧本杀** —— 本子库：档案页（人数／座位／类型／难度／体检结果）→ 开局 → 对局室。
- **游戏厅** —— 七种玩法：海龟汤 / 侦探推理 / 密室逃脱 / 剧本杀（反转）/ 时间循环 / 王国议会 / 单人跑团。

对局室有 8 个页签：

| 页签 | 内容 |
|---|---|
| 对局 | AI 主持（页内 DM），发线索、问、推进幕；右侧记笔记 |
| 引子 | 本子的开场与规则 |
| 正文 | 分幕故事 / 背景 |
| 人物剧本 | **按幕开放**：第 N 幕只给第 N 幕，且是原页图（可翻页看全） |
| 流程 | AI 排的带本大纲：每幕目标、在哪停下来讨论、何时发真相手册 |
| 白板 | 自由画板 + 卡片白板（拖、缩、七色、连线、导出 PNG），两种模式同一张纸 |
| 表格 | 自建表格：时间线模板（时间/人物/地点/做什么）或空白表 |
| 资料 | 线索、手册、PDF 原件；玩家视角会锁住剧透内容 |

## 功能

- **本子库 / 资料夹**：一个目录就是书库。有 `case.yml` 的是本子，没有的当资料夹（递归扫 PDF / 图片 / 文档，按子目录分组）。
- **导入**：把外面的资料夹（PDF、扫描件、图片）导成一本本子 —— 抽字、认角色、认线索、体检七条判据，缺什么如实列出来。
- **AI 试玩评测**：体检完还能让模型以玩家视角过一遍，回答「这本现在开得起来吗」。
- **按幕剧本页图**：`第 N 幕` 标题切页，每页用 PyMuPDF 渲成 JPEG 缓存；切不开幕的扫描件退化成「整份按页给图」，不会把你丢回 PDF 阅读器。
- **带本流程**：导入后让 AI 排一遍整场：哪一幕做什么、在哪里停、真相手册什么时候发。真相口径只给主持视角。
- **页内 DM**：主持人提示词拆成「静态前缀（整包资料）+ 每轮动态尾巴（当前幕、已发线索、玩家原话）」，换幕不换前缀，省 token 也更容易命中缓存。
- **白板**：2400×1500 世界 + 滚轮缩放 / 拖空白平移；卡片可拖动、改大小、七色、四边圆点拖连线（直线 + 终点箭头）；也能导出 PNG。画板模式左键画画，「✋ 拖动」切成指针（卡片一样能拖）。
- **房间**：本机 / 局域网 / 公网三级。公网走 cloudflared quick tunnel（失败自动退避重试、逐次换协议，最多约 3 分钟），访客一眼看到「有没有房、是哪一本、缺什么要素」，两个真人不能占同一个角色。
- **剧透保护**：玩家视角看别人剧本 / 流程 / 真相一律锁卡，切主持视角才展开。

## 快速开始

前置：**DSH 0.2.x**、Node ≥ 20。抽字与页图需要 Python（pypdf / PyMuPDF），OCR 与公网隧道可选，见「运行要求」。

```bash
git clone https://github.com/xinghe-1018/dsh-game-desk.git ~/.dsh/plugins/dsh-game-desk
```

在你 profile 的 `package.json` 里加一条 link 依赖，并把 id 写进 `dsh.profile.bundles`：

```jsonc
{
  "dependencies": {
    "dsh-game-desk": "link:C:/Users/<你>/.dsh/plugins/dsh-game-desk"
  },
  "dsh": { "profile": { "bundles": ["...", "dsh-game-desk"] } }
}
```

重启应用，左侧入口栏出现「剧本杀 / 游戏厅」两行，页面在 `/game-desk/app/`。

玩法本身依赖 `@max-null/dsh-jubensha`（本子与主持规则）与 `dsh-xgame`（游戏厅七玩法）。没装也能打开页面，只是游戏厅少几档、本子库要自己放。

### 放一本本子

```
$DSH_HOME/game-desk/cases/
└── 01-我的本子/
    ├── case.yml          # 结构化定义
    ├── _source/          # 原始 PDF / 图片（可选）
    └── _text/            # 抽出来的文本（导入时生成）
```

最小 `case.yml`（只写知道的，认不出的留白，页面会提示「缺什么」）：

```yaml
meta:
  id: my-case
  title: 我的本子
  players: 2
  genre: 推理
  difficulty: 2
scene:
  place: 老宅
  premise: 一句话背景
roles:
  - id: p1
    name: 程希
    player: 玩家一
    script: _source/程希.pdf     # 也可以指向 _text/ 里的 txt
```

其余字段（`truth` / `clues` / `phases` / `briefing` / `audit` / `reveal` …）都是可选的，写多少页面用多少。`@max-null/dsh-jubensha` 自带的 7 本会在首次启动时拷进 `cases/`，可以直接拿来对照。

没有现成的本子？把一包资料（PDF／图片／扫描件）放进任意目录，在页面里「＋ 目录」加进书库，点「导入剧本」——抽字、体检、缺项复核、AI 试玩一条链走完，认不出的项会列在档案页上。

## 目录结构

```
lib/
  index.js              宿主半：路由、书库、抽字、导入、体检、页图、流程、DM、房间、隧道
  client.js             DSH 侧桥（写进对话、重启等）
  script-pages.py       PyMuPDF 渲页 / --info 数页
  core/                 纯 IO 与解析：util / paths / names / yaml / text
  pure/                 纯函数：clues / hints / room
  services/             library / packs / scriptacts（切幕）/ textstore / usage
web/
  index.html  app.js    书库、档案页、游戏厅
  table.js             对局室（8 页签、白板、表格、DM）
  arcade.js  room.js    游戏厅页内对局 / 房间条
  lib/                  被拆出去的小模块（util / packview / listview / packdossier / roombar / arcadeui / roomui）
  style.css  library.css  arcade.css  table.css
tools/
  ocr.py  paddle_ocr.py OCR 入口与 PaddleOCR 封装
  patches/              对 dsh-xgame 的补丁脚本（按版本）
cordis.patch.yml        插件注入行（config: casesDir / seedFromJubensha / libraryRoots）
DEVELOPMENT.md          开发日志：每个需求的做法、实测数字、踩过的坑（很长，按需翻）
```

## 运行要求

| 能力 | 需要 | 没有会怎样 |
|---|---|---|
| 抽字（PDF → txt） | Python + pypdf（退 PyMuPDF） | 抽不出文字，档案页如实标「没抽出文字」 |
| 按幕页图 | Python + PyMuPDF | 退回 PDF 内嵌阅读器 |
| 扫描件 OCR | PaddleOCR（默认 GPU） | 扫描件只当图片看，不参与体检 |
| 公网房间 | `cloudflared` | 局域网／本机照常，公网按钮报「没装 cloudflared」 |
| AI 主持 / 流程 / 试玩 | 任一会话模型 | 这些按钮会提示需要模型；静态资料仍然能看 |

Python 默认在 PATH 里找；OCR 用的 venv 路径按本机约定探测，不匹配时在设置里改。页图与流程大纲都有磁盘缓存，重开不重算。

## 配置

插件配置（`cordis.patch.yml` 的 `config`）：

| 键 | 默认 | 作用 |
|---|---|---|
| `casesDir` | `$DSH_HOME/game-desk/cases` | 本子库（可写，新建的本子落这里） |
| `seedFromJubensha` | `true` | 首次启动把 jubensha 自带 7 本拷进来（只拷缺的） |
| `libraryRoots` | `[]` | 额外的书库目录；页面上「＋ 目录」写进 `$DSH_HOME/game-desk/library.json` |

运行时设置（`$DSH_HOME/game-desk/settings.json`，由页面上的开关写）：

- `lanEnabled` / `lanKey`（六位 hex）—— 局域网房间
- `remoteMode`（`off` / `quota` / `allow`）/ `remoteKey` —— 公网访客能做什么
- 公网隧道打开后地址写在这里，重启会重新分配

## 房间与安全

三级闸门，按来源判断：

- **本机**：浏览器直连，全部放行。
- **局域网**（`lanKey` 进门）：只读资料与页内 DM 放行；抽字、导入、重启、烧模型的批量操作要求 owner。
- **公网**（`remoteKey` + 房间在场 + `remoteMode`）：只读与「玩家自己那一份」放行，主持视角、真相、流程大纲一律锁。

所有文件接口都做路径守卫（只能读配置过的书库内文件），页图与缓存落在 `$DSH_HOME/game-desk/` 下，不写来源目录（网盘／只读目录也能玩）。

## 常见问题

**端口每次重启都变。** 本机地址看应用日志里的 `http://127.0.0.1:<port>/game-desk/app/`；局域网固定 5288，公网用隧道地址。写死的旧端口会 404。

**人物剧本只有文字/PDF，没按幕切。** 说明这份角色本没抽到文字（扫描件）或标题不是「第 N 幕」。前者会给「整份按页图」，后者按整份给。先在 `_text/` 里补文本或改标题，再重开。

**公网开房报 cloudflared 超时。** 点一次「开房」会自动重试 4 次 × 最多 3 轮（逐次换 quic → http2 → ipv4），页面显示「第 n / 4 次（第 N / 3 轮）」。三分钟仍失败就是真连不上，先查本机到 `api.trycloudflare.com` 的通路。

**玩家能看到真相吗？** 默认玩家视角：别人的剧本、流程、真相手册、主持笔记全部锁卡。要带本切「主持视角」。

**本子版权。** 仓库只含插件代码，不带任何剧本。`cases/` 里那 7 本是 `@max-null/dsh-jubensha` 自带的，版权归原作者。

## 开发

这份 README 只讲怎么用。**每个功能怎么做、为什么这么做、实测数字、踩过的坑**，都在 [DEVELOPMENT.md](DEVELOPMENT.md) —— 180KB 的中文开发日志，按需求编号组织，排障时先搜它。

改动分两层：`lib/` 是宿主半，改完要重启应用（或在有 plugin_manager 的会话里重载）；`web/` 是前端，刷新页面即生效。

## License

MIT © 2026 xinghe。插件代码与文档可自由使用；剧本杀本子（`case.yml`、PDF、线索图）版权归各自作者，不入库。
