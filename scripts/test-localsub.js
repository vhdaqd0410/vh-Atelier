
// 本地去字幕（VSR）面板回归：导入素材箱 + 框选区域
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  [OK]   ' + n); }
                       else { fail++; console.log('  [FAIL] ' + n + (e !== undefined ? ' -> ' + e : '')); } }
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const ui = read('js/vsr-ui.js');
const html = read('index.html');
const css = read('css/atelier.css');
const host = read('jsx/host.jsx');
const py = read('py/vsr_client.py');

// ---------- A) 处理完成后导入 PR 素材箱 ----------
ok('有 importToBin 实现', /function importToBin\s*\(/.test(ui));
ok('importToBin 走宿主 meImportFilesToBinStr', /meImportFilesToBinStr/.test(ui));
ok('importToBin 先写 meImportPayload（JS 变量传不进 ExtendScript）',
   /meImportPayload\s*=\s*/.test(ui));
ok('有 importResult 统一收尾', /function importResult\s*\(/.test(ui));
ok('素材箱名为「去字幕」', /'去字幕'/.test(ui));
ok('处理勾选序列完成后调用 importResult', /importResult\(produced, '去字幕', next\)/.test(ui));
ok('处理选中区间完成后调用 importResult', /importResult\(produced, '去字幕', null\)/.test(ui));
ok('选文件处理完成后调用 importResult',
   /runOne\(v, path\.join\(dir, base \+ '_erased\.mp4'\)[\s\S]{0,200}importResult\(produced/.test(ui));
ok('runOne 成功时回传产出路径', /onDone\(null, ev\.output\)/.test(ui));
ok('宿主确有 meImportFilesToBinStr', /function meImportFilesToBinStr/.test(host));

// ---------- B) 框选 ----------
ok('界面有「框选」选项', /value="pick"/.test(html));
ok('框选为默认选中', /<option value="pick" selected>/.test(html));
ok('有截帧按钮', /id="lsGrabFrame"/.test(html));
ok('有框选画布与框元素', /id="lsPickStage"/.test(html) && /id="lsPickBox"/.test(html));
ok('有应用按钮', /id="lsPickApply"/.test(html));
ok('有四个缩放手柄', (html.match(/class="ls-ph ls-ph-/g) || []).length === 4);
ok('CSS 有框选舞台样式', /\.ls-pick-stage\s*\{/.test(css));
ok('CSS 舞台贴合图片（fit-content，避免比例算错）', /width:fit-content/.test(css));
ok('CSS 框选有遮罩（box-shadow 大扩散）', /box-shadow:0 0 0 9999px/.test(css));

ok('有 grabFrame 实现', /function grabFrame\s*\(/.test(ui));
ok('截帧调宿主 lsGrabFrameStr', /lsGrabFrameStr\(/.test(ui));
ok('有拖拽绑定 bindPickDrag', /function bindPickDrag/.test(ui) && /bindPickDrag\(\);/.test(ui));
ok('有比例换算 boxToRatio', /function boxToRatio/.test(ui));
ok('比例上限收敛到 1（clamp）', /Math\.max\(0, Math\.min\(1,/.test(ui));
ok('pick 模式参与 currentArea', /mode === 'pick'/.test(ui) && /if \(picked\) return \[\[picked\.y0/.test(ui));
ok('框选后写入 picked', /picked = r;/.test(ui));
ok('pick 模式显示框选区', /pr\.style\.display = \(mode === 'pick'\)/.test(ui));
ok('未框选时先引导截帧（不拿默认区域硬跑）', /function ensurePickedForUI/.test(ui));
ok('引导在两条入口都调用', (ui.match(/ensurePickedForUI\(/g) || []).length >= 3);
ok('按序列名取 id 的宿主接口存在', /function lsSeqIdByNameStr/.test(host));

// ---------- 宿主截帧 ----------
ok('宿主有 lsGrabFrameStr', /function lsGrabFrameStr/.test(host));
ok('截帧用官方 QE 通道', /app\.enableQE\(\)/.test(host) && /exportFramePNG\(/.test(host));
ok('截帧用 CTI.timecode', /CTI\.timecode/.test(host));
ok('截帧回传帧尺寸（供换算像素）', /frameSizeHorizontal/.test(host));

// ---------- py 侧口径一致 ----------
ok('py 侧 --area 支持比例（<=1）', /<= 1\.0/.test(py) || /<=1/.test(py));
ok('py 侧比例换算 ymin*H / xmin*W', /ymin \* H/.test(py) && /xmin \* W/.test(py));

// ---------- 语法 ----------
try { new vm.Script(ui); ok('vsr-ui.js 可解析', true); }
catch (e) { ok('vsr-ui.js 可解析', false, e.message); }

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
