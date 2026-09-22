/* 用最小 DOM stub 跑 flatten-ui.js，验证绑定逻辑无运行时错误 */
const fs = require('fs');
const path = require('path');

const ROOT = 'F:/OH-WorkSpace/plugins/vh-Atelier/com.vh.atelier';
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 收集 HTML 里所有 id
const ids = new Set();
for (const m of html.matchAll(/id="([^"]+)"/g)) ids.add(m[1]);

// ---- 极简 DOM stub ----
class El {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this.innerHTML = '';
    this.style = {}; this.children = []; this._ev = {};
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
    this.disabled = false; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this.tagName = 'DIV';
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { (this._ev[t] = this._ev[t] || []).push(f); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {} getAttribute() { return null; }
  fire(t) { (this._ev[t] || []).forEach(f => f({ target: this })); }
}
const store = {};
global.document = {
  readyState: 'complete',
  getElementById(id) { return store[id] || null; },
  createElement(tag) { return new El(tag); },
  createTextNode(t) { const e = new El('#text'); e.textContent = t; return e; },
  addEventListener() {},
  querySelectorAll() { return []; },
};
global.window = { cep: { fs: {} } };
global.localStorage = {
  getItem(k) { return store['_ls_' + k] || null; },
  setItem(k, v) { store['_ls_' + k] = v; },
};
global.CSInterface = function () { this.evalScript = (s, cb) => cb('ERR:stub'); };
global.Promise = Promise;

// 只创建 flatten-ui.js 需要的那几个元素（其余保持 null，代码里有判空）
const NEED = ['panel-colorxml', 'cxSeq', 'cxRefreshSeq', 'cxReadSeq', 'cxStatus', 'cxTracks',
  'cxTracksWrap', 'cxSummary', 'cxSummaryRow', 'cxOutDir', 'cxOutBrowse', 'cxOutName',
  'cxGo', 'cxOpenOut', 'cxClearLog', 'cxLog', 'cxLogStat', 'cxDropTrans', 'cxAll', 'cxNone'];
for (const id of NEED) store[id] = new El(id);

// require stub
global.require = (m) => {
  if (m === 'fs') return { existsSync: () => true, readFileSync: () => '', writeFileSync: () => {}, mkdirSync: () => {} };
  if (m === 'path') return { join: (...a) => a.join('/'), };
  if (m === 'os') return { tmpdir: () => '/tmp' };
  if (m === 'child_process') return { exec: () => {} };
  throw new Error('unexpected require: ' + m);
};

// 提供 window.__vhFlatten
global.window.__vhFlatten = {
  scan: () => ({ error: 'stub' }),
  flatten: () => ({ ok: false, msg: 'stub' }),
};

let err = null;
try {
  const code = fs.readFileSync(path.join(ROOT, 'js', 'flatten-ui.js'), 'utf8');
  // 在函数作用域里执行，模拟浏览器 IIFE
  new Function('window', 'document', 'localStorage', 'CSInterface', 'require', 'Promise', code)(
    global.window, global.document, global.localStorage, global.CSInterface, global.require, Promise);
} catch (e) {
  err = e;
}

console.log('=== flatten-ui.js 加载 ===');
console.log(err ? ('✗ 运行时报错: ' + err.message) : '✓ 加载无错');

// 检查绑定的回调
console.log('\n=== 事件绑定 ===');
for (const id of ['cxRefreshSeq', 'cxReadSeq', 'cxGo', 'cxOutBrowse', 'cxAll', 'cxNone', 'cxClearLog']) {
  const e = store[id];
  // onclick 是属性赋值，addEventListener 才进 _ev，两者都算
  const hasOnclick = e && typeof e.onclick === 'function';
  const evs = e && e._ev ? Object.keys(e._ev) : [];
  const ok = hasOnclick || evs.length;
  console.log('  ' + id.padEnd(14) +
    (ok ? ('已绑定 [' + (hasOnclick ? 'onclick ' : '') + evs.join('/') + ']') : '未绑定'));
}
// 用 addEventListener 的三处
for (const id of ['cxSeq', 'cxOutName', 'cxDropTrans']) {
  const e = store[id];
  const evs = e && e._ev ? Object.keys(e._ev) : [];
  console.log('  ' + id.padEnd(14) + (evs.length ? ('已绑定 [' + evs.join('/') + ']') : '未绑定'));
}

console.log('\n=== 初始日志 ===');
const logEl = store['cxLog'];
console.log('  日志条数:', logEl.children.length);
console.log('  统计文字:', store['cxLogStat'] ? store['cxLogStat'].textContent : '(无)');
const first = logEl.children[0];
if (first) {
  console.log('  首条 class:', first.className);
  console.log('  首条内容:', first.children.map(c => c.textContent).join('') +
    ' ' + (first.children.length ? '' : ''));
}

console.log('\n=== 文件名自动填充测试 ===');
// 模拟：选序列 → change 事件 → 应自动填「序列名-调色」
store['cxSeq'].value = '51';
store['cxSeq'].fire('change');
console.log('  选 51 后文件名 =', JSON.stringify(store['cxOutName'].value));
store['cxSeq'].value = '48 - 简化';
store['cxSeq'].fire('change');
console.log('  换 48 后文件名 =', JSON.stringify(store['cxOutName'].value));
// 用户手动改过之后，不再自动覆盖
store['cxOutName'].value = '我的名字';
store['cxOutName'].fire('input');
store['cxSeq'].value = '99';
store['cxSeq'].fire('change');
console.log('  手动改过后再换序列 =', JSON.stringify(store['cxOutName'].value), '(应保持“我的名字”)');

console.log('\n=== 全局导出 ===');
console.log('  __vhColorXmlOnShow:', typeof window.__vhColorXmlOnShow);

process.exit(err ? 1 : 0);
