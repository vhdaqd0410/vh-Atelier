// vh-Atelier 主插件 · 管理台面板
// ==========================================================================
// 内嵌授权管理台（license-server 的 /admin 页面）。
// 主插件本身不参与授权管控（它只给 A/B 用），这个面板纯粹是给管理员方便的入口，
// 省得每次都开浏览器。
//
// 顺带做一件事：定时查「待处理申请」数量，在组按钮上显示角标 + 标题栏红点，
// 这样有人申请授权时能立刻看到。
//
// 依赖：CSInterface（可选，用于打开外部浏览器）
(function () {
    var fs, path, http, https;
    try {
        fs = require('fs');
        path = require('path');
        http = require('http');
        https = require('https');
    } catch (e) { return; }   // 非 CEP 环境（浏览器调试）直接不启用

    var DEFAULT_BASE = 'http://47.122.108.231:17894';

    // ---------- 配置：读插件根目录 license-admin.json（可选）----------
    function extRoot() {
        try {
            if (typeof CSInterface !== 'undefined') {
                var r = new CSInterface().getSystemPath('extension');
                if (r && fs.existsSync(r)) return r;
            }
        } catch (e) {}
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (e) {}
        return '';
    }
    var ROOT = extRoot();
    var CFG_FILE = ROOT ? path.join(ROOT, 'license-admin.json') : '';
    var TOKEN_FILE = ROOT ? path.join(ROOT, 'collect', 'admin-token.json') : '';

    function readJson(p) {
        try { if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
        return null;
    }
    function writeJson(p, o) {
        try {
            var d = path.dirname(p);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');
            return true;
        } catch (e) { return false; }
    }

    function base() {
        var c = readJson(CFG_FILE) || {};
        return String(c.base || DEFAULT_BASE).replace(/\/+$/, '');
    }

    var el = {};
    var loaded = false;

    function pick() {
        el.frame = document.getElementById('adFrame');
        el.reload = document.getElementById('adNavReload');
        el.home = document.getElementById('adNavHome');
        el.external = document.getElementById('adNavExternal');
        el.hint = document.getElementById('adNavHint');
        el.reqs = document.getElementById('adNavReqs');
        el.reqCount = document.getElementById('adReqCount');
        el.badge = document.getElementById('adminBadge');
        el.groupBtn = document.querySelector('.ws-group[data-group="admin"]');
    }

    function setHint(t) { if (el.hint) el.hint.textContent = t || ''; }

    function load(force) {
        if (!el.frame) return;
        var b = base();
        if (loaded && !force) return;
        setHint('正在加载 ' + b + '/admin …');
        try {
            // 带上缓存参数，避免 CEP 内嵌浏览器缓存旧页面
            el.frame.src = b + '/admin?_=' + Date.now();
            loaded = true;
        } catch (e) {
            setHint('加载失败：' + e.message);
        }
    }

    // ---------- 待处理申请数（无需口令，走 health）----------
    function fetchPending(cb) {
        cb = cb || function () {};
        try {
            var u = new URL(base() + '/api/health');
            var mod = (u.protocol === 'https:') ? https : http;
            var req = mod.get({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: u.pathname + u.search,
                timeout: 8000
            }, function (res) {
                var b = '';
                res.on('data', function (d) { b += d; });
                res.on('end', function () {
                    var j = null;
                    try { j = JSON.parse(b); } catch (e) {}
                    cb(null, j || {});
                });
            });
            req.on('error', function (e) { cb(e); });
            req.on('timeout', function () { try { req.destroy(); } catch (e) {} cb(new Error('timeout')); });
        } catch (e) { cb(e); }
    }

    function paintBadge(n) {
        n = Number(n) || 0;
        if (el.badge) {
            el.badge.textContent = n > 99 ? '99+' : String(n);
            el.badge.style.display = n > 0 ? '' : 'none';
        }
        if (el.reqCount) el.reqCount.textContent = n > 0 ? String(n) : '0';
        if (el.reqs) el.reqs.style.color = n > 0 ? '#fcd34d' : '';
        if (el.groupBtn) el.groupBtn.title = n > 0
            ? ('管理台 · ' + n + ' 条待处理申请')
            : '管理台';
    }

    function refreshPending() {
        fetchPending(function (err, j) {
            if (err) return;                 // 网络问题不打扰用户
            paintBadge(j.pendingRequests || 0);
        });
    }

    // ---------- 切到该面板时 ----------
    window.__adminPanelOnShow = function () {
        load(false);
        refreshPending();
    };

    // ---------- 按钮 ----------
    function bind() {
        pick();
        if (!el.frame) return;               // 不在主插件面板

        if (el.reload) {
            el.reload.addEventListener('click', function () {
                try { el.frame.src = 'about:blank'; } catch (e) {}
                setTimeout(function () { load(true); refreshPending(); }, 60);
            });
        }
        if (el.home) {
            el.home.addEventListener('click', function () { load(true); });
        }
        if (el.external) {
            el.external.addEventListener('click', function () {
                var url = base() + '/admin';
                try {
                    if (typeof CSInterface !== 'undefined') {
                        var cs = new CSInterface();
                        if (cs.openURLInDefaultBrowser) return cs.openURLInDefaultBrowser(url);
                    }
                } catch (e) {}
                try { require('child_process').exec('start "" "' + url + '"'); } catch (e) {}
            });
        }
        // 「申请」按钮：刷一次页面（管理台里能看到申请列表）
        if (el.reqs) {
            el.reqs.addEventListener('click', function () {
                load(true);
                refreshPending();
            });
        }

        el.frame.addEventListener('load', function () {
            setHint('授权管理台　' + base() + '/admin');
        });

        // 启动时先查一次，之后每 1 分钟刷新角标
        refreshPending();
        setInterval(refreshPending, 60000);

        // 面板若一开始就可见（记住上次 tab），主动加载
        setTimeout(function () {
            var p = document.getElementById('panel-admin');
            if (p && p.style.display !== 'none') load(false);
        }, 900);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    // 暴露给外部（便于调试）
    window.__adminPanel = {
        refreshPending: refreshPending,
        open: function () {
            if (window.__atSwitchTab) { try { window.__atSwitchTab('admin'); } catch (e) {} }
        }
    };
})();
