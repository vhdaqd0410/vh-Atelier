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
        copyTemplate: true,     // 复制模板结构
        copyRoughcut: true      // 同时把粗剪拉到 02粗剪
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

    // ---------- 集号识别 ----------
    // 真实 NAS 命名（2026-09 实测 O:\AI漫剧剪辑一组 11 个项目）有两类
    // 「数字_中文」，形式完全一样，只能靠后缀区分：
    //   集号    ：07_范堉淼  /  16_杜昊天  /  1-徐祥伟
    //   结构目录：01_抽卡素材 / 01_人物 / 02_粗剪 / 04_项目完成保存
    // 所以结构词表必须够全，否则会把结构目录当集号、或把集号当结构目录。
    var STRUCT_WORDS = [
        // 素材/筹备
        '抽卡素材', '抽卡', '单补镜头', '单补', '视频素材', '配音素材', '素材',
        '前期筹备', '制作明细', '资产表', '资产包', '项目资产', '资产', '溶图',
        // 剪辑/交付
        '工程成片', '成片交付', '成片', '交付', '交片', '多版本交片',
        '粗剪', '精剪', '定剪', '修改', '剪辑',
        '项目完成保存', '工程打包',
        // 文本/参考
        '备注', '评论', '分镜', '剧本', '脚本', '参考', '模板',
        '最终版剧本', '海报',
        // 音频
        '音频', '音乐', '音效',
        // 版本/字幕/其他
        '无音乐无字幕', '有音乐无字幕', '字幕',
        '人名条', '预告片', '集数', '导出', '原片',
        // 资产子类
        '人物', '场景', '道具',
        // 审核
        '审核', '最终'
    ];

    function isStructName(name) {
        if (!name) return false;
        for (var i = 0; i < STRUCT_WORDS.length; i++) {
            if (String(name).indexOf(STRUCT_WORDS[i]) >= 0) return true;
        }
        return false;
    }

    function extractEpisode(name, allowBare) {
        if (!name) return null;
        var s = String(name);
        // 1) 「第N集」最明确
        var m = s.match(/第\s*(\d{1,3})\s*集/);
        if (m) return parseInt(m[1], 10);
        // 2) 「N_中文」：集号（07_范堉淼）还是结构目录（01_抽卡素材）靠后缀判断
        m = s.match(/^(\d{1,3})_([\u4e00-\u9fff].*)$/);
        if (m) return isStructName(m[2]) ? null : parseInt(m[1], 10);
        // 3) 「N-中文」/「N 中文」
        m = s.match(/^(\d{1,3})\s*[-　 ]\s*([\u4e00-\u9fff].*)$/);
        if (m) return isStructName(m[2]) ? null : parseInt(m[1], 10);
        // 4) 纯数字（如粗剪目录里的 19.mp4 / 19）
        //    只在「已确定是粗剪上下文」时启用：那里不可能出现结构目录序号
        if (allowBare) {
            m = s.match(/^(\d{1,3})$/);
            if (m) return parseInt(m[1], 10);
            m = s.match(/^(\d{1,3})\s*[-_　 ]+$/);
            if (m) return parseInt(m[1], 10);
        }
        // 5) 其余带下划线的数字前缀（01_abc）当结构目录
        return null;
    }

    // 从「第3集 张三」/「07_范堉淼」里取出名字（没有/纯数字就返回空）
    function extractEditorFromDir(name) {
        var s = String(name || '');
        s = s.replace(/^第\s*\d{1,3}\s*集/, '');
        s = s.replace(/^\d{1,3}\s*[-_　 ]\s*/, '');
        s = s.replace(/^[-_\s]+/, '');
        s = s.trim().replace(/^-+|-+$/g, '').trim();
        // 纯数字/空不算名字（如 19.mp4 → "19"，或「第19集」本身）
        if (/^\d+$/.test(s)) return '';
        return s;
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
    // opts.allowBare  允许把纯数字目录名当集号（粗剪上下文）
    // opts.skipDir    命中则整棵跳过（如素材里嵌套的粗剪目录）
    async function findEpisodeDirsAsync(folder, maxDepth, opts) {
        if (typeof opts === 'boolean') opts = { allowBare: opts };
        opts = opts || {};
        var result = {};
        var limit = (typeof maxDepth === 'number') ? maxDepth : 4;
        async function walk(p, depth) {
            if (depth > limit) return;
            var names = await listDirs(p);
            for (var i = 0; i < names.length; i++) {
                var name = names[i];
                var full = path.join(p, name);
                if (opts.skipDir && opts.skipDir(name)) continue;
                var ep = extractEpisode(name, opts.allowBare);
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
    // fallbackEp：文件名本身没带集号时，用父目录的集号（如 第19集\粗剪\final.mp4）
    async function collectEpisodeFilesAsync(folder, fallbackEp, allowBare) {
        var result = {};
        var names = await listFiles(folder);
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            var stem = name.replace(/\.[^.]+$/, '');
            var ep = extractEpisode(stem, allowBare);
            if (ep === null && fallbackEp !== null && fallbackEp !== undefined) ep = fallbackEp;
            if (ep !== null && !result[ep]) {
                result[ep] = { file: path.join(folder, name), editor: extractEditorFromDir(stem) };
            }
        }
        return result;
    }

    // ---------- 项目扫描 ----------
    var MATERIAL_KW = ['抽卡素材', '抽卡', '视频素材', '素材'];
    var ROUGHCUT_KW = ['粗剪', '初剪', '粗减', '精剪', '定剪'];
    var SCRIPT_KW = ['剧本', '分集', '脚本'];

    function isRoughcutName(n) {
        if (!n) return false;
        var s = String(n);
        for (var i = 0; i < ROUGHCUT_KW.length; i++) {
            if (s.indexOf(ROUGHCUT_KW[i]) >= 0) return true;
        }
        return false;
    }

    // 探测单个项目（异步）
    async function inspectProjectAsync(projDir, onSub) {
        var eps = {};
        var st = await dirStat(projDir);

        // 素材（排除粗剪类目录，避免粗剪被计入素材集）
        var allMaterial = await findDirsAsync(projDir, MATERIAL_KW);
        var materialDirs = allMaterial.filter(function (d) {
            return !isRoughcutName(path.basename(d));
        });
        for (var i = 0; i < materialDirs.length; i++) {
            if (onSub) onSub('素材');
            var found = await findEpisodeDirsAsync(materialDirs[i], 4, { skipDir: isRoughcutName });
            Object.keys(found).forEach(function (k) { eps[k] = true; });
        }
        var roughDirs = await findDirsAsync(projDir, ROUGHCUT_KW);
        for (var j = 0; j < roughDirs.length; j++) {
            if (onSub) onSub('粗剪');
            var rd = roughDirs[j];
            var parentEp = extractEpisode(path.basename(path.dirname(rd)), true);
            var f1 = await findEpisodeDirsAsync(rd, 4, { allowBare: true });
            Object.keys(f1).forEach(function (k) { eps[k] = true; });
            var f2 = await collectEpisodeFilesAsync(rd, parentEp, true);
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
    // ctx: { used:{}, onFile(n), skipDir(name) }
    // 只有真的复制了文件才创建目标目录（避免拉出一堆空目录）
    async function flattenCopyAsync(srcDir, dstDir, ctx) {
        ctx = ctx || {};
        if (!ctx.used) ctx.used = {};
        if (!(await isDir(srcDir))) return 0;

        var count = 0;
        async function walk(p) {
            var names = await listFiles(p);
            for (var i = 0; i < names.length; i++) {
                try { await fsp.mkdir(dstDir, { recursive: true }); } catch (e) {}
                var target = uniquePath(dstDir, names[i], ctx.used);
                try {
                    await fsp.copyFile(path.join(p, names[i]), target);
                    count++;
                    if (ctx.onFile) ctx.onFile(1);
                } catch (e) {}
            }
            var subs = await listDirs(p);
            for (var j = 0; j < subs.length; j++) {
                if (ctx.skipDir && ctx.skipDir(subs[j])) continue;
                await walk(path.join(p, subs[j]));
            }
        }
        await walk(srcDir);
        return count;
    }

    // 目录里除了被 skipDir 排除的子目录外，还有没有文件（含更深层）
    async function hasFilesExcept(srcDir, skipDir) {
        async function walk(p) {
            var names = await listFiles(p);
            if (names.length) return true;
            var subs = await listDirs(p);
            for (var j = 0; j < subs.length; j++) {
                if (skipDir && skipDir(subs[j])) continue;
                if (await walk(path.join(p, subs[j]))) return true;
            }
            return false;
        }
        if (!(await isDir(srcDir))) return false;
        return await walk(srcDir);
    }

    // ---------- 建素材源索引（按集号归并） ----------
    // 三类来源（对照真实 NAS 实测结构）：
    //   素材目录  02_抽卡素材\01_抽卡素材\07_范堉淼\*.mp4
    //   粗剪-文件 02_抽卡素材\03_粗剪\1-徐祥伟.mp4
    //   粗剪-每集 03 视频素材\第19集\粗剪\19.mp4   ← 父目录才是集号，文件名是纯数字
    async function buildSourceIndex(projDir, onSub) {
        // 素材目录：排除本身就是粗剪的目录（否则粗剪会被当成素材）
        var allMaterial = await findDirsAsync(projDir, MATERIAL_KW);
        var materialDirs = allMaterial.filter(function (d) {
            return !isRoughcutName(path.basename(d));
        });
        var roughDirs = await findDirsAsync(projDir, ROUGHCUT_KW);
        var scriptDirs = await findDirsAsync(projDir, SCRIPT_KW);
        var byEp = {};

        function push(ep, item) {
            if (!byEp[ep]) byEp[ep] = [];
            byEp[ep].push(item);
        }

        for (var i = 0; i < materialDirs.length; i++) {
            if (onSub) onSub('索引素材 ' + (i + 1) + '/' + materialDirs.length);
            // 素材里遇到粗剪类子目录要跳过（它归粗剪管）
            var m = await findEpisodeDirsAsync(materialDirs[i], 4, { skipDir: isRoughcutName });
            Object.keys(m).forEach(function (k) {
                push(k, { dir: m[k].dir, editor: m[k].editor, kind: 'material' });
            });
            await tick();
        }
        for (var j = 0; j < roughDirs.length; j++) {
            if (onSub) onSub('索引粗剪 ' + (j + 1) + '/' + roughDirs.length);
            var rd = roughDirs[j];
            // 父目录是集号时（第19集\粗剪），用父目录集号兜底文件名
            var parentEp = extractEpisode(path.basename(path.dirname(rd)), true);
            var d = await findEpisodeDirsAsync(rd, 4, { allowBare: true });
            Object.keys(d).forEach(function (k) {
                push(k, { dir: d[k].dir, editor: d[k].editor, kind: 'rough' });
            });
            var f = await collectEpisodeFilesAsync(rd, parentEp, true);
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
            var roughTarget = path.join(projDir, '02粗剪');
            try { await fsp.mkdir(materialTarget, { recursive: true }); } catch (e) {}
            var usedM = {};
            var totalFiles = 0;
            var epWithSrc = 0;

            function epEditor(srcs) {
                for (var k = 0; k < srcs.length; k++) {
                    if (srcs[k].editor) return srcs[k].editor;
                }
                return '';
            }
            function epDirName(ep, ed) {
                return '第' + ep + '集' + (ed ? ' ' + ed : '');
            }

            // 4a) 素材 → 01原素材
            for (var i = 0; i < wantEps.length; i++) {
                var ep = wantEps[i];
                var all = idx.byEp[ep] || [];
                // 只取素材类（粗剪另走 4b）
                var srcs = all.filter(function (x) { return x.kind === 'material'; });
                onProgress('拉取素材', i, wantEps.length, '第' + ep + '集');
                if (!srcs.length) { await tick(); continue; }
                var editor = epEditor(srcs);
                var tdir = path.join(materialTarget, epDirName(ep, editor));
                var got = 0;
                for (var s = 0; s < srcs.length; s++) {
                    var item = srcs[s];
                    if (!item.dir) continue;
                    // 该目录里除了粗剪之外还有文件吗？（如 第19集\粗剪 里只有粗剪）
                    if (!(await hasFilesExcept(item.dir, isRoughcutName))) continue;
                    // 跳过目录内嵌套的粗剪子目录，避免粗剪流进素材
                    got += await flattenCopyAsync(item.dir, tdir, {
                        used: usedM, skipDir: isRoughcutName
                    });
                    await tick();
                }
                if (got > 0) { epWithSrc++; totalFiles += got; }
                onProgress('拉取素材', i + 1, wantEps.length, '第' + ep + '集');
            }
            steps.push('素材：' + epWithSrc + '/' + wantEps.length + ' 集，共 ' + totalFiles + ' 个文件');

            // 4b) 粗剪 → 02粗剪（默认开启，可在配置里关掉）
            var roughFiles = 0, roughEp = 0;
            if (cfg.copyRoughcut !== false) {
                try { await fsp.mkdir(roughTarget, { recursive: true }); } catch (e) {}
                var usedR = {};
                for (var r = 0; r < wantEps.length; r++) {
                    var rep = wantEps[r];
                    var rall = idx.byEp[rep] || [];
                    var rsrc = rall.filter(function (x) { return x.kind === 'rough' || x.kind === 'roughfile'; });
                    onProgress('拉取粗剪', r, wantEps.length, '第' + rep + '集');
                    if (!rsrc.length) { await tick(); continue; }
                    roughEp++;
                    var reditor = epEditor(rsrc);
                    var rdir = path.join(roughTarget, epDirName(rep, reditor));
                    for (var rs = 0; rs < rsrc.length; rs++) {
                        var ri = rsrc[rs];
                        if (ri.file) {
                            try {
                                await fsp.mkdir(rdir, { recursive: true });
                                var rp = uniquePath(rdir, path.basename(ri.file), usedR);
                                await fsp.copyFile(ri.file, rp);
                                roughFiles++;
                            } catch (e) {}
                        } else if (ri.dir) {
                            roughFiles += await flattenCopyAsync(ri.dir, rdir, { used: usedR });
                        }
                        await tick();
                    }
                    onProgress('拉取粗剪', r + 1, wantEps.length, '第' + rep + '集');
                }
                steps.push('粗剪：' + roughEp + '/' + wantEps.length + ' 集，共 ' + roughFiles + ' 个文件');
            } else {
                steps.push('粗剪：已关闭，跳过');
            }

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
                roughTarget: roughTarget,
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
        isStructName: isStructName,
        STRUCT_WORDS: STRUCT_WORDS,
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
