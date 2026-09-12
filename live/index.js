// vh-Atelier 直播本地服务（零依赖，纯 Node 标准库）
// 能力：解析直播间真实流地址（观看） / ffmpeg 拉流录制 / 关注列表与开播状态
// 支持平台：虎牙、斗鱼、哔哩哔哩、抖音（yt-dlp 原生 extractor）
//           快手 yt-dlp 无 extractor，暂不支持
// 端口：17893（video=17892，music=17890）
//
// 设计要点：
//   1. 解析复用 bin/yt-dlp.exe（与 video 服务同一套 cookie 策略）
//   2. 录制用 bin/ffmpeg-win32-x64.exe 直接拉流，落 mkv（断电不毁），
//      录制结束后自动 remux 成 mp4（-c copy，秒级，无损）
//   3. 录制可随时停止并保留已录内容；4 小时上限保护
//   4. 全程本地，不需要任何账号

const http = require('http')
const fs = require('fs')
const path = require('path')
const url = require('url')
const childProcess = require('child_process')

const PORT = 17893
const HOST = '127.0.0.1'

const YTDLP = path.join(__dirname, '..', 'bin', 'yt-dlp.exe')
const FFMPEG = path.join(__dirname, '..', 'bin', 'ffmpeg-win32-x64.exe')
const COOKIE_FILE = path.join(__dirname, '.video_cookie')
const COOKIE_TXT = path.join(__dirname, '.video_cookies.txt')
const OUT_DIR = path.join(__dirname, '..', 'collect', 'live')
const FAV_FILE = path.join(__dirname, 'collect_live_favs.json')
const REC_MAX_MINUTES = 240          // 录制上限：4 小时
const FREE_SPACE_GUARD_MB = 500      // 磁盘余量保护

// ---------- cookie（与 video 服务共用同一份） ----------
let cookieMode = 'none'
let cookie = ''
try { cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim() } catch (e) { cookie = '' }
if (cookie && /^(# Netscape HTTP Cookie File|\.douyin\.com|\tbilibili\.com)/m.test(cookie)) {
  cookieMode = 'netscape'
} else if (cookie) {
  cookieMode = 'header'
}

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

// ---------- 通用 ----------
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
  return (s || 'live').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80)
}

function ensureDir(d) {
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) } catch (e) {}
}

// 平台识别：只认我们支持的四个
function platformOf(link) {
  const s = String(link || '').toLowerCase()
  if (/huya\.com/.test(s)) return 'huya'
  if (/douyu\.com/.test(s)) return 'douyu'
  if (/bilibili\.com|b23\.tv/.test(s)) return 'bilibili'
  if (/douyin\.com|iesdouyin\.com/.test(s)) return 'douyin'
  if (/kuaishou\.com/.test(s)) return 'kuaishou'   // 识别出来但明确告知不支持
  return ''
}

const PLATFORM_CN = { huya: '虎牙', douyu: '斗鱼', bilibili: '哔哩哔哩', douyin: '抖音', kuaishou: '快手', '': '未知' }

// ---------- 解析直播间 ----------
// 返回 { platform, isLive, title, uploader, roomUrl, streamUrl, streamExt, formats, thumbnail }
function parseLive(link, cb) {
  const plat = platformOf(link)
  if (plat === 'kuaishou') return cb(new Error('快手暂不支持（yt-dlp 没有快手直播 extractor）'))
  if (!plat) return cb(new Error('无法识别的直播间链接（支持虎牙 / 斗鱼 / 哔哩哔哩 / 抖音）'))
  if (!fs.existsSync(YTDLP)) return cb(new Error('yt-dlp.exe 缺失'))

  const args = baseArgs().concat(['-J', link])
  let handle
  try {
    handle = childProcess.execFile(YTDLP, args, { timeout: 90000, maxBuffer: 1024 * 1024 * 32, windowsHide: true }, function (err, stdout, stderr) {
      if (err) {
        const msg = String((stderr || '') + (err.message || '')).toLowerCase()
        // 未开播的常见提示：尽量给友好文案
        if (/not currently live|is not live|no live|offline|未开播|live event will begin/.test(msg)) {
          return cb(null, { platform: plat, isLive: false, title: '', uploader: '', roomUrl: link, streamUrl: '', streamExt: '', formats: [], thumbnail: '' })
        }
        return cb(new Error('解析失败: ' + String(err.message || err).split('\n')[0]))
      }
      let j = null
      try { j = JSON.parse(stdout) } catch (e) { return cb(new Error('解析结果无效')) }

      const isLive = !!(j.is_live || j.live_status === 'is_live' || j.was_live === false)
      // 可选画质（直播一般就几档）
      const formats = []
      const seen = {}
      ;(j.formats || []).forEach(function (f) {
        const key = (f.height || f.format_note || 'default') + '|' + (f.ext || '')
        if (seen[key]) return
        seen[key] = 1
        formats.push({
          formatId: f.format_id,
          note: f.format_note || (f.height ? (f.height + 'p') : ''),
          ext: f.ext || '',
          height: f.height || 0,
          vcodec: f.vcodec || '',
          acodec: f.acodec || ''
        })
      })
      // 默认取最佳单文件（直播通常单流，避免合流等待）
      let streamUrl = j.url || ''
      let streamExt = j.ext || ''
      if (!streamUrl && formats.length) {
        const best = formats.slice().sort(function (a, b) { return (b.height || 0) - (a.height || 0) })[0]
        streamUrl = best.formatId || ''
        streamExt = best.ext || ''
      }
      cb(null, {
        platform: plat,
        isLive: isLive,
        title: j.title || '',
        uploader: j.uploader || j.channel || '',
        roomUrl: link,
        streamUrl: streamUrl,
        streamExt: streamExt,
        formats: formats,
        thumbnail: j.thumbnail || ''
      })
    })
  } catch (e) {
    return cb(new Error('启动解析失败: ' + e.message))
  }
}

// ---------- 录制任务 ----------
// id -> { link, platform, title, status, outPath, mp4Path, err, startedAt, stoppedAt, log, minutes, child }
let recs = {}
let recSeq = 0

function startRecord(link, quality, cb) {
  ensureDir(OUT_DIR)
  const plat = platformOf(link)
  if (plat === 'kuaishou') return cb(new Error('快手暂不支持录制'))
  if (!plat) return cb(new Error('无法识别的直播间链接'))
  if (!fs.existsSync(FFMPEG)) return cb(new Error('ffmpeg 缺失'))

  const id = 'r' + (++recSeq) + '_' + Date.now()
  const rec = {
    id, link, platform: plat, platformCN: PLATFORM_CN[plat],
    title: '', status: 'starting', outPath: '', mp4Path: '', err: '',
    startedAt: Date.now(), stoppedAt: 0, log: [], minutes: 0, child: null,
    segmentMkv: ''
  }
  recs[id] = rec

  // 先解析一次拿标题与流地址（未开播则报错，由前端决定是否定时等待）
  parseLive(link, function (err, info) {
    if (err) { rec.status = 'error'; rec.err = err.message; return cb(null, id) }
    if (!info.isLive) { rec.status = 'error'; rec.err = '当前未开播，无法录制'; return cb(null, id) }
    rec.title = info.title || info.uploader || ('live-' + id)

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const base = safeName(rec.platformCN + '_' + rec.title + '_' + stamp)
    rec.segmentMkv = path.join(OUT_DIR, base + '.mkv')

    // ffmpeg 拉流转存 mkv：
    //   -c copy 不转码（省 CPU，画质无损）
    //   -t 上限 4 小时
    //   自动重连（直播断流常见）
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rw_timeout', '15000000',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '30',
      '-i', info.streamUrl || link,
      '-c', 'copy',
      '-t', String(REC_MAX_MINUTES * 60),
      '-y', rec.segmentMkv
    ]

    let child
    try {
      child = childProcess.spawn(FFMPEG, args, { windowsHide: true })
    } catch (e) {
      rec.status = 'error'; rec.err = '启动 ffmpeg 失败: ' + e.message
      return cb(null, id)
    }
    rec.child = child
    rec.status = 'recording'
    rec.outPath = rec.segmentMkv

    let errBuf = ''
    child.stderr.on('data', function (c) {
      const s = c.toString()
      errBuf += s
      if (errBuf.length > 20000) errBuf = errBuf.slice(-10000)
    })
    child.on('error', function (e) {
      rec.status = 'error'; rec.err = e.message
    })
    child.on('close', function (code) {
      rec.stoppedAt = Date.now()
      rec.minutes = Math.max(1, Math.round((rec.stoppedAt - rec.startedAt) / 60000))
      if (rec.status === 'error') return
      if (!fs.existsSync(rec.segmentMkv)) {
        rec.status = 'error'
        rec.err = '录制未生成文件（' + (errBuf.split('\n').filter(function (l) { return l.trim() }).slice(-2).join(' | ') || ('退出码 ' + code)) + '）'
        return
      }
      // 录完自动 remux 成 mp4（-c copy 无损，秒级）
      remuxToMp4(rec)
    })

    cb(null, id)
  })
}

// mkv → mp4 无损转封装
function remuxToMp4(rec) {
  const mp4 = rec.segmentMkv.replace(/\.mkv$/i, '.mp4')
  rec.status = 'remuxing'
  const args = ['-hide_banner', '-loglevel', 'warning', '-i', rec.segmentMkv, '-c', 'copy', '-movflags', '+faststart', '-y', mp4]
  let child
  try {
    child = childProcess.spawn(FFMPEG, args, { windowsHide: true })
  } catch (e) {
    rec.status = 'done'; rec.mp4Path = ''; rec.err = '转 mp4 失败（mkv 已保留）'
    return
  }
  let errBuf = ''
  child.stderr.on('data', function (c) { errBuf += c.toString() })
  child.on('close', function (code) {
    if (code === 0 && fs.existsSync(mp4)) {
      rec.mp4Path = mp4
      rec.status = 'done'
      // 转封装成功即删掉 mkv（省空间）；失败则保留
      try { fs.unlinkSync(rec.segmentMkv) } catch (e) {}
    } else {
      rec.status = 'done'
      rec.mp4Path = ''
      rec.err = '已录成 mkv（转 mp4 失败，可直接用或手动转）'
    }
  })
}

function stopRecord(id, cb) {
  const rec = recs[id]
  if (!rec) return cb(new Error('录制任务不存在'))
  if (rec.status !== 'recording') return cb(new Error('该任务已结束（' + rec.status + '）'))
  rec.status = 'stopping'
  try {
    // Windows 下 ffmpeg 需要 taskkill 才能干净退出（SIGTERM 可能导致文件不完整）
    if (rec.child && rec.child.pid) {
      childProcess.exec('taskkill /PID ' + rec.child.pid + ' /T /F', { windowsHide: true }, function () {})
    } else if (rec.child) {
      rec.child.kill('SIGTERM')
    }
  } catch (e) {}
  cb(null)
}

// ---------- 关注列表 ----------
function loadFavs() {
  try {
    if (!fs.existsSync(FAV_FILE)) return []
    const a = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8'))
    return Array.isArray(a) ? a : []
  } catch (e) { return [] }
}
function saveFavs(a) {
  try { fs.writeFileSync(FAV_FILE, JSON.stringify(a, null, 1), 'utf8') } catch (e) {}
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

  function readBody(cb) {
    let body = ''
    req.on('data', function (c) { body += c })
    req.on('end', function () {
      try { cb(null, JSON.parse(body || '{}')) } catch (e) { cb(e, null) }
    })
  }

  try {
    if (p === '/health') {
      let ver = ''
      try { ver = childProcess.execFileSync(YTDLP, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim() } catch (e) { ver = '' }
      return json(res, ok({
        alive: true, version: ver,
        hasYtdlp: fs.existsSync(YTDLP), hasFfmpeg: fs.existsSync(FFMPEG),
        hasCookie: cookieMode !== 'none', cookieMode: cookieMode,
        platforms: ['huya', 'douyu', 'bilibili', 'douyin'],
        maxMinutes: REC_MAX_MINUTES
      }))
    }

    if (p === '/parse') {
      const link = (q.url || '').trim()
      if (!link) return json(res, fail('缺少 url'))
      parseLive(link, function (err, info) {
        if (err) return json(res, fail(err.message))
        json(res, ok(info))
      })
      return
    }

    if (p === '/record') {   // 开始录制
      const link = (q.url || '').trim()
      if (!link) return json(res, fail('缺少 url'))
      startRecord(link, q.quality || 'best', function (err, id) {
        if (err) return json(res, fail(err.message))
        json(res, ok({ id }))
      })
      return
    }

    if (p === '/stop') {     // 停止录制
      readBody(function (e, o) {
        const id = (o && o.id) || q.id || ''
        stopRecord(id, function (err) {
          if (err) return json(res, fail(err.message))
          json(res, ok({ id }))
        })
      })
      return
    }

    if (p === '/recs') {     // 录制任务列表
      const list = Object.keys(recs).map(function (k) {
        const r = recs[k]
        return {
          id: r.id, link: r.link, platform: r.platform, platformCN: r.platformCN,
          title: r.title, status: r.status, outPath: r.outPath, mp4Path: r.mp4Path,
          err: r.err, startedAt: r.startedAt, stoppedAt: r.stoppedAt, minutes: r.minutes,
          elapsedSec: Math.round(((r.stoppedAt || Date.now()) - r.startedAt) / 1000)
        }
      }).sort(function (a, b) { return b.startedAt - a.startedAt })
      return json(res, ok({ list: list }))
    }

    if (p === '/rec') {
      const id = q.id || ''
      const r = recs[id]
      if (!r) return json(res, fail('任务不存在'))
      return json(res, ok({
        id: r.id, title: r.title, status: r.status, outPath: r.outPath, mp4Path: r.mp4Path,
        err: r.err, startedAt: r.startedAt, stoppedAt: r.stoppedAt, minutes: r.minutes,
        platform: r.platform, platformCN: r.platformCN,
        elapsedSec: Math.round(((r.stoppedAt || Date.now()) - r.startedAt) / 1000)
      }))
    }

    if (p === '/favs') {
      if (req.method === 'POST') {
        return readBody(function (e, o) {
          if (e) return json(res, fail('解析失败'))
          const action = (o && o.action) || 'add'
          let list = loadFavs()
          if (action === 'add') {
            const link = String((o && o.url) || '').trim()
            if (!link) return json(res, fail('缺少 url'))
            if (!platformOf(link)) return json(res, fail('不支持的直播间链接'))
            if (list.some(function (f) { return f.url === link })) return json(res, ok({ list: list }))
            list.push({ url: link, name: String((o && o.name) || '').trim(), platform: platformOf(link), addedAt: Date.now() })
          } else if (action === 'remove') {
            const link = String((o && o.url) || '').trim()
            list = list.filter(function (f) { return f.url !== link })
          } else if (action === 'rename') {
            const link = String((o && o.url) || '').trim()
            list.forEach(function (f) { if (f.url === link) f.name = String((o && o.name) || '').trim() })
          }
          saveFavs(list)
          json(res, ok({ list: list }))
        })
      }
      return json(res, ok({ list: loadFavs() }))
    }

    if (p === '/favs/status') {   // 批量查开播状态（串行，避免并发打平台接口）
      const list = loadFavs()
      const out = []
      let i = 0
      function next() {
        if (i >= list.length) return json(res, ok({ list: out }))
        const f = list[i++]
        parseLive(f.url, function (err, info) {
          out.push({
            url: f.url, name: f.name, platform: f.platform, platformCN: PLATFORM_CN[f.platform],
            isLive: !!(info && info.isLive),
            title: (info && info.title) || '',
            uploader: (info && info.uploader) || '',
            error: err ? err.message : ''
          })
          next()
        })
      }
      next()
      return
    }

    json(res, fail('未知端点 ' + p))
  } catch (e) {
    json(res, fail(e.message || String(e)))
  }
})

server.listen(PORT, HOST, function () {
  console.log('[live-server] listening on http://' + HOST + ':' + PORT)
  console.log('[live-server] platforms: huya / douyu / bilibili / douyin (kuaishou unsupported)')
})
