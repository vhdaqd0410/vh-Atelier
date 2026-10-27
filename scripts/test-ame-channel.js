
// AME 队列通道回归：确保「选了 AME 就真的把任务送进 ME 队列」
// 历史 bug：A 版 AME 分支拉起了 ME，但入队时误用 meExport（PR 直渲），
// 现象是「ME 被拉起来但任务没进去，PR 自己渲了」。
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  [OK]   ' + n); }
                       else { fail++; console.log('  [FAIL] ' + n + (e !== undefined ? ' -> ' + e : '')); } }
const ex = fs.readFileSync(path.join(ROOT, 'js', 'export.js'), 'utf8');
const host = fs.readFileSync(path.join(ROOT, 'jsx', 'host.jsx'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ---- 分支隔离：AME 走入队，PR 走直渲 ----
const iLoop = ex.indexOf('for (var i = 0; i < totalV; i++)');
ok('找到逐版本循环', iLoop > 0);
const iAme = ex.indexOf('if (isAme) {', iLoop);
ok('AME 分支存在', iAme > 0);
const iEnq = ex.indexOf("evalHost('meEnqueueAME(", iAme);
ok('AME 分支调用 meEnqueueAME（真正入队）', iEnq > iAme);
const iElse = ex.indexOf('} else {', iEnq);
ok('AME 分支有配对的 else', iElse > iEnq);
const iExp = ex.indexOf("evalHost('meExport(", iElse);
ok('PR 直渲 meExport 在 else 分支内（不在 AME 分支）', iExp > iElse);
const ameBody = ex.slice(iAme, iElse);
ok('AME 分支体内不含 meExport', ameBody.indexOf('meExport(') < 0,
   ameBody.indexOf('meExport(') >= 0 ? '请检查 AME 分支是否误用 PR 直渲' : '');
ok('AME 分支记录任务到 ameJobs', ameBody.indexOf('ameJobs.push') >= 0);
ok('AME 分支入队后立即恢复轨道', ameBody.indexOf('await unmute()') >= 0);
ok('AME 分支体量合理（说明真的做了入队）', ameBody.length > 400, ameBody.length);

// ---- 入队前后置条件 ----
ok('有 meStartBatch（统一开渲）', ex.indexOf("evalHost('meStartBatch()')") >= 0);
ok('有等待任务完成 waitAmeJob', ex.indexOf('function waitAmeJob') >= 0);
ok('有 amePendings 收尾清单', ex.indexOf('amePendings.push') >= 0);

// ---- 拉起 ME 后必须等它就绪（冷启动竞态）----
ok('有 ameProcessRunning 探测', ex.indexOf('function ameProcessRunning') >= 0);
ok('有 waitAmeProcessReady 等待', ex.indexOf('function waitAmeProcessReady') >= 0);
const iLaunch = ex.indexOf("evalHost('meLaunchEncoder()')");
const iWait = ex.indexOf('await waitAmeProcessReady(', iLaunch);
ok('meLaunchEncoder 之后确实 await 就绪（相距 < 400 字符）',
   iLaunch > 0 && iWait > iLaunch && (iWait - iLaunch) < 400,
   'launch@' + iLaunch + ' wait@' + iWait);

// ---- 预检：PR 与 ME 版本不配套要明确告知 ----
ok('调用了 mePreflight', ex.indexOf("evalHost('mePreflight()')") >= 0);
ok('版本不配套有明确告警', ex.indexOf('VERSION_MISMATCH') >= 0);
ok('告警文案提到会落到 PR 本地渲染', /由 PR 本地渲染|PR 本地渲染/.test(ex));
ok('宿主实现 mePreflight', host.indexOf('function mePreflight') >= 0);
ok('预检扫描 Media Encoder 安装', /Adobe Media Encoder/.test(host));
ok('预检读 PR 版本', /app\.version/.test(host));

// ---- 回调健康：没收到回调却出文件 → 提示可能本地渲染 ----
ok('有 ameCallbackSeen 标志', ex.indexOf('ameCallbackSeen') >= 0);
ok('收到 AME 回调时置位', /ameCallbackSeen = true;/.test(ex));
ok('文件落地但无回调会标记 suspectLocal', /suspectLocal/.test(ex));
ok('疑似本地渲染时有用户可见警告', /未收到 ME 的任何回调/.test(ex));

// ---- 通道选择：默认 AME，无静默回退 PR ----
ok('默认走 AME', /localStorage\.getItem\(CH_KEY\) === 'pr' \? 'pr' : 'ame'/.test(ex));
ok('没有静默回退 PR 的分支', !/fallbackToPr|回退到 PR|降级为 PR/.test(ex));
ok('radio value 为 ame', /id="rnd-ame" value="ame"/.test(html));

// ---- 宿主侧 ----
ok('宿主有 meEnqueueAME', host.indexOf('function meEnqueueAME') >= 0);
ok('宿主启用编码器前检查 app.encoder', /if \(!app\.encoder\)/.test(host));
ok('宿主用 encodeSequence 入队', /app\.encoder\.encodeSequence\(/.test(host));
ok('宿主绑定 AME 回调并派发 CSXS 事件', /com\.vh\.ameJob/.test(host));

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
