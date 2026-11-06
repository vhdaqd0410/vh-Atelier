// vh-Atelier 达芬奇版 · 审片（分秒帧）
// 为什么不用 iframe：app.mediatrack.cn 返回 X-Frame-Options: SAMEORIGIN，
// 跨源内嵌被浏览器拒绝，iframe 永远空白。改用主进程 WebContentsView，
// 由插件把面板区的屏幕坐标报给主进程，视图覆盖在那块区域上。
(function () {
    'use strict';
    if (window.__spPanel && window.__spPanel.init) return;

    var H = null;
    var el = {};
    var offNav = null;
    var visible = false;
    var homeUrl = 'https://app.mediatrack.cn/';
    var relayoutTimer = null;

    function $(id) { return document.getElementById(id); }

    function bindEls() {
        ['spBack', 'spFwd', 'spReload', 'btnSpHome', 'spExternal', 'spUrl', 'spFrame',
         'spParseInput', 'spParseBtn', 'spParsePaste'].forEach(function (k) { el[k] = $(k); });
    }

    // 计算 iframe 占位区在窗口里的绝对坐标，交给主进程定位视图
    function frameRect() {
        var ph = el.spFrame;
        if (!ph) return null;
        var r = ph.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) return null;
        return {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height)
        };
    }

    function syncBounds() {
        if (!visible) return;
        var b = frameRect();
        if (!b) return;
        if (H && H.embedSetBounds) H.embedSetBounds(b).catch(function () {});
    }

    function scheduleSync() {
        if (relayoutTimer) clearTimeout(relayoutTimer);
        relayoutTimer = setTimeout(syncBounds, 60);
    }

    function show() {
        // 授权未通过时不创建原生视图：WebContentsView 是原生层，
        // 会盖在登录遮罩（z-index 再高也只是 DOM 层）之上，导致遮罩被挡住。
        var locked = false;
        try {
            if (window.__vhLicenseUI && window.__vhLicenseUI.isUnlocked) {
                locked = !window.__vhLicenseUI.isUnlocked();
            }
        } catch (e) { locked = false; }
        if (locked) {
            setTimeout(show, 500);   // 解锁后会自动进来
            return;
        }

        var b = frameRect();
        if (!b) {
            // 面板还没布局好，稍后再试
            setTimeout(show, 120);
            return;
        }
        visible = true;
        H.embedShow({ url: homeUrl, bounds: b }).then(function () {
            syncUrl(homeUrl);
        }).catch(function (e) {
            if (el.spUrl) el.spUrl.value = '打开失败：' + (e.message || e);
        });
    }

    function hide() {
        visible = false;
        if (H && H.embedHide) H.embedHide().catch(function () {});
    }

    function syncUrl(u) {
        if (el.spUrl && u) {
            // 去掉末尾根路径，看着干净些
            el.spUrl.value = u;
        }
    }

    function setNavState(s) {
        if (!s) return;
        if (el.spBack) el.spBack.disabled = !s.canBack;
        if (el.spFwd) el.spFwd.disabled = !s.canForward;
        if (s.url) syncUrl(s.url);
        if (s.canBack !== undefined && el.btnSpHome) el.btnSpHome.disabled = false;
    }

    function nav(action, url) {
        if (!H || !H.embedNav) return;
        H.embedNav({ action: action, url: url }).catch(function (e) {
            if (el.spUrl) el.spUrl.value = '导航失败：' + (e.message || e);
        });
    }

    // ---------- 链接解析 ----------
    function extractLinks(text) {
        var out = [];
        var s = String(text || '');
        var re1 = /(https?:\/\/[^\s"'<>()，。；、）】]+)/gi;
        var m;
        while ((m = re1.exec(s))) out.push(m[1]);
        if (!out.length) {
            var re2 = /((?:app\.)?mediatrack\.(?:cn|com)[^\s"'<>()，。；、）】]*)/gi;
            while ((m = re2.exec(s))) out.push('https://' + m[1]);
        }
        var seen = {};
        return out.filter(function (u) { if (seen[u]) return false; seen[u] = 1; return true; });
    }

    function openText(text) {
        var t = String(text || '').trim();
        if (!t) return;
        var list = extractLinks(t);
        if (!list.length) {
            if (el.spParseInput) el.spParseInput.value = '';
            if (el.spUrl) el.spUrl.value = '没找到可打开的链接';
            return;
        }
        var url = list[0];
        if (el.spParseInput) {
            el.spParseInput.value = url;
            el.spParseInput.classList.add('sp-parse-hit');
        }
        if (!visible) show();
        setTimeout(function () { nav('goto', url); }, 260);
    }

    function bind() {
        if (el.spBack) el.spBack.addEventListener('click', function () { nav('back'); });
        if (el.spFwd) el.spFwd.addEventListener('click', function () { nav('forward'); });
        if (el.spReload) el.spReload.addEventListener('click', function () { nav('reload'); });
        if (el.btnSpHome) el.btnSpHome.addEventListener('click', function () { nav('home', homeUrl); });
        if (el.spExternal) {
            el.spExternal.addEventListener('click', function () {
                var u = (el.spUrl && el.spUrl.value) || homeUrl;
                if (H && H.openExternal) H.openExternal(u);
            });
        }
        if (el.spUrl) {
            el.spUrl.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    nav('goto', el.spUrl.value);
                }
            });
        }
        if (el.spParseBtn) {
            el.spParseBtn.addEventListener('click', function () { openText(el.spParseInput && el.spParseInput.value); });
        }
        if (el.spParseInput) {
            el.spParseInput.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') { ev.preventDefault(); openText(el.spParseInput.value); }
            });
            el.spParseInput.addEventListener('paste', function (ev) {
                var cd = ev.clipboardData || window.clipboardData;
                var txt = cd ? cd.getData('text') : '';
                if (!txt) return;
                ev.preventDefault();
                el.spParseInput.value = txt;
                setTimeout(function () { openText(txt); }, 40);
            });
        }
        if (el.spParsePaste) {
            el.spParsePaste.addEventListener('click', function () {
                if (navigator.clipboard && navigator.clipboard.readText) {
                    navigator.clipboard.readText().then(function (txt) {
                        if (el.spParseInput) el.spParseInput.value = txt || '';
                        openText(txt);
                    }).catch(function () {});
                }
            });
        }
        // 窗口/面板尺寸变化时重新对齐
        window.addEventListener('resize', scheduleSync);
    }

    var _init = false;

    function init() {
        H = window.vhHost;
        bindEls();
        if (!_init) {
            _init = true;
            bind();
            if (H && H.onEmbedNavState) offNav = H.onEmbedNavState(setNavState);
        }
        // 面板刚切换过来，等一帧再算位置
        setTimeout(show, 100);
    }

    // 离开该面板时销毁视图（避免它盖在别的面板上）
    function onHide() { hide(); }

    window.__spPanel = { init: init, hide: onHide, show: show, syncBounds: syncBounds };
    window.__spAutoLoad = function () { try { init(); } catch (e) { console.log('[shenpian] init 失败', e); } };
})();
