// vh-Atelier · Breeze 语音合成本地服务
// 端口 17892（ncm 17890 / 扒歌 17891 / 媒体代理 17897，互不干扰）
//
// 职责：
//   1. 托管中文界面（breeze/ui/index.html）
//   2. 代理 /v1/* 到引擎
//   3. 管理引擎进程（启动/停止/重启/状态）
//   4. 首次使用时在线下载模型（约 2.3 GB）
//
// 零 npm 依赖，只用 Node 标准库。
'use strict'

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const VERSION = '1.0.0'
const PORT = 17892
const ENGINE_PORT = 17893

const ROOT = __dirname
const EXT_ROOT = path.resolve(__dirname, '..')
const ENGINE_DIR = path.join(ROOT, 'engine')
const ENGINE_EXE = path.join(ENGINE_DIR, 'breeze-server.exe')
const UI_DIR = path.join(ROOT, 'ui')
const MODEL_DIR = path.join(ROOT, 'models')
const OUTPUT_DIR = path.join(ROOT, 'output')
const MODEL_FILE = path.join(MODEL_DIR, 'breeze-tts-2-q4_k-dd2.gguf')
const DL_STATE = path.join(MODEL_DIR, '_download.json')
const SIZE_STATE = path.join(MODEL_DIR, '_model_size.txt')
const REF_DIR = path.join(ROOT, 'refs')
const REF_META = path.join(REF_DIR, 'current.json')

// 官方权重仓库（HoppouAI/Breeze-TTS-2.cpp，与引擎二进制配套）
const MODEL_URLS = [
  'https://hf-mirror.com/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q4_k-dd2.gguf',
  'https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/breeze-tts-2-q4_k-dd2.gguf',
]
const MODEL_SIZE = 2460000000        // 参考值，实际进度以响应头 Content-Length 为准

// 模型完整大小（下载成功后记录，用于完整性校验）
let MODEL_EXPECT_SIZE = 0
try {
  const s = fs.readFileSync(SIZE_STATE, 'utf8').trim()
  const n = parseInt(s, 10)
  if (isFinite(n) && n > 0) MODEL_EXPECT_SIZE = n
} catch (e) {}

for (const d of [MODEL_DIR, OUTPUT_DIR, REF_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }) } catch (e) {}
}

// ───────────────────────── 工具 ─────────────────────────
function send(res, code, body, ctype, extra) {
  if (typeof body === 'string') body = Buffer.from(body, 'utf8')
  const h = {
    'Content-Type': ctype || 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }
  if (extra) Object.assign(h, extra)
  try {
    res.writeHead(code, h)
    res.end(body)
  } catch (e) {}
}

function sendJson(res, obj, code) {
  send(res, code || 200, JSON.stringify(obj), 'application/json; charset=utf-8')
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > (limit || 200 * 1024 * 1024)) { req.destroy(); resolve(null); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

// 注意：引擎是本地 http，不能用 https 模块请求
function httpGetJson(url, timeout) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      timeout: timeout || 3000,
      headers: { 'Accept': 'application/json' },
    }, res => {
      let s = ''
      res.setEncoding('utf8')
      res.on('data', d => (s += d))
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(s) }) }
        catch (e) { resolve({ code: res.statusCode, body: null }) }
      })
    })
    req.on('error', () => resolve({ code: 0, body: null }))
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, body: null }) })
  })
}

// ───────────────────────── 引擎管理 ─────────────────────────
const engine = {
  proc: null,
  booting: false,
  lastError: '',
  startedAt: 0,

  isHealthy() {
    return httpGetJson('http://127.0.0.1:' + ENGINE_PORT + '/health', 2000)
      .then(r => r.code === 200 && r.body && r.body.status === 'ok')
      .catch(() => false)
  },

  modelReady() {
    try {
      const st = fs.statSync(MODEL_FILE)
      if (st.size < 1024 * 1024 * 1024) return false

      // 1) 魔数校验
      const fd = fs.openSync(MODEL_FILE, 'r')
      const buf = Buffer.alloc(4)
      fs.readSync(fd, buf, 0, 4, 0)
      fs.closeSync(fd)
      if (buf.toString('ascii') !== 'GGUF') return false

      // 2) 完整性校验：有已知总大小时必须匹配
      //    没下完的文件魔数也对，所以这一步必须有
      if (MODEL_EXPECT_SIZE > 0) {
        return st.size >= MODEL_EXPECT_SIZE * 0.995 && st.size <= MODEL_EXPECT_SIZE * 1.005
      }

      // 3) 未知大小：至少要比"明显不完整"大
      return st.size > 1500 * 1024 * 1024
    } catch (e) { return false }
  },

  async start() {
    if (await this.isHealthy()) {
      return { ok: true, already: true, msg: '引擎已在运行' }
    }
    if (this.proc && this.proc.exitCode === null) {
      return { ok: true, already: true, msg: '引擎启动中' }
    }
    if (!fs.existsSync(ENGINE_EXE)) {
      return { ok: false, msg: '引擎程序缺失：' + ENGINE_EXE }
    }
    if (!this.modelReady()) {
      return { ok: false, needModel: true, msg: '语音模型尚未下载' }
    }

    this.booting = true
    this.lastError = ''
    try {
      this.proc = spawn(ENGINE_EXE,
        [MODEL_FILE, '--port', String(ENGINE_PORT)],
        {
          cwd: ENGINE_DIR,
          windowsHide: true,
          stdio: 'ignore',
        })
      this.startedAt = Date.now()
      this.proc.on('exit', (code) => {
        this.lastError = '引擎退出（code=' + code + '）'
        this.proc = null
        this.booting = false
      })
    } catch (e) {
      this.booting = false
      this.lastError = String(e.message || e)
      return { ok: false, msg: '启动失败：' + e.message }
    }

    // 等待就绪（最多 120 秒）
    const t0 = Date.now()
    while (Date.now() - t0 < 120000) {
      if (await this.isHealthy()) {
        this.booting = false
        const secs = ((Date.now() - t0) / 1000).toFixed(1)
        return { ok: true, msg: '引擎已启动（' + secs + ' 秒）', secs: Number(secs) }
      }
      if (this.proc && this.proc.exitCode !== null) {
        this.booting = false
        return { ok: false, msg: '引擎启动后立即退出，可能是显存不足' }
      }
      await new Promise(r => setTimeout(r, 800))
    }
    this.booting = false
    return { ok: false, msg: '引擎启动超时（120 秒）' }
  },

  async stop() {
    const p = this.proc
    this.proc = null
    this.booting = false
    if (p && p.pid) {
      try {
        require('child_process').execFileSync('taskkill',
          ['/PID', String(p.pid), '/T', '/F'],
          { windowsHide: true, timeout: 10000 })
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1500))
    }
    if (await this.isHealthy()) {
      return { ok: false, msg: '停止失败，引擎仍在响应' }
    }
    return { ok: true, msg: p ? '引擎已停止' : '引擎本来就没在运行' }
  },

  async restart() {
    const r = await this.stop()
    if (!r.ok) return r
    await new Promise(res => setTimeout(res, 800))
    return this.start()
  },

  async status() {
    const healthy = await this.isHealthy()
    return {
      running: !!((this.proc && this.proc.exitCode === null) || healthy),
      healthy,
      booting: this.booting,
      port: ENGINE_PORT,
      model_ready: this.modelReady(),
      last_error: this.lastError,
      uptime: (this.proc && this.startedAt) ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
    }
  },
}

// ───────────────────────── 模型下载 ─────────────────────────
const download = {
  active: false,
  done: 0,
  total: MODEL_SIZE,
  percent: 0,
  speed: 0,
  error: '',
  urlIndex: 0,
  cancelFlag: false,
}

function loadDownloadState() {
  try {
    const j = JSON.parse(fs.readFileSync(DL_STATE, 'utf8'))
    if (j && typeof j.done === 'number') download.done = j.done
  } catch (e) {}
}

function saveDownloadState() {
  try {
    fs.writeFileSync(DL_STATE, JSON.stringify({ done: download.done, at: Date.now() }), 'utf8')
  } catch (e) {}
}

function startDownload() {
  if (download.active) return { ok: true, msg: '下载已在进行中' }
  if (engine.modelReady()) return { ok: true, msg: '模型已就绪' }

  download.active = true
  download.error = ''
  download.cancelFlag = false
  download.urlIndex = 0

  const run = (idx) => {
    if (download.cancelFlag) {
      download.active = false
      return
    }
    if (idx >= MODEL_URLS.length) {
      download.active = false
      download.error = '所有下载源均失败'
      return
    }

    const url = MODEL_URLS[idx]
    let startByte = 0
    try { startByte = fs.statSync(MODEL_FILE).size } catch (e) { startByte = 0 }

    const u = new URL(url)
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Range': 'bytes=' + startByte + '-',
      },
      timeout: 60000,
    }

    const req = https.get(opts, res => {
      // 跟随重定向（301/302/303/307/308 都要处理）
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0) {
        res.resume()
        const loc = res.headers.location
        if (loc) {
          const nextUrl = loc.startsWith('http') ? loc : (u.protocol + '//' + u.hostname + loc)
          console.log('[breeze] 重定向 -> ' + nextUrl.slice(0, 90))
          // 把重定向目标插到当前索引之后，优先尝试
          MODEL_URLS.splice(idx + 1, 0, nextUrl)
        }
        run(idx + 1)
        return
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume()
        download.error = 'HTTP ' + res.statusCode
        setTimeout(() => run(idx + 1), 1000)
        return
      }

      // 精确总大小：优先 content-range（续传时），其次 content-length
      let total = 0
      const cr = res.headers['content-range']
      if (cr) {
        const m = /\/(\d+)$/.exec(cr)          // "bytes 100-999/12345"
        if (m) total = parseInt(m[1], 10)
      }
      if (!total) {
        const cl = parseInt(res.headers['content-length'] || '0', 10)
        if (cl > 0) total = startByte + cl
      }
      if (total > 0) download.total = total

      const ws = fs.createWriteStream(MODEL_FILE, { flags: startByte > 0 ? 'a' : 'w' })
      let lastTick = Date.now()
      let lastBytes = download.done

      res.on('data', chunk => {
        if (download.cancelFlag) { req.destroy(); ws.end(); return }
        download.done += chunk.length
        if (download.total > 0) {
          download.percent = Math.min(99.9, (download.done / download.total) * 100)
        }

        const now = Date.now()
        if (now - lastTick > 800) {
          download.speed = (download.done - lastBytes) / ((now - lastTick) / 1000)
          lastTick = now
          lastBytes = download.done
          saveDownloadState()
        }
      })

      res.pipe(ws)

      ws.on('finish', () => {
        download.active = false
        // 以实际文件大小与总大小的比对判断完成
        let actual = 0
        try { actual = fs.statSync(MODEL_FILE).size } catch (e) {}
        const finished = download.total > 0 ? (actual >= download.total * 0.995) : (actual > 100 * 1024 * 1024)
        if (finished) {
          download.percent = 100
          download.done = actual
          MODEL_EXPECT_SIZE = actual
          try { fs.writeFileSync(SIZE_STATE, String(actual), 'utf8') } catch (e) {}
          saveDownloadState()
        } else {
          download.error = '文件不完整，重试中'
          setTimeout(() => { download.active = true; run(idx) }, 1500)
        }
      })

      ws.on('error', e => {
        download.active = false
        download.error = '写入失败：' + e.message
      })
    })

    req.on('error', e => {
      download.error = e.message
      setTimeout(() => run(idx + 1), 1200)
    })
    req.on('timeout', () => {
      req.destroy()
      download.error = '下载超时，重试中'
      setTimeout(() => { download.active = true; run(idx) }, 1500)
    })
  }

  loadDownloadState()
  run(0)
  return { ok: true, msg: '开始下载' }
}

// ───────────────────────── HTTP 路由 ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function proxy(req, res, body) {
  const opts = {
    hostname: '127.0.0.1',
    port: ENGINE_PORT,
    path: req.url,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + ENGINE_PORT }),
    timeout: 900000,
  }
  const p = http.request(opts, r => {
    const h = { 'Content-Type': r.headers['content-type'] || 'application/octet-stream' }
    if (r.headers['x-sample-rate']) h['X-Sample-Rate'] = r.headers['x-sample-rate']
    res.writeHead(r.statusCode, h)
    r.pipe(res)
  })
  p.on('error', e => sendJson(res, { error: '引擎未响应：' + e.message }, 502))
  p.on('timeout', () => { p.destroy(); sendJson(res, { error: '引擎响应超时' }, 504) })
  if (body && body.length) p.write(body)
  p.end()
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]

  // ── 界面 ──
  if (url === '/' || url === '/index.html') {
    const p = path.join(UI_DIR, 'index.html')
    if (fs.existsSync(p)) return send(res, 200, fs.readFileSync(p), MIME['.html'])
    return send(res, 404, 'UI not found')
  }

  // ── 引擎控制 ──
  if (url === '/api/status') {
    return sendJson(res, await engine.status())
  }
  if (url === '/api/start' && req.method === 'POST') {
    return sendJson(res, await engine.start())
  }
  if (url === '/api/stop' && req.method === 'POST') {
    return sendJson(res, await engine.stop())
  }
  if (url === '/api/restart' && req.method === 'POST') {
    return sendJson(res, await engine.restart())
  }

  // ── 模型下载 ──
  if (url === '/api/model/status') {
    return sendJson(res, {
      ready: engine.modelReady(),
      active: download.active,
      done: download.done,
      total: download.total,
      percent: Math.round(download.percent * 10) / 10,
      speed: Math.round(download.speed / 1024 / 1024 * 10) / 10,
      error: download.error,
    })
  }
  if (url === '/api/model/download' && req.method === 'POST') {
    return sendJson(res, startDownload())
  }

  // ── 外部传入的参考音频（供插件从时间轴取材后自动填入）──
  if (url === '/api/ref/upload' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body || body.length < 1000) {
      return sendJson(res, { ok: false, msg: '音频数据为空' }, 400)
    }
    try {
      const name = (req.headers['x-ref-name'] || 'ref.wav').toString().replace(/[^\w.\-]/g, '_')
      const file = path.join(REF_DIR, name)
      fs.writeFileSync(file, body)
      const meta = {
        name: name,
        file: file,
        size: body.length,
        at: Date.now(),
        // 可选：附带抓取时填的逐字稿
        ref_text: decodeURIComponent(req.headers['x-ref-text'] || ''),
      }
      fs.writeFileSync(REF_META, JSON.stringify(meta), 'utf8')
      console.log('[breeze] 收到参考音频: ' + name + ' (' + (body.length / 1024).toFixed(0) + ' KB)')
      return sendJson(res, { ok: true, name: name, size: body.length })
    } catch (e) {
      return sendJson(res, { ok: false, msg: String(e.message || e) }, 500)
    }
  }

  if (url === '/api/ref/latest') {
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(REF_META, 'utf8')) } catch (e) {}
    if (!meta) return sendJson(res, { ok: false, msg: '还没有外部传入的参考音频' })
    // 带一个版本号，前端据此判断是否是新文件
    return sendJson(res, { ok: true, meta: meta, url: '/api/ref/audio?v=' + meta.at })
  }

  if (url.startsWith('/api/ref/audio')) {
    let meta = null
    try { meta = JSON.parse(fs.readFileSync(REF_META, 'utf8')) } catch (e) {}
    if (!meta || !fs.existsSync(meta.file)) return send(res, 404, 'not found')
    return send(res, 200, fs.readFileSync(meta.file), 'audio/wav')
  }

  // ── 把生成的音频落盘，供插件插入时间轴 ──
  if (url === '/api/save-audio' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body || body.length < 1000) {
      return sendJson(res, { ok: false, msg: '音频数据为空' }, 400)
    }
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const name = 'gen_' + ts + '.wav'
      const file = path.join(OUTPUT_DIR, name)
      // 收到的可能是不带头的裸 PCM——直接写盘会得到 ffmpeg 无法识别的文件。
      // 检测到没有 RIFF 头就补一个标准 44 字节 WAV 头（24000Hz / 单声道 / 16bit）。
      let outBuf = body
      if (!(body.length >= 12 && body.slice(0, 4).toString('ascii') === 'RIFF')) {
        const hdr = Buffer.alloc(44)
        const dataLen = body.length
        hdr.write('RIFF', 0, 'ascii')
        hdr.writeUInt32LE(36 + dataLen, 4)
        hdr.write('WAVE', 8, 'ascii')
        hdr.write('fmt ', 12, 'ascii')
        hdr.writeUInt32LE(16, 16)
        hdr.writeUInt16LE(1, 20)
        hdr.writeUInt16LE(1, 22)
        hdr.writeUInt32LE(24000, 24)
        hdr.writeUInt32LE(24000 * 2, 28)
        hdr.writeUInt16LE(2, 32)
        hdr.writeUInt16LE(16, 34)
        hdr.write('data', 36, 'ascii')
        hdr.writeUInt32LE(dataLen, 40)
        outBuf = Buffer.concat([hdr, body])
        console.log('[breeze] 检测到裸 PCM，已补 WAV 头')
      }
      fs.writeFileSync(file, outBuf)
      console.log('[breeze] 音频已保存: ' + name + ' (' + (outBuf.length / 1024).toFixed(0) + ' KB)')
      return sendJson(res, { ok: true, file: file, name: name, size: outBuf.length })
    } catch (e) {
      return sendJson(res, { ok: false, msg: String(e.message || e) }, 500)
    }
  }

  // ── 参考音频的逐字稿（由插件侧 whisper 识别后写入）──
  if (url === '/api/ref/text' && req.method === 'POST') {
    const body = await readBody(req)
    let payload = null
    try { payload = JSON.parse((body || Buffer.alloc(0)).toString('utf8')) } catch (e) {}
    if (!payload) return sendJson(res, { ok: false, msg: '请求体解析失败' }, 400)

    let meta = null
    try { meta = JSON.parse(fs.readFileSync(REF_META, 'utf8')) } catch (e) {}
    if (!meta) return sendJson(res, { ok: false, msg: '还没有参考音频' }, 400)

    meta.ref_text = String(payload.text || '')
    meta.text_at = Date.now()
    try { fs.writeFileSync(REF_META, JSON.stringify(meta), 'utf8') } catch (e) {
      return sendJson(res, { ok: false, msg: '写入失败' }, 500)
    }
    console.log('[breeze] 收到逐字稿 (' + meta.ref_text.length + ' 字)')
    return sendJson(res, { ok: true, len: meta.ref_text.length })
  }

  if (url === '/api/ref/clear' && req.method === 'POST') {
    try { fs.unlinkSync(REF_META) } catch (e) {}
    return sendJson(res, { ok: true })
  }

  // ── 健康检查 / 引擎 API ──
  if (url === '/health') {
    const h = await engine.isHealthy()
    return sendJson(res, {
      status: h ? 'ok' : 'down',
      sample_rate: 24000,
      engine_port: ENGINE_PORT,
      model_ready: engine.modelReady(),
    })
  }
  if (url.startsWith('/v1/')) {
    if (!(await engine.isHealthy())) {
      return sendJson(res, { error: '引擎未运行' }, 503)
    }
    const body = (req.method === 'POST' || req.method === 'PATCH') ? await readBody(req) : null
    return proxy(req, res, body)
  }

  // ── 静态资源 ──
  const rel = url.replace(/^\//, '')
  const p = path.join(UI_DIR, rel.replace(/\//g, path.sep))
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    const ext = path.extname(p).toLowerCase()
    return send(res, 200, fs.readFileSync(p), MIME[ext] || 'application/octet-stream')
  }

  send(res, 404, 'Not found')
})

server.on('error', e => {
  console.error('[breeze] 服务启动失败：' + e.message)
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[breeze] 服务已启动 http://127.0.0.1:' + PORT)
  // 模型已就绪则自动预热引擎
  if (engine.modelReady()) {
    engine.start().then(r => console.log('[breeze] ' + r.msg))
  }
})
