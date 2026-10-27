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
print('=== A4. 首页卡片缺集摘要行（含已完成）===')
chk('定义 missSummaryHtml', 'function missSummaryHtml' in src)
chk('渲染时调用 missSummaryHtml', src.count('missSummaryHtml(') >= 3, 'count=%d' % src.count('missSummaryHtml('))
chk('卡片行含「已完成」文案', "' · 已完成 '" in src or "'已完成 '" in src)
chk('全完成文案以 ✅ 开头', "'✅ 已完成 '" in src)
chk('卡片行按状态切 is-done', "'prg-miss-row' + (_html" in src or "prg-miss-row' + (" in src)
# CSS 里要有配套的绿色样式
_css = open(os.path.join(D, 'css', 'atelier.css'), encoding='utf-8', errors='replace').read()
chk('CSS 有 .prg-miss-row.is-done 绿色样式', '.prg-miss-row.is-done' in _css)
chk('is-done 用成功绿而非警告黄', 'var(--fg-ok-soft)' in _css.split('.prg-miss-row.is-done')[1][:200] if '.prg-miss-row.is-done' in _css else False)

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
print('=== B2. 首页卡片缺集行渲染（真实数据）===')
if not WB or not browser or len(src) < 100:
    print('  [跳过] 缺工作台/浏览器')
else:
    def _grab_fn(s, name):
        i = s.find('function ' + name)
        if i < 0:
            return ''
        j = s.find('{', i)
        depth = 0; k = j; in_s = None; esc_on = False
        while k < len(s):
            c = s[k]
            if in_s:
                if esc_on: esc_on = False
                elif c == '\\': esc_on = True
                elif c == in_s: in_s = None
            else:
                if c in '\'"`': in_s = c
                elif c == '/' and k + 1 < len(s) and s[k + 1] == '/':
                    nl_ = s.find('\n', k)
                    if nl_ < 0: break
                    k = nl_; continue
                elif c == '{': depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0: return s[i:k + 1]
            k += 1
        return ''
    # esc 用固定后锚点，避免正则里的括号干扰
    _i = src.find('function esc(')
    _j = src.find('// 缺集摘要行文案（首页卡片用）', _i)
    f_esc = src[_i:_j].rstrip() if (_i >= 0 and _j > _i) else ''
    f_miss = _grab_fn(src, 'missSummaryHtml(')
    f_compact = _grab_fn(src, 'compactEpList(')
    if min(len(f_esc), len(f_miss), len(f_compact)) < 50:
        print('  [跳过] 函数抽取失败')
    else:
        # 取样：必须同时覆盖「有缺集」和「全完成」两种状态，否则测不到两条分支
        samples = []
        got_miss = got_done = False
        for n in names[:20]:
            r = api('/api/project/' + urllib.parse.quote(n) + '/episodes_status')
            if not r.get('ok'):
                continue
            has_miss = bool(r.get('missing'))
            if has_miss and not got_miss:
                samples.append(r); got_miss = True
            elif (not has_miss) and not got_done:
                samples.append(r); got_done = True
            if got_miss and got_done:
                break
        if not samples:
            print('  [跳过] 取不到项目数据')
        else:
            html2 = ('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
                     '<div id="o"></div><div id="log"></div><script>'
                     + f_esc + '\n' + f_compact + '\n' + f_miss +
                     '\nvar DATA=' + json.dumps(samples, ensure_ascii=False) + ';'
                     'var out=[];DATA.forEach(function(sc){'
                     'var h=missSummaryHtml(sc);'
                     'var cls=h.indexOf("\u2705")===0?"is-done":"warn";'
                     'out.push(cls+"||"+h);});'
                     'document.getElementById("log").textContent=out.join("\\n");'
                     '</script></body></html>')
            tp2 = os.path.join(tempfile.gettempdir(), 'card_gate.html')
            open(tp2, 'w', encoding='utf-8').write(html2)
            r2 = subprocess.run([browser, '--headless=new', '--disable-gpu', '--no-sandbox',
                                 '--virtual-time-budget=6000', '--dump-dom',
                                 'file:///' + tp2.replace('\\', '/')],
                                capture_output=True, text=True, encoding='utf-8',
                                errors='replace', timeout=150)
            m2 = re.search(r'<div id="log">(.*?)</div>', r2.stdout or '', re.S)
            log2 = m2.group(1).strip() if m2 else ''
            lines = [l for l in log2.split('\n') if l.strip()]
            print('    输出 %d 行:' % len(lines))
            for l in lines[:3]:
                print('      ' + l[:150])
            hasDone = any('已完成' in l for l in lines)
            chk('卡片行文案含「已完成」', hasDone, log2[:100])
            # 有缺集的样本：应是 warn 类且含「缺 N 集」
            if any((x.get('missing') or []) for x in samples):
                chk('有缺集样本显示「缺 N 集 · 已完成」',
                    any(('缺 ' in l and '已完成' in l) for l in lines), log2[:160])
                chk('有缺集样本不判为 is-done',
                    not any(l.startswith('is-done||') and '缺 ' in l for l in lines), log2[:160])
            # 全完成的样本：应判定 is-done
            if any(not (x.get('missing') or []) for x in samples):
                chk('全完成样本判定为 is-done',
                    any(l.startswith('is-done||') and '已完成' in l for l in lines), log2[:160])

print()
if fails:
    print('失败 %d 项：' % len(fails))
    for f in fails:
        print('   - ' + f)
    sys.exit(1)
print('全部通过')
