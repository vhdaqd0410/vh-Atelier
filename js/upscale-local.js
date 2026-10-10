// vh-Atelier 本地超分面板（Real-ESRGAN-ncnn-vulkan）
//
// 与「本地去字幕」保持同一套交互：序列/区间用公共模块 __vhClip，
// 中间件导出复用 __vhEnhanceExportForLocal，处理走 py/upscale_client.py。
// 历史记录独立存 collect/localup_history.json（与去字幕分开，便于各自清理）。
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path, cp, os;
    try {
        fs = require('fs'); path = require('path'); cp = require('child_process'); os = require('os');
    } catch (e) { return; }

    function $(id) { return document.getElementById(id); }
    var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;

    var clip = null;
    var running = null;
    var APP = 'lup';
    var HIST_KEY = 'vh_localup_hist_dir';

    // ---------- 小工具 ----------
    function hint(msg, cls) {
        var el = $(APP + 'HintLine');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'en-act-hint' + (cls ? ' ' + cls : '');
    }
    function log(msg, cls) {
        var el = $(APP + 'Log');
        if (!el) return;
        var line = document.createElement('div');
        line.className = 'en-log-line ' + (cls || '');
        line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
    }
    function setProg(pct, text) {
        var w = $(APP + 'ProgWrap');
        if (w) w.style.display = (pct === null) ? 'none' : '';
        if (pct !== null) {
            var f = $(APP + 'ProgFill'); if (f) f.style.width = Math.max(0, Math.min(100, pct)) + '%';
            var p = $(APP + 'ProgPct'); if (p) p.textContent = Math.round(pct) + '%';
        }
        if (text !== undefined) { var t = $(APP + 'ProgText'); if (t) t.textContent = text; }
    }
    function setBusy(on) {
        ['lupGoSeq', 'lupGoClip', 'lupPick'].forEach(function (id) {
            var b = $(id); if (b) b.disabled = !!on;
        });
        var s = $(APP + 'Stop'); if (s) s.disabled = !on;
    }
    function extRoot() {
        try { return csInterface.getSystemPath('extension'); } catch (e) { return ''; }
    }
    function getOutDir() {
        try { return localStorage.getItem(HIST_KEY) || ''; } catch (e) { return ''; }
    }
    function setOutDir(d) { try { localStorage.setItem(HIST_KEY, d || ''); } catch (e) {} }
    function defaultOutDir() {
        var saved = getOutDir();
        if (saved && fs.existsSync(saved)) return saved;
        var ext = extRoot();
        var d = ext ? path.join(ext, 'collect', 'localup_results')
                    : path.join(os.homedir(), 'vhAtelier_localup');
        try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
        return d;
    }
    function pyScript() {
        var ext = extRoot();
        var p = ext ? path.join(ext, 'py', 'upscale_client.py') : '';
        return (p && fs.existsSync(p)) ? p : '';
    }
    function pyExe() {
        // 引擎是绿色可执行，不需要 torch：用系统 python 即可
        var cands = [];
        try { cands.push(localStorage.getItem('vh_py') || ''); } catch (e) {}
        cands.push('python', 'py');
        return cands.filter(function (x) { return x; })[0] || 'python';
    }
    // 生成不覆盖的输出路径（与去字幕同一策略）
    function uniqueOutPath(dir, baseName, ext) {
        ext = ext || '.mp4';
        var cand = path.join(dir, baseName + ext);
        if (!fs.existsSync(cand)) return cand;
        for (var n = 2; n <= 999; n++) {
            cand = path.join(dir, baseName + '_' + n + ext);
            if (!fs.existsSync(cand)) return cand;
        }
        var ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        return path.join(dir, baseName + '_' + ts + ext);
    }

    // ---------- 历史记录 ----------
    var HIST_MAX = 300;
    function histFile() {
        var ext = extRoot();
        return ext ? path.join(ext, 'collect', 'localup_history.json') : '';
    }
    function loadHistory() {
        var f = histFile();
        if (!f) return [];
        try {
            if (!fs.existsSync(f)) return [];
            var a = JSON.parse(fs.readFileSync(f, 'utf8'));
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    }
    function saveHistory(a) {
        var f = histFile();
        if (!f) return false;
        try {
            var d = path.dirname(f);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(f, JSON.stringify((a || []).slice(0, HIST_MAX), null, 2), 'utf8');
            return true;
        } catch (e) { return false; }
    }
    function addHistory(rec) {
        var a = loadHistory(); a.unshift(rec);
        if (saveHistory(a)) renderHistory();
    }
    function delHistory(id) {
        if (saveHistory(loadHistory().filter(function (r) { return String(r.id) !== String(id); }))) renderHistory();
    }
    function fmtSize(n) {
        n = Number(n) || 0;
        if (n <= 0) return '';
        if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
        return (n / 1073741824).toFixed(2) + ' GB';
    }
    function fmtDur(s) {
        s = Math.round(Number(s) || 0);
        var m = Math.floor(s / 60);
        return m > 0 ? (m + '分' + (s % 60) + '秒') : (s + '秒');
    }
    function revealFile(p) {
        try {
            if (fs.existsSync(p)) cp.exec('explorer /select,"' + String(p).replace(/\//g, '\\') + '"', { windowsHide: true });
            else cp.exec('explorer "' + String(path.dirname(p)).replace(/\//g, '\\') + '"', { windowsHide: true });
        } catch (e) {}
    }
    function openDir(d) {
        try { cp.exec('explorer "' + String(d).replace(/\//g, '\\') + '"', { windowsHide: true }); } catch (e) {}
    }
    // 宿主各函数返回格式不统一（有的带 OK: 前缀有的不带），统一容错解析
    function parseHostJson(s) {
        if (s === null || s === undefined) return null;
        var t = String(s).trim();
        if (t.indexOf('OK:') === 0) t = t.slice(3).trim();
        if (t.indexOf('ERR:') === 0) return { error: t.slice(4).trim() };
        try { return JSON.parse(t); } catch (e) { return null; }
    }

    function importToBin(files, binName) {
        return new Promise(function (resolve) {
            try {
                var list = (files || []).filter(Boolean);
                if (!list.length) { resolve({ ok: false, error: '没有可导入的文件' }); return; }
                if (!csInterface) { resolve({ ok: false, error: '宿主桥不可用' }); return; }
                csInterface.evalScript('meImportPayload = ' +
                    JSON.stringify({ files: list, binName: binName || '超分' }) + ';', function () {
                    csInterface.evalScript('meImportFilesToBinStr()', function (r) {
                        var d = parseHostJson(r);
                        if (d) resolve(d);
                        else resolve({ ok: false, error: String(r) });
                    });
                });
            } catch (e) { resolve({ ok: false, error: e.message }); }
        });
    }

    function renderHistory() {
        var box = $(APP + 'HistList');
        if (!box) return;
        var arr = loadHistory();
        var cnt = $(APP + 'HistCount');
        var h = $(APP + 'HistHint');
        if (cnt) cnt.textContent = arr.length ? ('共 ' + arr.length + ' 条') : '';
        if (h) h.textContent = arr.length ? '可直接把文件名拖到时间轴；也可点「导入」放进素材箱' : '';
        if (!arr.length) {
            box.innerHTML = '<div class="hint" style="padding:6px;">还没有处理记录</div>';
            return;
        }
        box.innerHTML = '';
        arr.forEach(function (r) {
            var row = document.createElement('div');
            row.className = 'ls-hist-row';
            var exists = false;
            try { exists = fs.existsSync(r.out); } catch (e) {}
            if (!exists) row.classList.add('missing');

            var main = document.createElement('div');
            main.className = 'ls-hist-main';
            var nm = document.createElement('span');
            nm.className = 'ls-hist-name';
            nm.textContent = path.basename(r.out || '(未知)');
            nm.title = r.out || '';
            if (exists) {
                nm.setAttribute('draggable', 'true');
                nm.addEventListener('dragstart', function (ev) {
                    try {
                        ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', r.out);
                        ev.dataTransfer.setData('text/plain', r.out);
                        ev.dataTransfer.effectAllowed = 'copy';
                    } catch (e) {}
                });
                nm.style.cursor = 'grab';
            }
            main.appendChild(nm);
            if (!exists) {
                var ms = document.createElement('span');
                ms.className = 'ls-hist-miss';
                ms.textContent = '文件已不在';
                main.appendChild(ms);
            }
            row.appendChild(main);

            var meta = document.createElement('div');
            meta.className = 'ls-hist-meta';
            var bits = [];
            if (r.at) bits.push(String(r.at).replace('T', ' ').slice(0, 16));
            if (r.model) bits.push(r.model);
            if (r.scale) bits.push(r.scale + 'x');
            if (r.outRes) bits.push(r.outRes);
            if (r.elapsed) bits.push(fmtDur(r.elapsed));
            if (r.size) bits.push(fmtSize(r.size));
            meta.textContent = bits.join(' · ');
            row.appendChild(meta);

            var ops = document.createElement('div');
            ops.className = 'ls-hist-ops';
            function mk(label, title, fn, cls) {
                var b = document.createElement('button');
                b.className = 'secondary mini' + (cls ? ' ' + cls : '');
                b.textContent = label; b.title = title || '';
                b.addEventListener('click', fn);
                return b;
            }
            ops.appendChild(mk('⬆ 导入', '导入 PR「超分」素材箱', function () {
                if (!exists) { hint('文件已不在：' + r.out, 'err'); return; }
                importToBin([r.out], '超分').then(function (res) {
                    if (res && res.ok && (res.imported || []).length)
                        hint('✅ 已导入素材箱：' + (res.imported || []).join('、'), 'ok');
                    else hint('⚠ 导入失败：' + ((res && (res.error || JSON.stringify(res))) || '未知'), 'warn');
                });
            }));
            ops.appendChild(mk('📂 位置', '在资源管理器里定位', function () { revealFile(r.out); }));
            ops.appendChild(mk('▶ 打开', '用系统默认播放器打开', function () {
                if (!exists) { hint('文件已不在', 'err'); return; }
                try { cp.exec('start "" "' + String(r.out).replace(/\//g, '\\') + '"'); } catch (e) {}
            }));
            ops.appendChild(mk('✕', '从列表删除（不删文件）', function () { delHistory(r.id); }, 'ls-hist-del'));
            row.appendChild(ops);
            box.appendChild(row);
        });
    }

    // 卡片最大化
    var EXP_KEY = 'vh_localup_card_exp';
    function setCardExpanded(which, save) {
        var panel = $('panel-localup');
        if (!panel) return;
        panel.classList.remove('en-exp-hist');
        panel.classList.remove('en-exp-log');
        var hx = $(APP + 'HistExpand'), lx = $(APP + 'LogExpand');
        [hx, lx].forEach(function (b) { if (b) { b.textContent = '⤢'; b.title = '展开：占满面板（再点还原）'; } });
        if (!which) { if (save) { try { localStorage.setItem(EXP_KEY, ''); } catch (e) {} } return; }
        panel.classList.add('en-exp-' + which);
        var btn = (which === 'hist') ? hx : lx;
        if (btn) { btn.textContent = '⤡'; btn.title = '还原：恢复布局'; }
        if (save) { try { localStorage.setItem(EXP_KEY, which); } catch (e) {} }
    }
    function toggleCard(which) {
        var panel = $('panel-localup');
        if (!panel) return;
        setCardExpanded(panel.classList.contains('en-exp-' + which) ? '' : which, true);
    }

    // ---------- 引擎检查 ----------
    function doCheck(verbose) {
        var sp = pyScript();
        if (!sp) { hint('找不到 py/upscale_client.py', 'err'); return; }
        if (verbose) { log('▶ 开始自检…'); setProg(null, ''); }
        hint('正在检查本地超分引擎…');
        cp.exec('"' + pyExe() + '" "' + sp + '" check',
                { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
                function (err, stdout, stderr) {
                    var txt = String(stdout || '').trim().split('\n').pop() || '';
                    var d = null;
                    try { d = JSON.parse(txt); } catch (e) {}
                    if (!d) {
                        hint('❌ 自检失败：' + ((stderr || '') || txt || '无输出').slice(0, 300), 'err');
                        if (verbose) log('❌ 自检无有效输出', 'err');
                        return;
                    }
                    if (d.ok) {
                        hint('✅ 引擎就绪' + (d.gpu ? (' · ' + d.gpu) : '') +
                             '（模型 ' + (d.models || []).length + ' 个）', 'ok');
                        if (verbose) {
                            log('引擎: ' + d.engineRoot);
                            log('ffmpeg: ' + d.ffmpeg);
                            log('设备: ' + (d.gpu || '未知'));
                        }
                    } else {
                        hint('❌ 未就绪：' + ((d.reasons || []).join('；') || '未知'), 'err');
                        if (verbose) (d.reasons || []).forEach(function (x) { log('  ' + x, 'err'); });
                    }
                });
    }

    // ---------- 处理 ----------
    function currentOpts() {
        return {
            model: (($(APP + 'Model') || {}).value) || 'anime',
            scale: (($(APP + 'Scale') || {}).value) || '2',
            target: (($(APP + 'Target') || {}).value) || '1080',
            preset: (($(APP + 'Preset') || {}).value) || ''
        };
    }
    function runOne(input, output, onDone) {
        var o = currentOpts();
        var sp = pyScript();
        if (!sp) { hint('找不到 py/upscale_client.py', 'err'); if (onDone) onDone(new Error('缺脚本')); return; }
        hint('正在超分：' + path.basename(input) + '（' + o.model + ' ' + o.scale + 'x）…');
        setProg(0, '准备中…');
        log('▶ 输入：' + input);
        log('  模型 ' + o.model + ' ×' + o.scale + ' → 目标长边 ' + o.target);
        setBusy(true);

        var args = [sp, 'run', '--input', input, '--output', output,
                    '--model', o.model, '--scale', String(o.scale),
                    '--target', String(o.target), '--progress'];
        var child;
        try {
            child = cp.spawn(pyExe(), args, { windowsHide: true });
        } catch (e) {
            setBusy(false); hint('启动失败：' + e.message, 'err'); if (onDone) onDone(e); return;
        }
        var buf = '';
        function handle(chunk) {
            buf += String(chunk);
            var lines = buf.split('\n'); buf = lines.pop();
            lines.forEach(function (ln) {
                ln = ln.trim();
                if (!ln || ln.charAt(0) !== '{') return;
                var ev = null;
                try { ev = JSON.parse(ln); } catch (e) { return; }
                if (ev.stage === 'start') {
                    if (ev.video) log('  源：' + ev.video.width + '×' + ev.video.height +
                                      '  ' + (ev.video.fps || '?') + 'fps');
                    setProg(1, '抽帧中…');
                } else if (ev.stage === 'progress') {
                    setProg(ev.percent, (ev.phase || '处理中') + '  已用 ' + (ev.elapsed || 0) + 's');
                } else if (ev.stage === 'log') {
                    log('  ' + ev.line, 'warn');
                } else if (ev.stage === 'done') {
                    running = null; setBusy(false);
                    if (ev.ok) {
                        setProg(100, '完成');
                        hint('✅ 完成：' + path.basename(ev.output) + '（' + fmtSize(ev.size) +
                             '，' + fmtDur(ev.elapsed) + '）', 'ok');
                        log('✅ 完成，用时 ' + ev.elapsed + 's' +
                            (ev.outWidth ? ('，输出 ' + ev.outWidth + '×' + ev.outHeight) : ''));
                        try {
                            addHistory({
                                id: 'u' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                                input: input, out: ev.output,
                                at: new Date().toISOString(),
                                model: ev.model || o.model, scale: ev.scale || o.scale,
                                outRes: (ev.outWidth ? (ev.outWidth + '×' + ev.outHeight) : ''),
                                elapsed: ev.elapsed || 0, size: ev.size || 0
                            });
                        } catch (e) {}
                        if (onDone) onDone(null, ev.output);
                    } else {
                        setProg(null, '');
                        hint('❌ 失败：' + (ev.error || ('退出码 ' + ev.returncode)), 'err');
                        log('❌ 失败：' + (ev.error || ev.returncode), 'err');
                        if (onDone) onDone(new Error(ev.error || '失败'));
                    }
                }
            });
        }
        child.stdout.on('data', handle);
        child.stderr.on('data', handle);
        child.on('error', function (e) {
            running = null; setBusy(false);
            hint('进程启动失败：' + e.message, 'err');
            if (onDone) onDone(new Error(e.message));
        });
        child.on('close', function () {
            if (running) { running = null; setBusy(false); }
        });
        running = { kill: function () { try { child.kill(); } catch (e) {} } };
    }

    // 入口 1：处理勾选序列
    function runSequences() {
        if (running) { hint('已有任务在跑，请先停止', 'err'); return; }
        var seqs = clip ? clip.getCheckedSeqs() : [];
        if (!seqs.length) { hint('请先在上方勾选要处理的序列', 'err'); return; }
        doCheck(false);
        var dir = defaultOutDir();
        var idx = 0;
        function next() {
            if (idx >= seqs.length) {
                setBusy(false);
                hint('✅ 全部完成（' + seqs.length + ' 个序列）', 'ok');
                return;
            }
            var name = seqs[idx++];
            hint('导出中（' + idx + '/' + seqs.length + '）：' + name + '…');
            if (typeof window.__vhEnhanceExportForLocal !== 'function') {
                setBusy(false); hint('导出能力不可用：请改用「📁 选文件…」', 'err'); return;
            }
            var o = currentOpts();
            window.__vhEnhanceExportForLocal(function (err, file) {
                if (err || !file) {
                    log('✗ [' + name + '] 导出失败：' + ((err && err.message) || '未知'), 'err');
                    next(); return;
                }
                var base = path.basename(file).replace(/\.[^.]+$/, '')
                    .replace(/_nosub(_full|_clip)?$/i, '').replace(/_(full|clip)$/i, '') || 'out';
                try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
                var out = uniqueOutPath(dir, base + '_up' + o.scale, '.mp4');
                runOne(file, out, function (e2, produced) {
                    if (e2) { next(); return; }
                    importToBin([produced], '超分').then(function (r) {
                        if (r && r.ok) log('📥 已导入素材箱「超分」：' + (r.imported || []).join('、'), 'ok');
                        next();
                    });
                });
            }, name);
        }
        next();
    }

    // 入口 2：处理选中区间
    function runClip() {
        if (running) { hint('已有任务在跑，请先停止', 'err'); return; }
        if (!clip) { hint('序列模块未就绪', 'err'); return; }
        clip.grab(true).then(function (info) {
            if (!info) {
                hint('读不到区间：' + (clip.srcMode() === 'inout'
                    ? '请先在时间轴按 I / O 设好入出点' : '请先在时间轴选中片段'), 'err');
                return;
            }
            var c = clip.normalized();
            doCheck(false);
            if (typeof window.__vhEnhanceExportForLocal !== 'function') {
                hint('导出能力不可用：请改用「📁 选文件…」', 'err'); return;
            }
            var o = currentOpts();
            var dir = defaultOutDir();
            hint('导出区间中…');
            window.__vhEnhanceExportForLocal(function (err, file) {
                if (err || !file) { hint('区间导出失败：' + ((err && err.message) || '未知'), 'err'); return; }
                var base = path.basename(file).replace(/\.[^.]+$/, '')
                    .replace(/_nosub(_full|_clip)?$/i, '').replace(/_(full|clip)$/i, '') || 'clip';
                try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
                var out = uniqueOutPath(dir, base + '_up' + o.scale, '.mp4');
                runOne(file, out, function (e2, produced) {
                    if (e2) return;
                    importToBin([produced], '超分').then(function (r) {
                        if (r && r.ok) log('📥 已导入素材箱「超分」：' + (r.imported || []).join('、'), 'ok');
                    });
                });
            }, c.seqName, { startSec: c.startSec, endSec: c.endSec }, o.preset);
        });
    }

    // 入口 3：选文件
    function pickAndRun() {
        if (running) { hint('已有任务在跑，请先停止', 'err'); return; }
        var dir = defaultOutDir();
        doCheck(false);
        var v = window.prompt('请输入要超分的视频完整路径：', dir + '\\');
        if (!v) { hint('已取消', ''); return; }
        var o = currentOpts();
        var base = path.basename(v).replace(/\.[^.]+$/, '') || 'out';
        try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
        var out = uniqueOutPath(dir, base + '_up' + o.scale, '.mp4');
        runOne(v, out, function (e2, produced) {
            if (e2) return;
            importToBin([produced], '超分').then(function (r) {
                if (r && r.ok) log('📥 已导入素材箱「超分」：' + (r.imported || []).join('、'), 'ok');
            });
        });
    }

    // ---------- 预设填充 ----------
    function fillPresets() {
        var sel = $(APP + 'Preset');
        if (!sel) return;
        var hits = [];
        try { if (typeof window.__vhListPresets === 'function') hits = window.__vhListPresets() || []; } catch (e) {}
        var prev = sel.value;
        sel.innerHTML = '<option value="">自动（无字幕）</option>';
        hits.forEach(function (h) {
            var o = document.createElement('option');
            o.value = h.full; o.textContent = h.name;
            sel.appendChild(o);
        });
        if (prev) sel.value = prev;
        else {
            var prefer = hits.filter(function (h) { return /无字幕|no.?sub/i.test(h.name); });
            if (prefer.length) sel.value = prefer[0].full;
        }
    }

    // ---------- 初始化 ----------
    function bind() {
        if (!$('panel-localup')) return;
        if (window.__vhClip) {
            clip = window.__vhClip.mount({
                seqListId: APP + 'SeqList', refreshBtnId: APP + 'RefSeq',
                grabBtnId: APP + 'GrabClip', clipInfoId: APP + 'ClipInfo',
                srcSelectId: APP + 'ClipSrc',
                onLog: function (m, c) { log(m, c); }
            });
        }
        fillPresets();
        renderHistory();

        var ck = $(APP + 'Check'); if (ck) ck.addEventListener('click', function () { doCheck(true); });
        var g1 = $(APP + 'GoSeq'); if (g1) g1.addEventListener('click', runSequences);
        var g2 = $(APP + 'GoClip'); if (g2) g2.addEventListener('click', runClip);
        var g3 = $(APP + 'Pick'); if (g3) g3.addEventListener('click', pickAndRun);
        var st = $(APP + 'Stop'); if (st) st.addEventListener('click', function () {
            if (running) { running.kill(); hint('已请求停止', 'warn'); log('⏹ 用户停止', 'warn'); }
        });
        var hcl = $(APP + 'HistClear'); if (hcl) hcl.addEventListener('click', function () {
            if (!window.confirm('清空历史记录？（只清列表，不删除视频文件）')) return;
            if (saveHistory([])) { renderHistory(); hint('历史记录已清空', 'ok'); }
        });
        var hloc = $(APP + 'HistLoc'); if (hloc) hloc.addEventListener('click', function () { openDir(defaultOutDir()); });
        var hex = $(APP + 'HistExpand'); if (hex) hex.addEventListener('click', function () { toggleCard('hist'); });
        var lex = $(APP + 'LogExpand'); if (lex) lex.addEventListener('click', function () { toggleCard('log'); });
        var lcl = $(APP + 'LogClear'); if (lcl) lcl.addEventListener('click', function () {
            var el = $(APP + 'Log'); if (el) el.innerHTML = '';
        });
        (function () {
            var s = '';
            try { s = localStorage.getItem(EXP_KEY) || ''; } catch (e) {}
            if (s === 'hist' || s === 'log') setCardExpanded(s, false);
        })();

        // 倍率/模型变化时刷新目标可选值提示
        var sc = $(APP + 'Scale');
        if (sc) sc.addEventListener('change', function () {
            var o = currentOpts();
            log('切换：' + o.model + ' ×' + o.scale + ' → 长边 ' + o.target);
        });

        // 首次静默自检
        setTimeout(function () { doCheck(false); }, 1200);
    }

    window.__localupOnShow = function () {
        try { if (clip) clip.refreshSeqs(true); } catch (e) {}
        try { fillPresets(); } catch (e) {}
        try { renderHistory(); } catch (e) {}
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
