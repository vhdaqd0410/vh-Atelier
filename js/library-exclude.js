// vh-Atelier 库面板排除目录公共模块
//
// 「音乐库」与「音效库」都需要「右键子文件夹 → 排除 → 扫描时跳过」，
// 这里收拢成一份实现，两面板只传配置。
//
// 用法：
//   var exc = window.__vhExclude.mount({ scope: 'musiclib', collectDir: collectDir });
//   exc.isExcluded(absPath)      查询
//   exc.toggle(absPath)          排除 / 取消排除（自动落盘）
//   exc.applyToTree(treeRoot)    把排除结果应用到已建好的树（清空被排除子树）
//   exc.buildMenu(menuEl, abs, onChange)  生成右键菜单项
//   exc.recount(treeRoot)        重算每个节点的 dirs/files 计数
//
// 存储：collect/<scope>_excludes.json —— 用户数据，升级与同步都不会覆盖。
(function () {
    'use strict';
    if (typeof window === 'undefined') return;

    var fs, path;
    try { fs = require('fs'); path = require('path'); } catch (e) { return; }

    // 路径归一：统一分隔符 + 去尾分隔符 + 小写（Windows 大小写不敏感）
    function norm(p) {
        var s = String(p == null ? '' : p).replace(/\//g, '\\');
        s = s.replace(/\\+$/, '');
        return s.toLowerCase();
    }
    // child 是否等于 parent 或位于其下
    function isUnder(child, parent) {
        var c = norm(child), p = norm(parent);
        if (!p) return false;
        if (c === p) return true;
        return c.indexOf(p + '\\') === 0;
    }

    function mount(cfg) {
        cfg = cfg || {};
        var scope = cfg.scope || 'lib';
        var collectDir = cfg.collectDir || '';
        var file = collectDir ? path.join(collectDir, scope + '_excludes.json') : '';
        var set = {};        // norm(path) -> 原始 path（保留用户输入形式，便于显示）
        var arr = [];

        function load() {
            set = {}; arr = [];
            if (!file) return;
            try {
                if (!fs.existsSync(file)) return;
                var a = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!Array.isArray(a)) return;
                a.forEach(function (p) {
                    if (!p) return;
                    var k = norm(p);
                    if (!set[k]) { set[k] = String(p); arr.push(String(p)); }
                });
            } catch (e) {}
        }
        function save() {
            if (!file) return false;
            try {
                if (!fs.existsSync(collectDir)) fs.mkdirSync(collectDir, { recursive: true });
                fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
                return true;
            } catch (e) { return false; }
        }

        load();

        function isExcluded(abs) {
            var n = norm(abs);
            if (!n) return false;
            if (set[n]) return true;
            // 也支持「父目录被排除」的情况（扫到子路径时同样应跳过）
            for (var i = 0; i < arr.length; i++) {
                if (isUnder(n, arr[i])) return true;
            }
            return false;
        }

        // 直接命中（不含父级继承），用于判断「这个目录本身」是否被排除
        function isDirectly(abs) { return !!set[norm(abs)]; }

        function add(abs) {
            if (!abs) return false;
            var k = norm(abs);
            if (set[k]) return true;
            set[k] = String(abs); arr.push(String(abs));
            save();
            return true;
        }
        function remove(abs) {
            var k = norm(abs);
            if (!set[k]) return false;
            delete set[k];
            var n2 = norm(abs);
            arr = arr.filter(function (p) { return norm(p) !== n2; });
            save();
            return true;
        }
        function toggle(abs) {
            if (isDirectly(abs)) { remove(abs); return false; }
            add(abs); return true;
        }
        function list() { return arr.slice(); }
        function size() { return arr.length; }

        // 把排除结果应用到树上：
        //   被排除的节点「保留可见」（便于右键取消），但清空其子树与文件，并标记 __excluded。
        // 返回被处理的节点数。
        function applyToTree(rootNode) {
            if (!rootNode) return 0;
            var n = 0;
            (function walk(node) {
                var kids = node.children || [];
                for (var i = 0; i < kids.length; i++) {
                    var c = kids[i];
                    if (isDirectly(c.abs)) {
                        c.children = [];
                        c.music = [];
                        c.__excluded = true;
                        n++;
                        continue;             // 不再向下
                    }
                    c.__excluded = false;
                    walk(c);
                }
            })(rootNode);
            return n;
        }

        // 重算每个节点的 dirs / files 计数
        function recount(node) {
            if (!node) return { dirs: 0, files: 0 };
            var dirs = 0, files = (node.music || []).length;
            var kids = node.children || [];
            for (var i = 0; i < kids.length; i++) {
                var r = recount(kids[i]);
                dirs += r.dirs + 1;
                files += r.files;
            }
            node.dirs = dirs;
            node.files = files;
            return node;
        }

        // 生成目录右键菜单项（复用面板已有的 .ctx-item / .ctx-sep 样式）
        // onChange(excluded:boolean) 由调用方传入，用于刷新界面
        function buildMenu(menuEl, abs, onChange) {
            if (!menuEl) return;
            menuEl.innerHTML = '';
            function item(text, fn, cls) {
                var d = document.createElement('div');
                d.className = 'ctx-item' + (cls ? ' ' + cls : '');
                d.textContent = text;
                d.addEventListener('click', function () { fn(); });
                return d;
            }
            var excluded = isDirectly(abs);
            menuEl.appendChild(item(
                excluded ? '✅ 取消排除（恢复扫描）' : '🚫 排除此文件夹',
                function () {
                    var now = toggle(abs);
                    if (onChange) onChange(now);
                }, excluded ? '' : 'ctx-warn'));
            menuEl.appendChild(item('📂 在资源管理器中打开', function () {
                try { require('child_process').spawn('explorer.exe', ['"' + abs + '"']); } catch (e) {}
            }));
            var sep = document.createElement('div');
            sep.className = 'ctx-sep';
            menuEl.appendChild(sep);
            var p = document.createElement('div');
            p.className = 'ctx-item';
            p.style.cssText = 'color:var(--muted);cursor:default;font-size:10px;white-space:normal;word-break:break-all;';
            p.textContent = abs;
            menuEl.appendChild(p);
        }

        return {
            scope: scope, file: file,
            isExcluded: isExcluded, isDirectly: isDirectly,
            add: add, remove: remove, toggle: toggle,
            list: list, size: size, reload: load,
            applyToTree: applyToTree, recount: recount,
            buildMenu: buildMenu, norm: norm, isUnder: isUnder
        };
    }

    window.__vhExclude = { mount: mount, _norm: norm, _isUnder: isUnder };
})();
