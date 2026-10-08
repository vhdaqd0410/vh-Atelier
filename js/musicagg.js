// vh-Atelier 音乐聚合（lxserver）· 服务地址管理与探测
//
// 两种形态：
//   本地 —— 插件目录自带的 lxserver，进程随面板拉起（端口 17899）
//   服务器 —— 部署在你自己的服务器上的 lxserver，插件只做客户端
// 面板可在两者之间切换，选择记在 localStorage。
//
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

    var LOCAL_PORT = 17899;
    var LOCAL_BASE = 'http://127.0.0.1:' + LOCAL_PORT;
    var CFG_KEY = 'vh_musicagg_target';     // 'local' | 'server'
    var SERVER_KEY = 'vh_musicagg_server';  // 服务器地址

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

    // ---------- 目标配置 ----------
    function getTarget() {
        try { return localStorage.getItem(CFG_KEY) || 'local'; } catch (e) { return 'local'; }
    }
    function setTarget(t) {
        try { localStorage.setItem(CFG_KEY, (t === 'server') ? 'server' : 'local'); } catch (e) {}
    }
    function getServerUrl() {
        try {
            var v = localStorage.getItem(SERVER_KEY) || '';
            return v.trim().replace(/\/+$/, '');
        } catch (e) { return ''; }
    }
    function setServerUrl(u) {
        try { localStorage.setItem(SERVER_KEY, String(u || '').trim().replace(/\/+$/, '')); } catch (e) {}
    }
    function base() {
        if (getTarget() === 'server') {
            var s = getServerUrl();
            return s || '';
        }
        return LOCAL_BASE;
    }

    // ---------- 本地服务管理 ----------
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

    function hasDeps() {
        try {
            return fs.existsSync(path.join(svcDir, 'node_modules')) &&
                   fs.existsSync(path.join(svcDir, 'node_modules', 'module-alias')) &&
                   fs.existsSync(path.join(svcDir, 'node_modules', 'needle'));
        } catch (e) { return false; }
    }

    function spawnSvc() {
        try {
            if (!entry || !fs.existsSync(entry)) { log('entry missing: ' + entry); return false; }
            var node = findNode();
            if (!node) { log('node.exe not found'); return false; }
            if (child) { log('already spawned'); return true; }
            try {
                var dd = path.join(svcDir, 'data');
                if (!fs.existsSync(dd)) fs.mkdirSync(dd, { recursive: true });
            } catch (e) { log('mkdir data err: ' + (e && e.message)); }
            if (!hasDeps()) {
                var npm = node.replace(/node\.exe$/i, 'npm.cmd');
                if (fs.existsSync(npm)) {
                    log('node_modules missing, running npm install...');
                    try {
                        childProcess.spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'],
                            { cwd: svcDir, windowsHide: true, timeout: 900000, stdio: 'ignore' });
                    } catch (e) { log('npm install err: ' + (e && e.message)); }
                } else {
                    log('npm.cmd not found at ' + npm);
                }
            }
            var env = {};
            Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
            ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
                .forEach(function (k) { delete env[k]; });
            env.PORT = String(LOCAL_PORT);
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

    // 用 node 原生 http 探活（支持跨域地址）
    function probeUrl(url, timeoutMs, cb) {
        var done = false;
        function finish(ok, err) {
            if (done) return;
            done = true;
            cb(ok, err);
        }
        try {
            var u = new URL(url);
            var mod = (u.protocol === 'https:') ? require('https') : httpMod;
            var req = mod.get(url + '/api/music/config', function (res) {
                res.resume();
                finish(res.statusCode >= 200 && res.statusCode < 500, null);
            });
            req.on('error', function (e) { finish(false, e); });
            req.setTimeout(timeoutMs || 2500, function () { req.abort(); finish(false, new Error('timeout')); });
        } catch (e) {
            finish(false, e);
        }
    }

    // 对外：确保目标可用
    //   target=local  → 探活本地，不在则拉起
    //   target=server → 只探活（远程服务由你在服务器上维护）
    // cb(ok, info)  info = { base, target, error, needDeps }
    function ensure(cb, onProgress) {
        var t = getTarget();
        var b = base();
        if (!b) { cb(false, { base: '', target: t, error: '未填写服务器地址' }); return; }

        probeUrl(b, 2500, function (ok) {
            if (ok) { cb(true, { base: b, target: t }); return; }

            if (t === 'server') {
                // 远程服务：不尝试拉起，直接轮询一会儿（服务器可能刚重启）
                var n = 0;
                (function poll() {
                    n++;
                    if (onProgress) onProgress(n, 20, false);
                    probeUrl(b, 2500, function (ok2, err) {
                        if (ok2) { cb(true, { base: b, target: t }); return; }
                        lastErr = err ? (err.message || String(err)) : '';
                        if (n >= 20) { cb(false, { base: b, target: t, error: lastErr }); return; }
                        setTimeout(poll, 1000);
                    });
                })();
                return;
            }

            // 本地服务：拉起
            var needInstall = !hasDeps();
            spawnSvc();
            var maxTries = needInstall ? 300 : 45;
            var tries = 0;
            (function poll() {
                tries++;
                if (onProgress) onProgress(tries, maxTries, needInstall);
                probeUrl(b, 2000, function (ok2, err) {
                    if (ok2) { cb(true, { base: b, target: t }); return; }
                    lastErr = err ? (err.message || String(err)) : '';
                    if (tries >= maxTries) { cb(false, { base: b, target: t, error: lastErr, needDeps: !hasDeps() }); return; }
                    setTimeout(poll, 1000);
                });
            })();
        });
    }

    // ---------- 音源包：导出 / 一键导入（仅本地模式）----------
    // 设计意图：你在一台机器上配好音源，导出成 zip；拷到其他机器一键导入。
    // 只操作本地服务目录（lxserver/data/users/source），不动服务器。
    function sourceDir() {
        if (!svcDir) return '';
        return path.join(svcDir, 'data', 'users', 'source');
    }

    function runPS(script, extraEnv, timeoutMs) {
        return new Promise(function (resolve) {
            var ps = ['Add-Type -AssemblyName System.Windows.Forms;'].concat(script).join(' ');
            var env = Object.assign({}, process.env, extraEnv || {});
            var out = '';
            try {
                var r = childProcess.spawnSync('powershell', ['-NoProfile', '-Command', ps],
                    { env: env, encoding: 'utf8', timeout: timeoutMs || 180000 });
                out = (r.stdout || '').trim();
            } catch (e) { out = ''; }
            resolve(out);
        });
    }

    // 导出：把 source 目录打包成 zip（选保存位置）
    function exportSources(cb) {
        var src = sourceDir();
        if (!src || !fs.existsSync(src)) { cb(false, '本地还没有音源目录'); return; }
        var tmp = path.join(svcDir, 'data', '_sources_bak.zip');
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
        var save = path.join(svcDir, 'data', '_save_path.txt');
        try { if (fs.existsSync(save)) fs.unlinkSync(save); } catch (e) {}
        var script = [
            '$s=New-Object System.Windows.Forms.SaveFileDialog;',
            '$s.Filter="音源包 (*.zip)|*.zip";',
            '$s.FileName="vh-音源包-" + (Get-Date -Format yyyyMMdd) + ".zip";',
            'if($s.ShowDialog() -ne "OK"){exit};',
            '$dst=$s.FileName;',
            'if(Test-Path -LiteralPath $env:VH_TMP){Remove-Item -LiteralPath $env:VH_TMP -Force};',
            'Compress-Archive -Path (Join-Path $env:VH_SRC "*") -DestinationPath $env:VH_TMP -Force;',
            'Copy-Item -LiteralPath $env:VH_TMP -Destination $dst -Force;',
            '[System.IO.File]::WriteAllText($env:VH_OUT,$dst,[System.Text.UTF8Encoding]::new($false));',
        ];
        runPS(script, { VH_SRC: src, VH_TMP: tmp, VH_OUT: save }, 180000).then(function () {
            var dstPath = '';
            try { if (fs.existsSync(save)) { dstPath = fs.readFileSync(save, 'utf8').trim(); fs.unlinkSync(save); } } catch (e) {}
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
            if (dstPath) cb(true, dstPath); else cb(false, '已取消');
        });
    }

    // 导入：选 zip，解压到 source 目录（同名不覆盖，避免冲掉已有源）
    function importSources(cb) {
        var src = sourceDir();
        if (!src) { cb(false, '服务目录未知'); return; }
        try { if (!fs.existsSync(src)) fs.mkdirSync(src, { recursive: true }); } catch (e) {}
        var pick = path.join(svcDir, 'data', '_pick_path.txt');
        try { if (fs.existsSync(pick)) fs.unlinkSync(pick); } catch (e) {}
        var openScript = [
            '$f=New-Object System.Windows.Forms.OpenFileDialog;',
            '$f.Filter="音源包 (*.zip)|*.zip|所有文件|*.*";',
            'if($f.ShowDialog() -eq "OK"){[System.IO.File]::WriteAllText($env:VH_OUT,$f.FileName,[System.Text.UTF8Encoding]::new($false))}',
        ];
        runPS(openScript, { VH_OUT: pick }, 120000).then(function () {
            var zipPath = '';
            try { if (fs.existsSync(pick)) { zipPath = fs.readFileSync(pick, 'utf8').trim(); fs.unlinkSync(pick); } } catch (e) {}
            if (!zipPath) { cb(false, '已取消'); return; }
            if (!fs.existsSync(zipPath)) { cb(false, '文件不存在'); return; }
            // 解压到临时目录，再逐个拷贝（同名跳过）
            var tmpDir = path.join(svcDir, 'data', '_import_tmp');
            try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
            var exScript = [
                'if(Test-Path -LiteralPath $env:VH_TMP){Remove-Item -LiteralPath $env:VH_TMP -Recurse -Force};',
                'Expand-Archive -LiteralPath $env:VH_ZIP -DestinationPath $env:VH_TMP -Force;',
            ];
            runPS(exScript, { VH_ZIP: zipPath, VH_TMP: tmpDir }, 300000).then(function () {
                if (!fs.existsSync(tmpDir)) { cb(false, '解压失败'); return; }
                var added = 0, skipped = 0;
                (function walk(dir, relBase) {
                    var items = [];
                    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
                    items.forEach(function (it) {
                        var full = path.join(dir, it.name);
                        var rel = relBase ? path.join(relBase, it.name) : it.name;
                        if (it.isDirectory()) { walk(full, rel); return; }
                        if (!/\.js$/i.test(it.name)) return;   // 只收 .js 音源脚本
                        var dst = path.join(src, '_open', it.name);
                        try {
                            fs.mkdirSync(path.dirname(dst), { recursive: true });
                            if (fs.existsSync(dst)) { skipped++; return; }
                            fs.copyFileSync(full, dst);
                            added++;
                        } catch (e) { skipped++; }
                    });
                })(tmpDir, '');
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
                cb(true, { added: added, skipped: skipped });
            });
        });
    }

    window.__musicAgg = {
        LOCAL_PORT: LOCAL_PORT,
        localBase: function () { return LOCAL_BASE; },
        base: base,
        getTarget: getTarget,
        setTarget: setTarget,
        getServerUrl: getServerUrl,
        setServerUrl: setServerUrl,
        ensure: ensure,
        hasDeps: hasDeps,
        svcDir: function () { return svcDir; },
        // 播放器地址（lxserver 的 player.path 默认为空 → 根路径）
        playerUrl: function () {
            var b = base();
            if (!b) return '';
            return b + '/';
        },
        // 直接调它的 REST API
        api: function (p, opt) {
            opt = opt || {};
            var b = base();
            return new Promise(function (resolve, reject) {
                if (!b) { reject(new Error('未配置服务地址')); return; }
                var xhr = new XMLHttpRequest();
                xhr.open(opt.method || 'GET', b + p, true);
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
        },
        // 音源包：导出 / 一键导入（仅本地模式）
        exportSources: exportSources,
        importSources: importSources,
        sourceDir: sourceDir
    };
})();
