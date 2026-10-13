# -*- coding: utf-8 -*-
"""检查：顶栏「运行日志」按钮与浮层是否真的接上了（曾出现按钮无任何绑定）

在插件目录下运行：python scripts/test-log-overlay.py
"""
import os, sys, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
    D = os.path.abspath(sys.argv[1])
elif os.path.basename(_HERE).lower() == 'scripts':
    D = os.path.dirname(_HERE)
else:
    D = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'

fails = []
def chk(name, cond, extra=''):
    if cond:
        print('  [OK]   ' + name)
    else:
        print('  [FAIL] ' + name + (' -> ' + extra if extra else ''))
        fails.append(name)

html = open(os.path.join(D, 'index.html'), encoding='utf-8', errors='replace').read()
print('=== 1. HTML 结构存在 ===')
for i in ['btnLogView', 'logOverlay', 'logBody', 'logClose', 'logRefresh', 'logOpen', 'logClear', 'logPath']:
    chk('HTML 有 #%s' % i, ('id="%s"' % i) in html)

print()
print('=== 2. 浮层脚本已引入 ===')
chk('index.html 引入 log-overlay.js', 'js/log-overlay.js' in html)

print()
print('=== 3. 绑定逻辑存在 ===')
p = os.path.join(D, 'js', 'log-overlay.js')
chk('log-overlay.js 存在', os.path.isfile(p))
if os.path.isfile(p):
    t = open(p, encoding='utf-8', errors='replace').read()
    for i, why in [('btnLogView', '打开按钮'),
                   ('logOverlay', '浮层容器'),
                   ('logBody', '正文'),
                   ('logClose', '关闭'),
                   ('logRefresh', '刷新'),
                   ('logOpen', '打开文件'),
                   ('logClear', '清空')]:
        chk('绑定 #%s（%s）' % (i, why), i in t)
    # 关键：必须真的 addEventListener，不能只有 id 字符串
    chk('对打开按钮调用过 addEventListener',
        re.search(r"(btn|e\.btn)[^;]{0,80}addEventListener\('click'", t) is not None)
    chk('浮层显示用 display=flex', "display = 'flex'" in t or 'display="flex"' in t)

print()
print('=== 4. 引用的 __vhLog 方法确实存在（防写空）===')
el = open(os.path.join(D, 'js', 'errorlog.js'), encoding='utf-8', errors='replace').read()
i = el.rfind('window.__vhLog = {')
seg = el[i:]
for m in sorted(set(re.findall(r'__vhLog(?:\.| && __vhLog\.)(\w+)', open(p, encoding='utf-8', errors='replace').read()) if os.path.isfile(p) else [])):
    chk('__vhLog.%s 在 errorlog.js 中定义' % m, ('%s:' % m) in seg)

print()
if fails:
    print('失败 %d 项: %s' % (len(fails), ', '.join(fails)))
    sys.exit(1)
print('全部通过')
