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

    // ---------- 解析 ----------
    function parse() {
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
        $('lvRec').disabled = !canWatch;
        if (!info.isLive) $('lvWatch').disabled = true;
    }

    // ---------- 观看 ----------
    // 直播流地址带时效与防盗链，直接用 yt-dlp -g 拿一次直链喂给 <video>
    function watch() {
        if (!curInfo) return;
        var q = $('lvQuality').value || '';
        flash('获取播放地址…');
        var u = '/parse?url=' + encodeURIComponent(curInfo.roomUrl);
        ensureServer().then(function () { return api(u); }).then(function (info) {
            // 选指定画质
            var target = info.streamUrl;
            if (q) {
                var f = (info.formats || []).filter(function (x) { return x.formatId === q; })[0];
                if (f) target = f.formatId;
            }
            if (!target) throw new Error('没拿到可播放的流地址');
            curStreamUrl = target;
            var v = $('lvVideo');
            v.src = target;
            $('lvVideoMask').style.display = 'none';
            $('lvThumb').style.display = 'none';
            v.play().catch(function () {});
            $('lvStopWatch').disabled = false;
            flash('开始播放（直播流，画质取决于平台）');
        }).catch(function (e) { flash('播放失败：' + e.message, true); });
    }

    function stopWatch() {
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
            $('lvRec').disabled = true;
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
                $('lvRec').disabled = running;
                $('lvStopRec').disabled = !(mine.status === 'recording');
                if (!running) {
                    curRecId = '';
                    stopRecPoll();
                    $('lvRec').disabled = !(curInfo && curInfo.isLive);
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
        if ($('lvParse')) $('lvParse').addEventListener('click', parse);
        if ($('lvUrl')) $('lvUrl').addEventListener('keydown', function (e) { if (e.key === 'Enter') parse(); });
        if ($('lvFav')) $('lvFav').addEventListener('click', addFav);
        if ($('lvWatch')) $('lvWatch').addEventListener('click', watch);
        if ($('lvStopWatch')) $('lvStopWatch').addEventListener('click', stopWatch);
        if ($('lvRec')) $('lvRec').addEventListener('click', startRec);
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
        }).catch(function (e) {
            syncHealth(null);
            flash(e.message, true);
        });
    };
})();
