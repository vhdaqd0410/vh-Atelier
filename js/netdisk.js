// vh-Atelier 网盘板块
// 通过服务器上的中转服务（/opt/vh-netdisk，端口 17896）访问 CloudDrive2 挂载的网盘。
//
// 架构说明：
//   CEP 面板 → 中转服务(17896, 带 CORS) → CloudDrive2 WebDAV(19798, 无 CORS) → 网盘
//   必须中转，因为 WebDAV 端点不回 CORS 头，面板直连会被浏览器拦。
//
// 为什么下载到本地再导入 PR：
//   PR 的导入 API（meImportFilesToBinStr）只认本地文件路径。
//   网盘文件在服务器上，必须先下到本地临时目录。
(function () {
    var fs, path, os, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        childProcess = require('child_process');
    } catch (e) {
        return;
    }

    var cs = new CSInterface();
    var RELAY = 'http://47.122.108.231:17896';
    var RELAY_KEY = 'vh_netdisk_relay';
    var DL_DIR_KEY = 'vh_netdisk_dldir';
    var NAV_KEY = 'vh_netdisk_lastpath';

    // 下载目录：默认系统下载目录下的 vhNetdisk
    function defaultDlDir() {
        try { return path.join(os.homedir(), 'Downloads', 'vhNetdisk'); } catch (e) { return ''; }
    }
    function getDlDir() {
        try { return localStorage.getItem(DL_DIR_KEY) || defaultDlDir(); } catch (e) { return defaultDlDir(); }
    }
    function setDlDir(d) {
        try { localStorage.setItem(DL_DIR_KEY, d || ''); } catch (e) {}
        renderDir();
    }
    function getRelay() {
        try { return localStorage.getItem(RELAY_KEY) || RELAY; } catch (e) { return RELAY; }
    }

    // ---------- UI 工具 ----------
    function $ (id) { return document.getElementById(id); }
    function esc (s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function fmtSize (n) {
        if (!n) return '—';
        if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
        if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
        return n + ' B';
    }
    function setState (text, cls) {
        var d = $('ndDot'), s = $('ndState');
        if (d) d.className = 'nd-dot' + (cls ? ' ' + cls : '');
        if (s) s.textContent = text || '';
    }
    function flash (msg) {
        if (window.__copyFlash) { try { window.__copyFlash(msg); return; } catch (e) {} }
        try {
            var t = document.createElement('div');
            t.textContent = msg;
            t.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);' +
                'background:#2a3a2a;color:#7fd68b;padding:6px 14px;border-radius:6px;font-size:12px;' +
                'z-index:10001;pointer-events:none;';
            document.body.appendChild(t);
            setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2400);
        } catch (e) {}
    }
    function renderDir () {
        var el = $('ndDir');
        if (el) el.textContent = getDlDir() || '（未设置）';
    }

    // ---------- 状态 ----------
    var curPath = '/';
    var items = [];        // 当前目录条目
    var selected = {};     // path -> item（勾选的）
    var busy = false;
    var stopFlag = false;

    // ---------- API ----------
    function api (pathname, opt) {
        opt = opt || {};
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', getRelay() + pathname, true);
            xhr.timeout = opt.timeout || 60000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) { reject(new Error('连不上中转服务（' + getRelay() + '）')); return; }
                var txt = xhr.responseText || '';
                try { resolve(JSON.parse(txt)); }
                catch (e) { reject(new Error('响应解析失败（HTTP ' + xhr.status + '）')); }
            };
            xhr.onerror = function () { reject(new Error('无法连接中转服务')); };
            xhr.ontimeout = function () { reject(new Error('请求超时')); };
            xhr.send();
        });
    }

    // ---------- 浏览 ----------
    function joinPath (base, name) {
        if (base === '/') return '/' + name;
        return base.replace(/\/+$/, '') + '/' + name;
    }
    function parentPath (p) {
        if (!p || p === '/') return '/';
        var parts = p.replace(/\/+$/, '').split('/').filter(Boolean);
        parts.pop();
        return parts.length ? '/' + parts.join('/') : '/';
    }

    function load (p) {
        p = p || '/';
        setState('正在读取 ' + p + ' …', '');
        var list = $('ndList');
        if (list) list.innerHTML = '<div class="nd-empty">加载中…</div>';
        api('/list?path=' + encodeURIComponent(p)).then(function (r) {
            if (!r || r.code !== 0) {
                setState('读取失败：' + ((r && r.msg) || '未知错误'), 'err');
                if (list) list.innerHTML = '<div class="nd-empty nd-err">' + esc((r && r.msg) || '读取失败') + '</div>';
                return;
            }
            curPath = (r.data && r.data.path) || p;
            items = (r.data && r.data.items) || [];
            selected = {};
            try { localStorage.setItem(NAV_KEY, curPath); } catch (e) {}
            setState('已连接　共 ' + items.length + ' 项　（双击文件预览，拖到 PR 需先下载）', 'ok');
            renderCrumbs();
            renderList();
            updateSelInfo();
        }).catch(function (e) {
            setState('读取失败：' + (e && e.message || e), 'err');
            if (list) list.innerHTML = '<div class="nd-empty nd-err">' + esc((e && e.message) || String(e)) + '</div>';
        });
    }

    function renderCrumbs () {
        var box = $('ndCrumbs');
        if (!box) return;
        box.innerHTML = '';
        var parts = curPath.split('/').filter(Boolean);
        var a = document.createElement('span');
        a.className = 'nd-crumb';
        a.textContent = '网盘';
        a.addEventListener('click', function () { load('/'); });
        box.appendChild(a);
        var acc = '';
        parts.forEach(function (seg) {
            acc += '/' + seg;
            var sep = document.createElement('span');
            sep.className = 'nd-crumb-sep';
            sep.textContent = '›';
            box.appendChild(sep);
            var b = document.createElement('span');
            b.className = 'nd-crumb';
            b.textContent = seg;
            (function (target) {
                b.addEventListener('click', function () { load(target); });
            })(acc);
            box.appendChild(b);
        });
    }

    // 按扩展名判断类型（决定导入哪个素材箱）
    function kindOf (name) {
        var n = String(name || '').toLowerCase();
        if (/\.(mp4|mov|mkv|avi|flv|webm|m4v|wmv|ts)$/.test(n)) return 'video';
        if (/\.(mp3|wav|flac|m4a|aac|ogg|wma)$/.test(n)) return 'audio';
        if (/\.(jpg|jpeg|png|gif|webp|bmp|tif|tiff)$/.test(n)) return 'image';
        return 'other';
    }
    function kindIcon (k) {
        return k === 'video' ? '🎬' : k === 'audio' ? '🎵' : k === 'image' ? '🖼' : '📄';
    }

    function renderList () {
        var box = $('ndList');
        if (!box) return;
        if (!items.length) {
            box.innerHTML = '<div class="nd-empty">这个文件夹是空的</div>';
            return;
        }
        box.innerHTML = '';
        items.forEach(function (it) {
            var row = document.createElement('div');
            row.className = 'nd-item' + (it.dir ? ' is-dir' : '');
            row.setAttribute('data-path', it.path);

            var cb = document.createElement('span');
            cb.className = 'nd-cb' + (selected[it.path] ? ' on' : '');
            cb.textContent = selected[it.path] ? '☑' : '☐';

            var icon = document.createElement('span');
            icon.className = 'nd-icon';
            icon.textContent = it.dir ? '📁' : kindIcon(kindOf(it.name));

            var nm = document.createElement('span');
            nm.className = 'nd-name';
            nm.textContent = it.name;
            nm.title = it.path;

            var sz = document.createElement('span');
            sz.className = 'nd-size';
            sz.textContent = it.dir ? '文件夹' : fmtSize(it.size);

            row.appendChild(cb);
            row.appendChild(icon);
            row.appendChild(nm);
            row.appendChild(sz);

            // 目录：单击进入；文件：单击切勾选
            row.addEventListener('click', function () {
                if (it.dir) { load(it.path); return; }
                if (selected[it.path]) delete selected[it.path];
                else selected[it.path] = it;
                cb.textContent = selected[it.path] ? '☑' : '☐';
                cb.className = 'nd-cb' + (selected[it.path] ? ' on' : '');
                updateSelInfo();
            });
            // 文件：双击预览、可拖拽、右键菜单
            if (!it.dir) {
                row.addEventListener('dblclick', function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    openPreview(it);
                });
                enableDrag(row, it);
                row.addEventListener('contextmenu', function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    showFileMenu(it, ev);
                });
            }
            box.appendChild(row);
        });
    }

    function updateSelInfo () {
        var n = Object.keys(selected).length;
        var el = $('ndSelInfo');
        if (el) el.textContent = '已选 ' + n + ' 项';
    }

    // ---------- 下载 ----------
    // 下载单个文件到本地（支持进度）
    function downloadOne (item, onPct) {
        return new Promise(function (resolve, reject) {
            var dir = getDlDir();
            try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
            var safe = String(item.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
            var dest = path.join(dir, safe);
            // 重名加序号
            if (fs.existsSync(dest)) {
                var base = safe.replace(/(\.[^.]*)?$/, '');
                var ext = (safe.match(/(\.[^.]*)$/) || [''])[0];
                var k = 1;
                while (fs.existsSync(dest)) { dest = path.join(dir, base + '_' + (k++) + ext); }
            }
            var url = getRelay() + '/file?path=' + encodeURIComponent(item.path);
            var mod = url.indexOf('https') === 0 ? require('https') : require('http');
            mod.get(url, function (res) {
                if (res.statusCode !== 200 && res.statusCode !== 206) {
                    res.resume();
                    return reject(new Error('HTTP ' + res.statusCode));
                }
                var total = parseInt(res.headers['content-length'] || '0', 10);
                var got = 0;
                var f = fs.createWriteStream(dest);
                res.on('data', function (c) {
                    got += c.length;
                    if (onPct && total) onPct(Math.floor(got * 100 / total), got, total);
                });
                res.pipe(f);
                f.on('finish', function () { f.close(function () { resolve(dest); }); });
                f.on('error', reject);
            }).on('error', reject);
        });
    }

    function showProg (msg) {
        var el = $('ndProgress');
        if (el) el.style.display = '';
        setProg(0, msg || '准备中…', '');
    }
    function setProg (pct, msg, sub) {
        var f = $('ndProgFill'), m = $('ndProgMsg'), s = $('ndProgSub');
        if (f) f.style.width = Math.max(0, Math.min(100, pct)) + '%';
        if (m && msg != null) m.textContent = msg;
        if (s && sub != null) s.textContent = sub;
    }
    function hideProg () {
        var el = $('ndProgress');
        if (el) el.style.display = 'none';
    }

    // 批量下载：files 是 [{path,name,size}]，逐个下（串行，稳）
    function downloadBatch (list, label) {
        if (busy) { flash('已有任务在进行'); return Promise.resolve([]); }
        if (!list.length) { flash('没有选中文件'); return Promise.resolve([]); }
        busy = true; stopFlag = false;
        showProg(label || ('下载 ' + list.length + ' 个文件'));
        var out = [];
        var i = 0;
        return new Promise(function (resolve) {
            function next () {
                if (stopFlag) { flash('已停止'); busy = false; hideProg(); return resolve(out); }
                if (i >= list.length) {
                    busy = false; hideProg();
                    flash('已下载 ' + out.length + ' 个文件到 ' + getDlDir());
                    resolve(out);
                    return;
                }
                var it = list[i++];
                var head = '[' + i + '/' + list.length + '] ' + it.name;
                setProg(Math.round((i - 1) * 100 / list.length), head, '正在下载…');
                downloadOne(it, function (pct, got, total) {
                    setProg(
                        Math.round(((i - 1) + pct / 100) * 100 / list.length),
                        head,
                        pct + '%　' + fmtSize(got) + ' / ' + fmtSize(total)
                    );
                }).then(function (dest) {
                    out.push({ path: dest, name: it.name });
                    dragCache[it.path] = dest;   // 记入拖拽缓存，之后可直接拖
                    next();
                }).catch(function (e) {
                    flash('下载失败：' + it.name + '（' + (e && e.message || e) + '）');
                    next();
                });
            }
            next();
        });
    }

    // ---------- 导入 PR / 插入时间线 ----------
    function importToPR (paths, binName, label) {
        if (!paths.length) { flash('没有可导入的文件'); return; }
        var md = typeof window.__mediaImportList === 'function';
        // 复用素材板块的导入实现（它已处理分批、进度、素材箱）
        if (window.__mediaImportList) {
            window.__mediaImportList(paths, binName, label || '导入中…');
        } else {
            flash('导入模块未就绪，请重开面板');
        }
    }
    function insertToTimeline (p) {
        if (window.__mediaInsertToTimeline) window.__mediaInsertToTimeline(p);
        else flash('插入模块未就绪');
    }

    // 下好再导入：只处理选中项里的媒体文件
    function pickMedia (list) {
        return list.filter(function (it) { return kindOf(it.name) !== 'other'; });
    }

    function doImport () {
        var sel = Object.keys(selected).map(function (k) { return selected[k]; });
        if (!sel.length) { flash('先选中要导入的文件'); return; }
        var media = pickMedia(sel);
        if (!media.length) { flash('选中的都不是媒体文件'); return; }
        downloadBatch(media, '为导入 PR 下载 ' + media.length + ' 个文件').then(function (got) {
            if (!got.length) return;
            var bins = {};
            got.forEach(function (g) {
                var k = kindOf(g.name);
                var bin = k === 'video' ? '视频' : k === 'audio' ? '音乐' : '图片';
                (bins[bin] = bins[bin] || []).push(g.path);
            });
            Object.keys(bins).forEach(function (bin) {
                importToPR(bins[bin], bin, '导入「' + bin + '」素材箱');
            });
        });
    }
    function doInsert () {
        var sel = Object.keys(selected).map(function (k) { return selected[k]; });
        var media = pickMedia(sel);
        if (media.length !== 1) { flash('插入时间线只能选 1 个媒体文件'); return; }
        downloadBatch(media, '为插入时间线下载').then(function (got) {
            if (got.length) insertToTimeline(got[0].path);
        });
    }
    function doDownload () {
        var sel = Object.keys(selected).map(function (k) { return selected[k]; });
        downloadBatch(sel, null);
    }

    // ---------- 预览 ----------
    // 网盘文件用中转服务的流地址播放（支持 Range，能边下边播、拖进度）
    var previewOverlay = null;
    function closePreview () {
        if (previewOverlay && previewOverlay.parentNode) previewOverlay.parentNode.removeChild(previewOverlay);
        previewOverlay = null;
    }
    function openPreview (item) {
        closePreview();
        var ext = String(item.name || '').toLowerCase().split('.').pop();
        var k = kindOf(item.name);
        var streamUrl = getRelay() + '/stream?path=' + encodeURIComponent(item.path);

        var ov = document.createElement('div');
        ov.className = 'nd-prev-mask';
        var box = document.createElement('div');
        box.className = 'nd-prev-box';

        var ttl = document.createElement('div');
        ttl.className = 'nd-prev-title';
        ttl.textContent = item.name + '　' + fmtSize(item.size);
        box.appendChild(ttl);

        var media = null;
        if (k === 'image') {
            media = document.createElement('img');
            media.src = streamUrl;
            media.className = 'nd-prev-img';
        } else if (k === 'video') {
            media = document.createElement('video');
            media.controls = true;
            media.autoplay = true;
            media.preload = 'metadata';
            media.src = streamUrl;
            media.className = 'nd-prev-video';
        } else if (k === 'audio') {
            media = document.createElement('audio');
            media.controls = true;
            media.autoplay = true;
            media.src = streamUrl;
            media.className = 'nd-prev-audio';
        }
        if (media) {
            // 播放出错时给出可读提示（而不是黑屏）
            media.addEventListener('error', function () {
                var tip = document.createElement('div');
                tip.className = 'nd-prev-err';
                tip.textContent = '无法预览（可能是编码不支持，或中转服务暂时不可用）。可点「外部打开」用系统播放器。';
                box.appendChild(tip);
            });
            box.appendChild(media);
        } else {
            var tx = document.createElement('div');
            tx.className = 'nd-prev-text';
            tx.textContent = '此类型不支持内置预览：' + item.path;
            box.appendChild(tx);
        }

        // 底部按钮
        var row = document.createElement('div');
        row.className = 'nd-prev-actions';
        function btn (text, fn) {
            var b = document.createElement('button');
            b.className = 'tbtn';
            b.textContent = text;
            b.addEventListener('click', fn);
            row.appendChild(b);
        }
        if (k !== 'other') {
            btn('📥 导入 PR', function () {
                downloadBatch([item], '为导入下载').then(function (got) {
                    if (!got.length) return;
                    var kk = kindOf(got[0].name);
                    importToPR([got[0].path], kk === 'video' ? '视频' : kk === 'audio' ? '音乐' : '图片', '导入');
                });
            });
        }
        btn('⬇ 下载到本地', function () { downloadBatch([item], '下载 ' + item.name); });
        btn('🌐 外部打开', function () {
            try { childProcess.exec('start "" "' + streamUrl + '"'); } catch (e) {}
        });
        btn('✕ 关闭', closePreview);
        box.appendChild(row);

        ov.appendChild(box);
        // 点遮罩空白处关闭
        ov.addEventListener('click', function (e) { if (e.target === ov) closePreview(); });
        document.body.appendChild(ov);
        previewOverlay = ov;
    }

    // ---------- 拖拽到 PR ----------
    // 关键：CEP 拖拽只认本地文件路径（com.adobe.cep.dnd.file.0）。
    // 网盘文件不在本地，所以拖之前必须先下到本地缓存；已缓存的可以秒拖。
    var dragCache = {};   // path -> 本地绝对路径
    function localPathOf (item) {
        if (dragCache[item.path]) return dragCache[item.path];
        // 与下载逻辑一致的重名处理
        var dir = getDlDir();
        var safe = String(item.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
        var dest = path.join(dir, safe);
        if (fs.existsSync(dest)) return dest;   // 本地已有同名，直接用
        return null;
    }
    // 给行挂上拖拽（本地已有就直接可拖；没有则拖时先下载）
    function enableDrag (row, item) {
        row.draggable = true;
        row.addEventListener('dragstart', function (ev) {
            var local = localPathOf(item);
            if (local) {
                try {
                    ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', local);
                    ev.dataTransfer.setData('text/plain', local);
                    ev.dataTransfer.effectAllowed = 'copy';
                    flash('拖入：' + item.name);
                } catch (e) {}
                return;
            }
            // 未缓存：阻止本次拖拽，先下载，下完提示再拖
            ev.preventDefault();
            flash('首次拖拽需先下载：' + item.name);
            downloadBatch([item], '为拖拽准备 ' + item.name).then(function (got) {
                if (got.length) {
                    dragCache[item.path] = got[0].path;
                    flash('已就绪，现在可以拖到 PR 了：' + item.name);
                }
            });
        });
    }

    // ---------- 右键菜单 ----------
    function showFileMenu (it, ev) {
        var old = document.getElementById('ndMenu');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var menu = document.createElement('div');
        menu.id = 'ndMenu';
        menu.className = 'nd-menu';
        function mi (text, fn) {
            var el = document.createElement('div');
            el.className = 'nd-menu-item';
            el.textContent = text;
            el.addEventListener('click', function () { menu.remove(); try { fn(); } catch (e) { flash('出错：' + e.message); } });
            menu.appendChild(el);
        }
        var isMedia = kindOf(it.name) !== 'other';
        if (isMedia) mi('👁 预览', function () { openPreview(it); });
        mi('⬇ 下载到本地', function () { downloadBatch([it], '下载 ' + it.name); });
        if (isMedia) {
            mi('🖱 拖到 PR（首次需下载）', function () {
                var local = localPathOf(it);
                if (local) { flash('已就绪，直接把文件行拖进 PR：' + it.name); return; }
                downloadBatch([it], '为拖拽准备 ' + it.name).then(function (got) {
                    if (got.length) { dragCache[it.path] = got[0].path; flash('已就绪，现在可拖拽：' + it.name); }
                });
            });
        }
        if (isMedia) {
            mi('📥 导入 PR 素材箱', function () {
                downloadBatch([it], '为导入下载').then(function (got) {
                    if (!got.length) return;
                    var k = kindOf(got[0].name);
                    importToPR([got[0].path], k === 'video' ? '视频' : k === 'audio' ? '音乐' : '图片', '导入');
                });
            });
            mi('⏩ 插入当前时间线', function () {
                downloadBatch([it], '为插入下载').then(function (got) {
                    if (got.length) insertToTimeline(got[0].path);
                });
            });
        }
        mi('📋 复制网盘路径', function () {
            try {
                if (navigator.clipboard) navigator.clipboard.writeText(it.path);
                else if (window.__copyFlash) window.__copyFlash(it.path);
                flash('已复制：' + it.path);
            } catch (e) {}
        });
        document.body.appendChild(menu);
        var x = ev.clientX, y = ev.clientY;
        var w = 200, h = menu.offsetHeight || 150;
        if (x + w > window.innerWidth) x = window.innerWidth - w - 4;
        if (y + h > window.innerHeight) y = window.innerHeight - h - 4;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        setTimeout(function () {
            var kill = function (e2) {
                if (!menu.contains(e2.target)) { menu.remove(); document.removeEventListener('click', kill); }
            };
            document.addEventListener('click', kill);
        }, 10);
    }

    // ---------- 初始化 ----------
    function bind () {
        try {
            renderDir();
            // 顶部按钮
            var b;
            b = $('ndHome');    if (b) b.addEventListener('click', function () { load('/'); });
            b = $('ndUp');      if (b) b.addEventListener('click', function () { load(parentPath(curPath)); });
            b = $('ndRefresh'); if (b) b.addEventListener('click', function () { load(curPath); });
            b = $('ndSelAll');  if (b) b.addEventListener('click', function () {
                items.forEach(function (it) { if (!it.dir) selected[it.path] = it; });
                renderList(); updateSelInfo();
            });
            b = $('ndSelNone'); if (b) b.addEventListener('click', function () {
                selected = {}; renderList(); updateSelInfo();
            });
            b = $('ndPreview'); if (b) b.addEventListener('click', function () {
                var sel = Object.keys(selected).map(function (k) { return selected[k]; });
                if (sel.length !== 1) { flash('预览请选中 1 个文件（也可直接双击文件行）'); return; }
                openPreview(sel[0]);
            });
            b = $('ndDownload'); if (b) b.addEventListener('click', doDownload);
            b = $('ndImport');   if (b) b.addEventListener('click', doImport);
            b = $('ndInsert');   if (b) b.addEventListener('click', doInsert);
            b = $('ndProgCancel'); if (b) b.addEventListener('click', function () { stopFlag = true; });
            b = $('ndPickDir');  if (b) b.addEventListener('click', pickDlDir);
            b = $('ndOpenDir');  if (b) b.addEventListener('click', function () {
                var d = getDlDir();
                if (!d) return;
                try { fs.mkdirSync(d, { recursive: true }); childProcess.exec('explorer.exe "' + d + '"'); } catch (e) {}
            });
            // 管理界面：按需展开
            b = $('ndManage'); if (b) b.addEventListener('click', function () {
                var w = $('ndManageWrap');
                if (w) w.style.display = (w.style.display === 'none' || !w.style.display) ? '' : 'none';
                if (w && w.style.display !== 'none' && window.__netdiskAutoLoad) window.__netdiskAutoLoad();
            });
            b = $('ndManageClose'); if (b) b.addEventListener('click', function () {
                var w = $('ndManageWrap');
                if (w) w.style.display = 'none';
            });
        } catch (e) {}
    }

    function pickDlDir () {
        // 复用素材板块的目录选择器（PowerShell 文件夹对话框）
        if (typeof window.__mediaPickFolder === 'function') {
            window.__mediaPickFolder(getDlDir(), '选择网盘下载目录', function (p) {
                if (p) { setDlDir(p); flash('下载目录已设为：' + p); }
            });
        } else {
            flash('目录选择器未就绪，请重开面板');
        }
    }

    // 切到本板块时加载
    window.__netdiskOnShow = function () {
        var last = '/';
        try { last = localStorage.getItem(NAV_KEY) || '/'; } catch (e) {}
        if (!items.length) load(last);
    };

    bind();
})();
