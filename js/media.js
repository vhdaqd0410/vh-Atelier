/**
 * vh-Atelier · DaVinci Resolve 版 · 素材库
 *
 * 【设计】左侧可折叠目录树 + 右侧文件列表。
 *   - treeRoot：树的顶点（来自「常用根」或盘符），**与当前选中目录解耦**
 *   - curDir  ：当前选中的目录，只决定右侧列哪个目录的文件
 *   - 展开态记在 expanded[path]，懒加载：只在展开时读那一层
 *   - 点三角 = 展开/收起；点目录名 = 选中（并保证祖先链展开）
 *   - 右键目录 = 设为常用根 / 资源管理器打开 / 导入整目录 / 刷新
 *
 * 之前的错误：用 curDir 当树顶点 → 点一下目录树就"换根"，看起来像树没了。
 * 文件系统走 window.vhHost.fsSync（同步垫片），同步是链路不失效的关键。
 */
(function () {
  'use strict';

  var el = {};
  var roots = [];
  var treeRoot = '';          // 树的顶点
  var curDir = '';            // 当前选中目录（决定右侧列表）
  var selFiles = {};
  var curFiles = [];
  var expanded = {};
  var nodeKids = {};          // path -> [{name,path}] 缓存

  var ROOTS_KEY = 'vh_media_roots_v2';
  var CUR_KEY = 'vh_media_cur_v2';
  var TREE_ROOT_KEY = 'vh_media_treeroot_v1';
  var EXP_KEY = 'vh_media_exp_v1';
  var KIND_ICO = { video: '🎬', audio: '🎵', image: '🖼', sub: '💬', doc: '📄', other: '📦' };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(m, k) { if (window.__vhToast) window.__vhToast(m, k); else console.log('[media] ' + m); }
  function status(m, k) {
    if (!el.status) return;
    el.status.textContent = m || '';
    el.status.className = k || '';
  }
  function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }
  function kindOf(ext) {
    if (/^(mp4|mov|mxf|avi|m4v|webm|mts|m2ts)$/.test(ext)) return 'video';
    if (/^(wav|mp3|aiff|aac|flac)$/.test(ext)) return 'audio';
    if (/^(png|jpg|jpeg|webp|gif|bmp)$/.test(ext)) return 'image';
    if (/^(srt|ass|vtt)$/.test(ext)) return 'sub';
    if (/^(docx|pdf|txt|md|json|xml|csv|xlsx)$/.test(ext)) return 'doc';
    return 'other';
  }
  function fmtSize(b) {
    var n = Number(b) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
  function natCmp(a, b) { return String(a).localeCompare(String(b), 'zh', { numeric: true, sensitivity: 'base' }); }

  // ---------- 同步文件系统 ----------
  function fsReady() { return !!(window.vhHost && window.vhHost.fsSync && window.vhHost.fsSync.ready); }
  /** 读子目录（带缓存）；读失败返回 null 表示"不可读" */
  function kidsOf(p, useCache) {
    var key = norm(p);
    if (useCache !== false && nodeKids[key]) return nodeKids[key];
    if (!fsReady()) return null;
    try {
      var r = window.vhHost.fsSync.readdir(p);
      if (r && r.ok) {
        var dirs = (r.dirs || []).slice().sort(function (a, b) { return natCmp(a.name, b.name); });
        nodeKids[key] = dirs;
        return dirs;
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }
  function readDirFull(p) {
    if (!fsReady()) return null;
    try {
      var r = window.vhHost.fsSync.readdir(p);
      if (r && r.ok) {
        var files = (r.files || []).slice().sort(function (a, b) { return natCmp(a.name, b.name); });
        return { dirs: r.dirs || [], files: files };
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  // ---------- 持久化 ----------
  function loadRoots() {
    try { roots = JSON.parse(localStorage.getItem(ROOTS_KEY) || '[]') || []; }
    catch (e) { roots = []; }
  }
  function saveRoots() { try { localStorage.setItem(ROOTS_KEY, JSON.stringify(roots)); } catch (e) {} }
  function loadExpanded() {
    try { expanded = JSON.parse(localStorage.getItem(EXP_KEY) || '{}') || {}; }
    catch (e) { expanded = {}; }
  }
  function saveExpanded() {
    try {
      var keys = Object.keys(expanded).filter(function (k) { return expanded[k]; });
      if (keys.length > 300) keys = keys.slice(-300);
      var o = {};
      keys.forEach(function (k) { o[k] = true; });
      localStorage.setItem(EXP_KEY, JSON.stringify(o));
    } catch (e) {}
  }
  function saveTreeRoot() { try { localStorage.setItem(TREE_ROOT_KEY, treeRoot); } catch (e) {} }
  function saveCur() { try { localStorage.setItem(CUR_KEY, curDir); } catch (e) {} }

  function renderRootSel() {
    if (!el.rootSel) return;
    var html = ['<option value="__computer__">💻 我的电脑</option>'];
    roots.forEach(function (r) {
      html.push('<option value="' + esc(r.path) + '">📁 ' + esc(r.name || baseName(r.path)) + '</option>');
    });
    el.rootSel.innerHTML = html.join('');
    var hit = roots.filter(function (r) { return norm(treeRoot) === norm(r.path); })[0];
    el.rootSel.value = hit ? hit.path : '__computer__';
  }

  // ---------- 树 ----------
  function treeRow(name, path, depth, hasKids, isDrive) {
    var open = !!expanded[norm(path)];          // 键统一归一化，避免斜杠不一致
    var isSel = norm(path) === norm(curDir);
    return '<div class="md-node' + (isSel ? ' sel' : '') + '" data-path="' + esc(path) + '"'
      + ' style="padding-left:' + (4 + depth * 13) + 'px">'
      + '<span class="md-tri' + (hasKids ? '' : ' leaf') + '">' + (hasKids ? (open ? '▾' : '▸') : '') + '</span>'
      + '<span class="md-ico">' + (isDrive ? '💽' : '📁') + '</span>'
      + '<span class="md-nm" title="' + esc(path) + '">' + esc(name) + '</span>'
      + '</div>';
  }

  /** 递归渲染已展开的分支 */
  function renderKids(path, depth, out) {
    var kids = kidsOf(path);
    if (!kids) return;
    kids.forEach(function (d) {
      var sub = kidsOf(d.path);
      var hasKids = !!(sub && sub.length);
      out.push(treeRow(d.name, d.path, depth, hasKids, false));
      if (expanded[norm(d.path)]) renderKids(d.path, depth + 1, out);
    });
  }

  function renderTree() {
    if (!el.tree) return;
    var out = [];

    if (!treeRoot) {
      // 我的电脑：盘符列表
      if (!fsReady() || !window.vhHost.fsSync.drives) {
        el.tree.innerHTML = '<div class="empty">无法读取磁盘</div>';
        return;
      }
      var dr = window.vhHost.fsSync.drives();
      var list = ((dr && dr.drives) || []).slice();
      list.forEach(function (d) {
        var sub = kidsOf(d);
        var hasKids = !!(sub && sub.length);
        out.push(treeRow(d, d, 0, hasKids, true));
        if (expanded[norm(d)]) renderKids(d, 1, out);
      });
      el.tree.innerHTML = out.join('') || '<div class="empty">未检测到磁盘</div>';
      return;
    }

    // 以 treeRoot 为顶点；**不受 curDir 影响**
    var isDrive = /^[A-Za-z]:[\\/]?$/.test(treeRoot);
    var sub0 = kidsOf(treeRoot);
    var has0 = !!(sub0 && sub0.length);
    out.push(treeRow(baseName(treeRoot) || treeRoot, treeRoot, 0, has0, isDrive));
    renderKids(treeRoot, 1, out);
    el.tree.innerHTML = out.join('');
  }

  /** 保证从 treeRoot 到 path 的祖先链都展开 */
  function expandChain(path) {
    // 键统一用 norm(path)（正斜杠小写），避免正/反斜杠混用导致查不到
    if (!treeRoot) { expanded[norm(path)] = true; return; }
    var rootN = norm(treeRoot).replace(/\/+$/, '');
    var pN = norm(path);
    if (pN.indexOf(rootN) !== 0) { expanded[norm(path)] = true; return; }
    expanded[rootN] = true;
    // 逐级展开祖先链
    var tail = pN.slice(rootN.length).replace(/^\/+/, '');
    var parts = tail.split('/').filter(Boolean);
    var acc = rootN;
    for (var i = 0; i < parts.length; i++) {
      acc = acc + '/' + parts[i];
      expanded[acc] = true;
    }
  }

  // ---------- 文件列表 ----------
  function renderFiles() {
    if (!el.flist) return;
    if (!curDir) {
      el.flist.innerHTML = '<div class="empty">在左侧选择一个目录</div>';
      if (el.fhead) el.fhead.innerHTML = '<span class="hint">未选择目录</span>';
      updateSelCount();
      return;
    }
    var r = readDirFull(curDir);
    if (!r) {
      el.flist.innerHTML = '<div class="empty">读取失败：' + esc(curDir) + '</div>';
      return;
    }
    curFiles = r.files || [];
    closePreview();
    if (el.fhead) {
      el.fhead.innerHTML = '<span class="md-path" title="' + esc(curDir) + '">' + esc(curDir) + '</span>'
        + '<span class="hint" style="margin-left:auto">' + curFiles.length + ' 个文件</span>';
    }
    if (!curFiles.length) {
      el.flist.innerHTML = '<div class="empty">该目录下没有可导入的文件</div>';
      updateSelCount();
      return;
    }
    el.flist.innerHTML = curFiles.map(function (f) {
      var kind = kindOf(f.ext);
      return '<div class="md-file' + (selFiles[f.path] ? ' sel' : '') + '" data-path="' + esc(f.path) + '"'
        + ' data-name="' + esc(f.name) + '" data-ext="' + esc(f.ext || '') + '" draggable="true">'
        + '<span class="md-fico">' + (KIND_ICO[kind] || '📦') + '</span>'
        + '<span class="md-fname" title="' + esc(f.name) + '">' + esc(f.name) + '</span>'
        + '<span class="md-fsize">' + fmtSize(f.size) + '</span>'
        + '<span class="md-fkind">' + esc(String(f.ext || '').toUpperCase()) + '</span>'
        + '</div>';
    }).join('');
    updateSelCount();
    status(curFiles.length + ' 个文件', 'ok');
  }

  // ---------- 预览遮罩（对齐 PR：图/视频/音频 + 定位 + 导入） ----------
  var previewEl = null;
  function closePreview() {
    if (previewEl && previewEl.parentNode) previewEl.parentNode.removeChild(previewEl);
    previewEl = null;
  }
  function fileUrl(p) { return 'file:///' + String(p).replace(/\\/g, '/'); }

  function openPreview(full, name) {
    closePreview();
    var ext = (String(name).match(/\.([^.]+)$/) || [])[1];
    ext = ext ? ext.toLowerCase() : '';
    var ov = document.createElement('div');
    ov.className = 'md-preview-ov';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:10002;'
      + 'display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;';
    ov.addEventListener('click', function (e) { if (e.target === ov) closePreview(); });

    var box = document.createElement('div');
    box.style.cssText = 'background:#111;border:1px solid #333;border-radius:8px;padding:8px 10px;'
      + 'max-width:92%;max-height:88%;display:flex;flex-direction:column;';
    var ttl = document.createElement('div');
    ttl.style.cssText = 'font-size:11px;color:#ccc;margin-bottom:6px;overflow:hidden;'
      + 'text-overflow:ellipsis;white-space:nowrap;max-width:420px;';
    ttl.textContent = name;
    ttl.title = full;
    box.appendChild(ttl);

    var media = null;
    if (/^(png|jpg|jpeg|webp|gif|bmp)$/.test(ext)) {
      media = document.createElement('img');
      media.src = fileUrl(full);
      media.style.cssText = 'max-width:420px;max-height:60vh;border-radius:4px;display:block;';
    } else if (/^(mp4|mov|m4v|webm|mxf|avi|mts|m2ts)$/.test(ext)) {
      media = document.createElement('video');
      media.src = fileUrl(full);
      media.controls = true;
      media.style.cssText = 'max-width:520px;max-height:60vh;display:block;background:#000;';
    } else if (/^(wav|mp3|aiff|aac|flac)$/.test(ext)) {
      media = document.createElement('audio');
      media.src = fileUrl(full);
      media.controls = true;
      media.style.cssText = 'width:420px;display:block;';
    } else {
      media = document.createElement('div');
      media.textContent = full;
      media.style.cssText = 'color:#999;font-size:12px;max-width:420px;word-break:break-all;padding:20px 4px;';
    }
    box.appendChild(media);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:8px;flex-wrap:wrap;';
    // 定位
    var bLoc = document.createElement('button');
    bLoc.type = 'button';
    bLoc.textContent = '📂 定位';
    bLoc.style.cssText = 'background:#2a4a2a;color:#7fd68b;border:none;border-radius:4px;'
      + 'padding:4px 14px;cursor:pointer;font-size:11px;';
    bLoc.addEventListener('click', function () { reveal(full); });
    row.appendChild(bLoc);
    // 导入
    var bImp = document.createElement('button');
    bImp.type = 'button';
    bImp.textContent = '⬇ 导入素材箱';
    bImp.style.cssText = 'background:#3a2e52;color:#e6d9ff;border:none;border-radius:4px;'
      + 'padding:4px 14px;cursor:pointer;font-size:11px;';
    bImp.addEventListener('click', function () { curDir = dirOf(full); importFiles([full]); });
    row.appendChild(bImp);
    // 关闭
    var bCl = document.createElement('button');
    bCl.type = 'button';
    bCl.textContent = '✕ 关闭';
    bCl.style.cssText = 'background:#3a3a3a;color:#bbb;border:none;border-radius:4px;'
      + 'padding:4px 14px;cursor:pointer;font-size:11px;';
    bCl.addEventListener('click', closePreview);
    row.appendChild(bCl);
    box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);
    previewEl = ov;

    // 媒体类：尽量自动播放（失败不报错）
    if (media && media.play) { try { media.play().catch(function () {}); } catch (e) {} }
  }

  function dirOf(full) {
    var s = String(full || '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : '';
  }
  function reveal(full) {
    if (window.vhHost && window.vhHost.revealFile) { window.vhHost.revealFile(full); return; }
    if (window.vhHost && window.vhHost.openWithSystem) { window.vhHost.openWithSystem(dirOf(full)); }
  }

  /** 头部详情：名称 / 大小 / 时间 + 定位 / 导入（对齐 PR showFileDetail） */
  function showFileDetail(full, name, kind, isMedia) {
    if (!el.fhead) return;
    var st = null;
    try { st = window.vhHost.fsSync.stat(full); } catch (e) { st = null; }
    var szTxt = st ? fmtSize(st.size) : '';
    var when = '';
    if (st && st.mtimeMs) {
      try { when = new Date(st.mtimeMs).toLocaleString(); } catch (e) {}
    }
    el.fhead.innerHTML = '<span class="md-path" title="' + esc(full) + '">' + esc(name) + '</span>'
      + '<span class="hint" style="margin-left:auto">' + esc(szTxt) + (when ? ' · ' + esc(when) : '') + '</span>';
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;';
    if (isMedia) {
      bar.appendChild(mkMiniBtn('👁 预览', function () { openPreview(full, name); }));
      bar.appendChild(mkMiniBtn('⬇ 导入素材箱', function () { importFiles([full]); }, '#7fd68b'));
    }
    bar.appendChild(mkMiniBtn('📂 定位', function () { reveal(full); }));
    if (/^(docx|pdf)$/i.test(String(name).match(/\.([^.]+)$/) ? String(name).match(/\.([^.]+)$/)[1] : '')) {
      bar.appendChild(mkMiniBtn('📖 剧本阅读', function () {
        if (window.__scriptPanel && window.__scriptPanel.openScript) window.__scriptPanel.openScript(full);
        else if (window.vhHost && window.vhHost.openWithSystem) window.vhHost.openWithSystem(full);
      }));
    }
    el.fhead.appendChild(bar);
  }
  function mkMiniBtn(label, onClick, color) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tbtn';
    b.textContent = label;
    b.style.cssText = 'padding:1px 8px;font-size:11px;' + (color ? 'color:' + color + ';' : '');
    b.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(); });
    return b;
  }

  /** 导入指定路径列表 */
  function importFiles(paths) {
    if (!paths || !paths.length) return;
    var bin = el.binName ? el.binName.value.trim() : '素材';
    status('导入中 ' + paths.length + ' 个…', '');
    window.vhHost.importFilesToPool(paths, bin).then(function (r) {
      var d = r && r.data ? r.data : r;
      status('已导入 ' + (d.count || 0) + ' 个到「' + (d.folder || bin) + '」', 'ok');
      toast('已导入 ' + (d.count || 0) + ' 个', 'ok');
    }).catch(function (e) { status('导入失败：' + (e.message || e), 'err'); });
  }

  function updateSelCount() {
    var n = Object.keys(selFiles).length;
    if (el.impSel) {
      el.impSel.textContent = '⬆ 导入选中(' + n + ')';
      el.impSel.disabled = n === 0;
    }
  }

  // ---------- 交互 ----------
  /** 切换某个目录的展开态（三角点击 / 双击 共用） */
  function toggleExpand(path, forceOpen) {
    var key = norm(path);
    var wantOpen = (forceOpen === undefined) ? !expanded[key] : !!forceOpen;
    if (wantOpen) expanded[key] = true; else delete expanded[key];
    saveExpanded();
    renderTree();
    return wantOpen;
  }

  // 双击判定（自己算，不依赖 dblclick 事件）
  var _lastTapPath = '';
  var _lastTapAt = 0;
  var DBL_MS = 380;

  function onTreeClick(ev) {
    var node = ev.target.closest ? ev.target.closest('.md-node') : null;
    if (!node) return;
    var path = node.dataset.path;
    var tri = ev.target.closest ? ev.target.closest('.md-tri') : null;

    // 点三角：切换展开
    if (tri && !tri.classList.contains('leaf')) {
      ev.stopPropagation();
      _lastTapPath = '';       // 三角点击不参与双击判定
      toggleExpand(path);
      return;
    }

    // 目录名：先选中
    curDir = path;
    selFiles = {};
    saveCur();

    // 判定是否双击（同一行、间隔够短）
    var now = Date.now();
    var isDbl = (norm(path) === _lastTapPath) && ((now - _lastTapAt) < DBL_MS);
    _lastTapPath = norm(path);
    _lastTapAt = now;

    if (isDbl) {
      // 双击：切换展开态（有子目录时）
      _lastTapPath = '';       // 防止三击误判
      var kids = kidsOf(path);
      if (kids && kids.length) {
        if (expanded[norm(path)]) {
          delete expanded[norm(path)];
          saveExpanded();
        } else {
          expandChain(path);
          expanded[norm(path)] = true;
          saveExpanded();
        }
      }
    }
    renderTree();
    renderFiles();
  }

  function onTreeContext(ev) {
    var node = ev.target.closest ? ev.target.closest('.md-node') : null;
    if (!node) return;
    ev.preventDefault();
    ev.stopPropagation();
    var path = node.dataset.path;
    var isRoot = roots.some(function (r) { return norm(r.path) === norm(path); });
    var isDrive = /^[A-Za-z]:[\\/]?$/.test(path);
    var items = [];

    if (!isDrive) {
      items.push({
        label: isRoot ? '✅ 从常用根移除' : '⭐ 设为常用根',
        onClick: function () {
          if (isRoot) roots = roots.filter(function (r) { return norm(r.path) !== norm(path); });
          else roots.push({ path: path, name: baseName(path) });
          saveRoots(); renderRootSel(); renderTree();
          toast(isRoot ? '已移出常用根' : '已设为常用根', 'ok');
        }
      });
      items.push({
        label: '🎯 以此为树的顶点',
        onClick: function () {
          treeRoot = path;
          saveTreeRoot();
          delete expanded[path];
          renderRootSel(); renderTree();
        }
      });
    }
    items.push({
      label: '📂 在资源管理器中打开',
      onClick: function () {
        if (window.vhHost && window.vhHost.revealFolder) window.vhHost.revealFolder(path);
        else if (window.vhHost && window.vhHost.openWithSystem) window.vhHost.openWithSystem(path);
      }
    });
    items.push({ sep: true });
    items.push({
      label: '⬆ 导入该目录全部文件',
      onClick: function () { curDir = path; saveCur(); renderTree(); renderFiles(); importFolder(); }
    });
    items.push({
      label: '↻ 刷新此节点',
      onClick: function () {
        // 连同子树缓存一起清掉，避免显示陈旧内容
        Object.keys(nodeKids).forEach(function (k) {
          if (norm(k).indexOf(norm(path)) === 0) delete nodeKids[k];
        });
        renderTree();
      }
    });

    if (window.vhMenu) window.vhMenu.show(ev, items);
  }

  function onFileClick(ev) {
    var row = ev.target.closest ? ev.target.closest('.md-file') : null;
    if (!row) return;
    var p = row.dataset.path;
    var name = row.dataset.name || baseName(p);
    var kind = kindOf(row.dataset.ext || '');

    if (ev.ctrlKey || ev.metaKey) {
      if (selFiles[p]) delete selFiles[p]; else selFiles[p] = true;
      row.classList.toggle('sel', !!selFiles[p]);
      updateSelCount();
      return;
    }
    // 单选 + 详情 + 媒体预览（对齐 PR）
    selFiles = {}; selFiles[p] = true;
    if (el.flist) {
      var all = el.flist.querySelectorAll('.md-file');
      for (var i = 0; i < all.length; i++) all[i].classList.remove('sel');
    }
    row.classList.add('sel');
    updateSelCount();
    var isMedia = /^(video|audio|image)$/.test(kind);
    showFileDetail(p, name, kind, isMedia);
    if (isMedia) openPreview(p, name);
  }
  function onFileDblClick(ev) {
    var row = ev.target.closest ? ev.target.closest('.md-file') : null;
    if (!row) return;
    if (window.vhHost && window.vhHost.openWithSystem) {
      window.vhHost.openWithSystem(row.dataset.path).catch(function () {});
    }
  }
  function onDragStart(ev) {
    var row = ev.target.closest ? ev.target.closest('.md-file') : null;
    if (!row) return;
    var p = row.dataset.path;
    if (!selFiles[p]) { selFiles = {}; selFiles[p] = true; updateSelCount(); }
    ev.preventDefault();
    if (window.vhHost && window.vhHost.startDrag) {
      window.vhHost.startDrag(p);
      status('正在拖出：' + baseName(p), '');
    }
  }

  function importSelected() {
    var paths = Object.keys(selFiles);
    if (!paths.length) { toast('请先选择文件', 'err'); return; }
    var bin = el.binName ? el.binName.value.trim() : '素材';
    status('导入中 ' + paths.length + ' 个…', '');
    window.vhHost.importFilesToPool(paths, bin).then(function (r) {
      var d = r && r.data ? r.data : r;
      status('已导入 ' + (d.count || 0) + ' 个到「' + (d.folder || bin) + '」', 'ok');
      toast('已导入 ' + (d.count || 0) + ' 个', 'ok');
      selFiles = {};
      renderFiles();
    }).catch(function (e) { status('导入失败：' + (e.message || e), 'err'); });
  }

  function importFolder() {
    if (!curDir) { toast('请先选目录', 'err'); return; }
    var r = readDirFull(curDir);
    if (!r || !r.files.length) { status('该目录下没有可导入文件', 'warn'); return; }
    var bin = el.binName ? el.binName.value.trim() : '素材';
    var paths = r.files.map(function (f) { return f.path; });
    status('导入 ' + paths.length + ' 个…', '');
    window.vhHost.importFilesToPool(paths, bin).then(function (res) {
      var d = res && res.data ? res.data : res;
      status('已导入 ' + (d.count || 0) + ' 个', 'ok');
      toast('已导入 ' + (d.count || 0) + ' 个', 'ok');
    }).catch(function (e) { status('导入失败：' + (e.message || e), 'err'); });
  }

  function addRoot() {
    if (!window.vhHost || !window.vhHost.pickFolder) return;
    window.vhHost.pickFolder(treeRoot || '', '选择常用根目录').then(function (r) {
      var dir = r && r.data ? r.data : r;
      if (!dir) return;
      if (!roots.some(function (x) { return norm(x.path) === norm(dir); })) {
        roots.push({ path: dir, name: baseName(dir) });
        saveRoots();
      }
      gotoRoot(dir);
      toast('已添加：' + baseName(dir), 'ok');
    }).catch(function (e) { toast('选择失败：' + (e.message || e), 'err'); });
  }

  /** 切到某个根：树顶点 + 选中都指向它 */
  function gotoRoot(dir) {
    treeRoot = dir;
    curDir = dir;
    saveTreeRoot(); saveCur();
    expanded = {};                     // 新根从"只展开根"开始，避免旧状态的干扰
    expandChain(dir);
    saveExpanded();
    renderRootSel(); renderTree(); renderFiles();
  }

  function collapseAll() {
    expanded = {};
    // 保留根展开，否则一折叠就只剩一行、看不到任何子目录
    if (treeRoot) expanded[norm(treeRoot)] = true;
    saveExpanded();
    renderTree();
    toast('已折叠全部', 'ok');
  }

  // ---------- 初始化 ----------
  function init() {
    el = {
      rootSel: $('mdRootSel'), addRoot: $('mdAddRoot'), addSubRoot: $('mdAddSubRoot'),
      collapse: $('mdCollapse'), binName: $('mdBinName'), tree: $('mdTree'),
      fhead: $('mdFHead'), flist: $('mdFList'), impSel: $('mdImpSel'),
      impFolder: $('mdImpFolder'), status: $('mdStatus')
    };
    if (!el.tree) return;
    if (el.tree.__inited) return;
    el.tree.__inited = true;

    loadRoots();
    loadExpanded();
    try { treeRoot = localStorage.getItem(TREE_ROOT_KEY) || ''; } catch (e) { treeRoot = ''; }
    try { curDir = localStorage.getItem(CUR_KEY) || ''; } catch (e) { curDir = ''; }
    renderRootSel();

    if (el.rootSel) {
      el.rootSel.addEventListener('change', function () {
        var v = el.rootSel.value;
        if (v === '__computer__') {
          treeRoot = ''; curDir = '';
          saveTreeRoot(); saveCur();
          renderRootSel(); renderTree(); renderFiles();
        } else gotoRoot(v);
      });
    }
    if (el.addRoot) el.addRoot.addEventListener('click', addRoot);
    if (el.collapse) el.collapse.addEventListener('click', collapseAll);
    if (el.addSubRoot) el.addSubRoot.addEventListener('click', function () {
      var d = curDir || treeRoot;
      if (!d) { toast('请先选目录', 'err'); return; }
      if (roots.some(function (x) { return norm(x.path) === norm(d); })) { toast('已在常用根里', 'warn'); return; }
      roots.push({ path: d, name: baseName(d) });
      saveRoots(); renderRootSel(); toast('已存入常用根', 'ok');
    });
    el.tree.addEventListener('click', onTreeClick);
    el.tree.addEventListener('contextmenu', onTreeContext);
    if (el.flist) {
      el.flist.addEventListener('click', onFileClick);
      el.flist.addEventListener('dblclick', onFileDblClick);
      el.flist.addEventListener('dragstart', onDragStart);
    }
    if (el.impSel) el.impSel.addEventListener('click', importSelected);
    if (el.impFolder) el.impFolder.addEventListener('click', importFolder);

    // 校验上次的树顶点/选中目录是否还存在
    var okRoot = treeRoot && fsReady() && window.vhHost.fsSync.exists(treeRoot)
      && window.vhHost.fsSync.isDir(treeRoot);
    if (okRoot) {
      if (!curDir || !window.vhHost.fsSync.exists(curDir)) curDir = treeRoot;
      expandChain(treeRoot);
      renderTree(); renderFiles();
    } else {
      treeRoot = ''; curDir = '';
      saveTreeRoot(); saveCur();
      renderRootSel(); renderTree(); renderFiles();
    }
  }

  window.__mediaPanel = {
    init: init,
    openPreview: openPreview,
    toggleExpand: toggleExpand,
    closePreview: closePreview,
    showFileDetail: showFileDetail,
    navTo: function (p) { gotoRoot(p); },
    _state: function () {
      return {
        treeRoot: treeRoot,
        curDir: curDir,
        expandedCount: Object.keys(expanded).filter(function (k) { return expanded[k]; }).length,
        files: curFiles.map(function (f) { return f.name; }),
        sel: Object.keys(selFiles),
        rows: el.tree ? Array.prototype.map.call(
          el.tree.querySelectorAll('.md-node .md-nm'), function (n) { return n.textContent; }) : []
      };
    }
  };
})();
