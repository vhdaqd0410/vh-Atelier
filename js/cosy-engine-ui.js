// vh-Atelier 客户版 · 语音克隆引擎状态 UI
// 职责：把 cosy-engine.js 的检测结果翻译成「用户能看懂 + 知道下一步做什么」的界面
(function () {
    'use strict';

    var fs, path, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        childProcess = require('child_process');
    } catch (e) { return; }

    function $(id) { return document.getElementById(id); }
    var el = {};
    var lastResult = null;

    function initEl() {
        el.card = $('ceCard');
        el.dot = $('ceDot');
        el.text = $('ceText');
        el.detail = $('ceDetail');
        el.steps = $('ceSteps');
        el.config = $('ceConfig');
        el.rootInput = $('ceRootInput');
        el.btnRecheck = $('ceRecheck');
        el.btnRetry = $('ceRetry');
        el.btnSetup = $('ceSetup');
        el.btnBrowse = $('ceBrowse');
        el.btnRootBrowse = $('ceRootBrowse');
        el.btnRootSave = $('ceRootSave');
        el.btnRootAuto = $('ceRootAuto');
    }

    // 缺什么、要做什么，一条一条列出来
    function buildSteps(r) {
        var rows = [];

        function row(ok, text, sub) {
            rows.push({ ok: ok, text: text, sub: sub || '' });
        }

        var hasAny = !!r.root;
        row(hasAny && r.runtime.ok, '运行时（_internal / torch）',
            r.runtime.ok ? '' : '整合包里的 _internal 文件夹');
        row(hasAny && r.source.ok, 'cosyvoice 源码',
            r.source.ok ? '' : '整合包里的 cosyvoice 文件夹');
        row(hasAny && r.model.ok, '模型权重（pretrained_models）',
            r.model.ok ? '' : (r.model.missing.length ? ('缺 ' + r.model.missing.join('、')) : ''));
        row(r.python.ok, 'Python 3.10',
            r.python.ok ? '' : '需要安装 Python 3.10（cosyvoice 依赖它）');

        return rows;
    }

    function render(r) {
        lastResult = r;
        if (!el.dot) return;

        var ok = r.canRun;
        var cls = ok ? 'ok' : (r.action === 'no-root' || r.action === 'bad-root' ? 'err' : 'warn');

        el.dot.className = 'ce-dot ' + cls;
        el.text.className = 'ce-text ' + cls;

        if (ok) {
            el.text.textContent = '引擎就绪　' + shortRoot(r.root);
            el.text.title = r.root;   // 悬停看完整路径
            if (el.detail) el.detail.style.display = 'none';
            if (el.config) el.config.style.display = 'none';
            return;
        }

        // 不 ok：显示具体问题
        el.text.textContent = r.summary || '引擎未就绪';
        if (el.detail) el.detail.style.display = '';

        // 步骤列表
        if (el.steps) {
            el.steps.innerHTML = '';
            var rows = buildSteps(r);
            rows.forEach(function (x) {
                var d = document.createElement('div');
                d.className = 'ce-step' + (x.ok ? '' : ' miss');
                var ic = document.createElement('span');
                ic.className = 'ic';
                ic.textContent = x.ok ? '✅' : '⬜';
                var tx = document.createElement('span');
                tx.className = 'tx';
                tx.textContent = x.text;
                if (x.sub) {
                    var sb = document.createElement('div');
                    sb.className = 'sub';
                    sb.textContent = x.sub;
                    tx.appendChild(sb);
                }
                d.appendChild(ic);
                d.appendChild(tx);
                el.steps.appendChild(d);
            });

            // 补一句「怎么办」
            var tip = document.createElement('div');
            tip.style.cssText = 'margin-top:7px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.1);color:#8a9bab;';
            tip.innerHTML = hintFor(r);
            el.steps.appendChild(tip);
        }
    }

    // 路径展示：保留盘符前缀 + 末尾目录名，中间省略
    // 例：D:\cosyvoice3_V30 → D:\…\cosyvoice3_V30（短路径原样显示）
    function shortRoot(p) {
        p = String(p || '');
        if (p.length <= 30) return p;
        var parts = p.split(/[\\/]/).filter(function (x) { return x; });
        if (parts.length <= 2) return p;
        var head = parts[0];           // 通常是 "D:"
        var tail = parts[parts.length - 1];
        return head + '\\…\\' + tail;
    }

    // 针对不同缺失情况给不同的行动建议
    function hintFor(r) {
        switch (r.action) {
            case 'no-root':
                return '点下面「选择 CosyVoice3 目录」指定安装位置，或先安装 CosyVoice3 整合包。';
            case 'bad-root':
                return '填写的目录不存在。点「设置」重新指定，或安装 CosyVoice3 到默认位置 D:\\cosyvoice3_V30。';
            case 'no-runtime':
                return '这个目录里没有完整的 <code>_internal</code> 运行时。<br>如果你装的是精简版（只有模型），需要额外放一份运行时；<br>建议直接安装官方 CosyVoice3 整合包。';
            case 'no-source':
                return '缺少 <code>cosyvoice</code> 源码目录。整合包应包含它，可能是解压不完整。';
            case 'no-model':
                return '模型文件不完整。到「组件」面板下载语音克隆模型，或重新解压整合包。';
            case 'no-python':
                return '没找到 Python 3.10。需要装 <code>Python 3.10</code>（64 位），装完点「重新检测」。';
            default:
                return '点「重新检测」再试，或点「设置」检查目录是否正确。';
        }
    }

    function doCheck(silent) {
        var eng = window.__vhCosyEngine;
        if (!eng) {
            if (el.text) el.text.textContent = '引擎检测模块未加载';
            return null;
        }
        var r = null;
        try {
            r = eng.check();
        } catch (e) {
            if (el.text) el.text.textContent = '检测出错：' + e.message;
            return null;
        }
        render(r);
        if (!silent && r.canRun) {
            try { window.__vhFlash && window.__vhFlash('引擎就绪'); } catch (e) {}
        }
        return r;
    }

    // 浏览目录（用 PowerShell 文件夹选择器，绕开编码坑）
    function browseDir(cb) {
        var ps = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
            '$d.Description = "选择 CosyVoice3 目录（含 _internal / cosyvoice / pretrained_models）"',
            'if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath }'
        ].join('; ');
        try {
            var r = childProcess.spawnSync('powershell', ['-NoProfile', '-STA', '-Command', ps],
                                           { encoding: 'utf8', timeout: 120000, windowsHide: false });
            var out = String(r.stdout || '').trim().split(/\r?\n/).pop().trim();
            if (out && fs.existsSync(out)) { cb(out); return; }
        } catch (e) {}
        cb('');
    }

    function bind() {
        initEl();
        if (!el.dot) return;   // 面板不在

        doCheck(true);

        if (el.btnRecheck) el.btnRecheck.addEventListener('click', function () { doCheck(); });
        if (el.btnRetry) el.btnRetry.addEventListener('click', function () { doCheck(); });

        // 设置面板开关
        if (el.btnSetup) {
            el.btnSetup.addEventListener('click', function () {
                if (!el.config) return;
                var show = el.config.style.display === 'none';
                el.config.style.display = show ? '' : 'none';
                if (show && el.rootInput) {
                    el.rootInput.value = window.__vhCosyEngine ? window.__vhCosyEngine.getRoot() : '';
                    el.rootInput.focus();
                }
            });
        }

        // 直接选目录并保存
        if (el.btnBrowse) {
            el.btnBrowse.addEventListener('click', function () {
                browseDir(function (p) {
                    if (!p) return;
                    window.__vhCosyEngine.setRoot(p);
                    doCheck();
                });
            });
        }

        if (el.btnRootBrowse) {
            el.btnRootBrowse.addEventListener('click', function () {
                browseDir(function (p) {
                    if (p && el.rootInput) el.rootInput.value = p;
                });
            });
        }

        if (el.btnRootSave) {
            el.btnRootSave.addEventListener('click', function () {
                var v = el.rootInput ? el.rootInput.value.trim() : '';
                window.__vhCosyEngine.setRoot(v);
                if (el.config) el.config.style.display = 'none';
                doCheck();
            });
        }

        if (el.btnRootAuto) {
            el.btnRootAuto.addEventListener('click', function () {
                window.__vhCosyEngine.clearRoot();
                var auto = window.__vhCosyEngine.getRoot();
                if (el.rootInput) el.rootInput.value = auto;
                if (el.config) el.config.style.display = 'none';
                doCheck();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    // 切到克隆面板时重新检测（用户可能刚装了整合包）
    window.__cloneEngineOnShow = function () { doCheck(true); };

    window.__vhCloneEngineUI = {
        check: doCheck,
        last: function () { return lastResult; }
    };
})();
