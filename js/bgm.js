// vh-Atelier 短剧扒歌
// 输入短剧名/文件/目录 → 抽音轨 → 人声分离取伴奏轨 → 滑窗指纹 → 网易云识别 → 歌单
// 服务：bgm/server.js（端口 17891，零依赖，走更新通道）
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    var API = 'http://127.0.0.1:17891';
    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var bgmDir = path.join(extRoot, 'bgm');
    var bgmIndex = path.join(bgmDir, 'server.js');
    var bgmChild = null;

    var curSeries = null;      // { series_id, name, vid_list }
    var curJobId = null;
    var pollTimer = null;
    var lastResult = null;      // 最近一次识别结果
    var selected = {};          // songId -> song（勾选要入库的）

    function $(id) { return document.getElementById(id); }

    function flash(msg) {
        if (window.__copyFlash) { try { window.__copyFlash(msg); return; } catch (e) {} }
        try {
            var t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);background:#2a3a2a;color:#7fd68b;padding:6px 14px;border-radius:6px;font-size:12px;z-index:10001;pointer-events:none;';
            document.body.appendChild(t);
            setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2200);
        } catch (e) {}
    }

    function api(url, opt) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(opt && opt.method ? opt.method : 'GET', API + url, true);
            if (opt && opt.body) xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.timeout = opt && opt.timeout ? opt.timeout : 30000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) return reject(new Error('服务未连接'));
                try { resolve(JSON.parse(xhr.responseText || '{}')); }
                catch (e) { reject(new Error('响应解析失败')); }
            };
            xhr.ontimeout = function () { reject(new Error('请求超时')); };
            xhr.onerror = function () { reject(new Error('服务未连接')); };
            xhr.send(opt && opt.body ? JSON.stringify(opt.body) : null);
        });
    }

    function post(url, body, timeout) {
        return api(url, { method: 'POST', body: body, timeout: timeout });
    }

    // ---------- 服务自举 ----------
    function findNode() {
        var cands = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'];
        for (var i = 0; i < cands.length; i++) if (fs.existsSync(cands[i])) return cands[i];
        try {
            var w = childProcess.spawnSync('where', ['node'], { encoding: 'utf8' });
            if (w.status === 0 && w.stdout) return w.stdout.split('\n')[0].trim();
        } catch (e) {}
        return null;
    }

    function spawnServer() {
        try {
            if (!fs.existsSync(bgmIndex)) { setSrvState('服务文件缺失', 'err'); return false; }
            var node = findNode();
            if (!node) { setSrvState('未找到 Node.js', 'err'); return false; }
            if (bgmChild) return true;
            setSrvState('正在启动服务…', '');
            bgmChild = childProcess.spawn(node, [bgmIndex], { cwd: bgmDir, windowsHide: true });
            bgmChild.on('error', function () { bgmChild = null; setSrvState('启动失败', 'err'); });
            bgmChild.on('close', function () { bgmChild = null; });
            return true;
        } catch (e) { setSrvState('启动异常', 'err'); return false; }
    }

    function setSrvState(txt, cls) {
        var el = $('bgmSrvState');
        if (!el) return;
        el.textContent = txt;
        el.className = 'music-server' + (cls ? ' ' + cls : '');
    }

    function ensureServer(retries) {
        var tries = retries || 0;
        return api('/health', { timeout: 5000 }).then(function (h) {
            setSrvState('服务正常', 'ok');
            var hint = $('bgmLoginHint');
            if (hint) {
                if (!h.logged) hint.textContent = '⚠ 未登录网易云，请先在「网易云」板块登录';
                else if (!h.sherpa || !h.model) hint.textContent = '⚠ 缺少人声分离组件';
                else hint.textContent = '';
            }
            return h;
        }).catch(function () {
            if (tries < 1) {
                spawnServer();
                return new Promise(function (res) {
                    setTimeout(function () { res(ensureServer(tries + 1)); }, 2000);
                });
            }
            setSrvState('服务未连接', 'err');
            throw new Error('后端服务启动失败，请确认已安装 Node.js');
        });
    }

    // ---------- 搜索 ----------
    function doSearch() {
        var kw = ($('bgmQuery') || {}).value || '';
        kw = kw.trim();
        if (!kw) { flash('请输入短剧名'); return; }
        setSrvState('搜索中…', '');
        ensureServer().then(function () {
            return api('/search?keyword=' + encodeURIComponent(kw), { timeout: 40000 });
        }).then(function (r) {
            setSrvState('服务正常', 'ok');
            if (r.code !== 0) { flash(r.msg || '搜索失败'); return; }
            renderSearch(r.data || []);
        }).catch(function (e) { setSrvState('服务未连接', 'err'); flash(e.message); });
    }

    function renderSearch(list) {
        var wrap = $('bgmSearchWrap'), box = $('bgmSearchList');
        if (!wrap || !box) return;
        box.innerHTML = '';
        if (!list.length) {
            box.innerHTML = '<div class="bgm-item"><div class="bgm-item-main"><div class="bgm-item-name" style="color:var(--muted);">没有搜到结果</div></div></div>';
        } else {
            list.forEach(function (it, i) {
                var el = document.createElement('div');
                el.className = 'bgm-card';
                var tags = (it.tags || []).map(function (t) {
                    return '<span class="bgm-chip">' + esc(t) + '</span>';
                }).join('');
                var epTxt = it.count ? (it.count + ' 集') : '';
                var actorTxt = (it.actors && it.actors !== '暂无演员信息') ? ('演员：' + esc(it.actors)) : '';
                el.innerHTML =
                    '<img class="bgm-cover" src="' + esc(it.cover || '') + '" alt="" ' +
                        'onerror="this.style.visibility=&quot;hidden&quot;">' +
                    '<div class="bgm-card-main">' +
                        '<div class="bgm-card-title bgm-play">' + esc(it.name || ('剧集 ' + it.series_id)) + '</div>' +
                        '<div class="bgm-card-meta">' + tags +
                            (epTxt ? '<span class="bgm-chip">' + epTxt + '</span>' : '') + '</div>' +
                        (actorTxt ? '<div class="bgm-card-actor">' + actorTxt + '</div>' : '') +
                        '<div class="bgm-card-intro">' + esc(it.intro || '') + '</div>' +
                        '<div class="bgm-card-actions">' +
                            '<span class="bgm-item-act bgm-pick">选此剧扒歌</span>' +
                            '<span class="bgm-item-act bgm-look">先看看</span>' +
                        '</div>' +
                    '</div>';
                el.querySelector('.bgm-play').addEventListener('click', function () { openSeries(it); });
                el.querySelector('.bgm-pick').addEventListener('click', function () { openSeries(it); });
                el.querySelector('.bgm-look').addEventListener('click', function () { previewSeries(it); });
                box.appendChild(el);
            });
        }
        wrap.style.display = '';
        $('bgmSeriesWrap').style.display = 'none';
        $('bgmResultWrap').style.display = 'none';
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ---------- 预览（内嵌官网播放页，无需逆向解析） ----------
    function previewSeries(it) {
        openPreview('https://hongguoduanju.com/player/' + it.series_id + '/', it.name || it.series_id, 1);
    }

    function previewEpisode(vid, label) {
        if (!curSeries) return;
        openPreview('https://hongguoduanju.com/player/' + curSeries.series_id + '/' + vid + '/',
            (curSeries.name || '') + ' ' + label, 0);
    }

    function openPreview(url, title, isFirst) {
        var wrap = $('bgmPreviewWrap');
        if (!wrap) return;
        wrap.style.display = '';
        $('bgmPreviewTitle').textContent = title || '';
        var f = $('bgmPreviewFrame');
        // 防止重复加载同一地址
        if (f.getAttribute('data-cur') !== url) {
            f.setAttribute('data-cur', url);
            f.src = isFirst ? url.replace(/\/$/, '/') : url;
        }
        // 滚到预览区
        try { wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    }

    function closePreview() {
        var wrap = $('bgmPreviewWrap');
        if (wrap) wrap.style.display = 'none';
        var f = $('bgmPreviewFrame');
        if (f) { f.removeAttribute('data-cur'); f.src = 'about:blank'; }
    }

    function openExternalPreview() {
        var f = $('bgmPreviewFrame');
        var u = f && f.getAttribute('data-cur');
        if (!u) { flash('先选一部剧预览'); return; }
        try { childProcess.exec('start "" "' + u + '"'); } catch (e) { flash('打开外部浏览器失败'); }
    }

    // ---------- 剧集 ----------
    function openSeries(it) {
        ensureServer().then(function () {
            return api('/series?series_id=' + encodeURIComponent(it.series_id), { timeout: 40000 });
        }).then(function (r) {
            if (r.code !== 0) { flash(r.msg || '获取剧集失败'); return; }
            curSeries = r.data;
            renderSeries();
        }).catch(function (e) { flash(e.message); });
    }

    function renderSeries() {
        var d = curSeries;
        if (!d) return;
        $('bgmSearchWrap').style.display = 'none';
        $('bgmSeriesWrap').style.display = '';
        $('bgmSeriesName').textContent = d.name || d.series_id;
        $('bgmSeriesCount').textContent = '共 ' + d.count + ' 集';
        refreshLocal();   // 拉本地已下载列表，标出哪些集已就绪

        // 剧集头：封面 + 标签 + 简介
        var head = $('bgmSeriesHead');
        if (head) {
            var tags = (d.tags || []).map(function (t) { return '<span class="bgm-chip">' + esc(t) + '</span>'; }).join('');
            head.innerHTML =
                '<img class="bgm-cover" src="' + esc(d.cover || '') + '" alt="" ' +
                    'onerror="this.style.visibility=&quot;hidden&quot;">' +
                '<div class="bgm-card-main">' +
                    '<div class="bgm-card-meta">' + tags + '</div>' +
                    '<div class="bgm-card-intro">' + esc(d.intro || '') + '</div>' +
                    '<div class="bgm-card-actions">' +
                        '<span class="bgm-item-act" id="bgmHeadPreview">▶ 预览第 1 集</span>' +
                        '<span class="bgm-item-act" id="bgmHeadExternal">用浏览器打开</span>' +
                    '</div>' +
                '</div>';
            var pv = $('bgmHeadPreview');
            if (pv) pv.addEventListener('click', function () {
                openPreview('https://hongguoduanju.com/player/' + d.series_id + '/', d.name + ' 第1集', 1);
            });
            var ex = $('bgmHeadExternal');
            if (ex) ex.addEventListener('click', function () {
                openPreview('https://hongguoduanju.com/player/' + d.series_id + '/', d.name + ' 第1集', 1);
                openExternalPreview();
            });
        }

        var box = $('bgmEpList');
        box.innerHTML = '';
        // 只渲染前 60 集，避免一次塞太多 DOM
        (d.vid_list || []).slice(0, 60).forEach(function (v, i) {
            var ep = i + 1;
            var local = localMap[ep];
            var el = document.createElement('div');
            el.className = 'bgm-item';
            el.innerHTML =
                '<span class="bgm-item-idx">' + ep + '</span>' +
                '<div class="bgm-item-main"><div class="bgm-item-name">第 ' + ep + ' 集</div>' +
                '<div class="bgm-item-sub">' + (local ? '✔ 已下载 ' + local.sizeMB + 'MB' : esc(v)) + '</div></div>' +
                (local ? '<span class="bgm-item-act on bgm-playnow">播放</span>' : '') +
                '<span class="bgm-item-act bgm-watch">' + (local ? '重下' : '下载') + '</span>' +
                '<span class="bgm-item-act bgm-pick">扒这集</span>';
            var pn = el.querySelector('.bgm-playnow');
            if (pn) pn.addEventListener('click', function () { playEpisode(ep, v); });
            el.querySelector('.bgm-watch').addEventListener('click', function () {
                downloadEpisode(v, ep);
            });
            el.querySelector('.bgm-pick').addEventListener('click', function () {
                pickEpisode(v, ep);
            });
            box.appendChild(el);
        });
        if ((d.vid_list || []).length > 60) {
            var more = document.createElement('div');
            more.className = 'bgm-item';
            more.innerHTML = '<div class="bgm-item-main"><div class="bgm-item-sub">… 其余 ' + (d.vid_list.length - 60) + ' 集请用「扒整剧」批量处理</div></div>';
            box.appendChild(more);
        }
        var hint = $('bgmSeriesHint');
        if (hint) {
            hint.innerHTML = '本地已有则直接「播放」；没有则点「下载」（自动选官网/App 链路）';
        }
    }

    // 单集：自动下载后扒（不再要求先有本地文件）
    function pickEpisode(vid, epNo) {
        if (!curSeries) return;
        startBgm('/episode', {
            series_id: curSeries.series_id, vid: vid, name: curSeries.name, ep: epNo,
            start: null, end: null,
        }, '第 ' + epNo + ' 集（自动下载后扒）');
    }

    // 仅下载这一集到本地
    function downloadEpisode(vid, epNo, autoPlay) {
        if (!curSeries) return;
        pendingAutoPlay = autoPlay ? epNo : 0;
        startBgm('/download', {
            series_id: curSeries.series_id, vid: vid, name: curSeries.name, ep: epNo,
        }, '下载第 ' + epNo + ' 集');
    }

    // ---------- 本地已下载列表 ----------
    var localMap = {};    // ep -> { path, name, sizeMB }
    var localAll = [];   // 全部本地视频

    function refreshLocal() {
        return api('/local-videos', { timeout: 15000 }).then(function (r) {
            localAll = ((r.data || {}).files) || [];
            localMap = {};
            if (!curSeries) return r;
            var safe = String(curSeries.name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
            localAll.forEach(function (f) {
                // 文件名约定：<剧名>_<4位集号>.mp4
                if (safe && f.name.indexOf(safe) !== 0) return;
                var m = /_(\d{4})\.(mp4|mkv|mov|webm)$/i.exec(f.name);
                if (!m) return;
                var ep = parseInt(m[1], 10);
                localMap[ep] = { path: f.path, name: f.name, sizeMB: (f.size / 1048576).toFixed(1) };
            });
            var meta = $('bgmEpMeta');
            if (meta) {
                var n = Object.keys(localMap).length;
                meta.textContent = n ? ('本剧已下载 ' + n + ' 集到本地') : '';
            }
            return r;
        }).catch(function () { return null; });
    }

    function openDownloadDir() {
        api('/local-videos', { timeout: 10000 }).then(function (r) {
            var dir = ((r.data || {}).dir) || '';
            if (!dir) { flash('没拿到下载目录'); return; }
            try { childProcess.exec('explorer.exe "' + dir + '"'); }
            catch (e) { flash('打开目录失败'); }
        }).catch(function (e) { flash(e.message); });
    }

    // ---------- 播放（本地文件，边下边看）----------
    var playEp = 0;
    var pendingAutoPlay = 0;   // 下载完成后自动播哪一集

    function playEpisode(ep, vid) {
        if (!localMap[ep]) {
            flash('第 ' + ep + ' 集还没下载，正在下载…');
            downloadEpisode(vid, ep, true);
            return;
        }
        playLocal(ep);
    }

    function playLocal(ep) {
        var loc = localMap[ep];
        if (!loc) { flash('第 ' + ep + ' 集本地文件不存在'); return; }
        var wrap = $('bgmPlayerWrap');
        if (wrap) wrap.style.display = '';
        playEp = ep;
        $('bgmPlayerTitle').textContent = (curSeries && curSeries.name ? curSeries.name + ' ' : '') + '第 ' + ep + ' 集';
        var v = $('bgmV');
        if (!v) return;
        v.src = API + '/video?file=' + encodeURIComponent(loc.path);
        try { v.load(); v.play().catch(function () {}); } catch (e) {}
        var info = $('bgmPlayerInfo');
        if (info) info.textContent = loc.name + '  ' + loc.sizeMB + 'MB  ·  ' + loc.path;
        try { localStorage.setItem('vh_bgm_last_ep', String(ep)); } catch (e) {}
    }

    function playNav(delta) {
        if (!curSeries || !playEp) return;
        var ep = playEp + delta;
        if (ep < 1 || ep > (curSeries.vid_list || []).length) { flash('已经到头了'); return; }
        var vid = curSeries.vid_list[ep - 1];
        if (localMap[ep]) playLocal(ep);
        else { flash('第 ' + ep + ' 集还没下载，正在下载…'); downloadEpisode(vid, ep, true); }
    }

    function closePlayer() {
        var wrap = $('bgmPlayerWrap');
        if (wrap) wrap.style.display = 'none';
        var v = $('bgmV');
        if (v) { try { v.pause(); } catch (e) {} v.removeAttribute('src'); try { v.load(); } catch (e) {} }
        playEp = 0;
    }

    // ---------- 扒歌 ----------
    function startSingleByFile() {
        post('/pick-file', {}, 120000).then(function (r) {
            var p = (r.data || {}).path;
            if (!p) return;
            var start = ($('bgmStart') || {}).value;
            var end = ($('bgmEnd') || {}).value;
            startBgm('/single', { input: p, start: start || null, end: end || null, mode: 'accomp' },
                '单集扒歌');
        }).catch(function (e) { flash(e.message); });
    }

    function startBatchByDir() {
        post('/pick-dir', {}, 120000).then(function (r) {
            var p = (r.data || {}).path;
            if (!p) return;
            var lim = parseInt(($('bgmLimit') || {}).value, 10);
            startBgm('/batch', { dir: p, limit: isNaN(lim) ? 0 : lim }, '本地目录批量扒歌');
        }).catch(function (e) { flash(e.message); });
    }

    // 在线批量：自动逐集下载再扒
    function startOnlineBatch() {
        if (!curSeries) { flash('先选一部剧'); return; }
        var from = parseInt(($('bgmFromEp') || {}).value, 10);
        var cnt = parseInt(($('bgmCount') || {}).value, 10);
        if (isNaN(from) || from < 1) from = 1;
        if (isNaN(cnt) || cnt < 1) cnt = 10;
        if (cnt > 200) { flash('一次最多 200 集'); return; }
        startBgm('/batch', {
            series_id: curSeries.series_id, name: curSeries.name, from: from, count: cnt,
        }, '在线批量 ' + from + '~' + (from + cnt - 1) + ' 集');
    }

    function startBgm(endpoint, body, label) {
        // 纯下载 / 自动下载不需要网易云登录；只有扒歌（识别）才需要
        var needLogin = (endpoint === '/single' || endpoint === '/batch')
        var needSep = (endpoint !== '/download')
        ensureServer().then(function (h) {
            if (needLogin && !h.logged) { flash('未登录网易云，请先在「网易云」板块登录'); throw new Error('__stop'); }
            if (needSep && (!h.sherpa || !h.model)) { flash('缺少人声分离组件'); throw new Error('__stop'); }
            return post(endpoint, body, 60000);
        }).then(function (r) {
            if (!r || r.code !== 0) { flash((r && r.msg) || '启动失败'); return; }
            curJobId = (r.data || {}).jobId;
            showProgress(label);
            poll();
        }).catch(function (e) { if (e.message !== '__stop') flash(e.message); });
    }

    function showProgress(label) {
        var el = $('bgmProgress');
        if (el) el.style.display = '';
        $('bgmResultWrap').style.display = 'none';
        setProg(0, label + '：准备中…', '');
        var c = $('btnBgmCancel');
        if (c) c.style.display = '';
    }

    function setProg(pct, msg, timeTxt) {
        var b = $('bgmProgBar'), m = $('bgmProgMsg'), p = $('bgmProgPct'), t = $('bgmProgTime');
        if (b) b.style.width = pct + '%';
        if (m) m.textContent = msg;
        if (p) p.textContent = pct + '%';
        if (t) t.textContent = timeTxt || '';
    }

    // 结果为空时，给出可能原因提示
    function emptyHint(res) {
        var per = (res && res.perEp) || [];
        var fail = per.filter(function (e) { return e.error; });
        if (fail.length && fail.length === per.length) {
            var locked = fail.filter(function (e) { return /未开放试看|播放页|404/.test(e.error); }).length;
            if (locked === fail.length) {
                return '这些集未开放试看（官网只开放前 3 集）。要扒后面的集，得先用别的方式把视频下到本地，再用「选择本地文件…」。';
            }
            return '全部失败：' + fail[0].error;
        }
        return '本集没有识别出 BGM（可能是纯对白段）';
    }

    function poll() {
        if (!curJobId) return;
        if (pollTimer) clearTimeout(pollTimer);
        api('/status?jobId=' + encodeURIComponent(curJobId), { timeout: 15000 }).then(function (r) {
            if (r.code !== 0) { flash(r.msg || '任务丢失'); hideProgress(); return; }
            var d = r.data || {};
            var elapsed = d.elapsed || 0;
            setProg(d.percent || 0, d.msg || '', '已用 ' + elapsed + 's' +
                (d.percent > 3 ? '，预计剩余 ' + Math.max(0, Math.round(elapsed * (100 - d.percent) / d.percent)) + 's' : ''));
            if (d.state === 'running') {
                pollTimer = setTimeout(poll, 1200);
            } else {
                hideProgress();
                if (d.state === 'done') onJobDone(d);
                else flash(d.msg || '任务结束');
            }
        }).catch(function () { pollTimer = setTimeout(poll, 2000); });
    }

    // 任务完成后的分发：下载类显示产物与路径，识别类渲染结果
    function onJobDone(d) {
        var res = d.result || {};
        var jobKind = d.kind || '';
        if (res.file) {
            // 下载类任务
            var mb = ((res.size || 0) / 1048576).toFixed(1);
            flash('已下载 ' + mb + 'MB，共 ' + d.msg);
            var info = $('bgmPlayerInfo');
            if (info) info.textContent = '已保存到：' + res.file;
            refreshLocal().then(function () {
                if (pendingAutoPlay) {
                    var ep = pendingAutoPlay;
                    pendingAutoPlay = 0;
                    if (localMap[ep]) playLocal(ep);
                }
            });
            return;
        }
        if (jobKind === 'batch' || d.percent === 100) {
            refreshLocal();
        }
        renderResult(res);
    }

    function hideProgress() {
        var el = $('bgmProgress');
        if (el) el.style.display = 'none';
        var c = $('btnBgmCancel');
        if (c) c.style.display = 'none';
        curJobId = null;
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    }

    function stopJob() {
        if (!curJobId) return;
        post('/cancel', { jobId: curJobId }, 10000).then(function () {
            flash('已停止');
            hideProgress();
        }).catch(function () { hideProgress(); });
    }

    function renderResult(res) {
        if (!res) return;
        lastResult = res;
        selected = {};
        var wrap = $('bgmResultWrap'), box = $('bgmResultList');
        var songs = res.songs || [];
        $('bgmResultTitle').textContent = '识别结果 · ' + songs.length + ' 首' +
            (res.duration ? '（音频 ' + res.duration + 's，扫描 ' + res.windows + ' 窗' : '') +
            (res.episodes ? '，' + res.episodes + ' 集' : '') + ')';

        box.innerHTML = '';
        if (!songs.length) {
            box.innerHTML = '<div class="bgm-item"><div class="bgm-item-main"><div class="bgm-item-name" style="color:var(--muted);">' +
                esc(emptyHint(res)) + '</div></div></div>';
        } else {
            songs.forEach(function (s, i) {
                var el = document.createElement('div');
                el.className = 'bgm-item';
                var epTag = s.eps ? '<span class="bgm-item-ep">' + s.eps + ' 集</span>' : '';
                var timeTag = s.at != null ? ' @' + s.at + '~' + s.to + 's' : '';
                el.innerHTML =
                    '<span class="bgm-item-idx">' + (i + 1) + '</span>' +
                    '<div class="bgm-item-main">' +
                        '<div class="bgm-item-name">' + esc(s.name) + ' — ' + esc(s.artist) + '</div>' +
                        '<div class="bgm-item-sub">' + esc(s.album || '') + '  · 命中 ' + s.count + timeTag + '</div>' +
                    '</div>' + epTag +
                    '<span class="bgm-item-tag">' + s.count + '×</span>' +
                    '<span class="bgm-item-act" data-id="' + s.id + '">选用</span>';
                el.querySelector('.bgm-item-act').addEventListener('click', function () {
                    var btn = this, id = btn.getAttribute('data-id');
                    if (selected[id]) { delete selected[id]; btn.classList.remove('on'); btn.textContent = '选用'; }
                    else { selected[id] = s; btn.classList.add('on'); btn.textContent = '已选'; }
                });
                box.appendChild(el);
            });
        }
        wrap.style.display = '';
    }

    // ---------- 入库 ----------
    function toPlaylist() {
        var ids = Object.keys(selected);
        if (!ids.length) { flash('请先点「选用」挑出要入库的歌'); return; }
        post('/my-playlists', {}, 30000).then(function (r) {
            if (r.code !== 0) { flash(r.msg || '获取歌单失败'); return; }
            showPlaylistPicker((r.data || {}).playlists || [], ids);
        }).catch(function (e) { flash(e.message); });
    }

    function showPlaylistPicker(list, ids) {
        var old = document.getElementById('bgmPlMask');
        if (old) old.remove();
        var mask = document.createElement('div');
        mask.id = 'bgmPlMask';
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;';
        var card = document.createElement('div');
        card.style.cssText = 'background:var(--panel);border:1px solid var(--border);border-radius:10px;width:380px;max-height:70vh;display:flex;flex-direction:column;overflow:hidden;';
        var mine = list.filter(function (x) { return x.mine; });
        card.innerHTML =
            '<div style="padding:12px 14px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;">选一个歌单加入（' + ids.length + ' 首）</div>' +
            '<div id="bgmPlBody" style="padding:8px;overflow-y:auto;flex:1;"></div>' +
            '<div style="padding:10px 14px;border-top:1px solid var(--border);text-align:right;">' +
                '<button id="bgmPlCancel" class="tbtn">取消</button></div>';
        mask.appendChild(card);
        document.body.appendChild(mask);
        var body = card.querySelector('#bgmPlBody');
        if (!mine.length) {
            body.innerHTML = '<div style="padding:10px;font-size:12px;color:var(--muted);">没有找到你创建的歌单</div>';
        } else {
            mine.forEach(function (p) {
                var el = document.createElement('div');
                el.className = 'bgm-item';
                el.innerHTML = '<div class="bgm-item-main"><div class="bgm-item-name">' + esc(p.name) + '</div>' +
                    '<div class="bgm-item-sub">' + p.count + ' 首</div></div><span class="bgm-item-act">加入</span>';
                var go = function () {
                    post('/playlist/add', { pid: p.id, ids: ids.join(',') }, 30000).then(function (r) {
                        flash(r.code === 0 ? ('已加入「' + p.name + '」') : (r.msg || '加入失败'));
                        mask.remove();
                    }).catch(function (e) { flash(e.message); });
                };
                el.querySelector('.bgm-item-act').addEventListener('click', go);
                body.appendChild(el);
            });
        }
        card.querySelector('#bgmPlCancel').addEventListener('click', function () { mask.remove(); });
        mask.addEventListener('click', function (ev) { if (ev.target === mask) mask.remove(); });
    }

    // ---------- 切 tab 时刷新 ----------
    function onShow() {
        ensureServer().catch(function () {});
        refreshLocal();
    }

    function bind() {
        var q = $('bgmQuery');
        if (!q) return;
        q.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
        $('btnBgmSearch').addEventListener('click', doSearch);
        $('btnBgmBack').addEventListener('click', function () {
            $('bgmSeriesWrap').style.display = 'none';
            $('bgmSearchWrap').style.display = '';
            $('bgmResultWrap').style.display = '';
        });
        $('btnBgmPickFile').addEventListener('click', startSingleByFile);
        $('btnBgmPickDir').addEventListener('click', startBatchByDir);
        $('btnBgmBatch').addEventListener('click', startBatchByDir);
        var ob = $('btnBgmOnlineBatch');
        if (ob) ob.addEventListener('click', startOnlineBatch);
        $('btnBgmCancel').addEventListener('click', stopJob);
        $('btnBgmToLib').addEventListener('click', toPlaylist);
        var pc = $('btnBgmPreviewClose');
        if (pc) pc.addEventListener('click', closePreview);
        var pe = $('btnBgmPreviewExternal');
        if (pe) pe.addEventListener('click', openExternalPreview);
        // 下载目录 / 播放器
        var od = $('btnBgmOpenDir');
        if (od) od.addEventListener('click', openDownloadDir);
        var pv = $('btnBgmPlayerPrev');
        if (pv) pv.addEventListener('click', function () { playNav(-1); });
        var nx = $('btnBgmPlayerNext');
        if (nx) nx.addEventListener('click', function () { playNav(1); });
        var cl = $('btnBgmPlayerClose');
        if (cl) cl.addEventListener('click', closePlayer);
        var vv = $('bgmV');
        if (vv) vv.addEventListener('ended', function () {
            var auto = $('bgmAutoNext');
            if (auto && auto.checked) playNav(1);
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();

    window.__bgmOnShow = onShow;
})();
