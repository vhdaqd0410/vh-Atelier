// vh-Atelier 系列插件 · 在线更新模块 v2
// 能力：版本检查 / 自动检查 / 美化弹窗 / 更新说明展示 / 选择性覆盖
// 原理：GitHub 公共仓库对应分支打包下载 → 解压 → 覆盖代码（跳过模型/引擎/用户数据）
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
    var LAST_CHECK_KEY = 'vh_update_last_check';

    // 不参与更新的目录（大文件 + 用户数据）
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

    // ============ 样式（统一注入一次）============
    var STYLE_ID = 'vh-update-style';
    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent = [
            '.vhu-mask{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;}',
            '.vhu-card{background:linear-gradient(180deg,#252526,#1e1e1e);border:1px solid #3f3f46;border-radius:10px;width:440px;max-width:100%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;font-family:"Segoe UI","Microsoft YaHei",sans-serif;}',
            '.vhu-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #333;}',
            '.vhu-ico{width:26px;height:26px;border-radius:6px;background:rgba(139,92,246,.18);color:#a78bfa;display:flex;align-items:center;justify-content:center;font-size:14px;flex:0 0 auto;}',
            '.vhu-title{font-size:13.5px;font-weight:600;color:#eaeaea;flex:1 1 auto;}',
            '.vhu-x{background:transparent;border:none;color:#888;font-size:15px;cursor:pointer;padding:2px 5px;border-radius:4px;}',
            '.vhu-x:hover{color:#fff;background:#3a3a3a;}',
            '.vhu-body{padding:14px 16px;overflow-y:auto;font-size:12.5px;color:#cfcfcf;line-height:1.75;}',
            '.vhu-ver{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;}',
            '.vhu-badge{font-size:11px;padding:2px 8px;border-radius:4px;font-family:Consolas,monospace;}',
            '.vhu-old{background:#3a3a3a;color:#9a9a9a;}',
            '.vhu-new{background:rgba(127,214,139,.16);color:#7fd68b;border:1px solid rgba(127,214,139,.35);}',
            '.vhu-arrow{color:#666;}',
            '.vhu-sec{font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:.6px;margin:12px 0 6px;}',
            '.vhu-log{background:#141414;border:1px solid #333;border-radius:6px;padding:8px 10px;font-family:Consolas,monospace;font-size:11px;color:#9fe0a8;max-height:170px;overflow-y:auto;white-space:pre-wrap;}',
            '.vhu-note{font-size:11.5px;color:#a8a8a8;background:rgba(255,184,77,.07);border:1px solid rgba(255,184,77,.22);border-radius:6px;padding:8px 10px;line-height:1.7;}',
            '.vhu-bar{height:6px;background:#111;border-radius:3px;overflow:hidden;margin:10px 0 4px;}',
            '.vhu-fill{height:100%;width:0;background:linear-gradient(90deg,#8b5cf6,#a78bfa);border-radius:3px;transition:width .25s;}',
            '.vhu-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid #333;background:#1a1a1a;}',
            '.vhu-btn{border:none;border-radius:6px;padding:7px 18px;font-size:12.5px;cursor:pointer;font-family:inherit;}',
            '.vhu-btn.pri{background:linear-gradient(135deg,#8b5cf6,#9c6ee0);color:#fff;font-weight:600;}',
            '.vhu-btn.pri:hover{filter:brightness(1.12);}',
            '.vhu-btn.pri:disabled{filter:grayscale(.6);cursor:not-allowed;}',
            '.vhu-btn.sec{background:#3a3a3a;color:#c8c8c8;}',
            '.vhu-btn.sec:hover{background:#464646;}',
            '.vhu-files{font-family:Consolas,monospace;font-size:11px;color:#8a8a8a;}'
        ].join('');
        document.head.appendChild(st);
    }

    // ============ 弹窗组件 ============
    function modal(cfg) {
        injectStyle();
        var mask = document.createElement('div');
        mask.className = 'vhu-mask';
        var card = document.createElement('div');
        card.className = 'vhu-card';
        card.innerHTML =
            '<div class="vhu-head">' +
              '<div class="vhu-ico">⬆</div>' +
              '<div class="vhu-title"></div>' +
              '<button class="vhu-x" title="关闭">✕</button>' +
            '</div>' +
            '<div class="vhu-body"></div>' +
            '<div class="vhu-foot"></div>';
        card.querySelector('.vhu-title').textContent = cfg.title || '在线更新';
        var body = card.querySelector('.vhu-body');
        var foot = card.querySelector('.vhu-foot');
        mask.appendChild(card);
        document.body.appendChild(mask);

        function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
        card.querySelector('.vhu-x').addEventListener('click', close);
        mask.addEventListener('click', function (e) { if (e.target === mask && !cfg.locked) close(); });

        var api = {
            el: body,
            close: close,
            addBtn: function (text, primary, onClick) {
                var b = document.createElement('button');
                b.className = 'vhu-btn ' + (primary ? 'pri' : 'sec');
                b.textContent = text;
                b.addEventListener('click', onClick);
                foot.appendChild(b);
                return b;
            },
            clearBtns: function () { foot.innerHTML = ''; }
        };
        cfg.onReady && cfg.onReady(api);
        return api;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
        });
    }

    // 把更新说明（可能是 markdown 列表）渲染成 HTML
    function renderNotes(notes) {
        if (!notes) return '<div class="vhu-note">本次更新无详细说明。</div>';
        var txt = String(notes).trim();
        var lines = txt.split(/\r?\n/).filter(function (l) { return l.trim(); });
        var html = '<div class="vhu-log">';
        lines.forEach(function (l) {
            l = l.replace(/^[-*+]\s+/, '• ').replace(/^\d+\.\s+/, function (m) { return m; });
            html += esc(l) + '\n';
        });
        html += '</div>';
        return html;
    }

    // ============ 版本检查 ============
    // 一次 HTTP GET 拿 JSON（超时可调：检测要短、下载要长）
    function fetchJsonOnce(url, timeout, cb) {
        var xhr = new XMLHttpRequest();
        var done = false;
        function fin(err, j) { if (done) return; done = true; cb(err, j); }
        try {
            xhr.open('GET', url, true);
            xhr.timeout = timeout || 8000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status !== 200) { fin(new Error('HTTP ' + xhr.status)); return; }
                var j = null;
                try { j = JSON.parse(xhr.responseText); } catch (e) { fin(new Error('解析失败')); return; }
                fin(null, j);
            };
            xhr.onerror = function () { fin(new Error('网络错误')); };
            xhr.ontimeout = function () { fin(new Error('请求超时')); };
            xhr.send();
        } catch (e) { fin(new Error('请求异常：' + e.message)); }
    }

    // 记住上次成功的线路：raw.githubusercontent.com 在国内常被墙，
    // 而 api.github.com 通常可直连，避免每次都先撞一遍墙。
    var LAST_GOOD_KEY = 'vh_update_last_route';
    function lastGoodRoute() {
        try { return localStorage.getItem(LAST_GOOD_KEY) || ''; } catch (e) { return ''; }
    }
    function setLastGoodRoute(r) {
        try { localStorage.setItem(LAST_GOOD_KEY, r || ''); } catch (e) {}
    }

    function decodeB64Utf8(b64) {
        try {
            var clean = String(b64 || '').replace(/\s/g, '');
            if (typeof atob === 'function') return decodeURIComponent(escape(atob(clean)));
        } catch (e) {}
        return '';
    }

    // 读远端 version.json：api / raw 两条线路依次尝试，错误信息全部收集
    function fetchRemoteVersion(cfg, cb) {
        var stamp = Date.now();
        var raw = 'https://raw.githubusercontent.com/' + cfg.repo + '/' + cfg.branch +
                  '/version.json?_=' + stamp;
        var api = 'https://api.github.com/repos/' + cfg.repo + '/contents/version.json?ref=' +
                  encodeURIComponent(cfg.branch) + '&_=' + stamp;

        var routes = [
            {
                id: 'api', label: 'api.github.com',
                fn: function (next) {
                    fetchJsonOnce(api, 8000, function (e, j) {
                        if (e) return next(e);
                        var txt = decodeB64Utf8(j && j.content);
                        if (!txt) return next(new Error('返回内容为空'));
                        try {
                            var jr = JSON.parse(txt);
                            if (jr && jr.version) return next(null, jr);
                            next(new Error('缺少 version 字段'));
                        } catch (err) { next(new Error('解析失败')); }
                    });
                }
            },
            {
                id: 'raw', label: 'raw.githubusercontent.com',
                fn: function (next) {
                    fetchJsonOnce(raw, 8000, function (e, j) {
                        if (e) return next(e);
                        if (j && j.version) return next(null, j);
                        next(new Error('返回内容无 version'));
                    });
                }
            }
        ];

        if (lastGoodRoute() === 'raw') routes.reverse();

        var errs = [], i = 0;
        function tryNext() {
            if (i >= routes.length) return cb(new Error('无法读取远程版本（' + errs.join('；') + '）'));
            var r = routes[i++];
            r.fn(function (err, j) {
                if (!err && j) { setLastGoodRoute(r.id); return cb(null, j, r.id); }
                errs.push(r.label + ' → ' + (err ? err.message : '无数据'));
                tryNext();
            });
        }
        tryNext();
    }

    function checkUpdate(cb) {
        var cfg = readCfg();
        if (!cfg || !cfg.repo || !cfg.branch) { cb(new Error('未配置更新源（缺 version.json）')); return; }
        fetchRemoteVersion(cfg, function (err, remote, src) {
            if (err) { cb(err); return; }
            try { localStorage.setItem(LAST_CHECK_KEY, String(Date.now())); } catch (e) {}
            cb(null, {
                local: cfg,
                remote: remote,
                src: src || 'api',
                hasUpdate: String(remote.version || '') !== String(cfg.version || ''),
                remoteTime: remote.buildTime || '',
                notes: remote.notes || ''
            });
        });
    }

    // ============ 执行更新 ============
    function doUpdate(onLog, onProgress, cb) {
        var cfg = readCfg();
        if (!cfg) { cb(new Error('未配置更新源')); return; }
        var log = onLog || function () {};
        var zipUrl = 'https://codeload.github.com/' + cfg.repo + '/zip/refs/heads/' + cfg.branch;
        var zipFile = path.join(os.tmpdir(), 'vh_update_' + Date.now() + '.zip');

        (async function () {
            try {
                log('正在下载更新包…');
                await download(zipUrl, zipFile, function (pct) {
                    if (onProgress) onProgress(pct);
                });
                log('下载完成，正在解压…');
                var outDir = TMP + '_' + Date.now();
                if (fs.existsSync(outDir)) rmrf(outDir);
                fs.mkdirSync(outDir, { recursive: true });
                await unzip(zipFile, outDir);
                var tops = fs.readdirSync(outDir).filter(function (f) {
                    return fs.statSync(path.join(outDir, f)).isDirectory();
                });
                if (!tops.length) throw new Error('解压结果为空');
                var srcRoot = path.join(outDir, tops[0]);
                log('正在覆盖代码文件（跳过模型/引擎/用户数据）…');
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

    function copyTree(src, dst) {
        var n = 0;
        var items = fs.readdirSync(src);
        items.forEach(function (name) {
            if (SKIP.indexOf(name) >= 0) return;
            var s = path.join(src, name);
            var st = fs.statSync(s);
            if (st.isDirectory()) {
                var d = path.join(dst, name);
                try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
                n += copyTree(s, d);
            } else {
                if (name === '.gitignore') return;
                try { fs.copyFileSync(s, path.join(dst, name)); n++; } catch (e) {}
            }
        });
        return n;
    }

    function rmrf(p) {
        try {
            if (!fs.existsSync(p)) return;
            if (fs.statSync(p).isDirectory()) {
                fs.readdirSync(p).forEach(function (f) { rmrf(path.join(p, f)); });
                fs.rmdirSync(p);
            } else { fs.unlinkSync(p); }
        } catch (e) {}
    }

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

    // ============ 主流程（面板按钮调用）============
    function showUpdateUI(silent) {
        var m = modal({
            title: '在线更新',
            locked: false,
            onReady: function (api) {
                api.el.innerHTML = '<div class="vhu-files">正在检查更新…</div>';
                checkUpdate(function (err, r) {
                    if (err) {
                        api.el.innerHTML = '<div class="vhu-note">检查更新失败：' + esc(err.message) +
                            '<br><br>提示：需要能访问 GitHub。若使用代理，请确认 CEP 能走代理。</div>';
                        api.addBtn('关闭', true, api.close);
                        return;
                    }
                    var cur = r.local.version || '?';
                    if (!r.hasUpdate) {
                        api.el.innerHTML =
                            '<div class="vhu-ver"><span class="vhu-badge vhu-new">已是最新</span>' +
                            '<span class="vhu-files">v' + esc(cur) + '</span></div>' +
                            '<div class="vhu-note">当前已是最新版本，无需更新。</div>';
                        api.addBtn('关闭', true, api.close);
                        return;
                    }
                    // 有更新：展示版本 + 更新说明
                    api.el.innerHTML =
                        '<div class="vhu-ver">' +
                          '<span class="vhu-badge vhu-old">当前 v' + esc(cur) + '</span>' +
                          '<span class="vhu-arrow">→</span>' +
                          '<span class="vhu-badge vhu-new">最新 v' + esc(r.remote.version || '?') + '</span>' +
                        '</div>' +
                        '<div class="vhu-sec">本次更新内容</div>' +
                        renderNotes(r.notes) +
                        (r.remoteTime ? '<div class="vhu-sec">发布时间</div><div class="vhu-files">' + esc(r.remoteTime) + '</div>' : '') +
                        '<div class="vhu-note" style="margin-top:12px;">更新只同步代码（几百 KB），不动模型、引擎与你的数据。<br>更新后请关闭并重开面板；若涉及 JSX，需重启 Premiere Pro。</div>';
                    var btnDo = api.addBtn('立即更新', true, function () {
                        btnDo.disabled = true;
                        btnDo.textContent = '更新中…';
                        var logBox = document.createElement('div');
                        logBox.className = 'vhu-log';
                        logBox.style.marginTop = '12px';
                        logBox.textContent = '';
                        api.el.appendChild(logBox);
                        var bar = document.createElement('div');
                        bar.className = 'vhu-bar';
                        bar.innerHTML = '<div class="vhu-fill"></div>';
                        api.el.appendChild(bar);
                        var fill = bar.querySelector('.vhu-fill');
                        doUpdate(function (msg) {
                            logBox.textContent += msg + '\n';
                            logBox.scrollTop = logBox.scrollHeight;
                        }, function (pct) {
                            fill.style.width = pct + '%';
                        }, function (e2, rr) {
                            api.clearBtns();
                            if (e2) {
                                logBox.textContent += '\n✗ 更新失败：' + e2.message + '\n';
                                api.addBtn('关闭', true, api.close);
                                return;
                            }
                            logBox.textContent += '\n✅ 更新完成，共 ' + rr.files + ' 个文件。\n';
                            api.el.insertAdjacentHTML('afterbegin',
                                '<div class="vhu-ver"><span class="vhu-badge vhu-new">更新完成</span>' +
                                '<span class="vhu-files">共 ' + rr.files + ' 个文件</span></div>');
                            api.addBtn('重开面板', true, function () {
                                // 尝试重载面板页面
                                try { location.reload(); } catch (e) {}
                                api.close();
                            });
                            api.addBtn('稍后', false, api.close);
                        });
                    });
                    api.addBtn('稍后', false, api.close);
                });
            }
        });
        return m;
    }

    // 自动检查（每次打开面板检查一次；有新版本弹窗，失败留痕但不打扰）
    // 注意：不能用 sessionStorage 当「本次会话只查一次」的锁——
    // CEP 面板里 sessionStorage 会跨会话保留，第一次查过之后就永远不再查了，
    // 表现就是"自动更新不生效"。用内存标记即可。
    var autoChecked = false;
    var lastAutoResult = null;

    function autoCheck() {
        var cfg = readCfg();
        if (!cfg) return;
        if (autoChecked) return;
        autoChecked = true;
        setTimeout(function () {
            checkUpdate(function (err, r) {
                if (err) {
                    lastAutoResult = { ok: false, at: Date.now(), error: err.message };
                    markUpdateState('error', err.message);
                    try {
                        if (window.__vhLog && window.__vhLog.warn) {
                            window.__vhLog.warn('自动检查更新失败：' + err.message);
                        }
                    } catch (e) {}
                    return;
                }
                lastAutoResult = { ok: true, at: Date.now(), hasUpdate: !!r.hasUpdate,
                                   local: (r.local || {}).version, remote: (r.remote || {}).version };
                if (r.hasUpdate) {
                    markUpdateState('has-update', '新版本 v' + ((r.remote || {}).version || ''));
                    showUpdateUI(true);
                } else {
                    markUpdateState('latest', '已是最新 v' + ((r.local || {}).version || ''));
                }
            });
        }, 2500);
    }

    // 在「⬆ 更新」按钮上给出可见状态，让用户一眼知道检测结果
    function markUpdateState(state, tip) {
        try {
            var btn = document.getElementById('btnUpdate');
            if (!btn) return;
            btn.setAttribute('data-update-state', state);
            var dotId = 'vhUpdateDot';
            var old = document.getElementById(dotId);
            if (old && old.parentNode) old.parentNode.removeChild(old);
            if (state === 'has-update') {
                btn.style.color = '#7fd68b';
                var dot = document.createElement('span');
                dot.id = dotId;
                dot.style.cssText = 'display:inline-block;width:6px;height:6px;border-radius:50%;' +
                    'background:#7fd68b;margin-left:4px;vertical-align:middle;';
                btn.appendChild(dot);
            } else if (state === 'error') {
                btn.style.color = '#fca5a5';
            } else {
                btn.style.color = '';
            }
            btn.title = tip ? ('在线更新 · ' + tip) : '在线更新';
        } catch (e) {}
    }

    window.__vhUpdate = {
        check: checkUpdate,
        run: doUpdate,
        show: showUpdateUI,
        autoCheck: autoCheck,
        lastResult: function () { return lastAutoResult; },
        version: function () { var c = readCfg(); return c ? c.version : ''; },
        info: function () { return readCfg(); }
    };
})();
