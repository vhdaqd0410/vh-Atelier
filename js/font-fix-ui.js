// vh-Atelier · 字体修复 UI（挂在 PR 工具面板里）
// 依赖 js/font-install.js（window.__vhFont）+ js/font-fix.js（window.__vhFontFix）
(function () {
    if (!window.__vhFont) return;
    if (!document.getElementById('pcFontBox')) return;

    var fs, path;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }

    var F = window.__vhFont;
    var X = window.__vhFontFix;
    var el = {};

    function log(msg, kind) {
        var box = document.getElementById('pcLog');
        if (!box) return;
        var d = document.createElement('div');
        d.textContent = msg;
        if (kind === 'err') d.style.color = '#fca5a5';
        else if (kind === 'ok') d.style.color = '#7fd68b';
        else if (kind === 'warn') d.style.color = '#e0c268';
        box.appendChild(d);
        box.scrollTop = box.scrollHeight;
    }

    function refreshStatus() {
        var st = F.status();
        if (!el.status) return;
        if (st.installed && st.reg) {
            el.status.innerHTML = '<span style="color:#7fd68b">✅ 已安装</span> · Bahnschrift Bold';
            el.btnInstall.textContent = '重新安装';
            el.btnUninstall.style.display = '';
        } else if (st.installed) {
            el.status.innerHTML = '<span style="color:#e0c268">⚠ 已装文件但未登记</span>';
            el.btnInstall.textContent = '修复安装';
            el.btnUninstall.style.display = '';
        } else {
            el.status.innerHTML = '<span style="color:#9a9a9a">未安装</span>';
            el.btnInstall.textContent = '安装字体';
            el.btnUninstall.style.display = 'none';
        }
        if (!st.hasAsset) {
            el.status.innerHTML = '<span style="color:#fca5a5">✗ 插件内缺字体文件</span>';
        }
    }

    function bind() {
        el.status = document.getElementById('pcFontStatus');
        el.btnInstall = document.getElementById('pcFontInstall');
        el.btnUninstall = document.getElementById('pcFontUninstall');
        el.btnScan = document.getElementById('pcFontScan');
        if (!el.status) return;

        el.btnInstall.onclick = function () {
            log('正在安装字体…', '');
            var r = F.install();
            if (!r.ok) { log('安装失败：' + r.msg, 'err'); return; }
            log(r.msg, 'ok');
            log('  文件：' + r.file, '');
            log('  注册表：' + (r.reg ? '已登记' : '登记失败（不影响使用）'), r.reg ? '' : 'warn');
            log('  ' + r.notify, '');
            log('★ 请重启 Premiere Pro 后打开样式验证（PR 只在启动时扫描字体）', 'warn');
            refreshStatus();
        };

        el.btnUninstall.onclick = function () {
            var r = F.uninstall();
            if (!r.ok) { log('卸载失败：' + r.msg, 'err'); return; }
            log(r.msg, 'ok');
            log('★ 重启 PR 后彻底生效', 'warn');
            refreshStatus();
        };

        el.btnScan.onclick = function () {
            var f = (document.getElementById('pcSrc') || {}).value || '';
            f = f.trim();
            if (!f || !fs.existsSync(f)) { log('请先在上面选择样式文件', 'err'); return; }
            if (!X) { log('字体修复模块未就绪', 'err'); return; }
            try {
                var text = fs.readFileSync(f, 'utf8');
                var names = X.listFontNames(text);
                var keys = Object.keys(names);
                if (!keys.length) { log('没扫到字体名（可能不是文字样式文件）', 'warn'); return; }
                log('样式里引用的字体：', '');
                keys.forEach(function (k) {
                    var fix = X.len16Map[k];
                    log('  · ' + k + (fix ? '  → 可替换为 "' + fix + '"' : ''), fix ? 'ok' : '');
                });
                if (!keys.some(function (k) { return X.len16Map[k]; })) {
                    log('提示：没有可自动替换的字体（需等长名字才能安全替换）', 'warn');
                }
            } catch (e) {
                log('读取失败：' + e.message, 'err');
            }
        };

        refreshStatus();
    }

    window.__fontFixOnShow = function () { refreshStatus(); };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
