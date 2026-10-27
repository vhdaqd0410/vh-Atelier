// vh-Atelier · 样式字体名替换（PR 版本转换配套 · 方案A）
// ==========================================================================
// 用途：样式里引用的字体在本机不存在时，把字体名改成实际存在的名字。
//
// 存储结构（实测）：
//   样式里「源文本」参数是 base64 编码的二进制，字体名以
//     [长度 u32][名称字节]
//   形式存放。所以替换时：
//     · 等长名字 → 可原位替换（最安全）
//     · 不等长   → 必须同步改长度字段，且名称之后的偏移会移动
//
// 本模块只做「等长替换」，避免破坏后续结构。
// 不等长的情形需要重建二进制，风险高，此处不做（宁可拒绝，也不出错）。
(function () {
    var fs, path;
    try {
        fs = require('fs');
        path = require('path');
    } catch (e) { return; }

    // 常见缺失字体 → 本机可用的等长替代
    // 硬约束：key 与 value 必须【字节数完全相同】，否则会破坏样式内部结构。
    // 因此这里只收 16 字节的名字（与 Bahnschrift-Bold 等长）。
    var LEN16_MAP = {
        'Bahnschrift-Bold': 'Bahnschrift Bold'    // 破折号换成空格，长度不变
    };

    function findAll(buf, needle) {
        var out = [], i = 0;
        while (true) {
            var k = buf.indexOf(needle, i);
            if (k < 0) break;
            out.push(k);
            i = k + 1;
        }
        return out;
    }

    // 找出样式里被「长度字段 + 名称」包裹的字体名位置
    function findFontEntries(buf, name) {
        var hits = [];
        var nb = Buffer.from(name, 'ascii');
        findAll(buf, nb).forEach(function (off) {
            var okLen = false;
            if (off >= 4) {
                var len = buf.readUInt32LE(off - 4);
                okLen = (len === nb.length);
            }
            hits.push({ offset: off, lenOk: okLen, len: nb.length });
        });
        return hits;
    }

    // 从 prtextstyle 文本里取出 base64 blob 的位置
    function findBlobs(text) {
        var out = [];
        var re = /(<StartKeyframeValue[^>]*Encoding="base64"[^>]*>)([A-Za-z0-9+/=\s]+)(<\/StartKeyframeValue>)/g;
        var m;
        while ((m = re.exec(text))) {
            out.push({ start: m.index + m[1].length, end: m.index + m[1].length + m[2].length, raw: m[2] });
        }
        return out;
    }

    // 列出样式里所有「疑似字体名」的字符串（供 UI 展示）
    function listFontNames(text) {
        var names = {};
        findBlobs(text).forEach(function (b) {
            var buf;
            try { buf = Buffer.from(b.raw.replace(/\s+/g, ''), 'base64'); }
            catch (e) { return; }
            // 在二进制里扫「长度前缀 + 可打印 ASCII」模式
            for (var i = 4; i < buf.length - 4; i++) {
                var len = buf.readUInt32LE(i - 4);
                if (len < 4 || len > 80) continue;
                if (i + len > buf.length) continue;
                var seg = buf.slice(i, i + len).toString('ascii');
                if (!/^[A-Za-z][A-Za-z0-9\-_. ]*$/.test(seg)) continue;
                // 至少含一个字母，且不全是常见结构词
                if (/^(true|false|none|copy|start|end)$/i.test(seg)) continue;
                names[seg] = (names[seg] || 0) + 1;
            }
        });
        return names;
    }

    // 替换字体名（只等长替换）
    // 返回 {ok, msg, replaced, text}
    function replaceFontName(text, from, to) {
        if (from === to) return { ok: true, msg: '无需替换', replaced: 0, text: text };
        if (from.length !== to.length) {
            return {
                ok: false,
                msg: '不支持不等长替换（' + from + ' ' + from.length + ' → ' + to + ' ' + to.length +
                     '）：会破坏样式内部结构。已跳过。',
                replaced: 0, text: text
            };
        }
        var total = 0;
        var blobs = findBlobs(text);
        // 从后往前替换，避免位移影响
        blobs.slice().reverse().forEach(function (b) {
            var raw = b.raw;
            var compact = raw.replace(/\s+/g, '');
            var buf = Buffer.from(compact, 'base64');
            var hits = findFontEntries(buf, from);
            var good = hits.filter(function (h) { return h.lenOk; });
            if (!good.length) return;
            good.forEach(function (h) {
                buf.write(to, h.offset, 'ascii');
            });
            total += good.length;
            var newRaw = buf.toString('base64');
            // 按 base64 换行长度还原（原本可能带换行，简单处理为不带换行）
            text = text.slice(0, b.start) + newRaw + text.slice(b.end);
        });
        return { ok: true, replaced: total, text: text, msg: '已替换 ' + total + ' 处字体名' };
    }

    window.__vhFontFix = {
        listFontNames: listFontNames,
        replaceFontName: replaceFontName,
        len16Map: LEN16_MAP,
        // 便捷：用内置映射修一个文件
        fixFile: function (srcFile, outFile) {
            try {
                var text = fs.readFileSync(srcFile, 'utf8');
                var names = listFontNames(text);
                var fixedAny = 0, logs = [];
                Object.keys(names).forEach(function (nm) {
                    var to = LEN16_MAP[nm];
                    if (!to) return;
                    var r = replaceFontName(text, nm, to);
                    if (r.ok && r.replaced) {
                        text = r.text;
                        fixedAny += r.replaced;
                        logs.push(nm + ' → ' + to + ' x' + r.replaced);
                    } else if (!r.ok) {
                        logs.push('跳过：' + r.msg);
                    }
                });
                if (!outFile) outFile = srcFile.replace(/\.[^.]+$/, '') + '_字体修正.prtextstyle';
                if (fixedAny) fs.writeFileSync(outFile, text, 'utf8');
                return {
                    ok: true, replaced: fixedAny, out: fixedAny ? outFile : '',
                    found: Object.keys(names), log: logs,
                    msg: fixedAny ? ('修正 ' + fixedAny + ' 处') : '没找到需要修正的字体名'
                };
            } catch (e) {
                return { ok: false, msg: e.message };
            }
        }
    };
})();
