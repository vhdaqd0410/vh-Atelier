// vh-Atelier · CosyVoice3 引擎包导入
//
// 场景：用户从网盘下载了 cosyvoice3-V30-slim.zip（约 8.1 GB），
//       不想手动解压、手动改路径。
// 做法：扫描下载目录找 zip → 校验结构 → tar 解压 → 自动配置路径。
//
// 为什么用系统 tar 而不是自己解 zip：
//   Windows 10 1803+ 自带 bsdtar，实测解 8 GB zip 达 92 MB/s，
//   而 CEP 里没有可靠的纯 JS zip 库能处理 8 GB / 8800 条目。
(function () {
    'use strict';

    var fs, path, os2, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        os2 = require('os');
        childProcess = require('child_process');
    } catch (e) {
        window.__vhCosyImport = { scan: function () { return []; } };
        return;
    }

    // zip 内必须存在的三个目录（缺任一就不是有效引擎包）
    var REQUIRED_DIRS = ['_internal', 'cosyvoice', 'pretrained_models'];
    // 关键文件（体积校验，防解压不完整）
    var REQUIRED_FILES = [
        { p: '_internal/torch/lib/torch_cuda.dll', minMB: 500 },
        { p: 'pretrained_models/llm.pt', minMB: 1500 },
        { p: 'pretrained_models/flow.pt', minMB: 1000 }
    ];

    // 常见的下载目录
    function downloadDirs() {
        var out = [];
        var home = '';
        try { home = os2.homedir(); } catch (e) {}
        var up = '';
        try { up = process.env.USERPROFILE || ''; } catch (e) {}

        var bases = [home, up].filter(Boolean);
        bases.forEach(function (b) {
            out.push(path.join(b, 'Downloads'));
            out.push(path.join(b, 'Desktop'));
            out.push(path.join(b, '下载'));
        });

        // 百度网盘默认下载目录
        var bd = ['BaiduNetdiskDownload', 'BaiduNetdisk', 'Documents\\BaiduNetdiskDownload'];
        bases.forEach(function (b) {
            bd.forEach(function (d) { out.push(path.join(b, d)); });
        });

        // 去重、只留存在的
        var seen = {};
        var res = [];
        out.forEach(function (p) {
            if (!p || seen[p]) return;
            seen[p] = 1;
            try { if (fs.existsSync(p)) res.push(p); } catch (e) {}
        });
        return res;
    }

    // 在目录里找 zip（只看一层，递归太慢）
    function findZips(dir) {
        var hits = [];
        try {
            var list = fs.readdirSync(dir, { withFileTypes: true });
            for (var i = 0; i < list.length; i++) {
                var f = list[i];
                if (!f.isFile()) continue;
                if (!/\.zip$/i.test(f.name)) continue;
                // 只要看起来像引擎包的名字
                if (!/cosyvoice/i.test(f.name)) continue;
                var full = path.join(dir, f.name);
                var st = null;
                try { st = fs.statSync(full); } catch (e) { continue; }
                hits.push({
                    path: full,
                    name: f.name,
                    size: st.size,
                    mtime: st.mtimeMs
                });
            }
        } catch (e) {}
        return hits;
    }

    // 扫描所有已知下载目录
    function scan() {
        var dirs = downloadDirs();
        var all = [];
        dirs.forEach(function (d) {
            findZips(d).forEach(function (z) {
                z.dir = d;
                all.push(z);
            });
        });
        // 按修改时间倒序（最新的最可能是刚下的）
        all.sort(function (a, b) { return b.mtime - a.mtime; });
        return all;
    }

    // 列出 zip 内容（用 tar -tf，可读 8GB 而不解压）
    function listZip(zipPath) {
        return new Promise(function (resolve, reject) {
            try {
                var cp = childProcess.execFile('tar', ['-tf', zipPath],
                    { maxBuffer: 64 * 1024 * 1024, timeout: 180000, encoding: 'utf8' },
                    function (err, stdout) {
                        if (err) { reject(new Error('读取压缩包失败（可能损坏）: ' + err.message)); return; }
                        var lines = String(stdout || '').split(/\r?\n/).filter(function (x) { return x.trim(); });
                        resolve(lines);
                    });
            } catch (e) { reject(e); }
        });
    }

    // 校验 zip 是否为有效引擎包
    function validate(zipPath) {
        return listZip(zipPath).then(function (names) {
            // 目录名可能是 "dir/" 或 "dir/file"，统一判断前缀
            var has = {};
            names.forEach(function (n) {
                var norm = n.replace(/\\/g, '/');
                var first = norm.split('/')[0];
                if (first) has[first] = 1;
            });

            var missDir = REQUIRED_DIRS.filter(function (d) { return !has[d]; });
            if (missDir.length) {
                throw new Error('不是有效的引擎包，缺少目录：' + missDir.join('、'));
            }

            // 关键文件（用名字匹配，不读内容）
            var missFile = [];
            REQUIRED_FILES.forEach(function (rf) {
                var want = rf.p.replace(/\//g, '/');
                var found = names.some(function (n) {
                    return n.replace(/\\/g, '/').toLowerCase() === want.toLowerCase();
                });
                if (!found) missFile.push(rf.p);
            });
            if (missFile.length) {
                throw new Error('引擎包不完整，缺少文件：' + missFile.join('、'));
            }

            return {
                ok: true,
                entries: names.length,
                hasDirs: REQUIRED_DIRS
            };
        });
    }

    // 探测目标目录可用空间（返回 MB）
    function freeSpaceMB(dir) {
        try {
            // Windows 上没有直接 API，用 PowerShell 查
            var drive = String(dir).slice(0, 2);
            var r = childProcess.spawnSync('powershell',
                ['-NoProfile', '-Command',
                 '(Get-PSDrive ' + drive.replace(':', '') + ' -EA SilentlyContinue).Free'],
                { encoding: 'utf8', timeout: 15000, windowsHide: true });
            var n = parseInt(String(r.stdout || '').trim(), 10);
            if (!isNaN(n)) return n / 1024 / 1024;
        } catch (e) {}
        return -1;
    }

    // 解压（tar -xf，实测 92 MB/s）
    // onProgress({percent, doneMB, totalMB, phase})
    function extract(zipPath, targetDir, onProgress) {
        return new Promise(function (resolve, reject) {
            try {
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }

                var started = Date.now();
                var cp = childProcess.spawn('tar', ['-xf', zipPath, '-C', targetDir],
                    { windowsHide: true });

                // 估算总大小：zip 8.14 GB → 解压后 10.64 GB
                var zipMB = 0;
                try { zipMB = fs.statSync(zipPath).size / 1024 / 1024; } catch (e) {}
                var estTotalMB = zipMB * 1.31;
                if (onProgress) onProgress({ percent: 0, doneMB: 0, totalMB: estTotalMB, phase: 'start' });

                // 轮询目标目录大小算进度
                var tick = setInterval(function () {
                    var mb = 0;
                    try {
                        (function walk(d, depth) {
                            if (depth > 4) return;
                            var list = fs.readdirSync(d, { withFileTypes: true });
                            for (var i = 0; i < list.length; i++) {
                                var f = list[i];
                                var fp = path.join(d, f.name);
                                if (f.isDirectory()) walk(fp, depth + 1);
                                else {
                                    try { mb += fs.statSync(fp).size / 1024 / 1024; } catch (e) {}
                                }
                            }
                        })(targetDir, 0);
                    } catch (e) {}
                    if (onProgress) {
                        var pct = estTotalMB > 0 ? Math.min(99, mb / estTotalMB * 100) : 0;
                        onProgress({ percent: pct, doneMB: mb, totalMB: estTotalMB, phase: 'extract' });
                    }
                }, 900);

                var errBuf = '';
                if (cp.stderr) {
                    cp.stderr.on('data', function (d) { errBuf += String(d); });
                }

                cp.on('error', function (e) {
                    clearInterval(tick);
                    reject(new Error('解压启动失败: ' + e.message));
                });

                cp.on('close', function (code) {
                    clearInterval(tick);
                    if (code !== 0) {
                        reject(new Error('解压失败（code=' + code + '）: ' + errBuf.slice(0, 300)));
                        return;
                    }
                    var sec = (Date.now() - started) / 1000;
                    if (onProgress) onProgress({ percent: 100, phase: 'done', sec: sec });
                    resolve({ sec: sec, dir: targetDir });
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    // 解压后确认关键文件在位
    function verifyInstalled(rootDir) {
        var res = { ok: false, missing: [], found: [] };
        REQUIRED_FILES.forEach(function (rf) {
            var p = path.join(rootDir, rf.p.replace(/\//g, path.sep));
            var ok = false;
            try {
                if (fs.existsSync(p) && fs.statSync(p).size / 1024 / 1024 >= rf.minMB) ok = true;
            } catch (e) {}
            if (ok) res.found.push(rf.p);
            else res.missing.push(rf.p);
        });
        // 目录也要在
        REQUIRED_DIRS.forEach(function (d) {
            var p = path.join(rootDir, d);
            if (!fs.existsSync(p)) res.missing.push(d + '/');
        });
        res.ok = res.missing.length === 0;
        return res;
    }

    window.__vhCosyImport = {
        downloadDirs: downloadDirs,
        scan: scan,
        listZip: listZip,
        validate: validate,
        freeSpaceMB: freeSpaceMB,
        extract: extract,
        verifyInstalled: verifyInstalled
    };
})();
