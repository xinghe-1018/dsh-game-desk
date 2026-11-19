# ocr.py — 案卷台的本地 OCR

把**扫描件 PDF**（没有文字层、pypdf/PyMuPDF 的 extract_text 返回空）和 **jpg/png** 读成文字。
两条引擎，一个命令行：

    python ocr.py --engine rapid --in <文件或目录> [--out <目录>] [--json]
    python ocr.py --engine vl    --in <文件> --max-pages 2 [--out <目录>]

脚本自己找解释器：用哪个 python 起都行（宿主 PATH 的 `python`、两个 venv 的 python 都可以），
它会按引擎挑一个带齐依赖的 python 重跑自己（`OCR_REEXEC` 防递归），再动手。

## 快速开始

    & 'C:/Users/OMEN/.dsh/tools/ocr-venv/Scripts/python.exe' ocr.py \
        --engine rapid --in 'D:/BaiduNetdiskDownload/.../人物剧本' --out C:/Users/OMEN/.dsh/tmp/ocr-out

    # 只要 stdout（每页文字用空行隔开；多文件时加 ===== 文件名 ===== 分隔）
    python ocr.py --engine rapid --in 某个扫描件.pdf

    # 给插件/脚本吃：每行一个 JSON
    python ocr.py --engine rapid --in 某个扫描件.pdf --json
    {"engine": "rapid", "source": "...", "pages": [{"page": 1, "chars": 733, "text": "..."}], "ms": 21542}

- `--json` 是 **JSON Lines**：一个输入一行；单输入时那一行就是上面这个对象。
- `--out DIR` 时每个输入写 `DIR/<原文件名>.txt`（重名自动加 `_2`），页与页之间空一行；stdout 只剩 JSON（若有）。
- 默认把 PDF 用 PyMuPDF **200 DPI** 渲染（1167×1653 那种页面尺寸），逐页 OCR。

## 两条引擎

| | `rapid`（默认） | `vl` |
|---|---|---|
| 模型 | RapidOCR（PP-OCR 轻量检测+识别） | Qwen3-VL-2B-Instruct |
| 跑在哪 | ONNX Runtime **CPU** | transformers + torch，**GPU（fp16）**，OOM 自动退 CPU |
| 显存 | 0 | 模型权重约 4.0GB（safetensors 4.25GB），实测在 5.3GB 空闲显存下能跑 |
| 内存 | 初始化后 RSS ≈ 105MB，单页峰值 ≈ 460MB | 进程 + 模型约 5GB 上下（未单独测峰值） |
| 速度（本机） | **≈ 4.9s / 页**（PDF 页）、≈ 4–6s / 张图 | **≈ 75s / 页**（缩到 1.6MP 后；不缩 ≈ 119s/页） |
| 适合 | 默认全走它：中文印刷体扫描件、线索图 | 只用来救火：版式怪、标点/英文容易错的页，一次两三页 |

判断依据（实测同一页 健美女人.pdf p2，715 字）：
`rapid` 把刊头 `SILENT HOSPITAL` 认成 `SULENT HOSPITAL`、把破折号 `10月——` 认成 `10月一`，
而且保留硬换行（一句话被切成两行）；`vl` 这两处都对，还会把折断的句子接回去。
代价是慢 15 倍、吃 4GB 显存——所以默认不用它。

### 实测（2026-11-19，本机 RTX 4070 Laptop 8GB）

`rapid`，4 份人物剧本 PDF（扫描件）+ 5 张线索图，一条命令跑完：

| 输入 | 页/张 | 抽出字数 | 耗时 |
|---|---|---|---|
| 健美女人.pdf | 4 | 1564 | 21.5s |
| 圆润男人.pdf | 4 | 1255 | 16.8s |
| 摇滚男人.pdf | 5 | 2263 | 26.5s |
| 清秀女人.pdf | 4 | 1480 | 18.7s |
| 桐花线索_1.jpg | 1 | 151 | 4.0s |
| 桐花线索_2.jpg | 1 | 464 | 5.8s |
| 桐花线索_3.jpg | 1 | 616 | 6.0s |
| 桐花线索_4.jpg | 1 | 435 | 5.3s |
| 桐花线索_5.jpg | 1 | 84 | 2.9s |
| **合计** | 17 页 + 5 图 | **8312 字** | **107.5s**（整条命令 111s，含两次进程启动） |

`vl`：健美女人.pdf 前两页，**151.1s / 2 页**（75s 一页；整条命令 176.5s，含进程启动与 7.8s 模型加载）。
跑的时候显存空闲 5.3GB，**ComfyUI 当时没占显存，不需要先让它释放**；如果 ComfyUI 占着 6–7GB，
脚本会在 CUDA OOM 时自动退 CPU（会明显变慢），或者你先把 ComfyUI 停掉/释放模型再跑。

## 装法（本机现状，已经装好）

### rapid：`C:/Users/OMEN/.dsh/tools/ocr-venv`

    <whisper-venv 的 python> -m venv C:/Users/OMEN/.dsh/tools/ocr-venv
    C:/Users/OMEN/.dsh/tools/ocr-venv/Scripts/python.exe -m pip install --no-input rapidocr_onnxruntime pymupdf

装的是 `rapidocr_onnxruntime 1.4.4`、`onnxruntime 1.32.0`、`pymupdf 2.1`、`opencv-python 5.1.0.95`、`numpy 2.5.5`。

**为什么不直接用 whisper-venv**：它是个 junction，真身在 `E:\DSH-Offload\10-toolchains\whisper-venv`；
宿主起的子进程是 Low 完整性级别，写不了 E 盘，`pip install` 会死在
`ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied: '...\whisper-venv\Lib\site-packages\six.py'`。
所以另建了一个在 C 盘的 venv（装包时 `--cache-dir` 也指 C 盘，E 盘的 pip 缓存同样写不进去）。

### vl：`C:/Users/OMEN/.dsh/tools/gsv-venv` + torchvision overlay

gsv-venv 已有 `torch 2.9.1+cu128`、`transformers 4.57.6`、PIL，但**没有 torchvision**，
而 Qwen3-VL 的 `AutoProcessor` 要它：

    ImportError: AutoVideoProcessor requires the Torchvision library but it was not found in your environment.

gsv-venv 同样在 E 盘 junction 上、装不进去，所以只把 torchvision 装成一个 overlay 目录：

    C:/Users/OMEN/.dsh/tools/ocr-venv/Scripts/python.exe -m pip install --no-deps \
        --target C:/Users/OMEN/.dsh/tools/vl-extra torchvision==0.24.1

`ocr.py` 在 import transformers 之前把这个目录 `sys.path.insert(0, ...)`（可用 `OCR_TORCHVISION_DIR` 覆盖）。
实测 `torchvision 0.24.1+cpu` 跟 `torch 2.9.1+cu128` 能共存——我们只用它的图像预处理，不跑 GPU 算子。

gsv-venv 也**没有 pymupdf**，所以 `--engine vl` 遇到 PDF 时，会借 `ocr-venv` 的 python 起一个子进程把页渲染成 PNG，
再交给 VL。这样两边都不用改环境。

模型默认 `D:/qwen-image-local/models/Qwen3-VL-2B-Instruct`（`OCR_VL_MODEL` 可覆盖）。

## 参数

| 参数 | 说明 |
|---|---|
| `--engine rapid|vl` | 默认 `rapid` |
| `--in PATH` | PDF / 图片 / 目录（目录只收 PDF 与 jpg/png/webp/bmp/tif，排序后逐个跑） |
| `--out DIR` | 每个输入写 `<名字>.txt`；临时渲染的 PNG 也放这里（跑完删） |
| `--json` | JSON Lines，一个输入一行 |
| `--max-pages N` | 每个 PDF 只处理前 N 页（0=全部）；vl 建议配上 |
| `--dpi N` | PDF 渲染 DPI，默认 200 |
| `--device auto|cuda|cpu` | vl 用，默认 auto |
| `--model DIR` | vl 模型目录 |
| `--max-new-tokens N` | vl 每页生成上限，默认 2048 |
| `--vl-max-pixels N` | vl 送模型前把图缩到这个像素数以内，默认 1600000（0=不缩）。不缩的话一页扫描件是上万个视觉 token，慢一倍多 |
| `--keep-pages` | 保留渲染出来的 PNG（调版面问题时看） |

环境变量：`OCR_PYTHON_RAPID` / `OCR_PYTHON_VL` / `OCR_PYTHON_RENDER`（指定解释器）、
`OCR_TORCHVISION_DIR`、`OCR_VL_MODEL`、`OCR_TMP`（临时目录）。

## 退出码（失败必有一行 stderr，不会静默返回空字符串）

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 其它错误；多输入时有部分失败也是 1 |
| 2 | 引擎依赖缺失（rapidocr / transformers / torchvision 没装对） |
| 3 | VL 模型目录缺失或不完整（没有 `config.json`） |
| 4 | 显存/内存不足（CUDA OOM 后 CPU 也失败） |
| 5 | PDF 打不开或渲染失败 |
| 6 | 输入不存在、目录里没有可处理的文件、或扩展名不支持 |

## 已知取舍

- **不做版式分析**：多栏、表格会被按行拍平（行的物理顺序保留，语义顺序不保证）。
- 扫描件的固有噪声还在：`rapid` 偶尔把 `SILENT` 认成 `SULENT`、破折号认成 `一`；
  介意就用 `vl` 复核那一页，别整本跑。
- 只读来源目录：脚本从不往输入目录写东西，产物只落在 `--out`。
- 宿主插件那一侧调用时，建议固定 `--out` 并读 JSON，别解析 stdout 的纯文本。
