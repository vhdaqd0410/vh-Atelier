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
const PORT = 17891
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

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': WEB_UA }, timeout: 25000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve, reject)
      }
      let s = ''
      res.setEncoding('utf8')
      res.on('data', d => s += d)
      res.on('end', () => resolve(s))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('超时')) })
  })
}

async function searchDramas(keyword) {
  const url = 'https://hongguoduanju.com/search/' + encodeURIComponent(keyword) + '/'
  const html = await fetchText(url)
  const out = [], seen = {}

  // 搜索页卡片：<article>…，含封面图 / 标题 / 标签 / 演员 / 简介 / 集数
  const cards = html.split(/<article[^>]*>/i).slice(1)
  for (const c of cards) {
    if (out.length >= 40) break
    const idm = /series_id=(\d+)/.exec(c)
    if (!idm) continue
    const id = idm[1]
    if (seen[id]) continue

    // 剧名：alt 最可靠（title 属性不存在）
    let name = ''
    const am = /alt="([^"]{2,80})"/.exec(c)
    if (am) name = am[1]
    else {
      const tm = /class="pc-title-[^"]*"[^>]*>([\s\S]{0,300}?)<\/a>/.exec(c)
      if (tm) name = tm[1].replace(/<[^>]+>/g, '').trim()
    }

    // 封面：只取 image 版本（webp 在部分旧内核不支持）
    let cover = ''
    const imgAll = c.match(/https:\/\/[^"\s]+(?:byteimg|fqnovelpic)\.com\/[^"\s]+/g) || []
    for (const u of imgAll) {
      if (/\.jpeg|\.image|\.jpg|\.png/i.test(u) || /\.webp/i.test(u)) {
        cover = u.replace(/&amp;/g, '&')
        if (!/\.webp/i.test(u)) break
      }
    }

    // 标签
    const tags = []
    const tRe = /class="pc-tag-[^"]*"[^>]*>([^<]{1,12})</g
    let tm2
    while ((tm2 = tRe.exec(c))) tags.push(tm2[1].trim())

    // 演员
    let actors = ''
    const acm = /class="pc-actors-[^"]*"[^>]*>([\s\S]{0,200}?)<\/p>/.exec(c)
    if (acm) actors = acm[1].replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, '').replace(/^演员：/, '').trim()

    // 简介（取第一个，不带 tooltip 的那个）
    let intro = ''
    const inm = /class="pc-intro-[^"]*"[^>]*>([\s\S]{0,1200}?)<\/p>/.exec(c)
    if (inm) intro = inm[1].replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, '').replace(/^简介：/, '').trim()

    // 集数：从分集按钮/链接数量或文本推
    const epCells = (c.match(/pc-episode-cell/g) || []).length
    const epText = /全(\d+)集/.exec(c)
    const count = epText ? parseInt(epText[1], 10) : (epCells || 0)

    seen[id] = 1
    out.push({ series_id: id, name, cover, tags, actors, intro, count })
  }

  // 兜底：至少能列出 series_id
  if (!out.length) {
    const ids = [...new Set((html.match(/\/detail\?series_id=(\d+)/g) || [])
      .map(x => x.match(/(\d+)/)[1]))]
    ids.slice(0, 40).forEach(id => out.push({ series_id: id, name: '', cover: '', tags: [], actors: '', intro: '', count: 0 }))
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

// ── 从官网播放页 SSR 数据取 mp4 直链（免签名 / 免 cookie / 免设备号）──
// 官网播放页 HTML 里直接内置 video_player_info.main_url，是明文 mp4（无 DRM）
async function resolveWebVideo(seriesId, vid) {
  const url = `https://hongguoduanju.com/player/${seriesId}/` + (vid ? `${vid}/` : '')
  const html = await fetchText(url)
  const pick = (key) => {
    const m = new RegExp('"' + key + '"\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([\\d.]+))').exec(html)
    return m ? (m[1] !== undefined ? m[1] : m[2]) : ''
  }
  let main = pick('main_url')
  main = main.replace(/\\u002F/g, '/')
  if (!main) throw new Error('该集未开放试看（官网只开放前 3 集，后续集需 App 登录）')
  const nm = /"series_name"\s*:\s*"([^"]*)"/.exec(html)
  const v = /"vid"\s*:\s*"(\d+)"/.exec(html)
  let dur = pick('duration') || ''
  // ISO8601 时长（PT2M14S）转秒
  let durSec = 0
  const dm = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(dur)
  if (dm) durSec = (+dm[1] || 0) * 3600 + (+dm[2] || 0) * 60 + (parseFloat(dm[3]) || 0)
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

// ── 本地视频供给（支持 Range，供 <video> 拖动进度）──
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
async function downloadEpisodeAny(seriesId, vid, epNo, seriesName, onProgress) {
  const dir = videoDir()
  const fn = safeName(seriesName || seriesId) + '_' + ('0000' + epNo).slice(-4) + '.mp4'
  const local = path.join(dir, fn)
  if (fs.existsSync(local) && fs.statSync(local).size > 10000) {
    if (onProgress) onProgress(30, `第 ${epNo} 集：用本地已有文件`)
    return { file: local, size: fs.statSync(local).size, height: 0, reused: true }
  }

  // 1) 官网免签名明文 mp4
  try {
    if (onProgress) onProgress(6, `第 ${epNo} 集：官网取地址`)
    const info = await resolveWebVideo(seriesId, vid)
    if (info && info.url) {
      if (onProgress) onProgress(12, `第 ${epNo} 集：官网下载（${info.frame || '?'}）`)
      const size = await downloadVideo(info.url, local)
      const h = parseInt(String(info.frame || '').split('x')[1], 10) || 0
      return { file: local, size, height: h, via: 'web' }
    }
  } catch (e) {
    // 官网未开放该集，转 App 链路
  }

  // 2) App 链路（签名 + 设备号，可下官网限制外的集）
  if (onProgress) onProgress(20, `第 ${epNo} 集：转 App 链路（可下全剧）`)
  const r = await appDownload(seriesId, vid, epNo, seriesName, dir, (pct, msg) => {
    if (onProgress) onProgress(20 + Math.round(pct * 0.25), msg)
  })
  return { file: r.file, size: r.size, height: r.height || 0, via: 'app' }
}

// 仅下载（不扒歌）
async function runDownload(job, seriesId, vid, seriesName, epNo) {
  try {
    const r = await downloadEpisodeAny(seriesId, vid, epNo, seriesName, (p, m) => {
      job.percent = p; job.msg = m
    })
    job.result = { file: r.file, size: r.size, frame: (r.height ? r.height + 'p' : '') , via: r.via }
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
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$f=New-Object System.Windows.Forms.FolderBrowserDialog;',
        '$f.Description="选择短剧剧集所在文件夹";',
        'if($f.ShowDialog() -eq "OK"){[System.IO.File]::WriteAllText($env:VHBGM_OUT,$f.SelectedPath,[System.Text.UTF8Encoding]::new($false))}',
      ].join(' ')
      const outFile = path.join(os.tmpdir(), 'vhbgm_dir_' + Date.now() + '.txt')
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps],
        { env: Object.assign({}, process.env, { VHBGM_OUT: outFile }), encoding: 'utf8', timeout: 120000 })
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

    if (p === '/video') {
      // 供 <video> 播放本地已下载的集；只允许播放 collect/video 下的文件
      const f = u.searchParams.get('file') || ''
      const base = path.resolve(videoDir())
      const full = path.resolve(f)
      if (!f || full.indexOf(base) !== 0) {
        res.writeHead(403, { 'Content-Type': 'text/plain' })
        return res.end('forbidden')
      }
      return serveVideo(req, res, full)
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
          out.push({ name: f, path: full, size: sz, mtime: fs.statSync(full).mtimeMs })
        }
      } catch (e) {}
      out.sort((a, b) => b.mtime - a.mtime)
      return send(res, 200, { code: 0, data: { dir, files: out } })
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
