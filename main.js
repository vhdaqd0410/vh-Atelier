'use strict';
/**
 * vh-Atelier · DaVinci Resolve 版
 * Electron 主进程：窗口创建 + IPC 路由 + 导出进度推送
 */

const { app, BrowserWindow, ipcMain, dialog, shell, session, WebContentsView } = require('electron');
const path = require('path');
const vhUpdater = require('./updater-main');

// ==================== 缓存控制（重要）====================
// Resolve 里所有 Workflow Integration 插件共用 %APPDATA%\Electron 这个 userData，
// Chromium 会把插件页面引用的 JS/CSS 缓存下来。结果是：源码改了、文件也同步了，
// 但插件里跑的还是旧版本（表现为"功能没反应"）。
// 这里在窗口创建前彻底关掉 HTTP/磁盘缓存，保证每次都从文件读最新代码。
app.commandLine.appendSwitch('disable-http-cache');
app.commandLine.appendSwitch('disable-features', 'NetworkServiceInProcess');

/** 清掉除用户数据外的缓存目录（Local Storage 保留，否则会丢配置） */
function purgeCaches() {
  try {
    const ud = app.getPath('userData');
    const kill = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache',
                  'DawnWebGPUCache', 'Service Worker', 'Shared Dictionary'];
    kill.forEach(function (name) {
      const p2 = path.join(ud, name);
      try {
        if (require('fs').existsSync(p2)) {
          require('fs').rmSync(p2, { recursive: true, force: true });
        }
      } catch (e) { /* 被占用就跳过 */ }
    });
  } catch (e) { /* 忽略 */ }
}
const host = require('./js/resolve-host');
const svc = require('./localsvc');
const ncmHost = require('./ncm-host');

let mainWindow = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const onExportTick = (snap) => send('export:progress', snap);

// ==================== IPC 路由 ====================

function wrap(fn) {
  return async (_event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  };
}

function registerHandlers() {
  // 连通性
  ipcMain.handle('host:ping', wrap(() => host.ping()));
  ipcMain.handle('host:productInfo', wrap(() => host.getProductInfo()));

  // 时间线
  ipcMain.handle('host:listTimelines', wrap(() => host.listTimelines()));
  ipcMain.handle('host:rangeInfo', wrap((mode) => host.getRangeInfo(mode)));
  ipcMain.handle('host:timelineDetail', wrap((name) => host.getTimelineDetail(name)));
  ipcMain.handle('host:audioClips', wrap((name) => host.listAudioClipsWithPath(name)));
  ipcMain.handle('host:audioTracks', wrap((name) => host.listAudioTracks(name)));

  // 渲染预设
  ipcMain.handle('host:renderPresets', wrap(() => host.listRenderPresets()));

  // 素材
  ipcMain.handle('host:importMedia', wrap((paths) => host.importMedia(paths)));
  ipcMain.handle('host:openPage', wrap((page) => host.openPage(page)));
  ipcMain.handle('host:listSubDirs', wrap((rootPath) => host.listSubDirs(rootPath)));

  // 声音 / 素材池
  ipcMain.handle('host:importFilesToPool', wrap((paths, folder) => host.importFilesToPool(paths, folder)));
  ipcMain.handle('host:insertAudioToTimeline', wrap((opts) => host.insertAudioToTimeline(opts)));
  ipcMain.handle('host:listTimelineNames', wrap(() => host.listTimelineNames()));
  ipcMain.handle('host:getPlayhead', wrap((name) => host.getPlayhead(name)));
  ipcMain.handle('host:setAudioClipProps', wrap((name, props, opts) => host.setAudioClipProps(name, props, opts)));
  ipcMain.handle('host:readAudioClipProps', wrap((name, idx, opts) => host.readAudioClipProps(name, idx, opts)));

  // 本地服务（ffmpeg / 分离引擎）
  ipcMain.handle('svc:capabilities', wrap(() => svc.capabilities()));
  ipcMain.handle('svc:probe', wrap((p) => svc.probe(p)));
  ipcMain.handle('svc:extractAudio', wrap((opts) => svc.extractAudio(opts)));
  ipcMain.handle('svc:separateVocals', wrap((opts) => svc.separateVocals(opts)));
  ipcMain.handle('svc:toMp3', wrap((opts) => svc.toMp3(opts)));

  // ==================== 语音克隆（CosyVoice3） ====================
  // 引擎复用用户已装的 CosyVoice3 工具（默认 D:\cosyvoice3_V30），不往插件塞 13.7GB 模型。
  const clonePaths = {
    internal: 'D:\\cosyvoice3_V30\\_internal',
    matcha: 'D:\\cosyvoice3_V30\\third_party\\Matcha-TTS',
    modelDir: 'D:\\cosyvoice3_V30\\pretrained_models'
  };
  function findPythonForClone() {
    const fsm = require('fs');
    const osm = require('os');
    const cps = require('child_process');
    const cands = [
      path.join(osm.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
      path.join(osm.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'),
      path.join(osm.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
      'C:\\Program Files\\Python310\\python.exe',
      'C:\\Program Files\\Python311\\python.exe'
    ];
    for (const c of cands) { if (fsm.existsSync(c)) return c; }
    try {
      const w = cps.spawnSync('where', ['python'], { encoding: 'utf8' });
      if (w.status === 0 && w.stdout) {
        for (const line of w.stdout.split(/\r?\n/)) {
          const p2 = line.trim();
          if (p2 && p2.indexOf('WindowsApps') < 0) return p2;
        }
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }
  function cloneEnv() {
    const fsm = require('fs');
    const python = findPythonForClone();
    const cli = path.join(__dirname, 'py', 'cosyvoice_cli.py');
    const hasInternal = fsm.existsSync(clonePaths.internal);
    const hasModel = fsm.existsSync(path.join(clonePaths.modelDir, 'llm.pt'));
    const hasCli = fsm.existsSync(cli);
    if (!python) return { ok: false, error: '未找到 Python（CosyVoice3 需要）', python: null };
    if (!hasInternal || !hasModel) {
      return { ok: false, python: python, error: '未找到 CosyVoice3 引擎：' + clonePaths.modelDir };
    }
    if (!hasCli) return { ok: false, python: python, error: '缺少 py/cosyvoice_cli.py' };
    return { ok: true, python: python, model: clonePaths.modelDir };
  }
  ipcMain.handle('clone:env', wrap(() => cloneEnv()));
  // 抓取时间线选中音频片段 → 截成参考 wav（供 CosyVoice 用）
  let cloneJar = { child: null };
  ipcMain.handle('clone:grabSelection', wrap(async () => {
    const clips = await host.readAudioClipProps('', null, { onlySelected: true });
    if (!clips || !clips.length) throw new Error('时间线未选中音频片段');
    const c = clips[0];
    if (!c.filePath) throw new Error('该片段取不到文件路径（可能是生成器）');
    // 用素材内偏移，避免时间线位置 ≠ 素材位置（同人声分离踩过的坑）
    const opts = { input: c.filePath, outDir: svc.workDir('vc_ref'), output: null };
    if (c.sourceStartSec !== null && c.sourceStartSec !== undefined) {
      opts.startSec = c.sourceStartSec;
      if (c.sourceEndSec !== null && c.sourceEndSec !== undefined) {
        const dur = Math.max(0.5, c.sourceEndSec - c.sourceStartSec);
        opts.durationSec = Math.min(30, dur);   // CosyVoice 参考音频 <=30s
      }
    }
    const r = await svc.extractAudio(opts);
    const sec = await svc.probeAudioSeconds(r.output, r.sizeBytes).catch(() => 0);
    return { path: r.output, name: c.name || path.basename(c.filePath), seconds: sec };
  }));
  ipcMain.handle('clone:stop', wrap(() => {
    if (cloneJar.child) {
      try {
        if (process.platform === 'win32' && cloneJar.child.pid) {
          require('child_process').execFile('taskkill',
            ['/PID', String(cloneJar.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else { cloneJar.child.kill('SIGKILL'); }
      } catch (e) { /* 忽略 */ }
      cloneJar.child = null;
    }
    return { ok: true };
  }));
  ipcMain.handle('clone:run', wrap(async (cfg) => {
    const fsm = require('fs');
    const osm = require('os');
    const cps = require('child_process');
    const env = cloneEnv();
    if (!env.ok) throw new Error(env.error || '引擎未就绪');
    const tmpDir = path.join(osm.tmpdir(), 'vc_clone');
    try { fsm.mkdirSync(tmpDir, { recursive: true }); } catch (e) { /* 忽略 */ }
    const outWav = path.join(tmpDir, 'clone_' + Date.now() + '.wav');
    const cfgPath = path.join(tmpDir, 'clone_cfg.json');
    const c = Object.assign({}, cfg, {
      out_wav: outWav,
      internal: clonePaths.internal,
      matcha: clonePaths.matcha,
      model_dir: clonePaths.modelDir
    });
    fsm.writeFileSync(cfgPath, JSON.stringify(c), 'utf8');
    const cli = path.join(__dirname, 'py', 'cosyvoice_cli.py');
    const t0 = Date.now();
    const r = await new Promise((resolve) => {
      const child = cps.execFile(env.python, [cli, cfgPath], {
        timeout: 1800000, maxBuffer: 1024 * 1024 * 50, windowsHide: true
      }, (err, stdout, stderr) => { cloneJar.child = null; resolve({ err: err, stdout: stdout, stderr: stderr }); });
      cloneJar.child = child;
    });
    const seconds = (Date.now() - t0) / 1000;
    const line = String(r.stdout || '').trim().split(/\r?\n/)
      .filter(l => l.trim().indexOf('{') === 0).pop();
    let res = null;
    try { res = JSON.parse(line); } catch (e) { res = null; }
    if (res && res.ok) return Object.assign({ seconds: seconds }, res);
    const detail = (String(r.stderr || '') + ' ' + String(r.stdout || '')).slice(0, 600);
    throw new Error((res && res.error) || (r.err && r.err.message) || detail || '合成失败');
  }));

  // ==================== Breeze 朗读（本地 GGUF，直调 breeze-cli） ====================
  // 与 PR 版差异：PR 渲染进程可直接 spawn，达芬奇是 contextIsolation，
  // 所以子进程一律放在主进程，渲染进程通过 IPC 拿进度事件。
  const BZ_DIR = path.join(__dirname, 'breeze');
  const BZ_ENGINE = path.join(BZ_DIR, 'engine');
  const BZ_MODEL = path.join(BZ_DIR, 'models', 'breeze-tts-2-q4_k-dd2.gguf');
  const BZ_CLI = path.join(BZ_ENGINE, 'breeze-cli.exe');
  const BZ_VOICES = path.join(BZ_ENGINE, 'voices');

  let bzChild = null;
  let bzSeq = 0;

  function bzEnv() {
    const fsm = require('fs');
    const hasCli = fsm.existsSync(BZ_CLI);
    const hasModel = fsm.existsSync(BZ_MODEL);
    let modelSize = 0;
    try { modelSize = hasModel ? fsm.statSync(BZ_MODEL).size : 0; } catch (e) { modelSize = 0; }
    let voices = [];
    try {
      if (fsm.existsSync(BZ_VOICES)) {
        voices = fsm.readdirSync(BZ_VOICES)
          .filter(f => /\.(wav|mp3|flac|m4a)$/i.test(f))
          .map(f => {
            let sec = 0;
            return { id: f, name: f.replace(/\.[^.]+$/, ''), file: path.join(BZ_VOICES, f), seconds: sec };
          });
      }
    } catch (e) { voices = []; }
    return {
      ok: hasCli && hasModel && modelSize > 1500 * 1024 * 1024,
      hasCli: hasCli,
      hasModel: hasModel,
      modelSizeMB: Math.round(modelSize / 1048576),
      engine: BZ_ENGINE,
      model: BZ_MODEL,
      outDir: path.join(BZ_DIR, 'output'),
      voices: voices,
      error: !hasCli ? ('缺少引擎：' + BZ_CLI)
           : (!hasModel ? ('缺少模型：' + BZ_MODEL) : (modelSize <= 1500 * 1024 * 1024 ? '模型文件不完整' : null))
    };
  }
  ipcMain.handle('breeze:env', wrap(() => bzEnv()));

  ipcMain.handle('breeze:stop', wrap(() => {
    if (bzChild) {
      try {
        if (process.platform === 'win32' && bzChild.pid) {
          require('child_process').execFile('taskkill',
            ['/PID', String(bzChild.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else { bzChild.kill('SIGKILL'); }
      } catch (e) { /* 忽略 */ }
      bzChild = null;
    }
    return { ok: true };
  }));

  /**
   * cfg = { text, mode:'design'|'clone'|'direct', instruction, voice, refAudio, refText, cfgScale, seed, outDir }
   * 进度通过 webContents.send('breeze:progress', { seq, type, ... }) 推给渲染进程
   */
  ipcMain.handle('breeze:run', async (event, cfg) => {
   try {
    const fsm = require('fs');
    const cps = require('child_process');
    const env = bzEnv();
    if (!env.ok) throw new Error(env.error || 'Breeze 引擎未就绪');

    const text = String((cfg && cfg.text) || '').trim();
    if (!text) throw new Error('请先输入要朗读的文字');

    let outDir = (cfg && cfg.outDir) || env.outDir;
    try { fsm.mkdirSync(outDir, { recursive: true }); } catch (e) { /* 忽略 */ }
    const outWav = path.join(outDir, 'bz_' + Date.now() + '.wav');

    // 组装参数（与 PR 版 breeze.js 完全一致）
    const args = [BZ_MODEL, '--text', text];
    const seed = parseInt(cfg && cfg.seed, 10);
    if (isFinite(seed)) args.push('--seed', String(seed || 42));
    const cs = parseFloat(cfg && cfg.cfgScale);
    args.push('--cfg-scale', String(isFinite(cs) ? cs : 4));

    const mode = (cfg && cfg.mode) || 'design';
    if (mode === 'design') {
      const ins = String((cfg && cfg.instruction) || '').trim();
      if (ins) args.push('--instruction', ins);
    } else {
      const voice = String((cfg && cfg.voice) || '').trim();
      if (voice) {
        args.push('--voice', voice);
      } else {
        const ref = String((cfg && cfg.refAudio) || '').trim();
        const rtext = String((cfg && cfg.refText) || '').trim();
        if (!ref || !fsm.existsSync(ref)) throw new Error('请抓取参考音频，或从音色库选一个音色');
        if (!rtext) throw new Error('请填写参考音频对应的文字');
        args.push('--ref-audio', ref, '--ref-text', rtext);
      }
      if (mode === 'direct') {
        const dt = String((cfg && cfg.directText) || '').trim();
        if (!dt) throw new Error('请填写语气指令');
        args.push('--instruction', dt);
      }
    }
    args.push('--output', outWav);

    const seq = ++bzSeq;
    const sender = (event && event.sender && !event.sender.isDestroyed()) ? event.sender : null;

    const t0 = Date.now();
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = cps.spawn(BZ_CLI, args, {
          cwd: BZ_ENGINE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (e) {
        resolve({ err: e, stdout: '', stderr: '' });
        return;
      }
      bzChild = child;
      let stdout = '', stderr = '', buf = '';
      const push = (line) => {
        const l = String(line || '').trim();
        if (!l) return;
        if (sender && !sender.isDestroyed()) {
          sender.send('breeze:progress', { seq: seq, line: l });
        }
      };
      child.stdout.on('data', (d) => {
        const s = d.toString('utf8');
        stdout += s;
        buf += s;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() || '';
        parts.forEach(push);
      });
      child.stderr.on('data', (d) => {
        const s = d.toString('utf8');
        stderr += s;
        buf += s;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() || '';
        parts.forEach(push);
      });
      child.on('error', (err) => { bzChild = null; resolve({ err: err, stdout: stdout, stderr: stderr }); });
      child.on('close', (code) => { bzChild = null; resolve({ err: code === 0 ? null : new Error('退出码 ' + code), stdout: stdout, stderr: stderr }); });
    });

    const spent = (Date.now() - t0) / 1000;
    if (!fsm.existsSync(outWav)) {
      const detail = (String(result.stderr || '') + '\n' + String(result.stdout || '')).slice(0, 700);
      throw new Error((result.err && result.err.message) || detail || '合成失败');
    }
    let size = 0;
    try { size = fsm.statSync(outWav).size; } catch (e) { size = 0; }
    // 24kHz / 16bit / 单声道 → 秒数
    const seconds = size / 2 / 24000;
    return { ok: true, data: { ok: true, path: outWav, size: size, seconds: seconds, spent: spent, log: String(result.stdout || '').slice(-1500) } };
   } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
   }
  });

  // ==================== 短剧扒歌（本地服务 17911） ====================
  // 用「Electron 自身作为 Node」起子进程，不依赖系统 Node。
  let bgmChild = null;
  const bgmScript = path.join(__dirname, 'bgm', 'server.js');
  function bgmStart() {
    if (bgmChild && bgmChild.exitCode === null) return { ok: true, already: true };
    const cp = require('child_process');
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' });
    bgmChild = cp.spawn(process.execPath, [bgmScript], {
      cwd: path.dirname(bgmScript), env: env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    bgmChild.on('exit', () => { bgmChild = null; });
    return { ok: true, pid: bgmChild.pid };
  }
  function bgmStop() {
    if (bgmChild) { try { bgmChild.kill(); } catch (e) { /* 忽略 */ } bgmChild = null; }
    return { ok: true };
  }
  /** 代理一次 GET 到本地扒歌服务 */
  function bgmGet(pathq) {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const req = http.get({ host: '127.0.0.1', port: 17911, path: pathq, timeout: 20000 }, (res) => {
        let s = '';
        res.on('data', d => { s += d; });
        res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(s); } });
      });
      req.on('error', (e) => reject(new Error('扒歌服务未启动或不可达：' + e.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('扒歌服务响应超时')); });
    });
  }
  /** 代理一次 POST */
  function bgmPost(pathq, body) {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
      const req = http.request({
        host: '127.0.0.1', port: 17911, path: pathq, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        timeout: 10 * 60 * 1000
      }, (res) => {
        let s = '';
        res.on('data', d => { s += d; });
        res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(s); } });
      });
      req.on('error', (e) => reject(new Error('扒歌服务未启动或不可达：' + e.message)));
      req.on('timeout', () => { req.destroy(); reject(new Error('扒歌服务响应超时')); });
      req.write(data);
      req.end();
    });
  }
  ipcMain.handle('bgm:start', wrap(() => bgmStart()));
  ipcMain.handle('bgm:stop', wrap(() => bgmStop()));
  ipcMain.handle('bgm:api', wrap((pathq) => bgmGet(pathq)));
  ipcMain.handle('bgm:post', wrap((pathq, body) => bgmPost(pathq, body)));
  /**
   * 远端直链无需代理：扒歌服务取回的是明文 mp4（官网 SSR 里的 main_url），
   * <video> 可直接播。这里只做 URL 规范化（补协议、去转义）。
   */
  ipcMain.handle('bgm:proxyUrl', wrap((url) => {
    let u = String(url || '').trim();
    if (!u) return '';
    u = u.replace(/&amp;/g, '&');
    if (/^\/\//.test(u)) u = 'https:' + u;
    return u;
  }));

  /** 本地服务的原始 URL（用于 /video?file= 这类） */
  ipcMain.handle('bgm:apiRaw', wrap((pathq) => 'http://127.0.0.1:17911' + (pathq || '')));

  // ==================== 网易云音乐（主进程直连，无需独立服务） ====================
  ipcMain.handle('ncm:status', wrap(() => ncmHost.status()));
  ipcMain.handle('ncm:search', wrap((kw, type, limit, offset) => ncmHost.search(kw, type, limit, offset)));
  ipcMain.handle('ncm:songUrl', wrap((id, level) => ncmHost.songUrl(id, level)));
  ipcMain.handle('ncm:songDetail', wrap((ids) => ncmHost.songDetail(ids)));
  ipcMain.handle('ncm:playlistDetail', wrap((id) => ncmHost.playlistDetail(id)));
  ipcMain.handle('ncm:userPlaylist', wrap((uid) => ncmHost.userPlaylist(uid)));
  ipcMain.handle('ncm:lyric', wrap((id) => ncmHost.lyric(id)));
  ipcMain.handle('ncm:recentSongs', wrap(() => ncmHost.recentSongs()));
  ipcMain.handle('ncm:playlistCreate', wrap((name) => ncmHost.playlistCreate(name)));
  ipcMain.handle('ncm:playlistTrackAdd', wrap((pid, ids) => ncmHost.playlistTrackAdd(pid, ids)));
  ipcMain.handle('ncm:qrKey', wrap(() => ncmHost.qrKey()));
  ipcMain.handle('ncm:qrCreate', wrap((key) => ncmHost.qrCreate(key)));
  ipcMain.handle('ncm:qrCheck', wrap((key) => ncmHost.qrCheck(key)));
  ipcMain.handle('ncm:logout', wrap(() => ncmHost.logout()));
  // 听歌识曲：录系统声音（Python WASAPI loopback）→ 指纹 → 匹配
  ipcMain.handle('ncm:identify', wrap(async (seconds) => {
    const fsm = require('fs');
    const osm = require('os');
    const pathm = require('path');
    const cps = require('child_process');
    const py = findPythonForClone();
    if (!py) throw new Error('未找到 Python（听歌识曲需要）');
    const rec = pathm.join(__dirname, 'py', 'identify_record.py');
    if (!fsm.existsSync(rec)) throw new Error('缺少 py/identify_record.py');
    const wav = pathm.join(osm.tmpdir(), 'vh_identify_' + Date.now() + '.wav');
    const sec = Math.max(3, Math.min(12, Number(seconds) || 6));
    const r = await new Promise((resolve) => {
      cps.execFile(py, [rec, wav, String(sec)], {
        encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024
      }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
    let rec1 = null;
    try { rec1 = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); } catch (e) {}
    if (r.err || !rec1 || !rec1.ok) {
      throw new Error('录音失败：' + ((rec1 && rec1.error) || (r.err && r.err.message) || '未知'));
    }
    const res = await ncmHost.identifyFromWav(wav);
    try { fsm.unlinkSync(wav); } catch (e) { /* 忽略 */ }
    return res;
  }));

  // 下载歌曲到本地（走 ffmpeg 落地为 mp3，供素材池/时间线使用）
  ipcMain.handle('ncm:download', wrap(async (url, outDir, baseName2) => {
    const fsm = require('fs');
    const pathm = require('path');
    const http = require('http');
    const https = require('https');
    if (!url) throw new Error('缺少下载地址');
    const dir = outDir || pathm.join(__dirname, 'collect', 'music');
    try { fsm.mkdirSync(dir, { recursive: true }); } catch (e) { /* 忽略 */ }
    const safe = String(baseName2 || 'song').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    const raw = pathm.join(dir, safe + '.raw');
    const out = pathm.join(dir, safe + '.mp3');

    await new Promise((resolve, reject) => {
      const mod = String(url).indexOf('https:') === 0 ? https : http;
      const req = mod.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://music.163.com/'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 跟随一次重定向
          const mod2 = String(res.headers.location).indexOf('https:') === 0 ? https : http;
          mod2.get(res.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r2) => {
            if (r2.statusCode !== 200) { reject(new Error('下载失败 HTTP ' + r2.statusCode)); return; }
            const ws = fsm.createWriteStream(raw);
            r2.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
          }).on('error', reject);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error('下载失败 HTTP ' + res.statusCode)); return; }
        const ws = fsm.createWriteStream(raw);
        res.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => { req.destroy(new Error('下载超时')); });
    });

    // 统一转 mp3（源可能是 m4a/flac）
    const ff = svc.ffmpegPath();
    if (ff && fsm.existsSync(raw)) {
      const r = await new Promise((resolve) => {
        const cp = require('child_process');
        cp.execFile(ff, ['-y', '-v', 'error', '-i', raw, '-vn', '-codec:a', 'libmp3lame',
          '-q:a', '2', out], { timeout: 10 * 60 * 1000 }, (err) => resolve(err));
      });
      if (r) {
        // 转码失败则直接把原文件改名（至少能播）
        try { fsm.renameSync(raw, out); } catch (e) { /* 忽略 */ }
      } else {
        try { fsm.unlinkSync(raw); } catch (e) { /* 忽略 */ }
      }
    } else if (fsm.existsSync(raw)) {
      try { fsm.renameSync(raw, out); } catch (e) { /* 忽略 */ }
    }
    if (!fsm.existsSync(out)) throw new Error('下载后未找到文件');
    return {
      path: out,
      name: safe + '.mp3',
      size: fsm.statSync(out).size
    };
  }));

  // 字幕
  ipcMain.handle('host:transcribeAudio', wrap((p) => host.transcribeAudio(p)));
  ipcMain.handle('host:findWhisper', wrap(() => host.findWhisper()));
  ipcMain.handle('host:listSubtitles', wrap((name) => host.listSubtitles(name)));
  ipcMain.handle('host:recognizeSubtitles', wrap((name, opts) => host.recognizeSubtitles(name, opts)));
  ipcMain.handle('host:writeSubtitles', wrap((name, srtPath, opts) => host.writeSubtitles(name, srtPath, opts)));

  // 导出
  ipcMain.handle('export:start', wrap((payload) => host.startExport(payload, onExportTick)));
  ipcMain.handle('export:stop', wrap(() => host.stopExport()));
  ipcMain.handle('export:state', wrap(() => host.getExportState()));

  // 系统
  ipcMain.handle('sys:saveSrt', wrap(async (defaultDir, defaultName, content) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出字幕文件',
      defaultPath: defaultDir ? path.join(defaultDir, defaultName || 'subtitle.srt') : (defaultName || 'subtitle.srt'),
      filters: [{ name: 'SRT 字幕', extensions: ['srt'] }]
    });
    if (res.canceled || !res.filePath) return null;
    await require('fs').promises.writeFile(res.filePath, content, 'utf8');
    return res.filePath;
  }));

  ipcMain.handle('sys:pickFiles', wrap(async (defaultPath, filters) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的素材',
      defaultPath: defaultPath || undefined,
      properties: ['openFile', 'multiSelections'],
      filters: filters && filters.length ? filters : undefined
    });
    if (res.canceled || !res.filePaths.length) return [];
    return res.filePaths;
  }));

  /** 选目录（音效库根目录用） */
  ipcMain.handle('sys:pickFolder', wrap(async (defaultPath, title) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: title || '选择目录',
      defaultPath: defaultPath || undefined,
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  }));

  /** 列目录（音效库浏览）：递归或单层 */
  /** 列目录：单层或递归；kind 决定文件类型过滤（audio/media/all） */
  ipcMain.handle('sys:listDir', wrap(async (dirPath, recurse, kind) => {
    const fs = require('fs');
    const path = require('path');
    if (!dirPath || !fs.existsSync(dirPath)) throw new Error('目录不存在：' + dirPath);

    const AUDIO = /\.(wav|mp3|m4a|aac|flac|ogg|aiff?|wma)$/i;
    const MEDIA = /\.(wav|mp3|m4a|aac|flac|ogg|aiff?|wma|mp4|mov|mkv|avi|mxf|wmv|flv|webm|m4v|mpg|mpeg|r3d|braw|jpg|jpeg|png|gif|bmp|webp|tif|tiff|exr|dpx|srt|ass|vtt|txt|md|pdf|docx|xlsx|csv|xml)$/i;
    const matcher = (kind === 'all') ? null : (kind === 'media' ? MEDIA : AUDIO);

    const out = [];
    const walk = (d, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) {
          if (recurse && depth < 6) walk(fp, depth + 1);
          continue;
        }
        if (matcher && !matcher.test(e.name)) continue;
        let sz = 0, ct = 0, mt = 0;
        try {
          const st = fs.statSync(fp);
          sz = st.size; ct = st.birthtimeMs || st.ctimeMs || 0; mt = st.mtimeMs || 0;
        } catch (err) { /* 忽略 */ }
        out.push({ name: e.name, path: fp, sizeBytes: sz,
                   ext: path.extname(e.name).toLowerCase().slice(1),
                   ctimeMs: ct, mtimeMs: mt, isDirectory: false });
      }
    };
    walk(dirPath, 0);
    // 不在这里排序：保持文件系统顺序，排序交给前端（与 PR 版一致）
    return { root: dirPath, count: out.length, files: out };
  }));


  /** 读文件为可播放的 data URL（音效/音乐试听，纯本地不外传） */
  ipcMain.handle('sys:readAudioDataUrl', wrap(async (filePath) => {
    const fs = require('fs');
    const path = require('path');
    if (!filePath || !fs.existsSync(filePath)) throw new Error('文件不存在');
    const st = fs.statSync(filePath);
    if (st.size > 40 * 1024 * 1024) throw new Error('文件过大（>40MB），请用系统播放器试听');
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mime = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
                   flac: 'audio/flac', ogg: 'audio/ogg', aif: 'audio/aiff', aiff: 'audio/aiff',
                   wma: 'audio/x-ms-wma' }[ext] || 'audio/mpeg';
    const b64 = fs.readFileSync(filePath).toString('base64');
    return { dataUrl: 'data:' + mime + ';base64,' + b64, sizeBytes: st.size };
  }));

  /** 读音频为二进制（供波形解码）：返回 Uint8Array 对应的 Buffer */
  ipcMain.handle('sys:readAudioBuffer', wrap(async (filePath) => {
    const fs2 = require('fs');
    if (!filePath || !fs2.existsSync(filePath)) throw new Error('文件不存在');
    const st = fs2.statSync(filePath);
    // 波形不需要超大文件；超过 80MB 直接拒绝，避免拖垮渲染进程
    if (st.size > 80 * 1024 * 1024) throw new Error('文件过大（>80MB），波形已跳过');
    const buf = fs2.readFileSync(filePath);
    // 转成普通数组传过 IPC（Buffer 也能过，但数组更稳）
    return { bytes: buf, sizeBytes: st.size };
  }));

  /** 选剧本文件（docx / pdf / txt） */
  ipcMain.handle('sys:pickScript', wrap(async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择剧本文件',
      properties: ['openFile'],
      filters: [
        { name: '剧本', extensions: ['docx', 'pdf', 'txt'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  }));

  /** 解析剧本：docx/pdf -> 逐行 JSON（调 py/docx_read.py） */
  ipcMain.handle('sys:scriptParse', wrap(async (filePath) => {
    const fs2 = require('fs');
    const path2 = require('path');
    const { execFile } = require('child_process');
    if (!filePath || !fs2.existsSync(filePath)) throw new Error('文件不存在：' + filePath);

    const ext = path2.extname(filePath).toLowerCase();
    if (ext === '.txt') {
      // 纯文本直接读，无需 Python
      const txt = fs2.readFileSync(filePath, 'utf8');
      const lines = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      return { ok: true, lines: lines.map(t2 => ({ text: t2, episode: null })), source: 'txt' };
    }

    const script = path2.join(__dirname, 'py', 'docx_read.py');
    if (!fs2.existsSync(script)) throw new Error('缺少解析脚本 py/docx_read.py');

    // 找可用的 python
    const py = process.env.VH_PYTHON || 'python';
    const args = [script, '--docx', filePath];
    const out = await new Promise((resolve, reject) => {
      execFile(py, args, { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000,
                           windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) },
        (err, stdout, stderr) => {
          if (err && !stdout) { reject(new Error('解析进程失败：' + (err.message || '') + ' ' + String(stderr || '').slice(0, 200))); return; }
          resolve(String(stdout || ''));
        });
    });

    let data = null;
    try { data = JSON.parse(out); } catch (e) {
      // 兜底：可能混入了提示信息，取最后一个 JSON 对象
      const m = out.match(/\{[\s\S]*\}\s*$/);
      if (m) { try { data = JSON.parse(m[0]); } catch (e2) { /* 忽略 */ } }
    }
    if (!data) throw new Error('解析输出无法识别：' + out.slice(0, 200));
    if (data.ok === false) throw new Error(data.error || '解析失败');
    return data;
  }));

  /** 拖出到外部应用（Electron 原生拖拽）：达芬奇时间线可直接接收 */
  ipcMain.on('sys:startDrag', (event, filePath) => {
    try {
      const fs2 = require('fs');
      const p = require('path');
      if (!filePath || !fs2.existsSync(filePath)) {
        console.log('[startDrag] 文件不存在，跳过:', filePath);
        return;
      }
      // 拖拽图标必须是「图片文件」，传 dll 或 .exe 都不生效
      const icon = p.join(__dirname, 'assets', 'dragicon.png');
      if (!fs2.existsSync(icon)) {
        console.log('[startDrag] 缺少拖拽图标:', icon);
        return;
      }
      event.sender.startDrag({ file: filePath, icon: icon });
      console.log('[startDrag] 已启动原生拖拽:', filePath);
    } catch (e) {
      console.log('[startDrag] 异常:', e && e.message);
    }
  });

  /** 用系统默认程序打开 */
  ipcMain.handle('sys:openWithSystem', wrap(async (filePath) => {
    if (!filePath) throw new Error('路径为空');
    const err = await shell.openPath(filePath);
    if (err) throw new Error(err);
    return true;
  }));

  /** 列出可用盘符 */
  ipcMain.handle('sys:listDrives', wrap(async () => {
    const out = [];
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const L of letters) {
      const root = L + ':\\';
      try {
        const fs2 = require('fs');
        if (fs2.existsSync(root)) out.push({ letter: L + ':', root: root });
      } catch (e) { /* 忽略 */ }
    }
    return out;
  }));

  /** 抽取视频某一帧为 PNG（素材面板缩略图） */
  ipcMain.handle('sys:extractFrame', wrap(async (opts) => {
    const fs2 = require('fs');
    const path2 = require('path');
    const o = opts || {};
    if (!o.input || !fs2.existsSync(o.input)) throw new Error('输入文件不存在');
    const ff = svc.ffmpegPath();
    if (!ff) throw new Error('ffmpeg 不可用');
    const outDir = o.outDir || svc.workDir('thumbs');
    try { fs2.mkdirSync(outDir, { recursive: true }); } catch (e) { /* 忽略 */ }
    const out = o.output || path2.join(outDir, 'thumb_' + Date.now() + '.png');
    const t0 = o.atSec !== undefined ? String(Number(o.atSec)) : '0.5';
    const r = await svc.run(ff, ['-y', '-v', 'error', '-ss', t0, '-i', o.input,
                                 '-frames:v', '1', '-vf', 'scale=320:-1', out]);
    if (r.code !== 0 || !fs2.existsSync(out)) {
      throw new Error('抽帧失败：' + (r.stderr || '').split('\n').slice(-2).join(' '));
    }
    return { output: out, sizeBytes: fs2.statSync(out).size };
  }));

  /** 在文件管理器中定位 */
  ipcMain.handle('sys:revealFile', wrap(async (filePath) => {
    if (!filePath) throw new Error('路径为空');
    shell.showItemInFolder(filePath);
    return true;
  }));

  ipcMain.handle('sys:revealFolder', wrap(async (folder) => {
    if (!folder) throw new Error('路径为空');
    shell.openPath(folder);
    return true;
  }));

  ipcMain.handle('sys:openExternal', wrap(async (url) => {
    await shell.openExternal(url);
    return true;
  }));

  /** 版本号 + 文件时间戳：便于确认插件跑的是哪一版 */
  // 机器标识（授权设备绑定用，与 PR 版 wmic UUID 同源思路）
  ipcMain.handle('sys:machineId', wrap(() => {
    const osm = require('os');
    const cps = require('child_process');
    let host = '';
    try { host = osm.hostname(); } catch (e) {}
    let seed = '';
    try {
      const r = cps.spawnSync('wmic', ['csproduct', 'get', 'uuid'],
        { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const out = String((r && r.stdout) || '');
      const lines = out.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      if (lines.length >= 2) seed = lines[1];
    } catch (e) {}
    if (!seed) seed = host || 'unknown';
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    const tag = Math.abs(h).toString(36).toUpperCase();
    return {
      id: 'WX-' + tag + '-' + host.replace(/[^A-Za-z0-9]/g, '').slice(0, 12),
      hostname: host || '未命名电脑'
    };
  }));
  ipcMain.handle('sys:extRoot', wrap(() => __dirname));

  // 读图片成 dataURL（授权面板二维码用；按文件头判格式，扩展名不可信）
  ipcMain.handle('sys:readImageDataUrl', wrap(async (filePath) => {
    const fsm = require('fs');
    if (!filePath || !fsm.existsSync(filePath)) throw new Error('文件不存在');
    const st = fsm.statSync(filePath);
    if (st.size > 20 * 1024 * 1024) throw new Error('图片过大（>20MB）');
    const buf = fsm.readFileSync(filePath);
    let mime = '';
    if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) mime = 'image/jpeg';
    else if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) mime = 'image/png';
    else if (buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) mime = 'image/gif';
    else if (buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) mime = 'image/webp';
    else if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) mime = 'image/avif';
    if (!mime) throw new Error('不是可识别的图片');
    return { dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64'), sizeBytes: st.size, mime: mime };
  }));
  ipcMain.handle('sys:readdirSync', wrap((dirPath) => {
    const fsm = require('fs');
    if (!dirPath || !fsm.existsSync(dirPath)) return [];
    try { return fsm.readdirSync(dirPath); } catch (e) { return []; }
  }));

  // ==================== 超分 / 去字幕（py/enhance_client.py） ====================
  // 渲染进程没有 child_process，统一由主进程跑 Python 并解析 JSON
  function findPython() {
    const fsm = require('fs');
    const osm = require('os');
    const cands = [];
    ['Python310', 'Python311', 'Python312', 'Python313'].forEach(v => {
      cands.push(path.join(osm.homedir(), 'AppData', 'Local', 'Programs', 'Python', v, 'python.exe'));
    });
    cands.push(path.join(__dirname, 'runtime', 'python.exe'));
    for (const c of cands) { try { if (fsm.existsSync(c)) return c; } catch (e) {} }
    return 'python';
  }
  function pyEnhance(args) {
    const cps = require('child_process');
    const script = path.join(__dirname, 'py', 'enhance_client.py');
    const py = findPython();
    if (!require('fs').existsSync(script)) return Promise.reject(new Error('找不到 py/enhance_client.py'));
    const argv = [script].concat(args || []);
    return new Promise((resolve, reject) => {
      cps.execFile(py, argv, {
        windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' })
      }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        // 注意：folders/tasks 返回的是 JSON 数组 "[...]"，download 返回对象 "{...}"，
        // 所以不能只认 '{' 开头的行（之前就是这样把文件夹/任务全丢掉的）。
        let data = null;
        const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i];
          if (l[0] !== '{' && l[0] !== '[') continue;
          try { data = JSON.parse(l); break; } catch (e) { /* 继续往上找 */ }
        }
        if (data === null && out && (out[0] === '{' || out[0] === '[')) {
          try { data = JSON.parse(out); } catch (e) { /* 忽略 */ }
        }
        if (data !== null) { resolve(data); return; }
        if (err) {
          reject(new Error((String(stderr || '') + ' ' + out).slice(0, 500) || err.message));
          return;
        }
        resolve({ ok: true, raw: out.slice(0, 2000) });
      });
    });
  }
  ipcMain.handle('svc:pyEnhance', wrap((args) => pyEnhance(args)));

  // ==================== 授权状态持久化（达芬奇无 fs，由主进程落盘） ====================
  const LIC_DIR = path.join(__dirname, 'collect');
  const LIC_FILE = path.join(LIC_DIR, '_license.json');
  ipcMain.handle('license:save', wrap((json) => {
    const fsm = require('fs');
    try {
      if (!fsm.existsSync(LIC_DIR)) fsm.mkdirSync(LIC_DIR, { recursive: true });
      fsm.writeFileSync(LIC_FILE, String(json || '{}'), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }));
  ipcMain.handle('license:load', wrap(() => {
    const fsm = require('fs');
    try {
      if (fsm.existsSync(LIC_FILE)) return { ok: true, json: fsm.readFileSync(LIC_FILE, 'utf8') };
      return { ok: true, json: '' };
    } catch (e) {
      return { ok: true, json: '' };
    }
  }));

  // ==================== 内嵌浏览器 IPC ====================
  ipcMain.handle('embed:show', wrap(async (payload) => {
    const p = payload || {};
    const view = embedEnsure();
    embedBounds(p.bounds);
    const url = String(p.url || '').trim();
    if (url) {
      try { await view.webContents.loadURL(url); }
      catch (e) { throw new Error('打开失败：' + (e.message || e)); }
    }
    return { ok: true, url: view.webContents.getURL() };
  }));

  ipcMain.handle('embed:setBounds', wrap((bounds) => {
    embedBounds(bounds);
    return { ok: true };
  }));

  ipcMain.handle('embed:nav', wrap(async (payload) => {
    const p = payload || {};
    if (!embedView) throw new Error('视图未创建');
    const wc = embedView.webContents;
    const act = String(p.action || '');
    if (act === 'back') {
      if (wc.navigationHistory && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    } else if (act === 'forward') {
      if (wc.navigationHistory && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    } else if (act === 'reload') {
      wc.reload();
    } else if (act === 'goto') {
      let u = String(p.url || '').trim();
      if (!u) return { ok: true };
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      try { await wc.loadURL(u); } catch (e) { throw new Error('打开失败：' + (e.message || e)); }
    } else if (act === 'home') {
      const h = String(p.url || 'https://app.mediatrack.cn/');
      try { await wc.loadURL(h); } catch (e) { throw new Error('打开失败：' + (e.message || e)); }
    }
    return { ok: true, url: wc.getURL() };
  }));

  ipcMain.handle('embed:hide', wrap(() => {
    if (embedView) {
      try { mainWindow.contentView.removeChildView(embedView); } catch (e) {}
      try { embedView.webContents.close(); } catch (e) {}
      embedView = null;
    }
    return { ok: true };
  }));

  ipcMain.handle('embed:state', wrap(() => {
    if (!embedView || embedView.webContents.isDestroyed()) {
      return { created: false, url: '', canBack: false, canForward: false, loading: false };
    }
    const wc = embedView.webContents;
    return {
      created: true,
      url: wc.getURL() || '',
      canBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : false,
      canForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : false,
      loading: wc.isLoading()
    };
  }));

  // 在目录里找最新的视频文件（导出结果只给 outDir+fileName，且 fileName 常无扩展名，
  // 所以不能直接拼路径，必须扫目录找真实产物）
  ipcMain.handle('sys:findLatestVideo', wrap((dirPath, sinceMs) => {
    const fsm = require('fs');
    if (!dirPath || !fsm.existsSync(dirPath)) return { ok: false, error: '目录不存在' };
    const exts = ['.mp4', '.mov', '.mxf', '.mkv', '.avi', '.m4v', '.wav', '.m4a'];
    let best = null;
    let list = [];
    try { list = fsm.readdirSync(dirPath); } catch (e) { return { ok: false, error: '读取失败' }; }
    const since = sinceMs ? Number(sinceMs) : 0;
    list.forEach(name => {
      const ext = require('path').extname(name).toLowerCase();
      if (exts.indexOf(ext) < 0) return;
      const full = require('path').join(dirPath, name);
      try {
        const st = fsm.statSync(full);
        if (!st.isFile()) return;
        if (since && st.mtimeMs < since - 5000) return;
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, name: name, size: st.size, mtimeMs: st.mtimeMs };
      } catch (e) { /* 忽略 */ }
    });
    if (!best) return { ok: false, error: '目录里没有找到视频文件' };
    return { ok: true, path: best.path, name: best.name, size: best.size };
  }));

  // ==================== 在线更新 ====================
  ipcMain.handle('update:check', wrap(() => vhUpdater.checkUpdate()));
  ipcMain.handle('update:run', wrap((info) => vhUpdater.doUpdate(info)));
  ipcMain.handle('update:version', wrap(() => vhUpdater.readVersion()));

  ipcMain.handle('sys:version', wrap(async () => {
    let v = '0.0.0';
    try { v = require('./package.json').version; } catch (e) { /* 忽略 */ }
    const out = { version: v, buildTime: null, files: {} };
    try {
      const fs2 = require('fs');
      const idx = path.join(__dirname, 'index.html');
      if (fs2.existsSync(idx)) out.buildTime = fs2.statSync(idx).mtime.toISOString();
      ['index.html', 'js/app.js', 'js/sfx.js', 'js/musiclib.js', 'js/media.js', 'js/script.js', 'main.js', 'preload.js']
        .forEach(function (f) {
          const p2 = path.join(__dirname, f);
          try { if (fs2.existsSync(p2)) out.files[f] = fs2.statSync(p2).mtimeMs; } catch (e) { /* 忽略 */ }
        });
    } catch (e) { /* 忽略 */ }
    return out;
  }));

  ipcMain.handle('sys:getPaths', wrap(async () => ({
    extRoot: __dirname,
    collectDir: require('path').join(__dirname, 'collect')
  })));

  ipcMain.handle('sys:appInfo', wrap(async () => ({
    pluginVersion: (() => {
      try { return require('./package.json').version; } catch (e) { return '0.0.0'; }
    })(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch,
    pluginDir: __dirname,
    userData: app.getPath('userData')
  })));
}

// ==================== 内嵌浏览器（绕开 X-Frame-Options） ====================
// 为什么不用 <iframe>：目标站返回 X-Frame-Options: SAMEORIGIN，
// 跨源内嵌一律被浏览器拒绝，iframe 永远空白。WebContentsView 是独立的
// 浏览器视图，不受 frame 限制，等价于在插件里开一个真的浏览器。
let embedView = null;
let embedWin = null;

function embedEnsure() {
  if (embedView && !embedView.webContents.isDestroyed()) return embedView;
  if (!mainWindow) throw new Error('主窗口未就绪');
  embedView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:embed'
    }
  });
  mainWindow.contentView.addChildView(embedView);

  const wc = embedView.webContents;
  const push = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('embed:navState', {
        url: wc.getURL() || '',
        canBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : false,
        canForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : false,
        loading: wc.isLoading()
      });
    } catch (e) { /* 忽略 */ }
  };
  ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']
    .forEach(ev => { try { wc.on(ev, push); } catch (e) {} });

  // 新窗口请求改为当前视图内打开，避免弹独立窗
  try {
    wc.setWindowOpenHandler(({ url }) => {
      try { wc.loadURL(url); } catch (e) {}
      return { action: 'deny' };
    });
  } catch (e) { /* 忽略 */ }

  return embedView;
}

function embedBounds(b) {
  if (!embedView) return;
  const bb = b || {};
  embedView.setBounds({
    x: Math.max(0, Math.round(bb.x || 0)),
    y: Math.max(0, Math.round(bb.y || 0)),
    width: Math.max(50, Math.round(bb.width || 600)),
    height: Math.max(50, Math.round(bb.height || 400))
  });
}

// ==================== 窗口 ====================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    useContentSize: true,
    backgroundColor: '#1e1e1e',
    title: 'vh-Atelier · DaVinci Resolve',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // 打开前清一次 session 缓存，确保读的是磁盘上的最新代码
  try {
    mainWindow.webContents.session.clearCache().catch(function () {});
  } catch (e) { /* 忽略 */ }
  // 运行时关闭缓存：Resolve 拉起 Electron 时 app 可能已 ready，
  // 启动参数(appendSwitch)会失效，必须用 session API 才可靠。
  try {
    if (mainWindow.webContents.session) {
      mainWindow.webContents.session.setCacheEnabled(false);
    }
  } catch (e) { /* 忽略 */ }

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    try { if (embedView) { embedView.webContents.close(); embedView = null; } } catch (e) {}
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // 每一步独立容错：任何一步失败都不能影响 IPC 注册与窗口创建
  try { purgeCaches(); } catch (e) { /* 忽略 */ }
  try {
    if (session && session.defaultSession) {
      await session.defaultSession.clearCache();
    }
  } catch (e) { /* 忽略 */ }

  try { registerHandlers(); } catch (e) {
    try { console.log('[main] IPC 注册异常: ' + (e && e.message)); } catch (e2) {}
  }
  try { createWindow(); } catch (e) {
    try { console.log('[main] 建窗异常: ' + (e && e.message)); } catch (e2) {}
  }
});

app.on('window-all-closed', () => {
  try { host.cleanup(); } catch (e) { /* 忽略 */ }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  try { host.cleanup(); } catch (e) { /* 忽略 */ }
});
