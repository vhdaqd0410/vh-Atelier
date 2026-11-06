'use strict';
/**
 * 回归测试：锁定历次踩过的坑。
 *
 * 坑 1（v0.1.1）：GetRenderJobStatus 字段名首字母大写
 *    JobStatus / CompletionPercentage，官方文档不列字段名。
 * 坑 2（v0.1.2）：状态串是**本地化的**，中文环境返回「完成」不是 'Complete'。
 *    用英文常量硬比较 -> 永远判不出完成 -> 轮询卡死。
 * 坑 3（v0.1.2）：自动重试是破坏性操作
 *    对已完成任务重调 StartRendering 会把同一集渲了又渲。已彻底移除。
 *
 * 用法: node test-regression.js
 */

const fs = require('fs');
const path = require('path');
const host = require('./js/resolve-host.js');
const { parseJobStatus, resolveOutputs, sanitizeFileName } = host.__test;
const { STATE_COMPLETE, STATE_RENDERING, STATE_READY, STATE_FAILED, STATE_CANCELLED, STATE_UNKNOWN } = host.__test;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

console.log('=== 坑 2：中文状态串（本次真因）===');
{
  const r = parseJobStatus({ JobStatus: '完成', CompletionPercentage: 100 });
  ok('识别「完成」', r.state === STATE_COMPLETE, r.state);
  ok('「完成」进度 100', r.percent === 100, r.percent);
}
{
  const r = parseJobStatus({ JobStatus: '已完成', CompletionPercentage: 100 });
  ok('识别「已完成」', r.state === STATE_COMPLETE, r.state);
}
{
  const r = parseJobStatus({ JobStatus: '渲染中', CompletionPercentage: 37 });
  ok('识别「渲染中」', r.state === STATE_RENDERING, r.state);
}
{
  const r = parseJobStatus({ JobStatus: '准备', CompletionPercentage: 0 });
  ok('识别「准备」', r.state === STATE_READY, r.state);
}
{
  const r = parseJobStatus({ JobStatus: '失败', CompletionPercentage: 12 });
  ok('识别「失败」', r.state === STATE_FAILED, r.state);
}
{
  const r = parseJobStatus({ JobStatus: '已取消', CompletionPercentage: 0 });
  ok('识别「已取消」', r.state === STATE_CANCELLED, r.state);
}
{
  // 关键歧义：不能把「渲染完成」误判成「渲染中」
  const r = parseJobStatus({ JobStatus: '渲染完成', CompletionPercentage: 100 });
  ok('「渲染完成」判为完成，不误判渲染中', r.state === STATE_COMPLETE, r.state);
}

console.log('\n=== 坑 1：英文字段名（大小写）===');
{
  const r = parseJobStatus({ JobStatus: 'Rendering', CompletionPercentage: 42 });
  ok('读到 JobStatus', r.state === STATE_RENDERING, r.state);
  ok('读到 CompletionPercentage', r.percent === 42, r.percent);
}
{
  const r = parseJobStatus({ JobStatus: 'Complete', CompletionPercentage: 100 });
  ok('识别英文 Complete', r.state === STATE_COMPLETE, r.state);
}
{
  const r = parseJobStatus({ jobStatus: 'Complete', completionPercentage: 100 });
  ok('兼容小写字段名', r.state === STATE_COMPLETE && r.percent === 100);
}

console.log('\n=== 其他语言 + 防御性判读 ===');
{
  const cases = [
    ['Fertig', STATE_COMPLETE],
    ['Abgeschlossen', STATE_COMPLETE],
    ['rendering', STATE_RENDERING],
    ['Cancelled', STATE_CANCELLED],
    ['Failed', STATE_FAILED],
    ['Ready', STATE_READY],
    ['完了', STATE_COMPLETE],
    ['完成', STATE_COMPLETE]
  ];
  let bad = [];
  for (const [txt, want] of cases) {
    const r = parseJobStatus({ JobStatus: txt, CompletionPercentage: 0 });
    if (r.state !== want) bad.push(txt + '->' + r.state);
  }
  ok('多语言状态串全部识别', bad.length === 0, bad.join(', '));
}
{
  // 字符串完全认不出时，用百分比兜底
  const r = parseJobStatus({ JobStatus: '???', CompletionPercentage: 100 });
  ok('未知状态 + 100% 兜底判完成', r.state === STATE_COMPLETE, r.state);
  const r2 = parseJobStatus({ JobStatus: '???', CompletionPercentage: 55 });
  ok('未知状态 + 55% 兜底判渲染中', r2.state === STATE_RENDERING, r2.state);
}
{
  const r = parseJobStatus(null);
  ok('null 返回 unknown', r.state === STATE_UNKNOWN && r.percent === 0, r.state);
  const r2 = parseJobStatus({});
  ok('空对象不抛错', r2.state === STATE_UNKNOWN, r2.state);
}
{
  const r = parseJobStatus({ JobStatus: 'Complete', CompletionPercentage: '37.5' });
  ok('数值字符串进度可解析', r.percent === 37.5, r.percent);
  const r2 = parseJobStatus({ JobStatus: 'Complete', CompletionPercentage: 'abc' });
  ok('非法进度归零', r2.percent === 0, r2.percent);
}

console.log('\n=== 坑 3：绝不能有自动重试 ===');
{
  const src = fs.readFileSync(path.join(__dirname, 'js', 'resolve-host.js'), 'utf8');
  const i = src.indexOf('async function waitForJob');
  const j = src.indexOf('async function exportOne');
  // 去注释，只看可执行代码
  const body = src.slice(i, j)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  ok('waitForJob 内不含可执行的 StartRendering', body.indexOf('StartRendering') === -1);
  ok('waitForJob 内不含“尝试重新开始”', body.indexOf('尝试重新开始') === -1);
  // 全文件的 StartRendering 只应出现在 exportOne 里
  const occurrences = (src.match(/project\.StartRendering/g) || []).length;
  ok('全文件 StartRendering 仅 1 处', occurrences === 1, '实际 ' + occurrences + ' 处');
}

console.log('\n=== v0.1.3：字幕改由渲染设置控制 ===');
{
  const src = fs.readFileSync(path.join(__dirname, 'js', 'resolve-host.js'), 'utf8');
  ok('使用 ExportSubtitle 键', src.indexOf('ExportSubtitle') >= 0);
  ok('使用 SubtitleFormat 键', src.indexOf('SubtitleFormat') >= 0);
  ok('含 SeparateFile 选项', src.indexOf("SeparateFile") >= 0);
  ok('含 BurnIn 选项', src.indexOf("'BurnIn'") >= 0);
  ok('含 EmbeddedCaptions 选项', src.indexOf('EmbeddedCaptions') >= 0);
  // 不得再靠禁用字幕轨做「无字幕版」（对渲染无效）
  const i2 = src.indexOf('async function exportOne');
  const j2 = src.indexOf('async function startExport');
  const body2 = src.slice(i2, j2)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  ok('exportOne 内不再调用 setTrackTypeEnabled(subtitle)', body2.indexOf("setTrackTypeEnabled(timeline, 'subtitle'") === -1);
}

console.log('\n=== v0.1.3：音轨禁用必须读回校验 ===');
{
  const src = fs.readFileSync(path.join(__dirname, 'js', 'resolve-host.js'), 'utf8');
  ok('存在 muteExceptAndVerify', src.indexOf('muteExceptAndVerify') >= 0);
  ok('禁用后有 GetIsTrackEnabled 读回', /SetTrackEnable[\s\S]{0,400}GetIsTrackEnabled/.test(src));
  // 日志不得把“保留列表”说成“已禁用”
  ok('日志措辞不再自相矛盾', src.indexOf('已禁用非保留音轨') === -1);
}

console.log('\n=== v0.1.3：交付目录自动填充 ===');
{
  const src = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  ok('存在 autofillFromRoot', src.indexOf('function autofillFromRoot') >= 0);
  ok('存在数字前缀解析', src.indexOf('prefixOf') >= 0);
  ok('存在交付根目录输入', src.indexOf('deliveryRoot') >= 0);
  const hsrc = fs.readFileSync(path.join(__dirname, 'js', 'resolve-host.js'), 'utf8');
  ok('宿主提供 listSubDirs', hsrc.indexOf('async function listSubDirs') >= 0);
}

console.log('\n=== v0.1.4：sidecar 字幕收尾（对齐 PR 版）===');
{
  const src = fs.readFileSync(path.join(__dirname, 'js', 'resolve-host.js'), 'utf8');
  ok('存在 snapshotSrt', src.indexOf('function snapshotSrt') >= 0);
  ok('存在 findNewSrt', src.indexOf('function findNewSrt') >= 0);
  ok('存在 finalizeSidecar', src.indexOf('async function finalizeSidecar') >= 0);
  ok('存在 waitFileStable', src.indexOf('async function waitFileStable') >= 0);
  ok('exportOne 调用了 finalizeSidecar', src.indexOf('await finalizeSidecar') >= 0);
  ok('渲染前拍了 srt 快照', src.indexOf('srtBefore = snapshotSrt') >= 0);
  ok('支持 subtitleDir 归位', src.indexOf('version.subtitleDir') >= 0);

  const app = fs.readFileSync(path.join(__dirname, 'js', 'app.js'), 'utf8');
  ok('UI 有独立字幕文件选项', app.indexOf("['sidecar'") >= 0);
  ok('UI 有字幕目录输入', app.indexOf('v-subdir') >= 0);
  ok('导出传了 subtitleDir', app.indexOf('subtitleDir: v.subtitleDir') >= 0);
  ok('自动填充会填字幕目录', app.indexOf('srtHit') >= 0);
  ok('默认无音乐版带独立字幕', /name: '无音乐无字幕版'[\s\S]{0,200}subtitleMode: 'sidecar'/.test(app));
}

console.log('\n=== v0.1.4：srt 快照比对（实测逻辑）===');
{
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-srt-'));
  ok('snapshotSrt 空目录返回空对象', Object.keys(host.snapshotSrt(tmp)).length === 0);

  fs.writeFileSync(path.join(tmp, 'a.srt'), '12345');
  fs.writeFileSync(path.join(tmp, 'b.txt'), 'ignore');
  const snap = host.snapshotSrt(tmp);
  ok('只统计字幕类文件（忽略 .txt）', Object.keys(snap).length === 1 && snap['a.srt'] === 5, JSON.stringify(snap));

  // v0.2.0：达芬奇产出的 .ttml 也要被认出来
  fs.writeFileSync(path.join(tmp, '9_字幕 1.ttml'), '<tt/>');
  const snapT = host.snapshotSrt(tmp);
  ok('识别达芬奇产出的 .ttml', Object.keys(snapT).length === 2 && snapT['9_字幕 1.ttml'] === 5, JSON.stringify(snapT));
  const freshT = host.findNewSrt(tmp, snap);
  ok('新增 .ttml 能被 findNewSrt 找到', freshT.length === 1 && /\.ttml$/.test(freshT[0]), freshT.join('|'));
  fs.unlinkSync(path.join(tmp, '9_字幕 1.ttml'));   // 清理，后续断言只针对 a.srt

  // 新产生一个 srt 应能被找出
  fs.writeFileSync(path.join(tmp, '9_字幕 1.srt'), 'abcdef');
  const fresh = host.findNewSrt(tmp, snap);
  ok('能找出新增 srt', fresh.length === 1 && /9_字幕 1\.srt$/.test(fresh[0]), fresh.join('|'));

  // 已存在的 srt 内容没变 -> 不算新
  fs.writeFileSync(path.join(tmp, 'a.srt'), '12345');
  const snap2 = host.snapshotSrt(tmp);
  ok('内容无变化不算新', host.findNewSrt(tmp, snap2).length === 0);

  // 内容变了 -> 算新
  fs.writeFileSync(path.join(tmp, 'a.srt'), '12345678');
  ok('内容变化算新', host.findNewSrt(tmp, snap2).length === 1);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

console.log('\n=== v0.2.0：音轨禁用必须避开交付页（根因锁死）===');
{
  const src = fs.readFileSync(path.join(__dirname, 'js', 'resolve-host.js'), 'utf8');
  ok('存在 ensureTrackSafePage', src.indexOf('async function ensureTrackSafePage') >= 0);
  ok('安全页列表不含 deliver', src.indexOf("TRACK_SAFE_PAGES = ['edit'") >= 0
     && src.indexOf("TRACK_SAFE_PAGES") >= 0
     && !/TRACK_SAFE_PAGES\s*=\s*\[[^\]]*deliver/.test(src));
  ok('muteExceptAndVerify 先切安全页', /async function muteExceptAndVerify[\s\S]{0,200}ensureTrackSafePage/.test(src));
  ok('restoreAudioEnabled 也切安全页', /async function restoreAudioEnabled[\s\S]{0,200}ensureTrackSafePage/.test(src));
  ok('切换后有等待落地', /ensureTrackSafePage[\s\S]{0,400}await sleep\(/.test(src));
}

console.log('\n=== v0.2.0：TTML 转 SRT ===');
{
  const { ttmlToSrt, timecodeToSeconds, secToSrtTime } = host.__test;
  ok('导出 ttmlToSrt', typeof ttmlToSrt === 'function');
  ok('导出 timecodeToSeconds', typeof timecodeToSeconds === 'function');

  ok('timecodeToSeconds 按帧折算', Math.abs(timecodeToSeconds('01:00:05:12', 24) - 3605.5) < 1e-6);
  ok('timecodeToSeconds 零位', timecodeToSeconds('00:00:00:00', 24) === 0);
  ok('secToSrtTime 补零', secToSrtTime(0.958) === '00:00:00,958' && secToSrtTime(91.291) === '00:01:31,291');

  const t1 = ttmlToSrt('<?xml version="1.0"?><tt ttp:frameRate="24" ttp:timeBase="media"><body><div>'
    + '<p begin="01:00:00.958" end="01:00:01.708">Two million?</p>'
    + '<p begin="01:00:03.791" end="01:00:06.166">Had I known<br/>such capabilities,</p>'
    + '</div></body></tt>', 3600);
  ok('media 毫秒解析 + 去偏移', t1.indexOf('00:00:00,958 --> 00:00:01,708') >= 0, t1);
  ok('br 转多行', t1.indexOf('Had I known\nsuch capabilities,') >= 0, t1);
  ok('序号从 1 递增', t1.indexOf('1\n') === 0 && t1.indexOf('\n2\n') > 0);

  const t2 = ttmlToSrt('<?xml version="1.0"?><tt ttp:frameRate="24" ttp:timeBase="media"><body><div>'
    + '<p begin="00:00:01.000" end="00:00:02.500">Already zero</p></div></body></tt>', 3600);
  ok('已归零时间不被误减', t2.indexOf('00:00:01,000') >= 0, t2);

  const t3 = ttmlToSrt('<?xml version="1.0"?><tt ttp:frameRate="24" ttp:timeBase="smpte"><body><div>'
    + '<p begin="00:00:01:12" end="00:00:02:00">Frames</p></div></body></tt>', 0);
  ok('smpte 帧基准解析', t3.indexOf('00:00:01,500 --> 00:00:02,000') >= 0, t3);

  const t4 = ttmlToSrt('<?xml version="1.0"?><tt ttp:frameRate="24" ttp:timeBase="smpte"><body><div>'
    + '<p begin="00:00:01.958" end="00:00:02.500">Ms</p></div></body></tt>', 0);
  ok('末段 >= 帧率时退回毫秒', t4.indexOf('00:00:01,958') >= 0, t4);

  ok('XML 实体解码', ttmlToSrt('<tt ttp:timeBase="media"><body><div>'
    + '<p begin="00:00:01.000" end="00:00:02.000">A &amp; B &lt;3&gt;</p>'
    + '</div></body></tt>', 0).indexOf('A & B <3>') >= 0);
  ok('空输入返回空串', ttmlToSrt('', 0) === '');
  ok('无 p 返回空串', ttmlToSrt('<tt><body></body></tt>', 0) === '');

  const src = fs.readFileSync(path.join(__dirname, 'js', 'resolve-host.js'), 'utf8');
  ok('finalizeSidecar 会转 TTML', src.indexOf('ttmlToSrt(fsMod.readFileSync') >= 0);
  ok('finalizeSidecar 接收偏移参数', /async function finalizeSidecar\(outDir, stem, subtitleDir, before, offsetSeconds\)/.test(src));
  ok('exportOne 传入起始偏移', src.indexOf('finalizeSidecar(target.outDir, stem, sd, srtBefore, sidecarOffset)') >= 0);
}

console.log('\n=== sanitizeFileName / resolveOutputs ===');
ok('去掉非法字符', sanitizeFileName('a/b\\c:d*e?f"g<h>i|j') === 'a_b_c_d_e_f_g_h_i_j', sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'));
ok('空值回退', sanitizeFileName('') === 'output');
ok('中文保留', sanitizeFileName('成片') === '成片');
{
  const versions = [
    { name: '成片', outDir: 'D:\\out' },
    { name: '无字幕版', outDir: 'D:\\out' },
    { name: '无音乐无字幕版', outDir: 'D:\\other' }
  ];
  const t = resolveOutputs('第1集', versions);
  ok('同目录两个版本都加后缀', t[0].fileName === '第1集_成片' && t[1].fileName === '第1集_无字幕版',
    t.map(x => x.fileName).join(' | '));
  ok('独占目录不加后缀', t[2].fileName === '第1集', t[2].fileName);
}
{
  const t = resolveOutputs('seq', [{ name: 'a', outDir: 'D:\\only\\' }]);
  ok('单版本独占目录用序列名', t[0].fileName === 'seq');
  ok('尾部分隔符被清理', t[0].outDir === 'D:\\only');
}

console.log('\n=== 导出状态机 ===');
{
  const st = host.getExportState();
  ok('含 log 字段', Array.isArray(st.log));
  ok('含 results 字段', Array.isArray(st.results));
  ok('非运行态', st.running === false);
}

// ---- 阶段二：字幕模块 ----
try {
  require('./test-subtitle.js').run(ok);
} catch (e) {
  fail += 1;
  console.log('  FAIL  字幕模块未能运行：' + (e && e.message ? e.message : e));
}

// ---- 阶段四：剧本模块 ----
try {
  require('./test-script.js').run(ok);
require('./test-sound-panels.js').run(ok);
} catch (e) {
  fail += 1;
  console.log('  FAIL  剧本模块未能运行：' + (e && e.message ? e.message : e));
}

// ---- 阶段三：声音模块 ----
try {
  require('./test-sound.js').run(ok);
} catch (e) {
  fail += 1;
  console.log('  FAIL  声音模块未能运行：' + (e && e.message ? e.message : e));
}

console.log('\n========================================');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
