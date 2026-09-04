// vh-Atelier 板块三.4：音乐库（本地音乐整轨浏览器）
// 定位：Resonic 式本地音乐库。绑定目录 → 虚拟列表 + 大波形 → 点播/拖拽/插入时间线
// 与音效库区别：行更高、波形更宽（音乐重波形预览与入点），插入到时间线播放头处
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var collectDir = path.join(extRoot, 'collect');
    var favsFile = path.join(collectDir, 'musiclib_favs.json');
    var cacheFile = path.join(collectDir, 'musiclib_index.json');

    var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'aif', 'wma'];
    var MAX_FILES = 20000;
    var ITEM_H = 64;          // 须与 CSS .mllib-item height 一致
    var WINDOW_PAD = 10;

    var allFiles = [];
    var fileByPath = {};
    var visibleFiles = [];
    var visibleIdx = {};
    var renderedMap = {};
    var favSet = {};
    var filterFav = false;
    var savedSubdir = '';
    var playingPath = null;
    var activeWs = null;
    var busy = false;
    var subdirs = [];
    var rootDir = '';

    var el = {
        dir: document.getElementById('mllibDir'),
        browse: document.getElementById('btnMllibBrowse'),
        scan: document.getElementById('btnMllibScan'),
        subdir: document.getElementById('mllibSubdir'),
        search: document.getElementById('mllibSearch'),
        btnAll: document.getElementById('btnMllibAll'),
        btnFav: document.getElementById('btnMllibFav'),
        count: document.getElementById('mllibCount'),
        list: document.getElementById('mllibList'),
        spacer: document.getElementById('mllibSpacer'),
        empty: document.getElementById('mllibEmpty'),
        status: document.getElementById('mllibStatus'),
        ctxMenu: document.getElementById('mllibContextMenu')
    };

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
        if (!isFinite(sec) || sec < 0) return '';
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        return m + ':' + (s < 10 ? '0' + s : s);
    }

    // ---------- 收藏 ----------
    function loadFavs() {
        try {
            if (fs.existsSync(favsFile)) {
                var arr = JSON.parse(fs.readFileSync(favsFile, 'utf8'));
                if (Array.isArray(arr)) {
                    favSet = {};
                    arr.forEach(function (p) { favSet[p] = true; });
                }
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

    // ---------- 索引缓存 ----------
    function loadCache(root) {
        try {
            if (!fs.existsSync(cacheFile)) return null;
            var c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (c.root === root && Array.isArray(c.files)) return c.files;
        } catch (e) {}
        return null;
    }
    function saveCache(root, files) {
        try {
            if (!fs.existsSync(collectDir)) fs.mkdirSync(collectDir, { recursive: true });
            fs.writeFileSync(cacheFile, JSON.stringify({ root: root, files: files, updatedAt: Date.now() }), 'utf8');
        } catch (e) {}
    }

    // ---------- 扫描 ----------
    function scanDir(dirPath, root, out) {
        if (out.length >= MAX_FILES) return;
        var items;
        try { items = fs.readdirSync(dirPath); } catch (e) { return; }
        for (var i = 0; i < items.length; i++) {
            if (out.length >= MAX_FILES) return;
            var item = items[i];
            var full = path.join(dirPath, item);
            var st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (st.isDirectory()) {
                scanDir(full, root, out);
            } else {
                var ext = path.extname(item).replace('.', '').toLowerCase();
                if (AUDIO_EXTS.indexOf(ext) >= 0) {
                    var rel = path.relative(root, dirPath);
                    var topSub = rel ? rel.split(path.sep)[0] : '';
                    out.push({ name: item, dir: dirPath, fullPath: full, ext: ext, topSub: topSub });
                }
            }
        }
    }
    function collectSubdirs(root) {
        var dirs = [];
        try {
            fs.readdirSync(root, { withFileTypes: true }).forEach(function (item) {
                if (item.isDirectory()) dirs.push(item.name);
            });
        } catch (e) {}
        return dirs.sort();
    }
    function renderSubdirs() {
        var cur = el.subdir.value;
        el.subdir.innerHTML = '';
        var allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = '全部';
        el.subdir.appendChild(allOpt);
        subdirs.forEach(function (d) {
            var opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d;
            el.subdir.appendChild(opt);
        });
        var want = cur || savedSubdir;
        if (want && subdirs.indexOf(want) >= 0) el.subdir.value = want;
        else el.subdir.value = '';
    }

    // ---------- 扫描入口 ----------
    function doScan(useCache) {
        if (busy) return;
        var dirPath = el.dir.value.trim();
        if (!dirPath) { setStatus('请先输入或浏览选择音乐目录', 'warn'); return; }
        if (!fs.existsSync(dirPath)) { setStatus('目录不存在: ' + dirPath, 'err'); return; }
        if (!fs.statSync(dirPath).isDirectory()) { setStatus('路径不是文件夹: ' + dirPath, 'err'); return; }

        rootDir = dirPath;
        try { localStorage.setItem('mllibDir', dirPath); } catch (e) {}

        var cached = useCache ? loadCache(dirPath) : null;
        if (cached && cached.length > 0) {
            applyFiles(cached);
            setStatus('已加载缓存 ' + cached.length + ' 首，后台刷新中...', 'ok');
            setTimeout(function () { fullScan(dirPath); }, 60);
            return;
        }
        fullScan(dirPath);
    }

    function fullScan(dirPath) {
        stopCurrent();
        setStatus('正在扫描 ' + dirPath + ' ...', '');
        var out = [];
        try { scanDir(dirPath, dirPath, out); } catch (e) { setStatus('扫描出错: ' + e.message, 'err'); return; }
        if (out.length >= MAX_FILES) setStatus('文件超过 ' + MAX_FILES + ' 首，只加载前 ' + MAX_FILES + ' 首', 'warn');
        applyFiles(out);
        saveCache(dirPath, out);
        setStatus('扫描完成，找到 ' + out.length + ' 首音乐', 'ok');
    }

    function applyFiles(files) {
        allFiles = files;
        fileByPath = {};
        allFiles.forEach(function (f) { fileByPath[f.fullPath] = f; });
        subdirs = collectSubdirs(rootDir);
        renderSubdirs();
        setVisibleFiles(currentFiltered());
    }

    // ---------- 过滤 ----------
    function currentFiltered() {
        var kw = el.search.value.trim().toLowerCase();
        var sub = el.subdir.value;
        return allFiles.filter(function (f) {
            if (filterFav && !isFav(f.fullPath)) return false;
            if (sub && f.topSub !== sub) return false;
            if (kw) {
                var base = path.basename(f.name, path.extname(f.name)).toLowerCase();
                if (base.indexOf(kw) < 0) return false;
            }
            return true;
        });
    }

    // ---------- 虚拟列表 ----------
    function setVisibleFiles(list) {
        visibleFiles = list;
        visibleIdx = {};
        visibleFiles.forEach(function (f, i) { visibleIdx[f.fullPath] = i; });
        unmountAll();
        el.spacer.style.height = (visibleFiles.length * ITEM_H) + 'px';
        el.empty.style.display = visibleFiles.length === 0 ? '' : 'none';
        el.empty.textContent = allFiles.length === 0 ? '目录下没有音乐文件' : '没有匹配的结果';
        el.count.textContent = '显示 ' + visibleFiles.length + ' / ' + allFiles.length + ' 首';
        el.list.scrollTop = 0;
        renderWindow();
    }
    function renderWindow() {
        var st = el.list.scrollTop;
        var viewH = el.list.clientHeight || 400;
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
        var item = buildItem(f);
        item.style.top = (idx * ITEM_H) + 'px';
        el.list.appendChild(item);
        renderedMap[f.fullPath] = item;
        item.__idx = idx;
        ensureWave(item);
    }
    function unmountItem(p) {
        var item = renderedMap[p];
        if (!item) return;
        if (playingPath === p) stopCurrent();
        if (item.__ws) { try { item.__ws.destroy(); } catch (e) {} item.__ws = null; }
        item.__waveDone = false;
        item.__wsReady = false;
        if (item.parentNode) item.parentNode.removeChild(item);
        delete renderedMap[p];
    }
    function unmountAll() {
        stopCurrent();
        Object.keys(renderedMap).forEach(function (p) {
            var item = renderedMap[p];
            if (item && item.__ws) { try { item.__ws.destroy(); } catch (e) {} }
            if (item && item.parentNode) item.parentNode.removeChild(item);
        });
        renderedMap = {};
    }

    // ---------- 行构建 ----------
    function buildItem(f) {
        var item = document.createElement('div');
        item.className = 'mllib-item';
        item.dataset.path = f.fullPath;
        item.draggable = true;

        var playBtn = document.createElement('button');
        playBtn.className = 'playbtn';
        playBtn.textContent = '▶';
        playBtn.title = '播放 / 暂停';
        playBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            togglePlay(f);
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
            if (filterFav && !isFav(f.fullPath)) setVisibleFiles(currentFiltered());
        });

        item.appendChild(waveEl);
        item.appendChild(nm);
        item.appendChild(playBtn);
        item.appendChild(dur);
        item.appendChild(ext);
        item.appendChild(star);

        // 双击波形/行：插入到时间线播放头处
        item.addEventListener('dblclick', function (ev) {
            var t = ev.target;
            if (t.closest && (t.closest('.nm') || t.closest('.playbtn') || t.closest('.star'))) return;
            ev.preventDefault();
            insertToTimeline(f);
        });

        // 拖拽到 PR：CEP 官方 DnD 数据格式
        item.addEventListener('dragstart', function (ev) {
            var t = ev.target;
            if (t.closest && (t.closest('.wave') || t.closest('.playbtn') || t.closest('.star') || t.closest('.nm'))) {
                ev.preventDefault();
                return;
            }
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

    // ---------- 波形 ----------
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
                waveColor: '#5fce8a',
                progressColor: '#2fae5f',
                cursorColor: '#ffffff',
                height: 46,
                barWidth: 1,
                barGap: 1,
                barMinHeight: 1,
                cursorWidth: 1,
                interact: true,
                hideScrollbar: true
            });
        } catch (e) {
            waveEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">波形不可用</span>';
            return;
        }
        item.__ws = ws;
        ws.on('ready', function () {
            item.__wsReady = true;
            var d = ws.getDuration();
            var durEl = item.querySelector('.dur');
            if (durEl && isFinite(d)) durEl.textContent = formatDur(d);
        });
        ws.on('finish', function () { onPlayEnd(item); });

        readAsBlob(f.fullPath, function (err, blob) {
            if (err) {
                waveEl.innerHTML = '<span style="font-size:10px;color:var(--err);">加载失败</span>';
                return;
            }
            try { ws.loadBlob(blob); } catch (e) {}
        });
    }

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

    // ---------- 播放 ----------
    function togglePlay(f) {
        var item = renderedMap[f.fullPath];
        if (!item) return;
        if (item.__ws && item.__wsReady) {
            if (playingPath === f.fullPath && item.__ws.isPlaying()) {
                item.__ws.pause();
            } else {
                startPlay(f, item);
            }
        } else {
            setStatus('正在加载 ' + f.name + ' ...', '');
            ensureWave(item);
            var wait = setInterval(function () {
                if (item.__wsReady) {
                    clearInterval(wait);
                    startPlay(f, item);
                }
            }, 100);
        }
    }
    function startPlay(f, item) {
        stopCurrent();
        activeWs = item.__ws;
        playingPath = f.fullPath;
        try { item.__ws.play(); } catch (e) {}
        updatePlayState();
    }
    function stopCurrent() {
        if (activeWs) { try { activeWs.pause(); } catch (e) {} }
        playingPath = null;
        activeWs = null;
    }
    function onPlayEnd(item) {
        if (playingPath === item.dataset.path) { playingPath = null; activeWs = null; }
        updatePlayState();
    }
    function updatePlayState() {
        Object.keys(renderedMap).forEach(function (p) {
            var item = renderedMap[p];
            if (!item) return;
            var playing = playingPath === p && item.__ws && item.__ws.isPlaying && item.__ws.isPlaying();
            item.classList.toggle('playing', !!playing);
            var btn = item.querySelector('.playbtn');
            if (btn) btn.textContent = playing ? '⏸' : '▶';
        });
    }

    // ---------- 导入 PR「音乐」素材箱 ----------
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

    // ---------- 插入时间线（到播放头处，插入语义不覆盖） ----------
    function insertToTimeline(f) {
        if (busy) return;
        setStatus('正在获取播放头位置...', '');
        csInterface.evalScript('sfxGetPlayerPosition()', function (posResult) {
            var posSec = 0;
            try {
                var pr = JSON.parse(posResult);
                posSec = pr.positionSec || 0;
            } catch (e) {}
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

    // ---------- 右键菜单 ----------
    function showContextMenu(ev, f) {
        var menu = el.ctxMenu;
        menu.innerHTML = '';

        function addItem(text, fn, danger) {
            var d = document.createElement('div');
            d.className = 'ctx-item';
            d.textContent = text;
            if (danger) d.style.color = 'var(--err)';
            d.addEventListener('click', function () { hideContextMenu(); fn(); });
            menu.appendChild(d);
        }
        addItem('▶ 播放', function () { togglePlay(f); });
        addItem('⏱ 插入到时间线（播放头处）', function () { insertToTimeline(f); });
        addItem(isFav(f.fullPath) ? '☆ 取消收藏' : '★ 收藏', function () {
            toggleFav(f.fullPath);
            var item = renderedMap[f.fullPath];
            if (item) {
                var starEl = item.querySelector('.star');
                if (starEl) {
                    starEl.className = 'star' + (isFav(f.fullPath) ? ' on' : '');
                    starEl.textContent = isFav(f.fullPath) ? '★' : '☆';
                }
            }
            if (filterFav && !isFav(f.fullPath)) setVisibleFiles(currentFiltered());
        });
        addItem('📥 导入 PR「音乐」素材箱', function () { importToBin(f); });
        addItem('在资源管理器中显示', function () {
            setStatus('正在打开资源管理器...', '');
            try { childProcess.spawn('explorer.exe', ['/select,' + f.fullPath]); } catch (e) { setStatus('打开资源管理器失败: ' + e.message, 'err'); }
        });
        var sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        var pathItem = document.createElement('div');
        pathItem.className = 'ctx-item';
        pathItem.style.color = 'var(--muted)';
        pathItem.style.cursor = 'default';
        pathItem.style.fontSize = '10px';
        pathItem.textContent = f.fullPath;
        menu.appendChild(pathItem);

        menu.style.display = 'block';
        var mw = menu.offsetWidth;
        var mh = menu.offsetHeight;
        var x = ev.clientX, y = ev.clientY;
        if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
        if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }
    function hideContextMenu() {
        el.ctxMenu.style.display = 'none';
    }

    // ---------- 浏览目录 ----------
    function browseDir() {
        if (busy) return;
        var initial = el.dir.value.trim();
        if (!initial) { try { initial = localStorage.getItem('mllibDir') || ''; } catch (e) {} }
        setStatus('正在打开文件夹选择器...', '');
        var result;
        try {
            result = window.cep.fs.showOpenDialogEx(true, true, '选择音乐文件夹', initial, []);
        } catch (e) {
            setStatus('打开对话框失败: ' + e.message, 'err');
            return;
        }
        if (!result) { setStatus('未选择目录（已取消）', ''); return; }
        if (result.err && result.err !== 0) { setStatus('打开对话框失败: ' + result.err, 'err'); return; }
        var chosen = (result.data && result.data.length) ? result.data[0] : null;
        if (!chosen) { setStatus('未选择目录（已取消）', ''); return; }
        el.dir.value = chosen;
        try { localStorage.setItem('mllibDir', chosen); } catch (e) {}
        setStatus('已选择目录: ' + chosen, 'ok');
        doScan(false);
    }

    // ---------- 事件 ----------
    el.browse.addEventListener('click', browseDir);
    el.scan.addEventListener('click', function () { doScan(false); });
    el.search.addEventListener('input', function () { setVisibleFiles(currentFiltered()); });
    el.subdir.addEventListener('change', function () {
        savedSubdir = el.subdir.value;
        try { localStorage.setItem('mllibSubdir', savedSubdir); } catch (e) {}
        setVisibleFiles(currentFiltered());
    });
    el.list.addEventListener('scroll', renderWindow);
    el.btnAll.addEventListener('click', function () {
        filterFav = false;
        el.btnAll.classList.add('on');
        el.btnFav.classList.remove('on');
        setVisibleFiles(currentFiltered());
    });
    el.btnFav.addEventListener('click', function () {
        filterFav = true;
        el.btnFav.classList.add('on');
        el.btnAll.classList.remove('on');
        setVisibleFiles(currentFiltered());
    });

    // Esc 关闭右键菜单
    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') hideContextMenu();
    });
    document.addEventListener('click', function (ev) {
        if (el.ctxMenu.style.display === 'block' && !el.ctxMenu.contains(ev.target)) {
            hideContextMenu();
        }
    });

    // 切到音乐库 tab 自动聚焦搜索
    var libTab = document.querySelector('.tab[data-tab="musiclib"]');
    if (libTab) {
        libTab.addEventListener('click', function () {
            setTimeout(function () { try { el.search.focus(); } catch (e) {} }, 60);
        });
    }

    // ---------- 初始化 ----------
    loadFavs();
    try { savedSubdir = localStorage.getItem('mllibSubdir') || ''; } catch (e) {}
    try {
        var savedDir = localStorage.getItem('mllibDir');
        if (savedDir) {
            el.dir.value = savedDir;
            if (fs.existsSync(savedDir)) doScan(true);
        }
    } catch (e) {}
})();
