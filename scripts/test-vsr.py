# -*- coding: utf-8 -*-
"""本地去字幕（VSR）端到端验证。

用途：确认 VSR 环境可用、能真实跑出去字幕文件。
依赖已安装的 VSR 环境；未安装时会明确报出缺什么。

在插件目录下运行：
    python scripts/test-vsr.py
"""
import os
import sys
import json
import time
import subprocess

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # 插件根


def find_vsr_root():
    env = os.environ.get('VH_VSR_ROOT', '').strip()
    cands = [env] if env else []
    cands.append(os.path.join(D, 'py', '..', '..', '..', 'tools', 'VSR', 'video-subtitle-remover-main'))
    cur = D
    for _ in range(4):
        cur = os.path.dirname(cur)
        cands.append(os.path.join(cur, 'tools', 'VSR', 'video-subtitle-remover-main'))
        cands.append(os.path.join(cur, 'VSR', 'video-subtitle-remover-main'))
    for c in cands:
        if c and os.path.isfile(os.path.join(c, 'backend', 'main.py')):
            return os.path.abspath(c)
    return ''


ROOT = find_vsr_root()
VP = os.path.join(ROOT, 'venv', 'Scripts', 'python.exe') if ROOT else ''
CLIENT = os.path.join(D, 'py', 'vsr_client.py')

passed = 0
failed = 0


def ok(name, cond, extra=None):
    global passed, failed
    if cond:
        passed += 1
        print('  [OK]   ' + name)
    else:
        failed += 1
        print('  [FAIL] ' + name + ((' -> ' + str(extra)) if extra is not None else ''))


def run_json(args, timeout=1800, stream=False):
    """跑调用器，返回 (事件列表, 退出码)"""
    cmd = [VP, CLIENT] + args
    p = subprocess.Popen(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         text=True, encoding='utf-8', errors='replace', bufsize=1)
    events = []
    t0 = time.time()
    last_pct = -1
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
            events.append(d)
            if stream and d.get('stage') == 'progress':
                pct = d.get('percent', 0)
                if pct >= last_pct + 20:
                    last_pct = pct
                    print('       进度 %d%%  %.0fs' % (pct, time.time() - t0))
        except Exception:
            events.append({'stage': 'raw', 'line': line[:200]})
    rc = p.wait()
    return events, rc


def main():
    if not ROOT:
        print('未找到 VSR 目录（可用环境变量 VH_VSR_ROOT 指定）')
        print('安装方法见 docs/本地去字幕VSR.md')
        return 2
    if not os.path.exists(VP):
        print('未找到 VSR venv：' + VP)
        print('请先按 docs/本地去字幕VSR.md 建 venv 并装依赖')
        return 2
    print('VSR:', ROOT)
    print()
    print('=== 1. 环境自检 ===')
    ev, rc = run_json(['check'], timeout=300)
    chk = ev[-1] if ev else {}
    ok('check 返回 ok', chk.get('ok') is True, chk)
    ok('检测到 torch', chk.get('hasTorch') is True)
    ok('启用了 CUDA', chk.get('hasCuda') is True, chk.get('reasons'))
    if chk.get('gpu'):
        print('       显卡:', chk['gpu'], '| torch', chk.get('torchVer'))

    print()
    print('=== 2. 探测样片 ===')
    test = os.path.join(ROOT, 'test', 'test.mp4')
    ok('样片存在', os.path.exists(test), test)
    ev, rc = run_json(['probe', '--input', test], timeout=180)
    pr = ev[-1] if ev else {}
    ok('probe 读出分辨率', bool(pr.get('width') and pr.get('height')), pr)
    print('       %sx%s  %.1fs' % (pr.get('width'), pr.get('height'), pr.get('duration') or 0))

    print()
    print('=== 3. 真实去字幕（STTN 自动）===')
    out = os.path.join(ROOT, 'test', 'test_erased.mp4')
    if os.path.exists(out):
        try:
            os.remove(out)
        except Exception:
            pass
    ev, rc = run_json(['run', '--input', test, '--output', out,
                       '--mode', 'sttn-auto', '--progress'], timeout=3600, stream=True)
    done = next((e for e in ev if e.get('stage') == 'done'), {})
    ok('去字幕成功', done.get('ok') is True, done.get('tail'))
    ok('产出文件存在', os.path.exists(out))
    if os.path.exists(out):
        mb = os.path.getsize(out) / 1024 ** 2
        ok('产出文件大小合理（>0.1MB）', mb > 0.1, '%.2f MB' % mb)
        print('       输出 %.2f MB，用时 %ss' % (mb, done.get('elapsed')))
    ok('有进度事件', any(e.get('stage') == 'progress' for e in ev))

    print()
    print('=== 4. 固定区域模式（相对比例→像素）===')
    out2 = os.path.join(ROOT, 'test', 'test_erased_area.mp4')
    ev2, rc2 = run_json(['run', '--input', test, '--output', out2,
                         '--mode', 'sttn-auto',
                         '--area', '0.75', '1', '0', '1', '--progress'], timeout=3600)
    st = next((e for e in ev2 if e.get('stage') == 'start'), {})
    coords = st.get('coords') or []
    ok('区域坐标已换算', bool(coords), coords)
    if coords:
        W = (st.get('video') or {}).get('width') or 0
        H = (st.get('video') or {}).get('height') or 0
        y0, y1, x0, x1 = coords[0]
        ok('y0 约为高度的 75%', abs(y0 - H * 0.75) <= 2, 'y0=%s H=%s' % (y0, H))
        ok('x 覆盖全宽', x0 == 0 and x1 == W, 'x0=%s x1=%s W=%s' % (x0, x1, W))
    done2 = next((e for e in ev2 if e.get('stage') == 'done'), {})
    ok('固定区域模式成功', done2.get('ok') is True, done2.get('tail'))

    print()
    print('通过 %d / 失败 %d' % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
