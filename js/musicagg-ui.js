// vh-Atelier 音乐聚合面板（iframe 嵌 lxserver 的 Web 播放器）
//
// 面板本体是 lxserver 自带的完整播放器（多平台搜索 / 歌单 / 歌词 / 播放队列），
// 本文件只负责：确保本地服务在跑 → 把 iframe 指向播放器 → 处理退路入口。
//
// 为什么用 iframe 而非原生面板：播放器功能完整、随 lxserver 版本一起升级，
// 自己重写一遍没有收益。后续若要和音乐库/导入 PR 打通，再在这个面板里加原生区块。
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs;
    try { fs = require('fs'); } catch (e) { return; }

    function $(id) { return document.getElementById(id); }

    var loaded = false;   // iframe 是否已指向播放器
    var loading = false;

    function setStatus(msg, cls) {
        var el = $('maStatus');
        if (el) { el.textContent = msg; el.className = 'ma-status' + (cls ? ' ' + cls : ''); }
    }

    function showFrame(url) {
        var f = $('maFrame');
        if (!f) return;
        if (f.getAttribute('data-cur') !== url) {
            f.setAttribute('data-cur', url);
            f.src = url;
        }
        loaded = true;
    }

    function loadPlayer(force) {
        if (loading) return;
        if (loaded && !force) return;
        var agg = window.__musicAgg;
        if (!agg) { setStatus('音乐聚合模块未加载', 'err'); return; }
        loading = true;
        setStatus('正在启动音乐聚合服务…', '');

        var tries = 0;
        agg.ensure(function (ok, info) {
            loading = false;
            if (ok) {
                showFrame(agg.playerUrl());
                setStatus('已就绪 · 五平台聚合搜索', 'ok');
                var hint = $('maHint');
                if (hint) hint.style.display = 'none';
            } else {
                var msg = '启动失败';
                if (info && info.needDeps) {
                    msg = '缺少依赖（首次使用需联网执行 npm install）。若一直失败，请手动在 lxserver 目录运行：npm install --omit=dev';
                } else if (info && info.error) {
                    msg = '启动失败：' + info.error;
                }
                setStatus(msg, 'err');
                var hint2 = $('maHint');
                if (hint2) hint2.style.display = '';
            }
        }, function (t, m, needInstall) {
            var tip = needInstall
                ? '正在安装依赖（首次，约 1–3 分钟，已等 ' + t + ' 秒）…'
                : '正在启动音乐聚合服务…（' + t + '/' + m + '）';
            setStatus(tip, '');
        });
    }

    function openExternal() {
        var agg = window.__musicAgg;
        if (!agg) return;
        try {
            require('child_process').exec('start "" "' + agg.playerUrl() + '"');
        } catch (e) {
            setStatus('打开外部浏览器失败，请手动访问 ' + agg.playerUrl(), 'err');
        }
    }

    function reload() {
        var f = $('maFrame');
        if (f) { f.removeAttribute('data-cur'); f.src = 'about:blank'; }
        loaded = false;
        setTimeout(function () { loadPlayer(true); }, 200);
    }

    function bind() {
        var b1 = $('btnMaReload');
        if (b1) b1.addEventListener('click', reload);
        var b2 = $('btnMaExternal');
        if (b2) b2.addEventListener('click', openExternal);
        var b3 = $('btnMaRetry');
        if (b3) b3.addEventListener('click', function () { loadPlayer(true); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();

    // main.js 懒加载钩子：切到面板才拉起服务（不在启动时白占内存）
    window.__musicAggOnShow = function () { loadPlayer(false); };
})();
