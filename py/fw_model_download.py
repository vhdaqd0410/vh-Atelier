# -*- coding: utf-8 -*-
"""
faster-whisper 模型自动下载

为什么单独写这个模块：
  部署包里不放模型（medium 有 4GB，包体从 2.8GB 涨到 7GB 不现实）。
  改成首次使用时自动下载，但国内直连 HuggingFace 经常失败，
  所以要支持镜像回退，并且把进度报给前端，不能让人干等。

下载源优先级：
  1. 环境变量 VH_FW_MIRROR（用户可自定义）
  2. hf-mirror.com（国内可用）
  3. huggingface.co（官方）

模型存到插件自己的 models/faster-whisper/<model>/ 下，不用全局缓存，
这样整个插件目录可以整体搬走，也便于打包时排除。

用法：
  python fw_model_download.py --model medium [--check] [--mirror URL]
"""
import argparse
import json
import os
import shutil
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(HERE)
MODEL_ROOT = os.path.join(PLUGIN_ROOT, "models", "faster-whisper")

# 模型名 → HuggingFace 仓库
REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}

# 一个模型必需的文件（缺任一即视为未就绪）
REQUIRED = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]

MIRRORS = [
    "https://hf-mirror.com",
    "https://huggingface.co",
]


def emit(obj):
    """结果统一走 json，前端好解析。"""
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def progress(stage, pct, note=""):
    """进度打到 stderr，前端按行读取。"""
    print("PROGRESS %s %d %s" % (stage, int(pct), note), file=sys.stderr, flush=True)


def model_dir(model):
    return os.path.join(MODEL_ROOT, model)


def is_ready(model):
    """模型是否已完整下载。"""
    d = model_dir(model)
    if not os.path.isdir(d):
        return False
    for f in REQUIRED:
        p = os.path.join(d, f)
        if not os.path.exists(p) or os.path.getsize(p) == 0:
            return False
    return True


def total_size_bytes(model):
    d = model_dir(model)
    n = 0
    for root, _, files in os.walk(d):
        for f in files:
            try:
                n += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return n


def download_file(url, dest, on_bytes=None, tries=3):
    """下载单个文件，带重试与临时文件，避免半截文件污染缓存。"""
    import urllib.request
    tmp = dest + ".part"
    last_err = None
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "vh-atelier/1.0",
                # hf 的 CDN 需要跟随重定向
            })
            with urllib.request.urlopen(req, timeout=60) as r:
                total = int(r.headers.get("Content-Length") or 0)
                got = 0
                with open(tmp, "wb") as f:
                    while True:
                        chunk = r.read(1024 * 256)
                        if not chunk:
                            break
                        f.write(chunk)
                        got += len(chunk)
                        if on_bytes:
                            on_bytes(got, total)
            os.replace(tmp, dest)
            return True
        except Exception as e:
            last_err = e
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            if attempt < tries:
                time.sleep(1.5 * attempt)
    raise last_err


def ensure_model(model, mirror=None):
    """确保模型就位。返回 (ok, info)。"""
    if model not in REPOS:
        return False, "未知模型：%s（可选：%s）" % (model, ", ".join(REPOS))
    if is_ready(model):
        return True, {"model": model, "ready": True,
                      "size": total_size_bytes(model), "cached": True}

    repo = REPOS[model]
    os.makedirs(model_dir(model), exist_ok=True)

    bases = ([mirror] if mirror else []) + \
            ([os.environ["VH_FW_MIRROR"]] if os.environ.get("VH_FW_MIRROR") else []) + \
            MIRRORS

    last_err = None
    for base in bases:
        base = base.rstrip("/")
        progress("source", 0, base)
        try:
            # 先取文件清单（不同模型的辅助文件可能不同，用 API 拿全量）
            listing_url = "%s/api/models/%s" % (base, repo)
            import urllib.request
            req = urllib.request.Request(listing_url, headers={"User-Agent": "vh-atelier/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                meta = json.loads(r.read().decode("utf-8"))
            files = [s["rfilename"] for s in (meta.get("siblings") or [])]
            if not files:
                files = REQUIRED
            # 只要必要的几类文件，跳过 README/.gitattributes 等
            keep = []
            for f in files:
                low = f.lower()
                if low.startswith(("readme", ".git")):
                    continue
                if low.endswith((".md", ".png", ".jpg", ".gitattributes")):
                    continue
                keep.append(f)
            if not keep:
                keep = REQUIRED

            done = 0
            for idx, fname in enumerate(keep):
                dst = os.path.join(model_dir(model), fname)
                if os.path.exists(dst) and os.path.getsize(dst) > 0:
                    done += 1
                    progress("file", int(done / len(keep) * 100), fname + "（已存在）")
                    continue
                url = "%s/%s/resolve/main/%s" % (base, repo, fname)
                progress("file", int(idx / len(keep) * 100), fname)
                download_file(url, dst)
                done += 1
                progress("file", int(done / len(keep) * 100), fname)

            if is_ready(model):
                return True, {"model": model, "ready": True,
                              "size": total_size_bytes(model),
                              "cached": False, "source": base}
            last_err = "文件不完整（缺 %s）" % ", ".join(
                f for f in REQUIRED if not os.path.exists(os.path.join(model_dir(model), f)))
        except Exception as e:
            last_err = "%s：%s" % (base, str(e)[:160])
            progress("retry", 0, last_err)
            continue

    return False, "全部下载源失败。最后一个错误：%s" % last_err


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="medium")
    ap.add_argument("--check", action="store_true", help="只检查是否就绪")
    ap.add_argument("--mirror", default="")
    args = ap.parse_args()

    if args.check:
        ready = is_ready(args.model)
        emit({"ok": True, "model": args.model, "ready": ready,
              "size": total_size_bytes(args.model) if ready else 0,
              "dir": model_dir(args.model)})
        return

    ok, info = ensure_model(args.model, args.mirror or None)
    if ok:
        emit({"ok": True, "ready": True, "model": args.model,
              "size": info.get("size", 0), "cached": info.get("cached"),
              "dir": model_dir(args.model)})
    else:
        emit({"ok": False, "model": args.model, "error": info})


if __name__ == "__main__":
    main()
