// vh-Atelier 在线反馈（中转版）
//
// 设计：插件不直连 GitHub，也不包含任何令牌 —— 提交到「反馈中转服务」，
//       由服务端用自己的令牌代为创建 Issue。这样分发给别人的插件里没有凭据。
//
// 配置（可选；不配也能用，走内置默认地址）：
//   在插件目录 feedback.json 里可覆盖：
//   {
//     "endpoint": "http://你的服务器:17893/api/feedback",
//     "secret": "",            // 若服务端启用了口令，这里填同样的
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

    // 默认中转地址（部署服务后改成你的公网地址即可，无需重新分发插件）
    var DEFAULT_ENDPOINT = 'http://YOUR_SERVER_IP:17893/api/feedback';

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

    // ---------- 提交 ----------
    function post(endpoint, payload, timeout, cb) {
        var u = parseEndpoint(endpoint);
        if (!u) return cb(new Error('中转地址无效：' + endpoint));

        var mod = (u.protocol === 'https:') ? https : http;
        var data = JSON.stringify(payload);
        var opts = {
            hostname: u.hostname,
            port: u.port,
            path: u.path,
            method: 'POST',
            headers: {
                'User-Agent': 'vh-Atelier-feedback',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            },
            timeout: timeout
        };
        var req = mod.request(opts, function (res) {
            var buf = '';
            res.on('data', function (d) { buf += d.toString(); });
            res.on('end', function () {
                var j = null;
                try { j = JSON.parse(buf); } catch (e) {}
                if (res.statusCode >= 200 && res.statusCode < 300 && j && j.ok) return cb(null, j);
                var msg = (j && j.error) || ('HTTP ' + res.statusCode);
                if (res.statusCode === 403) msg = '口令不正确';
                else if (res.statusCode === 429) msg = '提交太频繁，请稍后再试';
                else if (res.statusCode === 404) msg = '中转服务地址不对（404）';
                cb(new Error(msg));
            });
        });
        req.on('error', function (e) {
            cb(new Error('连不上中转服务：' + e.message +
                '（地址 ' + u.hostname + ':' + opts.port + '，请确认服务器可达）'));
        });
        req.on('timeout', function () {
            try { req.destroy(); } catch (e) {}
            cb(new Error('请求超时（' + timeout + 'ms）'));
        });
        req.write(data);
        req.end();
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
        ping: ping
    };
})();
