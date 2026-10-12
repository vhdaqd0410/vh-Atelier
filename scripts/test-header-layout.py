# -*- coding: utf-8 -*-
"""新增回归测试：顶部提示行不被吸顶栏遮挡（真实渲染测几何）

为什么必须真实渲染测：这个 bug 从代码上看"每个属性都正常"（字号、margin 都合规），
只有量出来才发现 .sub 的 top 落在顶栏盒内。纯静态检查抓不到。

在插件目录下运行：python scripts/test-header-layout.py
"""
import os, sys, re, json, subprocess, tempfile, shutil
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
    D = os.path.abspath(sys.argv[1])
elif os.path.basename(_HERE).lower() == 'scripts':
    D = os.path.dirname(_HERE)
else:
    D = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'
assert os.path.isfile(os.path.join(D, 'index.html')), '插件目录不对: ' + D

CHROME = [r'C:\Program Files\Google\Chrome\Application\chrome.exe',
          r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
          r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
          r'C:\Program Files\Microsoft\Edge\Application\msedge.exe']
chrome = next((c for c in CHROME if os.path.exists(c)), None)
if not chrome:
    print('未找到 Chrome/Edge，跳过真实渲染验证（退出码 0）')
    sys.exit(0)

H = open(os.path.join(D, 'index.html'), encoding='utf-8', errors='replace').read()
m = re.search(r'(<div class="top-head">.*?<div class="tabs ws-subtabs" data-group="progress">.*?</div>)', H, re.S)
if not m:
    print('[FAIL] 取不到顶部结构片段（index.html 结构可能变了）')
    sys.exit(1)
top = m.group(1)
css_url = 'file:///' + os.path.join(D, 'css', 'atelier.css').replace('\\', '/')

TPL = r'''<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="__CSS__">
<style>html,body{margin:0;padding:0;background:#1b1b1f;}
#stage{width:__W__px;height:420px;overflow:auto;position:relative;padding:14px;box-sizing:border-box;}</style>
</head><body><div id="stage">__TOP__</div>
<script>window.CSInterface=function(){this.getSystemPath=function(){return '';};this.evalScript=function(){};};</script>
<script>
window.addEventListener('load',function(){ setTimeout(function(){
  var stage=document.getElementById('stage');
  function box(sel){var e=document.querySelector(sel);if(!e)return null;
    var b=e.getBoundingClientRect(), s=stage.getBoundingClientRect(), cs=getComputedStyle(e);
    return {top:Math.round(b.top-s.top),bottom:Math.round(b.bottom-s.top),h:Math.round(b.height),
            fontSize:cs.fontSize,overflow:cs.overflow,position:cs.position,zIndex:cs.zIndex,
            text:(e.textContent||'').trim().slice(0,30)};}
  var out={w:__W__, head:box('.top-head'), sub:box('.sub'), groups:box('.ws-groups'),
           errs:(document.querySelectorAll('*').length)};
  var pre=document.createElement('pre'); pre.id='__probe';
  pre.textContent=JSON.stringify(out); document.body.appendChild(pre);
},500);});
</script></body></html>'''

fails = []
tmp = tempfile.mkdtemp(prefix='vh_hdr_')
try:
    print('=== 顶部提示行遮挡回归（真实渲染）===')
    for W in (420, 700, 1000):
        html = TPL.replace('__CSS__', css_url).replace('__TOP__', top).replace('__W__', str(W))
        f = os.path.join(tmp, 't%d.html' % W)
        open(f, 'w', encoding='utf-8').write(html)
        url = 'file:///' + f.replace('\\', '/')
        r = subprocess.run([chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
                            '--virtual-time-budget=4000', '--dump-dom', url],
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=120)
        mm = re.search(r'<pre id="__probe">([\s\S]*?)</pre>', r.stdout or '')
        if not mm:
            print('  [FAIL] 宽度 %d：取不到测量结果' % W)
            fails.append('w%d 无输出' % W)
            continue
        d = json.loads(mm.group(1))
        head, sub = d['head'], d['sub']
        gap = sub['top'] - head['bottom']
        # 核心断言：提示行必须完全落在顶栏盒之下（留 >=1px 间隔）
        if gap >= 1:
            print('  [OK]   宽度 %-5d 提示行顶=%3d 顶栏底=%3d 间隔=%2dpx'
                  % (W, sub['top'], head['bottom'], gap))
        else:
            print('  [FAIL] 宽度 %-5d 提示行被顶栏压住：顶=%3d 顶栏底=%3d（重叠 %dpx）'
                  % (W, sub['top'], head['bottom'], -gap))
            fails.append('w%d 重叠%dpx' % (W, -gap))
        # 提示行自身要有足够高度容纳一行字（约 >=13px）
        if sub['h'] < 13:
            print('  [FAIL] 宽度 %-5d 提示行高度仅 %dpx（字形会被 overflow 切掉）' % (W, sub['h']))
            fails.append('w%d 高度%d' % (W, sub['h']))
        # 提示行要能压过顶栏背景
        if sub['position'] != 'relative' and sub['position'] != 'absolute':
            print('  [FAIL] 宽度 %-5d .sub 非定位元素（无法保证盖过顶栏背景）' % W)
            fails.append('w%d 未定位' % W)
        # 三层栏顺序正确
        if not (head['bottom'] <= d['groups']['top']):
            print('  [FAIL] 宽度 %-5d 顶栏与工作台栏顺序异常' % W)
            fails.append('w%d 顺序' % W)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
if fails:
    print('通过 %d / 失败 %d -> %s' % (3 * 4 - len(fails), len(fails), ', '.join(fails)))
    sys.exit(1)
print('全部通过（提示行在三种宽度下都未被吸顶栏遮挡）')
