// vh-Atelier 本地去字幕（VSR = video-subtitle-remover）
//
// 与「去字幕」面板里的云端（火山 VOD）方案互补：
//   云端：不用装环境、效果稳，但按量付费且要上传
//   本地：免费、不上传，需要独立 venv + 显卡
//
// 本模块只做三件事：
//   1) 环境自检（VSR 目录 / venv / torch / CUDA）
//   2) 调 py/vsr_client.py 跑去字幕，实时转发进度
//   3) 把结果落到指定目录
//
// 不引 torch/paddle：全部通过子进程跑 VSR 自己的 venv，避免污染插件 Python 环境。
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path, cp, os;
    try {
        fs = require('fs');
        path = require('path');
        cp = require('child_process');
        os = require('os');
    } catch (e) { return; }

    var csInterface = (typeof window.__adobe_cep__ !== 'undefined') ? new CSInterface() : null;

    function extRoot() {
        var r = '';
        try { r = csInterface.getSystemPath('extension'); } catch (_) {}
        if (r && fs.existsSync(path.join(r, 'py', 'vsr_client.py'))) return r;
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) {
                var root2 = (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
                if (fs.existsSync(path.join(root2, 'py', 'vsr_client.py'))) return root2;
            }
        } catch (_) {}
        return r || '';
    }

    function scriptPath() {
        var root = extRoot();
        return root ? path.join(root, 'py', 'vsr_client.py') : '';
    }

    function pyExe() {
        // 调用器本身只需要标准库，用系统 Python 即可；
        // 真正的 VSR 依赖在它自己的 venv 里（由 vsr_client.py 定位）
        var cands = [
            'C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python313\\python.exe',
            'C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python310\\python.exe',
            'C:\\Program Files\\Python313\\python.exe',
            'C:\\Program Files\\Python310\\python.exe'
        ];
        for (var i = 0; i < cands.length; i++) {
            if (fs.existsSync(cands[i])) return cands[i];
        }
        try {
            var roots = [extRoot()];
            for (var j = 0; j < roots.length; j++) {
                if (!roots[j]) continue;
                var p = path.join(roots[j], 'runtime', 'python.exe');
                if (fs.existsSync(p)) return p;
            }
        } catch (_) {}
        try {
            var w = cp.spawnSync('where', ['python'], { encoding: 'utf8', windowsHide: true });
            if (w.status === 0 && w.stdout) {
                var f = String(w.stdout).split('\n')[0].trim();
                if (f) return f;
            }
        } catch (_) {}
        return 'python';
    }

    function log(msg, cls) {
        if (cls === 'err') {
            try { if (window.__vhLog) window.__vhLog.err('[vsr] ' + msg); } catch (e) {}
        }
        try {
            var el = document.getElementById('vLocalLog');
            if (el) {
                var d = document.createElement('div');
                d.className = cls || '';
                d.textContent = msg;
                el.appendChild(d);
                el.scrollTop = el.scrollHeight;
            }
        } catch (e) {}
    }

    // ---------- 环境自检 ----------
    var _ckCache = null;
    function check(force, cb) {
        if (_ckCache && !force) { cb(_ckCache); return; }
        var sp = scriptPath();
        if (!sp || !fs.existsSync(sp)) {
            cb({ ok: false, reasons: ['找不到 py/vsr_client.py（插件安装不完整）'] });
            return;
        }
        var py = pyExe();
        var out = '';
        var done = false;
        function finish(res) {
            if (done) return;
            done = true;
            _ckCache = res;
            cb(res);
        }
        try {
            var child = cp.spawn(py, [sp, 'check'], { windowsHide: true });
            var timer = setTimeout(function () {
                try { child.kill(); } catch (e) {}
                finish({ ok: false, reasons: ['自检超时（60s）'] });
            }, 90000);
            child.stdout.on('data', function (b) { out += String(b); });
            child.stderr.on('data', function (b) { out += String(b); });
            child.on('error', function (e) {
                clearTimeout(timer);
                finish({ ok: false, reasons: ['无法启动 Python: ' + e.message] });
            });
            child.on('close', function () {
                clearTimeout(timer);
                var res = null;
                var lines = String(out).split('\n');
                for (var i = lines.length - 1; i >= 0; i--) {
                    var t = lines[i].trim();
                    if (t.charAt(0) === '{') {
                        try { res = JSON.parse(t); break; } catch (e) {}
                    }
                }
                finish(res || { ok: false, reasons: ['自检输出无法解析'], raw: String(out).slice(-300) });
            });
        } catch (e) {
            finish({ ok: false, reasons: [String(e.message || e)] });
        }
    }

    // ---------- 探测视频（分辨率/时长）----------
    function probe(input, cb) {
        var sp = scriptPath();
        if (!sp) { cb(null); return; }
        var out = '';
        try {
            var child = cp.spawn(pyExe(), [sp, 'probe', '--input', input], { windowsHide: true });
            child.stdout.on('data', function (b) { out += String(b); });
            child.stderr.on('data', function (b) { out += String(b); });
            child.on('error', function () { cb(null); });
            child.on('close', function () {
                var lines = String(out).split('\n');
                for (var i = lines.length - 1; i >= 0; i--) {
                    var t = lines[i].trim();
                    if (t.charAt(0) === '{') {
                        try { cb(JSON.parse(t)); return; } catch (e) {}
                    }
                }
                cb(null);
            });
        } catch (e) { cb(null); }
    }

    // ---------- 执行去字幕 ----------
    // opts: { input, output, area:[[y0,y1,x0,x1]...]（<=1 为比例）, mode }
    // onEvent({stage:'start'|'progress'|'log'|'done', ...})
    // 返回 { kill() }
    function run(opts, onEvent) {
        var sp = scriptPath();
        if (!sp || !fs.existsSync(sp)) {
            onEvent({ stage: 'done', ok: false, error: '找不到 py/vsr_client.py' });
            return { kill: function () {} };
        }
        var args = [sp, 'run', '--input', opts.input];
        if (opts.output) args.push('--output', opts.output);
        if (opts.mode) args.push('--mode', opts.mode);
        (opts.area || []).forEach(function (a) {
            args.push('--area');
            a.forEach(function (v) { args.push(String(v)); });
        });
        args.push('--progress');

        var child;
        try {
            child = cp.spawn(pyExe(), args, { windowsHide: true });
        } catch (e) {
            onEvent({ stage: 'done', ok: false, error: String(e.message || e) });
            return { kill: function () {} };
        }
        var buf = '';
        function handle(chunk) {
            buf += String(chunk);
            var lines = buf.split('\n');
            buf = lines.pop();
            lines.forEach(function (ln) {
                ln = ln.trim();
                if (!ln || ln.charAt(0) !== '{') return;
                try { onEvent(JSON.parse(ln)); } catch (e) {}
            });
        }
        child.stdout.on('data', handle);
        child.stderr.on('data', handle);
        child.on('error', function (e) {
            onEvent({ stage: 'done', ok: false, error: '进程启动失败: ' + e.message });
        });
        child.on('close', function (code) {
            if (buf) handle('\n');
            // 若调用器没发 done（异常退出），补一个
            onEvent({ stage: '__closed', code: code });
        });
        return {
            kill: function () { try { child.kill(); } catch (e) {} }
        };
    }

    window.__vhVSR = {
        check: check,
        probe: probe,
        run: run,
        scriptPath: scriptPath,
        pyExe: pyExe,
        log: log
    };
})();
