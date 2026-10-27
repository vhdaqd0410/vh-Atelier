# -*- coding: utf-8 -*-
"""歌词浮层与播放器布局的真实渲染验证。

用系统 Chrome 无头渲染插件面板（真实 HTML + 真实 CSS + 真实 JS），
在三种面板宽度下测量几何，判定：
  - 浮层是否铺满面板宽度、是否精确停在播放器上方（不遮控件）
  - 窄面板下歌词区是否有足够宽度（左右分栏会把歌词挤到 100 余像素）
  - 播放栏歌词是否独占整行

背景：之前用固定留白猜播放器位置、用百分比 padding 做歌词留白，
两者都算错了，肉眼看就是「错位 + 歌词挤成一列」。静态断言查不出来，
必须真实渲染测量。若本机没有 Chrome，会跳过（退出码 0）。
"""
import os, re, sys, json, subprocess, tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
chrome = next((c for c in CHROME_CANDIDATES if os.path.exists(c)), None)
if not chrome:
    print('未找到 Chrome/Edge，跳过真实渲染验证')
    sys.exit(0)

pass_n = 0
fail_n = 0
def ok(name, cond, extra=None):
    global pass_n, fail_n
    if cond:
        pass_n += 1; print('  [OK]   ' + name)
    else:
        fail_n += 1; print('  [FAIL] ' + name + ((' -> ' + str(extra)) if extra is not None else ''))

# ---- 1) 提取面板 HTML + 组装测试页 ----
ih = open(os.path.join(D, 'index.html'), encoding='utf-8', errors='replace').read()
i = ih.find('id="panel-musicagg"'); i = ih.rfind('<div', 0, i)
depth = 0; j = i
while j < len(ih):
    m = re.compile(r'<div\b|</div>').search(ih, j)
    if not m: break
    if m.group(0) == '</div>':
        depth -= 1
        if depth == 0: j = m.end(); break
    else: depth += 1
    j = m.end()
panel = ih[i:j]

css_url = os.path.join(D, 'css', 'atelier.css').replace('\\', '/')
mod_url = os.path.join(D, 'js', 'musicagg-native.js').replace('\\', '/')

TEMPLATE = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="file:///__CSS__">
<style>
html,body{margin:0;padding:0;background:#1b1b1f;}
#stage{width:__W__px;height:900px;position:relative;overflow:hidden;background:#1b1b1f;}
#panel-musicagg{display:block !important;}
#maNative{display:flex !important;}
#mv2Player{display:flex !important;}
#mv2List{display:flex !important;}
.ma-frame{display:none !important;}
.ma-hint{display:none !important;}
</style></head><body>
<div id="stage">__PANEL__</div>
<script>
window.__errs=[];
window.addEventListener('error',function(e){window.__errs.push(String(e.message||e));});
// CEP 有 node 集成，浏览器没有：补垫片，否则模块开头 require 失败会直接 return
(function(){
  function stub(o){return new Proxy(o||{},{get:function(tg,k){if(k in tg)return tg[k];
    return function(){return {on:function(){},stdout:{on:function(){}},stderr:{on:function(){}}};};}});}
  window.require=function(m){
    if(m==='fs')return stub({existsSync:function(){return false;},readdirSync:function(){return [];},
      readFileSync:function(){return '{}';},statSync:function(){return {isDirectory:function(){return false;}};}});
    if(m==='path')return {join:function(){return '';},dirname:function(){return '';},basename:function(){return '';},sep:'/'};
    if(m==='child_process')return stub({spawnSync:function(){return {status:1,stdout:''};},
      spawn:function(){return {on:function(){},stdout:{on:function(){}},stderr:{on:function(){}}};}});
    if(m==='os')return {tmpdir:function(){return '/tmp';}};
    if(m==='http'||m==='https')return {get:function(){return {on:function(){},setTimeout:function(){},abort:function(){}};}};
    if(m==='url')return {parse:function(){return {protocol:'http:'};}};
    return stub({});
  };
})();
window.__musicAgg={base:function(){return 'http://127.0.0.1:17899';},
  api:function(){return Promise.resolve({list:[]});}};
window.CSInterface=function(){this.getSystemPath=function(){return '';};this.evalScript=function(){};};
</script>
<script>
window.addEventListener('load', function(){
  var s=document.createElement('script');
  s.src='file:///__MOD__';
  s.onload=function(){ window.__modLoaded=true; };
  document.body.appendChild(s);
  setTimeout(runChecks, 900);
});
function runChecks(){
  var body=document.getElementById('mv2LyricBody');
  if(body){ body.innerHTML='';
    for(var i=1;i<=16;i++){ var d=document.createElement('div');
      d.className='mv2-lyric-line'+(i===8?' on':''); d.textContent='第 '+i+' 句歌词内容示例文字';
      body.appendChild(d); } }
  var t1=document.getElementById('mv2BigTitle'); if(t1)t1.textContent='测试歌曲名';
  var t2=document.getElementById('mv2BigSub'); if(t2)t2.textContent='测试歌手 · 专辑';
  var t3=document.getElementById('mv2PlayerTitle'); if(t3)t3.textContent='测试歌曲名';
  var t4=document.getElementById('mv2Sub'); if(t4)t4.textContent='测试歌手';
  var bt=document.getElementById('btnMv2Lyric'); if(bt) bt.click();
  setTimeout(function(){
    var bl=document.getElementById('mv2BarLyric');
    if(bl){ bl.textContent='第 8 句歌词内容示例文字'; bl.classList.add('show'); }
    setTimeout(function(){
      var st=document.getElementById('stage').getBoundingClientRect();
      function box(sel){var e=document.querySelector(sel); if(!e)return null;
        var b=e.getBoundingClientRect();
        return {top:Math.round(b.top-st.top),bottom:Math.round(b.bottom-st.top),
                left:Math.round(b.left-st.left),right:Math.round(b.right-st.left),
                h:Math.round(b.height),w:Math.round(b.width)};}
      var out={stage:{w:__W__,h:900},modLoaded:!!window.__modLoaded,errs:(window.__errs||[]).slice(0,3),
        float:box('#mv2LyricFloat'),card:box('#mv2LyricFloat .mv2-lyric-card'),
        lyricArea:box('#mv2LyricBody'),line:box('#mv2LyricBody .mv2-lyric-line'),
        leftCol:box('#mv2LyricFloat .mv2-lyric-left'),
        player:box('#mv2Player'),barLyric:box('#mv2BarLyric'),meta:box('#mv2Player .mp-meta')};
      var pre=document.createElement('pre'); pre.id='__probe';
      pre.textContent=JSON.stringify(out,null,1); document.body.appendChild(pre);
    },350);
  },350);
}
</script></body></html>
"""

tmp = tempfile.mkdtemp(prefix='vh_layout_')
try:
    print('=== 真实渲染验证（三种面板宽度）===')
    for W in (440, 700, 1000):
        html = (TEMPLATE.replace('__CSS__', css_url).replace('__MOD__', mod_url)
                        .replace('__PANEL__', panel).replace('__W__', str(W)))
        page = os.path.join(tmp, 'v%d.html' % W)
        open(page, 'w', encoding='utf-8').write(html)

        r = subprocess.run([chrome, '--headless=new', '--disable-gpu', '--dump-dom',
                            '--window-size=%d,940' % (W + 20), '--virtual-time-budget=6000',
                            'file:///' + page.replace('\\', '/')],
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
        dom = r.stdout or ''
        k = dom.find('id="__probe"')
        if k < 0:
            ok('宽度 %d：渲染出测量数据' % W, False, 'no probe')
            continue
        q = dom.find('</pre>', k); seg = dom[k:q]; seg = seg[seg.find('>')+1:]
        d = json.loads(seg)
        fl, pl, card, area, line1 = (d['float'], d['player'], d['card'],
                                     d['lyricArea'], d['line'])

        ok('宽度 %d：模块已加载' % W, d.get('modLoaded'), d.get('errs'))
        ok('宽度 %d：浮层铺满面板宽度' % W, fl and fl['w'] == W, fl)
        ok('宽度 %d：浮层精确停在播放器上方' % W,
           fl and pl and fl['bottom'] <= pl['top'] + 1,
           'float.bottom=%s player.top=%s' % (fl and fl['bottom'], pl and pl['top']))
        ok('宽度 %d：播放器完整可见' % W, pl and pl['bottom'] <= 900, pl)
        bl, mt = d.get('barLyric'), d.get('meta')
        ok('宽度 %d：歌词在歌名右侧' % W,
           bl and mt and bl['top'] <= mt['bottom'] + 4 and bl['left'] >= mt['left'] + mt['w'] - 6,
           (mt, bl))
        ok('宽度 %d：歌词有足够宽度（>150px）' % W, bl and bl['w'] > 150, bl)
        # 窄面板专项：歌词区必须够宽（左右分栏会只剩 100 余像素）
        if W <= 620:
            ok('宽度 %d：窄面板歌词区够宽（>280px）' % W, area and area['w'] > 280, area)
            ok('宽度 %d：歌词单行不折行（>260px）' % W, line1 and line1['w'] > 260, line1)
            ok('宽度 %d：窄面板左栏收到顶部（高 <90px）' % W,
               d['leftCol'] and d['leftCol']['h'] < 90, d['leftCol'])
        else:
            ok('宽度 %d：宽面板保留左右分栏' % W,
               d['leftCol'] and d['leftCol']['h'] > 150, d['leftCol'])

    print()
    print('通过 %d / 失败 %d' % (pass_n, fail_n))
finally:
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)

sys.exit(0 if fail_n == 0 else 1)
