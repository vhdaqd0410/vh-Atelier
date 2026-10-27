// vh-Atelier 音频导出预设公共模块
//
// 用途：凡是需要「渲染一段音频」的地方（音效库精确模式、语音克隆入点出点）都要：
//   1) 找到可用的音频类 .epr 预设（PR 的 exportAsMediaDirect / encoder 必须传预设）
//   2) 导出后校验产出真的是 wav（预设若配成视频容器，PR 会输出 MOV/MP4 只是后缀叫 .wav）
// 把这套逻辑收在这里，避免每个面板各抄一份。
//
// 挂在 window.__vhAudioPreset
(function () {
    'use strict';
    if (typeof window === 'undefined') return;
    var fs, os, path;
    try { fs = require('fs'); os = require('os'); path = require('path'); } catch (e) { return; }

    // ExporterFileType 的 fourCC 数字 → 容器后缀（与 sfx-capture 同口径）
    var AUDIO_FOURCC = {
        1463899717: 'wav',    // WAVE
        1095321158: 'aif',    // AIFF
        1295275552: 'wav',    // WAVE 另一种写法
        1096106052: 'aif',    // AIFC
        1832149350: 'mp3',    // .mp3
        1633972066: 'm4a'     // M4A
    };

    // 搜索根：用户 AME 预设目录 + Adobe 自带系统预设目录
    function defaultRoots() {
        var out = [];
        try { out.push(path.join(os.homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder')); } catch (e) {}
        ['C:\\Program Files\\Adobe', 'C:\\Program Files (x86)\\Adobe'].forEach(function (pf) {
            try {
                if (!fs.existsSync(pf)) return;
                fs.readdirSync(pf).forEach(function (n) {
                    if (/Media Encoder/i.test(n)) out.push(path.join(pf, n, 'Settings', 'EncoderPresets'));
                });
            } catch (e) {}
        });
        return out.filter(function (p) { return !!p; });
    }
    var ROOTS = defaultRoots();
    // 可覆盖搜索根（便于测试，也便于将来加别的预设目录）
    function setRoots(arr) { if (arr && arr.length) ROOTS = arr.slice(); }

    function presetFileType(fullPath) {
        try {
            var raw = fs.readFileSync(fullPath, 'utf8');
            var m = raw.match(/<ExporterFileType>(\d+)<\/ExporterFileType>/);
            return m ? parseInt(m[1], 10) : 0;
        } catch (e) { return 0; }
    }
    function isAudioPreset(fullPath) { return !!AUDIO_FOURCC[presetFileType(fullPath)]; }
    function extOf(fullPath) { return AUDIO_FOURCC[presetFileType(fullPath)] || ''; }

    // 扫出所有音频类 .epr（按 名字+后缀 去重，避免多个版本目录里同一预设重复）
    function scanAudioPresets() {
        var hits = [], seen = {};
        ROOTS.forEach(function (root) {
            (function walk(dir, depth) {
                if (depth > 4) return;
                var items;
                try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
                items.forEach(function (it) {
                    var full = path.join(dir, it.name);
                    if (it.isDirectory && it.isDirectory()) { walk(full, depth + 1); return; }
                    if (!/\.epr$/i.test(it.name)) return;
                    var ft = presetFileType(full);
                    if (!AUDIO_FOURCC[ft]) return;
                    var key = it.name.toLowerCase() + '|' + AUDIO_FOURCC[ft];
                    if (seen[key]) return;
                    seen[key] = 1;
                    hits.push({ name: it.name, full: full, fileType: ft, ext: AUDIO_FOURCC[ft] });
                });
            })(root, 0);
        });
        return hits;
    }

    // 挑一个音频预设（顺序确定，不受 readdir 顺序影响）：
    //   1) 指定的（上次用的）且确实存在、确实是音频预设
    //   2) 名字像「给人声/调音用」的（调音/人声/voice/vocal/音频/声音/audio/sound）
    //   3) wav / aif
    //   4) 任意音频预设
    function pickAudioPreset(opts) {
        opts = opts || {};
        var list = opts.list || scanAudioPresets();
        if (opts.saved) {
            var hit = null;
            list.forEach(function (p) { if (p.full === opts.saved) hit = p; });
            if (hit) return hit;
            if (fs.existsSync(opts.saved) && isAudioPreset(opts.saved)) {
                return { name: path.basename(opts.saved), full: opts.saved,
                         fileType: presetFileType(opts.saved), ext: extOf(opts.saved) };
            }
        }
        if (!list.length) {
            return { error: '没找到音频类导出预设（.epr）。请在 PR 的「导出设置」里选 WAV 格式并另存为预设（例如命名「调音输出」），再回来刷新。' };
        }
        var byName = list.filter(function (p) { return /调音|人声|voice|vocal|音频|声音|audio|sound/i.test(p.name); });
        if (byName.length) return byName[0];
        var byExt = list.filter(function (p) { return p.ext === 'wav' || p.ext === 'aif'; });
        return byExt.length ? byExt[0] : list[0];
    }

    // 校验产出真的是 wav（RIFF/WAVE）。预设选成视频时 PR 会输出 MOV/MP4，只是后缀叫 .wav。
    // 失败时顺手删掉这个无效文件，避免污染。
    function verifyWav(p) {
        try {
            if (!fs.existsSync(p)) return { ok: false, msg: '导出后未找到文件' };
            var fd = fs.openSync(p, 'r');
            var head = Buffer.alloc(12);
            fs.readSync(fd, head, 0, 12, 0);
            fs.closeSync(fd);
            var riff = head.toString('latin1', 0, 4);
            var wave = head.toString('latin1', 8, 12);
            if (riff === 'RIFF' && wave === 'WAVE') return { ok: true };
            var what = '未知格式';
            if (head.toString('latin1', 4, 8) === 'ftyp') what = 'MOV/MP4 视频容器';
            else if (head.toString('latin1', 0, 3) === 'ID3') what = 'MP3 音频';
            else if (head[0] === 0x1a && head[1] === 0x45) what = 'MKV 容器';
            try { fs.unlinkSync(p); } catch (e) {}
            return { ok: false, msg: '导出结果不是 wav（实际为' + what + '）。所选预设的输出格式不是 WAV，'
                + '请换一个音频预设，或改用「直接截取原素材」。已删除该无效文件' };
        } catch (e) { return { ok: false, msg: '校验导出结果失败：' + e.message }; }
    }

    window.__vhAudioPreset = {
        AUDIO_FOURCC: AUDIO_FOURCC,
        presetFileType: presetFileType,
        isAudioPreset: isAudioPreset,
        extOf: extOf,
        scanAudioPresets: scanAudioPresets,
        pickAudioPreset: pickAudioPreset,
        verifyWav: verifyWav,
        setRoots: setRoots,
        defaultRoots: defaultRoots
    };
})();
