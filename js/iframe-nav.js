// vh-Atelier 内嵌站导航通用模块
// 解决：审片（分秒帧）与超分（去字幕站）两个板块的 iframe 一直空白
// 根因：main.js 调用了 window.__spAutoLoad / window.__upscaleAutoLoad，但两者从未定义；
//       导航栏按钮（后退/前进/刷新/首页/外开/地址栏）也没有任何事件绑定。
// 本模块为两个板块补齐：iframe 首次加载 + 完整导航条 + 独立的历史栈。
//
// 说明：iframe 与主面板不同源（跨域），无法访问 contentWindow.history，
//      因此自带一个地址栈来模拟后退/前进。
(function () {
    var fs = require('fs');
    var path = require('path');
    var child_process = require('child_process');

    // 站点配置
    var SITES = {
        shenpian: {
            frame: 'spFrame', back: 'spBack', fwd: 'spFwd', reload: 'spReload',
            home: 'btnSpHome', external: 'spExternal', url: 'spUrl',
            homeUrl: 'https://app.mediatrack.cn/'
        },
        upscale: {
            frame: 'upscaleFrame', back: 'upBack', fwd: 'upFwd', reload: 'upReload',
            home: 'btnUpscaleHome', external: 'upExternal', url: 'upUrl',
            homeUrl: 'http://subtitle.zztianqiao.com'
        }
    };

    function $ (id) { return document.getElementById(id); }

    // 外部浏览器打开（CEP 面板内用系统默认浏览器）
    function openExternal (u) {
        try { child_process.exec('start "" "' + u + '"'); } catch (e) {}
    }

    // 为一个板块装配导航
    function wire (key) {
        var cfg = SITES[key];
        var frame = $(cfg.frame);
        if (!frame) return null;

        var elBack = $(cfg.back), elFwd = $(cfg.fwd), elReload = $(cfg.reload);
        var elHome = $(cfg.home), elExt = $(cfg.external), elUrl = $(cfg.url);

        var stack = [];      // 访问过的地址（模拟历史）
        var pos = -1;        // 当前在栈中的位置
        var loaded = false;  // 是否已加载过

        function syncBtns () {
            if (elBack) elBack.disabled = (pos <= 0);
            if (elFwd) elFwd.disabled = (pos < 0 || pos >= stack.length - 1);
        }
        function syncUrl (u) {
            if (elUrl && u && document.activeElement !== elUrl) elUrl.value = u;
        }

        // 导航（record=false 时不入栈，用于后退/前进）
        function go (u, record) {
            if (!u) return;
            u = String(u).trim();
            if (!u) return;
            // 补协议：用户可能只输入域名
            if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) {
                u = /^[\w-]+(\.[\w-]+)+/.test(u) ? ('http://' + u) : ('http://' + u);
            }
            try {
                frame.src = u;
                loaded = true;
            } catch (e) {
                openExternal(u);
                return;
            }
            if (record !== false) {
                // 截断前进分支，压入新地址
                stack = stack.slice(0, pos + 1);
                stack.push(u);
                pos = stack.length - 1;
            }
            syncUrl(u);
            syncBtns();
        }

        function goBack () { if (pos > 0) { pos--; go(stack[pos], false); } }
        function goFwd () { if (pos < stack.length - 1) { pos++; go(stack[pos], false); } }
        function reload () {
            var u = stack[pos] || cfg.homeUrl;
            // 强制重载：先清空再设，避免同地址不触发
            try { frame.src = 'about:blank'; } catch (e) {}
            setTimeout(function () { go(u, false); }, 40);
        }

        if (elBack) elBack.addEventListener('click', goBack);
        if (elFwd) elFwd.addEventListener('click', goFwd);
        if (elReload) elReload.addEventListener('click', reload);
        if (elHome) elHome.addEventListener('click', function () { go(cfg.homeUrl, true); });
        if (elExt) elExt.addEventListener('click', function () {
            openExternal(stack[pos] || cfg.homeUrl);
        });
        if (elUrl) {
            elUrl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.keyCode === 13) { go(elUrl.value, true); }
                e.stopPropagation();
            });
        }

        // 首次进入板块时自动加载首页
        var api = {
            loaded: function () { return loaded; },
            home: cfg.homeUrl,
            load: function (u, record) { go(u || cfg.homeUrl, record !== false); },
            autoLoad: function () {
                if (!loaded) go(cfg.homeUrl, true);
            }
        };
        syncBtns();
        return api;
    }

    var wired = {};
    function ensure (key) {
        if (!wired[key]) wired[key] = wire(key);
        return wired[key];
    }

    // 暴露给其他模块（如 progress.js 的 gotoFm，切项目时直接导航）
    window.__spNav = { load: function (u, rec) { var a = ensure('shenpian'); if (a) a.load(u, rec); } };
    window.__upNav = { load: function (u, rec) { var a = ensure('upscale'); if (a) a.load(u, rec); } };

    // main.js 懒加载钩子：切到板块时把 iframe 拉起来
    window.__spAutoLoad = function () {
        var a = ensure('shenpian');
        if (a) a.autoLoad();
    };
    window.__upscaleAutoLoad = function () {
        var a = ensure('upscale');
        if (a) a.autoLoad();
    };

    // 面板初始化时先把 DOM 绑好（不加载页面，等切到时再加载）
    ensure('shenpian');
    ensure('upscale');
})();
