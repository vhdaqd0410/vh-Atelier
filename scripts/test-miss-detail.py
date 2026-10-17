# -*- coding: utf-8 -*-
"""行为测试：进度板块「缺集详情」——已完成信息 + 分段分色

覆盖：
  A 静态：renderMiss 含「已完成 X/Y」「缺集区间」「两种配色」；排序有缺集优先
  B 渲染：用工作台真实项目数据跑 renderMiss，验证格子数 = 总集数、
          绿格数 = present、红格数 = missing、总览文案正确
          （工作台未运行 -> 自动跳过 B 段）

在插件目录下运行：python scripts/test-miss-detail.py
"""
import os, sys, re, json, subprocess, tempfile, urllib.request, urllib.parse
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
    D = os.path.abspath(sys.argv[1])
elif os.path.basename(_HERE).lower() == 'scripts':
    D = os.path.dirname(_HERE)
else:
    D = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'
assert os.path.isfile(os.path.join(D, 'js', 'progress.js')), '插件目录不对: ' + D

fails = []
def chk(name, cond, extra=''):
    if cond:
        print('  [OK]   ' + name)
    else:
        print('  [FAIL] ' + name + (' -> ' + extra if extra else ''))
        fails.append(name)

src = open(os.path.join(D, 'js', 'progress.js'), encoding='utf-8', errors='replace').read()

print('=== A. 静态检查 ===')
chk('存在 mkEpCell', 'function mkEpCell' in src)
chk('renderMiss 用 present', re.search(r'epData\.present', src) is not None)
chk('总览含「已完成」文案', "'已完成 ' + doneN" in src or '"已完成 " + doneN' in src or '已完成 ' in src)
chk('总览显示缺集数', "缺 ' + missing.length" in src)
chk('绿格配色（已有成片）', "'#7fd68b'" in src and 'rgba(127,214,139' in src)
chk('红格配色（缺集）', "'#ff8a8a'" in src and 'rgba(255,138,138' in src)
chk('组头显示 已完成 X/Y', "'已完成 ' + g.done.length + ' / ' + g.total" in src)
chk('组头显示缺集区间', "compactEpList(g.miss)" in src)
chk('排序：缺集多的在前', '缺集多的在前' in src or 'bm - am' in src)
chk('未分配排最后', "if (a === '未分配') return 1;" in src)
chk('集号 tooltip 含状态', re.search(r"c\.title = '第 ' \+ ep \+ ' 集 · ' \+ label", src) is not None)
chk('图例存在', '已有成片' in src and "'缺集', 'rgba(255,138,138,.42)'" in src)

# 抽取 renderMiss 代码块备用
i = src.find('// ===== 缺集（含已完成信息 + 分段分色）=====')
if i < 0:
    i = src.find('function mkEpCell')
j = src.find('// ===== 行构建 =====', i)
block = src[i:j] if j > i else ''
chk('可抽取 renderMiss 代码块', len(block) > 800, 'len=%d' % len(block))

print()
print('=== B. 真实数据渲染 ===')
WB = None
for c in [os.path.join(os.path.expanduser('~'), 'Desktop', '视频工作台'),
          os.path.join(os.path.expanduser('~'), '桌面', '视频工作台')]:
    if os.path.isdir(c):
        WB = c
        break
CHROME = [r'C:\Program Files\Google\Chrome\Application\chrome.exe',
          r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
          r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
          r'C:\Program Files\Microsoft\Edge\Application\msedge.exe']
browser = next((c for c in CHROME if os.path.exists(c)), None)

if not WB or not browser or len(block) < 800:
    print('  [跳过] 缺工作台目录 / 浏览器 / 代码块')
else:
    sec = ''
    cfg = os.path.join(WB, 'backend', 'config.yaml')
    if os.path.exists(cfg):
        m = re.search(r'api_secret\s*:\s*(\S+)', open(cfg, encoding='utf-8', errors='replace').read())
        if m:
            sec = m.group(1).strip().strip('"\'')
    def api(path, timeout=60):
        h = {'Content-Type': 'application/json'}
        if sec:
            h['X-API-Key'] = sec
        try:
            return json.loads(urllib.request.urlopen(
                urllib.request.Request('http://127.0.0.1:8089' + path, headers=h),
                timeout=timeout).read().decode('utf-8', 'replace'))
        except Exception:
            return {}
    # 用项目分类列表拿名字（轻量，不拉 /api/projects 全量）
    sample = None
    lst = api('/api/my/projects', timeout=25)
    names = []
    if isinstance(lst, dict):
        mine = lst.get('mine') or {}
        names = list(mine.keys())
    if not names:
        print('  [跳过] 拿不到项目名（工作台未运行或未设置剪辑师名）')
    else:
        for n in names[:6]:
            r = api('/api/project/' + urllib.parse.quote(n) + '/episodes_status')
            if r.get('ok') and (r.get('missing') or []):
                sample = r
                break
        if not sample:
            for n in names[:3]:
                r = api('/api/project/' + urllib.parse.quote(n) + '/episodes_status')
                if r.get('ok'):
                    sample = r
                    break
        if not sample:
            print('  [跳过] 取不到可用项目数据')
        else:
            total = int(sample.get('total') or 0)
            nPresent = len(sample.get('present') or [])
            nMissing = len(sample.get('missing') or [])
            # 注意：present 里可能含超出 total 的集号，格子以 present+missing 并集为准
            union = len(set(sample.get('present') or []) | set(sample.get('missing') or []))
            html = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
                    'body{background:#1e1e1e;color:#e8e8e8;--panel2:#2a2a2a;--border:#3a3a3a;'
                    '--text:#e8e8e8;--muted:#9a9a9a;--accent:#8b5cf6;}'
                    '#box{width:520px}</style></head><body><div id="box"></div>'
                    '<div id="log"></div><script>'
                    'var got={ep:' + json.dumps(sample, ensure_ascii=False) + '};'
                    'function compactEpList(n){if(!n||!n.length)return "";'
                    'var a=n.slice().sort(function(x,y){return x-y;}),p=[],s=a[0],v=a[0];'
                    'for(var k=1;k<a.length;k++){if(a[k]===v+1){v=a[k];}else{p.push(s===v?String(s):s+"-"+v);s=v=a[k];}}'
                    'p.push(s===v?String(s):s+"-"+v);return p.join(",");}'
                    + block +
                    'var c=document.getElementById("box");renderMiss(c);'
                    'setTimeout(function(){var all=c.querySelectorAll("[data-done]");'
                    'var d=c.querySelectorAll(\'[data-done="1"]\');'
                    'var m=c.querySelectorAll(\'[data-done="0"]\');'
                    'document.getElementById("log").textContent='
                    '"cells="+all.length+" done="+d.length+" miss="+m.length;},600);'
                    '</script></body></html>')
            tp = os.path.join(tempfile.gettempdir(), 'miss_gate.html')
            open(tp, 'w', encoding='utf-8').write(html)
            r = subprocess.run([browser, '--headless=new', '--disable-gpu', '--no-sandbox',
                                '--virtual-time-budget=8000', '--dump-dom',
                                'file:///' + tp.replace('\\', '/')],
                               capture_output=True, text=True, encoding='utf-8',
                               errors='replace', timeout=150)
            dom = r.stdout or ''
            mm = re.search(r'<div id="log">(.*?)</div>', dom, re.S)
            log = mm.group(1).strip() if mm else ''
            print('    项目=%s total=%d present=%d missing=%d 并集=%d'
                  % (str(sample.get('project_name'))[:24], total, nPresent, nMissing, union))
            print('    渲染: ' + log[:120])
            cells = done = miss = -1
            m1 = re.search(r'cells=(\d+)', log); cells = int(m1.group(1)) if m1 else -1
            m2 = re.search(r'done=(\d+)', log); done = int(m2.group(1)) if m2 else -1
            m3 = re.search(r'miss=(\d+)', log); miss = int(m3.group(1)) if m3 else -1
            chk('格子数 = present∪missing 并集', cells == union, 'cells=%d union=%d' % (cells, union))
            chk('绿格数 = present 数', done == nPresent, 'done=%d present=%d' % (done, nPresent))
            chk('红格数 = missing 数', miss == nMissing, 'miss=%d missing=%d' % (miss, nMissing))

print()
if fails:
    print('失败 %d 项：' % len(fails))
    for f in fails:
        print('   - ' + f)
    sys.exit(1)
print('全部通过')
