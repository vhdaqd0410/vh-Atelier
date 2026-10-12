# -*- coding: utf-8 -*-
"""行为测试：语音克隆「序列入点出点」取参考音频

覆盖三层：
  A 纯函数    区间→段换算（源素材偏移/时长/排序/剔零）
  B 选轨      非静音音频轨优先，覆盖时长最大者胜
  C 端到端    模式切换、单段截取、多段拼接、超 30 秒拦截、选轨与空区间报错

真实临时目录 + 真实 fs（写占位 wav）+ 桩 child_process（记录 ffmpeg 参数）。

在插件目录下运行：python scripts/test-vc-inout.py
"""
import os, sys, subprocess, shutil, atexit
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
    D = os.path.abspath(sys.argv[1])
elif os.path.basename(_HERE).lower() == 'scripts':
    D = os.path.dirname(_HERE)
else:
    D = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'
assert os.path.isfile(os.path.join(D, 'js', 'clone.js')), '插件目录不对: ' + D

OUT = os.path.join(D, '_tmp', 'test-vcinout')
if os.path.exists(OUT):
    shutil.rmtree(OUT, ignore_errors=True)
TR = os.path.join(OUT, 'tr')
os.makedirs(os.path.join(TR, 'ext', 'bin'), exist_ok=True)
# ffmpeg 占位（clone.js 会检查存在性）
with open(os.path.join(TR, 'ext', 'bin', 'ffmpeg-win32-x64.exe'), 'wb') as f:
    f.write(b'MZ')
atexit.register(lambda: shutil.rmtree(os.path.join(D, '_tmp'), ignore_errors=True))

JS = r'''
const fs=require('fs'), path=require('path'), vm=require('vm');
const TR=process.argv[2], ROOT=process.argv[3];
const EXT=path.join(TR,'ext');
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
    querySelectorAll(sel){
      const cs=String(sel).replace(/^\./,'').split('.')[0];
      const out=[];
      (function walk(n){(n.children||[]).forEach(c=>{
        if(c._cls && c._cls.split(/\s+/).indexOf(cs)>=0) out.push(c);
        walk(c);
      });})(this);
      return out;
    },
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

// ---------------- ffmpeg 桩 ----------------
const FF=[];              // 记录的调用 [{args, out, scriptName}]
const LISTS={};           // 拼接清单 {path: 内容}
let ffFailAt=-1;          // 让第 N 次调用失败（0 基）；-1 = 都成功
// 只数「截取/拼接」调用：抓取成功后 autoRecognizeRef 也会调 ffmpeg（转 16k 喂 whisper），
// 那是另一回事，不能计进来，否则本机装没装 whisper 会影响断言。
function refCalls(){ return FF.filter(function(f){ return /ref_\d+_(\d+|cat)\.wav$/.test(f.out); }); }
function makeChildProcess(){
  return {
    spawnSync: function(){ return { status:1, stdout:'', stderr:'', error:null }; },
    execFile: function(bin, args, opts, cb){
      if(typeof opts==='function'){ cb=opts; opts={}; }
      const out=args[args.length-1];
      const idx=FF.length;
      const isConcat = args.indexOf('-f')>=0 && args[args.indexOf('-f')+1]==='concat';
      if(isConcat){
        const li=args.indexOf('-i');
        if(li>=0){ try{ LISTS[args[li+1]]=fs.readFileSync(args[li+1],'utf8'); }catch(e){ LISTS[args[li+1]]='<读取失败>'; } }
      }
      FF.push({ args, out, isConcat });
      if(idx===ffFailAt) return cb(new Error('模拟 ffmpeg 失败'));
      try{ fs.writeFileSync(out, 'RIFF____WAVEfmt '); }catch(e){}
      cb(null, '', '');
    }
  };
}

// ---------------- 沙箱 ----------------
const RANGE={ data:null };
const TRACKS={ data:{ tracks:[ {index:0,name:'A1',clips:2}, {index:1,name:'A2',clips:1} ] } };
const EVALS=[];

function newSandbox(){
  const els={};
  const getEl=(id)=>(els[id]=els[id]||makeEl('div'));
  const store={};
  const documentStub={readyState:'complete',getElementById:getEl,createElement:(t)=>makeEl(t),
    addEventListener(){},removeEventListener(){},body:makeEl('body'),documentElement:makeEl('html'),
    head:makeEl('head'),querySelector:()=>null,querySelectorAll:()=>[],hidden:false,
    createDocumentFragment:()=>makeEl('frag')};
  function CSInterface(){}
  CSInterface.prototype.getSystemPath=function(){ return EXT; };
  CSInterface.prototype.addEventListener=function(){};
  CSInterface.prototype.removeEventListener=function(){};
  CSInterface.prototype.dispatchEvent=function(){};
  CSInterface.prototype.evalScript=function(script, cb){
    EVALS.push(String(script));
    let r='';
    if(script.indexOf('vcGetInOutRangeStr')>=0) r=JSON.stringify(RANGE.data||{error:'未设置'});
    else if(script.indexOf('vcGetAudioTracks')>=0) r=JSON.stringify(TRACKS.data);
    else if(script.indexOf('vcListProjectMedia')>=0) r=JSON.stringify({items:[]});
    else if(script.indexOf('vcGetPlayerPosition')>=0) r=JSON.stringify({sec:0});
    if(cb) cb(r);
  };
  CSInterface.prototype.getHostEnvironment=function(){ return '{}'; };
  const req=function(name){ if(name==='child_process') return makeChildProcess(); return require(name); };
  const sandbox={console,
    setTimeout:setTimeout, clearTimeout:clearTimeout, setInterval:setInterval, clearInterval:clearInterval,
    Promise, require:req, module:{exports:{}}, exports:{}, String, Number, JSON, Math, Date, Array, Object,
    RegExp, Error, TypeError, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    document:documentStub,
    localStorage:{getItem:(k)=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:(k)=>{delete store[k];}},
    navigator:{userAgent:'node'}, location:{href:''},
    CSInterface, SystemPath:{EXTENSION:'extension',USER_DATA:'userdata'},
    requestAnimationFrame:(fn)=>setTimeout(fn,0), cancelAnimationFrame:(id)=>clearTimeout(id),
    innerWidth:1400, innerHeight:900,
    XMLHttpRequest:function(){this.open=()=>{};this.send=()=>{};this.addEventListener=()=>{};this.setRequestHeader=()=>{};
      this.abort=()=>{};this.readyState=4;this.status=200;this.responseText='';this.getAllResponseHeaders=()=>'';},
    Audio:function(){return makeEl('audio');},
    cep:{fs:{showOpenDialogEx:()=>({err:0,data:[]}),readFile:()=>({err:0,data:''}),writeFile:()=>({err:0})},process:{}},
    __adobe_cep__:{getSystemPath:()=>EXT},
    getComputedStyle:()=>({getPropertyValue:()=>''}),
    alert(){}, confirm:()=>true, prompt:()=>null, postMessage(){}, addEventListener(){}, removeEventListener(){}
  };
  sandbox.window=sandbox; sandbox.globalThis=sandbox; sandbox.self=sandbox;
  vm.createContext(sandbox);
  return {sandbox, els, getEl, store};
}

// ================= A. 纯函数 =================
console.log('=== A. 区间→段换算 ===');
const {sandbox:s0}=newSandbox();
vm.runInContext(fs.readFileSync(path.join(ROOT,'js','utils.js'),'utf8'),s0,{filename:'utils.js'});
const U=s0.window.__vhUtils;
ok('utils 暴露 pickRefTrack', typeof U.pickRefTrack==='function');
ok('utils 暴露 buildRefSegments', typeof U.buildRefSegments==='function');

// 单片段，区间与片段完全重合：seq 10~14，素材内 2~6
let segs=U.buildRefSegments([{mediaPath:'C:/m/a.mp4',clipName:'c1',seqStart:10,mediaIn:2,ovStart:10,ovEnd:14,ovDur:4}],10,14);
ok('单段：只有 1 段', segs.length===1, JSON.stringify(segs));
ok('单段：素材偏移 = mediaIn', segs[0].srcStart===2, segs[0] && segs[0].srcStart);
ok('单段：时长 = 4', segs[0].take===4, segs[0] && segs[0].take);

// 左切：入点落在片段中间（in=11）
segs=U.buildRefSegments([{mediaPath:'m',seqStart:10,mediaIn:2,ovStart:11,ovEnd:14,ovDur:3}],11,14);
ok('左切：偏移 = mediaIn + (入点-片段起点)', segs[0].srcStart===3, segs[0] && segs[0].srcStart);
ok('左切：时长 = 3', segs[0].take===3, segs[0] && segs[0].take);

// 多片段：乱序传入应按序列时间排序，偏移各自独立
segs=U.buildRefSegments([
  {mediaPath:'m2',seqStart:30,mediaIn:5,ovStart:30,ovEnd:33,ovDur:3},
  {mediaPath:'m1',seqStart:20,mediaIn:1,ovStart:20,ovEnd:24,ovDur:4}
],20,33);
ok('多段：按时间排序', segs.length===2 && segs[0].mediaPath==='m1' && segs[1].mediaPath==='m2',
   JSON.stringify(segs.map(s=>s.mediaPath)));
ok('多段：各段偏移独立', segs[0].srcStart===1 && segs[1].srcStart===5,
   segs[0].srcStart+'/'+segs[1].srcStart);

// 第二段只部分落入区间（区间到 31.5）
segs=U.buildRefSegments([
  {mediaPath:'m2',seqStart:30,mediaIn:5,ovStart:30,ovEnd:33,ovDur:3}
],30,31.5);
ok('右切：时长被区间截断为 1.5', Math.abs(segs[0].take-1.5)<0.002, segs[0].take);

// 零长重叠被剔除
segs=U.buildRefSegments([{mediaPath:'m',seqStart:10,mediaIn:0,ovStart:10,ovEnd:14,ovDur:4}],20,25);
ok('区间外的片段被剔除', segs.length===0, segs.length);

// 负偏移兜底为 0
segs=U.buildRefSegments([{mediaPath:'m',seqStart:100,mediaIn:1,ovStart:100,ovEnd:103,ovDur:3}],99,101);
ok('异常偏移不会为负', segs.length>0 && segs[0].srcStart>=0, segs.length?segs[0].srcStart:'无段');

console.log('');
console.log('=== B. 选轨 ===');
const T=(i,n,type,cov,muted)=>({index:i,name:n,type:type,muted:!!muted,clips:[{ovDur:cov,ovStart:0,ovEnd:cov,seqStart:0,mediaIn:0,mediaPath:'m'}]});
ok('两条非静音音轨：取覆盖长的', U.pickRefTrack([T(0,'A1','audio',4),T(1,'A2','audio',8)]).name==='A2');
ok('覆盖长的被静音：退到另一条', U.pickRefTrack([T(0,'A1','audio',4),T(1,'A2','audio',8,true)]).name==='A1');
ok('全静音音频轨：仍从音频轨里取', U.pickRefTrack([T(0,'A1','audio',4,true)]).name==='A1');
ok('无音频轨：退到视频轨', U.pickRefTrack([T(0,'V1','video',6)]).name==='V1');
ok('音频轨静音 + 视频轨非静音：选音频轨（音频优先）',
   U.pickRefTrack([T(0,'A1','audio',1,true),T(0,'V1','video',9)]).name==='A1');
ok('空列表返回 null', U.pickRefTrack([])===null);
ok('多片段覆盖累加决定胜出',
   U.pickRefTrack([
     {index:0,name:'A1',type:'audio',muted:false,clips:[{ovDur:3},{ovDur:3}]},
     {index:1,name:'A2',type:'audio',muted:false,clips:[{ovDur:5}]}
   ]).name==='A1');

// ================= C. 端到端 =================
console.log('');
console.log('=== C. 模式切换 ===');
const {sandbox:s1, getEl:g1, els:e1}=newSandbox();
// 预置 refSrcRow / modeRow 的按钮
const srcRow=g1('refSrcRow');
[['clip','选中片段',true],['inout','入点出点',false]].forEach(([v,txt,act])=>{
  const b=makeEl('button'); b.className='vc-mode'+(act?' active':''); b.dataset.src=v; srcRow.appendChild(b);
});
const modeRow=g1('modeRow');
['clone','instruct','cross'].forEach((m,i)=>{ const b=makeEl('button'); b.className='vc-mode'+(i===0?' active':''); b.dataset.mode=m; modeRow.appendChild(b); });
// 预置 refTrackSel
const tsel=g1('refTrackSel'); const oa=makeEl('option'); oa.value='auto'; tsel.appendChild(oa);

let err=null;
try{
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','utils.js'),'utf8'),s1,{filename:'utils.js'});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','clone.js'),'utf8'),s1,{filename:'clone.js'});
}catch(e){ err=e; }
ok('clone.js 加载无异常', !err, err && (err.message+'\n'+err.stack));
if(err){ console.log(''); console.log('通过 '+pass+' / 失败 '+fail); process.exit(1); }

ok('初始为「选中片段」模式', e1['refSrcClip'].style.display==='' && e1['refSrcInOut'].style.display==='none',
   e1['refSrcClip'].style.display+'/'+e1['refSrcInOut'].style.display);
// 点「入点出点」
srcRow.children[1].click();
ok('切到入点出点：片段块隐藏', e1['refSrcClip'].style.display==='none');
ok('切到入点出点：入出点块显示', e1['refSrcInOut'].style.display==='');
ok('按钮 active 状态跟着切', srcRow.children[1].classList.contains('active') && !srcRow.children[0].classList.contains('active'));
ok('切模式会去读音轨', EVALS.some(s=>s.indexOf('vcGetAudioTracks')>=0));
ok('切模式会去读区间', EVALS.some(s=>s.indexOf('vcGetInOutRangeStr')>=0));
ok('音轨下拉已填充', g1('refTrackSel').children.length===3, g1('refTrackSel').children.length);

// ---- 单段抓取 ----
console.log('');
console.log('=== C2. 单段抓取 ===');
const A1CLIP={mediaPath:'C:/media/ep1.mp4',clipName:'voice',seqStart:100,mediaIn:12,ovStart:100,ovEnd:105,ovDur:5};
RANGE.data={inSec:100,outSec:105,durationSec:5,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[A1CLIP]}]};
FF.length=0;
g1('btnGrabInOut').click();
ok('发了 1 次 ffmpeg', refCalls().length===1, refCalls().length);
const a=refCalls()[0]?refCalls()[0].args:[];
ok('用的是片段源素材', a.indexOf('C:/media/ep1.mp4')>=0, JSON.stringify(a));
ok('素材内偏移 = mediaIn + (100-100) = 12', a[a.indexOf('-ss')+1]==='12.000', a[a.indexOf('-ss')+1]);
ok('截取时长 = 5', a[a.indexOf('-t')+1]==='5.000', a[a.indexOf('-t')+1]);
ok('输出 24k 单声道', a.indexOf('24000')>=0 && a.indexOf('1')>=0 && a.indexOf('-ac')>=0, JSON.stringify(a));
ok('参考音频已就绪', e1['refInfo'].textContent.indexOf('入点→出点')>=0, e1['refInfo'].textContent);
ok('refInfo 标了 has', e1['refInfo'].classList.contains('has'));
ok('文案说明取的是哪条轨', e1['refInfo'].textContent.indexOf('A1')>=0, e1['refInfo'].textContent);

// ---- 多段拼接 ----
console.log('');
console.log('=== C3. 多段拼接 ===');
RANGE.data={inSec:200,outSec:210,durationSec:10,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[
    {mediaPath:'C:/m/one.mp4',clipName:'a',seqStart:200,mediaIn:3,ovStart:200,ovEnd:204,ovDur:4},
    {mediaPath:'C:/m/two.mp4',clipName:'b',seqStart:205,mediaIn:7,ovStart:205,ovEnd:207,ovDur:2},
    {mediaPath:'C:/m/three.mp4',clipName:'c',seqStart:207,mediaIn:1,ovStart:207,ovEnd:210,ovDur:3}
  ]}]};
FF.length=0;
g1('btnGrabInOut').click();
ok('3 段各截一次 + 1 次拼接 = 4 次 ffmpeg', refCalls().length===4, refCalls().length);
ok('前 3 次是截取', refCalls().slice(0,3).every(f=>!f.isConcat));
ok('第 4 次是 concat', refCalls()[3] && refCalls()[3].isConcat);
const listPath=Object.keys(LISTS)[0];
ok('生成了拼接清单', !!listPath, listPath);
const lines=(LISTS[listPath]||'').trim().split('\n');
ok('清单 3 行', lines.length===3, JSON.stringify(lines));
ok('清单用正斜杠（ffmpeg 兼容）', lines.every(l=>l.indexOf('\\\\')<0), JSON.stringify(lines));
ok('拼接输出是 wav', /\.wav$/.test(refCalls()[3].out), refCalls()[3] && refCalls()[3].out);
ok('文案标了 3 段拼接', e1['refInfo'].textContent.indexOf('3 段拼接')>=0, e1['refInfo'].textContent);
ok('实取时长 = 4+2+3 = 9 秒', e1['refInfo'].textContent.indexOf('9.0 秒')>=0, e1['refInfo'].textContent);

// ---- 超 30 秒拦截 ----
console.log('');
console.log('=== C4. 边界与报错 ===');
RANGE.data={inSec:0,outSec:45,durationSec:45,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[
    {mediaPath:'C:/m/long.mp4',clipName:'x',seqStart:0,mediaIn:0,ovStart:0,ovEnd:45,ovDur:45}]}]};
FF.length=0;
g1('btnGrabInOut').click();
ok('45 秒被拦截，未调 ffmpeg', FF.length===0, FF.length);
ok('报错提示 30 秒上限', e1['vcStatus'].textContent.indexOf('30')>=0, e1['vcStatus'].textContent);

// 区间大但轨道内容少 → 允许（按实取算）
RANGE.data={inSec:0,outSec:45,durationSec:45,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[
    {mediaPath:'C:/m/sparse.mp4',clipName:'x',seqStart:10,mediaIn:0,ovStart:10,ovEnd:22,ovDur:12}]}]};
FF.length=0;
g1('btnGrabInOut').click();
ok('区间 45 秒但实取 12 秒 → 放行', refCalls().length===1, refCalls().length);

// 指定轨道在区间内无片段
RANGE.data={inSec:0,outSec:5,durationSec:5,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[
    {mediaPath:'C:/m/a.mp4',clipName:'x',seqStart:0,mediaIn:0,ovStart:0,ovEnd:5,ovDur:5}]}]};
g1('refTrackSel').value='1';   // A2 不在区间内
FF.length=0;
g1('btnGrabInOut').click();
ok('选了无内容的轨 → 报错且不调 ffmpeg', FF.length===0 && e1['vcStatus'].textContent.indexOf('没有片段')>=0,
   e1['vcStatus'].textContent);
g1('refTrackSel').value='auto';

// 区间内没有任何轨道
RANGE.data={inSec:0,outSec:5,durationSec:5,seqName:'EP1',tracks:[]};
FF.length=0;
g1('btnGrabInOut').click();
ok('区间内无片段 → 报错', FF.length===0 && e1['vcStatus'].textContent.indexOf('没有任何')>=0, e1['vcStatus'].textContent);

// 无入点出点
RANGE.data={error:'序列未设置有效入点出点（in=-1, out=-1），请先在时间轴按 I / O 设置'};
FF.length=0;
g1('btnGrabInOut').click();
ok('未设 I/O → 报错', FF.length===0 && e1['vcStatus'].textContent.indexOf('I / O')>=0, e1['vcStatus'].textContent);

// ffmpeg 失败（片段无音轨）
RANGE.data={inSec:0,outSec:5,durationSec:5,seqName:'EP1',
  tracks:[{index:0,name:'V1',type:'video',muted:false,clips:[
    {mediaPath:'C:/m/silent.mp4',clipName:'x',seqStart:0,mediaIn:0,ovStart:0,ovEnd:5,ovDur:5}]}]};
FF.length=0; ffFailAt=0;
g1('btnGrabInOut').click();
ok('ffmpeg 失败被上报', e1['vcStatus'].textContent.indexOf('截取失败')>=0, e1['vcStatus'].textContent);
ok('提示可以换轨', e1['vcStatus'].textContent.indexOf('换一条轨')>=0, e1['vcStatus'].textContent);
ffFailAt=-1;

console.log('');
console.log('通过 '+pass+' / 失败 '+fail);
process.exit(fail===0?0:1);
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
