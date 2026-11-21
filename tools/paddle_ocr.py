# -*- coding: utf-8 -*-
"""PaddleOCR (PP-OCRv5) 引擎：与 tools/ocr.py 同一套 CLI / JSONL 契约。
用法：python paddle_ocr.py --in a.pdf b.pdf --json [--dpi 150] [--limit-side 1280]
                          [--rec-batch 16] [--device gpu:0] [--det-model PP-OCRv5_server_det]
只输出 JSONL（每份一行），stderr 打诊断（provider / 耗时）。"""
import argparse, json, os, sys, time

HOME = r"C:\Users\OMEN\.dsh\tools\paddle-cache\paddle-home"
PDX = r"C:\Users\OMEN\.dsh\tools\paddle-cache\pdx"
os.environ["HOME"] = HOME
os.environ["USERPROFILE"] = HOME
os.environ["PADDLE_PDX_CACHE_HOME"] = PDX
for d in (HOME, PDX):
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass

import numpy as np


def _apply_mem_fraction(frac):
    if frac and frac > 0:
        v = "%.4f" % frac
        os.environ["FLAGS_fraction_of_gpu_memory_to_use"] = v
        os.environ["FLAGS_initial_gpu_memory_in_mb"] = "0"
    return frac


def log(msg):
    sys.stderr.write("[paddle] %s\n" % msg)
    sys.stderr.flush()


def render_pdf(path, dpi):
    import pymupdf
    doc = pymupdf.open(path)
    out = []
    for i in range(doc.page_count):
        page = doc.load_page(i)
        pix = page.get_pixmap(dpi=dpi)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        if pix.n == 4:
            img = img[:, :, :3]
        elif pix.n == 1:
            img = np.repeat(img, 3, axis=2)
        out.append(img)
    doc.close()
    return out


def image_files(path):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    return [np.array(im)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", nargs="+", required=True)
    ap.add_argument("--engine", default="paddle")  # 宿主统一传 --engine，这里忽略
    ap.add_argument("--json", action="store_true")
    # 2026-11-19 实测调优：dpi100 / 边长1024 / 批16 = 0.35-0.42 秒/页，CJK 保留 99.5%、
    # 与 150/1600 相比相似度 0.980；再往下调（90）只快 3% 而开始掉字，不值得。
    ap.add_argument("--dpi", type=int, default=100)
    ap.add_argument("--limit-side", type=int, default=1024)
    ap.add_argument("--rec-batch", type=int, default=16)
    ap.add_argument("--device", default="gpu:0")
    ap.add_argument("--det-model", default="PP-OCRv5_server_det")
    ap.add_argument("--rec-model", default="PP-OCRv5_server_rec")
    ap.add_argument("--mem-fraction", type=float, default=0.0,
                    help="0=不限；0.8 表示 paddle 最多占用整卡 80%% 显存")  
    ap.add_argument("--max-pages", type=int, default=0)
    a = ap.parse_args()
    _apply_mem_fraction(a.mem_fraction)

    t0 = time.time()
    from paddleocr import PaddleOCR
    ocr = PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_detection_model_name=a.det_model,
        text_recognition_model_name=a.rec_model,
        text_det_limit_side_len=a.limit_side,
        text_det_limit_type="max",
        text_recognition_batch_size=a.rec_batch,
        device=a.device,
    )
    log("provider=%s" % ("cuda" if str(a.device).startswith("gpu") else "cpu"))
    log("引擎 paddle 就绪：模型加载 %.1fs，device=%s det=%s rec=%s limit_side=%d rec_batch=%d"
        % (time.time() - t0, a.device, a.det_model, a.rec_model, a.limit_side, a.rec_batch))
    try:
        import paddle
        log("paddle %s compiled_with_cuda=%s cuda=%s；占用显存 %.0f MB"
            % (paddle.__version__, paddle.device.is_compiled_with_cuda(),
               paddle.version.cuda(), paddle.device.cuda.memory_allocated() / 1048576.0))
    except Exception as e:
        log("paddle 版本读取失败：%s" % e)

    for src in a.src:
        t = time.time()
        try:
            low = src.lower()
            imgs = render_pdf(src, a.dpi) if low.endswith(".pdf") else image_files(src)
            if a.max_pages:
                imgs = imgs[: a.max_pages]
            pages = []
            for i, img in enumerate(imgs):
                r = ocr.predict(img)
                texts = []
                for item in r:
                    d = item.get("rec_texts") if hasattr(item, "get") else None
                    if d:
                        texts.extend([str(x) for x in d])
                text = "\n".join(texts)
                pages.append({"page": i + 1, "chars": len(text.strip()), "text": text})
            rec = {"engine": "paddle", "source": os.path.abspath(src), "pages": pages,
                   "ms": int((time.time() - t) * 1000), "provider": a.device}
        except Exception as e:
            rec = {"engine": "paddle", "source": os.path.abspath(src), "error": "%s: %s" % (type(e).__name__, e),
                   "ms": int((time.time() - t) * 1000), "pages": []}
            log("失败 %s：%s" % (src, e))
        if a.json:
            sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        log("%s 页=%d 字数=%d 耗时=%.1fs" % (os.path.basename(src), len(rec.get("pages") or []),
                                            sum(p["chars"] for p in rec.get("pages") or []), rec["ms"] / 1000.0))


if __name__ == "__main__":
    main()
