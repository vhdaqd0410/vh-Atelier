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
  // resultDir = 超分结果下载位置（持久保留，PR 素材箱引用它，不清理）
  var tmpRoot = path.join(os.homedir(), 'Documents', 'vhAtelier_enhance_tmp');
  var resultDir = (function () {
    var r = '';
    try { r = csInterface.getSystemPath('extension'); } catch (_) {}
    var base = r ? path.join(r, 'collect', 'enhance_results') : path.join(tmpRoot, 'results');
    try { fs.mkdirSync(base, { recursive: true }); } catch (e) {}
    return base;
  })();

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

  // 上传超分 + 等待 + 下载（调 python）
  function uploadOne(file, outDir, folderId, resolution) {
    return new Promise(function (resolve, reject) {
      var py = findPy();
      var root = locateExtRoot();
      var script = root ? path.join(root, 'py', 'enhance_client.py') : '';
      if (!script || !fs.existsSync(script)) return reject(new Error('找不到 enhance_client.py'));
      var cp = require('child_process');
      var args = [script, 'upload', '--file', file, '--folder', String(folderId),
                  '--resolution', String(resolution), '--wait', '--download-to', outDir];
      log('🚀 上传超分：' + path.basename(file) + '（' + resolution + '，验证码自动识别）');
      var child = cp.spawn(py, args, { windowsHide: true });
      var buf = '';
      child.stdout.on('data', function (d) { buf += d.toString(); });
      child.stderr.on('data', function (d) { buf += d.toString(); });
      child.on('error', function (e) { reject(new Error('启动 python 失败：' + e.message)); });
      child.on('close', function (code) {
        var lines = buf.split(/\r?\n/).filter(Boolean);
        lines.forEach(function (l) { log(l); });
        var last = lines[lines.length - 1] || '';
        var j = null;
        try { j = JSON.parse(last); } catch (e) {}
        if (j && j.ok) {
          if (j.result && j.result.downloaded) { log('✅ 超分完成已下载：' + j.result.downloaded, 'ok'); resolve(j); }
          else { log('✅ 超分任务已提交 ID=' + j.task_id + '（等待轮询）', 'ok'); resolve(j); }
        } else {
          reject(new Error(last || ('退出码 ' + code)));
        }
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

  // 主流程
  async function runAll() {
    if (busy) return;
    busy = true;
    stopFlag = false;
    enGo.disabled = true; enStop.disabled = false;
    log('════ 开始导出并超分 ════');
    // 开始前清一次残留导出件（防上次异常中断遗留）
    cleanupTmp();
    try {
      if (!checked.length) { log('请先勾选要超分的序列', 'err'); return; }
      // 预设：手动选 > 自动无字幕
      var presetPath = enPreset.value;
      if (!presetPath) {
        var auto = findNoSubtitlePreset();
        if (!auto.length) { log('找不到无字幕导出预设（.epr），请手动选择', 'err'); return; }
        presetPath = auto[0].full;
        log('自动使用预设：' + path.basename(presetPath));
      }
      // 输出目录
      if (!fs.existsSync(tmpRoot)) { try { fs.mkdirSync(tmpRoot, { recursive: true }); } catch (e) {} }

      for (var i = 0; i < checked.length; i++) {
        if (stopFlag) break;
        var seqName = checked[i];
        var safe = String(seqName).replace(/[\\/:*?"<>|]/g, '_');
        var outFile = path.join(tmpRoot, safe + '_nosub.mp4');
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) {}
        var exported = await exportOne(seqName, presetPath, outFile);
        if (exported === '__STOPPED__') break;
        // 上传（下载到 resultDir 持久目录，PR 素材箱引用它不会被清理）
        var folderId = enFolder && enFolder.value ? enFolder.value : '14086';
        var resolution = enRes ? (enRes.value || '720p') : '720p';
        var j = await uploadOne(outFile, resultDir, folderId, resolution);
        // 下载成功后文件在 resultDir：enhance_client 存为 源名_720p.mp4
        var dlFile = path.join(resultDir, safe + '_nosub_720p.mp4');
        if (j.result && j.result.downloaded) dlFile = j.result.downloaded;
        if (fs.existsSync(dlFile)) {
          // 导入素材箱（素材箱名=序列名，方便对应）
          var imp = await importToBin([dlFile], seqName);
          if (imp && imp.ok) log('📥 已导入 PR 素材箱「' + seqName + '」：' + (imp.imported || []).join('、'), 'ok');
          else log('⚠ 导入素材箱：' + ((imp && (imp.error || imp.imported)) || '未知'), 'warn');
        } else {
          log('⚠ 未找到超分结果文件：' + dlFile, 'warn');
        }
      }
      log('════ 全部结束 ════', 'ok');
      cleanupTmp();
      log('🧹 临时文件已清理（导出/超分过程文件）');
    } catch (e) {
      log('✗ ' + e.message, 'err');
    } finally {
      busy = false;
      enGo.disabled = false; enStop.disabled = true;
    }
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
