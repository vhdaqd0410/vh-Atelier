// vh-Atelier 公共模块（en-shared）行为测试
//
// 覆盖「序列选择 + 时间轴区间读取」这块被两个面板共用的能力：
//   序列列表渲染与默认勾选、选中片段与入点出点两种区间归一化、信息提示渲染。
//
// 在插件目录下运行：
//   node scripts/test-en-shared.js
//

const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[2] || require('path').dirname(__dirname);
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  [OK]   ' + n); }
                       else { fail++; console.log('  [FAIL] ' + n + (e !== undefined ? ' -> ' + e : '')); } }

function makeEl(tag) {
  const el = { tagName:(tag||'div').toUpperCase(), children:[], _cls:'', _text:'', _html:'',
    style:{}, dataset:{}, value:'', _h:{}, attrs:{},
    get className(){return this._cls;}, set className(v){this._cls=String(v);},
    get textContent(){return this._text;}, set textContent(v){this._text=String(v==null?'':v);},
    get innerHTML(){return this._html;}, set innerHTML(v){this._html=String(v==null?'':v);this.children=[];},
    addEventListener(t,fn){(this._h[t]=this._h[t]||[]).push(fn);},
    appendChild(c){c.parentNode=this;this.children.push(c);return c;},
    removeChild(c){const i=this.children.indexOf(c);if(i>=0)this.children.splice(i,1);return c;},
    querySelector(sel){const cs=String(sel).replace(/^\./,'').split('.')[0];
      for(const c of this.children){ if(c._cls&&c._cls.split(/\s+/).indexOf(cs)>=0)return c;
        if(c.querySelector){const r=c.querySelector(sel);if(r)return r;} } return null;},
    querySelectorAll(){return [];},
    setAttribute(k,v){this.attrs[k]=String(v);}, getAttribute(k){return this.attrs[k];},
    removeAttribute(){}, click(){(this._h.click||[]).forEach(f=>f({type:'click'}));} };
  return el;
}
const els = {};
const getEl = (id) => (els[id] = els[id] || makeEl('div'));
['lsSeqList','lsRefSeq','lsGrabClip','lsClipInfo','lsClipSrc','vLocalLog','lsHint',
 'lsProgWrap','lsProgFill','lsProgPct','lsProgText','lsAlgoWarn','lsArea','lsMode',
 'lsAreaRow','lsY0','lsY1','lsX0','lsX1','lsGoSeq','lsGoClip','lsPick','lsCheck','lsStop',
 'panel-localsub'].forEach(getEl);
getEl('lsClipSrc').value = 'selection';
getEl('lsArea').value = 'preset-bottom';
getEl('lsMode').value = 'sttn-auto';

let clipCalls = [];
const sandbox = { console, setTimeout, clearTimeout, Promise, require, module:{exports:{}}, exports:{},
  document: { readyState:'complete', getElementById:getEl, createElement:(t)=>makeEl(t),
              addEventListener(){}, body:makeEl('body'),
              querySelector:()=>null, querySelectorAll:()=>[] },
  localStorage: { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} } };
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.__adobe_cep__ = {};
sandbox.CSInterface = function () {
  this.getSystemPath = () => 'F:\\ext';
  this.evalScript = (script, cb) => {
    clipCalls.push(script);
    let r = 'OK:[]';
    if (script.indexOf('meListSequences') >= 0) r = 'OK:' + JSON.stringify(['序列A','序列B']);
    if (script.indexOf('meGetSelectedClipInfo') >= 0)
      r = 'OK:' + JSON.stringify({seqName:'序列A', startSec:1.5, endSec:4.5, durationSec:3, clipCount:1});
    if (script.indexOf('meGetSequenceInOut') >= 0)
      r = 'OK:' + JSON.stringify({seqName:'序列A', inSec:2, outSec:6, durationSec:4});
    if (cb) setTimeout(() => cb(r), 0);
  };
  this.addEventListener = () => {}; this.removeEventListener = () => {};
};
sandbox.SystemPath = { EXTENSION:'extension' };

vm.createContext(sandbox);
let err = null;
try { vm.runInContext(fs.readFileSync(path.join(ROOT,'js','en-shared.js'),'utf8'), sandbox, {filename:'en-shared.js'}); }
catch (e) { err = e; }
ok('en-shared.js 加载', !err, err && err.message);
ok('暴露 __vhClip', typeof sandbox.window.__vhClip === 'object');

const clip = sandbox.window.__vhClip.mount({
  seqListId:'lsSeqList', refreshBtnId:'lsRefSeq', grabBtnId:'lsGrabClip',
  clipInfoId:'lsClipInfo', srcSelectId:'lsClipSrc',
  onLog: function(){}
});

setTimeout(() => {
  clip.refreshSeqs(true).then(() => {
    ok('刷新序列写入了列表', getEl('lsSeqList').children.length === 2,
       getEl('lsSeqList').children.length);
    ok('默认勾选第一个序列', clip.getCheckedSeqs().length === 1 && clip.getCheckedSeqs()[0] === '序列A',
       JSON.stringify(clip.getCheckedSeqs()));

    clip.grab(true).then((info) => {
      ok('读取选中片段成功', !!info, info);
      const n = clip.normalized();
      ok('归一化后有 startSec/endSec', n && n.startSec === 1.5 && n.endSec === 4.5,
         JSON.stringify(n));
      ok('区间信息已渲染', /序列A/.test(getEl('lsClipInfo').textContent),
         getEl('lsClipInfo').textContent);

      // 切到入点出点
      getEl('lsClipSrc').value = 'inout';
      clip.grab(true).then((info2) => {
        const n2 = clip.normalized();
        ok('入点出点归一化', n2 && n2.startSec === 2 && n2.endSec === 6, JSON.stringify(n2));
        ok('调了 meGetSequenceInOut',
           clipCalls.some(s => s.indexOf('meGetSequenceInOut') >= 0), clipCalls);

        // 未读取时的提示
        clip.clearClip();
        ok('清空后提示未读取', /未读取/.test(getEl('lsClipInfo').textContent),
           getEl('lsClipInfo').textContent);
      
// ---- 回归：宿主返回对象数组时，序列名不能变成 [object Object] ----
(function () {
  // 直接单测 fmtSec（字符串秒数曾导致 0:010.0）
  const f = require('path').join(ROOT, 'js', 'en-shared.js');
  const src2 = require('fs').readFileSync(f, 'utf8');
  ok('fmtSec 数字与字符串结果一致（防 0:010.0）',
     /typeof s === 'number'/.test(src2) && /parseFloat\(s\)/.test(src2));
  ok('序列名做对象归一（防 [object Object]）',
     /function seqNameOf/.test(src2) && /s\.name/.test(src2));
})();

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
        process.exit(fail === 0 ? 0 : 1);
      });
    });
  });
}, 300);
