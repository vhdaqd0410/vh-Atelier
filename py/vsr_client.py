# -*- coding: utf-8 -*-
"""VSR 本地去字幕调用器（供插件子进程调用）。

设计要点：
  - 插件侧不直接引 torch/paddle，而是调用 VSR 独立 venv 的解释器
  - 输出统一 JSON 行，便于 JS 解析
  - 支持「固定字幕区域」（短剧/漫剧字幕位置稳定，比自动检测快且稳）
  - 进度以 JSON 行流式输出，供插件显示

子命令：
  check                              环境自检
  probe --input X                    探测分辨率/时长
  run --input X [--output Y]         执行去字幕
      [--area ymin ymax xmin xmax]   可多次；<=1 视为相对比例
      [--mode sttn-auto|sttn-det|lama|propainter|opencv]
      [--progress]
"""
import os
import sys
import json
import time
import argparse
import subprocess
import re

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def find_vsr_root():
    """定位 VSR 源码目录：环境变量 > 插件同级 tools/VSR > 常见位置"""
    cands = []
    env = os.environ.get('VH_VSR_ROOT', '').strip()
    if env:
        cands.append(env)
    here = os.path.dirname(os.path.abspath(__file__))
    ext = os.path.dirname(here)
    for base in [ext, os.path.dirname(ext),
                 r'F:\OH-WorkSpace\tools', r'F:\OH-WorkSpace\plugins',
                 r'C:\Users\Admin\Desktop']:
        cands.append(os.path.join(base, 'VSR', 'video-subtitle-remover-main'))
        cands.append(os.path.join(base, 'tools', 'VSR', 'video-subtitle-remover-main'))
        cands.append(os.path.join(base, 'video-subtitle-remover-main'))
    for c in cands:
        if c and os.path.isfile(os.path.join(c, 'backend', 'main.py')):
            return c
    return ''


def venv_python(root):
    p = os.path.join(root, 'venv', 'Scripts', 'python.exe')
    return p if os.path.exists(p) else ''


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def probe_video(path):
    info = {'width': 0, 'height': 0, 'duration': 0.0}
    root = find_vsr_root()
    for fp in [os.path.join(root, 'backend', 'ffmpeg', 'win_x64', 'ffprobe.exe'),
               os.path.join(root, 'backend', 'ffmpeg', 'ffprobe.exe')]:
        if os.path.isfile(fp):
            try:
                r = subprocess.run([fp, '-v', 'quiet', '-print_format', 'json',
                                    '-show_streams', '-show_format', path],
                                   capture_output=True, text=True, timeout=60,
                                   encoding='utf-8', errors='replace')
                d = json.loads(r.stdout or '{}')
                for s in (d.get('streams') or []):
                    if s.get('codec_type') == 'video':
                        info['width'] = int(s.get('width') or 0)
                        info['height'] = int(s.get('height') or 0)
                info['duration'] = float((d.get('format') or {}).get('duration') or 0)
                if info['width']:
                    return info
            except Exception:
                pass
    try:
        import cv2
        cap = cv2.VideoCapture(path)
        info['width'] = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        info['height'] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 0
        n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        info['duration'] = (n / fps) if fps else 0
        cap.release()
    except Exception:
        pass
    return info


def cmd_check(args):
    root = find_vsr_root()
    vp = venv_python(root) if root else ''
    out = {'ok': False, 'vsrRoot': root, 'venvPython': vp,
           'hasTorch': False, 'hasCuda': False, 'gpu': '', 'reasons': []}
    if not root:
        out['reasons'].append('未找到 VSR 目录（video-subtitle-remover-main）')
        emit(out); return 0
    if not vp:
        out['reasons'].append('未找到 VSR 的 venv（venv\\Scripts\\python.exe）')
        emit(out); return 0
    code = (
        "import json\n"
        "r={'torch':False,'cuda':False,'gpu':'','ver':''}\n"
        "try:\n"
        "    import torch\n"
        "    r['torch']=True; r['cuda']=bool(torch.cuda.is_available())\n"
        "    r['ver']=torch.__version__\n"
        "    if r['cuda']: r['gpu']=torch.cuda.get_device_name(0)\n"
        "except Exception as e:\n"
        "    r['err']=str(e)[:200]\n"
        "print(json.dumps(r))\n"
    )
    try:
        r = subprocess.run([vp, '-c', code], capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=240, cwd=root)
        line = (r.stdout or '').strip().split('\n')[-1] or '{}'
        d = json.loads(line)
        out['hasTorch'] = bool(d.get('torch'))
        out['hasCuda'] = bool(d.get('cuda'))
        out['gpu'] = d.get('gpu') or ''
        out['torchVer'] = d.get('ver') or ''
        if not out['hasTorch']:
            out['reasons'].append('venv 里没有可用 torch：' + (d.get('err') or '未安装'))
        elif not out['hasCuda']:
            out['reasons'].append('torch 用不了 CUDA（会退回 CPU，速度很慢）')
    except Exception as e:
        out['reasons'].append('自检失败: %s' % str(e)[:160])
    # VSR 主程序存在
    out['hasMain'] = os.path.isfile(os.path.join(root, 'backend', 'main.py'))
    out['ok'] = bool(out['hasTorch'] and out['hasMain'])
    emit(out)
    return 0 if out['ok'] else 1


def cmd_probe(args):
    info = probe_video(args.input)
    info['ok'] = bool(info.get('width'))
    emit(info)
    return 0


def _norm_area(area, W, H):
    ymin, ymax, xmin, xmax = area
    if max(ymin, ymax, xmin, xmax) <= 1.0:
        return (int(round(ymin * H)), int(round(ymax * H)),
                int(round(xmin * W)), int(round(xmax * W)))
    return (int(ymin), int(ymax), int(xmin), int(xmax))


def cmd_run(args):
    root = find_vsr_root()
    vp = venv_python(root) if root else ''
    if not root or not vp:
        emit({'ok': False, 'error': 'VSR 或 venv 未就绪，请先执行 check'})
        return 2
    if not os.path.isfile(args.input):
        emit({'ok': False, 'error': '输入文件不存在: %s' % args.input})
        return 2

    out_path = args.output
    if not out_path:
        base, ext = os.path.splitext(args.input)
        out_path = base + '_erased' + (ext or '.mp4')

    info = probe_video(args.input)
    W, H = info.get('width') or 0, info.get('height') or 0
    coords = []
    for a in (args.area or []):
        coords.append(_norm_area(a, W, H) if (W and H) else tuple(int(x) for x in a))

    cmd = [vp, os.path.join(root, 'backend', 'main.py'),
           '-i', args.input, '-o', out_path, '--inpaint-mode', args.mode]
    for c in coords:
        cmd += ['-c'] + [str(x) for x in c]

    emit({'ok': True, 'stage': 'start', 'input': args.input, 'output': out_path,
          'mode': args.mode, 'coords': coords, 'video': info})

    t0 = time.time()
    try:
        proc = subprocess.Popen(cmd, cwd=root, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True,
                                encoding='utf-8', errors='replace', bufsize=1)
    except Exception as e:
        emit({'ok': False, 'error': '无法启动 VSR: %s' % str(e)[:200]})
        return 3

    pct_re = re.compile(r'(\d{1,3})%\|')
    last_emit = 0.0
    tail = []
    for line in proc.stdout:
        line = line.rstrip('\n')
        tail.append(line)
        if len(tail) > 40:
            tail.pop(0)
        m = pct_re.search(line)
        now = time.time()
        if m and now - last_emit > 0.4:
            last_emit = now
            emit({'ok': True, 'stage': 'progress', 'percent': int(m.group(1)),
                  'elapsed': round(now - t0, 1)})
        elif args.progress and ('Error' in line or 'Traceback' in line):
            emit({'ok': True, 'stage': 'log', 'line': line[:300]})
    rc = proc.wait()

    ok = (rc == 0) and os.path.isfile(out_path)
    emit({'ok': ok, 'stage': 'done',
          'output': out_path if ok else '',
          'returncode': rc, 'elapsed': round(time.time() - t0, 1),
          'size': (os.path.getsize(out_path) if ok else 0),
          'tail': [] if ok else tail[-8:]})
    return 0 if ok else 4


def main():
    ap = argparse.ArgumentParser(description='vh-Atelier 本地去字幕（VSR）调用器')
    sub = ap.add_subparsers(dest='cmd')
    sub.add_parser('check')

    p2 = sub.add_parser('probe')
    p2.add_argument('--input', required=True)

    p3 = sub.add_parser('run')
    p3.add_argument('--input', required=True)
    p3.add_argument('--output', default='')
    p3.add_argument('--area', nargs=4, type=float, action='append',
                    help='ymin ymax xmin xmax（<=1 视为相对比例）')
    p3.add_argument('--mode', default='sttn-auto',
                    choices=['sttn-auto', 'sttn-det', 'lama', 'propainter', 'opencv'])
    p3.add_argument('--progress', action='store_true')

    args = ap.parse_args()
    if args.cmd == 'check':
        return cmd_check(args)
    if args.cmd == 'probe':
        return cmd_probe(args)
    if args.cmd == 'run':
        return cmd_run(args)
    ap.print_help()
    return 1


if __name__ == '__main__':
    sys.exit(main())
