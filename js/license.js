// vh-Atelier 授权模块（插件端）
// ==========================================================================
// 账号登录式授权：邮箱 + 密码 → 服务端验证 → 签名回执存本机 → 定期心跳。
//
// 设计要点：
//   1. 凭据存 collect/license.json —— collect/ 在 skipDirs 里，在线更新不会覆盖，
//      所以授权状态能活过每次插件升级。
//   2. 回执用服务端给的 data 原字节验签（RSA-SHA256），不自行重新序列化 JSON，
//      避免「键序/空格差异导致验签失败」的经典坑。
//   3. 离线宽限：默认 7 天。断网/出差期间插件照常可用，超过宽限期才提示。
//   4. 本模块只做「判定」，不负责 UI，也不直接拦面板；拦截交给各插件自己的门。
//
// 暴露接口 window.__vhLicense：
//   state()            同步返回当前授权状态（不发网络请求）
//   isActive()         是否有有效授权
//   isGroupAllowed(g)  某工作台组是否被解锁
//   login(email, pwd, cb)  登录并激活本机
//   logout(cb)         退出（清本机凭据，服务端设备名额保留）
//   verify(cb)         主动心跳
//   openCenter()       打开网页用户中心
//   on(cb)             注册状态变化回调
(function () {
    var fs, path, os, http, https, cp;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        http = require('http');
        https = require('https');
        cp = require('child_process');
    } catch (e) {
        // 非 CEP 环境（浏览器里直接开面板调试）→ 降级为「全部放行」，不干扰调试
        window.__vhLicense = {
            available: false,
            state: function () { return { status: 'bypass', note: '非插件环境', email: '' }; },
            refresh: function () { return this.state(); },
            isActive: function () { return true; },
            isGroupAllowed: function () { return true; },
            login: function (e, p, cb) { cb(new Error('当前环境不支持授权')); },
            logout: function (cb) { cb && cb(); },
            verify: function (cb) { cb && cb(); },
            openCenter: function () {},
            on: function () {}
        };
        return;
    }

    // ---------- 插件身份 ----------
    var PLUGIN_ID = 'com.vh.subtitle';
    function extRoot() {
        try {
            if (typeof CSInterface !== 'undefined') {
                var r = new CSInterface().getSystemPath('extension');
                if (r && fs.existsSync(r)) return r;
            }
        } catch (e) {}
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (e) {}
        return '';
    }
    var ROOT = extRoot();
    var CFG_FILE = ROOT ? path.join(ROOT, 'license.json') : '';
    var CFG_SAMPLE = ROOT ? path.join(ROOT, 'license.example.json') : '';
    var DATA_DIR = ROOT ? path.join(ROOT, 'collect') : '';
    var CRED_FILE = DATA_DIR ? path.join(DATA_DIR, 'license.json') : '';
    var VER_FILE = ROOT ? path.join(ROOT, 'version.json') : '';

    // 从 manifest 读真实 BundleId（防止 id 写错导致服务端认不出插件）
    try {
        var mp = ROOT ? path.join(ROOT, 'CSXS', 'manifest.xml') : '';
        if (mp && fs.existsSync(mp)) {
            var mm = fs.readFileSync(mp, 'utf8').match(/ExtensionBundleId="([^"]+)"/);
            if (mm) PLUGIN_ID = mm[1];
        }
    } catch (e) {}

    // ---------- 授权服务地址 ----------
    var DEFAULT_BASE = 'http://47.122.108.231:17894';
    function base() {
        var c = readJson(CFG_FILE) || {};
        return String(c.base || DEFAULT_BASE).replace(/\/+$/, '');
    }

    // ---------- 内置公钥（与服务端 data/keys.json 一致）----------
    // 公钥是公开信息，放代码里不构成泄露；它只用于验签，无法伪造回执。
    // 注意：若服务端 data/keys.json 被删，会重新生成密钥，届时需同步更新这里。
    var PUBKEY = [
        '-----BEGIN PUBLIC KEY-----',
        'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyZY5iKKucmrJmj98pIJn',
        'a12qUUUb9MJ9JpwpP+A7CyTsm/KRtov9++HqeKLo+5I7xnBuxET4SH4HfNravC8s',
        '9MiODFGWGJNEM/xiS/uOlANymL8uP1nOzCcEZ8huVPzOUUuIcPb+SODWoPclj79Q',
        'NmVzXINnhKTVj+jZVD27hhe+hP258H3Gdk4qm7We4zRVX1HnjimweBhWWfrwCKX8',
        'cRxlEPPawtEm3wXLeBnVw105UDG3FlC3xpO3VspQr8/HdTwD/csEwwO4kVZRAmOW',
        'ocQe0yiNz9/ap7VlO96vsafEJNj3gW9W4hoR82raFbCECgpNIsehheXCZ/Rc2Qff',
        'qwIDAQAB',
        '-----END PUBLIC KEY-----'
    ].join('\n');

    // ---------- 工具 ----------
    function readJson(p) {
        try {
            if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (e) {}
        return null;
    }
    // 原子写：先写临时文件再改名。
    // 临时文件名带 pid + 递增序号：并发写（例如连点两次登录、登录与心跳同时落盘）
    // 不会互相踩。早期版本共用同一个 .tmp，先改名的成功、后改名的会 ENOENT 误报失败。
    var _writeSeq = 0;
    var _lastWriteError = '';
    function writeJson(p, obj) {
        var txt = JSON.stringify(obj, null, 2);
        var pid = (typeof process !== 'undefined' && process.pid) ? process.pid : 'x';
        var tmp = p + '.' + pid + '.' + (++_writeSeq) + '.tmp';
        try {
            var d = path.dirname(p);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(tmp, txt, 'utf8');
            fs.renameSync(tmp, p);
            _lastWriteError = '';
            return true;
        } catch (e) {
            // 改名失败（临时文件被占、目标被锁等）时退回直接写目标：
            // 牺牲原子性换可用性，凭据文件很小，撕裂概率极低。
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
            try {
                fs.writeFileSync(p, txt, 'utf8');
                _lastWriteError = '';
                return true;
            } catch (e3) {
                _lastWriteError = (e3 && e3.message) ? e3.message : String(e3);
                return false;
            }
        }
    }

    // ---------- 机器码 ----------
    // 重要：此函数会调 execSync（读注册表），是同步阻塞操作（实测 30ms 左右）。
    // 绝不能放在 computeState 这类高频路径上，否则每次刷新状态都阻塞一次。
    // 结果缓存到 collect/device.id，只需算一次。
    function registryMachineGuid() {
        try {
            var out = cp.execSync(
                'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
                { encoding: 'utf8', windowsHide: true, timeout: 5000 }
            );
            var m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{8,})/);
            if (m) return m[1].trim();
        } catch (e) {}
        return '';
    }
    function primaryMac() {
        // 收集所有非内部 MAC，排序后取最小。
        // 为什么不用「第一个遇到的」：机器上常有多个虚拟网卡（VMware/Tailscale/VPN），
        // 它们的枚举顺序会随软件安装、启停而变，取第一个会导致设备码漂移，
        // 表现为「同一台电脑被判成新设备」，白吃一个设备名额。
        // 取排序最小者与顺序无关，结果稳定。
        try {
            var ifs = os.networkInterfaces();
            var all = [];
            Object.keys(ifs).forEach(function (name) {
                (ifs[name] || []).forEach(function (a) {
                    if (!a.internal && a.mac && a.mac !== '00:00:00:00:00:00') all.push(a.mac.toLowerCase());
                });
            });
            all.sort();
            return all[0] || '';
        } catch (e) {}
        return '';
    }
    function cpuModel() {
        try {
            var c = os.cpus();
            return (c && c[0] && c[0].model) ? String(c[0].model).trim() : '';
        } catch (e) {}
        return '';
    }

    var _deviceId = '';
    function computeDeviceId() {
        try {
            var crypto = require('crypto');
            var seed = [registryMachineGuid() || 'noguid', cpuModel(), primaryMac()].join('|');
            return crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32);
        } catch (e) {
            return 'unknown-device';
        }
    }

    function deviceId() {
        if (_deviceId) return _deviceId;
        // 缓存优先：避免每次刷新状态都去读注册表（那会卡界面）
        var cacheFile = DATA_DIR ? path.join(DATA_DIR, 'device.id') : '';
        if (cacheFile) {
            try {
                if (fs.existsSync(cacheFile)) {
                    var cached = String(fs.readFileSync(cacheFile, 'utf8')).trim();
                    if (/^[0-9a-f]{32}$/.test(cached)) { _deviceId = cached; return _deviceId; }
                }
            } catch (e) {}
        }
        _deviceId = computeDeviceId();
        // 写缓存（失败不影响功能）
        if (cacheFile && _deviceId !== 'unknown-device') {
            try {
                if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
                fs.writeFileSync(cacheFile, _deviceId, 'utf8');
            } catch (e) {}
        }
        return _deviceId;
    }

    function deviceName() {
        try { return os.hostname(); } catch (e) { return '未知设备'; }
    }

    // ---------- HTTP ----------
    function parseUrl(u) {
        try {
            var x = new URL(u);
            return {
                protocol: x.protocol,
                hostname: x.hostname,
                port: x.port || (x.protocol === 'https:' ? '443' : '80'),
                path: (x.pathname || '/') + (x.search || '')
            };
        } catch (e) { return null; }
    }

    function request(method, fullUrl, body, timeout, cb) {
        var u = parseUrl(fullUrl);
        if (!u) return cb(new Error('授权服务器地址无效：' + fullUrl));
        var mod = (u.protocol === 'https:') ? https : http;
        var data = body ? JSON.stringify(body) : '';
        var opts = {
            hostname: u.hostname,
            port: u.port,
            path: u.path,
            method: method,
            headers: {
                'User-Agent': 'vh-Atelier-license',
                'Content-Type': 'application/json'
            },
            timeout: timeout || 15000
        };
        if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);

        var req = mod.request(opts, function (res) {
            var buf = '';
            res.on('data', function (d) { buf += d.toString('utf8'); });
            res.on('end', function () {
                var j = null;
                try { j = JSON.parse(buf); } catch (e) {}
                if (res.statusCode >= 200 && res.statusCode < 300 && j && j.ok) return cb(null, j);
                var err = new Error((j && j.error) || ('HTTP ' + res.statusCode));
                err.status = res.statusCode;
                cb(err);
            });
        });
        req.on('error', function (e) {
            cb(new Error('连不上授权服务器（' + e.message + '），地址 ' + u.hostname + ':' + u.port));
        });
        req.on('timeout', function () {
            try { req.destroy(); } catch (e) {}
            cb(new Error('授权服务器响应超时'));
        });
        if (data) req.write(data);
        req.end();
    }

    // ---------- 回执验签 ----------
    var _pubKeyCache = null;
    function publicKey() {
        // createPublicKey 有解析开销（数毫秒），而状态每次刷新都要验签，缓存起来
        if (!_pubKeyCache) {
            _pubKeyCache = require('crypto').createPublicKey(PUBKEY);
        }
        return _pubKeyCache;
    }

    function verifyReceipt(receipt) {
        if (!receipt || !receipt.sig || !receipt.data) return false;
        try {
            var crypto = require('crypto');
            var pub = publicKey();
            var raw = Buffer.from(receipt.data, 'base64');
            var sig = Buffer.from(receipt.sig, 'base64');
            var alg = String(receipt.alg || 'rsa-sha256');
            if (alg.indexOf('rsa') === 0) {
                var v = crypto.createVerify('sha256');
                v.update(raw); v.end();
                return v.verify(pub, sig);
            }
            // 兼容早期 ed25519 回执
            return crypto.verify(null, raw, pub, sig);
        } catch (e) {
            return false;
        }
    }

    // ---------- 状态机 ----------
    // unbound 未登录 / active 有效 / expired 到期 / revoked 吊销 / paused 暂停
    // mismatch 机器码不符 / invalid 回执无效 / grace_over 超离线宽限 / bypass 非插件环境
    var _state = null;
    var _listeners = [];
    var _emitting = false;
    var HEARTBEAT_MS = 12 * 3600 * 1000;

    function emit() {
        // 重入保护（重要）：监听器内部若再触发 refresh/emit，直接忽略。
        // 否则会形成 refresh → emit → 监听器 → refresh 的无界递归。
        // 危险之处在于下面那个 try/catch 会吞掉栈溢出错误，
        // 表现为插件「卡很久」而不报错，很难定位。
        if (_emitting) return;
        _emitting = true;
        try {
            for (var i = 0; i < _listeners.length; i++) {
                try { _listeners[i](_state); } catch (e) {}
            }
        } finally {
            _emitting = false;
        }
    }

    function computeState() {
        var cred = readJson(CRED_FILE);
        // 设备码：优先用凭据里已绑定的值，避免在状态判定路径上触发注册表读取
        var dev = (cred && cred.receipt && cred.receipt.deviceId) ? cred.receipt.deviceId : deviceId();
        var base_ = { deviceId: dev, deviceName: deviceName(), email: '', plan: '', expiresAt: 0, plugins: [], note: '' };
        if (!cred || !cred.token || !cred.receipt) {
            return mix(base_, 'unbound', '尚未登录');
        }
        var r = cred.receipt;
        var now = Date.now();
        base_.email = r.email || cred.email || '';
        base_.plan = r.plan || '';
        base_.expiresAt = r.expiresAt || 0;
        base_.plugins = r.plugins || [];
        base_.boundDeviceId = r.deviceId || '';
        base_.lastCheck = cred.lastCheck || 0;
        base_.graceDays = r.offlineGraceDays || 7;

        if (r.deviceId && r.deviceId !== deviceId()) {
            return mix(base_, 'mismatch', '本机与授权绑定的设备不一致，请重新登录');
        }
        if (!verifyReceipt(cred.receipt)) {
            return mix(base_, 'invalid', '授权回执校验失败（可能被篡改）');
        }
        if (r.state === 'revoked') return mix(base_, 'revoked', '授权已被吊销');
        if (r.state === 'paused') return mix(base_, 'paused', '授权已暂停');
        if (r.expiresAt && r.expiresAt < now) return mix(base_, 'expired', '授权已到期');

        var graceMs = (base_.graceDays || 7) * 86400000;
        var last = cred.lastCheck || cred.issuedAt || 0;
        if (!last || (now - last) > graceMs) {
            return mix(base_, 'grace_over', '已超过 ' + (base_.graceDays || 7) + ' 天未联网验证，请联网后重试');
        }
        if ((now - last) > graceMs * 0.7) {
            base_.note = '离线时间较长，建议联网验证';
        }
        return mix(base_, 'active', base_.note);
    }

    function mix(o, status, note) {
        o.status = status;
        o.note = note || '';
        o.loggedIn = !!o.email;
        return o;
    }

    function refresh() {
        _state = computeState();
        emit();
        return _state;
    }

    function isActiveStatus(s) {
        return s === 'active' || s === 'bypass';
    }

    // ---------- 登录 / 退出 ----------
    function login(email, password, cb) {
        var b = base();
        var payload = {
            email: String(email || '').trim(),
            password: String(password || ''),
            deviceId: deviceId(),
            deviceName: deviceName(),
            plugin: PLUGIN_ID
        };
        if (!payload.email || !payload.password) return cb(new Error('请输入邮箱和密码'));

        request('POST', b + '/api/auth/login', payload, 20000, function (err, j) {
            if (err) return cb(err);
            var cred = {
                base: b,
                token: j.token,
                email: (j.receipt && j.receipt.email) || payload.email,
                issuedAt: Date.now(),
                lastCheck: Date.now(),
                receipt: j.receipt
            };
            if (!writeJson(CRED_FILE, cred)) {
                // 写入报错时回读一次：并发场景下可能被另一次写抢先完成，
                // 只要磁盘上已是本次凭据就按成功处理，避免误报「写入失败」。
                var back = readJson(CRED_FILE);
                if (!(back && back.token && back.token === cred.token)) {
                    return cb(new Error('授权信息写入失败：' + (_lastWriteError || '未知原因') +
                        '（目标目录 ' + CRED_FILE + '）'));
                }
            }
            // 写入后立刻验一次回执，确保链路可信
            refresh();
            if (_state.status !== 'active') {
                return cb(new Error('授权校验未通过：' + _state.note), _state);
            }
            cb(null, _state);
        });
    }

    function logout(cb) {
        try {
            if (CRED_FILE && fs.existsSync(CRED_FILE)) fs.unlinkSync(CRED_FILE);
        } catch (e) {}
        refresh();
        cb && cb(null, _state);
    }

    // ---------- 心跳 ----------
    var _verifying = false;
    function verify(cb) {
        cb = cb || function () {};
        if (_verifying) return cb(null, _state || refresh());
        var cred = readJson(CRED_FILE);
        if (!cred || !cred.token) return cb(new Error('尚未登录'), refresh());

        _verifying = true;
        request('POST', base() + '/api/license/verify', {
            token: cred.token,
            deviceId: deviceId(),
            deviceName: deviceName(),
            plugin: PLUGIN_ID
        }, 15000, function (err, j) {
            _verifying = false;
            if (!err && j && j.receipt) {
                cred.lastCheck = Date.now();
                cred.receipt = j.receipt;
                cred.email = j.receipt.email || cred.email;
                delete cred.lastServerError;
                writeJson(CRED_FILE, cred);
                refresh();
                return cb(null, _state);
            }
            if (err && (err.status === 401 || err.status === 403)) {
                // 服务端明确拒绝：把状态落盘，让下次启动也能立刻反映
                var c2 = readJson(CRED_FILE);
                if (c2 && c2.receipt) {
                    var msg = err.message || '';
                    if (msg.indexOf('到期') >= 0) c2.receipt.state = 'expired';
                    else if (msg.indexOf('吊销') >= 0) c2.receipt.state = 'revoked';
                    else if (msg.indexOf('暂停') >= 0) c2.receipt.state = 'paused';
                    else if (msg.indexOf('解绑') >= 0) c2.receipt.state = 'revoked';
                    c2.lastServerError = msg;
                    c2.lastServerErrorAt = Date.now();
                    writeJson(CRED_FILE, c2);
                }
                refresh();
                return cb(err, _state);
            }
            // 网络类错误：保留凭据，交给离线宽限兜底
            refresh();
            cb(err, _state);
        });
    }

    var _timer = null;
    function startHeartbeat() {
        if (_timer) return;
        _timer = setInterval(function () {
            var st = refresh();
            if (st.loggedIn) verify(function () {});
        }, HEARTBEAT_MS);
    }

    function openCenter() {
        var u = base() + '/';
        try {
            if (typeof CSInterface !== 'undefined') {
                var cs = new CSInterface();
                if (cs.openURLInDefaultBrowser) return cs.openURLInDefaultBrowser(u);
            }
        } catch (e) {}
        try { cp.exec('start "" "' + u + '"'); } catch (e) {}
    }

    // ---------- 组级判定（A 插件锁超分/声音/交付）----------
    // 空数组 = 不限制（全部解锁）；否则只有列出的组需要授权。
    function isGroupAllowed(group) {
        var st = _state || (_state = computeState());
        var cfg = readJson(CFG_FILE) || {};
        var gated = Array.isArray(cfg.gatedGroups) ? cfg.gatedGroups : null;
        if (gated && gated.length && gated.indexOf(group) < 0) return true;  // 不在受限名单
        if (!isActiveStatus(st.status)) return false;
        if (st.plugins && st.plugins.length && st.plugins.indexOf(PLUGIN_ID) < 0) return false;
        return true;
    }

    // ---------- 初始化 ----------
    // 清理历史遗留的 .tmp（早期版本并发写可能留下的残片）
    try {
        if (DATA_DIR && fs.existsSync(DATA_DIR)) {
            var leftovers = fs.readdirSync(DATA_DIR);
            for (var li = 0; li < leftovers.length; li++) {
                var lf = leftovers[li];
                if (/^license\.json.*\.tmp$/.test(lf)) {
                    try { fs.unlinkSync(path.join(DATA_DIR, lf)); } catch (e) {}
                }
            }
        }
    } catch (e) {}

    refresh();
    startHeartbeat();
    // 启动后尽快心跳一次：
    // 若上次使用已超过离线宽限，这个请求能把状态拉回 active，
    // 否则用户会看到一段“需联网验证”的锁定，所以延迟不宜长。
    setTimeout(function () {
        var st = refresh();
        if (st.loggedIn) verify(function () {});
    }, 1500);

    window.__vhLicense = {
        available: true,
        pluginId: PLUGIN_ID,
        deviceId: deviceId,
        deviceName: deviceName,
        base: base,
        state: function () { return _state || (_state = computeState()); },
        refresh: refresh,
        isActive: function () { return isActiveStatus((_state || computeState()).status); },
        isGroupAllowed: isGroupAllowed,
        login: login,
        logout: logout,
        verify: verify,
        openCenter: openCenter,
        credFile: function () { return CRED_FILE; },
        cfgFile: function () { return CFG_FILE; },
        lastWriteError: function () { return _lastWriteError; },
        on: function (cb) { if (typeof cb === 'function') _listeners.push(cb); }
    };
})();
