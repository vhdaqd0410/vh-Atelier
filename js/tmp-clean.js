// vh-Atelier · 临时文件清理（通用工具）
// 各板块共用：统一登记自己的临时产物，提供「用完即删」与「一键清理」。
//
// 为什么需要：插件多处功能会在系统临时目录生成中间文件（音频、XML、json），
// 若只靠「下次同名时覆盖删除」，最后一次的产物会永久残留，长期累积占空间。
(function () {
    if (window.__vhTmp) return;

    var fs, path, os;
    try {
        fs = require('fs'); path = require('path'); os = require('os');
    } catch (e) { return; }

    // 已登记的临时命名空间：{ 前缀, 说明 }
    var NS = [
        { prefix: 'vh_cx_', label: '调色 XML 导出', kind: 'dir' },
        { prefix: 'vh_identify_', label: '听歌识曲录音', kind: 'file' },
        { prefix: 'vh_link_', label: '字幕链接', kind: 'file' },
        { prefix: 'vh_check_', label: '字幕校对', kind: 'file' },
        { prefix: 'vh_drivelabel_', label: '盘符标签', kind: 'file' },
        { prefix: 'vh_update_', label: '更新包', kind: 'file' },
        { prefix: 'ws_subtitle', label: '字幕识别音频', kind: 'dir' },
        { prefix: 'vc_clone', label: '语音克隆', kind: 'dir' },
        { prefix: 'vh_font_', label: '字体安装', kind: 'dir' },
        { prefix: 'cep_dir_', label: '文件夹选择器', kind: 'file' },
        { prefix: 'cep_td_', label: '待办导入', kind: 'file' },
    ];

    function tmpRoot() { return os.tmpdir(); }

    // ---------- 统计 ----------
    function statTree(dir) {
        var files = 0, bytes = 0;
        try {
            var es = fs.readdirSync(dir);
            for (var i = 0; i < es.length; i++) {
                var p = path.join(dir, es[i]);
                try {
                    var st = fs.statSync(p);
                    if (st.isDirectory()) {
                        var s = statTree(p); files += s.files; bytes += s.bytes;
                    } else { files++; bytes += st.size; }
                } catch (e) {}
            }
        } catch (e) {}
        return { files: files, bytes: bytes };
    }

    // 按命名空间汇总清理现状
    function scan() {
        var root = tmpRoot();
        var all;
        try { all = fs.readdirSync(root); } catch (e) { return { groups: [], total: { n: 0, bytes: 0 } }; }

        var groups = [];
        var totalN = 0, totalB = 0;

        for (var i = 0; i < NS.length; i++) {
            var ns = NS[i];
            var items = [];
            var bytes = 0, files = 0;
            for (var j = 0; j < all.length; j++) {
                if (all[j].indexOf(ns.prefix) !== 0) continue;
                var p = path.join(root, all[j]);
                try {
                    var st = fs.statSync(p);
                    var sz, fn;
                    if (st.isDirectory()) {
                        var t = statTree(p); sz = t.bytes; fn = t.files;
                    } else { sz = st.size; fn = 1; }
                    items.push({ name: all[j], path: p, bytes: sz, isDir: st.isDirectory() });
                    bytes += sz; files += fn;
                } catch (e) {}
            }
            if (items.length) {
                groups.push({
                    prefix: ns.prefix, label: ns.label,
                    count: items.length, files: files, bytes: bytes, items: items
                });
                totalN += items.length; totalB += bytes;
            }
        }
        return { groups: groups, total: { n: totalN, bytes: totalB } };
    }

    // ---------- 删除 ----------
    function rmTree(dir) {
        var n = 0;
        try {
            if (!fs.existsSync(dir)) return 0;
            var es = fs.readdirSync(dir);
            for (var i = 0; i < es.length; i++) {
                var p = path.join(dir, es[i]);
                try {
                    if (fs.statSync(p).isDirectory()) n += rmTree(p);
                    else { fs.unlinkSync(p); n++; }
                } catch (e) {}
            }
            try { fs.rmdirSync(dir); } catch (e) {}
        } catch (e) {}
        return n;
    }

    function rmOne(p) {
        try {
            if (!fs.existsSync(p)) return 0;
            if (fs.statSync(p).isDirectory()) return rmTree(p);
            fs.unlinkSync(p);
            return 1;
        } catch (e) { return 0; }
    }

    // 删除单个文件（忽略不存在）
    function rmFile(p) {
        try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    }

    // 清理全部登记的命名空间；only 可指定前缀数组
    function purge(only) {
        var root = tmpRoot();
        var set = null;
        if (only && only.length) {
            set = {};
            for (var k = 0; k < only.length; k++) set[only[k]] = true;
        }
        var res = { dirs: 0, files: 0, bytes: 0, groups: [] };
        var all;
        try { all = fs.readdirSync(root); } catch (e) { return res; }

        for (var i = 0; i < NS.length; i++) {
            var ns = NS[i];
            if (set && !set[ns.prefix]) continue;
            var gN = 0, gF = 0, gB = 0;
            for (var j = 0; j < all.length; j++) {
                if (all[j].indexOf(ns.prefix) !== 0) continue;
                var p = path.join(root, all[j]);
                try {
                    var st = fs.statSync(p);
                    var sz = st.isDirectory() ? statTree(p).bytes : st.size;
                    var fn = st.isDirectory() ? statTree(p).files : 1;
                    var n = rmOne(p);
                    if (!fs.existsSync(p)) {
                        gF += fn; gB += sz;
                        if (st.isDirectory()) gN++;
                    }
                } catch (e) {}
            }
            if (gF || gN) {
                res.groups.push({ prefix: ns.prefix, label: ns.label, count: gN, files: gF, bytes: gB });
                res.dirs += gN; res.files += gF; res.bytes += gB;
            }
        }
        return res;
    }

    function fmt(b) {
        if (b < 1024) return b + ' B';
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
        return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    window.__vhTmp = {
        scan: scan,
        purge: purge,
        rmTree: rmTree,
        rmFile: rmFile,
        fmt: fmt,
        ns: NS
    };
})();
