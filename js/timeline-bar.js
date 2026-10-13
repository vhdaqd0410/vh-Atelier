// vh-Atelier 时间线工具条：把常用的 PR 时间线动作做成一排常驻按钮
// 依赖：host.jsx 里的 tl* 函数（tlWorkspaces / tlSetWorkspace / tlDeleteKeyframes /
//       tlDeleteEffects / tlUnnest / tlSwapClips / tlSetIn / tlSetOut /
//       tlInOutFromSelection / tlClearInOut / tlStatus）
(function () {
    'use strict';
    if (window.__vhTimelineBar) return;

    var cs = null;
    try { cs = new CSInterface(); } catch (e) {}

    function call(code, cb) {
        if (!cs) { if (cb) cb('ERR:CSInterface 不可用'); return; }
        try { cs.evalScript(code, function (r) { if (cb) cb(String(r == null ? '' : r)); }); }
        catch (e) { if (cb) cb('ERR:' + e.message); }
    }

    function toast(msg, isErr) {
        try {
            if (window.__copyFlash) { window.__copyFlash(msg); return; }
        } catch (e) {}
        try { console.log('[timeline]', msg); } catch (e2) {}
    }

    // 解析 host 返回
    function run(code, okMsg, cb) {
        call(code, function (r) {
            var ok = r && r.indexOf('OK:') === 0;
            if (!ok) {
                var m = String(r || '').replace(/^ERR:/, '') || '未知错误';
                toast('✗ ' + m, true);
                try {
                    if (window.__vhLog && window.__vhLog.err) window.__vhLog.err('[timeline] 失败：' + m + ' ｜ 原始返回：' + String(r));
                } catch (e2) {}
                if (cb) cb(null, m);
                return;
            }
            var data = null;
            try { data = JSON.parse(r.slice(3)); } catch (e) { data = {}; }
            if (okMsg) toast('✓ ' + okMsg);
            // 关键：把 host 返回的完整数据写进运行日志，便于排查「点了没效果」
            try {
                if (window.__vhLog && window.__vhLog.info) {
                    window.__vhLog.info('[timeline] ' + okMsg + ' → ' + JSON.stringify(data));
                }
            } catch (e2) {}
            if (cb) cb(data, null);
            refresh();
        });
    }

    // 状态显示
    function refresh() {
        var st = document.getElementById('tlStatusText');
        if (!st) return;
        call('tlStatus()', function (r) {
            if (!r || r.indexOf('OK:') !== 0) { st.textContent = '读不到序列'; return; }
            var d = null;
            try { d = JSON.parse(r.slice(3)); } catch (e) { d = null; }
            if (!d) { st.textContent = ''; return; }
            var parts = [];
            if (d.seq) parts.push(d.seq);
            else parts.push('无激活序列');
            parts.push('选中 ' + (d.selCount || 0));
            if (d.inSec >= 0 || d.outSec >= 0) {
                parts.push('I/O ' + (d.inSec >= 0 ? d.inSec.toFixed(2) : '—') + ' ~ '
                    + (d.outSec >= 0 ? d.outSec.toFixed(2) : '—'));
            }
            // QE 不可用时，删效果/位置互换/清 I/O 会失效，这里明确提示
            if (d.qe === false) parts.push('⚠ QE 不可用（删效果/互换将失效）');
            st.textContent = parts.join(' · ');
        });
    }

    var workspacesLoaded = false;

    function loadWorkspaces() {
        var sel = document.getElementById('tlWsSel');
        if (!sel) return;
        call('tlWorkspaces()', function (r) {
            if (!r || r.indexOf('OK:') !== 0) return;
            var d = null;
            try { d = JSON.parse(r.slice(3)); } catch (e) { return; }
            if (!d || !d.list || !d.list.length) return;
            sel.innerHTML = '<option value="">工作区…</option>';
            d.list.forEach(function (n) {
                var o = document.createElement('option');
                o.value = n; o.textContent = n;
                sel.appendChild(o);
            });
            workspacesLoaded = true;
        });
    }

    function build() {
        var host = document.getElementById('tlBar');
        if (!host || host.__built) return;
        host.__built = true;

        var bar = document.createElement('div');
        bar.className = 'tl-bar';

        function btn(id, label, title, fn, cls) {
            var b = document.createElement('button');
            b.type = 'button';
            b.id = id;
            b.className = 'tl-btn' + (cls ? ' ' + cls : '');
            b.textContent = label;
            b.title = title || label;
            b.addEventListener('click', fn);
            bar.appendChild(b);
            return b;
        }

        // 工作区下拉
        var sel = document.createElement('select');
        sel.id = 'tlWsSel';
        sel.className = 'tl-sel';
        sel.title = '切换工作区';
        sel.innerHTML = '<option value="">工作区…</option>';
        sel.addEventListener('change', function () {
            var v = sel.value;
            if (!v) return;
            run('tlSetWorkspace(' + JSON.stringify(v) + ')', '已切到「' + v + '」');
        });
        bar.appendChild(sel);

        // ---- 保留的功能（均为官方 API 可靠支持）----
        // 删全部关键帧：一次清空 + 关掉秒表开关 + 强制刷新界面
        btn('tlDelKeyAll', '删全部关键帧', '删除选中片段所有关键帧，并关掉秒表开关',
            function () { run('tlDeleteKeyframes()', '已删全部关键帧'); });

        var sp = document.createElement('span');
        sp.className = 'tl-sep';
        bar.appendChild(sp);

        // 入点 / 出点：按播放头设置
        btn('tlIn', '入点', '把当前播放头位置设为序列入点',
            function () { run('tlSetIn()', '已设入点'); });
        btn('tlOut', '出点', '把当前播放头位置设为序列出点',
            function () { run('tlSetOut()', '已设出点'); });
        // 按选中片段的整体范围设 I/O
        btn('tlInOutSel', '片段→I/O', '按选中片段的整体范围设置入点出点',
            function () { run('tlInOutFromSelection()', '已按片段设 I/O'); });

        var sp2 = document.createElement('span');
        sp2.className = 'tl-sep';
        bar.appendChild(sp2);

        // 诊断：只读探测，排查用
        btn('tlDiag', '诊断', '只读探测：打印序列/QE/组件/关键帧的真实结构，用于排查',
            function () {
                toast('正在诊断…');
                call('tlProbe()', function (r) {
                    try {
                        var d = null;
                        try { d = JSON.parse(String(r || '').slice(3)); } catch (e) {}
                        if (d && d.lines) {
                            d.lines.forEach(function (ln) {
                                if (window.__vhLog && window.__vhLog.info) window.__vhLog.info('[诊断] ' + ln);
                            });
                        } else if (window.__vhLog && window.__vhLog.info) {
                            window.__vhLog.info('[诊断] ' + String(r));
                        }
                    } catch (e2) {}
                    toast('诊断完成，请看运行日志');
                });
            });


        host.appendChild(bar);

        // 状态行
        var st = document.createElement('div');
        st.id = 'tlStatusText';
        st.className = 'tl-status';
        st.textContent = '读取中…';
        st.title = '当前序列 / 选中片段数 / 入出点';
        st.addEventListener('click', refresh);
        host.appendChild(st);

        loadWorkspaces();
        refresh();
        // 切回工具台/面板时刷新一次
        setInterval(refresh, 5000);
    }

    // 面板可能后加载；等 DOM 就绪
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
    } else {
        build();
    }

    window.__vhTimelineBar = { refresh: refresh, loadWorkspaces: loadWorkspaces };
})();
