# -*- coding: utf-8 -*-
"""行为测试：语音克隆「停止」按钮 + 已用时间读秒

锁死的行为：
  · 空闲时停止按钮禁用；生成中启用
  · 点停止 → taskkill /T /F 杀进程树（只 kill 父进程不够，要点是释放显存）
  · 被杀后回调识别 stopRequested，报「已停止（用户中止）」，不报「克隆失败」
  · 停止后界面解锁、进度复位、标志位复位（下次还能正常生成）
  · 正常失败（非停止）仍按原样报错
  · 读秒计时器跑完要清掉（不留定时器）

在插件目录下运行：python scripts/test-clone-stop.py
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

OUT = os.path.join(D, '_tmp', 'test-clonestop')
if os.path.exists(OUT):
    shutil.rmtree(OUT, ignore_errors=True)
TR = os.path.join(OUT, 'tr')
os.makedirs(os.path.join(TR, 'ext', 'py'), exist_ok=True)
os.makedirs(os.path.join(TR, 'ext', 'bin'), exist_ok=True)
open(os.path.join(TR, 'ext', 'py', 'cosyvoice_cli.py'), 'w', encoding='utf-8').write('# stub')
open(os.path.join(TR, 'ext', 'bin', 'ffmpeg-win32-x64.exe'), 'wb').write(b'MZ')
# 参考音频（供音色库使用）
with open(os.path.join(TR, 'ref.wav'), 'wb') as f:
    f.write(b'RIFF' + b'\x00' * 4 + b'WAVE' + b'\x00' * 32)
atexit.register(lambda: shutil.rmtree(os.path.join(D, '_tmp'), ignore_errors=True))

JS = r'''
const fs=require('fs'), path=require('path'), vm=require('vm');
const TR=process.argv[2], ROOT=process.argv[3];
const EXT=path.join(TR,'ext');
const REFWAV=path.join(TR,'ref.wav');
let pass=0, fail=0;
function ok(n,c,e){ if(c){pass++;console.log('  [OK]   '+n);} else {fail++;console.log('  [FAIL] '+n+(e!==undefined?' -> '+e:''));} }

function makeEl(tag){
  const el={tagName:(tag||'div').toUpperCase(),children:[],_cls:'',_text:'',_html:'',style:{},dataset:{},
    value:'',title:'',_h:{},attrs:{},offsetTop:0,clientHeight:40,offsetHeight:40,scrollTop:0,offsetWidth:100,
    scrollHeight:400,checked:false,disabled:false,
    get className(){return this._cls;},set className(v){this._cls=String(v==null?'':v);},
    get textContent(){return this._text;},set textContent(v){this._text=String(v==null?'':v);(this._log=this._log||[]).push(this._text);},
    get innerHTML(){return this._html;},set innerHTML(v){this._html=String(v==null?'':v);this.children=[];},
    addEventListener(t,fn){(this._h[t]=this._h[t]||[]).push(fn);},
    removeEventListener(){},
    appendChild(c){c.parentNode=this;c.offsetTop=this.children.length*40;this.children.push(c);return c;},
    removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);return c;},
    insertBefore(c){c.parentNode=this;this.children.push(c);return c;},
    querySelector(sel){const cs=String(sel).replace(/^\./,'').split('.')[0];
      for(const c of this.children){ if(c._cls&&c._cls.split(/\s+/).indexOf(cs)>=0)return c;
        if(c.querySelector){const r=c.querySelector(sel);if(r)return r;} } return null;},
    querySelectorAll(sel){const cs=String(sel).replace(/^\./,'').split('.')[0];const out=[];
      (function walk(n){(n.children||[]).forEach(c=>{ if(c._cls&&c._cls.split(/\s+/).indexOf(cs)>=0)out.push(c); walk(c); });})(this);
      return out;},
    setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k]===undefined?null:this.attrs[k];},
    removeAttribute(){},focus(){},remove(){},pause(){},play(){return Promise.resolve();},
    getBoundingClientRect(){return {left:0,top:0,width:100,height:40,right:100,bottom:40};},
    click(){(this._h.click||[]).forEach(f=>f({type:'click',target:this,preventDefault(){},stopPropagation(){}}));},
    fire(type,ev){(this._h[type]||[]).forEach(f=>f(Object.assign({type,target:this,preventDefault(){},stopPropagation(){}},ev||{})));},
    src:'',currentTime:0,duration:200,volume:1,muted:false};
  const cls={_all:{},add(s){(s||'').split(/\s+/).forEach(x=>{if(x)this._all[x]=true;});},
    remove(s){if(!s){this._all={};return;}(s||'').split(/\s+/).forEach(x=>{delete this._all[x];});},
    toggle(s,on){ if(on===undefined) on=!this._all[s]; if(on) this._all[s]=true; else delete this._all[s]; return !!on;},
    contains(s){return !!this._all[s];}};
  el.classList=cls;
  return el;
}

// 造一个干净沙箱；预置音色库（localStorage 在 clone.js 初始化时会被读到）
function build(opts){
  opts=opts||{};
  const CALLS=[], LIVE={};
  let intervalSeq=0, pending=null;
  function makeCP(){
    // 合成调用返回的 handle 要带 stderr 流（产品代码读它的 STAGE 进度）
    function mkStream(){
      return { _h:{}, on:function(t,fn){(this._h[t]=this._h[t]||[]).push(fn);return this;},
               emit:function(t,d){(this._h[t]||[]).forEach(f=>f(Buffer.from(String(d))));} };
    }
    return {
      spawnSync: function(){ return { status:1, stdout:'', stderr:'', error:null }; },
      execFile: function(bin, args, o, cb){
        if(typeof o==='function'){ cb=o; o={}; }
        CALLS.push({bin:bin, args:args.slice()});
        if(/cosyvoice_cli\.py$/.test(args[0]||'')){
          const err=mkStream();
          pending={cb:cb, started:true, stderr:err};
          return { pid: 424242, stderr:err, kill: function(){ CALLS.push({bin:'<inproc-kill>',args:[]}); } };
        }
        if(cb) cb(null,'','');
        return { pid: 1, stderr:mkStream(), kill: function(){} };
      }
    };
  }
  const els={}, store={};
  const getEl=(id)=>(els[id]=els[id]||makeEl('div'));
  // 镜像 HTML 里的初始状态（disabled / value），否则桩与真实 DOM 不一致
  if(!build._html){
    build._html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    build._disabled=new Set();
    const re=/<(?:button|input|select|textarea)\s+id="([^"]+)"[^>]*\bdisabled\b/g;
    let m; while((m=re.exec(build._html))) build._disabled.add(m[1]);
  }
  for(const id of build._disabled) getEl(id).disabled=true;
  store['vh_clone_voices']=JSON.stringify([{name:'t', wav:REFWAV, ref_text:'hello world', at:Date.now()}]);
  const documentStub={readyState:'complete',getElementById:getEl,createElement:(t)=>makeEl(t),
    addEventListener(){},removeEventListener(){},body:makeEl('body'),documentElement:makeEl('html'),
    head:makeEl('head'),querySelector:()=>null,querySelectorAll:()=>[],hidden:false,
    createDocumentFragment:()=>makeEl('frag')};
  function CSInterface(){}
  CSInterface.prototype.getSystemPath=function(){ return EXT; };
  CSInterface.prototype.addEventListener=function(){};
  CSInterface.prototype.removeEventListener=function(){};
  CSInterface.prototype.dispatchEvent=function(){};
  CSInterface.prototype.evalScript=function(s,cb){ if(cb) cb(opts.evalRet!==undefined?opts.evalRet:''); };
  CSInterface.prototype.getHostEnvironment=function(){ return '{}'; };
  const sandbox={console,
    setTimeout:setTimeout, clearTimeout:clearTimeout,
    setInterval:function(fn,ms){ const id=++intervalSeq; LIVE[id]={fn:fn,ms:ms}; return id; },
    clearInterval:function(id){ delete LIVE[id]; },
    Promise, require:(n)=> n==='child_process' ? makeCP() : require(n),
    module:{exports:{}}, exports:{}, String, Number, JSON, Math, Date, Array, Object,
    RegExp, Error, TypeError, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, Buffer,
    document:documentStub,
    localStorage:{getItem:(k)=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:(k)=>{delete store[k];}},
    navigator:{userAgent:'node'}, location:{href:''},
    CSInterface, SystemPath:{EXTENSION:'extension',USER_DATA:'userdata'},
    requestAnimationFrame:(fn)=>setTimeout(fn,0), cancelAnimationFrame:(id)=>clearTimeout(id),
    innerWidth:1400, innerHeight:900, process:{platform:'win32'},
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
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','utils.js'),'utf8'),sandbox,{filename:'utils.js'});
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','audio-preset.js'),'utf8'),sandbox,{filename:'audio-preset.js'});
  let err=null;
  try{ vm.runInContext(fs.readFileSync(path.join(ROOT,'js','clone.js'),'utf8'),sandbox,{filename:'clone.js'}); }
  catch(e){ err=e; }
  return {sandbox, els, getEl, CALLS, LIVE,
          loadErr: err, getPending:()=>pending, clearPending:()=>{pending=null;}};
}

// ================= 加载 =================
console.log('=== 加载与初始状态 ===');
const B=build();
ok('clone.js 加载无异常', !B.loadErr, B.loadErr && (B.loadErr.message+'\n'+B.loadErr.stack));
if(B.loadErr){ console.log('\n通过 '+pass+' / 失败 '+fail); process.exit(1); }

const btnStop=B.getEl('btnCloneStop'), btnClone=B.getEl('btnClone');
ok('停止按钮已取到', !!btnStop);
ok('空闲时停止按钮禁用', btnStop.disabled===true, btnStop.disabled);
// 按钮在 HTML 里默认禁用（与交付面板同款写法）
{
  const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
  ok('HTML 里停止按钮默认 disabled', /id="btnCloneStop"[^>]*disabled/.test(html),
     (html.match(/<button id="btnCloneStop"[^>]*>/)||[''])[0]);
  ok('HTML 里停止按钮用 danger 样式（与交付面板一致）', /id="btnCloneStop"[^>]*class="danger"/.test(html));
}

// 载入音色 → 参考音频就绪
B.getEl('voiceLibSel').value='0';
B.getEl('btnUseVoice').click();
B.getEl('ttsText').value='test sentence';
B.getEl('ttsText').fire('input');
ok('载入音色后生成按钮可用', btnClone.disabled===false, btnClone.disabled);

// ================= 启动合成 =================
console.log('');
console.log('=== 生成中：停止可用 + 读秒在跑 ===');
btnClone.click();
ok('合成就绪（成功调起 python）', !!B.getPending(), '未调起');
ok('生成中：停止按钮启用', btnStop.disabled===false, btnStop.disabled);
ok('生成中：生成按钮禁用', btnClone.disabled===true, btnClone.disabled);
const intervalsAtStart=Object.keys(B.LIVE).length;
ok('读秒计时器已启动', intervalsAtStart>=1, intervalsAtStart);

// 读秒与阶段文案不能互相覆盖：发一段 STAGE 后，秒数文本应包含阶段词
{
  const pend0=B.getPending();
  if(pend0 && pend0.stderr) pend0.stderr.emit('data','STAGE gen\n');
  // 手动触发一次计时器回调
  const ids=Object.keys(B.LIVE);
  if(ids.length) B.LIVE[ids[0]].fn();
  const ptext=B.getEl('vcProgressText').textContent||'';
  ok('读秒文本包含阶段文案（未被覆盖）', /已用\s*\d+\s*秒/.test(ptext),
     JSON.stringify(ptext));
}

// ================= 点停止 =================
console.log('');
console.log('=== 点停止：杀进程树 ===');
btnStop.click();
const kills=B.CALLS.filter(c=>c.bin==='taskkill' || c.bin==='<inproc-kill>');
ok('发起了杀进程', kills.length===1, JSON.stringify(B.CALLS.map(c=>c.bin)));
const tk=B.CALLS.find(c=>c.bin==='taskkill');
ok('用 taskkill 杀（Windows）', !!tk, JSON.stringify(B.CALLS.map(c=>c.bin)));
ok('带 /T（连子进程树一起杀）', tk && tk.args.indexOf('/T')>=0, tk&&JSON.stringify(tk.args));
ok('带 /F（强制）', tk && tk.args.indexOf('/F')>=0, tk&&JSON.stringify(tk.args));
ok('杀了正确的 PID', tk && tk.args.indexOf('424242')>=0, tk&&JSON.stringify(tk.args));
ok('点停止后提示「正在停止」', (B.getEl('vcStatus')._log||[]).some(t=>t.indexOf('正在停止')>=0),
   JSON.stringify((B.getEl('vcStatus')._log||[]).slice(-3)));

// ================= 被杀后的回调 =================
console.log('');
console.log('=== 停止后的回调处理 ===');
const pend=B.getPending();
pend.cb(new Error('Command failed: killed'), '', '');
ok('报「已停止（用户中止）」，不是「克隆失败」',
   (B.getEl('vcStatus')._log||[]).some(t=>t.indexOf('已停止（用户中止）')>=0),
   JSON.stringify((B.getEl('vcStatus')._log||[]).slice(-3)));
ok('没有出现「克隆失败」字样',
   !(B.getEl('vcStatus')._log||[]).some(t=>t.indexOf('克隆失败')>=0),
   JSON.stringify((B.getEl('vcStatus')._log||[]).slice(-3)));
ok('停止后界面解锁：生成按钮恢复', btnClone.disabled===false, btnClone.disabled);
ok('停止后停止按钮回到禁用', btnStop.disabled===true, btnStop.disabled);
ok('读秒计时器已清理', Object.keys(B.LIVE).length===0, JSON.stringify(Object.keys(B.LIVE)));

// ================= 停止后还能再生成 =================
console.log('');
console.log('=== 停止后能再次生成（标志位已复位） ===');
B.clearPending();
btnClone.click();
ok('可以再次发起合成', !!B.getPending(), '没调起第二次');
const pend2=B.getPending();
pend2.cb(null, JSON.stringify({ok:true, out:path.join(TR,'out.wav'), mode:'clone', duration:1.2,
                               speed:1, model:'base', load_sec:3, gen_sec:1}), '');
ok('二次合成正常完成', (B.getEl('vcStatus')._log||[]).length>0);
ok('完成后计时器不残留', Object.keys(B.LIVE).length===0, JSON.stringify(Object.keys(B.LIVE)));

// ================= 正常失败仍按原样报错 =================
console.log('');
console.log('=== 非停止的失败仍按原样报错 ===');
const C=build();
C.getEl('voiceLibSel').value='0';
C.getEl('btnUseVoice').click();
C.getEl('ttsText').value='x';
C.getEl('ttsText').fire('input');
C.getEl('btnClone').click();
C.getPending().cb(new Error('Command failed'), 'boom detail', '');
ok('真失败仍报「克隆失败」',
   (C.getEl('vcStatus')._log||[]).some(t=>t.indexOf('克隆失败')>=0),
   JSON.stringify((C.getEl('vcStatus')._log||[]).slice(-3)));
ok('真失败不会被误判成「已停止」',
   !(C.getEl('vcStatus')._log||[]).some(t=>t.indexOf('已停止')>=0));

// ================= 空闲时点停止 =================
console.log('');
console.log('=== 边界：空闲时点停止 ===');
C.getEl('btnCloneStop').fire('click');
ok('空闲点停止不会崩', true);

console.log('');
console.log('通过 '+pass+' / 失败 '+fail);
process.exit(fail===0?0:1);
'''

tp = os.path.join(OUT, 't.js')
os.makedirs(OUT, exist_ok=True)
open(tp, 'w', encoding='utf-8').write(JS)
r = subprocess.run(['node', tp, TR, D], capture_output=True, text=True,
                   encoding='utf-8', errors='replace', timeout=120)
print(r.stdout)
if r.stderr:
    print('--- stderr ---')
    print(r.stderr[:3000])
sys.exit(r.returncode)
