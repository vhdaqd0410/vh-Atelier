// vh-Atelier 板块：音乐（网易云音乐）
// 架构：插件壳（本文件） + 本地 Node 服务（ncm/index.js，跑 NeteaseCloudMusicApi）
// 能力：扫码登录 / 搜索歌曲与歌单 / 我的歌单 / 试听 / 下载到本地 / 一键导入 PR「音乐」素材箱
// 说明：服务由本面板自举（检测端口探活，没跑则 spawn node），不再依赖 bg.js 是否重载。
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    var API = 'http://127.0.0.1:17890';
    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
    var musicDir = path.join(extRoot, 'collect', 'music');   // 兜底目录（未设音乐库时的默认）
    var ncmDir = path.join(extRoot, 'ncm');
    var ncmIndex = path.join(ncmDir, 'index.js');
    var ncmChild = null;

    // ---- 下载到音乐库 - 状态 ----
    var DL_DIR_KEY = 'vh_music_dl_dir';   // 上次下载保存目录（绝对路径）
    var selSet = {};                       // 批量下载多选：songId -> song
    var dlState = {};                      // 已下载记录：songId -> {dest}（本次会话内）

    // ---- 识别历史 - 状态 ----
    var IDENTIFY_HISTORY_KEY = 'vh_identify_history';
    var identifyHistoryShown = false;
    // ---- 识别进行中状态 ----
    var identifyActive = false;      // 是否正在识别（边听边识别循环中）
    var identifyStop = false;        // 用户点了停止
    var identifyRound = 0;           // 当前第几轮录音
    var identifyCache = [];          // 最近一次识别到的结果（song 对象数组）
    function loadIdentifyHistory() {
        try { return JSON.parse(localStorage.getItem(IDENTIFY_HISTORY_KEY) || '[]'); } catch (e) { return []; }
    }
    function saveIdentifyHistory(h) {
        try { localStorage.setItem(IDENTIFY_HISTORY_KEY, JSON.stringify(h)); } catch (e) {}
    }
    function addIdentifyHistory(song) {
        var h = loadIdentifyHistory();
        var nm = song.name || '';
        var ar = (song.artists || []).map(function (a) { return a.name; }).join(', ');
        h = h.filter(function (x) { return x.id !== song.id; });   // 去重：同歌顶到最前
        h.unshift({ id: song.id, name: nm, artist: ar, t: Date.now() });
        if (h.length > 20) h = h.slice(0, 20);
        saveIdentifyHistory(h);
    }

    // 轻提示（若全局无 __copyFlash 则本地兜底）
    function flash(msg) {
        if (window.__copyFlash) { try { window.__copyFlash(msg); } catch (e) {} return; }
        try {
            var tip = document.createElement('div');
            tip.textContent = msg;
            tip.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);background:#2a3a2a;color:#7fd68b;padding:6px 14px;border-radius:6px;font-size:12px;z-index:1001;pointer-events:none;';
            document.body.appendChild(tip);
            setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 2000);
        } catch (e2) {}
    }

    // 下载保存目录逻辑：优先音乐库根（localStorage mllibDir），无则 collect/music
    function getMusicLibRoot() {
        try {
            var p = localStorage.getItem('mllibDir');
            if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
        } catch (e) {}
        return null;
    }
    // 当前下载目录 = 记忆的下载目录（若还指向音乐库内）否则音乐库根，再否则 collect/music
    function getDlDir() {
        try {
            var mem = localStorage.getItem(DL_DIR_KEY);
            if (mem && fs.existsSync(mem) && fs.statSync(mem).isDirectory()) return mem;
        } catch (e) {}
        var root = getMusicLibRoot();
        if (root) return root;
        return musicDir;
    }
    function setDlDir(p) {
        try { localStorage.setItem(DL_DIR_KEY, p); } catch (e) {}
    }
    // 音乐库根目录下的一级子目录列表（用于选下载位置）
    function listMusicSubdirs() {
        var root = getMusicLibRoot();
        var out = [];
        if (root) {
            try {
                fs.readdirSync(root, { withFileTypes: true }).forEach(function (it) {
                    if (it.isDirectory()) out.push(path.join(root, it.name));
                });
            } catch (e) {}
        }
        return out.sort();
    }

    var LOGIN_STATE = { 800: '二维码已过期', 801: '等待扫码', 802: '已扫码，请在手机上确认', 803: '登录成功' };

    var qrTimer = null;
    var currentQrKey = '';
    var currentList = [];   // 当前列表（歌曲或歌单）
    var currentMode = '';   // 'songs' | 'playlists' | 'myPlaylist'

    // 播放队列
    var playQueue = [];   // 当前可播放的歌曲列表（song 对象数组）
    var playIndex = -1;   // 当前播放索引
    var nowPlaying = null; // 当前播放的歌曲对象
    // 播放模式：'list' = 列表循环，'order' = 顺序播放，'one' = 单曲循环，'random' = 随机播放
    var playMode = 'list';
    var MODE_TITLES = { list: '列表循环', order: '顺序播放', one: '单曲循环', random: '随机播放' };
    // 歌词
    var lyricLines = [];      // [{time: 秒, text: '...'}, ...]
    var lyricActiveIdx = -1;
    var lyricShown = false;

    // 登录态
    var loggedIn = false;
    var account = null;

    var el = {};

    function $(id) { return document.getElementById(id); }

    function setStatus(msg, type) {
        var s = $('musicStatus');
        if (!s) return;
        s.textContent = msg || '';
        s.className = type || '';
    }

    function setServerState(msg, type) {
        var s = $('musicServerState');
        if (!s) return;
        s.textContent = msg || '';
        s.className = 'music-server ' + (type || '');
    }

    // ---------- fetch 封装 ----------
    function api(pathname) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', API + pathname, true);
            xhr.timeout = 8000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        resolve(data);
                    } catch (e) {
                        reject(new Error('响应解析失败'));
                    }
                }
            };
            xhr.onerror = function () { reject(new Error('无法连接本地服务')); };
            xhr.ontimeout = function () { reject(new Error('请求超时')); };
            xhr.send();
        });
    }

    function enc(v) { return encodeURIComponent(v); }

    // ---------- fetch 封装（POST，JSON body） ----------
    function apiPost(pathname, body) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', API + pathname, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.timeout = 10000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState === 4) {
                    try {
                        var data = JSON.parse(xhr.responseText);
                        resolve(data);
                    } catch (e) {
                        reject(new Error('响应解析失败'));
                    }
                }
            };
            xhr.onerror = function () { reject(new Error('无法连接本地服务')); };
            xhr.ontimeout = function () { reject(new Error('请求超时')); };
            xhr.send(JSON.stringify(body || {}));
        });
    }

    // ---------- 服务自举 ----------
    function findNode() {
        var candidates = [
            'C:\\Program Files\\nodejs\\node.exe',
            'C:\\Program Files (x86)\\nodejs\\node.exe'
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (fs.existsSync(candidates[i])) return candidates[i];
        }
        try {
            var which = childProcess.spawnSync('where', ['node'], { encoding: 'utf8' });
            if (which.status === 0 && which.stdout) {
                var first = which.stdout.split('\n')[0].trim();
                if (first) return first;
            }
        } catch (e) {}
        return null;
    }

    function spawnNcm() {
        try {
            if (!fs.existsSync(ncmIndex)) {
                setStatus('本地服务文件缺失: ' + ncmIndex, 'err');
                setServerState('服务文件缺失', 'err');
                return false;
            }
            var node = findNode();
            if (!node) {
                setStatus('未找到 node.exe，请安装 Node.js', 'err');
                setServerState('未找到 Node', 'err');
                return false;
            }
            if (ncmChild) return true; // 已拉起过
            setServerState('正在启动服务...', '');
            ncmChild = childProcess.spawn(node, [ncmIndex], { cwd: ncmDir, windowsHide: true });
            ncmChild.on('error', function (e) { setServerState('启动失败', 'err'); ncmChild = null; });
            ncmChild.on('close', function () { ncmChild = null; });
            return true;
        } catch (e) {
            setServerState('启动异常', 'err');
            return false;
        }
    }

    // 探测服务，没跑就拉起；返回 Promise<health>
    function ensureServer(retries) {
        var tries = retries || 0;
        return api('/health').then(function (h) {
            return h;
        }).catch(function () {
            if (tries < 1) {
                spawnNcm();
                // 等 2 秒再探一次
                return new Promise(function (resolve) {
                    setTimeout(function () {
                        resolve(ensureServer(tries + 1));
                    }, 2000);
                });
            }
            throw new Error('服务启动失败，请检查 Node.js 安装');
        });
    }

    // ---------- 服务健康检测 ----------
    function checkServer() {
        return api('/health');
    }

    // ---------- 登录流程 ----------
    function showLogin() {
        $('musicLogin').style.display = '';
        $('musicHome').style.display = 'none';
        loggedIn = false;
    }

    function showHome() {
        $('musicLogin').style.display = 'none';
        $('musicHome').style.display = '';
        loggedIn = true;
    }

    function stopQrPoll() {
        if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
    }

    async function startLogin() {
        stopQrPoll();
        setServerState('连接服务...', '');
        try {
            var health = await ensureServer();
            if (!health || health.alive !== true) throw new Error('服务未就绪');
            setServerState('服务运行中', 'ok');

            // 已有登录态则直接进主视图
            if (health.logged) {
                await loadAccount();
                if (loggedIn) return;
                // logged 但账号拿不到，回退到扫码
            }
            await fetchQr();
        } catch (e) {
            setServerState('服务连接失败', 'err');
            setStatus('本地音乐服务未启动，请重启 PR 或联系排查。' + e.message, 'err');
        }
    }

    async function fetchQr() {
        try {
            var keyRes = await api('/login/qr/key');
            var unikey = keyRes && keyRes.data && keyRes.data.unikey;
            if (!unikey) throw new Error('获取登录 key 失败');

            var qrRes = await api('/login/qr/create?key=' + enc(unikey));
            var qrimg = qrRes && qrRes.data && qrRes.data.qrimg;
            if (!qrimg) throw new Error('生成二维码失败');

            currentQrKey = unikey;
            var img = $('musicQr');
            img.src = qrimg;
            img.style.display = '';
            $('musicQrHint').style.display = 'none';
            $('btnMusicRefreshQr').disabled = false;
            setStatus('请用网易云音乐 App 扫码', '');
            pollQr(unikey);
        } catch (e) {
            setStatus('二维码获取失败: ' + e.message, 'err');
            $('musicQrHint').style.display = '';
            $('musicQrHint').textContent = '获取二维码失败，点刷新重试';
            $('btnMusicRefreshQr').disabled = false;
        }
    }

    function pollQr(unikey) {
        stopQrPoll();
        qrTimer = setInterval(async function () {
            try {
                var r = await api('/login/qr/check?key=' + enc(unikey));
                if (!r) return;
                var code = r.code;
                if (code === 803) {
                    stopQrPoll();
                    setStatus('登录成功', 'ok');
                    await loadAccount();
                    return;
                }
                if (code === 800) {
                    setStatus('二维码已过期，请刷新', 'err');
                } else if (code === 801) {
                    // 等待扫码
                } else if (code === 802) {
                    setStatus('已扫码，请在手机上确认', '');
                }
            } catch (e) {}
        }, 2000);
    }

    async function loadAccount() {
        try {
            var r = await api('/user/account');
            if (r && r.code === 200 && r.account) {
                account = r.account;
                var profile = r.profile || {};
                $('musicNick').textContent = profile.nickname || '已登录';
                if (profile.avatarUrl) $('musicAvatar').src = profile.avatarUrl;
                showHome();
                loadMyPlaylist();
                return;
            }
        } catch (e) {}
        // 拿不到账号，回扫码
        showLogin();
    }

    // ---------- 搜索 ----------
    async function doSearch() {
        var q = $('musicQuery').value.trim();
        if (!q) { setStatus('请输入搜索词', 'err'); return; }
        var type = $('musicType').value;
        $('btnMusicBack').style.display = '';
        if (type === '1000') {
            currentMode = 'playlists';
            setStatus('搜索歌单中...', '');
            try {
                var r = await api('/search?keywords=' + enc(q) + '&type=1000&limit=30');
                var lists = r && r.result && r.result.playlists || [];
                renderPlaylistList(lists);
                setStatus('找到 ' + lists.length + ' 个歌单', lists.length ? 'ok' : '');
            } catch (e) { setStatus('搜索失败: ' + e.message, 'err'); }
        } else {
            currentMode = 'songs';
            setStatus('搜索歌曲中...', '');
            try {
                var r2 = await api('/search?keywords=' + enc(q) + '&type=1&limit=40');
                var songs = r2 && r2.result && r2.result.songs || [];
                renderSongList(songs);
                setStatus('找到 ' + songs.length + ' 首歌', songs.length ? 'ok' : '');
            } catch (e) { setStatus('搜索失败: ' + e.message, 'err'); }
        }
    }

    // ---------- 我的歌单 ----------
    async function loadMyPlaylist() {
        setStatus('加载我的歌单...', '');
        currentMode = 'myPlaylist';
        $('btnMusicBack').style.display = 'none';
        try {
            var uid = account && account.id ? account.id : '';
            var r = await api('/user/playlist?uid=' + enc(String(uid)));
            var lists = r && r.playlist || [];
            renderPlaylistList(lists);
            setStatus('共 ' + lists.length + ' 个歌单', '');
        } catch (e) { setStatus('歌单加载失败: ' + e.message, 'err'); }
    }

    // ---------- 打开歌单 ----------
    async function openPlaylist(id, name) {
        setStatus('加载歌单「' + name + '」...', '');
        try {
            var r = await api('/playlist/detail?id=' + enc(String(id)));
            var tracks = r && r.playlist && r.playlist.tracks || [];
            currentMode = 'songs';
            $('btnMusicBack').style.display = '';
            renderSongList(tracks.map(function (t) {
                return {
                    id: t.id,
                    name: t.name,
                    artists: t.ar || t.artists || [],
                    album: t.al || t.album || {}
                };
            }));
            setStatus('歌单「' + name + '」共 ' + tracks.length + ' 首', 'ok');
        } catch (e) { setStatus('歌单打开失败: ' + e.message, 'err'); }
    }

    // ---------- 渲染 ----------
    function renderPlaylistList(lists) {
        currentList = lists;
        var box = $('musicList');
        box.innerHTML = '';
        if (!lists.length) {
            box.innerHTML = '<div class="music-empty">没有歌单</div>';
            return;
        }
        lists.forEach(function (p) {
            var row = document.createElement('div');
            row.className = 'music-item';
            row.style.cursor = 'pointer';
            // 双击进入歌单
            row.addEventListener('dblclick', function () { openPlaylist(p.id, p.name); });

            var cover = document.createElement('img');
            cover.className = 'cover';
            cover.src = (p.coverImgUrl || p.picUrl || '');
            cover.onerror = function () { this.style.visibility = 'hidden'; };

            var info = document.createElement('div');
            info.className = 'info';
            var t = document.createElement('div');
            t.className = 'title';
            t.textContent = p.name;
            var s = document.createElement('div');
            s.className = 'sub';
            s.textContent = (p.trackCount != null ? p.trackCount + ' 首 · ' : '') + (p.creator && p.creator.nickname ? p.creator.nickname : '');
            info.appendChild(t); info.appendChild(s);

            var btn = document.createElement('button');
            btn.className = 'mbtn';
            btn.textContent = '打开';
            btn.addEventListener('click', function () { openPlaylist(p.id, p.name); });

            var btn = document.createElement('button');
            btn.className = 'mbtn';
            btn.textContent = '打开';
            btn.addEventListener('click', function () { openPlaylist(p.id, p.name); });

            var dlBtn = document.createElement('button');
            dlBtn.className = 'mbtn dl';
            dlBtn.textContent = '下载';
            dlBtn.title = '下载整个歌单（会先询问存放位置）';
            dlBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                downloadPlaylist(p.id, p.name);
            });

            row.appendChild(cover); row.appendChild(info); row.appendChild(btn); row.appendChild(dlBtn);
            box.appendChild(row);
        });
    }

    // ---------- 歌单一键下载（先询问存放位置） ----------
    function downloadPlaylist(pid, pname) {
        setStatus('加载歌单「' + pname + '」...', '');
        api('/playlist/detail?id=' + enc(String(pid))).then(function (r) {
            var tracks = r && r.playlist && r.playlist.tracks || [];
            if (!tracks.length) { setStatus('歌单为空', 'warn'); return; }
            // 询问存放位置（目录树弹窗）
            chooseDlDir(function (dir) {
                if (!dir) return;
                setDlDir(dir);
                refreshDlDirLabel();
                setStatus('开始下载歌单「' + pname + '」共 ' + tracks.length + ' 首...', '');
                var i = 0;
                function next() {
                    if (i >= tracks.length) {
                        setStatus('歌单「' + pname + '」下载完成：' + tracks.length + ' 首', 'ok');
                        return;
                    }
                    var t = tracks[i++];
                    var nm = t.name || '';
                    var ar = (t.ar || t.artists || []).map(function (a) { return a.name; }).join(' / ');
                    setStatus('下载歌单 [' + i + '/' + tracks.length + '] ' + nm + ' ...', '');
                    downloadSong(t.id, nm, ar, dir, next);
                }
                next();
            });
        }).catch(function (e) {
            setStatus('歌单加载失败: ' + e.message, 'err');
        });
    }

    function renderSongList(songs) {
        currentList = songs;
        // 新列表清空旧勾选
        selSet = {};
        refreshSelUI();
        // 建立播放队列（歌曲列表）
        playQueue = songs;
        var box = $('musicList');
        box.innerHTML = '';
        if (!songs.length) {
            box.innerHTML = '<div class="music-empty">没有结果</div>';
            return;
        }
        songs.forEach(function (s, idx) {
            var sid = String(s.id);
            var row = document.createElement('div');
            row.className = 'music-item';
            row.dataset.idx = String(idx);
            row.dataset.sid = sid;
            row.style.cursor = 'pointer';
            // 双击整行播放
            row.addEventListener('dblclick', function () { playFromQueue(idx, null); });

            // 多选（批量下载用）
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'mchk';
            cb.style.cssText = 'flex:0 0 auto;accent-color:var(--accent,#537d96);cursor:pointer;';
            cb.checked = !!selSet[sid];
            cb.addEventListener('click', function (ev) { ev.stopPropagation(); });
            cb.addEventListener('change', function () {
                if (cb.checked) selSet[sid] = s; else delete selSet[sid];
                refreshSelUI();
            });

            var cover = document.createElement('img');
            cover.className = 'cover';
            var albPic = (s.album && (s.album.picUrl || s.album.artist && s.album.artist.img1v1Url)) || '';
            cover.src = albPic || '';
            cover.onerror = function () { this.style.visibility = 'hidden'; };

            var info = document.createElement('div');
            info.className = 'info';
            var t = document.createElement('div');
            t.className = 'title';
            t.textContent = s.name;
            var artistNames = (s.artists || []).map(function (a) { return a.name; }).join(' / ');
            var subText = artistNames + (s.album && s.album.name ? ' · ' + s.album.name : '');
            var st = document.createElement('div');
            st.className = 'sub';
            st.textContent = subText;
            info.appendChild(t); info.appendChild(st);

            var playBtn = document.createElement('button');
            playBtn.className = 'mbtn';
            playBtn.textContent = '试听';
            playBtn.dataset.sid = sid;
            playBtn.dataset.idx = String(idx);
            playBtn.addEventListener('click', function () { playFromQueue(idx, playBtn); });

            var dlBtn = document.createElement('button');
            dlBtn.className = 'mbtn dl';
            dlBtn.textContent = '下载';
            dlBtn.dataset.sid = sid;
            dlBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                // 若本会话已下载过，点它弹菜单；否则直接下载（默认存上次目录）
                if (dlState[sid]) {
                    showDownloadedMenu(sid, dlState[sid].dest, dlBtn, ev);
                } else {
                    downloadSong(s.id, s.name, artistNames);
                }
            });

            row.appendChild(cb); row.appendChild(cover); row.appendChild(info); row.appendChild(playBtn); row.appendChild(dlBtn);
            box.appendChild(row);

            // 拖拽：已下载的歌可直接拖进 PR；未下载则提示先下载
            row.setAttribute('draggable', 'true');
            row.addEventListener('dragstart', function (ev) {
                if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON' || ev.target.tagName === 'IMG')) {
                    ev.preventDefault();
                    return;
                }
                var dest = row.dataset.dest || (dlState[sid] && dlState[sid].dest);
                if (!dest || !fs.existsSync(dest)) {
                    ev.preventDefault();
                    flash('请先点「下载」下载这首歌，才能拖入 PR');
                    return;
                }
                ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', dest);
                ev.dataTransfer.setData('text/plain', dest);
                ev.dataTransfer.effectAllowed = 'copy';
            });
            // 拖拽结束（放下）：若正在播放则暂停（与音效/音乐库行为一致）
            row.addEventListener('dragend', function (ev) {
                try {
                    var a2 = getAudio();
                    if (a2 && !a2.paused && a2.src) a2.pause();
                } catch (e) {}
            });

            // 若本会话已下载过该歌（切歌单/搜索回来），恢复已下载状态
            if (dlState[sid] && dlState[sid].dest) {
                var f = dlState[sid].dest;
                if (fs.existsSync(f)) {
                    dlBtn.textContent = '✓ 已下载';
                    dlBtn.classList.add('done');
                    dlBtn.title = f;
                    row.dataset.dest = f;
                }
            }
        });
    }

    // 批量选择 UI 刷新
    function refreshSelUI() {
        var cnt = Object.keys(selSet).length;
        var lb = $('musicSelCount');
        if (lb) lb.textContent = cnt ? ('已选 ' + cnt + ' 首') : '';
        var allBtn = $('btnMusicSelectAll');
        if (allBtn) allBtn.textContent = (currentList.length && cnt === currentList.length) ? '取消全选' : '全选';
    }

    // 批量下载：先选一次目录，再逐首严格串行下载
    function batchDownloadSelected() {
        var ids = Object.keys(selSet);
        if (!ids.length) { setStatus('请先勾选要下载的歌曲', 'warn'); return; }
        var songs = ids.map(function (k) { return selSet[k]; });
        chooseDlDir(function (dir) {
            if (!dir) return;
            setDlDir(dir);
            refreshDlDirLabel();
            setStatus('批量下载 ' + songs.length + ' 首到 ' + dir + ' ...', '');
            var i = 0;
            function next() {
                if (i >= songs.length) {
                    setStatus('批量下载完成：' + songs.length + ' 首已存入音乐库', 'ok');
                    // 下载完自动清空选择
                    selSet = {};
                    refreshSelUI();
                    var allBtn = $('btnMusicSelectAll');
                    if (allBtn) allBtn.textContent = '全选';
                    // 重置所有 checkbox
                    document.querySelectorAll('.music-item .mchk').forEach(function (c2) { c2.checked = false; });
                    return;
                }
                var s2 = songs[i++];
                var an = (s2.artists || []).map(function (a) { return a.name; }).join(' / ');
                setStatus('批量下载 ' + i + '/' + songs.length + '：' + s2.name + ' ...', '');
                downloadSong(s2.id, s2.name, an, dir, next);
            }
            next();
        });
    }

    // 全选 / 取消全选
    function toggleSelectAll() {
        if (!currentList || !currentList.length) return;
        var allSel = currentList.length && Object.keys(selSet).length === currentList.length;
        selSet = {};
        if (!allSel) {
            currentList.forEach(function (s) { selSet[String(s.id)] = s; });
        }
        refreshSelUI();
        document.querySelectorAll('.music-item .mchk').forEach(function (c2) {
            var row = c2.closest('.music-item');
            c2.checked = row && !!selSet[row.dataset.sid];
        });
    }

    // ---------- 播放器 ----------
    var audio = null;
    function getAudio() {
        if (!audio) audio = $('musicAudio');
        return audio;
    }

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        sec = Math.floor(sec);
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function updatePlayBtns() {
        // 同步列表里的试听按钮状态
        document.querySelectorAll('.music-item .mbtn.playing').forEach(function (b) { b.classList.remove('playing'); b.textContent = '试听'; });
        if (playIndex >= 0) {
            var cur = document.querySelector('.music-item .mbtn[data-idx="' + playIndex + '"]');
            if (cur) { cur.classList.add('playing'); cur.textContent = '暂停'; }
        }
        // 同步播放条按钮
        var a = getAudio();
        var btn = $('btnMusicPlayPause');
        var playing = (!a.paused && a.src);
        var playIcon = btn.querySelector('.ic-play');
        var pauseIcon = btn.querySelector('.ic-pause');
        if (playIcon && pauseIcon) {
            playIcon.style.display = playing ? 'none' : 'block';
            pauseIcon.style.display = playing ? 'block' : 'none';
        }
        btn.title = playing ? '暂停' : '播放';
    }

    function updatePlayerInfo(song) {
        var artist = (song.artists || []).map(function (a) { return a.name; }).join(' / ');
        $('mpTitle').textContent = song.name || '';
        $('mpSub').textContent = artist;
        // 封面
        var albPic = (song.album && (song.album.picUrl || song.album.artist && song.album.artist.img1v1Url)) || '';
        var coverEl = $('mpCover');
        if (albPic) {
            coverEl.src = albPic;
            coverEl.style.visibility = 'visible';
        } else {
            coverEl.src = '';
            coverEl.style.visibility = 'hidden';
        }
    }

    // 播放模式 SVG 图标（Feather 风格）
    var MODE_SVG = {
        list: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
        order: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
        one: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
        random: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>'
    };

    function updateModeBtn() {
        var btn = $('btnMusicMode');
        btn.innerHTML = MODE_SVG[playMode] || MODE_SVG.list;
        btn.title = MODE_TITLES[playMode] || MODE_TITLES.list;
        if (playMode !== 'order') btn.classList.add('active');
        else btn.classList.remove('active');
    }

    function cycleMode() {
        if (playMode === 'list') playMode = 'order';
        else if (playMode === 'order') playMode = 'one';
        else if (playMode === 'one') playMode = 'random';
        else playMode = 'list';
        updateModeBtn();
        setStatus(MODE_TITLES[playMode], '');
    }

    // 下载当前正在播放的歌曲
    function downloadCurrent() {
        if (!nowPlaying) { setStatus('当前没有在播放的歌曲', 'err'); return; }
        var artist = (nowPlaying.artists || []).map(function (a) { return a.name; }).join(' / ');
        downloadSong(nowPlaying.id, nowPlaying.name, artist);
    }

    // ---------- 歌词 ----------
    // 解析 LRC 文本 → [{time, text}]
    function parseLrc(lrcText) {
        var lines = [];
        if (!lrcText) return lines;
        var raw = lrcText.split('\n');
        raw.forEach(function (line) {
            // 匹配 [mm:ss.xx] 多个时间标签
            var re = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
            var times = [];
            var m;
            while ((m = re.exec(line)) !== null) {
                var min = parseInt(m[1], 10);
                var sec = parseInt(m[2], 10);
                var frac = m[3] ? parseInt(m[3], 10) : 0;
                if (m[3] && m[3].length === 1) frac *= 100;
                else if (m[3] && m[3].length === 2) frac *= 10;
                times.push(min * 60 + sec + frac / 1000);
            }
            var text = line.replace(/\[[^\]]*\]/g, '').trim();
            if (!text) return;
            times.forEach(function (t) {
                lines.push({ time: t, text: text });
            });
        });
        lines.sort(function (a, b) { return a.time - b.time; });
        return lines;
    }

    function renderLyric() {
        var body = $('lyricBody');
        body.innerHTML = '';
        lyricActiveIdx = -1;
        lyricLines.forEach(function (l, i) {
            var div = document.createElement('div');
            div.className = 'lyric-line';
            div.dataset.idx = String(i);
            div.textContent = l.text;
            body.appendChild(div);
        });
        // 回到顶部
        body.style.transform = 'translateY(0)';
    }

    function setLyricActive(idx) {
        if (idx === lyricActiveIdx) return;
        // 取消旧高亮
        var oldEl = document.querySelector('.lyric-line.active');
        if (oldEl) oldEl.classList.remove('active');
        lyricActiveIdx = idx;
        if (idx < 0) return;
        var el = document.querySelector('.lyric-line[data-idx="' + idx + '"]');
        if (!el) return;
        el.classList.add('active');
        // 让当前行居中：lyricBody 顶部停在 panel 正中（top:50%），
        // 所以平移量 = 负的（行偏移 + 半行高）
        var lineH = el.offsetHeight || 26;
        var offset = -(el.offsetTop + lineH / 2);
        var body = $('lyricBody');
        body.style.transform = 'translateY(' + offset + 'px)';
    }

    // 根据当前播放时间定位歌词行
    function syncLyric() {
        if (!lyricLines.length) return;
        var a = getAudio();
        var t = a.currentTime || 0;
        var idx = -1;
        for (var i = 0; i < lyricLines.length; i++) {
            if (lyricLines[i].time <= t) idx = i;
            else break;
        }
        setLyricActive(idx);
    }

    async function loadLyric() {
        if (!nowPlaying) return;
        try {
            var r = await api('/lyric?id=' + enc(String(nowPlaying.id)));
            var lrc = r && r.lrc && r.lrc.lyric;
            if (!lrc) {
                lyricLines = [];
                renderLyric();
                $('lyricBody').innerHTML = '<div class="lyric-line">纯音乐，暂无歌词</div>';
                return;
            }
            lyricLines = parseLrc(lrc);
            renderLyric();
            syncLyric();
        } catch (e) {
            lyricLines = [];
            renderLyric();
            $('lyricBody').innerHTML = '<div class="lyric-line">歌词加载失败</div>';
        }
    }

    function toggleLyric() {
        lyricShown = !lyricShown;
        var panel = $('musicLyric');
        var btn = $('btnMusicLyric');
        if (lyricShown) {
            panel.style.display = '';
            btn.classList.add('active');
            if (nowPlaying && !lyricLines.length) loadLyric();
        } else {
            panel.style.display = 'none';
            btn.classList.remove('active');
        }
    }

    async function playFromQueue(idx, btn) {
        var song = playQueue[idx];
        if (!song) return;
        var a = getAudio();
        // 同曲：切换播放/暂停
        if (playIndex === idx && a.src && !a.paused) {
            a.pause();
            updatePlayBtns();
            return;
        }
        if (playIndex === idx && a.src && a.paused) {
            a.play();
            updatePlayBtns();
            return;
        }
        // 切歌
        try {
            setStatus('获取播放源...', '');
            var r = await api('/song/url?id=' + enc(String(song.id)) + '&br=320000');
            var url = r && r.data && r.data[0] && r.data[0].url;
            if (!url) { setStatus('该歌曲无播放源（可能是 VIP 或版权限制）', 'err'); return; }
            a.src = url;
            a.play();
            playIndex = idx;
            nowPlaying = song;
            updatePlayerInfo(song);
            updatePlayBtns();
            setStatus('正在播放', 'ok');
            // 歌词面板开着就加载新歌歌词
            if (lyricShown) loadLyric();
        } catch (e) { setStatus('播放失败: ' + e.message, 'err'); }
    }

    function playNext() {
        if (playQueue.length === 0) return;
        // 单曲循环：重播当前
        if (playMode === 'one') {
            var cur = playIndex >= 0 ? playIndex : 0;
            playFromQueue(cur, null);
            return;
        }
        // 随机播放：随机挑一首
        if (playMode === 'random') {
            var ri;
            if (playQueue.length === 1) {
                ri = 0;
            } else {
                do { ri = Math.floor(Math.random() * playQueue.length); } while (ri === playIndex);
            }
            playFromQueue(ri, null);
            return;
        }
        var next = playIndex + 1;
        if (next >= playQueue.length) {
            if (playMode === 'order') { return; } // 顺序播放：播完停止
            next = 0; // 列表循环
        }
        playFromQueue(next, null);
    }

    function playPrev() {
        if (playQueue.length === 0) return;
        // 随机播放：上一首也是随机
        if (playMode === 'random') {
            var ri;
            if (playQueue.length === 1) { ri = 0; }
            else { do { ri = Math.floor(Math.random() * playQueue.length); } while (ri === playIndex); }
            playFromQueue(ri, null);
            return;
        }
        var prev = playIndex - 1;
        if (prev < 0) prev = playQueue.length - 1;
        playFromQueue(prev, null);
    }

    function togglePlayPause() {
        var a = getAudio();
        if (!a.src) {
            // 无歌，播放第一首
            if (playQueue.length) playFromQueue(0, null);
            return;
        }
        if (a.paused) { a.play(); }
        else { a.pause(); }
        updatePlayBtns();
    }

    // ---------- 音量 ----------
    var lastVolume = 0.8;
    function setVolume(v) {
        var a = getAudio();
        a.volume = v;
        var slider = $('musicVol');
        if (slider) slider.value = String(v);
        updateVolIcon();
    }

    function updateVolIcon() {
        var a = getAudio();
        var muted = (a.volume === 0 || a.muted);
        var onIcon = document.querySelector('#btnMusicVol .ic-vol-on');
        var offIcon = document.querySelector('#btnMusicVol .ic-vol-off');
        if (onIcon && offIcon) {
            onIcon.style.display = muted ? 'none' : 'block';
            offIcon.style.display = muted ? 'block' : 'none';
        }
        $('btnMusicVol').title = muted ? '取消静音' : '静音';
    }

    function toggleMute() {
        var a = getAudio();
        if (a.volume > 0 && !a.muted) {
            lastVolume = a.volume;
            a.volume = 0;
        } else {
            a.volume = lastVolume > 0 ? lastVolume : 0.8;
        }
        var slider = $('musicVol');
        if (slider) slider.value = String(a.volume);
        updateVolIcon();
    }

    // 监听播放事件
    function bindAudioEvents() {
        var a = getAudio();
        a.addEventListener('timeupdate', function () {
            if (a.duration) {
                $('mpCur').textContent = fmtTime(a.currentTime);
                $('mpDur').textContent = fmtTime(a.duration);
                var pct = (a.currentTime / a.duration) * 100;
                $('mpSeekFill').style.width = pct + '%';
            }
            if (lyricShown) syncLyric();
        });
        a.addEventListener('loadedmetadata', function () {
            $('mpDur').textContent = fmtTime(a.duration);
        });
        a.addEventListener('play', function () { updatePlayBtns(); });
        a.addEventListener('pause', function () { updatePlayBtns(); });
        a.addEventListener('ended', function () {
            // 顺序播放播完最后一首：停在结尾，复位按钮
            if (playMode === 'order' && playIndex >= playQueue.length - 1) {
                playIndex = -1;
                nowPlaying = null;
                updatePlayBtns();
                setStatus('已播放完列表', '');
                return;
            }
            playNext();
        });
        a.addEventListener('error', function () {
            setStatus('播放失败', 'err');
            playIndex = -1;
            nowPlaying = null;
            updatePlayBtns();
        });
    }

    // 点击进度条跳转
    function bindSeek() {
        var bar = $('mpSeek');
        bar.addEventListener('click', function (ev) {
            var a = getAudio();
            if (!a.duration) return;
            var rect = bar.getBoundingClientRect();
            var pct = (ev.clientX - rect.left) / rect.width;
            if (pct < 0) pct = 0; if (pct > 1) pct = 1;
            a.currentTime = pct * a.duration;
        });
    }

    // ---------- 下载到音乐库 ----------
    // 单首下载：默认存到 getDlDir()（上次目录/音乐库根），destDir 可指定；cb 下载流程结束回调；songObj 可选完整歌曲对象（用于标记已下载/加歌单）
    function downloadSong(songId, name, artist, destDir, cb, songObj) {
        var dir = destDir || getDlDir();
        setStatus('获取下载链接...', '');
        api('/song/url?id=' + enc(String(songId)) + '&br=320000').then(function (r) {
            var url = r && r.data && r.data[0] && r.data[0].url;
            if (!url) {
                setStatus('该歌曲无下载源（可能是 VIP 或版权限制）', 'err');
                if (cb) cb(false);
                return;
            }
            setStatus('正在下载: ' + name + ' ...', '');
            downloadViaNode(url, name, artist, dir, songId, cb, songObj);
        }).catch(function (e) {
            setStatus('下载失败: ' + e.message, 'err');
            if (cb) cb(false);
        });
    }

    // 通过面板 Node 侧下载文件（CEF 的 fetch 拿二进制不可靠，用 Node http/https 下载）
    function downloadViaNode(url, name, artist, dir, songId, cb, songObj) {
        var safe = safeName(artist + ' - ' + name);
        var dest = path.join(dir, safe + '.mp3');
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (e) { setStatus('创建目录失败: ' + e.message, 'err'); if (cb) cb(false); return; }

        var https = require('https');
        var http = require('http');
        var mod = url.indexOf('https://') === 0 ? https : http;
        setStatus('正在下载: ' + name + ' ...', '');
        var done = false;
        function finish(ok) {
            if (done) return;
            done = true;
            if (cb) cb(ok);
        }
        var req = mod.get(url, function (res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // 重定向
                downloadViaNode(res.headers.location, name, artist, dir, songId, cb);
                finish(false); // 原请求不再算
                return;
            }
            if (res.statusCode !== 200) { setStatus('下载失败，状态码 ' + res.statusCode, 'err'); finish(false); return; }
            var ws = fs.createWriteStream(dest);
            var total = parseInt(res.headers['content-length'] || '0', 10);
            var received = 0;
            res.on('data', function (chunk) {
                received += chunk.length;
                if (total > 0) setStatus('下载中: ' + Math.round(received / total * 100) + '%', '');
            });
            res.pipe(ws);
            ws.on('finish', function () {
                ws.close(function () {
                    setStatus('已下载: ' + safe + '.mp3', 'ok');
                    // 记录已下载，更新行内状态（替换顶部横幅）
                    if (songId) dlState[songId] = { dest: dest, name: name };
                    markRowDownloaded(songId, dest, safe);
                    // 若识别结果框里有这首歌的下载按钮，也标成已下载
                    markIdentifyDownloaded(songId, dest);
                    // 若音乐库 tab 开着，提示刷新可见（扫描目录即可看到）
                    var root = getMusicLibRoot();
                    var inLib = root && dest.indexOf(root) === 0;
                    if (inLib) {
                        flash('已存入音乐库 ✓ 可直接拖入时间线');
                        // 增量写入音乐库索引：不重扫全量，新歌下次打开音乐库直接可见
                        try {
                            if (window.__musiclibAddFiles) window.__musiclibAddFiles({ path: dest });
                        } catch (e2) {}
                    }
                    finish(true);
                });
            });
        });
        req.on('error', function (e) { setStatus('下载出错: ' + e.message, 'err'); finish(false); });
        req.setTimeout(60000, function () { req.abort(); setStatus('下载超时', 'err'); finish(false); });
    }

    // 更新歌行下载按钮 → 「已下载」状态（按钮右侧），点击可导入 PR / 换目录
    function markRowDownloaded(songId, dest, safe) {
        if (!songId) return;
        var row = document.querySelector('.music-item[data-sid="' + songId + '"]');
        if (!row) return;
        var dlBtn = row.querySelector('.mbtn.dl');
        if (!dlBtn) return;
        dlBtn.textContent = '✓ 已下载';
        dlBtn.classList.add('done');
        dlBtn.title = dest;
        // 整行可拖拽（已下载文件 → 拖入 PR）
        row.setAttribute('draggable', 'true');
        row.dataset.dest = dest;
        // 注：下载按钮的 click 在 renderSongList 里统一处理（已下载→弹菜单/未下载→下载）
    }

    // 识别结果框里的下载按钮 → 「已下载」状态（绿色），可再点弹菜单（导入/改目录）
    function markIdentifyDownloaded(songId, dest) {
        if (!songId) return;
        var box = $('musicIdentifyResult');
        if (!box) return;
        var btns = box.querySelectorAll('button[data-name][data-sid="' + songId + '"]');
        btns.forEach(function (b) {
            b.textContent = '✓ 已下载';
            b.style.background = '#1e3a33';
            b.style.color = '#7fd68b';
            b.dataset.dest = dest;
            // 改成弹菜单
            b.removeAttribute('data-name');
            b.addEventListener('click', function (ev) {
                ev.stopPropagation();
                showDownloadedMenu(songId, dest, b, ev);
            }, true);
        });
    }

    // ---------- 添加到歌单 ----------
    function addToPlaylist(song) {
        if (!song || !song.id) return;
        // 拉我的歌单列表
        setStatus('加载我的歌单...', '');
        var uid = account && account.id ? account.id : '';
        api('/user/playlist?uid=' + enc(String(uid))).then(function (r) {
            var lists = r && r.playlist || [];
            showAddToPlaylistDialog(song, lists);
        }).catch(function (e) {
            setStatus('歌单加载失败: ' + e.message, 'err');
        });
    }

    function showAddToPlaylistDialog(song, lists) {
        var old = document.getElementById('musicAddPlOv');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var ov = document.createElement('div');
        ov.id = 'musicAddPlOv';
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1002;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:16px;width:92%;max-width:420px;max-height:70vh;display:flex;flex-direction:column;font-size:12px;color:#ddd;';
        var tt = document.createElement('div');
        tt.style.cssText = 'font-size:13px;font-weight:600;color:#eee;margin-bottom:4px;';
        tt.textContent = '添加到歌单';
        box.appendChild(tt);
        var sub = document.createElement('div');
        sub.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:8px;';
        sub.textContent = '歌曲：' + (song.name || '') + ' ' + ((song.artists || []).map(function (a) { return a.name; }).join(' / '));
        box.appendChild(sub);

        var listBox = document.createElement('div');
        listBox.style.cssText = 'flex:1;overflow-y:auto;border:1px solid #333;border-radius:6px;padding:4px;min-height:140px;max-height:300px;';
        if (!lists.length) {
            listBox.innerHTML = '<div style="color:var(--muted);padding:8px;">还没有歌单，先创建一个</div>';
        } else {
            lists.forEach(function (p) {
                var row = document.createElement('div');
                row.style.cssText = 'padding:7px 10px;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:6px;';
                row.innerHTML = '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (p.name || '歌单') + '</span><span style="color:var(--muted);font-size:10px;">' + (p.trackCount != null ? p.trackCount + ' 首' : '') + '</span>';
                row.addEventListener('click', function () {
                    ov.remove();
                    doAddToPlaylist(p.id, song);
                });
                row.onmouseenter = function () { row.style.background = '#2a2a2a'; };
                row.onmouseleave = function () { row.style.background = ''; };
                listBox.appendChild(row);
            });
        }
        box.appendChild(listBox);

        var createBtn = document.createElement('button');
        createBtn.className = 'tbtn';
        createBtn.style.cssText = 'margin-top:8px;';
        createBtn.textContent = '＋ 新建歌单并添加';
        createBtn.addEventListener('click', function () {
            ov.remove();
            promptCreatePlaylist(song);
        });
        box.appendChild(createBtn);

        ov.appendChild(box);
        document.body.appendChild(ov);
        ov.addEventListener('click', function (e2) { if (e2.target === ov) ov.remove(); });
    }

    function promptCreatePlaylist(song) {
        var name = window.prompt('输入新歌单名称：', '');
        if (!name || !name.trim()) return;
        setStatus('创建歌单...', '');
        apiPost('/playlist/create', { name: name.trim() }).then(function (r) {
            var pid = r && r.id;
            if (r && r.playlist && r.playlist.id) pid = r.playlist.id;
            if (pid) {
                doAddToPlaylist(pid, song);
            } else {
                setStatus('创建歌单失败：' + ((r && r.msg) || '未知'), 'err');
            }
        }).catch(function (e) {
            setStatus('创建歌单失败: ' + e.message, 'err');
        });
    }

    function doAddToPlaylist(pid, song) {
        setStatus('添加歌曲到歌单...', '');
        apiPost('/playlist/track/add', { pid: String(pid), ids: String(song.id) }).then(function (r) {
            if (r && (r.code === 200 || r.body && r.body.code === 200)) {
                setStatus('已添加到歌单', 'ok');
                flash('已添加到歌单 ✓');
            } else {
                setStatus('添加失败：' + ((r && r.msg) || '未知'), 'err');
            }
        }).catch(function (e) {
            setStatus('添加失败: ' + e.message, 'err');
        });
    }

    // 已下载操作小菜单：导入 PR / 改存位置 / 打开目录
    function showDownloadedMenu(songId, dest, anchor, ev) {
        ev.stopPropagation();
        var old = document.getElementById('musicDlMenu');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        var menu = document.createElement('div');
        menu.id = 'musicDlMenu';
        menu.style.cssText = 'position:fixed;z-index:9999;min-width:170px;background:#2b2b2b;border:1px solid #444;border-radius:6px;padding:4px;box-shadow:0 6px 20px rgba(0,0,0,0.45);font-size:12px;';
        function mi(text, fn) {
            var d = document.createElement('div');
            d.style.cssText = 'padding:7px 12px;cursor:pointer;border-radius:4px;color:var(--text);white-space:nowrap;';
            d.textContent = text;
            d.addEventListener('click', function () { menu.remove(); fn(); });
            menu.appendChild(d);
            return d;
        }
        mi('📥 导入 PR 素材箱', function () { importToPR([dest]); });
        mi('📂 改存到其他目录…', function () { pickDlDirAndMove(songId, dest); });
        mi('🗂 在资源管理器显示', function () {
            try { childProcess.spawn('explorer.exe', ['/select,' + dest]); } catch (e) {}
        });
        document.body.appendChild(menu);
        var r = anchor.getBoundingClientRect();
        var x = r.left, y = r.bottom + 4;
        if (x + 180 > window.innerWidth) x = window.innerWidth - 185;
        menu.style.left = x + 'px'; menu.style.top = y + 'px';
        setTimeout(function () {
            var kill = function (e2) { if (!menu.contains(e2.target)) { menu.remove(); document.removeEventListener('click', kill); } };
            document.addEventListener('click', kill);
        }, 10);
    }

    // 改存位置：选择音乐库目录后把文件移过去
    function pickDlDirAndMove(songId, dest) {
        chooseDlDir(function (newDir) {
            if (!newDir || newDir === path.dirname(dest)) return;
            try {
                var nf = path.join(newDir, path.basename(dest));
                fs.renameSync(dest, nf);
                setDlDir(newDir);
                dlState[songId] = { dest: nf };
                var row = document.querySelector('.music-item[data-sid="' + songId + '"]');
                if (row) row.dataset.dest = nf;
                setStatus('已移动到: ' + nf, 'ok');
            } catch (e) {
                setStatus('移动失败: ' + e.message, 'err');
            }
        });
    }

    // 选下载目录弹窗（目录树样式，可逐层展开，支持新建子目录）
    function chooseDlDir(cb) {
        var root = getMusicLibRoot();
        if (!root) {
            // 没设音乐库目录：直接确认用默认目录
            cb(musicDir);
            return;
        }
        // 递归枚举目录树：返回 [{ abs, name, depth, children }]
        function buildDirTree(abs, depth, maxDepth) {
            var node = { abs: abs, name: depth === 0 ? path.basename(abs) : path.basename(abs), depth: depth, children: [] };
            if (depth >= (maxDepth || 6)) return node;
            try {
                fs.readdirSync(abs, { withFileTypes: true }).forEach(function (it) {
                    if (it.isDirectory()) {
                        var cabs = path.join(abs, it.name);
                        try {
                            node.children.push(buildDirTree(cabs, depth + 1, maxDepth));
                        } catch (e) {}
                    }
                });
            } catch (e) {}
            node.children.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
            return node;
        }
        var tree = buildDirTree(root, 0, 6);
        var curDl = getDlDir();
        var selected = { abs: curDl };

        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1001;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:16px;max-width:420px;width:92%;max-height:70vh;display:flex;flex-direction:column;font-size:12px;color:#ddd;';
        var tt = document.createElement('div');
        tt.style.cssText = 'font-size:13px;font-weight:600;color:#eee;margin-bottom:2px;';
        tt.textContent = '选择音乐库目录';
        box.appendChild(tt);
        var tip = document.createElement('div');
        tip.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:8px;word-break:break-all;';
        tip.textContent = '音乐库根目录: ' + root;
        box.appendChild(tip);

        // 当前选择显示
        var selShow = document.createElement('div');
        selShow.style.cssText = 'font-size:11px;color:#7fd68b;margin-bottom:6px;word-break:break-all;min-height:14px;';
        selShow.textContent = '保存到: ' + (selected.abs === root ? '（音乐库根目录）' : selected.abs);
        box.appendChild(selShow);

        // 目录树容器
        var treeBox = document.createElement('div');
        treeBox.style.cssText = 'flex:1;overflow-y:auto;background:#181818;border:1px solid #333;border-radius:6px;padding:6px;min-height:160px;max-height:320px;';
        box.appendChild(treeBox);

        var openSet = {};
        // 默认展开到当前下载目录的祖先
        (function initOpen(n) {
            if (curDl.indexOf(n.abs) === 0 && n.abs !== curDl) openSet[n.abs] = true;
            n.children.forEach(initOpen);
        })(tree);

        function renderTreeNode(n) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:4px;cursor:pointer;white-space:nowrap;' + (n.abs === selected.abs ? 'background:#1e3a33;color:#7fd68b;' : '');
            row.style.paddingLeft = (6 + n.depth * 16) + 'px';
            var hasKids = n.children.length > 0;
            var caret = document.createElement('span');
            caret.style.cssText = 'flex:0 0 14px;font-size:10px;color:var(--muted);text-align:center;';
            caret.textContent = hasKids ? (openSet[n.abs] ? '▼' : '▶') : '';
            var ico = document.createElement('span');
            ico.style.cssText = 'flex:0 0 auto;';
            ico.textContent = n.depth === 0 ? '📀' : (hasKids ? '📁' : '📂');
            var lb = document.createElement('span');
            lb.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;';
            lb.textContent = n.depth === 0 ? (path.basename(n.abs) || n.abs) : n.name;
            row.appendChild(caret); row.appendChild(ico); row.appendChild(lb);
            // 点击：选中目录；点 caret 展开/收起
            row.addEventListener('click', function (ev) {
                ev.stopPropagation();
                if (ev.target === caret && hasKids) {
                    openSet[n.abs] = !openSet[n.abs];
                    // 重渲染子树
                    var holder = row.parentNode;
                    var next = row.nextSibling;
                    // 移除旧子行（本节点后续 depth 更大的行）
                    var myDepth = n.depth;
                    while (next && next.__depth !== undefined && next.__depth > myDepth) {
                        var todel = next;
                        next = next.nextSibling;
                        holder.removeChild(todel);
                    }
                    // 展开则插入子行
                    if (openSet[n.abs]) {
                        var frag = document.createDocumentFragment();
                        n.children.forEach(function (ch) {
                            var cr = renderTreeNode(ch);
                            cr.__depth = ch.depth;
                            frag.appendChild(cr);
                            if (openSet[ch.abs]) appendDescendants(frag, ch);
                        });
                        holder.insertBefore(frag, next);
                    }
                    return;
                }
                selected.abs = n.abs;
                selShow.textContent = '保存到: ' + (n.abs === root ? '（音乐库根目录）' : n.abs);
                // 刷新选中高亮
                treeBox.querySelectorAll('div').forEach(function (d2) {
                    if (d2.style && d2.style.background === 'rgb(30, 58, 51)') {
                        d2.style.background = '';
                        d2.style.color = '';
                    }
                });
                row.style.background = '#1e3a33';
                row.style.color = '#7fd68b';
            });
            return row;
        }
        function appendDescendants(frag, n) {
            if (!openSet[n.abs]) return;
            n.children.forEach(function (ch) {
                var cr2 = renderTreeNode(ch);
                cr2.__depth = ch.depth;
                frag.appendChild(cr2);
                if (openSet[ch.abs]) appendDescendants(frag, ch);
            });
        }
        function renderTree() {
            treeBox.innerHTML = '';
            var frag = document.createDocumentFragment();
            var rr = renderTreeNode(tree);
            rr.__depth = tree.depth;
            frag.appendChild(rr);
            if (openSet[tree.abs]) appendDescendants(frag, tree);
            treeBox.appendChild(frag);
        }
        renderTree();

        // 新建子目录
        var newRow = document.createElement('div');
        newRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
        var newInp = document.createElement('input');
        newInp.type = 'text';
        newInp.placeholder = '在当前选中目录下新建子目录名';
        newInp.style.cssText = 'flex:1;min-width:0;padding:6px 8px;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;font-size:12px;';
        newRow.appendChild(newInp);
        var newBtn = document.createElement('button');
        newBtn.textContent = '新建';
        newBtn.style.cssText = 'flex:0 0 auto;background:#1e3a2a;color:#7fd68b;border:1px solid #2a5a3a;border-radius:4px;padding:4px 12px;cursor:pointer;font-size:12px;';
        newBtn.addEventListener('click', function () {
            var nn = (newInp.value || '').trim();
            if (!nn) return;
            var base = selected.abs || root;
            var np = path.join(base, nn);
            try {
                if (!fs.existsSync(np)) fs.mkdirSync(np, { recursive: true });
                else { flash('该目录已存在'); return; }
            } catch (e) { flash('创建失败: ' + e.message); return; }
            // 重建树并选中新目录
            tree = buildDirTree(root, 0, 6);
            selected.abs = np;
            selShow.textContent = '保存到: ' + np;
            // 展开新目录祖先
            (function mark(n2) {
                if (np.indexOf(n2.abs) === 0 && n2.abs !== np) openSet[n2.abs] = true;
                n2.children.forEach(mark);
            })(tree);
            renderTree();
            newInp.value = '';
        });
        newRow.appendChild(newBtn);
        box.appendChild(newRow);

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;';
        var cancel = document.createElement('button');
        cancel.textContent = '取消';
        cancel.style.cssText = 'background:#3a3a3a;color:#aaa;border:none;border-radius:4px;padding:5px 14px;cursor:pointer;';
        cancel.addEventListener('click', function () { ov.remove(); cb(null); });
        var ok = document.createElement('button');
        ok.textContent = '确定';
        ok.style.cssText = 'background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:5px 16px;cursor:pointer;';
        ok.addEventListener('click', function () {
            ov.remove();
            cb(selected.abs || root);
        });
        row.appendChild(cancel); row.appendChild(ok);
        box.appendChild(row);
        ov.appendChild(box);
        document.body.appendChild(ov);
    }

    // 设置下载目录（工具栏「下载目录…」）
    function setDlDirFromUI() {
        chooseDlDir(function (dir) {
            if (!dir) return;
            setDlDir(dir);
            refreshDlDirLabel();
            setStatus('下载目录已设为: ' + dir, 'ok');
        });
    }
    function refreshDlDirLabel() {
        var lb = $('musicDlDirLabel');
        if (lb) {
            var d = getDlDir();
            var root = getMusicLibRoot();
            var show = d;
            if (root && d.indexOf(root) === 0) {
                var rel = d.slice(root.length).replace(/^[\\\/]+/, '');
                show = rel ? ('📂 ' + rel) : '📂 （音乐库根目录）';
            }
            lb.textContent = show;
            lb.title = d;
        }
    }

    function safeName(s) {
        return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    // ---------- 导入 PR ----------
    function importToPR(files) {
        setStatus('导入 PR...', '');
        csInterface.evalScript('musicImportPayload = ' + JSON.stringify(files) + ';', function () {
            csInterface.evalScript('musicImportToBinStr()', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) setStatus('已导入「音乐」素材箱：' + data.imported.join('、'), 'ok');
                    else setStatus(data.error || '导入失败', 'err');
                } catch (e) {
                    setStatus('导入解析失败: ' + result, 'err');
                }
            });
        });
    }

    // ================= 听歌识曲（抓系统正在播放的声音） =================
    function findPython() {
        var os2 = require('os');
        // 按「装了 pyaudiowpatch 的优先」排：先用 runtime，再探测各 Python 是否可 import pyaudiowpatch
        var cands = [
            path.join(extRoot, 'runtime', 'python.exe'),
            path.join(os2.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
            path.join(os2.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe')
        ];
        var usable = null;
        for (var i = 0; i < cands.length; i++) {
            var c = cands[i];
            if (!fs.existsSync(c)) continue;
            try {
                var r = childProcess.spawnSync(c, ['-c', 'import pyaudiowpatch'], { encoding: 'utf8', timeout: 10000 });
                if (r.status === 0) { usable = c; break; }
            } catch (e) {}
            if (!usable) usable = c; // 兜底：即使 import 失败也先记下，最后用
        }
        return usable || 'python';
    }

    function doIdentify() {
        var btn = $('btnMusicIdentify');
        if (!btn) return;
        if (identifyActive) return;   // 已在识别中
        var stopBtn = $('btnMusicIdentifyStop');
        var prog = $('musicIdentifyProgress');
        var box = $('musicIdentifyResult');

        identifyActive = true;
        identifyStop = false;
        identifyRound = 0;
        identifyCache = [];

        btn.disabled = true;
        btn.textContent = '🎵 识别中…（边听边识别）';
        if (stopBtn) stopBtn.style.display = '';
        if (prog) { prog.style.display = 'block'; prog.innerHTML = ''; }
        if (box) box.style.display = 'none';

        var py = findPython();
        var scriptPath = path.join(extRoot, 'py', 'identify_record.py');
        var tmpdir = require('os').tmpdir();

        function setProg(html) {
            if (prog) prog.innerHTML = html;
        }

        // 边听边识别：循环录 6 秒 → 识别 → 命中则显示结果，否则继续下一轮
        function round() {
            if (identifyStop || !identifyActive) { finishIdentify(); return; }
            identifyRound++;
            setProg('<div style="color:#9db9ff;">🎙 第 ' + identifyRound + ' 轮录音中（6 秒）… 正在捕捉电脑播放的声音</div>');
            var wavPath = path.join(tmpdir, 'vh_identify_' + Date.now() + '.wav');
            childProcess.execFile(py, [scriptPath, wavPath, '6'], { encoding: 'utf8', timeout: 20000 }, function (err, stdout) {
                if (identifyStop || !identifyActive) { finishIdentify(); return; }
                var rec = null;
                try { rec = JSON.parse((stdout || '').trim().split('\n').pop()); } catch (e) {}
                if (err || !rec || !rec.ok) {
                    // 录音失败：显示错误并停止循环
                    identifyActive = false;
                    finishIdentify();
                    var diag = (rec && rec.allOutputDevices) ? ('<div style="margin-top:4px;font-size:11px;color:#889;">输出设备：' + rec.allOutputDevices.join('；') + '</div>') : '';
                    if (box) { box.style.display = 'block'; box.innerHTML = '<div style="color:#ff9a9a;">录音失败：' + ((rec && rec.error) || (err && err.message) || '未知错误') + '</div>' + diag; }
                    return;
                }
                if (rec.silent) {
                    // 这轮静音：继续下一轮，不报错
                    setProg('<div style="color:#9db9ff;">🎙 第 ' + identifyRound + ' 轮录音完成，未听到声音，继续监听…</div>');
                    round();
                    return;
                }
                // 识别
                setProg('<div style="color:#9db9ff;">🔍 正在识别第 ' + identifyRound + ' 轮录音…</div>');
                var body = JSON.stringify({ wavPath: wavPath });
                var xhr = new XMLHttpRequest();
                xhr.open('POST', API + '/identify', true);
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.timeout = 20000;
                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;
                    if (identifyStop || !identifyActive) { finishIdentify(); return; }
                    try {
                        var j = JSON.parse(xhr.responseText);
                        var data = j.data || {};
                        var results = data.result || [];
                        if (results.length > 0 && results[0].song) {
                            // 命中：显示结果，结束循环
                            identifyActive = false;
                            identifyCache = results.map(function (m) { return m.song; });
                            renderIdentifyResult(results);
                            finishIdentify();
                        } else {
                            setProg('<div style="color:#ffb84d;">第 ' + identifyRound + ' 轮未识别到，继续监听…（可点停止）</div>');
                            round();
                        }
                    } catch (e) {
                        identifyActive = false;
                        finishIdentify();
                        if (box) { box.style.display = 'block'; box.innerHTML = '<div style="color:#ff9a9a;">识别响应解析失败：' + e.message + '</div>'; }
                    }
                };
                xhr.onerror = function () {
                    if (identifyStop || !identifyActive) { finishIdentify(); return; }
                    setProg('<div style="color:#ff9a9a;">无法连接识曲服务，重试中…</div>');
                    round();
                };
                xhr.ontimeout = function () {
                    if (identifyStop || !identifyActive) { finishIdentify(); return; }
                    setProg('<div style="color:#ff9a9a;">识别超时，重试中…</div>');
                    round();
                };
                xhr.send(body);
            });
        }

        function finishIdentify() {
            identifyActive = false;
            identifyStop = false;
            var b2 = $('btnMusicIdentify');
            var s2 = $('btnMusicIdentifyStop');
            var p2 = $('musicIdentifyProgress');
            if (b2) { b2.disabled = false; b2.textContent = '🎵 听歌识曲'; }
            if (s2) s2.style.display = 'none';
            if (p2) p2.style.display = 'none';
        }

        round();
    }

    function stopIdentify() {
        if (!identifyActive) return;
        identifyStop = true;
        identifyActive = false;
        var b2 = $('btnMusicIdentify');
        var s2 = $('btnMusicIdentifyStop');
        var p2 = $('musicIdentifyProgress');
        var box = $('musicIdentifyResult');
        if (b2) { b2.disabled = false; b2.textContent = '🎵 听歌识曲'; }
        if (s2) s2.style.display = 'none';
        if (p2) { p2.style.display = 'none'; }
        setStatus('已停止识别', '');
        // 若之前已有识别结果，保留在结果框
        if (identifyCache.length && box && box.style.display === 'none') {
            // 无操作，保持现状
        }
    }

    // 渲染识别结果（播放/下载/加歌单/搜），不关结果框
    function renderIdentifyResult(results) {
        var box = $('musicIdentifyResult');
        if (!box) return;
        var html = '<div style="font-weight:600;color:#7fd68b;margin-bottom:6px;">✅ 识别到：</div>';
        var shown = 0;
        var songById = {};
        results.forEach(function (m) {
            if (shown >= 3) return;
            var s = m.song || {};
            var nm = s.name || '未知';
            var ar = (s.artists || []).map(function (a) { return a.name; }).join(', ');
            var sid = s.id;
            songById[sid] = s;
            html += '<div class="identify-item" style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #2a3a5d;" data-sid="' + sid + '">' +
                '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + nm + ' <span style="color:var(--muted);font-size:11px;">- ' + ar + '</span></span>' +
                '<button class="tbtn" style="padding:2px 7px;font-size:11px;" data-play="1" data-sid="' + sid + '">播放</button>' +
                '<button class="tbtn" style="padding:2px 7px;font-size:11px;" data-sid="' + sid + '" data-name="' + enc(nm) + '" data-artist="' + enc(ar) + '">下载</button>' +
                '<button class="tbtn" style="padding:2px 7px;font-size:11px;" data-add="1" data-sid="' + sid + '">+ 歌单</button>' +
                '<button class="tbtn" style="padding:2px 7px;font-size:11px;" data-q="' + enc(nm + ' ' + ar) + '">搜</button></div>';
            shown++;
        });
        html += '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #2a3a5d;text-align:right;">' +
            '<button class="tbtn" id="btnIdentifyHistoryToggle" style="padding:2px 8px;font-size:11px;">📜 识别历史</button></div>';
        box.innerHTML = html;
        box.style.display = 'block';

        if (results[0] && results[0].song) addIdentifyHistory(results[0].song);

        box.querySelectorAll('button[data-play]').forEach(function (b) {
            b.addEventListener('click', function () {
                var s = songById[b.dataset.sid];
                if (!s) return;
                playQueue.push(s);
                playFromQueue(playQueue.length - 1, null);
            });
        });
        box.querySelectorAll('button[data-name]').forEach(function (b) {
            b.addEventListener('click', function () {
                var sid = b.dataset.sid;
                var nm = decodeURIComponent(b.dataset.name);
                var ar = decodeURIComponent(b.dataset.artist);
                var s = songById[sid];
                downloadSong(sid, nm, ar, null, null, s);
            });
        });
        box.querySelectorAll('button[data-add]').forEach(function (b) {
            b.addEventListener('click', function () {
                var s = songById[b.dataset.sid];
                if (s) addToPlaylist(s);
            });
        });
        // 搜：填歌名+歌手搜索（不要填歌曲 id，否则搜出一串数字）
        box.querySelectorAll('button[data-q]').forEach(function (b) {
            b.addEventListener('click', function () {
                $('musicQuery').value = decodeURIComponent(b.dataset.q);
                $('musicType').value = '1';
                doSearch();
            });
        });
        // 双击整条结果 → 播放
        box.querySelectorAll('.identify-item').forEach(function (it) {
            it.style.cursor = 'pointer';
            it.addEventListener('dblclick', function () {
                var s = songById[it.dataset.sid];
                if (!s) return;
                playQueue.push(s);
                playFromQueue(playQueue.length - 1, null);
            });
        });
        var histBtn = box.querySelector('#btnIdentifyHistoryToggle');
        if (histBtn) histBtn.addEventListener('click', function () { toggleIdentifyHistory(); });
    }

    // ---------- 识别历史（展开/收起，显示在结果框下方） ----------
    function toggleIdentifyHistory() {
        var box = $('musicIdentifyResult');
        if (!box) return;
        var existing = box.querySelector('#identifyHistoryList');
        if (existing) { existing.remove(); identifyHistoryShown = false; return; }

        var h = loadIdentifyHistory();
        var wrap = document.createElement('div');
        wrap.id = 'identifyHistoryList';
        wrap.style.cssText = 'margin-top:6px;padding-top:6px;border-top:1px solid #2a3a5d;';
        if (h.length === 0) {
            wrap.innerHTML = '<div style="color:var(--muted);font-size:11px;">暂无识别历史</div>';
        } else {
            var html = '<div style="font-weight:600;color:#9db9ff;margin-bottom:4px;">📜 识别历史：</div>';
            h.forEach(function (it) {
                var t = new Date(it.t).toLocaleString();
                html += '<div class="identify-hist-item" style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid #22304a;">' +
                    '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (it.name || '未知') + ' <span style="color:var(--muted);font-size:11px;">- ' + (it.artist || '') + '</span></span>' +
                    '<span style="color:var(--muted);font-size:10px;white-space:nowrap;">' + t + '</span>' +
                    '<button class="tbtn" style="padding:1px 6px;font-size:11px;" data-hplay="' + it.id + '">播放</button>' +
                    '<button class="tbtn" style="padding:1px 6px;font-size:11px;" data-hdl="' + it.id + '" data-hname="' + enc(it.name || '') + '" data-hartist="' + enc(it.artist || '') + '">下载</button></div>';
            });
            wrap.innerHTML = html;
        }
        box.appendChild(wrap);
        identifyHistoryShown = true;

        // 历史条目：播放/下载
        wrap.querySelectorAll('button[data-hplay]').forEach(function (b) {
            b.addEventListener('click', function () {
                var sid = b.dataset.hplay;
                api('/song/detail?ids=' + sid).then(function (r) {
                    var songs = r && r.songs;
                    if (songs && songs[0]) {
                        playQueue.push(songs[0]);
                        playFromQueue(playQueue.length - 1, null);
                    }
                });
            });
        });
        wrap.querySelectorAll('button[data-hdl]').forEach(function (b) {
            b.addEventListener('click', function () {
                downloadSong(b.dataset.hdl, decodeURIComponent(b.dataset.hname), decodeURIComponent(b.dataset.hartist));
            });
        });
    }


    function bindEvents() {
        $('btnMusicSearch').addEventListener('click', doSearch);
        $('musicQuery').addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); doSearch(); }
        });
        $('btnMusicMyPlaylist').addEventListener('click', loadMyPlaylist);
        // 批量下载 / 选择 / 下载目录
        var allBtn = $('btnMusicSelectAll');
        if (allBtn) allBtn.addEventListener('click', toggleSelectAll);
        var batchBtn = $('btnMusicBatchDl');
        if (batchBtn) batchBtn.addEventListener('click', batchDownloadSelected);
        var dirBtn = $('btnMusicSetDir');
        if (dirBtn) dirBtn.addEventListener('click', setDlDirFromUI);
        var idBtn = $('btnMusicIdentify');
        if (idBtn) idBtn.addEventListener('click', doIdentify);
        var idStopBtn = $('btnMusicIdentifyStop');
        if (idStopBtn) idStopBtn.addEventListener('click', stopIdentify);
        $('btnMusicRefreshQr').addEventListener('click', function () { $('btnMusicRefreshQr').disabled = true; fetchQr(); });
        $('btnMusicLogout').addEventListener('click', function () {
            api('/logout').then(function () {
                loggedIn = false;
                account = null;
                stopQrPoll();
                showLogin();
                setStatus('已退出登录', '');
                startLogin();
            });
        });
        $('btnMusicBack').addEventListener('click', function () {
            if (currentMode === 'myPlaylist') return;
            loadMyPlaylist();
        });
        // 播放条按钮
        $('btnMusicPlayPause').addEventListener('click', togglePlayPause);
        $('btnMusicNext').addEventListener('click', playNext);
        $('btnMusicPrev').addEventListener('click', playPrev);
        $('btnMusicMode').addEventListener('click', cycleMode);
        $('btnMusicDownload').addEventListener('click', downloadCurrent);
        $('btnMusicLyric').addEventListener('click', toggleLyric);
        // 音量
        $('btnMusicVol').addEventListener('click', toggleMute);
        $('musicVol').addEventListener('input', function () {
            var v = parseFloat(this.value);
            if (isNaN(v)) v = 0.8;
            setVolume(v);
        });
        setVolume(0.8);
        bindAudioEvents();
        bindSeek();
        updateModeBtn();
    }

    // 切到本 tab 时触发（由 main.js switchTab 调用）
    function onTabVisible() {
        if (!loggedIn) {
            showLogin();
            startLogin();
        }
    }
    window.__musicOnShow = onTabVisible;

    // ---------- 初始化 ----------
    el = {
        query: $('musicQuery'),
        type: $('musicType')
    };
    bindEvents();
    refreshDlDirLabel();
    showLogin();
})();
