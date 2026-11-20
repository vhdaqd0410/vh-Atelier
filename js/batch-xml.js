// ==========================================================================
// vh-Atelier · 批量导出 XML
// --------------------------------------------------------------------------
// 用途：一次把多个序列导出成 Final Cut Pro XML（给调色、混音或别的软件用）。
//
// 实现要点：
//   1. 复用宿主已有的 fcExportXML，不重复实现导出逻辑。
//   2. 串行执行：PR 的导出是同步操作，并发没有收益，反而容易卡住。
//   3. 每个序列导出完立刻反馈，失败的记下原因继续下一个，不整体中断。
//   4. 可随时停止：停在两个序列之间，不会留下半截文件。
//   5. 文件名 = 序列名.xml，非法字符替换掉。
//
// 对外：window.__vhBatchXml.onShow()  切到该面板时刷新序列列表
// ==========================================================================
(function () {
    'use strict';

    var fs, path;
    try {
        fs = require('fs');
        path = require('path');
    } catch (e) { /* 非 CEP 环境不启用 */ }

    var el = {};
    var seqs = [];          // [{name, id}]
    var picked = {};        // { name: true }
    var running = false;
    var stopFlag = false;

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function setStatus(t, cls) {
        if (!el.count) return;
        el.count.textContent = t || '';
        el.count.style.color = cls === 'err' ? '#ef8a8a' : (cls === 'ok' ? '#7fd68b' : '');
    }

    // 复用同一个 CSInterface 实例（与其它面板一致）；每次 new 在部分宿主上会失效
    var csInterface = null;
    try {
        if (typeof CSInterface !== 'undefined') csInterface = new CSInterface();
    } catch (e0) { csInterface = null; }

    function csEval(script, cb) {
        try {
            if (!csInterface || typeof csInterface.evalScript !== 'function') {
                cb('ERR:与 PR 的通信不可用（请在 PR 内打开插件面板）');
                return;
            }
            csInterface.evalScript(script, function (r) { cb(r); });
        } catch (e) { cb('ERR:' + e.message); }
    }

    // ---------- 读取序列列表 ----------
    function loadSequences() {
        setStatus('正在读取序列…');
        csEval('meListSequences()', function (raw) {
            if (!raw || raw.indexOf('OK:') !== 0) {
                setStatus('读取失败：' + String(raw).slice(0, 120), 'err');
                return;
            }
            var list = [];
            try {
                var j = JSON.parse(raw.slice(3));
                list = (j && j.sequences) || j || [];
            } catch (e) {
                setStatus('解析序列列表失败', 'err');
                return;
            }
            seqs = list.map(function (x) {
                return (typeof x === 'string') ? { name: x } : { name: x.name || x.seqName || '' };
            }).filter(function (x) { return x.name; });

            // 默认全选
            picked = {};
            seqs.forEach(function (s) { picked[s.name] = true; });
            renderList();
            setStatus('共 ' + seqs.length + ' 个序列');
        });
    }

    function renderList() {
        if (!el.list) return;
        if (!seqs.length) {
            el.list.innerHTML = '<div class="hint" style="padding:10px;">没有读到序列。先在 PR 里打开一个工程。</div>';
            return;
        }
        el.list.innerHTML = '';
        seqs.forEach(function (s, i) {
            var row = document.createElement('label');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:5px;cursor:pointer;font-size:12px;';
            row.onmouseenter = function () { row.style.background = '#1d1d22'; };
            row.onmouseleave = function () { row.style.background = ''; };

            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!picked[s.name];
            cb.style.cssText = 'width:14px;height:14px;accent-color:#8b5cf6;';
            cb.onchange = function () { picked[s.name] = cb.checked; refreshCount(); };

            var sp = document.createElement('span');
            sp.textContent = s.name;
            sp.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

            row.appendChild(cb);
            row.appendChild(sp);
            el.list.appendChild(row);
        });
        refreshCount();
    }

    function refreshCount() {
        var n = Object.keys(picked).filter(function (k) { return picked[k]; }).length;
        setStatus('已选 ' + n + ' / ' + seqs.length + ' 个序列');
        if (el.run) el.run.disabled = n === 0 || running;
    }

    // ---------- 选择输出目录 ----------
    function pickDir() {
        try {
            var r = window.cep.fs.showOpenDialogEx(false, true, '选择 XML 输出目录', '', [], '', '选择');
            if (r && r.err === 0 && r.data && r.data.length) {
                el.outDir.value = r.data[0];
            }
        } catch (e) {
            setStatus('打开目录选择器失败：' + e.message, 'err');
        }
    }

    function safeName(n) {
        return String(n || 'sequence').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    }

    // ---------- 执行批量导出 ----------
    function run() {
        var names = Object.keys(picked).filter(function (k) { return picked[k]; });
        if (!names.length) { setStatus('请先勾选要导出的序列', 'err'); return; }

        var outDir = (el.outDir.value || '').trim();
        if (!outDir) {
            // 留空 → 用工程目录
            csEval('fcProjectDir()', function (raw) {
                var d = '';
                if (raw && raw.indexOf('OK:') === 0) {
                    try { d = JSON.parse(raw.slice(3)).dir || ''; } catch (e) {}
                }
                if (!d) { setStatus('没能取到工程目录，请手动选择输出目录', 'err'); return; }
                el.outDir.value = d;
                run();
            });
            return;
        }

        running = true;
        stopFlag = false;
        el.run.disabled = true;
        el.stop.style.display = '';
        el.progressRow.style.display = 'flex';
        el.result.innerHTML = '';

        var done = 0, okCount = 0, failCount = 0;
        var rows = [];

        function updateBar() {
            var pct = Math.round(done / names.length * 100);
            el.bar.style.width = pct + '%';
            el.pct.textContent = done + '/' + names.length;
        }
        updateBar();

        function addRow(name, ok, msg) {
            rows.push({ name: name, ok: ok, msg: msg });
            var div = document.createElement('div');
            div.style.cssText = 'font-size:11.5px;padding:3px 0;color:' + (ok ? '#9fd8b0' : '#ef8a8a') + ';';
            div.textContent = (ok ? '✓ ' : '✗ ') + name + (msg ? ('  ' + msg) : '');
            el.result.appendChild(div);
        }

        function next() {
            if (stopFlag) { finish(true); return; }
            if (done >= names.length) { finish(false); return; }

            var name = names[done];
            var outPath = outDir.replace(/[\\/]+$/, '') + '/' + safeName(name) + '.xml';

            // 检查是否已存在（提示将覆盖，不阻断）
            var existed = false;
            try { existed = fs && fs.existsSync(outPath); } catch (e) {}

            // 用 Quiet 版本：导出后自动确认 PR 的「转换报告」弹窗，
            // 否则批量导出会卡在每个人的手动确定上。
            var jsx = 'fcExportXMLQuiet(' + JSON.stringify(name) + ',' +
                      JSON.stringify(outPath) + ',600)';
            csEval(jsx, function (raw) {
                var ok = raw && raw.indexOf('OK:') === 0;
                if (ok) { okCount++; addRow(name, true, existed ? '（已覆盖）' : ''); }
                else {
                    failCount++;
                    addRow(name, false, String(raw || '').replace(/^ERR:/, '').slice(0, 90));
                }
                done++;
                updateBar();
                setTimeout(next, 60);      // 给 PR 一点缓冲，避免连续导出卡顿
            });
        }

        function finish(stopped) {
            running = false;
            el.run.disabled = false;
            el.stop.style.display = 'none';
            var tail = '完成 ' + okCount + ' 个' + (failCount ? '，失败 ' + failCount + ' 个' : '');
            if (stopped) tail = '已停止（成功 ' + okCount + ' / 共 ' + names.length + '）';
            setStatus(tail, failCount ? 'err' : 'ok');
            var tip = document.createElement('div');
            tip.className = 'hint';
            tip.style.cssText = 'margin-top:8px;';
            tip.textContent = '输出目录：' + outDir;
            el.result.appendChild(tip);

            // 完成反馈弹窗：带「打开输出目录」，省得再去文件夹里翻
            showDoneDialog(stopped ? tail : tail, outDir, okCount, failCount, names.length);
        }

        // 完成弹窗
        function showDoneDialog(title, dir, ok, fail, total) {
            var old = document.getElementById('bxDoneMask');
            if (old) old.parentNode.removeChild(old);

            var mask = document.createElement('div');
            mask.id = 'bxDoneMask';
            mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10003;' +
                'display:flex;align-items:center;justify-content:center;';

            var box = document.createElement('div');
            box.style.cssText = 'background:#202024;border:1px solid #3d3d45;border-radius:10px;' +
                'width:min(420px,88vw);padding:18px;box-shadow:0 14px 44px rgba(0,0,0,.6);';

            var h = document.createElement('div');
            h.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:10px;color:#e8e8ec;';
            h.textContent = '📦 XML 导出' + (ok + fail >= total ? '完成' : '已停止');

            var body = document.createElement('div');
            body.style.cssText = 'font-size:12.5px;line-height:1.9;color:#b8b8c0;';
            body.innerHTML =
                '成功 <b style="color:#7fd68b">' + ok + '</b> 个' +
                (fail ? '，失败 <b style="color:#ef8a8a">' + fail + '</b> 个' : '') +
                '<br><span style="color:#8a8a95;font-size:11.5px;word-break:break-all;">' + esc(dir) + '</span>';

            var foot = document.createElement('div');
            foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;';

            var bOpen = document.createElement('button');
            bOpen.textContent = '📂 打开目录';
            bOpen.style.cssText = 'padding:7px 14px;border-radius:6px;border:1px solid #46606f;' +
                'background:#2b3a45;color:#bcd9e8;font-size:12px;cursor:pointer;';
            bOpen.onclick = function () {
                try { require('child_process').spawnSync('explorer.exe', [dir], { windowsHide: true }); }
                catch (e) {}
            };

            var bOk = document.createElement('button');
            bOk.textContent = '知道了';
            bOk.style.cssText = 'padding:7px 16px;border-radius:6px;border:1px solid #6d54b8;' +
                'background:#6d54b8;color:#fff;font-size:12px;cursor:pointer;';
            bOk.onclick = function () { if (mask.parentNode) mask.parentNode.removeChild(mask); };

            foot.appendChild(bOpen);
            foot.appendChild(bOk);
            box.appendChild(h);
            box.appendChild(body);
            box.appendChild(foot);
            mask.appendChild(box);
            document.body.appendChild(mask);
        }

        next();
    }

    // ---------- 初始化 ----------
    function pick() {
        el.list = $('bxList');
        el.count = $('bxCount');
        el.outDir = $('bxOutDir');
        el.pickDir = $('bxPickDir');
        el.refresh = $('bxRefresh');
        el.all = $('bxAll');
        el.none = $('bxNone');
        el.run = $('bxRun');
        el.stop = $('bxStop');
        el.progressRow = $('bxProgressRow');
        el.bar = $('bxBar');
        el.pct = $('bxPct');
        el.result = $('bxResult');
    }

    function bind() {
        if (!el.list) return;
        if (el.refresh) el.refresh.onclick = loadSequences;
        if (el.pickDir) el.pickDir.onclick = pickDir;
        if (el.all) el.all.onclick = function () {
            seqs.forEach(function (s) { picked[s.name] = true; });
            renderList();
        };
        if (el.none) el.none.onclick = function () {
            picked = {};
            renderList();
        };
        if (el.run) el.run.onclick = run;
        if (el.stop) el.stop.onclick = function () {
            stopFlag = true;
            el.stop.textContent = '停止中…';
            setTimeout(function () { el.stop.textContent = '停止'; }, 800);
        };
    }

    function init() {
        pick();
        if (!el.list) return;
        bind();
        loadSequences();       // 打开面板就先读一次
    }

    window.__vhBatchXml = {
        onShow: function () {
            if (!el.list) return;
            if (!seqs.length) loadSequences();
            else refreshCount();
        },
        reload: loadSequences
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
