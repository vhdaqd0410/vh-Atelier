// vh-Atelier 客户版 · 关于与诊断面板
//
// 对齐达芬奇版（com.vh.atelier.resolve）的「关于页」：
//   品牌区 + 一句话定位 + 功能卡片网格 + 亮点列表 + 折叠的运行诊断
//
// 与达芬奇版的差异（因为宿主环境不同）：
//   达芬奇版拿数据走 window.vhHost.appInfo()/ping()（Electron 主进程 IPC）；
//   客户版是 CEP 环境，直接读 version.json + CSInterface + 本地 Node 模块。
//
// 重要：更新状态提示（updMsg）不从达芬奇版搬 —— 那一版曾用 textContent
//       写 #aboutBody，把整个功能介绍抹成一行字。这里所有写操作都限定在
//       #aboutVer 与 #aboutDiag 两个小容器里，绝不碰 #aboutBody 的正文。
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

    // 读插件根下 version.json（客户版更新模块用的是同一个文件）
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

    // CEP 宿主环境（PR 版本、CEP 版本等）
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
                out.myDocuments = cs.getSystemPath('myDocuments') || '';
            }
        } catch (e) {}
        return out;
    }

    function electronish() {
        var out = {};
        try {
            if (typeof process !== 'undefined' && process.versions) {
                out.node = process.versions.node || '';
                out.chrome = process.versions.chrome || '';
                out.v8 = process.versions.v8 || '';
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

    // 组件就位状态（与「组件」面板同源，这里只读不写）
    function componentState() {
        try {
            if (window.__vhComponents && window.__vhComponents.checkAll) {
                var all = window.__vhComponents.checkAll() || {};
                var lines = [];
                Object.keys(all).forEach(function (k) {
                    var it = all[k] || {};
                    var meta = it.meta || {};
                    lines.push('  ' + (it.ready ? '[就位] ' : '[缺失] ') +
                        (meta.name || k) + (meta.size ? '（' + meta.size + '）' : ''));
                });
                return lines;
            }
        } catch (e) {}
        return null;
    }

    function buildDiagText() {
        var v = readVersionFile() || {};
        var env = hostEnv();
        var rt = electronish();
        var lines = [];

        lines.push('插件版本：' + (v.version || '?' ) + (v.branch ? '（' + v.branch + ' 分支）' : ''));
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

        var comps = componentState();
        if (comps && comps.length) {
            lines.push('');
            lines.push('—— 组件状态 ——');
            lines = lines.concat(comps);
        }

        return lines.join('\n');
    }

    var opened = false;

    function showAbout() {
        var ov = $('aboutOverlay');
        if (ov) ov.style.display = 'flex';
        opened = true;

        // 只写两个小容器：#aboutVer（版本徽章）与 #aboutDiag（诊断）
        // 绝不写 #aboutBody —— 那里是功能介绍正文
        var verEl = $('aboutVer');
        var diag = $('aboutDiag');

        try {
            var v = readVersionFile();
            if (verEl && v && v.version) verEl.textContent = 'v' + v.version;
            else if (verEl) verEl.textContent = 'v?';
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

        // 弹窗内「检查更新」→ 走既有更新模块，不自己实现一套
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
            // 点遮罩空白处关闭；点内容区不关
            ov.addEventListener('click', function (e) {
                if (e.target === ov) hideAbout();
            });
        }
    }

    // Esc 关闭（只在打开时生效，避免干扰其它面板的 Esc 逻辑）
    function bindEsc() {
        if (window.__vhAboutEscBound) return;
        window.__vhAboutEscBound = true;
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && opened) { hideAbout(); }
        });
    }

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
