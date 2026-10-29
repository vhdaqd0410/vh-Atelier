// vh-Atelier 授权界面
//
// 未授权时整个插件被这层遮罩盖住，只显示两种激活方式：
//   ① 账号登录（邮箱 + 密码，可注册 / 7 天试用）
//   ② 卡密激活
// 授权后遮罩消失，插件正常使用。
(function () {
    'use strict';

    var LIC = window.__vhLicense;
    if (!LIC) { console.log('[lic] 授权模块未加载'); return; }

    var maskEl = null;
    var unlocked = false;
    var onUnlockCallbacks = [];

    function el(id) { return document.getElementById(id); }

    // ---------- 构建遮罩 ----------
    function buildMask() {
        if (maskEl) return maskEl;

        var mask = document.createElement('div');
        mask.id = 'licMask';
        mask.innerHTML = [
            '<div class="lic-box">',
            '  <div class="lic-head">',
            '    <div class="lic-logo">vh-Atelier</div>',
            '    <div class="lic-sub">专业影视后期工作台</div>',
            '  </div>',
            '  <div class="lic-body">',
            '    <div class="lic-tabs">',
            '      <button class="lic-tab active" data-mode="login">账号登录</button>',
            '      <button class="lic-tab" data-mode="card">卡密激活</button>',
            '    </div>',

            // 账号登录
            '    <div id="licPaneLogin" class="lic-pane">',
            '      <label class="lic-label">邮箱</label>',
            '      <input type="text" id="licEmail" class="lic-input" placeholder="your@email.com" autocomplete="off">',
            '      <label class="lic-label">密码</label>',
            '      <input type="password" id="licPwd" class="lic-input" placeholder="至少 6 位">',
            '      <button id="licBtnLogin" class="lic-btn primary">登 录</button>',
            '      <div class="lic-row">',
            '        <button id="licBtnRegister" class="lic-link">没有账号？注册并试用</button>',
            '      </div>',
            '    </div>',

            // 卡密
            '    <div id="licPaneCard" class="lic-pane" style="display:none;">',
            '      <label class="lic-label">激活码</label>',
            '      <input type="text" id="licCode" class="lic-input" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off">',
            '      <label class="lic-label">邮箱（用于绑定账号）</label>',
            '      <input type="text" id="licCardEmail" class="lic-input" placeholder="your@email.com" autocomplete="off">',
            '      <label class="lic-label">密码（新邮箱则自动创建账号）</label>',
            '      <input type="password" id="licCardPwd" class="lic-input" placeholder="至少 6 位">',
            '      <button id="licBtnRedeem" class="lic-btn primary">激 活</button>',
            '      <div class="lic-hint">激活码由管理员分发。同一激活码只能使用一次。</div>',
            '    </div>',

            // 状态提示
            '    <div id="licMsg" class="lic-msg"></div>',

            // 底部：设备信息 + 申请
            '    <div class="lic-foot">',
            '      <div class="lic-device">',
            '        <span>设备：<b id="licDevName">-</b></span>',
            '        <span class="lic-mono" id="licDevId">-</span>',
            '      </div>',
            '      <div class="lic-actions">',
            '        <button id="licBtnRequest" class="lic-btn ghost">申请授权</button>',
            '        <button id="licBtnCopyDev" class="lic-btn ghost">复制设备ID</button>',
            '      </div>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('\n');

        document.body.appendChild(mask);
        maskEl = mask;
        bind();
        return mask;
    }

    // ---------- 消息 ----------
    function msg(text, type) {
        var m = el('licMsg');
        if (!m) return;
        m.textContent = text || '';
        m.className = 'lic-msg' + (type ? ' ' + type : '');
    }

    function busy(b, text) {
        var btns = ['licBtnLogin', 'licBtnRegister', 'licBtnRedeem'];
        btns.forEach(function (id) {
            var x = el(id);
            if (x) x.disabled = b;
        });
        if (b && text) msg(text);
    }

    // ---------- 解锁 ----------
    function unlock(info) {
        if (unlocked) return;
        unlocked = true;
        if (maskEl && maskEl.parentNode) {
            maskEl.style.opacity = '0';
            setTimeout(function () {
                if (maskEl && maskEl.parentNode) maskEl.parentNode.removeChild(maskEl);
                maskEl = null;
            }, 220);
        }
        onUnlockCallbacks.forEach(function (fn) {
            try { fn(info); } catch (e) {}
        });
        console.log('[lic] 已解锁：' + JSON.stringify(info || {}));
    }

    // ---------- 绑定 ----------
    function bind() {
        // 切换 tab
        var tabs = maskEl.querySelectorAll('.lic-tab');
        Array.prototype.forEach.call(tabs, function (t) {
            t.addEventListener('click', function () {
                Array.prototype.forEach.call(tabs, function (x) { x.classList.remove('active'); });
                t.classList.add('active');
                var mode = t.dataset.mode;
                if (el('licPaneLogin')) el('licPaneLogin').style.display = (mode === 'login') ? '' : 'none';
                if (el('licPaneCard')) el('licPaneCard').style.display = (mode === 'card') ? '' : 'none';
                msg('');
            });
        });

        // 登录
        if (el('licBtnLogin')) {
            el('licBtnLogin').addEventListener('click', function () {
                var email = (el('licEmail').value || '').trim();
                var pwd = el('licPwd').value || '';
                if (!email) { msg('请输入邮箱', 'err'); return; }
                if (!pwd) { msg('请输入密码', 'err'); return; }
                busy(true, '正在登录…');
                LIC.login(email, pwd).then(function (r) {
                    afterAuth(r, '登录成功');
                }).catch(function (e) {
                    busy(false);
                    msg(e.message || '登录失败', 'err');
                });
            });
        }

        // 注册
        if (el('licBtnRegister')) {
            el('licBtnRegister').addEventListener('click', function () {
                var email = (el('licEmail').value || '').trim();
                var pwd = el('licPwd').value || '';
                if (!email) { msg('请先填邮箱', 'err'); el('licEmail').focus(); return; }
                if (!pwd || pwd.length < 6) { msg('密码至少 6 位', 'err'); el('licPwd').focus(); return; }
                busy(true, '正在注册…');
                LIC.register(email, pwd).then(function (r) {
                    afterAuth(r, '注册成功，已开启试用');
                }).catch(function (e) {
                    busy(false);
                    msg(e.message || '注册失败', 'err');
                });
            });
        }

        // 卡密
        if (el('licBtnRedeem')) {
            el('licBtnRedeem').addEventListener('click', function () {
                var code = (el('licCode').value || '').trim();
                var email = (el('licCardEmail').value || '').trim();
                var pwd = el('licCardPwd').value || '';
                if (!code) { msg('请输入激活码', 'err'); el('licCode').focus(); return; }
                if (!email) { msg('请输入邮箱', 'err'); el('licCardEmail').focus(); return; }
                if (!pwd || pwd.length < 6) { msg('密码至少 6 位', 'err'); el('licCardPwd').focus(); return; }
                busy(true, '正在激活…');
                LIC.redeem(code, email, pwd).then(function (r) {
                    var t = '激活成功';
                    if (r.createdAccount) t = '激活成功，已为你创建账号';
                    if (r.message) t = r.message;
                    afterAuth(r, t);
                }).catch(function (e) {
                    busy(false);
                    msg(e.message || '激活失败', 'err');
                });
            });
        }

        // 申请授权
        if (el('licBtnRequest')) {
            el('licBtnRequest').addEventListener('click', function () {
                showRequestDialog();
            });
        }

        // 复制设备 ID
        if (el('licBtnCopyDev')) {
            el('licBtnCopyDev').addEventListener('click', function () {
                var txt = LIC.deviceId() + '  (' + LIC.deviceName() + ')';
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(txt);
                    } else if (window.__copyText) {
                        window.__copyText(txt);
                    }
                    msg('设备ID 已复制：' + txt, 'ok');
                } catch (e) {
                    msg('复制失败，请手动选择：' + txt, 'err');
                }
            });
        }

        // 回车提交
        ['licEmail', 'licPwd', 'licCode', 'licCardEmail', 'licCardPwd'].forEach(function (id) {
            var x = el(id);
            if (!x) return;
            x.addEventListener('keydown', function (ev) {
                if (ev.key !== 'Enter') return;
                if (id === 'licCode' || id === 'licCardEmail' || id === 'licCardPwd') {
                    if (el('licBtnRedeem')) el('licBtnRedeem').click();
                } else {
                    if (el('licBtnLogin')) el('licBtnLogin').click();
                }
            });
        });

        // 填设备信息
        if (el('licDevName')) el('licDevName').textContent = LIC.deviceName();
        if (el('licDevId')) el('licDevId').textContent = LIC.deviceId();
    }

    // 登录/激活成功后的处理
    function afterAuth(result, okText) {
        var rc = result.receipt || (LIC.state() && LIC.state().receipt);
        var p = (rc && (rc.payload || rc)) || {};
        var exp = p.expiresAt || 0;
        var plan = p.plan || '';

        // 校验这个授权是否包含本插件
        var plugins = Array.isArray(p.plugins) ? p.plugins : [];
        if (plugins.length && plugins.indexOf(LIC.PLUGIN_ID) < 0) {
            busy(false);
            msg('这个账号的授权不包含本插件（' + LIC.PLUGIN_ID + '）\n如需开通请点「申请授权」', 'err');
            return;
        }

        busy(false);
        var expText = exp ? new Date(exp).toLocaleDateString('zh-CN') : '未知';
        msg(okText + '　有效期至 ' + expText, 'ok');

        // 稍等再解锁，让用户看到成功提示
        setTimeout(function () {
            var st = LIC.localStatus();
            if (st.canUse) unlock(st);
            else msg('授权状态异常：' + (st.msg || ''), 'err');
        }, 900);
    }

    // 申请授权弹窗
    function showRequestDialog() {
        var note = window.prompt(
            '申请授权\n\n' +
            '请填写你的用途说明（可选），提交后管理员会在后台看到。\n' +
            '设备：' + LIC.deviceName() + '\n' +
            '设备ID：' + LIC.deviceId() + '\n\n' +
            '如果已有账号，请先在「账号登录」里登录；没有账号可先注册。\n' +
            '也可以直接把上面的设备ID发给管理员，让他给你开通或发卡密。',
            ''
        );
        if (note === null) return;

        msg('正在提交申请…');
        LIC.requestAccess(note).then(function (j) {
            msg('✓ 申请已提交，请在后台处理。也可以把设备ID发给管理员加速处理。', 'ok');
        }).catch(function (e) {
            // /api/request 可能需要登录，退回到提示手动联系
            msg('提交失败（' + (e.message || '') + '）。请直接把设备ID发给管理员。', 'err');
        });
    }

    // ---------- 启动检查 ----------
    function start() {
        var st = LIC.localStatus();
        if (st.canUse) {
            // 本地看是有效的，后台异步校验一次（不阻塞）
            unlocked = true;
            LIC.verify().then(function (r) {
                if (!r.ok) {
                    // 校验失败 → 重新锁上
                    console.log('[lic] 后台校验失败：' + (r.msg || ''));
                    if (r.reason !== 'net') {
                        unlocked = false;
                        buildMask();
                        msg('授权校验失败：' + (r.msg || '') + '，请重新登录', 'err');
                    }
                }
            }).catch(function () {});
            return;
        }

        // 不可用 → 显示遮罩
        buildMask();
        if (st.reason === 'expired') {
            msg('授权已到期（' + new Date(LIC.state().expiresAt).toLocaleDateString('zh-CN') +
                '），请续期或重新激活', 'err');
        } else if (st.reason === 'offline-expired') {
            msg('离线时间过长，请联网后再试', 'err');
        } else if (st.reason === 'no-license') {
            msg('已登录但没有授权，请联系管理员开通', 'err');
        } else {
            msg('请登录或输入激活码', '');
        }
    }

    // 对外接口
    window.__vhLicenseUI = {
        start: start,
        unlock: unlock,
        relock: function (reason) {
            unlocked = false;
            buildMask();
            msg(reason || '授权失效，请重新登录', 'err');
        },
        onUnlock: function (fn) { onUnlockCallbacks.push(fn); },
        isUnlocked: function () { return unlocked; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        setTimeout(start, 100);
    }
})();
