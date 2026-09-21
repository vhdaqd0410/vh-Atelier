// vh-Atelier · 创建本地项目（主插件）
// ==========================================================================
// 把「视频工作台」的创建本地项目能力搬进插件，不用切去工作台。
//
// 走工作台已有的接口（插件本来就是工作台的前端）：
//   POST /api/project/<项目名>/create_local_project   异步启动
//   GET  /api/project/<项目名>/local_project_progress 轮询进度
//
// 工作台侧会：建「序号-项目名」文件夹 + 复制模板 + 拉我负责集数的素材/粗剪 + 副本
// 创建完成后可「📥 素材」把素材导进 PR 素材箱。
(function () {
    if (typeof window === 'undefined') return;
    var fs, path;
    try {
        fs = require('fs');
        path = require('path');
    } catch (e) { return; }

    var overlay = null;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---------- 进度弹窗 ----------
    function showModal(titleText) {
        closeModal();
        var mask = document.createElement('div');
        mask.id = 'vhLocalProjMask';
        mask.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.6);' +
            'z-index:10002;display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#202020;border:1px solid #3d3d3d;border-radius:8px;' +
            'width:min(460px,86vw);padding:14px 16px;box-shadow:0 12px 40px rgba(0,0,0,.6);' +
            'font-family:inherit;';
        box.innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
              '<span style="font-size:13px;font-weight:600;color:#e8e8e8;flex:1;min-width:0;' +
                'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                esc(titleText) + '</span>' +
              '<button id="vhLpX" style="background:none;border:none;color:#888;font-size:14px;' +
                'cursor:pointer;padding:0 4px;">✕</button>' +
            '</div>' +
            '<div id="vhLpStage" style="font-size:11px;color:#c8c8c8;margin-bottom:4px;min-height:16px;">准备中…</div>' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<div style="flex:1;height:6px;background:#151515;border-radius:3px;overflow:hidden;">' +
                '<div id="vhLpBar" style="height:100%;width:0;background:linear-gradient(90deg,#537d96,#7fb0cc);' +
                  'border-radius:3px;transition:width .18s;"></div>' +
              '</div>' +
              '<span id="vhLpPct" style="font-size:11px;color:#8ec4e0;font-weight:600;width:36px;' +
                'text-align:right;">0%</span>' +
            '</div>' +
            '<div id="vhLpMsg" style="font-size:10.5px;color:#9a9a9a;line-height:1.7;margin-top:8px;' +
              'max-height:150px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;"></div>' +
            '<div style="display:flex;gap:8px;margin-top:10px;">' +
              '<button id="vhLpClose2" class="secondary mini" style="margin-left:auto;display:none;">关闭</button>' +
            '</div>';
        mask.appendChild(box);
        document.body.appendChild(mask);
        overlay = mask;

        var x = document.getElementById('vhLpX');
        var c2 = document.getElementById('vhLpClose2');
        function closeAll() { closeModal(); }
        if (x) x.onclick = closeAll;
        if (c2) c2.onclick = closeAll;
        mask.addEventListener('mousedown', function (e) {
            if (e.target === mask) closeAll();
        });
    }

    function closeModal() {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        overlay = null;
    }

    function setProgress(stage, pct, msg, done) {
        var s = document.getElementById('vhLpStage');
        var b = document.getElementById('vhLpBar');
        var p = document.getElementById('vhLpPct');
        var m = document.getElementById('vhLpMsg');
        var btn = document.getElementById('vhLpClose2');
        if (s && stage != null) s.textContent = stage;
        if (b && pct != null) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
        if (p && pct != null) p.textContent = Math.round(pct) + '%';
        if (m && msg) {
            var d = document.createElement('div');
            d.textContent = msg;
            m.appendChild(d);
            m.scrollTop = m.scrollHeight;
        }
        if (btn && done) btn.style.display = '';
    }

    // ---------- 主流程 ----------
    // deps: { apiPost, apiGet, setStatus }
    function createLocalProject(projectName, deps) {
        if (!projectName) return;
        var apiPost = deps.apiPost, apiGet = deps.apiGet;
        var setStatus = deps.setStatus || function () {};

        showModal('创建本地项目 · ' + projectName);
        setProgress('正在提交…', 2, '');
        setStatus('正在创建「' + projectName + '」的本地项目…');

        apiPost('/api/project/' + encodeURIComponent(projectName) + '/create_local_project', {},
            function (err, r) {
                if (err) {
                    setProgress('提交失败', 0, '❌ ' + err.message, true);
                    setStatus('创建失败：' + err.message);
                    return;
                }
                if (!r || !r.ok) {
                    var msg = (r && r.message) || '创建失败';
                    setProgress('无法创建', 0, '❌ ' + msg, true);
                    setStatus(msg);
                    return;
                }
                setProgress('已开始创建', 5, '✅ ' + (r.message || '已开始'), false);
                poll(projectName, deps, 0);
            });
    }

    function poll(projectName, deps, n) {
        if (n > 900) {   // 最多轮询 ~15 分钟
            setProgress('超时', null, '⚠️ 轮询超时，请到工作台查看进度', true);
            return;
        }
        deps.apiGet('/api/project/' + encodeURIComponent(projectName) + '/local_project_progress',
            function (err, d) {
                if (err) {
                    setTimeout(function () { poll(projectName, deps, n + 1); }, 1000);
                    return;
                }
                var t = (d && d.task) || {};
                var st = t.status || '';
                var done = parseInt(t.done, 10) || 0;
                var total = parseInt(t.total, 10) || 0;
                var stage = t.stage || '';
                var pct = total > 0 ? (done / total * 100) : (st === 'done' ? 100 : 0);

                if (st === 'done' || st === 'error') {
                    if (st === 'done') {
                        setProgress('✅ 创建完成', 100, '');
                        var msg = t.message || '';
                        if (msg) setProgress(null, null, msg, false);
                        setProgress(null, null, '现在可以点该项目的「📥 素材」把素材导入 PR 素材箱，' +
                            '或点「🎬 工程」打开工程文件。', false);
                        deps.setStatus && deps.setStatus('本地项目创建成功：' + projectName);
                        setProgress(null, null, '', true);
                    } else {
                        setProgress('❌ 创建失败', 0, t.message || '未知错误', true);
                        deps.setStatus && deps.setStatus('创建失败：' + (t.message || ''));
                    }
                    try { if (deps.onDone) deps.onDone(st === 'done'); } catch (e) {}
                    return;
                }

                // 运行中
                var line = stage + (total > 1 ? ('  ' + done + '/' + total) : '');
                setProgress(line, pct, null, false);
                setTimeout(function () { poll(projectName, deps, n + 1); }, 700);
            });
    }

    window.__vhLocalProj = {
        create: createLocalProject,
        close: closeModal
    };
})();
