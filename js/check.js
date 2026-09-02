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
    var docxDir = null;       // 剧本目录（记忆用）
    var issues = [];          // 差异清单
    var checked = {};         // { idx: true } 打勾集合
    var resultJsonPath = null;
    var currentEpisode = '';  // 当前集数（推断或手填，供修正导出命名）
    var fixedSubs = null;     // 最近一次应用/导出用的修正后字幕（导出修正 SRT 用）

    // DOM
    var el = {
        btnPickSrt: document.getElementById('ckPickSrt'),
        srtPathLabel: document.getElementById('ckSrtPath'),
        srtBadge: document.getElementById('ckSrtBadge'),
        btnPickSelected: document.getElementById('ckPickSelected'),
        btnPickDocx: document.getElementById('ckPickDocx'),
        docxPathLabel: document.getElementById('ckDocxPath'),
        docxBadge: document.getElementById('ckDocxBadge'),
        docxList: document.getElementById('ckDocxList'),
        inpEpisode: document.getElementById('ckEpisode'),
        btnCheck: document.getElementById('ckRun'),
        btnApply: document.getElementById('ckApply'),
        btnSelectAll: document.getElementById('ckSelectAll'),
        btnDictOnly: document.getElementById('ckDictOnly'),
        btnExportFixed: document.getElementById('ckExportFixed'),
        status: document.getElementById('ckStatus'),
        list: document.getElementById('ckList'),
        summary: document.getElementById('ckSummary'),
        applyRow: document.getElementById('ckApplyRow'),
        dictFrom: document.getElementById('ckDictFrom'),
        dictTo: document.getElementById('ckDictTo'),
        dictAdd: document.getElementById('ckDictAdd'),
        dictList: document.getElementById('ckDictList'),
        dictOpen: document.getElementById('ckDictOpen'),
        dictReload: document.getElementById('ckDictReload'),
        dictPath: document.getElementById('ckDictPath'),
        dictToggle: document.getElementById('ckDictToggle'),
        dictCount: document.getElementById('ckDictCount'),
        dictSearch: document.getElementById('ckDictSearch'),
        dictAddRow: document.getElementById('ckDictAddRow')
    };

    // 字典列表折叠态 + 搜索关键词
    var dictCollapsed = false;
    var dictSearchKey = '';

    // ---------- 记忆（剧本目录/docx/集数，跨会话记住，减少重复选择）----------
    var CK_MEM_KEY = 'vh_check_memory_v1';
    function loadMemory() {
        try {
            var raw = localStorage.getItem(CK_MEM_KEY);
            if (raw) {
                var m = JSON.parse(raw) || {};
                docxDir = m.docxDir || null;
                if (m.docxName) {
                    docxPath = m.docxPath || null;
                    el.docxPathLabel.textContent = m.docxName;
                    el.docxPathLabel.title = docxPath || '';
                }
                if (m.episode) el.inpEpisode.value = m.episode;
            }
        } catch (e) {}
    }
    function saveMemory() {
        try {
            localStorage.setItem(CK_MEM_KEY, JSON.stringify({
                docxDir: docxDir || null,
                docxName: docxPath ? path.basename(docxPath) : null,
                docxPath: docxPath || null,
                episode: el.inpEpisode.value || ''
            }));
        } catch (e) {}
    }

    // ---------- 集数推断：从序列名里提取「第X集」等，识别完直接校对时自动填入 ----------
    function inferEpisodeFromName(name) {
        if (!name) return '';
        var s = String(name).trim();
        var m = s.match(/第\s*[一二两三四五六七八九十百零0-9]+\s*集/);
        if (m) return m[0];
        var m2 = s.match(/ep(?:isode)?\.?\s*(\d+)/i);
        if (m2) return '第' + parseInt(m2[1], 10) + '集';
        if (/^\d{1,3}$/.test(s)) return '第' + parseInt(s, 10) + '集';
        return '';
    }

    // 替换字典状态 + 持久化（全局：所有项目共用一份，存磁盘 JSON 文件）
    var dict = [];   // [{ from, to }]
    var dictFile = path.join(extRoot, 'collect', 'replace_dict.json');

    function loadDict() {
        // 兼容旧 localStorage 数据（迁移）
        var legacyRaw = null;
        try { legacyRaw = localStorage.getItem('vh_check_dict_v1'); } catch (e) {}
        try {
            if (fs.existsSync(dictFile)) {
                dict = JSON.parse(fs.readFileSync(dictFile, 'utf8')) || [];
            } else if (legacyRaw) {
                dict = JSON.parse(legacyRaw) || [];
                try { localStorage.removeItem('vh_check_dict_v1'); } catch (e) {}
            } else {
                dict = [];
            }
        } catch (e) { dict = []; }
        if (!Array.isArray(dict)) dict = [];
        dict = dict.filter(function (d) { return d && d.from; });
    }
    function saveDict() {
        try {
            var dir = path.join(extRoot, 'collect');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(dictFile, JSON.stringify(dict, null, 2), 'utf8');
        } catch (e) {}
    }
    function renderDict() {
        el.dictList.innerHTML = '';
        if (el.dictPath) {
            el.dictPath.textContent = dictFile;
            el.dictPath.title = dictFile;
        }
        // 折叠态：隐藏列表
        el.dictList.style.display = dictCollapsed ? 'none' : '';
        if (el.dictToggle) el.dictToggle.textContent = dictCollapsed ? '展开列表' : '收起列表';
        if (el.dictAddRow) el.dictAddRow.style.display = dictCollapsed ? 'none' : '';

        // 计数
        if (el.dictCount) {
            el.dictCount.textContent = dict.length > 0 ? '共 ' + dict.length + ' 条' : '';
        }
        if (dictCollapsed) return;

        // 搜索过滤
        var key = dictSearchKey.toLowerCase();
        var filtered = dict;
        if (key) {
            filtered = dict.filter(function (d) {
                return d.from.toLowerCase().indexOf(key) >= 0 || d.to.toLowerCase().indexOf(key) >= 0;
            });
        }

        if (dict.length === 0) {
            el.dictList.innerHTML = '<div class="hint">暂无替换规则。添加后，应用修正时字幕里的「原词」会自动替换成「替换为」。</div>';
            return;
        }
        if (filtered.length === 0) {
            el.dictList.innerHTML = '<div class="hint">没有匹配「' + escapeHtml(dictSearchKey) + '」的规则。</div>';
            return;
        }

        filtered.forEach(function (d) {
            // 找到该条在 dict 里的真实索引（编辑/删除用）
            var realIdx = dict.indexOf(d);
            var row = document.createElement('div');
            row.className = 'ck-dict-row';
            row.dataset.idx = realIdx;

            var from = document.createElement('span');
            from.className = 'ck-dict-from';
            from.textContent = d.from;
            var arrow = document.createElement('span');
            arrow.className = 'ck-dict-arrow';
            arrow.textContent = '→';
            var to = document.createElement('span');
            to.className = 'ck-dict-to';
            to.textContent = d.to;

            var editBtn = document.createElement('button');
            editBtn.className = 'ck-dict-edit';
            editBtn.textContent = '编辑';
            var del = document.createElement('button');
            del.className = 'ck-dict-del';
            del.textContent = '删除';

            // 删除
            del.addEventListener('click', function () {
                dict.splice(realIdx, 1);
                saveDict();
                renderDict();
            });

            // 编辑：把 from/to 换成输入框，编辑→保存/取消
            editBtn.addEventListener('click', function () {
                row.innerHTML = '';
                var ifrom = document.createElement('input');
                ifrom.type = 'text';
                ifrom.className = 'ck-dict-from ck-dict-input';
                ifrom.value = d.from;
                var iarrow = document.createElement('span');
                iarrow.className = 'ck-dict-arrow';
                iarrow.textContent = '→';
                var ito = document.createElement('input');
                ito.type = 'text';
                ito.className = 'ck-dict-to ck-dict-input';
                ito.value = d.to;
                var save = document.createElement('button');
                save.className = 'ck-dict-save';
                save.textContent = '保存';
                var cancel = document.createElement('button');
                cancel.className = 'ck-dict-del';
                cancel.textContent = '取消';
                row.appendChild(ifrom);
                row.appendChild(iarrow);
                row.appendChild(ito);
                row.appendChild(save);
                row.appendChild(cancel);
                ifrom.focus();
                ifrom.select();

                save.addEventListener('click', function () {
                    var nf = ifrom.value.trim();
                    var nt = ito.value.trim();
                    if (!nf) { setStatus('原词不能为空', 'warn'); return; }
                    if (!nt) { setStatus('替换词不能为空', 'warn'); return; }
                    dict[realIdx] = { from: nf, to: nt };
                    saveDict();
                    renderDict();
                    setStatus('已更新：' + nf + ' → ' + nt, 'ok');
                });
                cancel.addEventListener('click', function () { renderDict(); });
                // 回车保存
                var onKey = function (e) {
                    if (e.key === 'Enter') { save.click(); }
                    if (e.key === 'Escape') { cancel.click(); }
                };
                ifrom.addEventListener('keydown', onKey);
                ito.addEventListener('keydown', onKey);
            });

            row.appendChild(from);
            row.appendChild(arrow);
            row.appendChild(to);
            row.appendChild(editBtn);
            row.appendChild(del);
            el.dictList.appendChild(row);
        });
    }
    // 判断是否含中文（用于选择匹配策略）
    function hasCJK(s) { return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s); }
    // 对单条字幕文本应用字典替换：英文按词边界（大小写不敏感），中文/日韩直接子串替换
    function applyDictToText(text) {
        var out = text;
        dict.forEach(function (d) {
            if (!d.from) return;
            if (hasCJK(d.from)) {
                // 中文等：直接子串替换（不支持转义正则，用 indexOf 循环）
                var idx = out.toLowerCase().indexOf(d.from.toLowerCase());
                while (idx >= 0) {
                    out = out.slice(0, idx) + (d.to || '') + out.slice(idx + d.from.length);
                    idx = out.toLowerCase().indexOf(d.from.toLowerCase(), idx + (d.to ? d.to.length : 0));
                }
            } else {
                var esc = d.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                var re = new RegExp('\\b' + esc + '\\b', 'gi');
                out = out.replace(re, d.to || '');
            }
        });
        return out;
    }
    // 选中状态提示：SRT/剧本有了就亮徽章
    function refreshBadges() {
        if (el.srtBadge) el.srtBadge.classList.toggle('show', !!srtPath);
        if (el.srtPathLabel) el.srtPathLabel.classList.toggle('has', !!srtPath);
        if (el.docxBadge) el.docxBadge.classList.toggle('show', !!docxPath);
        if (el.docxPathLabel) el.docxPathLabel.classList.toggle('has', !!docxPath);
    }

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
        var title = kind === 'srt' ? '选择字幕 SRT' : '选择剧本 docx';
        var result;
        try {
            // 文件模式；fileTypes 在 Windows CEP 上过滤不可靠，传空数组不过滤，选择后自行校验扩展名
            result = window.cep.fs.showOpenDialogEx(false, false, title, '', [], '', '选择');
        } catch (e) {
            setStatus('打开对话框失败: ' + e.message, 'err');
            return Promise.resolve(null);
        }
        if (result && result.err === 0 && result.data && result.data.length > 0) {
            return Promise.resolve(result.data[0]);
        }
        return Promise.resolve(null);
    }

    // 选择剧本：直接选目录（用户习惯），然后扫描目录里的 .docx，列出让用户点选
    function pickDocxDir() {
        var result;
        try {
            result = window.cep.fs.showOpenDialogEx(false, true, '选择剧本所在目录', '', [], '', '选择');
        } catch (e) {
            setStatus('打开目录对话框失败: ' + e.message, 'err');
            return;
        }
        if (!result || result.err !== 0 || !result.data || result.data.length === 0) {
            return;
        }
        var dir = result.data[0];
        docxDir = dir;
        saveMemory();
        var files = [];
        try {
            files = fs.readdirSync(dir).filter(function (f) {
                return f.toLowerCase().slice(-5) === '.docx' && f.charAt(0) !== '~';
            });
        } catch (e) {
            setStatus('读取目录失败: ' + e.message, 'err');
            return;
        }
        if (files.length === 0) {
            setStatus('该目录里没有 .docx 文件', 'warn');
            el.docxList.style.display = 'none';
            el.docxList.innerHTML = '';
            return;
        }
        // 渲染列表
        el.docxList.innerHTML = '';
        files.forEach(function (f) {
            var btn = document.createElement('button');
            btn.className = 'ck-docx-item';
            btn.textContent = f;
            btn.addEventListener('click', function () {
                docxPath = path.join(dir, f);
                el.docxPathLabel.textContent = f;
                el.docxPathLabel.title = docxPath;
                // 高亮选中项
                var all = el.docxList.querySelectorAll('.ck-docx-item');
                for (var i = 0; i < all.length; i++) all[i].classList.remove('sel');
                btn.classList.add('sel');
                refreshBadges();
                saveMemory();
                setStatus('已选剧本：' + f, 'ok');
            });
            el.docxList.appendChild(btn);
        });
        el.docxList.style.display = 'block';
        setStatus('目录里有 ' + files.length + ' 个 docx，请点选一个', 'warn');
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
                refreshBadges();
                // 从字幕素材名推断集数（如「第3集.srt」）
                var inferred = inferEpisodeFromName(data.name || '');
                if (inferred) {
                    el.inpEpisode.value = inferred;
                    setStatus('已读取项目字幕：' + data.name + '，集数推断为「' + inferred + '」', 'ok');
                } else {
                    setStatus('已读取项目字幕：' + data.name, 'ok');
                }
                saveMemory();
            } catch (e) {
                setStatus('读取选中素材失败: ' + result, 'err');
            }
        });
    }

    // ---------- 从识别板块接收字幕（联动：识别完直接校对）----------
    // 把识别板块内存里的字幕落盘成临时 srt，作为校对输入
    function ingestFromSubtitle() {
        var bridge = window.__subtitleBridge;
        if (!bridge) { setStatus('未检测到字幕识别结果，请先完成识别', 'err'); return; }
        var cur = bridge.getCurrent();
        if (!cur || !cur.subtitles || cur.subtitles.length === 0) {
            setStatus('识别板块当前没有可校对的字幕（请先在「字幕识别」结果区选一个序列）', 'err');
            return;
        }
        var content = typeof bridge.toSRT === 'function' ? bridge.toSRT(cur.subtitles) : toSRT(cur.subtitles);
        var tmpFile = path.join(os.tmpdir(), 'vh_link_' + (cur.seqName || cur.seqId || 'subtitle') + '_' + Date.now() + '.srt');
        try {
            fs.writeFileSync(tmpFile, content, 'utf8');
        } catch (e) {
            setStatus('临时 srt 写入失败: ' + e.message, 'err');
            return;
        }
        srtPath = tmpFile;
        el.srtPathLabel.textContent = '（联动）' + (cur.seqName || cur.seqId) + ' · ' + cur.subtitles.length + ' 条';
        el.srtPathLabel.title = tmpFile;
        refreshBadges();
        // 识别完直接校对：从序列名推断集数并自动填入（不对再手动改）
        var inferred = inferEpisodeFromName(cur.seqName || '');
        if (inferred) {
            el.inpEpisode.value = inferred;
            setStatus('已接收识别字幕「' + (cur.seqName || cur.seqId) + '」' + cur.subtitles.length + ' 条，集数推断为「' + inferred + '」', 'ok');
        } else {
            setStatus('已接收识别字幕「' + (cur.seqName || cur.seqId) + '」' + cur.subtitles.length + ' 条，请选剧本并填集数', 'ok');
        }
        saveMemory();
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
        currentEpisode = data.episode || el.inpEpisode.value.trim() || '';
        saveMemory();
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

    // ---------- 计算修正后的字幕（纯函数：不改状态、不写回）----------
    // 返回 { subs: 修正后字幕数组, deletedCount, editCount, baseName }
    function computeFixedSubs() {
        var picked = [];
        Object.keys(checked).forEach(function (k) {
            if (checked[k]) picked.push(parseInt(k, 10));
        });
        if (picked.length === 0) return null;

        // 从识别板块拿当前序列的字幕（内存），若没有则从 srt 文件读
        var bridge = window.__subtitleBridge;
        var cur = bridge ? bridge.getCurrent() : null;
        var subs = null;
        if (cur && cur.subtitles && cur.subtitles.length > 0) {
            subs = cur.subtitles.map(function (s) { return { start: s.start, end: s.end, text: s.text }; });
        } else {
            subs = parseSRT(fs.readFileSync(srtPath, 'utf8'));
        }
        if (!subs || subs.length === 0) return { error: '没有可用的字幕数据' };

        var deletes = {};
        var edits = {};
        picked.forEach(function (idx) {
            var it = issues[idx];
            if (!it) return;
            if (it.type === 'delete') {
                (it.subIdxs || [it.subIdx]).forEach(function (si) { deletes[si] = true; });
            } else if (it.fixedText) {
                edits[it.subIdx] = it.fixedText;
            }
        });

        var newSubs = [];
        subs.forEach(function (s, i) {
            if (deletes[i]) return;
            var copy = { start: s.start, end: s.end, text: s.text };
            if (edits[i] !== undefined) copy.text = edits[i];
            newSubs.push(copy);
        });
        if (dict.length > 0) {
            newSubs.forEach(function (s) { s.text = applyDictToText(s.text); });
        }
        var seqName = (cur && cur.seqName) ? cur.seqName : '';
        return {
            subs: newSubs,
            deletedCount: subs.length - newSubs.length,
            editCount: Object.keys(edits).length,
            seqName: seqName,
            seqId: cur ? cur.seqId : ''
        };
    }

    // ---------- 应用修正：修改内存字幕 + 生成新 SRT + 回写 ----------
    function applyChecked() {
        var r = computeFixedSubs();
        if (!r) { setStatus('请先勾选要应用的差异', 'err'); return; }
        if (r.error) { setStatus(r.error, 'err'); return; }
        var newSubs = r.subs;

        // 写回内存 bridge（识别板块）
        var bridge = window.__subtitleBridge;
        if (bridge && bridge.applySubtitles) {
            bridge.applySubtitles(newSubs);
        }
        fixedSubs = newSubs;

        // 生成新 SRT 并回写激活序列（传正确的 seqId，避免写到别的序列）
        var srtContent = toSRT(newSubs);
        var payloadJson = JSON.stringify({ srt: srtContent, seqName: r.seqName, nameSuffix: '修正' });
        var setScript = 'wsWriteBackPayload = ' + payloadJson + ';';

        setStatus('正在回写字幕轨...', '');
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('wsWriteBackStr("' + r.seqId + '")', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setStatus('已应用 ' + r.deletedCount + ' 处删除 + ' + r.editCount + ' 处改写，回写完成（' + data.fileName + '）', 'ok');
                        clearAfterApply();
                    } else {
                        setStatus('修正已应用但回写失败: ' + (data.error || result), 'err');
                    }
                } catch (e) {
                    setStatus('回写解析失败: ' + result, 'err');
                }
            });
        });
    }

    // 应用/导出后清理：清差异清单、复位按钮，方便进下一集
    function clearAfterApply() {
        issues = [];
        checked = {};
        fixedSubs = null;
        el.list.innerHTML = '';
        el.summary.textContent = '';
        el.applyRow.style.display = 'none';
        el.btnApply.textContent = '应用选中的修正';
        el.btnApply.disabled = true;
        el.btnSelectAll.textContent = '全选';
    }

    // ---------- 导出修正后的 SRT（不写回 PR，只出文件）----------
    function exportFixedSrt() {
        // 优先用最近一次应用修正后的结果；否则按当前勾选计算
        var subs = fixedSubs;
        var deletedCount = 0, editCount = 0;
        if (!subs) {
            var r = computeFixedSubs();
            if (!r) { setStatus('请先勾选要导出的差异', 'err'); return; }
            if (r.error) { setStatus(r.error, 'err'); return; }
            subs = r.subs;
            deletedCount = r.deletedCount;
            editCount = r.editCount;
        }
        var content = toSRT(subs);
        var base = (currentEpisode || '字幕') + '_修正';
        cep.fs.showSaveDialog('导出修正后的字幕', base, ['.srt'], function (p) {
            if (p) {
                try {
                    fs.writeFileSync(p, content, 'utf8');
                    setStatus('已导出修正 SRT：' + p + (deletedCount || editCount ? '（删 ' + deletedCount + ' / 改 ' + editCount + '）' : ''), 'ok');
                } catch (e) {
                    setStatus('导出失败: ' + e.message, 'err');
                }
            }
        });
    }

    // ---------- 只套用字典（不校对，仅敏感词替换）----------
    function applyDictOnly() {
        if (dict.length === 0) { setStatus('字典为空，请先添加替换规则', 'err'); return; }
        var bridge = window.__subtitleBridge;
        var cur = bridge ? bridge.getCurrent() : null;
        var subs = null;
        var seqName = '';
        var seqId = '';
        if (cur && cur.subtitles && cur.subtitles.length > 0) {
            subs = cur.subtitles.map(function (s) { return { start: s.start, end: s.end, text: s.text }; });
            seqName = cur.seqName || '';
            seqId = cur.seqId || '';
        } else if (srtPath) {
            subs = parseSRT(fs.readFileSync(srtPath, 'utf8'));
        }
        if (!subs || subs.length === 0) { setStatus('没有可用的字幕数据', 'err'); return; }
        var newSubs = subs.map(function (s) { return { start: s.start, end: s.end, text: applyDictToText(s.text) }; });
        // 写回内存
        if (bridge && bridge.applySubtitles) bridge.applySubtitles(newSubs);
        fixedSubs = newSubs;
        // 回写 PR
        var srtContent = toSRT(newSubs);
        var payloadJson = JSON.stringify({ srt: srtContent, seqName: seqName, nameSuffix: '字典' });
        var setScript = 'wsWriteBackPayload = ' + payloadJson + ';';
        setStatus('正在套用字典并回写...', '');
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('wsWriteBackStr("' + seqId + '")', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setStatus('已套用 ' + dict.length + ' 条替换规则并回写（' + data.fileName + '）', 'ok');
                    } else {
                        setStatus('字典已套用但回写失败: ' + (data.error || result), 'err');
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
                refreshBadges();
            }
        });
    });

    el.btnPickDocx.addEventListener('click', function () {
        pickDocxDir();
    });

    el.btnCheck.addEventListener('click', runCheck);
    el.btnApply.addEventListener('click', applyChecked);
    el.btnDictOnly.addEventListener('click', applyDictOnly);
    el.btnExportFixed.addEventListener('click', exportFixedSrt);

    // 替换字典：添加
    el.dictAdd.addEventListener('click', function () {
        var from = el.dictFrom.value.trim();
        var to = el.dictTo.value.trim();
        if (!from) { setStatus('请填写「原词」', 'warn'); return; }
        if (!to) { setStatus('请填写「替换为」', 'warn'); return; }
        // 去重（同 from 覆盖）
        var existed = false;
        dict.forEach(function (d) {
            if (d.from.toLowerCase() === from.toLowerCase()) { d.to = to; existed = true; }
        });
        if (!existed) dict.push({ from: from, to: to });
        saveDict();
        renderDict();
        el.dictFrom.value = '';
        el.dictTo.value = '';
        setStatus('已添加替换规则：' + from + ' → ' + to, 'ok');
    });

    // 打开字典文件（用系统默认程序，方便批量编辑）
    el.dictOpen.addEventListener('click', function () {
        try {
            saveDict();
            child_process.exec('start "" "' + dictFile + '"');
        } catch (e) {
            setStatus('打开字典文件失败: ' + e.message, 'err');
        }
    });
    // 重新加载（外部编辑后重新读入）
    el.dictReload.addEventListener('click', function () {
        loadDict();
        renderDict();
        setStatus('已重新加载字典（' + dict.length + ' 条）', 'ok');
    });
    // 折叠/展开列表
    el.dictToggle.addEventListener('click', function () {
        dictCollapsed = !dictCollapsed;
        renderDict();
    });
    // 搜索（实时过滤）
    el.dictSearch.addEventListener('input', function () {
        dictSearchKey = el.dictSearch.value.trim();
        renderDict();
    });

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
    loadDict();
    renderDict();
    loadMemory();
    refreshBadges();
    // 集数输入时记忆
    el.inpEpisode.addEventListener('input', saveMemory);

    // 暴露给「字幕识别」板块联动调用：接收识别字幕并切到校对 tab
    window.__checkIngest = function () {
        ingestFromSubtitle();
        if (window.__atSwitchTab) window.__atSwitchTab('check');
    };
})();
