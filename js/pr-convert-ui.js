// vh-Atelier A · PR 版本转换工具（独立面板）
// 依赖 js/pr-convert.js（window.__vhPrConv）
(function () {
    if (!window.__vhPrConv) return;
    if (!document.getElementById('panel-prconv')) return;

    var fs, path;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }

    var C = window.__vhPrConv;
    var el = {};

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function pick() {
        el.src = document.getElementById('pcSrc');
        el.browse = document.getElementById('pcBrowse');
        el.target = document.getElementById('pcTarget');
        el.apply = document.getElementById('pcApply');
        el.detect = document.getElementById('pcDetect');
        el.openOut = document.getElementById('pcOpenOut');
        el.log = document.getElementById('pcLog');
        el.ver = document.getElementById('pcSrcVer');
        el.kind = document.getElementById('pcKind');
        el.clear = document.getElementById('pcClearLog');
    }

    var lastOut = '';

    function log(msg, kind) {
        if (!el.log) return;
        var d = document.createElement('div');
        d.textContent = msg;
        if (kind === 'err') d.style.color = '#fca5a5';
        else if (kind === 'ok') d.style.color = '#7fd68b';
        else if (kind === 'warn') d.style.color = '#e0c268';
        el.log.appendChild(d);
        el.log.scrollTop = el.log.scrollHeight;
    }

    // CEP 规范：fileTypes 是扩展名字符串数组
    function pickFile(inputEl, title, exts, cb) {
        var res = null;
        try {
            res = window.cep.fs.showOpenDialogEx(false, false, title, inputEl.value || '',
                exts && exts.length ? exts : ['*'], '', '选择');
        } catch (e) { log('打开文件选择器失败：' + e.message, 'err'); return; }
        if (!res || (res.err && res.err !== 0)) return;
        var p = res.data && res.data.length ? res.data[0] : '';
        if (p) { inputEl.value = p; if (cb) cb(p); }
    }

    function showDetect(file) {
        var d = C.detect(file);
        if (d.err) {
            el.ver.textContent = '⚠ ' + d.err;
            el.ver.style.color = '#e0c268';
            return;
        }
        if (!d.ver) {
            el.ver.textContent = '识别失败（可能不是 PR 文件）';
            el.ver.style.color = '#fca5a5';
            return;
        }
        var ext = (file.match(/\.(\w+)$/) || [, ''])[1].toLowerCase();
        var kindTxt = ext === 'prproj' ? 'PR 工程' : (ext === 'prtextstyle' ? 'PR 文字样式' : ext);
        el.ver.textContent = kindTxt + ' · v' + d.ver + '（' + (C.verName[d.ver] || '未知') + '）';
        el.ver.style.color = '#8ec4e0';
        if (C.supported.indexOf(d.ver) < 0 && d.ver) {
            log('提示：源文件版本 v' + d.ver + ' 不在已知列表里，仍可尝试转换', 'warn');
        }
    }

    function bind() {
        pick();
        if (!el.src) return;

        // 目标版本：默认 PR2021（高版本能开低版本，转最低够用）
        var html = '';
        C.supported.forEach(function (v) {
            html += '<option value="' + v + '">' + (C.verName[v] || ('v' + v)) + '</option>';
        });
        el.target.innerHTML = html;
        el.target.value = '39';

        el.browse.onclick = function () {
            pickFile(el.src, '选择 PR 文件（样式或工程）', C.exts, function (p) {
                log('已选择：' + path.basename(p), '');
                showDetect(p);
            });
        };

        el.detect.onclick = function () {
            var f = (el.src.value || '').trim();
            if (!f || !fs.existsSync(f)) { log('文件不存在：' + f, 'err'); return; }
            showDetect(f);
            log('识别结果：' + el.ver.textContent, 'ok');
        };

        el.apply.onclick = function () {
            var f = (el.src.value || '').trim();
            if (!f || !fs.existsSync(f)) { log('请先选择文件', 'err'); return; }
            var t = parseInt(el.target.value, 10);
            var r = C.convert(f, '', t);
            if (!r.ok) { log('转换失败：' + r.msg, 'err'); return; }
            lastOut = r.out;
            log(r.msg, 'ok');
            (r.log || []).forEach(function (l) { log('  · ' + l, ''); });
            log('输出：' + r.out, 'ok');
            log('已保留原文件，转换的是新文件。', '');
            var nm = C.verName[t] || ('v' + t);
            log('给 ' + nm + ' 用：' + (r.how === 'gzip' ? '工程文件直接打开；' : '') +
                '样式文件在 PR「基本图形 → 文字样式」里导入，或拖进项目面板。', '');
            if (el.openOut) el.openOut.style.display = '';
        };

        el.openOut.onclick = function () {
            if (!lastOut) return;
            try { require('child_process').exec('explorer /select,"' + lastOut + '"', { windowsHide: true }); }
            catch (e) { log('打开失败：' + e.message, 'err'); }
        };

        el.clear.onclick = function () { el.log.innerHTML = ''; };

        log('把高版本 PR 的文件转成低版本能打开的格式。', '');
        log('支持 .prtextstyle（文字样式）与 .prproj（工程文件）。', '');
        log('可选目标：' + C.supported.map(function (v) { return C.verName[v]; }).join(' / '), '');
        log('默认转 PR 2021 —— 高版本一定能打开低版本，转最低够用。', '');
    }

    window.__prconvOnShow = function () {
        if (!el.src) pick();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
