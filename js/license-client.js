// vh-Atelier 授权客户端
//
// 设计：
//   · 账号登录（邮箱+密码）或 卡密激活，两种都支持
//   · 一次登录后 token 存本地，之后走心跳校验，不用反复输密码
//   · 服务器返回的授权回执带 RSA 签名，本地验签防篡改
//   · 断网时按 offlineGraceDays（服务器配的 7 天）宽限，超期才锁
//   · 未授权 = 整个面板锁死，只显示激活界面
(function () {
    'use strict';

    // 达芬奇版：渲染进程 contextIsolation，没有 Node 模块，置空但**不能 return**，
    // 否则整个授权模块失效（面板会一直锁死）。网络走 XHR，不受影响。
    var fs = null, path = null, os2 = null, childProcess = null;
    try {
        if (typeof require === 'function') {
            fs = require('fs');
            path = require('path');
            os2 = require('os');
            childProcess = require('child_process');
        }
    } catch (e) { /* 达芬奇环境：保持 null */ }

    // ---------- 配置 ----------
    var DEFAULT_BASE = 'http://47.122.108.231:17894';
    // 达芬奇版独立插件 ID：与 PR 客户版分开授权（同一邮箱可各自申请）
    var PLUGIN_ID = 'com.vh.atelier.resolve';

    // 存储：localStorage 快，文件更持久（清缓存也不丢）
    var LS_KEY = 'vh_lic_state_v1';
    var extRoot = '';
    try {
        if (typeof CSInterface !== 'undefined') {
            var cs = new CSInterface();
            extRoot = cs.getSystemPath(SystemPath.EXTENSION) || '';
        }
    } catch (e) {}
    // 达芬奇：由 index.html 注入 __vhExtRoot（主进程给的扩展根）
    if (!extRoot) { try { if (window.__vhExtRoot) extRoot = window.__vhExtRoot; } catch (e) {} }
    var FILE = (extRoot && path) ? path.join(extRoot, 'collect', '_license.json') : '';

    function base() {
        // 允许插件目录下 license-admin.json 覆盖服务器地址
        try {
            if (extRoot && path && fs) {
                var p = path.join(extRoot, 'license-admin.json');
                if (fs.existsSync(p)) {
                    var j = JSON.parse(fs.readFileSync(p, 'utf8'));
                    if (j && j.base) return String(j.base).replace(/\/+$/, '');
                }
            }
        } catch (e) {}
        return DEFAULT_BASE;
    }

    // ---------- 状态存储 ----------
    var state = {
        token: '',
        email: '',
        plan: '',
        expiresAt: 0,
        plugins: [],
        deviceId: '',
        deviceName: '',
        receipt: null,
        lastVerify: 0,
        offlineGraceDays: 7
    };

    // ---------- 记住账号 / 密码 ----------
    // 密码只做本地混淆（Base64 + 逐字节异或），不是加密。
    // 目的是防止明文躺在文件里被一眼看到，挡不住有意为之的人。
    // 客户版插件里这是常见折中：真正的凭据安全靠 token 而不是密码。
    var CRED_FILE = (extRoot && path) ? path.join(extRoot, 'collect', '_cred.json') : '';
    var CRED_KEY = 'vh_lic_cred_v1';
    var CRED_MIX = [0x5A, 0x31, 0x7C, 0x2E, 0x49, 0x63, 0x18, 0x74];

    function xorStr(str) {
        var out = '';
        for (var i = 0; i < str.length; i++) {
            out += String.fromCharCode(str.charCodeAt(i) ^ CRED_MIX[i % CRED_MIX.length]);
        }
        return out;
    }

    function b64enc(str) {
        try {
            return btoa(unescape(encodeURIComponent(str)));
        } catch (e) {
            var out = '';
            for (var i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) & 0xFF);
            try { return btoa(out); } catch (e2) { return ''; }
        }
    }

    function b64dec(str) {
        try {
            return decodeURIComponent(escape(atob(str)));
        } catch (e) {
            try { return atob(str); } catch (e2) { return ''; }
        }
    }

    function encPwd(plain) {
        if (!plain) return '';
        return b64enc(xorStr(String(plain)));
    }

    function decPwd(enc) {
        if (!enc) return '';
        var s2 = b64dec(enc);
        if (!s2) return '';
        return xorStr(s2);
    }

    // 读取记住的凭据
    function loadCred() {
        var got = null;
        try {
            if (CRED_FILE && fs.existsSync(CRED_FILE)) {
                got = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
            }
        } catch (e) {}
        if (!got) {
            try {
                var raw = localStorage.getItem(CRED_KEY);
                if (raw) got = JSON.parse(raw);
            } catch (e) {}
        }
        if (!got || typeof got !== 'object') got = {};
        return {
            email: String(got.email || ''),
            pwdEnc: String(got.pwdEnc || ''),
            rememberEmail: !!got.rememberEmail,
            rememberPwd: !!got.rememberPwd,
            autoLogin: !!got.autoLogin
        };
    }

    // 保存记住的凭据
    function saveCred(c) {
        var json = JSON.stringify({
            email: String(c.email || ''),
            pwdEnc: String(c.pwdEnc || ''),
            rememberEmail: !!c.rememberEmail,
            rememberPwd: !!c.rememberPwd,
            autoLogin: !!c.autoLogin
        });
        try { localStorage.setItem(CRED_KEY, json); } catch (e) {}
        try {
            if (CRED_FILE) {
                var d = (path && CRED_FILE) ? path.dirname(CRED_FILE) : '';
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                fs.writeFileSync(CRED_FILE, json, 'utf8');
            }
        } catch (e) {}
    }

    function clearCred() {
        try { localStorage.removeItem(CRED_KEY); } catch (e) {}
        try { if (CRED_FILE && fs.existsSync(CRED_FILE)) fs.unlinkSync(CRED_FILE); } catch (e) {}
    }

    function loadState() {
        // 优先读文件（更持久）
        var got = null;
        try {
            if (FILE && fs && fs.existsSync(FILE)) {
                got = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            }
        } catch (e) {}
        if (!got) {
            try {
                var raw = localStorage.getItem(LS_KEY);
                if (raw) got = JSON.parse(raw);
            } catch (e) {}
        }
        // 达芬奇：localStorage 在插件重启后可能被清，再退到宿主桥存的 collect 文件
        if (!got && window.__vhLicFileCache) {
            try { got = JSON.parse(window.__vhLicFileCache); } catch (e) {}
        }
        if (got && typeof got === 'object') {
            Object.keys(state).forEach(function (k) {
                if (got[k] !== undefined) state[k] = got[k];
            });
        }
        // 设备 ID 首次生成后固定
        if (!state.deviceId) state.deviceId = makeDeviceId();
    }

    function saveState() {
        var json = JSON.stringify(state);
        try { localStorage.setItem(LS_KEY, json); } catch (e) {}
        window.__vhLicFileCache = json;
        try {
            if (FILE && fs && path) {
                var d = (path && FILE) ? path.dirname(FILE) : '';
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                fs.writeFileSync(FILE, json, 'utf8');
            } else if (window.vhHost && window.vhHost.saveLicenseState) {
                // 达芬奇：交给主进程落盘到 collect/_license.json
                window.vhHost.saveLicenseState(json);
            }
        } catch (e) {}
    }

    // 设备 ID：优先用宿主桥（达芬奇主进程算好，与 PR 版算法一致）；
    // 缓存到 window，避免每次同步调用都走一次 IPC。
    var _devCache = null;
    function makeDeviceId() {
        if (_devCache) return _devCache;
        // 同步兜底：本地随机持久化（IPC 是异步的，这里拿不到就用它）
        var CACHE_KEY = 'vh_dev_id_v1';
        try {
            var c = localStorage.getItem(CACHE_KEY);
            if (c) { _devCache = c; return c; }
        } catch (e) {}
        var host = '';
        try { if (os2) host = os2.hostname(); } catch (e) {}
        var seed = host || 'unknown';
        var h = 0;
        for (var i = 0; i < seed.length; i++) {
            h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
        }
        var tag = Math.abs(h).toString(36).toUpperCase();
        var id = 'WX-' + tag + '-' + host.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
        try { localStorage.setItem(CACHE_KEY, id); } catch (e) {}
        _devCache = id;
        return id;
    }

    // 供外部在启动时异步刷新成宿主桥真值（UUID 版）
    function refreshDeviceIdFromHost() {
        var H = window.vhHost;
        if (!H || !H.machineId) return;
        try {
            H.machineId().then(function (r) {
                if (r && r.ok && r.data && r.data.id) {
                    _devCache = r.data.id;
                    state.deviceId = r.data.id;
                    state.deviceName = r.data.hostname || '';
                    try { localStorage.setItem('vh_dev_id_v1', r.data.id); } catch (e) {}
                }
            }).catch(function () {});
        } catch (e) {}
    }

    function deviceName() {
        if (state.deviceName) return state.deviceName;
        var n = '';
        try { if (os2) n = os2.hostname(); } catch (e) {}
        return n || '未命名电脑';
    }

    // ---------- HTTP ----------
    function post(pathname, body, timeout) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', base() + pathname, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.timeout = timeout || 15000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) {
                    var e0 = new Error('网络不可用');
                    e0.network = true;
                    reject(e0);
                    return;
                }
                var txt = xhr.responseText || '';
                var j = null;
                try { j = JSON.parse(txt); } catch (e) {}
                if (!j) {
                    // 服务器有响应但内容异常：属于服务端问题，按「拒绝」处理
                    var e1 = new Error('服务器返回异常（HTTP ' + xhr.status + '）');
                    e1.httpStatus = xhr.status;
                    e1.denied = true;
                    reject(e1);
                    return;
                }
                if (j.ok) { resolve(j); return; }
                // 服务端明确拒绝（401/403 等）：标记 denied，不再走离线宽限
                var e2 = new Error(j.msg || j.error || ('HTTP ' + xhr.status));
                e2.httpStatus = xhr.status;
                e2.denied = true;
                reject(e2);
            };
            xhr.onerror = function () {
                var e3 = new Error('网络不可用');
                e3.network = true;
                reject(e3);
            };
            xhr.ontimeout = function () {
                var e4 = new Error('连接超时');
                e4.network = true;
                reject(e4);
            };
            xhr.send(JSON.stringify(body || {}));
        });
    }

    function get(pathname, timeout) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', base() + pathname, true);
            xhr.timeout = timeout || 10000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) { reject(new Error('网络不可用')); return; }
                try { resolve(JSON.parse(xhr.responseText || '{}')); }
                catch (e) { reject(new Error('返回异常')); }
            };
            xhr.onerror = function () { reject(new Error('网络不可用')); };
            xhr.ontimeout = function () { reject(new Error('连接超时')); };
            xhr.send();
        });
    }

    // ---------- RSA 验签（可选，失败不阻断） ----------
    var pubKeyCache = null;

    function b64ToBuf(b64) {
        var bin = atob(b64);
        var len = bin.length;
        var buf = new Uint8Array(len);
        for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
        return buf.buffer;
    }

    function pemToBuf(pem) {
        var b64 = String(pem)
            .replace(/-----BEGIN PUBLIC KEY-----/, '')
            .replace(/-----END PUBLIC KEY-----/, '')
            .replace(/\s+/g, '');
        return b64ToBuf(b64);
    }

    function verifyReceipt(rc) {
        // 回执结构：{ payload, data(base64), sig(base64), alg }
        // 校验 data 的签名是否匹配 pubkey
        if (!rc || !rc.data || !rc.sig) return Promise.resolve(false);
        if (!window.crypto || !window.crypto.subtle) return Promise.resolve(false);

        function run(pem) {
            try {
                var keyBuf = pemToBuf(pem);
                var sigBuf = b64ToBuf(rc.sig);
                var dataBuf = b64ToBuf(rc.data);
                return window.crypto.subtle.importKey(
                    'spki', keyBuf,
                    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
                    false, ['verify']
                ).then(function (key) {
                    return window.crypto.subtle.verify(
                        'RSASSA-PKCS1-v1_5', key, sigBuf, dataBuf);
                }).catch(function () { return false; });
            } catch (e) { return Promise.resolve(false); }
        }

        if (pubKeyCache) return run(pubKeyCache);
        return get('/api/pubkey').then(function (j) {
            if (j && j.publicKey) {
                pubKeyCache = j.publicKey;
                return run(j.publicKey);
            }
            return false;
        }).catch(function () { return false; });
    }

    // ---------- 核心动作 ----------
    // 登录
    function login(email, password) {
        return post('/api/auth/login', {
            email: String(email || '').trim(),
            password: String(password || ''),
            deviceId: state.deviceId,
            deviceName: deviceName(),
            plugin: PLUGIN_ID
        }, 20000).then(function (j) {
            state.token = j.token || '';
            state.email = String(email || '').trim();
            applyReceipt(j.receipt);
            state.lastVerify = Date.now();
            saveState();

            // 登录成功后按用户选择保存凭据
            try {
                var c = loadCred();
                var em = String(email || '').trim();
                if (c.rememberEmail || c.rememberPwd || c.autoLogin) {
                    c.email = em;
                }
                if (c.rememberPwd || c.autoLogin) {
                    // 自动登录必须能取到密码，所以勾自动登录也存密码
                    c.pwdEnc = encPwd(password);
                }
                saveCred(c);
            } catch (e) {}

            return { ok: true, receipt: j.receipt, token: state.token };
        });
    }

    // 卡密激活
    // 服务器要求 email + password + code：
    //   邮箱没注册过 → 自动建号；已注册 → 必须密码对得上
    // 兑换成功后同样要再登录拿 token。
    function redeem(code, email, password) {
        return post('/api/redeem', {
            code: String(code || '').trim(),
            email: String(email || '').trim(),
            password: String(password || ''),
            deviceId: state.deviceId,
            deviceName: deviceName(),
            plugin: PLUGIN_ID
        }, 20000).then(function (j) {
            // 兑换成功，登录拿 token
            return login(email, password).then(function (lr) {
                lr.redeemed = true;
                lr.createdAccount = !!j.createdAccount;
                lr.message = j.message || '';
                return lr;
            });
        });
    }

    // 注册
    // 注意：服务器注册接口只返回 { userId, licenseId }，不发 token。
    // 所以注册成功后必须再走一次登录，否则拿不到 token 和回执。
    function register(email, password, invite) {
        var body = {
            email: String(email || '').trim(),
            password: String(password || ''),
            deviceId: state.deviceId,
            deviceName: deviceName(),
            plugin: PLUGIN_ID
        };
        if (invite) body.invite = String(invite).trim();

        return post('/api/auth/register', body, 20000).then(function (j) {
            // 注册成功，紧接着登录
            return login(email, password).then(function (lr) {
                lr.registered = true;
                return lr;
            });
        });
    }

    function applyReceipt(rc) {
        if (!rc) return;
        var p = rc.payload || rc;
        state.receipt = rc;
        state.plan = p.plan || state.plan;
        state.expiresAt = p.expiresAt || state.expiresAt;
        state.plugins = Array.isArray(p.plugins) ? p.plugins : state.plugins;
        if (p.offlineGraceDays != null) state.offlineGraceDays = p.offlineGraceDays;
        if (p.deviceId) state.deviceId = p.deviceId;
        if (p.email) state.email = p.email;
    }

    // 心跳校验
    function verify() {
        if (!state.token) {
            return Promise.resolve({ ok: false, reason: 'no-token', msg: '未登录' });
        }
        return post('/api/license/verify', {
            token: state.token,
            deviceId: state.deviceId,
            plugin: PLUGIN_ID
        }, 15000).then(function (j) {
            applyReceipt(j.receipt);
            state.lastVerify = Date.now();
            saveState();
            // 顺便验签（不作为阻断条件，只记录）
            return verifyReceipt(j.receipt).then(function (sigOk) {
                state.sigOk = sigOk;
                return { ok: true, receipt: j.receipt, sigOk: sigOk };
            });
        }).catch(function (e) {
            // 服务端明确拒绝（账号被删/授权被吊销/未开通本插件/设备被解绑）：
            // 必须立即失败并清掉本地 token，不能走离线宽限，
            // 否则「管理端删了账号，插件仍显示已授权」。
            if (e && e.denied) {
                state.token = '';
                state.receipt = null;
                saveState();
                return { ok: false, reason: 'denied', msg: e.message || '授权已失效', httpStatus: e.httpStatus };
            }
            // 只有真正的网络故障才走离线宽限
            var offline = canUseOffline();
            if (offline.ok) {
                return { ok: true, offline: true, remainDays: offline.remainDays };
            }
            return { ok: false, reason: 'net', msg: e.message, offline: offline };
        });
    }

    // 离线宽限判断
    function canUseOffline() {
        if (!state.expiresAt) return { ok: false, remainDays: 0 };
        var now = Date.now();
        // 授权本身是否过期
        if (state.expiresAt < now) return { ok: false, remainDays: 0 };
        // 最后一次成功校验距今多久
        var last = state.lastVerify || 0;
        if (!last) return { ok: false, remainDays: 0 };
        var graceMs = (state.offlineGraceDays || 7) * 86400000;
        var elapsed = now - last;
        if (elapsed > graceMs) return { ok: false, remainDays: 0, expiredOffline: true };
        return { ok: true, remainDays: Math.floor((graceMs - elapsed) / 86400000) };
    }

    // 本地判断当前是否可用（不联网）
    function localStatus() {
        if (!state.token) return { canUse: false, reason: 'no-login', msg: '未登录' };
        if (!state.expiresAt) return { canUse: false, reason: 'no-license', msg: '没有授权信息' };
        if (state.expiresAt < Date.now()) {
            return { canUse: false, reason: 'expired', msg: '授权已到期' };
        }
        var off = canUseOffline();
        if (!off.ok) {
            return {
                canUse: false,
                reason: off.expiredOffline ? 'offline-expired' : 'need-verify',
                msg: off.expiredOffline ? '离线时间过长，请联网校验' : '需要联网校验'
            };
        }
        return {
            canUse: true,
            email: state.email,
            plan: state.plan,
            expiresAt: state.expiresAt,
            remainDays: Math.ceil((state.expiresAt - Date.now()) / 86400000),
            offlineRemain: off.remainDays
        };
    }

    function logout(opt) {
        opt = opt || {};
        state.token = '';
        state.receipt = null;
        state.lastVerify = 0;
        saveState();
        // 主动退出时默认保留记住的账号密码，方便下次登录
        if (opt.forget) clearCred();
    }

    // 申请授权（走 /api/request）
    function requestAccess(note, email) {
        return post('/api/request', {
            email: String(email || state.email || '').trim(),
            note: String(note || ''),
            deviceId: state.deviceId,
            deviceName: deviceName(),
            plugin: PLUGIN_ID
        }, 20000);
    }

    // 关键：定义之后必须真正执行一次，否则每次都是全新的空 state，
    // 表现为"关掉插件再打开就要重新登录"。
    loadState();

    window.__vhLicense = {
        PLUGIN_ID: PLUGIN_ID,
        base: base,
        state: function () { return state; },
        deviceId: function () { return state.deviceId; },
        deviceName: deviceName,
        login: login,
        redeem: redeem,
        register: register,
        verify: verify,
        localStatus: localStatus,
        canUseOffline: canUseOffline,
        logout: logout,
        requestAccess: requestAccess,
        verifyReceipt: verifyReceipt,
        // ---- 记住账号 / 密码 / 自动登录 ----
        cred: loadCred,
        setCred: function (c) { saveCred(c); },
        clearCred: clearCred,
        decPwd: decPwd,
        // 自动登录：有 token 且本地可用就不动；否则用记住的密码重新登录
        autoLogin: function () {
            var c = loadCred();
            if (!c.autoLogin || !c.email || !c.pwdEnc) {
                return Promise.resolve({ ok: false, reason: 'disabled' });
            }
            var pwd = decPwd(c.pwdEnc);
            if (!pwd) return Promise.resolve({ ok: false, reason: 'no-password' });
            return login(c.email, pwd).then(function (r) {
                return { ok: true, email: c.email, result: r };
            }).catch(function (e) {
                return { ok: false, reason: 'failed', msg: (e && e.message) || String(e) };
            });
        }
    };
})();
