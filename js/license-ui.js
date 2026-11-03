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
            '      <div class="lic-remember">',
            '        <label class="lic-chk"><input type="checkbox" id="licRememberPwd"><span>记住密码</span></label>',
            '        <label class="lic-chk"><input type="checkbox" id="licAutoLogin"><span>自动登录</span></label>',
            '      </div>',
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
        // 无论从哪条路径解锁（登录 / 卡密 / 自动登录 / 本地有效），
        // 都让账号面板重绘一次，避免显示过期的"未登录"。
        try {
            if (window.__vhAccount && window.__vhAccount.render) {
                setTimeout(function () {
                    try { window.__vhAccount.render(); } catch (e) {}
                }, 60);
            }
        } catch (e) {}
        console.log('[lic] 已解锁：' + JSON.stringify(info || {}));
    }

    // ---------- 绑定 ----------
    function bind() {
        // 回填记住的账号密码
        try {
            var cr = (LIC.cred && LIC.cred()) || {};
            var emEl = el('licEmail');
            var pwEl = el('licPwd');
            var rpEl = el('licRememberPwd');
            var alEl = el('licAutoLogin');
            if (emEl && cr.email) emEl.value = cr.email;
            if (rpEl) rpEl.checked = !!cr.rememberPwd;
            if (alEl) alEl.checked = !!cr.autoLogin;
            if (pwEl && (cr.rememberPwd || cr.autoLogin) && cr.pwdEnc) {
                var pwd = LIC.decPwd ? LIC.decPwd(cr.pwdEnc) : '';
                if (pwd) pwEl.value = pwd;
            }
            // 勾自动登录时联动勾上记住密码（否则自动登录取不到密码）
            if (alEl && rpEl) {
                alEl.addEventListener('change', function () {
                    if (alEl.checked) rpEl.checked = true;
                });
            }
        } catch (e) {}

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

        // 记住账号 / 密码勾选状态同步到本地
        function syncCred(email) {
            try {
                if (!LIC.setCred) return;
                var rp = el('licRememberPwd');
                var al = el('licAutoLogin');
                var c = (LIC.cred && LIC.cred()) || {};
                c.email = String(email || c.email || '');
                c.rememberEmail = !!(c.email);
                c.rememberPwd = !!(rp && rp.checked);
                c.autoLogin = !!(al && al.checked);
                LIC.setCred(c);
            } catch (e) {}
        }

        // 登录
        if (el('licBtnLogin')) {
            el('licBtnLogin').addEventListener('click', function () {
                var email = (el('licEmail').value || '').trim();
                var pwd = el('licPwd').value || '';
                if (!email) { msg('请输入邮箱', 'err'); return; }
                if (!pwd) { msg('请输入密码', 'err'); return; }
                // 先记下勾选状态，LIC.login 成功后据此保存密码
                syncCred(email);
                busy(true, '正在登录…');
                LIC.login(email, pwd).then(function (r) {
                    afterAuth(r, '登录成功');
                }).catch(function (e) {
                    busy(false);
                    msg(e.message || '登录失败', 'err');
                });
            });
        }

        // 注册：弹出独立注册窗，不再复用登录框里已填的账号密码
        if (el('licBtnRegister')) {
            el('licBtnRegister').addEventListener('click', function () {
                showRegisterDialog();
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
            if (st.canUse) {
                unlock(st);
                // 解锁后通知账号面板重绘：否则面板还停在"未登录"状态，
                // 要切走再切回来才刷新。
                try {
                    if (window.__vhAccount && window.__vhAccount.render) {
                        window.__vhAccount.render();
                    }
                } catch (e) {}
            } else {
                msg('授权状态异常：' + (st.msg || '本地授权校验未通过，请重新登录或联系管理员'), 'err');
            }
        }, 900);
    }

    // 从回执算试用天数文案（服务器 trialDays 可配，前端不写死）
    function trialDaysText(result) {
        var rc = (result && result.receipt) || (LIC.state() && LIC.state().receipt);
        var p = (rc && (rc.payload || rc)) || {};
        var exp = p.expiresAt || (LIC.state() && LIC.state().expiresAt) || 0;
        if (!exp) return '试用已开通';
        var days = Math.round((exp - Date.now()) / 86400000);
        if (days >= 27 && days <= 32) return '试用有效期 1 个月';
        if (days >= 360) return '试用有效期 1 年';
        if (days < 1) return '试用有效期 ' + Math.max(1, Math.round(days * 24)) + ' 小时';
        return '试用有效期 ' + days + ' 天';
    }

    // 注册弹窗（独立于登录框，避免"先填邮箱再点注册"的割裂感）
    function showRegisterDialog() {
        if (document.getElementById('licRegMask')) return;

        var mask = document.createElement('div');
        mask.id = 'licRegMask';
        mask.className = 'lic-modal-mask';
        mask.innerHTML = [
            '<div class="lic-modal">',
            '  <div class="lic-modal-head">',
            '    <span class="lic-modal-title">注册账号 · 免费试用</span>',
            '    <button class="lic-modal-x" id="licRegClose" title="关闭">✕</button>',
            '  </div>',
            '  <div class="lic-modal-body">',
            '    <div class="lic-reg-trial">',
            '      <span class="lic-reg-trial-day" id="licRegTrialDay">1</span>',
            '      <span class="lic-reg-trial-txt">天全功能试用<br><i>无需付费，注册即开通</i></span>',
            '    </div>',

            '    <label class="lic-label">邮箱 <span class="lic-opt">（用作登录账号）</span></label>',
            '    <input type="text" id="licRegEmail" class="lic-input" placeholder="your@email.com" autocomplete="off">',

            '    <label class="lic-label">密码 <span class="lic-opt">（至少 6 位）</span></label>',
            '    <input type="password" id="licRegPwd" class="lic-input" placeholder="设置登录密码">',

            '    <label class="lic-label">确认密码</label>',
            '    <input type="password" id="licRegPwd2" class="lic-input" placeholder="再输入一次">',

            '    <div id="licRegMsg" class="lic-msg"></div>',

            '    <div class="lic-modal-foot">',
            '      <button class="lic-btn ghost" id="licRegCancel" style="flex:1;">取消</button>',
            '      <button class="lic-btn primary" id="licRegSubmit" style="flex:1.4;">注册并开始试用</button>',
            '    </div>',

            '    <div class="lic-rrow">',
            '      已有账号？<button class="lic-link" id="licRegToLogin">直接登录</button>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('\n');

        document.body.appendChild(mask);

        function q(id) { return document.getElementById(id); }
        function setMsg(t, cls) {
            var m = q('licRegMsg');
            if (!m) return;
            m.textContent = t || '';
            m.className = 'lic-msg' + (cls ? ' ' + cls : '');
        }
        function close() {
            if (mask.parentNode) mask.parentNode.removeChild(mask);
        }

        q('licRegClose').addEventListener('click', close);
        q('licRegCancel').addEventListener('click', close);
        q('licRegToLogin').addEventListener('click', close);
        mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });

        // 试用天数徽标：优先用服务器已下发过的回执推算，拿不到就保持默认 1
        (function () {
            var t = trialDaysText(null);
            var m = t.match(/(\d+)\s*天/);
            var dayEl = q('licRegTrialDay');
            if (dayEl && m) dayEl.textContent = m[1];
        })();

        // 注册前把登录页已填的邮箱带过来，省一次输入
        var preEmail = (el('licEmail') && el('licEmail').value || '').trim();
        if (preEmail) q('licRegEmail').value = preEmail;
        setTimeout(function () { try { q('licRegEmail').focus(); } catch (e) {} }, 60);

        function submit() {
            var email = (q('licRegEmail').value || '').trim();
            var pwd = q('licRegPwd').value || '';
            var pwd2 = q('licRegPwd2').value || '';

            if (!email) { setMsg('请输入邮箱', 'err'); q('licRegEmail').focus(); return; }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg('邮箱格式不正确', 'err'); q('licRegEmail').focus(); return; }
            if (!pwd || pwd.length < 6) { setMsg('密码至少 6 位', 'err'); q('licRegPwd').focus(); return; }
            if (pwd2 !== pwd) { setMsg('两次输入的密码不一致', 'err'); q('licRegPwd2').focus(); return; }

            var btn = q('licRegSubmit');
            btn.disabled = true;
            btn.textContent = '注册中…';
            setMsg('正在创建账号…');

            LIC.register(email, pwd).then(function (r) {
                // 记住邮箱，方便下次登录
                try {
                    if (LIC.setCred) {
                        var c = (LIC.cred && LIC.cred()) || {};
                        c.email = email;
                        c.rememberEmail = true;
                        LIC.setCred(c);
                    }
                } catch (e) {}
                if (el('licEmail')) el('licEmail').value = email;

                // 试用天数以服务器回执为准，不在前端写死
                var trialTxt = trialDaysText(r);
                setMsg('✓ 注册成功，' + trialTxt, 'ok');
                btn.textContent = '已开通';
                setTimeout(function () {
                    close();
                    afterAuth(r, '注册成功，' + trialTxt);
                }, 700);
            }).catch(function (e) {
                btn.disabled = false;
                btn.textContent = '注册并开始试用';
                var m = (e && e.message) || '注册失败';
                if (/已存在|已注册|exists/i.test(m)) {
                    setMsg('这个邮箱已经注册过了\n改点下方「直接登录」，或换一个邮箱', 'err');
                } else {
                    setMsg(m, 'err');
                }
            });
        }

        q('licRegSubmit').addEventListener('click', submit);
        ['licRegEmail', 'licRegPwd', 'licRegPwd2'].forEach(function (id) {
            q(id).addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') submit();
            });
        });
    }

    // 申请授权弹窗（贴合插件风格）
    function showRequestDialog(presetType) {
        // 已开着就不再新建，避免叠层（同 id 多份时关不掉）
        if (document.getElementById('licReqMask')) return;

        // 复用遮罩层样式
        var mask = document.createElement('div');
        mask.id = 'licReqMask';
        mask.className = 'lic-modal-mask';
        mask.innerHTML = [
            '<div class="lic-modal">',
            '  <div class="lic-modal-head">',
            '    <span class="lic-modal-title">申请授权</span>',
            '    <button class="lic-modal-x" id="licReqClose" title="关闭">✕</button>',
            '  </div>',
            '  <div class="lic-modal-body">',

            '    <div class="lic-req-info">',
            '      <div class="lic-req-row"><span>设备名称</span><b id="licReqDevName">-</b></div>',
            '      <div class="lic-req-row"><span>设备 ID</span><b class="lic-mono" id="licReqDevId">-</b></div>',
            '      <div class="lic-req-row"><span>当前账号</span><b id="licReqEmail">(未登录)</b></div>',
            '    </div>',

            '    <label class="lic-label">申请类型</label>',
            '    <select id="licReqType" class="lic-input lic-select">',
            '      <option value="new">首次开通</option>',
            '      <option value="renew">续期</option>',
            '      <option value="plugin">增加插件权限</option>',
            '      <option value="unbind">解绑旧设备</option>',
            '      <option value="other">其他问题</option>',
            '    </select>',

            '    <label class="lic-label">需要开通的时长</label>',
            '    <select id="licReqDays" class="lic-input lic-select">',
            '      <option value="7">7 天</option>',
            '      <option value="30" selected>30 天（一个月）</option>',
            '      <option value="90">90 天（三个月）</option>',
            '      <option value="365">365 天（一年）</option>',
            '      <option value="0">由管理员决定</option>',
            '    </select>',

            '    <label class="lic-label">说明 <span class="lic-opt">（选填，最多 200 字）</span></label>',
            '    <textarea id="licReqNote" class="lic-input lic-textarea" rows="3"',
            '      placeholder="例如：我是XX工作室，买了年卡需要开通；或者：之前的授权已到期需要续期"></textarea>',

            '    <div class="lic-req-tip">',
            '      <b>提示：</b>提交后管理员会在后台看到你的申请，通常会在 24 小时内处理。',
            '      急用可以把上面的<b>设备 ID</b> 发给管理员，能更快处理。',
            '    </div>',

            '    <div class="lic-contact">',
            '      <div class="lic-contact-qr">',
            '        <img id="licContactQr" alt="扫码添加管理员">',
            '        <div class="lic-contact-qr-ph" id="licContactQrPh">二维码待配置</div>',
            '      </div>',
            '      <div class="lic-contact-txt">',
            '        <div class="lic-contact-h">扫码添加管理员</div>',
            '        <div class="lic-contact-d">加好友请备注 <b>vh-Atelier</b>，并附上设备 ID，处理更快。</div>',
            '        <div class="lic-contact-d lic-contact-mono" id="licContactWx">',
            '          微信：<span id="licContactWxId">—</span>',
            '        </div>',
            '      </div>',
            '    </div>',

            '    <div id="licReqMsg" class="lic-msg"></div>',

            '    <div class="lic-modal-foot">',
            '      <button class="lic-btn ghost" id="licReqCopy" style="flex:1;">复制申请信息</button>',
            '      <button class="lic-btn primary" id="licReqSubmit" style="flex:1;">提交申请</button>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('\n');

        document.body.appendChild(mask);

        function q(id) { return document.getElementById(id); }
        function setMsg(t, cls) {
            var m = q('licReqMsg');
            if (!m) return;
            m.textContent = t || '';
            m.className = 'lic-msg' + (cls ? ' ' + cls : '');
        }

        // 二维码：用 Node fs 直接读文件转 data URL。
        // 不走 <img src="collect/xxx.png"> 的相对路径，原因有三个：
        //   ① CEP 里 file:// 相对路径带查询串（?v=时间戳）在部分 CEF 版本上取不到文件；
        //   ② 用户常把截图存成 contact-qr.png.jpg 这种双扩展名，写死候选名会漏；
        //   ③ 扩展被在线更新覆盖后 assets/ 可能被换掉，collect/ 才是用户数据。
        // 所以这里：扫 collect/ 与 assets/，找文件名以 contact-qr 开头的任意图片，
        // 按文件头判真实格式（不认扩展名），读成 base64 塞给 img。
        var _qrDataUrl = '';
        (function () {
            var img = q('licContactQr');
            var ph = q('licContactQrPh');
            if (!img || !ph) return;

            var fs = null, pathMod = null, extRoot = '';
            try { fs = require('fs'); pathMod = require('path'); } catch (e) {}
            try { extRoot = new CSInterface().getSystemPath(SystemPath.EXTENSION); } catch (e) {}

            function showPh(reason) {
                img.style.display = 'none';
                img.removeAttribute('src');
                ph.style.display = 'flex';
                if (reason) ph.title = reason;
            }

            if (!fs || !pathMod || !extRoot) {
                showPh('当前环境读不到本地文件');
                return;
            }

            // 按文件头判真实图片格式（扩展名不可信）
            function mimeOf(buf) {
                if (!buf || buf.length < 4) return '';
                if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
                if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
                if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
                if (buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
                if (buf.length > 4 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'image/avif';
                return '';
            }

            var dirs = [pathMod.join(extRoot, 'collect'), pathMod.join(extRoot, 'assets')];
            var found = null, tried = [];

            for (var d = 0; d < dirs.length && !found; d++) {
                var dir = dirs[d];
                var names = [];
                try {
                    names = fs.readdirSync(dir);
                } catch (e) { continue; }
                // 只要 contact-qr 开头、且看起来是图片（含双扩展名 danger）
                var hits = [];
                for (var n = 0; n < names.length; n++) {
                    var nm = names[n];
                    if (nm.toLowerCase().indexOf('contact-qr') !== 0) continue;
                    if (/\.(png|jpe?g|gif|webp|avif)$/i.test(nm) || /\.(png|jpe?g|gif|webp|avif)\.(png|jpe?g|gif|webp|avif)$/i.test(nm)) {
                        hits.push(nm);
                    }
                }
                // 名字完全匹配的优先，其余按字母序
                hits.sort(function (a, b) {
                    var ea = /\.png$/i.test(a) ? 0 : 1;
                    var eb = /\.png$/i.test(b) ? 0 : 1;
                    if (ea !== eb) return ea - eb;
                    return a < b ? -1 : (a > b ? 1 : 0);
                });
                for (var k = 0; k < hits.length; k++) {
                    var fp = pathMod.join(dir, hits[k]);
                    tried.push(fp);
                    try {
                        var buf = fs.readFileSync(fp);
                        var mt = mimeOf(buf);
                        if (!mt) continue;
                        _qrDataUrl = 'data:' + mt + ';base64,' + buf.toString('base64');
                        found = fp;
                        break;
                    } catch (e) { /* 读失败继续下一个 */ }
                }
            }

            if (!found) {
                showPh('把 contact-qr.png 放进 collect 目录即可');
                try { window.__vhLog && window.__vhLog.info('[授权] 未找到二维码文件，已扫：' + dirs.join(' | ')); } catch (e) {}
                return;
            }

            img.onload = function () {
                img.onload = null;
                ph.style.display = 'none';
                img.style.display = '';
            };
            img.onerror = function () {
                img.onerror = null;
                showPh('二维码文件读不出图像');
                try { window.__vhLog && window.__vhLog.warn('[授权] 二维码解码失败：' + found); } catch (e) {}
            };
            ph.style.display = 'flex';
            img.style.display = 'none';
            img.src = _qrDataUrl;
            try { window.__vhLog && window.__vhLog.info('[授权] 二维码已加载：' + found); } catch (e) {}
        })();

        // 点击二维码查看大图（92px 太小扫不出来，必须能放大）
        (function () {
            var img = q('licContactQr');
            var box = img && img.parentNode;
            if (!img || !box) return;

            var zoomEl = null;
            function closeZoom() {
                if (!zoomEl) return;
                if (zoomEl.parentNode) zoomEl.parentNode.removeChild(zoomEl);
                zoomEl = null;
                document.removeEventListener('keydown', onKey, true);
            }
            function onKey(ev) {
                if (ev.key === 'Escape') { ev.stopPropagation(); closeZoom(); }
            }
            function openZoom() {
                var src = img.src || _qrDataUrl;
                if (!src || img.style.display === 'none') return;
                if (zoomEl) closeZoom();
                zoomEl = document.createElement('div');
                zoomEl.className = 'lic-qr-zoom';
                zoomEl.innerHTML =
                    '<img alt="扫码添加管理员">' +
                    '<div class="lic-qr-zoom-tip">点击任意处或按 Esc 关闭</div>';
                var big = zoomEl.querySelector('img');
                big.src = src;
                zoomEl.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    closeZoom();
                });
                // 阻止点击穿透到 mask（mask 点空白会关掉整个申请弹窗）
                zoomEl.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
                document.body.appendChild(zoomEl);
                document.addEventListener('keydown', onKey, true);
            }

            box.style.cursor = 'zoom-in';
            box.title = '点击查看大图';
            box.addEventListener('click', function (ev) {
                ev.stopPropagation();
                openZoom();
            });
        })();
        // 微信号（如需写死，改这一处即可）
        (function () {
            var wxId = '';
            var span = q('licContactWxId');
            var row = q('licContactWx');
            if (!span || !row) return;
            if (wxId) span.textContent = wxId;
            else row.style.display = 'none';
        })();

        // 填充设备信息
        q('licReqDevName').textContent = LIC.deviceName();
        q('licReqDevId').textContent = LIC.deviceId();
        var st = LIC.state ? LIC.state() : {};
        q('licReqEmail').textContent = st.email || '(未登录)';

        // 外部调用时预设申请类型
        if (presetType) {
            try {
                var sel = q('licReqType');
                for (var i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].value === presetType) {
                        sel.selectedIndex = i;
                        break;
                    }
                }
            } catch (e) {}
        }

        function close() {
            if (mask.parentNode) mask.parentNode.removeChild(mask);
        }

        q('licReqClose').addEventListener('click', close);
        mask.addEventListener('click', function (ev) {
            if (ev.target === mask) close();
        });

        // 复制完整申请信息（可以直接发给管理员）
        q('licReqCopy').addEventListener('click', function () {
            var typeText = q('licReqType').options[q('licReqType').selectedIndex].text;
            var daysText = q('licReqDays').options[q('licReqDays').selectedIndex].text;
            var note = (q('licReqNote').value || '').trim();
            var txt = [
                '【vh-Atelier 授权申请】',
                '类型：' + typeText,
                '时长：' + daysText,
                '设备名称：' + LIC.deviceName(),
                '设备 ID：' + LIC.deviceId(),
                '账号：' + (st.email || '(未登录)'),
                note ? ('说明：' + note) : ''
            ].filter(Boolean).join('\n');

            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(txt);
                } else if (window.__copyText) {
                    window.__copyText(txt);
                }
                setMsg('✓ 申请信息已复制，可以直接发给管理员', 'ok');
            } catch (e) {
                setMsg('复制失败，请手动记录：\n' + txt, 'err');
            }
        });

        // 提交
        q('licReqSubmit').addEventListener('click', function () {
            var typeVal = q('licReqType').value;
            var daysVal = q('licReqDays').value;
            var note = (q('licReqNote').value || '').trim();

            if (note.length > 200) {
                setMsg('说明太长，请控制在 200 字以内', 'err');
                return;
            }

            var btn = q('licReqSubmit');
            btn.disabled = true;
            btn.textContent = '提交中…';
            setMsg('正在提交…');

            // 组装完整说明（服务器只存 message 字段）
            var typeText = q('licReqType').options[q('licReqType').selectedIndex].text;
            var daysText = q('licReqDays').options[q('licReqDays').selectedIndex].text;
            var full = '[类型]' + typeText + ' [时长]' + daysText +
                       (note ? (' [说明]' + note) : '') +
                       ' [设备]' + LIC.deviceName() + ' [设备ID]' + LIC.deviceId();

            LIC.requestAccess(full, st.email || '').then(function () {
                setMsg('✓ 申请已提交，管理员会在后台看到', 'ok');
                btn.textContent = '已提交';
                setTimeout(close, 1800);
            }).catch(function (e) {
                btn.disabled = false;
                btn.textContent = '提交申请';
                var m = e && e.message || '';
                if (/邮箱/.test(m)) {
                    setMsg('提交失败：需要先登录或填写邮箱。\n可以点「复制申请信息」直接发给管理员。', 'err');
                } else {
                    setMsg('提交失败：' + m + '\n可以点「复制申请信息」直接发给管理员。', 'err');
                }
            });
        });
    }


    // ---------- 启动检查 ----------
    function start() {
        var st = LIC.localStatus();

        // 有 token 且本地有效：直接用，后台静默校验（原有逻辑）
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
        request: function (presetType) {
            // 遮罩层可能已关闭（已授权状态），这时直接弹申请窗
            try { showRequestDialog(presetType); } catch (e) {
                console.log('[lic] 打开申请弹窗失败: ' + e.message);
            }
        },
        relock: function (reason) {
            unlocked = false;
            buildMask();
            msg(reason || '授权失效，请重新登录', 'err');
        },
        onUnlock: function (fn) { onUnlockCallbacks.push(fn); },
        isUnlocked: function () { return unlocked; }
    };

    // 本地不可用时，尝试用记住的密码自动登录
    function tryAutoLogin() {
        if (!LIC.autoLogin) return;
        var cr = (LIC.cred && LIC.cred()) || {};
        if (!cr.autoLogin) return;
        if (!cr.email || !cr.pwdEnc) return;
        // 界面先给出提示，避免用户以为卡住
        msg('正在自动登录…', '');
        busy(true, '自动登录中…');
        LIC.autoLogin().then(function (r) {
            busy(false);
            if (r && r.ok) {
                var st2 = LIC.localStatus();
                if (st2.canUse) { unlock(st2); return; }
            }
            // 自动登录失败：停在登录界面，把错误说清楚
            msg('自动登录失败（' + ((r && r.msg) || (r && r.reason) || '未知') + '），请手动登录', 'err');
        }).catch(function (e) {
            busy(false);
            msg('自动登录失败：' + (e && e.message), 'err');
        });
    }

    function boot() {
        start();
        // start 只在本地有效时才解锁；到这里如果还没解锁，试自动登录
        if (!unlocked) {
            var st = LIC.localStatus();
            if (!st.canUse) {
                // 需要遮罩才有界面，先确保遮罩存在
                // 注意：buildMask() 内部已经 bind() 过，这里不能再 bind()，
                // 否则每个按钮绑两次事件，点一下弹两个窗。
                buildMask();
                tryAutoLogin();
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        setTimeout(boot, 100);
    }
})();
