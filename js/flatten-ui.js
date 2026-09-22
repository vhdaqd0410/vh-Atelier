// vh-Atelier · 调色 XML 清理（面板）
// 依赖 js/flatten-xml.js（window.__vhFlatten）
//
// 用途：剪辑完成 → 一键导出「只给达芬奇调色」的单轨 XML
//   自动删：禁用片段、装饰轨（水印/调整图层/转场）、全部音频
//   自动合：多条视频轨 → 一条 V1（上层优先，片段原子）
//   原序列零改动（只读导出，不碰工程）
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

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function pick() {
        el.seq = document.getElementById('cxSeq');
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
        el.preview = document.getElementById('cxPreview');
        el.dropTrans = document.getElementById('cxDropTrans');
        el.cbxAll = document.getElementById('cxAll');
        el.cbxNone = document.getElementById('cxNone');
    }

    function log(msg, kind) {
        if (!el.log) return;
        var d = document.createElement('div');
        d.textContent = msg;
        if (kind === 'err') d.style.color = '#fca5a5';
        else if (kind === 'ok') d.style.color = '#7fd68b';
        else if (kind === 'warn') d.style.color = '#e0c268';
        else if (kind === 'dim') d.style.color = '#8b95a5';
        el.log.appendChild(d);
        el.log.scrollTop = el.log.scrollHeight;
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

    // ---------- 序列列表 ----------
    function loadSequences() {
        return evalHost('fcListSequences()').then(function (res) {
            if (!res || res.indexOf('OK:') !== 0) {
                log('读取序列失败：' + res, 'err');
                return;
            }
            try {
                seqList = JSON.parse(res.slice(3)).sequences || [];
            } catch (e) { log('解析序列列表失败', 'err'); return; }

            var html = '';
            for (var i = 0; i < seqList.length; i++) {
                var s = seqList[i];
                html += '<option value="' + esc(s.name) + '">' + esc(s.name) +
                    ' （V' + s.videoTracks + ' / A' + s.audioTracks +
                    (s.active ? ' · 当前' : '') + '）</option>';
            }
            el.seq.innerHTML = html;
            // 默认选当前序列
            for (var j = 0; j < seqList.length; j++) {
                if (seqList[j].active) { el.seq.value = seqList[j].name; break; }
            }
            log('读取到 ' + seqList.length + ' 条序列', 'dim');
        });
    }

    // ---------- 导出 + 扫描 ----------
    function tmpXml(name) {
        var d = path.join(os.tmpdir(), 'vh_cx_' + Date.now());
        try { fs.mkdirSync(d); } catch (e) {}
        return path.join(d, (name || 'seq').replace(/[\\\/:*?"<>|]/g, '_') + '.xml');
    }

    function doReadSeq() {
        var name = el.seq.value || '';
        if (!name) { log('请先选择序列', 'err'); return Promise.resolve(); }
        var out = tmpXml(name);
        el.readSeq.disabled = true;
        el.status.textContent = '正在导出…';
        el.status.style.color = '#8ec4e0';
        log('正在把「' + name + '」导出为 XML…', 'dim');

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
            log('导出成功：' + out, 'ok');

            // 读文件并扫描
            var txt;
            try { txt = fs.readFileSync(out, 'utf8'); }
            catch (e) { log('读取 XML 失败：' + e.message, 'err'); return; }

            var s = F.scan(txt);
            if (s.error) { log('解析失败：' + s.error, 'err'); return; }
            scanData = { text: txt, scan: s, file: out };

            renderTracks(s);
            log('扫描完成：' + s.tracks.length + ' 条视频轨 / ' +
                s.audioTracks + ' 条音频轨（' + s.audioClips + ' 个音频片段，将全部清空）', 'ok');
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
                (disabled ? ' cx-empty' : '') + '" data-idx="' + t.index + '">';
            html += '<label class="cx-chk"><input type="checkbox" class="cx-cb"' +
                (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '></label>';
            html += '<span class="cx-name">' + esc(t.label) + '</span>';
            html += '<span class="cx-cnt">' + t.clipCount + ' 片段</span>';
            if (t.disabled > 0) {
                html += '<span class="cx-badge cx-badge-dis">禁用 ' + t.disabled + '</span>';
            }
            if (t.transitionCount > 0) {
                html += '<span class="cx-badge cx-badge-tr">转场 ' + t.transitionCount + '</span>';
            }
            if (t.decor) {
                html += '<span class="cx-badge cx-badge-decor">装饰 · ' + esc(t.decorWhy) + '</span>';
            }
            html += '<span class="cx-sample" title="' + esc(t.sample) + '">' +
                esc((t.sample || '(空轨)').slice(0, 30)) + '</span>';
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
            el.summary.textContent = '⚠ 至少要保留一条视频轨';
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
            el.summary.textContent = '⚠ ' + r.msg;
            el.summary.style.color = '#fca5a5';
            return;
        }
        var st = r.stats;
        var msg = '合轨后 ' + st.mergedSegments + ' 个片段（成片时长 ' +
            (st.duration / r.fps).toFixed(2) + ' 秒）';
        msg += ' · 删禁用片段 ' + st.droppedDisabled + ' 个';
        msg += ' · 清空音频 ' + st.droppedAudio + ' 个';
        if (st.skippedTracks.length) msg += ' · 跳过 ' + st.skippedTracks.join('/');
        el.summary.textContent = msg;
        el.summary.style.color = '#8ec4e0';
    }

    // ---------- 执行导出 ----------
    function doExport() {
        if (!scanData) { log('请先点「读取当前序列」', 'err'); return; }
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

        var name = (el.outName.value || '').trim() || (s.seqName || 'sequence');
        var outFile = path.join(dir, name + '_调色.xml');
        if (fs.existsSync(outFile)) {
            log('输出文件已存在，将被覆盖：' + outFile, 'warn');
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
        log('──────────', 'dim');
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
            log('  ⚠ 仍有 ' + st.danglingLeft + ' 个素材引用无法补全，建议在达芬奇里核对', 'warn');
        }
        log('原工程完全未改动，可直接把该 XML 导入达芬奇调色。', 'ok');
        el.openOut.style.display = '';
        setLastDir(dir);
    }

    // ---------- 绑定 ----------
    function bind() {
        pick();
        if (!el.seq) return;

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
        if (el.clearLog) el.clearLog.onclick = function () { el.log.innerHTML = ''; };

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
                // 至少留 V1
                var cbs = el.tracks.querySelectorAll('.cx-cb');
                for (var i = 0; i < cbs.length; i++) cbs[i].checked = (i === 0);
                if (cbs[0]) cbs[0].checked = true;
                updatePreview();
            };
        }

        // 恢复上次输出目录
        var ld = getLastDir();
        if (ld) { el.outDir.value = ld; }

        log('把剪辑好的序列导出成「只给调色用」的单轨 XML。', '');
        log('自动删除：被禁用的镜头、水印/调整图层/转场等装饰轨、全部音频。', '');
        log('自动合并：多条视频轨 → 一条 V1（上层优先，片段不被切碎）。', '');
        log('原工程不会被改动。', 'ok');

        loadSequences().catch(function () {});
    }

    // 切到本面板时刷新序列
    window.__vhColorXmlOnShow = function () {
        if (!el.seq) pick();
        loadSequences().catch(function () {});
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
