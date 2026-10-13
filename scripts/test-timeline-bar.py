# -*- coding: utf-8 -*-
"""行为测试：时间线工具条（8 个功能）

覆盖：
  A 静态：host 侧 tl* 函数齐全；script.js 调用的每个 host 函数都真实存在（防遗漏）
  B 前端渲染：工具条 9 个按钮 + 工作区下拉 + 状态行；点击各按钮发出的 evalScript 正确
  C 几何：多种面板宽度下按钮不重叠

在插件目录下运行：python scripts/test-timeline-bar.py
"""
import os, sys, re, json, subprocess, tempfile, shutil, atexit
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
    D = os.path.abspath(sys.argv[1])
elif os.path.basename(_HERE).lower() == 'scripts':
    D = os.path.dirname(_HERE)
else:
    D = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'
assert os.path.isfile(os.path.join(D, 'js', 'timeline-bar.js')), '插件目录不对: ' + D

fails = []
def chk(name, cond, extra=''):
    if cond:
        print('  [OK]   ' + name)
    else:
        print('  [FAIL] ' + name + (' -> ' + extra if extra else ''))
        fails.append(name)

print('=== A. host 侧函数齐全 ===')
host = open(os.path.join(D, 'jsx', 'host.jsx'), encoding='utf-8', errors='replace').read()
NEED = ['tlWorkspaces', 'tlSetWorkspace', 'tlDeleteKeyframes', 'tlDeleteEffects',
        'tlUnnest', 'tlSwapClips', 'tlSetIn', 'tlSetOut', 'tlInOutFromSelection',
        'tlClearInOut', 'tlStatus', 'tlTime', 'tlLocate', 'tlSelClips', 'tlSeq']
for n in NEED:
    chk('host.jsx 有 %s()' % n, ('function %s(' % n) in host)

print()
print('=== A2. 前端调用的 host 函数必须都存在（防遗漏）===')
js = open(os.path.join(D, 'js', 'timeline-bar.js'), encoding='utf-8', errors='replace').read()
called = sorted(set(re.findall(r"call\('(\w+)\(", js)))
for c in called:
    chk('调用 %s 在 host 有定义' % c, ('function %s(' % c) in host)
chk('前端没有中文函数名残留', not re.search(r'function\s*[\u4e00-\u9fff]\w*\s*\(', js),
    str([x.group(0) for x in re.finditer(r'function\s*[\u4e00-\u9fff]\w*\s*\(', js)][:3]))

print()
print('=== A2b. QE 关键 API 用法（据 timeline-tools 路线）===')
for k, why in [('tlQE', 'QE 开启封装'),
               ('removeKeyRange', '删关键帧一次清空'),
               ('setTimeVarying', '关秒表开关'),
               ('getComponentAt', 'QE 删效果取组件'),
               ('numComponents', 'QE 组件数'),
               ('parentTrackIndex', 'QE 按轨道号定位')]:
    chk('host 用到 %s（%s）' % (k, why), k in host)
chk('删效果的组件删除调用 remove()', re.search(r'comp\.remove\(\)', host) is not None)
chk('删关键帧带强制刷新 setValue(..., 1)', re.search(r'setValue\([^)]*,\s*1\)', host) is not None)
# tl 段内不允许「无 if 保护的直调 seq.clearInPoint()」——官方 Sequence 没这个方法。
# （插件别处已有的 `if (seq.clearInPoint) seq.clearInPoint()` 属存在性判断，安全，不计）
tl_seg = host[host.find('// ==================== 时间线工具条（QE 版）'):]
chk('tl 段内无裸调 seq.clearInPoint()',
    not re.search(r'(?<!if \()\bseq\.clearInPoint\(\)', tl_seg))

print()
print('=== A3. index.html 接线 ===')
html = open(os.path.join(D, 'index.html'), encoding='utf-8', errors='replace').read()
chk('index.html 有 tlBar 容器', 'id="tlBar"' in html)
chk('index.html 引入 timeline-bar.js', 'timeline-bar.js' in html)

print()
print('=== B. 前端渲染 + 点击行为 ===')
CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
          r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
          r'C:\Program Files\Microsoft\Edge\Application\msedge.exe']
chrome = next((c for c in CHROME if os.path.exists(c)), None)
if not chrome:
    print('  （未找到 Chrome/Edge，跳过 B/C）')
else:
    css = open(os.path.join(D, 'css', 'atelier.css'), encoding='utf-8', errors='replace').read()
    TPL = """<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#1b1b1f;}
#stage{width:__W__px;padding:12px;box-sizing:border-box;}
__CSS__
</style></head><body>
<div id="stage"><div id="tlBar"></div></div>
<script>
window.__calls=[];
function CSInterface(){this.evalScript=function(code,cb){
  window.__calls.push(code);
  if(code.indexOf('tlWorkspaces')>=0){cb('OK:'+JSON.stringify({list:['All Panels','Assembly','Audio','Color','Editing']}));return;}
  if(code.indexOf('tlStatus')>=0){cb('OK:'+JSON.stringify({seq:'EP1',selCount:2,inSec:1.5,outSec:12.25}));return;}
  if(cb)cb('OK:{}');};}
</script>
<script>__JS__</script>
<script>
window.addEventListener('load',function(){setTimeout(function(){
  var out={btns:[],wsOpts:0,status:'',calls:[],boxes:[],overlaps:[],rows:0};
  var bar=document.querySelector('.tl-bar');
  if(bar){
    bar.querySelectorAll('.tl-btn').forEach(function(b){out.btns.push(b.textContent);});
    // 依次点每个按钮，记录发出的脚本
    bar.querySelectorAll('.tl-btn').forEach(function(b){ b.click(); });
    var s=document.getElementById('tlWsSel');
    if(s){ out.wsOpts=s.options.length; s.value='Editing';
      s.dispatchEvent(new Event('change')); }
    var st=document.getElementById('tlStatusText');
    if(st) out.status=st.textContent;
    // 几何
    var items=[]; if(s) items.push(s);
    bar.querySelectorAll('.tl-btn').forEach(function(b){items.push(b);});
    var tops={};
    items.forEach(function(b){var r=b.getBoundingClientRect();
      out.boxes.push({t:Math.round(r.top),l:Math.round(r.left),rt:Math.round(r.right),txt:(b.textContent||'').slice(0,8)});
      tops[Math.round(r.top)]=1;});
    out.rows=Object.keys(tops).length;
    for(var i=0;i<out.boxes.length;i++)for(var j=i+1;j<out.boxes.length;j++){
      var A=out.boxes[i],B=out.boxes[j];
      if(Math.abs(A.t-B.t)<3 && A.rt>B.l+1 && B.rt>A.l+1) out.overlaps.push([A.txt,B.txt]);
    }
  }
  out.calls=window.__calls.slice();
  var pre=document.createElement('pre');pre.id='__p';pre.textContent=JSON.stringify(out);document.body.appendChild(pre);
},500);});
</script></body></html>"""
    tmp = tempfile.mkdtemp(prefix='vh_tlbar_')
    try:
        data = None
        for W in (300, 420, 700, 1100):
            htmlx = TPL.replace('__W__', str(W)).replace('__CSS__', css).replace('__JS__', js)
            f = os.path.join(tmp, 't%d.html' % W)
            open(f, 'w', encoding='utf-8').write(htmlx)
            r = subprocess.run([chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
                                '--virtual-time-budget=4000', '--dump-dom',
                                'file:///' + f.replace('\\', '/')],
                               capture_output=True, text=True, encoding='utf-8',
                               errors='replace', timeout=150)
            m = re.search(r'<pre id="__p">([\s\S]*?)</pre>', r.stdout or '')
            if not m:
                chk('宽度 %d 渲染出探针' % W, False, '无输出'); continue
            d = json.loads(m.group(1))
            if data is None:
                data = d
                chk('工具条有 8 个按钮', len(d['btns']) == 8, str(len(d['btns'])))
                for want in ['删全部关键帧', '删全部效果', '解除嵌套',
                             '位置互换', '入点', '出点', '片段→I/O', '清 I/O']:
                    chk('有按钮「%s」' % want, want in d['btns'])
                chk('已去掉「删当前关键帧」', '删当前关键帧' not in d['btns'])
                chk('工作区下拉已填充', d['wsOpts'] >= 5, str(d['wsOpts']))
                chk('状态行显示序列/选中/I-O', ('EP1' in d['status']) and ('选中 2' in d['status'])
                    and ('1.50' in d['status']), d['status'][:60])
                # 点击发出的脚本
                joined = ' | '.join(d['calls'])
                for fn, label in [('tlDeleteKeyframes()', '删全部关键帧'),
                                  ('tlDeleteEffects()', '删全部效果'),
                                  ('tlUnnest()', '解除嵌套'),
                                  ('tlSwapClips()', '位置互换'),
                                  ('tlSetIn()', '入点'),
                                  ('tlSetOut()', '出点'),
                                  ('tlInOutFromSelection()', '片段→I/O'),
                                  ('tlClearInOut()', '清 I/O')]:
                    chk('点「%s」发出 %s' % (label, fn), fn in joined, joined[:150])
                chk('切换工作区发出 tlSetWorkspace',
                    'tlSetWorkspace(' in joined and 'Editing' in joined, joined[:150])
            chk('宽度 %d 按钮无重叠' % W, len(d['overlaps']) == 0, json.dumps(d['overlaps']))
            chk('宽度 %d 换行合理（≥1 行）' % W, d['rows'] >= 1, str(d['rows']))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

print()
if fails:
    print('失败 %d 项: %s' % (len(fails), ', '.join(fails)))
    sys.exit(1)
print('全部通过')
