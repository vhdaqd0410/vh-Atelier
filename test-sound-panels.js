// 声音板块新增四项（网易云 / 短剧扒歌 / 音乐聚合 / 语音克隆）回归测试
const path = require('path');
const fs = require('fs');
const BASE = __dirname;
const D = BASE;   // com.vh.atelier

let pass = 0, fail = 0;
let sink = null;
function ok(name, cond) {
  if (sink) { sink(name, cond); return; }
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}
function read(f) { try { return fs.readFileSync(path.join(D, f), 'utf8'); } catch (e) { return ''; } }

function evalBody() {
  const main = read('main.js');
  const pre = read('preload.js');
  const html = read('index.html');
  const app = read('js/app.js');

  const media2 = read('js/media.js');
  const main2 = read('main.js');

  console.log('=== A. 网易云（主进程直连，无独立服务）===');
  ok('存在 ncm-host.js', fs.existsSync(path.join(D, 'ncm-host.js')));
  ok('存在 ncm 依赖', fs.existsSync(path.join(D, 'ncm', 'node_modules', 'NeteaseCloudMusicApi')));
  ok('main 注册 ncm:search', main.indexOf("'ncm:search'") >= 0);
  ok('main 注册 ncm:songUrl', main.indexOf("'ncm:songUrl'") >= 0);
  ok('main 注册 ncm:qrCreate', main.indexOf("'ncm:qrCreate'") >= 0);
  ok('main 注册 ncm:download', main.indexOf("'ncm:download'") >= 0);
  ok('preload 暴露 ncmStatus', pre.indexOf('ncmStatus:') >= 0);
  ok('preload 暴露 ncmDownload', pre.indexOf('ncmDownload:') >= 0);
  ok('有网易云面板', html.indexOf('id="panel-ncm"') >= 0);
  ok('有网易云脚本', html.indexOf('js/ncm.js') >= 0 && fs.existsSync(path.join(D, 'js', 'ncm.js')));
  ok('app 初始化网易云', app.indexOf('__ncmPanel') >= 0);

  console.log('');
  console.log('=== B. 短剧扒歌（本地服务 17891）===');
  ok('存在 bgm/server.js', fs.existsSync(path.join(D, 'bgm', 'server.js')));
  ok('存在 afp 指纹引擎', fs.existsSync(path.join(D, 'ncm', 'afp', 'afp.js')));
  ok('main 注册 bgm:start', main.indexOf("'bgm:start'") >= 0);
  ok('main 注册 bgm:api', main.indexOf("'bgm:api'") >= 0);
  ok('main 注册 bgm:post', main.indexOf("'bgm:post'") >= 0);
  ok('扒歌服务用 Electron 自身当 Node', main.indexOf('ELECTRON_RUN_AS_NODE') >= 0);
  ok('扒歌资源定位本插件优先', read('bgm/server.js').indexOf("path.join(EXT_ROOT, 'bin', 'ffmpeg-win32-x64.exe'),") >= 0);
  ok('preload 暴露 bgmApi', pre.indexOf('bgmApi:') >= 0);
  ok('有扒歌面板', html.indexOf('id="panel-bgm"') >= 0);
  ok('有扒歌脚本', html.indexOf('js/bgm.js') >= 0 && fs.existsSync(path.join(D, 'js', 'bgm.js')));
  ok('app 初始化扒歌', app.indexOf('__bgmPanel') >= 0);

  console.log('');
  console.log('=== C. 音乐聚合已移除（按需求下线）===');
  ok('无 lxserver 目录', !fs.existsSync(path.join(D, 'lxserver')));
  ok('无 musicagg 脚本', !fs.existsSync(path.join(D, 'js', 'musicagg.js'))
     && !fs.existsSync(path.join(D, 'js', 'musicagg-native.js')));
  ok('无音乐聚合面板', html.indexOf('panel-musicagg') < 0);
  ok('main 无 ma:* 通道', main.indexOf("'ma:start'") < 0 && main.indexOf("'ma:api'") < 0);
  ok('preload 无 ma* 接口', pre.indexOf('maStart') < 0);
  ok('app 不再初始化音乐聚合', app.indexOf('__maPanel') < 0);

  console.log('');
  console.log('=== D. 语音克隆（复用本机 CosyVoice3）===');
  ok('存在 cosyvoice_cli.py', fs.existsSync(path.join(D, 'py', 'cosyvoice_cli.py')));
  ok('存在 torio_stub', fs.existsSync(path.join(D, 'stubs', 'torio_stub', 'torio', '__init__.py')));
  ok('main 注册 clone:env', main.indexOf("'clone:env'") >= 0);
  ok('main 注册 clone:run', main.indexOf("'clone:run'") >= 0);
  ok('main 注册 clone:grabSelection', main.indexOf("'clone:grabSelection'") >= 0);
  ok('main 注册 clone:stop', main.indexOf("'clone:stop'") >= 0);
  ok('引擎默认指向本机 CosyVoice3', main.indexOf('cosyvoice3_V30') >= 0);
  ok('preload 暴露 cloneRun', pre.indexOf('cloneRun:') >= 0);
  ok('有 Breeze 面板', html.indexOf('panel-breeze') >= 0);
  ok('有 Breeze 脚本', fs.existsSync(path.join(D, 'js', 'breeze.js')));
  ok('Breeze 引擎在', fs.existsSync(path.join(D, 'breeze', 'engine', 'breeze-cli.exe')));
  ok('Breeze 模型在', fs.existsSync(path.join(D, 'breeze', 'models', 'breeze-tts-2-q4_k-dd2.gguf')));
  ok('Breeze 有参考波形', read('js/breeze.js').indexOf('mountRefWave') >= 0);
  ok('Breeze 有结果波形', read('js/breeze.js').indexOf('mountResultWave') >= 0);
  ok('Breeze 自动识别参考文字', read('js/breeze.js').indexOf('autoRecognizeRef') >= 0);
  ok('无语音克隆面板（已下线）', html.indexOf('panel-clone') < 0);
  ok('无克隆脚本', !fs.existsSync(path.join(D, 'js', 'clone.js')));
  ok('app 不再初始化语音克隆', app.indexOf('__clonePanel') < 0);


  console.log('');
  console.log('=== F. 本轮补齐（素材预览 / 刷新时间线 / 波形 / 音色库 / 简洁模式）===');
  const media = read('js/media.js');
  const clone = read('js/clone.js');
  const bgm = read('js/bgm.js');
  const ncm = read('js/ncm.js');
  const man = read('js/musicagg.js');
  const host = read('js/resolve-host.js');
  ok('素材有预览遮罩', media.indexOf('md-preview-ov') >= 0 && media.indexOf('function openPreview') >= 0);
  ok('素材有文件详情', media.indexOf('function showFileDetail') >= 0);
  ok('素材有定位', media.indexOf('function reveal') >= 0);
  ok('素材可导入指定文件', media.indexOf('function importFiles') >= 0);
  ok('三角已放大(22px)', read('css/app.css').indexOf('flex: 0 0 22px') >= 0);
  ok('刷新时间线支持选中当前', read('js/app.js').indexOf('preferCurrent') >= 0);
  ok('fillSubTimelineSelect 认 current', read('js/app.js').indexOf('t.current') >= 0);
  ok('有波形组件', fs.existsSync(path.join(D, 'js', 'wave-mini.js')));
  ok('分离结果用波形', read('js/app.js').indexOf('vhWave.mount') >= 0);
  ok('host 有转写能力', host.indexOf('async function transcribeAudio') >= 0);
  ok('host 能找 whisper', host.indexOf('function findWhisper') >= 0);
  ok('网易云有我的歌单', ncm.indexOf('function loadMyPlaylists') >= 0);
  ok('网易云有最近播放', ncm.indexOf('function loadRecent') >= 0);
  ok('网易云有批量下载', ncm.indexOf('function batchDownload') >= 0);
  ok('网易云有全选', ncm.indexOf('function toggleSelectAll') >= 0);
  ok('网易云有歌词', ncm.indexOf('function syncLyric') >= 0);
  ok('网易云有下载目录', ncm.indexOf('function pickDlDir') >= 0);
  ok('网易云有上下曲', ncm.indexOf('playNext') >= 0 || ncm.indexOf('nextSong') >= 0);
  ok('扒歌有首页榜单', bgm.indexOf('function loadRank') >= 0);
  ok('扒歌榜单四分类', bgm.indexOf('热播总榜') >= 0 && bgm.indexOf('AI 剧榜') >= 0);
  ok('扒歌点卡片进播放页', bgm.indexOf('function openSeries') >= 0 && bgm.indexOf('showPlayer()') >= 0);
  ok('扒歌两态视图', bgm.indexOf('function showHome') >= 0 && html.indexOf('id="bgmHome"') >= 0
     && html.indexOf('id="bgmPlayerWrap"') >= 0);
  ok('扒歌面板可滚动', html.indexOf('bgm-scroll') >= 0);


  console.log('');
  console.log('=== G. 视觉与交互补齐（封面 / 双击展开 / 服务器来源）===');
  ok('素材支持双击展开（click 内判定）', read('js/media.js').indexOf('isDbl') >= 0
     && read('js/media.js').indexOf('DBL_MS') >= 0);
  ok('素材有 toggleExpand', read('js/media.js').indexOf('function toggleExpand') >= 0);
  ok('网易云有头像', ncm.indexOf('ncm-avatar') >= 0);
  ok('网易云歌单带封面', ncm.indexOf('coverImgUrl') >= 0 && ncm.indexOf('ncm-thumb') >= 0);
  ok('网易云单曲带封面', ncm.indexOf('al && s.al.picUrl') >= 0 || ncm.indexOf('s.al.picUrl') >= 0);
  ok('网易云默认载我的歌单', ncm.indexOf('loadMyPlaylists') >= 0 && ncm.indexOf('进面板默认') >= 0);
  ok('网易云有播放模式', ncm.indexOf('function cycleMode') >= 0 && ncm.indexOf('playMode') >= 0);
  ok('网易云播放条对齐 PR', html.indexOf('mp-cover') >= 0 && html.indexOf('mp-side') >= 0);
  ok('网易云有静音按钮', html.indexOf('btnNcmVolBtn') >= 0);
  ok('扒歌用封面卡片', bgm.indexOf('bgm-card') >= 0 && bgm.indexOf('bgm-cover') >= 0);
  ok('扒歌分类扩展', bgm.indexOf('cat:urban') >= 0 && bgm.indexOf('cat:fantasy') >= 0);
  ok('扒歌有播放器', bgm.indexOf('function playAt') >= 0 && html.indexOf('id="bgmV"') >= 0);
  ok('扒歌双击分集播放', bgm.indexOf("addEventListener('dblclick'") >= 0);
  ok('扒歌本地文件匹配', bgm.indexOf('function findLocalEp') >= 0);
  ok('扒歌缓冲遮罩', html.indexOf('id="bgmBuf"') >= 0);
  ok('host 有 transcribeAudio 导出', host.indexOf('transcribeAudio') >= 0);


  console.log('');
  console.log('=== H. 本轮补齐（双击展开 / 字典弹层 / 字幕编辑 / 歌词 / 识曲 / 收藏历史 / 端口隔离）===');
  const appjs = read('js/app.js');
  ok('素材双击自行判定', media2.indexOf('isDbl') >= 0);
  ok('素材展开键归一化', media2.indexOf('expanded[norm(') >= 0);
  ok('有输入弹层组件', fs.existsSync(path.join(D, 'js', 'vh-prompt.js')));
  ok('字典编辑走两列编辑器', appjs.indexOf('__vhDictEditor') >= 0 && appjs.indexOf('window.prompt(') < 0);
  ok('字典编辑器组件存在', fs.existsSync(path.join(D, 'js', 'vh-dict.js')));
  ok('字幕可编辑', appjs.indexOf('contenteditable') >= 0);
  ok('字幕编辑事件绑定', appjs.indexOf('bindSubEditing') >= 0);
  ok('字幕可导出 SRT', appjs.indexOf('exportSubtitleSrt') >= 0);
  ok('网易云有歌词面板', read('js/ncm.js').indexOf('toggleLyricPanel') >= 0);
  ok('网易云有识曲', read('js/ncm.js').indexOf('function doIdentify') >= 0);
  ok('网易云有识曲历史', read('js/ncm.js').indexOf('identHist') >= 0);
  ok('网易云有已下载态', read('js/ncm.js').indexOf('isDownloaded') >= 0);
  ok('网易云有下载菜单', read('js/ncm.js').indexOf('function showDlMenu') >= 0);
  ok('网易云可拖拽', read('js/ncm.js').indexOf("dragstart") >= 0 && read('js/ncm.js').indexOf('startDrag') >= 0);
  ok('主进程有识曲接口', main2.indexOf("'ncm:identify'") >= 0);
  ok('识曲录音脚本存在', fs.existsSync(path.join(D, 'py', 'identify_record.py')));
  ok('ncm-host 有指纹识曲', read('ncm-host.js').indexOf('identifyFromWav') >= 0);
  ok('扒歌有收藏', read('js/bgm.js').indexOf('function toggleFav') >= 0);
  ok('扒歌有历史', read('js/bgm.js').indexOf('function addHist') >= 0);
  ok('扒歌启动状态会收尾', read('js/bgm.js').indexOf('if (ok) status(srvText()') >= 0);
  ok('端口已隔离（不在 PR 段）', main2.indexOf('17911') >= 0
     && main2.indexOf('127.0.0.1:17891') < 0 && main2.indexOf('127.0.0.1:17899') < 0);
  ok('网易云端口已隔离到 17910', read('ncm-host.js').indexOf('17910') >= 0 || main2.indexOf('17910') >= 0);

  console.log('');
  console.log('=== E. 声音组子标签齐全 ===');
  ['sep', 'sfx', 'musiclib', 'ncm', 'bgm', 'breeze'].forEach(t => {
    ok('声音组有 ' + t + ' 标签', new RegExp('data-tab="' + t + '"').test(html));
  });
  ok('人声分离在声音组', html.indexOf('data-tab="sep"') >= 0);
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
