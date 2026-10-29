// vh-Atelier 在线反馈（自建反馈中心版）
//
// 设计：插件不连接任何第三方服务，也不包含任何凭据 —— 提交到自建的反馈中心，
//       数据全部存在自己的服务器上。别的电脑只要能访问该服务器就能提反馈。
//
// 配置（可选；不配也能用，走内置默认地址）：
//   在插件目录 feedback.json 里可覆盖：
//   {
//     "endpoint": "http://47.122.108.231:17893/api/feedback",
//     "base": "http://47.122.108.231:17893",   // 反馈中心网页地址
//     "secret": "",                            // 服务端启用口令才需要
//     "timeout": 20000
//   }
//
// 提交内容：类型 / 标题 / 详情 / 运行环境 / 最近日志
(function () {
    var fs, path, os, http, https;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        http = require('http');
        https = require('https');
    } catch (e) { return; }

    var csInterface = (typeof CSInterface !== 'undefined') ? new CSInterface() : null;

    function extRoot() {
        var r = '';
        try { if (csInterface) r = csInterface.getSystemPath('extension'); } catch (_) {}
        if (r && fs.existsSync(r)) return r;
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (_) {}
        return '';
    }

    var ROOT = extRoot();
    var CFG_USER = ROOT ? path.join(ROOT, 'collect', 'feedback.json') : '';
    var CFG_ROOT = ROOT ? path.join(ROOT, 'feedback.json') : '';
    var CFG_SAMPLE = ROOT ? path.join(ROOT, 'feedback.example.json') : '';
    var VER_FILE = ROOT ? path.join(ROOT, 'version.json') : '';

    // 默认中转地址（自建反馈中心）
    var DEFAULT_ENDPOINT = 'http://47.122.108.231:17893/api/feedback';
    var DEFAULT_BASE = 'http://47.122.108.231:17893';

    function readJson(p) {
        try {
            if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (e) {}
        return null;
    }
    function cfg() {
        var j1 = readJson(CFG_USER);
        var j2 = readJson(CFG_ROOT);
        var c = j1 || j2 || {};
        var v = readJson(VER_FILE) || {};
        return {
            endpoint: String(c.endpoint || DEFAULT_ENDPOINT).trim(),
            base: String(c.base || DEFAULT_BASE).trim(),
            secret: String(c.secret || '').trim(),
            timeout: Number(c.timeout) || 20000,
            displayName: v.displayName || 'vh-Atelier',
            version: v.version || '?',
            cfgPath: j1 ? CFG_USER : (j2 ? CFG_ROOT : CFG_USER),
            samplePath: CFG_SAMPLE,
            isDefaultEndpoint: !c.endpoint
        };
    }

    // ---------- 环境信息 ----------
    function collectEnv() {
        var lines = [];
        var c = cfg();
        lines.push('插件 ' + c.displayName + ' v' + c.version);
        try { lines.push('系统 ' + os.type() + ' ' + os.release() + ' (' + os.arch() + ')'); } catch (e) {}
        try { lines.push('Node ' + process.versions.node); } catch (e) {}
        try {
            var d = new Date();
            var p = function (n) { return (n < 10 ? '0' : '') + n; };
            lines.push('时间 ' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                       ' ' + p(d.getHours()) + ':' + p(d.getMinutes()));
        } catch (e) {}
        return lines.join(' / ');
    }

    function recentLogs(maxLines) {
        try {
            if (window.__vhLog && typeof window.__vhLog.tail === 'function') {
                var t = window.__vhLog.tail(maxLines || 40);
                if (t) return String(t);
            }
        } catch (e) {}
        try {
            var f = ROOT ? path.join(ROOT, 'collect', 'error.log') : '';
            if (f && fs.existsSync(f)) {
                var raw = fs.readFileSync(f, 'utf8').split('\n');
                return raw.slice(-(maxLines || 40)).join('\n');
            }
        } catch (e) {}
        return '';
    }

    // 解析端点（用 WHATWG URL，避免 url.parse 在 Node 24 的废弃警告）
    function parseEndpoint(ep) {
        try {
            var u = new URL(ep);
            return {
                protocol: u.protocol,
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? '443' : '80'),
                path: (u.pathname || '/') + (u.search || ''),
                origin: u.origin
            };
        } catch (e) {
            return null;
        }
    }

    // 计算 UTF-8 字节数。不能直接用 Buffer.byteLength：
    // 某些 CEP 上下文里 Buffer 可能不可用（Node 集成未启用/被沙箱限制），
    // 一旦抛错整个 post() 就中断，请求发不出去。
    function utf8ByteLength(str) {
        try {
            if (typeof Buffer !== 'undefined' && Buffer && typeof Buffer.byteLength === 'function') {
                return Buffer.byteLength(str);
            }
        } catch (e) {}
        var n = 0;
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) n += 1;
            else if (c < 0x800) n += 2;
            else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
            else n += 3;
        }
        return n;
    }

    // ---------- 提交 ----------

    // 提交反馈。
    //
    // 为什么用 XMLHttpRequest 而不是 Node 的 http 模块：
    //   在 CEP 面板里，Node http 的请求确实发出去了（服务端日志能看到，
    //   数据也写进了库），但 response 回调不回到 JS 上下文，
    //   界面就永远等不到结果，表现为「一直正在提交」。
    //   插件里 license-client.js 用 XHR 调授权服务器一直稳定，所以这里也走 XHR。
    //
    // 解析响应：2xx 一律视为服务器已收下；只有明确 4xx/5xx 才报错。
    // 这样即使响应体格式有变化，也不会出现「已入库却提示失败」。
    function handleResponse(status, text, cb, settledRef) {
        if (settledRef.settled) return;
        settledRef.settled = true;

        var j = null;
        try { j = JSON.parse(text); } catch (e) {}

        if (status === 0) {
            return cb(new Error('连不上反馈服务器（网络不可达或被拦截）'));
        }
        if (status >= 200 && status < 300) {
            // 服务器明确说失败才失败
            if (j && j.ok === false) {
                return cb(new Error(j.error || ('服务器拒绝：HTTP ' + status)));
            }
            return cb(null, j || { ok: true, raw: text });
        }
        if (status === 403) return cb(new Error('口令不正确'));
        if (status === 429) return cb(new Error('提交太频繁，请稍后再试'));
        if (status === 404) return cb(new Error('反馈服务地址不对（404）'));
        return cb(new Error((j && j.error) || ('HTTP ' + status)));
    }

    function post(endpoint, payload, timeout, cb) {
        var data = JSON.stringify(payload);
        var ref = { settled: false };

        // ---- 主通道：XHR（CEP 里最可靠）----
        var xhr = null;
        try {
            if (typeof XMLHttpRequest !== 'undefined') xhr = new XMLHttpRequest();
        } catch (e) { xhr = null; }

        if (xhr) {
            try {
                xhr.open('POST', endpoint, true);
                try { xhr.setRequestHeader('Content-Type', 'application/json'); } catch (e) {}
                // 缩短等待：正常 100ms 内就能完成，8 秒足够；不要让人干等 20 秒
                xhr.timeout = Math.min(timeout || 8000, 10000);

                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;
                    handleResponse(xhr.status, xhr.responseText || '', cb, ref);
                };
                xhr.ontimeout = function () {
                    if (ref.settled) return;
                    ref.settled = true;
                    cb(new Error('提交超时，请检查网络后重试'));
                };
                xhr.onerror = function () {
                    if (ref.settled) return;
                    ref.settled = true;
                    cb(new Error('连不上反馈服务器，请检查网络'));
                };

                xhr.send(data);
                return;
            } catch (e) {
                // XHR 构造/发送异常，退到 Node http
                ref.settled = false;
            }
        }

        // ---- 兜底通道：Node http ----
        var u = parseEndpoint(endpoint);
        if (!u) return cb(new Error('反馈服务地址无效：' + endpoint));

        var mod = (u.protocol === 'https:') ? https : http;
        var settled = false;
        function done(err, ok) {
            if (settled) return;
            settled = true;
            try { cb(err, ok); } catch (e) {}
        }

        var gotResponse = false, statusCode = 0, respBody = '';

        var req;
        try {
            req = mod.request({
                hostname: u.hostname,
                port: u.port,
                path: u.path,
                method: 'POST',
                headers: {
                    'User-Agent': 'vh-Atelier-feedback',
                    'Content-Type': 'application/json',
                    'Content-Length': utf8ByteLength(data)
                },
                timeout: timeout
            }, function (res) {
                gotResponse = true;
                statusCode = res.statusCode;
                res.on('data', function (d) { respBody += d.toString(); });
                res.on('end', function () {
                    handleResponse(statusCode, respBody, function (e, r) { done(e, r); },
                                   { get settled() { return settled; }, set settled(v) { settled = v; } });
                });
            });
        } catch (e) {
            return done(new Error('请求构造失败：' + (e && e.message ? e.message : e)));
        }

        req.on('error', function (e) {
            done(new Error('连不上反馈服务器：' + (e && e.message)));
        });
        req.on('timeout', function () {
            try { req.destroy(); } catch (e) {}
            if (gotResponse) { handleResponse(statusCode, respBody, function (e2, r) { done(e2, r); }, { settled: false }); return; }
            done(new Error('提交超时，请检查网络后重试'));
        });
        req.on('close', function () {
            if (settled || gotResponse) return;
            done(new Error('连接被关闭，未收到响应'));
        });

        try { if (typeof req.setTimeout === 'function') req.setTimeout(timeout); } catch (e) {}
        try {
            req.write(data);
            req.end();
        } catch (e) {
            done(new Error('发送请求失败：' + (e && e.message ? e.message : e)));
        }
    }

    // kind: 'bug' | 'idea' | 'other'
    function submitFeedback(kind, title, detail, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        opts = opts || {};
        var c = cfg();
        if (!title || !String(title).trim()) return cb(new Error('请填写标题'));

        var payload = {
            kind: ['bug', 'idea', 'other'].indexOf(kind) >= 0 ? kind : 'other',
            title: String(title).trim().slice(0, 200),
            detail: String(detail || '').slice(0, 15000),
            env: collectEnv(),
            version: c.version,
            secret: c.secret
        };
        if (opts.withLogs !== false) {
            var lg = recentLogs(40);
            if (lg) payload.logs = lg.slice(0, 8000);
        }
        post(c.endpoint, payload, c.timeout, cb);
    }

    // 探测中转服务是否可用
    function ping(cb) {
        var c = cfg();
        var u = parseEndpoint(c.endpoint);
        if (!u) return cb(new Error('中转地址无效：' + c.endpoint));
        var base = u.origin + '/api/health';
        var mod = (u.protocol === 'https:') ? https : http;
        var req = mod.get(base, { timeout: 8000 }, function (res) {
            var buf = '';
            res.on('data', function (d) { buf += d.toString(); });
            res.on('end', function () {
                try { cb(null, JSON.parse(buf)); } catch (e) { cb(new Error('返回异常')); }
            });
        });
        req.on('error', function (e) { cb(new Error('不可达：' + e.message)); });
        req.on('timeout', function () { try { req.destroy(); } catch (e) {} cb(new Error('超时')); });
    }

    window.__vhFeedback = {
        cfg: cfg,
        configured: function () { return true; },   // 中转模式下无需本机凭据
        submit: submitFeedback,
        collectEnv: collectEnv,
        recentLogs: recentLogs,
        ping: ping,
        // 用系统浏览器打开反馈中心网页
        openBoard: function () {
            var c = cfg();
            try {
                require('child_process').exec('start "" "' + c.base + '"');
                return true;
            } catch (e) { return false; }
        }
    };
})();
