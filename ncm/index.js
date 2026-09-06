// vh-Atelier 网易云音乐本地服务（精简版）
// 只暴露插件需要的接口：扫码登录 / 搜索 / 歌单 / 歌曲直链 / 用户歌单
// 依赖 NeteaseCloudMusicApi（npm 包），cookie 在内存中维护
const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const ncm = require('NeteaseCloudMusicApi')

// ---- 听歌识曲：afp 指纹（网易云 demo 同款）----
// afp.js 需要浏览器 polyfill + 全局对象
if (typeof btoa === 'undefined') global.btoa = s => Buffer.from(s, 'binary').toString('base64')
if (typeof atob === 'undefined') global.atob = s => Buffer.from(s, 'base64').toString('binary')
if (typeof TextEncoder === 'undefined') global.TextEncoder = require('util').TextEncoder
global.window = global
global.self = global
global.document = { createElement: () => ({ getContext: () => null, style: {} }) }
const afp = require('./afp/afp.js')

const app = express()
const PORT = 17890

app.use(cors())
app.use(express.json({ limit: '10mb' }))
// 识曲接口提交是表单格式
app.use(express.urlencoded({ extended: true }))

// 登录 cookie：持久化到本目录 .ncm_cookie，重启服务免重新扫码
const COOKIE_FILE = path.join(__dirname, '.ncm_cookie')
let cookie = ''
try {
  cookie = fs.readFileSync(COOKIE_FILE, 'utf8').trim()
} catch (e) { cookie = '' }

function saveCookie(c) {
  cookie = c
  try {
    if (c) fs.writeFileSync(COOKIE_FILE, c, 'utf8')
    else if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE)
  } catch (e) {}
}

function ok(data) {
  return { code: 0, data }
}
function fail(msg) {
  return { code: -1, msg }
}

// 健康检查
app.get('/health', (req, res) => {
  res.json({ code: 0, alive: true, logged: !!cookie })
})

// 生成登录 key
app.get('/login/qr/key', async (req, res) => {
  try {
    const r = await ncm.login_qr_key({})
    res.json(r.body && r.body.data ? ok(r.body.data) : r.body)
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 生成二维码（返回 base64 图片）
app.get('/login/qr/create', async (req, res) => {
  const key = req.query.key || ''
  try {
    const r = await ncm.login_qr_create({ key, qrimg: true })
    res.json(r.body && r.body.data ? ok(r.body.data) : r.body)
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 轮询扫码状态
app.get('/login/qr/check', async (req, res) => {
  const key = req.query.key || ''
  try {
    const r = await ncm.login_qr_check({ key })
    // r.body: { code: 800/801/802/803, cookie, message }
    if (r.body && r.body.code === 803 && r.body.cookie) {
      saveCookie(r.body.cookie)
    }
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 登录状态
app.get('/login/status', async (req, res) => {
  try {
    const r = await ncm.login_status({ cookie })
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 用户详情（头像/昵称，需登录）
app.get('/user/detail', async (req, res) => {
  const uid = req.query.uid || ''
  try {
    const r = await ncm.user_detail({ uid, cookie })
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 账号信息（登录后拿自己的 uid/昵称/头像）
app.get('/user/account', async (req, res) => {
  try {
    const r = await ncm.user_account({ cookie })
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 退出
app.get('/logout', async (req, res) => {
  try {
    await ncm.logout({ cookie })
    saveCookie('')
    res.json(ok({ logged: false }))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 搜索歌曲/歌单/歌手/专辑（type: 1单曲 1000歌单 100歌手 10专辑）
app.get('/search', async (req, res) => {
  const keywords = req.query.keywords || ''
  const limit = parseInt(req.query.limit || '30', 10)
  const offset = parseInt(req.query.offset || '0', 10)
  const type = parseInt(req.query.type || '1', 10)
  try {
    const r = await ncm.search({ keywords, limit, offset, type, cookie })
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 歌曲详情（含播放直链）
app.get('/song/url', async (req, res) => {
  const id = req.query.id || ''
  const br = parseInt(req.query.br || '320000', 10)
  try {
    const r = await ncm.song_url({ id, br, cookie })
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 歌曲详情（元信息，用于拿歌名/歌手/专辑/封面）
app.get('/song/detail', async (req, res) => {
  const ids = req.query.ids || ''
  try {
    const r = await ncm.song_detail({ ids, cookie })
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 歌单详情（曲目列表）
app.get('/playlist/detail', async (req, res) => {
  const id = req.query.id || ''
  try {
    const r = await ncm.playlist_detail({ id, cookie })
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 用户歌单（需登录）
app.get('/user/playlist', async (req, res) => {
  const uid = req.query.uid || ''
  try {
    const r = await ncm.user_playlist({ uid, cookie })
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 歌词（用于未来扩展）
app.get('/lyric', async (req, res) => {
  const id = req.query.id || ''
  try {
    const r = await ncm.lyric({ id, cookie })
    res.json(r.body || fail('no body'))
  } catch (e) {
    res.json(fail(e.message))
  }
})

// 听歌识曲：上传 Shazam 指纹（audioFP），返回匹配的歌曲
// audioFP 由前端用 afp.js/wasm 生成（8kHz 音频指纹），duration 单位秒
app.post('/audio/match', async (req, res) => {
  const audioFP = req.body.audioFP || ''
  const duration = req.body.duration || '3'
  if (!audioFP) {
    return res.json(fail('缺少 audioFP'))
  }
  try {
    // NeteaseCloudMusicApi 的 audio_match 模块：内部调网易云接口
    const r = await ncm.audio_match({ audioFP, duration, cookie })
    // 结构: { status, body: { code, data } }
    if (r && r.body) {
      return res.json(r.body)
    }
    res.json(fail('识别服务无响应'))
  } catch (e) {
    res.json(fail('识别失败: ' + e.message))
  }
})

// ---- 读取 wav 转 8kHz Float32（afp 需要） ----
function wavTo8kFloat32(filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 wav 文件')
  const sampleRate = buf.readUInt32LE(24)
  const channels = buf.readUInt16LE(22)
  const bits = buf.readUInt16LE(34)
  let off = 12, dataStart = -1
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const sz = buf.readUInt32LE(off + 4)
    if (id === 'data') { dataStart = off + 8; break }
    off += 8 + sz + (sz % 2)
  }
  if (dataStart < 0) throw new Error('wav 无 data 块')
  const pcm = buf.slice(dataStart)
  const bps = bits / 8
  const raw = []
  for (let i = 0; i + bps <= pcm.length; i += bps * channels) {
    raw.push(bits === 16 ? pcm.readInt16LE(i) / 32768 : pcm.readInt32LE(i) / 2147483648)
  }
  // 降采样到 8k
  const n8k = Math.floor(raw.length * 8000 / sampleRate)
  const out = new Float32Array(n8k)
  for (let i = 0; i < n8k; i++) out[i] = raw[Math.floor(i * sampleRate / 8000)]
  return out
}

// 一键识曲：POST { wavPath } 或 { wavBase64 }，返回匹配歌曲
// 内部：读 wav → 8k → 前3秒 → afp 指纹 → 网易云匹配
app.post('/identify', async (req, res) => {
  try {
    let f32 = null
    if (req.body && req.body.wavPath) {
      f32 = wavTo8kFloat32(req.body.wavPath)
    } else if (req.body && req.body.wavBase64) {
      const tmp = path.join(require('os').tmpdir(), 'vh_identify_' + Date.now() + '.wav')
      fs.writeFileSync(tmp, Buffer.from(req.body.wavBase64, 'base64'))
      f32 = wavTo8kFloat32(tmp)
      fs.unlinkSync(tmp)
    } else {
      return res.json(fail('缺少 wavPath 或 wavBase64'))
    }

    const duration = 3  // 网易云匹配算法用前几秒
    const take = Math.min(f32.length, duration * 8000)
    const clip = take < f32.length ? f32.subarray(0, take) : f32
    const audioFP = await afp.GenerateFP(clip)

    const r = await ncm.audio_match({ audioFP, duration, cookie })
    if (r && r.body) return res.json(r.body)
    res.json(fail('识别服务无响应'))
  } catch (e) {
    res.json(fail('识曲失败: ' + e.message))
  }
})

app.listen(PORT, '127.0.0.1', () => {
  console.log('[ncm-server] listening on http://127.0.0.1:' + PORT)
})
