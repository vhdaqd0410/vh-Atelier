// vh-Atelier 本地去字幕（VSR）面板逻辑（独立于「去字幕/超分（云端）」）
//
// 序列选择与区间读取复用 window.__vhClip（js/en-shared.js），
// 与云端面板保持同一套交互，避免两处各写一遍。
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path, cp, os;
    try {
        fs = require('fs'); path = require('path'); cp = require('child_process'); os = require('os');
    } catch (e) { return; }

    function $(id) { return document.getElementById(id); }
    var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;

    var running = null;      // 当前 VSR 任务句柄
    var clip = null;         // 公共模块实例
    var DIR_KEY = 'vh_vsr_outdir';

    // ---------- 小工具 ----------
    function hint(msg, cls) {
        var el = $('lsHint');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'en-act-hint' + (cls ? ' ' + cls : '');
    }
    function log(msg, cls) {
        try { if (window.__vhVSR) window.__vhVSR.log(msg, cls); } catch (e) {}
    }
    function setLogVisible() {
        var el = $('vLocalLog');
        if (el && el.style.display === 'none') el.style.display = '';
    }
    function setProg(pct, text) {
        var w = $('lsProgWrap');
        if (w) w.style.display = (pct === null) ? 'none' : '';
        if (pct !== null) {
            var f = $('lsProgFill'); if (f) f.style.width = Math.max(0, Math.min(100, pct)) + '%';
            var p = $('lsProgPct'); if (p) p.textContent = Math.round(pct) + '%';
        }
        if (text !== undefined) { var t = $('lsProgText'); if (t) t.textContent = text; }
    }
    function setBusy(on) {
        ['lsGoSeq', 'lsGoClip', 'lsPick'].forEach(function (id) {
            var b = $(id); if (b) b.disabled = !!on;
        });
        var s = $('lsStop'); if (s) s.disabled = !on;
    }
    function getOutDir() {
        try { return localStorage.getItem(DIR_KEY) || ''; } catch (e) { return ''; }
    }
    function setOutDir(d) { try { localStorage.setItem(DIR_KEY, d || ''); } catch (e) {} }
    function defaultOutDir() {
        var saved = getOutDir();
        if (saved && fs.existsSync(saved)) return saved;
        var ext = '';
        try { ext = csInterface.getSystemPath('extension'); } catch (e) {}
        var d = ext ? path.join(ext, 'collect', 'vsr_results') : path.join(os.homedir(), 'vhAtelier_vsr');
        try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
        return d;
    }

    // ---------- 字幕区域 ----------
    function currentArea() {
        var mode = (($('lsArea') || {}).value) || 'preset-bottom';
        function num(id, def) {
            var v = parseFloat((($(id) || {}).value) || '');
            return isFinite(v) ? v : def;
        }
        if (mode === 'manual') {
            return [[num('lsY0', 0.78), num('lsY1', 1), num('lsX0', 0), num('lsX1', 1)]];
        }
        if (mode === 'auto') {
            // 「自动检测」仍给一个偏底部的搜索范围：比全屏检测快得多也更准
            return [[0.62, 1.0, 0.0, 1.0]];
        }
        return [[0.78, 1.0, 0.0, 1.0]];   // 竖屏短剧/漫剧字幕带
    }

    function refreshAreaUI() {
        var mode = (($('lsArea') || {}).value) || 'preset-bottom';
        var row = $('lsAreaRow');
        if (row) row.style.display = (mode === 'manual') ? '' : 'none';
        var h = $('lsAreaHint');
        if (h) {
            h.textContent = (mode === 'auto')
                ? '在偏底部范围内用 OCR 自动找字幕位置（需配合 STTN 检测 / LaMa 等会检测的算法）'
                : (mode === 'manual')
                    ? '自定义区域（相对比例 0–1）：y 为纵向、x 为横向'
                    : '默认覆盖底部 22%（竖屏短剧/漫剧的字幕带），最稳最快';
        }
        var algo = (($('lsMode') || {}).value) || 'sttn-auto';
        var box = $('lsAlgoWarn');
        if (box) {
            var msg = '';
            if (algo === 'sttn-auto' && mode === 'auto') {
                msg = 'STTN 直绘不做字幕识别，「区域内自动检测」对它无效：' +
                      '请改选 STTN 检测 / LaMa，或把区域改为底部固定区。';
            }
            box.textContent = msg;
            box.style.display = msg ? '' : 'none';
        }
    }

    // ---------- 自检 ----------
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
            }
        });
    }

    // ---------- 单次处理 ----------
    function runOne(input, output, onDone) {
        var opts = {
            input: input,
            output: output,
            area: currentArea(),
            mode: (($('lsMode') || {}).value) || 'sttn-auto'
        };
        hint('正在处理：' + path.basename(input) + '（' + opts.mode + '）…');
        setProg(0, '准备中…');
        setLogVisible();
        log('▶ 输入：' + input);
        log('  算法：' + opts.mode + '  区域：' + (opts.area.length ? JSON.stringify(opts.area) : '全片自动'));
        setBusy(true);
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
                running = null;
                setBusy(false);
                if (ev.ok) {
                    setProg(100, '完成');
                    hint('✅ 完成：' + ev.output + '（' + Math.round((ev.size || 0) / 1024 / 1024) +
                         ' MB，用时 ' + ev.elapsed + 's）', 'ok');
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
    }

    // ---------- 入口 1：处理勾选序列（整条） ----------
    function runSequences() {
        if (running) { hint('已有任务在跑，请先停止', 'err'); return; }
        var seqs = clip ? clip.getCheckedSeqs() : [];
        if (!seqs.length) { hint('请先在上方勾选要处理的序列', 'err'); return; }
        window.__vhVSR.check(false, function (r) {
            if (!r || !r.ok) { hint('本地引擎未就绪，请先点「🔧 自检」', 'err'); return; }
            var dir = defaultOutDir();
            setBusy(true);
            setLogVisible();
            log('▶ 待处理 ' + seqs.length + ' 个序列：' + seqs.join('、'));
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
                    setBusy(false);
                    hint('导出能力不可用：请改用「📁 选文件…」直接处理已有视频', 'err');
                    return;
                }
                // 复用导出能力：支持传序列名
                window.__vhEnhanceExportForLocal(function (err, file) {
                    if (err || !file) {
                        log('✗ [' + name + '] 导出失败：' + ((err && err.message) || '未知'), 'err');
                        next();
                        return;
                    }
                    var base = path.basename(file).replace(/\.[^.]+$/, '');
                    var out = path.join(dir, base + '_erased.mp4');
                    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
                    runOne(file, out, function () { next(); });
                }, name);
            }
            next();
        });
    }

    // ---------- 入口 2：处理选中区间 ----------
    function runClip() {
        if (running) { hint('已有任务在跑，请先停止', 'err'); return; }
        window.__vhVSR.check(false, function (r) {
            if (!r || !r.ok) { hint('本地引擎未就绪，请先点「🔧 自检」', 'err'); return; }
            // 现场重读区间，避免用上次的旧值
            clip.grab(true).then(function (info) {
                if (!info) {
                    hint('读不到区间：' + (clip.srcMode() === 'inout'
                        ? '请先在时间轴按 I / O 设好入出点'
                        : '请先在时间轴选中片段'), 'err');
                    return;
                }
                var c = clip.normalized();
                var dir = defaultOutDir();
                setLogVisible();
                log('════ 开始处理区间（' + (c.src === 'inout' ? '入点→出点' : '选中片段') + '） ════');
                log('✂ ' + c.seqName + ' ｜ ' + clip.fmtSec(c.startSec) + ' → ' + clip.fmtSec(c.endSec) +
                    '（' + clip.fmtSec(c.durationSec) + '）');
                if (typeof window.__vhEnhanceExportForLocal !== 'function') {
                    hint('导出能力不可用：请改用「📁 选文件…」直接处理已有视频', 'err');
                    return;
                }
                var preset = (($('lsPreset') || {}).value) || '';
                window.__vhEnhanceExportForLocal(function (err, file) {
                    if (err || !file) { hint('区间导出失败：' + ((err && err.message) || '未知'), 'err'); return; }
                    var base = path.basename(file).replace(/\.[^.]+$/, '');
                    var out = path.join(dir, base + '_erased.mp4');
                    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
                    runOne(file, out, function () {});
                }, c.seqName, { startSec: c.startSec, endSec: c.endSec, preset: preset });
            });
        });
    }

    // ---------- 入口 3：直接选文件 ----------
    function pickAndRun() {
        if (running) { hint('已有任务在跑，请先停止', 'err'); return; }
        var dir = defaultOutDir();
        setLogVisible();
        window.__vhVSR.check(false, function (r) {
            if (!r || !r.ok) { hint('本地引擎未就绪，请先点「🔧 自检」', 'err'); return; }
            var v = window.prompt('请输入要处理的视频完整路径：', dir + '\\');
            if (!v) { hint('已取消', ''); return; }
            var base = path.basename(v).replace(/\.[^.]+$/, '');
            runOne(v, path.join(dir, base + '_erased.mp4'), function () {});
        });
    }

    // ---------- 初始化 ----------
    function bind() {
        if (!$('panel-localsub')) return;

        // 公共模块：序列 + 区间
        if (window.__vhClip) {
            clip = window.__vhClip.mount({
                seqListId: 'lsSeqList',
                refreshBtnId: 'lsRefSeq',
                grabBtnId: 'lsGrabClip',
                clipInfoId: 'lsClipInfo',
                srcSelectId: 'lsClipSrc',
                onLog: function (m, c) { log(m, c); }
            });
        } else {
            log('公共模块 en-shared.js 未加载，序列与区间功能不可用', 'err');
        }

        var a = $('lsArea'); if (a) a.addEventListener('change', refreshAreaUI);
        var m = $('lsMode'); if (m) m.addEventListener('change', refreshAreaUI);
        refreshAreaUI();

        var ck = $('lsCheck'); if (ck) ck.addEventListener('click', doCheck);
        var g1 = $('lsGoSeq'); if (g1) g1.addEventListener('click', runSequences);
        var g2 = $('lsGoClip'); if (g2) g2.addEventListener('click', runClip);
        var pk = $('lsPick'); if (pk) pk.addEventListener('click', pickAndRun);
        var st = $('lsStop');
        if (st) st.addEventListener('click', function () {
            if (running) {
                running.kill();
                running = null;
                setBusy(false);
                setProg(null, '');
                hint('已停止', '');
                log('⏹ 用户停止', 'warn');
            }
        });

        // 首次进入静默自检
        setTimeout(function () {
            window.__vhVSR.check(false, function (r) {
                hint(r && r.ok ? ('本地引擎就绪' + (r.gpu ? (' · ' + r.gpu) : ''))
                               : '本地引擎未就绪，点「🔧 自检」查看原因', '');
            });
        }, 1200);
    }

    // 切到本 tab 时：拉一次序列（用户不用手动刷新）
    window.__localsubOnShow = function () {
        try {
            if (clip && clip.getCheckedSeqs().length === 0) clip.refreshSeqs(true);
        } catch (e) {}
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
