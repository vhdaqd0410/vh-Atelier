# -*- coding: utf-8 -*-
"""
GPU 加速包（CUDA 运行库）安装器

内容：cublasLt64_12.dll / cublas64_12.dll / cudnn64_9.dll，约 770MB
安装位置：<插件>/runtime/python/Lib/site-packages/ctranslate2/

用法：
  python fw_gpu_install.py --check
  python fw_gpu_install.py --install
  python fw_gpu_install.py --install --url URL
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time
import zipfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(HERE)
CT2_DIR = os.path.join(PLUGIN_ROOT, "runtime", "python", "Lib", "site-packages", "ctranslate2")

DEFAULT_URLS = [
    "http://47.122.108.231:8888/downloads/vh-fw-gpu-1.0.0.zip",
]

# 判定 GPU 包是否已装的标志文件
VERIFY = [
    "cublasLt64_12.dll",
    "cublas64_12.dll",
]


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def progress(stage, pct, note=""):
    print("PROGRESS %s %d %s" % (stage, int(pct), note), file=sys.stderr, flush=True)


def human(n):
    for u in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return "%.1f %s" % (n, u)
        n /= 1024.0
    return "%.1f TB" % n


def gpu_ready():
    if not os.path.isdir(CT2_DIR):
        return False
    for name in VERIFY:
        p = os.path.join(CT2_DIR, name)
        if not os.path.exists(p) or os.path.getsize(p) == 0:
            return False
    return True


def download(url, dest, tries=3):
    import urllib.request

    class R308(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if code in (307, 308):
                return urllib.request.Request(
                    newurl,
                    headers={k: v for k, v in req.headers.items()
                             if k.lower() not in ("content-length", "content-type")},
                    origin_req_host=req.origin_req_host,
                    unverifiable=True,
                    method=req.get_method())
            return urllib.request.HTTPRedirectHandler.redirect_request(
                self, req, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(R308())
    tmp = dest + ".part"
    last = None
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "vh-atelier/1.0"})
            with opener.open(req, timeout=180) as r:
                total = int(r.headers.get("Content-Length") or 0)
                got = 0
                with open(tmp, "wb") as f:
                    while True:
                        chunk = r.read(1024 * 512)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if total:
                            progress("download", int(got / total * 100),
                                     "%s / %s" % (human(got), human(total)))
            os.replace(tmp, dest)
            return True
        except Exception as e:
            last = e
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            if attempt < tries:
                progress("retry", 0, "第 %d 次失败，重试" % attempt)
                time.sleep(2 * attempt)
    raise last


def install(urls=None):
    if gpu_ready():
        return True, {"ready": True, "note": "GPU 加速包已就绪，无需安装"}

    urls = urls or DEFAULT_URLS
    tmpdir = tempfile.mkdtemp(prefix="vh_fw_gpu_")
    zpath = os.path.join(tmpdir, "gpu.zip")

    ok, last_err = False, None
    for url in urls:
        try:
            progress("source", 0, url)
            download(url, zpath)
            ok = True
            break
        except Exception as e:
            last_err = str(e)[:160]
            progress("retry", 0, "%s 失败：%s" % (url, last_err))
    if not ok:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return False, "下载失败：%s" % last_err

    try:
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            if "manifest.json" not in names:
                raise ValueError("包里没有 manifest.json，可能是错误页面")
            manifest = json.loads(z.read("manifest.json").decode("utf-8"))
    except Exception as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return False, "安装包校验失败：%s" % e

    progress("extract", 0, "解压中")
    try:
        os.makedirs(CT2_DIR, exist_ok=True)
        with zipfile.ZipFile(zpath) as z:
            members = [n for n in z.namelist() if not n.endswith("/")]
            for i, n in enumerate(members):
                z.extract(n, PLUGIN_ROOT)
                if i % 3 == 0:
                    progress("extract", int(i / max(1, len(members)) * 100), "")
        progress("extract", 100, "完成")
    except Exception as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return False, "解压失败：%s" % e
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not gpu_ready():
        return False, "解压完成但关键 dll 缺失"

    return True, {"ready": True, "installed": True,
                  "version": manifest.get("version"),
                  "files": manifest.get("files")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--install", action="store_true")
    ap.add_argument("--url", default="")
    args = ap.parse_args()

    if args.check or not args.install:
        emit({"ok": True, "ready": gpu_ready(), "dir": CT2_DIR,
              "missing": [n for n in VERIFY
                          if not os.path.exists(os.path.join(CT2_DIR, n))]})
        return

    ok, info = install([args.url] if args.url else None)
    emit({"ok": ok, **info} if ok else {"ok": False, "error": info})


if __name__ == "__main__":
    main()
