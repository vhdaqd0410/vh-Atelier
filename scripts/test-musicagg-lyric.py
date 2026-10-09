# -*- coding: utf-8 -*-
"""歌词浮层滚动定位：高亮偏下、保留上文、near 渐层

在插件目录下运行：
    python scripts/test-musicagg-lyric.py
"""
import os, sys, subprocess
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(D, '_tmp_test_lyric')
os.makedirs(OUT, exist_ok=True)

JS = r'''
const fs=require('fs'), path=require('path'), vm=require('vm');
const ROOT=process.argv[2];
let pass=0, fail=0;
function ok(n,c,e){ if(c){pass++;console.log('  [OK]   '+n);} else {fail++;console.log('  [FAIL] '+n+(e!==undefined?' -> '+e:''));} }

function makeEl(tag){
  const el={tagName:(tag||'div').toUpperCase(),children:[],_cls:'',_text:'',_html:'',style:{},dataset:{},
    value:'',title:'',_h:{},attrs:{},offsetTop:0,clientHeight:40,offsetHeight:40,scrollTop:0,
    get open(){return true;},set open(v){},
    get className(){return this._cls;},set className(v){this._cls=String(v);},
    get textContent(){return this._text;},set textContent(v){this._text=String(v==null?'':v);},
    get innerHTML(){return this._html;},set innerHTML(v){this._html=String(v==null?'':v);this.children=[];},
    addEventListener(t,fn){(this._h[t]=this._h[t]||[]).push(fn);},
    removeEventListener(){},
    appendChild(c){
      c.parentNode=this;
      // 模拟真实布局：每个子元素有 offsetTop
      c.offsetTop = this.children.length*40;
      if(c.classList && c.classList._set) c.classList._set(c._cls);
      this.children.push(c); return c;},
    removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);return c;},
    insertBefore(c){c.parentNode=this;c.offsetTop=this.children.length*40;this.children.push(c);return c;},
    querySelector(sel){const cs=String(sel).replace(/^\./,'').split('.')[0];
      for(const c of this.children){ if(c._cls&&c._cls.split(/\s+/).indexOf(cs)>=0)return c;
        if(c.querySelector){const r=c.querySelector(sel);if(r)return r;} } return null;},
    querySelectorAll(){return [];},
    setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k]===undefined?null:this.attrs[k];},
    removeAttribute(){},
    click(){(this._h.click||[]).forEach(f=>f({type:'click',target:this,preventDefault(){},stopPropagation(){}}));},
    focus(){},remove(){},pause(){},
    play(){return Promise.resolve();},
    src:'',currentTime:0,duration:200};
  // classList 记录真实状态，便于断言
  const cls={_all:{},add(s){this._all[s]=true;},remove(s){delete this._all[s];},
    toggle(s,on){ if(on===undefined) on=!this._all[s]; if(on) this._all[s]=true; else delete this._all[s]; },
    contains(s){return !!this._all[s];},_set(c){this._all={};(c||'').split(/\s+/).forEach(x=>{if(x)this._all[x]=true;});}};
  el.classList=cls;
  return el;
}
function deepFind(el,pred,out){(out=out||[]);(el.children||[]).forEach(c=>{if(pred(c))out.push(c);deepFind(c,pred,out);});return out;}
const els={};
const getEl=(id)=>(els[id]=els[id]||makeEl(id==='mv2Audio'?'audio':'div'));
['wy','tx','kw','kg','mg',''].forEach(p=>{const b=makeEl('button');b.className='mv2-pf';b.dataset={pf:p};getEl('mv2Platforms').appendChild(b);});
getEl('mv2Type').value='song';
getEl('mv2Sheet').style.display='none';
getEl('mv2LyricFloat').style.display='';
getEl('mv2LyricBody').clientHeight=400;
const documentStub={readyState:'complete',getElementById:getEl,createElement:(t)=>makeEl(t),addEventListener(){},
  body:makeEl('body'),documentElement:makeEl('html'),querySelector:()=>null,
  querySelectorAll:(sel)=>{ if(String(sel).indexOf('mv2-pf')>=0) return getEl('mv2Platforms').children.filter(c=>(c._cls||'').indexOf('mv2-pf')>=0); return []; }};
// 20 句歌词，每 3 秒一句
let lrc='';
for(let i=0;i<20;i++){ lrc += '[' + String(Math.floor(i*3/60)).padStart(2,'0') + ':' + String(i*3%60).padStart(2,'0') + '.00]第'+(i+1)+'句\n'; }
const store={};
const SONGS=[{name:'歌一',singer:'唱一',songmid:11,source:'wy',interval:'03:00'}];
const sandbox={console,setTimeout,clearTimeout,Promise,require,module:{exports:{}},exports:{},document:documentStub,
  localStorage:{getItem:(k)=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:(k)=>{delete store[k];}},
  XMLHttpRequest:function(){this.open=()=>{};this.send=()=>{};this.addEventListener=()=>{};this.setRequestHeader=()=>{};}};
sandbox.window=sandbox;sandbox.globalThis=sandbox;
sandbox.__musicAgg={base:()=>'http://127.0.0.1:17899',
  api:function(p){
    if(p.indexOf('/music/url')>=0)return Promise.resolve({url:'http://x/y.mp3'});
    if(p.indexOf('lyric')>=0)return Promise.resolve({lyric:lrc});
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
      const body=getEl('mv2LyricBody');
      const lines=deepFind(body,c=>(c._cls||'').indexOf('mv2-lyric-line')>=0);
      ok('歌词渲染 20 行',lines.length===20,lines.length);

      // 模拟播到第 10 句（t=27s）
      const a=getEl('mv2Audio');
      a.currentTime=27;
      (a._h.timeupdate||[]).forEach(f=>f({type:'timeupdate'}));

      const onIdx=lines.findIndex(l=>l.classList.contains('on'));
      ok('有且仅有一行高亮',lines.filter(l=>l.classList.contains('on')).length===1,
         lines.filter(l=>l.classList.contains('on')).length);
      ok('高亮行是第 10 句（t=27）',onIdx===9,onIdx);

      // 关键：滚动位置必须让高亮行落在容器偏下，而不是顶到最上
      ok('容器已滚动（不是停在顶部）',body.scrollTop>0,body.scrollTop);
      const onEl=lines[onIdx];
      const ratio=(onEl.offsetTop-body.scrollTop)/body.clientHeight;
      ok('高亮行落在容器偏下（ratio>0.5）',ratio>0.5,'ratio='+ratio.toFixed(3));
      ok('高亮行上方保留了大量上下文',body.scrollTop>body.clientHeight*0.3,
         'scrollTop='+body.scrollTop);

      // 后面几句应有 near 标记
      const nearCount=lines.filter(l=>l.classList.contains('near')).length;
      ok('当前句附近有 near 渐层',nearCount>0,nearCount);

      // 播到最后一句也不能超出
      a.currentTime=57;
      (a._h.timeupdate||[]).forEach(f=>f({type:'timeupdate'}));
      ok('最后一句能正常高亮',lines[19].classList.contains('on'));

      console.log('\n通过 '+pass+' / 失败 '+fail);
      process.exit(fail===0?0:1);
    },400);
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
