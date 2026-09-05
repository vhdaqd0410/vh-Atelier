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

            row.appendChild(cover); row.appendChild(info); row.appendChild(btn);
            box.appendChild(row);
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
    // 单首下载：默认存到 getDlDir()（上次目录/音乐库根），destDir 可指定；cb 下载流程结束回调
    function downloadSong(songId, name, artist, destDir, cb) {
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
            downloadViaNode(url, name, artist, dir, songId, cb);
        }).catch(function (e) {
            setStatus('下载失败: ' + e.message, 'err');
            if (cb) cb(false);
        });
    }

    // 通过面板 Node 侧下载文件（CEF 的 fetch 拿二进制不可靠，用 Node http/https 下载）
    function downloadViaNode(url, name, artist, dir, songId, cb) {
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
                    // 若音乐库 tab 开着，提示刷新可见（扫描目录即可看到）
                    var root = getMusicLibRoot();
                    var inLib = root && dest.indexOf(root) === 0;
                    if (inLib) {
                        flash('已存入音乐库 ✓ 可直接拖入时间线');
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

    // 选下载目录弹窗（音乐库子目录 + 根目录 + 新建）
    function chooseDlDir(cb) {
        var root = getMusicLibRoot();
        var subs = listMusicSubdirs();
        var ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1001;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:16px;max-width:380px;width:90%;font-size:12px;color:#ddd;';
        var tt = document.createElement('div');
        tt.style.cssText = 'font-size:13px;font-weight:600;color:#eee;margin-bottom:10px;';
        tt.textContent = '选择音乐库目录';
        box.appendChild(tt);
        var tip = document.createElement('div');
        tip.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.5;';
        tip.textContent = root ? ('音乐库根目录: ' + root) : '未设置音乐库目录（将用插件默认下载目录）';
        box.appendChild(tip);
        var sel = document.createElement('select');
        sel.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;margin-bottom:8px;';
        if (root) {
            var oRoot = document.createElement('option');
            oRoot.value = root;
            oRoot.textContent = '（音乐库根目录）';
            sel.appendChild(oRoot);
        }
        subs.forEach(function (s) {
            var op = document.createElement('option');
            op.value = s;
            op.textContent = path.basename(s);
            sel.appendChild(op);
        });
        var oNew = document.createElement('option');
        oNew.value = '__new__';
        oNew.textContent = '＋ 新建子目录…';
        sel.appendChild(oNew);
        box.appendChild(sel);
        var newRow = document.createElement('div');
        newRow.style.cssText = 'display:none;margin-bottom:8px;';
        var newInp = document.createElement('input');
        newInp.type = 'text';
        newInp.placeholder = '新目录名';
        newInp.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:4px;';
        newRow.appendChild(newInp);
        box.appendChild(newRow);
        sel.addEventListener('change', function () {
            newRow.style.display = sel.value === '__new__' ? '' : 'none';
            if (sel.value === '__new__') newInp.focus();
        });
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
        var cancel = document.createElement('button');
        cancel.textContent = '取消';
        cancel.style.cssText = 'background:#3a3a3a;color:#aaa;border:none;border-radius:4px;padding:5px 14px;cursor:pointer;';
        cancel.addEventListener('click', function () { ov.remove(); cb(null); });
        var ok = document.createElement('button');
        ok.textContent = '确定';
        ok.style.cssText = 'background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:5px 16px;cursor:pointer;';
        ok.addEventListener('click', function () {
            var v = sel.value;
            if (v === '__new__') {
                var nn = (newInp.value || '').trim();
                if (!nn) { return; }
                var base = root || musicDir;
                var np = path.join(base, nn);
                try {
                    if (!fs.existsSync(np)) fs.mkdirSync(np, { recursive: true });
                } catch (e) { return; }
                v = np;
            }
            if (!v) { ov.remove(); cb(null); return; }
            ov.remove();
            cb(v);
        });
        row.appendChild(cancel); row.appendChild(ok);
        box.appendChild(row);
        ov.appendChild(box);
        document.body.appendChild(ov);
        sel.focus();
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
