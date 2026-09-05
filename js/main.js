// vh-Atelier 整合插件 - 两级导航切换逻辑
// 工作台（组）→ 子功能（面板）。三组：字幕(字幕识别/字幕校对)、声音(人声分离/语音克隆/音效库/音乐)、交付(多版本导出/视频下载)
(function () {
    var panels = {
        subtitle: document.getElementById('panel-subtitle'),
        check: document.getElementById('panel-check'),
        separate: document.getElementById('panel-sep'),
        clone: document.getElementById('panel-clone'),
        sfx: document.getElementById('panel-sfx'),
        musiclib: document.getElementById('panel-musiclib'),
        music: document.getElementById('panel-music'),
        export: document.getElementById('panel-export'),
        video: document.getElementById('panel-video'),
        progress: document.getElementById('panel-progress'),
        script: document.getElementById('panel-script')
    };

    // 组定义：组名 → { members: [tab名...], default: 默认tab }
    var groups = {
        progress: { members: ['progress'], default: 'progress' },
        sub: { members: ['subtitle', 'check'], default: 'subtitle' },
        audio: { members: ['separate', 'clone', 'sfx', 'musiclib', 'music'], default: 'separate' },
        deliver: { members: ['export', 'video'], default: 'export' },
        script: { members: ['script'], default: 'script' }
    };
    // tab 归属映射
    var groupOf = {};
    Object.keys(groups).forEach(function (g) {
        groups[g].members.forEach(function (m) { groupOf[m] = g; });
    });

    var groupBtns = document.querySelectorAll('.ws-group');
    var subTabBars = document.querySelectorAll('.ws-subtabs');
    var allTabs = document.querySelectorAll('.tab');

    // 每个组当前选中哪个 tab（切走再切回能记住）
    var currentInGroup = {};
    Object.keys(groups).forEach(function (g) { currentInGroup[g] = groups[g].default; });

    // 真正显示某个 panel
    function showPanel(name) {
        Object.keys(panels).forEach(function (key) {
            panels[key].style.display = (key === name) ? '' : 'none';
        });
    }

    // 高亮子 tab（只在该 tab 所属的组条内高亮）
    function syncTabHighlight(name) {
        allTabs.forEach(function (t) {
            t.classList.toggle('active', t.dataset.tab === name);
        });
    }

    // 高亮组按钮
    function syncGroupHighlight(group) {
        groupBtns.forEach(function (b) {
            b.classList.toggle('active', b.dataset.group === group);
        });
    }

    // 显示某个组的子 tab 条
    function showGroupBar(group) {
        subTabBars.forEach(function (bar) {
            bar.style.display = (bar.dataset.group === group) ? '' : 'none';
        });
    }

    // 懒启动钩子
    function lazyInit(name) {
        if (name === 'music' && window.__musicOnShow) {
            try { window.__musicOnShow(); } catch (e) {}
        }
        if (name === 'video' && window.__videoOnShow) {
            try { window.__videoOnShow(); } catch (e) {}
        }
        if (name === 'progress' && window.__progressOnShow) {
            try { window.__progressOnShow(); } catch (e) {}
        }
        // 剧本：切到剧本 tab 时若面板是空的（没在阅读、也没首页），渲染剧本库首页
        if (name === 'script' && window.__atShowScriptHome) {
            try { window.__atShowScriptHome(); } catch (e) {}
        }
    }

    // 切到某个 tab（面板 + 组条 + 高亮同步）
    function switchTab(name) {
        if (!panels[name]) return;
        var g = groupOf[name];
        if (!g) return;
        currentInGroup[g] = name;
        showPanel(name);
        showGroupBar(g);
        syncGroupHighlight(g);
        syncTabHighlight(name);
        lazyInit(name);
    }

    // 切工作台：显示该组子 tab 条 + 切到该组记忆的 tab
    function switchGroup(g) {
        if (!groups[g]) return;
        var target = currentInGroup[g] || groups[g].default;
        switchTab(target);
    }

    // 事件：组按钮
    groupBtns.forEach(function (b) {
        b.addEventListener('click', function () {
            switchGroup(b.dataset.group);
        });
    });
    // 事件：子 tab
    allTabs.forEach(function (t) {
        t.addEventListener('click', function () {
            switchTab(t.dataset.tab);
        });
    });

    // 暴露给其他板块调用：字幕识别 → 字幕校对 联动时切 tab
    window.__atSwitchTab = switchTab;
    // 剧本工作台（常驻）：切过去并确保面板有内容；无内容时显示剧本库首页
    // 剧本库首页由 progress.js 提供（__atShowScriptHome），面板无阅读器时切到该组就展示它
    window.__atShowScriptGroup = function () {
        var btn = document.querySelector('.ws-group[data-group="script"]');
        if (btn) btn.style.display = '';
        // 若面板是空的（没有正在阅读的剧本），先渲染剧本库首页
        var panel = document.getElementById('panel-script');
        var hasReader = panel && panel.querySelector('#scriptReaderBox');
        if (panel && !hasReader && window.__atShowScriptHome) {
            try { window.__atShowScriptHome(); } catch (e) {}
        }
        switchGroup('script');
    };
    // 关闭剧本阅读：切回进度（按钮常驻，不隐藏）
    window.__atHideScriptGroup = function () {
        if (currentInGroup['script'] && groupBtns.length) {
            var active = null;
            groupBtns.forEach(function (b) { if (b.classList.contains('active')) active = b.dataset.group; });
            if (active === 'script') switchGroup('progress');
        }
        delete currentInGroup['script'];
    };
    window.__atIsScriptGroupActive = function () {
        var active = null;
        groupBtns.forEach(function (b) { if (b.classList.contains('active')) active = b.dataset.group; });
        return active === 'script';
    };
    // 供 progress.js 调用：直接切到剧本组（已渲染好内容时用）
    window.__atSwitchToScript = function () {
        switchGroup('script');
    };
})();
