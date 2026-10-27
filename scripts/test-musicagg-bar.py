# -*- coding: utf-8 -*-
"""歌词浮窗尺寸（露出播放控件）+ 播放栏歌词换句动画与配色

在插件目录下运行：
    python scripts/test-musicagg-bar.py
"""
import os, sys, subprocess, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(D, '_tmp', 'test-bar')
os.makedirs(OUT, exist_ok=True)

import atexit as _atexit, shutil as _shutil
def _cleanup_tmp():
    try:
        _p = os.path.join(D, '_tmp')
        if os.path.exists(_p):
            _shutil.rmtree(_p, ignore_errors=True)
    except Exception:
        pass
_atexit.register(_cleanup_tmp)


# ---- 1) CSS 静态断言 ----
j = open(os.path.join(D, 'js', 'musicagg-native.js'), encoding='utf-8', errors='replace').read()

c = open(os.path.join(D, r'css\atelier.css'), encoding='utf-8', errors='replace').read()
pass1 = fail1 = 0
def ok(n, cond, e=None):
    global pass1, fail1
    if cond: pass1 += 1; print('  [OK]   ' + n)
    else: fail1 += 1; print('  [FAIL] ' + n + ((' -> ' + str(e)) if e is not None else ''))

print('=== 1. 浮层定位：由 JS 实测几何驱动 ===')
# 固定留白会与播放器实际位置错开（播放器跟着内容流排版、高度随歌词行变化），
# 故改为每次打开时读实际几何，并用 ResizeObserver 跟随播放器尺寸变化。
ok('有 layoutLyricFloat', 'function layoutLyricFloat' in j)
ok('读面板矩形', "getElementById('panel-musicagg')" in j and 'getBoundingClientRect' in j)
ok('让出播放器高度', 'r.bottom - pr.top' in j)
ok('按渲染高度判定播放器可见', 'getComputedStyle(player).display' in j)
ok('不用行内 style.display 判定', "player.style.display !== 'none'" not in j)
ok('跟随播放器尺寸变化', 'ResizeObserver' in j and 'watchPlayerResize' in j)
ok('歌词区留白按高度设 px', 'lyr.style.paddingTop' in j and 'lyr.style.paddingBottom' in j)
ok('CSS 不再用百分比留白', 'padding: 45%' not in c)
ok('窄面板改上下布局', '.mv2-lyric-float.narrow .mv2-lyric-card' in c)
ok('按宽度决定窄布局', 'needNarrow' in j)
ok('播放器可分行为', 'flex-wrap: wrap' in c)
ok('歌词在歌名右侧（吃剩余宽度）',
   '.mv2-player-box .mp-lyric' in c and 'flex: 1 1 auto' in c and
   '.mv2-player-box .mp-meta' in c and 'max-width: 40%' in c)

print()
print('=== 1b. 音量准确性 + 静音 + 波形多风格 ===')
ok('音量不用 || 兜底（0 被误当 0.8）', "parseFloat(vol.value) || 0.8" not in j)
ok('音量初始化写进播放器', 'function applyVol' in j and 'applyVol(savedVol(), false)' in j)
ok('音量记忆', 'vh_musicagg_vol' in j)
ok('滑块填充跟随数值', "setProperty('--vol'" in j and 'background-size: var(--vol' in c)
ok('静音按钮存在', 'btnMv2Mute' in j)
ok('静音可切换', 'a.muted = true' in j and 'a.muted = false' in j)
ok('拖动取消静音', 'if (a.muted) a.muted = false' in j)
ok('波形多风格', 'styles = [' in j and 'styleIdx' in j)
ok('波形自动循环', 'STYLE_MS' in j)
ok('波形可点击切换', 'vh_musicagg_wavestyle' in j)
ok('歌词渐变流动', 'mpLyricFlow' in c)
ok('歌词高光掠过', 'mpLyricSheen' in c)
ok('歌词竖条呼吸', 'mpLyricPulse' in c)

print('=== 2. 播放栏歌词动画与颜色 ===')
ok('有渐变色文字', 'background-clip: text' in c and 'linear-gradient(90deg, #c4b5fd' in c)
ok('有换句动画 keyframes', '@keyframes mpLyricSwap' in c)
ok('有呼吸竖条', 'mpLyricPulse' in c)
ok('有过渡（淡入上移）', 'transition: opacity .28s ease, transform .28s ease' in c)
ok('有 show 态', '.mp-lyric.show' in c)

# ---- 2) JS 行为：换句才播动画 ----
JS = r'''
const fs=require('fs'), path=require('path'), vm=require('vm');
const ROOT=process.argv[2];
let pass=0, fail=0;
function ok(n,c,e){ if(c){pass++;console.log('  [OK]   '+n);} else {fail++;console.log('  [FAIL] '+n+(e!==undefined?' -> '+e:''));} }
function makeEl(tag){
  const el={tagName:(tag||'div').toUpperCase(),children:[],_cls:'',_text:'',_html:'',style:{},dataset:{},
    value:'',title:'',_h:{},attrs:{},offsetTop:0,clientHeight:40,offsetHeight:40,scrollTop:0,offsetWidth:100,
    get open(){return true;},set open(v){},
    get className(){return this._cls;},set className(v){this._cls=String(v);},
    get textContent(){return this._text;},set textContent(v){this._text=String(v==null?'':v);},
    get innerHTML(){return this._html;},set innerHTML(v){this._html=String(v==null?'':v);this.children=[];},
    addEventListener(t,fn){(this._h[t]=this._h[t]||[]).push(fn);},
    removeEventListener(){},
    appendChild(c){c.parentNode=this;c.offsetTop=this.children.length*40;this.children.push(c);return c;},
    removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);return c;},
    insertBefore(c){c.parentNode=this;this.children.push(c);return c;},
    querySelector(sel){const cs=String(sel).replace(/^\./,'').split('.')[0];
      for(const c of this.children){ if(c._cls&&c._cls.split(/\s+/).indexOf(cs)>=0)return c;
        if(c.querySelector){const r=c.querySelector(sel);if(r)return r;} } return null;},
    querySelectorAll(){return [];},
    setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k]===undefined?null:this.attrs[k];},
    removeAttribute(){},
    click(){(this._h.click||[]).forEach(f=>f({type:'click',target:this,preventDefault(){},stopPropagation(){}}));},
    focus(){},remove(){},pause(){},play(){return Promise.resolve();},src:'',currentTime:0,duration:200};
  const cls={_all:{},add(s){(s||'').split(/\s+/).forEach(x=>{if(x)this._all[x]=true;});},
    remove(){const args=Array.prototype.slice.call(arguments);if(!args.length){this._all={};return;}args.forEach(a=>String(a).split(/\s+/).forEach(x=>{if(x)delete this._all[x];}));},
    toggle(s,on){ if(on===undefined) on=!this._all[s]; if(on) this._all[s]=true; else delete this._all[s]; },
    contains(s){return !!this._all[s];}};
  el.classList=cls;
  // 记录动画重启动画：offsetWidth 读取
  let _w=100; Object.defineProperty(el,'offsetWidth',{get(){el.__forced=1;return _w;}});
  return el;
}
function deepFind(el,pred,out){(out=out||[]);(el.children||[]).forEach(c=>{if(pred(c))out.push(c);deepFind(c,pred,out);});return out;}
const els={};
const getEl=(id)=>(els[id]=els[id]||makeEl(id==='mv2Audio'?'audio':'div'));
['wy','tx','kw','kg','mg',''].forEach(p=>{const b=makeEl('button');b.className='mv2-pf';b.dataset={pf:p};getEl('mv2Platforms').appendChild(b);});
getEl('mv2Type').value='song';
getEl('mv2Sheet').style.display='none';
const documentStub={readyState:'complete',getElementById:getEl,createElement:(t)=>makeEl(t),addEventListener(){},
  body:makeEl('body'),documentElement:makeEl('html'),querySelector:()=>null,
  querySelectorAll:(sel)=>{ if(String(sel).indexOf('mv2-pf')>=0) return getEl('mv2Platforms').children.filter(c=>(c._cls||'').indexOf('mv2-pf')>=0); return []; }};
const store={};
const SONGS=[{name:'歌',singer:'唱',songmid:11,source:'wy',interval:'03:00'}];
const sandbox={console,setTimeout,clearTimeout,Promise,require,module:{exports:{}},exports:{},document:documentStub,
  localStorage:{getItem:(k)=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:(k)=>{delete store[k];}},
  XMLHttpRequest:function(){this.open=()=>{};this.send=()=>{};this.addEventListener=()=>{};this.setRequestHeader=()=>{};}};
sandbox.window=sandbox;sandbox.globalThis=sandbox;
sandbox.__musicAgg={base:()=>'http://127.0.0.1:17899',
  api:function(p){
    if(p.indexOf('/music/url')>=0)return Promise.resolve({url:'http://x/y.mp3'});
    if(p.indexOf('lyric')>=0)return Promise.resolve({lyric:'[00:01.00]第一句\n[00:05.00]第二句\n[00:09.00]第三句'});
    if(p.indexOf('/music/search')>=0)return Promise.resolve(SONGS);
    return Promise.resolve({list:[]});}};
vm.createContext(sandbox);
let err=null;
try{ vm.runInContext(fs.readFileSync(path.join(ROOT,'js','musicagg-native.js'),'utf8'),sandbox,{filename:'n.js'}); }
catch(e){ err=e; }
ok('加载无异常',!err,err&&err.message);
if(err){ console.log('\n通过 '+pass+' / 失败 '+fail); process.exit(1); }

setTimeout(()=>{
  getEl('mv2Query').value='x';
  getEl('btnMv2Search').click();
  setTimeout(()=>{
    const rows=deepFind(getEl('mv2List'),c=>(c._cls||'').split(' ').indexOf('mv2-row')>=0);
    rows[0].querySelector('.mv2-btn-play').click();
    setTimeout(()=>{
      const bar=getEl('mv2BarLyric');
      const a=getEl('mv2Audio');
      // t=0 时第一句（t=1s）本就未到 → 播放栏应为空（这是正确行为）
      ok('播放刚开始（t=0）第一句未到 → 播放栏为空', bar.textContent==='', JSON.stringify(bar.textContent));
      // 推进到 2s：进入第一句
      a.currentTime=2; (a._h.timeupdate||[]).forEach(f=>f({}));
      ok('进入第一句后显示内容', bar.textContent==='第一句', JSON.stringify(bar.textContent));
      ok('带 show 态（可见）', bar.classList.contains('show'));
      // 同一句内再次 timeupdate 不应重播动画
      (bar.classList)._all['swap']=false;
      bar.classList.remove('swap');
      (a._h.timeupdate||[]).forEach(f=>f({}));
      ok('同句内不触发 swap', !bar.classList.contains('swap'), JSON.stringify(bar.textContent));
      // 换到下一句应触发 swap
      a.currentTime=6; (a._h.timeupdate||[]).forEach(f=>f({}));
      ok('换句后触发 swap 动画', bar.classList.contains('swap'), JSON.stringify(bar.textContent));
      ok('内容已切到第二句', bar.textContent==='第二句', JSON.stringify(bar.textContent));

      // 关闭开关：清空并移除动画类
      (getEl('btnMv2BarLyric')._h.click||[]).forEach(f=>f({type:'click'}));
      ok('关闭后清空文本', bar.textContent==='', JSON.stringify(bar.textContent));
      ok('关闭后移除动画类', !bar.classList.contains('swap') && !bar.classList.contains('show'));

      console.log('\n通过 '+pass+' / 失败 '+fail);
      process.exit(fail===0?0:1);
    },300);
  },200);
},200);
'''
p = os.path.join(OUT, 't.js')
open(p, 'w', encoding='utf-8').write(JS)
r = subprocess.run(['node', p, D], capture_output=True, text=True, encoding='utf-8', errors='replace')
print()
print('=== 3. 播放栏歌词换句动画（行为）===')
print(r.stdout)
if r.stderr:
    print('--- stderr ---'); print(r.stderr[:1200])
print('CSS 部分：通过 %d / 失败 %d' % (pass1, fail1))
