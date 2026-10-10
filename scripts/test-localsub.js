
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
ok('pick 模式显示折叠按钮行', /tog\.parentNode\.style\.display = \(mode === 'pick'\)/.test(ui));
ok('pick 模式不直接展开框选区（默认折叠）', /if \(mode !== 'pick' && pr\) pr\.style\.display = 'none'/.test(ui));
ok('未框选时先引导截帧（不拿默认区域硬跑）', /function ensurePickedForUI/.test(ui));
ok('引导在两条入口都调用', (ui.match(/ensurePickedForUI\(/g) || []).length >= 3);
ok('按序列名取 id 的宿主接口存在', /function lsSeqIdByNameStr/.test(host));


// ---------- C) 区域预设 + 折叠 ----------
ok('有区域预设下拉', /id="lsAreaPreset"/.test(html));
ok('有存位置按钮', /id="lsAreaPresetSave"/.test(html));
ok('有删除预设按钮', /id="lsAreaPresetDel"/.test(html));
ok('有折叠按钮', /id="lsPickToggle"/.test(html));
ok('框选区默认收起', /id="lsPickRow"[^>]*display:none/.test(html));
ok('有已应用区域徽标', /id="lsAppliedBadge"/.test(html));
ok('预设存到 collect（受同步与更新双重保护）',
   /collect['"],\s*['"]vsr_area_presets\.json/.test(ui) || /'collect',\s*'vsr_area_presets\.json'/.test(ui));
ok('有 loadAreaPresets', /function loadAreaPresets/.test(ui));
ok('有 saveAreaPresets', /function saveAreaPresets/.test(ui));
ok('有 renderAreaPresets', /function renderAreaPresets/.test(ui));
ok('有 applyAreaPreset', /function applyAreaPreset/.test(ui));
ok('有 saveCurrentAreaAsPreset', /function saveCurrentAreaAsPreset/.test(ui));
ok('有 deleteCurrentAreaPreset', /function deleteCurrentAreaPreset/.test(ui));
ok('套预设写入 picked', /picked = \{ y0: p\.y0/.test(ui));
ok('同名预设覆盖不堆积', /p\.name !== name/.test(ui));
ok('有 setPickOpen', /function setPickOpen/.test(ui));
ok('折叠状态被记忆', /vh_vsr_pick_open/.test(ui));
ok('展开后重摆默认框（stage 尺寸问题）', /展开后 stage 才有尺寸/.test(ui));
ok('徽标随框选更新', /updateAppliedBadge\(\)/.test(ui));
ok('预设行绑定 change 即应用', /applyAreaPreset\(ps\.value\)/.test(ui));

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
