# -*- coding: utf-8 -*-
"""歌单分享链接直接打开 + 搜索类型不随平台切换而变

在插件目录下运行：
    python scripts/test-musicagg-list.py
"""
# -*- coding: utf-8 -*-
"""行为测试：歌单链接直接打开 + 搜索类型不随平台切换而变"""
import os, sys, subprocess
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(D, '_tmp', 'test-list')
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
    remove(s){if(!s){this._all={};return;}(s||'').split(/\s+/).forEach(x=>{delete this._all[x];});},
    toggle(s,on){ if(on===undefined) on=!this._all[s]; if(on) this._all[s]=true; else delete this._all[s]; },
    contains(s){return !!this._all[s];}};
  el.classList=cls;
  return el;
}
function deepFind(el,pred,out){(out=out||[]);(el.children||[]).forEach(c=>{if(pred(c))out.push(c);deepFind(c,pred,out);});return out;}
const els={};
const getEl=(id)=>(els[id]=els[id]||makeEl(id==='mv2Audio'?'audio':'div'));
['wy','tx','kw','kg','mg',''].forEach(p=>{const b=makeEl('button');b.className='mv2-pf';b.dataset={pf:p};getEl('mv2Platforms').appendChild(b);});
getEl('mv2Type').value='song';
getEl('mv2Sheet').style.display='none';
getEl('mv2List').style.display='';
const documentStub={readyState:'complete',getElementById:getEl,createElement:(t)=>makeEl(t),addEventListener(){},
  body:makeEl('body'),documentElement:makeEl('html'),querySelector:()=>null,
  querySelectorAll:(sel)=>{ if(String(sel).indexOf('mv2-pf')>=0) return getEl('mv2Platforms').children.filter(c=>(c._cls||'').indexOf('mv2-pf')>=0); return []; }};
const store={};
const CALLS=[];
const sandbox={console,setTimeout,clearTimeout,Promise,require,module:{exports:{}},exports:{},document:documentStub,
  localStorage:{getItem:(k)=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:(k)=>{delete store[k];}},
  XMLHttpRequest:function(){this.open=()=>{};this.send=()=>{};this.addEventListener=()=>{};this.setRequestHeader=()=>{};}};
sandbox.window=sandbox;sandbox.globalThis=sandbox;
sandbox.__musicAgg={base:()=>'http://127.0.0.1:17899',
  api:function(p){
    CALLS.push(p);
    if(p.indexOf('leaderboard/boards')>=0)return Promise.resolve({list:[]});
    if(p.indexOf('songList/list')>=0)return Promise.resolve({list:[{id:'1827',name:'推荐歌单',author:'a'}]});
    if(p.indexOf('hotSearch')>=0)return Promise.resolve({list:[]});
    if(p.indexOf('songList/detail')>=0)return Promise.resolve({list:[{name:'歌一',singer:'唱',songmid:11,source:'wy',interval:'03:00'}],info:{name:'分享的歌单'}});
    if(p.indexOf('lyric')>=0)return Promise.resolve({lyric:'[00:01.00]A\n[00:05.00]B'});
    if(p.indexOf('/music/search')>=0)return Promise.resolve([{name:'搜一',singer:'s',songmid:9,source:'wy',interval:'03:00'}]);
    if(p.indexOf('/music/url')>=0)return Promise.resolve({url:'http://x/y.mp3'});
    return Promise.resolve({list:[]});}};
vm.createContext(sandbox);
let err=null;
try{ vm.runInContext(fs.readFileSync(path.join(ROOT,'js','musicagg-native.js'),'utf8'),sandbox,{filename:'n.js'}); }
catch(e){ err=e; }
ok('加载无异常',!err,err&&err.message);
if(err){ console.log('\n通过 '+pass+' / 失败 '+fail); process.exit(1); }

setTimeout(()=>{
  // ================= 1. 类型不随平台切换而变 =================
  console.log('=== 1. 搜索类型保持 ===');
  getEl('mv2Type').value='playlist';
  getEl('mv2Query').value='';
  // 切到 QQ
  const pfBtn = getEl('mv2Platforms').children.find(b=>b.dataset.pf==='tx');
  pfBtn.click();
  setTimeout(()=>{
    ok('切到 QQ 后类型仍为歌单', getEl('mv2Type').value==='playlist', getEl('mv2Type').value);
    // 切成单曲，再切到酷狗
    getEl('mv2Type').value='song';
    const pfBtn2 = getEl('mv2Platforms').children.find(b=>b.dataset.pf==='kg');
    pfBtn2.click();
    setTimeout(()=>{
      ok('切成单曲后切平台仍为单曲', getEl('mv2Type').value==='song', getEl('mv2Type').value);
      // 切回歌单 + 网易云
      getEl('mv2Type').value='playlist';
      getEl('mv2Platforms').children.find(b=>b.dataset.pf==='wy').click();
      setTimeout(()=>{
        ok('切回网易云仍为歌单', getEl('mv2Type').value==='playlist', getEl('mv2Type').value);

        // ================= 2. 歌单链接直接打开 =================
        console.log('=== 2. 歌单链接直接打开 ===');
        CALLS.length=0;
        getEl('mv2Type').value='playlist';
        getEl('mv2Query').value='https://music.163.com/#/playlist?id=3778678';
        getEl('btnMv2Search').click();
        setTimeout(()=>{
          const detailCalls = CALLS.filter(c=>c.indexOf('songList/detail')>=0);
          ok('链接触发了 songList/detail', detailCalls.length>0, JSON.stringify(CALLS));
          ok('detail 用解析出的 id', detailCalls.some(c=>c.indexOf('3778678')>=0), JSON.stringify(detailCalls));
          ok('没有把链接当关键词去搜', !CALLS.some(c=>c.indexOf('/music/search')>=0 && c.indexOf('music.163')>=0),
             JSON.stringify(CALLS));
          const sheetRows=deepFind(getEl('mv2SheetList'),c=>(c._cls||'').split(' ').indexOf('mv2-row')>=0);
          ok('歌单已打开并渲染歌曲', sheetRows.length===1, sheetRows.length);

          // 分享文案里夹链接
          CALLS.length=0;
          getEl('mv2Query').value='分享歌单 《热歌榜》 https://music.163.com/playlist?id=3778678 （来自@网易云音乐）';
          getEl('btnMv2Search').click();
          setTimeout(()=>{
            ok('分享文案里的链接也能打开',
               CALLS.some(c=>c.indexOf('songList/detail')>=0 && c.indexOf('3778678')>=0),
               JSON.stringify(CALLS));

            // 纯歌单 ID
            CALLS.length=0;
            getEl('mv2Query').value='3778678';
            getEl('btnMv2Search').click();
            setTimeout(()=>{
              ok('纯歌单 ID 也能打开',
                 CALLS.some(c=>c.indexOf('songList/detail')>=0 && c.indexOf('3778678')>=0),
                 JSON.stringify(CALLS));

              console.log('\n通过 '+pass+' / 失败 '+fail);
              process.exit(fail===0?0:1);
            },200);
          },200);
        },250);
      },150);
    },150);
  },150);
},200);
'''
p = os.path.join(OUT, 't.js')
open(p, 'w', encoding='utf-8').write(JS)
r = subprocess.run(['node', p, D],
                   capture_output=True, text=True, encoding='utf-8', errors='replace')
print(r.stdout)
if r.stderr:
    print('--- stderr ---'); print(r.stderr[:1500])
