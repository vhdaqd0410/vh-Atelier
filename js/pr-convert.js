// vh-Atelier A · PR 版本转换（样式 + 工程）
// ==========================================================================
// 做什么：把高版本 PR 的文件转成低版本能打开的格式
//   · .prtextstyle  PR 文字样式
//   · .prproj       PR 工程文件
//
// 原理（已查证 + 本机实测，非推测）：
//   PR 判断能否打开只认文件里的版本号。文件是纯文本 XML
//   （.prproj 通常 gzip 压缩，.prtextstyle 未压缩）。
//   头部形如 <Project ... Version="43">，另有大量 <Xxx Version="n">。
//   把工程版本与各元素版本号改成目标版本对应的值即可。
//
// 版本对应（本机 3 个 PR 安装 + 真实文件实测）：
//   PR2021=39 / PR2022=40 / PR2023=41 / PR2024=42 / PR2025=43 / PR2026=45
//
// 元素级版本表来源：对比本机真实的多版本文件推导，
// 与公开降级工具做法一致（它们也是"从各版本原生保存的文件里提取版本档案"）。
//
// 保真度：只动版本号与明确的版本字段，不碰内容
//   （样式：文本/字体/颜色/关键帧；工程：序列/素材引用）。
(function () {
    var fs, path, zlib;
    try {
        fs = require('fs');
        path = require('path');
        zlib = require('zlib');
    } catch (e) { return; }

    // ---------- 元素 -> {工程版本: 元素版本}（实测推导）----------
    var SCHEMA = {
        'ArbVideoComponentParam': { 39: 2, 41: 2, 43: 2, 45: 3 },
        'AudioCompileSettings': { 39: 6, 41: 6, 43: 6, 45: 6 },
        'AudioSettings': { 39: 7, 41: 7, 43: 7, 45: 8 },
        'CompileSettings': { 39: 4, 41: 4, 43: 4, 45: 4 },
        'Component': { 39: 6, 41: 6, 43: 6, 45: 7 },
        'DefaultSequenceSettings': { 39: 2, 41: 2, 43: 2, 45: 2 },
        'IngestSettings': { 39: 1, 41: 1, 43: 2, 45: 2 },
        'PointComponentParam': { 39: 3, 41: 3, 43: 3, 45: 4 },
        'Project': { 39: 39, 41: 41, 43: 43, 45: 45 },
        'ProjectSettings': { 39: 18, 41: 19, 43: 21, 45: 21 },
        'VideoFilterComponent': { 39: 8, 41: 8, 43: 9, 45: 9 },
        'VideoComponentParam': { 39: 9, 41: 9, 43: 9, 45: 10 },
        'VideoSettings': { 39: 9, 41: 9, 43: 9, 45: 10 },
        'VideoCompileSettings': { 39: 9, 41: 9, 43: 9, 45: 9 },
        'ScratchDiskSettings': { 39: 4, 41: 4, 43: 4, 45: 4 },
        'WorkspaceSettings': { 39: 1, 41: 1, 43: 1, 45: 1 }
    };
    var SUPPORTED = [39, 41, 43, 45];
    var VER_NAME = {
        39: 'PR 2021', 40: 'PR 2022', 41: 'PR 2023',
        42: 'PR 2024', 43: 'PR 2025', 45: 'PR 2026'
    };
    var RENAME = {
        39: { 'DummyCaptureSettings': 'CaptureSettings' },
        41: { 'DummyCaptureSettings': 'CaptureSettings' },
        43: { 'CaptureSettings': 'DummyCaptureSettings' },
        45: { 'CaptureSettings': 'DummyCaptureSettings' }
    };
    var NEW_ONLY = ['ColorManagementSettings', 'ColorAwareEffectsEnabled'];

    // 支持的扩展名
    var EXTS = ['prtextstyle', 'prproj', 'prgraphicstyle'];

    // ---------- 读取 / 识别 ----------
    function readAny(file) {
        var raw = fs.readFileSync(file);
        if (raw[0] === 0x1f && raw[1] === 0x8b) {
            return { text: zlib.gunzipSync(raw).toString('utf8'), how: 'gzip' };
        }
        // 有些 prproj 是 zip 容器，按纯文本处理会失败 → 明确回报
        if (raw[0] === 0x50 && raw[1] === 0x4b) {
            return { text: null, how: 'zip' };
        }
        return { text: raw.toString('utf8'), how: 'plain' };
    }

    function detectVersion(text) {
        if (!text) return null;
        var m = text.match(/<Project\b[^>]*\bVersion="(\d+)"/);
        return m ? parseInt(m[1], 10) : null;
    }

    function detectFile(file) {
        var r = readAny(file);
        if (r.how === 'zip') return { ver: null, how: 'zip', err: 'ZIP 容器格式暂不支持' };
        return { ver: detectVersion(r.text), how: r.how, err: '' };
    }

    // ---------- 转换 ----------
    function convertText(text, target) {
        if (SUPPORTED.indexOf(target) < 0) {
            throw new Error('不支持转到工程版本 ' + target + '（可转：' + SUPPORTED.join(' / ') + '）');
        }
        var log = [];
        var srcVer = detectVersion(text);

        var ren = RENAME[target] || {};
        Object.keys(ren).forEach(function (oldTag) {
            var newTag = ren[oldTag];
            if (text.indexOf('<' + oldTag) >= 0) {
                text = text.replace(new RegExp('<' + oldTag + '(\\s)', 'g'), '<' + newTag + '$1');
                text = text.replace(new RegExp('</' + oldTag + '>', 'g'), '</' + newTag + '>');
                log.push('标签 ' + oldTag + ' → ' + newTag);
            }
        });

        var changed = 0;
        text = text.replace(/<([\w.]+)((?:(?:\s+(?![\/>]))[^>]*?)?)(\/?)>/g,
            function (whole, tag) {
                if (whole.indexOf('</') === 0) return whole;
                var map = SCHEMA[tag];
                if (!map) return whole;
                var tv = map[target];
                if (tv === undefined) return whole;
                var out = whole.replace(/\bVersion="\d+"/, 'Version="' + tv + '"');
                if (out !== whole) changed++;
                return out;
            });
        log.push('改写 ' + changed + ' 个版本号');

        if (target <= 41) {
            NEW_ONLY.forEach(function (tag) {
                var re1 = new RegExp('<' + tag + '>.*?</' + tag + '>\\s*', 'g');
                var before = text;
                text = text.replace(re1, '');
                if (text !== before) log.push('删除新版元素 ' + tag);
            });
        }
        return { text: text, log: log, srcVer: srcVer, dstVer: detectVersion(text) };
    }

    // ---------- 对外接口 ----------
    window.__vhPrConv = {
        supported: SUPPORTED,
        verName: VER_NAME,
        exts: EXTS,
        detect: function (file) {
            try { return detectFile(file); }
            catch (e) { return { ver: null, how: '?', err: e.message }; }
        },
        // 转换：srcFile -> outFile（不传则自动命名）
        convert: function (srcFile, outFile, target) {
            try {
                if (!fs.existsSync(srcFile)) return { ok: false, msg: '源文件不存在' };
                var r = readAny(srcFile);
                if (r.how === 'zip') {
                    return { ok: false, msg: '这是 ZIP 容器格式，暂不支持（多为压缩保存的工程文件）' };
                }
                if (!r.text) return { ok: false, msg: '读取失败' };
                var res = convertText(r.text, target);
                if (!res.dstVer) return { ok: false, msg: '输出里没找到版本号，可能不是 PR 文件' };

                if (!outFile) {
                    var ext = (srcFile.match(/\.[^.]+$/) || ['.prtextstyle'])[0];
                    outFile = srcFile.replace(/\.[^.]+$/, '') + '_' +
                        (VER_NAME[target] || ('v' + target)).replace(/\s+/g, '') + ext;
                }
                // 保持原压缩方式
                var buf = Buffer.from(res.text, 'utf8');
                if (r.how === 'gzip') buf = zlib.gzipSync(buf);
                fs.writeFileSync(outFile, buf);
                return {
                    ok: true, out: outFile, log: res.log,
                    srcVer: res.srcVer, dstVer: res.dstVer, how: r.how,
                    msg: '已转换 v' + res.srcVer + ' → ' + (VER_NAME[target] || target)
                };
            } catch (e) {
                return { ok: false, msg: e.message };
            }
        }
    };
})();
