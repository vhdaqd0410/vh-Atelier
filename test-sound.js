// 声音模块回归测试（阶段三）
const path = require('path');
const fs = require('fs');

const BASE = __dirname;
const host = require(path.join(BASE, 'js/resolve-host.js'));
const svc = require(path.join(BASE, 'localsvc.js'));

let pass = 0, fail = 0;
let sink = null;
function ok(name, cond, extra) {
  if (sink) { sink(name, cond, extra); return; }
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

function evalBody() {
  console.log('=== 1. 本地服务能力探测 ===');
  {
    const c = svc.capabilities();
    ok('返回平台信息', c.platform === process.platform);
    ok('有 workDir', typeof c.workDir === 'string' && c.workDir.length > 0);
    ok('ffmpeg 路径已解析', !!c.ffmpeg, String(c.ffmpeg));
    ok('ffmpeg 文件确实存在', !!c.ffmpeg && fs.existsSync(c.ffmpeg));
    ok('分离引擎存在', !!c.separationExe && fs.existsSync(c.separationExe));
    ok('vocals 模型存在', !!c.vocalsModel && fs.existsSync(c.vocalsModel));
    ok('accompaniment 模型存在', !!c.accompanimentModel && fs.existsSync(c.accompanimentModel));
    ok('hasSeparation 为真', c.hasSeparation === true);
  }

  console.log('');
  console.log('=== 2. localsvc 源码关键契约 ===');
  {
    const s = fs.readFileSync(path.join(BASE, 'localsvc.js'), 'utf8');
    ok('导出 capabilities', s.indexOf('capabilities,') >= 0);
    ok('导出 separateVocals', s.indexOf('separateVocals,') >= 0);
    ok('用 spawn 而非 shell', s.indexOf("require('child_process')") >= 0 && s.indexOf('spawn(') >= 0);
    ok('进程带 windowsHide', s.indexOf('windowsHide: true') >= 0);
    ok('分离输出纯 ASCII 名', s.indexOf("'voice_' + ts") >= 0);
    ok('有超时保护', s.indexOf('timeoutMs') >= 0);
    ok('失败时抛错并带退出码', s.indexOf('分离未产出人声轨') >= 0);
    ok('不把引擎日志当错误', s.indexOf("只要产物存在就算成功") >= 0);
  }

  console.log('');
  console.log('=== 3. 宿主：素材池与音频 ===');
  {
    const s = fs.readFileSync(path.join(BASE, 'js/resolve-host.js'), 'utf8');
    ok('有 ensureMediaFolder', s.indexOf('async function ensureMediaFolder') >= 0);
    ok('有 importFilesToPool', s.indexOf('async function importFilesToPool') >= 0);
    ok('有 insertAudioToTimeline', s.indexOf('async function insertAudioToTimeline') >= 0);
    ok('有 setAudioClipProps', s.indexOf('async function setAudioClipProps') >= 0);
    ok('有 readAudioClipProps', s.indexOf('async function readAudioClipProps') >= 0);
    ok('有 getPlayhead', s.indexOf('async function getPlayhead') >= 0);
    ok('有 describeClip 复用', s.indexOf('async function describeClip') >= 0);
    // 关键坑：必须用 AddItemListToMediaPool
    ok('导入用 AddItemListToMediaPool', s.indexOf('AddItemListToMediaPool(arr)') >= 0);
    ok('插入前切安全页', /async function insertAudioToTimeline[\s\S]{0,900}ensureTrackSafePage/.test(s));
    ok('属性写入前切安全页', /async function setAudioClipProps[\s\S]{0,900}ensureTrackSafePage/.test(s));
    ok('写属性后返回失败清单', s.indexOf('failed: failed') >= 0);
    ok('片段描述含文件路径', s.indexOf("GetClipProperty('File Path')") >= 0);
    ok('片段描述含相对秒', s.indexOf('startSec:') >= 0);
  }

  console.log('');
  console.log('=== 4. IPC 对齐 ===');
  {
    const main = fs.readFileSync(path.join(BASE, 'main.js'), 'utf8');
    const pre = fs.readFileSync(path.join(BASE, 'preload.js'), 'utf8');
    for (const ch of ['importFilesToPool', 'insertAudioToTimeline', 'getPlayhead',
                      'setAudioClipProps', 'readAudioClipProps']) {
      ok('main 注册 ' + ch, main.indexOf('host:' + ch) >= 0);
      ok('preload 暴露 ' + ch, pre.indexOf(ch + ':') >= 0);
    }
    for (const ch of ['capabilities', 'separateVocals', 'extractAudio', 'toMp3', 'probe']) {
      ok('main 注册 svc:' + ch, main.indexOf('svc:' + ch) >= 0);
    }
    ok('main 注册 sys:listDir', main.indexOf('sys:listDir') >= 0);
    ok('main 注册 sys:readAudioDataUrl', main.indexOf('sys:readAudioDataUrl') >= 0);
    ok('main 注册 sys:revealFile', main.indexOf('sys:revealFile') >= 0);
    // IPC 不重复
    const found = main.match(/ipcMain\.handle\('([^']+)'/g) || [];
    const names = found.map(x => x.replace(/.*'([^']+)'.*/, '$1'));
    const dup = [...new Set(names)].filter(x => names.filter(y => y === x).length > 1);
    ok('IPC 无重复注册', dup.length === 0, dup.join(','));
  }

  console.log('');
  console.log('=== 5. UI 结构 ===');
  {
    const html = fs.readFileSync(path.join(BASE, 'index.html'), 'utf8');
    const app = fs.readFileSync(path.join(BASE, 'js/app.js'), 'utf8');
    ok('有声音面板（三合一：人声分离/音效库/音乐库）',
       html.indexOf('id="panel-sep"') >= 0 && html.indexOf('id="panel-sfx"') >= 0
       && html.indexOf('id="panel-musiclib"') >= 0);
    ok('导航与视图对齐',
       (html.match(/data-view="(\w+)"/g) || []).length === (html.match(/id="view-\w+"/g) || []).length);
    ok('app 绑定人声分离', app.indexOf('bindSeparate') >= 0);
    ok('音效库面板脚本存在', fs.existsSync(path.join(BASE, 'js', 'sfx.js')));
    ok('音乐库面板脚本存在', fs.existsSync(path.join(BASE, 'js', 'musiclib.js')));
    ok('有音效库扫描', fs.readFileSync(path.join(BASE, 'js', 'sfx.js'), 'utf8').indexOf('function scan') >= 0);
    ok('音效库用 WaveSurfer 画波形',
       fs.readFileSync(path.join(BASE, 'js', 'sfx.js'), 'utf8').indexOf('WaveSurfer.create') >= 0);
    ok('音效库支持拖出（startDrag）',
       fs.readFileSync(path.join(BASE, 'js', 'sfx.js'), 'utf8').indexOf('startDrag') >= 0);
    ok('音效库有虚拟滚动',
       fs.readFileSync(path.join(BASE, 'js', 'sfx.js'), 'utf8').indexOf('ITEM_H') >= 0);
    ok('音效库有目录树',
       fs.readFileSync(path.join(BASE, 'js', 'sfx.js'), 'utf8').indexOf('buildTree') >= 0);
    ok('用选中片段读 onlySelected', app.indexOf('onlySelected: true') >= 0);
    ok('分离结果可导入/插入', app.indexOf('data-sep-import') >= 0 && app.indexOf('data-sep-insert') >= 0);
    ok('音效目录持久化', app.indexOf('SFX_ROOT_KEY') >= 0);
    ok('属性应用后读回校验', app.indexOf('读回校验') >= 0);
  }

  console.log('');
  console.log('=== 6. 运行时资产 ===');
  {
    const need = [
      ['bin', 'ffmpeg-win32-x64.exe'],
      ['bin', 'sherpa', 'sherpa-onnx-offline-source-separation.exe'],
      ['bin', 'sherpa', 'onnxruntime.dll'],
      ['models', 'spleeter', 'sherpa-onnx-spleeter-2stems-fp16', 'vocals.fp16.onnx'],
      ['models', 'spleeter', 'sherpa-onnx-spleeter-2stems-fp16', 'accompaniment.fp16.onnx']
    ];
    for (const seg of need) {
      const p = path.join(BASE, ...seg);
      ok('存在 ' + seg[seg.length - 1], fs.existsSync(p),
         fs.existsSync(p) ? (fs.statSync(p).size / 1048576).toFixed(1) + 'MB' : '缺失');
    }
  }
}


  console.log('');
  console.log('=== 7. 交互细节（对齐 PR 版）===');
  {
    const sfx = fs.readFileSync(path.join(BASE, 'js', 'sfx.js'), 'utf8');
    const mllib = fs.readFileSync(path.join(BASE, 'js', 'musiclib.js'), 'utf8');
    const media = fs.readFileSync(path.join(BASE, 'js', 'media.js'), 'utf8');
    const app = fs.readFileSync(path.join(BASE, 'js', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(BASE, 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(BASE, 'main.js'), 'utf8');

    // 目录树可折叠（不是全展开）
    ok('sfx 树有折叠状态 __open', sfx.indexOf('__open') >= 0);
    ok('sfx 树有 collapseTree', sfx.indexOf('collapseTree') >= 0);
    ok('sfx 子节点默认收起（__open: false）', /__open:\s*false/.test(sfx));
    ok('mllib 树有折叠状态', mllib.indexOf('__open') >= 0 && mllib.indexOf('collapseTree') >= 0);
    ok('点 caret 才折叠（区分行点击）', sfx.indexOf("contains('caret')") >= 0);

    // 波形点击从指针播放
    ok('sfx 波形有点击处理', sfx.indexOf("waveEl.addEventListener('click'") >= 0);
    ok('sfx 点击按比例 seek', /waveEl\.addEventListener\('click'[\s\S]{0,400}rect\.width/.test(sfx));
    ok('sfx 点击后从该位置播放', /waveEl\.addEventListener\('click'[\s\S]{0,900}playFrom\(f, ratio \* d\)/.test(sfx));
    ok('sfx 波形起点有时长兜底',
       sfx.indexOf('f.durationSec') >= 0 && sfx.indexOf('curAudio.duration') >= 0);
    ok('mllib 波形有点击处理', mllib.indexOf("waveEl.addEventListener('click'") >= 0);

    // 拖拽（真实图标）
    ok('sfx 拖拽走 startDrag', sfx.indexOf('startDrag') >= 0);
    ok('mllib 拖拽走 startDrag', mllib.indexOf('startDrag') >= 0);
    ok('media 拖拽走 startDrag', media.indexOf('startDrag') >= 0);
    ok('main 拖拽用图片图标（非 dll）',
       main.indexOf('dragicon.png') >= 0 && main.indexOf('shell32.dll') < 0);
    ok('存在拖拽图标文件', fs.existsSync(path.join(BASE, 'assets', 'dragicon.png')));

    // 素材面板（对齐 PR：左树 + 右列表）
    ok('素材面板有左树', html.indexOf('id="mdTree"') >= 0);
    ok('素材面板有右列表', html.indexOf('id="mdFList"') >= 0);
    ok('素材面板可加常用根', html.indexOf('id="mdAddRoot"') >= 0);
    ok('素材面板有盘符选择', html.indexOf('id="mdRootSel"') >= 0);
    ok('media 有目录树渲染', media.indexOf('renderTree') >= 0);
    ok('media 有文件列表渲染', media.indexOf('renderFiles') >= 0);
    ok('media 支持多选（Ctrl）', media.indexOf('ctrlKey') >= 0);
    ok('media 可导入选中/整目录', media.indexOf('importSelected') >= 0 && media.indexOf('importFolder') >= 0);

    // 待办/进度已移除
    ok('已移除待办分组', html.indexOf('data-group="todo"') < 0);
    ok('已移除进度分组', html.indexOf('data-group="progress"') < 0);

    // 连接状态（单一 class，且初始化步骤互相隔离）
    ok('连接灯只用 ok/err', /setDot\('ok'/.test(app) && /setDot\('err'/.test(app));
    ok('初始化逐步容错 safeStep', app.indexOf('safeStep') >= 0);
    ok('旧素材元素缺失时安全返回', /function renderFiles\(\)[\s\S]{0,90}if \(!box\) return/.test(app));
  }


  console.log('');
  console.log('');
  console.log('=== 8. 第二轮反馈修复（锁死） ===');
  {
    const sfx = fs.readFileSync(path.join(BASE, 'js', 'sfx.js'), 'utf8');
    const mllib = fs.readFileSync(path.join(BASE, 'js', 'musiclib.js'), 'utf8');
    const media = fs.readFileSync(path.join(BASE, 'js', 'media.js'), 'utf8');
    const host = fs.readFileSync(path.join(BASE, 'js', 'resolve-host.js'), 'utf8');
    const main = fs.readFileSync(path.join(BASE, 'main.js'), 'utf8');
    const html = fs.readFileSync(path.join(BASE, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(BASE, 'css', 'app.css'), 'utf8');

    // (1) 目录树图标：不能出现音乐图标
    ok('sfx 树里没有音乐图标', sfx.indexOf(String.fromCodePoint(0x1F3B5)) < 0);
    ok('mllib 树里没有音乐图标', mllib.indexOf(String.fromCodePoint(0x1F3B5)) < 0);
    ok('树图标区分有无子目录', sfx.indexOf('hasKids ?') >= 0 && sfx.indexOf('\uD83D\uDCC2') >= 0);

    // (2) 素材面板：可折叠目录树（左树 + 右文件列表）
    //     关键点：①同步 fs（异步链路一断整片失效）②树顶点与选中目录解耦（否则点一下树就"换根"）
    ok('media 用同步 fs 读目录', media.indexOf('fsSync.readdir') >= 0);
    ok('media 有可折叠三角', media.indexOf('md-tri') >= 0 && media.indexOf('expanded[') >= 0);
    ok('media 展开态可持久化', media.indexOf('vh_media_exp_v1') >= 0);
    ok('media 点三角切换展开', media.indexOf('function toggleExpand') >= 0 && media.indexOf('toggleExpand(path)') >= 0);
    ok('media 展开键归一化', media.indexOf('expanded[norm(') >= 0);
    ok('media 双击判定不依赖 dblclick', media.indexOf('isDbl') >= 0 && media.indexOf('DBL_MS') >= 0);
    ok('media 树顶点与选中目录解耦', media.indexOf('treeRoot') >= 0 && media.indexOf('curDir') >= 0);
    ok('media 有懒加载缓存', media.indexOf('nodeKids') >= 0);
    ok('media 有盘符列表兜底', media.indexOf('fsSync.drives') >= 0);
    ok('media 右键菜单走 vhMenu', media.indexOf('vhMenu') >= 0);

    // (3) listSubDirs 返回完整路径
    ok('listSubDirs 用 fs 直读', host.indexOf('async function listSubDirs') >= 0
       && host.indexOf('fs.promises.readdir') >= 0);
    ok('listSubDirs 返回完整路径', host.indexOf('path.join(rootPath, d.name)') >= 0);
    // 函数体内不得出现对 MediaStorage 的调用（注释里说明原因不算）
    var _subFn = host.slice(host.indexOf('async function listSubDirs'),
                            host.indexOf('async function listSubDirs') + 900);
    ok('listSubDirs 不再调用 MediaStorage',
       _subFn.indexOf('ms.GetSubFolders') < 0 && _subFn.indexOf('getResolve()') < 0);

    // (4) listDir 支持类型过滤、不强制排序
    ok('listDir 支持 kind 参数', main.indexOf('recurse, kind') >= 0);
    ok('listDir 支持 media/all 类型', main.indexOf("kind === 'media'") >= 0 && main.indexOf("kind === 'all'") >= 0);

    // (5) 搜索全局
    ok('sfx 搜索忽略当前目录', sfx.indexOf('有搜索词时全局搜') >= 0);
    ok('mllib 搜索忽略当前目录', mllib.indexOf('有搜索词时全局搜') >= 0);

    // (6) 逐个目录右键排除（不是一刀切复选框）
    ok('音效库有「已排除」入口', html.indexOf('btnSfxExcluded') >= 0);
    ok('音乐库有「已排除」入口', html.indexOf('btnMllibExcluded') >= 0);
    ok('已移除一刀切复选框', html.indexOf('chkSfxNoSubdir') < 0 && html.indexOf('chkMllibNoSubdir') < 0);
    ok('sfx 树支持右键', sfx.indexOf("row.addEventListener('contextmenu'") >= 0);
    ok('mllib 树支持右键', mllib.indexOf("row.addEventListener('contextmenu'") >= 0);
    ok('sfx 有排除菜单项', sfx.indexOf('排除该目录') >= 0 && sfx.indexOf('取消排除该目录') >= 0);
    ok('mllib 有排除菜单项', mllib.indexOf('排除该目录') >= 0);
    ok('sfx 排除持久化', sfx.indexOf('vh_sfx_excluded_v1') >= 0);
    ok('mllib 排除持久化', mllib.indexOf('vh_mllib_excluded_v1') >= 0);
    ok('sfx 路径归一比较', sfx.indexOf('function normPath') >= 0 && sfx.indexOf('function isExcluded') >= 0);
    ok('mllib 路径归一比较', mllib.indexOf('function normPath') >= 0 && mllib.indexOf('function isExcluded') >= 0);
    ok('sfx 建树时过滤排除项', /buildTree[\s\S]{0,600}isExcluded\(f\.path\)/.test(sfx));
    ok('mllib 建树时过滤排除项', /buildTree[\s\S]{0,600}isExcluded\(f\.path\)/.test(mllib));
    ok('sfx 列表也过滤排除项', /visibleFiles = files\.filter[\s\S]{0,120}isExcluded/.test(sfx));
    ok('mllib 列表也过滤排除项', /var list = files\.filter[\s\S]{0,120}isExcluded/.test(mllib));
    ok('sfx 有已排除管理面板', sfx.indexOf('function showExcludedPanel') >= 0);
    ok('mllib 有已排除管理面板', mllib.indexOf('function showExcludedPanel') >= 0);
    ok('可恢复单条排除', sfx.indexOf("btn.textContent = '恢复'") >= 0);
    ok('可一键清空排除', sfx.indexOf('clearAllExcluded') >= 0 && mllib.indexOf('clearAllExcluded') >= 0);
    ok('排除子目录后仍是递归扫描', sfx.indexOf('listDir(dir, true, ' + "'audio'" + ')') >= 0);

    // (7) 播放用 Blob URL
    ok('sfx 用 Blob URL 播放', sfx.indexOf('createObjectURL(blob)') >= 0);
    ok('mllib 用 Blob URL 播放', mllib.indexOf('createObjectURL(blob)') >= 0);
    ok('sfx 播放被拒有提示', sfx.indexOf('NotAllowedError') >= 0);
    ok('mllib 播放被拒有提示', mllib.indexOf('NotAllowedError') >= 0);
    ok('sfx 释放 blob URL', sfx.indexOf('revokeObjectURL') >= 0);

    // (8) 顶栏不遮挡：顶栏固定高度且不参与滚动（.topbar + flex 列布局）
    ok('顶栏固定高度不受挤', /\.topbar\s*\{[^}]*flex:\s*0\s+0\s+auto/.test(css)
       && /\.topbar\s*\{[^}]*height:\s*46px/.test(css));
    ok('顶栏不在滚动流内', /body\s*\{[^}]*overflow:\s*hidden/.test(css)
       && /html,\s*body\s*\{[^}]*height:\s*100%/.test(css));
    ok('面板自身承担滚动', /\.tab-panel\s*\{[^}]*overflow:\s*hidden/.test(css));
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
