# -*- coding: utf-8 -*-
"""超分/去字幕结果落盘：绝不覆盖同名文件（_unique_final）。

以前的落盘策略是「目标存在就删掉旧的再改名过去」，同一集跑两次超分，第二次把
第一次的结果覆盖了。现在一律顺延 _2/_3…
"""
import importlib.util
import os
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "py", "enhance_client.py")

passed = 0
failed = 0


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print("  [OK] " + name)
    else:
        failed += 1
        print("  [FAIL] " + name + ((" -> " + str(extra)) if extra else ""))


def main():
    if not os.path.exists(SRC):
        print("  [SKIP] 没有 py/enhance_client.py")
        print("通过 0 / 失败 0")
        return 0

    spec = importlib.util.spec_from_file_location("ec", SRC)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)

    if not hasattr(m, "_unique_final"):
        ok("存在 _unique_final", False)
        print("通过 %d / 失败 %d" % (passed, failed))
        return 1

    ok("存在 _unique_final", True)

    d = tempfile.mkdtemp()
    try:
        dest = os.path.join(d, "1_720p.mp4")
        open(dest, "wb").write(b"first")
        r2 = m._unique_final(dest)
        ok("已存在 → 顺延 _2", os.path.basename(r2) == "1_720p_2.mp4", os.path.basename(r2))

        open(r2, "wb").write(b"second")
        r3 = m._unique_final(dest)
        ok("再撞 → 顺延 _3", os.path.basename(r3) == "1_720p_3.mp4", os.path.basename(r3))

        ok("旧文件内容未被改动", open(dest, "rb").read() == b"first")

        free = os.path.join(d, "2_720p.mp4")
        ok("无同名时原样返回", m._unique_final(free) == free)

        # 源码层面：不应再有「先删旧文件」的落盘路径
        src = open(SRC, "rb").read().decode("utf-8", "replace")
        ok("没有 os.remove(dest) 这种覆盖写法", "os.remove(dest)" not in src)
        ok("落盘走 _unique_final", "final = _unique_final(dest)" in src)
    finally:
        for f in os.listdir(d):
            try:
                os.remove(os.path.join(d, f))
            except Exception:
                pass
        try:
            os.rmdir(d)
        except Exception:
            pass

    print("通过 %d / 失败 %d" % (passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())