// vh-Atelier A · 项目面板 UI
// ==========================================================================
// 依赖 js/project.js（window.__vhProject）
// 三段式：配置 → 项目选择（勾集数）→ 本地项目列表
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
        el.editorName = document.getElementById('pjEditorName');
        el.excludeDirs = document.getElementById('pjExcludeDirs');
        el.autoOpen = document.getElementById('pjAutoOpen');
        el.copyTpl = document.getElementById('pjCopyTpl');
        el.btnSaveCfg = document.getElementById('pjSaveCfg');
        el.btnScan = document.getElementById('pjScan');
        el.projSel = document.getElementById('pjProjSel');
        el.epBox = document.getElementById('pjEpBox');
        el.epInfo = document.getElementById('pjEpInfo');
        el.btnAll = document.getElementById('pjEpAll');
        el.btnNone = document.getElementById('pjEpNone');
        el.btnCreate = document.getElementById('pjCreate');
        el.log = document.getElementById('pjLog');
        el.localList = document.getElementById('pjLocalList');
        el.localInfo = document.getElementById('pjLocalInfo');
        el.btnRefreshLocal = document.getElementById('pjRefreshLocal');
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

    // ---------- 选文件夹（复用 folderpicker.ps1） ----------
    function pickFolder(inputEl, onPicked) {
        var extRoot = '';
        try { if (csInterface) extRoot = csInterface.getSystemPath('extension'); } catch (e) {}
        if (!extRoot || !fs.existsSync(path.join(extRoot, 'jsx', 'folderpicker.ps1'))) {
            // 兜底：用 cep.fs
            try {
                var r = window.cep.fs.showOpenDialogEx(true, false, '选择文件夹', inputEl.value || '', []);
                if (r && r.data && r.data.length) {
                    inputEl.value = r.data[0];
                    if (onPicked) onPicked(r.data[0]);
                }
            } catch (e) {
                log('打开文件夹选择器失败：' + e.message, 'err');
            }
            return;
        }
        var os2 = require('os');
        var inFile = path.join(os2.tmpdir(), 'vh_pj_in_' + Date.now() + '.json');
        var outFile = path.join(os2.tmpdir(), 'vh_pj_out_' + Date.now() + '.json');
        try {
            fs.writeFileSync(inFile, JSON.stringify({
                path: inputEl.value || '', title: '选择文件夹'
            }), 'utf8');
        } catch (e) { log('写临时文件失败：' + e.message, 'err'); return; }

        var psPath = path.join(extRoot, 'jsx', 'folderpicker.ps1');
        var cmd = 'powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' + psPath +
                  '" -Ini "' + inFile + '" -Out "' + outFile + '"';
        require('child_process').exec(cmd, { windowsHide: true }, function () {
            var picked = '';
            try {
                if (fs.existsSync(outFile)) {
                    var j = JSON.parse(fs.readFileSync(outFile, 'utf8'));
                    picked = (j && j.path) || '';
                }
            } catch (e) {}
            try { fs.unlinkSync(inFile); } catch (e) {}
            try { fs.unlinkSync(outFile); } catch (e) {}
            if (picked) {
                inputEl.value = picked;
                if (onPicked) onPicked(picked);
            }
        });
    }

    // ---------- 配置 ----------
    var scanned = [];      // 扫描到的项目
    var curProject = null; // 当前选中

    function fillCfg() {
        var c = P.readCfg();
        el.nasDir.value = c.nasDir || '';
        el.localRoot.value = c.localRoot || '';
        el.templateDir.value = c.templateDir || '';
        el.prTemplate.value = c.prTemplate || '';
        el.editorName.value = c.editorName || '';
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
        c.editorName = (el.editorName.value || '').trim();
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

    // ---------- 扫描 ----------
    function doScan() {
        var c = saveCfg(true);
        if (!c) return;
        if (!c.nasDir) { log('请先设置「组内 NAS 目录」', 'err'); return; }
        if (!fs.existsSync(c.nasDir)) { log('NAS 目录不存在：' + c.nasDir, 'err'); return; }

        el.btnScan.disabled = true;
        el.btnScan.textContent = '扫描中…';
        el.projSel.innerHTML = '<option value="">（扫描中…）</option>';
        el.epBox.innerHTML = '';
        el.epInfo.textContent = '';

        log('开始扫描：' + c.nasDir);
        var t0 = Date.now();
        P.scanProjects(function (err, list) {
            el.btnScan.disabled = false;
            el.btnScan.textContent = '重新扫描';
            if (err) { log('扫描失败：' + err.message, 'err'); return; }
            scanned = list;
            log('扫描完成：' + list.length + ' 个项目（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）', 'ok');
            renderProjSel();
        });
    }

    function renderProjSel() {
        if (!scanned.length) {
            el.projSel.innerHTML = '<option value="">（没扫到项目，检查 NAS 目录与排除设置）</option>';
            return;
        }
        var html = '<option value="">（请选择项目）</option>';
        scanned.forEach(function (p, i) {
            var epTxt = p.episodes.length ? (p.episodes.length + ' 集') : '无素材';
            html += '<option value="' + i + '">' + escHtml(p.name) +
                    '　—　' + epTxt + (p.hasScript ? ' · 有剧本' : '') + '</option>';
        });
        el.projSel.innerHTML = html;
    }

    function escHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---------- 集数勾选 ----------
    function renderEpisodes() {
        var idx = el.projSel.value;
        el.epBox.innerHTML = '';
        curProject = null;
        if (idx === '' || !scanned[idx]) { el.epInfo.textContent = ''; el.btnCreate.disabled = true; return; }
        curProject = scanned[idx];
        var eps = curProject.episodes || [];
        if (!eps.length) {
            el.epInfo.textContent = '该项目未识别到素材集数（检查素材目录结构）';
            el.btnCreate.disabled = true;
            return;
        }
        el.btnCreate.disabled = false;
        var html = '';
        eps.forEach(function (n) {
            html += '<label class="pj-ep"><input type="checkbox" class="pj-epcb" value="' + n + '" checked>第' + n + '集</label>';
        });
        el.epBox.innerHTML = html;
        var editor = P.readCfg().editorName;
        el.epInfo.textContent = '共 ' + eps.length + ' 集' +
            (editor ? '（剪辑师：' + editor + '）' : '') +
            (curProject.hasScript ? ' · 含剧本' : '');
    }

    function checkedEpisodes() {
        var out = [];
        el.epBox.querySelectorAll('.pj-epcb').forEach(function (cb) {
            if (cb.checked) out.push(parseInt(cb.value, 10));
        });
        return out;
    }

    // ---------- 创建 ----------
    function doCreate() {
        if (!curProject) return;
        var c = saveCfg(true);
        var eps = checkedEpisodes();
        if (!eps.length) { log('请至少勾选一集', 'err'); return; }
        if (!c.localRoot) { log('请先设置「本地项目根目录」', 'err'); return; }
        if (!fs.existsSync(c.localRoot)) { log('本地项目根目录不存在：' + c.localRoot, 'err'); return; }

        el.btnCreate.disabled = true;
        el.btnCreate.textContent = '创建中…';
        log('──────── 开始创建：' + curProject.name + '（' + eps.join(',') + ' 集）────────');

        P.createProject({
            project: curProject,
            episodes: eps,
            onProgress: function (stage, done, total) {
                log('  ' + stage + '  ' + done + '/' + total);
            }
        }, function (err, res) {
            el.btnCreate.disabled = false;
            el.btnCreate.textContent = '创建本地项目';
            if (err) { log('创建失败：' + err.message, 'err'); return; }
            log('项目目录：' + res.projDir, 'ok');
            (res.steps || []).forEach(function (s) { log('  · ' + s); });
            if (res.prOpened) log('已用 Premiere Pro 打开工程', 'ok');
            log('──────── 创建完成 ────────', 'ok');
            renderLocalList();
        });
    }

    // ---------- 本地项目列表 ----------
    function renderLocalList() {
        P.listLocalProjects(function (err, list) {
            if (err) { el.localList.innerHTML = '<div class="hint">' + escHtml(err.message) + '</div>'; return; }
            el.localInfo.textContent = list.length ? ('共 ' + list.length + ' 个项目') : '还没有本地项目';
            if (!list.length) {
                el.localList.innerHTML = '<div class="hint">还没有本地项目。上面选个 NAS 项目创建吧。</div>';
                return;
            }
            var html = '';
            list.forEach(function (p) {
                html += '<div class="pj-card" data-dir="' + escHtml(p.dir) + '" data-title="' + escHtml(p.title) + '">' +
                    '<div class="pj-card-main">' +
                      '<div class="pj-card-name">' + escHtml(p.dirName) + '</div>' +
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
            // 绑定按钮
            el.localList.querySelectorAll('.pj-card').forEach(function (card) {
                var dir = card.getAttribute('data-dir');
                var title = card.getAttribute('data-title');
                card.querySelectorAll('[data-act]').forEach(function (b) {
                    b.onclick = function () {
                        var act = b.getAttribute('data-act');
                        if (act === 'script') {
                            // 复用 A 插件已有的剧本逻辑（在本地项目里找剧本）
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

    // 把该项目的 01原素材 导入当前 PR 工程素材箱（复用 media.js 的能力）
    function importMaterials(projDir) {
        var matDir = path.join(projDir, '01原素材');
        if (!fs.existsSync(matDir)) { log('该项目没有 01原素材 目录', 'err'); return; }
        if (!window.__vhMedia || !window.__vhMedia.importFolderTree) {
            // media.js 未暴露时，退回到提示
            log('素材导入模块未就绪（需在「素材库」面板加载后使用）', 'err');
            return;
        }
        log('开始导入素材：' + matDir);
        window.__vhMedia.importFolderTree(matDir, '原素材');
    }

    // ---------- 事件绑定 ----------
    function bind() {
        pick();
        if (!el.nasDir) return;   // 不在该面板

        el.btnSaveCfg.onclick = function () { saveCfg(false); };
        el.btnScan.onclick = doScan;
        el.btnRefreshLocal.onclick = renderLocalList;
        el.projSel.onchange = renderEpisodes;
        el.btnAll.onclick = function () {
            el.epBox.querySelectorAll('.pj-epcb').forEach(function (cb) { cb.checked = true; });
        };
        el.btnNone.onclick = function () {
            el.epBox.querySelectorAll('.pj-epcb').forEach(function (cb) { cb.checked = false; });
        };
        el.btnCreate.onclick = doCreate;

        // 四个浏览按钮
        var map = [
            ['pjBrowseNas', el.nasDir], ['pjBrowseLocal', el.localRoot],
            ['pjBrowseTemplate', el.templateDir], ['pjBrowsePr', el.prTemplate]
        ];
        map.forEach(function (m) {
            var b = document.getElementById(m[0]);
            if (b) b.onclick = function () { pickFolder(m[1], function () { saveCfg(true); }); };
        });

        fillCfg();
        renderLocalList();
    }

    // 面板显示时刷新
    window.__projectOnShow = function () {
        if (!el.nasDir) pick();
        renderLocalList();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
