// vh-Atelier 达芬奇版 · 内嵌站导航通用模块
// 移植自客户版 js/iframe-nav.js，改动：
//   1. 去掉 require('fs'/'path'/'child_process')，渲染进程 contextIsolation 禁止
//   2. 「外部浏览器打开」改走 window.vhHost.openExternal
// 其余导航（后退/前进/刷新/首页/地址栏/链接解析/地址栈）逻辑与原版一致。
(function () {
    'use strict';

    // 站点配置
    var SITES = {
        shenpian: {
            frame: 'spFrame', back: 'spBack', fwd: 'spFwd', reload: 'spReload',
            home: 'btnSpHome', external: 'spExternal', url: 'spUrl',
            homeUrl: 'https://app.mediatrack.cn/'
        }
    };

    function $(id) { return document.getElementById(id); }

    function loadHomeUrl(cfg) {
        if (!cfg.storeKey) return cfg.homeUrl || '';
        try {
            var v = localStorage.getItem(cfg.storeKey);
            if (v) return v;
        } catch (e) {}
        return cfg.homeUrl || cfg.defaultUrl || '';
    }
    function saveHomeUrl(cfg, u) {
        if (!cfg.storeKey || !u) return;
        try { localStorage.setItem(cfg.storeKey, u); } catch (e) {}
    }

    function openExternal(u) {
        if (!u) return;
        var H = window.vhHost;
        if (H && H.openExternal) { try { H.openExternal(u); return; } catch (e) {} }
        try { window.open(u, '_blank'); } catch (e) {}
    }

    function cleanUrl(u) {
        var s = String(u || '').trim();
        if (!s) return '';
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        return s;
    }

    function isMediaTrackHost(u) {
        return /mediatrack\.(cn|com)/i.test(String(u || ''));
    }

    // 从一段文字里提取所有链接
    function extractLinks(text) {
        var out = [];
        var s = String(text || '');
        // 完整 URL
        var re1 = /(https?:\/\/[^\s"'<>()，。；、）】]+)/gi;
        var m;
        while ((m = re1.exec(s))) {
            out.push({ url: m[1], raw: m[1] });
        }
        // 裸域名（分秒帧常见）
        if (!out.length) {
            var re2 = /((?:app\.)?mediatrack\.(?:cn|com)[^\s"'<>()，。；、）】]*)/gi;
            while ((m = re2.exec(s))) {
                out.push({ url: 'https://' + m[1], raw: m[1] });
            }
        }
        // 去重
        var seen = {};
        return out.filter(function (x) {
            if (seen[x.url]) return false;
            seen[x.url] = 1;
            return true;
        });
    }

    // 为某个站点装配导航
    function wire(name) {
        var cfg = SITES[name];
        if (!cfg) return;
        var frame = $(cfg.frame);
        if (!frame) return;

        var stack = [];
        var idx = -1;

        function syncBtns() {
            var b = $(cfg.back), f = $(cfg.fwd);
            if (b) b.disabled = (idx <= 0);
            if (f) f.disabled = (idx >= stack.length - 1);
        }
        function syncUrl(u) {
            var inp = $(cfg.url);
            if (inp && u) inp.value = u;
        }
        function push(u) {
            if (!u) return;
            if (stack[idx] === u) return;
            stack = stack.slice(0, idx + 1);
            stack.push(u);
            idx = stack.length - 1;
            syncBtns();
        }
        function go(u, record) {
            var url = cleanUrl(u);
            if (!url) return;
            frame.src = url;
            if (record !== false) push(url);
            syncUrl(url);
        }
        function goBack() {
            if (idx <= 0) return;
            idx--;
            frame.src = stack[idx];
            syncUrl(stack[idx]);
            syncBtns();
        }
        function goFwd() {
            if (idx >= stack.length - 1) return;
            idx++;
            frame.src = stack[idx];
            syncUrl(stack[idx]);
            syncBtns();
        }
        function reload() {
            var cur = stack[idx];
            if (!cur) return;
            try { frame.contentWindow.location.reload(); }
            catch (e) { frame.src = cur; }
        }
        function ensure() {
            if (idx >= 0) return;
            go(loadHomeUrl(cfg));
        }

        // 事件
        var b = $(cfg.back), f = $(cfg.fwd), r = $(cfg.reload),
            hm = $(cfg.home), ext = $(cfg.external), inp = $(cfg.url);

        if (b) b.addEventListener('click', goBack);
        if (f) f.addEventListener('click', goFwd);
        if (r) r.addEventListener('click', reload);
        if (hm) hm.addEventListener('click', function () { go(loadHomeUrl(cfg)); });
        if (ext) ext.addEventListener('click', function () { openExternal(stack[idx] || loadHomeUrl(cfg)); });
        if (inp) {
            inp.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    go(inp.value);
                }
            });
        }

        syncBtns();

        // 暴露给外部（链接解析用）
        var api = {
            go: go,
            ensure: ensure,
            open: function (u) { go(u); }
        };
        window['__nav_' + name] = api;

        // 首次自动加载
        return api;
    }

    // 分秒帧链接解析条
    function bindSpParse() {
        var inp = $('spParseInput');
        var btn = $('spParseBtn');
        var pasteBtn = $('spParsePaste');
        if (!inp || !btn) return;

        function toast(msg) {
            if (window.__ndToast) { window.__ndToast(msg); return; }
            console.log('[shenpian] ' + msg);
        }

        function doOpen(text) {
            var t = String(text || '').trim();
            if (!t) return;
            var list = extractLinks(t);
            if (!list.length) {
                inp.classList.remove('sp-parse-hit');
                toast('没找到可打开的链接');
                return;
            }
            var url = list[0].url;
            var nav = window.__nav_shenpian;
            if (nav) nav.open(url);
            inp.value = url;
            inp.classList.add('sp-parse-hit');
            toast((isMediaTrackHost(url) ? '已打开分秒帧：' : '已打开链接：') + url);
            if (list.length > 1) {
                console.log('[shenpian] 解析到 ' + list.length + ' 个链接，已打开第 1 个：', list);
            }
        }

        btn.addEventListener('click', function () { doOpen(inp.value); });

        inp.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                doOpen(inp.value);
            }
        });

        // 粘贴即解析
        inp.addEventListener('paste', function (ev) {
            var cd = ev.clipboardData || window.clipboardData;
            var txt = cd ? cd.getData('text') : '';
            if (!txt) return;
            ev.preventDefault();
            inp.value = txt;
            setTimeout(function () { doOpen(txt); }, 30);
        });

        if (pasteBtn) {
            pasteBtn.addEventListener('click', function () {
                if (navigator.clipboard && navigator.clipboard.readText) {
                    navigator.clipboard.readText().then(function (txt) {
                        inp.value = txt || '';
                        doOpen(txt);
                    }).catch(function () { toast('读不到剪贴板，请手动粘贴'); });
                } else {
                    toast('读不到剪贴板，请手动粘贴');
                }
            });
        }
    }

    var _wired = false;

    function init() {
        if (_wired) {
            var nav = window.__nav_shenpian;
            if (nav) nav.ensure();
            return;
        }
        _wired = true;
        wire('shenpian');
        bindSpParse();
    }

    window.__iframeNav = { init: init, extractLinks: extractLinks };
    window.__spAutoLoad = function () { try { init(); } catch (e) { console.log('[shenpian] init 失败', e); } };
})();
