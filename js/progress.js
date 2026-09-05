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
                if (cur <= 0) return false;
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

            // 操作行：剧本（最左）+ 打开工作台
            var openRow = document.createElement('div');
            openRow.className = 'prg-open-row';
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
            item.appendChild(openRow);

            el.activeList.appendChild(item);
        });
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

    // 在项目目录递归找剧本 docx（优先「剧本/脚本」文件夹，再全目录递归）
    // 在项目目录递归找所有剧本 docx（过滤 ~$ 临时文件；优先「剧本/脚本」目录）
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
                    } else if (en.toLowerCase().endsWith('.docx')) {
                        found.push(full);
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
            result = window.cep.fs.showOpenDialogEx(false, false, '选择剧本 docx', '', [], '', '选择');
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

    // 解析指定 docx 并打开阅读浮层
    function loadScriptDocx(docx, projectName) {
        el.statusText.textContent = '解析剧本：' + path.basename(docx) + '…';
        var py = findPython();
        var scriptPath = path.join(extRoot, 'py', 'docx_read.py');
        if (!fs.existsSync(scriptPath)) {
            showScriptMsg('找不到 py/docx_read.py');
            return;
        }
        try {
            var r = child_process.spawnSync(py, [scriptPath, '--docx', docx], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
            var data = null;
            var out = (r.stdout || '').trim();
            try { data = JSON.parse(out); } catch (e) {
                try { data = JSON.parse((r.stderr || '').trim()); } catch (e2) {}
            }
            if (!data || !data.ok) {
                showScriptMsg('解析剧本失败：' + ((data && data.error) || (r.stderr || '').slice(0, 300) || '未知错误') + '\n\n文件：' + docx);
                return;
            }
            openScriptReader(data, docx, projectName);
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
            tip.innerHTML = '还没有剧本记录。<br>点上方「📂 打开剧本文件…」选一个 docx 开始，<br>或从视频工作台项目卡片里点「剧本」打开。<br><br>打开过的会自动出现在「最近阅读」，方便下次直接点。';
            box.appendChild(tip);
        }

        hostPanel.appendChild(box);
    }

    // 暴露给 main.js：切到剧本组且面板为空时，渲染首页
    window.__atShowScriptHome = function () {
        var hostPanel = document.getElementById('panel-script');
        if (!hostPanel) return;
        var hasReader = hostPanel.querySelector('#scriptReaderBox');
        var hasHome = hostPanel.querySelector('#scriptHomeBox');
        if (!hasReader && !hasHome) {
            showScriptHome();
        } else if (hasHome && !hasReader) {
            // 已显示首页则刷新最近/固定
            showScriptHome();
        }
    };

    // 剧本阅读浮层：左集数列表 + 右内容 + 搜索（集号跳转/关键词高亮）+ 翻译/复制
    function openScriptReader(data, docxPath, projectName) {
        // 剧本阅读作为独立面板（panel-script + 顶部「剧本」组），不遮挡其它板块
        var hostPanel = document.getElementById('panel-script');
        if (!hostPanel) return;
        // 记录最近阅读（跨项目，供剧本库首页）
        if (docxPath) pushRecentScript(docxPath, projectName);
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
        var curEp = null;            // 当前选中集（null=全部）
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
                    curEpKey = curEp ? String(curEp) : 'all';
                    searchKeyword = '';
                    searchInp.value = '';
                    searchState.textContent = '';
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
        // 翻译后把当前范围的批量译文渲染到行下
        var curEpKey = 'all';

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
        // 关闭当前剧本：清空面板 → 显示剧本库首页（留在剧本组，方便换下一个）
        function closeReader() {
            document.removeEventListener('keydown', escHandler);
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
    // 筛选：状态 / 只看有进度 → 重渲染当前列表
    el.filterState.addEventListener('change', function () { renderFilteredList(); });
    el.filterProgress.addEventListener('change', function () { renderFilteredList(); });

    // 暴露给 main.js：切到 progress tab 时自动刷新一次
    window.__progressOnShow = function () {
        refresh(true);
    };

    // 初始化：先探测在线状态
    refresh(true);
})();
