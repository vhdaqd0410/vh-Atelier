// vh-Atelier A · PR 样式版本转换 UI
// 依赖 js/style-convert.js（window.__vhStyleConv）
// 放在「素材 → 项目」面板底部
(function () {
    if (!window.__vhStyleConv || !window.__vhProject) return;

    var fs, path;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }

    var S = window.__vhStyleConv;
    var el = {};
    var lastOut = '';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function log(msg, kind) {
        if (!el.scLog) return;
        var d = document.createElement('div');
        d.textContent = msg;
        if (kind === 'err') d.style.color = '#fca5a5';
        else if (kind === 'ok') d.style.color = '#7fd68b';
        el.scLog.appendChild(d);
        el.scLog.scrollTop = el.scLog.scrollHeight;
    }

    // ---------- 选文件（CEP 规范：扩展名字符串数组）----------
    function pickFile(inputEl, title, exts, cb) {
        var res = null;
        try {
            res = window.cep.fs.showOpenDialogEx(false, false, title, inputEl.value || '',
                exts && exts.length ? exts : ['prtextstyle'], '', '选择');
        } catch (e) { log('打开选择器失败：' + e.message, 'err'); return; }
        if (!res || (res.err && res.err !== 0)) return;
        var p = res.data && res.data.length ? res.data[0] : '';
        if (p) { inputEl.value = p; if (cb) cb(p); }
    }

    function bind() {
        el.scSrc = document.getElementById('scSrc');
        el.scTarget = document.getElementById('scTarget');
        el.scApply = document.getElementById('scApply');
        el.scDetect = document.getElementById('scDetect');
        el.scOpenOut = document.getElementById('scOpenOut');
        el.scLog = document.getElementById('scLog');
        el.scSrcVer = document.getElementById('scSrcVer');
        el.scBrowse = document.getElementById('scBrowse');
        if (!el.scSrc) return;

        // 目标版本下拉（只列有实测依据的）
        var html = '';
        S.supported.forEach(function (v) {
            html += '<option value="' + v + '">' + (S.verName[v] || ('v' + v)) + '</option>';
        });
        el.scTarget.innerHTML = html;
        el.scTarget.value = '39';   // 默认给最低的 PR2021

        function showVer(file) {
            var v = S.detect(file);
            if (v) {
                el.scSrcVer.textContent = 'v' + v + '（' + (S.verName[v] || '未知版本') + '）';
                el.scSrcVer.style.color = '#8ec4e0';
            } else {
                el.scSrcVer.textContent = '识别失败';
                el.scSrcVer.style.color = '#fca5a5';
            }
        }

        if (el.scBrowse) {
            el.scBrowse.onclick = function () {
                pickFile(el.scSrc, '选择 PR 文字样式', ['prtextstyle'], function (p) {
                    log('已选择：' + path.basename(p), '');
                    showVer(p);
                });
            };
        }

        el.scDetect.onclick = function () {
            var f = (el.scSrc.value || '').trim();
            if (!f || !fs.existsSync(f)) { log('文件不存在：' + f, 'err'); return; }
            showVer(f);
            log('当前文件版本：' + el.scSrcVer.textContent, 'ok');
        };

        el.scApply.onclick = function () {
            var f = (el.scSrc.value || '').trim();
            if (!f || !fs.existsSync(f)) { log('请先选择样式文件', 'err'); return; }
            var t = parseInt(el.scTarget.value, 10);
            var r = S.convert(f, '', t);
            if (!r.ok) { log('转换失败：' + r.msg, 'err'); return; }
            lastOut = r.out;
            log(r.msg, 'ok');
            (r.log || []).forEach(function (l) { log('  · ' + l, ''); });
            log('输出：' + r.out, 'ok');
            log('（样式内容未改动，仅改版本号；如效果异常请用原文件重转）', '');
            if (el.scOpenOut) el.scOpenOut.style.display = '';
            // 顺便提示放到哪个 PR 用
            var nm = S.verName[t] || ('v' + t);
            log('这个文件给 ' + nm + ' 用。导入方式：PR 里切到「基本图形」→「文字样式」→ 导入样式文件，或直接拖进项目面板。', '');
        };

        if (el.scOpenOut) {
            el.scOpenOut.style.display = 'none';
            el.scOpenOut.onclick = function () {
                if (!lastOut) return;
                try {
                    require('child_process').exec('explorer /select,"' + lastOut + '"', { windowsHide: true });
                } catch (e) { log('打开失败：' + e.message, 'err'); }
            };
        }

        log('把高版本 PR 的文字样式（.prtextstyle）转成低版本能打开的格式。', '');
        log('支持：PR2021 / 2023 / 2025 / 2026（版本号已实测）。', '');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
