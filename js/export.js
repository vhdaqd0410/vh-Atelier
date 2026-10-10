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
  var btnRefreshSeq = document.getElementById('btn-refresh-seq');
  var btnOpenOut = document.getElementById('btn-open-out');
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
  var rndPr = document.getElementById('rnd-pr');
  var rndAme = document.getElementById('rnd-ame');
  var rndTip = document.getElementById('rnd-tip');
  // 渲染通道：'pr' = PR 直渲（前台占用）；'ame' = 交给 Media Encoder 后台渲染
  var CH_KEY = 'vh_export_channel';
  function getChannel() {
    // 默认走 AME（不占用 PR）；用户显式选过 PR 才用 PR
    try { return localStorage.getItem(CH_KEY) === 'pr' ? 'pr' : 'ame'; } catch (e) { return 'ame'; }
  }
  function setChannel(ch) {
    try { localStorage.setItem(CH_KEY, ch === 'ame' ? 'ame' : 'pr'); } catch (e) {}
    syncChannelUI();
  }
  function syncChannelUI() {
    var ch = getChannel();
    if (rndPr) rndPr.checked = (ch === 'pr');
    if (rndAme) rndAme.checked = (ch === 'ame');
    if (rndTip) {
      rndTip.textContent = (ch === 'ame')
        ? 'AME 队列：PR 只负责把任务排进 Media Encoder，渲染全在 ME 后台跑，导出期间可以正常剪片。首次会自动拉起 ME（约十几秒）。'
        : 'PR 直渲：渲染在 Premiere 前台进行，导出期间会占用 PR，不能同时编辑。';
      rndTip.className = 'rnd-tip' + (ch === 'ame' ? ' is-ame' : '');
    }
  }

  // ── 全局状态 ──────────────────────────────────
  var stopRequested = false;
  var allSeqs = [];
  var audioTracks = [];
  var allPresets = [];
  var versions = [];     // 交付版本列表（每个版本独立配置）
  var uidSeq = 0;
  var manifest = [];    // 交付清单（运行期收集，导出完生成 CSV）  
  var lastOutputDir = '';  // 最近一次成功导出的输出目录（供「打开输出目录」按钮用）
  var preflightResult = null;   // 最近一次 AME 预检结果
  var _amePreflightDone = false; // 本轮预检是否已跑过（每个序列复用）
  var ameJobs = [];        // 本轮 AME 队列已入队任务 [{jobId, file, version, out}]
  var amePendings = [];    // 待渲染完成后收尾的版本（清单/字幕）
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
    // 失败信息同时落盘到 collect/error.log：面板一关界面日志就没了，
    // 导出出问题时排障只能靠现象反推。只落 error/warn，避免正常流程刷满日志。
    try {
      if (lv === 'error' && window.__vhLog) window.__vhLog.err('[export] ' + msg);
      else if (lv === 'warn' && window.__vhLog) window.__vhLog.warn('[export] ' + msg);
    } catch (e) {}
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
  // 进度时间显示：单独抽出来，供 1 秒心跳复用
  function renderProgTime(elapsedSec, remainSec) {
    var t = '已用 ' + fmtTime(elapsedSec || 0);
    if (remainSec !== undefined && remainSec !== null) t += ' · 预计剩余 ' + fmtTime(remainSec);
    progressTime.textContent = t;
  }
  // 进度心跳：原来「已用时间」只在收到进度事件时才刷新，
  // 渲染阶段若回调稀疏，这个数字会长时间冻住，看起来像卡死。
  // 现在每秒自己走一遍，已用时间始终准确。
  var progTick = null;
  var progStartedAt = 0;
  var progLastRemain = null;
  function startProgTicker(startedAt) {
    stopProgTicker();
    progStartedAt = startedAt || Date.now();
    progTick = setInterval(function () {
      renderProgTime((Date.now() - progStartedAt) / 1000, progLastRemain);
    }, 1000);
  }
  function stopProgTicker() {
    if (progTick) { clearInterval(progTick); progTick = null; }
  }
  function setProgress(pct, stateText, elapsedSec, remainSec) {
    pct = Math.max(0, Math.min(100, pct));
    progressFill.style.width = pct + '%';
    progressPct.textContent = Math.round(pct) + '%';
    if (stateText) progressState.textContent = stateText;
    progLastRemain = (remainSec === undefined) ? null : remainSec;
    renderProgTime(elapsedSec, remainSec);
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
    // 关键：带上「当前勾选的第一个序列」，避免读到 PR 里碰巧活动的另一条序列
    var want = '';
    try {
      var cs = getCheckedSeqs();
      if (cs.length) want = cs[0];
    } catch (_) {}
    var r = await evalHost('meListAudioTracks(' + JSON.stringify(want) + ')');
    if (r.indexOf('OK:') !== 0) { setLog('读取音轨失败：' + r, true); return; }
    var d = {};
    try { d = JSON.parse(r.slice(3)); } catch (_) {}
    // 兼容旧返回（直接是数组）
    if (Array.isArray(d)) { audioTracks = d; d = { tracks: d, numTracks: d.length }; }
    audioTracks = d.tracks || [];
    var names = audioTracks.map(function (t) { return 'A' + (t.index + 1); }).join('/');
    setLog('已加载 ' + audioTracks.length + ' 条音频轨' +
           (d.seqName ? ('（序列「' + d.seqName + '」：' + (names || '无') + '）') : '') +
           (audioTracks.length <= 1 ? '  ← 若该序列确有更多音轨，请检查 PR 里该序列的音轨数' : ''),
           'success');
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
  // ── 收尾 sidecar 字幕文件（1.mp4.srt → 1.srt，并可归位到独立字幕目录） ──
  // PR 导出 sidecar 字幕时会生成「视频名+扩展名+.srt」如 1.mp4.srt；
  // AME 的命名规则不保证一致（可能叫 1.srt、1.mp4.srt、1_字幕.srt 等），
  // 所以这里不再死认两种名字：先试常见形态，再退到「扫描目录里以视频名为前缀的 .srt」。
  // 超时给足 90s —— AME 的任务完成回调在视频渲染完就触发，srt 可能更晚才落盘。
  function finalizeSidecar(outObj, destDir) {
    return new Promise(function (resolve) {
      var stem = path.basename(outObj.file, path.extname(outObj.file)); // 1
      var sidecar = path.join(outObj.dir, outObj.file + '.srt');        // 1.mp4.srt
      var sameDir = path.join(outObj.dir, stem + '.srt');               // 同目录 1.srt
      var start = Date.now();
      var timeoutMs = 90000;

      // 在输出目录里找一个「属于这个视频」的 srt：
      // 以视频名为前缀（1.srt / 1.mp4.srt / 1_字幕.srt 都算），且不是别的视频的。
      function scanCandidate() {
        var names = [];
        try { names = fs.readdirSync(outObj.dir); } catch (e) { return ''; }
        var hit = '';
        for (var i = 0; i < names.length; i++) {
          var n = names[i];
          if (n.length < 5 || n.slice(-4).toLowerCase() !== '.srt') continue;
          if (n.indexOf(stem) !== 0) continue;                 // 必须以视频名为前缀
          // 前缀后紧跟 . - _ 空格 或扩展名边界，避免「10.srt」被当成「1」的
          var rest = n.slice(stem.length);
          if (rest.charAt(0) !== '.' && rest.charAt(0) !== '-' && rest.charAt(0) !== '_' &&
              rest.charAt(0) !== ' ' && n.slice(0, stem.length + 1) !== stem + '.') continue;
          var full = path.join(outObj.dir, n);
          try { if (fs.statSync(full).size > 0) { hit = full; break; } } catch (e) {}
        }
        return hit;
      }

      function finish(nameInSameDir) {
        var finalDir = (destDir && fs.existsSync(destDir)) ? destDir : outObj.dir;
        var finalTarget = path.join(finalDir, stem + '.srt');
        try {
          if (path.resolve(finalTarget) === path.resolve(nameInSameDir)) {
            resolve({ found: true, target: finalTarget });
            return;
          }
          if (fs.existsSync(finalTarget)) fs.unlinkSync(finalTarget);
          fs.renameSync(nameInSameDir, finalTarget);
          resolve({ found: true, target: finalTarget });
        } catch (e) { resolve({ found: true, target: nameInSameDir, err: e.message }); }
      }

      function probe() {
        // 1) 同目录已是目标名
        if (fs.existsSync(sameDir) && fs.statSync(sameDir).size > 0) { finish(sameDir); return; }
        // 2) PR 的经典形态
        var exists = fs.existsSync(sidecar);
        var sz = 0;
        try { if (exists) sz = fs.statSync(sidecar).size; } catch (_) {}
        if (exists && sz > 0) {
          setTimeout(function () {
            var sz2 = 0;
            try { if (fs.existsSync(sidecar)) sz2 = fs.statSync(sidecar).size; } catch (_) {}
            if (sz2 === sz) {
              try { fs.renameSync(sidecar, sameDir); finish(sameDir); }
              catch (e) { resolve({ found: true, target: sidecar, err: e.message }); }
              return;
            }
            if (Date.now() - start > timeoutMs) { resolve({ found: true, target: sidecar, err: '字幕文件持续写入，未重命名' }); return; }
            probe();
          }, 1500);
          return;
        }
        // 3) 扫描目录（AME 等其它命名）
        var cand = scanCandidate();
        if (cand && path.resolve(cand) !== path.resolve(sameDir)) {
          // 等它写完再改名
          setTimeout(function () {
            var s1 = 0, s2 = 0;
            try { s1 = fs.statSync(cand).size; } catch (_) {}
            setTimeout(function () {
              try { s2 = fs.statSync(cand).size; } catch (_) {}
              if (s1 > 0 && s1 === s2) { finish(cand); return; }
              if (Date.now() - start > timeoutMs) { finish(cand); return; }
              probe();
            }, 900);
          }, 600);
          return;
        }
        // 视频已就位且稳定时，不必死等满 90 秒：
        // 该版本的导出已结束，若这段时间内仍没有任何候选 srt，
        // 再留 12 秒容忍 srt 晚写，然后判定「没有字幕文件」。
        var vidReady = false;
        try {
          var vpath = path.join(outObj.dir, outObj.file);
          var r1 = fs.existsSync(vpath) ? fs.statSync(vpath).size : 0;
          if (r1 > 0) {
            var r2 = fs.existsSync(vpath) ? fs.statSync(vpath).size : 0;
            vidReady = (r1 === r2);
          }
        } catch (e) {}
        var graceMs = vidReady ? 12000 : timeoutMs;
        if (Date.now() - start > graceMs) { resolve({ found: false }); return; }
        setTimeout(probe, 800);
      }
      probe();
    });
  }

  // ── 兜底清扫：把输出目录里残留的、属于这些视频的 srt 归位 ──
  // 用在 ME 批量结束之后：AME 写 srt 可能晚于任务完成回调，
  // 逐任务的 finalizeSidecar 可能错过；这里统一再扫一遍。
  function sweepSidecars(outputs, destDir) {
    var moved = 0, checked = 0;
    (outputs || []).forEach(function (o) {
      if (!o || !o.dir || !o.file) return;
      checked++;
      var stem = path.basename(o.file, path.extname(o.file));
      var finalDir = (destDir && fs.existsSync(destDir)) ? destDir : o.dir;
      var finalTarget = path.join(finalDir, stem + '.srt');
      if (fs.existsSync(finalTarget)) return;      // 已就位
      var names = [];
      try { names = fs.readdirSync(o.dir); } catch (e) { return; }
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (n.length < 5 || n.slice(-4).toLowerCase() !== '.srt') continue;
        if (n.indexOf(stem) !== 0) continue;
        var full = path.join(o.dir, n);
        var size = 0;
        try { size = fs.statSync(full).size; } catch (e) { continue; }
        if (size <= 0) continue;
        try {
          if (fs.existsSync(finalTarget)) fs.unlinkSync(finalTarget);
          fs.renameSync(full, finalTarget);
          moved++;
          setLog('  ✓ 字幕归位：' + finalTarget, 'success');
        } catch (e) {
          setLog('  ⚠ 字幕归位失败：' + n + '（' + e.message + '）', 'warn');
        }
        break;
      }
    });
    return { moved: moved, checked: checked };
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


  // ── AME 任务完成等待 ─────────────────────────
  // 首选 onEncoderJobComplete 回调（真事件）；若绑定失败/超时无回调，
  // 退回「等文件落地」兜底（AME 渲染完成后文件必然存在）。
  var ameWaiters = {};        // jobId -> { resolve, done }
  var ameCallbacksBound = false;
  function bindAmeCallbacks() {
    if (ameCallbacksBound) return true;
    try {
      // 宿主（ExtendScript）改不了面板的 window，事件必须走 CSXS 通道：
      // 宿端用 CSXSEvent 派发 com.vh.ameJob，这里监听。
      csInterface.addEventListener('com.vh.ameJob', function (ev) {
        var d = null;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (!d) return;
        var w = ameWaiters[String(d.jobId)];
        if (!w) return;
        ameCallbackSeen = true;    // 收到任一 AME 回调 → 说明任务确实被 ME 接走了
        if (d.kind === 'complete') { w.done = true; w.resolve({ via: 'callback', out: d.payload }); }
        else if (d.kind === 'error') { w.done = true; w.resolve({ via: 'callback', err: d.payload || 'AME 渲染出错' }); }
        else if (d.kind === 'canceled') { w.done = true; w.resolve({ via: 'callback', err: '__CANCELED__' }); }
        else if (d.kind === 'progress') { if (w.onPct) { try { w.onPct(parseFloat(d.payload) || 0); } catch (e) {} } }
      });
      // 让宿端把 AME 事件接上（宿端负责派发 com.vh.ameJob）
      csInterface.evalScript('meBindAmeCallbacks()', function () {});
      ameCallbacksBound = true;
      return true;
    } catch (e) { return false; }
  }
  function waitAmeJob(jobId, filePath, timeoutMs, isStopped, onPct) {
    return new Promise(function (resolve, reject) {
      var key = String(jobId);
      var settled = false;
      function once(fn) { return function (v) { if (settled) return; settled = true; fn(v); }; }
      var waiter = { done: false, resolve: once(function (r) { resolve(r); }), onPct: onPct };
      ameWaiters[key] = waiter;
      var start = Date.now();
      var poll = setInterval(function () {
        if (isStopped && isStopped()) {
          clearInterval(poll); delete ameWaiters[key];
          return reject(new Error('__STOPPED__'));
        }
        if (waiter.done) { clearInterval(poll); delete ameWaiters[key]; return; }
        // 兜底 1：文件已落地且大小稳定 → 认为完成
        try {
          if (fs.existsSync(filePath)) {
            var sz = fs.statSync(filePath).size;
            if (sz > 0) {
              setTimeout(function () {
                var sz2 = 0;
                try { if (fs.existsSync(filePath)) sz2 = fs.statSync(filePath).size; } catch (_) {}
                if (sz2 === sz && sz2 > 0) {
                  clearInterval(poll); delete ameWaiters[key];
                  // 若直到文件落地都没收到过任何 AME 回调，说明这个任务很可能
                  // 是 PR 本地渲染完成的（版本不配套 / ME 未就绪），不是 ME 渲的。
                  if (!ameCallbackSeen) resolve({ via: 'file', suspectLocal: true });
                  else resolve({ via: 'file' });
                }
              }, 2000);
              return;
            }
          }
        } catch (_) {}
        if (Date.now() - start > timeoutMs) {
          clearInterval(poll); delete ameWaiters[key];
          reject(new Error('AME 渲染超时'));
        }
      }, 1500);
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
    var isAme = (getChannel() === 'ame');

    try {
      rep(0, '准备');
      var act = await evalHost('meActivateSequence(' + JSON.stringify(seqName) + ')');
      if (act.indexOf('OK:') !== 0) return { ok: false, err: '激活序列失败：' + act };

      // AME 通道：预检 → 拉起 ME → 等就绪 → 再入队
      if (isAme) {
        // 预检（每个序列只查一次）：PR 与 ME 版本必须配套，否则任务会被 PR 本地渲染
        if (!_amePreflightDone) {
          _amePreflightDone = true;
          var pf = await evalHost('mePreflight()');
          try {
            var pj = JSON.parse(pf);
            preflightResult = pj;
            setLog('── AME 预检 ──');
            setLog('  PR ' + (pj.pr && pj.pr.version ? pj.pr.version : '?') +
                   ' ｜ 本机 ME 年份 [' + ((pj.me && pj.me.years) || []).join('/') + ']');
            (pj.warnings || []).forEach(function (w) { setLog('  ⚠ ' + w, 'warn'); });
            if (pj.reason === 'VERSION_MISMATCH') {
              setLog('  ✗ PR 与 ME 版本不配套：队列任务会由 PR 本地渲染（占用 PR，且 ME 队列里看不到）', 'error');
              setLog('  → 建议装与 PR 同版本的 Media Encoder；或把渲染通道切到「PR 直渲」以免误解', 'error');
            } else if (!pj.ok) {
              setLog('  ⚠ 预检未通过（' + (pj.reason || '未知') + '），AME 队列可能不可用', 'warn');
            } else {
              setLog('  ✓ 预检通过：PR 与 ME 配套', 'ok');
            }
          } catch (e) {
            setLog('  ⚠ 预检结果解析失败：' + (e && e.message), 'warn');
          }
        }

        var chk = await evalHost('meEncoderAvailable()');
        if (chk.indexOf('OK:') === 0) {
          var cj = {};
          try { cj = JSON.parse(chk.slice(3)); } catch (_) {}
          if (!cj.available) {
            await unmute();
            return { ok: false, err: 'AME 不可用：' + (cj.reason || '未知原因') + '（可切回 PR 直渲）' };
          }
        }
        bindAmeCallbacks();
        rep(1, '拉起 Media Encoder…');
        setLog('  ⏳ 正在拉起 Media Encoder（首次较慢）…');
        await evalHost('meLaunchEncoder()');
        // 关键：必须等 ME 真的起来再入队，否则任务会落到 PR 本地渲染
        var ready = await waitAmeProcessReady(90000);
        if (ready.already) {
          setLog('  ✓ Media Encoder 已在运行');
        } else if (ready.ok) {
          setLog('  ✓ Media Encoder 已就绪（等待 ' + Math.round(ready.waitedMs / 1000) + 's）', 'ok');
        } else {
          setLog('  ⚠ 等待 Media Encoder 启动超时（' + Math.round(ready.waitedMs / 1000) +
                 's）：任务可能由 PR 本地渲染，请留意 ME 队列里是否有任务', 'warn');
        }
      }

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

        rep(base + 6, (isAme ? '入队' : '导出') + '「' + v.name + '」');
        setLog('▶ [' + seqName + '] ' + v.name + ' → ' + f + (isAme ? '（AME 队列）' : ''));

        if (isAme) {
          // AME 通道：把当前轨道状态下的任务排进 ME 队列
          var rq = await evalHost('meEnqueueAME(' + JSON.stringify(f) + ', ' + JSON.stringify(v.preset) + ', 0)');
          if (rq.indexOf('OK:') !== 0) { await unmute(); return { ok: false, err: '「' + v.name + '」入队失败：' + rq }; }
          var jobId = rq.slice(3);
          ameEnqueuedAt = Date.now();
          setLog('  ✓ 已入队（job ' + jobId + '）');
          ameJobs.push({ jobId: jobId, file: f, version: v.name, out: o });
          // 入队后立即恢复轨道，避免影响下一个版本/后续手动操作
          await unmute();
        } else {
          var r = await evalHost('meExport(' + JSON.stringify(f) + ', ' + JSON.stringify(v.preset) + ', 0)');
          if (r.indexOf('OK:') !== 0) { await unmute(); return { ok: false, err: '「' + v.name + '」提交失败：' + r }; }
          if (stopRequested) { await unmute(); return { stopped: true }; }
          await waitForFile(f, 30 * 60 * 1000, function () { return stopRequested; });
          if (stopRequested) { await unmute(); return { stopped: true }; }
        }

        // AME 模式：此处 renderjob 还没渲染，清单与字幕留到全部完成后统一收尾
        if (isAme) {
          amePendings.push({ seq: seqName, version: v.name, out: o, file: f, duration: seqDur });
          rep(base + span - 2, '「' + v.name + '」已入队');
          continue;
        }

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


  // ── 等 Media Encoder 真正起来（拉起是异步的，冷启动要十几到几十秒）──
  // 为什么需要：meLaunchEncoder() 返回成功只表示"已请求拉起"，不代表 ME 已就绪。
  // 原来拉起后立刻 encodeSequence，冷启动机器上 ME 还没起来，任务就会由 PR
  // 自己的编码器接手 —— 表象是「ME 被拉起来了，但任务没进队列，PR 自己渲了」。
  function ameProcessRunning() {
    try {
      var cp = require('child_process');
      var r = cp.spawnSync('tasklist', ['/FI', 'IMAGENAME eq Adobe Media Encoder.exe', '/NH'],
                           { windowsHide: true, timeout: 8000, encoding: 'utf8' });
      var out = String((r && r.stdout) || '');
      return /Adobe Media Encoder\.exe/i.test(out);
    } catch (e) { return false; }   // 非 Windows 或取不到 → 视为未知，不阻塞
  }
  function waitAmeProcessReady(maxMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      if (ameProcessRunning()) { resolve({ ok: true, waitedMs: 0, already: true }); return; }
      var iv = setInterval(function () {
        if (ameProcessRunning()) {
          clearInterval(iv);
          // 进程起来后再给一小段初始化时间（队列通道建立需要一点时间）
          setTimeout(function () { resolve({ ok: true, waitedMs: Date.now() - t0 }); }, 3000);
          return;
        }
        if (Date.now() - t0 > maxMs) { clearInterval(iv); resolve({ ok: false, waitedMs: Date.now() - t0 }); }
      }, 1500);
    });
  }

  // ── AME 回调健康度：判断任务是否真的被 ME 接走 ──
  // 若入队后迟迟收不到任何 AME 回调，却看到输出文件开始增长，那多半是
  // PR 本地渲染在跑（版本不配套 / ME 没就绪）。这时必须明确告知，不能当成功。
  var ameCallbackSeen = false;    // 本轮是否收到过任一 AME 回调（progress/complete/…）
  var ameEnqueuedAt = 0;

  // ── AME 模式：逐版本入队 + 统一开渲 + 等全部完成 + 收尾 ──────────
  // 关键：插件照你手动流程走——
  //   版本A（禁用某轨 → 选预设 → 入队）→ 版本B（改轨道 → 入队）…
  // 因为 AME 在「入队那一刻」快照序列状态，所以各版本互不影响。
  // 全部排完后调一次 startBatch，渲染全在 ME 后台，PR 不参与。
  async function exportSequencesViaAme(seqs, onProgress) {
    ameJobs = [];
    amePendings = [];
    ameCallbackSeen = false;
    ameEnqueuedAt = 0;
    _amePreflightDone = false;
    var totalSeq = seqs.length;
    var totalJobs = 0;
    // 开始时快照字幕开关与目录：批量跑很久，期间用户可能改界面，
    // 用快照值保证「同一批次」行为一致（逐任务收尾与兜底清扫都用它）。
    var srtOn = chkSubtitle.checked;
    var srtDir = (subtitleDir.value || '').trim();

    // ── 进度模型 ──
    // 入队是「读序列状态 + 递交给 ME」，几秒就完事；渲染才是耗时主体。
    // 旧模型让入队占了 0~40%，进度条几秒冲到 40% 后长时间不动，
    // 按百分比线性外推的剩余时间因此严重失真（显示十几秒，实际好几分钟）。
    var ENQ_END = 5;     // 入队阶段：0 ~ 5%
    var RND_END = 99;    // 渲染阶段：5 ~ 99%
    var renderStartedAt = 0;

    // 剩余时间估算：同序列各版本体量接近，用「已完成任务的均速 × 剩余任务数」
    // 比按总百分比外推准得多。
    function estRemain(jobsDone, total, renderElapsedSec, withinPct) {
      if (jobsDone > 0) {
        var per = renderElapsedSec / jobsDone;      // 平均每个任务耗时
        return Math.max(0, per * (total - jobsDone) - (withinPct / 100) * per);
      }
      // 第一个任务还没完成：用当前任务内部进度粗估单任务耗时
      if (withinPct > 3 && renderElapsedSec > 5) {
        var thisJob = renderElapsedSec / (withinPct / 100);
        return Math.max(0, thisJob * total - renderElapsedSec);
      }
      return null;   // 数据不足，先不显示剩余
    }

    try {
      // 阶段 1：逐序列、逐版本入队
      for (var k = 0; k < seqs.length; k++) {
        if (stopRequested) break;
        var seqName = seqs[k];
        setLog('── 入队 [' + seqName + '] (' + (k + 1) + '/' + totalSeq + ') ──');
        var res = await exportOneSequence(seqName, function (p, t) {
          if (stopRequested) return;
          var overall = (k / totalSeq) * ENQ_END + (p / 100) * (ENQ_END / totalSeq);
          onProgress(overall, t, null);   // 入队很快，不给剩余估算
        });
        if (res.stopped) return { stopped: true };
        if (!res.ok) { setLog('✗ [' + seqName + '] 入队失败：' + res.err, 'error'); return { ok: false, err: res.err }; }
      }
      if (stopRequested) return { stopped: true };
      totalJobs = ameJobs.length;
      if (!totalJobs) return { ok: false, err: '没有任务入队' };

      // 阶段 2：统一开渲
      renderStartedAt = Date.now();
      setLog('════ 已入队 ' + totalJobs + ' 个任务，开始渲染（ME 后台）════');
      onProgress(ENQ_END + 1, 'ME 开始渲染 ' + totalJobs + ' 个任务', null);
      var sb = await evalHost('meStartBatch()');
      if (sb.indexOf('OK:') !== 0) { setLog('⚠ 启动渲染失败：' + sb, 'warn'); }

      // 阶段 3：等每个任务完成（回调优先，文件落地兜底）
      var done = 0;
      var pendByFile = {};
      amePendings.forEach(function (pd) { pendByFile[pd.file] = pd; });
      for (var j = 0; j < ameJobs.length; j++) {
        if (stopRequested) return { stopped: true };
        var job = ameJobs[j];
        var sub = function (pct) {
          // 量纲自适应：AME 进度回调可能是 0~1（官方 AME API 文档写 float 0~1），
          // 也可能是 0~100。当 0~1 当 0~100 用会让进度条几乎不动，所以自动归一。
          var raw = Number(pct);
          if (!isFinite(raw)) raw = 0;
          var within = (raw > 0 && raw <= 1) ? raw * 100 : raw;
          within = Math.max(0, Math.min(100, within));
          var per = (done + within / 100) / ameJobs.length;
          var renderElapsed = (Date.now() - renderStartedAt) / 1000;
          onProgress(
            ENQ_END + per * (RND_END - ENQ_END),
            '渲染中 ' + (done + 1) + '/' + ameJobs.length + '：' + job.version,
            estRemain(done, ameJobs.length, renderElapsed, within)
          );
        };
        setLog('⏳ 渲染「' + job.version + '」…');
        var rr = await waitAmeJob(job.jobId, job.file, 60 * 60 * 1000, function () { return stopRequested; }, sub);
        if (rr && rr.suspectLocal) {
          // 全程没收到任何 AME 回调，文件却出来了 → 几乎可以断定是 PR 本地渲染
          setLog('  ⚠ 未收到 ME 的任何回调，但文件已生成：该任务很可能由 PR 本地渲染完成', 'warn');
          setLog('    （原因通常是 PR 与 Media Encoder 版本不配套，或 ME 未就绪）', 'warn');
        }
        if (rr && rr.err) {
          if (rr.err === '__CANCELED__') { setLog('⏹「' + job.version + '」被取消', 'warn'); }
          else { setLog('✗「' + job.version + '」渲染失败：' + rr.err, 'error'); }
          manifest.push({ seq: job.out ? job.version : '', version: job.version, status: '失败', file: job.file, dir: job.out ? job.out.dir : '', size: '', duration: '' });
        } else {
          done++;
          setLog('✓「' + job.version + '」渲染完成');
          // 该版本对应的 pending：收尾字幕 + 写清单
          var pd = pendByFile[job.file];
          if (pd) {
            var srtNote = '';
            if (srtOn) {
              var sc = await finalizeSidecar(pd.out, srtDir);
              if (sc.found) {
                srtNote = sc.err ? '（字幕未归位：' + sc.err + '）' : ' + srt';
                setLog(sc.err ? ('  ⚠ 字幕未归位：' + sc.target) : ('  ✓ 字幕 ' + sc.target), sc.err ? 'warn' : 'success');
              } else {
                setLog('  ⚠ 未检测到 sidecar 字幕，请确认无字幕版预设已开启「创建 Sidecar 字幕」', 'warn');
              }
            }
            var sz2 = 0;
            try { if (fs.existsSync(job.file)) sz2 = fs.statSync(job.file).size; } catch (_) {}
            manifest.push({
              seq: pd.seq, version: pd.version, status: '成功',
              file: job.file, dir: pd.out.dir, size: fmtSize(sz2), duration: pd.duration
            });
          }
        }
      }

      // 兜底清扫：AME 写 srt 可能晚于任务完成回调，
      // 逐任务收尾可能错过；这里在批量结束后统一再扫一遍输出目录。
      if (srtOn) {
        try {
          var outsAll = amePendings.map(function (pd) { return pd.out; });
          var sw = sweepSidecars(outsAll, srtDir);
          if (sw.moved) setLog('  ✓ 批量兜底：归位 ' + sw.moved + ' 个字幕文件', 'success');
        } catch (e) {
          setLog('  ⚠ 字幕兜底清扫异常：' + (e && e.message), 'warn');
        }
      }

      onProgress(100, '全部完成', 0);
      if (stopRequested) return { stopped: true };
      return { ok: true, done: done, total: totalJobs };
    } catch (e) {
      if (e && e.message === '__STOPPED__') return { stopped: true };
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
    startProgTicker(startTime);   // 已用时间每秒自走，不依赖进度事件
    var doneSeq = 0;

    function overallPercent(seqIdx, inSeqPercent) {
      var base = (seqIdx / totalSeq) * 100;
      var span = (1 / totalSeq) * 100;
      return base + span * (inSeqPercent / 100);
    }

    try {
      if (getChannel() === 'ame') {
        // AME 通道：全部入队 → 统一开渲 → PR 不参与渲染
        var resA = await exportSequencesViaAme(seqs, function (p, t, remain) {
          if (stopRequested) return;
          var elapsed = (Date.now() - startTime) / 1000;
          setProgress(p, t, elapsed, remain === undefined ? null : remain);
        });
        if (resA.stopped) {
          setLog('⏹ 已停止（用户中止）', 'warn');
        } else if (!resA.ok) {
          setLog('✗ AME 流程失败：' + resA.err, 'error');
        } else {
          setProgress(100, '全部完成', (Date.now() - startTime) / 1000, 0);
          setLog('════ AME 批量结束：完成 ' + resA.done + ' / ' + resA.total + ' ════',
                 resA.done === resA.total ? 'success' : 'warn');
        }
        if (chkManifest.checked) writeManifest(manifest);
        try {
          var evsA = enabledVersions();
          if (evsA.length && evsA[0].outDir) lastOutputDir = evsA[0].outDir;
        } catch (_) {}
        return;
      }

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
        // 导出全部成功：记录首个启用版本输出目录，供「打开输出目录」按钮用
        try {
          var evsDone = enabledVersions();
          if (evsDone.length && evsDone[0].outDir) lastOutputDir = evsDone[0].outDir;
        } catch (_) {}
        // 若本次导出是「导出并超分」触发，交给超分流程

      }
    } catch (e) {
      setLog('流程中断：' + e.message, 'error');
      try { await evalHost('meUnmuteAll()'); } catch (_) {}
    } finally {
      stopProgTicker();
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
  // 渲染通道：单选切换即存偏好
  [rndPr, rndAme].forEach(function (el) {
    if (!el) return;
    el.addEventListener('change', function () {
      if (el.checked) setChannel(el.value);
    });
  });
  syncChannelUI();
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

  // 「🔄 刷新序列」：只刷新序列列表（不影响其它配置）
  if (btnRefreshSeq) {
    btnRefreshSeq.addEventListener('click', async function () {
      setLog('刷新序列列表…');
      try { await refreshSequences(); setLog('序列已刷新：' + allSeqs.length + ' 个', 'success'); }
      catch (e) { setLog('刷新序列失败：' + e.message, true); }
    });
  }

  // 「📂 打开输出目录」：打开最近一次导出的输出目录；未导出过则打开当前启用的第一个版本目录
  function openOutputDir() {
    var dir = lastOutputDir;
    if (!dir) {
      try {
        var evs0 = enabledVersions();
        if (evs0.length) dir = evs0[0].outDir || '';
      } catch (_) {}
    }
    if (!dir) { setLog('还没有输出目录（先配置版本输出目录，或完成一次导出）', true); return; }
    if (!fs.existsSync(dir)) { setLog('输出目录不存在：' + dir, true); return; }
    try {
      var cp = require('child_process');
      cp.exec('explorer "' + dir + '"', { windowsHide: true }, function () {});
      setLog('已打开输出目录：' + dir, 'success');
    } catch (e) {
      setLog('打开失败：' + e.message, true);
    }
  }
  if (btnOpenOut) {
    btnOpenOut.addEventListener('click', openOutputDir);
  }

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
