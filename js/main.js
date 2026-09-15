// vh-Atelier 整合插件 - 两级导航切换逻辑
// 工作台（组）→ 子功能（面板）。三组：字幕(字幕识别/字幕校对)、声音(人声分离/语音克隆/音效库/音乐)、交付(多版本导出/视频下载)
(function () {
    var panels = {
        subtitle: document.getElementById('panel-subtitle'),
        check: document.getElementById('panel-check'),
        clone: document.getElementById('panel-clone'),
    };

    // 组定义：组名 → { members: [tab名...], default: 默认tab }
    var groups = {
        sub: { members: ['subtitle', 'check'], default: 'subtitle' },
        audio: { members: ['clone'], default: 'clone' }
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
        // 待办：切到时刷新（跨天/外部改动后回来看到最新）
        // 剧本：切到剧本 tab 时若面板是空的（没在阅读、也没首页），渲染剧本库首页
        // 审片：切到时 iframe 若未加载则自动加载分秒帧
        // 素材库：切到时自动刷新（保持目录状态）
        // 超分：切到时自动加载去字幕/超分站
        // 超分面板：切到时刷新序列列表
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
})();
