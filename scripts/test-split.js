/* 验证拖动分隔条的宽度计算、夹取、记忆逻辑 */
const fs = require('fs');
const path = require('path');

const ROOT = 'F:/OH-WorkSpace/plugins/vh-Atelier/com.vh.atelier';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

class El {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this.innerHTML = '';
    this.style = {
      _p: {},
      setProperty(k, v) { this._p[k] = v; },
      getPropertyValue(k) { return this._p[k] || ''; },
    };
    this.children = []; this._ev = {};
    this.classList = { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle() {}, contains(c) { return this._s.has(c); } };
    this._rect = { left: 0, width: 800 };
    this.getBoundingClientRect = () => this._rect;
    this.disabled = false; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this.tagName = 'DIV';
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { (this._ev[t] = this._ev[t] || []).push(f); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {} getAttribute() { return null; }
  fire(t, ev) { (this._ev[t] || []).forEach(f => f(ev || { target: this, preventDefault() {} })); }
}

const store = {};
const bodyEl = new El('body');
bodyEl.classList = { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle() {}, contains(c) { return this._s.has(c); } };

const docEvents = {};
global.document = {
  readyState: 'complete',
  body: bodyEl,
  getElementById(id) { return store[id] || null; },
  createElement(tag) { return new El(tag); },
  createTextNode(t) { const e = new El('#text'); e.textContent = t; return e; },
  addEventListener(t, f) { (docEvents[t] = docEvents[t] || []).push(f); },
  querySelector(sel) {
    if (sel.indexOf('.cx-layout') >= 0) return store['__layout'];
    return null;
  },
  querySelectorAll() { return []; },
};
global.window = { cep: { fs: {} } };
global.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem(k, v) { this._d[k] = String(v); },
};
global.CSInterface = function () { this.evalScript = (s, cb) => cb('ERR:stub'); };
global.require = (m) => {
  if (m === 'fs') return { existsSync: () => true, readFileSync: () => '', writeFileSync: () => {}, mkdirSync: () => {} };
  if (m === 'path') return { join: (...a) => a.join('/') };
  if (m === 'os') return { tmpdir: () => '/tmp' };
  if (m === 'child_process') return { exec: () => {} };
  throw new Error('unexpected require: ' + m);
};
global.window.__vhFlatten = { scan: () => ({ error: 'stub' }), flatten: () => ({ ok: false }) };

const NEED = ['panel-colorxml', 'cxSeq', 'cxRefreshSeq', 'cxReadSeq', 'cxStatus', 'cxTracks',
  'cxTracksWrap', 'cxSummary', 'cxSummaryRow', 'cxOutDir', 'cxOutBrowse', 'cxOutName',
  'cxGo', 'cxOpenOut', 'cxClearLog', 'cxLog', 'cxLogStat', 'cxDropTrans', 'cxAll', 'cxNone', 'cxSplit'];
for (const id of NEED) store[id] = new El(id);
store['__layout'] = new El('cx-layout');

let err = null;
try {
  const code = fs.readFileSync(path.join(ROOT, 'js', 'flatten-ui.js'), 'utf8');
  new Function('window', 'document', 'localStorage', 'CSInterface', 'require', 'Promise', code)(
    global.window, global.document, global.localStorage, global.CSInterface, global.require, Promise);
} catch (e) { err = e; }

console.log('=== 加载 ===');
console.log(err ? ('✗ ' + err.message) : '✓ 无错');
if (err) process.exit(1);

const layout = store['__layout'];
const split = store['cxSplit'];

console.log('\n=== 初始宽度（应恢复默认 46%）===');
console.log('  --cx-left-w =', layout.style.getPropertyValue('--cx-left-w'));

function dragTo(clientX) {
  split.fire('mousedown', { clientX: 400, preventDefault() {} });
  (docEvents['mousemove'] || []).forEach(f => f({ clientX, preventDefault() {} }));
  (docEvents['mouseup'] || []).forEach(f => f({ preventDefault() {} }));
  return layout.style.getPropertyValue('--cx-left-w');
}

console.log('\n=== 拖动测试（容器 left=0 width=800）===');
console.log('  拖到 x=200 →', dragTo(200), '(期望 25%)');
console.log('  拖到 x=400 →', dragTo(400), '(期望 50%)');
console.log('  拖到 x=560 →', dragTo(560), '(期望 70%)');
console.log('  拖到 x=20  →', dragTo(20), '(期望夹取到下限 22%)');
console.log('  拖到 x=790 →', dragTo(790), '(期望夹取到上限 78%)');

console.log('\n=== 记忆（localStorage）===');
console.log('  已存值:', localStorage.getItem('vh_cx_leftw'));

console.log('\n=== 双击恢复默认 ===');
split.fire('dblclick', { preventDefault() {} });
console.log('  回到:', layout.style.getPropertyValue('--cx-left-w'), '(期望 46%)');
console.log('  已存值:', localStorage.getItem('vh_cx_leftw'));

console.log('\n=== 拖动时的光标状态 ===');
split.fire('mousedown', { clientX: 400, preventDefault() {} });
console.log('  split 有 dragging 类:', split.classList.contains('cx-dragging'));
console.log('  body 有 resizing 类:', bodyEl.classList.contains('cx-resizing'));
(docEvents['mouseup'] || []).forEach(f => f({ preventDefault() {} }));
console.log('  松开后 dragging:', split.classList.contains('cx-dragging'),
  ' resizing:', bodyEl.classList.contains('cx-resizing'));
