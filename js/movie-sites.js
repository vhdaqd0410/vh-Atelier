// vh-Atelier 影视板块 · 源配置模块
// 设计参考 uzVideo 的「自定义源 + 订阅更新」思路，但适配苹果 CMS 标准接口：
//   1) 源存在 localStorage，可增删改
//   2) 支持从远程 URL 订阅（JSON），合并进本地配置
//   3) 内置一份默认源（实测可用且非成人站）
(function () {
    var KEY = 'vh_movie_sites';
    var SUB_KEY = 'vh_movie_subs';

    // 内置默认源（2026-09-28 实测可用；已剔除 adult 源）
    var DEFAULTS = [
        { key: 'ffzy',  name: '非凡影视', api: 'http://ffzy5.tv' },
        { key: 'zy360', name: '360资源',  api: 'https://360zy.com' },
        { key: 'jisu',  name: '极速资源', api: 'https://jszyapi.com' },
        { key: 'bfzy',  name: '暴风资源', api: 'https://bfzyapi.com' },
        { key: 'mdzy',  name: '魔都资源', api: 'https://www.mdzyapi.com' },
        { key: 'ruyi',  name: '如意资源', api: 'https://cj.rycjapi.com' }
    ];

    function normSite(s) {
        if (!s || typeof s !== 'object') return null;
        var api = String(s.api || s.url || '').trim().replace(/\/+$/, '');
        if (!api) return null;
        // 必须是 http/https 地址，否则不是合法的采集站接口
        if (!/^https?:\/\//i.test(api)) return null;
        var name = String(s.name || '').trim() || api.replace(/^https?:\/\//, '').split('/')[0];
        var key = String(s.key || name).trim();
        return { key: key, name: name, api: api };
    }

    // 归一化比较：忽略协议与末尾斜杠，让删除/查重对用户传入的各种写法都能命中
    function sameHost(a, b) {
        var f = function (u) { return String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, ''); };
        return f(a) === f(b);
    }

    function load() {
        var list = [];
        try {
            var raw = localStorage.getItem(KEY);
            if (raw) {
                var arr = JSON.parse(raw);
                if (Array.isArray(arr)) list = arr.map(normSite).filter(Boolean);
            }
        } catch (e) {}
        if (!list.length) list = DEFAULTS.slice();
        return list;
    }

    function save(list) {
        try {
            localStorage.setItem(KEY, JSON.stringify((list || []).map(normSite).filter(Boolean)));
        } catch (e) {}
    }

    function add(site) {
        var api = String((site && site.api) || '').trim();
        if (!/^https?:\/\//i.test(api)) {
            return { ok: false, msg: '接口地址需以 http:// 或 https:// 开头' };
        }
        var s = normSite(site);
        if (!s) return { ok: false, msg: '源地址无效' };
        var list = load();
        if (list.some(function (x) { return sameHost(x.api, s.api); })) {
            return { ok: false, msg: '该源已存在' };
        }
        list.push(s);
        save(list);
        return { ok: true, list: list, site: s };
    }

    function remove(keyOrApi) {
        var list = load().filter(function (x) {
            if (x.key === keyOrApi) return false;
            if (sameHost(x.api, keyOrApi)) return false;
            return true;
        });
        save(list);
        return list;
    }

    function update(keyOrApi, patch) {
        var list = load();
        list.forEach(function (x) {
            if (x.key === keyOrApi || x.api === keyOrApi) {
                if (patch.name) x.name = patch.name;
                if (patch.api) x.api = String(patch.api).trim().replace(/\/+$/, '');
            }
        });
        save(list);
        return list;
    }

    function reset() {
        save(DEFAULTS.slice());
        return DEFAULTS.slice();
    }

    // ---------- 订阅 ----------
    // 订阅格式（兼容多种写法，尽量宽容）：
    //   { "sites": [{name, api}] }  或  [{name, api}]  或  ["https://xxx.com"]
    function parseSub(json) {
        var out = [];
        var arr = null;
        if (Array.isArray(json)) arr = json;
        else if (json && Array.isArray(json.sites)) arr = json.sites;
        else if (json && Array.isArray(json.list)) arr = json.list;
        if (!arr) return out;
        arr.forEach(function (it) {
            if (typeof it === 'string') {
                var s = normSite({ api: it });
                if (s) out.push(s);
            } else {
                var s2 = normSite(it);
                if (s2) out.push(s2);
            }
        });
        return out;
    }

    function loadSubs() {
        try {
            var raw = localStorage.getItem(SUB_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }
    function saveSubs(arr) {
        try { localStorage.setItem(SUB_KEY, JSON.stringify(arr || [])); } catch (e) {}
    }
    function addSub(url) {
        url = String(url || '').trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, msg: '订阅地址需以 http(s):// 开头' };
        var arr = loadSubs();
        if (arr.indexOf(url) >= 0) return { ok: false, msg: '该订阅已存在' };
        arr.push(url);
        saveSubs(arr);
        return { ok: true, subs: arr };
    }
    function removeSub(url) {
        var arr = loadSubs().filter(function (x) { return x !== url; });
        saveSubs(arr);
        return arr;
    }

    window.__vhMovieSites = {
        DEFAULTS: DEFAULTS,
        load: load,
        save: save,
        add: add,
        remove: remove,
        update: update,
        reset: reset,
        parseSub: parseSub,
        loadSubs: loadSubs,
        saveSubs: saveSubs,
        addSub: addSub,
        removeSub: removeSub
    };
})();
