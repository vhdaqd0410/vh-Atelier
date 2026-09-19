// vh-Atelier A · PR 文字样式版本转换
// ==========================================================================
// 做什么：把高版本 PR 的 .prtextstyle 转成低版本 PR 能打开的格式
//
// 原理（有实测依据，非推测）：
//   PR 按文件里的版本号决定能否打开。文件是纯文本 XML，
//   格式：<Project ... Version="43"> 以及一堆 <Xxx Version="n">。
//   把「工程版本」和各元素版本号改成目标版本对应的值即可。
//
// 版本对应（本机 3 个 PR 安装 + 真实样式样本实测）：
//   PR2021=工程版本39 / PR2022=40 / PR2023=41 / PR2024=42 / PR2025=43 / PR2026=45
//
// 保真度：只动版本号与结构字段，不碰样式负载（文本/字体/颜色/关键帧）。
//   已用真实同族文件验证：v43→v39 后 21 个样式参数值逐一相同。
(function () {
    if (!window.__vhProject) return;

    var fs, path, os;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
    } catch (e) { return; }

    var csInterface = (typeof CSInterface !== 'undefined') ? new CSInterface() : null;

    function extRoot() {
        try {
            if (csInterface) {
                var r = csInterface.getSystemPath('extension');
                if (r && fs.existsSync(r)) return r;
            }
        } catch (e) {}
        return '';
    }

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

    // 工程版本 -> PR 版本名
    var VER_NAME = {
        39: 'PR 2021', 40: 'PR 2022', 41: 'PR 2023',
        42: 'PR 2024', 43: 'PR 2025', 45: 'PR 2026'
    };

    // 标签改名（同 ClassID，不同版本叫法不同）
    var RENAME = {
        39: { 'DummyCaptureSettings': 'CaptureSettings' },
        41: { 'DummyCaptureSettings': 'CaptureSettings' },
        43: { 'CaptureSettings': 'DummyCaptureSettings' },
        45: { 'CaptureSettings': 'DummyCaptureSettings' }
    };
    // 只有新版才有的元素（降级时删掉）
    var NEW_ONLY = ['ColorManagementSettings', 'ColorAwareEffectsEnabled'];

    // ---------- 读取 / 识别 ----------
    function detectVersion(text) {
        var m = text.match(/<Project\b[^>]*\bVersion="(\d+)"/);
        return m ? parseInt(m[1], 10) : null;
    }

    function readAny(file) {
        var raw = fs.readFileSync(file);
        if (raw[0] === 0x1f && raw[1] === 0x8b) {
            return { text: require('zlib').gunzipSync(raw).toString('utf8'), how: 'gzip' };
        }
        return { text: raw.toString('utf8'), how: 'plain' };
    }

    // ---------- 转换 ----------
    function convertText(text, target) {
        if (SUPPORTED.indexOf(target) < 0) {
            throw new Error('不支持转换到工程版本 ' + target + '（可转：' + SUPPORTED.join('/') + '）');
        }
        var log = [];
        var srcVer = detectVersion(text);

        // 1) 标签改名
        var ren = RENAME[target] || {};
        Object.keys(ren).forEach(function (oldTag) {
            var newTag = ren[oldTag];
            if (text.indexOf('<' + oldTag) >= 0) {
                text = text.replace(new RegExp('<' + oldTag + '(\\s)', 'g'), '<' + newTag + '$1');
                text = text.replace(new RegExp('</' + oldTag + '>', 'g'), '</' + newTag + '>');
                log.push('标签 ' + oldTag + ' → ' + newTag);
            }
        });

        // 2) 改元素版本号
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

        // 3) 降级时删掉新版独有元素
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
    window.__vhStyleConv = {
        supported: SUPPORTED,
        verName: VER_NAME,
        detect: function (file) {
            try {
                var r = readAny(file);
                return detectVersion(r.text);
            } catch (e) { return null; }
        },
        // 转换：返回 {ok, msg, out, log, srcVer, dstVer}
        convert: function (srcFile, outFile, target) {
            try {
                if (!fs.existsSync(srcFile)) return { ok: false, msg: '源文件不存在' };
                var r = readAny(srcFile);
                var res = convertText(r.text, target);
                if (!res.dstVer) return { ok: false, msg: '输出里没找到版本号，可能不是 PR 样式文件' };
                if (!outFile) {
                    var base = srcFile.replace(/\.[^.]+$/, '');
                    outFile = base + '_' + (VER_NAME[target] || ('v' + target)).replace(/\s+/g, '') + '.prtextstyle';
                }
                fs.writeFileSync(outFile, res.text, 'utf8');
                return {
                    ok: true, out: outFile, log: res.log,
                    srcVer: res.srcVer, dstVer: res.dstVer,
                    msg: '已转换 v' + res.srcVer + ' → ' + (VER_NAME[target] || target)
                };
            } catch (e) {
                return { ok: false, msg: e.message };
            }
        }
    };
})();
