// vh-Atelier 客户版 · 组件面板 UI
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }
    var el = {};

    function initEl() {
        el.list = $('cpList');
        el.recheck = $('cpRecheck');
        el.installBtn = $('cpInstallDir');

        el.ndCard = $('cpNetdiskCard');
        el.ndTip = $('cpNetdiskTip');
    }

    function fmtSize(bytes) {
        if (!bytes) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    // 渲染组件列表
    function render() {
        if (!el.list) return;
        var comps = window.__vhComponents;
        if (!comps) {
            el.list.innerHTML = '<div class="hint">组件模块未加载</div>';
            return;
        }

        var state = comps.checkAll();
        var ids = Object.keys(state);
        el.list.innerHTML = '';

        ids.forEach(function (id) {
            var it = state[id];
            var c = it.meta;
            var card = document.createElement('div');
            card.className = 'cp-item' + (it.ready ? ' is-ready' : '');
            card.style.cssText = 'padding:9px 10px;margin-bottom:7px;border-radius:6px;' +
                'border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);';

            // 标题行
            var head = document.createElement('div');
            head.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';
            var dot = document.createElement('span');
            dot.textContent = it.ready ? '✅' : '⬜';
            dot.style.cssText = 'flex:0 0 auto;font-size:12px;';
            head.appendChild(dot);
            var name = document.createElement('span');
            name.textContent = c.name;
            name.style.cssText = 'flex:1;font-size:12px;font-weight:600;color:' +
                (it.ready ? '#7fd68b' : '#cfd8e3') + ';';
            head.appendChild(name);
            var sz = document.createElement('span');
            sz.textContent = c.size;
            sz.style.cssText = 'flex:0 0 auto;font-size:10px;color:#8a9bab;';
            head.appendChild(sz);
            card.appendChild(head);

            // 说明
            var desc = document.createElement('div');
            desc.textContent = c.desc;
            desc.style.cssText = 'font-size:10.5px;color:#8a9bab;line-height:1.55;margin-bottom:7px;';
            card.appendChild(desc);

            // 按钮行
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:6px;align-items:center;';

            if (it.ready) {
                var okTag = document.createElement('span');
                okTag.textContent = '已就位';
                okTag.style.cssText = 'font-size:10.5px;color:#7fd68b;flex:1;';
                row.appendChild(okTag);
            } else {
                // 有在线地址才显示「在线下载」；只有网盘时直接给网盘按钮
                if (c.url) {
                    var btnDl = document.createElement('button');
                    btnDl.className = 'secondary mini';
                    btnDl.textContent = '⬇ 在线下载';
                    btnDl.style.cssText = 'flex:1;font-size:11px;';
                    btnDl.addEventListener('click', function () { startDownload(c, card, btnDl); });
                    row.appendChild(btnDl);
                }

                var btnNd = document.createElement('button');
                btnNd.className = 'secondary mini';
                btnNd.textContent = c.url ? '📁 网盘' : '📁 网盘下载';
                btnNd.style.cssText = (c.url ? 'flex:0 0 auto;' : 'flex:1;') + 'font-size:11px;';
                if (!c.url) {
                    btnNd.style.background = 'linear-gradient(180deg,#537d96,#3f6a87)';
                    btnNd.style.borderColor = 'rgba(138,180,255,.32)';
                    btnNd.style.color = '#f0f7ff';
                }
                btnNd.addEventListener('click', function () {
                    window.__vhComponents.netdiskHelp(c);
                });
                row.appendChild(btnNd);
            }
            card.appendChild(row);

            // 进度区（默认隐藏）
            var prog = document.createElement('div');
            prog.className = 'cp-prog';
            prog.style.cssText = 'display:none;margin-top:7px;';
            prog.innerHTML = '<div style="height:4px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;">' +
                '<i style="display:block;height:100%;width:0%;background:linear-gradient(90deg,#537d96,#8ab4ff);transition:width .3s;"></i></div>' +
                '<div class="cp-prog-text" style="font-size:10px;color:#8a9bab;margin-top:4px;"></div>';
            card.appendChild(prog);

            el.list.appendChild(card);
        });
    }

    function startDownload(c, card, btn) {
        var prog = card.querySelector('.cp-prog');
        var bar = prog.querySelector('i');
        var txt = prog.querySelector('.cp-prog-text');
        prog.style.display = '';
        btn.disabled = true;
        btn.textContent = '下载中…';

        window.__vhComponents.download(c,
            function (st) {
                bar.style.width = (st.percent || 0).toFixed(1) + '%';
                txt.textContent = fmtSize(st.done) + ' / ' + fmtSize(st.total) +
                    '  (' + (st.percent || 0).toFixed(1) + '%)' +
                    (st.speed ? '  ' + st.speed.toFixed(1) + ' MB/s' : '');
            },
            function (err) {
                if (err) {
                    txt.textContent = '下载失败：' + err.message + '（可点「网盘」用另一种方式）';
                    txt.style.color = '#ff8a8a';
                    btn.disabled = false;
                    btn.textContent = '重试';
                } else {
                    txt.textContent = '✓ 完成，正在校验…';
                    txt.style.color = '#7fd68b';
                    setTimeout(function () {
                        render();
                        // 通知相关面板重新检测
                        try { window.dispatchEvent(new Event('vhComponentsReady')); } catch (e) {}
                    }, 800);
                }
            });
    }

    function bind() {
        initEl();
        render();
        if (el.recheck) {
            el.recheck.addEventListener('click', function () {
                el.recheck.textContent = '检测中…';
                setTimeout(function () {
                    render();
                    el.recheck.textContent = '🔄 重新检测';
                }, 200);
            });
        }
        // 从解压目录安装：绑定要放在 bind() 里，doInstallFromDir 此时已定义
        if (el.installBtn) {
            el.installBtn.addEventListener('click', function () {
                doInstallFromDir();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    // 面板切过来时刷新
    window.__componentsOnShow = function () { render(); };

    window.__vhComponentsUI = { render: render };

    // ---------- 从解压目录安装 ----------
    // 复用插件里已验证的 folderpicker.ps1 选择目录，
    // 然后交给 __vhComponents.installFromDir 复制。
    function pickFolder(cb) {
        var fs, path, os2, cp;
        try {
            fs = require('fs');
            path = require('path');
            os2 = require('os');
            cp = require('child_process');
        } catch (e) { cb(''); return; }

        var extRoot = '';
        try {
            extRoot = new CSInterface().getSystemPath(SystemPath.EXTENSION) || '';
        } catch (e) {}

        // 兜底：从 __dirname 推导
        if (!extRoot || !fs.existsSync(path.join(extRoot, 'jsx', 'folderpicker.ps1'))) {
            try {
                var d = (typeof __dirname !== 'undefined') ? __dirname : '';
                if (d) {
                    var root = (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
                    if (fs.existsSync(path.join(root, 'jsx', 'folderpicker.ps1'))) extRoot = root;
                }
            } catch (e) {}
        }

        var psPath = path.join(extRoot || '', 'jsx', 'folderpicker.ps1');
        if (!psPath || !fs.existsSync(psPath)) { cb(''); return; }

        var stamp = Date.now() + '_' + Math.floor(Math.random() * 1e6);
        var inFile = path.join(os2.tmpdir(), 'vh_cp_in_' + stamp + '.json');
        var outFile = path.join(os2.tmpdir(), 'vh_cp_out_' + stamp + '.txt');

        try {
            fs.writeFileSync(inFile,
                JSON.stringify({ path: '', title: '选择解压出来的文件夹' }), 'utf8');
        } catch (e) { cb(''); return; }

        var cmd = 'powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' +
                  psPath + '" -Ini "' + inFile + '" -Out "' + outFile + '"';

        cp.exec(cmd, { windowsHide: true }, function () {
            try { fs.unlinkSync(inFile); } catch (e) {}
            var picked = '';
            try {
                if (fs.existsSync(outFile)) {
                    picked = String(fs.readFileSync(outFile, 'utf8') || '').trim();
                    try { fs.unlinkSync(outFile); } catch (e) {}
                }
            } catch (e) {}
            cb(picked);
        });
    }

    function doInstallFromDir() {
        var comps = window.__vhComponents;
        if (!comps || !comps.installFromDir) {
            alert('组件模块未加载');
            return;
        }

        var btn = el.installBtn;
        pickFolder(function (dir) {
            if (!dir) return;   // 用户取消

            if (btn) {
                btn.disabled = true;
                btn.textContent = '正在安装…';
            }

            // 让 UI 有机会刷新再开始复制
            setTimeout(function () {
                var res;
                try {
                    res = comps.installFromDir(dir, function (line) {
                        console.log('[组件安装] ' + line);
                    });
                } catch (e) {
                    res = { ok: false, msg: '安装出错：' + (e && e.message) };
                }

                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '📂 从解压目录安装';
                }

                if (res.ok) {
                    var lines = [res.msg, ''];
                    if (res.whisperReady) {
                        lines.push('✓ Whisper 组件已就位，可以用了。');
                        lines.push('现在去「声音」面板，抓取参考音频后会自动识别文字。');
                    } else if (res.partial) {
                        lines.push('这次只复制了一部分，whisper 还用不了。');
                        lines.push('请把完整的 bin 和 models 都放进去再试一次。');
                    } else {
                        lines.push('已复制，但检测仍未通过。');
                        lines.push('请确认目录结构是 bin\\whisper\\ 和 models\\ 。');
                    }
                    lines.push('');
                    lines.push('插件目录：' + (comps.extRoot || ''));
                    alert(lines.join('\n'));
                    render();
                } else {
                    alert(res.msg || '安装失败');
                }
            }, 60);
        });
    }

})();
