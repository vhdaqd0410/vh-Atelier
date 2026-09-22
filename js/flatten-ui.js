// vh-Atelier · 调色 XML 清理（面板）
// 依赖 js/flatten-xml.js（window.__vhFlatten）
//
// 用途：剪辑完成 → 一键导出「只给达芬奇调色」的单轨 XML
//   自动删：禁用片段、装饰轨（水印/调整图层/转场）、全部音频
//   自动合：多条视频轨 → 一条 V1（上层优先，片段原子）
//   原序列零改动（只读导出，不碰工程）
//
// 布局：左栏配置（序列 / 步骤 / 轨道 / 输出），右栏运行日志（分级着色、自动粘底）
(function () {
    if (!document.getElementById('panel-colorxml')) return;

    var fs, path, os, cp;
    try {
        fs = require('fs'); path = require('path'); os = require('os');
        cp = require('child_process');
    } catch (e) { return; }

    var F = window.__vhFlatten;

    var el = {};
    var lastOut = '';
    var scanData = null;
    var seqList = [];
    var nameTouched = false;   // 用户是否手动改过文件名（改了就不再自动覆盖）

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function pick() {
        el.seq = document.getElementById('cxSeq');
        el.refreshSeq = document.getElementById('cxRefreshSeq');
        el.readSeq = document.getElementById('cxReadSeq');
        el.status = document.getElementById('cxStatus');
        el.tracks = document.getElementById('cxTracks');
        el.tracksWrap = document.getElementById('cxTracksWrap');
        el.summary = document.getElementById('cxSummary');
        el.summaryRow = document.getElementById('cxSummaryRow');
        el.outDir = document.getElementById('cxOutDir');
        el.outBrowse = document.getElementById('cxOutBrowse');
        el.outName = document.getElementById('cxOutName');
        el.go = document.getElementById('cxGo');
        el.openOut = document.getElementById('cxOpenOut');
        el.clearLog = document.getElementById('cxClearLog');
        el.log = document.getElementById('cxLog');
        el.logStat = document.getElementById('cxLogStat');
        el.dropTrans = document.getElementById('cxDropTrans');
        el.cbxAll = document.getElementById('cxAll');
        el.cbxNone = document.getElementById('cxNone');
    }

    // ---------- 日志（分级着色 + 自动粘底 + 条数统计） ----------
    var logCount = 0;
    var STICK_PX = 28;   // 距底部多少像素内算「贴底」

    function nowStr() {
        var d = new Date();
        function p2(n) { return (n < 10 ? '0' : '') + n; }
        return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    }

    function log(msg, kind) {
        if (!el.log) return;
        var atBottom = (el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight) <= STICK_PX;

        var line = document.createElement('span');
        line.className = 'cx-ln cx-ln-' + (kind || 'info');

        var t = document.createElement('span');
        t.className = 'cx-ln-time';
        t.textContent = nowStr();
        line.appendChild(t);
        line.appendChild(document.createTextNode(msg));

        el.log.appendChild(line);
        logCount++;
        if (el.logStat) el.logStat.textContent = logCount + ' 条';

        if (atBottom) el.log.scrollTop = el.log.scrollHeight;
    }

    function logSep() {
        log('────────────────────────────', 'sep');
    }

    function cs() { return new CSInterface(); }
    function evalHost(s) {
        return new Promise(function (r) { cs().evalScript(s, r); });
    }
    function q(s) { return "'" + String(s == null ? '' : s).replace(/\\/g, '/').replace(/'/g, "\\'") + "'"; }

    // ---------- 目录记忆 ----------
    var DIRKEY = 'vh_cx_lastdir';
    function getLastDir() {
        try { return localStorage.getItem(DIRKEY) || ''; } catch (e) { return ''; }
    }
    function setLastDir(d) {
        try { localStorage.setItem(DIRKEY, d || ''); } catch (e) {}
    }

    // CEP 规范：fileTypes 是扩展名字符串数组
    function pickDir(inputEl, cb) {
        var res = null;
        try {
            res = window.cep.fs.showOpenDialogEx(false, true, '选择输出目录',
                inputEl.value || getLastDir() || '', ['*'], '', '选择');
        } catch (e) { log('打开目录选择器失败：' + e.message, 'err'); return; }
        if (!res || (res.err && res.err !== 0)) return;
        var p = res.data && res.data.length ? res.data[0] : '';
        if (p) {
            inputEl.value = p;
            setLastDir(p);
            if (cb) cb(p);
        }
    }

    // ---------- 文件名自动填充：序列名-调色 ----------
    function autoFillName(seqName) {
        if (!el.outName) return;
        if (nameTouched) return;                 // 用户改过就不动
        if (!seqName) return;
        el.outName.value = String(seqName).replace(/[\\\/:*?"<>|]/g, '_') + '-调色';
    }

    // 当前选中的序列名
    function currentSeqName() {
        return (el.seq && el.seq.value) ? el.seq.value : '';
    }

    // ---------- 序列列表 ----------
    function loadSequences(silent) {
        if (el.refreshSeq) el.refreshSeq.disabled = true;
        return evalHost('fcListSequences()').then(function (res) {
            if (el.refreshSeq) el.refreshSeq.disabled = false;
            if (!res || res.indexOf('OK:') !== 0) {
                log('读取序列失败：' + res, 'err');
                return;
            }
            try {
                seqList = JSON.parse(res.slice(3)).sequences || [];
            } catch (e) { log('解析序列列表失败', 'err'); return; }

            // 记住当前选择，刷新后尽量保留
            var keepName = el.seq.value;

            var html = '';
            for (var i = 0; i < seqList.length; i++) {
                var s = seqList[i];
                html += '<option value="' + esc(s.name) + '">' + esc(s.name) +
                    ' （V' + s.videoTracks + ' / A' + s.audioTracks +
                    (s.active ? ' · 当前' : '') + '）</option>';
            }
            el.seq.innerHTML = html;

            // 优先保留原选择，否则选 PR 当前序列，再否则选第一个
            var picked = '';
            for (var k = 0; k < seqList.length; k++) {
                if (seqList[k].name === keepName) { picked = keepName; break; }
            }
            if (!picked) {
                for (var j = 0; j < seqList.length; j++) {
                    if (seqList[j].active) { picked = seqList[j].name; break; }
                }
            }
            if (!picked && seqList.length) picked = seqList[0].name;
            if (picked) el.seq.value = picked;

            if (!silent) log('已刷新序列列表，共 ' + seqList.length + ' 条', 'ok');
            else log('读取到 ' + seqList.length + ' 条序列', 'dim');
        });
    }

    // ---------- 导出 + 扫描 ----------
    function tmpXml(name) {
        var d = path.join(os.tmpdir(), 'vh_cx_' + Date.now());
        try { fs.mkdirSync(d); } catch (e) {}
        return path.join(d, (name || 'seq').replace(/[\\\/:*?"<>|]/g, '_') + '.xml');
    }

    function doReadSeq() {
        var name = currentSeqName();
        if (!name) { log('请先选择序列', 'err'); return Promise.resolve(); }

        var out = tmpXml(name);
        el.readSeq.disabled = true;
        el.status.textContent = '正在导出…';
        el.status.style.color = '#8ec4e0';
        log('【第 1 步】把「' + name + '」导出为 XML…', 'step');

        return evalHost('fcExportXML(' + q(name) + ',' + q(out) + ')').then(function (res) {
            el.readSeq.disabled = false;
            if (!res || res.indexOf('OK:') !== 0) {
                el.status.textContent = '导出失败';
                el.status.style.color = '#fca5a5';
                log('导出 XML 失败：' + res, 'err');
                log('提示：请确认 PR 里这条序列已保存，且不是空序列。', 'warn');
                return;
            }
            el.status.textContent = 'XML 已就绪';
            el.status.style.color = '#7fd68b';
            log('已导出：' + out, 'ok');

            // 读文件并扫描
            var txt;
            try { txt = fs.readFileSync(out, 'utf8'); }
            catch (e) { log('读取 XML 失败：' + e.message, 'err'); return; }

            var s = F.scan(txt);
            if (s.error) { log('解析失败：' + s.error, 'err'); return; }
            scanData = { text: txt, scan: s, file: out, seqName: name };

            renderTracks(s);
            // 文件名自动填充（序列名-调色）
            autoFillName(name);

            log('扫描完成：' + s.tracks.length + ' 条视频轨 / ' +
                s.audioTracks + ' 条音频轨（' + s.audioClips + ' 个音频片段，将全部清空）', 'ok');
            log('可在左侧勾选要保留的轨道，改完会自动重算结果。', 'dim');
        });
    }

    // ---------- 渲染轨道列表 ----------
    function renderTracks(s) {
        el.tracksWrap.style.display = '';
        if (el.summaryRow) el.summaryRow.style.display = '';
        var html = '';
        for (var i = 0; i < s.tracks.length; i++) {
            var t = s.tracks[i];
            var disabled = t.clipCount === 0;
            // 默认勾选 = 不勾选表示跳过；装饰轨默认不勾选
            var checked = !t.decor && !disabled;

            html += '<div class="cx-tr' + (t.decor ? ' cx-decor' : '') +
                (disabled ? ' cx-empty' : '') + '" data-idx="' + t.index + '" title="' +
                esc(t.label + ' · ' + (t.sample || '(空轨)')) + '">';
            html += '<label class="cx-chk"><input type="checkbox" class="cx-cb"' +
                (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '></label>';
            html += '<span class="cx-name">' + esc(t.label) + '</span>';
            html += '<span class="cx-cnt">' + t.clipCount + ' 片段</span>';
            if (t.disabled > 0) {
                html += '<span class="cx-badge cx-badge-dis" title="该轨上有被禁用的片段，会自动删除">禁用 ' + t.disabled + '</span>';
            }
            if (t.transitionCount > 0) {
                html += '<span class="cx-badge cx-badge-tr" title="该轨含转场（输出里表现为片段重叠）">转场 ' + t.transitionCount + '</span>';
            }
            if (t.decor) {
                html += '<span class="cx-badge cx-badge-decor" title="疑似装饰轨：' + esc(t.decorWhy) + '">装饰 · ' + esc(t.decorWhy) + '</span>';
            }
            html += '<span class="cx-sample">' + esc((t.sample || '(空轨)').slice(0, 30)) + '</span>';
            html += '</div>';
        }
        el.tracks.innerHTML = html;

        // 变化时更新预览
        var cbs = el.tracks.querySelectorAll('.cx-cb');
        for (var k = 0; k < cbs.length; k++) {
            cbs[k].addEventListener('change', updatePreview);
        }
        updatePreview();
    }

    function pickedTracks() {
        var out = [];
        if (!el.tracks) return out;
        var rows = el.tracks.querySelectorAll('.cx-tr');
        for (var i = 0; i < rows.length; i++) {
            var cb = rows[i].querySelector('.cx-cb');
            if (cb && cb.checked) out.push(parseInt(rows[i].getAttribute('data-idx'), 10));
        }
        return out;
    }

    // 实时预览：算出清理后的结果概况（在内存里跑一遍，不写文件）
    function updatePreview() {
        if (!scanData) return;
        var keep = pickedTracks();
        var s = scanData.scan;

        if (!keep.length) {
            el.summary.textContent = '至少要保留一条视频轨';
            el.summary.style.color = '#fca5a5';
            return;
        }

        var skip = [];
        for (var i = 0; i < s.tracks.length; i++) {
            var t = s.tracks[i];
            if (t.clipCount === 0) continue;
            if (keep.indexOf(t.index) < 0) skip.push(t.index);
        }

        var r = F.flatten(scanData.text, {
            skipTracks: skip,
            dropTransitions: !!(el.dropTrans && el.dropTrans.checked)
        });
        if (!r.ok) {
            el.summary.textContent = r.msg;
            el.summary.style.color = '#fca5a5';
            return;
        }
        var st = r.stats;
        var msg = '合轨后 ' + st.mergedSegments + ' 个片段（成片 ' +
            (st.duration / r.fps).toFixed(2) + ' 秒 @ ' + r.fps + 'fps）';
        msg += ' · 删禁用 ' + st.droppedDisabled;
        msg += ' · 清音频 ' + st.droppedAudio;
        if (st.skippedTracks.length) msg += ' · 跳过 ' + st.skippedTracks.join('/');
        el.summary.textContent = msg;
        el.summary.style.color = '#8ec4e0';
    }

    // ---------- 执行导出 ----------
    function doExport() {
        if (!scanData) { log('请先点「① 读取当前序列」', 'err'); return; }
        var keep = pickedTracks();
        if (!keep.length) { log('至少要保留一条视频轨', 'err'); return; }

        var dir = (el.outDir.value || '').trim();
        if (!dir) { log('请选择输出目录', 'err'); return; }
        if (!fs.existsSync(dir)) { log('输出目录不存在：' + dir, 'err'); return; }

        var s = scanData.scan;
        var skip = [];
        for (var i = 0; i < s.tracks.length; i++) {
            var t = s.tracks[i];
            if (t.clipCount === 0) continue;
            if (keep.indexOf(t.index) < 0) skip.push(t.index);
        }

        var name = (el.outName.value || '').trim() || ((s.seqName || 'sequence') + '-调色');
        var outFile = path.join(dir, name + '.xml');

        log('【第 2 步】生成调色 XML…', 'step');
        if (fs.existsSync(outFile)) {
            log('同名文件已存在，将被覆盖：' + outFile, 'warn');
        }

        var r = F.flatten(scanData.text, {
            skipTracks: skip,
            dropTransitions: !!(el.dropTrans && el.dropTrans.checked)
        });
        if (!r.ok) { log('处理失败：' + r.msg, 'err'); return; }

        try { fs.writeFileSync(outFile, r.text, 'utf8'); }
        catch (e) { log('写文件失败：' + e.message, 'err'); return; }

        lastOut = outFile;
        var st = r.stats;
        logSep();
        log('已输出：' + outFile, 'ok');
        log('  · 保留轨道：' + st.keptTracks.join(' / '), 'dim');
        if (st.skippedTracks.length) log('  · 跳过轨道：' + st.skippedTracks.join(' / '), 'dim');
        log('  · 合轨片段：' + st.mergedSegments + ' 个（成片时长 ' +
            (st.duration / r.fps).toFixed(2) + ' 秒 @ ' + r.fps + 'fps）', 'dim');
        log('  · 删除禁用片段：' + st.droppedDisabled + ' 个', 'dim');
        log('  · 跳过轨上的片段：' + st.droppedFromSkippedTracks + ' 个', 'dim');
        log('  · 清空音频片段：' + st.droppedAudio + ' 个', 'dim');
        if (st.fixedFileRefs) {
            log('  · 修复素材引用：' + st.fixedFileRefs + ' 个（原本因删轨而悬空）', 'dim');
        }
        if (st.danglingLeft) {
            log('  仍有 ' + st.danglingLeft + ' 个素材引用无法补全，建议在达芬奇里核对', 'warn');
        }
        log('原工程完全未改动，可直接把该 XML 导入达芬奇调色。', 'ok');
        el.openOut.style.display = '';
        setLastDir(dir);
    }

    // ---------- 绑定 ----------
    function bind() {
        pick();
        if (!el.seq) return;

        // 刷新序列列表（切换序列后不用切页面）
        el.refreshSeq.onclick = function () {
            loadSequences(false).catch(function (e) {
                log('刷新序列失败：' + (e && e.message || e), 'err');
            });
        };

        // 换序列时，如果文件名还是自动填的，跟着更新
        el.seq.addEventListener('change', function () {
            if (!scanData) autoFillName(currentSeqName());
        });

        // 用户手动改文件名后，不再自动覆盖
        el.outName.addEventListener('input', function () {
            nameTouched = !!el.outName.value.trim();
        });

        el.readSeq.onclick = function () {
            doReadSeq().catch(function (e) { log('异常：' + (e && e.message || e), 'err'); });
        };

        el.outBrowse.onclick = function () { pickDir(el.outDir); };

        el.go.onclick = doExport;

        if (el.openOut) {
            el.openOut.onclick = function () {
                if (!lastOut) return;
                try {
                    cp.exec('explorer /select,"' + lastOut.replace(/\//g, '\\') + '"', { windowsHide: true });
                } catch (e) { log('打开失败：' + e.message, 'err'); }
            };
        }
        if (el.clearLog) {
            el.clearLog.onclick = function () {
                el.log.innerHTML = '';
                logCount = 0;
                if (el.logStat) el.logStat.textContent = '';
            };
        }

        if (el.dropTrans) el.dropTrans.addEventListener('change', updatePreview);

        if (el.cbxAll) {
            el.cbxAll.onclick = function () {
                var cbs = el.tracks.querySelectorAll('.cx-cb');
                for (var i = 0; i < cbs.length; i++) if (!cbs[i].disabled) cbs[i].checked = true;
                updatePreview();
            };
        }
        if (el.cbxNone) {
            el.cbxNone.onclick = function () {
                var cbs = el.tracks.querySelectorAll('.cx-cb');
                for (var i = 0; i < cbs.length; i++) cbs[i].checked = (i === 0);
                if (cbs[0]) cbs[0].checked = true;
                updatePreview();
            };
        }

        // 恢复上次输出目录
        var ld = getLastDir();
        if (ld) { el.outDir.value = ld; }

        log('把剪辑好的序列导出成「只给调色用」的单轨 XML。', 'info');
        log('自动删除：被禁用的镜头、水印/调整图层/转场等装饰轨、全部音频。', 'dim');
        log('自动合并：多条视频轨 → 一条 V1（上层优先，片段不被切碎）。', 'dim');
        log('原工程不会被改动。', 'ok');

        loadSequences(true).catch(function () {});
    }

    // 切到本面板时刷新序列
    window.__vhColorXmlOnShow = function () {
        if (!el.seq) pick();
        loadSequences(true).catch(function () {});
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
