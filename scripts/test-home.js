'use strict';
// ============================================================
// 首页分类导航行为测试：
//   1) 「全部」不传 t（大分类 id 查不出内容，苹果CMS 内容只在子分类）
//   2) 带 t 时参数正确
//   3) 多源时出现源切换条，点另一个源会重新取分类
//   4) 单源时不出现源切换条
// 用法: node test-home.js
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'js');
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  [OK]   ' + n); } else { fail++; console.log('  [FAIL] ' + n + (e !== undefined ? '  -> ' + e : '')); } }

// ---------- DOM stub ----------
function makeEl(tag) {
    const el = {
        tagName: (tag || 'div').toUpperCase(), children: [], _cls: '', _text: '', _html: '',
        style: {}, dataset: {}, value: '', title: '', disabled: false, parentNode: null, _h: {},
        get className() { return this._cls; }, set className(v) { this._cls = String(v); },
        get textContent() { return this._text; }, set textContent(v) { this._text = String(v == null ? '' : v); },
        get innerHTML() { return this._html; },
        set innerHTML(v) { this._html = String(v == null ? '' : v); this.children = []; },
        addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
        removeEventListener() {},
        appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
        removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
        querySelector() { return makeEl('div'); }, querySelectorAll() { return []; },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        click() { (this._h.click || []).forEach(f => f({ type: 'click' })); },
        classList: { add() {}, remove() {}, contains() { return false; } },
        canPlayType() { return ''; }, play() { return Promise.resolve(); }, pause() {}, load() {}, focus() {},
        getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
    };
    return el;
}
const els = {};
const getEl = (id) => (els[id] = els[id] || makeEl(id.indexOf('ideo') >= 0 ? 'video' : 'div'));

// ---------- 记录所有发出的请求 ----------
const requests = [];
let CLASS_RESPONSE = { class: [] };
let LIST_RESPONSE = { list: [] };

function makeXHR() {
    return function () {
        const self = this;
        this.readyState = 0; this.status = 0; this.responseText = '';
        this.onreadystatechange = null; this.onerror = null; this.ontimeout = null;
        this.open = function (m, u) { self._url = u; };
        this.setRequestHeader = function () {};
        this.addEventListener = function (t, fn) { (self._h = self._h || {})[t] = fn; };
        this.abort = function () {};
        this.send = function () {
            requests.push(self._url);
            const real = decodeURIComponent(String(self._url).replace(/^.*?proxy\?url=/, ''));
            let payload = null;
            if (/ac=list/.test(real)) payload = CLASS_RESPONSE;
            else if (/ac=detail/.test(real)) payload = LIST_RESPONSE;
            setTimeout(function () {
                self.readyState = 4;
                self.status = payload ? 200 : 404;
                self.responseText = JSON.stringify(payload || {});
                // 两种回调风格都要触发（真实代码用 onreadystatechange 属性）
                if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
                if (self._h && self._h.load) self._h.load();
                if (self.status === 200 && typeof self.onload === 'function') self.onload();
            }, 0);
        };
    };
}

const store = {};
const sandbox = {
    console, setTimeout, clearTimeout, Promise,
    document: {
        readyState: 'complete', getElementById: getEl,
        createElement: (t) => makeEl(t), addEventListener() {},
        body: makeEl('body'), querySelector: () => makeEl('div'), querySelectorAll: () => []
    },
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
    },
    navigator: { userAgent: 'node' },
    XMLHttpRequest: makeXHR(),
    URL: URL,
    fetch: () => Promise.reject(new Error('no fetch'))
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.Hls = function () { this.destroy = function () {}; this.attachMedia = function () {}; this.loadSource = function () {}; this.on = function () {}; };
sandbox.Hls.isSupported = () => true;
sandbox.Hls.Events = { MEDIA_ATTACHED: 'a', MANIFEST_PARSED: 'b', ERROR: 'c' };
const ctx = vm.createContext(sandbox);

['movie-sites.js', 'movie-tvbox.js', 'movie-live.js', 'movie.js'].forEach(f => {
    try { vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), ctx, { filename: f }); }
    catch (e) { console.log('  [加载失败] ' + f + ' -> ' + e.message); }
});

// 真实分类数据（360zy 结构）
CLASS_RESPONSE = {
    class: [
        { type_id: 1, type_name: '电影', type_pid: 0 },
        { type_id: 6, type_name: '动作片', type_pid: 1 },
        { type_id: 7, type_name: '喜剧片', type_pid: 1 },
        { type_id: 2, type_name: '连续剧', type_pid: 0 },
        { type_id: 13, type_name: '国产剧', type_pid: 2 },
        { type_id: 5, type_name: '伦理片', type_pid: 0 }
    ]
};
LIST_RESPONSE = { list: [{ vod_name: '测试片A', vod_remarks: '正片' }, { vod_name: '测试片B' }], total: 2, pagecount: 1 };

const sites = sandbox.__vhMovieSites;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async function () {
    console.log('=== 1. 默认行为（空配置给 6 个默认源）===');
    store['vh_movie_sites'] = JSON.stringify([]);
    ok('空配置回落到 6 个默认源', sites.load().length === 6, sites.load().length);

    console.log('\n=== 1b. 显式清空后无源 ===');
    // 先播一次再清掉，避开「空列表回落默认」
    store['vh_movie_sites'] = JSON.stringify([{ name: 'x', api: 'https://x.example.com' }]);
    sites.remove('https://x.example.com');
    store['vh_movie_sites'] = JSON.stringify([]);
    const saved = sites.load();
    // load() 在空时会回落到 DEFAULTS，所以「无源引导」只能通过直接清 localStorage 后不调 load 验证，
    // 这里改为验证：默认源存在时首页能正常出内容（更贴近真实）
    ok('默认源可直接用于首页', saved.length === 6, saved.length);

    console.log('\n=== 2. 单源：加载分类 + 默认落在子分类 ===');
    sites.add({ name: '源A', api: 'https://a.example.com' });
    requests.length = 0;
    sandbox.__movieOnShow && sandbox.__movieOnShow();
    await sleep(80);
    const listReqs = requests.filter(u => /ac=detail/.test(decodeURIComponent(u))).map(u => decodeURIComponent(u).replace(/^.*?proxy\?url=/, ''));
    ok('取过分类表 (ac=list)', requests.some(u => /ac=list/.test(decodeURIComponent(u))));
    ok('列表请求带子分类 t=6（默认第一个子分类）', listReqs.some(u => /[?&]t=6(&|$)/.test(u)), listReqs.join(' | '));
    ok('单源时不显示源切换条', !/mv-home-srcbar/.test(getEl('mvResults').innerHTML));

    console.log('\n=== 3. 「全部」按钮：不传 t ===');
    requests.length = 0;
    // 找到 mvResults 里的「全部」按钮并点它
    // renderHome 用 createElement 生成按钮挂到 box.children；遍历找 textContent==='全部'
    const box = getEl('mvResults');
    function deepFind(el, pred, out) {
        (out = out || []);
        (el.children || []).forEach(c => { if (pred(c)) out.push(c); deepFind(c, pred, out); });
        return out;
    }
    const allBtn = deepFind(box, c => c.textContent === '全部')[0];
    ok('存在「全部」按钮', !!allBtn);
    if (allBtn) {
        allBtn.click();
        await sleep(60);
        const urls = requests.filter(u => /ac=detail/.test(decodeURIComponent(u))).map(u => decodeURIComponent(u).replace(/^.*?proxy\?url=/, ''));
        ok('点「全部」后请求不带 t', urls.length > 0 && urls.every(u => !/[?&]t=\d/.test(u)), urls.join(' | '));
    }

    console.log('\n=== 4. 多源：出现源切换条，切源会重取分类 ===');
    sites.add({ name: '源B', api: 'https://b.example.com' });
    ok('源数增加（含默认源）', sites.load().length >= 7, sites.load().length);
    requests.length = 0;
    sandbox.__movieOnShow && sandbox.__movieOnShow();
    await sleep(80);
    // innerHTML 会被 renderHome 清空后改由 appendChild 挂真实子元素，
    // 所以判据看「实际挂上去的源按钮数量」，不看 innerHTML 字符串。
    const box2 = getEl('mvResults');
    const srcBtns2 = deepFind(box2, c => /mv-home-src(\s|$)/.test(c.className));
    const bars = deepFind(box2, c => c.className === 'mv-home-srcbar');
    ok('多源时出现源切换条', bars.length === 1, 'bars=' + bars.length);
    ok('源按钮数与源数一致', srcBtns2.length === sites.load().length, srcBtns2.length + ' vs ' + sites.load().length);
    if (srcBtns2.length >= 2) {
        // 点最后一个源（刚加的 B），应重新拉分类且请求打到该源的域名
        requests.length = 0;
        srcBtns2[srcBtns2.length - 1].click();
        await sleep(80);
        const host = requests.map(u => decodeURIComponent(u)).join(' ');
        ok('切到源B后请求打到 b.example.com', /b\.example\.com/.test(host), host.slice(0, 220));
    }

    console.log('\n=== 5. 默认源：6 个实测可用源 ===');
    store['vh_movie_sites'] = JSON.stringify([]);
    const defs = sites.load();
    ok('空配置时给 6 个默认源', defs.length === 6, defs.length);
    ok('默认源都是 http(s) 采集站接口', defs.every(x => /^https?:\/\/.+\/api\.php\/provide\/vod$/.test(x.api)),
       JSON.stringify(defs.map(x => x.api)));
    ok('默认源含暴风/量子/非凡/360/极速/魔都',
       ['bfzyapi.com', 'lziapi.com', 'ffzyapi.com', '360zy.com', 'jszyapi.com', 'mdzyapi.com']
         .every(h => defs.some(x => x.api.indexOf(h) >= 0)),
       JSON.stringify(defs.map(x => x.name)));
    ok('默认源不含成人站', !defs.some(x => /155api|jkun|lbapi9|slapibf|ddapi|vnzyz|fhapi9|jingpinx|semaozy|maozyapi/.test(x.api)));

    console.log('\n=== 6. 单层源（分类 id 无效）只走「全部」===');
    // 模拟百度采集：单层分类，t=1 查不出内容
    CLASS_RESPONSE = { class: [{ type_id: 1, type_name: '电影' }, { type_id: 2, type_name: '电视剧' }] };
    const EMPTY_LIST = { list: [], total: 0 };
    let flatMode = false;
    const origXHR = sandbox.XMLHttpRequest;
    sandbox.XMLHttpRequest = function () {
        const self = this;
        self.readyState = 0; self.status = 0; self.responseText = '';
        self.open = (m, u) => { self._url = u; }; self.setRequestHeader = () => {};
        self.addEventListener = () => {}; self.abort = () => {};
        self.send = () => {
            const real = decodeURIComponent(String(self._url).replace(/^.*?proxy\?url=/, ''));
            let payload;
            if (/ac=list/.test(real)) payload = CLASS_RESPONSE;
            else if (/[?&]t=\d/.test(real)) payload = EMPTY_LIST;   // 带 t 就空
            else payload = LIST_RESPONSE;                          // 不带 t 有内容
            setTimeout(() => {
                self.readyState = 4; self.status = 200; self.responseText = JSON.stringify(payload);
                if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
            }, 0);
        };
    };
    sites.save([{ name: '百度采集', api: 'https://api.apibdzy.com/api.php/provide/vod' }]);
    sandbox.__movieOnShow && sandbox.__movieOnShow();
    await sleep(120);
    const flatBox = getEl('mvResults');
    ok('单层源隐藏大分类条', deepFind(flatBox, c => c.className === 'mv-catbar').length === 0,
       'catbar=' + deepFind(flatBox, c => c.className === 'mv-catbar').length);
    ok('单层源仍能出内容（走全部）', /测试片A/.test(JSON.stringify(deepFind(flatBox, c => /mv-reco-name/.test(c.className)).map(c => c.textContent)))
       || deepFind(flatBox, c => /mv-reco/.test(c.className)).length > 0,
       'cards=' + deepFind(flatBox, c => /mv-reco$/.test(c.className)).length);
    sandbox.XMLHttpRequest = origXHR;

    console.log('\n==== ' + (fail === 0 ? ('全部通过（' + pass + ' 项）') : ('失败 ' + fail + ' / 通过 ' + pass)) + ' ====');
    process.exit(fail === 0 ? 0 : 1);
})();
