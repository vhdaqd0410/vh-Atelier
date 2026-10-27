// vh-Atelier 本地处理面板公共模块
//
// 「本地去字幕」与「本地超分」两个面板高度同构（历史读写/输出目录/进度提示等），
// 此前各写一份，改一处要记得改两处。这里把真正共用的收拢，面板只传配置。
//
// 用法：
//   var loc = window.__vhLocal.mount({
//       prefix: 'ls',              // 元素 ID 前缀（ls* / lup*）
//       histFile: 'vsr_history.json',
//       dirKey: 'vh_vsr_outdir',
//       importBin: '去字幕',
//       presetAuto: '自动（有字幕版）',
//       presetPrefer: /有字幕|交片|成片/i,
//       histTip: '可直接把文件名拖到时间轴；也可点「导入」放进素材箱'
//   });
//   loc.hint(msg); loc.setProg(50); loc.renderHistory(); ...
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path, cp, os;
    try {
        fs = require('fs'); path = require('path'); cp = require('child_process'); os = require('os');
    } catch (e) { return; }

    var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;
    var HIST_MAX = 300;

    function mk(cfg) {
        cfg = cfg || {};
        var P = cfg.prefix || 'ls';
        var HIST_NAME = cfg.histFile || 'vsr_history.json';
        var DIR_KEY = cfg.dirKey || ('vh_' + P + '_outdir');
        var RESULT_DIR = cfg.resultDir || (P + '_results');
        var IMPORT_BIN = cfg.importBin || '字幕';
        var HIST_CACHE = null;

        function $(id) { return document.getElementById(id); }
        function E(suffix) { return $(P + suffix); }   // 元素按前缀取

        // ---------- 提示 / 日志 / 进度 ----------
        function hint(msg, cls) {
            var el = E(cfg.hintSuffix || 'HintLine');
            if (!el) el = E('Hint');
            if (!el) return;
            el.textContent = msg || '';
            el.className = 'en-act-hint' + (cls ? ' ' + cls : '');
        }
        function logEl() {
            return cfg.logId ? $(cfg.logId) : E('Log');
        }
        function log(msg, cls) {
            var el = logEl();
            if (!el) return;
            var line = document.createElement('div');
            line.className = 'en-log-line ' + (cls || '');
            line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
            el.appendChild(line);
            el.scrollTop = el.scrollHeight;
        }
        function clearLog() { var el = logEl(); if (el) el.innerHTML = ''; }
        function setProg(pct, text) {
            var w = E('ProgWrap');
            if (w) w.style.display = (pct === null) ? 'none' : '';
            if (pct !== null) {
                var f = E('ProgFill'); if (f) f.style.width = Math.max(0, Math.min(100, pct)) + '%';
                var p = E('ProgPct'); if (p) p.textContent = Math.round(pct) + '%';
            }
            if (text !== undefined) { var t = E('ProgText'); if (t) t.textContent = text; }
        }
        function setBusy(on, ids) {
            (ids || (cfg.busyIds || [])).forEach(function (id) {
                var b = $(id) || E(id); if (b) b.disabled = !!on;
            });
            var s = E('Stop'); if (s) s.disabled = !on;
        }

        // ---------- 扩展目录 / 输出目录 ----------
        function extRoot() {
            try { return csInterface.getSystemPath('extension'); } catch (e) { return ''; }
        }
        function getOutDir() {
            try { return localStorage.getItem(DIR_KEY) || ''; } catch (e) { return ''; }
        }
        function setOutDir(d) { try { localStorage.setItem(DIR_KEY, d || ''); } catch (e) {} }
        function defaultOutDir() {
            var saved = getOutDir();
            if (saved && fs.existsSync(saved)) return saved;
            var ext = extRoot();
            var d = ext ? path.join(ext, 'collect', RESULT_DIR)
                        : path.join(os.homedir(), 'vhAtelier_' + P);
            try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
            return d;
        }

        // ---------- 路径工具 ----------
        // 生成不覆盖的输出路径：目标已存在时依次 _2 / _3 …，绝不覆盖
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
        function revealFile(p) {
            try {
                if (fs.existsSync(p))
                    cp.exec('explorer /select,"' + String(p).replace(/\//g, '\\') + '"', { windowsHide: true });
                else
                    cp.exec('explorer "' + String(path.dirname(p)).replace(/\//g, '\\') + '"', { windowsHide: true });
            } catch (e) { hint('打开位置失败：' + e.message, 'err'); }
        }
        function openDir(d) {
            try { cp.exec('explorer "' + String(d).replace(/\//g, '\\') + '"', { windowsHide: true }); }
            catch (e) { hint('打开目录失败：' + e.message, 'err'); }
        }
        function openFile(p) {
            try { cp.exec('start "" "' + String(p).replace(/\//g, '\\') + '"'); } catch (e) {}
        }

        // ---------- 导入素材箱 ----------
        // 宿主各函数返回格式不统一（有的带 OK: 前缀），统一容错解析
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
                        JSON.stringify({ files: list, binName: binName || IMPORT_BIN }) + ';', function () {
                        csInterface.evalScript('meImportFilesToBinStr()', function (r) {
                            var d = parseHostJson(r);
                            resolve(d || { ok: false, error: String(r) });
                        });
                    });
                } catch (e) { resolve({ ok: false, error: e.message }); }
            });
        }
        // 导入并给统一提示
        function importResult(file, binName, onDone) {
            var bin = binName || IMPORT_BIN;
            if (!file) { if (onDone) onDone(); return; }
            log('📥 正在导入 PR 素材箱「' + bin + '」…');
            importToBin([file], bin).then(function (r) {
                if (r && r.ok && (r.imported || []).length) {
                    var names = (r.imported || []).join('、');
                    hint('✅ 已导入「' + bin + '」：' + names, 'ok');
                    log('📥 已导入素材箱「' + bin + '」：' + names, 'ok');
                    if ((r.failed || []).length) log('⚠ 部分未导入：' + r.failed.join('、'), 'warn');
                } else {
                    var why = (r && (r.error || (r.failed || []).join('、'))) || '未知原因';
                    hint('⚠ 导入素材箱失败：' + why + '（文件仍在：' + file + '）', 'warn');
                    log('⚠ 导入素材箱失败：' + why, 'warn');
                }
                if (onDone) onDone();
            });
        }

        // ---------- 预设下拉 ----------
        function fillPresets(sel) {
            sel = sel || E('Preset');
            if (!sel) return;
            var hits = [];
            try { if (typeof window.__vhListPresets === 'function') hits = window.__vhListPresets() || []; }
            catch (e) { hits = []; }
            var prev = sel.value;
            sel.innerHTML = '<option value="">' + (cfg.presetAuto || '自动') + '</option>';
            hits.forEach(function (h) {
                var o = document.createElement('option');
                o.value = h.full; o.textContent = h.name;
                sel.appendChild(o);
            });
            if (prev) { sel.value = prev; return; }
            var re = cfg.presetPrefer;
            if (re) {
                var prefer = hits.filter(function (h) { return re.test(h.name); });
                if (prefer.length) sel.value = prefer[0].full;
            }
        }

        // ---------- 历史记录 ----------
        function histFile() {
            var ext = extRoot();
            return ext ? path.join(ext, 'collect', HIST_NAME) : '';
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
        function saveHistory(arr) {
            var f = histFile();
            if (!f) return false;
            try {
                var d = path.dirname(f);
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                fs.writeFileSync(f, JSON.stringify((arr || []).slice(0, HIST_MAX), null, 2), 'utf8');
                return true;
            } catch (e) { return false; }
        }
        function addHistory(rec) {
            try {
                var a = loadHistory();
                a.unshift(rec);
                if (saveHistory(a)) renderHistory();
            } catch (e) {}
        }
        function delHistory(id) {
            if (saveHistory(loadHistory().filter(function (r) { return String(r.id) !== String(id); })))
                renderHistory();
        }
        function clearHistory() {
            if (!window.confirm('清空历史记录？（只清列表，不删除磁盘上的视频文件）')) return;
            if (saveHistory([])) { renderHistory(); hint('历史记录已清空', 'ok'); }
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
        // 面板可传 metaBits(rec) 定制元信息行
        function defaultMeta(r) {
            var bits = [];
            if (r.at) bits.push(String(r.at).replace('T', ' ').slice(0, 16));
            if (r.mode) bits.push(r.mode);
            if (r.model) bits.push(r.model);
            if (r.scale) bits.push(r.scale + 'x');
            if (r.outRes) bits.push(r.outRes);
            if (r.area) bits.push('区域 y' + r.area.y0 + '-' + r.area.y1);
            if (r.elapsed) bits.push(fmtDur(r.elapsed));
            if (r.size) bits.push(fmtSize(r.size));
            return bits;
        }
        function renderHistory(box, cntEl, tipEl) {
            box = box || E('HistList');
            if (!box) return;
            var arr = loadHistory();
            var cnt = cntEl || E('HistCount');
            var tip = tipEl || E('HistHint');
            if (cnt) cnt.textContent = arr.length ? ('共 ' + arr.length + ' 条') : '';
            if (tip) tip.textContent = arr.length ? (cfg.histTip || '') : '';
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
                var bits = (cfg.metaBits || defaultMeta)(r);
                meta.textContent = (bits || []).join(' · ');
                row.appendChild(meta);

                var ops = document.createElement('div');
                ops.className = 'ls-hist-ops';
                function mkBtn(label, title, fn, cls) {
                    var b = document.createElement('button');
                    b.className = 'secondary mini' + (cls ? ' ' + cls : '');
                    b.textContent = label; b.title = title || '';
                    b.addEventListener('click', fn);
                    return b;
                }
                ops.appendChild(mkBtn('⬆ 导入', '导入 PR「' + IMPORT_BIN + '」素材箱', function () {
                    if (!exists) { hint('文件已不在：' + r.out, 'err'); return; }
                    importToBin([r.out], IMPORT_BIN).then(function (res) {
                        if (res && res.ok && (res.imported || []).length)
                            hint('✅ 已导入素材箱：' + (res.imported || []).join('、'), 'ok');
                        else hint('⚠ 导入失败：' + ((res && (res.error || JSON.stringify(res))) || '未知'), 'warn');
                    });
                }));
                ops.appendChild(mkBtn('📂 位置', '在资源管理器里定位', function () { revealFile(r.out); }));
                ops.appendChild(mkBtn('▶ 打开', '用系统默认播放器打开', function () {
                    if (!exists) { hint('文件已不在', 'err'); return; }
                    openFile(r.out);
                }));
                ops.appendChild(mkBtn('✕', '从列表删除（不删文件）', function () { delHistory(r.id); }, 'ls-hist-del'));
                row.appendChild(ops);
                box.appendChild(row);
            });
        }

        var api = {
            // 元素/工具
            $: $, E: E,
            hint: hint, log: log, clearLog: clearLog, setProg: setProg, setBusy: setBusy,
            extRoot: extRoot, getOutDir: getOutDir, setOutDir: setOutDir, defaultOutDir: defaultOutDir,
            uniqueOutPath: uniqueOutPath, revealFile: revealFile, openDir: openDir, openFile: openFile,
            parseHostJson: parseHostJson, importToBin: importToBin, importResult: importResult,
            fillPresets: fillPresets,
            // 历史
            histFile: histFile, loadHistory: loadHistory, saveHistory: saveHistory,
            addHistory: addHistory, delHistory: delHistory, clearHistory: clearHistory,
            renderHistory: renderHistory, fmtSize: fmtSize, fmtDur: fmtDur,
            cfg: cfg
        };
        return api;
    }

    window.__vhLocal = { mount: mk };
})();
