// vh-Atelier 视频下载本地服务（零依赖，纯 Node 标准库）
// 只暴露插件需要的接口：健康检查 / 解析视频信息 / 下载 / 进度查询 / cookie 管理
// 底层调用 bin/yt-dlp.exe，ffmpeg 用 bin/ffmpeg-win32-x64.exe 合流
// cookie：用户粘贴浏览器 Cookie，存本地 .video_cookie，喂给 yt-dlp 提升抖音/B站成功率
//
// v2.0 引擎扩展（2026-09-05）：
//   引擎 = yt-dlp（默认主引擎，多清晰度 + cookie 高清）| greenvideo（免登录兜底引擎）
//   解析失败自动降级：yt-dlp 报错/超时/需 cookie 时，尝试 greenvideo 免登录解析
//   /parse?engine=gv 与 /download?engine=gv 可强制指定引擎
//   greenvideo 模块见同目录 gv.js（复刻 greenvideo.cc AES+RSA 加密接口，零依赖）
const http = require('http')
const fs = require('fs')
const path = require('path')
const url = require('url')
const childProcess = require('child_process')

const gv = require('./gv.js')

const PORT = 17892
const HOST = '127.0.0.1'

const YTDLP = path.join(__dirname, '..', 'bin', 'yt-dlp.exe')
const FFMPEG = path.join(__dirname, '..', 'bin', 'ffmpeg-win32-x64.exe')
const COOKIE_FILE = path.join(__dirname, '.video_cookie')
const COOKIE_TXT = path.join(__dirname, '.video_cookies.txt')
const OUT_DIR = path.join(__dirname, '..', 'collect', 'video')

// cookie 形态：'netscape' = Cookie-Editor 导出的 Netscape 多行文本（存 .video_cookies.txt，用 --cookies 喂）
//            'header'   = 单串浏览器 Cookie 头（存 .video_cookie，用 --add-header 喂）
let cookieMode = 'none'
let cookie = ''
try { cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim() } catch (e) { cookie = '' }
if (cookie && /^(# Netscape HTTP Cookie File|\.douyin\.com|\tbilibili\.com)/m.test(cookie)) {
  cookieMode = 'netscape'
} else if (cookie) {
  cookieMode = 'header'
}

// 判断一段文本是不是 Netscape 格式（以 # Netscape 开头，或有 tab 分隔的 7 列记录）
function isNetscape(text) {
  const t = (text || '').trim()
  if (!t) return false
  if (t.indexOf('# Netscape HTTP Cookie File') >= 0) return true
  // 单行 7 列 tab 分隔：domain \t flag \t path \t secure \t expiry \t name \t value
  const lines = t.split('\n').filter(function (l) { return l.trim() && l.trim().charAt(0) !== '#' })
  if (!lines.length) return false
  var tabCount = 0
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split('\t')
    if (parts.length >= 7) tabCount++
  }
  return tabCount > 0 && tabCount === lines.length
}

function saveCookie(c) {
  c = (c || '').trim()
  cookie = c
  try {
    // 清空两个旧文件
    if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE)
    if (fs.existsSync(COOKIE_TXT)) fs.unlinkSync(COOKIE_TXT)
    if (!c) { cookieMode = 'none'; return }
    if (isNetscape(c)) {
      cookieMode = 'netscape'
      fs.writeFileSync(COOKIE_TXT, c + '\n', 'utf8')
    } else {
      cookieMode = 'header'
      fs.writeFileSync(COOKIE_FILE, c, 'utf8')
    }
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
  const args = ['--no-playlist', '--no-warnings', '--newline', '--encoding', 'utf-8']
  if (fs.existsSync(FFMPEG)) args.push('--ffmpeg-location', FFMPEG)
  if (cookieMode === 'netscape' && fs.existsSync(COOKIE_TXT)) {
    args.push('--cookies', COOKIE_TXT)
  } else if (cookieMode === 'header' && cookie) {
    args.push('--add-header', 'Cookie: ' + cookie)
  }
  return args
}

// auto 模式下 yt-dlp 只要失败就值得尝试 greenvideo 兜底：
// 无论是 cookie 缺失/登录态失效/平台风控/提取器失效/网络超时，还是 spawn/权限类环境错误，
// 兜底引擎都是零成本的额外尝试（多一次免登录解析请求而已）。
// 例外：gv 模块本身不可用时不降级。
function shouldFallbackToGv(errText) {
  const s = String(errText || '').toLowerCase()
  // 明确属于"链接不是视频平台/用户输入错误"时才不降级（避免用 gv 掩盖脏输入）
  if (/not a valid url|unsupported url|no video formats found/i.test(s)) return false
  return true
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
      let gvOk = false
      try { gvOk = typeof gv.gvExtract === 'function' } catch (e) { gvOk = false }
      if (!fs.existsSync(YTDLP)) return json(res, fail('yt-dlp.exe 缺失'))
      let ver = ''
      try { ver = childProcess.execFileSync(YTDLP, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim() } catch (e) { ver = '' }
      return json(res, ok({ alive: true, version: ver, hasCookie: cookieMode !== 'none', cookieMode: cookieMode, hasFfmpeg: fs.existsSync(FFMPEG), engines: ['yt-dlp', 'greenvideo'], gvReady: gvOk }))
    }

    if (p === '/parse') {
      const link = (q.url || '').trim()
      if (!link) return json(res, fail('缺少 url'))
      const engine = (q.engine || 'auto').toLowerCase()
      parseSmart(link, engine, function (err, info) {
        if (err) return json(res, fail(err.message || String(err)))
        json(res, ok(info))
      })
      return
    }

    if (p === '/download') {
      const link = (q.url || '').trim()
      if (!link) return json(res, fail('缺少 url'))
      const quality = q.quality || 'best'
      const engine = (q.engine || 'auto').toLowerCase()
      startDownload(link, quality, engine, function (err, id) {
        if (err) return json(res, fail(err.message || String(err)))
        json(res, ok({ id }))
      })
      return
    }

    if (p === '/task') {
      const id = q.id || ''
      const t = tasks[id]
      if (!t) return json(res, fail('任务不存在'))
      return json(res, ok({ id: id, status: t.status, title: t.title, outPath: t.outPath, err: t.err, progress: t.progress, log: t.log, engine: t.engine }))
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
            json(res, ok({ hasCookie: cookieMode !== 'none', mode: cookieMode, len: cookie.length }))
          } catch (e) { json(res, fail('解析失败')) }
        })
        return
      }
      // GET：返回是否已配置（不返回明文，保护隐私）
      return json(res, ok({ hasCookie: cookieMode !== 'none', mode: cookieMode, len: cookie.length }))
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

// ---------- 解析（智能引擎选择） ----------
// engine: 'auto'（默认，yt-dlp 优先，失败降级 gv）/ 'yt-dlp'（强制主引擎）/ 'gv'（强制兜底）
function parseSmart(link, engine, cb) {
  const runGv = function (reason) {
    gv.gvExtract(link).then(function (info) {
      info._fallbackReason = reason || ''
      cb(null, info)
    }).catch(function (e) {
      cb(new Error('greenvideo 兜底也失败: ' + (e.message || e)))
    })
  }

  if (engine === 'gv') return runGv('')

  const args = baseArgs().concat(['-J', link])
  // execFile 在部分 Windows 环境（如沙箱/权限受限）spawn 会同步抛 EPERM，
  // 必须 try-catch，否则同步异常会绕过回调直接冒泡到路由层，降级逻辑失效。
  let handle
  try {
    handle = childProcess.execFile(YTDLP, args, { timeout: 60000, maxBuffer: 1024 * 1024 * 20, windowsHide: true }, function (err, stdout) {
      if (err) {
        if (engine === 'auto' && shouldFallbackToGv(err.message)) return runGv('yt-dlp: ' + (err.message || '').split('\n')[0])
        return cb(err)
      }
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
          engine: 'yt-dlp',
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
  } catch (e) {
    // 同步抛异常（如 spawn EPERM）：auto 模式下同样降级
    if (engine === 'auto' && shouldFallbackToGv(e.message)) return runGv('yt-dlp: ' + (e.message || '').split('\n')[0])
    return cb(e)
  }
}

// ---------- 下载 ----------
function startDownload(link, quality, engine, cb) {
  try {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true })
  } catch (e) { return cb(e) }

  const id = 'v' + (++taskSeq) + '_' + Date.now()
  const outTmpl = path.join(OUT_DIR, '%(title).80s [%(id)s].%(ext)s')

  // greenvideo 兜底：不走 yt-dlp 任务，直接下载直链。仍挂到 tasks 表，前端轮询逻辑不变。
  if (engine === 'gv') {
    return startGvDownload(id, link, quality, cb)
  }

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

  const task = { url: link, status: 'downloading', title: '', outPath: '', err: '', progress: 0, log: [], engine: 'yt-dlp' }
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

// greenvideo 兜底下载：先解析拿直链，再按平台策略直接下。
// 关键：抖音直链（v*.douyin.com / ixigua）自带音轨免头直接下；
//       B站（bilivideo）需带 Referer: https://www.bilibili.com。
// 下载期间同步更新任务进度。
function startGvDownload(id, link, quality, cb) {
  const task = { url: link, status: 'downloading', title: '', outPath: '', err: '', progress: 0, log: [], engine: 'greenvideo' }
  tasks[id] = task

  gv.gvExtract(link).then(function (info) {
    const g = info._gv || {}
    const vid = g.video || {}
    const base = vid.baseUrl
    if (!base) { task.status = 'error'; task.err = 'greenvideo 未返回可下载直链'; return cb(null, id) }

    const title = safeName(info.title || ('video-' + (g.vid || Date.now())))
    // 目录：host-vid-标题（与 yt-dlp 风格一致，防重名）
    const host = (g.host || 'unknown').replace(/[\\/:*?"<>|]/g, '_')
    const dir = path.join(OUT_DIR, host + '-' + safeName(g.vid || 'x') + '-' + title)
    try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { task.status = 'error'; task.err = '创建目录失败: ' + e.message; return cb(null, id) }

    // 文件名
    let fileName = 'video.mp4'
    try {
      const up = new url.URL(base)
      const pm = up.pathname || ''
      if (/\.mp3($|\?)/i.test(pm) || quality === 'audio') fileName = 'audio.mp3'
      else if (/\.(mp4|m4a|webm)($|\?)/i.test(pm)) fileName = 'video.' + (pm.match(/\.(mp4|m4a|webm)($|\?)/i)[1] || 'mp4')
      else fileName = 'video.mp4'
    } catch (e) { fileName = 'video.mp4' }

    // 保存 info.json（结构对齐 download_videos.cjs 的规范）
    try {
      fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({
        input: link, engine: 'greenvideo', host: g.host, vid: g.vid, title: info.title,
        items: [vid].concat(g.audios || []).concat(g.covers || []), fetchedAt: new Date().toISOString()
      }, null, 2))
    } catch (e) {}

    const dest = path.join(dir, fileName)
    task.outPath = dest
    task.title = info.title

    // 平台 referer：B站直链必须带，否则 403
    const headers = { 'user-agent': 'Mozilla/5.0', 'accept': '*/*' }
    const hostL = (g.host || '').toLowerCase()
    if (hostL.indexOf('bilibili') >= 0 || /bilivideo\.com/.test(base)) {
      headers['referer'] = 'https://www.bilibili.com'
    }

    downloadFileWithProgress(base, dest, headers, task).then(function () {
      task.status = 'done'
      task.progress = 100
    }).catch(function (e) {
      task.status = 'error'
      task.err = '下载失败: ' + (e.message || e)
    })
    return cb(null, id)
  }).catch(function (e) {
    task.status = 'error'
    task.err = 'greenvideo 解析失败: ' + (e.message || e)
    return cb(null, id)
  })
}

// 带进度与断点续传能力的下载。为避免下载大文件时 fetch 全量进内存，用流式写入。
function downloadFileWithProgress(uri, destPath, headers, task) {
  return new Promise(function (resolve, reject) {
    const mod = uri.indexOf('https:') === 0 ? require('https') : require('http')
    const req = mod.request(uri, { headers: headers, method: 'GET' }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const loc = res.headers.location
        return downloadFileWithProgress(loc.indexOf('http') === 0 ? loc : new url.URL(loc, uri).toString(), destPath, headers, task).then(resolve, reject)
      }
      if (res.statusCode >= 400) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0
      let got = 0
      const file = fs.createWriteStream(destPath)
      res.on('data', function (c) {
        got += c.length
        if (total > 0) task.progress = Math.min(99, Math.round((got / total) * 100))
        task.log = [destPath]
      })
      res.pipe(file)
      file.on('finish', function () { file.close(function () { resolve() }) })
      file.on('error', reject)
    })
    req.setTimeout(120000, function () { req.destroy(new Error('下载超时 120s')) })
    req.on('error', reject)
    req.end()
  })
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
  console.log('[video-server] engines: yt-dlp (default) + greenvideo (fallback, no-login)')
})
