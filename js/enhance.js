// vh-Atelier 超分/去字幕面板：一键导出并处理
// 流程：勾选序列 → meExport(预设, 临时目录) → py/enhance_client.py 上传处理站
//      → 完成后下载回本地 → 导入当前 PR 工程素材箱（继续剪辑用）
// 两种处理类型：
//   enhance 超分（导出无字幕底版 → 放大画质）
//   erase   去字幕（导出有字幕版 → 擦除硬字幕，得到干净画面）
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
  var enResWrap = document.getElementById('enResWrap');
  var enMode = document.getElementById('enMode');
  var enGrabClip = document.getElementById('enGrabClip');
  var enGoClip = document.getElementById('enGoClip');
  var enClipInfo = document.getElementById('enClipInfo');
  var enGo = document.getElementById('enGo');
  var enStop = document.getElementById('enStop');
  var enLog = document.getElementById('enLog');
  var enActHint = document.getElementById('enActHint');
  var enTaskRefresh = document.getElementById('enTaskRefresh');
  var enTaskList = document.getElementById('enTaskList');
  var enTaskTitle = document.getElementById('enTaskTitle');
  var enTaskHint = document.getElementById('enTaskHint');
  var enAccount = document.getElementById('enAccount');
  var enAccHint = document.getElementById('enAccHint');
  var enTaskPickAll = document.getElementById('enTaskPickAll');
  var enTaskDlSel = document.getElementById('enTaskDlSel');
  var enTaskExpand = document.getElementById('enTaskExpand');
  var enTaskCard = document.getElementById('enTaskCard');
  var enLogCard = document.getElementById('enLogCard');
  var enLogExpand = document.getElementById('enLogExpand');
  var enLogClear = document.getElementById('enLogClear');

  // 处理站固定参数（用户/密码来自 client 默认）
  var ENHANCE_FOLDER = '14086';
  var ENHANCE_RES = '720p';
  var folderMap = {};   // folderId -> {name, description}（供任务列表显示文件夹名）

  // 当前处理类型：'enhance'（超分） | 'erase'（去字幕）
  var taskMode = 'enhance';

  var seqs = [];           // 全量序列
  var checked = [];        // 勾选序列名
  var stopFlag = false;
  var busy = false;        // 仅表示「正在导出/上传」（短时），不含等待云端
  var grabbedClip = null;  // 从时间轴抓取的片段 { seqName, startSec, endSec, durationSec, clipCount }

  // ===== 后台任务队列 =====
  // 提交成功后任务进队列，由独立轮询器在后台等结果并自动下载导入。
  // 这样「导出并超分/去字幕」按钮提交完就释放，可以立即提交下一个。
  var bgQueue = [];         // [{ taskId, seqName, mode, status, addedAt }]
  var bgPolling = false;    // 轮询器是否在跑
  var BG_TICK = 15000;      // 轮询间隔 ms
  var bgTimer = null;

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
  // 探测过的可用解释器缓存（避免反复 spawn）
  var _pyResolved = null;
  // 判断某个 python 是否能 import ddddocr（同步探测，带超时）
  function _pyHasDdddocr(exe) {
    try {
      var cp = require('child_process');
      var r = cp.spawnSync(exe, ['-c', 'import ddddocr'], { windowsHide: true, timeout: 20000 });
      return r && r.status === 0;
    } catch (e) { return false; }
  }
  // 找可用的 Python 解释器：优先 runtime/python.exe，其次系统安装；
  // 关键：优先选能 import ddddocr 的（登录需要验证码识别）
  function findPy() {
    if (_pyResolved) return _pyResolved;
    var cands = [];
    try {
      var root = '';
      try { root = csInterface.getSystemPath('extension'); } catch (_) {}
      if (root) cands.push(path.join(root, 'runtime', 'python.exe'));
      ['Python310', 'Python311', 'Python312', 'Python313'].forEach(function (v) {
        cands.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', v, 'python.exe'));
      });
      // py 启动器与 PATH 上的 python 作为兜底
      cands.push('py');
      cands.push('python');
    } catch (e) {}
    var existing = cands.filter(function (c) {
      if (c === 'py' || c === 'python') return true;
      try { return fs.existsSync(c); } catch (e) { return false; }
    });
    if (!existing.length) { _pyResolved = 'python'; return _pyResolved; }
    // 先找带 ddddocr 的
    for (var i = 0; i < existing.length; i++) {
      if (_pyHasDdddocr(existing[i])) {
        _pyResolved = existing[i];
        try { console.log('[vh-enhance] 选用 Python（含 ddddocr）: ' + existing[i]); } catch (e) {}
        return _pyResolved;
      }
    }
    // 都没有 ddddocr：退回第一个存在的，并提示
    _pyResolved = existing[0];
    try { console.log('[vh-enhance] 警告：所有候选 Python 均无 ddddocr，暂用 ' + _pyResolved); } catch (e) {}
    return _pyResolved;
  }

  // 扫描 AME 预设，按关键字筛选 .epr
  function findPresets(re) {
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
    var matched = hits.filter(function (h) { return re.test(h.name); });
    return matched.length ? matched : hits;
  }

  // 无字幕预设（超分用：底版不带字幕）
  function findNoSubtitlePreset() {
    return findPresets(/无字幕|no.?sub/i);
  }

  // 有字幕预设（去字幕用：必须把字幕烧进去才能擦）
  function findSubtitlePreset() {
    return findPresets(/有字幕|交片|成片|with.?sub/i);
  }

  function fillPresets() {
    var hits = findPresets(/\.epr$/i);
    enPreset.innerHTML = '<option value="">自动（按处理类型选预设）</option>';
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
        folderMap = {};
        enFolder.innerHTML = '';
        arr.forEach(function (f) {
          folderMap[String(f.ID)] = { name: f.name || '', description: f.description || '' };
          var o = document.createElement('option');
          o.value = String(f.ID);
          var desc = f.description ? (' - ' + f.description) : '';
          o.textContent = f.name + desc + '（ID ' + f.ID + '）';
          if (String(f.ID) === cur || String(f.ID) === '14086') o.selected = true;
          enFolder.appendChild(o);
        });
        if (!enFolder.value && arr.length) enFolder.value = String(arr[0].ID);
        try { refreshTaskList(); } catch (e) {}   // 映射更新后刷新任务列表（显示文件夹名）
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
    try { log('📋 读到 ' + seqs.length + ' 个序列：' + seqs.map(function (s) { return s.name; }).join(' | ')); } catch (e) {}
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
        lab.className = 'en-seq-item' + (cb.checked ? ' checked' : '');
        updateHint();
      });
      lab.appendChild(cb);
      var span = document.createElement('span');
      span.textContent = s.name;
      span.title = s.name;
      lab.appendChild(span);
      lab.className = 'en-seq-item' + ((checked.indexOf(s.name) >= 0) ? ' checked' : '');
      enSeqList.appendChild(lab);
    });
    // 默认勾当前活动序列（第一个）
    if (!checked.length && seqs.length) { checked.push(seqs[0].name); }
    syncCheck();
    updateHint();
  }
  function syncCheck() {
    var items = enSeqList.querySelectorAll('.en-seq-item');
    items.forEach(function (lab) {
      var cb = lab.querySelector('input[type=checkbox]');
      if (!cb) return;
      var on = checked.indexOf(cb.value) >= 0;
      cb.checked = on;
      lab.className = 'en-seq-item' + (on ? ' checked' : '');
    });
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
    return submitMode(file, folderId, resolution, 'enhance');
  }

  // 提交任务（超分 / 去字幕共用），返回 task_id
  // erase 模式：走火山 VOD 上传（applyVodUpload → PUT → commitVodUpload → createTask）
  function submitMode(file, folderId, resolution, mode) {
    return new Promise(function (resolve, reject) {
      var py = findPy();
      var root = locateExtRoot();
      var script = root ? path.join(root, 'py', 'enhance_client.py') : '';
      if (!script || !fs.existsSync(script)) return reject(new Error('找不到 enhance_client.py'));
      log('（使用 Python：' + py + '）');
      var cp = require('child_process');
      var args;
      if (mode === 'erase') {
        args = [script, 'erase', '--file', file, '--folder', String(folderId)];
      } else {
        args = [script, 'upload', '--file', file, '--folder', String(folderId),
                '--resolution', String(resolution)];
      }
      var child = cp.spawn(py, args, { windowsHide: true });
      var buf = '';
      child.stdout.on('data', function (d) { buf += d.toString(); });
      child.stderr.on('data', function (d) { buf += d.toString(); });
      child.on('error', function (e) { reject(new Error('启动 python 失败（' + py + '）：' + e.message)); });
      child.on('close', function (code) {
        var last = buf.split(/\r?\n/).filter(Boolean).pop() || '';
        var j = null;
        try { j = JSON.parse(last); } catch (e) {}
        if (j && j.ok && j.task_id) { resolve(j.task_id); }
        else {
          var msg = (j && j.msg) || last || ('退出码 ' + code);
          if (/ddddocr/i.test(msg)) {
            msg += '  → 请在 Python 中安装："' + py + '" -m pip install ddddocr（或改用带 ddddocr 的 Python）';
          }
          reject(new Error(msg));
        }
      });
    });
  }

  // 拉任务状态（python tasks/erase-tasks --json）。mode: 'enhance' | 'erase'
  function queryTasks(mode) {
    mode = mode || taskMode;
    return new Promise(function (resolve) {
      var py = findPy();
      var root = locateExtRoot();
      var script = root ? path.join(root, 'py', 'enhance_client.py') : '';
      if (!script || !fs.existsSync(script)) { resolve([]); return; }
      var cp = require('child_process');
      var sub = (mode === 'erase') ? 'erase-tasks' : 'tasks';
      cp.exec('"' + py + '" "' + script + '" ' + sub + ' --json', { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, function (err, stdout) {
        try {
          var out = String(stdout || '').trim();
          var arr = JSON.parse(out.split(/\r?\n/).pop());
          resolve(Array.isArray(arr) ? arr : []);
        } catch (e) { resolve([]); }
      });
    });
  }

  // 下载指定任务结果到目录；onProgress(pct) 实时回调进度（0-100）
  // mode: 'enhance' 走 download 命令；'erase' 走 erase-download
  function downloadTask(taskId, dir, saveName, onProgress, mode) {
    mode = mode || taskMode;
    return new Promise(function (resolve, reject) {
      var py = findPy();
      var root = locateExtRoot();
      var script = root ? path.join(root, 'py', 'enhance_client.py') : '';
      if (!script || !fs.existsSync(script)) {
        return reject(new Error('找不到 enhance_client.py（插件安装不完整）'));
      }
      var cp = require('child_process');
      var args = (mode === 'erase')
        ? [script, 'erase-download', '--task', String(taskId), '--download-to', dir, '--json']
        : [script, 'download', '--task', String(taskId), '--download-to', dir, '--json'];
      if (saveName) { args.push('--save-name'); args.push(saveName); }
      var child = cp.spawn(py, args, { windowsHide: true });
      var outBuf = '';
      var errBuf = '';
      child.stdout.on('data', function (d) { outBuf += d.toString(); });
      child.stderr.on('data', function (d) {
        var s = d.toString();
        // 进度行 DLP:xx（正常进度，不当作错误）
        var m = s.match(/DLP:(\d+)/);
        if (m && onProgress) onProgress(parseInt(m[1], 10));
        // 其余 stderr 内容可能是真实错误（python 异常回显）
        var rest = s.replace(/DLP:\d+\s*/g, '').trim();
        if (rest) errBuf += rest + '\n';
      });
      child.on('error', function (e) {
        reject(new Error('无法启动下载进程：' + (e && e.message ? e.message : e) +
          '（请确认已装 Python，或运行一键部署选 y 装依赖）'));
      });
      child.on('close', function (code) {
        var out = (outBuf || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        var j = null;
        try { j = JSON.parse(out); } catch (e) {}
        // 成功：拿得到路径
        if (j && j.path && fs.existsSync(j.path)) return resolve(j.path);
        // 失败：拼出尽可能具体的理由
        var msg = '';
        if (j && (j.error || j.msg)) msg = j.error || j.msg;
        if (!msg) {
          // python 正常情况下用 out('\u274c ' + str(e)) 输出错误，取最后一行
          var lines = (outBuf || '').trim().split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
          var last = lines.length ? lines[lines.length - 1] : '';
          if (last && !/^\{/.test(last)) msg = last.replace(/^\u274c\s*/, '');
        }
        if (!msg && errBuf) msg = errBuf.trim().split(/\r?\n/).pop();
        if (!msg) msg = 'python 退出码 ' + code + '，无输出（可能脚本异常）';
        reject(new Error(msg));
      });
    });
  }


  // 导入 PR 素材箱
  function importToBin(files, binName) {
    return new Promise(function (resolve) {
      try {
        // 必须通过 evalScript 在 ExtendScript 环境赋值 wsImportToBinPayload（JS window 变量传不过去）
        var payloadJson = JSON.stringify(files || []);
        csInterface.evalScript('wsImportToBinPayload = ' + payloadJson + ';', function () {
          csInterface.evalScript('wsImportToBinStr(' + JSON.stringify(binName) + ')', function (r) {
            try { resolve(JSON.parse(r)); } catch (e) { resolve({ error: r }); }
          });
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
    var isErase = (taskMode === 'erase');
    var modeCN = isErase ? '去字幕' : '超分';
    var binName = isErase ? '去字幕' : '超分';
    log('════ 开始导出并' + modeCN + ' ════');
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
      if (!checked.length) { log('请先勾选要' + modeCN + '的序列', 'err'); return; }
      // 导出前校验：剔除已不存在于项目中的勾选项（如序列被删/改名）
      var validNames = {};
      seqs.forEach(function (s) { validNames[s.name] = true; });
      var missing = checked.filter(function (n) { return !validNames[n]; });
      if (missing.length) {
        log('⚠ 以下勾选项在当前项目中找不到（将跳过）：' + missing.join('、') + '。若列表与 PR 不一致，请点“刷新序列”。', 'warn');
        checked = checked.filter(function (n) { return validNames[n]; });
        syncCheck(); updateHint();
        if (!checked.length) { log('没有可导出的有效序列', 'err'); return; }
      }
      var presetPath = enPreset.value;
      if (!presetPath) {
        var auto = isErase ? findSubtitlePreset() : findNoSubtitlePreset();
        if (!auto.length) {
          log('找不到' + (isErase ? '有字幕' : '无字幕') + '导出预设（.epr），请手动选择', 'err');
          return;
        }
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
        var outFile = path.join(tmpRoot, safe + (isErase ? '.mp4' : '_nosub.mp4'));
        try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) {}
        setProg((i / totalN) * 55, '[' + (i + 1) + '/' + totalN + '] 导出 ' + seqName + ' …');
        log('▶ [' + (i + 1) + '/' + totalN + '] 导出（' + (isErase ? '含字幕' : '无字幕') + '）：' + seqName);
        try { await exportOne(seqName, presetPath, outFile); } catch (e) {
          if (e && e.message === '__STOPPED__') break;
          log('✗ 导出失败 ' + seqName + '：' + e.message, 'err');
          continue;
        }
        setProg(((i + 0.6) / totalN) * 55, '[' + (i + 1) + '/' + totalN + '] 上传 ' + seqName + ' …');
        log('🚀 上传' + modeCN + '：' + path.basename(outFile) + (isErase ? '' : ('（' + resolution + '）')));
        try {
          var tid = await submitMode(outFile, folderId, resolution, taskMode);
          log('✅ 已提交任务 ID=' + tid + '（' + seqName + '，' + modeCN + '在云端进行，继续下一集）', 'ok');
          tasks.push({ seqName: seqName, taskId: tid, status: 'queued', outFile: outFile });
        } catch (e) {
          log('✗ 上传失败 ' + seqName + '：' + e.message, 'err');
        }
      }
      if (stopFlag) { log('⏹ 阶段1 已停止（已提交 ' + tasks.length + ' 个任务）', 'warn'); }

      // ===== 阶段2：交给后台队列轮询（不阻塞界面） =====
      if (!tasks.length) { log('没有任何任务提交', 'err'); return; }
      tasks.forEach(function (tk) { bgEnqueue(tk.taskId, tk.seqName, taskMode); });
      log('════ 全部 ' + tasks.length + ' 集已提交到后台队列 ════', 'ok');
      log('💡 ' + modeCN + '在云端处理中，无需等待——可直接改选其他序列继续提交；结果完成后会自动下载并导入素材箱', 'ok');
      setProg(100, '已提交 ' + tasks.length + ' 个任务，后台自动处理');
      cleanupTmp();
      try { refreshTaskList(); } catch (e) {}
    } catch (e) {
      log('✗ ' + e.message, 'err');
    } finally {
      busy = false;
      enGo.disabled = false; enStop.disabled = true;
      if (progWrap) setTimeout(function () { try { progWrap.style.display = 'none'; } catch (e) {} }, 3000);
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function bgEnqueue(taskId, seqName, mode) {
    bgQueue.push({
      taskId: String(taskId),
      seqName: seqName || '',
      mode: mode || taskMode,
      status: 'queued',
      addedAt: Date.now()
    });
    bgSave();
    bgRender();
    bgStart();
  }

  // 持久化：面板关闭/重开后继续轮询未完成的任务
  var BG_LS = 'vh_enhance_bgqueue';
  function bgSave() {
    try {
      // 只存未完成的（已完成/失败的不用跨会话恢复）
      var keep = bgQueue.filter(function (q) { return q.status === 'queued'; });
      localStorage.setItem(BG_LS, JSON.stringify(keep));
    } catch (e) {}
  }
  function bgLoad() {
    try {
      var raw = localStorage.getItem(BG_LS);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      var now = Date.now();
      arr.forEach(function (q) {
        // 超过 24 小时的不再恢复（任务多半已在云端过期/清理）
        if (q && q.taskId && (now - (q.addedAt || 0)) < 24 * 3600 * 1000) {
          bgQueue.push({
            taskId: String(q.taskId),
            seqName: q.seqName || '',
            mode: q.mode || 'enhance',
            status: 'queued',
            addedAt: q.addedAt || now
          });
        }
      });
      if (bgQueue.length) {
        log('↻ 恢复上次未完成的后台任务 ' + bgQueue.length + ' 个，继续监控', 'ok');
        bgStart();
      }
    } catch (e) {}
  }

  function bgStart() {
    if (bgPolling) return;
    bgPolling = true;
    bgTick();
  }

  async function bgTick() {
    if (!bgQueue.length) {
      bgPolling = false;
      bgSave();
      bgRender();
      return;
    }
    try {
      // 分模式查一次任务列表
      var modes = {};
      bgQueue.forEach(function (q) { if (q.status === 'queued') modes[q.mode] = true; });
      var byMode = {};
      for (var m in modes) {
        if (modes.hasOwnProperty(m)) {
          try { byMode[m] = await queryTasks(m); } catch (e) { byMode[m] = []; }
        }
      }
      var changed = false;
      for (var i = bgQueue.length - 1; i >= 0; i--) {
        var q = bgQueue[i];
        if (q.status !== 'queued') continue;
        var list = byMode[q.mode] || [];
        var hit = null;
        for (var k = 0; k < list.length; k++) {
          if (String(list[k].ID) === q.taskId) { hit = list[k]; break; }
        }
        if (!hit) continue;
        var st = String(hit.status || '').toLowerCase();
        var modeCN = (q.mode === 'erase') ? '去字幕' : '超分';
        if (st === 'succeeded' || st === 'success' || st === 'done') {
          q.status = 'done';
          changed = true;
          log('✅ ' + modeCN + '完成：' + q.seqName + '（任务 ' + q.taskId + '），开始下载…', 'ok');
          // 下载导入走异步，不卡轮询
          bgDownload(q);
        } else if (st === 'failed') {
          q.status = 'failed';
          changed = true;
          log('✗ ' + modeCN + '失败：' + q.seqName + '（任务 ' + q.taskId + '）：' + (hit.errorMessage || '未知'), 'err');
        }
      }
      if (changed) { bgSave(); bgRender(); }
    } catch (e) {
      try { console.log('[vh-enhance] bgTick 异常: ' + e.message); } catch (_) {}
    }
    bgTimer = setTimeout(bgTick, BG_TICK);
  }

  // 下载并导入（后台队列用；不复用 downloadAndImport，因为那个绑定了具体的 dir/mode 流程日志）
  async function bgDownload(q) {
    var isErase = (q.mode === 'erase');
    var binName = isErase ? '去字幕' : '超分';
    try {
      var dir = resultDir || (await resolveResultDir());
      var srcBase = String(q.seqName || ('task_' + q.taskId)).replace(/\.mp4$/i, '').replace(/_nosub$/i, '');
      var saveName = srcBase + (isErase ? '_erased.mp4' : '_720p.mp4');
      var f = await downloadTask(q.taskId, dir, saveName, null, q.mode);
      if (f && fs.existsSync(f)) {
        log('📥 已下载：' + f, 'ok');
        var imp = await importToBin([f], binName);
        if (imp && imp.ok) log('📥 已导入素材箱「' + binName + '」：' + (imp.imported || []).join('、'), 'ok');
        else log('⚠ 导入素材箱失败：' + ((imp && (imp.error || JSON.stringify(imp))) || '未知'), 'warn');
        q.status = 'imported';
      } else {
        log('⚠ 下载失败（任务 ' + q.taskId + '），原因未知', 'warn');
        q.status = 'dlfail';
      }
    } catch (e) {
      log('✗ 下载失败（任务 ' + q.taskId + '）：' + ((e && e.message) || e), 'err');
      q.status = 'dlfail';
    }
    bgSave();
    bgRender();
    try { refreshTaskList(); } catch (e) {}
  }

  // 渲染后台队列状态条（挂到日志区上方；无容器时静默）
  function bgRender() {
    var box = document.getElementById('enBgQueue');
    if (!box) return;
    var pending = bgQueue.filter(function (q) { return q.status === 'queued'; }).length;
    if (!bgQueue.length) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }
    box.style.display = '';
    var rows = bgQueue.map(function (q) {
      var modeCN = (q.mode === 'erase') ? '去字幕' : '超分';
      var label = { queued: '云端处理中', done: '下载中', imported: '✅ 已导入', failed: '❌ 失败', dlfail: '⚠ 下载失败' }[q.status] || q.status;
      var color = { imported: '#7fd68b', failed: '#ff9a9a', dlfail: '#ffb84d', done: '#b39ddb' }[q.status] || '#9a9a9a';
      return '<span style="display:inline-flex;gap:5px;align-items:center;background:#2a2a2a;border:1px solid #3a3a3a;border-radius:4px;padding:2px 8px;margin:2px 4px 2px 0;font-size:10.5px;">' +
             '<span style="color:' + color + ';">' + label + '</span>' +
             '<span style="color:#888;">' + modeCN + ' · ' + (q.seqName || ('#' + q.taskId)) + '</span>' +
             '</span>';
    }).join('');
    box.innerHTML = '<div style="font-size:10.5px;color:#8a8a8a;margin-bottom:3px;">后台任务（' + pending + ' 个在云端处理，可继续提交新任务）' +
      (pending ? ' <a href="#" id="enBgClear" style="color:#7fd68b;">清除已完成</a>' : '') + '</div>' + rows;
    var clr = document.getElementById('enBgClear');
    if (clr) {
      clr.addEventListener('click', function (ev) {
        ev.preventDefault();
        bgQueue = bgQueue.filter(function (q) { return q.status === 'queued'; });
        bgSave();
        bgRender();
      });
    }
  }

  // 汇总查询后台队列里正在进行/已完成的任务（供任务列表页显式标记）
  function bgIsQueued(taskId) {
    taskId = String(taskId);
    for (var i = 0; i < bgQueue.length; i++) {
      if (bgQueue[i].taskId === taskId && bgQueue[i].status === 'queued') return true;
    }
    return false;
  }

  // 下载并导入素材箱（异步后台执行）
  function downloadAndImport(tk, dir, mode) {
    mode = mode || taskMode;
    var isErase = (mode === 'erase');
    var binName = isErase ? '去字幕' : '超分';
    (async function () {
      try {
        var dlFile = '';
        try {
          var srcBase = path.basename(tk.outFile).replace(/\.mp4$/i, '');
          dlFile = await downloadTask(tk.taskId, dir, srcBase + (isErase ? '_erased.mp4' : '_720p.mp4'), null, mode);
        } catch (e) {
          // 保留具体原因：外层只知道"下载失败"，这里能区分网络/令牌过期/磁盘问题
          try { window.__vhLog && window.__vhLog.err((isErase ? '去字幕' : '超分') + '结果下载失败 task=' + tk.taskId, e); } catch (_) {}
          log('⚠ 下载失败（任务 ' + tk.taskId + '）：' + ((e && e.message) || e), 'warn');
        }
        if (dlFile && fs.existsSync(dlFile)) {
          log('📥 已下载：' + dlFile);
          var imp = await importToBin([dlFile], binName);
          if (imp && imp.ok) log('📥 已导入素材箱「' + binName + '」：' + (imp.imported || []).join('、'), 'ok');
          else log('⚠ 导入素材箱失败：' + ((imp && (imp.error || JSON.stringify(imp))) || '未知'), 'warn');
        } else {
          log('⚠ 下载失败（任务 ' + tk.taskId + '），原因未知', 'warn');
        }
      } catch (e) {
        log('⚠ 下载/导入异常：' + e.message, 'warn');
      }
    })();
  }

  // ===== 任务记录列表（超分 / 去字幕 两种模式共用）=====
  function taskStateLabel(st) {
    var base = { pending: '待处理', queued: '排队中', running: '处理中', succeeded: '✅ 完成', failed: '❌ 失败' };
    var label = base[st] || st || '';
    if ((st === 'running' || st === 'queued' || st === 'pending') && taskMode === 'enhance') {
      return { pending: '待处理', queued: '排队中', running: '超分中' }[st] || label;
    }
    return label;
  }
  function taskColor(st) {
    if (st === 'succeeded') return '#7fd68b';
    if (st === 'failed') return '#ff9a9a';
    if (st === 'running') return '#ffd76a';
    return '#9a9a9a';
  }
  function prettyName(fn) {
    var n = String(fn || '');
    n = n.replace(/_nosub\.mp4$/i, '.mp4');
    return n;
  }
  function fmtTime(iso) {
    try {
      var d = new Date(String(iso || '').replace('T', ' ').replace(/\+08:00$/, ''));
      if (isNaN(d.getTime())) return iso ? String(iso).slice(5, 16) : '';
      function p(x) { return x < 10 ? '0' + x : '' + x; }
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }
  var taskDownloading = {};  // taskId -> true（防重复下载）
  var taskPicked = {};       // taskId -> true（勾选待批量下载）
  var taskListCache = [];    // 最近一次拉到的任务列表（供批量下载取文件名）

  async function refreshTaskList() {
    if (!enTaskList) return;
    var list = await queryTasks(taskMode);
    taskListCache = list;
    if (enTaskTitle) enTaskTitle.textContent = taskMode === 'erase' ? '📥 去字幕任务' : '📥 超分任务';
    // 清理已不存在的勾选（换模式/任务消失时）
    var alive = {};
    list.forEach(function (t) { alive[t.ID] = 1; });
    Object.keys(taskPicked).forEach(function (id) { if (!alive[id]) delete taskPicked[id]; });
    var doneCount = list.filter(function (t) { return t.status === 'succeeded'; }).length;
    if (enTaskHint) {
      var pickedN = Object.keys(taskPicked).length;
      enTaskHint.textContent = list.length
        ? ('共 ' + list.length + ' 条 · 已完成 ' + doneCount + (pickedN ? ' · 已选 ' + pickedN : ''))
        : '';
    }
    enTaskList.innerHTML = '';
    if (!list.length) { enTaskList.innerHTML = '<div class="hint" style="padding:8px;">暂无任务</div>'; syncTaskPickUI(); return; }
    list.forEach(function (t) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;padding:4px 6px;border-bottom:1px dashed var(--border);';
      // 主行：勾选框 + 文件名 + 状态 + 下载按钮
      var mainRow = document.createElement('div');
      mainRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
      var canPick = (t.status === 'succeeded' && !taskDownloading[t.ID]);
      if (canPick) {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'en-task-cb';
        cb.checked = !!taskPicked[t.ID];
        cb.title = '勾选后可批量下载';
        cb.addEventListener('change', function () {
          if (cb.checked) taskPicked[t.ID] = 1; else delete taskPicked[t.ID];
          syncTaskPickUI();
        });
        mainRow.appendChild(cb);
      } else {
        var sp = document.createElement('span');
        sp.className = 'en-task-cb-space';
        mainRow.appendChild(sp);
      }
      var nm = document.createElement('span');
      nm.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-weight:600;font-size:11px;';
      nm.textContent = prettyName(t.sourceFileName);
      nm.title = (t.sourceFileName || '') + ' · 任务ID ' + t.ID + (t.resultFileName ? '\n结果: ' + t.resultFileName : '');
      mainRow.appendChild(nm);
      var st = document.createElement('span');
      st.style.cssText = 'flex:0 0 auto;font-weight:600;font-size:11px;color:' + taskColor(t.status) + ';';
      st.textContent = taskStateLabel(t.status);
      mainRow.appendChild(st);
      // 后台队列中的任务：未完成时显式标出
      if (bgIsQueued(t.ID)) {
        var bgTag = document.createElement('span');
        bgTag.style.cssText = 'flex:0 0 auto;color:#b39ddb;font-size:10px;border:1px solid #4a3a6a;border-radius:3px;padding:0 5px;';
        bgTag.textContent = '⏳ 后台等待';
        bgTag.title = '已挂在后台队列，完成后会自动下载并导入素材箱';
        mainRow.appendChild(bgTag);
      }
      // 已完成 → 下载按钮
      if (t.status === 'succeeded' && !taskDownloading[t.ID]) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '⬇ 下载到项目';
        btn.title = taskMode === 'erase'
          ? '下载到当前 PR 项目的「超分结果」目录并导入「去字幕」素材箱'
          : '下载到当前 PR 项目的「超分结果」目录并导入「超分」素材箱';
        btn.style.cssText = 'flex:0 0 auto;background:#1e3a2a;color:#7fd68b;border:1px solid #2a5a3a;border-radius:4px;padding:1px 8px;cursor:pointer;font-size:10px;';
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          downloadTaskToProject(t.ID, t.sourceFileName || '', taskMode);
        });
        mainRow.appendChild(btn);
      } else if (taskDownloading[t.ID]) {
        var dl = document.createElement('span');
        dl.style.cssText = 'flex:0 0 auto;color:#b39ddb;font-size:10px;';
        dl.textContent = '下载中…';
        mainRow.appendChild(dl);
      }
      row.appendChild(mainRow);
      // meta 行：时间 · 文件夹 · 分辨率/费用
      var metaRow = document.createElement('div');
      metaRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:1px;font-size:10px;color:#9a9a9a;';
      var tm = document.createElement('span');
      tm.textContent = '🕐 ' + fmtTime(t.CreatedAt);
      metaRow.appendChild(tm);
      var fmap = folderMap[String(t.folderId)];
      var fd = document.createElement('span');
      fd.style.cssText = 'max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#7fb3d9;';
      fd.textContent = '📁 ' + ((fmap ? fmap.name : ('文件夹' + t.folderId)) + (fmap && fmap.description ? ('·' + fmap.description) : ''));
      fd.title = fmap ? (fmap.name + ' ' + fmap.description) : '';
      metaRow.appendChild(fd);
      if (t.resolution) { var rs = document.createElement('span'); rs.textContent = '🎚 ' + t.resolution; metaRow.appendChild(rs); }
      if (t.costCents) { var cs = document.createElement('span'); cs.textContent = '💰 ¥' + (t.costCents / 100).toFixed(2); metaRow.appendChild(cs); }
      if (t.outputDurationSeconds) { var ds = document.createElement('span'); ds.textContent = '⏱ ' + Math.round(t.outputDurationSeconds) + 's'; metaRow.appendChild(ds); }
      row.appendChild(metaRow);
      enTaskList.appendChild(row);
    });
    syncTaskPickUI();
  }

  // 同步「全选/下载选中」按钮状态
  function syncTaskPickUI() {
    var succeeded = taskListCache.filter(function (t) { return t.status === 'succeeded'; });
    var pickedN = succeeded.filter(function (t) { return taskPicked[t.ID]; }).length;
    if (enTaskPickAll) {
      enTaskPickAll.checked = succeeded.length > 0 && pickedN === succeeded.length;
      enTaskPickAll.indeterminate = pickedN > 0 && pickedN < succeeded.length;
      enTaskPickAll.disabled = succeeded.length === 0;
    }
    if (enTaskDlSel) {
      enTaskDlSel.disabled = pickedN === 0;
      enTaskDlSel.textContent = pickedN ? ('⬇ 下载选中 (' + pickedN + ')') : '⬇ 下载选中';
    }
  }

  // 批量下载勾选的任务（串行，避免同时打满磁盘/带宽）
  async function downloadPicked() {
    var ids = Object.keys(taskPicked).filter(function (id) { return taskPicked[id]; });
    if (!ids.length) { log('请先勾选要下载的任务', 'err'); return; }
    // 找出对应的任务与文件名
    var jobs = [];
    ids.forEach(function (id) {
      var n = parseInt(id, 10);
      var t = null;
      for (var i = 0; i < taskListCache.length; i++) { if (taskListCache[i].ID === n) { t = taskListCache[i]; break; } }
      if (t) jobs.push({ id: n, name: t.sourceFileName || '' });
    });
    if (!jobs.length) { log('勾选的任务已不存在，请刷新列表', 'err'); return; }

    // 不占用 busy（那是导出/分离流程的），单独用一个标记防重入
    if (batchDownloading) { log('批量下载已在进行中…', 'warn'); return; }
    batchDownloading = true;
    if (enTaskDlSel) enTaskDlSel.disabled = true;
    if (enTaskPickAll) enTaskPickAll.disabled = true;
    log('════ 批量下载 ' + jobs.length + ' 个任务 ════');
    var okN = 0, failN = 0;
    var prog = document.getElementById('enProgWrap');
    var fill = document.getElementById('enProgFill');
    var txt = document.getElementById('enProgText');
    var pctEl = document.getElementById('enProgPct');
    function setProg(pct, t) {
      if (!prog) return;
      prog.style.display = 'block';
      if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      if (txt) txt.textContent = t || '';
      if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    }
    try {
      var dir = resultDir || (await resolveResultDir());
      for (var k = 0; k < jobs.length; k++) {
        if (stopFlag) { log('⏹ 已停止批量下载', 'warn'); break; }
        var job = jobs[k];
        setProg((k / jobs.length) * 100, '[' + (k + 1) + '/' + jobs.length + '] 下载 ' + prettyName(job.name));
        var srcBase = String(job.name || ('task_' + job.id)).replace(/\.mp4$/i, '').replace(/_nosub$/i, '');
        var saveName = srcBase + (taskMode === 'erase' ? '_erased.mp4' : '_720p.mp4');
        try {
          var f = await downloadTask(job.id, dir, saveName, null, taskMode);
          if (f && fs.existsSync(f)) {
            okN++;
            delete taskPicked[job.id];
            log('📥 [' + (k + 1) + '/' + jobs.length + '] 已下载：' + path.basename(f), 'ok');
          } else {
            failN++;
            log('✗ [' + (k + 1) + '/' + jobs.length + '] 下载失败（任务 ' + job.id + '）', 'err');
          }
        } catch (e) {
          failN++;
          log('✗ 下载异常（任务 ' + job.id + '）：' + e.message, 'err');
        }
      }
      setProg(100, '批量下载结束：成功 ' + okN + '，失败 ' + failN);
      log('════ 批量下载结束：成功 ' + okN + ' / 失败 ' + failN + ' ════', failN ? 'warn' : 'ok');
      if (okN) log('📁 文件已保存在：' + dir, 'ok');
    } catch (e) {
      log('✗ 批量下载中断：' + e.message, 'err');
    } finally {
      batchDownloading = false;
      refreshTaskList();
      setTimeout(function () { if (prog) { try { prog.style.display = 'none'; } catch (_) {} } }, 4000);
    }
  }
  var batchDownloading = false;

  // 下载某已完成任务到项目根/超分结果 + 导入素材箱（带进度显示）
  var dlProgEls = {};   // taskId -> {row, mainRow, btn}
  function downloadTaskToProject(taskId, srcName, mode) {
    if (taskDownloading[taskId]) return;
    mode = mode || taskMode;
    var isErase = (mode === 'erase');
    var binName = isErase ? '去字幕' : '超分';
    taskDownloading[taskId] = true;
    log('⬇ 开始下载任务 ' + taskId + ' 到项目…');
    refreshTaskList();  // 立即刷新显示“下载中”
    var progEl = makeDlProgress(taskId);
    (async function () {
      try {
        var dir = resultDir || (await resolveResultDir());
        var srcBase = String(srcName || 'task_' + taskId).replace(/\.mp4$/i, '').replace(/_nosub$/i, '');
        var saveName = srcBase + (isErase ? '_erased.mp4' : '_720p.mp4');
        var dlFile = await downloadTask(taskId, dir, saveName, function (pct) {
          if (progEl) { progEl.textContent = '下载中 ' + pct + '%'; progEl.style.color = '#b39ddb'; }
        }, mode);
        if (progEl) progEl.textContent = '下载完成，导入中…';
        if (dlFile && fs.existsSync(dlFile)) {
          log('📥 已下载：' + dlFile, 'ok');
          // 统一导入到对应素材箱（不存在自动创建，存在直接放入）
          var imp = await importToBin([dlFile], binName);
          if (imp && imp.ok) { log('📥 已导入素材箱「' + binName + '」：' + (imp.imported || []).join('、'), 'ok'); if (progEl) progEl.textContent = '✅ 已导入' + binName + '素材箱'; }
          else { log('⚠ 导入素材箱失败：' + ((imp && (imp.error || JSON.stringify(imp))) || '未知'), 'warn'); if (progEl) progEl.textContent = '下载OK·导入失败'; }
        } else {
          log('⚠ 下载失败（任务 ' + taskId + '），请重试', 'err');
          if (progEl) progEl.textContent = '下载失败';
        }
      } catch (e) {
        log('✗ 下载异常：' + e.message, 'err');
        if (progEl) progEl.textContent = '下载异常';
      } finally {
        delete taskDownloading[taskId];
        setTimeout(function () { refreshTaskList(); }, 2500);  // 稍后刷新恢复按钮
      }
    })();
  }

  // 在日志区末尾显示该任务的下载进度行
  function makeDlProgress(taskId) {
    if (!enLog) return null;
    var d = document.createElement('div');
    d.style.cssText = 'color:#b39ddb;font-size:11px;';
    d.textContent = '⬇ 下载任务 ' + taskId + '：准备中…';
    enLog.appendChild(d);
    enLog.scrollTop = enLog.scrollHeight;
    return d;
  }


  // ===== 超分站账号（每台机器各用各的）=====
  var SITE_URL = 'http://subtitle.zztianqiao.com';

  function pyPath() {
    var root = locateExtRoot();
    return root ? path.join(root, 'py', 'enhance_client.py') : '';
  }

  function refreshAccount() {
    if (!enAccHint) return;
    var py = findPy();
    var script = pyPath();
    if (!script || !fs.existsSync(script)) { enAccHint.textContent = ''; return; }
    var cp = require('child_process');
    cp.exec('"' + py + '" "' + script + '" account', { windowsHide: true, timeout: 20000 }, function (err, stdout) {
      var txt = String(stdout || '').trim().split('\n').pop() || '';
      var j = null;
      try { j = JSON.parse(txt); } catch (e) {}
      if (j && j.configured) {
        enAccHint.textContent = '当前账号：' + j.user;
        enAccHint.className = 'en-acc-hint ok';
      } else {
        enAccHint.textContent = '⚠ 未配置超分站账号，请点「⚙ 账号」设置（否则无法提交任务）';
        enAccHint.className = 'en-acc-hint warn';
      }
    });
  }

  function saveAccount(user, pwd, cb) {
    var py = findPy();
    var script = pyPath();
    if (!script || !fs.existsSync(script)) { if (cb) cb('找不到 enhance_client.py'); return; }
    var cp = require('child_process');
    var arg = user + ':' + pwd;
    cp.exec('"' + py + '" "' + script + '" account --file "' + arg.replace(/"/g, '') + '"',
      { windowsHide: true, timeout: 30000 }, function (err, stdout) {
        var out = String(stdout || '').trim();
        if (out.indexOf('已保存') >= 0) { if (cb) cb(null); }
        else { if (cb) cb(out || (err && err.message) || '保存失败'); }
      });
  }

  function openAccountDialog() {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:18px;width:400px;max-width:92vw;';
    box.innerHTML =
      '<div style="font-size:13px;font-weight:600;color:#eee;margin-bottom:8px;">超分站账号</div>' +
      '<div style="font-size:11px;color:#9a9a9a;line-height:1.7;margin-bottom:12px;">' +
        '用于<b style="color:#c9a86a;">超分</b>和<b style="color:#c9a86a;">去字幕</b>任务（subtitle.zztianqiao.com）。' +
        '<br>每台机器填自己的账号，任务和余额互不影响。' +
        '<br>账号只存本地（collect/enhance_account.json），不会外传。' +
      '</div>';
    var lab1 = document.createElement('div');
    lab1.style.cssText = 'font-size:11px;color:#aaa;margin-bottom:4px;';
    lab1.textContent = '账号';
    var in1 = document.createElement('input');
    in1.type = 'text'; in1.placeholder = '你的账号';
    in1.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #444;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:13px;margin-bottom:10px;';
    var lab2 = document.createElement('div');
    lab2.style.cssText = 'font-size:11px;color:#aaa;margin-bottom:4px;';
    lab2.textContent = '密码';
    var in2 = document.createElement('input');
    in2.type = 'password'; in2.placeholder = '你的密码';
    in2.style.cssText = in1.style.cssText.replace('margin-bottom:10px;', 'margin-bottom:12px;');
    var tip = document.createElement('div');
    tip.style.cssText = 'font-size:11px;color:#ffb84d;min-height:16px;margin-bottom:8px;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
    var bWeb = document.createElement('button');
    bWeb.textContent = '🌐 打开网页登录'; bWeb.className = 'secondary mini';
    var bCancel = document.createElement('button');
    bCancel.textContent = '取消'; bCancel.className = 'secondary mini';
    var bSave = document.createElement('button');
    bSave.textContent = '保存'; bSave.className = 'en-go';
    bSave.style.cssText = 'flex:0 0 auto;padding:4px 16px;font-size:12px;';
    row.appendChild(bWeb); row.appendChild(bCancel); row.appendChild(bSave);
    box.appendChild(lab1); box.appendChild(in1);
    box.appendChild(lab2); box.appendChild(in2);
    box.appendChild(tip); box.appendChild(row);
    ov.appendChild(box);
    document.body.appendChild(ov);

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    bWeb.addEventListener('click', function () {
      try { require('child_process').exec('start "" "' + SITE_URL + '"'); } catch (e) {}
      tip.style.color = '#7fd68b';
      tip.textContent = '已用浏览器打开网站，登录后回到这里填账号密码即可';
    });
    bCancel.addEventListener('click', close);
    bSave.addEventListener('click', function () {
      var u = (in1.value || '').trim();
      var p = in2.value || '';
      if (!u || !p) { tip.style.color = '#ff9a9a'; tip.textContent = '账号和密码都要填'; return; }
      tip.style.color = '#c9a86a'; tip.textContent = '保存中…';
      saveAccount(u, p, function (err) {
        if (err) { tip.style.color = '#ff9a9a'; tip.textContent = '保存失败：' + err; return; }
        tip.style.color = '#7fd68b'; tip.textContent = '✅ 已保存，正在重新登录…';
        var cp = require('child_process');
        var py = findPy(); var script = pyPath();
        cp.exec('"' + py + '" "' + script + '" login', { windowsHide: true, timeout: 120000 }, function (e2, so) {
          var t = String(so || '');
          if (t.indexOf('登录成功') >= 0) {
            tip.textContent = '✅ 账号已保存并登录成功';
            refreshAccount();
            setTimeout(close, 1200);
          } else {
            tip.style.color = '#ffb84d';
            tip.textContent = '已保存，但登录失败：' + (t.split('\n').pop() || '请检查账号密码').slice(0, 60);
            refreshAccount();
          }
        });
      });
    });
    in1.focus();
  }

  // 切换处理类型（超分 / 去字幕）：改按钮文案、隐藏不适用项、切换任务列表数据源
  function applyMode() {
    var isErase = (taskMode === 'erase');
    if (enGo && !busy) enGo.textContent = isErase ? '🚀 导出并去字幕' : '🚀 导出并超分';
    if (enResWrap) enResWrap.style.display = isErase ? 'none' : '';   // 去字幕没有分辨率档
    if (enActHint) {
      enActHint.textContent = isErase
        ? '导出含字幕成片 → 上传擦除硬字幕 → 下载导入「去字幕」箱；或时间轴选片段 → 点「处理选中片段」只做该段'
        : '导出无字幕底版 → 上传超分 → 下载导入「超分」箱；或时间轴选片段 → 点「处理选中片段」只做该段';
    }
    try { refreshTaskList(); } catch (e) {}
  }

  // ===== 选中片段模式：从时间轴抓取片段区间，只导出这一段跑完整流程 =====
  // 抓取（只读）：读时间轴当前选中的视频片段，记录序列名 + 起止秒
  // silent=true 时不写日志（供「直接处理」时静默预抓）
  async function grabClip(silent) {
    try {
      var r = await evalHost('meGetSelectedClipInfo()');
      if (!r || r.indexOf('OK:') !== 0) {
        grabbedClip = null;
        var em = r ? r.replace(/^ERR:/, '') : '抓取失败（无返回）';
        renderClipInfo(em);
        if (!silent) log('✗ ' + em, 'err');
        return null;
      }
      var info = JSON.parse(r.slice(3));
      grabbedClip = info;
      renderClipInfo();
      if (!silent) {
        log('✂ 已抓取片段：' + info.seqName + ' ｜ ' + fmtSec(info.startSec) + ' → ' + fmtSec(info.endSec) +
            '（' + fmtSec(info.durationSec) + (info.clipCount > 1 ? '，含 ' + info.clipCount + ' 个选中块（按并集）' : '') + '）', 'ok');
      }
      return info;
    } catch (e) {
      grabbedClip = null;
      renderClipInfo('抓取异常：' + e.message);
      if (!silent) log('✗ 抓取异常：' + e.message, 'err');
      return null;
    }
  }

  function fmtSec(s) {
    var n = Number(s) || 0;
    var m = Math.floor(n / 60);
    var r = n - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + (Math.round(r * 100) / 100);
  }

  // 片段信息条：成功→绿色显示区间；失败/空→显示提示（红色），按钮不禁用
  function renderClipInfo(errMsg) {
    if (!enClipInfo) return;
    if (errMsg) {
      enClipInfo.textContent = '⚠ ' + errMsg;
      enClipInfo.className = 'en-clip-info err';
      enClipInfo.title = errMsg;
      return;
    }
    if (!grabbedClip) {
      enClipInfo.textContent = '未抓取（在时间轴选中片段后点「处理选中片段」即可）';
      enClipInfo.className = 'en-clip-info';
      enClipInfo.title = '';
      return;
    }
    var c = grabbedClip;
    enClipInfo.textContent = c.seqName + ' ｜ ' + fmtSec(c.startSec) + ' → ' + fmtSec(c.endSec) +
      ' （' + fmtSec(c.durationSec) + '）';
    enClipInfo.className = 'en-clip-info has';
    enClipInfo.title = enClipInfo.textContent;
  }

  // 导出抓取到的片段区间（设入出点 → 导出 → 还原入出点）
  function exportRange(seqName, startSec, endSec, presetPath, outFile) {
    return new Promise(function (resolve, reject) {
      var payload = {
        seqName: seqName, startSec: startSec, endSec: endSec,
        outPath: outFile, presetPath: presetPath
      };
      csInterface.evalScript('meRangePayload = ' + JSON.stringify(payload) + ';', function () {
        csInterface.evalScript('meExportRangeStr()', function (r) {
          if (!r) return reject(new Error('导出无返回'));
          if (r.indexOf('OK:') === 0) return resolve(r.slice(3).trim());
          var msg = r.replace(/^ERR:/, '');
          if (msg.indexOf('NOSETINOUT:') === 0) {
            msg = msg.slice('NOSETINOUT:'.length);
          }
          reject(new Error(msg));
        });
      });
    });
  }

  // 跑「选中片段」流程：现场重读选中片段 → 导出区间 → 上传 → 轮询 → 下载导入
  // 不依赖先点「抓取」：没抓过就静默抓一次，避免按钮点不动
  async function runClip() {
    if (busy) return;
    busy = true; stopFlag = false;
    enGo.disabled = true; enGoClip.disabled = true; enStop.disabled = false;
    try {
      // 1) 现场读取选中片段（总是重读，避免用上次的旧区间）
      var info = await grabClip(true);
      if (!info) {
        log('✗ 读不到选中片段：请先在时间轴选中片段（视频轨或音频轨均可，导出按选中区间渲染画面）', 'err');
        return;
      }
      log('✂ 选中区间：' + info.seqName + ' ｜ ' + fmtSec(info.startSec) + ' → ' + fmtSec(info.endSec) +
          '（' + fmtSec(info.durationSec) + (info.clipCount > 1 ? '，含 ' + info.clipCount + ' 个选中块（按并集）' : '') + '）', 'ok');
      await doRunClip(info);
    } finally {
      busy = false;
      enGo.disabled = false;
      enGoClip.disabled = false;
      enStop.disabled = true;
    }
  }

  async function doRunClip(c) {
    var isErase = (taskMode === 'erase');
    var modeCN = isErase ? '去字幕' : '超分';
    var binName = isErase ? '去字幕' : '超分';
    log('════ 开始处理选中片段（' + modeCN + '） ════');
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
      var presetPath = enPreset.value;
      if (!presetPath) {
        var auto = isErase ? findSubtitlePreset() : findNoSubtitlePreset();
        if (!auto.length) { log('找不到' + (isErase ? '有字幕' : '无字幕') + '导出预设（.epr），请手动选择', 'err'); return; }
        presetPath = auto[0].full;
        log('自动使用预设：' + path.basename(presetPath));
      }
      var folderId = enFolder && enFolder.value ? enFolder.value : ENHANCE_FOLDER;
      var resolution = enRes ? (enRes.value || ENHANCE_RES) : ENHANCE_RES;
      await resolveResultDir();

      var safe = String(c.seqName).replace(/[\\/:*?"<>|]/g, '_');
      if (!fs.existsSync(tmpRoot)) { try { fs.mkdirSync(tmpRoot, { recursive: true }); } catch (e) {} }
      var outFile = path.join(tmpRoot, safe + (isErase ? '_clip.mp4' : '_clip_nosub.mp4'));
      try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (e) {}

      setProg(6, '导出区间 ' + fmtSec(c.startSec) + ' → ' + fmtSec(c.endSec) + ' …');
      log('▶ 导出区间（' + (isErase ? '含字幕' : '无字幕') + '）：' + c.seqName + ' ' + fmtSec(c.startSec) + '→' + fmtSec(c.endSec));
      await exportRange(c.seqName, c.startSec, c.endSec, presetPath, outFile);
      // 等文件落地
      var deadline = Date.now() + 30 * 60 * 1000;
      while (!fs.existsSync(outFile) && Date.now() < deadline) {
        if (stopFlag) throw new Error('__STOPPED__');
        await sleep(700);
      }
      if (!fs.existsSync(outFile)) throw new Error('导出超时，未生成文件');
      var mb = Math.round(fs.statSync(outFile).size / 1048576 * 10) / 10;
      log('✅ 片段已导出（' + mb + ' MB），上传' + modeCN + '…', 'ok');

      setProg(30, '上传' + modeCN + '…');
      var tid = await submitMode(outFile, folderId, resolution, taskMode);
      log('✅ 已提交任务 ID=' + tid + '，已挂到后台处理', 'ok');
      setProg(100, '已提交，后台处理中');

      // 交给后台队列：不阻塞界面，完成后自动下载导入
      bgEnqueue(tid, c.seqName || ('片段 ' + fmtSec(c.startSec)), taskMode);
      log('💡 ' + modeCN + '在云端处理中，无需等待——可立即选其他片段继续处理', 'ok');
      log('════ 选中片段已提交 ════', 'ok');
      try { refreshTaskList(); } catch (e) {}
    } catch (e) {
      if (e && e.message === '__STOPPED__') log('⏹ 已停止', 'warn');
      else log('✗ ' + e.message, 'err');
    } finally {
      if (progWrap) setTimeout(function () { try { progWrap.style.display = 'none'; } catch (e) {} }, 3000);
    }
  }

  // ===== 任务卡 / 日志卡 展开：占满面板（与内嵌站展开同一套交互）=====
  (function () {
    var STORE_X = 'vh_upscale_card_exp';   // '' | 'task' | 'log'

    function setCardExpanded(which, save) {
      var panel = document.getElementById('panel-upscale');
      if (!panel) return;
      // 先清掉旧态
      panel.classList.remove('en-exp-task');
      panel.classList.remove('en-exp-log');
      function restore(btn) { if (btn) { btn.textContent = '⤢'; btn.title = '展开：占满面板（再点还原）'; } }
      restore(enTaskExpand); restore(enLogExpand);
      if (!which) {
        if (save) { try { localStorage.setItem(STORE_X, ''); } catch (e) {} }
        return;
      }
      if (which === 'task') {
        panel.classList.add('en-exp-task');
        if (enTaskExpand) { enTaskExpand.textContent = '⤡'; enTaskExpand.title = '还原：恢复并排布局'; }
      } else {
        panel.classList.add('en-exp-log');
        if (enLogExpand) { enLogExpand.textContent = '⤡'; enLogExpand.title = '还原：恢复并排布局'; }
      }
      if (save) { try { localStorage.setItem(STORE_X, which); } catch (e) {} }
    }

    function toggle(which) {
      var panel = document.getElementById('panel-upscale');
      if (!panel) return;
      var already = panel.classList.contains(which === 'task' ? 'en-exp-task' : 'en-exp-log');
      setCardExpanded(already ? '' : which, true);
    }

    if (enTaskExpand) enTaskExpand.addEventListener('click', function () { toggle('task'); });
    if (enLogExpand) enLogExpand.addEventListener('click', function () { toggle('log'); });
    if (enLogClear) enLogClear.addEventListener('click', function () { if (enLog) enLog.innerHTML = ''; });

    // 恢复上次
    var saved = '';
    try { saved = localStorage.getItem(STORE_X) || ''; } catch (e) {}
    if (saved === 'task' || saved === 'log') setCardExpanded(saved, false);

    // 绑定批量下载相关
    if (enTaskPickAll) {
      enTaskPickAll.addEventListener('change', function () {
        var on = enTaskPickAll.checked;
        taskListCache.forEach(function (t) {
          if (t.status !== 'succeeded') return;
          if (on) taskPicked[t.ID] = 1; else delete taskPicked[t.ID];
        });
        refreshTaskList();
      });
    }
    if (enTaskDlSel) enTaskDlSel.addEventListener('click', downloadPicked);
  })();

  function init() {
    if (!enGo || !enSeqList) return;  // 元素不存在（其它面板被禁用时）
    fillPresets();
    loadFolders();
    enRefSeq.addEventListener('click', function () { refreshSeqs(); });
    enGo.addEventListener('click', runAll);
    enStop.addEventListener('click', function () { stopFlag = true; log('⏹ 停止请求已发送…', 'warn'); });
    if (enMode) {
      // 记住上次选择（存在则回填）
      var saved = '';
      try { saved = localStorage.getItem('vh_enhance_mode') || ''; } catch (e) {}
      if (saved === 'erase' || saved === 'enhance') { taskMode = saved; enMode.value = saved; }
      enMode.addEventListener('change', function () {
        taskMode = (enMode.value === 'erase') ? 'erase' : 'enhance';
        try { localStorage.setItem('vh_enhance_mode', taskMode); } catch (e) {}
        applyMode();
        log('处理类型：' + (taskMode === 'erase' ? '去字幕（擦除硬字幕）' : '超分（放大画质）'));
      });
    }
    var enEnvBtn = document.getElementById('enEnv');
    if (enEnvBtn) enEnvBtn.addEventListener('click', checkEnv);
    if (enAccount) enAccount.addEventListener('click', openAccountDialog);
    if (enTaskRefresh) enTaskRefresh.addEventListener('click', function () { refreshTaskList(); });
    if (enGrabClip) enGrabClip.addEventListener('click', function () { grabClip(false); });
    if (enGoClip) enGoClip.addEventListener('click', runClip);
    // 按钮始终可点（不再依赖先抓取），初始信息条只做提示
    if (enGoClip) enGoClip.disabled = false;
    // 默认加载
    applyMode();
    renderClipInfo();
    refreshSeqs();
    refreshTaskList();
    bgLoad();           // 恢复上次未完成的后台任务
  }

  // 检测 Python 环境：逐个候选报告是否能 import ddddocr
  function checkEnv() {
    log('════ 环境检测 ════');
    var cands = [];
    try {
      var root = '';
      try { root = csInterface.getSystemPath('extension'); } catch (_) {}
      if (root) cands.push(path.join(root, 'runtime', 'python.exe'));
      ['Python310', 'Python311', 'Python312', 'Python313'].forEach(function (v) {
        cands.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', v, 'python.exe'));
      });
    } catch (e) {}
    var cp = require('child_process');
    var any = false;
    cands.forEach(function (exe) {
      var isPath = (exe === 'py' || exe === 'python');
      var exists = isPath ? true : (function () { try { return fs.existsSync(exe); } catch (e) { return false; } })();
      if (!exists) { log('  ✖ 不存在：' + exe); return; }
      try {
        var r = cp.spawnSync(exe, ['-c', 'import ddddocr'], { windowsHide: true, timeout: 25000 });
        if (r && r.status === 0) { log('  ✅ ddddocr 可用：' + exe, 'ok'); any = true; }
        else { log('  ⚠ 无 ddddocr：' + exe); }
      } catch (e) { log('  ⚠ 探测失败：' + exe + '（' + e.message + '）'); }
    });
    if (any) { log('环境正常，可直接导出并超分。', 'ok'); }
    else {
      log('未找到含 ddddocr 的 Python。请在其中一个解释器执行安装：', 'err');
      log('  "<上面任一 python.exe>" -m pip install ddddocr');
      log('  或安装到指定版本："...\\Python310\\python.exe" -m pip install ddddocr');
    }
  }

  // 面板显示钩子（main.js 切换时调用）
  window.__enhanceOnShow = function () { refreshSeqs(); refreshTaskList(); };

  // ===== 内嵌站（去字幕站）高度：拖拽分隔条 + 展开/还原 =====
  (function () {
    var panel = document.getElementById('panel-upscale');
    var frame = document.getElementById('upscaleFrame');
    var splitter = document.getElementById('upSplitter');
    var expandBtn = document.getElementById('upExpand');
    if (!panel || !frame || !splitter) { init(); return; }

    var STORE_H = 'vh_upscale_frame_h';
    var STORE_X = 'vh_upscale_expanded';
    var DEFAULT_H = 260;
    var MIN_TOP = 110;   // 操作区保底高度
    var MIN_FRAME = 80;  // 内嵌站最小高度

    function clampH(h) {
      var total = panel.clientHeight || 600;
      var max = Math.max(MIN_FRAME, total - MIN_TOP);
      if (h < MIN_FRAME) { h = MIN_FRAME; }
      if (h > max) { h = max; }
      return Math.round(h);
    }

    function applyH(h, save) {
      h = clampH(h);
      frame.style.flex = '0 0 ' + h + 'px';
      frame.style.height = h + 'px';
      if (save) { try { localStorage.setItem(STORE_H, String(h)); } catch (e) {} }
      return h;
    }

    function isExpanded() { return panel.classList.contains('en-expanded'); }

    function setExpanded(on, save) {
      if (on) { panel.classList.add('en-expanded'); expandBtn.textContent = '⤡'; expandBtn.title = '还原：恢复操作区（再点展开）'; }
      else { panel.classList.remove('en-expanded'); expandBtn.textContent = '⤢'; expandBtn.title = '展开：内嵌站占满整个面板（再点还原）'; applyH(parseInt(localStorage.getItem(STORE_H) || DEFAULT_H, 10), false); }
      if (save) { try { localStorage.setItem(STORE_X, on ? '1' : '0'); } catch (e) {} }
    }

    // 恢复上次状态
    var savedH = parseInt(localStorage.getItem(STORE_H) || DEFAULT_H, 10);
    if (isNaN(savedH)) { savedH = DEFAULT_H; }
    applyH(savedH, false);
    if (localStorage.getItem(STORE_X) === '1') { setExpanded(true, false); }

    // 拖拽
    var dragging = false, startY = 0, startH = 0;
    function onDown(e) {
      if (isExpanded()) { return; }
      dragging = true;
      startY = e.clientY;
      startH = frame.getBoundingClientRect().height;
      splitter.classList.add('active');
      document.body.style.cursor = 'row-resize';
      try { e.preventDefault(); } catch (_) {}
      // 拖拽期间禁用 iframe 抢事件
      frame.style.pointerEvents = 'none';
    }
    function onMove(e) {
      if (!dragging) { return; }
      var dy = startY - e.clientY;   // 往上拖 = 变大
      applyH(startH + dy, false);
      try { e.preventDefault(); } catch (_) {}
    }
    function onUp() {
      if (!dragging) { return; }
      dragging = false;
      splitter.classList.remove('active');
      document.body.style.cursor = '';
      frame.style.pointerEvents = '';
      try { localStorage.setItem(STORE_H, String(Math.round(frame.getBoundingClientRect().height))); } catch (e) {}
    }

    splitter.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // 双击分隔条：还原默认高度
    splitter.addEventListener('dblclick', function () { applyH(DEFAULT_H, true); });

    if (expandBtn) {
      expandBtn.addEventListener('click', function () { setExpanded(!isExpanded(), true); });
    }

    init();
  })();
})();
