/**
 * vh-Atelier · DaVinci Resolve 版 · 短剧扒歌面板
 *
 * 【结构对齐 PR】两态切换：
 *   首页（bgmHome）：服务状态 + 搜索 + 榜单网格（含收藏/已下载 tab、题材分类）
 *   播放页（bgmPlayerWrap）：视频播放 + 自制控制条 + 连播 + 选集
 *
 * 后端：本地服务（主进程以 Electron 自身为 Node 拉起）
 *   GET  /health · /search?keyword= · /series?series_id= · /hot?kind=
 *   GET  /probe?series_id=&vid=      → 取某集播放直链
 *   POST /download {series_id,vid,name,ep} · POST /batch {series_id,name,from,count}
 *   GET  /status · /local-videos
 *
 * 关键修复（相对上一版）：
 *   ① 面板整体可滚动（原来是堆叠卡片 + overflow:hidden → 下方内容看不到）
 *   ② 点剧进入播放页（原来是原地展开，看不到下面的分集）
 *   ③ 双击分集即播放（原来没有播放链路）
 */
(function () {
  'use strict';

  var el = {};
  var srvReady = false;
  var cur = null;          // 当前剧 {series_id,name,cover,vid_list}
  var picked = {};
  var pollTimer = null;
  var curRank = 'all';
  var playEp = 0;          // 正在播放第几集
  var playIdx = -1;        // 在分集数组里的下标
  var autoNext = true;
  var identHist = [];
  var identTimer = null;

  var FAV_KEY = 'vh_bgm_fav_v1';
  var HIST_KEY = 'vh_bgm_hist_v1';
  var SEARCH_KEY = 'vh_bgm_search_v1';
  var PLAY_KEY = 'vh_bgm_play_v1';
  var favs = {};
  var hist = [];
  var searches = [];
  var playHist = [];

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(m, k) { if (window.__vhToast) window.__vhToast(m, k); else console.log('[bgm] ' + m); }
  function status(m, k) {
    if (!el.status) return;
    el.status.textContent = m || '';
    el.status.className = k || '';
  }
  function host() { return window.vhHost || {}; }

  // ---------- 数据访问 ----------
  function api(pathq) {
    if (!host().bgmApi) return Promise.reject(new Error('缺少扒歌接口'));
    return host().bgmApi(pathq).then(function (r) { return r && r.data !== undefined ? r.data : r; });
  }
  function post(pathq, body) {
    if (!host().bgmPost) return Promise.reject(new Error('缺少扒歌接口'));
    return host().bgmPost(pathq, body).then(function (r) { return r && r.data !== undefined ? r.data : r; });
  }

  // ---------- 服务 ----------
  function ensureServer() {
    if (srvReady) return Promise.resolve(true);
    status('正在启动本地服务…', '');
    return (host().bgmStart ? host().bgmStart() : Promise.reject(new Error('缺少 bgmStart')))
      .then(function () { return waitHealth(25); })
      .then(function (ok) {
        if (ok) status(srvText(), 'ok');
        return ok;
      })
      .catch(function (e) {
        status('服务启动失败：' + (e && e.message ? e.message : e), 'err');
        throw e;
      });
  }
  function srvText() {
    var s = el.srv ? (el.srv.textContent || '') : '';
    return s ? ('本地服务就绪 · ' + s.replace(/^服务就绪\s*·?\s*/, '')) : '本地服务就绪';
  }
  function waitHealth(tries) {
    return api('/health').then(function (h) {
      if (h && h.alive) { srvReady = true; setSrv(h); return true; }
      throw new Error('未就绪');
    }).catch(function () {
      if (tries <= 0) { setSrv({ alive: false }); throw new Error('服务启动失败，请点 ↻ 重试'); }
      return new Promise(function (r) { setTimeout(r, 800); }).then(function () { return waitHealth(tries - 1); });
    });
  }
  function setSrv(h) {
    if (!el.srv) return;
    if (h && h.alive) {
      var ok = [];
      if (h.logged) ok.push('已登录');
      if (h.ffmpeg) ok.push('ffmpeg');
      if (h.sherpa) ok.push('分离引擎');
      el.srv.textContent = '服务就绪' + (ok.length ? ' · ' + ok.join(' · ') : '');
      el.srv.className = 'mini ok';
    } else {
      el.srv.textContent = '服务未就绪';
      el.srv.className = 'mini err';
    }
  }

  // ---------- 收藏 / 历史 / 搜索历史 ----------
  function loadStore() {
    try { favs = JSON.parse(localStorage.getItem(FAV_KEY) || '{}') || {}; } catch (e) { favs = {}; }
    try { hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]') || []; } catch (e) { hist = []; }
    try { searches = JSON.parse(localStorage.getItem(SEARCH_KEY) || '[]') || []; } catch (e) { searches = []; }
    try { playHist = JSON.parse(localStorage.getItem(PLAY_KEY) || '[]') || []; } catch (e) { playHist = []; }
  }
  function saveFavs() { try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch (e) {} }
  function saveHist() { try { localStorage.setItem(HIST_KEY, JSON.stringify(hist.slice(0, 60))); } catch (e) {} }
  function saveSearches() { try { localStorage.setItem(SEARCH_KEY, JSON.stringify(searches.slice(0, 20))); } catch (e) {} }
  function savePlayHist() { try { localStorage.setItem(PLAY_KEY, JSON.stringify(playHist.slice(0, 40))); } catch (e) {} }

  function isFav(sid) { return !!favs[String(sid)]; }
  function toggleFav(sid, name, cover) {
    var k = String(sid);
    if (favs[k]) { delete favs[k]; saveFavs(); toast('已取消收藏：' + name, 'warn'); return false; }
    favs[k] = { name: name || '', cover: cover || '', t: Date.now() };
    saveFavs(); toast('已收藏：' + name, 'ok'); return true;
  }
  function addHist(sid, name, cover) {
    var k = String(sid);
    hist = hist.filter(function (h) { return String(h.id) !== k; });
    hist.unshift({ id: k, name: name || '', cover: cover || '', t: Date.now() });
    saveHist(); renderHist();
  }
  function addPlayHist(ep) {
    if (!cur) return;
    var k = String(cur.series_id);
    playHist = playHist.filter(function (h) { return String(h.id) !== k; });
    playHist.unshift({ id: k, name: cur.name, cover: cur.cover || '', ep: ep, t: Date.now() });
    playHist = playHist.slice(0, 40);
    savePlayHist();
  }
  function addSearch(kw) {
    kw = String(kw || '').trim();
    if (!kw) return;
    searches = searches.filter(function (s) { return s !== kw; });
    searches.unshift(kw);
    searches = searches.slice(0, 20);
    saveSearches(); renderSearchHist();
  }

  // ---------- 视图切换（首页 / 播放页） ----------
  function showHome() {
    if (el.home) el.home.style.display = '';
    if (el.playerWrap) el.playerWrap.style.display = 'none';
    stopBuf();
    try { pauseVideo(); } catch (e) {}
  }
  function showPlayer() {
    if (el.home) el.home.style.display = 'none';
    if (el.playerWrap) el.playerWrap.style.display = '';
  }

  // ---------- 榜单 ----------
  var RANK_KINDS = [
    { k: 'all', t: '热播总榜' }, { k: 'real', t: '真人剧榜' },
    { k: 'ai', t: 'AI 剧榜' }, { k: 'comic', t: '漫剧榜' },
    { k: 'fav', t: '⭐ 收藏' }
  ];
  var CAT_KINDS = [
    { k: 'cat:urban', t: '都市' }, { k: 'cat:romance', t: '甜宠' },
    { k: 'cat:comeback', t: '逆袭' }, { k: 'cat:suspense', t: '悬疑' },
    { k: 'cat:costume', t: '古装' }, { k: 'cat:cute-kids', t: '萌宝' },
    { k: 'cat:fantasy', t: '奇幻' }, { k: 'cat:family', t: '家庭' },
    { k: 'cat:comedy', t: '喜剧' }, { k: 'cat:action-adventure', t: '动作' }
  ];

  function loadRank(kind) {
    curRank = kind || curRank;
    renderRankTabs();
    if (curRank === 'fav') { renderFavGrid(); return; }
    if (el.rank) el.rank.innerHTML = '<div class="empty">读取中…</div>';
    ensureServer().then(function () {
      return api('/hot?kind=' + encodeURIComponent(curRank));
    }).then(function (d) {
      renderRank((d && d.data) || []);
    }).catch(function (e) {
      if (el.rank) el.rank.innerHTML = '<div class="empty">榜单读取失败：' + esc(e.message || e) + '</div>';
    });
  }

  function renderRankTabs() {
    if (!el.rankTabs) return;
    el.rankTabs.innerHTML = RANK_KINDS.map(function (x) {
      return '<button class="tbtn' + (x.k === curRank ? ' on' : '') + '" data-rank="' + x.k + '">'
        + esc(x.t) + '</button>';
    }).join('') + '<span class="bgm-tab-label">题材</span>'
      + CAT_KINDS.map(function (x) {
        return '<button class="tbtn' + (x.k === curRank ? ' on' : '') + '" data-rank="' + x.k + '">'
          + esc(x.t) + '</button>';
      }).join('');
  }

  function mkCard(s) {
    var nm = s.name || '';
    var cov = s.cover || '';
    var sid = s.series_id || s.id || '';
    var tags = (s.tags && s.tags.length) ? s.tags.join('/') : '';
    return '<div class="bgm-card" data-sid="' + esc(sid) + '" data-name="' + esc(nm) + '"'
      + ' data-cover="' + esc(cov) + '" title="' + esc(nm) + '">'
      + (cov ? '<img class="bgm-cover" src="' + esc(cov) + '" alt="" loading="lazy">'
             : '<span class="bgm-cover bgm-cover-ph">🎬</span>')
      + '<span class="bgm-card-name">' + esc(nm) + '</span>'
      + (tags ? '<span class="bgm-card-tag">' + esc(tags.slice(0, 18)) + '</span>' : '')
      + '<button class="bgm-fav' + (isFav(sid) ? ' on' : '') + '" data-fav-sid="' + esc(sid) + '"'
      + ' data-fav-name="' + esc(nm) + '" data-fav-cover="' + esc(cov) + '"'
      + ' title="收藏">' + (isFav(sid) ? '★' : '☆') + '</button>'
      + '</div>';
  }

  function renderRank(arr) {
    if (!el.rank) return;
    if (!arr.length) {
      el.rank.innerHTML = '<div class="mini" style="padding:10px;">该榜单暂无内容，可换一个分类或直接搜索</div>';
      return;
    }
    el.rank.innerHTML = '<div class="bgm-grid">' + arr.map(mkCard).join('') + '</div>';
  }

  function renderFavGrid() {
    if (!el.rank) return;
    var keys = Object.keys(favs).sort(function (a, b) { return (favs[b].t || 0) - (favs[a].t || 0); });
    if (!keys.length) {
      el.rank.innerHTML = '<div class="mini" style="padding:10px;">还没有收藏。在榜单卡片右上角点 ☆ 即可收藏。</div>';
      return;
    }
    el.rank.innerHTML = '<div class="bgm-grid">' + keys.map(function (k) {
      var f = favs[k];
      return '<div class="bgm-card" data-sid="' + esc(k) + '" data-name="' + esc(f.name) + '"'
        + ' data-cover="' + esc(f.cover) + '" title="' + esc(f.name) + '">'
        + (f.cover ? '<img class="bgm-cover" src="' + esc(f.cover) + '" alt="" loading="lazy">'
                   : '<span class="bgm-cover bgm-cover-ph">⭐</span>')
        + '<span class="bgm-card-name">' + esc(f.name) + '</span>'
        + '<button class="bgm-fav on" data-fav-sid="' + esc(k) + '" data-fav-name="' + esc(f.name) + '"'
        + ' data-fav-cover="' + esc(f.cover) + '" title="收藏">★</button>'
        + '</div>';
    }).join('') + '</div>';
  }

  function renderHist() {
    if (!el.hist) return;
    if (!hist.length) { el.hist.innerHTML = '<div class="mini" style="padding:8px;">还没有记录</div>'; return; }
    el.hist.innerHTML = '<div class="bgm-grid">' + hist.map(function (h) {
      return '<div class="bgm-card" data-sid="' + esc(h.id) + '" data-name="' + esc(h.name) + '"'
        + ' data-cover="' + esc(h.cover) + '" title="' + esc(h.name) + '">'
        + (h.cover ? '<img class="bgm-cover" src="' + esc(h.cover) + '" alt="" loading="lazy">'
                   : '<span class="bgm-cover bgm-cover-ph">🎬</span>')
        + '<span class="bgm-card-name">' + esc(h.name) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderPlayHist() {
    if (!el.playHistWrap) return;
    if (!playHist.length) { el.playHistWrap.style.display = 'none'; return; }
    el.playHistWrap.style.display = '';
    var one = playHist.slice(0, 8);
    el.playHist.innerHTML = one.map(function (h) {
      return '<div class="bgm-card" data-sid="' + esc(h.id) + '" data-name="' + esc(h.name) + '"'
        + ' data-cover="' + esc(h.cover) + '" data-ep="' + esc(String(h.ep || 1)) + '" title="' + esc(h.name) + '">'
        + (h.cover ? '<img class="bgm-cover" src="' + esc(h.cover) + '" alt="" loading="lazy">'
                   : '<span class="bgm-cover bgm-cover-ph">🎬</span>')
        + '<span class="bgm-card-name">' + esc(h.name) + '</span>'
        + '<span class="bgm-card-tag">第 ' + esc(String(h.ep || 1)) + ' 集</span></div>';
    }).join('');
  }

  function renderSearchHist() {
    if (!el.searchHistWrap) return;
    if (!searches.length) { el.searchHistWrap.style.display = 'none'; return; }
    el.searchHistWrap.style.display = '';
    el.searchHist.innerHTML = searches.map(function (s) {
      return '<span class="bgm-chip" data-kw="' + esc(s) + '">' + esc(s) + '</span>';
    }).join('');
  }

  // ---------- 搜索 ----------
  function doSearch(kwArg) {
    var kw = String(kwArg || (el.kw && el.kw.value) || '').trim();
    if (!kw) { toast('请输入剧名，或粘贴分享链接', 'err'); return; }
    if (el.kw) el.kw.value = kw;
    addSearch(kw);
    status('搜索中…', '');
    if (el.searchList) el.searchList.innerHTML = '<div class="empty">搜索中…</div>';
    if (el.searchWrap) el.searchWrap.style.display = '';

    var isUrl = /^https?:\/\//i.test(kw);
    var req = isUrl
      ? api('/share-parse?text=' + encodeURIComponent(kw))
      : api('/search?keyword=' + encodeURIComponent(kw));

    ensureServer().then(function () { return req; }).then(function (d) {
      var arr = (d && d.data) || [];
      if (arr && !Array.isArray(arr) && arr.series_id) arr = [arr];
      if (!Array.isArray(arr)) arr = [];
      renderSearch(arr);
      status(arr.length ? ('找到 ' + arr.length + ' 部') : '没有找到', arr.length ? 'ok' : 'warn');
    }).catch(function (e) {
      status('搜索失败：' + (e.message || e), 'err');
      if (el.searchList) el.searchList.innerHTML = '<div class="empty">搜索失败：' + esc(e.message || e) + '</div>';
    });
  }

  function renderSearch(arr) {
    if (!el.searchList) return;
    if (!arr.length) { el.searchList.innerHTML = '<div class="empty">没有结果</div>'; return; }
    el.searchList.innerHTML = '<div class="bgm-grid">' + arr.map(mkCard).join('') + '</div>';
  }

  // ---------- 打开剧（进播放页） ----------
  function openSeries(sid, name, cover, wantEp) {
    if (!sid) { toast('缺少剧 ID', 'err'); return; }
    status('读取分集…', '');
    showPlayer();
    if (el.playerTitle) el.playerTitle.textContent = '加载中…';
    stopBuf(); bufShow('正在读取分集…', { sub: name || '' });

    api('/series?series_id=' + encodeURIComponent(sid)).then(function (d) {
      var info = (d && d.data) || d || {};
      var vids = info.vid_list || info.vids || [];
      cur = {
        series_id: sid,
        name: info.name || name || '',
        cover: info.cover || cover || '',
        vid_list: vids
      };
      picked = {};
      addHist(sid, cur.name, cur.cover);
      bufHide();
      renderPlayerInfo();
      renderEps();
      if (wantEp) {
        var idx = vids.indexOf(wantEp);
        if (idx < 0) idx = Number(wantEp) - 1;
        playAt(idx);
      } else if (vids.length) {
        // 进播放页自动播第 1 集（对齐 PR「点完剧自动跳转播放」）
        playAt(0);
      }
    }).catch(function (e) {
      bufShow('读取分集失败：' + (e.message || e), { sub: '可点左上「返回」换一部' });
      status('读取分集失败：' + (e.message || e), 'err');
    });
  }

  function renderPlayerInfo() {
    if (!cur) return;
    if (el.playerTitle) el.playerTitle.textContent = cur.name || '';
    if (el.playerCover) {
      if (cur.cover) { el.playerCover.src = cur.cover; el.playerCover.style.display = ''; }
      else { el.playerCover.removeAttribute('src'); el.playerCover.style.display = 'none'; }
    }
    if (el.epMeta) el.epMeta.textContent = '共 ' + cur.vid_list.length + ' 集';
  }

  function renderEps() {
    if (!el.epList) return;
    var vids = (cur && cur.vid_list) || [];
    if (!vids.length) { el.epList.innerHTML = '<div class="empty">没有分集</div>'; updatePick(); return; }
    el.epList.innerHTML = vids.map(function (v, i) {
      var n = i + 1;
      var on = (n === playEp) ? ' on' : '';
      return '<label class="bgm-ep' + on + '" data-ep="' + n + '">'
        + '<input type="checkbox" class="bgm-cb" data-ep="' + n + '"' + (picked[n] ? ' checked' : '') + '>'
        + '<span class="bgm-epname" title="双击播放第 ' + n + ' 集">第 ' + n + ' 集</span>'
        + '<button class="tbtn bgm-epplay" data-ep="' + n + '" title="播放本集">▶</button>'
        + '</label>';
    }).join('');
    updatePick();
  }

  function updatePick() {
    var n = Object.keys(picked).length;
    if (el.dl) { el.dl.textContent = '⬇ 下载并扒歌选中(' + n + ')'; el.dl.disabled = n === 0; }
  }

  // ---------- 播放 ----------
  function bufShow(msg, opt) {
    opt = opt || {};
    if (!el.buf) return;
    el.buf.style.display = '';
    if (el.bufMsg) el.bufMsg.textContent = msg || '';
    if (el.bufSub) el.bufSub.textContent = opt.sub || '';
    if (el.bufBarWrap) el.bufBarWrap.style.display = (opt.pct == null) ? 'none' : '';
    if (el.bufFill && opt.pct != null) el.bufFill.style.width = Math.max(0, Math.min(100, opt.pct)) + '%';
    if (el.bufCancel) el.bufCancel.style.display = opt.cancellable ? '' : 'none';
  }
  function bufHide() { if (el.buf) el.buf.style.display = 'none'; }
  function stopBuf() { bufHide(); }

  function playAt(idx) {
    var vids = (cur && cur.vid_list) || [];
    if (idx < 0 || idx >= vids.length) return;
    var ep = idx + 1;
    var vid = vids[idx];
    playEp = ep;
    playIdx = idx;
    showPlayer();
    if (el.playerTitle) el.playerTitle.textContent = (cur.name || '') + ' 第 ' + ep + ' 集';
    renderEps();

    // ① 先看本地是否已有这一集（下载过的直接播，最快）
    bufShow('正在检查本地第 ' + ep + ' 集…', { sub: '' });
    api('/local-videos').then(function (d) {
      var raw = pickFileList(d);
      var path = findLocalEp(raw, ep);
      if (path) {
        status('播放本地文件：第 ' + ep + ' 集', 'ok');
        return host().bgmApiRaw('/video?prefer=h264&file=' + encodeURIComponent(path)).then(function (r) {
          var url = (r && r.data !== undefined ? r.data : r) || path;
          return playUrl(url, ep);
        });
      }
      // ② 本地没有 → 试在线直链（官网仅前几集开放）
      bufShow('正在解析第 ' + ep + ' 集在线地址…', { sub: '官网仅前 3 集可在线播放' });
      status('解析第 ' + ep + ' 集…', '');
      return api('/probe?series_id=' + encodeURIComponent(cur.series_id) + '&vid=' + encodeURIComponent(vid))
        .then(function (dd) {
          var info = (dd && dd.data) || dd || {};
          var url = info.url || info.main_url || info.play_url || '';
          if (!url) throw new Error('该集未开放试看');
          return playUrl(url, ep);
        })
        .catch(function (e) {
          var msg = (e && e.message) || '';
          var limited = msg.indexOf('试看') >= 0 || msg.indexOf('未开放') >= 0;
          // ③ 都不行 → 自动下载后播放（对齐 PR「边下边看」）
          bufShow(
            limited ? ('第 ' + ep + ' 集需下载后播放（官网只开放前 3 集在线）')
                    : ('在线播放不可用，正在下载第 ' + ep + ' 集'),
            { pct: 0, sub: '下载完成后会自动播放', cancellable: true }
          );
          status('自动下载第 ' + ep + ' 集…', '');
          return downloadThenPlay(vid, ep);
        });
    }).catch(function (e) {
      bufShow('播放失败：' + (e && e.message ? e.message : e), { sub: '可换一集或稍后重试' });
    });
  }

  function playUrl(url, ep) {
    var v = el.video;
    if (!v) return;
    // 经本地服务代理，避免跨域与 Referer 限制
    bufShow('正在缓冲第 ' + ep + ' 集…', { sub: '' });
    // 代理地址要经主进程取（异步），这里先算出再赋给 video
    var srcP = host().bgmProxyUrl
      ? host().bgmProxyUrl(url).then(function (r) { return (r && r.data !== undefined ? r.data : r) || url; })
        .catch(function () { return url; })
      : Promise.resolve(url);
    return srcP.then(function (src) { return doPlay(src, url, ep); });
  }

  function doPlay(src, rawUrl, ep) {
    var v = el.video;
    if (!v) return Promise.resolve();
    v.dataset.ep = String(ep);
    v.src = src;
    return new Promise(function (resolve) {
      var done = false;
      function ok() {
        if (done) return; done = true;
        bufHide();
        v.play().then(function () {
          status('正在播放：' + (cur.name || '') + ' 第 ' + ep + ' 集', 'ok');
          addPlayHist(ep);
          renderEps();
        }).catch(function () { /* 用户手势限制，控件可手动播 */ });
        resolve();
      }
      function fail() {
        if (done) return; done = true;
        bufShow('播放失败，可点「下载后播放」或换一集', { sub: String(rawUrl).slice(0, 80) });
        resolve();
      }
      v.addEventListener('canplay', ok, { once: true });
      v.addEventListener('error', fail, { once: true });
      try { v.load(); } catch (e) {}
      setTimeout(function () { if (!done) ok(); }, 8000);
    });
  }

  /** 下载该集（并顺带扒歌），完成后本地播放 */
  function downloadThenPlay(vid, ep) {
    return post('/download', { series_id: cur.series_id, vid: vid, name: cur.name, ep: ep })
      .then(function (d) {
        if (d && d.code === -1) throw new Error(d.msg || '提交失败');
        startPoll();
        pollUntilDone(ep);
      }).catch(function (e) {
        bufShow('下载失败：' + (e.message || e), { sub: '可换一集或稍后重试' });
      });
  }

  var pollWatch = null;
  function pollUntilDone(ep) {
    if (pollWatch) clearInterval(pollWatch);
    pollWatch = setInterval(function () {
      api('/status').then(function (d) {
        var jobs = (d && (d.jobs || d.tasks)) || [];
        if (!Array.isArray(jobs) || !jobs.length) {
          clearInterval(pollWatch); pollWatch = null;
          bufShow('下载完成，正在准备播放…', { sub: '' });
          // 稍等一下让文件落稳，再走完整播放流程（会命中本地文件分支）
          setTimeout(function () { playAt(ep - 1); }, 800);
          return;
        }
        var j = jobs[0];
        var pct = j.percent != null ? j.percent : (j.done != null && j.total ? Math.round(j.done / j.total * 100) : null);
        bufShow('下载中：' + (j.title || j.kind || '') + (pct != null ? ' ' + pct + '%' : ''), {
          pct: pct == null ? 0 : pct, sub: j.msg || '完成后自动播放', cancellable: true
        });
      }).catch(function () {});
    }, 1500);
  }

  /** 从 /local-videos 的返回里取出文件数组（返回是 {code,data:{dir,files}}） */
  function pickFileList(d) {
    if (!d) return [];
    if (Array.isArray(d)) return d;
    // 常见几种包装
    if (Array.isArray(d.files)) return d.files;
    if (d.data) {
      if (Array.isArray(d.data)) return d.data;
      if (d.data && Array.isArray(d.data.files)) return d.data.files;
      if (d.data && Array.isArray(d.data.list)) return d.data.list;
    }
    if (Array.isArray(d.list)) return d.list;
    return [];
  }

  /**
   * 从本地文件列表里找第 ep 集。
   * 实际命名是「剧名_0001.mp4」（补零，下划线分隔），也可能带「第N集」。
   * 优先按当前剧名匹配，避免跨剧串集。
   */
  function findLocalEp(list, ep) {
    var want = String(ep);
    var pad4 = ('0000' + want).slice(-4);
    var nm = (cur && cur.name) || '';
    function pathOf(f) { return typeof f === 'string' ? f : (f.path || f.file || ''); }
    function score(p) {
      p = String(p || '');
      var base = p.split(/[\\/]/).pop();
      if (!base) return -1;
      var s = 0;
      // 剧名一致优先（避免不同剧的 0001 互相串）
      if (nm && base.indexOf(nm) >= 0) s += 10;
      // 集号形式：_0001 / _1 / 第1集 / -01
      if (new RegExp('[_\-]' + pad4 + '(\.|$)').test(base)) s += 5;
      if (new RegExp('第' + want + '集').test(base)) s += 5;
      if (new RegExp('(^|[^0-9])' + want + '([^0-9]|$)').test(base)) s += 3;
      return s;
    }
    var best = null, bestS = 0;
    list.forEach(function (f) {
      var p = pathOf(f);
      var s = score(p);
      if (s > bestS) { bestS = s; best = p; }
    });
    return best || '';
  }

  /** 播放已下载到本地的某集 */
  function playLocal(ep) {
    return api('/local-videos').then(function (d) {
      var raw = pickFileList(d);
      var one = findLocalEp(raw, ep);
      var path = one ? (typeof one === 'string' ? one : (one.path || one.file)) : '';
      if (!path) { bufShow('未找到第 ' + ep + ' 集的本地文件', { sub: '可点「下载并扒歌选中」' }); return; }
      if (!host().bgmApiRaw) { bufShow('缺少本地播放接口', { sub: '' }); return; }
      return host().bgmApiRaw('/video?prefer=h264&file=' + encodeURIComponent(path)).then(function (r) {
        var url = (r && r.data !== undefined ? r.data : r) || ('http://127.0.0.1:17911/video?prefer=h264&file=' + encodeURIComponent(path));
        return playUrl(url, ep);
      }).catch(function (e) {
        bufShow('播放本地文件失败：' + (e.message || e), { sub: '' });
      });
    }).catch(function (e) {
      bufShow('读取本地文件失败：' + (e.message || e), { sub: '' });
    });
  }

  function pauseVideo() { if (el.video) { try { el.video.pause(); } catch (e) {} } }

  // ---------- 下载（批量） ----------
  function downloadPicked() {
    if (!cur) { toast('请先选一部剧', 'err'); return; }
    var eps = Object.keys(picked).map(Number).sort(function (a, b) { return a - b; });
    if (!eps.length) { toast('请先选集', 'err'); return; }
    status('提交下载任务…', '');
    post('/batch', { series_id: cur.series_id, name: cur.name, from: eps[0], count: eps.length })
      .then(function (d) {
        if (d && d.code === -1) { status('提交失败：' + (d.msg || ''), 'err'); return; }
        status('已提交：' + cur.name + ' 第 ' + eps[0] + ' 集起 ' + eps.length + ' 集', 'ok');
        toast('已提交下载任务', 'ok');
        startPoll();
      }).catch(function (e) { status('提交失败：' + (e.message || e), 'err'); });
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      api('/status').then(function (d) {
        if (!d) return;
        var jobs = (d.jobs || d.tasks) || [];
        if (Array.isArray(jobs) && jobs.length) {
          var j = jobs[0];
          var pct = j.percent != null ? (j.percent + '%') : (j.done != null ? (j.done + '/' + (j.total || '?')) : '');
          if (el.prog) el.prog.textContent = (j.title || j.kind || '任务') + ' ' + pct + (j.msg ? ' · ' + j.msg : '');
        } else if (el.prog) {
          el.prog.textContent = '';
          clearInterval(pollTimer); pollTimer = null;
        }
      }).catch(function () {});
    }, 1500);
  }

  // ---------- 导入 ----------
  function importDone() {
    status('读取下载结果…', '');
    api('/local-videos').then(function (d) {
      var raw = pickFileList(d);
      var paths = raw.map(function (f) { return typeof f === 'string' ? f : (f.path || f.file || f.name); })
        .filter(function (p) { return p && /[\\/]/.test(p); });
      if (!paths.length) { status('没有可导入的文件（先下载几集）', 'warn'); return; }
      return host().importFilesToPool(paths, '扒歌').then(function (r) {
        var dd = r && r.data ? r.data : r;
        status('已导入 ' + (dd.count || paths.length) + ' 个到「扒歌」素材箱', 'ok');
        toast('已导入素材池', 'ok');
      });
    }).catch(function (e) { status('导入失败：' + (e.message || e), 'err'); });
  }

  // ---------- 听歌识曲（悬浮，复用网易云链路） ----------
  function toggleIdentify(force) {
    if (!el.identPanel) return;
    var wantOn = (force === undefined) ? (el.identPanel.style.display === 'none') : !!force;
    el.identPanel.style.display = wantOn ? '' : 'none';
    if (!wantOn && identTimer) { clearInterval(identTimer); identTimer = null; }
  }
  function runIdentify() {
    if (!host().ncmIdentify) { toast('识曲接口不可用', 'err'); return; }
    if (el.identProgress) el.identProgress.textContent = '录音中（6 秒）…';
    host().ncmIdentify(6).then(function (r) {
      var d = r && r.data !== undefined ? r.data : r;
      var ms = (d && d.matches) || [];
      if (!ms.length) {
        if (el.identProgress) el.identProgress.textContent = '没有识别到';
        return;
      }
      var out = ms.map(function (m) {
        return { name: (m.song && m.song.name) || '', ar: ((m.song && m.song.artists) || []).map(function (a) { return a.name; }).join('/') };
      }).filter(function (x) { return x.name; });
      if (el.identResult) {
        el.identResult.style.display = '';
        el.identResult.innerHTML = out.map(function (x) {
          return '<div class="mini" style="padding:3px 0;">' + esc(x.name) + ' <span style="color:var(--muted)">' + esc(x.ar) + '</span></div>';
        }).join('');
      }
      if (el.identProgress) el.identProgress.textContent = '识别到 ' + out.length + ' 首';
      identHist.unshift(out[0]);
    }).catch(function (e) {
      if (el.identProgress) el.identProgress.textContent = '失败：' + (e.message || e);
    });
  }

  // ---------- 初始化 ----------
  function init() {
    el = {
      srv: $('bgmSrvState'), kw: $('bgmKw'), list: $('bgmList'), eps: $('bgmEps'),
      count: $('bgmCount'), status: $('bgmStatus'), dl: $('bgmDl'), prog: $('bgmProg'),
      rank: $('bgmRank'), rankTabs: $('bgmRankTabs'),
      home: $('bgmHome'), searchWrap: $('bgmSearchWrap'), searchList: $('bgmSearchList'),
      searchHistWrap: $('bgmSearchHistWrap'), searchHist: $('bgmSearchHist'),
      fav: $('bgmFav'), hist: $('bgmHist'),
      playHistWrap: $('bgmPlayHistWrap'), playHist: $('bgmPlayHist'),
      playerWrap: $('bgmPlayerWrap'), playerTitle: $('bgmPlayerTitle'),
      playerCover: $('bgmPlayerCover'), epMeta: $('bgmEpMeta'), epList: $('bgmEpList'),
      video: $('bgmV'), buf: $('bgmBuf'), bufMsg: $('bgmBufMsg'), bufSub: $('bgmBufSub'),
      bufBarWrap: $('bgmBufBarWrap'), bufFill: $('bgmBufFill'), bufCancel: $('bgmBufCancel'),
      chkNext: $('bgmAutoNext'),
      identPanel: $('bgmIdentifyPanel'), identProgress: $('bgmIdentifyProgress'),
      identResult: $('bgmIdentifyResult')
    };
    if (!el.home) return;
    if (el.home.__inited) return;
    el.home.__inited = true;

    loadStore();
    renderRankTabs(); renderHist(); renderSearchHist(); renderPlayHist();

    // 搜索
    var sb = $('btnBgmSearch');
    if (sb) sb.addEventListener('click', function () { doSearch(); });
    if (el.kw) el.kw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
    var rb = $('btnBgmRefresh');
    if (rb) rb.addEventListener('click', function () {
      srvReady = false;
      ensureServer().then(function () { loadRank(curRank); toast('服务已就绪', 'ok'); })
        .catch(function (e) { toast('启动失败：' + (e.message || e), 'err'); });
    });

    // 榜单（事件委托）
    if (el.rankTabs) {
      el.rankTabs.addEventListener('click', function (e) {
        var tb = e.target.closest ? e.target.closest('[data-rank]') : null;
        if (tb) loadRank(tb.dataset.rank);
      });
    }
    bindCardClicks(el.rank);
    bindCardClicks(el.searchList);
    bindCardClicks(el.hist);
    bindCardClicks(el.playHist);

    // 搜索历史
    if (el.searchHist) {
      el.searchHist.addEventListener('click', function (e) {
        var c = e.target.closest ? e.target.closest('[data-kw]') : null;
        if (c) doSearch(c.dataset.kw);
      });
    }
    var shc = $('btnBgmSearchHistClear');
    if (shc) shc.addEventListener('click', function () {
      searches = []; saveSearches(); renderSearchHist();
    });

    // 清空按钮
    var hc = $('btnBgmHistClear');
    if (hc) hc.addEventListener('click', function () { hist = []; saveHist(); renderHist(); toast('已清空', 'ok'); });
    var phc = $('btnBgmPlayHistClear');
    if (phc) phc.addEventListener('click', function () { playHist = []; savePlayHist(); renderPlayHist(); });

    // 播放页控件
    var back = $('btnBgmBack');
    if (back) back.addEventListener('click', function () { pauseVideo(); showHome(); });
    var pv = $('btnBgmPlayerPrev');
    if (pv) pv.addEventListener('click', function () { if (playIdx > 0) playAt(playIdx - 1); });
    var nx = $('btnBgmPlayerNext');
    if (nx) nx.addEventListener('click', function () { playAt(playIdx + 1); });
    var cl = $('btnBgmPlayerClose');
    if (cl) cl.addEventListener('click', function () { pauseVideo(); showHome(); });
    var pc = $('btnBgmPlayerPlay');
    if (pc) pc.addEventListener('click', function () {
      var v = el.video;
      if (!v) return;
      if (v.paused) v.play().catch(function () {}); else v.pause();
    });
    if (el.chkNext) el.chkNext.addEventListener('change', function () { autoNext = el.chkNext.checked; });
    if (el.video) {
      el.video.addEventListener('ended', function () {
        if (autoNext && playIdx >= 0 && playIdx + 1 < ((cur && cur.vid_list) || []).length) playAt(playIdx + 1);
      });
      el.video.addEventListener('timeupdate', function () {
        var v = el.video;
        if (el.cur && v.duration) el.cur.textContent = fmtSec(v.currentTime);
        if (el.dur && v.duration) el.dur.textContent = fmtSec(v.duration);
        if (el.fill && v.duration) el.fill.style.width = (v.currentTime / v.duration * 100) + '%';
      });
    }
    var seek = $('bgmSeek');
    if (seek) seek.addEventListener('click', function (e) {
      var v = el.video;
      if (!v || !v.duration) return;
      var r = seek.getBoundingClientRect();
      v.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * v.duration;
    });

    // 分集：双击播放 / 勾选 / 播放按钮
    if (el.epList) {
      el.epList.addEventListener('dblclick', function (e) {
        var row = e.target.closest ? e.target.closest('.bgm-ep') : null;
        if (row) playAt(Number(row.dataset.ep) - 1);
      });
      el.epList.addEventListener('click', function (e) {
        var pb = e.target.closest ? e.target.closest('.bgm-epplay') : null;
        if (pb) { e.preventDefault(); e.stopPropagation(); playAt(Number(pb.dataset.ep) - 1); return; }
      });
      el.epList.addEventListener('change', function (e) {
        var cb = e.target.closest ? e.target.closest('.bgm-cb') : null;
        if (!cb) return;
        var n = Number(cb.dataset.ep);
        if (cb.checked) picked[n] = true; else delete picked[n];
        updatePick();
      });
    }

    // 下载区
    if (el.dl) el.dl.addEventListener('click', downloadPicked);
    var ab = $('btnBgmAll');
    if (ab) ab.addEventListener('click', function () { selectAll(true); });
    var nb = $('btnBgmNone');
    if (nb) nb.addEventListener('click', function () { selectAll(false); });
    var ib = $('btnBgmImport');
    if (ib) ib.addEventListener('click', importDone);

    // 识曲
    var fab = $('bgmIdentifyFab');
    if (fab) fab.addEventListener('click', function () { toggleIdentify(); runIdentify(); });
    var ic = $('btnBgmIdentifyClose');
    if (ic) ic.addEventListener('click', function () { toggleIdentify(false); });

    // 缓冲区取消
    if (el.bufCancel) el.bufCancel.addEventListener('click', function () {
      if (pollWatch) { clearInterval(pollWatch); pollWatch = null; }
      bufHide();
    });

    // 启动：进面板即拉榜单
    ensureServer().then(function () { loadRank(curRank); }).catch(function (e) {
      status('服务未就绪：' + (e.message || e), 'err');
    });
  }

  function bindCardClicks(box) {
    if (!box || box.__cardBound) return;
    box.__cardBound = true;
    box.addEventListener('click', function (e) {
      var fb = e.target.closest ? e.target.closest('.bgm-fav') : null;
      if (fb) {
        e.stopPropagation();
        var on = toggleFav(fb.dataset.favSid, fb.dataset.favName, fb.dataset.favCover);
        fb.textContent = on ? '★' : '☆';
        fb.classList.toggle('on', on);
        if (curRank === 'fav') renderFavGrid();
        return;
      }
      var cd = e.target.closest ? e.target.closest('.bgm-card') : null;
      if (cd && cd.dataset.sid) {
        openSeries(cd.dataset.sid, cd.dataset.name, cd.dataset.cover, cd.dataset.ep);
      }
    });
    box.addEventListener('contextmenu', function (e) {
      var cd = e.target.closest ? e.target.closest('.bgm-card') : null;
      if (!cd || !cd.dataset.sid) return;
      e.preventDefault();
      if (window.vhMenu) window.vhMenu.show(e, [
        { label: '▶ 打开播放', onClick: function () { openSeries(cd.dataset.sid, cd.dataset.name, cd.dataset.cover); } },
        { label: isFav(cd.dataset.sid) ? '★ 取消收藏' : '☆ 收藏该剧', onClick: function () {
            toggleFav(cd.dataset.sid, cd.dataset.name, cd.dataset.cover);
            if (curRank === 'fav') renderFavGrid();
          } },
        { sep: true },
        { label: '⬇ 下载该剧全部', onClick: function () { openSeries(cd.dataset.sid, cd.dataset.name, cd.dataset.cover); } }
      ]);
    });
  }

  function selectAll(on) {
    if (!cur || !cur.vid_list) return;
    picked = {};
    if (on) cur.vid_list.forEach(function (v, i) { picked[i + 1] = true; });
    renderEps();
  }

  function fmtSec(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  window.__bgmPanel = {
    init: init,
    openSeries: openSeries,
    playAt: playAt,
    showHome: showHome,
    _state: function () {
      return {
        srvReady: srvReady,
        view: (el.home && el.home.style.display === 'none') ? 'player' : 'home',
        cur: cur ? cur.name : null,
        eps: cur ? cur.vid_list.length : 0,
        cards: el.rank ? el.rank.querySelectorAll('.bgm-card').length : 0,
        epRows: el.epList ? el.epList.querySelectorAll('.bgm-ep').length : 0,
        playingEp: playEp,
        favs: Object.keys(favs).length
      };
    }
  };
})();
