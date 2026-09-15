// vh-Atelier 系列插件 · 在线更新模块
// 原理：GitHub 仓库（public）对应分支打包下载 → 解压 → 覆盖代码文件（跳过模型/引擎/用户数据）
// 特点：只同步代码（几百 KB），不动 bin/models/engine（GB 级，不常变）
// 用法：面板标题栏「⬆ 更新」按钮；或点标题栏版本号查看当前版本
(function () {
    var fs, path, os, cp;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        cp = require('child_process');
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
    var CFG_FILE = ROOT ? path.join(ROOT, 'version.json') : '';
    var TMP = path.join(os.tmpdir(), 'vh_update');

    // 这些目录/文件不参与更新（大文件 + 用户数据）
    var SKIP = ['collect', 'bin', 'models', 'engine', 'ncm', 'runtime', 'stubs',
                '.git', '_tmp', '_releases', 'node_modules'];

    function readCfg() {
        try {
            if (CFG_FILE && fs.existsSync(CFG_FILE)) {
                return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
            }
        } catch (e) {}
        return null;
    }

    function toast(msg, isErr) {
        if (window.__copyFlash) { window.__copyFlash(msg); return; }
        // 无全局提示时自建一个
        try {
            var tip = document.createElement('span');
            tip.textContent = msg || '';
            tip.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);background:' +
                (isErr ? '#3a2a2a' : '#2a3a2a') + ';color:' + (isErr ? '#ff9090' : '#7fd68b') +
                ';padding:6px 14px;border-radius:6px;font-size:12px;z-index:9999;pointer-events:none;';
            document.body.appendChild(tip);
            setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 2200);
        } catch (e) { console.log('[update]', msg); }
    }

    // 比对远程版本
    function checkUpdate(cb) {
        var cfg = readCfg();
        if (!cfg || !cfg.repo || !cfg.branch) { cb(new Error('未配置更新源（缺 version.json）')); return; }
        var url = 'https://raw.githubusercontent.com/' + cfg.repo + '/' + cfg.branch + '/version.json?_=' + Date.now();
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 20000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status !== 200) { cb(new Error('读取远程版本失败（HTTP ' + xhr.status + '）')); return; }
            var remote = null;
            try { remote = JSON.parse(xhr.responseText); } catch (e) { cb(new Error('远程版本文件解析失败')); return; }
            cb(null, {
                local: cfg,
                remote: remote,
                hasUpdate: String(remote.version || '') !== String(cfg.version || ''),
                remoteTime: remote.buildTime || ''
            });
        };
        xhr.onerror = function () { cb(new Error('网络错误（无法访问 GitHub）')); };
        xhr.ontimeout = function () { cb(new Error('请求超时')); };
        xhr.send();
    }

    // 执行更新：下载分支 zip → 解压 → 覆盖代码
    function doUpdate(onLog, cb) {
        var cfg = readCfg();
        if (!cfg) { cb(new Error('未配置更新源')); return; }
        var log = onLog || function () {};
        var zipUrl = 'https://codeload.github.com/' + cfg.repo + '/zip/refs/heads/' + cfg.branch;
        var zipFile = path.join(os.tmpdir(), 'vh_update_' + Date.now() + '.zip');

        (async function () {
            try {
                log('下载更新包…');
                await download(zipUrl, zipFile, function (pct) {
                    if (pct % 20 === 0) log('下载中 ' + pct + '%');
                });
                log('解压…');
                var outDir = TMP + '_' + Date.now();
                if (fs.existsSync(outDir)) rmrf(outDir);
                fs.mkdirSync(outDir, { recursive: true });
                await unzip(zipFile, outDir);
                // zip 解压后是一个顶层目录（仓库名-分支）
                var tops = fs.readdirSync(outDir).filter(function (f) {
                    return fs.statSync(path.join(outDir, f)).isDirectory();
                });
                if (!tops.length) throw new Error('解压结果为空');
                var srcRoot = path.join(outDir, tops[0]);
                log('覆盖代码文件（跳过模型/引擎/用户数据）…');
                var n = copyTree(srcRoot, ROOT, ROOT);
                log('已更新 ' + n + ' 个文件');
                try { fs.unlinkSync(zipFile); } catch (e) {}
                try { rmrf(outDir); } catch (e) {}
                cb(null, { files: n });
            } catch (e) {
                try { fs.unlinkSync(zipFile); } catch (_) {}
                cb(e);
            }
        })();
    }

    // 递归复制，跳过 SKIP 目录；返回复制文件数
    function copyTree(src, dst, root) {
        var n = 0;
        var items = fs.readdirSync(src);
        items.forEach(function (name) {
            if (SKIP.indexOf(name) >= 0) return;           // 跳过指定目录/文件
            var s = path.join(src, name);
            var st = fs.statSync(s);
            if (st.isDirectory()) {
                var d = path.join(dst, name);
                try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
                n += copyTree(s, d, root);
            } else {
                // 不覆盖用户数据文件
                if (name === '.gitignore') return;
                try {
                    fs.copyFileSync(s, path.join(dst, name));
                    n++;
                } catch (e) {}
            }
        });
        return n;
    }

    function rmrf(p) {
        try {
            if (!fs.existsSync(p)) return;
            var st = fs.statSync(p);
            if (st.isDirectory()) {
                fs.readdirSync(p).forEach(function (f) { rmrf(path.join(p, f)); });
                fs.rmdirSync(p);
            } else {
                fs.unlinkSync(p);
            }
        } catch (e) {}
    }

    // 下载（Node http/https，写文件）
    function download(url, dest, onPct) {
        return new Promise(function (resolve, reject) {
            var mod = url.indexOf('https') === 0 ? require('https') : require('http');
            mod.get(url, { headers: { 'User-Agent': 'vh-Atelier-updater' } }, function (res) {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return download(res.headers.location, dest, onPct).then(resolve, reject);
                }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
                var total = parseInt(res.headers['content-length'] || '0', 10);
                var got = 0, last = -1;
                var f = fs.createWriteStream(dest);
                res.on('data', function (c) {
                    got += c.length;
                    if (total > 0 && onPct) {
                        var pct = Math.floor(got * 100 / total);
                        if (pct !== last) { last = pct; onPct(pct); }
                    }
                });
                res.pipe(f);
                f.on('finish', function () { f.close(function () { resolve(); }); });
                f.on('error', reject);
            }).on('error', reject);
        });
    }

    // 解压 zip：优先用 Windows 自带 PowerShell（无需第三方库）
    function unzip(zipFile, outDir) {
        return new Promise(function (resolve, reject) {
            var ps = 'Expand-Archive -LiteralPath "' + zipFile.replace(/"/g, '') +
                     '" -DestinationPath "' + outDir.replace(/"/g, '') + '" -Force';
            cp.exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"',
                { windowsHide: true, timeout: 180000 }, function (err, so, se) {
                    if (err) return reject(new Error('解压失败: ' + String(se || err.message).slice(0, 150)));
                    resolve();
                });
        });
    }

    window.__vhUpdate = {
        check: checkUpdate,
        run: doUpdate,
        version: function () { var c = readCfg(); return c ? c.version : ''; },
        info: function () { return readCfg(); }
    };
})();
