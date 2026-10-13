// 运行日志浮层：顶栏 📄 按钮打开，可刷新 / 打开文件 / 清空
// 背景：这套 HTML 结构（logOverlay/logHead/logBody/logFoot）一直存在，
// 但从未有任何 JS 绑定它 —— 按钮点了没反应。这里补齐。
(function () {
    'use strict';
    if (window.__vhLogOverlay) return;

    function ready(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    function els() {
        return {
            btn: document.getElementById('btnLogView'),
            ov: document.getElementById('logOverlay'),
            body: document.getElementById('logBody'),
            path: document.getElementById('logPath'),
            close: document.getElementById('logClose'),
            refresh: document.getElementById('logRefresh'),
            open: document.getElementById('logOpen'),
            clear: document.getElementById('logClear'),
            badge: document.getElementById('logBadge')
        };
    }

    function readLog() {
        try {
            if (window.__vhLog && window.__vhLog.read) return window.__vhLog.read();
        } catch (e) {}
        return [];
    }

    function render() {
        var e = els();
        if (!e.body) return;
        var lines = readLog();
        if (!lines || !lines.length) {
            e.body.textContent = '（暂无日志）';
        } else {
            e.body.textContent = lines.join('\n');
        }
        e.body.scrollTop = e.body.scrollHeight;   // 滚到最新
        if (e.path) {
            try {
                var p = (window.__vhLog && window.__vhLog.path) ? window.__vhLog.path() : '';
                e.path.textContent = p || '';
            } catch (er) {}
        }
    }

    function openOverlay() {
        var e = els();
        if (!e.ov) return;
        e.ov.style.display = 'flex';
        render();
        // 打开即视为已读
        try {
            if (window.__vhLog && window.__vhLog.markRead) window.__vhLog.markRead();
            if (e.badge) e.badge.style.display = 'none';
        } catch (er) {}
    }
    function closeOverlay() {
        var e = els();
        if (e.ov) e.ov.style.display = 'none';
    }

    ready(function () {
        var e = els();
        if (e.btn) {
            e.btn.addEventListener('click', openOverlay);
            e.btn.title = '查看运行日志（点击打开）';
        }
        if (e.close) e.close.addEventListener('click', closeOverlay);
        // 点遮罩空白处关闭
        if (e.ov) e.ov.addEventListener('click', function (ev) {
            if (ev.target === e.ov) closeOverlay();
        });
        if (e.refresh) e.refresh.addEventListener('click', render);
        if (e.clear) e.clear.addEventListener('click', function () {
            try {
                if (window.__vhLog && window.__vhLog.clear) window.__vhLog.clear();
            } catch (er) {}
            render();
        });
        if (e.open) e.open.addEventListener('click', function () {
            try {
                if (window.__vhLog && window.__vhLog.open) window.__vhLog.open();
            } catch (er) {}
        });
        // Esc 关闭
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
                var o = els().ov;
                if (o && o.style.display !== 'none') closeOverlay();
            }
        });
    });

    window.__vhLogOverlay = { open: openOverlay, close: closeOverlay, render: render };
})();
