# dsh-game-desk（案卷台）

左侧入口栏两行：**剧本杀**（读 `@max-null/dsh-jubensha` 的本子库）与 **游戏厅**（`dsh-xgame` 的七种玩法）。

- 本子库：默认 `$DSH_HOME/game-desk/cases`，一个本子一个子目录 + `case.yml`。
  首次加载会把 jubensha 自带的 7 个本子拷进来（只拷缺的）。
- 开局：页面把开场指令交给对话输入框（`insertText`），回车即发；宿主半没有往会话说话的口子，
  所以"开一局"始终是用户按回车那一刻发生的。
- 路由：`/game-desk/app`（页面）、`/game-desk/api/cases|case|catalog`、`POST /game-desk/api/reveal`。

## 通用书库（不要求 case.yml）

一个「书库」= 一个装着子目录的目录。每个子目录算一件藏品：

- 有 `case.yml` → **本子**（kind=case），走结构化渲染：人数/座位/类型/难度/引子/开这一局。
- 没有 `case.yml` → **资料夹**（kind=pack），递归扫 3 层的 PDF / 图片 / 文档，
  按子目录分组（正文、人物剧本、线索…），能直接预览 PDF、点开图片、读抽出来的文本。

书库来源（按顺序合并，去重）：

1. 本子库 `$DSH_HOME/game-desk/cases`（可写，新建本子落这里；jubensha 的 7 个本子首次运行时拷进来）
2. 插件配置 `libraryRoots: []`
3. `$DSH_HOME/game-desk/library.json` 的 `roots`（页面左上「＋ 目录」写这里，持久保存）

### 抽出文本

资料夹里的 PDF 可以「抽文字」：宿主用 python 的 pypdf（不行再退 PyMuPDF）逐页抽，
得到的纯文本缓存在 `$DSH_HOME/game-desk/text/<root|folder 的 sha1 前 16>`，
**不写来源目录**（网盘/只读目录会在 mkdir 处 EPERM）。抽不出的（扫描件、字体加密）会在页面上单独提示。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/game-desk/app/?panel=jubensha|arcade&root=&case=&` | 页面（支持深链到某个书库/某本） |
| GET | `/game-desk/api/cases?root=` | 书库列表（root 必须在已配置的 roots 内） |
| GET | `/game-desk/api/case?root=&folder=` | 单件详情（pack 附 texts/textDir） |
| GET | `/game-desk/api/file?root=&folder=&rel=` | 只读取本子/资料夹里的原文件（路径守卫） |
| GET | `/game-desk/api/text?root=&folder=&rel=` | 取抽好的纯文本 |
| POST | `/game-desk/api/extract {root,folder}` | 抽这个资料夹里的 PDF/文本 |
| POST | `/game-desk/api/roots {root}` | 追加一个书库目录（写 library.json） |
| POST | `/game-desk/api/case {root,folder,id,title,…}` | 在指定书库里新建 `case.yml` |
| POST | `/game-desk/api/reveal {path}` | 资源管理器里打开（限已配置的书库内） |

## 导入与评判（把外面的资料夹变成档案页上的本子）

资料夹（pack）详情页有一块「体检」：选中就自动跑一遍评判，把**判据**摆在导入按钮上面，不是默默吞掉。
同一来源再导一次 = 刷新那一本（按来源目录认），不会多出第二本一样的。

七条判据（`screenPack`，全部指得回原文；认不出就判不过，不猜）：

| id | 判据 | 怎么判 | 不过的后果 |
|---|---|---|---|
| text | 抽出了可读文字 | 缓存文本 ≥ 800 字 | **硬闸**：verdict=blocked |
| manual | 有组织者手册 | 正文出现「组织者须知 / 主持人手册 / 组织者手册」，或文件名含之 | warn |
| players | 人数可判定 | `N 名玩家` / `N 男 M 女` | warn |
| roles | 角色可拆解 | 「名字（N 岁，M kg）」这种角色行 ≥ 2 | warn |
| premise | 引子可提取 | 有「故事背景」段 | warn |
| scripts | 人物剧本可对位 | 文件名含角色名的 PDF，且那些 PDF 抽得出字 | warn |
| clues | 线索有下落 | 「共有 N 条」/「线索卡（N 张）」/ 有线索文件 | warn |

verdict：有 fail → `blocked`（页面给「强行导入」，再确认一次才写）；有 warn → `partial`；全过 → `ready`。

导入（`importPack`）做的事：

1. 没有缓存文本时先 `extractPack` 抽一遍 —— 这样判据才是真的，而不是「没抽过所以判不过」；
2. 在本子库里取一个没占用的编号 `NN`，目录 `NN-<标题前 24 字>`；
3. 原始文件拷进 `_source/`（保留子目录），抽出的文本拷进 `_text/`；
4. 写 `case.yml`：meta（id/title/players/genre/difficulty/duration/tags/imported/source_*/verdict）、
   scene.premise、scene.setup（指出 _source / _text）、roles（取自 `spec.roles`，没有就按人数补「角色N」，
   `p0` 是 human、其余 ai，带 age/weight/script）；
5. 页面 toast 后自动切到本子库并选中这一本。

导入后的档案页多出：eyebrow 的「导入本」、来源条（来源目录 + 体检结论 chip）、
「原始资料」列表（`_source/` 全部文件，可预览）、「抽出的文字」列表（`_text/` 的 txt，可读）。
「开这一局」的指令里会多一句：先读 `_text/` 下的 txt，别去解析扫描件 PDF。

### 接口补两条

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/game-desk/api/screen?root=&folder=` | 七条判据 + verdict + detectSpec 抽到的 spec；已有 case.yml 的目录回 `verdict:ready, already:case` |
| POST | `/game-desk/api/import {root,folder,force?}` | 导入 / 刷新（同来源覆盖）；blocked 且不带 force 时 422，回 `{ok:false, screen}` |

实测（2026-11-19，D:/BaiduNetdiskDownload/双人本合集）：桐花那本 verdict=partial —— 15751 字、
4 人（2男2女）、四个角色名、引子 197 字、14 条线索（2 张卡）都对上了；只有「人物剧本可对位」warn：
4 份人物剧本 PDF 文件名对上角色，但都是扫描件 / 字体加密，pypdf 与 PyMuPDF 都抽不出字。
另外三本（不能说的秘密 / 彩虹酒吧 / 归途）16 份 PDF 一个字符都抽不出 → blocked，页面按钮变成「强行导入」。

## 排障心跳（客户端半）

客户端半活在渲染进程里，控制台看不到。每次 apply / 注册入口行都会 POST `/game-desk/api/beat`，
宿主在内存里留最近 60 条，`GET /game-desk/api/beats` 就能看到卡在哪一步：

`eval → apply(slots=present layout=present) → row-ok:jubensha-desk → row-ok:xgame-desk → panel-ok:…`

缺哪一步就说明断在哪；`row-fail` / `apply-fail` 会带上错误原文。宿主模块每次热重载会清空这份记录。

## OCR：扫描件 PDF 与线索图（2026-11-19 接入）

来源目录里常常只有扫描件（人大扫描、字库加密）。抽取链现在是三段：

1. `pypdf` 逐页抽文本（有文本层就直接成）；
2. 抽不出 → `tools/ocr.py --engine rapid`（RapidOCR + onnxruntime，CPU，约 3–4 秒/页）；
3. 仍抽不出 → `--engine vl`（Qwen3-VL-2B-Instruct，CUDA，慢，啃版式怪的页）。

整本几乎没字（<800 字）时，线索图（jpg/png）也会用 rapid 过一遍。

配置（profile 的 game-desk 行）：`ocrEngine: 'auto' | 'off'`、`ocrVlFallback: true`、`ocrImages: true`。

实测（桐花中路私立协济医院怪谈，10 个文件 / 4 份扫描版人物剧本 + 5 张线索图）：
抽出 5 份 PDF 共 22352 字，4 份人物剧本分别 1264–2275 字，总耗时 107 秒；
体检从 `partial`（6/7，scripts 红）变成 **ready（7/7）**。

解释器：`ocr.py` 自己会在候选里挑一个装了依赖的（`~/.dsh/tools/ocr-venv` → `whisper-venv`，vl 用 `gsv-venv`），
宿主半只负责起进程与拼文本，不猜环境。

## 开局留在页内（第三阶段）

- 两个页面的「开这一局」都走 `startGame()`：页内打开对局视图 `#match`（整页，不是对话框），**不再** `layout.selectPanel('conversation')`。
- 四步进度：装载本子 → 组装开局指令 → 写进对话并发出 → 交给会话接手；条形在第三步之后停在 86%，会话接手后走到 100%。右栏列出这次发给会话的指令原文。
- 回执协议（`lib/client.js`）：页面发 `{source:'game-desk', type:'fill', id, text, submit, ack:true}`；客户端填完回 `{source:'dsh-game-desk', type:'filled', id, ok}`。**带 ack 时不自动切面板**；页面想切时再发 `{type:'show-conversation'}`。不带 ack 的旧调用保持原行为（自动切回对话）。
- 页面单独打开（非 iframe）时无法回写会话：显示「不在应用里」，可复制指令。没收到回执时提示"旧版客户端会自己切走"，并提供切到对话的按钮。

## 导入剧本（顶栏「导入剧本」）

- `POST /api/peek {path}` 三种结果：`case`（已有 case.yml，直接打开）/ `dirs`（列出子目录供选择，点一个继续）/ `pack`（体检七条 + 文件清单 + 导入按钮）。
- 抽取是异步任务：peek 内部起 `startExtract` 后立刻返回，页面用 `GET /api/extract/status` 每 900ms 轮询；进度条显示秒数与成功/失败份数，抽完自动重扫一次。
- 导入成功后关弹层、刷新书库并选中新本子；同一来源再导一次会走 `updated:true` 覆盖 `_source/` 与 `_text/`，不会多出一本。

## 自由选择角色（m01937）

- 谁演谁不再是本子里写死的 `human`：**档案页的座位 chips 和「对局室」左栏的座位卡都能点**。
  - 档案页：点某个 `<button class="seat" data-me="i">` → `pickSeat(c, i)` 写存档并重画，chip 立刻变成红框「你」。
  - 对局室：每张座位卡下面的「我演这个」按钮 → `S.me = i`（`S.seat` 跟着走，人物剧本页签同步换人）；已经是你的时候按钮显示「你在演」。
  - 人物剧本页签顶部也有一条「我演这个」，看别人的本时能就地换人。
- 存档键与对局室共用：`localStorage['gd:table:<root>|<folder>']`，字段 `me`（-1 = 没选过，按本子的 human 标记）与 `seat`（正在看的座位）。
- 档案页与 `openingText` 都读同一个 `me`：座位 chips 的「你/AI」、以及「交给 AI 主持」时 `jubensha_state start` 的 `humanSeat` 与要 spawn 的 AI 座位，都跟着你选的人走。
- **顺手修掉一个老 bug**：`open()` 原来是 `S = Object.assign({root, folder}, load())`，而 `load()` 里的 `key()` 读 `S.root` —— 首次打开时 `S` 还是 null，`key()` 抛错被 `try/catch` 吞掉，于是**每次刷新都读不到存档**。改成先把 root/folder 放到 `S` 上再 `load()`，存档（席位、线索发放、笔记、计时）现在真的能跨刷新保留。

## 页内 DM（对局不回会话）

对局室默认打开「对局」页签：宿主 `POST /game-desk/api/dm` 直接用本体的 llm 服务当主持人，全程留在这一页。

- 资料注入：`dmContext()` 读 case.yml（24000 字）+ DM 手册（匹配 handbook/手册/主持/组织者/dm，12000 字）+ roles/*.md（每份 6000 字，≤8 份）；资料夹本读 `_text/` 或抽取缓存（≤6 份 ×12000 字）。资料只进 system 提示，规矩里写明「绝不允许原文念给玩家」。
- 模型选择：`ctx.get('agentDefaultModel', false).currentSelection()` → `ctx.get('llm', false).prepareCall({provider, model, maxTokens:1200})` → `call.stream()` 累加 text-delta。不硬编码模型，跟随右下角档位。实测 qwen3.8-flash 开场 3.7s、追问 3.4s。
- 主持规矩（写进 system）：一次一小步；AI 角色「名字：（神态）台词」每人每轮最多两句；不剧透但按人设应付追问；≤350 字结尾留钩子。幕次（上一幕/下一幕）进 system，玩家换演角色（meName）同步进 system。
- 前端：对局记录存 `gd:table:<root>|<folder>` 的 `chat` 字段，切页签/刷新不丢；发送失败会把玩家那句话退回输入框；`GET /api/dm/health` 探不到服务时提示改用「交给 AI 主持」。
- 修掉的三个 bug：① 上一幕/下一幕无反馈 → 标签变化 + toast；② 结构化本（.md/.txt 原件）读不出正文 → loadDoc 先直读原件；③ 资料点不出 → 同上；另修手册识别（dm-handbook）与角色剧本匹配（按 p0 这类角色 id 命中 p0-linmo.md）。
- Markdown 强调符：聊天气泡与文档正文渲染前剥 `**`/`__`。

「交给 AI 主持」仍在顶栏，作为显式出口（走会话 composer），不再是默认路径。

## 剧透保护（玩家视角 / 主持视角）

对局室默认「玩家视角」：选了角色之后，只看得到自己的本。

- 顶栏「玩家视角 / 主持视角」按钮切换（#tbl-mode，主持视角描金）；状态存 `gd:table:<root>|<folder>` 的 `mode` 字段，每本独立。
- 玩家视角下：「人物剧本」页签点别人的座位 → 剧透保护卡（「切到主持视角」一键可达，「我演这个」仍可直接换角色）；「正文」页签（DM 手册含真相）→ 同款锁卡；「资料」页签只列自己的本 + 公开文件，其余折叠成一句「藏起了 N 份」。
- 判定：isTruth（case.yml/handbook/手册/主持/组织者/复盘/真相/结局/dm）、isRole（roles/ 与人物剧本目录）、isClue（线索原件，发放走右栏线索面板）、手册同干（stem）匹配 `_text/` 里的副本、别人的角色名命中的任何文件。自己的本（seat.file.rel）永远放行。
- 主持视角 = 全部照旧摊开（线下自己带本用）；卡片文案提醒「屏幕别让同桌看见」。
- 案卷档案页（选角之前那页）不设锁 —— 它是主持人的资料台；对局中的防剧透面是对局室。
- 实测：01 拾光照相馆（正文/人物剧本/资料三处锁 + 切主持视角全开 + 切回重新锁）；08 桐花（扫描件 OCR 后自己的本可读，清秀女人锁卡，资料只剩 1 份 + 藏起 15 份提示）。

## 游戏厅页内对局室（不回会话）

点玩法卡不再发指令回会话，而是弹出全屏「对局室」（web/arcade.js + arcade.css），
引擎调用全部走宿主路由：

- `POST /game-desk/api/xgame` `{tool, scheme, sid, args}` —— 宿主经 dsh-tools 服务
  `executable(name).execute(args, {agent:{session:{id:sid},options:{provider,model}}})`
  直接调 dsh-xgame 的工具；provider/model 取 agentDefaultModel 当前档位。
- **sid 每局新生成**（`game-desk-<scheme>-<base36 时间>`）：xgame 在内存里也缓存对局，
  只删 `~/.dsh/storages/dsh-xgame/<sid>/` 不够；换 sid 就是换牌桌。「重新开一局」= 清旧目录 + 新 sid。
- `POST /api/xgame/narrate` `{text,name,soup,verdict}` —— 引擎输出是写给主持人模型的指令
  （含汤底/守则），页内一律再过一层 LLM 转述给玩家。soup 用专门的防泄底提示：
  只播裁决（verdict 显式传入，不让模型自己判是/否）+ 一句引导，60 字内。
  转述失败时退回原文并标「（原文）」。
- `POST /api/xgame/reset` `{scheme,sid}`。
- `GET /api/catalog` 每个 mode 带 `actions`（动作表：label/tool/fields/end）。

动作表在宿主 `XGAME_ACTIONS`：soup 2、detective 5、escape 6、party 7、loop 7、council 5、trpg 8。
**人名/区域每局随机**（跑团「海港疑云」的 NPC 就不是铁喉城寨那套），所以 detective/party/trpg
的对象一律是自由文本，引擎会纠正（「没有这个人。在场可选:…」）；loop/council 是固定剧本才用下拉。

存档 localStorage `gd:arcade:<scheme>`（log/started/ended/diff/sid）；URL 带 `?fresh=1` 清档重开。

## 对局室的四个修正（2026-11-19）

1. **对局页签不被座位打断**：三条路都查过 ——
   - 「我演这个」按钮：`stopPropagation` + 不改页签；
   - 座位卡名字区（外层）：`if (S.tab !== 'play') S.tab = 'roles'` —— 对局里点座位只是「在看谁」，不带走页签；
   - 存档污染：旧 bug 曾把 `tab:'roles'` 写进 localStorage，重开就落在人物剧本。现在 `open()` 永远把 `tab` 置回 `play`（「开/继续这一局」= 回到牌桌）。
   人物剧本页签里点别的座位仍然换人看本（玩家视角锁着），这是它自己的职责。
2. **收桌 = 停表**：时钟状态改为 `{ t0, accMs, running, lastSeen }`。点顶栏计时器走表/停表（停表后虚线框），收桌自动停表并把用时定格进存档；下次「继续这一局」看到的是静止数字，点一下才继续走。重新进入时按 `lastSeen` 折算 —— 关掉页面期间的空档不计入用时（旧存档里停表的数字保持不变，走表的会归正）。
3. **继续上次未完成的对局**：对局状态本来就按 `gd:table:<root>|<folder>` 存在 localStorage（幕次/线索/笔记/席位/对白/视角/计时）。现在档案页会显式提示：列表条目带「· 对局中」，主按钮变「**继续这一局**」，hint 追加「第 N 幕 · M 句对白 · 计时在走/已停表」。判定「未完」= 有对白 / 幕次>1 / 发过线索 / 写过笔记。
4. **「交给 AI 主持」不再回会话**：按钮改为页内动作 —— 切到「对局」页签；没有对白就当场调 `/api/dm` 让 DM 开场，已有对局就提示「就在这一页继续」。会话桥（handOverRaw）只保留在游戏厅的兜底路径里。

验证（浏览器实测）：01 拾光照相馆换席位后 `对局 is-on` 保持、气泡不丢；计时器点击后 77:34 冻结、收桌重开仍冻结；02 深夜电台新开局点「交给 AI 主持」5.2s 页内出完整开场。

## 导入本写出体检缺项（m02572）

有缺项的本（09-陶宅夜话这类）导入后，**缺什么要看得见**。三段：

1. **落盘**：`importCaseYml` 把 `screen.checks` 里 level ≠ ok 的项写成 case.yml 顶层 `gaps:` 段（id/label/level/detail），注释说明「重导同一资料夹会刷新」。体检全过的本不写这段。
2. **读回**：`parseCase` 新增 `gaps` 段解析（`- id:` 起条，label/level/detail 归位），`scanCases` 把 `gaps` 放进列表项 —— `/api/cases` 与 `/api/case` 自动带出。
3. **显示**：档案页 importBlock 之后渲染 `.gaplist`「体检缺项 · N 项 —— 不是拆不出来，是原文里就没这些」，warn 金色 / fail 印章红，尾注给补法（补文件进原资料夹，或让 AI 按已有正文补写人物剧本，再重导刷新）。

存量回填：对 `meta.source_folder` 重跑 `POST /api/import`（twin 去重原地更新）—— 09 已回填（4 项 warn），08 体检全过无缺项。

## 双人散放本的角色识别（m02692）

「双人本-陶宅夜话」这类本，人物剧本是**顶层散放、文件名即人名**（程希.pdf / 陶苏.pdf），正文里既没有「N 名玩家」也没有「名字（27 岁，55kg）」行 —— 旧 detectSpec 全认不出，importCaseYml 还兜底造了 4 个假座位。三处修好：

1. **人数**：detectSpec 认不出「N 名玩家」时退用 `playersGuess(folder)`（双人本→2、1-4人本→上限+区间注记）。
2. **角色**：screenPack 正文没角色行时，按文件名认角色 —— 排除 NON_ROLE（手册/组织者/真相/线索/答题/准备/复盘/封面…）后，2–12 字的文件名 stem 即角色名（≥2 人才算，标 `rolesFrom:'files'`，判据文案写「按文件名认出」）。人物剧本对位的文件池同步放宽：所有非 NON_ROLE 的 PDF 都进池，散放与「人物剧本/」分组两种形态都能配对。
3. **不造假人**：importCaseYml 兜底改成「players≥2 才按人数占位，否则 roles 留空」—— 认不出就空着，gaps 段会写明「角色可拆解」没过，绝不凭空造 4 座。

实测：09 重导后 players 2、roles 程希(你)/陶苏(AI)，缺项只剩「引子可提取」1 条；08 桐花回归无影响（ready，4 份人物剧本照常对位）。

## 游戏厅辅助面板（m02740）

七种玩法的对局室右侧各有一块**辅助面板**（顶栏「辅助面板」可开关，<900px 落到底部）：**笔记**全玩法都有（textarea，250ms 防抖自动存）；**表格**按玩法定制，单元格直接点着改、行尾 × 删行、「＋ 记一行」加行，全部随存档存 localStorage（`gd:arcade:<scheme>` 的 `note` / `tables`，重开页面还在；「重新开一局」会清空）。

| 玩法 | 表格 |
|---|---|
| 海龟汤 | 提问记录（问题/裁决/剩余/备注）—— **引擎自动记**：soup_ask 的裁决与剩余问数直接成行，猜汤底也记一行 |
| 侦探推理 | 嫌疑人（人/不在场/动机/判断）、线索（线索/哪里得到/指向谁） |
| 密室逃脱 | 背包（物品/哪里拿到/用途组合/状态）、机关与门（对象/试过什么/结果） |
| 剧本杀·反转 | 侦探团搜到的证据（证据/第几轮/威胁）、我的说辞（话题/咬死怎么说/效果） |
| 时间循环 | 元知识（先知道才拿得到）、完美一日排期（时间/地点/动作/状态） |
| 王国议会 | 季度账本（季度/拍板/结果国库）、顾问信任 —— **预填沈万钧/霍震霆/玄尘子/顾长风四行** |
| 单人跑团 | 背包（物品/数量/备注）、任务（任务/进展/状态）、战斗记录（敌人/骰伤害/结果） |

实现都在 web/arcade.js（`AUX` 定义 + `renderSide` + `autoRow`）与 arcade.css；表格定义是数据，加玩法改 `AUX` 一处即可。


## 局域网（m02788）

顶栏「局域网」→ 开关拨到「开」，同一 Wi-Fi / 局域网里的手机、平板、别的电脑用弹层里的链接就能直接开案卷台、对局室和游戏厅，不用装任何东西。

- **实现**：宿主半只听 127.0.0.1，所以插件自己起一个 `node:http` 服务挂 `0.0.0.0:端口`（默认 5288），与宿主路由共用同一份 `dispatch`（`lib/index.js` 里 handler 已抽成 dispatch，两条入口一套逻辑）。
- **钥匙闸**：六位 hex（`randomBytes(3)`），存 `$DSH_HOME/game-desk/settings.json`（lanEnabled/lanPort/lanKey）。链接带 `?k=钥匙` → 302 并写 cookie `gdlan`（`HttpOnly; SameSite=Lax`）；此后所有请求按 cookie 放行。没钥匙时 `/game-desk/app*` 给一张纸色钥匙表单页，其余接口 403 `lan-key`。「换钥匙」后旧链接、旧 cookie 立刻全废（实测旧 403 / 新 200）。
- **开关权限**：`POST /api/lan` 只认回环侧（Host 在 trustedHosts 里），局域网设备能玩、拆不了门（403 `lan-toggle-host-only`）。
- **网卡**：链接列表过滤 `169.254.*`（没拿到 DHCP 的自动私有地址，别的设备进不来），每条标注网卡名（如 WLAN 2 / VMnet8）。
- **换端口**：1024–65535，存下即重挂；旧端口实测立即释放。端口被占时弹层红字显示 `EADDRINUSE`，关→开一次即可。
- **自动重挂**：开关为「开」时，宿主热重载 / 应用重启后 `applyInner` 会自己把端口重新 listen 上，不用手动再拨。
- **根路径**：局域网服务收到 `/` 直接 302 到 `/game-desk/app/`，链接只给 `http://IP:5288/?k=钥匙` 也能进。
- **顶栏换房间**：品牌右侧是「剧本杀 / 游戏厅」两枚 tab（墨底为当前房间）。桌面端左侧栏入口照旧；手机上没有左侧栏，就靠这两枚换房间 —— 游戏厅态会藏起「新建本子 / 导入剧本」（那是剧本杀房间的动作）。深链 `?panel=arcade` 直接落游戏厅。
- **「打开文件夹」只在电脑上生效**：`POST /api/reveal` 只认回环侧，局域网点会得到 403 `reveal-host-only`，页面提示「只能在那台电脑上点」—— 免得手机一按，电脑上弹一排 explorer 窗口。
- **防火墙**：本机 Windows 防火墙服务在跑，但 agent 侧权限（Low IL）读不到入站规则，**无法证明 5288 已放行**。手机连不上时，在管理员 PowerShell 里跑一次：`New-NetFirewallRule -DisplayName "案卷台 LAN" -Direction Inbound -Protocol TCP -LocalPort 5288 -Profile Private -Action Allow`（换过端口记得同步改 LocalPort）。
- **边界（如实）**：
  - 笔记、表格、对局存档在 **localStorage**，每台设备各存各的 —— 手机上的进度不会出现在电脑上；反过来也是。共享的是服务端的东西：本子文件、抽出的文字、DM（`/api/dm`）与游戏厅引擎。
  - 局域网里页面是独立文档，「交给会话」类桥接自动退化为复制到剪贴板。
  - 钥匙写在链接里，别贴到公网；不用了把开关拨回「关」，端口即释放。

## 公网房间（局域网外邀请，m03007）

顶栏「局域网」弹层下半的「公网房间」：拨到「开」，本机 cloudflared（2026.8.2，`~/.local/bin/cloudflared.exe`，PATH 里有也算）拉起一条 quick tunnel，十几秒后给出 `https://随机词.trycloudflare.com/game-desk/app/?k=长钥匙` —— 不在同一个局域网的朋友，拿到这条链接就能进案卷台、对局室、游戏厅。**不要求公网 IP，不开路由器端口，本机防火墙只出不进。**

安全边界（都实测过）：

- **公网只认长钥匙**：16 位 hex（64 bit，`randomBytes(8)`，存 settings.json 的 lanRemoteKey）。局域网那把 6 位短钥匙在公网侧无效 —— 带短钥匙走隧道会撞回钥匙表单页。
- **撞钥匙闸门**：同一来源 60 秒内错 20 次以上直接 429（实测 403×21 → 429×4）；正确钥匙不受闸门影响。来源 IP 取 `CF-Connecting-IP`。
- **管理面公网全关**：`/api/reveal`、`/api/lan` 开关、`/api/tunnel` 开关都只认回环侧（Host 判断），公网一律 403。隧道开着时手机/朋友也只能玩，拆不了门。
- **关即断**：拨回「关」，cloudflared 进程杀掉，公网侧立刻 502；换公网钥匙旧链接立刻 403。
- **接口**：`GET/POST /api/tunnel`（`{enabled}` / `{rotate}`），只回环可访问。

如实的限制：

- 拿到链接的人能用你的**模型额度**请 DM、用游戏厅引擎 —— 链接等于邀请函，别发到公开群。
- quick tunnel 的域名随开随换，**没有固定地址**；要长期开门得上 Cloudflare 账号建 named tunnel + Access 策略，这里不做。
- 内容经 Cloudflare 公共边缘中继（TLS 在边缘终止）—— 开剧本杀够用，**别把不愿外流的资料放进被分享的本子目录**。
- 存档仍按设备各自 localStorage，公网朋友那端也一样。


## 手机端（≤680px）

- 顶栏两行：品牌 + 房间切换一行，工具按钮整行横排（不再竖排溢出）。
- 列表与详情整页切换：点一本进档案页，档案页顶部「← 返回列表」回到账本；窄屏下列表不再被压成 240px 一条。
- 对局室：座位两列网格、页签横向滚动、时钟与工具按钮自动换行；游戏厅：快捷指令横滑、输入 16px 防 iOS 聚焦缩放。
- 弹层（导入 / 局域网 / 新建）：卡片近全屏、字段单列、URL 自动断行、主按钮整行。
- 断点实现：style.css / table.css / arcade.css / library.css 各自末尾的 @media (max-width: 680px) 分节；app.js 的 body.is-detail 类 + .backlink 委托。

## 材料局（导入内容进游戏厅）

- 游戏厅顶栏「导入内容」或卡片区「＋ 导入内容」：选一个资料夹（案例集 / 小说集 / 设定集），挑玩法（七种任选），登记成游戏厅的**材料局**卡。
- 抽取走异步任务（同案件台：peek 起后台抽字，进度条轮 /api/extract/status）；登记后正文缓存进 arcade/<id>/_text。
- 点开材料卡进「材料局房间」：把这本资料当汤面 / 案情 / 设定，直接请模型 DM。POST /api/arcade/ask，本机与局域网免费用；公网走分级闸门。
- 人数：导入时可填「人数」，留空按文件夹名/标题猜（「1-4人本」「双人本」「单人」），卡片与房间顶栏都有胶囊。

## 公网分级（remote 模式）

- 局域网弹层里的「公网」三档：off（默认）/ 只读 / 全开，另有每日额度（默认 40 问）。
- 只读：公网访客能看目录、开材料局房间，但 ask 走额度；全开：连引擎玩法也放行。owner 面（导入、删除、体检、缺件总结、隧道管理）公网一律 403。
- 钥匙：公网用长钥匙（settings.lanRemoteKey，可一键换）；错钥匙 60 秒内超 20 次限流 429。

## 缺件总结（看看缺什么）

- 案卷页与体检区都有「看看缺什么」按钮：POST /api/case/gaps 让模型通读这本的文件清单与正文摘录，**只列材料里明确看得见的缺件**（手册/人物剧本份数/线索卡/真相/答案），≤8 行，每行「缺什么：依据」；看不出来源就写「材料里看不出来」。
- 它是只读总结，不补内容、不改本子；owner 面，公网 403。

## 跨房间入口

- 顶栏「剧本杀 / 游戏厅」页签只在两个房间的主界面可点；进了**对局室 / 引擎房 / 材料局**这类整页覆盖层后，页签被盖住，改用覆盖层顶栏上的按钮：对局室右上「游戏厅」，引擎房与材料局右上「剧本杀」。
- 实现：app.js 的 gotoRoom(p)（收三层覆盖层 + setRoom），经 GameDeskBridge 暴露给 table.js / arcade.js / room.js。

