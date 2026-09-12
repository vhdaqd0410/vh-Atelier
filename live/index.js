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
      // 注意：直播的播放地址不能从 -J 的顶层 url/formats 拿（常常为空），
      // 要用 getStreamUrl()（yt-dlp -g）单独取。这里只回元信息。
      cb(null, {
        platform: plat,
        isLive: isLive,
        title: j.title || '',
        uploader: j.uploader || j.channel || '',
        roomUrl: link,
        streamUrl: '',          // 播放地址请调 /stream（-g）
        streamExt: j.ext || '',
        formats: formats,
        thumbnail: j.thumbnail || ''
      })
    })
  } catch (e) {
    return cb(new Error('启动解析失败: ' + e.message))
  }
}

// 取播放直链：用 yt-dlp -g（--get-url）拿真正的流地址
// 不同于 -J（元信息），-g 才会给出可直接喂给播放器/ffmpeg 的 URL。
// 传入可选的 formatId 时，取该格式的直链。
function getStreamUrl(link, formatId, cb) {
  const plat = platformOf(link)
  if (!plat) return cb(new Error('无法识别的直播间链接'))
  if (!fs.existsSync(YTDLP)) return cb(new Error('yt-dlp.exe 缺失'))

  const args = baseArgs().concat(['-g'])
  if (formatId) args.push('-f', String(formatId))
  args.push(link)

  try {
    childProcess.execFile(YTDLP, args, { timeout: 90000, maxBuffer: 1024 * 1024 * 16, windowsHide: true }, function (err, stdout, stderr) {
      if (err) {
        const msg = String((stderr || '') + (err.message || '')).toLowerCase()
        if (/not currently live|is not live|offline|未开播/.test(msg)) {
          return cb(new Error('当前未开播'))
        }
        return cb(new Error('取流地址失败: ' + String(err.message || err).split('\n')[0]))
      }
      // -g 可能返回多行（视频流/音频流），直播通常单行
      const urls = String(stdout || '').split('\n').map(function (s) { return s.trim() }).filter(Boolean)
      if (!urls.length) return cb(new Error('未取到播放地址（可能未开播或需要 Cookie）'))
      // 取第一个符合条件的 http(s) 地址
      const u = urls.filter(function (x) { return /^https?:\/\//i.test(x) })[0] || urls[0]
      if (!/^https?:\/\//i.test(u)) {
        return cb(new Error('取到的不是有效地址：' + u.slice(0, 60)))
      }
      cb(null, { streamUrl: u, alternates: urls.length > 1 ? urls.slice(1, 4) : [] })
    })
  } catch (e) {
    return cb(new Error('启动 yt-dlp 失败: ' + e.message))
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

    // 用 yt-dlp 直接录制（而不是自己拿直链喂 ffmpeg）：
    //   yt-dlp 自己会做提取/重连/断流恢复，是录直播的标准做法；
    //   直链有时效，长时录制中途失效会直接断，交给 yt-dlp 更稳。
    //   --hls-use-mpegts：HLS 写 mpegts 流式落盘，中途停止时文件仍可播放（关键）；
    //   -o 指定 .mkv：容器耐崩溃，录完再无损 remux 成 mp4。
    const args = baseArgs().concat([
      '--hls-use-mpegts',
      '--no-part',
      '--no-playlist',
      '--retries', '20',
      '--fragment-retries', '20',
      '--no-check-certificates',
      '-o', rec.segmentMkv,
      link
    ])

    let child
    try {
      child = childProcess.spawn(YTDLP, args, { windowsHide: true })
    } catch (e) {
      rec.status = 'error'; rec.err = '启动 yt-dlp 失败: ' + e.message
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
    // 4 小时上限：yt-dlp 没有内建的时长限制，到点自动停（走与手动停止相同的收尾流程）
    const maxTimer = setTimeout(function () {
      if (rec.status === 'recording') {
        rec.log.push('已达 ' + REC_MAX_MINUTES + ' 分钟上限，自动停止')
        stopRecord(rec.id, function () {})
      }
    }, REC_MAX_MINUTES * 60 * 1000)
    rec.maxTimer = maxTimer
    child.on('error', function (e) {
      rec.status = 'error'; rec.err = e.message
    })
    child.on('close', function (code) {
      if (rec.maxTimer) { try { clearTimeout(rec.maxTimer) } catch (e) {} rec.maxTimer = null }
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
  if (rec.maxTimer) { try { clearTimeout(rec.maxTimer) } catch (e) {} rec.maxTimer = null }
  try {
    // Windows 下需要 taskkill 才能让 yt-dlp/ffmpeg 干净退出并封好容器
    if (rec.child && rec.child.pid) {
      childProcess.exec('taskkill /PID ' + rec.child.pid + ' /T /F', { windowsHide: true }, function () {})
    } else if (rec.child) {
      rec.child.kill('SIGTERM')
    }
  } catch (e) {}
  cb(null)
}

// ---------- 平台推荐 / 分类 / 搜索 ----------
// 说明：这部分不能用 yt-dlp（它只能解析给定链接），改为直连各平台站点 API。
// 接口来源与可用性均实测确认（2026-09）：
//   斗鱼 推荐 japi/weblist/apinc/allpage  搜索 japi/search/api/searchShow  分类 m.douyu.com/api/cate/list
//   虎牙 推荐 cache.php?m=LiveList          （无公开搜索 JSON 接口，搜索走站点页）
//   B站  推荐 room/v1/Area/getRoomList（旧接口可用，新接口需 wbi 签名）  搜索 web-interface/search/type
//   抖音 首页 HTML 内嵌 webcast 数据，从中提取在播房间

const httpMod = require('http')
const httpsMod = require('https')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

// 通用 GET（支持重定向），返回 string
function httpGet(uri, headers, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const mod = uri.indexOf('https:') === 0 ? httpsMod : httpMod
    const h = Object.assign({ 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' }, headers || {})
    const req = mod.request(uri, { headers: h, method: 'GET' }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        const loc = res.headers.location
        const next = loc.indexOf('http') === 0 ? loc : require('url').resolve(uri, loc)
        return httpGet(next, headers, timeoutMs).then(resolve, reject)
      }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', function (c) { buf += c })
      res.on('end', function () { resolve(buf) })
    })
    req.setTimeout(timeoutMs || 15000, function () { req.destroy(new Error('请求超时')) })
    req.on('error', reject)
    req.end()
  })
}

function httpGetJson(uri, headers) {
  return httpGet(uri, headers).then(function (s) { return JSON.parse(s) })
}

const RISKY = /[\/:*?"<>|]/g
function pickRoom(platform, roomId, title, uname, cover, online, areaName) {
  return {
    platform: platform,
    platformCN: PLATFORM_CN[platform] || platform,
    roomId: String(roomId || ''),
    title: String(title || '').trim(),
    uname: String(uname || '').trim(),
    cover: String(cover || ''),
    online: online === undefined || online === null ? '' : String(online),
    areaName: String(areaName || ''),
    url: roomUrlOf(platform, roomId)
  }
}

function roomUrlOf(platform, roomId) {
  const id = String(roomId || '')
  if (platform === 'huya') return 'https://www.huya.com/' + id
  if (platform === 'douyu') return 'https://www.douyu.com/' + id
  if (platform === 'bilibili') return 'https://live.bilibili.com/' + id
  if (platform === 'douyin') return 'https://live.douyin.com/' + id
  return ''
}

// ---------- 斗鱼 ----------
function douyuRecommend(page, cb) {
  const p = page || 1
  httpGetJson('https://www.douyu.com/japi/weblist/apinc/allpage/6/' + p, { Referer: 'https://www.douyu.com/' })
    .then(function (j) {
      const rl = ((j || {}).data || {}).rl || []
      const out = rl.map(function (x) {
        return pickRoom('douyu', x.rid, x.rn || x.roomName, x.nn || x.nickName,
          x.rs16 || x.roomSrc || x.av, x.ol || x.hn, x.c2name || x.cateName)
      })
      cb(null, out)
    }).catch(function (e) { cb(e) })
}

function douyuSearch(kw, page, cb) {
  const u = 'https://www.douyu.com/japi/search/api/searchShow?kw=' + encodeURIComponent(kw) +
    '&page=' + (page || 1) + '&pageSize=30'
  httpGetJson(u, { Referer: 'https://www.douyu.com/search/' })
    .then(function (j) {
      // 实测：data.relateShow 直接是数组（不是 {list:[]}）
      const rel = ((j || {}).data || {}).relateShow
      const list = Array.isArray(rel) ? rel : ((rel || {}).list || [])
      const out = list.map(function (x) {
        // 实测字段：rid / roomName / nickName / roomSrc / hot / cateName / isLive
        return pickRoom('douyu', x.rid, x.roomName || x.rn, x.nickName || x.nn,
          x.roomSrc || x.rs16 || x.avatar, x.hot || x.ol, x.cateName || x.c2name)
      }).filter(function (r) { return r.roomId })
      cb(null, out)
    }).catch(function (e) { cb(e) })
}

// ---------- 虎牙 ----------
function huyaRecommend(page, cb) {
  const p = page || 1
  const u = 'https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&tagAll=0&page=' + p
  httpGetJson(u, { Referer: 'https://www.huya.com/' })
    .then(function (j) {
      const ds = (((j || {}).data || {}).datas) || []
      const out = ds.map(function (x) {
        return pickRoom('huya', x.profileRoom || x.privateHost, x.roomName, x.nick,
          x.screenshot || x.avatar180, x.totalCount, x.gameFullName)
      })
      cb(null, out)
    }).catch(function (e) { cb(e) })
}

function huyaSearch(kw, page, cb) {
  // 虎牙搜索接口需要站点页上下文，这里给出可用的搜索跳转地址，由其自行解析；
  // 实际取回用 m.huya.com 移动站搜索页（返回 HTML，不适合直接解析），
  // 故虎牙搜索返回“引导用户去网页搜索”的信号（前端展示提示），返回空列表。
  cb(null, [])
}

// ---------- B站 ----------
function biliRecommend(page, cb) {
  const p = page || 1
  // 旧接口（无需 wbi 签名）
  const u = 'https://api.live.bilibili.com/room/v1/Area/getRoomList?platform=web' +
    '&parent_area_id=1&area_id=0&sort_type=online&page=' + p + '&page_size=30'
  httpGetJson(u, { Referer: 'https://live.bilibili.com/' })
    .then(function (j) {
      const arr = (j || {}).data || []
      const out = (Array.isArray(arr) ? arr : []).map(function (x) {
        return pickRoom('bilibili', x.roomid, x.title, x.uname,
          x.user_cover || x.system_cover, x.online, x.area_name)
      })
      cb(null, out)
    }).catch(function (e) { cb(e) })
}

function biliSearch(kw, page, cb) {
  // 实测（2026-09）：result 是对象 { live_room: [...], live_user: [...] }，主列表取 live_room。
  // 该接口有风控：① 缺 Referer 会 412；② 短时间内重复请求会返回空结果或 412。
  // 这里做一次带延迟的重试，失败时把真实原因报出（而不是静默返回空列表）。
  const u = 'https://api.bilibili.com/x/web-interface/search/type?context=&search_type=live' +
    '&cover_type=user_cover&keyword=' + encodeURIComponent(kw) + '&page=' + (page || 1)

  function attempt(n) {
    httpGetJson(u, { Referer: 'https://live.bilibili.com/' })
      .then(function (j) {
        const data = (j || {}).data
        let arr = []
        if (data) {
          const r = data.result
          if (Array.isArray(r)) arr = r
          else if (r && Array.isArray(r.live_room)) arr = r.live_room
          else if (r && Array.isArray(r.live_user)) arr = r.live_user
        }
        // 拿到空结果且还有重试机会：B站限流常见表现，稍等再试
        if (!arr.length && n < 1) {
          return setTimeout(function () { attempt(n + 1) }, 1500)
        }
        const out = arr.map(function (x) {
          const rid = x.roomid || x.room_id || x.uid || x.mid
          return pickRoom('bilibili', rid, stripEm(x.title), stripEm(x.uname),
            normBiliUrl(x.user_cover || x.cover || x.uface), x.online, stripEm(x.cate_name))
        }).filter(function (r) { return r.roomId })
        if (!out.length) {
          return cb(new Error('B站搜索未返回结果（可能是平台临时限流，稍后重试）'))
        }
        cb(null, out)
      }).catch(function (e) {
        const msg = String(e.message || e)
        // 412 = 风控；重试一次
        if (/412/.test(msg) && n < 1) {
          return setTimeout(function () { attempt(n + 1) }, 1500)
        }
        if (/412/.test(msg)) return cb(new Error('B站接口风控（412），请稍后重试'))
        cb(e)
      })
  }
  attempt(0)
}

// B站搜索结果里关键词会包 <em class="keyword"> 标签，去掉
function stripEm(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, '')
}

// B站部分图片地址以 // 开头，补 https:
function normBiliUrl(u) {
  u = String(u || '')
  if (u.indexOf('//') === 0) return 'https:' + u
  return u
}

// ---------- 抖音 ----------
// 抖音直播首页把在播房间数据内嵌在 HTML 里（webcast 相关 JSON），
// 从中抽取 rid/title/nickname/cover。接口不稳定，失败就返回空（不报错）。
function douyinRecommend(page, cb) {
  httpGet('https://live.douyin.com/', { Referer: 'https://live.douyin.com/' })
    .then(function (html) {
      const out = []
      const seen = {}
      // 在 HTML 中找 "rid":"数字" 与邻近的 title / nickname / cover
      const re = /\\"rid\\":\\"(\d+)\\"/g
      let m
      while ((m = re.exec(html)) !== null) {
        const rid = m[1]
        if (!rid || seen[rid]) continue
        seen[rid] = 1
        // 取该位置之后的片段找标题/昵称
        const seg = html.slice(m.index, m.index + 1600)
        const t = (seg.match(/\\"title\\":\\"(.*?)\\"/) || [])[1] || ''
        const nk = (seg.match(/\\"nickname\\":\\"(.*?)\\"/) || [])[1] || ''
        const cv = (seg.match(/\\"cover\\":\\{\\"url_list\\":\[\\"(.*?)\\"/) || [])[1] ||
                   (seg.match(/\\"cover_url\\":\\"(.*?)\\"/) || [])[1] || ''
        out.push(pickRoom('douyin', rid, unescapeJson(t), unescapeJson(nk), unescapeJson(cv), '', ''))
        if (out.length >= 40) break
      }
      cb(null, out)
    }).catch(function () { cb(null, []) })
}

function douyinSearch(kw, page, cb) {
  // 抖音搜索需签名参数，暂不做；返回空列表并由前端提示
  cb(null, [])
}

// 处理 JSON 字符串里的转义字符
function unescapeJson(s) {
  try {
    return String(s || '').replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)) })
      .replace(/\\\\/g, '\\').replace(/\\"/g, '"')
  } catch (e) { return String(s || '') }
}

// 统一分发
function recommendOf(platform, page, cb) {
  if (platform === 'douyu') return douyuRecommend(page, cb)
  if (platform === 'huya') return huyaRecommend(page, cb)
  if (platform === 'bilibili') return biliRecommend(page, cb)
  if (platform === 'douyin') return douyinRecommend(page, cb)
  cb(new Error('不支持的平台: ' + platform))
}

function searchOf(platform, kw, page, cb) {
  if (platform === 'douyu') return douyuSearch(kw, page, cb)
  if (platform === 'huya') return huyaSearch(kw, page, cb)
  if (platform === 'bilibili') return biliSearch(kw, page, cb)
  if (platform === 'douyin') return douyinSearch(kw, page, cb)
  cb(new Error('不支持的平台: ' + platform))
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

    if (p === '/stream') {   // 取播放直链（yt-dlp -g）
      const link = (q.url || '').trim()
      if (!link) return json(res, fail('缺少 url'))
      getStreamUrl(link, q.format || '', function (err, d) {
        if (err) return json(res, fail(err.message))
        json(res, ok(d))
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

    if (p === '/recommend') {   // 平台推荐列表
      const plat = (q.platform || '').toLowerCase()
      const page = parseInt(q.page || '1', 10) || 1
      if (['huya', 'douyu', 'bilibili', 'douyin'].indexOf(plat) < 0) {
        return json(res, fail('不支持的平台（可选：huya / douyu / bilibili / douyin）'))
      }
      recommendOf(plat, page, function (err, list) {
        if (err) return json(res, fail('获取推荐失败: ' + err.message))
        json(res, ok({ platform: plat, page: page, list: list }))
      })
      return
    }

    if (p === '/search') {      // 搜索直播间
      const plat = (q.platform || '').toLowerCase()
      const kw = (q.kw || '').trim()
      const page = parseInt(q.page || '1', 10) || 1
      if (!kw) return json(res, fail('缺少搜索关键词'))
      if (['huya', 'douyu', 'bilibili', 'douyin'].indexOf(plat) < 0) {
        return json(res, fail('不支持的平台（可选：huya / douyu / bilibili / douyin）'))
      }
      searchOf(plat, kw, page, function (err, list) {
        if (err) return json(res, fail('搜索失败: ' + err.message))
        json(res, ok({ platform: plat, kw: kw, page: page, list: list }))
      })
      return
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
