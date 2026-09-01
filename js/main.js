// vh-Atelier 整合插件 - tab 切换逻辑
(function () {
    var tabs = document.querySelectorAll('.tab');
    var panels = {
        subtitle: document.getElementById('panel-subtitle'),
        clone: document.getElementById('panel-clone'),
        sfx: document.getElementById('panel-sfx'),
        export: document.getElementById('panel-export'),
        check: document.getElementById('panel-check')
    };

    function switchTab(name) {
        tabs.forEach(function (t) {
            t.classList.toggle('active', t.dataset.tab === name);
        });
        Object.keys(panels).forEach(function (key) {
            panels[key].style.display = (key === name) ? '' : 'none';
        });
    }

    tabs.forEach(function (t) {
        t.addEventListener('click', function () {
            switchTab(t.dataset.tab);
        });
    });

    // 暴露给其他板块调用：字幕识别 → 字幕校对 联动时切 tab
    window.__atSwitchTab = switchTab;
})();
