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
        mDone: document.getElementById('prgMDone'),
        mToday: document.getElementById('prgMToday'),
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
        el.mProducing.textContent = stats.producing != null ? stats.producing : '-';
        el.mDone.textContent = stats.this_month_done != null ? stats.this_month_done : '-';
        el.mToday.textContent = stats.this_month != null ? stats.this_month : '-';
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
    function openScriptForProject(projectName) {
        el.statusText.textContent = '找剧本：' + projectName + '…';
        var projDir = findLocalProjectDir(projectName);
        if (!projDir) {
            showScriptMsg('没在本地项目盘（' + SCRIPT_ROOT + '）找到「' + projectName + '」对应目录。\n\n可能还没建本地项目，或项目名对不上。');
            return;
        }
        var docxList = findScriptDocxList(projDir);
        if (docxList.length === 0) {
            showScriptMsg('找到了项目目录：' + projDir + '\n\n但里面没找到剧本 docx。请先把剧本拷贝进这个项目（放「剧本」文件夹或任意位置）。');
            return;
        }
        if (docxList.length === 1) {
            loadScriptDocx(docxList[0], projectName);
        } else {
            // 多个剧本 → 弹选择器
            showScriptPick(docxList, projectName);
        }
    }

    // 选剧本弹层（多个 docx 时）
    function showScriptPick(docxList, projectName) {
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:998;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:18px;max-width:520px;width:90%;box-sizing:border-box;';
        var title = document.createElement('div');
        title.style.cssText = 'font-size:13px;font-weight:600;color:#eee;margin-bottom:10px;';
        title.textContent = '选一个剧本打开（' + projectName + '）';
        box.appendChild(title);
        docxList.forEach(function (p) {
            var btn = document.createElement('button');
            btn.style.cssText = 'display:block;width:100%;text-align:left;background:#2a2a2a;color:#ddd;border:1px solid #3a3a3a;border-radius:6px;padding:8px 12px;margin-bottom:6px;cursor:pointer;font-size:12px;';
            btn.textContent = path.basename(p);
            btn.title = p;
            btn.addEventListener('click', function () {
                if (modal.parentNode) modal.parentNode.removeChild(modal);
                loadScriptDocx(p, projectName);
            });
            box.appendChild(btn);
        });
        var cancel = document.createElement('button');
        cancel.textContent = '取消';
        cancel.style.cssText = 'margin-top:8px;background:#3a3a3a;color:#aaa;border:none;border-radius:4px;padding:5px 14px;cursor:pointer;font-size:12px;';
        cancel.addEventListener('click', function () { if (modal.parentNode) modal.parentNode.removeChild(modal); });
        box.appendChild(cancel);
        modal.appendChild(box);
        document.body.appendChild(modal);
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

    // 简易消息弹层
    function showScriptMsg(text) {
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:998;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:18px;max-width:480px;font-size:12px;color:#ddd;line-height:1.7;white-space:pre-wrap;';
        box.textContent = text;
        var ok = document.createElement('button');
        ok.textContent = '知道了';
        ok.style.cssText = 'margin-top:12px;background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:5px 16px;cursor:pointer;display:block;margin-left:auto;';
        ok.addEventListener('click', function () { if (modal.parentNode) modal.parentNode.removeChild(modal); });
        box.appendChild(ok);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    // 剧本阅读浮层
    // 剧本阅读浮层（分类排版 + 翻译）
    function openScriptReader(data, docxPath, projectName) {
        var old = document.getElementById('scriptReaderModal');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var modal = document.createElement('div');
        modal.id = 'scriptReaderModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:999;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#181818;border:1px solid #3a3a3a;border-radius:8px;width:94%;max-width:860px;height:88%;display:flex;flex-direction:column;overflow:hidden;';
        // ---- 头部 ----
        var head = document.createElement('div');
        head.style.cssText = 'padding:8px 12px;border-bottom:1px solid #2e2e2e;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        var title = document.createElement('span');
        title.style.cssText = 'font-size:13px;font-weight:600;color:#e8e8e8;flex:1;min-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        title.textContent = '📖 ' + (projectName || '') + (docxPath ? ' · ' + path.basename(docxPath) : '');
        title.title = docxPath;
        head.appendChild(title);
        var eps = data.episodes || [];
        var epSel = document.createElement('select');
        epSel.style.cssText = 'background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;padding:3px 6px;font-size:12px;';
        epSel.innerHTML = '<option value="">全部</option>';
        eps.forEach(function (e) {
            var o = document.createElement('option');
            o.value = e;
            o.textContent = '第' + e + '集';
            epSel.appendChild(o);
        });
        head.appendChild(epSel);
        // 翻译按钮
        var transBtn = document.createElement('button');
        transBtn.textContent = '🌐 翻译台词';
        transBtn.style.cssText = 'background:#1e3a2a;color:#7fd68b;border:1px solid #2a5a3a;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;';
        head.appendChild(transBtn);
        var transState = document.createElement('span');
        transState.style.cssText = 'font-size:11px;color:#888;';
        head.appendChild(transState);
        var close = document.createElement('button');
        close.textContent = '✕ 关闭';
        close.style.cssText = 'background:#3a3a3a;color:#ccc;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;';
        close.addEventListener('click', function () { if (modal.parentNode) modal.parentNode.removeChild(modal); });
        head.appendChild(close);
        box.appendChild(head);
        // ---- 内容区 ----
        var body = document.createElement('div');
        body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 18px 30px;font-size:13.5px;line-height:1.8;color:#ddd;word-break:break-word;';
        box.appendChild(body);
        modal.appendChild(box);
        document.body.appendChild(modal);

        // ---- 翻译状态 ----
        var translating = false;      // 正在翻译
        var transMap = {};            // 台词原文 → 译文（按集缓存）
        var curEpKey = 'all';         // 当前翻译的集

        function epLines(ep) {
            return (data.lines || []).filter(function (x) {
                if (!ep) return true;
                return x.episode === ep;
            });
        }

        // 从台词行提取纯英文（去掉角色名/动作标注/中文部分）
        function extractEnglish(line) {
            var t = line || '';
            // 去掉 "角色名（动作）:" 前缀
            var m = t.match(/^[^:：]*[:：]\s*(.*)$/);
            if (m) t = m[1];
            // 去掉中文（保留英文 + 标点）
            t = t.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/g, ' ').replace(/\s+/g, ' ').trim();
            return t;
        }

        function isEnglish(s) {
            return /[A-Za-z]{3,}/.test(s);
        }

        // 翻译一段台词（MyMemory 单条接口，串行）
        function translateLine(text, cb) {
            var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en%7Czh-CN';
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

        // 翻译当前显示范围的台词（按集）
        function doTranslate() {
            if (translating) return;
            var fep = epSel.value ? parseInt(epSel.value, 10) : null;
            var key = fep ? String(fep) : 'all';
            // 已有该集翻译缓存 → 直接切显示
            if (transMap['__' + key]) {
                curEpKey = key;
                render();
                transState.textContent = '（已翻译）';
                return;
            }
            // 收集该范围英文台词
            var targets = [];
            epLines(fep).forEach(function (x) {
                if (x.type !== 'dialogue') return;
                var en = extractEnglish(x.text);
                if (en && isEnglish(en)) targets.push({ idx: targets.length, line: x.text, en: en });
            });
            if (targets.length === 0) {
                transState.textContent = '该范围没有可翻译的英文台词';
                return;
            }
            translating = true;
            transBtn.disabled = true;
            transState.textContent = '翻译中 0/' + targets.length + '…';
            var results = {};
            var i = 0;
            function next() {
                if (i >= targets.length) {
                    transMap['__' + key] = results;
                    translating = false;
                    transBtn.disabled = false;
                    curEpKey = key;
                    transState.textContent = '已翻译 ' + targets.length + ' 条';
                    render();
                    return;
                }
                var tg = targets[i];
                i++;
                transState.textContent = '翻译中 ' + i + '/' + targets.length + '…';
                translateLine(tg.en, function (err, zh) {
                    results[tg.line] = (err || !zh) ? '' : zh;
                    setTimeout(next, 250);
                });
            }
            next();
        }

        // 台词行渲染（高亮英文 + 可选中文译文）
        function renderDialogue(text, withTrans) {
            // 拆 角色名(含动作标注) : 台词
            var m = text.match(/^([^:：]{1,50}?)[：:]\s*(.*)$/);
            if (!m) return '<div class="scr-dlg">' + escHtml(text) + '</div>';
            var rolePart = m[1];
            var speech = m[2];
            // 判断台词主体语言
            var zhCount = (speech.match(/[\u4e00-\u9fff]/g) || []).length;
            var enCount = (speech.match(/[A-Za-z]/g) || []).length;
            var isZhMain = zhCount > enCount && zhCount > 2;

            // 角色名：名字部分橙金加粗，括号动作弱化灰
            var roleHtml = escHtml(rolePart);
            roleHtml = roleHtml.replace(/([（(][^）)]*[）)])/g, '<span style="color:#9a8a8a;font-weight:400;">$1</span>');

            var speechHtml;
            if (isZhMain) {
                speechHtml = escHtml(speech);
                speechHtml = speechHtml.replace(/([（(][^）)]*[）)])/g, '<span style="color:#9a8a8a;font-size:12px;">$1</span>');
            } else {
                speechHtml = escHtml(speech);
                speechHtml = speechHtml.replace(/([\u4e00-\u9fff]+)/g, '<span style="color:#9a9a9a;font-size:12px;">$1</span>');
            }
            var zhHtml = '';
            if (withTrans && transMap['__' + curEpKey] && transMap['__' + curEpKey][text]) {
                zhHtml = '<div class="scr-zh">' + escHtml(transMap['__' + curEpKey][text]) + '</div>';
            }
            // 复制按钮：放到台词末尾（cpBtn 在 speech 之后），行内小图标
            var spColor = isZhMain ? '#ff9090' : '#ff6b6b';
            return '<div class="scr-dlg"><span style="color:#ffb347;font-weight:700;">' + roleHtml + '</span><span style="color:#8a7a6a;"> : </span><span style="color:' + spColor + ';">' + speechHtml + '</span><span class="scr-copy" data-copy="' + escHtml(speech) + '" title="复制台词">⧉</span>' + zhHtml + '</div>';
        }

        // 主渲染
        function render() {
            var fep = epSel.value ? parseInt(epSel.value, 10) : null;
            var showTrans = curEpKey === (fep ? String(fep) : 'all');
            var html = '';
            var lines = data.lines || [];
            for (var li = 0; li < lines.length; li++) {
                var x = lines[li];
                if (fep && x.episode !== fep) continue;
                var t = x.text || '';
                var tp = x.type || 'plain';
                if (tp === 'ep_title') {
                    html += '<div style="margin:18px 0 8px;padding:6px 12px;background:#22303c;border-left:4px solid #537d96;border-radius:3px;font-weight:700;font-size:14px;color:#8fc0e8;">' + escHtml(t) + '</div>';
                } else if (tp === 'scene') {
                    html += '<div style="margin:12px 0 4px;padding:3px 10px;color:#7fb3d9;font-weight:600;font-size:12.5px;letter-spacing:.3px;">🎬 ' + escHtml(t) + '</div>';
                } else if (tp === 'cast') {
                    html += '<div style="color:#999;font-size:12px;padding:2px 10px;margin-bottom:6px;">' + escHtml(t) + '</div>';
                } else if (tp === 'action') {
                    html += '<div style="color:#9a9a9a;font-style:italic;font-size:12.5px;padding:1px 10px;border-left:2px solid #3a3a3a;margin:2px 0;">' + escHtml(t) + '</div>';
                } else if (tp === 'caption') {
                    html += '<div style="color:#c9a86a;font-size:12px;padding:1px 10px;">' + escHtml(t) + '</div>';
                } else if (tp === 'dialogue') {
                    html += renderDialogue(t, showTrans);
                } else {
                    html += '<div style="padding:1px 10px;">' + escHtml(t) + '</div>';
                }
            }
            body.innerHTML = html || '<div style="color:#888;padding:20px;text-align:center;">该集暂无内容</div>';
            body.scrollTop = 0;
        }
        // 注入台词样式（红色调 + 复制按钮）
        var st = document.createElement('style');
        st.textContent = '.scr-dlg{margin:4px 0;padding:2px 6px;position:relative;} .scr-dlg:hover{background:#242020;} .scr-dlg .scr-copy{visibility:hidden;display:inline;color:#888;cursor:pointer;font-size:11px;padding:0 4px;margin-left:6px;border-radius:3px;vertical-align:middle;} .scr-dlg:hover .scr-copy{visibility:visible;} .scr-dlg .scr-copy:hover{color:#ffb347;background:#2a2a2a;} .scr-zh{margin-top:2px;padding-left:8px;border-left:2px solid #4a6b4a;color:#9fe0a8;font-size:12.5px;}';
        document.head.appendChild(st);
        // 复制按钮：body 事件委托（从 data-copy 取值）
        if (!window.__copyDelegateBound) {
            window.__copyDelegateBound = true;
            document.body.addEventListener('click', function (e) {
                var t = e.target;
                var el2 = t.closest ? t.closest('.scr-copy') : null;
                if (el2 && el2.getAttribute('data-copy')) {
                    window.__copyText(el2.getAttribute('data-copy'));
                }
            });
        }
        // 提示气泡（全局，供 __copyText 内部调用）
        window.__copyFlash = function (msg) {
            var tip = document.createElement('span');
            tip.textContent = msg || '✓ 已复制';
            var okStyle = (msg || '').indexOf('失败') >= 0;
            tip.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);background:' + (okStyle ? '#3a2a2a' : '#2a3a2a') + ';color:' + (okStyle ? '#ff9090' : '#7fd68b') + ';padding:6px 14px;border-radius:6px;font-size:12px;z-index:1001;pointer-events:none;';
            document.body.appendChild(tip);
            setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 1400);
        };

        epSel.addEventListener('change', render);
        transBtn.addEventListener('click', doTranslate);
        render();
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && modal.parentNode) modal.parentNode.removeChild(modal);
        }, { once: true });
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
