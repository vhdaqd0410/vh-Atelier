// vh-Atelier 后台桥（隐藏面板）
// 职责：PR 启动时自动加载（AutoVisible=false），负责拉起网易云音乐本地服务（ncm）。
// 历史：曾 spawn vh_keyhook.exe 做全局音效搜索热键（Ctrl+F2 唤起搜索浮窗），
//       2026-09 应需求移除全局搜索功能后，keyhook 链不再需要，此面板仅保留服务管理。
(function () {
    var cs = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var childProcess = require('child_process');

    var extRoot = cs.getSystemPath(SystemPath.EXTENSION);

    function log(msg) {
        try {
            console.log('[vh-bg] ' + msg);
            var logFile = path.join(extRoot, 'collect', 'keyhook.log');
            if (!fs.existsSync(path.dirname(logFile))) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch (e) {} }
            var stamp = new Date().toISOString();
            fs.appendFileSync(logFile, stamp + ' ' + msg + '\n', 'utf8');
        } catch (e) {}
    }

    // ---------- 网易云音乐本地服务 ----------
    var ncmChild = null;
    var ncmDir = path.join(extRoot, 'ncm');
    var ncmIndex = path.join(ncmDir, 'index.js');
    var nodeExe = null;

    function findNode() {
        var candidates = [
            path.join(extRoot, 'runtime', 'node.exe'),  // 便携 node（自包含部署优先）
            'C:\\Program Files\\nodejs\\node.exe',
            'C:\\Program Files (x86)\\nodejs\\node.exe'
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (fs.existsSync(candidates[i])) return candidates[i];
        }
        try {
            var which = childProcess.spawnSync('where', ['node'], { encoding: 'utf8' });
            if (which.status === 0 && which.stdout) {
                var first = which.stdout.split('\n')[0].trim();
                if (first) return first;
            }
        } catch (e) {}
        return null;
    }

    function ncmStart() {
        try {
            if (!fs.existsSync(ncmIndex)) {
                log('ncm service missing: ' + ncmIndex);
                return;
            }
            if (!nodeExe) nodeExe = findNode();
            if (!nodeExe) {
                log('node.exe not found');
                return;
            }
            if (ncmChild) {
                log('ncm service already spawned, skip');
                return;
            }
            log('starting ncm service: ' + nodeExe + ' ' + ncmIndex);
            ncmChild = childProcess.spawn(nodeExe, [ncmIndex], {
                cwd: ncmDir,
                windowsHide: true
            });
            ncmChild.stdout.on('data', function (chunk) { log('ncm: ' + chunk.toString().trim()); });
            ncmChild.stderr.on('data', function (chunk) { log('ncm err: ' + chunk.toString().trim()); });
            ncmChild.on('error', function (e) { log('ncm spawn error: ' + e.message); ncmChild = null; });
            ncmChild.on('close', function (code) { log('ncm exited code ' + code); ncmChild = null; });
        } catch (e) {
            log('ncmStart err: ' + e.message);
        }
    }

    function ncmProbeThenStart() {
        try {
            var httpMod = require('http');
            var req = httpMod.get('http://127.0.0.1:17890/health', function (res) {
                res.resume();
                log('ncm already running, no need to spawn');
            });
            req.on('error', function () { ncmStart(); });
            req.setTimeout(2000, function () { req.abort(); ncmStart(); });
        } catch (e) {
            ncmStart();
        }
    }

    log('bg.js loaded, extRoot=' + extRoot);
    ncmProbeThenStart();
})();
