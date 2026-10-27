// vh-Atelier · 音频片段选区（音效库 / 音乐库共用）
// ==========================================================================
// 做什么：在波形上拖出一段选区，然后把「只这一段」插入 PR 时间轴。
//
// 为什么不用 wavesurfer 的 Regions 插件：本机打包的是 wavesurfer 6.4.0，
// 不含 Regions（也未打包插件机制），所以自带实现选区层，不引入新依赖。
//
// 交互设计（关键：不能破坏原有的「点波形从该处播放」）：
//   区分「单击」与「拖动」——
//     · 按下后位移 < 阈值  → 视为单击，走库原有的播放逻辑
//     · 按下后位移 >= 阈值 → 视为拖选，画选区，并吃掉随后那次 click
//   事件挂点说明：
//     mousedown 挂在 waveEl 的【捕获阶段】——waveEl 在事件传播路径上，
//     且不会像覆盖层那样挡住下层 canvas 的点击。
//     视觉层（.vcs-layer）设 pointer-events:none，纯展示，绝不拦截事件。
//
// 插入一律走 insertClip（插入语义）：后续片段往后推，不覆盖已有音频。
(function () {
    if (window.__vhClipSel) return;

    var DRAG_PX = 4;   // 位移超过多少像素算「拖动」

    function fmtSec(s) {
        s = Math.max(0, s || 0);
        var m = Math.floor(s / 60);
        var r = s - m * 60;
        return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
    }

    // 在波形元素上安装选区功能
    // opts: {
    //   waveEl,                  // 波形容器
    //   getDuration(),           // 返回音频时长（秒）
    //   onSend(inSec, outSec),   // 点「送入时间轴」时回调
    //   onChange(inSec, outSec), // 选区变化（可选）
    //   onClear()                // 清除选区（可选）
    // }
    function attach(opts) {
        var waveEl = opts.waveEl;
        if (!waveEl) return null;
        if (waveEl.__clipSel) return waveEl.__clipSel;

        if (!waveEl.style.position) waveEl.style.position = 'relative';

        // ---- 视觉层（不接收事件） ----
        var layer = document.createElement('div');
        layer.className = 'vcs-layer';
        waveEl.appendChild(layer);

        var bar = document.createElement('div');
        bar.className = 'vcs-bar';
        bar.style.display = 'none';
        layer.appendChild(bar);

        var actBar = document.createElement('div');
        actBar.className = 'vcs-actions';
        actBar.style.display = 'none';
        layer.appendChild(actBar);

        var lab = document.createElement('span');
        lab.className = 'vcs-lab';
        actBar.appendChild(lab);

        var btnSend = document.createElement('button');
        btnSend.className = 'vcs-btn';
        btnSend.textContent = '↧ 送入时间轴';
        btnSend.title = '只把选中的这一段插入到播放头位置（插入语义，不覆盖已有音频）';
        actBar.appendChild(btnSend);

        var btnClr = document.createElement('button');
        btnClr.className = 'vcs-btn vcs-btn-x';
        btnClr.textContent = '✕';
        btnClr.title = '清除选区（也可按 Esc）';
        actBar.appendChild(btnClr);

        // ---- 状态 ----
        var st = {
            inSec: null, outSec: null,
            down: false, moved: false,
            x0: 0, y0: 0, r0: 0,
            justDragged: false
        };

        function dur() {
            try { var d = opts.getDuration(); return (isFinite(d) && d > 0) ? d : 0; } catch (e) { return 0; }
        }
        function ratioOf(clientX) {
            var rect = waveEl.getBoundingClientRect();
            if (!rect.width) return 0;
            var r = (clientX - rect.left) / rect.width;
            return r < 0 ? 0 : (r > 1 ? 1 : r);
        }
        function normRange() {
            if (st.inSec === null || st.outSec === null) return null;
            var a = Math.min(st.inSec, st.outSec), b = Math.max(st.inSec, st.outSec);
            return { a: a, b: b };
        }

        function paint() {
            var d = dur();
            var rr = normRange();
            if (!d || !rr) {
                bar.style.display = 'none';
                actBar.style.display = 'none';
                return;
            }
            var pa = rr.a / d, pb = rr.b / d;
            bar.style.display = '';
            bar.style.left = (pa * 100) + '%';
            bar.style.width = Math.max(0.4, (pb - pa) * 100) + '%';

            actBar.style.display = '';
            lab.textContent = fmtSec(rr.a) + '→' + fmtSec(rr.b) + ' (' + (rr.b - rr.a).toFixed(2) + 's)';
            // 操作条贴选区左边缘；太靠右就左移，避免出界
            actBar.style.left = Math.min(pa * 100, 62) + '%';
        }

        function setRange(a, b, silent) {
            st.inSec = a;
            st.outSec = b;
            paint();
            if (!silent && opts.onChange) { try { opts.onChange(a, b); } catch (e) {} }
        }
        function clear(silent) {
            st.inSec = null;
            st.outSec = null;
            paint();
            if (!silent && opts.onClear) { try { opts.onClear(); } catch (e) {} }
        }

        // ---- 按下（捕获阶段，挂在 waveEl 上）----
        waveEl.addEventListener('mousedown', function (ev) {
            if (ev.button !== 0) return;
            // 点在选区操作条上：交给按钮自己处理
            if (ev.target && ev.target.closest && ev.target.closest('.vcs-actions')) return;
            if (!dur()) return;
            st.down = true;
            st.moved = false;
            st.x0 = ev.clientX;
            st.y0 = ev.clientY;
            st.r0 = ratioOf(ev.clientX);
        }, true);

        // ---- 拖动 ----
        document.addEventListener('mousemove', function (ev) {
            if (!st.down) return;
            var dx = ev.clientX - st.x0, dy = ev.clientY - st.y0;
            if (!st.moved && Math.sqrt(dx * dx + dy * dy) < DRAG_PX) return;
            st.moved = true;
            var d = dur();
            if (!d) return;
            var r = ratioOf(ev.clientX);
            setRange(st.r0 * d, r * d);
        });

        document.addEventListener('mouseup', function () {
            if (!st.down) return;
            st.down = false;
            if (st.moved) {
                // 拖选完成：吃掉紧随的 click，避免触发「从该处播放」
                st.justDragged = true;
                setTimeout(function () { st.justDragged = false; }, 280);
            }
        });

        // 拖选后吞掉尾随 click（捕获阶段，赶在库的 handler 之前）
        waveEl.addEventListener('click', function (ev) {
            if (st.justDragged) {
                ev.stopPropagation();
                ev.preventDefault();
            }
        }, true);

        // ---- 按钮 ----
        actBar.addEventListener('mousedown', function (ev) { ev.stopPropagation(); }, true);
        btnSend.addEventListener('click', function (ev) {
            ev.stopPropagation();
            ev.preventDefault();
            var rr = normRange();
            if (!rr || (rr.b - rr.a) < 0.05) return;
            if (opts.onSend) opts.onSend(rr.a, rr.b);
        });
        btnClr.addEventListener('click', function (ev) {
            ev.stopPropagation();
            ev.preventDefault();
            clear();
        });

        // 双击波形空白处清除
        waveEl.addEventListener('dblclick', function (ev) {
            if (ev.target && ev.target.closest && ev.target.closest('.vcs-actions')) return;
            if (normRange()) { ev.stopPropagation(); clear(); }
        }, true);

        // Esc 清除
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape' && normRange()) clear();
        });

        var api = {
            setRange: setRange,
            clear: clear,
            getRange: normRange,
            paint: paint
        };
        waveEl.__clipSel = api;
        return api;
    }

    window.__vhClipSel = { attach: attach, fmtSec: fmtSec };
})();
