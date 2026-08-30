// vh-Atelier 全局热键桥（隐藏面板）
// 职责：PR 启动时自动加载（AutoVisible=false），spawn 全局键盘钩子 vh_keyhook.exe，
// 读它的 stdout（JSON），命中热键时广播 CSEvent 给主面板。
// 支持自定义热键：主面板写入 collect/hotkey.json 并广播 reload 事件，本面板换键重启钩子。
// 架构参照 Knights of the Editing Table 的 Spell Book：exe 钩键 → stdout → CEP 广播。
(function () {
    var cs = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    var EVENT_HOTKEY = 'com.vh.atelier.hotkey';
    var EVENT_RELOAD = 'com.vh.atelier.hotkey.reload';
    var SEARCH_EXT_ID = 'com.vh.atelier.search';
    var DEFAULT_COMBO = 'alt+f5';

    var extRoot = cs.getSystemPath(SystemPath.EXTENSION);
    var hookPath = path.join(extRoot, 'keyhook', 'vh_keyhook.exe');
    var collectDir = path.join(extRoot, 'collect');
    var hotkeyFile = path.join(collectDir, 'hotkey.json');

    var child = null;

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

    // 打开音效搜索浮窗（Spotlight 式）
    function openSearch() {
        try {
            cs.requestOpenExtension(SEARCH_EXT_ID, '');
            log('requestOpenExtension sent: ' + SEARCH_EXT_ID);
        } catch (e) {
            log('openSearch err: ' + e.message);
        }
    }

    // 从共享配置文件读自定义键，没有则用默认
    function readCombo() {
        try {
            if (fs.existsSync(hotkeyFile)) {
                var obj = JSON.parse(fs.readFileSync(hotkeyFile, 'utf8'));
                if (obj && obj.combo && obj.combo.trim()) return obj.combo.trim();
            }
        } catch (e) {}
        return DEFAULT_COMBO;
    }

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
        var combo = readCombo();
        log('spawning ' + hookPath + ' with combo ' + combo);
        child = childProcess.spawn(hookPath, [combo, 'Adobe Premiere Pro']);

        child.stdout.on('data', function (chunk) {
            var text = chunk.toString();
            text.split('\n').forEach(function (line) {
                line = line.trim();
                if (!line) return;
                var data;
                try { data = JSON.parse(line); } catch (e) { return; }
                log('stdout: ' + line);
                if (data.type === 'ready') {
                    broadcast({ type: 'ready', combo: data.combo });
                } else if (data.type === 'hotkey') {
                    // 命中热键：直接弹搜索浮窗（任意界面可用）
                    openSearch();
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

    // 主面板保存新键后广播 reload，这里收到就换键重启
    cs.addEventListener(EVENT_RELOAD, function () {
        log('reload event received');
        start();
    });

    // PR 应用初始化完成时加载；这里直接 start（面板随 PR 启动即加载）
    log('bg.js loaded, extRoot=' + extRoot);
    log('hookPath=' + hookPath + ' exists=' + fs.existsSync(hookPath));
    start();
})();
