// vh-Atelier 整合插件 - 两级导航切换逻辑
// 工作台（组）→ 子功能（面板）。三组：字幕(字幕识别/字幕校对)、声音(人声分离/语音克隆/音效库/音乐)、交付(多版本导出/视频下载)
(function () {
    var panels = {
        media: document.getElementById('panel-media'),
        subtitle: document.getElementById('panel-subtitle'),
        check: document.getElementById('panel-check'),
        separate: document.getElementById('panel-sep'),
        clone: document.getElementById('panel-clone'),
        sfx: document.getElementById('panel-sfx'),
        musiclib: document.getElementById('panel-musiclib'),
        music: document.getElementById('panel-music'),
        bgm: document.getElementById('panel-bgm'),
        export: document.getElementById('panel-export'),
        video: document.getElementById('panel-video'),
        progress: document.getElementById('panel-progress'),
        script: document.getElementById('panel-script'),
        shenpian: document.getElementById('panel-shenpian'),
        upscale: document.getElementById('panel-upscale'),
        prconv: document.getElementById('panel-prconv'),
        colorxml: document.getElementById('panel-colorxml'),
        todo: document.getElementById('panel-todo'),
        feedback: document.getElementById('panel-feedback'),
        admin: document.getElementById('panel-admin')
    };

    // 组定义：组名 → { members: [tab名...], default: 默认tab }
    var groups = {
        media: { members: ['media'], default: 'media' },
        progress: { members: ['progress'], default: 'progress' },
        todo: { members: ['todo'], default: 'todo' },
        sub: { members: ['subtitle', 'check'], default: 'subtitle' },
        audio: { members: ['separate', 'clone', 'sfx', 'musiclib', 'music', 'bgm'], default: 'separate' },
        deliver: { members: ['export', 'video'], default: 'export' },
        script: { members: ['script'], default: 'script' },
        shenpian: { members: ['shenpian'], default: 'shenpian' },
        upscale: { members: ['upscale'], default: 'upscale' },
        prconv: { members: ['prconv', 'colorxml'], default: 'prconv' },
        feedback: { members: ['feedback'], default: 'feedback' },
        admin: { members: ['admin'], default: 'admin' }
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
        if (name === 'bgm' && window.__bgmOnShow) {
            try { window.__bgmOnShow(); } catch (e) {}
        }
        if (name === 'video' && window.__videoOnShow) {
            try { window.__videoOnShow(); } catch (e) {}
        }
        if (name === 'sfx' && window.__sfxOnShow) {
            try { window.__sfxOnShow(); } catch (e) {}
        }
        if (name === 'progress' && window.__progressOnShow) {
            try { window.__progressOnShow(); } catch (e) {}
        }
        // 待办：切到时刷新（跨天/外部改动后回来看到最新）
        if (name === 'todo' && window.__todoOnShow) {
            try { window.__todoOnShow(); } catch (e) {}
        }
        // 剧本：切到剧本 tab 时若面板是空的（没在阅读、也没首页），渲染剧本库首页
        if (name === 'script' && window.__atShowScriptHome) {
            try { window.__atShowScriptHome(); } catch (e) {}
        }
        // 审片：切到时 iframe 若未加载则自动加载分秒帧
        if (name === 'shenpian' && window.__spAutoLoad) {
            try { window.__spAutoLoad(); } catch (e) {}
        }
        // 素材库：切到时自动刷新（保持目录状态）
        if (name === 'media' && window.__mediaOnShow) {
            try { window.__mediaOnShow(); } catch (e) {}
        }
        // 超分：切到时自动加载去字幕/超分站
        if (name === 'upscale' && window.__upscaleAutoLoad) {
            try { window.__upscaleAutoLoad(); } catch (e) {}
        }
        // 超分面板：切到时刷新序列列表
        if (name === 'upscale' && window.__enhanceOnShow) {
            try { window.__enhanceOnShow(); } catch (e) {}
        }
        // 反馈中心：切到时把 iframe 拉起来
        if (name === 'feedback' && window.__feedbackPanelOnShow) {
            try { window.__feedbackPanelOnShow(); } catch (e) {}
        }
        // 管理台：切到时把 iframe 拉起来并刷新待处理数
        if (name === 'admin' && window.__adminPanelOnShow) {
            try { window.__adminPanelOnShow(); } catch (e) {}
        }
        if (name === 'prconv' && window.__prconvOnShow) {
            try { window.__prconvOnShow(); } catch (e) {}
        }
        if (name === 'colorxml' && window.__vhColorXmlOnShow) {
            try { window.__vhColorXmlOnShow(); } catch (e) {}
        }
    }

    // 切到某个 tab（面板 + 组条 + 高亮同步）
    function switchTab(name) {
        if (!panels[name]) return;
        setTimeout(function () { try { window.__atSyncSticky && window.__atSyncSticky(); } catch (e) {} }, 0);
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

    // ---------- 启动预热：打开插件后陆续拉起本地服务 ----------
    // 目的：不再等用户点进某个板块才启动该服务，减少首次操作时的等待。
    // 策略：面板先渲染（不阻塞 UI），随后错峰预热，避免三个 node 同时抢占启动。
    function warmupServices() {
        var tasks = [
            // [名称, 全局钩子名, 延迟 ms]
            ['网易云', '__ncmEnsure', 300],
            ['短剧扒歌', '__bgmEnsure', 1200],
            ['视频下载', '__videoEnsure', 2200],
        ];
        tasks.forEach(function (t) {
            var name = t[0], hook = t[1], delay = t[2];
            setTimeout(function () {
                try {
                    var fn = window[hook];
                    if (typeof fn === 'function') {
                        var r = fn();
                        if (r && typeof r.then === 'function') {
                            r.then(function () {
                                console.log('[warmup] ' + name + ' 服务就绪');
                            }).catch(function (e) {
                                console.log('[warmup] ' + name + ' 服务未就绪: ' + (e && e.message));
                            });
                        }
                    }
                } catch (e) {
                    console.log('[warmup] ' + name + ' 预热异常: ' + (e && e.message));
                }
            }, delay);
        });
    }

    // 面板渲染完成后再预热（用 requestIdleCallback 兜底，避免与首屏争资源）
    function scheduleWarmup() {
        var run = function () { setTimeout(warmupServices, 400); };
        try {
            if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 3000 });
            else setTimeout(run, 800);
        } catch (e) { setTimeout(run, 800); }
    }
    if (document.readyState === 'complete') scheduleWarmup();
    else window.addEventListener('load', scheduleWarmup);
    // 兜底：即便 load 事件错过也要预热
    setTimeout(function () { try { warmupServices(); } catch (e) {} }, 4000);

    // ---------- 导航常驻：按真实高度校准 sticky 偏移 ----------
    // 三层导航（顶栏 / 工作台组栏 / 子标签栏）吸顶，偏移量按实际高度动态计算，
    // 避免写死像素导致字体或缩放变化时错位。
    function syncStickyOffsets() {
        try {
            var head = document.querySelector('.top-head');
            var groups = document.querySelector('.ws-groups');
            if (head) {
                var h1 = Math.ceil(head.getBoundingClientRect().height);
                document.documentElement.style.setProperty('--sticky-top-head', h1 + 'px');
                if (groups) groups.style.top = h1 + 'px';
                var h2 = groups ? Math.ceil(groups.getBoundingClientRect().height) : 0;
                document.documentElement.style.setProperty('--sticky-top-groups', (h1 + h2) + 'px');
                // 所有子标签栏统一偏移
                subTabBars.forEach(function (bar) { bar.style.top = (h1 + h2) + 'px'; });
            }
        } catch (e) {}
    }
    syncStickyOffsets();
    window.addEventListener('resize', syncStickyOffsets);
    // 顶栏内容变化（如徽标出现）后重算
    setTimeout(syncStickyOffsets, 400);
    setTimeout(syncStickyOffsets, 1500);
    window.__atSyncSticky = syncStickyOffsets;

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
