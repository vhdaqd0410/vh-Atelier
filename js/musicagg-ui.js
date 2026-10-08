// vh-Atelier 音乐聚合面板（iframe 嵌 lxserver 的 Web 播放器）
//
// 面板本体是 lxserver 自带的完整播放器（多平台搜索 / 歌单 / 歌词 / 播放队列），
// 本文件负责：选择本地/服务器 → 确保目标可用 → 把 iframe 指向播放器 →
//             跟随 PR 主题注入深色模式 → 处理退路入口。
(function () {
    'use strict';
    if (typeof window === 'undefined') return;
    var fs, path;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }

    function $(id) { return document.getElementById(id); }

    var loaded = false;
    var loading = false;

    function setStatus(msg, cls) {
        var el = $('maStatus');
        if (el) { el.textContent = msg; el.className = 'ma-status' + (cls ? ' ' + cls : ''); }
        var dot = $('maDot');
        if (dot) dot.className = 'ma-dot' + (cls === 'ok' ? ' ok' : (cls === 'err' ? ' err' : ''));
    }

    // 是否深色主题：读 PR/插件根元素上的标记
    function isDark() {
        try {
            var html = document.documentElement;
            if (html.classList.contains('dark') || html.classList.contains('theme-dark')) return true;
            var body = document.body;
            if (body && (body.classList.contains('dark') || body.classList.contains('theme-dark'))) return true;
            // 看 CSS 变量的背景色亮度（无标记时兜底）
            var v = getComputedStyle(document.documentElement).getPropertyValue('--bg') ||
                    getComputedStyle(document.body).backgroundColor || '';
            var m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(v);
            if (m) {
                var lum = (parseInt(m[1], 10) * 299 + parseInt(m[2], 10) * 587 + parseInt(m[3], 10) * 114) / 1000;
                return lum < 128;
            }
        } catch (e) {}
        return false;
    }

    // lxserver 的播放器自带主题（localStorage / prefers-color-scheme）。
    // 通过 URL 传参不生效，故在 iframe 加载后（同源时）注入偏好。
    // 本地/服务器都是我们自己的服务，但 CEP 里 iframe 属跨源，无法直接写 localStorage。
    // 折中：用 postMessage 通知播放器（播放器若不处理则无害），并在面板上给出主题按钮。
    function applyTheme() {
        var f = $('maFrame');
        if (!f || !f.contentWindow) return;
        try {
            f.contentWindow.postMessage({ type: 'vh-set-theme', dark: isDark() }, '*');
        } catch (e) {}
    }

    function showFrame(url) {
        var f = $('maFrame');
        if (!f) return;
        if (f.getAttribute('data-cur') !== url) {
            f.setAttribute('data-cur', url);
            f.src = url;
            try { f.onload = function () { setTimeout(applyTheme, 300); }; } catch (e) {}
        }
        loaded = true;
    }

    function describeTarget() {
        var agg = window.__musicAgg;
        var t = agg.getTarget();
        if (t === 'server') {
            var s = agg.getServerUrl();
            return s ? ('服务器 · ' + s.replace(/^https?:\/\//, '')) : '服务器（未填地址）';
        }
        return '本地服务';
    }

    function loadPlayer(force) {
        if (loading) return;
        if (loaded && !force) return;
        var agg = window.__musicAgg;
        if (!agg) { setStatus('音乐聚合模块未加载', 'err'); return; }

        var url = agg.playerUrl();
        if (!url) {
            setStatus('请先填写服务器地址', 'err');
            var hh = $('maHint'); if (hh) hh.style.display = '';
            return;
        }

        loading = true;
        setStatus('正在连接' + describeTarget() + '…', '');

        agg.ensure(function (ok, info) {
            loading = false;
            if (ok) {
                showFrame(agg.playerUrl());
                setStatus('已就绪 · ' + describeTarget() + ' · 五平台聚合搜索', 'ok');
                var hint = $('maHint');
                if (hint) hint.style.display = 'none';
            } else {
                var msg;
                if (info && info.target === 'server') {
                    msg = '连不上服务器（' + (info.error || '超时') + '）。请确认服务已启动、安全组已放行端口。';
                } else if (info && info.needDeps) {
                    msg = '缺少依赖（首次使用需联网执行 npm install）。若一直失败，请手动在 lxserver 目录运行：npm install --omit=dev';
                } else {
                    msg = '启动失败：' + ((info && info.error) || '未知原因');
                }
                setStatus(msg, 'err');
                var hint2 = $('maHint');
                if (hint2) hint2.style.display = '';
            }
        }, function (t, m, needInstall) {
            var tip = needInstall
                ? '正在安装依赖（首次，约 1–3 分钟，已等 ' + t + ' 秒）…'
                : ('正在连接' + describeTarget() + '…（' + t + '/' + m + '）');
            setStatus(tip, '');
        });
    }

    function openExternal() {
        var agg = window.__musicAgg;
        if (!agg) return;
        var u = agg.playerUrl();
        if (!u) { setStatus('请先填写服务器地址', 'err'); return; }
        try { require('child_process').exec('start "" "' + u + '"'); }
        catch (e) { setStatus('打开外部浏览器失败，请手动访问 ' + u, 'err'); }
    }

    function reload() {
        var f = $('maFrame');
        if (f) { f.removeAttribute('data-cur'); f.src = 'about:blank'; }
        loaded = false;
        setTimeout(function () { loadPlayer(true); }, 200);
    }

    // 切换目标（本地/服务器）
    function onTargetChange() {
        var sel = $('maTarget');
        if (!sel) return;
        window.__musicAgg.setTarget(sel.value);
        var rowSrv = $('maServerRow');
        if (rowSrv) rowSrv.style.display = (sel.value === 'server') ? '' : 'none';
        // 音源包只在本地模式有意义
        var rowSrc = $('maSrcRow');
        if (rowSrc) rowSrc.style.display = (sel.value === 'server') ? 'none' : '';
        refreshSrcCount();
        // 切换后强制重载
        var f = $('maFrame');
        if (f) { f.removeAttribute('data-cur'); f.src = 'about:blank'; }
        loaded = false;
        loadPlayer(true);
    }

    function saveServer() {
        var inp = $('maServerUrl');
        if (!inp) return;
        window.__musicAgg.setServerUrl(inp.value);
        setStatus('服务器地址已保存', 'ok');
        reload();
    }

    // 显示本机音源数量（仅本地模式有意义）
    function refreshSrcCount() {
        var el = $('maSrcCount');
        if (!el) return;
        try {
            var agg = window.__musicAgg;
            if (!agg || agg.getTarget() !== 'local') { el.textContent = ''; return; }
            var dir = path.join(agg.sourceDir(), '_open');
            var n = fs.existsSync(dir)
                ? fs.readdirSync(dir).filter(function (f) { return /\.js$/i.test(f); }).length
                : 0;
            el.textContent = n ? ('本机已有 ' + n + ' 个音源') : '本机还没有音源，可导入音源包';
        } catch (e) { el.textContent = ''; }
    }

    function bind() {
        var sel = $('maTarget');
        if (sel) {
            sel.value = window.__musicAgg.getTarget();
            sel.addEventListener('change', onTargetChange);
        }
        var inp = $('maServerUrl');
        if (inp) inp.value = window.__musicAgg.getServerUrl();
        var rowSrv = $('maServerRow');
        if (rowSrv) rowSrv.style.display = (window.__musicAgg.getTarget() === 'server') ? '' : 'none';
        var rowSrc0 = $('maSrcRow');
        if (rowSrc0) rowSrc0.style.display = (window.__musicAgg.getTarget() === 'server') ? 'none' : '';

        var b1 = $('btnMaReload'); if (b1) b1.addEventListener('click', reload);
        var b2 = $('btnMaExternal'); if (b2) b2.addEventListener('click', openExternal);
        var b3 = $('btnMaRetry'); if (b3) b3.addEventListener('click', function () { loadPlayer(true); });
        var b4 = $('btnMaSaveServer'); if (b4) b4.addEventListener('click', saveServer);
        var b5 = $('btnMaTheme'); if (b5) b5.addEventListener('click', function () {
            applyTheme();
            setStatus('已尝试同步主题（播放器若未响应，可在播放器内单独设置）', 'ok');
        });

        // 音源包：导出 / 一键导入
        var b6 = $('btnMaExportSrc');
        if (b6) b6.addEventListener('click', function () {
            setStatus('请选择音源包的保存位置…', '');
            window.__musicAgg.exportSources(function (ok, info) {
                if (ok) setStatus('音源包已导出到：' + info, 'ok');
                else setStatus('导出未完成（' + info + '）', 'err');
            });
        });
        var b7 = $('btnMaImportSrc');
        if (b7) b7.addEventListener('click', function () {
            setStatus('请选择音源包（zip）…', '');
            window.__musicAgg.importSources(function (ok, info) {
                if (ok) {
                    var s = info || {};
                    setStatus('导入完成：新增 ' + (s.added || 0) + ' 个，跳过 ' + (s.skipped || 0) + ' 个（同名不覆盖）', 'ok');
                    refreshSrcCount();
                    setTimeout(reload, 800);
                } else {
                    setStatus('导入未完成（' + info + '）', 'err');
                }
            });
        });
        refreshSrcCount();

        // 监听主题变化（MutationObserver 太重的场景不做，切面板时同步一次即可）
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();

    window.__musicAggOnShow = function () { loadPlayer(false); setTimeout(applyTheme, 800); };
})();
