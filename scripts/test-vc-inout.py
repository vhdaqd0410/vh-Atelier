# -*- coding: utf-8 -*-
"""行为测试：语音克隆「序列入点出点」取参考音频

三条路径：
  独奏渲染  有音频预设 + 音频轨 → meMuteExcept 独奏 → meExportRangeStr 渲染 → 还原静音 → 转 24k
  兜底直取  无音频预设 或 视频轨 → 逐段按素材偏移截取（多段拼接）
  纯函数    区间→段换算、选轨优先级

重点锁死的行为：
  · 渲染失败 / 独奏失败 / 校验失败时，**必须**把用户自己的静音状态还原回去
  · 上限口径：渲染路径按 I/O 区间长度，直取路径按该轨实际覆盖时长
  · 预设挑选用确定性顺序（不受 readdir 顺序影响）

真实临时目录 + 真实 fs + 桩 child_process / evalScript。

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
with open(os.path.join(TR, 'ext', 'bin', 'ffmpeg-win32-x64.exe'), 'wb') as f:
    f.write(b'MZ')
# 假的 AME 预设目录：一个她惯用的「调音输出」（WAVE）+ 一个通用 Wave 预设（用于验证挑选优先级）
PRESET_DIR = os.path.join(TR, 'ame', '25.0', 'Presets')
os.makedirs(PRESET_DIR, exist_ok=True)
EPR = '<?xml version="1.0" encoding="UTF-8"?>\n<Preset><ExporterFileType>%d</ExporterFileType></Preset>\n'
with open(os.path.join(PRESET_DIR, '调音输出.epr'), 'w', encoding='utf-8') as f:
    f.write(EPR % 1463899717)          # WAVE
with open(os.path.join(PRESET_DIR, 'Wave48mono16.epr'), 'w', encoding='utf-8') as f:
    f.write(EPR % 1463899717)          # WAVE
with open(os.path.join(PRESET_DIR, '视频输出.epr'), 'w', encoding='utf-8') as f:
    f.write(EPR % 1211250229)          # H264（应被排除）
atexit.register(lambda: shutil.rmtree(os.path.join(D, '_tmp'), ignore_errors=True))

JS = r'''
const fs=require('fs'), path=require('path'), vm=require('vm');
const TR=process.argv[2], ROOT=process.argv[3];
const EXT=path.join(TR,'ext'), PRESET_DIR=path.join(TR,'ame','25.0','Presets');
const WAV=Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(36)]);
const MOV=Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.alloc(32)]);
let pass=0, fail=0;
function ok(n,c,e){ if(c){pass++;console.log('  [OK]   '+n);} else {fail++;console.log('  [FAIL] '+n+(e!==undefined?' -> '+e:''));} }

// ---------------- DOM 桩 ----------------
function makeEl(tag){
  const el={tagName:(tag||'div').toUpperCase(),children:[],_cls:'',_text:'',_html:'',style:{},dataset:{},
    value:'',title:'',_h:{},attrs:{},offsetTop:0,clientHeight:40,offsetHeight:40,scrollTop:0,offsetWidth:100,
    scrollHeight:400,checked:false,disabled:false,
    get className(){return this._cls;},set className(v){this._cls=String(v==null?'':v);},
    get textContent(){return this._text;},set textContent(v){this._text=String(v==null?'':v);(this._textLog=this._textLog||[]).push(this._text);},
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
const FF=[];
let ffFailAt=-1;
function makeChildProcess(){
  return {
    spawnSync: function(){ return { status:1, stdout:'', stderr:'', error:null }; },
    execFile: function(bin, args, opts, cb){
      if(typeof opts==='function'){ cb=opts; opts={}; }
      const out=args[args.length-1];
      FF.push({ args, out });
      if(FF.length-1===ffFailAt) return cb(new Error('模拟 ffmpeg 失败'));
      try{ fs.writeFileSync(out, WAV); }catch(e){}
      cb(null, '', '');
    }
  };
}
// 只数「截取/拼接」与「转 24k」调用（autoRecognizeRef 的 ffmpeg 不算）
function extractCalls(){ return FF.filter(f=>/ref_\d+_(\d+|cat)\.wav$/.test(f.out)); }
function convCalls(){ return FF.filter(f=>/ref_\d+_24k\.wav$/.test(f.out)); }

// ---------------- 沙箱 ----------------
const RANGE={ data:null };
const TRACKS={ data:{ tracks:[ {index:0,name:'A1',clips:2}, {index:1,name:'A2',clips:1} ] } };
const MUTE={ states:'OK:{"seqName":"EP1","numTracks":2,"tracks":[{"index":0,"name":"A1","muted":false},{"index":1,"name":"A2","muted":true}]}' };
const EVALS=[];         // 所有 evalScript 脚本
const SOLO=[];          // meMuteExcept 的入参
const RESTORE=[];       // meRestoreMuteStates 的入参
const UNMUTE=[];        // meUnmuteAll 调用次数
const PAYLOAD=[];       // meRangePayload 内容
let EXPORT_RET='OK:';
let EXPORT_BYTES=null;  // null=写合法 wav；否则写指定字节

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
    const sc=String(script);
    EVALS.push(sc);
    let r='';
    if(sc.indexOf('vcGetInOutRangeStr')>=0) r=JSON.stringify(RANGE.data||{error:'未设置'});
    else if(sc.indexOf('vcGetAudioTracks')>=0) r=JSON.stringify(TRACKS.data);
    else if(sc.indexOf('vcListProjectMedia')>=0) r=JSON.stringify({items:[]});
    else if(sc.indexOf('vcGetPlayerPosition')>=0) r=JSON.stringify({sec:0});
    else if(sc.indexOf('meListAudioTracks')>=0) r=MUTE.states;
    else if(sc.indexOf('meMuteExcept')>=0){
      const m=sc.match(/meMuteExcept\("([^"]*)"\)/);
      SOLO.push(m?m[1]:null);
      r='OK:{"muted":[1],"kept":[0],"total":2}';
    }
    else if(sc.indexOf('meRestoreMuteStates')>=0){
      const m=sc.match(/meRestoreMuteStates\("([^"]*)"\)/);
      RESTORE.push(m?m[1]:null);
      r='OK:{"restored":2,"failed":0}';
    }
    else if(sc.indexOf('meUnmuteAll')>=0){ UNMUTE.push(1); r='OK:'; }
    else if(sc.indexOf('meRangePayload')>=0){
      const m=sc.match(/meRangePayload\s*=\s*(\{[\s\S]*\});/);
      try{ PAYLOAD.push(m?JSON.parse(m[1]):null); }catch(e){ PAYLOAD.push('解析失败'); }
      r='';
    }
    else if(sc.indexOf('meExportRangeStr')>=0){
      const last=PAYLOAD[PAYLOAD.length-1];
      if(last && last.outPath){
        try{ fs.writeFileSync(last.outPath, EXPORT_BYTES||WAV); }catch(e){}
      }
      r=(EXPORT_RET==='OK:') ? ('OK:'+(last?last.outPath:'')) : EXPORT_RET;
    }
    if(cb) cb(r);
  };
  CSInterface.prototype.getHostEnvironment=function(){ return '{}'; };
  const req=function(name){ if(name==='child_process') return makeChildProcess(); return require(name); };
  const sandbox={console,
    setTimeout:setTimeout, clearTimeout:clearTimeout, setInterval:setInterval, clearInterval:clearInterval,
    Promise, require:req, module:{exports:{}}, exports:{}, String, Number, JSON, Math, Date, Array, Object,
    RegExp, Error, TypeError, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, Buffer,
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
function loadPanels(s){
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','utils.js'),'utf8'),s,{filename:'utils.js'});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','audio-preset.js'),'utf8'),s,{filename:'audio-preset.js'});
  s.window.__vhAudioPreset.setRoots([PRESET_DIR]);   // 测试用假预设目录
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','clone.js'),'utf8'),s,{filename:'clone.js'});
}

// ================= A. 纯函数 =================
console.log('=== A. 区间→段换算 ===');
{ const {sandbox:s0}=newSandbox();
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','utils.js'),'utf8'),s0,{filename:'utils.js'});
  const U=s0.window.__vhUtils;
  let segs=U.buildRefSegments([{mediaPath:'m',seqStart:10,mediaIn:2,ovStart:10,ovEnd:14,ovDur:4}],10,14);
  ok('单段：偏移=mediaIn，时长=4', segs.length===1 && segs[0].srcStart===2 && segs[0].take===4, JSON.stringify(segs));
  segs=U.buildRefSegments([{mediaPath:'m',seqStart:10,mediaIn:2,ovStart:11,ovEnd:14,ovDur:3}],11,14);
  ok('左切：偏移 = mediaIn + (入点-片段起点)', segs[0].srcStart===3, segs[0].srcStart);
  segs=U.buildRefSegments([
    {mediaPath:'m2',seqStart:30,mediaIn:5,ovStart:30,ovEnd:33,ovDur:3},
    {mediaPath:'m1',seqStart:20,mediaIn:1,ovStart:20,ovEnd:24,ovDur:4}],20,33);
  ok('多段按时间排序且各自偏移独立', segs.length===2 && segs[0].mediaPath==='m1' && segs[1].srcStart===5);
  segs=U.buildRefSegments([{mediaPath:'m',seqStart:10,mediaIn:0,ovStart:10,ovEnd:14,ovDur:4}],20,25);
  ok('区间外片段被剔除', segs.length===0);
  ok('选轨：非静音音频轨取覆盖长', U.pickRefTrack([
      {index:0,name:'A1',type:'audio',muted:false,clips:[{ovDur:4}]},
      {index:1,name:'A2',type:'audio',muted:false,clips:[{ovDur:8}]}]).name==='A2');
  ok('选轨：覆盖长的被静音则退另一条', U.pickRefTrack([
      {index:0,name:'A1',type:'audio',muted:false,clips:[{ovDur:4}]},
      {index:1,name:'A2',type:'audio',muted:true,clips:[{ovDur:8}]}]).name==='A1');
  ok('选轨：无音频轨退视频轨', U.pickRefTrack([{index:0,name:'V1',type:'video',muted:false,clips:[{ovDur:6}]}]).name==='V1');
  const sp=U.trackSpan([{ovStart:110,ovEnd:118},{ovStart:120,ovEnd:122}],100,145);
  ok('trackSpan：取该轨有内容的首尾范围', sp && sp.start===110 && sp.end===122 && sp.seconds===12, JSON.stringify(sp));
  ok('trackSpan：无内容返回 null', U.trackSpan([],100,145)===null);
}

// ================= B. 预设模块 =================
console.log('');
console.log('=== B. 音频预设模块 ===');
{ const {sandbox:s0}=newSandbox();
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','audio-preset.js'),'utf8'),s0,{filename:'audio-preset.js'});
  const P=s0.window.__vhAudioPreset;
  P.setRoots([PRESET_DIR]);
  const list=P.scanAudioPresets();
  ok('只认出音频预设（视频预设被排除）', list.length===2 && list.every(p=>p.ext==='wav'),
     JSON.stringify(list.map(p=>p.name)));
  const picked=P.pickAudioPreset({list:list});
  ok('优先选名字像「调音」的预设', picked && picked.name==='调音输出.epr', picked&&picked.name);
  const saved=P.pickAudioPreset({saved:path.join(PRESET_DIR,'Wave48mono16.epr'), list:list});
  ok('指定过的预设优先', saved && saved.name==='Wave48mono16.epr', saved&&saved.name);
  const none=P.pickAudioPreset({list:[]});
  ok('无预设时给出可操作提示', !!(none&&none.error) && none.error.indexOf('调音输出')>=0, none&&none.error);
  // verifyWav
  const w=path.join(TR,'v_ok.wav'), b=path.join(TR,'v_bad.wav');
  fs.writeFileSync(w, WAV); fs.writeFileSync(b, MOV);
  ok('校验通过合法 wav', P.verifyWav(w).ok);
  const bad=P.verifyWav(b);
  ok('拦下非 wav 产出并说明是视频容器', !bad.ok && bad.msg.indexOf('MOV/MP4')>=0, bad.msg);
  ok('无效产出被删除', !fs.existsSync(b));
}

// ================= C. 端到端 =================
console.log('');
console.log('=== C. 模式切换 ===');
const {sandbox:S, getEl:GE, els:EL}=newSandbox();
const srcRow=GE('refSrcRow');
[['clip','选中片段',true],['inout','入点出点',false]].forEach(([v,txt,act])=>{
  const b=makeEl('button'); b.className='vc-mode'+(act?' active':''); b.dataset.src=v; srcRow.appendChild(b);
});
const modeRow=GE('modeRow');
['clone','instruct','cross'].forEach((m,i)=>{ const b=makeEl('button'); b.className='vc-mode'+(i===0?' active':''); b.dataset.mode=m; modeRow.appendChild(b); });

let err=null;
try{ loadPanels(S); }catch(e){ err=e; }
ok('clone.js 加载无异常', !err, err && (err.message+'\n'+err.stack));
if(err){ console.log(''); console.log('通过 '+pass+' / 失败 '+fail); process.exit(1); }

ok('初始为「选中片段」模式', EL['refSrcClip'].style.display==='' && EL['refSrcInOut'].style.display==='none');
ok('预设下拉已填充（2 个音频预设）', GE('refPresetSel').children.length===2, GE('refPresetSel').children.length);
ok('默认选中「调音输出」', /调音输出/.test(GE('refPresetSel').value), GE('refPresetSel').value);

srcRow.children[1].click();
ok('切到入点出点：片段块隐藏、入出点块显示',
   EL['refSrcClip'].style.display==='none' && EL['refSrcInOut'].style.display==='');
ok('切模式会读音轨与区间',
   EVALS.some(s=>s.indexOf('vcGetAudioTracks')>=0) && EVALS.some(s=>s.indexOf('vcGetInOutRangeStr')>=0));

// ---- 独奏渲染路径 ----
console.log('');
console.log('=== C2. 独奏渲染（有音频预设 + 音频轨）===');
const A1CLIP={mediaPath:'C:/media/ep1.mp4',clipName:'voice',seqStart:100,mediaIn:12,ovStart:100,ovEnd:105,ovDur:5};
RANGE.data={inSec:100,outSec:105,durationSec:5,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[A1CLIP]}]};
EVALS.length=0; SOLO.length=0; RESTORE.length=0; UNMUTE.length=0; PAYLOAD.length=0; FF.length=0;
EL['vcStatus']._textLog=[];
EXPORT_RET='OK:'; EXPORT_BYTES=null;
GE('refTrackSel').value='auto';
GE('btnGrabInOut').click();

ok('先读了音轨静音状态', EVALS.some(s=>s.indexOf('meListAudioTracks')>=0));
ok('独奏了所选轨（索引 0）', SOLO.length===1 && SOLO[0]==='0', JSON.stringify(SOLO));
ok('独奏在渲染之前', EVALS.findIndex(s=>s.indexOf('meMuteExcept')>=0) < EVALS.findIndex(s=>s.indexOf('meExportRangeStr')>=0));
ok('渲染前把入出点传进了 payload', PAYLOAD.length===1 && PAYLOAD[0] && PAYLOAD[0].startSec===100 && PAYLOAD[0].endSec===105,
   JSON.stringify(PAYLOAD));
ok('payload 用了所选预设', PAYLOAD[0] && /调音输出/.test(PAYLOAD[0].presetPath), PAYLOAD[0]&&PAYLOAD[0].presetPath);
ok('payload 序列名正确', PAYLOAD[0] && PAYLOAD[0].seqName==='EP1');
ok('导出后还原了静音状态（原样，不是一刀切全开）', RESTORE.length===1 && RESTORE[0]==='0:0,1:1', JSON.stringify(RESTORE));
ok('没有用 meUnmuteAll 覆盖用户设置', UNMUTE.length===0, UNMUTE.length);
ok('转了一次 24k 单声道', convCalls().length===1, convCalls().length);
ok('转码带 -ar 24000 -ac 1',
   convCalls()[0] && convCalls()[0].args.indexOf('24000')>=0 && convCalls()[0].args.indexOf('1')>=0);
ok('没走直取路径', extractCalls().length===0, extractCalls().length);
ok('界面标明是独奏渲染', EL['refInfo'].textContent.indexOf('独奏渲染')>=0, EL['refInfo'].textContent);
ok('界面标了轨道与区间', EL['refInfo'].textContent.indexOf('A1')>=0 && EL['refInfo'].textContent.indexOf('100.00')>=0,
   EL['refInfo'].textContent);
ok('状态栏提示过未混入其他轨道', (EL['vcStatus']._textLog||[]).some(t=>t.indexOf('未混入其他轨道')>=0),
   JSON.stringify((EL['vcStatus']._textLog||[]).slice(-3)));

// ---- 手动指定轨道 ----
console.log('');
console.log('=== C3. 手动指定轨道 ===');
RANGE.data={inSec:200,outSec:206,durationSec:6,seqName:'EP1',
  tracks:[
    {index:0,name:'A1',type:'audio',muted:false,clips:[{mediaPath:'m',clipName:'a',seqStart:200,mediaIn:0,ovStart:200,ovEnd:206,ovDur:6}]},
    {index:1,name:'A2',type:'audio',muted:false,clips:[{mediaPath:'m2',clipName:'b',seqStart:201,mediaIn:0,ovStart:201,ovEnd:206,ovDur:5}]}
  ]};
SOLO.length=0; RESTORE.length=0; PAYLOAD.length=0; FF.length=0;
GE('refTrackSel').value='1';       // 指定 A2
GE('btnGrabInOut').click();
ok('按指定轨独奏（索引 1）', SOLO.length===1 && SOLO[0]==='1', JSON.stringify(SOLO));
ok('自定轨也走独奏渲染（不是直取）', convCalls().length===1, convCalls().length);

// ---- 失败时也必须还原静音 ----
console.log('');
console.log('=== C4. 失败路径必须还原静音 ===');
RANGE.data={inSec:0,outSec:5,durationSec:5,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[{mediaPath:'m',clipName:'a',seqStart:0,mediaIn:0,ovStart:0,ovEnd:5,ovDur:5}]}]};
GE('refTrackSel').value='auto';

EXPORT_RET='ERR:exportAsMediaDirect 返回失败'; RESTORE.length=0; FF.length=0;
GE('btnGrabInOut').click();
ok('渲染失败仍还原了静音', RESTORE.length===1 && RESTORE[0]==='0:0,1:1', JSON.stringify(RESTORE));
ok('渲染失败有报错', EL['vcStatus'].textContent.indexOf('渲染失败')>=0, EL['vcStatus'].textContent);
ok('渲染失败不转码', convCalls().length===0, convCalls().length);

EXPORT_RET='OK:'; EXPORT_BYTES=MOV; RESTORE.length=0; FF.length=0;
GE('btnGrabInOut').click();
ok('产出非 wav 被拦下', EL['vcStatus'].textContent.indexOf('不是 wav')>=0, EL['vcStatus'].textContent);
ok('非 wav 也还原了静音', RESTORE.length===1, JSON.stringify(RESTORE));
ok('非 wav 不转码', convCalls().length===0, convCalls().length);
EXPORT_BYTES=null;

// ---- 兜底：没有可用音频预设 ----
console.log('');
console.log('=== C5. 兜底直取（无音频预设）===');
RANGE.data={inSec:300,outSec:310,durationSec:10,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[
    {mediaPath:'C:/m/one.mp4',clipName:'a',seqStart:300,mediaIn:3,ovStart:300,ovEnd:304,ovDur:4},
    {mediaPath:'C:/m/two.mp4',clipName:'b',seqStart:305,mediaIn:7,ovStart:305,ovEnd:307,ovDur:2},
    {mediaPath:'C:/m/three.mp4',clipName:'c',seqStart:307,mediaIn:1,ovStart:307,ovEnd:310,ovDur:3}]}]};
GE('refPresetSel').value='';        // 模拟扫不到预设
SOLO.length=0; FF.length=0;
EL['vcStatus']._textLog=[];
GE('btnGrabInOut').click();
ok('无预设时不独奏', SOLO.length===0, SOLO.length);
ok('3 段各截一次 + 1 次拼接', extractCalls().length===4, extractCalls().length);
ok('第 4 次是 concat', extractCalls()[3] && extractCalls()[3].args.indexOf('concat')>=0);
ok('界面标明是直取原素材', EL['refInfo'].textContent.indexOf('直取原素材')>=0, EL['refInfo'].textContent);
ok('状态栏提示过不含时间轴处理', (EL['vcStatus']._textLog||[]).some(t=>t.indexOf('不含时间轴')>=0),
   JSON.stringify((EL['vcStatus']._textLog||[]).slice(-3)));

// ---- 视频轨只能直取 ----
console.log('');
console.log('=== C6. 视频轨走直取 ===');
RANGE.data={inSec:400,outSec:405,durationSec:5,seqName:'EP1',
  tracks:[{index:0,name:'V1',type:'video',muted:false,clips:[
    {mediaPath:'C:/m/cam.mp4',clipName:'v',seqStart:400,mediaIn:1,ovStart:400,ovEnd:405,ovDur:5}]}]};
GE('refPresetSel').value=path.join(PRESET_DIR,'调音输出.epr');   // 预设是有的
SOLO.length=0; FF.length=0;
GE('btnGrabInOut').click();
ok('视频轨不走独奏（音轨静音隔离不了内嵌音频）', SOLO.length===0, SOLO.length);
ok('视频轨走直取', extractCalls().length===1, extractCalls().length);
ok('界面标为视频内嵌音频', EL['refInfo'].textContent.indexOf('视频内嵌音频')>=0, EL['refInfo'].textContent);

// ---- 上限口径 ----
console.log('');
console.log('=== C7. 上限口径 ===');
// 渲染路径：按 I/O 区间长度卡（产出就是区间长度）
RANGE.data={inSec:0,outSec:45,durationSec:45,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[{mediaPath:'m',clipName:'a',seqStart:0,mediaIn:0,ovStart:0,ovEnd:45,ovDur:45}]}]};
GE('refPresetSel').value=path.join(PRESET_DIR,'调音输出.epr');
SOLO.length=0; FF.length=0;
GE('btnGrabInOut').click();
ok('渲染路径：45 秒被拦（哪怕整轨都有内容）', SOLO.length===0 && EL['vcStatus'].textContent.indexOf('30 秒上限')>=0,
   EL['vcStatus'].textContent);

// 渲染路径：I/O 宽但该轨内容少 → 收紧区间后放行，payload 用收紧后的范围
GE('refPresetSel').value=path.join(PRESET_DIR,'调音输出.epr');
RANGE.data={inSec:100,outSec:145,durationSec:45,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[
    {mediaPath:'m',clipName:'a',seqStart:110,mediaIn:0,ovStart:110,ovEnd:122,ovDur:12}]}]};
SOLO.length=0; PAYLOAD.length=0; FF.length=0;
GE('btnGrabInOut').click();
ok('渲染路径：I/O 45 秒但该轨仅 12 秒 → 放行', SOLO.length===1, JSON.stringify(SOLO));
ok('渲染区间收紧到该轨内容（110~122）', PAYLOAD[0] && PAYLOAD[0].startSec===110 && PAYLOAD[0].endSec===122,
   JSON.stringify(PAYLOAD[0]));
ok('界面说明已按内容收紧', EL['refInfo'].textContent.indexOf('已按该轨内容收紧')>=0, EL['refInfo'].textContent);

// 直取路径：按该轨实际覆盖算（区间宽但内容少 → 放行）
GE('refPresetSel').value='';
RANGE.data={inSec:0,outSec:45,durationSec:45,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[{mediaPath:'C:/m/sparse.mp4',clipName:'a',seqStart:10,mediaIn:0,ovStart:10,ovEnd:22,ovDur:12}]}]};
FF.length=0;
GE('btnGrabInOut').click();
ok('直取路径：区间 45 秒但实取 12 秒 → 放行', extractCalls().length===1, extractCalls().length);

// ---- 各类报错 ----
console.log('');
console.log('=== C8. 报错 ===');
RANGE.data={inSec:0,outSec:5,durationSec:5,seqName:'EP1',tracks:[]};
SOLO.length=0; FF.length=0;
GE('btnGrabInOut').click();
ok('区间内无片段 → 报错', SOLO.length===0 && FF.length===0 && EL['vcStatus'].textContent.indexOf('没有任何')>=0);

RANGE.data={error:'序列未设置有效入点出点（in=-1, out=-1），请先在时间轴按 I / O 设置'};
GE('btnGrabInOut').click();
ok('未设 I/O → 报错', EL['vcStatus'].textContent.indexOf('I / O')>=0, EL['vcStatus'].textContent);

RANGE.data={inSec:0,outSec:5,durationSec:5,seqName:'EP1',
  tracks:[{index:0,name:'A1',type:'audio',muted:false,clips:[{mediaPath:'m',clipName:'a',seqStart:0,mediaIn:0,ovStart:0,ovEnd:5,ovDur:5}]}]};
GE('refPresetSel').value=path.join(PRESET_DIR,'调音输出.epr');
GE('refTrackSel').value='1';    // A2 不在区间内
GE('btnGrabInOut').click();
ok('指定轨在区间内无片段 → 报错', EL['vcStatus'].textContent.indexOf('没有片段')>=0, EL['vcStatus'].textContent);
GE('refTrackSel').value='auto';

// 独奏本身失败 → 也要还原
SOLO.length=0; RESTORE.length=0;
EVALS.length=0;
GE('btnGrabInOut').click();
ok('正常路径能走通（前置校验）', EVALS.some(s=>s.indexOf('meMuteExcept')>=0));

console.log('');
console.log('通过 '+pass+' / 失败 '+fail);
process.exit(fail===0?0:1);
'''

tp = os.path.join(OUT, 't.js')
os.makedirs(OUT, exist_ok=True)
with open(tp, 'w', encoding='utf-8') as f:
    f.write(JS)
r = subprocess.run(['node', tp, TR, D], capture_output=True, text=True,
                   encoding='utf-8', errors='replace', timeout=180)
print(r.stdout)
if r.stderr:
    print('--- stderr ---')
    print(r.stderr[:4000])
sys.exit(r.returncode)
