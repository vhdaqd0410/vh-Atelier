# -*- coding: utf-8 -*-
"""校验改动：HTML 结构 + id 完整性 + CSS 类是否都有定义"""
import io, sys, re, os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ROOT = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'
html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8', errors='replace').read()
css = open(os.path.join(ROOT, 'css', 'atelier.css'), encoding='utf-8', errors='replace').read()
js = open(os.path.join(ROOT, 'js', 'flatten-ui.js'), encoding='utf-8', errors='replace').read()

print('=== 1. div 配平 ===')
o, c = len(re.findall(r'<div\b', html)), len(re.findall(r'</div>', html))
print('  开=%d 闭=%d  %s' % (o, c, 'OK' if o == c else 'BAD'))

print()
print('=== 2. 面板必需 id ===')
need = ['panel-colorxml', 'cxRefreshSeq', 'cxReadSeq', 'cxGo', 'cxLog', 'cxLogStat',
        'cxTracksWrap', 'cxSummaryRow', 'cxOutName', 'cxOutDir', 'cxDropTrans',
        'cxAll', 'cxNone', 'cxOpenOut', 'cxClearLog', 'cxTracks', 'cxSummary', 'cxStatus']
miss = [i for i in need if ('id="%s"' % i) not in html]
print('  缺失: %s' % (miss if miss else '无 ✓'))

print()
print('=== 3. JS 里引用的 id 是否都在 HTML ===')
js_ids = set(re.findall(r"getElementById\('([^']+)'\)", js))
miss2 = [i for i in js_ids if ('id="%s"' % i) not in html]
print('  JS 引用 %d 个，缺失: %s' % (len(js_ids), miss2 if miss2 else '无 ✓'))

print()
print('=== 4. CSS 类是否都有定义 ===')
cls = set(re.findall(r'class="(cx-[\w -]+)"', html))
flat = set()
for c2 in cls:
    for x in c2.split():
        if x.startswith('cx-'):
            flat.add(x)
# JS 里动态加的行类
flat |= {'cx-ln', 'cx-ln-info', 'cx-ln-dim', 'cx-ln-ok', 'cx-ln-warn',
         'cx-ln-err', 'cx-ln-step', 'cx-ln-sep', 'cx-ln-time'}
undef = sorted(x for x in flat if ('.' + x) not in css)
print('  用到 %d 个类，未定义: %s' % (len(flat), undef if undef else '无 ✓'))

print()
print('=== 5. 导航组顺序 ===')
i = html.find('<div class="ws-groups">')
seg = html[i:i + 1300]
groups = re.findall(r'data-group="([\w-]+)"', seg)
print('  ' + ' → '.join(groups[:6]))

print()
print('=== 6. 工具子 tab ===')
m = re.search(r'data-group="prconv"[^>]*>(.*?)</div>', html, re.S)
if m:
    tabs = re.findall(r'data-tab="([\w-]+)"', m.group(1))
    print('  ' + ' / '.join(tabs))

print()
print('=== 7. 日志分级类在 CSS 中的颜色 ===')
for k in ('info', 'dim', 'ok', 'warn', 'err', 'step', 'sep'):
    m = re.search(r'\.cx-ln-%s\{([^}]*)\}' % k, css)
    print('  %-5s %s' % (k, m.group(1) if m else '(未定义)'))
