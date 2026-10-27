/* 用真实文件系统验证清理逻辑：只删本功能的目录，不碰其他文件 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 直接提取 flatten-ui.js 里的清理函数做行为验证
const ROOT = 'F:/OH-WorkSpace/plugins/vh-Atelier/com.vh.atelier';
const code = fs.readFileSync(path.join(ROOT, 'js', 'flatten-ui.js'), 'utf8');

// 把需要的函数抽出来跑（避免整套 DOM 依赖）
function extract(name) {
  const re = new RegExp('(function ' + name + '\\s*\\([\\s\\S]*?\\n    \\})', 'm');
  const m = code.match(re);
  return m ? m[1] : null;
}

const TMP_PREFIX = 'vh_cx_';
const sandbox = path.join(os.tmpdir(), 'vh_cx_test_' + Date.now());
fs.mkdirSync(sandbox, { recursive: true });

// 构造：2 个本功能目录 + 1 个无关目录 + 1 个无关文件
const d1 = path.join(sandbox, 'vh_cx_111');
const d2 = path.join(sandbox, 'vh_cx_222');
const other = path.join(sandbox, 'someone_else');
fs.mkdirSync(d1); fs.mkdirSync(d2); fs.mkdirSync(other);
fs.writeFileSync(path.join(d1, 'a.xml'), 'x'.repeat(1000));
fs.writeFileSync(path.join(d1, 'FCP 转换结果.txt'), 'y'.repeat(500));
fs.writeFileSync(path.join(d2, 'b.xml'), 'z'.repeat(2000));
fs.writeFileSync(path.join(other, 'keep.txt'), 'do not delete');
fs.writeFileSync(path.join(sandbox, 'vh_cx_file.txt'), 'not a dir, keep');

// 注入真实函数（把 os.tmpdir 指向沙箱）
const body = `
var fs = arguments[0], path = arguments[1], os = arguments[2];
var TMP_PREFIX = ${JSON.stringify(TMP_PREFIX)};
${extract('rmTree')}
${extract('statTree')}
${extract('statTmp')}
${extract('purgeTmp')}
${extract('fmtSize')}
return { rmTree: rmTree, statTmp: statTmp, purgeTmp: purgeTmp, fmtSize: fmtSize };
`;
const api = new Function(body)(fs, path, { tmpdir: () => sandbox });

console.log('=== 清理前 ===');
let st = api.statTmp();
console.log('  本功能目录:', st.dirs, ' 文件:', st.files, ' 大小:', api.fmtSize(st.bytes));
console.log('  无关目录存在:', fs.existsSync(other));
console.log('  无关文件存在:', fs.existsSync(path.join(sandbox, 'vh_cx_file.txt')));

console.log('\n=== 执行清理 ===');
const r = api.purgeTmp();
console.log('  删除目录:', r.dirs, ' 文件:', r.files, ' 释放:', api.fmtSize(r.bytes));

console.log('\n=== 清理后 ===');
st = api.statTmp();
console.log('  剩余本功能目录:', st.dirs, '(期望 0)');
console.log('  vh_cx_111 还在:', fs.existsSync(d1), '(期望 false)');
console.log('  vh_cx_222 还在:', fs.existsSync(d2), '(期望 false)');
console.log('  无关目录还在:', fs.existsSync(other), '(期望 true)');
console.log('  无关目录内容还在:', fs.existsSync(path.join(other, 'keep.txt')), '(期望 true)');
console.log('  同名无关文件还在:', fs.existsSync(path.join(sandbox, 'vh_cx_file.txt')), '(期望 true，它是文件非目录)');

console.log('\n=== 空跑一次（重入安全）===');
const r2 = api.purgeTmp();
console.log('  再次清理:', r2.dirs, '个目录 (期望 0)');

// 清理测试沙箱
api.rmTree(sandbox);
fs.rmSync(sandbox, { recursive: true, force: true });
console.log('\n测试沙箱已删除:', !fs.existsSync(sandbox));
