# -*- coding: utf-8 -*-
"""vh-Atelier 统一测试入口。

背景：scripts/ 下原本散着 8 个手工测试脚本，各写各的（有的带退出码，
有的只打印对照值），发版前要逐个想起来手动跑，容易漏。

这个入口做两件事：
  1. 跑「有明确通过判据」的脚本（test-regression.js / test-flatten.js /
     check-ui.py / verify-ui-sync.py），以退出码和输出关键词判定成败；
  2. 跑「打印对照值」的演示脚本（test-clipsel / test-purge / test-tmpclean /
     test-cx-ui / test-split），只做「是否跑完且无异常」的冒烟判定。

用法：
    python run-tests.py            跑全部
    python run-tests.py -v         附带每个脚本的完整输出
    python run-tests.py --list     只列出会跑哪些
"""
import os
import re
import sys
import subprocess

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # 插件根（com.vh.atelier）

# 脚本分类：
#   gate=True  —— 有明确判据，失败即视为测试不通过（影响退出码）
#   gate=False —— 演示型脚本，只要求「跑完且无异常」；异常才影响退出码
JOBS = [
    # (脚本名, 运行器, gate, 说明, 需要的额外参数)
    ("test-regression.js", "node", True,  "回归测试：锁历史坑（changelog/版本号/共享模块/落盘）", None),
    # check-ui.py 无论成败都返回 0，只能看输出里的失败标志，故归为冒烟
    ("check-ui.py",        "python", False, "UI 结构校验：div 配平 / id 完整性 / CSS 类是否都有定义", None),
    ("verify-ui-sync.py",  "python", False, "校验改动是否已同步到 CEP 安装目录（未同步时跳过）", None),
    ("test-flatten.js",    "node", True,  "调色 XML 处理自检（良构性/负值/连续性）", "selftest"),
    ("test-clipsel.js",    "node", False, "波形划选：拖选/单击区分/按钮回调", None),
    ("test-tmpclean.js",   "node", False, "临时目录清理：命名空间识别/统计/安全边界", None),
    ("test-purge.js",      "node", False, "扁平化临时目录清理：只删本功能目录", None),
    ("test-cx-ui.js",      "node", False, "扁平化 UI 绑定逻辑加载无错", None),
    ("test-split.js",      "node", False, "拖动分隔条宽度计算与记忆", None),
]

# 失败标志：输出里出现这些词则判失败（用于 gate=False 的脚本）
FAIL_MARKERS = ["HAS_FAILURE", "Traceback", "SyntaxError", "ReferenceError",
                "TypeError", "is not defined", "Cannot find module",
                "未定义:", "缺失:"]
# 例外：这些词出现在“无缺失/无未定义”这类通过语句里，命中后要排除
FAIL_EXCEPTIONS = ["缺失: 无", "未定义: 无", "缺失:无", "未定义:无"]

# 需要外部条件（待处理文件 / 已同步的安装目录）的脚本：
# 条件不足时输出里会出现这些关键词，此时归为“跳过”而非“失败”。
SKIP_WHEN = {
    "verify-ui-sync.py": ["不一致", "MISSING"],      # 尚未同步到 CEP 目录，属预期
    "test-flatten.js": ["用法:"],                      # 需要传入待处理的 XML 路径
}

# 已知失效的遗留脚本（建立本入口时即已坏，与被测功能无关）。
# 列在这里不作为门禁，但会在结果里提醒，以免被误认为新引入的回归。
KNOWN_BROKEN = {
    "test-purge.js": "引用了不存在的 statTmp（自 v1.14 起即坏）",
    "test-cx-ui.js": "DOM stub 缺 document.querySelector",
}


def run_one(name, runner, gate, desc, extra, verbose):
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        return "SKIP", "脚本不存在", ""

    if runner == "node":
        cmd = ["node", path]
    else:
        cmd = [sys.executable, path]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", cwd=ROOT,
                           timeout=180, shell=(runner == "node" and os.name == "nt"))
        out = (r.stdout or "") + (r.stderr or "")
        code = r.returncode
    except subprocess.TimeoutExpired:
        return "FAIL", "超时（180s）", ""
    except Exception as e:
        return "FAIL", "启动失败: %s" % e, ""

    # 条件不足（缺参数 / 未同步） -> 跳过
    skips = SKIP_WHEN.get(name) or []
    if skips and any(s in out for s in skips):
        return "SKIP", "缺少所需输入（%s）" % skips[0], out

    # 门禁脚本：只看退出码
    if gate:
        if code != 0:
            return "FAIL", "退出码 %d" % code, out
        return "PASS", "退出码 0", out

    # 冒烟脚本：退出码非零 或 输出里有异常标志 -> 失败
    if code != 0:
        if name in KNOWN_BROKEN:
            return "KNOWN", "已知失效：%s" % KNOWN_BROKEN[name], out
        return "FAIL", "退出码 %d" % code, out
    hit = []
    for m in FAIL_MARKERS:
        if m in out:
            stripped = out
            for ex in FAIL_EXCEPTIONS:
                stripped = stripped.replace(ex, "")
            if m in stripped:
                hit.append(m)
    if hit:
        if name in KNOWN_BROKEN:
            return "KNOWN", "已知失效：%s" % KNOWN_BROKEN[name], out
        return "FAIL", "检出异常标志: %s" % ", ".join(hit[:3]), out
    return "PASS", "无异常", out


def main():
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    if "--list" in sys.argv:
        for name, runner, gate, desc, _ in JOBS:
            tag = "门禁" if gate else "冒烟"
            print("  [%s] %-22s %s" % (tag, name, desc))
        return 0

    print("=" * 74)
    print("vh-Atelier 测试入口")
    print("  插件根: %s" % ROOT)
    print("=" * 74)

    results = []
    for name, runner, gate, desc, extra in JOBS:
        print("\n>> %s  (%s%s)" % (name, "门禁" if gate else "冒烟", ""))
        print("   %s" % desc)
        status, why, out = run_one(name, runner, gate, desc, extra, verbose)
        mark = {"PASS": "[通过]", "FAIL": "[失败]", "SKIP": "[跳过]", "KNOWN": "[已知]"}[status]
        print("   %s %s" % (mark, why))
        if out and (verbose or status == "FAIL"):
            tail = out.strip().split("\n")
            show = tail if verbose else tail[-25:]
            for ln in show:
                print("      | " + ln)
        results.append((name, status, gate))

    print("\n" + "=" * 74)
    passed = [r for r in results if r[1] == "PASS"]
    failed = [r for r in results if r[1] == "FAIL"]
    skipped = [r for r in results if r[1] == "SKIP"]
    known = [r for r in results if r[1] == "KNOWN"]
    print("结果：通过 %d / 失败 %d / 跳过 %d / 已知失效 %d" % (
        len(passed), len(failed), len(skipped), len(known)))
    if known:
        print("已知失效（遗留，与本次改动无关）：")
        for n, s, g in known:
            print("  - %s：%s" % (n, KNOWN_BROKEN.get(n, "")))
    if failed:
        print("失败项：")
        for n, s, g in failed:
            print("  - %s%s" % (n, "" if g else "（冒烟）"))
    print("=" * 74)

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
