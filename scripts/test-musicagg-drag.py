# -*- coding: utf-8 -*-
"""拖拽进 PR（行创建即 draggable + 路径映射表）与播放栏歌词开关

在插件目录下运行：
    python scripts/test-musicagg-drag.py
"""
import os, sys, subprocess
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(D, '_tmp', 'test-drag')
os.makedirs(OUT, exist_ok=True)

# 跑完自动清理临时目录（避免在插件目录里留垃圾）
import atexit as _atexit, shutil as _shutil
def _cleanup_tmp():
    try:
        _p = os.path.join(D, '_tmp')
        if os.path.exists(_p):
            _shutil.rmtree(_p, ignore_errors=True)
    except Exception:
        pass
_atexit.register(_cleanup_tmp)


JS = r'''
const fs=require('fs'), path=require('path'), vm=require('vm');
const ROOT=process.argv[2];
let pass=0, fail=0;
function ok(n,c,e){ if(c){pass++;console.log('  [OK]   '+n);} else {fail++;console.log('  [FAIL] '+n+(e!==undefined?' -> '+e:''));} }

function makeEl(tag){
  const el={tagName:(tag||'div').toUpperCase(),children:[],_cls:'',_text:'',_html:'',style:{},dataset:{},
    value:'',title:'',_h:{},attrs:{},offsetTop:0,clientHeight:100,_open:false,offsetHeight:40,
    get open(){return this._open;},set open(v){this._open=v;},
    get className(){return this._cls;},set className(v){this._cls=String(v);},
    get textContent(){return this._text;},set textContent(v){this._text=String(v==null?'':v);},
    get innerHTML(){return this._html;},set innerHTML(v){this._html=String(v==null?'':v);this.children=[];},
    addEventListener(t,fn){(this._h[t]=this._h[t]||[]).push(fn);},
    removeEventListener(){},
    appendChild(c){c.parentNode=this;this.children.push(c);return c;},
    removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);return c;},
    insertBefore(c){c.parentNode=this;this.children.push(c);return c;},
    querySelector(sel){const cs=String(sel).replace(/^\./,'').split('.')[0];
      for(const c of this.children){ if(c._cls&&c._cls.split(/\s+/).indexOf(cs)>=0)return c;
        if(c.querySelector){const r=c.querySelector(sel);if(r)return r;} } return null;},
    querySelectorAll(){return [];},
    setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k]===undefined?null:this.attrs[k];},
    removeAttribute(){},
    click(){(this._h.click||[]).forEach(f=>f({type:'click',target:this,preventDefault(){},stopPropagation(){}}));},
    classList:{add(){},remove(){},toggle(){},contains(){return false;}},
    focus(){},remove(){},pause(){},play(){return Promise.resolve();},src:'',currentTime:6,duration:200};
  return el;
}
function deepFind(el,pred,out){(out=out||[]);(el.children||[]).forEach(c=>{if(pred(c))out.push(c);deepFind(c,pred,out);});return out;}
const els={};
const getEl=(id)=>(els[id]=els[id]||makeEl(id==='mv2Audio'?'audio':'div'));
['wy','tx','kw','kg','mg',''].forEach(p=>{const b=makeEl('button');b.className='mv2-pf';b.dataset={pf:p};getEl('mv2Platforms').appendChild(b);});
getEl('mv2Type').value='song';
getEl('mv2Sheet').style.display='none';
getEl('mv2Player').style.display='none';
getEl('mv2LyricFloat').style.display='none';
const documentStub={readyState:'complete',getElementById:getEl,createElement:(t)=>makeEl(t),addEventListener(){},
  body:makeEl('body'),documentElement:makeEl('html'),querySelector:()=>null,
  querySelectorAll:(sel)=>{ if(String(sel).indexOf('mv2-pf')>=0) return getEl('mv2Platforms').children.filter(c=>(c._cls||'').indexOf('mv2-pf')>=0); return []; }};
// 关键：加载模块之前就预设已下载映射（第二首）
const store = { 'vh_musicagg_dl': JSON.stringify({ '歌二|唱二|12': 'D:\\music\\歌二.mp3' }) };
const LRC='[00:01.00]第一句歌词\n[00:05.00]第二句歌词\n[00:09.00]第三句歌词';
const SONGS=[{name:'歌一',singer:'唱一',songmid:11,source:'wy',interval:'03:00'},
             {name:'歌二',singer:'唱二',songmid:12,source:'wy',interval:'03:10'}];
const sandbox={console,setTimeout,clearTimeout,Promise,require,module:{exports:{}},exports:{},document:documentStub,
  localStorage:{getItem:(k)=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:(k)=>{delete store[k];}},
  XMLHttpRequest:function(){this.open=()=>{};this.send=()=>{};this.addEventListener=()=>{};this.setRequestHeader=()=>{};}};
sandbox.window=sandbox;sandbox.globalThis=sandbox;
sandbox.__musicAgg={base:()=>'http://127.0.0.1:17899',
  api:function(p){
    if(p.indexOf('leaderboard/boards')>=0)return Promise.resolve({list:[]});
    if(p.indexOf('songList/list')>=0)return Promise.resolve({list:[]});
    if(p.indexOf('hotSearch')>=0)return Promise.resolve({list:[]});
    if(p.indexOf('/music/url')>=0)return Promise.resolve({url:'http://x/y.mp3'});
    if(p.indexOf('lyric')>=0)return Promise.resolve({lyric:LRC});
    if(p.indexOf('/music/search')>=0)return Promise.resolve(SONGS);
    return Promise.resolve({list:[]});}};
vm.createContext(sandbox);
let err=null;
try{ vm.runInContext(fs.readFileSync(path.join(ROOT,'js','musicagg-native.js'),'utf8'),sandbox,{filename:'n.js'}); }
catch(e){ err=e; }
ok('加载无异常',!err,err&&err.message);
if(err){ console.log('\n通过 '+pass+' / 失败 '+fail); process.exit(1); }

setTimeout(()=>{
  getEl('mv2Query').value='测试';
  getEl('btnMv2Search').click();
  setTimeout(()=>{
    const rows=deepFind(getEl('mv2List'),c=>(c._cls||'').split(' ').indexOf('mv2-row')>=0);
    ok('搜到歌曲行',rows.length===2,rows.length);
    if(!rows.length){ console.log('\n通过 '+pass+' / 失败 '+fail); process.exit(1); }

    ok('行创建即 draggable=true',rows[0].attrs.draggable==='true',rows[0].attrs.draggable);

    // 第一首（未下载）
    const evA={dataTransfer:{setData(){}},_pd:false,preventDefault(){this._pd=true;}};
    (rows[0]._h.dragstart||[]).forEach(f=>f(evA));
    ok('未下载：拖拽被阻止',evA._pd===true);
    ok('未下载：提示先下载',/先点/.test(getEl('mv2Toast').textContent),getEl('mv2Toast').textContent);

    // 第二首（预设已下载 → 加载时已进内存映射表）
    const evB={dataTransfer:{_d:{},setData(k,v){this._d[k]=v;}},_pd:false,preventDefault(){this._pd=true;}};
    (rows[1]._h.dragstart||[]).forEach(f=>f(evB));
    ok('已下载：拖拽放行',evB._pd===false);
    ok('已下载：写入 CEP 拖拽数据',
       evB.dataTransfer._d['com.adobe.cep.dnd.file.0']==='D:\\music\\歌二.mp3',
       JSON.stringify(evB.dataTransfer._d));
    ok('已下载：按钮变 ✔',/✔/.test((rows[1].querySelector('.mv2-btn')||{}).textContent||''),
       (rows[1].querySelector('.mv2-btn')||{}).textContent);
    ok('已下载：行有 grab 光标类可用',rows[1].attrs.draggable==='true');

    // ===== 播放栏歌词 =====
    const play=rows[0].querySelector('.mv2-btn-play');
    play.click();
    setTimeout(()=>{
      const bar=getEl('mv2BarLyric');
      ok('切歌后播放栏立即有歌词',!!bar.textContent, JSON.stringify(bar.textContent));
      ok('播放栏歌词是当前句（t=6 → 第二句）',bar.textContent==='第二句歌词',JSON.stringify(bar.textContent));
      ok('播放栏只取首行（不含换行）',String(bar.textContent).indexOf('\n')<0);

      (getEl('btnMv2BarLyric')._h.click||[]).forEach(f=>f({type:'click'}));
      ok('关闭开关后隐藏',getEl('mv2BarLyric').style.display==='none',getEl('mv2BarLyric').style.display);
      ok('开关状态持久化(关)',store['vh_musicagg_barlyric']==='0',store['vh_musicagg_barlyric']);

      (getEl('btnMv2BarLyric')._h.click||[]).forEach(f=>f({type:'click'}));
      ok('重新打开后恢复显示',getEl('mv2BarLyric').style.display!=='none');
      ok('恢复后立刻显示当前句',bar.textContent==='第二句歌词',JSON.stringify(bar.textContent));
      ok('开关状态持久化(开)',store['vh_musicagg_barlyric']==='1',store['vh_musicagg_barlyric']);

      console.log('\n通过 '+pass+' / 失败 '+fail);
      process.exit(fail===0?0:1);
    },300);
  },200);
},200);
'''
p = os.path.join(OUT, 't.js')
open(p, 'w', encoding='utf-8').write(JS)
r = subprocess.run(['node', p, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))],
                   capture_output=True, text=True, encoding='utf-8', errors='replace')
print(r.stdout)
if r.stderr:
    print('--- stderr ---'); print(r.stderr[:1500])
