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

    // 采集源（实测可用 + 已剔除成人源）
    var SITES = [
        { key: 'ffzy',  name: '非凡影视', api: 'http://ffzy5.tv' },
        { key: 'zy360', name: '360资源',  api: 'https://360zy.com' },
        { key: 'jisu',  name: '极速资源', api: 'https://jszyapi.com' },
        { key: 'bfzy',  name: '暴风资源', api: 'https://bfzyapi.com' },
        { key: 'mdzy',  name: '魔都资源', api: 'https://www.mdzyapi.com' },
        { key: 'ruyi',  name: '如意资源', api: 'https://cj.rycjapi.com' }
    ];

    var SEARCH_PATH = '/api.php/provide/vod/?ac=detail&wd=';

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

    // ---------- 搜索 ----------
    var lastResults = [];

    function search() {
        var q = ($('mvQuery') && $('mvQuery').value || '').trim();
        if (!q) { flash('请输入片名'); return; }
        var box = $('mvResults');
        box.innerHTML = '<div class="hint mv-empty">正在聚合搜索…</div>';
        setState('搜索中…');

        var done = 0, all = [];
        var total = SITES.length;
        SITES.forEach(function (site) {
            var u = site.api + SEARCH_PATH + encodeURIComponent(q);
            apiGet(u, 20000).then(function (j) {
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
        // 多源同片：先列出源供选，并默认选中第一个源直接渲染集数
        // （否则用户点开只看到空白，以为没数据）
        var ov = $('mvPick'), tt = $('mvPickTitle'), srcBox = $('mvPickSrc'), epsBox = $('mvPickEps');
        $('mvPick').style.display = '';
        tt.textContent = g.name + ' · 选择来源';
        srcBox.innerHTML = '';
        epsBox.innerHTML = '';
        var firstBtn = null, firstDirect = null;
        g.items.forEach(function (it) {
            var b = document.createElement('button');
            var ok2 = isDirectSrc(it);
            b.className = 'tbtn mv-pickbtn' + (ok2 ? '' : ' mv-nodirect');
            b.textContent = it.siteName + (ok2 ? '' : '（非直链）');
            b.title = ok2 ? '可直接播放' : '该源返回的是网页播放页，插件里播不了';
            b.addEventListener('click', function () {
                Array.prototype.forEach.call(srcBox.children, function (c) { c.classList.remove('on'); });
                b.classList.add('on');
                renderEps(it);
            });
            srcBox.appendChild(b);
            if (!firstBtn) firstBtn = b;
            if (!firstDirect && ok2) firstDirect = { btn: b, item: it };
        });
        // 默认选中「第一个可直接播放的源」（没有则退到第一个）并直接渲染集数，
        // 避免用户点开只看到空白。
        var pickOne = firstDirect || (firstBtn ? { btn: firstBtn, item: g.items[0] } : null);
        if (pickOne) {
            pickOne.btn.classList.add('on');
            try { renderEps(pickOne.item); } catch (e) {}
        }
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

        // 直接把原始 m3u8 地址交给 hls.js 并不行（跨域），所以给代理地址；
        // 代理会把清单里的子清单/分片/AES 密钥地址全部改写成「经代理」的绝对地址，
        // 因此 hls.js 不需要任何 xhrSetup 技巧，拿到什么就请求什么。
        var playUrl = proxy() + 'proxy?url=' + encodeURIComponent(ep.url);

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

    // ---------- 绑定 ----------
    function bind() {
        var b;
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
    window.__movieOnShow = function () {
        if (!window.Hls) {
            setState('未加载 hls.js（无法播 HLS）', 'err');
        } else {
            setState('就绪 · 6 个源', 'ok');
        }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
