// vh-Atelier 搜索浮窗（Spotlight 式全局搜索）
// 三个标签页：音效（插入时间线）、效果（施加到播放头剪辑）、转场（施加到播放头剪辑）。
// 热键触发 → bg 面板 requestOpenExtension 打开本弹窗 → 输入关键词实时过滤 →
//   音效：回车/双击插入时间线；效果/转场：回车/双击施加 + 记住「上次选中」供全局快捷键直接复用。
(function () {
    var cs = new CSInterface();
    var fs = require('fs');
    var path = require('path');

    var extRoot = cs.getSystemPath(SystemPath.EXTENSION);
    var collectDir = path.join(extRoot, 'collect');
    var indexFile = path.join(collectDir, 'index.json');
    var favsFile = path.join(collectDir, 'favs.json');
    var fxCacheFile = path.join(collectDir, 'fxcache.json');
    var lastAppliedFile = path.join(collectDir, 'lastapplied.json');

    var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'wma'];

    var el = {
        q: document.getElementById('q'),
        results: document.getElementById('results'),
        count: document.getElementById('count'),
        status: document.getElementById('status'),
        tabs: document.querySelectorAll('.tab')
    };

    var currentTab = 'sfx';
    var allFiles = [];       // 音效索引
    var allEffects = [];     // 效果列表 [{name, matchName}]
    var allTransitions = []; // 转场列表 [{name, matchName}]
    var favSet = {};         // 收藏（仅音效）
    var visible = [];        // 当前过滤结果
    var selectedIdx = -1;    // 键盘选中下标
    var busy = false;
    var playingAudio = null; // 当前播放的 HTMLAudioElement
    var fxLoaded = { effect: false, transition: false };

    // ---------- 日志 ----------
    function log(msg) {
        try {
            console.log('[vh-search] ' + msg);
            var logFile = path.join(collectDir, 'search.log');
            fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n', 'utf8');
        } catch (e) {}
    }

    function setStatus(msg, type) {
        el.status.textContent = msg || '';
        el.status.className = type ? 'status-' + type : '';
    }

    // ---------- 收藏（仅音效）----------
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
            fs.writeFileSync(favsFile, JSON.stringify(Object.keys(favSet), null, 2), 'utf8');
        } catch (e) {}
    }
    function isFav(p) { return !!favSet[p]; }
    function toggleFav(p) {
        if (favSet[p]) delete favSet[p]; else favSet[p] = true;
        saveFavs();
    }

    // ---------- 记住「上次选中」的效果/转场（供全局快捷键直接施加）----------
    function rememberLast(kind, matchName) {
        try {
            var obj = {};
            if (fs.existsSync(lastAppliedFile)) {
                try { obj = JSON.parse(fs.readFileSync(lastAppliedFile, 'utf8')); } catch (e) {}
            }
            obj[kind] = matchName;
            fs.writeFileSync(lastAppliedFile, JSON.stringify(obj, null, 2), 'utf8');
        } catch (e) {}
    }

    // 判断缓存数组是否有效（至少有一条非空 name/matchName）
    function cacheIsValid(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        for (var i = 0; i < arr.length; i++) {
            if ((arr[i] && (arr[i].name || arr[i].matchName))) return true;
        }
        return false;
    }

    // ---------- 加载 fx 缓存（效果/转场，来自 host.jsx 枚举，本地缓存避免每次枚举）----------
    function loadFxCache() {
        try {
            if (fs.existsSync(fxCacheFile)) {
                var c = JSON.parse(fs.readFileSync(fxCacheFile, 'utf8'));
                if (c && Array.isArray(c.effects) && cacheIsValid(c.effects)) allEffects = c.effects;
                if (c && Array.isArray(c.transitions) && cacheIsValid(c.transitions)) allTransitions = c.transitions;
            }
        } catch (e) {}
    }

    // 从 host.jsx 枚举并写缓存
    function refreshFx(kind, callback) {
        var fn = kind === 'effect' ? 'qeListEffects()' : 'qeListTransitions()';
        cs.evalScript(fn, function (result) {
            var data = null;
            try { data = JSON.parse(result); } catch (e) {}
            if (data && data.ok && Array.isArray(data.items)) {
                if (kind === 'effect') allEffects = data.items;
                else allTransitions = data.items;
                // 写缓存
                try {
                    var cache = {};
                    if (fs.existsSync(fxCacheFile)) { try { cache = JSON.parse(fs.readFileSync(fxCacheFile, 'utf8')); } catch (e) {} }
                    cache[kind === 'effect' ? 'effects' : 'transitions'] = (kind === 'effect' ? allEffects : allTransitions);
                    fs.writeFileSync(fxCacheFile, JSON.stringify(cache, null, 2), 'utf8');
                } catch (e) {}
                fxLoaded[kind] = true;
                if (callback) callback(null, data.items);
            } else {
                if (callback) callback(data && data.error ? data.error : '枚举失败', null);
            }
        });
    }

    // ---------- 切换标签页 ----------
    function switchTab(tab) {
        currentTab = tab;
        el.tabs.forEach(function (t) {
            t.classList.toggle('active', t.dataset.tab === tab);
        });
        // 更新占位符
        var ph = { sfx: '输入音效名搜索，回车 / 双击插入时间线...', effect: '输入效果名搜索，回车 / 双击施加...', transition: '输入转场名搜索，回车 / 双击施加...' };
        el.q.placeholder = ph[tab];
        selectedIdx = -1;
        visible = [];

        if (tab === 'sfx') {
            renderEmpty('输入关键词搜索音效\n回车或双击插入当前序列');
            el.count.textContent = '共 ' + allFiles.length + ' 个音效';
            if (el.q.value.trim()) doFilter();
        } else {
            var kind = tab;
            var arr = kind === 'effect' ? allEffects : allTransitions;
            if (arr.length > 0) {
                el.count.textContent = '共 ' + arr.length + ' 个' + (kind === 'effect' ? '效果' : '转场') + '（缓存）';
                renderEmpty('输入关键词搜索' + (kind === 'effect' ? '效果' : '转场') + '\n回车或双击施加到播放头剪辑');
                if (el.q.value.trim()) doFilter();
            } else {
                el.count.textContent = '正在枚举' + (kind === 'effect' ? '效果' : '转场') + '...';
                renderEmpty('正在从 PR 枚举' + (kind === 'effect' ? '效果' : '转场') + '列表...');
                refreshFx(kind, function (err) {
                    if (err) {
                        el.count.textContent = '枚举失败';
                        renderEmpty('枚举失败: ' + err);
                    } else {
                        var a = kind === 'effect' ? allEffects : allTransitions;
                        el.count.textContent = '共 ' + a.length + ' 个' + (kind === 'effect' ? '效果' : '转场');
                        renderEmpty('输入关键词搜索' + (kind === 'effect' ? '效果' : '转场'));
                        if (el.q.value.trim()) doFilter();
                    }
                });
            }
        }
    }

    // ---------- 加载音效索引 ----------
    function loadIndex() {
        try {
            if (!fs.existsSync(indexFile)) {
                el.count.textContent = '还没有音效索引，请先到主面板「音效库」扫描一次目录';
                renderEmpty('还没有音效索引\n请先到主面板「音效库」tab 扫描一次目录');
                return;
            }
            el.count.textContent = '正在加载索引...';
            fs.readFile(indexFile, 'utf8', function (err, text) {
                if (err) {
                    el.count.textContent = '索引加载失败';
                    renderEmpty('索引加载失败: ' + err.message);
                    return;
                }
                setTimeout(function () {
                    try {
                        var c = JSON.parse(text);
                        if (c && Array.isArray(c.files)) {
                            allFiles = c.files;
                        } else {
                            allFiles = [];
                        }
                        el.count.textContent = '共 ' + allFiles.length + ' 个音效';
                        log('index loaded: ' + allFiles.length + ' files');
                        if (el.q.value.trim()) doFilter();
                        else renderEmpty('输入关键词搜索音效\n回车或双击插入当前序列');
                    } catch (e2) {
                        el.count.textContent = '索引解析失败';
                        log('index parse error: ' + e2.message);
                        renderEmpty('索引解析失败: ' + e2.message);
                    }
                }, 0);
            });
        } catch (e) {
            el.count.textContent = '索引加载失败';
            log('index load error: ' + e.message);
            renderEmpty('索引加载失败: ' + e.message);
        }
    }

    function renderEmpty(text) {
        el.results.innerHTML = '';
        var d = document.createElement('div');
        d.className = 'empty';
        var lines = text.split('\n');
        var big = document.createElement('span');
        big.className = 'big';
        big.textContent = '🔎';
        d.appendChild(big);
        d.appendChild(document.createTextNode(lines[0]));
        if (lines.length > 1) {
            d.appendChild(document.createElement('br'));
            var s = document.createElement('span');
            s.style.fontSize = '11px';
            s.textContent = lines.slice(1).join(' ');
            d.appendChild(s);
        }
        el.results.appendChild(d);
    }

    // ---------- 过滤 ----------
    function doFilter() {
        var kw = el.q.value.trim().toLowerCase();
        if (!kw) {
            visible = [];
            selectedIdx = -1;
            switchTab(currentTab);
            return;
        }

        if (currentTab === 'sfx') {
            var out = [];
            for (var i = 0; i < allFiles.length; i++) {
                var f = allFiles[i];
                var base = path.basename(f.name, path.extname(f.name)).toLowerCase();
                if (base.indexOf(kw) >= 0) out.push(f);
                if (out.length >= 200) break;
            }
            visible = out;
            selectedIdx = -1;
            el.count.textContent = '找到 ' + out.length + ' 条 / 共 ' + allFiles.length + ' 个';
            renderList(out);
        } else {
            var kind = currentTab;
            var arr = kind === 'effect' ? allEffects : allTransitions;
            var out2 = [];
            for (var j = 0; j < arr.length; j++) {
                var it = arr[j];
                var name = (it.name || '').toLowerCase();
                var mn = (it.matchName || '').toLowerCase();
                if (name.indexOf(kw) >= 0 || mn.indexOf(kw) >= 0) out2.push(it);
                if (out2.length >= 200) break;
            }
            visible = out2;
            selectedIdx = -1;
            el.count.textContent = '找到 ' + out2.length + ' 条 / 共 ' + arr.length + ' 个';
            renderList(out2);
        }
    }

    function renderList(list) {
        el.results.innerHTML = '';
        if (list.length === 0) {
            renderEmpty('没有匹配「' + el.q.value.trim() + '」的内容');
            return;
        }
        list.forEach(function (f, i) {
            el.results.appendChild(buildItem(f, i));
        });
    }

    function buildItem(f, i) {
        var item = document.createElement('div');
        item.className = 'item';
        item.dataset.idx = String(i);

        if (currentTab === 'sfx') {
            // 音效项
            item.dataset.path = f.fullPath;
            item.draggable = true;

            var playBtn = document.createElement('button');
            playBtn.className = 'playbtn';
            playBtn.textContent = '▶';
            playBtn.title = '播放 / 暂停';
            playBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                togglePlay(f, playBtn);
            });

            var nm = document.createElement('span');
            nm.className = 'nm';
            nm.textContent = f.name;
            nm.title = f.fullPath;

            var ext = document.createElement('span');
            ext.className = 'ext';
            ext.textContent = f.ext ? f.ext.toUpperCase() : '';

            var star = document.createElement('span');
            star.className = 'star' + (isFav(f.fullPath) ? ' on' : '');
            star.textContent = isFav(f.fullPath) ? '★' : '☆';
            star.title = '收藏 / 取消收藏';
            star.addEventListener('click', function (ev) {
                ev.stopPropagation();
                toggleFav(f.fullPath);
                star.className = 'star' + (isFav(f.fullPath) ? ' on' : '');
                star.textContent = isFav(f.fullPath) ? '★' : '☆';
            });

            item.appendChild(playBtn);
            item.appendChild(nm);
            item.appendChild(ext);
            item.appendChild(star);

            item.addEventListener('click', function () { selectIdx(i); });
            item.addEventListener('dblclick', function () { insertToTimeline(f); });
            item.addEventListener('dragstart', function (ev) {
                if (ev.target.closest && (ev.target.closest('.playbtn') || ev.target.closest('.star'))) {
                    ev.preventDefault();
                    return;
                }
                ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', f.fullPath);
                ev.dataTransfer.setData('text/plain', f.fullPath);
                ev.dataTransfer.effectAllowed = 'copy';
            });
        } else {
            // 效果 / 转场项
            var kind = currentTab;
            item.dataset.matchName = f.matchName || f.name || '';

            var icon = document.createElement('span');
            icon.className = 'ext';
            icon.textContent = kind === 'effect' ? '效果' : '转场';

            var nm2 = document.createElement('span');
            nm2.className = 'nm';
            nm2.textContent = f.name || f.matchName || '';

            var mn = document.createElement('span');
            mn.className = 'dur';
            mn.textContent = f.matchName || '';
            mn.title = f.matchName || '';

            item.appendChild(icon);
            item.appendChild(nm2);
            item.appendChild(mn);

            item.addEventListener('click', function () { selectIdx(i); });
            item.addEventListener('dblclick', function () { applyFx(f); });
        }

        return item;
    }

    function selectIdx(i) {
        selectedIdx = i;
        var items = el.results.querySelectorAll('.item');
        items.forEach(function (it, j) {
            it.classList.toggle('selected', j === i);
        });
    }

    function getSelectedItem() {
        return el.results.querySelector('.item.selected');
    }

    // ---------- 播放（仅音效）----------
    function togglePlay(f, btn) {
        if (playingAudio && playingAudio.__path === f.fullPath) {
            if (!playingAudio.paused) {
                playingAudio.pause();
                btn.textContent = '▶';
                return;
            }
        }
        if (playingAudio) {
            playingAudio.pause();
            playingAudio = null;
        }
        var a = new Audio();
        a.src = 'file:///' + f.fullPath.replace(/\\/g, '/');
        a.__path = f.fullPath;
        a.onended = function () {
            if (btn) btn.textContent = '▶';
            playingAudio = null;
        };
        a.onerror = function () {
            setStatus('播放失败: ' + f.name, 'err');
            playingAudio = null;
        };
        a.play().then(function () {
            playingAudio = a;
            if (btn) btn.textContent = '⏸';
        }).catch(function (e) {
            setStatus('播放失败: ' + e.message, 'err');
        });
    }

    // ---------- 插入音效到时间线 ----------
    function insertToTimeline(f) {
        if (busy) return;
        busy = true;
        setStatus('正在插入 ' + f.name + ' ...', 'ok');
        cs.evalScript('sfxGetPlayerPosition()', function (posResult) {
            var posSec = 0;
            try {
                var posObj = JSON.parse(posResult);
                if (posObj && posObj.positionSec !== undefined) posSec = posObj.positionSec;
            } catch (e) {}
            cs.evalScript('sfxInsertPayload = ' + JSON.stringify({ path: f.fullPath, positionSec: posSec }) + ';', function () {
                cs.evalScript('sfxInsertToTimelineStr()', function (result) {
                    busy = false;
                    try {
                        var data = JSON.parse(result);
                        if (data.ok) {
                            setStatus('已插入时间线: ' + data.name, 'ok');
                        } else {
                            setStatus(data.error || '插入失败', 'err');
                        }
                    } catch (e) {
                        setStatus('插入结果解析失败', 'err');
                    }
                });
            });
        });
    }

    // ---------- 施加效果/转场到播放头剪辑 ----------
    function applyFx(f) {
        if (busy) return;
        busy = true;
        var kind = currentTab;
        var matchName = f.matchName || f.name || '';
        setStatus('正在施加' + (kind === 'effect' ? '效果' : '转场') + ': ' + (f.name || matchName) + ' ...', 'ok');
        // 记住「上次选中」，供全局快捷键直接复用
        rememberLast(kind, matchName);
        var fn = kind === 'effect' ? 'fxApplyEffectStr' : 'fxApplyTransitionStr';
        cs.evalScript('fxPayload = ' + JSON.stringify({ matchName: matchName }) + ';', function () {
            cs.evalScript(fn + '()', function (result) {
                busy = false;
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setStatus('已施加到: ' + (data.clip || ''), 'ok');
                        log('applied ' + kind + ': ' + matchName);
                    } else {
                        setStatus(data.error || '施加失败', 'err');
                    }
                } catch (e) {
                    setStatus('施加结果解析失败', 'err');
                }
            });
        });
    }

    // ---------- 键盘交互 ----------
    function onKey(ev) {
        if (ev.key === 'Escape') {
            try { cs.closeExtension(); } catch (e) {}
            return;
        }
        // Tab 切换标签页
        if (ev.key === 'Tab') {
            ev.preventDefault();
            var order = ['sfx', 'effect', 'transition'];
            var idx = order.indexOf(currentTab);
            var next = order[(idx + 1) % order.length];
            switchTab(next);
            return;
        }
        if (ev.key === 'ArrowDown') {
            ev.preventDefault();
            if (visible.length === 0) return;
            var next = Math.min(selectedIdx + 1, visible.length - 1);
            if (next < 0) next = 0;
            selectIdx(next);
            scrollSelectedIntoView();
            return;
        }
        if (ev.key === 'ArrowUp') {
            ev.preventDefault();
            if (visible.length === 0) return;
            var prev = Math.max(selectedIdx - 1, 0);
            selectIdx(prev);
            scrollSelectedIntoView();
            return;
        }
        if (ev.key === 'Enter') {
            ev.preventDefault();
            var sel = getSelectedItem();
            var target = null;
            if (sel) {
                target = visible[parseInt(sel.dataset.idx, 10)];
            } else if (visible.length > 0) {
                target = visible[0];
            }
            if (!target) return;
            if (currentTab === 'sfx') insertToTimeline(target);
            else applyFx(target);
            return;
        }
    }

    function scrollSelectedIntoView() {
        var sel = getSelectedItem();
        if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    }

    // ---------- 监听 bg 传来的初始 tab（requestOpenExtension 参数）----------
    function initTab() {
        // requestOpenExtension 的第二个参数会作为 query string 传入，CEP 里通过 location 无法直接拿到
        // 这里用 CSInterface 的事件或直接默认 sfx；bg 面板可通过 broadcast 指定
        try {
            var params = new URLSearchParams(window.location.search);
            var t = params.get('tab');
            if (t && ['sfx', 'effect', 'transition'].indexOf(t) >= 0) {
                switchTab(t);
                return;
            }
        } catch (e) {}
        switchTab('sfx');
    }

    // ---------- 初始化 ----------
    el.tabs.forEach(function (t) {
        t.addEventListener('click', function () { switchTab(t.dataset.tab); });
    });
    el.q.addEventListener('input', doFilter);
    el.q.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey);
    loadFavs();
    loadFxCache();
    loadIndex();
    initTab();
    log('search panel loaded');

    setTimeout(function () { el.q.focus(); }, 100);
})();
