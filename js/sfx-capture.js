// vh-Atelier 音效采集：把时间轴选中的音频片段导出为 wav，存进音效库
//
// 两种模式：
//   fast  = ffmpeg 直接剪切素材源文件
//           快（1~3 秒），取的是原始素材音频
//           片段若做了变速/变调/加效果器，结果与时间轴听到的不一致
//   exact = PR 原生导出（设入出点 → exportAsMediaDirect → 还原入出点）
//           所见即所得，效果器/变速/增益全带上；但要过 AME，慢，且需 PR 前台
//
// 依赖：bin/ffmpeg-win32-x64.exe；exact 模式依赖 AME 导出预设（.epr）
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var os = require('os');
    var path = require('path');
    var cp = require('child_process');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);

    // 元素（不齐就说明不在音效库面板）
    var el = {
        cap: document.getElementById('sfxCap'),
        head: document.getElementById('sfxCapHead'),
        body: document.getElementById('sfxCapBody'),
        src: document.getElementById('sfxCapSrc'),
        pick: document.getElementById('btnSfxCapPick'),
        name: document.getElementById('sfxCapName'),
        mode: document.getElementById('sfxCapMode'),
        tip: document.getElementById('sfxCapTip'),
        dir: document.getElementById('sfxCapDir'),
        btnDir: document.getElementById('btnSfxCapDir'),
        btnDef: document.getElementById('btnSfxCapDef'),
        fade: document.getElementById('sfxCapFade'),
        imp: document.getElementById('sfxCapImport'),
        status: document.getElementById('sfxCapStatus'),
        go: document.getElementById('btnSfxCapGo')
    };
    if (!el.cap || !el.pick || !el.go) return;

    var LS_DIR = 'vh_sfx_capture_dir';
    var LS_MODE = 'vh_sfx_capture_mode';
    var LS_FADE = 'vh_sfx_capture_fade';
    var LS_PRESET = 'vh_sfx_capture_preset';

    var picked = null;      // { mediaPath, inPoint, outPoint, duration, name, seqName }
    var busy = false;

    // ---------------- 基础工具 ----------------
    function setStatus(msg, cls) {
        if (!el.status) return;
        el.status.className = 'sfx-cap-st' + (cls ? ' ' + cls : '');
        el.status.textContent = msg || '';
    }

    function sfxRoot() {
        var d = document.getElementById('sfxDir');
        return d ? String(d.value || '').trim() : '';
    }
    function defaultDir() {
        var r = sfxRoot();
        return r ? path.join(r, '新采集') : '';
    }
    function currentDir() {
        var v = el.dir ? String(el.dir.value || '').trim() : '';
        if (v) return v;
        try { v = localStorage.getItem(LS_DIR) || ''; } catch (e) {}
        return v || defaultDir();
    }

    // Windows 文件名净化
    function safeName(s) {
        s = String(s == null ? '' : s).replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();
        s = s.replace(/[. ]+$/, '');
        if (s.length > 80) s = s.slice(0, 80);
        return s || '音效';
    }
    function uniquePath(dir, base) {
        var p = path.join(dir, base + '.wav');
        var i = 2;
        while (fs.existsSync(p)) { p = path.join(dir, base + '_' + i + '.wav'); i++; }
        return p;
    }

    // ---------------- 模式说明 ----------------
    function syncTip() {
        if (!el.tip) return;
        var m = el.mode ? el.mode.value : 'fast';
        el.tip.innerHTML = (m === 'fast')
            ? '<b>快速模式</b>　用 ffmpeg 直接剪切素材源文件<br>' +
              '✓ 快（通常 1~3 秒），不占用 AME 导出队列<br>' +
              '⚠ 取的是<b>原始素材音频</b>：若该片段在时间轴上做过变速 / 变调 / 加了效果器，' +
              '结果与听到的不一致 —— 这种情况请改用精确模式<br>' +
              '· 多选时：<b>只导出第 1 个</b>选中片段'
            : '<b>精确模式</b>　调用 PR 原生导出（所见即所得）<br>' +
              '✓ 效果器、变速、增益全部带上，与时间轴播放完全一致<br>' +
              '⚠ 慢（要过 AME，10 秒到数分钟），需要 PR 保持在前台，会占用导出队列<br>' +
              '· 多选时：按<b>并集区间</b>导出一整段（含中间的空白/其他片段）';
    }

    // ---------------- 读取选中片段 ----------------
    // 取两种信息：
    //   mediaPath + inPoint/outPoint → 快速模式（ffmpeg 切素材源，inPoint 是素材内偏移）
    //   startSec/endSec              → 精确模式（序列时间轴区间，exportAsMediaDirect 需要）
    function pickSelection() {
        setStatus('正在读取时间轴选中片段…', '');
        // 先拿素材信息（快速模式用）
        csInterface.evalScript('wsGetSequenceClipsRangeStr("", "selection")', function (res) {
            var d = null;
            try { d = JSON.parse(res); } catch (e) {}
            if (!d || d.error || !d.clips || !d.clips.length) {
                picked = null;
                if (el.src) { el.src.textContent = '未读取（点右侧「取选中」）'; el.src.classList.remove('has'); }
                setStatus((d && d.error) || '没有选中片段，请先在时间轴选中音频块', 'err');
                return;
            }
            var c = d.clips[0];
            var ip = Number(c.inPoint) || 0;
            var op = Number(c.outPoint) || 0;
            picked = {
                mediaPath: c.mediaPath,
                inPoint: ip,
                outPoint: op,
                duration: (op - ip) > 0 ? (op - ip) : (Number(c.duration) || 0),
                name: c.clipName || path.basename(c.mediaPath || ''),
                seqName: d.seqName || '',
                count: d.clips.length,
                startSec: null,
                endSec: null
            };
            // 再拿序列表位置（精确模式用；不同接口，字段含义不同）
            csInterface.evalScript('meGetSelectedClipInfo()', function (r2) {
                var s2 = String(r2 || '');
                if (s2.indexOf('OK:') === 0) {
                    try {
                        var info = JSON.parse(s2.slice(3));
                        picked.startSec = info.startSec;
                        picked.endSec = info.endSec;
                        if (info.seqName) picked.seqName = info.seqName;
                        if (info.durationSec) picked.duration = info.durationSec;
                    } catch (e) {}
                }
                afterPick();
            });
        });
    }

    function afterPick() {
        if (!picked) return;
        if (el.name && !String(el.name.value || '').trim()) {
            el.name.value = safeName(picked.name);
        }
        if (el.src) {
            el.src.textContent = picked.name + '  ·  ' + picked.duration.toFixed(2) + 's' +
                (picked.count > 1 ? '（选中 ' + picked.count + ' 个，仅取第 1 个）' : '');
            el.src.classList.add('has');
        }
        if (el.mode && el.mode.value === 'exact' && (picked.startSec == null || picked.endSec == null)) {
            setStatus('已读取素材；但未能取到序列区间（精确模式需要），请改用快速模式或重试', 'warn');
        } else {
            setStatus('已读取，时长 ' + picked.duration.toFixed(2) + ' 秒', 'ok');
        }
    }

    // ---------------- 快速模式：ffmpeg ----------------
    function exportFast(clip, outWav, fade, cb) {
        var ff = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
        if (!fs.existsSync(ff)) return cb('找不到 ffmpeg：' + ff);
        var dur = clip.outPoint - clip.inPoint;
        if (!(dur > 0)) return cb('片段时长异常（in=' + clip.inPoint + ', out=' + clip.outPoint + '）');

        var args = ['-ss', clip.inPoint.toFixed(3), '-t', dur.toFixed(3),
                    '-i', clip.mediaPath, '-ac', '2', '-ar', '48000'];
        if (fade) {
            var fd = Math.min(0.05, dur / 4);
            args.push('-af', 'afade=t=out:st=' + Math.max(0, dur - fd).toFixed(3) + ':d=' + fd.toFixed(3));
        }
        args.push('-y', outWav);

        cp.execFile(ff, args, { timeout: 300000, maxBuffer: 1024 * 1024 * 20 }, function (err) {
            if (err || !fs.existsSync(outWav)) {
                return cb('ffmpeg 剪切失败：' + (err ? err.message : '未生成文件'));
            }
            cb(null);
        });
    }

    // ---------------- 精确模式：PR 原生导出 ----------------
    // 扫描 AME 预设目录，优先挑音频类 .epr
    function findPresets() {
        var hits = [];
        var ameRoot = path.join(os.homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder');
        try {
            if (fs.existsSync(ameRoot)) {
                fs.readdirSync(ameRoot).forEach(function (v) {
                    var pdir = path.join(ameRoot, v, 'Presets');
                    try {
                        if (!fs.existsSync(pdir)) return;
                        fs.readdirSync(pdir).forEach(function (fn) {
                            if (/\.epr$/i.test(fn)) hits.push({ name: fn, full: path.join(pdir, fn) });
                        });
                    } catch (e) {}
                });
            }
        } catch (e) {}
        return hits;
    }
    function pickPreset() {
        // 已选过且仍存在，直接用
        var saved = '';
        try { saved = localStorage.getItem(LS_PRESET) || ''; } catch (e) {}
        if (saved && fs.existsSync(saved)) return saved;

        var all = findPresets();
        if (!all.length) return '';
        // 优先音频/wav 类关键词，其次 WAV 相关的默认预设名
        var re = /wav|audio|音频|wave/i;
        for (var i = 0; i < all.length; i++) {
            if (re.test(all[i].name)) return all[i].full;
        }
        return all[0].full;
    }

    function exportExact(clip, outWav, cb) {
        if (clip.startSec == null || clip.endSec == null) {
            return cb('未取到序列区间，无法精确导出。请重新点「取选中」，或改用快速模式');
        }
        var preset = pickPreset();
        if (!preset) {
            return cb('未找到可用的导出预设（.epr）。精确模式需要一个导出预设，' +
                      '可在「交付」板块的导出设置里确认 AME 预设目录');
        }
        var payload = {
            seqName: clip.seqName || '',
            startSec: clip.startSec,
            endSec: clip.endSec,
            outPath: outWav,
            presetPath: preset
        };
        csInterface.evalScript('meRangePayload = ' + JSON.stringify(payload) + ';', function () {
            csInterface.evalScript('meExportRangeStr()', function (r) {
                var s = String(r || '');
                if (!s) return cb('导出无返回');
                if (s.indexOf('OK:') === 0) return cb(null);
                var msg = s.replace(/^ERR:/, '');
                if (msg.indexOf('NOSETINOUT:') === 0) msg = msg.slice('NOSETINOUT:'.length);
                cb(msg || '导出失败');
            });
        });
    }

    // ---------------- 主流程 ----------------
    function doExport() {
        if (busy) return;
        if (!picked) { setStatus('请先点「取选中」读取时间轴上的音频片段', 'err'); return; }

        var dir = currentDir();
        if (!dir) { setStatus('请先设置保存目录（或先给音效库选个根目录）', 'err'); return; }
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            setStatus('无法创建目录：' + e.message, 'err');
            return;
        }

        var base = safeName((el.name && el.name.value) || picked.name);
        var outWav = uniquePath(dir, base);
        var mode = el.mode ? el.mode.value : 'fast';
        var fade = !!(el.fade && el.fade.checked);

        busy = true;
        el.go.disabled = true;
        el.go.textContent = mode === 'fast' ? '剪切中…' : '导出中（较慢）…';
        setStatus(mode === 'fast' ? '正在剪切音频…'
                                  : '正在调用 PR 导出，请勿切走（可能数十秒）…', '');

        var done = function (err) {
            busy = false;
            el.go.disabled = false;
            el.go.textContent = '导出为音效';
            if (err) { setStatus(String(err).slice(0, 170), 'err'); return; }

            try { localStorage.setItem(LS_DIR, dir); } catch (e) {}

            // 可选：导入素材箱（host 端从全局变量 meImportPayload 读参数）
            if (el.imp && el.imp.checked) {
                var impPl = JSON.stringify({ binName: '音效库', files: [outWav] });
                csInterface.evalScript('meImportPayload = ' + JSON.stringify(impPl) + '; meImportFilesToBinStr()', function () {});
            }

            setStatus('✅ 已保存：' + path.basename(outWav) +
                      '　→　' + dir, 'ok');

            // 刷新音效库列表（若它正浏览保存目录相关位置）
            try {
                if (typeof window.__sfxRescan === 'function') window.__sfxRescan();
                else if (typeof window.__sfxOnShow === 'function') window.__sfxOnShow();
            } catch (e) {}
        };

        if (mode === 'fast') exportFast(picked, outWav, fade, done);
        else exportExact(picked, outWav, done);
    }

    // ---------------- 事件 ----------------
    function bind() {
        el.head.addEventListener('click', function () {
            var open = el.body.style.display !== 'none';
            el.body.style.display = open ? 'none' : '';
            el.cap.classList.toggle('open', !open);
        });
        el.pick.addEventListener('click', pickSelection);
        el.go.addEventListener('click', doExport);

        if (el.mode) {
            el.mode.addEventListener('change', function () {
                syncTip();
                try { localStorage.setItem(LS_MODE, el.mode.value); } catch (e) {}
            });
        }
        if (el.fade) {
            el.fade.addEventListener('change', function () {
                try { localStorage.setItem(LS_FADE, el.fade.checked ? '1' : '0'); } catch (e) {}
            });
        }
        if (el.btnDir) {
            el.btnDir.addEventListener('click', function () {
                var initial = currentDir() || sfxRoot() || '';
                var result;
                try {
                    result = window.cep.fs.showOpenDialogEx(true, true, '选择音效保存目录', initial, []);
                } catch (e) { setStatus('打开目录选择器失败：' + e.message, 'err'); return; }
                if (!result) { setStatus('未选择（已取消）', ''); return; }
                if (result.err && result.err !== 0) { setStatus('打开目录选择器失败：' + result.err, 'err'); return; }
                var chosen = (result.data && result.data.length) ? result.data[0] : null;
                if (!chosen) { setStatus('未选择（已取消）', ''); return; }
                el.dir.value = chosen;
                try { localStorage.setItem(LS_DIR, chosen); } catch (e) {}
                setStatus('保存目录已设为：' + chosen, 'ok');
            });
        }
        if (el.btnDef) {
            el.btnDef.addEventListener('click', function () {
                var d = defaultDir();
                if (!d) { setStatus('请先给音效库选择根目录（上方路径框）', 'warn'); return; }
                el.dir.value = '';
                try { localStorage.removeItem(LS_DIR); } catch (e) {}
                setStatus('已恢复默认：' + d, 'ok');
            });
        }

        // 恢复上次设置
        try {
            var m = localStorage.getItem(LS_MODE);
            if (m && el.mode) el.mode.value = m;
            var f = localStorage.getItem(LS_FADE);
            if (f !== null && el.fade) el.fade.checked = (f === '1');
            var d0 = localStorage.getItem(LS_DIR);
            if (d0 && el.dir) el.dir.value = d0;
        } catch (e) {}
        syncTip();

        // 音效库根目录变化 → 提示默认落点
        var rootInput = document.getElementById('sfxDir');
        if (rootInput) {
            rootInput.addEventListener('change', function () {
                if (!String(el.dir ? el.dir.value : '').trim()) {
                    var d = defaultDir();
                    setStatus(d ? ('默认保存到：' + d) : '请先给音效库选择根目录', d ? '' : 'warn');
                }
            });
        }

        // 首次展开时刷新一次提示
        setStatus(defaultDir() ? ('默认保存到：' + defaultDir()) : '请先给音效库选择根目录，再采集', defaultDir() ? '' : 'warn');
    }

    bind();

    // 供外部调用（例如面板切到时）
    window.__sfxCapturePick = pickSelection;
})();
