# -*- coding: utf-8 -*-
"""行为测试：音乐库 / 音效库「右键排除子文件夹」

真实 fs + 真实目录树（临时目录）+ DOM 桩，验证：
  1) 树的右键菜单出现「排除此文件夹」
  2) 点击后 collect/<scope>_excludes.json 落盘
  3) 被排除的目录仍在树中可见，但标记 excluded + 🚫 图标、文件数归零
  4) 重新扫描后该目录下的文件不再被收录（其余目录不受影响）
  5) 再右键可「取消排除」，文件恢复

在插件目录下运行：python scripts/test-lib-exclude.py
也可从别处运行并显式指定插件目录：python test-lib-exclude.py <插件目录>
"""
import os, sys, subprocess, shutil, atexit
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
    D = os.path.abspath(sys.argv[1])
elif os.path.basename(_HERE).lower() == 'scripts':
    D = os.path.dirname(_HERE)                      # 正常位置：插件根
else:
    D = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'
assert os.path.isfile(os.path.join(D, 'js', 'library-exclude.js')), '插件目录不对: ' + D
OUT = os.path.join(D, '_tmp', 'test-exclude')
if os.path.exists(OUT):
    shutil.rmtree(OUT, ignore_errors=True)
TR = os.path.join(OUT, 'tr')          # 临时目录树根
os.makedirs(TR, exist_ok=True)
atexit.register(lambda: shutil.rmtree(os.path.join(D, '_tmp'), ignore_errors=True))

# ---------- 造测试目录树 ----------
EXT = os.path.join(TR, 'ext')                    # 假的扩展根（collect 落在它下面）
MUSIC = os.path.join(TR, 'music')                # 被扫描的库目录
for d in [os.path.join(MUSIC, 'A', 'Sub'), os.path.join(MUSIC, 'B')]:
    os.makedirs(d, exist_ok=True)
for f, sz in [(os.path.join(MUSIC, 'A', 'a1.mp3'), 1200),
              (os.path.join(MUSIC, 'A', 'Sub', 'a2.mp3'), 1300),
              (os.path.join(MUSIC, 'B', 'b1.mp3'), 1400),
              (os.path.join(MUSIC, 'B', 'b2.mp3'), 1500)]:
    with open(f, 'wb') as fh:
        fh.write(b'\x00' * sz)
os.makedirs(os.path.join(EXT, 'collect'), exist_ok=True)
print('测试目录树:')
for root, dirs, files in os.walk(MUSIC):
    for fn in files:
        print('   ', os.path.relpath(os.path.join(root, fn), TR))

JS = r'''
const fs=require('fs'), path=require('path'), vm=require('vm');
const TR=process.argv[2], ROOT=process.argv[3];
const EXT=path.join(TR,'ext'), MUSIC=path.join(TR,'music');
let pass=0, fail=0;
function ok(n,c,e){ if(c){pass++;console.log('  [OK]   '+n);} else {fail++;console.log('  [FAIL] '+n+(e!==undefined?' -> '+e:''));} }

// ---------------- DOM 桩 ----------------
function makeEl(tag){
  const el={tagName:(tag||'div').toUpperCase(),children:[],_cls:'',_text:'',_html:'',style:{},dataset:{},
    value:'',title:'',_h:{},attrs:{},offsetTop:0,clientHeight:40,offsetHeight:40,scrollTop:0,offsetWidth:100,
    scrollHeight:400,checked:false,disabled:false,
    get className(){return this._cls;},set className(v){this._cls=String(v==null?'':v);},
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
    removeAttribute(){},focus(){},remove(){},pause(){},play(){return Promise.resolve();},
    setPointerCapture(){},releasePointerCapture(){},
    getBoundingClientRect(){return {left:0,top:0,width:100,height:40,right:100,bottom:40};},
    scrollTo(){},scrollIntoView(){},
    click(){(this._h.click||[]).forEach(f=>f({type:'click',target:this,clientX:1,clientY:1,preventDefault(){},stopPropagation(){}}));},
    fire(type,ev){(this._h[type]||[]).forEach(f=>f(Object.assign({type,target:this,clientX:1,clientY:1,preventDefault(){},stopPropagation(){}},ev||{})));},
    src:'',currentTime:0,duration:200,volume:1,muted:false};
  const cls={_all:{},add(s){(s||'').split(/\s+/).forEach(x=>{if(x)this._all[x]=true;});},
    remove(s){if(!s){this._all={};return;}(s||'').split(/\s+/).forEach(x=>{delete this._all[x];});},
    toggle(s,on){ if(on===undefined) on=!this._all[s]; if(on) this._all[s]=true; else delete this._all[s]; return !!on;},
    contains(s){return !!this._all[s];}};
  el.classList=cls;
  return el;
}
function deepFind(el,pred,out){(out=out||[]);(el.children||[]).forEach(c=>{if(pred(c))out.push(c);deepFind(c,pred,out);});return out;}

function newSandbox(){
  const els={};
  const getEl=(id)=>(els[id]=els[id]||makeEl('div'));
  const store={ mllibDir: MUSIC, sfxDir: MUSIC };
  const documentStub={readyState:'complete',getElementById:getEl,createElement:(t)=>makeEl(t),
    addEventListener(){},removeEventListener(){},body:makeEl('body'),documentElement:makeEl('html'),
    head:makeEl('head'),querySelector:()=>null,querySelectorAll:()=>[],hidden:false,
    createDocumentFragment:()=>makeEl('frag')};
  function CSInterface(){}
  CSInterface.prototype.getSystemPath=function(){ return EXT; };
  CSInterface.prototype.addEventListener=function(){};
  CSInterface.prototype.removeEventListener=function(){};
  CSInterface.prototype.dispatchEvent=function(){};
  CSInterface.prototype.evalScript=function(script,cb){ if(cb) cb(''); };
  CSInterface.prototype.getHostEnvironment=function(){ return '{}'; };
  const sandbox={console,
    setTimeout:setTimeout, clearTimeout:clearTimeout, setInterval:setInterval, clearInterval:clearInterval,
    Promise, require, module:{exports:{}}, exports:{}, String, Number, JSON, Math, Date, Array, Object, RegExp, Error,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, unescape, escape,
    document:documentStub,
    localStorage:{getItem:(k)=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:(k)=>{delete store[k];}},
    navigator:{userAgent:'node'}, location:{href:''},
    CSInterface, SystemPath:{EXTENSION:'extension',USER_DATA:'userdata'},
    requestAnimationFrame:(fn)=>setTimeout(fn,0), cancelAnimationFrame:(id)=>clearTimeout(id),
    innerWidth:1400, innerHeight:900,
    XMLHttpRequest:function(){this.open=()=>{};this.send=()=>{};this.addEventListener=()=>{};this.setRequestHeader=()=>{};
      this.abort=()=>{};this.readyState=4;this.status=200;this.responseText='';this.getAllResponseHeaders=()=>'';},
    Audio:function(){return makeEl('audio');},
    cep:{fs:{showOpenDialogEx:()=>({err:0,data:[MUSIC]}),readFile:()=>({err:0,data:''}),writeFile:()=>({err:0}),
          showOpenDialog:()=>({err:0,data:[MUSIC]})},
         process:{},
         getHostEnvironment:()=>'{}'},
    __adobe_cep__:{getSystemPath:()=>EXT},
    getComputedStyle:()=>({getPropertyValue:()=>''}),
    alert(){}, postMessage(){}, addEventListener(){}, removeEventListener(){},
    wavesurfer:{create:()=>({on(){},load(){},play(){},pause(){},destroy(){},setVolume(){},seekTo(){},isPlaying:()=>false,
      getDuration:()=>200,getCurrentTime:()=>0,onReady(){},zoom(){},getWrapper:()=>makeEl('div')})}
  };
  sandbox.window=sandbox; sandbox.globalThis=sandbox; sandbox.self=sandbox;
  vm.createContext(sandbox);
  return {sandbox, els, getEl, store};
}

// ---------------- 通用工具 ----------------
function rows(el){ return deepFind(el, c=>(c._cls||'').split(/\s+/).indexOf('tnode')>=0); }
function rowOf(treeEl,name){
  return rows(treeEl).find(r=>{
    const l=(r.children||[]).find(x=>(x._cls||'').indexOf('tlabel')>=0);
    return l && l.textContent===name;
  });
}
function icoOf(row){ return (row.children||[]).find(x=>(x._cls||'').indexOf('tico')>=0); }
function excludeFile(scope){ return path.join(EXT,'collect',scope+'_excludes.json'); }
function readExcl(scope){ try{ return JSON.parse(fs.readFileSync(excludeFile(scope),'utf8')); }catch(e){ return null; } }

// 点开目录右键菜单
function openDirMenu(row, menuEl){
  menuEl.style.display='none';
  row.fire('contextmenu',{clientX:40,clientY:40});
  return menuEl;
}

// ---------------- 音乐库 ----------------
function testMusiclib(then){
  console.log('=== 音乐库 musiclib.js ===');
  const {sandbox, getEl}=newSandbox();
  let err=null;
  try{
    vm.runInContext(fs.readFileSync(path.join(ROOT,'js','library-exclude.js'),'utf8'),sandbox,{filename:'library-exclude.js'});
    vm.runInContext(fs.readFileSync(path.join(ROOT,'js','musiclib.js'),'utf8'),sandbox,{filename:'musiclib.js'});
  }catch(e){ err=e; }
  ok('加载无异常', !err, err&&(err.message+'\n'+err.stack));
  if(err){ then(); return; }

  const treeEl=getEl('mllibTree');
  const menuEl=getEl('mllibContextMenu');
  const countEl=getEl('mllibCount');

  setTimeout(()=>{
    const rA=rowOf(treeEl,'A'), rB=rowOf(treeEl,'B');
    ok('树渲染出 A', !!rA);
    ok('树渲染出 B', !!rB);
    ok('B 初始未被排除', !!rB && rB.className.indexOf('excluded')<0, rB&&rB.className);
    ok('初始无排除文件', readExcl('musiclib')===null, JSON.stringify(readExcl('musiclib')));

    // 右键 B
    rB.fire('contextmenu',{clientX:40,clientY:40});
    ok('右键后菜单显示', menuEl.style.display==='block', menuEl.style.display);
    const it0=menuEl.children[0];
    ok('菜单第一项为「排除此文件夹」', !!it0 && it0.textContent.indexOf('排除此文件夹')>=0, it0&&it0.textContent);
    ok('菜单含「在资源管理器中打开」', (menuEl.children[1]||{}).textContent.indexOf('资源管理器')>=0);

    // 点排除
    it0.click();
    const ex1=readExcl('musiclib');
    ok('排除已落盘', Array.isArray(ex1) && ex1.length===1, JSON.stringify(ex1));
    ok('落盘路径 = B 目录', Array.isArray(ex1) && path.normalize(ex1[0]).toLowerCase()===path.join(MUSIC,'B').toLowerCase(),
       JSON.stringify(ex1));
    ok('菜单已关闭', menuEl.style.display==='none', menuEl.style.display);

    const rB2=rowOf(treeEl,'B');
    ok('B 仍在树中可见（可取消排除）', !!rB2);
    ok('B 行带 excluded 标记', !!rB2 && rB2.className.indexOf('excluded')>=0, rB2&&rB2.className);
    ok('B 图标变 🚫', !!rB2 && icoOf(rB2).textContent==='🚫', rB2&&icoOf(rB2).textContent);
    const rA2=rowOf(treeEl,'A');
    ok('A 未受影响', !!rA2 && rA2.className.indexOf('excluded')<0);
    ok('B 文件数归零', !!rB2 && ((rB2.children||[]).find(x=>(x._cls||'').indexOf('tcnt')>=0)||{}).textContent==='',
       rB2&&((rB2.children||[]).find(x=>(x._cls||'').indexOf('tcnt')>=0)||{}).textContent);

    // 选中 B → 列表为空
    rB2.click();
    ok('选中 B 后列表为空', (countEl.textContent||'')==='', JSON.stringify(countEl.textContent));
    rA2.click();
    ok('选中 A 仍有 1 首（直接层）', (countEl.textContent||'').indexOf('1')>=0, JSON.stringify(countEl.textContent));

    // 等后台重扫完成，验证磁盘缓存也不再收录 B
    setTimeout(()=>{
      const cache=path.join(EXT,'collect','musiclib_tree.json');
      let okCache=false, detail='';
      try{
        const c=JSON.parse(fs.readFileSync(cache,'utf8'));
        const hits=(c.music||[]).filter(m=>String(m.n).toLowerCase().indexOf('b1.mp3')>=0||String(m.n).toLowerCase().indexOf('b2.mp3')>=0);
        okCache = hits.length===0 && (c.music||[]).length===2;
        detail = 'music='+(c.music||[]).length+' bHits='+hits.length;
      }catch(e){ detail='读取失败 '+e.message; }
      ok('重扫后缓存不再收录 B 的文件', okCache, detail);
      ok('重扫后 B 节点仍在缓存（可见）', (function(){
        try{ const c=JSON.parse(fs.readFileSync(cache,'utf8'));
          return (c.dirs||[]).some(d=>path.normalize(d.a).toLowerCase()===path.join(MUSIC,'B').toLowerCase()); }catch(e){ return false; }
      })());

      // 取消排除
      const rB3=rowOf(treeEl,'B');
      rB3.fire('contextmenu',{clientX:40,clientY:40});
      const itU=menuEl.children[0];
      ok('再右键显示「取消排除」', !!itU && itU.textContent.indexOf('取消排除')>=0, itU&&itU.textContent);
      itU.click();
      const ex2=readExcl('musiclib');
      ok('取消排除后列表为空', Array.isArray(ex2) && ex2.length===0, JSON.stringify(ex2));

      setTimeout(()=>{
        const rB4=rowOf(treeEl,'B');
        ok('B 恢复未排除', !!rB4 && rB4.className.indexOf('excluded')<0, rB4&&rB4.className);
        ok('B 图标恢复', !!rB4 && icoOf(rB4).textContent!=='🚫', rB4&&icoOf(rB4).textContent);
        rB4.click();
        ok('B 的 2 个文件恢复', (countEl.textContent||'').indexOf('2')>=0, JSON.stringify(countEl.textContent));
        then();
      },400);
    },400);
  },300);
}

// ---------------- 音效库 ----------------
function testSfx(then){
  console.log('');
  console.log('=== 音效库 sfx.js ===');
  const {sandbox, getEl}=newSandbox();
  let err=null;
  try{
    vm.runInContext(fs.readFileSync(path.join(ROOT,'js','library-exclude.js'),'utf8'),sandbox,{filename:'library-exclude.js'});
    vm.runInContext(fs.readFileSync(path.join(ROOT,'js','sfx.js'),'utf8'),sandbox,{filename:'sfx.js'});
  }catch(e){ err=e; }
  ok('加载无异常', !err, err&&(err.message+'\n'+err.stack));
  if(err){ then(); return; }

  const treeEl=getEl('sfxTree');
  const menuEl=getEl('sfxContextMenu');
  const countEl=getEl('sfxCount');

  setTimeout(()=>{
    const rA=rowOf(treeEl,'A'), rB=rowOf(treeEl,'B');
    ok('树渲染出 A', !!rA);
    ok('树渲染出 B', !!rB);
    ok('B 初始未被排除', !!rB && rB.className.indexOf('excluded')<0, rB&&rB.className);
    ok('扫描收录 4 个音频', (countEl.textContent||'').indexOf('4')>=0, JSON.stringify(countEl.textContent));

    rB.fire('contextmenu',{clientX:40,clientY:40});
    const it0=menuEl.children[0];
    ok('菜单第一项为「排除此文件夹」', !!it0 && it0.textContent.indexOf('排除此文件夹')>=0, it0&&it0.textContent);
    it0.click();

    const ex1=readExcl('sfx');
    ok('排除已落盘', Array.isArray(ex1) && ex1.length===1, JSON.stringify(ex1));
    ok('落盘路径 = B 目录', Array.isArray(ex1) && path.normalize(ex1[0]).toLowerCase()===path.join(MUSIC,'B').toLowerCase(), JSON.stringify(ex1));

    const rB2=rowOf(treeEl,'B');
    ok('B 仍在树中可见', !!rB2);
    ok('B 行带 excluded 标记', !!rB2 && rB2.className.indexOf('excluded')>=0, rB2&&rB2.className);
    ok('B 图标变 🚫', !!rB2 && icoOf(rB2).textContent==='🚫', rB2&&icoOf(rB2).textContent);
    ok('B 文件数为空', !!rB2 && ((rB2.children||[]).find(x=>(x._cls||'').indexOf('tcnt')>=0)||{}).textContent==='');

    // 直接重扫：验证 B 下文件真的不再被收录（总数 4 → 2）
    sandbox.__sfxRescan && sandbox.__sfxRescan();
    setTimeout(()=>{
      ok('重扫后总数从 4 降到 2', (countEl.textContent||'').indexOf('4')<0, JSON.stringify(countEl.textContent));
      const cache=path.join(EXT,'collect','index.json');
      let detail='', okCache=false;
      try{
        const c=JSON.parse(fs.readFileSync(cache,'utf8'));
        const arr=Array.isArray(c)?c:(c.files||[]);
        okCache = arr.length===2 && !arr.some(x=>String(x.name||x.fullPath||'').toLowerCase().indexOf('b1.mp3')>=0);
        detail='缓存条数='+arr.length;
      }catch(e){ detail='读取失败 '+e.message; }
      ok('磁盘缓存不再收录 B 的文件', okCache, detail);
      ok('重扫后 B 节点仍可见', !!rowOf(treeEl,'B'));

      // 取消排除
      const rB3=rowOf(treeEl,'B');
      rB3.fire('contextmenu',{clientX:40,clientY:40});
      const itU=menuEl.children[0];
      ok('再右键显示「取消排除」', !!itU && itU.textContent.indexOf('取消排除')>=0, itU&&itU.textContent);
      itU.click();
      ok('取消排除后列表为空', (readExcl('sfx')||[]).length===0, JSON.stringify(readExcl('sfx')));

      setTimeout(()=>{
        const rB4=rowOf(treeEl,'B');
        ok('B 恢复未排除', !!rB4 && rB4.className.indexOf('excluded')<0, rB4&&rB4.className);
        ok('B 图标恢复', !!rB4 && icoOf(rB4).textContent!=='🚫', rB4&&icoOf(rB4).textContent);
        ok('总数恢复到 4', (countEl.textContent||'').indexOf('4')>=0, JSON.stringify(countEl.textContent));
        then();
      },500);
    },500);
  },300);
}

testMusiclib(()=>{
  testSfx(()=>{
    console.log('');
    console.log('通过 '+pass+' / 失败 '+fail);
    process.exit(fail===0?0:1);
  });
});
'''

tp = os.path.join(OUT, 't.js')
with open(tp, 'w', encoding='utf-8') as f:
    f.write(JS)
r = subprocess.run(['node', tp, TR, D], capture_output=True, text=True,
                   encoding='utf-8', errors='replace', timeout=180)
print(r.stdout)
if r.stderr:
    print('--- stderr ---')
    print(r.stderr[:4000])
sys.exit(r.returncode)
