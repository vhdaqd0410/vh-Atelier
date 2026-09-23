/* 用 DOM stub 验证 clip-select.js：拖选、单击区分、按钮回调、清除 */
const fs = require('fs');
const path = require('path');

const ROOT = 'F:/OH-WorkSpace/plugins/vh-Atelier/com.vh.atelier';
const code = fs.readFileSync(path.join(ROOT, 'js', 'clip-select.js'), 'utf8');

class El {
  constructor(cls) {
    this.className = cls || '';
    this.style = { setProperty() {}, getPropertyValue() { return ''; }, };
    this.children = [];
    this._ev = {};
    this._rect = { left: 0, width: 400, top: 0, height: 32 };
    this.getBoundingClientRect = () => this._rect;
    this.textContent = '';
    this.title = '';
    this.__clipSel = null;
  }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f, cap) { (this._ev[t] = this._ev[t] || []).push({ f, cap: !!cap }); }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  closest(sel) { return null; }
  fire(t, ev) { (this._ev[t] || []).forEach(h => h.f(ev)); }
  fireCap(t, ev) { (this._ev[t] || []).filter(h => h.cap).forEach(h => h.f(ev)); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const docEvents = {};
global.window = {};
global.document = {
  createElement(tag) { return new El(); },
  addEventListener(t, f) { (docEvents[t] = docEvents[t] || []).push(f); },
};

new Function('window', 'document', code)(global.window, global.document);

console.log('=== 1. 模块导出 ===');
console.log('  __vhClipSel:', typeof global.window.__vhClipSel);

const waveEl = new El('wave');
let lastSend = null, lastChange = null, clearCount = 0;
let DURATION = 10;

const api = global.window.__vhClipSel.attach({
  waveEl: waveEl,
  getDuration: () => DURATION,
  onSend: (a, b) => { lastSend = [a, b]; },
  onChange: (a, b) => { lastChange = [a, b]; },
  onClear: () => { clearCount++; },
});
console.log('  attach 返回:', api ? 'api对象' : 'null');
console.log('  waveEl 上挂 api:', !!waveEl.__clipSel);

console.log('\n=== 2. 单击（位移<4px）应视为点击播放，不产生选区 ===');
waveEl.fireCap('mousedown', { button: 0, clientX: 100, clientY: 10, target: null, preventDefault() {}, stopPropagation() {} });
docEvents['mousemove'].forEach(f => f({ clientX: 101, clientY: 10 }));   // 位移 1px
docEvents['mouseup'].forEach(f => f({}));
console.log('  选区:', api.getRange(), '(期望 null)');
console.log('  onChange 是否被调用:', lastChange !== null, '(期望 false)');

console.log('\n=== 3. 拖选：从 25% 拖到 75%（时长10s → 2.5s~7.5s）===');
waveEl.fireCap('mousedown', { button: 0, clientX: 100, clientY: 10, target: null, preventDefault() {}, stopPropagation() {} });
docEvents['mousemove'].forEach(f => f({ clientX: 300, clientY: 10 }));   // 75%
docEvents['mouseup'].forEach(f => f({}));
const rg = api.getRange();
console.log('  选区:', rg ? (rg.a.toFixed(2) + ' ~ ' + rg.b.toFixed(2)) : null, '(期望 2.50 ~ 7.50)');
console.log('  onChange:', lastChange ? lastChange.map(x => x.toFixed(2)) : null);

console.log('\n=== 4. 点「送入时间轴」→ onSend 收到选区 ===');
const actBar = waveEl.children.find(c => c.className === 'vcs-layer')
  .children.find(c => c.className === 'vcs-actions');
const btnSend = actBar.children.find(c => c.className === 'vcs-btn');
console.log('  找到送入按钮:', !!btnSend, '文案:', btnSend && btnSend.textContent);
btnSend.fire('click', { stopPropagation() {}, preventDefault() {} });
console.log('  onSend 收到:', lastSend ? lastSend.map(x => x.toFixed(2)) : null, '(期望 2.50 ~ 7.50)');

console.log('\n=== 5. 反向拖动（从右往左）应规范化 ===');
api.clear(true);
waveEl.fireCap('mousedown', { button: 0, clientX: 350, clientY: 10, target: null, preventDefault() {}, stopPropagation() {} });
docEvents['mousemove'].forEach(f => f({ clientX: 50, clientY: 10 }));
docEvents['mouseup'].forEach(f => f({}));
const rg2 = api.getRange();
console.log('  选区:', rg2 ? (rg2.a.toFixed(2) + ' ~ ' + rg2.b.toFixed(2)) : null,
  '(期望 1.25 ~ 8.75，已排序)');

console.log('\n=== 6. 无时长时不应产生选区 ===');
api.clear(true);
DURATION = 0;
waveEl.fireCap('mousedown', { button: 0, clientX: 100, clientY: 10, target: null, preventDefault() {}, stopPropagation() {} });
docEvents['mousemove'].forEach(f => f({ clientX: 300, clientY: 10 }));
docEvents['mouseup'].forEach(f => f({}));
console.log('  选区:', api.getRange(), '(期望 null)');
DURATION = 10;

console.log('\n=== 7. 清除按钮 + Esc ===');
api.setRange(1, 2, true);
console.log('  设选区后:', api.getRange() ? '有' : '无');
const btnClr = actBar.children.find(c => c.className === 'vcs-btn vcs-btn-x');
btnClr.fire('click', { stopPropagation() {}, preventDefault() {} });
console.log('  点✕后:', api.getRange(), ' onClear 调用次数:', clearCount);

api.setRange(1, 2, true);
(docEvents['keydown'] || []).forEach(f => f({ key: 'Escape' }));
console.log('  按 Esc 后:', api.getRange(), '(期望 null)');

console.log('\n=== 8. 拖选后吞掉尾随 click ===');
api.setRange(1, 3, true);
waveEl.fireCap('mousedown', { button: 0, clientX: 50, clientY: 10, target: null, preventDefault() {}, stopPropagation() {} });
docEvents['mousemove'].forEach(f => f({ clientX: 200, clientY: 10 }));
docEvents['mouseup'].forEach(f => f({}));
let clickBlocked = false;
waveEl.fireCap('click', { stopPropagation() { clickBlocked = true; }, preventDefault() {} });
console.log('  justDragged 期内 click 被拦:', clickBlocked, '(期望 true)');
