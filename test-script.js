// 剧本模块测试（阶段四）
const path = require('path');
const fs = require('fs');

const BASE = __dirname;
let pass = 0, fail = 0;
let sink = null;
function ok(name, cond, extra) {
  if (sink) { sink(name, cond, extra); return; }
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

function evalBody() {
  const html = fs.readFileSync(path.join(BASE, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(BASE, 'js', 'script.js'), 'utf8');
  const app = fs.readFileSync(path.join(BASE, 'js', 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(BASE, 'main.js'), 'utf8');
  const pre = fs.readFileSync(path.join(BASE, 'preload.js'), 'utf8');
  const css = fs.readFileSync(path.join(BASE, 'css', 'app.css'), 'utf8');

  console.log('=== 1. 面板结构 ===');
  ok('剧本面板存在', html.indexOf('id="panel-script"') >= 0);
  ok('有选择文件按钮', html.indexOf('SCR-btnPick') >= 0);
  ok('有集数侧栏', html.indexOf('SCR-side') >= 0);
  ok('有正文区', html.indexOf('SCR-body') >= 0);
  ok('有搜索框', html.indexOf('SCR-search') >= 0);
  ok('有译文开关', html.indexOf('SCR-chkZh') >= 0);
  ok('引用了 script.js', html.indexOf('js/script.js') >= 0);

  console.log('');
  console.log('=== 2. 解析脚本 ===');
  ok('存在 py/docx_read.py', fs.existsSync(path.join(BASE, 'py', 'docx_read.py')));
  const py = fs.readFileSync(path.join(BASE, 'py', 'docx_read.py'), 'utf8');
  ok('支持 docx', py.indexOf('word/document.xml') >= 0);
  ok('输出 JSON', py.indexOf('json') >= 0);

  console.log('');
  console.log('=== 3. IPC 链路 ===');
  ok('main 注册 pickScript', main.indexOf("sys:pickScript") >= 0);
  ok('main 注册 scriptParse', main.indexOf("sys:scriptParse") >= 0);
  ok('main 调 python 解析', /execFile\(py/.test(main));
  ok('main 支持 txt 直读', /ext === '\.txt'/.test(main));
  ok('preload 暴露 pickScript', pre.indexOf('pickScript:') >= 0);
  ok('preload 暴露 scriptParse', pre.indexOf('scriptParse:') >= 0);

  console.log('');
  console.log('=== 4. 面板逻辑（对齐 PR js/script.js）===');
  ok('有分集识别（PR 用 data.episodes）', script.indexOf('data.episodes') >= 0);
  ok('有阅读进度记忆', script.indexOf('saveReading') >= 0);
  ok('有最近打开列表', script.indexOf('pushRecentScript') >= 0);
  ok('有翻译入口（整集）', script.indexOf('function doTranslate') >= 0);
  ok('有单句翻译', script.indexOf('lineTransMap') >= 0);
  ok('有翻译邮箱提额', script.indexOf('myMemoryUrl') >= 0 || script.indexOf('getTranslateEmail') >= 0);
  ok('暴露 __scriptPanel', script.indexOf('window.__scriptPanel') >= 0);
  ok('暴露 __copyText', script.indexOf('window.__copyText') >= 0);

  console.log('');
  console.log('=== 5. 接线 ===');
  ok('app 初始化剧本面板', app.indexOf('__scriptPanel.init') >= 0);
  ok('app 切页时初始化', /tab === 'script'[\s\S]{0,120}__scriptPanel/.test(app));
  ok('引用了 utils.js（__vhUtils）', html.indexOf('js/utils.js') >= 0);
  ok('utils.js 文件存在', fs.existsSync(path.join(BASE, 'js', 'utils.js')));

  console.log('');
  console.log('=== 5b. 对齐 PR（彩色字体 / 选中菜单 / 双击复制 / 全量显示）===');
  ok('有台词渲染', script.indexOf('function renderDialogue') >= 0);
  ok('角色名橙色加粗', script.indexOf("#ffb347;font-weight:700") >= 0);
  ok('台词分色（中/英）', script.indexOf("#ff9090") >= 0 && script.indexOf("#ff6b6b") >= 0);
  ok('支持集标题类型（PR scr-ept）', script.indexOf("'ep_title'") >= 0);
  ok('支持场景类型', script.indexOf("'scr-scene'") >= 0 || script.indexOf("'scene'") >= 0);
  ok('支持台词类型', script.indexOf("'dialogue'") >= 0);
  ok('支持旁白类型', script.indexOf("'scr-action'") >= 0 || script.indexOf("'action'") >= 0);
  ok('一次显示全部内容', /var lines = data\.lines \|\| \[\]/.test(script));
  ok('滚动时同步侧栏', script.indexOf('onBodyScroll') >= 0);
  ok('用 getBoundingClientRect 算偏移', script.indexOf('getBoundingClientRect().top - bodyTop') >= 0);
  ok('选集滚动定位', /function scrollToEp[\s\S]{0,400}scrollTop/.test(script));
  ok('内联样式含分色类', script.indexOf('.scr-ept{') >= 0 && script.indexOf('.scr-scene{') >= 0
     && script.indexOf('.scr-dlg{') >= 0 && script.indexOf('.scr-action{') >= 0);
  ok('选中即弹复制菜单', script.indexOf('scr-selmenu') >= 0);
  ok('双击复制台词', script.indexOf('bindDblCopy') >= 0);
  ok('换剧本按钮', script.indexOf('换剧本') >= 0);

  console.log('');
  console.log('=== 6. preload 容错（防整链失效）===');
  ok('preload 用 safeRequire', pre.indexOf('safeRequire') >= 0);
  ok('fs 不可用时返回 null', /fs: _fs \? \{/.test(pre));
  ok('getPaths 走真实 IPC', pre.indexOf("call('sys:getPaths')") >= 0);
}

module.exports = {
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
