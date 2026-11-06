// vh-Atelier 达芬奇版 · 顶部四按钮（官网 / 历史 / 更新 / 反馈）
// 对齐 PR 客户版行为：
//   官网 = 系统浏览器打开官网
//   历史 = 弹窗展示 changelog 全部版本
//   更新 = 检查更新并升级
//   反馈 = 切到反馈面板
(function () {
    'use strict';

    var SITE_URL = 'http://47.122.108.231:8888/';

    function $(id) { return document.getElementById(id); }

    function openSite() {
        var H = window.vhHost;
        if (H && H.openExternal) {
            try { H.openExternal(SITE_URL); return; } catch (e) {}
        }
        try { window.open(SITE_URL, '_blank'); } catch (e) {}
    }

    // ---------- 历史弹窗 ----------
    function loadChangelog() {
        // 达芬奇版：vhHost.fs 是同步垫片（readFileSync(p, enc) 带编码时直接返回字符串）。
        // 插件根从 __vhExtRoot 拿（index.html 启动时注入）。
        try {
            var root = '';
            try { if (window.__vhExtRoot) root = String(window.__vhExtRoot); } catch (e) {}
            if (!root) return Promise.resolve(null);

            var H = window.vhHost || {};
            var fsShim = H.fs;
            var p = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/changelog.json';

            // 1) 同步垫片（首选）
            if (fsShim && fsShim.readFileSync) {
                try {
                    var txt = fsShim.readFileSync(p, 'utf8');
                    if (typeof txt === 'string' && txt) {
                        return Promise.resolve(JSON.parse(txt));
                    }
                } catch (e) { /* 继续尝试异步 */ }
            }

            // 2) 异步 IPC
            if (H.readFileSync) {
                return H.readFileSync(p).then(function (r) {
                    if (!r || !r.ok) return null;
                    var s = (typeof r.data === 'string') ? r.data : (r.data && r.data.content);
                    if (!s) return null;
                    try { return JSON.parse(s); } catch (e) { return null; }
                }).catch(function () { return null; });
            }
        } catch (e) { /* 忽略 */ }
        return Promise.resolve(null);
    }

    var KIND = {
        feat: { t: '新增', c: '#7ddc9a' },
        fix: { t: '修复', c: '#f0a04a' },
        impr: { t: '改进', c: '#6cb6d8' },
        impro: { t: '改进', c: '#6cb6d8' },
        note: { t: '说明', c: '#9a9a9a' }
    };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function showHistory() {
        var old = $('chMask');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var mask = document.createElement('div');
        mask.id = 'chMask';
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:100400;'
            + 'display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';

        var box = document.createElement('div');
        box.style.cssText = 'background:#1e2229;border:1px solid #39414d;border-radius:10px;'
            + 'width:640px;max-width:100%;max-height:78vh;display:flex;flex-direction:column;'
            + 'box-shadow:0 16px 50px rgba(0,0,0,.7);';

        box.innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;padding:12px 15px;'
            + 'border-bottom:1px solid #2b3340;">'
            + '<span style="font-size:13.5px;font-weight:600;color:#e6eef6;">版本更新历史</span>'
            + '<span id="chCount" style="font-size:11px;color:#7d8794;"></span>'
            + '<button id="chClose" class="secondary mini" style="margin-left:auto;">关闭</button>'
            + '</div>'
            + '<div id="chBody" style="padding:10px 15px;overflow:auto;flex:1;'
            + 'font-size:11.5px;color:#c3cfdb;line-height:1.7;">读取中…</div>';

        mask.appendChild(box);
        document.body.appendChild(mask);

        function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
        $('chClose').addEventListener('click', close);
        mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });

        loadChangelog().then(function (j) {
            var body = $('chBody');
            var cnt = $('chCount');
            if (!j || !Array.isArray(j.versions) || !j.versions.length) {
                if (body) body.innerHTML = '<div style="color:#8a97a5;padding:14px 0;">'
                    + '读不到版本历史（changelog.json 缺失或不可读）</div>';
                return;
            }
            if (cnt) cnt.textContent = '共 ' + j.versions.length + ' 个版本';

            var html = '';
            j.versions.forEach(function (v, idx) {
                var items = (v.changes || v.items || []);
                html += '<div style="margin-bottom:' + (idx === j.versions.length - 1 ? '4px' : '16px') + ';">';
                html += '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">'
                     + '<span style="font-size:12.5px;font-weight:700;color:#8ab4ff;">v' + esc(v.version) + '</span>';
                if (v.date) html += '<span style="font-size:10.5px;color:#6f7c8a;">' + esc(v.date) + '</span>';
                if (v.title) html += '<span style="font-size:11.5px;color:#dfe9f3;">' + esc(v.title) + '</span>';
                html += '</div>';
                if (items.length) {
                    html += '<ul style="margin:5px 0 0;padding-left:16px;">';
                    items.forEach(function (it) {
                        var k = KIND[it.type] || KIND.note;
                        html += '<li style="margin:2px 0;">'
                             + '<span style="display:inline-block;min-width:32px;font-size:10px;'
                             + 'color:' + k.c + ';border:1px solid ' + k.c + '44;border-radius:3px;'
                             + 'padding:0 4px;margin-right:6px;">' + k.t + '</span>'
                             + esc(it.text) + '</li>';
                    });
                    html += '</ul>';
                }
                html += '</div>';
            });
            if (body) { body.innerHTML = html; body.scrollTop = 0; }
        });
    }

    // ---------- 更新 ----------
    function doUpdate() {
        if (typeof window.checkUpdateFlow === 'function') {
            window.checkUpdateFlow(false);
        } else {
            alert('更新功能未就绪');
        }
    }

    // ---------- 反馈 ----------
    function goFeedback() {
        try {
            if (typeof window.showPanel === 'function') {
                window.showPanel('feedback');
                return;
            }
        } catch (e) {}
        var btn = document.querySelector('.ws-group[data-group="feedback"]');
        if (btn) btn.click();
    }

    function bind() {
        var bSite = $('btnSite');
        if (bSite) bSite.addEventListener('click', openSite);

        var bHis = $('btnHistory');
        if (bHis) bHis.addEventListener('click', showHistory);

        var bUpd = $('btnUpdate');
        if (bUpd) bUpd.addEventListener('click', doUpdate);

        var bFb = $('btnFeedback');
        if (bFb) bFb.addEventListener('click', goFeedback);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        setTimeout(bind, 60);
    }

    window.__vhTopBar = { openSite: openSite, showHistory: showHistory, doUpdate: doUpdate, goFeedback: goFeedback };
})();
