// vh-Atelier · 工具面板的可折叠行为
// 面板结构：<section class="pt-tool"><header class="pt-head"><div class="pt-body">
// 点标题栏展开/收起；展开状态记在 localStorage。
(function () {
    if (!document.getElementById('panel-prconv')) return;

    var KEY = 'vh_pt_open';   // 存哪些工具是展开的

    function loadOpen() {
        try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    function saveOpen(o) {
        try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {}
    }

    function setOpen(tool, head, body, on, persist) {
        body.style.display = on ? '' : 'none';
        tool.classList.toggle('pt-open', on);
        var caret = head.querySelector('.pt-caret');
        if (caret) caret.textContent = on ? '▾' : '▸';
        if (persist) {
            var o = loadOpen();
            o[tool.getAttribute('data-tool') || tool.id] = !!on;
            saveOpen(o);
        }
    }

    function init() {
        var wrap = document.querySelector('#panel-prconv .pt-wrap');
        if (!wrap) return;
        var tools = wrap.querySelectorAll('.pt-tool');
        var saved = loadOpen();

        tools.forEach(function (tool) {
            var head = tool.querySelector('.pt-head');
            var body = tool.querySelector('.pt-body');
            if (!head || !body) return;
            var key = tool.getAttribute('data-tool') || tool.id;

            // 默认：日志和转换展开，字体收起（首次使用时引导）
            var def = (key === 'conv' || key === 'log');
            var on = (saved[key] === undefined) ? def : !!saved[key];
            setOpen(tool, head, body, on, false);

            head.addEventListener('click', function (ev) {
                // 点在标题栏内的按钮上时，不触发折叠
                if (ev.target && ev.target.tagName === 'BUTTON') return;
                var now = (body.style.display === 'none');
                setOpen(tool, head, body, now, true);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
