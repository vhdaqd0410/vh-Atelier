// vh-Atelier 短剧扒歌 · 在线播放模块
// 作用：未下载的剧集直接在线看，不落盘、不转码、不占下载目录。
// 设计约束：
//   1) 不修改 bgm.js 里的任何既有函数，只增一个全局 window.vhBgmOnline
//   2) bgm.js 在 playEpisode 里会先判断 localMap；本模块由那个判断点调用（见接线说明）
//   3) 播放走 /stream 代理（manifest 已在服务端改写为绝对代理地址），因此这里直接
//      把 /stream?url=... 交给 hls.js，不做任何 URL 拼接
(function () {
    'use strict';

    var API = 'http://127.0.0.1:17891';
    var HLS_CDN = 'js/hls.light.min.js';
    var hlsLib = null;          // 已加载的 Hls 构造器
    var hlsLoading = null;      // 正在加载的 Promise
    var hlsInst = null;         // 当前 Hls 实例（切集时必须 destroy，否则内存泄漏 + 抢流）
    var currentKey = '';        // 当前播放标识（剧名:集号），防重复请求
    var pendingReq = null;

    function $(id) { return document.getElementById(id); }

    function fetchJson(url, timeout) {
        return readJson(url, timeout || 20000);
    }

    function readJson(url, timeout) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.timeout = timeout || 20000;
            xhr.onload = function () {
                if (xhr.status !== 200) return reject(new Error('HTTP ' + xhr.status));
                try { resolve(JSON.parse(xhr.responseText)); }
                catch (e) { reject(new Error('返回不是 JSON')); }
            };
            xhr.onerror = function () { reject(new Error('网络错误')); };
            xhr.ontimeout = function () { reject(new Error('请求超时')); };
            xhr.send();
        });
    }

    // 动态加载 hls.js（本地文件，不打 CDN，CEP 离线可用）
    function ensureHls() {
        if (hlsLib) return Promise.resolve(hlsLib);
        if (hlsLoading) return hlsLoading;
        hlsLoading = new Promise(function (resolve, reject) {
            if (window.Hls && window.Hls.isSupported) {
                hlsLib = window.Hls;
                return resolve(hlsLib);
            }
            var s = document.createElement('script');
            s.src = HLS_CDN;
            s.onload = function () {
                if (window.Hls && window.Hls.isSupported) {
                    hlsLib = window.Hls;
                    resolve(hlsLib);
                } else {
                    reject(new Error('hls.js 已加载但不可用'));
                }
            };
            s.onerror = function () { reject(new Error('hls.js 加载失败')); };
            document.head.appendChild(s);
        });
        hlsLoading.catch(function () { hlsLoading = null; });
        return hlsLoading;
    }

    function destroyHls() {
        if (hlsInst) {
            try { hlsInst.destroy(); } catch (e) {}
            hlsInst = null;
        }
    }

    // 拿在线播放地址。返回 {url, source, title, isMerged, episode, episodeTo, count}
    function fetchPlayUrl(seriesName, epNo, seriesId) {
        var q = [];
        if (seriesName) q.push('name=' + encodeURIComponent(seriesName));
        if (seriesId) q.push('series_id=' + encodeURIComponent(seriesId));
        q.push('ep=' + encodeURIComponent(epNo || 1));
        return readJson(API + '/play-url?' + q.join('&'), 60000).then(function (r) {
            if (!r || r.code !== 0) {
                var e = new Error((r && r.msg) || '没拿到播放地址');
                // 把各源的失败原因挂上去，界面可以显示"哪个源挂了"
                e.tried = (r && r.tried) || [];
                throw e;
            }
            return r.data;
        });
    }

    // 统一入口：在线播放某一集
    //   opts.onStatus(msg)  进度/失败提示
    //   opts.onReady()      真正开始播放
    //   opts.video          video 元素（默认 #bgmV）
    function play(opts) {
        opts = opts || {};
        var v = opts.video || $('bgmV');
        var status = opts.onStatus || function () {};
        var name = opts.seriesName || '';
        var ep = opts.ep || 1;
        if (!v) return Promise.reject(new Error('没有 video 元素'));

        var key = name + ':' + ep;
        // 同一集正在请求就复用，避免重复打源站
        if (pendingReq && currentKey === key) return pendingReq;
        currentKey = key;

        destroyHls();
        status('正在匹配在线片源…');

        // 内部重试封装：失败一次后换源再试
        var attempt = 0;
        function runOnce() {
            attempt++;
            return playOnce(attempt);
        }
        function playOnce(att) {
        return fetchPlayUrl(name, ep, opts.seriesId).then(function (d) {
            // 合并集提示：这一条流里含多集，播的是起点那集
            var note = d.isMerged
                ? ('（合并集，含第 ' + d.episode + '–' + d.episodeTo + ' 集）')
                : '';
            // switched > 0 表示前面的源失效、已自动换源，明确告诉用户
            var sw = (d.switched && d.switched > 0) ? ('  · 已自动跳过 ' + d.switched + ' 个失效源') : '';
            status('片源：' + d.source + note + sw);
            var url = API + d.url;
            return ensureHls().then(function (Hls) {
                return new Promise(function (resolve, reject) {
                    var settled = false;
                    var timer = setTimeout(function () {
                        if (!settled) { settled = true; reject(new Error('加载超时（15 秒）')); }
                    }, 15000);
                    var done = function (fn, arg, retryable) {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        // retryable 必须挂到 Error 上，外层 catch 才知道该不该换源重试
                        if (retryable && arg && typeof arg === 'object') arg.retryable = true;
                        fn(arg);
                    };

                    v.dataset.online = '1';
                    v.dataset.ep = String(ep);
                    // 不用原生 HLS（CEP Chromium 不带），统一走 hls.js
                    hlsInst = new Hls({
                        enableWorker: false,          // CEP 里 worker 路径容易出问题
                        lowLatencyMode: false,
                        manifestLoadingTimeOut: 20000,
                        manifestLoadingMaxRetry: 2,
                        fragLoadingTimeOut: 30000,
                        fragLoadingMaxRetry: 3,
                        xhrSetup: function (xhr, u) {
                            // 走本机代理，同源，无需自定义头
                            try { xhr.withCredentials = false; } catch (e) {}
                        }
                    });
                    hlsInst.on(Hls.Events.MANIFEST_PARSED, function () {
                        try {
                            var p = v.play();
                            if (p && p.catch) p.catch(function () { /* 用户未交互时会被拦，无害 */ });
                        } catch (e) {}
                        done(resolve, d);
                    });
                    var retried = false;
                    hlsInst.on(Hls.Events.ERROR, function (evt, data) {
                        if (!data || !data.fatal) return;   // 非致命错误让 hls.js 自己恢复
                        var msg = '播放失败：' + (data.details || data.type || '未知');
                        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                            try { hlsInst.startLoad(); return; } catch (e) {}
                        }
                        // 清单/分片加载失败：很可能是这个源刚好抽风。
                        // 自动重新走一次 /play-url（服务端会换源），只重试一次避免死循环。
                        if (!retried && (data.type === Hls.ErrorTypes.NETWORK_ERROR
                                          || String(data.details || '').indexOf('manifest') >= 0)) {
                            retried = true;
                            done(reject, new Error(msg + '（将自动换源重试）'), true);
                            return;
                        }
                        done(reject, new Error(msg));
                    });
                    hlsInst.loadSource(url);
                    hlsInst.attachMedia(v);
                });
            });
        }).then(function (d) {
            if (opts.onReady) opts.onReady(d);
            return d;
        }).catch(function (e) {
            destroyHls();
            // 可重试的失败且还没重试过：清掉服务端对该集的缓存，逼它换源
            if (e && e.retryable && att < 2) {
                status('当前源失效，正在换源重试…');
                return fetchJson(API + '/reset-episode?name=' + encodeURIComponent(name) + '&ep=' + ep)
                    .catch(function () {})
                    .then(function () { return playOnce(att + 1); });
            }
            throw e;
        });
        }   // playOnce end

        pendingReq = runOnce().then(function (d) {
            pendingReq = null;
            return d;
        }).catch(function (e) {
            pendingReq = null;
            destroyHls();
            throw e;
        });

        return pendingReq;
    }

    function stop() {
        destroyHls();
        var v = $('bgmV');
        if (v) {
            try { v.pause(); } catch (e) {}
            if (v.dataset.online === '1') {
                v.removeAttribute('src');
                try { v.load(); } catch (e) {}
                v.dataset.online = '';
            }
        }
    }

    // 当前 video 是不是在线播放模式（bgm.js 切到本地文件前要清掉 hls）
    function isOnline() {
        var v = $('bgmV');
        return !!(v && v.dataset.online === '1');
    }

    window.vhBgmOnline = {
        play: play,
        stop: stop,
        isOnline: isOnline,
        fetchPlayUrl: fetchPlayUrl,
        API: API
    };
})();
