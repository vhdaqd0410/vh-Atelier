// vh-Atelier 整合插件 - tab 切换逻辑
(function () {
    var tabs = document.querySelectorAll('.tab');
    var panels = {
        subtitle: document.getElementById('panel-subtitle'),
        clone: document.getElementById('panel-clone'),
        sfx: document.getElementById('panel-sfx'),
        export: document.getElementById('panel-export')
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
})();
