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

    var fs, path, os2, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        os2 = require('os');
        childProcess = require('child_process');
    } catch (e) { return; }

    // ---------- 配置 ----------
    var DEFAULT_BASE = 'http://47.122.108.231:17894';
    var PLUGIN_ID = 'com.vh.atelier.pro';

    // 存储：localStorage 快，文件更持久（清缓存也不丢）
    var LS_KEY = 'vh_lic_state_v1';
    var extRoot = '';
    try {
        var cs = new CSInterface();
        extRoot = cs.getSystemPath(SystemPath.EXTENSION) || '';
    } catch (e) {}
    var FILE = extRoot ? path.join(extRoot, 'collect', '_license.json') : '';

    function base() {
        // 允许插件目录下 license-admin.json 覆盖服务器地址
        try {
            if (extRoot) {
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
        receipt: null,
        lastVerify: 0,
        offlineGraceDays: 7
    };

    function loadState() {
        // 优先读文件（更持久）
        var got = null;
        try {
            if (FILE && fs.existsSync(FILE)) {
                got = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            }
        } catch (e) {}
        if (!got) {
            try {
                var raw = localStorage.getItem(LS_KEY);
                if (raw) got = JSON.parse(raw);
            } catch (e) {}
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
        try {
            if (FILE) {
                var d = path.dirname(FILE);
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                fs.writeFileSync(FILE, json, 'utf8');
            }
        } catch (e) {}
    }

    // 设备 ID：机器标识 + 随机串，重装插件不变
    function makeDeviceId() {
        var host = '';
        try { host = os2.hostname(); } catch (e) {}
        var seed = '';
        try {
            // 用系统盘序列号或计算机名做种子
            var r = childProcess.spawnSync('wmic', ['csproduct', 'get', 'uuid'],
                { encoding: 'utf8', timeout: 8000, windowsHide: true });
            var out = String(r.stdout || '');
            var lines = out.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
            if (lines.length >= 2) seed = lines[1];
        } catch (e) {}
        if (!seed) seed = host || 'unknown';
        // 简单 hash
        var h = 0;
        for (var i = 0; i < seed.length; i++) {
            h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
        }
        var tag = Math.abs(h).toString(36).toUpperCase();
        return 'WX-' + tag + '-' + host.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    }

    function deviceName() {
        var n = '';
        try { n = os2.hostname(); } catch (e) {}
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
                if (xhr.status === 0) { reject(new Error('网络不可用')); return; }
                var txt = xhr.responseText || '';
                var j = null;
                try { j = JSON.parse(txt); } catch (e) {}
                if (!j) { reject(new Error('服务器返回异常（HTTP ' + xhr.status + '）')); return; }
                if (j.ok) resolve(j);
                else reject(new Error(j.msg || j.error || ('HTTP ' + xhr.status)));
            };
            xhr.onerror = function () { reject(new Error('网络不可用')); };
            xhr.ontimeout = function () { reject(new Error('连接超时')); };
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
            // 网络错误 → 走离线宽限
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

    function logout() {
        state.token = '';
        state.receipt = null;
        state.lastVerify = 0;
        saveState();
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
        verifyReceipt: verifyReceipt
    };
})();
