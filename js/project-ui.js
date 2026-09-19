// vh-Atelier A · 项目面板 UI
// ==========================================================================
// 依赖 js/project.js（window.__vhProject）
// 结构：路径配置 → 项目列表（搜索/排序/选集弹窗）→ 运行进度 → 本地项目
(function () {
    if (!window.__vhProject) return;
    if (!document.getElementById('panel-project')) return;

    var fs, path;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }

    var P = window.__vhProject;
    var csInterface = (typeof CSInterface !== 'undefined') ? new CSInterface() : null;

    // ---------- 元素 ----------
    var el = {};
    function pick() {
        el.nasDir = document.getElementById('pjNasDir');
        el.localRoot = document.getElementById('pjLocalRoot');
        el.templateDir = document.getElementById('pjTemplateDir');
        el.prTemplate = document.getElementById('pjPrTemplate');
        el.excludeDirs = document.getElementById('pjExcludeDirs');
        el.autoOpen = document.getElementById('pjAutoOpen');
        el.copyTpl = document.getElementById('pjCopyTpl');
        el.btnSaveCfg = document.getElementById('pjSaveCfg');
        el.btnScan = document.getElementById('pjScan');
        el.search = document.getElementById('pjSearch');
        el.sortSel = document.getElementById('pjSort');
        el.sortDir = document.getElementById('pjSortDir');
        el.projList = document.getElementById('pjProjList');
        el.projCount = document.getElementById('pjProjCount');
        el.btnCreate = document.getElementById('pjCreate');
        el.selInfo = document.getElementById('pjSelInfo');
        el.log = document.getElementById('pjLog');
        el.localList = document.getElementById('pjLocalList');
        el.localInfo = document.getElementById('pjLocalInfo');
        el.btnRefreshLocal = document.getElementById('pjRefreshLocal');
        el.progWrap = document.getElementById('pjProgWrap');
        el.progBar = document.getElementById('pjProgBar');
        el.progTxt = document.getElementById('pjProgTxt');
        el.progPct = document.getElementById('pjProgPct');
    }

    function log(msg, kind) {
        if (!el.log) return;
        var line = document.createElement('div');
        line.textContent = msg;
        if (kind === 'err') line.style.color = '#fca5a5';
        else if (kind === 'ok') line.style.color = '#7fd68b';
        else line.style.color = '#cfcfcf';
        el.log.appendChild(line);
        el.log.scrollTop = el.log.scrollHeight;
        try { if (window.__vhLog) window.__vhLog.info('[project] ' + msg); } catch (e) {}
    }

    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---------- 统一进度 ----------
    function showProg(label, done, total) {
        if (!el.progWrap) return;
        el.progWrap.style.display = 'block';
        var pct = total > 0 ? Math.round(done / total * 100) : 0;
        if (pct > 100) pct = 100;
        if (el.progBar) el.progBar.style.width = pct + '%';
        if (el.progPct) el.progPct.textContent = pct + '%';
        if (el.progTxt) el.progTxt.textContent = label + (total > 1 ? '  (' + done + '/' + total + ')' : '');
    }
    function hideProg(delay) {
        if (!el.progWrap) return;
        setTimeout(function () {
            if (el.progWrap) el.progWrap.style.display = 'none';
            if (el.progBar) el.progBar.style.width = '0%';
            if (el.progTxt) el.progTxt.textContent = '';
            if (el.progPct) el.progPct.textContent = '';
        }, delay || 900);
    }
    function busy(on, text) {
        if (el.btnScan) {
            el.btnScan.disabled = !!on;
            if (on) el.btnScan.textContent = text || '处理中…';
        }
    }

    // ---------- 选文件夹 ----------
    // 注意：folderpicker.ps1 写出的是「纯文本路径」（不是 JSON），
    // 这里必须按文本读，media.js 也是这么做的。
    function pickFolder(inputEl, onPicked) {
        var extRoot = '';
        try { if (csInterface) extRoot = csInterface.getSystemPath('extension'); } catch (e) {}
        if (!extRoot) {
            try {
                var d = (typeof __dirname !== 'undefined') ? __dirname : '';
                if (d) extRoot = (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
            } catch (e) {}
        }
        var psPath = extRoot ? path.join(extRoot, 'jsx', 'folderpicker.ps1') : '';
        if (!psPath || !fs.existsSync(psPath)) {
            log('找不到文件夹选择器：' + (psPath || '(未定位到扩展目录)'), 'err');
            return;
        }
        var os2 = require('os');
        var stamp = Date.now() + '_' + Math.floor(Math.random() * 1e6);
        var inFile = path.join(os2.tmpdir(), 'vh_pj_in_' + stamp + '.json');
        var outFile = path.join(os2.tmpdir(), 'vh_pj_out_' + stamp + '.txt');
        try {
            fs.writeFileSync(inFile, JSON.stringify({
                path: inputEl.value || '', title: '选择文件夹'
            }), 'utf8');
        } catch (e) { log('写临时文件失败：' + e.message, 'err'); return; }

        var cmd = 'powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' + psPath +
                  '" -Ini "' + inFile + '" -Out "' + outFile + '"';
        require('child_process').exec(cmd, { windowsHide: true }, function (err) {
            var picked = '';
            try {
                if (fs.existsSync(outFile)) {
                    // 纯文本路径
                    picked = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
                }
            } catch (e) {}
            if (err && !picked) {
                log('文件夹选择器执行失败：' + (err.message || err), 'err');
            }
            try { fs.unlinkSync(inFile); } catch (e) {}
            try { fs.unlinkSync(outFile); } catch (e) {}
            if (picked) {
                inputEl.value = picked;
                if (onPicked) onPicked(picked);
            } else if (!err) {
                log('未选择文件夹（已取消）');
            }
        });
    }

    // ---------- 配置 ----------
    function fillCfg() {
        var c = P.readCfg();
        el.nasDir.value = c.nasDir || '';
        el.localRoot.value = c.localRoot || '';
        el.templateDir.value = c.templateDir || '';
        el.prTemplate.value = c.prTemplate || '';
        el.excludeDirs.value = (c.excludeDirs || []).join('、');
        el.autoOpen.checked = c.autoOpenPR !== false;
        el.copyTpl.checked = c.copyTemplate !== false;
    }

    function collectCfg() {
        var c = P.readCfg();
        c.nasDir = (el.nasDir.value || '').trim();
        c.localRoot = (el.localRoot.value || '').trim();
        c.templateDir = (el.templateDir.value || '').trim();
        c.prTemplate = (el.prTemplate.value || '').trim();
        c.excludeDirs = (el.excludeDirs.value || '').split(/[、,，\s]+/)
            .map(function (s) { return s.trim(); }).filter(Boolean);
        c.autoOpenPR = !!el.autoOpen.checked;
        c.copyTemplate = !!el.copyTpl.checked;
        return c;
    }

    function saveCfg(quiet) {
        var c = collectCfg();
        if (!P.writeCfg(c)) { log('配置保存失败（插件目录不可写？）', 'err'); return null; }
        if (!quiet) log('配置已保存', 'ok');
        return c;
    }

    // ---------- 状态 ----------
    var scanned = [];        // 扫描到的全部项目
    var view = [];           // 搜索/排序后的视图
    var curProject = null;   // 当前展开的项目
    var selEps = [];         // 当前勾选的集数
    var epModal = null;      // 选集弹窗节点

    // ---------- 扫描 ----------
    function doScan() {
        var c = saveCfg(true);
        if (!c) return;
        if (!c.nasDir) { log('请先设置「组内 NAS 目录」', 'err'); return; }
        if (!fs.existsSync(c.nasDir)) { log('NAS 目录不存在：' + c.nasDir, 'err'); return; }

        busy(true, '扫描中…');
        el.projList.innerHTML = '<div class="hint">正在扫描…</div>';
        if (el.projCount) el.projCount.textContent = '';
        curProject = null; selEps = [];
        renderSelInfo();

        log('开始扫描：' + c.nasDir);
        var t0 = Date.now();
        var lastUi = 0;
        P.scanProjects({
            onProgress: function (done, total, name) {
                showProg('扫描项目', done, total);
                // 每 120ms 才刷一次文字，避免刷屏
                var now = Date.now();
                if (now - lastUi > 120) {
                    lastUi = now;
                    if (el.progTxt) el.progTxt.textContent = '扫描项目 (' + done + '/' + total + ')  ' + (name || '');
                    log('  [' + done + '/' + total + '] ' + (name || ''), '');
                }
            },
            onSub: function (sub) {
                if (el.progTxt) el.progTxt.textContent = el.progTxt.textContent.replace(/\s+·\s+.*$/, '') + '  · ' + sub;
            }
        }, function (err, list) {
            busy(false);
            el.btnScan.textContent = '重新扫描';
            if (err) { hideProg(0); log('扫描失败：' + err.message, 'err'); return; }
            scanned = list || [];
            log('扫描完成：' + scanned.length + ' 个项目（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）', 'ok');
            showProg('扫描完成', 1, 1);
            hideProg(700);
            applyFilter();
        });
    }

    // ---------- 搜索 + 排序 ----------
    function applyFilter() {
        var kw = (el.search && el.search.value || '').trim().toLowerCase();
        var list = scanned;
        if (kw) {
            list = scanned.filter(function (p) {
                return String(p.name).toLowerCase().indexOf(kw) >= 0;
            });
        }
        var key = el.sortSel ? el.sortSel.value : 'name';
        var desc = el.sortDir ? el.sortDir.value === 'desc' : false;
        view = P.sortProjects(list, key, desc);
        renderProjList();
    }

    function epBadge(p) {
        var n = (p.episodes || []).length;
        if (p.error) return '<span class="pj-tag err">读取失败</span>';
        if (!n) return '<span class="pj-tag warn">无素材</span>';
        return '<span class="pj-tag ok">' + n + ' 集</span>';
    }

    function renderProjList() {
        if (!el.projList) return;
        if (!scanned.length) {
            el.projList.innerHTML = '<div class="hint">没扫到项目。检查 NAS 目录与「排除目录」设置，或点右上角重新扫描。</div>';
            if (el.projCount) el.projCount.textContent = '';
            return;
        }
        if (!view.length) {
            el.projList.innerHTML = '<div class="hint">没有匹配「' + escHtml(el.search.value) + '」的项目</div>';
            if (el.projCount) el.projCount.textContent = '0 / ' + scanned.length;
            return;
        }
        if (el.projCount) el.projCount.textContent = view.length + ' / ' + scanned.length + ' 个项目';

        var html = '';
        view.forEach(function (p) {
            var isCur = curProject && curProject.dir === p.dir;
            html += '<div class="pj-item' + (isCur ? ' on' : '') + '" data-i="' + scanned.indexOf(p) + '">' +
                '<div class="pj-item-main">' +
                  '<div class="pj-item-name" title="' + escHtml(p.name) + '">' + escHtml(p.name) + '</div>' +
                  '<div class="pj-item-meta">' + epBadge(p) +
                    (p.hasScript ? '<span class="pj-tag script">有剧本</span>' : '') +
                  '</div>' +
                '</div>' +
                '<button class="pj-mini pj-pick" data-i="' + scanned.indexOf(p) + '">选集 ▸</button>' +
              '</div>';
        });
        el.projList.innerHTML = html;

        el.projList.querySelectorAll('.pj-item').forEach(function (node) {
            node.onclick = function (ev) {
                // 点按钮不触发整行
                if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-i') !== null &&
                    ev.target.classList && ev.target.classList.contains('pj-pick')) return;
                var i = parseInt(node.getAttribute('data-i'), 10);
                openEpModal(scanned[i]);
            };
        });
        el.projList.querySelectorAll('.pj-pick').forEach(function (b) {
            b.onclick = function (ev) {
                if (ev && ev.stopPropagation) ev.stopPropagation();
                var i = parseInt(b.getAttribute('data-i'), 10);
                openEpModal(scanned[i]);
            };
        });
    }

    // ---------- 选集弹窗 ----------
    function renderSelInfo() {
        if (!el.selInfo) return;
        if (!curProject) { el.selInfo.textContent = '未选择项目'; el.btnCreate.disabled = true; return; }
        if (!selEps.length) {
            el.selInfo.innerHTML = '<b>' + escHtml(curProject.name) + '</b> · 未选集';
            el.btnCreate.disabled = true;
            return;
        }
        var eps = selEps.slice().sort(function (a, b) { return a - b; });
        var txt = eps.length > 12 ? (eps.slice(0, 12).join(',') + ' …') : eps.join(',');
        el.selInfo.innerHTML = '<b>' + escHtml(curProject.name) + '</b> · 已选 <b>' + eps.length +
            '</b> 集（' + txt + '）';
        el.btnCreate.disabled = false;
        el.btnCreate.textContent = '创建本地项目（' + eps.length + ' 集）';
    }

    function openEpModal(proj) {
        if (!proj) return;
        curProject = proj;
        var eps = (proj.episodes || []).slice();
        // 默认全选
        selEps = eps.slice();
        renderProjList();
        renderSelInfo();

        if (!eps.length) {
            log('「' + proj.name + '」未识别到集数（检查素材目录结构）', 'err');
            return;
        }
        closeEpModal();

        var mx = eps[eps.length - 1];
        var mn = eps[0];
        var body = '<div class="pj-md-head">' +
            '<span class="pj-md-title">' + escHtml(proj.name) + '</span>' +
            '<span class="pj-md-sub">共 ' + eps.length + ' 集</span>' +
            '<button class="pj-md-x" id="pjMdX">✕</button>' +
          '</div>' +
          '<div class="pj-md-range">' +
            '<span>批量选：</span>第<input type="number" id="pjMdFrom" min="' + mn + '" max="' + mx + '" value="' + mn + '" style="width:56px;">' +
            '<span>集 到 第</span><input type="number" id="pjMdTo" min="' + mn + '" max="' + mx + '" value="' + mx + '" style="width:56px;">' +
            '<span>集</span>' +
            '<button class="secondary mini" id="pjMdRangeOn">选中该范围</button>' +
            '<button class="secondary mini" id="pjMdRangeOff">取消该范围</button>' +
            '<span style="margin-left:auto;display:flex;gap:4px;">' +
              '<button class="secondary mini" id="pjMdAll">全选</button>' +
              '<button class="secondary mini" id="pjMdNone">全不选</button>' +
              '<button class="secondary mini" id="pjMdInvert">反选</button>' +
            '</span>' +
          '</div>' +
          '<div class="pj-md-body" id="pjMdBody"></div>' +
          '<div class="pj-md-foot">' +
            '<span id="pjMdCount" class="pj-md-cnt"></span>' +
            '<button class="primary mini" id="pjMdOk" style="margin-left:auto;">确定</button>' +
          '</div>';

        var mask = document.createElement('div');
        mask.className = 'pj-mask';
        mask.id = 'pjMask';
        var box = document.createElement('div');
        box.className = 'pj-modal';
        box.innerHTML = body;

        var host = document.getElementById('panel-project') || document.body;
        mask.appendChild(box);
        host.appendChild(mask);
        epModal = mask;

        var mdBody = document.getElementById('pjMdBody');
        function renderEps() {
            var html = '';
            eps.forEach(function (n) {
                html += '<label class="pj-ep"><input type="checkbox" class="pj-epcb" value="' + n + '"' +
                    (selEps.indexOf(n) >= 0 ? ' checked' : '') + '>第' + n + '集</label>';
            });
            mdBody.innerHTML = html;
            mdBody.querySelectorAll('.pj-epcb').forEach(function (cb) {
                cb.onchange = function () {
                    var n = parseInt(cb.value, 10);
                    var i = selEps.indexOf(n);
                    if (cb.checked && i < 0) selEps.push(n);
                    else if (!cb.checked && i >= 0) selEps.splice(i, 1);
                    updCount();
                };
            });
            updCount();
            function updCount() {
                var c = document.getElementById('pjMdCount');
                if (c) c.textContent = '已选 ' + selEps.length + ' / ' + eps.length + ' 集';
            }
        }
        function syncBoxes() {
            mdBody.querySelectorAll('.pj-epcb').forEach(function (cb) {
                var n = parseInt(cb.value, 10);
                cb.checked = selEps.indexOf(n) >= 0;
            });
            var c = document.getElementById('pjMdCount');
            if (c) c.textContent = '已选 ' + selEps.length + ' / ' + eps.length + ' 集';
        }
        function inRange(n, a, b) {
            var lo = Math.min(a, b), hi = Math.max(a, b);
            return n >= lo && n <= hi;
        }
        function readRange() {
            var a = parseInt(document.getElementById('pjMdFrom').value, 10);
            var b = parseInt(document.getElementById('pjMdTo').value, 10);
            if (isNaN(a)) a = mn;
            if (isNaN(b)) b = mx;
            return [a, b];
        }

        renderEps();

        document.getElementById('pjMdX').onclick = closeEpModal;
        mask.onclick = function (ev) { if (ev.target === mask) closeEpModal(); };
        document.getElementById('pjMdOk').onclick = function () {
            closeEpModal();
            renderSelInfo();
            log('已选「' + curProject.name + '」' + selEps.length + ' 集');
        };
        document.getElementById('pjMdAll').onclick = function () { selEps = eps.slice(); syncBoxes(); };
        document.getElementById('pjMdNone').onclick = function () { selEps = []; syncBoxes(); };
        document.getElementById('pjMdInvert').onclick = function () {
            var inv = [];
            eps.forEach(function (n) { if (selEps.indexOf(n) < 0) inv.push(n); });
            selEps = inv;
            syncBoxes();
        };
        document.getElementById('pjMdRangeOn').onclick = function () {
            var r = readRange();
            eps.forEach(function (n) {
                if (inRange(n, r[0], r[1]) && selEps.indexOf(n) < 0) selEps.push(n);
            });
            syncBoxes();
        };
        document.getElementById('pjMdRangeOff').onclick = function () {
            var r = readRange();
            selEps = selEps.filter(function (n) { return !inRange(n, r[0], r[1]); });
            syncBoxes();
        };
    }

    function closeEpModal() {
        if (epModal && epModal.parentNode) epModal.parentNode.removeChild(epModal);
        epModal = null;
    }

    // ---------- 创建 ----------
    var lastCreated = '';   // 刚创建的项目目录（用于标「新」）

    function doCreate() {
        if (!curProject) return;
        var c = saveCfg(true);
        if (!selEps.length) { log('请先选集（点项目的「选集 ▸」或「创建」按钮）', 'err'); return; }
        if (!c.localRoot) { log('请先设置「本地项目根目录」', 'err'); return; }
        if (!fs.existsSync(c.localRoot)) { log('本地项目根目录不存在：' + c.localRoot, 'err'); return; }

        el.btnCreate.disabled = true;
        el.btnCreate.textContent = '创建中…';
        log('──────── 开始创建：' + curProject.name + '（' + selEps.slice().sort(function (a, b) { return a - b; }).join(',') + ' 集）────────');

        P.createProject({
            project: curProject,
            episodes: selEps,
            onProgress: function (stage, done, total, detail) {
                showProg(stage, done, total);
                if (el.progTxt) el.progTxt.textContent = stage + (detail ? '  ' + detail : '') +
                    (total > 1 ? '  (' + done + '/' + total + ')' : '');
                if (done === 0 || done === total || stage !== lastStage) {
                    log('  ' + stage + (detail ? ' · ' + detail : '') + (total > 1 ? '  ' + done + '/' + total : ''));
                    lastStage = stage;
                }
            }
        }, function (err, res) {
            el.btnCreate.disabled = false;
            if (err) { renderSelInfo(); hideProg(0); log('创建失败：' + err.message, 'err'); return; }
            log('项目目录：' + res.projDir, 'ok');
            (res.steps || []).forEach(function (s) { log('  · ' + s); });
            if (res.prOpened) log('已用 Premiere Pro 打开工程', 'ok');
            log('──────── 创建完成 ────────', 'ok');
            showProg('创建完成', 1, 1);
            hideProg(900);
            // 自动刷新本地列表 + 标「新」
            lastCreated = res.projDir;
            renderLocalList();
            renderSelInfo();
        });
    }
    var lastStage = '';

    // ---------- 本地项目列表 ----------
    function renderLocalList() {
        P.listLocalProjects(function (err, list) {
            if (err) { el.localList.innerHTML = '<div class="hint">' + escHtml(err.message) + '</div>'; return; }
            el.localInfo.textContent = list.length ? ('共 ' + list.length + ' 个项目') : '还没有本地项目';
            if (!list.length) {
                el.localList.innerHTML = '<div class="hint">还没有本地项目。上面选个 NAS 项目创建吧。</div>';
                return;
            }
            // 刚创建的排最前（按 seq 已倒序，这里再把 lastCreated 提到首位）
            if (lastCreated) {
                var k = -1;
                list.forEach(function (p, i) { if (p.dir === lastCreated) k = i; });
                if (k > 0) { var one = list.splice(k, 1)[0]; list.unshift(one); }
            }
            var html = '';
            list.forEach(function (p) {
                var isNew = lastCreated && p.dir === lastCreated;
                html += '<div class="pj-card' + (isNew ? ' is-new' : '') + '" data-dir="' + escHtml(p.dir) + '" data-title="' + escHtml(p.title) + '">' +
                    '<div class="pj-card-main">' +
                      '<div class="pj-card-name">' + escHtml(p.dirName) +
                        (isNew ? '<span class="pj-new">NEW</span>' : '') + '</div>' +
                      '<div class="pj-card-sub">' + escHtml(p.dir) + '</div>' +
                    '</div>' +
                    '<div class="pj-card-acts">' +
                      '<button class="pj-mini" data-act="script">📖 剧本</button>' +
                      '<button class="pj-mini" data-act="import">📥 素材</button>' +
                      '<button class="pj-mini" data-act="open">📂 打开</button>' +
                    '</div>' +
                  '</div>';
            });
            el.localList.innerHTML = html;
            el.localList.querySelectorAll('.pj-card').forEach(function (card) {
                var dir = card.getAttribute('data-dir');
                var title = card.getAttribute('data-title');
                card.querySelectorAll('[data-act]').forEach(function (b) {
                    b.onclick = function () {
                        var act = b.getAttribute('data-act');
                        if (act === 'script') {
                            if (window.__vhScript && window.__vhScript.openScriptForProject) {
                                window.__vhScript.openScriptForProject(title);
                            } else {
                                log('剧本模块未就绪', 'err');
                            }
                        } else if (act === 'import') {
                            importMaterials(dir);
                        } else if (act === 'open') {
                            try { require('child_process').exec('explorer "' + dir + '"', { windowsHide: true }); }
                            catch (e) { log('打开失败：' + e.message, 'err'); }
                        }
                    };
                });
            });
        });
    }

    // 把项目的 01原素材 导入当前 PR 工程素材箱（复用 media.js 的能力）
    function importMaterials(projDir) {
        var matDir = path.join(projDir, '01原素材');
        if (!fs.existsSync(matDir)) { log('该项目没有 01原素材 目录', 'err'); return; }
        if (!window.__vhMedia || !window.__vhMedia.importFolderTree) {
            log('素材导入模块未就绪（先在「素材库」面板加载一次）', 'err');
            return;
        }
        log('开始导入素材：' + matDir);
        showProg('导入素材', 0, 1);
        try {
            window.__vhMedia.importFolderTree(matDir, '原素材');
        } catch (e) {
            log('导入失败：' + e.message, 'err');
        }
        showProg('导入素材', 1, 1);
        hideProg(1200);
    }

    // ---------- 事件绑定 ----------
    function bind() {
        pick();
        if (!el.nasDir) return;   // 不在该面板

        el.btnSaveCfg.onclick = function () { saveCfg(false); };
        el.btnScan.onclick = doScan;
        el.btnRefreshLocal.onclick = function () { lastCreated = ''; renderLocalList(); };
        el.btnCreate.onclick = doCreate;
        if (el.search) el.search.oninput = applyFilter;
        if (el.sortSel) el.sortSel.onchange = applyFilter;
        if (el.sortDir) el.sortDir.onchange = applyFilter;

        var map = [
            ['pjBrowseNas', el.nasDir], ['pjBrowseLocal', el.localRoot],
            ['pjBrowseTemplate', el.templateDir], ['pjBrowsePr', el.prTemplate]
        ];
        map.forEach(function (m) {
            var b = document.getElementById(m[0]);
            if (b) b.onclick = function () { pickFolder(m[1], function () { saveCfg(true); }); };
        });

        fillCfg();
        renderSelInfo();
        renderLocalList();
    }

    window.__projectOnShow = function () {
        if (!el.nasDir) pick();
        renderLocalList();
    };

    document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && epModal) closeEpModal();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
