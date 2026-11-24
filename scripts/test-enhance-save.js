// 超分/去字幕结果下载：唯一命名 + 目标工程锁定（防覆盖、防落到别的项目）
// 直接抽取 js/enhance.js 里的辅助函数来测，保证测的是真实代码。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'js', 'enhance.js');
const src = fs.readFileSync(SRC, 'utf8');

const s = src.indexOf('  // ===== 目标工程锁定 + 唯一文件名 =====');
const e = src.indexOf('  // 持久化：面板关闭/重开后继续轮询未完成的任务');
if (s < 0 || e <= s) {
  console.log('  [FAIL] 取不到「工程锁定 + 唯一命名」代码段');
  console.log('通过 0 / 失败 1');
  process.exit(1);
}
const code = src.slice(s, e);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

function makeCtx(existsArr, projectPath) {
  const existsSet = new Set(existsArr.map((p) => p.replace(/\\/g, '/')));
  const ctx = {
    path,
    fs: { existsSync: (p) => existsSet.has(String(p).replace(/\\/g, '/')), mkdirSync: () => {} },
    JSON, Date, String, Number, Array, Object, Math, RegExp, Promise,
    resultDir: 'D:/P/超分结果',
    projCtx: null,
    evalHost: async () => 'OK:' + JSON.stringify({ path: projectPath, root: 'D:/P', name: 'P' }),
    console
  };
  vm.createContext(ctx);
  vm.runInContext(code + '\n;globalThis.__h={pickSaveName,saveNameForRecord,dirOfRecord,isSameProject,captureProjectCtx};', ctx);
  return ctx.__h;
}

(async () => {
  // ---- A. 唯一命名：已有文件绝不覆盖 ----
  let H = makeCtx([], 'D:/P/a.prproj');
  ok('无同名时保留原名', H.pickSaveName('D:/P/超分结果', '1_720p', '_1124-1530-1234', '.mp4') === '1_720p_1124-1530-1234.mp4');

  H = makeCtx(['D:/P/超分结果/1_720p_1124-1530-1234.mp4'], 'D:/P/a.prproj');
  ok('同名已存在 → (2)', H.pickSaveName('D:/P/超分结果', '1_720p', '_1124-1530-1234', '.mp4') === '1_720p_1124-1530-1234(2).mp4');

  H = makeCtx(['D:/P/超分结果/1_720p_x.mp4', 'D:/P/超分结果/1_720p_x(2).mp4', 'D:/P/超分结果/1_720p_x(3).mp4'], 'D:/P/a.prproj');
  ok('连续占用 → (4)', H.pickSaveName('D:/P/超分结果', '1_720p', '_x', '.mp4') === '1_720p_x(4).mp4');

  // ---- B. 记录名带提交时间与任务尾号（同一集多次提交也不会撞） ----
  H = makeCtx([], 'D:/P/a.prproj');
  const rec = { taskId: '987654', seqName: '12_nosub', addedAt: new Date(2026, 10, 24, 15, 30).getTime(), targetDir: 'D:/P/超分结果' };
  const nm = H.saveNameForRecord(rec, 'D:/P/超分结果', false);
  ok('超分记录名 = 集名_720p_时间-任务尾号', /^12_720p_1124-1530-7654\.mp4$/.test(nm), nm);
  const nmE = H.saveNameForRecord(rec, 'D:/P/超分结果', true);
  ok('去字幕记录名用 _erased', /^12_erased_1124-1530-7654\.mp4$/.test(nmE), nmE);
  const nmOther = H.saveNameForRecord(Object.assign({}, rec, { taskId: '111766' }), 'D:/P/超分结果', false);
  ok('不同任务尾号不同名', nmOther !== nm, nmOther);

  // ---- C. 目标目录锁定：用记录里的目录，而不是当前工程 ----
  H = makeCtx(['D:/P/超分结果'], 'D:/P/a.prproj');
  ok('有 targetDir 就用它', H.dirOfRecord(rec) === 'D:/P/超分结果');
  ok('无 targetDir 返回空走兜底', H.dirOfRecord({}) === '');
  ok('targetDir 不存在（建不出来）返回空', H.dirOfRecord({ targetDir: 'D:/NOTEXIST/x' }) === '');

  // ---- D. 工程一致性：决定要不要自动导入素材箱 ----
  H = makeCtx([], 'D:/P/a.prproj');
  ok('同一工程（大小写/斜杠差异）算相同', (await H.isSameProject('d:\\p\\A.PRPROJ')) === true);
  H = makeCtx([], 'D:/P/别的一部剧.prproj');
  ok('当前打开了别的工程 → 不同', (await H.isSameProject('D:/P/a.prproj')) === false);
  ok('旧记录没有工程路径 → 放行', (await H.isSameProject('')) === true);

  // ---- E. 提交时捕获上下文，含工程路径与结果目录 ----
  H = makeCtx([], 'D:/P/a.prproj');
  const c = await H.captureProjectCtx();
  ok('captureProjectCtx 带路径与目标目录', c.path === 'D:/P/a.prproj' && c.targetDir === 'D:/P/超分结果', c);

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();