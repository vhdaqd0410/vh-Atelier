// vh-Atelier 板块：视频下载（抖音/B站/YouTube/小红书等，yt-dlp 引擎）
// 架构：插件壳（本文件） + 本地 Node 服务（video/index.js，调 bin/yt-dlp.exe）
// 能力：粘贴链接解析 / 选画质下载 / cookie 粘贴（抖音/B站高清需登录态）/ 一键导入 PR「视频」素材箱
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
    var downloadId = null;    // 下载任务 id
    var pollTimer = null;     // 下载进度轮询
    var lastOutPath = '';     // 最近下载完成的文件路径

    function $(id) { return document.getElementById(id); }

    function setStatus(msg, type) {
        var s = $('vStatus');
        if (!s) return;
        s.textContent = msg || '';
        s.className = 'v-status ' + (type || '');
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
            $('vCookieDot').className = 'dot' + (has ? ' on' : '');
            $('vCookieTxt').textContent = has ? ('已配置浏览器 Cookie（' + r.data.len + ' 字符）') : '未配置浏览器 Cookie（抖音 / B 站高清需登录态）';
        }).catch(function () {});
    }

    function pasteCookie() {
        var cur = '';
        try { cur = window.cep.util.readClipboardText ? '' : ''; } catch (e) {}
        // 用系统剪贴板（CEP 里读剪贴板可能受限，退化为弹输入框让用户粘贴）
        var cookie = window.prompt('粘贴浏览器 Cookie（登录抖音/B站后，F12 → Network 任意请求 → 复制 Cookie 值）：\n\n说明：Cookie 只存本地 .video_cookie 文件，喂给 yt-dlp 用于解析/下载，不会上传。', '');
        if (cookie === null) return;
        cookie = (cookie || '').trim();
        if (!cookie) {
            setStatus('未输入内容', 'err');
            return;
        }
        apiPost('/cookie', { cookie: cookie }).then(function (r) {
            if (r && r.code === 0) {
                setStatus('Cookie 已保存', 'ok');
                addLog('Cookie 已配置（' + cookie.length + ' 字符）', 'ok');
                refreshCookieBar();
            } else {
                setStatus((r && r.msg) || '保存失败', 'err');
            }
        }).catch(function (e) { setStatus('保存失败: ' + e.message, 'err'); });
    }

    // ---------- 解析 ----------
    function doParse() {
        var link = $('vUrl').value.trim();
        if (!link) { setStatus('请先粘贴视频链接', 'err'); return; }
        setStatus('解析中...', '');
        addLog('解析: ' + link, '');
        hideResult();
        ensureServer().then(function () {
            return api('/parse?url=' + enc(link));
        }).then(function (r) {
            if (r && r.code === 0 && r.data) {
                parsedInfo = r.data;
                renderResult(r.data);
                setStatus('解析成功', 'ok');
                addLog('解析成功: ' + r.data.title, 'ok');
            } else {
                setStatus((r && r.msg) || '解析失败', 'err');
                addLog('解析失败: ' + ((r && r.msg) || '未知错误'), 'err');
            }
        }).catch(function (e) {
            setStatus('解析失败: ' + e.message, 'err');
            addLog('解析失败: ' + e.message, 'err');
        });
    }

    function hideResult() {
        var r = $('vResult');
        if (r) r.className = 'v-result';
        $('btnVImport').disabled = true;
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

    // ---------- 下载 ----------
    function doDownload() {
        if (!parsedInfo) { setStatus('请先解析链接', 'err'); return; }
        var link = $('vUrl').value.trim();
        var fmt = $('vFormat').value || 'best';
        setStatus('提交下载...', '');
        addLog('开始下载: ' + parsedInfo.title, '');
        $('btnVDownload').disabled = true;
        $('vProgress').className = 'v-progress show';
        $('vProgressFill').style.width = '0%';

        ensureServer().then(function () {
            // 若选了具体 formatId，传 quality=formatId 由服务端映射
            return api('/download?url=' + enc(link) + '&quality=' + enc(fmt));
        }).then(function (r) {
            if (r && r.code === 0 && r.data && r.data.id) {
                downloadId = r.data.id;
                startPoll();
            } else {
                setStatus((r && r.msg) || '提交下载失败', 'err');
                $('btnVDownload').disabled = false;
                $('vProgress').className = 'v-progress';
            }
        }).catch(function (e) {
            setStatus('提交下载失败: ' + e.message, 'err');
            $('btnVDownload').disabled = false;
            $('vProgress').className = 'v-progress';
        });
    }

    function startPoll() {
        stopPoll();
        pollTimer = setInterval(function () {
            api('/task?id=' + enc(downloadId)).then(function (r) {
                var t = r && r.data;
                if (!t) return;
                var pct = Math.round(t.progress || 0);
                $('vProgressFill').style.width = pct + '%';
                if (t.status === 'done') {
                    stopPoll();
                    lastOutPath = t.outPath;
                    setStatus('下载完成: ' + path.basename(t.outPath), 'ok');
                    addLog('下载完成: ' + t.outPath, 'ok');
                    $('btnVDownload').disabled = false;
                    $('btnVImport').disabled = false;
                    $('vProgress').className = 'v-progress';
                } else if (t.status === 'error') {
                    stopPoll();
                    setStatus('下载失败', 'err');
                    addLog('下载失败: ' + (t.err || '未知错误'), 'err');
                    $('btnVDownload').disabled = false;
                    $('vProgress').className = 'v-progress';
                } else {
                    setStatus('下载中... ' + pct + '%', '');
                }
            }).catch(function () {});
        }, 1200);
    }

    function stopPoll() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    // ---------- 导入 PR ----------
    function importToPR() {
        if (!lastOutPath) { setStatus('没有可导入的文件', 'err'); return; }
        setStatus('导入 PR...', '');
        csInterface.evalScript('videoImportPayload = ' + JSON.stringify([lastOutPath]) + ';', function () {
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
        $('btnVDownload').addEventListener('click', doDownload);
        $('btnVImport').addEventListener('click', importToPR);
        $('btnVCookie').addEventListener('click', pasteCookie);
        $('vUrl').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') doParse();
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
    }

    init();
})();
