// vh-Atelier 音频输出位置（朗读 / 声音克隆 共用）
//
// 为什么单独做一个模块：
//   朗读走 breeze.js，语音克隆走 clone.js，两套代码各自拼路径。
//   用户要的是「一个设置项管住所有产出」，所以把路径决策抽出来统一管，
//   两个模块都从这里取目录，改一处全局生效。
//
// 存储：collect/audio-out.json（主）+ localStorage（备），清缓存不丢设置。
// 校验：设置时立即试写，不可写的目录直接拒绝并说明原因。
// 兜底：没设置或设置失效时回到默认目录 <插件>/breeze/output。
(function () {
    'use strict';

    var fs, path, os, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        childProcess = require('child_process');
    } catch (e) { return; }

    var csInterface = null;
    try { csInterface = new CSInterface(); } catch (e) {}

    function extRoot() {
        var r = '';
        try { if (csInterface) r = csInterface.getSystemPath('extension') || ''; } catch (e) {}
        if (r) {
            // getSystemPath 可能返回 file:/// 形式，统一成普通路径
            if (/^file:\/\//i.test(r)) {
                try {
                    r = decodeURIComponent(r.replace(/^file:\/\/\//i, '').replace(/\//g, '\\'));
                } catch (e2) {}
            }
            if (fs.existsSync(r)) return r;
        }
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (e3) {}
        return '';
    }

    var ROOT = extRoot();
    var STORE = ROOT ? path.join(ROOT, 'collect', 'audio-out.json') : '';
    var LS_KEY = 'vh_audio_out_v1';
    var DEFAULT_DIR = ROOT ? path.join(ROOT, 'breeze', 'output') : '';

    function readStore() {
        var j = null;
        try {
            if (STORE && fs.existsSync(STORE)) j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
        } catch (e) {}
        if (!j) {
            try {
                var raw = localStorage.getItem(LS_KEY);
                if (raw) j = JSON.parse(raw);
            } catch (e) {}
        }
        return (j && typeof j === 'object') ? j : {};
    }

    function writeStore(j) {
        var s = JSON.stringify(j);
        try { localStorage.setItem(LS_KEY, s); } catch (e) {}
        try {
            if (STORE) {
                var d = path.dirname(STORE);
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
                fs.writeFileSync(STORE, s, 'utf8');
            }
        } catch (e) {}
    }

    // 自定目录（没设置返回空串）
    function getCustom() {
        var j = readStore();
        return String(j.dir || '').trim();
    }

    function defaultDir() { return DEFAULT_DIR; }

    // 实际生效目录：自定且存在则用它，否则回默认
    function getDir() {
        var c = getCustom();
        if (c) return c;
        return DEFAULT_DIR;
    }

    // 目录是否可用（存在 + 能写）。不存在会尝试创建。
    function probe(dir) {
        if (!dir) return { ok: false, msg: '路径为空' };
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            return { ok: false, msg: '无法创建目录：' + (e.message || e) };
        }
        try {
            var t = path.join(dir, '.vh_write_test_' + Date.now());
            fs.writeFileSync(t, 'ok');
            fs.unlinkSync(t);
        } catch (e) {
            return { ok: false, msg: '目录不可写：' + (e.message || e) };
        }
        return { ok: true };
    }

    // 设置目录。空串 = 恢复默认。
    function setDir(dir) {
        var d = String(dir || '').trim();
        if (!d) {
            writeStore({ dir: '' });
            return { ok: true, dir: DEFAULT_DIR, reset: true };
        }
        // 规范化：去掉结尾反斜杠（盘符根 'D:\' 除外）
        d = d.replace(/[\\\/]+$/, '');
        if (/^[A-Za-z]:$/.test(d)) d += '\\';
        var r = probe(d);
        if (!r.ok) return { ok: false, msg: r.msg, dir: d };
        writeStore({ dir: d });
        return { ok: true, dir: d };
    }

    // 取目录并确保可用（生成前调用）
    function ensure() {
        var d = getDir();
        if (!d) return { ok: false, msg: '输出目录未确定（扩展根路径没取到）', dir: '' };
        var r = probe(d);
        if (!r.ok) {
            var isCustom = !!getCustom();
            return {
                ok: false,
                msg: r.msg + (isCustom ? '\n（这是你自定义的目录，可在设置里改回默认）' : ''),
                dir: d
            };
        }
        return { ok: true, dir: d };
    }

    // ---------- 目录选择器（复用插件的 folderpicker.ps1）----------
    function browse(initialDir, cb) {
        if (!childProcess) return cb('');
        var init = String(initialDir || '').trim();
        if (!init || !fs.existsSync(init)) {
            var par = init ? path.dirname(init) : '';
            init = (par && fs.existsSync(par)) ? par : '';
        }
        var psPath = ROOT ? path.join(ROOT, 'jsx', 'folderpicker.ps1') : '';
        if (!psPath || !fs.existsSync(psPath)) {
            // 没有选择器脚本就退到系统对话框
            try {
                var vbs = 'mshta "javascript:var f=new ActiveXObject(\'Shell.Application\');' +
                          'var d=f.BrowseForFolder(0,\'选择保存目录\',0,\'\');' +
                          'if(d)new ActiveXObject(\'Scripting.FileSystemObject\').CreateTextFile(\'' +
                          '__OUT__\',true).Write(d.Self.Path);close()"';
                return cb('');
            } catch (e) { return cb(''); }
        }

        var stamp = Date.now() + '_' + Math.floor(Math.random() * 1e6);
        var inFile = path.join(os.tmpdir(), 'vh_ao_in_' + stamp + '.json');
        var outFile = path.join(os.tmpdir(), 'vh_ao_out_' + stamp + '.txt');
        try {
            fs.writeFileSync(inFile, JSON.stringify({ path: init, title: '选择音频保存目录' }), 'utf8');
        } catch (e) {
            return cb('');
        }

        var cmd = 'powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' + psPath +
                  '" -Ini "' + inFile + '" -Out "' + outFile + '"';
        childProcess.exec(cmd, { windowsHide: true }, function (err) {
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

    // 打开目录（资源管理器）
    function openDir(dir) {
        var d = dir || getDir();
        if (!d) return false;
        try {
            childProcess.exec('explorer "' + d + '"');
            return true;
        } catch (e) { return false; }
    }

    // ---------- 设置 UI ----------
    // 往每个 .ao-mount 里渲染一份设置卡；不同挂载点用 data-ao 区分 id，避免重复 id。
    var listeners = [];

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderMount(mount) {
        var tag = mount.getAttribute('data-ao') || 'x';
        var idIn = 'aoDir_' + tag;
        var idBrowse = 'aoBrowse_' + tag;
        var idReset = 'aoReset_' + tag;
        var idOpen = 'aoOpen_' + tag;
        var idHint = 'aoHint_' + tag;

        mount.innerHTML = [
            '<div class="card ao-card">',
            '  <h2>音频保存位置</h2>',
            '  <div class="hint" style="margin:0 0 8px;">朗读与语音克隆的产物都保存到这里，两处共用同一个设置。</div>',
            '  <div class="row" style="gap:6px;align-items:center;">',
            '    <input type="text" id="' + idIn + '" placeholder="默认：插件目录\\breeze\\output" style="flex:1;">',
            '    <button id="' + idBrowse + '" class="secondary mini">浏览…</button>',
            '  </div>',
            '  <div class="row" style="margin-top:6px;gap:6px;">',
            '    <button id="' + idOpen + '" class="secondary mini" style="flex:1;">打开目录</button>',
            '    <button id="' + idReset + '" class="secondary mini" style="flex:1;">恢复默认</button>',
            '  </div>',
            '  <div class="hint" id="' + idHint + '"></div>',
            '</div>'
        ].join('');

        var inp = mount.querySelector('#' + idIn);
        var hint = mount.querySelector('#' + idHint);

        function setHint(t, cls) {
            if (!hint) return;
            hint.textContent = t || '';
            hint.style.color = cls === 'err' ? '#ff8a8a' : (cls === 'ok' ? '#7fd68b' : '');
        }

        function syncHint() {
            var c = getCustom();
            if (!c) {
                setHint('当前使用默认位置：' + DEFAULT_DIR);
            } else {
                var r = probe(c);
                if (r.ok) setHint('已自定义：' + c + '（点「打开目录」查看）');
                else setHint('⚠ 自定义目录不可用：' + r.msg + '，将回退默认位置', 'err');
            }
        }

        if (inp) inp.value = getCustom();

        // 输入框失焦 / 回车时保存
        function commit() {
            var v = (inp && inp.value || '').trim();
            var r = setDir(v);
            if (!r.ok) {
                setHint('✗ ' + r.msg, 'err');
                return;
            }
            if (inp) inp.value = getCustom();
            if (r.reset) setHint('已恢复默认位置：' + DEFAULT_DIR, 'ok');
            else setHint('✓ 已保存：' + r.dir, 'ok');
            notify();
        }
        if (inp) {
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            });
        }

        var bB = mount.querySelector('#' + idBrowse);
        if (bB) bB.addEventListener('click', function () {
            setHint('正在打开目录选择器…');
            browse(inp ? inp.value : '', function (p) {
                if (!p) { syncHint(); return; }
                if (inp) inp.value = p;
                commit();
            });
        });

        var bR = mount.querySelector('#' + idReset);
        if (bR) bR.addEventListener('click', function () {
            if (inp) inp.value = '';
            commit();
        });

        var bO = mount.querySelector('#' + idOpen);
        if (bO) bO.addEventListener('click', function () {
            var d = getDir();
            var r = probe(d);
            if (!r.ok) { setHint('✗ 目录不可用：' + r.msg, 'err'); return; }
            openDir(d);
        });

        syncHint();

        // 保存到可回调列表，供其它挂载点同步刷新
        listeners.push(function () {
            if (inp) inp.value = getCustom();
            syncHint();
        });
    }

    function notify() {
        listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
    }

    function mountAll() {
        var mounts = document.querySelectorAll('.ao-mount');
        Array.prototype.forEach.call(mounts, function (m) {
            if (m.getAttribute('data-ready') === '1') return;
            m.setAttribute('data-ready', '1');
            try { renderMount(m); } catch (e) {
                console.log('[ao] 渲染设置卡失败: ' + (e && e.message));
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountAll);
    } else {
        mountAll();
    }

    window.__vhAudioOut = {
        getDir: getDir,
        getCustom: getCustom,
        defaultDir: defaultDir,
        setDir: setDir,
        ensure: ensure,
        probe: probe,
        browse: browse,
        openDir: openDir,
        mountAll: mountAll
    };
})();
