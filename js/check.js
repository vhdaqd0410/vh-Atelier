// vh-Atelier 第 5 板块：字幕校对（对剧本核对字幕，全局词级对齐）
// 流程：选 SRT → 选剧本 docx → 填集数 → 校对 → 差异清单打勾 → 应用修正 → 回写
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var child_process = require('child_process');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);

    // 状态
    var srtPath = null;       // 选中的 srt 文件（文件对话框或项目面板）
    var docxPath = null;      // 选中的剧本 docx
    var issues = [];          // 差异清单
    var checked = {};         // { idx: true } 打勾集合
    var resultJsonPath = null;

    // DOM
    var el = {
        btnPickSrt: document.getElementById('ckPickSrt'),
        srtPathLabel: document.getElementById('ckSrtPath'),
        btnPickSelected: document.getElementById('ckPickSelected'),
        btnPickDocx: document.getElementById('ckPickDocx'),
        docxPathLabel: document.getElementById('ckDocxPath'),
        inpEpisode: document.getElementById('ckEpisode'),
        btnCheck: document.getElementById('ckRun'),
        btnApply: document.getElementById('ckApply'),
        btnSelectAll: document.getElementById('ckSelectAll'),
        status: document.getElementById('ckStatus'),
        list: document.getElementById('ckList'),
        summary: document.getElementById('ckSummary'),
        applyRow: document.getElementById('ckApplyRow')
    };

    function setStatus(msg, type) {
        el.status.textContent = msg || '';
        el.status.className = type || '';
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function detectPython() {
        var candidates = [
            path.join(extRoot, 'runtime', 'python.exe'),
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
            'python',
            'py'
        ];
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (c === 'python' || c === 'py') {
                try {
                    var r = child_process.spawnSync('where', [c], { encoding: 'utf8' });
                    if (r.status === 0 && r.stdout) {
                        var lines = r.stdout.split(/\r?\n/).filter(function (l) { return l.trim(); });
                        for (var j = 0; j < lines.length; j++) {
                            var p = lines[j].trim();
                            if (p.indexOf('WindowsApps') < 0) return p;
                        }
                    }
                } catch (e) {}
            } else if (fs.existsSync(c)) {
                return c;
            }
        }
        return null;
    }

    function pickFile(kind) {
        var filter = kind === 'srt' ? ['*.srt'] : ['*.docx'];
        var title = kind === 'srt' ? '选择字幕 SRT' : '选择剧本 docx';
        var result;
        try {
            result = window.cep.fs.showOpenDialogEx(false, false, title, '', filter, '', '选择');
        } catch (e) {
            setStatus('打开对话框失败: ' + e.message, 'err');
            return Promise.resolve(null);
        }
        if (result && result.err === 0 && result.data && result.data.length > 0) {
            return Promise.resolve(result.data[0]);
        }
        return Promise.resolve(null);
    }

    // ---------- 读取项目面板当前选中的字幕（方案 B）----------
    function pickSelectedSrt() {
        setStatus('正在读取项目选中的素材...', '');
        csInterface.evalScript('ckGetSelectedSrt()', function (result) {
            try {
                var data = JSON.parse(result);
                if (data.error) { setStatus(data.error, 'err'); return; }
                if (!data.mediaPath) {
                    var msg = '选中素材「' + data.name + '」拿不到磁盘路径（type=' + data.type + '）。';
                    if (data.treePath) msg += ' treePath=' + data.treePath;
                    setStatus(msg, 'warn');
                    return;
                }
                srtPath = data.mediaPath;
                el.srtPathLabel.textContent = data.name;
                el.srtPathLabel.title = data.mediaPath;
                setStatus('已读取项目字幕：' + data.name, 'ok');
            } catch (e) {
                setStatus('读取选中素材失败: ' + result, 'err');
            }
        });
    }

    // ---------- 台词抽取/对齐（调用 Python 引擎）----------
    function runCheck() {
        if (!srtPath) { setStatus('请先选择字幕 SRT 文件', 'err'); return; }
        if (!docxPath) { setStatus('请先选择剧本 docx 文件', 'err'); return; }

        var py = detectPython();
        if (!py) { setStatus('未找到 Python，请安装或放到插件 runtime 目录', 'err'); return; }

        var scriptPath = path.join(extRoot, 'py', 'subtitle_check.py');
        if (!fs.existsSync(scriptPath)) { setStatus('找不到字幕校对引擎 py/subtitle_check.py', 'err'); return; }

        var episode = el.inpEpisode.value.trim() || '第一集';
        var outPath = path.join(os.tmpdir(), 'vh_check_' + Date.now() + '.json');

        setStatus('校对中（对齐剧本与字幕词流）...', '');
        el.btnCheck.disabled = true;

        var args = [scriptPath, '--docx', docxPath, '--srt', srtPath, '--episode', episode, '--out', outPath];
        try {
            var r = child_process.spawnSync(py, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        } catch (e) {
            el.btnCheck.disabled = false;
            setStatus('调用 Python 失败: ' + e.message, 'err');
            return;
        }
        el.btnCheck.disabled = false;

        var stdout = (r.stdout || '').trim();
        var stderr = (r.stderr || '').trim();
        var data = null;
        // 优先读输出文件（避免 stdout 编码问题），失败则解析 stdout
        try {
            if (fs.existsSync(outPath)) data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        } catch (e) {}
        if (!data) {
            try { data = JSON.parse(stdout); } catch (e) {
                setStatus('引擎输出解析失败' + (stderr ? '：' + stderr.slice(0, 200) : ''), 'err');
                return;
            }
        }

        if (!data.ok) {
            var extra = data.availableEpisodes ? '（可用集数：' + data.availableEpisodes.join('、') + '）' : '';
            setStatus(data.error + extra, 'err');
            return;
        }

        issues = data.issues || [];
        checked = {};
        // 默认全不勾（用户先看再打勾）
        resultJsonPath = outPath;
        renderIssues();
        el.applyRow.style.display = issues.length > 0 ? '' : 'none';

        var typeCount = { replace: 0, insert: 0, delete: 0 };
        issues.forEach(function (it) { typeCount[it.type] = (typeCount[it.type] || 0) + 1; });
        setStatus('第' + (data.episode || '?') + '集：台词 ' + data.dialogueCount + ' 句，字幕 ' + data.srtCount +
            ' 条，发现 ' + issues.length + ' 处差异（替换 ' + (typeCount.replace || 0) +
            ' / 漏词 ' + (typeCount.insert || 0) + ' / 多余 ' + (typeCount.delete || 0) + '）',
            issues.length > 0 ? 'warn' : 'ok');
    }

    // ---------- 渲染差异清单 ----------
    function typeLabel(t) {
        if (t === 'replace') return '听错';
        if (t === 'insert') return '漏词';
        if (t === 'delete') return '多余';
        return t;
    }

    function renderIssues() {
        el.list.innerHTML = '';
        if (issues.length === 0) {
            el.list.innerHTML = '<div class="hint" style="padding:10px;">没有发现差异，字幕与剧本一致 🎉</div>';
            return;
        }
        issues.forEach(function (it, i) {
            var row = document.createElement('div');
            row.className = 'ck-issue ck-' + it.type;
            row.dataset.idx = i;

            var chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.className = 'ck-chk';
            chk.checked = !!checked[i];
            chk.addEventListener('change', function () {
                checked[i] = chk.checked;
                updateApplyBtn();
            });

            var head = document.createElement('div');
            head.className = 'ck-issue-head';
            var tag = document.createElement('span');
            tag.className = 'ck-tag ck-tag-' + it.type;
            tag.textContent = typeLabel(it.type);
            var time = document.createElement('span');
            time.className = 'ck-time';
            time.textContent = (it.subStart || '') + ' → ' + (it.subEnd || '');
            head.appendChild(chk);
            head.appendChild(tag);
            head.appendChild(time);

            var detail = document.createElement('div');
            detail.className = 'ck-detail';
            detail.textContent = it.detail || '';

            var body = document.createElement('div');
            body.className = 'ck-issue-body';
            // 原文（当前字幕）
            var cur = document.createElement('div');
            cur.className = 'ck-cur';
            cur.innerHTML = '<span class="ck-lbl">当前</span>' + escapeHtml(it.subText || '');
            body.appendChild(cur);

            // 修正后（仅 replace / insert 有 fixedText）
            if (it.fixedText) {
                var fix = document.createElement('div');
                fix.className = 'ck-fix';
                fix.innerHTML = '<span class="ck-lbl">应为</span>' + escapeHtml(it.fixedText || '');
                body.appendChild(fix);
            } else if (it.type === 'delete') {
                var del = document.createElement('div');
                del.className = 'ck-fix ck-del';
                del.innerHTML = '<span class="ck-lbl">处理</span>删除以上多余字幕条目';
                body.appendChild(del);
            }

            row.appendChild(head);
            row.appendChild(detail);
            row.appendChild(body);
            el.list.appendChild(row);
        });
        updateApplyBtn();
    }

    function updateApplyBtn() {
        var n = 0;
        Object.keys(checked).forEach(function (k) { if (checked[k]) n++; });
        el.btnApply.textContent = '应用选中的修正（' + n + '）';
        el.btnApply.disabled = n === 0;
    }

    // ---------- 应用修正：修改内存字幕 + 生成新 SRT + 回写 ----------
    function applyChecked() {
        var picked = [];
        Object.keys(checked).forEach(function (k) {
            if (checked[k]) picked.push(parseInt(k, 10));
        });
        if (picked.length === 0) { setStatus('请先勾选要应用的差异', 'err'); return; }

        // 从识别板块拿当前序列的字幕（内存），若没有则从 srt 文件读
        var bridge = window.__subtitleBridge;
        var cur = bridge ? bridge.getCurrent() : null;
        var subs = null;
        if (cur && cur.subtitles && cur.subtitles.length > 0) {
            subs = cur.subtitles.map(function (s) { return { start: s.start, end: s.end, text: s.text }; });
        } else {
            // 从 srt 文件重新解析
            subs = parseSRT(fs.readFileSync(srtPath, 'utf8'));
        }
        if (!subs || subs.length === 0) { setStatus('没有可用的字幕数据', 'err'); return; }

        // 按类型应用
        var deletes = {};   // subIdx -> true 待删除
        var edits = {};     // subIdx -> fixedText 待改写
        var applied = 0;

        picked.forEach(function (idx) {
            var it = issues[idx];
            if (!it) return;
            if (it.type === 'delete') {
                (it.subIdxs || [it.subIdx]).forEach(function (si) { deletes[si] = true; });
            } else if (it.fixedText) {
                edits[it.subIdx] = it.fixedText;
            }
        });

        // 先应用改写，再删多余（保序）
        var newSubs = [];
        subs.forEach(function (s, i) {
            if (deletes[i]) return;       // 删除
            var copy = { start: s.start, end: s.end, text: s.text };
            if (edits[i] !== undefined) copy.text = edits[i];
            newSubs.push(copy);
        });
        applied = newSubs.length;

        // 写回内存 bridge（识别板块）
        if (bridge && bridge.applySubtitles) {
            bridge.applySubtitles(newSubs);
        }

        // 生成新 SRT 并回写激活序列（复用识别板块的 host 回写函数）
        var srtContent = toSRT(newSubs);
        var seqName = (cur && cur.seqName) ? cur.seqName : '';
        var payloadJson = JSON.stringify({ srt: srtContent, seqName: seqName });
        var setScript = 'wsWriteBackPayload = ' + payloadJson + ';';

        setStatus('正在回写字幕轨...', '');
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('wsWriteBackStr("")', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setStatus('已应用 ' + (subs.length - newSubs.length) + ' 处删除 + ' +
                            Object.keys(edits).length + ' 处改写，回写完成（' + data.fileName + '）', 'ok');
                    } else {
                        setStatus('修正已应用但回写失败: ' + (data.error || result), 'err');
                    }
                } catch (e) {
                    setStatus('回写解析失败: ' + result, 'err');
                }
            });
        });
    }

    // ---------- SRT 工具（秒，与识别板块一致）----------
    function parseSRT(content) {
        var subs = [];
        var lines = content.replace(/\r\n/g, '\n').split('\n');
        var i = 0;
        while (i < lines.length) {
            while (i < lines.length && lines[i].trim() === '') i++;
            if (i >= lines.length) break;
            if (/^\d+$/.test(lines[i].trim())) i++;
            if (i >= lines.length) break;
            var timeMatch = lines[i].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
            if (!timeMatch) { i++; continue; }
            var start = parseTime(timeMatch[1]);
            var end = parseTime(timeMatch[2]);
            i++;
            var text = [];
            while (i < lines.length && lines[i].trim() !== '') {
                text.push(lines[i].trim());
                i++;
            }
            subs.push({ start: start, end: end, text: text.join('\n') });
        }
        return subs;
    }

    function parseTime(t) {
        var m = t.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
        return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
    }

    function formatTime(sec) {
        var ms = Math.round(sec * 1000);
        var h = Math.floor(ms / 3600000);
        var m = Math.floor((ms % 3600000) / 60000);
        var s = Math.floor((ms % 60000) / 1000);
        var millis = ms % 1000;
        function pad(n, w) { n = '' + n; while (n.length < w) n = '0' + n; return n; }
        return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(millis, 3);
    }

    function toSRT(subs) {
        var out = '';
        subs.forEach(function (s, i) {
            out += (i + 1) + '\n';
            out += formatTime(s.start) + ' --> ' + formatTime(s.end) + '\n';
            out += s.text + '\n\n';
        });
        return out;
    }

    // ---------- 事件 ----------
    el.btnPickSelected.addEventListener('click', pickSelectedSrt);

    el.btnPickSrt.addEventListener('click', function () {
        pickFile('srt').then(function (p) {
            if (p) {
                srtPath = p;
                el.srtPathLabel.textContent = p;
                el.srtPathLabel.title = p;
            }
        });
    });

    el.btnPickDocx.addEventListener('click', function () {
        pickFile('docx').then(function (p) {
            if (p) {
                docxPath = p;
                el.docxPathLabel.textContent = p;
                el.docxPathLabel.title = p;
            }
        });
    });

    el.btnCheck.addEventListener('click', runCheck);
    el.btnApply.addEventListener('click', applyChecked);

    el.btnSelectAll.addEventListener('click', function () {
        var all = issues.length > 0 && Object.keys(checked).length !== issues.length;
        checked = {};
        if (all) issues.forEach(function (_, i) { checked[i] = true; });
        renderIssues();
        el.btnSelectAll.textContent = all ? '取消全选' : '全选';
    });

    // 初始化
    setStatus('就绪。选 SRT + 剧本 docx + 集数，点「开始校对」', '');
    el.applyRow.style.display = 'none';
})();
