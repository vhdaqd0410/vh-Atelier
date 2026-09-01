// vh-Atelier 搜索浮窗（Spotlight 式音效搜索）
// 热键触发 → bg 面板 requestOpenExtension 打开本弹窗 → 输入关键词实时过滤 →
//   回车 / 双击插入音效到时间线（播放头位置）。
(function () {
    var cs = new CSInterface();
    var fs = require('fs');
    var path = require('path');

    var extRoot = cs.getSystemPath(SystemPath.EXTENSION);
    var collectDir = path.join(extRoot, 'collect');
    var indexFile = path.join(collectDir, 'searchIndex.json');
    var fallbackIndexFile = path.join(collectDir, 'index.json');
    var favsFile = path.join(collectDir, 'favs.json');

    var el = {
        q: document.getElementById('q'),
        results: document.getElementById('results'),
        toast: document.getElementById('toast')
    };

    var allFiles = [];       // 音效索引
    var favSet = {};         // 收藏
    var visible = [];        // 当前过滤结果
    var selectedIdx = -1;    // 键盘选中下标
    var busy = false;
    var playingAudio = null; // 当前播放的 HTMLAudioElement

    // ---------- 日志 ----------
    function log(msg) {
        try {
            console.log('[vh-search] ' + msg);
            var logFile = path.join(collectDir, 'search.log');
            fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n', 'utf8');
        } catch (e) {}
    }

    var toastTimer = null;
    function setStatus(msg, type) {
        if (!el.toast) return;
        el.toast.textContent = msg || '';
        el.toast.className = 'toast show' + (type ? ' ' + type : '');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            el.toast.className = 'toast';
        }, 2200);
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
            fs.writeFileSync(favsFile, JSON.stringify(Object.keys(favSet), null, 2), 'utf8');
        } catch (e) {}
    }
    function isFav(p) { return !!favSet[p]; }
    function toggleFav(p) {
        if (favSet[p]) delete favSet[p]; else favSet[p] = true;
        saveFavs();
    }

    // ---------- 加载音效索引 ----------
    function loadIndex() {
        try {
            var src = indexFile;
            if (!fs.existsSync(src) && fs.existsSync(fallbackIndexFile)) src = fallbackIndexFile;
            if (!fs.existsSync(src)) {
                renderEmpty('还没有音效索引<br>请先到主面板「音效库」扫描一次目录');
                broadcastReady();
                return;
            }
            fs.readFile(src, 'utf8', function (err, text) {
                if (err) {
                    renderEmpty('索引加载失败: ' + err.message);
                    broadcastReady();
                    return;
                }
                setTimeout(function () {
                    try {
                        var data = JSON.parse(text);
                        var raw = Array.isArray(data) ? data : (data && Array.isArray(data.files) ? data.files : []);
                        allFiles = raw.map(function (f) {
                            // 兼容轻量索引 {n,p,e} 与全量索引 {name,fullPath,ext}
                            return {
                                name: f.n || f.name,
                                fullPath: f.p || f.fullPath,
                                ext: f.e || f.ext || path.extname(f.p || f.fullPath || f.name || '').replace('.', '')
                            };
                        });
                        log('index loaded: ' + allFiles.length + ' files');
                        if (el.q.value.trim()) doFilter();
                        else renderEmpty('输入关键词搜索音效<br>回车或双击插入当前序列');
                    } catch (e2) {
                        log('index parse error: ' + e2.message);
                        renderEmpty('索引解析失败: ' + e2.message);
                    }
                    broadcastReady();
                }, 0);
            });
        } catch (e) {
            log('index load error: ' + e.message);
            renderEmpty('索引加载失败: ' + e.message);
            broadcastReady();
        }
    }

    // 通知 bg 面板「搜索浮窗已就绪」，bg 据此决定立即唤起还是延迟
    function broadcastReady() {
        try {
            var cev = new CSEvent('com.vh.atelier.search.ready', 'APPLICATION');
            cs.dispatchEvent(cev);
        } catch (e) {}
    }

    function renderEmpty(text) {
        el.results.innerHTML = '';
        var d = document.createElement('div');
        d.className = 'empty';
        d.innerHTML = text.replace(/\n/g, '<br>');
        el.results.appendChild(d);
    }

    // ---------- 过滤 ----------
    function doFilter() {
        var kw = el.q.value.trim().toLowerCase();
        if (!kw) {
            visible = [];
            selectedIdx = -1;
            renderEmpty('输入关键词搜索音效<br>回车或双击插入当前序列');
            return;
        }
        var out = [];
        for (var i = 0; i < allFiles.length; i++) {
            var f = allFiles[i];
            var base = path.basename(f.name, path.extname(f.name)).toLowerCase();
            if (base.indexOf(kw) >= 0) out.push(f);
            if (out.length >= 200) break;
        }
        visible = out;
        selectedIdx = -1;
        renderList(out);
    }

    function renderList(list) {
        el.results.innerHTML = '';
        if (list.length === 0) {
            renderEmpty('没有匹配「' + el.q.value.trim() + '」的音频');
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

    // ---------- 播放 ----------
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

    // ---------- 键盘交互 ----------
    function onKey(ev) {
        if (ev.key === 'Escape') {
            // 先广播 closing 让 bg 面板进入 idle 状态（同步状态机，避免竞态）
            try {
                var cev = new CSEvent('com.vh.atelier.search.closing', 'APPLICATION');
                cs.dispatchEvent(cev);
            } catch (e) {}
            // Modeless 面板在 CEP 6 没有 hideExtension，只能 closeExtension 真卸载。
            // 但配合：① 搜身索引（7MB→3.9MB）加速重开 ② bg 的 ready 状态机防吞请求，
            // 重开足够快且不白屏不两次拉起（对齐 Excalibur 已验证模式）。
            try { cs.closeExtension(); } catch (e) {}
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
            insertToTimeline(target);
            return;
        }
    }

    function scrollSelectedIntoView() {
        var sel = getSelectedItem();
        if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    }

    // ---------- 初始化 ----------
    el.q.addEventListener('input', doFilter);
    el.q.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey);
    loadFavs();
    loadIndex();
    log('search panel loaded');

    setTimeout(function () { el.q.focus(); }, 100);
})();
