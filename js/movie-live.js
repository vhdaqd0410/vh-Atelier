// vh-Atelier 影视板块 · 直播（IPTV）
// 数据源：M3U / TXT 播放列表（TVBox 配置的 lives[] 或用户自填地址）
// 播放：复用 hls.js（同一套播放内核，直播流多为 m3u8）
(function () {
    var $ = function (id) { return document.getElementById(id); };
    if (!$('mvLiveList')) return;

    var CUR_KEY = 'vh_movie_live_cur';    // 上次选的频道
    var GROUPS_KEY = 'vh_movie_live_grp'; // 上次选的分组

    var channels = [];      // 全部频道 [{name,group,logo,url}]
    var curGroup = '';
    var curCh = null;
    var hls = null;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function flash(msg) {
        try {
            var t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;left:50%;top:44%;transform:translateX(-50%);' +
                'background:rgba(20,24,20,.95);color:#9fe0ab;border:1px solid rgba(127,214,139,.4);' +
                'padding:8px 16px;border-radius:8px;font-size:12px;z-index:10060;pointer-events:none;';
            document.body.appendChild(t);
            setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2400);
        } catch (e) {}
    }
    function setState(t, cls) {
        var el = $('mvLiveState');
        if (el) { el.textContent = t || ''; el.className = 'mv-state' + (cls ? ' ' + cls : ''); }
    }

    // 通过代理取文本（直播源多无 CORS）
    function proxyFetchText(url, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            var full = 'http://47.122.108.231:17897/proxy?url=' + encodeURIComponent(url);
            xhr.open('GET', full, true);
            xhr.timeout = timeoutMs || 20000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) { reject(new Error('连不上代理')); return; }
                if (xhr.status !== 200) { reject(new Error('HTTP ' + xhr.status)); return; }
                resolve(xhr.responseText || '');
            };
            xhr.onerror = function () { reject(new Error('请求失败')); };
            xhr.ontimeout = function () { reject(new Error('超时')); };
            xhr.send();
        });
    }

    // 加载所有已配置的直播源，合并频道
    function loadAll() {
        var box = $('mvLiveList');
        if (!box) return;
        var srcs = window.__vhTvbox ? window.__vhTvbox.loadLives() : [];
        if (!srcs.length) {
            box.innerHTML = '<div class="hint mv-empty">还没有直播源<br>点上方「📺 直播源」添加，或到「⚙ 源管理」导入 TVBox 配置</div>';
            setState('无直播源');
            return;
        }
        setState('加载 ' + srcs.length + ' 个直播源…');
        box.innerHTML = '<div class="hint mv-empty">正在加载频道…</div>';
        channels = [];
        var n = 0;
        srcs.forEach(function (s) {
            proxyFetchText(s.url, 25000).then(function (txt) {
                var list = window.__vhTvbox.parsePlaylist(txt);
                list.forEach(function (c) {
                    c.srcName = s.name;
                    c.ua = s.ua || '';
                    c.epg = s.epg || '';
                    channels.push(c);
                });
            }).catch(function () {
                // 单源失败不影响其他源
            }).then(function () {
                n++;
                if (n === srcs.length) render();
            });
        });
    }

    function render() {
        var box = $('mvLiveList');
        if (!box) return;
        if (!channels.length) {
            box.innerHTML = '<div class="hint mv-empty">频道列表为空（源可能失效）</div>';
            setState('无频道', 'err');
            return;
        }
        // 分组
        var groups = {};
        channels.forEach(function (c) {
            var g = c.group || '未分组';
            (groups[g] = groups[g] || []).push(c);
        });
        var names = Object.keys(groups);
        // 分组条
        var gb = $('mvLiveGroups');
        if (gb) {
            gb.innerHTML = '';
            if (!curGroup || names.indexOf(curGroup) < 0) {
                curGroup = '';
                try { curGroup = localStorage.getItem(GROUPS_KEY) || ''; } catch (e) {}
                if (names.indexOf(curGroup) < 0) curGroup = '';
            }
            var all = document.createElement('button');
            all.className = 'mv-grp' + (!curGroup ? ' on' : '');
            all.textContent = '全部 ' + channels.length;
            all.addEventListener('click', function () { curGroup = ''; saveCurGroup(); render(); });
            gb.appendChild(all);
            names.forEach(function (g) {
                var b = document.createElement('button');
                b.className = 'mv-grp' + (curGroup === g ? ' on' : '');
                b.textContent = g + ' ' + groups[g].length;
                b.title = g;
                b.addEventListener('click', function () { curGroup = g; saveCurGroup(); render(); });
                gb.appendChild(b);
            });
        }
        // 频道列表
        var show = curGroup ? (groups[curGroup] || []) : channels;
        box.innerHTML = '';
        show.forEach(function (c) {
            var row = document.createElement('div');
            row.className = 'mv-live-item' + (curCh && curCh.url === c.url ? ' on' : '');
            row.innerHTML = '<span class="mv-live-ic">📺</span><span class="mv-live-nm"></span>';
            row.querySelector('.mv-live-nm').textContent = c.name;
            row.title = (c.group || '') + ' · ' + c.srcName;
            row.addEventListener('click', function () { play(c); });
            box.appendChild(row);
        });
        setState('共 ' + channels.length + ' 频道 · ' + names.length + ' 分组', 'ok');
    }

    function saveCurGroup() {
        try { localStorage.setItem(GROUPS_KEY, curGroup || ''); } catch (e) {}
    }

    // ---------- 播放 ----------
    function play(c) {
        curCh = c;
        try { localStorage.setItem(CUR_KEY, JSON.stringify({ name: c.name, url: c.url, group: c.group })); } catch (e) {}
        var v = $('mvVideo');
        if (!v) return;
        $('mvPlayer').style.display = '';
        $('mvPlayerTitle').textContent = '📺 ' + c.name;
        $('mvPlayerInfo').textContent = (c.group || '') + '　' + c.srcName;
        bufShow('正在连接直播流…');
        render();

        // 直播流：先把地址交给 hls.js；跨域时经代理
        var raw = c.url;
        var playUrl = raw;
        try {
            var clear = raw.indexOf('http://') === 0 || raw.indexOf('https://') === 0;
            // 直接给原始地址，若失败在 ERROR 回调里换代理
            if (!clear) playUrl = raw;
        } catch (e) {}

        startHls(playUrl, raw, c);
    }

    function startHls(playUrl, rawUrl, c) {
        var v = $('mvVideo');
        try { if (hls) { hls.destroy(); hls = null; } } catch (e) {}
        var Hls = window.Hls;
        if (!Hls || !Hls.isSupported()) {
            // 退化：直接喂给 video（Chromium 不支持原生 HLS，基本会失败，但留个兜底）
            v.src = playUrl;
            v.play && v.play().catch(function () {});
            bufHide();
            return;
        }
        var triedProxy = false;
        hls = new Hls({
            liveDurationInfinity: true,
            maxBufferLength: 20,
            manifestLoadingTimeOut: 15000,
            fragLoadingTimeOut: 25000
        });
        hls.attachMedia(v);
        hls.on(Hls.Events.MEDIA_ATTACHED, function () { hls.loadSource(playUrl); });
        hls.on(Hls.Events.MANIFEST_PARSED, function () {
            bufHide();
            v.play().catch(function () {});
        });
        hls.on(Hls.Events.ERROR, function (evt, data) {
            if (!data || !data.fatal) return;
            // 首次失败：换成经代理的地址重试一次
            if (!triedProxy) {
                triedProxy = true;
                bufShow('直连失败，改用代理重试…');
                try { hls.destroy(); } catch (e) {}
                var viaProxy = 'http://47.122.108.231:17897/proxy?url=' + encodeURIComponent(rawUrl);
                startHlsFinal(viaProxy);
                return;
            }
            bufShow('直播播放失败：' + (data.details || data.type), true);
        });
    }

    function startHlsFinal(url) {
        var v = $('mvVideo');
        hls = new Hls({ liveDurationInfinity: true, maxBufferLength: 20 });
        hls.attachMedia(v);
        hls.on(Hls.Events.MEDIA_ATTACHED, function () { hls.loadSource(url); });
        hls.on(Hls.Events.MANIFEST_PARSED, function () { bufHide(); v.play().catch(function () {}); });
        hls.on(Hls.Events.ERROR, function (evt, data) {
            if (data && data.fatal) bufShow('直播播放失败：' + (data.details || data.type), true);
        });
    }

    function bufShow(msg, isErr) {
        var b = $('mvBuf');
        if (!b) return;
        b.style.display = '';
        $('mvBufMsg').textContent = msg || '加载中…';
        $('mvBufMsg').style.color = isErr ? '#f6a1b1' : '';
        $('mvBufSub').textContent = isErr ? '可换个频道或检查源' : '';
    }
    function bufHide() { var b = $('mvBuf'); if (b) b.style.display = 'none'; }

    // ---------- 直播源管理弹层 ----------
    function renderLiveSrcList() {
        var box = $('mvLiveSrcList');
        if (!box || !window.__vhTvbox) return;
        var arr = window.__vhTvbox.loadLives();
        box.innerHTML = '';
        if (!arr.length) { box.innerHTML = '<div class="hint" style="padding:6px;">暂无直播源</div>'; return; }
        arr.forEach(function (s) {
            var row = document.createElement('div');
            row.className = 'mv-mgr-row';
            row.innerHTML = '<span class="mv-mgr-name"></span><span class="mv-mgr-api"></span>';
            row.querySelector('.mv-mgr-name').textContent = s.name;
            row.querySelector('.mv-mgr-api').textContent = s.url;
            row.querySelector('.mv-mgr-api').title = s.url;
            var del = document.createElement('button');
            del.className = 'tbtn';
            del.textContent = '删除';
            del.style.cssText = 'padding:2px 8px;font-size:11px;color:#f6a1b1;';
            del.addEventListener('click', function () {
                window.__vhTvbox.removeLive(s.url);
                renderLiveSrcList();
                loadAll();
            });
            row.appendChild(del);
            box.appendChild(row);
        });
    }

    function bindLiveSrcMgr() {
        var b = $('mvLiveSrcMgr');
        if (b) b.addEventListener('click', function () {
            $('mvLiveSrcBox').style.display = '';
            renderLiveSrcList();
        });
        b = $('mvLiveSrcClose');
        if (b) b.addEventListener('click', function () { $('mvLiveSrcBox').style.display = 'none'; });
        b = $('mvLiveSrcAdd');
        if (b) b.addEventListener('click', function () {
            var nm = ($('mvLiveSrcName').value || '').trim();
            var u = ($('mvLiveSrcUrl').value || '').trim();
            var r = window.__vhTvbox.addLive({ name: nm || '直播源', url: u });
            if (!r.ok) { flash(r.msg); return; }
            $('mvLiveSrcName').value = '';
            $('mvLiveSrcUrl').value = '';
            renderLiveSrcList();
            flash('已添加，正在加载频道…');
            loadAll();
        });
    }

    // 对外：彻底停掉直播（销毁自己的 hls；video 元素由 movie.js 统一处理）
    function stop() {
        try { if (hls) { hls.destroy(); hls = null; } } catch (e) {}
        curCh = null;
        try { render(); } catch (e) {}
    }

    window.__mvLive = {
        loadAll: loadAll,
        bind: bindLiveSrcMgr,
        renderSrcList: renderLiveSrcList,
        stop: stop
    };
})();
