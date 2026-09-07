// vh-Atelier 板块八：项目进度（联动「视频工作台」只读快照）
// 数据源：视频工作台 Flask 服务（127.0.0.1:8089），token 在 backend/config.yaml 的 web.api_secret
// 本面板只读展示：本月概览 + 组内进行中项目（集数进度/状态/剧名）
(function () {
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var child_process = require('child_process');

    var WB_PORT = 8089;
    var WB_BASE = 'http://127.0.0.1:' + WB_PORT;
    // 视频工作台 config.yaml 位置（默认桌面；可通过 localStorage 覆盖）
    var CFG_MEM_KEY = 'vh_progress_wb_yaml';
    var WB_CFG_PATH = 'C:/Users/Admin/Desktop/视频工作台/backend/config.yaml';
    var WB_START = 'C:/Users/Admin/Desktop/视频工作台/start_desktop.vbs';
    // 兜底：找不到 start_desktop.vbs 时用 main_desktop.py + pythonw
    var WB_PY = 'C:/Users/Admin/Desktop/视频工作台/main_desktop.py';
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
        offline: document.getElementById('prgOffline'),
        launch: document.getElementById('prgLaunch'),
        retry: document.getElementById('prgRetry'),
        activeWrap: document.getElementById('prgActiveWrap'),
        activeCount: document.getElementById('prgActiveCount'),
        activeList: document.getElementById('prgActiveList'),
        filterState: document.getElementById('prgFilterState'),
        filterProgress: document.getElementById('prgFilterProgress')
    };

    var busy = false;
    var lastData = null;
    var allActiveProjects = [];   // 最近一次拉到的 group_active 全量（供筛选/排序）

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
        // 本月项目 = 制作中 + 已完成（本月涉及的项目总数）
        var monthTotal = producing + done;
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
        var list = allActiveProjects.filter(function (p) {
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
            nm.title = p.name || '';
            var tag = document.createElement('span');
            tag.className = 'prg-state ' + stateClass(state);
            tag.textContent = state || '待同步';
            head.appendChild(nm);
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

            // 操作行：查剪辑 / 缺集明细 / 刷新进度（剪辑中）/ 组内NAS / 制作部 / 剧本 / 在工作台打开
            var openRow = document.createElement('div');
            openRow.className = 'prg-open-row';

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
            openRow.appendChild(searchBtn);

            // 📋 缺集/成片/修改 明细浮层
            var detBtn = document.createElement('button');
            detBtn.type = 'button';
            detBtn.className = 'prg-open-btn';
            detBtn.textContent = '📋 明细';
            detBtn.title = '缺集明细 + 成片列表 + 修改文件';
            detBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openProjectDetail(p);
            });
            openRow.appendChild(detBtn);


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
                openRow.appendChild(rfBtn);
            }

            // 📁 组内NAS
            if (p.group_path) {
                var gBtn = document.createElement('button');
                gBtn.type = 'button';
                gBtn.className = 'prg-open-btn';
                gBtn.textContent = '📁 组内NAS';
                gBtn.title = '打开组内 NAS 项目目录';
                gBtn.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    openProjFolder(p.name || '', 'group_root');
                });
                openRow.appendChild(gBtn);
            }

            // 🏢 制作部
            if (p.production_path) {
                var pBtn = document.createElement('button');
                pBtn.type = 'button';
                pBtn.className = 'prg-open-btn';
                pBtn.textContent = '🏢 制作部';
                pBtn.title = '打开制作部项目目录';
                pBtn.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    openProjFolder(p.name || '', 'prod');
                });
                openRow.appendChild(pBtn);
            }

            var scriptBtn = document.createElement('button');
            scriptBtn.type = 'button';
            scriptBtn.className = 'prg-open-btn prg-open-main';
            scriptBtn.textContent = '📖 剧本';
            scriptBtn.title = '在本地项目里找剧本并阅读';
            scriptBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openScriptForProject(p.name || '');
            });
            openRow.appendChild(scriptBtn);
            var openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.className = 'prg-open-btn';
            openBtn.textContent = '在工作台打开 ↗';
            openBtn.title = '跳转视频工作台并定位到该项目';
            openBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openInWorkbench(p.name || '');
            });
            openRow.appendChild(openBtn);

            // 🔗 分秒帧：点开该项目的分秒帧审核页（无链接先填）
            var fmBtn = document.createElement('button');
            fmBtn.type = 'button';
            fmBtn.className = 'prg-open-btn prg-fm-btn';
            fmBtn.textContent = '🔗 分秒帧';
            fmBtn.title = '打开该项目的分秒帧审核页；Shift+点击可修改链接';
            fmBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openFenmiaozhen(p.name || '', ev.shiftKey);
            });
            openRow.appendChild(fmBtn);
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
    var got = { ep: null, edit: null, rev: null };   // null=未返回，[] / {}=空结果
    var curTab = 'miss';          // 当前 tab
    var revSub = '';              // 修改子路径（空=修改根）
    var revStack = [];            // 导航栈
    var revFilesCache = [];       // 当前修改文件夹内文件缓存

    // DOM 引用（renderContent 构建后赋值）
    var dom = { ov: null, tabMiss: null, tabEdit: null, tabRev: null, body: null };

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
        // 当前 tab：数据变化时刷新。miss 只依赖 ep（首次已渲染，跳过）；edit/rev 各自依赖自身数据
        if (curTab === 'miss') return;
        if (curTab === 'edit' && got.edit !== null) renderCurrent();
        else if (curTab === 'rev' && got.rev !== null) renderCurrent();
    }

    function updateTabCounts() {
        if (!dom.tabMiss || !dom.tabEdit || !dom.tabRev) return;
        var missingN = got.ep && got.ep.ok ? (got.ep.missing || []).length : 0;
        dom.tabMiss.textContent = '缺集 ' + missingN;
        dom.tabEdit.textContent = '🎬 成片 ' + fileCount(got.edit);
        dom.tabRev.textContent = '📝 修改 ' + fileCount(got.rev);
    }

    function renderCurrent() {
        if (!dom.body) return;
        if (curTab === 'miss') { dom.body.innerHTML = ''; renderMiss(dom.body); }
        else if (curTab === 'edit') { dom.body.innerHTML = ''; renderEditFiles(dom.body); }
        else { dom.body.innerHTML = ''; renderRev(dom.body); }
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
        tabs.appendChild(dom.tabMiss);
        tabs.appendChild(dom.tabEdit);
        tabs.appendChild(dom.tabRev);
        content.appendChild(tabs);

        var body = document.createElement('div');
        body.style.cssText = 'min-height:120px;max-height:46vh;overflow-y:auto;';
        content.appendChild(body);
        dom.body = body;
        dom.ov = ov;

        dom.tabMiss.addEventListener('click', function () { switchTab('miss'); });
        dom.tabEdit.addEventListener('click', function () { switchTab('edit'); });
        dom.tabRev.addEventListener('click', function () { switchTab('rev'); });

        updateTabCounts();
        renderCurrent();
    }

    function switchTab(key) {
        curTab = key;
        var map = { miss: dom.tabMiss, edit: dom.tabEdit, rev: dom.tabRev };
        var keys = ['miss', 'edit', 'rev'];
        for (var i = 0; i < 3; i++) {
            var b = map[keys[i]];
            if (!b) continue;
            b.style.borderBottomColor = (keys[i] === key) ? 'var(--accent,#537d96)' : 'transparent';
            b.style.color = (keys[i] === key) ? 'var(--text,#e8e8e8)' : 'var(--muted,#999)';
        }
        if (!dom.body) return;
        dom.body.innerHTML = '';
        if (key === 'miss') renderMiss(dom.body);
        else if (key === 'edit') renderEditFiles(dom.body);
        else renderRev(dom.body);
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
                : '暂无成片文件';
            container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted,#888);font-size:12px">' + t + '</div>';
            return;
        }
        container.innerHTML = '';
        files.forEach(function (f) {
            var nm = f.name || f;
            mkFileRow(container, {
                icon: mode === 'revising' ? '✏️' : '🎬',
                name: nm,
                title: (f.path || '') + '\n点击播放，📂 打开所在目录',
                meta: f.editor || '',
                size: f.size_mb ? Math.round(f.size_mb) + 'MB' : '',
                onClick: function () {
                    try {
                        // 点击反馈：状态栏提示 + 行高亮，确保用户知道点击被接收
                        try { el.statusText.textContent = '点击：' + nm; } catch (e) {}
                        var rc = container.lastChild;
                        if (rc && rc.style) {
                            var origBg = rc.style.background;
                            rc.style.background = 'rgba(139,92,246,.25)';
                            setTimeout(function () { try { rc.style.background = origBg || ''; } catch (e) {} }, 250);
                        }
                        playVideo(projectName, nm, mode, subpath || '');
                    }
                    catch (err) {
                        el.statusText.textContent = '播放失败：' + (err && err.message);
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
            folders.forEach(function (fd) {
                var fname = fd.name || '';
                mkFileRow(container, {
                    icon: '📁',
                    name: fname,
                    title: (fd.abs_path || '') + '\n点击进入查看集数，📂 打开目录',
                    onClick: function () { enterRevFolder(fname); },
                    openDir: function () { if (fd.abs_path) openFolderPath(fd.abs_path); }
                });
            });
            // 修改根下的散文件（罕见）——仅在有值时追加，空时不显示误导性空态
            if (files.length) renderVideoRows(container, files, 'revising', '');
        } else {
            // 已进入修改文件夹：面包屑 + 集数视频
            var crumb = document.createElement('div');
            crumb.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px;';
            var backBtn = document.createElement('button');
            backBtn.type = 'button';
            backBtn.textContent = '← 返回';
            backBtn.style.cssText = 'background:none;border:1px solid var(--border,#555);color:var(--accent,#7aa7c7);border-radius:3px;padding:1px 8px;cursor:pointer;font-size:11px;';
            backBtn.addEventListener('click', function () {
                revSub = revStack.length ? revStack.pop() : '';
                fetchRevSub();
            });
            crumb.appendChild(backBtn);
            var crumbTxt = document.createElement('span');
            crumbTxt.style.cssText = 'color:var(--muted,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            crumbTxt.textContent = '📁 ' + revSub;
            crumbTxt.title = revSub;
            crumb.appendChild(crumbTxt);
            container.appendChild(crumb);
            if (revFilesCache.length) {
                renderVideoRows(container, revFilesCache, 'revising', revSub);
            } else {
                // 还没有缓存（刚进入/返回）：先显示加载中并拉取
                container.innerHTML += '<div style="padding:14px;text-align:center;color:var(--muted,#888);font-size:12px">⏳ 加载集数…</div>';
                fetchRevSub();
            }
        }
    }

    var revReqId = 0;
    function fetchRevSub() {
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
            if (curTab === 'rev' && revSub) {
                if (dom.body) { dom.body.innerHTML = ''; renderRev(dom.body); }
            }
        });
    }

    function enterRevFolder(fname) {
        revStack.push(revSub);
        revSub = revSub ? (revSub + '/' + fname) : fname;
        revFilesCache = [];
        fetchRevSub();
    }

    // 播放视频
    function playVideo(proj, fileName, mode, subpath) {
        var url = WB_BASE + '/api/preview/' + encodeURIComponent(proj) + '/' + encodeURIComponent(fileName)
            + '?mode=' + encodeURIComponent(mode);
        if (subpath) url += '&subpath=' + encodeURIComponent(subpath);
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
}


    function showVideoPlayer(proj, fileName, url, mode, subpath) {
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
        // 本地播放器按钮
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

        // 提示条
        var loadTip = document.createElement('div');
        loadTip.style.cssText = 'text-align:center;padding:5px;font-size:11px;color:#aaa;background:#151515;border-bottom:1px solid #222;min-height:16px;';
        loadTip.textContent = '⏳ 正在加载视频流…';
        box.appendChild(loadTip);

        // 视频
        var video = document.createElement('video');
        video.controls = true;
        video.style.cssText = 'display:block;width:100%;max-height:52vh;background:#000;';
        box.appendChild(video);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        _videoOverlay = overlay;
        var fallbackTimer = null;
        var openedLocal = false;

        function openInLocalPlayer() {
            if (openedLocal) return;
            openedLocal = true;
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
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
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
            loadTip.textContent = '';
            try { el.statusText.textContent = '播放中：' + fileName; } catch (e) {}
            try { var pp = video.play(); if (pp && pp.catch) pp.catch(function () {}); } catch (e) {}
        });
        // 视频加载失败 → 明确提示并给本地播放器兜底
        video.addEventListener('error', function () {
            if (openedLocal) return;
            loadTip.textContent = '⚠️ 内嵌播放失败（错误码 ' + (video.error ? video.error.code : '?') + '），自动用本地播放器打开…';
            openInLocalPlayer();
        });
        video.src = url;
        try { var pp = video.play(); if (pp && pp.catch) pp.catch(function () {}); } catch (e) {}

        // 超时兜底：4 秒没加载出画面 → 自动转本地播放器
        fallbackTimer = setTimeout(function () {
            if (openedLocal) return;
            var rs = 0; try { rs = video.readyState; } catch (e) {}
            if (rs < 2) {  // 还没 enough data
                loadTip.textContent = '⏱ 内嵌加载超时，自动用本地播放器打开…';
                openInLocalPlayer();
            }
        }, 4000);

        var closeIt = function () {
            if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
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

    // ==================== 剧本阅读（本地项目找 docx → 内嵌阅读） ====================
    var SCRIPT_ROOT = 'F:/001AI漫剧';  // 本地项目盘根目录（固定）

    // 从项目名提取用于匹配目录的特征：去掉序号前缀，保留下划线分隔的核心段
    function normName(n) {
        return String(n || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    // 在本地项目盘里找匹配的目录
    function findLocalProjectDir(projectName) {
        try {
            if (!fs.existsSync(SCRIPT_ROOT)) return null;
            var name = normName(projectName);
            var dirs = fs.readdirSync(SCRIPT_ROOT);
            // 候选匹配键：全名、去掉前导序号、取《》内剧名、下划线末段
            var candidates = [];
            candidates.push(name);
            var m0 = name.match(/^\d+[-_\s]*/);
            if (m0) candidates.push(name.slice(m0[0].length));
            var m1 = name.match(/《([^》]+)》/);
            if (m1) candidates.push(m1[1]);
            var segs = name.split('_');
            if (segs.length > 1) candidates.push(segs[segs.length - 1].trim());
            if (segs.length > 1) candidates.push(segs.slice(1).join('_'));
            var m2 = name.match(/\((.*)\)/);
            if (m2) candidates.push(m2[1]);

            // 去掉候选里的空格小写化，做包含匹配
            function squash(s) { return s.toLowerCase().replace(/\s+/g, ''); }
            var sqName = squash(name);
            var best = null, bestScore = 0;
            dirs.forEach(function (d) {
                if (d.charAt(0) === '.') return;
                var sqDir = squash(d);
                // 目录名包含项目全名（squash 后）得分最高
                var score = 0;
                if (sqDir === sqName) score = 100;
                else if (sqDir.indexOf(sqName) >= 0) score = 80;
                else if (sqName.indexOf(sqDir) >= 0) score = 60;
                else {
                    // 试各候选键包含
                    for (var ci = 0; ci < candidates.length; ci++) {
                        var c = squash(candidates[ci]);
                        if (c.length >= 2 && sqDir.indexOf(c) >= 0) { score = Math.max(score, 70 - ci); }
                    }
                }
                if (score > bestScore) { bestScore = score; best = d; }
            });
            return best ? path.join(SCRIPT_ROOT, best) : null;
        } catch (e) { return null; }
    }

    // 在项目目录递归找剧本 docx/pdf（过滤 ~$ 临时文件；优先「剧本/脚本」目录）
    function findScriptDocxList(projDir) {
        var found = [];
        var limit = 400;  // 防失控
        function walk(dir, depth) {
            if (depth > 5) return;
            try {
                var entries = fs.readdirSync(dir);
                entries.forEach(function (en) {
                    if (limit-- <= 0) return;
                    if (en.charAt(0) === '.') return;
                    // 跳过 Word 临时锁文件（~$开头）
                    if (en.charAt(0) === '~' && en.charAt(1) === '$') return;
                    var full = path.join(dir, en);
                    var st = null;
                    try { st = fs.statSync(full); } catch (e) { return; }
                    if (st.isDirectory()) {
                        walk(full, depth + 1);
                    } else {
                        var low = en.toLowerCase();
                        if (low.endsWith('.docx') || low.endsWith('.pdf')) {
                            found.push(full);
                        }
                    }
                });
            } catch (e) {}
        }
        var scriptDirs = [];
        // 先找「剧本/脚本」目录
        ['剧本', '脚本', 'Script'].forEach(function (k) {
            var p = path.join(projDir, k);
            if (fs.existsSync(p)) scriptDirs.push(p);
        });
        if (scriptDirs.length > 0) {
            scriptDirs.forEach(function (p) { walk(p, 1); });
        }
        if (found.length === 0) walk(projDir, 0);
        // 去重
        var uniq = [];
        found.forEach(function (f) { if (uniq.indexOf(f) < 0) uniq.push(f); });
        return uniq;
    }

    function findPython() {
        var c = [
            path.join(extRoot, 'runtime', 'python.exe'),
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe')
        ];
        for (var i = 0; i < c.length; i++) {
            if (fs.existsSync(c[i])) return c[i];
        }
        return 'python';
    }

    // 主入口：项目卡片点「剧本」→ 定位目录 → 找 docx（可能多个）→ 选择后打开阅读浮层
    // ==================== 剧本书签（固定剧本：手动选的记住，多剧本可固定） ====================
    var SCRIPT_MARKS_KEY = 'vh_script_marks';
    // { 项目名: [剧本绝对路径, ...] }  跨会话持久
    function loadScriptMarks() {
        try {
            var raw = localStorage.getItem(SCRIPT_MARKS_KEY);
            if (raw) {
                var o = JSON.parse(raw);
                if (o && typeof o === 'object') return o;
            }
        } catch (e) {}
        return {};
    }
    function saveScriptMarks(marks) {
        try { localStorage.setItem(SCRIPT_MARKS_KEY, JSON.stringify(marks)); } catch (e) {}
    }
    // 取某项目固定的剧本列表
    function getProjectMarks(projectName) {
        var marks = loadScriptMarks();
        var key = normName(projectName);
        var arr = marks[key] || [];
        // 过滤不存在的路径
        return arr.filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } });
    }
    // 给项目添加/移除固定剧本
    function addProjectMark(projectName, docxPath) {
        var marks = loadScriptMarks();
        var key = normName(projectName);
        var arr = marks[key] || [];
        if (arr.indexOf(docxPath) < 0) {
            arr.push(docxPath);
            marks[key] = arr;
            saveScriptMarks(marks);
        }
    }
    function removeProjectMark(projectName, docxPath) {
        var marks = loadScriptMarks();
        var key = normName(projectName);
        marks[key] = (marks[key] || []).filter(function (p) { return p !== docxPath; });
        if (marks[key].length === 0) delete marks[key];
        saveScriptMarks(marks);
    }

    // 打开某项目的剧本
    function openScriptForProject(projectName) {
        var fixed = getProjectMarks(projectName);
        var projDir = findLocalProjectDir(projectName);
        var auto = [];
        if (projDir) auto = findScriptDocxList(projDir);
        // 合并候选：固定优先，再加检测到的（去重）；最终只有一份就直接打开
        var cands = fixed.slice();
        auto.forEach(function (p) { if (cands.indexOf(p) < 0) cands.push(p); });
        if (cands.length === 0) {
            // 没找到剧本（或项目目录对不上）→ 手动选择
            showScriptMsg('没找到「' + projectName + '」的剧本。\n\n可手动选择剧本文件并固定，下次点开直接可用。',
                [{ text: '📂 手动选择剧本文件', primary: true, onClick: function () { browseScriptFile(projectName, true); } }]);
        } else if (cands.length === 1) {
            // 只有一份 → 直接打开
            loadScriptDocx(cands[0], projectName);
        } else {
            // 多份（固定多份或中英并存）→ 弹面板选
            showScriptPanel(projectName, fixed, auto, projDir);
        }
    }

    // 剧本面板：固定列表（常驻）+ 自动检测 + 添加按钮
    function showScriptPanel(projectName, fixed, auto, projDir) {
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:998;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:16px;max-width:560px;width:92%;box-sizing:border-box;max-height:80%;overflow-y:auto;';
        var title = document.createElement('div');
        title.style.cssText = 'font-size:13px;font-weight:600;color:#eee;margin-bottom:4px;';
        title.textContent = '📖 ' + projectName;
        box.appendChild(title);
        var sub = document.createElement('div');
        sub.style.cssText = 'font-size:11px;color:#9a9a9a;margin-bottom:10px;';
        sub.textContent = (projDir ? projDir : '未匹配到本地目录') + (fixed.length ? ' · 已固定 ' + fixed.length + ' 份' : '');
        box.appendChild(sub);

        function itemRow(p, isFixed) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;background:#242424;border:1px solid #333;border-radius:6px;padding:7px 10px;margin-bottom:6px;';
            var nm = document.createElement('span');
            nm.style.cssText = 'flex:1;font-size:12px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;';
            nm.textContent = path.basename(p);
            nm.title = p;
            nm.addEventListener('click', function () {
                if (modal.parentNode) modal.parentNode.removeChild(modal);
                loadScriptDocx(p, projectName);
            });
            row.appendChild(nm);
            if (isFixed) {
                var pin = document.createElement('span');
                pin.textContent = '📌 固定';
                pin.style.cssText = 'font-size:10px;color:#7fb3d9;flex:0 0 auto;';
                row.appendChild(pin);
                var rm = document.createElement('button');
                rm.textContent = '移除';
                rm.style.cssText = 'flex:0 0 auto;background:#3a1f1f;color:#ff9a9a;border:none;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;';
                rm.addEventListener('click', function () {
                    removeProjectMark(projectName, p);
                    // 刷新面板
                    var f2 = getProjectMarks(projectName);
                    var a2 = projDir ? findScriptDocxList(projDir) : [];
                    if (modal.parentNode) modal.parentNode.removeChild(modal);
                    if (f2.length > 0 || a2.length > 0) showScriptPanel(projectName, f2, a2, projDir);
                    else showScriptMsg('已移除。项目没有固定的剧本了。', [{ text: '📂 手动选择剧本文件', primary: true, onClick: function () { browseScriptFile(projectName, true); } }]);
                });
                row.appendChild(rm);
            } else {
                var pinBtn = document.createElement('button');
                pinBtn.textContent = '📌 固定';
                pinBtn.style.cssText = 'flex:0 0 auto;background:#1e3a5b;color:#6db3ff;border:none;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;';
                pinBtn.addEventListener('click', function () {
                    addProjectMark(projectName, p);
                    var f3 = getProjectMarks(projectName);
                    var a3 = projDir ? findScriptDocxList(projDir) : [];
                    if (modal.parentNode) modal.parentNode.removeChild(modal);
                    showScriptPanel(projectName, f3, a3, projDir);
                });
                row.appendChild(pinBtn);
            }
            return row;
        }

        // 固定列表
        if (fixed.length > 0) {
            var fh = document.createElement('div');
            fh.style.cssText = 'font-size:11px;color:#7fb3d9;font-weight:600;margin:4px 0 6px;';
            fh.textContent = '已固定（点击打开）';
            box.appendChild(fh);
            fixed.forEach(function (p) { box.appendChild(itemRow(p, true)); });
        }
        // 自动检测但未固定的
        var autoNew = auto.filter(function (p) { return fixed.indexOf(p) < 0; });
        if (autoNew.length > 0) {
            var ah = document.createElement('div');
            ah.style.cssText = 'font-size:11px;color:#9a9a9a;font-weight:600;margin:8px 0 6px;';
            ah.textContent = '在项目里检测到的（可固定）';
            box.appendChild(ah);
            autoNew.forEach(function (p) { box.appendChild(itemRow(p, false)); });
        }
        // 底部按钮：添加文件 / 关闭
        var rowBtn = document.createElement('div');
        rowBtn.style.cssText = 'display:flex;gap:8px;margin-top:10px;justify-content:flex-end;';
        var addB = document.createElement('button');
        addB.textContent = '📂 添加剧本文件…';
        addB.style.cssText = 'background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;';
        addB.addEventListener('click', function () {
            if (modal.parentNode) modal.parentNode.removeChild(modal);
            browseScriptFile(projectName, true);
        });
        rowBtn.appendChild(addB);
        var ok = document.createElement('button');
        ok.textContent = '关闭';
        ok.style.cssText = 'background:#3a3a3a;color:#ccc;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;';
        ok.addEventListener('click', function () { if (modal.parentNode) modal.parentNode.removeChild(modal); });
        rowBtn.appendChild(ok);
        box.appendChild(rowBtn);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    // 手动选剧本 docx（addToMark=true 时固定）
    function browseScriptFile(projectName, addToMark) {
        var result;
        try {
            result = window.cep.fs.showOpenDialogEx(false, false, '选择剧本 docx/pdf', '', [], '', '选择');
        } catch (e) {
            showScriptMsg('打开文件选择失败: ' + e.message);
            return;
        }
        var p = result && result.data && result.data[0];
        if (p) {
            if (addToMark) addProjectMark(projectName || '', p);
            loadScriptDocx(p, projectName || '');
        }
    }

    // 解析指定剧本文件（docx/pdf）并打开阅读浮层
    // restoreEp: 可选，打开后定位到第几集（用于自动续读）
    function loadScriptDocx(docx, projectName, restoreEp) {
        el.statusText.textContent = '解析剧本：' + path.basename(docx) + '…';
        var py = findPython();
        var scriptPath = path.join(extRoot, 'py', 'docx_read.py');
        if (!fs.existsSync(scriptPath)) {
            showScriptMsg('找不到 py/docx_read.py');
            return;
        }
        try {
            var r = child_process.spawnSync(py, [scriptPath, '--file', docx], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            var data = null;
            var out = (r.stdout || '').trim();
            function tryParse(s) {
                try { return JSON.parse(s); } catch (e) { return null; }
            }
            data = tryParse(out);
            if (!data) {
                // PyMuPDF 可能把 deprecation warning 打到 stdout 污染 JSON；从第一个 { 起截取再试
                var brace = out.indexOf('{');
                if (brace > 0) data = tryParse(out.slice(brace));
            }
            if (!data) {
                data = tryParse((r.stderr || '').trim());
                if (!data) {
                    var sb = (r.stderr || '');
                    var sbBrace = sb.indexOf('{');
                    if (sbBrace > 0) data = tryParse(sb.slice(sbBrace));
                }
            }
            if (!data || !data.ok) {
                var msg = ((data && data.error) || (r.stderr || '').slice(0, 300) || '未知错误');
                var low = docx.toLowerCase();
                if (low.endsWith('.pdf')) {
                    msg += '\n\n（PDF 剧本需为文字版；若是扫描图片版 PDF 暂不支持）';
                }
                showScriptMsg('解析剧本失败：' + msg + '\n\n文件：' + docx);
                return;
            }
            openScriptReader(data, docx, projectName, restoreEp);
        } catch (e) {
            showScriptMsg('调用解析器失败：' + e.message);
        }
    }

    // 简易消息弹层（支持附加按钮）
    function showScriptMsg(text, buttons) {
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:998;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:18px;max-width:520px;width:90%;box-sizing:border-box;font-size:12px;color:#ddd;line-height:1.7;white-space:pre-wrap;word-break:break-word;';
        box.textContent = text;
        var row = document.createElement('div');
        row.style.cssText = 'margin-top:14px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
        // 附加按钮
        (buttons || []).forEach(function (b) {
            var btn = document.createElement('button');
            btn.textContent = b.text;
            btn.style.cssText = b.primary ? 'background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;' : 'background:#3a3a3a;color:#ccc;border:none;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:12px;';
            btn.addEventListener('click', function () {
                if (modal.parentNode) modal.parentNode.removeChild(modal);
                if (b.onClick) b.onClick();
            });
            row.appendChild(btn);
        });
        var ok = document.createElement('button');
        ok.textContent = '知道了';
        ok.style.cssText = 'background:#3a3a3a;color:#ccc;border:none;border-radius:4px;padding:6px 16px;cursor:pointer;font-size:12px;';
        ok.addEventListener('click', function () { if (modal.parentNode) modal.parentNode.removeChild(modal); });
        row.appendChild(ok);
        box.appendChild(row);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    // ==================== 剧本库首页（常驻入口：手动开 / 最近 / 固定） ====================
    var SCRIPT_RECENT_KEY = 'vh_script_recent';   // [{ path, name, project, t }] 最近阅读（新的在前）
    var SCRIPT_HOME_SHOWN = false;

    function loadRecentScripts() {
        try {
            var raw = localStorage.getItem(SCRIPT_RECENT_KEY);
            if (raw) {
                var arr = JSON.parse(raw);
                if (Array.isArray(arr)) return arr;
            }
        } catch (e) {}
        return [];
    }
    function saveRecentScripts(arr) {
        try { localStorage.setItem(SCRIPT_RECENT_KEY, JSON.stringify(arr)); } catch (e) {}
    }
    // 打开剧本时记录最近（去重，最多 30 条）
    function pushRecentScript(docxPath, projectName) {
        try {
            var arr = loadRecentScripts();
            arr = arr.filter(function (r) { return r.path !== docxPath; });
            arr.unshift({ path: docxPath, name: path.basename(docxPath), project: projectName || '', t: Date.now() });
            if (arr.length > 30) arr = arr.slice(0, 30);
            saveRecentScripts(arr);
        } catch (e) {}
    }
    // 汇总所有项目下固定的剧本：返回 [{ path, name, project }]
    function collectAllFixedScripts() {
        var marks = loadScriptMarks();
        var out = [];
        Object.keys(marks).forEach(function (proj) {
            (marks[proj] || []).forEach(function (p) {
                try { if (fs.existsSync(p)) out.push({ path: p, name: path.basename(p), project: proj }); } catch (e) {}
            });
        });
        return out;
    }

    // 在读状态：记住上次读的剧本 + 集（点「剧本」组时自动续读；关闭剧本时清除）
    var SCRIPT_READING_KEY = 'vh_script_reading';  // { path, ep }  ep: null=全部 / 数字=第几集
    function saveReading(path, ep) {
        try { localStorage.setItem(SCRIPT_READING_KEY, JSON.stringify({ path: path, ep: ep })); } catch (e) {}
    }
    function clearReading() {
        try { localStorage.removeItem(SCRIPT_READING_KEY); } catch (e) {}
    }
    function loadReading() {
        try {
            var raw = localStorage.getItem(SCRIPT_READING_KEY);
            if (raw) {
                var o = JSON.parse(raw);
                if (o && o.path) return o;
            }
        } catch (e) {}
        return null;
    }

    // 剧本库首页：手动打开按钮 + 最近阅读 + 已固定剧本
    function showScriptHome() {
        var hostPanel = document.getElementById('panel-script');
        if (!hostPanel) return;
        hostPanel.innerHTML = '';
        var box = document.createElement('div');
        box.id = 'scriptHomeBox';
        box.style.cssText = 'flex:1;height:auto;display:flex;flex-direction:column;overflow:hidden;background:var(--panel,#181818);border-radius:8px;border:1px solid #3a3a3a;padding:14px 16px;overflow-y:auto;';

        // 标题
        var h = document.createElement('div');
        h.style.cssText = 'font-size:14px;font-weight:600;color:#e8e8e8;margin-bottom:4px;';
        h.textContent = '📖 剧本库';
        box.appendChild(h);
        var sub = document.createElement('div');
        sub.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:14px;';
        sub.textContent = '不依赖视频工作台项目，直接打开本地剧本阅读';
        box.appendChild(sub);

        // 手动打开按钮
        var openBtn = document.createElement('button');
        openBtn.textContent = '📂  打开剧本文件…';
        openBtn.style.cssText = 'display:block;width:100%;padding:12px;font-size:13px;font-weight:600;background:var(--accent,#537d96);color:#fff;border:none;border-radius:8px;cursor:pointer;margin-bottom:14px;';
        openBtn.addEventListener('click', function () { browseScriptFile('', false); });
        box.appendChild(openBtn);

        // 段标题工具
        function secTitle(txt, hint) {
            var t = document.createElement('div');
            t.style.cssText = 'font-size:11px;color:#9fb3c8;font-weight:600;margin:6px 0 6px;display:flex;align-items:center;gap:8px;';
            var sp = document.createElement('span');
            sp.textContent = txt;
            t.appendChild(sp);
            if (hint) {
                var hs = document.createElement('span');
                hs.textContent = hint;
                hs.style.cssText = 'color:var(--muted);font-weight:400;font-size:10px;';
                t.appendChild(hs);
            }
            return t;
        }
        function itemRow(p, metaRight) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;background:#242424;border:1px solid #333;border-radius:6px;padding:7px 10px;margin-bottom:6px;cursor:pointer;';
            row.addEventListener('click', function () { loadScriptDocx(p, ''); });
            var ic = document.createElement('span');
            ic.textContent = '📄';
            row.appendChild(ic);
            var nm = document.createElement('span');
            nm.style.cssText = 'flex:1;font-size:12px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            nm.textContent = path.basename(p);
            nm.title = p;
            row.appendChild(nm);
            if (metaRight) {
                var mt = document.createElement('span');
                mt.style.cssText = 'flex:0 0 auto;font-size:10px;color:var(--muted);';
                mt.textContent = metaRight;
                row.appendChild(mt);
            }
            return row;
        }

        // 最近阅读
        var recents = loadRecentScripts().filter(function (r) {
            try { return fs.existsSync(r.path); } catch (e) { return false; }
        });
        if (recents.length > 0) {
            box.appendChild(secTitle('最近阅读', '点开即读'));
            recents.slice(0, 10).forEach(function (r) {
                var when = '';
                try {
                    var d = new Date(r.t);
                    var now = new Date();
                    var sameDay = d.toDateString() === now.toDateString();
                    when = sameDay ? '今天 ' + (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes()
                        : (d.getMonth() + 1) + '/' + d.getDate();
                } catch (e) {}
                var meta = r.project ? (r.project + ' · ' + when) : when;
                box.appendChild(itemRow(r.path, meta));
            });
        }

        // 已固定（跨项目汇总）
        var fixed = collectAllFixedScripts();
        if (fixed.length > 0) {
            box.appendChild(secTitle('已固定', '点开即读'));
            fixed.forEach(function (f) {
                box.appendChild(itemRow(f.path, f.project));
            });
        }

        if (recents.length === 0 && fixed.length === 0) {
            var tip = document.createElement('div');
            tip.style.cssText = 'padding:18px;text-align:center;font-size:12px;color:var(--muted);background:#202020;border:1px dashed #3a3a3a;border-radius:8px;line-height:1.8;';
            tip.innerHTML = '还没有剧本记录。<br>点上方「📂 打开剧本文件…」选一个 docx / pdf 开始，<br>或从视频工作台项目卡片里点「剧本」打开。<br><br>打开过的会自动出现在「最近阅读」，方便下次直接点。';
            box.appendChild(tip);
        }

        hostPanel.appendChild(box);
    }

    // 暴露给 main.js：切到剧本组且面板为空时，渲染首页（若有在读剧本则自动续开）
    window.__atShowScriptHome = function () {
        var hostPanel = document.getElementById('panel-script');
        if (!hostPanel) return;
        var hasReader = hostPanel.querySelector('#scriptReaderBox');
        var hasHome = hostPanel.querySelector('#scriptHomeBox');
        if (hasReader) return;  // 阅读器还在，不打扰
        if (hasHome) { showScriptHome(); return; }  // 已显示首页则刷新最近/固定
        // 面板空：优先自动续读上次打开的剧本
        var reading = loadReading();
        if (reading && reading.path) {
            var exist = false;
            try { exist = fs.existsSync(reading.path); } catch (e) {}
            if (exist) {
                loadScriptDocx(reading.path, '', reading.ep);
                return;
            }
            clearReading();  // 文件已不在，清记录回首页
        }
        showScriptHome();
    };

    // 剧本阅读浮层：左集数列表 + 右内容 + 搜索（集号跳转/关键词高亮）+ 翻译/复制
    // restoreEp: 打开后定位到的集（可为 null=全部）
    function openScriptReader(data, docxPath, projectName, restoreEp) {
        // 剧本阅读作为独立面板（panel-script + 顶部「剧本」组），不遮挡其它板块
        var hostPanel = document.getElementById('panel-script');
        if (!hostPanel) return;
        // 记录最近阅读（跨项目，供剧本库首页）
        if (docxPath) pushRecentScript(docxPath, projectName);
        // 记为「在读」：点剧本组自动续读；关闭时清除
        saveReading(docxPath, restoreEp != null ? restoreEp : null);
        hostPanel.innerHTML = '';
        var box = document.createElement('div');
        box.id = 'scriptReaderBox';
        box.style.cssText = 'flex:1;height:auto;display:flex;flex-direction:column;overflow:hidden;background:var(--panel,#181818);border-radius:8px;border:1px solid #3a3a3a;';

        // ---------- 头部 ----------
        var head = document.createElement('div');
        head.style.cssText = 'padding:6px 12px;border-bottom:1px solid #2e2e2e;display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#222;border-radius:8px 8px 0 0;';
        var title = document.createElement('span');
        title.style.cssText = 'font-size:12.5px;font-weight:600;color:#e8e8e8;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;';
        title.textContent = '📖 ' + (projectName || '') + (docxPath ? ' · ' + path.basename(docxPath) : '');
        title.title = docxPath;
        head.appendChild(title);
        // 搜索框
        var searchInp = document.createElement('input');
        searchInp.type = 'text';
        searchInp.placeholder = '🔍 输入集号（如 3）或关键词…';
        searchInp.style.cssText = 'flex:1;min-width:150px;background:#242424;color:#ddd;border:1px solid #444;border-radius:4px;padding:5px 8px;font-size:12px;';
        head.appendChild(searchInp);
        var searchState = document.createElement('span');
        searchState.style.cssText = 'font-size:11px;color:#c9a86a;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        head.appendChild(searchState);
        // 翻译
        var transBtn = document.createElement('button');
        transBtn.textContent = '🌐 翻译台词';
        transBtn.style.cssText = 'background:#1e3a2a;color:#7fd68b;border:1px solid #2a5a3a;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;';
        head.appendChild(transBtn);
        var transState = document.createElement('span');
        transState.style.cssText = 'font-size:11px;color:#888;';
        head.appendChild(transState);
        var mailBtn = document.createElement('button');
        mailBtn.textContent = '📮';
        mailBtn.title = '设置翻译邮箱（MyMemory 提额 10 倍）';
        mailBtn.style.cssText = 'background:#2a2a2a;color:#c9a86a;border:1px solid #4a4a2a;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px;';
        head.appendChild(mailBtn);
        // 换一个剧本：回剧本库首页（不关闭面板）
        var switchBtn = document.createElement('button');
        switchBtn.textContent = '📂 换剧本';
        switchBtn.title = '回到剧本库，换一个剧本';
        switchBtn.style.cssText = 'background:#1e3a2a;color:#7fd68b;border:1px solid #2a5a3a;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;flex:0 0 auto;';
        switchBtn.addEventListener('click', function () {
            document.removeEventListener('keydown', escHandler);
            clearReading();   // 主动换剧本：不再续读当前这本
            if (hostPanel) hostPanel.innerHTML = '';
            showScriptHome();
            if (window.__atSwitchToScript) { try { window.__atSwitchToScript(); } catch (e) {} }
        });
        head.appendChild(switchBtn);
        var close = document.createElement('button');
        close.textContent = '✕ 关闭剧本';
        close.title = '关闭剧本阅读，返回进度';
        close.style.cssText = 'background:#4a2a2a;color:#ff9a9a;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;flex:0 0 auto;';
        head.appendChild(close);
        box.appendChild(head);

        // ---------- 主体：左列表 + 右内容 ----------
        var main = document.createElement('div');
        main.style.cssText = 'flex:1;display:flex;overflow:hidden;min-height:0;';
        // 左栏：集数列表
        var sidebar = document.createElement('div');
        sidebar.style.cssText = 'width:150px;flex:0 0 150px;border-right:1px solid #2a2a2a;overflow-y:auto;background:#141414;padding:6px 0;';
        main.appendChild(sidebar);
        // 右栏：内容
        var body = document.createElement('div');
        body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 18px 40px;font-size:13.5px;line-height:1.8;color:#ddd;word-break:break-word;';
        main.appendChild(body);
        box.appendChild(main);
        hostPanel.appendChild(box);
        // 显示「剧本」组并切换过去
        if (window.__atShowScriptGroup) {
            try { window.__atShowScriptGroup(); } catch (e) {}
        }

        // ---------- 状态 ----------
        var eps = data.episodes || [];
        // 恢复上次阅读的集：restoreEp 存在且在该剧本集数内才定位；否则 null=全部
        var curEp = null;
        if (restoreEp != null && eps.indexOf(restoreEp) >= 0) curEp = restoreEp;
        var curEpKey = curEp != null ? String(curEp) : 'all';
        var translating = false;
        var transMap = {};           // 批量翻译缓存：'__'+epkey -> {台词行:译文}
        var lineTransMap = {};       // 单句翻译缓存
        var searchKeyword = '';      // 关键词搜索（非集号时）

        function epLines(ep) {
            return (data.lines || []).filter(function (x) { return ep ? x.episode === ep : true; });
        }
        function extractEnglish(line) {
            var t = line || '';
            var m = t.match(/^[^:：]*[:：]\s*(.*)$/);
            if (m) t = m[1];
            t = t.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/g, ' ').replace(/\s+/g, ' ').trim();
            return t;
        }
        function isEnglish(s) { return /[A-Za-z]{3,}/.test(s); }
        function translateLine(text, cb) {
            var U = window.__vhUtils || {};
            var url = (U.myMemoryUrl ? U.myMemoryUrl(text) :
                'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en%7Czh-CN');
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.timeout = 15000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                try {
                    var j = JSON.parse(xhr.responseText);
                    var out = j && j.responseData && j.responseData.translatedText;
                    cb(null, out || '');
                } catch (e) { cb(e); }
            };
            xhr.onerror = function () { cb(new Error('网络错误')); };
            xhr.ontimeout = function () { cb(new Error('超时')); };
            xhr.send();
        }

        // ---------- 左栏集数列表 ----------
        function renderSidebar() {
            sidebar.innerHTML = '';
            function addItem(label, ep) {
                var it = document.createElement('div');
                it.style.cssText = 'padding:5px 12px;font-size:12px;color:#aaa;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:2px solid transparent;';
                it.textContent = label;
                if (curEp === ep) {
                    it.style.background = '#22303c';
                    it.style.color = '#8fc0e8';
                    it.style.borderLeft = '2px solid #537d96';
                }
                it.addEventListener('click', function () {
                    curEp = ep;
                    curEpKey = curEp != null ? String(curEp) : 'all';
                    searchKeyword = '';
                    searchInp.value = '';
                    searchState.textContent = '';
                    saveReading(docxPath, curEp);   // 记住读到第几集
                    renderSidebar();
                    render();
                });
                sidebar.appendChild(it);
            }
            addItem('📄 全部', null);
            eps.forEach(function (e) { addItem('第 ' + e + ' 集', e); });
        }

        // ---------- 台词渲染 ----------
        function renderDialogue(text) {
            var m = text.match(/^([^:：]{1,50}?)[：:]\s*(.*)$/);
            if (!m) return '<div class="scr-dlg">' + escHtml(text) + '</div>';
            var rolePart = m[1], speech = m[2];
            var zhCount = (speech.match(/[\u4e00-\u9fff]/g) || []).length;
            var enCount = (speech.match(/[A-Za-z]/g) || []).length;
            var isZhMain = zhCount > enCount && zhCount > 2;
            var roleHtml = escHtml(rolePart);
            roleHtml = roleHtml.replace(/([（(][^）)]*[）)])/g, '<span style="color:#9a8a8a;font-weight:400;">$1</span>');
            var speechHtml;
            if (isZhMain) {
                speechHtml = escHtml(speech).replace(/([（(][^）)]*[）)])/g, '<span style="color:#9a8a8a;font-size:12px;">$1</span>');
            } else {
                speechHtml = escHtml(speech).replace(/([\u4e00-\u9fff]+)/g, '<span style="color:#9a9a9a;font-size:12px;">$1</span>');
            }
            // 关键词高亮
            if (searchKeyword) {
                var kw = searchKeyword;
                speechHtml = hlText(speechHtml, kw);
                roleHtml = hlText(roleHtml, kw);
            }
            var spColor = isZhMain ? '#ff9090' : '#ff6b6b';
            var cachedZh = lineTransMap[text];
            var zhHtml = '';
            if (cachedZh) zhHtml = '<div class="scr-zh">' + escHtml(cachedZh) + '</div>';
            else {
                // 批量翻译缓存（整集翻译按钮）
                var bk = curEpKey;
                if (bk && transMap['__' + bk] && transMap['__' + bk][text]) {
                    zhHtml = '<div class="scr-zh">' + escHtml(transMap['__' + bk][text]) + '</div>';
                }
            }
            var en = extractEnglish(text);
            return '<div class="scr-dlg"><span style="color:#ffb347;font-weight:700;">' + roleHtml + '</span><span style="color:#8a7a6a;"> : </span><span style="color:' + spColor + ';">' + speechHtml + '</span><span class="scr-copy" data-copy="' + escHtml(speech) + '" title="复制台词">⧉</span><span class="scr-trn" data-line="' + escHtml(text) + '" data-en="' + escHtml(en) + '" title="翻译本句">译</span>' + zhHtml + '</div>';
        }
        // 在已转义 HTML 上做关键词高亮（简单：大小写不敏感子串包 <mark>）—— 因 HTML 已含标签，仅在纯文本段操作有风险；改为渲染前对原文高亮。
        function hlText(escapedHtml, kw) { return escapedHtml; } // 占位，实际用 render 层高亮

        // 渲染右栏
        function render() {
            var lines = data.lines || [];
            var html = '';
            var hitCount = 0;
            for (var li = 0; li < lines.length; li++) {
                var x = lines[li];
                if (curEp && x.episode !== curEp) continue;
                var t = x.text || '';
                var tp = x.type || 'plain';
                // 关键词过滤：命中才显示
                if (searchKeyword) {
                    if (t.toLowerCase().indexOf(searchKeyword) < 0) continue;
                    hitCount++;
                }
                var disp = escHtml(t);
                if (searchKeyword) {
                    disp = hlOnPlain(t);
                }
                if (tp === 'ep_title') {
                    html += '<div class="scr-ept" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'scene') {
                    html += '<div class="scr-scene" data-raw="' + escHtml(t) + '">🎬 ' + disp + '</div>';
                } else if (tp === 'cast') {
                    html += '<div class="scr-cast" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'action') {
                    html += '<div class="scr-action" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'caption') {
                    html += '<div class="scr-caption" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'dialogue') {
                    html += renderDialogue(t);
                } else {
                    html += '<div class="scr-plain" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                }
            }
            if (searchKeyword) {
                searchState.textContent = '命中 ' + hitCount + ' 处';
            }
            body.innerHTML = html || (searchKeyword ? '<div style="color:#888;padding:30px;text-align:center;">没有匹配「' + escHtml(searchKeyword) + '」的内容</div>' : '<div style="color:#888;padding:30px;text-align:center;">该集暂无内容</div>');
            body.scrollTop = 0;
            applyHighlight();
        }
        // 纯文本关键词高亮（在转义前的原文上做，避免破坏 HTML）
        function hlOnPlain(raw) {
            var kw = searchKeyword;
            if (!kw) return escHtml(raw);
            var out = '';
            var lower = raw.toLowerCase();
            var i = 0;
            while (true) {
                var idx = lower.indexOf(kw, i);
                if (idx < 0) { out += escHtml(raw.slice(i)); break; }
                out += escHtml(raw.slice(i, idx)) + '<mark class="scr-hl">' + escHtml(raw.slice(idx, idx + kw.length)) + '</mark>';
                i = idx + kw.length;
            }
            return out;
        }
        // 渲染后把 dialogue 行内的关键词也高亮（dialogue 走了 renderDialogue 未处理搜索词，用 DOM 补）
        function applyHighlight() {
            if (!searchKeyword) return;
            var kw = searchKeyword;
            var dlgEls = body.querySelectorAll('.scr-dlg');
            for (var i = 0; i < dlgEls.length; i++) {
                var el = dlgEls[i];
                if (el.getAttribute('data-hl')) continue;
                walkHighlight(el, kw);
                el.setAttribute('data-hl', '1');
            }
        }
        function walkHighlight(el, kw) {
            // 遍历文本节点，命中包 mark
            var nodes = el.childNodes;
            var toReplace = [];
            for (var i = 0; i < nodes.length; i++) {
                var n = nodes[i];
                if (n.nodeType === 3) {
                    var txt = n.nodeValue;
                    var lower = txt.toLowerCase();
                    if (lower.indexOf(kw) >= 0) toReplace.push(n);
                } else if (n.nodeType === 1 && n.tagName !== 'MARK' && n.tagName !== 'SPAN') {
                    walkHighlight(n, kw);
                } else if (n.nodeType === 1 && n.tagName === 'SPAN') {
                    walkHighlight(n, kw);
                }
            }
            toReplace.forEach(function (n) {
                var txt = n.nodeValue;
                var lower = txt.toLowerCase();
                var frag = document.createDocumentFragment();
                var i = 0;
                while (true) {
                    var idx = lower.indexOf(kw, i);
                    if (idx < 0) { frag.appendChild(document.createTextNode(txt.slice(i))); break; }
                    frag.appendChild(document.createTextNode(txt.slice(i, idx)));
                    var mk = document.createElement('mark');
                    mk.className = 'scr-hl';
                    mk.textContent = txt.slice(idx, idx + kw.length);
                    frag.appendChild(mk);
                    i = idx + kw.length;
                }
                n.parentNode.replaceChild(frag, n);
            });
        }

        // 样式
        var st = document.createElement('style');
        st.textContent = '.scr-dlg{margin:3px 0;padding:2px 4px;position:relative;} .scr-dlg:hover{background:#242020;} .scr-dlg .scr-copy,.scr-dlg .scr-trn{visibility:hidden;display:inline;color:#888;cursor:pointer;font-size:11px;padding:0 4px;margin-left:4px;border-radius:3px;vertical-align:middle;} .scr-dlg:hover .scr-copy,.scr-dlg:hover .scr-trn{visibility:visible;} .scr-dlg .scr-copy:hover{color:#ffb347;background:#2a2a2a;} .scr-dlg .scr-trn:hover{color:#7fd68b;background:#1e2a1e;} .scr-zh{margin-top:2px;padding-left:8px;border-left:2px solid #4a6b4a;color:#9fe0a8;font-size:12.5px;} .scr-ept{margin:16px 0 8px;padding:5px 12px;background:#22303c;border-left:4px solid #537d96;border-radius:3px;font-weight:700;font-size:14px;color:#8fc0e8;} .scr-scene{margin:10px 0 3px;padding:2px 8px;color:#7fb3d9;font-weight:600;font-size:12.5px;} .scr-cast{color:#999;font-size:12px;padding:1px 8px;} .scr-action{color:#9a9a9a;font-style:italic;font-size:12.5px;padding:1px 8px;border-left:2px solid #3a3a3a;margin:2px 0;} .scr-caption{color:#c9a86a;font-size:12px;padding:1px 8px;} .scr-plain{padding:1px 8px;} mark.scr-hl{background:#5a4a1e;color:#ffd76a;padding:0 1px;border-radius:2px;}';
        document.head.appendChild(st);

        // 事件委托：复制 + 单句翻译
        if (!window.__copyDelegateBound) {
            window.__copyDelegateBound = true;
            document.body.addEventListener('click', function (e) {
                var el2 = e.target.closest ? e.target.closest('.scr-copy') : null;
                if (el2 && el2.getAttribute('data-copy')) window.__copyText(el2.getAttribute('data-copy'));
            });
        }
        body.addEventListener('click', function (e) {
            var trn = e.target.closest ? e.target.closest('.scr-trn') : null;
            if (!trn) return;
            var line = trn.getAttribute('data-line');
            var en = trn.getAttribute('data-en') || '';
            var dlg = trn.closest('.scr-dlg');
            if (!dlg || !line) return;
            if (lineTransMap[line]) { ensureZh(dlg, lineTransMap[line]); return; }
            if (!en || !isEnglish(en)) { trn.textContent = '本句非英文'; return; }
            trn.textContent = '译中…';
            translateLine(en, function (err, zh) {
                if (err || !zh) { trn.textContent = '译'; window.__copyFlash && window.__copyFlash('翻译失败'); return; }
                lineTransMap[line] = zh;
                trn.textContent = '译';
                ensureZh(dlg, zh);
            });
        });
        function ensureZh(dlg, zh) {
            if (!zh) return;
            var olds = dlg.querySelectorAll('.scr-zh');
            for (var oi = 0; oi < olds.length; oi++) olds[oi].parentNode.removeChild(olds[oi]);
            var d = document.createElement('div');
            d.className = 'scr-zh';
            d.textContent = zh;
            dlg.appendChild(d);
        }
        window.__copyFlash = function (msg) {
            var tip = document.createElement('span');
            tip.textContent = msg || '✓ 已复制';
            var okStyle = (msg || '').indexOf('失败') >= 0;
            tip.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);background:' + (okStyle ? '#3a2a2a' : '#2a3a2a') + ';color:' + (okStyle ? '#ff9090' : '#7fd68b') + ';padding:6px 14px;border-radius:6px;font-size:12px;z-index:1001;pointer-events:none;';
            document.body.appendChild(tip);
            setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 1400);
        };

        // 搜索框：纯数字 → 集号跳转；否则关键词检索
        searchInp.addEventListener('input', function () {
            var v = searchInp.value.trim();
            if (!v) { searchKeyword = ''; curEp = null; curEpKey = 'all'; renderSidebar(); render(); return; }
            // 数字 → 集号
            var numM = v.match(/^\s*(\d+)\s*$/);
            if (numM) {
                var n = parseInt(numM[1], 10);
                if (eps.indexOf(n) >= 0) {
                    curEp = n;
                    curEpKey = String(n);
                    searchKeyword = '';
                    searchState.textContent = '已跳转 第' + n + ' 集';
                    saveReading(docxPath, curEp);   // 跳集也算在读位置
                    renderSidebar();
                    render();
                    return;
                }
            }
            // 第X集 形式
            var epM = v.match(/^第\s*(\d+)\s*集$/);
            if (epM) {
                var n2 = parseInt(epM[1], 10);
                if (eps.indexOf(n2) >= 0) {
                    curEp = n2;
                    curEpKey = String(n2);
                    searchKeyword = '';
                    searchState.textContent = '已跳转 第' + n2 + ' 集';
                    saveReading(docxPath, curEp);
                    renderSidebar(); render(); return;
                }
            }
            // 关键词：全文（所有集）检索
            curEp = null;
            curEpKey = 'all';
            searchKeyword = v.toLowerCase();
            renderSidebar();
            render();
        });
        // Enter：清空搜索回全部
        searchInp.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { searchInp.value = ''; searchKeyword = ''; curEp = null; curEpKey = 'all'; searchState.textContent = ''; renderSidebar(); render(); e.stopPropagation(); }
        });

        // 整集翻译
        function doTranslate() {
            if (translating) return;
            var key = curEp ? String(curEp) : 'all';
            if (transMap['__' + key]) { curEpKey = key; render(); transState.textContent = '（已翻译）'; return; }
            var targets = [];
            epLines(curEp).forEach(function (x) {
                if (x.type !== 'dialogue') return;
                var en = extractEnglish(x.text);
                if (en && isEnglish(en)) targets.push(x.text);
            });
            if (targets.length === 0) { transState.textContent = '该范围没有可翻译的英文台词'; return; }
            translating = true;
            transBtn.disabled = true;
            transState.textContent = '翻译中 0/' + targets.length + '…';
            var i = 0;
            var results = {};
            function next() {
                if (i >= targets.length) {
                    transMap['__' + key] = results;
                    translating = false;
                    transBtn.disabled = false;
                    transState.textContent = '已翻译 ' + targets.length + ' 条';
                    curEpKey = key;
                    render();
                    return;
                }
                var line = targets[i];
                i++;
                transState.textContent = '翻译中 ' + i + '/' + targets.length + '…';
                translateLine(extractEnglish(line), function (err, zh) {
                    results[line] = (err || !zh) ? '' : zh;
                    setTimeout(next, 200);
                });
            }
            next();
        }

        transBtn.addEventListener('click', doTranslate);
        mailBtn.addEventListener('click', function () {
            var U = window.__vhUtils || {};
            var cur = U.getTranslateEmail ? U.getTranslateEmail() : '';
            var ov = document.createElement('div');
            ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1002;display:flex;align-items:center;justify-content:center;';
            var b2 = document.createElement('div');
            b2.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:16px;max-width:420px;width:90%;';
            b2.innerHTML = '<div style="font-size:13px;font-weight:600;color:#eee;margin-bottom:6px;">翻译邮箱（MyMemory 提额）</div>' +
                '<div style="font-size:11px;color:#9a9a9a;line-height:1.6;margin-bottom:8px;">填一个邮箱后，翻译额度从每天约 5000 字提升到 50000 字（官方支持）。填一次全局生效。</div>';
            var inp = document.createElement('input');
            inp.type = 'email'; inp.value = cur; inp.placeholder = 'your@email.com';
            inp.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #444;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:13px;margin-bottom:10px;';
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
            var save = document.createElement('button'); save.textContent = '保存'; save.style.cssText = 'background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:5px 16px;cursor:pointer;font-size:12px;';
            var clearB = document.createElement('button'); clearB.textContent = '清除'; clearB.style.cssText = 'background:#3a3a3a;color:#aaa;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;';
            var cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.style.cssText = 'background:#3a3a3a;color:#aaa;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;';
            row.appendChild(clearB); row.appendChild(cancel); row.appendChild(save);
            b2.appendChild(inp); b2.appendChild(row); ov.appendChild(b2);
            document.body.appendChild(ov);
            function close2() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
            save.addEventListener('click', function () {
                var v = inp.value.trim();
                if (v && U.setTranslateEmail) U.setTranslateEmail(v);
                close2();
                window.__copyFlash && window.__copyFlash(v ? '已保存邮箱（提额生效）' : '已清除邮箱');
            });
            clearB.addEventListener('click', function () { if (U.setTranslateEmail) U.setTranslateEmail(''); inp.value = ''; });
            cancel.addEventListener('click', close2);
            inp.focus();
        });

        renderSidebar();
        render();
        // 关闭当前剧本：清空面板 → 显示剧本库首页（留在剧本组）；清除在读记录（下次进剧本组回首页）
        function closeReader() {
            document.removeEventListener('keydown', escHandler);
            clearReading();
            if (hostPanel) hostPanel.innerHTML = '';
            showScriptHome();
        }
        close.addEventListener('click', closeReader);
        function escHandler(e) {
            if (e.key === 'Escape') closeReader();
        }
        document.addEventListener('keydown', escHandler);
        // 打开下一个剧本前若面板被其它路径清空，监听会随 hostPanel.innerHTML='' 一起失效；此处仅保留引用避免 GC 误伤
    }

    // 转义（progress.js 里没有就用内置小函数）
    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
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

    // 暴露给 main.js：切到 progress tab 时自动刷新一次（刷新会自动实扫剪辑中项目）
    window.__progressOnShow = function () {
        refresh(true);
    };

    // 初始化：先探测在线状态
    refresh(true);
})();
