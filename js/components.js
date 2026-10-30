// vh-Atelier 客户版 · 组件下载与检测
// 用途：客户版不预装大模型/引擎，首次用到某功能时检查并按需下载。
// 双通道：
//   A. 在线下载（自动，进度可见）
//   B. 百度网盘（下载慢或在线失败时，提示用户手动下载后放到指定目录）
(function () {
    'use strict';

    var fs, path, os2, https, http, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        os2 = require('os');
        https = require('https');
        http = require('http');
        childProcess = require('child_process');
    } catch (e) {
        window.__vhComponents = { list: [], check: function () { return {}; } };
        return;
    }

    var extRoot = '';
    try {
        var cs = new CSInterface();
        extRoot = cs.getSystemPath(SystemPath.EXTENSION);
    } catch (e) {}

    // ── 组件清单 ────────────────────────────────────────────
    // check: 判断是否已就位（返回 true/false）
    // size: 展示用体积
    // url: 在线下载地址（GitHub Release 直链）
    // netdisk: 百度网盘分享链接
    // unzip: 下载后是否需要解压（true=zip，false=单文件）
    var COMPONENTS = [
        {
            id: 'funasr',
            name: '字幕识别模型',
            desc: '本地字幕识别（Paraformer + 标点 + VAD）',
            size: '1.24 GB',
            dir: 'models/funasr',
            check: function () {
                var p = path.join(extRoot, 'models', 'funasr');
                if (!fs.existsSync(p)) return false;
                // 关键文件：大模型权重
                var found = false;
                try {
                    var stack = [p];
                    var guard = 0;
                    while (stack.length && guard++ < 500) {
                        var d = stack.shift();
                        var list = fs.readdirSync(d, { withFileTypes: true });
                        for (var i = 0; i < list.length; i++) {
                            var f = list[i];
                            var full = path.join(d, f.name);
                            if (f.isDirectory()) stack.push(full);
                            else if (/\.pt$/i.test(f.name) && fs.statSync(full).size > 500 * 1024 * 1024) {
                                found = true;
                                break;
                            }
                        }
                        if (found) break;
                    }
                } catch (e) {}
                return found;
            },
            url: '',
            netdisk: '',
            unzip: true
        },
        {
            id: 'breeze',
            name: 'Breeze 语音合成',
            desc: '本地 GGUF 语音引擎 + 模型',
            size: '2.46 GB',
            dir: 'breeze',
            check: function () {
                var exe = path.join(extRoot, 'breeze', 'engine', 'breeze-cli.exe');
                var mdl = path.join(extRoot, 'breeze', 'models', 'breeze-tts-2-q4_k-dd2.gguf');
                try {
                    return fs.existsSync(exe) && fs.existsSync(mdl) &&
                           fs.statSync(mdl).size > 1500 * 1024 * 1024;
                } catch (e) { return false; }
            },
            url: '',
            netdisk: '',
            unzip: true
        },
        {
            // whisper 是朗读/克隆的「自动识别参考音频文字」和字幕识别都要用的引擎。
            // 之前打包时漏了，只有装了别的字幕插件才能借到，所以单独列出来让用户下载。
            id: 'whisper',
            name: 'Whisper 语音识别',
            desc: '朗读与克隆的自动识别、字幕识别都要用',
            size: '约 1.9 GB',
            dir: 'bin/whisper',
            check: function () {
                // CPU 版必需；CUDA 版可选（有则优先用）
                var cpu = path.join(extRoot, 'bin', 'whisper', 'win32-x64', 'whisper-cli.exe');
                if (!fs.existsSync(cpu)) return false;
                // 模型也要在
                var m1 = path.join(extRoot, 'models', 'ggml-belle-large-v3-turbo-zh-q8_0.bin');
                var m2 = path.join(extRoot, 'models', 'ggml-large-v3-q5_0.bin');
                return fs.existsSync(m1) || fs.existsSync(m2);
            },
            url: '',          // 没有在线下载源，只走网盘
            netdisk: '（待填：whisper 组件包网盘链接）',
            unzip: true,
            // 网盘包解压后的结构说明，展示给用户
            layout: {
                'bin/whisper/win32-x64/': 'CPU 引擎（必需，51 MB）',
                'bin/whisper/cuda/': 'GPU 加速引擎（可选，1.1 GB）',
                'models/ggml-belle-large-v3-turbo-zh-q8_0.bin': '中文模型（必需，834 MB）',
                'models/ggml-large-v3-q5_0.bin': '通用模型（可选，1 GB）'
            }
        },
        {
            id: 'ncm',
            name: '网易云服务',
            desc: '网易云音乐搜索/试听/下载的本地服务',
            size: '27 MB',
            dir: 'ncm',
            check: function () {
                return fs.existsSync(path.join(extRoot, 'ncm', 'index.js'));
            },
            url: '',
            netdisk: '',
            unzip: true
        }
    ];

    // ── 检测 ────────────────────────────────────────────────
    function checkAll() {
        var out = {};
        COMPONENTS.forEach(function (c) {
            var ok = false;
            try { ok = c.check(); } catch (e) { ok = false; }
            out[c.id] = { ready: ok, meta: c };
        });
        return out;
    }

    function missingList() {
        var r = checkAll();
        return COMPONENTS.filter(function (c) { return !r[c.id].ready; });
    }

    // ── 下载 ────────────────────────────────────────────────
    var dlState = {};   // id -> { active, done, total, percent, speed, err }

    function download(c, onProgress, onDone) {
        if (dlState[c.id] && dlState[c.id].active) return;
        dlState[c.id] = { active: true, done: 0, total: 0, percent: 0, speed: 0 };

        var tmpZip = path.join(os2.tmpdir(), 'vh_' + c.id + '_' + Date.now() + '.zip');

        function step(url, redirects) {
            redirects = redirects || 0;
            if (redirects > 6) {
                dlState[c.id].active = false;
                dlState[c.id].err = '重定向过多';
                onDone && onDone(new Error('重定向过多'));
                return;
            }
            var mod = /^https:/i.test(url) ? https : http;
            var req = mod.get(url, {
                headers: { 'User-Agent': 'vh-Atelier-Updater' },
                timeout: 30000
            }, function (res) {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return step(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    dlState[c.id].active = false;
                    dlState[c.id].err = 'HTTP ' + res.statusCode;
                    onDone && onDone(new Error('HTTP ' + res.statusCode));
                    return;
                }

                var total = parseInt(res.headers['content-length'] || '0', 10);
                var done = 0;
                var t0 = Date.now();
                var out = fs.createWriteStream(tmpZip);

                res.on('data', function (chunk) {
                    done += chunk.length;
                    dlState[c.id].done = done;
                    dlState[c.id].total = total;
                    dlState[c.id].percent = total > 0 ? (done / total * 100) : 0;
                    var el = (Date.now() - t0) / 1000;
                    dlState[c.id].speed = el > 0 ? (done / 1024 / 1024 / el) : 0;
                    onProgress && onProgress(dlState[c.id]);
                });
                res.pipe(out);
                out.on('finish', function () {
                    out.close(function () {
                        dlState[c.id].active = false;
                        dlState[c.id].percent = 100;
                        try {
                            extractAndPlace(c, tmpZip);
                            onDone && onDone(null);
                        } catch (e) {
                            onDone && onDone(e);
                        }
                    });
                });
            });
            req.on('error', function (e) {
                dlState[c.id].active = false;
                dlState[c.id].err = e.message;
                onDone && onDone(e);
            });
            req.on('timeout', function () {
                try { req.destroy(); } catch (e) {}
                dlState[c.id].active = false;
                dlState[c.id].err = '超时';
                onDone && onDone(new Error('超时'));
            });
        }
        step(c.url);
    }

    // 解压并放到目标目录
    function extractAndPlace(c, zipPath) {
        var target = path.join(extRoot, c.dir.replace(/\//g, path.sep));

        // 用一个临时解压目录，避免直接覆盖
        var tmpDir = path.join(os2.tmpdir(), 'vh_extract_' + c.id + '_' + Date.now());
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}

        // 用 PowerShell 的 Expand-Archive（Windows 自带，无需 7z）
        var psCmd = 'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + tmpDir + '" -Force';
        var r = childProcess.spawnSync('powershell', ['-NoProfile', '-Command', psCmd],
                                       { windowsHide: true, timeout: 600000, encoding: 'utf8' });
        if (r.status !== 0) {
            throw new Error('解压失败: ' + String(r.stderr || '').slice(0, 200));
        }

        // 拷贝到目标
        copyTree(tmpDir, target);

        // 清理
        try { fs.unlinkSync(zipPath); } catch (e) {}
        try { rmTree(tmpDir); } catch (e) {}
    }

    function copyTree(src, dst) {
        try { fs.mkdirSync(dst, { recursive: true }); } catch (e) {}
        var list = fs.readdirSync(src, { withFileTypes: true });
        list.forEach(function (f) {
            var s = path.join(src, f.name);
            var d = path.join(dst, f.name);
            if (f.isDirectory()) copyTree(s, d);
            else {
                try { fs.copyFileSync(s, d); } catch (e) {}
            }
        });
    }

    function rmTree(p) {
        try {
            var list = fs.readdirSync(p, { withFileTypes: true });
            list.forEach(function (f) {
                var full = path.join(p, f.name);
                if (f.isDirectory()) rmTree(full);
                else { try { fs.unlinkSync(full); } catch (e) {} }
            });
            fs.rmdirSync(p);
        } catch (e) {}
    }

    // ── 网盘说明弹窗 ────────────────────────────────────────
    function showNetdiskHelp(c) {
        var target = path.join(extRoot, c.dir.replace(/\//g, path.sep));
        var msg = '【' + c.name + '】\n\n';
        msg += '1. 打开网盘链接下载：\n' + (c.netdisk || '（暂未提供）') + '\n\n';
        msg += '2. 解压后，把里面的文件夹放进插件目录：\n' + extRoot + '\n\n';

        // 有结构说明就逐个列清楚
        if (c.layout) {
            msg += '3. 放好之后应该是这样：\n';
            Object.keys(c.layout).forEach(function (k) {
                var line = (k.slice(-1) === '/') ? '   ' + k : '   ' + k;
                msg += line + '\n      ' + c.layout[k] + '\n';
            });
            msg += '\n';
        } else {
            msg += '   目标位置：\n' + target + '\n\n';
        }

        msg += '4. 回到插件点「重新检测」\n\n';
        msg += '需要下载的内容：' + c.desc;
        if (c.size) msg += '（' + c.size + '）';

        try {
            window.__vhAlert ? window.__vhAlert(msg) : alert(msg);
        } catch (e) { alert(msg); }
    }

    window.__vhComponents = {
        list: COMPONENTS,
        checkAll: checkAll,
        missing: missingList,
        download: download,
        state: dlState,
        netdiskHelp: showNetdiskHelp
    };
})();
