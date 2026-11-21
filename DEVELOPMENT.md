# 开发日志 · 案卷台（dsh-game-desk）

> 这是开发日志：每个需求的做法、实测数字、踩过的坑，按时间与需求编号排。**想先会用，看 [README.md](README.md)。**
> 下面第一段「安装 / 是什么」是最早写在 README 里的原文，保留原样。

---

# dsh-game-desk（案卷台）

> 一个 DeepSeek Harness（DSH）插件：把剧本杀与游戏厅搬进左侧入口栏 —— 选本、带本、按幕给剧本页图、AI 主持、白板与表格、局域网／公网房间。
> A DSH plugin that turns a folder of 剧本杀 (murder-mystery) cases into a playable table: per-act scenario pages, an AI host, a canvas whiteboard, and LAN/public rooms. MIT licensed.

## 安装（当作 DSH 插件）

需要 DSH 0.2.x（`engines.dsh` 是 `^0.2.0-0`）、Node ≥ 20。

1. 放到本机插件目录：`git clone https://github.com/xinghe-1018/dsh-game-desk.git ~/.dsh/plugins/dsh-game-desk`。
2. 在你 profile 的 `package.json` 里加一条 link 依赖，并把 id 加进 `dsh.profile.bundles`：
   `"dsh-game-desk": "link:C:/Users/<你>/.dsh/plugins/dsh-game-desk"`。
3. 重启应用，左侧入口栏出现「剧本杀 / 游戏厅」两行。

本子放 `$DSH_HOME/game-desk/cases/<本子名>/case.yml`，第一次打开会把 `@max-null/dsh-jubensha` 自带的 7 本拷进来。
玩法依赖 `@max-null/dsh-jubensha` 与 `dsh-xgame` 两个插件（没装也能开，只是游戏厅少几档玩法）。

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

## OCR：扫描件 PDF 与线索图（默认 rapid-cuda / GPU 推理 + 批处理；2026-11-19）

默认引擎 **rapid-cuda**（用户 20:04：「以后把这个换成默认的」）：RapidOCR + onnxruntime 的 CUDAExecutionProvider，解释器是 `~/.dsh/tools/gsv-venv`。**GPU 只接管推理**，PDF 渲染与图像预处理仍在 CPU（gsv-venv 里没有 pymupdf，`ocr.py` 每次都借 `ocr-venv` 子进程渲页，约 1 秒/份）——所以这一档的天花板是 CPU 预处理，不是显卡。

抽取链（`ocrEngine='auto'` 时）：

1. `pypdf` 逐页抽文本（有文本层就直接成，不启 python OCR）；
2. 抽不出 → 一批多份塞给 `tools/ocr.py --engine rapid-cuda --in f1 f2 … --json`（见下「批处理」）；
3. 仍抽不出且 `ocrVlFallback: true` → `--engine vl`（Qwen3-VL-2B，CUDA，慢，只在引擎没停用时兜底）。**vl 不进默认链**，只有显式点名（`body.engine='vl'` 或 settings 写 `vl`）才会用。

整本几乎没字（<800 字）时，线索图（jpg/png）走同一个引擎、同样攒批，最多 24 张。

### 批处理：一份文件不再起一个 python

`ocrMany()` 把待 OCR 的路径按 `OCR_BATCH_SIZE = 6` 切片，**一批一个进程、模型只加载一次**；stdout 是 JSONL（每行 `{engine,source,pages[],ms[,provider]}`），按 `source` 回填到各自的文本 store/index。

- **单份失败不杀整批**：`ocr.py` 内部单份失败会 continue 并在 stderr 记 `[ocr] <name> 失败（exit N）`，宿主按行回填，缺的那份记 failed，不重跑整批。
- **整批真失败**（exit≠0 且一行 JSONL 都没吐 = 崩溃/超时）才降级成逐份各重试一次，日志 `[game-desk] OCR 整批无输出，逐份重试 N 份`。
- **超时按批放宽**：单份上限 `OCR_TIMEOUT_PER_FILE`（rapid-cuda 240s / rapid 180s / vl 300s），整批 = 份数 × 单份，封顶 `OCR_TIMEOUT_CAP = 900000`（15 分钟）。
- 进度：`ocr.current[]` 里一批只占一条，写成「首份 等 N 份（同批）」。

### CUDA 起不来 = 停下报错，不静默回落 CPU（用户 2026-11-19 硬要求）

`ocr.py` 自己在 provider 拿不到时会回落 CPU 并 exit 0（它只保证「能跑」）。宿主的判定更严，命中任一即判 `engineError = {code:'cuda-unavailable', reason:<stderr 尾行>}`：

- `ocr.py` exit 2（引擎缺依赖）；
- 进程 exit 0 但 JSONL 里 `provider` 全是 `cpu`（= ocr.py 已经悄悄回落了）；
- exit 4 且 stderr 提到 cuda / 显存 / out of memory（显存不足）；
- exit 1 且一行输出都没有、stderr 有 cuda 提示。

命中后：**这一轮后面的批不再跑，已经掉下来的 CPU 文本也不采纳**（不拿降级结果冒充 GPU 结果）；任务状态转 `error`，原因写进 `job.error` 与 `job.engineError`，「抽字到一半」的缓存保持原样（已拿到的真 CUDA 结果照常落盘）。缺依赖与 provider 拿不到会**记在本进程里**（`latched:true`），后面的任务直接报错、不再一份份试错；显存那条（exit 4）**不记**——停掉生图再点一次就行。手动改引擎会清掉这条记录。

**要 CPU 只有一条路**：用户自己把引擎切回 `rapid`。宿主任何情况下都不会替用户做这个决定。

### 怎么手动切引擎

- 运行时：`POST /api/ocr {engine:'rapid'}`（也接受 `rapid-cuda` / `vl` / `auto` / `off`），写进 `~/.dsh/game-desk/settings.json` 的 `ocrEngine`，热重载/重启后仍生效；`off` = 完全不 OCR。改引擎同时清掉「CUDA 起不来」的记录并打一行日志。
- 配置：profile 的 game-desk 行 `ocrEngine`（`'auto'` 或留空 = 默认 rapid-cuda；`'rapid'` = CPU 版；`'vl'` = VL；`'off'` 关）。
- 单次任务点名：`POST /api/case/ocr {engine:'rapid'}`。优先级 = body.engine（显式）→ settings.ocrEngine → 默认 rapid-cuda。

### 观测字段（`GET /api/ocr` 向后兼容扩字段，前端不用改）

`ocr.engine`（实际生效）、`ocr.engineSetting`（用户写的原始值）、`ocr.engineDefault`（`'rapid-cuda'`）、`ocr.engineError`（`null` 或 `{code,reason,at,latched}`）、`ocr.providers`（`{active:'cuda'|'cpu', evidence:<ocr.py stderr 原文>, at}`）、`ocr.batch`（`{size,batches,files,failed}`）。
任务侧：`GET /api/extract/status`、`/api/import/status`、`/api/case/ocr/status` 都带 `engine` / `provider` / `engineError`。宿主日志每次跑完一批打一行 `[game-desk] OCR provider=cuda（engine=rapid-cuda）证据：<ocr.py stderr 原文>`；引擎停用打 `[game-desk] OCR 引擎停用（rapid-cuda）：<原因>`。

### 实测（2026-11-19，本机 RTX 4070 Laptop 8GB）

素材：`D:\BaiduNetdiskDownload\双人本合集\1-4人本-生门\` 的两份 16 页扫描件（林盼盼 3.08MB / 周忍冬 3.11MB）。

| 跑法 | 进程墙钟 | 每份 ocr.py ms | 字数 | provider |
|---|---|---|---|---|
| rapid-cuda 单份（林盼盼） | 118.8 s | 61560 | 6851 | cuda |
| rapid-cuda 同批 2 份（林盼盼 + 周忍冬） | 102.4 s | 49170 / 34406 | 6851 / 6965 | cuda / cuda |
| rapid（CPU）单份（林盼盼） | 720.6 s | 700693 | 6851 | — |
| 宿主真代码路径（`ocrMany`，2 份同批） | 134.6 s | 79621 / 34322 | 6851 / 6965 | cuda / cuda |

- **批处理省冷启**：同两份单跑估算 237.6 s，一批 102.4 s → 省 **135.2 s（≈57%）**。模型加载本身只要 1.9–2.7 s，省下的大头是「起进程 + 解释器 + 预热」的固定开销。
- **准确率不掉**：同一份文件 rapid 与 rapid-cuda 输出 **6851 vs 6851 字，差 0.0%**（验收线 <5%）。
- **CUDA 硬证据**（`ocr.py` stderr 原文，宿主原样收进 `providers.evidence`）：

  ```
  [ocr] rapid-cuda：ort.get_available_providers()=['TensorrtExecutionProvider', 'CUDAExecutionProvider', 'CPUExecutionProvider']
  [ocr] rapid-cuda：首个会话 session.get_providers()=['CUDAExecutionProvider', 'CPUExecutionProvider']
  [ocr] rapid-cuda：CUDAExecutionProvider 已启用
  [ocr] 引擎 rapid-cuda 就绪：模型加载 2.7s，provider=cuda
  ```

- **诚实限定**：CPU 那一趟是在机器上另有 3 个用户的抽取任务抢 CPU 时测的，**CPU 数字偏悲观**，只当量级参考；GPU 这边也别把 6 倍差当干净基准——页面渲染与预处理留在 CPU，页数越多越接近「每页 2–5 秒」的稳定值。
- **显存与生图互斥**：rapid-cuda 与 ComfyUI 生图共用一个 8GB 显卡。生图模型驻留时 CUDA 会话可能 exit 4 → 宿主报 `cuda-unavailable` 并停下（**不会**偷偷用 CPU）；停掉生图再点一次即可。`vl` 更吃显存，生图在跑时基本必 exit 4。

### 解释器与 CLI 约定

`ocr.py` 自己会在候选里挑一个装了依赖的解释器（`ocr-venv` → `whisper-venv`；`rapid-cuda` / `vl` 走 `gsv-venv`，缺模块时 re-exec 到带依赖的那个）。宿主只负责起进程与拼文本：`--engine <e> --in <多路径> --json`；退出码 0 成功 / 1 部分失败 / 2 引擎缺依赖 / 3 模型缺失 / 4 显存不足或整批全失败 / 5 PDF 打不开 / 6 输入不支持。

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
3. **显示**：档案页 importBlock 之后渲染 `.gaplist`「体检没认出的项 · N 项 —— 没认出 ≠ 原文没有：先在 _text/ 里按关键词搜一遍，确实没有再补」，warn 金色 / fail 印章红，尾注给补法（补文件进原资料夹，或让 AI 按已有正文补写人物剧本，再重导刷新）。

## 体检误报「缺」的修正（m00429，2026-11-19）

用户指出：体检报「缺」的东西，很多其实就在文本里，只是检测没找出来。实测两本导入本定位到四类真缺陷，全部改掉：

1. **抽取失败被掩盖**：09 的 `陶苏.pdf`（9.9MB 扫描件）与 `一轮线索.pdf`（38MB）根本没抽出字（_text 只有 5/9 份），旧 `scripts` 判据 `readable>0` 就过——半本人物剧本读不到也不报。现在要求**每个角色**都有可读剧本（文件或正文小节），部分失败时 warn 里点名列（「抽不出字的：陶苏（多半是扫描件——先跑 OCR 再重导，不是缺件）」）。
2. **缺件总结的抽样盲区**：旧 caseGaps 只取前 6 份文件 × 各自头 8000 字——08 手册 15751 字，真相/复盘在后半截，模型看不见就报「缺真相」。现在：全文读入 → **每份头 2600 + 尾 2600 抽样**（真相常在结尾）；另跑**全文关键词检索**（手册/人物剧本/线索/真相解析/背景引子/答题卡 六类，报命中数与所在文件）；`_source` 里没抽出字的文件单独列给模型并标注「不代表缺件」。提示词改成三档结论：检索有痕迹→不许说缺，只说「有痕迹，抽样没展开」；扫描件未抽字→说「先跑抽取」；检索零命中且清单无对应→才列「缺」。实测 09 不再误报、08 的真相复盘判「已在主 PDF 中展开」。
3. **正则太窄误报「没找到」**：detectSpec 现在认多种写法——角色行加「名字（性别，N岁）」「名字，性别，N岁」；引子标题加 背景故事/故事简介/剧情简介/内容简介/开场白/楔子；线索加「线索卡x54」「第N轮线索卡共26张」与正文「线索一：」小节计数；手册加 游戏手册/DM手册/真相手册/上帝视角（文件名排除 玩家/人物/角色 手册）；人数加「游戏人数：N」「适合N人」。
4. **合集杂志页污染**：09 文本里夹着别本简介（「游戏人数：7人《恶魔契约》」等 6 个数），旧式取首个命中会报 7 人。现在收集全部命中：**多值不一致时优先信资料夹名**（playersGuess），detail 注明「文本里有 7/4/6/2/3/5 人多个数（可能混了别本的简介）」。

措辞原则同步改：所有判据 fail 的 detail 从「原文里就没这些」改成「没认出 + 去 _text/ 搜什么词」；case.yml gaps 段头注释同改。09 已重导刷新（2 项 warn：引子、陶苏抽不出字）。

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


## 公网隧道连不上：重试、换协议，以及那句报错本身是个坑（2026-11-20）

起因：开房时报 `cloudflared-exited-1：failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded`，页面只有一个红字，点第二次照样失败。

排查结论（都是当天实测）：

- **不是这台机器出不去公网**：同一时刻 `curl.exe -X POST https://api.trycloudflare.com/tunnel` 3/3 都是 200（总耗时 3.5 / 4.5 / 4.5 秒；DNS 0.01s、TCP 0.23–0.33s、TLS 0.47–0.73s）；`-4` 也是 200，`-6` 没有 AAAA（本机未启用 IPv6）。
- **三种协议都能连**：各起一条真隧道，`QUIC`（lax10）、`--protocol http2`（lax12）、`http2 + --edge-ip-version 4`（lax01）都在 2 秒内 `Registered tunnel connection`。
- 所以那是 Cloudflare「换域名」这个接口偶发十几秒不应答，cloudflared 自己的 HTTP 客户端先超时。治不了上游，能治的是**多试几次、每次换条路**。
- **更大的坑**：cloudflared 的这句报错里带 `https://api.trycloudflare.com`，而插件找隧道地址的正则只看 `*.trycloudflare.com` —— 于是把「换域名的接口地址」当成隧道地址：`url` 被填成 api 域名、`starting` 被清、`tried` 被清零。旧版「失败自动重试一次」因此常常永远停在第 1 次尝试，协议也永远不换（假宿主里三次 spawn 全是 quic，铁证）。

现在的做法（`lib/index.js`，`TUNNEL_*` 常量那一段）：

- **一轮 4 次**，失败后退避 **2s / 5s / 10s**；第 **2** 次换 `--protocol http2`（UDP 7844 被掐时 QUIC 永远连不上），第 **3** 次起再加 `--edge-ip-version 4`；每次都带 `--retries 10`。
- 一轮没成就**再来一轮**，轮间歇 **30 秒**，最多 **3 轮**（约 3 分钟）：用户点一次「开房」，插件替他连 12 次。Cloudflare 那个接口的坏窗口常常就是几十秒，只给一轮 20 秒容易整轮撞进去（2026-11-20 用户实测：点一次报错、隔一分钟再点就好）。
- 单次 25 秒（正常 2–4 秒就拿到地址），超时按失败处理，直接进下一次。
- 次数在**启动时**累加（`TUNNEL.tried`），不再依赖「失败次数自己数」；只有真拿到地址才清零。
- 失败分类 `errorKind`：`api-timeout` / `no-network` / `edge-fail` / `closed` / `timeout`，前端各翻一句人话；原始尾巴留在 `detail`，悬停可看。
- `GET /api/tunnel` 多回 `tryNo / tries / round / rounds / retrying / retryInMs / protocol / errorKind / detail`；`retrying` 期间房间快照仍算「房间在」，前端按忙态显示「第 N / 4 次（HTTP/2）…」，不会中途把「开房」按钮放出来。
- 前端轮询窗 20×5s → **80×5s**（400 秒，够 3 轮走完）；重试文案带「（第 N / 3 轮）」，免得次数从 4 跳回 1 被当成死循环。

实测（独立假宿主 + 假 cloudflared：前两次原样吐那句超时，第三次转发真 cloudflared）：

- 正常路径：4.7 秒拿到 `https://….trycloudflare.com`，`protocol=quic`、`attempts=0`、`error` 空；关掉后 `running:false`。
- 重试路径：三次 spawn 的参数依次是 `[… --retries 10]` → `+ --protocol http2` → `+ --edge-ip-version 4`；状态序列 `0/quic → 1 重试(api-timeout, 2s) → 1/http2 → 2/http2(5s) → 成功`，全程 19.4 秒，url 真、error 空。
- 同一次假故障也复现了上面的正则 bug：修之前每次失败都被当成「已就绪」，`tried` 每轮清零、协议永远是 quic。
- 跨轮（假 cloudflared 前 8 次都吐超时，第 9 次转发真 cloudflared）：状态序列 `round 0 → 1 → 2`，12 次配额里第 9 次拿到真地址，全程 7.5 秒（测试里把退避改成 120ms / 轮间歇 300ms），成功后 `round` 归零。
- 12 次全失败的情况：`spawns=12`、`round=2/3`、`retrying=false`，错误留在页面上，用户可再点一次。

坑：

- 别把 `api.trycloudflare.com` 当隧道地址（`quickUrl()` 已排除 `api.` 与 `www.`）。
- 前端必须把 `retrying` 当忙态：两次尝试之间 `starting=false`，按旧条件会收忙态、按钮变可点、弹层还闪一句报错。
- 时间预算：一轮 4×25 秒 + 退避 ≈ 117 秒；三轮 ≈ 3 分钟，再往上加只会让人以为卡死。
- **改完 `lib/index.js` 必须重启应用**（宿主不热重载插件模块）。2026-11-20 的现场教训：代码 21:29 落盘、应用 18:06 起就没重启过，21:52 用户再点一次照样报同一句 —— 判断办法是 `GET /api/tunnel` 有没有新字段（`round` / `errorKind`），有才是新代码在跑。


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

## 导入完成的 token 用量提示（m00625，2026-11-19）

- 导入收尾的 toast 现在带账：「已导入：X · 本次模型用量 N token · 案卷台今日 M token（K 次模型调用）」。**导入本身是本地抽取（pypdf/fitz + 本地 OCR venv），不走模型，所以本次恒为 0**——文案照实写 0 并注明「导入是本地抽取，不走模型」，另附案卷台当日真实模型用量（缺件总结/页内 DM/材料局/引擎房旁白花的）。
- 记账链路：lib/index.js 的 USAGE 段——四个 llm 调用点（dm / arcade-content / case-gaps / narrate）在 stream 循环里捕获 `{type:'usage'}` chunk（inputTokens/outputTokens/totalTokens/cacheReadTokens），落 `~/.dsh/game-desk/model-usage.json`（留最近 300 条）；`todayModelUsage()` 按本地日合计。新路由 `GET /api/usage`（owner 面）回 `{today, remote}`；前端 importDoneToast() 完成后 fetch 它拼文案。
- 引擎房（xgameCall）走 tools.executable → dsh-xgame 引擎，其内部模型用量对本插件不可见，不计入此账（narrate 旁白半可见、已入账）。
- 顺带修了一个既有 bug：doImport 原来 POST 不带 wait，拿到的是 202 空响应，toast 会显示「已导入：undefined」；现在 wait:true 走同步 importPack，folder/updated 都是真值。

## 导入进度恢复 + 动态人数 chips（m01116，2026-11-19）

- **缺陷1：导入进行中关掉/刷新页面，进度条就没了。** 现在两头补：
  - 宿主 `GET /api/import/status` **不带 folder** 时不再 400：扫 IMPORT_JOBS——有 running 就回最新启动那个（`{importing, job:{root,folder}, ocr}`）；没有 running 但有 3 分钟窗口内结束的 done/error 任务也回它（前端据此判断「刚导完」）；都没有才回 `{importing:{state:'idle'}}`。带 folder 的老行为原样保留。key 是 `root|folder`，root 取**最后一个** `'|'` 之前（Windows 路径不含 `|`）。
  - 前端 boot 新增 `restoreImportStrip()`：查到 running 就显示**全局进度条**（页面底部居中小条 `.imp-strip`，`hidden` 属性切换、不做 opacity 动画）并起独立的 800ms 轮询 `pollStrip()`；done 时 importDoneToast + loadCases 后收起，error 时 toast 报错收起。刚结束（done 窗口内）只 console 记录、不打扰。条上「×」只收起显示，任务继续跑（文案注明「关掉不影响导入」）；导入弹层开着时全局条自动让位，避免双条。弹层内原有 pollImport 逻辑未动。
  - **热重载的可见性坑（实证）**：`plugin_manager` 关开本插件会清空 IMPORT_JOBS/EXTRACT_JOBS/OCR 闸口的**内存表**，但已 spawn 的 ocr.py/pdfToText 子进程继续跑、结果照常写进 `~/.dsh/game-desk/text` 缓存——只是状态接口从此看不见那趟活。所以恢复轮询只认内存任务表，页面对这种「孤儿在跑」保持沉默（**不得谎报「已停止」**）；缓存照常补齐，重扫即命中。进度条 done/error 判定**只看 job.state**，绝不按文件数猜。
- **缺陷2：左栏人数 chips 硬编码只有四人/六人，双人本没得筛。** 改为动态：
  - `index.html` 的 `#chips` 只留静态「全部」；`app.js` 新增 `renderChips()`（loadCases 数据到手后调用）——从已加载本子里收集去重的 `players>0` 升序生成 chip，标签 2→「双人」、1..10→中文数字、>10→「N人」；当前 filter 对应 chip 消失时自动回 all。
  - 点击绑定从逐个 addEventListener 换成 **`#chips` 容器事件委托**（动态 chip 绑不上老监听，必改点）；`visible()` 里硬编码 '4'/'6' 的比较换成 `state.filter!=='all' && String(c.players)!==state.filter` 通配任意人数。手机端 ≤680 分节未动（`.chips` 本就 flex-wrap）。
- **后台 OCR/解析进度条（用户 m01262「后台ocr干活的时候在前端显示个进度条」）**：全局条做成通用的，同一元素两个数据源——
  - 宿主 `GET /api/ocr` 向后兼容扩字段：`ocr.jobs[]`（扫 EXTRACT_JOBS+IMPORT_JOBS 里 state==='running' 的任务，带 kind/root/folder/phase/done/total/rel/elapsedMs）+ `ocr.current[]`（新增 OCR_ACTIVE 台账：ocrBatchRun 起跑时 push（一批一条，写成「首份 等 N 份（同批）」）、finally 摘除，只留最早 3 条，即正在跑/最先排队的）。注意 POST /api/extract 是同步老接口**不登记 EXTRACT_JOBS**，走 GET /api/peek（pack 分支）或 GET /api/screen 才会 startExtract 进 jobs[]。
  - 前端 `startOcrPoll()`（boot 起，5s 一轮）：有活就画「后台解析：folder · 抽字 x/y（当前 文件名） 等N本 · OCR排队 k（关掉不影响后台）」，没活收起；`importStripActive` 时让位给导入条，弹层开着时让位给弹层。× 只收起**本轮**——活动清零后下一轮再亮（`ocrWasActive` 跳变重置 `stripHidden`）。热重载后的孤儿任务依旧看不见（同上条），UI 保持沉默不谎报。

## 识图补齐（m01150，2026-11-19）

- **它解决什么**：结构化本（导入本）档案页里，扫描件 PDF/图片走 pdf-parse 抽不出字时，体检会挂「抽不出字」。现在在「看看缺什么」旁加「**识图补齐**」按钮：只对本本、由用户点击触发，对这些文件补跑一次本机 OCR（`POST /api/case/ocr` → 202 起后台 → `GET /api/case/ocr/status` 700ms 轮询）。左栏 pack 的灰 chip「扫描 x/y」加了 title 提示指向这里（pack 没有 caseDir，不做点击接线）。
- **三个引擎**：`rapid-cuda`（缺省）= gsv-venv 里的 RapidOCR + onnxruntime CUDA（**GPU 推理**，单份上限 240s）；`rapid` = whisper-venv 的 CPU 版，只有 settings.ocrEngine='rapid' 或 body.engine='rapid' 才走（单份 180s）；`vl` 必须显式点名 = gsv-venv 的 Qwen3-VL-2B（CUDA，300s）。**CUDA 不可用（含生图占着显存导致的 exit 4）时宿主报 `cuda-unavailable` 并停下，不回落 CPU**（见上文「CUDA 起不来」一节）；响应 `note` 里带同样提醒。
- **空文本严禁落盘**：失败/超时/白页一律只进 `failed[]`，不写 `_text/`。一份 0 字节的假 txt 等于告诉体检/缺件/DM「这有字」，比这次没识别出来伤害大得多。成功的写两处：`caseDir/_text/<rel去后缀>.txt`（沿用旧命名 `legacyOutNameOf`，老 `_text` 目录不作废）+ 若有 case.yml `meta.source_root/source_folder`，同步补写 `~/.dsh/game-desk/text/<sha1(root|folder)>/` 缓存与 index.json（**这里用新命名 `outNameOf`**，仿 put：清洗控制字符、按 rel 替换旧条目、全量重写）——缓存与同目录 extract/import 会撞 index 写入，起跑前查它们 running 则 409。
- **默认清单与 force**：rels 省略时后端按 caseGaps 的「_source 文档类 vs _text 现有 txt」反查生成（docx 剔除——ocr.py 直接 exit 6；已有 txt 的剔除，`force:true` 连它们一起重认）。
- **门**：`case/ocr`、`case/ocr/status` 在 GATE_RULES 显式钉 `owner`——gateFor 是完整剩余段精确键查，漏写等于公网可触发本机 OCR。
- **只手动、不主动（用户 m01367）**：boot 与后台都不起识图；标签/体检类数据只在用户自己发起的抽取或识图收尾时顺手算。`extractPack` 收尾处原本留的钩子位（「extract done → 顺手 screenPack 落 pack-meta」），归下一单「扫描后打标签」任务实施，本单已做，见下文新节。
- **取消与缺件**：`POST /api/case/ocr/cancel`（owner）把在跑任务标 `cancelled`，跑完当前文件即停（状态转 error「已取消」）。rels 里指向不存在文件的条目直接记 failed、**不起 python**（用户 m01377 期间禁起 OCR，接线验收即走这条路）。OCR 段是「先攒齐 todo、再交 ocrMany 分批」的两段式，（agent-9b 2026-11-19 已完成批处理改造：第二个循环已换成 `ocrMany()` 按 6 份一批）。
- **2 并发开关（用户稍后要开）**：`POST /api/ocr {parallel:true}`（owner）即把全局闸从 1 提到 2（`ocrLimit()`），并写进 settings 的 `ocrParallel` 持久化、重启生效；`/api/ocr` 返回里的 `ocr.parallel` 是当前状态。CPU 的 rapid 可开；vl 别开（双份 CUDA 显存更容易 exit 4）。
- **热重载注意**：插件开关会清 CASE_OCR_JOBS 内存表（同 IMPORT/EXTRACT 的孤儿行为），在途子进程照常跑完但状态接口看不见——重载前先查 `/api/ocr` 无 running。

## 重大线索解锁（m01167，2026-11-19）

- **机制**：dsh-xgame 引擎每次工具调用后把对局真相与进度原子落盘 `~/.dsh/storages/dsh-xgame/<sid>/{truth.json,state.json}`；sid 由游戏厅前端生成（`game-desk-<scheme>-<ts36>`）、宿主 pickSid 原样采用 ⇒ 目录名==sid。所以线索面板是**纯读盘**：`POST /api/xgame/clues` 用 truth 全集 × state 已获得算出卡片表 `{title,endTitle,cards[{id,text,on}],total,lit,complete}`，零模型调用、零 token 成本。集齐后 `POST /api/xgame/unlock` 回终局文本 `ending`；未集齐 409 `{error:'clues-not-complete'}`。
- **防泄底**：`on:false` 的卡 `text` 恒为 `null`，卡片文案全部来自宿主 truth.json，前端零玩法分支。门与 xgame/reset 同级（`model`）。
- **七玩法映射**（字段名以 2026-11-19 磁盘样例核对）：soup=factPoints[core] × coreHits，ending=汤面+汤底全文；detective/party=clues × discoveredClues，ending=凶手+手法/动机/机会；escape=puzzles × solved（doors 作进度卡），ending=各谜底+出口链；loop=facts × state.facts（**不用 cutEdges——每轮回零**），点亮 ≥70% 即解锁，ending=因果边全表；council=facts × exposed，ending=四灾真值+引爆状态；trpg=quests × questDone，ending=主线全貌。truth 对不上映射的玩法回 `{ok:false,error:'no-map'}`（HTTP 200，前端静默不显卡片）。
- **材料局未做的原因**：一句话——材料局（导入本进游戏厅）的进度不落 xgame 的 state.json，没有可对账的「已获得」集合，读盘算不出卡片，待引擎为材料局落状态后再接。

### 海龟汤：汤面摆在右侧（2026-11-20）

海龟汤没有地点、没有 NPC、没有可勘查的物件，`hints` 对它回 `sections:[]`，所以右侧曾经只剩「重大线索 · 汤底解锁 已点亮 0/1」，玩家连要猜的那个故事都看不到。

- **宿主**：`POST /api/xgame/clues` 的回包新增 `surface` 字段，**只有 `scheme==='soup'` 才给**（`String(truth.surface).trim().slice(0,4000)`），其它玩法恒为空串。汤面是谜面，不是汤底 —— 汤底只在 `unlock` 时随 `ending` 给出。
- 同时放宽一条：海龟汤即便 truth 里没有 `core:true` 的 fact（`cards` 为空）也**不再回 `no-map`**，否则汤面会跟着卡片一起被吞掉；其它玩法仍按原口径回 `no-map`。
- **前端**（`web/arcade.js` `soupBlock()`，插在 `hintBlock()` 与 `clueBlock()` 之间）：右侧「笔记」下面固定一块「汤面 · 要还原的故事」，正文 `white-space:pre-wrap`；取不到时显示「正在取这局的汤面…」/「汤面还没取到 —— 点下面的『刷新提示』再试」；块内自带一句规则提示「问『是/否』问题；命中汤底才会点亮下面的线索。串通了就点『猜汤底』」+「刷新提示」按钮（同时刷 clues 与 hints）。样式 `web/arcade.css` 的 `.ar-soup*`。
- 实测（1280×800，海龟汤新开一局）：右侧依次为 笔记 / **汤面**（正文 + 规则 + 刷新）/ 重大线索 · 汤底解锁 / 提问记录；`clues.surface` 49 字与画面一致；`loop` 等同接口回包的 `surface` 为空串。

## 提示：这局现在能查什么（2026-11-20）

- **机制**：`POST /api/xgame/hints`，body `{scheme,sid}`，闸门级别 `model`（与 clues 同级，插在 `.../api/xgame/clues` 之后）。与线索卡**同源**（`truth.json × state.json`），纯读盘、零模型调用、零 token。回包 `{ok:true, scheme, title, where:{id,name}|null, sections:[{key,label,items:[{name,sub?}]}]}`。
- **四种 key**：`investigate` 可以深查 / `talk` 可以问 / `go` 可以去 / `search` 可以勘查。每段 **≤30 条**；`sub` 没有就**省略键**（不写 `null`）；空段整段不出，前端拿到 `sections:[]` 时整块不渲染。前端另有显示上限 `HINT_LIMIT=24`（第 25 个起收成「…还有 N 个」）。`scheme` **以 state.json 为准**（body.scheme 与之不一致时听 state 的，回包里的 scheme 同源）；没有对局 / 缺 state.json 或 truth.json → `{ok:false,error:'no-game'}`（HTTP 200，前端只认 `ok:false`）。
- **绝不泄底**：只回**名字**——地点名 / NPC 名 / 物件名 / 顾问名。fact 的 `text`、`auditKeywords`、solution、trap 一律不读、不出现；`facts` 只当「元知识 id 集合」用（loop 判 `requires` 是否满足）。自检里有一组专门断言：把 `JSON.stringify(回包)` 与 truth 的每条 fact 正文（含片段）、auditKeywords 词、solution/trap 字段逐个比对，一条都不许出现。
- **各玩法取什么**：loop = 当前地点 × 当前时间片（`slice ≤ state.slice ≤ sliceTo ?? slice`）的 `events[].investigate.target`（`requires` 未全在 `state.facts` ⇒ sub「可能需要先查到相关线索」）＋在场 NPC（`location/locationId/at` → `schedule[slice]` → `home` → 无地点字段=常驻）＋其它地点，where=当前地点；council = 顾问名 + 固定四灾（瘟疫潜伏/朝堂贪腐/外敌威胁/饥荒压力，sub「花 2 金」），talk 只放顾问；detective/party = 地点（sub「还有 N 处没查」，N = 该地点 clues 数 − 已查到数，N≤0 跳过）＋嫌疑人；escape = 当前房间（state 的 `room/currentRoom/roomId/location` 任取）的 props + 从这儿出发的门；trpg = 当前区域 + 本区域活着的 NPC + 其它区域；soup 及其它 = `sections:[]`。
- **容忍处理**（存档形状不齐也照常出提示，绝不 500）：名字接受字符串/`{name}`/`{label}`/`{title}`/`{id}` 五种形态；地点表可为字符串数组或对象数组；loop 的 `slice/sliceTo`、事件的 `location` 缺失就不按该维度过滤；escape 的 doors 整份没有 `from` 字段时退回全给；trpg 的 `npcAlive[id]===false` 的 NPC 不上提示（死了问不了）；truth 里某表为 null / 不是数组时那一段直接空着。

## 资料夹标签与全要素排序（m01363，2026-11-19）

- **口径（用户 m01290 + m01363 + m01367）**：合集那批扫描件不再整批重跑；每扫完一本，资料夹区这本就带体检标签——**人数 / 类型 / PVP·PVE / 是否全要素（缺几项）**，列表按要素齐不齐排，缺得越多越靠后。**boot 不主动补算**（m01367「不需要重跑了，我想玩哪个本我自己去跑」）。
- **什么时候落标签**：只有两个入口，都是「用户自己发起」——① `extractPack` 收尾（`POST /api/extract`、`importPack` 内部那次抽取都算一次）；② `POST /api/packs/meta` 手动重算。取消/中断的抽取**不落**（那本还没扫全，写下去会长期停在「缺项多」的假状态；重跑会覆盖）。
- **落盘**：`~/.dsh/game-desk/pack-meta/<sha1(root|folder) 前 16 位>.json`，key 与文本缓存 `~/.dsh/game-desk/text/<同一个 key>/` 同一套 ⇒ **有 text 缓存就是 meta 的候选，没有 meta 就是没抽完、或抽在钩子上线之前**。写入先写 `.tmp` 再 `renameSync`：列表随时在读，不会读到半截 JSON。
  字段：`{at, root, folder, title, players, genre, pvp, pvpWhy, complete, missing[{key,label,level,detail}], checksSummary{ok,warn,missing,total}, verdict, chars, fileCount}`。
  `players` 直接复用 `detectSpec`（合集页多值纠错那套，不另写一套）；`missing` = `screenPack` 七判据里没过的那几条（`level` 区分 fail / warn）；`checksSummary.missing` 是其中 fail 的条数。
- **类型 genre**：只认原文「剧本类型 / 游戏类型 / 题材 / 类型：」字段里的第一个类型词（悬疑/恐怖/情感/推理/欢乐/机制/还原/硬核/阵营/互动/本格…）；字段取不到退回体检自己认出的 genre，再没有就是 `null`（前端不显示这枚 chip，不猜）。
- **PVP / PVE 判定优先级**（推不出就 `未标注`，不硬猜）：
  1. 字面优先：`PVP` / `PvP` / `对抗本` / `阵营本` → pvp；`PVE` / `协作本` / `合作本` → pve。
  2. 没字面才用机制词：对抗 / 阵营 / 内奸 / 背叛 / 竞技 / 互相 / 凶手在玩家中 / 指认 → pvp；协作 / 合作 / 共同 / 一起逃出 / 合力 / 团队 / 联手 → pve。
  3. 字面两边都出现、或机制词两边都命中、或零命中 → `null`。判定依据写进 `pvpWhy`，就是 chip 的 title——鼠标停上去能看到「为什么标成这个」。
- **排序（只动 pack 行）**：「未体检」沉底 → 缺项数升序 → 文件夹名（zh）兜底；全要素（缺 0 项）自然顶置。实现是 `orderPacks()`：先记下 pack 在列表里占的槽位，再把排好的 pack 写回这些槽位——**剧本（case）行的相对顺序一个也不动**（剧本区仍按导入顺序 / 名称）。行首 `case-no` 是文件夹名里的编号，不随显示顺序变。
- **一次拿全，不逐行请求**：`GET /api/cases` 给每条 pack 挂 `meta`（`withPackMeta()`），meta 文件不存在就是 `null`，不报错。列表 chip：`N 人`、类型、`PVP` / `PVE` / `未标注`、金色 `全要素` 或虚线灰 `缺 M 项`；**缺项清单全塞在 title 里**，行内只放短文案（小字堆在行内会把列表挤爆）。已导入的本子（case 视图）不显示这些标签——那是资料夹区的语义；pack 详情页本来就有整栏「体检」，标签只是列表摘要。
- **想刷旧本用哪个入口**：顶栏「刷新」右边的 **「重算标签」**（`POST /api/packs/meta`，owner 面）。body 可空 = 当前书库全部；`{folder}` 只算一本；`{root}` 换书库。它**只读文本缓存**：不重新抽、不启 OCR、不写 text store；没抽过字的资料夹跳过并列进 `skipped`，返回 `{counted, skipped[], metas[]}`。
- **热重载的可见性坑不因这一单改变**：关开插件会丢在途任务的内存表视图（子进程继续跑、结果照进缓存，见上文「导入进度恢复」那节），所以这里**刻意不留 boot 补算**；重载后要补旧本的标签，点一次「重算标签」即可——它只读缓存，不依赖任何在途任务。

## OCR 引擎：PaddleOCR 成为默认（m01924/m01933/m02004/m02017，2026-11-19）

- **默认链路**：`settings.ocrEngine` 不写（或写 auto/写错）→ `paddle`（PP-OCRv5，跑在 `~/.dsh/tools/paddle-venv`）；paddle 没装好才退 `rapid-cuda`（RapidOCR + onnxruntime CUDA，gsv-venv），再退 `rapid`（CPU）。显式写 `rapid` / `rapid-cuda` / `vl` / `off` 仍按写的来。
- **为什么换**：同一批文件（胎屋 6 份 + 陶苏，各 6 页，共 42 页；GPU 独占、模型已热、两引擎交替各跑两遍）实测 **paddle 0.40 秒/页 vs rapid-cuda 0.69 秒/页 ≈ 1.7×**（墙钟 24.0s vs 34.7s），CJK 字数 9,134 vs 9,224（-1.0%）。
  > 早期一度记成「8.6×」：那次 rapid 的 2.85 秒/页是**在 paddel 抽取任务同时占用 GPU 时**测的（墙钟 136.7s 里还夹了别人的活），把两个引擎的差距放大了约 4 倍；同一批文件清空 GPU 重测只有 1.7×。以本节数字为准。
- **调参（用户 2026-11-19「尽量追求速度」）**：`tools/paddle_ocr.py` 默认值改为 **dpi=100 / limit-side=1024 / rec-batch=16**。扫描对照（18 页/档，同 3 份）：

  | 档 | ms/页 | CJK 保留 | 备注 |
  |---|---|---|---|
  | 300 / 2400 / 16 | 1714 | 100% | 只慢不快 |
  | 200 / 1600 / 16 | 1345-1677 | 100% | 大页才用 |
  | 150 / 1600 / 16 | 942-959 | 100% | 质量基线 |
  | 120 / 1280 / 32 | 642 | 99.5% | 相似度 0.982 |
  | **100 / 1024 / 16（现默认）** | **361** | **99.5%** | 相似度 0.980，最优点 |
  | 90 / 1024 / 32 | 350 | — | 只快 3%，开始掉字 |
  | 100 / 1024/ 16 + mobile 模型 | 442 | 100.1% | 更快但相似度降到 0.969 |

- **显存**：paddle 按需增长，实测峰值 **2.7–4.8 GB**（整卡 8 GB，桌面基线约 1.2–1.9 GB）。**给更多显存不会更快**——dpi 200/边长 2400/批 32/64 全都更慢；`FLAGS_fraction_of_gpu_memory_to_use`（`--mem-fraction`）实测**不生效**（0.25/0.85/默认三档速度和峰值完全一致），因为 paddlex 自己建 predictor 的内存策略。想用满 6–7 GB 的唯一有效办法是 **2 路并发**（见下），实测峰值 6.3 GB。
- **并发**：`POST /api/ocr {"parallel":true}`（或 `settings.ocrParallel`）= 两个 OCR 进程同时在跑，`OCR_GATE` 上限 2。实测 48 页：单路 13.4 秒（1.79 页/秒）→ 双路 21.5 秒（2.24 页/秒），**+25% 吞吐、峰值 6.3 GB**；3 路会顶到 9 GB+，8 GB 卡别开。
- **端到端（同样走宿主 API）**：彩虹酒吧 12 份 44,124 字 **68.4 秒**（≈5.7 秒/份，含 PDF 渲染与写缓存）；生门 3 份 28.5 秒；对照旧 CPU rapid 的 80–110 秒/份。剩余全量约 200 份时，按 5–6 秒/份估算 **20 分钟左右**跑完。
- **质量抽样**（生门 周忍冬，paddle dpi100 输出）：「村子里有个传言。女，12岁，白水村村民，王传明的好友。鹅蛋脸，笑起来纯真可爱。」——整句干净，无乱码。
- **和 rapid-cuda 的关系**：rapid-cuda 仍保留、可显式切回；它的 CUDA 证据行（`session.get_providers()`）与 `engineError='cuda-unavailable'` 不回落 CPU 的规则没变。两个引擎的 CLI 契约一致（`--engine/--in/--json`），宿主用 `OCR_SCRIPT_BY_ENGINE` 分派脚本。

## 跨房间入口

- 顶栏「剧本杀 / 游戏厅」页签只在两个房间的主界面可点；进了**对局室 / 引擎房 / 材料局**这类整页覆盖层后，页签被盖住，改用覆盖层顶栏上的按钮：对局室右上「游戏厅」，引擎房与材料局右上「剧本杀」。
- 实现：app.js 的 gotoRoom(p)（收三层覆盖层 + setRoom），经 GameDeskBridge 暴露给 table.js / arcade.js / room.js。


## 后台解析进度条（百分比 / 断点续跑 / 图片线索卡）（m02107 + 2026-11-19 收尾）

- **百分比**：`#imp-strip` 右端新增 `#imp-strip-pct`（`.progress-pct`），弹层内的 peek / 游戏厅进度条同样带百分比。
  - 有任务（`/api/ocr` 的 `jobs[]`，含 `extract` / `import` / `case-ocr`）→ `done/total`；抽字已到 total、OCR 批次还在收尾时给 **99%**（不要死钉 95%）。
  - 没有任务、只有 OCR 闸口台账时 → 退到「书库已扫 d/t」的整库百分比（逐个 root 调 `/api/cases?root=` 求和，不带 root 只回 roots[0]）。
- **断点续跑**：`extractPack` 开头扫 `~/.dsh/game-desk/text/<key>/` 里已有的非空 `*.txt`，命中就记进 index 直接跳过，**不重烧 OCR**。中断过的书重跑只补缺口。
  缓存名规则与「新名 / 旧名回落」见下面「文本缓存命名」一节（2026-11-20 改成带扩展名的哈希名，老 store 仍全部命中）。
- **后台抽取**：`POST /api/extract {"background":true}` → 立刻回 202，任务进 `EXTRACT_JOBS`，用 `GET /api/extract/status?root&folder` 轮询。
  必须用它的原因：同步路由在 Node 默认 5 分钟 `requestTimeout` 下会被掐断，掐断时抽取循环中途死亡还会漏放 `OCR_GATE` 名额（实测 running:2/queued:9 卡死，后续任务永远排队）。
- **图片线索卡也认**（用户 2026-11-19 拍板）：`CONF.ocrImagesMode='all'`（默认）→ 每本的 jpg/png 线索卡都走 OCR；单本上限 `CONF.ocrImageMax=80`。
  老行为 `'sparse'` 只在整本几乎没字（`charsSoFar<800`）时才认图片，保留作回退。改之前 24 本里 103 份 jpg 永远进不了文本（「大明星」41 份里 34 份是 jpg）。
- **vl 兜底不再判死任务**：主引擎把某份扫描件认成 0 字、兜底 vl 又起不来时，原来会把 vl 的 `ocr.py exit 4` 写成整个 job 的 `engineError` → 一本书后半截直接中断。现在兜底失败只记日志，失败文件留在 `failed` 清单里。
- **实测（2026-11-19 22:4x）**：18 本、含图片，两路并发 **196 秒**跑完，书库 **407/415**；剩下 8 份是空白/无字页（不能说的秘密 18/19、双生探案 20/22、双生探案2 20/23、失魂 5/6、无形之刃 28/29），不是缺件。
  **2026-11-20 起口径变了**：分母只算「可抽文件」（`_ai_fill/` 等 `_` 前缀内部目录、doc/docx 全部剔除），所以这几个数字不再可比，见下面「数据一致性修复」一节。
- **纪律**：重载插件前先杀掉所有 `python.exe`，否则旧 fiber 里的抽取循环会留下看不见的幽灵进程（杀一个跳一份，唯一干净解是重启应用）。

## 数据一致性修复（2026-11-20，P0/P1）

审计给出四类实证缺陷，均已修，且**都不会让老缓存失效**（24 本 400+ 份 txt 照旧命中）。

### 文本缓存命名：不同 rel 永不撞名 + 旧名回落

- **旧规则的 bug**：`outNameOf` 先把扩展名剥掉再拼 `.txt`，于是 `X.jpg` 与 `X.pdf` 都落成 `X.txt`，后写的覆盖先写的——那份源文件的文本**永久不存在**。实证：双生探案 `李子鸣.jpg`+`李子鸣.pdf`、`齐靖宇.jpg`+`齐靖宇.pdf`，双生探案2 `人物剧本/普朗克`、`人物剧本/白桓川` 各一对；两本 22/23 个文件而 index 只有 20 条，进度永远 20/22。
- **新规则**（`outNameOf`）：`rel.replace(/[\\/]/g,'__')` 保留原扩展名，再拼一个 8 位 `sha1(rel)` —— 形如 `人物剧本__普朗克.jpg.a1b2c3d4.txt`。人可读、确定性、纯函数、不同 rel 数学上不会撞。
- **旧名回落**（向后兼容的硬要求）：另留 `legacyOutNameOf`（旧规则）。命中判定是「**新名存在→用它；否则旧名存在→用旧名**」，回落时 `console.info` 一条 legacy-hit（每本只打一次）。**写入一律用新名**，所以新抽的文本都在新名下，旧名只是只读的兼容层。
- **覆盖告警**：`put()` 写到同名文件时打 `[game-desk] txt 覆盖告警`，以后再出现撞名能当场发现。
- 顺带修掉：已缓存的图片以前从不进 index（只在当轮 OCR 后才 push），所以索引与磁盘 txt 数量对不上。现在缓存命中的每份都会补进 index。

### index.json：取消保护 + 目录读不全不当全量

- **取消时不写残缺索引**：`extractPack` 写 index 前判 `cancelled()`；并且与旧 index **取并集**（按 txt 名去重，缓存文件才是实体）——旧条目保留、本轮新写盘的补进来，**任何情况下不会比旧的小**。
- **目录读不全要报出来**：`walkFilesEx` 遇到 `EACCES/EBUSY/ENOENT` 或 `statSync` 失败都会记进 `errors[]` 并置 `incomplete=true`（`walkFiles` 仍返回数组，老调用方不受影响）。抽取收尾若 `incomplete` → **不写 pack-meta**（只落 index），`GET /api/extract/status` 带 `incomplete:true` + `note` 说明哪棵树没读全。
- 效果：残缺索引不会再被当成全量索引写回去。实证过的坏例子是「1-4人本-消失的子弹」index 3 条 / 磁盘 6 个非空 txt。

### YAML 转义对称：`source_root` 不再算出幽灵 key

- **写侧**：`yamlScalar` 改用 `JSON.stringify`；**读侧**：`stripQuotes` 用 `JSON.parse` 反解（不是合法 JSON 时退回 `\\`/`\"` 的最小反转义）。
- **归一化**：`caseSourceMeta` 的 `root` 过 `resolve()`（幂等，已是正常路径的不变），避免 `D:\\...` 与 `D:\...` 参与 `sha1(root|folder)` 算出两个 key。
- 效果：`~/.dsh/game-desk/text/<key>` 的 key 只由**真实路径**决定；抽取在跑时的守卫（查 `extractStatus` 是不是 running）也因此命中真 store。实证：09 陶宅夜话、08 两本 case.yml 里是双反斜杠文本，读出来是单反斜杠绝对路径，`textStore` 命中的就是原来那份 store。

### 进度分母：只算「可抽的」

- `scanProgress` 的分母排除 `_ai_fill/`（及一切 `_` 前缀内部目录）与 doc/docx 等永不抽取的文档；额外回 `unsupported`（被排除的份数）与 `totalAll`（旧口径全量）供对照。
- 结果：**「所有能抽的都抽完」时进度就是 100%**，不会再结构性卡在 19/20。实测 24 本的分母从 832 降到 824，原先结构性缺口的 4 本（失魂、无形之刃、消失的子弹、无间追凶）已满格，剩下的都是真·未抽（缺 jpg / 缺 pdf）。

### `aiComplete` 是派生量，不再当状态字段搬运

- `META_STATE_FIELDS` 从 `['aiFill','aiComplete','review']` 改为 `['aiFill','review']`；`aiComplete` 由 `withAiFillMeta` 现算（`missingEffective.length === 0`），**不落盘**。
- 为什么：磁盘上会残留「`aiComplete=true` 但 `complete=false` 且 `missing=[scripts]`」这种自相矛盾的状态，前端 `complete = completeEffective || aiComplete || complete` 直接判「完成」——假完成。
- 盘上已有的旧 `aiComplete` 值不主动删（留着无害，读侧一律以现算为准）。

### 其它两处一致性加固

- **pack-meta 读-改-写竞态**：`packReview` / `packFill` / `packFillUndo` 原本是「开头读 meta → 模型调用（几十秒）→ 整份写回」，窗口里若抽取收尾写了新 meta 会被旧快照覆盖。现在**写回前重读**，只覆盖自己负责的字段（`review` / `aiFill`），其余字段用新读到的。
- **`model-usage.json` 原子写**：`recordModelUsage` 改成 tmp + rename；读失败区分 `ENOENT`（真空账，正常新建）与解析失败（先备份坏文件成 `.bad-<ts>` 再重置，不再直接覆盖成 `[]` 把历史账目烧掉）。

### 自检

`node ~/.dsh/tmp/gd-datafix-test.mjs`（或在仓库里 `node tmp/gd-datafix-test.mjs`）：读插件真源码 + 追加 export 到 tmp 探针再 import，**只用真函数**，写操作全落 `tmp/gd-datafix-sandbox`，不注册路由、不起服务、`ocrEngine='off'` 不触 OCR。覆盖：新旧命名零失效 / 撞名消失 / 取消不缩水 / incomplete 不写 meta / YAML 双反斜杠解析 / aiComplete 现算 / usage 原子写。当前 **64 PASS / 0 FAIL**。

## 缺项 AI 复核与补全（2026-11-19）

**为什么要有这条链**：体检（`screenPack` 七判据 + 抽出来的文字）有两处会**误报缺**——正则没认出写法（写法一变就判零命中），以及模型只看了部分文本。所以缺项不直接信：**先让 AI 对着原文复核，真缺再让 AI 补，补出来的东西必须打标记**，一眼能看出不是原稿。

三个路由都在 owner 面（`GATE_RULES` 里 `'packs/review'` / `'packs/fill'` / `'packs/fill/undo'` 全钉 `'owner'`，公网一律 403；也**不**放进 `model` 面，因为它们不产生模型服务）。共用约定：`root` 省略 = 当前书库，越权回 403 `root-not-allowed`，`folder` 必填。

- `POST /api/packs/review` — body `{root?, folder}`。
  1. 读 pack-meta；文件不存在就先 `refreshPackMeta` 造一份（**只读文本缓存**：不重抽、不启 OCR；仍然没文本回 422 `no-text`）。
  2. 取 `meta.missing` 里的项——**`level:'warn'` 也算缺**（`buildPackMeta` 的 `complete` 本来就是把 warn 一起算进去的），最多前 8 项。
  3. 正文材料每份取**开头 1200 + 结尾 2600** 字符、总预算约 24000 字（真相/复盘常在后段，只截开头会把要素误判成缺）。
  4. 一次模型调用，要求**严格 JSON**：`{"items":[{"key","verdict":"missing|present|unclear","evidence":"<=80字原文","why":"<=60字"}]}`。明确告诉模型：**只有原文里确实能找到对应内容才能判 present，找到就给原文证据片段；拿不准写 unclear；不许编造**。
  5. 回包剥 ```json 围栏、取第一个 `{` 到最后一个 `}`；模型漏掉的 key 按 `unclear` 补齐；**present 但没给原文证据 → 降级 `unclear`**（不信口头结论）。
  6. 写 `meta.review = {at, model, verdicts}`（原子写）；模型调用失败回 502 `{ok:false,error:'模型没返回'}`，**不写 meta**。
  7. 回 `{ok:true, folder, model, verdicts:[{key,label,verdict,evidence,why}], reallyMissing:[key], present:[key], usage}`。**`reallyMissing` = verdict 不是 present 的项（missing + unclear）**；没有缺项时直接回 `{ok:true, verdicts:[], reallyMissing:[], present:[], note:'no-missing'}`，不花模型。

- `POST /api/packs/fill` — body `{root?, folder, keys:[…]}`。keys 必须非空、**一次最多 3 项**（超了 400 `too-many-keys`）；不在 `meta.missing` 里的 key 直接 400 `bad-key`。**一项一次模型调用**（失败只影响那一项），提示词带该书文本摘要（同上头+尾预算）与该缺项的 label / detail，要求按该项在原剧本里应有的格式产出可直接使用的中文 markdown，800–2500 字，线索类按条给（最多 30 条）。
  落盘到 **`<本子文件夹>/_ai_fill/<key>.md`**，文件开头固定一段：

  ```
  # AI 补全：<label>
  > 由 AI 生成，不是原稿；生成于 <ISO 时间>；依据 <参与摘要的文本文件数> 份文本。
  > 想核对可对照原 PDF/图片；删掉本文件并把 pack-meta 的 aiFill 清掉即可撤销。
  ```

  然后接模型正文。**写回前重读 pack-meta，只覆盖 `meta.aiFill = {at, model, items:{<key>:{file:'_ai_fill/<key>.md', at, chars}}}`**（已有则合并），其余字段用新读到的（模型调用窗口里抽取收尾可能刚写过 meta，不要拿旧快照整份覆盖）。`aiComplete` **不再落盘**——它是派生量，由 `withAiFillMeta` 按 `missing` 与 `aiFill.items` 现算（见「数据一致性修复」节）。
  回 `{ok:true, made:[{key,label,file,chars}], failed:[{key,error}], model, usage, aiComplete}`；一项都没成回 502 `{ok:false, error:'模型没返回', made, failed, model, usage, aiComplete}`。

- `POST /api/packs/fill/undo` — body `{root?, folder, keys?}`。删 `_ai_fill/<key>.md`、从 `meta.aiFill.items` 里摘掉（写回前重读 meta，只动 `aiFill`；`aiComplete` 由读侧现算，不用改）；**不给 keys 就摘掉全部 aiFill 项并整个删掉 `_ai_fill` 目录**。只允许删 `_ai_fill/` 前缀下的路径。回 `{ok:true, removed:[{key,file}]}`。

**标记与撤销**：每个补全文件第一行 `# AI 补全：<label>`，紧接着两行说明「由 AI 生成、不是原稿、生成时间、依据几份文本」和「删掉本文件并清 meta.aiFill 即可撤销」。整本还原走 undo 路由，或手工删 `_ai_fill/` + 清 meta 的 `aiFill`（`aiComplete` 是派生量，不用管）。

**口径（别记反）**：

- **复核只信原文**：模型看到的是真文本，判 present 必须抄证据原文；找不到才是 missing。
- **拿不准算未复核成**：`unclear` 会留在 `reallyMissing` 里，仍建议补——宁可多一份带标记的补全，也不要漏项。
- 补全只写 `_ai_fill/` 下的**新文件** + pack-meta 的 `aiFill`（`review` 由复核路由写；`aiComplete` 现在是派生量、不落盘），**绝不改原稿、绝不改 text store**。
- 记账：`pack-review` / `pack-fill` 两个 source 进 `~/.dsh/game-desk/model-usage.json`，与 `case-gaps` / `narrate` 同一本账。
- 档案页能直接看到状态：`GET /api/case` 的 pack 分支现在一并回 `meta`（读不到给 `null`），无需再单独拉一次。

## 补全之后体检与缺项也要认账（2026-11-19）

**起因**：`POST /api/packs/fill` 补完 `_ai_fill/<key>.md` 之后，体检区块一点没变 —— `GET /api/screen` 只看原文，根本不知道 pack-meta 里记着 AI 补过什么；档案页的 `meta.missing` 也照旧把已补过的 key 当缺，前端于是继续显示「缺 N 项」、「全要素」判 false。

**口径：原始判据不动，只在出口加派生层。** `screenPack()` 照旧按原文出 `checks`，`buildPackMeta()` 照旧用它算 `missing`——`missing` 保持原始语义（否则撤销补全后那一项再也回不到缺项清单里）。

- `GET /api/screen` 返回前过 `applyAiFillToScreen(screen, readPackMeta(root, folder))`：
  - 命中 `meta.aiFill.items` 的 check 加 `ai:true` / `aiChars` / `aiAt`，`level` 判 `'ok'`，`detail` 变成 `AI 补全（N 字）：原稿没有这一项，是按已有正文补写的，文件在 _ai_fill/，不是原稿；原体检描述：<原文>`（原描述不许丢）。
  - `verdict` 按**改后**的 level 重算（否则会出现「这项 ok 但结论还是 blocked」）。
  - 新增 `screen.aiFill`：没补过 = `null`；补过但一项都没对上体检 id = `{count:0,chars:0,at:'',keys:{}}`；有命中 = `{count,chars,at,keys:{<key>:{chars,at}}}`，`at` 取最近一项。**`null` 与 `count:0` 要能分开看**。
  - 新增 `screen.checksSummary = {ok,warn,fail,ai}`，按装饰后的 level 统计，`ai` 是命中条数（同时已计入 ok）。
- `withAiFillMeta(meta)`（null 进 null 出，浅拷贝、不改传入对象）给 meta 挂三个派生字段：`aiFilledKeys`（`Object.keys(aiFill.items)`）、`missingEffective`（`missing` 去掉已补的 key）、`completeEffective`（`missingEffective` 为空）。三个出口各过一遍：`GET /api/cases`、`GET /api/case` 的 pack 分支、`GET /api/packs/meta`。
- **新增只读 `GET /api/packs/meta`**（`?root=&folder=`，也兼容 GET body `{root,folder}`）回 `{ok,root,folder,meta}`，读不到 meta 给 `null`。原来只有 POST（重算标签），前端从不拉单本 meta。
- `POST /api/packs/meta`（重算标签）的 `metas[]` 每条也带 `completeEffective` / `missingEffective` / `aiFilledKeys`。

**重算标签不再冲掉补全账（bug 修复）**：`refreshPackMeta` 与抽字收尾的同一个钩子原来直接 `writePackMeta(buildPackMeta(...))` —— 整份覆盖，点一次「重算标签」，`aiFill` / `aiComplete` / `review` 全没了。现在统一走 `preserveMetaState(root, folder, next)`：读旧 meta，只补 `next` 里没给（`undefined`）的状态字段——2026-11-20 20:00 起是 `aiFill` / `review` / `playtest` 三个（`playtest` 是试玩结论，见「体检之后让 AI 试玩一遍」节；`aiComplete` 已改为派生量，不再搬运）；`next` 自己带值就听它的（补全 / 撤销路由显式写，不受影响）。

**前端没改**：体检区块本来就按 `check.level` 画点、`check.detail` 出字，所以 `level:'ok'` + detail 前缀已经能看出「这项是 AI 补的」；档案页 `packTags()` 早就在吃 `meta.aiFill` / `meta.aiComplete`（金色「全要素(AI补)」「AI 补 N 项」）。

**注意（别把两件事混起来）**：`_ai_fill/` 就躺在本子文件夹里，`screenPack` 抽文字时**会把它当成本子的文本一起读**——实测「双人本-无间追凶」补了 clues 之后，原始体检的 `clues` 判据自己就翻成 `level:'ok'`（detail `1 个线索文件，条数未标注`）。也就是说「补全后这项判过」有两个来源：原文抽到了 AI 文件、以及本次的 AI 标记。要看**哪个是 AI 补的**只认 `ai:true` / `screen.aiFill.keys`，别只看 level。

## 体检之后让 AI 试玩一遍：这本开得起来吗（2026-11-20）

**起因**：体检（七判据）只回答「要素齐不齐」，回答不了用户真正要问的那句「这本现在能不能开一局」。用户要求：体检完之后让 AI **替 DM 走一遍流程**做评测；**缺项只要不挡流程，仍然算能玩**。

**口径（写死在宿主提示词里，别改反）**：

- 缺项 ≠ 不能玩。没标人数 / 没标难度 / 没写作者、线索没标条数、没有独立线索卡但正文里有线索小节 —— 一律只是「薄」（`thin`），照旧算能玩，写进 `tips` 告诉 DM 现场怎么处理。
- 只有真正卡死才算 `broken`：没人能读到自己的人物剧本 / 完全没有线索可搜 / 找不到真相或结局 / 角色与材料对不上导致有人空手。
- 材料只抽了头尾（每份头 1200 + 尾 2600，总预算 26000 字），**看不见某段正文时按「薄」判**并说明没看到什么；**材料里没看到不许拿常识替它补**。

**后端**：

- 新增 `POST /api/packs/playtest`（body `{root?, folder, force?}`），owner 面（`GATE_RULES` 加 `'packs/playtest': 'owner'`）；`folder` 必填，`root` 省略 = 当前书库，越权 403 `root-not-allowed`。
- 流程与 `packs/review` 同构：读 pack-meta（没有就先 `refreshPackMeta` 造一份，只读文本缓存、不重抽不启 OCR；仍无文本 422 `no-text`）→ `applyAiFillToScreen` → 材料抽取 → `packLlm()`（没模型 503）→ `packModelOnce`（`maxTokens: 1600`，记账 source `pack-playtest`）→ `parseJsonLoose`（不是 JSON 回 502）→ 规整 → **重读 meta 只写 `meta.playtest`**（写失败 500 `meta-write-failed`）。
- 回包 `{ok:true, folder, model, playtest, usage}`；材料没变且没 `force` 时直接回 `{ok:true, cached:true, playtest, usage:null}`，**不花模型**。
- `normalizePlaytest` 的六门固定不变：`open` 开本 / `roles` 角色 / `scripts` 人物剧本 / `clues` 线索 / `truth` 真相·复盘 / `host` 主持；`state` 只认 `ok|thin|broken`（认不出的按 `thin`）。
- **`canPlay` 由 gates 现算**（`broken.length === 0`），不信模型自己填的；`verdict` = 有 broken → `unplayable`、否则有 thin → `risky`、否则 `playable`；能玩时 `blockers` 强制清空（模型偶尔把缺项塞进 blockers），缺项全进 `tips`（≤4 条，每条 60 字）。
- 落盘形状：`meta.playtest = {at, model, stamp, canPlay, verdict, why, gates[6], blockers[≤6], tips[≤4], missingN, chars}`。
- **指纹**：`screenStamp(screen)` = `chars|fileCount|checkId:level,checkId:level…`（纯字符串，不引 crypto）。`/api/screen` 出口过 `attachPlaytest()`，带 `screen.playtest` 与 `screen.playtestStale`（没有结论 = stale；结论的 stamp 与当前体检不一致 = stale）。
- `META_STATE_FIELDS` 现在是 **`aiFill` / `review` / `playtest` 三个**：重算标签、抽字收尾整份重写 meta 时，试玩结论不能被冲掉。

**前端（档案页）**：

- 体检块下面多一块 `.ptbox#gd-pt`：头部 `AI 试玩` + 徽标（`能玩` / `能玩，但薄` / `开不起来了`）+ 时间·型号·体检缺 N 项 + 「重新试玩」（`data-gd-force="1"`）；下面是一句话结论、六个环节 `.pt-gate`（`is-ok` / `is-thin` 虚线暗金 / `is-broken` 实线红）、卡点 `.pt-block`、现场建议 `.pt-tip`。
- 打开资料夹档案页时**自动试玩一次**（`PT_DONE` 按 `root|folder` 在页面会话内去重）；结论已经过期（`playtestStale`）自动重跑一次；没结论时只在块里放一个「让 AI 试玩一遍」按钮 —— 不点也能用体检，点了才花模型。
- 结论过期但不想现在跑，也会照旧显示旧结论 + 一行「体检内容变过，这是旧结论」。

**实测（2026-11-20，standalone 宿主 + Edge）**：

- 假模型判 thin（线索/主持两项薄）：`verdict:'risky'`、`canPlay:true`、`blockers:[]`、模型调用 **1** 次。
- 紧接着再打一次（不带 force）：`cached:true`，调用数仍是 1；带 `force:true` 才 +1。
- 换成 broken 回包：`verdict:'unplayable'`、`canPlay:false`、blockers 2 条（what/need 都在）。
- `/api/screen`：第一次 `playtest:null / playtestStale:true`；跑完 `playtestStale:false`，stamp = `1200|2|text:ok,manual:warn,players:warn,roles:warn,premise:ok,scripts:warn,clues:ok`。
- `folder` 不存在 → 404 `pack-not-found`；非本机来源 → 403（未登记/owner 两道都验过）。
- 真浏览器（playwright + msedge）：点开「测试本」→ 档案页自动出 `is-risky`「能玩，但薄」、六个 gate 状态正确、重跑按钮在、toast「能玩：有几处偏薄，DM 现场补一句就行」。

**踩过的坑**：

- **补丁拼接多一个 `}`**：锚点文本自带收尾花括号，追加片段又抄了一遍 → `node --check` 报 `Illegal return statement`（packs.mjs）/ `Missing catch or finally after try`（index.js）。教训：片段开头不要再复制锚点结尾的括号。
- **pwsh 子进程（Low IL）写不了 `AppData\Local\Temp`**：playwright 启动即 `EPERM mkdtemp playwright-artifacts-XXXXXX` → 把 `TEMP/TMP` 重定向到工作区再跑。
- 本机没有 `plugin_manager` 工具，**改完宿主代码不会自动重载**；`POST /api/restart` 会重启整个应用，别在回合中途调 —— 独立验收走 standalone 假宿主。

## 内容卡不铺网格了：一档玩法一个「更多」（2026-11-20）

**起因**：游戏厅把导入的 12 碗海龟汤、1 本侦探本全当卡片铺进网格，七张玩法卡被挤到第一屏之外。用户要的是「这一档里到底有几份、几个文本文件」，不是整页材料卡。

**做法**（纯前端，`web/app.js` + `web/index.html` + `web/arcade.css`，刷新页面即生效）：

- `renderArcade`：先按 `modes` 认出玩法 id，把 `ARC_ITEMS` 里 `scheme` 命中某一档的收起来，网格只画「玩法卡 + 没归类的散装内容 + 导入内容」。
- 每张玩法卡右下角一枚 `.mode-more`（`更多 N`，N = 这一档的份数，title 里带文本文件数）；点开是 `#arc-more` 弹层。
- 弹层抬头 `共 N 份内容 · M 个文本文件 · X 字`，下面一行一份（标题 · 已读字数 · 文件数），行尾 `拆分`（海龟汤且 ≥4 文件）/ `移除`；点行按它开材料局；底部 `收起 / 随机开一篇 / ＋再加一份`（原来的「随机 N」收进这里）。
- 内容库变了（拆分 / 移除 / 新登记）走 `loadArcadeExtra` → `refreshArcMore()` 就地重画，删空了自动收起；Esc 与点背板都关。

**实测**（playwright + msedge 打真宿主，1500×1000）：网格 `#modes` 7 张玩法卡、内容卡 **0** 张；`更多 12`（海龟汤）/ `更多 1`（侦探推理）；弹层抬头「共 12 份内容 · 24 个文本文件 · 37045 字」，12 行，首行「God 变红 · 已读 4856 字 · 2 文件 · 移除」；Esc 后 `#arc-more` 回到 hidden。

**坑**：`?panel=arcade` 只是初始档位，玩法目录要 `setRoom('arcade')` 才 `loadCatalog()` —— 直接开 `/game-desk/app/?panel=arcade` 截到的是空网格，E2E 得先点 `#room-arcade`。

## 房间条：访客一眼看到有没有房、是哪一本、缺什么要素（m01599，2026-11-19）

**起因**：房间信息原来只画在「局域网」弹层里。手机或公网访客打开案卷台首页，什么也看不到 —— 不知道房主有没有开房、开的是哪一本，得先点开弹层才像个能用的页面。

**做法**（宿主 + 前端两半）：

- 房间快照里加 `case`：房主页面每轮心跳上报 `caseRoot` / `caseFolder`，宿主用 `roomCaseInfo()` 扫书库并**缓存 20 秒**，返回标题 / 人数 / 类型 / PVP / 全要素与缺项。
- 快照里加 `you.via`（`local` / `lan` / `remote`），前端据此判身份。
- 前端在顶栏下面加一条 `.roombar`（`#roombar`）：

| 场景 | 显示 |
|---|---|
| idle · 房主页 | 隐藏 |
| idle · 访客页 | 现在没有开着的房间 |
| running | 房间 · 本子标题 · 人数/类型/PVP/全要素或缺 N 项 · 等待玩家 x/y（房主在场/不在）/ 已开局 · 在场 N 人 / 人都离场了 · 约 1 分钟后自动关房 |

条上另有一行**缺项明细**：缺哪几项直接写出来，不用再点进档案页看。

- **按钮随身份变**：访客只有「看这本」；房主还有「强行开局」「房间设置」。
- **类型显示中文化**：`detection` / `deduction` 这类英文原值经 `genreCn()` 字典映射成「推理 / 情感 / 恐怖 / 机制 / 阵营…」，本来就是中文的原样返回。
- **手机窄屏**：`@media (max-width:680px)` 里标题单行省略、chips 与状态换行、按钮靠右。这是新加的一块，不与既有手机端分节冲突。

**踩过的坑**（表现 → 真因 → 对策）：

- **表现**：公网访客的页面上也出现「强行开局 / 房间设置」，点下去才知道自己被当成了房主。
- **真因**：`roomBeat()` 的两处回包调 `roomSnapshot()` 时漏传 via，访客被判成本机。
- **对策**：签名改成 `roomSnapshot(via)`；前端再以回包的 `you.via` 为权威，并把身份写进 `data-via`，出问题时看一眼属性就知道判成了谁。

## 座位占用：两个人不能演同一个角色（m02720，2026-11-19）

**起因**：座位原来只存在各自浏览器的 `localStorage`（`gd:table:<root>|<folder>` 的 `me` / `seat`），服务端根本不知道谁坐了哪一席 —— 于是两个人能选同一个角色，进了对局才发现撞车。

**做法**：宿主加一层内存态座位表，按「书库|本子」记 `seat → {who, name, via, at}`。`who` 就是每个浏览器一个的 `localStorage['gd-who']`（房间心跳用的也是同一个 id，两套东西认的是同一个人）。

三条路由，**都不设闸**（公网 / 局域网访客也要能认领；认领不花模型钱）：

| 方法 | 路径 | 回包 |
|---|---|---|
| GET | `/api/seats?root&folder&who` | `{ok, seats:[{seat,who,name,via,at,mine}]}` —— 读的时候会**给请求者自己的席位续期** |
| POST | `/api/seats/claim` body `{root,folder,seat,who,name}` | 成功 `{ok,seat,seats}`；被占 **409** `{ok:false,error:'seat-taken',seat,holder:{name,who,via},seats}` |
| POST | `/api/seats/release` body `{root,folder,who}` | `{ok,seats}` |

**保鲜与自动释放**：

- 席位 TTL **2 分钟**；页面开着时每 **12 秒**拉一次 `GET /api/seats`，顺便续期。
- 关页面时（`sendBeacon` 的 bye）宿主顺手释放这个 who 的所有席位。
- 同一个 who 换席会自动释放旧席。

**前端行为**：

- 档案页的座位 chips 里，被别人占的席渲染成 disabled 的 `is-taken`（灰、显示占位者名字），点它只弹一句「这一席已经被「X」选了，换一个」。
- 对局室右侧「我演这个」也是**先认领再落座**，认领失败同样提示。
- 别的浏览器一进来就能看到哪些席已经有人 —— 不用等第一个人落座报错。

**边界（诚实写）**：这是**同屋协作的君子协定**，不是防作弊 ——

- 谁都能换一个 who 重新认领；
- 席位只在内存里，**应用重启即清空**；
- 两个人同时点同一席时，先到的那次 claim 赢，后到的收 409。

## 安全加固：信任边界（2026-11-20，三份审计后的 P0 修复）

**起因**：一次系统性审计（宿主 / 前端 / 数据三路）挖出四个 P0，其中两个能直接读任意文件与冒充本机。修复都在 `lib/index.js`，前端无需改动。

**修了什么**：

| # | 原来的洞 | 现在的规则 |
|---|---|---|
| A | `trusted()` 只看 `req.headers.host`，而局域网服务原样转发 —— 持钥匙的人发 `Host: 127.0.0.1` 就被当成本机，全部 owner 闸门失效 | 身份改看 **socket 回环**（127.*/::1/::ffff:127.*）＋显式 `req.__via`；LAN 服务在 cookie 通过后写 `req.__via = 'lan'`，`trusted()` 对 lan/remote 一律 false |
| B | `gateFor` 里 `if (!GATE_RULES[seg]) return null` —— **没登记 = 放行**，40 条路由有 11 条裸奔 | **默认拒绝**：未登记返回 `403 route-not-allowed`；改成白名单，访客可用 13 条显式 `'any'`（cases/case/file/text/screen/catalog/beat/room/room-beat/seats/seats-claim/seats-release/arcade GET），其余 owner |
| C | `/api/file`、`/api/screen`、`/api/text`、`/api/case` 等的 `folder` 参数无校验，`folder=..\..` 能把基准目录挪出书库（实测能读插件源码） | 新增 `requireLibraryFolder(root, folder)`：空/`..`/`/`/`\`/盘符一律 400；root 必须在 `rootsFor()` 里、folder 必须是 `scanRoot(root)` 的真实条目，否则 403。接到 9 条路由 + 2 处纵深防御 |
| D | 席位释放不验归属，谁都能清别人的席 | `seatRelease(body, via)`：非本机必须 `who` 与 `via` 都对得上；本机空 `who` 才允许清场 |

顺带把两条本来就该关的收紧：`GET /api/restart-probe`、`POST /api/room/force`、`GET /api/dm/health`、`POST /api/{import,extract}/cancel` 都变 owner-only。

**实测口径**（重载后逐条打过）：

- `folder=..\..` 打 file / screen / text / case → 全 **400**；正常读面 cases/catalog/room/seats → 200，功能没坏。
- 局域网 5288 + `Host: 127.0.0.1` 伪造（带 `gdlan` cookie）→ `/api/usage`、`/api/lan` **403**（修前 200），`/api/cases`、`/api/seats` 200（客人该能看的仍在）。
- 本机访问 `dm/health`、`restart-probe` 仍 200 —— GATE 只管非本机，本机全放行是设计。

**边界（诚实写）**：

- `via` 是**渠道**不是人：同一渠道里两台设备仍能互相顶替（真隔离要发 token，目前没做）。
- `dm/health` 变 owner-only 后，局域网客人拿 403；前端已改成「静默跳过、不报没探到服务」，探活结果缓存 60 秒。

**座位表的键也一并归一**：原来 `seatKey = root + '|' + folder` 直接用客户端传的 root，同一本书换个写法（真路径 / 空 / `cases` 目录 / 尾随空格）就是四份各自的座位表 —— 所以「公网、局域网、本地各选一个角色互不冲突」。现在 `canonSeatRoot()` 先按 folder 在 `rootsFor()` 里反查唯一真根、再回退客户端路径，实测四种写法：第一个 200，其余三个全部 **409**。

**自检入口**：`tmp/gd-sec-test.mjs`（93 PASS）、`tmp/gd-sec-dispatch-test.mjs`（15 PASS，假 ctx 真 dispatch）、`tmp/gd-seatcanon-test.mjs`（14 PASS）。路由→规则全表 57 个分支 / 50 条路径，未登记 0 条。

## 性能与一致性修复（2026-11-20，第二批 P0/P1：缓存 / `_ai_fill` / 重导安全）

> 本批只动 `lib/index.js`（+ 本节），`web/` 一个字节没碰，也没重载插件。自检 `tmp/gd-selftest.mjs`：**57 PASS / 0 FAIL**；`node --check lib/index.js` exit=0。

### 四层进程内缓存（TTL 2500ms，命中一律返回副本）

- `scanRoot(root)`：键 = root，唤醒键 = 根目录 `mtimeMs|ctimeMs`；命中 `structuredClone` 后返回，调用方改不到缓存。顺带把循环里的 `scanCases(root)` 提到循环外 —— 旧实现 9 本结构化本子 = 9 次全目录扫描 + 81 次 `case.yml` 读取解析，现在 1 次。实测 9 本：miss 2.5ms、200 次命中单次 < 0.02ms。
- `readPackMeta(root, folder)`：键 = `root|folder`，唤醒键 = meta 文件 `mtimeMs|ctimeMs|size`；`writePackMeta` 成功即删对应键。命中返回副本 —— `packReview` / `packFill` 会原地改 `review`/`aiFill`，没有副本就会把缓存写花。
- `storeTxtNames(dir)`：键 = 目录，唤醒键 = 目录 `mtimeMs|ctimeMs`。目录新增立刻可见；删除的可见性上界是**一个 TTL**（NTFS 对目录时间戳的提交是惰性的，这点写在代码注释里，别当成缓存坏了）。
- `folderNamesOf(root)`：记忆键补上根目录唤醒键（旧键只有 root，新建/刚导入的本子 3 秒内看不见）。`fresh=true` 语义不变。

四层都是「键 + 磁盘唤醒键 + TTL」三件套，不靠定时器失效，也都有条数上限（超限整体清表），不会随书库增长漏内存。

### `_ai_fill/` 不再被当成原稿

`walkFilesEx` 新增第 6 参 `opts.skipInternal`（复用已有的 `inInternalDir()`），只在**把目录当原稿扫**的三个入口打开：`scanRoot` 的资料夹分支、`importPack` 的 `walkFiles`、`extractPack` 的 `walkFilesEx`。`importPack` 的 `copyTree` 新增 `{ skipAiFill: true }`，不再把 `_ai_fill/` 拷进新本的 `_source/`；`readStoreTexts` 与 `packTextMaterial` 也过滤 `_ai_fill` 条目。

**`_source/` 是有意保留的例外**：结构化本的原稿就躺在 `_source/` 下，抽文本必须递归进去（自检实测 `extractPack` 仍收 `_source/keep.txt`）。档案页 `/api/case` 走的是不带该参数的老路径，`_source` 里的文件照旧可见。

### 重导：先 park 后写，任何一刻磁盘上都有完整的一份

- 旧 `_source` / `_text` 先 `rename` 成 `*.bak-<yyyyMMddHHmmss>`（同盘原子），新内容全部写完才删备份；中途失败先清掉本轮半成品，再把备份 `rename` 回原名。
- `case.yml` 覆盖前另存 `case.yml.bak-<ts>`，同一本最多留最近 **5 份**（多的删最旧）。
- 本轮**没有文本可写**时不 park `_text`：旧代码是「删了再拷」，store 一空就等于把上一轮的缓存抹掉。

### twin 判据：同根 + 同 folder

旧判据只比 folder 名 —— 从别的库导入同名资料夹会被认成 twin，把人家的 `_source/_text` 清掉改写。现在要求 `source_folder === folder` **且** `source_root` 归一后相等（`resolve` + 双反斜杠压单，兼容存量 case.yml 里的旧值）。

### 索引只增不减 → 读全即裁

`index.json` 收尾仍是「旧 ∪ 新」（取消 / 目录读不全时不让索引变小，这条不变）；但 `walk.incomplete === false` 时按本轮 rel 集合裁掉原稿已不存在的条目，打 `[game-desk] index pruned N stale entries: …`。以前被当成原稿收进来的 `_ai_fill/` 条目也在这步清掉。

### 取消后的 `done` 带 `error`

`extractStatus` / `importStatus` 的 done 分支：`job.cancelled` 为真时带 `cancelled:true` + `error:'已取消（跑完当前文件即停）'` + `done/total`；`{state:'done', cached:true}` 分支补齐 `made:null, failed:null, cancelled:false` —— 页面据此走「之前抽过」那套文案，不会把历史缓存显示成绿色的「刚抽完 N 份」。

### 用量记账的边界（诚实写）

- **导入路径本身零模型调用**：`importPack` → `walkFiles` → `extractPack`（本地 pypdf / PaddleOCR）→ `screenPack`（纯正则判据）→ 拷文件写 `case.yml`，全程不碰模型，所以 `importStatus.modelUsage` 恒 0 是**真 0、不是漏记**。烧模型的是 AI 复核 / 补全（`packReview` / `packFill` → `packModelOnce` → `recordModelUsage`），那是另一条链路。
- `xgameCall`（游戏厅的引擎工具）拿不到模型用量，返回值新增 `usageKnown:false`，**不假装记 0**；`xgameNarrate` 有自己的 usage 捕获，照旧 `recordModelUsage('narrate', …)`。
- `roomCaseInfo` 的 `missing[].level` 原样透传 pack-meta 的 `ok/fail/warn`（`String(m.level || 'warn')` 只兜缺值，不会把 fail 改写成 warn）。

### 自检

`tmp/gd-selftest.mjs`：把 `lib/index.js` 复制到 tmp、末尾追加一行 export，直接调内部函数；fixture 只放 `.txt` 且 `CONF.ocrEngine='off'`（不 spawn python、不碰真书库）。16 组覆盖：`_ai_fill` 边界 / 索引与裁剪 / 四层缓存的副本语义与失效 / twin 三态（同根重导、双反斜杠旧值、跨根同名）/ `case.yml` 备份 5 份 / park 后不残留备份目录 / 取消态两个状态面 / `usageKnown` / `backupStamp` 定宽 —— **57 PASS / 0 FAIL**。

## 前端审计修复（2026-11-20，四份只读审计后的 P0/P1）

四份审计（可信边界 / 内容丢失 / 降级静默 / 卡顿）报告出的前端问题，这一轮全部落地。前端是静态文件，**改完刷新页面即生效**，不需要重载插件。

### 不再「假报失败」与「永久卡住」

- **抽取 / 导入改异步**：`extract()` body 带 `background:true` 走 202 + `/extract/status` 轮询（按钮显示「正在抽 d / t · N 秒」）；`doImport()` 改 `wait:false` 走已有的 `pollImport`，422 确认分支原样保留。以前这两条走同步接口，撞宿主 5 分钟 `requestTimeout` 就报「抽取失败」而磁盘其实还在写 —— 现在报的是真进度。
- **进度条不再冻结**：`watchPeek` 的 `if (!j || !j.ok) return` 死路删掉，403/`route-not-allowed` 显示「这一步只有房主能做（远程/访客页）」，其它错误走中文码 + 停轮询。
- **街机进度退避续轮**：`arcadeWatch` 从 `setInterval` 换递归 `setTimeout`，丢包 800→1600→3200ms 退避最多 10 次；「登记进内容库」按钮在 done/error 分支**直接**出现（以前轮询一死它就永不出现）。
- **取消 / 缓存口径对齐宿主**：`cached:true` → 「这本之前抽过，直接用现成文本（N 份）」；`cancelled:true` → 中性「已取消：跑完当前文件就停了」；`import` 一直 idle 超过 ~15 秒放手并提示再点一次。

### 不再白重画、丢焦点、丢滚动位置

- `roombarPaint` 加指纹：房间数据没变且不是强制 → 整块不重建（15 秒一次的 innerHTML 重建会让正在点的按钮被换掉）。
- `renderList` 的搜索改 120ms 去抖 + 保存/恢复 `#cases.scrollTop`，列表内容没变只切 `.is-on`。
- `pickSeat` 成功后只重画座位行；`renderCase` 重画前后保存/恢复 `#dossier.scrollTop`。

### 内容不再丢失 / 错标

- **doc/xlsx 不再当文本预览**：只有 text/txt/md 走 `fetch().text()`，其余走 `<iframe>` + 「用 Word / WPS 打开原件」+「打开文件夹」。
- **`全要素(AI补)` 只在真有 AI 补全时显示**：`aiStyled = complete && (aiFilledKeys.length>0 || aiN>0)`；原生全要素（`aiFill` 为空）不会再被写成 AI 补的。
- **列表序号**：pack 本子按 folder 排序取库内序号（01…24，稳定、不随筛选变），结构化本子仍是 01…09；不再十本都显示「1」。
- **人数区间**：`1-4` → 「1–4 人」（`playersText`，吃 `-` `–` `—` `～`），不再丢失区间只显示「4 人」。
- **房间条硬缺项判据**改正为 `level==='fail'`（宿主值域是 ok/fail/warn，旧写法 `'missing'` 永不成立）；标题补 `title` 悬停可看全。
- **线索卡不再整块消失**：无数据时显示「线索卡正在取…」/「线索卡取不到（点『辅助面板』重试）」。
- **通用防线**：`type:'select'` 的字段在 `options` 缺失/为空时降级成文本输入 —— 时间循环曾把某一局的地名写死进通用动作表，导致「上面选镇公所、下面引擎说没这个地方」；现在 loop 的「前往/深查/对话」与 council 的「追问/调查」全是带占位提示的文本框。
- **英文错误码收口**：`ERR_CN`（20 个码）+ `errCn()` 覆盖缺口页/抽取/导入/进度条/窥探；`table.js` 与 `arcade.js` 各有一张 `ROOM_ERRS`，表外码一律包成「未知错误（code）」。

### 提示：现在能查什么

辅助面板新增「能查什么」块（见上一节）：可以深查 / 可以问 / 可以去 / 可以勘查，点一条只把名字填进当前动作的输入框（有同名 option 的 select 就选中），**不自动提交**。

### 窄屏

`@media (max-width:860px)` 里 `.verdict em{display:none}` 那条删掉（它把「N / M 项通过」「含 K 项 AI 补全」整块藏了），改缩字号 + 换行；`.rb-acts` 加 `flex-wrap`；680px 下 `.check` 不再压成 76px、座位按钮与线索卡/结局块允许换行不溢出。

## 端到端测试：七玩法 + 材料局全跑一遍（2026-11-20）

四个只读子代理各领两个玩法，只用自建 `sid`（`game-desk-<scheme>-<8位>`）按真实 HTTP 契约跑完整局，跑完 reset；对照 `~/.dsh/storages/dsh-xgame/<sid>/truth.json` 查泄底。共 200×52 / 400×1 / 404×1 / 409×4 / 500×3 状态码，报告落 `tmp/e2e-*.log`。

### 查出来并已修的（插件侧）

| 现象 | 根因 | 修法 |
|---|---|---|
| 议会线索卡永远集不齐、`unlock` 恒 409 | `truth.facts` 6 张，但 `state.exposed` 只由「调查顾问」写（4 顾问上限 4 条），且 `f_spy_enemy/f_spy_court/f_spy_loyal` 是三选一互斥变体 | council 只按顾问 `agendaFact` 出 4 张卡 |
| 跑团线索卡永不点亮 | 拿 quest id（`q_main`）比 `state.questDone`（里面是 objective id `obj_*`），两集合永不相交 | 改按 `q.objectives` 是否全部完成判 |
| 海龟汤死局卡（1 张核心卡）点不亮 | 只认 `state.coreHits`，且有 4 张卡规则无 point；判据又要求 `fact.text` 前八字原样命中 | 再看 `state.questions`；判据加第三档「问题与核心事实重合 ≥2 个 CJK 二元字组」（`gShingles`） |
| 议会「上下没对上」：议院没开就提示可以查 | `hintCouncil` 不读 `state.pending` | 只在 `pending` 存在时给 investigate，已曝光顾问不再列 |
| 跑团提示去不相邻的区域 | `hintTrpg` 的 go 不按 `regions[].adjacent` 过滤 | 按相邻表过滤（老存档无表才全列） |
| 终局后仍提示「还有 N 处没查」 | hints 不看 `phase` | solved/ended 系列回 `ended:true` + 空 sections |
| 密室提示的物件是内部 id（`__outside`/`copper_key`） | 直接用 truth 的键 | `gNamed()` 换人话；并把本房间可拿物品列进「可以拿」 |
| 密室换皮局猜谜题报「没有这个谜题」 | 引擎 `applySkin` 漏换 `puzzles[].name` | 插件侧：唯一谜题按真名替换 |
| 材料局传 `text`/`role` 被忽略、空输入照样烧 token | `arcadeAsk` 只读 `body.input`/`history[].who`，空 input 用「（继续推进）」兜底 | 兼容 `body.text` 与 `history[].role`；空 input 且非 open 直接 400 |
| 正常状态被报成 500 | `xgameCall` catch 一律 `code:500` | 按文案分码：`已结束|开新局`→409，参数/不存在→400，其余 500 |
| `sid` 缺省回落成常量 `game-desk-<scheme>`，多开会互相覆盖 | 无校验 | `sid` 必填且须匹配 `^[a-z][a-z0-9-]{1,47}$`；scheme 必须在动作表里 |
| `loop_move{to:''}` 静默送到 `locations[0]` 并扣时间；去原地也算一次移动 | 无守卫 | 空地名 400、原地 409，两者都不扣时间片 |
| 用量面板高估约 3.2 倍 | `recordModelUsage` 用 `totalTokens`（含 cacheRead） | 账本分开记 `total` 与 `cacheRead` |

### 仍属引擎（`dsh-xgame`）侧、插件改不了的

- `useItem2.giveTo` 写死 `obj_mold`/「铁匠的模具」、`handleDefeat` 写死 `frostpine`/「松针旅店」、`game_start` 简报末句写死「松针旅店的黄昏」、`applySkin` 漏换谜题名 —— 换皮剧本会被这些硬编码污染（插件只兜住「唯一谜题别名」这一条）。
- 拒绝类动作（不存在区域/没钥匙/无战斗 attack）仍回 `ok:true result:"success"`，只能靠文案判断。
- soup 的 `truth.hints` 没有对应工具（`hintsUsed` 恒 0）；我们不给提示以免泄底。
- trpg 的模型用量在 `xgameCall` 里拿不到，接口诚实地回 `usageKnown:false`。

### 复验口径

- `tmp/verify-e2e-fixes2.mjs` 13 PASS / 0 FAIL（海龟汤 1 卡局提问→点亮→unlock；议会 consult 后才有 investigate、investigate 后 `lit 1/4`、已曝光顾问消失；从没开过的 sid → 404；跑团 2 张卡）。
- 跑团正向解锁用合成存档验（复制一份 truth + 把 `questDone` 填成四个 objective id）→ `lit 2/2 complete`、`unlock` 给「主线全貌」。
- 测试口径两个坑，别再踩：①议会 `council_investigate` 必须先在 `council_consult` 之后（`pending` 才非 null）；②`/api/xgame/reset` 只删目录，引擎内存里的对局还在，所以「reset 完再调动作」不等于 `no-game`。

## 改 `dsh-xgame` 本体：清掉跨剧本硬编码（2026-11-20）

引擎把「某一局」的具体名字写进了通用逻辑，换皮/换剧本就会被污染。插件侧只能兜（唯一谜题别名），根治要在 `dist/index.js` 上打补丁：

| 位置 | 原来写死 | 现在 |
|---|---|---|
| `handleDefeat()` | `state.regionId = "frostpine"`、文案「已躺在松针旅店的床上」 | 回 `script.startRegion`（退化用 `regions[0]`），文案用该区域真名 |
| `useItem2()` 的 `giveTo` 分支 | `state.questDone.push("obj_mold")`、文案「任务「铁匠的模具」完成」 | 新增 `giveObjectiveOf(script, state, npc, item)`：优先匹配「未完成 objective 的 desc 里出现了这个 NPC 名或物品名」，否则取第一条未完成的支线目标；文案用该任务真标题 |
| `buildBrief7()` 开场提示 | 「描述松针旅店的黄昏」 | `const startPlace = 起始区域名`，提示改成「描述 `${startPlace}` 的此刻」 |
| `applySkin()` | 只换 `puzzles[].prompt/solveNarrative/hints`，漏了 `name` | 补 `name: repl(p.name)`，换皮局谜题名跟着换，`escape_solve` 才认得 |

- 补丁脚本：`tools/patches/patch-xgame-0.1.2.cjs`（9 个锚点，每个断言「恰好命中 1 次」，已打过会报 SKIP；`--dry` 只验不改）。**它写不进 `node_modules`**：DSH 工作区保护下 agent 子进程是 Low IL，`writeFileSync` 报 EPERM —— 要在用户自己的普通终端跑，或用宿主文件工具按同样锚点手工替换（本次即如此，备份 `dist/index.js.bak-xgamepatch-*`）。
- **升级 `dsh-xgame` 后 dist 会被覆盖**，重跑一次脚本/复核 `tools/patches` 里的锚点即可。
- 复验（`tmp/verify-xgame-patch.mjs`，**10 PASS / 0 FAIL**）：跑团开场提示变成「描述渔村码头的此刻」（不再提松针旅店）；密室换皮局用 truth 里的谜题真名 solve → 回「答案不对(已记一次错误尝试)」而不是「没有这个谜题」；三条代码级断言（动态目标/动态区域/换皮谜题名）全在。
- 引擎里还剩两件事没动（改动会波及语义，先记着）：拒绝类动作仍回 `ok:true result:"success"`（只能靠文案判断）；`soup` 的 `truth.hints` 没有对应工具（`hintsUsed` 恒 0）。

## 纯函数层抽取（2026-11-20，`lib/pure/`）

`lib/index.js` 曾是 5467 行单文件。这一轮把**不读盘、不碰 ctx** 的那部分逐字搬到 `lib/pure/`，路由与 IO 原地不动：

| 模块 | 行数 | 内容 |
|---|---|---|
| `lib/pure/clues.mjs` | 150 | `gNamed / gShingles / gNorm / gList / gHit / gCard / CLUE_MAP`（七玩法的线索卡表与判据） |
| `lib/pure/hints.mjs` | 238 | `HINT_LABELS / HINT_MAX / HINT_DISASTERS / hStr…hLoopNpcHere / hintLoop…hintTrpg / HINT_MAP`（「能查什么」的取数规则） |
| `lib/pure/room.mjs` | 27 | `pickHostWho`（房主判定五参）/ `hostAfterRelease` |

- `lib/index.js` **5467 → 5082 行**，净 `+7 / −392`，只有 4 个 hunk：顶部 3 条 import（+7 行）、以及三处删除。三个模块正文与原文**逐字一致**（脚本去注释头/去 `export ` 前缀后与备份比对，142/142、228/228、21/21 IDENTICAL）。
- 留在 `index.js` 的：`xgameClues` / `xgameHints`（要读 `storages/dsh-xgame/<sid>/`）、`applyHostRelease` / `roomBeat` / `roomPresent`，以及 `canonSeatRoot` / `seatKey` / `seatsOf` / `seatClaim` 等依赖 `rootsFor` 的座位函数 —— 它们不是纯函数，硬拆会变成传一长串参数。
- 取舍说明：`clues.mjs`/`hints.mjs` 的全部导出在 `index.js` 里**全量 import**（虽然本文件只用到 5 个名字），因为旧自检脚本会把 index.js 拷成探针再在末尾 `export { … HINT_MAX … }`，少一个名字探针就报 `Export 'HINT_MAX' is not defined`。等于维持搬移前的符号可见面。
- 两个自检脚本的输入面被这次搬移影响，已各自改一行（都在 `tmp/`，不动插件）：`gd-hostwho-test.mjs` 抓函数源码时把 `lib/pure/room.mjs` 一起读进来；`gd-selftest.mjs` 拷探针时把 `lib/pure` 一并 `cpSync` 进去。修完两者重新全绿（11/0、57/0）。
- 复验（`tmp/verify-pure.mjs` + 手工补一条）：`/api/cases` 24 本、`/api/catalog` 七玩法、pack 的 `/api/screen` 7 项（含 AI 补全标记）、`/api/xgame/hints` 给 `where=旅店大厅 / investigate,talk,go` 且不含泄底面、`/api/xgame/clues` 5 张卡且未发现卡 `text` 为 `null`、房主判定「非嵌入页不抢 / 嵌入页接管 / 本机多窗口折叠 merged=2 / 全员 bye 后 hostWho 清空」全对。
- 自检回归（重载后）：`gd-sec-test` 93/0、`gd-hostwho-test` 11/0、`gd-selftest` 57/0、`gd-seatcanon` 11/0、`gd-hints-test` 22/2、`gd-datafix-test` 59/5 —— 后两个的 FAIL 是搬移前就存在的（数据依赖型断言），一条没增加。

## 前端模块化：`web/lib/` 两个 ES module（2026-11-20）

`web/app.js` 3542 → **3122 行**，抽出两个纯模块（浏览器原生 ESM，无打包器）：

| 模块 | 行数 | 内容 |
|---|---|---|
| `web/lib/util.js` | 161 | `esc / bytes / baseName / ERR_CN / errCn / errHtml / GENRE / DIFF / genreName / diffName / genreOf / diffOf / CN_NUM / playersLabel / playersText / playersRange / CASE_NO / caseNoBase / packNoMap / caseNo / fmtAt / RB_GENRE / genreCn` |
| `web/lib/packview.js` | 288 | `metaLine / scanBadge / packTags / packRank / orderPacks / aiFillItems / aiFillCount / missEffOf / packCompleteState / reviewOf / gdChip / packMissHtml / reviewResultHtml / packReviewHtml / packAiFillHtml / fact` |

- 加载方式：`index.html` 只改了 app.js 那一行 —— `<script type="module" src="app.js"></script>`；`table.js / arcade.js / room.js` 三行保持普通脚本（先执行），app.js 因为 module 是延迟执行，先读到它们的全局。
- **模块后缀用 `.js` 不用 `.mjs`**：插件的静态文件服务按扩展名查 `MIME` 表（`lib/index.js:74`），表里只有 `.js`，`.mjs` 会回 `application/octet-stream`，浏览器对 module script 做严格 MIME 校验，直接拒绝加载（控制台报 `Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "application/octet-stream"`）。要么用 `.js`，要么哪天给它加 `.mjs: text/javascript` 再重载。
- 行为等价证据：`tmp/websplit-parity.mjs` 用**备份版 app.js 的原文切片**当参考实现、真 ESM 当对照，跑 24 条真实 pack 记录：`packTags / metaLine / orderPacks / esc / errCn / genreName / playersText` **7 项全等、0 处差异**；`tmp/websplit-diff.mjs` 逐字核对 packview 的 16 个函数 252 行里只有 6 行不同，全是参数化行。
- 唯一的行为参数化（渲染结果不变）：`LAST_REVIEW` 与 `state.root` 不进模块作用域，改成显式入参 —— `reviewOf(meta, folder, lastReview, root)`、`packReviewHtml(c, meta, ctx)`、`packAiFillHtml(c, meta, ctx)`；app.js 传 `{ lastReview: LAST_REVIEW, root: state.root }`。
- 自检：三个文件 `node --check` 全 0；`tmp/check-gd-audit2.cjs`（假 DOM 真跑 boot）改前改后都是 **47 PASS / 0 FAIL、BOOT: clean**（该脚本按授权改了加载方式：模块源码去 `export`/`import` 后灌进同一 vm 上下文）。
- 真机（1280×800，57467）：剧本杀页 01–09 序号/chips/房间条/档案页四格 facts 全在；双人本合集 24 本标签与排序正常、pack 档案页「缺项 2 / 缺项复核 / 逐项补 2」三块齐全；`?panel=arcade` 七玩法卡与材料局卡正常；两次加载 console 均 0 报错。
- 窄屏（390 / 680 宽，用 iframe 探针量媒体查询）：顶栏按钮换行、房间条 chips/按钮分两行、档案页 facts 2×2、游戏厅卡单列 —— 均可用，未出现横向溢出。
- 备份：`web/app.js.bak-websplit-20261120-015250`、`web/index.html.bak-websplit-20261120-015250`、`tmp/check-gd-audit2.cjs.bak-websplit`。
- 下一步（未做）：`web/app.js` 里剩下的 DOM 绑定层（`renderCase`/`renderList`/`roombarPaint`/`renderSide` 的接线）可以再按「列表 / 档案页 / 房间条 / 对局桥」拆，但那些函数都闭合在 `state` 与 `$()` 上，要拆得先做一个显式的 `ctx` 依赖注入层 —— 属于第二轮，风险比纯渲染层高。
### 第二轮：房间条 → `web/lib/roombar.js`（2026-11-20）

`web/app.js` 3122 → **2641 行**（−481），房间条与「房间设置」弹层整块搬进 `web/lib/roombar.js`（562 行），用**工厂 + 依赖注入**而不是全局：

```js
const rb = createRoombar({ $, api, toast, state, select, loadCases, caseMetaOf,
                           nick, setNick, seatWho, copyText, setBtnBusy,
                           loadRoomBar, loadRemote, reClaimMySeat })
rb.paint(room, via, force)   // 房间条重画（带指纹，同帧不重建）
rb.bind()                    // 按钮事件
```

- 搬入：`lanProbe / lanPaint / loadLan / lanSet / tunnelPaint / tunnelPoll / loadTunnel / tunnelSet / roomPaint / rbChips / rbCaseView / rbLocalCase / nickBtnHtml / nickRowHtml / rbLanBind / rbOpenRoom / rbCloseRoom / rbCopyLink / matchOpen / rbBindActs / bindNick / saveNick / cancelNick / repaintRoomBar / rbHostWho / rbHostHere / rbPersonOne / rbPeopleHtml / roombarPaint`（29 个函数）+ 14 个顶层状态（`RB_VIA / RB_LAST / RB_PENDING / NICK_EDIT / NICK_DRAFT / RB_OPENING / RB_FP / LAN_ON / LAN_PORT / LAN_PROBING / T_POLL / T_FAILS / T_LAST / T_ERR`）。
- 模块内 **0 处** `fetch(` / `document.` / `window.` / `location.` / `localStorage`（grep 证据在交付报告里）：请求只走注入的 `api(path)`，DOM 只走注入的 `$`，昵称与 `gd-who` 仍留在 app.js。
- app.js 只保留 `const rb = createRoombar({…})` 与 6 个同名薄委托（`roombarPaint / roomPaint / loadLan / lanSet / loadTunnel / tunnelSet` → `rb.*`），所以原调用点一行没改。
- 等价性：`tmp/rbmod-parity.mjs` **91 PASS / 0 FAIL** —— 从**备份版 app.js** 切原文当参考实现、新模块当对照：`rbChips 5/5`、`rbCaseView 6/6`、`rbLocalCase 2/2`、`rbHostWho 7/7`、`rbHostHere 7/7`、`rbPersonOne 20/20`、`rbPeopleHtml 7/7`（含单人 local / local+lan / 含 embed 房主三组必需样例）、`nickBtnHtml+nickRowHtml 8/8`、`roombarPaint 12/12`（HTML+hidden）、指纹命中不重建 6/6、昵称编辑守卫 8/8、调用面 smoke 3/3。**行为变更 0 条**（两处只是 `RB_LAST`/`NICK_EDIT` 改成 `rb.current()` / `rb.nickEditing()`）。
- 自检：`node --check` 两文件 0；`tmp/check-gd-audit2.cjs` 现在遍历 `web/lib/*.js` 自动加载，输出 `LIB 模块: util.js, packview.js, roombar.js` / `BOOT: clean` / **PASS 47 / FAIL 0**。
- 真机（1280×800）：房间条正常；点「昵称 · 玩家01zz」→ 编辑行「昵称 [输入框] 保存 取消」出现，点「取消」收回；点「房间设置」→ 弹层完整画出（开关/端口/钥匙/链接/公网隧道/额度/换钥匙/存端口）；console 0 报错。
- 顺手修的体验缺陷：弹层里原来会把 **VMware VMnet8** 的 `http://192.17.1.100:5288/...` 也列出来（手机根本连不上、容易复制错），现在按接口名过滤虚拟网卡（`VMware|VirtualBox|Hyper-V|vEthernet|Tailscale|ZeroTier|Loopback|Bluetooth|Npcap|Wintun|TAP-|VMnet`），全被剔光时才退回前 3 条兜底；实测弹层只剩 `WLAN 2` 一条。
- 备份：`web/app.js.bak-rbmod-20261120-020026`、`tmp/check-gd-audit2.cjs.bak-rbmod-20261120-020026`。
- 还能继续拆的：`renderList`（列表）与 `renderCase`/`renderPack`（档案页）同样闭合在 `state` 上，可以照 `createRoombar` 这个模式各做一个工厂；`renderSide` 之类属于对局室（`room.js`/`arcade.js`），要另开一轮。
### 第三轮：列表与档案页 → `web/lib/listview.js` + `web/lib/packdossier.js`（2026-11-20）

`web/app.js` 2641 → **1822 行**（−819，累计 3542 → 1822，砍掉 48.6%）。

| 新模块 | 行数 | 工厂 | 返回 |
|---|---|---|---|
| `web/lib/listview.js` | 172 | `createListview(deps)` | `render`(=renderList)、`renderChips`、`visible`、`listKeyOf`、`ensurePackCss`、`recomputePackMeta`、`ensurePackTools` |
| `web/lib/packdossier.js` | 761 | `createPackDossier(deps)` | `renderCase`、`renderPack`、`renderScreen`、`refreshActiveScreen`、`contentCard`、`caseMetaOf`、`runPackReview`、`packRecompute`、`packFill`、`packUndo`、`gotoAiFill`、`preview`、`previewUrl`、`closeViewer`、`reveal`、`loadScreen`、`VERDICT` |

- 装配段在 app.js 1514–1572：`var pd = createPackDossier({…})` → `var VERDICT = pd.VERDICT` → `var lv = createListview({…})` → 17 个同名薄委托（`preview(c, rel, kind)`、`packFill(folder, btn, oneKey)`、`packUndo(folder, key, label, btn)`、`runPackReview(folder, btn)` …），签名照旧，页内调用点一行未改。
- `state` / DOM 仍是同一对象引用（写回照旧生效）；`LAST_REVIEW`、`GAPS_AUTO` 留在 app.js，通过 `getLastReview()/getGapsAuto()` 传同一引用；`listDebounce`、`postJson`、`setBtnBusy`、`arcTag` 仍在 app.js。
- 等价性：`tmp/lv-parity.mjs` 拿「备份版单文件 app.js」的原文实现当参考，同一假 DOM + 同一份真实数据（`lv-data.json`：24 本 pack、9 个结构化本、无间追凶的 `/api/case`+`/api/screen`）逐字比较 —— **19 项全 PASS / 0 差异**：列表 24 行（15996B=15996B，逐行逐字）、空书库、搜索过滤命中 1 条、pack 档案页 13017B、结构化档案页、体检块 7 项、chips 动态建节点、`caseMetaOf`、导入预览 `renderPeekPack`（blocked 与 partial 两态）。
- 两道静态体检（顺手补的）：`lv-leftover.cjs` 比对备份里 171 个 IIFE 顶层声明与新 app.js —— **「仍被引用但两边都没有」= 0**，正是它抓出真漏：`renderPeekPack` 还引用已搬走的 `VERDICT` → 运行期必 `ReferenceError`，已用 `pd.VERDICT` 单一来源修好；`lv-deps.cjs` 检查模块侧「缺依赖 0 / 绑了没用 0」。
- 自检：三文件 `node --check` 全 0；`check-gd-audit2.cjs` **47 PASS / 0 FAIL**；`/game-desk/app/lib/listview.js` 与 `packdossier.js` 均 200 + `text/javascript`。

### 第四轮：对局室三件套转 ES module（2026-11-20）

`table.js` 830 → **829 行**、`arcade.js` 774 → **572 行**、`room.js` 221 → **190 行**，新增 `web/lib/arcadeui.js`（228 行，17 个导出：`AUX`/`tablesOf`/`resultText`/`metaOf`/`logHtml`/`chipsHtml`/`selectOpts`/`isSelectField`/`formHtml`/`HINT_LIMIT`/`hintSections`/`hintTotal`/`soupBlock`/`hintBlock`/`clueBlock`/`tablesHtml`/`sideBodyHtml`）与 `web/lib/roomui.js`（42 行，`SCHEME_NAME`/`HINTS`/`titleOf`/`msgHtml`/`logListHtml`/`chipsHtml`）。

- `index.html` L251–253 三行由 `<script src=…>` 改成 `<script type="module" src=…>`，加载顺序 table → arcade → room → app.js 不变（module 按文档序执行）。
- 三个文件由「IIFE + `window.GameXxx={open,close}`」改成模块顶层 + `export function open/close`，**末尾保留兼容垫片** `window.GameTable = { open, close }`（带 `typeof window !== 'undefined'` 守卫），所以 app.js 里 6 处 `window.GameXxx` 一行未改。
- `room.js` 原本不是严格模式，转 module 后在严格模式运行 —— 已 grep 确认无 `arguments`/`with`/八进制。
- 等价性：`tmp/roommod-parity.mjs` **118 项全 PASS / 0 差异**（老实现从 `.bak-roommod-*` 原文在 vm 里跑、用注入尾巴导出内部函数，一个字符没改）：`roomui` 16 项（消息列表 5 种状态、chips、常量表）、`arcadeui` 65 项（右侧栏 3 种状态整块 HTML 逐字、提示块 9 种、汤面 4 种、线索卡 5 种、表单 6 种…）、`table.js` 17 项（座位行 3 种 + 页签 + **正文逐字等价**）、声明/接缝 19 项（搬走的都搬了、没搬的一个没丢、`renderSide` 头尾语句按序全在）。
- 抓到的真 bug：搬运切点把 `var wrap = document.createElement('div')` 一起切掉了 —— 严格模式下这个隐式全局会 `ReferenceError`，一开游戏厅右侧栏就炸；已修（`arcade.js:421`），并为此在 parity 里加了「用了却没声明的局部名」「renderSide 头尾语句全保留」两类检查，正是它们抓到的。
- 三个模块在 Node 里 `import` 成功、`open`/`close` 都是函数、顶层无 DOM/window 副作用。

### 前端当前结构（2026-11-20 收口）

```
web/index.html      256 行
web/app.js         1822 行   ← 入口 module，只做状态与装配
web/table.js        829 行   ← 对局室（module）
web/arcade.js       572 行   ← 游戏厅引擎房（module）
web/room.js         190 行   ← 材料局（module）
web/lib/util.js         161   ← esc/错误码/人数/类型/难度/编号/时间
web/lib/packview.js     288   ← 标签、排序、缺项、复核、AI 补全清单（纯 HTML）
web/lib/listview.js     172   ← 书库列表
web/lib/packdossier.js  761   ← 档案页 + 体检 + 导入预览 + AI 复核/补全动作
web/lib/roombar.js      569   ← 房间条 + 房间设置 + 昵称 + 座位渲染
web/lib/arcadeui.js     228   ← 右侧栏/提示/线索/表单
web/lib/roomui.js        42   ← 材料局消息与 chips
web/*.css            1762 行（style 721 / library 670 / arcade 213 / table 158）
```

真机走查（1280×800，57467）：剧本杀列表 24 本标签排序、pack 档案页（缺项 2 / 缺项复核 / 逐项补 2 / facts / 缓存路径 / 体检）、结构化档案页、`开这一局` → 对局室（座位/页签/线索/笔记/DM 模型）、游戏厅 7 张玩法卡 + 材料局卡、材料局（主持人开场白 + 快捷提问 + 资料列表）、海龟汤引擎房（汤面 / 重大线索 0-1 / 提问记录表 / 辅助面板）——全部正常，console 只有一条 Edge 的 lazy-image info，无报错。

## 后端 IO/领域层拆分（`lib/core` + `lib/services`，2026-11-20）

一句话：`lib/index.js` 从 **5082 行降到 4184 行**（−898），IO/领域层按域搬进 9 个 ES module，**函数正文逐字未改**，依赖靠工厂注入；`name` / `inject` / `ROUTE` / `apply` 四个导出与路由语义一字未动。备份：`lib/index.js.bak-liosplit-20261120-023224`。

### 模块地图

| 文件 | 行 | 放什么 | 注入什么 |
|---|---|---|---|
| `lib/core/paths.mjs` | 47 | `dshHome` `caseRoot` `libraryFile` `usageFile` `modelUsageFile` `packMetaKey` `packMetaDir` `packMetaFile` `textStore` | 无（只读 `DSH_HOME` 环境） |
| `lib/core/names.mjs` | 52 | `TXT_NAME_EXT_RE` `outNameOf` `legacyOutNameOf` `txtNamePlan` | 无 |
| `lib/core/yaml.mjs` | 107 | `stripQuotes` `scalar` `parseCase` `yamlScalar` `blockScalar` | 无 |
| `lib/core/text.mjs` | 64 | `flatText` `tidyParagraph` `CN_DIGIT` `cnNumber` `humanName` `playersGuess` | 无 |
| `lib/core/util.mjs` | 33 | `dirWake` `cloneData` `backupStamp` `kindOf` | 无 |
| `lib/services/textstore.mjs` | 129 | 抽出文本 store + 目录遍历：`storeTxtNames` `inInternalDir` `isAiFillRel` `extractableFile` `scanProgress` `walkFilesEx` `walkFiles` `readTextStore` + `SCAN_TTL_MS` `STORE_NAMES_MEMO` | `createTextStoreService({ ttlMs, storeNamesMemo })` |
| `lib/services/library.mjs` | 133 | `scanCases` `packEntry` `scanRoot` + `SCAN_MEMO` | `createLibraryService({ textstore, memo, ttlMs })` |
| `lib/services/packs.mjs` | 417 | 资料夹体检 + AI 补全元数据：`withPackMeta` `readPackMeta` `writePackMeta` `aiFillItemsOf` `applyAiFillToScreen` `withAiFillMeta` `META_STATE_FIELDS` `preserveMetaState` `firstWord` `detectSide` `detectGenre` `readStoreTexts` `detectSpec` `screenPack` `buildPackMeta` `refreshPackMeta` + PVP/PVE/GENRE 常量 + `PACKMETA_MEMO` | `createPacksService({ textstore, library, memo })` |
| `lib/services/usage.mjs` | 69 | `recordModelUsage` `todayModelUsage` `todayLocal` | 无模块级状态，不需要工厂 |

### 接缝怎么做的

- **工厂 + 注入**：每个 service 导出 `createXService(deps)`（deps 缺省时自己 `new Map()`、取默认 ttl），尾部 `export const xService = createXService()` + `export const { … } = xService`；`index.js` 用**同名 import**，不写薄委托 —— 5000 行里所有调用点一行未改，import 绑定也可以被 tmp 下的自检探针 `export { … }` 再导出（52 个名字实测全在）。
- 模块级缓存（`SCAN_MEMO` / `STORE_NAMES_MEMO` / `PACKMETA_MEMO`）跟着模块走，`index.js` import 它们只为探针能再导出；**全进程只有一份缓存**。
- 依赖方向 `core → textstore → library → packs`，任何模块都不 import `lib/index.js`（无环）。注入改写总共只有 4 行状态常量（`SCAN_TTL_MS = 2500` → `= ttlMs`；三个 `= new Map()` → `= xxx ?? new Map()`，行尾注释原样保留），函数正文逐字搬走、缩进不重排。
- **这一轮没搬**：厂商/LLM 桥接（`xgameCall` / `xgameNarrate` / `dmAsk` / `arcadeAsk` / `caseGaps` / `packReview` / `packFill`，依赖 `ctx.get('llm')` 与 tools）、OCR 全栈、抽取/导入作业机（`EXTRACT_JOBS` / `IMPORT_JOBS` / `startExtract*` / `extractPack` / `importPack` / `importCaseYml`）、`SEATS` / `ROOM` 对局状态机与 `room*` / `seat*`、公网网关（`remoteGate` / `remoteInfo` / `GATE_RULES` / `serveFile` / `copyTree` / `seed`）、`readSettings` / `writeSettings`（只有几行，收益低）。理由一致：闭包强依赖运行期 ctx 与状态，搬过去要造一堆注入，风险大于收益。

### 等价性证据

- `node --check`：`lib/index.js` + 9 个模块全部 exit 0。
- **静态声明比对**（`tmp/liosplit-static.mjs`）：备份里 200 个顶层声明 → 新 `index.js` 133 + 模块内定义；`missing: []`、`movedNotImported: []`、**`referencedButUndefined: []`**（即「仍被引用但哪里都没定义」为 0，上一轮前端拆分抓过真漏的就是这条）；`extra` 只有 6 个新增工厂名。
- **动态等价**（`tmp/liosplit-diff.mjs`，**209 项全 PASS / 0 差异**）：旧侧不是「按名字抠函数源码」，而是把备份 `index.js` 原文当模块直接 import（+`pure/` 副本），跑的就是当年那份代码。覆盖 `outNameOf` / `legacyOutNameOf`（含 `X.jpg` vs `X.pdf` 共享旧名撞名）、`txtNamePlan`（撞名裁决/空 rels/present 空）、`stripQuotes` / `scalar` / `yamlScalar→stripQuotes` 往返（反斜杠、中文、引号、emoji、tab）、`parseCase`（01/02/03 三份真实 `case.yml`）、`walkFilesEx`（假树含内部目录、深度上限、点文件、不存在的根、路径是文件）、`readTextStore`（正常/坏 JSON）、`storeTxtNames`、`recordModelUsage` / `todayModelUsage`（ENOENT/正常/坏 JSON/非数组 + `.bad-` 备份是否生成）、`applyAiFillToScreen` / `withAiFillMeta`（3 份真实 `pack-meta` + 10 组合成边界）。
- **7 个自检脚本与拆分前基线逐项一致**：`gd-sec` 93/0、`gd-seatcanon` 11 条 PASS + 预存在 `seatCountFor is not defined`、`gd-hostwho` 11/0、`gd-hints` 22/2 + 预存在 `reading 'items'`、`gd-datafix` 59/5、`gd-selftest` 57/0、`gd-aifill-route` 4/17 —— PASS 数没降、FAIL 数没增。
- 测试装载两处适配（**只动 `tmp/` 下的自检脚本，不动插件**）：①`lib/core`、`lib/services` 复制到 `tmp/core`、`tmp/services` —— 探针文件写在 `tmp/` 下，相对 import 由那里解析（与上一轮 `pure/` 抽取同一先例）；②`gd-selftest.mjs` 的 `cpSync` 从只拷 `pure` 改成拷 `pure` + `core` + `services`。
## 收掉「已知缺口」里的前三条（2026-11-20）

一句话：离开页面只清**当前这一本**的座位；导入本（08 / 09）在书库列表里也有体检标签；对局室开着时全局座位轮询让位给对局室自己那份。改动走 `tmp/patch-fix3.cjs`（每个锚点断言恰好命中 1 次，逐文件备份 `.bak-fix3-20261120-025157`），四个文件 `node --check` 全 exit 0，重载后实测见下。

### 1. 关页面不再抹掉别的书的座位

- 病灶：`lib/index.js` 的 `bye` 分支原来只 `seatReleaseWho(who)` —— 不带 root/folder，于是同一个人在**所有书**里占的席位一起没了。
- 改法：前端 `web/app.js` 的 sendBeacon body 补 `caseRoot` / `caseFolder`；后端两字段都给了才按书清（`seatReleaseWho(who, root, folder, via)` 本就有 `onlyThisBook` 分支），没带的老客户端仍退回清全部。
- 实测（57467）：同一个 who 在 `01-拾光照相馆` 与 `02-深夜电台` 各占 seat 0 → 对 01 发 bye 后，01 的 `GET /api/seats` 回 0 条、02 仍回 1 条。

### 2. 导入本也挂体检标签

- 病灶：`withPackMeta` 只给 `kind === 'pack'` 挂 meta，导入本（`kind === 'case'`）的体检结论写在 `case.yml` 的 `verdict` / `gaps` 里，列表上什么都看不到。
- 改法：`lib/services/packs.mjs` 新增 `structMetaOf(root, c)`，把 `verdict` / `gaps` 折成与 pack-meta 同形的字段（`source:'case'`、`missing[{key,label,level,detail}]`、`checksSummary`、`complete = missing.length === 0`）；**`verdict` 与 `gaps` 都空的内置模板本返回 `null`** —— 01–07 没有跑过七条判据，不能凭空宣称「全要素」。前端 `web/lib/packview.js` 的 `packTags` 放开 `kind === 'case'`，且 PVP/PVE 判定只对扫描资料夹有口径（导入本 case.yml 里没这一栏，改成显「未标注类型」而不是「未标注」）。
- 实测（列表 DOM）：`08-桐花中路…` = 4 人 / 硬核还原 / 全要素；`09-陶宅夜话` = 2 人 / 未标注类型 / 缺 2 项（title 里带两项 detail：引子可提取、人物剧本可对位）；01–07 仍无标签。

### 3. 座位轮询不再双跑

- 病灶：`web/app.js` 的 `startSeatPoll` 从 boot 起每 12 秒拉一次 `/api/seats` 且不判断对局室是否开着，`web/table.js` 打开时另开一条 12 秒轮询 ⇒ 对局室开着时同一条请求每 6 秒一次。
- 改法：`startSeatPoll` 的轮询体里 `const tbl = $('table'); if (tbl && !tbl.hidden) return` —— 对局室开着就交给 table.js（它还要处理开/关与认领中跳过）。
- 实测（打开对局室后 40 秒的 `/api/seats` 时间戳）：过渡点两条（其中一条是开桌前已经在飞的那次），其后间隔 **11986 / 12003 / 11996 / 12000 ms**，即只剩一条轮询。

## 密室逃脱「能查什么」改成发现制（2026-11-20，m04546）

一句话：右侧「能查什么」不再把当前房间的物件清单摊开，只列**玩家真的碰过**的东西；没碰过的只给一个虚线方块（占位），并提示「还有 N 样没发现」。旧存档（没有 `examined` 字段）退回老行为，不会被一刀切成方块。

### 为什么要改

原来 `hintEscape` 把当前房间的全部 `props`、全部 `items`、所有 `from` 等于本房间的门直接塞进面板 —— 等于把「这间屋里有壁炉/镜子/书桌/西洋钟/斜窗/一盒火柴…」全告诉玩家，谜题还没开始就被剧透。引擎本身有 `/look` 可以把房间看一遍（那是玩家的动作），但侧栏常驻清单等于白送。

### 怎么判「发现」

- **引擎侧记录**（`dsh-xgame` 补丁，脚本 `tools/patches/patch-xgame-seen.cjs`，6 个锚点、幂等、`--apply` 才写盘）：`examine` 命中 prop / item / door 时调 `noteSeen(state, kind, id)`，把 id 记进 `state.examined = { props: [], items: [], doors: [] }`；`escapeEngine.create` 的初始 state 与另一处 state 模板都带上这个字段。
  - 引擎升级后要重跑：`D:\Node\node.exe <插件>\tools\patches\patch-xgame-seen.cjs --apply`（agent 的 pwsh 子进程是 Low IL，写 `node_modules` 会 EPERM，得用普通终端或宿主文件工具）。
  - 已打过会报 `ALREADY-PATCHED`，不会重复插入。
- **插件侧过滤**（`lib/pure/hints.mjs` 的 `hintEscape`）：`state.examined` 里有的才给名字；已经在 `inventory` 里的东西不再出现在「可以拿」；门只有 `examined` 或 `openDoors` 里出现过才给名字。`Object.prototype.hasOwnProperty.call(st, 'examined')` 为假 ⇒ 老存档，退回全列。
- **占位**：新增 `HINT_PH`/`HINT_PH_MAX`（4）/`hPh(n)` —— 每段最多 4 个方块，多出来的合并成一条「还有 N 样没发现」；`hSection` 对 `ph` 条目按序号去重（否则方块长得一样会被合并成 1 个）。
- **前端**（`web/lib/arcadeui.js` 的 `hintBlock`）：`ph` 条目渲染成 `<span class="ar-hint-chip is-ph" aria-hidden="true">`，**不是按钮**、没有 `data-name`，点了不会往输入框填东西；`web/arcade.js` 的点击绑定改成 `.ar-hint-chip:not(.is-ph)`。样式在 `web/arcade.css`（`.ar-hint-chip.is-ph`：虚线、透明底、`cursor:default`、`pointer-events:none`）。

### 验证（端口 56226，自建 sid 后已 reset）

- 新开一局 `game_start`：`state.json` 里 `examined={"props":[],"items":[],"doors":[]}`，`roomId=attic`。
- 首帧 `POST /api/xgame/hints`：`可以拿: [方块] [方块] [方块]`、`可以勘查: [方块]×4 +（还有 2 样没发现）` —— 阁楼 5 个 prop + 1 扇门 = 6 样未发现，4 个方块 +「还有 2 样」对得上。
- `escape_examine {target:"壁炉"}` → `examined.props=["p_fireplace"]` → 面板变 `可以勘查: 壁炉 [方块]×4 [方块](还有 1 样没发现)`。
- `escape_examine {target:"火柴"}` → `可以拿: 一盒火柴 [方块] [方块]`；再 `escape_take {item:"一盒火柴"}` → `inventory=["matches"]`，面板 `可以拿: [方块] [方块]`（拿到手的不会再提示「可以拿」）。
- 老存档 `game-desk-escape-5cp6c8pp`（state 里没有 `examined`）⇒ 面板仍是完整清单（壁炉/镜子/书桌/西洋钟/斜窗/通往书房的门 + 三件物品），确认向后兼容。
- 渲染层用 Node 直接跑 `hintBlock`（7 条断言全 PASS）：6 个 `is-ph` 方块、占位不是 `<button>`、占位没有 `data-name`、真实条目仍是可点按钮、摘要行「还有 2 样没发现」在、`hintTotal` 把方块也算进去。
- `node --check`：`lib/pure/hints.mjs`、`web/lib/arcadeui.js`、`web/arcade.js` 全 exit 0；重载 `include:dsh-xgame` 与 `include:game-desk` 各两次均 applied。

## 发现制推广到另外四个玩法（2026-11-20，m04715）

一句话：密室逃脱那套「碰过才点名、没碰过只给方块」的规矩，现在 detective / party / loop / council 也照做了（trpg 本来就有 `visited`/`conversations` 可用，soup 没有提示面板）。

### 引擎侧补哪里（`tools/patches/patch-xgame-discovered.cjs`，11 个锚点、幂等、`--apply` 才写盘）

脚本会报 `ALREADY-PATCHED`（已打过）或逐个 `SKIP/PATCH`。agent 的 pwsh 子进程是 Low IL，写 `node_modules` 会 EPERM —— 用普通终端跑，或用宿主文件工具按同样锚点手改。引擎升级后要重跑。

| 玩法 | 新增 state 字段 | 记录点 |
|---|---|---|
| detective | `examined: { places: [] }` | `detective_examine` 命中地点时 |
| party | `examined: { places: [] }` | `party_search` 命中场景时 |
| loop | `examined: { places: [], targets: [] }` | `move` 到达地点、`investigate` 真正深查成功（门槛满足之后，复合键 `地点\|目标`） |
| council | `examined: { advisors: [], disasters: [] }` | `council_investigate` 查顾问 / 查灾祸 |

共用 `noteDiscovered(state, kind, key)`（懒建对象，与密室那套 `noteSeen` 同构）。loop 的 `examined` 属元知识，**故意不随世界回滚重置**（回滚只清 items/observed/cutEdges/conversations）。

### 插件侧（`lib/pure/hints.mjs`）

- 新增 `hTracked(st, key)` / `hSeenSet(st, key)`：`state` 里有 `examined[key]` 数组才启用发现制；**旧存档没有这个字段 ⇒ 退回全列老行为**，老局不会突然满屏方块。
- `hintCase`（detective/party 共用）：没搜过的地点只累加占位；搜过的照旧给「还有 N 处没查」。
- `hintLoop`：`investigate` 段按 `地点|目标` 复合键过滤，`go` 段按 `examined.places`（id）过滤；在场 NPC 不隐藏（`/observe` 本来就报在场人，隐藏反而自相矛盾）。
- `hintCouncil`：未查过的顾问/四灾只给方块；查过但没查出事儿的标「已查过」（免得玩家反复花 2 金）；已曝光的顾问仍按老规矩不列。

### 关于「要不要全隐藏」的诚实口径

有几个玩法里，这些名字本来就在别处出现过：detective 开局简报列全「可勘查地点」、party 搜错场景的报错列全场景、trpg `/world` 列全区域（未去过标「未探明」）、council 名册与 `council_investigate` 的工具描述列四个灾名。对这些地方，面板隐藏只是**界面一致性**，不算真防剧透；真正只有玩家自己知道的，是 **loop 的可深查目标**（`/observe` 从不列候选）。

### 验证

- 纯函数（合成数据，`tmp/test-discovered-unit.mjs`）：**18/18 PASS** —— 未搜过全方块、搜过不点名、部分搜到给「还有 N 处」、已查顾问标「已查过」、已曝光顾问不列、未开议会只给 talk、旧存档回退全列。
- 真引擎 + HTTP（`tmp/test-discovered.mjs`，端口 56226，自建 sid 后已 reset）：**29/29 PASS** —— 四个玩法新局 `state.examined` 初始化正确；detective/party 首帧 `search` 段全是方块；`detective_examine 书房` / `party_search 书房` 后 `examined.places` 有记录且面板不再泄漏名字；loop 新局 `go` 段三块方块、`move` 后 `examined.places` 有目标地点；council 未咨询时没有 investigate 段、咨询后出现方块、查完顾问后面板缩小或顾问转曝光；旧存档（`game-desk-detective-mwntc7bv`）仍全列。
- 未能端到端跑到的两处（如实记录）：①loop 的 `investigate` 记录只有「门槛（requires 元知识）已满足」时才会写 —— 现成剧本开局那一格没有这类对象，所以这一条只用代码路径 + 纯函数断言覆盖，没在真局里点亮过；②party 的占位数量在本次剧本里没变化（搜过的那个地点本来没有线索记录，两种模式下都不出现在列表里），所以断言只到「不泄漏名字、数量不增长」。
- `node --check`：`dist/index.js`（拷成 `.mjs` 后检查）、`lib/pure/hints.mjs` 全 exit 0；重载 `include:dsh-xgame` 与 `include:game-desk` 各两次均 applied。

## 有文字层的 PDF 不要用 OCR（2026-11-20，m04715 实测）

同一批 3 份有文字层的 PDF（共 30,968 字，都是本地剧本手册）：

| 走法 | 耗时 | 出字 |
|---|---|---|
| `pdfToText()`（pypdf，失败退 fitz）逐份跑 | **1,302 ms** | **30,968 字** |
| PaddleOCR（`--engine paddle`，3 份一批，GPU） | **46,294 ms**（含模型初始化，纯推理 17,356 ms） | 13,308 字 |

**慢 35 倍，还少抽 57% 的字**（版面底色、水印、分栏会让 OCR 漏行）。所以导入链路的三段式分流是对的，别动：文本类直接读文件 → PDF 先 `pdfToText()` → **只有抽出来是空的（或本来就是图片）才进 OCR**。游戏厅的材料局也没有单独的 OCR 通道，它复用同一份文本缓存。

## 游戏厅：手写导入一条内容（2026-11-20）

以前往游戏厅加内容只有一条路：先建一个资料夹、跑抽字、登记成「材料局」卡。海龟汤这种「一碗汤面 + 一碗汤底」的小东西，为此建资料夹太绕。现在 `POST /api/arcade` 多认一种请求体：**没有 `folder`、带 `text`** 的请求就是「手写一条」，直接落成一个普通条目，不碰资料夹、不抽字。

### 请求体

```json
{ "scheme": "soup",
  "title": "雪夜的汤",
  "text": "一碗热汤面端上来，客人只喝了一口就起身跳楼了，为什么？",
  "truth": "汤里漂着的是他妻子的遗物——那场山难里唯一没找到的东西。",
  "players": "1 人" }
```

`scheme` 七选一：soup / detective / escape / party / loop / council / trpg。`truth`（汤底/真相/凶手/解法）和 `players` 都可选。

### 校验与上限（`arcadeCreateHand`）

| 字段 | 规则 |
|---|---|
| scheme | 必须在这七种里，否则 400 `scheme 不在七种玩法里：…` |
| title | trim 后必填，空 → 400 `title 必填`；超过 30 字截断 |
| text | trim 后至少 10 字，否则 400 `内容太短（至少 10 字）`；超过 60000 字截断 |
| truth | 可选；超过 20000 字截断 |
| players | 可选，原样写进 arcade.yml |

编号沿用清单的规矩：两位数字递增、取最小空号，`folder = <id>-<去掉非法字符的标题>`（非法字符是 `\ / : * ? " < > |`）。清单读回来的 id 是归一过的（yml 里的 `"01"` 会变成 `1`），所以新条目按数字比，不会撞出两个同号；同名的残留目录（没有 arcade.yml 的目录）也会被跳过。

### 落盘结构

```
<arcadeRoot>/<id>-<title>/
├── arcade.yml          note: 手写导入，source_root / source_folder 留空
└── _source/main.md     正文 + 可选汤底（就这一份）
```

`main.md` 的形状：

```
# <title>
（玩法：<scheme> · 手写导入 · <ISO 时间>）

## 材料
<text>

## 汤底 / 真相（主持人专用：不得原样透给玩家）
<truth>
```

没给 `truth` 就没有最后那一段。整份文件压在 60000 字以内（材料超了先截材料，汤底完整保留）—— `arcadeMaterial` 对这类条目是整份读 `_source/main.md`，上限就是 60000 字。

### 主持人能不能看到汤底

**能，而且是故意的。** `POST /api/arcade/ask` 的材料（`arcadeMaterial`）对这类条目直接读整份 `_source/main.md`，汤底段也在 system prompt 里 —— 主持人不知道真相就判不了「是 / 否 / 无关」。代价是：凡是能让模型开这一局的入口，模型都拿到了答案；玩家侧看到的只是模型的台词，汤底不会原样出现在对局里（`ARCADE_TAIL` 第一条就要求重新组织、不许原文照念）。想让某个真相连模型都看不到，就别写进 `truth`。

顺带修了一个会漏字的地方：`arcadeChars` 原来只数 `_text` 与 `_source/case.yml`，手写条目没有 `_text` 会显示 0 字，现在补了 `_source/main.md` 的字数回退（只认这个文件名，老资料夹条目的字数口径不变）。

### 返回与其它路由

`200 { ok: true, entry: { folder, id, title, scheme, players, note: "手写导入", chars, files, updated: false } }`，`chars` / `files` 与 `GET /api/arcade` 同口径（chars 是 `main.md` 的字节数，不是字符数）。`GET /api/arcade` 直接列得出来；`POST /api/arcade/delete` 按 folder 删目录，照常可用（不依赖已经留空的 source_root）。

**资料夹导入仍然照旧**：只要请求里带 `folder`，走的就是老的 `arcadeImportPack` 链路（选资料夹 → 抽字 → 登记 → needsText），老的 `{root, folder, scheme, title, players}` 行为一字未改，两条链路不互相借道（带 folder 又带 text 也只当资料夹导入）。

自检：`tmp/gd-arcadenew-test.mjs`（DSH_HOME 指到 tmp 沙盒、假 ctx、假 llm）**58/58 PASS**，覆盖资料夹导入照旧、正常建条目、目录结构、arcade.yml 字段、id 递增与撞号、四个 400 分支、title 截断、truth 缺省/存在、ask 的 system prompt 带汤底、60000 字上限、GET 读回、delete。

## 游戏厅：每个玩法卡上都能导入 + 手写一条（2026-11-20，m04864）

### 前端
- 七张玩法卡各带一个右上角「＋导入」（`.mode-wrap` 包一层 + 绝对定位的 `.mode-imp`，因为 button 里不能嵌 button）。点哪张卡的＋导入，导入弹层就预选那个玩法，顶部提示「这份会归到「X」」；海龟汤默认落在「手写一条」页签，其它玩法默认「从资料夹导入」。
- 导入弹层加两个页签：**从资料夹导入**（原有 `#a-path` 扫描抽字那套，一字未改）与 **手写一条**（标题 / 玩法 / 人数 / 材料正文 / 汤底·真相，两段 textarea）。
- 内容库卡片上的玩法名改中文（`材料 2 / 海龟汤`），不再显示 `soup` 这种内部 id。
- 顶栏「导入内容」与列表末尾的「导入内容」卡保持老行为（不预选玩法、资料夹页签、焦点在路径框）。

### 手写导入的后端形态
`POST /api/arcade` 多认一种请求体（不带 folder、带 text 就走手写链路）：

```json
{ "scheme": "soup", "title": "一碗汤", "text": "汤面正文…", "truth": "汤底（可空）", "players": "1 人" }
```

- 校验：scheme 必须是七种之一；title 必填截 30 字；text ≥10 字、截 60000 字；truth 截 20000 字。
- 落盘：`arcadeRoot()/<两位id>-<安全标题>/_source/main.md` + `arcade.yml`（note=`手写导入`，来源 root/folder 留空）。
- `main.md` 形状：`# 标题` → 玩法/时间 → `## 材料` → `## 汤底 / 真相（主持人专用：不得原样透给玩家）`。汤底进 system prompt（主持人要判得对），但 ARCADE_RULES 要求它不原样透给玩家。
- `arcadeMaterial` 对手写条目整份读 60000 字（通用回退每份 8000 字会砍掉文件尾部的汤底）。
- 测试：`POST /api/arcade {scheme:'soup',title,text,truth}` → 出现在 `GET /api/arcade` → `POST /api/arcade/ask {folder,open:true}` 主持人用材料+汤底开场 → `POST /api/arcade/delete` 能删。

### 已知口径
- `GET /api/arcade` 里 `id` 是归一后的数字（`"1"` 而不是 `"01"`），目录名才是两位补零。
- 手写条目的 `chars` 是 `main.md` 的**字节数**（中文 3 字节/字），与老条目同口径。
- 前端是静态文件：改完刷新页面即生效（宿主 `lib/index.js` 改动仍需重载插件）。

## 游戏厅：自动识文字 + 一篇一条 + 随机挑一篇（2026-11-20，m05055 / m05164）

用户要的是「导入进去的文件自己识文字、自己归类好，一篇一篇的，每次重开随机挑一篇」。

### 导入弹层的「自动整理」开关（默认勾选）
- 只在**从资料夹导入**页签下生效。勾着点「登记进内容库」时，前端不再走 `POST /api/arcade`（整包一条），
  而是 `POST /api/arcade/auto {root, folder, scheme}`（**202**，后台任务），再每 1.4 秒轮询
  `GET /api/arcade/auto/status`，把 `phase/rel/done/total` 画进弹层进度条。
- 后端 `startArcadeAuto()` / `arcadeAutoRun()`（lib/index.js）：一份内容 = **一个子资料夹**
  （`arcadeAutoPieces()`；没有子资料夹时整包算一份），逐个资料夹：
  1. 文件全递归列出（`arcadeListFiles()`，深度 ≤6）；
  2. 文字来源三级：`readTextStore(root,folder)` 的现成缓存（免费）→ `.txt` 直读 → 图片/PDF 走
     `ocrMany()`（引擎 = `resolveOcrEngine()`，默认 paddle GPU 档）；
  3. 命名分类：文件名含 `汤底|真相|答案|解答|复盘` → truth；含 `额外|补充` → 材料里的「## 额外补充」；
     其余（`汤面*`、正文、图片、PDF）→ 材料正文；
  4. 每篇调 `arcadeCreateHand()` 落成一条独立条目（`_source/main.md` + `arcade.yml`），
     标题去掉尾部 ` sasili` 并在 30 字内。
- **去重**：开跑前把内容库已有标题读成集合，同名直接进 `skipped`（重导同一批不会再生成一套重复卡）。
- 状态机：`ARCADE_AUTO = {running, phase('scan'|'ocr'|'done'|'error'), done, total, rel, made[], failed[], skipped[], error, startedAt, endedAt}`；
  并发保护：已有任务在跑时再起一个回 **409**。
- 实测：①带文字缓存的 12 篇合集 → 12 篇全部 skipped（0 新建）、耗时 <5 秒；
  ②没有缓存的两个子资料夹（3 张真实扫描 jpg）→ 25.7 秒 OCR 出字、建成 2 条（699 / 1218 字节），
  其中一条 `POST /api/arcade/ask {open:true}` 当场开局成功（758 tokens，汤面正确）；
  ③真浏览器走完整链路：填路径 → 扫描 → 登记 → toast「已整理成 2 篇」→ 列表 14→16 条、新卡出现（console 0 报错）。

### 玩法卡右下角「随机 N」
- `renderArcade()` 会数一下内容库里该玩法有几条，有就渲染 `<button class="mode-rand" data-rand="<id>">随机 N</button>`
  （`.mode-rand` 绝对定位在卡片右下角，与右上角「＋导入」对称）。
- 点击 → `POST /api/arcade/random {scheme}`（后端从 `scanArcade()` 里按 scheme 过滤后等概率取一条）
  → 直接 `window.GameRoom.open(entry)` 开材料局，toast「随机开：<标题>」。**每点一次换一篇**。
- 实测（真浏览器）：海龟汤卡显示「随机 13」、侦探卡「随机 1」、其余玩法（库里没有内容）不显示；
  点海龟汤的随机 → toast「随机开：屠户 本红」+ 材料局标题栏「材料局 / 屠户 本红 · 海龟汤」，
  主持人当场端出汤面。

> 2026-11-20 20:13 起这个按钮改成玩法卡右下角的「更多 N」，点开是一张列出该玩法全部内容的弹层，
> 不再直接随机开一篇（弹层里仍有「随机开一篇」）——见本文后面「内容卡不铺网格了」那一节。

### 还提供了「拆分」（同一天，m05055）
`POST /api/arcade/split {folder, remove?}`：把一个装了多份内容的条目（`_text` 里 `*_汤面*.txt` 成对
`*_汤底*.txt`）按场景拆成独立条目；内容卡上对 `scheme==='soup' && files>=4` 的条目显示「拆分」按钮。
幂等：同名条目已存在就跳过、回 `{ok:true, made:0, skipped:[...], already:true}`。
本次已把 `01-海龟汤合集`（31 个文本 / 12 碗汤，含 `God 变红` 的三汤面 + 两汤底）拆成 12 条，
原合集条目保留（想删自己删）。

## 人物剧本按幕给图：翻到第几幕，只开第几幕（2026-11-20，m00504）

用户要的是「人物剧本在每一幕开放之后再给，不是一次性全给出来；而且给图片，不是全文字解说」。
改法分三层，宿主与前端各一半：

### 一、切幕（纯函数，`lib/services/scriptacts.mjs`）
- `splitPages(text)`：抽字结果是按页用 `\n\f\n` 拼的（`lib/index.js` 的 pypdf 路径），`\f` 就是页界。
- `parseActMarks(pages)`：只认**独占一行、去掉空白 ≤24 字**的 `第N幕`（中文数字、阿拉伯数字都吃），
  行太长（比如正文里叙述「第一幕的时候……」）不算 —— 这条限制是为了别把台词切成幕。
- `buildActs(marks, pageCount)`：同一幕号只认**第一次**出现；第一幕固定从第 1 页起；两幕落在同一页就钳到该页开头；
  遇到「完成前不要翻页」这类字样跳过。
- `actAt(acts, n)` 越界钳到最后一幕并给一句 note（前端会 toast 出来）。
- 四本导入本实测页界：程希 1-5 / 6-9 / 10-20、陶苏 1-8 / 9-13 / 14-20、江岷与金阅川 1-5 / 6-13 / 14-19。
  **真相手册里的「第 N 幕真相解析」不能拿来当角色本的幕界**（手册是分幕解说，角色本才是连续页码）。

### 二、按幕取页 + 渲图（`lib/index.js`）
- `GET /api/script?root&folder&rel&act` → `scriptInfo()`：
  `{ok, rel, name, source:'pdf'|'text', split, act, actCount, acts:[{act,label,from,to,pages}], pages:[{page,url}], text?, note?, textMissing?}`。
- 切不开幕（扫描件没抽字 / 没有「第N幕」标题）的 **PDF 也不再退回阅读器**：`pdfPageCount()` 调
  `script-pages.py <pdf> --info` 问总页数（按 PDF mtime 缓存），把 1..N 全部按页渲成图返回（`whole:true`），
  只是不声称按幕切了。用户口径是「要图，不要 PDF 嵌页」。
- 只有 md/txt 切不开（纯文字本没有幕标题）、或连页数都问不出来时，前端才退回 `loadDoc` 整份原文。
- `GET /api/page?root&folder&rel&page` → `lib/script-pages.py`（PyMuPDF，`SCRIPT_DPI = 130`）渲成
  `p<N>.jpg`（q88）；缓存目录 `~/.dsh/game-desk/pages/<sha1(root|folder|rel) 前 16>/p<N>.jpg`，
  失效条件三个：PDF 的 `mtimeMs`、dpi、格式后缀任一变化就整目录删掉重渲。
- **格式选 JPEG 是实测出来的**：同一页 130dpi 的 PNG 3.0MB、JPEG q88 345KB，一页 5 张图差 20 倍流量，
  手机上翻开一页要等十几秒；画质在 130dpi 下肉眼看不出差别。
- 两条路由进 `GATE_RULES` 的 `script:'any'`、`page:'any'`（只读，访客也能看自己的本）。
- **踩过的坑**：`readTextStore(root,folder)` 读的是 `~/.dsh/game-desk/text` 那份缓存，
  而导入本的文字在 `<case>/_text/*.txt`；一开始用前者，09/10 两本全被判成「还没抽出文字」。
  现在的 `caseTextList()` 先看 `<case>/_text`，再退回缓存。

### 三、对局室（`web/table.js` + `web/table.css`）
- 「人物剧本」页签里原来 `loadDoc(s.file, …)` 一摊到底；现在 `loadScript(s, holder)`：
  抬头「第 N 幕 / M 幕 · 角色名 · 本幕 K 页」+ 一行「按幕开放：这里只有当前这一幕 —— 用上方「第 N 幕」往后翻」，
  下面是本幕每一页一张 `<figure class="pg"><img loading="lazy">`，图注只有「第 N 页」。
- `step(n)`（上一幕 / 下一幕）原来只重画顶栏；现在如果正停在「人物剧本」或「流程」页签，会 `renderMain()` 一次，
  否则翻幕之后画面还停在上一幕的图上。
- 切不开幕的 PDF 走另一支：抬头变成「整份 · 角色名 · N 页」，只有一条说明（不再叠两行提示），
  下面同样是逐页 `<figure class="pg">`。
- 实测（假宿主 + 真 Edge，`tmp/gd-acts-e2e.mjs`）：09-陶宅夜话·程希 第 1 幕 → 5 张图全部 `naturalWidth > 0`；
  点「下一幕」→ 抬头变「第 2 幕 / 3 幕 程希 4 页」、图片换成第 6 页起（`page=6,7…`），0 页面报错。
- 实测（`tmp/gd-whole-e2e.mjs`，2026-11-20 追问后补）：08-桐花中路私立协济医院怪谈·健美女人（4 页扫描件、
  `_text` 里没有抽字）→ 抬头「整份 健美女人 4 页」、4 张图全部 `naturalWidth = 759`、
  说明「这份剧本还没抽出文字，按幕切不开 —— 先把整份按页给你（4 页）」，0 页面报错。
  后端同一本：`/api/script` 回 `{split:false, whole:true, pages:[1,2,3,4]}`，`/api/page?page=1` 168KB JPEG（第二次 16ms 命中缓存）。

## 对局室白板：一张纸，两种模式（自由画板 / 卡片白板）+ 自己搭的表格（2026-11-20，m01037 + m01053）

用户原话（m01037）：「加一个画板，再加一个游戏厅里面那种表格，两个的目的都是模拟线下玩剧本杀的白板，画板为自由画板，
表格可以自己创建，不设置具体内容，由玩家自己创建并选择表头等内容，比如说在哪个时间哪个人在做什么这种」；
随后补一句（m01053）：「自由画板要给一个创建文件的选项用来做类似思维导图的东西，也要有自由画板，两个功能都集成在一起」
—— 所以不是两个页面，是**同一块画布两种模式**：`自由画板` 用笔，`白板`（原「思维导图」）用卡片和连线，笔迹一直留在底下（线上开会时白板也是这么用的）。

### 一、放哪儿、存在哪儿
- 对局室页签变成 8 个：对局 / 引子 / 正文 / 人物剧本 / 流程 / **白板** / **表格** / 资料（`table.js` 的 `TABS`，白板表格在流程之后）。
- 画板：`localStorage["gd:board:<root>|<folder>"]` = `{mode,color,width,eraser,strokes:[{c,w,e,pts}],nodes:[{id,px,py,pw,ph,k,text}],links:[{a,b}],view:{x,y,z}}`。
  笔迹仍是归一化坐标（0–1，按世界画布宽高），笔画宽度也存相对宽（`wN = px / rect.width`），所以换窗口、换手机再打开，画面和粗细都不变形；
  卡片改用**世界像素**（`px/py/pw/ph`，默认 220×132），因为要能缩放、能拖右下角改大小（2026-11-21 起；旧数据由 `wbMigrate()` 一次性换算，见下一节）。
- 表格：`localStorage["gd:grids:<root>|<folder>"]` = `{grids:[{id,title,cols,rows}]}`。一个本子一份，换本子互不干扰；落笔/打字都是防抖存（画板 350ms、表格 300ms）。

### 二、自由画板
- 工具条：`自由画板 / 白板` 切换、5 个颜色（墨黑 `#1a1710`、朱红 `#a63a2b`、赭金 `#a9843c`、松绿 `#3d5a4a`、靛蓝 `#2f4d7a`）、三档粗细（细 2 / 中 4.5 / 粗 8）、橡皮、撤销、清空、**拖动**（指针模式，见下一节）、导出 PNG。
- 笔迹是点序列（`pts` 归一化），`pointerdown/move/up` 一路记，抬起才落盘；橡皮不是擦数据，而是给这一笔记 `e:true`，绘制时 `destination-out` —— 所以撤销能把它当一笔撤掉。
- 导出 PNG 1600×1000：先透明层画笔画，再压纸色，接着画连线（边框到边框的直线 + 终点箭头，和屏幕上同一套 `wbEdge`/`wbLinkDraw`），最后把卡片（按 Obsidian 配色填底、矩形 + 24px serif 文字，最多 4 行）画上去，文件名「白板-<本名>.png」。

### 三、思维导图（同一张纸）
- 双击空白 → 出一张卡（默认「新想法」）；拖卡片移动（3px 阈值，避免手抖就跳）；双击卡片就地改字（contenteditable，Enter 收）；
- 「连线」进连线态，点两张卡连一条（重复连线去重、自己连自己忽略）；「删除选中」删卡或删线；「清空导图」只清卡片和线，不碰笔迹。
- 连线按卡片**当前**位置算（`wbPaintLinks` 直接读 `offsetLeft/Top/Width/Height`，不受缩放影响），两端各取「朝向对方」的边框交点（`wbEdge`），中间是**一条直线**，箭头只画在**终点**那一头：先按下的卡是起点，所以「左拖到右」箭头在右边，「右拖到左」箭头在左边（点两张卡时按点击顺序定方向）。
  连线的三种手势：点「连线」后**从起点卡拖到终点卡**、点起点卡再点终点卡、或者直接从卡片四边的小圆点拖出去。
  **怎么好连**：鼠标移到卡片上，四边中点冒出四个小圆点（`table.css` 的 `.wb-hdl`），从任意一个圆点直接拖到另一张卡就成一条线——不用先点「连线」；拖的时候有红虚线跟着指针、落点那张卡会高亮（`.wb-node.is-drop`），松手才落定。
  历史上这里改过四次：最初是从卡片中心画二次贝塞尔、向中垂方向鼓 `min(46, 长度×0.18)` 像素（用户截图说「像没搭上」）；后来改成边框到边框的直线（用户说「连线不太行，直接首尾相连就可以」）；再后来试过 S 形贝塞尔 + 四边端口（用户 m01760：「现在的效果还是不好」）；最后按 Obsidian Canvas 重做整块画布，连线定稿为「边框到边框的直线 + 终点箭头」。

### 四、表格：给「时间 / 人物 / 地点 / 做什么」这种白板留的
- 空态两个按钮：`＋ 时间线表`（预设表头 时间 / 人物 / 地点 / 做什么，3 行空）与 `＋ 空白表`（3×3，表头也能改）。
- 表头、标题、每一格都是 contenteditable，点一下就能写；`＋列` 在表头右边，`＋行` 在表尾，行尾/表头各有 `×` 删行删列，`删表` 在表头右上。
- 行、列都至少留 1（删到只剩一行/一列时按钮不再动），粘进来的富文本会被压成纯文本（否则会把网页样式一起贴进格子）。

### 五、实测（真 Edge，`tmp/gd-board-e2e.mjs`，1440×980，09-陶宅夜话）
- 画板 676×423；两笔 `strokes=2`（每笔 13 个点）；换朱红+粗后第 3 笔 `c=#a63a2b`、`w=0.01187`；橡皮后第 4 笔 `e:true`；撤销回到 3 笔；导出「白板-陶宅夜话.png」72483 字节。
- 卡片白板：双击空白出 2 张卡、双击第一张改成「凶手的动机」（落盘 `texts=["凶手的动机","新想法"]`）、连线 `links=1`；刷新重开本子后 `mode=map`、`nodes=2`、`strokes=3`、canvas 非透明像素 7396（笔迹确实重绘出来了）。
- 表格：时间线模板表头 `[时间,人物,地点,做什么]`、3 行 12 格；把表头改成「几点」、把「程希」填进第二列 → 落盘；再加 1 行 1 列后 `4 行 × 5 列`；空白表 3 列；刷新后 2 张表仍在；删 1 行 1 列 + 删 1 张表后 `3 行 × 4 列`。
- 手机 390 宽：画布 400×300（`aspect-ratio: 4/3`，`min-height: 300px`），工具条自动换行。pageerror 0，console 只有 favicon 404。

### 六、踩过的两个坑（e2e 抓出来的）
1. **双击卡片改不了字**：`wbNodeClick()` 当时无条件 `wbRenderNodes()` 重建卡片 DOM，刚点中的那个元素被换掉，紧接着的 `dblclick` 落在已被丢弃的旧节点上。改成 `wbPaintSel()` —— 只切 `is-sel` / `is-from` 两个 class，不重建。
2. **「＋列」一次加四列、「删列」一次删两列**：`#tbl-body` 是常驻元素，`boxGrids()` 每画一次就 `addEventListener` 一次，点一下等于四个监听器各跑一遍（首轮实测加 1 列变 8 列）。改成 `bindGrids()` 开头 `if (box.getAttribute("data-gbound") === "1") return`，只绑一次。

### 七、有意留白
- 单张世界画布 2400×1500（不是真无限：拖到更远就靠平移找回来），没有图片贴入、没有分组；导出只出 PNG，不导出可编辑文件。
- 白板与表格都是**本机 localStorage**，不进本子文件、不同步给其他人 —— 谁开这一本，谁看到自己那张纸。要「全桌共用一张白板」得另做服务端。

## 白板重做成 Obsidian Canvas 那种：能拖能缩，卡片能改大小（2026-11-21，m01756 + m01760）

用户原话：m01756「看一下 obsidian 的那个白板，就用那种类型的」，m01760「现在的效果还是不好」——
上一版是「固定 16:10 的画布 + 归一化卡片」，看着像一张截图，不像能一直往上放东西的板子。

### 画布：一块 2400×1500 的世界，外面是取景框
- `WB_W=2400`、`WB_H=1500` 世界像素；`#wb-world` 按 `WB.view={x,y,z}` 做 `transform: translate(x,y) scale(z)`，
  卡片与笔迹全画在世界坐标里，缩放/平移只动这一层。
- 滚轮缩放（`.wb` 上 `wheel`，`passive:false`）：`f = Math.exp(-deltaY * 0.0016)`，以指针为锚 `wbZoomAt()`，`z` 夹在 0.2–3。
- 平移：画布空白处按住——卡片模式左键，或任意模式右键/中键；移动超过 3px 才算拖，没移动的左键点击在卡片模式顺手清选中。
- **手势挂在取景框上，不是挂在 canvas 上**（`wbBind()` 里的 `var frame = $('wb') || cv`）：世界只有 2400×1500，缩到 26% 摆一摆，四周就会露出世界外的空白。挂在 canvas 上时那块没有监听，拖不动，看着像「把左上角那张卡当成了边界」（用户 m02288 的原话猜对了）。现在 `pointerdown` / `dblclick` 都挂在 `.wb` 上，`ev.target.closest('.wb-zoom')` 早退免得点缩放按钮也算拖画布；画板落笔时起点钳到 0–1，从世界外起笔画出来也落在纸内。
- 左下角浮层 `− 100% ＋`：中间那个百分比是「适应窗口」（`wbFit()`）—— **有卡片/笔画就框住它们的并集**（外面留 90 世界像素，`z` 夹 0.18–1.6），**空板按 100% 摆在世界中间** —— 否则一进来缩成 26%，卡片上的字小到看不清（第一版就是这样，被截图抓到）。`−` / `＋` 是以视口中心为锚的 0.8 / 1.25 倍。
- **白板和表格页签会把整页放宽**：`.tbl-page.is-wide` 把 1240px 上限提到 1760px，网格列从 `196 / 1fr / 268` 改成 `180 / 1fr / 250`，画板高度 `min(calc(100vh - 248px), 820px)`（最小 460px）。1440×980 窗口实测画板从 676×423 变成 **910×732**，1920×1080 是 **1230×820**，390 宽手机是 362×490。
- 点阵底纹铺在 `.wb` 上（`radial-gradient` 22px），**不随缩放走**；观感接近 Obsidian，但严格说没做到点阵跟手，记在这里免得后来人当 bug。

### 画笔和指针：左键到底是画还是拖
- 画板模式默认左键 = 画笔；工具条里那个「✋ 拖动」把它反过来：左键拖画布就平移，光标从十字变抓手（`grab` / 拖动时 `grabbing`），笔画一笔都不会多。
- 再点一下（此时按钮写「✎ 画笔」）回到画笔，光标恢复十字。这个开关跟着板子存（`WB.pan`），下次打开还是上次那个手。
- **指针模式不是「只能平移」**：开着它的时候，卡片和「白板」模式里一模一样 —— 卡片上光标是 `move`、能拖着挪、能双击改字、右下角能改大小、四边圆点能拖出连线、点一下能选中（选中后色块改的是这张卡）。区别只有一处：左键在空白处是平移而不是画线，也不靠双击空白建卡（建卡回「白板」模式）。
- 代码上这是两处小口子：`wbCardOn()`（`WB.mode === 'map' || !!WB.pan`）替掉卡片 / 圆点 / 右下角 / 双击四处原来的 `WB.mode !== 'map'` 守卫；CSS 加 `.wb[data-mode="draw"][data-pan="1"] .wb-node { pointer-events: auto; }` 把画板模式默认的 `pointer-events: none` 破一个口。翻幕、换模式都走 `boxBoard()` 重建，所以状态跟着 `WB.pan` 走。
- 右键 / 中键拖动在两种模式下都一直能平移，不用先切指针。

### 卡片：拖动、改大小、七色
- 双击空白出一张卡（默认 220×132，落在指针处）；拖动改 `px/py`（位移除以 `z`，所以缩到 26% 拖也跟手）。
- 右下角 14px 的 `.wb-rz` 拖出大小（120–720 宽、64–520 高），内容超出时在卡内自己滚（`.wb-node-t`）。
- 七色（`data-wbnk` → `k-red` 等）：Obsidian 的 red / orange / yellow / green / cyan / purple + 默认纸色；
  有选中就改选中那张，否则改「下一张新卡的默认色」。浅底 + 深描边，不是纯色块。
- 双击卡内改字仍是 `contenteditable`（`wbEditNode`）；选中描边 `is-sel`、连线起点 `is-from`。
- 起点在卡片上，动的就是卡片（拖、改大小、拖连线）；要平移画布得从空白处或按住右键起手 —— 这是照 Obsidian 的手感，`tmp/gd-carddrag-e2e.mjs` 把六种手势都跑了一遍（卡片中间/文字区/右下角/大位移都动卡，空白与右键拖动画布）。
- **文字不会再把拖动抢走**：卡片文字 `user-select: none`（只有 `contenteditable="true"` 时才 `text`），`.wb` 上 `dragstart` 直接 `preventDefault` —— 否则文字被选中后按住会起原生拖拽，`pointermove` 不再来，画布/卡片都拖不动，看着就是「拖一下变成选中」。`wbEditNode` 收工时也不再 `wbRenderNodes()`：blur 常发生在 pointerdown 捕获阶段，重建卡片会把正在按下的元素换掉，同样会「选了但拖不动」。
- **改完字点画布/别的卡就收工**：canvas 的 `pointerdown` 会 `preventDefault`，焦点不会自己离开，不显式 `blur` 就会一直停在 `contenteditable` 里（文字保持全选高亮、继续打字还在改那张卡）。`wbBind()` 在 `.wb` 上加了捕获阶段的 `pointerdown`：目标不在正在编辑的那张卡里就 `blur()`，`wbEditNode` 的 `blur` 回调负责落盘并重画。

### 连线：边框到边框的一条直线，箭头只在终点
- `wbEdge(cx,cy,hw,hh,tx,ty)` 从卡片中心朝对方求矩形交点，`wbLinkDraw` 连直线、终点画箭头（`wbArrow`，`ah=8`、`aw=4.6`）。
- 三种手势都在：四边中点小圆点直接拖出去（拖时红虚线 + 落点卡 `.is-drop` 高亮）、点「连线」后拖卡、点两张卡；方向 = 起点卡 → 终点卡。
- 缩放不影响连线：`wbPaintLinks` 用 `offsetLeft/Top/Width/Height`，这是世界坐标里的布局值，不随 `transform` 变。

### 旧数据怎么上来
- 旧版 `{x,y,w,h}` 是 0–1 归一化，新版是 `{px,py,pw,ph}` 世界像素。`wbMigrate()` 在第一次打开时用当时 `#wb` 的 rect 换算
  （`pw = max(120, w*W)`，`ph` 缺省 124），然后 `delete` 旧字段，只跑一次（`WB._px` 标记）。
- 迁移完 `WB.view` 不存在就 `wbFit()` 居中；之后每次 `wbSave()` 连 `view` 一起写，刷新回来还是上次那个缩放位置。

### 实测（真 Edge 1440×980，`tmp/gd-canvas-e2e.mjs`，09-陶宅夜话）
- 初始 `translate(24px,15px) scale(0.2617)`、标签 26%；点 4 次＋到 64%；双击空白 ×2 → 2 张 220×132 卡。（空板改 100% 后的实测见下：`gd-canvas-e2e.mjs` 现在从 `translate(-745px,-384px) scale(1)`、标签 100% 起步，244% → 300%。）
- 拖卡 `px 898→1038`、`py 549→635`；拖右下角 resize → 337×210；点红块 → `class="wb-node is-sel k-red"`、`k=[red,""]`。
- 从 0 号卡 e 圆点拖到 1 号卡 → `links=1`、`pair=[true,true]`；滚轮 64%→107%；拖空白 `x -941→-1031`、`y -588→-538`。
- 刷新重开：`nodes=2`、四边圆点 8 个、`mode=map`、`zoom=107%`；pageerror 0（console 只有 favicon 404）。
- 同轮 `tmp/gd-board-e2e.mjs` 全量回归通过（笔画/橡皮/撤销/导出 72058 字节、卡片与连线、表格 4×5 与刷新保留、手机 427×320）。
- 世界外平移（`tmp/gd-outside-pan-e2e.mjs`）：先把 `view` 摆成 `{x:400,y:300,z:0.5}` 让左上露出世界外，世界外那点 `elementFromPoint` 现在是 **`.wb`**（改前没有监听），拖一下 `translate(400px,300px)` → `(340px,260px)`；世界内 `(300px,230px)` 同样能拖；世界外双击不崩、也不建卡。

### 一个 CSS 坑
给 `.wb-node` 加 `overflow:hidden` 会把伸出边框的四边圆点裁掉，`pointerdown` 打不到 handle，连线永远连不上
（e2e 里 `down.from=0`）。改回 `overflow:visible`，文字滚动交给内层 `.wb-node-t`。

## 带本流程：导入完先让 AI 排一遍「哪里停、哪时发真相」（2026-11-20，m00610）

用户要的是：确认导入之后，让 AI 生成整场游玩顺序的大纲 —— 包括在哪停下等玩家讨论、真相手册在哪一步发，
提前有个底稿保证连贯。它不是给玩家看的，是**主持人（或者 AI 主持）带本时按着走的那张纸**。

### 后端
- `flowMaterial(root,folder)`：拼一份「给模型看」的摘要 —— `case.yml`（≤24000 字）、真相手册（≤12000）、
  规则/准备（≤6000）、线索 8 份 × 1200、线索清单、每个角色本的三幕骨架；`stamp` = 全文 sha1 前 16 位。
  已生成过的 AI 补全文件被跳过（别把 AI 写的东西再喂回去）。
- `flowPrompt` 要求严格 JSON：`{title, actCount, acts:[{label, goal, steps[], pause, hand, truth}], final:{truth, debrief}, notes[]}`；
  `parseFlow` 剥掉 ``` 围栏、按花括号配对取第一段 JSON，解析不出来就回 null（宁可报错也不编一份假的）。
- `flowAsk(ctx,root,folder,{force})`：缓存 `~/.dsh/game-desk/flows/<sha1(root|folder) 前 16>.json`，
  命中直接回 `cached:true`；`maxTokens 1800`、180 秒超时、用量记 `recordModelUsage('flow', …)`。
- 路由：`GET /api/flow`（读缓存，带 `stale` = 材料指纹变了）、`POST /api/flow`（生成 / `force:true` 重生成）；
  进 `GATE_RULES` 的 `flow:'owner'` —— 大纲里直接写着每一幕的真相口径，**只给房主**。
- `dmActBlock(root,folder,act)` **不接 system**，而是拼在本轮**用户消息最前面**：「【本轮带本流程 · 第 N 幕】」+「当前是第 N 幕。」，
  再塞当前这一幕的「目标 / 按这个顺序带 / 该停就停 / 这一幕可发 / 真相口径」，末尾固定一句「流程是底稿，不是剧本；
  玩家没走到的地方不要抢着推进」。这样「交给 AI 主持」不是照着整包资料自由发挥，而是按同一份大纲走；
  换幕只改用户消息，system 一个字节不动（见下一节「缓存：换幕不换前缀」）。

### 前端
- 对局室页签多一个「流程」（在「人物剧本」之后）：玩家视角是一个 lockcard（「『流程』是带本大纲，写着每一幕什么时候发真相 ——
  玩家视角不摊开」，带「切到主持视角」按钮）；主持视角读 `GET /api/flow`。
- 没有大纲 → 一段说明 + 「生成游玩顺序」按钮（忙态最多 180 秒，按钮变「正在排…」）；
  有大纲 → 抬头（本名 · N 幕 · 生成时间 · 模型）+ 每幕一张卡（序号、这一幕要做什么、步骤、在哪停下等讨论、这一幕可发、真相口径），
  **当前这一幕**左边描边变红并标「当前这一幕」，最后是「收尾」与「提醒」，底部「重新生成」。
- 翻幕时流程页签跟着重画（同 `step(n)` 那条），高亮会跟着走。
- 实测（假宿主 + 真 Edge）：玩家视角 lockcard 1 张；切主持视角 → 点「生成游玩顺序」→ 5 张卡（3 幕 + 收尾 + 提醒）、
  `is-now` 恰好 1 张（第 2 幕，因为测试时停在第二幕）、首卡文案「01 第一幕 … 在哪停下等讨论 第一轮搜证后停下来讨论十分钟」；
  点「重新生成」→ 模型调用 1 → 2 次（缓存被 force 绕开）、卡片仍是 5 张。

### 缓存：换幕不换前缀（2026-11-20）

- 以前 `dmAsk` 把「当前是第 N 幕」和 `dmFlowBlock(...)` 拼在 system 末尾，换一幕 system 就变一次；
  模型侧的前缀缓存按字节命中，等于每一幕都要重新吃一遍整段 system。
- 现在 system 只放整局不变的部分（DM 规则、整包资料、输出格式、玩家与同席名字），
  幕与带本流程改由 `dmActBlock` 拼进「本轮用户消息」的最前面，玩家原话与历史仍在后面。
- 为什么必须「一个字节都不差」：前缀缓存是按 token 前缀逐字节比的，多一个换行、少一个空格都会让整段 system 重新计费。
- 实测（`tmp/gd-dm-cache-test.mjs`，09-陶宅夜话，同一 `meName`/`aiNames` 分别发 act=1 与 act=2）：
  system **1231 字符**，两次 `sha256` 前 16 位都是 `ae95b6604235d21e`（`===` 也相等）；
  act=2 的用户消息里带「【本轮带本流程 · 第 2 幕】」「当前是第 2 幕。」「对时间线」，
  而 system 里搜不到「第 2 幕」「带本流程」「对时间线」。

### 本文没做的事（有意留白）
- 不把大纲写进 `case.yml`：它是「一次生成、可重生成」的缓存，材料一变 `stale` 就提示重排，不污染本子本身。
- 不让玩家视角「看个大概」：真相口径就在卡里，做模糊展示只会误导，直接锁住更诚实。

## License

MIT © 2026 xinghe。本仓库只包含插件代码与文档；剧本杀本子（`case.yml`、PDF、线索图）各自的版权归原作者，不入库。

