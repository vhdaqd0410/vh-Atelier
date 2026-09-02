// vh-Atelier 板块三：音效库（本地素材浏览器）
// 功能：选目录 → 扫描音频 → 虚拟列表 + 波形懒加载 → 搜索/收藏/子目录过滤 → 点击导入 / 拖拽到时间轴
// 性能：本地索引缓存 + 列表虚拟化（只渲染可视区），几千上万文件不卡
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var collectDir = path.join(extRoot, 'collect');
    var favsFile = path.join(collectDir, 'favs.json');
    var cacheFile = path.join(collectDir, 'index.json');
    var searchIndexFile = path.join(collectDir, 'searchIndex.json');
    var hotkeyFile = path.join(collectDir, 'hotkey.json');
    var DEFAULT_COMBO = 'ctrl+f2';

    var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'wma'];
    var MAX_FILES = 20000;
    var ITEM_H = 44;          // 每条高度，须与 CSS .sfx-item 一致
    var WINDOW_PAD = 12;      // 可视区上下多渲染的条数

    // 状态
    var allFiles = [];        // 扫描到的全部文件 [{ name, dir, fullPath, ext, topSub }]
    var fileByPath = {};      // fullPath -> file
    var visibleFiles = [];    // 过滤后的有序列表（虚拟化数据源）
    var visibleIdx = {};      // fullPath -> 在 visibleFiles 中的下标
    var renderedMap = {};     // fullPath -> 已挂载的 DOM item
    var favSet = {};          // fullPath -> true
    var filterFav = false;
    var savedSubdir = '';      // 记住上次选择的子目录
    var playingPath = null;
    var activeWs = null;
    var busy = false;
    var subdirs = [];
    var rootDir = '';

    var el = {
        dir: document.getElementById('sfxDir'),
        browse: document.getElementById('btnSfxBrowse'),
        scan: document.getElementById('btnSfxScan'),
        subdir: document.getElementById('sfxSubdir'),
        search: document.getElementById('sfxSearch'),
        hotkey: document.getElementById('sfxHotkey'),
        btnHotkey: document.getElementById('btnSfxHotkey'),
        hotkeyHint: document.getElementById('sfxHotkeyHint'),
        btnAll: document.getElementById('btnSfxAll'),
        btnFav: document.getElementById('btnSfxFav'),
        count: document.getElementById('sfxCount'),
        list: document.getElementById('sfxList'),
        spacer: document.getElementById('sfxSpacer'),
        empty: document.getElementById('sfxEmpty'),
        status: document.getElementById('sfxStatus'),
        ctxMenu: document.getElementById('sfxContextMenu')
    };

    function log(msg) {
        try {
            console.log('[vh-sfx] ' + msg);
            var logFile = path.join(collectDir, 'sfx.log');
            if (!fs.existsSync(path.dirname(logFile))) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (e) {} }
            var stamp = new Date().toISOString();
            fs.appendFileSync(logFile, stamp + ' ' + msg + '\n', 'utf8');
        } catch (e) {}
    }

    function setStatus(msg, type) {
        el.status.textContent = msg || '';
        el.status.className = type || '';
    }

    function formatDur(sec) {
        if (!isFinite(sec) || sec < 0) return '';
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        return m + ':' + (s < 10 ? '0' + s : s);
    }

    // ---------- 收藏读写 ----------
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
        } catch (e) {
            setStatus('收藏保存失败: ' + e.message, 'err');
        }
    }

    function isFav(p) { return !!favSet[p]; }
    function toggleFav(p) {
        if (favSet[p]) delete favSet[p]; else favSet[p] = true;
        saveFavs();
    }

    // ---------- 本地索引缓存 ----------
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
            // 生成 search 浮窗专用轻量索引：只保留搜索/插入/播放所需字段，
            // 避免热键每次拉起浮窗都解析 7MB 全量索引导致白屏 + 两次拉起。
            var slim = files.map(function (f) { return { n: f.name, p: f.fullPath, e: f.ext }; });
            fs.writeFileSync(searchIndexFile, JSON.stringify(slim), 'utf8');
        } catch (e) {}
    }

    // ---------- 递归扫描 ----------
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
        // 恢复上次选择的子目录（若目录仍在）
        var want = cur || savedSubdir;
        if (want && subdirs.indexOf(want) >= 0) {
            el.subdir.value = want;
        } else {
            el.subdir.value = '';
        }
    }

    // ---------- 扫描入口 ----------
    function doScan(useCache) {
        if (busy) return;
        var dirPath = el.dir.value.trim();
        if (!dirPath) { setStatus('请先输入或浏览选择音效库目录', 'warn'); return; }
        if (!fs.existsSync(dirPath)) { setStatus('目录不存在: ' + dirPath, 'err'); return; }
        if (!fs.statSync(dirPath).isDirectory()) { setStatus('路径不是文件夹: ' + dirPath, 'err'); return; }

        rootDir = dirPath;
        try { localStorage.setItem('sfxDir', dirPath); } catch (e) {}

        // 先用缓存秒开，再后台刷新
        var cached = useCache ? loadCache(dirPath) : null;
        if (cached && cached.length > 0) {
            applyFiles(cached);
            setStatus('已加载缓存 ' + cached.length + ' 个音频，后台刷新中...', 'ok');
            setTimeout(function () { fullScan(dirPath); }, 60);
            return;
        }
        fullScan(dirPath);
    }

    function fullScan(dirPath) {
        stopCurrent();
        setStatus('正在扫描 ' + dirPath + ' ...', '');
        var out = [];
        try {
            scanDir(dirPath, dirPath, out);
        } catch (e) {
            setStatus('扫描出错: ' + e.message, 'err');
            return;
        }
        if (out.length >= MAX_FILES) {
            setStatus('文件超过 ' + MAX_FILES + ' 个，只加载前 ' + MAX_FILES + ' 个', 'warn');
        }
        applyFiles(out);
        saveCache(dirPath, out);
        setStatus('扫描完成，找到 ' + out.length + ' 个音频文件', 'ok');
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

    // ---------- 虚拟列表渲染 ----------
    function setVisibleFiles(list) {
        visibleFiles = list;
        visibleIdx = {};
        visibleFiles.forEach(function (f, i) { visibleIdx[f.fullPath] = i; });
        // 卸载所有已挂载项
        unmountAll();
        // 设定滚动高度
        el.spacer.style.height = (visibleFiles.length * ITEM_H) + 'px';
        el.empty.style.display = visibleFiles.length === 0 ? '' : 'none';
        el.empty.textContent = allFiles.length === 0 ? '目录下没有音频文件' : '没有匹配的结果';
        el.count.textContent = '显示 ' + visibleFiles.length + ' / ' + allFiles.length + ' 个音频';
        el.list.scrollTop = 0;
        renderWindow();
    }

    function renderWindow() {
        var st = el.list.scrollTop;
        var viewH = el.list.clientHeight || 400;
        var start = Math.max(0, Math.floor(st / ITEM_H) - WINDOW_PAD);
        var end = Math.min(visibleFiles.length, Math.ceil((st + viewH) / ITEM_H) + WINDOW_PAD);

        // 卸载窗口外的项
        Object.keys(renderedMap).forEach(function (p) {
            var idx = visibleIdx[p];
            if (idx === undefined || idx < start || idx >= end) unmountItem(p);
        });

        // 挂载窗口内的项
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
        // 挂载即加载波形（窗口很小，几十条无压力）
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

    function buildItem(f) {
        var item = document.createElement('div');
        item.className = 'sfx-item';
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
        nm.title = '点击导入项目面板「音效库」素材箱';
        nm.addEventListener('click', function (ev) {
            ev.stopPropagation();
            importToPR(f);
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

        item.appendChild(nm);
        item.appendChild(playBtn);
        item.appendChild(waveEl);
        item.appendChild(dur);
        item.appendChild(ext);
        item.appendChild(star);

        // 拖拽到 PR 时间轴/项目：CEP 官方 DnD API
        item.addEventListener('dragstart', function (ev) {
            var t = ev.target;
            if (t.closest && (t.closest('.wave') || t.closest('.playbtn') || t.closest('.star'))) {
                ev.preventDefault();
                return;
            }
            ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', f.fullPath);
            ev.dataTransfer.setData('text/plain', f.fullPath);
            ev.dataTransfer.effectAllowed = 'copy';
        });

        // 右键弹出菜单
        item.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            showContextMenu(ev, f);
        });

        return item;
    }

    // ---------- 波形懒加载 ----------
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
                waveColor: '#8ab0ff',
                progressColor: '#4f8bff',
                cursorColor: '#ffffff',
                height: 32,
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
        } catch (e) {
            cb(e, null);
        }
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
        if (playingPath === item.dataset.path) {
            playingPath = null;
            activeWs = null;
        }
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

    // ---------- 导入 PR 项目面板 ----------
    function importToPR(f) {
        if (busy) return;
        busy = true;
        setStatus('正在导入: ' + f.name + ' ...', '');
        csInterface.evalScript('sfxImportPayload = ' + JSON.stringify([f.fullPath]) + ';', function () {
            csInterface.evalScript('sfxImportToBinStr()', function (result) {
                busy = false;
                try {
                    var data = JSON.parse(result);
                    if (data.ok) setStatus('已导入「音效库」素材箱：' + data.imported.join('、'), 'ok');
                    else setStatus(data.error || '导入失败', 'err');
                } catch (e) {
                    setStatus('导入解析失败: ' + result, 'err');
                }
            });
        });
    }

    // ---------- 右键菜单 ----------
    function showContextMenu(ev, f) {
        var menu = el.ctxMenu;
        menu.innerHTML = '';

        var favItem = document.createElement('div');
        favItem.className = 'ctx-item';
        favItem.textContent = isFav(f.fullPath) ? '☆ 取消收藏' : '★ 收藏';
        favItem.addEventListener('click', function () {
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
            hideContextMenu();
        });

        var showItem = document.createElement('div');
        showItem.className = 'ctx-item';
        showItem.textContent = '在资源管理器中显示';
        showItem.addEventListener('click', function () {
            showInExplorer(f);
            hideContextMenu();
        });

        var sep = document.createElement('div');
        sep.className = 'ctx-sep';

        var pathItem = document.createElement('div');
        pathItem.className = 'ctx-item';
        pathItem.style.color = 'var(--muted)';
        pathItem.style.cursor = 'default';
        pathItem.style.fontSize = '10px';
        pathItem.textContent = f.fullPath;

        menu.appendChild(favItem);
        menu.appendChild(showItem);
        menu.appendChild(sep);
        menu.appendChild(pathItem);

        menu.style.display = 'block';
        var mw = menu.offsetWidth;
        var mh = menu.offsetHeight;
        var x = ev.clientX;
        var y = ev.clientY;
        if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
        if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    }

    function hideContextMenu() {
        el.ctxMenu.style.display = 'none';
    }

    // 在系统资源管理器中定位到该文件并选中（spawn 数组传参，避开 shell 转义）
    function showInExplorer(f) {
        setStatus('正在打开资源管理器...', '');
        try {
            childProcess.spawn('explorer.exe', ['/select,' + f.fullPath]);
        } catch (e) {
            setStatus('打开资源管理器失败: ' + e.message, 'err');
        }
    }

    // ---------- 浏览目录（CEP 原生对话框）----------
    function browseDir() {
        if (busy) return;
        var initial = el.dir.value.trim();
        if (!initial) { try { initial = localStorage.getItem('sfxDir') || ''; } catch (e) {} }
        setStatus('正在打开文件夹选择器...', '');
        var result;
        try {
            result = window.cep.fs.showOpenDialogEx(true, true, '选择音效文件夹', initial, []);
        } catch (e) {
            setStatus('打开对话框失败: ' + e.message, 'err');
            return;
        }
        if (!result) { setStatus('未选择目录（已取消）', ''); return; }
        if (result.err && result.err !== 0) {
            setStatus('打开对话框失败: ' + result.err, 'err');
            return;
        }
        var chosen = (result.data && result.data.length) ? result.data[0] : null;
        if (!chosen) { setStatus('未选择目录（已取消）', ''); return; }
        el.dir.value = chosen;
        try { localStorage.setItem('sfxDir', chosen); } catch (e) {}
        setStatus('已选择目录: ' + chosen, 'ok');
        doScan(false);
    }

    // ---------- 快捷键 ----------
    function registerShortcutInterest() {
        try {
            // '/' 聚焦搜索；Ctrl/Cmd+F 聚焦搜索
            var keys = [
                { keyCode: 191 },                                   // '/'
                { keyCode: 70, ctrlKey: true },                      // Ctrl+F (Win)
                { keyCode: 70, metaKey: true }                       // Cmd+F (Mac)
            ];
            csInterface.registerKeyEventsInterest(JSON.stringify(keys));
        } catch (e) {}
    }

    function focusSearch() {
        el.search.focus();
        try { el.search.select(); } catch (e) {}
    }

    // ---------- 全局热键（隐藏面板广播）----------
    function switchToSfxTab() {
        // 统一委托 main.js 的切换，避免面板列表（含 music/export/check）不一致
        if (window.__atSwitchTab) { window.__atSwitchTab('sfx'); return; }
        var tabs = document.querySelectorAll('.tab');
        var panels = { subtitle: document.getElementById('panel-subtitle'), clone: document.getElementById('panel-clone'), sfx: document.getElementById('panel-sfx') };
        tabs.forEach(function (t) {
            t.classList.toggle('active', t.dataset.tab === 'sfx');
        });
        Object.keys(panels).forEach(function (k) {
            panels[k].style.display = (k === 'sfx') ? '' : 'none';
        });
    }

    function onHotkey(data) {
        if (data && data.type === 'ready') {
            log('onHotkey READY received: ' + (data.combo || ''));
            // 回显实际生效的键到输入框（若未手动编辑）
            var map = data.hotkeys || {};
            if (!el.hotkey.dataset.editing && map.openSearch) {
                el.hotkey.value = map.openSearch;
            }
        } else if (data && data.type === 'hotkey') {
            // 命中热键时 bg 面板已直接弹搜索浮窗，主面板无需再切 tab
            log('onHotkey HOTKEY received (bg 已弹窗): ' + (data.combo || ''));
        }
    }

    csInterface.addEventListener('com.vh.atelier.hotkey', function (evt) {
        var data = evt.data;
        // CEP 跨扩展广播时，data 可能是字符串（自己 stringify 的）或已反序列化的对象，做兼容处理
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) { log('JSON.parse fail: ' + e.message); return; }
        }
        if (data && data.type) {
            log('listener got type=' + data.type + ' combo=' + (data.combo || ''));
        }
        onHotkey(data);
    });

    // ---------- 热键自定义 ----------
    function normalizeCombo(raw) {
        var s = (raw || '').trim().toLowerCase();
        if (!s) return '';
        var parts = s.split('+').map(function (p) { return p.trim(); }).filter(Boolean);
        if (parts.length === 0) return '';
        var mods = [];
        var main = '';
        parts.forEach(function (p) {
            if (p === 'ctrl' || p === 'control') mods.push('ctrl');
            else if (p === 'shift') mods.push('shift');
            else if (p === 'alt') mods.push('alt');
            else if (p === 'win' || p === 'cmd' || p === 'meta') mods.push('win');
            else main = p;
        });
        if (!main) return '';
        // 去重修饰键
        var seen = {};
        var uniq = [];
        mods.forEach(function (m) { if (!seen[m]) { seen[m] = 1; uniq.push(m); } });
        return uniq.join('+') + '+' + main;
    }

    function saveHotkey() {
        var combo = normalizeCombo(el.hotkey.value);
        if (!combo) {
            setStatus('音效热键格式不对，例如 ctrl+f2、ctrl+shift+k', 'err');
            return;
        }
        try {
            if (!fs.existsSync(collectDir)) fs.mkdirSync(collectDir, { recursive: true });
            var map = {};
            try {
                if (fs.existsSync(hotkeyFile)) {
                    var old = JSON.parse(fs.readFileSync(hotkeyFile, 'utf8'));
                    if (old && old.map) map = old.map;
                }
            } catch (e) {}
            map.openSearch = combo;
            fs.writeFileSync(hotkeyFile, JSON.stringify({ map: map }, null, 2), 'utf8');
        } catch (e) {
            setStatus('热键保存失败: ' + e.message, 'err');
            return;
        }
        // 通知隐藏面板换键重启钩子
        try {
            var evt = new CSEvent('com.vh.atelier.hotkey.reload', 'APPLICATION');
            csInterface.dispatchEvent(evt);
        } catch (e) {}
        el.hotkey.value = combo;
        el.hotkey.dataset.editing = '1';
        setStatus('热键已保存：音效搜索 ' + combo, 'ok');
        // 几秒后回显解除锁定
        setTimeout(function () {
            delete el.hotkey.dataset.editing;
        }, 3000);
    }

    el.btnHotkey.addEventListener('click', saveHotkey);
    el.hotkey.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); saveHotkey(); }
    });

    // 初始化：显示当前配置的热键（读共享文件）
    function loadHotkeyDisplay() {
        try {
            if (fs.existsSync(hotkeyFile)) {
                var obj = JSON.parse(fs.readFileSync(hotkeyFile, 'utf8'));
                if (obj && obj.map) {
                    if (obj.map.openSearch) el.hotkey.value = obj.map.openSearch;
                    return;
                }
                if (obj && obj.combo) { el.hotkey.value = obj.combo; return; }
            }
        } catch (e) {}
        el.hotkey.value = DEFAULT_COMBO;
    }

    // ---------- 事件绑定 ----------
    el.browse.addEventListener('click', browseDir);
    el.scan.addEventListener('click', function () { doScan(false); });
    el.search.addEventListener('input', function () { setVisibleFiles(currentFiltered()); });
    el.subdir.addEventListener('change', function () {
        savedSubdir = el.subdir.value;
        try { localStorage.setItem('sfxSubdir', savedSubdir); } catch (e) {}
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

    // 面板内快捷键
    document.addEventListener('keydown', function (ev) {
        var tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
        var isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
        if (ev.key === '/' && !isInput) {
            ev.preventDefault();
            focusSearch();
            return;
        }
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'f' || ev.key === 'F')) {
            ev.preventDefault();
            focusSearch();
            return;
        }
        // Esc 关闭右键菜单 / 清空搜索
        if (ev.key === 'Escape') {
            hideContextMenu();
        }
    });

    // 点击面板空白处关闭右键菜单
    document.addEventListener('click', function (ev) {
        if (el.ctxMenu.style.display === 'block' && !el.ctxMenu.contains(ev.target)) {
            hideContextMenu();
        }
    });

    // 切到音效库 tab 时自动聚焦搜索框
    var sfxTab = document.querySelector('.tab[data-tab="sfx"]');
    if (sfxTab) {
        sfxTab.addEventListener('click', function () {
            setTimeout(focusSearch, 60);
        });
    }

    // ---------- 初始化 ----------
    loadFavs();
    registerShortcutInterest();
    loadHotkeyDisplay();
    try { savedSubdir = localStorage.getItem('sfxSubdir') || ''; } catch (e) {}
    try {
        var savedDir = localStorage.getItem('sfxDir');
        if (savedDir) {
            el.dir.value = savedDir;
            if (fs.existsSync(savedDir)) doScan(true);   // 用缓存秒开 + 后台刷新
        }
    } catch (e) {}
})();
