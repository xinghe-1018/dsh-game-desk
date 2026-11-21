#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ocr.py — 本地 OCR：把扫描件 PDF / 图片读成文字（案卷台 dsh-game-desk 用）。

三条引擎：
  rapid       RapidOCR（rapidocr_onnxruntime，ONNX Runtime CPU）——快、不占显存，默认。
  rapid-cuda  RapidOCR 走 ONNX Runtime 的 CUDAExecutionProvider（跑在 gsv-venv，复用 torch 的 cuDNN9 DLL）——
              同模型同后处理，只把推理搬到 GPU；CUDA 不可用时自动回落 CPU 并在 stderr 说明。
  vl          Qwen3-VL-2B-Instruct + transformers——慢、吃显存/内存，用来啃版式怪的页。

用法：
  python ocr.py --engine rapid      --in <文件或目录> [--out <目录>] [--json]
  python ocr.py --engine rapid-cuda --in <a.pdf> <b.pdf> <c目录> [--json]   # --in 可给多个路径，模型只加载一次
  python ocr.py --engine vl         --in <文件> --max-pages 2 [--out 目录]

输入：.pdf（PyMuPDF 按 200 DPI 逐页渲染）、.jpg/.jpeg/.png/.webp/.bmp/.tif。
输出：默认把每页文字拼好打印到 stdout；--out 时每个输入写 <名字>.txt；--json 每行一个对象
      {engine, source, pages:[{page, chars, text}], ms}。

退出码：0 成功；2 引擎缺依赖；3 模型缺失；4 显存/内存不足；5 PDF 打不开；6 输入为空或不支持；1 其它。
任何失败都在 stderr 留一行可读原因，绝不"静默返回空字符串"。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

DEFAULT_DPI = 200
DEFAULT_MAX_NEW_TOKENS = 2048
MODEL_DIR = os.environ.get("OCR_VL_MODEL", "D:/qwen-image-local/models/Qwen3-VL-2B-Instruct")

VL_PROMPT = (
    "只输出页面上的文字，保留换行，不要解释。"
    "按从上到下、从左到右的阅读顺序输出；表格按行输出，不要补字、不要翻译、不要总结。"
)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
PDF_EXTS = {".pdf"}

# 解释器候选。环境变量优先，方便换机器/换环境时覆盖。
RAPID_MODULES = ("pymupdf", "rapidocr_onnxruntime")
RAPID_CUDA_MODULES = ("onnxruntime", "rapidocr_onnxruntime", "cv2", "numpy", "PIL")
VL_MODULES = ("torch", "transformers", "PIL")
RENDER_MODULES = ("pymupdf",)

RAPID_PYTHONS = [
    os.environ.get("OCR_PYTHON_RAPID", ""),
    "C:/Users/OMEN/.dsh/tools/ocr-venv/Scripts/python.exe",
    "C:/Users/OMEN/.dsh/tools/whisper-venv/Scripts/python.exe",
]
# rapid-cuda 跑在 gsv-venv：那里有 onnxruntime-gpu + torch 的 cuDNN9 DLL，复用之。
RAPID_CUDA_PYTHONS = [
    os.environ.get("OCR_PYTHON_RAPID_CUDA", ""),
    "C:/Users/OMEN/.dsh/tools/gsv-venv/Scripts/python.exe",
]
VL_PYTHONS = [
    os.environ.get("OCR_PYTHON_VL", ""),
    "C:/Users/OMEN/.dsh/tools/gsv-venv/Scripts/python.exe",
]
RENDER_PYTHONS = [
    os.environ.get("OCR_PYTHON_RENDER", ""),
    "C:/Users/OMEN/.dsh/tools/ocr-venv/Scripts/python.exe",
    "C:/Users/OMEN/.dsh/tools/whisper-venv/Scripts/python.exe",
]


def _engine_env(engine: str) -> tuple[list[str], tuple[str, ...]]:
    if engine == "rapid-cuda":
        return RAPID_CUDA_PYTHONS, RAPID_CUDA_MODULES
    if engine == "vl":
        return VL_PYTHONS, VL_MODULES
    return RAPID_PYTHONS, RAPID_MODULES


_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


class OcrError(Exception):
    """带退出码的可读错误。"""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _run_quiet(cmd: list[str]) -> bool:
    try:
        p = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=180,
            creationflags=_CREATE_NO_WINDOW,
        )
        return p.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _has_modules(py: str, modules: tuple[str, ...]) -> bool:
    if not py:
        return False
    code = "import " + ", ".join(modules)
    return _run_quiet([py, "-c", code])


def _pick_python(engine: str) -> str | None:
    candidates, modules = _engine_env(engine)
    seen = set()
    for py in list(candidates) + [sys.executable]:
        if not py or py in seen:
            continue
        seen.add(py)
        if not os.path.isfile(py):
            continue
        if _has_modules(py, modules):
            return py
    return None


def ensure_interpreter(engine: str, argv: list[str]) -> None:
    """当前解释器缺依赖时，把自身交给带依赖的那个 python 重跑，然后退出。"""
    if os.environ.get("OCR_REEXEC"):
        return
    _candidates, modules = _engine_env(engine)
    if _has_modules(sys.executable, modules):
        return
    py = _pick_python(engine)
    if not py:
        need = " + ".join(modules)
        raise OcrError(
            2,
            f"--engine {engine} 缺依赖：需要 {need}。"
            f"可试：pip install {' '.join(x for x in modules if x != 'PIL')} pillow",
        )
    if os.path.normcase(py) == os.path.normcase(sys.executable):
        return
    env = dict(os.environ)
    env["OCR_REEXEC"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    _log(f"[ocr] 换用解释器：{py}")
    p = subprocess.run([py, os.path.abspath(__file__), *argv], env=env)
    sys.exit(p.returncode)


# ---------------------------------------------------------------- 输入与渲染

def collect_inputs(src: str) -> list[str]:
    if os.path.isdir(src):
        names = sorted(os.listdir(src))
        files = [
            os.path.join(src, n)
            for n in names
            if os.path.splitext(n)[1].lower() in (IMAGE_EXTS | PDF_EXTS)
            and os.path.isfile(os.path.join(src, n))
        ]
        if not files:
            raise OcrError(6, f"目录里没有可处理的 PDF/图片：{src}")
        return files
    if os.path.isfile(src):
        ext = os.path.splitext(src)[1].lower()
        if ext not in (IMAGE_EXTS | PDF_EXTS):
            raise OcrError(6, f"不支持的文件类型：{ext}（只收 PDF 与图片）")
        return [src]
    raise OcrError(6, f"输入不存在：{src}")


_PDF_HELPER = r"""
import sys
try:
    import pymupdf as fitz
except ImportError:
    import fitz
src, outdir, dpi, maxp = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
doc = fitz.open(src)
total = doc.page_count
n = total if maxp <= 0 else min(total, maxp)
for i in range(n):
    pix = doc[i].get_pixmap(dpi=dpi)
    pix.save(outdir + "/p%04d.png" % (i + 1))
print("%d %d" % (total, n))
"""


def render_pdf(pdf_path: str, outdir: str, dpi: int, max_pages: int) -> tuple[int, list[str]]:
    """把 PDF 逐页渲染成 PNG。有 pymupdf 就本地渲染，没有就借 render python 起子进程。"""
    try:
        try:
            import pymupdf as fitz  # type: ignore
        except ImportError:
            import fitz  # type: ignore
        doc = fitz.open(pdf_path)
    except Exception as exc:  # noqa: BLE001 - 打开失败一律转成 5
        raise OcrError(5, f"PDF 打不开：{pdf_path}（{type(exc).__name__}: {exc}）") from exc
    total = doc.page_count
    n = total if max_pages <= 0 else min(total, max_pages)
    paths: list[str] = []
    for i in range(n):
        png = os.path.join(outdir, "p%04d.png" % (i + 1))
        doc[i].get_pixmap(dpi=dpi).save(png)
        paths.append(png)
    doc.close()
    return total, paths


def render_pdf_via_python(pdf_path: str, outdir: str, dpi: int, max_pages: int) -> tuple[int, list[str]]:
    py = None
    for cand in RENDER_PYTHONS + [sys.executable]:
        if cand and os.path.isfile(cand) and _has_modules(cand, RENDER_MODULES):
            py = cand
            break
    if not py:
        raise OcrError(5, f"VL 引擎需要 PyMuPDF 渲染 PDF，但没找到带 pymupdf 的 python：{pdf_path}")
    helper = os.path.join(outdir, "_render_pdf.py")
    with open(helper, "w", encoding="utf-8") as fh:
        fh.write(_PDF_HELPER)
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    p = subprocess.run(
        [py, helper, pdf_path, outdir, str(dpi), str(max_pages)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        creationflags=_CREATE_NO_WINDOW,
    )
    if p.returncode != 0:
        msg = (p.stderr or p.stdout or "").strip().splitlines()
        raise OcrError(5, f"PDF 打不开：{pdf_path}（{msg[-1] if msg else 'render failed'}）")
    try:
        total_s, n_s = (p.stdout.strip().split() + ["0", "0"])[:2]
        total, n = int(total_s), int(n_s)
    except ValueError as exc:
        raise OcrError(5, f"渲染结果无法解析：{pdf_path}") from exc
    return total, [os.path.join(outdir, "p%04d.png" % i) for i in range(1, n + 1)]


def _has_pymupdf() -> bool:
    try:
        try:
            import pymupdf  # noqa: F401
        except ImportError:
            import fitz  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def pages_for(src: str, tmpdir: str, dpi: int, max_pages: int) -> tuple[int, list[tuple[int, str]]]:
    """返回 (文档总页数, [(页号, 图片路径), ...])。"""
    if os.path.splitext(src)[1].lower() in PDF_EXTS:
        try:
            if _has_pymupdf():
                total, paths = render_pdf(src, tmpdir, dpi, max_pages)
            else:
                # VL 引擎跑在 gsv-venv（没 pymupdf），借带 pymupdf 的 python 渲染
                total, paths = render_pdf_via_python(src, tmpdir, dpi, max_pages)
        except OcrError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise OcrError(5, f"PDF 渲染失败：{src}（{type(exc).__name__}: {exc}）") from exc
        return total, [(i + 1, p) for i, p in enumerate(paths)]
    return 1, [(1, src)]


# ------------------------------------------------------------------- 引擎

class RapidEngine:
    name = "rapid"

    def __init__(self) -> None:
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise OcrError(2, f"RapidOCR 不可用（{type(exc).__name__}: {exc}）") from exc
        self._engine = RapidOCR()

    def run(self, image_path: str) -> str:
        try:
            result, _elapse = self._engine(image_path)
        except Exception as exc:  # noqa: BLE001
            raise OcrError(1, f"RapidOCR 识别失败（{type(exc).__name__}: {exc}）") from exc
        lines = [str(item[1]).strip() for item in (result or []) if len(item) > 1]
        return "\n".join(line for line in lines if line)


def _torch_lib_dir() -> str:
    """gsv-venv 里 torch\\lib 带着 CUDA12 + cuDNN9 的 DLL（torch 是 cu128 版）。
    onnxruntime-gpu 复用它们即可，不必再装一整套 CUDA 运行时。不 import torch（重），按 venv 目录推。"""
    if os.environ.get("OCR_TORCH_LIB"):
        return os.environ["OCR_TORCH_LIB"]
    venv = os.path.dirname(os.path.dirname(os.path.abspath(sys.executable)))  # <venv>/Scripts/python.exe
    for sub in (("Lib", "site-packages"), ("lib", "site-packages")):
        cand = os.path.join(venv, *sub, "torch", "lib")
        if os.path.isdir(cand):
            return cand
    try:
        import torch  # type: ignore
        return os.path.join(os.path.dirname(torch.__file__), "lib")
    except Exception:  # noqa: BLE001
        return ""


def _enable_cuda_inference_sessions(ort) -> dict:
    """rapidocr 建会话时把 providers 写死成 CPU。这里包一层 InferenceSession，
    强制 CUDAExecutionProvider 优先、CPU 兜底，并记录第一张会话是否真用上了 CUDA。"""
    probe = {"cuda": False, "checked": False}
    orig = ort.InferenceSession

    def wrapper(*args, **kwargs):
        passed = kwargs.get("providers")
        if passed:
            if isinstance(passed, str):
                passed = [passed]
            desired = ["CUDAExecutionProvider"] + [p for p in passed if p != "CUDAExecutionProvider"]
        else:
            desired = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        kwargs["providers"] = desired
        sess = orig(*args, **kwargs)
        if not probe["checked"]:
            probe["checked"] = True
            probe["cuda"] = "CUDAExecutionProvider" in sess.get_providers()
            _log(f"[ocr] rapid-cuda：首个会话 session.get_providers()={sess.get_providers()}")
        return sess

    ort.InferenceSession = wrapper  # type: ignore[attr-defined]
    return probe


class RapidCudaEngine:
    """RapidOCR 但推理走 ONNX Runtime 的 CUDAExecutionProvider。
    跑在 gsv-venv：复用同包内 rapidocr 的默认 onnx 模型 + torch\\lib 的 cuDNN9 DLL。
    CUDA 不可用时自动回落 CPU（stderr 说明），输出与 rapid 档逐字一致（同模型同后处理）。"""

    name = "rapid-cuda"

    def __init__(self) -> None:
        try:
            import onnxruntime as ort  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise OcrError(2, f"rapid-cuda 缺 onnxruntime（GPU 版）：{type(exc).__name__}: {exc}") from exc
        # torch\lib 的 CUDA12/cuDNN9 DLL 必须在建任何会话之前挂上
        dll_dir = _torch_lib_dir()
        if dll_dir and hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(dll_dir)
                os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")
            except OSError:
                pass
        avail = ort.get_available_providers()
        _log(f"[ocr] rapid-cuda：ort.get_available_providers()={avail}")
        if "CUDAExecutionProvider" not in avail:
            _log(f"[ocr] rapid-cuda：onnxruntime 无 CUDAExecutionProvider（有 {avail}），回落 CPU")
            from rapidocr_onnxruntime import RapidOCR  # type: ignore  # noqa: E402 后文同款 import
            self._engine = RapidOCR()
            self.active = "cpu"
            return
        # 关键顺序：rapidocr 的 infer_engine 在 import 时就把 InferenceSession 绑进了自己命名空间，
        # 所以必须先给 onnxruntime 打 CUDA 包装、再 import rapidocr——否则包装根本不生效（会话照旧 CPU）。
        probe = _enable_cuda_inference_sessions(ort)
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise OcrError(2, f"rapid-cuda 缺 rapidocr_onnxruntime：{type(exc).__name__}: {exc}") from exc
        try:
            self._engine = RapidOCR()
        except Exception as exc:  # noqa: BLE001
            _log(f"[ocr] rapid-cuda：CUDA 建会话失败（{type(exc).__name__}: {exc}），回落 CPU")
            self._engine = RapidOCR()
            self.active = "cpu"
            return
        if probe["cuda"]:
            self.active = "cuda"
            _log("[ocr] rapid-cuda：CUDAExecutionProvider 已启用")
        else:
            self.active = "cpu"
            _log("[ocr] rapid-cuda：请求了 CUDA provider 但未生效（多半缺对应 DLL），回落 CPU")

    def run(self, image_path: str) -> str:
        try:
            result, _elapse = self._engine(image_path)
        except Exception as exc:  # noqa: BLE001
            raise OcrError(1, f"RapidOCR(cuda) 识别失败（{type(exc).__name__}: {exc}）") from exc
        lines = [str(item[1]).strip() for item in (result or []) if len(item) > 1]
        return "\n".join(line for line in lines if line)


def _ensure_torchvision() -> None:
    """Qwen3-VL 的 AutoProcessor 需要 torchvision。

    gsv-venv 里没装（而且它在 E: 盘 junction 上，Low IL 的子进程写不进去），
    所以留了一个只装 torchvision 的 overlay 目录，用 sys.path 挂进去。
    """
    try:
        import torchvision  # noqa: F401

        return
    except Exception:  # noqa: BLE001 - 缺了才走 overlay
        pass
    extra = os.environ.get("OCR_TORCHVISION_DIR", "C:/Users/OMEN/.dsh/tools/vl-extra")
    if extra and os.path.isdir(extra) and extra not in sys.path:
        sys.path.insert(0, extra)


class VLEngine:
    name = "vl"

    def __init__(self, model_dir: str, device: str, max_new_tokens: int, max_pixels: int = 1600000) -> None:
        self.max_new_tokens = max_new_tokens
        self.max_pixels = max_pixels
        if not os.path.isdir(model_dir) or not os.path.isfile(os.path.join(model_dir, "config.json")):
            raise OcrError(3, f"VL 模型目录缺失或不完整：{model_dir}")
        _ensure_torchvision()
        try:
            import torch  # type: ignore
            from PIL import Image  # type: ignore
            from transformers import AutoProcessor  # type: ignore
        except Exception as exc:  # noqa: BLE001
            raise OcrError(2, f"VL 依赖不可用（{type(exc).__name__}: {exc}）") from exc
        self.torch = torch
        self.Image = Image
        self.processor = AutoProcessor.from_pretrained(model_dir)

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        dtype = torch.float16 if device == "cuda" else torch.float32
        try:
            from transformers import Qwen3VLForConditionalGeneration as ModelCls  # type: ignore
        except Exception:  # noqa: BLE001
            from transformers import AutoModelForImageTextToText as ModelCls  # type: ignore

        t0 = time.time()
        try:
            model = ModelCls.from_pretrained(model_dir, dtype=dtype)
        except TypeError:
            model = ModelCls.from_pretrained(model_dir, torch_dtype=dtype)
        model.eval()
        try:
            model = model.to(device)
        except Exception as exc:  # noqa: BLE001
            if _is_oom(exc) and device == "cuda":
                _log("[ocr] 显存不足，VL 退回 CPU（会明显变慢）")
                model = model.to(dtype=torch.float32).to("cpu")
                self.device = device = "cpu"
            else:
                raise OcrError(4, f"VL 模型装不进 {device}（{type(exc).__name__}: {exc}）") from exc
        self.model = model
        _log(f"[ocr] VL 已加载：device={self.device} dtype={str(dtype).replace('torch.','')} 用时 {time.time()-t0:.1f}s")

    def _fit(self, img):
        """喂给 VL 前按像素上限缩一下：不缩的话一页扫描件能进出上万个视觉 token，慢到不可用。"""
        if self.max_pixels <= 0:
            return img
        w, h = img.size
        if w * h <= self.max_pixels:
            return img
        scale = (self.max_pixels / float(w * h)) ** 0.5
        return img.resize((max(8, int(w * scale)), max(8, int(h * scale))), self.Image.LANCZOS)

    def run(self, image_path: str) -> str:
        img = self.Image.open(image_path).convert("RGB")
        img = self._fit(img)
        try:
            return self._generate(img)
        except Exception as exc:  # noqa: BLE001
            if _is_oom(exc) and self.device == "cuda":
                _log("[ocr] 显存不足（CUDA OOM），VL 退回 CPU 重跑这一页")
                torch = self.torch
                torch.cuda.empty_cache()
                self.model = self.model.to(dtype=torch.float32).to("cpu")
                self.device = "cpu"
                try:
                    return self._generate(img)
                except Exception as exc2:  # noqa: BLE001
                    raise OcrError(4, f"VL 在 CPU 上也失败（{type(exc2).__name__}: {exc2}）") from exc2
            raise OcrError(1, f"VL 识别失败（{type(exc).__name__}: {exc}）") from exc

    def _generate(self, img) -> str:
        torch = self.torch
        messages = [
            {
                "role": "user",
                "content": [{"type": "image", "image": img}, {"type": "text", "text": VL_PROMPT}],
            }
        ]
        text = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self.processor(text=[text], images=[img], return_tensors="pt").to(self.device)
        with torch.inference_mode():
            out = self.model.generate(
                **inputs,
                max_new_tokens=self.max_new_tokens,
                do_sample=False,
            )
        prompt_len = inputs["input_ids"].shape[1]
        gen = out[:, prompt_len:]
        decoded = self.processor.batch_decode(gen, skip_special_tokens=True)[0]
        return decoded.strip()


def _is_oom(exc: BaseException) -> bool:
    s = str(exc).lower()
    return "out of memory" in s or "cuda oom" in s or "cublas" in s and "alloc" in s


# ------------------------------------------------------------------- 输出

def make_workdir(outdir: str) -> str:
    """挑一个能写的临时目录（pwsh 子进程是 Low IL，系统 temp 可能被拒）。"""
    candidates = []
    if outdir:
        candidates.append(outdir)
    if os.environ.get("OCR_TMP"):
        candidates.append(os.environ["OCR_TMP"])
    candidates.append(os.path.join(tempfile.gettempdir(), "ocr-work"))
    candidates.append(os.path.join(os.path.expanduser("~"), ".dsh", "tmp", "ocr-work"))
    last: OSError | None = None
    for root in candidates:
        try:
            os.makedirs(root, exist_ok=True)
            return tempfile.mkdtemp(prefix="ocr_", dir=root)
        except OSError as exc:
            last = exc
    raise OcrError(1, f"找不到可写的临时目录（最后错误：{last}）")


def output_name(src: str, used: set[str]) -> str:
    stem = os.path.splitext(os.path.basename(src))[0]
    name = stem + ".txt"
    i = 2
    while name.lower() in used:
        name = f"{stem}_{i}.txt"
        i += 1
    used.add(name.lower())
    return name


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="ocr.py",
        description="本地 OCR：扫描件 PDF / 图片转文字（rapid=RapidOCR，vl=Qwen3-VL-2B）。",
    )
    parser.add_argument("--engine", choices=("rapid", "rapid-cuda", "vl"), default="rapid")
    parser.add_argument(
        "--in", dest="src", required=True, nargs="+", metavar="PATH",
        help="PDF/图片文件或目录；可给多个路径，同一次进程内模型只加载一次、逐份输出（旧单路径用法不变）",
    )
    parser.add_argument("--out", dest="outdir", default="", help="把每个输入的文本写成 <名字>.txt 放到这个目录")
    parser.add_argument("--json", action="store_true", help="每行输出一个 JSON：{engine,source,pages,ms}")
    parser.add_argument("--max-pages", type=int, default=0, help="只处理前 N 页（0 = 全部）")
    parser.add_argument("--dpi", type=int, default=DEFAULT_DPI, help=f"PDF 渲染 DPI（默认 {DEFAULT_DPI}）")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto", help="vl 引擎设备（默认 auto）")
    parser.add_argument("--model", default=MODEL_DIR, help="vl 模型目录")
    parser.add_argument("--max-new-tokens", type=int, default=DEFAULT_MAX_NEW_TOKENS, help="vl 每页最多生成多少 token")
    parser.add_argument("--vl-max-pixels", type=int, default=1600000, help="vl 送模型前把图缩到这个像素数以内（0 = 不缩，慢且吃显存）")
    parser.add_argument("--keep-pages", action="store_true", help="保留 PDF 渲染出来的 PNG（调试用）")
    args = parser.parse_args(argv)

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    ensure_interpreter(args.engine, argv)

    if args.max_pages < 0:
        raise OcrError(6, "--max-pages 不能是负数")

    sources: list[str] = []
    for one in args.src:
        for p in collect_inputs(one):
            if p not in sources:
                sources.append(p)
    if not sources:
        raise OcrError(6, "--in 展开后没有任何可处理的输入")
    if args.outdir:
        os.makedirs(args.outdir, exist_ok=True)

    t_load = time.time()
    if args.engine == "rapid":
        engine = RapidEngine()
    elif args.engine == "rapid-cuda":
        engine = RapidCudaEngine()
    else:
        engine = VLEngine(args.model, args.device, args.max_new_tokens, args.vl_max_pixels)
    _log(f"[ocr] 引擎 {engine.name} 就绪：模型加载 {time.time() - t_load:.1f}s"
         + (f"，provider={engine.active}" if getattr(engine, "active", None) else ""))

    used_names: set[str] = set()
    failures = 0
    for idx, src in enumerate(sources, 1):
        t0 = time.time()
        tmpdir = make_workdir(args.outdir)
        try:
            total_pages, pages = pages_for(src, tmpdir, args.dpi, args.max_pages)
            page_rows = []
            for page_no, img_path in pages:
                txt = engine.run(img_path)
                page_rows.append({"page": page_no, "chars": len(txt), "text": txt})
                _log(f"[ocr] {idx}/{len(sources)} {os.path.basename(src)} p{page_no}/{total_pages} "
                     f"{len(txt)} 字")
            ms = int(round((time.time() - t0) * 1000))
            doc = {"engine": engine.name, "source": os.path.abspath(src), "pages": page_rows, "ms": ms}
            prov = getattr(engine, "active", None)
            if prov:
                doc["provider"] = prov  # 仅 rapid-cuda：标注这一行实际跑在 cuda 还是回落 cpu
            if args.json:
                print(json.dumps(doc, ensure_ascii=False), flush=True)
            if args.outdir:
                name = output_name(src, used_names)
                path = os.path.join(args.outdir, name)
                with open(path, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write("\n\n".join(p["text"] for p in page_rows))
                _log(f"[ocr] 写入 {path}")
            elif not args.json:
                if len(sources) > 1:
                    print(f"===== {os.path.basename(src)} =====")
                print("\n\n".join(p["text"] for p in page_rows))
                if len(sources) > 1:
                    print()
        except OcrError as exc:
            failures += 1
            _log(f"[ocr] {os.path.basename(src)} 失败（exit {exc.code}）：{exc.message}")
            if not args.json and args.outdir == "" and len(sources) == 1:
                raise
        finally:
            if not args.keep_pages:
                shutil.rmtree(tmpdir, ignore_errors=True)
    if failures:
        _log(f"[ocr] 共 {failures}/{len(sources)} 个输入失败")
        return 1 if failures < len(sources) else 4
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except OcrError as err:
        _log(f"[ocr] 错误（exit {err.code}）：{err.message}")
        sys.exit(err.code)
    except KeyboardInterrupt:
        _log("[ocr] 已中断")
        sys.exit(130)
