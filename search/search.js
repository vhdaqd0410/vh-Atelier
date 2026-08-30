// vh-Atelier 音效搜索浮窗（Spotlight 式全局搜索）
// 热键触发 → bg 面板 requestOpenExtension 打开本弹窗 → 输入关键词实时过滤 →
// 回车/双击插入到当前序列播放头，也可拖拽到时间轴。
// 复用主面板的 collect/index.json 索引缓存（音效目录扫描结果）。
(function () {
    var cs = new CSInterface();
    var fs = require('fs');
    var path = require('path');

    var extRoot = cs.getSystemPath(SystemPath.EXTENSION);
    var collectDir = path.join(extRoot, 'collect');
    var indexFile = path.join(collectDir, 'index.json');
    var favsFile = path.join(collectDir, 'favs.json');

    var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'wma'];

    var el = {
        q: document.getElementById('q'),
        results: document.getElementById('results'),
        count: document.getElementById('count'),
        status: document.getElementById('status')
    };

    var allFiles = [];     // 全部索引文件
    var favSet = {};       // 收藏
    var visible = [];      // 当前过滤结果
    var selectedIdx = -1;  // 键盘选中下标
    var busy = false;
    var playingAudio = null;  // 当前播放的 HTMLAudioElement

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

    // ---------- 加载索引 ----------
    function loadIndex() {
        try {
            if (!fs.existsSync(indexFile)) {
                el.count.textContent = '还没有音效索引，请先到主面板「音效库」扫描一次目录';
                renderEmpty('还没有音效索引\n请先到主面板「音效库」tab 扫描一次目录');
                return;
            }
            var c = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
            if (c && Array.isArray(c.files)) {
                allFiles = c.files;
            } else {
                allFiles = [];
            }
            el.count.textContent = '共 ' + allFiles.length + ' 个音效';
            log('index loaded: ' + allFiles.length + ' files');
            renderEmpty('输入关键词搜索音效\n回车或双击插入当前序列 · 可拖拽到时间轴');
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
        big.textContent = lines[0].indexOf('🔎') >= 0 || lines[0].length <= 4 ? '🔎' : '';
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
            renderEmpty('输入关键词搜索音效\n回车或双击插入当前序列 · 可拖拽到时间轴');
            el.count.textContent = '共 ' + allFiles.length + ' 个音效';
            return;
        }
        var out = [];
        for (var i = 0; i < allFiles.length; i++) {
            var f = allFiles[i];
            var base = path.basename(f.name, path.extname(f.name)).toLowerCase();
            if (base.indexOf(kw) >= 0) out.push(f);
            if (out.length >= 200) break;   // 最多展示 200 条，够用了
        }
        visible = out;
        selectedIdx = -1;
        el.count.textContent = '找到 ' + out.length + ' 条 / 共 ' + allFiles.length + ' 个';
        renderList(out);
    }

    function renderList(list) {
        el.results.innerHTML = '';
        if (list.length === 0) {
            renderEmpty('没有匹配「' + el.q.value.trim() + '」的音效');
            return;
        }
        list.forEach(function (f, i) {
            el.results.appendChild(buildItem(f, i));
        });
    }

    function buildItem(f, i) {
        var item = document.createElement('div');
        item.className = 'item';
        item.dataset.path = f.fullPath;
        item.dataset.idx = String(i);
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

        var dur = document.createElement('span');
        dur.className = 'dur';
        dur.textContent = f.ext.toUpperCase();

        var ext = document.createElement('span');
        ext.className = 'ext';
        ext.textContent = f.topSub || '';

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
        item.appendChild(dur);
        item.appendChild(ext);
        item.appendChild(star);

        // 单击选中
        item.addEventListener('click', function () {
            selectIdx(i);
        });
        // 双击插入
        item.addEventListener('dblclick', function () {
            insertToTimeline(f);
        });
        // 拖拽到时间轴
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

    // ---------- 插入时间线 ----------
    function insertToTimeline(f) {
        if (busy) return;
        busy = true;
        setStatus('正在插入 ' + f.name + ' ...', 'ok');
        // 先取播放头位置
        cs.evalScript('sfxGetPlayerPosition()', function (posResult) {
            var posSec = 0;
            try {
                var posObj = JSON.parse(posResult);
                if (posObj && posObj.positionSec !== undefined) posSec = posObj.positionSec;
            } catch (e) {}
            // 写入全局变量并插入
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
            // 关闭本面板
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
            if (sel) {
                var f = visible[parseInt(sel.dataset.idx, 10)];
                if (f) insertToTimeline(f);
            } else if (visible.length > 0) {
                // 没选中时插入第一条
                insertToTimeline(visible[0]);
            }
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

    // 打开时自动聚焦搜索框
    setTimeout(function () { el.q.focus(); }, 100);
})();
