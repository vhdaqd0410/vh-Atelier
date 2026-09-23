/* 用真实文件系统验证 tmp-clean.js：命名空间识别、统计、清理、安全边界 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = 'F:/OH-WorkSpace/plugins/vh-Atelier/com.vh.atelier';
const code = fs.readFileSync(path.join(ROOT, 'js', 'tmp-clean.js'), 'utf8');

// 造一个沙箱作为 "tmpdir"
const sandbox = path.join(os.tmpdir(), 'vhtmp_test_' + Date.now());
fs.mkdirSync(sandbox, { recursive: true });

function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }
function mk(p, n) { fs.writeFileSync(p, 'x'.repeat(n || 100)); }

// 各命名空间的样本
mkdir(path.join(sandbox, 'vh_cx_111')); mk(path.join(sandbox, 'vh_cx_111', 'a.xml'), 1000);
mkdir(path.join(sandbox, 'vh_cx_222')); mk(path.join(sandbox, 'vh_cx_222', 'b.xml'), 2000);
mk(path.join(sandbox, 'vh_identify_1.wav'), 1100);
mk(path.join(sandbox, 'vh_identify_2.wav'), 1200);
mkdir(path.join(sandbox, 'ws_subtitle'));
mk(path.join(sandbox, 'ws_subtitle', 'mix_abc.wav'), 5000);
mk(path.join(sandbox, 'ws_subtitle', 'mix.wav'), 4000);
mk(path.join(sandbox, 'ws_subtitle', 'funasr_list.json'), 50);
mk(path.join(sandbox, 'vh_link_1.srt'), 300);
mk(path.join(sandbox, 'vh_check_1.json'), 200);
// 不该被碰的：无关文件/目录（注意 cep_dir_ 是插件自己的，属于应清范围）
mk(path.join(sandbox, 'other_file.txt'), 9999);
mkdir(path.join(sandbox, 'other_dir')); mk(path.join(sandbox, 'other_dir', 'keep.txt'), 8888);
mk(path.join(sandbox, 'unrelated_cep.txt'), 7777);   // 不带下划线，不应匹配 cep_dir_/cep_td_
mk(path.join(sandbox, 'cep_dir_in_123_456.ini'), 333);  // 插件自己的，应被清理

// 注入真实模块（把 os.tmpdir 指向沙箱）
const body = `
var fs = arguments[0], path = arguments[1], os = arguments[2];
var window = {};
var require = function(n){
  if (n === 'fs') return fs;
  if (n === 'path') return path;
  if (n === 'os') return os;
  throw new Error('require ' + n);
};
(function(){
${code}
})();
return window.__vhTmp;
`;
const T = new Function(body)(fs, path, { tmpdir: () => sandbox });

console.log('=== 1. scan：命名空间识别 ===');
const s1 = T.scan();
console.log('  识别到分组:', s1.groups.length);
s1.groups.forEach(g => {
  console.log('    ' + g.label.padEnd(14) + ' ' + String(g.count).padStart(2) + ' 项 / ' +
    String(g.files).padStart(2) + ' 文件 / ' + T.fmt(g.bytes));
});
console.log('  合计:', s1.total.n, '项 /', T.fmt(s1.total.bytes));

console.log('\n=== 2. 无关文件是否被误识别 ===');
const names = s1.groups.flatMap(g => g.items.map(i => i.name));
console.log('  other_file.txt 在内:', names.includes('other_file.txt'), '(期望 false)');
console.log('  other_dir 在内:', names.includes('other_dir'), '(期望 false)');
console.log('  cep_dir_ 前缀属插件产物，应被识别:', names.some(function (n) { return n.indexOf('cep_dir_') === 0; }), '(期望 true)');
console.log('  unrelated_cep.txt 在内:', names.includes('unrelated_cep.txt'), '(期望 false)');

console.log('\n=== 3. purge：执行清理 ===');
const r = T.purge();
console.log('  删除:', r.files, '个文件 /', r.dirs, '个目录 /', T.fmt(r.bytes));
r.groups.forEach(g => console.log('    ' + g.label.padEnd(14) + ' ' + g.files + ' 文件 / ' + T.fmt(g.bytes)));

console.log('\n=== 4. 清理后 ===');
const s2 = T.scan();
console.log('  剩余分组:', s2.groups.length, '(期望 0)');
console.log('  无关文件还在:', fs.existsSync(path.join(sandbox, 'other_file.txt')), '(期望 true)');
console.log('  无关目录还在:', fs.existsSync(path.join(sandbox, 'other_dir')), '(期望 true)');
console.log('  无关目录内容还在:', fs.existsSync(path.join(sandbox, 'other_dir', 'keep.txt')), '(期望 true)');
console.log('  unrelated_cep.txt 还在:', fs.existsSync(path.join(sandbox, 'unrelated_cep.txt')), '(期望 true)');
console.log('  ws_subtitle 目录还在:', fs.existsSync(path.join(sandbox, 'ws_subtitle')), '(期望 false)');

console.log('\n=== 5. 定向清理（只清某一类）===');
mk(path.join(sandbox, 'vh_identify_9.wav'), 500);
mkdir(path.join(sandbox, 'vh_cx_999')); mk(path.join(sandbox, 'vh_cx_999', 'z.xml'), 700);
const r2 = T.purge(['vh_identify_']);
console.log('  只清听歌识曲:', r2.files, '个文件 /', T.fmt(r2.bytes));
console.log('  听歌识曲已清:', !fs.existsSync(path.join(sandbox, 'vh_identify_9.wav')));
console.log('  vh_cx_999 保留:', fs.existsSync(path.join(sandbox, 'vh_cx_999')), '(期望 true)');

console.log('\n=== 6. 重入安全 ===');
T.purge();
const r3 = T.purge();
console.log('  再次清理:', r3.files, '个文件 (期望 0)');

// 收尾
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('\n沙箱已删除:', !fs.existsSync(sandbox));
