'use strict';
/**
 * 离线自检：不启动 Resolve，只验证模块可加载、导出调度逻辑正确。
 * 用法：node selftest.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('=== 1. 模块加载 ===');
let host = null;
try {
  host = require('./js/resolve-host.js');
  check('resolve-host.js 可加载', true);
} catch (e) {
  check('resolve-host.js 可加载', false, e.message);
}

if (host) {
  console.log('\n=== 2. 导出接口导出 ===');
  for (const fn of ['ping', 'getProductInfo', 'listTimelines', 'getTimelineDetail',
    'listAudioClipsWithPath', 'listAudioTracks', 'listRenderPresets',
    'importMedia', 'openPage', 'startExport', 'stopExport', 'getExportState', 'cleanup']) {
    check('导出 ' + fn, typeof host[fn] === 'function');
  }

  console.log('\n=== 3. 未初始化时的失败行为 ===');
  (async () => {
    try {
      await host.getProductInfo();
      check('无 Resolve 时 getProductInfo 应抛错', false, '竟然成功了');
    } catch (e) {
      check('无 Resolve 时 getProductInfo 报错', /Resolve|初始化|Initialize|IPC|host/i.test(e.message), e.message);
    }

    const st = host.getExportState();
    check('getExportState 返回对象', st && typeof st === 'object');
    check('初始 running=false', st.running === false);

    const stop = await host.stopExport();
    check('空闲时 stopExport 返回 stopped=false', stop.stopped === false);

    console.log('\n=== 4. WorkflowIntegration.node 完整性 ===');
    const nodePath = path.join(__dirname, 'WorkflowIntegration.node');
    check('WorkflowIntegration.node 存在', fs.existsSync(nodePath));
    if (fs.existsSync(nodePath)) {
      const sz = fs.statSync(nodePath).size;
      check('node 模块大小合理 (>100KB)', sz > 100 * 1024, sz + ' bytes');
    }

    console.log('\n=== 5. 插件清单 ===');
    const mf = fs.readFileSync(path.join(__dirname, 'manifest.xml'), 'utf8');
    check('manifest 含 plugin id', mf.includes('<Id>com.vh.atelier</Id>'));
    check('manifest 指向 main.js', mf.includes('<FilePath>main.js</FilePath>'));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    check('package.json pluginId 一致', pkg.pluginId === 'com.vh.atelier', pkg.pluginId);
    check('package.json main 一致', pkg.main === 'main.js', pkg.main);

    console.log('\n=== 6. 前端资源齐全 ===');
    for (const f of ['index.html', 'preload.js', 'js/app.js', 'css/app.css']) {
      check(f + ' 存在', fs.existsSync(path.join(__dirname, f)));
    }

    console.log('\n========================================');
    console.log(`结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
  })();
}
