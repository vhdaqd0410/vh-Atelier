// vh-Atelier 授权弹窗 UI
// ==========================================================================
// 依赖 js/license.js（window.__vhLicense）。样式自注入，不依赖 atelier.css，
// 这样三个插件（主 / A / B）可以直接复制同一份文件。
//
// 入口：
//   window.__vhLicenseUI.show()      打开/关闭授权弹窗
//   window.__vhLicenseUI.bindTop()   绑定标题栏 #btnLicense 按钮
// 拦截提示：
//   window.__vhLicenseUI.blocked(groupName)  被锁时弹出提示
(function () {
    if (!window.__vhLicense) return;

    var STYLE_ID = 'vh-license-style';
    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent = [
            '.vhl-mask{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:10020;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;}',
            '.vhl-card{background:linear-gradient(180deg,#252526,#1e1e1e);border:1px solid #3f3f46;border-radius:10px;width:400px;max-width:100%;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.55);overflow:hidden;font-family:"Segoe UI","Microsoft YaHei",sans-serif;}',
            '.vhl-head{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid #333;}',
            '.vhl-ico{width:26px;height:26px;border-radius:6px;background:rgba(139,92,246,.18);color:#a78bfa;display:flex;align-items:center;justify-content:center;font-size:14px;flex:0 0 auto;}',
            '.vhl-title{font-size:13.5px;font-weight:600;color:#eaeaea;flex:1 1 auto;}',
            '.vhl-x{background:transparent;border:none;color:#888;font-size:15px;cursor:pointer;padding:2px 5px;border-radius:4px;}',
            '.vhl-x:hover{color:#fff;background:#3a3a3a;}',
            '.vhl-body{padding:16px;overflow-y:auto;font-size:12.5px;color:#cfcfcf;line-height:1.7;}',
            '.vhl-foot{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid #333;background:#1a1a1a;}',
            '.vhl-btn{border:none;border-radius:6px;padding:7px 16px;font-size:12.5px;cursor:pointer;font-family:inherit;}',
            '.vhl-btn.pri{background:linear-gradient(135deg,#8b5cf6,#9c6ee0);color:#fff;font-weight:600;}',
            '.vhl-btn.pri:hover{filter:brightness(1.12);}',
            '.vhl-btn.pri:disabled{filter:grayscale(.6);cursor:not-allowed;}',
            '.vhl-btn.sec{background:#3a3a3a;color:#c8c8c8;}',
            '.vhl-btn.sec:hover{background:#464646;}',
            '.vhl-btn.link{background:transparent;color:#a78bfa;padding:4px 6px;font-size:12px;}',
            '.vhl-btn.link:hover{text-decoration:underline;}',
            '.vhl-lab{display:block;font-size:12px;color:#9a9a9a;margin:12px 0 5px;}',
            '.vhl-in{width:100%;padding:9px 11px;background:#131316;color:#eaeaea;border:1px solid #45454f;border-radius:6px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;}',
            '.vhl-in:focus{border-color:#8b5cf6;}',
            '.vhl-msg{margin-top:12px;padding:8px 11px;border-radius:6px;font-size:12px;line-height:1.6;}',
            '.vhl-msg.err{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);color:#fca5a5;}',
            '.vhl-msg.ok{background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.3);color:#86efac;}',
            '.vhl-msg.info{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.3);color:#c4b5fd;}',
            '.vhl-st{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;}',
            '.vhl-badge{font-size:11px;padding:2px 9px;border-radius:20px;font-weight:600;}',
            '.vhl-b-ok{background:rgba(74,222,128,.14);color:#86efac;border:1px solid rgba(74,222,128,.3);}',
            '.vhl-b-bad{background:rgba(248,113,113,.14);color:#fca5a5;border:1px solid rgba(248,113,113,.3);}',
            '.vhl-b-warn{background:rgba(251,191,36,.14);color:#fcd34d;border:1px solid rgba(251,191,36,.3);}',
            '.vhl-kv{font-size:12px;color:#a8a8a8;margin-top:9px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;}',
            '.vhl-kv i{font-style:normal;color:#7a7a85;}',
            '.vhl-kv b{font-weight:500;color:#d8d8d8;font-family:Consolas,monospace;font-size:11.5px;word-break:break-all;}',
            '.vhl-note{font-size:11.5px;color:#8a8a8a;background:rgba(255,184,77,.06);border:1px solid rgba(255,184,77,.2);border-radius:6px;padding:8px 10px;line-height:1.7;margin-top:12px;}',
            '.vhl-hr{height:1px;background:#333;margin:14px 0;}'
        ].join('\n');
        document.head.appendChild(st);
    }

    var mask = null;

    function el(tag, cls, html) {
        var d = document.createElement(tag);
        if (cls) d.className = cls;
        if (html !== undefined) d.innerHTML = html;
        return d;
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var STATE_TEXT = {
        unbound:   ['未登录', 'warn'],
        active:    ['已授权', 'ok'],
        expired:   ['已到期', 'bad'],
        revoked:   ['已吊销', 'bad'],
        paused:    ['已暂停', 'bad'],
        mismatch:  ['设备不符', 'bad'],
        invalid:   ['回执失效', 'bad'],
        grace_over:['需联网验证', 'bad'],
        bypass:    ['调试模式', 'warn']
    };

    function stateBadge(s) {
        var t = STATE_TEXT[s] || ['未知', 'warn'];
        return '<span class="vhl-badge vhl-b-' + t[1] + '">' + esc(t[0]) + '</span>';
    }

    function fmtDate(ts) {
        if (!ts) return '永久';
        var d = new Date(ts), p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    var PLUGIN_LABEL = { 'com.vh.atelier': '主插件', 'com.vh.ate': 'A 插件', 'com.vh.subtitle': 'B 插件' };

    function close() {
        if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
        mask = null;
        document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    function show() {
        injectStyle();
        if (mask) { close(); return; }
        var L = window.__vhLicense;
        var st = L.refresh();

        mask = el('div', 'vhl-mask');
        var card = el('div', 'vhl-card');

        var head = el('div', 'vhl-head',
            '<div class="vhl-ico">🔑</div>' +
            '<div class="vhl-title">授权</div>' +
            '<button class="vhl-x" title="关闭">✕</button>');
        head.querySelector('.vhl-x').onclick = close;

        var body = el('div', 'vhl-body');
        renderBody(body, st);

        card.appendChild(head);
        card.appendChild(body);
        mask.appendChild(card);
        mask.onclick = function (e) { if (e.target === mask) close(); };
        document.body.appendChild(mask);
        document.addEventListener('keydown', onKey);
    }

    function renderBody(body, st) {
        var L = window.__vhLicense;
        var loggedIn = !!st.loggedIn;

        body.innerHTML = '';

        // ---------- 状态区 ----------
        var stBox = el('div');
        stBox.innerHTML =
            '<div class="vhl-st">' + stateBadge(st.status) +
            (st.note ? '<span style="font-size:11.5px;color:#9a9a9a">' + esc(st.note) + '</span>' : '') +
            '</div>';

        if (loggedIn) {
            var pl = (st.plugins || []).map(function (x) { return PLUGIN_LABEL[x] || x; }).join(' / ');
            stBox.innerHTML +=
                '<div class="vhl-kv">' +
                '<i>账号</i><b>' + esc(st.email) + '</b>' +
                '<i>套餐</i><b>' + esc(st.plan || '-') + '</b>' +
                '<i>到期</i><b>' + esc(fmtDate(st.expiresAt)) + '</b>' +
                (pl ? '<i>可用</i><b>' + esc(pl) + '</b>' : '') +
                '<i>本机码</i><b>' + esc((st.deviceId || '').slice(0, 20)) + '…</b>' +
                '<i>最后验证</i><b>' + esc(st.lastCheck ? new Date(st.lastCheck).toLocaleString('zh-CN') : '-') + '</b>' +
                '</div>';
        }
        body.appendChild(stBox);

        var msgHost = el('div');

        if (loggedIn) {
            // ---------- 已登录：操作区 ----------
            var ops = el('div');
            ops.style.marginTop = '14px';
            ops.innerHTML = '<button class="vhl-btn sec" data-act="verify">重新验证</button> ' +
                            '<button class="vhl-btn sec" data-act="logout">退出登录</button> ' +
                            '<button class="vhl-btn link" data-act="center">打开网页用户中心 →</button>';
            body.appendChild(ops);

            ops.querySelector('[data-act="verify"]').onclick = function () {
                var b = this;
                b.disabled = true; b.textContent = '验证中…';
                L.verify(function (err, s2) {
                    b.disabled = false; b.textContent = '重新验证';
                    if (err) setMsg(msgHost, err.message, 'err');
                    else setMsg(msgHost, '验证通过，授权有效', 'ok');
                    setTimeout(function () { renderBody(body, s2 || L.refresh()); },
                        (err ? 1600 : 700));
                });
            };
            ops.querySelector('[data-act="logout"]').onclick = function () {
                var self = this;
                if (!confirm('确定退出登录？\n\n退出后这台电脑会释放授权名额，需要重新登录才能使用受限功能。')) return;
                self.disabled = true;
                L.logout(function () {
                    renderBody(body, L.refresh());
                });
            };
            ops.querySelector('[data-act="center"]').onclick = function () { L.openCenter(); };

            if (st.status !== 'active' && st.status !== 'bypass') {
                body.appendChild(el('div', 'vhl-note',
                    '当前授权不可用，受限功能已锁定。可在网页用户中心查看授权与设备状态，' +
                    '或联系管理员处理。若是换机，请先在网页端解绑旧设备。'));
            }

            body.appendChild(msgHost);

        } else {
            // ---------- 未登录：登录表单 ----------
            var form = el('div');
            form.innerHTML =
                '<div class="vhl-hr"></div>' +
                '<div style="font-size:12.5px;color:#b8b8b8;line-height:1.7">' +
                '用你的账号登录即可解锁。一个账号默认可绑定 2 台电脑。</div>' +
                '<label class="vhl-lab">邮箱</label>' +
                '<input class="vhl-in" id="vhlEmail" type="email" placeholder="you@example.com">' +
                '<label class="vhl-lab">密码</label>' +
                '<input class="vhl-in" id="vhlPwd" type="password" placeholder="登录密码">' +
                '<div style="margin-top:14px">' +
                '<button class="vhl-btn pri" data-act="login" style="width:100%">登录并激活本机</button>' +
                '</div>' +
                '<div style="margin-top:10px;text-align:center">' +
                '<button class="vhl-btn link" data-act="reg">还没有账号？去注册 →</button>' +
                '</div>';
            body.appendChild(form);
            body.appendChild(msgHost);

            var emailI = form.querySelector('#vhlEmail');
            var pwdI = form.querySelector('#vhlPwd');
            var loginBtn = form.querySelector('[data-act="login"]');

            function doLogin() {
                var em = emailI.value.trim();
                var pw = pwdI.value;
                if (!em || !pw) { setMsg(msgHost, '请填写邮箱和密码', 'err'); return; }
                loginBtn.disabled = true; loginBtn.textContent = '登录中…';
                L.login(em, pw, function (err, s2) {
                    loginBtn.disabled = false; loginBtn.textContent = '登录并激活本机';
                    if (err) {
                        setMsg(msgHost, err.message || '登录失败', 'err');
                        return;
                    }
                    setMsg(msgHost, '登录成功，本机已激活', 'ok');
                    pwdI.value = '';
                    setTimeout(function () { renderBody(body, s2 || L.refresh()); }, 700);
                });
            }
            loginBtn.onclick = doLogin;
            pwdI.onkeydown = function (e) { if (e.key === 'Enter') doLogin(); };
            emailI.onkeydown = function (e) { if (e.key === 'Enter') pwdI.focus(); };
            form.querySelector('[data-act="reg"]').onclick = function () { L.openCenter(); };
            setTimeout(function () { try { emailI.focus(); } catch (e) {} }, 60);
        }

        // 底部：调试信息（本机机器码，换机解绑时用户要报给管理员）
        var foot = el('div');
        foot.style.cssText = 'margin-top:14px;padding-top:10px;border-top:1px solid #2c2c2c;font-size:10.5px;color:#5f5f68;font-family:Consolas,monospace;line-height:1.7';
        foot.innerHTML = '设备 ' + esc(L.deviceName ? L.deviceName() : '') +
            '<br>机器码 ' + esc(L.deviceId ? L.deviceId() : '');
        body.appendChild(foot);
    }

    function setMsg(host, text, kind) {
        host.innerHTML = text ? '<div class="vhl-msg ' + (kind || 'info') + '">' + esc(text) + '</div>' : '';
    }

    // ---------- 被锁提示 ----------
    var GROUP_LABEL = {
        home: '首页', media: '素材库', script: '剧本', upscale: '超分', audio: '声音',
        sub: '字幕', shenpian: '审片', deliver: '交付', progress: '进度',
        todo: '待办', feedback: '反馈'
    };

    function blocked(group) {
        injectStyle();
        var name = GROUP_LABEL[group] || group || '该功能';
        var st = window.__vhLicense.refresh();
        var m = el('div', 'vhl-mask');
        var card = el('div', 'vhl-card');
        card.style.width = '360px';
        var title = st.loggedIn
            ? (name + ' 未解锁')
            : (name + ' 需要授权');
        var detail = st.loggedIn
            ? ('当前授权状态：' + esc((STATE_TEXT[st.status] || ['未知'])[0]) +
               (st.note ? '（' + esc(st.note) + '）' : '') +
               '<br><br>可在网页用户中心查看详情或联系管理员。')
            : ('<b style="color:#d8d8d8">' + esc(name) + '</b> 属于需要授权的功能。<br><br>' +
               '登录账号并激活本机后即可解锁。若还没有账号，可在用户中心注册。');

        card.innerHTML =
            '<div class="vhl-head"><div class="vhl-ico">🔒</div><div class="vhl-title">' + esc(title) + '</div>' +
            '<button class="vhl-x">✕</button></div>' +
            '<div class="vhl-body">' + detail + '</div>' +
            '<div class="vhl-foot">' +
            '<button class="vhl-btn sec" data-act="center">用户中心</button>' +
            '<button class="vhl-btn pri" data-act="login">' + (st.loggedIn ? '查看授权' : '去登录') + '</button>' +
            '</div>';

        function shut() { if (m.parentNode) m.parentNode.removeChild(m); }
        card.querySelector('.vhl-x').onclick = shut;
        card.querySelector('[data-act="center"]').onclick = function () { window.__vhLicense.openCenter(); };
        card.querySelector('[data-act="login"]').onclick = function () { shut(); show(); };
        m.onclick = function (e) { if (e.target === m) shut(); };
        m.appendChild(card);
        document.body.appendChild(m);
    }

    // ---------- 标题栏按钮 ----------
    function bindTop() {
        var btn = document.getElementById('btnLicense');
        if (!btn) return;
        var L = window.__vhLicense;
        function paint() {
            var st = L.refresh();
            var ok = (st.status === 'active' || st.status === 'bypass');
            btn.classList.toggle('lic-ok', ok);
            btn.classList.toggle('lic-locked', !ok);
            btn.title = ok
                ? ('已授权 · ' + (st.email || '') + '（点此查看）')
                : ('未授权 · ' + (st.note || '点击登录') + '（点此登录）');
        }
        // 红点：未授权时显示
        if (!document.getElementById('licDotStyle')) {
            var s = document.createElement('style');
            s.id = 'licDotStyle';
            s.textContent =
                '#btnLicense.lic-locked{color:#fca5a5;}' +
                '#btnLicense.lic-locked::after{content:"";position:absolute;top:2px;right:2px;width:5px;height:5px;border-radius:50%;background:#f87171;}' +
                '#btnLicense{position:relative;}';
            document.head.appendChild(s);
        }
        if (!btn.__licBound) {
            btn.__licBound = true;
            btn.addEventListener('click', function () { show(); });
            L.on(paint);
        }
        paint();
    }

    window.__vhLicenseUI = {
        show: show,
        close: close,
        blocked: blocked,
        bindTop: bindTop,
        isActive: function () { return window.__vhLicense.isActive(); }
    };

    // DOM 就绪后自动绑定标题栏按钮
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindTop);
    } else {
        bindTop();
    }
})();
