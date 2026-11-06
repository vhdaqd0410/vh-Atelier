'use strict';
/**
 * vh-Atelier · DaVinci Resolve 版 · 网易云音乐（主进程）
 *
 * 【比 PR 更省一层】PR 的 CEP 面板没有 Node 环境，所以要单开一个 express 服务
 * （ncm/index.js，端口 17910）供面板走 HTTP 调用。达芬奇版的主进程本身就是 Node，
 * 直接 require 网易云 API 库即可，不需要额外进程、端口和 HTTP 往返。
 *
 * 依赖：ncm/node_modules/NeteaseCloudMusicApi（随插件分发，26.9MB）
 * 登录：扫码登录，cookie 持久化到 collect/ncm_cookie.txt，重启免扫。
 */
const fs = require('fs');
const path = require('path');

let ncm = null;
let loadError = '';
let cookie = '';
let cookieFile = '';

/** 惰性加载：库很大，只在真的用到时才 require */
function api() {
  if (ncm) return ncm;
  if (loadError) throw new Error(loadError);
  try {
    ncm = require(path.join(__dirname, 'ncm', 'node_modules', 'NeteaseCloudMusicApi'));
  } catch (e) {
    loadError = '网易云组件加载失败：' + (e && e.message ? e.message : e)
      + '（请确认 ncm/node_modules 已随插件安装）';
    throw new Error(loadError);
  }
  return ncm;
}

/** cookie 落盘目录：优先 collect/（随插件、有写权限） */
function initDataDir(dir) {
  if (dir) cookieFile = path.join(dir, 'ncm_cookie.txt');
}

function ensureCookieFile() {
  if (cookieFile) return cookieFile;
  // 兜底：插件根目录下 collect/
  cookiesDir();
  return cookieFile;
}

function cookiesDir() {
  const d = path.join(__dirname, 'collect');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 忽略 */ }
  cookieFile = path.join(d, 'ncm_cookie.txt');
  return d;
}

function loadCookie() {
  try {
    ensureCookieFile();
    cookie = fs.readFileSync(cookieFile, 'utf8').trim();
  } catch (e) { cookie = ''; }
  return cookie;
}
function saveCookie(c) {
  cookie = c || '';
  try {
    ensureCookieFile();
    if (c) fs.writeFileSync(cookieFile, c, 'utf8');
    else if (fs.existsSync(cookieFile)) fs.unlinkSync(cookieFile);
  } catch (e) { /* 忽略 */ }
}

/** 统一调用：自动带上 cookie，并把结果规整成 { ok, ... } */
async function call(name, params) {
  const m = api();
  const fn = m[name];
  if (typeof fn !== 'function') throw new Error('网易云接口不存在：' + name);
  const p = Object.assign({}, params || {});
  if (cookie) p.cookie = cookie;
  // 部分接口要 realIP / timestamp，库自行处理
  const r = await fn(p);
  const body = (r && r.body) ? r.body : r;
  return body;
}

/** 能力探测：库在不在、登录没登录 */
async function status() {
  let libOk = false, libErr = '';
  try { api(); libOk = true; } catch (e) { libErr = e.message; }
  let loggedIn = false, nickname = '', userId = null, avatarUrl = '';
  if (libOk && !cookie) loadCookie();
  if (libOk && cookie) {
    try {
      const b = await call('login_status', {});
      const d = (b && b.data) || b || {};
      const prof = d.profile || (d.data && d.data.profile) || null;
      if (prof && prof.userId) {
        loggedIn = true;
        nickname = prof.nickname || '';
        userId = prof.userId;
        avatarUrl = prof.avatarUrl || '';
      }
    } catch (e) { /* 未登录或库报错 */ }
  }
  return {
    libOk: libOk,
    libError: libErr,
    loggedIn: loggedIn,
    nickname: nickname,
    userId: userId,
    avatarUrl: avatarUrl,
    hasCookie: !!cookie,
    cookieSaved: !!cookieFile && fs.existsSync(cookieFile)
  };
}

// ==================== 各功能 ====================

/** 搜索：type 1=单曲 1000=歌单 */
async function search(keywords, type, limit, offset) {
  if (!keywords) throw new Error('请输入搜索词');
  return await call('cloudsearch', {
    keywords: keywords,
    type: type || 1,
    limit: limit || 30,
    offset: offset || 0
  });
}

/** 歌曲直链：优先更高音质；VIP 歌曲需要登录 cookie */
async function songUrl(id, level) {
  if (!id) throw new Error('缺少歌曲 id');
  return await call('song_url_v1', { id: String(id), level: level || 'exhigh' });
}

/** 歌曲详情（歌名/歌手/封面/时长） */
async function songDetail(ids) {
  const arr = Array.isArray(ids) ? ids : [ids];
  return await call('song_detail', { ids: arr.join(',') });
}

/** 歌单详情 */
async function playlistDetail(id) {
  return await call('playlist_detail', { id: String(id) });
}

/** 我的歌单 */
async function userPlaylist(uid) {
  return await call('user_playlist', { uid: String(uid) });
}

/** 歌词 */
async function lyric(id) {
  return await call('lyric', { id: String(id) });
}

/** 最近播放 */
async function recentSongs() {
  return await call('record_recent_song', { limit: 100 });
}

/** 收藏/取消收藏（歌单加歌） */
async function playlistTrackAdd(pid, ids) {
  return await call('playlist_track_add', {
    pid: String(pid),
    ids: (Array.isArray(ids) ? ids : [ids]).join(',')
  });
}
async function playlistCreate(name) {
  return await call('playlist_create', { name: name || 'vh-Atelier' });
}

// ---------- 扫码登录 ----------
let qrKeyCache = '';
async function qrKey() {
  const b = await call('login_qr_key', {});
  const k = b && b.data && b.data.unikey;
  if (!k) throw new Error('获取二维码 key 失败');
  qrKeyCache = k;
  return k;
}
async function qrCreate(key) {
  const k = key || qrKeyCache;
  if (!k) throw new Error('请先获取 key');
  const b = await call('login_qr_create', { key: k, qrimg: true });
  return b && b.data ? b.data : b;   // { qrurl, qrimg(dataURL) }
}
async function qrCheck(key) {
  const k = key || qrKeyCache;
  if (!k) throw new Error('请先获取 key');
  const b = await call('login_qr_check', { key: k });
  const code = b && b.code;
  // 803 = 授权成功，需要把 cookie 存下来
  if (code === 803 && (b.cookie || (b.data && b.data.cookie))) {
    const ck = b.cookie || b.data.cookie;
    saveCookie(ck);
    return { code: 803, ok: true, message: '登录成功', cookie: ck };
  }
  const msg = {
    800: '二维码已过期，请刷新',
    801: '等待扫码',
    802: '已扫码，请在手机上确认',
    803: '登录成功'
  }[code] || ('状态：' + code);
  return { code: code, ok: code === 803, message: msg };
}
function logout() {
  saveCookie('');
  return { ok: true };
}

/**
 * 听歌识曲：wav → 8kHz 单声道 → afp 指纹 → 网易云匹配。
 * 复用 ncm/afp 指纹引擎（与 PR 版同款）。
 * @param {string} wavPath 录音文件
 */
async function identifyFromWav(wavPath) {
  const fs2 = require('fs');
  const pathm = require('path');
  if (!wavPath || !fs2.existsSync(wavPath)) throw new Error('录音文件不存在');

  // afp 需要浏览器 polyfill + 全局对象（与 PR 的 ncm/index.js 同款做法）
  if (typeof global.btoa === 'undefined') global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
  if (typeof global.atob === 'undefined') global.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  if (typeof global.TextEncoder === 'undefined') global.TextEncoder = require('util').TextEncoder;
  global.window = global;
  global.self = global;
  if (typeof global.document === 'undefined') {
    global.document = { createElement: () => ({ getContext: () => null, style: {} }) };
  }

  let afp;
  try {
    afp = require(pathm.join(__dirname, 'ncm', 'afp', 'afp.js'));
  } catch (e) {
    throw new Error('afp 指纹引擎缺失：' + (e && e.message));
  }

  // 读 wav → 8kHz Float32（afp 要求）
  const buf = fs2.readFileSync(wavPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('录音不是有效的 wav');
  const chans = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  // 找到 data 块
  let off = 12, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0) throw new Error('wav 缺少 data 块');

  const bytesPerSample = bits / 8;
  const frameBytes = bytesPerSample * chans;
  const frames = Math.floor(dataLen / frameBytes);
  // 取前 3 秒即可（指纹够用）
  const useFrames = Math.min(frames, Math.floor(sampleRate * 3));
  const mono = new Float32Array(useFrames);
  for (let i = 0; i < useFrames; i++) {
    let sum = 0;
    for (let c = 0; c < chans; c++) {
      const pos = dataOff + i * frameBytes + c * bytesPerSample;
      let v = 0;
      if (bits === 16) v = buf.readInt16LE(pos) / 32768;
      else if (bits === 32) v = buf.readInt32LE(pos) / 2147483648;
      else v = (buf.readUInt8(pos) - 128) / 128;
      sum += v;
    }
    mono[i] = sum / chans;
  }
  // 线性重采样到 8kHz
  const target = 8000;
  let clip = mono;
  if (sampleRate !== target) {
    const n = Math.floor(mono.length * target / sampleRate);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const src = i * sampleRate / target;
      const i0 = Math.floor(src);
      const i1 = Math.min(mono.length - 1, i0 + 1);
      const frac = src - i0;
      out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
    }
    clip = out;
  }

  const duration = Math.round(clip.length / target);
  const fp = await afp.GenerateFP(clip);
  if (!fp) throw new Error('指纹生成失败');

  // 调用网易云匹配接口
  const https = require('https');
  const body = await new Promise((resolve) => {
    const q = '/api/music/audio/match?sessionId=0123456789abcdef&algorithmCode=shazam_v2'
      + '&duration=' + duration + '&rawdata=' + encodeURIComponent(fp) + '&times=1&decrypt=1';
    const req = https.get({
      hostname: 'interface.music.163.com', path: q, timeout: 25000,
      headers: { Cookie: cookie || '', 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
  });

  const result = (body && body.data && body.data.result) || [];
  return { ok: true, duration: duration, matches: result };
}

module.exports = {
  initDataDir,
  loadCookie,
  saveCookie,
  status,
  search,
  songUrl,
  songDetail,
  playlistDetail,
  userPlaylist,
  lyric,
  recentSongs,
  playlistTrackAdd,
  playlistCreate,
  qrKey,
  qrCreate,
  qrCheck,
  logout,
  identifyFromWav
};
