/**
 * vh-Atelier · DaVinci Resolve 版 · 音效库
 *
 * 布局与交互对齐 PR 版：
 *   工具栏（目录 / 搜索 / 浏览-收藏切换）
 *   ├ 左侧文件夹树（mllib-tree）
 *   └ 右侧虚拟滚动列表（sfx-list + sfx-spacer + 绝对定位的 sfx-item）
 *      每项：名称 · 播放按钮 · wavesurfer 波形 · 时长 · 扩展名 · 收藏
 *   底部播放条（播放/暂停 · 上一首/下一首 · 进度 · 音量）
 *
 * 与 PR 版的差异：
 *   - 拖拽：PR 用 CEP 专用 DnD API，这里改用 Electron 的 webContents.startDrag
 *   - 文件读取：PR 走 CEP 的 fs，这里走主进程 IPC
 */
(function () {
  'use strict';

  var ITEM_H = 44;          // 须与 CSS .sfx-item height 一致
  var WINDOW_PAD = 6;       // 虚拟滚动上下各多渲染几行
  var FAV_KEY = 'pr_me_sfxfav_v1';
  var ROOT_KEY = 'pr_me_sfxroot_v1';

  var el = {};
  var files = [];           // 全部扫描到的文件
  var visibleFiles = [];    // 当前视图（经过搜索/收藏过滤）
  var fileByPath = {};
  var renderedMap = {};     // path -> DOM 节点（虚拟滚动在用）
  var treeData = null;      // 目录树
  var curDir = '';          // 当前选中目录（'' = 全部）
  var curNode = null;       // 当前选中节点
  var excluded = {};        // 被排除的目录（绝对路径 -> true），持久化
  var viewMode = 'all';     // all | fav
  var playingPath = null;
  var curWs = null;
  var curAudio = null;
  var seeking = false;

  // ---------- 工具 ----------

  function $(id) { return document.getElementById(id); }

  function toast(msg, kind) {
    if (window.__vhToast) { window.__vhToast(msg, kind); return; }
    console.log('[sfx] ' + msg);
  }

  function status(msg, kind) {
    if (!el.status) return;
    el.status.textContent = msg || '';
    el.status.className = kind || '';
  }

  function fmtDur(sec) {
    var s = Math.max(0, Number(sec) || 0);
    var m = Math.floor(s / 60);
    var r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function baseName(p) {
    return String(p || '').split(/[\\/]/).pop();
  }

  // ---------- 排除目录 ----------
  var EXCL_KEY = 'vh_sfx_excluded_v1';

  function loadExcluded() {
    try {
      var a = JSON.parse(localStorage.getItem(EXCL_KEY) || '[]') || [];
      excluded = {};
      a.forEach(function (p) { excluded[normPath(p)] = true; });
    } catch (e) { excluded = {}; }
  }
  function saveExcluded() {
    try {
      localStorage.setItem(EXCL_KEY, JSON.stringify(Object.keys(excluded)));
    } catch (e) {}
  }
  /** 路径归一：统一分隔符 + 小写，便于比较 */
  function normPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
  /** 该路径是否位于某个被排除目录之下（含自身） */
  function isExcluded(p) {
    var n = normPath(p);
    var hit = false;
    Object.keys(excluded).forEach(function (ex) {
      if (hit) return;
      if (n === ex || n.indexOf(ex + '/') === 0) hit = true;
    });
    return hit;
  }
  function toggleExclude(p) {
    var n = normPath(p);
    if (!n) return false;
    if (excluded[n]) delete excluded[n];
    else excluded[n] = true;
    saveExcluded();
    return !!excluded[n];
  }
  function clearAllExcluded() {
    excluded = {};
    saveExcluded();
  }
  function updateExcludedBtn() {
    var k = Object.keys(excluded).length;
    var el2 = $('sfxExcludedCnt');
    if (el2) el2.textContent = k ? ('(' + k + ')') : '';
    var b = $('btnSfxExcluded');
    if (b) b.classList.toggle('on', k > 0);
  }

  function loadFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function saveFavs(o) {
    try { localStorage.setItem(FAV_KEY, JSON.stringify(o || {})); } catch (e) {}
  }
  function isFav(p) { return !!loadFavs()[p]; }
  function toggleFav(p) {
    var f = loadFavs();
    if (f[p]) delete f[p]; else f[p] = 1;
    saveFavs(f);
  }

  // ---------- 目录树 ----------

  /** 由文件列表构建树：{ name, path, depth, children[], files, parent, __open } */
  function buildTree(root, list) {
    var sep = root.indexOf('\\') >= 0 ? '\\' : '/';
    var rootNode = { name: baseName(root) || root, path: root, depth: 0,
                     children: [], files: 0, parent: null, __open: true, _map: {} };
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      // 跳过被排除目录下的文件
      if (isExcluded(f.path)) continue;
      var rel = String(f.path).substring(root.length).replace(/^[\\/]+/, '');
      var parts = rel.split(/[\\/]/);
      parts.pop();
      var node = rootNode;
      node.files++;
      for (var k = 0; k < parts.length; k++) {
        var nm = parts[k];
        if (!node._map[nm]) {
          var child = { name: nm, path: node.path + sep + nm, depth: node.depth + 1,
                        children: [], files: 0, parent: node, __open: false, _map: {} };
          node._map[nm] = child;
          node.children.push(child);
        }
        node = node._map[nm];
        node.files++;
      }
    }
    return rootNode;
  }

  /** 按绝对路径找节点 */
  function findNode(abs) {
    if (!treeData || !abs) return null;
    var target = String(abs).toLowerCase();
    var hit = null;
    (function walk(n) {
      if (hit) return;
      if (String(n.path).toLowerCase() === target) { hit = n; return; }
      n.children.forEach(walk);
    })(treeData);
    return hit;
  }

  /** 依据每个节点的 __open 决定显隐；caret 方向同步 */
  function collapseTree() {
    if (!el.tree || !treeData) return;
    var rows = Array.prototype.slice.call(el.tree.querySelectorAll('.tnode'));
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var n = r.__node;
      if (!n) continue;
      var show = true;
      var pp = n.parent;
      while (pp) { if (!pp.__open) { show = false; break; } pp = pp.parent; }
      r.style.display = show ? '' : 'none';
      var caret = r.querySelector('.caret');
      if (caret) {
        caret.textContent = n.children.length ? (n.__open ? '▾' : '▸') : '';
      }
      if (n === curNode) r.classList.add('sel'); else r.classList.remove('sel');
    }
  }

  function renderTree() {
    if (!el.tree) return;
    el.tree.innerHTML = '';
    if (!treeData) return;

    (function walk(n) {
      var row = document.createElement('div');
      row.className = 'tnode';
      row.style.paddingLeft = (6 + n.depth * 14) + 'px';
      var hasKids = n.children.length > 0;

      var caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = hasKids ? (n.__open ? '▾' : '▸') : '';

      var ico = document.createElement('span');
      ico.className = 'tico';
      // 树节点都是文件夹：有子目录用 📂，没有子目录也用 📁（不能因为没子目录就当成音频）
      ico.textContent = hasKids ? '📂' : '📁';

      var lbl = document.createElement('span');
      lbl.className = 'tlabel';
      lbl.textContent = n.depth === 0 ? (baseName(n.path) || '全部音效') : n.name;
      lbl.title = n.path;

      var cnt = document.createElement('span');
      cnt.className = 'tcnt';
      cnt.textContent = n.files > 0 ? String(n.files) : '';

      row.appendChild(caret); row.appendChild(ico); row.appendChild(lbl); row.appendChild(cnt);
      row.__node = n;

      // 右键：排除该目录 / 取消排除
      // 排除入口：右键 / Ctrl+点击 均可（部分环境右键被宿主拦截，故两条路都留）
      function openMenuAt(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        showTreeMenu(ev, n);
      }
      row.addEventListener('contextmenu', openMenuAt);
      row.addEventListener('mousedown', function (ev) {
        if (ev.button === 2 || ev.ctrlKey || ev.metaKey) openMenuAt(ev);
      });
      // 兜底：树行末尾加一个「⋯」按钮，点它一定弹菜单
      (function () {
        var more = document.createElement('span');
        more.className = 'tmore';
        more.textContent = '⋯';
        more.title = '更多（排除该目录）';
        more.style.cssText = 'flex:0 0 auto;padding:0 4px;color:var(--muted);cursor:pointer;';
        more.addEventListener('click', function (ev) {
          ev.stopPropagation();
          showTreeMenu(ev, n);
        });
        row.appendChild(more);
      })();
      row.addEventListener('click', function (ev) {
        ev.stopPropagation();
        // 点 caret 只折叠/展开，不改变选中
        if (ev.target && ev.target.classList && ev.target.classList.contains('caret')) {
          if (!hasKids) return;
          n.__open = !n.__open;
          collapseTree();
          return;
        }
        // 点整行：选中该目录（并自动展开它）
        curNode = n;
        curDir = n.depth === 0 ? '' : n.path;
        if (hasKids && !n.__open) n.__open = true;
        collapseTree();
        applyView();
      });

      el.tree.appendChild(row);
      n.children.forEach(walk);
    })(treeData);

    collapseTree();
  }

  /** 目录树的行右键菜单 */
  function showTreeMenu(ev, n) {
    closeMenu();
    // ⋯ 按钮触发时没有 clientX/Y，用元素位置兜底
    if (ev && (ev.clientX === undefined || ev.clientX === 0) && ev.target && ev.target.getBoundingClientRect) {
      try {
        var _r = ev.target.getBoundingClientRect();
        ev = { clientX: Math.round(_r.left), clientY: Math.round(_r.bottom), preventDefault: function () {}, stopPropagation: function () {} };
      } catch (e) { /* 忽略 */ }
    }
    var isRoot = n.depth === 0;
    var cur = normPath(n.path);
    var already = !!excluded[cur];
    var menu = mkMenu([
      [isRoot ? '（根目录不可排除）' : (already ? '✅ 取消排除该目录' : '🚫 排除该目录'), function () {
        if (isRoot) return;
        var now = toggleExclude(n.path);
        rebuildAfterExclude();
        status(now ? ('已排除：' + n.name) : ('已恢复：' + n.name), now ? 'warn' : 'ok');
      }, isRoot],
      ['——', null],
      ['查看已排除（' + Object.keys(excluded).length + '）', function () {
        showExcludedPanel();
      }],
      ['清空全部排除', function () {
        if (!Object.keys(excluded).length) { status('没有已排除的目录', 'warn'); return; }
        clearAllExcluded();
        rebuildAfterExclude();
        status('已清空全部排除', 'ok');
      }]
    ], ev);
  }

  /**
   * 通用小菜单构造。
   * 改为接回调用方直接展示（不再 append 进隐藏容器），从根上杜绝「菜单不可见」。
   * 传入 items 为 [label, onClick, disabled] 的数组（兼容旧调用形式）。
   */
  function mkMenu(items, ev) {
    var list = (items || []).map(function (it) {
      if (it[0] === '——') return { sep: true };
      return { label: it[0], onClick: it[1], disabled: it[2] === true || !it[1] };
    });
    if (window.vhMenu) {
      window.vhMenu.show(ev, list);
      return null;
    }
    // 兜底：vhMenu 未加载时自己造一个挂 body 的浮层
    var menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;left:' + (ev && ev.clientX || 0) + 'px;top:'
      + (ev && ev.clientY || 0) + 'px;z-index:99999;background:#262626;border:1px solid #4a4a4a;'
      + 'border-radius:7px;padding:4px;font-size:12px;min-width:170px;color:#ddd;';
    list.forEach(function (it) {
      if (it.sep) {
        var hr = document.createElement('div');
        hr.style.cssText = 'height:1px;background:#3d3d3d;margin:4px 6px;';
        menu.appendChild(hr); return;
      }
      var b = document.createElement('div');
      b.textContent = it.label;
      b.style.cssText = 'padding:6px 10px;border-radius:4px;cursor:'
        + (it.disabled ? 'default;opacity:.45;' : 'pointer;');
      if (!it.disabled) {
        b.addEventListener('click', function () { closeMenu(); it.onClick(); });
      }
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    return menu;
  }

  /** 某个目录被排除/恢复后：重建树 + 刷新视图 */
  function rebuildAfterExclude() {
    if (!files.length) { updateExcludedBtn(); return; }
    var root = (el.dir && el.dir.value || '').trim();
    treeData = root ? buildTree(root, files) : null;
    curNode = treeData;
    if (curDir && isExcluded(curDir)) curDir = '';
    renderTree();
    applyView();
    updateExcludedBtn();
  }

  /** 「已排除」管理面板：列出全部排除项，可逐个恢复 */
  function showExcludedPanel() {
    var keys = Object.keys(excluded);
    var wrap = document.createElement('div');

    if (!keys.length) {
      var e = document.createElement('div');
      e.className = 'mini';
      e.textContent = '暂无。在左侧目录上右键 →「排除该目录」即可。';
      wrap.appendChild(e);
    } else {
      keys.forEach(function (k) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 6px;'
          + 'border-bottom:1px solid var(--border);font-size:11.5px;';
        var sp = document.createElement('span');
        sp.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        sp.textContent = k;
        sp.title = k;
        var btn = document.createElement('button');
        btn.className = 'tbtn';
        btn.style.cssText = 'padding:2px 8px;font-size:11px;';
        btn.textContent = '恢复';
        btn.addEventListener('click', function () {
          toggleExclude(k);
          rebuildAfterExclude();
          closeMenu();
          showExcludedPanel();
        });
        row.appendChild(sp); row.appendChild(btn);
        wrap.appendChild(row);
      });
    }
    if (window.vhMenu) {
      window.vhMenu.panel('已排除的目录（' + keys.length + '）', wrap, [
        { label: '全部恢复', onClick: function () {
            clearAllExcluded(); rebuildAfterExclude(); showExcludedPanel();
          }, keepOpen: false }
      ]);
    } else {
      document.body.appendChild(wrap);
    }
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escAttr(s) { return escHtml(s).replace(/'/g, '&#39;'); }


  /** 波形未就绪时，等它就绪再按比例播放 */
  function ensureReadyWhenReady(item, f, ratio) {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (item.__wsReady && item.__ws) {
        clearInterval(timer);
        var d = 0;
        try { d = item.__ws.getDuration() || 0; } catch (e) { d = 0; }
        if (!d) { try { d = f.durationSec || 0; } catch (e) { d = 0; } }
        if (!d) { var pend = ratio; playFrom(f, 0);
          setTimeout(function () {
            if (curAudio && isFinite(curAudio.duration) && curAudio.duration > 0) {
              try { curAudio.currentTime = pend * curAudio.duration; } catch (e) {}
            }
          }, 350);
          return; }
        try { item.__ws.seekTo(ratio); } catch (e) {}
        playFrom(f, ratio * d);
        return;
      }
      if (tries > 150) { clearInterval(timer); status('波形加载超时', 'err'); }
    }, 80);
  }


  /** 读音频成 Blob URL（播放用；比 data URL 可靠，长度不受限） */
  function readPlayableUrl(filePath) {
    if (window.vhHost.readAudioBuffer) {
      return window.vhHost.readAudioBuffer(filePath).then(function (r) {
        var d = r && r.data ? r.data : r;
        var raw = d && d.bytes;
        if (!raw) throw new Error('无音频数据');
        var u8;
        if (raw instanceof Uint8Array) u8 = raw;
        else if (raw.type === 'Buffer' && Array.isArray(raw.data)) u8 = new Uint8Array(raw.data);
        else if (Array.isArray(raw)) u8 = new Uint8Array(raw);
        else if (raw.data) u8 = new Uint8Array(raw.data);
        else throw new Error('未知二进制格式');
        var blob = new Blob([u8], { type: guessMime(filePath) });
        return URL.createObjectURL(blob);
      });
    }
    // 退路：data URL
    return window.vhHost.readAudioDataUrl(filePath).then(function (r) {
      var d = r && r.data ? r.data : r;
      if (!d || !d.dataUrl) throw new Error('无法读取音频');
      return d.dataUrl;
    });
  }

  /** 依扩展名猜 MIME */
  function guessMime(p) {
    var m = String(p).toLowerCase().match(/\.([a-z0-9]+)$/);
    var e = m ? m[1] : '';
    return ({ mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
              flac: 'audio/flac', ogg: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff',
              wma: 'audio/x-ms-wma' })[e] || 'audio/mpeg';
  }

  /** 读音频二进制并转成 ArrayBuffer，供 WaveSurfer 解码 */
  function loadWaveBytes(filePath, cb) {
    if (!window.vhHost || !window.vhHost.readAudioBuffer) {
      cb(new Error('读取接口不可用')); return;
    }
    window.vhHost.readAudioBuffer(filePath).then(function (r) {
      var d = r && r.data ? r.data : r;
      var raw = d && d.bytes;
      if (!raw) { cb(new Error('无数据')); return; }
      try {
        // IPC 传回的可能是 Buffer 序列化后的 {type:'Buffer',data:[...]} 或 Uint8Array
        var u8;
        if (raw instanceof Uint8Array) u8 = raw;
        else if (raw.type === 'Buffer' && Array.isArray(raw.data)) u8 = new Uint8Array(raw.data);
        else if (Array.isArray(raw)) u8 = new Uint8Array(raw);
        else if (typeof raw === 'object' && raw.data) u8 = new Uint8Array(raw.data);
        else { cb(new Error('未知二进制格式')); return; }
        cb(null, u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
      } catch (e) { cb(e); }
    }).catch(function (e) { cb(e); });
  }


  // ---------- 视图过滤 ----------

  function applyView() {
    var kw = (el.search && el.search.value || '').trim().toLowerCase();
    var favs = loadFavs();
    visibleFiles = files.filter(function (f) {
      if (isExcluded(f.path)) return false;          // 排除目录下的文件不显示
      if (viewMode === 'fav' && !favs[f.path]) return false;
      // 有搜索词时全局搜（不限于当前选中目录），与 PR 一致
      if (kw) {
        var base = String(f.name).replace(/\.[^.]+$/, '').toLowerCase();
        if (base.indexOf(kw) >= 0) return true;
        return String(f.path).toLowerCase().indexOf(kw) >= 0;
      }
      if (curDir) {
        var d = String(f.path).toLowerCase();
        var c = String(curDir).toLowerCase();
        if (d.indexOf(c) !== 0) return false;
      }
      return true;
    });
    if (el.count) {
      el.count.textContent = visibleFiles.length === files.length
        ? (files.length + ' 个音效')
        : (visibleFiles.length + ' / ' + files.length + ' 个');
    }
    unmountAll();
    if (el.empty) el.empty.style.display = visibleFiles.length ? 'none' : '';
    renderList();
  }

  // ---------- 虚拟滚动列表 ----------

  function renderList() {
    if (!el.list || !el.spacer) return;
    el.spacer.style.height = (visibleFiles.length * ITEM_H) + 'px';
    var st = el.list.scrollTop;
    var viewH = el.list.clientHeight || 400;
    var start = Math.max(0, Math.floor(st / ITEM_H) - WINDOW_PAD);
    var end = Math.min(visibleFiles.length, Math.ceil((st + viewH) / ITEM_H) + WINDOW_PAD);

    var keep = {};
    for (var i = start; i < end; i++) {
      var f = visibleFiles[i];
      keep[f.path] = true;
      if (!renderedMap[f.path]) {
        var node = buildItem(f);
        node.style.top = (i * ITEM_H) + 'px';
        el.list.appendChild(node);
        renderedMap[f.path] = node;
      } else {
        renderedMap[f.path].style.top = (i * ITEM_H) + 'px';
      }
    }
    // 回收离开视口的行（正在播放的留住，避免中断）
    Object.keys(renderedMap).forEach(function (p) {
      if (!keep[p]) unmountItem(p);
    });
    // 给当前可见行建波形（惰性，不影响滚动性能）
    requestAnimationFrame(function () {
      Object.keys(keep).forEach(function (p) {
        if (renderedMap[p]) ensureWave(renderedMap[p]);
      });
    });
  }

  function unmountItem(p) {
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
    item.dataset.path = f.path;
    item.draggable = true;

    var nm = document.createElement('button');
    nm.className = 'nm';
    nm.textContent = f.name;
    nm.title = '点击导入素材池「音效库」；拖拽可送到时间线';
    nm.addEventListener('click', function (ev) {
      ev.stopPropagation();
      importToPool(f);
    });

    var playBtn = document.createElement('button');
    playBtn.className = 'playbtn';
    playBtn.textContent = '▶';
    playBtn.title = '播放 / 暂停';
    playBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (playingPath === f.path && isPlaying()) pausePlayback();
      else playFrom(f, 0);
    });

    var waveEl = document.createElement('div');
    waveEl.className = 'wave';

    var dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = f.durationSec ? fmtDur(f.durationSec) : '';

    var ext = document.createElement('span');
    ext.className = 'ext';
    ext.textContent = String(f.ext || '').toUpperCase();

    var star = document.createElement('span');
    star.className = 'star' + (isFav(f.path) ? ' on' : '');
    star.textContent = isFav(f.path) ? '★' : '☆';
    star.title = '收藏 / 取消收藏';
    star.addEventListener('click', function (ev) {
      ev.stopPropagation();
      toggleFav(f.path);
      star.className = 'star' + (isFav(f.path) ? ' on' : '');
      star.textContent = isFav(f.path) ? '★' : '☆';
      if (viewMode === 'fav' && !isFav(f.path)) applyView();
    });

    item.appendChild(nm);
    item.appendChild(playBtn);
    item.appendChild(waveEl);
    item.appendChild(dur);
    item.appendChild(ext);
    item.appendChild(star);

    // 拖拽：交给主进程走 Electron 原生拖出
    item.addEventListener('dragstart', function (ev) {
      var t = ev.target;
      if (t.closest && (t.closest('.wave') || t.closest('.playbtn') || t.closest('.star'))) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      if (window.vhHost && window.vhHost.startDrag) {
        window.vhHost.startDrag(f.path);
        status('正在拖出：' + f.name, '');
      } else {
        toast('当前环境不支持拖拽，请用「点击名称」导入', 'err');
      }
    });
    item.addEventListener('dragend', function () { stopPlayback(); });

    item.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      showContextMenu(ev, f);
    });

    return item;
  }

  // ---------- 波形（惰性加载） ----------

  function ensureWave(item) {
    if (item.__waveDone) return;
    item.__waveDone = true;
    var f = fileByPath[item.dataset.path];
    if (!f) return;
    if (item.__ws) return;
    var waveEl = item.querySelector('.wave');
    if (typeof WaveSurfer === 'undefined') {
      waveEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">波形不可用</span>';
      return;
    }
    var ws;
    try {
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
        interact: false,
        hideScrollbar: true
      });
    } catch (e) {
      waveEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">波形不可用</span>';
      return;
    }
    item.__ws = ws;
    ws.on('ready', function () {
      item.__wsReady = true;
      try {
        var d = ws.getDuration();
        var dEl = item.querySelector('.dur');
        if (dEl && d) {
          dEl.textContent = fmtDur(d);
          f.durationSec = d;
        }
      } catch (e) {}
      // 恢复对应的播放进度
      try {
        if (playingPath === f.path && curAudio && curAudio.currentTime > 0) {
          var dur = ws.getDuration() || 1;
          ws.seekTo(Math.min(0.999, curAudio.currentTime / dur));
        }
      } catch (e) {}
    });
    ws.on('error', function () {
      waveEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">波形读取失败</span>';
    });

    // 点波形 → 从指针位置播放（与 PR 手感一致）
    waveEl.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var rect = waveEl.getBoundingClientRect();
      if (!rect.width) return;
      var ratio = (ev.clientX - rect.left) / rect.width;
      if (ratio < 0) ratio = 0;
      if (ratio > 1) ratio = 1;
      if (item.__wsReady && item.__ws) {
        // 时长可能因解码时机返回 0，用多个来源兜底
        var d = 0;
        try { d = item.__ws.getDuration() || 0; } catch (e) { d = 0; }
        if (!d) { try { d = f.durationSec || 0; } catch (e) { d = 0; } }
        if (!d && curAudio && isFinite(curAudio.duration)) d = curAudio.duration;
        if (!d) {
          // 实在拿不到时长：先播，等 ready 后按比例定位
          item.__pendingRatio = ratio;
          playFrom(f, 0);
          ensureReadyWhenReady(item, f, ratio);
          return;
        }
        try { item.__ws.seekTo(ratio); } catch (e) {}
        playFrom(f, ratio * d);
      } else {
        // 还没解码完：先按比例记下，待 ready 后播放
        item.__pendingRatio = ratio;
        ensureReadyWhenReady(item, f, ratio);
      }
    });
    // 用二进制喂波形（loadArrayBuffer）：不走网络、不外传，比 data URL 稳
    loadWaveBytes(f.path, function (err, buf) {
      if (err) {
        waveEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">波形读取失败</span>';
        return;
      }
      try { ws.loadArrayBuffer(buf); } catch (e) {
        waveEl.innerHTML = '<span style="font-size:10px;color:var(--muted);">波形读取失败</span>';
      }
    });
  }

  // ---------- 播放 ----------


  /** 实时取播放/暂停图标（不用缓存，避免面板重开后引用失效） */
  function playIco() { var b = $('btnSfxPlay'); return b ? b.querySelector('.ic-play') : null; }
  function pauseIco() { var b = $('btnSfxPlay'); return b ? b.querySelector('.ic-pause') : null; }
  function setIco(playing) {
    var a = playIco(), b = pauseIco();
    if (a) a.style.display = playing ? 'none' : '';
    if (b) b.style.display = playing ? '' : 'none';
  }

  function isPlaying() {
    return !!(curAudio && !curAudio.paused);
  }

  function playFrom(f, startSec) {
    stopPlayback();
    if (!window.vhHost) { toast('宿主接口不可用', 'err'); return; }
    status('加载中：' + f.name, '');

    // 播放用真实二进制 → Blob URL。
    // 不用 data URL：wav 的 base64 会让 data URL 变得极长，Chromium 会拒绝播放。
    readPlayableUrl(f.path).then(function (url) {
      if (!url) throw new Error('无法读取音频');
      curAudio = new Audio(url);
      curAudio.__url = url;
      curAudio.volume = parseFloat(el.vol ? el.vol.value : 0.8) || 0.8;
      curAudio.addEventListener('timeupdate', onTimeUpdate);
      curAudio.addEventListener('ended', function () { stopPlayback(); });
      // 起点定位：必须在元数据就绪后设置，否则会被忽略（从头播放）
      var _startSec = Number(startSec) || 0;
      curAudio.addEventListener('loadedmetadata', function () {
        if (el.dur) el.dur.textContent = fmtDur(curAudio.duration);
        if (_startSec > 0) {
          try {
            var dur0 = curAudio.duration || 0;
            curAudio.currentTime = dur0 > 0 ? Math.min(_startSec, Math.max(0, dur0 - 0.05)) : _startSec;
          } catch (e) { /* 忽略 */ }
        }
      });
      // 若元数据已就绪（缓存命中时可能同步完成），直接设
      if (curAudio.readyState >= 1 && _startSec > 0) {
        try { curAudio.currentTime = _startSec; } catch (e) { /* 忽略 */ }
      }
      return curAudio.play().then(function () {
        return curAudio;
      }).catch(function (err) {
        // 播放被拒（常见于无用户手势）：明确告知，而不是静默失败
        var name = err && err.name || '';
        if (name === 'NotAllowedError') {
          throw new Error('浏览器拦截了自动播放，请再点一次播放按钮');
        }
        throw new Error('播放失败：' + (err && err.message || name || '未知'));
      });
    }).then(function (au) {
      if (au && au.paused) {
        // 没真正播起来：保持图标为"播放"，让用户知道要点第二次
        status('已就绪，请再点一次播放', 'warn');
        setIco(false);
        if (el.player) el.player.style.display = '';
        if (el.title) el.title.textContent = f.name;
        if (el.sub) el.sub.textContent = f.path;
        playingPath = f.path;
        var node0 = renderedMap[f.path];
        if (node0) ensureWave(node0);
        return;
      }
      playingPath = f.path;
      if (el.player) el.player.style.display = '';
      if (el.title) el.title.textContent = f.name;
      if (el.sub) el.sub.textContent = f.path;
      setIco(true);
      markPlaying(f.path);
      status('播放中：' + f.name, 'ok');
      // 让对应行建波形
      var node = renderedMap[f.path];
      if (node) ensureWave(node);
    }).catch(function (e) {
      toast('播放失败：' + (e && e.message || e), 'err');
      status('播放失败', 'err');
      stopPlayback();
    });
  }

  function pausePlayback() {
    if (curAudio) curAudio.pause();
    setIco(false);
    status('已暂停', '');
  }

  function resumePlayback() {
    if (!curAudio) {
      // 音频对象丢了（切过页/被回收）：用当前记录重新播
      if (playingPath && fileByPath[playingPath]) { playFrom(fileByPath[playingPath], 0); return; }
      if (visibleFiles[0]) { playFrom(visibleFiles[0], 0); return; }
      return;
    }
    if (curAudio) {
      curAudio.play();
      setIco(true);
      status('播放中', 'ok');
    }
  }

  function stopPlayback() {
    if (curAudio) {
      try { curAudio.pause(); } catch (e) {}
      try { if (curAudio.__url && curAudio.__url.indexOf('blob:') === 0) URL.revokeObjectURL(curAudio.__url); } catch (e) {}
      curAudio = null;
    }
    playingPath = null;
    setIco(false);
    if (el.cur) el.cur.textContent = '0:00';
    if (el.seekFill) el.seekFill.style.width = '0%';
    markPlaying(null);
  }

  function markPlaying(p) {
    Object.keys(renderedMap).forEach(function (k) {
      var n = renderedMap[k];
      if (!n) return;
      if (k === p) n.classList.add('playing');
      else n.classList.remove('playing');
    });
    // 同步波形进度
    Object.keys(renderedMap).forEach(function (k) {
      var n = renderedMap[k];
      if (!n || !n.__ws) return;
      try {
        if (k === p) return;   // 正在播放的另处理
        n.__ws.seekTo(0);
      } catch (e) {}
    });
  }

  function onTimeUpdate() {
    if (!curAudio || seeking) return;
    var d = curAudio.duration || 0;
    var c = curAudio.currentTime || 0;
    if (el.cur) el.cur.textContent = fmtDur(c);
    if (el.dur && d) el.dur.textContent = fmtDur(d);
    if (el.seekFill && d) el.seekFill.style.width = ((c / d) * 100).toFixed(2) + '%';
    // 同步播放行的波形游标
    var node = playingPath ? renderedMap[playingPath] : null;
    if (node && node.__ws && node.__wsReady && d) {
      try { node.__ws.seekTo(Math.min(0.999, c / d)); } catch (e) {}
    }
  }

  function playPrev() {
    if (!visibleFiles.length) return;
    var i = visibleFiles.findIndex(function (f) { return f.path === playingPath; });
    var n = i > 0 ? i - 1 : visibleFiles.length - 1;
    playFrom(visibleFiles[n], 0);
  }
  function playNext() {
    if (!visibleFiles.length) return;
    var i = visibleFiles.findIndex(function (f) { return f.path === playingPath; });
    var n = (i >= 0 && i < visibleFiles.length - 1) ? i + 1 : 0;
    playFrom(visibleFiles[n], 0);
  }

  // ---------- 导入 / 插入 ----------

  function importToPool(f) {
    if (!window.vhHost || !window.vhHost.importFilesToPool) return;
    status('导入中：' + f.name, '');
    window.vhHost.importFilesToPool([f.path], '音效库').then(function (r) {
      var d = r && r.data ? r.data : r;
      status('已导入素材池：' + (d && d.names ? d.names.join(', ') : f.name), 'ok');
      toast('已导入：' + f.name, 'ok');
    }).catch(function (e) {
      status('导入失败：' + (e && e.message || e), 'err');
    });
  }

  // ---------- 右键菜单 ----------

  function showContextMenu(ev, f) {
    closeMenu();
    var items = [
      ['▶ 播放', function () { playFrom(f, 0); }],
      ['导入素材池', function () { importToPool(f); }],
      ['插入播放头', function () { insertToTimeline(f); }],
      ['在资源管理器定位', function () {
        if (window.vhHost && window.vhHost.revealFile) window.vhHost.revealFile(f.path);
      }],
      ['——', null],
      [(isFav(f.path) ? '☆ 取消收藏' : '★ 收藏'), function () { toggleFav(f.path); applyView(); }]
    ];
    if (window.vhMenu) {
      window.vhMenu.show(ev, items.map(function (it) {
        if (it[0] === '——') return { sep: true };
        return { label: it[0], onClick: it[1] };
      }));
      return;
    }
    mkMenu(items, ev);
  }
  function closeMenu() {
    if (window.vhMenu) { window.vhMenu.close(); return; }
    var box = $('sfxContextMenu');
    if (box) box.innerHTML = '';
  }

  function insertToTimeline(f) {
    if (!window.vhHost) return;
    status('插入中：' + f.name, '');
    window.vhHost.getPlayhead('').then(function (r) {
      var ph = r && r.data ? r.data : r;
      return window.vhHost.insertAudioToTimeline({
        path: f.path,
        recordFrame: ph && ph.frames !== null ? ph.frames : undefined,
        folderName: '音效库'
      }).then(function (res) {
        var d = res && res.data ? res.data : res;
        status('已插入时间线（' + (ph && ph.timecode || '') + '）', 'ok');
        toast('已插入：' + f.name, 'ok');
      });
    }).catch(function (e) {
      status('插入失败：' + (e && e.message || e), 'err');
    });
  }

  // ---------- 扫描 ----------

  function scan() {
    var dir = (el.dir && el.dir.value || '').trim();
    if (!dir) { toast('请先选择音效目录', 'err'); return; }
    status('扫描中…', '');
    if (el.empty) el.empty.style.display = 'none';
    window.vhHost.listDir(dir, true, 'audio').then(function (r) {
      var d = r && r.data ? r.data : r;
      files = (d.files || []).map(function (x) {
        return { name: x.name, path: x.path, sizeBytes: x.sizeBytes, ext: x.ext, kind: 'sfx' };
      });
      // 不加排序：保持文件系统顺序（与 PR 版一致）
      fileByPath = {};
      files.forEach(function (f) { fileByPath[f.path] = f; });
      treeData = files.length ? buildTree(dir, files) : null;
      curDir = '';
      curNode = treeData;
      try { localStorage.setItem(ROOT_KEY, dir); } catch (e) {}
      renderTree();
      applyView();
      updateExcludedBtn();
      status('已扫描 ' + files.length + ' 个音效', 'ok');
      toast('扫描到 ' + files.length + ' 个音效', 'ok');
    }).catch(function (e) {
      status('扫描失败：' + (e && e.message || e), 'err');
      toast('扫描失败：' + (e && e.message || e), 'err');
    });
  }

  function browse() {
    var start = (el.dir && el.dir.value || '').trim();
    window.vhHost.pickFolder(start, '选择音效库根目录').then(function (r) {
      var dir = r && r.data ? r.data : r;
      if (!dir) return;
      el.dir.value = dir;
      scan();
    }).catch(function (e) {
      toast('选择目录失败：' + (e && e.message || e), 'err');
    });
  }

  // ---------- 初始化 ----------

  function init() {
    el = {
      dir: $('sfxDir'), search: $('sfxSearch'), count: $('sfxCount'),
      tree: $('sfxTree'), list: $('sfxList'), spacer: $('sfxSpacer'),
      excludedBtn: $('btnSfxExcluded'),
      empty: $('sfxEmpty'), status: $('sfxStatus'),
      player: $('sfxPlayerBar'), title: $('sfxPlayerTitle'), sub: $('sfxPlayerSub'),
      playIco: null, pauseIco: null, cur: $('sfxCur'), dur: $('sfxDur'),
      seek: $('sfxSeek'), seekFill: $('sfxSeekFill'), vol: $('sfxVol')
    };
    if (!el.list) return;

    var playBtn = $('btnSfxPlay');
    if (playBtn) {
      el.playIco = playBtn.querySelector('.ic-play');
      el.pauseIco = playBtn.querySelector('.ic-pause');
    }

    // 事件
    $('btnSfxBrowse').addEventListener('click', browse);
    $('btnSfxScan').addEventListener('click', scan);
    var exBtn = $('btnSfxExcluded');
    if (exBtn) exBtn.addEventListener('click', function (ev) { ev.stopPropagation(); showExcludedPanel(); });
    if (el.search) el.search.addEventListener('input', applyView);
    $('btnSfxAll').addEventListener('click', function () {
      viewMode = 'all';
      $('btnSfxAll').classList.add('on');
      $('btnSfxFav').classList.remove('on');
      applyView();
    });
    $('btnSfxFav').addEventListener('click', function () {
      viewMode = 'fav';
      $('btnSfxFav').classList.add('on');
      $('btnSfxAll').classList.remove('on');
      applyView();
    });

    el.list.addEventListener('scroll', function () {
      renderList();
      // 滚动时给可见行补波形
      Object.keys(renderedMap).forEach(function (p) { ensureWave(renderedMap[p]); });
    }, { passive: true });

    // 播放条
    if (playBtn) {
      playBtn.addEventListener('click', function () {
        // 无当前曲：播列表第一首
        if (!playingPath) {
          if (visibleFiles[0]) playFrom(visibleFiles[0], 0);
          else toast('列表为空，先扫描目录', 'warn');
          return;
        }
        // 有当前曲：真正判断音频对象状态（不要依赖缓存的 playingPath）
        var playing = !!(curAudio && !curAudio.paused);
        if (playing) pausePlayback(); else resumePlayback();
      });
    }
    var prev = $('btnSfxPrev'); if (prev) prev.addEventListener('click', playPrev);
    var next = $('btnSfxNext'); if (next) next.addEventListener('click', playNext);
    var volBtn = $('btnSfxVol');
    if (volBtn) {
      volBtn.addEventListener('click', function () {
        var on = volBtn.querySelector('.ic-vol-on'), off = volBtn.querySelector('.ic-vol-off');
        var muted = on && on.style.display === 'none';
        if (on) on.style.display = muted ? '' : 'none';
        if (off) off.style.display = muted ? 'none' : '';
        if (curAudio) curAudio.muted = !muted;
      });
    }
    if (el.vol) {
      el.vol.addEventListener('input', function () {
        if (curAudio) curAudio.volume = parseFloat(el.vol.value);
      });
    }
    if (el.seek) {
      var doSeek = function (ev) {
        if (!curAudio) return;
        var r = el.seek.getBoundingClientRect();
        var p = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        try { curAudio.currentTime = p * (curAudio.duration || 0); } catch (e) {}
      };
      el.seek.addEventListener('mousedown', function (ev) {
        seeking = true;
        doSeek(ev);
      });
      el.seek.addEventListener('mousemove', function (ev) { if (seeking) doSeek(ev); });
      window.addEventListener('mouseup', function () {
        if (!seeking) return;
        seeking = false;
        var d = curAudio && curAudio.duration || 0;
        var c = curAudio && curAudio.currentTime || 0;
        if (el.seekFill && d) el.seekFill.style.width = ((c / d) * 100).toFixed(2) + '%';
      });
    }

    loadExcluded();

    // 恢复上次目录并自动扫描（免得每次进来都要手动扫）
    var saved = null;
    try { saved = localStorage.getItem(ROOT_KEY); } catch (e) {}
    if (saved && el.dir) {
      el.dir.value = saved;
      setTimeout(function () {
        try { scan(); } catch (e) { /* 忽略 */ }
      }, 120);
    }

    window.addEventListener('resize', renderList);
  }

  window.__sfxPanel = {
    init: function () {
      init();
      // 无数据时明确显示空状态，避免看起来像"坏了"
      if (!files.length && el.empty) el.empty.style.display = '';
    },
    scan: scan,
    get hasData() { return files.length > 0; }
  };
})();
