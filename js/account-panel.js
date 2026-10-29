// vh-Atelier 账号与授权管理面板
//
// 解决的问题：
//   登录后没地方看剩余授权、没地方切账号、没地方申请续期
//
// 提供的功能：
//   · 查看当前账号、套餐、到期时间、剩余天数（环形进度）
//   · 查看已授权插件列表
//   · 查看当前设备绑定情况
//   · 申请续期 / 申请开通其他插件
//   · 重新校验（联网刷新状态）
//   · 退出登录 / 切换账号
(function () {
    'use strict';

    var LIC = window.__vhLicense;
    if (!LIC) { console.log('[account] 授权模块未加载'); return; }

    function $(id) { return document.getElementById(id); }
    var el = {};
    var refreshTimer = null;

    function initEl() {
        el.accountName = $('acName');
        el.accountEmail = $('acEmail');
        el.panel = $('panel-account');
        el.body = $('acBody');
        el.msg = $('acMsg');
    }

    function msg(t, cls) {
        if (!el.msg) return;
        el.msg.textContent = t || '';
        el.msg.className = 'ac-msg' + (cls ? ' ' + cls : '');
    }

    // 环形进度（剩余天数可视化）
    function ringHtml(remain, total) {
        var pct = total > 0 ? Math.max(0, Math.min(1, remain / total)) : 0;
        var r = 34;
        var c = 2 * Math.PI * r;
        var dash = c * pct;
        var color = pct > 0.3 ? '#7fd68b' : (pct > 0.1 ? '#e0b96a' : '#ff8a8a');
        return '<svg class="ac-ring" viewBox="0 0 84 84">' +
            '<circle cx="42" cy="42" r="' + r + '" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="6"/>' +
            '<circle cx="42" cy="42" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="6"' +
            ' stroke-dasharray="' + dash.toFixed(1) + ' ' + c.toFixed(1) + '"' +
            ' stroke-linecap="round" transform="rotate(-90 42 42)"/>' +
            '<text x="42" y="38" text-anchor="middle" fill="' + color + '" font-size="18" font-weight="700">' +
            remain + '</text>' +
            '<text x="42" y="55" text-anchor="middle" fill="#6f7c8a" font-size="9">天</text>' +
            '</svg>';
    }

    function fmtDate(ts) {
        if (!ts) return '—';
        try {
            var d = new Date(ts);
            return d.getFullYear() + '-' +
                   String(d.getMonth() + 1).padStart(2, '0') + '-' +
                   String(d.getDate()).padStart(2, '0');
        } catch (e) { return '—'; }
    }

    // 渲染整个面板
    function render() {
        if (!el.body) return;
        var st = LIC.state ? LIC.state() : {};
        var local = LIC.localStatus ? LIC.localStatus() : { canUse: false };

        if (!st.token) {
            el.body.innerHTML = [
                '<div class="ac-empty">',
                '  <div class="ac-empty-ic">🔒</div>',
                '  <div class="ac-empty-t">未登录</div>',
                '  <div class="ac-empty-d">登录后可以在这里查看授权状态、续期和切换账号</div>',
                '  <button class="ac-btn primary" id="acBtnLogin">去登录</button>',
                '</div>'
            ].join('');
            var b = $('acBtnLogin');
            if (b) b.addEventListener('click', function () {
                if (window.__vhLicenseUI) window.__vhLicenseUI.relock('请先登录');
            });
            return;
        }

        var remain = local.remainDays || 0;
        var exp = st.expiresAt || 0;
        // 总天数 = 从授权开始到到期（无开始时间就用剩余+已过，简化为按套餐估算）
        var total = 0;
        try {
            if (exp) {
                // 假设最长 365 天，按剩余推算环形比例更直观
                total = Math.max(remain, 365);
            }
        } catch (e) { total = 365; }

        var planName = { trial: '试用版', pro: '专业版', basic: '基础版' }[st.plan] || (st.plan || '未知');
        var plugins = st.plugins || [];

        var warn = '';
        if (remain <= 0) {
            warn = '<div class="ac-warn err">⚠ 授权已到期，请点下方「申请续期」</div>';
        } else if (remain <= 7) {
            warn = '<div class="ac-warn warn">⚠ 授权仅剩 ' + remain + ' 天，建议尽快续期</div>';
        }

        el.body.innerHTML = [
            warn,
            '<div class="ac-card">',
            '  <div class="ac-top">',
            '    <div class="ac-ring-wrap">' + ringHtml(remain, total) + '</div>',
            '    <div class="ac-info">',
            '      <div class="ac-row"><span>账号</span><b>' + (st.email || '—') + '</b></div>',
            '      <div class="ac-row"><span>套餐</span><b class="ac-plan">' + planName + '</b></div>',
            '      <div class="ac-row"><span>到期</span><b>' + fmtDate(exp) + '</b></div>',
            '      <div class="ac-row"><span>状态</span><b class="' +
                   (local.canUse ? 'ac-ok' : 'ac-err') + '">' +
                   (local.canUse ? '正常' : '不可用') + '</b></div>',
            '    </div>',
            '  </div>',
            '</div>',

            '<div class="ac-card">',
            '  <div class="ac-sec-title">已授权插件</div>',
            '  <div class="ac-plugins">',
            plugins.length
                ? plugins.map(function (p) {
                    var isThis = (p === LIC.PLUGIN_ID);
                    return '<span class="ac-tag' + (isThis ? ' cur' : '') + '">' +
                           (isThis ? '✓ ' : '') + p + '</span>';
                  }).join('')
                : '<span class="ac-none">无</span>',
            '  </div>',
            '</div>',

            '<div class="ac-card">',
            '  <div class="ac-sec-title">当前设备</div>',
            '  <div class="ac-row"><span>名称</span><b>' + LIC.deviceName() + '</b></div>',
            '  <div class="ac-row"><span>设备 ID</span><b class="lic-mono">' + LIC.deviceId() + '</b></div>',
            '</div>',

            '<div class="ac-btns">',
            '  <button class="ac-btn" id="acBtnRefresh">🔄 刷新状态</button>',
            '  <button class="ac-btn" id="acBtnRenew">📅 申请续期</button>',
            '  <button class="ac-btn" id="acBtnMore">➕ 开通其他插件</button>',
            '  <button class="ac-btn danger" id="acBtnLogout">🚪 退出登录</button>',
            '</div>'
        ].join('');

        bindBody();
    }

    function bindBody() {
        var b1 = $('acBtnRefresh');
        if (b1) b1.addEventListener('click', function () {
            b1.disabled = true;
            b1.textContent = '刷新中…';
            msg('');
            LIC.verify().then(function (r) {
                b1.disabled = false;
                b1.textContent = '🔄 刷新状态';
                if (r.ok) {
                    msg(r.offline ? ('离线状态，宽限期还剩 ' + r.remainDays + ' 天')
                                  : '✓ 授权状态已刷新', r.offline ? 'warn' : 'ok');
                    render();
                } else {
                    msg('刷新失败：' + (r.msg || '') + '（' + (r.reason || '') + '）', 'err');
                }
            }).catch(function (e) {
                b1.disabled = false;
                b1.textContent = '🔄 刷新状态';
                msg('刷新失败：' + e.message, 'err');
            });
        });

        var b2 = $('acBtnRenew');
        if (b2) b2.addEventListener('click', function () {
            openRequest('renew');
        });

        var b3 = $('acBtnMore');
        if (b3) b3.addEventListener('click', function () {
            openRequest('plugin');
        });

        var b4 = $('acBtnLogout');
        if (b4) b4.addEventListener('click', confirmLogout);
    }

    // 退出登录（二次确认 + 提示影响）
    function confirmLogout() {
        var mask = document.createElement('div');
        mask.className = 'lic-modal-mask';
        mask.innerHTML = [
            '<div class="lic-modal" style="max-width:340px;">',
            '  <div class="lic-modal-head">',
            '    <span class="lic-modal-title">退出登录</span>',
            '    <button class="lic-modal-x" id="loClose">✕</button>',
            '  </div>',
            '  <div class="lic-modal-body">',
            '    <div class="ac-logout-tip">',
            '      退出后需要重新登录才能使用插件。<br>',
            '      你的<b>音色库、设置和已下载的模型</b>不受影响。',
            '    </div>',
            '    <div class="lic-modal-foot">',
            '      <button class="lic-btn ghost" id="loCancel" style="flex:1;">取消</button>',
            '      <button class="lic-btn primary" id="loOk" style="flex:1;background:linear-gradient(180deg,#a85a5a,#873f3f);">确认退出</button>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');
        document.body.appendChild(mask);

        function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
        $('loClose').addEventListener('click', close);
        $('loCancel').addEventListener('click', close);
        mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

        $('loOk').addEventListener('click', function () {
            close();
            LIC.logout();
            msg('已退出登录', 'ok');
            render();
            // 立即锁回激活界面
            if (window.__vhLicenseUI) {
                window.__vhLicenseUI.relock('已退出登录，请重新登录');
            }
        });
    }

    // 打开申请弹窗（复用 license-ui 的实现，带上预设类型）
    function openRequest(presetType) {
        if (window.__vhLicenseUI && window.__vhLicenseUI.request) {
            window.__vhLicenseUI.request(presetType);
        } else {
            msg('申请功能未就绪', 'err');
        }
    }

    // 定时刷新（面板显示时每 5 分钟刷一次）
    function startAutoRefresh() {
        stopAutoRefresh();
        refreshTimer = setInterval(function () {
            if (el.panel && el.panel.style.display !== 'none') {
                LIC.verify().then(function () { render(); }).catch(function () {});
            }
        }, 5 * 60 * 1000);
    }
    function stopAutoRefresh() {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    }

    function bind() {
        initEl();
        if (!el.body) return;
        render();
        startAutoRefresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    // 切到账号面板时刷新
    // 账号面板每次显示：先按当前状态画，再联网校验后重画一次。
    // 之前登录成功后面板仍显示未登录，就是因为没有监听解锁事件，
    // 只能靠切走再切回来触发 render。
    window.__accountOnShow = function () {
        render();
        LIC.verify().then(function () { render(); }).catch(function () {});
    };

    // 授权状态一变（登录 / 卡密 / 自动登录 / 退出）立刻重画
    try {
        if (window.__vhLicenseUI && window.__vhLicenseUI.onUnlock) {
            window.__vhLicenseUI.onUnlock(function () {
                try { render(); } catch (e) {}
            });
        }
    } catch (e) {}

    window.__vhAccount = {
        render: render,
        openRequest: openRequest
    };
})();
