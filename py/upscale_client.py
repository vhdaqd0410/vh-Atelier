# -*- coding: utf-8 -*-
"""本地超分调用器（Real-ESRGAN-ncnn-vulkan + ffmpeg，供插件子进程调用）。

设计要点：
  - 不依赖 Python 的 torch/CUDA，直接调用 ncnn-vulkan 绿色可执行
    （走 Vulkan，N 卡 / A 卡 / Intel 核显都能跑）
  - 视频流程：ffmpeg 抽帧 -> 逐帧超分 -> ffmpeg 缩放/回拼（音频直接 copy）
  - 输出统一 JSON 行，便于 JS 解析
  - 通过环境变量 VH_FFMPEG 指定 ffmpeg 路径（插件会传自己的 bin/ffmpeg）

子命令：
  check                              环境自检（引擎/模型/ffmpeg/Vulkan 设备）
  probe --input X                    探测分辨率/帧率/时长
  run --input X [--output Y]         执行超分
      [--scale 2|3|4]                放大倍率
      [--model anime|photo|anime4x]  模型
      [--target 1080|1440|2160|none] 目标长边像素；none=保持放大后原始尺寸
      [--tile 0]                     分块大小（0=自动；显存不足时调小）
      [--progress]                   流式输出进度 JSON
"""
import os
import sys
import json
import time
import shutil
import argparse
import subprocess
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MODELS = {
    'anime':   {'name': 'realesr-animevideov3',   'scales': [2, 3, 4],
                'desc': '动漫/视频通用（最快）'},
    'photo':   {'name': 'realesrgan-x4plus',      'scales': [4],
                'desc': '真人写实（慢，细节强）'},
    'anime4x': {'name': 'realesrgan-x4plus-anime', 'scales': [4],
                'desc': '动漫 4x（细节强）'},
}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def find_engine_root():
    """找 realesrgan-ncnn-vulkan.exe 所在目录"""
    cands = []
    env = (os.environ.get('VH_REALESRGAN_ROOT') or '').strip()
    if env:
        cands.append(env)
    here = os.path.dirname(os.path.abspath(__file__))
    ext = os.path.dirname(here)                      # 插件根
    cands += [
        os.path.join(ext, 'bin', 'realesrgan'),
        os.path.join(ext, 'bin', 'realesrgan', 'realesrgan-ncnn-vulkan-v0.2.0-windows'),
        os.path.join(ext, 'bin'),
    ]
    for base in [r'F:\OH-WorkSpace\tools', os.path.dirname(ext),
                 r'C:\Users\Admin\Desktop']:
        cands.append(os.path.join(base, 'RealESRGAN', 'pkg',
                                  'realesrgan-ncnn-vulkan-v0.2.0-windows'))
    for d in cands:
        if d and os.path.isfile(os.path.join(d, 'realesrgan-ncnn-vulkan.exe')):
            return d
    return ''


def find_ffmpeg():
    """找 ffmpeg：环境变量 > 插件 bin > PATH"""
    env = (os.environ.get('VH_FFMPEG') or '').strip()
    if env and os.path.isfile(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    ext = os.path.dirname(here)
    for d in [os.path.join(ext, 'bin'), ext]:
        for n in ('ffmpeg-win32-x64.exe', 'ffmpeg.exe'):
            p = os.path.join(d, n)
            if os.path.isfile(p):
                return p
    return shutil.which('ffmpeg') or ''


def _run(cmd, timeout=7200, cwd=None):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                          encoding='utf-8', errors='replace', cwd=cwd)


def probe_video(ff, path):
    """拿分辨率/帧率/时长（优先 ffprobe，退到 ffmpeg -i 解析）"""
    info = {'width': 0, 'height': 0, 'fps': 0.0, 'duration': 0.0, 'hasAudio': False}
    ffprobe = ''
    if ff:
        d = os.path.dirname(ff)
        for n in ('ffprobe.exe', 'ffprobe-win32-x64.exe'):
            if os.path.isfile(os.path.join(d, n)):
                ffprobe = os.path.join(d, n)
                break
        if not ffprobe and ff.lower().endswith('ffmpeg.exe'):
            cand = os.path.join(d, os.path.basename(ff).replace('ffmpeg', 'ffprobe'))
            if os.path.isfile(cand):
                ffprobe = cand
    if ffprobe:
        try:
            r = _run([ffprobe, '-v', 'quiet', '-print_format', 'json',
                      '-show_streams', '-show_format', path], timeout=120)
            d = json.loads(r.stdout or '{}')
            for s in (d.get('streams') or []):
                if s.get('codec_type') == 'video' and not info['width']:
                    info['width'] = int(s.get('width') or 0)
                    info['height'] = int(s.get('height') or 0)
                    fr = str(s.get('r_frame_rate') or '')
                    if '/' in fr:
                        a, b = fr.split('/')[:2]
                        try:
                            info['fps'] = float(a) / float(b) if float(b) else 0.0
                        except Exception:
                            pass
                if s.get('codec_type') == 'audio':
                    info['hasAudio'] = True
            info['duration'] = float((d.get('format') or {}).get('duration') or 0)
        except Exception:
            pass
    if not info['width'] and ff:
        import re
        try:
            r = _run([ff, '-hide_banner', '-i', path], timeout=120)
            txt = (r.stderr or '')
            m = re.search(r'(\d{2,5})x(\d{2,5})', txt)
            if m:
                info['width'], info['height'] = int(m.group(1)), int(m.group(2))
            m2 = re.search(r'(\d+(?:\.\d+)?)\s*fps', txt)
            if m2:
                info['fps'] = float(m2.group(1))
            m3 = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', txt)
            if m3:
                info['duration'] = (int(m3.group(1)) * 3600 + int(m3.group(2)) * 60
                                    + float(m3.group(3)))
            if 'Audio:' in txt:
                info['hasAudio'] = True
        except Exception:
            pass
    return info


def cmd_check(args):
    root = find_engine_root()
    ff = find_ffmpeg()
    out = {'ok': False, 'engineRoot': root, 'ffmpeg': ff,
           'models': [], 'devices': '', 'reasons': []}
    if not root:
        out['reasons'].append('未找到 realesrgan-ncnn-vulkan（放到插件的 bin/realesrgan/）')
    if not ff:
        out['reasons'].append('未找到 ffmpeg（插件的 bin/ffmpeg-win32-x64.exe）')
    if root:
        md = os.path.join(root, 'models')
        if os.path.isdir(md):
            out['models'] = sorted([f for f in os.listdir(md) if f.endswith('.param')])
        if not out['models']:
            out['reasons'].append('models 目录为空（需要 realesr-animevideov3-x2 等模型）')
        try:
            tmp = tempfile.mkdtemp(prefix='vhup_')
            ip = os.path.join(tmp, 'a.png')
            op = os.path.join(tmp, 'b.png')
            if ff:
                _run([ff, '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x64',
                      '-frames:v', '1', ip], timeout=120)
                r = _run([os.path.join(root, 'realesrgan-ncnn-vulkan.exe'),
                          '-i', ip, '-o', op, '-n', 'realesr-animevideov3', '-s', '2',
                          '-m', os.path.join(root, 'models'), '-g', '0'],
                         timeout=300, cwd=root)
                err = (r.stderr or '')
                for ln in err.split('\n'):
                    if ('GeForce' in ln or 'NVIDIA' in ln or 'AMD' in ln
                            or 'Intel' in ln or 'Radeon' in ln):
                        out['devices'] = ln.strip()
                        break
                out['smokeOk'] = os.path.isfile(op)
                if not out['smokeOk']:
                    out['reasons'].append('试跑未产出结果：' + (err[-300:] or '无输出'))
            shutil.rmtree(tmp, ignore_errors=True)
        except Exception as e:
            out['reasons'].append('试跑异常: %s' % str(e)[:200])
    out['ok'] = bool(root and ff and out.get('smokeOk'))
    if out['ok']:
        out['gpu'] = out.get('devices') or 'Vulkan 设备'
    emit(out)
    return 0 if out['ok'] else 1


def cmd_probe(args):
    info = probe_video(find_ffmpeg(), args.input)
    info['ok'] = bool(info.get('width'))
    emit(info)
    return 0


def _count_frames(d):
    try:
        return len([f for f in os.listdir(d) if f.lower().endswith('.png')])
    except Exception:
        return 0


def cmd_run(args):
    t0 = time.time()
    ff = find_ffmpeg()
    root = find_engine_root()
    if not ff:
        emit({'stage': 'done', 'ok': False, 'error': '未找到 ffmpeg'})
        return 1
    if not root:
        emit({'stage': 'done', 'ok': False, 'error': '未找到 realesrgan 引擎'})
        return 1

    mdl = MODELS.get(args.model, MODELS['anime'])
    scale = int(args.scale or 2)
    if scale not in mdl['scales']:
        scale = mdl['scales'][0]
    exe = os.path.join(root, 'realesrgan-ncnn-vulkan.exe')
    models_dir = os.path.join(root, 'models')

    src = args.input
    if not os.path.isfile(src):
        emit({'stage': 'done', 'ok': False, 'error': '输入文件不存在: ' + src})
        return 1
    info = probe_video(ff, src)
    if not info['width']:
        emit({'stage': 'done', 'ok': False, 'error': '读不出视频分辨率'})
        return 1
    W, H = info['width'], info['height']
    fps = info['fps'] or 30.0

    out = args.output or (os.path.splitext(src)[0] + '_up%d.mp4' % scale)
    tmp = tempfile.mkdtemp(prefix='vhup_')
    fdir = os.path.join(tmp, 'in')
    udir = os.path.join(tmp, 'up')
    os.makedirs(fdir, exist_ok=True)
    os.makedirs(udir, exist_ok=True)

    emit({'stage': 'start', 'video': {'width': W, 'height': H, 'fps': fps,
                                      'duration': info['duration']},
          'model': mdl['name'], 'scale': scale, 'target': args.target})

    try:
        # 1) 抽帧
        emit({'stage': 'log', 'line': '抽帧中...'})
        r = _run([ff, '-y', '-hide_banner', '-loglevel', 'error',
                  '-i', src, '-vsync', '0', '-qscale:v', '1',
                  os.path.join(fdir, 'f%06d.png')], timeout=3600)
        if r.returncode != 0:
            emit({'stage': 'done', 'ok': False,
                  'error': '抽帧失败: ' + (r.stderr or '')[-300:]})
            return 1
        total = _count_frames(fdir)
        if not total:
            emit({'stage': 'done', 'ok': False, 'error': '抽帧结果为空'})
            return 1
        emit({'stage': 'log', 'line': '抽帧完成：%d 帧' % total})
        emit({'stage': 'progress', 'percent': 5,
              'elapsed': round(time.time() - t0, 1), 'phase': '抽帧完成'})

        # 2) 逐帧超分（目录模式，模型只加载一次）
        emit({'stage': 'log', 'line': '超分中（%s x%d）...' % (mdl['name'], scale)})
        proc = subprocess.Popen(
            [exe, '-i', fdir, '-o', udir, '-n', mdl['name'], '-s', str(scale),
             '-m', models_dir, '-g', '0', '-t', str(args.tile or 0), '-j', '1:2:2'],
            cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', bufsize=1)
        last = 0.0
        for _line in proc.stdout:
            now = time.time()
            if now - last > 1.0:
                last = now
                done_n = _count_frames(udir)
                p = 5 + (done_n / float(total)) * 85 if total else 5
                emit({'stage': 'progress', 'percent': round(min(p, 90), 1),
                      'elapsed': round(now - t0, 1),
                      'phase': '超分 %d/%d' % (done_n, total)})
        proc.wait()
        up_n = _count_frames(udir)
        if proc.returncode != 0 or up_n == 0:
            emit({'stage': 'done', 'ok': False,
                  'error': '超分失败（退出码 %s，产出 %d 帧）' % (proc.returncode, up_n)})
            return 1
        emit({'stage': 'log', 'line': '超分完成：%d 帧' % up_n})

        # 3) 回拼（可带目标分辨率缩放）
        ow, oh = W * scale, H * scale
        vf = None
        tgt = str(args.target or '').lower()
        if tgt and tgt not in ('none', '0'):
            tw = int(float(tgt))
            if W >= H:
                th = int(round(tw * H / float(W))); th -= th % 2
                vf = 'scale=%d:%d:flags=lanczos' % (tw, th)
                ow, oh = tw, th
            else:
                nw = int(round(tw * W / float(H))); nw -= nw % 2
                vf = 'scale=%d:%d:flags=lanczos' % (nw, tw)
                ow, oh = nw, tw
        emit({'stage': 'log', 'line': '回拼中（输出 %dx%d）...' % (ow, oh)})
        cmd = [ff, '-y', '-hide_banner', '-loglevel', 'error',
               '-framerate', str(fps),
               '-i', os.path.join(udir, 'f%06d.png'), '-i', src]
        if vf:
            cmd += ['-vf', vf]
        cmd += ['-map', '0:v:0']
        if info['hasAudio']:
            cmd += ['-map', '1:a:0?', '-c:a', 'copy']
        cmd += ['-c:v', 'libx264', '-crf', '16', '-preset', 'medium',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-shortest', out]
        r2 = _run(cmd, timeout=7200)
        if r2.returncode != 0 or not os.path.isfile(out):
            emit({'stage': 'done', 'ok': False,
                  'error': '回拼失败: ' + (r2.stderr or '')[-300:]})
            return 1

        try:
            size = os.path.getsize(out)
        except Exception:
            size = 0
        emit({'stage': 'done', 'ok': True, 'output': out, 'size': size,
              'elapsed': round(time.time() - t0, 1), 'frames': up_n,
              'outWidth': ow, 'outHeight': oh, 'model': mdl['name'], 'scale': scale})
        return 0
    except Exception as e:
        emit({'stage': 'done', 'ok': False, 'error': str(e)[:300]})
        return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description='本地超分（Real-ESRGAN-ncnn-vulkan）')
    sub = ap.add_subparsers(dest='cmd')
    sub.add_parser('check')
    p1 = sub.add_parser('probe')
    p1.add_argument('--input', required=True)
    p2 = sub.add_parser('run')
    p2.add_argument('--input', required=True)
    p2.add_argument('--output', default='')
    p2.add_argument('--scale', type=int, default=2)
    p2.add_argument('--model', default='anime')
    p2.add_argument('--target', default='1080')
    p2.add_argument('--tile', type=int, default=0)
    p2.add_argument('--progress', action='store_true')
    p2.add_argument('--mode', default='')
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
