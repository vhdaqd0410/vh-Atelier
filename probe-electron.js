'use strict';
/**
 * 在 Resolve 自带的 Electron 运行时下验证宿主模块可加载性。
 * 用法：
 *   set ELECTRON_RUN_AS_NODE=1
 *   "<Resolve>\Electron\electron.exe" probe-electron.js
 * 结果写入 probe-result.json
 */

const path = require('path');
const fs = require('fs');

const out = {
  when: new Date().toISOString(),
  electron: process.versions.electron || null,
  node: process.versions.node,
  chrome: process.versions.chrome || null,
  abi: process.versions.modules,
  steps: []
};

function step(name, ok, detail) {
  out.steps.push({ name, ok, detail: detail == null ? null : String(detail) });
}

(async () => {
  // 1. 加载原生模块
  let WI = null;
  try {
    WI = require(path.join(__dirname, 'WorkflowIntegration.node'));
    step('加载 WorkflowIntegration.node', true, 'type=' + typeof WI.Initialize);
  } catch (e) {
    step('加载 WorkflowIntegration.node', false, e.message);
    finish();
    return;
  }

  // 2. 调用 Initialize（预期在非 Resolve 拉起时失败，只要能返回而不是崩溃即可）
  try {
    const ok = await WI.Initialize('com.vh.atelier');
    step('调用 Initialize', true, 'result=' + ok);
    if (ok) {
      const r = await WI.GetResolve();
      step('GetResolve', !!r, r ? 'OK' : 'null');
      if (r) {
        step('GetProductName', true, await r.GetProductName());
        step('GetVersionString', true, await r.GetVersionString());
        step('GetCurrentPage', true, await r.GetCurrentPage());
        const pm = await r.GetProjectManager();
        const p = pm ? await pm.GetCurrentProject() : null;
        step('GetCurrentProject', !!p, p ? await p.GetName() : 'null');
        if (p) {
          step('GetTimelineCount', true, await p.GetTimelineCount());
          const t = await p.GetCurrentTimeline();
          step('GetCurrentTimeline', !!t, t ? await t.GetName() : 'null');
        }
      }
      WI.CleanUp();
    }
  } catch (e) {
    step('调用 Initialize', 'expected-fail', e.message);
  }

  // 3. 验证宿主桥模块本身可加载
  try {
    const host = require(path.join(__dirname, 'js', 'resolve-host.js'));
    step('加载 js/resolve-host.js', typeof host.ping === 'function', Object.keys(host).length + ' 个导出');
  } catch (e) {
    step('加载 js/resolve-host.js', false, e.message);
  }

  finish();
})();

function finish() {
  try {
    fs.writeFileSync(path.join(__dirname, 'probe-result.json'), JSON.stringify(out, null, 2), 'utf8');
  } catch (e) { /* 忽略 */ }
  process.exit(0);
}
