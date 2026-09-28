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

    // ---------- 绑定 ----------
    function bind() {
        var b;
        bindSiteMgr();
        b = $('mvSearch'); if (b) b.addEventListener('click', search);
        b = $('mvQuery');
        if (b) b.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.keyCode === 13) { e.stopPropagation(); search(); }
        });
        b = $('mvPickClose'); if (b) b.addEventListener('click', function () { $('mvPick').style.display = 'none'; });
        b = $('mvPlayerClose'); if (b) b.addEventListener('click', function () {
            $('mvPlayer').style.display = 'none';
            var v = $('mvVideo');
            if (v) { try { v.pause(); } catch (e) {} v.removeAttribute('src'); try { v.load(); } catch (e) {} }
            if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
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

    // ---------- 首页推荐（无 wd 参数即最新/热播） ----------
    function loadRecommend() {
        var box = $('mvResults');
        if (!box) return;
        recommendLoaded = true;
        box.innerHTML = '<div class="hint mv-empty">正在加载推荐…</div>';
        setState('加载推荐中…');
        var list0 = sites();
        if (!list0.length) { box.innerHTML = '<div class="hint mv-empty">没有可用源，请到「源管理」添加</div>'; return; }
        var site = list0[0];   // 用首个可用源出推荐
        var u = site.api + '/api.php/provide/vod/?ac=detail&t=6&pg=1';
        fetchJson(u, 20000).then(function (j) {
            var list = (j && j.list) || [];
            renderRecommend(list, '🎬 最新电影');
        }).catch(function () {
            // 退回无分类的最新
            return fetchJson(site.api + RECOMMEND_PATH, 20000).then(function (j) {
                renderRecommend((j && j.list) || [], '🔥 最新上架');
            });
        }).catch(function (e) {
            box.innerHTML = '<div class="hint mv-empty">推荐加载失败：' + esc(e.message)
                + '<br>可直接在上方输入片名搜索</div>';
            setState('推荐失败', 'err');
        });
    }

    function renderRecommend(list, title) {
        var box = $('mvResults');
        if (!box) return;
        if (!list.length) { box.innerHTML = '<div class="hint mv-empty">暂无推荐</div>'; return; }
        box.innerHTML = '';
        var cap = document.createElement('div');
        cap.className = 'mv-sec';
        cap.textContent = title + '（点卡片搜索同名资源）';
        box.appendChild(cap);
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
            // 点推荐 → 用片名去搜索（跨源聚合，才能拿到可播地址）
            card.addEventListener('click', function () {
                if ($('mvQuery')) $('mvQuery').value = name;
                search();
            });
            grid.appendChild(card);
        });
        box.appendChild(grid);
        setState('推荐 ' + list.length + ' 部 · 6 个源', 'ok');
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
