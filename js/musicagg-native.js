// vh-Atelier 音乐聚合 · 简洁模式（原生面板）
//
// 与 iframe（完整播放器）互补：这里做「逛 → 搜 → 听 → 下 → 进 PR」这条干活链路，
// 界面与插件一致、能与音乐库和 PR 打通。
//
// 数据来源：浏览器直连 lxserver 的 REST API（CORS 已放行）。
//   GET  /api/music/search?source=&name=&type=song|playlist|singer|album&limit=
//   POST /api/music/url           body { songInfo, quality }
//   GET  /api/music/leaderboard/boards?source=
//   GET  /api/music/leaderboard/list?source=&bangid=
//   GET  /api/music/songList/tags?source=
//   GET  /api/music/songList/list?source=&tag=&page=
//   GET  /api/music/songList/detail?source=&id=
//   GET  /api/music/hotSearch?source=
//   GET  /api/music/download?url=&filename=      ← 音频代理（解决跨域）
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path, childProcess, os, httpMod, httpsMod, urlMod;
    try {
        fs = require('fs');
        path = require('path');
        childProcess = require('child_process');
        os = require('os');
        httpMod = require('http');
        httpsMod = require('https');
        urlMod = require('url');
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
        el._t = setTimeout(function () { el.style.display = 'none'; }, 3000);
    }
    function setState(msg, cls) {
        var el = $('mv2State');
        if (el) { el.textContent = msg || ''; el.className = 'mv2-state' + (cls ? ' ' + cls : ''); }
    }
    function setCount(t) { var el = $('mv2Count'); if (el) el.textContent = t || ''; }

    var PLATFORMS = [
        { id: 'wy', name: '网易云' },
        { id: 'tx', name: 'QQ' },
        { id: 'kw', name: '酷我' },
        { id: 'kg', name: '酷狗' },
        { id: 'mg', name: '咪咕' }
    ];
    var curPlatform = 'wy';
    var curType = 'song';
    var playlist = [];      // 当前播放队列
    var playIdx = -1;       // 当前播放下标
    var audio = null;       // <audio>
    var playMode = 'list';  // list | one | random
    var lastDlDir = '';     // 上次下载目录（记忆）

    var DL_DIR_KEY = 'vh_musicagg_dl_dir';

    function api(p, opt) {
        var agg = window.__musicAgg;
        if (!agg) return Promise.reject(new Error('音乐聚合模块未加载'));
        return agg.api(p, opt);
    }
    function srcLabel(s) {
        for (var i = 0; i < PLATFORMS.length; i++) { if (PLATFORMS[i].id === s) return PLATFORMS[i].name; }
        return s || '';
    }
    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        sec = Math.floor(sec);
        var m = Math.floor(sec / 60), s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    // ---------- 音频代理（解决 CDN 无 CORS 头的问题）----------
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

    // ==================== 首页：推荐歌单 + 榜单 ====================
    function loadHome() {
        var box = $('mv2List');
        var sheet = $('mv2Sheet');
        if (sheet) sheet.style.display = 'none';
        if (box) { box.style.display = ''; box.className = 'mv2-list mv2-home'; }
        setCount('');
        setState('正在加载首页…', '');
        if (box) box.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⏳</div><div>加载首页…</div></div>';

        var src = curPlatform || 'wy';
        // 并发拉：榜单列表 + 推荐歌单 + 热搜
        Promise.all([
            api('/api/music/leaderboard/boards?source=' + src).catch(function () { return {}; }),
            api('/api/music/songList/list?source=' + src + '&page=1').catch(function () { return {}; }),
            api('/api/music/hotSearch?source=' + src).catch(function () { return {}; })
        ]).then(function (arr) {
            var boards = (arr[0] && (arr[0].list || arr[0].data)) || [];
            var sheets = (arr[1] && (arr[1].list || arr[1].data)) || [];
            var hot = (arr[2] && (arr[2].list || arr[2].data)) || [];
            renderHome(boards, sheets, hot);
            setState('已就绪', 'ok');
        }).catch(function (e) {
            if (box) box.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⚠</div><div>首页加载失败</div><div class="mv2-empty-sub">' + esc(e.message) + '</div></div>';
            setState('加载失败', 'err');
        });
    }

    function renderHome(boards, sheets, hot) {
        var box = $('mv2List');
        if (!box) return;
        box.innerHTML = '';
        box.className = 'mv2-list mv2-home-scroll';

        // 热搜词
        if (hot && hot.length) {
            var sec0 = mkSection('🔥 热搜');
            var wr = document.createElement('div');
            wr.className = 'mv2-chips';
            hot.slice(0, 14).forEach(function (w) {
                var c = document.createElement('span');
                c.className = 'mv2-chip';
                c.textContent = w;
                c.addEventListener('click', function () { $('mv2Query').value = w; curType = 'song'; $('mv2Type').value = 'song'; doSearch(); });
                wr.appendChild(c);
            });
            sec0.body.appendChild(wr);
            box.appendChild(sec0.el);
        }

        // 榜单
        if (boards && boards.length) {
            var sec = mkSection('🏆 排行榜');
            var g = document.createElement('div');
            g.className = 'mv2-sheet-grid';
            boards.slice(0, 12).forEach(function (b) {
                var card = document.createElement('div');
                card.className = 'mv2-sheet-card';
                card.innerHTML = '<div class="mv2-sheet-name">' + esc(b.name || '') + '</div>';
                card.addEventListener('click', function () { openBoard(b); });
                g.appendChild(card);
            });
            sec.body.appendChild(g);
            box.appendChild(sec.el);
        }

        // 推荐歌单
        if (sheets && sheets.length) {
            var sec2 = mkSection('✨ 推荐歌单');
            var g2 = document.createElement('div');
            g2.className = 'mv2-pick-grid';
            sheets.slice(0, 18).forEach(function (s) {
                g2.appendChild(mkSheetCard(s));
            });
            sec2.body.appendChild(g2);
            box.appendChild(sec2.el);
        }

        if (!box.children.length) {
            box.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">🎵</div><div>暂无首页内容</div><div class="mv2-empty-sub">可直接搜索，或切换平台</div></div>';
        }
    }

    function mkSection(title) {
        var el = document.createElement('div');
        el.className = 'mv2-sec';
        var h = document.createElement('div');
        h.className = 'mv2-sec-title';
        h.textContent = title;
        var body = document.createElement('div');
        body.className = 'mv2-sec-body';
        el.appendChild(h);
        el.appendChild(body);
        return { el: el, body: body };
    }

    function mkSheetCard(s) {
        var card = document.createElement('div');
        card.className = 'mv2-pick';
        var cover = s.img || s.picUrl || s.cover || '';
        card.innerHTML =
            '<div class="mv2-pick-cover">' + (cover ? '<img src="' + esc(cover) + '" alt="">' : '<div class="mv2-pick-nopic">🎼</div>') + '</div>' +
            '<div class="mv2-pick-name">' + esc(s.name || '') + '</div>' +
            '<div class="mv2-pick-sub">' + esc(s.author || s.creator || '') + (s.play_count || s.playCount ? (' · ' + (s.play_count || s.playCount)) : '') + '</div>';
        card.addEventListener('click', function () { openSheet(s); });
        return card;
    }

    // ==================== 榜单 / 歌单详情 ====================
    function openBoard(b) {
        var agg = window.__musicAgg;
        var src = curPlatform || (b.id || '').split('__')[0] || 'wy';
        var bangid = b.bangid || b.id;
        setCount('榜单：' + (b.name || ''));
        setState('正在加载…', '');
        showSheetView();
        api('/api/music/leaderboard/list?source=' + src + '&bangid=' + encodeURIComponent(bangid)).then(function (r) {
            var list = r && (r.list || r.data) || [];
            renderSongRows(list, b.name || '榜单');
            setState('已就绪', 'ok');
        }).catch(function (e) {
            $('mv2Sheet').innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⚠</div><div>榜单加载失败</div><div class="mv2-empty-sub">' + esc(e.message) + '</div></div>';
            setState('加载失败', 'err');
        });
    }

    function openSheet(s) {
        var agg = window.__musicAgg;
        setCount('歌单：' + (s.name || ''));
        setState('正在加载歌单…', '');
        showSheetView();
        var src = s.source || curPlatform || 'wy';
        api('/api/music/songList/detail?source=' + src + '&id=' + encodeURIComponent(s.id)).then(function (r) {
            var list = r && (r.list || r.data || r.songs) || [];
            renderSongRows(list, s.name || '歌单');
            setState('共 ' + list.length + ' 首', 'ok');
        }).catch(function (e) {
            $('mv2Sheet').innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⚠</div><div>歌单加载失败</div><div class="mv2-empty-sub">' + esc(e.message) + '</div></div>';
            setState('加载失败', 'err');
        });
    }

    function showSheetView() {
        var box = $('mv2List'), sheet = $('mv2Sheet');
        if (box) { box.style.display = 'none'; box.className = 'mv2-list'; }
        if (sheet) { sheet.style.display = ''; sheet.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⏳</div><div>加载中…</div></div>'; }
    }

    function showListView() {
        var box = $('mv2List'), sheet = $('mv2Sheet');
        if (sheet) sheet.style.display = 'none';
        if (box) { box.style.display = ''; box.className = 'mv2-list'; }
    }

    // ==================== 搜索 ====================
    function doSearch() {
        var kw = ($('mv2Query').value || '').trim();
        if (!kw) { flash('请输入关键词'); return; }
        curType = ($('mv2Type') && $('mv2Type').value) || 'song';
        showListView();
        var box = $('mv2List');
        setCount('');
        setState('搜索中…', '');
        if (box) box.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⏳</div><div>搜索中…</div></div>';

        if (!curPlatform) {
            var all = [], done = 0;
            PLATFORMS.forEach(function (pf) {
                api(searchPath(pf.id, kw, curType, 12))
                    .then(function (r) { norm(r).forEach(function (x) { all.push(x); }); })
                    .catch(function () {})
                    .then(function () {
                        done++;
                        if (done === PLATFORMS.length) {
                            afterSearch(all, kw);
                        }
                    });
            });
            return;
        }
        api(searchPath(curPlatform, kw, curType, 30))
            .then(function (r) { afterSearch(norm(r), kw); })
            .catch(function (e) {
                if (box) box.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⚠</div><div>搜索失败</div><div class="mv2-empty-sub">' + esc(e.message) + '</div></div>';
                setState('搜索失败', 'err');
            });
    }

    function searchPath(src, kw, type, limit) {
        return '/api/music/search?source=' + src + '&name=' + encodeURIComponent(kw)
            + '&type=' + (type || 'song') + '&limit=' + (limit || 30);
    }
    function norm(r) {
        if (Array.isArray(r)) return r;
        if (!r) return [];
        return r.list || r.data || r.songs || [];
    }

    function afterSearch(list, kw) {
        var box = $('mv2List');
        setState('已就绪', 'ok');
        if (!box) return;
        if (!list.length) {
            box.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">😐</div><div>没搜到「' + esc(kw) + '」</div><div class="mv2-empty-sub">换个关键词或类型试试</div></div>';
            setCount('');
            return;
        }
        if (curType === 'playlist') {
            setCount('共 ' + list.length + ' 个歌单');
            box.innerHTML = '';
            box.className = 'mv2-list mv2-home';
            var g = document.createElement('div');
            g.className = 'mv2-pick-grid';
            var seen = {};
            list.forEach(function (s) {
                var key = String(s.id) + (s.source || '');
                if (seen[key]) return;
                seen[key] = 1;
                g.appendChild(mkSheetCard(s));
            });
            box.appendChild(g);
            return;
        }
        // 单曲/歌手/专辑：都先按可播列表展示（歌手/专辑只列名字，点击再取详情）
        setCount('共 ' + list.length + ' 首 · ' + srcLabel(curPlatform || '全部'));
        renderSongRows(list, kw);
    }

    // ==================== 歌曲行渲染 ====================
    function renderSongRows(list, title) {
        var box = (curType === 'playlist') ? $('mv2List') : (($('mv2Sheet') && $('mv2Sheet').style.display !== 'none') ? $('mv2Sheet') : $('mv2List'));
        if (!box) return;
        box.innerHTML = '';
        // 统一成播放队列
        playlist = list.slice();
        list.forEach(function (s, idx) {
            var row = document.createElement('div');
            row.className = 'mv2-row';
            row.setAttribute('data-idx', String(idx));

            var no = document.createElement('span');
            no.className = 'mv2-no';
            no.textContent = String(idx + 1);
            row.appendChild(no);

            var main = document.createElement('div');
            main.className = 'mv2-main';
            var nm = document.createElement('div');
            nm.className = 'mv2-name';
            nm.textContent = s.name || '';
            nm.title = s.name || '';
            var sub = document.createElement('div');
            sub.className = 'mv2-sub';
            sub.textContent = (s.singer || s.artist || '未知歌手') + (s.albumName ? (' · ' + s.albumName) : '');
            sub.title = sub.textContent;
            main.appendChild(nm); main.appendChild(sub);
            row.appendChild(main);

            var tag = document.createElement('span');
            tag.className = 'mv2-badge mv2-badge-' + (s.source || 'x');
            tag.textContent = srcLabel(s.source);
            row.appendChild(tag);

            var dur = document.createElement('span');
            dur.className = 'mv2-dur';
            dur.textContent = s.interval || '--:--';
            row.appendChild(dur);

            var ops = document.createElement('div');
            ops.className = 'mv2-ops';
            ops.appendChild(mkBtn('▶', 'mv2-btn-play', '播放', function () { playListAt(idx); }));
            ops.appendChild(mkBtn('⤓', 'mv2-btn', '下载（可选目录）', function () { download(s); }));
            ops.appendChild(mkBtn('→PR', 'mv2-btn', '下载并插入当前时间线', function () { insertToTimeline(s); }));
            row.appendChild(ops);

            row.addEventListener('dblclick', function () { playListAt(idx); });
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

    // ==================== 播放器 ====================
    function getAudio() {
        if (!audio) audio = $('mv2Audio');
        return audio;
    }

    function playListAt(idx) {
        if (idx < 0 || idx >= playlist.length) return;
        playIdx = idx;
        var s = playlist[idx];
        setState('正在取播放地址…', '');
        api('/api/music/url', { method: 'POST', body: { songInfo: s, quality: '320k' }, timeout: 60000 })
            .then(function (r) {
                var url = (r && r.url) || ((r && r.data) || {}).url;
                if (!url) throw new Error('取不到播放地址（该平台可能无可播源）');
                var a = getAudio();
                if (!a) throw new Error('播放器元素缺失');
                a.src = proxyUrl(url);
                updateNow(s);
                a.play().catch(function (e) { setState('播放失败：' + (e.message || '被浏览器拦截'), 'err'); });
                setState('播放中', 'ok');
            })
            .catch(function (e) {
                setState('播放失败：' + e.message, 'err');
                flash(e.message, 'err');
            });
    }

    function updateNow(s) {
        var box = $('mv2Player');
        if (box) box.style.display = '';
        var t = $('mv2PlayerTitle');
        if (t) t.textContent = s.name || '未在播放';
        var sub = $('mv2Sub');
        if (sub) sub.textContent = (s.singer || '') + (s.albumName ? (' · ' + s.albumName) : '');
        var cov = $('mv2Cover');
        if (cov) {
            var img = s.img || s.picUrl || '';
            cov.style.display = img ? '' : 'none';
            if (img) cov.src = img;
        }
    }

    function syncPlayIcon() {
        var a = getAudio();
        var btn = $('btnMv2PlayPause');
        if (!btn) return;
        var playing = a && !a.paused && a.src;
        var ip = btn.querySelector('.ic-play'), ipa = btn.querySelector('.ic-pause');
        if (ip) ip.style.display = playing ? 'none' : '';
        if (ipa) ipa.style.display = playing ? '' : 'none';
    }

    function playNav(delta) {
        if (!playlist.length) return;
        if (playMode === 'random') {
            playListAt(Math.floor(Math.random() * playlist.length));
            return;
        }
        var n = playIdx + delta;
        if (n < 0) n = playlist.length - 1;
        if (n >= playlist.length) n = 0;
        playListAt(n);
    }

    function bindPlayer() {
        var a = getAudio();
        if (!a) return;
        a.addEventListener('timeupdate', function () {
            var fill = $('mv2SeekFill');
            var cur = $('mv2Cur');
            var d = a.duration;
            if (isFinite(d) && d > 0 && fill) fill.style.width = Math.min(100, a.currentTime / d * 100) + '%';
            if (cur) cur.textContent = fmtTime(a.currentTime);
        });
        a.addEventListener('loadedmetadata', function () {
            var dur = $('mv2Dur');
            if (dur) dur.textContent = fmtTime(a.duration);
        });
        a.addEventListener('play', syncPlayIcon);
        a.addEventListener('pause', syncPlayIcon);
        a.addEventListener('ended', function () {
            syncPlayIcon();
            if (playMode === 'one') { try { a.currentTime = 0; a.play(); } catch (e) {} return; }
            playNav(1);
        });

        var pp = $('btnMv2PlayPause');
        if (pp) pp.addEventListener('click', function () {
            if (!a.src) { if (playlist.length) playListAt(0); return; }
            if (a.paused) a.play().catch(function () {}); else a.pause();
        });
        var pv = $('btnMv2Prev'); if (pv) pv.addEventListener('click', function () { playNav(-1); });
        var nx = $('btnMv2Next'); if (nx) nx.addEventListener('click', function () { playNav(1); });
        var cl = $('btnMv2Close');
        if (cl) cl.addEventListener('click', function () {
            try { a.pause(); } catch (e) {}
            var box = $('mv2Player'); if (box) box.style.display = 'none';
        });
        var vol = $('mv2Vol');
        if (vol) vol.addEventListener('input', function () { a.volume = parseFloat(vol.value) || 0.8; });
        var seek = $('mv2Seek');
        if (seek) seek.addEventListener('click', function (ev) {
            var r = seek.getBoundingClientRect();
            var ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
            if (isFinite(a.duration)) a.currentTime = ratio * a.duration;
        });
        var dl = $('btnMv2Download');
        if (dl) dl.addEventListener('click', function () {
            if (playIdx >= 0 && playlist[playIdx]) download(playlist[playIdx]);
            else flash('先选一首歌');
        });
        var ins = $('btnMv2Insert');
        if (ins) ins.addEventListener('click', function () {
            if (playIdx >= 0 && playlist[playIdx]) insertToTimeline(playlist[playIdx]);
            else flash('先选一首歌');
        });
    }

    // ==================== 下载（对齐扒歌：选目录 + 记忆 + 资源管理器 + 拖拽）====================
    function getDlDir() {
        try { return localStorage.getItem(DL_DIR_KEY) || ''; } catch (e) { return ''; }
    }
    function setDlDir(d) {
        try { localStorage.setItem(DL_DIR_KEY, String(d || '')); } catch (e) {}
        lastDlDir = d || '';
    }

    // 选目录：优先系统原生对话框（经本地服务），起始位置为「上次选的目录 → 音乐库」
    function pickDir(cb) {
        var start = getDlDir() || (function () { try { return localStorage.getItem('mllibDir') || ''; } catch (e) { return ''; } })();
        var agg = window.__musicAgg;
        var isLocal = agg && agg.getTarget() === 'local';
        if (isLocal) {
            agg.api('/pick-dir', { method: 'POST', body: { desc: '选择歌曲保存目录', startDir: start }, timeout: 120000 })
                .then(function (r) {
                    var p = (r && r.data && r.data.path) || '';
                    if (p) { setDlDir(p); cb(p); } else cb(null);
                })
                .catch(function () { cb(null); });
            return;
        }
        // 服务器模式：本地没跑服务，退回树形选择器
        if (typeof window.__vhPickDir === 'function') {
            window.__vhPickDir({ title: '选择歌曲保存目录', startDir: start || undefined, root: start || undefined }, function (d) {
                if (d) setDlDir(d);
                cb(d || null);
            });
            return;
        }
        cb(null);
    }

    function download(s, skipPick) {
        var doIt = function (dir) {
            if (dir === null) return;   // 用户取消
            setState('正在取播放地址…', '');
            api('/api/music/url', { method: 'POST', body: { songInfo: s, quality: '320k' }, timeout: 60000 })
                .then(function (r) {
                    var url = (r && r.url) || ((r && r.data) || {}).url;
                    if (!url) throw new Error('取不到播放地址（该平台可能无可播源）');
                    var fname = safeName((s.name || 'song') + ' - ' + (s.singer || s.artist || '')) + '.mp3';
                    setState('正在下载…', '');
                    return new Promise(function (resolve, reject) {
                        fetchToFile(proxyUrl(url), dir, fname, function (err, saved) {
                            if (err) reject(new Error(err)); else resolve(saved);
                        });
                    });
                })
                .then(function (saved) {
                    setState('已下载：' + saved, 'ok');
                    flash('已下载到：' + saved, 'ok');
                    markRowDownloaded(s, saved);
                })
                .catch(function (e) {
                    setState('下载失败：' + e.message, 'err');
                    flash('下载失败：' + e.message, 'err');
                });
        };
        if (skipPick) { doIt(skipPick); return; }
        pickDir(function (dir) {
            if (!dir) { setState('已取消', ''); return; }
            doIt(dir);
        });
    }

    function safeName(name) {
        return String(name || 'song').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    }

    function fetchToFile(u, dir, fname, cb) {
        try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
        catch (e) { cb('目录不可写：' + e.message); return; }
        var out = path.join(dir, fname);
        try {
            var mod = urlMod.parse(u).protocol === 'https:' ? httpsMod : httpMod;
            var req = mod.get(u, { headers: { 'User-Agent': 'vh-Atelier' } }, function (res) {
                if (res.statusCode !== 200) { res.resume(); cb('HTTP ' + res.statusCode); return; }
                var fw = fs.createWriteStream(out);
                res.pipe(fw);
                fw.on('finish', function () { cb(null, out); });
                fw.on('error', function (e) { cb('写入失败：' + e.message); });
            });
            req.on('error', function (e) { cb('请求失败：' + e.message); });
            req.setTimeout(300000, function () { req.abort(); cb('超时'); });
        } catch (e) { cb(e.message); }
    }

    // 下载完成 → 行内按钮变「已下载」，并把文件路径挂到行上（可拖进 PR）
    function markRowDownloaded(s, filePath) {
        var boxes = [$('mv2List'), $('mv2Sheet')];
        boxes.forEach(function (box) {
            if (!box) return;
            var rows = box.children;
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (!r.classList || r.className.indexOf('mv2-row') < 0) continue;
                var nm = r.querySelector && r.querySelector('.mv2-name');
                if (nm && nm.textContent === (s.name || '')) {
                    r.setAttribute('draggable', 'true');
                    r.dataset.file = filePath;
                    r.addEventListener('dragstart', function (ev) {
                        try {
                            ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', filePath);
                            ev.dataTransfer.setData('text/plain', filePath);
                            ev.dataTransfer.effectAllowed = 'copy';
                        } catch (e) {}
                    });
                    var ops = r.querySelector('.mv2-ops');
                    if (ops && ops.children[1]) {
                        ops.children[1].textContent = '✔';
                        ops.children[1].title = '已下载：' + filePath + '（可拖进 PR；右键菜单）';
                        // 右键菜单：改目录 / 资源管理器 / 导入PR / 插时间线
                        r.addEventListener('contextmenu', function (ev) {
                            ev.preventDefault();
                            showRowMenu(ev, filePath);
                        });
                    }
                    break;
                }
            }
        });
    }

    // 右键菜单（对齐扒歌：导入PR / 插时间线 / 改目录 / 资源管理器）
    function showRowMenu(ev, filePath) {
        var old = document.getElementById('mv2Ctx');
        if (old) old.remove();
        var menu = document.createElement('div');
        menu.id = 'mv2Ctx';
        menu.className = 'mv2-ctx';
        function mi(label, fn) {
            var d = document.createElement('div');
            d.className = 'mv2-ctx-item';
            d.textContent = label;
            d.addEventListener('click', function () { menu.remove(); fn(); });
            menu.appendChild(d);
        }
        mi('📂 在资源管理器中显示', function () {
            try { childProcess.spawn('explorer.exe', ['/select,' + filePath]); } catch (e) { flash('打开失败', 'err'); }
        });
        mi('📁 更改保存目录…', function () {
            pickDir(function (dir) {
                if (!dir) return;
                moveFile(filePath, dir);
            });
        });
        mi('▶ 插入时间线', function () { insertFileToTimeline(filePath); });
        menu.style.left = ev.clientX + 'px';
        menu.style.top = ev.clientY + 'px';
        document.body.appendChild(menu);
        setTimeout(function () {
            document.addEventListener('click', function h() {
                var m = document.getElementById('mv2Ctx');
                if (m) m.remove();
                document.removeEventListener('click', h);
            });
        }, 10);
    }

    function moveFile(filePath, destDir) {
        try {
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            var dest = path.join(destDir, path.basename(filePath));
            fs.renameSync(filePath, dest);
            setDlDir(destDir);
            flash('已移到：' + dest, 'ok');
        } catch (e) { flash('移动失败：' + e.message, 'err'); }
    }

    // ==================== 插入时间线 ====================
    function insertFileToTimeline(filePath) {
        var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;
        if (!csInterface) { flash('当前非 PR 环境', 'err'); return; }
        var payload = { wavPath: filePath, trackIndex: 0, positionSec: 0, colorLabel: 3 };
        csInterface.evalScript('vcInsertPayload = ' + JSON.stringify(payload) + ';', function () {
            csInterface.evalScript('vcInsertToTimelineStr()', function (result) {
                try {
                    var r = JSON.parse(result);
                    if (r && r.ok) flash('已插入时间线', 'ok');
                    else flash('插入失败：' + ((r && r.error) || result), 'err');
                } catch (e) { flash('插入失败：' + result, 'err'); }
            });
        });
    }

    function insertToTimeline(s) {
        var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;
        if (!csInterface) { flash('当前非 PR 环境', 'err'); return; }
        var dir = getDlDir();
        if (!dir) {
            // 没设过目录 → 先让用户选
            pickDir(function (d) {
                if (!d) return;
                download(s, d);
                setTimeout(function () {
                    var f = path.join(d, safeName((s.name || 'song') + ' - ' + (s.singer || s.artist || '')) + '.mp3');
                    if (fs.existsSync(f)) insertFileToTimeline(f);
                }, 4000);
            });
            return;
        }
        download(s, dir);
        setTimeout(function () {
            var f = path.join(dir, safeName((s.name || 'song') + ' - ' + (s.singer || s.artist || '')) + '.mp3');
            if (fs.existsSync(f)) insertFileToTimeline(f);
            else flash('文件还没就绪，稍后再点一次或从菜单插入', 'err');
        }, 4000);
    }

    // ==================== 平台 / 事件绑定 ====================
    function setPlatform(id) {
        curPlatform = id;
        Array.prototype.forEach.call(document.querySelectorAll('#mv2Platforms .mv2-pf'), function (b) {
            b.classList.toggle('on', b.dataset.pf === id);
        });
    }

    function bind() {
        Array.prototype.forEach.call(document.querySelectorAll('#mv2Platforms .mv2-pf'), function (b) {
            b.addEventListener('click', function () { setPlatform(b.dataset.pf); loadHome(); });
        });
        var s = $('btnMv2Search'); if (s) s.addEventListener('click', doSearch);
        var q = $('mv2Query');
        if (q) q.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doSearch(); });
        var hm = $('btnMv2Home'); if (hm) hm.addEventListener('click', loadHome);
        var ty = $('mv2Type'); if (ty) ty.addEventListener('change', function () { if (($('mv2Query').value || '').trim()) doSearch(); });
        bindPlayer();
        setPlatform('wy');
        loadHome();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
