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
    var filterFav = false;    // 收藏视图
    var playingPath = null;
    var busy = false;
    var rootDir = '';
    // ---- 目录树浏览状态 ----
    var sfxTreeRoot = null;   // 目录树根 {abs,name,depth,children,music[],files}
    var curSfxDir = '';       // 当前选中目录（绝对路径）；'' = 浏览根全部
    var sfxViewMode = 'tree'; // 'tree' | 'fav' | 'search'

    var el = {
        dir: document.getElementById('sfxDir'),
        browse: document.getElementById('btnSfxBrowse'),
        scan: document.getElementById('btnSfxScan'),
        search: document.getElementById('sfxSearch'),
        tree: document.getElementById('sfxTree'),
        btnAll: document.getElementById('btnSfxAll'),
        btnFav: document.getElementById('btnSfxFav'),
        count: document.getElementById('sfxCount'),
        list: document.getElementById('sfxList'),
        spacer: document.getElementById('sfxSpacer'),
        empty: document.getElementById('sfxEmpty'),
        status: document.getElementById('sfxStatus'),
        ctxMenu: document.getElementById('sfxContextMenu'),
        player: document.getElementById('sfxPlayerBar'),
        playBtn: document.getElementById('btnSfxPlay'),
        prevBtn: document.getElementById('btnSfxPrev'),
        nextBtn: document.getElementById('btnSfxNext'),
        volBtn: document.getElementById('btnSfxVol'),
        volSlider: document.getElementById('sfxVol'),
        seek: document.getElementById('sfxSeek'),
        seekFill: document.getElementById('sfxSeekFill'),
        curT: document.getElementById('sfxCur'),
        durT: document.getElementById('sfxDur'),
        pTitle: document.getElementById('sfxPlayerTitle'),
        pSub: document.getElementById('sfxPlayerSub')
    };

    // 统一播放状态（单活动实例模型，同音乐库）
    var curWs = null;        // 当前活动 wavesurfer
    var curWsPath = null;
    var activeItem = null;
    var progressTimer = null;

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

    // 从 allFiles 构建目录树（文件夹结构 + 每层直接音乐文件）
    function buildSfxTree() {
        // 统一路径分隔符：rootDir 可能是用户填的正斜杠 D:/...，而 scanDir 产出的 f.dir 是反斜杠 D:\...
        // 不统一会导致 ensureNode 回溯永远到不了根 → 树只剩空根。用 path.normalize 统一为系统风格
        var normRoot = path.normalize(rootDir);
        var rootNode = { abs: normRoot, name: path.basename(normRoot) || normRoot, depth: 0, children: [], music: [], parent: null, files: 0, dirs: 0 };
        var nodeByDir = {};
        nodeByDir[normRoot] = rootNode;
        function ensureNode(dirAbs) {
            var d = path.normalize(dirAbs);
            if (nodeByDir[d]) return nodeByDir[d];
            var parentAbs = path.dirname(d);
            var parent = parentAbs === d ? rootNode : ensureNode(parentAbs);
            var n = { abs: d, name: path.basename(d), depth: parent.depth + 1, children: [], music: [], parent: parent, files: 0, dirs: 0 };
            nodeByDir[d] = n;
            parent.children.push(n);
            return n;
        }
        allFiles.forEach(function (f) {
            var node = ensureNode(f.dir);
            node.music.push(f);
        });
        function recount(n) {
            n.files = (n.music || []).length;
            n.dirs = 0;
            n.children.forEach(function (c) { recount(c); n.dirs += c.dirs + 1; n.files += c.files; });
        }
        recount(rootNode);
        return rootNode;
    }

    // 渲染左目录树
    function renderSfxTree() {
        if (!el.tree) return;
        el.tree.innerHTML = '';
        if (!sfxTreeRoot) return;
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
            ico.textContent = n.depth === 0 ? '🗂' : (hasKids ? '📁' : '📂');
            var lbl = document.createElement('span');
            lbl.className = 'tlabel';
            lbl.textContent = n.depth === 0 ? (path.basename(n.abs) || n.abs) : n.name;
            lbl.title = n.abs;
            var cnt = document.createElement('span');
            cnt.className = 'tcnt';
            cnt.textContent = n.files > 0 ? String(n.files) : '';
            row.appendChild(caret); row.appendChild(ico); row.appendChild(lbl); row.appendChild(cnt);
            row.__node = n;
            row.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (ev.target && ev.target.classList && ev.target.classList.contains('caret')) {
                    n.__open = !n.__open;
                    collapseSfxTree();
                    return;
                }
                sfxViewMode = 'tree';
                curSfxDir = n.abs;
                syncSfxViewBtns();
                if (n.children.length && !n.__open) n.__open = true;
                collapseSfxTree();
                applyView();
            });
            el.tree.appendChild(row);
            n.children.forEach(walk);
        })(sfxTreeRoot);
        collapseSfxTree();
    }

    function collapseSfxTree() {
        if (!el.tree || !sfxTreeRoot) return;
        if (sfxTreeRoot.__open !== false) sfxTreeRoot.__open = true;
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
            r.classList.toggle('sel', show && sfxViewMode === 'tree' && n.abs === curSfxDir);
        });
    }

    // 根据当前视图（目录/收藏/搜索）算出可见文件列表
    function applyView() {
        var kw = (el.search.value || '').trim().toLowerCase();
        var list = [];
        if (sfxViewMode === 'fav') {
            // 收藏视图：所有收藏
            list = allFiles.filter(function (f) { return isFav(f.fullPath); });
        } else if (kw) {
            // 搜索：文件名 + 所在文件夹路径（路径用反斜杠统一比较，避免正反斜杠混用）
            var kwL = kw.toLowerCase();
            list = allFiles.filter(function (f) {
                var nameHit = path.basename(f.name, path.extname(f.name)).toLowerCase().indexOf(kwL) >= 0;
                if (nameHit) return true;
                try {
                    var dirL = path.normalize(f.dir).toLowerCase();
                    return dirL.indexOf(kwL) >= 0;
                } catch (e) { return false; }
            });
        } else if (curSfxDir) {
            // 目录视图：该目录 + 其所有子孙目录的音效（递归收集）
            var node = findSfxNode(curSfxDir);
            list = [];
            if (node) {
                (function collect(n2) {
                    (n2.music || []).forEach(function (m) { list.push(m); });
                    n2.children.forEach(collect);
                })(node);
            }
        } else {
            // 根视图：整个库（所有目录音效）
            list = [];
            if (sfxTreeRoot) {
                (function collect2(n3) {
                    (n3.music || []).forEach(function (m) { list.push(m); });
                    n3.children.forEach(collect2);
                })(sfxTreeRoot);
            }
        }
        setVisibleFiles(list);
        el.empty.textContent = allFiles.length === 0 ? '目录下没有音频文件' : (list.length === 0 ? '该目录下没有音效' : '');
    }

    function findSfxNode(abs) {
        if (!sfxTreeRoot) return null;
        var out = null;
        (function w(n) { if (n.abs === abs) { out = n; return; } n.children.forEach(function (c) { if (!out) w(c); }); })(sfxTreeRoot);
        return out;
    }

    function syncSfxViewBtns() {
        if (!el.btnAll || !el.btnFav) return;
        el.btnAll.classList.toggle('on', sfxViewMode === 'tree');
        el.btnFav.classList.toggle('on', sfxViewMode === 'fav');
        if (sfxViewMode === 'tree') { el.btnAll.textContent = '浏览'; el.btnFav.textContent = '★ 收藏'; }
        else if (sfxViewMode === 'fav') { el.btnAll.textContent = '浏览'; el.btnFav.textContent = '★ 收藏中'; }
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
        stopPlayback();
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
        // 构建目录树 + 重置浏览视图到根
        sfxTreeRoot = buildSfxTree();
        curSfxDir = '';
        sfxViewMode = 'tree';
        syncSfxViewBtns();
        renderSfxTree();
        applyView();
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
        if (el.empty && !el.empty.textContent) el.empty.textContent = '没有匹配的结果';
        // 计数显示（工具栏上）：当前视图/总数
        var scope = '';
        if (sfxViewMode === 'fav') scope = '★ 收藏 ';
        else if (curSfxDir) scope = path.basename(curSfxDir) + ' ';
        else scope = '根目录 ';
        el.count.textContent = scope + visibleFiles.length + ' / ' + allFiles.length + ' 个';
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
            if (playingPath === f.fullPath && curPlaying()) { pausePlayback(); }
            else playFrom(f, 0);
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
            if (sfxViewMode === 'fav' && !isFav(f.fullPath)) applyView();
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
                interact: false,   // 点击统一走我们的 handler（点波形从指针处播放）
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
            if (playingPath === f.fullPath) setProgressUI();
        });
        ws.on('finish', function () {
            if (playingPath === f.fullPath) onTrackEnd();
        });

        // 点波形从指针处播放（Resonic 手感）；行内 ws 默认 interact:true 会自带 seek，这里统一走我们的 handler
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

    // ---------- 统一播放（单活动实例，点波形从指针处播） ----------
    function curPlaying() { return curWs && curWs.isPlaying && curWs.isPlaying(); }

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

    function applyVolume() {
        if (!curWs) return;
        try {
            var v = parseFloat(el.volSlider.value);
            if (!isFinite(v)) v = 0.8;
            curWs.setVolume(v);
        } catch (e) {}
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

    function stopPlayback() {
        if (curWs) { try { curWs.pause(); curWs.seekTo(0); } catch (e) {} }
        curWs = null;
        curWsPath = null;
        playingPath = null;
        activeItem = null;
        updatePlayState();
        setPlayerUI();
    }
    function pausePlayback() {
        if (curWs) { try { curWs.pause(); } catch (e) {} }
        updatePlayState();
        setPlayerUI();
    }

    function syncPlayUI(f) {
        playingPath = f.fullPath;
        activeItem = renderedMap[f.fullPath] || null;
        if (el.player) el.player.style.display = '';
        if (el.pTitle) el.pTitle.textContent = f.name;
        if (el.pSub) el.pSub.textContent = f.dir + ' · ' + f.ext.toUpperCase();
        updatePlayState();
        setPlayerUI();
        setProgressUI();
    }

    function onTrackEnd() {
        // 音效：播完即停，不自动连播下一段（音效短又多，自动续播会烦）
        // 播放条保留显示当前文件，进度停在结尾；用户可再点播放从头（playFrom 会 seek 0）
        if (curWs) {
            try { curWs.pause(); curWs.seekTo(0); } catch (e) {}
        }
        setProgressUI();
        updatePlayState();
    }

    function nextTrack(dir) {
        if (!visibleFiles.length) return;
        var idx = playingPath ? visibleIdx[playingPath] : -1;
        if (idx === undefined || idx < 0) idx = -1;
        var ni = idx + dir;
        if (ni < 0) ni = visibleFiles.length - 1;
        if (ni >= visibleFiles.length) ni = 0;
        playFrom(visibleFiles[ni], 0);
    }

    function updatePlayState() {
        Object.keys(renderedMap).forEach(function (p) {
            var item = renderedMap[p];
            if (!item) return;
            var playing = playingPath === p && curPlaying();
            item.classList.toggle('playing', !!playing);
            var btn = item.querySelector('.playbtn');
            if (btn) btn.textContent = playing ? '⏸' : '▶';
        });
        var playing = curPlaying();
        if (el.playBtn) {
            var icp = el.playBtn.querySelector('.ic-play');
            var icp2 = el.playBtn.querySelector('.ic-pause');
            if (icp) icp.style.display = playing ? 'none' : '';
            if (icp2) icp2.style.display = playing ? '' : 'none';
        }
    }

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
    }

    function startProgressTick() {
        clearInterval(progressTimer);
        progressTimer = setInterval(function () {
            if (playingPath && curWs && curPlaying()) setProgressUI();
        }, 250);
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
            if (sfxViewMode === 'fav' && !isFav(f.fullPath)) applyView();
            hideContextMenu();
        });

        var showItem = document.createElement('div');
        showItem.className = 'ctx-item';
        showItem.textContent = '在资源管理器中显示';
        showItem.addEventListener('click', function () {
            showInExplorer(f);
            hideContextMenu();
        });

        var insItem = document.createElement('div');
        insItem.className = 'ctx-item';
        insItem.textContent = '⏱ 插入到时间线（播放头处）';
        insItem.addEventListener('click', function () {
            insertToTimeline(f);
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
        menu.appendChild(insItem);
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

    // 插入到时间线（播放头处，插入语义不覆盖）
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

    // ---------- 事件绑定 ----------
    el.browse.addEventListener('click', browseDir);
    el.scan.addEventListener('click', function () { doScan(false); });
    el.search.addEventListener('input', function () { applyView(); });
    el.list.addEventListener('scroll', renderWindow);
    el.btnAll.addEventListener('click', function () {
        sfxViewMode = 'tree';
        syncSfxViewBtns();
        collapseSfxTree();
        applyView();
    });
    el.btnFav.addEventListener('click', function () {
        sfxViewMode = 'fav';
        syncSfxViewBtns();
        applyView();
    });

    // 播放条事件（单活动实例控制）
    if (el.playBtn) el.playBtn.addEventListener('click', function () {
        if (curPlaying()) pausePlayback();
        else if (playingPath && curWs) { try { curWs.play(); } catch (e) {} updatePlayState(); }
        else if (visibleFiles.length) playFrom(visibleFiles[0], 0);
    });
    if (el.prevBtn) el.prevBtn.addEventListener('click', function () { nextTrack(-1); });
    if (el.nextBtn) el.nextBtn.addEventListener('click', function () { nextTrack(1); });
    if (el.seek) el.seek.addEventListener('click', function (ev) {
        if (!curWs) return;
        var rect = el.seek.getBoundingClientRect();
        if (!rect.width) return;
        var ratio = (ev.clientX - rect.left) / rect.width;
        if (ratio < 0) ratio = 0; if (ratio > 1) ratio = 1;
        curWs.seekTo(ratio);
        if (!curPlaying()) { try { curWs.play(); } catch (e) {} updatePlayState(); }
        setProgressUI();
    });
    if (el.volSlider) el.volSlider.addEventListener('input', function () {
        if (curWs) { try { curWs.setVolume(parseFloat(el.volSlider.value) || 0.8); } catch (e) {} }
    });
    if (el.volBtn) el.volBtn.addEventListener('click', function () {
        var muted = curWs && curWs.getMuted && curWs.getMuted();
        var toMute = !muted;
        if (curWs) { try { curWs.setMute(toMute); } catch (e) {} }
        var iconOn = el.volBtn.querySelector('.ic-vol-on');
        var iconOff = el.volBtn.querySelector('.ic-vol-off');
        if (iconOn) iconOn.style.display = toMute ? 'none' : '';
        if (iconOff) iconOff.style.display = toMute ? '' : 'none';
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
    startProgressTick();
    try {
        var savedDir = localStorage.getItem('sfxDir');
        if (savedDir) {
            el.dir.value = savedDir;
            if (fs.existsSync(savedDir)) doScan(true);   // 用缓存秒开 + 后台刷新
        }
    } catch (e) {}
})();
