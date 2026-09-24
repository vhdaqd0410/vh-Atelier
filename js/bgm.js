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

    var srvLog = '';
    function spawnServer() {
        try {
            if (!fs.existsSync(bgmIndex)) { setSrvState('\u670d\u52a1\u6587\u4ef6\u7f3a\u5931', 'err'); return false; }
            var node = findNode();
            if (!node) { setSrvState('\u672a\u627e\u5230 Node.js', 'err'); return false; }
            if (bgmChild) return true;
            setSrvState('\u6b63\u5728\u542f\u52a8\u670d\u52a1\u2026', '');
            bgmChild = childProcess.spawn(node, [bgmIndex], { cwd: bgmDir, windowsHide: true });
            try {
                if (bgmChild.stdout) bgmChild.stdout.on('data', function (b) { srvLog = (srvLog + String(b)).slice(-800); });
                if (bgmChild.stderr) bgmChild.stderr.on('data', function (b) { srvLog = (srvLog + String(b)).slice(-800); });
            } catch (e) {}
            bgmChild.on('error', function (e) {
                srvLog = (srvLog + ' spawn error: ' + (e && e.message)).slice(-800);
                bgmChild = null; setSrvState('\u542f\u52a8\u5931\u8d25', 'err');
            });
            bgmChild.on('close', function (code) {
                if (code !== 0 && code !== null) srvLog = (srvLog + ' exit ' + code).slice(-800);
                bgmChild = null;
            });
            return true;
        } catch (e) { srvLog = String(e && e.message); setSrvState('\u542f\u52a8\u5f02\u5e38', 'err'); return false; }
    }

    function setSrvState(txt, cls) {
        var el = $('bgmSrvState');
        if (!el) return;
        el.textContent = txt;
        el.className = 'music-server' + (cls ? ' ' + cls : '');
    }

    var lastSrvErr = '';
    function ensureServer(retries) {
        var tries = retries || 0;
        return api('/health', { timeout: 8000 }).then(function (h) {
            setSrvState('\u670d\u52a1\u6b63\u5e38', 'ok');
            var hint = $('bgmLoginHint');
            if (hint) {
                if (!h.logged) hint.textContent = '\u26a0 \u672a\u767b\u5f55\u7f51\u6613\u4e91\uff0c\u8bf7\u5148\u5728\u300c\u7f51\u6613\u4e91\u300d\u677f\u5757\u767b\u5f55';
                else if (!h.sherpa || !h.model) hint.textContent = '\u26a0 \u7f3a\u5c11\u4eba\u58f0\u5206\u79bb\u7ec4\u4ef6';
                else hint.textContent = '';
            }
            return h;
        }).catch(function (e) {
            lastSrvErr = (e && e.message) || '\u672a\u77e5';
            if (tries < 6) {
                if (tries === 0) spawnServer();
                setSrvState('\u670d\u52a1\u542f\u52a8\u4e2d\u2026(' + (tries + 1) + '/6)', '');
                return new Promise(function (res) {
                    setTimeout(function () { res(ensureServer(tries + 1)); }, 1500);
                });
            }
            setSrvState('\u670d\u52a1\u672a\u8fde\u63a5', 'err');
            throw new Error(srvErrMsg('\u540e\u7aef\u670d\u52a1\u542f\u52a8\u5931\u8d25', lastSrvErr));
        });
    }

    // 组合可读的错误原因（区分没装 node / 端口占用 / 文件缺失 / 启动超时）
    function srvErrMsg(prefix, detail) {
        var tips = [];
        var node = findNode();
        tips.push(node ? ('Node: ' + node) : '\u672a\u627e\u5230 Node.js');
        if (!fs.existsSync(bgmIndex)) tips.push('\u670d\u52a1\u6587\u4ef6\u7f3a\u5931');
        if (srvLog) tips.push('\u65e5\u5fd7: ' + srvLog.replace(/\s+/g, ' ').slice(-200));
        return prefix + '\uff08' + tips.join('\uff1b') + '\uff09' + (detail ? ' / ' + detail : '');
    }


    // ---------- 首页热门瀑布流 ----------
    var hotKind = 'all';
    function loadHot(kind) {
        hotKind = kind || hotKind;
        var grid = $('bgmHotGrid');
        if (!grid) return;
        grid.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--muted);">\u6b63\u5728\u52a0\u8f7d\u70ed\u699c\u2026</div>';
        api('/hot?kind=' + encodeURIComponent(hotKind), { timeout: 40000 }).then(function (r) {
            if (r.code !== 0) { grid.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--ff-err-soft);">\u52a0\u8f7d\u5931\u8d25</div>'; return; }
            renderHot(r.data || []);
        }).catch(function (e) {
            grid.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--muted);">\u52a0\u8f7d\u5931\u8d25\uff1a' + esc(e.message) + '</div>';
        });
    }

    function renderHot(list) {
        var grid = $('bgmHotGrid');
        if (!grid) return;
        grid.innerHTML = '';
        if (!list.length) { grid.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--muted);">\u6682\u65e0\u6570\u636e</div>'; return; }
        list.forEach(function (it) {
            var el = document.createElement('div');
            el.className = 'bgm-grid-card';
            el.title = it.name;
            el.innerHTML =
                '<img class="bgm-grid-cover" src="' + esc(it.cover || '') + '" loading="lazy" ' +
                    'onerror="this.style.background=\'#222\';this.removeAttribute(\'src\')">' +
                '<div class="bgm-grid-name">' + esc(it.name || '') + '</div>' +
                '<div class="bgm-grid-sub">' + esc(it.hot || it.fav || it.like || '') +
                    (it.score ? ('  \u8bc4' + esc(it.score)) : '') + '</div>';
            el.addEventListener('click', function () { openSeries(it); });
            grid.appendChild(el);
        });
    }

    function bindHotTabs() {
        document.querySelectorAll('.bgm-hot-tab').forEach(function (b) {
            b.addEventListener('click', function () {
                document.querySelectorAll('.bgm-hot-tab').forEach(function (x) { x.classList.remove('active'); });
                b.classList.add('active');
                loadHot(b.getAttribute('data-kind'));
            });
        });
        var rf = $('bgmHotRefresh');
        if (rf) rf.addEventListener('click', function () { loadHot(hotKind); });
    }

    // ---------- 搜索历史 ----------
    var HIST_KEY = 'vh_bgm_search_hist';
    function loadHist() {
        try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; }
    }
    function addHist(kw) {
        kw = String(kw || '').trim();
        if (!kw) return;
        var h = loadHist().filter(function (x) { return x !== kw; });
        h.unshift(kw);
        if (h.length > 20) h = h.slice(0, 20);
        try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) {}
        renderHist();
    }
    function renderHist() {
        var wrap = $('bgmHistoryWrap'), box = $('bgmHistory');
        if (!wrap || !box) return;
        var h = loadHist();
        if (!h.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        box.innerHTML = '';
        h.forEach(function (kw) {
            var el = document.createElement('span');
            el.className = 'bgm-chip';
            el.style.cssText = 'cursor:pointer;padding:2px 8px;';
            el.textContent = kw;
            el.addEventListener('click', function () {
                var q = $('bgmQuery'); if (q) q.value = kw;
                doSearch();
            });
            box.appendChild(el);
        });
    }

    // ---------- 输入自动补全 ----------
    var suggestTimer = null;
    function onQueryInput() {
        var q = $('bgmQuery');
        var box = $('bgmSuggest');
        if (!q || !box) return;
        var kw = q.value.trim();
        if (suggestTimer) clearTimeout(suggestTimer);
        if (!kw) { box.style.display = 'none'; return; }
        suggestTimer = setTimeout(function () {
            api('/suggest?keyword=' + encodeURIComponent(kw), { timeout: 30000 }).then(function (r) {
                var list = (r.data || []).filter(function (x) { return x.name; });
                if (!list.length) { box.style.display = 'none'; return; }
                box.innerHTML = '';
                list.forEach(function (it) {
                    var el = document.createElement('div');
                    el.style.cssText = 'padding:6px 10px;font-size:12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);';
                    el.textContent = it.name;
                    el.addEventListener('mouseenter', function () { el.style.background = 'rgba(255,255,255,.06)'; });
                    el.addEventListener('mouseleave', function () { el.style.background = ''; });
                    el.addEventListener('click', function () {
                        box.style.display = 'none';
                        openSeries(it);
                    });
                    box.appendChild(el);
                });
                box.style.display = '';
            }).catch(function () { box.style.display = 'none'; });
        }, 400);
    }

    // ---------- 分享链接解析 ----------
    function parseShare() {
        var el = $('bgmShare');
        var t = el ? el.value.trim() : '';
        if (!t) { flash('\u8bf7\u7c98\u8d34\u5206\u4eab\u94fe\u63a5\u6216\u5267 ID'); return; }
        flash('\u89e3\u6790\u4e2d\u2026');
        api('/share-parse?text=' + encodeURIComponent(t), { timeout: 40000 }).then(function (r) {
            if (r.code !== 0) { flash(r.msg || '\u89e3\u6790\u5931\u8d25'); return; }
            var info = r.data || {};
            if (!info.count) { flash('\u89e3\u6790\u5230\u5267 ID ' + info.series_id + '\uff0c\u4f46\u672a\u53d6\u5230\u5267\u96c6\u4fe1\u606f'); }
            curSeries = info;
            openSeries(info);   // 直接进剧集页
        }).catch(function (e) { flash(e.message); });
    }

    // ---------- 搜索 ----------
    function doSearch() {
        var box = $('bgmSuggest'); if (box) box.style.display = 'none';
        var kw = ($('bgmQuery') || {}).value || '';
        kw = kw.trim();
        if (!kw) { flash('请输入短剧名'); return; }
        setSrvState('搜索中…', '');
        ensureServer().then(function () {
            return api('/search?keyword=' + encodeURIComponent(kw), { timeout: 40000 });
        }).then(function (r) {
            setSrvState('服务正常', 'ok');
            if (r.code !== 0) { flash(r.msg || '搜索失败'); return; }
            addHist(kw);
            var hw = $('bgmHistoryWrap'); if (hw) hw.style.display = 'none';
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
    // 换剧清理：清掉结果列表、色块、叠加条、当前播放集（缓存本身保留，按剧号隔离）
    function resetForSeries() {
        try { closePlayer(); } catch (e) {}
        try { clearMarks(); } catch (e) {}
        try {
            var rw = $('bgmResultWrap'); if (rw) rw.style.display = 'none';
            var rl = $('bgmResultList'); if (rl) rl.innerHTML = '';
            var rt = $('bgmResultTitle'); if (rt) rt.textContent = '\u8bc6\u522b\u7ed3\u679c';
            var ns = $('bgmNowSong'); if (ns) ns.style.display = 'none';
            var meta = $('bgmEpMeta'); if (meta) meta.textContent = '';
        } catch (e) {}
        lastResult = null; selected = {}; lastPickEp = 0; lastHlId = null; lastOverlayId = null;
    }

    function openSeries(it) {
        resetForSeries();
        ensureServer().then(function () {
            return api('/series?series_id=' + encodeURIComponent(it.series_id), { timeout: 40000 });
        }).then(function (r) {
            if (r.code !== 0) { flash(r.msg || '获取剧集失败'); return; }
            curSeries = r.data;
            renderSeries();
        }).catch(function (e) { flash(e.message); });
    }

    // 对外入口：先拉本地已下载列表，再渲染（修复“进页时已下载信息不显示”）
    function renderSeries() {
        if (!curSeries) return;
        // 先给个即时反馈
        $('bgmSearchWrap').style.display = 'none';
        $('bgmSeriesWrap').style.display = '';
        $('bgmSeriesName').textContent = curSeries.name || curSeries.series_id;
        $('bgmSeriesCount').textContent = '\u5171 ' + curSeries.count + ' \u96c6';
        bindEpToolbar();
        var meta = $('bgmEpMeta');
        if (meta) meta.textContent = '\u6b63\u5728\u8bfb\u53d6\u672c\u5730\u5df2\u4e0b\u8f7d\u5217\u8868\u2026';
        // 关键：等本地列表回来后再渲染剧集行
        refreshLocal().then(function () {
            try { renderSeriesNow(); } catch (e) { flash('\u6e32\u67d3\u5931\u8d25: ' + (e && e.message || e)); }
        }).catch(function () {
            try { renderSeriesNow(); } catch (e) {}
        });
    }

    function renderSeriesNow() {
        var d = curSeries;
        if (!d) return;
        $('bgmSearchWrap').style.display = 'none';
        $('bgmSeriesWrap').style.display = '';
        $('bgmSeriesName').textContent = d.name || d.series_id;
        $('bgmSeriesCount').textContent = '共 ' + d.count + ' 集';


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
        // 工具条：多选 + 下载全集
        var tools = document.createElement('div');
        tools.className = 'bgm-item';
        tools.style.cssText = 'background:var(--panel);gap:6px;flex-wrap:wrap;';
        tools.innerHTML =
            '<span class="bgm-item-act" id="bgmSelAll">全选</span>' +
            '<span class="bgm-item-act" id="bgmSelInv">反选</span>' +
            '<span class="bgm-item-act" id="bgmSelClear">清空</span>' +
            '<span class="bgm-item-act bgm-sel-dl">下载选中</span>' +
            '<span class="bgm-item-act bgm-sel-pr">导入PR</span>' +
            '<span id="bgmSelInfo" style="font-size:11px;color:var(--muted);"></span>';
        box.appendChild(tools);
        // 只渲染前 60 集，避免一次塞太多 DOM
        (d.vid_list || []).slice(0, 60).forEach(function (v, i) {
            var ep = i + 1;
            var local = localMap[ep];
            var el = document.createElement('div');
            el.className = 'bgm-item';
            el.dataset.ep = String(ep);
            el.innerHTML =
                '<input type="checkbox" class="bgm-ep-cb" data-ep="' + ep + '" style="flex:0 0 auto;">' +
                '<span class="bgm-item-idx">' + ep + '</span>' +
                '<div class="bgm-item-main"><div class="bgm-item-name">第 ' + ep + ' 集</div>' +
                '<div class="bgm-item-sub">' + (local ? '✔ 已下载 ' + local.sizeMB + 'MB' : '未下载') + '</div></div>' +
                (local ? '<span class="bgm-item-act on bgm-playnow">播放</span>' : '') +
                (local ? '<span class="bgm-item-act bgm-imp" title="导入 PR 项目面板素材库">导入PR</span>' : '') +
                (local ? '<span class="bgm-item-act bgm-ins" title="插入到当前时间线播放头位置">插入时间线</span>' : '') +
                '<span class="bgm-item-act bgm-watch">' + (local ? '重下' : '下载') + '</span>' +
                '<span class="bgm-item-act bgm-pick">' + (getCached(ep) ? '看结果' : '扒这集') + '</span>' +
                (getCached(ep) ? '<span class="bgm-item-act bgm-repick">重扒</span>' : '');
            var pn = el.querySelector('.bgm-playnow');
            if (pn) pn.addEventListener('click', function (ev) { ev.stopPropagation(); playEpisode(ep, v); });
            var imp = el.querySelector('.bgm-imp');
            if (imp) imp.addEventListener('click', function (ev) {
                ev.stopPropagation();
                importFilesToPR([local.path], curSeries ? curSeries.name : '短剧');
            });
            var ins = el.querySelector('.bgm-ins');
            if (ins) ins.addEventListener('click', function (ev) {
                ev.stopPropagation();
                insertToTimeline(local.path);
            });
            el.querySelector('.bgm-watch').addEventListener('click', function (ev) {
                ev.stopPropagation(); downloadEpisode(v, ep);
            });
            el.querySelector('.bgm-pick').addEventListener('click', function (ev) {
                ev.stopPropagation(); pickEpisode(v, ep);
            });
            var rp = el.querySelector('.bgm-repick');
            if (rp) rp.addEventListener('click', function (ev) {
                ev.stopPropagation(); rePickEpisode(v, ep);
            });
            // 双击 = 下载（未下）/ 播放（已下）
            el.addEventListener('dblclick', function () {
                // 已下载 → 直接播；未下载 → 下载完自动播（autoPlay=ep）
                if (local) playEpisode(ep, v); else downloadEpisode(v, ep, true);
            });
            // 已下载的集：整行可拖进 PR（拖时排除按钮区）
            if (local) {
                el.draggable = true;
                el.addEventListener('dragstart', function (ev) {
                    var t = ev.target;
                    if (t.closest && t.closest('.bgm-item-act')) { ev.preventDefault(); return; }
                    try {
                        ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', local.path);
                        ev.dataTransfer.setData('text/plain', local.path);
                        ev.dataTransfer.effectAllowed = 'copy';
                    } catch (e) {}
                });
            }
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
            hint.innerHTML = '双击 = 下载/播放；勾选多集可「下载选中」；已下载的可「拖进PR」';
        }
    }

    // 单集：自动下载后扒（不再要求先有本地文件）
    function pickEpisode(vid, epNo) {
        if (!curSeries) return;
        // 已扒过 → 直接展示缓存结果，不重跑
        if (getCached(epNo)) {
            flash('\u5df2\u6709\u7f13\u5b58\u7ed3\u679c\uff0c\u76f4\u63a5\u5c55\u793a\uff08\u60f3\u91cd\u626c\u70b9\u300c\u91cd\u626c\u300d\uff09');
            renderEpisodeSongList(epNo);
            highlightSong(null, false);
            return;
        }
        lastPickEp = epNo;
        startBgm('/episode', {
            series_id: curSeries.series_id, vid: vid, name: curSeries.name, ep: epNo,
            start: null, end: null,
        }, '\u7b2c ' + epNo + ' \u96c6\uff08\u81ea\u52a8\u4e0b\u8f7d\u540e\u626c\uff09');
    }

    // 强制重扒
    function rePickEpisode(vid, epNo) {
        if (!curSeries) return;
        delete resultCache[epNo]; saveResults();
        lastPickEp = epNo;
        startBgm('/episode', {
            series_id: curSeries.series_id, vid: vid, name: curSeries.name, ep: epNo,
            start: null, end: null,
        }, '\u91cd\u626c\u7b2c ' + epNo + ' \u96c6');
    }

    // 仅下载这一集到本地
    function downloadEpisode(vid, epNo, autoPlay) {
        if (!curSeries) return;
        pendingAutoPlay = autoPlay ? epNo : 0;
        startBgm('/download', {
            series_id: curSeries.series_id, vid: vid, name: curSeries.name, ep: epNo,
        }, '下载第 ' + epNo + ' 集');
    }

    // ---------- 进度条上标出 BGM 命中点 ----------
    // 结构：bgmMarks[ep] = [{ name, artist, at, to, count }]
    var bgmMarks = {};
    try { bgmMarks = JSON.parse(localStorage.getItem('vh_bgm_marks') || '{}'); } catch (e) { bgmMarks = {}; }
    function saveMarks() { try { localStorage.setItem('vh_bgm_marks', JSON.stringify(bgmMarks)); } catch (e) {} }

    // 扒歌结果缓存：ep -> { songs, duration, windows, at }
    var resultCache = {};
    try {
        resultCache = JSON.parse(localStorage.getItem('vh_bgm_results') || '{}');
        // 迁移：旧格式 key 是纯数字集号（会跨剧串），上线隔离后清掉一次
        if (localStorage.getItem('vh_bgm_keyver') !== '2') {
            resultCache = {};
            bgmMarks = {};
            localStorage.setItem('vh_bgm_keyver', '2');
        }
    } catch (e) { resultCache = {}; }
    function saveResults() { try { localStorage.setItem('vh_bgm_results', JSON.stringify(resultCache)); } catch (e) {} }
    // 缓存键 = 剧号 + 集号（换剧后互不干扰，杜绝"上一部剧信息残留"）
    function ckey(ep) { return (curSeries && curSeries.series_id ? curSeries.series_id : '_') + ':' + ep; }
    function cacheResult(ep, res) {
        if (!ep || !res) return;
        resultCache[ckey(ep)] = { songs: res.songs || [], duration: res.duration, windows: res.windows, at: Date.now() };
        saveResults();
    }
    function getCached(ep) { return resultCache[ckey(ep)] || null; }

    // 每首歌一个稳定颜色（按 id 哈希，色相区分明显）
    function songColor(id) {
        var n = 0, s = String(id);
        for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 360000;
        var hue = n % 360;
        return 'hsl(' + hue + ', 78%, 58%)';
    }

    function rememberMarks(ep, songs) {
        if (!ep || !songs || !songs.length) return;
        bgmMarks[ckey(ep)] = songs.map(function (s) {
            return { id: s.id, name: s.name, artist: s.artist, at: s.at, to: s.to, count: s.count };
        });
        saveMarks();
    }


    function clearMarks() {
        var box = $('bgmMarkerBar');
        if (box) { box.innerHTML = ''; box.style.display = 'none'; }
        var tip = $('bgmMarkerTip');
        if (tip) tip.textContent = '';
    }

    function drawMarkers(ep) {
        var box = $('bgmMarkerBar');
        var tip = $('bgmMarkerTip');
        var v = $('bgmV');
        if (!box || !v) return;
        var marks = bgmMarks[ep] || [];
        var sig = ep + '|' + (v.duration || 0) + '|' + marks.length;
        if (box.getAttribute('data-sig') === sig) return;   // 同签名不重建，避免闪烁
        box.setAttribute('data-sig', sig);
        if (!marks.length) {
            clearMarks();
            if (tip) tip.textContent = '\u8fd9\u96c6\u8fd8\u6ca1\u626c\u8fc7\uff0c\u70b9\u300c\u626c\u8fd9\u96c6\u300d\u540e\u5c31\u80fd\u5728\u8fdb\u5ea6\u6761\u4e0a\u770b\u5230 BGM \u4f4d\u7f6e';
            return;
        }
        var dur = v.duration || 0;
        if (!dur) { setTimeout(function () { drawMarkers(ep); }, 600); return; }
        box.innerHTML = '';
        box.style.display = '';
        marks.forEach(function (m) {
            var c = songColor(m.id);
            var left = Math.min(100, Math.max(0, (m.at / dur) * 100));
            var width = Math.max(0.7, ((m.to - m.at) / dur) * 100);
            var el = document.createElement('div');
            el.className = 'bgm-mark';
            el.setAttribute('data-id', String(m.id));
            el.title = m.name + ' \u2014 ' + m.artist + '  (' + m.at + '~' + m.to + 's)';
            el.style.cssText = 'position:absolute;left:' + left + '%;width:' + width + '%;' +
                'height:100%;background:' + c + ';opacity:.85;border-radius:2px;cursor:pointer;';
            el.addEventListener('click', function () {
                try { v.currentTime = m.at; v.play().catch(function () {}); } catch (e) {}
                // 点击色块 → 列表里对应歌曲高亮并滚到可见
                highlightSong(m.id, true);
            });
            box.appendChild(el);
        });
        if (tip) tip.textContent = '\u8fd9\u96c6\u547d\u4e2d ' + marks.length + ' \u9996 BGM\uff08\u8272\u5757\u70b9\u51fb\u8df3\u8f6c + \u9ad8\u4eae\u5217\u8868\uff09';
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

    function pickMusicDir() {
        post('/pick-dir', {}, 120000).then(function (r) {
            var p = (r.data || {}).path;
            if (!p) return;
            post('/music-dir', { dir: p }, 30000).then(function (r2) {
                if (r2 && r2.code === 0) {
                    flash('\u97f3\u4e50\u4e0b\u8f7d\u76ee\u5f55\u5df2\u8bbe\u4e3a\uff1a' + r2.data.dir);
                    var lbl = $('bgmMusicDirLabel');
                    if (lbl) lbl.textContent = r2.data.dir;
                } else flash((r2 && r2.msg) || '\u8bbe\u7f6e\u5931\u8d25');
            });
        }).catch(function (e) { flash(e.message); });
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
    var lastPickEp = 0;   // \u6700\u8fd1\u626c\u8fc7\u7684\u96c6
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
        if (!loc) { flash('\u7b2c ' + ep + ' \u96c6\u672c\u5730\u6587\u4ef6\u4e0d\u5b58\u5728'); return; }
        var wrap = $('bgmPlayerWrap');
        if (wrap) wrap.style.display = '';
        if (miniMode) applyMini(true);
        playEp = ep;
        $('bgmPlayerTitle').textContent = (curSeries && curSeries.name ? curSeries.name + ' ' : '') + '\u7b2c ' + ep + ' \u96c6';
        var v = $('bgmV');
        if (!v) return;
        // 从歌曲模式切回视频：停掉试听
        songMode = false;
        if (inlineAudio) { try { inlineAudio.pause(); } catch (e) {} }
        v.src = API + '/video?file=' + encodeURIComponent(loc.path);
        v.dataset.ep = String(ep);
        try { v.load(); v.play().catch(function () {}); } catch (e) {}
        drawMarkers(ep);
        renderEpisodeSongList(ep);      // 该集已有识别结果 → 直接显示列表
        syncBar();
        focusPlayer();                  // 自动聚焦到画面中心
        var info = $('bgmPlayerInfo');
        if (info) info.textContent = loc.name + '  ' + loc.sizeMB + 'MB';
        try { localStorage.setItem('vh_bgm_last_ep', String(ep)); } catch (e) {}
    }


    // HEVC 黑屏兜底：检测到"有进度但无画面"则提示转码
    function wireHevcFallback() {
        var v = $('bgmV');
        if (!v) return;
        v.addEventListener('playing', function () {
            // 播 2.5 秒后检查是否真的在当前时间推进（黑屏时 readyState 高但画面不动）
            var t0 = v.currentTime, ep = v.dataset.ep;
            setTimeout(function () {
                if (v.paused || !ep) return;
                if (v.currentTime - t0 < 0.3) {
                    flash('该集在本地播放异常，正在转码为兼容格式…');
                    post('/transcode', { file: localMap[ep] ? localMap[ep].path : '' }, 60000).then(function (r) {
                        if (r && r.code === 0) { curJobId = r.data.jobId; showProgress('转码'); poll(); }
                    }).catch(function () {});
                }
            }, 2500);
        });
        // 彻底报错也有提示
        v.addEventListener('error', function () {
            flash('本地播放失败（编码不支持），可点「转码」重试');
        });
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
    function closePlayer() {
        var wrap = $('bgmPlayerWrap');
        if (wrap) wrap.style.display = 'none';
        var v = $('bgmV');
        if (v) { try { v.pause(); } catch (e) {} v.removeAttribute('src'); try { v.load(); } catch (e) {} }
        playEp = 0;
    }

    // ---------- 小窗（画中画式）模式 ----------
    var miniMode = false;
    function applyMini(on) {
        miniMode = !!on;
        var wrap = $('bgmPlayerWrap');
        var btn = $('btnBgmMini');
        if (wrap) wrap.classList.toggle('bgm-mini', miniMode);
        if (btn) btn.textContent = miniMode ? '\u5c55\u5f00' : '\u5c0f\u7a97';
        try { localStorage.setItem('vh_bgm_mini', miniMode ? '1' : '0'); } catch (e) {}
    }
    function toggleMini() { applyMini(!miniMode); }

    // ⑦ 播放时把播放窗口滚到视野中心（小窗模式则滚到右下角区域）
    function focusPlayer() {
        var wrap = $('bgmPlayerWrap');
        if (!wrap) return;
        try {
            if (miniMode) return;   // 小窗本就固定定位，不需要滚
            // 优先滚到视频元素，留出上下舒适边距
            var v = $('bgmV');
            var target = v || wrap;
            var rect = target.getBoundingClientRect();
            var vh = window.innerHeight || document.documentElement.clientHeight;
            var top = rect.top + window.pageYOffset - Math.max(0, (vh - rect.height) / 2);
            window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        } catch (e) {
            try { if (wrap.scrollIntoView) wrap.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e2) {}
        }
    }

    // ---------- 实时叠加：当前进度落在哪首 BGM 上 ----------
    var lastOverlayId = null;
    function tickOverlay() {
        var v = $('bgmV');
        if (!v || !playEp) return;
        var marks = bgmMarks[ckey(playEp)] || [];
        if (!marks.length) return;              // 没标记直接跳过，不做任何 DOM 操作
        var t = v.currentTime || 0;
        var cur = null;
        for (var i = 0; i < marks.length; i++) {
            var m = marks[i];
            if (t >= m.at && t <= m.to) { cur = m; break; }
        }
        var box = $('bgmNowSong');
        if (!box) return;
        var newId = cur ? String(cur.id) : null;
        if (newId === lastOverlayId) return;    // 关键：没变就不碰 DOM，避免每帧重绘闪烁
        lastOverlayId = newId;
        if (cur) {
            box.style.display = '';
            box.style.borderColor = songColor(cur.id);
            box.textContent = '';               // 用 textContent 组装，避免 innerHTML 触发重排
            var b = document.createElement('b');
            b.textContent = '\u266b ' + cur.name;
            box.appendChild(b);
            box.appendChild(document.createTextNode(' \u2014 ' + (cur.artist || '') +
                '  (' + cur.at + '~' + cur.to + 's)'));
            highlightSong(cur.id, false);       // 高亮但不滚动（滚动会引发布局抖动）
        } else {
            box.style.display = 'none';
        }
    }


    // 点叠加条 → 跳到识别列表并高亮
    function jumpToSongList() {
        var id = lastOverlayId;
        highlightSong(id, true);
    }

    // ---------- 识别结果列表高亮 ----------
    var lastHlId = null;
    function highlightSong(id, scroll) {
        var key = (id == null) ? null : String(id);
        if (key === lastHlId) return;          // 没变化直接返回，避免无谓重绘
        // 只摘掉上一个高亮
        var prev = document.querySelector('#bgmResultList .bgm-item.bgm-hl');
        if (prev) prev.classList.remove('bgm-hl');
        lastHlId = key;
        if (key == null) return;
        var rows = document.querySelectorAll('#bgmResultList .bgm-item');
        for (var k = 0; k < rows.length; k++) {
            var rid = rows[k].getAttribute('data-song-id');
            if (rid && String(rid) === key) {
                rows[k].classList.add('bgm-hl');
                // 只有用户主动点击时才滚动（scroll=true）；实时播放不滚，防止抖动
                if (scroll) {
                    try { rows[k].scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
                }
                break;
            }
        }
    }


    // ---------- 该集已有缓存结果 → 直接展示（不重扒） ----------
    function renderEpisodeSongList(ep) {
        var c = getCached(ep);
        if (!c || !c.songs || !c.songs.length) return false;
        renderResult({ songs: c.songs, duration: c.duration, windows: c.windows, cached: true });
        return true;
    }

    // ---------- 底部播放条 ----------
    function syncBar() {
        var v = $('bgmV');
        var bar = $('bgmBar');
        if (!v || !bar) return;
        bar.style.display = '';
        var tt = $('bgmBarTitle');
        if (tt) tt.textContent = (playEp ? ('\u7b2c ' + playEp + ' \u96c6') : '\u672a\u5728\u64ad\u653e');
        var pb = $('btnBgmBarPlay');
        if (pb) pb.textContent = v.paused ? '\u25b6' : '\u23f8';
        var cur = $('bgmBarCur'), dur = $('bgmBarDur');
        if (cur) cur.textContent = fmtTime(v.currentTime || 0);
        if (dur) dur.textContent = fmtTime(v.duration || 0);
        updateBarFill();
    }
    function fmtTime(s) {
        s = Math.max(0, Math.floor(s || 0));
        var m = Math.floor(s / 60), ss = s % 60;
        return m + ':' + (ss < 10 ? '0' : '') + ss;
    }
    // 当前活跃媒体元素（视频优先；歌曲模式用 audio）
    function curMedia() {
        if (songMode && inlineAudio) return inlineAudio;
        return $('bgmV');
    }
    function updateBarFill() {
        var m = curMedia();
        var f = $('bgmBarFill');
        if (!f || !m || !m.duration) { if (f) f.style.width = '0%'; return; }
        f.style.width = Math.min(100, (m.currentTime / m.duration) * 100) + '%';
    }

    // 歌曲模式的底部条
    function syncSongBar() {
        var bar = $('bgmBar');
        if (!bar) return;
        bar.style.display = '';
        var tt = $('bgmBarTitle');
        if (tt) tt.textContent = curSong ? ('\u266b ' + curSong.name + ' \u2014 ' + (curSong.artist || '')) : '\u672a\u5728\u64ad\u653e';
        var pb = $('btnBgmBarPlay');
        if (pb && inlineAudio) pb.textContent = inlineAudio.paused ? '\u25b6' : '\u23f8';
        var cur = $('bgmBarCur'), dur = $('bgmBarDur');
        if (cur && inlineAudio) cur.textContent = fmtTime(inlineAudio.currentTime || 0);
        if (dur && inlineAudio) dur.textContent = fmtTime(inlineAudio.duration || 0);
        updateBarFill();
    }

    function bindSongBar() {
        if (!inlineAudio) return;
        if (inlineAudio.__bound) return;
        inlineAudio.__bound = true;
        inlineAudio.addEventListener('timeupdate', function () {
            if (!songMode) return;
            var cur = $('bgmBarCur');
            if (cur) cur.textContent = fmtTime(inlineAudio.currentTime || 0);
            updateBarFill();
        });
        inlineAudio.addEventListener('loadedmetadata', function () {
            if (!songMode) return;
            var dur = $('bgmBarDur');
            if (dur) dur.textContent = fmtTime(inlineAudio.duration || 0);
        });
        inlineAudio.addEventListener('play', function () { if (songMode) syncSongBar(); });
        inlineAudio.addEventListener('pause', function () { if (songMode) syncSongBar(); });
        inlineAudio.addEventListener('ended', function () { if (songMode) syncSongBar(); });
    }

    // ⑦ 双向定位：从音乐列表定位到视频对应位置
    function locateInVideo(s) {
        if (!playEp) { flash('\u5148\u64ad\u653e\u4e00\u96c6\uff0c\u624d\u80fd\u5b9a\u4f4d'); return; }
        var marks = bgmMarks[ckey(playEp)] || [];
        var m = null;
        for (var i = 0; i < marks.length; i++) if (String(marks[i].id) === String(s.id)) { m = marks[i]; break; }
        if (!m) { flash('\u5f53\u524d\u96c6\u6ca1\u6709\u8fd9\u9996\u7684\u547d\u4e2d\u8bb0\u5f55'); return; }
        var v = $('bgmV');
        if (!v) return;
        // 展开（若在小窗，保持小窗但滚到播放器）
        try { v.currentTime = m.at; v.play().catch(function () {}); } catch (e) {}
        highlightSong(s.id, true);
        flash('\u5df2\u5b9a\u4f4d\u5230 ' + m.at + 's');
    }

    // ⑨ 在网易云里搜索这首歌
    function searchOnNetease(s) {
        var kw = ((s.name || '') + ' ' + (s.artist || '')).trim();
        if (!kw) { flash('\u6ca1\u6709\u53ef\u641c\u7684\u5173\u952e\u8bcd'); return; }
        // 在插件内的「网易云」板块搜索（不跳浏览器）
        try {
            if (window.__atSwitchTab) window.__atSwitchTab('music');
        } catch (e) {}
        // 等面板切过去后，往它的搜索框填词并触发搜索
        var tries = 0;
        var timer = setInterval(function () {
            tries++;
            var q = document.getElementById('musicQuery');
            var btn = document.getElementById('btnMusicSearch');
            if (q && btn) {
                clearInterval(timer);
                q.value = kw;
                try { btn.click(); } catch (e) {}
                flash('\u5df2\u5728\u7f51\u6613\u4e91\u677f\u5757\u641c\u7d22\uff1a' + kw);
            } else if (tries > 20) {
                clearInterval(timer);
                flash('\u672a\u627e\u5230\u7f51\u6613\u4e91\u641c\u7d22\u6846');
            }
        }, 150);
    }


    function bindBar() {
        var v = $('bgmV');
        if (!v) return;
        v.addEventListener('timeupdate', function () {
            var cur = $('bgmBarCur');
            if (cur && !songMode) cur.textContent = fmtTime(v.currentTime || 0);
            if (!songMode) updateBarFill();
            tickOverlay();
        });
        v.addEventListener('loadedmetadata', function () {
            var dur = $('bgmBarDur');
            if (dur) dur.textContent = fmtTime(v.duration || 0);
            // 该集若已扒过，进度条色块按真实时长重画
            drawMarkers(playEp);
        });
        v.addEventListener('play', syncBar);
        v.addEventListener('pause', syncBar);
        ['seeked', 'volumechange'].forEach(function (ev) { v.addEventListener(ev, syncBar); });
    }

    function bindEpToolbar() {
        var box = $('bgmEpList');
        if (!box || box.dataset.bound) return;
        box.dataset.bound = '1';
        box.addEventListener('change', function (ev) {
            if (ev.target.classList && ev.target.classList.contains('bgm-ep-cb')) updateSelInfo();
        });
        box.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t.classList) return;
            var cbs = box.querySelectorAll('.bgm-ep-cb');
            if (t.id === 'bgmSelAll') { cbs.forEach(function (c) { c.checked = true; }); updateSelInfo(); }
            else if (t.id === 'bgmSelInv') { cbs.forEach(function (c) { c.checked = !c.checked; }); updateSelInfo(); }
            else if (t.id === 'bgmSelClear') { cbs.forEach(function (c) { c.checked = false; }); updateSelInfo(); }
            else if (t.classList.contains('bgm-sel-dl')) downloadSelected();
            else if (t.classList.contains('bgm-sel-pr')) importSelectedToPR();
        });
    }

    function selectedEps() {
        var out = [];
        document.querySelectorAll('#bgmEpList .bgm-ep-cb').forEach(function (cb) {
            if (cb.checked) out.push(parseInt(cb.getAttribute('data-ep'), 10));
        });
        return out;
    }

    function updateSelInfo() {
        var n = selectedEps().length;
        var el = $('bgmSelInfo');
        if (el) el.textContent = n ? ('已选 ' + n + ' 集') : '';
    }

    // 下载选中集（取最早的一段连续区间）
    function downloadSelected() {
        if (!curSeries) return;
        var eps = selectedEps();
        if (!eps.length) { flash('先勾选几集'); return; }
        eps.sort(function (a, b) { return a - b; });
        var start = eps[0], n = 1;
        for (var i = 1; i < eps.length; i++) {
            if (eps[i] === eps[i - 1] + 1) n++;
            else break;
        }
        if (n < eps.length) flash('本次先下第 ' + start + '~' + (start + n - 1) + ' 集（连续区间）');
        startBgm('/batch', {
            series_id: curSeries.series_id, name: curSeries.name, from: start, count: n,
        }, '下载第 ' + start + '~' + (start + n - 1) + ' 集');
    }

    // 已下载的选中集 → 导入 PR 素材库
    function importSelectedToPR() {
        var files = [];
        selectedEps().forEach(function (ep) { if (localMap[ep]) files.push(localMap[ep].path); });
        if (!files.length) { flash('选中的集里没有已下载的'); return; }
        importFilesToPR(files, (curSeries && curSeries.name) || '短剧');
    }


    // CEP 官方 DnD：拖到 PR 时间线/项目面板（与素材库/音效库同一机制）
    function enableCepDrag(el, filePath) {
        if (!el || !filePath) return;
        el.draggable = true;
        el.addEventListener('dragstart', function (ev) {
            try {
                ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', filePath);
                ev.dataTransfer.setData('text/plain', filePath);
                ev.dataTransfer.effectAllowed = 'copy';
            } catch (e) {}
        });
    }

    // 插入到当前时间线（播放头位置），复用 sfxInsertToTimelineStr
    function insertToTimeline(filePath) {
        try {
            // 取当前播放头位置（秒）
            csInterface.evalScript('(function(){try{var s=app.project.activeSequence;if(!s)return "0";return String(s.playerPosition||"0")}catch(e){return "0"}})()', function (posTicks) {
                var sec = 0;
                try { sec = Number(posTicks) / 254016000000; } catch (e) { sec = 0; }
                if (!isFinite(sec) || sec < 0) sec = 0;
                var payload = JSON.stringify({ path: filePath, positionSec: sec });
                csInterface.evalScript('sfxInsertPayload = ' + payload + ';', function () {
                    csInterface.evalScript('sfxInsertToTimelineStr()', function (r) {
                        var o = null;
                        try { o = JSON.parse(r); } catch (e) {}
                        if (o && o.ok) flash('已插入时间线（第 ' + (o.positionSec || 0).toFixed(1) + ' 秒）');
                        else flash('插入失败：' + ((o && o.error) || r));
                    });
                });
            });
        } catch (e) { flash('插入失败：' + e.message); }
    }

    function importFilesToPR(files, binName) {
        try {
            csInterface.evalScript('bgmImportPayload = ' + JSON.stringify(files) + ';', function () {
                csInterface.evalScript('bgmImportToBinStr(' + JSON.stringify(binName || '短剧') + ')', function (r) {
                    var o = null;
                    try { o = JSON.parse(r); } catch (e) {}
                    if (o && o.ok) flash('已导入 PR：' + o.count + ' 个文件');
                    else flash('导入 PR 失败：' + ((o && o.error) || r));
                });
            });
        } catch (e) { flash('导入失败：' + e.message); }
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
        // 注意：不要隐藏结果列表 —— 点「下载」时列表要留着（此前 bug 就是这里把列表藏了）
        setProg(0, label + '\uff1a\u51c6\u5907\u4e2d\u2026', '');
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

        // 歌曲下载：必须放在最前（它的 result 也带 file，会被剧集分支误吃）
        if (jobKind === 'songdl') {
            if (res.files) {
                var n = res.count || 0;
                flash('\u5df2\u4e0b\u8f7d ' + n + ' \u9996\u5230 ' + (res.dir || ''));
                var bad = (res.failed || []).length;
                if (bad) flash('\u6709 ' + bad + ' \u9996\u5931\u8d25\uff08\u53ef\u80fd\u9700\u4f1a\u5458\uff09');
                markSongsDownloaded(res.files || []);
            } else if (res.file) {
                flash('\u5df2\u4e0b\u8f7d\uff1a' + res.file.split('\\').pop());
                var info2 = $('bgmSongInfo');
                if (info2) info2.textContent = '\u5df2\u4fdd\u5b58\u5230\uff1a' + res.file;
                if (pendingSongRow) attachSongDrag(pendingSongRow, res.file);
                pendingSongRow = null;
            }
            return;
        }

        if (jobKind === 'transcode') {
            flash(d.msg || '\u8f6c\u7801\u5b8c\u6210');
            refreshLocal().then(function () { if (curSeries) renderSeries(); });
            return;
        }

        // 剧集下载（含 file 的结果）
        if (res.file) {
            var mb = ((res.size || 0) / 1048576).toFixed(1);
            flash('\u5df2\u4e0b\u8f7d ' + mb + 'MB \u2192 ' + res.file.split('\\').pop());
            var info = $('bgmPlayerInfo');
            if (info) info.textContent = '\u5df2\u4fdd\u5b58\u5230\uff1a' + res.file;
            refreshLocal().then(function () {
                if (curSeries) renderSeries();
                if (pendingAutoPlay) {
                    var ep = pendingAutoPlay;
                    pendingAutoPlay = 0;
                    if (localMap[ep]) playLocal(ep);
                }
            });
            return;
        }

        if (jobKind === 'batch') {
            refreshLocal().then(function () { if (curSeries) renderSeries(); });
        }
        renderResult(res);
        if (res && res.songs && (playEp || lastPickEp)) cacheResult(playEp || lastPickEp, res);
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
        // 该集结果入缓存（下次直接展示，不重扒）
        if (playEp && res.songs) cacheResult(playEp, res);
        // 若当前正在播放该集，把命中点记下来画到进度条
        if (playEp && res.songs && res.songs.length) rememberMarks(playEp, res.songs);
        drawMarkers(playEp);
        selected = {};
        lastHlId = null;
        var wrap = $('bgmResultWrap'), box = $('bgmResultList');
        var songs = res.songs || [];
        $('bgmResultTitle').textContent = (res.cached ? '\u8bc6\u522b\u7ed3\u679c\uff08\u5df2\u7f13\u5b58\uff09 \u00b7 ' : '\u8bc6\u522b\u7ed3\u679c \u00b7 ') + songs.length + ' \u9996' +
            (res.duration ? '\uff08\u97f3\u9891 ' + res.duration + 's\uff0c\u626b\u63cf ' + res.windows + ' \u7a97' : '') +
            (res.episodes ? '\uff0c' + res.episodes + ' \u96c6' : '') + '\uff09';

        box.innerHTML = '';

        // 说明条：解释「N×」与「选用」的含义
        var help = document.createElement('div');
        help.className = 'bgm-item';
        help.style.cssText = 'background:var(--panel);font-size:11px;line-height:1.75;color:var(--muted);display:block;white-space:normal;';
        help.innerHTML =
            '<b>\u600e\u4e48\u770b\u7ed3\u679c</b><br>' +
            '\u2022 <b>12\u00d7</b> = \u8fd9\u9996 BGM \u5728\u8fd9\u6bb5\u97f3\u9891\u91cc\u88ab\u8bc6\u522b\u5230 <b>12 \u6b21</b>\u3002' +
            '\u6b21\u6570\u8d8a\u591a\u8d8a\u53ef\u4fe1\uff0c\u53ea\u547d\u4e2d 1 \u6b21\u7684\u53ef\u80fd\u662f\u8bef\u8bc6\u522b\u3002<br>' +
            '\u2022 <b>@16.5~115.5s</b> = \u9996\u6b21\u51fa\u73b0 ~ \u672b\u6b21\u51fa\u73b0\u7684\u65f6\u95f4\u70b9\u3002<br>' +
            '\u2022 <b>\u9009\u7528</b> = \u52fe\u4e0a\u8fd9\u9996\uff0c\u6700\u540e\u7528\u300c\u52a0\u8fdb\u6b4c\u5355\u2026\u300d\u6279\u91cf\u5165\u5e93\u3002\u4e0d\u52fe\u5c31\u4e0d\u5165\u5e93\u3002<br>' +
            '\u2022 <b>\u53cc\u51fb</b>\u4efb\u610f\u4e00\u884c = \u8bd5\u542c\uff1b<b>\u4e0b\u8f7d</b>\u540e\u53ef\u62d6\u8fdb PR \u65f6\u95f4\u7ebf\u3002';
        box.appendChild(help);

        if (!songs.length) {
            var e0 = document.createElement('div');
            e0.className = 'bgm-item';
            e0.innerHTML = '<div class="bgm-item-main"><div class="bgm-item-name" style="color:var(--muted);">' +
                esc(emptyHint(res)) + '</div></div>';
            box.appendChild(e0);
        } else {
            songs.forEach(function (s, i) {
                var el = document.createElement('div');
                el.className = 'bgm-item';
                el.setAttribute('data-song-id', String(s.id));
                var epTag = s.eps ? '<span class="bgm-item-ep">' + s.eps + ' \u96c6</span>' : '';
                var timeTag = s.at != null ? '  @' + s.at + '~' + s.to + 's' : '';
                el.innerHTML =
                    '<span class="bgm-item-idx">' + (i + 1) + '</span>' +
                    '<div class="bgm-item-main">' +
                        '<div class="bgm-item-name"><span class="bgm-dot" style="background:' + songColor(s.id) + '"></span>' + esc(s.name) + ' \u2014 ' + esc(s.artist) + '</div>' +
                        '<div class="bgm-item-sub">' + (esc(s.album || '') || '\u672a\u77e5\u4e13\u8f91') +
                            '  \u00b7  \u547d\u4e2d ' + s.count + ' \u6b21' + timeTag + '</div>' +
                    '</div>' + epTag +
                    '<span class="bgm-item-tag" title="\u626b\u7a97\u547d\u4e2d\u6b21\u6570">' + s.count + '\u00d7</span>' +
                    '<span class="bgm-item-act bgm-m-play" title="\u8bd5\u542c\uff08\u53cc\u51fb\u884c\u4e5f\u884c\uff09">\u8bd5\u542c</span>' +
                    '<span class="bgm-item-act bgm-m-loc" title="\u5b9a\u4f4d\u5230\u89c6\u9891\u5bf9\u5e94\u4f4d\u7f6e">\u5b9a\u4f4d</span>' +
                    '<span class="bgm-item-act bgm-m-163" title="\u5728\u7f51\u6613\u4e91\u641c\u7d22\u8fd9\u9996\u6b4c">\u7f51\u6613\u4e91</span>' +
                    '<span class="bgm-item-act bgm-m-dl" title="\u4e0b\u8f7d\u5230\u672c\u5730">\u4e0b\u8f7d</span>' +
                    '<span class="bgm-item-act bgm-m-sel" data-id="' + s.id + '">\u9009\u7528</span>';
                el.querySelector('.bgm-m-play').addEventListener('click', function (ev) {
                    ev.stopPropagation(); playSongInline(s, el);
                });
                el.querySelector('.bgm-m-dl').addEventListener('click', function (ev) {
                    ev.stopPropagation(); downloadOneSong(s, el);
                });
                el.querySelector('.bgm-m-loc').addEventListener('click', function (ev) {
                    ev.stopPropagation(); locateInVideo(s);
                });
                el.querySelector('.bgm-m-163').addEventListener('click', function (ev) {
                    ev.stopPropagation(); searchOnNetease(s);
                });
                el.querySelector('.bgm-m-sel').addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    var btn = this, id = btn.getAttribute('data-id');
                    if (selected[id]) { delete selected[id]; btn.classList.remove('on'); btn.textContent = '\u9009\u7528'; }
                    else { selected[id] = s; btn.classList.add('on'); btn.textContent = '\u5df2\u9009'; }
                    updateSongSelUI();
                });
                el.addEventListener('dblclick', function () { playSongInline(s, el); });
                box.appendChild(el);
            });
        }
        wrap.style.display = '';
    }

    // 内嵌试听一首（不离开面板）
    var inlineAudio = null;
    var curSong = null;       // 当前试听的歌
    var songMode = false;     // 底部条是歌还是视频
    function playSongInline(s, row) {
        api('/song-url?id=' + encodeURIComponent(s.id), { timeout: 30000 }).then(function (r) {
            var url = (r.data || {}).url;
            if (!url) { flash(r.msg || '\u62ff\u4e0d\u5230\u8bd5\u542c\u5730\u5740\uff08\u53ef\u80fd\u9700\u4f1a\u5458\uff09'); return; }
            if (!inlineAudio) {
                inlineAudio = document.createElement('audio');
                inlineAudio.id = 'bgmSongAudio';
                document.body.appendChild(inlineAudio);
            }
            // 记录当前歌曲，供底部条使用
            curSong = s;
            inlineAudio.src = url;
            inlineAudio.play().catch(function () {});
            var old = document.querySelector('#bgmResultList .bgm-now');
            if (old) old.classList.remove('bgm-now');
            if (row) {
                row.classList.add('bgm-now');
                row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            songMode = true;
            bindSongBar();
            syncSongBar();
            flash('\u8bd5\u542c\u4e2d\uff1a' + s.name);
        }).catch(function (e) { flash(e.message); });
    }


    // 下载一首歌到本地（存档后可拖入时间线）
    var pendingSongRow = null;
    function downloadOneSong(s, row) {
        post('/song/download', { id: s.id, name: s.name, artist: s.artist }, 60000).then(function (r) {
            if (!r || r.code !== 0) { flash((r && r.msg) || '\u4e0b\u8f7d\u5931\u8d25'); return; }
            curJobId = r.data.jobId;
            showProgress('\u4e0b\u8f7d\u300a' + s.name + '\u300b');
            pendingSongRow = row;
            poll();
        }).catch(function (e) { flash(e.message); });
    }

    // 给结果行补一个可拖拽入口（下载完成后才有本地文件可拖）
    function attachSongDrag(row, filePath) {
        if (!row || !filePath) return;
        row.dataset.songPath = filePath;
        enableCepDrag(row, filePath);   // 整行可拖进 PR
        // 下载按钮 → 「✔ 已下载」，点它弹菜单（导入PR / 改目录 / 资源管理器）
        var dlBtn = row.querySelector('.bgm-m-dl');
        if (dlBtn) {
            dlBtn.textContent = '\u2714 \u5df2\u4e0b\u8f7d';
            dlBtn.classList.add('done');
            dlBtn.title = filePath;
            var clone = dlBtn.cloneNode(true);
            dlBtn.parentNode.replaceChild(clone, dlBtn);
            clone.addEventListener('click', function (ev) {
                ev.stopPropagation();
                showSongMenu(filePath, clone, ev);
            });
        }
    }

    // 歌曲下载后的操作菜单（对齐网易云板块）
    function showSongMenu(dest, anchor, ev) {
        ev.stopPropagation();
        var old = document.getElementById('bgmSongMenu');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var menu = document.createElement('div');
        menu.id = 'bgmSongMenu';
        menu.style.cssText = 'position:fixed;z-index:9999;min-width:180px;background:#2b2b2b;border:1px solid #444;border-radius:6px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.45);font-size:12px;';
        function mi(text, fn) {
            var el = document.createElement('div');
            el.style.cssText = 'padding:7px 12px;cursor:pointer;border-radius:4px;color:var(--text);white-space:nowrap;';
            el.textContent = text;
            el.addEventListener('mouseenter', function () { el.style.background = 'rgba(255,255,255,.08)'; });
            el.addEventListener('mouseleave', function () { el.style.background = ''; });
            el.addEventListener('click', function () { menu.remove(); fn(); });
            menu.appendChild(el);
        }
        mi('\u2934 \u5bfc\u5165 PR \u7d20\u6750\u7bb1', function () { importFilesToPR([dest], 'BGM'); });
        mi('\u25b6 \u63d2\u5165\u65f6\u95f4\u7ebf', function () { insertToTimeline(dest); });
        mi('\ud83d\udcc1 \u6539\u5b58\u5230\u5176\u4ed6\u76ee\u5f55\u2026', function () { moveSongFile(dest); });
        mi('\ud83d\udcc2 \u5728\u8d44\u6e90\u7ba1\u7406\u5668\u663e\u793a', function () {
            try { childProcess.spawn('explorer.exe', ['/select,' + dest]); } catch (e) {}
        });
        document.body.appendChild(menu);
        var r = anchor.getBoundingClientRect();
        var x = r.left, y = r.bottom + 4;
        if (x + 190 > window.innerWidth) x = window.innerWidth - 195;
        menu.style.left = x + 'px'; menu.style.top = y + 'px';
        setTimeout(function () {
            var kill = function (e2) { if (!menu.contains(e2.target)) { menu.remove(); document.removeEventListener('click', kill); } };
            document.addEventListener('click', kill);
        }, 10);
    }

    // 改存到其他目录（选目录后移动文件）
    function moveSongFile(dest) {
        post('/pick-dir', {}, 120000).then(function (r) {
            var newDir = (r.data || {}).path;
            if (!newDir) return;
            post('/song/move', { file: dest, dir: newDir }, 60000).then(function (r2) {
                if (r2 && r2.code === 0) {
                    flash('\u5df2\u79fb\u5230\uff1a' + r2.data.file);
                    // 更新行上的路径
                    var rows = document.querySelectorAll('#bgmResultList .bgm-item');
                    for (var i = 0; i < rows.length; i++) {
                        if (rows[i].dataset.songPath === dest) {
                            rows[i].dataset.songPath = r2.data.file;
                            var b = rows[i].querySelector('.bgm-m-dl');
                            if (b) b.title = r2.data.file;
                            enableCepDrag(rows[i], r2.data.file);
                            break;
                        }
                    }
                } else flash((r2 && r2.msg) || '\u79fb\u52a8\u5931\u8d25');
            });
        }).catch(function (e) { flash(e.message); });
    }


    // 批量记下已下载歌曲（按名字匹配行）
    function markSongsDownloaded(files) {
        files.forEach(function (f) {
            var nm = (f.name || '').trim();
            var rows = document.querySelectorAll('#bgmResultList .bgm-item');
            for (var i = 0; i < rows.length; i++) {
                var t = rows[i].querySelector('.bgm-item-name');
                if (nm && t && t.textContent.indexOf(nm) >= 0) { attachSongDrag(rows[i], f.file); break; }
            }
        });
    }

    // ---------- 入库 ----------
    // 音乐列表全选 / 取消全选
    function toggleSongSelectAll() {
        var songs = (lastResult && lastResult.songs) || [];
        if (!songs.length) { flash('\u5f53\u524d\u6ca1\u6709\u8bc6\u522b\u7ed3\u679c'); return; }
        var allSel = songs.length && Object.keys(selected).length === songs.length;
        selected = {};
        document.querySelectorAll('#bgmResultList .bgm-m-sel').forEach(function (b) {
            if (allSel) { b.classList.remove('on'); b.textContent = '\u9009\u7528'; }
            else { b.classList.add('on'); b.textContent = '\u5df2\u9009'; }
        });
        if (!allSel) songs.forEach(function (s) { selected[s.id] = s; });
        updateSongSelUI();
    }

    function updateSongSelUI() {
        var n = Object.keys(selected).length;
        var el = $('bgmSongSelInfo');
        if (el) el.textContent = n ? ('\u5df2\u9009 ' + n + ' \u9996') : '';
        var btn = $('btnBgmSelAllSongs');
        if (btn) {
            var total = (lastResult && lastResult.songs) ? lastResult.songs.length : 0;
            btn.textContent = (total && n === total) ? '\u53d6\u6d88\u5168\u9009' : '\u5168\u9009';
        }
    }

    // 批量下载选中的歌
    function downloadSelectedSongs() {
        var ids = Object.keys(selected);
        if (!ids.length) { flash('\u5148\u70b9\u300c\u9009\u7528\u300d\u52fe\u51fa\u8981\u4e0b\u8f7d\u7684\u6b4c'); return; }
        var songs = ids.map(function (k) { return selected[k]; });
        post('/song/download-multi', { songs: songs }, 60000).then(function (r) {
            if (!r || r.code !== 0) { flash((r && r.msg) || '\u4e0b\u8f7d\u5931\u8d25'); return; }
            curJobId = r.data.jobId;
            showProgress('\u6279\u91cf\u4e0b\u8f7d ' + songs.length + ' \u9996');
            poll();
        }).catch(function (e) { flash(e.message); });
    }

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
        try { ensureServer().catch(function () {}); } catch (e) {}
        try { refreshLocal(); } catch (e) {}
        try { renderHist(); } catch (e) {}
        try {
            var grid = $('bgmHotGrid');
            if (grid && !grid.children.length) loadHot('all');
        } catch (e) {}
    }

    // 安全绑定：元素缺失/异常都不影响其它按钮
    function on(id, fn, evName) {
        try {
            var el = $(id);
            if (!el) return false;
            el.addEventListener(evName || 'click', function (e) { try { fn(e); } catch (err) { flash('操作出错: ' + (err && err.message || err)); } });
            return true;
        } catch (e) { return false; }
    }

    function bind() {
      try {
        var q = $('bgmQuery');
        if (!q) return;
        q.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { var box = $('bgmSuggest'); if (box) box.style.display = 'none'; doSearch(); }
        });
        q.addEventListener('input', onQueryInput);
        on('btnBgmShareParse', parseShare);
        on('bgmHistClear', function () {
            try { localStorage.removeItem(HIST_KEY); } catch (e) {}
            renderHist();
        });
        bindHotTabs();
        on('btnBgmSearch', doSearch, 'click');
        $('btnBgmBack').addEventListener('click', function () {
            $('bgmSeriesWrap').style.display = 'none';
            $('bgmSearchWrap').style.display = '';
            $('bgmResultWrap').style.display = '';
        });
        on('btnBgmPickFile', startSingleByFile, 'click');
        on('btnBgmPickDir', startBatchByDir, 'click');
        on('btnBgmBatch', startBatchByDir, 'click');
        var ob = $('btnBgmOnlineBatch');
        if (ob) ob.addEventListener('click', startOnlineBatch);
        on('btnBgmCancel', stopJob, 'click');
        on('btnBgmToLib', toPlaylist, 'click');
        on('btnBgmSelAllSongs', toggleSongSelectAll);
        var ds = $('btnBgmDownloadSongs');
        if (ds) ds.addEventListener('click', downloadSelectedSongs);
        var md = $('btnBgmMusicDir');
        if (md) md.addEventListener('click', pickMusicDir);
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
        var da = $('btnBgmDownloadAll');
        if (da) da.addEventListener('click', function () {
            if (!curSeries) { flash('先选一部剧'); return; }
            var total = (curSeries.vid_list || []).length;
            if (!total) { flash('没有可下载的集'); return; }
            if (!window.confirm('下载全集（' + total + ' 集）？文件较多、耗时较长，可随时停止。')) return;
            startBgm('/batch', { series_id: curSeries.series_id, name: curSeries.name, from: 1, count: total },
                '下载全集（' + total + ' 集）');
        });
        var vv = $('bgmV');
        if (vv) vv.addEventListener('ended', function () {
            var auto = $('bgmAutoNext');
            if (auto && auto.checked) playNav(1);
        });
        wireHevcFallback();
        bindBar();
        // 小窗切换
        var mb = $('btnBgmMini');
        if (mb) mb.addEventListener('click', toggleMini);
        // 恢复上次小窗偏好
        try { if (localStorage.getItem('vh_bgm_mini') === '1') applyMini(true); } catch (e) {}
        // 当前 BGM 叠加条 → 跳识别列表
        var ns = $('bgmNowSong');
        if (ns) ns.addEventListener('click', jumpToSongList);
        // 底部播放条
        var bp = $('btnBgmBarPlay');
        if (bp) bp.addEventListener('click', function () {
            if (songMode && inlineAudio) {
                if (inlineAudio.paused) inlineAudio.play().catch(function () {}); else inlineAudio.pause();
                syncSongBar();
                return;
            }
            var v = $('bgmV'); if (!v || !v.src) { flash('\u5148\u9009\u4e00\u96c6\u64ad\u653e'); return; }
            if (v.paused) v.play().catch(function () {}); else v.pause();
            syncBar();
        });
        var bs = $('btnBgmBarStop');
        if (bs) bs.addEventListener('click', function () {
            if (songMode && inlineAudio) {
                try { inlineAudio.pause(); inlineAudio.currentTime = 0; } catch (e) {}
                syncSongBar();
                return;
            }
            var v = $('bgmV'); if (v) { try { v.pause(); v.currentTime = 0; } catch (e) {} }
            syncBar();
        });
        var bprev = $('btnBgmBarPrev');
        if (bprev) bprev.addEventListener('click', function () { playNav(-1); });
        // 进度条：点击/拖动跳转
        (function () {
            var sk = $('bgmBarSeek');
            if (!sk) return;
            var seekTo = function (ev) {
                var m = curMedia();
                if (!m || !m.duration) return;
                var r = sk.getBoundingClientRect();
                var pct = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
                try { m.currentTime = pct * m.duration; } catch (e) {}
                updateBarFill();
            };
            var dragging = false;
            sk.addEventListener('mousedown', function (ev) { dragging = true; seekTo(ev); ev.preventDefault(); });
            document.addEventListener('mousemove', function (ev) { if (dragging) seekTo(ev); });
            document.addEventListener('mouseup', function () { dragging = false; });
        })();
        // 音量
        on('bgmBarVol', function (ev) {
            var v = +ev.target.value;
            var m = curMedia();
            if (m) m.volume = v;
            var vv2 = $('bgmV'); if (vv2) vv2.volume = v;
            if (inlineAudio) inlineAudio.volume = v;
        }, 'input');
        var bnext = $('btnBgmBarNext');
        if (bnext) bnext.addEventListener('click', function () { playNav(1); });
      } catch (e) { try { flash('\u754c\u9762\u521d\u59cb\u5316\u5f02\u5e38: ' + (e && e.message || e)); } catch (e2) {} }
    }

    function safeBind() {
        try { bind(); } catch (e) { try { flash('\u77ed\u5267\u626c\u6b4c\u9762\u677f\u521d\u59cb\u5316\u5931\u8d25: ' + (e && e.message || e)); } catch (e2) {} }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeBind);
    else safeBind();

    window.__bgmOnShow = onShow;
})();
