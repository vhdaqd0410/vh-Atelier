// vh-Atelier 音乐聚合 · 原生面板（简洁模式）
//
// 与 iframe（完整播放器）互补：这里只做「搜歌 → 试听 → 下载 / 插入时间轴」这条干活链路，
// 界面与插件一致、深色模式跟随、能与音乐库和 PR 打通。
//
// 数据来源：浏览器直连 lxserver 的 REST API（CORS 已放行）。
//   GET  /api/music/search?source=&name=&type=song&limit=
//   POST /api/music/url      body { songInfo, quality }
//   GET  /api/music/lyric?source=&songmid=
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        childProcess = require('child_process');
    } catch (e) { return; }

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function flash(msg, type) {
        var el = $('mv2Toast');
        if (!el) return;
        el.textContent = msg;
        el.className = 'mv2-toast' + (type ? ' ' + type : '');
        el.style.display = '';
        clearTimeout(el._t);
        el._t = setTimeout(function () { el.style.display = 'none'; }, 2800);
    }
    function setState(msg, cls) {
        var el = $('mv2State');
        if (el) { el.textContent = msg || ''; el.className = 'mv2-state' + (cls ? ' ' + cls : ''); }
    }

    var PLATFORMS = [
        { id: 'wy', name: '网易云' },
        { id: 'tx', name: 'QQ' },
        { id: 'kw', name: '酷我' },
        { id: 'kg', name: '酷狗' },
        { id: 'mg', name: '咪咕' }
    ];
    var curPlatform = 'wy';     // 当前平台；'' 表示全部
    var results = [];           // 当前结果
    var curSong = null;         // 选中/正在试听的歌
    var ws = null, wsPlaying = false;   // wavesurfer 实例

    function api(p, opt) {
        var agg = window.__musicAgg;
        if (!agg) return Promise.reject(new Error('音乐聚合模块未加载'));
        return agg.api(p, opt);
    }

    // ---------- 搜索 ----------
    function doSearch() {
        var kw = ($('mv2Query').value || '').trim();
        if (!kw) { flash('请输入歌名或歌手'); return; }
        var box = $('mv2List');
        setState('正在搜索…', '');
        box.innerHTML = '<div class="hint" style="padding:14px;">搜索中…</div>';

        if (!curPlatform) {
            // 全部平台：并发搜索后合并
            var all = [], done = 0;
            PLATFORMS.forEach(function (pf) {
                api('/api/music/search?source=' + pf.id + '&name=' + encodeURIComponent(kw) + '&type=song&limit=12')
                    .then(function (r) {
                        var lst = Array.isArray(r) ? r : ((r && r.data) || []);
                        lst.forEach(function (s) { all.push(s); });
                    }).catch(function () {})
                    .then(function () {
                        done++;
                        if (done === PLATFORMS.length) {
                            results = all;
                            renderList();
                            setState('共 ' + all.length + ' 条（' + PLATFORMS.length + ' 个平台）', 'ok');
                        }
                    });
            });
            return;
        }

        api('/api/music/search?source=' + curPlatform + '&name=' + encodeURIComponent(kw) + '&type=song&limit=30')
            .then(function (r) {
                results = Array.isArray(r) ? r : ((r && r.data) || []);
                renderList();
                setState('共 ' + results.length + ' 条', 'ok');
            }).catch(function (e) {
                box.innerHTML = '<div class="hint" style="padding:14px;color:#f6a1b1;">搜索失败：' + esc(e.message) + '</div>';
                setState('搜索失败', 'err');
            });
    }

    function srcLabel(s) {
        for (var i = 0; i < PLATFORMS.length; i++) { if (PLATFORMS[i].id === s) return PLATFORMS[i].name; }
        return s || '';
    }

    function renderList() {
        var box = $('mv2List');
        if (!results.length) {
            box.innerHTML = '<div class="hint" style="padding:14px;">没有结果</div>';
            return;
        }
        box.innerHTML = '';
        results.forEach(function (s, idx) {
            var row = document.createElement('div');
            row.className = 'sep-res-item';
            row.setAttribute('data-idx', String(idx));
            row.setAttribute('draggable', 'false');

            // 试听
            var play = document.createElement('button');
            play.type = 'button';
            play.className = 'sep-res-play';
            play.textContent = '\u25b6';
            play.title = '试听';
            play.addEventListener('click', function (ev) {
                ev.stopPropagation();
                togglePlay(s, play);
            });
            row.appendChild(play);

            // 平台标签
            var tag = document.createElement('span');
            tag.className = 'sep-res-tag sep-res-accomp';
            tag.textContent = srcLabel(s.source);
            row.appendChild(tag);

            // 歌名 + 歌手/专辑
            var info = document.createElement('div');
            info.className = 'sep-res-info';
            var nm = document.createElement('div');
            nm.className = 'sep-res-name';
            nm.textContent = s.name || '';
            var sub = document.createElement('div');
            sub.className = 'sep-res-sub';
            sub.textContent = (s.singer || '') + (s.albumName ? (' · ' + s.albumName) : '');
            info.appendChild(nm);
            info.appendChild(sub);
            row.appendChild(info);

            // 时长
            var dur = document.createElement('span');
            dur.className = 'mv2-dur';
            dur.textContent = s.interval || '';
            row.appendChild(dur);

            // 下载到音乐库
            var dl = document.createElement('button');
            dl.type = 'button';
            dl.className = 'sep-res-btn';
            dl.textContent = '\u2913 下载';
            dl.title = '下载到音乐库目录';
            dl.addEventListener('click', function (ev) { ev.stopPropagation(); download(s); });
            row.appendChild(dl);

            // 插入时间轴
            var ins = document.createElement('button');
            ins.type = 'button';
            ins.className = 'sep-res-btn';
            ins.textContent = '\u2192PR';
            ins.title = '下载后插入当前时间线';
            ins.addEventListener('click', function (ev) { ev.stopPropagation(); insertToTimeline(s); });
            row.appendChild(ins);

            row.addEventListener('click', function () { curSong = s; flash('已选中：' + s.name); });
            box.appendChild(row);
        });
    }

    // ---------- 试听（波形）----------
    function togglePlay(s, btn) {
        if (wsPlaying && curSong && curSong.songmid === s.songmid) {
            try { ws.pause(); } catch (e) {}
            wsPlaying = false;
            btn.textContent = '\u25b6';
            return;
        }
        stopPlay();
        curSong = s;
        setState('正在取播放地址…', '');
        api('/api/music/url', { method: 'POST', body: { songInfo: s, quality: '320k' }, timeout: 60000 })
            .then(function (r) {
                var url = (r && r.url) || ((r && r.data) || {}).url;
                if (!url) throw new Error('取不到播放地址（可能该平台无可播源）');
                playUrl(url, s, btn);
            }).catch(function (e) {
                setState('试听失败：' + e.message, 'err');
                flash(e.message, 'err');
            });
    }

    function playUrl(url, s, btn) {
        var wrap = $('mv2Player');
        if (wrap) wrap.style.display = '';
        var title = $('mv2PlayerTitle');
        if (title) title.textContent = (s.name || '') + (s.singer ? (' · ' + s.singer) : '');
        var holder = $('mv2Wave');
        if (!holder) return;
        holder.innerHTML = '';
        try {
            if (typeof WaveSurfer === 'undefined') throw new Error('wavesurfer 未加载');
            ws = WaveSurfer.create({
                container: holder,
                waveColor: '#c9b6ff', progressColor: '#8b5cf6', cursorColor: '#fff',
                height: 34, barWidth: 2, barGap: 1, barMinHeight: 1, cursorWidth: 1,
                interact: true, hideScrollbar: true
            });
            ws.load(url);
            ws.on('ready', function () {
                try { ws.play(); } catch (e) {}
                wsPlaying = true;
                if (btn) btn.textContent = '\u23f8';
                setState('试听中', 'ok');
            });
            ws.on('finish', function () {
                wsPlaying = false;
                if (btn) btn.textContent = '\u25b6';
                setState('已就绪', 'ok');
            });
            ws.on('error', function () {
                wsPlaying = false;
                if (btn) btn.textContent = '\u25b6';
                setState('试听出错（可能是直链过期或跨域限制）', 'err');
            });
        } catch (e) {
            setState('试听失败：' + e.message, 'err');
        }
    }

    function stopPlay() {
        try { if (ws) ws.stop(); } catch (e) {}
        ws = null; wsPlaying = false;
    }

    // ---------- 下载到音乐库 ----------
    // 逻辑：取直链 → 交给 lxserver 的下载接口落盘到音乐库目录
    function dlDir() {
        try { return localStorage.getItem('mllibDir') || ''; } catch (e) { return ''; }
    }

    function download(s, cb) {
        setState('正在取播放地址…', '');
        api('/api/music/url', { method: 'POST', body: { songInfo: s, quality: '320k' }, timeout: 60000 })
            .then(function (r) {
                var url = (r && r.url) || ((r && r.data) || {}).url;
                var srcName = (r && r.sourceName) || s.source;
                if (!url) throw new Error('取不到播放地址（该平台可能无可播源）');
                setState('正在下载…', '');
                return api('/api/music/download', {
                    method: 'POST', timeout: 180000,
                    body: {
                        url: url,
                        filename: (s.name || 'song') + ' - ' + (s.singer || ''),
                        songInfo: s,
                        source: srcName,
                        quality: '320k',
                        dir: dlDir() || undefined
                    }
                });
            })
            .then(function (r2) {
                var d = (r2 && r2.data) || r2 || {};
                var f = d.file || d.path || d.filename || '';
                setState('已下载' + (f ? ('：' + f) : ''), 'ok');
                flash('下载完成' + (f ? ('：' + f) : ''), 'ok');
                if (cb) cb(true, d);
            })
            .catch(function (e) {
                setState('下载失败：' + e.message, 'err');
                flash('下载失败：' + e.message, 'err');
                if (cb) cb(false, e.message);
            });
    }

    // ---------- 插入时间轴 ----------
    // 先下载到本地，再走语音克隆面板那套「插入到时间线」宿主接口
    function insertToTimeline(s) {
        var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;
        if (!csInterface) { flash('当前非 PR 环境', 'err'); return; }
        download(s, function (ok, d) {
            if (!ok) return;
            var file = d.file || d.path || '';
            if (!file) { flash('下载结果里没有文件路径', 'err'); return; }
            // 复用 vcInsertPayload / vcInsertToTimelineStr（语音克隆已实现的插入链路）
            var payload = { wavPath: file, trackIndex: 0, positionSec: 0, colorLabel: 3 };
            // 音轨数/播放头位置由宿主查询，这里交给宿主接口自己决定
            csInterface.evalScript('vcInsertPayload = ' + JSON.stringify(payload) + ';', function () {
                csInterface.evalScript('vcInsertToTimelineStr()', function (result) {
                    try {
                        var r = JSON.parse(result);
                        if (r && r.ok) flash('已插入时间线', 'ok');
                        else flash('插入失败：' + ((r && r.error) || result), 'err');
                    } catch (e) {
                        flash('插入失败：' + result, 'err');
                    }
                });
            });
        });
    }

    // ---------- 平台切换 ----------
    function setPlatform(id) {
        curPlatform = id;
        Array.prototype.forEach.call(document.querySelectorAll('#mv2Platforms .mv2-pf'), function (b) {
            b.classList.toggle('on', b.dataset.pf === id);
        });
    }

    function bind() {
        Array.prototype.forEach.call(document.querySelectorAll('#mv2Platforms .mv2-pf'), function (b) {
            b.addEventListener('click', function () { setPlatform(b.dataset.pf); });
        });
        var s = $('btnMv2Search');
        if (s) s.addEventListener('click', doSearch);
        var q = $('mv2Query');
        if (q) q.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doSearch(); });
        var pc = $('btnMv2PlayerClose');
        if (pc) pc.addEventListener('click', function () {
            stopPlay();
            var w = $('mv2Player'); if (w) w.style.display = 'none';
        });
        setPlatform('wy');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
