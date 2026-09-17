// vh-Atelier 在线反馈 · 界面（中转版）
// 依赖：js/feedback.js（window.__vhFeedback）
// 入口：标题栏「📮 反馈」按钮
(function () {
    var el = function (id) { return document.getElementById(id); };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

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

        box.innerHTML =
            '<div class="fb-head">' +
              '<span class="fb-title">📮 在线反馈</span>' +
              '<span class="fb-repo" id="fbEndpoint" title="' + esc(cfg.endpoint) + '">' + esc(cfg.endpoint) + '</span>' +
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
              '<label class="fb-chk"><input type="checkbox" id="fbEnv" checked> 附带运行环境（插件版本 / 系统）</label>' +
              '<label class="fb-chk"><input type="checkbox" id="fbLogs" checked> 附带最近日志（末 40 行，便于排查）</label>' +
              '<div class="fb-status" id="fbStatus"></div>' +
            '</div>' +
            '<div class="fb-foot">' +
              '<span class="fb-hint" id="fbHint">提交后会在项目 Issue 区创建一条记录</span>' +
              '<button type="button" class="fb-btn" id="fbTest" title="检查反馈服务是否可达">测试连接</button>' +
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
        function setHint(t) {
            var h = el('fbHint');
            if (h) h.textContent = t;
        }

        el('fbClose').addEventListener('click', close);
        el('fbCancel').addEventListener('click', close);
        ov.addEventListener('click', function (e) { if (e.target === ov && !busy) close(); });

        Array.prototype.forEach.call(box.querySelectorAll('.fb-kind'), function (b) {
            b.addEventListener('click', function () {
                Array.prototype.forEach.call(box.querySelectorAll('.fb-kind'), function (x) { x.classList.remove('on'); });
                b.classList.add('on');
                kind = b.getAttribute('data-kind');
            });
        });

        // 测试连通性
        el('fbTest').addEventListener('click', function () {
            setStatus('正在测试连接…', '');
            window.__vhFeedback.ping(function (err, info) {
                if (err) { setStatus('✗ 连接失败：' + err.message, 'err'); return; }
                if (info && info.tokenReady === false) {
                    setStatus('⚠ 服务可达，但服务端未配置令牌，提交会失败', 'err');
                } else {
                    setStatus('✓ 服务可达（仓库 ' + (info && info.repo) + '）', 'ok');
                }
            });
        });

        // 提交
        el('fbSubmit').addEventListener('click', function () {
            if (busy) return;
            var title = (el('fbTitle').value || '').trim();
            if (!title) { setStatus('请填写标题', 'err'); el('fbTitle').focus(); return; }

            busy = true;
            el('fbSubmit').disabled = true;
            el('fbSubmit').textContent = '提交中…';
            setStatus('正在提交…', '');

            window.__vhFeedback.submit(
                kind, title, (el('fbDetail').value || ''),
                { withLogs: el('fbLogs').checked },
                function (err, res) {
                    busy = false;
                    el('fbSubmit').disabled = false;
                    el('fbSubmit').textContent = '提交';
                    if (err) { setStatus('✗ 提交失败：' + err.message, 'err'); return; }

                    var num = (res && res.number) ? ('#' + res.number) : '';
                    var u = (res && res.url) || '';
                    var s = el('fbStatus');
                    if (s) {
                        s.className = 'fb-status ok';
                        s.innerHTML = '✅ 已提交 ' + esc(num) +
                            (u ? '　<a href="#" id="fbOpen" style="color:#7fd68b;">在浏览器打开</a>' : '');
                        var op = el('fbOpen');
                        if (op) op.addEventListener('click', function (ev) {
                            ev.preventDefault();
                            try { require('child_process').exec('start "" "' + u + '"'); } catch (e) {}
                        });
                    }
                    setHint('感谢反馈！');
                    setTimeout(close, 2600);
                });
        });

        el('fbTitle').focus();

        // 打开时顺手探测一次（不阻塞）
        if (!cfg.isDefaultEndpoint) {
            window.__vhFeedback.ping(function (err, info) {
                if (!err && info && info.tokenReady === false) {
                    setHint('⚠ 服务端未配置令牌，暂时无法提交');
                }
            });
        }
    }

    function bind() {
        var btn = el('btnFeedback');
        if (!btn) return;
        btn.addEventListener('click', openDialog);
        try {
            var c = window.__vhFeedback && window.__vhFeedback.cfg();
            btn.title = c && c.isDefaultEndpoint
                ? '在线反馈（尚未配置中转地址，见 feedback.example.json）'
                : '在线反馈：提 Bug / 需求 / 意见，直接进项目 Issue 区';
        } catch (e) {}
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    window.__vhFeedbackUI = { open: openDialog };
})();
