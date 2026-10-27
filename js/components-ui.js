// vh-Atelier 客户版 · 组件面板 UI
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }
    var el = {};

    function initEl() {
        el.list = $('cpList');
        el.recheck = $('cpRecheck');
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
                var btnDl = document.createElement('button');
                btnDl.className = 'secondary mini';
                btnDl.textContent = '⬇ 在线下载';
                btnDl.style.cssText = 'flex:1;font-size:11px;';
                btnDl.addEventListener('click', function () { startDownload(c, card, btnDl); });
                row.appendChild(btnDl);

                var btnNd = document.createElement('button');
                btnNd.className = 'secondary mini';
                btnNd.textContent = '📁 网盘';
                btnNd.style.cssText = 'flex:0 0 auto;font-size:11px;';
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
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    // 面板切过来时刷新
    window.__componentsOnShow = function () { render(); };

    window.__vhComponentsUI = { render: render };
})();
