// vh-Atelier 全局错误日志
// 目的：插件里有大量 catch(e){} 静默吞异常，出错时没有任何痕迹，排障只能靠现象反推。
// 这里挂一个全局兜底：捕获未处理的 JS 错误、未处理的 Promise 拒绝、console.error，
// 统一写入 collect/error.log（运行时数据目录，已 .gitignore 排除，不会污染仓库）。
//
// 用法：
//   window.__vhLog.err('导出失败', err)   // 主动记录（推荐在关键流程的 catch 里调用）
//   window.__vhLog.warn('...')            // 记一条警告
//   window.__vhLog.info('...')            // 记一条信息
//   window.__vhLog.read()                 // 控制台读取最近 200 行
//   window.__vhLog.open()                 // 用系统默认程序打开日志文件
//   window.__vhLog.clear()                // 清空日志
(function () {
    var MAX_BYTES = 1024 * 1024;   // 超过 1MB 自动截断保留后半段
    var LOG_NAME = 'error.log';

    var fs, path, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        childProcess = require('child_process');
    } catch (e) {
        // 非 CEP 环境（浏览器调试）直接降级为仅 console
        window.__vhLog = {
            err: function (m, e) { try { console.error(m, e || ''); } catch (_) {} },
            warn: function (m) { try { console.warn(m); } catch (_) {} },
            info: function (m) { try { console.log(m); } catch (_) {} },
            read: function () { return []; },
            open: function () {},
            clear: function () {}
        };
        return;
    }

    // 日志目录：优先插件根目录下的 collect/
    var extRoot = '';
    try { extRoot = new CSInterface().getSystemPath(SystemPath.EXTENSION); } catch (e) {}
    var logDir = extRoot ? path.join(extRoot, 'collect') : '';
    var logFile = logDir ? path.join(logDir, LOG_NAME) : '';

    var sessionTag = null;
    function tag() {
        if (!sessionTag) {
            var d = new Date();
            sessionTag = 'S' + d.getHours() + d.getMinutes() + d.getSeconds();
        }
        return sessionTag;
    }

    function stamp() {
        var d = new Date();
        function p(n, w) { n = '' + n; while (n.length < w) n = '0' + n; return n; }
        return d.getFullYear() + '-' + p(d.getMonth() + 1, 2) + '-' + p(d.getDate(), 2) + ' ' +
            p(d.getHours(), 2) + ':' + p(d.getMinutes(), 2) + ':' + p(d.getSeconds(), 2) + '.' +
            p(d.getMilliseconds(), 3);
    }

    function ensureDir() {
        if (!logDir) return false;
        try {
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            return true;
        } catch (e) { return false; }
    }

    function truncateIfNeeded() {
        try {
            if (!logFile || !fs.existsSync(logFile)) return;
            var st = fs.statSync(logFile);
            if (st.size <= MAX_BYTES) return;
            // 保留后半段，前半段丢弃
            var buf = fs.readFileSync(logFile);
            var keep = buf.slice(Math.floor(buf.length / 2));
            fs.writeFileSync(logFile, '[日志超过 1MB，已截断保留后半段]\n', 'utf8');
            fs.appendFileSync(logFile, keep);
        } catch (e) {}
    }

    function stringify(v) {
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        if (typeof v === 'string') return v;
        if (v instanceof Error) return (v.message || '') + (v.stack ? '\n' + v.stack : '');
        try { return JSON.stringify(v); } catch (e) { return String(v); }
    }

    var writeCount = 0;
    function write(level, msg, extra) {
        var line = '[' + stamp() + '][' + tag() + '][' + level + '] ' + stringify(msg);
        if (extra !== undefined) line += ' | ' + stringify(extra);
        line += '\n';
        try { console.log('[vh-log] ' + line.trim()); } catch (e) {}
        if (!ensureDir()) return;
        try {
            fs.appendFileSync(logFile, line, 'utf8');
            // 每 200 条检查一次体积，避免频繁 statSync
            if (++writeCount % 200 === 0) truncateIfNeeded();
        } catch (e) {}
    }

    // ---------- 全局兜底捕获 ----------
    window.addEventListener('error', function (ev) {
        try {
            var where = (ev.filename || '') + (ev.lineno ? ':' + ev.lineno : '');
            write('ERROR', (ev.message || '未知错误') + ' @ ' + where, ev.error ? ev.error.stack : undefined);
        } catch (e) {}
    });

    window.addEventListener('unhandledrejection', function (ev) {
        try {
            var r = ev.reason;
            write('REJECT', (r && r.message) ? r.message : String(r), (r && r.stack) ? r.stack : undefined);
        } catch (e) {}
    });

    // 兜住 console.error（很多板块用它报错但没人看控制台）
    var origError = console.error;
    console.error = function () {
        try {
            var parts = [];
            for (var i = 0; i < arguments.length; i++) parts.push(stringify(arguments[i]));
            write('CONSOLE', parts.join(' '));
        } catch (e) {}
        try { origError.apply(console, arguments); } catch (e) {}
    };

    function readTail(maxLines) {
        maxLines = maxLines || 200;
        try {
            if (!logFile || !fs.existsSync(logFile)) return [];
            var txt = fs.readFileSync(logFile, 'utf8');
            var lines = txt.split(/\r?\n/).filter(function (l) { return l.trim(); });
            return lines.slice(-maxLines);
        } catch (e) { return []; }
    }

    window.__vhLog = {
        err: function (msg, e) { write('ERR', msg, e); },
        warn: function (msg, e) { write('WARN', msg, e); },
        info: function (msg, e) { write('INFO', msg, e); },
        read: function (n) {
            var lines = readTail(n);
            console.log('[vh-log] 最近 ' + lines.length + ' 条：\n' + lines.join('\n'));
            return lines;
        },
        open: function () {
            try {
                if (logFile && fs.existsSync(logFile)) childProcess.exec('start "" "' + logFile + '"');
                else console.log('[vh-log] 日志文件尚不存在：' + logFile);
            } catch (e) { console.log('[vh-log] 打开失败：' + e.message); }
        },
        clear: function () {
            try { if (logFile) fs.writeFileSync(logFile, '', 'utf8'); console.log('[vh-log] 已清空'); } catch (e) {}
        },
        path: function () { return logFile; }
    };

    window.__vhLog.info('插件已加载（扩展根目录：' + (extRoot || '未知') + '）');
})();
