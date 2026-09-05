// vh-Atelier 板块三.4：音乐库（Resonic 式本地音乐浏览器）
// 布局：左文件夹树(逐层展开) + 右列表(带波形) + 底部统一播放条
// 交互：点波形/行从指针处播放（Resonic 逻辑）；双击插入时间线；拖拽到 PR；点歌名导入素材箱
// 性能：目录结构缓存 + 波形 peaks 本地索引缓存（避免重复解码整曲）
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var collectDir = path.join(extRoot, 'collect');
    var favsFile = path.join(collectDir, 'musiclib_favs.json');
    var treeCacheFile = path.join(collectDir, 'musiclib_tree.json');   // 目录结构+文件列表
    var peaksFile = path.join(collectDir, 'musiclib_peaks.json');      // 波形峰值索引 {path: {dur, peaks, ext, mtime}}

    var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'aif', 'wma'];
    var MAX_FILES = 20000;
    var ITEM_H = 56;          // 须与 CSS .mllib-item height 一致
    var WINDOW_PAD = 10;
    var PEAKS_SAMPLES = 1200;  // 波形峰值采样点数（每条）
    var PEAKS_CACHE_MAX = 600; // peaks 缓存文件数上限（超出丢最旧的，防无限膨胀）

    // ---------- 状态 ----------
    var fileByPath = {};      // fullPath -> file
    var visibleFiles = [];    // 当前目录下过滤后的文件
    var visibleIdx = {};
    var renderedMap = {};
    var favSet = {};
    var playingPath = null;   // 当前播放文件 fullPath
    var curWs = null;         // 当前活动 wavesurfer（只在播放项上建）
    var curWsPath = null;
    var activeItem = null;    // 当前播放对应的行 DOM
    var curDir = '';          // 树当前选中目录（绝对路径）
    var allDirs = [];         // 全部目录树节点 {abs, name, rel, depth, parent}
    var dirChildren = {};     // absDir -> 直接子目录数组
    var dirMusic = {};        // absDir -> 该目录下(仅直接层)音乐文件
    var busy = false;
    var rootDir = '';
    var treeRoot = null;
    var favFilter = false;
    var sortKey = 'ctime';     // ctime/name/mtime/size/type
    var sortAsc = false;       // 默认降序（ctime 降序 = 新创建的在前）

    var el = {
        dir: document.getElementById('mllibDir'),
        browse: document.getElementById('btnMllibBrowse'),
        scan: document.getElementById('btnMllibScan'),
        search: document.getElementById('mllibSearch'),
        sort: document.getElementById('mllibSort'),
        sortDir: document.getElementById('btnMllibSortDir'),
        tree: document.getElementById('mllibTree'),
        list: document.getElementById('mllibList'),
        spacer: document.getElementById('mllibSpacer'),
        empty: document.getElementById('mllibEmpty'),
        count: document.getElementById('mllibCount'),
        status: document.getElementById('mllibStatus'),
        player: document.getElementById('mllibPlayer'),
        playBtn: document.getElementById('btnMlPlay'),
        prevBtn: document.getElementById('btnMlPrev'),
        nextBtn: document.getElementById('btnMlNext'),
        volBtn: document.getElementById('btnMlVol'),
        volSlider: document.getElementById('mlpVol'),
        seek: document.getElementById('mlpSeek'),
        seekFill: document.getElementById('mlpSeekFill'),
        curT: document.getElementById('mlpCur'),
        durT: document.getElementById('mlpDur'),
        pTitle: document.getElementById('mlpTitle'),
        pSub: document.getElementById('mlpSub'),
        ctxMenu: document.getElementById('mllibContextMenu')
    };

    // ================= 基础工具 =================
    function log(msg) {
        try {
            console.log('[vh-musiclib] ' + msg);
            var logFile = path.join(collectDir, 'musiclib.log');
            if (!fs.existsSync(path.dirname(logFile))) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (e) {} }
            fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n', 'utf8');
        } catch (e) {}
    }
    function setStatus(msg, type) {
        if (!el.status) return;
        el.status.textContent = msg || '';
        el.status.className = type || '';
    }
    function formatDur(sec) {
        if (!isFinite(sec) || sec < 0) return '0:00';
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        return m + ':' + (s < 10 ? '0' + s : s);
    }
    function isMusicFile(name) {
        var ext = path.extname(name).replace('.', '').toLowerCase();
        return AUDIO_EXTS.indexOf(ext) >= 0;
    }

    // ================= 收藏 =================
    function loadFavs() {
        try {
            if (fs.existsSync(favsFile)) {
                var arr = JSON.parse(fs.readFileSync(favsFile, 'utf8'));
                if (Array.isArray(arr)) { favSet = {}; arr.forEach(function (p) { favSet[p] = true; }); }
            }
        } catch (e) { favSet = {}; }
    }
    function saveFavs() {
        try {
            if (!fs.existsSync(collectDir)) fs.mkdirSync(collectDir, { recursive: true });
            fs.writeFileSync(favsFile, JSON.stringify(Object.keys(favSet), null, 2), 'utf8');
        } catch (e) { setStatus('收藏保存失败: ' + e.message, 'err'); }
    }
    function isFav(p) { return !!favSet[p]; }
    function toggleFav(p) {
        if (favSet[p]) delete favSet[p]; else favSet[p] = true;
        saveFavs();
    }

    // ================= 扫描构建目录树 =================
    function buildTree(root) {
        var rootNode = { abs: root, name: path.basename(root) || root, depth: 0, children: [], parent: null, dirs: 0, files: 0 };
        var stack = [rootNode];
        while (stack.length) {
            var node = stack.pop();
            var items;
            try { items = fs.readdirSync(node.abs, { withFileTypes: true }); } catch (e) { continue; }
            var music = [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (it.isDirectory()) {
                    var dn = path.join(node.abs, it.name);
                    var child = { abs: dn, name: it.name, depth: node.depth + 1, children: [], parent: node, dirs: 0, files: 0 };
                    node.children.push(child);
                    stack.push(child);
                } else if (it.isFile() && isMusicFile(it.name)) {
                    var fp = path.join(node.abs, it.name);
                    var st = null;
                    try { st = fs.statSync(fp); } catch (e) {}
                    music.push({
                        name: it.name,
                        fullPath: fp,
                        ext: path.extname(it.name).replace('.', '').toLowerCase(),
                        dir: node.abs,
                        ctime: st ? (st.birthtimeMs || st.ctimeMs || 0) : 0,
                        mtime: st ? (st.mtimeMs || 0) : 0,
                        size: st ? (st.size || 0) : 0
                    });
                }
            }
            node.music = music;
            node.files = music.length;
        }
        // 回填 dirs/files 计数
        (function count(n) {
            for (var i = 0; i < n.children.length; i++) { count(n.children[i]); n.dirs += n.children[i].dirs + 1; n.files += n.children[i].files; }
        })(rootNode);
        return rootNode;
    }

    function scanAndCache(dirPath) {
        busy = true;
        setStatus('正在扫描 ' + dirPath + ' ...', '');
        setTimeout(function () {
            try {
                var t0 = Date.now();
                var root = buildTree(dirPath);
                rootDir = dirPath;
                treeRoot = root;
                flattenTree(root);
                // 写缓存 v3：dirs 全量 + music 用 dirs 下标(di)引用父目录，避免重复 6 万次全路径
                // 结构: { v:3, root, dirs:[{a,n,d,p}...], music:[{di,n,c,t,s}...] }  e 由文件名后缀推
                var slim = { v: 3, root: dirPath, dirs: [], music: [] };
                var dirIdx = {};
                allDirs.forEach(function (d, i) {
                    dirIdx[d.abs] = i;
                    slim.dirs.push({ a: d.abs, n: d.name, d: d.depth, p: d.parent ? d.parent.abs : null });
                });
                allDirs.forEach(function (d) {
                    var di = dirIdx[d.abs];
                    (d.music || []).forEach(function (m) {
                        slim.music.push({ di: di, n: m.name, c: Math.round(m.ctime || 0), t: Math.round(m.mtime || 0), s: m.size || 0 });
                    });
                });
                try {
                    if (!fs.existsSync(collectDir)) fs.mkdirSync(collectDir, { recursive: true });
                    fs.writeFileSync(treeCacheFile, JSON.stringify(slim), 'utf8');
                } catch (e) {}
                log('scan done ' + dirPath + ' dirs=' + allDirs.length + ' music=' + slim.music.length + ' in ' + (Date.now() - t0) + 'ms');
                renderTree();
                // 默认选中根目录
                selectDir(dirPath);
                setStatus('扫描完成：' + allDirs.length + ' 个文件夹，' + slim.music.length + ' 首音乐', 'ok');
            } catch (e) {
                setStatus('扫描出错: ' + e.message, 'err');
                log('scan error ' + e.message);
            }
            busy = false;
        }, 30);
    }

    function loadTreeCache(dirPath) {
        try {
            if (!fs.existsSync(treeCacheFile)) return false;
            var c = JSON.parse(fs.readFileSync(treeCacheFile, 'utf8'));
            if (!c || c.v !== 3 || c.root !== dirPath || !Array.isArray(c.dirs)) return false;
            // 重建树节点
            var nodeByAbs = {};
            var rootNode = null;
            c.dirs.forEach(function (d) {
                var n = { abs: d.a, name: d.n, depth: d.d, parent: null, children: [], music: [], dirs: 0, files: 0 };
                nodeByAbs[d.a] = n;
                if (!rootNode || d.d === 0) rootNode = n;
            });
            if (!rootNode) return false;
            // 重建父子
            c.dirs.forEach(function (d) {
                var n = nodeByAbs[d.a];
                if (d.p && nodeByAbs[d.p]) { n.parent = nodeByAbs[d.p]; nodeByAbs[d.p].children.push(n); }
            });
            // 挂音乐：music.di 是 dirs 数组下标（v3），父目录 = c.dirs[di].a
            var byPath = {};
            c.music.forEach(function (m) {
                var dd = c.dirs[m.di];
                if (!dd) return;
                var n = nodeByAbs[dd.a];
                if (!n) return;
                var full = path.join(dd.a, m.n);
                var f = { name: m.n, fullPath: full, ext: path.extname(m.n).replace('.', '').toLowerCase(), dir: dd.a, ctime: m.c || 0, mtime: m.t || 0, size: m.s || 0 };
                if (!n.music) n.music = [];
                n.music.push(f);
                byPath[full] = f;
            });
            // 计数
            (function count(n) {
                n.files = (n.music || []).length;
                for (var i = 0; i < n.children.length; i++) { count(n.children[i]); n.dirs += n.children[i].dirs + 1; n.files += n.children[i].files; }
            })(rootNode);
            // 检查根目录还在
            if (!fs.existsSync(rootNode.abs)) return false;
            rootDir = dirPath;
            treeRoot = rootNode;
            flattenTree(rootNode);
            return true;
        } catch (e) { return false; }
    }

    function flattenTree(root) {
        allDirs = [];
        dirChildren = {};
        (function walk(n) {
            allDirs.push(n);
            if (!dirChildren[n.abs]) dirChildren[n.abs] = [];
            n.children.forEach(function (c) { dirChildren[n.abs].push(c); walk(c); });
        })(root);
    }

    // ================= 文件夹树渲染 =================
    function renderTree() {
        el.tree.innerHTML = '';
        if (!treeRoot) return;
        (function walk(n) {
            var row = document.createElement('div');
            row.className = 'tnode';
            row.style.paddingLeft = (6 + n.depth * 14) + 'px';
            var hasKids = n.children.length > 0;
            var caret = document.createElement('span');
            caret.className = 'caret';
            caret.textContent = hasKids ? '▶' : '';
            var ico = document.createElement('span');
            ico.className = 'tico';
            ico.textContent = n.depth === 0 ? '📀' : (hasKids ? '📁' : '📂');
            var lbl = document.createElement('span');
            lbl.className = 'tlabel';
            lbl.textContent = n.depth === 0 ? (path.basename(n.abs) || n.abs) : n.name;
            lbl.title = n.abs;
            var cnt = document.createElement('span');
            cnt.className = 'tcnt';
            cnt.textContent = n.files > 0 ? String(n.files) : '';
            row.appendChild(caret); row.appendChild(ico); row.appendChild(lbl); row.appendChild(cnt);
            row.__node = n;
            // 行点击：选中目录并自动展开其子层；若点在 caret 上则只切换展开/收起
            row.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (ev.target && ev.target.classList && ev.target.classList.contains('caret')) {
                    n.__open = !n.__open;
                    collapseRender();
                    return;
                }
                // 选中 + 若含子目录且未展开则展开一层
                if (n.children.length && !n.__open) n.__open = true;
                collapseRender();
                selectDir(n.abs);
            });
            el.tree.appendChild(row);
            n.children.forEach(walk);
        })(treeRoot);
        collapseRender();
    }

    function collapseRender() {
        if (!treeRoot) return;
        if (treeRoot.__open !== false) treeRoot.__open = true;
        var rows = Array.prototype.slice.call(el.tree.querySelectorAll('.tnode'));
        rows.forEach(function (r) {
            var n = r.__node;
            if (!n) return;
            var show = true;
            var p = n.parent;
            while (p) { if (!p.__open) { show = false; break; } p = p.parent; }
            r.style.display = show ? '' : 'none';
            var caret = r.querySelector('.caret');
            if (caret) caret.textContent = (n.children.length && n.__open) ? '▼' : (n.children.length ? '▶' : '');
            r.classList.toggle('sel', show && n.abs === curDir);
        });
    }

    // ================= 目录选择 =================
    function selectDir(abs) {
        if (!abs) return;
        curDir = abs;
        // 展开祖先
        var n = findNode(abs);
        if (n) { var p = n.parent; while (p) { p.__open = true; p = p.parent; } }
        collapseRender();
        // 载入该目录音乐（直接层），并确保 fileByPath 有当前层数据供 ensureWave 查
        var files = [];
        if (n) {
            files = (n.music || []).slice();
            files.forEach(function (m) { fileByPath[m.fullPath] = m; });
        }
        visibleDirFiles = files;
        setVisibleFiles(currentFiltered(files));
    }

    var visibleDirFiles = [];

    function findNode(abs) {
        if (!treeRoot) return null;
        var out = null;
        (function w(n) { if (n.abs === abs) { out = n; return; } for (var i = 0; i < n.children.length && !out; i++) w(n.children[i]); })(treeRoot);
        return out;
    }

    // ================= 列表过滤 =================
    function sortFiles(files) {
        var key = sortKey;
        var dirMul = sortAsc ? 1 : -1;
        files = files.slice().sort(function (a, b) {
            var r = 0;
            if (key === 'name') {
                r = a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
            } else if (key === 'type') {
                r = (a.ext < b.ext ? -1 : (a.ext > b.ext ? 1 : 0)) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
            } else {
                var va = key === 'size' ? (a.size || 0) : (a.ctime || a.mtime || 0);
                var vb = key === 'size' ? (b.size || 0) : (b.ctime || b.mtime || 0);
                if (key === 'mtime') { va = a.mtime || 0; vb = b.mtime || 0; }
                r = (va < vb) ? -1 : (va > vb ? 1 : 0);
                if (r === 0) r = a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
            }
            return r * dirMul;
        });
        return files;
    }

    function currentFiltered(files) {
        var kw = el.search.value.trim().toLowerCase();
        if (favFilter) files = files.filter(function (f) { return isFav(f.fullPath); });
        if (kw) files = files.filter(function (f) {
            var base = path.basename(f.name, path.extname(f.name)).toLowerCase();
            return base.indexOf(kw) >= 0;
        });
        return sortFiles(files);
    }

    function syncSortUI() {
        if (el.sort) el.sort.value = sortKey;
        if (el.sortDir) {
            var labels = { ctime: '新→旧', mtime: '新→旧', size: '大→小', name: 'A→Z', type: 'A→Z' };
            var ascLabels = { ctime: '旧→新', mtime: '旧→新', size: '小→大', name: 'Z→A', type: 'Z→A' };
            el.sortDir.textContent = (sortAsc ? '↑ ' : '↓ ') + (sortAsc ? (ascLabels[sortKey] || '升序') : (labels[sortKey] || '降序'));
        }
    }

    // ================= 虚拟列表 =================
    function setVisibleFiles(list) {
        visibleFiles = list;
        visibleIdx = {};
        visibleFiles.forEach(function (f, i) { visibleIdx[f.fullPath] = i; });
        unmountAll();
        el.spacer.style.height = (visibleFiles.length * ITEM_H) + 'px';
        el.empty.style.display = visibleFiles.length === 0 ? '' : 'none';
        el.empty.textContent = '该目录下没有音乐' + (el.search.value.trim() ? '（且无匹配）' : '');
        el.count.textContent = (visibleFiles.length ? '显示 ' + visibleFiles.length + ' 首' : '');
        el.list.scrollTop = 0;
        renderWindow();
    }
    function renderWindow() {
        var st = el.list.scrollTop;
        var viewH = el.list.clientHeight || 300;
        var start = Math.max(0, Math.floor(st / ITEM_H) - WINDOW_PAD);
        var end = Math.min(visibleFiles.length, Math.ceil((st + viewH) / ITEM_H) + WINDOW_PAD);
        Object.keys(renderedMap).forEach(function (p) {
            var idx = visibleIdx[p];
            if (idx === undefined || idx < start || idx >= end) unmountItem(p);
        });
        for (var i = start; i < end; i++) {
            var f = visibleFiles[i];
            if (!renderedMap[f.fullPath]) mountItem(f, i);
        }
    }
    function mountItem(f, idx) {
        var item;
        try {
            item = buildItem(f);
        } catch (e) {
            log('buildItem 失败 ' + f.fullPath + ': ' + e.message);
            return;
        }
        item.style.top = (idx * ITEM_H) + 'px';
        el.list.appendChild(item);
        renderedMap[f.fullPath] = item;
        item.__idx = idx;
        try { ensureWave(item); } catch (e) { log('ensureWave 失败: ' + e.message); }
    }
    function unmountItem(p) {
        // 正在播放的行保持挂载（播放不中断，行 pin 在视口内）
        if (playingPath === p) return;
        var item = renderedMap[p];
        if (!item) return;
        if (item.__ws) { try { item.__ws.destroy(); } catch (e) {} item.__ws = null; }
        item.__waveDone = false;
        item.__wsReady = false;
        if (item.parentNode) item.parentNode.removeChild(item);
        delete renderedMap[p];
    }
    function unmountAll() {
        // 换目录/刷新列表：统一停播（播放行随列表重建，避免悬空 ws）
        stopPlayback();
        Object.keys(renderedMap).forEach(function (p) {
            var item = renderedMap[p];
            if (!item) return;
            if (item.__ws) { try { item.__ws.destroy(); } catch (e) {} }
            if (item.parentNode) item.parentNode.removeChild(item);
        });
        renderedMap = {};
    }

    // ================= 行构建 =================
    function buildItem(f) {
        var item = document.createElement('div');
        item.className = 'mllib-item' + (playingPath === f.fullPath ? ' playing' : '');
        item.dataset.path = f.fullPath;
        item.draggable = true;

        var playBtn = document.createElement('button');
        playBtn.className = 'playbtn';
        playBtn.textContent = (playingPath === f.fullPath && curPlaying() ? '⏸' : '▶');
        playBtn.title = '播放 / 暂停';
        playBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (playingPath === f.fullPath && curPlaying()) { pausePlayback(); }
            else playFrom(f, 0);
        });

        var waveEl = document.createElement('div');
        waveEl.className = 'wave';

        var nm = document.createElement('button');
        nm.className = 'nm';
        nm.textContent = f.name;
        nm.title = '导入 PR「音乐」素材箱';
        nm.addEventListener('click', function (ev) {
            ev.stopPropagation();
            importToBin(f);
        });

        var dur = document.createElement('span');
        dur.className = 'dur';
        dur.textContent = '';

        var ext = document.createElement('span');
        ext.className = 'ext';
        ext.textContent = f.ext.toUpperCase();

        var star = document.createElement('span');
        star.className = 'star' + (isFav(f.fullPath) ? ' on' : '');
        star.textContent = isFav(f.fullPath) ? '★' : '☆';
        star.title = '收藏 / 取消收藏';
        star.addEventListener('click', function (ev) {
            ev.stopPropagation();
            toggleFav(f.fullPath);
            star.className = 'star' + (isFav(f.fullPath) ? ' on' : '');
            star.textContent = isFav(f.fullPath) ? '★' : '☆';
            if (favFilter) setVisibleFiles(currentFiltered(visibleDirFiles));
        });

        item.appendChild(playBtn);
        item.appendChild(waveEl);
        item.appendChild(nm);
        item.appendChild(dur);
        item.appendChild(ext);
        item.appendChild(star);

        // 点击行（非按钮/波形）→ 播放
        item.addEventListener('click', function (ev) {
            var t = ev.target;
            if (t.closest && (t.closest('.nm') || t.closest('.playbtn') || t.closest('.star') || t.closest('.wave'))) return;
            playFrom(f, 0);
        });
        // 双击非控件 → 插入时间线
        item.addEventListener('dblclick', function (ev) {
            var t = ev.target;
            if (t.closest && (t.closest('.nm') || t.closest('.playbtn') || t.closest('.star') || t.closest('.wave'))) return;
            insertToTimeline(f);
        });

        // 拖拽到 PR
        item.addEventListener('dragstart', function (ev) {
            ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', f.fullPath);
            ev.dataTransfer.setData('text/plain', f.fullPath);
            ev.dataTransfer.effectAllowed = 'copy';
        });

        // 右键菜单
        item.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            showContextMenu(ev, f);
        });

        return item;
    }

    // ================= 波形（点波形从指针处播放） =================
    function ensureWave(item) {
        if (item.__waveDone) return;
        item.__waveDone = true;
        var f = fileByPath[item.dataset.path];
        if (!f) return;
        if (item.__ws) return;
        var waveEl = item.querySelector('.wave');
        var ws = null;
        try {
            if (typeof WaveSurfer === 'undefined') throw new Error('wavesurfer 未加载');
            ws = WaveSurfer.create({
                container: waveEl,
                waveColor: '#4d8f6a',
                progressColor: '#7fd68b',
                cursorColor: '#cfe9d8',
                height: 40,
                barWidth: 1,
                barGap: 1,
                barMinHeight: 1,
                cursorWidth: 1,
                interact: false,   // 点击统一走我们的 handler
                hideScrollbar: true,
                fillParent: true
            });
        } catch (e) {
            waveEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">波形不可用</span>';
            return;
        }
        item.__ws = ws;
        // ready：唯一监听，负责 UI + 缓存 peaks
        ws.on('ready', function () {
            item.__wsReady = true;
            var d = ws.getDuration();
            var durEl = item.querySelector('.dur');
            if (durEl && isFinite(d)) durEl.textContent = formatDur(d);
            if (playingPath === f.fullPath) setProgressUI();
            // 解码后写缓存（若是缓存加载则 no-op；loadBlob 才会触发 ready 后 exportPeaks）
            if (!ws.__peaksCached) {
                try {
                    var pk = ws.exportPeaks ? ws.exportPeaks() : null;
                    if (pk && pk.length) cachePeaks(f.fullPath, d, pk[0] || pk);
                    ws.__peaksCached = true;
                } catch (e) {}
            }
        });
        ws.on('finish', function () {
            if (playingPath === f.fullPath) onTrackEnd();
        });

        // 波形容器点击：seek 并播放（Resonic：点哪从哪播）
        waveEl.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var rect = waveEl.getBoundingClientRect();
            if (!rect.width) return;
            var ratio = (ev.clientX - rect.left) / rect.width;
            if (ratio < 0) ratio = 0; if (ratio > 1) ratio = 1;
            if (item.__wsReady && item.__ws) {
                var d = item.__ws.getDuration() || 0;
                item.__ws.seekTo(ratio);
                playFrom(f, ratio * d);
            } else {
                ensureReady(f, function (ws) {
                    curWs = ws;
                    curWsPath = f.fullPath;
                    playingPath = f.fullPath;
                    activeItem = item;
                    try {
                        var d2 = ws.getDuration() || 0;
                        ws.seekTo(ratio);
                        ws.play();
                    } catch (e) {}
                    syncPlayUI(f);
                });
            }
        });

        // 从缓存 peaks 加载（快）或解码
        var cachedPeaks = getPeaksCache(f.fullPath);
        if (cachedPeaks) {
            try {
                ws.load('file:///' + f.fullPath.replace(/\\/g, '/'), cachedPeaks.peaks, false);
                ws.__peaksCached = true;
                var durEl = item.querySelector('.dur');
                if (durEl && cachedPeaks.dur) durEl.textContent = formatDur(cachedPeaks.dur);
            } catch (e) { loadDecode(ws, waveEl, f); }
        } else {
            loadDecode(ws, waveEl, f);
        }
    }

    function loadDecode(ws, waveEl, f) {
        readAsBlob(f.fullPath, function (err, blob) {
            if (err) {
                waveEl.innerHTML = '<span style="font-size:10px;color:var(--err);">加载失败</span>';
                return;
            }
            try {
                ws.loadBlob(blob, null, false, PEAKS_SAMPLES);
            } catch (e) {}
        });
    }

    // 以 blob 方式读取本地音频文件（file:// XHR）
    function readAsBlob(filePath, cb) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', 'file:///' + filePath.replace(/\\/g, '/'), true);
            xhr.responseType = 'blob';
            xhr.onload = function () {
                if (xhr.status === 0 || xhr.status === 200) cb(null, xhr.response);
                else cb(new Error('读取失败 HTTP ' + xhr.status), null);
            };
            xhr.onerror = function () { cb(new Error('无法读取文件'), null); };
            xhr.send();
        } catch (e) { cb(e, null); }
    }

    // ================= 波形 peaks 本地缓存 =================
    function getPeaksCache(p) {
        try {
            if (!fs.existsSync(peaksFile)) return null;
            var all = JSON.parse(fs.readFileSync(peaksFile, 'utf8'));
            var e = all[p];
            if (!e) return null;
            // mtime 校验：文件变了就失效
            try {
                var st = fs.statSync(p);
                if (Math.floor(st.mtimeMs) !== e.mt) return null;
            } catch (err) { return null; }
            return e;
        } catch (e) { return null; }
    }
    function cachePeaks(p, dur, peaks) {
        try {
            var all = {};
            if (fs.existsSync(peaksFile)) { try { all = JSON.parse(fs.readFileSync(peaksFile, 'utf8')); } catch (e) { all = {}; } }
            var st;
            try { st = fs.statSync(p); } catch (e) { return; }
            // 简单 LRU：超限时清掉一半旧条目
            var keys = Object.keys(all);
            if (keys.length > PEAKS_CACHE_MAX) {
                var half = Math.floor(keys.length / 2);
                var sorted = keys.slice().sort(function (a, b) { return (all[a].t || 0) - (all[b].t || 0); });
                for (var i = 0; i < half; i++) delete all[sorted[i]];
            }
            all[p] = { dur: dur, peaks: peaks, mt: Math.floor(st.mtimeMs), t: Date.now() };
            if (!fs.existsSync(collectDir)) fs.mkdirSync(collectDir, { recursive: true });
            fs.writeFileSync(peaksFile, JSON.stringify(all), 'utf8');
        } catch (e) {}
    }

    // ================= 统一播放 =================
    function curPlaying() { return curWs && curWs.isPlaying && curWs.isPlaying(); }

    // 行就绪检查：返回该行已 ready 的 ws（未建则先 ensureWave）
    function ensureReady(f, cb) {
        var item = renderedMap[f.fullPath];
        if (item && item.__ws && item.__wsReady) { cb && cb(item.__ws); return; }
        if (item) {
            if (!item.__ws) ensureWave(item);
            var tries = 0;
            var w = setInterval(function () {
                tries++;
                if (item.__wsReady) { clearInterval(w); cb && cb(item.__ws); return; }
                if (tries > 150) { clearInterval(w); setStatus('音频加载超时', 'err'); }
            }, 80);
        } else {
            setStatus('该行未在列表中', 'err');
        }
    }

    function playFrom(f, sec) {
        var item = renderedMap[f.fullPath];
        // 已在播同文件 → seek 续播
        if (playingPath === f.fullPath && curWs && item && item.__ws === curWs) {
            try {
                var dd = curWs.getDuration() || 1;
                curWs.seekTo(Math.min(1, Math.max(0, (sec || 0) / dd)));
                curWs.play();
            } catch (e) {}
            syncPlayUI(f);
            return;
        }
        stopPlayback();
        ensureReady(f, function (ws) {
            curWs = ws;
            curWsPath = f.fullPath;
            playingPath = f.fullPath;
            activeItem = item || renderedMap[f.fullPath] || null;
            try {
                applyVolume();
                var d = curWs.getDuration() || 1;
                curWs.seekTo(Math.min(1, Math.max(0, (sec || 0) / d)));
                curWs.play();
            } catch (e) {}
            syncPlayUI(f);
            setProgressUI();
        });
    }

    function applyVolume() {
        if (!curWs) return;
        try {
            var v = parseFloat(el.volSlider.value);
            if (!isFinite(v)) v = 0.8;
            curWs.setVolume(v);
        } catch (e) {}
    }

    function stopPlayback() {
        if (curWs) { try { curWs.pause(); curWs.seekTo(0); } catch (e) {} }
        curWs = null;
        curWsPath = null;
        playingPath = null;
        activeItem = null;
        updatePlayStates();
        setPlayerUI();
    }
    function pausePlayback() {
        if (curWs) { try { curWs.pause(); } catch (e) {} }
        updatePlayStates();
        setPlayerUI();
    }

    function syncPlayUI(f) {
        playingPath = f.fullPath;
        activeItem = renderedMap[f.fullPath] || null;
        el.player.style.display = '';
        el.pTitle.textContent = f.name;
        el.pSub.textContent = f.dir + ' · ' + f.ext.toUpperCase();
        updatePlayStates();
        setPlayerUI();
        setProgressUI();
    }

    function onTrackEnd() {
        // 播完自动下一首（在当前可见列表内）
        var idx = visibleIdx[playingPath];
        if (idx !== undefined && idx < visibleFiles.length - 1) {
            var nx = visibleFiles[idx + 1];
            playFrom(nx, 0);
        } else {
            stopPlayback();
        }
    }

    function updatePlayStates() {
        Object.keys(renderedMap).forEach(function (p) {
            var item = renderedMap[p];
            if (!item) return;
            var on = playingPath === p && curPlaying();
            item.classList.toggle('playing', !!on);
            var b = item.querySelector('.playbtn');
            if (b) b.textContent = on ? '⏸' : '▶';
        });
        // 播放条按钮图标
        var playing = curPlaying();
        var icp = el.playBtn && el.playBtn.querySelector('.ic-play');
        var icp2 = el.playBtn && el.playBtn.querySelector('.ic-pause');
        if (icp) icp.style.display = playing ? 'none' : '';
        if (icp2) icp2.style.display = playing ? '' : 'none';
    }

    // ================= 播放条 UI =================
    var seekDrag = false;
    function setPlayerUI() {
        if (!el.player) return;
        var active = playingPath && curWs;
        el.player.style.display = active ? '' : 'none';
    }
    function setProgressUI() {
        if (!curWs || !playingPath) return;
        var d = curWs.getDuration() || 0;
        var t = curWs.getCurrentTime ? curWs.getCurrentTime() : 0;
        if (el.curT) el.curT.textContent = formatDur(t);
        if (el.durT) el.durT.textContent = formatDur(d);
        if (el.seekFill) el.seekFill.style.width = (d > 0 ? (t / d * 100) : 0) + '%';
        // 行内播放进度
        var item = activeItem || renderedMap[playingPath];
        if (item && item.__ws && item.__ws !== curWs) { /* noop */ }
    }
    function startProgressTick() {
        clearInterval(progressTimer);
        progressTimer = setInterval(function () {
            if (playingPath && curWs && curPlaying()) setProgressUI();
        }, 250);
    }
    var progressTimer = null;

    function nextTrack(dir) {
        if (!visibleFiles.length) return;
        var idx = playingPath ? visibleIdx[playingPath] : -1;
        if (idx === undefined || idx < 0) idx = -1;
        var ni = idx + dir;
        if (ni < 0) ni = visibleFiles.length - 1;
        if (ni >= visibleFiles.length) ni = 0;
        playFrom(visibleFiles[ni], 0);
    }

    // ================= 导入 PR「音乐」素材箱 =================
    function importToBin(f) {
        if (busy) return;
        busy = true;
        setStatus('正在导入: ' + f.name + ' ...', '');
        csInterface.evalScript('musicImportPayload = ' + JSON.stringify([f.fullPath]) + ';', function () {
            csInterface.evalScript('musicImportToBinStr()', function (result) {
                busy = false;
                try {
                    var data = JSON.parse(result);
                    if (data.ok) setStatus('已导入「音乐」素材箱：' + data.imported.join('、'), 'ok');
                    else setStatus(data.error || '导入失败', 'err');
                } catch (e) { setStatus('导入解析失败: ' + result, 'err'); }
            });
        });
    }

    // ================= 插入时间线 =================
    function insertToTimeline(f) {
        if (busy) return;
        setStatus('正在获取播放头位置...', '');
        csInterface.evalScript('sfxGetPlayerPosition()', function (posResult) {
            var posSec = 0;
            try { var pr = JSON.parse(posResult); posSec = pr.positionSec || 0; } catch (e) {}
            busy = true;
            setStatus('正在插入时间线: ' + f.name + ' @ ' + formatDur(posSec) + ' ...', '');
            csInterface.evalScript('sfxInsertPayload = ' + JSON.stringify({ path: f.fullPath, positionSec: posSec }) + ';', function () {
                csInterface.evalScript('sfxInsertToTimelineStr()', function (result) {
                    busy = false;
                    try {
                        var data = JSON.parse(result);
                        if (data.ok) setStatus('已插入时间线 @ ' + formatDur(data.positionSec) + '（音轨 ' + (data.trackIndex + 1) + '）：' + data.name, 'ok');
                        else setStatus(data.error || '插入失败', 'err');
                    } catch (e) { setStatus('插入解析失败: ' + result, 'err'); }
                });
            });
        });
    }

    // ================= 右键菜单 =================
    function showContextMenu(ev, f) {
        var menu = el.ctxMenu;
        menu.innerHTML = '';
        function addItem(text, fn) {
            var d = document.createElement('div');
            d.className = 'ctx-item';
            d.textContent = text;
            d.addEventListener('click', function () { hideContextMenu(); fn(); });
            menu.appendChild(d);
        }
        addItem('▶ 播放', function () { playFrom(f, 0); });
        addItem('⏱ 插入到时间线（播放头处）', function () { insertToTimeline(f); });
        addItem(isFav(f.fullPath) ? '☆ 取消收藏' : '★ 收藏', function () {
            toggleFav(f.fullPath);
            if (favFilter) setVisibleFiles(currentFiltered(visibleDirFiles));
            else { var it = renderedMap[f.fullPath]; if (it) { var se = it.querySelector('.star'); if (se) { se.className = 'star' + (isFav(f.fullPath) ? ' on' : ''); se.textContent = isFav(f.fullPath) ? '★' : '☆'; } } }
        });
        addItem('📥 导入 PR「音乐」素材箱', function () { importToBin(f); });
        addItem('在资源管理器中显示', function () {
            setStatus('正在打开资源管理器...', '');
            try { childProcess.spawn('explorer.exe', ['/select,' + f.fullPath]); } catch (e) { setStatus('打开资源管理器失败: ' + e.message, 'err'); }
        });
        var sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep);
        var pathItem = document.createElement('div');
        pathItem.className = 'ctx-item';
        pathItem.style.cssText = 'color:var(--muted);cursor:default;font-size:10px;white-space:normal;word-break:break-all;';
        pathItem.textContent = f.fullPath;
        menu.appendChild(pathItem);
        menu.style.display = 'block';
        var mw = menu.offsetWidth, mh = menu.offsetHeight;
        var x = ev.clientX, y = ev.clientY;
        if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
        if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
        menu.style.left = x + 'px'; menu.style.top = y + 'px';
    }
    function hideContextMenu() { el.ctxMenu.style.display = 'none'; }

    // ================= 浏览目录 =================
    function browseDir() {
        if (busy) return;
        var initial = el.dir.value.trim();
        if (!initial) { try { initial = localStorage.getItem('mllibDir') || ''; } catch (e) {} }
        setStatus('正在打开文件夹选择器...', '');
        var result;
        try { result = window.cep.fs.showOpenDialogEx(true, true, '选择音乐文件夹', initial, []); }
        catch (e) { setStatus('打开对话框失败: ' + e.message, 'err'); return; }
        if (!result) { setStatus('', ''); return; }
        if (result.err && result.err !== 0) { setStatus('打开对话框失败: ' + result.err, 'err'); return; }
        var chosen = (result.data && result.data.length) ? result.data[0] : null;
        if (!chosen) { setStatus('', ''); return; }
        el.dir.value = chosen;
        try { localStorage.setItem('mllibDir', chosen); } catch (e) {}
        setStatus('已选择目录: ' + chosen, 'ok');
        doLoad(chosen, true);
    }

    // ================= 加载入口（缓存优先） =================
    function doLoad(dirPath, forceScan) {
        if (!dirPath || busy) return;
        rootDir = dirPath;
        try { localStorage.setItem('mllibDir', dirPath); } catch (e) {}
        el.dir.value = dirPath;
        if (!fs.existsSync(dirPath)) { setStatus('目录不存在: ' + dirPath, 'err'); return; }

        // 尝试缓存
        if (!forceScan && loadTreeCache(dirPath)) {
            renderTree();
            selectDir(dirPath);
            setStatus('已加载缓存，后台刷新中...', 'ok');
            setTimeout(function () { scanAndCache(dirPath); }, 100);
            return;
        }
        scanAndCache(dirPath);
    }

    // ================= 事件 =================
    function bindEvents() {
        el.browse.addEventListener('click', browseDir);
        el.scan.addEventListener('click', function () {
            var d = el.dir.value.trim();
            if (!d) { setStatus('请先输入或浏览选择音乐目录', 'warn'); return; }
            doLoad(d, true);
        });
        el.search.addEventListener('input', function () {
            setVisibleFiles(currentFiltered(visibleDirFiles));
        });
        el.list.addEventListener('scroll', renderWindow);

        // 排序控件
        if (el.sort) el.sort.addEventListener('change', function () {
            sortKey = el.sort.value;
            try { localStorage.setItem('mllibSort', sortKey); } catch (e) {}
            syncSortUI();
            setVisibleFiles(currentFiltered(visibleDirFiles));
        });
        if (el.sortDir) el.sortDir.addEventListener('click', function () {
            sortAsc = !sortAsc;
            try { localStorage.setItem('mllibSortAsc', sortAsc ? '1' : '0'); } catch (e) {}
            syncSortUI();
            setVisibleFiles(currentFiltered(visibleDirFiles));
        });

        // 播放条按钮
        el.playBtn.addEventListener('click', function () {
            if (curPlaying()) pausePlayback();
            else if (playingPath && curWs) { try { curWs.play(); } catch (e) {} updatePlayStates(); }
            else if (visibleFiles.length) playFrom(visibleFiles[0], 0);
        });
        el.prevBtn.addEventListener('click', function () { nextTrack(-1); });
        el.nextBtn.addEventListener('click', function () { nextTrack(1); });
        // 进度条点击 seek
        el.seek.addEventListener('click', function (ev) {
            if (!curWs) return;
            var rect = el.seek.getBoundingClientRect();
            if (!rect.width) return;
            var ratio = (ev.clientX - rect.left) / rect.width;
            if (ratio < 0) ratio = 0; if (ratio > 1) ratio = 1;
            var d = curWs.getDuration() || 1;
            curWs.seekTo(ratio);
            if (!curPlaying()) { try { curWs.play(); } catch (e) {} updatePlayStates(); }
            setProgressUI();
        });
        // 音量
        el.volSlider.addEventListener('input', function () {
            var v = parseFloat(el.volSlider.value) || 0.8;
            if (curWs) { try { curWs.setVolume(v); } catch (e) {} }
        });
        el.volBtn.addEventListener('click', function () {
            var muted = curWs && curWs.getMuted && curWs.getMuted();
            var toMute = !muted;
            if (curWs) { try { curWs.setMute(toMute); } catch (e) {} }
            var iconOn = el.volBtn.querySelector('.ic-vol-on');
            var iconOff = el.volBtn.querySelector('.ic-vol-off');
            if (iconOn) iconOn.style.display = toMute ? 'none' : '';
            if (iconOff) iconOff.style.display = toMute ? '' : 'none';
        });

        // Esc 关右键菜单
        document.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') hideContextMenu();
        });
        document.addEventListener('click', function (ev) {
            if (el.ctxMenu.style.display === 'block' && !el.ctxMenu.contains(ev.target)) hideContextMenu();
        });

        // 切到音乐库 tab 自动聚焦搜索
        var libTab = document.querySelector('.tab[data-tab="musiclib"]');
        if (libTab) libTab.addEventListener('click', function () { setTimeout(function () { try { el.search.focus(); } catch (e) {} }, 60); });
    }

    // ================= 初始化 =================
    loadFavs();
    bindEvents();
    startProgressTick();
    // 恢复排序偏好（默认：创建时间 新→旧）
    try {
        var sk = localStorage.getItem('mllibSort');
        if (sk && ['ctime', 'name', 'mtime', 'size', 'type'].indexOf(sk) >= 0) sortKey = sk;
        var sa = localStorage.getItem('mllibSortAsc');
        sortAsc = sa === '1';
        syncSortUI();
    } catch (e) {}
    try {
        var savedDir = localStorage.getItem('mllibDir');
        if (savedDir && fs.existsSync(savedDir)) {
            el.dir.value = savedDir;
            doLoad(savedDir, false);
        }
    } catch (e) {}

    // ================= 增量写入（供外部：网易云下载后把新文件塞进音乐库索引） =================
    // 不重扫全量：只把新增文件挂进内存树 + 追加到磁盘缓存。
    // files: [{ path: 绝对路径 }]
    window.__musiclibAddFiles = function (files) {
        try {
            if (!files || !files.length) return;
            var list = Array.isArray(files) ? files : [files];
            // 确保树已就绪：优先用当前 treeRoot；没加载则尝试 loadTreeCache；仍无则忽略（用户下次扫全量会带上）
            if (!treeRoot) {
                var saved = '';
                try { saved = localStorage.getItem('mllibDir') || ''; } catch (e) {}
                if (saved && fs.existsSync(saved)) {
                    if (!loadTreeCache(saved)) return; // 缓存也失效，等用户手动全扫
                } else {
                    return;
                }
            }
            var root = treeRoot;
            if (!root || !fs.existsSync(root.abs)) return;
            var addedAny = false;
            list.forEach(function (item) {
                var fp = item && item.path;
                if (!fp || !fs.existsSync(fp)) return;
                // 已在树中则跳过
                if (fileByPath[fp]) return;
                var dirAbs = path.dirname(fp);
                if (dirAbs.indexOf(root.abs) !== 0) return; // 不在音乐库根下
                var node = findNode(dirAbs);
                if (!node) {
                    // 目标目录可能不存在（子目录新建）——按相对根路径逐级建节点
                    var rel = path.relative(root.abs, dirAbs);
                    if (!rel || rel.indexOf('..') === 0) return;
                    var parts = rel.split(path.sep);
                    var cur = root;
                    var ok = true;
                    for (var pi = 0; pi < parts.length; pi++) {
                        var seg = parts[pi];
                        var next = null;
                        for (var ci = 0; ci < cur.children.length; ci++) {
                            if (cur.children[ci].name === seg) { next = cur.children[ci]; break; }
                        }
                        if (!next) {
                            var nabs = path.join(cur.abs, seg);
                            if (!fs.existsSync(nabs)) { ok = false; break; }
                            next = { abs: nabs, name: seg, depth: cur.depth + 1, children: [], parent: cur, music: [], dirs: 0, files: 0 };
                            cur.children.push(next);
                            if (!dirChildren[cur.abs]) dirChildren[cur.abs] = [];
                            dirChildren[cur.abs].push(next);
                            allDirs.push(next);
                        }
                        cur = next;
                    }
                    if (!ok) return;
                    node = cur;
                }
                var st = null;
                try { st = fs.statSync(fp); } catch (e) { return; }
                var mf = {
                    name: path.basename(fp),
                    fullPath: fp,
                    ext: path.extname(fp).replace('.', '').toLowerCase(),
                    dir: node.abs,
                    ctime: st ? (st.birthtimeMs || st.ctimeMs || 0) : 0,
                    mtime: st ? (st.mtimeMs || 0) : 0,
                    size: st ? (st.size || 0) : 0
                };
                if (!node.music) node.music = [];
                node.music.push(mf);
                fileByPath[fp] = mf;
                addedAny = true;
            });
            if (!addedAny) return;
            // 重算计数
            (function recount(n) {
                n.files = (n.music || []).length;
                n.dirs = 0;
                for (var i2 = 0; i2 < n.children.length; i2++) { recount(n.children[i2]); n.dirs += n.children[i2].dirs + 1; n.files += n.children[i2].files; }
            })(root);
            // 若正在浏览受影响的目录，刷新列表（新歌按当前排序可见）
            var curNode = curDir ? findNode(curDir) : null;
            if (curNode) {
                var cf = (curNode.music || []).slice();
                cf.forEach(function (mm) { fileByPath[mm.fullPath] = mm; });
                visibleDirFiles = cf;
                setVisibleFiles(currentFiltered(cf));
            }
            // 刷新树（保留展开状态：__open 存在节点上，renderTree 不重置它们，但 collapseRender 依赖 __open，重建 row 无妨）
            renderTree();
            // 增量写盘缓存：读现有 v3，追加上层新目录与音乐条目
            try {
                if (!fs.existsSync(collectDir)) fs.mkdirSync(collectDir, { recursive: true });
                if (fs.existsSync(treeCacheFile)) {
                    var slim = JSON.parse(fs.readFileSync(treeCacheFile, 'utf8'));
                    if (slim && slim.v === 3 && slim.root === root.abs) {
                        var dirIdx = {};
                        slim.dirs.forEach(function (d, i) { dirIdx[d.a] = i; });
                        // 新目录补齐
                        var added = false;
                        allDirs.forEach(function (d) {
                            if (dirIdx[d.abs] === undefined) {
                                dirIdx[d.abs] = slim.dirs.length;
                                slim.dirs.push({ a: d.abs, n: d.name, d: d.depth, p: d.parent ? d.parent.abs : null });
                                added = true;
                            }
                        });
                        list.forEach(function (item) {
                            var fp2 = item && item.path;
                            if (!fp2 || !fileByPath[fp2]) return;
                            var dir2 = path.dirname(fp2);
                            var di = dirIdx[dir2];
                            if (di === undefined) return;
                            var m2 = fileByPath[fp2];
                            slim.music.push({ di: di, n: m2.name, c: Math.round(m2.ctime || 0), t: Math.round(m2.mtime || 0), s: m2.size || 0 });
                        });
                        if (added || true) {
                            fs.writeFileSync(treeCacheFile, JSON.stringify(slim), 'utf8');
                        }
                    }
                }
            } catch (e) { log('增量写盘失败: ' + e.message); }
            log('musiclib 增量写入 ' + list.length + ' 首');
        } catch (e) {
            log('musiclibAddFiles 错误: ' + e.message);
        }
    };
})();
