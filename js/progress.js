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

    // DOM
    var el = {
        dot: document.getElementById('prgDot'),
        statusText: document.getElementById('prgStatusText'),
        refresh: document.getElementById('prgRefresh'),
        overview: document.getElementById('prgOverview'),
        mProducing: document.getElementById('prgMProducing'),
        mDone: document.getElementById('prgMDone'),
        mToday: document.getElementById('prgMToday'),
        offline: document.getElementById('prgOffline'),
        launch: document.getElementById('prgLaunch'),
        retry: document.getElementById('prgRetry'),
        activeWrap: document.getElementById('prgActiveWrap'),
        activeCount: document.getElementById('prgActiveCount'),
        activeList: document.getElementById('prgActiveList')
    };

    var busy = false;
    var lastData = null;

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
        el.mProducing.textContent = stats.producing != null ? stats.producing : '-';
        el.mDone.textContent = stats.this_month_done != null ? stats.this_month_done : '-';
        el.mToday.textContent = stats.this_month != null ? stats.this_month : '-';
    }

    // 渲染组内进行中项目
    function renderActive(sections) {
        var sec = null;
        (sections || []).forEach(function (s) { if (s && s.key === 'group_active') sec = s; });
        var projects = sec ? (sec.projects || []) : [];
        el.activeWrap.style.display = projects.length ? '' : 'none';
        el.activeCount.textContent = projects.length ? '共 ' + projects.length + ' 个' : '';
        el.activeList.innerHTML = '';
        if (projects.length === 0) {
            el.activeList.innerHTML = '<div class="prg-empty">组内没有进行中的项目</div>';
            return;
        }
        projects.forEach(function (p) {
            var cur = parseInt(p.current_episodes, 10) || 0;
            var total = parseInt(p.total_episodes, 10) || 0;
            var pct = total > 0 ? Math.min(100, Math.round(cur / total * 100)) : 0;
            var state = p.custom_status || '';

            var item = document.createElement('div');
            item.className = 'prg-item';
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
            fill.className = 'prg-bar-fill';
            fill.style.width = pct + '%';
            bar.appendChild(fill);
            item.appendChild(bar);

            var foot = document.createElement('div');
            foot.className = 'prg-item-foot';
            var ep = document.createElement('span');
            ep.textContent = total > 0 ? (cur + ' / ' + total + ' 集 · ' + pct + '%') : '未设总集数';
            var meta = document.createElement('span');
            meta.className = 'prg-item-sub';
            meta.textContent = (p.source_department || p.department || '') + (p.project_month ? ' · ' + p.project_month : '');
            foot.appendChild(ep);
            foot.appendChild(meta);
            item.appendChild(foot);

            el.activeList.appendChild(item);
        });
    }

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
    el.refresh.addEventListener('click', function () { refresh(true); });
    el.launch.addEventListener('click', launchWB);
    el.retry.addEventListener('click', function () { refresh(true); });

    // 暴露给 main.js：切到 progress tab 时自动刷新一次
    window.__progressOnShow = function () {
        refresh(true);
    };

    // 初始化：先探测在线状态
    refresh(true);
})();
