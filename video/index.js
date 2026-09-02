// vh-Atelier 视频下载本地服务（零依赖，纯 Node 标准库）
// 只暴露插件需要的接口：健康检查 / 解析视频信息 / 下载 / 进度查询 / cookie 管理
// 底层调用 bin/yt-dlp.exe，ffmpeg 用 bin/ffmpeg-win32-x64.exe 合流
// cookie：用户粘贴浏览器 Cookie，存本地 .video_cookie，喂给 yt-dlp 提升抖音/B站成功率
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const url = require('url')
const childProcess = require('child_process')

const PORT = 17892
const HOST = '127.0.0.1'

const YTDLP = path.join(__dirname, '..', 'bin', 'yt-dlp.exe')
const FFMPEG = path.join(__dirname, '..', 'bin', 'ffmpeg-win32-x64.exe')
const COOKIE_FILE = path.join(__dirname, '.video_cookie')
const OUT_DIR = path.join(__dirname, '..', 'collect', 'video')

let cookie = ''
try { cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim() } catch (e) { cookie = '' }

function saveCookie(c) {
  cookie = c
  try {
    if (c) fs.writeFileSync(COOKIE_FILE, c, 'utf8')
    else if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE)
  } catch (e) {}
}

// 任务表：id -> { url, status, title, outPath, err, progress, log }
let tasks = {}
let taskSeq = 0

function ok(data) { return { code: 0, data } }
function fail(msg) { return { code: -1, msg } }

function json(res, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(body)
}

function safeName(s) {
  return (s || 'video').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80)
}

// ---------- 构建 yt-dlp 通用参数 ----------
function baseArgs() {
  const args = ['--no-playlist', '--no-warnings', '--newline']
  if (fs.existsSync(FFMPEG)) args.push('--ffmpeg-location', FFMPEG)
  if (cookie) args.push('--add-header', 'Cookie: ' + cookie)
  return args
}

// ---------- 路由 ----------
const server = http.createServer(function (req, res) {
  const u = url.parse(req.url, true)
  const p = u.pathname
  const q = u.query

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
    return res.end()
  }

  try {
    if (p === '/health') {
      if (!fs.existsSync(YTDLP)) return json(res, fail('yt-dlp.exe 缺失'))
      let ver = ''
      try { ver = childProcess.execFileSync(YTDLP, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim() } catch (e) { ver = '' }
      return json(res, ok({ alive: true, version: ver, hasCookie: !!cookie, hasFfmpeg: fs.existsSync(FFMPEG) }))
    }

    if (p === '/parse') {
      const link = (q.url || '').trim()
      if (!link) return json(res, fail('缺少 url'))
      parseVideo(link, function (err, info) {
        if (err) return json(res, fail(err.message || String(err)))
        json(res, ok(info))
      })
      return
    }

    if (p === '/download') {
      const link = (q.url || '').trim()
      if (!link) return json(res, fail('缺少 url'))
      const quality = q.quality || 'best'
      startDownload(link, quality, function (err, id) {
        if (err) return json(res, fail(err.message || String(err)))
        json(res, ok({ id }))
      })
      return
    }

    if (p === '/task') {
      const id = q.id || ''
      const t = tasks[id]
      if (!t) return json(res, fail('任务不存在'))
      return json(res, ok({ id: id, status: t.status, title: t.title, outPath: t.outPath, err: t.err, progress: t.progress, log: t.log }))
    }

    if (p === '/cookie') {
      if (req.method === 'POST') {
        let body = ''
        req.on('data', function (c) { body += c })
        req.on('end', function () {
          try {
            const o = JSON.parse(body || '{}')
            const c = (o.cookie || '').trim()
            saveCookie(c)
            json(res, ok({ hasCookie: !!cookie, len: cookie.length }))
          } catch (e) { json(res, fail('解析失败')) }
        })
        return
      }
      // GET：返回是否已配置（不返回明文，保护隐私）
      return json(res, ok({ hasCookie: !!cookie, len: cookie.length }))
    }

    if (p === '/update') {
      try {
        const out = childProcess.execFileSync(YTDLP, ['-U'], { encoding: 'utf8', timeout: 120000 })
        return json(res, ok({ out: out.trim() }))
      } catch (e) {
        return json(res, fail((e.stdout || e.message || String(e)).toString()))
      }
    }

    json(res, fail('未知端点 ' + p))
  } catch (e) {
    json(res, fail(e.message || String(e)))
  }
})

// ---------- 解析视频信息 ----------
function parseVideo(link, cb) {
  const args = baseArgs().concat(['-J', link])
  childProcess.execFile(YTDLP, args, { timeout: 60000, maxBuffer: 1024 * 1024 * 20, windowsHide: true }, function (err, stdout) {
    if (err) return cb(err)
    try {
      const j = JSON.parse(stdout)
      // 提取可选格式（去重，按分辨率/扩展名）
      const formats = []
      const seen = {}
      ;(j.formats || []).forEach(function (f) {
        const key = (f.height || f.format_note || 'audio') + '|' + (f.ext || '')
        if (seen[key]) return
        seen[key] = 1
        formats.push({
          formatId: f.format_id,
          note: f.format_note || '',
          ext: f.ext || '',
          height: f.height || 0,
          width: f.width || 0,
          vcodec: f.vcodec || '',
          acodec: f.acodec || '',
          filesize: f.filesize || 0
        })
      })
      cb(null, {
        id: j.id || '',
        title: j.title || '',
        uploader: j.uploader || j.channel || '',
        duration: j.duration || 0,
        thumbnail: j.thumbnail || '',
        webpageUrl: j.webpage_url || link,
        formats: formats
      })
    } catch (e) {
      cb(new Error('解析结果无效: ' + e.message))
    }
  })
}

// ---------- 下载 ----------
function startDownload(link, quality, cb) {
  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  } catch (e) { return cb(e) }

  const id = 'v' + (++taskSeq) + '_' + Date.now()
  const outTmpl = path.join(OUT_DIR, '%(title).80s [%(id)s].%(ext)s')

  const args = baseArgs().concat(['-o', outTmpl, '--merge-output-format', 'mp4'])

  // 画质：best=最高（默认）、worst=最低、audio=仅音频、其它值视为具体 formatId（选该视频流 + 最佳音频）
  if (quality === 'audio') {
    args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3')
  } else if (quality === 'worst') {
    args.push('-f', 'worst')
  } else if (quality && quality !== 'best') {
    // 具体 formatId：该视频流 + 最佳音频，回退到最佳单文件
    args.push('-f', quality + '+ba/b')
  } else {
    // 最高画质：视频+音频合流，回退单文件
    args.push('-f', 'bv*+ba/b')
  }

  const task = { url: link, status: 'downloading', title: '', outPath: '', err: '', progress: 0, log: [] }
  tasks[id] = task

  let child
  try {
    child = childProcess.spawn(YTDLP, args.concat([link]), { windowsHide: true })
  } catch (e) {
    task.status = 'error'; task.err = e.message
    return cb(null, id)
  }

  let stderrBuf = ''
  child.stdout.on('data', function (c) {
    const s = c.toString()
    parseProgress(s, task)
  })
  child.stderr.on('data', function (c) { stderrBuf += c.toString() })
  child.on('error', function (e) {
    task.status = 'error'; task.err = e.message
  })
  child.on('close', function (code) {
    if (task.status === 'error') return
    if (code === 0) {
      // 找刚生成的输出文件
      task.outPath = findOutput(OUT_DIR, task.log)
      task.status = task.outPath ? 'done' : 'error'
      if (!task.outPath) task.err = '下载完成但未找到输出文件'
    } else {
      task.status = 'error'
      task.err = (stderrBuf || '下载失败').split('\n').filter(function (l) { return l.trim() }).slice(-3).join(' | ')
    }
  })

  return cb(null, id)
}

// 从 yt-dlp stdout 解析进度（默认 [download] xx.x% 与 [Merger] 阶段）
function parseProgress(s, task) {
  const lines = s.split('\n')
  lines.forEach(function (l) {
    if (!l.trim()) return
    // [download]  45.3% of 12.34MiB
    let m = l.match(/\[download\]\s+([\d.]+)%/)
    if (m) { task.progress = parseFloat(m[1]); return }
    // [Merger] 阶段视为 99%
    if (l.indexOf('[Merger]') >= 0 || l.indexOf('[ExtractAudio]') >= 0) task.progress = 99
    if (l.indexOf('[download] Destination') >= 0) {
      const mm = l.match(/\[download\] Destination: (.+)/)
      if (mm) task.log.push(mm[1].trim())
    }
    if (l.indexOf('has already been downloaded') >= 0) {
      const mm = l.match(/\[download\] (.+?) has already been downloaded/)
      if (mm) task.log.push(mm[1].trim())
    }
    // 记录标题
    if (l.indexOf('[youtube]') >= 0 || l.indexOf('[BiliBili]') >= 0 || l.indexOf('[Douyin]') >= 0) {
      // extractor 标记，忽略
    }
  })
}

function findOutput(dir, log) {
  // 优先用 yt-dlp 打印的 Destination 路径
  if (log && log.length) {
    for (let i = log.length - 1; i >= 0; i--) {
      const p = log[i]
      if (fs.existsSync(p)) return p
    }
  }
  // 兜底：目录里最新的媒体文件
  try {
    const files = fs.readdirSync(dir)
      .map(function (f) { return path.join(dir, f) })
      .filter(function (f) { return /\.(mp4|mkv|webm|flv|ts|mp3|m4a)$/i.test(f) })
      .sort(function (a, b) { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs })
    return files[0] || ''
  } catch (e) { return '' }
}

server.listen(PORT, HOST, function () {
  console.log('[video-server] listening on http://' + HOST + ':' + PORT)
})
