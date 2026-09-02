// vh-Atelier 网易云音乐本地服务（精简版）
// 只暴露插件需要的接口：扫码登录 / 搜索 / 歌单 / 歌曲直链 / 用户歌单
// 依赖 NeteaseCloudMusicApi（npm 包），cookie 在内存中维护
const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const ncm = require('NeteaseCloudMusicApi')

const app = express()
const PORT = 17890

app.use(cors())
app.use(express.json())

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

app.listen(PORT, '127.0.0.1', () => {
  console.log('[ncm-server] listening on http://127.0.0.1:' + PORT)
})
