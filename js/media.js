// vh-Atelier 素材库：浏览素材目录 → 导入 PR 项目（支持多选/文件夹/进度/防误导入）
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
    addSubRoot: document.getElementById('mdAddSubRoot'),
    binName: document.getElementById('mdBinName'),
    projInfo: document.getElementById('mdProjInfo'),
    selAll: document.getElementById('mdSelAll'),
    selNone: document.getElementById('mdSelNone'),
    impSel: document.getElementById('mdImpSel'),
    impFolder: document.getElementById('mdImpFolder'),
    progWrap: document.getElementById('mdProgWrap'),
    progFill: document.getElementById('mdProgFill'),
    progText: document.getElementById('mdProgText'),
    progPct: document.getElementById('mdProgPct'),
    tree: document.getElementById('mdTree'),
    files: document.getElementById('mdFiles')
  };
  if (!el.tree) return;

  var ROOTS_KEY = 'vh_media_roots';
  var CUR_KEY = 'vh_media_cur';
  var PROJ_KEY = 'vh_media_lastproj';
  var MEDIA_EXT = /\.(mp4|mov|mxf|avi|m4v|webm|mts|m2ts|wav|aiff|mp3|aac|flac|png|jpg|jpeg|webp|gif|bmp|srt)$/i;

  var currentRoot = '';
  var browseDir = '';
  var selFiles = {};       // 全路径 -> true 勾选
  var importing = false;

  function loadJSON(key, def) { try { return JSON.parse(localStorage.getItem(key) || def); } catch (e) { return JSON.parse(def); } }
  function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }
  function loadRoots() { var a = loadJSON(ROOTS_KEY, '[]'); return Array.isArray(a) ? a : []; }
  function saveRoots(a) { saveJSON(ROOTS_KEY, a); }
  function loadCur() { try { return localStorage.getItem(CUR_KEY) || ''; } catch (e) { return ''; } }
  function saveCur(p) { try { localStorage.setItem(CUR_KEY, p); } catch (e) {} }

  function flash(msg) { try { window.__copyFlash(msg); } catch (e) {} }

  // ===== 目录选择（folderpicker.ps1 浏览对话框）=====
  function locateExtRoot() {
    var r = '';
    try { r = csInterface.getSystemPath('extension'); } catch (_) {}
    if (r && fs.existsSync(path.join(r, 'jsx', 'folderpicker.ps1'))) return r;
    try {
      var d = (typeof __dirname !== 'undefined') ? __dirname : '';
      if (d) {
        var root2 = (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        if (fs.existsSync(path.join(root2, 'jsx', 'folderpicker.ps1'))) return root2;
      }
    } catch (_) {}
    return '';
  }
  function pickFolder(initial, title, cb) {
    var last = '';
    try { last = localStorage.getItem('vh_media_lastdir') || ''; } catch (e) {}
    var init = '';
    if (last && fs.existsSync(last)) init = last;
    else if (initial && fs.existsSync(initial)) init = initial;
    else if (initial) { var par = path.dirname(initial); if (fs.existsSync(par)) init = par; }

    var inFile = path.join(os.tmpdir(), 'cep_dir_in_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.txt');
    var outFile = path.join(os.tmpdir(), 'cep_dir_out_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.txt');
    fs.writeFileSync(inFile, JSON.stringify({ path: init, title: title || '选择文件夹' }), 'utf8');
    var extRoot = locateExtRoot();
    var psPath = path.join(extRoot || '', 'jsx', 'folderpicker.ps1');
    if (!fs.existsSync(psPath)) { cb(''); return; }
    var cmd = 'powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' + psPath + '" -Ini "' + inFile + '" -Out "' + outFile + '"';
    require('child_process').exec(cmd, { windowsHide: true }, function (err) {
      try { fs.unlinkSync(inFile); } catch (_) {}
      if (err) { try { fs.unlinkSync(outFile); } catch (_) {} cb(''); return; }
      var p2 = '';
      try { if (fs.existsSync(outFile)) { p2 = fs.readFileSync(outFile, 'utf8').trim(); fs.unlinkSync(outFile); } } catch (e) {}
      if (p2) { try { localStorage.setItem('vh_media_lastdir', p2); } catch (e) {} }
      cb(p2);
    });
  }

  // ===== 工程信息 & 防误导入 =====
  var curProj = null;   // {name, dir, saved, seq}
  async function refreshProjInfo() {
    try {
      var r = await evalHost('meProjectInfo()');
      if (!r) return;
      var j = JSON.parse(r);
      if (j && !j.error) {
        curProj = j;
        el.projInfo.textContent = '🎬 ' + (j.name || '(未命名工程)') + (j.saved ? '' : ' ⚠未保存');
        el.projInfo.title = (j.dir || '') + (j.seq ? '\n序列: ' + j.seq : '');
      } else { el.projInfo.textContent = '⚠ ' + (j && j.error || '检测工程失败'); }
    } catch (e) { el.projInfo.textContent = '⚠ 工程检测失败'; }
  }
  // 导入前确认目标工程：与上次不同则询问
  function confirmProject() {
    if (!curProj) return false;
    if (!curProj.name) return true;
    var last = loadJSON(PROJ_KEY, '{}');
    if (last.name && last.name !== curProj.name) {
      var ok = window.confirm('检测到当前导入目标是工程「' + curProj.name + '」\n上次导入到「' + last.name + '」\n\n确认导入到当前工程吗？');
      if (!ok) return false;
    }
    saveJSON(PROJ_KEY, { name: curProj.name, dir: curProj.dir, t: Date.now() });
    return true;
  }

  // ===== 根路径 =====
  function renderRootSel() {
    var roots = loadRoots();
    el.rootSel.innerHTML = '';
    if (!roots.length) {
      var o0 = document.createElement('option');
      o0.value = '';
      o0.textContent = '（未设置路径，点设根）';
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
    if (currentRoot) { browseDir = currentRoot; renderNav(); renderFiles(browseDir); }
  }
  function setRoot(p) {
    if (!p || !fs.existsSync(p)) return;
    var roots = loadRoots();
    if (roots.indexOf(p) < 0) roots.push(p);
    saveRoots(roots);
    currentRoot = p;
    browseDir = p;
    saveCur(p);
    renderRootSel();
    el.rootSel.value = p;
  }

  el.addRoot.addEventListener('click', function () {
    pickFolder(el.rootSel.value || '', '选择素材根目录', function (p) { if (p) setRoot(p); });
  });
  el.addSubRoot.addEventListener('click', function () {
    if (browseDir && fs.existsSync(browseDir)) setRoot(browseDir);
    else flash('当前无浏览目录');
  });
  el.rootSel.addEventListener('change', function () {
    currentRoot = el.rootSel.value || '';
    if (currentRoot) { saveCur(currentRoot); browseDir = currentRoot; renderNav(); renderFiles(browseDir); }
    else { el.tree.innerHTML = '<div class="hint" style="padding:8px;">设根后浏览</div>'; el.files.innerHTML = ''; }
  });

  // ===== 目录 =====
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
  function dirName(p) {
    var b = path.basename(p);
    return b || p;
  }

  function renderNav() {
    var dir = browseDir;
    el.tree.innerHTML = '';
    // 面包屑
    var crumb = document.createElement('div');
    crumb.className = 'md-crumb';
    function pushCrumb(label, full, isLast) {
      var sp = document.createElement('span');
      sp.className = 'md-crumb-item' + (isLast ? ' cur' : '');
      sp.textContent = label;
      sp.title = full;
      if (!isLast) sp.addEventListener('click', function () { browseDir = full; renderNav(); renderFiles(full); });
      crumb.appendChild(sp);
      if (!isLast) { var sep = document.createElement('span'); sep.textContent = ' › '; crumb.appendChild(sep); }
    }
    if (dir === currentRoot) {
      pushCrumb(dirName(currentRoot) || currentRoot, currentRoot, true);
    } else {
      pushCrumb(dirName(currentRoot), currentRoot, false);
      var rel = path.relative(currentRoot, dir);
      var parts = rel.split(path.sep);
      var acc = currentRoot;
      parts.forEach(function (pp, idx) {
        acc = path.join(acc, pp);
        pushCrumb(pp, acc, idx === parts.length - 1);
      });
    }
    el.tree.appendChild(crumb);

    if (dir !== currentRoot) {
      var parent = path.dirname(dir);
      var upRow = document.createElement('div');
      upRow.className = 'md-tree-item md-up';
      upRow.textContent = '⬆ 上级';
      upRow.title = parent;
      upRow.addEventListener('click', function () { if (fs.existsSync(parent)) { browseDir = parent; renderNav(); renderFiles(parent); } });
      el.tree.appendChild(upRow);
    }
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
      row.addEventListener('click', function () { browseDir = full; renderNav(); renderFiles(full); });
      wrap.appendChild(row);
    });
    el.tree.appendChild(wrap);
  }

  // ===== 文件列表（支持多选）=====
  function renderFiles(dir) {
    var files = listFiles(dir);
    el.files.innerHTML = '';
    if (!files.length) {
      el.files.innerHTML = '<div class="hint" style="padding:10px;">该目录无媒体文件</div>';
      updateSelCount();
      return;
    }
    var cap = document.createElement('div');
    cap.className = 'md-fcap';
    cap.textContent = files.length + ' 个媒体 · 点选导入 / 双击定位';
    el.files.appendChild(cap);

    var listWrap = document.createElement('div');
    listWrap.style.cssText = 'overflow-y:auto;flex:1;min-height:0;';
    files.forEach(function (f) {
      var full = path.join(dir, f);
      var ext = path.extname(f).toLowerCase().slice(1);
      var icon = { mp4: '🎬', mov: '🎬', mxf: '🎬', avi: '🎬', m4v: '🎬', webm: '🎬', mts: '🎬', m2ts: '🎬', wav: '🔊', mp3: '🎵', aiff: '🔊', aac: '🎵', flac: '🎵', png: '🖼', jpg: '🖼', jpeg: '🖼', webp: '🖼', gif: '🖼', srt: '📝' }[ext] || '📄';
      var row = document.createElement('div');
      row.className = 'md-file' + (selFiles[full] ? ' sel' : '');
      row.innerHTML = '<span class="md-ic">' + icon + '</span><span class="md-fn"></span><span class="md-check"></span>';
      row.querySelector('.md-fn').textContent = f;
      row.title = full;
      // 预览按钮（视频/音频/图片）
      if (/^(mp4|mov|mxf|avi|m4v|webm|wav|mp3|aiff|aac|flac|png|jpg|jpeg|webp|gif)$/i.test(ext)) {
        var pb = document.createElement('button');
        pb.type = 'button';
        pb.textContent = '👁';
        pb.title = '预览';
        pb.style.cssText = 'flex:0 0 auto;background:none;border:1px solid var(--border);border-radius:3px;color:#7fd68b;font-size:10px;padding:0 4px;cursor:pointer;line-height:15px;';
        pb.addEventListener('click', function (ev2) {
          ev2.stopPropagation();
          openPreview(full, f);
        });
        pb.addEventListener('dblclick', function (ev2) { ev2.stopPropagation(); });
        row.appendChild(pb);
      }
      row.addEventListener('click', function (ev) {
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
          if (ev.shiftKey) { flash('Shift 多选暂用 Ctrl 逐个'); return; }
          if (selFiles[full]) delete selFiles[full]; else selFiles[full] = true;
          row.classList.toggle('sel', !!selFiles[full]);
          updateSelCount();
        } else {
          // 单击：清空其它，仅选当前（防止误导入）——单击不导入，需点「导入选中」或双击
          // 为保留旧习惯「单击即导入」，此处改为单击选中，双击导入+定位
          Object.keys(selFiles).forEach(function (k) { delete selFiles[k]; });
          selFiles[full] = true;
          var rows = listWrap.querySelectorAll('.md-file');
          rows.forEach(function (r2) { r2.classList.remove('sel'); });
          row.classList.add('sel');
          updateSelCount();
        }
      });
      row.addEventListener('dblclick', function () {
        var bin = (el.binName.value || '').trim() || '素材';
        if (confirmProject()) importList([full], bin, '导入 ' + f);
      });
      listWrap.appendChild(row);
    });
    el.files.appendChild(listWrap);
    updateSelCount();
  }

  function updateSelCount() {
    var n = Object.keys(selFiles).length;
    if (el.impSel) el.impSel.textContent = '⬇ 导入选中(' + n + ')';
  }
  function clearSel() {
    selFiles = {};
    var rows = el.files.querySelectorAll('.md-file');
    rows.forEach(function (r) { r.classList.remove('sel'); });
    updateSelCount();
  }

  // ===== 预览浮层（视频/音频/图片）=====
  var previewOverlay = null;
  function openPreview(full, name) {
    try {
      if (previewOverlay) closePreview();
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:10002;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;';
      var box = document.createElement('div');
      box.style.cssText = 'background:#111;border:1px solid #333;border-radius:8px;padding:8px 10px;max-width:92%;';
      var ttl = document.createElement('div');
      ttl.style.cssText = 'font-size:11px;color:#ccc;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px;';
      ttl.textContent = name;
      box.appendChild(ttl);
      var ext = path.extname(full).toLowerCase().slice(1);
      var fileUrl = 'file:///' + full.replace(/\\/g, '/');
      if (/^(png|jpg|jpeg|webp|gif|bmp)$/i.test(ext)) {
        var img = document.createElement('img');
        img.src = fileUrl;
        img.style.cssText = 'max-width:360px;max-height:60vh;border-radius:4px;';
        box.appendChild(img);
      } else if (/^(mp4|mov|m4v|webm)$/i.test(ext)) {
        var vd = document.createElement('video');
        vd.controls = true;
        vd.src = fileUrl;
        vd.style.cssText = 'max-width:420px;max-height:55vh;';
        box.appendChild(vd);
      } else if (/^(wav|mp3|aiff|aac|flac)$/i.test(ext)) {
        var ad = document.createElement('audio');
        ad.controls = true;
        ad.src = fileUrl;
        ad.style.cssText = 'width:360px;';
        box.appendChild(ad);
      } else {
        var tx = document.createElement('div');
        tx.textContent = full;
        tx.style.cssText = 'color:#999;font-size:12px;max-width:380px;word-break:break-all;';
        box.appendChild(tx);
      }
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:8px;';
      var openB = document.createElement('button');
      openB.type = 'button';
      openB.textContent = '📂 定位';
      openB.style.cssText = 'background:#2a4a2a;color:#7fd68b;border:none;border-radius:4px;padding:3px 12px;cursor:pointer;font-size:11px;';
      openB.addEventListener('click', function () { try { require('child_process').exec('explorer /select,"' + full + '"', { windowsHide: true }); } catch (e) {} });
      row.appendChild(openB);
      var impB = document.createElement('button');
      impB.type = 'button';
      impB.textContent = '⬇ 导入素材箱';
      impB.style.cssText = 'background:#3a2e52;color:#e6d9ff;border:none;border-radius:4px;padding:3px 12px;cursor:pointer;font-size:11px;';
      impB.addEventListener('click', function () {
        var bin = (el.binName.value || '').trim() || '素材';
        if (confirmProject()) { importList([full], bin, '导入 ' + path.basename(full)); closePreview(); }
      });
      row.appendChild(impB);
      var clB = document.createElement('button');
      clB.type = 'button';
      clB.textContent = '关闭';
      clB.style.cssText = 'background:#3a3a3a;color:#ccc;border:none;border-radius:4px;padding:3px 12px;cursor:pointer;font-size:11px;';
      clB.addEventListener('click', closePreview);
      row.appendChild(clB);
      box.appendChild(row);
      ov.appendChild(box);
      ov.addEventListener('mousedown', function (e) { if (e.target === ov) closePreview(); });
      document.body.appendChild(ov);
      previewOverlay = ov;
      // 自动播放（音视频）
      if (vd) { try { var pp = vd.play(); if (pp && pp.catch) pp.catch(function () {}); } catch (e) {} }
      if (ad) { try { var pp2 = ad.play(); if (pp2 && pp2.catch) pp2.catch(function () {}); } catch (e) {} }
    } catch (e) { flash('预览失败：' + e.message); }
  }
  function closePreview() {
    try {
      if (previewOverlay) {
        var ms = previewOverlay.querySelectorAll('video,audio');
        ms.forEach(function (m) { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {} });
        if (previewOverlay.parentNode) previewOverlay.parentNode.removeChild(previewOverlay);
      }
    } catch (e) {}
    previewOverlay = null;
  }

  // ===== 进度条 =====
  function setProg(pct, txt) {
    if (!el.progWrap) return;
    el.progWrap.style.display = 'block';
    el.progFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (el.progText) el.progText.textContent = txt || '';
    if (el.progPct) el.progPct.textContent = Math.round(pct) + '%';
  }
  function hideProg() {
    if (el.progWrap) { setTimeout(function () { el.progWrap.style.display = 'none'; }, 2500); }
  }

  // ===== 导入 =====
  // 逐文件导入（分小批避免单次 eval 过大），带进度
  function importList(filePaths, binName, label) {
    if (importing) { flash('正在导入中…'); return; }
    if (!filePaths.length) return;
    importing = true;
    setProg(0, label + '…');
    var done = 0, okN = 0, failN = 0, fails = [];
    var BATCH = 20;
    function nextBatch() {
      var batch = filePaths.slice(done, done + BATCH);
      if (!batch.length) { finish(); return; }
      // 分批调 host meImportFilesToBinStr
      var payload = JSON.stringify({ files: batch, binName: binName });
      csInterface.evalScript('meImportPayload = ' + payload + ';', function () {
        csInterface.evalScript('meImportFilesToBinStr()', function (r) {
          try {
            var j = JSON.parse(r);
            if (j && j.ok) {
              okN += (j.imported || []).length;
              (j.failed || []).forEach(function (x) { fails.push(x); failN++; });
            } else { failN += batch.length; fails.push((j && j.error) || '批失败'); }
          } catch (e) { failN += batch.length; fails.push('解析失败'); }
          done += batch.length;
          var pct = Math.min(100, Math.round(done / filePaths.length * 100));
          setProg(pct, label + ' ' + done + '/' + filePaths.length);
          setTimeout(nextBatch, 60);
        });
      });
    }
    function finish() {
      importing = false;
      hideProg();
      clearSel();
      var msg = '✅ 导入完成：成功 ' + okN + '，失败 ' + failN;
      flash(msg);
      // 汇总详情
      var detail = fails.slice(0, 8).join('\n');
      window.confirm(msg + (detail ? '\n\n' + detail + (fails.length > 8 ? '\n…' : '') : ''));
    }
    nextBatch();
  }

  // 整个文件夹递归导入（保留结构）
  function importFolderTree(folderPath, binName) {
    if (importing) { flash('正在导入中…'); return; }
    importing = true;
    setProg(5, '扫描并导入文件夹…');
    var payload = JSON.stringify({ folderPath: folderPath, binName: binName });
    csInterface.evalScript('meImportPayload = ' + payload + ';', function () {
      csInterface.evalScript('meImportFolderTreeStr()', function (r) {
        importing = false;
        hideProg();
        try {
          var j = JSON.parse(r);
          if (j && j.ok) {
            var s = j.stats || {};
            var msg = '✅ 文件夹导入完成：成功 ' + s.ok + ' / ' + s.files + (s.fail ? '，失败 ' + s.fail : '');
            flash(msg);
            var det = (j.failed || []).slice(0, 8).join('\n');
            window.confirm(msg + (det ? '\n\n' + det : ''));
          } else {
            flash('⚠ 导入失败：' + ((j && j.error) || '未知'));
            window.confirm('文件夹导入失败：' + ((j && j.error) || '未知'));
          }
        } catch (e) {
          flash('⚠ 导入失败');
          window.confirm('导入失败：' + e.message);
        }
      });
    });
  }

  // ===== 事件 =====
  el.selAll.addEventListener('click', function () {
    var rows = el.files.querySelectorAll('.md-file');
    var cbs = el.files.querySelectorAll('.md-fn');
    cbs.forEach(function (fn, idx) { var row = rows[idx]; if (row) { var full = row.title; selFiles[full] = true; row.classList.add('sel'); } });
    updateSelCount();
  });
  el.selNone.addEventListener('click', clearSel);
  el.impSel.addEventListener('click', function () {
    var paths = Object.keys(selFiles);
    if (!paths.length) { flash('请先勾选文件'); return; }
    if (!confirmProject()) return;
    var bin = (el.binName.value || '').trim() || '素材';
    importList(paths, bin, '导入 ' + paths.length + ' 个文件');
  });
  el.impFolder.addEventListener('click', function () {
    if (!browseDir) { flash('先在左侧选择目录'); return; }
    if (!confirmProject()) return;
    var bin = (el.binName.value || '').trim() || '素材';
    importFolderTree(browseDir, bin);
  });

  // ===== 初始化 =====
  window.__mediaOnShow = function () { refreshProjInfo(); if (!el.tree.innerHTML.trim() || !currentRoot) renderRootSel(); };
  renderRootSel();
  refreshProjInfo();
})();
