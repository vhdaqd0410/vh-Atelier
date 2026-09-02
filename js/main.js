// vh-Atelier 整合插件 - tab 切换逻辑
(function () {
    var tabs = document.querySelectorAll('.tab');
    var panels = {
        subtitle: document.getElementById('panel-subtitle'),
        clone: document.getElementById('panel-clone'),
        sfx: document.getElementById('panel-sfx'),
        music: document.getElementById('panel-music'),
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
        // 音乐板块懒启动：切到 music 时开始监控下载目录
        if (name === 'music' && window.__musicOnShow) {
            try { window.__musicOnShow(); } catch (e) {}
        }
    }

    tabs.forEach(function (t) {
        t.addEventListener('click', function () {
            switchTab(t.dataset.tab);
        });
    });

    // 暴露给其他板块调用：字幕识别 → 字幕校对 联动时切 tab
    window.__atSwitchTab = switchTab;
})();
