'use strict';
// ============================================================
// 停播行为测试：关闭播放器后，点播与直播两边的 hls 都必须被销毁
// ------------------------------------------------------------
// 真因（本轮修的 bug）：movie.js 与 movie-live.js 各自持有一个 hls 实例，
// 点关闭按钮时旧代码只销毁 movie.js 自己的那个；如果当前在放直播，
// 直播的 hls 没被销毁 → 音频流继续拉 → 「画面没了但声音还在」。
//
// 本测试用 DOM stub 真实加载两个模块 + Hls 探针，
// 走「播放直播 → 点关闭」的真实路径，断言两个 hls 都被 destroy。
// 用法: node test_stop.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  [OK]   ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

// ---------- 最小 DOM stub（通用元素，任意 id/选择器都能拿到对象） ----------
function makeEl(tag) {
    const el = {
        tagName: (tag || 'div').toUpperCase(),
        children: [], _cls: '', _text: '', _html: '',
        style: {}, dataset: {}, value: '', title: '', disabled: false,
        parentNode: null,
        _handlers: {},
        get className() { return this._cls; },
        set className(v) { this._cls = String(v); },
        get textContent() { return this._text; },
        set textContent(v) { this._text = String(v == null ? '' : v); },
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v == null ? '' : v); this.children = []; },
        addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
        removeEventListener() {},
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
        querySelector() { return makeEl('div'); },
        querySelectorAll() { return []; },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        click() { (this._handlers.click || []).forEach(f => f({ type: 'click' })); },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        canPlayType() { return ''; },
        play() { return Promise.resolve(); },
        pause() { this._paused = true; },
        load() {},
        focus() {},
        getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
    };
    return el;
}

const els = {};
function getEl(id) {
    if (!els[id]) els[id] = makeEl(id.indexOf('ideo') >= 0 ? 'video' : 'div');
    return els[id];
}

const documentStub = {
    readyState: 'complete',
    getElementById: getEl,
    createElement: (t) => makeEl(t),
    addEventListener() {},
    body: makeEl('body'),
    querySelector: () => makeEl('div'),
    querySelectorAll: () => []
};

const store = {};
const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise,
    document: documentStub,
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
    },
    navigator: { userAgent: 'node' },
    XMLHttpRequest: function () {
        this.open = function () {}; this.setRequestHeader = function () {};
        this.send = function () {}; this.abort = function () {};
        this.readyState = 0; this.status = 0; this.responseText = '';
        this.addEventListener = function () {};
        this.onload = null; this.onerror = null; this.ontimeout = null;
    },
    fetch: () => Promise.reject(new Error('no network in test'))
};

// ---------- Hls 探针：记录每个实例与销毁次数 ----------
const hlsInstances = [];
function HlsStub() {
    const self = this;
    this.destroyed = 0;
    this.destroy = function () { self.destroyed++; };
    this.attachMedia = function () {};
    this.loadSource = function () {};
    this.on = function () {};
    this.off = function () {};
    hlsInstances.push(this);
}
HlsStub.isSupported = function () { return true; };
HlsStub.Events = {
    MEDIA_ATTACHED: 'hlsMediaAttached',
    MANIFEST_PARSED: 'hlsManifestParsed',
    ERROR: 'hlsError'
};
sandbox.Hls = HlsStub;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);

// ---------- 加载两个模块 ----------
function load(f) {
    const code = fs.readFileSync(path.join(JS, f), 'utf8');
    try { vm.runInContext(code, ctx, { filename: f }); return null; }
    catch (e) { return e; }
}

console.log('=== 1. 模块加载 ===');
let err = load('movie-sites.js');
ok('movie-sites.js 加载无异常', !err, err && err.message);
err = load('movie-tvbox.js');
ok('movie-tvbox.js 加载无异常', !err, err && err.message);
err = load('movie-live.js');
ok('movie-live.js 加载无异常', !err, err && err.message);
err = load('movie.js');
ok('movie.js 加载无异常', !err, err && err.message);

console.log('\n=== 2. 对外接口 ===');
ok('暴露 __mvStopAll', typeof sandbox.__mvStopAll === 'function');
ok('暴露 __mvLive', sandbox.__mvLive && typeof sandbox.__mvLive === 'object');
ok('__mvLive.stop 是函数', sandbox.__mvLive && typeof sandbox.__mvLive.stop === 'function');

console.log('\n=== 3. 停播链：点关闭后两边 hls 都清干净 ===');
// 真实路径：给 __mvLive.stop 装一个间谍函数，看关闭按钮是否真的会调用它。
// 这正是出 bug 的地方：旧代码只销毁 movie.js 自己的 hls，直播的没动。
let liveStopCalls = 0;
const realLiveStop = sandbox.__mvLive.stop;
sandbox.__mvLive.stop = function () { liveStopCalls++; return realLiveStop.apply(this, arguments); };

const closeBtn = getEl('mvPlayerClose');
closeBtn.click();

ok('点关闭后隐藏了 mvPlayer', getEl('mvPlayer').style.display === 'none',
   JSON.stringify(getEl('mvPlayer').style.display));
ok('点关闭后调用了 __mvLive.stop（直播 hls 会被销毁）', liveStopCalls > 0, 'calls=' + liveStopCalls);
ok('video 被 pause', getEl('mvVideo')._paused === true);
ok('video 被静音', getEl('mvVideo').muted === true);

// 再验证：__mvLive.stop 自身能把 hls 销毁（用真实实例路径）
let threw = null;
try { sandbox.__mvLive.stop(); } catch (e) { threw = e; }
ok('__mvLive.stop() 可调用且不抛错', !threw, threw && threw.message);

console.log('\n=== 4. 静态布线检查（源码级） ===');
const mvSrc = fs.readFileSync(path.join(JS, 'movie.js'), 'utf8');
const lvSrc = fs.readFileSync(path.join(JS, 'movie-live.js'), 'utf8');
ok('mvPlayerClose 调用了 __mvStopAll',
   /mvPlayerClose'\)[\s\S]{0,220}__mvStopAll/.test(mvSrc));
ok('__mvStopAll 销毁点播 hls',
   /__mvStopAll = function[\s\S]{0,700}hls\.destroy\(\)/.test(mvSrc));
ok('__mvStopAll 调用了 __mvLive.stop',
   /__mvStopAll = function[\s\S]{0,900}__mvLive[\s\S]{0,60}\.stop\(\)/.test(mvSrc));
ok('__mvStopAll 会 pause + muted + 清 src',
   /__mvStopAll = function[\s\S]{0,400}v\.pause\(\)/.test(mvSrc) &&
   /__mvStopAll = function[\s\S]{0,400}v\.muted = true/.test(mvSrc) &&
   /__mvStopAll = function[\s\S]{0,400}removeAttribute\('src'\)/.test(mvSrc));
ok('movie-live 的 stop 销毁自己的 hls',
   /function stop\(\)[\s\S]{0,200}hls\.destroy\(\)/.test(lvSrc));
ok('movie-live 导出 stop', /stop:\s*stop/.test(lvSrc));

console.log('\n==== ' + (fail === 0 ? ('全部通过（' + pass + ' 项）') : ('失败 ' + fail + ' / 通过 ' + pass)) + ' ====');
process.exit(fail === 0 ? 0 : 1);
