// vh-Atelier 本地去字幕（VSR）面板逻辑
// 对接 js/vsr.js（子进程调用 py/vsr_client.py）。界面元素见 index.html 的 #enLocalCard。
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path, cp, os;
    try {
        fs = require('fs'); path = require('path'); cp = require('child_process'); os = require('os');
    } catch (e) { return; }

    function $(id) { return document.getElementById(id); }
    var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;

    var running = null;      // 当前任务句柄
    var lastOutDir = '';     // 上次输出目录
    var DIR_KEY = 'vh_vsr_outdir';

    function hint(msg, cls) {
        var el = $('enLocalHint');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'en-act-hint' + (cls ? ' ' + cls : '');
    }
    function logEl() { return $('vLocalLog'); }
    function log(msg, cls) {
        try { if (window.__vhVSR) window.__vhVSR.log(msg, cls); } catch (e) {}
    }
    function setLogVisible() {
        var el = logEl();
        if (el && el.style.display === 'none') el.style.display = '';
    }
    function setProg(pct, text) {
        var w = $('enLocalProgWrap');
        if (w) w.style.display = (pct === null) ? 'none' : '';
        if (pct !== null) {
            var f = $('enLocalProgFill'); if (f) f.style.width = Math.max(0, Math.min(100, pct)) + '%';
            var p = $('enLocalProgPct'); if (p) p.textContent = pct + '%';
        }
        if (text !== undefined) { var t = $('enLocalProgText'); if (t) t.textContent = text; }
    }
    function getOutDir() {
        var v = '';
        try { v = localStorage.getItem(DIR_KEY) || ''; } catch (e) {}
        return v;
    }
    function setOutDir(d) {
        try { localStorage.setItem(DIR_KEY, d || ''); } catch (e) {}
        lastOutDir = d || '';
    }
    // 默认输出目录：优先工程目录/去字幕结果，其次 collect/vsr_results
    function defaultOutDir() {
        var saved = getOutDir();
        if (saved && fs.existsSync(saved)) return saved;
        var ext = '';
        try { ext = csInterface.getSystemPath('extension'); } catch (e) {}
        var d = ext ? path.join(ext, 'collect', 'vsr_results') : path.join(os.homedir(), 'vhAtelier_vsr');
        try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
        return d;
    }

    // 字幕区域：返回 [[y0,y1,x0,x1]] 或 []
    // 注意（VSR 源码实测）：
    //   sttn-auto 不做字幕检测，直接用给定区域重绘 —— 不给区域会把整屏当区域，
    //   等于全屏重绘（几乎无效且极慢）。所以「区域内自动检测」要配合会检测的算法
    //   （sttn-det / lama / propainter / opencv），并且仍给一个大致区域。
    function currentArea() {
        var mode = (($('enLocalArea') || {}).value) || 'preset-bottom';
        function num(id, def) {
            var v = parseFloat((($(id) || {}).value) || '');
            return isFinite(v) ? v : def;
        }
        if (mode === 'manual') {
            return [[num('enLocalY0', 0.78), num('enLocalY1', 1),
                     num('enLocalX0', 0), num('enLocalX1', 1)]];
        }
        if (mode === 'auto') {
            // 「自动检测」仍需要一个搜索范围：给到偏底部的大区间，
            // 由 OCR 在这个范围内自己找字幕（比全屏检测快很多也更准）
            return [[0.62, 1.0, 0.0, 1.0]];
        }
        // preset-bottom：竖屏短剧/漫剧，底部约 22%
        return [[0.78, 1.0, 0.0, 1.0]];
    }

    // 算法与区域模式不匹配时给出提示（避免用户白等）
    function algoAreaWarn() {
        var algo = (($('enLocalMode') || {}).value) || 'sttn-auto';
        var mode = (($('enLocalArea') || {}).value) || 'preset-bottom';
        var box = $('enLocalAlgoWarn');
        if (!box) return;
        var msg = '';
        if (algo === 'sttn-auto' && mode === 'auto') {
            msg = 'STTN 直绘不做字幕识别，「区域内自动检测」对它无效：' +
                  '请改选 STTN 检测 / LaMa，或把区域改为底部固定区。';
        }
        box.textContent = msg;
        box.style.display = msg ? '' : 'none';
    }

    function refreshAreaUI() {
        var mode = (($('enLocalArea') || {}).value) || 'preset-bottom';
        var row = $('enLocalAreaRow');
        if (row) row.style.display = (mode === 'manual') ? '' : 'none';
        var h = $('enLocalAreaHint');
        if (h) {
            h.textContent = (mode === 'auto')
                ? '在偏底部范围内用 OCR 自动找字幕位置（需配合 STTN 检测 / LaMa 等会检测的算法）'
                : (mode === 'manual')
                    ? '自定义区域（相对比例 0–1）：y 为纵向、x 为横向'
                    : '默认覆盖底部 22%（竖屏短剧/漫剧的字幕带），最稳最快';
        }
        algoAreaWarn();
    }

    function doCheck() {
        hint('正在自检本地引擎…');
        setLogVisible();
        log('开始自检…');
        window.__vhVSR.check(true, function (r) {
            if (r && r.ok) {
                hint('✅ 本地引擎就绪' + (r.gpu ? (' · ' + r.gpu) : '') +
                     (r.hasCuda ? '（CUDA 加速）' : '（未启用 CUDA，会很慢）'), 'ok');
                log('✅ 就绪：torch ' + (r.torchVer || '') + '  GPU=' + (r.gpu || '无'));
            } else {
                hint('❌ 本地引擎未就绪：' + ((r && r.reasons && r.reasons[0]) || '未知原因'), 'err');
                (r && r.reasons || []).forEach(function (x) { log('· ' + x, 'err'); });
                log('安装方法见 tools/VSR 目录说明', 'err');
            }
        });
    }

    function runOne(input, output, onDone) {
        var opts = {
            input: input,
            output: output,
            area: currentArea(),
            mode: (($('enLocalMode') || {}).value) || 'sttn-auto'
        };
        hint('正在处理：' + path.basename(input) + '（' + opts.mode + '）…');
        setProg(0, '准备中…');
        setLogVisible();
        log('▶ 输入：' + input);
        log('  算法：' + opts.mode + '  区域：' + (opts.area.length ? JSON.stringify(opts.area) : '全片自动'));
        if (output) log('  输出：' + output);
        var t0 = Date.now();
        var gotDone = false;
        running = window.__vhVSR.run(opts, function (ev) {
            if (!ev) return;
            if (ev.stage === 'start') {
                if (ev.video && ev.video.width) {
                    log('  视频：' + ev.video.width + 'x' + ev.video.height +
                        (ev.coords && ev.coords.length ? ('，字幕区像素=' + JSON.stringify(ev.coords[0])) : ''));
                }
                setProg(1, '开始处理…');
            } else if (ev.stage === 'progress') {
                setProg(ev.percent, '处理中… 已用 ' + (ev.elapsed || 0) + 's');
            } else if (ev.stage === 'log') {
                log('  ' + ev.line, 'warn');
            } else if (ev.stage === 'done') {
                gotDone = true;
                running = null;
                var btn = $('enLocalStop'); if (btn) btn.disabled = true;
                if (ev.ok) {
                    setProg(100, '完成');
                    hint('✅ 完成：' + ev.output + '（' + Math.round((ev.size || 0) / 1024 / 1024) + ' MB，用时 ' + ev.elapsed + 's）', 'ok');
                    log('✅ 完成，用时 ' + ev.elapsed + 's');
                    if (onDone) onDone(null, ev.output);
                } else {
                    setProg(null, '');
                    hint('❌ 失败：' + (ev.error || ('退出码 ' + ev.returncode)), 'err');
                    log('❌ 失败，退出码 ' + ev.returncode, 'err');
                    (ev.tail || []).forEach(function (x) { log('  ' + x, 'err'); });
                    if (onDone) onDone(new Error(ev.error || '失败'));
                }
            }
        });
        var btn = $('enLocalStop'); if (btn) btn.disabled = false;
    }

    // 选一个已导出的文件直接处理
    function pickAndRun() {
        if (running) { hint('已有任务在跑，请先停止', 'err'); return; }
        var dir = defaultOutDir();
        setLogVisible();
        window.__vhVSR.check(false, function (r) {
            if (!r || !r.ok) {
                hint('本地引擎未就绪，请先点「🔧 自检」', 'err');
                return;
            }
            // 用插件既有的目录选择器（__vhPickDir 若可用），否则退到输入框
            var start = dir;
            function afterPick(files) {
                if (!files || !files.length) { hint('已取消', ''); return; }
                var input = files[0];
                var base = path.basename(input).replace(/\.[^.]+$/, '');
                var out = path.join(dir, base + '_erased.mp4');
                try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
                runOne(input, out, function () {});
            }
            if (typeof window.__vhPickFiles === 'function') {
                window.__vhPickFiles(start, afterPick);
            } else if (typeof window.__vhPickDir === 'function') {
                // 没有文件选择器时，让用户选目录再手填——退到 prompt 简单可行
                var v = window.prompt('请输入要处理的视频完整路径：', start + '\\');
                if (v) afterPick([v]);
            } else {
                var v2 = window.prompt('请输入要处理的视频完整路径：', start + '\\');
                if (v2) afterPick([v2]);
            }
        });
    }

    // 从当前序列导出后处理
    function runFromSequence() {
        if (running) { hint('已有任务在跑，请先停止', 'err'); return; }
        if (typeof window.__vhEnhanceExportForLocal !== 'function') {
            hint('导出能力不可用：请先在面板上方导出序列，或用「📁 选文件…」直接处理', 'err');
            return;
        }
        window.__vhVSR.check(false, function (r) {
            if (!r || !r.ok) { hint('本地引擎未就绪，请先点「🔧 自检」', 'err'); return; }
            var dir = defaultOutDir();
            hint('正在导出当前序列（无字幕底版）…');
            setLogVisible();
            log('▶ 导出当前序列用于本地去字幕…');
            window.__vhEnhanceExportForLocal(function (err, file) {
                if (err || !file) {
                    hint('导出失败：' + ((err && err.message) || '未知'), 'err');
                    return;
                }
                var base = path.basename(file).replace(/\.[^.]+$/, '');
                var out = path.join(dir, base + '_erased.mp4');
                try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
                runOne(file, out, function () {});
            });
        });
    }

    function bind() {
        if (!$('enLocalCard')) return;      // 该面板不存在（A 版可能没有）
        var a = $('enLocalArea'); if (a) a.addEventListener('change', refreshAreaUI);
        var msel = $('enLocalMode'); if (msel) msel.addEventListener('change', refreshAreaUI);
        refreshAreaUI();

        var c = $('enLocalCheck'); if (c) c.addEventListener('click', doCheck);
        var g = $('enLocalGo'); if (g) g.addEventListener('click', runFromSequence);
        var p = $('enLocalPick'); if (p) p.addEventListener('click', pickAndRun);
        var s = $('enLocalStop');
        if (s) s.addEventListener('click', function () {
            if (running) {
                running.kill();
                running = null;
                s.disabled = true;
                setProg(null, '');
                hint('已停止', '');
                log('⏹ 用户停止', 'warn');
            }
        });

        // 打开面板时静默自检一次（不打扰）
        setTimeout(function () {
            window.__vhVSR.check(false, function (r) {
                if (r && r.ok) {
                    hint('本地引擎就绪' + (r.gpu ? (' · ' + r.gpu) : ''), '');
                } else {
                    hint('本地引擎未就绪，点「🔧 自检」查看原因', '');
                }
            });
        }, 1200);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
