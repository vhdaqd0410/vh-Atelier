// vh-Atelier 全局热键桥（隐藏面板）
// 职责：PR 启动时自动加载（AutoVisible=false），spawn 全局键盘钩子 vh_keyhook.exe，
// 读它的 stdout（JSON），命中热键时广播 CSEvent 给主面板。
// 支持多热键：每个热键绑定一个命令 id，命令分发到不同执行路径：
//   - openSearch        → 打开音效搜索浮窗
// 命令映射存 collect/hotkey.json，主面板写入并广播 reload 事件，本面板换键重启钩子。
// 架构参照 Knights of the Editing Table 的 Spell Book：exe 钩键 → stdout → CEP 广播。
(function () {
    var cs = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    var EVENT_HOTKEY = 'com.vh.atelier.hotkey';
    var EVENT_RELOAD = 'com.vh.atelier.hotkey.reload';
    var EVENT_CLOSING = 'com.vh.atelier.search.closing';
    var SEARCH_EXT_ID = 'com.vh.atelier.search';

    var extRoot = cs.getSystemPath(SystemPath.EXTENSION);
    var hookPath = path.join(extRoot, 'keyhook', 'vh_keyhook.exe');
    var collectDir = path.join(extRoot, 'collect');
    var hotkeyFile = path.join(collectDir, 'hotkey.json');
    var openTabFile = path.join(collectDir, 'opentab.json');

    var child = null;
    var lastCloseTime = 0; // search 面板上次关闭时间（兼容旧冷却，已由 ready 状态机取代）

    // search 浮窗状态机：idle（已卸载）/ loading（加载中）/ open（已就绪）
    var searchState = 'idle';
    var pendingOpen = false; // loading 期间是否有重开请求排队
    var loadTimeout = null;   // loading 超时兜底

    var EVENT_SEARCH_READY = 'com.vh.atelier.search.ready';

    // 默认命令→热键映射（无配置文件时用）
    var DEFAULT_MAP = {
        openSearch: 'ctrl+f2'
    };

    function log(msg) {
        try {
            console.log('[vh-keyhook] ' + msg);
            var logFile = path.join(extRoot, 'collect', 'keyhook.log');
            if (!fs.existsSync(path.dirname(logFile))) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (e) {} }
            var stamp = new Date().toISOString();
            fs.appendFileSync(logFile, stamp + ' ' + msg + '\n', 'utf8');
        } catch (e) {}
    }

    function broadcast(data) {
        try {
            var evt = new CSEvent(EVENT_HOTKEY, 'APPLICATION');
            evt.data = JSON.stringify(data);
            cs.dispatchEvent(evt);
        } catch (e) {
            log('dispatch err: ' + e.message);
        }
    }

    // 打开搜索浮窗（Spotlight 式），带初始 tab 参数
    function openSearch(tab) {
        if (searchState === 'open') {
            // 已就绪：直接激活（秒响应，无需重新加载）
            requestOpen();
            return;
        }
        if (searchState === 'loading') {
            // 加载中：排队，等 ready 后补开一次
            pendingOpen = true;
            log('search loading, queue reopen');
            return;
        }
        // idle：首次加载，requestOpen 后进入 loading
        pendingOpen = false;
        requestOpen();
        searchState = 'loading';
        armLoadTimeout();
    }

    function requestOpen() {
        try {
            // 用共享文件记录（供首次加载时读，虽当前仅音效，保留结构以备扩展）
            try {
                if (!fs.existsSync(collectDir)) fs.mkdirSync(collectDir, { recursive: true });
                fs.writeFileSync(openTabFile, JSON.stringify({ tab: 'sfx', ts: Date.now() }), 'utf8');
            } catch (e) { log('write opentab err: ' + e.message); }
            cs.requestOpenExtension(SEARCH_EXT_ID, '');
            log('requestOpenExtension sent: ' + SEARCH_EXT_ID);
        } catch (e) {
            log('openSearch err: ' + e.message);
        }
    }

    // loading 超时兜底：浮窗未在预期时间内就绪，强制回 idle 重试一次
    function armLoadTimeout() {
        if (loadTimeout) clearTimeout(loadTimeout);
        loadTimeout = setTimeout(function () {
            log('search load timeout, reset to idle');
            searchState = 'idle';
            pendingOpen = false;
        }, 4000);
    }

    // 从配置文件读命令→热键映射；兼容旧版 { combo } 格式
    function readMap() {
        try {
            if (fs.existsSync(hotkeyFile)) {
                var obj = JSON.parse(fs.readFileSync(hotkeyFile, 'utf8'));
                if (obj && obj.map && typeof obj.map === 'object') return obj.map;
                // 兼容旧版 { combo: "ctrl+f2" }
                if (obj && obj.combo && obj.combo.trim()) return { openSearch: obj.combo.trim() };
            }
        } catch (e) {}
        return DEFAULT_MAP;
    }

    // 上次选中的效果/转场 matchName（由搜索浮窗写入，供全局快捷键直接施加）——已废弃，仅音效搜索保留 openSearch

    function stop() {
        if (child) {
            try { child.kill(); } catch (e) {}
            child = null;
        }
    }

    function start() {
        stop();
        if (!fs.existsSync(hookPath)) {
            log('hook exe missing: ' + hookPath);
            broadcast({ type: 'error', msg: 'hook exe 缺失' });
            return;
        }
        var map = readMap();
        var args = [];
        for (var id in map) {
            if (map[id]) args.push(id + '=' + map[id]);
        }
    if (args.length === 0) args.push('openSearch=ctrl+f2');
        log('spawning ' + hookPath + ' with ' + args.join(' '));
        child = childProcess.spawn(hookPath, args);

        child.stdout.on('data', function (chunk) {
            var text = chunk.toString();
            text.split('\n').forEach(function (line) {
                line = line.trim();
                if (!line) return;
                var data;
                try { data = JSON.parse(line); } catch (e) { return; }
                log('stdout: ' + line);
                if (data.type === 'ready') {
                    broadcast({ type: 'ready', hotkeys: data.hotkeys });
                } else if (data.type === 'hotkey') {
                    dispatch(data.id, data);
                } else if (data.type === 'error') {
                    broadcast({ type: 'error', msg: data.msg });
                }
            });
        });

        child.stderr.on('data', function (chunk) {
            log('stderr: ' + chunk.toString());
        });

        child.on('error', function (err) {
            log('spawn error: ' + err.message);
            broadcast({ type: 'error', msg: err.message });
        });

        child.on('close', function (code) {
            log('hook exited code ' + code);
        });
    }

    // 命令分发
    function dispatch(id, data) {
        if (id === 'openSearch') {
            openSearch('sfx');
            return;
        }
        // 未知命令：广播给主面板处理
        broadcast({ type: 'command', id: id, data: data });
    }

    // 主面板保存新键后广播 reload，这里收到就换键重启
    cs.addEventListener(EVENT_RELOAD, function () {
        log('reload event received');
        start();
    });

    // search 面板 Esc 关闭时广播 closing，这里记录时间（状态机据此回 idle）
    cs.addEventListener(EVENT_CLOSING, function () {
        lastCloseTime = Date.now();
        searchState = 'idle';
        pendingOpen = false;
        if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
        log('search panel closing, state=idle');
    });

    // search 面板加载完广播 ready，这里转 open；若有排队请求则补开一次
    cs.addEventListener(EVENT_SEARCH_READY, function () {
        if (loadTimeout) { clearTimeout(loadTimeout); loadTimeout = null; }
        searchState = 'open';
        log('search panel ready');
        if (pendingOpen) {
            pendingOpen = false;
            log('flush pending reopen');
            setTimeout(function () { requestOpen(); }, 60);
        }
    });

    // PR 应用初始化完成时加载；这里直接 start（面板随 PR 启动即加载）
    log('bg.js loaded, extRoot=' + extRoot);
    log('hookPath=' + hookPath + ' exists=' + fs.existsSync(hookPath));
    start();
})();
