// ==========================================================================
// vh-Atelier · 翻译缓存
// --------------------------------------------------------------------------
// 目的：翻译过一次的字幕，下次打开自动带出，不重复请求免费接口。
//
// 设计：
//   以「原文文本 → 译文」做映射，按序列名分文件存 collect/translate_cache.json。
//   用原文做键而不是行号：字幕重新识别后行号会变，但文本不变就该复用。
//   同一序列同一模式（zh / bilingual）分开存，避免中文版覆盖双语版。
//   只存译文，不存时间轴。
//
// 对外：
//   window.__transCache.get(seqName, mode, text)   -> 译文或 null
//   window.__transCache.put(seqName, mode, pairs)  -> 批量写入（pairs: [[text, out]])
//   window.__transCache.stats(seqName, mode)       -> {count}
// ==========================================================================
(function () {
    'use strict';

    var fs, path, os;
    try {
        fs = require('fs');
        path = require('path');
    } catch (e) { /* 非 CEP 环境不启用 */ }

    function rootDir() {
        if (!fs || !path) return '';
        try {
            if (typeof CSInterface !== 'undefined') {
                var r = new CSInterface().getSystemPath('extension');
                if (r && fs.existsSync(r)) return r;
            }
        } catch (e1) {}
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (e2) {}
        return '';
    }

    function cacheFile() {
        var root = rootDir();
        return root ? path.join(root, 'collect', 'translate_cache.json') : '';
    }

    var _mem = null;       // { [seqName]: { zh: {text: out}, bilingual: {...} } }
    var _dirty = false;

    function load() {
        if (_mem) return _mem;
        _mem = {};
        try {
            var f = cacheFile();
            if (f && fs.existsSync(f)) {
                var j = JSON.parse(fs.readFileSync(f, 'utf8'));
                if (j && typeof j === 'object') _mem = j;
            }
        } catch (e) { _mem = {}; }
        return _mem;
    }

    function save() {
        if (!_dirty) return true;
        try {
            var f = cacheFile();
            if (!f) return false;
            var d = path.dirname(f);
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(f, JSON.stringify(_mem), 'utf8');
            _dirty = false;
            return true;
        } catch (e) { return false; }
    }

    function keyOf(seqName) {
        return String(seqName || '(未命名序列)').trim();
    }

    function get(seqName, mode, text) {
        var m = load();
        var s = m[keyOf(seqName)];
        if (!s) return null;
        var bucket = s[mode || 'zh'];
        if (!bucket) return null;
        var k = String(text || '').trim();
        if (!k) return null;
        return Object.prototype.hasOwnProperty.call(bucket, k) ? bucket[k] : null;
    }

    function put(seqName, mode, pairs) {
        if (!pairs || !pairs.length) return;
        var m = load();
        var key = keyOf(seqName);
        if (!m[key]) m[key] = {};
        var bucket = m[key][mode || 'zh'] || (m[key][mode || 'zh'] = {});
        var n = 0;
        pairs.forEach(function (p) {
            if (!p) return;
            var src = String(p[0] || '').trim();
            var out = p[1];
            if (!src || out == null) return;
            out = String(out);
            if (!out) return;
            if (bucket[src] !== out) { bucket[src] = out; n++; }
        });
        if (n) { _dirty = true; save(); }
    }

    function stats(seqName, mode) {
        var s = load()[keyOf(seqName)];
        if (!s) return { count: 0 };
        var bucket = s[mode || 'zh'];
        return { count: bucket ? Object.keys(bucket).length : 0 };
    }

    function clear(seqName) {
        var m = load();
        var key = keyOf(seqName);
        if (m[key]) { delete m[key]; _dirty = true; save(); return true; }
        return false;
    }

    window.__transCache = { get: get, put: put, stats: stats, clear: clear, _file: cacheFile };
})();
