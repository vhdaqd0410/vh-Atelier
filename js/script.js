/**
 * vh-Atelier · 剧本模块
 * 由 progress.js 拆分而来：剧本阅读 / 书签 / 剧本库首页 / 阅读器
 *
 * 对外接口：window.__vhScript
 * 外部依赖：window.__vhProgress.setStatus(text)  写状态栏文字
 */
(function () {
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var child_process = require('child_process');

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

    // 写状态栏（由 progress.js 暴露）
    function setStatus(msg) {
        try {
            var p = window.__vhProgress;
            if (p && p.setStatus) p.setStatus(msg);
        } catch (e) {}
    }

    // 转义（progress.js 里没有就用内置小函数）
    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
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
        setStatus('解析剧本：' + path.basename(docx) + '…');
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
        searchState.style.cssText = 'font-size:11px;color:#c9a86a;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        head.appendChild(searchState);
        // 命中定位：上一条 / 下一条 / 只看命中
        var hitPrev = document.createElement('button');
        hitPrev.textContent = '↑';
        hitPrev.title = '上一个命中';
        hitPrev.style.cssText = 'background:#2a2a2a;color:#c9a86a;border:1px solid #4a4a2a;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px;display:none;';
        head.appendChild(hitPrev);
        var hitNext = document.createElement('button');
        hitNext.textContent = '↓';
        hitNext.title = '下一个命中';
        hitNext.style.cssText = hitPrev.style.cssText;
        head.appendChild(hitNext);
        var onlyHitBtn = document.createElement('button');
        onlyHitBtn.textContent = '只看命中';
        onlyHitBtn.title = '切换：只列出命中行 / 保留原文并定位';
        onlyHitBtn.style.cssText = 'background:#2a2a2a;color:#888;border:1px solid #444;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px;display:none;';
        head.appendChild(onlyHitBtn);
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
        var searchHits = [];         // 当前命中的 <mark> 元素列表
        var hitIdx = -1;             // 当前定位到第几个命中（0 基）
        var onlyHits = false;        // false=保留全文并定位到第一个命中；true=只列出命中行
        var pendingScrollEp = null;  // 渲染后需要滚动到的集（选集/跳集时置位）
        var viewEp = null;           // 当前视口顶部所在的集（随右栏滚动变化，驱动左栏高亮）
        var epMarks = [];            // [[集号, 标题元素], ...] 渲染后缓存，供滚动同步快速取用
        var epMarksDirty = true;

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

        // ---------- 左栏集数列表（全量渲染下：点击 = 滚动定位 + 高亮）----------
        // 左栏项按集号存起来，右栏滚动时只切样式不重建 DOM（避免闪烁与开销）
        var sidebarMap = {};   // 'all' 或 String(ep) -> element
        var SIDE_NORMAL = 'padding:5px 12px;font-size:12px;color:#aaa;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:2px solid transparent;';
        var SIDE_ACTIVE = 'padding:5px 12px;font-size:12px;color:#8fc0e8;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:2px solid #537d96;background:#22303c;';

        // 高亮指定集（并保证它在左栏可视区内）
        function updateSidebarActive(ep) {
            var key = (ep != null ? String(ep) : 'all');
            Object.keys(sidebarMap).forEach(function (k) {
                var el2 = sidebarMap[k];
                if (!el2 || !el2.parentNode) return;
                el2.style.cssText = (k === key) ? SIDE_ACTIVE : SIDE_NORMAL;
            });
            var cur = sidebarMap[key];
            if (!cur) return;
            // 左栏自身滚动，让高亮项居中可见
            try {
                var top = cur.offsetTop;
                var h = cur.offsetHeight || 24;
                var viewTop = sidebar.scrollTop;
                var viewBottom = viewTop + sidebar.clientHeight;
                if (top < viewTop + 4 || top + h > viewBottom - 4) {
                    sidebar.scrollTop = Math.max(0, top - sidebar.clientHeight / 2 + h / 2);
                }
            } catch (e) {}
        }

        function renderSidebar() {
            sidebar.innerHTML = '';
            sidebarMap = {};
            function addItem(label, ep) {
                var it = document.createElement('div');
                var isActive = (viewEp != null) ? (ep === viewEp) : (curEp === ep);
                it.style.cssText = isActive ? SIDE_ACTIVE : SIDE_NORMAL;
                it.textContent = label;
                sidebarMap[ep != null ? String(ep) : 'all'] = it;
                it.addEventListener('click', function () {
                    curEp = ep;
                    curEpKey = curEp != null ? String(curEp) : 'all';
                    viewEp = ep;
                    searchKeyword = '';
                    searchInp.value = '';
                    searchState.textContent = '';
                    searchHits = []; hitIdx = -1;
                    pendingScrollEp = ep;   // 全量渲染后滚到该集
                    saveReading(docxPath, curEp);   // 记住读到第几集
                    renderSidebar();
                    render();
                });
                sidebar.appendChild(it);
            }
            addItem('📄 全部', null);
            eps.forEach(function (e) { addItem('第 ' + e + ' 集', e); });
            // 渲染完把高亮项滚到左栏可视区（点开续读时直接定位）
            var key = (viewEp != null) ? String(viewEp) : ((curEp != null) ? String(curEp) : 'all');
            var act = sidebarMap[key];
            if (act) {
                try {
                    var top = act.offsetTop, h = act.offsetHeight || 24;
                    if (top < sidebar.scrollTop || top + h > sidebar.scrollTop + sidebar.clientHeight) {
                        sidebar.scrollTop = Math.max(0, top - sidebar.clientHeight / 2 + h / 2);
                    }
                } catch (e2) {}
            }
        }

        // ---------- 台词渲染 ----------
        function renderDialogue(text, ep) {
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
                // 批量翻译缓存（整集翻译按钮）：按该行自己的集号取，全量渲染下也能命中
                var bk = (ep != null ? String(ep) : curEpKey);
                if (bk && transMap['__' + bk] && transMap['__' + bk][text]) {
                    zhHtml = '<div class="scr-zh">' + escHtml(transMap['__' + bk][text]) + '</div>';
                }
            }
            var en = extractEnglish(text);
            return '<div class="scr-dlg"><span style="color:#ffb347;font-weight:700;">' + roleHtml + '</span><span style="color:#8a7a6a;"> : </span><span style="color:' + spColor + ';">' + speechHtml + '</span><span class="scr-copy" data-copy="' + escHtml(speech) + '" title="复制台词">⧉</span><span class="scr-trn" data-line="' + escHtml(text) + '" data-en="' + escHtml(en) + '" title="翻译本句">译</span>' + zhHtml + '</div>';
        }
        // 在已转义 HTML 上做关键词高亮（简单：大小写不敏感子串包 <mark>）—— 因 HTML 已含标签，仅在纯文本段操作有风险；改为渲染前对原文高亮。
        function hlText(escapedHtml, kw) { return escapedHtml; } // 占位，实际用 render 层高亮

        // 渲染右栏（全量渲染所有集：选集只做滚动定位，上下滚可连续阅读相邻集）
        function render() {
            var lines = data.lines || [];
            var html = '';
            epMarks = [];   // [集号, 元素] 缓存，避免滚动时反复查询 DOM
            for (var li = 0; li < lines.length; li++) {
                var x = lines[li];
                var t = x.text || '';
                var tp = x.type || 'plain';
                // 关键词：默认保留全文（看得到上下文），切到「只看命中」时才过滤
                if (searchKeyword && onlyHits) {
                    if (t.toLowerCase().indexOf(searchKeyword) < 0) continue;
                }
                var disp = escHtml(t);
                if (searchKeyword) {
                    disp = hlOnPlain(t);
                }
                if (tp === 'ep_title') {
                    html += '<div class="scr-ept" data-ep="' + (x.episode != null ? x.episode : '') + '" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                    epMarks.push(x.episode);
                } else if (tp === 'scene') {
                    html += '<div class="scr-scene" data-raw="' + escHtml(t) + '">🎬 ' + disp + '</div>';
                } else if (tp === 'cast') {
                    html += '<div class="scr-cast" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'action') {
                    html += '<div class="scr-action" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'caption') {
                    html += '<div class="scr-caption" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'dialogue') {
                    html += renderDialogue(t, x.episode);
                } else {
                    html += '<div class="scr-plain" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                }
            }
            var emptyHtml = '<div style="color:#888;padding:30px;text-align:center;">' +
                (searchKeyword ? (onlyHits ? '没有匹配「' + escHtml(searchKeyword) + '」的内容' : '剧本暂无内容')
                               : '剧本暂无内容') + '</div>';
            body.innerHTML = html || emptyHtml;
            epMarksDirty = true;
            applyHighlight();
            refreshHitUI();
            // 选集模式：渲染后滚动到目标集（仅当没有在定位搜索命中时）
            if (pendingScrollEp != null && !searchKeyword) {
                scrollToEp(pendingScrollEp);
                if (viewEp !== pendingScrollEp) { viewEp = pendingScrollEp; updateSidebarActive(viewEp); }
                pendingScrollEp = null;
            } else {
                // 普通重渲染：按当前滚动位置回填左栏高亮
                onBodyScroll();
            }
        }

        // 滚动到指定集的标题行（顶部对齐）
        function scrollToEp(ep) {
            if (ep == null) return;
            var node = body.querySelector('.scr-ept[data-ep="' + ep + '"]');
            if (!node) return;
            try {
                var bodyRect = body.getBoundingClientRect();
                var elRect = node.getBoundingClientRect();
                body.scrollTop += (elRect.top - bodyRect.top) - 6;
            } catch (e) {}
        }

        // 集标题缓存：每次 render 后标记失效，首次滚动时惰性重建
        function buildEpMarks() {
            if (!epMarksDirty) return;
            epMarks = [];
            var nodes = body.querySelectorAll('.scr-ept[data-ep]');
            for (var i = 0; i < nodes.length; i++) {
                var v = nodes[i].getAttribute('data-ep');
                if (v === '' || v == null) continue;
                epMarks.push([v, nodes[i]]);
            }
            epMarksDirty = false;
        }

        // 右栏滚动 → 算出当前视口顶部对应的集，同步左栏高亮 + 左栏自动滚动
        var syncRaf = null;
        function readVisibleEp() {
            buildEpMarks();
            if (!epMarks.length) return null;
            var bodyTop = body.getBoundingClientRect().top;
            var cur = null;
            for (var i = 0; i < epMarks.length; i++) {
                // 标题顶端已到达（或越过）视口顶部的，就是当前集；取最后一个
                if (epMarks[i][1].getBoundingClientRect().top - bodyTop <= 8) cur = epMarks[i][0];
                else break;
            }
            if (cur == null) cur = epMarks[0][0];   // 还没到任何集标题，算作第一集
            return cur != null ? parseInt(cur, 10) : null;
        }
        function onBodyScroll() {
            if (syncRaf) return;
            syncRaf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
                syncRaf = null;
                var ep = readVisibleEp();
                if (ep != null && ep !== viewEp) {
                    viewEp = ep;
                    curEp = ep;                       // 滚动也算「读到这一集」，翻译/记录对齐当前视口
                    curEpKey = String(ep);
                    updateSidebarActive(ep);
                    saveReading(docxPath, ep);        // 读到哪记到哪
                }
            });
        }
        body.addEventListener('scroll', onBodyScroll);

        // 收集所有命中标记（渲染后调用，dialogue 行的高亮由 applyHighlight 补，故必须在其后）
        function collectHits() {
            searchHits = [];
            if (!searchKeyword) return;
            var all = body.querySelectorAll('mark.scr-hl');
            for (var i = 0; i < all.length; i++) searchHits.push(all[i]);
        }

        // 跳到第 idx 个命中：高亮当前项并滚动到可视区中部
        function gotoHit(idx) {
            if (searchHits.length === 0) { hitIdx = -1; updateHitUI(); return; }
            if (idx < 0) idx = searchHits.length - 1;
            if (idx >= searchHits.length) idx = 0;
            for (var i = 0; i < searchHits.length; i++) searchHits[i].classList.remove('scr-hl-cur');
            hitIdx = idx;
            var el = searchHits[idx];
            el.classList.add('scr-hl-cur');
            try {
                var bodyRect = body.getBoundingClientRect();
                var elRect = el.getBoundingClientRect();
                body.scrollTop += (elRect.top - bodyRect.top) - body.clientHeight / 3;
            } catch (e) {}
            updateHitUI();
        }

        // 刷新命中计数与按钮显隐
        function updateHitUI() {
            var has = !!searchKeyword;
            hitPrev.style.display = has ? '' : 'none';
            hitNext.style.display = has ? '' : 'none';
            onlyHitBtn.style.display = has ? '' : 'none';
            if (!has) { searchState.textContent = ''; return; }
            if (searchHits.length === 0) { searchState.textContent = '无命中'; return; }
            searchState.textContent = '第 ' + (hitIdx + 1) + '/' + searchHits.length + ' 处';
        }

        // 重新收集 + 定位到第一个
        function refreshHitUI() {
            if (!searchKeyword) { searchHits = []; hitIdx = -1; updateHitUI(); return; }
            collectHits();
            if (searchHits.length > 0) gotoHit(0);
            else updateHitUI();
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
        st.textContent = '.scr-dlg{margin:3px 0;padding:2px 4px;position:relative;} .scr-dlg:hover{background:#242020;} .scr-dlg .scr-copy,.scr-dlg .scr-trn{visibility:hidden;display:inline;color:#888;cursor:pointer;font-size:11px;padding:0 4px;margin-left:4px;border-radius:3px;vertical-align:middle;} .scr-dlg:hover .scr-copy,.scr-dlg:hover .scr-trn{visibility:visible;} .scr-dlg .scr-copy:hover{color:#ffb347;background:#2a2a2a;} .scr-dlg .scr-trn:hover{color:#7fd68b;background:#1e2a1e;} .scr-zh{margin-top:2px;padding-left:8px;border-left:2px solid #4a6b4a;color:#9fe0a8;font-size:12.5px;} .scr-ept{margin:16px 0 8px;padding:5px 12px;background:#22303c;border-left:4px solid #537d96;border-radius:3px;font-weight:700;font-size:14px;color:#8fc0e8;} .scr-scene{margin:10px 0 3px;padding:2px 8px;color:#7fb3d9;font-weight:600;font-size:12.5px;} .scr-cast{color:#999;font-size:12px;padding:1px 8px;} .scr-action{color:#9a9a9a;font-style:italic;font-size:12.5px;padding:1px 8px;border-left:2px solid #3a3a3a;margin:2px 0;} .scr-caption{color:#c9a86a;font-size:12px;padding:1px 8px;} .scr-plain{padding:1px 8px;} mark.scr-hl{background:#5a4a1e;color:#ffd76a;padding:0 1px;border-radius:2px;} mark.scr-hl-cur{background:#ffb347;color:#1a1a1a;outline:1px solid #ffd76a;}';
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

        // 命中导航：上一条 / 下一条 / 只看命中
        hitPrev.addEventListener('click', function () { gotoHit(hitIdx - 1); });
        hitNext.addEventListener('click', function () { gotoHit(hitIdx + 1); });
        onlyHitBtn.addEventListener('click', function () {
            onlyHits = !onlyHits;
            onlyHitBtn.textContent = onlyHits ? '保留原文' : '只看命中';
            onlyHitBtn.style.color = onlyHits ? '#c9a86a' : '#888';
            onlyHitBtn.style.borderColor = onlyHits ? '#4a4a2a' : '#444';
            render();
        });

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
                    pendingScrollEp = n;
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

        pendingScrollEp = curEp;   // 打开时定位到上次读到的集（全量渲染，可上下滚看相邻集）
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

    // 轻提示 toast（模块级：原来定义在 openScriptReader 内部，导致 media.js / music.js
    // 在未打开过剧本阅读器时取不到它，提示会静默失效）
    window.__copyFlash = function (msg) {
        var tip = document.createElement('span');
        tip.textContent = msg || '✓ 已复制';
        var okStyle = (msg || '').indexOf('失败') >= 0;
        tip.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);background:' + (okStyle ? '#3a2a2a' : '#2a3a2a') + ';color:' + (okStyle ? '#ff9090' : '#7fd68b') + ';padding:6px 14px;border-radius:6px;font-size:12px;z-index:1001;pointer-events:none;';
        document.body.appendChild(tip);
        setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 1400);
    };

    // 供素材面板等打开任意剧本文件（内部走剧本阅读器）
    window.__openDocxByPath = function (docxPath) {
        try {
            if (!docxPath || !fs.existsSync(docxPath)) return false;
            loadScriptDocx(docxPath, '');
            return true;
        } catch (e) { return false; }
    };

    // 对外接口
    window.__vhScript = {
        openScriptForProject: openScriptForProject,
        loadScriptDocx: loadScriptDocx,
        showScriptHome: showScriptHome,
        showScriptPanel: showScriptPanel
    };
})();
