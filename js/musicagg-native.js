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

    // 【每平台独立视图】切平台时各自保留自己的现场，切回即恢复。
    // 每个平台一份：{ view: 'home'|'search'|'sheet', kw, type, list, sheet: {kind,data}, sheetList }
    var viewByPlatform = {};
    var MAX_VIEW_CACHE = 20;
    function snapshotView() {
        if (!curPlatform) return;
        viewByPlatform[curPlatform] = {
            view: currentView,
            kw: (lastSearch && lastSearch.kw) || '',
            type: curType,
            list: (lastSearch && lastSearch.list) || null,
            sheet: currentSheet,
            sheetList: (lastRendered && lastRendered.list) || null,
            at: Date.now()
        };
        // 限制缓存数量
        var keys = Object.keys(viewByPlatform);
        if (keys.length > MAX_VIEW_CACHE) {
            keys.sort(function (a, b) { return (viewByPlatform[a].at || 0) - (viewByPlatform[b].at || 0); });
            while (keys.length > MAX_VIEW_CACHE) delete viewByPlatform[keys.shift()];
        }
    }
    var currentView = 'home';   // home | search | sheet
    var currentSheet = null;    // { kind:'sheet'|'board', data }
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
        currentView = 'home';
        currentSheet = null;
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
        var src = curPlatform || (b.id || '').split('__')[0] || 'wy';
        var bangid = b.bangid || b.id;
        setCount('榜单：' + (b.name || ''));
        setState('正在加载…', '');
        currentSheet = { kind: 'board', data: b };
        showSheetView(b.name || '榜单');
        currentView = 'sheet';
        api('/api/music/leaderboard/list?source=' + src + '&bangid=' + encodeURIComponent(bangid)).then(function (r) {
            var list = r && (r.list || r.data) || [];
            renderSongRows(list, b.name || '榜单', $('mv2SheetList'), { pickable: true });
            updatePickCount();
            setState('已就绪', 'ok');
        }).catch(function (e) {
            $('mv2SheetList').innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⚠</div><div>榜单加载失败</div><div class="mv2-empty-sub">' + esc(e.message) + '</div></div>';
            setState('加载失败', 'err');
        });
    }

    function openSheet(s) {
        setCount('歌单：' + (s.name || ''));
        setState('正在加载歌单…', '');
        currentSheet = { kind: 'sheet', data: s };
        showSheetView(s.name || '歌单');
        currentView = 'sheet';
        var src = s.source || curPlatform || 'wy';
        api('/api/music/songList/detail?source=' + src + '&id=' + encodeURIComponent(s.id)).then(function (r) {
            var list = r && (r.list || r.data || r.songs) || [];
            renderSongRows(list, s.name || '歌单', $('mv2SheetList'), { pickable: true });
            updatePickCount();
            setState('共 ' + list.length + ' 首', 'ok');
        }).catch(function (e) {
            $('mv2SheetList').innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⚠</div><div>歌单加载失败</div><div class="mv2-empty-sub">' + esc(e.message) + '</div></div>';
            setState('加载失败', 'err');
        });
    }

    // 已进入的层级（供返回）
    var sheetHistory = [];

    function showSheetView(title) {
        var box = $('mv2List'), sheet = $('mv2Sheet');
        if (box) { box.style.display = 'none'; box.className = 'mv2-list'; }
        if (sheet) sheet.style.display = '';
        var tl = $('mv2SheetTitle');
        if (tl) tl.textContent = title || '';
        var lst = $('mv2SheetList');
        if (lst) lst.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">⏳</div><div>加载中…</div></div>';
    }

    function showListView() {
        var box = $('mv2List'), sheet = $('mv2Sheet');
        if (sheet) sheet.style.display = 'none';
        if (box) { box.style.display = ''; box.className = 'mv2-list'; }
    }

    // 返回：从详情退回到上一层（搜索/首页）
    function goBack() {
        showListView();
        // 如果当前是搜索结果，重新渲染它
        if (lastSearch && lastSearch.list && lastSearch.list.length) {
            currentView = 'search';
            currentSheet = null;
            if (lastSearch.type === 'playlist') renderPlaylistCards(lastSearch.list, lastSearch.kw);
            else { setCount('共 ' + lastSearch.list.length + ' 首 · ' + srcLabel(curPlatform || '全部')); renderSongRows(lastSearch.list, lastSearch.kw, $('mv2List'), { pickable: true }); updatePickCount(); }
            setState('已就绪', 'ok');
        } else {
            loadHome();
        }
    }

    var lastSearch = null;   // { list, kw, type }  用于返回时恢复

    // 歌单卡片列表（搜索结果 type=playlist 或首页推荐）
    function renderPlaylistCards(list, kw) {
        var box = $('mv2List');
        if (!box) return;
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
        setCount('共 ' + Object.keys(seen).length + ' 个歌单');
    }

    // ==================== 搜索历史 ====================
    var HIST_KEY = 'vh_musicagg_hist';
    var HIST_MAX = 12;

    function getHist() {
        try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; }
    }
    function addSearchHist(kw) {
        kw = String(kw || '').trim();
        if (!kw) return;
        var list = getHist().filter(function (x) { return x !== kw; });
        list.unshift(kw);
        try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); } catch (e) {}
        renderHist();
    }
    function clearHist() {
        try { localStorage.removeItem(HIST_KEY); } catch (e) {}
        renderHist();
    }
    function renderHist() {
        var wrap = $('mv2HistWrap'), list = $('mv2HistList');
        if (!wrap || !list) return;
        var h = getHist();
        if (!h.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        list.innerHTML = '';
        h.forEach(function (kw) {
            var c = document.createElement('span');
            c.className = 'mv2-chip';
            c.textContent = kw;
            c.addEventListener('click', function () { doSearch(kw); });
            list.appendChild(c);
        });
    }

    // ==================== 搜索 ====================
    function doSearch(kwArg) {
        var kw = (typeof kwArg === 'string' ? kwArg : ($('mv2Query').value || '')).trim();
        if (!kw) { flash('请输入关键词'); return; }
        var qEl = $('mv2Query'); if (qEl) qEl.value = kw;
        addSearchHist(kw);
        curType = ($('mv2Type') && $('mv2Type').value) || 'song';
        showListView();
        currentView = 'search';
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
        lastSearch = { list: list, kw: kw, type: curType };
        if (!box) return;
        if (!list.length) {
            box.innerHTML = '<div class="mv2-empty"><div class="mv2-empty-ico">😐</div><div>没搜到「' + esc(kw) + '」</div><div class="mv2-empty-sub">换个关键词或类型试试</div></div>';
            setCount('');
            return;
        }
        if (curType === 'playlist') {
            renderPlaylistCards(list, kw);
            return;
        }
        setCount('共 ' + list.length + ' 首 · ' + srcLabel(curPlatform || '全部'));
        renderSongRows(list, kw, $('mv2List'), { pickable: true });
        updatePickCount();
    }

    // ==================== 歌曲行渲染 ====================
    // 容器显式传入（修过「搜过歌单后点歌单一直加载中」的 bug）。
    // options.pickable=true 时行前带勾选框（歌单详情用）。
    function renderSongRows(list, title, targetEl, options) {
        options = options || {};
        var box = targetEl || $('mv2List');
        if (!box) return;
        var pickable = !!options.pickable;
        box.innerHTML = '';
        // 只有搜索结果/歌单详情才当播放队列
        if (!options.keepQueue) { playlist = list.slice(); renderQueue(); }
        lastRendered = { list: list, title: title, targetEl: box, pickable: pickable };

        list.forEach(function (s, idx) {
            var row = document.createElement('div');
            row.className = 'mv2-row';
            row.setAttribute('data-idx', String(idx));

            if (pickable) {
                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'mv2-cb';
                cb.dataset.idx = String(idx);
                cb.addEventListener('click', function (ev) { ev.stopPropagation(); updatePickCount(); });
                row.appendChild(cb);
            }

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

    // 记住最近一次渲染（供返回到上一层）
    var lastRendered = null;

    // 批量选择相关
    function pickedSongs() {
        var out = [];
        if (!lastRendered || !lastRendered.pickable) return out;
        var box = lastRendered.targetEl;
        var cbs = box.querySelectorAll ? box.querySelectorAll('.mv2-cb') : [];
        for (var i = 0; i < cbs.length; i++) {
            if (cbs[i].checked) {
                var idx = parseInt(cbs[i].dataset.idx, 10);
                if (lastRendered.list[idx]) out.push(lastRendered.list[idx]);
            }
        }
        return out;
    }
    function updatePickCount() {
        var n = pickedSongs().length;
        var b = $('btnMv2DlSel');
        if (b) b.textContent = n ? ('下载选中（' + n + '）') : '下载选中';
    }
    function togglePickAll() {
        if (!lastRendered || !lastRendered.pickable) { flash('当前列表不支持多选'); return; }
        var box = lastRendered.targetEl;
        var cbs = box.querySelectorAll ? box.querySelectorAll('.mv2-cb') : [];
        var allOn = true;
        for (var i = 0; i < cbs.length; i++) { if (!cbs[i].checked) { allOn = false; break; } }
        for (var j = 0; j < cbs.length; j++) { cbs[j].checked = !allOn; }
        updatePickCount();
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
            cov.style.cursor = 'pointer';
        }
        // 大图 + 歌词悬浮层信息
        var big = $('mv2BigCover');
        if (big) { var im2 = s.img || s.picUrl || ''; if (im2) big.src = im2; big.style.display = im2 ? '' : 'none'; }
        var bt = $('mv2BigTitle'); if (bt) bt.textContent = s.name || '';
        var bs = $('mv2BigSub'); if (bs) bs.textContent = (s.singer || '') + (s.albumName ? (' · ' + s.albumName) : '');
        // 同步刷新歌词（仅在悬浮层已打开时）与播放列表，并启动频谱
        if ($('mv2LyricFloat') && $('mv2LyricFloat').style.display !== 'none') loadLyric(s);
        renderQueue();
        try { if (!audioCtx) initWave(); else drawWave(); } catch (e) {}
    }

    // ==================== 歌词（悬浮层） ====================
    var lyricLines = [];

    function parseLrc(text) {
        var out = [];
        if (!text) return out;
        text.split(/\r?\n/).forEach(function (line) {
            var m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
            if (!m) return;
            var t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
            var txt = (m[3] || '').trim();
            if (!txt) return;
            out.push({ t: t, text: txt });
        });
        out.sort(function (a, b) { return a.t - b.t; });
        return out;
    }

    var lyricCache = {};   // songmid -> lines（避免重复请求）

    function loadLyric(s) {
        var body = $('mv2LyricBody');
        if (!body) return;
        var key = String(s && s.songmid || '');
        if (!key) { lyricLines = []; body.innerHTML = '<div class="mv2-lyric-empty">暂无歌曲信息</div>'; return; }
        if (lyricCache[key]) { lyricLines = lyricCache[key]; renderLyric(); return; }
        lyricLines = [];
        body.innerHTML = '<div class="mv2-lyric-empty">加载歌词…</div>';
        var src = s.source || curPlatform || 'wy';
        api('/api/music/lyric?source=' + src + '&songmid=' + encodeURIComponent(key), { timeout: 30000 })
            .then(function (r) {
                var raw = (r && (r.lyric || r.lrc)) || '';
                var tl = (r && (r.tlyric || r.rlyric)) || '';
                var lines = parseLrc(raw);
                if (tl) {
                    var tr = parseLrc(tl);
                    var map = {};
                    tr.forEach(function (x) { map[Math.round(x.t)] = x.text; });
                    lines.forEach(function (x) {
                        var tt = map[Math.round(x.t)];
                        if (tt) x.text = x.text + '\n' + tt;
                    });
                }
                lyricCache[key] = lines;
                lyricLines = lines;
                renderLyric();
            })
            .catch(function () { body.innerHTML = '<div class="mv2-lyric-empty">暂无歌词</div>'; });
    }

    function renderLyric() {
        var body = $('mv2LyricBody');
        if (!body) return;
        if (!lyricLines.length) { body.innerHTML = '<div class="mv2-lyric-empty">暂无歌词</div>'; return; }
        body.innerHTML = '';
        lyricLines.forEach(function (x, i) {
            var d = document.createElement('div');
            d.className = 'mv2-lyric-line';
            d.dataset.idx = String(i);
            d.textContent = x.text;
            d.addEventListener('click', function () {
                var a = getAudio();
                if (a && isFinite(a.duration)) a.currentTime = x.t;
            });
            body.appendChild(d);
        });
    }

    function syncLyric(cur) {
        var body = $('mv2LyricBody');
        if (!body || !lyricLines.length) return;
        var idx = -1;
        for (var i = 0; i < lyricLines.length; i++) {
            if (lyricLines[i].t <= cur + 0.25) idx = i; else break;
        }
        if (idx < 0) return;
        var lines = body.children;
        for (var j = 0; j < lines.length; j++) {
            if (lines[j].classList) lines[j].classList.toggle('on', j === idx);
        }
        var curEl = lines[idx];
        if (curEl && typeof body.scrollTop === 'number') {
            try {
                var top = curEl.offsetTop - body.clientHeight / 2 + curEl.clientHeight / 2;
                body.scrollTop = Math.max(0, top);
            } catch (e) {}
        }
    }

    function toggleLyricFloat(show) {
        var box = $('mv2LyricFloat');
        if (!box) return;
        var willShow = (typeof show === 'boolean') ? show : (box.style.display === 'none');
        box.style.display = willShow ? '' : 'none';
        if (willShow && playIdx >= 0 && playlist[playIdx]) {
            loadLyric(playlist[playIdx]);
            setTimeout(function () { syncLyric((getAudio() || {}).currentTime || 0); }, 120);
        }
    }

    // ==================== 频谱波形（对齐网页端可视化）====================
    var audioCtx = null, analyser = null, srcNode = null, waveRAF = null;

    function initWave() {
        var a = getAudio();
        var cv = $('mv2WaveCanvas');
        if (!a || !cv) return;
        try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            if (!audioCtx) {
                audioCtx = new AC();
                srcNode = audioCtx.createMediaElementSource(a);
                analyser = audioCtx.createAnalyser();
                analyser.fftSize = 128;
                srcNode.connect(analyser);
                analyser.connect(audioCtx.destination);
            }
            drawWave();
        } catch (e) {
            // 某些环境下 createMediaElementSource 可能失败（不影响播放）
        }
    }

    function drawWave() {
        var cv = $('mv2WaveCanvas');
        if (!cv || !analyser) return;
        var ctx = cv.getContext ? cv.getContext('2d') : null;
        if (!ctx) return;
        var buf = new Uint8Array(analyser.frequencyBinCount);
        function frame() {
            waveRAF = requestAnimationFrame(frame);
            analyser.getByteFrequencyData(buf);
            var w = cv.width || 400, h = cv.height || 34;
            ctx.clearRect(0, 0, w, h);
            var bars = 40, bw = w / bars;
            for (var i = 0; i < bars; i++) {
                var v = buf[Math.floor(i * buf.length / bars)] / 255;
                var bh = Math.max(2, v * h);
                ctx.fillStyle = 'rgba(139,92,246,' + (0.35 + v * 0.5) + ')';
                ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
            }
        }
        if (waveRAF) cancelAnimationFrame(waveRAF);
        frame();
    }

    function stopWave() {
        if (waveRAF) { try { cancelAnimationFrame(waveRAF); } catch (e) {} waveRAF = null; }
    }

    // ==================== 播放列表 ====================
    function renderQueue() {
        var box = $('mv2QueueBox');
        var list = $('mv2Queue');
        var sum = $('mv2QueueSummary');
        if (!box || !list) return;
        if (!playlist.length) { box.style.display = 'none'; return; }
        box.style.display = '';
        if (sum) sum.textContent = '播放列表（' + playlist.length + ' 首）';
        list.innerHTML = '';
        playlist.forEach(function (s, i) {
            var row = document.createElement('div');
            row.className = 'mv2-q-item' + (i === playIdx ? ' on' : '');
            row.innerHTML = '<span class="mv2-q-no">' + (i + 1) + '</span>' +
                '<span class="mv2-q-name">' + esc(s.name || '') + '</span>' +
                '<span class="mv2-q-singer">' + esc(s.singer || s.artist || '') + '</span>';
            row.addEventListener('dblclick', function () { playListAt(i); });
            row.addEventListener('click', function () { playListAt(i); });
            list.appendChild(row);
        });
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
            syncLyric(a.currentTime);
        });
        a.addEventListener('loadedmetadata', function () {
            var dur = $('mv2Dur');
            if (dur) dur.textContent = fmtTime(a.duration);
        });
        a.addEventListener('play', function () { syncPlayIcon(); try { initWave(); } catch (e) {} });
        a.addEventListener('pause', function () { syncPlayIcon(); stopWave(); });
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
        // 歌词/大图：点封面或歌词按钮都打开悬浮层
        var lb = $('btnMv2Lyric');
        if (lb) lb.addEventListener('click', function () { toggleLyricFloat(); });
        var cov = $('mv2Cover');
        if (cov) cov.addEventListener('click', function () { toggleLyricFloat(true); });
        var lc = $('btnMv2LyricClose');
        if (lc) lc.addEventListener('click', function () { toggleLyricFloat(false); });
        var lf = $('mv2LyricFloat');
        if (lf) lf.addEventListener('click', function (ev) { if (ev.target === lf) toggleLyricFloat(false); });
        // 播放列表面板开关
        var qb = $('btnMv2Queue');
        if (qb) qb.addEventListener('click', function () {
            var box = $('mv2QueueBox');
            if (box) box.open = !box.open;
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

    // 选目录：统一用插件自带树形选择器（__vhPickDir），起始位置为「上次选的目录 → 音乐库」
    function pickDir(cb) {
        var start = getDlDir() || (function () { try { return localStorage.getItem('mllibDir') || ''; } catch (e) { return ''; } })();
        if (typeof window.__vhPickDir === 'function') {
            window.__vhPickDir({
                title: '选择歌曲保存目录',
                tip: start ? ('上次/音乐库：' + start) : '选择保存位置',
                startDir: start || undefined,
                root: start || undefined
            }, function (d) {
                if (d) setDlDir(d);
                cb(d || null);
            });
            return;
        }
        // 树形选择器未加载时，退回系统对话框（本地模式才可用）
        var agg = window.__musicAgg;
        if (agg && agg.getTarget() === 'local') {
            agg.api('/pick-dir', { method: 'POST', body: { desc: '选择歌曲保存目录', startDir: start }, timeout: 120000 })
                .then(function (r) {
                    var p = (r && r.data && r.data.path) || '';
                    if (p) { setDlDir(p); cb(p); } else cb(null);
                })
                .catch(function () { cb(null); });
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

    // ==================== 批量 / 整单下载 ====================
    // 串行下载（避免并发把服务打满），带进度与可中断
    var batchCancel = false;

    function downloadList(songs, label) {
        if (!songs || !songs.length) { flash('没有可下载的歌'); return; }
        var btnAll = $('btnMv2DlAll');
        var btnSel = $('btnMv2DlSel');
        // 正在下载时点同一按钮 = 停止
        if (btnAll && btnAll.dataset.busy === '1') { batchCancel = true; return; }
        pickDir(function (dir) {
            if (!dir) return;
            batchCancel = false;
            var ok = 0, fail = 0, i = 0;
            if (btnAll) { btnAll.textContent = '⏹ 停止'; btnAll.dataset.busy = '1'; }

            function finish(stopped) {
                if (btnAll) { btnAll.textContent = '下载整个歌单'; delete btnAll.dataset.busy; }
                if (btnSel) btnSel.textContent = '下载选中';
                var msg = (stopped ? '已停止，' : '') + '完成：成功 ' + ok + ' 首' + (fail ? ('，失败 ' + fail + ' 首') : '');
                setState(msg, fail ? 'err' : 'ok');
                flash(msg, fail ? 'err' : 'ok');
            }
            function tick() {
                if (batchCancel) { finish(true); return; }
                if (i >= songs.length) { finish(false); return; }
                var s = songs[i];
                var tip = label + '：' + (i + 1) + '/' + songs.length + ' · ' + (s.name || '');
                setState(tip, '');
                if (btnSel) btnSel.textContent = i + '/' + songs.length;
                api('/api/music/url', { method: 'POST', body: { songInfo: s, quality: '320k' }, timeout: 60000 })
                    .then(function (r) {
                        var url = (r && r.url) || ((r && r.data) || {}).url;
                        if (!url) throw new Error('无直链');
                        var fname = safeName((s.name || 'song') + ' - ' + (s.singer || s.artist || '')) + '.mp3';
                        return new Promise(function (res, rej) {
                            fetchToFile(proxyUrl(url), dir, fname, function (err, saved) { if (err) rej(new Error(err)); else res(saved); });
                        });
                    })
                    .then(function () { ok++; i++; setTimeout(tick, 120); })
                    .catch(function () { fail++; i++; setTimeout(tick, 120); });
            }
            tick();
        });
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

    // ==================== 平台切换（每平台独立现场）====================
    // 行为：
    //  1) 切走前存下当前平台的现场（首页/搜索结果/歌单）
    //  2) 切回的若是空平台 → 若有搜索词，在新平台重新搜一遍（显示该平台的结果）；
    //                            否则展示首页
    //  3) 切回的若是刚才离开的平台 → 原样恢复（包括正打开的的歌单）
    function setPlatform(id, opts) {
        opts = opts || {};
        var old = curPlatform;
        if (old === id && !opts.force) return;
        if (old) snapshotView();
        curPlatform = id;
        Array.prototype.forEach.call(document.querySelectorAll('#mv2Platforms .mv2-pf'), function (b) {
            b.classList.toggle('on', b.dataset.pf === id);
        });
        var saved = id ? viewByPlatform[id] : null;
        if (saved) { restoreView(saved); return; }
        // 新平台：有搜索词就重新搜（切到哪个平台显示哪个平台的结果）
        var kw = (lastSearch && lastSearch.kw) || ($('mv2Query') && ($('mv2Query').value || '').trim()) || '';
        if (kw) {
            curType = (lastSearch && lastSearch.type) || curType || 'song';
            var ty = $('mv2Type'); if (ty) ty.value = curType;
            doSearch(kw);
        } else {
            loadHome();
        }
    }

    function restoreView(v) {
        curType = v.type || 'song';
        var ty = $('mv2Type'); if (ty) ty.value = curType;
        var q = $('mv2Query'); if (q && v.kw) q.value = v.kw;
        if (v.view === 'sheet' && v.sheet) {
            // 恢复歌单/榜单现场
            openSheetLike(v.sheet, v.sheetList);
            return;
        }
        if (v.view === 'search' && v.list) {
            lastSearch = { list: v.list, kw: v.kw, type: v.type };
            showListView();
            currentView = 'search';
            if (v.type === 'playlist') renderPlaylistCards(v.list, v.kw);
            else { setCount('共 ' + v.list.length + ' 首 · ' + srcLabel(curPlatform || '全部')); renderSongRows(v.list, v.kw, $('mv2List'), { pickable: true }); updatePickCount(); }
            setState('已就绪', 'ok');
            return;
        }
        loadHome();
    }

    // 按现场直接恢复详情（不重新拉取）
    function openSheetLike(sheet, list) {
        currentSheet = sheet;
        showSheetView(sheet.data && sheet.data.name || '');
        currentView = 'sheet';
        if (list && list.length) {
            renderSongRows(list, (sheet.data && sheet.data.name) || '', $('mv2SheetList'), { pickable: true });
            updatePickCount();
            setState('共 ' + list.length + ' 首', 'ok');
        }
    }

    function bind() {
        Array.prototype.forEach.call(document.querySelectorAll('#mv2Platforms .mv2-pf'), function (b) {
            b.addEventListener('click', function () {
                // setPlatform 内部已处理「存当前平台现场 / 恢复目标平台现场 / 新平台重新搜索」
                setPlatform(b.dataset.pf);
            });
        });
        var s = $('btnMv2Search'); if (s) s.addEventListener('click', doSearch);
        var q = $('mv2Query');
        if (q) q.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doSearch(); });
        var hm = $('btnMv2Home'); if (hm) hm.addEventListener('click', function () { lastSearch = null; showListView(); loadHome(); });
        var hc = $('mv2HistClear'); if (hc) hc.addEventListener('click', function () { clearHist(); });
        var ty = $('mv2Type'); if (ty) ty.addEventListener('change', function () { if (($('mv2Query').value || '').trim()) doSearch(); });
        // 返回
        var bk = $('btnMv2Back'); if (bk) bk.addEventListener('click', goBack);
        // 多选 / 批量下载
        var sa = $('btnMv2SelAll'); if (sa) sa.addEventListener('click', togglePickAll);
        var ds = $('btnMv2DlSel');
        if (ds) ds.addEventListener('click', function () {
            var picked = pickedSongs();
            if (!picked.length) { flash('先勾选要下载的歌'); return; }
            downloadList(picked, '下载选中');
        });
        var da = $('btnMv2DlAll');
        if (da) da.addEventListener('click', function () {
            // 正在下载时点它 = 停止
            if (da.dataset.busy === '1') { batchCancel = true; return; }
            var all = (lastRendered && lastRendered.list) || [];
            if (!all.length) { flash('当前没有歌单内容'); return; }
            downloadList(all, '下载整单');
        });
        bindPlayer();
        renderHist();
        setPlatform('wy', { force: true });
        loadHome();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
