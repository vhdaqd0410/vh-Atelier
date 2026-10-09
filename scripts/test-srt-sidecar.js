// vh-Atelier 字幕侧车（srt）归位测试
//
// 覆盖 AME / PR 两种导出通道下 srt 的命名差异与晚到情况：
//   1.mp4.srt（PR 形态）、1.srt、1_字幕.srt（AME 可能的命名）
//   长名称前缀边界（10.srt 不能被当成 1 的）、独立字幕目录、晚到、批量兜底清扫
//
// 在插件目录下运行：
//   node scripts/test-srt-sidecar.js
//

const fs = require('fs'), path = require('path');
try { fs.mkdirSync(require('path').join(require('path').dirname(require('path').dirname(__filename)) || '.', '_tmp'), { recursive: true }); } catch (e) {}
const ROOT = process.argv[2] || require('path').dirname(__dirname);
const TMP = process.argv[3] || require('path').join(ROOT, '_tmp', 'srttest');

let pass = 0, fail = 0;
function ok(n, c, e) {
  if (c) { pass++; console.log('  [OK]   ' + n); }
  else { fail++; console.log('  [FAIL] ' + n + (e !== undefined ? ' -> ' + e : '')); }
}

// 从 export.js 里抽出 finalizeSidecar / sweepSidecars 的实现来单测
const src = fs.readFileSync(path.join(ROOT, 'js', 'export.js'), 'utf8');
function grab(name) {
  const i = src.indexOf('function ' + name);
  if (i < 0) return '';
  let d = 0, started = false;
  for (let k = i; k < src.length; k++) {
    const ch = src[k];
    if (ch === '{') { d++; started = true; }
    else if (ch === '}') { d--; if (started && d === 0) return src.slice(i, k + 1); }
  }
  return '';
}

const fSide = grab('finalizeSidecar');
const fSweep = grab('sweepSidecars');
ok('能取出 finalizeSidecar', !!fSide);
ok('能取出 sweepSidecars', !!fSweep);

const logs = [];
const ctx = {
  fs, path, console, setTimeout, Promise,
  setLog: (m) => logs.push(String(m)),
};
const vm = require('vm');
vm.createContext(ctx);
vm.runInContext(fSide + '\n' + fSweep + '\nthis._finalize = finalizeSidecar; this._sweep = sweepSidecars;', ctx);

const finalize = ctx._finalize;
const sweep = ctx._sweep;

function mkDir(name) {
  const d = path.join(TMP, name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function scenario(label, setup, opts) {
  opts = opts || {};
  const dir = mkDir(label.replace(/[^\w]/g, '_'));
  const outDir = opts.destDirName ? mkDir(label.replace(/[^\w]/g, '_') + '_srt') : '';
  const out = { dir: dir, file: '1.mp4' };
  setup(dir, outDir);
  const r = await finalize(out, outDir);
  return { dir, outDir, r };
}

(async function () {
  // 场景 1：PR 经典命名 1.mp4.srt
  let s = await scenario('s1', (d) => {
    fs.writeFileSync(path.join(d, '1.mp4.srt'), 'x'.repeat(100));
  });
  ok('1.mp4.srt → 归位为 1.srt', fs.existsSync(path.join(s.dir, '1.srt')), JSON.stringify(s.r));

  // 场景 2：AME 直接产出 1.srt（无独立字幕目录）
  s = await scenario('s2', (d) => {
    fs.writeFileSync(path.join(d, '1.srt'), 'x'.repeat(100));
  });
  ok('1.srt 原样保留', fs.existsSync(path.join(s.dir, '1.srt')), JSON.stringify(s.r));

  // 场景 3：AME 用别的命名 1_字幕.srt → 应被识别归位
  s = await scenario('s3', (d) => {
    fs.writeFileSync(path.join(d, '1_字幕.srt'), 'x'.repeat(100));
  });
  ok('1_字幕.srt → 归位为 1.srt', fs.existsSync(path.join(s.dir, '1.srt')), JSON.stringify(s.r));

  // 场景 4：有独立字幕目录 → 应移动到那里
  s = await scenario('s4', (d) => {
    fs.writeFileSync(path.join(d, '1.mp4.srt'), 'x'.repeat(100));
  }, { destDirName: true });
  ok('有字幕目录时移动到该目录', fs.existsSync(path.join(s.outDir, '1.srt')), JSON.stringify(s.r));

  // 场景 5：不应误抓别的视频的 srt（10.srt 不能被当成 1 的）
  s = await scenario('s5', (d) => {
    fs.writeFileSync(path.join(d, '10.srt'), 'x'.repeat(100));
  });
  ok('不误抓 10.srt', s.r.found === false, JSON.stringify(s.r));

  // 场景 6：晚到（2 秒后才出现）—— 应在超时窗口内等到
  const d6 = mkDir('s6');
  setTimeout(() => { fs.writeFileSync(path.join(d6, '1.mp4.srt'), 'x'.repeat(100)); }, 2000);
  const r6 = await finalize({ dir: d6, file: '1.mp4' }, '');
  ok('晚到 2 秒仍能收到', fs.existsSync(path.join(d6, '1.srt')), JSON.stringify(r6));

  // 场景 7：sweepSidecars 兜底 —— 视频已存在，srt 是别的名字
  const d7 = mkDir('s7');
  fs.writeFileSync(path.join(d7, '3.mp4'), 'v');
  fs.writeFileSync(path.join(d7, '3_字幕.srt'), 'x'.repeat(100));
  const sw = sweep([{ dir: d7, file: '3.mp4' }], '');
  ok('sweep 归位 3_字幕.srt → 3.srt', fs.existsSync(path.join(d7, '3.srt')), JSON.stringify(sw));

  // 场景 8：sweep 尊重已有目标文件（不重复搬）
  const d8 = mkDir('s8');
  fs.writeFileSync(path.join(d8, '4.mp4'), 'v');
  fs.writeFileSync(path.join(d8, '4.srt'), 'x'.repeat(100));
  const sw8 = sweep([{ dir: d8, file: '4.mp4' }], '');
  ok('sweep 对已就位的不重复搬', sw8.moved === 0, JSON.stringify(sw8));


  // ---- 结构断言：防止「点击无反应」类作用域 bug 复发 ----
  (function () {
    const lines = src.split('\n');
    const rs = lines.findIndex(l => /^\s*(async\s+)?function\s+runExport/.test(l));
    let d = 0, started = false, rend = -1;
    for (let i = rs; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') { d++; started = true; }
        else if (ch === '}') { d--; if (started && d === 0) { rend = i; break; } }
      }
      if (rend >= 0) break;
    }
    const gs = lines.findIndex(l => /^\s*function\s+guardBeforeExport/.test(l));
    if (gs >= 0) {
      ok('guardBeforeExport 不在 runExport 内部（否则点击无反应）',
         !(rs < gs && gs < rend), 'runExport ' + rs + '-' + rend + ' guard@' + gs);
    }
    // btn-go 的点击处理必须能访问到它
    if (gs >= 0) {
      const callIdx = lines.findIndex(l => l.indexOf('guardBeforeExport()') >= 0 &&
                                           l.indexOf('function') < 0);
      ok('btn-go 处理能调到 guardBeforeExport',
         callIdx > 0 && (callIdx < rs || callIdx > rend),
         'call@' + callIdx);
    }
  })();

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
