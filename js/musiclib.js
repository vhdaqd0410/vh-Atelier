/**
 * vh-Atelier · DaVinci Resolve 版 · 音乐库
 *
 * 与音效库同一套布局骨架（工具栏 + 左树右列表 + 底部播放条），
 * 差异：多一个排序下拉（创建时间/名称/修改时间/大小/类型）与升降序切换；
 * 列表项高度 56（与 CSS .mllib-item 一致），波形占比更大。
 */
(function () {
  'use strict';

  var ITEM_H = 56;
  var WINDOW_PAD = 6;
  var ROOT_KEY = 'pr_me_mllibroot_v1';

  var el = {};
  var files = [];
  var visibleFiles = [];
  var fileByPath = {};
  var renderedMap = {};
  var treeData = null;
  var curDir = '';
  var curNode = null;
  var excluded = {};        // 被排除的目录（持久化）
  var playingPath = null;
  var curAudio = null;
  var seeking = false;
  var sortKey = 'ctime';     // 与 PR 一致：默认按创建时间
  var sortAsc = false;       // 默认降序（新 → 旧）

  function $(id) { return document.getElementById(id); }
  function toast(m, k) { if (window.__vhToast) window.__vhToast(m, k); else console.log('[mllib] ' + m); }
  function status(m, k) {
    if (!el.status) return;
    el.status.textContent = m || '';
    el.status.className = k || '';
  }
  function fmtDur(sec) {
    var s = Math.max(0, Number(sec) || 0);
    var m = Math.floor(s / 60);
    var r = Math.floor(s % 60);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
  // ---------- 排除目录 ----------
  var EXCL_KEY = 'vh_mllib_excluded_v1';
  function loadExcluded() {
    try {
      var a = JSON.parse(localStorage.getItem(EXCL_KEY) || '[]') || [];
      excluded = {};
      a.forEach(function (p) { excluded[normPath(p)] = true; });
    } catch (e) { excluded = {}; }
  }
  function saveExcluded() {
    try { localStorage.setItem(EXCL_KEY, JSON.stringify(Object.keys(excluded))); } catch (e) {}
  }
  function normPath(p) {
    return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
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
    if (excluded[n]) delete excluded[n]; else excluded[n] = true;
    saveExcluded();
    return !!excluded[n];
  }
  function clearAllExcluded() { excluded = {}; saveExcluded(); }
  function updateExcludedBtn() {
    var k = Object.keys(excluded).length;
    var c = $('mllibExcludedCnt');
    if (c) c.textContent = k ? ('(' + k + ')') : '';
    var b = $('btnMllibExcluded');
    if (b) b.classList.toggle('on', k > 0);
  }

  /** 通用小菜单 */
  /**
   * 通用小菜单构造。
   * 改为直接交给 vhMenu 展示（挂 body 的独立浮层），不再 append 进隐藏容器
   * —— 旧实现 append 进的 #mllibContextMenu 是 display:none，菜单永远看不见。
   */
  function mkMenu(items, ev) {
    var list = (items || []).map(function (it) {
      if (it[0] === '——') return { sep: true };
      return { label: it[0], onClick: it[1], disabled: it[2] === true || !it[1] };
    });
    if (window.vhMenu) { window.vhMenu.show(ev, list); return null; }
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
      if (!it.disabled) b.addEventListener('click', function () { closeMenu(); it.onClick(); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    return menu;
  }

  function showTreeMenu(ev, n) {
    closeMenu();
    if (ev && (ev.clientX === undefined || ev.clientX === 0) && ev.target && ev.target.getBoundingClientRect) {
      try {
        var _r = ev.target.getBoundingClientRect();
        ev = { clientX: Math.round(_r.left), clientY: Math.round(_r.bottom), preventDefault: function () {}, stopPropagation: function () {} };
      } catch (e) { /* 忽略 */ }
    }
    var isRoot = n.depth === 0;
    var already = !!excluded[normPath(n.path)];
    mkMenu([
      [isRoot ? '（根目录不可排除）' : (already ? '✅ 取消排除该目录' : '🚫 排除该目录'), function () {
        if (isRoot) return;
        var now = toggleExclude(n.path);
        rebuildAfterExclude();
        status(now ? ('已排除：' + n.name) : ('已恢复：' + n.name), now ? 'warn' : 'ok');
      }, isRoot],
      ['——', null],
      ['查看已排除（' + Object.keys(excluded).length + '）', function () { showExcludedPanel(); }],
      ['清空全部排除', function () {
        if (!Object.keys(excluded).length) { status('没有已排除的目录', 'warn'); return; }
        clearAllExcluded(); rebuildAfterExclude(); status('已清空全部排除', 'ok');
      }]
    ], ev);
  }

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
        sp.textContent = k; sp.title = k;
        var btn = document.createElement('button');
        btn.className = 'tbtn';
        btn.style.cssText = 'padding:2px 8px;font-size:11px;';
        btn.textContent = '恢复';
        btn.addEventListener('click', function () {
          toggleExclude(k); rebuildAfterExclude(); showExcludedPanel();
        });
        row.appendChild(sp); row.appendChild(btn);
        wrap.appendChild(row);
      });
    }
    if (window.vhMenu) {
      window.vhMenu.panel('已排除的目录（' + keys.length + '）', wrap, [
        { label: '全部恢复', onClick: function () {
            clearAllExcluded(); rebuildAfterExclude(); showExcludedPanel();
          } }
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


  // ---------- 目录树 ----------

  function buildTree(root, list) {
    var sep = root.indexOf('\\') >= 0 ? '\\' : '/';
    var rootNode = { name: baseName(root) || root, path: root, depth: 0,
                     children: [], files: 0, parent: null, __open: true, _map: {} };
    list.forEach(function (f) {
      if (isExcluded(f.path)) return;   // 跳过被排除目录下的文件
      var rel = String(f.path).substring(root.length).replace(/^[\\/]+/, '');
      var parts = rel.split(/[\\/]/);
      parts.pop();
      var node = rootNode;
      node.files++;
      parts.forEach(function (nm) {
        if (!node._map[nm]) {
          var c = { name: nm, path: node.path + sep + nm, depth: node.depth + 1,
                    children: [], files: 0, parent: node, __open: false, _map: {} };
          node._map[nm] = c;
          node.children.push(c);
        }
        node = node._map[nm];
        node.files++;
      });
    });
    return rootNode;
  }

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

  function collapseTree() {
    if (!el.tree || !treeData) return;
    var rows = Array.prototype.slice.call(el.tree.querySelectorAll('.tnode'));
    rows.forEach(function (r) {
      var n = r.__node;
      if (!n) return;
      var show = true;
      var pp = n.parent;
      while (pp) { if (!pp.__open) { show = false; break; } pp = pp.parent; }
      r.style.display = show ? '' : 'none';
      var caret = r.querySelector('.caret');
      if (caret) caret.textContent = n.children.length ? (n.__open ? '▾' : '▸') : '';
      if (n === curNode) r.classList.add('sel'); else r.classList.remove('sel');
    });
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
      // 树节点都是文件夹，不因无子目录就显示成音频图标
      ico.textContent = hasKids ? '📂' : '📁';

      var lbl = document.createElement('span');
      lbl.className = 'tlabel';
      lbl.textContent = n.depth === 0 ? (baseName(n.path) || '全部音乐') : n.name;
      lbl.title = n.path;

      var cnt = document.createElement('span');
      cnt.className = 'tcnt';
      cnt.textContent = n.files > 0 ? String(n.files) : '';

      row.appendChild(caret); row.appendChild(ico); row.appendChild(lbl); row.appendChild(cnt);
      row.__node = n;

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
        if (ev.target && ev.target.classList && ev.target.classList.contains('caret')) {
          if (!hasKids) return;
          n.__open = !n.__open;
          collapseTree();
          return;
        }
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

  // ---------- 排序 ----------

  function sortList(list) {
    var arr = list.slice();
    var dir = sortAsc ? 1 : -1;
    arr.sort(function (a, b) {
      var r = 0;
      switch (sortKey) {
        case 'name': r = String(a.name).localeCompare(String(b.name), 'zh'); break;
        case 'size': r = (a.sizeBytes || 0) - (b.sizeBytes || 0); break;
        case 'type': r = String(a.ext || '').localeCompare(String(b.ext || '')); break;
        case 'mtime': r = (a.mtimeMs || 0) - (b.mtimeMs || 0); break;
        case 'ctime':
        default: r = (a.ctimeMs || 0) - (b.ctimeMs || 0); break;
      }
      if (r === 0) r = String(a.name).localeCompare(String(b.name), 'zh');
      return r * dir;
    });
    return arr;
  }

  // ---------- 视图 ----------

  function applyView() {
    var kw = (el.search && el.search.value || '').trim().toLowerCase();
    var list = files.filter(function (f) {
      if (isExcluded(f.path)) return false;          // 排除目录下的文件不显示
      // 有搜索词时全局搜（不限当前目录），与 PR 一致
      if (kw) {
        var base = String(f.name).replace(/\.[^.]+$/, '').toLowerCase();
        if (base.indexOf(kw) >= 0) return true;
        return String(f.path).toLowerCase().indexOf(kw) >= 0;
      }
      if (curDir) {
        var d = String(f.path).toLowerCase(), c = String(curDir).toLowerCase();
        if (d.indexOf(c) !== 0) return false;
      }
      return true;
    });
    visibleFiles = sortList(list);
    if (el.count) {
      el.count.textContent = visibleFiles.length === files.length
        ? (files.length + ' 首')
        : (visibleFiles.length + ' / ' + files.length + ' 首');
    }
    unmountAll();
    if (el.empty) el.empty.style.display = visibleFiles.length ? 'none' : '';
    renderList();
  }

  // ---------- 虚拟滚动 ----------

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
        var node = buildItem(f, i);
        node.style.top = (i * ITEM_H) + 'px';
        el.list.appendChild(node);
        renderedMap[f.path] = node;
      } else {
        renderedMap[f.path].style.top = (i * ITEM_H) + 'px';
      }
    }
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
      var n = renderedMap[p];
      if (!n) return;
      if (n.__ws) { try { n.__ws.destroy(); } catch (e) {} }
      if (n.parentNode) n.parentNode.removeChild(n);
    });
    renderedMap = {};
  }

  function buildItem(f, idx) {
    var item = document.createElement('div');
    item.className = 'mllib-item';
    item.dataset.path = f.path;
    item.draggable = true;

    var nm = document.createElement('button');
    nm.className = 'nm';
    nm.textContent = f.name;
    nm.title = '点击导入素材池「音乐」；拖拽可送到时间线';
    nm.addEventListener('click', function (ev) { ev.stopPropagation(); importToPool(f); });

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

    item.appendChild(playBtn);
    item.appendChild(waveEl);
    item.appendChild(nm);
    item.appendChild(dur);
    item.appendChild(ext);

    item.addEventListener('dragstart', function (ev) {
      var t = ev.target;
      if (t.closest && (t.closest('.wave') || t.closest('.playbtn'))) { ev.preventDefault(); return; }
      ev.preventDefault();
      if (window.vhHost && window.vhHost.startDrag) {
        window.vhHost.startDrag(f.path);
        status('正在拖出：' + f.name, '');
      } else {
        toast('当前环境不支持拖拽，请用「点击名称」导入', 'err');
      }
    });
    item.addEventListener('dragend', stopPlayback);

    item.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      showMenu(ev, f);
    });
    return item;
  }

  // ---------- 波形 ----------

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
        height: 40,
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
        if (dEl && d) { dEl.textContent = fmtDur(d); f.durationSec = d; }
        if (playingPath === f.path && curAudio && curAudio.currentTime > 0) {
          var dd = ws.getDuration() || 1;
          ws.seekTo(Math.min(0.999, curAudio.currentTime / dd));
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
  function playIco() { var b = $('btnMlPlay'); return b ? b.querySelector('.ic-play') : null; }
  function pauseIco() { var b = $('btnMlPlay'); return b ? b.querySelector('.ic-pause') : null; }
  function setIco(playing) {
    var a = playIco(), b = pauseIco();
    if (a) a.style.display = playing ? 'none' : '';
    if (b) b.style.display = playing ? '' : 'none';
  }

  function isPlaying() { return !!(curAudio && !curAudio.paused); }

  function playFrom(f, startSec) {
    stopPlayback();
    if (!window.vhHost) { toast('宿主接口不可用', 'err'); return; }
    status('加载中：' + f.name, '');
    // 播放用 Blob URL（data URL 对 wav 过长会被 Chromium 拒绝）
    readPlayableUrl(f.path).then(function (url) {
      if (!url) throw new Error('无法读取音频');
      curAudio = new Audio(url);
      curAudio.__url = url;
      curAudio.volume = parseFloat(el.vol ? el.vol.value : 0.8) || 0.8;
      curAudio.addEventListener('timeupdate', onTimeUpdate);
      curAudio.addEventListener('ended', stopPlayback);
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
      var node = renderedMap[f.path];
      if (node) ensureWave(node);
    }).catch(function (e) {
      toast('播放失败：' + (e && e.message || e), 'err');
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
  }
  function onTimeUpdate() {
    if (!curAudio || seeking) return;
    var d = curAudio.duration || 0;
    var c = curAudio.currentTime || 0;
    if (el.cur) el.cur.textContent = fmtDur(c);
    if (el.dur && d) el.dur.textContent = fmtDur(d);
    if (el.seekFill && d) el.seekFill.style.width = ((c / d) * 100).toFixed(2) + '%';
    var node = playingPath ? renderedMap[playingPath] : null;
    if (node && node.__ws && node.__wsReady && d) {
      try { node.__ws.seekTo(Math.min(0.999, c / d)); } catch (e) {}
    }
  }
  function playPrev() {
    if (!visibleFiles.length) return;
    var i = visibleFiles.findIndex(function (f) { return f.path === playingPath; });
    playFrom(visibleFiles[i > 0 ? i - 1 : visibleFiles.length - 1], 0);
  }
  function playNext() {
    if (!visibleFiles.length) return;
    var i = visibleFiles.findIndex(function (f) { return f.path === playingPath; });
    playFrom(visibleFiles[(i >= 0 && i < visibleFiles.length - 1) ? i + 1 : 0], 0);
  }

  // ---------- 导入 / 插入 ----------

  function importToPool(f) {
    if (!window.vhHost || !window.vhHost.importFilesToPool) return;
    status('导入中：' + f.name, '');
    window.vhHost.importFilesToPool([f.path], '音乐').then(function (r) {
      var d = r && r.data ? r.data : r;
      status('已导入素材池：' + (d && d.names ? d.names.join(', ') : f.name), 'ok');
      toast('已导入：' + f.name, 'ok');
    }).catch(function (e) {
      status('导入失败：' + (e && e.message || e), 'err');
    });
  }

  function insertToTimeline(f) {
    window.vhHost.getPlayhead('').then(function (r) {
      var ph = r && r.data ? r.data : r;
      return window.vhHost.insertAudioToTimeline({
        path: f.path,
        recordFrame: ph && ph.frames !== null ? ph.frames : undefined,
        folderName: '音乐'
      });
    }).then(function () {
      status('已插入时间线', 'ok');
      toast('已插入：' + f.name, 'ok');
    }).catch(function (e) {
      status('插入失败：' + (e && e.message || e), 'err');
    });
  }

  // ---------- 右键菜单 ----------

  function showMenu(ev, f) {
    var box = $('mllibContextMenu');
    if (!box) return;
    box.innerHTML = '';
    var menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;left:' + ev.clientX + 'px;top:' + ev.clientY + 'px;'
      + 'background:var(--panel);border:1px solid var(--border);border-radius:6px;'
      + 'padding:4px;z-index:9999;font-size:12px;min-width:150px;box-shadow:0 4px 14px rgba(0,0,0,.4);';
    [['▶ 播放', function () { playFrom(f, 0); }],
     ['导入素材池', function () { importToPool(f); }],
     ['插入播放头', function () { insertToTimeline(f); }],
     ['在资源管理器定位', function () {
       if (window.vhHost && window.vhHost.revealFile) window.vhHost.revealFile(f.path);
     }]].forEach(function (it) {
      var b = document.createElement('div');
      b.textContent = it[0];
      b.style.cssText = 'padding:6px 10px;border-radius:4px;cursor:pointer;';
      b.addEventListener('mouseenter', function () { b.style.background = 'var(--gray-card)'; });
      b.addEventListener('mouseleave', function () { b.style.background = ''; });
      b.addEventListener('click', function () { closeMenu(); it[1](); });
      menu.appendChild(b);
    });
    box.appendChild(menu);
    var r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = Math.max(4, window.innerWidth - r.width - 6) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - r.height - 6) + 'px';
    setTimeout(function () { document.addEventListener('click', closeMenu, { once: true }); }, 0);
  }
  function closeMenu() {
    if (window.vhMenu) { window.vhMenu.close(); return; }
    var b = $('mllibContextMenu');
    if (b) b.innerHTML = '';
  }

  // ---------- 扫描 ----------

  function scan() {
    var dir = (el.dir && el.dir.value || '').trim();
    if (!dir) { toast('请先选择音乐目录', 'err'); return; }
    status('扫描中…', '');
    if (el.empty) el.empty.style.display = 'none';
    window.vhHost.listDir(dir, true, 'audio').then(function (r) {
      var d = r && r.data ? r.data : r;
      files = (d.files || []).map(function (x) {
        return { name: x.name, path: x.path, sizeBytes: x.sizeBytes, ext: x.ext,
                 ctimeMs: x.ctimeMs || 0, mtimeMs: x.mtimeMs || 0, kind: 'music' };
      });
      fileByPath = {};
      files.forEach(function (f) { fileByPath[f.path] = f; });
      treeData = files.length ? buildTree(dir, files) : null;
      curDir = '';
      curNode = treeData;
      try { localStorage.setItem(ROOT_KEY, dir); } catch (e) {}
      renderTree();
      applyView();
      updateExcludedBtn();
      status('已扫描 ' + files.length + ' 首', 'ok');
      toast('扫描到 ' + files.length + ' 首音乐', 'ok');
    }).catch(function (e) {
      status('扫描失败：' + (e && e.message || e), 'err');
      toast('扫描失败：' + (e && e.message || e), 'err');
    });
  }

  function browse() {
    var start = (el.dir && el.dir.value || '').trim();
    window.vhHost.pickFolder(start, '选择音乐库根目录').then(function (r) {
      var dir = r && r.data ? r.data : r;
      if (!dir) return;
      el.dir.value = dir;
      scan();
    }).catch(function (e) {
      toast('选择目录失败：' + (e && e.message || e), 'err');
    });
  }

  function init() {
    el = {
      dir: $('mllibDir'), search: $('mllibSearch'), count: $('mllibCount'),
      tree: $('mllibTree'), list: $('mllibList'), spacer: $('mllibSpacer'),
      excludedBtn: $('btnMllibExcluded'),
      empty: $('mllibEmpty'), status: $('mllibStatus'),
      player: $('mllibPlayer'), title: $('mlpTitle'), sub: $('mlpSub'),
      cur: $('mlpCur'), dur: $('mlpDur'), seek: $('mlpSeek'), seekFill: $('mlpSeekFill'),
      vol: $('mlpVol'), playIco: null, pauseIco: null
    };
    if (!el.list) return;
    var playBtn = $('btnMlPlay');
    if (playBtn) {
      el.playIco = playBtn.querySelector('.ic-play');
      el.pauseIco = playBtn.querySelector('.ic-pause');
    }

    $('btnMllibBrowse').addEventListener('click', browse);
    $('btnMllibScan').addEventListener('click', scan);
    var exBtn = $('btnMllibExcluded');
    if (exBtn) exBtn.addEventListener('click', function (ev) { ev.stopPropagation(); showExcludedPanel(); });
    if (el.search) el.search.addEventListener('input', applyView);

    var sel = $('mllibSort');
    if (sel) sel.addEventListener('change', function () { sortKey = sel.value; applyView(); });
    var sdir = $('btnMllibSortDir');
    if (sdir) {
      sdir.addEventListener('click', function () {
        sortAsc = !sortAsc;
        sdir.textContent = sortAsc ? '↑ 旧→新' : '↓ 新→旧';
        applyView();
      });
    }

    el.list.addEventListener('scroll', function () {
      renderList();
      Object.keys(renderedMap).forEach(function (p) { ensureWave(renderedMap[p]); });
    }, { passive: true });

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
    var prev = $('btnMlPrev'); if (prev) prev.addEventListener('click', playPrev);
    var next = $('btnMlNext'); if (next) next.addEventListener('click', playNext);
    var volBtn = $('btnMlVol');
    if (volBtn) {
      volBtn.addEventListener('click', function () {
        var on = volBtn.querySelector('.ic-vol-on'), off = volBtn.querySelector('.ic-vol-off');
        var muted = on && on.style.display === 'none';
        if (on) on.style.display = muted ? '' : 'none';
        if (off) off.style.display = muted ? 'none' : '';
        if (curAudio) curAudio.muted = !muted;
      });
    }
    if (el.vol) el.vol.addEventListener('input', function () {
      if (curAudio) curAudio.volume = parseFloat(el.vol.value);
    });
    if (el.seek) {
      var doSeek = function (ev) {
        if (!curAudio) return;
        var r = el.seek.getBoundingClientRect();
        var p = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        try { curAudio.currentTime = p * (curAudio.duration || 0); } catch (e) {}
      };
      el.seek.addEventListener('mousedown', function (ev) { seeking = true; doSeek(ev); });
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

  window.__mllibPanel = {
    init: function () {
      init();
      if (!files.length && el.empty) el.empty.style.display = '';
    },
    scan: scan,
    get hasData() { return files.length > 0; }
  };
})();
