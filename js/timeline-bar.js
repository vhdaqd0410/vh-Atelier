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
                if (cb) cb(null, m);
                return;
            }
            var data = null;
            try { data = JSON.parse(r.slice(3)); } catch (e) { data = {}; }
            if (okMsg) toast('✓ ' + okMsg);
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

        // 删全部关键帧（一次清空 + 关掉秒表开关 + 强制刷新界面）
        btn('tlDelKeyAll', '删全部关键帧', '删除选中片段所有关键帧，并关掉秒表开关',
            function () { run('tlDeleteKeyframes()', '已删全部关键帧'); });
        btn('tlDelFx', '删全部效果', '删除选中片段上的全部效果',
            function () { run('tlDeleteEffects()', '已删全部效果'); });
        btn('tlUnnest', '解除嵌套', '把嵌套序列里的内容展开，替换掉嵌套片段',
            function () { run('tlUnnest()', '已解除嵌套'); });
        btn('tlSwap', '位置互换', '两个选中的片段在时间轴上互换位置（不是画面翻转）',
            function () { run('tlSwapClips()', '已互换位置'); });

        // 分隔
        var sp = document.createElement('span');
        sp.className = 'tl-sep';
        bar.appendChild(sp);

        btn('tlIn', '入点', '把当前播放头位置设为序列入点',
            function () { run('tlSetIn()', '已设入点'); });
        btn('tlOut', '出点', '把当前播放头位置设为序列出点',
            function () { run('tlSetOut()', '已设出点'); });
        btn('tlInOutSel', '片段→I/O', '按选中片段的整体范围设置入点出点',
            function () { run('tlInOutFromSelection()', '已按片段设 I/O'); });
        btn('tlClearIo', '清 I/O', '清除序列的入点和出点',
            function () { run('tlClearInOut()', '已清除 I/O'); });

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
