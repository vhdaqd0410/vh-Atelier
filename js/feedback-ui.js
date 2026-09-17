// vh-Atelier 在线反馈 · 界面
// 依赖：js/feedback.js（window.__vhFeedback）
// 入口：标题栏「📮 反馈」按钮
(function () {
    var el = function (id) { return document.getElementById(id); };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    var KIND_LABEL = {
        bug: '🐞 Bug 反馈',
        idea: '💡 功能需求',
        other: '💬 其他意见'
    };

    function openDialog() {
        if (!window.__vhFeedback) {
            alert('反馈模块未加载（js/feedback.js 缺失）');
            return;
        }
        var ov = document.createElement('div');
        ov.className = 'log-overlay';
        ov.style.zIndex = '10001';

        var box = document.createElement('div');
        box.style.cssText = 'background:var(--panel);border:1px solid var(--border);border-radius:10px;' +
            'width:100%;max-width:560px;max-height:86vh;display:flex;flex-direction:column;overflow:hidden;';

        var cfg = window.__vhFeedback.cfg();
        var envText = window.__vhFeedback.collectEnv();
        var logs = window.__vhFeedback.recentLogs(40);

        box.innerHTML =
            '<div class="fb-head">' +
              '<span class="fb-title">📮 在线反馈</span>' +
              '<span class="fb-repo">' + esc(cfg.repo) + '</span>' +
              '<button type="button" class="log-x" id="fbClose" title="关闭">✕</button>' +
            '</div>' +
            '<div class="fb-body">' +
              '<div class="fb-row">' +
                '<span class="fb-lab">类型</span>' +
                '<div class="fb-kinds" id="fbKinds">' +
                  '<button type="button" class="fb-kind on" data-kind="bug">🐞 Bug</button>' +
                  '<button type="button" class="fb-kind" data-kind="idea">💡 需求</button>' +
                  '<button type="button" class="fb-kind" data-kind="other">💬 其他</button>' +
                '</div>' +
              '</div>' +
              '<div class="fb-row">' +
                '<span class="fb-lab">标题</span>' +
                '<input type="text" id="fbTitle" class="fb-input" placeholder="一句话概括（必填）" maxlength="120">' +
              '</div>' +
              '<div class="fb-row fb-row-top">' +
                '<span class="fb-lab">详情</span>' +
                '<textarea id="fbDetail" class="fb-textarea" rows="7" ' +
                  'placeholder="复现步骤 / 期望效果 / 实际情况。描述越具体，越容易定位。"></textarea>' +
              '</div>' +
              '<label class="fb-chk"><input type="checkbox" id="fbEnv" checked> 附带运行环境（插件版本 / PR 版本 / 系统）</label>' +
              '<label class="fb-chk"><input type="checkbox" id="fbLogs" checked> 附带最近日志（末 40 行，便于排查）</label>' +
              (cfg.token ? '' : '<div class="fb-warn">⚠ 未配置反馈令牌，无法提交。请在插件根目录或 <code>collect/feedback.json</code> 里填 <code>token</code>（见 <code>feedback.json</code> 模板里的说明）。</div>') +
              '<div class="fb-status" id="fbStatus"></div>' +
            '</div>' +
            '<div class="fb-foot">' +
              '<span class="fb-hint">提交后会创建一条 GitHub Issue，你可在仓库 Issue 区看到</span>' +
              '<button type="button" class="fb-btn" id="fbCancel">取消</button>' +
              '<button type="button" class="fb-btn pri" id="fbSubmit">提交</button>' +
            '</div>';

        ov.appendChild(box);
        document.body.appendChild(ov);

        var kind = 'bug';
        var busy = false;

        function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
        function setStatus(msg, cls) {
            var s = el('fbStatus');
            if (!s) return;
            s.className = 'fb-status' + (cls ? ' ' + cls : '');
            s.textContent = msg || '';
        }

        el('fbClose').addEventListener('click', close);
        el('fbCancel').addEventListener('click', close);
        ov.addEventListener('click', function (e) { if (e.target === ov && !busy) close(); });

        // 类型切换
        var kinds = box.querySelectorAll('.fb-kind');
        Array.prototype.forEach.call(kinds, function (b) {
            b.addEventListener('click', function () {
                Array.prototype.forEach.call(kinds, function (x) { x.classList.remove('on'); });
                b.classList.add('on');
                kind = b.getAttribute('data-kind');
            });
        });

        el('fbSubmit').addEventListener('click', function () {
            if (busy) return;
            var title = (el('fbTitle').value || '').trim();
            if (!title) { setStatus('请填写标题', 'err'); el('fbTitle').focus(); return; }

            var detail = (el('fbDetail').value || '').trim();
            // 按勾选拼装补充信息
            var extra = [];
            if (el('fbEnv').checked) extra.push('环境见下方');
            busy = true;
            el('fbSubmit').disabled = true;
            el('fbSubmit').textContent = '提交中…';
            setStatus('正在提交到 GitHub…', '');

            // 用 hook：临时改写 collectEnv / recentLogs 的返回值不现实，
            // 直接在这里把内容合并进 detail（未勾选时不带）
            var envOn = el('fbEnv').checked;
            var logsOn = el('fbLogs').checked;
            var body = detail || '（未填写详细描述）';
            if (envOn) {
                body += '\n\n---\n**运行环境**\n' + window.__vhFeedback.collectEnv();
            }
            if (logsOn) {
                var lg = window.__vhFeedback.recentLogs(40);
                if (lg) body += '\n\n<details><summary>最近日志（末 40 行）</summary>\n\n```\n' + lg + '\n```\n</details>';
            }

            // 直接调底层提交（自带一次环境附加，这里用 raw 版本避免重复）
            submitRaw(kind, title, body, function (err, res) {
                busy = false;
                el('fbSubmit').disabled = false;
                el('fbSubmit').textContent = '提交';
                if (err) {
                    setStatus('✗ 提交失败：' + err.message, 'err');
                    return;
                }
                var url = (res && res.html_url) || '';
                var num = (res && res.number) ? ('#' + res.number) : '';
                setStatus('✅ 已提交 ' + num + (url ? '（点击可打开）' : ''), 'ok');
                var s = el('fbStatus');
                if (s && url) {
                    s.innerHTML = '✅ 已提交 ' + esc(num) +
                        '　<a href="#" id="fbOpen" style="color:#7fd68b;">在浏览器打开</a>';
                    var op = el('fbOpen');
                    if (op) op.addEventListener('click', function (ev) {
                        ev.preventDefault();
                        try { require('child_process').exec('start "" "' + url + '"'); } catch (e) {}
                    });
                }
                setTimeout(close, 2500);
            });
        });

        el('fbTitle').focus();
    }

    // 用给定正文直接提交（不再重复附加环境）
    function submitRaw(kind, title, body, cb) {
        var fb = window.__vhFeedback;
        if (!fb) return cb(new Error('反馈模块未加载'));
        // 复用 feedback.js 的底层 POST：临时用一个包装
        var c = fb.cfg();
        if (!c.token) return cb(new Error('未配置反馈令牌'));

        var labels = [(kind === 'bug') ? 'bug' : (kind === 'idea' ? 'enhancement' : 'question')];
        try {
            var https = require('https');
            var payload = JSON.stringify({ title: title, body: body, labels: labels });
            var req = https.request({
                hostname: 'api.github.com',
                path: '/repos/' + c.repo + '/issues',
                method: 'POST',
                headers: {
                    'User-Agent': 'vh-Atelier-feedback',
                    'Accept': 'application/vnd.github+json',
                    'Authorization': 'Bearer ' + c.token,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                },
                timeout: 30000
            }, function (res) {
                var buf = '';
                res.on('data', function (d) { buf += d.toString(); });
                res.on('end', function () {
                    var j = null;
                    try { j = JSON.parse(buf); } catch (e) {}
                    if (res.statusCode >= 200 && res.statusCode < 300 && j) return cb(null, j);
                    var msg = (j && (j.message || j.error)) || ('HTTP ' + res.statusCode);
                    if (res.statusCode === 401) msg = '令牌无效或已过期';
                    else if (res.statusCode === 403) msg = '令牌权限不足（需 Issues 读写）或触发限流';
                    else if (res.statusCode === 404) msg = '仓库不存在或无权限（' + c.repo + '）';
                    cb(new Error(msg));
                });
            });
            req.on('error', function (e) { cb(new Error('网络错误：' + e.message + '（需能访问 api.github.com）')); });
            req.on('timeout', function () { try { req.destroy(); } catch (e) {} cb(new Error('请求超时')); });
            req.write(payload);
            req.end();
        } catch (e) {
            cb(new Error('提交异常：' + e.message));
        }
    }

    // 绑定标题栏按钮
    function bind() {
        var btn = el('btnFeedback');
        if (!btn) return;
        btn.addEventListener('click', function () {
            openDialog();
        });
        // 未配置令牌时给个视觉提示
        try {
            if (!window.__vhFeedback || !window.__vhFeedback.configured()) {
                btn.title = '在线反馈（需先在 feedback.json 里配置反馈令牌）';
            } else {
                btn.title = '在线反馈：提 Bug / 需求 / 意见，直接在 GitHub Issue 上跟进';
            }
        } catch (e) {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    window.__vhFeedbackUI = { open: openDialog };
})();
