// vh-Atelier 板块八：项目进度（联动「视频工作台」只读快照）
// 数据源：视频工作台 Flask 服务（127.0.0.1:8089），token 在 backend/config.yaml 的 web.api_secret
// 本面板只读展示：本月概览 + 组内进行中项目（集数进度/状态/剧名）
(function () {
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var child_process = require('child_process');
    var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;

    var WB_PORT = 8089;
    var WB_BASE = 'http://127.0.0.1:' + WB_PORT;
    // 视频工作台位置：不写死用户名/盘符，按候选列表自动探测第一个存在的工作台目录。
    // 优先级：localStorage 手动指定 > 常见位置的自动探测。
    var CFG_MEM_KEY = 'vh_progress_wb_yaml';

    // 探测视频工作台根目录（含 main_desktop.py 或 backend/config.yaml 的那个目录）
    function detectWbDir() {
        // 1) 用户手动指定过 config.yaml 路径 → 用它反推工作台根目录
        try {
            var saved = localStorage.getItem(CFG_MEM_KEY);
            if (saved) {
                var dir = saved.replace(/[/\\]backend[/\\]config\.yaml$/i, '')
                              .replace(/[/\\]config\.yaml$/i, '');
                if (dir && fs.existsSync(dir)) return dir;
            }
        } catch (e) {}

        // 2) 常见位置候选（用户目录下的桌面 / 各盘根目录 / 旧的固定位置）
        var cands = [];
        try {
            var home = os.homedir();
            cands.push(path.join(home, 'Desktop', '视频工作台'));
            cands.push(path.join(home, '桌面', '视频工作台'));
        } catch (e) {}
        ['C:', 'D:', 'E:', 'F:'].forEach(function (drv) {
            cands.push(drv + '\\视频工作台');
            cands.push(drv + '\\OH-WorkSpace\\视频工作台');
            cands.push(drv + '\\OH-WorkSpace\\projects\\视频工作台');
            cands.push(drv + '\\tools\\视频工作台');
        });
        for (var i = 0; i < cands.length; i++) {
            try {
                if (fs.existsSync(path.join(cands[i], 'backend', 'config.yaml'))) return cands[i];
            } catch (e) {}
        }
        // 3) 都没找到 → 退回用户桌面的默认位置（保持原行为，便于报错提示）
        try { return path.join(os.homedir(), 'Desktop', '视频工作台'); } catch (e) {}
        return '视频工作台';
    }

    var WB_DIR = detectWbDir();
    var WB_CFG_PATH = path.join(WB_DIR, 'backend', 'config.yaml').replace(/\\/g, '/');
    var WB_START = path.join(WB_DIR, 'start_desktop.vbs').replace(/\\/g, '/');
    // 兜底：找不到 start_desktop.vbs 时用 main_desktop.py + pythonw
    var WB_PY = path.join(WB_DIR, 'main_desktop.py').replace(/\\/g, '/');
    // 插件根目录（js/ 的上一级），供定位 py/ 等资源
    var extRoot = (function () {
        try {
            if (typeof __dirname !== 'undefined') {
                var d = __dirname;
                return path.basename(d).toLowerCase() === 'js' ? path.dirname(d) : d;
            }
        } catch (e) {}
        return '';
    })();

    // DOM
    var el = {
        dot: document.getElementById('prgDot'),
        statusText: document.getElementById('prgStatusText'),
        refresh: document.getElementById('prgRefresh'),
        scanAll: document.getElementById('prgScanAll'),
        overview: document.getElementById('prgOverview'),
        mProducing: document.getElementById('prgMProducing'),
        mActive: document.getElementById('prgMActive'),
        mDone: document.getElementById('prgMDone'),
        mLeft: document.getElementById('prgMLeft'),
        offline: document.getElementById('prgOffline'),
        launch: document.getElementById('prgLaunch'),
        retry: document.getElementById('prgRetry'),
        activeWrap: document.getElementById('prgActiveWrap'),
        activeCount: document.getElementById('prgActiveCount'),
        activeList: document.getElementById('prgActiveList'),
        filterState: document.getElementById('prgFilterState'),
        filterProgress: document.getElementById('prgFilterProgress'),
        search: document.getElementById('prgSearch')
    };

    var busy = false;
    var lastData = null;
    var allActiveProjects = [];   // 最近一次拉到的 group_active 全量（供筛选/排序）

    // ===== 可视诊断：把点击/播放链路每步状态写进面板顶部，不再静默 =====
    function dbg(msg) {
        try {
            el.statusText.textContent = msg;
        } catch (e) {}
        try { console.log('[vh-dbg] ' + msg); } catch (e) {}
    }
    // 全局错误捕获：任何未捕获异常都显示出来
    try {
        window.addEventListener('error', function (ev) {
            try {
                var m = (ev && ev.message) || 'unknown';
                dbg('⚠️ 脚本错误: ' + m + (ev && ev.filename ? ' @' + ev.filename.split('/').pop() + ':' + ev.lineno : ''));
            } catch (e) {}
        });
    } catch (e) {}

    // 工作流状态排序权重（越小越靠前 = 越接近交付越优先展示）
    var STATE_ORDER = ['剪辑中', '分集中', '制作中', '审核中', '修改中', '交付中', '质检中', '已完成'];
    function stateWeight(st) {
        st = st || '';
        for (var i = 0; i < STATE_ORDER.length; i++) {
            if (st.indexOf(STATE_ORDER[i]) >= 0) return i;
        }
        return 99;
    }
    // 工作流步骤数（用于筛选下拉的有序去重）
    function stateGroup(st) {
        st = st || '';
        for (var i = 0; i < STATE_ORDER.length; i++) {
            if (st.indexOf(STATE_ORDER[i]) >= 0) return STATE_ORDER[i];
        }
        return '其他';
    }

    function setOnline(on, msg) {
        el.dot.className = 'prg-dot ' + (on ? 'on' : 'off');
        el.statusText.textContent = msg || (on ? '视频工作台在线' : '视频工作台离线');
        el.offline.style.display = on ? 'none' : '';
        el.overview.style.display = on ? '' : 'none';
        el.activeWrap.style.display = on ? '' : 'none';
        if (!on) {
            el.overview.style.display = 'none';
            el.activeWrap.style.display = 'none';
        }
    }

    // 读视频工作台 config.yaml 取 api_secret
    function readSecret() {
        var p = WB_CFG_PATH;
        try { p = localStorage.getItem(CFG_MEM_KEY) || WB_CFG_PATH; } catch (e) {}
        try {
            if (!fs.existsSync(p)) return null;
            var raw = fs.readFileSync(p, 'utf8');
            // 只取 web: 段下的 api_secret（避免匹配到别的 yaml 里的同名字段）
            var m = raw.match(/api_secret\s*:\s*["']?([A-Za-z0-9_\-]+)/);
            return m ? m[1] : null;
        } catch (e) {
            return null;
        }
    }

    // 拉取项目数据
    function fetchProjects(cb) {
        var secret = readSecret();
        if (!secret) { cb(new Error('读不到 api_secret（config.yaml 路径不对？）'), null); return; }
        var url = WB_BASE + '/api/projects?key=' + encodeURIComponent(secret);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 8000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try {
                    cb(null, JSON.parse(xhr.responseText));
                } catch (e) {
                    cb(new Error('解析失败'), null);
                }
            } else if (xhr.status === 401) {
                cb(new Error('鉴权失败（api_secret 过期？请重启视频工作台）'), null);
            } else {
                cb(new Error('HTTP ' + xhr.status), null);
            }
        };
        xhr.onerror = function () { cb(new Error('网络错误'), null); };
        xhr.ontimeout = function () { cb(new Error('超时'), null); };
        xhr.send();
    }

    // 通用带鉴权的 API GET（相对 /api/ 路径）
    function apiGet(sub, cb) {
        var secret = readSecret();
        if (!secret) { cb(new Error('读不到 api_secret（config.yaml 路径不对？）'), null); return; }
        var url = WB_BASE + sub + (sub.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(secret);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 20000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try { cb(null, JSON.parse(xhr.responseText)); }
                catch (e) { cb(new Error('解析失败'), null); }
            } else if (xhr.status === 401) {
                cb(new Error('鉴权失败（api_secret 过期？请重启视频工作台）'), null);
            } else {
                cb(new Error('HTTP ' + xhr.status), null);
            }
        };
        xhr.onerror = function () { cb(new Error('网络错误'), null); };
        xhr.ontimeout = function () { cb(new Error('超时'), null); };
        xhr.send();
    }

    // 通用带鉴权的 API POST（JSON body）
    function apiPost(sub, bodyObj, cb) {
        var secret = readSecret();
        if (!secret) { cb(new Error('读不到 api_secret（config.yaml 路径不对？）'), null); return; }
        var url = WB_BASE + sub + (sub.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(secret);
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.timeout = 20000;
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try { cb(null, JSON.parse(xhr.responseText)); }
                catch (e) { cb(new Error('解析失败'), null); }
            } else if (xhr.status === 401) {
                cb(new Error('鉴权失败（api_secret 过期？请重启视频工作台）'), null);
            } else {
                cb(new Error('HTTP ' + xhr.status), null);
            }
        };
        xhr.onerror = function () { cb(new Error('网络错误'), null); };
        xhr.ontimeout = function () { cb(new Error('超时'), null); };
        xhr.send(JSON.stringify(bodyObj || {}));
    }

    // 状态标签样式映射
    function stateClass(st) {
        st = st || '';
        if (st.indexOf('审核') >= 0) return 'st-review';
        if (st.indexOf('修改') >= 0) return 'st-modify';
        if (st.indexOf('交付') >= 0) return 'st-deliver';
        if (st.indexOf('剪辑') >= 0 || st.indexOf('制作') >= 0) return 'st-edit';
        return 'st-other';
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // 渲染概览
    function renderOverview(stats) {
        if (!stats) return;
        var producing = stats.producing != null ? stats.producing : 0;
        var done = stats.this_month_done != null ? stats.this_month_done : 0;
        var left = stats.last_month_left != null ? stats.last_month_left : 0;
        // 本月项目 = 制作中 + 已完成（本月涉及的项目总数）
        var monthTotal = producing + done;
        if (el.mLeft) el.mLeft.textContent = left > 0 ? left : '-';
        el.mProducing.textContent = monthTotal > 0 ? monthTotal : '-';
        el.mActive.textContent = producing > 0 ? producing : '-';
        el.mDone.textContent = done > 0 ? done : '-';
    }

    // 渲染组内进行中项目
    function renderActive(sections) {
        // 保存全量 group_active（供筛选/排序）
        var sec = null;
        (sections || []).forEach(function (s) { if (s && s.key === 'group_active') sec = s; });
        allActiveProjects = sec ? (sec.projects || []) : [];
        el.activeWrap.style.display = allActiveProjects.length ? '' : 'none';
        el.activeCount.textContent = allActiveProjects.length ? '共 ' + allActiveProjects.length + ' 个' : '';
        fillStateFilter();
        renderFilteredList();
    }

    // 填充状态筛选下拉（按工作流顺序去重）
    function fillStateFilter() {
        var seen = [];
        var cur = el.filterState.value;
        allActiveProjects.forEach(function (p) {
            var g = stateGroup(p.custom_status || '');
            if (seen.indexOf(g) < 0) seen.push(g);
        });
        seen.sort(function (a, b) {
            var ia = STATE_ORDER.indexOf(a), ib = STATE_ORDER.indexOf(b);
            if (a === '其他') return 1;
            if (b === '其他') return -1;
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        // 仅在选项集合变化时重建（避免打断用户选择）
        var needRebuild = false;
        var opts = el.filterState.querySelectorAll('option');
        var names = [];
        for (var i = 1; i < opts.length; i++) names.push(opts[i].value);
        if (names.length !== seen.length) needRebuild = true;
        else for (var j = 0; j < seen.length; j++) if (names[j] !== seen[j]) { needRebuild = true; break; }
        if (!needRebuild) return;
        el.filterState.innerHTML = '<option value="">全部状态</option>';
        seen.forEach(function (s) {
            var o = document.createElement('option');
            o.value = s;
            o.textContent = s;
            el.filterState.appendChild(o);
        });
        if (cur && seen.indexOf(cur) >= 0) el.filterState.value = cur;
    }

    // 应用筛选 + 排序后渲染
    function renderFilteredList() {
        var fState = el.filterState.value;
        var fProgress = el.filterProgress.checked;
        var kw = (el.search && (el.search.value || '').trim().toLowerCase()) || '';
        var list = allActiveProjects.filter(function (p) {
            if (kw) {
                var hay = String(p.name || '').toLowerCase();
                var kws = kw.split(/[\s,，]+/).filter(Boolean);
                var allHit = kws.every(function (k) { return hay.indexOf(k) >= 0; });
                if (!allHit) return false;
            }
            if (fState && stateGroup(p.custom_status || '') !== fState) return false;
            if (fProgress) {
                var cur = parseInt(p.current_episodes, 10) || 0;
                // 剪辑中项目总会实扫，视作有进度；其余按 DB 值判断
                var isClipSt = (p.custom_status || '').indexOf('剪辑') >= 0;
                if (cur <= 0 && !isClipSt) return false;
            }
            return true;
        });
        // 排序：状态工作流权重 + 同状态集数进度降序（进度高=更接近完成=靠前）
        list.sort(function (a, b) {
            var wa = stateWeight(a.custom_status || ''), wb = stateWeight(b.custom_status || '');
            if (wa !== wb) return wa - wb;
            var ca = parseInt(a.current_episodes, 10) || 0;
            var cb = parseInt(b.current_episodes, 10) || 0;
            var ta = parseInt(a.total_episodes, 10) || 0;
            var tb = parseInt(b.total_episodes, 10) || 0;
            var pa = ta > 0 ? ca / ta : 0;
            var pb = tb > 0 ? cb / tb : 0;
            return pb - pa;
        });
        el.activeCount.textContent = '共 ' + list.length + ' 个' + (list.length !== allActiveProjects.length ? '（筛选中）' : '');
        el.activeList.innerHTML = '';
        if (list.length === 0) {
            el.activeList.innerHTML = '<div class="prg-empty">没有符合条件的项目</div>';
            return;
        }
        list.forEach(function (p) {
            var cur = parseInt(p.current_episodes, 10) || 0;
            var total = parseInt(p.total_episodes, 10) || 0;
            var pct = total > 0 ? Math.min(100, Math.round(cur / total * 100)) : 0;
            var state = p.custom_status || '';
            var isClip = state.indexOf('剪辑') >= 0;
            var safeId = String(p.name || '').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_');

            var item = document.createElement('div');
            item.className = 'prg-item';
            item.setAttribute('data-proj', p.name || '');
            var head = document.createElement('div');
            head.className = 'prg-item-head';
            var nm = document.createElement('div');
            nm.className = 'prg-item-name';
            nm.textContent = p.name || '';
            nm.title = p.name || '（点 📋 复制全名）';
            nm.dataset.fullname = p.name || '';
            var cpBtn = document.createElement('button');
            cpBtn.type = 'button';
            cpBtn.className = 'prg-copy-name';
            cpBtn.textContent = '📋';
            cpBtn.title = '复制项目全名';
            cpBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                var full = (nm.dataset.fullname || '');
                window.__copyText ? window.__copyText(full) : null;
                if (window.__copyFlash) {
                    try { window.__copyFlash(full ? '已复制项目名' : ''); } catch (e) {}
                } else {
                    try { el.statusText.textContent = full ? '已复制：' + full : ''; } catch (e) {}
                }
            });
            var tag = document.createElement('span');
            tag.className = 'prg-state ' + stateClass(state);
            tag.textContent = state || '待同步';
            head.appendChild(nm);
            head.appendChild(cpBtn);
            head.appendChild(tag);
            item.appendChild(head);

            var bar = document.createElement('div');
            bar.className = 'prg-bar';
            var fill = document.createElement('div');
            fill.className = 'prg-bar-fill' + (pct >= 100 && total > 0 ? ' prg-done' : '');
            fill.style.width = pct + '%';
            bar.appendChild(fill);
            item.appendChild(bar);

            var foot = document.createElement('div');
            foot.className = 'prg-item-foot';
            var ep = document.createElement('span');
            ep.className = 'prg-ep-text';
            ep.setAttribute('data-proj', p.name || '');
            // 剪辑中项目：DB 缓存 current_episodes 不可靠，初始显示待扫描，等实扫回填
            if (isClip && total > 0) {
                ep.textContent = '待扫描…';
                ep.title = '点「🔄 刷新」或稍候自动扫描输出目录';
            } else {
                ep.textContent = total > 0 ? (cur + ' / ' + total + ' 集 · ' + pct + '%') : '未设总集数';
            }
            var meta = document.createElement('span');
            meta.className = 'prg-item-sub';
            meta.textContent = (p.source_department || p.department || '') + (p.project_month ? ' · ' + p.project_month : '');
            foot.appendChild(ep);
            foot.appendChild(meta);
            item.appendChild(foot);

            // 缺集摘要行（刷新后填充，剪辑中项目实扫后显示谁缺哪几集）
            var missRow = document.createElement('div');
            missRow.className = 'prg-miss-row';
            missRow.style.display = 'none';
            item.appendChild(missRow);

            // 操作区：主操作行（明细/查剪辑/刷新） + 辅助操作行（目录/素材/剧本/跳转）
            var openRow = document.createElement('div');
            openRow.className = 'prg-open-row';
            var opsMain = document.createElement('div');
            opsMain.className = 'prg-ops-main';
            var opsMore = document.createElement('div');
            opsMore.className = 'prg-ops-more';
            openRow.appendChild(opsMain);
            openRow.appendChild(opsMore);

            // 🔍 查剪辑：输入集号查该集剪辑师（或反查）
            var searchBtn = document.createElement('button');
            searchBtn.type = 'button';
            searchBtn.className = 'prg-open-btn';
            searchBtn.textContent = '🔍 查剪辑';
            searchBtn.title = '输入集号查谁剪的，或点剪辑师看他负责哪些集';
            searchBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openEpSearch(p);
            });
            opsMain.appendChild(searchBtn);

            // 📋 缺集/成片/修改/交付 明细浮层（核心操作）
            var detBtn = document.createElement('button');
            detBtn.type = 'button';
            detBtn.className = 'prg-open-btn prg-btn-primary';
            detBtn.textContent = '📋 明细';
            detBtn.title = '缺集明细 + 成片列表 + 修改 + 交付预览';
            detBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openProjectDetail(p);
            });
            opsMain.appendChild(detBtn);


            // 🔄 刷新进度：仅剪辑中项目，扫描磁盘实算已剪集数
            if (isClip) {
                var rfBtn = document.createElement('button');
                rfBtn.type = 'button';
                rfBtn.className = 'prg-open-btn prg-refresh-btn';
                rfBtn.textContent = '🔄 刷新';
                rfBtn.title = '扫描项目输出目录，刷新已剪辑集数';
                rfBtn.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    refreshProject(p.name || '');
                });
                opsMain.appendChild(rfBtn);
            }

            // 📁 组内NAS
            if (p.group_path) {
                var gBtn = document.createElement('button');
                gBtn.type = 'button';
                gBtn.className = 'prg-open-btn prg-ops-icon';
                gBtn.textContent = '📁 组内';
                gBtn.title = '打开组内 NAS 项目目录';
                gBtn.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    openProjFolder(p.name || '', 'group_root');
                });
                opsMore.appendChild(gBtn);
            }

            // 🏢 制作部
            if (p.production_path) {
                var pBtn = document.createElement('button');
                pBtn.type = 'button';
                pBtn.className = 'prg-open-btn prg-ops-icon';
                pBtn.textContent = '🏢 制作部';
                pBtn.title = '打开制作部项目目录';
                pBtn.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    openProjFolder(p.name || '', 'prod');
                });
                opsMore.appendChild(pBtn);
            }

            var scriptBtn = document.createElement('button');
            scriptBtn.type = 'button';
            scriptBtn.className = 'prg-open-btn prg-ops-icon';
            scriptBtn.textContent = '📖 剧本';
            scriptBtn.title = '在本地项目里找剧本并阅读';
            scriptBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                window.__vhScript && window.__vhScript.openScriptForProject(p.name || '');
            });
            opsMore.appendChild(scriptBtn);
            var impBtn = document.createElement('button');
            impBtn.type = 'button';
            impBtn.className = 'prg-open-btn prg-ops-icon';
            impBtn.textContent = '📥 素材';
            impBtn.title = '把该项目的本地素材(01原素材)一键导入当前 PR 工程素材箱';
            impBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                importMaterialsForProject(p.name || '');
            });
            opsMore.appendChild(impBtn);
            var openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.className = 'prg-open-btn prg-ops-icon';
            openBtn.textContent = '↗ 工作台';
            openBtn.title = '跳转视频工作台并定位到该项目';
            openBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openInWorkbench(p.name || '');
            });
            opsMore.appendChild(openBtn);

            // 🔗 分秒帧：点开该项目的分秒帧审核页（无链接先填）
            var fmBtn = document.createElement('button');
            fmBtn.type = 'button';
            fmBtn.className = 'prg-open-btn prg-fm-btn prg-ops-icon';
            fmBtn.textContent = '🔗 分秒帧';
            fmBtn.title = '打开该项目的分秒帧审核页；Shift+点击可修改链接';
            fmBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openFenmiaozhen(p.name || '', ev.shiftKey);
            });
            opsMore.appendChild(fmBtn);
            item.appendChild(openRow);

            el.activeList.appendChild(item);
        });
    }

    // 分秒帧：读取链接 → 有则切审片板块并导航；无则提示填写后保存再导航
    function openFenmiaozhen(projectName, forceEdit) {
        var enc = encodeURIComponent(projectName);
        apiGet('/api/fenmiaozhen/link/' + enc, function (err, d) {
            if (err) {
                el.statusText.textContent = '读取分秒帧链接失败：' + err.message;
                return;
            }
            var cur = (d && d.url) || '';
            if (cur && !forceEdit) {
                gotoFm(projectName, cur);
                return;
            }
            // 无链接或强制修改：填/改链接
            var entered = window.prompt(cur ? '修改该项目分秒帧审核链接：' : '填写该项目分秒帧审核链接：', cur || 'https://app.mediatrack.cn/');
            if (!entered) return;
            entered = String(entered).trim();
            if (!entered) return;
            apiPost('/api/fenmiaozhen/link/' + enc, { url: entered }, function (err2, d2) {
                if (err2) { el.statusText.textContent = '保存链接失败：' + err2.message; return; }
                if (d2 && d2.ok) {
                    el.statusText.textContent = '✅ 分秒帧链接已保存';
                    gotoFm(projectName, d2.url || entered);
                } else {
                    el.statusText.textContent = '保存失败：' + ((d2 && d2.msg) || '');
                }
            });
        });
    }

    // 切到审片板块并导航 iframe 到分秒帧项目页
    function gotoFm(projectName, url) {
        try {
            var fr = document.getElementById('spFrame');
            if (fr) fr.src = url;   // 先设 src，避免切 tab 时 __spAutoLoad 用首页覆盖
            if (window.__atSwitchTab) window.__atSwitchTab('shenpian');
        } catch (e) {
            // CEP 里跨域 iframe 导航失败则提示手动打开
            el.statusText.textContent = '已保存，请到审片板块查看：' + url;
        }
    }

    // 单个项目刷新进度（扫描磁盘，更新本卡片进度条）
    function refreshProject(projectName) {
        var btn = null;
        var items = el.activeList.querySelectorAll('.prg-item');
        for (var i = 0; i < items.length; i++) {
            if ((items[i].getAttribute('data-proj') || '') === projectName) {
                btn = items[i].querySelector('.prg-refresh-btn');
                break;
            }
        }
        if (btn) { btn.disabled = true; btn.textContent = '扫描中…'; }
        var url = '/api/project/' + encodeURIComponent(projectName) + '/episodes_status';
        apiGet(url, function (err, data) {
            if (btn) { btn.disabled = false; btn.textContent = '🔄 刷新'; }
            if (err) {
                el.statusText.textContent = '刷新失败：' + err.message;
                return;
            }
            applyScanToCard(projectName, data);
            el.statusText.textContent = '已刷新：' + projectName;
        });
    }

    // 把磁盘实扫结果应用到对应卡片（进度条 + 文字）
    function applyScanToCard(projectName, data) {
        if (!data || !data.ok) return;
        var total = parseInt(data.total, 10) || 0;
        var cur = parseInt(data.current_count, 10) || 0;
        var pct = total > 0 ? Math.min(100, Math.round(cur / total * 100)) : 0;
        var items = el.activeList.querySelectorAll('.prg-item');
        var item = null;
        for (var i = 0; i < items.length; i++) {
            if ((items[i].getAttribute('data-proj') || '') === projectName) { item = items[i]; break; }
        }
        if (!item) return;
        var fill = item.querySelector('.prg-bar-fill');
        if (fill) {
            fill.style.width = pct + '%';
            fill.className = 'prg-bar-fill' + (pct >= 100 && total > 0 ? ' prg-done' : '');
        }
        var epTxt = item.querySelector('.prg-ep-text');
        if (epTxt) {
            epTxt.textContent = total > 0 ? (cur + ' / ' + total + ' 集 · ' + pct + '%') : '未设总集数';
            // 缺集提示
            var missing = (data.missing || []).length;
            if (total > 0 && missing > 0) {
                epTxt.title = '缺 ' + missing + ' 集：' + (data.missing || []).join(', ');
            }
        }
        // 缺集摘要行：谁缺哪几集（分组显示）
        var missRow = item.querySelector('.prg-miss-row');
        if (missRow) {
            var missArr = data.missing || [];
            if (total > 0 && missArr.length > 0) {
                var planMap = data.editor_plan || {};
                var mgroups = {};
                missArr.forEach(function (ep) {
                    var ed = planMap[String(ep)] || planMap[ep] || '未分配';
                    if (!mgroups[ed]) mgroups[ed] = [];
                    mgroups[ed].push(parseInt(ep, 10));
                });
                var parts = [];
                Object.keys(mgroups).forEach(function (ed) {
                    parts.push(esc(ed) + ' 缺 ' + compactEpList(mgroups[ed]));
                });
                missRow.innerHTML = '⚠️ ' + parts.join('　');
                missRow.style.display = 'block';
                missRow.title = '点「📋 明细」看完整缺集 + 成片 + 修改';
            } else {
                missRow.style.display = 'none';
                missRow.innerHTML = '';
            }
        }
    }

    // 批量扫描全部剪辑中项目，用实扫值覆盖 DB 缓存值；showUi 时带按钮反馈
    function batchScanClipProjects(showUi) {
        var names = [];
        allActiveProjects.forEach(function (p) {
            if ((p.custom_status || '').indexOf('剪辑') >= 0) names.push(p.name);
        });
        if (names.length === 0) {
            if (showUi) el.statusText.textContent = '没有剪辑中的项目可扫描';
            return;
        }
        if (showUi && el.scanAll) { el.scanAll.disabled = true; el.scanAll.textContent = '扫描中…'; }
        apiPost('/api/projects/episodes_status_batch', { names: names }, function (err, data) {
            if (showUi && el.scanAll) { el.scanAll.disabled = false; el.scanAll.textContent = '⚡ 一键刷新进度'; }
            if (err) {
                if (showUi) el.statusText.textContent = '扫描失败：' + err.message;
                return;
            }
            var results = (data && data.results) || {};
            var okN = 0;
            names.forEach(function (n) {
                if (results[n] && results[n].ok) { applyScanToCard(n, results[n]); okN++; }
            });
            el.statusText.textContent = '已刷新 ' + okN + '/' + names.length + ' 个剪辑中项目 · ' + new Date().toLocaleTimeString();
        });
    }

    // 打开项目目录（which: group_root=组内NAS / prod=制作部）
    function openProjFolder(projectName, which) {
        apiPost('/api/project/' + encodeURIComponent(projectName) + '/open_folder', { which: which }, function (err, data) {
            if (err) { el.statusText.textContent = '打开失败：' + err.message; return; }
            if (data && data.ok) {
                el.statusText.textContent = '已打开：' + (data.message || projectName);
            } else {
                el.statusText.textContent = (data && data.message) || '打开失败';
            }
        });
    }

    // 导入素材到当前 PR 工程素材箱（保留目录结构：按相对根目录分组 → meImportTreePlanStr）
    function importMaterialsForProject(projectName) {
        if (!csInterface) {
            el.statusText.textContent = '当前非 PR 环境，无法导入素材箱';
            return;
        }
        el.statusText.textContent = '正在获取「' + projectName + '」的本地素材...';
        apiGet('/api/project/' + encodeURIComponent(projectName) + '/local_materials', function (err, d) {
            if (err) { el.statusText.textContent = '获取素材失败：' + err.message; return; }
            var files = (d && d.files) || [];
            if (!files.length) {
                el.statusText.textContent = '该项目暂无本地素材（可能尚未创建本地项目）';
                return;
            }
            el.statusText.textContent = '正在导入 ' + files.length + ' 个素材（保留目录结构）...';
            // 根目录 = material_dir（后端返回），其余文件路径相对它分组
            var matRoot = (d && d.material_dir) || '';
            var groups = [];
            var byRel = {};
            if (matRoot && fs.existsSync(matRoot)) {
                files.forEach(function (fp) {
                    if (!fp) return;
                    var rel = path.relative(matRoot, fp);
                    var parts = rel.split(path.sep);
                    parts.pop();  // 去掉文件名
                    var key = parts.join('/');
                    if (!byRel[key]) byRel[key] = { relPath: parts.filter(Boolean), files: [] };
                    byRel[key].files.push(fp);
                });
                Object.keys(byRel).forEach(function (k) { groups.push(byRel[k]); });
            } else {
                // 无根目录信息：全部平铺到根
                groups = [{ relPath: [], files: files }];
            }
            // 进度弹窗（共享素材面板的模态）
            var M = window.__vhImportModal;
            var totalN = groups.reduce(function (n, g) { return n + (g.files || []).length; }, 0);
            try { if (M) M.open('正在导入素材到「原素材」素材箱…'); if (M) M.progress(5, '准备导入 ' + totalN + ' 个文件（保留目录结构）…'); } catch (e) {}
            var payload = JSON.stringify({ binName: '原素材', groups: groups });
            csInterface.evalScript('meImportPayload = ' + payload + ';', function () {
                csInterface.evalScript('meImportTreePlanStr()', function (result) {
                    try {
                        var r = JSON.parse(result);
                        if (r && r.ok) {
                            var s = r.stats || {};
                            var okN = s.ok || 0, failN = s.fail || 0;
                            if (M) M.progress(100, '');
                            var fails = (r.failed || []).slice(0, 10).join('\n');
                            var det = failN ? '失败明细：\n' + fails + (failN > 10 ? '\n…共 ' + failN + ' 个失败' : '') : '全部成功';
                            if (M) { M.result('✅ 导入完成', '成功 ' + okN + ' 个\n失败 ' + failN + ' 个\n\n' + det); }
                            el.statusText.textContent = '✅ 已导入 ' + okN + ' 个素材到「原素材」（保留目录结构）' + (failN ? '，失败 ' + failN : '');
                        } else {
                            if (M) M.close();
                            var msg = (r && r.error) || '导入失败';
                            if (M) M.result('⚠ 导入失败', msg); else el.statusText.textContent = msg;
                        }
                    } catch (e) {
                        if (M) M.close();
                        if (M) M.result('⚠ 导入失败', e.message); else el.statusText.textContent = '导入解析失败: ' + result;
                    }
                });
            });
        });
    }

    // 查剪辑浮层：输入集号查该集剪辑师；点剪辑师名反查其负责集数
    var _epSearchOverlay = null;
    function openEpSearch(p) {
        var projectName = p.name || '';
        if (_epSearchOverlay) { _epSearchOverlay.remove(); _epSearchOverlay = null; }
        var planStr = p.episode_plan || p.episodes_plan || '{}';
        var plan = {};
        try { plan = typeof planStr === 'string' ? JSON.parse(planStr) : planStr; } catch (e) { plan = {}; }
        if (!plan || typeof plan !== 'object' || Array.isArray(plan)) plan = {};

        var overlay = document.createElement('div');
        overlay.className = 'prg-modal-mask';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.className = 'prg-modal';
        box.style.cssText = 'background:var(--panel,#1e1e1e);border:1px solid var(--border,#3a3a3a);border-radius:10px;width:340px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.4);';
        var totalCnt = Object.keys(plan).length;
        var head = document.createElement('div');
        head.style.cssText = 'padding:10px 14px;background:var(--panel2,#242424);border-bottom:1px solid var(--border,#333);display:flex;align-items:center;gap:6px;';
        var title = document.createElement('span');
        title.style.cssText = 'flex:1;font-size:12px;font-weight:600;color:var(--text,#e8e8e8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        title.textContent = '🔍 查剪辑 · ' + projectName;
        title.title = projectName;
        var xBtn = document.createElement('button');
        xBtn.type = 'button';
        xBtn.textContent = '✕';
        xBtn.style.cssText = 'background:none;border:none;color:var(--muted,#999);font-size:14px;cursor:pointer;padding:2px 6px;';
        head.appendChild(title);
        head.appendChild(xBtn);
        box.appendChild(head);

        var body = document.createElement('div');
        body.style.cssText = 'padding:12px 14px;overflow-y:auto;';
        var info = document.createElement('div');
        info.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:8px;word-break:break-all;';
        info.textContent = totalCnt > 0 ? ('已登记 ' + totalCnt + ' 集') : '未登记分集数据';
        body.appendChild(info);
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
        var inp = document.createElement('input');
        inp.type = 'number';
        inp.min = '1';
        inp.placeholder = '输入集号，如 12';
        inp.style.cssText = 'flex:1;min-width:0;background:var(--bg,#111);color:var(--text,#ddd);border:1px solid var(--border,#444);border-radius:4px;padding:5px 8px;font-size:12px;';
        var goBtn = document.createElement('button');
        goBtn.type = 'button';
        goBtn.textContent = '查询';
        goBtn.style.cssText = 'background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;';
        row.appendChild(inp);
        row.appendChild(goBtn);
        body.appendChild(row);
        var res = document.createElement('div');
        res.style.cssText = 'font-size:12px;min-height:20px;line-height:1.7;';
        body.appendChild(res);

        function doQuery() {
            var n = String(inp.value || '').trim();
            if (!n || isNaN(parseInt(n, 10))) {
                res.innerHTML = '<div style="color:#ff9a9a;font-size:11px">请输入有效的集号</div>';
                return;
            }
            var key = String(parseInt(n, 10));
            var editor = plan[key];
            if (editor) {
                res.innerHTML = '<div style="padding:8px 10px;background:#1e3a2a;border-radius:6px">第 <b>' + esc(key) + '</b> 集 → 剪辑师 <b style="color:#7fd68b">' + esc(editor) + '</b></div>';
            } else {
                res.innerHTML = '<div style="padding:8px 10px;background:#3a2f1e;border-radius:6px">⚠️ 未找到第 <b>' + esc(key) + '</b> 集的剪辑师登记</div>';
            }
        }
        function showByEditor(editorName) {
            var eps = [];
            Object.keys(plan).forEach(function (k) {
                if (plan[k] === editorName) eps.push(parseInt(k, 10));
            });
            eps.sort(function (a, b) { return a - b; });
            res.innerHTML = eps.length
                ? '<div style="padding:8px 10px;background:#1e3a2a;border-radius:6px">剪辑师 <b style="color:#7fd68b">' + esc(editorName) + '</b> 负责：第 ' + esc(eps.join('、')) + ' 集</div>'
                : '<div style="padding:8px 10px;background:#3a2f1e;border-radius:6px">未找到剪辑师 <b>' + esc(editorName) + '</b> 的分集记录</div>';
        }
        goBtn.addEventListener('click', doQuery);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') doQuery(); });
        // 剪辑师快捷标签（按剪辑师反查）
        var byEditor = {};
        Object.keys(plan).forEach(function (k) {
            var ed = plan[k];
            if (!ed) return;
            if (!byEditor[ed]) byEditor[ed] = [];
            byEditor[ed].push(parseInt(k, 10));
        });
        var edNames = Object.keys(byEditor);
        if (edNames.length) {
            var tip = document.createElement('div');
            tip.style.cssText = 'margin-top:8px;border-top:1px solid var(--border,#333);padding-top:8px;';
            var tipT = document.createElement('div');
            tipT.style.cssText = 'font-size:10px;color:var(--muted);margin-bottom:4px;';
            tipT.textContent = '按剪辑师反查：';
            tip.appendChild(tipT);
            var chips = document.createElement('div');
            chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
            edNames.forEach(function (ed) {
                var c = document.createElement('span');
                c.style.cssText = 'background:var(--panel2,#2a2a2a);border:1px solid var(--border,#444);border-radius:4px;padding:1px 6px;font-size:11px;cursor:pointer;color:var(--text,#ccc);';
                c.textContent = ed + ':' + byEditor[ed].join(',');
                c.title = '点我查看 ' + ed + ' 负责哪些集';
                c.addEventListener('click', function () { showByEditor(ed); });
                chips.appendChild(c);
            });
            tip.appendChild(chips);
            body.appendChild(tip);
        }
        box.appendChild(body);
        var foot = document.createElement('div');
        foot.style.cssText = 'padding:8px 14px;border-top:1px solid var(--border,#333);text-align:right;';
        var cls = document.createElement('button');
        cls.type = 'button';
        cls.textContent = '关闭';
        cls.style.cssText = 'background:none;border:1px solid var(--border,#555);color:var(--text,#ccc);border-radius:4px;padding:3px 12px;cursor:pointer;font-size:12px;';
        foot.appendChild(cls);
        box.appendChild(foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        _epSearchOverlay = overlay;
        var closeAll = function () { if (overlay.parentNode) overlay.remove(); if (_epSearchOverlay === overlay) _epSearchOverlay = null; };
        xBtn.addEventListener('click', closeAll);
        cls.addEventListener('click', closeAll);
        overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeAll(); });
        setTimeout(function () { try { inp.focus(); } catch (e) {} }, 30);
    }

    // ==================== 项目明细浮层：缺集 / 成片 / 修改 三合一 ====================
    var _detailOverlay = null;
    var _videoOverlay = null;   // 播放器浮层（showVideoPlayer / closeVideoPlayer 共用）
    // 连续集区间压缩：1,2,3,5 -> 1-3,5
    function compactEpList(nums) {
        if (!nums || !nums.length) return '';
        var arr = nums.slice().sort(function (a, b) { return a - b; });
        var parts = [], start = arr[0], prev = arr[0];
        for (var k = 1; k < arr.length; k++) {
            if (arr[k] === prev + 1) { prev = arr[k]; }
            else {
                parts.push(start === prev ? String(start) : start + '-' + prev);
                start = prev = arr[k];
            }
        }
        parts.push(start === prev ? String(start) : start + '-' + prev);
        return parts.join(',');
    }

    function openProjectDetail(p) {
    var projectName = p.name || '';
    if (_detailOverlay) { _detailOverlay.remove(); _detailOverlay = null; }

    var overlay = document.createElement('div');
    overlay.className = 'prg-modal-mask';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--panel,#1e1e1e);border:1px solid var(--border,#3a3a3a);border-radius:10px;width:400px;max-width:94vw;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.4);';

    // 头部
    var head = document.createElement('div');
    head.style.cssText = 'padding:9px 12px;background:var(--panel2,#242424);border-bottom:1px solid var(--border,#333);display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
    var title = document.createElement('span');
    title.style.cssText = 'flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--text,#e8e8e8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    title.textContent = projectName;
    title.title = projectName;
    head.appendChild(title);
    var stateTag = document.createElement('span');
    stateTag.className = 'prg-state ' + stateClass(p.custom_status || '');
    stateTag.textContent = p.custom_status || '';
    head.appendChild(stateTag);
    box.appendChild(head);

    // 内容（tab + 列表）
    var content = document.createElement('div');
    content.style.cssText = 'flex:1;overflow-y:auto;min-height:0;padding:10px 12px;';
    content.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted,#999);font-size:12px">⏳ 加载中…</div>';
    box.appendChild(content);

    // 底部
    var foot = document.createElement('div');
    foot.style.cssText = 'padding:8px 12px;border-top:1px solid var(--border,#333);display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;';
    var openG = document.createElement('button');
    openG.type = 'button';
    openG.textContent = '📁 组内NAS';
    openG.style.cssText = 'background:none;border:1px solid var(--border,#555);color:var(--text,#ccc);border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;';
    if (p.group_path) {
        openG.addEventListener('click', function () { openProjFolder(projectName, 'group_root'); });
        foot.appendChild(openG);
    }
    var openP = document.createElement('button');
    openP.type = 'button';
    openP.textContent = '🏢 制作部';
    openP.style.cssText = 'background:none;border:1px solid var(--border,#555);color:var(--text,#ccc);border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;';
    if (p.production_path) {
        openP.addEventListener('click', function () { openProjFolder(projectName, 'prod'); });
        foot.appendChild(openP);
    }
    var cls = document.createElement('button');
    cls.type = 'button';
    cls.textContent = '关闭';
    cls.style.cssText = 'background:none;border:1px solid var(--border,#555);color:var(--text,#ccc);border-radius:4px;padding:3px 12px;cursor:pointer;font-size:12px;margin-left:auto;';
    foot.appendChild(cls);
    box.appendChild(foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    _detailOverlay = overlay;
    var closeAll = function () { if (overlay.parentNode) overlay.remove(); if (_detailOverlay === overlay) _detailOverlay = null; };
    cls.addEventListener('click', closeAll);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeAll(); });

    // ===== 数据与状态（函数顶层，不随渲染重建） =====
    var enc = encodeURIComponent(projectName);
    var got = { ep: null, edit: null, rev: null, del: null };   // null=未返回，[] / {}=空结果
    // 默认 tab：待交付 / 已完成 项目优先看交付；修改中看修改；其余看缺集
    var st0 = (p.custom_status || '');
    var curTab = (st0.indexOf('交付') >= 0 || st0 === '已完成' || st0 === '待质检' || st0 === '质检中')
        ? 'del' : (st0.indexOf('修改') >= 0 ? 'rev' : 'miss');
    var revSub = '';              // 修改子路径（空=修改根）
    var revStack = [];            // 修改导航栈
    var revFilesCache = [];       // 当前修改文件夹内文件缓存
    var delSub = '';              // 交付子路径（空=000交付 根）
    var delStack = [];            // 交付导航栈
    var delFilesCache = [];       // 当前交付文件夹内文件缓存
    var delCheck = null;          // delivery_check（000交付 根时返回）

    // DOM 引用（renderContent 构建后赋值）
    var dom = { ov: null, tabMiss: null, tabEdit: null, tabRev: null, tabDel: null, body: null };

    // ===== 工具 =====
    function fileCount(d) {
        if (!d) return 0;
        if (Array.isArray(d)) return d.length;
        return (d.files || []).length + (d.folders || []).length;
    }

    // 数据就绪后统一入口：首次建骨架；数据各自到达刷新对应 tab 内容
    function dataReady() {
        var isFirst = !dom.body;
        if (isFirst) {
            if (got.ep) renderContent();   // ep 就绪即可建骨架
        }
        if (!dom.body) return;
        updateTabCounts();
        // 当前 tab：数据变化时刷新。miss 只依赖 ep（首次已渲染，跳过）；edit/rev/del 各自依赖自身数据
        if (curTab === 'miss') return;
        if (curTab === 'edit' && got.edit !== null) renderCurrent();
        else if (curTab === 'rev' && got.rev !== null) renderCurrent();
        else if (curTab === 'del' && got.del !== null) renderCurrent();
    }

    function updateTabCounts() {
        if (!dom.tabMiss || !dom.tabEdit || !dom.tabRev || !dom.tabDel) return;
        var missingN = got.ep && got.ep.ok ? (got.ep.missing || []).length : 0;
        dom.tabMiss.textContent = '缺集 ' + missingN;
        dom.tabEdit.textContent = '🎬 成片 ' + fileCount(got.edit);
        dom.tabRev.textContent = '📝 修改 ' + fileCount(got.rev);
        dom.tabDel.textContent = '📦 交付 ' + fileCount(got.del);
    }

    function renderCurrent() {
        if (!dom.body) return;
        if (curTab === 'miss') { dom.body.innerHTML = ''; renderMiss(dom.body); }
        else if (curTab === 'edit') {
            if (got.edit === null) { dom.body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted,#999);font-size:12px">⏳ 加载成片列表…</div>'; return; }
            dom.body.innerHTML = ''; renderEditFiles(dom.body);
        }
        else if (curTab === 'rev') {
            if (got.rev === null) { dom.body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted,#999);font-size:12px">⏳ 加载修改文件夹…</div>'; return; }
            dom.body.innerHTML = ''; renderRev(dom.body);
        }
        else {
            if (got.del === null) { dom.body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted,#999);font-size:12px">⏳ 加载交付预览…</div>'; return; }
            dom.body.innerHTML = ''; renderDel(dom.body);
        }
    }

    function renderContent() {
        var epData = got.ep;
        content.innerHTML = '';
        if (!epData || !epData.ok) {
            content.innerHTML = '<div style="padding:18px;text-align:center;color:#ff9a9a;font-size:12px">读取失败（工作台未运行？）</div>';
            return;
        }
        var total = parseInt(epData.total, 10) || 0;
        var cur = parseInt(epData.current_count, 10) || 0;
        var pct = total > 0 ? Math.min(100, Math.round(cur / total * 100)) : 0;

        // 概览条
        var ov = document.createElement('div');
        ov.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;color:var(--text,#ddd);';
        var barWrap = document.createElement('div');
        barWrap.style.cssText = 'flex:1;height:6px;background:#1a1a1a;border-radius:3px;overflow:hidden;';
        var bar = document.createElement('div');
        bar.style.cssText = 'height:100%;width:' + pct + '%;background:' + (pct >= 100 ? '#3d9a50' : 'var(--accent,#537d96)') + ';border-radius:3px;';
        barWrap.appendChild(bar);
        ov.appendChild(barWrap);
        var ovTxt = document.createElement('span');
        ovTxt.style.cssText = 'flex:0 0 auto;font-weight:600;';
        ovTxt.textContent = cur + '/' + total + ' 集 · ' + pct + '%';
        ov.appendChild(ovTxt);
        content.appendChild(ov);

        // tab 条
        var tabs = document.createElement('div');
        tabs.style.cssText = 'display:flex;gap:4px;border-bottom:1px solid var(--border,#333);margin-bottom:8px;';
        function mkTab(txt) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = txt;
            b.style.cssText = 'background:none;border:none;border-bottom:2px solid transparent;color:var(--muted,#999);padding:4px 10px;cursor:pointer;font-size:12px;';
            return b;
        }
        dom.tabMiss = mkTab('缺集 0');
        dom.tabEdit = mkTab('🎬 成片 0');
        dom.tabRev = mkTab('📝 修改 0');
        dom.tabDel = mkTab('📦 交付 0');
        tabs.appendChild(dom.tabMiss);
        tabs.appendChild(dom.tabEdit);
        tabs.appendChild(dom.tabRev);
        tabs.appendChild(dom.tabDel);
        content.appendChild(tabs);

        var body = document.createElement('div');
        body.style.cssText = 'min-height:120px;max-height:46vh;overflow-y:auto;';
        content.appendChild(body);
        dom.body = body;
        dom.ov = ov;

        dom.tabMiss.addEventListener('click', function () { switchTab('miss'); });
        dom.tabEdit.addEventListener('click', function () { switchTab('edit'); });
        dom.tabRev.addEventListener('click', function () { switchTab('rev'); });
        dom.tabDel.addEventListener('click', function () { switchTab('del'); });

        updateTabCounts();
        renderCurrent();
    }

    function switchTab(key) {
        curTab = key;
        var map = { miss: dom.tabMiss, edit: dom.tabEdit, rev: dom.tabRev, del: dom.tabDel };
        var keys = ['miss', 'edit', 'rev', 'del'];
        for (var i = 0; i < 4; i++) {
            var b = map[keys[i]];
            if (!b) continue;
            b.style.borderBottomColor = (keys[i] === key) ? 'var(--accent,#537d96)' : 'transparent';
            b.style.color = (keys[i] === key) ? 'var(--text,#e8e8e8)' : 'var(--muted,#999)';
        }
        if (!dom.body) return;
        dom.body.innerHTML = '';
        if (key === 'miss') renderMiss(dom.body);
        else if (key === 'edit') renderEditFiles(dom.body);
        else if (key === 'rev') renderRev(dom.body);
        else renderDel(dom.body);
    }

    // ===== 缺集 =====
    function renderMiss(container) {
        var epData = got.ep;
        var missing = (epData && epData.missing) || [];
        var editorPlan = (epData && epData.editor_plan) || {};
        if (missing.length === 0) {
            container.innerHTML = '<div style="padding:16px;text-align:center;color:#7fd68b;font-size:12px">✅ 已全部完成，无缺集</div>';
            return;
        }
        var groups = {};
        missing.forEach(function (ep) {
            var ed = editorPlan[String(ep)] || editorPlan[ep] || '未分配';
            if (!groups[ed]) groups[ed] = [];
            groups[ed].push(parseInt(ep, 10));
        });
        var keys = Object.keys(groups);
        container.innerHTML = '';
        keys.forEach(function (ed) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:baseline;gap:8px;padding:4px 2px;border-bottom:1px dashed var(--border,#2e2e2e);font-size:12px;';
            var name = document.createElement('span');
            name.style.cssText = 'flex:0 0 auto;color:#7fd68b;font-weight:600;';
            name.textContent = ed;
            var eps = document.createElement('span');
            eps.style.cssText = 'flex:1;color:var(--text,#ccc);word-break:break-all;';
            eps.textContent = '缺 ' + compactEpList(groups[ed]);
            row.appendChild(name);
            row.appendChild(eps);
            container.appendChild(row);
        });
    }

    // ===== 行构建 =====
    function mkFileRow(container, cfg) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 2px;border-bottom:1px dashed var(--border,#2e2e2e);font-size:12px;cursor:pointer;';
        if (cfg.title) row.title = cfg.title;
        if (cfg.onClick) row.addEventListener('click', cfg.onClick);
        var ic = document.createElement('span');
        ic.style.cssText = 'flex:0 0 auto;';
        ic.textContent = cfg.icon || '📄';
        row.appendChild(ic);
        var nmEl = document.createElement('span');
        nmEl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text,#ddd);';
        nmEl.textContent = cfg.name;
        nmEl.title = cfg.name;
        row.appendChild(nmEl);
        var metaEl = document.createElement('span');
        metaEl.style.cssText = 'flex:0 0 auto;color:#7fd68b;font-size:11px;';
        if (cfg.meta) { metaEl.textContent = cfg.meta; metaEl.title = cfg.meta; }
        row.appendChild(metaEl);
        var szEl = document.createElement('span');
        szEl.style.cssText = 'flex:0 0 auto;color:var(--muted,#777);font-size:10px;';
        if (cfg.size) szEl.textContent = cfg.size;
        row.appendChild(szEl);
        // 可选「▶ 进入」按钮：文件夹行用它进入（不依赖整行 click，点击更明确）
        if (cfg.enterLabel && cfg.onClick) {
            var eb = document.createElement('button');
            eb.type = 'button';
            eb.textContent = cfg.enterLabel;
            eb.title = cfg.enterTitle || '点击进入';
            eb.style.cssText = 'flex:0 0 auto;background:none;border:1px solid var(--border,#555);border-radius:3px;color:#7fd68b;font-size:10px;padding:0 6px;cursor:pointer;line-height:16px;';
            eb.addEventListener('click', function (e) {
                e.stopPropagation();
                if (cfg.onClick) cfg.onClick();
            });
            row.appendChild(eb);
        }
        if (cfg.openDir) {
            var ob = document.createElement('button');
            ob.type = 'button';
            ob.textContent = '📂';
            ob.title = '在文件管理器中打开所在目录';
            ob.style.cssText = 'flex:0 0 auto;background:none;border:1px solid var(--border,#555);border-radius:3px;color:var(--accent,#7aa7c7);font-size:10px;padding:0 5px;cursor:pointer;line-height:16px;';
            ob.addEventListener('click', function (e) {
                e.stopPropagation();
                if (cfg.openDir) cfg.openDir();
            });
            row.appendChild(ob);
        }
        container.appendChild(row);
    }

    function renderVideoRows(container, files, mode, subpath) {
        if (!files || !files.length) {
            var t = mode === 'revising'
                ? (subpath ? '「' + subpath + '」内暂无视频文件' : '修改根目录暂无散文件')
                : (mode === 'delivery'
                    ? (subpath ? '「' + subpath + '」内暂无视频文件' : '交付目录暂无散文件')
                    : '暂无成片文件');
            container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted,#888);font-size:12px">' + t + '</div>';
            return;
        }
        container.innerHTML = '';
        files.forEach(function (f) {
            var nm = f.name || f;
            // 交付目录里可能有非视频（字幕/截图），只对视频行给播放点击；其余仅当信息行
            var isVid = /^\d+(\.\w+)?$/.test(nm) || /\.(mp4|mov|mkv|avi|webm)$/i.test(nm);
            if (mode === 'delivery' && !isVid) return;
            var meta = f.editor || '';
            if (mode === 'delivery') {
                // 交付目录文件名可能带扩展名集号如 3.mp4；显示集号徽章
                var mm = String(nm).match(/^(\d+)/);
                if (mm) meta = '第' + mm[1] + '集' + (f.editor ? ' · ' + f.editor : '');
            }
            mkFileRow(container, {
                icon: mode === 'revising' ? '✏️' : (mode === 'delivery' ? '📦' : '🎬'),
                name: nm,
                title: (f.path || '') + '\n点击播放，📂 打开所在目录',
                meta: meta,
                size: f.size_mb ? Math.round(f.size_mb) + 'MB' : '',
                onClick: function () {
                    try {
                        // 点击反馈：状态栏提示 + 行高亮，确保用户知道点击被接收
                        dbg('① 收到点击：' + nm + '（mode=' + mode + ' subpath=' + (subpath || '') + '）');
                        try { el.statusText.textContent = '点击：' + nm; } catch (e) {}
                        var rc = container.lastChild;
                        if (rc && rc.style) {
                            var origBg = rc.style.background;
                            rc.style.background = 'rgba(139,92,246,.25)';
                            setTimeout(function () { try { rc.style.background = origBg || ''; } catch (e) {} }, 250);
                        }
                        if (typeof playVideo !== 'function') { dbg('② 出错：playVideo 未定义（脚本加载异常）'); throw new Error('playVideo undefined'); }
                        dbg('② 调 playVideo…');
                        playVideo(projectName, nm, mode, subpath || '');
                    }
                    catch (err) {
                        try { el.statusText.textContent = '播放失败：' + (err && err.message); } catch (e) {}
                        dbg('✗ 播放异常：' + (err && err.message));
                        try { console.error('[vh播放]', err); } catch (e2) {}
                    }
                },
                openDir: function () {
                    var target = f.path || '';
                    if (target) openFolderPath(target);
                }
            });
        });
    }

    // ===== 成片 Tab =====
    function renderEditFiles(container) {
        var files = Array.isArray(got.edit) ? got.edit : ((got.edit && got.edit.files) || []);
        renderVideoRows(container, files, 'editing', '');
    }

    // ===== 修改 Tab =====
    function renderRev(container) {
        container.innerHTML = '';
        if (!revSub) {
            // 修改根：列文件夹
            var folders = (got.rev && got.rev.folders) || [];
            var files = (got.rev && got.rev.files) || [];
            if (!folders.length && !files.length) {
                container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted,#888);font-size:12px">暂无修改文件夹</div>';
                return;
            }
            var fRoot = document.createElement('div');
            folders.forEach(function (fd) {
                var fname = fd.name || '';
                mkFileRow(fRoot, {
                    icon: '📁',
                    name: fname,
                    title: (fd.abs_path || '') + '\n点击进入查看集数，📂 打开目录',
                    enterLabel: '进入 →',
                    enterTitle: '进入 ' + fname + ' 查看集数',
                    onClick: function () { enterRevFolder(fname); },
                    openDir: function () { if (fd.abs_path) openFolderPath(fd.abs_path); }
                });
            });
            container.appendChild(fRoot);
            // 修改根下的散文件（罕见）——渲染到独立子容器，避免清掉上面文件夹
            if (files.length) renderVideoRows(container, files, 'revising', '');
        } else {
            // 已进入修改文件夹：顶部固定导航条（返回）+ 下方独立列表区（不会被清空）
            container.innerHTML = '';
            var nav = document.createElement('div');
            nav.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 8px;background:var(--panel2,#242424);border:1px solid var(--border,#444);border-radius:6px;position:sticky;top:0;z-index:5;';
            var backBtn = document.createElement('button');
            backBtn.type = 'button';
            backBtn.textContent = '← 返回修改列表';
            backBtn.title = '回到修改文件夹列表';
            backBtn.style.cssText = 'flex:0 0 auto;background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;';
            backBtn.addEventListener('click', function () {
                dbg('← 修改返回：回根列表');
                revSub = '';
                revStack = [];
                revFilesCache = [];
                fetchRevSub();
            });
            nav.appendChild(backBtn);
            var crumbTxt = document.createElement('span');
            crumbTxt.style.cssText = 'color:var(--muted,#ccc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;';
            crumbTxt.textContent = '📁 ' + revSub;
            crumbTxt.title = revSub;
            nav.appendChild(crumbTxt);
            container.appendChild(nav);
            // 独立列表子容器：renderVideoRows 只清这块，不影响上方导航
            var listBox = document.createElement('div');
            container.appendChild(listBox);
            if (revFilesCache.length) {
                renderVideoRows(listBox, revFilesCache, 'revising', revSub);
            } else {
                listBox.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted,#888);font-size:12px">⏳ 加载集数…</div>';
                fetchRevSub();
            }
        }
    }

    var revReqId = 0;
    function fetchRevSub() {
        dbg('📂 修改 fetch subpath=' + (revSub || '(根)'));
        if (!revSub) { renderRev(dom.body); return; }
        var myId = ++revReqId;
        var q = '/api/output_files/' + enc + '?mode=revising&subpath=' + encodeURIComponent(revSub);
        apiGet(q, function (err, d) {
            if (myId !== revReqId) return;  // 已有更新的请求，丢弃过期响应
            if (err) {
                if (dom.body) dom.body.innerHTML = '<div style="padding:14px;color:#ff9a9a;font-size:12px">加载失败：' + err.message + '</div>';
                return;
            }
            revFilesCache = (d && d.files) || [];
            dbg('修改列表已载：' + revFilesCache.length + ' 个文件');
            if (curTab === 'rev' && revSub) {
                if (dom.body) { dom.body.innerHTML = ''; renderRev(dom.body); }
            }
        });
    }

    function enterRevFolder(fname) {
        dbg('→ 进入修改文件夹：' + fname);
        revStack.push(revSub);
        revSub = revSub ? (revSub + '/' + fname) : fname;
        revFilesCache = [];
        fetchRevSub();
    }

    // ===== 交付 Tab（000交付 目录树，与桌面端一致） =====
    var delReqId = 0;
    // 交付根若只有唯一「000交付」虚拟文件夹：自动进入它，直接展示各版本文件夹（与桌面端一致）
    var delAutoRooted = false;
    function renderDel(container) {
        container.innerHTML = '';
        if (!delSub) {
            var data = got.del || {};
            var folders = data.folders || [];
            var files = data.files || [];
            var dc = data.delivery_check || delCheck || null;
            // 齐套状态条（有才显示）
            if (dc && dc.base_exists) {
                var okBanner = document.createElement('div');
                okBanner.style.cssText = 'padding:7px 10px;border-radius:6px;font-size:11px;line-height:1.5;margin-bottom:8px;';
                if (dc.all_ok) {
                    okBanner.style.cssText += 'background:#1e3a2a;color:#7fd68b;border:1px solid #2a5a3a;';
                    okBanner.textContent = '✅ 交付文件已完成（' + (dc.folders || []).length + ' 个文件夹全部齐套）';
                } else {
                    okBanner.style.cssText += 'background:#3a2f1e;color:#ffd76a;border:1px solid #5a4a1e;';
                    var bads = (dc.folders || []).filter(function (f) { return !f.ok; });
                    okBanner.textContent = '⚠️ 交付文件不齐套（' + (dc.folders || []).length + ' 个文件夹，缺 ' + bads.length + ' 个）';
                    if (bads.length) {
                        var sub = document.createElement('div');
                        sub.style.cssText = 'margin-top:4px;color:#c9a86a;font-size:10px;line-height:1.6;';
                        bads.forEach(function (f) {
                            var missing = (f.missing_episodes || []);
                            // 每项可能是 {episode:65, editor:'xx'} 或纯数字，统一提取集号
                            var epNums = missing.map(function (x) {
                                if (x == null) return null;
                                if (typeof x === 'object') {
                                    var v = x.episode != null ? x.episode : x.ep;
                                    return v != null ? parseInt(v, 10) : null;
                                }
                                return parseInt(x, 10);
                            }).filter(function (v) { return v != null && !isNaN(v); });
                            sub.textContent += '· ' + f.name + '：' + f.actual + '/' + f.expected + (epNums.length ? '（缺 ' + compactEpList(epNums) + ' 集）' : '') + '\n';
                        });
                        okBanner.appendChild(sub);
                    }
                }
                container.appendChild(okBanner);
            }
            // 若根只有唯一 000交付 且尚未自动进入 → 立即自动进入（否则用户看到的是空壳"000交付"行）
            var onlyRoot = folders.length === 1 && folders[0].name === '000交付' && !delAutoRooted;
            if (onlyRoot) {
                delAutoRooted = true;
                dbg('📦 自动进入 000交付 …');
                enterDelFolder('000交付');
                container.innerHTML += '<div style="padding:14px;text-align:center;color:var(--muted,#888);font-size:12px">⏳ 加载 000交付 …</div>';
                return;
            }
            if (!folders.length && !files.length) {
                container.innerHTML += '<div style="padding:16px;text-align:center;color:var(--muted,#888);font-size:12px">暂无交付文件夹（项目未建 000交付？）</div>';
                return;
            }
            var fRoot = document.createElement('div');
            folders.forEach(function (fd) {
                var fname = fd.name || '';
                var fcnt = fd.file_count != null && fd.file_count > 0 ? '（' + fd.file_count + '）' : '';
                var isRootV = (fname === '000交付');
                mkFileRow(fRoot, {
                    icon: '📁',
                    name: fname + (isRootV ? '' : fcnt),
                    title: isRootV ? '000交付 文件夹：点击进入查看各版本交付内容' : '点击进入查看交付内容，📂 打开目录',
                    enterLabel: '进入 →',
                    enterTitle: '进入 ' + fname,
                    onClick: function () { enterDelFolder(fname); },
                    openDir: function () {
                        var target = fd.abs_path || '';
                        if (target) openFolderPath(target);
                    }
                });
            });
            container.appendChild(fRoot);
            // 根下散文件（罕见）渲染到独立子容器，避免清掉文件夹
            if (files.length) renderVideoRows(container, files, 'delivery', '');
        } else {
            // 已进入交付子文件夹：顶部固定导航条（返回）+ 下方独立列表区
            container.innerHTML = '';
            var crumb = document.createElement('div');
            crumb.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 8px;background:var(--panel2,#242424);border:1px solid var(--border,#444);border-radius:6px;position:sticky;top:0;z-index:5;';
            var backBtn = document.createElement('button');
            backBtn.type = 'button';
            // 在 000交付 版本列表层（交付预览顶层）无上级，不显示返回；更深的集数/子目录层显示
            var isRootLevel = (delSub === '000交付');
            backBtn.textContent = '← 返回';
            backBtn.title = isRootLevel ? '' : '回到上一级目录';
            backBtn.style.cssText = 'flex:0 0 auto;background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;';
            if (isRootLevel) {
                backBtn.style.visibility = 'hidden';
            }
            backBtn.addEventListener('click', function () {
                dbg('← 交付返回：上一级');
                var prev = delStack.length ? delStack.pop() : '';
                if (!prev) { prev = '000交付'; }
                delSub = prev;
                delFilesCache = [];
                fetchDelSub();
            });
            crumb.appendChild(backBtn);
            var crumbTxt = document.createElement('span');
            crumbTxt.style.cssText = 'color:var(--muted,#ccc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;';
            crumbTxt.textContent = '📦 ' + delSub;
            crumbTxt.title = delSub;
            crumb.appendChild(crumbTxt);
            container.appendChild(crumb);
            // 独立列表子容器：renderDelContent/renderVideoRows 只清这块
            var listBox = document.createElement('div');
            container.appendChild(listBox);
            if (delFilesCache.length) {
                renderDelContent(listBox);
            } else {
                listBox.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted,#888);font-size:12px">⏳ 加载交付内容…</div>';
                fetchDelSub();
            }
        }
    }

    // 交付子目录内容：可能是子文件夹 + 文件（继续套 mkFileRow 导航），也可能只有视频文件
    function renderDelContent(container) {
        if (!delFilesCache.length) {
            container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted,#888);font-size:12px">📭 该目录下没有文件</div>';
            return;
        }
        var folders = delFilesCache.filter(function (x) { return x.kind === 'folder'; });
        var files = delFilesCache.filter(function (x) { return x.kind !== 'folder'; });
        folders.forEach(function (fd) {
            var fname = fd.name || '';
            var fcnt = fd.file_count != null && fd.file_count > 0 ? '（' + fd.file_count + '）' : '';
            mkFileRow(container, {
                icon: '📁',
                name: fname + fcnt,
                title: '点击进入查看交付内容',
                enterLabel: '进入 →',
                enterTitle: '进入 ' + fname,
                onClick: function () { enterDelFolder(fname); },
                openDir: function () { if (fd.abs_path) openFolderPath(fd.abs_path); }
            });
        });
        // 只剩视频文件（交付的 00成片/无字幕版本目录）；字幕/截图目录无视频是正常现象
        var vids = files.filter(function (x) { return /\.(mp4|mov|mkv|avi|webm)$/i.test(String(x.name || '')); });
        if (vids.length) renderVideoRows(container, vids, 'delivery', delSub);
        // 有文件夹列表（版本/子目录导航）就不提示；只有既无文件夹也无视频才给说明
        if (!folders.length && !vids.length) {
            container.innerHTML += '<div style="padding:10px;text-align:center;color:var(--muted,#666);font-size:11px">该目录无视频文件（可能是字幕/截图等交付物）</div>';
        }
    }

    function enterDelFolder(fname) {
        dbg('→ 进入交付文件夹：' + fname + '（当前 delSub=' + delSub + '）');
        delStack.push(delSub);
        delSub = delSub ? (delSub + '/' + fname) : fname;
        delFilesCache = [];
        fetchDelSub();
    }

    function fetchDelSub() {
        dbg('📦 交付 fetch subpath=' + (delSub || '(根)'));
        var q = '/api/output_files/' + enc + '?mode=delivery';
        if (delSub) q += '&subpath=' + encodeURIComponent(delSub);
        var myId = ++delReqId;
        apiGet(q, function (err, d) {
            if (myId !== delReqId) return;
            if (err) {
                if (dom.body) dom.body.innerHTML = '<div style="padding:14px;color:#ff9a9a;font-size:12px">加载失败：' + err.message + '</div>';
                return;
            }
            if (!delSub) {
                got.del = d || { files: [], folders: [] };
                delCheck = (d && d.delivery_check) || null;
                if (curTab === 'del') {
                    if (dom.body) { dom.body.innerHTML = ''; renderDel(dom.body); }
                }
            } else {
                delFilesCache = (d && d.files) || [];
                // 后端在子目录返回 folders + files；把 folders 转成带 kind 标记统一进缓存
                var dFolders = (d && d.folders) || [];
                dFolders.forEach(function (x) { x.kind = 'folder'; });
                delFilesCache = dFolders.concat(delFilesCache);
                if (curTab === 'del' && delSub) {
                    if (dom.body) { dom.body.innerHTML = ''; renderDel(dom.body); }
                }
            }
        });
    }

    // 播放视频
    function playVideo(proj, fileName, mode, subpath) {
        dbg('③ playVideo 构造 URL…');
        var url = WB_BASE + '/api/preview/' + encodeURIComponent(proj) + '/' + encodeURIComponent(fileName)
            + '?mode=' + encodeURIComponent(mode);
        if (subpath) url += '&subpath=' + encodeURIComponent(subpath);
        dbg('④ 弹出播放器 → ' + fileName);
        showVideoPlayer(proj, fileName, url, mode, subpath);
    }

    // 打开文件管理目录
    function openFolderPath(target) {
        apiPost('/api/project/' + enc + '/open_folder', { which: 'path', path: target }, function (err2, d2) {
            if (!err2 && d2 && d2.ok) el.statusText.textContent = '已打开目录';
            else el.statusText.textContent = '打开失败：' + ((err2 && err2.message) || (d2 && d2.message) || '');
        });
    }

    // 并行拉数据（各自就绪后更新，不整体重建）
    apiGet('/api/project/' + enc + '/episodes_status', function (err, d) { got.ep = err ? { ok: false } : d; dataReady(); });
    apiGet('/api/output_files/' + enc + '?mode=editing', function (err, d) { got.edit = err ? [] : d; dataReady(); });
    apiGet('/api/output_files/' + enc + '?mode=revising', function (err, d) { got.rev = err ? { files: [], folders: [] } : d; dataReady(); });
    apiGet('/api/output_files/' + enc + '?mode=delivery', function (err, d) {
        got.del = err ? { files: [], folders: [], delivery_check: null } : d;
        delCheck = (d && d.delivery_check) || null;
        dataReady();
    });
}


    function showVideoPlayer(proj, fileName, url, mode, subpath) {
        dbg('⑤ showVideoPlayer 入口：' + fileName);
        try { if (!_videoOverlay) _videoOverlay = null; } catch (e) {}
        if (_videoOverlay) closeVideoPlayer();
        // 状态栏即时反馈，确认点击已生效
        try { el.statusText.textContent = '正在打开播放器：' + fileName + '…'; } catch (e) {}
        var overlay = document.createElement('div');
        overlay.className = 'prg-modal-mask';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:10001;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#000;border:1px solid var(--border,#333);border-radius:10px;width:600px;max-width:95vw;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.6);';

        // 标题条
        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 10px;background:#111;border-bottom:1px solid #222;';
        var ttl = document.createElement('span');
        ttl.style.cssText = 'flex:1;font-size:12px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        ttl.textContent = '▶ ' + (mode === 'revising' ? '📝 ' : '🎬 ') + fileName;
        head.appendChild(ttl);
        // 本地播放器按钮（手动，不自动跳）
        var localBtn = document.createElement('button');
        localBtn.type = 'button';
        localBtn.textContent = '📺 本地播放器';
        localBtn.title = '用 PotPlayer / 系统默认播放器打开';
        localBtn.style.cssText = 'background:none;border:1px solid #444;color:#7aa7c7;border-radius:4px;padding:1px 8px;cursor:pointer;font-size:11px;';
        localBtn.addEventListener('click', function () { openInLocalPlayer(); });
        head.appendChild(localBtn);
        var xBtn = document.createElement('button');
        xBtn.type = 'button';
        xBtn.textContent = '✕';
        xBtn.style.cssText = 'background:none;border:none;color:#999;font-size:14px;cursor:pointer;padding:0 6px;';
        head.appendChild(xBtn);
        box.appendChild(head);

        // 提示条：加载状态实时可见
        var loadTip = document.createElement('div');
        loadTip.style.cssText = 'text-align:center;padding:5px;font-size:11px;color:#aaa;background:#151515;border-bottom:1px solid #222;min-height:16px;';
        loadTip.textContent = '⏳ 正在加载视频流（NAS 首帧较慢，请稍候）…';
        box.appendChild(loadTip);

        // 视频
        var video = document.createElement('video');
        video.controls = true;
        video.preload = 'auto';
        video.style.cssText = 'display:block;width:100%;max-height:52vh;background:#000;';
        box.appendChild(video);

        // 进度提示（实时反映加载进度，避免“看起来没反应”）
        var slowTimer = null;
        var lastLoaded = 0;
        function showLoadState(force) {
            if (openedLocal) return;
            var ready = 0, net = 0, loaded = 0, total = 0;
            try { ready = video.readyState; net = video.networkState; } catch (e) {}
            try { loaded = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0; } catch (e) {}
            try { total = video.duration || 0; } catch (e) {}
            if (force || (ready < 2 && net !== 3)) {
                var sec = total > 0 ? Math.round(loaded) + 's/' + Math.round(total) + 's' : (loaded > 0 ? '已缓冲 ' + Math.round(loaded) + 's' : '等待首帧…');
                loadTip.textContent = '⏳ 加载中… ' + sec + '（网络盘首次较慢，一般 5~15 秒）';
                lastLoaded = loaded;
            }
        }
        // 每 800ms 刷新一次加载状态
        slowTimer = setInterval(function () { showLoadState(false); }, 800);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        _videoOverlay = overlay;
        var fallbackTimer = null;
        var openedLocal = false;
        var pendingPlay = false;

        function clearTimers() {
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
            if (slowTimer) { clearInterval(slowTimer); slowTimer = null; }
        }

        function tryPlay() {
            try {
                var pp = video.play();
                if (pp && pp.catch) pp.catch(function (e) { pendingPlay = true; });
            } catch (e) { pendingPlay = true; }
        }

        function openInLocalPlayer() {
            if (openedLocal) return;
            openedLocal = true;
            clearTimers();
            try { video.pause(); } catch (e) {}
            try { el.statusText.textContent = '正在用本地播放器打开：' + fileName; } catch (e) {}
            apiPost('/api/preview/open_local', { project_name: proj, filename: fileName, mode: mode, subpath: subpath }, function (err, d) {
                if (err) { loadTip.textContent = '打开本地播放器失败：' + err.message; openedLocal = false; return; }
                if (d && d.ok) {
                    loadTip.textContent = '📺 已调起本地播放器（可关闭本窗口）';
                    ttl.textContent = '📺 ' + fileName;
                } else {
                    loadTip.textContent = '打开失败：' + ((d && d.message) || '未知错误');
                    openedLocal = false;
                }
            });
        }

        // 视频加载成功
        video.addEventListener('loadeddata', function () {
            if (openedLocal) return;
            clearTimers();
            loadTip.textContent = '✅ 已就绪';
            try { el.statusText.textContent = '播放中：' + fileName; } catch (e) {}
            tryPlay();
        });
        video.addEventListener('canplay', function () {
            if (openedLocal) return;
            if (pendingPlay) { pendingPlay = false; tryPlay(); }
        });
        // 加载失败：明确展示错误码，保留重试与本地播放器选项（不自动跳走）
        video.addEventListener('error', function () {
            if (openedLocal) return;
            clearTimers();
            var code = video.error ? video.error.code : '?';
            var hint = code === 2 ? '（网络中断/连接被拒）' : code === 3 ? '（解码失败：文件可能损坏或编码不支持）' : code === 4 ? '（该地址不支持播放：格式或跨域受限）' : '';
            loadTip.textContent = '⚠️ 内嵌播放失败（错误码 ' + code + '）' + hint + '，可点右侧「重试」，或「📺 本地播放器」直接播';
            try { el.statusText.textContent = '内嵌播放失败（' + code + '）：' + fileName; } catch (e) {}
        });
        // 开始加载（手势后显式 play）
        video.src = url;
        video.load();
        tryPlay();

        // 超时兜底：NAS 首次加载慢，放宽到 15 秒；仍没就绪 → 只提示不自动跳，附手动重试
        fallbackTimer = setTimeout(function () {
            if (openedLocal) return;
            var rs = 0; try { rs = video.readyState; } catch (e) {}
            if (rs < 2) {
                clearTimers();
                loadTip.textContent = '⏱ 15 秒仍未就绪（网络盘慢或服务繁忙）。点「重试」再试，或「📺 本地播放器」直接播。';
            }
        }, 15000);

        // 重试按钮：重新加载同一地址
        var retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.textContent = '🔄 重试';
        retryBtn.title = '重新加载视频流（首次连接慢时可多点几次）';
        retryBtn.style.cssText = 'background:none;border:1px solid #444;color:#d9a05b;border-radius:4px;padding:1px 8px;cursor:pointer;font-size:11px;';
        retryBtn.addEventListener('click', function () {
            clearTimers();
            openedLocal = false;
            loadTip.textContent = '⏳ 重新加载中…';
            try { video.pause(); } catch (e) {}
            try { video.removeAttribute('src'); video.load(); } catch (e) {}
            slowTimer = setInterval(function () { showLoadState(false); }, 800);
            fallbackTimer = setTimeout(function () {
                if (openedLocal) return;
                var rs = 0; try { rs = video.readyState; } catch (e) {}
                if (rs < 2) {
                    clearTimers();
                    loadTip.textContent = '⏱ 仍未就绪。点「重试」再试，或「📺 本地播放器」直接播。';
                }
            }, 15000);
            try { video.src = url; video.load(); tryPlay(); } catch (e) { loadTip.textContent = '重试失败：' + (e && e.message); }
        });
        head.insertBefore(retryBtn, xBtn);

        var closeIt = function () {
            clearTimers();
            closeVideoPlayer();
        };
        xBtn.addEventListener('click', closeIt);
        overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeIt(); });
    }

    function closeVideoPlayer() {
        if (_videoOverlay) {
            var v = _videoOverlay.querySelector('video');
            if (v) { try { v.pause(); } catch (e) {} v.removeAttribute('src'); try { v.load(); } catch (e) {} }
            if (_videoOverlay.parentNode) _videoOverlay.parentNode.removeChild(_videoOverlay);
            _videoOverlay = null;
        }
    }

    // 请求视频工作台跳转定位（通过 SSE jump 事件）；服务离线则先启动再跳
    function openInWorkbench(projectName) {
        var secret = readSecret();
        if (!secret) {
            setOnline(false, '读不到视频工作台配置（api_secret）');
            return;
        }
        var url = WB_BASE + '/api/_self/jump?project=' + encodeURIComponent(projectName);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 6000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                el.statusText.textContent = '已通知工作台定位：' + projectName;
            } else {
                // 服务没起来 → 一键启动后重试
                el.statusText.textContent = '工作台未响应，正在启动…';
                launchWBThenJump(projectName);
            }
        };
        xhr.onerror = function () { launchWBThenJump(projectName); };
        xhr.ontimeout = function () { launchWBThenJump(projectName); };
        xhr.send();
    }

    function launchWBThenJump(projectName) {
        var started = false;
        try {
            if (fs.existsSync(WB_START)) {
                child_process.exec('wscript "' + WB_START + '"');
                started = true;
            } else if (fs.existsSync(WB_PY)) {
                child_process.exec('pythonw "' + WB_PY + '"');
                started = true;
            }
        } catch (e) {}
        if (!started) {
            setOnline(false, '找不到视频工作台启动脚本，请手动启动');
            return;
        }
        el.statusText.textContent = '正在启动视频工作台…';
        // 等服务就绪后广播跳转
        var tries = 0;
        var timer = setInterval(function () {
            tries++;
            var xhr = new XMLHttpRequest();
            var url = WB_BASE + '/api/_self/jump?project=' + encodeURIComponent(projectName);
            xhr.open('GET', url, true);
            xhr.timeout = 4000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 200) {
                    clearInterval(timer);
                    el.statusText.textContent = '已启动并定位：' + projectName;
                    setTimeout(function () { refresh(true); }, 1200);
                } else if (tries > 15) {
                    clearInterval(timer);
                    setOnline(false, '启动超时，请确认视频工作台能正常运行');
                }
            };
            xhr.onerror = function () {
                if (tries > 15) { clearInterval(timer); setOnline(false, '启动超时'); }
            };
            xhr.ontimeout = function () {
                if (tries > 15) { clearInterval(timer); setOnline(false, '启动超时'); }
            };
            xhr.send();
        }, 1500);
    }



    // 复制文本到剪贴板（供阅读器台词复制按钮用）
    // CEP 的 Chromium 对 navigator.clipboard 支持不稳定，优先用 execCommand('copy')
    window.__copyText = function (text) {
        var done = false;
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            ta.setSelectionRange(0, text.length);
            done = document.execCommand('copy');
            document.body.removeChild(ta);
        } catch (e) { done = false; }
        if (!done) {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text);
                    done = true;
                }
            } catch (e2) { done = false; }
        }
        window.__copyFlash && window.__copyFlash(done ? '已复制' : '复制失败，请手动选中复制');
    };

    // 主刷新
    function refresh(showBusy) {
        if (busy) return;
        busy = true;
        if (showBusy) {
            el.refresh.disabled = true;
            el.statusText.textContent = '拉取中…';
        }
        fetchProjects(function (err, data) {
            busy = false;
            if (el.refresh) el.refresh.disabled = false;
            if (err) {
                // 尝试区分：服务没起 vs 鉴权失败
                var secret = readSecret();
                if (!secret) {
                    setOnline(false, '读不到视频工作台配置（api_secret）');
                } else if (err.message === '网络错误' || err.message === '超时') {
                    setOnline(false, '视频工作台未运行');
                } else {
                    setOnline(false, err.message);
                }
                return;
            }
            lastData = data;
            setOnline(true, '视频工作台在线 · ' + new Date().toLocaleTimeString());
            renderOverview(data.overview_stats || {});
            renderActive(data.sections || []);
            // 每次拉取渲染后都自动批量实扫剪辑中项目（避免卡片卡在"待扫描…"）
            setTimeout(function () {
                if (el.activeList.children.length) batchScanClipProjects(false);
            }, 200);
        });
    }

    // 启动视频工作台
    function launchWB() {
        el.statusText.textContent = '正在启动视频工作台…';
        var started = false;
        try {
            if (fs.existsSync(WB_START)) {
                child_process.exec('wscript "' + WB_START + '"');
                started = true;
            } else if (fs.existsSync(WB_PY)) {
                child_process.exec('pythonw "' + WB_PY + '"');
                started = true;
            }
        } catch (e) {}
        if (!started) {
            el.statusText.textContent = '找不到视频工作台启动脚本，请手动启动';
            return;
        }
        // 轮询等服务就绪
        var tries = 0;
        var timer = setInterval(function () {
            tries++;
            fetchProjects(function (err, data) {
                if (!err) {
                    clearInterval(timer);
                    refresh(true);
                } else if (tries > 20) {
                    clearInterval(timer);
                    setOnline(false, '启动超时，请确认视频工作台能正常运行');
                }
            });
        }, 1500);
    }

    // 事件
    // 顶部「刷新」：重新拉取项目列表并自动实扫剪辑中项目进度
    el.refresh.addEventListener('click', function () { refresh(true); });
    // 「⚡ 一键刷新进度」：不重新拉列表，只批量扫描当前所有剪辑中项目
    if (el.scanAll) {
        el.scanAll.addEventListener('click', function () {
            batchScanClipProjects(true);
        });
    }
    el.launch.addEventListener('click', launchWB);
    el.retry.addEventListener('click', function () { refresh(true); });
    // 筛选：状态 / 只看有进度 → 重渲染当前列表
    el.filterState.addEventListener('change', function () { renderFilteredList(); });
    el.filterProgress.addEventListener('change', function () { renderFilteredList(); });
    if (el.search) {
        var _st = 0;
        el.search.addEventListener('input', function () { renderFilteredList(); });
        el.search.addEventListener('keydown', function (e) { if (e.key === 'Escape') { el.search.value = ''; renderFilteredList(); } });
    }

    // 暴露给 script.js：写状态栏 / 取插件根目录
    window.__vhProgress = {
        setStatus: function (msg) { try { el.statusText.textContent = msg; } catch (e) {} },
        getExtRoot: function () { return extRoot; }
    };

    // 暴露给 main.js：切到 progress tab 时自动刷新一次（刷新会自动实扫剪辑中项目）
    window.__progressOnShow = function () {
        refresh(true);
    };

    // 初始化：先探测在线状态
    refresh(true);

})();
