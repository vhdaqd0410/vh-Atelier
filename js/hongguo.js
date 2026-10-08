// vh-Atelier 工作台：红果短剧（在插件里直接看全集，不跳浏览器）
//
// 与「短剧扒歌」共用同一个本地服务（17891 · bgm/server.js），
// 但不复用扒歌的播放器（那个深度绑定 BGM 指纹 / 色块 / 结果区）。
// 本面板只做一件事：榜单/搜索 → 选集 → 自动下载并转码 → 播放。
//
// 为什么能看全集（实测）：
//   红果官网只放开前 3 集，第 4 集起页面 404（accessible_episode_cnt=3）；
//   插件自带的 App 链路（py/hongguo_app_dl.py，字节签名 + 设备号）能拿到任意集
//   的 mp4（第 10 集 1920p 实测可用），且不需要登录 —— 官网根本没有登录入口。
//   该直链是 CENC-AES-CTR 加密的 HEVC，服务端 ffmpeg 用派生 key 解密后转 H.264，
//   才能在 CEP 的 Chromium(99) 里播（这条链路服务端已实现，本面板复用）。
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        childProcess = require('child_process');
    } catch (e) { return; }
    if (!window.__vhLocalSvc) return;

    var API = 'http://127.0.0.1:17891';
    var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;
    var extRoot = '';
    try { if (csInterface) extRoot = csInterface.getSystemPath(SystemPath.EXTENSION); } catch (e) {}
    var serverJs = extRoot ? path.join(extRoot, 'bgm', 'server.js') : '';

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function safeName(s) { return String(s || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80); }
    function flash(msg, type) {
        var el = $('hgToast');
        if (!el) return;
        el.textContent = msg;
        el.className = 'hg-toast' + (type ? ' ' + type : '');
        el.style.display = '';
        clearTimeout(el._t);
        el._t = setTimeout(function () { el.style.display = 'none'; }, 2600);
    }

    // ==================== 本地服务（与扒歌同一端口，探活优先，不重复拉起）====================
    var child = null, srvLog = '', lastErr = '';

    function findNode() {
        var cands = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'];
        for (var i = 0; i < cands.length; i++) { if (fs.existsSync(cands[i])) return cands[i]; }
        try {
            var w = childProcess.spawnSync('where', ['node'], { encoding: 'utf8' });
            if (w.status === 0 && w.stdout) {
                var first = w.stdout.split('\n')[0].trim();
                if (first) return first;
            }
        } catch (e) {}
        return null;
    }

    function setState(text, cls) {
        var el = $('hgSrvState');
        if (!el) return;
        el.textContent = text;
        el.className = 'hg-srvstate' + (cls ? ' ' + cls : '');
    }

    function spawnServer() {
        try {
            if (!serverJs || !fs.existsSync(serverJs)) { setState('服务文件缺失', 'err'); return false; }
            var node = findNode();
            if (!node) { setState('未找到 Node.js', 'err'); return false; }
            if (child) return true;
            setState('正在启动服务…', '');
            child = childProcess.spawn(node, [serverJs], { cwd: path.dirname(serverJs), windowsHide: true });
            try {
                if (child.stdout) child.stdout.on('data', function (b) { srvLog = (srvLog + String(b)).slice(-800); });
                if (child.stderr) child.stderr.on('data', function (b) { srvLog = (srvLog + String(b)).slice(-800); });
            } catch (e) {}
            child.on('error', function (e) { srvLog = (srvLog + ' spawn error: ' + (e && e.message)).slice(-800); child = null; });
            child.on('close', function () { child = null; });
            return true;
        } catch (e) { return false; }
    }

    var svc = window.__vhLocalSvc.create({
        base: API,
        name: '红果短剧',
        defaultTimeout: 30000,
        healthTimeout: 8000,
        retries: 5,
        interval: 1500,
        emptyAsObject: true,
        errorStatusMessage: '服务未连接',
        errorNetMessage: '服务未连接',
        spawn: spawnServer,
        onState: function (t, c) { setState(t, c); },
        onError: function (e) { lastErr = (e && e.message) || ''; },
        errorMessage: function () {
            var node = findNode();
            return '后端服务启动失败（' + (node ? 'Node: ' + node : '未找到 Node.js')
                + (serverJs && fs.existsSync(serverJs) ? '' : '；服务文件缺失')
                + (srvLog ? '；日志: ' + srvLog.replace(/\s+/g, ' ').slice(-160) : '') + '）';
        }
    });

    function api(u, opt) { return svc.api(u, opt); }
    function post(u, body, timeout) { return api(u, { method: 'POST', body: body, timeout: timeout }); }

    // ==================== 状态 ====================
    var curSeries = null;   // { series_id, name, cover, vid_list, count, tags, intro }
    var localMap = {};      // ep -> { path, name, size, sizeMB, hasH264 }
    var curEp = 0;
    var autoNext = true;
    var jobPoll = null;
    var hotKind = 'all';
    var HIST_KEY = 'vh_hg_hist';
    var UI_KEY = 'vh_hg_state';

    function getHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; } }
    function saveHist(list) { try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 30))); } catch (e) {} }
    function addHist(it) {
        var list = getHist().filter(function (x) { return String(x.series_id) !== String(it.series_id); });
        list.unshift(it);
        saveHist(list);
        renderHist();
    }

    // ==================== 已下载检测 ====================
    function refreshLocal(cb) {
        api('/local-videos', { timeout: 15000 }).then(function (r) {
            var files = ((r && r.data && r.data.files) || []);
            localMap = {};
            if (curSeries) {
                var safe = safeName(curSeries.name || curSeries.series_id);
                var re = new RegExp('^' + safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_(\\d{4})\\.mp4$', 'i');
                files.forEach(function (f) {
                    var m = re.exec(f.name);
                    if (!m) return;
                    var ep = parseInt(m[1], 10);
                    if (!ep) return;
                    localMap[ep] = {
                        path: f.path, name: f.name, size: f.size,
                        sizeMB: (f.size / 1048576).toFixed(1), hasH264: !!f.hasH264,
                    };
                });
            }
            if (cb) cb();
        }).catch(function () { if (cb) cb(); });
    }

    // ==================== 首页：榜单 / 搜索 / 解析 ====================
    function loadHot(kind) {
        hotKind = kind || 'all';
        var grid = $('hgGrid');
        if (!grid) return;
        grid.innerHTML = '<div class="hint" style="padding:16px;">正在加载…</div>';
        $('hgHome').style.display = '';
        $('hgSeriesWrap').style.display = 'none';
        $('hgSearchWrap').style.display = 'none';
        api('/hot?kind=' + encodeURIComponent(hotKind), { timeout: 30000 }).then(function (r) {
            renderGrid((r && r.data) || []);
        }).catch(function (e) {
            grid.innerHTML = '<div class="hint" style="padding:16px;color:#f6a1b1;">加载失败：' + esc(e.message) + '</div>';
        });
    }

    function renderGrid(list) {
        var grid = $('hgGrid');
        if (!grid) return;
        if (!list || !list.length) { grid.innerHTML = '<div class="hint" style="padding:16px;">没有内容</div>'; return; }
        grid.innerHTML = '';
        list.forEach(function (it) {
            var card = document.createElement('div');
            card.className = 'hg-card';
            card.innerHTML =
                '<div class="hg-cover">' +
                    (it.cover ? '<img src="' + esc(it.cover) + '" alt="" onerror="this.style.display=&quot;none&quot;">' : '<div class="hg-nopic">🎬</div>') +
                    (it.count ? '<span class="hg-badge">' + esc(it.count) + '集</span>' : '') +
                '</div>' +
                '<div class="hg-name" title="' + esc(it.name || it.series_id) + '">' + esc(it.name || it.series_id) + '</div>';
            card.addEventListener('click', function () { openSeries(it); });
            grid.appendChild(card);
        });
    }

    function doSearch(kw) {
        kw = (kw || '').trim();
        if (!kw) { flash('请输入剧名'); return; }
        $('hgHome').style.display = 'none';
        $('hgSeriesWrap').style.display = 'none';
        $('hgSearchWrap').style.display = '';
        var list = $('hgSearchList');
        list.innerHTML = '<div class="hint" style="padding:16px;">正在搜索「' + esc(kw) + '」…</div>';
        api('/search?keyword=' + encodeURIComponent(kw), { timeout: 30000 }).then(function (r) {
            var arr = (r && r.data) || [];
            if (!arr.length) { list.innerHTML = '<div class="hint" style="padding:16px;">没搜到「' + esc(kw) + '」</div>'; return; }
            list.innerHTML = '';
            arr.forEach(function (it) {
                var row = document.createElement('div');
                row.className = 'hg-srow';
                row.innerHTML =
                    '<div class="hg-srow-cover">' +
                        (it.cover ? '<img src="' + esc(it.cover) + '" alt="" onerror="this.style.display=&quot;none&quot;">' : '<div class="hg-nopic">🎬</div>') +
                    '</div>' +
                    '<div class="hg-srow-main">' +
                        '<div class="hg-srow-name">' + esc(it.name || it.series_id) + '</div>' +
                        '<div class="hg-srow-meta">' + (it.count ? ('共 ' + it.count + ' 集') : '') + (it.actors ? (' · ' + esc(it.actors)) : '') + '</div>' +
                        '<div class="hg-srow-intro">' + esc(it.intro || '') + '</div>' +
                    '</div>';
                row.addEventListener('click', function () { openSeries(it); });
                list.appendChild(row);
            });
        }).catch(function (e) {
            list.innerHTML = '<div class="hint" style="padding:16px;color:#f6a1b1;">搜索失败：' + esc(e.message) + '</div>';
        });
    }

    function doShareParse(text) {
        text = (text || '').trim();
        if (!text) { flash('粘贴红果分享链接或剧 ID'); return; }
        flash('正在解析…');
        api('/share-parse?text=' + encodeURIComponent(text), { timeout: 30000 }).then(function (r) {
            if (r && r.code === 0 && r.data && (r.data.vid_list || []).length) {
                openSeries({
                    series_id: r.data.series_id, name: r.data.name, cover: r.data.cover,
                    tags: r.data.tags, intro: r.data.intro,
                    count: (r.data.vid_list || []).length, vid_list: r.data.vid_list,
                });
            } else {
                flash((r && r.msg) || '没识别出剧号（支持分享链接 / 短链 / 剧 ID）', 'err');
            }
        }).catch(function (e) { flash('解析失败：' + e.message, 'err'); });
    }

    function renderHist() {
        var wrap = $('hgHistWrap');
        var box = $('hgHist');
        if (!wrap || !box) return;
        var list = getHist();
        if (!list.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        box.innerHTML = '';
        list.slice(0, 12).forEach(function (it) {
            var c = document.createElement('div');
            c.className = 'hg-hist';
            c.innerHTML =
                '<div class="hg-hist-cover">' +
                    (it.cover ? '<img src="' + esc(it.cover) + '" alt="" onerror="this.style.display=&quot;none&quot;">' : '<div class="hg-nopic">🎬</div>') +
                '</div>' +
                '<div class="hg-hist-name" title="' + esc(it.name) + '">' + esc(it.name || '') + '</div>' +
                '<div class="hg-hist-ep">看到第 ' + (it.ep || 1) + ' 集</div>';
            c.addEventListener('click', function () {
                openSeries({ series_id: it.series_id, name: it.name, cover: it.cover, count: it.count }, it.ep);
            });
            box.appendChild(c);
        });
    }

    // ==================== 剧集页 ====================
    function openSeries(it, resumeEp) {
        // 榜单/搜索结果没有 vid_list，先补拉详情
        function goto(info) {
            curSeries = {
                series_id: info.series_id || it.series_id,
                name: info.name || it.name,
                cover: info.cover || it.cover,
                tags: info.tags || it.tags || [],
                intro: info.intro || it.intro || '',
                vid_list: info.vid_list || it.vid_list || [],
                count: (info.vid_list || it.vid_list || []).length || it.count || 0,
            };
            curEp = 0;
            $('hgHome').style.display = 'none';
            $('hgSearchWrap').style.display = 'none';
            $('hgSeriesWrap').style.display = '';
            $('hgSeriesName').textContent = curSeries.name || curSeries.series_id;
            refreshLocal(function () {
                renderSeries();
                saveState();
                if (resumeEp) playEpisode(resumeEp);
                try { $('hgSeriesWrap').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
            });
        }
        if (it.vid_list && it.vid_list.length) { goto(it); return; }
        $('hgSeriesName').textContent = it.name || it.series_id;
        $('hgSeriesWrap').style.display = '';
        $('hgHome').style.display = 'none';
        $('hgSearchWrap').style.display = 'none';
        if ($('hgEpGrid')) $('hgEpGrid').innerHTML = '<div class="hint" style="padding:12px;">正在获取集列表…</div>';
        api('/series?series_id=' + encodeURIComponent(it.series_id), { timeout: 30000 }).then(function (r) {
            goto((r && r.data) || it);
        }).catch(function (e) {
            flash('取集列表失败：' + e.message, 'err');
            goto(it);
        });
    }

    function backHome() {
        try { stopPlay(); } catch (e) {}
        curSeries = null;
        curEp = 0;
        saveState();
        $('hgSeriesWrap').style.display = 'none';
        $('hgPlayerWrap').style.display = 'none';
        $('hgHome').style.display = '';
    }

    function renderSeries() {
        var d = curSeries;
        if (!d) return;
        var head = $('hgSeriesHead');
        if (head) {
            var tags = (d.tags || []).map(function (t) { return '<span class="hg-chip">' + esc(t) + '</span>'; }).join('');
            head.innerHTML =
                '<div class="hg-shead">' +
                    '<div class="hg-scover">' +
                        (d.cover ? '<img src="' + esc(d.cover) + '" alt="" onerror="this.style.display=&quot;none&quot;">' : '<div class="hg-nopic">🎬</div>') +
                    '</div>' +
                    '<div class="hg-sinfo">' +
                        (tags ? '<div class="hg-chiprow">' + tags + '</div>' : '') +
                        '<div class="hg-sintro">' + esc(d.intro || '') + '</div>' +
                        '<div class="hg-scount">共 ' + ((d.vid_list || []).length || d.count || 0) + ' 集 · 已下载 ' + Object.keys(localMap).length + ' 集</div>' +
                    '</div>' +
                '</div>';
        }
        var vids = d.vid_list || [];
        var grid = $('hgEpGrid');
        if (!grid) return;
        grid.innerHTML = '';
        vids.forEach(function (v, i) {
            var ep = i + 1;
            var local = localMap[ep];
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'hg-ep' + (local ? ' is-local' : '') + (ep === curEp ? ' is-cur' : '');
            b.dataset.ep = String(ep);
            b.title = local ? ('第 ' + ep + ' 集（已下载 ' + local.sizeMB + 'MB，点击播放）') : ('第 ' + ep + ' 集（点击后自动下载并播放）');
            b.innerHTML = '<span class="hg-ep-n">' + ep + '</span>';
            b.addEventListener('click', function () { playEpisode(ep); });
            grid.appendChild(b);
        });
        if (!vids.length) grid.innerHTML = '<div class="hint" style="padding:12px;">没取到集列表</div>';
    }

    // ==================== 播放 ====================
    function playEpisode(ep) {
        if (!curSeries) return;
        var vids = curSeries.vid_list || [];
        if (ep < 1 || ep > vids.length) return;
        curEp = ep;
        markCurEp();
        if (localMap[ep]) { playLocal(ep); return; }
        showPlayer();
        $('hgPlayerTitle').textContent = (curSeries.name ? curSeries.name + ' · ' : '') + '第 ' + ep + ' 集';
        bufShow('正在下载第 ' + ep + ' 集', { pct: 0, sub: '下载完成后自动播放' });
        startJob('/download', {
            series_id: curSeries.series_id, vid: vids[ep - 1], name: curSeries.name, ep: ep,
        }, function (ok) {
            if (!ok) return;
            refreshLocal(function () { playLocal(ep); });
        }, false);
    }

    function playLocal(ep) {
        var loc = localMap[ep];
        if (!loc) { flash('第 ' + ep + ' 集本地文件不存在', 'err'); return; }
        showPlayer();
        curEp = ep;
        markCurEp();
        $('hgPlayerTitle').textContent = (curSeries && curSeries.name ? curSeries.name + ' · ' : '') + '第 ' + ep + ' 集';
        var v = $('hgV');
        if (!v) return;

        function useSrc() {
            v.src = API + '/video?prefer=h264&t=' + Date.now() + '&file=' + encodeURIComponent(loc.path);
            bufShow('正在准备播放…', { pct: null, sub: loc.name });
            waitCanPlay(v, function () {
                try { v.play().catch(function () {}); } catch (e) {}
                addHist({
                    series_id: curSeries.series_id, name: curSeries.name, cover: curSeries.cover,
                    count: (curSeries.vid_list || []).length, ep: ep,
                });
                saveState();
            });
            try { v.load(); } catch (e) {}
        }

        if (loc.hasH264) { useSrc(); return; }
        bufShow('正在检查视频格式…', { pct: null, sub: '第 ' + ep + ' 集' });
        api('/probe-codec?file=' + encodeURIComponent(loc.path), { timeout: 30000 }).then(function (r) {
            var codec = ((r && r.data && r.data.codec) || '').toLowerCase();
            if (codec === 'h264' || codec === 'avc1') { loc.hasH264 = true; useSrc(); return; }
            transcodeThenPlay(ep, loc);
        }).catch(function () { transcodeThenPlay(ep, loc); });
    }

    function transcodeThenPlay(ep, loc) {
        bufShow('正在转码（HEVC → H.264）', { pct: 0, sub: '第 ' + ep + ' 集 · 转码后自动播放' });
        startJob('/transcode', { file: loc.path }, function (ok) {
            if (!ok) return;
            refreshLocal(function () {
                if (localMap[ep]) localMap[ep].hasH264 = true;
                playLocal(ep);
            });
        }, true);
    }

    function startJob(pathname, body, onDone, isTranscode) {
        if (jobPoll) { clearTimeout(jobPoll); jobPoll = null; }
        post(pathname, body, 60000).then(function (r) {
            if (!r || r.code !== 0) {
                bufShow('启动失败：' + ((r && r.msg) || ''), { error: true });
                if (onDone) onDone(false);
                return;
            }
            pollJob(r.data.jobId, onDone, isTranscode);
        }).catch(function (e) {
            bufShow('启动失败：' + e.message, { error: true });
            if (onDone) onDone(false);
        });
    }

    function pollJob(jobId, onDone, isTranscode) {
        api('/status?jobId=' + encodeURIComponent(jobId), { timeout: 15000 }).then(function (r) {
            if (!r || r.code !== 0) { bufShow('任务丢失', { error: true }); if (onDone) onDone(false); return; }
            var d = r.data || {};
            if (d.state === 'running') {
                bufShow(d.msg || (isTranscode ? '转码中' : '下载中'), { pct: d.percent || 0, sub: (d.percent || 0) + '%' });
                jobPoll = setTimeout(function () { pollJob(jobId, onDone, isTranscode); }, 1000);
                return;
            }
            if (d.state === 'done') { bufShow('准备就绪', { pct: 100, sub: '' }); if (onDone) onDone(true); return; }
            bufShow('失败：' + (d.msg || '未知错误'), { error: true });
            if (onDone) onDone(false);
        }).catch(function (e) {
            bufShow('轮询失败：' + e.message, { error: true });
            if (onDone) onDone(false);
        });
    }

    function markCurEp() {
        var grid = $('hgEpGrid');
        if (!grid) return;
        Array.prototype.forEach.call(grid.children, function (b) {
            if (!b.dataset || !b.dataset.ep) return;
            b.classList.toggle('is-cur', String(b.dataset.ep) === String(curEp));
        });
    }

    // ==================== 播放器 UI ====================
    function showPlayer() {
        var w = $('hgPlayerWrap');
        if (w) { w.style.display = ''; }
    }

    var bufTimer = null;

    function bufShow(msg, opt) {
        opt = opt || {};
        var el = $('hgBuf');
        if (!el) return;
        el.style.display = '';
        el.classList.toggle('is-error', !!opt.error);
        var m = $('hgBufMsg'); if (m) m.textContent = msg;
        var wrap = $('hgBufBar'), fill = $('hgBufFill');
        if (opt.pct === undefined || opt.pct === null) { if (wrap) wrap.style.display = 'none'; }
        else {
            if (wrap) wrap.style.display = '';
            if (fill) fill.style.width = Math.max(0, Math.min(100, opt.pct)) + '%';
        }
        var s = $('hgBufSub'); if (s) s.textContent = opt.sub || '';
    }

    function bufHide() {
        var el = $('hgBuf');
        if (el) el.style.display = 'none';
        if (bufTimer) { clearTimeout(bufTimer); bufTimer = null; }
    }

    function waitCanPlay(v, onReady) {
        var settled = false;
        function done(ok, msg) {
            if (settled) return;
            settled = true;
            v.removeEventListener('canplay', onCan);
            v.removeEventListener('error', onErr);
            if (bufTimer) { clearTimeout(bufTimer); bufTimer = null; }
            if (!ok) bufShow(msg, { error: true });
            else { bufHide(); if (onReady) onReady(); }
        }
        function onCan() { done(true); }
        function onErr() {
            var e = v.error;
            var reason = e ? (e.code === 4 ? '格式不支持' : (e.message || ('错误 ' + e.code))) : '未知错误';
            done(false, '播放失败：' + reason);
        }
        v.addEventListener('canplay', onCan);
        v.addEventListener('error', onErr);
        if (bufTimer) clearTimeout(bufTimer);
        bufTimer = setTimeout(function () { done(false, '加载超时'); }, 15000);
    }

    function stopPlay() {
        var v = $('hgV');
        if (v) {
            try { v.pause(); } catch (e) {}
            try { v.removeAttribute('src'); v.load(); } catch (e) {}
        }
        if (jobPoll) { clearTimeout(jobPoll); jobPoll = null; }
        bufHide();
    }

    function closePlayer() {
        stopPlay();
        var w = $('hgPlayerWrap');
        if (w) w.style.display = 'none';
        saveState();
    }

    function navPlay(delta) {
        if (!curSeries) return;
        var total = (curSeries.vid_list || []).length;
        var next = curEp + delta;
        if (next < 1 || next > total) { flash(delta > 0 ? '已是最后一集' : '已是第一集'); return; }
        playEpisode(next);
    }

    // ==================== 持久化 ====================
    function saveState() {
        try {
            localStorage.setItem(UI_KEY, JSON.stringify({
                series: curSeries ? {
                    series_id: curSeries.series_id, name: curSeries.name, cover: curSeries.cover,
                    tags: curSeries.tags, intro: curSeries.intro,
                    count: curSeries.count, vid_list: curSeries.vid_list,
                } : null,
                ep: curEp, autoNext: autoNext,
            }));
        } catch (e) {}
    }

    function restoreState() {
        var s = null;
        try { s = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch (e) {}
        if (!s || !s.series || !(s.series.vid_list || []).length) return false;
        curSeries = s.series;
        curEp = s.ep || 0;
        autoNext = s.autoNext !== false;
        var an = $('hgAutoNext'); if (an) an.checked = autoNext;
        $('hgHome').style.display = 'none';
        $('hgSearchWrap').style.display = 'none';
        $('hgSeriesWrap').style.display = '';
        $('hgSeriesName').textContent = curSeries.name || curSeries.series_id;
        refreshLocal(function () { renderSeries(); });
        return true;
    }

    // ==================== 绑定 / 生命周期 ====================
    function bind() {
        var s = $('btnHgSearch');
        if (s) s.addEventListener('click', function () { doSearch($('hgQuery').value); });
        var q = $('hgQuery');
        if (q) q.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doSearch(q.value); });
        var sp = $('btnHgShareParse');
        if (sp) sp.addEventListener('click', function () { doShareParse($('hgShare').value); });
        var sh = $('hgShare');
        if (sh) sh.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doShareParse(sh.value); });
        var bk = $('btnHgBack'); if (bk) bk.addEventListener('click', backHome);
        var hc = $('hgHistClear'); if (hc) hc.addEventListener('click', function () { saveHist([]); renderHist(); });

        Array.prototype.forEach.call(document.querySelectorAll('#hgHome .hg-tab'), function (b) {
            b.addEventListener('click', function () {
                Array.prototype.forEach.call(document.querySelectorAll('#hgHome .hg-tab'), function (x) { x.classList.remove('active'); });
                b.classList.add('active');
                loadHot(b.dataset.kind);
            });
        });

        var pc = $('btnHgClose'); if (pc) pc.addEventListener('click', closePlayer);
        var pp = $('btnHgPrev'); if (pp) pp.addEventListener('click', function () { navPlay(-1); });
        var pp2 = $('btnHgPlayPause');
        if (pp2) pp2.addEventListener('click', function () {
            var vv = $('hgV'); if (!vv) return;
            if (vv.paused) { try { vv.play().catch(function () {}); } catch (e) {} }
            else { try { vv.pause(); } catch (e) {} }
        });
        var pn = $('btnHgNext'); if (pn) pn.addEventListener('click', function () { navPlay(1); });
        var v = $('hgV');
        if (v) {
            v.addEventListener('click', function () {
                if (v.paused) { try { v.play().catch(function () {}); } catch (e) {} }
                else { try { v.pause(); } catch (e) {} }
            });
            v.addEventListener('play', function () { var b = $('btnHgPlayPause'); if (b) b.textContent = '⏸'; });
            v.addEventListener('pause', function () { var b = $('btnHgPlayPause'); if (b) b.textContent = '▶'; });
            v.addEventListener('ended', function () { if (autoNext) navPlay(1); });
        }
        var an = $('hgAutoNext');
        if (an) {
            an.checked = autoNext;
            an.addEventListener('change', function () { autoNext = !!an.checked; saveState(); });
        }
        renderHist();
    }

    function onShow() {
        try { svc.ensureServer(0, true); } catch (e) {}
        if (!restoreState()) loadHot(hotKind);
        renderHist();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();

    window.__hgOnShow = onShow;
    window.__hgEnsure = function () { try { return svc.ensureServer(0, true); } catch (e) { return null; } };
})();
