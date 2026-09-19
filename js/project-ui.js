// vh-Atelier A · 项目面板 UI
// ==========================================================================
// 依赖 js/project.js（window.__vhProject）
// 布局：配置（可折叠）→ [进行中项目 | 本地项目] 左右并排 → 日志（可最大化）
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
        el.prVersion = document.getElementById('pjPrVersion');
        el.autoOpen = document.getElementById('pjAutoOpen');
        el.copyTpl = document.getElementById('pjCopyTpl');
        el.copyRough = document.getElementById('pjCopyRough');
        el.btnSaveCfg = document.getElementById('pjSaveCfg');
        el.cfgBody = document.getElementById('pjCfgBody');
        el.cfgToggle = document.getElementById('pjCfgToggle');
        el.cfgSummary = document.getElementById('pjCfgSummary');
        el.btnScan = document.getElementById('pjScan');
        el.search = document.getElementById('pjSearch');
        el.sortSel = document.getElementById('pjSort');
        el.sortDir = document.getElementById('pjSortDir');
        el.projList = document.getElementById('pjProjList');
        el.projCount = document.getElementById('pjProjCount');
        el.btnCreate = document.getElementById('pjCreate');
        el.selInfo = document.getElementById('pjSelInfo');
        el.log = document.getElementById('pjLog');
        el.logWrap = document.getElementById('pjLogWrap');
        el.btnLogMax = document.getElementById('pjLogMax');
        el.localList = document.getElementById('pjLocalList');
        el.localInfo = document.getElementById('pjLocalInfo');
        el.btnRefreshLocal = document.getElementById('pjRefreshLocal');
        el.localMore = document.getElementById('pjLocalMore');
        el.localSort = document.getElementById('pjLocalSort');
        el.localSortDir = document.getElementById('pjLocalSortDir');
        el.scanInterval = document.getElementById('pjScanInterval');
        el.scanHint = document.getElementById('pjScanHint');
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

    // ---------- 选文件夹 / 选文件 ----------
    // 文件夹：folderpicker.ps1（输出为纯文本路径，不是 JSON）
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
                    picked = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
                }
            } catch (e) {}
            if (err && !picked) log('文件夹选择器执行失败：' + (err.message || err), 'err');
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

    // 选文件：用 CEP 自带对话框，不启 PowerShell（更快、更稳）
    // 注意 CEP 规范：fileTypes 是「扩展名字符串数组」，如 ['prproj']，
    // 不是 Electron 那种 [{name, extensions}] 对象（传错会导致选不到任何文件）。
    function pickFile(inputEl, title, exts, onPicked) {
        var res = null;
        var types = (exts || []).slice();
        if (!types.length) types = ['*'];
        try {
            res = window.cep.fs.showOpenDialogEx(
                false, false, title || '选择文件', inputEl.value || '', types, '', '选择');
        } catch (e) {
            log('打开文件选择器失败：' + e.message, 'err');
            return;
        }
        if (!res || (res.err && res.err !== 0)) {
            if (res && res.err && res.err !== 0) log('文件选择器返回错误码 ' + res.err, 'err');
            return;
        }
        var p = res.data && res.data.length ? res.data[0] : '';
        if (p) {
            inputEl.value = p;
            if (onPicked) onPicked(p);
        }
    }

    // ---------- 配置折叠 ----------
    function cfgSummaryText(c) {
        var bits = [];
        if (c.nasDir) bits.push('NAS: ' + c.nasDir);
        else bits.push('未设 NAS 目录');
        if (c.localRoot) bits.push('本地: ' + c.localRoot);
        return bits.join('　·　');
    }

    function setCfgCollapsed(collapsed) {
        if (!el.cfgBody) return;
        el.cfgBody.style.display = collapsed ? 'none' : '';
        if (el.cfgToggle) el.cfgToggle.textContent = collapsed ? '▸' : '▾';
        if (el.cfgSummary) el.cfgSummary.style.display = collapsed ? '' : 'none';
        try { localStorage.setItem('vh_pj_cfg_collapsed', collapsed ? '1' : '0'); } catch (e) {}
    }

    function fillCfg() {
        var c = P.readCfg();
        el.nasDir.value = c.nasDir || '';
        el.localRoot.value = c.localRoot || '';
        el.templateDir.value = c.templateDir || '';
        el.prTemplate.value = c.prTemplate || '';
        el.excludeDirs.value = (c.excludeDirs || []).join('、');
        el.autoOpen.checked = c.autoOpenPR !== false;
        el.copyTpl.checked = c.copyTemplate !== false;
        if (el.copyRough) el.copyRough.checked = c.copyRoughcut !== false;
        if (el.scanInterval) el.scanInterval.value = String(c.scanIntervalMin == null ? 30 : c.scanIntervalMin);
        fillPrVersions(c.prVersion);
        if (el.cfgSummary) el.cfgSummary.textContent = cfgSummaryText(c);
    }

    // 填充 PR 版本下拉（扫描本机装了几个版本）
    function fillPrVersions(curSel) {
        if (!el.prVersion) return;
        var all = [];
        try { all = P.listPREXE() || []; } catch (e) {}
        var html = '<option value="0">自动（最新版）</option>';
        all.forEach(function (v) {
            html += '<option value="' + v.version + '">Premiere Pro ' + v.version + '</option>';
        });
        el.prVersion.innerHTML = html;
        el.prVersion.value = String(curSel || 0);
        if (all.length && el.prVersion.title !== undefined) {
            el.prVersion.title = '检测到 ' + all.length + ' 个版本：' +
                all.map(function (x) { return x.version; }).join(' / ');
        }
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
        if (el.copyRough) c.copyRoughcut = !!el.copyRough.checked;
        if (el.scanInterval) {
            var _iv = parseInt(el.scanInterval.value, 10);
            c.scanIntervalMin = isNaN(_iv) ? 30 : Math.max(0, _iv);
        }
        c.prVersion = parseInt(el.prVersion ? el.prVersion.value : 0, 10) || 0;
        return c;
    }

    function saveCfg(quiet) {
        var before = P.readCfg();
        var c = collectCfg();
        if (!P.writeCfg(c)) { log('配置保存失败（插件目录不可写？）', 'err'); return null; }
        // NAS 目录或排除目录变了 → 原缓存失效
        if (before.nasDir !== c.nasDir ||
            JSON.stringify(before.excludeDirs || []) !== JSON.stringify(c.excludeDirs || [])) {
            P.clearScanCache();
            if (!quiet) log('扫描目录已变更，缓存已清除（下次将重新扫描）', '');
        }
        if (before.scanIntervalMin !== c.scanIntervalMin) scheduleAutoScan();
        if (el.cfgSummary) el.cfgSummary.textContent = cfgSummaryText(c);
        if (!quiet) {
            log('配置已保存', 'ok');
            // 保存后自动折叠，把空间让给列表
            setCfgCollapsed(true);
        }
        return c;
    }

    // ---------- 状态 ----------
    var scanned = [];        // 扫描到的全部项目
    var view = [];           // 搜索/排序后的视图
    var curProject = null;   // 当前选中的 NAS 项目
    var selEps = [];         // 当前勾选的集数
    var epModal = null;
    var lastCreated = '';
    var localAll = [];       // 本地项目全量
    var LOCAL_PAGE = 6;      // 本地项目首屏条数
    var localShown = LOCAL_PAGE;

    // ---------- 扫描 ----------
    function doScan(silent) {
        var c = saveCfg(true);
        if (!c) return;
        if (!c.nasDir) { log('请先设置「组内 NAS 目录」', 'err'); setCfgCollapsed(false); return; }
        if (!fs.existsSync(c.nasDir)) { log('NAS 目录不存在：' + c.nasDir, 'err'); return; }

        busy(true, '扫描中…');
        if (!silent) {
            el.projList.innerHTML = '<div class="hint">正在扫描…</div>';
            if (el.projCount) el.projCount.textContent = '';
            resetSelection();
        }

        log((silent ? '（自动）' : '') + '开始扫描：' + c.nasDir);
        var t0 = Date.now();
        var lastUi = 0;
        P.scanProjects({
            onProgress: function (done, total, name) {
                showProg('扫描项目', done, total);
                var now = Date.now();
                if (now - lastUi > 120) {
                    lastUi = now;
                    if (el.progTxt) el.progTxt.textContent = '扫描项目 (' + done + '/' + total + ')  ' + (name || '');
                    log('  [' + done + '/' + total + '] ' + (name || ''), '');
                }
            },
            onSub: function (sub) {
                if (el.progTxt) {
                    el.progTxt.textContent = el.progTxt.textContent.replace(/\s+·\s+.*$/, '') + '  · ' + sub;
                }
            }
        }, function (err, list) {
            busy(false);
            el.btnScan.textContent = '重新扫描';
            if (err) { hideProg(0); log('扫描失败：' + err.message, 'err'); return; }
            scanned = list || [];
            log('扫描完成：' + scanned.length + ' 个项目（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）', 'ok');
            // 落缓存：下次打开秒显，配置不变不再重扫
            if (P.writeScanCache(c, scanned)) log('已缓存扫描结果', '');
            updateScanHint();
            showProg('扫描完成', 1, 1);
            hideProg(700);
            applyFilter();
            renderLocalList();     // 左右并排，扫描后一起刷新
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
        if (el.projCount) el.projCount.textContent = view.length + ' / ' + scanned.length;

        var html = '';
        view.forEach(function (p) {
            var isCur = curProject && curProject.dir === p.dir;
            var i = scanned.indexOf(p);
            html += '<div class="pj-item' + (isCur ? ' on' : '') + '" data-i="' + i + '">' +
                '<div class="pj-item-main">' +
                  '<div class="pj-item-name" title="' + escHtml(p.name) + '">' + escHtml(p.name) + '</div>' +
                  '<div class="pj-item-meta">' + epBadge(p) +
                    (p.hasScript ? '<span class="pj-tag script">有剧本</span>' : '') +
                  '</div>' +
                '</div>' +
                '<button class="pj-mini pj-pick" data-i="' + i + '">选集 ▸</button>' +
              '</div>';
        });
        el.projList.innerHTML = html;

        el.projList.querySelectorAll('.pj-item').forEach(function (node) {
            node.onclick = function (ev) {
                var tgt = ev.target;
                if (tgt && tgt.classList && tgt.classList.contains('pj-pick')) return;
                openEpModal(scanned[parseInt(node.getAttribute('data-i'), 10)]);
            };
        });
        el.projList.querySelectorAll('.pj-pick').forEach(function (b) {
            b.onclick = function (ev) {
                if (ev && ev.stopPropagation) ev.stopPropagation();
                openEpModal(scanned[parseInt(b.getAttribute('data-i'), 10)]);
            };
        });
    }

    // ---------- 选中状态 ----------
    function resetSelection() {
        curProject = null;
        selEps = [];
        renderSelInfo();
        renderProjList();
    }

    function renderSelInfo() {
        if (!el.selInfo) return;
        if (!curProject) {
            el.selInfo.textContent = '未选择项目 · 点项目的「选集 ▸」开始';
            el.btnCreate.disabled = true;
            el.btnCreate.textContent = '创建本地项目';
            return;
        }
        if (!selEps.length) {
            el.selInfo.innerHTML = '<b>' + escHtml(curProject.name) + '</b> · 未选集';
            el.btnCreate.disabled = true;
            el.btnCreate.textContent = '创建本地项目';
            return;
        }
        var eps = selEps.slice().sort(function (a, b) { return a - b; });
        var txt = eps.length > 12 ? (eps.slice(0, 12).join(',') + ' …') : eps.join(',');
        el.selInfo.innerHTML = '<b>' + escHtml(curProject.name) + '</b> · 已选 <b>' + eps.length +
            '</b> 集（' + txt + '）';
        el.btnCreate.disabled = false;
        el.btnCreate.textContent = '创建本地项目（' + eps.length + ' 集）';
    }

    // ---------- 选集弹窗 ----------
    function openEpModal(proj) {
        if (!proj) return;
        var eps = (proj.episodes || []).slice();
        if (!eps.length) {
            log('「' + proj.name + '」未识别到集数（检查素材目录结构）', 'err');
            return;
        }
        curProject = proj;
        // 第一次看这个项目 → 默认全选；再看同一项目 → 保留上次勾选
        var isSame = (window.__pjLastProj === proj.dir);
        window.__pjLastProj = proj.dir;
        if (!isSame) {
            selEps = eps.slice();
        } else {
            selEps = selEps.filter(function (n) { return eps.indexOf(n) >= 0; });
            if (!selEps.length) selEps = eps.slice();
        }

        renderProjList();
        renderSelInfo();
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
            '<button class="secondary mini" id="pjMdRangeOn">只选该范围</button>' +
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

        function cnt() {
            var c = document.getElementById('pjMdCount');
            if (c) c.textContent = '已选 ' + selEps.length + ' / ' + eps.length + ' 集';
        }
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
                    cnt();
                };
            });
            cnt();
        }
        function syncBoxes() {
            mdBody.querySelectorAll('.pj-epcb').forEach(function (cb) {
                cb.checked = selEps.indexOf(parseInt(cb.value, 10)) >= 0;
            });
            cnt();
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

        // 「确定」→ 关弹窗 + 弹确认框（是否创建）
        document.getElementById('pjMdOk').onclick = function () {
            closeEpModal();
            renderSelInfo();
            if (!selEps.length) { log('没有勾选任何集数', 'err'); return; }
            confirmCreate();
        };
        document.getElementById('pjMdAll').onclick = function () { selEps = eps.slice(); syncBoxes(); };
        document.getElementById('pjMdNone').onclick = function () { selEps = []; syncBoxes(); };
        document.getElementById('pjMdInvert').onclick = function () {
            var inv = [];
            eps.forEach(function (n) { if (selEps.indexOf(n) < 0) inv.push(n); });
            selEps = inv;
            syncBoxes();
        };
        // 「只选该范围」= 清掉范围外 + 选中范围内（而不是叠加）
        document.getElementById('pjMdRangeOn').onclick = function () {
            var r = readRange();
            selEps = eps.filter(function (n) { return inRange(n, r[0], r[1]); });
            syncBoxes();
        };
    }

    function closeEpModal() {
        if (epModal && epModal.parentNode) epModal.parentNode.removeChild(epModal);
        epModal = null;
    }

    // ---------- 创建确认弹窗 ----------
    function confirmCreate() {
        if (!curProject || !selEps.length) return;
        var eps = selEps.slice().sort(function (a, b) { return a - b; });
        var txt = eps.length > 30 ? (eps.slice(0, 30).join('、') + ' …（共 ' + eps.length + ' 集）')
                                  : eps.join('、');

        var mask = document.createElement('div');
        mask.className = 'pj-mask';
        mask.id = 'pjConfirmMask';
        var box = document.createElement('div');
        box.className = 'pj-modal pj-confirm';
        box.innerHTML =
            '<div class="pj-md-head">' +
              '<span class="pj-md-title">确认创建本地项目</span>' +
              '<button class="pj-md-x" id="pjCfX">✕</button>' +
            '</div>' +
            '<div class="pj-cf-body">' +
              '<div class="pj-cf-row"><span class="pj-cf-k">项目</span>' +
                '<span class="pj-cf-v">' + escHtml(curProject.name) + '</span></div>' +
              '<div class="pj-cf-row"><span class="pj-cf-k">集数</span>' +
                '<span class="pj-cf-v"><b>' + eps.length + '</b> 集（' + escHtml(txt) + '）</span></div>' +
              '<div class="pj-cf-row"><span class="pj-cf-k">本地目录</span>' +
                '<span class="pj-cf-v">' + escHtml((P.readCfg().localRoot) || '(未设置)') + '</span></div>' +
              '<div class="pj-cf-row"><span class="pj-cf-k">PR 版本</span>' +
                '<span class="pj-cf-v">' + escHtml(prVersionLabel()) + '</span></div>' +
            '</div>' +
            '<div class="pj-md-foot">' +
              '<button class="secondary mini" id="pjCfNo">返回修改</button>' +
              '<button class="primary mini" id="pjCfYes" style="margin-left:auto;">开始创建</button>' +
            '</div>';

        var host = document.getElementById('panel-project') || document.body;
        mask.appendChild(box);
        host.appendChild(mask);

        function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
        document.getElementById('pjCfX').onclick = close;
        document.getElementById('pjCfNo').onclick = close;
        mask.onclick = function (ev) { if (ev.target === mask) close(); };
        document.getElementById('pjCfYes').onclick = function () { close(); doCreate(); };
    }

    function prVersionLabel() {
        var c = P.readCfg();
        var v = parseInt(c.prVersion || 0, 10);
        if (v) return 'Premiere Pro ' + v;
        var all = [];
        try { all = P.listPREXE() || []; } catch (e) {}
        return all.length ? ('自动（最新：' + all[0].version + '）') : '未检测到';
    }

    // ---------- 创建 ----------
    function doCreate() {
        if (!curProject) return;
        var c = saveCfg(true);
        if (!selEps.length) { log('请先选集', 'err'); return; }
        if (!c.localRoot) { log('请先设置「本地项目根目录」', 'err'); setCfgCollapsed(false); return; }
        if (!fs.existsSync(c.localRoot)) { log('本地项目根目录不存在：' + c.localRoot, 'err'); return; }

        var epsSnapshot = selEps.slice();
        el.btnCreate.disabled = true;
        el.btnCreate.textContent = '创建中…';
        log('──────── 开始创建：' + curProject.name + '（' +
            epsSnapshot.sort(function (a, b) { return a - b; }).join(',') + ' 集）────────');

        P.createProject({
            project: curProject,
            episodes: epsSnapshot,
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
            if (err) {
                el.btnCreate.disabled = false;
                renderSelInfo();
                hideProg(0);
                log('创建失败：' + err.message, 'err');
                return;
            }
            log('项目目录：' + res.projDir, 'ok');
            (res.steps || []).forEach(function (s) { log('  · ' + s); });
            if (res.prOpened) log('已用 Premiere Pro 打开工程', 'ok');
            log('──────── 创建完成 ────────', 'ok');
            showProg('创建完成', 1, 1);
            hideProg(900);
            lastCreated = res.projDir;
            // 建完就重置选择，按钮恢复初始文案
            resetSelection();
            localShown = LOCAL_PAGE;
            renderLocalList();
        });
    }
    var lastStage = '';

    // ---------- 本地项目列表（折叠 + 加载更多） ----------
    // 只默认展开「与扫描到的进行中项目对应」的那些，其余折叠
    function activeNames() {
        return scanned.map(function (p) { return String(p.name); });
    }

    function renderLocalList() {
        P.listLocalProjects(function (err, list) {
            if (err) { el.localList.innerHTML = '<div class="hint">' + escHtml(err.message) + '</div>'; return; }
            if (lastCreated) {
                var k = -1;
                list.forEach(function (p, i) { if (p.dir === lastCreated) k = i; });
                if (k > 0) { var one = list.splice(k, 1)[0]; list.unshift(one); }
            }
            // 排序（默认名称降序）
            var lk = el.localSort ? el.localSort.value : 'name';
            var ld = el.localSortDir ? el.localSortDir.value === 'asc' : false;   // 默认 desc
            var keepTop = lastCreated && list.length ? list[0].dir === lastCreated : false;
            var topOne = keepTop ? list.shift() : null;
            list = P.sortLocalProjects(list, lk, ld);
            if (topOne) list.unshift(topOne);   // 刚创建的重置最前
            localAll = list;

            var act = activeNames();
            function isActive(p) {
                var t = String(p.title || '');
                for (var i = 0; i < act.length; i++) {
                    if (t === act[i] || t.indexOf(act[i]) >= 0 || act[i].indexOf(t) >= 0) return true;
                }
                return false;
            }

            var activeList = list.filter(isActive);
            var otherList = list.filter(function (p) { return !isActive(p); });

            if (!list.length) {
                el.localInfo.textContent = '';
                el.localList.innerHTML = '<div class="hint">还没有本地项目。左边选个 NAS 项目创建吧。</div>';
                if (el.localMore) el.localMore.style.display = 'none';
                return;
            }

            var html = '';

            // A. 进行中（默认展开）
            html += '<div class="pj-lgroup"><div class="pj-lgroup-h">进行中' +
                '<span class="pj-lgroup-n">' + activeList.length + '</span></div>';
            if (!activeList.length) {
                html += '<div class="hint" style="padding:4px 2px;">' +
                    (scanned.length ? '没有与进行中项目对应的本地项目' : '先扫描左边的项目') + '</div>';
            } else {
                activeList.forEach(function (p) { html += cardHtml(p, true); });
            }
            html += '</div>';

            // B. 其他（默认折叠）
            if (otherList.length) {
                var collapsed = localStorage.getItem('vh_pj_local_collapsed') !== '0';
                var shown = collapsed ? 0 : localShown;
                html += '<div class="pj-lgroup"><div class="pj-lgroup-h" id="pjLocalTog" style="cursor:pointer;">' +
                    '其他（已完成）' +
                    '<span class="pj-lgroup-n">' + otherList.length + '</span>' +
                    '<span style="margin-left:auto;font-size:10px;color:#8a8a8a;">' +
                    (collapsed ? '▸ 展开' : '▾ 收起') + '</span></div>';
                if (!collapsed) {
                    otherList.slice(0, shown).forEach(function (p) { html += cardHtml(p, false); });
                    if (otherList.length > shown) {
                        html += '<button class="pj-loadmore" id="pjLoadMore">加载更多（还有 ' +
                            (otherList.length - shown) + ' 个）</button>';
                    }
                }
                html += '</div>';
            }

            el.localInfo.textContent = '共 ' + list.length + ' 个';
            el.localList.innerHTML = html;

            bindLocalCards();

            var tog = document.getElementById('pjLocalTog');
            if (tog) {
                tog.onclick = function () {
                    var c = localStorage.getItem('vh_pj_local_collapsed') !== '0';
                    try { localStorage.setItem('vh_pj_local_collapsed', c ? '0' : '1'); } catch (e) {}
                    if (c) localShown = LOCAL_PAGE;
                    renderLocalList();
                };
            }
            var more = document.getElementById('pjLoadMore');
            if (more) {
                more.onclick = function () { localShown += LOCAL_PAGE * 2; renderLocalList(); };
            }
            if (el.localMore) el.localMore.style.display = 'none';
        });
    }

    function cardHtml(p, isActive) {
        var isNew = lastCreated && p.dir === lastCreated;
        return '<div class="pj-card' + (isNew ? ' is-new' : '') + (isActive ? ' is-active' : '') +
            '" data-dir="' + escHtml(p.dir) + '" data-title="' + escHtml(p.title) + '">' +
            '<div class="pj-card-main">' +
              '<div class="pj-card-name">' + escHtml(p.dirName) +
                (isNew ? '<span class="pj-new">NEW</span>' : '') +
                (p.prproj ? '<span class="pj-tag script">有工程</span>' : '') +
              '</div>' +
              '<div class="pj-card-sub" title="' + escHtml(p.dir) + '">' + escHtml(p.dir) + '</div>' +
            '</div>' +
            '<div class="pj-card-acts">' +
              (p.prproj ? '<button class="pj-mini pj-strong" data-act="prproj">🎬 工程</button>' : '') +
              '<button class="pj-mini" data-act="script">📖 剧本</button>' +
              '<button class="pj-mini" data-act="import">📥 素材</button>' +
              '<button class="pj-mini" data-act="open">📂 目录</button>' +
            '</div>' +
          '</div>';
    }

    function bindLocalCards() {
        el.localList.querySelectorAll('.pj-card').forEach(function (card) {
            var dir = card.getAttribute('data-dir');
            var title = card.getAttribute('data-title');
            card.querySelectorAll('[data-act]').forEach(function (b) {
                b.onclick = function () {
                    var act = b.getAttribute('data-act');
                    if (act === 'prproj') {
                        openPrproj(dir, title);
                    } else if (act === 'script') {
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
    }

    // 打开项目里的工程文件（默认用配置的 PR 版本）
    function openPrproj(dir, title) {
        var prproj = '';
        try { prproj = P.findProjectFileSync(dir, 3); } catch (e) {}
        if (!prproj) { log('该项目里没找到 .prproj 工程文件', 'err'); return; }
        var c = P.readCfg();
        var r = P.openProjectFile(prproj, c.prVersion);
        if (r.ok) log('「' + (title || '') + '」' + r.msg, 'ok');
        else log('打开工程失败：' + r.msg, 'err');
    }

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

    // ---------- 日志最大化 ----------
    function toggleLogMax() {
        if (!el.logWrap) return;
        // 不依赖 classList.toggle 的返回值，用 contains 判断切换后的状态
        var willMax = !el.logWrap.classList.contains('pj-log-max');
        if (willMax) el.logWrap.classList.add('pj-log-max');
        else el.logWrap.classList.remove('pj-log-max');
        if (el.btnLogMax) el.btnLogMax.textContent = willMax ? '⤢ 还原' : '⤢ 最大化';
        if (willMax && el.log) el.log.scrollTop = el.log.scrollHeight;
    }

    // ---------- 事件绑定 ----------
    function bind() {
        pick();
        if (!el.nasDir) return;

        el.btnSaveCfg.onclick = function () { saveCfg(false); };
        el.btnScan.onclick = doScan;
        el.btnRefreshLocal.onclick = function () { lastCreated = ''; localShown = LOCAL_PAGE; renderLocalList(); };
        el.btnCreate.onclick = function () {
            if (curProject && selEps.length) confirmCreate();
            else log('请先点项目的「选集 ▸」选择集数', 'err');
        };
        if (el.search) el.search.oninput = applyFilter;
        if (el.sortSel) el.sortSel.onchange = applyFilter;
        if (el.sortDir) el.sortDir.onchange = applyFilter;
        if (el.localSort) el.localSort.onchange = function () { localShown = LOCAL_PAGE; renderLocalList(); };
        if (el.localSortDir) el.localSortDir.onchange = function () { localShown = LOCAL_PAGE; renderLocalList(); };
        if (el.btnLogMax) el.btnLogMax.onclick = toggleLogMax;
        if (el.cfgToggle) {
            el.cfgToggle.onclick = function () {
                var collapsed = el.cfgBody && el.cfgBody.style.display === 'none';
                setCfgCollapsed(!collapsed);
            };
        }

        // 文件夹选择
        [['pjBrowseNas', el.nasDir], ['pjBrowseLocal', el.localRoot], ['pjBrowseTemplate', el.templateDir]]
            .forEach(function (m) {
                var b = document.getElementById(m[0]);
                if (b) b.onclick = function () { pickFolder(m[1], function () { saveCfg(true); }); };
            });
        // PR 模板：选文件（.prproj）——exts 要传扩展名字符串数组
        var bp = document.getElementById('pjBrowsePr');
        if (bp) {
            bp.onclick = function () {
                pickFile(el.prTemplate, '选择 PR 模板工程（.prproj）', ['prproj'],
                    function (p) { saveCfg(true); log('已选择 PR 模板工程：' + p, 'ok'); });
            };
        }

        fillCfg();
        renderSelInfo();
        renderLocalList();

        // 配置区折叠状态（默认折叠，省空间）
        var saved = null;
        try { saved = localStorage.getItem('vh_pj_cfg_collapsed'); } catch (e) {}
        setCfgCollapsed(saved !== '0');
    }

    // 自动重扫定时器
    var autoScanTimer = null;

    function scheduleAutoScan() {
        if (autoScanTimer) { clearInterval(autoScanTimer); autoScanTimer = null; }
        var c = P.readCfg();
        var min = parseInt(c.scanIntervalMin, 10);
        if (!min || min <= 0) { updateScanHint(); return; }
        autoScanTimer = setInterval(function () {
            // 只在面板可见时自动扫，避免后台白耗
            var panel = document.getElementById('panel-project');
            if (panel && panel.style.display === 'none') return;
            doScan(true);
        }, min * 60000);
        updateScanHint();
    }

    function updateScanHint() {
        if (!el.scanHint) return;
        var c = P.readCfg();
        var min = parseInt(c.scanIntervalMin, 10) || 0;
        var cache = P.readScanCache();
        var age = P.cacheAgeMin(cache);
        var parts = [];
        if (cache && P.cacheValid(cache, c)) {
            parts.push('缓存：' + (age < 1 ? '刚刚' : Math.round(age) + ' 分钟前'));
        } else {
            parts.push('无可用缓存');
        }
        if (min > 0) parts.push('每 ' + min + ' 分钟自动重扫');
        else parts.push('仅手动扫描');
        el.scanHint.textContent = parts.join(' · ');
    }

    // 面板显示：先铺缓存（若有效），再按需扫描
    window.__projectOnShow = function () {
        if (!el.nasDir) pick();
        fillPrVersions(P.readCfg().prVersion);
        renderLocalList();
        scheduleAutoScan();
        loadFromCacheOrScan();
    };

    // 用缓存铺屏；配置变了或缓存太旧则自动扫一次
    function loadFromCacheOrScan() {
        var c = P.readCfg();
        if (!c.nasDir) { updateScanHint(); return; }
        var cache = P.readScanCache();
        if (cache && P.cacheValid(cache, c)) {
            scanned = cache.projects || [];
            view = scanned.slice();
            applyFilter();
            resetSelection();
            updateScanHint();
            log('已载入扫描缓存（' + scanned.length + ' 个项目，' +
                Math.round(P.cacheAgeMin(cache)) + ' 分钟前）', 'ok');
            // 缓存过期（超过自动重扫间隔，或超过 60 分钟）→ 后台静默重扫
            var min = parseInt(c.scanIntervalMin, 10) || 0;
            var limit = min > 0 ? min : 60;
            if (P.cacheAgeMin(cache) > limit) {
                log('缓存已过期，后台重新扫描…');
                doScan(true);
            }
            return;
        }
        // 没有可用缓存：首次自动扫一次（不再让用户手动点）
        updateScanHint();
        if (!scanned.length) doScan(true);
    }

    document.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') return;
        if (epModal) { closeEpModal(); return; }
        var cm = document.getElementById('pjConfirmMask');
        if (cm && cm.parentNode) cm.parentNode.removeChild(cm);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
