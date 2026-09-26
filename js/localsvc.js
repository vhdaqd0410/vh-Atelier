// vh-Atelier 共享模块 · 本地 Node 服务管理
//
// 抽此模块的原因：音乐(网易云 17890)、短剧扒歌(17891)、视频下载(17892) 三个板块
// 原本各写了一份「找 node.exe → 探活 /health → 没跑就 spawn → 重试」的逻辑。
// findNode 在三个文件里几乎逐字重复，api() 是三份略有出入的 XHR 样板。
// 加第四个本地服务时不必再抄一遍。
//
// 边界：spawn 各板块保留自己的实现（各自的报错文案不同，短剧扒歌还要采集
//       子进程 stdout/stderr 供排障），本模块只负责 findNode / api / ensureServer。
//
// 用法：
//   var svc = window.__vhLocalSvc.create({
//       base: 'http://127.0.0.1:17892',   // 服务地址
//       name: '视频下载',                  // 报错文案用
//       defaultTimeout: 8000,              // api() 默认超时 ms
//       healthTimeout: 8000,               // 探活 /health 的超时（不传则同 defaultTimeout）
//       spawn: spawnSvc,                   // 本板块自己的拉起函数，返回 true/false
//       retries: 1,                        // ensureServer 重试次数
//       interval: 2000,                    // 重试间隔 ms
//       onState: function (text, type) {}, // 状态栏文案（不传则不显示任何状态）
//       onHealth: function (h) {},         // 探活成功后处理业务状态（可选）
//       onError: function (err) {},        // 每次探活失败时调用（可选，可记录最近错误）
//       errorMessage: function (err) {}    // 自定义最终报错文案（可选）
//       emptyAsObject: true                // 空响应体当作 {}（默认 false，按解析失败处理）
//       netErrorMessage: '服务未连接'        // 连不上服务时的文案（默认「连不上本地服务（base）」）
//   });
//   注：不传 onState 时，模块不会主动改任何状态文案，与原板块行为一致。
//   svc.api('/health')                       → Promise
//   svc.api('/x', {method:'POST', body:{}, timeout:5000})
//   svc.ensureServer(retries, quiet)
//   svc.findNode()
(function () {
    'use strict';

    var fs, childProcess;
    try {
        fs = require('fs');
        childProcess = require('child_process');
    } catch (e) {
        // 非 CEP 环境：给出降级桩，避免调用方炸掉
        window.__vhLocalSvc = {
            findNode: function () { return null; },
            create: function () {
                return {
                    api: function () { return Promise.reject(new Error('非 CEP 环境')); },
                    findNode: function () { return null; },
                    ensureServer: function () { return Promise.reject(new Error('非 CEP 环境')); },
                    base: function () { return ''; }
                };
            }
        };
        return;
    }

    // 找 node.exe：先查两个默认安装位置，再退回 PATH 里的 where node
    function findNode() {
        var candidates = [
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

    function create(cfg) {
        cfg = cfg || {};
        var base = cfg.base || '';
        var name = cfg.name || '本地服务';
        var defaultTimeout = cfg.defaultTimeout || 8000;
        var healthTimeout = cfg.healthTimeout || defaultTimeout;
        var maxRetries = (typeof cfg.retries === 'number') ? cfg.retries : 1;
        var interval = cfg.interval || 2000;
        var spawnFn = (typeof cfg.spawn === 'function') ? cfg.spawn : function () { return false; };
        // 只有显式传入 onState 的板块才更新状态文案；不传则完全静默。
        // （音乐 / 视频下载原本就不在探活阶段改状态栏，只有短剧扒歌会。）
        var hasState = (typeof cfg.onState === 'function');
        var onState = hasState ? cfg.onState : function () {};
        var onHealth = (typeof cfg.onHealth === 'function') ? cfg.onHealth : null;
        var onError = (typeof cfg.onError === 'function') ? cfg.onError : null;
        var errorMessage = (typeof cfg.errorMessage === 'function') ? cfg.errorMessage : null;
        // 空响应体是否当作 {}。原实现里短剧扒歌是宽松的（responseText || '{}'），
        // 音乐与视频下载是严格的（空体按解析失败处理），这里保留各自原有行为。
        var emptyAsObject = !!cfg.emptyAsObject;
        // 连不上服务时的文案。三处原实现不同：短剧扒歌用「服务未连接」（status 0 与 error 同文案），
        // 音乐用「无法连接本地服务」，视频下载用「连不上本地服务（地址）」/「无法连接本地服务（地址）」。
        // 分开两个开关才能逐字保留原文案。
        var errStatusMsg = cfg.errorStatusMessage || '';
        var errNetMsg = cfg.errorNetMessage || '';
        function statusErr() {
            return new Error(errStatusMsg || ('连不上本地服务（' + base + '）'));
        }
        function netErr() {
            return new Error(errNetMsg || ('无法连接本地服务（' + base + '）'));
        }

        // 统一 HTTP 调用。opt.method / opt.body / opt.timeout 可选。
        // 空响应体按 {} 处理，避免服务端偶发空回复被当成解析失败。
        function api(pathname, opt) {
            opt = opt || {};
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                var method = opt.method || 'GET';
                xhr.open(method, base + pathname, true);
                if (opt.body) xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.timeout = opt.timeout || defaultTimeout;
                xhr.onreadystatechange = function () {
                    if (xhr.readyState !== 4) return;
                    if (xhr.status === 0) { reject(statusErr()); return; }
                    var txt = xhr.responseText || '';
                    if (!txt && emptyAsObject) { resolve({}); return; }
                    try {
                        resolve(JSON.parse(txt));
                    } catch (e) {
                        reject(new Error('响应解析失败（HTTP ' + xhr.status +
                                         '，返回：' + txt.slice(0, 80).replace(/\s+/g, ' ') + '）'));
                    }
                };
                xhr.onerror = function () { reject(netErr()); };
                xhr.ontimeout = function () { reject(new Error('请求超时')); };
                xhr.send(opt.body ? JSON.stringify(opt.body) : null);
            });
        }

        // 探活；失败则调本板块的 spawn 后按 retries/interval 重试。
        // quiet=true 时不改状态栏（预热阶段用）。
        function ensureServer(retries, quiet) {
            var tries = retries || 0;
            return api('/health', { timeout: healthTimeout }).then(function (h) {
                if (!quiet && hasState) onState('服务正常', 'ok');
                if (onHealth) { try { onHealth(h); } catch (e) {} }
                return h;
            }).catch(function (e) {
                if (onError) { try { onError(e); } catch (_) {} }
                if (tries < maxRetries) {
                    if (tries === 0) spawnFn();
                    if (!quiet && hasState) onState('服务启动中…(' + (tries + 1) + '/' + maxRetries + ')', '');
                    return new Promise(function (resolve) {
                        setTimeout(function () {
                            resolve(ensureServer(tries + 1, quiet));
                        }, interval);
                    });
                }
                if (!quiet && hasState) onState('服务未连接', 'err');
                throw new Error(errorMessage ? errorMessage(e)
                                             : (name + '服务启动失败，请检查 Node.js 安装'));
            });
        }

        return {
            api: api,
            findNode: findNode,
            ensureServer: ensureServer,
            base: function () { return base; }
        };
    }

    window.__vhLocalSvc = { findNode: findNode, create: create };
})();
