# -*- coding: utf-8 -*-
"""行为测试：语音克隆「参考音频波形 + 试听」

覆盖：
  A 组件：wave-mini.js 存在、导出 vhWave.mount、关键能力齐全
  A2 接入：index.html 有 vcRefWave 容器、脚本顺序正确
  A3 接线：clone.js 有 mountRefWave/clearRefWave、每处 refWavPath 赋值后都挂波形
  B 真实渲染：用真实 wav 在 Chrome 里跑，验证 canvas 真画出波形 + 时长显示

在插件目录下运行：python scripts/test-ref-wave.py
"""
import os, sys, re, subprocess, glob, base64, tempfile
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
    D = os.path.abspath(sys.argv[1])
elif os.path.basename(_HERE).lower() == 'scripts':
    D = os.path.dirname(_HERE)
else:
    D = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'
assert os.path.isfile(os.path.join(D, 'js', 'clone.js')), '插件目录不对: ' + D

fails = []
def chk(name, cond, extra=''):
    if cond:
        print('  [OK]   ' + name)
    else:
        print('  [FAIL] ' + name + (' -> ' + extra if extra else ''))
        fails.append(name)

print('=== A. wave-mini.js 组件 ===')
wp = os.path.join(D, 'js', 'wave-mini.js')
chk('wave-mini.js 存在', os.path.isfile(wp))
w = open(wp, encoding='utf-8', errors='replace').read() if os.path.isfile(wp) else ''
for label, k in [
    ('导出 window.vhWave.mount', 'window.vhWave = { mount: mount }'),
    ('mount 签名正确', 'function mount(host, filePath, opts)'),
    ('Web Audio 解码', 'decodeAudioData'),
    ('取声道算峰值', 'getChannelData'),
    ('canvas 绘制', 'clearRect'),
    ('播放按钮', "play.addEventListener('click'"),
    ('点波形定位', "canvas.addEventListener('click'"),
    ('返回 destroy', 'destroy: function ()'),
    ('PR 侧 XHR 读取', "xhr.responseType = 'arraybuffer'"),
    ('时长格式化', 'function fmtSec'),
]:
    chk(label, k in w)

print()
print('=== A2. index.html 接入 ===')
H = open(os.path.join(D, 'index.html'), encoding='utf-8', errors='replace').read()
chk('有 vcRefWave 容器', 'id="vcRefWave"' in H)
chk('引入了 wave-mini.js', 'js/wave-mini.js' in H)
i_w, i_c = H.find('js/wave-mini.js'), H.find('js/clone.js')
chk('脚本顺序：wave-mini 先于 clone', 0 < i_w < i_c, 'wave=%d clone=%d' % (i_w, i_c))
i_panel = H.find('id="panel-clone"')
i_wave_el = H.find('id="vcRefWave"')
i_next = H.find('<!-- 2 ')
chk('vcRefWave 在 panel-clone 内',
    i_panel > 0 and i_wave_el > i_panel and (i_next < 0 or i_wave_el < i_next),
    'panel=%d wave=%d' % (i_panel, i_wave_el))

print()
print('=== A3. clone.js 接线 ===')
C = open(os.path.join(D, 'js', 'clone.js'), encoding='utf-8', errors='replace').read()
chk('定义 mountRefWave', 'function mountRefWave' in C)
chk('定义 clearRefWave', 'function clearRefWave' in C)
chk('el 表注册 vcRefWave', "vcRefWave: document.getElementById('vcRefWave')" in C)
chk('暴露 __vhReadAudioBlob', 'window.__vhReadAudioBlob = vcReadAsBlob' in C)
chk('文件不存在时清波形', 'clearRefWave(); return;' in C)
chk('组件缺失时静默跳过', 'if (!window.vhWave) return;' in C)

lines = C.split('\n')
miss = []
for i, l in enumerate(lines):
    if re.search(r'refWavPath\s*=\s*\w', l) and 'var refWavPath' not in l:
        tail = '\n'.join(lines[i + 1:i + 4])
        if 'mountRefWave()' not in tail:
            miss.append((i + 1, l.strip()[:60]))
chk('每处 refWavPath 赋值后都挂波形', not miss, str(miss))
chk('挂载调用 >=4 处', C.count('mountRefWave();') >= 4, 'count=%d' % C.count('mountRefWave();'))

print()
print('=== B. 真实渲染（Chrome headless）===')
CHROME = [r'C:\Program Files\Google\Chrome\Application\chrome.exe',
          r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
          r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
          r'C:\Program Files\Microsoft\Edge\Application\msedge.exe']
browser = next((c for c in CHROME if os.path.exists(c)), None)
if not browser:
    print('  [跳过] 未找到 Chrome/Edge')
else:
    wavs = [p for p in glob.glob(os.path.join(tempfile.gettempdir(), 'vc_clone', '*.wav'))
            if os.path.getsize(p) > 5000]
    if not wavs:
        print('  [跳过] 没有可用的测试 wav')
    else:
        wav = sorted(wavs, key=os.path.getsize, reverse=True)[0]
        b64 = base64.b64encode(open(wav, 'rb').read()).decode()
        html = ('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
                '<div id="host" style="width:600px;"></div><div id="log"></div>'
                '<script>' + w + '</script><script>'
                'var L=[];function say(s){L.push(s);document.getElementById("log").textContent=L.join("\\n");}'
                'window.__vhReadAudioBlob=function(p,cb){try{var b=atob("' + b64 + '");'
                'var u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);'
                'cb(null,new Blob([u],{type:"audio/wav"}));}catch(e){cb(e,null);}};'
                'var host=document.getElementById("host");'
                'window.vhWave.mount(host,"C:\\\\fake\\\\a.wav",{height:48});'
                'var n=0;var iv=setInterval(function(){'
                '  n++;'
                '  var cv=host.querySelector("canvas");'
                '  var d=cv.getContext("2d").getImageData(0,0,cv.width,cv.height).data;var c=0;'
                '  for(var i=0;i<d.length;i+=4)if(d[i]>25||d[i+1]>25||d[i+2]>25)c++;'
                '  say("tick"+n+" painted="+c+" time="+(host.querySelector("span")||{}).textContent+ " play="+!!host.querySelector("button"));'
                '  if(n>=20)clearInterval(iv);'
                '},300);'
                '</script></body></html>')
        tp = os.path.join(tempfile.gettempdir(), 'wavetest_gate.html')
        open(tp, 'w', encoding='utf-8').write(html)
        r = subprocess.run([browser, '--headless=new', '--disable-gpu', '--no-sandbox',
                            '--virtual-time-budget=9000', '--dump-dom',
                            'file:///' + tp.replace('\\', '/')],
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=150)
        dom = r.stdout or ''
        m = re.search(r'<div id="log">(.*?)</div>', dom, re.S)
        log = m.group(1).strip() if m else ''
        # 轮询输出多行，取最终一次的值（解码完成后的稳定结果）
        paints = re.findall(r'painted=(\d+)', log)
        times = re.findall(r'time=([^\n]+)', log)
        painted = int(paints[-1]) if paints else -1
        finaltime = times[-1].strip() if times else ''
        print('    采样 %d 次，最终 painted=%d  time=%s' % (len(paints), painted, finaltime[:24]))
        chk('canvas 真画出波形（>500 像素）', painted > 500, 'painted=%d' % painted)
        chk('显示总时长（非 --:--）', ('--:--' not in finaltime), finaltime[:40])
        chk('有播放按钮', 'play=true' in log)

print()
if fails:
    print('失败 %d 项：' % len(fails))
    for f in fails:
        print('   - ' + f)
    sys.exit(1)
print('全部通过')
