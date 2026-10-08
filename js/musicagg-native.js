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
            var cntEl = $('mv2Count');
            if (cntEl) cntEl.textContent = '正在并发搜索 5 个平台…';
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
                            setState('已就绪', 'ok');
                        }
                    });
            });
            return;
        }

        api('/api/music/search?source=' + curPlatform + '&name=' + encodeURIComponent(kw) + '&type=song&limit=30')
            .then(function (r) {
                results = Array.isArray(r) ? r : ((r && r.data) || []);
                renderList();
                setState('已就绪', 'ok');
            }).catch(function (e) {
                box.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⚠</div><div>搜索失败</div><div class="mv2-empty-sub">' + esc(e.message) + '</div></div>';
                setState('搜索失败', 'err');
            });
    }

    function srcLabel(s) {
        for (var i = 0; i < PLATFORMS.length; i++) { if (PLATFORMS[i].id === s) return PLATFORMS[i].name; }
        return s || '';
    }

    function renderList() {
        var box = $('mv2List');
        var cnt = $('mv2Count');
        if (cnt) cnt.textContent = results.length ? ('共 ' + results.length + ' 首 · ' + srcLabel(curPlatform || '全部')) : '没有结果';
        if (!results.length) {
            box.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">😐</div><div>没搜到</div><div class="mv2-empty-sub">换个关键词，或切换平台试试</div></div>';
            return;
        }
        box.innerHTML = '';
        results.forEach(function (s, idx) {
            var row = document.createElement('div');
            row.className = 'mv2-row';
            row.setAttribute('data-idx', String(idx));

            // 序号
            var no = document.createElement('span');
            no.className = 'mv2-no';
            no.textContent = String(idx + 1);
            row.appendChild(no);

            // 主体：歌名 / 歌手·专辑
            var main = document.createElement('div');
            main.className = 'mv2-main';
            var nm = document.createElement('div');
            nm.className = 'mv2-name';
            nm.textContent = s.name || '';
            nm.title = s.name || '';
            var sub = document.createElement('div');
            sub.className = 'mv2-sub';
            sub.textContent = (s.singer || '未知歌手') + (s.albumName ? (' · ' + s.albumName) : '');
            sub.title = sub.textContent;
            main.appendChild(nm);
            main.appendChild(sub);
            row.appendChild(main);

            // 平台徽标
            var tag = document.createElement('span');
            tag.className = 'mv2-badge mv2-badge-' + (s.source || 'x');
            tag.textContent = srcLabel(s.source);
            row.appendChild(tag);

            // 时长
            var dur = document.createElement('span');
            dur.className = 'mv2-dur';
            dur.textContent = s.interval || '--:--';
            row.appendChild(dur);

            // 操作组
            var ops = document.createElement('div');
            ops.className = 'mv2-ops';
            var play = mkBtn('▶', 'mv2-btn-play', '试听', function () { togglePlay(s, play); });
            var dl = mkBtn('⤓', 'mv2-btn', '下载到音乐库', function () { download(s); });
            var ins = mkBtn('→PR', 'mv2-btn', '下载并插入当前时间线', function () { insertToTimeline(s); });
            ops.appendChild(play); ops.appendChild(dl); ops.appendChild(ins);
            row.appendChild(ops);

            row.addEventListener('click', function () { curSong = s; flash('已选中：' + s.name); });
            box.appendChild(row);
        });
    }

    function mkBtn(text, cls, title, fn) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
        return b;
    }

    // 关键：音频直链来自平台 CDN，浏览器直接拉会被 CORS 拦（无 Access-Control-Allow-Origin）。
    // lxserver 自带音频代理 /api/music/download?url=...（转发 Range、处理重定向），
    // 用它当同源代理后，试听与下载都不再有跨域问题。
    function proxyUrl(realUrl) {
        var agg = window.__musicAgg;
        if (!agg) return realUrl;
        return agg.base() + '/api/music/download?inline=1&url=' + encodeURIComponent(realUrl);
    }
    function dlUrl(realUrl, filename) {
        var agg = window.__musicAgg;
        if (!agg) return realUrl;
        return agg.base() + '/api/music/download?url=' + encodeURIComponent(realUrl)
            + '&filename=' + encodeURIComponent(filename || 'download.mp3');
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
        var proxied = proxyUrl(url);
        try {
            if (typeof WaveSurfer === 'undefined') throw new Error('wavesurfer 未加载');
            ws = WaveSurfer.create({
                container: holder,
                waveColor: '#8ea0d0', progressColor: '#6d8cff', cursorColor: '#fff',
                height: 40, barWidth: 2, barGap: 1, barMinHeight: 1, cursorWidth: 1,
                interact: true, hideScrollbar: true,
                // 走代理时是普通 mp3，用 media 元素解码最稳
                mediaControls: false
            });
            ws.load(proxied);
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
            ws.on('error', function (e) {
                wsPlaying = false;
                if (btn) btn.textContent = '\u25b6';
                var msg = (e && (e.message || e.type)) || '';
                setState('试听失败' + (msg ? ('：' + msg) : '（可试试「→PR」直接下载）'), 'err');
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
    // 两种落盘方式：
    //  1) 本地模式：用 Node 的 http 流式拉 lxserver 的代理地址，写进音乐库目录
    //  2) 服务器模式：让服务器自己缓存（调 /api/music/cache/download），或直接浏览器下载
    // 之前写的是 POST + JSON，但接口实际是 GET，故报「响应解析失败」。
    function dlDir() {
        try { return localStorage.getItem('mllibDir') || ''; } catch (e) { return ''; }
    }
    function sanitize(name) {
        return String(name || 'song').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    }

    function download(s, cb) {
        setState('正在取播放地址…', '');
        api('/api/music/url', { method: 'POST', body: { songInfo: s, quality: '320k' }, timeout: 60000 })
            .then(function (r) {
                var url = (r && r.url) || ((r && r.data) || {}).url;
                if (!url) throw new Error('取不到播放地址（该平台可能无可播源）');
                var fname = sanitize((s.name || 'song') + ' - ' + (s.singer || '')) + '.mp3';
                var dir = dlDir();
                if (dir) {
                    setState('正在下载到音乐库…', '');
                    fetchToFile(proxyUrl(url), dir, fname, function (err, saved) {
                        if (err) {
                            setState('下载失败：' + err + '（改为浏览器下载）', 'err');
                            browserDownload(dlUrl(url, fname));
                            if (cb) cb(false, err);
                            return;
                        }
                        setState('已下载：' + saved, 'ok');
                        flash('已下载到音乐库：' + fname, 'ok');
                        if (cb) cb(true, { file: saved });
                    });
                } else {
                    // 未设置音乐库目录 → 交给浏览器下载
                    browserDownload(dlUrl(url, fname));
                    setState('已开始下载（浏览器）', 'ok');
                    if (cb) cb(true, {});
                }
            })
            .catch(function (e) {
                setState('下载失败：' + e.message, 'err');
                flash('下载失败：' + e.message, 'err');
                if (cb) cb(false, e.message);
            });
    }

    // 用 Node http 流式写文件（同源代理，无跨域）
    function fetchToFile(u, dir, fname, cb) {
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (e) { cb('目录不可写：' + e.message); return; }
        var out = path.join(dir, fname);
        try {
            var mod = require('url').parse(u).protocol === 'https:' ? require('https') : require('http');
            var req = mod.get(u, { headers: { 'User-Agent': 'vh-Atelier' } }, function (res) {
                if (res.statusCode !== 200) {
                    res.resume();
                    cb('HTTP ' + res.statusCode);
                    return;
                }
                var fw = fs.createWriteStream(out);
                res.pipe(fw);
                fw.on('finish', function () { cb(null, out); });
                fw.on('error', function (e) { cb('写入失败：' + e.message); });
            });
            req.on('error', function (e) { cb('请求失败：' + e.message); });
            req.setTimeout(180000, function () { req.abort(); cb('超时'); });
        } catch (e) { cb(e.message); }
    }

    // 浏览器下载（未设音乐库时的退路）
    function browserDownload(u) {
        try {
            var a = document.createElement('a');
            a.href = u;
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { try { a.remove(); } catch (e) {} }, 1000);
        } catch (e) { flash('浏览器下载失败：' + e.message, 'err'); }
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
