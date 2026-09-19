// vh-Atelier A · 项目素材拉取 + 本地项目创建
// ==========================================================================
// 做什么：
//   扫描组内 NAS 目录 → 列表列出进行中项目 → 选项目、勾集数
//   → 建本地项目文件夹（序号-项目名）+ 复制模板结构
//   → 按集号把素材/粗剪/剧本拉到本地
//   → 复制 PR 模板工程并改名，可选自动打开
//
// 为什么全异步：
//   NAS 是网络盘，同步 readdirSync/statSync 会把 CEP 的 UI 线程锁死
//   （表现为整个面板卡住、进度条不动）。这里全部走 fs.promises +
//   定期 await tick() 让出事件循环，UI 才能持续重绘并汇报进度。
//
// 集号识别规则照搬工作台 local_project.py 的踩坑结论：
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
    var fsp = fs.promises;

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
        templateDir: '',        // 项目模板结构目录
        prTemplate: '',         // PR 模板工程 .prproj
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
                // 老配置里的 editorName 直接丢弃（已废弃）
                return out;
            }
        } catch (e) {}
        return JSON.parse(JSON.stringify(DEFAULT_CFG));
    }
    function writeCfg(c) {
        try {
            var d = path.dirname(CFG_FILE);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            var clean = {};
            Object.keys(DEFAULT_CFG).forEach(function (k) { clean[k] = c[k]; });
            fs.writeFileSync(CFG_FILE, JSON.stringify(clean, null, 2), 'utf8');
            return true;
        } catch (e) { return false; }
    }

    // ---------- 让出事件循环（关键：保 UI 不卡） ----------
    function tick() {
        return new Promise(function (r) { setTimeout(r, 0); });
    }

    // ---------- 集号识别（照搬工作台规则） ----------
    function extractEpisode(name) {
        if (!name) return null;
        // 1) 「第N集」最明确
        var m = String(name).match(/第\s*(\d{1,3})\s*集/);
        if (m) return parseInt(m[1], 10);
        // 2) 数字+下划线 → 结构目录序号，不是集号
        if (/^\d{1,3}_/.test(name)) return null;
        // 3) 「N-中文」或「N 中文」
        m = String(name).match(/^(\d{1,3})\s*[- 　]\s*([\u4e00-\u9fff])/);
        if (m) return parseInt(m[1], 10);
        return null;
    }

    // 从「第3集 张三」里取出「张三」（没有就返回空）
    function extractEditorFromDir(name) {
        var s = String(name || '');
        s = s.replace(/第\s*\d{1,3}\s*集/g, '');
        s = s.replace(/^\d{1,3}\s*[- 　]/, '');
        s = s.replace(/^-\s*/, '');
        return s.trim().replace(/^-+|-+$/g, '').trim();
    }

    // ---------- fs 异步小工具 ----------
    var SKIP_NAMES = /^(thumbs\.db|desktop\.ini|\.DS_Store)$/i;

    async function isDir(p) {
        try { var st = await fsp.stat(p); return st.isDirectory(); } catch (e) { return false; }
    }
    async function dirStat(p) {
        try { var st = await fsp.stat(p); return st; } catch (e) { return null; }
    }
    async function listDirs(p) {
        try {
            var ents = await fsp.readdir(p, { withFileTypes: true });
            var out = [];
            for (var i = 0; i < ents.length; i++) {
                var e = ents[i];
                if (!e.isDirectory()) continue;
                if (e.name.charAt(0) === '.' || e.name.charAt(0) === '$') continue;
                out.push(e.name);
            }
            return out;
        } catch (e) { return []; }
    }
    async function listFiles(p) {
        try {
            var ents = await fsp.readdir(p, { withFileTypes: true });
            var out = [];
            for (var i = 0; i < ents.length; i++) {
                var e = ents[i];
                if (e.isDirectory()) continue;
                if (e.name.charAt(0) === '.' || SKIP_NAMES.test(e.name)) continue;
                out.push(e.name);
            }
            return out;
        } catch (e) { return []; }
    }

    // ---------- 异步递归查找 ----------
    // 找「名字含任一关键词」的目录（命中后不再往下钻）
    async function findDirsAsync(root, keywords, maxDepth) {
        var out = [];
        var limit = (typeof maxDepth === 'number') ? maxDepth : 4;
        async function walk(p, depth) {
            if (depth > limit) return;
            var names = await listDirs(p);
            for (var i = 0; i < names.length; i++) {
                var name = names[i];
                var full = path.join(p, name);
                var hit = false;
                for (var k = 0; k < keywords.length; k++) {
                    if (name.indexOf(keywords[k]) >= 0) { hit = true; break; }
                }
                if (hit) out.push(full);
                else await walk(full, depth + 1);
            }
            await tick();
        }
        await walk(root, 0);
        return out;
    }

    // 在 folder 下递归找集号目录 → { 集号: {dir, editor} }
    // 结构目录（集号为 null）继续往下钻
    async function findEpisodeDirsAsync(folder, maxDepth) {
        var result = {};
        var limit = (typeof maxDepth === 'number') ? maxDepth : 4;
        async function walk(p, depth) {
            if (depth > limit) return;
            var names = await listDirs(p);
            for (var i = 0; i < names.length; i++) {
                var name = names[i];
                var full = path.join(p, name);
                var ep = extractEpisode(name);
                if (ep !== null) {
                    if (!result[ep]) result[ep] = { dir: full, editor: extractEditorFromDir(name) };
                } else {
                    await walk(full, depth + 1);
                }
            }
            await tick();
        }
        await walk(folder, 0);
        return result;
    }

    // 收集「集号-剪辑师.扩展名」形式的文件（粗剪常见）
    async function collectEpisodeFilesAsync(folder) {
        var result = {};
        var names = await listFiles(folder);
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            var stem = name.replace(/\.[^.]+$/, '');
            var ep = extractEpisode(stem);
            if (ep !== null && !result[ep]) {
                result[ep] = { file: path.join(folder, name), editor: extractEditorFromDir(stem) };
            }
        }
        return result;
    }

    // ---------- 项目扫描 ----------
    var MATERIAL_KW = ['抽卡素材', '抽卡', '视频素材', '素材'];
    var ROUGHCUT_KW = ['粗剪', '初剪', '粗减'];
    var SCRIPT_KW = ['剧本', '分集', '脚本'];

    // 探测单个项目（异步）
    async function inspectProjectAsync(projDir, onSub) {
        var eps = {};
        var st = await dirStat(projDir);

        var materialDirs = await findDirsAsync(projDir, MATERIAL_KW);
        for (var i = 0; i < materialDirs.length; i++) {
            if (onSub) onSub('素材');
            var found = await findEpisodeDirsAsync(materialDirs[i]);
            Object.keys(found).forEach(function (k) { eps[k] = true; });
        }
        var roughDirs = await findDirsAsync(projDir, ROUGHCUT_KW);
        for (var j = 0; j < roughDirs.length; j++) {
            if (onSub) onSub('粗剪');
            var f1 = await findEpisodeDirsAsync(roughDirs[j]);
            Object.keys(f1).forEach(function (k) { eps[k] = true; });
            var f2 = await collectEpisodeFilesAsync(roughDirs[j]);
            Object.keys(f2).forEach(function (k) { eps[k] = true; });
        }
        if (onSub) onSub('剧本');
        var scriptDirs = await findDirsAsync(projDir, SCRIPT_KW);

        var epList = Object.keys(eps).map(function (k) { return parseInt(k, 10); })
            .filter(function (n) { return !isNaN(n); })
            .sort(function (a, b) { return a - b; });

        return {
            name: path.basename(projDir),
            dir: projDir,
            mtime: st ? st.mtimeMs : 0,
            episodes: epList,
            materialDirCount: materialDirs.length,
            roughcutDirCount: roughDirs.length,
            hasScript: scriptDirs.length > 0
        };
    }

    // 扫描 NAS 根目录下所有进行中项目
    // opts: { onProgress(done, total, name), onSub(label) }
    function scanProjects(opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        opts = opts || {};
        var onProgress = opts.onProgress || function () {};
        var onSub = opts.onSub || null;

        (async function () {
            var cfg = readCfg();
            var base = cfg.nasDir;
            if (!base || !(await isDir(base))) {
                return cb(new Error('NAS 目录不存在：' + (base || '(未设置)')));
            }
            var exclude = (cfg.excludeDirs || []).map(function (s) { return String(s).trim(); }).filter(Boolean);

            var names = await listDirs(base);
            var targets = [];
            for (var i = 0; i < names.length; i++) {
                var name = names[i];
                // 排除目录（包含匹配：填 "00已完成" 也能排除 "00已完成(2025)"）
                var skip = false;
                for (var k = 0; k < exclude.length; k++) {
                    if (name.indexOf(exclude[k]) >= 0) { skip = true; break; }
                }
                if (skip) continue;
                targets.push(name);
            }

            var total = targets.length;
            onProgress(0, total, '准备中');

            var list = [];
            for (var t = 0; t < total; t++) {
                var full = path.join(base, targets[t]);
                onProgress(t, total, targets[t]);
                await tick();
                try {
                    var info = await inspectProjectAsync(full, onSub);
                    list.push(info);
                } catch (e) {
                    // 单个项目出错不影响整体
                    list.push({
                        name: targets[t], dir: full, mtime: 0, episodes: [],
                        materialDirCount: 0, roughcutDirCount: 0, hasScript: false,
                        error: e.message
                    });
                }
                onProgress(t + 1, total, targets[t]);
                await tick();
            }
            cb(null, list);
        })().catch(function (e) { cb(e); });
    }

    // ---------- 复制 ----------
    // 目标同名时自动加 -2 -3（used 记录本次已占用，避免并发撞名）
    function uniquePath(dstDir, name, used) {
        var ext = path.extname(name);
        var base = name.slice(0, name.length - ext.length);
        var target = path.join(dstDir, name);
        var key = target.toLowerCase();
        if (!used[key] && !fs.existsSync(target)) { used[key] = true; return target; }
        var i = 2;
        do {
            target = path.join(dstDir, base + '-' + i + ext);
            key = target.toLowerCase();
            i++;
        } while (used[key] || fs.existsSync(target));
        used[key] = true;
        return target;
    }

    // 保留结构的整树复制（模板用）：连同空目录一起建
    async function copyTreeAsync(srcDir, dstDir) {
        if (!(await isDir(srcDir))) return 0;
        try { await fsp.mkdir(dstDir, { recursive: true }); } catch (e) { return 0; }
        var files = 0;
        async function walk(src, dst) {
            var names = [];
            try { names = await fsp.readdir(src, { withFileTypes: true }); } catch (e) { return; }
            for (var i = 0; i < names.length; i++) {
                var e = names[i];
                if (e.name.charAt(0) === '.' || SKIP_NAMES.test(e.name)) continue;
                var s = path.join(src, e.name);
                var d = path.join(dst, e.name);
                if (e.isDirectory()) {
                    try { await fsp.mkdir(d, { recursive: true }); } catch (er) {}
                    await walk(s, d);
                } else {
                    try { await fsp.copyFile(s, d); files++; } catch (er) {}
                }
            }
            await tick();
        }
        await walk(srcDir, dstDir);
        return files;
    }

    // 扁平复制：srcDir 下所有文件（递归）复制到 dstDir，去掉中间层级
    // ctx: { used:{}, onFile(n) }
    async function flattenCopyAsync(srcDir, dstDir, ctx) {
        ctx = ctx || {};
        if (!ctx.used) ctx.used = {};
        if (!(await isDir(srcDir))) return 0;
        try { await fsp.mkdir(dstDir, { recursive: true }); } catch (e) { return 0; }

        var count = 0;
        async function walk(p) {
            var names = await listFiles(p);
            for (var i = 0; i < names.length; i++) {
                var target = uniquePath(dstDir, names[i], ctx.used);
                try {
                    await fsp.copyFile(path.join(p, names[i]), target);
                    count++;
                    if (ctx.onFile) ctx.onFile(1);
                } catch (e) {}
            }
            var subs = await listDirs(p);
            for (var j = 0; j < subs.length; j++) {
                await walk(path.join(p, subs[j]));
            }
        }
        await walk(srcDir);
        return count;
    }

    // ---------- 建素材源索引（按集号归并） ----------
    async function buildSourceIndex(projDir, onSub) {
        var materialDirs = await findDirsAsync(projDir, MATERIAL_KW);
        var roughDirs = await findDirsAsync(projDir, ROUGHCUT_KW);
        var scriptDirs = await findDirsAsync(projDir, SCRIPT_KW);
        var byEp = {};

        function push(ep, item) {
            if (!byEp[ep]) byEp[ep] = [];
            byEp[ep].push(item);
        }

        for (var i = 0; i < materialDirs.length; i++) {
            if (onSub) onSub('索引素材 ' + (i + 1) + '/' + materialDirs.length);
            var m = await findEpisodeDirsAsync(materialDirs[i]);
            Object.keys(m).forEach(function (k) {
                push(k, { dir: m[k].dir, editor: m[k].editor, kind: 'material' });
            });
            await tick();
        }
        for (var j = 0; j < roughDirs.length; j++) {
            if (onSub) onSub('索引粗剪 ' + (j + 1) + '/' + roughDirs.length);
            var d = await findEpisodeDirsAsync(roughDirs[j]);
            Object.keys(d).forEach(function (k) {
                push(k, { dir: d[k].dir, editor: d[k].editor, kind: 'rough' });
            });
            var f = await collectEpisodeFilesAsync(roughDirs[j]);
            Object.keys(f).forEach(function (k) {
                push(k, { file: f[k].file, editor: f[k].editor, kind: 'roughfile' });
            });
            await tick();
        }
        return { byEp: byEp, materialDirs: materialDirs, roughDirs: roughDirs, scriptDirs: scriptDirs };
    }

    // ---------- 创建本地项目 ----------
    // opts: {project, episodes:[...], onProgress(stage, done, total, detail)}
    function createProject(opts, cb) {
        var onProgress = opts.onProgress || function () {};

        (async function () {
            var cfg = readCfg();
            var proj = opts.project;
            var wantEps = (opts.episodes || []).slice().sort(function (a, b) { return a - b; });

            if (!cfg.localRoot || !(await isDir(cfg.localRoot))) {
                return cb(new Error('本地项目根目录不存在：' + (cfg.localRoot || '(未设置)')));
            }
            if (!proj || !proj.dir) return cb(new Error('未选择项目'));
            if (!wantEps.length) return cb(new Error('未选择集数'));

            // 1) 建本地项目文件夹
            onProgress('创建项目文件夹', 0, 1, '');
            var seq = await nextSeq(cfg.localRoot);
            var dirName = ('000' + seq).slice(-3) + '-' + proj.name;
            var projDir = path.join(cfg.localRoot, dirName);
            try {
                await fsp.mkdir(projDir, { recursive: true });
            } catch (e) { return cb(new Error('创建项目文件夹失败：' + e.message)); }
            onProgress('创建项目文件夹', 1, 1, dirName);

            var steps = [];

            // 2) 复制模板结构（保留目录层级，含空目录）
            if (cfg.copyTemplate && cfg.templateDir && (await isDir(cfg.templateDir))) {
                onProgress('复制模板结构', 0, 1, '');
                var tn = await copyTreeAsync(cfg.templateDir, projDir);
                steps.push('模板结构：复制 ' + tn + ' 个文件');
                onProgress('复制模板结构', 1, 1, '');
            } else if (cfg.copyTemplate) {
                steps.push('模板结构：未配置，跳过');
            }

            // 3) 索引素材源
            onProgress('索引素材', 0, 1, '');
            var idx = await buildSourceIndex(proj.dir, function (sub) {
                onProgress('索引素材', 0, 1, sub);
            });
            onProgress('索引素材', 1, 1, '');

            // 4) 按集拉素材
            var materialTarget = path.join(projDir, '01原素材');
            try { await fsp.mkdir(materialTarget, { recursive: true }); } catch (e) {}
            var usedM = {};
            var totalFiles = 0;
            var epWithSrc = 0;
            for (var i = 0; i < wantEps.length; i++) {
                var ep = wantEps[i];
                var srcs = idx.byEp[ep] || [];
                var editor = '';
                for (var k = 0; k < srcs.length; k++) {
                    if (srcs[k].editor) { editor = srcs[k].editor; break; }
                }
                var tdir = path.join(materialTarget, '第' + ep + '集' + (editor ? ' ' + editor : ''));
                onProgress('拉取素材', i, wantEps.length, '第' + ep + '集');

                if (!srcs.length) { await tick(); continue; }
                epWithSrc++;
                for (var s = 0; s < srcs.length; s++) {
                    var item = srcs[s];
                    if (item.file) {
                        try {
                            await fsp.mkdir(tdir, { recursive: true });
                            var tp = uniquePath(tdir, path.basename(item.file), usedM);
                            await fsp.copyFile(item.file, tp);
                            totalFiles++;
                        } catch (e) {}
                    } else if (item.dir) {
                        totalFiles += await flattenCopyAsync(item.dir, tdir, { used: usedM });
                    }
                    await tick();
                }
                onProgress('拉取素材', i + 1, wantEps.length, '第' + ep + '集');
            }
            steps.push('素材：' + epWithSrc + '/' + wantEps.length + ' 集，共 ' + totalFiles + ' 个文件');

            // 5) 拉剧本
            if (idx.scriptDirs.length) {
                onProgress('拉取剧本', 0, 1, '');
                var scriptTarget = path.join(projDir, '剧本');
                var usedS = {};
                var sn = 0;
                for (var q = 0; q < idx.scriptDirs.length; q++) {
                    sn += await flattenCopyAsync(idx.scriptDirs[q], scriptTarget, { used: usedS });
                    await tick();
                }
                steps.push('剧本：' + sn + ' 个文件');
                onProgress('拉取剧本', 1, 1, '');
            } else {
                steps.push('剧本：未找到剧本目录');
            }

            // 6) 复制 PR 模板工程并改名
            var prPath = '';
            var tpl = cfg.prTemplate;
            if (tpl && fs.existsSync(tpl)) {
                onProgress('复制工程文件', 0, 1, '');
                var engDir = path.join(projDir, '工程文件');
                try {
                    await fsp.mkdir(engDir, { recursive: true });
                    prPath = path.join(engDir, dirName + '.prproj');
                    await fsp.copyFile(tpl, prPath);
                    steps.push('工程文件：已复制模板并改名');
                } catch (e) {
                    steps.push('工程复制失败：' + e.message);
                    prPath = '';
                }
                onProgress('复制工程文件', 1, 1, '');
            } else {
                steps.push('工程文件：未配置 PR 模板工程');
            }

            var result = {
                dirName: dirName,
                projDir: projDir,
                materialTarget: materialTarget,
                prproj: prPath,
                seq: seq,
                steps: steps,
                prOpened: false
            };

            // 7) 打开 PR（可选）
            if (prPath && cfg.autoOpenPR) {
                var exe = findPREXE();
                if (exe) {
                    try {
                        cp.spawn(exe, [prPath], { detached: true, stdio: 'ignore' }).unref();
                        result.prOpened = true;
                        steps.push('已用 Premiere Pro 打开工程');
                    } catch (e) {
                        steps.push('打开 PR 失败：' + e.message);
                    }
                } else {
                    steps.push('未找到 Premiere Pro，未自动打开');
                }
            }
            cb(null, result);
        })().catch(function (e) { cb(e); });
    }

    // ---------- 本地项目序号 ----------
    async function nextSeq(localRoot) {
        var max = 0;
        var names = [];
        try { names = await fsp.readdir(localRoot); } catch (e) { return 1; }
        names.forEach(function (n) {
            var m = n.match(/^(\d{1,4})/);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        });
        return max + 1;
    }

    function findPREXE() {
        var cands = [
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2026\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2025\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2024\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2023\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2022\\Adobe Premiere Pro.exe',
            'C:\\Program Files\\Adobe\\Adobe Premiere Pro 2021\\Adobe Premiere Pro.exe'
        ];
        for (var i = 0; i < cands.length; i++) {
            if (fs.existsSync(cands[i])) return cands[i];
        }
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
        (async function () {
            var cfg = readCfg();
            var base = cfg.localRoot;
            if (!base || !(await isDir(base))) return cb(new Error('本地项目根目录不存在'));
            var names = [];
            try { names = await fsp.readdir(base); } catch (e) { return cb(new Error(e.message)); }
            var out = [];
            for (var i = 0; i < names.length; i++) {
                var name = names[i];
                if (name.charAt(0) === '.') continue;
                var full = path.join(base, name);
                if (!(await isDir(full))) continue;
                var m = name.match(/^(\d{1,4})[-_\s]*(.*)$/);
                if (!m) continue;
                var st = await dirStat(full);
                out.push({
                    seq: parseInt(m[1], 10),
                    title: m[2] || name,
                    dirName: name,
                    dir: full,
                    mtime: st ? st.mtimeMs : 0,
                    hasScript: fs.existsSync(path.join(full, '剧本')),
                    hasMaterial: fs.existsSync(path.join(full, '01原素材'))
                });
            }
            out.sort(function (a, b) { return b.seq - a.seq; });
            cb(null, out);
        })().catch(function (e) { cb(e); });
    }

    // ---------- 排序 ----------
    // key: name | time | eps
    function sortProjects(list, key, desc) {
        var arr = (list || []).slice();
        var dir = desc ? -1 : 1;
        arr.sort(function (a, b) {
            var r = 0;
            if (key === 'time') r = (a.mtime || 0) - (b.mtime || 0);
            else if (key === 'eps') r = ((a.episodes || []).length) - ((b.episodes || []).length);
            else {
                try { r = String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'); }
                catch (e) { r = String(a.name) < String(b.name) ? -1 : (String(a.name) > String(b.name) ? 1 : 0); }
            }
            if (r === 0) r = (a.mtime || 0) - (b.mtime || 0);
            return r * dir;
        });
        return arr;
    }

    // ---------- 对外接口 ----------
    window.__vhProject = {
        readCfg: readCfg,
        writeCfg: writeCfg,
        DEFAULT_CFG: DEFAULT_CFG,
        extractEpisode: extractEpisode,
        extractEditorFromDir: extractEditorFromDir,
        scanProjects: scanProjects,
        inspectProjectAsync: inspectProjectAsync,
        buildSourceIndex: buildSourceIndex,
        copyTreeAsync: copyTreeAsync,
        flattenCopyAsync: flattenCopyAsync,
        createProject: createProject,
        listLocalProjects: listLocalProjects,
        sortProjects: sortProjects,
        findPREXE: findPREXE,
        configFile: function () { return CFG_FILE; }
    };
})();
