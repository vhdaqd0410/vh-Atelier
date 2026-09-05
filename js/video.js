// vh-Atelier 板块：视频下载（抖音/B站/YouTube/小红书等，yt-dlp 引擎）
// 架构：插件壳（本文件） + 本地 Node 服务（video/index.js，调 bin/yt-dlp.exe）
// 能力：粘贴链接解析 / 选画质下载 / 批量下载 / 打开下载目录 / cookie 粘贴 / 一键导入 PR「视频」素材箱
// 说明：服务由本面板自举（探测端口探活，没跑则 spawn node），与 music 板块同构。
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    var API = 'http://127.0.0.1:17892';
    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var videoDir = path.join(extRoot, 'collect', 'video');
    var videoSvcDir = path.join(extRoot, 'video');
    var videoSvcIndex = path.join(videoSvcDir, 'index.js');
    var videoChild = null;

    var parsedInfo = null;    // 解析结果
    var lastOutPath = '';     // 最近下载完成的文件路径
    var batching = false;     // 批量下载进行中标志
    var importing = false;    // 下载并导入进行中标志

    var HIST_KEY = 'pr_me_video_history_v1';
    var HIST_MAX = 10;

    function $(id) { return document.getElementById(id); }

    function setStatus(msg, type) {
        var s = $('vStatus');
        if (!s) return;
        s.textContent = msg || '';
        s.className = 'v-status ' + (type || '');
    }

    function setMeta(msg) {
        var m = $('vProgressMeta');
        if (!m) return;
        if (!msg) { m.style.display = 'none'; return; }
        m.style.display = 'block';
        m.textContent = msg;
    }

    function addLog(msg, type) {
        var box = $('vLog');
        if (!box) return;
        var line = document.createElement('div');
        line.className = 'l ' + (type || '');
        line.textContent = msg;
        box.appendChild(line);
        box.scrollTop = box.scrollHeight;
    }

    // ---------- fetch 封装 ----------
    function api(pathname) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', API + pathname, true);
            xhr.timeout = 8000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    try { resolve(JSON.parse(xhr.responseText)); }
                    catch (e) { reject(new Error('响应解析失败')); }
                }
            };
            xhr.onerror = function () { reject(new Error('无法连接本地服务')); };
            xhr.ontimeout = function () { reject(new Error('请求超时')); };
            xhr.send();
        });
    }

    function apiPost(pathname, body) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', API + pathname, true);
            xhr.timeout = 8000;
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    try { resolve(JSON.parse(xhr.responseText)); }
                    catch (e) { reject(new Error('响应解析失败')); }
                }
            };
            xhr.onerror = function () { reject(new Error('无法连接本地服务')); };
            xhr.ontimeout = function () { reject(new Error('请求超时')); };
            xhr.send(JSON.stringify(body || {}));
        });
    }

    function enc(v) { return encodeURIComponent(v); }

    // ---------- 历史记录（localStorage 持久化，最近 10 条） ----------
    function loadHistory() {
        try {
            var raw = window.localStorage.getItem(HIST_KEY);
            if (!raw) return [];
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr.filter(function (it) { return it && it.path; });
        } catch (e) { return []; }
    }

    function saveHistory(list) {
        try {
            window.localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX)));
        } catch (e) {}
    }

    function addHistory(title, filePath) {
        if (!filePath) return;
        var list = loadHistory();
        // 去重：同路径移到最前
        list = list.filter(function (it) { return it.path !== filePath; });
        list.unshift({ path: filePath, title: title || path.basename(filePath), time: Date.now() });
        list = list.slice(0, HIST_MAX);
        saveHistory(list);
        renderHistory();
    }

    function clearHistory() {
        saveHistory([]);
        renderHistory();
        setStatus('历史记录已清空', 'ok');
    }

    function renderHistory() {
        var wrap = $('vHistoryWrap');
        var box = $('vHistoryList');
        if (!wrap || !box) return;
        var list = loadHistory();
        box.innerHTML = '';
        if (!list.length) {
            wrap.className = 'v-history';
            return;
        }
        wrap.className = 'v-history show';
        list.forEach(function (it) {
            var row = document.createElement('div');
            row.className = 'v-hist-item';

            var nm = document.createElement('span');
            nm.className = 'nm';
            nm.title = it.path;
            nm.textContent = it.title || path.basename(it.path);
            nm.addEventListener('click', function () { importPathToPR(it.path); });

            var btn = document.createElement('button');
            btn.className = 'imp';
            btn.textContent = '导入';
            btn.addEventListener('click', function () { importPathToPR(it.path); });

            row.appendChild(nm);
            row.appendChild(btn);
            box.appendChild(row);
        });
    }

    // 从一段文本（抖音/B站/小红书等分享文案）里抠出真正的链接
    function extractUrl(raw) {
        var s = (raw || '').trim();
        if (!s) return '';
        if (/^https?:\/\//i.test(s)) {
            return s.replace(/[。，、！？；：,.!?;:）)>}\]】]+$/g, '');
        }
        var m = s.match(/https?:\/\/[^\s"'<>]+/i);
        if (!m) return '';
        var u = m[0];
        u = u.replace(/[。，、！？；：,.!?;:）)>}\]】]+$/g, '');
        return u;
    }

    // 从输入框整段文本提取所有链接（每行一个；整段无换行则全文扫）
    function extractLinks() {
        var box = $('vUrl');
        var raw = box.value || '';
        var links = [];
        var seen = {};
        function push(u) {
            if (u && /^https?:\/\//i.test(u) && !seen[u]) { seen[u] = 1; links.push(u); }
        }
        var lines = raw.split(/\r?\n/);
        var hit = false;
        lines.forEach(function (line) {
            var u = extractUrl(line);
            if (u) { push(u); hit = true; }
        });
        if (!hit) {
            var all = raw.match(/https?:\/\/[^\s"'<>]+/gi) || [];
            all.forEach(function (u) { push(u.replace(/[。，、！？；：,.!?;:）)>}\]】]+$/g, '')); });
        }
        return links;
    }

    // ---------- 服务自举 ----------
    function findNode() {
        var candidates = [
            'C:\\Program Files\\nodejs\\node.exe',
            'C:\\Program Files (x86)\\nodejs\\node.exe'
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (fs.existsSync(candidates[i])) return candidates[i];
        }
        try {
            var which = childProcess.spawnSync('where', ['node'], { encoding: 'utf8' });
            if (which.status === 0 && which.stdout) {
                var first = which.stdout.split('\n')[0].trim();
                if (first) return first;
            }
        } catch (e) {}
        return null;
    }

    function spawnSvc() {
        try {
            if (!fs.existsSync(videoSvcIndex)) {
                setStatus('本地服务文件缺失: ' + videoSvcIndex, 'err');
                return false;
            }
            var node = findNode();
            if (!node) {
                setStatus('未找到 node.exe，请安装 Node.js', 'err');
                return false;
            }
            if (videoChild) return true;
            videoChild = childProcess.spawn(node, [videoSvcIndex], { cwd: videoSvcDir, windowsHide: true });
            videoChild.on('error', function () { videoChild = null; });
            videoChild.on('close', function () { videoChild = null; });
            return true;
        } catch (e) {
            return false;
        }
    }

    function ensureServer(retries) {
        var tries = retries || 0;
        return api('/health').then(function (h) {
            return h;
        }).catch(function () {
            if (tries < 1) {
                spawnSvc();
                return new Promise(function (resolve) {
                    setTimeout(function () { resolve(ensureServer(tries + 1)); }, 2000);
                });
            }
            throw new Error('服务启动失败，请检查 Node.js 安装');
        });
    }

    // ---------- cookie 状态 ----------
    function refreshCookieBar() {
        api('/cookie').then(function (r) {
            var has = r && r.data && r.data.hasCookie;
            var mode = (r && r.data && r.data.mode) || 'none';
            $('vCookieDot').className = 'dot' + (has ? ' on' : '');
            var label = '未配置浏览器 Cookie（抖音 / B 站高清需登录态）';
            if (has) {
                label = mode === 'netscape'
                    ? ('已配置 Cookie-Editor 导出（Netscape 格式，' + r.data.len + ' 字符）')
                    : ('已配置 Cookie 头（' + r.data.len + ' 字符）');
            }
            $('vCookieTxt').textContent = label;
        }).catch(function () {});
    }

    function pasteCookie() {
        var hint = '请先按下面步骤导出抖音/B站的 Cookie：\n' +
            '1. 登录抖音（或B站）网页版\n' +
            '2. 点浏览器右上角 Cookie-Editor 图标\n' +
            '3. 底部 Export 按钮 → 选「Netscape」格式\n' +
            '4. 复制导出的全部内容\n\n' +
            '然后把内容粘贴到下面的输入框：\n\n' +
            '（内容只存本地 cookies.txt，喂给 yt-dlp 下载，不上传）';
        var cookie = window.prompt(hint, '');
        if (cookie === null) return;
        cookie = (cookie || '').trim();
        if (!cookie) {
            setStatus('未输入内容', 'err');
            return;
        }
        apiPost('/cookie', { cookie: cookie }).then(function (r) {
            if (r && r.code === 0) {
                var m = (r.data && r.data.mode) || 'header';
                var how = m === 'netscape' ? '（识别为 Netscape 格式，用 --cookies 喂入）' : '（识别为单串 Cookie 头，用 --add-header 喂入）';
                setStatus('Cookie 已保存', 'ok');
                addLog('Cookie 已配置 ' + how, 'ok');
                refreshCookieBar();
            } else {
                setStatus((r && r.msg) || '保存失败', 'err');
            }
        }).catch(function (e) { setStatus('保存失败: ' + e.message, 'err'); });
    }

    // ---------- 解析 ----------
    function doParse() {
        var links = extractLinks();
        if (!links.length) { setStatus('没有检测到有效链接', 'err'); return; }
        var link = links[0];
        var eng = forceGv ? 'gv' : 'auto';
        setStatus('解析中' + (eng === 'gv' ? '（免登录通道）' : '') + '...', '');
        addLog('解析: ' + link + (eng === 'gv' ? '（强制免登录通道）' : ''), '');
        hideResult();
        ensureServer().then(function () {
            return api('/parse?engine=' + eng + '&url=' + enc(link));
        }).then(function (r) {
            if (r && r.code === 0 && r.data) {
                parsedInfo = r.data;
                renderResult(r.data);
                var eng2 = r.data.engine || 'yt-dlp';
                var why = r.data._fallbackReason ? '（yt-dlp 失败已自动切换）' : '';
                setStatus('解析成功 [' + eng2 + ']' + why, 'ok');
                addLog('解析成功: ' + r.data.title + ' [' + eng2 + ']', 'ok');
            } else {
                var msg = (r && r.msg) || '解析失败';
                setStatus(friendlyErr(msg), 'err');
                addLog('解析失败: ' + msg, 'err');
            }
        }).catch(function (e) {
            setStatus('解析失败: ' + e.message, 'err');
            addLog('解析失败: ' + e.message, 'err');
        });
    }

    // 免登录通道开关：置位后解析/下载强制走 greenvideo（不依赖 cookie）
    var forceGv = false;
    function toggleGv() {
        forceGv = !forceGv;
        var b = $('btnVGv');
        if (!b) return;
        b.className = forceGv ? 'tbtn gv-on' : 'tbtn';
        b.title = forceGv ? '当前强制走免登录通道（greenvideo），点击恢复自动' : '当前自动模式（yt-dlp 优先，失败切免登录），点击强制走免登录';
        setStatus(forceGv ? '已切换到免登录通道（greenvideo）：不依赖 cookie，单档源' : '已恢复自动模式（yt-dlp 优先，失败自动降级免登录）', forceGv ? 'warn' : 'ok');
        addLog(forceGv ? '已强制免登录通道（greenvideo）' : '已恢复自动模式', forceGv ? 'warn' : '');
    }

    function hideResult() {
        var r = $('vResult');
        if (r) r.className = 'v-result';
        lastOutPath = '';
    }

    function renderResult(info) {
        var r = $('vResult');
        r.className = 'v-result show';
        $('vTitle').textContent = info.title || '(无标题)';
        var sub = [];
        if (info.uploader) sub.push(info.uploader);
        if (info.duration) sub.push(fmtDur(info.duration));
        $('vSub').textContent = sub.join(' · ') || info.webpageUrl || '';
        if (info.thumbnail) {
            $('vThumb').src = info.thumbnail;
            $('vThumb').onerror = function () { this.style.visibility = 'hidden'; };
        } else {
            $('vThumb').style.visibility = 'hidden';
        }

        // 画质下拉：合并视频格式（有高度）供选择
        var sel = $('vFormat');
        sel.innerHTML = '';
        var vids = (info.formats || []).filter(function (f) { return f.height > 0; });
        if (!vids.length) {
            var o1 = document.createElement('option');
            o1.value = 'best';
            o1.textContent = '默认最高画质';
            sel.appendChild(o1);
        } else {
            // 按高度降序
            vids.sort(function (a, b) { return b.height - a.height; });
            vids.forEach(function (f) {
                var o = document.createElement('option');
                o.value = f.formatId;
                o.textContent = f.height + 'P' + (f.note ? ' (' + f.note + ')' : '');
                sel.appendChild(o);
            });
            var o2 = document.createElement('option');
            o2.value = 'best';
            o2.textContent = '最高（自动合流）';
            sel.appendChild(o2);
            sel.value = 'best';
        }
    }

    function fmtDur(s) {
        s = Math.round(s || 0);
        var m = Math.floor(s / 60);
        var sec = s % 60;
        return m + ':' + (sec < 10 ? '0' : '') + sec;
    }

    // ---------- 友好错误提示：把 yt-dlp 的英文报错翻译成人话 ----------
    function friendlyErr(errText) {
        var s = (errText || '').toLowerCase();
        if (s.indexOf('fresh cookies') >= 0 || s.indexOf('cookies are needed') >= 0 || s.indexOf('cookie') >= 0) {
            return '需要登录态 Cookie：用 Cookie-Editor 导出抖音/B站的 Netscape cookie，点「粘贴 Cookie」更新';
        }
        if (s.indexOf('429') >= 0 || s.indexOf('rate limit') >= 0 || s.indexOf('too many requests') >= 0) {
            return '被平台限流（风控）：过几分钟再试，或更新 Cookie';
        }
        if (s.indexOf('sign in') >= 0 || s.indexOf('login') >= 0 || s.indexOf('log in') >= 0) {
            return '需要登录：请更新 Cookie 后再试';
        }
        if (s.indexOf('not a valid url') >= 0) {
            return '链接无效：请确认粘的是完整链接（https:// 开头）';
        }
        if (s.indexOf('unable to download') >= 0 && s.indexOf('video') >= 0) {
            return '平台拒绝下载，可能是地区限制或需要更高画质登录';
        }
        return errText;
    }

    // ---------- 下载（单条） ----------
    function doDownload() {
        if (!parsedInfo) { setStatus('请先解析链接', 'err'); return; }
        var links = extractLinks();
        if (!links.length) { setStatus('没有检测到有效链接', 'err'); return; }
        var link = links[0];
        var fmt = $('vFormat').value || 'best';
        runOne(link, fmt, false);
    }

    // 下载单条：提交 → 轮询 → 结束
    function runOne(link, fmt, silent) {
        // 引擎：手动强制免登录 > 解析结果本身是 greenvideo > yt-dlp
        var eng = forceGv ? 'gv' : ((parsedInfo && parsedInfo.engine === 'greenvideo') ? 'gv' : 'auto');
        var engQ = (eng === 'gv') ? '&engine=gv' : '';
        $('vProgress').className = 'v-progress show';
        $('vProgressFill').style.width = '0%';
        setMeta('提交下载...');
        if (!silent) { setStatus('提交下载...', ''); addLog('开始下载: ' + link, ''); }
        $('btnVDownload').disabled = true;

        return ensureServer().then(function () {
            return api('/download?url=' + enc(link) + '&quality=' + enc(fmt) + engQ);
        }).then(function (r) {
            if (r && r.code === 0 && r.data && r.data.id) {
                return pollTask(r.data.id, silent);
            }
            throw new Error((r && r.msg) || '提交下载失败');
        }).catch(function (e) {
            setMeta('');
            $('btnVDownload').disabled = false;
            $('vProgress').className = 'v-progress';
            if (!silent) {
                setStatus('下载失败: ' + friendlyErr(e.message), 'err');
                addLog('下载失败: ' + e.message, 'err');
            }
            return { ok: false, err: e.message };
        });
    }

    // 轮询任务直到结束，resolve 成 { ok, outPath, err }
    function pollTask(id, silent) {
        return new Promise(function (resolve) {
            var timer = setInterval(function () {
                api('/task?id=' + enc(id)).then(function (r) {
                    var t = r && r.data;
                    if (!t) return;
                    var pct = Math.round(t.progress || 0);
                    $('vProgressFill').style.width = pct + '%';
                    if (!silent) setStatus('下载中... ' + pct + '%', '');
                    if (t.status === 'done') {
                        clearInterval(timer);
                        lastOutPath = t.outPath;
                        setMeta('');
                        $('btnVDownload').disabled = false;
                        $('btnVImport').disabled = false;
                        $('vProgress').className = 'v-progress';
                        addHistory(t.title, t.outPath);
                        if (!silent) {
                            setStatus('下载完成: ' + path.basename(t.outPath), 'ok');
                            addLog('下载完成: ' + t.outPath, 'ok');
                        }
                        resolve({ ok: true, outPath: t.outPath });
                    } else if (t.status === 'error') {
                        clearInterval(timer);
                        setMeta('');
                        $('btnVDownload').disabled = false;
                        $('vProgress').className = 'v-progress';
                        var emsg = t.err || '未知错误';
                        if (!silent) {
                            setStatus('下载失败: ' + friendlyErr(emsg), 'err');
                            addLog('下载失败: ' + emsg, 'err');
                        }
                        resolve({ ok: false, err: emsg });
                    }
                }).catch(function () {});
            }, 1200);
        });
    }

    // ---------- 批量下载 ----------
    function doDownloadAll() {
        if (batching) { setStatus('批量下载进行中，请稍候', 'warn'); return; }
        var links = extractLinks();
        if (!links.length) { setStatus('没有检测到有效链接', 'err'); return; }
        var fmt = $('vFormat').value || 'best';
        batching = true;
        $('btnVDownloadAll').disabled = true;
        $('btnVDownload').disabled = true;
        addLog('检测到 ' + links.length + ' 个链接，开始批量下载', '');
        $('vProgress').className = 'v-progress show';
        $('vProgressFill').style.width = '0%';

        var idx = 0;
        var okCount = 0;
        var failCount = 0;

        function next() {
            if (idx >= links.length) {
                batching = false;
                $('btnVDownloadAll').disabled = false;
                $('btnVDownload').disabled = false;
                $('vProgress').className = 'v-progress';
                setMeta('');
                var summary = '批量下载完成：成功 ' + okCount + '，失败 ' + failCount;
                setStatus(summary, okCount > 0 ? 'ok' : 'err');
                addLog(summary, okCount > 0 ? 'ok' : 'err');
                return;
            }
            var link = links[idx];
            idx++;
            var cur = idx;
            setMeta('第 ' + cur + '/' + links.length + ' 个');
            addLog('[' + cur + '/' + links.length + '] ' + link, '');
            runOne(link, fmt, true).then(function (res) {
                if (res.ok) okCount++; else failCount++;
                next();
            });
        }
        next();
    }

    // ---------- 打开下载目录 ----------
    function openDir() {
        try {
            if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true });
            childProcess.exec('explorer.exe "' + videoDir + '"');
            setStatus('已打开下载目录', 'ok');
            addLog('下载目录: ' + videoDir, '');
        } catch (e) {
            setStatus('无法打开目录: ' + e.message, 'err');
        }
    }

    // ---------- 导入 PR（一键：无已下载文件则先自动下载再导入） ----------
    function importToPR() {
        if (importing) { setStatus('正在下载并导入，请稍候', 'warn'); return; }
        // 已经有下载好的文件，直接导入
        if (lastOutPath) { importPathToPR(lastOutPath); return; }
        // 否则自动下载再导入
        var links = extractLinks();
        if (!links.length) { setStatus('没有检测到有效链接', 'err'); return; }
        var link = links[0];
        var fmt = $('vFormat').value || 'best';
        importing = true;
        $('btnVImport').disabled = true;
        setStatus('自动下载并导入...', '');
        addLog('下载并导入: ' + link, '');
        runOne(link, fmt, false).then(function (res) {
            importing = false;
            $('btnVImport').disabled = false;
            if (res.ok && res.outPath) {
                importPathToPR(res.outPath);
            }
        });
    }

    function importPathToPR(filePath) {
        if (!filePath) { setStatus('没有可导入的文件', 'err'); return; }
        setStatus('导入 PR...', '');
        csInterface.evalScript('videoImportPayload = ' + JSON.stringify([filePath]) + ';', function () {
            csInterface.evalScript('videoImportToBinStr()', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) setStatus('已导入「视频」素材箱：' + data.imported.join('、'), 'ok');
                    else setStatus(data.error || '导入失败', 'err');
                } catch (e) {
                    setStatus('导入解析失败: ' + result, 'err');
                }
            });
        });
    }

    // ---------- 事件绑定 & 初始化 ----------
    function bindEvents() {
        $('btnVParse').addEventListener('click', doParse);
        $('btnVGv').addEventListener('click', toggleGv);
        $('btnVDownload').addEventListener('click', doDownload);
        $('btnVDownloadAll').addEventListener('click', doDownloadAll);
        $('btnVOpenDir').addEventListener('click', openDir);
        $('btnVImport').addEventListener('click', importToPR);
        $('btnVCookie').addEventListener('click', pasteCookie);
        $('btnVClearHistory').addEventListener('click', clearHistory);
        $('vUrl').addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                doParse();
            }
        });
    }

    function init() {
        bindEvents();
        // 暴露给 main.js 的懒启动钩子
        window.__videoOnShow = function () {
            ensureServer().then(function (h) {
                if (h && h.data && h.data.alive) {
                    addLog('本地视频服务已就绪（yt-dlp ' + h.data.version + '）', '');
                }
                refreshCookieBar();
            }).catch(function () {
                addLog('本地视频服务未就绪', 'err');
                refreshCookieBar();
            });
        };
        // 首次也刷一次 cookie 状态
        refreshCookieBar();
        renderHistory();
    }

    init();
})();
