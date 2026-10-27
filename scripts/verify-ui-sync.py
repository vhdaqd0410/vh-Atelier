# -*- coding: utf-8 -*-
"""验证 UI 改动已落到 CEP 真目录"""
import io, sys, os, hashlib, json, re

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SRC = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'
DST = r'C:\Users\Admin\AppData\Roaming\Adobe\CEP\extensions\com.vh.atelier'


def sha(p):
    return hashlib.md5(open(p, 'rb').read()).hexdigest()[:12] if os.path.exists(p) else 'MISSING'


ok = True
print('=== 文件落盘校验 ===')
for f in ['index.html', 'css/atelier.css', 'js/flatten-ui.js', 'js/tool-panel.js', 'version.json']:
    a = sha(os.path.join(SRC, f.replace('/', os.sep)))
    b = sha(os.path.join(DST, f.replace('/', os.sep)))
    good = a == b and a != 'MISSING'
    if not good:
        ok = False
    print('  %s %-22s %s / %s' % ('OK ' if good else 'BAD', f, a, b))

print()
print('=== 真目录内容抽检 ===')
dh = open(os.path.join(DST, 'index.html'), encoding='utf-8', errors='replace').read()
# 导航顺序
i = dh.find('<div class="ws-groups">')
groups = re.findall(r'data-group="([\w-]+)"', dh[i:i + 1300])
print('  导航第一组:', groups[0] if groups else '(无)')
print('  含 left/right 分栏:', 'cx-layout' in dh)
print('  含刷新按钮:', 'cxRefreshSeq' in dh)
print('  含步骤按钮:', 'cx-step-no' in dh)

dc = open(os.path.join(DST, 'css', 'atelier.css'), encoding='utf-8', errors='replace').read()
print('  日志分级样式:', all(('.cx-ln-' + k) in dc for k in ('info', 'dim', 'ok', 'warn', 'err', 'step', 'sep')))

djs = open(os.path.join(DST, 'js', 'flatten-ui.js'), encoding='utf-8', errors='replace').read()
print('  文件名自动填充:', 'autoFillName' in djs)
print('  时间戳日志:', 'cx-ln-time' in djs)

dv = json.load(open(os.path.join(DST, 'version.json'), encoding='utf-8'))
print('  安装目录版本:', dv.get('version'))

print()
print('结论:', '已正确落盘' if ok else '有文件不一致')
