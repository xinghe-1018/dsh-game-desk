# -*- coding: utf-8 -*-
"""把 PDF 的指定页渲染成 JPEG（角色剧本按幕给图，2026-11-20 用户 m00504）。

由 lib/index.js 用本机的 paddle-venv python 调起来（那份环境里有 PyMuPDF 2.1）：
    python script-pages.py <pdf> <outdir> <dpi> <page1,page2,...>
    python script-pages.py <pdf> --info          # 只报总页数，不渲

约定：
- 页号 1 起；输出 <outdir>/p<N>.jpg（q88），已存在就跳过（缓存由 Node 侧按 PDF mtime 失效）；
- 用 JPEG 不用 PNG：同一页 130dpi，PNG 3.0MB、JPEG 约 300KB，小字仍然清楚；
- stdout 只打一行 JSON，Node 侧直接 JSON.parse；
- 出错也打 JSON（ok:false），不要把 traceback 混进 stdout —— 页面拿到的错误信息要能读。
"""
import json
import os
import sys


def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))
    sys.exit(0)


def main():
    # --info：只问「几页」，不渲（角色本切不开幕时，前端要按整份给图）。
    if len(sys.argv) >= 3 and sys.argv[2] == "--info":
        if not os.path.isfile(sys.argv[1]):
            fail("PDF 不存在：%s" % sys.argv[1])
        try:
            import pymupdf as fitz
        except ImportError:
            try:
                import fitz
            except ImportError:
                fail("这份 python 里没有 PyMuPDF（装法：pip install pymupdf）")
        try:
            doc = fitz.open(sys.argv[1])
        except Exception as e:  # 加密 / 损坏的 PDF
            fail("打不开 PDF：%s" % e)
        print(json.dumps({"ok": True, "total": doc.page_count}, ensure_ascii=False))
        return
    if len(sys.argv) < 5:
        fail("args: <pdf> <outdir> <dpi> <pages>")
    pdf, outdir, dpi_s, pages_s = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    try:
        dpi = int(dpi_s)
    except ValueError:
        fail("dpi 不是整数：%s" % dpi_s)
    pages = [int(x) for x in pages_s.split(",") if x.strip().isdigit()]
    if not pages:
        fail("没有要渲染的页")
    if not os.path.isfile(pdf):
        fail("PDF 不存在：%s" % pdf)
    try:
        import pymupdf as fitz
    except ImportError:
        try:
            import fitz
        except ImportError:
            fail("这份 python 里没有 PyMuPDF（装法：pip install pymupdf）")
    os.makedirs(outdir, exist_ok=True)
    try:
        doc = fitz.open(pdf)
    except Exception as e:  # 加密 / 损坏的 PDF
        fail("打不开 PDF：%s" % e)
    total = doc.page_count
    out = []
    for p in pages:
        if p < 1 or p > total:
            continue
        path = os.path.join(outdir, "p%d.jpg" % p)
        if not os.path.exists(path):
            try:
                pix = doc[p - 1].get_pixmap(dpi=dpi)
                pix.save(path, jpg_quality=88)
            except Exception as e:
                fail("第 %d 页渲染失败：%s" % (p, e))
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        out.append({"page": p, "file": "p%d.jpg" % p, "bytes": size})
    print(json.dumps({"ok": True, "total": total, "dpi": dpi, "pages": out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
