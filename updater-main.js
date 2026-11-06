// vh-Atelier 达芬奇版 · 在线更新（主进程实现）
// 为什么放主进程：达芬奇插件渲染进程 contextIsolation=true，没有 fs/http/child_process，
// 而更新要下载 zip、解压、写文件，全部属于主进程能力。
//
// 与 PR 版对齐的点：
//   · 走自建镜像（服务器代理 codeload），失败才直连 GitHub
//   · SKIP 列表保护用户数据（collect）与大文件（bin/models/breeze/ncm）
//   · 只覆盖不删除，升级后不会丢配置
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

// 这些目录/文件不进更新包，也不会被覆盖（大文件随部署包分发）
const SKIP = ['collect', 'bin', 'models', 'engine', 'ncm', 'runtime', 'stubs',
              'breeze', 'video', 'node_modules', 'data', 'cache', 'music',
              'backups', 'cover_cache', '.git', '_tmp', '_releases'];
const SKIP_EXT = ['.log', '.pyc'];

// ==================== 工具 ====================

function extRoot() { return __dirname; }

function readVersion() {
  try {
    const p = path.join(extRoot(), 'version.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* 忽略 */ }
  // 退化到 package.json
  try {
    const p2 = path.join(extRoot(), 'package.json');
    if (fs.existsSync(p2)) {
      const j = JSON.parse(fs.readFileSync(p2, 'utf8'));
      return { version: j.version, repo: '', branch: '', pluginId: j.pluginId || 'com.vh.atelier' };
    }
  } catch (e) { /* 忽略 */ }
  return { version: '0.0.0' };
}

function verNum(v) {
  return String(v || '0').split('.').map(x => parseInt(x, 10) || 0);
}
function verGt(a, b) {
  const x = verNum(a), y = verNum(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i] || 0, q = y[i] || 0;
    if (p > q) return true;
    if (p < q) return false;
  }
  return false;
}

function get(url, redirects, cb) {
  if (typeof redirects === 'function') { cb = redirects; redirects = 0; }
  if (redirects > 5) return cb(new Error('重定向过多'));
  let mod;
  try { mod = url.indexOf('https') === 0 ? https : http; }
  catch (e) { return cb(e); }
  const req = mod.get(url, { timeout: 60000, headers: { 'User-Agent': 'vh-Atelier-Updater' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return get(res.headers.location, redirects + 1, cb);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return cb(new Error('HTTP ' + res.statusCode));
    }
    const chunks = [];
    res.on('data', d => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
    res.on('error', cb);
  });
  req.on('error', cb);
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} cb(new Error('连接超时')); });
}

// ==================== zip 解压（纯 Node） ====================
// zip 结构：本地文件头 PK\x03\x04 + 数据；中央目录 PK\x01\x02；结尾 PK\x05\x06
// 这里直接读中央目录拿准确的偏移与大小（比顺序扫描可靠）

function unzip(buf) {
  // 找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到 EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const nameBuf = buf.slice(off + 46, off + 46 + nameLen);
    const name = nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1');

    // 读本地头拿真实数据起点
    if (buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      let data = null;
      try {
        if (method === 0) data = raw;
        else if (method === 8) data = zlib.inflateRawSync(raw);
      } catch (e) {
        data = null;
      }
      if (data && name && !name.endsWith('/')) {
        out.push({ name: name, data: data });
      }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ==================== 写入 ====================

function shouldSkip(relPath) {
  const parts = relPath.replace(/\\/g, '/').split('/');
  for (const seg of parts) {
    if (SKIP.indexOf(seg) >= 0) return true;
  }
  const ext = path.extname(relPath).toLowerCase();
  if (SKIP_EXT.indexOf(ext) >= 0) return true;
  if (path.basename(relPath) === '.gitignore') return true;
  return false;
}

function writeEntries(entries, prefix) {
  const root = extRoot();
  let n = 0;
  const failed = [];
  for (const e of entries) {
    let rel = e.name;
    // 去掉 github zip 的顶层目录（形如 repo-branchhash/）
    if (prefix) {
      if (rel.indexOf(prefix + '/') === 0) rel = rel.slice(prefix.length + 1);
      else continue;
    }
    if (!rel || shouldSkip(rel)) continue;
    const dest = path.join(root, rel);
    try {
      const dir = path.dirname(dest);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, e.data);
      n++;
    } catch (err) {
      failed.push({ file: rel, error: String(err && err.message ? err.message : err) });
    }
  }
  return { count: n, failed: failed };
}

// ==================== 检查更新 ====================

function mirrorBase(versionJson) {
  return (versionJson && versionJson.mirrorBase) ||
    'http://47.122.108.231:17894';
}

function checkUpdate() {
  return new Promise((resolve) => {
    const local = readVersion();
    const repo = local.repo || '';
    const branch = local.branch || '';
    const pluginId = local.pluginId || 'com.vh.atelier.resolve';
    const base = mirrorBase(local);

    const urlVersion = base + '/api/update/version?plugin=' + encodeURIComponent(pluginId) + '&_=' + Date.now();

    get(urlVersion, (err, buf) => {
      if (err) return resolve({ ok: false, error: '检查失败：' + err.message, local: local.version });
      let j = null;
      try { j = JSON.parse(buf.toString('utf8')); } catch (e) {}
      if (!j || !j.ok || !j.versionJson) {
        return resolve({ ok: false, error: (j && j.error) || '服务器返回异常', local: local.version });
      }
      const remote = j.versionJson;
      const newer = verGt(remote.version, local.version);
      resolve({
        ok: true,
        local: local.version,
        remote: remote.version,
        newer: newer,
        notes: remote.notes || '',
        buildTime: remote.buildTime || '',
        repo: repo,
        branch: branch,
        pluginId: pluginId,
        mirror: base
      });
    });
  });
}

// ==================== 执行更新 ====================

function doUpdate(info) {
  return new Promise((resolve) => {
    info = info || {};
    const pluginId = info.pluginId || 'com.vh.atelier.resolve';
    const base = info.mirror || mirrorBase(readVersion());
    const zipUrl = base + '/api/update/zip?plugin=' + encodeURIComponent(pluginId) + '&_=' + Date.now();

    get(zipUrl, (err, buf) => {
      if (err) return resolve({ ok: false, error: '下载失败：' + err.message });
      if (!buf || buf.length < 500) return resolve({ ok: false, error: '下载内容异常（' + (buf ? buf.length : 0) + ' 字节）' });

      let entries;
      try { entries = unzip(buf); }
      catch (e) { return resolve({ ok: false, error: '解压失败：' + e.message }); }

      if (!entries.length) return resolve({ ok: false, error: '更新包里没有文件' });

      // 推断顶层目录前缀
      let prefix = '';
      const first = entries[0].name;
      const slash = first.indexOf('/');
      if (slash > 0) prefix = first.slice(0, slash);

      let result;
      try { result = writeEntries(entries, prefix); }
      catch (e) { return resolve({ ok: false, error: '写入失败：' + e.message }); }

      // 写入后从包里取 version.json 更新本地
      try {
        const vEntry = entries.filter(x => x.name.endsWith('/version.json') || x.name === 'version.json')[0];
        if (vEntry) {
          const vpath = path.join(extRoot(), 'version.json');
          fs.writeFileSync(vpath, vEntry.data);
        }
      } catch (e) { /* 忽略 */ }

      resolve({
        ok: true,
        count: result.count,
        failed: result.failed.slice(0, 10),
        failedCount: result.failed.length,
        zipSize: buf.length,
        version: (info.remote || '')
      });
    });
  });
}

module.exports = { checkUpdate, doUpdate, unzip, readVersion, verGt, SKIP };
