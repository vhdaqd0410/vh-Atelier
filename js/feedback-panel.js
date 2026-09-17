// vh-Atelier 反馈中心面板：在插件内嵌显示自建反馈中心网页
// 依赖：js/feedback.js（提供 cfg() 拿到 base 地址）
//
// 为什么要 iframe 而不是自己写界面：
//   反馈中心有完整的筛选/投票/改状态/回复功能，内嵌现成网页可以完全复用，
//   服务端更新界面时插件端无需跟着改。
(function () {
    var el = {
        frame: document.getElementById('fbFrame'),
        reload: document.getElementById('fbNavReload'),
        home: document.getElementById('fbNavHome'),
        external: document.getElementById('fbNavExternal'),
        hint: document.getElementById('fbNavHint'),
        submit: document.getElementById('fbNavSubmit')
    };
    if (!el.frame) return;   // 不在主插件面板里

    var loaded = false;

    function base() {
        try {
            return (window.__vhFeedback && window.__vhFeedback.cfg().base) || '';
        } catch (e) { return ''; }
    }

    function setHint(t) { if (el.hint) el.hint.textContent = t || ''; }

    function load(force) {
        var b = base();
        if (!b) { setHint('未配置反馈中心地址'); return; }
        if (loaded && !force) return;
        setHint('正在加载 ' + b + ' …');
        try {
            el.frame.src = b;
            loaded = true;
        } catch (e) {
            setHint('加载失败：' + e.message);
        }
    }

    // 面板切到时调用（由 main.js 的 lazyInit 触发）
    window.__feedbackPanelOnShow = function () { load(false); };

    if (el.reload) {
        el.reload.addEventListener('click', function () {
            // 强制重载：先置空再设回，避免同地址不刷新
            try { el.frame.src = 'about:blank'; } catch (e) {}
            setTimeout(function () { load(true); }, 60);
        });
    }
    if (el.home) {
        el.home.addEventListener('click', function () { load(true); });
    }
    if (el.external) {
        el.external.addEventListener('click', function () {
            var b = base();
            if (!b) return;
            try { require('child_process').exec('start "" "' + b + '"'); } catch (e) {}
        });
    }
    if (el.submit) {
        el.submit.addEventListener('click', function () {
            if (window.__vhFeedbackUI && window.__vhFeedbackUI.open) {
                window.__vhFeedbackUI.open();
            }
        });
    }

    // iframe 加载完成 / 失败时更新提示
    el.frame.addEventListener('load', function () {
        var b = base();
        setHint('反馈中心　' + b);
    });

    // 面板可能一开始就可见（记住上次 tab），尝试加载一次
    setTimeout(function () {
        var p = document.getElementById('panel-feedback');
        if (p && p.style.display !== 'none') load(false);
    }, 800);
})();
