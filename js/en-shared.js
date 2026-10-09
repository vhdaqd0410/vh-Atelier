// vh-Atelier 共用：序列选择 + 时间轴区间读取
//
// 背景：「云端去字幕/超分」和「本地去字幕（VSR）」都需要两件相同的事：
//   1) 列出序列并多选
//   2) 从时间轴读一个区间（选中片段 / 入点→出点）
// 这两件事以前只有前者实现，本地去字幕只能整条序列跑。这里抽出来共用，
// 避免复制两套逻辑（复制出来的第二套通常会先腐坏）。
//
// 用法：
//   var clip = window.__vhClip.mount({
//     ns: 'en',                                  // 元素 id 前缀
//     seqListId: 'enSeqList',                    // 序列列表容器
//     refreshBtnId: 'enRefSeq',                  // 刷新按钮
//     grabBtnId: 'enGrabClip',                   // 读取区间按钮
//     clipInfoId: 'enClipInfo',                  // 区间信息展示
//     srcSelectId: 'enClipSrc',                  // 区间来源下拉
//     onLog: function (msg, cls) {}              // 可选：写日志
//   });
//   clip.refreshSeqs();        // 刷新序列列表
//   clip.getCheckedSeqs();     // 取勾选的序列名数组
//   await clip.grab(true);     // 读取区间（silent=不写日志），返回 info 或 null
//   clip.renderInfo();         // 重绘区间提示
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;

    function $(id) { return document.getElementById(id); }

    function evalHost(script) {
        return new Promise(function (resolve) {
            if (!csInterface) { resolve('ERR:当前非 PR 环境'); return; }
            try {
                csInterface.evalScript(script, function (r) { resolve(r == null ? '' : String(r)); });
            } catch (e) { resolve('ERR:' + e.message); }
        });
    }

    function fmtSec(s) {
        s = Number(s);
        if (!isFinite(s) || s < 0) s = 0;
        var m = Math.floor(s / 60), r = s - m * 60;
        return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
    }

    // 每个挂载点一份状态
    function mount(opt) {
        opt = opt || {};
        var el = {
            seqList: $(opt.seqListId),
            refresh: $(opt.refreshBtnId),
            grab: $(opt.grabBtnId),
            info: $(opt.clipInfoId),
            srcSel: $(opt.srcSelectId)
        };
        var state = { seqs: [], checked: [], clip: null };
        var onLog = opt.onLog || function () {};
        var autoGrab = opt.autoGrab !== false;   // 点按钮自动读取

        function srcMode() {
            return (el.srcSel && el.srcSel.value) === 'inout' ? 'inout' : 'selection';
        }

        // ---------- 序列列表 ----------
        function renderSeqs() {
            if (!el.seqList) return;
            if (!state.seqs.length) {
                el.seqList.innerHTML = '<div class="hint" style="padding:4px 6px;">没有序列</div>';
                return;
            }
            el.seqList.innerHTML = '';
            state.seqs.forEach(function (name) {
                var lab = document.createElement('label');
                lab.className = 'en-seq-item' + (state.checked.indexOf(name) >= 0 ? ' checked' : '');
                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = name;
                cb.checked = state.checked.indexOf(name) >= 0;
                cb.addEventListener('change', function () {
                    var i = state.checked.indexOf(name);
                    if (cb.checked) { if (i < 0) state.checked.push(name); }
                    else if (i >= 0) { state.checked.splice(i, 1); }
                    lab.className = 'en-seq-item' + (cb.checked ? ' checked' : '');
                });
                var sp = document.createElement('span');
                sp.textContent = name;
                lab.appendChild(cb);
                lab.appendChild(sp);
                el.seqList.appendChild(lab);
            });
        }

        function refreshSeqs(silent) {
            return evalHost('meListSequences()').then(function (r) {
                if (!r || r.indexOf('OK:') !== 0) {
                    if (!silent) onLog('读取序列失败：' + (r || '无返回'), 'err');
                    return [];
                }
                var arr = [];
                try { arr = JSON.parse(r.slice(3)); } catch (e) {}
                if (!Array.isArray(arr)) arr = [];
                state.seqs = arr;
                // 默认选当前活动序列；没有就选第一个
                var act = '';
                try {
                    if (arr.length && window.__vhActiveSeq) act = window.__vhActiveSeq;
                } catch (e) {}
                state.checked = [];
                if (act && arr.indexOf(act) >= 0) state.checked = [act];
                else if (arr.length) state.checked = [arr[0]];
                renderSeqs();
                if (!silent) onLog('已加载 ' + arr.length + ' 个序列' +
                    (state.checked.length ? ('（默认选 ' + state.checked[0] + '）') : ''), 'ok');
                return arr;
            });
        }

        function getCheckedSeqs() {
            return state.checked.slice();
        }

        // ---------- 区间读取 ----------
        function renderInfo(errMsg) {
            if (!el.info) return;
            if (errMsg) {
                el.info.textContent = '⚠ ' + errMsg;
                el.info.className = 'en-clip-info err';
                el.info.title = errMsg;
                return;
            }
            if (!state.clip) {
                el.info.textContent = (srcMode() === 'inout')
                    ? '未读取（在时间轴按 I / O 设好入出点，再点左侧按钮）'
                    : '未读取（在时间轴选中片段，再点左侧按钮）';
                el.info.className = 'en-clip-info';
                el.info.title = '';
                return;
            }
            var c = state.clip;
            var s0 = (c.startSec != null) ? c.startSec : c.inSec;
            var s1 = (c.endSec != null) ? c.endSec : c.outSec;
            el.info.textContent = c.seqName + ' ｜ ' + fmtSec(s0) + ' → ' + fmtSec(s1) +
                ' （' + fmtSec(c.durationSec) + '）' +
                (c.src === 'inout' ? ' ［入点→出点］' : (c.clipCount > 1 ? ' ［' + c.clipCount + ' 个选中块］' : ''));
            el.info.className = 'en-clip-info has';
            el.info.title = el.info.textContent;
        }

        function grab(silent) {
            var src = srcMode();
            return evalHost(src === 'inout' ? 'meGetSequenceInOut()' : 'meGetSelectedClipInfo()')
                .then(function (r) {
                    if (!r || r.indexOf('OK:') !== 0) {
                        state.clip = null;
                        var em = r ? r.replace(/^ERR:/, '') :
                            (src === 'inout' ? '读取入出点失败（无返回）' : '读取选中片段失败（无返回）');
                        renderInfo(em);
                        if (!silent) onLog('✗ ' + em, 'err');
                        return null;
                    }
                    var info = null;
                    try { info = JSON.parse(r.slice(3)); } catch (e) { info = null; }
                    if (!info) {
                        state.clip = null;
                        renderInfo('区间数据解析失败');
                        if (!silent) onLog('✗ 区间数据解析失败', 'err');
                        return null;
                    }
                    info.src = src;
                    state.clip = info;
                    renderInfo();
                    if (!silent) {
                        var s0 = (info.startSec != null) ? info.startSec : info.inSec;
                        var s1 = (info.endSec != null) ? info.endSec : info.outSec;
                        onLog('✂ 已读取' + (src === 'inout' ? '入出点' : '选中片段') + '：' +
                            info.seqName + ' ｜ ' + fmtSec(s0) + ' → ' + fmtSec(s1) +
                            '（' + fmtSec(info.durationSec) + '）', 'ok');
                    }
                    return info;
                })
                .catch(function (e) {
                    state.clip = null;
                    renderInfo('读取异常：' + e.message);
                    if (!silent) onLog('✗ 抓取异常：' + e.message, 'err');
                    return null;
                });
        }

        // 归一区间字段：选中片段 {startSec,endSec} / 入点出点 {inSec,outSec}
        function normalized() {
            var c = state.clip;
            if (!c) return null;
            var out = {};
            for (var k in c) out[k] = c[k];
            if (out.startSec == null && out.inSec != null) out.startSec = out.inSec;
            if (out.endSec == null && out.outSec != null) out.endSec = out.outSec;
            return out;
        }

        // ---------- 接线 ----------
        if (el.refresh) el.refresh.addEventListener('click', function () { refreshSeqs(false); });
        if (el.srcSel) el.srcSel.addEventListener('change', function () { renderInfo(); });
        if (el.grab && autoGrab) el.grab.addEventListener('click', function () { grab(false); });

        renderInfo();

        return {
            refreshSeqs: refreshSeqs,
            getCheckedSeqs: getCheckedSeqs,
            setChecked: function (arr) { state.checked = (arr || []).slice(); renderSeqs(); },
            grab: grab,
            renderInfo: renderInfo,
            normalized: normalized,
            srcMode: srcMode,
            hasClip: function () { return !!state.clip; },
            clearClip: function () { state.clip = null; renderInfo(); },
            el: el,
            fmtSec: fmtSec
        };
    }

    window.__vhClip = { mount: mount, fmtSec: fmtSec };
})();
