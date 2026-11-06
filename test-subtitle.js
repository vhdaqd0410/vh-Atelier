// 字幕模块回归测试（阶段二）
const path = require('path');
const fs = require('fs');
const os = require('os');

const BASE = __dirname;
const host = require(path.join(BASE, 'js/resolve-host.js'));
const T = host.__test;

let pass = 0, fail = 0;
let sink = null;   // 被主套件 require 时，用作外部记账函数

function ok(name, cond, extra) {
  if (sink) { sink(name, cond, extra); return; }
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function evalBody() {
console.log('=== 1. buildSrt 基础 ===');
{
  const items = [
    { text: 'Hello world', startSec: 0.5, endSec: 2.0 },
    { text: 'Second line', startSec: 2.5, endSec: 4.0 }
  ];
  const srt = T.buildSrt(items, 'orig', null);
  ok('条目数正确', (srt.match(/-->/g) || []).length === 2, srt);
  ok('时间格式正确', srt.indexOf('00:00:00,500 --> 00:00:02,000') >= 0, srt);
  ok('序号从 1 起', srt.indexOf('1\n') === 0 && srt.indexOf('\n2\n') > 0, srt);

  const zh = T.buildSrt(items, 'zh', ['你好世界', '第二行']);
  ok('中文模式替换文本', zh.indexOf('你好世界') >= 0 && zh.indexOf('Hello world') < 0, zh);

  const bi = T.buildSrt(items, 'bilingual', ['你好世界', '第二行']);
  ok('双语模式英文在上', bi.indexOf('Hello world\n你好世界') >= 0, bi);

  const noZh = T.buildSrt(items, 'zh', null);
  ok('无译文时回退原文', noZh.indexOf('Hello world') >= 0, noZh);

  ok('空列表返回空串', T.buildSrt([], 'orig', null) === '');
  ok('全空白条目被过滤', T.buildSrt([{ text: '   ', startSec: 0, endSec: 1 }], 'orig', null) === '');
}

console.log('');
console.log('=== 2. 时间码工具 ===');
{
  ok('timecodeStrToFrames 基本', T.timecodeStrToFrames('01:00:00:00', 24) === 86400);
  ok('timecodeStrToFrames 带帧', T.timecodeStrToFrames('01:00:05:12', 24) === 86400 + 5 * 24 + 12);
  ok('timecodeStrToFrames 非法返回 null', T.timecodeStrToFrames('abc', 24) === null);
  ok('secToSrtTime 补零', T.secToSrtTime(0.5) === '00:00:00,500');
  ok('secToSrtTime 跨分', T.secToSrtTime(91.291) === '00:01:31,291');
  ok('secToSrtTime 负数归零', T.secToSrtTime(-5) === '00:00:00,000');
}

console.log('');
console.log('=== 3. 字幕写回：源文件校验 ===');
{
  const src = fs.readFileSync(path.join(BASE, 'js/resolve-host.js'), 'utf8');
  ok('存在 listSubtitles', src.indexOf('async function listSubtitles') >= 0);
  ok('存在 recognizeSubtitles', src.indexOf('async function recognizeSubtitles') >= 0);
  ok('存在 writeSubtitles', src.indexOf('async function writeSubtitles') >= 0);
  ok('识别前切安全页', /async function recognizeSubtitles[\s\S]{0,700}ensureTrackSafePage/.test(src));
  ok('写回前切安全页', /async function writeSubtitles[\s\S]{0,1500}ensureTrackSafePage/.test(src));
  ok('写回前读时间线', /async function writeSubtitles[\s\S]{0,2000}SetCurrentTimeline/.test(src));
  ok('写回清理旧轨', src.indexOf("DeleteTrack('subtitle'") >= 0);
  ok('写回用 AddItemListToMediaPool', src.indexOf('AddItemListToMediaPool([srtPath])') >= 0);
  ok('落点异常有告警', src.indexOf('offsetFromEnd') >= 0);
  ok('临时文件夹被清理', /finally[\s\S]{0,400}DeleteFolders/.test(src));
}

console.log('');
console.log('=== 4. listSubtitles 相对时间换算（构造真实临时目录不便，改为逻辑校验）===');
{
  const src = fs.readFileSync(path.join(BASE, 'js/resolve-host.js'), 'utf8');
  ok('用起始帧做基准', src.indexOf('(sf - startFrame) / fps') >= 0);
  ok('按起始帧排序', src.indexOf('a.startFrame - b.startFrame') >= 0);
  ok('返回 trackCount/fps/items', /return \{ trackCount: n, startFrame: startFrame, fps: fps, items: items \}/.test(src));
}

console.log('');
console.log('=== 5. IPC 三处对齐 ===');
{
  const main = fs.readFileSync(path.join(BASE, 'main.js'), 'utf8');
  const pre = fs.readFileSync(path.join(BASE, 'preload.js'), 'utf8');
  for (const ch of ['listSubtitles', 'recognizeSubtitles', 'writeSubtitles']) {
    ok('main 注册 ' + ch, main.indexOf("host:" + ch) >= 0);
    ok('preload 暴露 ' + ch, pre.indexOf(ch + ":") >= 0);
  }
  ok('main 注册 sys:saveSrt', main.indexOf("sys:saveSrt") >= 0);
  ok('preload 暴露 saveSrt', pre.indexOf("saveSrt:") >= 0);
  ok('主进程用 path.join 拼默认路径', main.indexOf("path.join(defaultDir") >= 0);
}

console.log('');
console.log('=== 6. UI 结构 ===');
{
  const html = fs.readFileSync(path.join(BASE, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(BASE, 'js/app.js'), 'utf8');
  ok('有字幕面板', html.indexOf('id="panel-subtitle"') >= 0);
  ok('无时间线读取探针', html.indexOf('id="view-timeline"') < 0);
  ok('导航项对齐', (html.match(/data-view="(\w+)"/g) || []).length === (html.match(/id="view-\w+"/g) || []).length);
  ok('引入翻译模块', html.indexOf('js/translate.js') >= 0);
  ok('app 绑定字幕面板', app.indexOf('bindSubtitle') >= 0);
  ok('app 无 loadDetail 残留', app.indexOf('function loadDetail') < 0);
  ok('app 无 tlDetailSelect 残留', app.indexOf('tlDetailSelect') < 0);
  ok('翻译走 bridge', app.indexOf('__translateBridge') >= 0);
  ok('字典持久化', app.indexOf('SUB_DICT_KEY') >= 0);
  ok('导出用宿主保存对话框', app.indexOf('H.saveSrt') >= 0);
  ok('写回有二次确认', app.indexOf('window.confirm') >= 0);
}

console.log('');
console.log('=== 7. 翻译模块 ===');
{
  const tr = fs.readFileSync(path.join(BASE, 'js/translate.js'), 'utf8');
  ok('暴露 runTranslate', tr.indexOf('runTranslate') >= 0);
  ok('暴露 translateEnZh', tr.indexOf('translateEnZh') >= 0);
  ok('有节流间隔', tr.indexOf('setTimeout(next, 260)') >= 0);
  ok('有长度截断', tr.indexOf('q.slice(0, 480)') >= 0);
  // 注释里可能提到 __vhUtils（说明来源），关键是不能真的调用它
  ok('不调用 __vhUtils', !/__vhUtils\s*\./.test(tr) && tr.indexOf("window.__vhUtils") < 0);
}

}


module.exports = {
  /** 被主套件调用：用外部 ok 记账 */
  run: function (externalOk) {
    sink = externalOk;
    try { evalBody(); } finally { sink = null; }
  }
};

if (require.main === module) {
  evalBody();
  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
}
