// vh-Atelier 超分面板：一键导出并超分
// 流程：勾选序列 → meExport(无字幕预设, 临时目录) → py/enhance_client.py 上传超分站(720p/14086)
//      → 完成后下载回本地 → 导入当前 PR 工程素材箱（继续剪辑用）
(function () {
  var fs, os, path;
  try {
    fs = require('fs');
    os = require('os');
    path = require('path');
  } catch (e) { return; }
  var csInterface = new CSInterface();
  function evalHost(s) { return new Promise(function (r) { csInterface.evalScript(s, r); }); }

  // UI
  var enSeqList = document.getElementById('enSeqList');
  var enRefSeq = document.getElementById('enRefSeq');
  var enPreset = document.getElementById('enPreset');
  var enFolder = document.getElementById('enFolder');
  var enRes = document.getElementById('enRes');
  var enGo = document.getElementById('enGo');
  var enStop = document.getElementById('enStop');
  var enLog = document.getElementById('enLog');
  var enActHint = document.getElementById('enActHint');

  // 超分站固定参数（用户/密码来自 client 默认）
  var ENHANCE_FOLDER = '14086';
  var ENHANCE_RES = '720p';

  var seqs = [];           // 全量序列
  var checked = [];        // 勾选序列名
  var stopFlag = false;
  var busy = false;

  // 目录规划：
  // tmpRoot   = 无字幕导出过程件（跑完清空，仅此目录被清）
  // resultDir = 超分结果下载位置（默认工程目录/超分结果 子目录；拿不到工程路径时用 collect/enhance_results）
  var tmpRoot = path.join(os.homedir(), 'Documents', 'vhAtelier_enhance_tmp');
  var resultDir = '';   // 运行时确定（async 初始化）

  function log(msg, cls) {
    if (!enLog) return;
    var d = document.createElement('div');
    d.className = cls || '';
    d.textContent = msg;
    enLog.appendChild(d);
    enLog.scrollTop = enLog.scrollHeight;
  }

  function locateExtRoot() {
    var r = '';
    try { r = csInterface.getSystemPath('extension'); } catch (_) {}
    if (r && fs.existsSync(path.join(r, 'py', 'enhance_client.py'))) return r;
    try {
      var d = (typeof __dirname !== 'undefined') ? __dirname : '';
      if (d) {
        var root2 = (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        if (fs.existsSync(path.join(root2, 'py', 'enhance_client.py'))) return root2;
      }
    } catch (_) {}
    return '';
  }
  function findPy() {
    try {
      var root = '';
      try { root = csInterface.getSystemPath('extension'); } catch (_) {}
      if (root && fs.existsSync(path.join(root, 'runtime', 'python.exe'))) return path.join(root, 'runtime', 'python.exe');
      var cands = [
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe')
      ];
      for (var i = 0; i < cands.length; i++) if (fs.existsSync(cands[i])) return cands[i];
    } catch (e) {}
    return 'python';
  }

  // 扫描 AME 预设，找含「无字幕」的 .epr
  function findNoSubtitlePreset() {
    var ameRoot = path.join(os.homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder');
    var hits = [];
    if (fs.existsSync(ameRoot)) {
      try {
        fs.readdirSync(ameRoot).forEach(function (v) {
          var pdir = path.join(ameRoot, v, 'Presets');
          if (!fs.existsSync(pdir)) return;
          fs.readdirSync(pdir).forEach(function (fn) {
            if (/\.epr$/i.test(fn)) {
              hits.push({ name: fn, full: path.join(pdir, fn) });
            }
          });
        });
      } catch (_) {}
    }
    // 无字幕关键字优先
    var noSub = hits.filter(function (h) { return /无字幕|no.?sub/i.test(h.name); });
    var list = noSub.length ? noSub : hits;
    return list;
  }

  function fillPresets() {
    var hits = findNoSubtitlePreset();
    enPreset.innerHTML = '<option value="">自动（含「无字幕」.epr）</option>';
    hits.forEach(function (h) {
      var o = document.createElement('option');
      o.value = h.full;
      o.textContent = h.name;
      enPreset.appendChild(o);
    });
    return hits;
  }

  // 拉取超分站文件夹列表填充下拉（调 python folders --json，登录态自动）
  function loadFolders() {
    if (!enFolder) return;
    var py = findPy();
    var root = locateExtRoot();
    var script = root ? path.join(root, 'py', 'enhance_client.py') : '';
    if (!script || !fs.existsSync(script)) return;
    var cp = require('child_process');
    var cur = enFolder.value;
    enFolder.innerHTML = '<option value="">加载中…</option>';
    cp.exec('"' + py + '" "' + script + '" folders --json', { windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, function (err, stdout) {
      try {
        var arr = JSON.parse(String(stdout || '').trim().split(/\r?\n/).pop());
        if (!Array.isArray(arr)) throw new Error('not array');
        enFolder.innerHTML = '';
        arr.forEach(function (f) {
          var o = document.createElement('option');
          o.value = String(f.ID);
          var desc = f.description ? (' - ' + f.description) : '';
          o.textContent = f.name + desc + '（ID ' + f.ID + '）';
          if (String(f.ID) === cur || String(f.ID) === '14086') o.selected = true;
          enFolder.appendChild(o);
        });
        if (!enFolder.value && arr.length) enFolder.value = String(arr[0].ID);
      } catch (e) {
        enFolder.innerHTML = '<option value="14086">超分（默认 49-58）</option>';
      }
    });
  }

  // 清理临时目录（过程文件）
  function cleanupTmp() {
    try {
      if (fs.existsSync(tmpRoot)) {
        fs.readdirSync(tmpRoot).forEach(function (f) {
          try { fs.unlinkSync(path.join(tmpRoot, f)); } catch (e) {}
        });
      }
    } catch (e) {}
  }

  // 确定超分结果落盘目录：工程目录/超分结果（拿不到就 collect/enhance_results）
  async function resolveResultDir() {
    var dir = '';
    try {
      var r = await evalHost('meProjectDir()');
      if (r && r.indexOf('OK:') === 0) {
        var pd = r.slice(3).trim();
        if (pd) {
          var target = path.join(pd, '超分结果');
          try { fs.mkdirSync(target, { recursive: true }); } catch (e) {}
          if (fs.existsSync(target)) dir = target;
        }
      }
    } catch (e) {}
    if (!dir) {
      var ext = '';
      try { ext = csInterface.getSystemPath('extension'); } catch (e2) {}
      dir = ext ? path.join(ext, 'collect', 'enhance_results') : path.join(tmpRoot, 'results');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e2) {}
    }
    resultDir = dir;
    log('结果将保存到：' + resultDir);
    return dir;
  }

  // 序列列表
  async function refreshSeqs() {
    try {
      var r = await evalHost('meListSequences()');
      if (r.indexOf('OK:') !== 0) { log('读取序列失败：' + r, 'err'); return; }
      seqs = JSON.parse(r.slice(3));
    } catch (e) { log('解析序列失败：' + e.message, 'err'); return; }
    enSeqList.innerHTML = '';
    if (!seqs.length) { enSeqList.innerHTML = '<div class="hint" style="padding:6px 8px;">项目里没有序列</div>'; return; }
    seqs.forEach(function (s) {
      var lab = document.createElement('label');
      lab.className = 'en-seq-item';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.name;
      cb.checked = checked.indexOf(s.name) >= 0;
      cb.addEventListener('change', function () {
        if (cb.checked) { if (checked.indexOf(cb.value) < 0) checked.push(cb.value); }
        else { checked = checked.filter(function (x) { return x !== cb.value; }); }
        updateHint();
      });
      lab.appendChild(cb);
      var span = document.createElement('span');
      span.textContent = s.name;
      span.title = s.name;
      lab.appendChild(span);
      enSeqList.appendChild(lab);
    });
    // 默认勾当前活动序列（第一个）
    if (!checked.length && seqs.length) { checked.push(seqs[0].name); }
    syncCheck();
    updateHint();
  }
  function syncCheck() {
    var cbs = enSeqList.querySelectorAll('input[type=checkbox]');
    cbs.forEach(function (cb) { cb.checked = checked.indexOf(cb.value) >= 0; });
  }
  function updateHint() {
    if (enActHint) enActHint.textContent = checked.length ? ('将导出并超分：' + checked.join('、')) : '未勾选序列';
  }

  // 激活序列 + 导出到临时目录
  function exportOne(seqName, presetPath, outFile) {
    return new Promise(function (resolve, reject) {
      (async function () {
        var act = await evalHost('meActivateSequence(' + JSON.stringify(seqName) + ')');
        if (act.indexOf('OK:') !== 0) return reject(new Error('激活序列失败：' + act));
        log('▶ 导出 ' + seqName + '（无字幕）…');
        var r = await evalHost('meExport(' + JSON.stringify(outFile) + ', ' + JSON.stringify(presetPath) + ', 0)');
        if (r.indexOf('OK:') !== 0) return reject(new Error('导出提交失败：' + r));
        // 等文件出现
        var deadline = Date.now() + 30 * 60 * 1000;
        var timer = setInterval(function () {
          if (stopFlag) { clearInterval(timer); return reject(new Error('__STOPPED__')); }
          if (fs.existsSync(outFile)) {
            var sz = 0;
            try { sz = fs.statSync(outFile).size; } catch (e) {}
            // 文件 >0 且大小稳定（500ms 不变视为写完）
            if (sz > 0) {
              try {
                var s1 = fs.statSync(outFile).size;
                setTimeout(function () {
                  try {
                    var s2 = fs.statSync(outFile).size;
                    if (s2 >= s1) { clearInterval(timer); resolve(outFile); }
                  } catch (e) {}
                }, 1500);
              } catch (e) {}
            }
          }
          if (Date.now() > deadline) { clearInterval(timer); reject(new Error('导出超时')); }
        }, 2000);
      })();
    });
  }

  // 上传超分（只提交建任务，不等待）→ 返回 task_id
  function submitOne(file, folderId, resolution) {
    return new Promise(function (resolve, reject) {
      var py = findPy();
      var root = locateExtRoot();
      var script = root ? path.join(root, 'py', 'enhance_client.py') : '';
      if (!script || !fs.existsSync(script)) return reject(new Error('找不到 enhance_client.py'));
      var cp = require('child_process');
      var args = [script, 'upload', '--file', file, '--folder', String(folderId),
                  '--resolution', String(resolution)];   // 不带 --wait → 提交后立即返回 task_id
      var child = cp.spawn(py, args, { windowsHide: true });
      var buf = '';
      child.stdout.on('data', function (d) { buf += d.toString(); });
      child.stderr.on('data', function (d) { buf += d.toString(); });
      child.on('error', function (e) { reject(new Error('启动 python 失败：' + e.message)); });
      child.on('close', function (code) {
        var last = buf.split(/\r?\n/).filter(Boolean).pop() || '';
        var j = null;
        try { j = JSON.parse(last); } catch (e) {}
        if (j && j.ok && j.task_id) { resolve(j.task_id); }
        else { reject(new Error((j && j.msg) || last || ('退出码 ' + code))); }
      });
    });
  }

  // 拉最近任务状态（python tasks --json）
  function queryTasks() {
    return new Promise(function (resolve) {
      var py = findPy();
      var root = locateExtRoot();
      var script = root ? path.join(root, 'py', 'enhance_client.py') : '';
      if (!script || !fs.existsSync(script)) { resolve([]); return; }
      var cp = require('child_process');
      cp.exec('"' + py + '" "' + script + '" tasks --json', { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, function (err, stdout) {
        try {
          var out = String(stdout || '').trim();
          var arr = JSON.parse(out.split(/\r?\n/).pop());
          resolve(Array.isArray(arr) ? arr : []);
        } catch (e) { resolve([]); }
      });
    });
  }

  // 下载指定任务结果到目录
  function downloadTask(taskId, dir, saveName) {
    return new Promise(function (resolve) {
      var py = findPy();
      var root = locateExtRoot();
      var script = root ? path.join(root, 'py', 'enhance_client.py') : '';
      if (!script || !fs.existsSync(script)) { resolve(''); return; }
      var cp = require('child_process');
      var args = [script, 'download', '--task', String(taskId), '--download-to', dir, '--json'];
      if (saveName) { args.push('--save-name'); args.push(saveName); }
      cp.exec('"' + py + '" "' + args.join('" "') + '"', { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, function (err, stdout) {
        try {
          var out = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
          var j = JSON.parse(out);
          var p = (j && j.path) || '';
          resolve(p && fs.existsSync(p) ? p : '');
        } catch (e) { resolve(''); }
      });
    });
  }


  // 导入 PR 素材箱
  function importToBin(files, binName) {
    return new Promise(function (resolve) {
      try {
        // wsImportToBinPayload 全局变量，host.jsx 读取
        window.wsImportToBinPayload = files;
        csInterface.evalScript('wsImportToBinStr(' + JSON.stringify(binName) + ')', function (r) {
          try { resolve(JSON.parse(r)); } catch (e) { resolve({ error: r }); }
        });
      } catch (e) { resolve({ error: e.message }); }
    });
  }

  // 主流程：阶段1 逐序列 导出→立即提交（不等超分）；阶段2 并行轮询所有任务 → 逐个下载导入
  async function runAll() {
    if (busy) return;
    busy = true;
    stopFlag = false;
    enGo.disabled = true; enStop.disabled = false;
    log('════ 开始导出并超分 ════');
    cleanupTmp();
    var progWrap = document.getElementById('enProgWrap');
    var progFill = document.getElementById('enProgFill');
    var progText = document.getElementById('enProgText');
    var progPct = document.getElementById('enProgPct');
    function setProg(pct, txt) {
      if (!progWrap || !progFill) return;
      progWrap.style.display = 'block';
      progFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      if (progText) progText.textContent = txt || '';
      if (progPct) progPct.textContent = Math.round(pct) + '%';
    }
    try {
      if (!checked.length) { log('请先勾选要超分的序列', 'err'); return; }
      var presetPath = enPreset.value;
      if (!presetPath) {
        var auto = findNoSubtitlePreset();
        if (!auto.length) { log('找不到无字幕导出预设（.epr），请手动选择', 'err'); return; }
        presetPath = auto[0].full;
        log('自动使用预设：' + path.basename(presetPath));
      }
      if (!fs.existsSync(tmpRoot)) { try { fs.mkdirSync(tmpRoot, { recursive: true }); } catch (e) {} }
      var folderId = enFolder && enFolder.value ? enFolder.value : '14086';
      var resolution = enRes ? (enRes.value || '720p') : '720p';
      // 结果目录（项目根/超分结果）
      await resolveResultDir();

      // ===== 阶段1：逐集 导出 → 提交任务（导出串行，因为 AME 一次一个） =====
      var totalN = checked.length;
      var tasks = [];   // { seqName, taskId, status }
      for (var i = 0; i < totalN; i++) {
        if (stopFlag) { log('⏹ 已停止', 'warn'); break; }
        var seqName = checked[i];
        var safe = String(seqName).replace(/[\\/:*?"<>|]/g, '_');
        var outFile = path.join(tmpRoot, safe + '_nosub.mp4');
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) {}
        setProg((i / totalN) * 55, '[' + (i + 1) + '/' + totalN + '] 导出 ' + seqName + ' …');
        log('▶ [' + (i + 1) + '/' + totalN + '] 导出（无字幕）：' + seqName);
        try { await exportOne(seqName, presetPath, outFile); } catch (e) {
          if (e && e.message === '__STOPPED__') break;
          log('✗ 导出失败 ' + seqName + '：' + e.message, 'err');
          continue;
        }
        setProg(((i + 0.6) / totalN) * 55, '[' + (i + 1) + '/' + totalN + '] 上传 ' + seqName + ' …');
        log('🚀 上传超分：' + path.basename(outFile) + '（' + resolution + '）');
        try {
          var tid = await submitOne(outFile, folderId, resolution);
          log('✅ 已提交任务 ID=' + tid + '（' + seqName + '，超分在云端进行，继续下一集）', 'ok');
          tasks.push({ seqName: seqName, taskId: tid, status: 'queued', outFile: outFile });
        } catch (e) {
          log('✗ 上传失败 ' + seqName + '：' + e.message, 'err');
        }
      }
      if (stopFlag) { log('⏹ 阶段1 已停止（已提交 ' + tasks.length + ' 个任务）', 'warn'); }

      // ===== 阶段2：轮询所有任务 → 完成就下载+导入 =====
      if (!tasks.length) { log('没有任何任务提交', 'err'); return; }
      log('════ 全部 ' + tasks.length + ' 集已提交，进入超分等待阶段（云端处理中） ════', 'ok');
      var doneCount = 0;
      var failCount = 0;
      var seenDone = {};
      var pollTicks = 0;
      // 每 20s 查一次全量任务，匹配我们的 taskId
      while (doneCount + failCount < tasks.length) {
        if (stopFlag) { log('⏹ 已停止等待，已完成的仍会下载', 'warn'); break; }
        pollTicks++;
        var list = await queryTasks();
        var byId = {};
        list.forEach(function (t) { byId[t.ID] = t; });
        var changed = false;
        tasks.forEach(function (tk) {
          if (seenDone[tk.taskId]) return;
          var t = byId[tk.taskId];
          if (!t) return;
          var st = t.status;
          tk.status = st;
          if (st === 'succeeded' || st === 'failed') {
            seenDone[tk.taskId] = true;
            changed = true;
            if (st === 'succeeded') {
              doneCount++;
              setProg(55 + (doneCount / tasks.length) * 45, '超分完成：' + tk.seqName + ' → 下载中…');
              log('✅ 超分完成：' + tk.seqName + '（任务 ' + tk.taskId + '），下载中…', 'ok');
              downloadAndImport(tk, resultDir);
            } else {
              failCount++;
              log('✗ 超分失败：' + tk.seqName + '（任务 ' + tk.taskId + '）：' + (t.errorMessage || '未知'), 'err');
            }
          }
        });
        if (changed) {
          var remain = tasks.length - doneCount - failCount;
          log('⏳ 进度：完成 ' + doneCount + ' / 失败 ' + failCount + ' / 等待 ' + remain);
        }
        if (doneCount + failCount >= tasks.length) break;
        // 等待下一轮（最后一轮短等即可）
        await sleep(20000);
      }
      setProg(100, '全部结束：完成 ' + doneCount + '，失败 ' + failCount);
      log('════ 全部结束：成功 ' + doneCount + ' / 失败 ' + failCount + ' ════', failCount ? 'warn' : 'ok');
      cleanupTmp();
      log('🧹 临时导出件已清理（超分结果已保存在 ' + resultDir + '）');
    } catch (e) {
      log('✗ ' + e.message, 'err');
    } finally {
      busy = false;
      enGo.disabled = false; enStop.disabled = true;
      if (progWrap) setTimeout(function () { try { progWrap.style.display = 'none'; } catch (e) {} }, 3000);
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 下载并导入素材箱（异步后台执行）
  function downloadAndImport(tk, dir) {
    (async function () {
      try {
        var dlFile = '';
        try {
          var srcBase = path.basename(tk.outFile).replace(/\.mp4$/i, '');
          dlFile = await downloadTask(tk.taskId, dir, srcBase + '_720p.mp4');
        } catch (e) {}
        if (dlFile && fs.existsSync(dlFile)) {
          log('📥 已下载：' + dlFile);
          var imp = await importToBin([dlFile], tk.seqName);
          if (imp && imp.ok) log('📥 已导入素材箱「' + tk.seqName + '」：' + (imp.imported || []).join('、'), 'ok');
          else log('⚠ 导入素材箱失败：' + ((imp && (imp.error || JSON.stringify(imp))) || '未知'), 'warn');
        } else {
          log('⚠ 下载失败（任务 ' + tk.taskId + '），可稍后到超分站手动下载', 'warn');
        }
      } catch (e) {
        log('⚠ 下载/导入异常：' + e.message, 'warn');
      }
    })();
  }

  function init() {
    if (!enGo || !enSeqList) return;  // 元素不存在（其它面板被禁用时）
    fillPresets();
    loadFolders();
    enRefSeq.addEventListener('click', function () { refreshSeqs(); });
    enGo.addEventListener('click', runAll);
    enStop.addEventListener('click', function () { stopFlag = true; log('⏹ 停止请求已发送…', 'warn'); });
    // 默认加载
    refreshSeqs();
  }

  // 面板显示钩子（main.js 切换时调用）
  window.__enhanceOnShow = function () { refreshSeqs(); };
  init();
})();
