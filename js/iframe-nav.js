// vh-Atelier 内嵌站导航通用模块
// 解决：审片（分秒帧）与超分（去字幕站）两个板块的 iframe 一直空白
// 根因：main.js 调用了 window.__spAutoLoad / window.__upscaleAutoLoad，但两者从未定义；
//       导航栏按钮（后退/前进/刷新/首页/外开/地址栏）也没有任何事件绑定。
// 本模块为两个板块补齐：iframe 首次加载 + 完整导航条 + 独立的历史栈。
//
// 说明：iframe 与主面板不同源（跨域），无法访问 contentWindow.history，
//      因此自带一个地址栈来模拟后退/前进。
(function () {
    var fs = require('fs');
    var path = require('path');
    var child_process = require('child_process');

    // 站点配置
    var SITES = {
        shenpian: {
            frame: 'spFrame', back: 'spBack', fwd: 'spFwd', reload: 'spReload',
            home: 'btnSpHome', external: 'spExternal', url: 'spUrl',
            homeUrl: 'https://app.mediatrack.cn/'
        },
        upscale: {
            frame: 'upscaleFrame', back: 'upBack', fwd: 'upFwd', reload: 'upReload',
            home: 'btnUpscaleHome', external: 'upExternal', url: 'upUrl',
            homeUrl: 'http://subtitle.zztianqiao.com'
        },
    };

    // 读/写某站点的默认地址（目前只有网盘用）
    function loadHomeUrl (cfg) {
        if (!cfg.storeKey) return cfg.homeUrl || '';
        try {
            var v = localStorage.getItem(cfg.storeKey);
            if (v) return v;
        } catch (e) {}
        return cfg.homeUrl || cfg.defaultUrl || '';
    }
    function saveHomeUrl (cfg, u) {
        if (!cfg.storeKey || !u) return;
        try { localStorage.setItem(cfg.storeKey, u); } catch (e) {}
    }

    function $ (id) { return document.getElementById(id); }

    // 轻提示（面板内右下角，2 秒消失）—— 供「存为默认/已记住地址」用
    var _toastTimer = null;
    window.__ndToast = function (msg) {
        try {
            var t = document.getElementById('ndToast');
            if (!t) {
                t = document.createElement('div');
                t.id = 'ndToast';
                t.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:10030;' +
                    'background:rgba(20,24,20,.95);border:1px solid rgba(127,214,139,.4);' +
                    'color:#9fe0ab;padding:7px 14px;border-radius:999px;font-size:12px;' +
                    'box-shadow:0 6px 20px rgba(0,0,0,.5);opacity:0;transition:opacity .2s;';
                document.body.appendChild(t);
            }
            t.textContent = msg;
            void t.offsetWidth;
            t.style.opacity = '1';
            if (_toastTimer) clearTimeout(_toastTimer);
            _toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 2000);
        } catch (e) {}
    };

    // 外部浏览器打开（CEP 面板内用系统默认浏览器）
    function openExternal (u) {
        try { child_process.exec('start "" "' + u + '"'); } catch (e) {}
    }

    // 为一个板块装配导航
    function wire (key) {
        var cfg = SITES[key];
        var frame = $(cfg.frame);
        if (!frame) return null;
        // 主页地址可配置（网盘用），支持用户改地址
        if (cfg.storeKey) cfg.homeUrl = loadHomeUrl(cfg);

        var elBack = $(cfg.back), elFwd = $(cfg.fwd), elReload = $(cfg.reload);
        var elHome = $(cfg.home), elExt = $(cfg.external), elUrl = $(cfg.url);

        var stack = [];      // 访问过的地址（模拟历史）
        var pos = -1;        // 当前在栈中的位置
        var loaded = false;  // 是否已加载过

        function syncBtns () {
            if (elBack) elBack.disabled = (pos <= 0);
            if (elFwd) elFwd.disabled = (pos < 0 || pos >= stack.length - 1);
        }
        function syncUrl (u) {
            if (elUrl && u && document.activeElement !== elUrl) elUrl.value = u;
        }

        // 导航（record=false 时不入栈，用于后退/前进）
        function go (u, record) {
            if (!u) return;
            u = String(u).trim();
            if (!u) return;
            // 补协议：用户可能只输入域名
            if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) {
                u = /^[\w-]+(\.[\w-]+)+/.test(u) ? ('http://' + u) : ('http://' + u);
            }
            try {
                frame.src = u;
                loaded = true;
            } catch (e) {
                openExternal(u);
                return;
            }
            if (record !== false) {
                // 截断前进分支，压入新地址
                stack = stack.slice(0, pos + 1);
                stack.push(u);
                pos = stack.length - 1;
            }
            syncUrl(u);
            syncBtns();
        }

        function goBack () { if (pos > 0) { pos--; go(stack[pos], false); } }
        function goFwd () { if (pos < stack.length - 1) { pos++; go(stack[pos], false); } }
        function reload () {
            var u = stack[pos] || cfg.homeUrl;
            // 强制重载：先清空再设，避免同地址不触发
            try { frame.src = 'about:blank'; } catch (e) {}
            setTimeout(function () { go(u, false); }, 40);
        }

        if (elBack) elBack.addEventListener('click', goBack);
        if (elFwd) elFwd.addEventListener('click', goFwd);
        if (elReload) elReload.addEventListener('click', reload);
        if (elHome) elHome.addEventListener('click', function () { go(cfg.homeUrl, true); });
        if (elExt) elExt.addEventListener('click', function () {
            openExternal(stack[pos] || cfg.homeUrl);
        });
        if (elUrl) {
            elUrl.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.keyCode === 13) {
                    var v = String(elUrl.value || '').trim();
                    if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v;
                    go(v, true);
                    // 有 storeKey 的站点：地址栏是「用户主动指定」，记下来
                    if (cfg.storeKey && v) {
                        saveHomeUrl(cfg, v);
                        if (typeof window.__ndToast === 'function') window.__ndToast('已记住该地址');
                    }
                }
                e.stopPropagation();
            });
        }
        // 「存为默认」：把地址栏当前值写为默认主页
        var elSave = cfg.save ? $(cfg.save) : null;
        if (elSave) {
            elSave.addEventListener('click', function () {
                var v = (elUrl && elUrl.value || '').trim();
                if (!v) return;
                if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
                saveHomeUrl(cfg, v);
                cfg.homeUrl = v;
                if (typeof window.__ndToast === 'function') window.__ndToast('已存为默认网盘地址');
            });
        }

        // 首次进入板块时自动加载首页
        var api = {
            loaded: function () { return loaded; },
            home: cfg.homeUrl,
            load: function (u, record) { go(u || cfg.homeUrl, record !== false); },
            autoLoad: function () {
                if (!loaded) go(cfg.homeUrl, true);
            }
        };
        syncBtns();
        return api;
    }

    var wired = {};
    function ensure (key) {
        if (!wired[key]) wired[key] = wire(key);
        return wired[key];
    }

    // 暴露给其他模块（如 progress.js 的 gotoFm，切项目时直接导航）
    window.__spNav = { load: function (u, rec) { var a = ensure('shenpian'); if (a) a.load(u, rec); } };
    window.__upNav = { load: function (u, rec) { var a = ensure('upscale'); if (a) a.load(u, rec); } };
    // main.js 懒加载钩子：切到板块时把 iframe 拉起来
    window.__spAutoLoad = function () {
        var a = ensure('shenpian');
        if (a) a.autoLoad();
    };
    window.__upscaleAutoLoad = function () {
        var a = ensure('upscale');
        if (a) a.autoLoad();
    };
    // ==================== 审片：从聊天文字里解析分秒帧链接 ====================
    // 典型输入（微信/钉钉常见格式）：
    //   请点击链接，审阅1026
    //   链接：https://mdl.ink/OWnlGO @王玉闪 马上传完了@邵莹莹
    // 目标：把 https://mdl.ink/OWnlGO 挖出来并打开。
    //
    // 分秒帧（mediatrack）的分享域名不固定，mdl.ink 是短链，
    // 也可能直接是 app.mediatrack.cn 的长链，所以用「域名白名单 + 通用兜底」两层策略。
    var MT_HOSTS = [
        'mdl.ink', 'mediatrack.cn', 'app.mediatrack.cn', 'fm.mediatrack.cn',
        'm.mediatrack.cn', 'mediatrack.com'
    ];

    // 常见「链接前面带标签」的写法，先把标签吃掉，避免把中文标点混进 URL
    var LABEL_RE = /(?:链接|地址|网址|url|URL|link)\s*[:：]?\s*$/;

    function cleanUrl(u) {
        if (!u) return '';
        var x = String(u).trim();
        // 去掉包裹的尖括号/括号/引号
        x = x.replace(/^[<（(\[【"'\s]+/, '').replace(/[>）)\]】"'\s]+$/, '');
        // 去掉结尾常见的中文标点与汉字（粘贴时常紧跟 @某人）
        x = x.replace(/[，,。.、；;：:！!？?、）)】\]}"'\s]+$/, '');
        // 结尾若粘上了汉字（如 …/abc张），把尾部汉字剥掉
        x = x.replace(/[\u4e00-\u9fa5]+$/, '');
        return x;
    }

    function isMediaTrackHost(u) {
        try {
            var h = String(u).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
            for (var i = 0; i < MT_HOSTS.length; i++) {
                var d = MT_HOSTS[i];
                if (h === d || h.endsWith('.' + d)) return true;
            }
        } catch (e) {}
        return false;
    }

    // 从任意文本里抽出候选链接，按可信度排序
    function extractLinks(text) {
        var t = String(text || '');
        if (!t.trim()) return [];
        var urls = [];
        var seen = {};

        function push(raw, why) {
            var u = cleanUrl(raw);
            if (!u || u.length < 8) return;
            if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
            if (seen[u]) return;
            seen[u] = 1;
            urls.push({ url: u, why: why || '' });
        }

        // 1) 带协议的完整链接
        var reFull = /https?:\/\/[^\s<>"'，。、；！？）)】\]]+/gi;
        var m;
        while ((m = reFull.exec(t))) push(m[0], 'full');

        // 2) 不带协议的裸域名（mdl.ink/xxx、app.mediatrack.cn/xxx）
        if (!urls.length) {
            var reBare = /(?:[a-z0-9-]+\.)+(?:ink|cn|com|net|io)(?:\/[^\s<>"'，。、；！？）)】\]]*)?/gi;
            var m2;
            while ((m2 = reBare.exec(t))) {
                var cand = m2[0];
                // 只要看起来像短链或分秒帧域名才收，避免把普通句子里的词当链接
                if (isMediaTrackHost(cand) || /^mdl\.ink\//i.test(cand)) push(cand, 'bare');
            }
        }

        // 排序：分秒帧域名优先
        urls.sort(function (a, b) {
            var sa = isMediaTrackHost(a.url) ? 1 : 0;
            var sb = isMediaTrackHost(b.url) ? 1 : 0;
            return sb - sa;
        });
        return urls;
    }

    function openInShenpian(url) {
        if (!url) return false;
        try {
            var a = ensure('shenpian');
            if (a) { a.load(url, true); }
            // 导航栏地址框同步
            var uEl = $('spUrl');
            if (uEl) uEl.value = url;
            return true;
        } catch (e) {
            return false;
        }
    }

    // 解析并打开：优先分秒帧链接，其次任意 http 链接
    function parseAndOpen(text) {
        var list = extractLinks(text);
        if (!list.length) return { ok: false, msg: '没找到链接' };
        var target = list[0];
        openInShenpian(target.url);
        return {
            ok: true,
            url: target.url,
            all: list.map(function (x) { return x.url; }),
            mt: isMediaTrackHost(target.url)
        };
    }

    function bindSpParse() {
        var inp = $('spParseInput');
        var btn = $('spParseBtn');
        var pasteBtn = $('spParsePaste');
        if (!inp || !btn) return;

        function doOpen(text) {
            var t = String(text || '').trim();
            if (!t) return;
            var r = parseAndOpen(t);
            if (!r.ok) {
                inp.classList.remove('sp-parse-hit');
                window.__ndToast && window.__ndToast('没找到可打开的链接');
                return;
            }
            inp.value = r.url;
            inp.classList.add('sp-parse-hit');
            window.__ndToast && window.__ndToast(
                r.mt ? ('已打开分秒帧：' + r.url) : ('已打开链接：' + r.url)
            );
            if (r.all && r.all.length > 1) {
                console.log('[shenpian] 共解析到 ' + r.all.length + ' 个链接，已打开第 1 个：', r.all);
            }
        }

        btn.addEventListener('click', function () { doOpen(inp.value); });

        inp.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                doOpen(inp.value);
            }
        });

        // 粘贴时立刻尝试解析（不用再点按钮）
        inp.addEventListener('paste', function (ev) {
            var cd = ev.clipboardData || window.clipboardData;
            var txt = cd ? cd.getData('text') : '';
            if (!txt) return;
            ev.preventDefault();
            inp.value = txt;
            setTimeout(function () { doOpen(txt); }, 30);
        });

        if (pasteBtn) {
            pasteBtn.addEventListener('click', function () {
                var done = false;
                try {
                    if (navigator.clipboard && navigator.clipboard.readText) {
                        navigator.clipboard.readText().then(function (txt) {
                            inp.value = txt || '';
                            doOpen(txt);
                        }, function () {
                            window.__ndToast && window.__ndToast('读取剪贴板被拒绝，请手动粘贴');
                        });
                        done = true;
                    }
                } catch (e) {}
                if (!done) {
                    window.__ndToast && window.__ndToast('请手动粘贴到输入框');
                    inp.focus();
                }
            });
        }
    }

    // 对外暴露，便于其他模块（如从审批消息直接跳转）调用
    window.__spParse = {
        extract: extractLinks,
        open: parseAndOpen,
        isMediaTrack: isMediaTrackHost
    };

    // 面板初始化时先把 DOM 绑好（不加载页面，等切到时再加载）
    ensure('shenpian');
    ensure('upscale');

    // 审片链接解析条（DOM 此时已就绪）
    try {
        if (document.getElementById('spParseInput')) bindSpParse();
        else if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bindSpParse);
        }
    } catch (e) {}
})();
