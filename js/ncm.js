/**
 * vh-Atelier · DaVinci Resolve 版 · 网易云音乐面板
 *
 * 数据走主进程 ncm-host（无需独立服务、无端口）。
 * 功能对齐 PR 版 music.js：
 *   扫码登录 · 我的歌单 · 最近播放 · 搜索（单曲/歌单）· 多选批量下载
 *   · 试听（上下一首/进度/音量）· 歌词 · 下载到本地 · 导入素材池 · 插入播放头
 */
(function () {
  'use strict';

  var el = {};
  var cur = null;
  var queue = [];            // 当前播放队列
  var qIdx = -1;
  var playing = false;
  var audio = null;
  var lastResults = [];
  var selSet = {};           // 批量下载多选：id -> song
  var lrcLines = [];         // 解析后的歌词
  var dlDir = '';            // 下载目录（记忆）
  var vol = 0.8;

  var SEL_KEY = 'vh_ncm_sel_v1';
  var DL_DIR_KEY = 'vh_ncm_dldir_v1';
  var VOL_KEY = 'vh_ncm_vol_v1';
  var DL_MAP_KEY = 'vh_ncm_dlmap_v1';   // songId -> 已下载文件绝对路径
  var dlMap = {};                       // 已下载记录（本次会话 + 持久化）
  var identHist = [];                   // 识曲历史
  var IDENT_KEY = 'vh_ncm_ident_v1';

  function loadDlMap() {
    try { dlMap = JSON.parse(localStorage.getItem(DL_MAP_KEY) || '{}') || {}; }
    catch (e) { dlMap = {}; }
  }
  function saveDlMap() {
    try { localStorage.setItem(DL_MAP_KEY, JSON.stringify(dlMap)); } catch (e) {}
  }
  function isDownloaded(id) { return !!dlMap[String(id)]; }

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(m, k) { if (window.__vhToast) window.__vhToast(m, k); else console.log('[ncm] ' + m); }
  function status(m, k) {
    if (!el.status) return;
    el.status.textContent = m || '';
    el.status.className = k || '';
  }
  function fmtDur(ms) {
    var s = Math.floor((Number(ms) || 0) / 1000);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }
  function fmtSec(s) {
    s = Math.floor(Number(s) || 0);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }
  function host() { return window.vhHost || {}; }

  // ---------- 登录 ----------
  function renderLogin(st) {
    if (!el.loginBox) return;
    if (!st.libOk) {
      el.loginState.textContent = '组件缺失';
      el.loginBox.innerHTML = '<div class="mini" style="color:#ff9a9a;line-height:1.7">'
        + esc(st.libError || '') + '</div>';
      return;
    }
    if (st.loggedIn) {
      el.loginState.textContent = '已登录';
      el.loginBox.innerHTML = '<div class="row">'
        + (st.avatarUrl
            ? '<img class="ncm-avatar" src="' + esc(st.avatarUrl) + '" alt="">'
            : '<span class="ncm-avatar ncm-avatar-ph">👤</span>')
        + '<span class="mini">' + esc(st.nickname || ('用户 ' + st.userId)) + '</span>'
        + '<button class="tbtn" id="btnNcmMyPl">🎵 我的歌单</button>'
        + '<button class="tbtn" id="btnNcmRecent">🕘 最近播放</button>'
        + '<span class="grow"></span>'
        + '<button class="tbtn" id="btnNcmLogout">退出登录</button></div>';
      bind('btnNcmLogout', function () {
        host().ncmLogout().then(function () { refreshLogin(); toast('已退出登录', 'ok'); });
      });
      bind('btnNcmMyPl', function () { loadMyPlaylists(st.uid || st.userId); });
      bind('btnNcmRecent', loadRecent);
      return;
    }
    el.loginState.textContent = '未登录';
    el.loginBox.innerHTML = '<div class="row">'
      + '<button class="tbtn on" id="btnNcmQr">📱 扫码登录</button>'
      + '<span class="mini">登录后可用「我的歌单」「最近播放」「批量下载」</span></div>'
      + '<div id="ncmQrBox" style="margin-top:8px;"></div>';
    bind('btnNcmQr', startQrLogin);
  }
  function bind(id, fn) { var b = $(id); if (b) b.addEventListener('click', fn); }

  function refreshLogin() {
    if (!host().ncmStatus) return Promise.resolve();
    return host().ncmStatus().then(function (r) {
      var st = (r && r.data ? r.data : r) || {};
      if (!st.uid) st.uid = st.userId;
      renderLogin(st);
      return st;
    }).catch(function (e) { console.warn('[ncm] status', e); });
  }

  var qrTimer = null;
  function startQrLogin() {
    var box = $('ncmQrBox');
    if (!box) return;
    box.innerHTML = '<div class="mini">正在获取二维码…</div>';
    host().ncmQrKey().then(function (kr) {
      var key = kr && kr.data ? kr.data : kr;
      return host().ncmQrCreate(key).then(function (cr) {
        var d = cr && cr.data ? cr.data : cr;
        if (!d || !d.qrimg) { box.innerHTML = '<div class="mini" style="color:#ff9a9a">二维码生成失败</div>'; return; }
        box.innerHTML = '<div style="display:flex;gap:10px;align-items:flex-start">'
          + '<img src="' + d.qrimg + '" style="width:150px;height:150px;background:#fff;border-radius:6px;padding:4px;">'
          + '<div class="mini" id="ncmQrState" style="line-height:1.9">用手机网易云 App 扫码<br>状态：等待扫码</div></div>';
        var stEl = $('ncmQrState');
        if (qrTimer) clearInterval(qrTimer);
        qrTimer = setInterval(function () {
          host().ncmQrCheck(key).then(function (r2) {
            var s2 = r2 && r2.data ? r2.data : r2;
            if (!s2) return;
            if (stEl) stEl.innerHTML = '用手机网易云 App 扫码<br>状态：' + esc(s2.message || '');
            if (s2.ok) { clearInterval(qrTimer); qrTimer = null; toast('登录成功', 'ok'); refreshLogin(); }
            else if (s2.code === 800) { clearInterval(qrTimer); qrTimer = null; toast('二维码已过期，请重新点扫码登录', 'warn'); }
          }).catch(function () {});
        }, 2500);
      });
    }).catch(function (e) {
      box.innerHTML = '<div class="mini" style="color:#ff9a9a">获取二维码失败：' + esc(e.message || e) + '</div>';
    });
  }

  // ---------- 我的歌单 / 最近播放 ----------
  function loadMyPlaylists(uid) {
    status('读取我的歌单…', '');
    host().ncmUserPlaylist(uid).then(function (r) {
      var d = r && r.data ? r.data : r;
      var pls = (d && d.playlist) || [];
      if (!pls.length) { status('没有歌单', 'warn'); return; }
      renderPlaylists(pls, '我的歌单（' + pls.length + '）');
    }).catch(function (e) { status('歌单读取失败：' + (e.message || e), 'err'); });
  }

  function loadRecent() {
    status('读取最近播放…', '');
    host().ncmRecentSongs().then(function (r) {
      var d = r && r.data ? r.data : r;
      // 接口返回 { total, list: [...] }，每项形如 { data: {song...} } 或直接是 song
      var raw = (d && (d.list || d.data)) || [];
      if (!Array.isArray(raw)) raw = [];
      var songs = raw.map(function (x) {
        if (!x) return null;
        // 常见包装：{ data: song } / { song: song } / 直接是 song
        return x.data || x.song || x;
      }).filter(function (x) { return x && (x.id || x.name); });
      if (!songs.length) {
        if (el.count) el.count.textContent = '最近播放（0）';
        if (el.list) {
          el.list.innerHTML = '<div class="ncm-sec">最近播放（0）</div>'
            + '<div class="mini" style="padding:12px;line-height:1.8">'
            + '暂无最近播放记录。<br>在网易云 App 上听几首歌后回来点这里就能看到。</div>';
        }
        status('最近播放为空', 'warn');
        return;
      }
      renderSongs(songs, '最近播放（' + songs.length + '）');
    }).catch(function (e) { status('最近播放读取失败：' + (e.message || e), 'err'); });
  }

  // ---------- 搜索 ----------
  function doSearch() {
    var kw = (el.kw && el.kw.value || '').trim();
    if (!kw) { toast('请输入搜索词', 'err'); return; }
    var type = Number(el.type && el.type.value || 1);
    status('搜索中…', '');
    if (el.list) el.list.innerHTML = '<div class="empty">搜索中…</div>';
    host().ncmSearch(kw, type, 40, 0).then(function (r) {
      var d = r && r.data ? r.data : r;
      if (type === 1000) renderPlaylists((d.result && d.result.playlists) || [], '搜索结果（歌单）');
      else renderSongs((d.result && d.result.songs) || [], '搜索结果');
    }).catch(function (e) {
      status('搜索失败：' + (e.message || e), 'err');
      if (el.list) el.list.innerHTML = '<div class="empty">搜索失败：' + esc(e.message || e) + '</div>';
    });
  }

  function renderPlaylists(pls, title) {
    el.list._pls = pls;
    if (el.count) el.count.textContent = title || (pls.length + ' 个歌单');
    if (!pls.length) { el.list.innerHTML = '<div class="empty">没有结果</div>'; return; }
    el.list.innerHTML = '<div class="ncm-sec">' + esc(title || '') + '</div>'
      + pls.map(function (p, i) {
        var cnt = p.trackCount != null ? p.trackCount : (p.playCount != null ? p.playCount : '');
        var creator = (p.creator && p.creator.nickname) || '';
        var pic = p.coverImgUrl || p.picUrl || (p.album && p.album.picUrl) || '';
        return '<div class="ncm-item ncm-pl" data-id="' + p.id + '">'
          + (pic ? '<img class="ncm-thumb" src="' + esc(pic) + '" alt="" loading="lazy">'
                 : '<span class="ncm-thumb ncm-thumb-ph">♪</span>')
          + '<span class="ncm-main"><span class="ncm-name">' + esc(p.name || '') + '</span>'
          + '<span class="ncm-sub">' + esc(creator) + (cnt !== '' ? ' · ' + cnt + ' 首' : '') + '</span></span>'
          + '<span class="ncm-acts"><button class="tbtn ncm-plopen" data-id="' + p.id + '">打开</button></span></div>';
      }).join('');
    status(pls.length + ' 个歌单', 'ok');
  }

  function renderSongs(songs, title) {
    lastResults = songs || [];
    selSet = {};
    if (el.count) el.count.textContent = title || (lastResults.length + ' 首');
    if (!lastResults.length) { el.list.innerHTML = '<div class="empty">没有结果</div>'; status('无结果', 'warn'); return; }
    el.list.innerHTML = '<div class="ncm-sec">' + esc(title || '') + '</div>'
      + lastResults.map(function (s, i) {
        var ar = (s.ar || s.artists || []).map(function (a) { return a.name; }).join(' / ');
        var al = (s.al || s.album || {}).name || '';
        var pic = (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || '';
        var dl = isDownloaded(s.id);
        return '<div class="ncm-item' + (dl ? ' dl-ok' : '') + '" data-i="' + i + '"'
          + ' data-sid="' + esc(String(s.id)) + '"' + (dl ? ' draggable="true"' : '') + '>'
          + '<label class="ncm-ck" title="勾选用于批量下载"><input type="checkbox" class="ncm-cb" data-id="' + s.id + '"></label>'
          + (pic ? '<img class="ncm-thumb" src="' + esc(pic) + '" alt="" loading="lazy">'
                 : '<span class="ncm-thumb ncm-thumb-ph">♪</span>')
          + '<span class="ncm-main"><span class="ncm-name">' + esc(s.name || '') + '</span>'
          + '<span class="ncm-sub">' + esc(ar) + (al ? ' · ' + esc(al) : '') + '</span></span>'
          + '<span class="ncm-dur">' + fmtDur(s.dt || s.duration) + '</span>'
          + '<span class="ncm-acts">'
          + '<button class="tbtn ncm-play" data-i="' + i + '" title="试听">▶</button>'
          + (isDownloaded(s.id)
              ? '<button class="tbtn on ncm-dlmade" data-i="' + i + '" title="已下载（点击查看操作）">✓ 已下载</button>'
              : '<button class="tbtn ncm-dl" data-i="' + i + '" title="下载到本地">⬇</button>')
          + '<button class="tbtn ncm-pool" data-i="' + i + '" title="导入素材池">⇥</button>'
          + '</span></div>';
      }).join('');
    refreshSelUI();
    status(lastResults.length + ' 首', 'ok');
  }

  function refreshSelUI() {
    var n = Object.keys(selSet).length;
    if (el.batch) {
      el.batch.textContent = '⬇ 批量下载(' + n + ')';
      el.batch.disabled = n === 0;
    }
    if (el.selAll) el.selAll.checked = lastResults.length > 0 && n === lastResults.length;
  }

  function toggleSelectAll(on) {
    selSet = {};
    if (on) lastResults.forEach(function (s) { if (s && s.id) selSet[s.id] = s; });
    var cbs = el.list.querySelectorAll('.ncm-cb');
    for (var i = 0; i < cbs.length; i++) cbs[i].checked = !!on;
    refreshSelUI();
  }

  // ---------- 播放 ----------
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.volume = vol;
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', function () {
      if (playMode === 'one' && audio) { audio.currentTime = 0; audio.play().catch(function () {}); return; }
      nextSong();
    });
    audio.addEventListener('error', function () { status('播放出错', 'err'); playing = false; setIco(false); });
    return audio;
  }
  function onTime() {
    if (!audio) return;
    var d = audio.duration || 0, c = audio.currentTime || 0;
    if (el.cur) el.cur.textContent = fmtSec(c);
    if (el.dur) el.dur.textContent = fmtSec(d);
    if (el.fill) el.fill.style.width = d ? (c / d * 100) + '%' : '0%';
    syncLyric(c);
  }
  function setIco(on) {
    var b = $('btnNcmPlay');
    if (!b) return;
    var p = b.querySelector('.ic-play'), q = b.querySelector('.ic-pause');
    if (p) p.style.display = on ? 'none' : '';
    if (q) q.style.display = on ? '' : 'none';
  }
  function togglePlay() {
    if (!audio) { if (cur) playAt(queue.indexOf(cur)); return; }
    if (playing) { audio.pause(); playing = false; setIco(false); setLrcBtn(); }
    else { audio.play().then(function () { playing = true; setIco(true); setLrcBtn(); }).catch(function () {}); }
  }

  function playAt(i) {
    var s = lastResults[i];
    if (!s) return;
    queue = lastResults.slice();
    qIdx = i;
    playSong(s);
  }
  function playSong(s) {
    var ar = (s.ar || s.artists || []).map(function (a) { return a.name; }).join(' / ');
    status('取直链…', '');
    host().ncmSongUrl(s.id, 'exhigh').then(function (r) {
      var d = r && r.data ? r.data : r;
      var u = d && d.data && d.data[0];
      if (!u || !u.url) {
        status('该曲目无法播放（可能需 VIP 或已下架）', 'warn');
        toast('无法播放：' + (u && u.freeTrialInfo ? '需会员' : '无直链'), 'warn');
        return;
      }
      var a = ensureAudio();
      a.src = u.url;
      a.play().then(function () {
        cur = s; playing = true; setIco(true);
        if (el.title) el.title.textContent = s.name || '';
        if (el.sub) el.sub.textContent = ar;
        // 封面
        var pic = (s.al && s.al.picUrl) || (s.album && s.album.picUrl) || '';
        var cov = document.getElementById('ncmCover');
        if (cov) {
          if (pic) { cov.src = pic; cov.style.visibility = 'visible'; }
          else { cov.removeAttribute('src'); cov.style.visibility = 'hidden'; }
        }
        if (el.player) el.player.style.display = '';
        status('播放中：' + (s.name || ''), 'ok');
        loadLyric(s.id);
      }).catch(function (e) { status('播放被拒：' + (e.message || e), 'err'); });
    }).catch(function (e) { status('取直链失败：' + (e.message || e), 'err'); });
  }
  // 播放模式：list=列表循环 / one=单曲循环 / shuffle=随机
  var playMode = 'list';
  var MODE_ICON = { list: '🔁', one: '🔂', shuffle: '🔀' };
  var MODE_TITLE = { list: '列表循环', one: '单曲循环', shuffle: '随机播放' };
  function cycleMode() {
    playMode = playMode === 'list' ? 'one' : (playMode === 'one' ? 'shuffle' : 'list');
    updateModeBtn();
    try { localStorage.setItem('vh_ncm_mode_v1', playMode); } catch (e) {}
    toast('播放模式：' + MODE_TITLE[playMode], 'ok');
  }
  function updateModeBtn() {
    var b = $('btnNcmMode');
    if (!b) return;
    b.textContent = MODE_ICON[playMode] || '🔁';
    b.title = MODE_TITLE[playMode] || '';
  }

  function nextSong() {
    if (!queue.length) return;
    if (playMode === 'shuffle') {
      qIdx = Math.floor(Math.random() * queue.length);
    } else {
      qIdx = (qIdx + 1) % queue.length;
    }
    playSong(queue[qIdx]);
  }
  function prevSong() {
    if (!queue.length) return;
    qIdx = (qIdx - 1 + queue.length) % queue.length;
    playSong(queue[qIdx]);
  }

  // ---------- 歌词 ----------
  function parseLrc(txt) {
    var out = [];
    if (!txt) return out;
    var re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    txt.split(/\r?\n/).forEach(function (line) {
      var texts = line.replace(re, '').trim();
      if (!texts) return;
      var m, times = [];
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        var t = (+m[1]) * 60 + (+m[2]) + (m[3] ? (parseFloat('0.' + m[3])) : 0);
        times.push(t);
      }
      times.forEach(function (t) { out.push({ t: t, text: texts }); });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }
  function loadLyric(id) {
    lrcLines = [];
    if (el.lyric) el.lyric.innerHTML = '<div class="mini">歌词加载中…</div>';
    host().ncmLyric(id).then(function (r) {
      var d = r && r.data ? r.data : r;
      var lrc = (d && (d.lrc && d.lrc.lyric)) || (d && d.lyric) || '';
      lrcLines = parseLrc(lrc);
      renderLyric();
    }).catch(function () {
      lrcLines = [];
      if (el.lyric) el.lyric.innerHTML = '<div class="mini">无歌词</div>';
    });
  }
  function renderLyric() {
    if (!el.lyric) return;
    if (!lrcLines.length) { el.lyric.innerHTML = '<div class="mini">无歌词</div>'; return; }
    el.lyric.innerHTML = lrcLines.map(function (l, i) {
      return '<div class="ncm-lrc-line" data-i="' + i + '">' + esc(l.text) + '</div>';
    }).join('');
  }
  function syncLyric(curSec) {
    if (!lrcLines.length || !el.lyric) return;
    var idx = -1;
    for (var i = 0; i < lrcLines.length; i++) {
      if (lrcLines[i].t <= curSec + 0.2) idx = i; else break;
    }
    var lines = el.lyric.querySelectorAll('.ncm-lrc-line');
    for (var k = 0; k < lines.length; k++) lines[k].classList.toggle('on', k === idx);
    if (idx >= 0 && lines[idx] && el.lyric.dataset.follow !== '0') {
      try { lines[idx].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
    }
  }
  function setLrcBtn() {
    var b = $('btnNcmLyric');
    if (b) b.classList.toggle('on', !!(el.lyric && el.lyric.style.display !== 'none'));
  }


  // ---------- 下载 ----------
  function ensureDlDir() {
    if (dlDir) return Promise.resolve(dlDir);
    try { dlDir = localStorage.getItem(DL_DIR_KEY) || ''; } catch (e) { dlDir = ''; }
    return Promise.resolve(dlDir);
  }
  function pickDlDir() {
    if (!host().pickFolder) return Promise.resolve('');
    return host().pickFolder(dlDir || '', '选择下载保存目录').then(function (r) {
      var d = r && r.data !== undefined ? r.data : r;
      if (d) {
        dlDir = d;
        try { localStorage.setItem(DL_DIR_KEY, d); } catch (e) {}
      }
      return dlDir;
    });
  }

  function downloadSong(s, silent) {
    var ar = (s.ar || s.artists || []).map(function (a) { return a.name; }).join(',');
    var safe = (s.name || 'song') + (ar ? ' - ' + ar : '');
    return ensureDlDir().then(function () {
      return host().ncmSongUrl(s.id, 'exhigh');
    }).then(function (r) {
      var d = r && r.data ? r.data : r;
      var u = d && d.data && d.data[0];
      if (!u || !u.url) throw new Error('无法下载（可能需 VIP）');
      return host().ncmDownload(u.url, dlDir || '', safe);
    }).then(function (r2) {
      var f = r2 && r2.data ? r2.data : r2;
      if (f && f.path && s && s.id) {
        dlMap[String(s.id)] = f.path;
        saveDlMap();
      }
      if (!silent) {
        status('已下载：' + (f && f.name), 'ok');
        toast('已下载：' + (f && f.name) + '（可点击「✓ 已下载」或直接拖到时间线）', 'ok');
        renderSongs(lastResults, el.count ? el.count.textContent : '');
      }
      return f;
    });
  }

  function downloadOne(i) {
    var s = lastResults[i];
    if (!s) return;
    status('取直链…', '');
    downloadSong(s, false).catch(function (e) { status('下载失败：' + (e.message || e), 'err'); });
  }

  function batchDownload() {
    var list = Object.keys(selSet).map(function (k) { return selSet[k]; });
    if (!list.length) { toast('请先勾选歌曲', 'err'); return; }
    var i = 0, ok = 0, bad = 0;
    status('批量下载 0/' + list.length + '…', '');
    function step() {
      if (i >= list.length) {
        status('批量下载完成：成功 ' + ok + ' 首' + (bad ? '，失败 ' + bad + ' 首' : ''), bad ? 'warn' : 'ok');
        toast('批量下载完成：' + ok + '/' + list.length, 'ok');
        return;
      }
      var s = list[i++];
      status('批量下载 ' + i + '/' + list.length + '：' + (s.name || ''), '');
      downloadSong(s, true).then(function () { ok++; })
        .catch(function () { bad++; })
        .then(function () { setTimeout(step, 200); });
    }
    step();
  }

  function downloadPlaylist(pl) {
    status('读取歌单内容…', '');
    host().ncmPlaylistDetail(pl.id).then(function (r) {
      var d = r && r.data ? r.data : r;
      var tracks = (d && d.playlist && d.playlist.tracks) || [];
      if (!tracks.length) { status('歌单为空', 'warn'); return; }
      renderSongs(tracks, '歌单：' + (pl.name || '') + '（' + tracks.length + '）');
      // 自动全选，方便一键批量下载
      toggleSelectAll(true);
      status('已载入歌单，可直接「批量下载」', 'ok');
    }).catch(function (e) { status('歌单读取失败：' + (e.message || e), 'err'); });
  }

  function toPoolOne(i) {
    var s = lastResults[i];
    if (!s) return;
    status('下载并导入…', '');
    downloadSong(s, true).then(function (f) {
      if (!f || !f.path) throw new Error('下载结果异常');
      return host().importFilesToPool([f.path], '网易云音乐');
    }).then(function (res) {
      var dd = res && res.data ? res.data : res;
      status('已导入 ' + (dd.count || 1) + ' 个到「网易云音乐」', 'ok');
      toast('已导入素材池', 'ok');
    }).catch(function (e) { status('操作失败：' + (e.message || e), 'err'); });
  }

  // ---------- 已下载菜单（对齐 PR） ----------
  function showDlMenu(row, i, ev) {
    var s = lastResults[i];
    if (!s) return;
    var path = dlMap[String(s.id)];
    if (!path) return;
    var items = [
      { label: '▶ 试听', onClick: function () { playAt(i); } },
      { label: '⤓ 插入时间线', onClick: function () { insertToTimeline(path); } },
      { label: '⇥ 导入素材池', onClick: function () {
          host().importFilesToPool([path], '网易云音乐').then(function () { toast('已导入素材池', 'ok'); });
        } },
      { sep: true },
      { label: '📂 在资源管理器中定位', onClick: function () {
          if (host().revealFile) host().revealFile(path);
        } },
      { label: '✂ 移出下载记录', onClick: function () {
          delete dlMap[String(s.id)];
          saveDlMap();
          renderSongs(lastResults, '');
          toast('已移出记录（文件仍在磁盘）', 'warn');
        } }
    ];
    if (window.vhMenu) window.vhMenu.show(ev, items);
  }

  function insertToTimeline(path) {
    if (!window.vhHost) return;
    var p = String(path);
    // 非 mp3 的（如 wav）也能插
    window.vhHost.getPlayhead('').then(function (r) {
      var ph = r && r.data !== undefined ? r.data : r;
      return window.vhHost.insertAudioToTimeline({
        path: p,
        recordFrame: ph && ph.frames !== null ? ph.frames : undefined,
        folderName: '网易云音乐'
      });
    }).then(function () { toast('已插入时间线', 'ok'); })
      .catch(function (e) { toast('插入失败：' + (e.message || e), 'err'); });
  }

  function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }

  // ---------- 听歌识曲 ----------
  function doIdentify() {
    if (!host().ncmIdentify) { toast('识曲接口不可用', 'err'); return; }
    var b = $('btnNcmIdentify');
    if (b) { b.disabled = true; b.textContent = '🎙 录音识别中…'; }
    status('正在录系统声音（约 6 秒）…', '');
    host().ncmIdentify(6).then(function (r) {
      var d = r && r.data !== undefined ? r.data : r;
      var ms = (d && d.matches) || [];
      if (!ms.length) {
        status('没有识别到歌曲，请调大播放音量后再试', 'warn');
        toast('未识别到，请确保电脑正在播放音乐', 'warn');
        return;
      }
      // 把匹配结果转成可播放的歌曲对象
      var out = ms.map(function (m) {
        return {
          id: m.song && m.song.id,
          name: (m.song && m.song.name) || '',
          ar: (m.song && m.song.artists) || [],
          al: (m.song && m.song.album) || {},
          dt: (m.song && m.song.duration) || 0
        };
      }).filter(function (x) { return x.id; });
      // 记历史
      out.forEach(function (x) {
        identHist = identHist.filter(function (h) { return h.id !== x.id; });
        identHist.unshift({ id: x.id, name: x.name, ar: (x.ar || []).map(function (a) { return a.name; }).join('/'), t: Date.now() });
      });
      identHist = identHist.slice(0, 30);
      try { localStorage.setItem(IDENT_KEY, JSON.stringify(identHist)); } catch (e) {}
      renderSongs(out, '识曲结果（' + out.length + '）');
      status('识别到 ' + out.length + ' 首', 'ok');
      toast('识别到：' + (out[0] && out[0].name), 'ok');
    }).catch(function (e) {
      status('识曲失败：' + (e.message || e), 'err');
    }).then(function () {
      if (b) { b.disabled = false; b.textContent = '🎙 听歌识曲'; }
    });
  }

  // ---------- 打开/关闭识曲历史 ----------
  function showIdentHist() {
    if (!identHist.length) {
      try { identHist = JSON.parse(localStorage.getItem(IDENT_KEY) || '[]') || []; } catch (e) { identHist = []; }
    }
    if (!identHist.length) { toast('还没有识曲记录', 'warn'); return; }
    var body = document.createElement('div');
    body.innerHTML = identHist.map(function (h) {
      return '<div class="mini" style="padding:5px 2px;border-bottom:1px solid var(--border);">'
        + esc(h.name) + ' <span style="color:var(--muted)">· ' + esc(h.ar || '') + '</span></div>';
    }).join('');
    if (window.vhMenu && window.vhMenu.panel) {
      window.vhMenu.panel('识曲历史（' + identHist.length + '）', body, [
        { label: '清空', onClick: function () {
            identHist = [];
            try { localStorage.setItem(IDENT_KEY, '[]'); } catch (e) {}
            toast('已清空识曲历史', 'ok');
          } }
      ]);
    }
  }

  // ---------- 歌词面板（内嵌滚动，不依赖外部浮层） ----------
  function toggleLyricPanel(force) {
    var box = $('ncmLyric');
    if (!box) return;
    var wantOn = (force === undefined) ? (box.style.display === 'none') : !!force;
    box.style.display = wantOn ? '' : 'none';
    var b = $('btnNcmLyric');
    if (b) b.classList.toggle('on', wantOn);
    if (wantOn) {
      if (!lrcLines.length && cur && cur.id) loadLyric(cur.id);
      else renderLyric();
      status('歌词：' + (lrcLines.length ? lrcLines.length + ' 行' : '暂无'), lrcLines.length ? 'ok' : 'warn');
    }
  }

  // ---------- 初始化 ----------
  function init() {
    el = {
      loginState: $('ncmLoginState'), loginBox: $('ncmLoginBox'),
      kw: $('ncmSearchKw'), type: $('ncmSearchType'), list: $('ncmList'),
      count: $('ncmCount'), status: $('ncmStatus'),
      player: $('ncmPlayer'), title: $('ncmTitle'), sub: $('ncmSub'),
      cur: $('ncmCur'), dur: $('ncmDur'), fill: $('ncmSeekFill'),
      batch: $('btnNcmBatch'), selAll: $('chkNcmSelAll'), lyric: $('ncmLyric')
    };
    if (!el.list) return;
    if (el.list.__inited) { refreshLogin(); return; }
    el.list.__inited = true;

    bind('btnNcmSearch', doSearch);
    if (el.kw) el.kw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
    if (el.type) el.type.addEventListener('change', function () { if ((el.kw.value || '').trim()) doSearch(); });
    bind('btnNcmBatch', batchDownload);
    bind('btnNcmPickDir', function () { pickDlDir().then(function (d) { if (d) toast('下载目录：' + d, 'ok'); }); });
    bind('btnNcmLyric', function () { toggleLyricPanel(); });
    bind('btnNcmIdentify', doIdentify);
    bind('btnNcmIdentHist', showIdentHist);
    bind('btnNcmPlay', togglePlay);
    bind('btnNcmNext', nextSong);
    bind('btnNcmPrev', prevSong);
    if (el.selAll) el.selAll.addEventListener('change', function () { toggleSelectAll(el.selAll.checked); });

    // 音量
    var vs = $('ncmVol');
    if (vs) {
      try { vol = parseFloat(localStorage.getItem(VOL_KEY)) || 0.8; } catch (e) { vol = 0.8; }
      vs.value = vol;
      vs.addEventListener('input', function () {
        vol = parseFloat(vs.value) || 0;
        if (audio) audio.volume = vol;
        try { localStorage.setItem(VOL_KEY, String(vol)); } catch (e) {}
      });
    }

    // 列表事件委托
    el.list.addEventListener('click', function (e) {
      var t = e.target;
      var open = t.closest ? t.closest('.ncm-plopen, .ncm-pl') : null;
      if (open) {
        var id = open.dataset.id;
        var pl = (el.list._pls || []).filter(function (p) { return String(p.id) === String(id); })[0]
              || { id: id, name: '' };
        downloadPlaylist(pl);
        return;
      }
      if (t.closest && t.closest('.ncm-dlmade')) {
        var it0 = t.closest('.ncm-item');
        showDlMenu(it0, Number(t.closest('.ncm-dlmade').dataset.i), e);
        return;
      }
      if (t.closest && t.closest('.ncm-play')) { playAt(Number(t.closest('.ncm-play').dataset.i)); return; }
      if (t.closest && t.closest('.ncm-dl')) { downloadOne(Number(t.closest('.ncm-dl').dataset.i)); return; }
      if (t.closest && t.closest('.ncm-pool')) { toPoolOne(Number(t.closest('.ncm-pool').dataset.i)); return; }
      var item = t.closest ? t.closest('.ncm-item') : null;
      if (item && item.dataset.i !== undefined && !(t.tagName === 'INPUT')) playAt(Number(item.dataset.i));
    });
    // 拖拽已下载的歌到时间线
    el.list.addEventListener('dragstart', function (e) {
      var row = e.target.closest ? e.target.closest('.ncm-item.dl-ok') : null;
      if (!row) return;
      var path = dlMap[row.dataset.sid];
      if (!path) return;
      e.preventDefault();
      if (window.vhHost && window.vhHost.startDrag) window.vhHost.startDrag(path);
      status('正在拖出：' + baseName(path), '');
    });
    el.list.addEventListener('change', function (e) {
      var cb = e.target.closest ? e.target.closest('.ncm-cb') : null;
      if (!cb) return;
      var id = cb.dataset.id;
      var s = lastResults.filter(function (x) { return String(x.id) === String(id); })[0];
      if (cb.checked && s) selSet[id] = s; else delete selSet[id];
      refreshSelUI();
    });

    // 进度条点击
    var sk = $('ncmSeek');
    if (sk) sk.addEventListener('click', function (e) {
      if (!audio || !audio.duration) return;
      var r = sk.getBoundingClientRect();
      audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
    });

    bind('btnNcmMode', cycleMode);
    // 静音/取消静音
    bind('btnNcmVolBtn', function () {
      if (!audio) return;
      audio.muted = !audio.muted;
      var on = document.querySelector('#btnNcmVolBtn .ic-vol-on');
      var off = document.querySelector('#btnNcmVolBtn .ic-vol-off');
      if (on) on.style.display = audio.muted ? 'none' : '';
      if (off) off.style.display = audio.muted ? '' : 'none';
    });
    bind('btnNcmDlCur', function () {
      if (!cur) { toast('当前没有播放的歌曲', 'err'); return; }
      downloadSong(cur, false).catch(function (e) { status('下载失败：' + (e.message || e), 'err'); });
    });
    try { playMode = localStorage.getItem('vh_ncm_mode_v1') || 'list'; } catch (e) {}
    updateModeBtn();
    ensureDlDir();

    // 载入本地记录（已下载 / 识曲历史）
    loadDlMap();
    try { identHist = JSON.parse(localStorage.getItem(IDENT_KEY) || '[]') || []; } catch (e) { identHist = []; }

    // 进面板默认显示「我的歌单」
    refreshLogin().then(function (st) {
      if (st && st.loggedIn) {
        loadMyPlaylists(st.uid || st.userId);
      } else if (el.count) {
        el.count.textContent = '登录后可看我的歌单，或直接搜索';
      }
    });
  }

  window.__ncmPanel = {
    init: init,
    search: doSearch,
    _state: function () {
      return {
        results: lastResults.length,
        items: el.list ? el.list.querySelectorAll('.ncm-item').length : 0,
        playing: playing,
        cur: cur ? cur.name : null,
        login: el.loginState ? el.loginState.textContent : null,
        sel: Object.keys(selSet).length,
        lyric: lrcLines.length,
        dlDir: dlDir
      };
    }
  };
})();
