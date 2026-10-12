// vh-Atelier 共享工具函数
// 各板块（subtitle/check/clone/sfx/music/video/export）共用的纯函数收在这里，
// 挂在 window.__vhUtils，避免每个文件重复实现一份。
// 依赖：需要 extRoot 时由调用方传入（detectPython/extRoot 相关）
(function () {
    // ---------- SRT 解析/生成（秒）----------
    function parseTime(t) {
        var m = t.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
        if (!m) return 0;
        var h = parseInt(m[1]), mi = parseInt(m[2]), s = parseInt(m[3]), ms = parseInt(m[4]);
        return h * 3600 + mi * 60 + s + ms / 1000;
    }

    function parseSRT(content) {
        var subs = [];
        var lines = content.replace(/\r\n/g, '\n').split('\n');
        var i = 0;
        while (i < lines.length) {
            while (i < lines.length && lines[i].trim() === '') i++;
            if (i >= lines.length) break;
            if (/^\d+$/.test(lines[i].trim())) i++;
            if (i >= lines.length) break;
            var timeMatch = lines[i].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
            if (!timeMatch) { i++; continue; }
            var start = parseTime(timeMatch[1]);
            var end = parseTime(timeMatch[2]);
            i++;
            var text = [];
            while (i < lines.length && lines[i].trim() !== '') {
                text.push(lines[i].trim());
                i++;
            }
            subs.push({ start: start, end: end, text: text.join('\n') });
        }
        return subs;
    }

    function pad(n, w) {
        n = '' + n;
        while (n.length < w) n = '0' + n;
        return n;
    }

    function formatTime(sec) {
        var ms = Math.round(sec * 1000);
        var h = Math.floor(ms / 3600000);
        var m = Math.floor((ms % 3600000) / 60000);
        var s = Math.floor((ms % 60000) / 1000);
        var millis = ms % 1000;
        return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(millis, 3);
    }

    function toSRT(subs) {
        var out = '';
        subs.forEach(function (s, i) {
            out += (i + 1) + '\n';
            out += formatTime(s.start) + ' --> ' + formatTime(s.end) + '\n';
            out += s.text + '\n\n';
        });
        return out;
    }

    // ---------- HTML 转义 ----------
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---------- 判断是否含中文（用于选择匹配策略）----------
    function hasCJK(s) {
        return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s);
    }

    // ---------- MyMemory 翻译邮箱（带 de 参数提额 5000→50000 字/天）----------
    var MM_EMAIL_KEY = 'vh_mymemory_email';
    function getTranslateEmail() {
        try { return localStorage.getItem(MM_EMAIL_KEY) || ''; } catch (e) { return ''; }
    }
    function setTranslateEmail(email) {
        try {
            if (email) localStorage.setItem(MM_EMAIL_KEY, email.trim());
            else localStorage.removeItem(MM_EMAIL_KEY);
        } catch (e) {}
    }
    // 构造 MyMemory 请求 URL（带 email 提额）
    function myMemoryUrl(text) {
        var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
            '&langpair=en%7Czh-CN';
        var email = getTranslateEmail();
        if (email) url += '&de=' + encodeURIComponent(email);
        return url;
    }

    // ---------- Python 探测 ----------
    // 返回可用的 python 可执行路径；找不到返回 null。
    // extRoot 由调用方传入（各模块的 SystemPath.EXTENSION），runtime/python.exe 是可选便携候选。
    function detectPython(extRoot) {
        var fs = require('fs');
        var path = require('path');
        var os = require('os');
        var child_process = require('child_process');
        var candidates = [];
        if (extRoot) candidates.push(path.join(extRoot, 'runtime', 'python.exe'));
        candidates.push(
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
            'python',
            'py'
        );
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (c === 'python' || c === 'py') {
                // 用 where 探测，避免 spawn 到 WindowsApps 的假 python
                try {
                    var r = child_process.spawnSync('where', [c], { encoding: 'utf8' });
                    if (r.status === 0 && r.stdout) {
                        var lines = r.stdout.split(/\r?\n/).filter(function (l) { return l.trim(); });
                        for (var j = 0; j < lines.length; j++) {
                            var p = lines[j].trim();
                            // 排除 WindowsApps 商店占位符
                            if (p.indexOf('WindowsApps') < 0) return p;
                        }
                    }
                } catch (e) {}
            } else if (fs.existsSync(c)) {
                return c;
            }
        }
        return null;
    }


    // ---------- 语音克隆：入点出点 → 按轨取纯净素材 ----------
    // tracks: [{index, name, type:'audio'|'video', muted, clips:[{mediaPath, clipName,
    //           seqStart, mediaIn, mediaOut, ovStart, ovEnd, ovDur}]}]
    // 选轨优先级：非静音音频轨（覆盖时长最大）→ 任意音频轨 → 非静音视频轨 → 任意视频轨
    function pickRefTrack(tracks) {
        if (!tracks || !tracks.length) return null;
        function coverage(t) {
            var c = 0, cs = t.clips || [];
            for (var i = 0; i < cs.length; i++) c += Number(cs[i].ovDur) || 0;
            return c;
        }
        function best(list) {
            var b = null;
            for (var i = 0; i < list.length; i++) {
                var cov = coverage(list[i]);
                if (!b || cov > b.cov) b = { t: list[i], cov: cov };
            }
            return b ? b.t : null;
        }
        function pick(pred) {
            var out = [];
            for (var i = 0; i < tracks.length; i++) if (pred(tracks[i])) out.push(tracks[i]);
            return out;
        }
        var audio = pick(function (t) { return t.type === 'audio'; });
        var video = pick(function (t) { return t.type !== 'audio'; });
        var live = function (t) { return !t.muted; };
        return best(pick(function (t) { return t.type === 'audio' && !t.muted; }))
            || best(audio)
            || best(pick(function (t) { return t.type !== 'audio' && !t.muted; }))
            || best(video);
    }

    // 把某轨在 [inSec,outSec] 内的片段换算为截取段：
    //   srcStart = 素材内偏移 = mediaIn + (重叠起点 - 片段在序列上的起点)
    //   take     = 该段实际取多长
    // 段按时间排序；段间空白直接略过（拼接后变短，由调用方告知用户）
    function buildRefSegments(clips, inSec, outSec) {
        var segs = [];
        for (var i = 0; i < (clips || []).length; i++) {
            var c = clips[i];
            var ovS = Math.max(Number(c.ovStart), Number(inSec));
            var ovE = Math.min(Number(c.ovEnd), Number(outSec));
            if (!(ovE - ovS > 0.001)) continue;
            var srcStart = Number(c.mediaIn) + (ovS - Number(c.seqStart));
            if (!(srcStart >= 0)) srcStart = 0;
            segs.push({
                mediaPath: c.mediaPath,
                clipName: c.clipName || '',
                srcStart: Math.round(srcStart * 1000) / 1000,
                take: Math.round((ovE - ovS) * 1000) / 1000,
                ovStart: ovS,
                ovEnd: ovE
            });
        }
        segs.sort(function (a, b) { return a.ovStart - b.ovStart; });
        return segs;
    }


    // 某轨在 [inSec,outSec] 内「真正有声音」的范围（用于把渲染区间收紧到内容本身，
    // 避免 I/O 拉宽时把区间内的空白也渲进来、撞上 30 秒上限）
    function trackSpan(clips, inSec, outSec) {
        var s = null, e = null;
        for (var i = 0; i < (clips || []).length; i++) {
            var c = clips[i];
            var a = Math.max(Number(c.ovStart), Number(inSec));
            var b = Math.min(Number(c.ovEnd), Number(outSec));
            if (!(b - a > 0.001)) continue;
            if (s === null || a < s) s = a;
            if (e === null || b > e) e = b;
        }
        if (s === null) return null;
        return { start: s, end: e, seconds: e - s };
    }

    window.__vhUtils = {
        parseTime: parseTime,
        parseSRT: parseSRT,
        pad: pad,
        formatTime: formatTime,
        toSRT: toSRT,
        escapeHtml: escapeHtml,
        hasCJK: hasCJK,
        detectPython: detectPython,
        getTranslateEmail: getTranslateEmail,
        setTranslateEmail: setTranslateEmail,
        myMemoryUrl: myMemoryUrl,
        pickRefTrack: pickRefTrack,
        buildRefSegments: buildRefSegments,
        trackSpan: trackSpan
    };
})();
