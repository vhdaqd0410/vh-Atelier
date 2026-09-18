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
            '.vhl-in[type=email],.vhl-in[type=password],.vhl-in[type=text]{height:36px;}',
            'textarea.vhl-in{resize:vertical;min-height:64px;line-height:1.6;}',
            'select.vhl-in{height:36px;cursor:pointer;}',
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
    // 待展示提示：某些操作（兑换/申请）完成后会立刻重渲染界面，
    // 直接写进 msgHost 会被冲掉，用这个槽位带到下一次渲染顶部显示。
    var _pendingNotice = null;

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

        // 已登录但状态不可用（如超离线宽限）时，自动补一次心跳，
        // 用户就不用自己点「重新验证」了。
        if (st.loggedIn && st.status !== 'active' && st.status !== 'bypass') {
            L.verify(function (err, s2) {
                if (!mask) return;              // 已关窗
                if (!err && s2) renderBody(body, s2);
            });
        }
    }

    function renderBody(body, st) {
        var L = window.__vhLicense;
        var loggedIn = !!st.loggedIn;

        body.innerHTML = '';

        // 先展示上一次操作留下的成功提示（只显示一次）
        if (_pendingNotice) {
            var nb = el('div');
            nb.className = 'vhl-msg-host';
            nb.innerHTML = '<div class="msg ok">' + esc(_pendingNotice) + '</div>';
            body.appendChild(nb);
            _pendingNotice = null;
        }

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
                            '<button class="vhl-btn link" data-act="center">打开网页用户中心 →</button>' +
                            '<div style="margin-top:8px">' +
                            '<button class="vhl-btn sec" data-act="apply">📩 申请授权 / 续期</button> ' +
                            '<button class="vhl-btn sec" data-act="card">🎟 激活码兑换</button>' +
                            '</div>';
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
            ops.querySelector('[data-act="apply"]').onclick = function () {
                renderApplyForm(body, msgHost);
            };
            ops.querySelector('[data-act="card"]').onclick = function () {
                renderRedeemForm(body, msgHost);
            };

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
                '</div>' +
                '<div style="margin-top:4px;text-align:center">' +
                '<button class="vhl-btn link" data-act="apply">试用到期 / 想申请授权？点这里 →</button>' +
                '<button class="vhl-btn link" data-act="card">有激活码？点此兑换 →</button>' +
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
            form.querySelector('[data-act="apply"]').onclick = function () {
                renderApplyForm(body, msgHost);
            };
            form.querySelector('[data-act="card"]').onclick = function () {
                renderRedeemForm(body, msgHost);
            };
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

    // ---------- 申请授权表单 ----------
    var APPLY_TYPES = [
        ['trial-expired', '试用到期，申请正式授权'],
        ['new', '首次申请授权'],
        ['add-plugin', '申请增加插件'],
        ['renew', '申请续期'],
        ['other', '其他']
    ];

    // 打开弹窗并直接跳到申请表单（供被锁提示调用）
    function openApply() {
        show();
        setTimeout(function () {
            var body = document.querySelector('.vhl-body');
            var host = document.querySelector('.vhl-msg-host') || (function () {
                var d = document.createElement('div');
                d.className = 'vhl-msg-host';
                if (body) body.appendChild(d);
                return d;
            })();
            if (body) renderApplyForm(body, host);
        }, 30);
    }

    // ---------- 激活码兑换 ----------
    function openRedeem() {
        show();
        setTimeout(function () {
            var body = document.querySelector('.vhl-body');
            var host = document.querySelector('.vhl-msg-host') || (function () {
                var d = document.createElement('div');
                d.className = 'vhl-msg-host';
                if (body) body.appendChild(d);
                return d;
            })();
            if (body) renderRedeemForm(body, host);
        }, 30);
    }

    function renderRedeemForm(body, msgHost) {
        var L = window.__vhLicense;
        var st = L.state();
        var email = st.email || '';

        var box = el('div');
        box.innerHTML =
            '<div class="vhl-hr"></div>' +
            '<div style="font-size:12.5px;color:#b8b8b8;line-height:1.7">' +
            '输入激活码即可开通 / 续期。激活码一个只能用一次，会绑定到你填写的邮箱。' +
            (email ? '' : '<br><span style="color:#fcd34d">提示：请填写你的邮箱与密码。</span>') +
            '</div>' +
            '<label class="vhl-lab">激活码</label>' +
            '<input class="vhl-in" id="vhlCardCode" type="text" placeholder="VHA-XXXXX-XXXXX-XXXXX" ' +
            'style="font-family:Consolas,monospace;letter-spacing:1px;text-transform:uppercase">' +
            '<label class="vhl-lab">邮箱</label>' +
            '<input class="vhl-in" id="vhlCardEmail" type="email" placeholder="you@example.com" value="' + esc(email) + '">' +
            '<label class="vhl-lab">密码（已有账号请填原密码；新账号将以此密码创建）</label>' +
            '<input class="vhl-in" id="vhlCardPwd" type="password" placeholder="至少 6 位">' +
            '<div style="margin-top:14px">' +
            '<button class="vhl-btn pri" data-act="redeem" style="width:100%">兑换并开通</button>' +
            '</div>';

        body.appendChild(box);
        body.appendChild(msgHost);

        var codeI = box.querySelector('#vhlCardCode');
        var emailI = box.querySelector('#vhlCardEmail');
        var pwdI = box.querySelector('#vhlCardPwd');
        var btn = box.querySelector('[data-act="redeem"]');

        // 输入时自动大写 + 补前缀，减少抄错
        codeI.oninput = function () {
            var v = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (v && v.indexOf('VHA') !== 0) v = 'VHA' + v;
            v = v.slice(0, 18);
            var body15 = v.slice(3);
            var out = 'VHA';
            for (var i = 0; i < body15.length && i < 15; i++) {
                if (i % 5 === 0 && i > 0) out += '-';
                out += body15[i];
            }
            this.value = out;
        };

        function doRedeem() {
            var code = codeI.value.trim();
            var em = emailI.value.trim();
            var pw = pwdI.value;
            if (!code) { setMsg(msgHost, '请输入激活码', 'err'); return; }
            if (!em) { setMsg(msgHost, '请输入邮箱', 'err'); return; }
            if (!pw || pw.length < 6) { setMsg(msgHost, '请输入密码（至少 6 位）', 'err'); return; }
            btn.disabled = true; btn.textContent = '兑换中…';

            doPost((window.__vhLicense.base ? window.__vhLicense.base() : '').replace(/\/+$/, '') + '/api/redeem',
                { code: code, email: em, password: pw, plugin: L.pluginId || '' },
                function (err, j) {
                    btn.disabled = false; btn.textContent = '兑换并开通';
                    if (err) { setMsg(msgHost, err.message || '兑换失败', 'err'); return; }
                    var msg = j.message || '兑换成功';
                    if (j.createdAccount) msg += '（已为你创建账号）';
                    msg += '　有效期至 ' + fmtDate((j.license || {}).expiresAt);
                    setMsg(msgHost, msg, 'ok');
                    _pendingNotice = msg;     // 重渲染后仍在顶部显示
                    pwdI.value = '';
                    // 兑换即等于登录：把凭据落盘，界面立刻变已授权
                    if (window.__vhLicense.adoptSession) {
                        window.__vhLicense.adoptSession(em, pw, function () {
                            setTimeout(function () { renderBody(body, L.refresh()); }, 1200);
                        });
                    } else {
                        setTimeout(function () { renderBody(body, L.refresh()); }, 1200);
                    }
                });
        }
        btn.onclick = doRedeem;
        pwdI.onkeydown = function (e) { if (e.key === 'Enter') doRedeem(); };

        setTimeout(function () { try { codeI.focus(); } catch (e) {} }, 60);
    }

    function renderApplyForm(body, msgHost) {
        var L = window.__vhLicense;
        var st = L.state();
        var email = st.email || '';

        var opts = APPLY_TYPES.map(function (t) {
            return '<option value="' + t[0] + '">' + esc(t[1]) + '</option>';
        }).join('');

        var box = el('div');
        box.innerHTML =
            '<div class="vhl-hr"></div>' +
            '<div style="font-size:12.5px;color:#b8b8b8;line-height:1.7">' +
            '提交申请后，管理员会在后台看到并为你开通。' +
            (email ? '' : '<br><span style="color:#fcd34d">提示：还没登录过，请先在下方填写邮箱。</span>') +
            '</div>' +
            '<label class="vhl-lab">邮箱</label>' +
            '<input class="vhl-in" id="vhlApplyEmail" type="email" placeholder="you@example.com" value="' + esc(email) + '">' +
            '<label class="vhl-lab">申请类型</label>' +
            '<select class="vhl-in" id="vhlApplyType">' + opts + '</select>' +
            '<label class="vhl-lab">希望开通时长（续期时填，单位天）</label>' +
            '<input class="vhl-in" id="vhlApplyDays" type="number" min="0" max="3650" placeholder="例如 90（留空则用管理员默认）">' +
            '<label class="vhl-lab">补充说明（可选）</label>' +
            '<textarea class="vhl-in" id="vhlApplyMsg" rows="3" placeholder="例如：我是做短剧剪辑的，需要长期使用超分和字幕校对"></textarea>' +
            '<div style="margin-top:14px;display:flex;gap:8px">' +
            '<button class="vhl-btn pri" data-act="send" style="flex:1">提交申请</button>' +
            '<button class="vhl-btn sec" data-act="status">查看进度</button>' +
            '</div>';

        body.appendChild(box);
        body.appendChild(msgHost);

        var emailI = box.querySelector('#vhlApplyEmail');
        var typeI = box.querySelector('#vhlApplyType');
        var msgI = box.querySelector('#vhlApplyMsg');
        var daysI = box.querySelector('#vhlApplyDays');

        // 依据当前状态预选类型
        if (st.status === 'expired' || st.status === 'grace_over') typeI.value = 'trial-expired';
        else if (!st.loggedIn) typeI.value = 'new';

        box.querySelector('[data-act="send"]').onclick = function () {
            var em = emailI.value.trim();
            if (!em) { setMsg(msgHost, '请填写邮箱', 'err'); return; }
            var b = this;
            b.disabled = true; b.textContent = '提交中…';

            // 允许未登录提交：直接调服务端接口，用表单里的邮箱
            applyDirect(em, typeI.value, msgI.value, Number(daysI.value) || 0, function (err, j) {
                b.disabled = false; b.textContent = '提交申请';
                if (err) { setMsg(msgHost, err.message || '提交失败', 'err'); return; }
                setMsg(msgHost, j && j.duplicated
                    ? '你之前已提交过相同申请，正在处理中'
                    : '申请已提交 ✅ 管理员处理后插件会自动解锁', 'ok');
            });
        };

        box.querySelector('[data-act="status"]').onclick = function () {
            var b = this;
            b.disabled = true; b.textContent = '查询中…';
            applyStatusDirect(emailI.value.trim(), function (err, j) {
                b.disabled = false; b.textContent = '查看进度';
                if (err) { setMsg(msgHost, err.message || '查询失败', 'err'); return; }
                var l = j.latest;
                if (!l) { setMsg(msgHost, '还没有提交过申请', 'info'); return; }
                var txt = { pending: '待处理', approved: '已通过', rejected: '已拒绝' }[l.status] || l.status;
                var line = '申请状态：' + txt + '（' + l.typeText + '）';
                if (l.status === 'approved' && j.license) {
                    line += '　授权已开通，剩余 ' +
                        (j.license.expiresAt ? Math.max(0, Math.ceil((j.license.expiresAt - Date.now()) / 86400000)) + ' 天' : '永久');
                    refresh();   // 已开通 → 立刻刷新界面状态
                }
                setMsg(msgHost, line, l.status === 'approved' ? 'ok' : 'info');
            });
        };
    }

    // 直接调服务端（不依赖模块内部 email，支持未登录提交）
    function applyDirect(email, type, message, wantDays, cb) {
        var L = window.__vhLicense;
        var base = (L.base ? L.base() : '').replace(/\/+$/, '');
        if (!base) return cb(new Error('未配置授权服务地址'));
        var body = {
            email: email, type: type, message: message,
            wantDays: Number(wantDays) || 0,
            plugin: L.pluginId || '',
            deviceId: L.deviceId ? L.deviceId() : '',
            deviceName: L.deviceName ? L.deviceName() : ''
        };
        doPost(base + '/api/request', body, cb);
    }

    function applyStatusDirect(email, cb) {
        var L = window.__vhLicense;
        var base = (L.base ? L.base() : '').replace(/\/+$/, '');
        if (!base) return cb(new Error('未配置授权服务地址'));
        if (!email) return cb(new Error('请填写邮箱'));
        doGet(base + '/api/request/status?email=' + encodeURIComponent(email), cb);
    }

    function doPost(url, body, cb) {
        try {
            var http = require('http'), https = require('https');
            var u = new URL(url);
            var mod = (u.protocol === 'https:') ? https : http;
            var data = JSON.stringify(body);
            var req = mod.request({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: (u.pathname || '/') + (u.search || ''),
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
                timeout: 15000
            }, function (res) {
                var b = '';
                res.on('data', function (d) { b += d; });
                res.on('end', function () {
                    var j = null; try { j = JSON.parse(b); } catch (e) {}
                    if (res.statusCode >= 200 && res.statusCode < 300 && j && j.ok) return cb(null, j);
                    cb(new Error((j && j.error) || ('HTTP ' + res.statusCode)));
                });
            });
            req.on('error', function (e) { cb(new Error('连不上授权服务（' + e.message + '）')); });
            req.on('timeout', function () { try { req.destroy(); } catch (e) {} cb(new Error('请求超时')); });
            req.write(data); req.end();
        } catch (e) { cb(new Error('提交失败：' + e.message)); }
    }

    function doGet(url, cb) {
        try {
            var http = require('http'), https = require('https');
            var u = new URL(url);
            var mod = (u.protocol === 'https:') ? https : http;
            var req = mod.get({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                path: (u.pathname || '/') + (u.search || ''),
                timeout: 12000
            }, function (res) {
                var b = '';
                res.on('data', function (d) { b += d; });
                res.on('end', function () {
                    var j = null; try { j = JSON.parse(b); } catch (e) {}
                    if (res.statusCode >= 200 && res.statusCode < 300 && j && j.ok) return cb(null, j);
                    cb(new Error((j && j.error) || ('HTTP ' + res.statusCode)));
                });
            });
            req.on('error', function (e) { cb(new Error('连不上授权服务（' + e.message + '）')); });
            req.on('timeout', function () { try { req.destroy(); } catch (e) {} cb(new Error('请求超时')); });
        } catch (e) { cb(new Error('查询失败：' + e.message)); }
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
            '<button class="vhl-btn sec" data-act="card">激活码</button>' +
            '<button class="vhl-btn sec" data-act="apply">申请授权</button>' +
            '<button class="vhl-btn sec" data-act="center">用户中心</button>' +
            '<button class="vhl-btn pri" data-act="login">' + (st.loggedIn ? '查看授权' : '去登录') + '</button>' +
            '</div>';

        function shut() { if (m.parentNode) m.parentNode.removeChild(m); }
        card.querySelector('.vhl-x').onclick = shut;
        card.querySelector('[data-act="center"]').onclick = function () { window.__vhLicense.openCenter(); };
        card.querySelector('[data-act="login"]').onclick = function () { shut(); show(); };
        card.querySelector('[data-act="apply"]').onclick = function () { shut(); show(); openApply(); };
        card.querySelector('[data-act="card"]').onclick = function () { shut(); show(); openRedeem(); };
        m.onclick = function (e) { if (e.target === m) shut(); };
        m.appendChild(card);
        document.body.appendChild(m);
    }

    // ---------- 标题栏按钮 ----------
    function bindTop() {
        var btn = document.getElementById('btnLicense');
        if (!btn) return;
        var L = window.__vhLicense;
        // 注意：paint 会被注册为状态变化监听器，运行在 emit 过程中。
        // 因此这里绝不能再调 L.refresh()，否则形成 refresh→emit→paint→refresh
        // 的无界递归；emit 里的 try/catch 会吞掉栈溢出，表现为界面卡死。
        // 直接用传入的状态对象。
        function paint(st) {
            st = st || L.state();
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
        paint(L.state());
    }

    window.__vhLicenseUI = {
        show: show,
        pendingNotice: function () { return _pendingNotice; },
        openApply: openApply,
        openRedeem: openRedeem,
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
