# -*- coding: utf-8 -*-
"""
字幕识别引擎增量包安装器（CPU 版依赖）

为什么需要它：
  在线更新会跳过 runtime/ 和 models/，而 faster-whisper 的库放在
  runtime/python/Lib/site-packages 下。老版本用户点「更新」拿不到这些库，
  但为此重装 3GB 部署包不合理 —— 实际只差 66MB。

做法：从官网 downloads/ 拉增量包，解压覆盖到插件根目录。

用法：
  python fw_engine_install.py --check            检查是否已就绪
  python fw_engine_install.py --install          下载并安装
  python fw_engine_install.py --install --url URL 指定地址
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

DEFAULT_URLS = [
    "http://47.122.108.231:8888/downloads/vh-fw-engine-cpu-1.0.2.zip",
]

# 安装后要检查的关键文件（相对插件根）
VERIFY = [
    "runtime/python/Lib/site-packages/faster_whisper/__init__.py",
    "runtime/python/Lib/site-packages/ctranslate2/__init__.py",
    "runtime/python/Lib/site-packages/ctranslate2/ctranslate2.dll",
    "runtime/python/Lib/site-packages/av/__init__.py",
    "runtime/python/Lib/site-packages/numpy/__init__.py",
    "runtime/python/Lib/site-packages/yaml/__init__.py",
]


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def progress(stage, pct, note=""):
    print("PROGRESS %s %d %s" % (stage, int(pct), note), file=sys.stderr, flush=True)


def engine_ready():
    """依赖是否已就位。"""
    for rel in VERIFY:
        p = os.path.join(PLUGIN_ROOT, rel.replace("/", os.sep))
        if not os.path.exists(p) or os.path.getsize(p) == 0:
            return False
    return True


def human(n):
    for u in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return "%.1f %s" % (n, u)
        n /= 1024.0
    return "%.1f TB" % n


def download(url, dest, tries=3):
    """下载到本地临时文件，带进度。"""
    import urllib.request
    tmp = dest + ".part"
    last = None
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "vh-atelier/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r:
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
    if engine_ready():
        return True, {"ready": True, "note": "依赖已就绪，无需安装"}

    urls = urls or DEFAULT_URLS
    tmpdir = tempfile.mkdtemp(prefix="vh_fw_engine_")
    zpath = os.path.join(tmpdir, "engine.zip")

    ok = False
    last_err = None
    for url in urls:
        try:
            progress("source", 0, url)
            download(url, zpath)
            ok = True
            break
        except Exception as e:
            last_err = str(e)[:160]
            progress("retry", 0, "%s 失败：%s" % (url, last_err))
            continue

    if not ok:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return False, "下载失败（所有源都不可用）：%s" % last_err

    # 校验是合法 zip 且有 manifest
    try:
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            if "manifest.json" not in names:
                raise ValueError("包里没有 manifest.json，可能下到的是错误页面")
            manifest = json.loads(z.read("manifest.json").decode("utf-8"))
    except Exception as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return False, "安装包校验失败：%s" % e

    # 解压到插件根目录（包内路径已经是 runtime/python/... 结构）
    progress("extract", 0, "解压中")
    try:
        with zipfile.ZipFile(zpath) as z:
            members = [n for n in z.namelist() if not n.endswith("/")]
            for i, n in enumerate(members):
                z.extract(n, PLUGIN_ROOT)
                if i % 200 == 0:
                    progress("extract", int(i / max(1, len(members)) * 100), "")
        progress("extract", 100, "完成")
    except Exception as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return False, "解压失败：%s" % e
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    if not engine_ready():
        missing = [r for r in VERIFY
                   if not os.path.exists(os.path.join(PLUGIN_ROOT, r.replace("/", os.sep)))]
        return False, "解压完成但关键文件仍缺失：%s" % ", ".join(missing)

    return True, {"ready": True, "installed": True,
                  "version": manifest.get("version"),
                  "files": manifest.get("fileCount")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--install", action="store_true")
    ap.add_argument("--url", default="")
    args = ap.parse_args()

    if args.check or not args.install:
        emit({"ok": True, "ready": engine_ready(),
              "root": PLUGIN_ROOT,
              "missing": [r for r in VERIFY
                          if not os.path.exists(os.path.join(PLUGIN_ROOT, r.replace("/", os.sep)))]})
        return

    urls = [args.url] if args.url else None
    ok, info = install(urls)
    if ok:
        emit({"ok": True, **info})
    else:
        emit({"ok": False, "error": info})


if __name__ == "__main__":
    main()
