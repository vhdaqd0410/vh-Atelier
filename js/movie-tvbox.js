// vh-Atelier 影视板块 · TVBox 配置解析
//
// 背景：TVBox / OK影视 的配置是 JSON，里面有两类东西：
//   sites[] 点播源 —— type=1 是苹果CMS标准接口（网页能直接请求）；
//                      type=3 是 spider（csp_XXX），依赖 Android 的 classes.dex
//                      + ARM .so + 加固壳，PC/浏览器里跑不了，只能跳过。
//   lives[] 直播源 —— type=0，url 指向 M3U/TXT 播放列表，标准格式，网页可用。
//
// 所以本模块的策略：
//   - 点播：只收 type=1（含 api 是 http(s) 地址 或 ac= 参数的），并进点播源列表
//   - 直播：全部收（url 是 http(s) 或相对路径），作为直播源列表
//   - type=3 统计数量后明确告知用户「跳过 N 个需 Android spider 的源」
(function () {
    var SITES_KEY = 'vh_movie_sites';
    var LIVE_KEY = 'vh_movie_lives';   // 直播源列表

    function isHttp(u) { return /^https?:\/\//i.test(String(u || '').trim()); }

    // 判断一个 site 是否是「网页能直接用」的点播源
    function usableVod(s) {
        if (!s || typeof s !== 'object') return false;
        var t = s.type;
        // type 1 = 普通接口；type 0 有时也是普通接口
        var isPlain = (t === 1 || t === 0 || t === '1' || t === '0');
        if (!isPlain) return false;
        return isHttp(s.api) || isHttp(s.ext);
    }

    // 解析 TVBox 配置对象 → { vod: [...], live: [...], skipped: N, stats: {} }
    function parseConfig(json, baseUrl) {
        var out = { vod: [], live: [], skipped: 0, stats: {} };
        if (!json || typeof json !== 'object') return out;

        // ---------- 点播 ----------
        var sites = json.sites || json.sites2 || [];
        if (!Array.isArray(sites)) sites = [];
        var n3 = 0, n1 = 0, nOther = 0;
        sites.forEach(function (s) {
            if (usableVod(s)) {
                var api = String(s.api || s.ext || '').trim().replace(/\/+$/, '');
                out.vod.push({
                    key: String(s.key || s.name || api).trim(),
                    name: String(s.name || api).trim(),
                    api: api
                });
                n1++;
            } else if (String(s.type) === '3') {
                n3++;                       // 需要 Android spider，跳过
            } else {
                nOther++;
            }
        });
        out.skipped = n3;
        out.stats.vodTotal = sites.length;
        out.stats.vodUsable = n1;
        out.stats.vodSpider = n3;
        out.stats.vodOther = nOther;

        // ---------- 直播 ----------
        var lives = json.lives || json.lives2 || [];
        if (!Array.isArray(lives)) lives = [];
        lives.forEach(function (l) {
            if (!l || typeof l !== 'object') return;
            var u = String(l.url || '').trim();
            if (!u) return;
            // 相对路径（如 ./list.txt）按配置所在地址补全
            if (!isHttp(u) && baseUrl) {
                try { u = new URL(u.replace(/^\.\//, ''), baseUrl).href; } catch (e) { return; }
            }
            if (!isHttp(u)) return;
            out.live.push({
                name: String(l.name || '直播源').trim(),
                url: u,
                ua: l.ua || '',
                epg: l.epg || (typeof l.ext === 'string' ? l.ext : '')
            });
        });
        out.stats.liveTotal = (json.lives || []).length;
        out.stats.liveUsable = out.live.length;
        return out;
    }

    // 把解析出的点播源并进本地点播源列表（去重）
    function mergeVod(vodList) {
        var added = 0;
        var list;
        try { list = JSON.parse(localStorage.getItem(SITES_KEY) || '[]'); } catch (e) { list = []; }
        if (!Array.isArray(list) || !list.length) {
            // 没配置过就用内置默认（与 movie-sites.js 保持一致的前 6 个）
            list = [
                { key: 'ffzy', name: '非凡影视', api: 'http://ffzy5.tv' },
                { key: 'zy360', name: '360资源', api: 'https://360zy.com' },
                { key: 'jisu', name: '极速资源', api: 'https://jszyapi.com' },
                { key: 'bfzy', name: '暴风资源', api: 'https://bfzyapi.com' },
                { key: 'mdzy', name: '魔都资源', api: 'https://www.mdzyapi.com' },
                { key: 'ruyi', name: '如意资源', api: 'https://cj.rycjapi.com' }
            ];
        }
        function host(u) {
            return String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '').split('/')[0];
        }
        var have = {};
        list.forEach(function (x) { have[host(x.api)] = true; });
        (vodList || []).forEach(function (v) {
            var h = host(v.api);
            if (!h || have[h]) return;
            have[h] = true;
            list.push(v);
            added++;
        });
        try { localStorage.setItem(SITES_KEY, JSON.stringify(list)); } catch (e) {}
        return { added: added, total: list.length };
    }

    // ---------- 直播源存取 ----------
    function loadLives() {
        try {
            var raw = localStorage.getItem(LIVE_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function saveLives(arr) {
        try { localStorage.setItem(LIVE_KEY, JSON.stringify(arr || [])); } catch (e) {}
    }
    function addLive(src) {
        if (!src || !isHttp(src.url)) return { ok: false, msg: '直播源地址无效' };
        var arr = loadLives();
        if (arr.some(function (x) { return x.url === src.url; })) return { ok: false, msg: '该直播源已存在' };
        arr.push({ name: String(src.name || '直播源').trim(), url: src.url, ua: src.ua || '', epg: src.epg || '' });
        saveLives(arr);
        return { ok: true, list: arr };
    }
    function removeLive(url) {
        var arr = loadLives().filter(function (x) { return x.url !== url; });
        saveLives(arr);
        return arr;
    }

    // ---------- M3U / TXT 播放列表解析 ----------
    // 支持三种常见写法：
    //   1) 标准 M3U：#EXTM3U  + #EXTINF:-1 tvg-logo="..." group-title="央视",CCTV1  + 流地址
    //   2) 简单 TXT：分组行（如「央视频道,#genre#」）+ 每行「频道名,流地址」
    //   3) 混合：只要有 #EXTINF 就按 M3U 走
    function parsePlaylist(text) {
        var out = [];
        text = String(text || '').replace(/^\uFEFF/, '');
        if (/#EXTINF/i.test(text)) {
            // ---- M3U ----
            var lines = text.split(/\r?\n/);
            var cur = null;
            for (var i = 0; i < lines.length; i++) {
                var ln = lines[i].trim();
                if (!ln) continue;
                if (/^#EXTINF/i.test(ln)) {
                    var name = (ln.split(',').pop() || '').trim();
                    var logo = (ln.match(/tvg-logo="([^"]*)"/i) || [])[1] || '';
                    var group = (ln.match(/group-title="([^"]*)"/i) || [])[1] || '未分组';
                    var tvg = (ln.match(/tvg-id="([^"]*)"/i) || [])[1] || '';
                    cur = { name: name || '未命名', logo: logo, group: group, tvgId: tvg };
                } else if (ln.charAt(0) !== '#') {
                    if (cur) { cur.url = ln; out.push(cur); cur = null; }
                }
            }
        } else {
            // ---- TXT：分组,#genre#  /  频道名,地址 ----
            var lines2 = text.split(/\r?\n/);
            var grp = '未分组';
            for (var k = 0; k < lines2.length; k++) {
                var l2 = lines2[k].trim();
                if (!l2 || l2.charAt(0) === '#') continue;
                var parts = l2.split(',');
                if (parts.length >= 2 && /#genre#/i.test(parts[1])) {
                    grp = parts[0].trim() || '未分组';
                    continue;
                }
                if (parts.length >= 2) {
                    var nm = parts[0].trim();
                    var url = parts.slice(1).join(',').trim();
                    if (nm && isHttp(url)) out.push({ name: nm, group: grp, logo: '', tvgId: '', url: url });
                }
            }
        }
        return out;
    }

    window.__vhTvbox = {
        parseConfig: parseConfig,
        mergeVod: mergeVod,
        loadLives: loadLives,
        saveLives: saveLives,
        addLive: addLive,
        removeLive: removeLive,
        parsePlaylist: parsePlaylist
    };
})();
