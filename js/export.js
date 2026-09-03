/* global require, CSInterface, console */
// vh-Atelier 板块四：多版本交付导出
// 从独立插件 com.delivery.multiexport 整合而来，仅做两处适配：
//   1. Node 环境检查失败时不再覆盖整个 body（否则会毁掉主面板其它板块）
//   2. getSystemPath('extension') 现在指向 vh-Atelier 根目录，jsx 路径不变
(function () {
  var fs, os, path;
  try {
    fs = require('fs');
    os = require('os');
    path = require('path');
  } catch (e) {
    return;
  }

  var csInterface = new CSInterface();
  function evalHost(s) { return new Promise(function (r) { csInterface.evalScript(s, r); }); }

  // ── UI 元素 ──────────────────────────────────
  var seqList = document.getElementById('seq-list');
  var btnSelAll = document.getElementById('btn-sel-all');
  var btnSelNone = document.getElementById('btn-sel-none');
  var versionsWrap = document.getElementById('versions-wrap');
  var btnAddVersion = document.getElementById('btn-add-version');
  var log = document.getElementById('log');
  var btnGo = document.getElementById('btn-go');
  var btnStop = document.getElementById('btn-stop');
  var btnRefresh = document.getElementById('btn-refresh');
  var statusDot = document.getElementById('status-dot');
  var progressArea = document.getElementById('progress-area');
  var progressFill = document.getElementById('progress-fill');
  var progressPct = document.getElementById('progress-pct');
  var progressTime = document.getElementById('progress-time');
  var progressState = document.getElementById('progress-state');
  var deliveryRoot = document.getElementById('delivery-root');
  var btnBrowseRoot = document.getElementById('btn-browse-root');
  var btnAutofill = document.getElementById('btn-autofill');
  var chkManifest = document.getElementById('chk-manifest');
  var chkSubtitle = document.getElementById('chk-subtitle');
  var subtitleDir = document.getElementById('subtitle-dir');
  var btnBrowseSubtitle = document.getElementById('btn-browse-subtitle');
  var tplSelect = document.getElementById('tpl-select');
  var btnTplSave = document.getElementById('btn-tpl-save');
  var btnTplRename = document.getElementById('btn-tpl-rename');
  var btnTplDelete = document.getElementById('btn-tpl-delete');
  var tplTip = document.getElementById('tpl-tip');
  var tplGroup = document.getElementById('tpl-group');

  // ── 全局状态 ──────────────────────────────────
  var stopRequested = false;
  var allSeqs = [];
  var audioTracks = [];
  var allPresets = [];
  var versions = [];     // 交付版本列表（每个版本独立配置）
  var uidSeq = 0;
  var manifest = [];    // 交付清单（运行期收集，导出完生成 CSV）  
  // ── 交付模板状态 ──
  var templates = [];        // [{ id, name, updatedAt, snapshot }]  snapshot = { deliveryRoot, manifest, subtitleEnabled, subtitleDir, versions }
  var activeTplId = '';      // 当前套用的模板 id；'' = 自由配置
  var tplDirty = false;      // 当前配置相对模板是否有改动
  var lastSnapshot = null;   // 套用模板时的快照，用于 dirty 对比// ── 基础 UI 工具 ──────────────────────────────
  function setLog(msg, level) {
    // level: 'info'(默认) | 'success' | 'warn' | 'error' | true(兼容旧代码=error)
    var lv = 'info';
    if (level === true || level === 'err' || level === 'error') lv = 'error';
    else if (level === 'warn' || level === 'warning') lv = 'warn';
    else if (level === 'success' || level === 'ok') lv = 'success';
    var line = document.createElement('div');
    line.className = 'log-line ' + lv;
    var ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = '[' + new Date().toLocaleTimeString() + '] ';
    var body = document.createElement('span');
    body.className = 'log-body';
    body.textContent = msg;
    line.appendChild(ts);
    line.appendChild(body);
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
  function setBusy(b) {
    btnGo.disabled = b;
    btnStop.disabled = !b;
    statusDot.className = b ? 'dot busy' : 'dot on';
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    function pad(x) { return x < 10 ? '0' + x : '' + x; }
    if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
    return pad(m) + ':' + pad(s);
  }
  function setProgress(pct, stateText, elapsedSec, remainSec) {
    pct = Math.max(0, Math.min(100, pct));
    progressFill.style.width = pct + '%';
    progressPct.textContent = Math.round(pct) + '%';
    if (stateText) progressState.textContent = stateText;
    var t = '已用 ' + fmtTime(elapsedSec || 0);
    if (remainSec !== undefined && remainSec !== null) t += ' · 预计剩余 ' + fmtTime(remainSec);
    progressTime.textContent = t;
  }

  // ── 交付清单 ────────────────────────────────
  function fmtSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function fmtDur(sec) {
    if (sec == null || isNaN(sec)) return '';
    sec = Math.round(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + '分' + (s < 10 ? '0' : '') + s + '秒';
  }
  function csvEscape(v) {
    v = String(v == null ? '' : v);
    if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  function buildManifestCsv(rows) {
    var head = ['序列', '版本', '状态', '输出文件', '大小', '时长'];
    var lines = [head.map(csvEscape).join(',')];
    rows.forEach(function (r) {
      lines.push([r.seq, r.version, r.status, r.file, r.size, r.duration].map(csvEscape).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }
  function writeManifest(rows) {
    if (rows.length === 0) return;
    // 清单写在第一个序列第一个版本的输出目录里
    var first = rows[0];
    var dir = '';
    try { if (first.dir) dir = first.dir; } catch (_) {}
    if (!dir) {
      try { var ev = enabledVersions()[0]; if (ev && ev.outDir) dir = ev.outDir; } catch (_) {}
    }
    if (!dir) { setLog('未找到可写目录，交付清单未生成', true); return; }
    var stamp = new Date();
    function p2(x) { return x < 10 ? '0' + x : '' + x; }
    var ts = stamp.getFullYear() + '-' + p2(stamp.getMonth() + 1) + '-' + p2(stamp.getDate()) + '_' + p2(stamp.getHours()) + '-' + p2(stamp.getMinutes());
    var csvPath = path.join(dir, '交付清单_' + ts + '.csv');
    try {
      fs.writeFileSync(csvPath, buildManifestCsv(rows), 'utf8');
      setLog('交付清单已生成：' + csvPath, 'success');
      return csvPath;
    } catch (e) {
      setLog('交付清单生成失败：' + e.message, true);
      return null;
    }
  }

  // ── 扫描 AME 预设目录 ─────────────────────────
  function scanPresets() {
    var presets = [];
    var ameRoot = path.join(os.homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder');
    if (fs.existsSync(ameRoot)) {
      try {
        fs.readdirSync(ameRoot).forEach(function (v) {
          var pdir = path.join(ameRoot, v, 'Presets');
          if (!fs.existsSync(pdir)) return;
          fs.readdirSync(pdir).forEach(function (fn) {
            if (/\.epr$/i.test(fn)) {
              presets.push({ name: fn, dir: pdir, full: path.join(pdir, fn) });
            }
          });
        });
      } catch (_) {}
    }
    return presets;
  }

  function fillPresetSelect(sel, presets, keyword) {
    sel.innerHTML = '';
    presets.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.full;
      o.textContent = p.name;
      sel.appendChild(o);
    });
    if (keyword) {
      presets.forEach(function (p) {
        if (p.name.indexOf(keyword) >= 0) { sel.value = p.full; }
      });
    }
  }

  function refreshPresets() {
    allPresets = scanPresets();
    if (allPresets.length === 0) {
      setLog('未扫描到 AME 导出预设（.epr），请手动输入完整路径', true);
    } else {
      setLog('已扫描到 ' + allPresets.length + ' 个导出预设', 'success');
    }
    return allPresets;
  }

  // ── 从 .epr 推断容器格式后缀 ──────────────────
  function inferExtFromPreset(presetPath) {
    try {
      var raw = fs.readFileSync(presetPath, 'utf8');
      var m = raw.match(/<ExporterFileType>(\d+)<\/ExporterFileType>/);
      if (!m) return 'mp4';
      var code = parseInt(m[1], 10);
      var chars = String.fromCharCode(
        (code >> 24) & 0xff, (code >> 16) & 0xff, (code >> 8) & 0xff, code & 0xff
      );
      var map = {
        'H264': 'mp4', 'h264': 'mp4', 'avc1': 'mp4',
        'HEVC': 'mp4', 'hvc1': 'mp4', 'hev1': 'mp4',
        'MP4 ': 'mp4', 'mp4v': 'mp4',
        'QT  ': 'mov', 'Quick': 'mov',
        'MXF ': 'mxf', 'MXF': 'mxf',
        'AVI ': 'avi',
        'WAVE': 'wav', 'WAV ': 'wav',
        'MP3 ': 'mp3', 'mp3 ': 'mp3'
      };
      return map[chars.trim()] || 'mp4';
    } catch (_) { return 'mp4'; }
  }

  // ── 序列列表 ──────────────────────────────────
  function renderSeqList() {
    seqList.innerHTML = '';
    allSeqs.forEach(function (s) {
      var lab = document.createElement('label');
      lab.className = 'seq-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.name;
      if (/^\d+$/.test(s.name)) cb.checked = true;
      var span = document.createElement('span');
      span.textContent = s.name;
      lab.appendChild(cb);
      lab.appendChild(span);
      seqList.appendChild(lab);
    });
  }
  function getCheckedSeqs() {
    var out = [];
    seqList.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      if (cb.checked) out.push(cb.value);
    });
    return out;
  }
  async function refreshSequences() {
    var r = await evalHost('meListSequences()');
    if (r.indexOf('OK:') !== 0) { setLog('读取序列失败：' + r, true); return; }
    allSeqs = JSON.parse(r.slice(3));
    renderSeqList();
    setLog('已加载 ' + allSeqs.length + ' 个序列', 'success');
  }

  // ── 音轨结构（全局一份，供每个版本的保留列表渲染） ──
  async function refreshAudioTracks() {
    var r = await evalHost('meListAudioTracks()');
    if (r.indexOf('OK:') !== 0) { setLog('读取音轨失败：' + r, true); return; }
    audioTracks = JSON.parse(r.slice(3));
    setLog('已加载 ' + audioTracks.length + ' 条音频轨', 'success');
    renderVersions(); // 音轨结构变了，重渲版本卡片里的保留列表
  }

  // ── 版本数据（持久化到 localStorage） ─────────
  function genId() { return 'v' + (++uidSeq) + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }

  function defaultVersions() {
    return [
      { id: genId(), name: '成片', preset: '', muteMode: 'none', keepList: [0, 1], outDir: '', enabled: true, folderKey: '0' },
      { id: genId(), name: '无字幕', preset: '', muteMode: 'none', keepList: [0, 1], outDir: '', enabled: true, folderKey: '1' },
      { id: genId(), name: '无音乐无字幕', preset: '', muteMode: 'mute', keepList: [0, 1], outDir: '', enabled: true, folderKey: '2' }
    ];
  }
  // 按版本名称推断目录的数字前缀：成片→0、无字幕→1、无音乐无字幕→2
  function inferFolderKey(name) {
    name = name || '';
    if (name.indexOf('无音乐') >= 0 || /bgm/i.test(name)) return '2';
    if (name.indexOf('无字幕') >= 0) return '1';
    if (name.indexOf('成片') >= 0) return '0';
    return '';
  }
  function loadVersions() {
    try {
      var raw = localStorage.getItem('pr_me_versions_v1');
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) {
          arr.forEach(function (v) {
            if (!v.id) v.id = genId();
            if (!v.muteMode) v.muteMode = 'none';
            if (!v.keepList) v.keepList = [0, 1];
            if (!v.outDir) v.outDir = '';
            if (v.enabled === undefined) v.enabled = true;
            if (!v.folderKey) v.folderKey = inferFolderKey(v.name);
          });
          return arr;
        }
      }
    } catch (_) {}
    return defaultVersions();
  }
  function saveVersions() {
    try { localStorage.setItem('pr_me_versions_v1', JSON.stringify(versions)); } catch (_) {}
  }
  function findVersion(id) {
    for (var i = 0; i < versions.length; i++) if (versions[i].id === id) return versions[i];
    return null;
  }

  // ── 交付模板（多套命名配置，方案 A）─────────────────
  // 每套模板 = 完整「交付配置」快照：版本列表 + 交付根目录 + 字幕目录/开关 + 清单开关。
  // 序列勾选属运行时状态（每项目不同），不入模板。
  function snapshotCurrent() {
    return {
      deliveryRoot: deliveryRoot.value.trim() || '',
      manifest: chkManifest.checked,
      subtitleEnabled: chkSubtitle.checked !== false,
      subtitleDir: subtitleDir.value.trim() || '',
      versions: JSON.parse(JSON.stringify(versions))  // 深拷贝
    };
  }

  function applySnapshot(snap) {
    if (!snap) return;
    versions = JSON.parse(JSON.stringify(snap.versions || []));
    deliveryRoot.value = snap.deliveryRoot || '';
    chkManifest.checked = !!snap.manifest;
    chkSubtitle.checked = snap.subtitleEnabled !== false;
    subtitleDir.value = snap.subtitleDir || '';
    saveVersions();
    setDeliveryRoot(deliveryRoot.value);
    setManifestCfg(chkManifest.checked);
    var sc = getSubtitleCfg(); sc.enabled = chkSubtitle.checked; sc.dir = subtitleDir.value; setSubtitleCfg(sc);
    renderVersions();
  }

  var TPL_KEY = 'pr_me_templates_v1';
  function loadTemplates() {
    try {
      var raw = localStorage.getItem(TPL_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && Array.isArray(d.list)) {
          templates = d.list;
          activeTplId = d.activeId || '';
          return;
        }
      }
    } catch (_) {}
    templates = [];
    activeTplId = '';
  }
  function saveTemplates() {
    try {
      localStorage.setItem(TPL_KEY, JSON.stringify({ list: templates, activeId: activeTplId }));
    } catch (_) {}
  }
  function findTemplate(id) {
    for (var i = 0; i < templates.length; i++) if (templates[i].id === id) return templates[i];
    return null;
  }
  function activeTemplate() {
    return activeTplId ? findTemplate(activeTplId) : null;
  }

  function renderTplSelect() {
    // 保留下拉当前选中
    var prev = tplSelect.value;
    tplSelect.innerHTML = '';
    var optFree = document.createElement('option');
    optFree.value = '';
    optFree.textContent = '（自由配置 · 不套模板）';
    tplSelect.appendChild(optFree);
    templates.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.name;
      tplSelect.appendChild(o);
    });
    if (activeTplId && findTemplate(activeTplId)) {
      tplSelect.value = activeTplId;
    } else {
      tplSelect.value = '';
    }
    updateTplTip();
  }

  function updateTplTip() {
    if (!tplTip) return;
    var at = activeTemplate();
    if (!at) {
      tplTip.textContent = '当前为自由配置。改好整套交付参数后，点「另存为模板…」存成命名模板。';
      tplTip.className = 'tpl-tip';
      btnTplRename.disabled = true;
      btnTplDelete.disabled = true;
      return;
    }
    btnTplRename.disabled = false;
    btnTplDelete.disabled = false;
    if (tplDirty) {
      tplTip.textContent = '正在使用模板「' + at.name + '」，配置已改动（未保存到模板）。';
      tplTip.className = 'tpl-tip dirty';
    } else {
      tplTip.textContent = '正在使用模板「' + at.name + '」。改动配置后可点「另存为模板…」更新或另存。';
      tplTip.className = 'tpl-tip on';
    }
  }

  // 采集当前配置快照并对比模板，标记 dirty
  function captureBaseline() {
    var at = activeTemplate();
    if (!at) { tplDirty = false; lastSnapshot = null; updateTplTip(); return; }
    var cur = snapshotCurrent();
    var snap = at.snapshot || {};
    tplDirty = !snapEqual(cur, snap);
    lastSnapshot = cur;
    updateTplTip();
  }

  function snapEqual(a, b) {
    if (!a || !b) return false;
    if (a.deliveryRoot !== b.deliveryRoot) return false;
    if (!!a.manifest !== !!b.manifest) return false;
    if (a.subtitleEnabled !== b.subtitleEnabled) return false;
    if ((a.subtitleDir || '') !== (b.subtitleDir || '')) return false;
    var va = a.versions || [], vb = b.versions || [];
    if (va.length !== vb.length) return false;
    for (var i = 0; i < va.length; i++) {
      if (va[i].name !== vb[i].name) return false;
      if (va[i].preset !== vb[i].preset) return false;
      if (va[i].muteMode !== vb[i].muteMode) return false;
      if (!!va[i].enabled !== !!vb[i].enabled) return false;
      if ((va[i].outDir || '') !== (vb[i].outDir || '')) return false;
      var ka = (va[i].keepList || []).join(','), kb = (vb[i].keepList || []).join(',');
      if (ka !== kb) return false;
    }
    return true;
  }

  // 套用模板：把模板快照刷到 UI
  function applyTemplate(id) {
    var t = findTemplate(id);
    if (!t) return;
    activeTplId = id;
    lastSnapshot = JSON.parse(JSON.stringify(t.snapshot || {}));
    tplDirty = false;
    applySnapshot(lastSnapshot);
    saveTemplates();
    renderTplSelect();
    setLog('已套用交付模板「' + t.name + '」', 'success');
  }

  // 存当前全套配置为模板；若 sameId 提供则覆盖该模板，否则新建
  function saveAsTemplate(name, sameId) {
    var snap = snapshotCurrent();
    if (sameId) {
      var t = findTemplate(sameId);
      if (!t) return null;
      t.name = name;
      t.snapshot = snap;
      t.updatedAt = Date.now();
    } else {
      var nt = { id: 'tpl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6), name: name, updatedAt: Date.now(), snapshot: snap };
      templates.push(nt);
    }
    activeTplId = sameId || (templates.length ? templates[templates.length - 1].id : '');
    lastSnapshot = JSON.parse(JSON.stringify(snap));
    tplDirty = false;
    saveTemplates();
    renderTplSelect();
    return findTemplate(activeTplId);
  }

  function deleteTemplate(id) {
    for (var i = 0; i < templates.length; i++) {
      if (templates[i].id === id) { templates.splice(i, 1); break; }
    }
    if (activeTplId === id) {
      activeTplId = '';
      lastSnapshot = null;
      tplDirty = false;
    }
    saveTemplates();
    renderTplSelect();
    setLog('已删除模板', 'warn');
  }

  // 简易命名对话框（CEP 无 prompt，用覆盖层）
  function askName(title, defVal, cb) {
    var old = document.getElementById('tpl-modal');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var modal = document.createElement('div');
    modal.id = 'tpl-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999;display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#1e1e1e;border:1px solid #3a3a3a;border-radius:8px;padding:16px;width:300px;';
    var h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:10px;color:#eee;';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.value = defVal || '';
    inp.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #3a3a3a;border-radius:4px;background:#2a2a2a;color:#eee;font-size:13px;margin-bottom:12px;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    var ok = document.createElement('button');
    ok.textContent = '确定';
    ok.style.cssText = 'background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:5px 14px;font-size:13px;cursor:pointer;';
    var cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText = 'background:#3a3a3a;color:#ccc;border:none;border-radius:4px;padding:5px 14px;font-size:13px;cursor:pointer;';
    row.appendChild(cancel);
    row.appendChild(ok);
    box.appendChild(h);
    box.appendChild(inp);
    box.appendChild(row);
    modal.appendChild(box);
    document.body.appendChild(modal);
    function close() {
      if (modal.parentNode) modal.parentNode.removeChild(modal);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') { close(); }
      if (e.key === 'Enter') { ok.click(); }
    }
    ok.addEventListener('click', function () {
      var v = inp.value.trim();
      close();
      cb(v);
    });
    cancel.addEventListener('click', function () { close(); cb(''); });
    document.addEventListener('keydown', onKey);
    inp.focus();
    inp.select();
  }

  // ── 渲染版本卡片 ──────────────────────────────
  function toggleKeep(card) {
    var m = card.querySelector('.v-mute').value;
    card.querySelector('.v-keep').style.display = (m === 'mute') ? '' : 'none';
  }

  function createVersionCard(v) {
    var card = document.createElement('div');
    card.className = 'ver-card';
    card.setAttribute('data-id', v.id);

    // 头部：启用勾选 + 版本名 + 删除
    var head = document.createElement('div');
    head.className = 'ver-head';
    var enCheck = document.createElement('input');
    enCheck.type = 'checkbox';
    enCheck.className = 'v-enabled';
    enCheck.title = '取消勾选则该版本不参与本次导出';
    enCheck.checked = (v.enabled !== false);
    head.appendChild(enCheck);
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'v-name';
    nameInput.placeholder = '版本名';
    nameInput.value = v.name;
    head.appendChild(nameInput);
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'v-del';
    delBtn.textContent = '删除';
    delBtn.title = '删除此版本';
    head.appendChild(delBtn);
    card.appendChild(head);

    // 预设 + 音轨模式 两列并排
    var cols = document.createElement('div');
    cols.className = 'ver-cols';

    var c1 = document.createElement('div');
    c1.className = 'col';
    var pLab = document.createElement('label');
    pLab.textContent = '导出预设';
    c1.appendChild(pLab);
    var pSel = document.createElement('select');
    pSel.className = 'v-preset';
    fillPresetSelect(pSel, allPresets, ''); // 只填选项，不自动选
    // 决定选中值：有已存值则用，否则按关键词自动选并回写
    if (v.preset && allPresets.some(function (p) { return p.full === v.preset; })) {
      pSel.value = v.preset;
    } else {
      var keyword = v.name.indexOf('无字幕') >= 0 ? '无字幕' : '有字幕';
      allPresets.forEach(function (p) {
        if (p.name.indexOf(keyword) >= 0) pSel.value = p.full;
      });
      v.preset = pSel.value || ''; // 回写自动选中的预设，避免导出时校验报“预设无效”
    }
    c1.appendChild(pSel);
    cols.appendChild(c1);

    var c2 = document.createElement('div');
    c2.className = 'col';
    var mLab = document.createElement('label');
    mLab.textContent = '音轨模式';
    c2.appendChild(mLab);
    var mSel = document.createElement('select');
    mSel.className = 'v-mute';
    var o1 = document.createElement('option');
    o1.value = 'none'; o1.textContent = '不静音';
    var o2 = document.createElement('option');
    o2.value = 'mute'; o2.textContent = '静音非保留轨';
    mSel.appendChild(o1);
    mSel.appendChild(o2);
    mSel.value = v.muteMode || 'none';
    c2.appendChild(mSel);
    cols.appendChild(c2);
    card.appendChild(cols);

    // 输出目录
    var dLab = document.createElement('label');
    dLab.textContent = '输出目录';
    card.appendChild(dLab);
    var dirRow = document.createElement('div');
    dirRow.className = 'dir-row';
    var dirInput = document.createElement('input');
    dirInput.type = 'text';
    dirInput.className = 'v-dir';
    dirInput.placeholder = '例如 D:\\成片';
    dirInput.value = v.outDir || '';
    dirRow.appendChild(dirInput);
    var browseBtn = document.createElement('button');
    browseBtn.type = 'button';
    browseBtn.className = 'v-browse';
    browseBtn.textContent = '浏览…';
    dirRow.appendChild(browseBtn);
    card.appendChild(dirRow);

    // 保留音轨列表（仅静音模式显示）
    var keepWrap = document.createElement('div');
    keepWrap.className = 'v-keep';
    var kLab = document.createElement('label');
    kLab.textContent = '保留音轨（勾选保留，其余静音）';
    keepWrap.appendChild(kLab);
    var keepList = document.createElement('div');
    keepList.className = 'keep-list';
    if (audioTracks.length === 0) {
      keepList.innerHTML = '<div class="keep-empty">尚未加载音轨，点「刷新」</div>';
    } else {
      audioTracks.forEach(function (t) {
        var lab = document.createElement('label');
        lab.className = 'track-item';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'v-keep-cb';
        cb.value = String(t.index);
        if (v.keepList.indexOf(t.index) >= 0) cb.checked = true;
        var span = document.createElement('span');
        span.textContent = 'A' + (t.index + 1) + (t.name ? ' · ' + t.name : '');
        lab.appendChild(cb);
        lab.appendChild(span);
        keepList.appendChild(lab);
      });
    }
    keepWrap.appendChild(keepList);
    card.appendChild(keepWrap);

    // 事件
    delBtn.addEventListener('click', function () { removeVersion(v.id); });
    browseBtn.addEventListener('click', function () { browseFolder(dirInput); });
    mSel.addEventListener('change', function () {
      v.muteMode = mSel.value;
      toggleKeep(card);
      saveVersions();
    });

    toggleKeep(card);
    return card;
  }

  function renderVersions() {
    versionsWrap.innerHTML = '';
    versions.forEach(function (v) {
      versionsWrap.appendChild(createVersionCard(v));
    });
    saveVersions(); // 回写 createVersionCard 里自动选中的预设
  }

  function addVersion() {
    versions.push({ id: genId(), name: '新版本', preset: '', muteMode: 'none', keepList: [0, 1], outDir: '', enabled: true, folderKey: '' });
    saveVersions();
    renderVersions();
    captureBaseline();
    setLog('已添加新版本，请配置名称/预设/目录', 'success');
  }

  function removeVersion(id) {
    if (versions.length <= 1) { setLog('至少保留一个版本', true); return; }
    versions = versions.filter(function (v) { return v.id !== id; });
    saveVersions();
    renderVersions();
    captureBaseline();
    setLog('已删除版本', 'success');
  }
  // 本次参与导出的版本（勾选了启用复选框的）
  function enabledVersions() {
    return versions.filter(function (v) { return v.enabled !== false; });
  }

  // ── 输出目录浏览（修乱码：结果写 UTF-8 文件再读回，并记住上次位置） ──
  function getLastDir() {
    try { return localStorage.getItem('pr_me_lastdir') || ''; } catch (_) { return ''; }
  }
  function setLastDir(p) {
    try { localStorage.setItem('pr_me_lastdir', p); } catch (_) {}
  }

  // 交付根目录持久化
  function getDeliveryRoot() {
    try { return localStorage.getItem('pr_me_delivery_root') || ''; } catch (_) { return ''; }
  }
  function setDeliveryRoot(p) {
    try { localStorage.setItem('pr_me_delivery_root', p); } catch (_) {}
  }
  // 字幕配置持久化
  function getSubtitleCfg() {
    try {
      var raw = localStorage.getItem('pr_me_subtitle_cfg');
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return { enabled: true, dir: '' };
  }
  function setSubtitleCfg(cfg) {
    try { localStorage.setItem('pr_me_subtitle_cfg', JSON.stringify(cfg)); } catch (_) {}
  }
  // 清单开关持久化
  function getManifestCfg() {
    try { return localStorage.getItem('pr_me_manifest') === '1'; } catch (_) { return true; }
  }
  function setManifestCfg(b) {
    try { localStorage.setItem('pr_me_manifest', b ? '1' : '0'); } catch (_) {}
  }
  function browseFolder(targetInput, onPick) {
    var last = getLastDir();
    var cur = (targetInput && targetInput.value || '').trim();
    var initial = '';
    if (last && fs.existsSync(last)) initial = last;
    if (!initial && cur && fs.existsSync(cur)) initial = cur;
    else if (!initial && cur) { var par = path.dirname(cur); if (fs.existsSync(par)) initial = par; }

    var inFile = path.join(os.tmpdir(), 'cep_dir_in_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.txt');
    var outFile = path.join(os.tmpdir(), 'cep_dir_out_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.txt');
    // ini 文件存 JSON（path + title），UTF-8，避开中文命令行转义
    fs.writeFileSync(inFile, JSON.stringify({ path: initial, title: '选择输出目录' }), 'utf8');

    // 定位扩展根目录（folderpicker.ps1 所在位置）：
    // 1) getSystemPath('extension') 返回 file:/// URI，解析成绝对路径
    // 2) __dirname 回退：main.js 在 js/ 下，扩展根是其父目录
    var extRoot = '';
    try { extRoot = csInterface.getSystemPath('extension'); } catch (_) {}
    if (!extRoot || !fs.existsSync(path.join(extRoot, 'jsx', 'folderpicker.ps1'))) {
      try {
        var d = (typeof __dirname !== 'undefined') ? __dirname : '';
        if (d) {
          var root = (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
          if (fs.existsSync(path.join(root, 'jsx', 'folderpicker.ps1'))) extRoot = root;
        }
      } catch (_) {}
    }
    var psPath = path.join(extRoot || '', 'jsx', 'folderpicker.ps1');

    var cmd = 'powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' + psPath + '" -Ini "' + inFile + '" -Out "' + outFile + '"';
    require('child_process').exec(cmd, { windowsHide: true }, function (err) {
      try { fs.unlinkSync(inFile); } catch (_) {}
      if (err) { setLog('打开目录选择失败：' + err.message, true); return; }
      try {
        if (fs.existsSync(outFile)) {
          var p = fs.readFileSync(outFile, 'utf8').trim();
          try { fs.unlinkSync(outFile); } catch (_) {}
          if (p) {
            targetInput.value = p;
            setLastDir(p);
            var card = targetInput.closest('.ver-card');
            if (card) {
              var vv = findVersion(card.getAttribute('data-id'));
              if (vv) { vv.outDir = p; saveVersions(); }
            }
            if (onPick) onPick(p);
            setLog('已选择输出目录：' + p, 'success');
          } else {
            setLog('未选择目录（已取消）');
          }
        } else {
          setLog('未选择目录（已取消）');
        }
      } catch (e) { setLog('读取目录失败：' + e.message, true); }
    });
  }

  // ── 等待输出文件完整落地 ─────────────────────
  function waitForFile(filePath, timeoutMs, isStopped) {
    return new Promise(function (resolve, reject) {
      var start = Date.now();
      function check() {
        if (isStopped && isStopped()) { reject(new Error('__STOPPED__')); return; }
        var exists = fs.existsSync(filePath);
        var sz = 0;
        try { if (exists) sz = fs.statSync(filePath).size; } catch (_) {}
        if (exists && sz > 0) {
          setTimeout(function () {
            var sz2 = 0;
            try { if (fs.existsSync(filePath)) sz2 = fs.statSync(filePath).size; } catch (_) {}
            if (sz2 === sz) { resolve(); return; }
            if (Date.now() - start > timeoutMs) { reject(new Error('导出超时')); return; }
            check();
          }, 2000);
          return;
        }
        if (Date.now() - start > timeoutMs) { reject(new Error('导出超时 ' + timeoutMs + 'ms')); return; }
        setTimeout(check, 1500);
      }
      check();
    });
  }

  // ── 收尾 sidecar 字幕文件（1.mp4.srt → 1.srt，并可归位到独立字幕目录） ──
  // PR 导出 sidecar 字幕时会生成「视频名+扩展名+.srt」如 1.mp4.srt，
  // 这里把它重命名为「视频名去扩展名+.srt」如 1.srt，再可选移动到字幕目录。
  function finalizeSidecar(outObj, destDir) {
    return new Promise(function (resolve) {
      var stem = path.basename(outObj.file, path.extname(outObj.file)); // 1
      var sidecar = path.join(outObj.dir, outObj.file + '.srt');        // 1.mp4.srt
      var sameDir = path.join(outObj.dir, stem + '.srt');               // 同目录 1.srt
      var start = Date.now();
      var timeoutMs = 15000;
      function finish(nameInSameDir) {
        // 若无独立字幕目录，就留在视频目录；否则移动到 destDir
        var finalDir = (destDir && fs.existsSync(destDir)) ? destDir : outObj.dir;
        var finalTarget = path.join(finalDir, stem + '.srt');
        try {
          if (fs.existsSync(finalTarget)) fs.unlinkSync(finalTarget);
          fs.renameSync(nameInSameDir, finalTarget);
          resolve({ found: true, target: finalTarget });
        } catch (e) { resolve({ found: true, target: nameInSameDir, err: e.message }); }
      }
      function probe() {
        // 优先探测同目录已改名好的 1.srt（可能上次遗留或 PR 直接生成）
        if (fs.existsSync(sameDir) && fs.statSync(sameDir).size > 0) {
          finish(sameDir);
          return;
        }
        var exists = fs.existsSync(sidecar);
        var sz = 0;
        try { if (exists) sz = fs.statSync(sidecar).size; } catch (_) {}
        if (exists && sz > 0) {
          setTimeout(function () {
            var sz2 = 0;
            try { if (fs.existsSync(sidecar)) sz2 = fs.statSync(sidecar).size; } catch (_) {}
            if (sz2 === sz) {
              try {
                fs.renameSync(sidecar, sameDir);
                finish(sameDir);
              } catch (e) { resolve({ found: true, target: sidecar, err: e.message }); }
              return;
            }
            if (Date.now() - start > timeoutMs) { resolve({ found: true, target: sidecar, err: '字幕文件持续写入，未重命名' }); return; }
            probe();
          }, 1500);
          return;
        }
        if (Date.now() - start > timeoutMs) {
          resolve({ found: false });
          return;
        }
        setTimeout(probe, 800);
      }
      probe();
    });
  }

  // ── 构建每个版本的输出目标（处理目录冲突） ────
  function buildOutputs(seqName) {
    var evs = enabledVersions();
    var dirs = evs.map(function (v) { return v.outDir; });
    var seen = {};
    dirs.forEach(function (d) { seen[d] = (seen[d] || 0) + 1; });
    return evs.map(function (v) {
      var ext = inferExtFromPreset(v.preset);
      var name = (seen[v.outDir] > 1) ? (seqName + '_' + v.name) : seqName;
      return { dir: v.outDir, file: name + '.' + ext };
    });
  }

  // ── 单个序列：按版本列表依次导出 ──────────────
  async function exportOneSequence(seqName, onProgress) {
    var evs = enabledVersions();
    var totalV = evs.length;
    var subtitleEnabled = chkSubtitle.checked;
    var subtitleOutDir = (subtitleDir.value || '').trim();
    function rep(p, t) { if (onProgress) onProgress(p, '[' + seqName + '] ' + t); }
    var muted = false;
    async function unmute() { if (muted) { try { await evalHost('meUnmuteAll()'); } catch (_) {} muted = false; } }

    try {
      rep(0, '准备');
      var act = await evalHost('meActivateSequence(' + JSON.stringify(seqName) + ')');
      if (act.indexOf('OK:') !== 0) return { ok: false, err: '激活序列失败：' + act };

      // 获取序列时长/尺寸，供交付清单记录
      var seqDur = '';
      try {
        var si = await evalHost('meSeqInfo()');
        if (si.indexOf('OK:') === 0) {
          var siObj = JSON.parse(si.slice(3));
          if (siObj.durationSec != null) seqDur = fmtDur(siObj.durationSec);
        }
      } catch (_) {}

      var outs = buildOutputs(seqName);
      evs.forEach(function (v, i) {
        if (outs[i].dir) fs.mkdirSync(outs[i].dir, { recursive: true });
      });

      for (var i = 0; i < totalV; i++) {
        if (stopRequested) { await unmute(); return { stopped: true }; }
        var v = evs[i];
        var o = outs[i];
        var f = path.join(o.dir, o.file);
        var base = (i / totalV) * 100;
        var span = (1 / totalV) * 100;

        if (v.muteMode === 'mute') {
          rep(base + 2, '静音非保留轨');
          var m = await evalHost('meMuteExcept(' + JSON.stringify(v.keepList.join(',')) + ')');
          if (m.indexOf('OK:') !== 0) return { ok: false, err: '静音失败：' + m };
          muted = true;
        }

        rep(base + 6, '导出「' + v.name + '」');
        setLog('▶ [' + seqName + '] ' + v.name + ' → ' + f);
        var r = await evalHost('meExport(' + JSON.stringify(f) + ', ' + JSON.stringify(v.preset) + ', 0)');
        if (r.indexOf('OK:') !== 0) { await unmute(); return { ok: false, err: '「' + v.name + '」提交失败：' + r }; }
        if (stopRequested) { await unmute(); return { stopped: true }; }
        await waitForFile(f, 30 * 60 * 1000, function () { return stopRequested; });
        if (stopRequested) { await unmute(); return { stopped: true }; }

        // 收尾 sidecar 字幕（1.mp4.srt → 1.srt，可归位到独立字幕目录）
        var srtNote = '';
        if (subtitleEnabled) {
          rep(base + span - 4, '收尾字幕文件');
          var sc = await finalizeSidecar(o, subtitleOutDir);
          if (sc.found) {
            srtNote = sc.err ? '（字幕未归位：' + sc.err + '）' : ' + srt';
            setLog(sc.err ? ('  ⚠ 字幕文件已生成但未归位：' + sc.target) : ('  ✓ 字幕 ' + sc.target), sc.err ? 'warn' : 'success');
          } else {
            setLog('  ⚠ 未检测到 sidecar 字幕，请确认无字幕版预设已开启「创建 Sidecar 字幕」', 'warn');
          }
        }

        await unmute();
        setLog('  ✓ ' + v.name + '完成' + srtNote, 'success');
        rep(base + span - 2, '「' + v.name + '」完成');

        // 记录到交付清单
        var sz = 0;
        try { if (fs.existsSync(f)) sz = fs.statSync(f).size; } catch (_) {}
        manifest.push({
          seq: seqName, version: v.name, status: '成功',
          file: f, dir: o.dir, size: fmtSize(sz), duration: seqDur
        });
      }

      rep(100, '完成');
      return { ok: true };
    } catch (e) {
      if (e && e.message === '__STOPPED__') { await unmute(); return { stopped: true }; }
      await unmute();
      return { ok: false, err: e.message };
    }
  }

  // ── 主流程：批量导出 ─────────────────────────
  async function runExport() {
    var seqs = getCheckedSeqs();
    if (seqs.length === 0) { setLog('请至少勾选一个序列', true); return; }
    var evs = enabledVersions();
    if (evs.length === 0) { setLog('请至少启用一个版本（勾选版本卡片前的复选框）', true); return; }

    // 校验每个启用的版本
    for (var i = 0; i < evs.length; i++) {
      var v = evs[i];
      if (!v.name) { setLog('第 ' + (i + 1) + ' 个版本缺名称', true); return; }
      if (!v.preset || !fs.existsSync(v.preset)) { setLog('版本「' + v.name + '」导出预设无效', true); return; }
      if (!v.outDir || !fs.existsSync(v.outDir)) { setLog('版本「' + v.name + '」输出目录不存在：' + v.outDir, true); return; }
      if (v.muteMode === 'mute' && v.keepList.length === 0) { setLog('版本「' + v.name + '」选了静音但没勾保留轨', true); return; }
    }

    stopRequested = false;
    setBusy(true);
    manifest = [];
    progressArea.style.display = 'block';
    var totalSeq = seqs.length;
    var startTime = Date.now();
    var doneSeq = 0;

    function overallPercent(seqIdx, inSeqPercent) {
      var base = (seqIdx / totalSeq) * 100;
      var span = (1 / totalSeq) * 100;
      return base + span * (inSeqPercent / 100);
    }

    try {
      for (var k = 0; k < seqs.length; k++) {
        if (stopRequested) break;
        var seqName = seqs[k];
        setLog('━━ 开始处理 [' + seqName + '] (' + (k + 1) + '/' + totalSeq + ') ━━');

        var res = await exportOneSequence(seqName, function (p, t) {
          if (stopRequested) return;
          var overall = overallPercent(k, p);
          var elapsed = (Date.now() - startTime) / 1000;
          var remain = overall > 0 ? elapsed * (100 - overall) / overall : 0;
          setProgress(overall, t, elapsed, remain);
        });

        if (res.stopped) { setLog('⏹ 已停止（用户中止）', 'warn'); break; }
        if (res.ok) { doneSeq++; setLog('✓ [' + seqName + '] 全部完成', 'success'); }
        else {
          setLog('✗ [' + seqName + '] 失败：' + res.err, 'error');
          // 失败时记录该序列未完成的所有启用版本
          var outsF = buildOutputs(seqName);
          evs.forEach(function (v, i) {
            manifest.push({ seq: seqName, version: v.name, status: '失败', file: outsF[i] ? path.join(outsF[i].dir, outsF[i].file) : '', dir: outsF[i] ? outsF[i].dir : '', size: '', duration: '' });
          });
        }
      }

      if (stopRequested) {
        setLog('════ 任务已停止：完成 ' + doneSeq + ' / ' + totalSeq + ' ════', 'warn');
        if (chkManifest.checked) writeManifest(manifest);
      } else {
        setProgress(100, '全部完成', (Date.now() - startTime) / 1000, 0);
        var allOk = (doneSeq === totalSeq && totalSeq > 0);
        setLog('════ 批量结束：成功 ' + doneSeq + ' / 失败 ' + (totalSeq - doneSeq) + ' ════', allOk ? 'success' : 'warn');
        if (chkManifest.checked) writeManifest(manifest);
      }
    } catch (e) {
      setLog('流程中断：' + e.message, 'error');
      try { await evalHost('meUnmuteAll()'); } catch (_) {}
    } finally {
      setBusy(false);
    }
  }

  // ── 交付结构自动填充 ────────────────────────
  // 扫描根目录下的子文件夹，按数字前缀 + 名称关键词匹配到各版本和字幕目录
  function autofillFromRoot() {
    var root = (deliveryRoot.value || '').trim();
    if (!root || !fs.existsSync(root)) { setLog('交付根目录不存在：' + root, true); return; }
    var subs = [];
    try {
      subs = fs.readdirSync(root, { withFileTypes: true })
        .filter(function (d) { return d.isDirectory(); })
        .map(function (d) { return d.name; });
    } catch (e) { setLog('读取根目录失败：' + e.message, true); return; }

    // 数字前缀提取："1.有音乐无字幕版本" -> {n:1, name}
    function prefixOf(name) {
      var m = name.match(/^(\d+)\s*[.、_\-]?/);
      return m ? parseInt(m[1], 10) : null;
    }

    // 按数字前缀匹配版本（folderKey），数字对不上时用名称关键词兜底
    function keyOf(v) {
      return v.folderKey || inferFolderKey(v.name);
    }
    var matched = 0;
    versions.forEach(function (v) {
      var key = keyOf(v);
      var hit = null;
      if (key) {
        var want = parseInt(key, 10);
        if (!isNaN(want)) hit = subs.find(function (s) { return prefixOf(s) === want; });
      }
      // 兜底：名称关键词
      if (!hit) {
        var kw = '';
        if (v.name.indexOf('无音乐') >= 0 || /bgm/i.test(v.name)) kw = '无音乐';
        else if (v.name.indexOf('无字幕') >= 0) kw = '无字幕';
        else if (v.name.indexOf('成片') >= 0) kw = '成片';
        if (kw) hit = subs.find(function (s) { return s.indexOf(kw) >= 0; });
      }
      if (hit) {
        v.outDir = path.join(root, hit);
        matched++;
      }
    });

    // 字幕目录：优先数字前缀 3，其次名称含「字幕」
    var srtHit = subs.find(function (s) { return prefixOf(s) === 3; });
    if (!srtHit) srtHit = subs.find(function (s) { return s.indexOf('字幕') >= 0; });
    if (srtHit) {
      subtitleDir.value = path.join(root, srtHit);
    }

    saveVersions();
    renderVersions();
    setDeliveryRoot(root);
    captureBaseline();
    setLog('已从 ' + root + ' 填充 ' + matched + ' 个版本路径' + (srtHit ? ' + 字幕目录' : ''), matched > 0 ? 'success' : 'warn');
  }

  // ── 事件绑定 ──────────────────────────────────
  // 交付模板：下拉切换 / 另存为 / 重命名 / 删除
  tplSelect.addEventListener('change', function () {
    var id = tplSelect.value;
    if (!id) {
      // 切回自由配置：不销毁当前配置，仅解除模板关联
      activeTplId = '';
      lastSnapshot = null;
      tplDirty = false;
      saveTemplates();
      renderTplSelect();
      setLog('已切回自由配置（当前参数保留）');
      return;
    }
    applyTemplate(id);
  });
  btnTplSave.addEventListener('click', function () {
    var at = activeTemplate();
    var defName = at ? (at.name + ' 副本') : (deliveryRoot.value.trim() ? path.basename(deliveryRoot.value.trim()) : '默认交付');
    askName('另存为交付模板', defName, function (name) {
      if (!name) return;
      var t = saveAsTemplate(name, null);
      setLog('已保存模板「' + t.name + '」并套用', 'success');
    });
  });
  btnTplRename.addEventListener('click', function () {
    var at = activeTemplate();
    if (!at) return;
    askName('重命名模板', at.name, function (name) {
      if (!name) return;
      var t = findTemplate(at.id);
      if (t) { t.name = name; saveTemplates(); renderTplSelect(); setLog('已重命名为「' + name + '」', 'success'); }
    });
  });
  btnTplDelete.addEventListener('click', function () {
    var at = activeTemplate();
    if (!at) return;
    askName('确认删除模板「' + at.name + '」？输入模板名确认', '', function (v) {
      if (v === at.name) {
        deleteTemplate(at.id);
        setLog('已删除模板「' + at.name + '」', 'warn');
      } else if (v !== '') {
        setLog('输入的名字不匹配，未删除', 'warn');
      }
    });
  });
  // 统一 dirty 监听：panel-export 内任何 input/change 都刷新「相对模板是否改动」提示
  document.addEventListener('input', function (e) {
    if (e.target && e.target.closest && e.target.closest('#panel-export')) captureBaseline();
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.closest && e.target.closest('#panel-export')) captureBaseline();
  });

  btnGo.addEventListener('click', runExport);
  btnStop.addEventListener('click', function () {
    if (!btnStop.disabled) {
      stopRequested = true;
      setLog('⏹ 正在停止…（当前导出完成后中止）', true);
    }
  });

  btnAddVersion.addEventListener('click', addVersion);

  btnBrowseRoot.addEventListener('click', function () {
    browseFolder(deliveryRoot, function (p) { setDeliveryRoot(p); });
  });
  btnAutofill.addEventListener('click', autofillFromRoot);
  btnBrowseSubtitle.addEventListener('click', function () {
    browseFolder(subtitleDir, function (p) {
      var cfg = getSubtitleCfg(); cfg.dir = p; setSubtitleCfg(cfg);
    });
  });
  chkManifest.addEventListener('change', function () { setManifestCfg(chkManifest.checked); });
  chkSubtitle.addEventListener('change', function () {
    var cfg = getSubtitleCfg(); cfg.enabled = chkSubtitle.checked; setSubtitleCfg(cfg);
  });
  subtitleDir.addEventListener('input', function () {
    var cfg = getSubtitleCfg(); cfg.dir = subtitleDir.value; setSubtitleCfg(cfg);
  });

  btnRefresh.addEventListener('click', async function () {
    refreshPresets();
    await refreshSequences();
    await refreshAudioTracks();
    renderVersions();
  });

  // 版本卡片内部 input/change 实时同步到 versions
  versionsWrap.addEventListener('input', function (e) {
    var card = e.target.closest('.ver-card');
    if (!card) return;
    var v = findVersion(card.getAttribute('data-id'));
    if (!v) return;
    if (e.target.classList.contains('v-name')) v.name = e.target.value;
    else if (e.target.classList.contains('v-dir')) v.outDir = e.target.value;
    saveVersions();
  });
  versionsWrap.addEventListener('change', function (e) {
    var card = e.target.closest('.ver-card');
    if (!card) return;
    var v = findVersion(card.getAttribute('data-id'));
    if (!v) return;
    if (e.target.classList.contains('v-preset')) {
      v.preset = e.target.value;
      saveVersions();
    } else if (e.target.classList.contains('v-enabled')) {
      v.enabled = e.target.checked;
      saveVersions();
    } else if (e.target.classList.contains('v-keep-cb')) {
      v.keepList = [];
      card.querySelectorAll('.v-keep-cb:checked').forEach(function (cb) {
        v.keepList.push(parseInt(cb.value, 10));
      });
      saveVersions();
    }
  });

  btnSelAll.addEventListener('click', function () {
    seqList.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = true; });
  });
  btnSelNone.addEventListener('click', function () {
    seqList.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = false; });
  });

  seqList.addEventListener('change', async function () {
    var first = getCheckedSeqs()[0];
    if (first) {
      await evalHost('meActivateSequence(' + JSON.stringify(first) + ')');
      await refreshAudioTracks();
    }
  });

  // ── 初始化 ──────────────────────────────────
  (async function () {
    refreshPresets();
    versions = loadVersions();
    // 恢复交付根目录 / 字幕 / 清单开关
    deliveryRoot.value = getDeliveryRoot();
    var scfg = getSubtitleCfg();
    chkSubtitle.checked = (scfg.enabled !== false);
    subtitleDir.value = scfg.dir || '';
    chkManifest.checked = getManifestCfg();
    // 加载交付模板：若有上次套用的模板则套用之，否则维持自由配置
    loadTemplates();
    var at = activeTemplate();
    if (at) {
      lastSnapshot = JSON.parse(JSON.stringify(at.snapshot || {}));
      tplDirty = false;
      applySnapshot(lastSnapshot);
    } else {
      activeTplId = '';
      lastSnapshot = null;
      tplDirty = false;
    }
    renderTplSelect();
    try { await refreshSequences(); } catch (_) {}
    try { await refreshAudioTracks(); } catch (_) { renderVersions(); }
    var v = await evalHost('meVersion()');
    if (v) document.getElementById('version').textContent = 'v' + v;
    statusDot.className = 'dot on';
  })();
})();
