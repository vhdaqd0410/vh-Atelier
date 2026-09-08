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
    selAll: null,
    selNone: null,
    impSel: document.getElementById('mdImpSel'),
    impFolder: document.getElementById('mdImpFolder'),
    progWrap: null,
    progFill: null,
    progText: null,
    progPct: null,
    tree: document.getElementById('mdTree'),
    files: document.getElementById('mdDetail'),
    detail: document.getElementById('mdDetail')
  };
  el.files = el.detail;
  if (!el.tree) return;

  var ROOTS_KEY = 'vh_media_roots';
  var CUR_KEY = 'vh_media_cur';
  var PROJ_KEY = 'vh_media_lastproj';
  var MEDIA_EXT = /\.(mp4|mov|mxf|avi|m4v|webm|mts|m2ts|wav|aiff|mp3|aac|flac|png|jpg|jpeg|webp|gif|bmp|srt)$/i;
  var DOC_EXT = /\.(prproj|docx|pdf|epr|prel|psd|txt|json|aep|pproj|aepx|mogrt|prfpset)$/i;   // 文档/工程/预设类（提供打开动作）
  function fileKind(name) {
    var e = path.extname(name || '').toLowerCase().slice(1);
    if (/^(mp4|mov|mxf|avi|m4v|webm|mts|m2ts)$/i.test(e)) return 'video';
    if (/^(wav|mp3|aiff|aac|flac)$/i.test(e)) return 'audio';
    if (/^(png|jpg|jpeg|webp|gif|bmp)$/i.test(e)) return 'image';
    if (/^(prproj|pproj)$/i.test(e)) return 'prproj';
    if (/^docx$/i.test(e)) return 'docx';
    if (/^pdf$/i.test(e)) return 'pdf';
    if (/^(epr|prel|prfpset|mogrt)$/i.test(e)) return 'preset';
    if (/^(aep|aepx)$/i.test(e)) return 'ae';
    if (/^psd$/i.test(e)) return 'psd';
    if (/^(srt|txt|json)$/i.test(e)) return 'text';
    return '';
  }

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
    var oPC = document.createElement('option');
    oPC.value = 'COMPUTER';
    oPC.textContent = '💻 我的电脑（全部磁盘）';
    el.rootSel.appendChild(oPC);
    roots.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r;
      o.textContent = r;
      el.rootSel.appendChild(o);
    });
    var cur = loadCur();
    if (cur === 'COMPUTER' || !cur || roots.indexOf(cur) < 0) el.rootSel.value = 'COMPUTER';
    else el.rootSel.value = cur;
    currentRoot = el.rootSel.value || 'COMPUTER';
    if (currentRoot === 'COMPUTER') { browseDir = 'COMPUTER'; renderNav(); if (el.detail) el.detail.innerHTML = '<div class="hint" style="padding:10px;">选择磁盘开始浏览</div>'; }
    else { browseDir = currentRoot; renderNav(); showDirDetail(browseDir); }
  }
  function setRoot(p) {
    if (!p || p === 'COMPUTER') return;
    if (!fs.existsSync(p)) return;
    var roots = loadRoots();
    if (roots.indexOf(p) < 0) roots.push(p);
    saveRoots(roots);
    currentRoot = p;
    browseDir = p;
    saveCur(p);
    renderRootSel();
    el.rootSel.value = p;
    renderNav();
    showDirDetail(p);
  }

  el.addRoot.addEventListener('click', function () {
    pickFolder(el.rootSel.value || '', '选择素材根目录', function (p) { if (p) setRoot(p); });
  });
  el.addSubRoot.addEventListener('click', function () {
    if (browseDir && fs.existsSync(browseDir)) setRoot(browseDir);
    else flash('当前无浏览目录');
  });
  el.rootSel.addEventListener('change', function () {
    currentRoot = el.rootSel.value || 'COMPUTER';
    saveCur(currentRoot);
    if (currentRoot === 'COMPUTER') { browseDir = 'COMPUTER'; renderNav(); if (el.detail) el.detail.innerHTML = '<div class="hint" style="padding:10px;">选择磁盘开始浏览</div>'; }
    else if (currentRoot) { browseDir = currentRoot; renderNav(); showDirDetail(browseDir); }
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
        .filter(function (n) { return MEDIA_EXT.test(n) || DOC_EXT.test(n); })
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
    if (dir === 'COMPUTER') { renderComputerNav(); return; }
    if (dir) { try { localStorage.setItem('mdCurDir', dir); } catch (e) {} }
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
    var files = listFiles(dir);
    var wrap = document.createElement('div');
    wrap.className = 'md-subwrap';
    if (!subs.length && !files.length) wrap.innerHTML = '<div style="padding:6px 4px;font-size:11px;color:var(--muted);">空目录</div>';
    subs.forEach(function (s) {
      var full = path.join(dir, s);
      var row = document.createElement('div');
      row.className = 'md-tree-item md-subdir';
      row.textContent = '📁 ' + s;
      row.title = full + '\n点击进入';
      row.addEventListener('click', function () { browseDir = full; renderNav(); showDirDetail(full); });
      wrap.appendChild(row);
    });
    files.forEach(function (fn) {
      var full = path.join(dir, fn);
      var leaf = makeFileLeaf(full, fn, dir);
      if (leaf) wrap.appendChild(leaf);
    });
    el.tree.appendChild(wrap);
  }
  // 「我的电脑」虚拟浏览：列本机盘符
  function listDrives() {
    var out = [];
    for (var i = 0; i < 26; i++) {
      var d = String.fromCharCode(65 + i) + ':/';
      try { if (fs.existsSync(d)) out.push(d); } catch (e) {}
    }
    return out;
  }
  function renderComputerNav() {
    if (!el.tree) return;
    el.tree.innerHTML = '';
    var crumb = document.createElement('div');
    crumb.className = 'md-crumb';
    var sp = document.createElement('span');
    sp.className = 'md-crumb-item cur';
    sp.textContent = '💻 我的电脑';
    crumb.appendChild(sp);
    el.tree.appendChild(crumb);
    var drives = listDrives();
    var wrap = document.createElement('div');
    wrap.className = 'md-subwrap';
    if (!drives.length) wrap.innerHTML = '<div style="padding:6px;font-size:11px;color:var(--muted);">未检测到磁盘</div>';
    drives.forEach(function (d) {
      var row = document.createElement('div');
      row.className = 'md-tree-item md-subdir';
      row.textContent = '💽 ' + d;
      row.title = d;
      row.addEventListener('click', function () { browseDir = d; renderNav(); showDirDetail(d); });
      wrap.appendChild(row);
    });
    el.tree.appendChild(wrap);
    if (el.detail) el.detail.innerHTML = '<div class="hint" style="padding:10px;">选择磁盘开始浏览</div>';
  }

  // ===== 文件列表（支持多选）=====
  // 右侧：目录详情（左树点目录时）
  function showDirDetail(dir) {
    if (!el.detail) return;
    el.detail.innerHTML = '';
    var files = listFiles(dir);
    var subs = listDirs(dir);
    var ttl = document.createElement('div');
    ttl.className = 'md-fcap';
    ttl.textContent = (subs.length ? subs.length + ' 文件夹 · ' : '') + files.length + ' 文件';
    el.detail.appendChild(ttl);
    var info = document.createElement('div');
    info.style.cssText = 'font-size:10px;color:var(--muted);word-break:break-all;padding:2px 4px 6px;';
    info.textContent = dir;
    el.detail.appendChild(info);
    if (!files.length && !subs.length) {
      el.detail.innerHTML += '<div class="hint" style="padding:8px;">空目录</div>';
      return;
    }
    var tip = document.createElement('div');
    tip.style.cssText = 'font-size:10px;color:var(--muted);padding:2px 4px;';
    tip.textContent = '💡 左侧点选文件看详情；拖拽文件可直接放入 PR 项目/时间线。';
    el.detail.appendChild(tip);
    var bf = document.createElement('button');
    bf.type = 'button';
    bf.textContent = '📁 导入整个目录';
    bf.className = 'secondary mini';
    bf.style.cssText = 'margin-top:6px;color:#7fd68b;border-color:#2a5a3a;';
    bf.addEventListener('click', function () { if (confirmProject()) importFolderTree(dir, (el.binName.value || '').trim() || '素材'); });
    el.detail.appendChild(bf);
  }
  // 左树文件叶子：构建一个可拖拽/可点的文件行（缩进样式由 CSS .md-leaf 控制）
  function makeFileLeaf(full, name, dir) {
    var ext = path.extname(name).toLowerCase().slice(1);
    var kind = fileKind(name);
    var icon = { mp4: '🎬', mov: '🎬', mxf: '🎬', avi: '🎬', m4v: '🎬', webm: '🎬', mts: '🎬', m2ts: '🎬', wav: '🔊', mp3: '🎵', aiff: '🔊', aac: '🎵', flac: '🎵', png: '🖼', jpg: '🖼', jpeg: '🖼', webp: '🖼', gif: '🖼', srt: '📝' }[ext] || (kind === 'prproj' ? '🎬PR' : kind === 'docx' ? '📄' : kind === 'pdf' ? '📕' : kind === 'preset' ? '⚙️' : kind === 'psd' ? '🎨' : kind === 'ae' ? '✨' : kind === 'text' ? '📝' : '📄');
    var isMedia = ['video', 'audio', 'image'].indexOf(kind) >= 0;
    var row = document.createElement('div');
    row.className = 'md-file md-leaf' + (selFiles[full] ? ' sel' : '');
    row.innerHTML = '<span class="md-ic">' + icon + '</span><span class="md-fn"></span>';
    row.querySelector('.md-fn').textContent = name;
    row.title = full;
    row.draggable = true;
    row.addEventListener('dragstart', function (ev) {
      try { ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', full); ev.dataTransfer.setData('text/plain', full); ev.dataTransfer.effectAllowed = 'copy'; } catch (e) {}
    });
    row.addEventListener('dragend', function () { closePreview(); });
    row.addEventListener('click', function (ev) {
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) {
        if (selFiles[full]) delete selFiles[full]; else selFiles[full] = true;
        row.classList.toggle('sel', !!selFiles[full]);
        updateSelCount();
        return;
      }
      Object.keys(selFiles).forEach(function (k) { delete selFiles[k]; });
      selFiles[full] = true;
      var all = el.tree.querySelectorAll('.md-file');
      all.forEach(function (r) { r.classList.remove('sel'); });
      row.classList.add('sel');
      updateSelCount();
      showFileDetail(full, name, kind, isMedia);
      if (isMedia) openPreview(full, name);
    });
    row.addEventListener('dblclick', function () {
      if (isMedia) { var bin = (el.binName.value || '').trim() || '素材'; if (confirmProject()) importList([full], bin, '导入 ' + name); }
      else { openWithSystem(full); }
    });
    return row;
  }
  // 右侧：文件详情
  function showFileDetail(full, name, kind, isMedia) {
    if (!el.detail) return;
    el.detail.innerHTML = '';
    var ttl = document.createElement('div');
    ttl.className = 'md-fcap';
    ttl.textContent = name;
    el.detail.appendChild(ttl);
    try {
      var st = fs.statSync(full);
      var sz = st.size;
      var szTxt = sz < 1048576 ? Math.round(sz / 1024) + ' KB' : (sz / 1048576).toFixed(2) + ' MB';
      var meta = document.createElement('div');
      meta.style.cssText = 'font-size:10px;color:var(--muted);white-space:pre-wrap;word-break:break-all;line-height:1.6;padding:2px 4px;';
      meta.textContent = '类型: ' + (kind || '未知') + '\n大小: ' + szTxt + '\n修改: ' + (st.mtime ? st.mtime.toLocaleString() : '') + '\n路径: ' + full;
      el.detail.appendChild(meta);
    } catch (e) {}
    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;';
    if (isMedia) {
      var b1 = document.createElement('button'); b1.type='button'; b1.textContent='👁 预览'; b1.className='secondary mini';
      b1.addEventListener('click', function () { openPreview(full, name); }); btns.appendChild(b1);
      var b2 = document.createElement('button'); b2.type='button'; b2.textContent='⬇ 导入素材箱'; b2.className='secondary mini';
      b2.style.cssText='color:#7fd68b;border-color:#2a5a3a;';
      b2.addEventListener('click', function () { var bin=(el.binName.value||'').trim()||'素材'; if(confirmProject()) importList([full],bin,'导入 '+name); }); btns.appendChild(b2);
    } else if (kind === 'docx' || kind === 'pdf') {
      var bd = document.createElement('button'); bd.type='button'; bd.textContent='📖 剧本阅读'; bd.className='secondary mini';
      bd.addEventListener('click', function () { if (window.__openDocxByPath) window.__openDocxByPath(full); else openWithSystem(full); }); btns.appendChild(bd);
    } else {
      var bo = document.createElement('button'); bo.type='button'; bo.textContent='▶ 打开'; bo.className='secondary mini';
      bo.addEventListener('click', function () { openWithSystem(full); }); btns.appendChild(bo);
    }
    var b3 = document.createElement('button'); b3.type='button'; b3.textContent='📂 定位'; b3.className='secondary mini';
    b3.addEventListener('click', function () { try { require('child_process').exec('explorer /select,"' + full + '"', { windowsHide: true }); } catch (e) {} });
    btns.appendChild(b3);
    el.detail.appendChild(btns);
  }
  // 兼容旧调用：renderFiles(dir) → 显示目录详情
  function renderFiles(dir) { showDirDetail(dir); }

  function insertToTimeline(full, name) {
    try {
      csInterface.evalScript('sfxGetPlayerPosition()', function (posResult) {
        var posSec = 0;
        try { var pr = JSON.parse(posResult); posSec = pr.positionSec || 0; } catch (e) {}
        var payload = JSON.stringify({ path: full, positionSec: posSec });
        csInterface.evalScript('meInsertPayload = ' + payload + ';', function () {
          csInterface.evalScript('meInsertMediaToTimeline()', function (result) {
            try {
              var d = JSON.parse(result);
              if (d && d.ok) {
                var who = path.basename(full);
                flash('⏩ 已插入时间线 @ ' + Math.round(posSec) + 's：' + who);
                window.__copyFlash ? window.__copyFlash('已插入时间线：' + who) : null;
              } else {
                flash('插入失败：' + ((d && d.error) || result));
              }
            } catch (e) { flash('插入失败：' + result); }
          });
        });
      });
    } catch (e) { flash('插入异常：' + e.message); }
  }

  function openWithSystem(full) {
    try { require('child_process').exec('start "" "' + full + '"', { windowsHide: true }); }
    catch (e) { flash('打开失败'); }
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

  // ===== 导入弹窗（进度模态 + 结果模态）=====
  var importModal = null;
  function showImportModal(title, showBar) {
    closeImportModal();
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10010;display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--panel,#242424);border:1px solid var(--border,#444);border-radius:10px;width:340px;max-width:90vw;padding:16px 18px;box-shadow:0 8px 30px rgba(0,0,0,.5);';
    var ttl = document.createElement('div');
    ttl.style.cssText = 'font-size:13px;font-weight:600;color:var(--text);margin-bottom:10px;';
    ttl.textContent = title || '';
    box.appendChild(ttl);
    var barWrap = document.createElement('div');
    if (showBar) {
      barWrap.style.cssText = 'height:10px;background:#1a1a1a;border-radius:5px;overflow:hidden;margin:6px 0;';
      var bar = document.createElement('div');
      bar.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#3d9a50,#7fd68b);border-radius:5px;transition:width .2s;';
      barWrap.appendChild(bar);
    }
    box.appendChild(barWrap);
    var txt = document.createElement('div');
    txt.style.cssText = 'font-size:12px;color:var(--muted);line-height:1.7;margin-top:6px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;user-select:text;';
    box.appendChild(txt);
    ov.appendChild(box);
    document.body.appendChild(ov);
    importModal = { ov: ov, box: box, bar: barWrap.firstChild, txt: txt };
    return importModal;
  }
  function setModalProgress(pct, text) {
    if (!importModal) return;
    try { if (importModal.bar) importModal.bar.style.width = Math.max(0, Math.min(100, pct)) + '%'; } catch (e) {}
    if (text) importModal.txt.textContent = text;
  }
  function showResultModal(title, detail) {
    if (importModal) { try { importModal.ov.parentNode && importModal.ov.parentNode.removeChild(importModal.ov); } catch (e) {} importModal = null; }
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10011;display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--panel,#242424);border:1px solid var(--border,#444);border-radius:10px;width:360px;max-width:90vw;padding:16px 18px;box-shadow:0 8px 30px rgba(0,0,0,.5);';
    var ttl = document.createElement('div');
    ttl.style.cssText = 'font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;';
    ttl.textContent = title || '';
    box.appendChild(ttl);
    var txt = document.createElement('div');
    txt.style.cssText = 'font-size:12px;color:var(--muted);line-height:1.7;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow-y:auto;user-select:text;';
    txt.textContent = detail || '';
    box.appendChild(txt);
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = '知道了';
    okBtn.style.cssText = 'display:block;margin:12px auto 0;background:var(--accent,#7e57c2);color:#fff;border:none;border-radius:6px;padding:6px 26px;cursor:pointer;font-size:12px;';
    okBtn.addEventListener('click', function () { if (ov.parentNode) ov.parentNode.removeChild(ov); });
    box.appendChild(okBtn);
    ov.appendChild(box);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) { if (ov.parentNode) ov.parentNode.removeChild(ov); } });
    document.body.appendChild(ov);
  }
  function closeImportModal() {
    if (importModal) { try { if (importModal.ov.parentNode) importModal.ov.parentNode.removeChild(importModal.ov); } catch (e) {} importModal = null; }
  }
  // 共享给其它板块（progress 面板导入等）
  window.__vhImportModal = {
    progress: function (pct, text) { setModalProgress(pct, text); },
    open: function (title) { showImportModal(title, true); },
    result: function (title, detail) { showResultModal(title, detail); },
    close: function () { closeImportModal(); }
  };

  // 逐文件导入（分批调 host，模态进度）
  function importList(filePaths, binName, label) {
    if (importing) { flash('正在导入中…'); return; }
    if (!filePaths.length) return;
    importing = true;
    var md = showImportModal(label || '导入中…', true);
    var done = 0, okN = 0, failN = 0, fails = [];
    var BATCH = 20;
    setModalProgress(0, '准备中…');
    function nextBatch() {
      var batch = filePaths.slice(done, done + BATCH);
      if (!batch.length) { finish(); return; }
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
          setModalProgress(pct, '已处理 ' + done + '/' + filePaths.length);
          setTimeout(nextBatch, 60);
        });
      });
    }
    function finish() {
      importing = false;
      closeImportModal();
      clearSel();
      var det = fails.length ? '失败明细：\n' + fails.slice(0, 10).join('\n') + (fails.length > 10 ? '\n…共 ' + fails.length + ' 个失败' : '') : '全部成功';
      showResultModal('✅ 导入完成', '成功 ' + okN + ' 个\n失败 ' + failN + ' 个\n\n' + det);
    }
    nextBatch();
  }

  // 文件夹递归导入（前端算 plan → host meImportTreePlanStr，保留 UTF-8 目录结构）
  function importFolderTree(folderPath, binName) {
    if (importing) { flash('正在导入中…'); return; }
    importing = true;
    var md = showImportModal('导入文件夹：' + path.basename(folderPath), true);
    setModalProgress(2, '扫描目录…');
    // 前端递归收集：groups = [{ relPath:[子目录...], files:[绝对路径] }]
    var groups = [];
    function walk(dir, relArr) {
      var files = [], subDirs = [];
      try {
        var ents = fs.readdirSync(dir, { withFileTypes: true });
        ents.forEach(function (en) {
          if (en.name.charAt(0) === '.') return;
          var full = path.join(dir, en.name);
          if (en.isDirectory()) subDirs.push(en.name);
          else if (MEDIA_EXT.test(en.name)) files.push(full);
        });
      } catch (e) {}
      if (files.length) groups.push({ relPath: relArr.slice(), files: files });
      subDirs.forEach(function (sd) { walk(path.join(dir, sd), relArr.concat([sd])); });
    }
    walk(folderPath, []);
    setModalProgress(8, '扫描完成，共 ' + groups.length + ' 组，开始导入…');
    if (!groups.length) { importing = false; closeImportModal(); showResultModal('导入完成', '该目录没有可导入的媒体文件'); return; }
    var totalFiles = 0;
    groups.forEach(function (g) { totalFiles += g.files.length; });
    var doneF = 0, okN = 0, failN = 0, fails = [];
    var BATCH = 15;
    function pushBatch() {
      // 组装 plan 中未处理的部分（分批太细会多次 host 调用建 bin 重复）
      // 简化：整个 plan 一次交给 host（目录/文件多时可分批按组）
      var payload = JSON.stringify({ binName: binName, groups: groups });
      csInterface.evalScript('meImportPayload = ' + payload + ';', function () {
        csInterface.evalScript('meImportTreePlanStr()', function (r) {
          importing = false;
          try {
            var j = JSON.parse(r);
            if (j && j.ok) {
              var s = j.stats || {};
              okN = s.ok || 0; failN = s.fail || 0; fails = j.failed || [];
              setModalProgress(100, '');
              setTimeout(function () {
                closeImportModal();
                var det = fails.length ? '失败明细：\n' + fails.slice(0, 10).join('\n') + (fails.length > 10 ? '\n…共 ' + fails.length + ' 个失败' : '') : '全部成功';
                showResultModal('✅ 文件夹导入完成', '成功 ' + okN + ' 个\n失败 ' + failN + ' 个\n\n' + det);
              }, 300);
            } else {
              closeImportModal();
              showResultModal('⚠ 导入失败', (j && j.error) || '未知错误');
            }
          } catch (e) {
            closeImportModal();
            showResultModal('⚠ 导入失败', e.message);
          }
        });
      });
    }
    pushBatch();
  }

  // ===== 事件 =====
  if (el.selAll) el.selAll.addEventListener('click', function () {
    var rows = el.files.querySelectorAll('.md-file');
    rows.forEach(function (row) { var full = row.title || ''; if (full) { selFiles[full] = true; row.classList.add('sel'); } });
    updateSelCount();
  });
  if (el.selNone) el.selNone.addEventListener('click', clearSel);
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

  // 恢复上次浏览目录（切面板/重开后保持）
  function restoreLastDir() {
    try {
      var last = localStorage.getItem('mdCurDir') || '';
      if (last && fs.existsSync(last)) { browseDir = last; renderNav(); showDirDetail(last); }
      else if (browseDir && browseDir !== 'COMPUTER') { renderNav(); showDirDetail(browseDir); }
    } catch (e) {}
  }
  // ===== 初始化 =====
  window.__mediaOnShow = function () { refreshProjInfo(); if (!el.tree.innerHTML.trim() || !currentRoot) renderRootSel(); restoreLastDir(); };
  renderRootSel();
  refreshProjInfo();
})();
