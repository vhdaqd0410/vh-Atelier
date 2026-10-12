# -*- coding: utf-8 -*-
"""行为测试：剧本面板「选中即弹复制菜单 + 按标点断句复制」

A 纯函数：splitSentences / splitByComma / halfAround（断句、保标点、边界）
B 真实渲染：Chrome 里挂载剧本阅读器结构，模拟选中 → 菜单出现 → 断言菜单项与点击复制内容

在插件目录下运行：python scripts/test-script-copy.py
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
assert os.path.isfile(os.path.join(D, 'js', 'script.js')), '插件目录不对: ' + D

OUT = os.path.join(D, '_tmp', 'test-scriptcopy')
if os.path.exists(OUT):
    shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)
atexit.register(lambda: shutil.rmtree(os.path.join(D, '_tmp'), ignore_errors=True))

JS = r'''
const fs=require('fs'), path=require('path'), vm=require('vm');
const ROOT=process.argv[2];
let pass=0, fail=0;
function ok(n,c,e){ if(c){pass++;console.log('  [OK]   '+n);} else {fail++;console.log('  [FAIL] '+n+(e!==undefined?' -> '+e:''));} }

// ================= A. 纯函数 =================
console.log('=== A. 断句纯函数 ===');
const {sandbox:s0}=(()=>{
  const sandbox={console, require:require, String, Number, JSON, Math, Date, Array, Object, RegExp, Error,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent};
  sandbox.window=sandbox; sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT,'js','utils.js'),'utf8'),sandbox,{filename:'utils.js'});
  return {sandbox};
})();
const U=s0.window.__vhUtils;
ok('utils 暴露 splitSentences', typeof U.splitSentences==='function');
ok('utils 暴露 splitByComma', typeof U.splitByComma==='function');
ok('utils 暴露 halfAround', typeof U.halfAround==='function');

// 按句末标点断句，标点保留在前句
let r=U.splitSentences('你疯了吗？我不会答应的。别再说了！');
ok('按 。！？ 断成 3 句', r.length===3, JSON.stringify(r.map(x=>x.text)));
ok('标点保留在句尾', r[0].text==='你疯了吗？' && r[1].text==='我不会答应的。' && r[2].text==='别再说了！',
   JSON.stringify(r.map(x=>x.text)));

// 英文标点
r=U.splitSentences('I love you. Do you hear me? Yes!');
ok('英文句末标点同样断句', r.length===3, JSON.stringify(r.map(x=>x.text)));

// 连续标点归一句
r=U.splitSentences('真的吗？！不可能……');
ok('连续标点并到同句末', r.length===2 && r[0].text==='真的吗？！', JSON.stringify(r.map(x=>x.text)));

// 无句末标点但有逗号 → 按逗号切（供前半/后半）
r=U.splitSentences('我爱你，但我不确定，你能明白吗');
ok('只有逗号时按逗号切', r.length===3 && r[0].text==='我爱你，', JSON.stringify(r.map(x=>x.text)));

// 单句无标点
r=U.splitSentences('我爱你');
ok('无标点只有一句', r.length===1 && r[0].text==='我爱你', JSON.stringify(r.map(x=>x.text)));

// 空 / null
ok('空串返回空数组', U.splitSentences('').length===0);
ok('null 返回空数组', U.splitSentences(null).length===0);

// start/end 下标可回指原串
r=U.splitSentences('甲乙。丙丁。');
ok('start/end 能回指原串', r[0].text===('甲乙。丙丁。').slice(r[0].start,r[0].end),
   JSON.stringify(r[0]));

// halfAround：以中间为界取前半/后半
let h=U.halfAround('我爱你，但我不确定', 3);
ok('halfAround 取到前半（含标点）', h.hasHead && h.head==='我爱你，', JSON.stringify(h));
ok('halfAround 取到后半', h.hasTail && h.tail==='但我不确定', JSON.stringify(h));
h=U.halfAround('我爱你', 2);
ok('无标点时前后半都为空', !h.hasHead && !h.hasTail, JSON.stringify(h));
h=U.halfAround('前半句。后半句', 2);
ok('以句号切前后半', h.head==='前半句。' && h.tail==='后半句', JSON.stringify(h));

// ================= B. 真实渲染 =================
console.log('');
console.log('=== B. 真实渲染：选中 → 菜单 → 复制 ===');
const CHROME=[
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
const chrome=CHROME.find(c=>fs.existsSync(c));
if(!chrome){ console.log('  （未找到 Chrome/Edge，跳过真实渲染部分）'); console.log(''); console.log('通过 '+pass+' / 失败 '+fail); process.exit(fail===0?0:1); }

const COPYFILE=path.join(ROOT,'_tmp','test-scriptcopy','copied.txt');
try{ try{fs.unlinkSync(COPYFILE);}catch(e){} }catch(e){}

// 抽出 script.js 里与选中菜单有关的那一段（避免整包加载带来的 CEP 依赖）
const sj=fs.readFileSync(path.join(ROOT,'js','script.js'),'utf8');
const start=sj.indexOf('// ---------- 字幕快替（方案B）：时间轴上选中的字幕块 ----------');
// 注意：段起点取「选中即弹复制菜单」处，不要往前扩到「字幕快替」段——
// 那段含 new CSInterface()，页面里没有该构造会直接抛错、整段注入失败。
const end=sj.indexOf('// 事件委托：复制 + 单句翻译');
if(start<0||end<=start){ console.log('  [FAIL] 取不到菜单代码段'); console.log('通过 '+pass+' / 失败 '+fail); process.exit(1); }
const menuCode=sj.slice(start,end);
// 取出菜单 CSS（在 style 注入里）
const cssM=sj.match(/\.scr-selmenu\{[^']*/);
const menuCss=cssM?cssM[0]:'';

const utilsSrc=fs.readFileSync(path.join(ROOT,'js','utils.js'),'utf8');

const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:20px;background:#181818;color:#ddd;font-family:"Microsoft YaHei",sans-serif;}
.scr-dlg{margin:3px 0;padding:2px 4px;position:relative;}
${menuCss}
</style></head><body>
<div class="scr-dlg" data-role="林辰" data-speech="你疯了吗？我不会答应的。别再说了！">
  <span class="scr-role" style="color:#ffb347;font-weight:700;">林辰</span>
  <span style="color:#8a7a6a;"> : </span>
  <span class="scr-sp" style="color:#ff9090;">你疯了吗？我不会答应的。别再说了！</span>
  <span class="scr-copy">⧉</span>
</div>
<div class="scr-dlg" data-role="苏挽" data-speech="我爱你，但我不确定，你能明白吗">
  <span class="scr-role" style="color:#ffb347;font-weight:700;">苏挽</span>
  <span style="color:#8a7a6a;"> : </span>
  <span class="scr-sp" style="color:#ff9090;">我爱你，但我不确定，你能明白吗</span>
  <span class="scr-copy">⧉</span>
</div>
<script>
window.__copied=[];
window.__copyText=function(t){ window.__copied.push(String(t)); window.__lastCopy=String(t); };
window.__copyFlash=function(){};
window.__SCR_EOF=1;
</script>
<script src="utils.js"></script>
<script>
${menuCode}
bindSelMenu();
window.__testDone=true;
</script>
</body></html>`;

const tmp=path.join(ROOT,'_tmp','test-scriptcopy');
fs.writeFileSync(path.join(tmp,'utils.js'), utilsSrc, 'utf8');
fs.writeFileSync(path.join(tmp,'t.html'), html, 'utf8');

const RUNNER=`<!DOCTYPE html><html><body><script>
// 通过 Chrome 的 --dump-dom 无法交互；改为在页面内直接模拟选择并触发 mouseup
window.addEventListener('load',function(){
  setTimeout(function(){
    var dlgs=document.querySelectorAll('.scr-dlg');
    var sp=dlgs[0].querySelector('.scr-sp');
    var tn=sp.firstChild;
    var r=document.createRange();
    r.setStart(tn,0); r.setEnd(tn,4);           // 选中「你疯了吗」
    var s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    setTimeout(function(){
      var menu=document.querySelector('.scr-selmenu');
      var out={menuShown:!!menu, items:[], copiedBefore:0};
      if(menu){
        menu.querySelectorAll('.it').forEach(function(b){
          out.items.push((b.querySelector('.k')?b.querySelector('.k').textContent:'')+'='+
                         (b.querySelector('.t')?b.querySelector('.t').textContent:''));
        });
        // 点第一项（复制选中）
        menu.querySelectorAll('.it')[0].click();
        out.afterFirstClick=window.__lastCopy||'';
        // 再开一次菜单，点「前半」或列表里的句子
        var s2=window.getSelection(); s2.removeAllRanges(); s2.addRange(r);
        document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
        setTimeout(function(){
          var m2=document.querySelector('.scr-selmenu');
          out.menuShown2=!!m2;
          if(m2){
            var its=m2.querySelectorAll('.it');
            out.items2=[];
            its.forEach(function(b){ out.items2.push((b.querySelector('.k')?b.querySelector('.k').textContent:'')+
              '='+(b.querySelector('.t')?b.querySelector('.t').textContent:'')); });
            // 点含「半」或数字序号的那一项
            for(var i=0;i<its.length;i++){
              var k=its[i].querySelector('.k');
              if(k && /[12]|前半|后半/.test(k.textContent)){ its[i].click(); out.afterHalfClick=window.__lastCopy||''; break; }
            }
          }
          out.allCopied=window.__copied.slice();
          var pre=document.createElement('pre'); pre.id='__probe';
          pre.textContent=JSON.stringify(out); document.body.appendChild(pre);
        },200);
      } else {
        var pre=document.createElement('pre'); pre.id='__probe';
        pre.textContent=JSON.stringify(out); document.body.appendChild(pre);
      }
    },300);
  },400);
});
</script></body></html>`;

// 把 runner 逻辑直接并进测试页（追加脚本）
const finalHtml = html.replace('</body>', `<script>
window.addEventListener('load',function(){
  setTimeout(function(){
    try{
      var dlgs=document.querySelectorAll('.scr-dlg');
      var sp=dlgs[0].querySelector('.scr-sp');
      var tn=sp.firstChild;
      var r=document.createRange(); r.setStart(tn,0); r.setEnd(tn,4);
      var s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      setTimeout(function(){
        var out={};
        var menu=document.querySelector('.scr-selmenu');
        out.menuShown=!!menu; out.items=[];
        if(menu){
          menu.querySelectorAll('.it').forEach(function(b){
            var k=b.querySelector('.k'), t=b.querySelector('.t');
            out.items.push((k?k.textContent:'')+'='+(t?t.textContent:''));
          });
          menu.querySelectorAll('.it')[0].click();
          out.afterCopySelected=window.__lastCopy||'';
          var s2=window.getSelection(); s2.removeAllRanges(); s2.addRange(r);
          document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
          setTimeout(function(){
            var m2=document.querySelector('.scr-selmenu');
            out.menuShown2=!!m2; out.items2=[];
            if(m2){
              var its=m2.querySelectorAll('.it');
              its.forEach(function(b){ var k=b.querySelector('.k'),t=b.querySelector('.t');
                out.items2.push((k?k.textContent:'')+'='+(t?t.textContent:'')); });
              for(var i=0;i<its.length;i++){
                var k=its[i].querySelector('.k');
                if(k && /^(1\\.|前半|整句)/.test(k.textContent)){ its[i].click(); out.afterListClick=window.__lastCopy||''; break; }
              }
            }
            out.allCopied=window.__copied.slice();
            // 再验：双击台词行直接复制整句
            out.dblBound = !!window.__scrDblCopyBound;
            window.__lastCopy='';
            var dlgs2=document.querySelectorAll('.scr-dlg');
            dlgs2[0].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
            out.afterDblClick = window.__lastCopy||'';
            var pre=document.createElement('pre'); pre.id='__probe';
            pre.textContent=JSON.stringify(out); document.body.appendChild(pre);
          },250);
        } else {
          var pre=document.createElement('pre'); pre.id='__probe';
          pre.textContent=JSON.stringify(out); document.body.appendChild(pre);
        }
      },350);
    }catch(e){
      var pre=document.createElement('pre'); pre.id='__probe';
      pre.textContent=JSON.stringify({err:String(e&&e.message||e)}); document.body.appendChild(pre);
    }
  },500);
});
</script></body>`);
fs.writeFileSync(path.join(tmp,'t.html'), finalHtml, 'utf8');

const url='file:///'+path.join(tmp,'t.html').replace(/\\/g,'/');
const res=require('child_process').spawnSync(chrome,
  ['--headless=new','--disable-gpu','--no-sandbox','--virtual-time-budget=6000','--dump-dom',url],
  {encoding:'utf8',maxBuffer:40*1024*1024,timeout:120000});
const dom=res.stdout||'';
const pm=dom.match(/<pre id="__probe">([\s\S]*?)<\/pre>/);
if(!pm){ console.log('  [FAIL] 取不到渲染探针结果'); console.log('  stderr:', String(res.stderr||'').slice(0,300));
  console.log(''); console.log('通过 '+pass+' / 失败 '+fail); process.exit(1); }
const d=JSON.parse(pm[1]);
if(d.err){ console.log('  [FAIL] 页面内报错: '+d.err); }
ok('选中后菜单出现', d.menuShown===true, JSON.stringify(d));
ok('菜单有「复制选中」项', (d.items||[]).some(x=>x.indexOf('复制选中')>=0), JSON.stringify(d.items));
ok('菜单按标点给出断句项（句子列表或前半/后半）',
   (d.items||[]).some(x=>/1\\.=.+？/.test(x)) || (d.items||[]).some(x=>x.indexOf('前半')>=0),
   JSON.stringify(d.items));
ok('点「复制选中」复制到的是选中的文字', d.afterCopySelected==='你疯了吗', JSON.stringify(d.afterCopySelected));
ok('菜单含整句/整行选项', (d.items||[]).some(x=>x.indexOf('整句')>=0||x.indexOf('整行')>=0)
   || (d.items2||[]).some(x=>x.indexOf('整句')>=0||x.indexOf('整行')>=0),
   JSON.stringify([d.items,d.items2]));
ok('第二次选中同样弹菜单', d.menuShown2===true);
ok('点列表项能复制到对应句子', !!d.afterListClick, JSON.stringify(d.afterListClick));
ok('复制历史记录了多次', (d.allCopied||[]).length>=2, JSON.stringify(d.allCopied));
ok('菜单有双击复制的说明（绑定已生效）', d.dblBound===true, JSON.stringify(d.dblBound));
ok('双击台词行直接复制整句', d.afterDblClick==='你疯了吗？我不会答应的。别再说了！', JSON.stringify(d.afterDblClick));

// ================= C. 菜单不遮挡当前台词行（多视口） =================
console.log('');
console.log('=== C. 菜单避让当前台词行 ===');
const POS_ANCHOR_OK = !!menuCode.match(/三档避让|菜单挂到「整条台词行」/);
ok('定位逻辑含避让实现', POS_ANCHOR_OK);

function measure(W,H){
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:16px;background:#181818;color:#ddd;font-family:"Microsoft YaHei",sans-serif;}
  .scr-dlg{margin:3px 0;padding:2px 4px;position:relative;}
  ${menuCss}
  </style></head><body>
  <div class="scr-dlg" data-role="林辰" data-speech="你疯了吗？我不会答应的。别再说了！">
    <span class="scr-sp">你疯了吗？我不会答应的。别再说了！</span></div>
  <div class="scr-dlg" data-role="苏挽" data-speech="第二行">
    <span class="scr-sp">第二行</span></div>
  <script>window.__copyText=function(){};window.__copyFlash=function(){};
function CSInterface(){this.evalScript=function(c,cb){if(cb)cb('');};}</script>
  <script>${utilsSrc}<\/script>
  <script>${menuCode} bindSelMenu();<\/script>
  <script>
  window.addEventListener('load',function(){setTimeout(function(){
    var sp=document.querySelectorAll('.scr-sp')[0], tn=sp.firstChild;
    var rr=document.createRange(); rr.setStart(tn,0); rr.setEnd(tn,4);
    var s=window.getSelection(); s.removeAllRanges(); s.addRange(rr);
    document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    setTimeout(function(){
      var dlg=document.querySelectorAll('.scr-dlg')[0];
      var menu=document.querySelector('.scr-selmenu');
      function rc(e){var b=e.getBoundingClientRect();return {t:b.top,b:b.bottom};}
      var o={ shown:!!menu };
      if(menu){ var a=rc(dlg), m=rc(menu);
        o.overlap = !(m.t >= a.b - 0.5 || m.b <= a.t + 0.5); }
      var pre=document.createElement('pre');pre.id='__p2';pre.textContent=JSON.stringify(o);document.body.appendChild(pre);
    },320);
  },320);});
  <\/script></body></html>`;
  const f=path.join(ROOT,'_tmp','test-scriptcopy','m'+W+'.html');
  fs.writeFileSync(f,page,'utf8');
  const r=require('child_process').spawnSync(chrome,
    ['--headless=new','--disable-gpu','--no-sandbox','--window-size='+W+','+H,
     '--virtual-time-budget=4000','--dump-dom','file:///'+f.replace(/\\/g,'/')],
    {encoding:'utf8',maxBuffer:40*1024*1024,timeout:120000});
  const mm=String(r.stdout||'').match(/<pre id="__p2">([\s\S]*?)<\/pre>/);
  if(!mm) return null;
  return JSON.parse(mm[1]);
}
[[560,360],[1100,700]].forEach(function(wh){
  const o=measure(wh[0],wh[1]);
  if(!o){ ok('视口 '+wh[0]+'x'+wh[1]+' 测量成功', false, '无探针'); return; }
  ok('视口 '+wh[0]+'x'+wh[1]+' 菜单出现', o.shown===true);
  ok('视口 '+wh[0]+'x'+wh[1]+' 菜单不遮当前行', o.overlap===false, JSON.stringify(o));
});

console.log('');
console.log('通过 '+pass+' / 失败 '+fail);
process.exit(fail===0?0:1);
'''

tp = os.path.join(OUT, 't.js')
open(tp, 'w', encoding='utf-8').write(JS)
r = subprocess.run(['node', tp, D], capture_output=True, text=True,
                   encoding='utf-8', errors='replace', timeout=240)
print(r.stdout)
if r.stderr:
    print('--- stderr ---')
    print(r.stderr[:3000])
sys.exit(r.returncode)
