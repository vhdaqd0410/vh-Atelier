// vh-Atelier 主版 · 关于与诊断面板
//
// 与客户版（com.vh.atelier.pro）的差异：
//   1) 主版有「进度」「语音克隆」「管理」三个独有面板，功能卡片里要体现；
//   2) 主版没有组件面板，诊断区改报 CosyVoice3 引擎状态（运行时/源码/模型/Python）；
//   3) 客户版报的是「组件就位状态」，两者信息源不同。
//
// 重要：更新状态提示不从达芬奇版搬 —— 那一版曾用 textContent 写 #aboutBody，
//       把整个功能介绍抹成一行字。这里所有写操作都限定在 #aboutVer 与 #aboutDiag
//       两个小容器里，绝不碰 #aboutBody 的正文。
(function () {
    'use strict';

    var fs = null, path = null, os2 = null;
    try {
        fs = require('fs');
        path = require('path');
        os2 = require('os');
    } catch (e) { /* 非 Node 环境，诊断区降级 */ }

    function $(id) { return document.getElementById(id); }

    function extRoot() {
        var r = '';
        try {
            if (typeof CSInterface !== 'undefined') {
                var cs = new CSInterface();
                r = cs.getSystemPath('extension') || '';
            }
        } catch (e) {}
        if (r && fs && fs.existsSync(r)) return r;
        try {
            if (typeof __dirname !== 'undefined') {
                var d = __dirname;
                return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
            }
        } catch (e) {}
        return '';
    }

    function readVersionFile() {
        try {
            var root = extRoot();
            if (!root || !fs || !path) return null;
            var fp = path.join(root, 'version.json');
            if (!fs.existsSync(fp)) return null;
            var raw = fs.readFileSync(fp, 'utf8');
            if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
            return JSON.parse(raw);
        } catch (e) { return null; }
    }

    function hostEnv() {
        var out = {};
        try {
            if (typeof CSInterface !== 'undefined') {
                var cs = new CSInterface();
                var env = cs.getHostEnvironment();
                if (env) {
                    out.hostName = env.appName || '';
                    out.hostVersion = env.appVersion || '';
                }
                out.cepVersion = cs.getCurrentApiVersion ? cs.getCurrentApiVersion() : '';
                out.extensionPath = cs.getSystemPath('extension') || '';
            }
        } catch (e) {}
        return out;
    }

    function runtimeInfo() {
        var out = {};
        try {
            if (typeof process !== 'undefined' && process.versions) {
                out.node = process.versions.node || '';
                out.chrome = process.versions.chrome || '';
            }
        } catch (e) {}
        try {
            if (navigator && navigator.userAgent) {
                var m = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
                if (m) out.chrome = out.chrome || m[1];
            }
        } catch (e) {}
        try {
            out.platform = (os2 && os2.platform) ? os2.platform() : (navigator.platform || '');
            out.arch = (os2 && os2.arch) ? os2.arch() : '';
            out.cpus = (os2 && os2.cpus) ? os2.cpus().length : '';
            out.memGB = (os2 && os2.totalmem) ? Math.round(os2.totalmem() / 1073741824) : '';
            out.hostname = (os2 && os2.hostname) ? os2.hostname() : '';
        } catch (e) {}
        return out;
    }

    // 主版专属：CosyVoice3 引擎状态（客户版已移除语音克隆，没有这个模块）
    function cosyState() {
        try {
            var CE = window.__vhCosyEngine;
            if (!CE || typeof CE.check !== 'function') return null;
            var r = CE.check() || {};
            var lines = [];
            lines.push('  目录：' + (r.root || '（未配置）'));
            if (r.runtime) lines.push('  运行时 _internal：' + (r.runtime.ok ? '就位' : '缺失' + (r.runtime.msg ? '（' + r.runtime.msg + '）' : '')));
            if (r.source) lines.push('  源码 cosyvoice：' + (r.source.ok ? '就位' : '缺失'));
            if (r.model) {
                var mo = r.model.ok ? '就位' : '缺失';
                if (!r.model.ok && r.model.missing && r.model.missing.length) {
                    mo += '（缺 ' + r.model.missing.length + ' 个文件）';
                }
                lines.push('  模型权重：' + mo);
            }
            if (r.python) lines.push('  Python：' + (r.python.ok ? (r.python.path || '就位') : '未找到'));
            if (r.summary) lines.push('  结论：' + r.summary);
            return lines;
        } catch (e) { return ['  读取失败：' + (e.message || e)]; }
    }

    function buildDiagText() {
        var v = readVersionFile() || {};
        var env = hostEnv();
        var rt = runtimeInfo();
        var lines = [];

        lines.push('插件版本：' + (v.version || '?') + (v.branch ? '（' + v.branch + ' 分支）' : ''));
        lines.push('插件目录：' + (env.extensionPath || extRoot() || '?'));
        if (v.buildTime) lines.push('构建时间：' + v.buildTime);

        lines.push('');
        lines.push('—— 宿主环境 ——');
        if (env.hostName) lines.push('宿主：' + env.hostName + (env.hostVersion ? ' ' + env.hostVersion : ''));
        if (env.cepVersion) lines.push('CEP：' + env.cepVersion);
        if (rt.chrome) lines.push('Chromium：' + rt.chrome);
        if (rt.node) lines.push('Node：' + rt.node);
        if (rt.platform) lines.push('平台：' + rt.platform + (rt.arch ? ' / ' + rt.arch : ''));
        if (rt.hostname) lines.push('本机：' + rt.hostname);
        if (rt.cpus) lines.push('CPU 核心：' + rt.cpus + (rt.memGB ? '　内存：' + rt.memGB + ' GB' : ''));

        var cosy = cosyState();
        if (cosy) {
            lines.push('');
            lines.push('—— 语音克隆引擎（CosyVoice3）——');
            lines = lines.concat(cosy);
        }

        return lines.join('\n');
    }

    var opened = false;

    function showAbout() {
        var ov = $('aboutOverlay');
        if (ov) ov.style.display = 'flex';
        opened = true;

        // 只写两个小容器：#aboutVer 与 #aboutDiag。绝不写 #aboutBody
        var verEl = $('aboutVer');
        var diag = $('aboutDiag');

        try {
            var v = readVersionFile();
            if (verEl) verEl.textContent = (v && v.version) ? ('v' + v.version) : 'v?';
        } catch (e) {
            if (verEl) verEl.textContent = 'v?';
        }

        if (diag) {
            diag.textContent = '读取中…';
            setTimeout(function () {
                try { diag.textContent = buildDiagText(); }
                catch (e) { diag.textContent = '诊断读取失败：' + (e.message || e); }
            }, 0);
        }
    }

    function hideAbout() {
        var ov = $('aboutOverlay');
        if (ov) ov.style.display = 'none';
        opened = false;
    }

    function bind() {
        var btn = $('btnAbout');
        if (btn && !btn.__vhBound) {
            btn.__vhBound = true;
            btn.addEventListener('click', showAbout);
        }

        var bcu = $('btnCheckUpdate');
        if (bcu && !bcu.__vhBound) {
            bcu.__vhBound = true;
            bcu.addEventListener('click', function () {
                try {
                    if (window.__vhUpdate && window.__vhUpdate.check) {
                        window.__vhUpdate.check(true);
                    } else {
                        var ub = $('btnUpdate');
                        if (ub) ub.click();
                    }
                } catch (e) {
                    console.log('[about] 检查更新失败: ' + (e && e.message));
                }
            });
        }

        var bc = $('btnCloseAbout');
        if (bc && !bc.__vhBound) {
            bc.__vhBound = true;
            bc.addEventListener('click', hideAbout);
        }

        var ov = $('aboutOverlay');
        if (ov && !ov.__vhBound) {
            ov.__vhBound = true;
            ov.addEventListener('click', function (e) {
                if (e.target === ov) hideAbout();
            });
        }
    }

    function bindEsc() {
        if (window.__vhAboutEscBound) return;
        window.__vhAboutEscBound = true;
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && opened) { hideAbout(); }
        });
    }

    // 主版顶栏有「管理」面板，Esc 可能被别处占用；这里只处理关闭自己的弹窗
    function init() {
        bind();
        bindEsc();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.__vhAbout = { show: showAbout, hide: hideAbout, diag: buildDiagText };
})();
