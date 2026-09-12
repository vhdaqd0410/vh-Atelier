// vh-Atelier 直播板块：解析直播间（观看） + ffmpeg 录制 + 关注列表开播状态
// 服务：live/index.js（本地 17893，零依赖，按需自举）
// 支持平台：虎牙 / 斗鱼 / 哔哩哔哩 / 抖音（快手不支持）
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var cp = require('child_process');

    var API = 'http://127.0.0.1:17893';
    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var svcDir = path.join(extRoot, 'live');
    var svcIndex = path.join(svcDir, 'index.js');
    var liveChild = null;

    var PLATFORM_CN = { huya: '虎牙', douyu: '斗鱼', bilibili: '哔哩哔哩', douyin: '抖音', kuaishou: '快手' };

    var curInfo = null;      // 当前解析结果
    var curRecId = '';       // 当前正在录制的任务 id
    var recTimer = null;     // 录制轮询
    var curStreamUrl = '';   // 当前播放地址
    var curPlat = 'douyu';   // 当前平台
    var curPage = 1;         // 当前推荐/搜索页码
    var curKw = '';          // 当前搜索词（空 = 推荐模式）
    var lastList = [];       // 当前列表（供加载更多去重）

    function $(id) { return document.getElementById(id); }

    function flash(msg, isErr) {
        var el = $('lvFlash');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'lv-flash show' + (isErr ? ' err' : '');
        clearTimeout(el.__t);
        el.__t = setTimeout(function () { el.className = 'lv-flash'; }, 2600);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function fmtDur(sec) {
        sec = Math.max(0, Math.floor(Number(sec) || 0));
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        function p(x) { return x < 10 ? '0' + x : '' + x; }
        return h > 0 ? (h + ':' + p(m) + ':' + p(s)) : (m + ':' + p(s));
    }

    // ---------- 服务自举 ----------
    function findNode() {
        var cands = [
            path.join(extRoot, 'runtime', 'node.exe'),
            path.join(extRoot, 'runtime', 'node', 'node.exe')
        ];
        for (var i = 0; i < cands.length; i++) { try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) {} }
        try {
            var w = cp.spawnSync('where', ['node'], { encoding: 'utf8' });
            if (w.status === 0 && w.stdout) {
                var first = w.stdout.split('\n')[0].trim();
                if (first) return first;
            }
        } catch (e) {}
        return null;
    }

    function spawnSvc() {
        try {
            if (!fs.existsSync(svcIndex)) return false;
            if (liveChild) return true;
            var node = findNode();
            if (!node) return false;
            liveChild = cp.spawn(node, [svcIndex], { cwd: svcDir, windowsHide: true });
            liveChild.on('error', function () { liveChild = null; });
            liveChild.on('close', function () { liveChild = null; });
            return true;
        } catch (e) { return false; }
    }

    function api(pathname, opts) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open((opts && opts.method) || 'GET', API + pathname, true);
            xhr.timeout = (opts && opts.timeout) || 100000;   // 解析要等 yt-dlp
            if (opts && opts.body) xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) { reject(new Error('连不上直播服务')); return; }
                var txt = xhr.responseText || '';
                var j = null;
                try { j = JSON.parse(txt); } catch (e) {
                    reject(new Error('服务响应异常（HTTP ' + xhr.status + '）')); return;
                }
                if (j.code !== 0) { reject(new Error(j.msg || '服务返回失败')); return; }
                resolve(j.data);
            };
            xhr.onerror = function () { reject(new Error('连不上直播服务')); };
            xhr.ontimeout = function () { reject(new Error('请求超时')); };
            xhr.send(opts && opts.body ? JSON.stringify(opts.body) : null);
        });
    }

    function ensureServer(retries) {
        var tries = retries || 0;
        return api('/health', { timeout: 8000 }).catch(function () {
            if (tries < 1) {
                spawnSvc();
                return new Promise(function (resolve) { setTimeout(function () { resolve(ensureServer(tries + 1)); }, 2200); });
            }
            throw new Error('直播服务未就绪（需本机 Node.js）');
        });
    }

    function syncHealth(h) {
        var el = $('lvHealth');
        if (!el) return;
        if (!h) { el.textContent = '服务未就绪'; el.className = 'lv-badge err'; return; }
        if (!h.hasYtdlp) { el.textContent = 'yt-dlp 缺失'; el.className = 'lv-badge err'; return; }
        el.textContent = '就绪 · yt-dlp ' + (h.version || '?') + (h.hasFfmpeg ? '' : ' · ffmpeg 缺失');
        el.className = 'lv-badge' + (h.hasFfmpeg ? ' ok' : ' err');
    }

    // ---------- 平台推荐 / 搜索 ----------
    function setPlat(plat) {
        curPlat = plat;
        curPage = 1;
        curKw = '';
        lastList = [];
        var bar = document.querySelectorAll('#panel-live .lv-plat');
        for (var i = 0; i < bar.length; i++) {
            bar[i].className = 'lv-plat' + (bar[i].getAttribute('data-plat') === plat ? ' active' : '');
        }
        var ph = $('lvPlatHint');
        if (ph) {
            if (plat === 'huya') ph.textContent = '虎牙搜索接口已关闭，仅支持推荐';
            else if (plat === 'douyin') ph.textContent = '抖音仅支持推荐（搜索需签名）';
            else ph.textContent = '';
        }
        loadList(true);
    }

    function loadList(reset) {
        if (reset) { curPage = 1; lastList = []; }
        var kw = ($('lvKw').value || '').trim();
        curKw = kw;
        var grid = $('lvGrid');
        if (reset && grid) grid.innerHTML = '<div class="lv-empty">加载中…</div>';
        ensureServer().then(function () {
            var sub;
            if (kw) {
                sub = '/search?platform=' + curPlat + '&kw=' + encodeURIComponent(kw) + '&page=' + curPage;
            } else {
                sub = '/recommend?platform=' + curPlat + '&page=' + curPage;
            }
            return api(sub, { timeout: 30000 });
        }).then(function (d) {
            var list = (d && d.list) || [];
            if (curPage > 1) list = lastList.concat(list);
            lastList = list;
            renderGrid(list);
            if (!list.length) {
                var tip = kw ? ('没有搜到「' + kw + '」') : '这个平台暂时没拉到推荐';
                if (curPlat === 'huya' && kw) tip += '（虎牙不支持搜索）';
                if (curPlat === 'douyin' && kw) tip += '（抖音不支持搜索）';
                flash(tip, true);
            } else {
                flash('已加载 ' + list.length + ' 个直播间');
            }
        }).catch(function (e) {
            if (grid) grid.innerHTML = '<div class="lv-empty">加载失败：' + esc(e.message) + '</div>';
            flash(e.message, true);
        });
    }

    function renderGrid(list) {
        var grid = $('lvGrid');
        if (!grid) return;
        if (!list.length) { grid.innerHTML = '<div class="lv-empty">没有可展示的直播间</div>'; return; }
        grid.innerHTML = '';
        list.forEach(function (r) {
            var card = document.createElement('div');
            card.className = 'lv-cell';
            card.title = (r.title || '') + (r.uname ? ('\n主播：' + r.uname) : '') + (r.online ? ('\n热度：' + r.online) : '');

            var coverBox = document.createElement('div');
            coverBox.className = 'lv-cell-cover';
            if (r.cover) {
                var img = document.createElement('img');
                img.src = r.cover;
                img.alt = '';
                img.loading = 'lazy';
                img.onerror = function () { img.style.display = 'none'; };
                coverBox.appendChild(img);
            }
            var tag = document.createElement('span');
            tag.className = 'lv-cell-plat';
            tag.textContent = r.platformCN || '';
            coverBox.appendChild(tag);
            card.appendChild(coverBox);

            var t = document.createElement('div');
            t.className = 'lv-cell-title';
            t.textContent = r.title || '(无标题)';
            card.appendChild(t);

            var s = document.createElement('div');
            s.className = 'lv-cell-sub';
            var bits = [r.uname || '', r.areaName || ''];
            if (r.online) bits.push('热 ' + r.online);
            s.textContent = bits.filter(Boolean).join(' · ');
            card.appendChild(s);

            var acts = document.createElement('div');
            acts.className = 'lv-cell-acts';
            var bView = document.createElement('button');
            bView.className = 'tbtn mini';
            bView.textContent = '▶ 看';
            bView.addEventListener('click', function (ev) {
                ev.stopPropagation();
                $('lvUrl').value = r.url;
                parse(function () { watch(); });
            });
            var bRec = document.createElement('button');
            bRec.className = 'tbtn mini';
            bRec.textContent = '⏺ 录';
            bRec.addEventListener('click', function (ev) {
                ev.stopPropagation();
                $('lvUrl').value = r.url;
                parse(function () { startRec(); });
            });
            var bFav = document.createElement('button');
            bFav.className = 'tbtn mini';
            bFav.textContent = '☆';
            bFav.title = '关注';
            bFav.addEventListener('click', function (ev) {
                ev.stopPropagation();
                favAction('add', r.url, r.uname || r.title || '');
            });
            acts.appendChild(bView); acts.appendChild(bRec); acts.appendChild(bFav);
            card.appendChild(acts);

            card.addEventListener('click', function () {
                $('lvUrl').value = r.url;
                parse();
            });
            grid.appendChild(card);
        });
    }

    // ---------- 解析 ----------
    function parse(afterOk) {
        var link = ($('lvUrl').value || '').trim();
        if (!link) { flash('请先粘贴直播间链接', true); return; }
        flash('解析中…（首次可能要几秒）');
        ensureServer().then(function (h) {
            syncHealth(h);
            return api('/parse?url=' + encodeURIComponent(link));
        }).then(function (info) {
            curInfo = info;
            renderInfo(info);
            if (info.isLive) flash('已解析：' + (info.title || info.uploader || '') + '（正在直播）');
            else flash('已解析：当前未开播');
            if (typeof afterOk === 'function') afterOk(info);
        }).catch(function (e) {
            curInfo = null;
            renderInfo(null);
            flash(e.message, true);
        });
    }

    function renderInfo(info) {
        var card = $('lvPlayCard');
        if (!card) return;
        if (!info) { card.style.display = 'none'; return; }
        card.style.display = '';

        var st = $('lvState');
        st.textContent = info.isLive ? '🔴 直播中' : '⚪ 未开播';
        st.className = 'lv-state' + (info.isLive ? ' on' : '');
        $('lvTitle').textContent = info.title || '（无标题）';
        $('lvSub').textContent = (PLATFORM_CN[info.platform] || '') + (info.uploader ? ' · ' + info.uploader : '');

        // 封面
        var th = $('lvThumb');
        if (info.thumbnail) { th.src = info.thumbnail; th.style.display = ''; }
        else { th.removeAttribute('src'); th.style.display = 'none'; }
        $('lvVideoMask').style.display = '';

        // 画质
        var qs = $('lvQuality');
        qs.innerHTML = '';
        (info.formats || []).forEach(function (f) {
            var o = document.createElement('option');
            o.value = f.formatId;
            o.textContent = (f.note || f.height || '默认') + (f.ext ? (' · ' + f.ext) : '');
            qs.appendChild(o);
        });
        if (!(info.formats || []).length) {
            var o2 = document.createElement('option');
            o2.value = '';
            o2.textContent = '默认';
            qs.appendChild(o2);
        }

        var canWatch = info.isLive && !!info.streamUrl;
        $('lvWatch').disabled = !canWatch;
        $('lvStartRec').disabled = !canWatch;
        if (!info.isLive) $('lvWatch').disabled = true;
    }

    // ---------- 观看 ----------
    // CEP 是 Chromium 桌面内核：<video> 原生不支持 HLS(m3u8)，也不能放 FLV。
    // 所以按流类型选播放器：
    //   .m3u8  → hls.js（MediaSource 解封装）
    //   .flv   → flv.js
    //   其它   → 交给 <video> 原生（mp4 等）
    var hlsInst = null;
    var flvInst = null;

    function destroyPlayers() {
        try { if (hlsInst) { hlsInst.destroy(); hlsInst = null; } } catch (e) {}
        try { if (flvInst) { flvInst.destroy(); flvInst = null; } } catch (e) {}
    }

    function guessStreamType(u) {
        var s = String(u || '').toLowerCase()
        if (/\.m3u8($|\?)/.test(s) || /m3u8/.test(s)) return 'hls'
        if (/\.flv($|\?)/.test(s) || /flv/.test(s)) return 'flv'
        return 'native'
    }

    function playStream(url) {
        var v = $('lvVideo');
        var kind = guessStreamType(url);
        destroyPlayers();
        $('lvVideoMask').style.display = 'none';
        $('lvThumb').style.display = 'none';

        if (kind === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) {
            hlsInst = new Hls({ enableWorker: false, lowLatencyMode: true, liveSyncDurationCount: 3 });
            hlsInst.loadSource(url);
            hlsInst.attachMedia(v);
            hlsInst.on(Hls.Events.MANIFEST_PARSED, function () { v.play().catch(function () {}); });
            hlsInst.on(Hls.Events.ERROR, function (evt, data) {
                if (data && data.fatal) flash('直播流错误：' + (data.details || data.type), true);
            });
            return true;
        }
        if (kind === 'flv' && typeof flvjs !== 'undefined' && flvjs.isSupported()) {
            flvInst = flvjs.createPlayer({ type: 'flv', url: url, isLive: true }, { enableWorker: false });
            flvInst.attachMediaElement(v);
            flvInst.load();
            flvInst.play().catch(function () {});
            flvInst.on(flvjs.Events.ERROR, function (e, d) { flash('直播流错误：' + (d || e), true); });
            return true;
        }
        // 原生（mp4 等），或库不可用时退回原生
        v.src = url;
        var pr = v.play();
        if (pr && pr.catch) pr.catch(function () {
            flash('无法直接播放该流，建议点「外部播放」用本地播放器看', true);
        });
        if (kind === 'hls' && (typeof Hls === 'undefined' || !Hls.isSupported())) {
            flash('hls.js 未加载或不被支持，无法播放 HLS 直播', true);
        }
        return true;
    }

    function watch() {
        if (!curInfo) return;
        var q = $('lvQuality').value || '';
        flash('获取播放地址…');
        ensureServer().then(function () {
            var sub = '/stream?url=' + encodeURIComponent(curInfo.roomUrl);
            if (q) sub += '&format=' + encodeURIComponent(q);
            return api(sub, { timeout: 90000 });
        }).then(function (d) {
            var target = (d && d.streamUrl) || '';
            if (!target) throw new Error('没拿到可播放的流地址');
            curStreamUrl = target;
            playStream(target);
            $('lvStopWatch').disabled = false;
            var kind = guessStreamType(target);
            flash('开始播放（' + (kind === 'hls' ? 'HLS' : kind === 'flv' ? 'FLV' : '直链') + '）');
        }).catch(function (e) { flash('播放失败：' + e.message, true); });
    }

    // 用系统默认播放器打开直播流（PotPlayer/VLC 等；看流比面板内更稳）
    function openExternal() {
        if (!curStreamUrl) { flash('请先点「观看」获取到播放地址', true); return; }
        var q = $('lvQuality').value || '';
        // 若有选择具体画质，重新取一次对应直链
        ensureServer().then(function () {
            var sub = '/stream?url=' + encodeURIComponent(curInfo.roomUrl);
            if (q) sub += '&format=' + encodeURIComponent(q);
            return api(sub, { timeout: 90000 });
        }).then(function (d) {
            var u = (d && d.streamUrl) || curStreamUrl;
            try {
                require('child_process').exec('start "" "' + u.replace(/"/g, '') + '"');
                flash('已交给系统默认播放器打开');
            } catch (e) { flash('外部打开失败：' + e.message, true); }
        }).catch(function (e) { flash('外部打开失败：' + e.message, true); });
    }

    function stopWatch() {
        destroyPlayers();
        var v = $('lvVideo');
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
        curStreamUrl = '';
        $('lvStopWatch').disabled = true;
        $('lvVideoMask').style.display = '';
        if (curInfo && curInfo.thumbnail) $('lvThumb').style.display = '';
        flash('已停止播放');
    }

    // ---------- 录制 ----------
    function startRec() {
        if (!curInfo) return;
        if (curRecId) { flash('已有录制在进行中，请先停止', true); return; }
        flash('开始录制…');
        ensureServer().then(function () {
            return api('/record?url=' + encodeURIComponent(curInfo.roomUrl), { method: 'POST', timeout: 120000 });
        }).then(function (d) {
            curRecId = d.id;
            $('lvStartRec').disabled = true;
            $('lvStopRec').disabled = false;
            flash('录制已启动（mkv 落盘，结束后自动转 mp4）');
            refreshRecs();
            startRecPoll();
        }).catch(function (e) {
            flash('录制启动失败：' + e.message, true);
        });
    }

    function stopRec() {
        if (!curRecId) return;
        var id = curRecId;
        flash('正在停止录制…');
        ensureServer().then(function () {
            return api('/stop', { method: 'POST', body: { id: id } });
        }).then(function () {
            flash('已请求停止，正在收尾并转 mp4…');
            stopRecPoll();
            setTimeout(refreshRecs, 1200);
        }).catch(function (e) { flash('停止失败：' + e.message, true); });
    }

    function startRecPoll() {
        stopRecPoll();
        recTimer = setInterval(refreshRecs, 3000);
    }
    function stopRecPoll() {
        if (recTimer) { clearInterval(recTimer); recTimer = null; }
    }

    function refreshRecs() {
        ensureServer().then(function () { return api('/recs', { timeout: 8000 }); }).then(function (d) {
            var list = (d && d.list) || [];
            renderRecs(list);
            // 当前录制是否还在进行
            var mine = list.filter(function (r) { return r.id === curRecId; })[0];
            if (curRecId && mine) {
                var running = (mine.status === 'recording' || mine.status === 'starting' || mine.status === 'stopping' || mine.status === 'remuxing');
                $('lvStartRec').disabled = running;
                $('lvStopRec').disabled = !(mine.status === 'recording');
                if (!running) {
                    curRecId = '';
                    stopRecPoll();
                    $('lvStartRec').disabled = !(curInfo && curInfo.isLive);
                    $('lvStopRec').disabled = true;
                    if (mine.status === 'done') flash('录制完成，已转 mp4');
                }
            }
        }).catch(function () {});
    }

    var REC_LABEL = { starting: '启动中', recording: '录制中', stopping: '停止中', remuxing: '转 mp4', done: '✅ 完成', error: '❌ 失败' };

    function renderRecs(list) {
        var box = $('lvRecList');
        if (!box) return;
        if (!list.length) { box.innerHTML = '<div class="lv-empty">暂无录制任务</div>'; return; }
        box.innerHTML = '';
        list.slice(0, 30).forEach(function (r) {
            var row = document.createElement('div');
            row.className = 'lv-rec-item' + (r.status === 'recording' ? ' rec' : '');
            var live = (r.status === 'recording');
            var line1 = document.createElement('div');
            line1.className = 'lv-rec-l1';
            line1.innerHTML = '<span class="lv-rec-st ' + r.status + '">' + (REC_LABEL[r.status] || r.status) + '</span>' +
                '<span class="lv-rec-nm" title="' + esc(r.title) + '">' + esc(r.title || r.link) + '</span>';
            row.appendChild(line1);
            var line2 = document.createElement('div');
            line2.className = 'lv-rec-l2';
            var bits = [r.platformCN || '', live ? ('已录 ' + fmtDur(r.elapsedSec)) : (r.minutes ? (fmtDur(r.minutes * 60)) : '')];
            if (r.err) bits.push('⚠ ' + r.err);
            line2.textContent = bits.filter(Boolean).join(' · ');
            row.appendChild(line2);
            if (r.mp4Path) {
                var act = document.createElement('div');
                act.className = 'lv-rec-acts';
                var b1 = document.createElement('button');
                b1.className = 'tbtn mini';
                b1.textContent = '📥 导入 PR';
                b1.title = r.mp4Path;
                b1.addEventListener('click', function () { importRec(r.mp4Path); });
                var b2 = document.createElement('button');
                b2.className = 'tbtn mini';
                b2.textContent = '📂 打开目录';
                b2.addEventListener('click', function () { openDir(path.dirname(r.mp4Path)); });
                act.appendChild(b1); act.appendChild(b2);
                row.appendChild(act);
            } else if (r.outPath) {
                var act2 = document.createElement('div');
                act2.className = 'lv-rec-acts';
                var b3 = document.createElement('button');
                b3.className = 'tbtn mini';
                b3.textContent = '📂 打开目录';
                b3.addEventListener('click', function () { openDir(path.dirname(r.outPath)); });
                act2.appendChild(b3);
                row.appendChild(act2);
            }
            box.appendChild(row);
        });
    }

    // 导入录制结果到 PR「直播」素材箱
    function importRec(file) {
        if (!file || !fs.existsSync(file)) { flash('文件不存在：' + file, true); return; }
        var payload = JSON.stringify([file]);
        csInterface.evalScript('wsImportToBinPayload = ' + payload + ';', function () {
            csInterface.evalScript('wsImportToBinStr("直播")', function (r) {
                try {
                    var d = JSON.parse(r);
                    if (d.ok) flash('已导入素材箱「直播」：' + (d.imported || []).join('、'));
                    else flash('导入失败：' + (d.error || '未知'), true);
                } catch (e) { flash('导入解析失败', true); }
            });
        });
    }

    function openDir(dir) {
        try { cp.exec('start "" "' + dir + '"'); } catch (e) { flash('打开目录失败', true); }
    }

    // ---------- 关注列表 ----------
    function loadFavs() {
        ensureServer().then(function () { return api('/favs', { timeout: 8000 }); }).then(function (d) {
            renderFavs((d && d.list) || []);
        }).catch(function () {});
    }

    function renderFavs(list) {
        var box = $('lvFavList');
        if (!box) return;
        if (!list.length) { box.innerHTML = '<div class="lv-empty">还没有关注的直播间</div>'; return; }
        box.innerHTML = '';
        list.forEach(function (f) {
            var row = document.createElement('div');
            row.className = 'lv-fav-item';
            var dot = document.createElement('span');
            dot.className = 'lv-fav-dot' + (f.__live ? ' on' : '');
            dot.title = f.__live ? '直播中' : (f.__err ? f.__err : '未开播');
            row.appendChild(dot);
            var info = document.createElement('div');
            info.className = 'lv-fav-info';
            var t1 = document.createElement('div');
            t1.className = 'lv-fav-nm';
            t1.textContent = f.name || f.url;
            var t2 = document.createElement('div');
            t2.className = 'lv-fav-sub';
            var bits = [PLATFORM_CN[f.platform] || ''];
            if (f.__live && f.__title) bits.push(f.__title);
            else if (f.__err) bits.push('⚠ ' + f.__err);
            t2.textContent = bits.filter(Boolean).join(' · ');
            info.appendChild(t1); info.appendChild(t2);
            row.appendChild(info);
            var acts = document.createElement('div');
            acts.className = 'lv-fav-acts';
            var bView = document.createElement('button');
            bView.className = 'tbtn mini';
            bView.textContent = '查看';
            bView.addEventListener('click', function () { $('lvUrl').value = f.url; parse(); });
            var bRec = document.createElement('button');
            bRec.className = 'tbtn mini';
            bRec.textContent = '录制';
            bRec.title = '解析后开始录制';
            bRec.addEventListener('click', function () { $('lvUrl').value = f.url; parse(); flash('已填入地址，请在下方点「开始录制」'); });
            var bDel = document.createElement('button');
            bDel.className = 'tbtn mini';
            bDel.textContent = '✕';
            bDel.title = '取消关注';
            bDel.addEventListener('click', function () { favAction('remove', f.url); });
            acts.appendChild(bView); acts.appendChild(bRec); acts.appendChild(bDel);
            row.appendChild(acts);
            box.appendChild(row);
        });
    }

    function favAction(action, link, name) {
        ensureServer().then(function () {
            return api('/favs', { method: 'POST', body: { action: action, url: link, name: name || '' } });
        }).then(function (d) {
            renderFavs((d && d.list) || []);
            flash(action === 'add' ? '已加入关注' : (action === 'remove' ? '已取消关注' : '已更新'));
        }).catch(function (e) { flash('操作失败：' + e.message, true); });
        // 注意：renderFavs 会覆盖 __live 标记，这里保留上次状态
    }

    function addFav() {
        var link = ($('lvUrl').value || '').trim();
        if (!link) { flash('请先粘贴直播间链接', true); return; }
        var nm = (curInfo && (curInfo.uploader || curInfo.title)) || '';
        favAction('add', link, nm);
    }

    function checkFavStatus() {
        flash('检测开播状态…（逐个查询，稍候）');
        ensureServer().then(function () { return api('/favs/status', { timeout: 300000 }); }).then(function (d) {
            var list = (d && d.list) || [];
            // 保留状态标记
            var merged = list.map(function (x) {
                return { url: x.url, name: x.name, platform: x.platform, __live: x.isLive, __title: x.title, __err: x.error };
            });
            renderFavs(merged);
            var n = list.filter(function (x) { return x.isLive; }).length;
            flash('检测完成：' + n + ' 个正在直播');
        }).catch(function (e) { flash('检测失败：' + e.message, true); });
    }

    // ---------- 事件 ----------
    function bind() {
        if ($('lvParse')) $('lvParse').addEventListener('click', function () { parse(); });
        if ($('lvUrl')) $('lvUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') parse(); });
        if ($('lvFav')) $('lvFav').addEventListener('click', addFav);
        // 平台切换
        var pbtns = document.querySelectorAll('#panel-live .lv-plat');
        for (var pi = 0; pi < pbtns.length; pi++) {
            pbtns[pi].addEventListener('click', function () { setPlat(this.getAttribute('data-plat')); });
        }
        if ($('lvSearch')) $('lvSearch').addEventListener('click', function () { loadList(true); });
        if ($('lvKw')) $('lvKw').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadList(true); });
        if ($('lvRec')) $('lvRec').addEventListener('click', function () { $('lvKw').value = ''; loadList(true); });
        if ($('lvMore')) $('lvMore').addEventListener('click', function () { curPage++; loadList(false); });
        if ($('lvWatch')) $('lvWatch').addEventListener('click', watch);
        if ($('lvStopWatch')) $('lvStopWatch').addEventListener('click', stopWatch);
        if ($('lvExternal')) $('lvExternal').addEventListener('click', openExternal);
        if ($('lvStartRec')) $('lvStartRec').addEventListener('click', startRec);
        if ($('lvStopRec')) $('lvStopRec').addEventListener('click', stopRec);
        if ($('lvRecRefresh')) $('lvRecRefresh').addEventListener('click', refreshRecs);
        if ($('lvFavCheck')) $('lvFavCheck').addEventListener('click', checkFavStatus);
        if ($('lvOpenDir')) $('lvOpenDir').addEventListener('click', function () {
            openDir(path.join(extRoot, 'collect', 'live'));
        });
    }

    function init() {
        if (!$('lvUrl')) return;
        bind();
        // 面板加载时静默探服务（不在跑就不着急拉起，切到本板块时再起）
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // 切到本板块时：确保服务在跑，刷新录制任务与关注
    window.__liveOnShow = function () {
        ensureServer().then(function (h) {
            syncHealth(h);
            refreshRecs();
            loadFavs();
            // 首次进入自动拉一次推荐
            var grid = $('lvGrid');
            if (grid && grid.getAttribute('data-loaded') !== '1') {
                grid.setAttribute('data-loaded', '1');
                loadList(true);
            }
        }).catch(function (e) {
            syncHealth(null);
            flash(e.message, true);
        });
    };
})();
