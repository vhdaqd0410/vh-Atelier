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

    // 公共模块：历史/输出目录/进度提示等（与「本地去字幕」共用一份实现）
    var loc = (window.__vhLocal && window.__vhLocal.mount) ? window.__vhLocal.mount({
        prefix: 'lup',
        hintSuffix: 'HintLine',
        histFile: 'localup_history.json',
        dirKey: HIST_KEY,
        resultDir: 'localup_results',
        importBin: '超分',
        presetAuto: '自动（无字幕）',
        presetPrefer: /无字幕|no.?sub/i,
        histTip: '可直接把文件名拖到时间轴；也可点「导入」放进素材箱',
        busyIds: ['lupGoSeq', 'lupGoClip', 'lupPick']
    }) : null;

    // 无公共模块时的兜底（保证单文件也能跑）
    function needLoc() {
        if (!loc) throw new Error('en-local.js 未加载');
        return loc;
    }

    // ---------- 小工具 ----------
    function hint(msg, cls) { return loc ? loc.hint(msg, cls) : null; }
    function log(msg, cls) { return loc ? loc.log(msg, cls) : null; }
    function setProg(pct, text) { return loc ? loc.setProg(pct, text) : null; }
    function setBusy(on) { return loc ? loc.setBusy(on) : null; }
    function extRoot() { return loc ? loc.extRoot() : ''; }
    function getOutDir() { return loc ? loc.getOutDir() : ''; }
    function setOutDir(d) { return loc ? loc.setOutDir(d) : null; }
    function defaultOutDir() { return loc ? loc.defaultOutDir() : ''; }
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
    function uniqueOutPath(dir, baseName, ext) { return loc ? loc.uniqueOutPath(dir, baseName, ext) : ''; }

    // ---------- 历史记录 ----------
    var HIST_MAX = 300;
    function histFile() { return loc ? loc.histFile() : ''; }
    function loadHistory() { return loc ? loc.loadHistory() : []; }
    function saveHistory(a) { return loc ? loc.saveHistory(a) : false; }
    function addHistory(rec) { return loc ? loc.addHistory(rec) : null; }
    function delHistory(id) { return loc ? loc.delHistory(id) : null; }
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
    function revealFile(p) { return loc ? loc.revealFile(p) : null; }
    function openDir(d) { return loc ? loc.openDir(d) : null; }
    // 宿主各函数返回格式不统一（有的带 OK: 前缀有的不带），统一容错解析
    function importToBin(files, binName) { return loc ? loc.importToBin(files, binName) : Promise.resolve({ ok: false, error: 'en-local 未加载' }); }

    function renderHistory() { return loc ? loc.renderHistory() : null; }

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
    function fillPresets() { return loc ? loc.fillPresets() : null; }

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
