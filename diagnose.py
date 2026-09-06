# -*- coding: utf-8 -*-
"""
vh-Atelier 部署诊断 / 自检工具
用法: python diagnose.py
输出: 逐项检测结果 + 汇总报告（检测报告可复制发给开发者排查）

检测内容:
1. 基础环境：Python / Node / 系统信息
2. 插件文件完整性：关键资源文件
3. 各功能依赖：字幕识别(中/英) / 人声分离 / 语音克隆 / 识曲 / 音乐 / 视频下载 / 剧本
4. 本地服务连通性：ncm(17890) / video(17892)
"""
import os
import sys
import json
import platform
import subprocess
import shutil

# 插件根目录（本文件所在目录）
HERE = os.path.dirname(os.path.abspath(__file__))
EXT_ROOT = HERE  # diagnose.py 放在 com.vh.atelier 根

REPORT = []  # [{name, status, detail}]  status: ok/warn/fail/skip

def add(name, status, detail=''):
    REPORT.append({'name': name, 'status': status, 'detail': detail})
    mark = {'ok': '[OK]', 'warn': '[!]', 'fail': '[X]', 'skip': '[-]'}[status]
    print('%-4s %-28s %s' % (mark, name, detail))


def exists(rel):
    return os.path.exists(os.path.join(EXT_ROOT, rel))


def find_python():
    cands = [
        os.path.join(EXT_ROOT, 'runtime', 'python.exe'),
        os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
        os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    ]
    for c in cands:
        if os.path.exists(c):
            return c
    # 用 where 找
    try:
        r = subprocess.run(['where', 'python'], capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            for line in r.stdout.strip().split('\n'):
                p = line.strip()
                if p and 'WindowsApps' not in p:
                    return p
    except Exception:
        pass
    return None


def find_node():
    cands = [r'C:\Program Files\nodejs\node.exe', r'C:\Program Files (x86)\nodejs\node.exe']
    for c in cands:
        if os.path.exists(c):
            return c
    try:
        r = subprocess.run(['where', 'node'], capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip().split('\n')[0].strip()
    except Exception:
        pass
    return None


def py_module(python, mod):
    try:
        r = subprocess.run([python, '-c', 'import %s' % mod], capture_output=True, text=True, timeout=20)
        return r.returncode == 0
    except Exception:
        return False


def http_get(url, timeout=3):
    try:
        import urllib.request
        r = urllib.request.urlopen(url, timeout=timeout)
        return r.status, r.read().decode('utf-8', errors='replace')
    except Exception as e:
        return None, str(e)


def main():
    print('=' * 60)
    print('vh-Atelier 部署诊断 / 自检')
    print('插件目录:', EXT_ROOT)
    print('=' * 60)
    print()

    # ---- 1. 系统信息 ----
    add('系统', 'ok', platform.platform())
    add('Python版本', 'ok', sys.version.split()[0])
    add('架构', 'ok', platform.machine())

    # ---- 2. 基础环境 ----
    print()
    print('--- 基础环境 ---')
    py = find_python()
    if py:
        add('Python 可执行', 'ok', py)
    else:
        add('Python 可执行', 'fail', '未找到 Python，需安装 3.10+')
        py = None

    node = find_node()
    if node:
        add('Node.js', 'ok', node)
    else:
        add('Node.js', 'fail', '未找到 Node.js，需安装（音乐/视频服务依赖）')

    ffmpeg = os.path.join(EXT_ROOT, 'bin', 'ffmpeg-win32-x64.exe')
    if os.path.exists(ffmpeg):
        add('FFmpeg', 'ok', 'bin/ffmpeg-win32-x64.exe')
    else:
        add('FFmpeg', 'fail', '缺失 bin/ffmpeg-win32-x64.exe')

    ytdlp = os.path.join(EXT_ROOT, 'bin', 'yt-dlp.exe')
    if os.path.exists(ytdlp):
        add('yt-dlp', 'ok', 'bin/yt-dlp.exe')
    else:
        add('yt-dlp', 'fail', '缺失 bin/yt-dlp.exe')

    # ---- 3. 插件文件完整性 ----
    print()
    print('--- 插件文件完整性 ---')
    critical = [
        'index.html', 'CSXS/manifest.xml', 'js/main.js', 'js/script.js',
        'js/subtitle.js', 'js/check.js', 'js/clone.js', 'js/sfx.js',
        'js/musiclib.js', 'js/music.js', 'js/export.js', 'js/video.js',
        'jsx/host.jsx', 'jsx/folderpicker.ps1',
        'py/funasr_cli.py', 'py/cosyvoice_cli.py', 'py/docx_read.py',
        'py/identify_record.py', 'py/subtitle_check.py',
        'ncm/index.js', 'video/index.js', 'bg/bg.js',
    ]
    missing = [f for f in critical if not exists(f)]
    if missing:
        add('关键文件', 'fail', '缺失 %d 个: %s' % (len(missing), ', '.join(missing)))
    else:
        add('关键文件', 'ok', '%d 个关键文件齐全' % len(critical))

    # ---- 4. Python 依赖 ----
    print()
    print('--- Python 依赖 ---')
    if py:
        deps = [
            ('funasr', '字幕识别(中文)'),
            ('pyaudiowpatch', '听歌识曲录音'),
            ('torch', '语音克隆'),
            ('torchaudio', '语音克隆'),
        ]
        for mod, desc in deps:
            if py_module(py, mod):
                add('Python库: %s' % mod, 'ok', desc)
            else:
                add('Python库: %s' % mod, 'warn', '%s 需要 %s（pip install %s）' % (desc, mod, mod))

        # PyMuPDF（剧本解析）
        if py_module(py, 'fitz'):
            add('Python库: fitz', 'ok', '剧本解析(docx/pdf)')
        else:
            add('Python库: fitz', 'warn', '剧本解析需 PyMuPDF（pip install pymupdf）')
    else:
        add('Python库', 'skip', 'Python 未找到，跳过依赖检测')

    # ---- 5. 模型文件 ----
    print()
    print('--- 模型文件 ---')
    # FunASR 模型（中文识别）
    funasr_models = os.path.join(EXT_ROOT, 'models', 'funasr')
    if os.path.isdir(funasr_models):
        # 检查是否有模型内容
        has_model = False
        for dp, dn, fn in os.walk(funasr_models):
            if any(f.endswith('.pt') or f.endswith('.onnx') or f.endswith('.bin') for f in fn):
                has_model = True
                break
        if has_model:
            add('FunASR模型', 'ok', 'models/funasr')
        else:
            add('FunASR模型', 'warn', '目录存在但未找到模型文件（可能需重新下载）')
    else:
        add('FunASR模型', 'warn', '缺失 models/funasr（首次识别会自动下载，需联网）')

    # whisper 模型（英文识别）
    whisper_dir = os.path.join(EXT_ROOT, 'models')
    whisper_found = False
    if os.path.isdir(whisper_dir):
        for f in os.listdir(whisper_dir):
            if 'ggml' in f and f.endswith('.bin'):
                whisper_found = True
                break
    if whisper_found:
        add('Whisper模型', 'ok', 'models/ 下有 ggml 模型')
    else:
        add('Whisper模型', 'warn', '未找到 ggml 模型（英文识别需手动放入或从旧插件复制）')

    # whisper-cli.exe
    whisper_cli_cuda = os.path.join(EXT_ROOT, 'bin', 'whisper', 'cuda', 'whisper-cli.exe')
    whisper_cli_cpu = os.path.join(EXT_ROOT, 'bin', 'whisper', 'win32-x64', 'whisper-cli.exe')
    if os.path.exists(whisper_cli_cuda) or os.path.exists(whisper_cli_cpu):
        add('whisper-cli', 'ok', 'bin/whisper/ 存在')
    else:
        add('whisper-cli', 'warn', '缺失 whisper-cli.exe（英文识别需手动放入）')

    # sherpa（人声分离）
    sherpa = os.path.join(EXT_ROOT, 'bin', 'sherpa', 'sherpa-onnx-offline-source-separation.exe')
    spleeter_model = os.path.join(EXT_ROOT, 'models', 'spleeter')
    if os.path.exists(sherpa):
        add('sherpa引擎', 'ok', 'bin/sherpa/')
    else:
        add('sherpa引擎', 'warn', '缺失 sherpa 引擎（人声分离需手动放入）')
    if os.path.isdir(spleeter_model):
        add('Spleeter模型', 'ok', 'models/spleeter')
    else:
        add('Spleeter模型', 'warn', '缺失 spleeter 模型')

    # CosyVoice3（语音克隆）
    print()
    print('--- 语音克隆（CosyVoice3） ---')
    cfg_file = os.path.join(EXT_ROOT, 'collect', 'cosyvoice_paths.json')
    internal = r'D:\cosyvoice3_V30\_internal'
    model_dir = r'D:\cosyvoice3_V30\pretrained_models'
    if os.path.exists(cfg_file):
        try:
            with open(cfg_file, encoding='utf-8-sig') as f:
                cfg = json.load(f)
            internal = cfg.get('internal', internal)
            model_dir = cfg.get('model_dir', model_dir)
            add('CosyVoice配置', 'ok', 'collect/cosyvoice_paths.json 已配置')
        except Exception:
            add('CosyVoice配置', 'warn', '配置文件读取失败，用默认路径')
    else:
        add('CosyVoice配置', 'warn', '未配置（用默认 D:\\cosyvoice3_V30）')

    if os.path.isdir(internal):
        add('CosyVoice引擎', 'ok', internal)
    else:
        add('CosyVoice引擎', 'fail', '引擎目录不存在: %s（语音克隆不可用，请安装 CosyVoice3 或改配置）' % internal)
    if os.path.isdir(model_dir):
        add('CosyVoice模型', 'ok', model_dir)
    else:
        add('CosyVoice模型', 'fail', '模型目录不存在: %s' % model_dir)

    # ---- 6. 本地服务连通性 ----
    print()
    print('--- 本地服务 ---')
    # ncm (17890)
    st, body = http_get('http://127.0.0.1:17890/health')
    if st == 200:
        add('网易云服务(17890)', 'ok', body)
    else:
        add('网易云服务(17890)', 'warn', '未运行（首次打开音乐板块会自动启动，或需 npm install ncm/node_modules）')
    # video (17892)
    st2, _ = http_get('http://127.0.0.1:17892/health')
    if st2 == 200:
        add('视频服务(17892)', 'ok', '')
    else:
        add('视频服务(17892)', 'warn', '未运行（打开视频下载板块会自动启动）')

    # ---- 7. ncm node_modules ----
    ncm_nm = os.path.join(EXT_ROOT, 'ncm', 'node_modules')
    if os.path.isdir(ncm_nm) and os.path.exists(os.path.join(ncm_nm, 'NeteaseCloudMusicApi')):
        add('网易云依赖', 'ok', 'ncm/node_modules 已安装')
    else:
        add('网易云依赖', 'fail', 'ncm/node_modules 缺失，需在 ncm 目录运行 npm install')

    # ---- 汇总 ----
    print()
    print('=' * 60)
    ok_n = sum(1 for r in REPORT if r['status'] == 'ok')
    warn_n = sum(1 for r in REPORT if r['status'] == 'warn')
    fail_n = sum(1 for r in REPORT if r['status'] == 'fail')
    skip_n = sum(1 for r in REPORT if r['status'] == 'skip')
    print('汇总: %d OK / %d 警告 / %d 失败 / %d 跳过' % (ok_n, warn_n, fail_n, skip_n))
    print()
    if fail_n > 0:
        print('存在失败项，请优先解决以下:')
        for r in REPORT:
            if r['status'] == 'fail':
                print('  [X] %s: %s' % (r['name'], r['detail']))
    print()
    print('提示: 复制以上完整输出发给开发者，可快速定位问题。')
    print('=' * 60)

    # 保存报告到文件
    try:
        report_path = os.path.join(EXT_ROOT, 'diagnose_report.txt')
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write('vh-Atelier 诊断报告\n')
            f.write('时间: %s\n' % __import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
            f.write('系统: %s\n' % platform.platform())
            f.write('=' * 60 + '\n')
            for r in REPORT:
                f.write('[%s] %s: %s\n' % (r['status'].upper(), r['name'], r['detail']))
            f.write('=' * 60 + '\n')
            f.write('汇总: %d OK / %d 警告 / %d 失败 / %d 跳过\n' % (ok_n, warn_n, fail_n, skip_n))
        print('\n报告已保存到: %s' % report_path)
    except Exception:
        pass


if __name__ == '__main__':
    main()
