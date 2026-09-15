// vh-Atelier 视频下载：greenvideo.cc 免登录兜底引擎（zero-dep，仅 Node 内置 crypto/fetch）
// 架构说明：
//   - 复刻 greenvideo 网页前端加密流程（AES-128-CBC + RSA-1024 分段），把分享文本/URL 加密后
//     POST 到 https://greenvideo.cc/api/video/cnSimpleExtract，换取各平台免登录下载直链。
//   - 定位为 yt-dlp 的兜底通道：yt-dlp 缺 cookie / extractor 失效 / 被风控时自动降级到本引擎。
//   - 接口特征：公钥约 5 分钟过期（失效时返回 code=530，重跑即可）；下载直链通常几小时内有效。
//   - 平台差异：B站直链需带 Referer: https://www.bilibili.com；抖音直链自带音轨且免头直接可下。
const crypto = require('crypto')

const HOST = 'https://greenvideo.cc'
const IV_B64 = 'a2Vkb3VAODk4OSE2MzIzMw==' // 固定 IV: 'kedou@8989!63233'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ---------- 首页取 cookie（免登录） ----------
async function fetchCookie() {
  const r = await fetch(HOST + '/', {
    method: 'GET',
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'zh-CN,zh;q=0.9' },
  })
  if (r.status !== 200) throw new Error('greenvideo 首页访问失败 status=' + r.status)
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  const setCookies = Array.isArray(raw) ? raw : []
  if (!setCookies.length) return ''
  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

// ---------- RSA 公钥解密 k2 得 AES key（PKCS#1 v1.5 用公钥做 doPublic） ----------
function decryptByPublicKey(k2Base64, publicPem) {
  const buf = Buffer.from(k2Base64, 'base64')
  const key = crypto.createPublicKey(publicPem)
  return crypto.publicDecrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, buf).toString('utf8')
}

// ---------- AES-128-CBC + PKCS7，输出 base64（等价 CryptoJS.AES.encrypt） ----------
function aesEncryptString(plainJson, aesKeyUtf8) {
  const iv = Buffer.from(IV_B64, 'base64')
  const key = Buffer.from(aesKeyUtf8, 'utf8')
  const enc = crypto.createCipheriv('aes-' + key.length * 8 + '-cbc', key, iv)
  return enc.update(plainJson, 'utf8', 'base64') + enc.final('base64')
}

// JSEncrypt.encryptLong 复刻：JSEncrypt 的 hex2b64 是自定义 base64（每 3 hex 字符转 2 base64 字符），
// 不能用标准 Buffer.from(hex).toString('base64')。117 字节/段 RSA-1024。
const F_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function hex2b64(hex) {
  let i, o = ''
  for (i = 0; i + 3 <= hex.length; i += 3) {
    const n = parseInt(hex.substring(i, i + 3), 16)
    o += F_CHARSET.charAt(n >> 6) + F_CHARSET.charAt(n & 63)
  }
  if (i + 1 === hex.length) {
    const n = parseInt(hex.substring(i, i + 1), 16)
    o += F_CHARSET.charAt(n << 2)
  } else if (i + 2 === hex.length) {
    const n = parseInt(hex.substring(i, i + 2), 16)
    o += F_CHARSET.charAt(n >> 2) + F_CHARSET.charAt((n & 3) << 4)
  }
  while ((o.length & 3) > 0) o += '='
  return o
}

function encryptLongBase64(plainBase64, publicPem) {
  const keyObj = crypto.createPublicKey(publicPem)
  const parts = plainBase64.match(/.{1,117}/g) || []
  let allHex = ''
  for (const p of parts) {
    const bytes = Buffer.from(p, 'utf8')
    const enc = crypto.publicEncrypt({ key: keyObj, padding: crypto.constants.RSA_PKCS1_PADDING }, bytes)
    allHex += enc.toString('hex')
  }
  return hex2b64(allHex)
}

async function fetchKeys(cookie) {
  const r = await fetch(HOST + '/api/auth/keys', {
    headers: { cookie, 'user-agent': UA },
  })
  if (r.status !== 200) throw new Error('greenvideo /auth/keys 失败 status=' + r.status)
  const j = await r.json()
  if (j.code !== 200 || !j.data) throw new Error('greenvideo /auth/keys 异常: ' + (j.message || JSON.stringify(j)))
  return j.data // { k1: 公钥base64, k2: RSA加密的AES密钥base64 }
}

// ---------- 核心：解析一个视频（分享文本或 URL），返回归一化结果 ----------
async function gvExtract(input) {
  const cookie = await fetchCookie()
  const { k1, k2 } = await fetchKeys(cookie)
  const k1Pem =
    '-----BEGIN PUBLIC KEY-----\n' + k1.match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----\n'
  const aesKey = decryptByPublicKey(k2, k1Pem)
  const bodyJson = JSON.stringify({ url: input, list: undefined, pageNo: undefined, pageSize: undefined })
  const step1 = aesEncryptString(bodyJson, aesKey)
  const final = encryptLongBase64(step1, k1Pem)

  const headers = {
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    cookie,
    dnt: '1',
    kdsystem: 'GreenVideo',
    origin: HOST,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': UA,
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('greenvideo 解析超时 60s')), 60000)
  try {
    const r = await fetch(HOST + '/api/video/cnSimpleExtract', {
      method: 'POST', headers, body: final, signal: ac.signal,
    })
    const j = await r.json()
    if (j.code === 200 && j.data) return normalize(j.data, input)
    if (j.code === 530) throw new Error('greenvideo 密钥过期(530)，请重试')
    throw new Error('greenvideo 解析失败: ' + (j.message || ('code=' + j.code)))
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 归一化为 yt-dlp 风格信息结构（video.js 前端复用同一渲染） ----------
function normalize(d, input) {
  const items = (d.videoItemVoList || []).filter((v) => v && v.baseUrl)
  const byType = (t) => items.filter((v) => (v.fileType || '').toLowerCase() === t)
  const isCover = (v) => {
    const q = (v.quality || v.qualityAlias || '').toLowerCase()
    const t = (v.fileType || '').toLowerCase()
    return q.indexOf('封面') >= 0 || q.indexOf('cover') >= 0 ||
      (t === 'image') || (t === 'video' && (q.indexOf('图片') >= 0 || q.indexOf('封面') >= 0))
  }
  const vids = items.filter((v) => !isCover(v) && (v.fileType || '').toLowerCase() === 'video')
  const auds = byType('audio')
  const covers = items.filter(isCover)
  const mdTexts = items.filter((v) => /#{1,6}\s|!\[|]\(http/m.test(String(v.baseUrl || '')))

  // 直链里带 unwatermarked 即为无水印源
  const mainVid = vids[0] || {}
  const u = String(mainVid.baseUrl || '')
  const noteParts = []
  if (u.indexOf('unwatermarked') >= 0) noteParts.push('无水印')
  if (u.indexOf('watermark') >= 0) noteParts.push('含水印')
  const qAlias = mainVid.qualityAlias || mainVid.quality || ''
  if (qAlias && qAlias !== '未知清晰度' && qAlias !== '清晰度') noteParts.unshift(qAlias)

  return {
    engine: 'greenvideo',
    id: d.vid || '',
    title: d.displayTitle || d.title || '',
    uploader: d.authorName || d.author || '',
    duration: 0,
    thumbnail: covers.length ? covers[0].baseUrl : (d.coverUrl || ''),
    webpageUrl: input,
    // 对前端格式选择：格式列表只保留主视频一条（best），可选音频为独立提示
    formats: [{
      formatId: 'gv_best',
      note: noteParts.join(' ') || '单档源',
      ext: 'mp4',
      height: 0, width: 0, vcodec: 'h264', acodec: 'aac',
      filesize: mainVid.size || 0,
      _gv: true,
    }],
    // greenvideo 原始明细，供下载器用
    _gv: {
      video: mainVid,
      audios: auds,
      covers,
      markdownTexts: mdTexts,
      host: d.host || '',
      vid: d.vid || '',
    },
  }
}

module.exports = { gvExtract, gvNormalize: normalize, HOST }
