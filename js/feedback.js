// vh-Atelier 在线反馈：把 Bug / 需求 / 其他意见提交到 GitHub Issues
//
// 原理：调 GitHub REST API 创建 issue（POST /repos/{owner}/{repo}/issues）
// 权限：需要一个 Fine-grained Token，只授予本仓库 Issues: Read and write
//       建议不要写死在代码里 —— 留空时读取 collect/feedback.json 的 token 字段
//
// 配置（在插件 collect/ 目录建 feedback.json）：
//   {
//     "token": "github_pat_xxx",         // 必填：提交用的令牌
//     "repo": "vhdaqd0410/vh-Atelier",   // 可选：默认取 version.json 的 repo
//     "labelPrefix": ""                  // 可选：给 issue 打标签前缀
//   }
//
// 提交内容：标题 / 正文 / 类型标签 / 自动附带的运行环境（插件版本、PR 版本、系统、最近日志）
(function () {
    var fs, path, os, https;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        https = require('https');
    } catch (e) { return; }

    var csInterface = (typeof CSInterface !== 'undefined') ? new CSInterface() : null;

    function extRoot() {
        var r = '';
        try { if (csInterface) r = csInterface.getSystemPath('systemPath' in SystemPath ? SystemPath.EXTENSION : 'extension'); } catch (_) {}
        if (r && fs.existsSync(r)) return r;
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (_) {}
        return '';
    }

    var ROOT = extRoot();
    // 配置位置（优先级从高到低）：
    //   1) collect/feedback.json —— 用户私有，不参与更新
    //   2) 插件根目录 feedback.json —— 同样不参与更新（.gitignore 已排除）
    //   3) 找不到 → 提示参考 feedback.example.json 模板
    var CFG_USER = ROOT ? path.join(ROOT, 'collect', 'feedback.json') : '';
    var CFG_ROOT = ROOT ? path.join(ROOT, 'feedback.json') : '';
    var CFG_SAMPLE = ROOT ? path.join(ROOT, 'feedback.example.json') : '';
    var VER_FILE = ROOT ? path.join(ROOT, 'version.json') : '';

    function readJson(p) {
        try {
            if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (e) {}
        return null;
    }
    function cfg() {
        var c = null, used = '';
        var j1 = readJson(CFG_USER);
        var j2 = readJson(CFG_ROOT);
        if (j1) { c = j1; used = CFG_USER; }
        else if (j2) { c = j2; used = CFG_ROOT; }
        else { c = {}; used = CFG_USER; }
        var v = readJson(VER_FILE) || {};
        return {
            token: String(c.token || '').trim(),
            repo: String(c.repo || v.repo || 'vhdaqd0410/vh-Atelier').trim(),
            labelPrefix: String(c.labelPrefix || ''),
            displayName: v.displayName || 'vh-Atelier',
            version: v.version || '?',
            cfgPath: used,
            samplePath: CFG_SAMPLE
        };
    }

    // ---------- 收集环境信息（附在 issue 正文里，方便定位） ----------
    function collectEnv() {
        var lines = [];
        var c = cfg();
        lines.push('- 插件：' + c.displayName + ' v' + c.version);
        // PR 版本：面板 JS 里拿不到 ExtendScript 的 app 对象，尝试从已知位置取
        try {
            if (typeof window !== 'undefined' && window.__vhPrVersion) {
                lines.push('- Premiere Pro：' + window.__vhPrVersion);
            }
        } catch (e) {}
        try { lines.push('- 系统：' + os.type() + ' ' + os.release() + ' (' + os.arch() + ')'); } catch (e) {}
        try { lines.push('- Node：' + process.versions.node); } catch (e) {}
        try {
            var d = new Date();
            var p = function (n) { return (n < 10 ? '0' : '') + n; };
            lines.push('- 时间：' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                       ' ' + p(d.getHours()) + ':' + p(d.getMinutes()));
        } catch (e) {}
        return lines.join('\n');
    }

    // 取最近日志（若有 errorlog 模块）
    function recentLogs(maxLines) {
        try {
            if (window.__vhLog && typeof window.__vhLog.tail === 'function') {
                var t = window.__vhLog.tail(maxLines || 40);
                if (t) return String(t);
            }
        } catch (e) {}
        // 退路：读 collect/error.log
        try {
            var f = ROOT ? path.join(ROOT, 'collect', 'error.log') : '';
            if (f && fs.existsSync(f)) {
                var raw = fs.readFileSync(f, 'utf8').split('\n');
                return raw.slice(-(maxLines || 40)).join('\n');
            }
        } catch (e) {}
        return '';
    }

    // ---------- GitHub API ----------
    function apiPost(apiPath, body, cb) {
        var c = cfg();
        if (!c.token) return cb(new Error('未配置反馈令牌：请复制 feedback.example.json 为 feedback.json 并填 token'));
        if (!c.repo || c.repo.indexOf('/') < 0) return cb(new Error('仓库配置无效：' + c.repo));

        var payload = JSON.stringify(body);
        var opts = {
            hostname: 'api.github.com',
            path: apiPath,
            method: 'POST',
            headers: {
                'User-Agent': 'vh-Atelier-feedback',
                'Accept': 'application/vnd.github+json',
                'Authorization': 'Bearer ' + c.token,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 30000
        };
        var req = https.request(opts, function (res) {
            var buf = '';
            res.on('data', function (d) { buf += d.toString(); });
            res.on('end', function () {
                var j = null;
                try { j = JSON.parse(buf); } catch (e) {}
                if (res.statusCode >= 200 && res.statusCode < 300 && j) return cb(null, j);
                var msg = (j && (j.message || j.error)) || ('HTTP ' + res.statusCode);
                if (res.statusCode === 401) msg = '令牌无效或已过期';
                else if (res.statusCode === 403) msg = '令牌权限不足（需 Issues 读写）或触发限流';
                else if (res.statusCode === 404) msg = '仓库不存在或无权限（' + cfg().repo + '）';
                else if (res.statusCode === 410) msg = 'Issues 功能已关闭';
                cb(new Error(msg));
            });
        });
        req.on('error', function (e) {
            cb(new Error('网络错误：' + e.message + '（需能访问 api.github.com）'));
        });
        req.on('timeout', function () {
            try { req.destroy(); } catch (e) {}
            cb(new Error('请求超时（网络到不了 api.github.com）'));
        });
        req.write(payload);
        req.end();
    }

    // ---------- 提交反馈 ----------
    // kind: 'bug' | 'idea' | 'other'
    function submitFeedback(kind, title, detail, cb) {
        var c = cfg();
        if (!title || !String(title).trim()) return cb(new Error('请填写标题'));
        var labels = [];
        if (kind === 'bug') labels.push('bug');
        else if (kind === 'idea') labels.push('enhancement');
        else labels.push('question');
        if (c.labelPrefix) labels = labels.map(function (l) { return c.labelPrefix + l; });

        var lines = [];
        lines.push(String(detail || '').trim() || '（未填写详细描述）');
        lines.push('');
        lines.push('---');
        lines.push('**运行环境**');
        lines.push(collectEnv());
        var logs = recentLogs(40);
        if (logs) {
            lines.push('');
            lines.push('<details><summary>最近日志（末 40 行）</summary>');
            lines.push('');
            lines.push('```');
            lines.push(logs);
            lines.push('```');
            lines.push('</details>');
        }

        apiPost('/repos/' + c.repo + '/issues', {
            title: String(title).trim(),
            body: lines.join('\n'),
            labels: labels
        }, cb);
    }

    function configured() {
        var c = cfg();
        return !!c.token;
    }

    window.__vhFeedback = {
        configured: configured,
        cfg: cfg,
        submit: submitFeedback,
        collectEnv: collectEnv,
        recentLogs: recentLogs
    };
})();
