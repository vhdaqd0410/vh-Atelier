// vh-Atelier 影视板块：在线影视搜索 + 播放
// 架构：插件面板 → 自建 CORS 代理(17897) → 第三方采集站(苹果CMS) → m3u8 流
//   1) 采集站不返回 CORS 头，浏览器直连会被拦，故走自建代理；
//   2) CEP 的 Chromium 不支持原生 HLS，用本地打包的 hls.js 播放；
//   3) 部分源分片是 AES-128 加密，hls.js 会自动取 key 解密。
(function () {
    var $ = function (id) { return document.getElementById(id); };
    if (!$('panel-movie')) return;   // 不在主插件里

    // ---------- 配置 ----------
    var PROXY = 'http://47.122.108.231:17897/';   // 自建 CORS 代理
    var PROXY_KEY = 'vh_movie_proxy';

    // 采集源：优先用可配置的源（js/movie-sites.js），没有则用内置默认
    function sites() {
        try {
            if (window.__vhMovieSites) return window.__vhMovieSites.load();
        } catch (e) {}
        return [];
    }

    var SEARCH_PATH = '/api.php/provide/vod/?ac=detail&wd=';
    // 首页推荐：无 wd 参数即返回最新/热播列表
    var RECOMMEND_PATH = '/api.php/provide/vod/?ac=detail&pg=1';

    // 是否走代理直连源站：部分源站自带 CORS（如暴风/魔都），
    // 直连可绕开服务器出口带宽瓶颈（实测服务器出口仅 ~3Mbps）。
    // 策略：先直连试一次，失败再回退到代理。检测结果缓存在内存里。
    var directOk = {};   // host -> true/false

    function proxy() {
        try { return localStorage.getItem(PROXY_KEY) || PROXY; } catch (e) { return PROXY; }
    }

    // ---------- 工具 ----------
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function setState(t, cls) {
        var el = $('mvState');
        if (el) { el.textContent = t || ''; el.className = 'mv-state' + (cls ? ' ' + cls : ''); }
    }
    function flash(msg) {
        try {
            var t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;left:50%;top:44%;transform:translateX(-50%);' +
                'background:rgba(20,24,20,.95);color:#9fe0ab;border:1px solid rgba(127,214,139,.4);' +
                'padding:8px 16px;border-radius:8px;font-size:12px;z-index:10050;pointer-events:none;';
            document.body.appendChild(t);
            setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2400);
        } catch (e) {}
    }

    // 通过代理请求（统一走 /proxy?url= 形式，避免路径编码歧义）
    function apiGet(url, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            var full = proxy() + 'proxy?url=' + encodeURIComponent(url);
            xhr.open('GET', full, true);
            xhr.timeout = timeoutMs || 20000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) { reject(new Error('连不上代理')); return; }
                if (xhr.status !== 200) { reject(new Error('HTTP ' + xhr.status)); return; }
                try { resolve(JSON.parse(xhr.responseText)); }
                catch (e) { reject(new Error('响应不是 JSON')); }
            };
            xhr.onerror = function () { reject(new Error('代理请求失败')); };
            xhr.ontimeout = function () { reject(new Error('超时')); };
            xhr.send();
        });
    }

    // 直连优先：先试源站（部分源自带 CORS），失败再走代理。
    // 目的：把流量从服务器那 3Mbps 出口引开，缓解播放卡顿。
    function xhrGet(url, timeoutMs) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.timeout = timeoutMs || 15000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) { reject(new Error('CORS/网络拦截')); return; }
                if (xhr.status !== 200) { reject(new Error('HTTP ' + xhr.status)); return; }
                resolve(xhr.responseText);
            };
            xhr.onerror = function () { reject(new Error('直连失败')); };
            xhr.ontimeout = function () { reject(new Error('直连超时')); };
            xhr.send();
        });
    }

    // 取 JSON：直连可行就直连，否则走代理；结果按 host 缓存避免重复试错
    function fetchJson(url, timeoutMs) {
        var host = '';
        try { host = new URL(url).host; } catch (e) {}
        if (host && directOk[host] === true) {
            return xhrGet(url, timeoutMs).then(function (t) { return JSON.parse(t); });
        }
        if (host && directOk[host] === false) {
            return apiGet(url, timeoutMs);
        }
        // 未知：先直连，失败则记下并回退代理
        return xhrGet(url, Math.min(timeoutMs || 15000, 8000)).then(function (t) {
            if (host) directOk[host] = true;
            return JSON.parse(t);
        }).catch(function () {
            if (host) directOk[host] = false;
            return apiGet(url, timeoutMs);
        });
    }

    // 播放地址取用：直连优先（但必须针对「视频站域名」单独探，
    // 不能复用搜索时的判断——搜索走采集站域名，与视频流域名不同）。
    function playUrlFor(rawUrl) {
        var host = '';
        try { host = new URL(rawUrl).host; } catch (e) {}
        if (host && directOk[host] === true) return rawUrl;
        return proxy() + 'proxy?url=' + encodeURIComponent(rawUrl);
    }

    // 探测视频站是否可直接拉流（带 CORS）：能直连就不绕服务器。
    // 服务器出口带宽实测仅 ~3Mbps，绕一圈容易卡；直连可显著缓解。
    function probeDirect(rawUrl, cb) {
        var host = '';
        try { host = new URL(rawUrl).host; } catch (e) { return cb(false); }
        if (directOk[host] === true) return cb(true);
        if (directOk[host] === false) return cb(false);
        var xhr = new XMLHttpRequest();
        xhr.open('GET', rawUrl, true);
        xhr.timeout = 6000;
        xhr.onreadystatechange = function () {
            // 只关心能否拿到响应（分片/清单开头即可），拿到就断开
            if (xhr.readyState >= 2) {
                try { xhr.abort(); } catch (e) {}
                if (xhr.status === 200 || xhr.status === 206) { directOk[host] = true; cb(true); }
                else { directOk[host] = false; cb(false); }
            }
        };
        xhr.onerror = function () { directOk[host] = false; cb(false); };
        xhr.ontimeout = function () { directOk[host] = false; cb(false); };
        try { xhr.send(); } catch (e) { directOk[host] = false; cb(false); }
    }

    // ---------- 搜索 ----------
    var lastResults = [];

    function search() {
        var q = ($('mvQuery') && $('mvQuery').value || '').trim();
        if (!q) { flash('请输入片名'); return; }
        var box = $('mvResults');
        box.innerHTML = '<div class="hint mv-empty">正在聚合搜索…</div>';
        setState('搜索中…');

        var done = 0, all = [];
        var list0 = sites();
        var total = list0.length;
        if (!total) { box.innerHTML = '<div class="hint mv-empty">没有可用源，请到「源管理」添加</div>'; return; }
        list0.forEach(function (site) {
            var u = site.api + SEARCH_PATH + encodeURIComponent(q);
            fetchJson(u, 20000).then(function (j) {
                var list = (j && j.list) || [];
                list.forEach(function (it) {
                    all.push({
                        site: site.key, siteName: site.name,
                        id: it.vod_id, name: it.vod_name, sub: it.vod_sub,
                        pic: it.vod_pic, remarks: it.vod_remarks,
                        year: it.vod_year, area: it.vod_area,
                        actor: it.vod_actor, score: it.vod_douban_score,
                        playFrom: it.vod_play_from, playUrl: it.vod_play_url
                    });
                });
            }).catch(function () {
                // 单源失败不影响整体
            }).then(function () {
                done++;
                setState('已完成 ' + done + '/' + total + ' 个源，共 ' + all.length + ' 条');
                if (done === total) renderResults(all, q);
            });
        });
    }

    function renderResults(list, q) {
        var box = $('mvResults');
        if (!list.length) {
            box.innerHTML = '<div class="hint mv-empty">没搜到「' + esc(q) + '」<br>换个片名试试，或换个源</div>';
            setState('无结果', 'err');
            return;
        }
        // 按片名归组（同片不同源合并）
        var groups = {};
        list.forEach(function (it) {
            var k = String(it.name || '').replace(/\s+/g, '');
            if (!groups[k]) groups[k] = { name: it.name, items: [] };
            groups[k].items.push(it);
        });
        var arr = Object.keys(groups).map(function (k) { return groups[k]; });
        // 条目多的（通常更完整）排前面
        arr.sort(function (a, b) { return b.items.length - a.items.length; });
        lastResults = arr;

        box.innerHTML = '';
        arr.forEach(function (g) {
            var it = g.items[0];
            var direct = g.items.some(function (x) { return isDirectSrc(x); });
            var card = document.createElement('div');
            card.className = 'mv-card' + (direct ? '' : ' mv-cantplay');
            var pic = it.pic ? ('<img src="' + esc(it.pic) + '" onerror="this.style.visibility=\'hidden\'">') : '<div class="mv-nopic">🎬</div>';
            card.innerHTML =
                '<div class="mv-cover">' + pic + '</div>' +
                '<div class="mv-meta">' +
                    '<div class="mv-name">' + esc(g.name) + '</div>' +
                    '<div class="mv-sub">' + esc([it.year, it.area, it.remarks].filter(Boolean).join(' · ')) + '</div>' +
                    '<div class="mv-srcs">' + g.items.map(function (x) {
                        var ok2 = isDirectSrc(x);
                        return '<span class="mv-src' + (ok2 ? '' : ' mv-src-no') + '" title="'
                            + (ok2 ? '可直接播放' : '该源为网页播放页，插件里播不了') + '">'
                            + esc(x.siteName) + (ok2 ? '' : ' ⊘') + '</span>';
                    }).join('') + '</div>' +
                '</div>';
            card.addEventListener('click', function () {
                if (!direct) { flash('这部暂时只能拿到网页地址，插件里放不了'); }
                if (g.items.length === 1) openPick(g.items[0]);
                else openPickMulti(g);
            });
            box.appendChild(card);
        });
        setState('共 ' + arr.length + ' 部（' + list.length + ' 条来源）', 'ok');
    }

    // ---------- 选集/选线路 ----------
    var pickState = null;

    function openPickMulti(g) {
        // 多源同片：列出源供选，并异步测速，默认选最快的可播源。
        var ov = $('mvPick'), tt = $('mvPickTitle'), srcBox = $('mvPickSrc'), epsBox = $('mvPickEps');
        $('mvPick').style.display = '';
        tt.textContent = g.name + ' · 选择来源（自动测速）';
        srcBox.innerHTML = '';
        epsBox.innerHTML = '<div class="hint" style="padding:8px;">正在测速…</div>';

        // 只为「有直链」的源建按钮，并记录按钮引用
        var entries = [];
        g.items.forEach(function (it) {
            var ok2 = isDirectSrc(it);
            var b = document.createElement('button');
            b.className = 'tbtn mv-pickbtn' + (ok2 ? '' : ' mv-nodirect');
            b.textContent = it.siteName + (ok2 ? ' …' : '（非直链）');
            b.title = ok2 ? '等待测速' : '该源返回的是网页播放页，插件里播不了';
            b.disabled = !ok2;
            b.addEventListener('click', function () {
                Array.prototype.forEach.call(srcBox.children, function (c) { c.classList.remove('on'); });
                b.classList.add('on');
                renderEps(it);
            });
            srcBox.appendChild(b);
            if (ok2) entries.push({ item: it, btn: b });
        });

        if (!entries.length) {
            epsBox.innerHTML = '<div class="hint" style="padding:8px;">该片暂无可直接播放的源</div>';
            return;
        }

        // 并发测速：取第一个分片的字节数/耗时 算 KB/s
        var results = [];
        var pending = entries.length;
        entries.forEach(function (e2) {
            speedOf(e2.item, function (kbps) {
                e2.speed = kbps;
                e2.btn.textContent = e2.item.siteName + (kbps > 0 ? (' ' + kbps + ' KB/s') : ' 测速失败');
                e2.btn.title = kbps > 0 ? ('实测 ' + kbps + ' KB/s') : '测速失败，仍可尝试播放';
                results.push(e2);
                pending--;
                if (pending === 0) done();
            });
        });

        function done() {
            // 按时速降序排按钮，选最快的并直接渲染集数
            results.sort(function (a, b) { return (b.speed || 0) - (a.speed || 0); });
            srcBox.innerHTML = '';
            results.forEach(function (e3) { srcBox.appendChild(e3.btn); });
            // 非直链的排在后面（不可点）
            g.items.forEach(function (it) {
                if (isDirectSrc(it)) return;
                var b2 = document.createElement('button');
                b2.className = 'tbtn mv-pickbtn mv-nodirect';
                b2.textContent = it.siteName + '（非直链）';
                b2.disabled = true;
                srcBox.appendChild(b2);
            });
            var best = results[0];
            if (best) {
                best.btn.classList.add('on');
                best.btn.textContent = best.item.siteName + (best.speed > 0 ? (' ' + best.speed + ' KB/s ★') : ' ★');
                try { renderEps(best.item); } catch (e) {}
            }
        }
    }

    // 测一个源的播放速度：取第一集 m3u8，量下载耗时与字节数。
    // 返回约整的 KB/s（拿不到算 0）。
    function speedOf(item, cb) {
        var eps = playableEps(item);
        if (!eps.length) return cb(0);
        var raw = eps[0].url;
        var host = '';
        try { host = new URL(raw).host; } catch (e) {}
        var testUrl = (host && directOk[host] === true) ? raw
            : proxy() + 'proxy?url=' + encodeURIComponent(raw);
        var t0 = Date.now();
        var xhr = new XMLHttpRequest();
        xhr.open('GET', testUrl, true);
        xhr.timeout = 8000;
        xhr.onreadystatechange = function () {
            // 收够 200KB 或结束时算速度
            if (xhr.readyState === 4) { finish(); }
        };
        xhr.onprogress = function (e) {
            if (e.loaded >= 200000) { try { xhr.abort(); } catch (er) {} finish(); }
        };
        xhr.onerror = function () { cb(0); };
        xhr.ontimeout = function () { finish(); };
        var finished = false;
        function finish() {
            if (finished) return;
            finished = true;
            var dt = (Date.now() - t0) / 1000;
            var len = 0;
            try { len = (xhr.responseText || '').length; } catch (e) {}
            if (!len) { try { len = xhr.response ? (xhr.response.byteLength || xhr.response.length || 0) : 0; } catch (e) {} }
            if (dt <= 0 || !len) return cb(0);
            cb(Math.round(len / 1024 / dt));
        }
        try { xhr.send(); } catch (e) { cb(0); }
    }

    function openPick(it) {
        $('mvPick').style.display = '';
        $('mvPickTitle').textContent = it.name + ' · ' + it.siteName;
        $('mvPickSrc').innerHTML = '';
        renderEps(it);
    }

    // 解析 vod_play_url：格式 "集名$地址#集名$地址"
    function parseEps(it) {
        var out = [];
        var s = String(it.playUrl || '');
        s.split('#').forEach(function (seg) {
            var p = seg.indexOf('$');
            if (p < 0) return;
            var name = seg.slice(0, p).trim();
            var url = seg.slice(p + 1).trim();
            if (url) out.push({ name: name || ('第' + (out.length + 1) + '集'), url: url });
        });
        return out;
    }

    // 是否可直接播放：只看 m3u8 流。
    // 有些源给的是网页播放页（如 https://vv.jisuzyv.com/play/xxx），
    // 那种需要跑页面脚本才能拿到真实流，插件里播不了，直接标出来避免用户踩坑。
    function playableEps(it) {
        var eps = parseEps(it);
        return eps.filter(function (e) { return /\.m3u8(\?|#|$)/i.test(e.url); });
    }
    function isDirectSrc(it) { return playableEps(it).length > 0; }

    function renderEps(it) {
        var box = $('mvPickEps');
        var all = parseEps(it);
        var eps = playableEps(it);
        if (!all.length) {
            box.innerHTML = '<div class="hint" style="padding:8px;">该来源没解析出播放地址</div>';
            return;
        }
        if (!eps.length) {
            box.innerHTML = '<div class="hint" style="padding:8px;line-height:1.8;">'
                + '该来源（' + esc(it.siteName) + '）返回的是网页播放页，不是直链，插件里无法直接播放。<br>'
                + '请换一个标了「非直链」以外 的来源试试。</div>';
            return;
        }
        box.innerHTML = '';
        var head = document.createElement('div');
        head.className = 'mv-eps-head';
        head.textContent = '共 ' + eps.length + ' 集，点即播'
            + (all.length > eps.length ? ('（另 ' + (all.length - eps.length) + ' 集为网页地址，已过滤）') : '');
        box.appendChild(head);
        var grid = document.createElement('div');
        grid.className = 'mv-eps-grid';
        eps.forEach(function (e, i) {
            var b = document.createElement('button');
            b.className = 'mv-ep';
            b.textContent = String(i + 1);
            b.title = e.name;
            b.addEventListener('click', function () {
                $('mvPick').style.display = 'none';
                play(it, e, eps, i);
            });
            grid.appendChild(b);
        });
        box.appendChild(grid);
        pickState = { item: it, eps: eps };
    }

    // ---------- 播放 ----------
    var hls = null;
    var curPlay = null;   // { item, eps, idx }

    function play(item, ep, eps, idx) {
        var v = $('mvVideo');
        if (!v) return;
        curPlay = { item: item, eps: eps || [ep], idx: idx || 0 };
        $('mvPlayer').style.display = '';
        $('mvPlayerTitle').textContent = item.name + ' · ' + ep.name;
        $('mvPlayerInfo').textContent = item.siteName + '　' + (item.remarks || '');
        bufShow('正在解析播放地址…');

        // 先探视频站能否直连；能直连就把原始地址交给 hls.js，
        // 不绕服务器（服务器出口带宽仅 ~3Mbps，绕一圈容易卡）。
        // 直连时 hls.js 自己按原始地址解析相对路径，无需代理改写。
        probeDirect(ep.url, function (direct) {
            var playUrl = direct ? ep.url : playUrlFor(ep.url);
            startPlay(playUrl, direct);
        });
        return;
    }

    function startPlay(playUrl, direct) {
        var v = $('mvVideo');
        bufShow(direct ? '正在加载（直连）…' : '正在加载（经代理）…');

        try {
            if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
        } catch (e) {}

        var Hls = window.Hls;
        var canNative = v.canPlayType('application/vnd.apple.mpegurl');
        if (Hls && Hls.isSupported()) {
            hls = new Hls({
                maxBufferLength: 30,
                manifestLoadingTimeOut: 20000,
                fragLoadingTimeOut: 30000
            });
            hls.attachMedia(v);
            hls.on(Hls.Events.MEDIA_ATTACHED, function () { hls.loadSource(playUrl); });
            hls.on(Hls.Events.MANIFEST_PARSED, function () {
                bufHide();
                v.play().catch(function () {});
            });
            hls.on(Hls.Events.ERROR, function (evt, data) {
                if (data && data.fatal) {
                    bufShow('播放出错：' + (data.details || data.type), true);
                }
            });
        } else if (canNative) {
            v.src = playUrl;
            v.addEventListener('loadedmetadata', function once() {
                v.removeEventListener('loadedmetadata', once);
                bufHide();
                v.play().catch(function () {});
            });
            v.addEventListener('error', function () { bufShow('播放失败（浏览器不支持或地址失效）', true); });
        } else {
            bufShow('当前环境不支持 HLS 播放', true);
        }
    }

    function bufShow(msg, isErr) {
        var b = $('mvBuf');
        if (!b) return;
        b.style.display = '';
        $('mvBufMsg').textContent = msg || '加载中…';
        $('mvBufMsg').style.color = isErr ? '#f6a1b1' : '';
        $('mvBufSub').textContent = isErr ? '可换一个来源试试' : '';
    }
    function bufHide() { var b = $('mvBuf'); if (b) b.style.display = 'none'; }

    function nextEp() {
        if (!curPlay) return;
        var i = curPlay.idx + 1;
        if (i >= curPlay.eps.length) { flash('已经是最后一集'); return; }
        play(curPlay.item, curPlay.eps[i], curPlay.eps, i);
    }

    // ---------- 源管理 ----------
    function mgrHint(t, isErr) {
        var el = $('mvMgrHint');
        if (el) { el.textContent = t || ''; el.style.color = isErr ? '#f6a1b1' : '#7fd68b'; }
    }

    function renderSiteList() {
        var box = $('mvSiteList');
        if (!box || !window.__vhMovieSites) return;
        var list = window.__vhMovieSites.load();
        box.innerHTML = '';
        if (!list.length) { box.innerHTML = '<div class="hint" style="padding:6px;">暂无源</div>'; return; }
        list.forEach(function (s) {
            var row = document.createElement('div');
            row.className = 'mv-mgr-row';
            row.innerHTML = '<span class="mv-mgr-name"></span><span class="mv-mgr-api"></span>';
            row.querySelector('.mv-mgr-name').textContent = s.name;
            row.querySelector('.mv-mgr-api').textContent = s.api;
            row.querySelector('.mv-mgr-api').title = s.api;
            var del = document.createElement('button');
            del.className = 'tbtn';
            del.textContent = '删除';
            del.style.cssText = 'padding:2px 8px;font-size:11px;color:#f6a1b1;';
            del.addEventListener('click', function () {
                window.__vhMovieSites.remove(s.key);
                renderSiteList();
                mgrHint('已删除：' + s.name);
            });
            row.appendChild(del);
            box.appendChild(row);
        });
    }

    function renderSubList() {
        var box = $('mvSubList');
        if (!box || !window.__vhMovieSites) return;
        var subs = window.__vhMovieSites.loadSubs();
        box.innerHTML = '';
        if (!subs.length) { box.innerHTML = '<div class="hint" style="padding:6px;">暂无订阅</div>'; return; }
        subs.forEach(function (u) {
            var row = document.createElement('div');
            row.className = 'mv-mgr-row';
            var sp = document.createElement('span');
            sp.className = 'mv-mgr-api';
            sp.textContent = u;
            sp.title = u;
            row.appendChild(sp);
            var del = document.createElement('button');
            del.className = 'tbtn';
            del.textContent = '删除';
            del.style.cssText = 'padding:2px 8px;font-size:11px;color:#f6a1b1;';
            del.addEventListener('click', function () {
                window.__vhMovieSites.removeSub(u);
                renderSubList();
            });
            row.appendChild(del);
            box.appendChild(row);
        });
    }

    // 拉取所有订阅，合并新源
    function pullSubs() {
        if (!window.__vhMovieSites) return;
        var subs = window.__vhMovieSites.loadSubs();
        if (!subs.length) { mgrHint('没有订阅可拉取', true); return; }
        mgrHint('正在拉取 ' + subs.length + ' 个订阅…');
        var n = 0, added = 0;
        subs.forEach(function (url) {
            apiGet(url, 15000).then(function (j) {
                var list = window.__vhMovieSites.parseSub(j);
                list.forEach(function (s) {
                    var r = window.__vhMovieSites.add(s);
                    if (r.ok) added++;
                });
            }).catch(function () {}).then(function () {
                n++;
                if (n === subs.length) {
                    renderSiteList();
                    mgrHint(added ? ('订阅拉取完成，新增 ' + added + ' 个源') : '订阅拉取完成，无新增源');
                }
            });
        });
    }

    function bindSiteMgr() {
        var b;
        b = $('mvSiteMgr');
        if (b) b.addEventListener('click', function () {
            $('mvSiteMgrBox').style.display = '';
            renderSiteList();
            renderSubList();
            mgrHint('');
        });
        b = $('mvSiteMgrClose');
        if (b) b.addEventListener('click', function () { $('mvSiteMgrBox').style.display = 'none'; });
        b = $('mvSiteAdd');
        if (b) b.addEventListener('click', function () {
            var name = ($('mvSiteName').value || '').trim();
            var api = ($('mvSiteApi').value || '').trim();
            if (!api) { mgrHint('请填接口地址', true); return; }
            if (!/^https?:\/\//i.test(api)) { mgrHint('接口地址需以 http(s):// 开头', true); return; }
            var r = window.__vhMovieSites.add({ name: name, api: api });
            if (!r.ok) { mgrHint(r.msg, true); return; }
            $('mvSiteName').value = '';
            $('mvSiteApi').value = '';
            renderSiteList();
            mgrHint('已添加：' + r.site.name);
        });
        b = $('mvSiteReset');
        if (b) b.addEventListener('click', function () {
            window.__vhMovieSites.reset();
            renderSiteList();
            mgrHint('已恢复内置默认源');
        });
        b = $('mvSubAdd');
        if (b) b.addEventListener('click', function () {
            var u = ($('mvSubUrl').value || '').trim();
            var r = window.__vhMovieSites.addSub(u);
            if (!r.ok) { mgrHint(r.msg, true); return; }
            $('mvSubUrl').value = '';
            renderSubList();
            mgrHint('已订阅，点「拉取更新」合入源');
        });
        b = $('mvSubPull');
        if (b) b.addEventListener('click', pullSubs);
    }

    // ---------- TVBox 配置导入 ----------
    function tvboxHint(t, isErr) {
        var el = $('mvTvboxHint');
        if (el) { el.textContent = t || ''; el.style.color = isErr ? '#f6a1b1' : '#7fd68b'; }
    }

    function importTvbox() {
        var url = ($('mvTvboxUrl').value || '').trim();
        if (!/^https?:\/\//i.test(url)) { tvboxHint('配置地址需以 http(s):// 开头', true); return; }
        var box = $('mvTvboxResult');
        box.innerHTML = '<div class="hint" style="padding:6px;">正在拉取配置…</div>';
        tvboxHint('');
        apiGet(url, 25000).then(function (j) {
            var r = window.__vhTvbox.parseConfig(j, url);
            // 点播源并入现有列表
            var m = window.__vhTvbox.mergeVod(r.vod);
            // 直播源自动加入
            var lv = 0;
            r.live.forEach(function (s) {
                var a = window.__vhTvbox.addLive(s);
                if (a.ok) lv++;
            });
            // 展示结果
            box.innerHTML = '';
            function line(tag, txt, cls) {
                var d = document.createElement('div');
                d.className = 'mv-tvbox-line' + (cls ? ' ' + cls : '');
                d.textContent = tag + ' ' + txt;
                box.appendChild(d);
            }
            line('✅', '点播源：共解析 ' + r.stats.vodTotal + ' 个，可用 ' + r.stats.vodUsable
                + ' 个，新增 ' + m.added + ' 个（现共 ' + m.total + ' 个）');
            if (r.stats.vodSpider) {
                line('⏭', '跳过 ' + r.stats.vodSpider + ' 个 spider 源（csp_XXX，依赖 Android 运行环境，插件里跑不了）', 'warn');
            }
            if (r.stats.vodOther) {
                line('❔', '其他不可用 ' + r.stats.vodOther + ' 个', 'warn');
            }
            // 关键提醒：全被跳过时要说清为什么、怎么办
            if (r.stats.vodUsable === 0) {
                line('⚠', '这份配置里没有可用的点播源', 'warn');
                line('ℹ', 'spider 源（csp_XXX）的代码是加密的 Android 包，浏览器和 Node 都运行不了，不是插件能修的', 'warn');
                line('ℹ', '插件能用的只有「普通采集站」源（type=1）。已内置 6 个实测可用的，可直接搜索点播；', 'warn');
                line('ℹ', '要加自己的，用「⚙ 源管理」填采集站接口地址（形如 https://xxx.com/api.php/provide/vod）', 'warn');
            }
            line('✅', '直播源：共 ' + r.stats.liveTotal + ' 个，可用 ' + r.stats.liveUsable + ' 个，新增 ' + lv + ' 个');
            if (r.vod.length) {
                line('📋', '可用点播源：' + r.vod.slice(0, 6).map(function (v) { return v.name; }).join('、')
                    + (r.vod.length > 6 ? ' 等' : ''));
            }
            if (r.live.length) {
                line('📋', '可用直播源：' + r.live.map(function (v) { return v.name; }).join('、'));
            }
            tvboxHint('导入完成。点播源已生效，直播源到「📺 电视直播」页查看');
            // 刷新源管理列表（如果开着）
            try { renderSiteList(); } catch (e) {}
        }).catch(function (e) {
            box.innerHTML = '';
            tvboxHint('拉取或解析失败：' + (e && e.message || e), true);
        });
    }

    function bindTvbox() {
        var b = $('mvTvboxImp');
        if (b) b.addEventListener('click', function () {
            $('mvTvboxBox').style.display = '';
            tvboxHint('');
            $('mvTvboxResult').innerHTML = '';
        });
        b = $('mvTvboxClose');
        if (b) b.addEventListener('click', function () { $('mvTvboxBox').style.display = 'none'; });
        b = $('mvTvboxGo');
        if (b) b.addEventListener('click', importTvbox);
        b = $('mvTvboxUrl');
        if (b) b.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.keyCode === 13) { e.stopPropagation(); importTvbox(); }
        });
    }

    // 统一的“彻底停播”：不管当前是点播还是直播，都要停掉。
    // 两个模块各自持有 hls 实例（点播用 movie.js 的 hls，直播用 movie-live.js 的 hls），
    // 关闭时只销毁自己的那个 -> 另一个的音频流还在拉，听起来就是「画面没了但声音还在」。
    window.__mvStopAll = function () {
        // 1) 停 video 元素本身
        var v = $('mvVideo');
        if (v) {
            try { v.pause(); } catch (e) {}
            try { v.muted = true; } catch (e) {}
            try { v.removeAttribute('src'); } catch (e) {}
            try { v.load(); } catch (e) {}
        }
        // 2) 销毁本模块（点播）的 hls
        try { if (hls) { hls.destroy(); hls = null; } } catch (e) {}
        // 3) 让直播模块也销毁它的 hls
        try { if (window.__mvLive && window.__mvLive.stop) window.__mvLive.stop(); } catch (e) {}
    };

    // ---------- 绑定 ----------
    function bind() {
        var b;
        bindSiteMgr();
        bindTvbox();
        if (window.__mvLive && window.__mvLive.bind) { try { window.__mvLive.bind(); } catch (e) {} }
        b = $('mvSearch'); if (b) b.addEventListener('click', search);
        b = $('mvQuery');
        if (b) b.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.keyCode === 13) { e.stopPropagation(); search(); }
        });
        b = $('mvPickClose'); if (b) b.addEventListener('click', function () { $('mvPick').style.display = 'none'; });
        b = $('mvPlayerClose'); if (b) b.addEventListener('click', function () {
            $('mvPlayer').style.display = 'none';
            if (window.__mvStopAll) window.__mvStopAll();
            curPlay = null;
        });
        b = $('mvPlayerReload'); if (b) b.addEventListener('click', function () {
            if (!curPlay) return;
            play(curPlay.item, curPlay.eps[curPlay.idx], curPlay.eps, curPlay.idx);
        });
        b = $('mvPlayerPick'); if (b) b.addEventListener('click', function () {
            if (!curPlay) return;
            openPick(curPlay.item);
        });
        // 播完自动下一集
        var v = $('mvVideo');
        if (v) v.addEventListener('ended', nextEp);
    }

    // 切到本板块时
    var recommendLoaded = false;
    window.__movieOnShow = function () {
        if (!window.Hls) setState('未加载 hls.js（无法播 HLS）', 'err');
        if (!recommendLoaded) loadRecommend();
    };

    // ---------- 首页：分类导航 ----------
    // 结构对齐 TVBox 配置：大分类（电影/连续剧/综艺/动漫）→ 子分类 → 影片网格 + 分页。
    // 分类来自采集站 ac=list 返回的 class（含 type_id / type_pid 层级）。
    var catModel = null;    // { roots: [{id,name,children:[{id,name}]}] }
    var curRoot = '';
    var curSub = '';
    var curPage = 1;
    var curSiteApi = '';    // 首页当前选中的源（多源时可切换）

    function firstSite() {
        var l = sites();
        return l.length ? l[0] : null;
    }
    function sameApi(a, b) {
        var f = function (u) { return String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''); };
        return f(a) === f(b);
    }
    function siteByApi(api) {
        if (!api) return null;
        var l = sites();
        for (var i = 0; i < l.length; i++) { if (sameApi(l[i].api, api)) return l[i]; }
        return null;
    }

    function loadRecommend() {
        var box = $('mvResults');
        if (!box) return;
        var site = firstSite();
        if (!site) {
            box.innerHTML = '<div class="hint mv-empty">还没有可用的点播源<br>点上方「📥 导入配置」导入 TVBox 配置，或「⚙ 源管理」手动添加</div>';
            setState('无点播源', 'err');
            return;
        }
        if (!curSiteApi) curSiteApi = site.api;
        box.innerHTML = '<div class="hint mv-empty">正在加载分类…</div>';
        setState('加载中…');
        loadCatModel(siteByApi(curSiteApi) || site);
    }

    // 取某源的分类表并渲染首页
    function loadCatModel(site) {
        var box = $('mvResults');
        fetchJson(site.api + '/api.php/provide/vod/?ac=list', 20000).then(function (j) {
            var cls = (j && j.class) || [];
            if (!cls.length) throw new Error('该源没返回分类');
            catModel = buildCatModel(cls);
            if (!catModel.roots.length) throw new Error('该源没有可用分类');
            if (!curRoot || !catModel.roots.some(function (r) { return r.id === curRoot; })) {
                curRoot = catModel.roots[0].id;
            }
            var r = findRoot(curRoot);
            // 单层源（没有任何子分类）：它的 type_id 常是占位值，t= 查不出东西。
            // 探测一下首个分类是否真有内容：没有则只保留「全部」（不传 t）。
            var flat = catModel.roots.every(function (x) { return !x.children.length; });
            if (flat) {
                var probe = site.api + '/api.php/provide/vod/?ac=detail&t=' + encodeURIComponent(curRoot) + '&pg=1';
                fetchJson(probe, 15000).then(function (pj) {
                    if (((pj && pj.list) || []).length) {
                        curSub = (r && r.children.length) ? r.children[0].id : '__all__';
                    } else {
                        catModel.flat = true;   // 分类无效 → 隐藏分类条，只走「全部」
                        curSub = '__all__';
                    }
                    curPage = 1;
                    renderHome();
                }).catch(function () {
                    catModel.flat = true;
                    curSub = '__all__';
                    curPage = 1;
                    renderHome();
                });
                return;
            }
            curSub = (r && r.children.length) ? r.children[0].id : '__all__';
            curPage = 1;
            renderHome();
        }).catch(function (e) {
            catModel = null;
            fetchJson(site.api + RECOMMEND_PATH, 20000).then(function (j) {
                renderRecommend((j && j.list) || [], '🔥 最新上架（分类不可用：' + e.message + '）');
            }).catch(function (e2) {
                box.innerHTML = '<div class="hint mv-empty">加载失败：' + esc(e2.message) + '</div>';
                setState('加载失败', 'err');
            });
        });
    }

    // class 数组 → 两级分类模型
    // 注意：有些源（如百度/索尼采集）给的是单层“占位分类”，type_id 与真实内容
    // 对不上（t=1 查不出东西）。这类源只有「全部」（不带 t）能用，
    // 故子分类为空时不硬塞分类条，直接落到「全部」。
    function buildCatModel(cls) {
        var roots = [], byId = {};
        cls.forEach(function (c) {
            var id = String(c.type_id);
            byId[id] = { id: id, name: String(c.type_name || ''), pid: String(c.type_pid || '0'), children: [] };
        });
        Object.keys(byId).forEach(function (id) {
            var n = byId[id];
            if (n.pid === '0' || !byId[n.pid]) roots.push(n);
            else byId[n.pid].children.push(n);
        });
        // 过滤不该出现在工作插件里的分类
        var BAD = /伦理|情色|成人|里番|福利|丝袜|自拍|无码|有码|麻豆|三级|主播|偷拍|三级/;
        roots = roots.filter(function (r) { return !BAD.test(r.name); });
        roots.forEach(function (r) {
            r.children = r.children.filter(function (c) { return !BAD.test(c.name); });
        });
        var ORDER = ['电影', '电影片', '连续剧', '电视剧', '综艺', '综艺片', '动漫', '动漫片', '动画', '纪录片', '记录片', '体育'];
        roots.sort(function (a, b) {
            var ia = ORDER.indexOf(a.name), ib = ORDER.indexOf(b.name);
            if (ia < 0) ia = 99;
            if (ib < 0) ib = 99;
            return ia - ib;
        });
        return { roots: roots };
    }
    function findRoot(id) {
        if (!catModel) return null;
        for (var i = 0; i < catModel.roots.length; i++) {
            if (catModel.roots[i].id === id) return catModel.roots[i];
        }
        return null;
    }

    function renderHome() {
        var box = $('mvResults');
        if (!box || !catModel) return;
        box.innerHTML = '';

        // 源切换条：订阅里有多个可用源时，可切源看各自的首页
        var all = sites();
        if (all.length > 1) {
            var srcBar = document.createElement('div');
            srcBar.className = 'mv-home-srcbar';
            var lb = document.createElement('span');
            lb.className = 'mv-home-srcbar-label';
            lb.textContent = '源';
            srcBar.appendChild(lb);
            all.forEach(function (s) {
                var b = document.createElement('button');
                b.className = 'mv-home-src' + (sameApi(s.api, curSiteApi) ? ' on' : '');
                b.textContent = s.name;
                b.title = s.api;
                b.addEventListener('click', function () {
                    if (sameApi(s.api, curSiteApi)) return;
                    curSiteApi = s.api;
                    catModel = null;
                    setState('切换源：' + s.name);
                    box.innerHTML = '<div class="hint mv-empty">正在加载分类…</div>';
                    loadCatModel(s);
                });
                srcBar.appendChild(b);
            });
            box.appendChild(srcBar);
        }

        // 大分类（单层源分类无效时隐藏）
        if (!catModel.flat) {
        var rootBar = document.createElement('div');
        rootBar.className = 'mv-catbar';
        catModel.roots.forEach(function (r) {
            var b = document.createElement('button');
            b.className = 'mv-cat' + (r.id === curRoot ? ' on' : '');
            b.textContent = r.name;
            b.addEventListener('click', function () {
                curRoot = r.id;
                curSub = r.children.length ? r.children[0].id : '__all__';
                curPage = 1;
                renderHome();
            });
            rootBar.appendChild(b);
        });
        box.appendChild(rootBar);
        }

        // 子分类（单层源无子分类，自动略过）
        var r0 = findRoot(curRoot);
        if (!catModel.flat && r0 && r0.children.length) {
            var subBar = document.createElement('div');
            subBar.className = 'mv-subbar';
            // 「全部」不传 t：苹果CMS 的大分类（type_pid=0）本身不挂内容，
            // 内容全在子分类，所以查大分类 id 会是空的。不带 t 才是真正的「全站最新」。
            var allBtn = document.createElement('button');
            allBtn.className = 'mv-sub' + (curSub === '__all__' ? ' on' : '');
            allBtn.textContent = '全部';
            allBtn.title = '全站最新（不限分类）';
            allBtn.addEventListener('click', function () { curSub = '__all__'; curPage = 1; renderHome(); });
            subBar.appendChild(allBtn);
            r0.children.forEach(function (c) {
                var b = document.createElement('button');
                b.className = 'mv-sub' + (c.id === curSub ? ' on' : '');
                b.textContent = c.name;
                b.addEventListener('click', function () { curSub = c.id; curPage = 1; renderHome(); });
                subBar.appendChild(b);
            });
            box.appendChild(subBar);
        }

        var host = document.createElement('div');
        host.className = 'mv-grid-wrap';
        host.innerHTML = '<div class="hint" style="padding:14px;">加载中…</div>';
        box.appendChild(host);
        var cur = siteByApi(curSiteApi) || firstSite();
        setState('源：' + ((cur || {}).name || '-'));
        loadCatList(curSub || curRoot, host);
    }

    function loadCatList(catId, host) {
        var site = siteByApi(curSiteApi) || firstSite();
        if (!site) { host.innerHTML = '<div class="hint" style="padding:14px;">没有可用源</div>'; return; }
        // 「全部」= 不带 t（全站最新）
        var base = site.api + '/api.php/provide/vod/?ac=detail';
        if (catId && catId !== '__all__') base += '&t=' + encodeURIComponent(catId);
        var u = base + '&pg=' + curPage;
        fetchJson(u, 20000).then(function (j) {
            renderGrid((j && j.list) || [], host, j);
        }).catch(function (e) {
            host.innerHTML = '<div class="hint" style="padding:14px;">加载失败：' + esc(e.message) + '</div>';
        });
    }

    function renderGrid(list, host, meta) {
        host.innerHTML = '';
        if (!list.length) { host.innerHTML = '<div class="hint" style="padding:14px;">该分类暂无内容</div>'; return; }
        var grid = document.createElement('div');
        grid.className = 'mv-reco-grid';
        list.forEach(function (it) {
            var name = it.vod_name || '';
            if (!name) return;
            var card = document.createElement('div');
            card.className = 'mv-reco';
            var pic = it.vod_pic
                ? ('<img src="' + esc(it.vod_pic) + '" onerror="this.style.visibility=\'hidden\'">')
                : '<div class="mv-nopic">🎬</div>';
            card.innerHTML = '<div class="mv-reco-cover">' + pic + '</div>'
                + '<div class="mv-reco-name" title="' + esc(name) + '">' + esc(name) + '</div>'
                + '<div class="mv-reco-sub">' + esc(it.vod_remarks || it.vod_year || '') + '</div>';
            card.addEventListener('click', function () {
                if ($('mvQuery')) $('mvQuery').value = name;
                search();
            });
            grid.appendChild(card);
        });
        host.appendChild(grid);

        var foot = document.createElement('div');
        foot.className = 'mv-pagebar';
        var total = (meta && meta.total) ? meta.total : 0;
        var pages = (meta && meta.pagecount) ? Number(meta.pagecount) : 0;
        function pbtn(t, dis, fn) {
            var b = document.createElement('button');
            b.className = 'tbtn';
            b.textContent = t;
            b.disabled = !!dis;
            if (!dis) b.addEventListener('click', fn);
            foot.appendChild(b);
        }
        pbtn('‹ 上一页', curPage <= 1, function () { curPage--; loadCatList(curSub || curRoot, host); });
        var info = document.createElement('span');
        info.className = 'mv-pageinfo';
        info.textContent = '第 ' + curPage + ' 页' + (pages ? (' / 共 ' + pages + ' 页') : '')
            + (total ? ('　共 ' + total + ' 部') : '');
        foot.appendChild(info);
        pbtn('下一页 ›', pages ? (curPage >= pages) : (list.length < 20), function () { curPage++; loadCatList(curSub || curRoot, host); });
        host.appendChild(foot);
    }

    // 分类不可用时的兜底（保留原「推荐网格」形态）
    function renderRecommend(list, title) {
        var box = $('mvResults');
        if (!box) return;
        if (!list.length) { box.innerHTML = '<div class="hint mv-empty">暂无内容</div>'; return; }
        box.innerHTML = '';
        var cap = document.createElement('div');
        cap.className = 'mv-sec';
        cap.textContent = title;
        box.appendChild(cap);
        var host = document.createElement('div');
        host.className = 'mv-grid-wrap';
        box.appendChild(host);
        renderGrid(list, host, null);
        setState('共 ' + list.length + ' 部', 'ok');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
