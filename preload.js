'use strict';
/**
 * preload：把主进程能力以白名单方式暴露给渲染层。
 * 渲染层只能拿到 vhHost.*，无法直接 require。
 */

const { contextBridge, ipcRenderer } = require('electron/renderer');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

// Node 模块按需加载；沙箱下可能拿不到，必须容错（否则整个 vhHost 都建不起来）
function safeRequire(name) {
  try { return require(name); } catch (e) {
    try { console.warn('[preload] 无法加载 ' + name + '：' + (e && e.message)); } catch (e2) {}
    return null;
  }
}
const _fs = safeRequire('fs');
const _path = safeRequire('path');

contextBridge.exposeInMainWorld('vhHost', {
  // 连通性
  ping: () => call('host:ping'),
  productInfo: () => call('host:productInfo'),

  // 时间线
  listTimelines: () => call('host:listTimelines'),
  timelineDetail: (name) => call('host:timelineDetail', name),
  rangeInfo: function (mode) { return call('host:rangeInfo', mode); },
  audioClips: (name) => call('host:audioClips', name),
  audioTracks: (name) => call('host:audioTracks', name),

  // 渲染预设
  renderPresets: () => call('host:renderPresets'),

  // 素材
  importMedia: (paths) => call('host:importMedia', paths),
  openPage: (page) => call('host:openPage', page),

  // 声音 / 素材池
  importFilesToPool: (paths, folder) => call('host:importFilesToPool', paths, folder),
  insertAudioToTimeline: (opts) => call('host:insertAudioToTimeline', opts),
  listTimelineNames: () => call('host:listTimelineNames'),
  getPlayhead: (name) => call('host:getPlayhead', name),
  setAudioClipProps: (name, props, opts) => call('host:setAudioClipProps', name, props, opts),
  readAudioClipProps: (name, idx, opts) => call('host:readAudioClipProps', name, idx, opts),

  // 本地服务
  svcCapabilities: () => call('svc:capabilities'),
  svcProbe: (p) => call('svc:probe', p),
  svcExtractAudio: (opts) => call('svc:extractAudio', opts),
  svcSeparateVocals: (opts) => call('svc:separateVocals', opts),
  svcToMp3: (opts) => call('svc:toMp3', opts),

  // 字幕
  listSubtitles: (name) => call('host:listSubtitles', name),
  recognizeSubtitles: (name, opts) => call('host:recognizeSubtitles', name, opts),
  writeSubtitles: (name, srtPath, opts) => call('host:writeSubtitles', name, srtPath, opts),

  // 导出
  exportStart: (payload) => call('export:start', payload),
  exportStop: () => call('export:stop'),
  exportState: () => call('export:state'),
  onExportProgress: (cb) => {
    const listener = (_e, snap) => cb(snap);
    ipcRenderer.on('export:progress', listener);
    return () => ipcRenderer.removeListener('export:progress', listener);
  },

  // 系统
  pickFolder: (defaultPath) => call('sys:pickFolder', defaultPath),
  pickFiles: (defaultPath) => call('sys:pickFiles', defaultPath),
  saveSrt: (dir, name, content) => call('sys:saveSrt', dir, name, content),
  listSubDirs: (rootPath) => call('host:listSubDirs', rootPath),
  listDir: (dirPath, recurse, kind) => call('sys:listDir', dirPath, recurse, kind),
  readAudioDataUrl: (filePath) => call('sys:readAudioDataUrl', filePath),
  readAudioBuffer: (filePath) => call('sys:readAudioBuffer', filePath),
  revealFile: (filePath) => call('sys:revealFile', filePath),
  pickScript: () => call('sys:pickScript'),
  getVersion: () => call('sys:version'),
  scriptParse: (filePath) => call('sys:scriptParse', filePath),
  /** 拖出到外部应用（fire-and-forget，不等待返回） */
  startDrag: (filePath) => ipcRenderer.send('sys:startDrag', filePath),
  revealFolder: (folder) => call('sys:revealFolder', folder),
  openExternal: (url) => call('sys:openExternal', url),
  openWithSystem: (filePath) => call('sys:openWithSystem', filePath),
  listDrives: () => call('sys:listDrives'),
  extractFrame: (opts) => call('sys:extractFrame', opts),
  /** 素材面板：一次拿到根目录与 collect 目录 */
  getPaths: () => call('sys:getPaths'),
  /**
   * 同步文件系统垫片（关键是「同步」）。
   * PR 版的面板全部用 fs.readdirSync，异步化后会因为链路断裂而整片失效，
   * 所以这里在 preload 里直接提供同步接口，行为与 PR 一致。
   */
  fsSync: _fs ? {
    get ready() { return true; },
    /** 读目录：返回 { ok, dirs:[{name,path}], files:[{name,path,ext,size}] } */
    readdir: function (p) {
      try {
        var ents = _fs.readdirSync(p, { withFileTypes: true });
        var dirs = [], files = [];
        ents.forEach(function (e) {
          var fp = _path.join(p, e.name);
          if (e.isDirectory()) {
            dirs.push({ name: e.name, path: fp });
          } else if (e.isFile()) {
            var sz = 0;
            try { sz = _fs.statSync(fp).size; } catch (err) {}
            dirs.length; // 保持结构
            files.push({ name: e.name, path: fp,
                         ext: _path.extname(e.name).toLowerCase().slice(1), size: sz });
          }
        });
        return { ok: true, dirs: dirs, files: files };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e), dirs: [], files: [] };
      }
    },
    exists: function (p) { try { return _fs.existsSync(p); } catch (e) { return false; } },
    isDir: function (p) {
      try { return _fs.statSync(p).isDirectory(); } catch (e) { return false; }
    },
    stat: function (p) {
      try {
        var s = _fs.statSync(p);
        return { size: s.size, mtimeMs: s.mtimeMs || 0, isDirectory: s.isDirectory() };
      } catch (e) { return null; }
    },
    /** 盘符列表 */
    drives: function () {
      var out = [];
      for (var i = 0; i < 26; i++) {
        var L = String.fromCharCode(65 + i) + ':/';
        try { if (_fs.existsSync(L)) out.push(L); } catch (e) {}
      }
      return { ok: true, drives: out };
    }
  } : { get ready() { return false; }, readdir: function () { return { ok: false, error: '无 fs' }; },
        exists: function () { return false; }, isDir: function () { return false; },
        stat: function () { return null; }, drives: function () { return { ok: false, drives: [] }; } },

  /** fs/path 垫片：让从 PR 移植的面板代码可直接用同步文件 API（拿不到 fs 时为 null） */
  fs: _fs ? {
    existsSync: (p) => { try { return _fs.existsSync(p); } catch (e) { return false; } },
    readFileSync: (p, enc) => {
      const b = _fs.readFileSync(p);
      return enc ? b.toString(enc) : { __buffer: true, data: Array.from(b) };
    },
    writeFileSync: (p, d, enc) => {
      if (d && d.__buffer) _fs.writeFileSync(p, Buffer.from(d.data));
      else _fs.writeFileSync(p, d, enc || 'utf8');
      return true;
    },
    appendFileSync: (p, d, enc) => { try { _fs.appendFileSync(p, d, enc || 'utf8'); return true; } catch (e) { return false; } },
    mkdirSync: (p, o) => { try { _fs.mkdirSync(p, o || { recursive: true }); return true; } catch (e) { return false; } },
    statSync: (p) => {
      try {
        const s = _fs.statSync(p);
        return { size: s.size, mtimeMs: s.mtimeMs || 0, birthtimeMs: s.birthtimeMs || 0,
                 ctimeMs: s.ctimeMs || 0, isDirectory: s.isDirectory(), isFile: s.isFile() };
      } catch (e) { return null; }
    }
  } : null,
  path: _path ? {
    sep: _path.sep,
    basename: (a, b) => _path.basename(a || '', b),
    dirname: (a) => _path.dirname(a || ''),
    extname: (a) => _path.extname(a || ''),
    join: (...a) => _path.join(...a),
    normalize: (a) => _path.normalize(a || ''),
    relative: (a, b) => _path.relative(a, b),
    resolve: (...a) => _path.resolve(...a)
  } : null,
  transcribeAudio: function (p) { return call('host:transcribeAudio', p); },
  findWhisper: function () { return call('host:findWhisper'); },

  // ==================== 语音克隆（CosyVoice3） ====================
  cloneEnv: function () { return call('clone:env'); },
  cloneRun: function (cfg) { return call('clone:run', cfg); },
  cloneGrabSelection: function () { return call('clone:grabSelection'); },
  cloneStop: function () { return call('clone:stop'); },

  maStop: function () { return call('ma:stop'); },
  maApi: function (pathq, opt) { return call('ma:api', pathq, opt); },
  moveFile: function (from, toDir) { return call('ma:moveFile', from, toDir); },

  // ==================== 短剧扒歌（本地服务） ====================
  bgmStart: function () { return call('bgm:start'); },
  bgmStop: function () { return call('bgm:stop'); },
  bgmApi: function (pathq) { return call('bgm:api', pathq); },
  bgmPost: function (pathq, body) { return call('bgm:post', pathq, body); },
  bgmProxyUrl: function (url) { return call('bgm:proxyUrl', url); },
  bgmApiRaw: function (pathq) { return call('bgm:apiRaw', pathq); },

  // ==================== 网易云音乐（主进程直连） ====================
  ncmStatus: function () { return call('ncm:status'); },
  ncmSearch: function (kw, type, limit, offset) { return call('ncm:search', kw, type, limit, offset); },
  ncmSongUrl: function (id, level) { return call('ncm:songUrl', id, level); },
  ncmSongDetail: function (ids) { return call('ncm:songDetail', ids); },
  ncmPlaylistDetail: function (id) { return call('ncm:playlistDetail', id); },
  ncmUserPlaylist: function (uid) { return call('ncm:userPlaylist', uid); },
  ncmLyric: function (id) { return call('ncm:lyric', id); },
  ncmRecentSongs: function () { return call('ncm:recentSongs'); },
  ncmPlaylistCreate: function (name) { return call('ncm:playlistCreate', name); },
  ncmPlaylistTrackAdd: function (pid, ids) { return call('ncm:playlistTrackAdd', pid, ids); },
  ncmQrKey: function () { return call('ncm:qrKey'); },
  ncmQrCreate: function (key) { return call('ncm:qrCreate', key); },
  ncmQrCheck: function (key) { return call('ncm:qrCheck', key); },
  ncmLogout: function () { return call('ncm:logout'); },
  ncmIdentify: function (sec) { return call('ncm:identify', sec); },
  ncmDownload: function (url, outDir, name) { return call('ncm:download', url, outDir, name); },

  // ==================== Breeze 朗读（本地 GGUF） ====================
  breezeEnv: function () { return call('breeze:env'); },
  breezeRun: function (cfg) { return call('breeze:run', cfg); },
  breezeStop: function () { return call('breeze:stop'); },
  onBreezeProgress: function (cb) {
    if (!ipcRenderer || !cb) return function () {};
    var h = function (e, d) { try { cb(d); } catch (err) {} };
    ipcRenderer.on('breeze:progress', h);
    return function () { try { ipcRenderer.removeListener('breeze:progress', h); } catch (e) {} };
  },

  machineId: function () { return call('sys:machineId'); },
  updateCheck: function () { return call('update:check'); },
  updateRun: function (info) { return call('update:run', info); },
  updateVersion: function () { return call('update:version'); },
  findLatestVideo: function (dir, since) { return call('sys:findLatestVideo', dir, since); },
  embedShow: function (payload) { return call('embed:show', payload); },
  embedSetBounds: function (b) { return call('embed:setBounds', b); },
  embedNav: function (p) { return call('embed:nav', p); },
  embedHide: function () { return call('embed:hide'); },
  embedState: function () { return call('embed:state'); },
  onEmbedNavState: function (cb) {
    if (!ipcRenderer || !cb) return function () {};
    var h = function (e, d) { try { cb(d); } catch (err) {} };
    ipcRenderer.on('embed:navState', h);
    return function () { try { ipcRenderer.removeListener('embed:navState', h); } catch (e) {} };
  },
  pyEnhance: function (args) { return call('svc:pyEnhance', args); },
  saveLicenseState: function (json) { return call('license:save', json); },
  loadLicenseState: function () { return call('license:load'); },
  readImageDataUrl: function (p) { return call('sys:readImageDataUrl', p); },
  readdirSync: function (d) { return call('sys:readdirSync', d); },
  extRoot: function () { return call('sys:extRoot'); },

  appInfo: () => call('sys:appInfo')
});
