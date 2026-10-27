
// CSS 作用域回归：双面板共享样式不得产生畸变选择器
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; console.log('  [OK]   ' + n); }
                       else { fail++; console.log('  [FAIL] ' + n + (e !== undefined ? ' -> ' + e : '')); } }

const css = fs.readFileSync(path.join(ROOT, 'css', 'atelier.css'), 'utf8');

// 规则解析（去注释）
const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [];
const re = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = re.exec(clean)) !== null) {
  const sels = m[1].split(',').map(s => s.trim()).filter(Boolean);
  rules.push({ sels: sels, body: m[2], raw: m[1].trim() });
}

// 1) 每个带 #panel-upscale 的选择器，都必须有对应的 #panel-localsub 版本
let missingTwin = [];
rules.forEach(r => {
  r.sels.forEach(s => {
    if (s.indexOf('#panel-upscale') < 0) return;
    const twin = s.replace('#panel-upscale', '#panel-localsub');
    if (r.sels.indexOf(twin) < 0) missingTwin.push(s);
  });
});
ok('每条 #panel-upscale 选择器都有配对的 #panel-localsub', missingTwin.length === 0,
   missingTwin.slice(0, 4).join(' ; '));

// 2) 核心：不得出现「裸/复合 #panel-upscale」被当成独立选择器而失去后代限定
//    合法例外只有面板容器本身那一条（display:flex / 100vh-130px）
let corrupted = [];
rules.forEach(r => {
  r.sels.forEach(s => {
    if (!/^#panel-upscale(\.[\w-]+)?$/.test(s)) return;
    const isContainerRule = /100vh\s*-\s*130px/.test(r.body);
    if (!isContainerRule) corrupted.push(s + '  { ' + r.body.trim().slice(0, 50) + ' }');
  });
});
ok('没有把复合选择器切断成独立 #panel-upscale 规则', corrupted.length === 0,
   corrupted.slice(0, 3).join(' ; '));

// 3) 关键回归点：#panel-upscale 不应被 display:none 直接命中
const killsPanel = rules.some(r =>
  r.sels.some(s => /^#panel-upscale(\.[\w-]+)?$/.test(s)) && /display\s*:\s*none/.test(r.body));
ok('#panel-upscale 自身未被 display:none 命中（面板不会整体消失）', !killsPanel);

// 4) 展开态隐藏的是内部滚动区，不是面板本身
const expHidden = rules.filter(r => /en-expanded|en-exp-task|en-exp-log/.test(r.raw) && /display\s*:\s*none/.test(r.body));
ok('展开态隐藏规则都作用于内部元素（带 .en- 后代）',
   expHidden.every(r => r.sels.every(s => /\.en-|#en/.test(s))),
   expHidden.map(r => r.raw.slice(0, 80)).join(' ; ').slice(0, 200));

// 5) 顶层容器规则仍在（两个面板都能撑满高度）
ok('两个面板都有 100vh-130px 容器规则',
   rules.some(r => /100vh\s*-\s*130px/.test(r.body) &&
                   r.sels.indexOf('#panel-upscale') >= 0 && r.sels.indexOf('#panel-localsub') >= 0));

// 6) CSS 语法基本健全
ok('括号平衡', (clean.match(/\{/g) || []).length === (clean.match(/\}/g) || []).length);
ok('无连续逗号', !/,\s*,/.test(clean));
ok('无空选择器', !/(?:^|[};])\s*\{/.test(clean));
ok('逗号后不是直接左花括号', !/,\s*\{/.test(clean));

// 7) 本地面板的样式确实也生效（防止只写了超分侧）
const lsRules = rules.filter(r => r.sels.some(s => s.indexOf('#panel-localsub') >= 0));
ok('本地去字幕面板有足够样式规则（>= 50）', lsRules.length >= 50, lsRules.length);
ok('框选舞台样式存在', css.indexOf('.ls-pick-stage') >= 0);
ok('框选舞台贴合图片（比例换算正确性）', /width:fit-content/.test(css));

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
