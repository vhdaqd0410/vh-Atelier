// vh-Atelier 网盘板块（树形版）
// 交互对齐「素材浏览」：左侧目录树（懒加载展开）+ 右侧文件列表 + 多选 + 批量导入。
//
// 数据源：服务器中转服务（/opt/vh-netdisk，端口 17896）
//   面板 → 中转(带CORS) → CloudDrive2 WebDAV(无CORS) → 网盘
//   必须先下到本地再导入 PR：PR 的导入 API 只认本地文件路径。
(function () {
    var fs, path, os, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        childProcess = require('child_process');
    } catch (e) { return; }

    var RELAY_KEY = 'vh_netdisk_relay';
    var DL_DIR_KEY = 'vh_netdisk_dldir';
    var NAV_KEY = 'vh_netdisk_curdir';
    var EXP_KEY = 'vh_netdisk_expanded';
    var RELAY = 'http://47.122.108.231:17896';

    function $ (id) { return document.getElementById(id); }
    function esc (s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function getRelay () {
        try { return localStorage.getItem(RELAY_KEY) || RELAY; } catch (e) { return RELAY; }
    }
    function defaultDlDir () {
        try { return path.join(os.homedir(), 'Downloads', 'vhNetdisk'); } catch (e) { return ''; }
    }
    function getDlDir () {
        try { return localStorage.getItem(DL_DIR_KEY) || defaultDlDir(); } catch (e) { return defaultDlDir(); }
    }
    function setDlDir (d) {
        try { localStorage.setItem(DL_DIR_KEY, d || ''); } catch (e) {}
        renderDirLabel();
    }
    function fmtSize (n) {
        if (!n) return '—';
        if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
        return n + ' B';
    }
    function setState (t, cls) {
        var d = $('ndDot'), s = $('ndState');
        if (d) d.className = 'nd-dot' + (cls ? ' ' + cls : '');
        if (s) s.textContent = t || '';
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
    function renderDirLabel () {
        var el = $('ndDir');
        if (el) { el.textContent = getDlDir() || '（未设置）'; el.title = getDlDir() || ''; }
    }

    // ---------- 状态 ----------
    var curDir = '';              // 当前选中目录（绝对路径）
    var childrenCache = {};       // dir -> [items]
    var expanded = {};            // dir -> true
    var dirFiles = {};            // dir -> [file items]（右侧列表用）
    var selFiles = {};            // path -> item（选中，与素材浏览一致）
    var busy = false, stopFlag = false;
    var dragCache = {};           // path -> 本地路径

    try { expanded = JSON.parse(localStorage.getItem(EXP_KEY) || '{}') || {}; } catch (e) { expanded = {}; }
    function saveExpanded () {
        try { localStorage.setItem(EXP_KEY, JSON.stringify(expanded)); } catch (e) {}
    }

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

    // 拉某目录的子项（带缓存）
    function fetchDir (dir, force) {
        if (!force && childrenCache[dir]) return Promise.resolve(childrenCache[dir]);
        return api('/list?path=' + encodeURIComponent(dir)).then(function (r) {
            if (!r || r.code !== 0) throw new Error((r && r.msg) || '读取失败');
            var items = (r.data && r.data.items) || [];
            childrenCache[dir] = items;
            return items;
        });
    }

    function kindOf (name) {
        var n = String(name || '').toLowerCase();
        if (/\.(mp4|mov|mkv|avi|flv|webm|m4v|wmv|ts|mxf|mts|m2ts)$/.test(n)) return 'video';
        if (/\.(mp3|wav|flac|m4a|aac|ogg|wma|aiff)$/.test(n)) return 'audio';
        if (/\.(jpg|jpeg|png|gif|webp|bmp|tif|tiff)$/.test(n)) return 'image';
        return 'other';
    }
    function iconOf (name, isDir) {
        if (isDir) return '📁';
        var ext = String(name).toLowerCase().split('.').pop();
        var map = {
            mp4: '🎬', mov: '🎬', mkv: '🎬', avi: '🎬', m4v: '🎬', webm: '🎬', mxf: '🎬', mts: '🎬', m2ts: '🎬',
            wav: '🔊', mp3: '🎵', aiff: '🔊', aac: '🎵', flac: '🎵', m4a: '🎵',
            png: '🖼', jpg: '🖼', jpeg: '🖼', webp: '🖼', gif: '🖼',
            srt: '📝', txt: '📝', pdf: '📕', docx: '📄', doc: '📄',
            psd: '🎨', prproj: '🎬PR',
        };
        return map[ext] || '📄';
    }
    function isMedia (name) { return kindOf(name) !== 'other'; }

    // ---------- 左树 ----------
    function renderTree () {
        var box = $('ndTree');
        if (!box) return;
        box.innerHTML = '';
        // 根节点：网盘
        var root = document.createElement('div');
        root.className = 'md-tree-item md-root' + (curDir === '/' ? ' sel' : '');
        root.style.paddingLeft = '6px';
        var rcaret = document.createElement('span');
        rcaret.className = 'caret';
        rcaret.textContent = expanded['/'] ? '▾' : '▸';
        rcaret.style.cssText = 'display:inline-block;width:22px;height:20px;line-height:18px;text-align:center;color:var(--accent);cursor:pointer;border-radius:4px;font-size:13px;flex:0 0 auto;';
        var rico = document.createElement('span');
        rico.textContent = '☁ ';
        var rlbl = document.createElement('span');
        rlbl.textContent = '网盘';
        root.appendChild(rcaret); root.appendChild(rico); root.appendChild(rlbl);
        root.addEventListener('click', function (ev) {
            if (ev.target === rcaret) {
                if (expanded['/']) delete expanded['/']; else expanded['/'] = true;
                saveExpanded(); renderTree(); return;
            }
            selectDir('/', true);
        });
        root._caret = rcaret;
        box.appendChild(root);

        // 递归渲染已展开的子树
        if (expanded['/']) {
            renderChildren('/', 1, box);
        }
    }

    function renderChildren (dir, depth, host) {
        var items = childrenCache[dir];
        if (!items) {
            // 还没拉过：拉一次再渲染
            var loading = document.createElement('div');
            loading.className = 'hint';
            loading.style.cssText = 'padding:4px 8px;font-size:11px;';
            loading.textContent = '加载中…';
            host.appendChild(loading);
            fetchDir(dir).then(function () {
                renderTree();
            }).catch(function (e) {
                loading.textContent = '加载失败：' + (e && e.message || e);
            });
            return;
        }
        var dirs = items.filter(function (x) { return x.dir; });
        dirs.forEach(function (it) {
            var row = document.createElement('div');
            row.className = 'md-tree-item md-subdir' + (it.path === curDir ? ' sel' : '');
            row.style.paddingLeft = (6 + depth * 12) + 'px';
            var caret = document.createElement('span');
            caret.className = 'caret';
            var hasKids = true;   // 网盘目录无法预先知道有没有子项，统一给展开箭头
            caret.textContent = hasKids ? (expanded[it.path] ? '▾' : '▸') : '';
            caret.style.cssText = 'display:inline-block;width:22px;height:20px;line-height:18px;text-align:center;color:var(--accent);cursor:pointer;border-radius:4px;font-size:13px;flex:0 0 auto;';
            var ico = document.createElement('span');
            ico.textContent = '📁 ';
            var lbl = document.createElement('span');
            lbl.textContent = it.name;
            lbl.title = it.path;
            lbl.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            row.appendChild(caret); row.appendChild(ico); row.appendChild(lbl);
            row.addEventListener('click', function (ev) {
                if (ev.target === caret) {
                    if (expanded[it.path]) delete expanded[it.path];
                    else expanded[it.path] = true;
                    saveExpanded();
                    if (expanded[it.path] && !childrenCache[it.path]) {
                        fetchDir(it.path).then(function () { renderTree(); }, function () { renderTree(); });
                    } else {
                        renderTree();
                    }
                    return;
                }
                selectDir(it.path, true);
            });
            host.appendChild(row);
            if (expanded[it.path]) {
                renderChildren(it.path, depth + 1, host);
            }
        });
        if (!dirs.length) {
            var empty = document.createElement('div');
            empty.className = 'hint';
            empty.style.cssText = 'padding:2px 8px 6px ' + (10 + depth * 12) + 'px;font-size:10.5px;';
            empty.textContent = '（无子文件夹）';
            host.appendChild(empty);
        }
    }

    function selectDir (dir, autoExpand) {
        curDir = dir;
        if (autoExpand) expanded[dir] = true;
        saveExpanded();
        try { localStorage.setItem(NAV_KEY, dir); } catch (e) {}
        if (!childrenCache[dir]) {
            fetchDir(dir).then(function () { renderTree(); renderFiles(dir); },
                              function () { renderTree(); renderFiles(dir); });
        } else {
            renderTree();
            renderFiles(dir);
        }
    }

    // ---------- 右侧文件列表 ----------
    function renderFiles (dir) {
        var head = $('ndFHead'), list = $('ndFList');
        if (!head || !list) return;
        var items = childrenCache[dir] || [];
        var files = items.filter(function (x) { return !x.dir; });
        var dirs = items.filter(function (x) { return x.dir; });
        head.innerHTML = '';
        var hcap = document.createElement('span');
        hcap.className = 'hint';
        hcap.textContent =
            (dir === '/' ? '网盘根目录' : dir) +
            '　·　' + dirs.length + ' 个文件夹 / ' + files.length + ' 个文件';
        head.appendChild(hcap);

        list.innerHTML = '';
        dirs.concat(files).forEach(function (it) {
            var row = document.createElement('div');
            row.className = 'md-file md-leaf' + (selFiles[it.path] ? ' sel' : '') + (it.dir ? ' md-dirleaf' : '');
            var ic = document.createElement('span'); ic.className = 'md-ic'; ic.textContent = iconOf(it.name, it.dir);
            var fn = document.createElement('span'); fn.className = 'md-fn'; fn.textContent = it.name;
            var sz = document.createElement('span'); sz.className = 'md-sz'; sz.textContent = it.dir ? '' : fmtSize(it.size);
            row.appendChild(ic); row.appendChild(fn); row.appendChild(sz);
            row.title = it.path;

            if (it.dir) {
                // 文件夹：单击进入
                row.addEventListener('click', function () { selectDir(it.path, true); });
            } else {
                row.draggable = true;
                row.addEventListener('dragstart', function (ev) {
                    var local = localPathOf(it);
                    if (local) {
                        try {
                            ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', local);
                            ev.dataTransfer.setData('text/plain', local);
                            ev.dataTransfer.effectAllowed = 'copy';
                            flash('拖入：' + it.name);
                        } catch (e) {}
                        return;
                    }
                    ev.preventDefault();
                    flash('首次拖拽需先下载：' + it.name);
                    downloadBatch([it], '为拖拽准备 ' + it.name).then(function (got) {
                        if (got.length) {
                            dragCache[it.path] = got[0].path;
                            flash('已就绪，现在可以拖到 PR：' + it.name);
                        }
                    });
                });
                row.addEventListener('dragend', function () { closePreview(); });
                row.addEventListener('click', function (ev) {
                    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
                        if (selFiles[it.path]) delete selFiles[it.path]; else selFiles[it.path] = it;
                        row.classList.toggle('sel', !!selFiles[it.path]);
                        updateSelCount();
                        return;
                    }
                    selFiles = {};
                    selFiles[it.path] = it;
                    renderFiles(curDir);
                    updateSelCount();
                });
                row.addEventListener('dblclick', function (ev) {
                    ev.preventDefault(); ev.stopPropagation();
                    openPreview(it);
                });
                row.addEventListener('contextmenu', function (ev) {
                    ev.preventDefault(); ev.stopPropagation();
                    showFileMenu(it, ev);
                });
            }
            list.appendChild(row);
        });
        if (!items.length) {
            list.innerHTML = '<div class="hint" style="padding:10px;">这个文件夹是空的</div>';
        }
    }

    function updateSelCount () {
        var n = Object.keys(selFiles).length;
        var b = $('ndDownload');
        if (b) b.textContent = '⬇ 下载选中(' + n + ')';
    }
    function selectedList () {
        return Object.keys(selFiles).map(function (k) { return selFiles[k]; });
    }

    // ---------- 下载 ----------
    function localPathOf (item) {
        if (dragCache[item.path]) return dragCache[item.path];
        var dir = getDlDir();
        var safe = String(item.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
        var dest = path.join(dir, safe);
        try { if (fs.existsSync(dest)) return dest; } catch (e) {}
        return null;
    }
    function downloadOne (item, onPct) {
        return new Promise(function (resolve, reject) {
            var dir = getDlDir();
            try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
            var safe = String(item.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
            var dest = path.join(dir, safe);
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
        var el = $('ndProgress'); if (el) el.style.display = '';
        setProg(0, msg || '准备中…', '');
    }
    function setProg (pct, msg, sub) {
        var f = $('ndProgFill'), m = $('ndProgMsg'), s = $('ndProgSub');
        if (f) f.style.width = Math.max(0, Math.min(100, pct)) + '%';
        if (m && msg != null) m.textContent = msg;
        if (s && sub != null) s.textContent = sub;
    }
    function hideProg () { var el = $('ndProgress'); if (el) el.style.display = 'none'; }

    function downloadBatch (list, label) {
        if (busy) { flash('已有任务在进行'); return Promise.resolve([]); }
        if (!list.length) { flash('没有选中文件'); return Promise.resolve([]); }
        busy = true; stopFlag = false;
        showProg(label || ('下载 ' + list.length + ' 个文件'));
        var out = [], i = 0;
        return new Promise(function (resolve) {
            function next () {
                if (stopFlag) { flash('已停止'); busy = false; hideProg(); return resolve(out); }
                if (i >= list.length) {
                    busy = false; hideProg();
                    flash('已下载 ' + out.length + ' 个文件到 ' + getDlDir());
                    return resolve(out);
                }
                var it = list[i++];
                var head = '[' + i + '/' + list.length + '] ' + it.name;
                setProg(Math.round((i - 1) * 100 / list.length), head, '正在下载…');
                downloadOne(it, function (pct, got, total) {
                    setProg(Math.round(((i - 1) + pct / 100) * 100 / list.length), head,
                            pct + '%　' + fmtSize(got) + ' / ' + fmtSize(total));
                }).then(function (dest) {
                    out.push({ path: dest, name: it.name });
                    dragCache[it.path] = dest;
                    next();
                }).catch(function (e) {
                    flash('下载失败：' + it.name + '（' + (e && e.message || e) + '）');
                    next();
                });
            }
            next();
        });
    }

    // ---------- 预览 ----------
    var previewOverlay = null;
    function closePreview () {
        if (previewOverlay && previewOverlay.parentNode) previewOverlay.parentNode.removeChild(previewOverlay);
        previewOverlay = null;
    }
    function openPreview (item) {
        closePreview();
        var k = kindOf(item.name);
        var url = getRelay() + '/stream?path=' + encodeURIComponent(item.path);
        var ov = document.createElement('div'); ov.className = 'nd-prev-mask';
        var box = document.createElement('div'); box.className = 'nd-prev-box';
        var ttl = document.createElement('div'); ttl.className = 'nd-prev-title';
        ttl.textContent = item.name + '　' + fmtSize(item.size);
        box.appendChild(ttl);
        var media = null;
        if (k === 'image') { media = document.createElement('img'); media.src = url; media.className = 'nd-prev-img'; }
        else if (k === 'video') { media = document.createElement('video'); media.controls = true; media.autoplay = true; media.preload = 'metadata'; media.src = url; media.className = 'nd-prev-video'; }
        else if (k === 'audio') { media = document.createElement('audio'); media.controls = true; media.autoplay = true; media.src = url; media.className = 'nd-prev-audio'; }
        if (media) {
            media.addEventListener('error', function () {
                var tip = document.createElement('div'); tip.className = 'nd-prev-err';
                tip.textContent = '无法预览（编码不支持或中转服务不可用）。可点「外部打开」用系统播放器。';
                box.appendChild(tip);
            });
            box.appendChild(media);
        } else {
            var tx = document.createElement('div'); tx.className = 'nd-prev-text';
            tx.textContent = '此类型不支持内置预览：' + item.path;
            box.appendChild(tx);
        }
        var row = document.createElement('div'); row.className = 'nd-prev-actions';
        function btn (text, fn) {
            var b = document.createElement('button'); b.className = 'tbtn'; b.textContent = text;
            b.addEventListener('click', fn); row.appendChild(b);
        }
        if (k !== 'other') btn('📥 导入 PR', function () {
            downloadBatch([item], '为导入下载').then(function (got) {
                if (!got.length) return;
                var kk = kindOf(got[0].name);
                importToPR([got[0].path], kk === 'video' ? '视频' : kk === 'audio' ? '音乐' : '图片', '导入');
            });
        });
        btn('⬇ 下载到本地', function () { downloadBatch([item], '下载 ' + item.name); });
        btn('🌐 外部打开', function () { try { childProcess.exec('start "" "' + url + '"'); } catch (e) {} });
        btn('✕ 关闭', closePreview);
        box.appendChild(row);
        ov.appendChild(box);
        ov.addEventListener('click', function (e) { if (e.target === ov) closePreview(); });
        document.body.appendChild(ov);
        previewOverlay = ov;
    }

    // ---------- 导入 PR ----------
    function importToPR (paths, binName, label) {
        if (!paths.length) { flash('没有可导入的文件'); return; }
        if (window.__mediaImportList) window.__mediaImportList(paths, binName, label || '导入中…');
        else flash('导入模块未就绪，请重开面板');
    }
    function insertToTimeline (p) {
        if (window.__mediaInsertToTimeline) window.__mediaInsertToTimeline(p);
        else flash('插入模块未就绪');
    }
    function pickMedia (list) { return list.filter(function (it) { return isMedia(it.name); }); }

    function doImport () {
        var sel = selectedList();
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
        var media = pickMedia(selectedList());
        if (media.length !== 1) { flash('插入时间线只能选 1 个媒体文件'); return; }
        downloadBatch(media, '为插入时间线下载').then(function (got) {
            if (got.length) insertToTimeline(got[0].path);
        });
    }
    function doDownload () { downloadBatch(selectedList(), null); }
    function doPreview () {
        var sel = selectedList();
        if (sel.length !== 1) { flash('预览请选中 1 个文件（也可双击文件行）'); return; }
        openPreview(sel[0]);
    }

    // ---------- 右键菜单 ----------
    function showFileMenu (it, ev) {
        var old = document.getElementById('ndMenu');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var menu = document.createElement('div');
        menu.id = 'ndMenu'; menu.className = 'nd-menu';
        function mi (text, fn) {
            var el = document.createElement('div');
            el.className = 'nd-menu-item'; el.textContent = text;
            el.addEventListener('click', function () { menu.remove(); try { fn(); } catch (e) { flash('出错：' + e.message); } });
            menu.appendChild(el);
        }
        if (isMedia(it.name)) mi('👁 预览', function () { openPreview(it); });
        mi('⬇ 下载到本地', function () { downloadBatch([it], '下载 ' + it.name); });
        if (isMedia(it.name)) {
            mi('📥 导入 PR 素材箱', function () {
                downloadBatch([it], '为导入下载').then(function (got) {
                    if (!got.length) return;
                    var k = kindOf(got[0].name);
                    importToPR([got[0].path], k === 'video' ? '视频' : k === 'audio' ? '音乐' : '图片', '导入');
                });
            });
            mi('⏩ 插入当前时间线', function () {
                downloadBatch([it], '为插入下载').then(function (got) { if (got.length) insertToTimeline(got[0].path); });
            });
            mi('🖱 拖到 PR（首次需下载）', function () {
                var local = localPathOf(it);
                if (local) { flash('已就绪，直接拖文件行：' + it.name); return; }
                downloadBatch([it], '为拖拽准备 ' + it.name).then(function (got) {
                    if (got.length) { dragCache[it.path] = got[0].path; flash('已就绪，现在可拖拽：' + it.name); }
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
        var w = 210, h = menu.offsetHeight || 170;
        if (x + w > window.innerWidth) x = window.innerWidth - w - 4;
        if (y + h > window.innerHeight) y = window.innerHeight - h - 4;
        menu.style.left = x + 'px'; menu.style.top = y + 'px';
        setTimeout(function () {
            var kill = function (e2) { if (!menu.contains(e2.target)) { menu.remove(); document.removeEventListener('click', kill); } };
            document.addEventListener('click', kill);
        }, 10);
    }

    // ---------- 初始化 ----------
    function boot () {
        renderDirLabel();
        var b;
        b = $('ndRefresh'); if (b) b.addEventListener('click', function () {
            childrenCache = {}; renderTree(); if (curDir) renderFiles(curDir);
            flash('已刷新');
        });
        b = $('ndPreview');   if (b) b.addEventListener('click', doPreview);
        b = $('ndDownload');  if (b) b.addEventListener('click', doDownload);
        b = $('ndImport');    if (b) b.addEventListener('click', doImport);
        b = $('ndInsert');    if (b) b.addEventListener('click', doInsert);
        b = $('ndProgCancel');if (b) b.addEventListener('click', function () { stopFlag = true; });
        b = $('ndPickDir');   if (b) b.addEventListener('click', pickDlDir);
        b = $('ndOpenDir');   if (b) b.addEventListener('click', function () {
            var d = getDlDir(); if (!d) return;
            try { fs.mkdirSync(d, { recursive: true }); childProcess.exec('explorer.exe "' + d + '"'); } catch (e) {}
        });
        b = $('ndManage');    if (b) b.addEventListener('click', function () {
            var w = $('ndManageWrap');
            var showing = w && w.style.display === 'none';
            if (w) w.style.display = showing ? 'flex' : 'none';
            if (showing && window.__netdiskAutoLoad) window.__netdiskAutoLoad();
        });
        b = $('ndManageClose'); if (b) b.addEventListener('click', function () {
            var w = $('ndManageWrap'); if (w) w.style.display = 'none';
        });
        updateSelCount();
    }

    function pickDlDir () {
        if (typeof window.__mediaPickFolder === 'function') {
            window.__mediaPickFolder(getDlDir(), '选择网盘下载目录', function (p) {
                if (p) { setDlDir(p); flash('下载目录已设为：' + p); }
            });
        } else flash('目录选择器未就绪，请重开面板');
    }

    // 切到本板块时加载
    window.__netdiskOnShow = function () {
        var last = '/';
        try { last = localStorage.getItem(NAV_KEY) || '/'; } catch (e) {}
        if (!childrenCache['/']) {
            setState('正在连接网盘服务…', '');
            fetchDir('/').then(function (items) {
                var n = items.filter(function (x) { return x.dir; }).length;
                setState('已连接　根目录 ' + n + ' 个网盘', 'ok');
                expanded['/'] = true;
                renderTree();
                var target = last && last !== '/' ? last : '/';
                curDir = target;
                if (!childrenCache[target]) {
                    fetchDir(target).then(function () { renderTree(); renderFiles(target); },
                                          function () { renderTree(); renderFiles(target); });
                } else {
                    renderTree(); renderFiles(target);
                }
            }, function (e) {
                setState('连接失败：' + (e && e.message || e), 'err');
                var box = $('ndTree');
                if (box) box.innerHTML = '<div class="hint" style="padding:10px;color:#f6a1b1;">' +
                    esc((e && e.message) || '连接失败') + '</div>';
            });
        } else {
            renderTree();
            if (curDir) renderFiles(curDir);
        }
    };

    boot();
})();
