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

    // 共享模块句柄在下方（setSrvState / $ / srvErrMsg 定义之后）创建，
    // 否则闭包里的函数表达式会捕获尚未初始化的变量。
    var svc = null;

    var curSeries = null;      // { series_id, name, vid_list }
    var curJobId = null;
    var pollTimer = null;
    var lastResult = null;      // 最近一次识别结果
    var selected = {};          // songId -> song（勾选要入库的）

    function $(id) { return document.getElementById(id); }

    // 轻提示：顶部滑入的小胶囊，自动消失。多条会纵向堆叠，不互相覆盖。
    var flashHost = null;
    function flash(msg, kind) {
        if (window.__copyFlash && !kind) { try { window.__copyFlash(msg); return; } catch (e) {} }
        try {
            if (!flashHost) {
                flashHost = document.createElement('div');
                flashHost.className = 'bgm-toast-host';
                document.body.appendChild(flashHost);
            }
            var t = document.createElement('div');
            t.className = 'bgm-toast' + (kind ? (' is-' + kind) : '');
            t.textContent = msg;
            flashHost.appendChild(t);
            // 入场
            void t.offsetWidth;
            t.classList.add('is-in');
            setTimeout(function () {
                t.classList.remove('is-in');
                setTimeout(function () {
                    if (t.parentNode) t.parentNode.removeChild(t);
                    if (flashHost && !flashHost.children.length) {
                        if (flashHost.parentNode) flashHost.parentNode.removeChild(flashHost);
                        flashHost = null;
                    }
                }, 260);
            }, 2200);
        } catch (e) {}
    }

    // ============ 统一弹窗（替代原生 confirm / alert） ============
    // 原生弹窗在 CEP 里样式丑陋、且会阻塞；这里用自建层，风格与面板一致。
    //   bgmDialog.confirm({title, body, okText, cancelText, danger}) -> Promise<bool>
    //   bgmDialog.alert({title, body, okText})                      -> Promise<void>
    var bgmDialog = (function () {
        function open(opt) {
            opt = opt || {};
            return new Promise(function (resolve) {
                var mask = document.createElement('div');
                mask.className = 'bgm-dlg-mask';
                var box = document.createElement('div');
                box.className = 'bgm-dlg' + (opt.danger ? ' is-danger' : '');

                var head = document.createElement('div');
                head.className = 'bgm-dlg-head';
                head.textContent = opt.title || '提示';
                box.appendChild(head);

                var body = document.createElement('div');
                body.className = 'bgm-dlg-body';
                // 支持 \n 换行（用 textContent + pre-line 由 CSS 处理）
                body.textContent = opt.body || '';
                box.appendChild(body);

                var foot = document.createElement('div');
                foot.className = 'bgm-dlg-foot';
                var isConfirm = !!opt.cancelText || opt.confirm === true;

                function close(v) {
                    try { if (mask.parentNode) mask.parentNode.removeChild(mask); } catch (e) {}
                    document.removeEventListener('keydown', onKey);
                    resolve(v);
                }
                function onKey(e) {
                    if (e.key === 'Escape') close(false);
                    else if (e.key === 'Enter') close(true);
                }

                if (isConfirm) {
                    var btnC = document.createElement('button');
                    btnC.className = 'bgm-dlg-btn';
                    btnC.textContent = opt.cancelText || '取消';
                    btnC.addEventListener('click', function () { close(false); });
                    foot.appendChild(btnC);
                }
                var btnO = document.createElement('button');
                btnO.className = 'bgm-dlg-btn is-primary' + (opt.danger ? ' is-danger' : '');
                btnO.textContent = opt.okText || '确定';
                btnO.addEventListener('click', function () { close(true); });
                foot.appendChild(btnO);
                box.appendChild(foot);

                mask.appendChild(box);
                document.body.appendChild(mask);
                document.addEventListener('keydown', onKey);
                // 遮罩点击 = 取消（确认框）或关闭（提示框）
                mask.addEventListener('click', function (e) { if (e.target === mask) close(false); });
                setTimeout(function () { try { btnO.focus(); } catch (e) {} }, 20);
            });
        }
        return {
            confirm: function (opt) {
                if (typeof opt === 'string') opt = { body: opt };
                opt.confirm = true;
                return open(opt);
            },
            alert: function (opt) {
                if (typeof opt === 'string') opt = { body: opt };
                opt.cancelText = '';
                opt.okText = opt.okText || '知道了';
                return open(opt);
            }
        };
    })();

    function api(url, opt) {
        // 实现已抽到 js/localsvc.js，文案保持本板块原样（服务未连接 / 响应解析失败）
        return svc.api(url, opt);
    }

    function post(url, body, timeout) {
        return api(url, { method: 'POST', body: body, timeout: timeout });
    }

    // ---------- 服务自举 ----------
    // findNode / 探活重试 已抽到 js/localsvc.js；spawnServer 保留
    // （它要采集子进程 stdout/stderr 到 srvLog，供报错时展示排障信息）
    function findNode() {
        return svc.findNode();
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
        // 服务侧失败同时落盘：扒歌出错时提示一闪而过，没地方查原因。
        if (cls === 'err') {
            try { if (window.__vhLog) window.__vhLog.err('[bgm] ' + txt); } catch (e) {}
        }
        var el = $('bgmSrvState');
        if (!el) return;
        el.textContent = txt;
        el.className = 'music-server' + (cls ? ' ' + cls : '');
    }

    var lastSrvErr = '';
    // 探活重试逻辑已抽到 js/localsvc.js；lastSrvErr 由 onError 钩子记录
    function ensureServer(retries, quiet) {
        return svc.ensureServer(retries, quiet);
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

    // 本地服务句柄：放在 setSrvState / $ / findNode / srvErrMsg 定义之后创建，
    // 确保闭包里的这些函数都已就绪。
    svc = window.__vhLocalSvc.create({
        base: API,
        name: '\u77ed\u5267\u6252\u6b4c',
        defaultTimeout: 30000,
        healthTimeout: 8000,
        retries: 6,
        interval: 1500,
        emptyAsObject: true,
        errorStatusMessage: '服务未连接',
        errorNetMessage: '服务未连接',
        spawn: function () { return spawnServer(); },
        onState: function (t, c) { setSrvState(t, c); },
        onHealth: function (h) {
            var hint = $('bgmLoginHint');
            if (hint) {
                if (!h.logged) hint.textContent = '\u26a0 \u672a\u767b\u5f55\u7f51\u6613\u4e91\uff0c\u8bf7\u5148\u5728\u300c\u7f51\u6613\u4e91\u300d\u677f\u5757\u767b\u5f55';
                else if (!h.sherpa || !h.model) hint.textContent = '\u26a0 \u7f3a\u5c11\u4eba\u58f0\u5206\u79bb\u7ec4\u4ef6';
                else hint.textContent = '';
            }
        },
        onError: function (e) {
            lastSrvErr = (e && e.message) || '\u672a\u77e5';
        },
        errorMessage: function () {
            return srvErrMsg('\u540e\u7aef\u670d\u52a1\u542f\u52a8\u5931\u8d25', lastSrvErr);
        }
    });


    // ---------- 上次页面持久化（关插件/切板块后回来仍停在原页面）----------
    var UI_KEY = 'vh_bgm_uistate';
    // 上次播放位置（秒）：暂停/卸载时 currentTime 可能已丢失，用它兜底
    var lastPlayPos = 0;
    var lastPosSaveAt = 0;
    function saveUiState() {
        try {
            var st = {
                view: 'home',
                series: null,
                hotKind: hotKind,
                playEp: playEp || 0,
                at: Date.now(),
            };
            // 判断当前停在哪个视图（按显示优先级：播放器 > 结果 > 剧集 > 搜索 > 首页）
            if (curSeries && curSeries.series_id && $('bgmSeriesWrap') && $('bgmSeriesWrap').style.display !== 'none') {
                st.view = 'series';
                st.series = {
                    series_id: curSeries.series_id,
                    name: curSeries.name || '',
                    count: curSeries.count || 0,
                };
                // 记录播放器是否开着、开的哪一集、播到多少秒
                // （用户希望重开面板后直接回到上次暂停的位置）
                var pw = $('bgmPlayerWrap');
                var pv = $('bgmV');
                st.playerOpen = !!(pw && pw.style.display !== 'none');
                if (st.playerOpen && playEp) {
                    st.playEp = playEp;
                    // 暂停时的位置优先用实际 currentTime；否则用上次记下的
                    var ct = 0;
                    try { ct = pv ? (pv.currentTime || 0) : 0; } catch (e) { ct = 0; }
                    st.pos = ct > 1 ? ct : (lastPlayPos || 0);
                } else {
                    st.pos = 0;
                }
            } else {
                var sw = $('bgmSearchWrap');
                if (sw && sw.style.display !== 'none' && sw.innerHTML) st.view = 'search';
                st.playerOpen = false;
            }
            localStorage.setItem(UI_KEY, JSON.stringify(st));
        } catch (e) {}
    }
    function loadUiState() {
        try { return JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch (e) { return null; }
    }

    // 恢复上次停留的页面
    function restoreUiState() {
        var st = loadUiState();
        if (!st) return false;
        // 榜单分类还原
        if (st.hotKind && st.hotKind !== hotKind) {
            hotKind = st.hotKind;
            document.querySelectorAll('.bgm-hot-tab').forEach(function (b) {
                b.classList.toggle('active', b.getAttribute('data-kind') === hotKind);
            });
        }
        // 剧集页还原：有剧号就重新拉一次剧集信息（vid_list 不缓存，避免过期）
        if (st.view === 'series' && st.series && st.series.series_id) {
            ensureServer().then(function () {
                return api('/series?series_id=' + encodeURIComponent(st.series.series_id), { timeout: 40000 });
            }).then(function (r) {
                if (r && r.code === 0 && r.data) {
                    curSeries = r.data;
                    renderSeriesNow();
                    // 上次停在播放器里 → 重新打开播放器并回到原进度
                    var wantEp = st.playEp || 0;
                    if (st.playerOpen && wantEp) {
                        // 等本地列表就绪（refreshLocal 在 renderSeries 里异步进行）
                        setTimeout(function () {
                            try {
                                if (!localMap[wantEp]) {
                                    // 文件不在了（被清过），就不强行恢复
                                    saveUiState();
                                    return;
                                }
                                resumeInto(wantEp, st.pos || 0);
                            } catch (e) {}
                        }, 500);
                    } else if (wantEp && localMap[wantEp]) {
                        playEp = wantEp;
                    }
                    setTimeout(function () { saveUiState(); }, 900);
                }
            }).catch(function () { /* 恢复失败就停在首页 */ });
            return true;
        }
        return false;
    }

    // ---------- 首页热门瀑布流 ----------
    var hotKind = 'all';
    // 骨架屏（等待服务启动时给视觉反馈）
    function hotSkeleton() {
        var grid = $('bgmHotGrid');
        if (!grid) return;
        var s = '';
        for (var i = 0; i < 8; i++) {
            s += '<div class="bgm-grid-card bgm-sk"><div class="bgm-sk-cover"></div>' +
                 '<div class="bgm-sk-line"></div><div class="bgm-sk-line short"></div></div>';
        }
        grid.innerHTML = s;
        grid.setAttribute('data-loaded', '0');
    }

    function hotStatus(text, isErr, retry) {
        var grid = $('bgmHotGrid');
        if (!grid) return;
        grid.innerHTML = '<div class="bgm-hot-status' + (isErr ? ' err' : '') + '">' +
            '<div>' + esc(text) + '</div>' +
            (retry ? '<button class="tbtn" id="bgmHotRetry" style="margin-top:8px;padding:3px 10px;font-size:11px;">重试</button>' : '') +
            '</div>';
        grid.setAttribute('data-loaded', '0');
        if (retry) {
            var b = $('bgmHotRetry');
            if (b) b.addEventListener('click', function () { loadHot(hotKind, true); });
        }
    }

    var hotLoading = false;
    var hotAutoRetry = 0;          // 自动重试次数（有上限，防无限循环）
    // ---------- 剧集收藏 ----------
    // 存：剧号、剧名、封面、热度等卡片信息。同一剧按 series_id 去重。
    var FAV_KEY = 'vh_bgm_fav_series';
    var FAV_MAX = 200;

    function loadFavSeries() {
        try {
            var a = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    }
    function saveFavSeries(list) {
        try { localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, FAV_MAX))); } catch (e) {}
    }
    function isFavSeries(sid) {
        if (!sid) return false;
        var list = loadFavSeries();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].series_id) === String(sid)) return true;
        }
        return false;
    }
    // 切换收藏；返回切换后的状态（true=已收藏）
    function toggleFavSeries(it) {
        if (!it || !it.series_id) return false;
        var sid = String(it.series_id);
        var list = loadFavSeries();
        var idx = -1;
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].series_id) === sid) { idx = i; break; }
        }
        if (idx >= 0) {
            list.splice(idx, 1);
            saveFavSeries(list);
            refreshFavCards();
            if (hotKind === 'fav') renderFavGrid();
            return false;
        }
        list.unshift({
            series_id: it.series_id,
            name: it.name || '',
            cover: it.cover || '',
            hot: it.hot || '',
            fav: it.fav || '',
            like: it.like || '',
            score: it.score || '',
            at: Date.now(),
        });
        saveFavSeries(list);
        refreshFavCards();
        if (hotKind === 'fav') renderFavGrid();
        return true;
    }
    function clearFavSeries() {
        try { localStorage.removeItem(FAV_KEY); } catch (e) {}
        refreshFavCards();
        if (hotKind === 'fav') renderFavGrid();
    }

    // 收藏列表页（复用瀑布流卡片）
    function renderFavGrid() {
        var grid = $('bgmHotGrid');
        if (!grid) return;
        var list = loadFavSeries();
        if (!list.length) {
            grid.innerHTML = '<div style="padding:14px 10px;font-size:11.5px;color:var(--muted);line-height:1.7;">' +
                '还没有收藏的短剧。<br>在任意剧的封面上点 ☆ 即可收藏，之后在这里集中查看。</div>';
            grid.setAttribute('data-loaded', '1');
            return;
        }
        renderHot(list);
        grid.setAttribute('data-loaded', '1');
    }

    // ---------- 已下载剧集（从本地文件名聚合）----------
    // 文件名约定：<剧名>_<4位集号>.mp4
    // 反推出「剧名 → 已下载的集号集合」，用于「已下载」页的按剧管理。
    // 缓存一份，供已下载页与右键菜单共用（refreshLocal 时刷新）。
    var dlSeries = {};   // name -> { name, eps: [{ep, path, sizeMB, hasH264}], totalMB, latest }
    // 下载中的任务：剧号 -> { name, total, done, curEp, percent }
    // 目的：触发下载后立刻能在「已下载」板块看到这部剧（文件还没落地时靠它先建卡片）
    var dlJobs = {};
    function dlJobStart(sid, name, total) {
        dlJobs[String(sid)] = { name: name || '', total: total || 0, done: 0, curEp: 0, percent: 0 };
        if (hotKind === 'downloaded') renderDlGrid();
    }
    function dlJobProgress(sid, done, curEp, percent) {
        var j = dlJobs[String(sid)];
        if (!j) return;
        j.done = done; j.curEp = curEp; j.percent = percent || 0;
        if (hotKind === 'downloaded') renderDlGrid();
    }
    function dlJobFinish(sid) {
        delete dlJobs[String(sid)];
        if (hotKind === 'downloaded') renderDlGrid();
    }
    function dlJobOfSeries(name) {
        var keys = Object.keys(dlJobs);
        for (var i = 0; i < keys.length; i++) {
            if (dlJobs[keys[i]].name === name) return { sid: keys[i], job: dlJobs[keys[i]] };
        }
        return null;
    }

    function rebuildDlSeries() {
        dlSeries = {};
        (localAll || []).forEach(function (f) {
            var m = /^(.*)_(\d{4})\.(mp4|mkv|mov|webm)$/i.exec(f.name);
            if (!m) return;
            var sname = m[1] || '(未命名)';
            var ep = parseInt(m[2], 10);
            if (!dlSeries[sname]) dlSeries[sname] = { name: sname, eps: [], totalMB: 0 };
            dlSeries[sname].eps.push({
                ep: ep,
                path: f.path,
                name: f.name,
                sizeMB: (f.size / 1048576),
                hasH264: !!f.hasH264,
                mtime: f.mtime || 0,
            });
            dlSeries[sname].totalMB += (f.size / 1048576);
        });
        Object.keys(dlSeries).forEach(function (k) {
            dlSeries[k].eps.sort(function (a, b) { return a.ep - b.ep; });
        });
        return dlSeries;
    }

    // 某剧的总集数：从已知来源查（当前剧信息 / 收藏记录），查不到返回 0
    // 用于在已下载页显示「已下载 X / 总 Y 集」
    function seriesTotalOf(name) {
        if (!name) return 0;
        // 1) 当前打开的剧
        if (curSeries && curSeries.name === name && curSeries.count) return curSeries.count;
        // 2) 收藏记录里存过 count
        try {
            var favs = loadFavSeries();
            for (var i = 0; i < favs.length; i++) {
                if (favs[i].name === name && favs[i].count) return favs[i].count;
            }
        } catch (e) {}
        // 3) 播放历史里存过 count
        try {
            var hist = loadPlayHist();
            for (var k = 0; k < hist.length; k++) {
                if (hist[k].name === name && hist[k].count) return hist[k].count;
            }
        } catch (e) {}
        return 0;
    }

    // 某剧的已下载集号列表（供右键菜单判断"下载该剧"要不要跳过已下载的集）
    function dlEpsOf(seriesName) {
        var key = String(seriesName || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        var obj = dlSeries[key];
        return obj ? obj.eps.map(function (e) { return e.ep; }) : [];
    }

    // 已下载页：按剧列出，点剧展开看集
    var dlExpanded = {};   // 剧名 -> 是否展开
    function renderDlGrid() {
        var grid = $('bgmHotGrid');
        if (!grid) return;
        var obj = rebuildDlSeries();
        var names = Object.keys(obj);

        // 下载中的剧（文件还没落地）也要出现在这里，让用户看到进展
        var jobKeys = Object.keys(dlJobs);
        var downloading = [];
        jobKeys.forEach(function (k) {
            var j = dlJobs[k];
            // 已完成落地的不再作为「下载中」重复显示
            if (j.name && obj[j.name] && obj[j.name].eps.length >= j.done && j.done >= j.total) return;
            downloading.push({ sid: k, job: j });
        });

        if (!names.length && !downloading.length) {
            grid.innerHTML = '<div style="padding:14px 10px;font-size:11.5px;color:var(--muted);line-height:1.7;">' +
                '本地还没有已下载的短剧。<br>在剧集页点「下载全集」，或在卡片右键选「下载该剧」。</div>';
            grid.setAttribute('data-loaded', '1');
            return;
        }
        // 按最近下载时间排序
        names.sort(function (a, b) {
            var la = 0, lb = 0;
            obj[a].eps.forEach(function (e) { if (e.mtime > la) la = e.mtime; });
            obj[b].eps.forEach(function (e) { if (e.mtime > lb) lb = e.mtime; });
            return lb - la;
        });
        grid.innerHTML = '';

        // 先画「下载中」的剧（要标出 X/Y 集与进度）
        downloading.forEach(function (d) {
            var j = d.job;
            var pct = Math.max(0, Math.min(100, j.percent || 0));
            var card = document.createElement('div');
            card.className = 'bgm-dl-series is-downloading';
            card.innerHTML =
                '<div class="bgm-dl-head">' +
                    '<span class="bgm-dl-arrow">↓</span>' +
                    '<span class="bgm-dl-name">' + esc(j.name || '(未命名)') + '</span>' +
                    '<span class="bgm-dl-meta">下载中 ' + j.done + ' / ' + j.total + ' 集 · ' + pct + '%</span>' +
                '</div>' +
                '<div class="bgm-dl-prog"><i style="width:' + pct + '%"></i></div>';
            grid.appendChild(card);
        });

        names.forEach(function (n) {
            var item = obj[n];
            var card = document.createElement('div');
            card.className = 'bgm-dl-series';
            var open = !!dlExpanded[n];
            var sizeTxt = item.totalMB >= 1024
                ? (item.totalMB / 1024).toFixed(1) + ' GB'
                : item.totalMB.toFixed(0) + ' MB';
            // 总集数：优先用已知的剧信息（当前剧/收藏里存的 count），否则只显示已下载数
            var mine = item.eps.map(function (e) { return e.ep; });
            var maxEp = mine.length ? Math.max.apply(null, mine) : 0;
            var totalCnt = seriesTotalOf(n);
            var epsTxt = totalCnt
                ? ('已下载 ' + item.eps.length + ' / ' + totalCnt + ' 集')
                : ('已下载 ' + item.eps.length + ' 集');
            // 有缺口时提示（靠 max 集号推断，仅供参考）
            var gapTxt = '';
            if (maxEp > item.eps.length) {
                gapTxt = '<span class="bgm-dl-gap" title="已下载集号不连续，中间有缺口">缺 ' +
                    (maxEp - item.eps.length) + ' 集</span>';
            }
            card.innerHTML =
                '<div class="bgm-dl-head">' +
                    '<span class="bgm-dl-arrow">' + (open ? '▾' : '▸') + '</span>' +
                    '<span class="bgm-dl-name">' + esc(n) + '</span>' +
                    '<span class="bgm-dl-meta">' + epsTxt + ' · ' + sizeTxt + gapTxt + '</span>' +
                    '<span class="bgm-dl-actions">' +
                        '<button class="tbtn bgm-dl-open" title="打开所在目录">📂</button>' +
                        '<button class="tbtn danger bgm-dl-delall" title="删除这部剧的全部本地文件">删除</button>' +
                    '</span>' +
                '</div>' +
                '<div class="bgm-dl-eps" style="display:' + (open ? '' : 'none') + ';"></div>';

            // 展开/收起
            var head = card.querySelector('.bgm-dl-head');
            head.addEventListener('click', function (ev) {
                if (ev.target.tagName === 'BUTTON') return;   // 点按钮不触发折叠
                dlExpanded[n] = !dlExpanded[n];
                renderDlGrid();
            });
            // 打开目录
            card.querySelector('.bgm-dl-open').addEventListener('click', function (ev) {
                ev.stopPropagation();
                var first = item.eps[0];
                if (!first) return;
                try { childProcess.spawn('explorer.exe', ['/select,' + first.path]); } catch (e) {}
            });
            // 删除整剧
            card.querySelector('.bgm-dl-delall').addEventListener('click', function (ev) {
                ev.stopPropagation();
                delDlFiles(item.eps.map(function (e) { return e.path; }), n + '（' + item.eps.length + ' 集）');
            });

            // 展开的集列表
            var box = card.querySelector('.bgm-dl-eps');
            if (open) {
                item.eps.forEach(function (e) {
                    var row = document.createElement('div');
                    row.className = 'bgm-dl-ep';
                    row.innerHTML =
                        '<span class="bgm-dl-epno">第 ' + e.ep + ' 集</span>' +
                        '<span class="bgm-dl-epsize">' + e.sizeMB.toFixed(1) + ' MB</span>' +
                        '<span class="bgm-dl-epactions">' +
                            '<button class="tbtn bgm-dl-play" title="播放这一集">播放</button>' +
                            '<button class="tbtn danger bgm-dl-del" title="删除这一集">删除</button>' +
                        '</span>';
                    row.querySelector('.bgm-dl-play').addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        playDlEp(n, e.ep);
                    });
                    row.querySelector('.bgm-dl-del').addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        delDlFiles([e.path], n + ' 第 ' + e.ep + ' 集');
                    });
                    box.appendChild(row);
                });
            }
            grid.appendChild(card);
        });
        grid.setAttribute('data-loaded', '1');
    }

    // 删除本地文件（二次确认）
    function delDlFiles(paths, label) {
        if (!paths || !paths.length) return;
        bgmDialog.confirm({
            title: '删除本地文件',
            body: '确定删除 ' + label + ' 的本地文件吗？\n\n文件将被永久删除，不可恢复；对应的转码缓存也会一并清除。',
            okText: '删除',
            cancelText: '取消',
            danger: true
        }).then(function (yes) {
        if (!yes) return;
        post('/local-delete', { files: paths }, 60000).then(function (r) {
            if (r && r.code === 0) {
                var n = (r.data || {}).count || 0;
                var fail = (r.data || {}).fail || [];
                flash('已删除 ' + n + ' 个文件' + (fail.length ? ('，' + fail.length + ' 个失败') : ''));
                if (fail.length) { try { window.__vhLog && window.__vhLog.err('[bgm] 删除失败: ' + JSON.stringify(fail.slice(0, 3))); } catch (e) {} }
                refreshLocal().then(function () {
                    if (hotKind === 'downloaded') renderDlGrid();
                });
            } else {
                flash((r && r.msg) || '删除失败');
            }
        }).catch(function (e) { flash('删除失败：' + (e && e.message || e)); });
        });
    }

    // 播放本地某剧某集（不依赖当前剧集页）
    function playDlEp(seriesName, ep) {
        var obj = dlSeries[seriesName];
        if (!obj) return;
        var found = null;
        obj.eps.forEach(function (e) { if (e.ep === ep) found = e; });
        if (!found) return;
        // 构造一个最小 curSeries，让 playLocal 能复用
        var vids = [];
        for (var i = 0; i < ep; i++) vids.push(null);
        curSeries = { series_id: '_local_' + seriesName, name: seriesName, vid_list: vids, count: vids.length };
        localMap = {};
        obj.eps.forEach(function (e) {
            localMap[e.ep] = { path: e.path, name: e.name, sizeMB: e.sizeMB.toFixed(1), hasH264: e.hasH264 };
        });
        playLocal(ep);
    }

    // 卡片上的星标状态刷新（不重建整个列表，避免滚动位置丢失）
    function refreshFavCards() {
        var grid = $('bgmHotGrid');
        if (!grid) return;
        var cards = grid.querySelectorAll('.bgm-grid-card');
        for (var i = 0; i < cards.length; i++) {
            var sid = cards[i].getAttribute('data-sid');
            var st = cards[i].querySelector('.bgm-card-fav');
            if (!st || !sid) continue;
            var on = isFavSeries(sid);
            st.textContent = on ? '★' : '☆';
            st.classList.toggle('is-on', on);
            st.title = on ? '取消收藏' : '收藏';
        }
    }

    function loadHot(kind, force) {
        if (force) hotAutoRetry = 0;   // 手动触发时重置
        hotKind = kind || hotKind;
        var grid = $('bgmHotGrid');
        if (!grid) return;
        // 收藏是纯本地数据，不请求服务
        if (hotKind === 'fav') {
            hotLoading = false;
            grid.removeAttribute('data-loaded');
            renderFavGrid();
            return;
        }
        // 已下载也是本地数据：先刷新本地列表再渲染
        if (hotKind === 'downloaded') {
            hotLoading = false;
            grid.removeAttribute('data-loaded');
            refreshLocal().then(function () { renderDlGrid(); }, function () { renderDlGrid(); });
            return;
        }
        // 非强制刷新 && 已加载过 → 不重复请求
        if (!force && grid.getAttribute('data-loaded') === '1') return;
        if (hotLoading) return;
        hotLoading = true;

        hotSkeleton();
        // 关键：先等服务就绪（首次打开要 spawn node + 探测资源，可能几秒）
        ensureServer().then(function () {
            return api('/hot?kind=' + encodeURIComponent(hotKind), { timeout: 40000 });
        }).then(function (r) {
            hotLoading = false;
            if (!r || r.code !== 0) {
                hotStatus('榜单加载失败，请重试', true, true);
                return;
            }
            var list = r.data || [];
            renderHot(list);
            grid.setAttribute('data-loaded', '1');
            hotAutoRetry = 0;
        }).catch(function (e) {
            hotLoading = false;
            // 服务未就绪：给一次自动重试，再失败才让用户点
            var st = $('bgmSrvState');
            var notReady = !st || st.textContent.indexOf('服务正常') < 0;
            hotStatus(notReady ? '正在等待本地服务启动…' : ('加载失败：' + (e && e.message || e)),
                      true, true);
            // 最多自动再试 2 轮（服务通常几秒内就绪），之后交给用户点「重试」
            if (hotAutoRetry < 2) {
                hotAutoRetry++;
                hotStatus(notReady ? ('正在等待本地服务启动…（已重试 ' + hotAutoRetry + '/2）')
                                   : ('加载失败：' + (e && e.message || e) + '（已重试 ' + hotAutoRetry + '/2）'),
                          true, true);
                setTimeout(function () {
                    var g2 = $('bgmHotGrid');
                    if (g2 && g2.getAttribute('data-loaded') !== '1') loadHot(hotKind, true);
                }, 3000);
            }
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
            if (it.series_id) el.setAttribute('data-sid', String(it.series_id));
            var faved = isFavSeries(it.series_id);
            el.innerHTML =
                '<img class="bgm-grid-cover" src="' + esc(it.cover || '') + '" loading="lazy" ' +
                    'onerror="this.style.background=\'#222\';this.removeAttribute(\'src\')">' +
                // 收藏星标（盖在封面右上角）
                '<span class="bgm-card-fav' + (faved ? ' is-on' : '') + '" title="' +
                    (faved ? '取消收藏' : '收藏') + '">' + (faved ? '★' : '☆') + '</span>' +
                '<div class="bgm-grid-name">' + esc(it.name || '') + '</div>' +
                '<div class="bgm-grid-sub">' + esc(it.hot || it.fav || it.like || '') +
                    (it.score ? ('  \u8bc4' + esc(it.score)) : '') + '</div>';
            // 星标点击：只切收藏，不进剧集页
            var st = el.querySelector('.bgm-card-fav');
            if (st) {
                st.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    ev.preventDefault();
                    var on = toggleFavSeries(it);
                    st.textContent = on ? '★' : '☆';
                    st.classList.toggle('is-on', on);
                    st.title = on ? '取消收藏' : '收藏';
                    if (on) flash('已收藏：' + (it.name || ''));
                });
            }
            el.addEventListener('click', function () { openSeries(it); });
            // 右键菜单：收藏 / 下载该剧 / 打开
            el.addEventListener('contextmenu', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                showSeriesMenu(it, ev);
            });
            grid.appendChild(el);
        });
    }

    function bindHotTabs() {
        document.querySelectorAll('.bgm-hot-tab').forEach(function (b) {
            b.addEventListener('click', function () {
                document.querySelectorAll('.bgm-hot-tab').forEach(function (x) { x.classList.remove('active'); });
                b.classList.add('active');
                loadHot(b.getAttribute('data-kind'), true);
                saveUiState();
            });
        });
        var rf = $('bgmHotRefresh');
        if (rf) rf.addEventListener('click', function () { loadHot(hotKind, true); });
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

    // ---------- 播放历史（首页「接着看」）----------
    // 记录看过哪部剧、看到第几集、看到多少秒。
    // 同一部剧只保留一条（重复看同一部只更新时间与进度），最多 30 部。
    var PLAY_HIST_KEY = 'vh_bgm_play_hist';
    var PLAY_HIST_MAX = 30;

    function loadPlayHist() {
        try {
            var a = JSON.parse(localStorage.getItem(PLAY_HIST_KEY) || '[]');
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    }
    function savePlayHist(list) {
        try { localStorage.setItem(PLAY_HIST_KEY, JSON.stringify(list.slice(0, PLAY_HIST_MAX))); } catch (e) {}
    }

    // 记一条播放历史。ep/pos 可省略（只更新剧信息时用）。
    // 不记未识别的媒体；同一剧按 series_id 去重并置顶。
    function addPlayHist(opt) {
        if (!opt || !opt.series_id) return;
        var list = loadPlayHist();
        var sid = String(opt.series_id);
        list = list.filter(function (x) { return String(x.series_id) !== sid; });
        var old = null;
        try {
            var raw = JSON.parse(localStorage.getItem(PLAY_HIST_KEY) || '[]');
            for (var i = 0; i < raw.length; i++) {
                if (String(raw[i].series_id) === sid) { old = raw[i]; break; }
            }
        } catch (e) {}
        list.unshift({
            series_id: opt.series_id,
            name: opt.name || (old && old.name) || '',
            cover: opt.cover || (old && old.cover) || '',
            count: opt.count || (old && old.count) || 0,
            ep: (opt.ep != null && opt.ep) ? opt.ep : ((old && old.ep) || 1),
            pos: (opt.pos != null) ? opt.pos : ((old && old.pos) || 0),
            dur: opt.dur || (old && old.dur) || 0,
            at: Date.now(),
        });
        savePlayHist(list);
        renderPlayHist();
    }

    function removePlayHist(sid) {
        var list = loadPlayHist().filter(function (x) { return String(x.series_id) !== String(sid); });
        savePlayHist(list);
        renderPlayHist();
    }

    // 只更新某部剧的观看进度（不置顶、不动其他字段）。
    // 与 addPlayHist 的区别：用于播放中高频更新，不能重排序（否则看着看着列表就跳了）。
    function updatePlayHistPos(ep, pos, dur) {
        if (!curSeries || !curSeries.series_id) return;
        var sid = String(curSeries.series_id);
        var list = loadPlayHist();
        var hit = false;
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].series_id) === sid) {
                list[i].ep = ep || list[i].ep;
                list[i].pos = pos || 0;
                if (dur) list[i].dur = dur;
                list[i].at = Date.now();
                hit = true;
                break;
            }
        }
        if (!hit) {
            addPlayHist({
                series_id: curSeries.series_id, name: curSeries.name,
                cover: curSeries.cover || curSeries.cover_url || curSeries.pic,
                count: curSeries.count, ep: ep, pos: pos, dur: dur
            });
            return;
        }
        savePlayHist(list);
        renderPlayHist();
    }

    function clearPlayHist() {
        try { localStorage.removeItem(PLAY_HIST_KEY); } catch (e) {}
        renderPlayHist();
    }

    // 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前）
    function relTime(t) {
        if (!t) return '';
        var d = Date.now() - t;
        if (d < 60000) return '刚刚';
        if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
        if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
        if (d < 2592000000) return Math.floor(d / 86400000) + ' 天前';
        return new Date(t).toLocaleDateString();
    }

    function renderPlayHist() {
        var wrap = $('bgmPlayHistWrap'), box = $('bgmPlayHist');
        if (!wrap || !box) return;
        var list = loadPlayHist();
        if (!list.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        box.innerHTML = '';
        list.forEach(function (it) {
            var row = document.createElement('div');
            row.className = 'bgm-ph-item';

            var cover = document.createElement('div');
            cover.className = 'bgm-ph-cover';
            if (it.cover) {
                cover.style.backgroundImage = 'url("' + String(it.cover).replace(/"/g, '') + '")';
            } else {
                cover.textContent = '🎬';
            }

            var main = document.createElement('div');
            main.className = 'bgm-ph-main';

            var nm = document.createElement('div');
            nm.className = 'bgm-ph-name';
            nm.textContent = it.name || it.series_id;

            var meta = document.createElement('div');
            meta.className = 'bgm-ph-meta';
            var epTxt = '第 ' + (it.ep || 1) + ' 集';
            var posTxt = (it.pos > 1) ? ('看到 ' + fmtTime(it.pos)) : '';
            meta.textContent = [epTxt, posTxt, relTime(it.at)].filter(function (x) { return x; }).join(' · ');

            main.appendChild(nm);
            main.appendChild(meta);

            // 进度条（有总时长与位置时才有意义）
            if (it.dur > 0 && it.pos > 0) {
                var pb = document.createElement('div');
                pb.className = 'bgm-ph-prog';
                var fill = document.createElement('i');
                fill.style.width = Math.min(100, Math.max(0, (it.pos / it.dur) * 100)) + '%';
                pb.appendChild(fill);
                main.appendChild(pb);
            }

            var go = document.createElement('span');
            go.className = 'bgm-ph-go';
            go.textContent = '继续 ▶';

            var del = document.createElement('span');
            del.className = 'bgm-ph-del';
            del.textContent = '✕';
            del.title = '从历史中移除';
            del.addEventListener('click', function (ev) {
                ev.stopPropagation();
                removePlayHist(it.series_id);
            });

            row.appendChild(cover);
            row.appendChild(main);
            row.appendChild(go);
            row.appendChild(del);

            row.addEventListener('click', function () { openPlayHist(it); });
            box.appendChild(row);
        });
    }

    // 点播放历史：打开该剧，并恢复该集与该位置（不自动播，由用户按播放）
    function openPlayHist(it) {
        if (!it || !it.series_id) return;
        ensureServer().then(function () {
            return api('/series?series_id=' + encodeURIComponent(it.series_id), { timeout: 40000 });
        }).then(function (r) {
            if (!r || r.code !== 0 || !r.data) { flash((r && r.msg) || '打开失败'); return; }
            curSeries = r.data;
            renderSeries({ noFocus: true });
            var wantEp = it.ep || 1;
            var wantPos = it.pos || 0;
            // 等本地列表就绪再进播放器
            setTimeout(function () {
                if (!localMap[wantEp]) {
                    // 该集不在本地：进剧集页并提示，不强行下载
                    focusSeries();
                    flash('第 ' + wantEp + ' 集还没下载，可在列表里点它播放');
                    return;
                }
                try { resumeInto(wantEp, wantPos, true); } catch (e) {}   // true = 自动播放
            }, 600);
        }).catch(function (e) { flash('打开失败：' + (e && e.message || e)); });
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
            if (r.code !== 0) {
                flash(r.msg || '\u89e3\u6790\u5931\u8d25\uff08\u652f\u6301\u5206\u4eab\u94fe\u63a5/App \u77ed\u94fe/\u7eaf\u6570\u5b57\u5267 ID\uff09');
                return;
            }
            var info = r.data || {};
            if (!info.count) { flash('\u89e3\u6790\u5230\u5267 ID ' + info.series_id + '\uff0c\u4f46\u672a\u53d6\u5230\u5267\u96c6\u4fe1\u606f'); }
            curSeries = info;
            if (info.name) flash('\u5df2\u89e3\u6790\uff1a' + info.name + '\uff08' + (info.count || 0) + ' \u96c6\uff09');
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
        focusSearchResult();   // 结果出来自动滚到视野
        saveUiState();
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
        try { saveUiState(); } catch (e) {}
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
    // 刷新列表但不自动聚焦（下载完成后刷新集的「已下载」状态时用，
    // 避免把用户的视线从正在看的播放器拽回上面的集数列表）
    function renderSeriesQuiet() {
        renderSeries({ noFocus: true });
    }

    function renderSeries(opt) {
        if (!curSeries) return;
        // 先给个即时反馈
        $('bgmSearchWrap').style.display = 'none';
        $('bgmSeriesWrap').style.display = '';
        $('bgmSeriesName').textContent = curSeries.name || curSeries.series_id;
        $('bgmSeriesCount').textContent = '共 ' + curSeries.count + ' 集';
        bindEpToolbar();
        var meta = $('bgmEpMeta');
        if (meta) meta.textContent = '正在读取本地已下载列表…';
        // 关键：等本地列表回来后再渲染剧集行
        refreshLocal().then(function () {
            try { renderSeriesNow(opt); } catch (e) { flash('渲染失败: ' + (e && e.message || e)); }
        }).catch(function () {
            try { renderSeriesNow(opt); } catch (e) {}
        });
    }

    function renderSeriesNow(opt) {
        var d = curSeries;
        if (!d) return;
        // 只有真正切换剧集时才自动聚焦；下载后刷新列表不聚焦（保留在播放器）
        if (!(opt && opt.noFocus)) focusSeries();
        saveUiState();
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
            var cached = !!getCached(ep);
            // 主按钮：扒这集/看结果（核心动作，primary 色）；重扒（有缓存时）
            var pickLabel = cached ? '看结果' : '扒这集';
            el.innerHTML =
                '<input type="checkbox" class="bgm-ep-cb" data-ep="' + ep + '" style="flex:0 0 auto;">' +
                '<span class="bgm-item-idx">' + ep + '</span>' +
                '<div class="bgm-item-main"><div class="bgm-item-name">第 ' + ep + ' 集</div>' +
                '<div class="bgm-item-sub">' + (local ? '✔ 已下载 ' + local.sizeMB + 'MB' : '未下载') + '</div></div>' +
                (local ? '<span class="bgm-item-act bgm-playnow">播放</span>' : '') +
                '<span class="bgm-item-act bgm-watch">' + (local ? '重下' : '下载') + '</span>' +
                (cached ? '<span class="bgm-item-act bgm-repick">重扒</span>' : '') +
                '<span class="bgm-item-act bgm-pick primary">' + pickLabel + '</span>' +
                (local ? '<span class="bgm-item-act bgm-more" title="更多操作">⋯</span>' : '');
            var pn = el.querySelector('.bgm-playnow');
            if (pn) pn.addEventListener('click', function (ev) { ev.stopPropagation(); playEpisode(ep, v); });
            el.querySelector('.bgm-watch').addEventListener('click', function (ev) {
                ev.stopPropagation(); downloadEpisode(v, ep);
            });
            var rp = el.querySelector('.bgm-repick');
            if (rp) rp.addEventListener('click', function (ev) {
                ev.stopPropagation(); rePickEpisode(v, ep);
            });
            el.querySelector('.bgm-pick').addEventListener('click', function (ev) {
                ev.stopPropagation(); pickEpisode(v, ep);
            });
            // 「⋯」：低频操作（导入PR / 插入时间线）收进小菜单
            var more = el.querySelector('.bgm-more');
            if (more) {
                more.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    toggleEpMore(ev, el, ep, local);
                });
            }
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
            more.innerHTML = '<div class="bgm-item-main"><div class="bgm-item-sub">… 其余 ' + (d.vid_list.length - 60) + ' 集请用「在线批量扒」处理</div></div>';
            box.appendChild(more);
        }
        var hint = $('bgmSeriesHint');
        if (hint) {
            hint.innerHTML = '勾选多集可「下载选中」；已下载的可拖进 PR；⋯ 里有导入 PR / 插入时间线';
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
        }, '\u7b2c ' + epNo + ' \u96c6\uff08\u81ea\u52a8\u4e0b\u8f7d\u540e\u626c\uff09');
    }

    // 强制重扒
    function rePickEpisode(vid, epNo) {
        if (!curSeries) return;
        delete resultCache[ckey(epNo)]; saveResults();
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
    // 结构：bgmMarks['剧号:集号'] = [{ name, artist, at, to, count }]
    var bgmMarks = {};
    try { bgmMarks = JSON.parse(localStorage.getItem('vh_bgm_marks') || '{}'); } catch (e) { bgmMarks = {}; }
    function saveMarks() { try { localStorage.setItem('vh_bgm_marks', JSON.stringify(bgmMarks)); } catch (e) {} }

    // 扒歌结果缓存：ep -> { songs, duration, windows, at }
    var resultCache = {};
    try {
        resultCache = JSON.parse(localStorage.getItem('vh_bgm_results') || '{}');
        // 迁移：旧格式 key 是纯数字集号（会跨剧串），只清结果缓存
        // 注意：不要清 bgmMarks —— 那是用户的进度条标记，清掉等于抹掉已扒的痕迹
        if (localStorage.getItem('vh_bgm_keyver') !== '4') {
            resultCache = {};
            localStorage.setItem('vh_bgm_keyver', '4');
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
        var marks = bgmMarks[ckey(ep)] || [];
        var sig = ep + '|' + (v.duration || 0) + '|' + marks.length;
        if (box.getAttribute('data-sig') === sig) return;   // 同签名不重建，避免闪烁
        box.setAttribute('data-sig', sig);
        if (!marks.length) {
            clearMarks();
            if (tip) tip.textContent = '\u8fd9\u96c6\u8fd8\u6ca1\u626c\u8fc7\uff1a\u70b9\u300c\u626c\u8fd9\u96c6\u300d\u626c\u5b8c\u540e\uff0c\u518d\u70b9\u8be5\u96c6\u64ad\u653e\uff0c\u8fdb\u5ea6\u6761\u4e0a\u5c31\u4f1a\u51fa\u73b0 BGM \u8272\u5757';
            return;
        }
        var dur = v.duration || 0;
        if (!dur) {
            // 播放器还没拿到时长（未打开/未加载）：有限重试，避免无限空转
            var tries = parseInt(box.getAttribute('data-wait') || '0', 10);
            if (tries < 12) {
                box.setAttribute('data-wait', String(tries + 1));
                setTimeout(function () { drawMarkers(ep); }, 600);
            }
            return;
        }
        box.removeAttribute('data-wait');
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


    // ---------- 选集浮层 ----------
    // 在播放器内直接选集，不必把视线拉回上面的集数列表。
    function toggleEpPicker() {
        var pk = $('bgmEpPicker');
        if (!pk) return;
        if (pk.style.display === 'none' || !pk.style.display) {
            renderEpPicker();
            pk.style.display = '';
        } else {
            pk.style.display = 'none';
        }
    }

    function renderEpPicker() {
        var grid = $('bgmEpPickerGrid');
        if (!grid) return;
        var vids = (curSeries && curSeries.vid_list) || [];
        grid.innerHTML = '';
        for (var i = 1; i <= vids.length; i++) {
            var b = document.createElement('div');
            b.className = 'bgm-eppick-item';
            if (localMap[i]) b.className += ' is-local';
            if (i === playEp) b.className += ' is-cur';
            b.textContent = String(i);
            b.title = '第 ' + i + ' 集' + (localMap[i] ? '（已下载）' : '（未下载，点击后自动下载）');
            (function (ep) {
                b.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    var pk = $('bgmEpPicker');
                    if (pk) pk.style.display = 'none';
                    jumpToEp(ep);
                });
            })(i);
            // 直接 append（不用 fragment：避免依赖 fragment 展开行为，也便于测试）
            grid.appendChild(b);
        }
        // 把当前集滚到可见
        var curEl = null;
        for (var k = 0; k < grid.children.length; k++) {
            if (grid.children[k].className && grid.children[k].className.indexOf('is-cur') >= 0) { curEl = grid.children[k]; break; }
        }
        if (curEl && curEl.scrollIntoView) {
            try { curEl.scrollIntoView({ block: 'nearest' }); } catch (e) {}
        }
    }

    // ---------- 进度条上的 BGM 色块 ----------
    // 进度条本身负责播放进度（更新在 updateBarFill）；
    // 这里负责把 BGM 区间按真实起止画上去，并将当前播放的那首高亮。
    // 函数名沿用 drawEpTimeline / syncEpTimelineCurrent，调用点无需改。
    var epTlMarks = [];      // 当前进度条对应的 marks
    var epTlCurId = null;    // 当前高亮的歌曲 id

    function drawEpTimeline(ep) {
        var wrap = $('bgmProgWrap');
        var box = $('bgmMarkerBar');
        var tip = $('bgmMarkerTip');
        var v = $('bgmV');
        if (!wrap || !box || !v) return;
        var marks = bgmMarks[ckey(ep)] || [];
        epTlMarks = marks;
        if (!marks.length) {
            // 没扒过：进度条仍显示（纯进度），只是没有色块
            wrap.style.display = '';
            box.innerHTML = '';
            epTlCurId = null;
            if (tip) tip.textContent = '';
            return;
        }
        var dur = v.duration || 0;
        if (!dur) {
            // 时长未知（还没 loadedmetadata）：有限重试
            var tries = parseInt(wrap.getAttribute('data-wait') || '0', 10);
            if (tries < 12) {
                wrap.setAttribute('data-wait', String(tries + 1));
                setTimeout(function () { drawEpTimeline(ep); }, 600);
            }
            return;
        }
        wrap.removeAttribute('data-wait');
        wrap.style.display = '';
        // 关键：重建色块后必须重置高亮缓存，否则新色块永远拿不到 is-current
        epTlCurId = null;
        var sorted = marks.slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
        box.innerHTML = '';
        sorted.forEach(function (m) {
            var c = songColor(m.id);
            var left = Math.min(100, Math.max(0, ((m.at || 0) / dur) * 100));
            var w = Math.max(0.8, (((m.to == null ? m.at : m.to) - (m.at || 0)) / dur) * 100);
            if (left + w > 100) w = Math.max(0.8, 100 - left);
            var el = document.createElement('div');
            el.className = 'bgm-mark';
            el.setAttribute('data-id', String(m.id));
            el.style.left = left + '%';
            el.style.width = w + '%';
            el.style.top = '0';
            el.style.bottom = '0';
            el.style.background = c;
            el.style.opacity = '.85';
            el.title = (m.name || '') + ' — ' + (m.artist || '') +
                '  (' + (m.at || 0) + '~' + (m.to || 0) + 's)  点击跳转';
            el.addEventListener('click', function (ev) {
                ev.stopPropagation();   // 不让点击冒泡成"跳转进度"
                try { v.currentTime = m.at || 0; v.play().catch(function () {}); } catch (e) {}
                highlightSong(m.id, true);
            });
            box.appendChild(el);
        });
        if (tip) tip.textContent = '本集命中 ' + marks.length + ' 首 BGM（色块点击跳转）';
        syncEpTimelineCurrent();
    }

    // 根据当前播放时间，高亮所在的那首（放在进度条色块上）
    function syncEpTimelineCurrent() {
        var box = $('bgmMarkerBar');
        if (!box || !epTlMarks.length) return;
        var v = $('bgmV');
        var t = v ? (v.currentTime || 0) : 0;
        var TOL = 1.5;   // 区间缝隙容差（秒），双向，避免高亮闪烁
        var cur = null, bestDist = Infinity;
        for (var i = 0; i < epTlMarks.length; i++) {
            var m = epTlMarks[i];
            var a = m.at || 0, b = (m.to == null ? m.at : m.to) || 0;
            if (t >= a && t <= b) { cur = m; break; }
            var d = (t < a) ? (a - t) : (t - b);
            if (d <= TOL && d < bestDist) { bestDist = d; cur = m; }
        }
        var id = cur ? String(cur.id) : null;
        if (id === epTlCurId) return;   // 无变化不重绘
        epTlCurId = id;
        var chips = box.children;
        for (var k = 0; k < chips.length; k++) {
            var on = chips[k].getAttribute('data-id') === id;
            chips[k].classList.toggle('is-current', on);
        }
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
                localMap[ep] = { path: f.path, name: f.name, sizeMB: (f.size / 1048576).toFixed(1), hasH264: !!f.hasH264 };
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
            // 未下载：立刻在播放器画面区亮遮罩（以前只有 2.2 秒的 flash 浮字，
            // 且进度条在面板底部，视线焦点处是黑屏，用户感觉不到反馈）
            showPlayer();
            bufEp = ep;   // 标记：用户正在等这一集
            bufShow('正在下载第 ' + ep + ' 集', { pct: 0, sub: '下载完成后将自动播放', cancellable: true });
            downloadEpisode(vid, ep, true);
            return;
        }
        playLocal(ep);
    }

    // ============ 就绪前遮罩 ============
    // 点播后立刻可见，覆盖四种状态：下载中 / 转码中 / 准备播放 / 失败。
    // 目的：任何等待与失败都在用户视线焦点（画面区）有明确反馈，
    //       不再依赖一闪而过的 flash 浮字，也不出现无声黑屏。
    var bufTimer = null;      // 长时间无 canplay 的兜底计时
    var bufEp = 0;            // 当前遮罩对应的集号

    function bufShow(msg, opt) {
        opt = opt || {};
        var el = $('bgmBuf');
        if (!el) return;
        el.style.display = '';
        el.classList.toggle('is-error', !!opt.error);
        var m = $('bgmBufMsg');
        if (m) m.textContent = msg;
        var wrap = $('bgmBufBarWrap');
        var fill = $('bgmBufFill');
        if (opt.pct === undefined || opt.pct === null) {
            if (wrap) wrap.style.display = 'none';
        } else {
            if (wrap) wrap.style.display = '';
            if (fill) fill.style.width = Math.max(0, Math.min(100, opt.pct)) + '%';
        }
        var sub = $('bgmBufSub');
        if (sub) sub.textContent = opt.sub || '';
        var c = $('bgmBufCancel');
        if (c) c.style.display = opt.cancellable ? '' : 'none';
    }

    function bufHide() {
        var el = $('bgmBuf');
        if (el) el.style.display = 'none';
        if (bufTimer) { clearTimeout(bufTimer); bufTimer = null; }
        bufEp = 0;
    }

    // 播放器容器显示出来（遮罩要盖在它上面）
    function showPlayer() {
        var wrap = $('bgmPlayerWrap');
        if (wrap) wrap.style.display = '';
        var bar = $('bgmBar');
        if (bar) bar.style.display = '';
    }

    // 等 video 真的可播（canplay）才算就绪；超时无响应给提示，避免无声黑屏。
    // 关键：以前是 v.load(); v.play().catch(function(){}) —— 错误被吞掉，
    // 文件损坏/解码失败全是静默黑屏，用户只看到卡住。
    function waitCanPlay(v, ep, onReady) {
        var settled = false;
        function done(ok, msg) {
            if (settled) return;
            settled = true;
            v.removeEventListener('canplay', onCan);
            v.removeEventListener('error', onErr);
            if (bufTimer) { clearTimeout(bufTimer); bufTimer = null; }
            if (!ok) { bufShow(msg, { error: true }); }
            else { bufHide(); onReady && onReady(); }
        }
        function onCan() { done(true); }
        function onErr() {
            var e = v.error;
            var reason = e ? (e.code === 4 ? '格式不支持' : (e.message || ('错误 ' + e.code))) : '未知错误';
            done(false, '播放失败：' + reason);
        }
        v.addEventListener('canplay', onCan);
        v.addEventListener('error', onErr);
        // 兜底：12 秒仍未 canplay 也没 error，说明加载卡住 —— 给可见提示，不静默等待
        if (bufTimer) clearTimeout(bufTimer);
        bufTimer = setTimeout(function () {
            done(false, '加载超时，这集可能损坏。可重试或重新下载。');
        }, 12000);
        bufEp = ep;
    }

    // 「转码中」集合：按集号记录，杜绝重复触发（error 事件与播放前探测可能同时命中）
    var transcodePending = {};

    // 请求转码（带全局守卫），完成后回调
    function requestTranscode(ep, loc, onDone) {
        if (!loc) return;
        if (transcodePending[ep]) return;      // 已经在转，忽略重复请求
        transcodePending[ep] = true;
        showProgress('转码');
        // 画面区遮罩：转码阶段有明确反馈（原先只有一闪而过的 flash）
        bufShow('正在转码（HEVC → H.264）', { pct: 0, sub: '第 ' + ep + ' 集 · 转码后自动播放' });
        post('/transcode', { file: loc.path }, 60000).then(function (r) {
            if (r && r.code === 0) {
                curJobId = r.data.jobId;
                pollTranscode(r.data.jobId, ep, onDone);
            } else {
                delete transcodePending[ep];
                hideProgress();
                bufShow('转码启动失败：' + (r.msg || ''), { error: true });
            }
        }).catch(function (e) {
            delete transcodePending[ep];
            hideProgress();
            bufShow('转码失败：' + e.message, { error: true });
        });
    }

    // 播放前转码：无 H.264 版时先转，转完自动接续播放
    // 期间在画面区显示遮罩（用户点播后立即有反馈，不再是黑屏）
    function startTranscodeFor(ep, loc, startAtPos, noAutoPlay) {
        if (!loc) return;
        bufShow('正在检查视频格式…', { pct: null, sub: '第 ' + ep + ' 集' });
        api('/probe-codec?file=' + encodeURIComponent(loc.path), { timeout: 30000 }).then(function (r) {
            var codec = ((r.data || {}).codec || '').toLowerCase();
            if (codec === 'h264' || codec === 'avc1') {
                loc.hasH264 = true;
                playLocal(ep, startAtPos, noAutoPlay);   // 已是 H.264，走完整播放逻辑
                return;
            }
            requestTranscode(ep, loc, function () { playLocal(ep, startAtPos, noAutoPlay); });
        }).catch(function () {
            // 探测失败：保守起见直接转码
            requestTranscode(ep, loc, function () { playLocal(ep, startAtPos, noAutoPlay); });
        });
    }

    // 恢复现场：打开播放器、定位到上次进度。
    //   autoPlay=true  —— 点播放历史「继续」：跳过去就接着放
    //   autoPlay=false —— 重开面板恢复上次现场：只定位不开播（避免一开面板就出声）
    function resumeInto(ep, pos, autoPlay) {
        try { playLocal(ep, pos || 0, !autoPlay); } catch (e) {}
    }

    // playLocal(ep, startAtPos, noAutoPlay)
    //   startAtPos : 就绪后跳到该秒数（用于恢复上次播放进度）
    //   noAutoPlay : true 时不自动播放（恢复现场时只定位不开播）
    function playLocal(ep, startAtPos, noAutoPlay) {
        var loc = localMap[ep];
        if (!loc) { flash('第 ' + ep + ' 集本地文件不存在'); return; }
        showPlayer();
        if (miniMode) applyMini(true);
        playEp = ep;
        $('bgmPlayerTitle').textContent = (curSeries && curSeries.name ? curSeries.name + ' ' : '') + '第 ' + ep + ' 集';
        var v = $('bgmV');
        if (!v) return;
        songMode = false;
        if (inlineAudio) { try { inlineAudio.pause(); } catch (e) {} }
        v.dataset.ep = String(ep);
        // 播放前先确保有 H.264 版：HEVC 原文件在 CEP 里会直接报错/黑屏。
        if (loc.hasH264) {
            v.src = API + '/video?prefer=h264&t=' + Date.now() + '&file=' + encodeURIComponent(loc.path);
        } else {
            // 需要转码：转完再进（把目标位置一并带过去）
            startTranscodeFor(ep, loc, startAtPos, noAutoPlay);
            return;
        }
        // 切换集时收起选集浮层
        var pk0 = $('bgmEpPicker');
        if (pk0) pk0.style.display = 'none';
        bufShow('正在准备播放…', { pct: null, sub: loc.name });
        // 切集时先清掉上一集的位置（避免上一集的位置污染本集）
        if (!startAtPos) lastPlayPos = 0;
        // 先挂 canplay/error 监听，再 load；就绪后才真正 play。
        // 以前是 load+play 一把梭、错误被 catch 吞掉，损坏文件就是静默黑屏。
        waitCanPlay(v, ep, function () {
            // 恢复现场：先定位到上次位置，不自动播
            if (startAtPos && startAtPos > 1) {
                try { v.currentTime = startAtPos; } catch (e) {}
                lastPlayPos = startAtPos;
            } else {
                lastPlayPos = 0;
            }
            if (!noAutoPlay) {
                try { v.play().catch(function () {}); } catch (e) {}
            } else {
                syncBar();
            }
            // 记一条播放历史（真正开始播才算）
            try {
                addPlayHist({
                    series_id: curSeries && curSeries.series_id,
                    name: curSeries && curSeries.name,
                    cover: curSeries && (curSeries.cover || curSeries.cover_url || curSeries.pic),
                    count: curSeries && curSeries.count,
                    ep: ep,
                    pos: startAtPos || 0,
                    dur: v.duration || 0,
                });
            } catch (e) {}
            // 本集就绪后，静默预加载下一集（不影响当前播放）
            setTimeout(preloadNext, 800);
            saveUiState();
        });
        try { v.load(); } catch (e) {}
        drawMarkers(ep);
        drawEpTimeline(ep);
        // 进度条一旦有集在播就显示（没扒过也有纯进度）
        var pw2 = $('bgmProgWrap');
        if (pw2) pw2.style.display = '';
        // 该集有缓存 → 显示结果；无缓存 → 清空旧结果，避免残留上一集的内容
        var shown = renderEpisodeSongList(ep);
        if (!shown) clearResultArea();
        syncBar();
        focusPlayer();
        updateRipBtn(ep);
        var info = $('bgmPlayerInfo');
        if (info) info.textContent = loc.name + '  ' + loc.sizeMB + 'MB';
        try { localStorage.setItem('vh_bgm_last_ep', String(ep)); } catch (e) {}
    }

    // 清空识别结果区（切换集时避免残留上一集内容）
    function clearResultArea() {
        var wrap = $('bgmResultWrap'), box = $('bgmResultList'), title = $('bgmResultTitle');
        if (box) box.innerHTML = '';
        if (title) title.textContent = '识别结果 · 本集还没扒';
        // 保留结果区可见，但内容清空（不隐藏，避免布局跳动）
        if (wrap) wrap.style.display = '';
    }

    // 更新播放器内「扒此集」按钮：按当前集缓存状态变文字
    function updateRipBtn(ep) {
        var b = $('btnBgmRipThis');
        if (!b) return;
        var cached = !!getCached(ep);
        if (cached) {
            b.textContent = '✓ 已扒 · 看结果';
            b.classList.add('done');
        } else {
            b.textContent = '🎵 扒此集';
            b.classList.remove('done');
        }
    }

    // HEVC 黑屏兜底：检测到"有进度但无画面"则提示转码
    function wireHevcFallback() {
        var v = $('bgmV');
        if (!v) return;
        v.addEventListener('playing', function () {
            // 判据用 videoWidth：解不出画面时它是 0（HEVC 黑屏的典型特征）。
            // 原来用 currentTime 判断是错的 —— 黑屏时音频照常播、时间照常走，永不触发。
            var ep = v.dataset.ep;
            var tries = 0;
            var chk = function () {
                tries++;
                if (v.paused || !ep) return;
                if (v.videoWidth > 0) return;            // 有画面，正常
                if (tries < 4) { setTimeout(chk, 700); return; }
                // 确认黑屏：自动转码并接续播放（统一走守卫，防重复）
                var loc = localMap[ep];
                if (loc) requestTranscode(ep, loc, function () { playLocal(ep); });
            };
            setTimeout(chk, 1200);
        });
        // 播放报错：多为编码不支持（HEVC）。自动转码，转完接续播放
        v.addEventListener('error', function () {
            var ep = v.dataset.ep;
            if (!ep) return;
            var loc = localMap[ep];
            if (!loc) return;
            requestTranscode(ep, loc, function () { playLocal(ep); });
        });
    }

    function playNav(delta) {
        if (!curSeries || !playEp) return;
        var ep = playEp + delta;
        if (ep < 1 || ep > (curSeries.vid_list || []).length) { flash('已经到头了'); return; }
        jumpToEp(ep);
    }

    // 跳到某集：已下载直接播，未下载先下载（画面区亮遮罩，与点列表保持一致）
    function jumpToEp(ep) {
        if (!curSeries) return;
        var vids = curSeries.vid_list || [];
        if (ep < 1 || ep > vids.length) return;
        var vid = vids[ep - 1];
        if (localMap[ep]) { playLocal(ep); return; }
        showPlayer();
        bufEp = ep;
        bufShow('正在下载第 ' + ep + ' 集', { pct: 0, sub: '下载完成后将自动播放', cancellable: true });
        downloadEpisode(vid, ep, true);
    }

    // ---------- 预加载下一集 ----------
    // 当前集就绪后，静默把下一集下载好（不自动播放）。
    // 注意：只预下载、不预转码 —— 预转码会与用户可能立即的播放争抢 CPU，
    // 且转码很快（实测约 2s），播时再转完全来得及。
    var preloadEp = 0;
    function preloadNext() {
        if (!curSeries || !playEp) return;
        var vids = curSeries.vid_list || [];
        var next = playEp + 1;
        if (next < 1 || next > vids.length) return;
        if (localMap[next]) return;          // 已有，不重复
        if (preloadEp === next) return;      // 已在预加载中
        if (pendingAutoPlay) return;         // 用户点播正在下载，不抢
        preloadEp = next;
        try {
            post('/download', {
                series_id: curSeries.series_id, vid: vids[next - 1],
                name: curSeries.name, ep: next,
            }, 60000).then(function () {
                preloadEp = 0;
                refreshLocal();   // 静默刷新本地列表（不聚焦）
            }).catch(function () { preloadEp = 0; });
        } catch (e) { preloadEp = 0; }
    }

    function closePlayer() {
        var wrap = $('bgmPlayerWrap');
        if (wrap) wrap.style.display = 'none';
        bufHide();   // 遮罩一并收起
        pendingAutoPlay = 0;
        // 浮层也收起，避免下次打开时残留
        var pk = $('bgmEpPicker');
        if (pk) pk.style.display = 'none';
        var v = $('bgmV');
        if (v) { try { v.pause(); } catch (e) {} v.removeAttribute('src'); try { v.load(); } catch (e) {} }
        playEp = 0;
        // 关播放器 = 明确退出播放状态：位置清掉，playerOpen 置 false，
        // 下次打开面板就不再弹回播放器（尊重用户的“关闭”意图）
        lastPlayPos = 0;
        saveUiState();
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
    // 记录用户最近是否「真的滚动」过（避免自动聚焦打断浏览）
    // 注意：不能用 mousedown —— 点击搜索/解析按钮也会触发，会把聚焦拦掉
    var lastUserScrollAt = 0;
    var lastScrollY = 0;
    (function () {
        var mark = function () { lastUserScrollAt = Date.now(); };
        // 滚轮 / 触摸拖动 = 明确的滚动意图，直接标记
        ['wheel', 'touchmove'].forEach(function (ev) {
            window.addEventListener(ev, mark, { passive: true });
        });
        window.addEventListener('keydown', function (e) {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].indexOf(e.key) >= 0) mark();
        });
        // 拖动滚动条等：只在「滚动位置真的变化」时才算用户滚动
        lastScrollY = window.pageYOffset || 0;
        window.addEventListener('scroll', function () {
            var y = window.pageYOffset || 0;
            if (Math.abs(y - lastScrollY) > 2) {
                lastScrollY = y;
                mark();
            }
        }, { passive: true });
    })();

    // 通用：把某个元素平滑滚到视野中心（留出舒适边距）
    function focusEl(el, opt) {
        if (!el) return;
        if (miniMode) return;                 // 小窗固定定位，不滚
        opt = opt || {};
        // 用户 1.2 秒内刚手动滚过 → 不打扰（用户主动滚动优先）
        if (Date.now() - lastUserScrollAt < 1200) return;
        try {
            var rect = el.getBoundingClientRect();
            var vh = window.innerHeight || document.documentElement.clientHeight;
            var bias = opt.bias == null ? 0.5 : opt.bias;   // 0=顶部,0.5=居中
            // 吸顶导航（顶栏/分组栏/子标签）会盖住页面顶部，聚焦时须避让，
            // 否则元素被滚到 sticky 栏背后，看起来"没聚焦 / 滚过头"
            var occl = 0;
            try {
                ['top-head', 'ws-groups'].forEach(function (c) {
                    var n = document.querySelector('.' + c);
                    if (n && n.offsetParent !== null) occl += n.offsetHeight;
                });
                // 子标签有多个（每工作台一组），只算当前可见的
                document.querySelectorAll('.ws-subtabs').forEach(function (n) {
                    if (n.offsetParent !== null) occl += n.offsetHeight;
                });
            } catch (e) {}
            var top = rect.top + window.pageYOffset - Math.max(0, (vh - rect.height) * bias) - occl;
            if (opt.maxTop != null) top = Math.min(top, opt.maxTop);
            window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
            // 程序滚动不算用户滚动：延迟同步基准值与时间戳
            setTimeout(function () {
                lastScrollY = window.pageYOffset || 0;
                lastUserScrollAt = 0;
            }, 500);
        } catch (e) {
            try { el.scrollIntoView({ behavior: 'smooth', block: opt.block || 'center' }); } catch (e2) {}
        }
    }

    function focusPlayer() {
        var v = $('bgmV') || $('bgmPlayerWrap');
        if (!v) return;
        // 播放区较高，稍微偏上一点更舒服
        focusEl(v, { bias: 0.35 });
    }

    // 搜索结果／剧集页出现后聚焦
    function focusSearchResult() {
        var w = $('bgmSearchWrap');
        if (!w || w.style.display === 'none') return;
        focusEl(w, { bias: 0.12 });
    }

    function focusSeries() {
        var w = $('bgmSeriesWrap');
        if (!w || w.style.display === 'none') return;
        focusEl(w, { bias: 0.1 });
    }


    // ---------- 实时叠加：当前进度落在哪首 BGM 上 ----------
    var lastOverlayId = null;
    function tickOverlay() {
        var v = $('bgmV');
        if (!v || !playEp) return;
        var marks = bgmMarks[ckey(playEp)] || [];
        var box = $('bgmNowSong');
        if (!box) return;
        if (!marks.length) {
            // 没扒过：确保气泡收起
            if (lastOverlayId !== null) { lastOverlayId = null; box.classList.remove('is-in'); }
            return;
        }
        var t = v.currentTime || 0;
        var cur = null;
        for (var i = 0; i < marks.length; i++) {
            var m = marks[i];
            if (t >= m.at && t <= m.to) { cur = m; break; }
        }
        var newId = cur ? String(cur.id) : null;
        if (newId === lastOverlayId) return;    // 没变就不碰 DOM，避免每帧重绘闪烁
        lastOverlayId = newId;
        if (cur) {
            // 定位到该曲在进度条上的起点，气泡从那里滑出
            var dur = v.duration || 0;
            var pct = dur ? Math.min(100, Math.max(0, (cur.at / dur) * 100)) : 0;
            // 靠右时改成右对齐，避免气泡超出容器
            var rightSide = pct > 60;
            box.style.left = rightSide ? 'auto' : pct + '%';
            box.style.right = rightSide ? '0' : 'auto';
            box.style.borderLeftColor = songColor(cur.id);
            // 组装内容（先清空，避免重复叠加）
            box.textContent = '';
            var b = document.createElement('b');
            b.textContent = '♫ ' + (cur.name || '');
            box.appendChild(b);
            if (cur.artist) {
                var art = document.createElement('span');
                art.className = 'bgm-nsbub-art';
                art.textContent = ' — ' + cur.artist;
                box.appendChild(art);
            }
            // 入场：下一帧加类，触发 transition（先归位再展开，保证动画每次都播）
            box.classList.remove('is-in');
            void box.offsetWidth;   // 强制重排，让浏览器识别状态变化
            box.classList.add('is-in');
            highlightSong(cur.id, false);   // 高亮但不滚动（滚动会抖）
        } else {
            // 播完：收回
            box.classList.remove('is-in');
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
        var pb = $('btnBgmBarPlay');
        if (pb) pb.textContent = v.paused ? '\u25b6' : '\u23f8';
        var cur = $('bgmBarCur');
        if (cur) cur.textContent = fmtTime(v.currentTime || 0);
        // 新进度条（画面下方，带 BGM 色块）的时间标签
        var pc = $('bgmPbarCur'), pd = $('bgmPbarDur');
        if (pc) pc.textContent = fmtTime(v.currentTime || 0);
        if (pd) pd.textContent = fmtTime(v.duration || 0);
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
        var pct = 0;
        if (m && m.duration) pct = Math.min(100, (m.currentTime / m.duration) * 100);
        // 新进度条（画面下方那条，带 BGM 色块）
        var pf = $('bgmPbarFill');
        if (pf) pf.style.width = pct + '%';
        var pk = $('bgmPbarKnob');
        if (pk) pk.style.left = pct + '%';
    }

    // 歌曲模式的底部条
    function syncSongBar() {
        var bar = $('bgmBar');
        if (!bar) return;
        bar.style.display = '';
        var pb = $('btnBgmBarPlay');
        if (pb && inlineAudio) pb.textContent = inlineAudio.paused ? '\u25b6' : '\u23f8';
        var cur = $('bgmBarCur'), pcur = $('bgmPbarCur'), pdur = $('bgmPbarDur');
        if (cur && inlineAudio) cur.textContent = fmtTime(inlineAudio.currentTime || 0);
        if (pcur && inlineAudio) pcur.textContent = fmtTime(inlineAudio.currentTime || 0);
        if (pdur && inlineAudio) pdur.textContent = fmtTime(inlineAudio.duration || 0);
        updateBarFill();
    }

    function bindSongBar() {
        if (!inlineAudio) return;
        if (inlineAudio.__bound) return;
        inlineAudio.__bound = true;
        inlineAudio.addEventListener('timeupdate', function () {
            if (!songMode) return;
            var cur = $('bgmBarCur'), pcur = $('bgmPbarCur');
            if (cur) cur.textContent = fmtTime(inlineAudio.currentTime || 0);
            if (pcur) pcur.textContent = fmtTime(inlineAudio.currentTime || 0);
            updateBarFill();
            try { syncEpTimelineCurrent(); } catch (e) {}
        });
        inlineAudio.addEventListener('loadedmetadata', function () {
            if (!songMode) return;
            var pdur = $('bgmPbarDur');
            if (pdur) pdur.textContent = fmtTime(inlineAudio.duration || 0);
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
            // 进度条时间标签
            var pcur = $('bgmPbarCur');
            if (pcur && !songMode) pcur.textContent = fmtTime(v.currentTime || 0);
            if (!songMode) updateBarFill();
            tickOverlay();
            // 同步视频上 BGM 时间轴的「当前高亮」
            if (!songMode) syncEpTimelineCurrent();
            // 记住播放位置（内存里每帧更新；写盘节流到每 3 秒一次）
            if (!songMode) {
                lastPlayPos = v.currentTime || 0;
                var now = Date.now();
                if (now - lastPosSaveAt > 3000) {
                    lastPosSaveAt = now;
                    saveUiState();
                    // 同步刷新播放历史里的进度（节流，避免频繁写 localStorage）
                    try { updatePlayHistPos(playEp, lastPlayPos, v.duration || 0); } catch (e) {}
                    // 诊断（临时）：记录历史写入现场，便于排查"进度没生效"
                    try {
                        if (window.__vhLog && window.__vhLog.info) {
                            var _h = loadPlayHist();
                            var _hit = null;
                            for (var _i = 0; _i < _h.length; _i++) {
                                if (String(_h[_i].series_id) === String(curSeries && curSeries.series_id)) { _hit = _h[_i]; break; }
                            }
                            window.__vhLog.info('[bgm-hist] 写入 pos=' + Math.round(lastPlayPos) +
                                ' ep=' + playEp + ' dur=' + Math.round(v.duration || 0) +
                                ' songMode=' + songMode +
                                ' 历史条数=' + _h.length +
                                ' 命中=' + (_hit ? ('ep' + _hit.ep + '/pos' + Math.round(_hit.pos) + '/dur' + Math.round(_hit.dur)) : '未命中'));
                        }
                    } catch (e) {}
                }
            }
        });
        v.addEventListener('loadedmetadata', function () {
            var pdur = $('bgmPbarDur');
            if (pdur) pdur.textContent = fmtTime(v.duration || 0);
            // 时长已知 → 进度条可见
            var pw = $('bgmProgWrap');
            if (pw) pw.style.display = '';
            // 该集若已扒过，进度条色块按真实时长重画
            drawMarkers(playEp);
            drawEpTimeline(playEp);   // 视频上也按真实时长重画
        });
        // 就绪：遮罩收起后再画一次（此时时长已准确）
        v.addEventListener('canplay', function () {
            drawEpTimeline(playEp);
        });
        v.addEventListener('play', syncBar);
        v.addEventListener('pause', function () {
            syncBar();
            // 暂停是“告一段落”的可靠时机：立即把进度写入播放历史，
            // 不依赖 3 秒节流（否则刚看几秒就暂停会没记录）
            try {
                if (!songMode && playEp) {
                    lastPlayPos = v.currentTime || 0;
                    updatePlayHistPos(playEp, lastPlayPos, v.duration || 0);
                }
            } catch (e) {}
        });
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

    // 「⋯」小菜单：收起低频操作（导入PR / 插入时间线），点外部自动关闭
    function toggleEpMore(ev, rowEl, ep, loc) {
        var old = document.querySelector('#bgmEpMoreMenu');
        if (old) old.remove();
        var menu = document.createElement('div');
        menu.id = 'bgmEpMoreMenu';
        menu.className = 'bgm-ep-more';
        menu.innerHTML =
            '<div class="bgm-more-item" data-act="pr">导入 PR 素材库</div>' +
            '<div class="bgm-more-item" data-act="tl">插入到时间线播放头</div>';
        var rect = rowEl.getBoundingClientRect();
        var host = rowEl.closest('.bgm-list') || rowEl.parentElement;
        // 挂在列表容器内，绝对定位到当前行右侧
        host.appendChild(menu);
        menu.style.top = (rowEl.offsetTop) + 'px';
        menu.style.right = '8px';
        menu.addEventListener('click', function (e2) {
            var act = (e2.target && e2.target.getAttribute && e2.target.getAttribute('data-act'));
            menu.remove();
            if (!act) return;
            if (act === 'pr') {
                importFilesToPR([loc.path], (curSeries && curSeries.name) || '短剧');
            } else if (act === 'tl') {
                insertToTimeline(loc.path);
            }
        });
        // 点别处关闭
        setTimeout(function () {
            var closer = function (e3) {
                var m = $('bgmEpMoreMenu');
                if (m && !m.contains(e3.target)) { m.remove(); document.removeEventListener('click', closer); }
            };
            document.addEventListener('click', closer);
        }, 0);
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

    // ---------- 听歌识曲（复用网易云板块的录音脚本 + ncm 识别）----------
    var idActive = false, idStop = false, idRound = 0;
    var idWav = null;

    function identifyServer() { return 'http://127.0.0.1:17890'; }

    function findIdentifyPython() {
        var os2 = require('os');
        var cands = [
            path.join(extRoot, 'runtime', 'python.exe'),
            path.join(os2.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
            path.join(os2.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe')
        ];
        for (var i = 0; i < cands.length; i++) {
            if (fs.existsSync(cands[i])) return cands[i];
        }
        return 'python';
    }

    function setIdProg(html) {
        var el = $('bgmIdentifyProgress');
        if (el) el.innerHTML = html;
    }

    function dropIdWav() {
        try { if (idWav && fs.existsSync(idWav)) fs.unlinkSync(idWav); } catch (e) {}
        idWav = null;
    }

    function openIdentifyPanel() {
        var p = $('bgmIdentifyPanel');
        if (p) p.style.display = '';
    }
    function closeIdentifyPanel() {
        var p = $('bgmIdentifyPanel');
        if (p) p.style.display = 'none';
    }

    function doBgmIdentify() {
        if (idActive) return;
        var btn = $('bgmIdentifyFab');
        if (btn) { btn.disabled = true; btn.textContent = '🎧…'; }
        openIdentifyPanel();
        var stopBtn = $('btnBgmIdentifyStop');
        if (stopBtn) stopBtn.style.display = '';
        var box = $('bgmIdentifyResult');
        if (box) box.style.display = 'none';

        idActive = true; idStop = false; idRound = 0;

        var py = findIdentifyPython();
        var scriptPath = path.join(extRoot, 'py', 'identify_record.py');
        var tmpdir = require('os').tmpdir();

        function finish() {
            idActive = false; idStop = false;
            dropIdWav();
            var b2 = $('bgmIdentifyFab');
            if (b2) { b2.disabled = false; b2.textContent = '🎧'; }
            var s2 = $('btnBgmIdentifyStop');
            if (s2) s2.style.display = 'none';
        }

        function round() {
            if (idStop || !idActive) { finish(); return; }
            dropIdWav();
            idRound++;
            setIdProg('<span style="color:var(--fg-info);">🎙 第 ' + idRound + ' 轮录音中（6 秒）…</span>');
            var wavPath = path.join(tmpdir, 'vh_bgm_id_' + Date.now() + '.wav');
            idWav = wavPath;
            childProcess.execFile(py, [scriptPath, wavPath, '6'], { encoding: 'utf8', timeout: 20000 }, function (err, stdout) {
                if (idStop || !idActive) { finish(); return; }
                var rec = null;
                try { rec = JSON.parse((stdout || '').trim().split('\n').pop()); } catch (e) {}
                if (err || !rec || !rec.ok) {
                    idActive = false; finish();
                    var diag = (rec && rec.allOutputDevices) ? ('<div style="font-size:10.5px;color:var(--muted);margin-top:4px;">输出设备：' + esc(rec.allOutputDevices.join(' / ')) + '</div>') : '';
                    setIdProg('<span style="color:var(--fg-err-soft);">录音失败：' + esc((rec && rec.error) || (err && err.message) || '未知') + '</span>' + diag);
                    return;
                }
                if (rec.silent) {
                    setIdProg('<span style="color:var(--fg-warn-soft);">第 ' + idRound + ' 轮没听到声音，继续…</span>');
                    round();
                    return;
                }
                setIdProg('<span style="color:var(--fg-info);">🔍 第 ' + idRound + ' 轮识别中…</span>');
                var xhr = new XMLHttpRequest();
                xhr.open('POST', identifyServer() + '/identify', true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.timeout = 20000;
                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;
                    if (idStop || !idActive) { finish(); return; }
                    try {
                        var j = JSON.parse(xhr.responseText);
                        var data = j.data || {};
                        var results = data.result || [];
                        if (results.length > 0 && results[0].song) {
                            idActive = false;
                            renderIdentifyHits(results);
                            finish();
                        } else {
                            setIdProg('<span style="color:var(--fg-warn-soft);">第 ' + idRound + ' 轮没识别出，继续下一轮…</span>');
                            round();
                        }
                    } catch (e) {
                        idActive = false; finish();
                        setIdProg('<span style="color:var(--fg-err-soft);">识别出错：' + esc(e.message) + '</span>');
                    }
                };
                xhr.onerror = function () {
                    if (!idStop && idActive) {
                        setIdProg('<span style="color:var(--fg-err-soft);">无法连接识曲服务（请先打开「网易云」板块，它会自动启动本地服务）</span>');
                        finish();
                    }
                };
                xhr.ontimeout = function () { if (!idStop && idActive) round(); };
                xhr.send(JSON.stringify({ wavPath: wavPath }));
            });
        }
        round();
    }

    function stopBgmIdentify() {
        idStop = true; idActive = false;
        var b = $('bgmIdentifyFab');
        if (b) { b.disabled = false; b.textContent = '🎧'; }
        var s = $('btnBgmIdentifyStop');
        if (s) s.style.display = 'none';
        setIdProg('<span style="color:var(--muted);">已停止</span>');
        dropIdWav();
    }

    // 识曲结果：直接复用扒歌结果区（可试听/下载/选用/加歌单）
    function renderIdentifyHits(results) {
        var box = $('bgmIdentifyResult');
        if (box) box.style.display = '';
        setIdProg('<span style="color:var(--fg-ok-soft);">✅ 识别到 ' + results.length + ' 首</span>');
        var songs = results.map(function (m) {
            var s = m.song || {};
            return {
                id: s.id, name: s.name,
                artist: (s.artists || []).map(function (a) { return a.name; }).join(', '),
                album: (s.album || {}).name || '',
                count: 1, fromIdentify: true,
            };
        }).filter(function (s) { return s.id && s.name; });
        if (!songs.length) return;
        // 写进结果区，复用同一套下载/选用/加歌单逻辑
        lastResult = { songs: songs, identify: true };
        renderResult(lastResult);
        setTimeout(function () {
            var rw = $('bgmResultWrap');
            if (rw && rw.style.display !== 'none') focusEl(rw, { bias: 0.08 });
        }, 80);
    }

    // ---------- 扒歌 ----------
    function startSingleByFile() {
        post('/pick-file', {}, 120000).then(function (r) {
            var p = (r.data || {}).path;
            if (!p) return;
startBgm('/single', { input: p, start: null, end: null, mode: 'accomp' },
                '\u5355\u96c6\u626c\u6b4c\uff08\u5168\u7247\uff09');
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
            // 下载中的集若正是用户点播等待的那一集，画面区同步显示遮罩进度
            if (pendingAutoPlay && bufEp !== 0) {
                bufShow('正在下载第 ' + pendingAutoPlay + ' 集', {
                    pct: d.percent || 0,
                    sub: '下载完成后将自动播放' + (d.msg ? ' · ' + d.msg : ''),
                    cancellable: true
                });
            }
            if (d.state === 'running') {
                pollTimer = setTimeout(poll, 1200);
            } else {
                hideProgress();
                if (d.state === 'done') onJobDone(d);
                else flash(d.msg || '任务结束');
            }
        }).catch(function () { pollTimer = setTimeout(poll, 2000); });
    }

    // 转码任务：转完先刷新本地列表（拿到 hasH264），再按需接续播放
    function pollTranscode(jobId, ep, onDone) {
        if (!jobId) return;
        if (pollTimer) clearTimeout(pollTimer);
        api('/status?jobId=' + encodeURIComponent(jobId), { timeout: 15000 }).then(function (r) {
            var d = r.data || {};
            if (r.code !== 0) { delete transcodePending[ep]; flash('转码任务丢失'); hideProgress(); return; }
            setProg(d.percent || 0, d.msg || '转码中', '转码为 H.264（播放器兼容格式）');
            // 同步推进画面区遮罩的进度
            bufShow('正在转码（HEVC → H.264）', {
                pct: d.percent || 0,
                sub: '第 ' + ep + ' 集' + (d.percent > 3
                    ? ' · 约剩 ' + Math.max(0, Math.round((d.elapsed || 0) * (100 - d.percent) / d.percent)) + 's'
                    : '')
            });
            if (d.state === 'running') {
                pollTimer = setTimeout(function () { pollTranscode(jobId, ep, onDone); }, 1200);
            } else {
                hideProgress();
                delete transcodePending[ep];      // 复位守卫（无论成功失败）
                if (d.state === 'done') {
                    // 关键：先刷新本地列表，让 localMap[ep].hasH264 变成 true，
                    // 再重播。否则 playLocal 会因 hasH264 仍为 false 再次转码 → 死循环。
                    refreshLocal().then(function () {
                        if (onDone) { onDone(); }
                        else if (localMap[ep]) { playLocal(ep); }
                    }).catch(function () {
                        if (onDone) onDone();
                        else if (localMap[ep]) { playLocal(ep); }
                    });
                } else {
                    flash(d.msg || '转码失败');
                }
            }
        }).catch(function () { pollTimer = setTimeout(function () { pollTranscode(jobId, ep, onDone); }, 2000); });
    }

    // 后台静默转码队列：显示"后台优化中 N 集"，转完自动刷新本地列表
    var tcTimer = null, tcLastPending = -1;
    function watchTranscodeQueue() {
        if (tcTimer) return;
        var tick = function () {
            api('/transcode-status', { timeout: 10000 }).then(function (r) {
                var dz = r.data || {};
                var pend = dz.pending || 0;
                var el = $('bgmTcHint');
                if (el) {
                    if (pend > 0) {
                        el.style.display = '';
                        el.textContent = '后台优化中（HEVC→H.264）剩 ' + pend + ' 集' +
                            (dz.done ? '，已完成 ' + dz.done : '');
                    } else {
                        el.style.display = 'none';
                    }
                }
                // 从"有任务"变"没任务" = 转完一批，刷新本地列表
                if (tcLastPending > 0 && pend === 0) {
                    try { refreshLocal().then(function () {}); } catch (e) {}
                }
                tcLastPending = pend;
            }).catch(function () {});
            tcTimer = setTimeout(tick, 4000);
        };
        tick();
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
                markSongsDownloaded(res.files || []);
                // 有失败就把每首的原因列出来（不再吞掉）
                if (bad) {
                    var info3 = $('bgmSongInfo');
                    if (info3) {
                        info3.innerHTML = '<span style="color:var(--fg-warn-soft);">' + bad +
                            ' \u9996\u672a\u4e0b\u8f7d\uff1a</span>' +
                            (res.failed || []).map(function (f) {
                                return esc(f.name || '') + '<span style="color:var(--muted);">\uff08' +
                                    esc(f.msg || '') + '\uff09</span>';
                            }).join('\u3001');
                    }
                }
            } else if (res.file) {
                flash('\u5df2\u4e0b\u8f7d\uff1a' + res.file.split('\\').pop());
                var info2 = $('bgmSongInfo');
                if (info2) info2.textContent = '\u5df2\u4fdd\u5b58\u5230\uff1a' + res.file;
                if (pendingSongRow) attachSongDrag(pendingSongRow, res.file);
                pendingSongRow = null;
            }
            return;
        }

        // 剧集下载（含 file 的结果）
        if (res.file) {
            var mb = ((res.size || 0) / 1048576).toFixed(1);
            flash('\u5df2\u4e0b\u8f7d ' + mb + 'MB \u2192 ' + res.file.split('\\').pop());
            var info = $('bgmPlayerInfo');
            if (info) info.textContent = '\u5df2\u4fdd\u5b58\u5230\uff1a' + res.file;
            refreshLocal().then(function () {
                // 刷新集的「已下载」状态，但不聚焦列表
                // （聚焦会把正在看播放器的视线拽回去）
                if (curSeries) renderSeries({ noFocus: true });
                if (pendingAutoPlay) {
                    var ep = pendingAutoPlay;
                    pendingAutoPlay = 0;
                    if (localMap[ep]) {
                        // 下载完成 → 直接接播放（playLocal 会先查编码，必要时转码）
                        bufShow('下载完成，正在准备播放…', { pct: null, sub: '第 ' + ep + ' 集' });
                        playLocal(ep);
                    } else {
                        bufShow('下载完成，但没找到文件', { error: true });
                    }
                } else {
                    // 非点播触发的下载（如批量/后台），完成后收起遮罩
                    bufHide();
                }
            });
            return;
        }

        if (jobKind === 'batch') {
            refreshLocal().then(function () { if (curSeries) renderSeries({ noFocus: true }); });
        }
        renderResult(res);
        // 统一在此写缓存：批量结果带 perEp（逐集），单集结果带 ep
        try {
            if (res && res.songs && res.ep) {
                cacheResult(res.ep, res);
            } else if (res && res.perEp && res.perEp.length) {
                res.perEp.forEach(function (pe) {
                    if (pe && pe.ep && pe.songs && pe.songs.length) {
                        cacheResult(pe.ep, { songs: pe.songs });
                    }
                });
            } else if (res && res.songs && lastPickEp) {
                cacheResult(lastPickEp, res);   // 兜底：按最近扒过的那集
            }
        } catch (e) {}
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
        // 该集结果入缓存：用结果自带的集号（服务端返回）
        // 缓存对象（cached:true）不会再写，避免覆盖
        if (res.ep && res.songs && !res.cached) cacheResult(res.ep, res);
        // 把命中点记下来画到进度条：
        // 用结果自带的集号（res.ep），不再只认"正在播放的那集"——
        // 否则单独扒完一集不记标记，之后再播放也看不到色块
        var markEp = res.ep || playEp;
        if (markEp && res.songs && res.songs.length) rememberMarks(markEp, res.songs);
        drawMarkers(playEp || markEp);
        selected = {};
        lastHlId = null;
        var wrap = $('bgmResultWrap'), box = $('bgmResultList');
        var songs = res.songs || [];
        // 更新播放器内「扒此集」按钮状态（当前集扒完 → 变为已扒·看结果）
        if (res.ep) { try { updateRipBtn(res.ep); } catch (e) {} }
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
        // 结果列表出现后聚焦（留一点延迟等布局稳定）
        setTimeout(function () {
            var rw = $('bgmResultWrap');
            if (rw && rw.style.display !== 'none') focusEl(rw, { bias: 0.08 });
        }, 60);
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
    // ---------- 剧集卡片右键菜单 ----------
    // 收藏 / 下载该剧（自动跳过已下载的集）/ 打开详情 / 复制剧名
    function showSeriesMenu(it, ev) {
        if (!it || !it.series_id) return;
        var old = document.getElementById('bgmSeriesMenu');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var menu = document.createElement('div');
        menu.id = 'bgmSeriesMenu';
        menu.style.cssText = 'position:fixed;z-index:9999;min-width:190px;background:#2b2b2b;' +
            'border:1px solid #444;border-radius:6px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,.45);font-size:12px;';
        function mi(text, fn, danger) {
            var el = document.createElement('div');
            el.style.cssText = 'padding:7px 12px;cursor:pointer;border-radius:4px;white-space:nowrap;' +
                (danger ? 'color:#f2879a;' : 'color:var(--text);');
            el.textContent = text;
            el.addEventListener('mouseenter', function () { el.style.background = 'rgba(255,255,255,.08)'; });
            el.addEventListener('mouseleave', function () { el.style.background = ''; });
            el.addEventListener('click', function () { menu.remove(); try { fn(); } catch (e) { flash('操作出错：' + e.message); } });
            menu.appendChild(el);
        }

        var faved = isFavSeries(it.series_id);
        mi(faved ? '★ 取消收藏' : '☆ 收藏该剧', function () {
            var on = toggleFavSeries(it);
            flash(on ? ('已收藏：' + (it.name || '')) : '已取消收藏');
        });

        mi('⬇ 下载该剧', function () { downloadWholeSeries(it); });

        mi('ℹ 打开详情', function () { openSeries(it); });

        mi('📋 复制剧名', function () {
            var nm = it.name || '';
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(nm);
                else if (window.__copyFlash) window.__copyFlash(nm);
                flash('已复制：' + nm);
            } catch (e) { flash('复制失败'); }
        });

        document.body.appendChild(menu);
        var x = ev.clientX, y = ev.clientY;
        var mw = 200, mh = menu.offsetHeight || 150;
        if (x + mw > window.innerWidth) x = window.innerWidth - mw - 4;
        if (y + mh > window.innerHeight) y = window.innerHeight - mh - 4;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        setTimeout(function () {
            var kill = function (e2) {
                if (!menu.contains(e2.target)) { menu.remove(); document.removeEventListener('click', kill); document.removeEventListener('contextmenu', kill); }
            };
            document.addEventListener('click', kill);
            document.addEventListener('contextmenu', kill);
        }, 10);
    }

    // 下载整部剧：拉剧集信息 → 跳过已下载的集 → 对缺口逐集下载
    function downloadWholeSeries(it) {
        if (!it || !it.series_id) return;
        flash('正在获取剧集信息…');
        ensureServer().then(function () {
            return api('/series?series_id=' + encodeURIComponent(it.series_id), { timeout: 40000 });
        }).then(function (r) {
            if (!r || r.code !== 0 || !r.data) { flash('获取剧集失败'); return; }
            var info = r.data;
            var vids = info.vid_list || [];
            if (!vids.length) { flash('这部剧没有可下载的集'); return; }
            // 刷新本地列表，算出缺口
            return refreshLocal().then(function () {
                var have = dlEpsOf(info.name || it.name || '');
                var miss = [];
                for (var i = 1; i <= vids.length; i++) {
                    if (have.indexOf(i) < 0) miss.push(i);
                }
                if (!miss.length) {
                    flash('该剧 ' + vids.length + ' 集已全部下载完成');
                    return;
                }
                bgmDialog.confirm({
                    title: '下载该剧',
                    body: '《' + (info.name || it.name || '') + '》共 ' + vids.length + ' 集。\n' +
                          '已下载 ' + have.length + ' 集，还需下载 ' + miss.length + ' 集。\n\n开始下载？',
                    okText: '开始下载',
                    cancelText: '取消'
                }).then(function (yes) {
                if (!yes) return;
                // 逐集触发下载（服务端串行处理，这里按顺序发，避免并发）
                curSeries = info;
                var idx = 0;
                dlJobStart(info.series_id, info.name || it.name, miss.length);
                // 若用户正停在「已下载」页，切回去让他看到新卡片
                if (hotKind === 'downloaded') renderDlGrid();
                function next() {
                    if (idx >= miss.length) {
                        flash('该剧下载完成');
                        dlJobFinish(info.series_id);
                        refreshLocal();
                        return;
                    }
                    var ep = miss[idx++];
                    var vid = vids[ep - 1];
                    post('/download', { series_id: info.series_id, vid: vid, name: info.name, ep: ep }, 60000)
                        .then(function (rr) {
                            if (!rr || rr.code !== 0) {
                                flash('第 ' + ep + ' 集启动失败，跳过');
                                setTimeout(next, 300);
                                return;
                            }
                            pollDownloadJob(rr.data.jobId, ep, function () {
                                idxDone++;
                                setTimeout(next, 200);
                            }, { sid: info.series_id, name: info.name || it.name, total: miss.length, done: idxDone });
                        })
                        .catch(function () { setTimeout(next, 500); });
                }
                var idxDone = 0;
                showProgress('下载该剧');
                next();
                });
            });
        }).catch(function (e) { flash('下载失败：' + (e && e.message || e)); });
    }

    // 轮询单个下载任务，完成后回调
    // 轮询单个下载任务。ctx: { sid, name, total, done }（批量下载时用于汇总进度）
    function pollDownloadJob(jobId, ep, done, ctx) {
        api('/status?jobId=' + encodeURIComponent(jobId), { timeout: 15000 }).then(function (r) {
            var d = (r && r.data) || {};
            var pct = d.percent || 0;
            if (ctx) {
                // 汇总：已完成 done 集 + 当前集进度 / 总集数
                var overall = ctx.total
                    ? Math.round(((ctx.done + pct / 100) / ctx.total) * 100)
                    : pct;
                setProg(overall,
                    '第 ' + ep + ' / 共 ' + ctx.total + ' 集 · ' +
                    (d.msg || '下载中') + '（本集 ' + pct + '%）',
                    '已完成 ' + ctx.done + ' / ' + ctx.total + ' 集');
                dlJobProgress(ctx.sid, ctx.done, ep, overall);
            } else {
                setProg(pct, d.msg || ('第 ' + ep + ' 集下载中'), '');
            }
            if (d.state === 'running') {
                setTimeout(function () { pollDownloadJob(jobId, ep, done, ctx); }, 1200);
            } else {
                done && done();
            }
        }).catch(function () { setTimeout(function () { pollDownloadJob(jobId, ep, done, ctx); }, 2000); });
    }

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
    var uiRestored = false;

    // 面板被关闭/卸载（关插件、重载扩展）时，把当前进度落盘。
    // timeupdate 每 3 秒存一次，这一下是兼容“刚好在两次之间关掉”。
    window.addEventListener('beforeunload', function () {
        try {
            var v = $('bgmV');
            if (v && !songMode && v.currentTime > 1) {
                lastPlayPos = v.currentTime;
                // 关面板/重载扩展的最后一刻：把进度写进播放历史
                if (playEp) updatePlayHistPos(playEp, lastPlayPos, v.duration || 0);
            }
            saveUiState();
        } catch (e) {}
    });

    function onShow() {
        try { ensureServer().catch(function () {}); } catch (e) {}
        try { watchTranscodeQueue(); } catch (e) {}
        try { refreshLocal().then(function () { try { saveUiState(); } catch (e) {} }); } catch (e) {}
        try { renderHist(); } catch (e) {}
        try { renderPlayHist(); } catch (e) {}   // 首页的「接着看」
        // 首次进入本会话：尝试恢复上次页面；已有内容则不动
        if (!uiRestored) {
            uiRestored = true;
            var ok = false;
            try { ok = restoreUiState(); } catch (e) { ok = false; }
            if (ok) return;   // 正在恢复剧集页，不再加载首页
        }
        try {
            var grid = $('bgmHotGrid');
            // 用 data-loaded 标记判断（骨架屏会填充 children，不能用 children.length）
            if (grid && grid.getAttribute('data-loaded') !== '1') loadHot(hotKind);
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
        // 播放历史清空（首页「接着看」）
        on('bgmPlayHistClear', function () {
            clearPlayHist();
        });
        bindHotTabs();
        on('btnBgmSearch', doSearch, 'click');
        $('btnBgmBack').addEventListener('click', function () {
            $('bgmSeriesWrap').style.display = 'none';
            $('bgmSearchWrap').style.display = '';
            $('bgmResultWrap').style.display = '';
        });
        saveUiState();
        on('btnBgmPickFile', startSingleByFile, 'click');
        on('btnBgmPickDir', startBatchByDir, 'click');
        var ob = $('btnBgmOnlineBatch');
        if (ob) ob.addEventListener('click', startOnlineBatch);
        on('btnBgmCancel', stopJob, 'click');
        on('btnBgmToLib', toPlaylist, 'click');
        on('bgmIdentifyFab', function () {
            var p = $('bgmIdentifyPanel');
            if (p && p.style.display === 'none') { openIdentifyPanel(); return; }
            doBgmIdentify();
        });
        on('btnBgmIdentifyStop', stopBgmIdentify);
        on('btnBgmIdentifyClose', closeIdentifyPanel);
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
        // 播放器内「扒此集」大按钮
        on('btnBgmRipThis', function () {
            if (!curSeries || !playEp) { flash('先在下面选一集播放'); return; }
            var vid = curSeries.vid_list && curSeries.vid_list[playEp - 1];
            pickEpisode(vid, playEp);
        }, 'click');
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
            bgmDialog.confirm({
                title: '下载全集',
                body: '共 ' + total + ' 集，文件较多、耗时较长。\n\n过程中可随时点「停止」中断。开始下载？',
                okText: '开始下载',
                cancelText: '取消'
            }).then(function (yes) {
                if (!yes) return;
                startBgm('/batch', { series_id: curSeries.series_id, name: curSeries.name, from: 1, count: total },
                    '下载全集（' + total + ' 集）');
            });
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
        var bprev = $('btnBgmBarPrev');
        if (bprev) bprev.addEventListener('click', function () { playNav(-1); });
        // 进度条：点击/拖动跳转
        (function () {
            var sk = $('bgmPbarHit');
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
        // 全屏（原生 controls 已移除，这里补上）
        var bfull = $('btnBgmBarFull');
        if (bfull) bfull.addEventListener('click', function () {
            var v = $('bgmV');
            if (!v) return;
            try {
                if (v.requestFullscreen) v.requestFullscreen();
                else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
                else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();   // CEF 下备选
            } catch (e) { flash('全屏失败：' + (e && e.message || e)); }
        });
        // 遮罩上的取消：下载/转码中途放弃
        var bcancel = $('bgmBufCancel');
        if (bcancel) bcancel.addEventListener('click', function () {
            pendingAutoPlay = 0;
            stopJob();
            bufShow('已取消', { error: false, sub: '' });
            setTimeout(bufHide, 900);
        });
        // 选集浮层
        var bpick = $('btnBgmBarPick');        if (bpick) bpick.addEventListener('click', function (ev) {
            ev.stopPropagation();
            toggleEpPicker();
        });
        var bpickClose = $('btnBgmEpPickerClose');
        if (bpickClose) bpickClose.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var pk = $('bgmEpPicker');
            if (pk) pk.style.display = 'none';
        });
        // 点击画面切换播放/暂停（视频居中区域，排除叠加控件）
        (function () {
            var stage = $('bgmV');
            if (!stage) return;
            // 用事件委托到 video 自身；遮罩、识曲按钮、BGM 叠加层都在 video 之上，
            // 它们的点击不会冒泡到 video，所以不必额外排除。
            stage.addEventListener('click', function (ev) {
                if (bufEp !== 0 && $('bgmBuf') && $('bgmBuf').style.display !== 'none') return; // 遮罩期间不切
                if (ev.target !== stage) return;
                var m = curMedia();
                if (!m || !m.src) return;
                if (songMode && inlineAudio) {
                    if (inlineAudio.paused) inlineAudio.play().catch(function () {}); else inlineAudio.pause();
                    syncSongBar();
                    return;
                }
                if (m.paused) m.play().catch(function () {}); else m.pause();
                syncBar();
            });
        })();
      } catch (e) { try { flash('\u754c\u9762\u521d\u59cb\u5316\u5f02\u5e38: ' + (e && e.message || e)); } catch (e2) {} }
    }

    function safeBind() {
        try { bind(); } catch (e) { try { flash('\u77ed\u5267\u626c\u6b4c\u9762\u677f\u521d\u59cb\u5316\u5931\u8d25: ' + (e && e.message || e)); } catch (e2) {} }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safeBind);
    else safeBind();

    window.__bgmOnShow = onShow;
    // 供 main.js 启动预热：只确保本地服务在跑，不动界面
    window.__bgmEnsure = function () { try { return ensureServer(0, true); } catch (e) { return null; } };
})();
