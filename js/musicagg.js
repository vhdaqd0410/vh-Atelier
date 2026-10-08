// vh-Atelier 音乐聚合（lxserver）· 本地服务管理
//
// lxserver = 多平台音乐聚合（网易云/QQ/酷我/酷狗/咪咕）的本地服务，
// 内置完整 Web 播放器。本模块负责：找到 node → 确保服务在跑（未跑则拉起）→
// 给面板一个可用的 base 地址。
//
// 端口 17899（ncm 用 17890、短剧扒歌 17891、视频下载 17892，避开）。
// 依赖：lxserver/node_modules 不入仓（首次运行需 npm install，与 ncm 同模式）；
//       服务目录与用户数据（data/音源、cache/试听缓存）都列在 updater 的 SKIP 里。
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path, childProcess, httpMod;
    try {
        fs = require('fs');
        path = require('path');
        childProcess = require('child_process');
        httpMod = require('http');
    } catch (e) { return; }

    var PORT = 17899;
    var BASE = 'http://127.0.0.1:' + PORT;
    var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;
    var extRoot = '';
    try { if (csInterface) extRoot = csInterface.getSystemPath(SystemPath.EXTENSION); } catch (e) {}
    var svcDir = extRoot ? path.join(extRoot, 'lxserver') : '';
    var entry = svcDir ? path.join(svcDir, 'index.js') : '';
    var LOG = svcDir ? path.join(svcDir, 'data', 'launch.log') : '';

    var child = null;
    var lastErr = '';

    function log(msg) {
        try {
            if (!LOG) return;
            var d = path.dirname(LOG);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n', 'utf8');
        } catch (e) {}
    }

    function findNode() {
        var cands = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe'];
        for (var i = 0; i < cands.length; i++) { if (fs.existsSync(cands[i])) return cands[i]; }
        try {
            var w = childProcess.spawnSync('where', ['node'], { encoding: 'utf8' });
            if (w.status === 0 && w.stdout) {
                var first = w.stdout.split('\n')[0].trim();
                if (first) return first;
            }
        } catch (e) {}
        return null;
    }

    // 依赖是否就位（node_modules 不入仓，首次要装）
    // 用 module-alias 判定：它被 index.js 第一行 require，缺失就启动不了。
    function hasDeps() {
        try {
            return fs.existsSync(path.join(svcDir, 'node_modules')) &&
                   fs.existsSync(path.join(svcDir, 'node_modules', 'module-alias')) &&
                   fs.existsSync(path.join(svcDir, 'node_modules', 'needle'));
        } catch (e) { return false; }
    }

    // 用 node 原生 http 探活（不依赖 XMLHttpRequest）
    function probe(timeoutMs, cb) {
        var done = false;
        function finish(ok, err) {
            if (done) return;
            done = true;
            cb(ok, err);
        }
        try {
            var req = httpMod.get(BASE + '/api/music/config', function (res) {
                res.resume();
                finish(res.statusCode >= 200 && res.statusCode < 500, null);
            });
            req.on('error', function (e) { finish(false, e); });
            req.setTimeout(timeoutMs || 2500, function () { req.abort(); finish(false, new Error('timeout')); });
        } catch (e) {
            finish(false, e);
        }
    }

    function spawnSvc() {
        try {
            if (!entry || !fs.existsSync(entry)) { log('entry missing: ' + entry); return false; }
            var node = findNode();
            if (!node) { log('node.exe not found'); return false; }
            if (child) { log('already spawned'); return true; }
            // 确保运行时目录存在（data 不入仓，首次要在本机建）
            try {
                var dd = path.join(svcDir, 'data');
                if (!fs.existsSync(dd)) fs.mkdirSync(dd, { recursive: true });
            } catch (e) { log('mkdir data err: ' + (e && e.message)); }
            // 首次没依赖：跑 npm install（与 ncm 同模式）
            if (!hasDeps()) {
                var npm = node.replace(/node\.exe$/i, 'npm.cmd');
                if (fs.existsSync(npm)) {
                    log('node_modules missing, running npm install...');
                    try {
                        childProcess.spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'],
                            { cwd: svcDir, windowsHide: true, timeout: 600000, stdio: 'ignore' });
                    } catch (e) { log('npm install err: ' + (e && e.message)); }
                } else {
                    log('npm.cmd not found at ' + npm);
                }
            }
            var env = {};
            Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
            // 关键：清掉系统代理（实测这些平台直连可达，走代理反而 TLS 失败）
            ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
                .forEach(function (k) { delete env[k]; });
            env.PORT = String(PORT);
            env.BIND_IP = '127.0.0.1';
            env.DATA_PATH = path.join(svcDir, 'data');
            env.LOG_PATH = path.join(svcDir, 'data', 'logs');
            env.DISABLE_TELEMETRY = 'true';
            env.SERVER_NAME = 'vh-music';
            env.USER_ENABLE_ROOT = 'true';
            env.PROXY_ALL_ENABLED = 'false';

            log('spawning: ' + node + ' ' + entry);
            child = childProcess.spawn(node, [entry], { cwd: svcDir, env: env, windowsHide: true });
            try {
                if (child.stdout) child.stdout.on('data', function (b) { log('out: ' + String(b).slice(0, 300)); });
                if (child.stderr) child.stderr.on('data', function (b) { log('err: ' + String(b).slice(0, 300)); });
            } catch (e) {}
            child.on('error', function (e) { log('spawn error: ' + (e && e.message)); child = null; });
            child.on('close', function (c) { log('exited code ' + c); child = null; });
            return true;
        } catch (e) {
            log('spawnSvc err: ' + (e && e.message));
            return false;
        }
    }

    // 对外：确保服务在跑（探活 → 不在则拉起 → 轮询等就绪）
    // cb(ok, info)  info={base,error,needDeps}
    function ensure(cb, onProgress) {
        probe(2500, function (ok) {
            if (ok) { cb(true, { base: BASE }); return; }
            // 依赖缺失时首次要 npm install（几分钟），等待时间放宽
            var needInstall = !hasDeps();
            spawnSvc();
            var maxTries = needInstall ? 300 : 45;   // 装依赖时最多等 ~5 分钟，否则 45 秒
            var tries = 0;
            (function poll() {
                tries++;
                if (onProgress) onProgress(tries, maxTries, needInstall);
                probe(2000, function (ok2, err) {
                    if (ok2) { cb(true, { base: BASE }); return; }
                    lastErr = err ? (err.message || String(err)) : '';
                    if (tries >= maxTries) { cb(false, { base: BASE, error: lastErr, needDeps: !hasDeps() }); return; }
                    setTimeout(poll, 1000);
                });
            })();
        });
    }

    window.__musicAgg = {
        PORT: PORT,
        base: function () { return BASE; },
        ensure: ensure,
        hasDeps: hasDeps,
        svcDir: function () { return svcDir; },
        // 面板显示用：Web 播放器地址
        // 实测：player.path 默认为空 → 播放器就在根路径（/music/ 是 404）
        playerUrl: function () { return BASE + '/'; },
        // 供高级用法：直接调它的 REST API
        api: function (p, opt) {
            opt = opt || {};
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open(opt.method || 'GET', BASE + p, true);
                if (opt.body) xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.timeout = opt.timeout || 30000;
                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;
                    if (xhr.status === 0) { reject(new Error('连不上音乐聚合服务')); return; }
                    try { resolve(JSON.parse(xhr.responseText || '{}')); }
                    catch (e) { reject(new Error('响应解析失败')); }
                };
                xhr.onerror = function () { reject(new Error('连不上音乐聚合服务')); };
                xhr.ontimeout = function () { reject(new Error('请求超时')); };
                xhr.send(opt.body ? JSON.stringify(opt.body) : null);
            });
        }
    };
})();
