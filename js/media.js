// vh-Atelier 素材库：浏览本地/NAS 素材目录 → 点击导入 PR 项目（素材箱或时间线）
(function () {
  var fs, os, path;
  try {
    fs = require('fs');
    os = require('os');
    path = require('path');
  } catch (e) { return; }
  var csInterface = new CSInterface();
  function evalHost(s) { return new Promise(function (r) { csInterface.evalScript(s, r); }); }

  var el = {
    rootSel: document.getElementById('mdRootSel'),
    addRoot: document.getElementById('mdAddRoot'),
    target: document.getElementById('mdTarget'),
    binName: document.getElementById('mdBinName'),
    tree: document.getElementById('mdTree'),
    files: document.getElementById('mdFiles')
  };
  if (!el.tree) return;

  var ROOTS_KEY = 'vh_media_roots';
  var CUR_KEY = 'vh_media_cur';
  var MEDIA_EXT = /\.(mp4|mov|mxf|avi|m4v|webm|mts|m2ts|wav|aiff|mp3|aac|flac|png|jpg|jpeg|webp|gif|bmp)$/i;

  var currentRoot = '';      // 当前根
  var expanded = {};         // dir -> true 展开态

  function loadRoots() {
    try { var v = JSON.parse(localStorage.getItem(ROOTS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function saveRoots(arr) {
    try { localStorage.setItem(ROOTS_KEY, JSON.stringify(arr)); } catch (e) {}
  }
  function loadCur() {
    try { return localStorage.getItem(CUR_KEY) || ''; } catch (e) { return ''; }
  }
  function saveCur(p) {
    try { localStorage.setItem(CUR_KEY, p); } catch (e) {}
  }

  function log(msg, cls) {
    var d = document.createElement('div');
    d.className = cls || '';
    d.textContent = msg;
    // 素材面板无专门日志区，简单反馈用 title 闪烁替代；可后续加
  }

  // ---------- 根路径 ----------
  function renderRootSel() {
    var roots = loadRoots();
    el.rootSel.innerHTML = '';
    if (!roots.length) {
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = '（未设置路径）';
      el.rootSel.appendChild(o0);
      return;
    }
    roots.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r;
      o.textContent = r;
      el.rootSel.appendChild(o);
    });
    var cur = loadCur();
    if (cur && roots.indexOf(cur) >= 0) el.rootSel.value = cur;
    else el.rootSel.value = roots[0];
    currentRoot = el.rootSel.value || '';
    if (currentRoot) { buildTree(); }
  }

  el.addRoot.addEventListener('click', function () {
    // 手动输入或从 select 选根。用 prompt 让用户填路径（CEP 文件选择器复用 folderpicker 复杂，先 prompt）
    var roots = loadRoots();
    var cur = el.rootSel.value || '';
    var input = window.prompt('输入素材根目录路径（本地或网络盘，如 F:\\001AI漫剧 或 \\\\nas\\share）', cur || '');
    if (!input) return;
    input = input.trim().replace(/\\+$/, '');
    if (!input || !fs.existsSync(input)) { window.__copyFlash ? window.__copyFlash('路径不存在') : null; return; }
    if (roots.indexOf(input) < 0) roots.push(input);
    saveRoots(roots);
    renderRootSel();
    el.rootSel.value = input;
    currentRoot = input;
    saveCur(input);
    buildTree();
  });

  el.rootSel.addEventListener('change', function () {
    currentRoot = el.rootSel.value || '';
    if (currentRoot) {
      saveCur(currentRoot);
      expanded = {};
      buildTree();
    } else {
      el.tree.innerHTML = '<div class="hint" style="padding:8px;">设置根路径后浏览</div>';
      el.files.innerHTML = '';
    }
  });

  // ---------- 目录树（懒展开两级，点击进入） ----------
  function listDirs(p) {
    try {
      return fs.readdirSync(p, { withFileTypes: true })
        .filter(function (e) { return e.isDirectory(); })
        .map(function (e) { return e.name; })
        .filter(function (n) { return n.charAt(0) !== '.'; })
        .sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
    } catch (e) { return []; }
  }
  function listFiles(p) {
    try {
      return fs.readdirSync(p, { withFileTypes: true })
        .filter(function (e) { return e.isFile(); })
        .map(function (e) { return e.name; })
        .filter(function (n) { return MEDIA_EXT.test(n); })
        .sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
    } catch (e) { return []; }
  }

  var browseDir = '';   // 当前浏览目录（从根开始可逐级进入）

  function buildTree() {
    if (!currentRoot || !fs.existsSync(currentRoot)) {
      el.tree.innerHTML = '<div class="hint" style="padding:8px;">路径不可用，请重新设置</div>';
      el.files.innerHTML = '';
      return;
    }
    browseDir = currentRoot;
    renderNav();
  }

  // 导航式：面包屑(可点回根/上级) + 子目录列表
  function renderNav() {
    var dir = browseDir;
    el.tree.innerHTML = '';
    // 面包屑行：根 + 各级
    var crumb = document.createElement('div');
    crumb.className = 'md-crumb';
    function pushCrumb(label, full, isLast) {
      var sp = document.createElement('span');
      sp.className = 'md-crumb-item' + (isLast ? ' cur' : '');
      sp.textContent = label;
      sp.title = full;
      if (!isLast) {
        sp.addEventListener('click', function () { browseDir = full; renderNav(); });
      }
      crumb.appendChild(sp);
      if (!isLast) { var sep = document.createElement('span'); sep.textContent = ' › '; crumb.appendChild(sep); }
    }
    if (dir === currentRoot) {
      pushCrumb(path.basename(currentRoot) || currentRoot, currentRoot, true);
    } else {
      pushCrumb(path.basename(currentRoot) || currentRoot, currentRoot, false);
      var rel = path.relative(currentRoot, dir);
      var parts = rel.split(path.sep);
      var acc = currentRoot;
      parts.forEach(function (pp, idx) {
        acc = path.join(acc, pp);
        pushCrumb(pp, acc, idx === parts.length - 1);
      });
    }
    el.tree.appendChild(crumb);

    // 上级
    if (dir !== currentRoot) {
      var parent = path.dirname(dir);
      var upRow = document.createElement('div');
      upRow.className = 'md-tree-item md-up';
      upRow.textContent = '⬆ 上级：' + (parent === currentRoot ? path.basename(currentRoot) : path.basename(parent));
      upRow.title = parent;
      upRow.addEventListener('click', function () { if (fs.existsSync(parent)) { browseDir = parent; renderNav(); } });
      el.tree.appendChild(upRow);
    }
    // 子目录
    var subs = listDirs(dir);
    var wrap = document.createElement('div');
    wrap.className = 'md-subwrap';
    if (!subs.length) wrap.innerHTML = '<div style="padding:6px 4px;font-size:11px;color:var(--muted);">无子目录</div>';
    subs.forEach(function (s) {
      var full = path.join(dir, s);
      var row = document.createElement('div');
      row.className = 'md-tree-item md-subdir';
      row.textContent = '📁 ' + s;
      row.title = full + '\n点击进入';
      row.addEventListener('click', function () { browseDir = full; renderNav(); });
      wrap.appendChild(row);
    });
    el.tree.appendChild(wrap);
    renderFiles(dir);
  }

  // ---------- 右侧文件列表 ----------
  function renderFiles(dir) {
    var files = listFiles(dir);
    el.files.innerHTML = '';
    if (!files.length) {
      el.files.innerHTML = '<div class="hint" style="padding:10px;">该目录无媒体文件（视频/音频/图片）</div>';
      return;
    }
    var cap = document.createElement('div');
    cap.className = 'md-fcap';
    cap.textContent = files.length + ' 个媒体文件 · 点文件导入项目';
    el.files.appendChild(cap);

    var listWrap = document.createElement('div');
    listWrap.style.cssText = 'overflow-y:auto;flex:1;min-height:0;';
    files.forEach(function (f) {
      var full = path.join(dir, f);
      var ext = path.extname(f).toLowerCase().slice(1);
      var icon = { mp4: '🎬', mov: '🎬', mxf: '🎬', avi: '🎬', m4v: '🎬', webm: '🎬', wav: '🔊', mp3: '🎵', aiff: '🔊', aac: '🎵', png: '🖼', jpg: '🖼', jpeg: '🖼', webp: '🖼', gif: '🖼' }[ext] || '📄';
      var row = document.createElement('div');
      row.className = 'md-file';
      row.innerHTML = '<span class="md-ic">' + icon + '</span><span class="md-fn"></span>';
      row.querySelector('.md-fn').textContent = f;
      row.title = full + '\n点击导入项目';
      row.addEventListener('click', function () { importFile(full, f); });
      // 双击在资源管理器中打开所在目录
      row.addEventListener('dblclick', function () {
        try { require('child_process').exec('explorer /select,"' + full + '"', { windowsHide: true }); } catch (e) {}
      });
      listWrap.appendChild(row);
    });
    el.files.appendChild(listWrap);
  }

  // ---------- 导入到 PR ----------
  function importFile(full, name) {
    var mode = el.target.value;
    var binName = (el.binName.value || '').trim() || '素材';
    if (mode === 'bin') {
      importToBin([full], binName).then(function (imp) {
        if (imp && imp.ok) { flash('✅ 已导入素材箱「' + binName + '」'); }
        else { flash('⚠ 导入失败：' + ((imp && (imp.error || JSON.stringify(imp))) || '未知')); }
      });
    } else {
      // 时间线：先探测 —— 现有 vcInsertToTimelineStr 只支持 wav 特定 payload，做视频插入需新 host 函数
      flash('时间线插入需激活序列与目标轨，稍后支持；先导入素材箱');
      // TODO: 实现通用时间线插入
    }
  }

  function importToBin(files, binName) {
    return new Promise(function (resolve) {
      try {
        var payloadJson = JSON.stringify(files || []);
        csInterface.evalScript('wsImportToBinPayload = ' + payloadJson + ';', function () {
          csInterface.evalScript('wsImportToBinStr(' + JSON.stringify(binName) + ')', function (r) {
            try { resolve(JSON.parse(r)); } catch (e) { resolve({ error: r }); }
          });
        });
      } catch (e) { resolve({ error: e.message }); }
    });
  }

  function flash(msg) {
    try { window.__copyFlash(msg); } catch (e) {}
  }

  // 面板显示钩子
  window.__mediaOnShow = function () {
    if (!el.tree.innerHTML.trim() || !currentRoot) renderRootSel();
  };

  // 初始化：读根
  if (loadRoots().length) renderRootSel();
  else renderRootSel();  // 空态显示提示
})();
