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


    // ---------- 文本断句（剧本台词复制用） ----------
    // 主断句：句末标点（。！？；…及其英文对应），标点保留在前句末尾。
    // 次级（fallback）：仅逗号/顿号时按逗号切，供「前半句/后半句」用。
    // 返回 [{ text, start, end }]，start/end 是相对原串的下标，便于与选段拼接。
    function splitSentences(text) {
        var s = String(text == null ? '' : text);
        var out = [];
        if (!s) return out;
        // 句末标点：中文句号/问号/叹号/分号/省略号 + 英文 ! ? ;
        // 英文句点单列：只在「后面是空白或串尾」时算句末，避免把 3.5 / Dr. 之类误断
        var END = /[。！？；…!?;]/;
        var i = 0, n = s.length, segStart = 0;
        // 英文句点：后面是空白/串尾才算句末（'3.5'、'Dr.' 不误断）
        function isEnd(ch, idx) {
            if (END.test(ch)) return true;
            if (ch === '.') {
                var nx = s.charAt(idx + 1);
                return (idx + 1 >= n) || /\s/.test(nx);
            }
            return false;
        }
        while (i < n) {
            if (isEnd(s.charAt(i), i)) {
                // 连续标点（如「？！」）并到一个句子末尾
                var j = i;
                while (j + 1 < n && isEnd(s.charAt(j + 1), j + 1)) j++;
                var piece = s.slice(segStart, j + 1);
                if (piece.trim()) out.push({ text: piece.trim(), start: segStart, end: j + 1 });
                segStart = j + 1;
                i = j + 1;
            } else i++;
        }
        if (segStart < n) {
            var tail = s.slice(segStart);
            if (tail.trim()) out.push({ text: tail.trim(), start: segStart, end: n });
        }
        // 只有一段且内部有逗号 → 按逗号再切（供取前半/后半）
        if (out.length <= 1) {
            var byComma = splitByComma(s);
            if (byComma.length > 1) return byComma;
        }
        return out;
    }

    // 按逗号/顿号切（保留标点），仅用于「前半句/后半句」这种次级切分
    function splitByComma(text) {
        var s = String(text == null ? '' : text);
        var out = [];
        if (!s) return out;
        var COMMA = /[，,、]/;
        var i = 0, n = s.length, segStart = 0;
        while (i < n) {
            if (COMMA.test(s.charAt(i))) {
                var j = i;
                while (j + 1 < n && COMMA.test(s.charAt(j + 1))) j++;
                var piece = s.slice(segStart, j + 1);
                if (piece.trim()) out.push({ text: piece.trim(), start: segStart, end: j + 1 });
                segStart = j + 1;
                i = j + 1;
            } else i++;
        }
        if (segStart < n) {
            var tail = s.slice(segStart);
            if (tail.trim()) out.push({ text: tail.trim(), start: segStart, end: n });
        }
        return out;
    }

    // 在一个文本里，取「以 at（相对下标）为界的上半句 / 下半句」——
    // 用于用户选中了某个片段后，还想只要它前面/后面那半句
    function halfAround(text, at) {
        var s = String(text == null ? '' : text);
        if (!s) return null;
        var pivots = '，,、。！？；…!?;';
        var a = Number(at);
        if (!(a >= 0 && a <= s.length)) a = Math.floor(s.length / 2);
        // 找分界标点：先看 at 本身，再向右找第一个，再退而向左找最后一个。
        // （原来从 a-1 往左、从 a 往右找，标点恰在 a 时两边都落空 → 前半永远为空）
        var cut = -1;
        if (pivots.indexOf(s.charAt(a)) >= 0) cut = a;
        if (cut < 0) {
            for (var k = a; k < s.length; k++) { if (pivots.indexOf(s.charAt(k)) >= 0) { cut = k; break; } }
        }
        if (cut < 0) {
            for (var i = a - 1; i >= 0; i--) { if (pivots.indexOf(s.charAt(i)) >= 0) { cut = i; break; } }
        }
        if (cut < 0) return { head: '', tail: '', hasHead: false, hasTail: false };
        // head 含分界标点本身；tail 是标点之后
        var head = s.slice(0, cut + 1), tail = s.slice(cut + 1);
        return {
            head: head.trim(),
            tail: tail.trim(),
            hasHead: !!head.trim(),
            hasTail: !!tail.trim()
        };
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
        trackSpan: trackSpan,
        splitSentences: splitSentences,
        splitByComma: splitByComma,
        halfAround: halfAround
    };
})();
