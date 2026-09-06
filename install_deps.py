# -*- coding: utf-8 -*-
"""
vh-Atelier 依赖安装脚本
用法: python install_deps.py
自动检测 Python，安装插件运行所需的 pip 依赖。
"""
import os
import sys
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))

def find_python():
    cands = [
        os.path.join(HERE, 'runtime', 'python.exe'),
        os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
        os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
    ]
    for c in cands:
        if os.path.exists(c):
            return c
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

def run(cmd):
    print('>>>', ' '.join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print('    失败:', (r.stderr or r.stdout)[-300:])
        return False
    return True

def main():
    print('=' * 60)
    print('vh-Atelier 依赖安装')
    print('=' * 60)
    py = find_python()
    if not py:
        print('[错误] 未找到 Python。请先安装 Python 3.10+（勾选 Add to PATH）')
        return 1
    print('使用 Python:', py)

    # 安装依赖
    deps = [
        'funasr',          # 字幕识别(中文)
        'pyaudiowpatch',   # 听歌识曲录音
        'pymupdf',         # 剧本解析(docx/pdf)
        'torch',           # 语音克隆（若已装 CosyVoice3 工具自带，可跳过）
        'torchaudio',
    ]
    print()
    print('将安装以下依赖（torch 较大，若 CosyVoice3 工具已自带可跳过）:')
    for d in deps:
        print('  -', d)
    print()
    resp = input('继续安装? (回车继续 / 输入 n 跳过 torch): ').strip().lower()
    if resp == 'n':
        deps = deps[:3]  # 只装轻量依赖
        print('跳过 torch/torchaudio（假设 CosyVoice3 工具已自带）')

    for d in deps:
        print()
        print('安装', d, '...')
        ok = run([py, '-m', 'pip', 'install', '--upgrade', d])
        if not ok:
            print('[警告]', d, '安装失败，可稍后手动执行: pip install', d)

    print()
    print('依赖安装完成。运行 diagnose.py 可检测环境完整性。')
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\n已取消')
