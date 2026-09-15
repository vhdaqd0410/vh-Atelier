# -*- coding: utf-8 -*-
"""
安装 post-commit 钩子：提交后自动同步源码 -> PR 安装目录。

用法（仓库根目录执行一次即可，新机器/重新克隆后需重跑）：
    python tools/install-hook.py

为什么需要：
    PR 实际加载的是 C:\\Users\\<用户>\\AppData\\Roaming\\Adobe\\CEP\\extensions\\com.vh.atelier，
    而开发改的是仓库里的 com.vh.atelier\\。两边是两个目录，改完必须同步，
    否则 PR 里看不到改动。靠"记得手动跑"迟早会漏，所以做成提交后自动执行。

卸载：
    删除 .git/hooks/post-commit 即可。
"""
import os
import sys
import shutil
import stat

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
HOOK_SRC = os.path.join(REPO, 'tools', 'hooks', 'post-commit')
HOOK_DST = os.path.join(REPO, '.git', 'hooks', 'post-commit')


def main():
    if not os.path.isfile(HOOK_SRC):
        print('[错误] 找不到钩子源文件:', HOOK_SRC)
        return 1
    if not os.path.isdir(os.path.join(REPO, '.git')):
        print('[错误] 当前目录不是 git 仓库根:', REPO)
        return 1

    os.makedirs(os.path.dirname(HOOK_DST), exist_ok=True)
    if os.path.exists(HOOK_DST):
        print('[提示] 已存在 post-commit，将被覆盖')
    shutil.copyfile(HOOK_SRC, HOOK_DST)
    # 赋予可执行权限（Windows 上 git 也会检查，保险起见）
    try:
        st = os.stat(HOOK_DST)
        os.chmod(HOOK_DST, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    except Exception:
        pass

    print('[完成] 已安装 post-commit 钩子：')
    print('       ', HOOK_DST)
    print()
    print('之后每次 git commit 都会自动把源码同步到 PR 安装目录。')
    print('如需临时跳过同步，可设置环境变量 VH_SKIP_SYNC=1（见钩子脚本）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
