// vh-Atelier 短剧扒歌 · 本地服务
// 端口 17891（ncm 用 17890，互不干扰）
//
// 架构说明：
//   - 本目录 bgm/ 走 GitHub 更新通道（不在 version.json 的 skipDirs 里）
//   - ncm/ 在 skipDirs 里，改它不会下发，所以此服务**只读复用** ncm 的
//     afp 指纹引擎与 .ncm_cookie，不修改 ncm 任何文件
//   - 零 npm 依赖：只用 Node 标准库，避免 node_modules 进更新包
'use strict'

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn, spawnSync } = require('child_process')

const VERSION = '1.0.0'
const PORT = Number(process.env.VH_BGM_PORT) || 17891   // VH_BGM_PORT 仅供本地调试并行起实例，正常固定 17891
const EXT_ROOT = path.resolve(__dirname, '..')
const NCM_DIR = path.join(EXT_ROOT, 'ncm')
const COOKIE_FILE = path.join(NCM_DIR, '.ncm_cookie')
const OUT_ROOT = path.join(EXT_ROOT, 'collect', 'bgm')

// ── afp 指纹引擎（复用 ncm，只读）──
function loadAfp() {
  if (typeof global.btoa === 'undefined') global.btoa = s => Buffer.from(s, 'binary').toString('base64')
  if (typeof global.atob === 'undefined') global.atob = s => Buffer.from(s, 'base64').toString('binary')
  if (typeof global.TextEncoder === 'undefined') global.TextEncoder = require('util').TextEncoder
  global.window = global
  global.self = global
  global.document = { createElement: () => ({ getContext: () => null, style: {} }) }
  return require(path.join(NCM_DIR, 'afp', 'afp.js'))
}

function getCookie() {
  try { return fs.readFileSync(COOKIE_FILE, 'utf8').trim() } catch (e) { return '' }
}

// ── 定位外部资源（优先安装目录，回退本机常见路径）──
function firstExisting(list) {
  for (const p of list) { try { if (p && fs.existsSync(p)) return p } catch (e) {} }
  return null
}

function findFfmpeg() {
  return firstExisting([
    process.env.FFMPEG,
    path.join(EXT_ROOT, 'bin', 'ffmpeg-win32-x64.exe'),
    path.join(EXT_ROOT, 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ]) || 'ffmpeg'
}

function findSherpa() {
  const d = firstExisting([
    process.env.SHERPA_DIR,
    path.join(EXT_ROOT, 'bin', 'sherpa'),
  ])
  return d
}

function findModel() {
  return firstExisting([
    process.env.MODEL_DIR,
    path.join(EXT_ROOT, 'models', 'spleeter', 'sherpa-onnx-spleeter-2stems-fp16'),
  ])
}

// ── 网易云音频匹配（零依赖，等价于 NeteaseCloudMusicApi 的 audio_match）──
function audioMatch(audioFP, duration, cookie) {
  return new Promise((resolve) => {
    const url = 'https://interface.music.163.com/api/music/audio/match' +
      '?sessionId=0123456789abcdef&algorithmCode=shazam_v2&duration=' + duration +
      '&rawdata=' + encodeURIComponent(audioFP) + '&times=1&decrypt=1'
    const req = https.get(url, {
      headers: { Cookie: cookie || '', 'User-Agent': 'Mozilla/5.0' }, timeout: 20000,
    }, res => {
      let s = ''
      res.on('data', d => s += d)
      res.on('end', () => {
        try {
          const j = JSON.parse(s)
          resolve((j.data && j.data.result) || [])
        } catch (e) { resolve([]) }
      })
    })
    req.on('error', () => resolve([]))
    req.on('timeout', () => { req.destroy(); resolve([]) })
  })
}

// ── wav → 8kHz Float32 ──
function wavTo8kFloat32(filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 wav 文件')
  const sampleRate = buf.readUInt32LE(24)
  const channels = buf.readUInt16LE(22)
  const bits = buf.readUInt16LE(34)
  let off = 12, dataStart = -1, dataSize = 0
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4)
    const sz = buf.readUInt32LE(off + 4)
    if (id === 'data') { dataStart = off + 8; dataSize = sz; break }
    off += 8 + sz + (sz % 2)
  }
  if (dataStart < 0) throw new Error('wav 无 data 块')
  const pcm = buf.slice(dataStart, dataStart + dataSize)
  const bps = bits / 8
  const n = Math.floor(pcm.length / (bps * channels))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * bps * channels
    out[i] = bits === 16 ? pcm.readInt16LE(o) / 32768 : pcm.readInt32LE(o) / 2147483648
  }
  if (sampleRate === 8000) return out
  const n8 = Math.floor(n * 8000 / sampleRate)
  const r = new Float32Array(n8)
  for (let i = 0; i < n8; i++) r[i] = out[Math.floor(i * sampleRate / 8000)]
  return r
}

// ── 可杀死的异步进程执行（替代 spawnSync，不阻塞事件循环）──
// 说明：spawnSync 会冻住 Node 事件循环，导致下载/分离期间 /status 与 /cancel 都无法响应。
const runningChildren = new Set()

function runProc(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const cp = spawn(cmd, args, Object.assign({ windowsHide: true }, opts || {}))
    runningChildren.add(cp)
    let out = ''
    if (cp.stdout) cp.stdout.on('data', d => { out += d })
    if (cp.stderr) cp.stderr.on('data', d => { out += d })
    let timer = null
    if (opts && opts.timeout) {
      timer = setTimeout(() => { try { cp.kill() } catch (e) {} }, opts.timeout)
    }
    cp.on('error', e => {
      clearTimeout(timer); runningChildren.delete(cp); reject(e)
    })
    cp.on('close', code => {
      clearTimeout(timer); runningChildren.delete(cp)
      if (code === 0) resolve(out)
      else reject(new Error('exit ' + code + ': ' + out.slice(-250)))
    })
  })
}

// 取消时杀掉所有在跑的子进程
function killAllChildren() {
  for (const cp of runningChildren) {
    try { cp.kill() } catch (e) {}
  }
  runningChildren.clear()
}

// ── ffmpeg 抽音轨（可指定区间，异步）──
async function extractWav(input, outWav, start, end) {
  const args = ['-y', '-v', 'error']
  if (start != null && start !== '') args.push('-ss', String(start))
  args.push('-i', input)
  if (end != null && end !== '') {
    const dur = (start != null && start !== '') ? Number(end) - Number(start) : Number(end)
    args.push('-t', String(dur > 0 ? dur : 0))
  }
  args.push('-vn', '-ac', '2', '-ar', '48000', outWav)
  await runProc(findFfmpeg(), args, { timeout: 600000 })
  if (!fs.existsSync(outWav)) throw new Error('ffmpeg 抽音轨失败')
  return outWav
}

// ── sherpa 人声分离（要求 exe 与 dll/模型同目录）──
function ensureSherpaDir(workDir) {
  const sherpaSrc = findSherpa()
  const modelSrc = findModel()
  if (!sherpaSrc) throw new Error('未找到 sherpa 分离器（bin/sherpa）')
  if (!modelSrc) throw new Error('未找到 spleeter 模型（models/spleeter）')
  const d = path.join(workDir, 'sherpa')
  fs.mkdirSync(d, { recursive: true })
  const need = [
    path.join(sherpaSrc, 'sherpa-onnx-offline-source-separation.exe'),
    path.join(sherpaSrc, 'onnxruntime.dll'),
    path.join(sherpaSrc, 'onnxruntime_providers_shared.dll'),
    path.join(modelSrc, 'vocals.fp16.onnx'),
    path.join(modelSrc, 'accompaniment.fp16.onnx'),
  ]
  for (const src of need) {
    if (!fs.existsSync(src)) throw new Error('缺文件: ' + src)
    const dst = path.join(d, path.basename(src))
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst)
  }
  return d
}

async function separate(sherpaDir, inputWav, outVocals, outAccomp) {
  const exe = path.join(sherpaDir, 'sherpa-onnx-offline-source-separation.exe')
  await runProc(exe, [
    '--spleeter-vocals=' + path.join(sherpaDir, 'vocals.fp16.onnx'),
    '--spleeter-accompaniment=' + path.join(sherpaDir, 'accompaniment.fp16.onnx'),
    '--num-threads=4',
    '--input-wav=' + inputWav,
    '--output-vocals-wav=' + outVocals,
    '--output-accompaniment-wav=' + outAccomp,
  ], { cwd: sherpaDir, timeout: 1800000 })
  if (!fs.existsSync(outAccomp)) throw new Error('人声分离失败')
  return outAccomp
}

// ── 全片滑窗扫描（含静音过滤）──
async function scanWav(afp, wavPath, cookie, opts) {
  const WIN = opts.win || 3
  const STEP = opts.step || 1.5
  const SR = 8000
  const f32 = wavTo8kFloat32(wavPath)
  const total = f32.length / SR
  const hits = [], byId = {}
  let windows = 0, skipped = 0

  for (let off = 0; off + WIN <= total; off += STEP) {
    const s = Math.floor(off * SR)
    const e = Math.min(f32.length, Math.floor((off + WIN) * SR))
    let sum = 0
    for (let k = s; k < e; k++) sum += f32[k] * f32[k]
    const rms = Math.sqrt(sum / Math.max(1, e - s))
    if (rms < (opts.silenceRms || 0.002)) { skipped++; continue }
    windows++
    let fp
    try { fp = await afp.GenerateFP(f32.subarray(s, e)) } catch (err) { continue }
    const results = await audioMatch(fp, WIN, cookie)
    for (const m of results) {
      const sng = m && m.song
      if (!sng || !sng.id) continue
      if (!byId[sng.id]) { byId[sng.id] = { song: sng, count: 0, firstAt: off, lastAt: off }; hits.push(byId[sng.id]) }
      byId[sng.id].count++
      byId[sng.id].lastAt = off
    }
    if (opts.onProgress) opts.onProgress(windows, justCount(total, WIN, STEP))
  }
  hits.sort((a, b) => (b.count - a.count) || (a.firstAt - b.firstAt))
  return { hits, windows, skipped, duration: total }
}

function justCount(total, WIN, STEP) { return Math.max(0, Math.floor((total - WIN) / STEP) + 1) }

// ── 短剧官网搜索 / 剧集信息 ──
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// 单次请求（强制 IPv4，避免 IPv6 握手被 reset）
function fetchTextOnce(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      // 不用 family:4 —— 实测自动选择（family:0）成功率更高（10/10 vs 8/10）
      headers: {
        'User-Agent': WEB_UA,
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://hongguoduanju.com/'
      },
      timeout: timeoutMs
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchTextOnce(res.headers.location, timeoutMs).then(resolve, reject)
      }
      let s = ''
      res.setEncoding('utf8')
      res.on('data', d => s += d)
      res.on('end', () => resolve({ status: res.statusCode, body: s }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('\u8d85\u65f6')) })
  })
}

// 带重试：上游 TLS 有概率被 reset，重试 3 次基本可解
async function fetchText(url, retries = 3) {
  let lastErr = null
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchTextOnce(url)
      // 5xx 也重试
      if (r.status >= 500 && i < retries) {
        lastErr = new Error('HTTP ' + r.status)
        await new Promise(z => setTimeout(z, 300 * (i + 1)))
        continue
      }
      return r.body
    } catch (e) {
      lastErr = e
      if (i < retries) await new Promise(z => setTimeout(z, 300 * (i + 1)))
    }
  }
  throw lastErr || new Error('\u8bf7\u6c42\u5931\u8d25')
}

async function searchDramas(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return []

  // 红果搜索页是 SPA（返回的是空壳 + 埋点脚本），必须走 XHR 接口。
  // 接口：/api/search/result/?query=<关键词>&page=<页码>  每页固定 10 条
  const base = 'https://hongguoduanju.com/api/search/result/?query=' + encodeURIComponent(kw)

  // 上游 TLS 有概率被 reset。先把首页拿稳，再翻页；
  // 首页失败重试到拿到数据为止（否则会把「连不上」误报成「没结果」）。
  let first = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = await fetchText(base + '&page=1', 2)
      const jj = JSON.parse(raw)
      const arr = Array.isArray(jj.searchList) ? jj.searchList : []
      if (arr.length) { first = arr; break }
      // 真·空结果（上游明确返回 0 条），不必再等
      if (typeof jj.totalCount === 'number' && jj.totalCount === 0) { first = []; break }
    } catch (e) { /* 继续重试 */ }
    await new Promise(z => setTimeout(z, 400 * (attempt + 1)))
  }
  if (first === null) return []       // 4 次都失败
  if (!first.length) return []        // 真的没有结果

  const list = first.slice()
  for (const pg of [2, 3]) {          // 再补两页，共最多 30 条
    if (list.length >= 30) break
    try {
      const raw = await fetchText(base + '&page=' + pg, 2)
      const jj = JSON.parse(raw)
      const arr = Array.isArray(jj.searchList) ? jj.searchList : []
      if (!arr.length) break
      list.push.apply(list, arr)
      if (arr.length < 10) break
    } catch (e) {
      break
    }
  }

  const out = [], seen = {}
  for (const item of list) {
    if (out.length >= 30) break
    const vd = item.video_data || {}
    const sid = String(vd.series_id || item.keyword || '')
    if (!sid || seen[sid]) continue
    seen[sid] = 1

    const name = vd.series_title || item.name || ''
    let cover = vd.series_cover || vd.cover || vd.thumb_url || ''
    if (Array.isArray(cover)) cover = cover[0] || ''
    if (typeof cover === 'string') cover = cover.replace(/&amp;/g, '&')

    // 标签
    const tags = []
    for (const k of ['category_name', 'category', 'tags']) {
      const v = vd[k]
      if (Array.isArray(v)) v.forEach(x => { if (x && tags.length < 4) tags.push(String(x)) })
      else if (typeof v === 'string' && v && tags.length < 4) tags.push(v)
    }

    out.push({
      series_id: sid,
      name: name,
      cover: cover,
      tags: tags,
      hot: Number(vd.play_cnt || vd.hot || 0),
      score: Number(vd.score || 0),
      episode_cnt: Number(vd.episode_cnt || 0),
      intro: String(vd.series_intro || '')
    })
  }
  return out
}

async function getSeries(seriesId) {
  const html = await fetchText(`https://hongguoduanju.com/player/${seriesId}/`)
  const nm = /"series_name":"([^"]*)"/.exec(html)
  const mv = /"vid_list":\[([^\]]+)\]/.exec(html)
  const vids = mv ? (mv[1].match(/"(\d+)"/g) || []).map(x => x.replace(/"/g, '')) : []
  let cover = ''
  const cm = /"series_cover":"([^"]*)"/.exec(html)
  if (cm) cover = cm[1].replace(/\\u002F/g, '/')
  let intro = ''
  const im = /"series_intro":"([^"]*)"/.exec(html)
  if (im) intro = im[1]
  const tags = []
  const tm = /"tags":\[([^\]]*)\]/.exec(html)
  if (tm) (tm[1].match(/"([^"]*)"/g) || []).forEach(x => tags.push(x.replace(/"/g, '')))
  return { series_id: seriesId, name: nm ? nm[1] : seriesId, cover, intro, tags, vid_list: vids, count: vids.length }
}


// ════════════════════════════════════════════════════════════════════
// 短剧采集源（优先于官网链路）
// ════════════════════════════════════════════════════════════════════
// 为什么要这一层：
//   红果官网页面只给 video/public/<vid>/360p.mp4，那是 10 秒试看片段；
//   正片走 /api/video/protected/ 的火山 VOD + DRM（playauth / drmkek /
//   x-amz-signature），且 accessible_episode_cnt 只有 5 集。纯 JS 拿不到、
//   拿不稳。所以改走苹果 CMS 采集源：这些源由第三方维护、直接给 m3u8
//   全集，不需要登录、不需要签名、不需要设备号。
//
// 端口与协议不变，只是 getVideo 的取地址顺序变了。
// ════════════════════════════════════════════════════════════════════

// 采集源清单（2026-11 实测校准）
//   kind: single = 每集一条 m3u8，可直接精确到集；merged = 合并集需按时间轴切片；page = 只给 /play/ 网页，归一化后变合并集
//   order 越小越优先；dead=true 的源保留在表里但不参与搜索（记录实测结论，便于日后回查）
// 2026-11-18 重新实测校准（35 个候选源里活下来 11 个）
// 覆盖排行（12 部短剧样本）：无尽 8、极速/光速/金鹰/量子 7、魔都 4、非凡/360/iKun 3、如意 2、百度云 1
// kind: single = 每集一条 m3u8（能精确到集）；page = /play/ 网页，归一化后是合并集
const DRAMA_SOURCES = [
  // 覆盖最高，单集粒度，优先
  { id: 'wujin', name: '无尽资源', api: 'https://api.wujinapi.me/api.php/provide/vod/', kind: 'single', order: 1 },
  { id: 'mdzy', name: '魔都资源', api: 'https://www.mdzyapi.com/api.php/provide/vod/', kind: 'single', order: 2 },
  { id: 'lzzy', name: '量子资源', api: 'https://cj.lziapi.com/api.php/provide/vod/', kind: 'single', order: 3 },
  { id: 'rycj', name: '如意资源', api: 'https://cj.rycjapi.com/api.php/provide/vod/', kind: 'single', order: 4 },
  { id: 'ffzy', name: '非凡影视', api: 'https://cj.ffzyapi.com/api.php/provide/vod/', kind: 'single', order: 5 },
  { id: 'zy360', name: '360资源', api: 'https://360zy.com/api.php/provide/vod/', kind: 'single', order: 6 },
  { id: 'ikun', name: 'iKun资源', api: 'https://ikunzyapi.com/api.php/provide/vod/', kind: 'single', order: 7 },
  { id: 'bdzy', name: '百度云资源', api: 'https://api.apibdzy.com/api.php/provide/vod/', kind: 'single', order: 8 },
  // 合并集源：覆盖也不错，单集源全失败时才用
  { id: 'jszy', name: '极速资源', api: 'https://jszyapi.com/api.php/provide/vod/', kind: 'page', order: 21 },
  { id: 'gszy', name: '光速资源', api: 'https://api.guangsuapi.com/api.php/provide/vod/', kind: 'page', order: 22 },
  { id: 'jyzy', name: '金鹰资源', api: 'https://jinyingzy.com/api.php/provide/vod/', kind: 'page', order: 23 },
  // 实测死亡：暴风 m3u8 全线 404 + API 偶发 TLS EOF
  { id: 'bfzy', name: '暴风资源', api: 'https://bfzyapi.com/api.php/provide/vod/', kind: 'single', order: 90, dead: true },
]

// 参与搜索的源（按 order 升序）
const ACTIVE_SOURCES = DRAMA_SOURCES.filter(s => !s.dead).sort((a, b) => a.order - b.order)

// ── 播放地址归一化 ────────────────────────────────────────────
// 采集站的 vod_play_url 可能给四种东西：
//   1) 直链 m3u8              → 原样用
//   2) /play/xxx 播放页       → 页面内嵌的就是 /play/xxx/index.m3u8，直接拼
//   3) /share/xxx 分享页      → 实测多为 404（非凡），交给探活判定失败
//   4) 多线路 "a$$$720P$b"    → 取第一段
// 只做确定性字符串转换，不发网络请求；能不能播由 probePlayable 判定。
function normalizePlayUrl(raw) {
  let u = String(raw || '').trim()
  if (!u) return ''
  if (u.indexOf('$$$') >= 0) u = u.split('$$$')[0].trim()
  if (!/^https?:\/\//i.test(u)) return ''
  if (/\.m3u8(\?|$)/i.test(u)) return u
  if (/\/play\/[^/?#]+\/?(\?|$)/i.test(u)) {
    return u.replace(/[?#].*$/, '').replace(/\/$/, '') + '/index.m3u8'
  }
  return u
}

// 探活：头部取 2KB 判断是不是真 m3u8。超时短，任何失败都返回 false，不抛。
function probePlayable(url, timeoutMs) {
  return new Promise((resolve) => {
    let target
    try { target = normalizePlayUrl(url) } catch (e) { return resolve(false) }
    if (!target) return resolve(false)
    let u
    try { u = new URL(target) } catch (e) { return resolve(false) }
    const mod = u.protocol === 'https:' ? https : http
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'User-Agent': DRAMA_UA, 'Accept': '*/*', 'Range': 'bytes=0-2047' },
      timeout: timeoutMs || 6000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        try {
          const loc = /^https?:\/\//i.test(res.headers.location)
            ? res.headers.location
            : new URL(res.headers.location, target).toString()
          return probePlayable(loc, timeoutMs).then(finish, () => finish(false))
        } catch (e) { return finish(false) }
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return finish(false) }
      const chunks = []
      let size = 0
      res.on('data', (d) => { chunks.push(d); size += d.length; if (size > 2048) { try { res.destroy() } catch (e) {} } })
      res.on('end', () => {
        const head = Buffer.concat(chunks).toString('utf8', 0, 512)
        finish(head.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U'))
      })
      res.on('error', () => finish(false))
    })
    req.on('error', () => finish(false))
    req.on('timeout', () => { try { req.destroy() } catch (e) {} finish(false) })
  })
}

const DRAMA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// 采集源结果缓存：seriesId -> { at, hit }
// 一部剧只需搜一次，后续每集直接复用。30 分钟内有效。
const dramaSearchCache = new Map()

// 集数列表缓存：videokey -> { at, map }
const dramaEpsCache = new Map()

function normTitle(s) {
  return String(s || '')
    .replace(/[\s，,。.、：:！!？?《》【】\[\]（）()·\-—_"'“”‘’]/g, '')
    .replace(/第[一二三四五六七八九十\d]+[部季]$/g, '')
    .toLowerCase()
}

// 找最匹配的条目：优先名字归一化后相等，其次互相包含
function pickBestDrama(list, wantTitle) {
  const want = normTitle(wantTitle)
  if (!want) return null
  let exact = null, contains = null, partial = null
  for (const it of list) {
    const nm = normTitle(it.vod_name)
    if (!nm) continue
    if (nm === want) { exact = it; break }
    if (!contains && (nm.includes(want) || want.includes(nm))) contains = it
    if (!partial && nm.slice(0, 6) === want.slice(0, 6)) partial = it
  }
  return exact || contains || partial || null
}

// 从 vod_play_url 解析集号 -> 播放地址
// 格式："第1集$http://...#第2集$http://...#..."
// 也兼容 "第1-40集$url" 这种合并集（取区间起点）
function parsePlayUrl(playUrl) {
  const out = []
  if (!playUrl) return out
  for (const seg of String(playUrl).split('#')) {
    const i = seg.indexOf('$')
    if (i < 0) continue
    const label = seg.slice(0, i)
    const raw = seg.slice(i + 1).trim()
    if (!/^https?:\/\//i.test(raw)) continue
    const m = /(\d+)/.exec(label)
    if (!m) continue
    // 归一化后才是真正能喂给播放器/ffmpeg 的地址（/play/xxx → /play/xxx/index.m3u8）
    const url = normalizePlayUrl(raw)
    // 合并集形如「第1-20集」，记下区间终点，供 resolveFromSource 做时间轴切片
    const rng = /(\d+)\s*[-–~]\s*(\d+)/.exec(label)
    const epTo = rng ? parseInt(rng[2], 10) : 0
    out.push({ ep: parseInt(m[1], 10), epTo: epTo, label: label, url: url, raw: raw })
  }
  return out
}

// 向单个采集源要一部剧的分集表。失败/未命中/无分集都返回 null。
async function queryOneSource(src, seriesName) {
  // 原名搜不到时去掉「第N季/第N部/第N集」再试一次（实测对系列短剧有效）
  const tries = [seriesName]
  const stripped = String(seriesName || '').replace(/第[一二三四五六七八九十百\d]+[季部集期]$/, '').trim()
  if (stripped && stripped !== seriesName) tries.push(stripped)

  for (const kw of tries) {
    const url = src.api + '?ac=detail&wd=' + encodeURIComponent(kw)
    let txt
    try { txt = await fetchTextWithUA(url, DRAMA_UA, 12000) } catch (e) { continue }
    let j = null
    try { j = JSON.parse(txt) } catch (e) { continue }
    const list = (j && j.list) || []
    if (!list.length) continue
    const best = pickBestDrama(list, kw)
    if (!best) continue
    // 季号校验：原名带「第N季」时必须匹配同一季，否则会串季
    const wantSeason = /第([一二三四五六七八九十\d]+)季/.exec(seriesName)
    if (wantSeason && kw === stripped) {
      const gotSeason = /第([一二三四五六七八九十\d]+)季/.exec(best.vod_name || '')
      if (gotSeason && gotSeason[1] !== wantSeason[1]) continue
    }
    const eps = parsePlayUrl(best.vod_play_url)
    if (!eps.length) continue
    return {
      source: src.name,
      sourceId: src.id,
      kind: src.kind || 'single',
      order: src.order || 50,
      title: best.vod_name,
      remarks: best.vod_remarks || '',
      eps: eps.sort((a, b) => a.ep - b.ep),
      count: eps.length,
    }
  }
  return null
}

// 按剧缓存「所有源的完整分集表」。不再只留一个源——留全部，
// 这样某一集在 A 源失效时还能换 B 源，这是"能搜到但放不出来"的根治办法。
const normOrder = (hits) => hits.slice().sort((a, b) => {
  // 单集源优先（能精确到集），再按 order
  const ka = a.kind === 'single' ? 0 : 1
  const kb = b.kind === 'single' ? 0 : 1
  if (ka !== kb) return ka - kb
  return (a.order || 50) - (b.order || 50)
})

// 搜索所有源，但只等 SOFT_WAIT 毫秒。
// 为什么不等全部：11 个源里只要有 1 个卡 13 秒，Promise.all 就整体 13 秒，
// 而用户第一次点播放等 13 秒是不可接受的。慢源的结果继续在后台补进缓存，
// 本次先用已拿到的源取流；下次点同一部剧时缓存里已经有全量结果。
// 两级等待：目标是在「不让用户久等」和「必须拿到单集源」之间取平衡。
//   L1 FAST_WAIT 毫秒内只要出现单集源就立刻返回（常见情况，约 1~3 秒）
//   L2 若到 FAST_WAIT 仍无单集源，继续等到 SLOW_WAIT（等魔都这类慢源）
const FAST_WAIT = 3000
const SLOW_WAIT = 9000

async function searchAllSources(seriesName) {
  if (!seriesName) return []
  const key = normTitle(seriesName)
  const c = dramaSearchCache.get(key)
  // 缓存命中：完整结果直接用；partial 的只在没有单集源时复用（避免一直用残缺结果）
  if (c && Date.now() - c.at < 30 * 60 * 1000) {
    const hasSingle = (c.hits || []).some(h => h.kind === 'single')
    if (!c.partial || hasSingle) return c.hits || []
  }

  const collected = []
  let done = false
  const tasks = ACTIVE_SOURCES.map(s =>
    queryOneSource(s, seriesName)
      .then(h => { if (h) collected.push(h) })
      .catch(() => {})
  )
  const all = Promise.all(tasks).then(() => { done = true })

  const hasSingle = () => collected.some(h => h.kind === 'single')
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  // L1：等到出现单集源，或 FAST_WAIT 到时
  const l1End = Date.now() + FAST_WAIT
  while (!done && !hasSingle() && Date.now() < l1End) await sleep(120)
  // L2：还没有单集源就继续等（最多到 SLOW_WAIT 总时长）
  if (!hasSingle()) {
    const l2End = Date.now() + Math.max(0, SLOW_WAIT - FAST_WAIT)
    while (!done && !hasSingle() && Date.now() < l2End) await sleep(150)
  }
  // 已有单集源但还想更全：非阻塞，让后台继续收集

  const hits = normOrder(collected)
  if (!done) {
    dramaSearchCache.set(key, { at: Date.now(), hits, partial: true })
    all.then(() => {
      const full = normOrder(collected)
      dramaSearchCache.set(key, { at: Date.now(), hits: full, partial: false })
    })
  } else {
    dramaSearchCache.set(key, { at: Date.now(), hits, partial: false })
  }
  return hits
}

// 兼容旧调用点：返回第一个可用的源（不做探活，仅用于「有没有这部剧」判断）
async function searchDramaOnce(seriesName) {
  const hits = await searchAllSources(seriesName)
  return hits.length ? hits[0] : null
}

// 单集取流：逐源探活，命中即用。
//   - 偏好：上次成功的源排最前（preferredSource）
//   - 缓存：同一集 10 分钟内复用，重复点不重复探测
//   - 全失败返回 null，并在结果里带上各源的失败原因
const episodeCache = new Map()   // "normTitle|ep" -> { at, hit, triedAll }
const EPISODE_CACHE_MS = 10 * 60 * 1000
// 每部剧记住上次成功的源，下次优先试它，减少探测延迟
const preferredSource = new Map()  // normTitle -> sourceId

async function resolveEpisodePlayable(seriesName, epNo) {
  if (!seriesName) return { ok: false, msg: '缺少剧名' }
  const titleKey = normTitle(seriesName)
  const ck = titleKey + '|' + epNo
  const cached = episodeCache.get(ck)
  if (cached && Date.now() - cached.at < EPISODE_CACHE_MS) return cached.result

  const hits = await searchAllSources(seriesName)
  if (!hits.length) {
    const r = { ok: false, msg: '采集源没有这部剧（红果自制剧常不在采集站片库）', tried: [] }
    episodeCache.set(ck, { at: Date.now(), result: r })
    return r
  }

  // 排序：kind 优先（单集 >> 合并集），其次偏好源，最后 order。
  // 注意顺序不能反 —— 偏好优先级如果压过 kind，上次选中过合并集源，
  // 这次就会继续用合并集，用户点第 1 集还是看到整段合集。
  const pref = preferredSource.get(titleKey)
  const ordered = hits.slice().sort((a, b) => {
    const ka = a.kind === 'single' ? 0 : 1
    const kb = b.kind === 'single' ? 0 : 1
    if (ka !== kb) return ka - kb          // 1) 单集源永远在前
    if (pref) {                             // 2) 同类源内部，偏好优先
      if (a.sourceId === pref && b.sourceId !== pref) return -1
      if (b.sourceId === pref && a.sourceId !== pref) return 1
    }
    return (a.order || 50) - (b.order || 50)   // 3) 再按 order
  })

  const tried = []
  // 竞速式并发，但分两轮：先只探「单集源」，全失败才探「合并集源」。
  // 为什么必须分轮：单集源能给到精确的某一集，合并集源给的是"第1-20集"整段。
  // 如果混在一起竞速，响应快的合并集源会抢先，用户点第1集却看到 39 分钟合集。
  const race = (list) => new Promise((resolve) => {
    if (!list.length) return resolve(null)
    let pending = list.length
    const results = []
    for (const t of list) {
      t.p.then((r) => {
        pending--
        results.push({ t, r })
        if (r.ok) return resolve({ h: t.h, e: t.e, r })
        tried.push({ source: t.h.source, msg: r.msg })
        if (pending === 0) resolve(null)
      }).catch(() => {
        pending--
        if (pending === 0) resolve(null)
      })
    }
  })

  const buildTasks = (list) => {
    const out = []
    for (const h of list) {
      const e = findEpisodeEntry(h, epNo)
      if (!e) { tried.push({ source: h.source, msg: '该源无此集' }); continue }
      out.push({ h, e, p: probeStreamFull(e.url, 5000) })
    }
    return out
  }

  const singleSrc = ordered.filter(h => h.kind === 'single')
  const mergedSrc = ordered.filter(h => h.kind !== 'single')

  let winner = await race(buildTasks(singleSrc))
  if (!winner) winner = await race(buildTasks(mergedSrc))

  if (!winner && !singleSrc.length && !mergedSrc.length) {
    const r = { ok: false, msg: '这部剧所有源都没有第 ' + epNo + ' 集', tried }
    episodeCache.set(ck, { at: Date.now(), result: r })
    return r
  }

  if (winner) {
    const { h, e } = winner
    preferredSource.set(titleKey, h.sourceId)
    const result = {
      ok: true,
      url: e.url,
      label: e.label,
      source: h.source,
      sourceId: h.sourceId,
      title: h.title,
      count: h.count,
      kind: h.kind || 'single',
      ep: e.ep,
      epTo: e.epTo || 0,
      isMerged: !!(e.epTo && e.epTo > e.ep),
      tried: tried,
    }
    episodeCache.set(ck, { at: Date.now(), result })
    return result
  }

  const r = {
    ok: false,
    msg: '这部剧在 ' + hits.length + ' 个源里都取不到第 ' + epNo + ' 集',
    tried: tried,
  }
  episodeCache.set(ck, { at: Date.now(), result: r })
  return r
}

// 在某个源的分集表里找第 epNo 集（含合并集区间匹配）
function findEpisodeEntry(hit, epNo) {
  const direct = hit.eps.find(x => x.ep === epNo)
  if (direct) return direct
  for (const x of hit.eps) {
    const m = /(\d+)\s*[-–~]\s*(\d+)/.exec(x.label || '')
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10)
      if (epNo >= a && epNo <= b) {
        return { ep: x.ep, epTo: parseInt(m[2], 10), label: x.label + '（合并集）', url: x.url }
      }
    }
  }
  return null
}

// 完整探测一条流：master → 子清单 → AES key → 首分片。
// 只看 master 是不是 m3u8 不够——子清单 404、key 取不到、分片 403 都会导致播不了。
async function probeStreamFull(url, timeoutMs) {
  const target = normalizePlayUrl(url)
  if (!target) return { ok: false, msg: '地址为空' }
  try {
    const first = await httpGetHead(target, timeoutMs || 5000)
    if (!first.ok) return { ok: false, msg: '主清单 ' + first.msg }
    let body = first.text
    let base = target
    if (!body.trimStart().startsWith('#EXTM3U')) return { ok: false, msg: '非 m3u8' }
    // master → 取子清单
    if (body.indexOf('#EXT-X-STREAM-INF') >= 0) {
      const subs = body.split(/\r?\n/).map(l => l.trim()).filter(l => l && l[0] !== '#')
      if (!subs.length) return { ok: false, msg: '主清单无子流' }
      const sub = new URL(subs[0], base).toString()
      const r2 = await httpGetHead(sub, timeoutMs || 5000)
      if (!r2.ok) return { ok: false, msg: '子清单 ' + r2.msg }
      if (!r2.text.trimStart().startsWith('#EXTM3U')) return { ok: false, msg: '子清单非 m3u8' }
      body = r2.text
      base = sub
    }
    // AES key
    const km = /#EXT-X-KEY:[^\n]*URI="([^"]+)"/.exec(body)
    if (km) {
      const kurl = new URL(km[1], base).toString()
      const kr = await httpGetHead(kurl, timeoutMs || 5000)
      if (!kr.ok) return { ok: false, msg: 'AES key ' + kr.msg }
      if (kr.buf.length !== 16) return { ok: false, msg: 'AES key 长度异常' }
    }
    // 首分片
    const segs = body.split(/\r?\n/).map(l => l.trim()).filter(l => l && l[0] !== '#')
    if (!segs.length) return { ok: false, msg: '无分片' }
    const seg = new URL(segs[0], base).toString()
    const sr = await httpGetHead(seg, timeoutMs || 5000, 'bytes=0-1023')
    if (!sr.ok) return { ok: false, msg: '分片 ' + sr.msg }
    if (sr.buf.length < 100) return { ok: false, msg: '分片过小' }
    return { ok: true, segCount: segs.length }
  } catch (e) {
    return { ok: false, msg: String(e.message || e).slice(0, 30) }
  }
}

// 轻量 HTTP GET（取前 2~4KB 即可判断），返回 {ok, status, text, buf, msg}
function httpGetHead(url, timeoutMs, range) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch (e) { return resolve({ ok: false, msg: '地址非法' }) }
    if (!/^https?:$/.test(u.protocol)) return resolve({ ok: false, msg: '协议不支持' })
    const mod = u.protocol === 'https:' ? https : http
    const headers = { 'User-Agent': DRAMA_UA, 'Accept': '*/*' }
    headers['Range'] = range || 'bytes=0-4095'
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: timeoutMs || 5000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        let loc = res.headers.location
        try { if (!/^https?:/i.test(loc)) loc = new URL(loc, url).toString() } catch (e) {}
        return httpGetHead(loc, timeoutMs, range).then(finish, () => finish({ ok: false, msg: '重定向失败' }))
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume()
        return finish({ ok: false, status: res.statusCode, msg: 'HTTP ' + res.statusCode })
      }
      const chunks = []
      let size = 0
      res.on('data', (d) => {
        chunks.push(d); size += d.length
        if (size >= 4096) { try { res.destroy() } catch (e) {} }
      })
      const doneRead = () => {
        const buf = Buffer.concat(chunks)
        let text = buf.toString('utf8')
        if (text.indexOf('\ufffd') >= 0) {
          try { text = buf.toString('latin1') } catch (e) {}
        }
        finish({ ok: true, status: res.statusCode, buf, text })
      }
      res.on('end', doneRead)
      res.on('close', doneRead)
      res.on('error', () => finish({ ok: false, msg: '读取中断' }))
    })
    req.on('error', (e) => finish({ ok: false, msg: 'ERR ' + (e.code || '').slice(0, 12) }))
    req.on('timeout', () => { try { req.destroy() } catch (e) {} finish({ ok: false, msg: '超时' }) })
  })
}

// 兼容旧调用点（下载链路仍在用）：退化为「取第一个能探通的源」
async function resolveFromSource(seriesName, epNo) {
  const r = await resolveEpisodePlayable(seriesName, epNo)
  if (!r.ok) return null
  return {
    url: r.url,
    label: r.label,
    source: r.source,
    title: r.title,
    count: r.count,
    kind: r.kind,
    ep: r.ep,
    epTo: r.epTo,
    isMerged: r.isMerged,
  }
}

// 带 UA 的文本抓取（采集站需要浏览器 UA，否则返回空）
function fetchTextWithUA(url, ua, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u = null
    try { u = new URL(url) } catch (e) { return reject(new Error('bad url')) }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'User-Agent': ua || DRAMA_UA,
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: timeoutMs || 15000,
    }, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const loc = res.headers.location
        return fetchTextWithUA(
          /^https?:\/\//i.test(loc) ? loc : new URL(loc, url).toString(),
          ua, timeoutMs).then(resolve, reject)
      }
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => {
        let buf = Buffer.concat(chunks)
        let txt = buf.toString('utf8')
        // 采集站有时用 GBK
        if (txt.indexOf('\ufffd') >= 0 || !/[\u4e00-\u9fa5]/.test(txt)) {
          try { txt = buf.toString('gbk') } catch (e) {}
        }
        resolve(txt)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { try { req.destroy() } catch (e) {} reject(new Error('timeout')) })
  })
}

// ════════════════════════════════════════════════════════════════════


// ── 官网播放页取 mp4 直链（仅作最后兜底，且必须校验时长）──
//
// 注意：这个链路拿到的是 10 秒试看片段，不是正片。
// 页面里 protectedPlayback=true、accessible_episode_cnt=5，
// 正片走 /api/video/protected/ 的火山 VOD + DRM，纯 JS 无法稳定获取。
// 正常流程应先走 DRAMA_SOURCES 采集源，这里只用于极端情况。
// 页面 JSON-LD 里内置 contentUrl，是明文 mp4（无 DRM）；旧版字段为 main_url
async function resolveWebVideo(seriesId, vid) {
  const url = `https://hongguoduanju.com/player/${seriesId}/` + (vid ? `${vid}/` : '')
  const html = await fetchText(url)
  const pick = (key) => {
    const m = new RegExp('"' + key + '"\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([\\d.]+))').exec(html)
    return m ? (m[1] !== undefined ? m[1] : m[2]) : ''
  }
  // 上游页面 2025 改版：视频地址字段从 main_url 改为 contentUrl
  // （实测新页面已无 main_url / video_player_info，只保留 JSON-LD 里的 contentUrl）
  // 两个都取，兼容旧页面结构。
  let main = pick('contentUrl') || pick('main_url') || pick('play_url')
  main = main.replace(/\\u002F/g, '/')

  // 时长以页面 JSON-LD 为准（如 PT2M6S = 126 秒）。
  // 注意：video/public 下的 mp4 可能只是 10 秒预告片段，
  // 不能用它的实际时长冒充整集长度，否则前端会显示成几秒。
  let dur = pick('duration') || ''
  let durSec = 0
  const dm = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(dur)
  if (dm) durSec = (+dm[1] || 0) * 3600 + (+dm[2] || 0) * 60 + (parseFloat(dm[3]) || 0)

  // 拿不到直链时仍然返回时长（前端可据此显示真实集长，不因缺链接而丢时长）
  if (!main) {
    return {
      url: '',
      name: (/"series_name"\s*:\s*"([^"]*)"/.exec(html) || [])[1] || '',
      vid: vid || '',
      frame: '',
      duration: Math.round(durSec),
      locked: true
    }
  }
  const nm = /"series_name"\s*:\s*"([^"]*)"/.exec(html)
  const v = /"vid"\s*:\s*"(\d+)"/.exec(html)
  return {
    url: main.replace(/&amp;/g, '&'),
    name: nm ? nm[1] : '',
    vid: v ? v[1] : (vid || ''),
    frame: (pick('width') || '') + 'x' + (pick('height') || ''),
    duration: Math.round(durSec),
  }
}

// ── 下载单集（ffmpeg 直接拉取，可限时长）──
async function downloadVideo(url, outPath, limitSeconds) {
  const args = ['-y', '-v', 'error']
  if (limitSeconds) args.push('-t', String(limitSeconds))
  args.push('-i', url, '-c', 'copy', '-movflags', '+faststart', outPath)
  await runProc(findFfmpeg(), args, { timeout: 1800000 })
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 10000) {
    throw new Error('下载失败或文件过小')
  }
  return fs.statSync(outPath).size
}

function safeName(s) { return String(s || 'video').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) }

// ── App 链路下载（可下官网限制外的集）────────────────────────────
// 官网只开放前 3 集；后面的集走红果 App 接口（需字节签名 + 设备号）。
// 签名库与依赖已内置在 py/libs + py/liushen，不依赖用户环境。
function findPython() {
  const cands = [
    process.env.VH_PYTHON,
    'C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python310\\python.exe',
    'C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
    'C:\\Python310\\python.exe',
  ]
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c } catch (e) {}
  }
  return 'python'
}

const APP_DL = path.join(EXT_ROOT, 'py', 'hongguo_app_dl.py')

async function appDownload(seriesId, vid, epNo, seriesName, outDir, onProgress) {
  if (!fs.existsSync(APP_DL)) throw new Error('App 下载脚本缺失: ' + APP_DL)
  const py = findPython()
  const args = [APP_DL, '--vid', vid, '--ep', String(epNo), '--out', outDir]
  if (seriesName) args.push('--name', seriesName)
  const out = await runProc(py, args, { timeout: 900000 })
  // 解析 JSON 行事件
  let done = null, err = null
  for (const line of String(out).split('\n')) {
    const t = line.trim()
    if (!t || t[0] !== '{') continue
    let j = null
    try { j = JSON.parse(t) } catch (e) { continue }
    if (j.event === 'progress' && onProgress) onProgress(j.percent || 0, j.msg || '')
    else if (j.event === 'done') done = j
    else if (j.event === 'error') err = j.msg || '未知错误'
  }
  if (!done) throw new Error(err || 'App 链路下载失败')
  return done   // { file, size, height, ep }
}

// 下载目录：优先用视频板块的 collect/video，回退 collect/bgm/downloads
function videoDir() {
  const d = path.join(EXT_ROOT, 'collect', 'video')
  fs.mkdirSync(d, { recursive: true })
  return d
}

// ── 音乐下载：从网易云拿直链存到本地（可配目录）──
// 网易云接口：GET http://127.0.0.1:17890/song/url?id=&br=
function musicDir() {
  const f = path.join(EXT_ROOT, 'collect', 'bgm', 'music_dir.txt')
  try {
    const d = fs.readFileSync(f, 'utf8').trim()
    if (d) { fs.mkdirSync(d, { recursive: true }); return d }
  } catch (e) {}
  const d = path.join(EXT_ROOT, 'collect', 'bgm', 'music')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function setMusicDir(d) {
  const f = path.join(EXT_ROOT, 'collect', 'bgm', 'music_dir.txt')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, d, 'utf8')
}

function httpGetJson(url, cookie) {
  return new Promise(resolve => {
    const http = require('http')
    const mod = url.indexOf('https:') === 0 ? https : http
    const u = new URL(url)
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity' }
    if (cookie) headers.Cookie = cookie
    const rq = mod.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers, timeout: 20000 }, rs => {
      const chunks = []
      rs.on('data', d => chunks.push(d))
      rs.on('end', () => {
        let buf = Buffer.concat(chunks)
        // 某些服务会 gzip（即使请求 identity）
        if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
          try { buf = require('zlib').gunzipSync(buf) } catch (e) {}
        }
        const s = buf.toString('utf8')
        try { resolve(JSON.parse(s)) } catch (e) { resolve({ _parseError: true, _raw: s.slice(0, 200) }) }
      })
    })
    rq.on('error', () => resolve({}))
    rq.on('timeout', () => { rq.destroy(); resolve({}) })
  })
}

async function downloadSongFile(songId, name, artist, cookie, paramDir) {
  // 1) 拿直链（走本地 ncm 服务）
  const j = await httpGetJson('http://127.0.0.1:17890/song/url?id=' + encodeURIComponent(songId) + '&br=320000')
  const d = (j.data || [])[0]
  if (!d || !d.url) {
    // \u7ec6\u5206\u5931\u8d25\u539f\u56e0\uff0c\u907f\u514d\u4e00\u5f8b\u8bf4\u300c\u53ef\u80fd\u9700\u8981\u4f1a\u5458\u300d\u8bef\u5bfc
    var why = 'song:url \u672a\u8fd4\u56de\u76f4\u94fe'
    if (!d) why = '\u63a5\u53e3\u65e0\u6570\u636e\uff08id \u53ef\u80fd\u65e0\u6548\uff09'
    else if (d.freeTrialInfo) why = '\u4ec5\u8bd5\u542c\u7247\u6bb5\uff08\u9700\u8981\u4f1a\u5458\uff09'
    else if (d.level === null || d.level === 'none') why = '\u65e0\u7248\u6743/\u5df2\u4e0b\u67b6\uff08\u6b64\u6b4c\u653e\u4e0d\u4e86\uff09'
    else why = '\u5f53\u524d\u7801\u7387\u4e0d\u53ef\u7528\uff08code=' + (d.code || '?') + '\uff09'
    // \u518d\u8bd5\u4f4e\u7801\u7387\uff1a\u6709\u65f6 320k \u4e0d\u53ef\u7528\u4f46 128k \u53ef\u7528
    try {
      const j2 = await httpGetJson('http://127.0.0.1:17890/song/url?id=' + encodeURIComponent(songId) + '&br=128000')
      const d2 = (j2.data || [])[0]
      if (d2 && d2.url) {
        const dir0 = paramDir || musicDir()
        const fn0 = safeName((name || 'song') + (artist ? ' - ' + artist : '')) + '.mp3'
        const out0 = path.join(dir0, fn0)
        if (!(fs.existsSync(out0) && fs.statSync(out0).size > 10000)) {
          await runProc(findFfmpeg(), ['-y', '-v', 'error', '-i', d2.url, '-c', 'copy', out0], { timeout: 600000 })
        }
        return { file: out0, size: fs.statSync(out0).size, lowered: true }
      }
    } catch (e) {}
    throw new Error(why)
  }
  const dir = paramDir || musicDir()
  const fn = safeName((name || 'song') + (artist ? ' - ' + artist : '')) + '.mp3'
  const out = path.join(dir, fn)
  if (fs.existsSync(out) && fs.statSync(out).size > 10000) return { file: out, size: fs.statSync(out).size, reused: true }
  await runProc(findFfmpeg(), ['-y', '-v', 'error', '-i', d.url, '-c', 'copy', out], { timeout: 600000 })
  if (!fs.existsSync(out)) throw new Error('下载失败')
  return { file: out, size: fs.statSync(out).size }
}

// ── 转码兜底：HEVC → H.264（部分机器 Chromium 硬解不支持会黑屏）──
// 产物缓存到 collect/video/_h264/，同名 .mp4，避免重复转码。
// 转码互斥锁：同一目标文件并发只转一次（下载后静默队列 + 用户点播放可能同时触发）
const h264Locks = {}        // dstPath -> Promise（进行中的转码）

function h264Target(srcPath) {
  return path.join(videoDir(), '_h264', path.basename(srcPath))
}

function ensureH264(srcPath) {
  // 只转 H.264，供 CEP 的 Chromium(99) 软解播放。
  // 统一用 libx264：标准 High profile，软解流畅、画质正常，参数简单可靠。
  // 不能用 h264_nvenc（本机 ffmpeg 的 nvenc 要数字 preset，传 veryfast 直接失败）
  // 也不能用 h264_mf（Media Foundation 产 Constrained Baseline，软解卡顿花屏）
  const dst = h264Target(srcPath)
  fs.mkdirSync(path.dirname(dst), { recursive: true })

  // 已有完整产物，直接返回
  try {
    if (fs.existsSync(dst) && fs.statSync(dst).size > 10000) return Promise.resolve(dst)
  } catch (e) {}

  // 同一目标正在转：复用那个 Promise，等它完成，不重复转
  if (h264Locks[dst]) return h264Locks[dst]

  const job = (async () => {
    // 临时文件放系统临时目录（短路径），避免中文剧名 + 后缀导致超过 Windows 路径上限
    const tmp = path.join(os.tmpdir(), 'vhbgm_h264_' + Date.now() + '_' + Math.floor(Math.random() * 100000) + '.mp4')
    try {
      await runProc(findFfmpeg(), [
        '-y', '-v', 'error', '-i', srcPath,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', tmp,
      ], { timeout: 3600000 })
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size <= 10000) {
        throw new Error('转码产物为空或过小')
      }
      // 原子替换：先删旧的再改名，避免半成品被读到
      try { fs.unlinkSync(dst) } catch (e) {}
      fs.renameSync(tmp, dst)
      return dst
    } catch (e) {
      try { fs.unlinkSync(tmp) } catch (e2) {}
      throw e
    }
  })()

  h264Locks[dst] = job
  // 完成后清理锁（成功/失败都清）
  job.then(function () { delete h264Locks[dst] }, function () { delete h264Locks[dst] })
  return job
}

// ── 探测视频编码（HEVC 在 CEP 的 Chromium 里解不了，会黑屏有声音）──
async function probeVideoCodec(filePath) {
  // 用 ffmpeg 读编码。注意两点：
  //  1) 扩展 bin 里没有独立 ffprobe，不能依赖它
  //  2) `ffmpeg -i 文件` 无输出文件时返回码为 1，而 runProc 在非 0 时 reject
  //     且只保留输出末尾 250 字符，流信息在中间会被截掉。
  //     故这里直接拿 spawn 的完整输出，不经过 runProc。
  return new Promise(resolve => {
    let buf = ''
    let cp
    try {
      cp = spawn(findFfmpeg(), ['-hide_banner', '-i', filePath], { windowsHide: true })
    } catch (e) { return resolve('') }
    runningChildren.add(cp)
    const done = () => {
      clearTimeout(timer)
      runningChildren.delete(cp)
      const m = /Video:\s*([A-Za-z0-9_]+)/i.exec(buf)
      resolve(m ? m[1].toLowerCase() : '')
    }
    if (cp.stdout) cp.stdout.on('data', d => { buf += d })
    if (cp.stderr) cp.stderr.on('data', d => { buf += d })
    const timer = setTimeout(() => { try { cp.kill() } catch (e) {} }, 30000)
    cp.on('error', done)
    cp.on('close', done)
  })
}

// ── 静默转码队列：下载完即转，串行、去重、可查进度 ──
// 目标：HEVC 集在用户点开播放前就已转好，观看无感；产物落 _h264/ 复用
const tcq = { items: {}, order: [], running: false, done: 0, failed: 0 }

function tcqKey(filePath) { return path.basename(filePath) }

function tcqEnqueue(filePath, codec) {
  const k = tcqKey(filePath)
  if (!tcq.items[k]) {
    tcq.items[k] = { file: filePath, codec, state: 'pending', tries: 0, at: Date.now() }
    tcq.order.push(k)
  }
  tcqPump()
}

async function tcqPump() {
  if (tcq.running) return
  tcq.running = true
  try {
    while (true) {
      const k = tcq.order.find(x => tcq.items[x] && tcq.items[x].state === 'pending')
      if (!k) break
      const it = tcq.items[k]
      it.state = 'running'
      try {
        await ensureH264(it.file)
        it.state = 'done'; tcq.done++
      } catch (e) {
        it.tries++
        it.state = it.tries >= 2 ? 'failed' : 'pending'
        if (it.state === 'failed') tcq.failed++
        it.err = e.message
      }
    }
  } finally { tcq.running = false }
}

// 下载成功后调用：HEVC（含 bytevc1）才需要转，H.264 直接跳过
async function maybeQueueTranscode(filePath) {
  try {
    const codec = await probeVideoCodec(filePath)
    if (!codec) return ''
    // CEP 的 Chromium(99) 只保证 H.264；hevc/h265/bytedance 出的 hevc 都要转
    if (codec === 'h264' || codec === 'avc1') return codec
    tcqEnqueue(filePath, codec)
    return codec
  } catch (e) { return '' }
}

// ── 本地视频供给（支持 Range，供 <video> 拖动进度）──
// 若带 h264=1 则自动转码后再供给（部分机器 HEVC 黑屏的兜底）
// ══════════════════════════════════════════════════════════════════
// 在线播放通道
// ══════════════════════════════════════════════════════════════════
// 设计要点：采集源的 m3u8/shard/key 实测都带 Access-Control-Allow-Origin: *，
// 理论上前端可直连。但我们仍走本地代理，原因有三：
//   1) 保留 UA/Referer，部分源按 UA 拦（直连时浏览器 UA 可能被拒）
//   2) 改写 m3u8 内容里的相对路径 —— hls.js 以「响应 URL」为基准解析相对路径，
//      经代理后基准变成 127.0.0.1，根相对路径会全拼错（影视板块踩过这个坑）
//   3) 统一 30 分钟内的 manifest 缓存，减少对源站的重复请求

const STREAM_UA = DRAMA_UA
// 每个 manifest 缓存：url -> { at, body, ctype }
const streamCache = new Map()
const STREAM_CACHE_MS = 30 * 1000   // manifest 变（合并集除外）不频繁，30 秒够用

function streamCachePrune() {
  if (streamCache.size < 200) return
  const now = Date.now()
  for (const [k, v] of streamCache) { if (now - v.at > STREAM_CACHE_MS) streamCache.delete(k) }
}

// 把 m3u8 文本里的所有地址改写成经代理的绝对地址
//   - 子清单/分片：/proxy?url=<abs>
//   - EXT-X-KEY 的 URI：同样改写（AES key 必须能取到，否则 hls.js 解密失败）
//   - 已经是绝对地址的保持；相对地址按 baseUrl 解析
function rewriteM3u8(text, baseUrl) {
  const toAbs = (ref) => {
    if (!ref) return ''
    if (/^https?:\/\//i.test(ref)) return ref
    try { return new URL(ref, baseUrl).toString() } catch (e) { return ref }
  }
  const wrap = (abs) => '/stream?url=' + encodeURIComponent(abs)
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim()
    if (!t) return line
    // 标签行：只处理 EXT-X-KEY 的 URI="..."
    if (t.startsWith('#')) {
      if (t.indexOf('URI="') >= 0) {
        return line.replace(/URI="([^"]+)"/g, (m, uri) => 'URI="' + wrap(toAbs(uri)) + '"')
      }
      return line
    }
    // 地址行
    return wrap(toAbs(t))
  }).join('\n')
}

// 抓远程资源并跟随重定向（返回 {status, headers, stream}）
function fetchRemote(url, req, res, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { return reject(new Error('bad url')) }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('bad protocol'))
    const mod = u.protocol === 'https:' ? https : http
    const headers = {
      'User-Agent': STREAM_UA,
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }
    // 透传 Range，让分片支持断点与 seek
    if (req && req.headers && req.headers.range) headers['Range'] = req.headers.range
    const r = mod.get({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers: headers, timeout: timeoutMs || 20000,
    }, (up) => {
      if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
        up.resume()
        let loc = up.headers.location
        if (!/^https?:\/\//i.test(loc)) { try { loc = new URL(loc, url).toString() } catch (e) {} }
        return fetchRemote(loc, req, res, timeoutMs).then(resolve, reject)
      }
      resolve({ status: up.statusCode, headers: up.headers, stream: up })
    })
    r.on('error', reject)
    r.on('timeout', () => { try { r.destroy() } catch (e) {} reject(new Error('timeout')) })
  })
}

// /stream 处理器：m3u8 走改写，其余（.ts/key）原样 pipe
async function handleStream(req, res, url) {
  if (!url || !/^https?:\/\//i.test(url)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad url')
  }
  let target = url
  try { target = normalizePlayUrl(url) } catch (e) {}

  // 判是不是 m3u8：看路径后缀，也看查询里是否带 m3u8
  const looksM3u8 = /\.m3u8(\?|$)/i.test(target)

  const cached = streamCache.get(target)
  if (looksM3u8 && cached && Date.now() - cached.at < STREAM_CACHE_MS) {
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    return res.end(cached.body)
  }

  let up
  try {
    up = await fetchRemote(target, req, res, 20000)
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
    return res.end('upstream error: ' + String(e.message || e))
  }
  if (up.status >= 400) {
    try { up.stream.resume() } catch (e) {}
    res.writeHead(up.status, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' })
    return res.end('upstream ' + up.status)
  }

  const ct = String(up.headers['content-type'] || '')
  const isM3u8 = looksM3u8 || /mpegurl/i.test(ct)

  if (isM3u8) {
    const chunks = []
    up.stream.on('data', (d) => chunks.push(d))
    up.stream.on('error', () => {
      if (!res.headersSent) { res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); res.end('stream error') }
    })
    up.stream.on('end', () => {
      let txt = Buffer.concat(chunks).toString('utf8')
      if (txt.indexOf('\ufffd') >= 0) {
        try { txt = Buffer.concat(chunks).toString('latin1') } catch (e) {}
      }
      const rewritten = rewriteM3u8(txt, target)
      streamCachePrune()
      streamCache.set(target, { at: Date.now(), body: rewritten })
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      })
      res.end(rewritten)
    })
    return
  }

  // 非 m3u8（分片 / key）：透传状态与关键头，直接 pipe
  const out = { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' }
  if (up.headers['content-type']) out['Content-Type'] = up.headers['content-type']
  if (up.headers['content-length']) out['Content-Length'] = up.headers['content-length']
  if (up.headers['content-range']) out['Content-Range'] = up.headers['content-range']
  res.writeHead(up.status, out)
  up.stream.pipe(res)
  up.stream.on('error', () => { try { res.end() } catch (e) {} })
}

function serveVideo(req, res, filePath) {
  let st
  try { st = fs.statSync(filePath) } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end('not found')
  }
  const size = st.size
  const range = req.headers.range
  const base = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  }
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1
    if (isNaN(start) || start < 0) start = 0
    if (isNaN(end) || end >= size) end = size - 1
    if (start > end) {
      res.writeHead(416, Object.assign({}, base, { 'Content-Range': 'bytes */' + size }))
      return res.end()
    }
    res.writeHead(206, Object.assign({}, base, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    }))
    fs.createReadStream(filePath, { start, end }).pipe(res)
  } else {
    res.writeHead(200, Object.assign({}, base, { 'Content-Length': size }))
    fs.createReadStream(filePath).pipe(res)
  }
}

// ── 首页热榜：抓官网榜单页（瀑布流数据源）──
const RANK_MAP = {
  all: '/rank/hot-drama',
  real: '/rank/hot-real-drama',
  ai: '/rank/hot-ai-drama',
  comic: '/rank/hot-comic-drama',
}
// kind 支持三种：
//   all / real / ai / comic  → 热榜
//   cat:<genre>              → 题材分类（如 cat:urban）
//   cat:<base>/<genre>       → 指定基类的题材（如 cat:ai-drama/sci-fi）
const RANK_LABEL = { all: '\u70ed\u64ad\u603b\u699c', real: '\u771f\u4eba\u5267\u699c', ai: 'AI \u5267\u699c', comic: '\u6f2b\u5267\u699c' }

async function fetchRank(kind) {
  let path
  if (String(kind).indexOf('cat:') === 0) {
    const g = String(kind).slice(4)
    path = g.indexOf('/') >= 0 ? ('/category/' + g) : ('/category/real-drama/' + g)
  } else {
    path = RANK_MAP[kind] || RANK_MAP.all
  }
  const html = await fetchText('https://hongguoduanju.com' + path)
  const out = [], seen = {}

  // 统一解析：按 /detail?series_id=ID 出现的位置切块（榜单与分类页 class 不同，
  // 但都以 detail 链接 + 相邻封面/剧名/标签 呈现）
  const marks = []
  const re = /\/detail\?series_id=(\d+)/g
  let m
  while ((m = re.exec(html))) marks.push({ id: m[1], at: m.index })
  for (let mi = 0; mi < marks.length; mi++) {
    if (out.length >= 40) break
    const { id, at } = marks[mi]
    if (seen[id]) continue
    // 取本块：从当前链接到下一个链接（截断防止跨卡片误匹配）
    // 注意：热度/评分在剧名之后、下一个 detail 链接之前，所以区块要向后多取一段
    const nextAt = (mi + 1 < marks.length) ? marks[mi + 1].at : Math.min(html.length, at + 6000)
    const seg = html.slice(Math.max(0, at - 1200), Math.min(html.length, nextAt + 1200))

    // 剧名：alt 最稳（去“封面”后缀）；其次 title 属性
    let name = ''
    const am = /alt="([^"]{2,80})"/.exec(seg)
    if (am) name = am[1]
    if (!name) {
      const tm = /title="([^"]{2,80})"/.exec(seg)
      if (tm) name = tm[1]
    }
    if (!name) continue
    name = name.replace(/\u5c01\u9762$/, '').trim()
    if (!name || name === '\u7ea2\u679c\u77ed\u5267logo') continue

    // 封面
    let cover = ''
    const imgs = seg.match(/https:\/\/[^"\s]+(?:byteimg|fqnovelpic)\.com\/[^"\s]+/g) || []
    for (const u of imgs) {
      if (/\.jpeg|\.image|\.jpg|\.png|\.webp/i.test(u)) { cover = u.replace(/&amp;/g, '&'); break }
    }

    // 标签
    const tags = []
    const tRe = /class="(?:pc-tag|m-tag)-[^"]*"[^>]*>([^<]{1,12})</g
    let tm2
    while ((tm2 = tRe.exec(seg)) && tags.length < 4) {
      const t = tm2[1].trim()
      if (t && t !== '\u5168\u90e8' && tags.indexOf(t) < 0) tags.push(t)
    }

    // 榜单页的热度/评分
    const txt = seg.replace(/<[^>]+>/g, '|')
    const hotM = /([\d.]+[\u4e07\u4ebf]?)\u70ed\u5ea6/.exec(txt)
    const scoreM = /\u8bc4\u5206([\d.]+)/.exec(txt)
    const favM = /([\d.]+[\u4e07\u4ebf]?)\u6536\u85cf/.exec(txt)
    const likeM = /([\d.]+[\u4e07\u4ebf]?)\u70b9\u8d5e/.exec(txt)

    seen[id] = 1
    out.push({
      series_id: id, name, cover, tags,
      hot: hotM ? hotM[1] + '\u70ed\u5ea6' : '',
      score: scoreM ? scoreM[1] : '',
      fav: favM ? favM[1] + '\u6536\u85cf' : '',
      like: likeM ? likeM[1] + '\u70b9\u8d5e' : '',
    })
  }
  return out
}

// 从跳转 URL 的 zlink/schemeParams 里解出 video_series_id（两层 URL 编码）
function extractFromSchemeParams(text) {
  if (!text) return ''
  let cur = String(text)
  // 最多解两层 URL 编码
  for (let round = 0; round < 3; round++) {
    const m = /video_series_id[^\d]{0,12}(\d{15,20})/.exec(cur)
    if (m) return m[1]
    let next
    try { next = decodeURIComponent(cur) } catch (e) { break }
    if (next === cur) break
    cur = next
  }
  return ''
}

// 短链白名单域名（红果 App 分享用的是 novelquickapp.com）
const SHORT_LINK_HOSTS = ['novelquickapp.com', 'applink.novelquickapp.com', 'hongguoduanju.com']

// 跟随短链跳转（不消费 body，只看 Location / 最终 URL）
function followShortLink(url) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : require('http')
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 9; SM-N9860) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.152 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      timeout: 20000,
    }, res => {
      // 302/301 → 从 Location 里找；200 → 从 body 里找
      const loc = res.headers.location || ''
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume()
        const abs = loc.indexOf('http') === 0 ? loc : new URL(loc, url).href
        let sid = extractFromSchemeParams(abs)
        if (!sid) sid = parseShareSeriesId(abs)
        if (sid) return resolve({ series_id: sid, via: 'redirect', finalUrl: abs })
        // 再跟一层
        return resolve(followOneMore(abs))
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { if (body.length < 200000) body += c })
      res.on('end', () => {
        // 优先从 zlink 解
        const zl = /zlink=([^&]+)/.exec(res.headers.location || '') 
        let sid = extractFromSchemeParams(body)
        if (!sid) {
          const zm = /"zlink":"([^"]+)"/.exec(body)
          if (zm) sid = extractFromSchemeParams(zm[1])
        }
        if (!sid) {
          // 退而求其次：页面内嵌 title 对应的 series_id 拿不到，取 video_series_id 邻近的
          const vm = /"video_series_id"[^\d]{0,12}(\d{15,20})/.exec(body)
          if (vm) sid = vm[1]
        }
        resolve(sid ? { series_id: sid, via: 'body' } : null)
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function followOneMore(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url)
      const mod = u.protocol === 'https:' ? https : require('http')
      const req = mod.get({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 9) AppleWebKit/537.36 Chrome/88 Mobile Safari/537.36' },
        timeout: 20000,
      }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', c => { if (body.length < 200000) body += c })
        res.on('end', () => {
          let sid = extractFromSchemeParams(body)
          if (!sid) {
            const zm = /"zlink":"([^"]+)"/.exec(body)
            if (zm) sid = extractFromSchemeParams(zm[1])
          }
          resolve(sid ? { series_id: sid, via: 'body2' } : null)
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    } catch (e) { resolve(null) }
  })
}

// ── 解析分享链接 / 剧 ID ──
// 支持：纯数字、detail?series_id=、share?series_id=、video_series_id=、含引导文案的长文本
function parseShareSeriesId(text) {
  const s = String(text || '').trim()
  if (!s) return ''
  if (/^\d{15,20}$/.test(s)) return s
  // 短链形态（/s/xxx），调用方应先 followShortLink
  if (/novelquickapp\.com\/s\//i.test(s)) return ''
  const pats = [
    /series_id=(\d+)/i,
    /video_series_id=(\d+)/i,
    /book_id=(\d+)/i,
    /\/detail\/(\d+)/i,
    /\/player\/(\d+)/i,
    /\b(\d{15,20})\b/,
  ]
  for (const p of pats) {
    const m = p.exec(s)
    if (m) return m[1]
  }
  return ''
}

// ── 搜索建议（自动补全）：用官网搜索页返回的剧名 ──
async function suggest(keyword) {
  if (!keyword || keyword.length < 1) return []
  const list = await searchDramas(keyword)
  return list.slice(0, 10).map(x => ({ series_id: x.series_id, name: x.name }))
}

// ── HTTP 服务 ──
function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': body.length,
  })
  res.end(body)
}

function readBody(req) {
  return new Promise(resolve => {
    let s = ''
    req.on('data', d => s += d)
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch (e) { resolve({}) } })
  })
}

// 任务表（内存）：/bgm/start 异步跑，前端轮询 /bgm/status
// 任务是否已被要求停止
function cancelled(job) { return !!(job && job.cancelRequested) }
// 收尾统一处理：已取消则不再覆写状态
function finalize(job, state, msg) {
  if (job.cancelRequested) { job.state = 'cancelled'; job.msg = job.msg || '已停止'; return }
  job.state = state; job.msg = msg
}

const jobs = {}
let seq = 0

function newJob(kind) {
  const id = 'job' + (++seq) + '_' + Date.now()
  jobs[id] = { id, kind, state: 'running', percent: 0, msg: '准备中', startedAt: Date.now(), result: null }
  return jobs[id]
}

// 统一下载：官网优先（快、免签名）→ 失败用 App 链路（可下全剧）
// 返回 { file, size, height }

// 读取本地视频真实时长（秒）。用于识别「官网只给了预告片段」的情况。
// 探测媒体时长（秒）。失败返回 0。
//
// 历史坑：原来调 ffprobe，但安装包里从来只有 ffmpeg-win32-x64.exe，
// 没有 ffprobe.exe。findFfmpegProbe() 返回一个不存在的路径，
// spawnSync 直接抛 ENOENT，catch 里 resolve(0)。
// 结果就是「预告片段检测」的 realDur 永远是 0、条件永远不成立，
// 保护形同虚设。现在改成解析 ffmpeg -i 的 stderr，不再依赖 ffprobe。
const DUR_CACHE = new Map()

function probeDuration(file) {
  const key = String(file || '')
  const c = DUR_CACHE.get(key)
  if (c && Date.now() - c.at < 10 * 60 * 1000) return Promise.resolve(c.v)

  return new Promise((resolve) => {
    try {
      const ff = findFfmpeg()
      const r = spawnSync(ff, ['-hide_banner', '-i', file], {
        encoding: 'utf8', timeout: 25000, windowsHide: true,
      })
      const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(String(r.stderr || ''))
      let v = 0
      if (m) v = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])
      if (!isFinite(v) || v < 0) v = 0
      try { DUR_CACHE.set(key, { at: Date.now(), v: v }) } catch (e) {}
      resolve(v)
    } catch (e) { resolve(0) }
  })
}

function findFfmpegProbe() {
  const f = findFfmpeg()
  if (!f) return 'ffprobe'
  const dir = path.dirname(f)
  const cands = ['ffprobe.exe', 'ffprobe-win32-x64.exe', 'ffprobe']
  for (const c of cands) {
    const p = path.join(dir, c)
    if (fs.existsSync(p)) return p
  }
  return path.join(dir, 'ffprobe.exe')
}

async function downloadEpisodeAny(seriesId, vid, epNo, seriesName, onProgress) {
  const dir = videoDir()
  const fn = safeName(seriesName || seriesId) + '_' + ('0000' + epNo).slice(-4) + '.mp4'
  const local = path.join(dir, fn)
  if (fs.existsSync(local) && fs.statSync(local).size > 300 * 1024) {
    // 本地已有文件也要校验时长，避免历史上存下的 10 秒片段被当成完整集复用
    const d0 = await probeDuration(local)
    if (d0 === 0 || d0 >= 20) {
      if (onProgress) onProgress(30, `第 ${epNo} 集：用本地已有文件`)
      return { file: local, size: fs.statSync(local).size, height: 0, reused: true, duration: d0 }
    }
    if (onProgress) onProgress(4, `第 ${epNo} 集：本地文件只有 ${d0.toFixed(0)} 秒，重新下载`)
    try { fs.unlinkSync(local) } catch (e) {}
  }

  // ── 顺序：采集源 → App 链路 → 官网兜底 ──
  // 采集源最优先。第三方维护的苹果 CMS 源直接给全集 m3u8，
  // 不需要登录、签名、设备号。实测覆盖 5/5、4/5 这类水平。
  let srcErr = null
  try {
    if (onProgress) onProgress(6, `第 ${epNo} 集：搜采集源`)
    const hit = await resolveFromSource(seriesName, epNo)
    if (hit && hit.url) {
      if (onProgress) onProgress(10, `第 ${epNo} 集：${hit.source}，下载中`)
      const tmpF = local + '.part'
      try { if (fs.existsSync(tmpF)) fs.unlinkSync(tmpF) } catch (e) {}
      const size = await downloadVideo(hit.url, tmpF)
      const d = await probeDuration(tmpF)
      if (d > 0 && d < 20) {
        try { fs.unlinkSync(tmpF) } catch (e) {}
        throw new Error(`只下到 ${d.toFixed(1)} 秒，疑似预告或分片不全`)
      }
      if (d === 0 && size < 300 * 1024) {
        try { fs.unlinkSync(tmpF) } catch (e) {}
        throw new Error('文件过小，疑似残缺')
      }
      try { if (fs.existsSync(local)) fs.unlinkSync(local) } catch (e) {}
      fs.renameSync(tmpF, local)
      if (onProgress) onProgress(35, `第 ${epNo} 集：${hit.source} 下载完成（${(size / 1048576).toFixed(1)}MB）`)
      return { file: local, size, height: 0, via: 'source', source: hit.source, duration: d }
    }
  } catch (e) {
    srcErr = e
    try { const tf = local + '.part'; if (fs.existsSync(tf)) fs.unlinkSync(tf) } catch (e2) {}
    if (onProgress) onProgress(14, `第 ${epNo} 集：采集源未命中（${String(e.message || e).slice(0, 26)}）`)
  }

  // App 链路（红果 App 端接口 + 设备号）
  try {
    if (onProgress) onProgress(20, `第 ${epNo} 集：转 App 链路`)
    const r = await appDownload(seriesId, vid, epNo, seriesName, dir, (pct, msg) => {
      if (onProgress) onProgress(20 + Math.round(pct * 0.25), msg)
    })
    const d2 = await probeDuration(r.file)
    if (d2 > 0 && d2 < 20) {
      try { fs.unlinkSync(r.file) } catch (e) {}
      throw new Error(`App 链路只拿到 ${d2.toFixed(1)} 秒`)
    }
    return { file: r.file, size: r.size, height: r.height || 0, via: 'app', duration: d2 }
  } catch (e) {
    if (onProgress) onProgress(40, `第 ${epNo} 集：App 链路失败（${String(e.message || e).slice(0, 22)}）`)
  }

  // 官网兜底。这里拿到的是 10 秒试看片段，只在前面全部失败时救急。
  try {
    if (onProgress) onProgress(42, `第 ${epNo} 集：官网兜底`)
    const info = await resolveWebVideo(seriesId, vid)
    if (info && info.url) {
      const size = await downloadVideo(info.url, local)
      const h = parseInt(String(info.frame || '').split('x')[1], 10) || 0
      const realDur = await probeDuration(local)
      const expectDur = Number(info.duration || 0)
      if (realDur > 0 && ((expectDur > 30 && realDur < expectDur * 0.6) || realDur < 20)) {
        try { fs.unlinkSync(local) } catch (e) {}
        throw new Error(`官网只有 ${realDur.toFixed(0)} 秒，不是正片`)
      }
      return { file: local, size, height: h, via: 'web', duration: realDur }
    }
  } catch (e) {
    throw new Error('所有来源都失败：' + String(e.message || e).slice(0, 70) +
      (srcErr ? '（采集源：' + String(srcErr.message || srcErr).slice(0, 40) + '）' : ''))
  }

  throw new Error('该集在任何来源都拿不到地址' +
    (srcErr ? '（采集源：' + String(srcErr.message || srcErr).slice(0, 40) + '）' : ''))
}


// 仅下载（不扒歌）
async function runDownload(job, seriesId, vid, seriesName, epNo) {
  try {
    const r = await downloadEpisodeAny(seriesId, vid, epNo, seriesName, (p, m) => {
      job.percent = p; job.msg = m
    })
    job.result = { file: r.file, size: r.size, frame: (r.height ? r.height + 'p' : '') , via: r.via }
    // HEVC 静默入转码队列
    try { job.result.codec = await maybeQueueTranscode(r.file) } catch (e) {}
    job.state = 'done'; job.percent = 100
    job.msg = `已下载 ${(r.size / 1048576).toFixed(1)}MB → ${path.basename(r.file)}`
  } catch (e) {
    job.state = 'error'; job.msg = e.message
  }
}

// 单集：自动下载再扒（默认行为）
async function runEpisode(job, seriesId, vid, seriesName, epNo, start, end) {
  try {
    const r = await downloadEpisodeAny(seriesId, vid, epNo, seriesName, (p, m) => {
      // 下载阶段占 3~35%
      job.percent = Math.min(35, Math.round(3 + p * 0.32))
      job.msg = m
    })
    await ripWav(job, r.file, start, end)
    // 让结果自带集号，前端据此写缓存（不再依赖"正在播放的那集"）
    if (job.result) job.result.ep = epNo
    // 下载完若为 HEVC，静默入转码队列（用户点开播放前转好，观看无感）
    maybeQueueTranscode(r.file).then(function (c) {
      if (job.result) job.result.codec = c
    }).catch(function () {})
  } catch (e) {
    job.state = 'error'; job.msg = e.message
  }
}

// 共用：对本地文件（可区间）做分离 + 扫描
async function ripWav(job, input, start, end) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vhbgm_r_'))
  try {
    job.msg = '抽取音轨'; job.percent = 40
    const mix = await extractWav(input, path.join(work, 'mix.wav'), start, end)
    job.msg = '人声分离（取伴奏轨）'; job.percent = 55
    const sherpaDir = ensureSherpaDir(work)
    const accomp = await separate(sherpaDir, mix, path.join(work, 'vocals.wav'), path.join(work, 'accomp.wav'))
    job.msg = '扫描伴奏轨'; job.percent = 65
    const afp = loadAfp()
    const cookie = getCookie()
    const r = await scanWav(afp, accomp, cookie, {
      win: 3, step: 1.5,
      onProgress: (w, tot) => { job.percent = 65 + Math.round(w / Math.max(1, tot) * 33); job.msg = `扫描中 ${w}/${tot}` },
    })
    job.result = {
      total: r.hits.length,
      songs: r.hits.map(h => ({
        id: h.song.id, name: h.song.name,
        artist: (h.song.artists || []).map(a => a.name).join(', '),
        album: (h.song.album || {}).name || '',
        count: h.count, at: +h.firstAt.toFixed(1), to: +(h.lastAt + 3).toFixed(1),
      })),
      duration: +r.duration.toFixed(1), windows: r.windows, skipped: r.skipped,
    }
    job.state = 'done'; job.percent = 100; job.msg = `完成，识别 ${r.hits.length} 首`
  } catch (e) {
    job.state = 'error'; job.msg = e.message
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }) } catch (e) {}
  }
}

// 单集：本地已有文件直接扒
async function runSingle(job, input, start, end, mode) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vhbgm_'))
  try {
    job.msg = '抽取音轨'; job.percent = 5
    const mix = await extractWav(input, path.join(work, 'mix.wav'), start, end)

    job.msg = '人声分离（取伴奏轨）'; job.percent = 25
    const sherpaDir = ensureSherpaDir(work)
    const accomp = await separate(sherpaDir, mix, path.join(work, 'vocals.wav'), path.join(work, 'accomp.wav'))

    job.msg = '扫描伴奏轨'; job.percent = 40
    const afp = loadAfp()
    const cookie = getCookie()
    const r = await scanWav(afp, accomp, cookie, {
      win: 3, step: 1.5,
      onProgress: (w, tot) => { job.percent = 40 + Math.round(w / Math.max(1, tot) * 55); job.msg = `扫描中 ${w}/${tot}` },
    })

    let mixResult = null
    if (mode === 'both') {
      job.msg = '对照：扫描原始混音'; job.percent = 95
      mixResult = await scanWav(afp, mix, cookie, { win: 3, step: 1.5 })
    }

    job.result = {
      total: r.hits.length,
      songs: r.hits.map(h => ({
        id: h.song.id, name: h.song.name,
        artist: (h.song.artists || []).map(a => a.name).join(', '),
        album: (h.song.album || {}).name || '',
        count: h.count, at: +h.firstAt.toFixed(1), to: +(h.lastAt + 3).toFixed(1),
      })),
      duration: +r.duration.toFixed(1), windows: r.windows, skipped: r.skipped,
      mixTotal: mixResult ? mixResult.hits.length : null,
    }
    job.state = 'done'; job.percent = 100; job.msg = `完成，识别 ${r.hits.length} 首`
  } catch (e) {
    job.state = 'error'; job.msg = e.message
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }) } catch (e) {}
  }
}

function fmtSong(s) {
  return {
    id: s.id, name: s.name,
    artist: (s.artists || []).map(a => a.name).join(', '),
    album: (s.album || {}).name || '',
    count: s.count, at: +(s.firstAt).toFixed(1), to: +(s.lastAt + 3).toFixed(1),
  }
}

// 在线批量：自动逐集下载+分离+扒歌（不依赖本地已下载文件）
async function runBatchOnline(job, seriesId, seriesName, fromEp, count) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vhbgm_on_'))
  try {
    job.msg = '获取剧集列表'; job.percent = 2
    const ser = await getSeries(seriesId)
    const vids = (ser.vid_list || []).slice(Math.max(0, fromEp - 1), Math.max(0, fromEp - 1) + count)
    if (!vids.length) throw new Error('没有取到剧集')
    const name = seriesName || ser.name || seriesId

    const sherpaDir = ensureSherpaDir(work)
    const afp = loadAfp()
    const cookie = getCookie()
    const agg = {}, perEp = []

    for (let i = 0; i < vids.length; i++) {
      if (cancelled(job)) break
      const epNo = fromEp + i
      const vid = vids[i]
      const base = i / vids.length
      job.percent = Math.round(5 + base * 90)
      try {
        const base2 = i / vids.length
        const dl = await downloadEpisodeAny(seriesId, vid, epNo, name, (p, m) => {
          job.percent = Math.round(5 + base2 * 90)
          job.msg = m
        })
        const src = dl.file
        job.msg = `[${i + 1}/${vids.length}] 第 ${epNo} 集：分离+扫描`
        job.percent = Math.round(5 + (base2 + 0.5 / vids.length) * 90)
        const mix = await extractWav(src, path.join(work, `m_${i}.wav`), null, null)
        const accomp = await separate(sherpaDir, mix, path.join(work, `v_${i}.wav`), path.join(work, `a_${i}.wav`))
        const r = await scanWav(afp, accomp, cookie, { win: 3, step: 1.5 })
        for (const h of r.hits) {
          const k = h.song.id
          if (!agg[k]) agg[k] = { song: h.song, count: 0, eps: [] }
          agg[k].count += h.count
          if (agg[k].eps.indexOf(epNo) < 0) agg[k].eps.push(epNo)
        }
        perEp.push({ ep: epNo, vid, songs: r.hits.map(fmtSong) })
      } catch (e) {
        perEp.push({ ep: epNo, vid, error: e.message })
      }
    }

    const songs = Object.values(agg)
      .sort((a, b) => (b.count - a.count) || (b.eps.length - a.eps.length))
      .map(h => ({
        id: h.song.id, name: h.song.name,
        artist: (h.song.artists || []).map(a => a.name).join(', '),
        album: (h.song.album || {}).name || '',
        count: h.count, eps: h.eps.length, epList: h.eps.slice(0, 30),
      }))

    try {
      fs.mkdirSync(OUT_ROOT, { recursive: true })
      fs.writeFileSync(path.join(OUT_ROOT, 'last_batch.json'),
        JSON.stringify({ series_id: seriesId, name, at: new Date().toISOString(), songs, perEp }, null, 2), 'utf8')
    } catch (e) {}

    job.result = { total: songs.length, songs, episodes: perEp.length, perEp, seriesName: name }
    if (!cancelled(job)) job.percent = 100
    // 汇总失败原因（典型：官网仅开放前 3 集，后续集播放页 404）
    const failed = perEp.filter(e => e.error)
    let doneMsg = `完成，共识别 ${songs.length} 首`
    if (failed.length) {
      const locked = failed.filter(e => /播放页|未取到|404/.test(e.error)).length
      if (locked === failed.length && locked === perEp.length) {
        doneMsg = `未能下载任何一集：官网只开放前 3 集试看，后面的集需要 App 登录`
      } else if (locked) {
        doneMsg = `完成，识别 ${songs.length} 首（${locked} 集因未开放试看跳过）`
      } else {
        doneMsg = `完成，识别 ${songs.length} 首（${failed.length} 集失败）`
      }
    }
    finalize(job, 'done', doneMsg)
  } catch (e) {
    finalize(job, 'error', e.message)
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }) } catch (e) {}
  }
}

async function runBatch(job, dir, limit) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vhbgm_'))
  try {
    let files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|mov|wav|mp3|m4a|flv|ts)$/i.test(f)).sort()
    if (limit && limit > 0) files = files.slice(0, limit)
    if (!files.length) throw new Error('目录里没有可处理的视频/音频')

    const sherpaDir = ensureSherpaDir(work)
    const afp = loadAfp()
    const cookie = getCookie()
    const agg = {}, perEp = []

    for (let i = 0; i < files.length; i++) {
      if (cancelled(job)) break
      const f = files[i]
      job.msg = `[${i + 1}/${files.length}] ${f}`
      job.percent = Math.round(i / files.length * 100)
      try {
        const mix = await extractWav(path.join(dir, f), path.join(work, `m_${i}.wav`), null, null)
        const accomp = await separate(sherpaDir, mix, path.join(work, `v_${i}.wav`), path.join(work, `a_${i}.wav`))
        const r = await scanWav(afp, accomp, cookie, { win: 3, step: 1.5 })
        for (const h of r.hits) {
          const k = h.song.id
          if (!agg[k]) agg[k] = { song: h.song, count: 0, eps: [] }
          agg[k].count += h.count
          if (agg[k].eps.indexOf(f) < 0) agg[k].eps.push(f)
        }
        perEp.push({ file: f, songs: r.hits.map(fmtSong), duration: +r.duration.toFixed(1) })
      } catch (e) {
        perEp.push({ file: f, error: e.message })
      }
    }

    const songs = Object.values(agg)
      .sort((a, b) => (b.count - a.count) || (b.eps.length - a.eps.length))
      .map(h => ({
        id: h.song.id, name: h.song.name,
        artist: (h.song.artists || []).map(a => a.name).join(', '),
        album: (h.song.album || {}).name || '',
        count: h.count, eps: h.eps.length,
      }))

    // 落盘结果
    try {
      fs.mkdirSync(OUT_ROOT, { recursive: true })
      fs.writeFileSync(path.join(OUT_ROOT, 'last_batch.json'),
        JSON.stringify({ dir, at: new Date().toISOString(), songs, perEp }, null, 2), 'utf8')
    } catch (e) {}

    job.result = { total: songs.length, songs, episodes: perEp.length, perEp }
    if (!cancelled(job)) job.percent = 100
    finalize(job, 'done', `完成，共识别 ${songs.length} 首`)
  } catch (e) {
    finalize(job, 'error', e.message)
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }) } catch (e) {}
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const p = u.pathname
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      return res.end()
    }

    if (p === '/health') {
      const ff = findFfmpeg(), sh = findSherpa(), md = findModel()
      return send(res, 200, {
        code: 0, alive: true, version: VERSION, logged: !!getCookie(),
        ffmpeg: !!ff, sherpa: !!sh, model: !!md,
        paths: { ffmpeg: ff, sherpa: sh, model: md },
      })
    }

    if (p === '/hot') {
      const kind = u.searchParams.get('kind') || 'all'
      const list = await fetchRank(kind)
      return send(res, 200, { code: 0, data: list })
    }

    if (p === '/share-parse') {
      const raw = u.searchParams.get('text') || ''
      // 用户往往粘贴「《剧名》免费看全集 https://xxx」这种带文案的文本，先抽出 URL
      const um = /https?:\/\/[^\s\u4e00-\u9fa5"']+/.exec(raw)
      const t = um ? um[0] : raw.trim()
      let sid = parseShareSeriesId(t)
      let via = 'text'
      // 短链（/s/xxx）：先跟随跳转，从 schemeParams 里解出 video_series_id
      if (!sid && /https?:\/\//.test(t) && /\/s\//i.test(t)) {
        try {
          const r = await followShortLink(t.trim())
          if (r && r.series_id) { sid = r.series_id; via = r.via || 'shortlink' }
        } catch (e) {}
      }
      // 其它 http 链接：也可能是跳转链，跟随一层再试
      if (!sid && /https?:\/\//.test(t)) {
        try {
          const r = await followShortLink(t.trim())
          if (r && r.series_id) { sid = r.series_id; via = r.via || 'follow' }
        } catch (e) {}
      }
      if (!sid) {
        return send(res, 200, { code: -1, msg: '\u6ca1\u8bc6\u522b\u51fa\u5267\u53f7\uff08\u652f\u6301\u7ea2\u679c\u5206\u4eab\u94fe\u63a5\u3001App \u77ed\u94fe\u3001\u7eaf\u6570\u5b57\u5267 ID\uff09' })
      }
      try {
        const info = await getSeries(sid)
        info.via = via
        return send(res, 200, { code: 0, data: info })
      } catch (e) {
        return send(res, 200, { code: 0, data: { series_id: sid, name: '', vid_list: [], count: 0, via } })
      }
    }

    if (p === '/suggest') {
      const kw = u.searchParams.get('keyword') || ''
      const list = await suggest(kw)
      return send(res, 200, { code: 0, data: list })
    }

    if (p === '/search') {
      const kw = u.searchParams.get('keyword') || ''
      const list = await searchDramas(kw)
      return send(res, 200, { code: 0, data: list })
    }

    if (p === '/series') {
      const sid = u.searchParams.get('series_id') || ''
      const info = await getSeries(sid)
      return send(res, 200, { code: 0, data: info })
    }

    if (p === '/pick-dir' && req.method === 'POST') {
      // 用 PowerShell 文件夹选择器（UTF-8 临时文件绕开控制台编码）
      // 支持传入 desc（对话框标题）与 startDir（初始目录），
      // 便于「下载歌曲选目录」等场景默认停在音乐库。
      let bd = {}
      try { bd = await readBody(req) || {} } catch (e) { bd = {} }
      const desc = String(bd.desc || '选择短剧剧集所在文件夹').replace(/"/g, '')
      const startDir = String(bd.startDir || '')
      // 起始目录存在才设，避免 PowerShell 报错
      const setStart = (startDir && fs.existsSync(startDir))
        ? ('if(Test-Path -LiteralPath $env:VHBGM_START){$f.SelectedPath=$env:VHBGM_START};')
        : ''
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$f=New-Object System.Windows.Forms.FolderBrowserDialog;',
        '$f.Description=$env:VHBGM_DESC;',
        setStart,
        'if($f.ShowDialog() -eq "OK"){[System.IO.File]::WriteAllText($env:VHBGM_OUT,$f.SelectedPath,[System.Text.UTF8Encoding]::new($false))}',
      ].join(' ')
      const outFile = path.join(os.tmpdir(), 'vhbgm_dir_' + Date.now() + '.txt')
      const env2 = Object.assign({}, process.env, {
        VHBGM_OUT: outFile, VHBGM_DESC: desc, VHBGM_START: startDir,
      })
      spawnSync('powershell', ['-NoProfile', '-Command', ps],
        { env: env2, encoding: 'utf8', timeout: 120000 })
      let chosen = ''
      try { if (fs.existsSync(outFile)) { chosen = fs.readFileSync(outFile, 'utf8').trim(); fs.unlinkSync(outFile) } } catch (e) {}
      return send(res, 200, { code: 0, data: { path: chosen } })
    }

    if (p === '/pick-file' && req.method === 'POST') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$f=New-Object System.Windows.Forms.OpenFileDialog;',
        '$f.Filter="视频/音频|*.mp4;*.mkv;*.mov;*.wav;*.mp3;*.m4a|所有文件|*.*";',
        'if($f.ShowDialog() -eq "OK"){[System.IO.File]::WriteAllText($env:VHBGM_OUT,$f.FileName,[System.Text.UTF8Encoding]::new($false))}',
      ].join(' ')
      const outFile = path.join(os.tmpdir(), 'vhbgm_file_' + Date.now() + '.txt')
      spawnSync('powershell', ['-NoProfile', '-Command', ps],
        { env: Object.assign({}, process.env, { VHBGM_OUT: outFile }), encoding: 'utf8', timeout: 120000 })
      let chosen = ''
      try { if (fs.existsSync(outFile)) { chosen = fs.readFileSync(outFile, 'utf8').trim(); fs.unlinkSync(outFile) } } catch (e) {}
      return send(res, 200, { code: 0, data: { path: chosen } })
    }

    if (p === '/single' && req.method === 'POST') {
      const b = await readBody(req)
      if (!b.input) return send(res, 200, { code: -1, msg: '缺少 input（视频/音频路径）' })
      if (!fs.existsSync(b.input)) return send(res, 200, { code: -1, msg: '文件不存在: ' + b.input })
      const job = newJob('single')
      runSingle(job, b.input, b.start, b.end, b.mode || 'accomp')
      return send(res, 200, { code: 0, data: { jobId: job.id } })
    }

    if (p === '/batch' && req.method === 'POST') {
      const b = await readBody(req)
      // 新用法：给 series_id 自动逐集下载再扒
      if (b.series_id) {
        const job = newJob('batch')
        runBatchOnline(job, b.series_id, b.name || '', b.from || 1, b.count || 10)
        return send(res, 200, { code: 0, data: { jobId: job.id } })
      }
      if (!b.dir) return send(res, 200, { code: -1, msg: '缺少 dir（本地剧集目录）或 series_id（在线批量）' })
      if (!fs.existsSync(b.dir)) return send(res, 200, { code: -1, msg: '目录不存在: ' + b.dir })
      const job = newJob('batch')
      runBatch(job, b.dir, b.limit)
      return send(res, 200, { code: 0, data: { jobId: job.id } })
    }

    if (p === '/episodes') {
      const sid = u.searchParams.get('series_id') || ''
      const info = await getSeries(sid)
      return send(res, 200, { code: 0, data: info })
    }

    if (p === '/episode' && req.method === 'POST') {
      const b = await readBody(req)
      if (!b.series_id) return send(res, 200, { code: -1, msg: '缺少 series_id' })
      const job = newJob('episode')
      runEpisode(job, b.series_id, b.vid || null, b.name || '', b.ep || 1, b.start, b.end)
      return send(res, 200, { code: 0, data: { jobId: job.id } })
    }

    if (p === '/download' && req.method === 'POST') {
      const b = await readBody(req)
      if (!b.series_id) return send(res, 200, { code: -1, msg: '缺少 series_id' })
      const job = newJob('download')
      runDownload(job, b.series_id, b.vid || null, b.name || '', b.ep || 1)
      return send(res, 200, { code: 0, data: { jobId: job.id } })
    }

    if (p === '/probe') {
      const sid = u.searchParams.get('series_id') || ''
      const vid = u.searchParams.get('vid') || ''
      const info = await resolveWebVideo(sid, vid || null)
      return send(res, 200, { code: 0, data: info })
    }

    // 在线播放：给定剧名 + 集号，返回可直接喂给 hls.js 的地址（已改成走本机代理）
    // 这是「未下载也能看」的入口，不落盘、不转码。
    if (p === '/play-url') {
      const name = u.searchParams.get('name') || ''
      const epNo = parseInt(u.searchParams.get('ep') || '0', 10)
      const sid = u.searchParams.get('series_id') || ''
      if (!name && !sid) return send(res, 200, { code: -1, msg: '缺少 name 或 series_id' })
      let seriesName = name
      // 只给 series_id 时，先从官网取剧名
      if (!seriesName && sid) {
        try {
          const info = await getSeries(sid)
          seriesName = info.name || ''
        } catch (e) {}
      }
      if (!seriesName) return send(res, 200, { code: -1, msg: '拿不到剧名，无法匹配采集源' })
      // 逐集探活：按源优先级依次试，命中即用。某集在某源失效会自动换下一个源。
      let r = null
      try {
        r = await resolveEpisodePlayable(seriesName, epNo || 1)
      } catch (e) {
        return send(res, 200, { code: -1, msg: '采集源查询失败：' + String(e.message || e).slice(0, 60) })
      }
      if (!r || !r.ok) {
        return send(res, 200, {
          code: -1,
          msg: (r && r.msg) || '未找到可播片源',
          // 把每个源的失败原因带回前端，便于排查到底是"没有这部剧"还是"源挂了"
          tried: (r && r.tried) || [],
        })
      }
      return send(res, 200, {
        code: 0,
        data: {
          url: '/stream?url=' + encodeURIComponent(r.url),
          rawUrl: r.url,
          source: r.source,
          title: r.title,
          episode: r.ep,
          episodeTo: r.epTo || 0,
          isMerged: !!r.isMerged,
          count: r.count,
          kind: r.kind || 'single',
          // 前面失败过几个源，供界面提示"已自动切换 N 个源"
          switched: (r.tried || []).length,
        },
      })
    }

    if (p === '/stream') {
      const target = u.searchParams.get('url') || ''
      return handleStream(req, res, target)
    }

    // 调试：看某个剧名在各源的实际搜索结果（排查"为什么没选单集源"）
    if (p === '/debug-sources') {
      const name = u.searchParams.get('name') || ''
      if (!name) return send(res, 200, { code: -1, msg: '缺少 name' })
      const key = normTitle(name)
      dramaSearchCache.delete(key)
      const t0 = Date.now()
      const hits = await searchAllSources(name)
      const ms = Date.now() - t0
      const cached = dramaSearchCache.get(key)
      return send(res, 200, {
        code: 0,
        data: {
          ms: ms,
          partial: !!(cached && cached.partial),
          count: hits.length,
          hits: hits.map(h => ({
            source: h.source, kind: h.kind, order: h.order,
            eps: h.count, title: h.title,
          })),
        },
      })
    }

    // 清掉某一集的取流缓存 + 该剧的源偏好，逼下次重新逐源探测（前端播放失败时调）
    if (p === '/reset-episode') {
      const name = u.searchParams.get('name') || ''
      const epNo = parseInt(u.searchParams.get('ep') || '0', 10)
      if (!name) return send(res, 200, { code: -1, msg: '缺少 name' })
      const key = normTitle(name)
      if (epNo) episodeCache.delete(key + '|' + epNo)
      // 偏好源也清掉，否则会一直优先试那个已经挂掉的源
      preferredSource.delete(key)
      return send(res, 200, { code: 0, msg: '已清除该集缓存' })
    }

    if (p === '/transcode' && req.method === 'POST') {
      // 把某集转成 H.264（供黑屏时兑底），返回新文件路径
      const b = await readBody(req)
      const base = path.resolve(videoDir())
      const full = path.resolve(b.file || '')
      if (!b.file || full.indexOf(base) !== 0) return send(res, 200, { code: -1, msg: '非法路径' })
      const job = newJob('transcode')
      job.msg = '准备转码'
      ;(async () => {
        try {
          job.msg = '转码中（HEVC → H.264）'; job.percent = 10
          const out = await ensureH264(full)
          job.result = { file: out, size: fs.statSync(out).size, src: full }
          job.state = 'done'; job.percent = 100; job.msg = '转码完成'
        } catch (e) {
          job.state = 'error'; job.msg = e.message
        }
      })()
      return send(res, 200, { code: 0, data: { jobId: job.id } })
    }

    if (p === '/transcode-status') {
      // 静默转码队列状态（前端用于显示"后台优化中 N/M"）
      const items = Object.keys(tcq.items).map(function (k) {
        const it = tcq.items[k]
        return { name: k, state: it.state, codec: it.codec, err: it.err || '' }
      })
      const pending = items.filter(function (x) { return x.state === 'pending' || x.state === 'running' }).length
      return send(res, 200, { code: 0, data: {
        pending: pending, done: tcq.done, failed: tcq.failed,
        total: items.length, items: items,
      } })
    }

    if (p === '/probe-codec') {
      // 探测某文件的视频编码（前端播放前判断是否需要转码）
      const f = u.searchParams.get('file') || ''
      const base = path.resolve(videoDir())
      const full = path.resolve(f)
      if (!f || full.indexOf(base) !== 0) return send(res, 200, { code: -1, msg: '非法路径' })
      const codec = await probeVideoCodec(full)
      return send(res, 200, { code: 0, data: { codec: codec } })
    }

    if (p === '/song/download' && req.method === 'POST') {
      const b = await readBody(req)
      if (!b.id) return send(res, 200, { code: -1, msg: '缺少歌曲 id' })
      // 目标目录：优先用面板传入的 dir（用户当场选的），否则退回默认音乐目录
      let wantDir = ''
      if (b.dir) {
        try { fs.mkdirSync(b.dir, { recursive: true }); wantDir = b.dir; } catch (e) {}
      }
      const job = newJob('songdl')
      job.msg = '获取歌曲直链'
      ;(async () => {
        try {
          const r = await downloadSongFile(b.id, b.name || '', b.artist || '', getCookie(), wantDir)
          job.result = { file: r.file, size: r.size, reused: !!r.reused }
          job.state = 'done'; job.percent = 100; job.msg = '已下载 ' + (r.size / 1048576).toFixed(1) + 'MB'
        } catch (e) { job.state = 'error'; job.msg = e.message }
      })()
      return send(res, 200, { code: 0, data: { jobId: job.id, dir: wantDir || musicDir() } })
    }

    if (p === '/song/download-multi' && req.method === 'POST') {
      const b = await readBody(req)
      const list = b.songs || []
      if (!list.length) return send(res, 200, { code: -1, msg: '没有要下载的歌' })
      let wantDir2 = ''
      if (b.dir) {
        try { fs.mkdirSync(b.dir, { recursive: true }); wantDir2 = b.dir; } catch (e) {}
      }
      const job = newJob('songdl')
      ;(async () => {
        const ok = [], fail = []
        for (let i = 0; i < list.length; i++) {
          const s = list[i]
          job.msg = `[${i + 1}/${list.length}] ${s.name || s.id}`
          job.percent = Math.round(i / list.length * 100)
          try {
            const r = await downloadSongFile(s.id, s.name, s.artist, getCookie(), wantDir2)
            ok.push({ file: r.file, name: s.name })
          } catch (e) { fail.push({ name: s.name, msg: e.message }) }
        }
        job.result = { count: ok.length, files: ok, failed: fail, dir: wantDir2 || musicDir() }
        job.state = 'done'; job.percent = 100
        var reasons = {}
        fail.forEach(function (f) { reasons[f.msg] = (reasons[f.msg] || 0) + 1 })
        var reasonTxt = Object.keys(reasons).map(function (k) { return k + '×' + reasons[k] }).join('；')
        job.msg = `完成：成功 ${ok.length} 首` + (fail.length ? `，失败 ${fail.length} 首（${reasonTxt}）` : '')
      })()
      return send(res, 200, { code: 0, data: { jobId: job.id, dir: wantDir2 || musicDir() } })
    }

    if (p === '/song/move' && req.method === 'POST') {
      // 把已下载的歌曲移到另一个目录
      const b = await readBody(req)
      if (!b.file || !b.dir) return send(res, 200, { code: -1, msg: '缺少 file 或 dir' })
      try {
        if (!fs.existsSync(b.file)) return send(res, 200, { code: -1, msg: '源文件不存在' })
        fs.mkdirSync(b.dir, { recursive: true })
        const dest = path.join(b.dir, path.basename(b.file))
        if (path.resolve(dest) === path.resolve(b.file)) {
          return send(res, 200, { code: 0, data: { file: dest } })
        }
        fs.renameSync(b.file, dest)
        setMusicDir(b.dir)
        return send(res, 200, { code: 0, data: { file: dest } })
      } catch (e) {
        return send(res, 200, { code: -1, msg: '移动失败: ' + e.message })
      }
    }

    if (p === '/music-dir') {
      if (req.method === 'POST') {
        const b = await readBody(req)
        if (!b.dir) return send(res, 200, { code: -1, msg: '缺少 dir' })
        try { fs.mkdirSync(b.dir, { recursive: true }); setMusicDir(b.dir) }
        catch (e) { return send(res, 200, { code: -1, msg: '目录不可用: ' + e.message }) }
        return send(res, 200, { code: 0, data: { dir: musicDir() } })
      }
      return send(res, 200, { code: 0, data: { dir: musicDir() } })
    }

    if (p === '/song-url') {
      // 代理本地 ncm 服务拿歌曲直链（供内嵌试听）
      const id = u.searchParams.get('id') || ''
      if (!id) return send(res, 200, { code: -1, msg: '缺少 id' })
      const j = await httpGetJson('http://127.0.0.1:17890/song/url?id=' + encodeURIComponent(id) + '&br=320000')
      const d = (j.data || [])[0]
      if (!d || !d.url) return send(res, 200, { code: -1, msg: '拿不到直链（可能需会员或版权限制）' })
      return send(res, 200, { code: 0, data: { url: d.url, br: d.br } })
    }

    if (p === '/video') {
      // 供 <video> 播放本地已下载的集；只允许播放 collect/video 下的文件
      const f = u.searchParams.get('file') || ''
      const base = path.resolve(videoDir())
      const full = path.resolve(f)
      if (!f || full.indexOf(base) !== 0) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        return res.end('forbidden')
      }
      // prefer=h264：优先供给转码好的 H.264 版（CEP 的 Chromium 解不了 HEVC）
      let target = full
      try {
        if (u.searchParams.get('prefer') === 'h264') {
          const h264 = path.join(videoDir(), '_h264', path.basename(full))
          if (fs.existsSync(h264) && fs.statSync(h264).size > 10000) target = h264
        }
      } catch (e) {}
      return serveVideo(req, res, target)
    }

    if (p === '/local-videos') {
      // 列出已下载的视频（供播放器选集）
      const dir = videoDir()
      const out = []
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!/\.(mp4|mkv|mov|webm)$/i.test(f)) continue
          const full = path.join(dir, f)
          let sz = 0
          try { sz = fs.statSync(full).size } catch (e) {}
          if (sz < 10000) continue
          // 标记是否已有转码好的 H.264 版（前端据此决定播放源）
          let hasH264 = false
          try {
            const hp = path.join(dir, '_h264', f)
            hasH264 = fs.existsSync(hp) && fs.statSync(hp).size > 10000
          } catch (e) {}
          out.push({ name: f, path: full, size: sz, mtime: fs.statSync(full).mtimeMs, hasH264: hasH264 })
        }
      } catch (e) {}
      out.sort((a, b) => b.mtime - a.mtime)
      return send(res, 200, { code: 0, data: { dir, files: out } })
    }

    // ── 本地文件管理（删除 / 占用统计）──
    // 安全铁律：只允许操作 videoDir() 之内的文件。
    // 用 path.resolve 后再校验前缀，杜绝 ../ 路径穿越。
    function insideVideoDir(target) {
      try {
        const root = path.resolve(videoDir())
        const full = path.resolve(target)
        return full === root || full.startsWith(root + path.sep)
      } catch (e) { return false }
    }

    if (p === '/local-delete' && req.method === 'POST') {
      const b = await readBody(req)
      const files = Array.isArray(b.files) ? b.files : (b.file ? [b.file] : [])
      if (!files.length) return send(res, 200, { code: -1, msg: '没有指定要删除的文件' })
      const dir = videoDir()
      const h264Dir = path.join(dir, '_h264')
      const ok = [], fail = []
      for (const f of files) {
        try {
          if (!insideVideoDir(f)) { fail.push({ file: f, msg: '路径不在下载目录内，拒绝删除' }); continue }
          if (!fs.existsSync(f)) { fail.push({ file: f, msg: '文件不存在' }); continue }
          fs.unlinkSync(f)
          // 顺带删掉对应的转码缓存（同名的 _h264 版本）
          try {
            const h = path.join(h264Dir, path.basename(f))
            if (fs.existsSync(h)) fs.unlinkSync(h)
          } catch (e) {}
          ok.push(f)
        } catch (e) { fail.push({ file: f, msg: e.message }) }
      }
      return send(res, 200, { code: 0, data: { ok, fail, count: ok.length } })
    }

    if (p === '/local-usage') {
      // 统计下载占用（供「已下载」页展示）
      const dir = videoDir()
      let total = 0, count = 0
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!/\.(mp4|mkv|mov|webm)$/i.test(f)) continue
          try { total += fs.statSync(path.join(dir, f)).size; count++ } catch (e) {}
        }
      } catch (e) {}
      return send(res, 200, { code: 0, data: { dir, total, count } })
    }

    if (p === '/status') {
      const id = u.searchParams.get('jobId') || ''
      const j = jobs[id]
      if (!j) return send(res, 200, { code: -1, msg: '任务不存在' })
      return send(res, 200, {
        code: 0, data: {
          id: j.id, kind: j.kind, state: j.state, percent: j.percent, msg: j.msg,
          elapsed: Math.round((Date.now() - j.startedAt) / 1000), result: j.result,
        },
      })
    }

    if (p === '/cancel' && req.method === 'POST') {
      const b = await readBody(req)
      const j = jobs[b.jobId]
      if (j && j.state === 'running') {
        j.cancelRequested = true
        j.state = 'cancelled'
        j.msg = '已停止'
        killAllChildren()   // 关键：杀掉正在跑的 ffmpeg / 分离器
      }
      return send(res, 200, { code: 0 })
    }

    // 入库到网易云歌单
    if (p === '/playlist/add' && req.method === 'POST') {
      const b = await readBody(req)
      if (!b.pid || !b.ids) return send(res, 200, { code: -1, msg: '缺少 pid 或 ids' })
      const cookie = getCookie()
      if (!cookie) return send(res, 200, { code: -1, msg: '未登录网易云，请先在音乐板块登录' })
      const data = 'pid=' + encodeURIComponent(b.pid) + '&trackIds=' + encodeURIComponent('[' + b.ids + ']') + '&op=add'
      const r = await new Promise(resolve => {
        const rq = https.request({
          method: 'POST', hostname: 'music.163.com', path: '/api/playlist/manipulate/tracks',
          headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
          timeout: 20000,
        }, rs => { let s = ''; rs.on('data', d => s += d); rs.on('end', () => resolve(s)) })
        rq.on('error', e => resolve(''))
        rq.write(data); rq.end()
      })
      let j = {}
      try { j = JSON.parse(r) } catch (e) {}
      return send(res, 200, { code: j.code === 200 ? 0 : -1, data: j, msg: j.message || (j.code === 200 ? '已加入歌单' : '加入失败') })
    }

    // 我的歌单列表（供入库时选择）
    if (p === '/my-playlists') {
      const cookie = getCookie()
      if (!cookie) return send(res, 200, { code: -1, msg: '未登录网易云' })
      const uidMatch = /MUSIC_U=([^;]+)/.exec(cookie)
      void uidMatch
      const get = (hostname, pathq) => new Promise(resolve => {
        const rq = https.get({ hostname, path: pathq, headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 },
          rs => { let s = ''; rs.on('data', d => s += d); rs.on('end', () => { try { resolve(JSON.parse(s)) } catch (e) { resolve({}) } }) })
        rq.on('error', () => resolve({}))
      })
      // 先取账号 uid
      const acc = await get('music.163.com', '/api/nuser/account/get?' + Date.now())
      const uid = acc && acc.account && acc.account.id
      if (!uid) return send(res, 200, { code: -1, msg: '无法获取账号信息，请重新登录' })
      const pl = await get('music.163.com', `/api/user/playlist?uid=${uid}&limit=50&offset=0&` + Date.now())
      const list = (pl.playlist || []).map(x => ({ id: x.id, name: x.name, count: x.trackCount, mine: !!x.userId && x.userId === uid }))
      return send(res, 200, { code: 0, data: { uid, playlists: list } })
    }

    return send(res, 404, { code: -1, msg: 'not found: ' + p })
  } catch (e) {
    try { send(res, 200, { code: -1, msg: e.message }) } catch (e2) {}
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[bgm-server] listening on http://127.0.0.1:' + PORT + '  v' + VERSION)
  console.log('[bgm-server] extRoot=' + EXT_ROOT)
  console.log('[bgm-server] ffmpeg=' + findFfmpeg())
  console.log('[bgm-server] sherpa=' + findSherpa())
})
