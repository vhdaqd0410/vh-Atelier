// vh-Atelier A · 项目素材拉取 + 本地项目创建
// ==========================================================================
// 做什么：
//   扫描组内 NAS 目录 → 列出进行中项目 → 选项目、勾集数
//   → 建本地项目文件夹（序号-项目名）+ 复制模板结构
//   → 按集号把素材/粗剪/剧本拉到本地
//   → 复制 PR 模板工程并改名，可选自动打开
//
// 为什么不复用视频工作台：
//   工作台是用户自用工具，其他人没装；且它是 Python 服务，
//   跨进程调用还要处理"服务没启动"，不如在插件内用 Node 直接做。
//
// 集号识别规则严格照搬工作台 local_project.py 的踩坑结论：
//   「第N集 xxx」         → N
//   「N-中文」/「N 中文」  → N
//   「NN_结构词」         → 不是集号（01_抽卡素材 是目录序号），必须排除
(function () {
    var fs, path, os, cp;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        cp = require('child_process');
    } catch (e) { return; }

    var csInterface = (typeof CSInterface !== 'undefined') ? new CSInterface() : null;

    function extRoot() {
        try {
            if (csInterface) {
                var r = csInterface.getSystemPath('extension');
                if (r && fs.existsSync(r)) return r;
            }
        } catch (e) {}
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (e) {}
        return '';
    }
    var ROOT = extRoot();

    // ---------- 配置（存 collect，更新不覆盖） ----------
    var CFG_FILE = ROOT ? path.join(ROOT, 'collect', 'project.json') : '';
    var DEFAULT_CFG = {
        nasDir: '',             // 组内 NAS 源目录
        localRoot: '',          // 本地项目根目录
        templateDir: '',        // 项目模板结构目录（给新人用的空壳模板）
        prTemplate: '',         // PR 模板工程 .prproj
        editorName: '',         // 我的剪辑师名
        excludeDirs: ['00已完成', '0000新人'],   // 扫描时排除的目录名
        autoOpenPR: true,       // 创建后自动用 PR 打开工程
        copyTemplate: true      // 复制模板结构
    };

    function readCfg() {
        try {
            if (CFG_FILE && fs.existsSync(CFG_FILE)) {
                var j = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
                var out = {};
                Object.keys(DEFAULT_CFG).forEach(function (k) {
                    out[k] = (j[k] === undefined) ? DEFAULT_CFG[k] : j[k];
                });
                return out;
            }
        } catch (e) {}
        return JSON.parse(JSON.stringify(DEFAULT_CFG));
    }
    function writeCfg(c) {
        try {
            var d = path.dirname(CFG_FILE);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2), 'utf8');
            return true;
        } catch (e) { return false; }
    }

    // ---------- 集号识别（照搬工作台规则） ----------
    var STRUCT_WORDS = ['抽卡素材', '抽卡', '单补镜头', '单补', '视频素材', '素材',
        '前期筹备', '制作明细', '工程成片', '成片交付', '交付',
        '备注', '评论', '分镜', '剧本', '脚本', '参考', '模板'];

    function extractEpisode(name) {
        if (!name) return null;
        // 1) 「第N集」最明确
        var m = name.match(/第\s*(\d{1,3})\s*集/);
        if (m) return parseInt(m[1], 10);
        // 2) 数字+下划线 → 结构目录序号，不是集号
        if (/^\d{1,3}_/.test(name)) return null;
        // 3) 「N-中文」或「N 中文」
        m = name.match(/^(\d{1,3})\s*[- 　]\s*([\u4e00-\u9fff])/);
        if (m) return parseInt(m[1], 10);
        return null;
    }

    function extractEditorFromDir(name) {
        var s = String(name || '');
        s = s.replace(/第\s*\d{1,3}\s*集/g, '');
        s = s.replace(/^\d{1,3}\s*[- 　]/, '');
        s = s.replace(/^-\s*/, '');
        return s.trim().replace(/^-+|-+$/g, '').trim();
    }

    // ---------- 目录递归查找 ----------
    function isDir(p) {
        try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
    }

    // 在 root 下递归找「名字含任一关键词」的目录（深度上限 4）
    function findDirs(root, keywords, maxDepth) {
        var out = [];
        var depthLimit = maxDepth || 4;
        (function walk(p, depth) {
            if (depth > depthLimit) return;
            var items;
            try { items = fs.readdirSync(p); } catch (e) { return; }
            items.forEach(function (name) {
                if (name.charAt(0) === '.') return;
                var full = path.join(p, name);
                if (!isDir(full)) return;
                var hit = keywords.some(function (k) { return name.indexOf(k) >= 0; });
                if (hit) out.push(full);
                else walk(full, depth + 1);
            });
        })(root, 0);
        return out;
    }

    // 在 folder 下递归找集号目录，返回 {集号: {dir, editor}}
    // 结构目录（集号为 null）继续往下钻
    function findEpisodeDirs(folder, maxDepth) {
        var result = {};
        var depthLimit = maxDepth || 4;
        (function walk(p, depth) {
            if (depth > depthLimit) return;
            var items;
            try { items = fs.readdirSync(p); } catch (e) { return; }
            items.forEach(function (name) {
                if (name.charAt(0) === '.') return;
                var full = path.join(p, name);
                if (!isDir(full)) return;
                var ep = extractEpisode(name);
                if (ep !== null) {
                    if (!result[ep]) {
                        result[ep] = { dir: full, editor: extractEditorFromDir(name) };
                    }
                } else {
                    walk(full, depth + 1);
                }
            });
        })(folder, 0);
        return result;
    }

    // 收集「集号-剪辑师.扩展名」形式的文件（粗剪常见）
    function collectEpisodeFiles(folder) {
        var result = {};
        var items;
        try { items = fs.readdirSync(folder); } catch (e) { return result; }
        items.forEach(function (name) {
            if (name.charAt(0) === '.') return;
            var full = path.join(folder, name);
            if (!isDir(full)) {
                var stem = name.replace(/\.[^.]+$/, '');
                var ep = extractEpisode(stem);
                if (ep !== null && !result[ep]) {
                    result[ep] = { file: full, editor: extractEditorFromDir(stem) };
                }
            }
        });
        return result;
    }

    // ---------- 项目扫描 ----------
    // 返回 [{name, dir, episodes:[1,2,3], materialDirs:[], hasScript:bool}]
    function scanProjects(cb) {
        var cfg = readCfg();
        var base = cfg.nasDir;
        if (!base || !isDir(base)) return cb(new Error('NAS 目录不存在：' + (base || '(未设置)')));
        var exclude = (cfg.excludeDirs || []).map(function (s) { return String(s).trim(); }).filter(Boolean);
        var list = [];
        var items;
        try { items = fs.readdirSync(base); } catch (e) { return cb(new Error('读取 NAS 目录失败：' + e.message)); }

        items.forEach(function (name) {
            if (name.charAt(0) === '.' || name.charAt(0) === '$') return;
            var full = path.join(base, name);
            if (!isDir(full)) return;
            // 排除目录（支持包含匹配，用户填 "00已完成" 也能排除 "00已完成(2025)"）
            if (exclude.some(function (ex) { return name.indexOf(ex) >= 0; })) return;

            var info = inspectProject(full, cfg);
            if (info) list.push(info);
        });
        list.sort(function (a, b) { return b.episodes.length - a.episodes.length; });
        cb(null, list);
    }

    // 探测单个项目的素材集数
    var MATERIAL_KW = ['抽卡素材', '抽卡', '视频素材', '素材'];
    var ROUGHCUT_KW = ['粗剪', '初剪', '粗减'];
    var SCRIPT_KW = ['剧本', '分集', '脚本'];

    function inspectProject(projDir, cfg) {
        var eps = {};
        var materialDirs = findDirs(projDir, MATERIAL_KW);
        materialDirs.forEach(function (md) {
            var found = findEpisodeDirs(md);
            Object.keys(found).forEach(function (k) { eps[k] = true; });
        });
        var roughDirs = findDirs(projDir, ROUGHCUT_KW);
        roughDirs.forEach(function (rd) {
            var f1 = findEpisodeDirs(rd);
            Object.keys(f1).forEach(function (k) { eps[k] = true; });
            var f2 = collectEpisodeFiles(rd);
            Object.keys(f2).forEach(function (k) { eps[k] = true; });
        });
        var scriptDirs = findDirs(projDir, SCRIPT_KW);
        var epList = Object.keys(eps).map(function (k) { return parseInt(k, 10); })
            .filter(function (n) { return !isNaN(n); }).sort(function (a, b) { return a - b; });
        return {
            name: path.basename(projDir),
            dir: projDir,
            episodes: epList,
            materialDirCount: materialDirs.length,
            roughcutDirCount: roughDirs.length,
            hasScript: scriptDirs.length > 0
        };
    }

    // ---------- 本地项目序号 ----------
    function nextSeq(localRoot) {
        var max = 0;
        try {
            fs.readdirSync(localRoot).forEach(function (n) {
                var m = n.match(/^(\d{1,4})/);
                if (m) max = Math.max(max, parseInt(m[1], 10));
            });
        } catch (e) {}
        return max + 1;
    }

    // ---------- 复制（robocopy 更稳，量大时优于 fs） ----------
    // robocopy 退出码：0-7 都算成功（1=有复制 2=有额外 3=1+2 等）
    function robocopy(src, dst, onLine, cb) {
        try {
            if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
        } catch (e) { return cb(new Error('创建目标目录失败：' + e.message)); }
        var args = [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'];
        var child;
        try {
            child = cp.spawn('robocopy', args, { windowsHide: true });
        } catch (e) {
            return cb(new Error('无法启动 robocopy：' + e.message));
        }
        // robocopy 输出是 GBK；这里只做粗略进度统计，不解析中文
        var buf = '';
        child.stdout.on('data', function (d) {
            buf += d.toString('binary');
            if (onLine) onLine(buf.length);
        });
        child.on('error', function (e) { cb(new Error('robocopy 执行失败：' + e.message)); });
        child.on('close', function (code) {
            if (code <= 7) return cb(null, code);
            cb(new Error('robocopy 返回码 ' + code));
        });
    }

    // 扁平复制：把 srcDir 下所有文件复制到 dstDir（去掉中间层级）
    function flattenCopy(srcDir, dstDir, cb) {
        if (!isDir(srcDir)) return cb(null, 0);
        try {
            if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
        } catch (e) { return cb(new Error('创建目录失败：' + e.message)); }
        var count = 0;
        var used = {};
        function walk(p) {
            var items;
            try { items = fs.readdirSync(p); } catch (e) { return; }
            items.forEach(function (name) {
                if (name.charAt(0) === '.' || /^(thumbs\.db|desktop\.ini)$/i.test(name)) return;
                var full = path.join(p, name);
                if (isDir(full)) { walk(full); return; }
                var target = path.join(dstDir, name);
                // 同名去重（加 -2 -3）
                if (used[target.toLowerCase()] || fs.existsSync(target)) {
                    var ext = path.extname(name);
                    var base = name.slice(0, name.length - ext.length);
                    var i = 2;
                    do { target = path.join(dstDir, base + '-' + i + ext); i++; }
                    while (used[target.toLowerCase()] || fs.existsSync(target));
                }
                used[target.toLowerCase()] = true;
                try { fs.copyFileSync(full, target); count++; } catch (e) {}
            });
        }
        walk(srcDir);
        cb(null, count);
    }

    // ---------- 创建本地项目 ----------
    // opts: {project, episodes:[...], onProgress(stage, done, total)}
    function createProject(opts, cb) {
        var cfg = readCfg();
        var proj = opts.project;
        var wantEps = opts.episodes || [];
        var onProgress = opts.onProgress || function () {};

        if (!cfg.localRoot || !isDir(cfg.localRoot)) {
            return cb(new Error('本地项目根目录不存在：' + (cfg.localRoot || '(未设置)')));
        }
        if (!proj || !proj.dir) return cb(new Error('未选择项目'));

        // 1) 建本地项目文件夹
        var seq = nextSeq(cfg.localRoot);
        var dirName = ('000' + seq).slice(-3) + '-' + proj.name;
        var projDir = path.join(cfg.localRoot, dirName);
        try {
            fs.mkdirSync(projDir, { recursive: true });
        } catch (e) { return cb(new Error('创建项目文件夹失败：' + e.message)); }
        onProgress('创建项目文件夹', 1, 1);

        var steps = [];
        // 2) 复制模板结构（可选）
        var doTemplate = function (next) {
            if (!cfg.copyTemplate || !cfg.templateDir || !isDir(cfg.templateDir)) return next();
            onProgress('复制模板结构', 0, 1);
            robocopy(cfg.templateDir, projDir, null, function (err) {
                if (err) { steps.push('模板复制失败：' + err.message); }
                else steps.push('模板结构已复制');
                onProgress('复制模板结构', 1, 1);
                next();
            });
        };

        // 3) 拉素材
        var materialTarget = path.join(projDir, '01原素材');
        var doMaterial = function (next) {
            if (!wantEps.length) { steps.push('未选择集数，跳过素材'); return next(); }
            try { fs.mkdirSync(materialTarget, { recursive: true }); } catch (e) {}
            var epSet = {};
            wantEps.forEach(function (n) { epSet[n] = true; });

            var materialDirs = findDirs(proj.dir, MATERIAL_KW);
            var roughDirs = findDirs(proj.dir, ROUGHCUT_KW);
            var done = 0, copied = 0;
            var total = wantEps.length;

            // 集号 → 目标子目录（第N集 剪辑师）
            function targetFor(ep, editor) {
                var nm = '第' + ep + '集' + (editor ? ' ' + editor : '');
                return path.join(materialTarget, nm);
            }

            // 素材目录
            materialDirs.forEach(function (md) {
                var found = findEpisodeDirs(md);
                wantEps.forEach(function (ep) {
                    if (!found[ep]) return;
                    var t = targetFor(ep, found[ep].editor);
                    flattenCopy(found[ep].dir, t, function (err, n) {
                        if (!err && n) copied += n;
                    });
                });
            });

            // 粗剪（文件形式 + 目录形式，全局按集去重）
            var seen = {};
            roughDirs.forEach(function (rd) {
                var files = collectEpisodeFiles(rd);
                Object.keys(files).forEach(function (k) {
                    var ep = parseInt(k, 10);
                    if (!epSet[ep] || seen[ep]) return;
                    seen[ep] = true;
                    var t = targetFor(ep, files[k].editor);
                    try {
                        if (!fs.existsSync(t)) fs.mkdirSync(t, { recursive: true });
                        fs.copyFileSync(files[k].file, path.join(t, path.basename(files[k].file)));
                        copied++;
                    } catch (e) {}
                });
                var dirs = findEpisodeDirs(rd);
                Object.keys(dirs).forEach(function (k) {
                    var ep = parseInt(k, 10);
                    if (!epSet[ep] || seen[ep]) return;
                    seen[ep] = true;
                    var t = targetFor(ep, dirs[k].editor);
                    flattenCopy(dirs[k].dir, t, function (err, n) {
                        if (!err && n) copied += n;
                    });
                });
            });

            steps.push('素材：' + wantEps.length + ' 集，复制 ' + copied + ' 个文件');
            onProgress('拉取素材', total, total);
            next();
        };

        // 4) 拉剧本
        var doScript = function (next) {
            var scriptDirs = findDirs(proj.dir, SCRIPT_KW);
            if (!scriptDirs.length) { steps.push('未找到剧本目录'); return next(); }
            var target = path.join(projDir, '剧本');
            try { fs.mkdirSync(target, { recursive: true }); } catch (e) {}
            var n = 0;
            scriptDirs.forEach(function (sd) {
                flattenCopy(sd, target, function (err, c) { if (!err) n += c; });
            });
            onProgress('拉取剧本', 1, 1);
            steps.push('剧本：' + n + ' 个文件');
            next();
        };

        // 5) 复制 PR 模板并改名
        var prPath = '';
        var doPR = function (next) {
            var tpl = cfg.prTemplate;
            if (!tpl || !fs.existsSync(tpl)) { steps.push('未配置 PR 模板工程'); return next(); }
            var engDir = path.join(projDir, '工程文件');
            try { fs.mkdirSync(engDir, { recursive: true }); } catch (e) {}
            prPath = path.join(engDir, dirName + '.prproj');
            try {
                fs.copyFileSync(tpl, prPath);
                steps.push('工程文件：已复制模板并改名');
            } catch (e) {
                steps.push('工程复制失败：' + e.message);
                prPath = '';
            }
            onProgress('复制工程文件', 1, 1);
            next();
        };

        // 串行执行
        doTemplate(function () {
            doMaterial(function () {
                doScript(function () {
                    doPR(function () {
                        var result = {
                            dirName: dirName,
                            projDir: projDir,
                            materialTarget: materialTarget,
                            prproj: prPath,
                            seq: seq,
                            steps: steps,
                            prOpened: false
                        };
                        // 6) 打开 PR（可选）
                        if (prPath && cfg.autoOpenPR) {
                            try {
                                var exe = findPREXE();
                                if (exe) {
                                    cp.spawn(exe, [prPath], { detached: true, stdio: 'ignore' }).unref();
                                    result.prOpened = true;
                                    steps.push('已用 PR 打开工程');
                                } else {
                                    steps.push('未找到 Premiere Pro，未自动打开');
                                }
                            } catch (e) {
                                steps.push('打开 PR 失败：' + e.message);
                            }
                        }
                        cb(null, result);
                    });
                });
            });
        });
    }

    function findPREXE() {
        var cands = [
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2026\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2024\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2023\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2022\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2021\\Adobe Premiere Pro.exe'
        ];
        for (var i = 0; i < cands.length; i++) {
            if (fs.existsSync(cands[i])) return cands[i];
        }
        // 兜底：扫 Program Files\Adobe 下的目录名
        try {
            var base = 'C:\\Program Files\\Adobe';
            if (fs.existsSync(base)) {
                var dirs = fs.readdirSync(base);
                for (var k = 0; k < dirs.length; k++) {
                    if (dirs[k].indexOf('Premiere Pro') >= 0) {
                        var p = path.join(base, dirs[k], 'Adobe Premiere Pro.exe');
                        if (fs.existsSync(p)) return p;
                    }
                }
            }
        } catch (e) {}
        return '';
    }

    // ---------- 已建本地项目列表 ----------
    function listLocalProjects(cb) {
        var cfg = readCfg();
        var base = cfg.localRoot;
        if (!base || !isDir(base)) return cb(new Error('本地项目根目录不存在'));
        var out = [];
        var items;
        try { items = fs.readdirSync(base); } catch (e) { return cb(new Error(e.message)); }
        items.forEach(function (name) {
            if (name.charAt(0) === '.') return;
            var full = path.join(base, name);
            if (!isDir(full)) return;
            var m = name.match(/^(\d{1,4})[-_\s]*(.*)$/);
            if (!m) return;
            out.push({
                seq: parseInt(m[1], 10),
                title: m[2] || name,
                dirName: name,
                dir: full
            });
        });
        out.sort(function (a, b) { return b.seq - a.seq; });
        cb(null, out);
    }

    // ---------- 对外接口 ----------
    window.__vhProject = {
        readCfg: readCfg,
        writeCfg: writeCfg,
        DEFAULT_CFG: DEFAULT_CFG,
        scanProjects: scanProjects,
        inspectProject: inspectProject,
        createProject: createProject,
        listLocalProjects: listLocalProjects,
        extractEpisode: extractEpisode,
        findPREXE: findPREXE,
        configFile: function () { return CFG_FILE; }
    };
})();
