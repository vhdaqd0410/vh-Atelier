
// 本地超分面板回归：引擎客户端 + 面板 + 历史 + 样式作用域
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  [OK]   ' + n); }
                       else { fail++; console.log('  [FAIL] ' + n + (e !== undefined ? ' -> ' + e : '')); } }
function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } }

const py = read('py/upscale_client.py');
const ui = read('js/upscale-local.js');
const el_src = read('js/en-local.js');   // 历史/导入等已抽到公共模块
const html = read('index.html');
const css = read('css/atelier.css');
const main = read('js/main.js');

// ---------- A) 引擎客户端 ----------
ok('有 upscale_client.py', py.length > 3000);
ok('有 check 子命令', /def cmd_check\s*\(/.test(py));
ok('有 probe 子命令', /def cmd_probe\s*\(/.test(py));
ok('有 run 子命令', /def cmd_run\s*\(/.test(py));
ok('用 realesrgan-ncnn-vulkan', /realesrgan-ncnn-vulkan\.exe/.test(py));
ok('模型可选 anime/photo/anime4x', /'anime'/.test(py) && /'photo'/.test(py) && /'anime4x'/.test(py));
ok('默认用 realesr-animevideov3（最快）', /realesr-animevideov3/.test(py));
ok('视频流程：抽帧→超分→回拼', /ffmpeg/.test(py) && /f%06d\.png/.test(py) && /libx264/.test(py));
ok('支持目标分辨率（1080 交付）', /--target/.test(py) && /scale=%d:%d:flags=lanczos/.test(py));
ok('音频直接 copy（不重编码）', /'-c:a',\s*'copy'/.test(py));
ok('返回 JSON 行（含 percent）', /'percent'/.test(py) && /'stage'/.test(py));
ok('自检会实跑一次推理', /smokeOk/.test(py));

// ---------- B) 面板 ----------
ok('index.html 有本地超分面板', /id="panel-localup"/.test(html));
ok('tab 按钮存在', /data-tab="localup"/.test(html));
ok('脚本已注册', /upscale-local\.js/.test(html));
ok('main.js 注册面板', /localup:\s*document\.getElementById\('panel-localup'\)/.test(main));
ok('main.js 归入 upscale 分组', /members:\s*\['upscale',\s*'localsub',\s*'localup'\]/.test(main));
ok('切页钩子已接', /__localupOnShow/.test(main) && /window\.__localupOnShow/.test(ui));
ok('有模型/倍率/目标选择', /id="lupModel"/.test(html) && /id="lupScale"/.test(html) && /id="lupTarget"/.test(html));
ok('三条入口齐全', /function runSequences/.test(ui) && /function runClip/.test(ui) && /function pickAndRun/.test(ui));

// ---------- C) 历史与产出 ----------
ok('历史独立存 localup_history.json（与去字幕分开）', /localup_history\.json/.test(ui));
ok('处理完写历史', /addHistory\(\{/.test(ui) || /addHistory/.test(el_src));
ok('历史可拖拽进时间轴', /com\.adobe\.cep\.dnd\.file\.0/.test(el_src));
ok('历史可导入素材箱', /meImportFilesToBinStr/.test(el_src));
ok('历史可定位/打开', /explorer \/select/.test(el_src) && /start "" /.test(el_src));
ok('可清空历史（不删文件）', /清空历史记录/.test(el_src));
ok('输出不覆盖（uniqueOutPath）', /uniqueOutPath/.test(el_src));
ok('结果自动导入「超分」素材箱', /importToBin\(\[produced\], '超分'\)/.test(ui));

// ---------- D) 样式作用域（防切断） ----------
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
ok('CSS 有 #panel-localup 作用域', /#panel-localup/.test(clean));
ok('#panel-localup 未被云端专属 ID 污染',
   !/#panel-localup[^{},]*(#enLogCard|#enTaskCard|#enTaskList|#upscaleFrame|#upNav)/.test(clean));
ok('历史最大化规则指向 lupHistCard', /#panel-localup\.en-exp-hist #lupHistCard/.test(clean));
ok('日志最大化规则指向 lupLogCard', /#panel-localup\.en-exp-log #lupLogCard/.test(clean));
ok('括号平衡', (clean.match(/\{/g) || []).length === (clean.match(/\}/g) || []).length);
ok('无连续逗号', !/,\s*,/.test(clean));

// ---------- E) 语法 ----------
try { new vm.Script(ui); ok('upscale-local.js 可解析', true); }
catch (e) { ok('upscale-local.js 可解析', false, e.message); }


// ---------- E) 公共模块接线完整性（防「引用了未定义的 loc」这类漏改）----------
(function () {
  const src = read('js/en-local.js');
  ok('en-local.js 存在且导出 mount', /window\.__vhLocal\s*=\s*\{\s*mount/.test(src));
  ok('en-local.js 收拢了历史能力', /function loadHistory/.test(src) && /function renderHistory/.test(src));
  ok('en-local.js 收拢了导入能力', /meImportFilesToBinStr/.test(src));
  ok('en-local.js 收拢了唯一输出路径', /function uniqueOutPath/.test(src));
  ok('en-local.js 支持 logId 配置', /function logEl/.test(src));
  // 面板侧：有引用就必须有定义
  const def = /var loc = \(window\.__vhLocal/.test(ui);
  const nUse = (ui.match(/loc \? loc\./g) || []).length;
  ok('面板引用了 loc 就必须定义 loc（定义=' + def + ' 引用=' + nUse + '）',
     (nUse === 0 && !def) || (nUse > 0 && def));
  ok('面板已接入公共模块（引用数 > 0）', nUse > 0, nUse);
})();

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
