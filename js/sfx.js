// vh-Atelier 板块三：音效库（本地素材浏览器）
// 功能：选目录 → 递归扫描音频 → 试听 → 搜索/收藏 → 导入 PR 项目面板
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var os = require('os');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);

    // 收藏数据持久化：存到插件目录的 collect/favs.json
    var collectDir = path.join(extRoot, 'collect');
    var favsFile = path.join(collectDir, 'favs.json');

    var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'wma'];

    // 状态
    var allFiles = [];        // [{ name, dir, fullPath, ext }]
    var favSet = {};          // { fullPath: true }
    var filterFav = false;    // 当前是否只看收藏
    var playingPath = null;   // 正在播放的路径
    var busy = false;

    // DOM 引用
    var el = {
        dir: document.getElementById('sfxDir'),
        browse: document.getElementById('btnSfxBrowse'),
        scan: document.getElementById('btnSfxScan'),
        search: document.getElementById('sfxSearch'),
        btnAll: document.getElementById('btnSfxAll'),
        btnFav: document.getElementById('btnSfxFav'),
        count: document.getElementById('sfxCount'),
        list: document.getElementById('sfxList'),
        status: document.getElementById('sfxStatus'),
        player: document.getElementById('sfxPlayer')
    };

    function setStatus(msg, type) {
        el.status.textContent = msg || '';
        el.status.className = type || '';
    }

    // ---------- 收藏读写 ----------
    function loadFavs() {
        try {
            if (fs.existsSync(favsFile)) {
                var raw = fs.readFileSync(favsFile, 'utf8');
                var arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    favSet = {};
                    arr.forEach(function (p) { favSet[p] = true; });
                }
            }
        } catch (e) {
            favSet = {};
        }
    }

    function saveFavs() {
        try {
            if (!fs.existsSync(collectDir)) fs.mkdirSync(collectDir, { recursive: true });
            var keys = Object.keys(favSet);
            fs.writeFileSync(favsFile, JSON.stringify(keys, null, 2), 'utf8');
        } catch (e) {
            setStatus('收藏保存失败: ' + e.message, 'err');
        }
    }

    function isFav(p) { return !!favSet[p]; }
    function toggleFav(p) {
        if (favSet[p]) delete favSet[p];
        else favSet[p] = true;
        saveFavs();
    }

    // ---------- 递归扫描 ----------
    function scanDir(dirPath, out) {
        var items;
        try { items = fs.readdirSync(dirPath); }
        catch (e) { return; }
        items.forEach(function (item) {
            var full = path.join(dirPath, item);
            var st;
            try { st = fs.statSync(full); } catch (e) { return; }
            if (st.isDirectory()) {
                scanDir(full, out);
            } else {
                var ext = path.extname(item).replace('.', '').toLowerCase();
                if (AUDIO_EXTS.indexOf(ext) >= 0) {
                    out.push({ name: item, dir: dirPath, fullPath: full, ext: ext });
                }
            }
        });
    }

    function doScan() {
        if (busy) return;
        var dirPath = el.dir.value.trim();
        if (!dirPath) { setStatus('请先输入或浏览选择音效库目录', 'warn'); return; }
        if (!fs.existsSync(dirPath)) { setStatus('目录不存在: ' + dirPath, 'err'); return; }
        if (!fs.statSync(dirPath).isDirectory()) { setStatus('路径不是文件夹: ' + dirPath, 'err'); return; }

        setStatus('正在扫描 ' + dirPath + ' ...', '');
        var out = [];
        try {
            scanDir(dirPath, out);
        } catch (e) {
            setStatus('扫描出错: ' + e.message, 'err');
            return;
        }
        allFiles = out;
        // 记住目录到 localStorage
        try { localStorage.setItem('sfxDir', dirPath); } catch (e) {}
        setStatus('扫描完成，找到 ' + allFiles.length + ' 个音频文件', 'ok');
        renderList();
    }

    // ---------- 渲染 ----------
    function currentFiltered() {
        var kw = el.search.value.trim().toLowerCase();
        return allFiles.filter(function (f) {
            if (filterFav && !isFav(f.fullPath)) return false;
            if (kw) {
                var base = path.basename(f.name, path.extname(f.name)).toLowerCase();
                if (base.indexOf(kw) < 0) return false;
            }
            return true;
        });
    }

    function renderList() {
        var list = currentFiltered();
        el.list.innerHTML = '';
        el.count.textContent = '显示 ' + list.length + ' / ' + allFiles.length + ' 个音频';

        if (list.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'sfx-empty';
            empty.textContent = allFiles.length === 0 ? '目录下没有音频文件' : '没有匹配的结果';
            el.list.appendChild(empty);
            return;
        }

        list.forEach(function (f) {
            var item = document.createElement('div');
            item.className = 'sfx-item' + (playingPath === f.fullPath ? ' playing' : '');

            var star = document.createElement('span');
            star.className = 'star' + (isFav(f.fullPath) ? ' on' : '');
            star.textContent = isFav(f.fullPath) ? '★' : '☆';
            star.title = '收藏 / 取消收藏';
            star.addEventListener('click', function (ev) {
                ev.stopPropagation();
                toggleFav(f.fullPath);
                renderList();
            });

            var nm = document.createElement('span');
            nm.className = 'nm';
            nm.textContent = f.name;

            var ext = document.createElement('span');
            ext.className = 'ext';
            ext.textContent = f.ext.toUpperCase();

            item.appendChild(star);
            item.appendChild(nm);
            item.appendChild(ext);

            // 单击试听，双击导入 PR
            item.addEventListener('click', function () { playPreview(f); });
            item.addEventListener('dblclick', function () { importToPR(f); });

            el.list.appendChild(item);
        });
    }

    // ---------- 试听 ----------
    function playPreview(f) {
        if (playingPath === f.fullPath) {
            el.player.pause();
            playingPath = null;
            renderList();
            return;
        }
        try {
            el.player.src = 'file:///' + f.fullPath.replace(/\\/g, '/');
            el.player.play();
            playingPath = f.fullPath;
            renderList();
        } catch (e) {
            setStatus('播放失败: ' + e.message, 'err');
        }
    }

    // ---------- 导入 PR 项目面板 ----------
    function importToPR(f) {
        if (busy) return;
        busy = true;
        setStatus('正在导入: ' + f.name + ' ...', '');
        var payloadJson = JSON.stringify([f.fullPath]);
        var setScript = 'sfxImportPayload = ' + payloadJson + ';';
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('sfxImportToBinStr()', function (result) {
                busy = false;
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setStatus('已导入「音效库」素材箱：' + data.imported.join('、'), 'ok');
                    } else {
                        setStatus(data.error || '导入失败', 'err');
                    }
                } catch (e) {
                    setStatus('导入解析失败: ' + result, 'err');
                }
            });
        });
    }

    // ---------- 浏览目录（PowerShell 文件夹选择器，UTF-8 临时文件规避中文乱码）----------
    function browseDir() {
        if (busy) return;
        var iniDir = el.dir.value.trim();
        if (!iniDir) {
            try { iniDir = localStorage.getItem('sfxDir') || ''; } catch (e) {}
        }
        if (!iniDir) iniDir = os.homedir();

        var tmpIn = path.join(os.tmpdir(), 'sfx_browse_in.txt');
        var tmpOut = path.join(os.tmpdir(), 'sfx_browse_out.txt');
        try { fs.writeFileSync(tmpIn, iniDir, 'utf8'); } catch (e) {}

        var ps = [
            '$ErrorActionPreference="Stop";',
            '$in = [System.IO.File]::ReadAllText("' + tmpIn.replace(/\\/g, '\\\\') + '", [System.Text.Encoding]::UTF8);',
            'Add-Type -AssemblyName System.Windows.Forms;',
            '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
            '$d.Description = "选择音效库文件夹";',
            'if ($in -and (Test-Path -LiteralPath $in)) { $d.SelectedPath = $in };',
            '$r = $d.ShowDialog();',
            'if ($r -eq [System.Windows.Forms.DialogResult]::OK) {',
            '  [System.IO.File]::WriteAllText("' + tmpOut.replace(/\\/g, '\\\\') + '", $d.SelectedPath, [System.Text.Encoding]::UTF8);',
            '}'
        ].join('\n');

        setStatus('正在打开文件夹选择器...', '');
        var cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "' + ps.replace(/"/g, '\\"') + '"';
        require('child_process').exec(cmd, { timeout: 120000, maxBuffer: 1024 * 1024 }, function (err) {
            if (err) { setStatus('选择器打开失败: ' + err.message, 'err'); return; }
            try {
                if (fs.existsSync(tmpOut)) {
                    var chosen = fs.readFileSync(tmpOut, 'utf8').trim();
                    fs.unlinkSync(tmpOut);
                    if (chosen) {
                        el.dir.value = chosen;
                        try { localStorage.setItem('sfxDir', chosen); } catch (e) {}
                        setStatus('已选择目录: ' + chosen, 'ok');
                        return;
                    }
                }
                setStatus('未选择目录（已取消）', '');
            } catch (e) {
                setStatus('读取选择结果失败: ' + e.message, 'err');
            }
        });
    }

    // ---------- 事件绑定 ----------
    el.browse.addEventListener('click', browseDir);
    el.scan.addEventListener('click', doScan);
    el.search.addEventListener('input', renderList);
    el.btnAll.addEventListener('click', function () {
        filterFav = false;
        el.btnAll.classList.add('on');
        el.btnFav.classList.remove('on');
        renderList();
    });
    el.btnFav.addEventListener('click', function () {
        filterFav = true;
        el.btnFav.classList.add('on');
        el.btnAll.classList.remove('on');
        renderList();
    });
    el.player.addEventListener('ended', function () {
        playingPath = null;
        renderList();
    });
    el.player.addEventListener('error', function () {
        playingPath = null;
        renderList();
    });

    // ---------- 初始化 ----------
    loadFavs();
    try {
        var savedDir = localStorage.getItem('sfxDir');
        if (savedDir) el.dir.value = savedDir;
    } catch (e) {}
})();
