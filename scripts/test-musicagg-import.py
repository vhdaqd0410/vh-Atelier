# -*- coding: utf-8 -*-
"""音源包导入必须登记 sources.json（否则服务端扫不到 → 提示启用失败/没有找到音源）

在插件目录下运行：
    python scripts/test-musicagg-import.py
"""
import os, sys, json, shutil, subprocess
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(D, '_tmp', 'test-import')
shutil.rmtree(TMP, ignore_errors=True)
EXT = os.path.join(TMP, 'ext')
OPEN = os.path.join(EXT, 'lxserver', 'data', 'users', 'source', '_open')
os.makedirs(OPEN, exist_ok=True)

# 跑完自动清理临时目录（避免在插件目录里留垃圾）
import atexit as _atexit, shutil as _shutil
def _cleanup_tmp():
    try:
        _p = os.path.join(D, '_tmp')
        if os.path.exists(_p):
            _shutil.rmtree(_p, ignore_errors=True)
    except Exception:
        pass
_atexit.register(_cleanup_tmp)


SRC_PACK = os.path.join(TMP, 'pack')
os.makedirs(SRC_PACK, exist_ok=True)
open(os.path.join(SRC_PACK, '测试源A.js'), 'w', encoding='utf-8').write(
    '/*!\n * @name 测试源A\n * @version 1.2.3\n * @author 小张\n * @description 用于测试导入\n */\nmodule.exports = {};\n')
open(os.path.join(SRC_PACK, '测试源B.js'), 'w', encoding='utf-8').write(
    '/*!\n * @name 测试源B\n * @version 0.1.0\n * @author 某人\n */\nmodule.exports = {};\n')
open(os.path.join(OPEN, '已有源.js'), 'w', encoding='utf-8').write('/*! @name 已有源 */\n')
json.dump([{"id": "已有源.js", "name": "已有源", "enabled": True}],
          open(os.path.join(OPEN, 'sources.json'), 'w', encoding='utf-8'),
          ensure_ascii=False, indent=2)

ZIP = os.path.join(TMP, 'pack.zip')
subprocess.run(['powershell', '-NoProfile', '-Command',
                'Compress-Archive -Path (Join-Path $env:VH_SRC "*") -DestinationPath $env:VH_ZIP -Force'],
               env=dict(os.environ, VH_SRC=SRC_PACK, VH_ZIP=ZIP), check=True, capture_output=True)
print('测试 zip:', os.path.getsize(ZIP), '字节')

RUNNER = os.path.join(TMP, 'run.js')
open(RUNNER, 'w', encoding='utf-8').write(r'''
const fs = require('fs'), path = require('path'), vm = require('vm');
const EXT = process.argv[2], ZIP = process.argv[3], ROOT = process.argv[4];
const realCP = require('child_process');

let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  [OK]   ' + n); }
                       else { fail++; console.log('  [FAIL] ' + n + (e !== undefined ? ' -> ' + e : '')); } }

// 只替换「弹对话框」的两种脚本，其余（Expand-Archive 等）真实执行
const fakeCP = Object.assign({}, realCP, {
  spawnSync(cmd, args, opts) {
    const script = (args && args.join(' ')) || '';
    if (/ShowDialog/.test(script)) {
      try { fs.writeFileSync(opts.env.VH_OUT, ZIP, 'utf8'); } catch (e) {}
      return { status: 0, stdout: '', stderr: '' };
    }
    return realCP.spawnSync(cmd, args, opts);
  }
});

const store = {};
const sandbox = {
  console, setTimeout, clearTimeout, Promise, Buffer, process,
  require: (m) => (m === 'child_process' ? fakeCP : require(m)),
  module: { exports: {} }, exports: {},
  document: { readyState: 'complete', getElementById: () => null, addEventListener() {},
              body: {}, documentElement: {}, querySelector: () => null, querySelectorAll: () => [] },
  localStorage: { getItem: k => (k in store ? store[k] : null),
                  setItem: (k, v) => { store[k] = String(v); },
                  removeItem: k => { delete store[k]; } },
  XMLHttpRequest: function () { this.open = () => {}; this.send = () => {}; this.setRequestHeader = () => {}; },
  CSInterface: function () { this.getSystemPath = () => EXT; this.evalScript = () => {}; },
  SystemPath: { EXTENSION: 'extension' }
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
sandbox.window.__adobe_cep__ = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'musicagg.js'), 'utf8'), sandbox, { filename: 'musicagg.js' });

const agg = sandbox.window.__musicAgg;
ok('musicagg 模块已加载', !!agg);
if (!agg) { console.log('\n通过 ' + pass + ' / 失败 ' + fail); process.exit(1); }

const openDir = path.join(EXT, 'lxserver', 'data', 'users', 'source', '_open');
const metaPath = path.join(openDir, 'sources.json');
const before = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

agg.importSources(function (okRes, info) {
  ok('导入返回成功', okRes === true, JSON.stringify(info));
  setTimeout(() => {
    // 1) 脚本文件已落盘
    ok('新脚本已落盘 A', fs.existsSync(path.join(openDir, '测试源A.js')));
    ok('新脚本已落盘 B', fs.existsSync(path.join(openDir, '测试源B.js')));

    // 2) 关键：sources.json 已登记（这是原本缺失的一步）
    let after = [];
    try { after = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
    const ids = after.map(s => s.id);
    ok('sources.json 登记了 A', ids.indexOf('测试源A.js') >= 0, JSON.stringify(ids));
    ok('sources.json 登记了 B', ids.indexOf('测试源B.js') >= 0);
    ok('原有条目未丢失', ids.indexOf('已有源.js') >= 0);
    ok('条目总数 = 原有1 + 新增2', after.length === 3, after.length);

    // 3) 元数据从 JSDoc 正确解析 + 默认启用
    const a = after.find(s => s.id === '测试源A.js') || {};
    ok('解析出 @name', a.name === '测试源A', a.name);
    ok('解析出 @version', a.version === '1.2.3', a.version);
    ok('解析出 @author', a.author === '小张', a.author);
    ok('默认启用（免二次手动点）', a.enabled === true, a.enabled);
    ok('带上传时间戳', !!a.uploadTime);

    // 4) 重复导入不重复登记
    agg.importSources(function (ok2, info2) {
      setTimeout(() => {
        const again = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        ok('重复导入不产生重复条目', again.length === 3, again.length);
        ok('重复导入被计为跳过', (info2 && info2.skipped) === 2, JSON.stringify(info2));
        console.log('\n通过 ' + pass + ' / 失败 ' + fail);
        process.exit(fail === 0 ? 0 : 1);
      }, 900);
    });
  }, 400);
});
''')

R = subprocess.run(['node', RUNNER, EXT, ZIP,
                    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))],
                   capture_output=True, text=True, encoding='utf-8', errors='replace')
print(R.stdout)
if R.stderr:
    print('--- stderr ---'); print(R.stderr[:2000])
sys.exit(R.returncode)
