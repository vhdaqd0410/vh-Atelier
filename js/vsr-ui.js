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
        if (mode === 'pick') {
            // 框选：用已应用的比例；没框过则退回底部固定区（并提示）
            if (picked) return [[picked.y0, picked.y1, picked.x0, picked.x1]];
            return [[0.78, 1.0, 0.0, 1.0]];
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
        var mode = (($('lsArea') || {}).value) || 'pick';
        var row = $('lsAreaRow');
        if (row) row.style.display = (mode === 'manual') ? '' : 'none';
        // 框选区默认折叠：这里只控制「折叠按钮 + 徽标」那一行是否出现；
        // 真正的画布由 setPickOpen 控制展开状态。
        var pr = $('lsPickRow');
        var tog = $('lsPickToggle');
        if (tog) tog.parentNode.style.display = (mode === 'pick') ? '' : 'none';
        var apRow = $('lsAreaPresetRow');
        if (apRow) apRow.style.display = (mode === 'pick' || mode === 'manual') ? '' : 'none';
        if (mode !== 'pick' && pr) pr.style.display = 'none';
        var h = $('lsAreaHint');
        if (h) {
            h.textContent = (mode === 'pick')
                ? '展开截帧框选 → 拖框圈住字幕 → 用这块区域；位置固定可「存位置」以后一键调用'
                : (mode === 'auto')
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




    // ==================== 历史记录 ====================
    // 存 collect/：与区域预设同策略，升级不丢、拷到别的电脑也能带走。
    // 记录的是「本地产出」——视频就在磁盘上，所以除了导入素材箱，
    // 还能直接拖进时间轴 / 在资源管理器里定位。
    var HIST_FILE = '';
    var HIST_MAX = 300;      // 最多保留条数，防无限增长
    function histFile() {
        if (HIST_FILE) return HIST_FILE;
        var ext = '';
        try { ext = csInterface.getSystemPath('extension'); } catch (e) {}
        HIST_FILE = ext ? path.join(ext, 'collect', 'vsr_history.json') : '';
        return HIST_FILE;
    }
    function loadHistory() {
        var f = histFile();
        if (!f) return [];
        try {
            if (!fs.existsSync(f)) return [];
            var arr = JSON.parse(fs.readFileSync(f, 'utf8'));
            return Array.isArray(arr) ? arr : [];
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
    // 处理完成后追加一条
    function addHistory(rec) {
        try {
            var arr = loadHistory();
            arr.unshift(rec);
            if (arr.length > HIST_MAX) arr = arr.slice(0, HIST_MAX);
            if (saveHistory(arr)) { renderHistory(); }
        } catch (e) {}
    }
    function delHistory(id) {
        var arr = loadHistory().filter(function (r) { return String(r.id) !== String(id); });
        if (saveHistory(arr)) renderHistory();
    }
    function clearHistory() {
        if (!window.confirm('清空历史记录？（只清列表，不删除磁盘上的视频文件）')) return;
        if (saveHistory([])) { renderHistory(); hint('历史记录已清空', 'ok'); }
    }

    function fmtSize2(n) {
        n = Number(n) || 0;
        if (n <= 0) return '';
        if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
        return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }
    function fmtDur2(s) {
        s = Math.round(Number(s) || 0);
        var m = Math.floor(s / 60);
        return m > 0 ? (m + '分' + (s % 60) + '秒') : (s + '秒');
    }

    // 在资源管理器里打开一个目录（Win）
    function openDir(d) {
        try {
            var cp = require('child_process');
            cp.exec('explorer "' + String(d).replace(/\//g, '\\') + '"', { windowsHide: true });
        } catch (e) { hint('打开目录失败：' + e.message, 'err'); }
    }

    // 在资源管理器里定位文件（Win）
    function revealFile(p) {
        try {
            var cp = require('child_process');
            if (fs.existsSync(p)) cp.exec('explorer /select,"' + String(p).replace(/\//g, '\\') + '"', { windowsHide: true });
            else cp.exec('explorer "' + String(path.dirname(p)).replace(/\//g, '\\') + '"', { windowsHide: true });
        } catch (e) { hint('打开位置失败：' + e.message, 'err'); }
    }

    function renderHistory() {
        var box = $('lsHistList');
        if (!box) return;
        var arr = loadHistory();
        var cnt = $('lsHistCount');
        var hintEl = $('lsHistHint');
        if (cnt) cnt.textContent = arr.length ? ('共 ' + arr.length + ' 条') : '';
        if (hintEl) {
            hintEl.textContent = arr.length
                ? '可直接把文件名拖到时间轴；也可点「导入」放进素材箱'
                : '';
        }
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

            // 主行：文件名（可拖）+ 状态
            var main = document.createElement('div');
            main.className = 'ls-hist-main';
            var nm = document.createElement('span');
            nm.className = 'ls-hist-name';
            nm.textContent = path.basename(r.out || '(未知)');
            nm.title = r.out || '';
            // 拖拽到时间轴：PR 认 com.adobe.cep.dnd.file.N
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
                var miss = document.createElement('span');
                miss.className = 'ls-hist-miss';
                miss.textContent = '文件已不在';
                main.appendChild(miss);
            }
            row.appendChild(main);

            // 次行：时间 / 算法 / 区域 / 耗时 / 大小
            var meta = document.createElement('div');
            meta.className = 'ls-hist-meta';
            var bits = [];
            if (r.at) bits.push(String(r.at).replace('T', ' ').slice(0, 16));
            if (r.mode) bits.push(r.mode);
            if (r.area) bits.push('区域 y' + r.area.y0 + '-' + r.area.y1);
            if (r.elapsed) bits.push(fmtDur2(r.elapsed));
            if (r.size) bits.push(fmtSize2(r.size));
            meta.textContent = bits.join(' · ');
            row.appendChild(meta);

            // 操作行
            var ops = document.createElement('div');
            ops.className = 'ls-hist-ops';
            function mkBtn(label, title, fn, cls) {
                var b = document.createElement('button');
                b.className = 'secondary mini' + (cls ? ' ' + cls : '');
                b.textContent = label;
                b.title = title || '';
                b.addEventListener('click', fn);
                return b;
            }
            ops.appendChild(mkBtn('⬆ 导入', '导入 PR「去字幕」素材箱', function () {
                if (!exists) { hint('文件已不在：' + r.out, 'err'); return; }
                log('📥 正在导入素材箱「去字幕」…');
                importToBin([r.out], '去字幕').then(function (res) {
                    if (res && res.ok && (res.imported || []).length)
                        hint('✅ 已导入素材箱：' + (res.imported || []).join('、'), 'ok');
                    else hint('⚠ 导入失败：' + ((res && (res.error || JSON.stringify(res))) || '未知'), 'warn');
                });
            }));
            ops.appendChild(mkBtn('📂 位置', '在资源管理器里定位', function () {
                revealFile(r.out);
            }));
            ops.appendChild(mkBtn('▶ 打开', '用系统默认播放器打开', function () {
                if (!exists) { hint('文件已不在', 'err'); return; }
                try { require('child_process').exec('start "" "' + String(r.out).replace(/\//g, '\\') + '"'); } catch (e) {}
            }));
            ops.appendChild(mkBtn('✕', '从列表删除（不删文件）', function () {
                delHistory(r.id);
            }, 'ls-hist-del'));
            row.appendChild(ops);

            box.appendChild(row);
        });
    }

    // 卡片最大化：历史 / 日志 各占满面板（复用超分面板那套 class）
    var LOCAL_EXP_KEY = 'vh_vsr_card_exp';   // '' | 'hist' | 'log'
    function setLocalCardExpanded(which, save) {
        var panel = $('panel-localsub');
        if (!panel) return;
        panel.classList.remove('en-exp-hist');
        panel.classList.remove('en-exp-log');
        var hx = $('lsHistExpand'), lx = $('lsLogExpand');
        [hx, lx].forEach(function (b) { if (b) { b.textContent = '⤢'; b.title = '展开：占满面板（再点还原）'; } });
        if (!which) {
            if (save) { try { localStorage.setItem(LOCAL_EXP_KEY, ''); } catch (e) {} }
            return;
        }
        panel.classList.add('en-exp-' + which);
        var btn = (which === 'hist') ? hx : lx;
        if (btn) { btn.textContent = '⤡'; btn.title = '还原：恢复布局'; }
        if (save) { try { localStorage.setItem(LOCAL_EXP_KEY, which); } catch (e) {} }
    }
    function toggleLocalCard(which) {
        var panel = $('panel-localsub');
        if (!panel) return;
        var on = panel.classList.contains('en-exp-' + which);
        setLocalCardExpanded(on ? '' : which, true);
    }

    // ==================== 字幕区域预设 ====================
    // 存到 collect/：该目录被 sync-to-pr 与在线更新器双重排除，
    // 升级不会覆盖；拷到别的电脑也能一起带走（字幕位置一般全剧通用）。
    var PRESET_FILE = '';
    function presetFile() {
        if (PRESET_FILE) return PRESET_FILE;
        var ext = '';
        try { ext = csInterface.getSystemPath('extension'); } catch (e) {}
        PRESET_FILE = ext ? path.join(ext, 'collect', 'vsr_area_presets.json') : '';
        return PRESET_FILE;
    }
    function loadAreaPresets() {
        var f = presetFile();
        if (!f) return [];
        try {
            if (!fs.existsSync(f)) return [];
            var arr = JSON.parse(fs.readFileSync(f, 'utf8'));
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function saveAreaPresets(arr) {
        var f = presetFile();
        if (!f) return false;
        try {
            var d = path.dirname(f);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(f, JSON.stringify(arr || [], null, 2), 'utf8');
            return true;
        } catch (e) { return false; }
    }

    // 把预设列表渲染进下拉
    function renderAreaPresets(keepId) {
        var sel = $('lsAreaPreset');
        if (!sel) return;
        var arr = loadAreaPresets();
        var cur = keepId || sel.value || '';
        sel.innerHTML = '';
        var o0 = document.createElement('option');
        o0.value = ''; o0.textContent = arr.length ? '（未选预设）' : '（还没有预设，先框选再「存位置」）';
        sel.appendChild(o0);
        arr.forEach(function (p) {
            var o = document.createElement('option');
            o.value = String(p.id || p.name);
            o.textContent = p.name + '　y ' + p.y0 + '–' + p.y1 + ' · x ' + p.x0 + '–' + p.x1;
            sel.appendChild(o);
        });
        if (cur) { try { sel.value = cur; } catch (e) {} }
    }

    // 应用某个预设到 picked
    function applyAreaPreset(id) {
        var arr = loadAreaPresets();
        for (var i = 0; i < arr.length; i++) {
            if (String(arr[i].id || arr[i].name) === String(id)) {
                var p = arr[i];
                picked = { y0: p.y0, y1: p.y1, x0: p.x0, x1: p.x1 };
                updateAppliedBadge();
                hint('✅ 已套用区域预设「' + p.name + '」', 'ok');
                log('🎯 套用区域预设「' + p.name + '」: y ' + p.y0 + '–' + p.y1 +
                    '  x ' + p.x0 + '–' + p.x1);
                return p;
            }
        }
        return null;
    }

    // 存当前框选（或当前比例）为预设
    function saveCurrentAreaAsPreset() {
        var r = picked;
        // 没框过就用框选画布上的当前框；再没有就用下拉的自定义比例
        if (!r) r = boxToRatio();
        if (!r) {
            var mode = (($('lsArea') || {}).value) || 'pick';
            if (mode === 'manual') {
                r = { y0: num('lsY0', 0.78), y1: num('lsY1', 1), x0: num('lsX0', 0), x1: num('lsX1', 1) };
            }
        }
        if (!r) { hint('请先在图上框出字幕区域（或展开截帧框选），再存预设', 'err'); return; }
        var name = window.prompt('给这个区域起个名字（以后所有剧都能直接用）：', '字幕区');
        if (!name) { hint('已取消', ''); return; }
        var arr = loadAreaPresets();
        // 同名覆盖，避免堆积
        var id = 'a' + Date.now();
        arr = arr.filter(function (p) { return p.name !== name; });
        arr.push({ id: id, name: name, y0: r.y0, y1: r.y1, x0: r.x0, x1: r.x1,
                   savedAt: new Date().toISOString().slice(0, 10) });
        if (saveAreaPresets(arr)) {
            picked = { y0: r.y0, y1: r.y1, x0: r.x0, x1: r.x1 };
            renderAreaPresets(id);
            updateAppliedBadge();
            hint('✅ 已存为预设「' + name + '」：y ' + r.y0 + '–' + r.y1 + ' · x ' + r.x0 + '–' + r.x1, 'ok');
            log('💾 已存区域预设「' + name + '」');
        } else {
            hint('存预设失败（collect 目录不可写？）', 'err');
        }
    }

    function deleteCurrentAreaPreset() {
        var sel = $('lsAreaPreset');
        var id = sel ? sel.value : '';
        if (!id) { hint('请先在下拉里选中要删除的预设', 'err'); return; }
        var arr = loadAreaPresets();
        var hit = arr.filter(function (p) { return String(p.id || p.name) === String(id); })[0];
        if (!hit) { hint('找不到该预设', 'err'); return; }
        if (!window.confirm('删除预设「' + hit.name + '」？')) return;
        arr = arr.filter(function (p) { return String(p.id || p.name) !== String(id); });
        if (saveAreaPresets(arr)) {
            renderAreaPresets('');
            hint('已删除预设「' + hit.name + '」', 'ok');
        } else hint('删除失败', 'err');
    }

    // 已应用区域的小徽标（折叠时也能看到当前生效的区域）
    function updateAppliedBadge() {
        var el = $('lsAppliedBadge');
        if (!el) return;
        if (!picked) { el.textContent = ''; return; }
        el.textContent = '当前区域：y ' + picked.y0 + '–' + picked.y1 + ' · x ' + picked.x0 + '–' + picked.x1;
    }

    // 折叠/展开截帧框选区（记住用户选择）
    var PICK_OPEN_KEY = 'vh_vsr_pick_open';
    function setPickOpen(open) {
        var row = $('lsPickRow');
        var btn = $('lsPickToggle');
        if (row) row.style.display = open ? '' : 'none';
        if (btn) btn.textContent = (open ? '▾ 收起截帧框选' : '▸ 展开截帧框选');
        try { localStorage.setItem(PICK_OPEN_KEY, open ? '1' : '0'); } catch (e) {}
        // 展开后 stage 才有尺寸；若之前是收起状态，默认框会摆错，这里重摆一次
        if (open) {
            setTimeout(function () {
                var stage = $('lsPickStage');
                var box = $('lsPickBox');
                if (!stage || !box || !box.classList.contains('on')) return;
                if (stage.clientHeight > 0 && (!pickBox || pickBox.h < 12)) {
                    setBox(Math.round(stage.clientWidth * 0.02), Math.round(stage.clientHeight * 0.78),
                           Math.round(stage.clientWidth * 0.96), Math.round(stage.clientHeight * 0.20));
                    updateReadout();
                }
            }, 30);
        }
    }
    function pickOpenSaved() {
        try { return localStorage.getItem(PICK_OPEN_KEY) === '1'; } catch (e) { return false; }
    }

    // ==================== 截帧框选 ====================
    var picked = null;        // {y0,y1,x0,x1} 相对比例（已应用的框选区域）
    var pickImgSize = null;   // {w,h} 图片像素尺寸
    var pickBox = null;       // {x,y,w,h} 当前框在显示坐标（相对 stage）的像素

    // 读本地图片为 data URL（CEP 里 file:// 受限，base64 最稳）
    function readImgDataUrl(p) {
        try {
            var buf = fs.readFileSync(p);
            var ext = String(p).toLowerCase();
            var mime = /\.jpe?g$/.test(ext) ? 'image/jpeg'
                     : (/\.webp$/.test(ext) ? 'image/webp' : 'image/png');
            return 'data:' + mime + ';base64,' + buf.toString('base64');
        } catch (e) { return ''; }
    }

    function showPickWrap(on) {
        var w = $('lsPickWrap');
        if (w) w.style.display = on ? '' : 'none';
    }

    // 把图片放到 stage 上，按容器宽度等比显示
    function loadPickImage(dataUrl, natW, natH) {
        var img = $('lsPickImg');
        if (!img) return;
        img.onload = function () {
            pickImgSize = { w: img.naturalWidth || natW || 0, h: img.naturalHeight || natH || 0 };
            var d = $('lsPickDim');
            if (d) d.textContent = pickImgSize.w ? (pickImgSize.w + '×' + pickImgSize.h) : '';
            showPickWrap(true);
            // 等布局落定再量 stage（stage 贴合图片，限高后尺寸会变）
            setTimeout(function () {
                var stage = $('lsPickStage');
                if (stage) {
                    var sw = stage.clientWidth || 300, sh = stage.clientHeight || 300;
                    setBox(Math.round(sw * 0.02), Math.round(sh * 0.78),
                           Math.round(sw * 0.96), Math.round(sh * 0.20));
                }
                updateReadout();
            }, 30);
        };
        img.src = dataUrl;
    }

    // 设置框（显示坐标）
    function setBox(x, y, w, h) {
        var stage = $('lsPickStage');
        if (stage) {
            var sw = stage.clientWidth, sh = stage.clientHeight;
            if (w < 8) w = 8; if (h < 8) h = 8;
            if (x < 0) x = 0; if (y < 0) y = 0;
            if (x + w > sw) w = sw - x;
            if (y + h > sh) h = sh - y;
        }
        pickBox = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
        var b = $('lsPickBox');
        if (b) {
            b.classList.add('on');
            b.style.left = pickBox.x + 'px';
            b.style.top = pickBox.y + 'px';
            b.style.width = pickBox.w + 'px';
            b.style.height = pickBox.h + 'px';
        }
    }

    // 显示坐标 → 相对比例
    function boxToRatio() {
        var stage = $('lsPickStage');
        if (!stage || !pickBox) return null;
        var sw = stage.clientWidth || 1, sh = stage.clientHeight || 1;
        function cl(v, max) { return Math.max(0, Math.min(1, v / max)); }
        var x0 = cl(pickBox.x, sw), x1 = cl(pickBox.x + pickBox.w, sw);
        var y0 = cl(pickBox.y, sh), y1 = cl(pickBox.y + pickBox.h, sh);
        if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
        return {
            y0: Math.round(y0 * 1000) / 1000, y1: Math.round(y1 * 1000) / 1000,
            x0: Math.round(x0 * 1000) / 1000, x1: Math.round(x1 * 1000) / 1000
        };
    }

    function updateReadout() {
        var r = boxToRatio();
        var el = $('lsPickRead');
        if (!el) return;
        if (!r) { el.textContent = '框太小了，拖大一点'; el.style.color = '#ffb84d'; return; }
        el.style.color = '#7fd68b';
        var px = '';
        if (pickImgSize) {
            px = '  像素 y ' + Math.round(r.y0 * pickImgSize.h) + '–' + Math.round(r.y1 * pickImgSize.h) +
                 ' · x ' + Math.round(r.x0 * pickImgSize.w) + '–' + Math.round(r.x1 * pickImgSize.w);
        }
        el.textContent = 'y ' + r.y0 + '–' + r.y1 + ' · x ' + r.x0 + '–' + r.x1 + px;
    }

    // 拖拽画框 / 移动 / 缩放
    function bindPickDrag() {
        var stage = $('lsPickStage'), box = $('lsPickBox');
        if (!stage || !box) return;

        var drag = null;   // {mode:'new'|'move'|'resize', handle, sx,sy, orig}

        function localPt(ev) {
            var r = stage.getBoundingClientRect();
            var p = (ev.touches && ev.touches[0]) ? ev.touches[0] : ev;
            return { x: p.clientX - r.left, y: p.clientY - r.top };
        }
        function start(mode, ev, handle) {
            ev.preventDefault();
            var p = localPt(ev);
            drag = { mode: mode, handle: handle, sx: p.x, sy: p.y,
                     orig: pickBox ? { x: pickBox.x, y: pickBox.y, w: pickBox.w, h: pickBox.h } : null };
            if (mode === 'new') setBox(p.x, p.y, 8, 8);
        }
        function move(ev) {
            if (!drag) return;
            ev.preventDefault();
            var p = localPt(ev);
            var dx = p.x - drag.sx, dy = p.y - drag.sy;
            if (drag.mode === 'new') {
                var x = Math.min(drag.sx, p.x), y = Math.min(drag.sy, p.y);
                setBox(x, y, Math.abs(p.x - drag.sx), Math.abs(p.y - drag.sy));
            } else if (drag.mode === 'move' && drag.orig) {
                setBox(drag.orig.x + dx, drag.orig.y + dy, drag.orig.w, drag.orig.h);
            } else if (drag.mode === 'resize' && drag.orig) {
                var o = drag.orig, x2 = o.x + o.w, y2 = o.y + o.h;
                var h = drag.handle;
                if (h === 'nw') { setBox(o.x + dx, o.y + dy, o.w - dx, o.h - dy); }
                else if (h === 'ne') { setBox(o.x, o.y + dy, o.w + dx, o.h - dy); }
                else if (h === 'sw') { setBox(o.x + dx, o.y, o.w - dx, o.h + dy); }
                else if (h === 'se') { setBox(o.x, o.y, o.w + dx, o.h + dy); }
            }
            updateReadout();
        }
        function end() { if (drag) { drag = null; updateReadout(); } }

        stage.addEventListener('mousedown', function (ev) {
            if (ev.target === box || (ev.target.classList && ev.target.classList.contains('ls-ph'))) return;
            start('new', ev);
        });
        box.addEventListener('mousedown', function (ev) {
            if (ev.target.classList && ev.target.classList.contains('ls-ph')) {
                start('resize', ev, ev.target.getAttribute('data-h'));
            } else {
                start('move', ev);
            }
        });
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', end);
        stage.addEventListener('touchstart', function (ev) {
            if (ev.target === box || (ev.target.classList && ev.target.classList.contains('ls-ph'))) return;
            start('new', ev);
        }, { passive: false });
        box.addEventListener('touchstart', function (ev) {
            if (ev.target.classList && ev.target.classList.contains('ls-ph')) {
                start('resize', ev, ev.target.getAttribute('data-h'));
            } else { start('move', ev); }
        }, { passive: false });
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', end);
    }

    // 截当前节目窗口帧（或给定序列/秒数）
    function grabFrame(seqId, seconds) {
        if (!csInterface) { hint('截帧需要在 PR 内运行', 'err'); return; }
        var dir = defaultOutDir();
        try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
        var stamp = 'frame_' + Date.now();
        var noExt = path.join(dir, stamp);
        hint('正在截取当前帧…');
        csInterface.evalScript(
            'lsGrabFrameStr(' + JSON.stringify(seqId || '') + ',' +
            JSON.stringify(seconds === undefined ? '' : seconds) + ',' +
            JSON.stringify(noExt) + ')',
            function (r) {
                var res = null;
                try { res = JSON.parse(r); } catch (e) {}
                if (!res || res.error || !res.path) {
                    hint('❌ 截帧失败：' + ((res && res.error) || r || '未知'), 'err');
                    return;
                }
                var dataUrl = readImgDataUrl(res.path);
                if (!dataUrl) { hint('❌ 截帧成功但读取失败：' + res.path, 'err'); return; }
                // 缓存原图路径，便于清理
                lastFramePath = res.path;
                loadPickImage(dataUrl, res.width, res.height);
                hint('✅ 已截取当前帧，在下方图上拖动框住字幕', 'ok');
                log('📷 截帧：' + res.path + (res.width ? ('（' + res.width + '×' + res.height + '）') : ''));
                // 记住了这一帧对应的时间，处理区间时可直接沿用
                try { $('lsPickDim').setAttribute('data-seconds', String(res.seconds)); } catch (e) {}
            });
    }

    var lastFramePath = '';

    // 同步抓取当前帧（供三条入口在需要时自动截帧）
    function grabFrameAsync(seqId, seconds) {
        return new Promise(function (resolve) {
            if (!csInterface) { resolve(null); return; }
            var dir = defaultOutDir();
            try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
            var noExt = path.join(dir, 'frame_' + Date.now());
            csInterface.evalScript(
                'lsGrabFrameStr(' + JSON.stringify(seqId || '') + ',' +
                JSON.stringify(seconds === undefined ? '' : seconds) + ',' +
                JSON.stringify(noExt) + ')',
                function (r) {
                    var res = null;
                    try { res = JSON.parse(r); } catch (e) {}
                    if (res && res.path && fs.existsSync(res.path)) {
                        lastFramePath = res.path;
                        resolve(res);
                    } else resolve(null);
                });
        });
    }


    // 生成不覆盖的输出路径：目标已存在时依次尝试 _2 / _3 …（绝不覆盖上一次结果）
    function uniqueOutPath(dir, baseName, ext) {
        ext = ext || '.mp4';
        var cand = path.join(dir, baseName + ext);
        if (!fs.existsSync(cand)) return cand;
        for (var n = 2; n <= 999; n++) {
            cand = path.join(dir, baseName + '_' + n + ext);
            if (!fs.existsSync(cand)) return cand;
        }
        // 极端情况（999 个同名）：退到时间戳，保证唯一
        var ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        return path.join(dir, baseName + '_' + ts + ext);
    }

    // 由中间导出文件推导「干净、可读」的输出基名
    // 中间名形如 <序列名>_nosub_full.mp4 / <序列名>_nosub_clip.mp4，
    // 这里剥掉中间标记，只留 <序列名>，避免交付名里带一堆内部字样。
    function outBaseFrom(file) {
        var b = path.basename(String(file)).replace(/\.[^.]+$/, '');
        return b.replace(/_nosub(_full|_clip)?$/i, '').replace(/_(full|clip)$/i, '') || b;
    }

    // ---------- 导入 PR「去字幕」素材箱（对齐超分面板）----------
    // 宿主通道：meImportFilesToBinStr，入参经全局 meImportPayload 传入
    // （JS window 变量传不进 ExtendScript，必须先在 ExtendScript 里赋值）
    function importToBin(files, binName) {
        return new Promise(function (resolve) {
            try {
                var list = (files || []).filter(function (f) { return !!f; });
                if (!list.length) { resolve({ ok: false, error: '没有可导入的文件' }); return; }
                if (!csInterface || typeof csInterface.evalScript !== 'function') {
                    resolve({ ok: false, error: '宿主桥不可用（面板未在 PR 内运行？）' }); return;
                }
                var cs = csInterface;
                cs.evalScript('meImportPayload = ' +
                    JSON.stringify({ files: list, binName: binName || '去字幕' }) + ';', function () {
                    cs.evalScript('meImportFilesToBinStr()', function (r) {
                        try { resolve(JSON.parse(r)); }
                        catch (e) { resolve({ ok: false, error: String(r) }); }
                    });
                });
            } catch (e) { resolve({ ok: false, error: e.message }); }
        });
    }

    // 统一收尾：把处理结果导入素材箱，日志里给出明确结果
    function importResult(file, binName, onDone) {
        if (!file) { if (onDone) onDone(); return; }
        log('📥 正在导入 PR 素材箱「' + binName + '」…');
        importToBin([file], binName).then(function (r) {
            if (r && r.ok && (r.imported || []).length) {
                var names = (r.imported || []).join('、');
                hint('✅ 已处理并导入「' + binName + '」：' + names, 'ok');
                log('📥 已导入素材箱「' + binName + '」：' + names, 'ok');
                if ((r.failed || []).length) log('⚠ 部分未导入：' + r.failed.join('、'), 'warn');
            } else {
                var why = (r && (r.error || (r.failed || []).join('、'))) || '未知原因';
                hint('⚠ 已处理完成，但导入素材箱失败：' + why + '（文件仍在：' + file + '）', 'warn');
                log('⚠ 导入素材箱失败：' + why, 'warn');
            }
            if (onDone) onDone();
        });
    }

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
                    // 记入历史（视频已在磁盘上，可拖进时间轴/导入素材箱/定位）
                    try {
                        var ca = (opts.area && opts.area[0]) || null;
                        addHistory({
                            id: 'h' + Date.now() + '_' + Math.floor(Math.random() * 1000),
                            input: input,
                            out: ev.output,
                            at: new Date().toISOString(),
                            mode: opts.mode,
                            area: ca ? { y0: ca[0], y1: ca[1], x0: ca[2], x1: ca[3] } : null,
                            elapsed: ev.elapsed || 0,
                            size: ev.size || 0
                        });
                    } catch (e) {}
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


    // 框选模式的守卫：没有框过区域时，先自动截帧并引导框选，别拿默认区域硬跑
    // 返回 true 表示可以继续处理
    function ensurePickedForUI(seqName, atSeconds) {
        var mode = (($('lsArea') || {}).value) || 'pick';
        if (mode !== 'pick') return true;
        if (picked) return true;
        hint('框选模式：正在截取一帧供你框选字幕区域…');
        var seqId = '';
        if (seqName) {
            // 同步取名→id 需要异步桥；用回调形式
            ensurePickedAsync(seqName, atSeconds);
            return false;
        }
        grabFrame('', (atSeconds === undefined ? '' : atSeconds));
        hint('请在上方图上拖框圈住字幕，然后点「✓ 用这块区域」，再点处理', 'ok');
        return false;
    }

    function ensurePickedAsync(seqName, atSeconds) {
        if (!csInterface) { hint('截帧需要在 PR 内运行', 'err'); return; }
        csInterface.evalScript('lsSeqIdByNameStr(' + JSON.stringify(seqName) + ')', function (r) {
            var res = null;
            try { res = JSON.parse(r); } catch (e) {}
            var id = (res && res.ok) ? res.id : '';
            if (id) {
                grabFrame(id, (atSeconds === undefined ? '' : atSeconds));
            } else {
                hint('找不到序列「' + seqName + '」，改为截取当前活动序列', 'warn');
                grabFrame('', (atSeconds === undefined ? '' : atSeconds));
            }
            hint('请在上方图上拖框圈住字幕，然后点「✓ 用这块区域」，再点处理', 'ok');
        });
    }

    // ---------- 入口 1：处理勾选序列（整条） ----------
    function runSequences() {
        if (running) { hint('已有任务在跑，请先停止', 'err'); return; }
        var seqs = clip ? clip.getCheckedSeqs() : [];
        if (!seqs.length) { hint('请先在上方勾选要处理的序列', 'err'); return; }
        // 框选模式且还没框过 → 先截第一帧让用户框
        if (!ensurePickedForUI(seqs[0], '')) return;
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
                    var base = outBaseFrom(file);
                    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
                    var out = uniqueOutPath(dir, base + '_erased', '.mp4');
                    if (path.basename(out) !== base + '_erased.mp4') {
                        log('  ℹ 同名已存在，本次输出为：' + path.basename(out));
                    }
                    runOne(file, out, function (e2, produced) {
                        // 处理完成 → 导入 PR「去字幕」素材箱，再继续下一个
                        if (e2) { next(); return; }
                        importResult(produced, '去字幕', next);
                    });
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
                // 框选模式且还没框过 → 先截区间起点那一帧让用户框
                if (!ensurePickedForUI(c.seqName, c.startSec)) return;
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
                // 注意签名是 (cb, seqName, range, preset) —— preset 必须单独传，
                // 早前误塞进 range 对象里，导致「导出预设不存在：[object Object]」。
                window.__vhEnhanceExportForLocal(function (err, file) {
                    if (err || !file) { hint('区间导出失败：' + ((err && err.message) || '未知'), 'err'); return; }
                    var base = outBaseFrom(file);
                    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
                    var out = uniqueOutPath(dir, base + '_erased', '.mp4');
                    if (path.basename(out) !== base + '_erased.mp4') {
                        log('  ℹ 同名已存在，本次输出为：' + path.basename(out));
                    }
                    runOne(file, out, function (e2, produced) {
                        if (e2) return;
                        importResult(produced, '去字幕', null);
                    });
                }, c.seqName, { startSec: c.startSec, endSec: c.endSec }, preset);
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
            try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
            var out = uniqueOutPath(dir, base + '_erased', '.mp4');
            runOne(v, out, function (e2, produced) {
                if (e2) return;
                importResult(produced, '去字幕', null);
            });
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

        // 历史记录
        renderHistory();
        var hcl = $('lsHistClear'); if (hcl) hcl.addEventListener('click', clearHistory);
        var hloc = $('lsHistLoc'); if (hloc) hloc.addEventListener('click', function () {
            openDir(defaultOutDir());
        });
        var hex = $('lsHistExpand'); if (hex) hex.addEventListener('click', function () { toggleLocalCard('hist'); });
        var lex = $('lsLogExpand'); if (lex) lex.addEventListener('click', function () { toggleLocalCard('log'); });
        var lcl = $('lsLogClear'); if (lcl) lcl.addEventListener('click', function () {
            var el = $('vLocalLog'); if (el) el.innerHTML = '';
        });
        // 恢复上次的展开状态
        (function () {
            var s = '';
            try { s = localStorage.getItem(LOCAL_EXP_KEY) || ''; } catch (e) {}
            if (s === 'hist' || s === 'log') setLocalCardExpanded(s, false);
        })();

        // 区域预设
        renderAreaPresets();
        var ps = $('lsAreaPreset');
        if (ps) ps.addEventListener('change', function () {
            if (ps.value) applyAreaPreset(ps.value);
        });
        var psv = $('lsAreaPresetSave');
        if (psv) psv.addEventListener('click', saveCurrentAreaAsPreset);
        var pdl = $('lsAreaPresetDel');
        if (pdl) pdl.addEventListener('click', deleteCurrentAreaPreset);

        // 折叠：默认收起（字幕位置通常固定，不需要一直占屏幕）
        setPickOpen(pickOpenSaved());
        var ptog = $('lsPickToggle');
        if (ptog) ptog.addEventListener('click', function () {
            var row = $('lsPickRow');
            var open = !(row && row.style.display !== 'none');
            setPickOpen(open);
        });

        // 截帧框选
        bindPickDrag();
        var gf = $('lsGrabFrame');
        if (gf) gf.addEventListener('click', function () { grabFrame('', ''); });
        var pf = $('lsPickFromFile');
        if (pf) pf.addEventListener('click', function () {
            var v = window.prompt('请输入图片完整路径（PNG/JPG）：', '');
            if (!v) return;
            var url = readImgDataUrl(v);
            if (!url) { hint('读不到图片：' + v, 'err'); return; }
            loadPickImage(url);
            hint('已载入图片，在图上拖框圈住字幕', 'ok');
        });
        var pfull = $('lsPickFull');
        if (pfull) pfull.addEventListener('click', function () {
            var stage = $('lsPickStage');
            if (stage) setBox(0, 0, stage.clientWidth, stage.clientHeight);
            updateReadout();
        });
        var papply = $('lsPickApply');
        if (papply) papply.addEventListener('click', function () {
            var r = boxToRatio();
            if (!r) { hint('框太小了，请拖大一点', 'err'); return; }
            picked = r;
            updateAppliedBadge();
            var ap = $('lsPickApplied');
            if (ap) {
                ap.style.display = '';
                var h = (pickImgSize ? pickImgSize.h : 0);
                ap.textContent = '✓ 已应用区域：y ' + r.y0 + '–' + r.y1 + ' · x ' + r.x0 + '–' + r.x1 +
                    (h ? ('（约 ' + Math.round((r.y1 - r.y0) * h) + ' px 高）') : '');
            }
            hint('✅ 区域已应用，可直接点「处理选中区间」或「处理勾选序列」', 'ok');
            log('🎯 框选区域（比例）: y ' + r.y0 + '–' + r.y1 + '  x ' + r.x0 + '–' + r.x1);
        });
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

        // 填充导出预设下拉（复用 enhance 面板同一份预设扫描）
        fillPresets();

        // 首次进入静默自检
        setTimeout(function () {
            window.__vhVSR.check(false, function (r) {
                hint(r && r.ok ? ('本地引擎就绪' + (r.gpu ? (' · ' + r.gpu) : ''))
                               : '本地引擎未就绪，点「🔧 自检」查看原因', '');
            });
        }, 1200);
    }

    // 填充「导出预设」下拉：与云端面板用同一份 AME 预设扫描结果
    function fillPresets() {
        var sel = $('lsPreset');
        if (!sel) return;
        var hits = [];
        try {
            if (typeof window.__vhListPresets === 'function') hits = window.__vhListPresets() || [];
        } catch (e) { hits = []; }
        var prev = sel.value;
        sel.innerHTML = '<option value="">自动（有字幕版）</option>';
        hits.forEach(function (h) {
            var o = document.createElement('option');
            o.value = h.full;
            o.textContent = h.name;
            sel.appendChild(o);
        });
        // 默认选中第一个「有字幕」预设（去字幕需要把字幕烧进画面）
        if (prev) {
            sel.value = prev;
        } else {
            var prefer = hits.filter(function (h) { return /有字幕|交片|成片|with.?sub/i.test(h.name); });
            if (prefer.length) sel.value = prefer[0].full;
        }
    }

    // 切到本 tab 时：拉一次序列（用户不用手动刷新）
    window.__localsubOnShow = function () {
        try { if (clip) clip.refreshSeqs(true); } catch (e) {}
        try { fillPresets(); } catch (e) {}
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
