/* vh-Atelier · 调色 XML 回归测试
 * 用法：node test-flatten.js <原始.xml> [期望输出.xml]
 *
 * 无期望输出时只做自检（良构性 / 负值残留 / 连续性 / 来源正确性）。
 * 有期望输出时额外做逐段全字段对比。
 */
const fs = require('fs');
const path = require('path');
const API = require(path.join(__dirname, '..', 'js', 'flatten-xml.js'));

const raw = process.argv[2];
const expect = process.argv[3];
if (!raw) {
    console.log('用法: node test-flatten.js <原始.xml> [期望输出.xml]');
    process.exit(1);
}

const text = fs.readFileSync(raw, 'utf8');
let fails = 0;
function check(label, ok, extra) {
    console.log('  %s %s%s', ok ? '✓' : '✗', label, extra ? '  ' + extra : '');
    if (!ok) fails++;
}

console.log('=== 扫描 ===');
const s = API.scan(text);
if (s.error) { console.log('ERR', s.error); process.exit(1); }
console.log('  序列 %s  时长 %d  fps %s', s.seqName, s.duration, s.fps);
console.log('  视频轨 %d  音频轨 %d  音频片段 %d', s.tracks.length, s.audioTracks, s.audioClips);
for (const t of s.tracks) {
    console.log('   %-4s 片段%-4d 禁用%-3d 转场%-2d %s %s',
        t.label, t.clipCount, t.disabled, t.transitionCount,
        t.decor ? '[装饰:' + t.decorWhy + ']' : '        ',
        (t.sample || '').slice(0, 28));
}

const skip = s.tracks.filter(t => t.decor).map(t => t.index);
console.log('\n  装饰轨(自动预判): %s', skip.map(i => 'V' + (i + 1)).join(', ') || '(无)');

console.log('\n=== 处理 ===');
const r = API.flatten(text, { skipTracks: skip, dropTransitions: false });
if (!r.ok) { console.log('ERR', r.msg); process.exit(1); }
const st = r.stats;
console.log('  合轨片段 %d  时长 %d  删禁用 %d  清音频 %d  修引用 %d  残留引用 %d',
    st.mergedSegments, st.duration, st.droppedDisabled, st.droppedAudio,
    st.fixedFileRefs, st.danglingLeft);
console.log('  保留 %s   跳过 %s', st.keptTracks.join('/'), st.skippedTracks.join('/') || '-');

const outFile = path.join(path.dirname(raw), '_regress_out.xml');
fs.writeFileSync(outFile, r.text, 'utf8');

console.log('\n=== 自检 ===');
// 1. 负值残留
const negS = (r.text.match(/<start>-\d+<\/start>/g) || []).length;
const negE = (r.text.match(/<end>-\d+<\/end>/g) || []).length;
check('无 -1 边界残留', negS === 0 && negE === 0, `start=${negS} end=${negE}`);

// 2. 标签配平
function bal(tag) {
    const o = (r.text.match(new RegExp('<' + tag + '(?=[\\s>/])', 'g')) || []).length;
    const c = (r.text.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    const sf = (r.text.match(new RegExp('<' + tag + '[^>]*/>', 'g')) || []).length;
    return o === c + sf;
}
check('标签配平', ['xmeml', 'sequence', 'video', 'audio', 'track', 'clipitem'].every(bal));

// 3. 栈匹配
(function () {
    const stack = []; let bad = 0;
    const re = /<\/?([\w.:-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
    let m;
    while ((m = re.exec(r.text))) {
        if (m[0].startsWith('</')) { if (stack.pop() !== m[1]) bad++; }
        else if (m[3] !== '/') stack.push(m[1]);
    }
    check('XML 良构', stack.length === 0 && bad === 0, `未闭合=${stack.length} 错配=${bad}`);
})();

// 4. 结构
const s2 = API.scan(r.text);
const nonV1 = s2.tracks.filter(t => t.index > 0 && t.clipCount > 0);
check('仅 V1 有片段', nonV1.length === 0);
check('音频片段清空', s2.audioClips === 0, '剩 ' + s2.audioClips);
check('序列时长已重算', s2.duration === st.duration, `duration=${s2.duration}`);

// 5. 片段来源与连续性
const P = API.parse(r.text);
function k(n, t) { return (n.children || []).filter(c => c.tag === t); }
let seq = P.tag === 'sequence' ? P : k(P, 'sequence')[0];
let tr = k(k(k(seq, 'media')[0], 'video')[0], 'track')[0];
const cis = k(tr, 'clipitem');
const g = (ci, t) => { const n = k(ci, t)[0]; return n ? r.text.slice(n.contentStart, n.contentEnd).trim() : ''; };
const segs = cis.map(ci => ({ st: +g(ci, 'start'), en: +g(ci, 'end'), nm: g(ci, 'name') }))
    .sort((a, b) => a.st - b.st);

const trans = (function () {
    // 输出里的转场数（V1）
    const tts = k(tr, 'transitionitem');
    return tts.length;
})();

let gaps = 0, overlaps = 0, long = 0, missing = 0;
for (const sg of segs) {
    if (!sg.nm) missing++;
    if (sg.en - sg.st > 900) long++;
}
for (let i = 1; i < segs.length; i++) {
    const gap = segs[i].st - segs[i - 1].en;
    if (gap > 0.5) gaps++;
    else if (gap < -0.5) overlaps++;
}
check('无空隙', gaps === 0, '空隙 ' + gaps + ' 处');
check('重叠数 = 转场数', overlaps === trans, `重叠 ${overlaps} / 转场 ${trans}`);
check('无超长异常片段', long === 0, '超长 ' + long + ' 处');
check('片段字段齐全', missing === 0, '缺 ' + missing);
check('时间轴顺序正常', segs.every((x, i) => i === 0 || x.st >= segs[i - 1].st));

console.log('\n  输出: %s  (%d 段)', outFile, segs.length);

// 6. 与期望输出对比
if (expect && fs.existsSync(expect)) {
    console.log('\n=== 与期望输出逐段对比 ===');
    const ep = API.parse(fs.readFileSync(expect, 'utf8'));
    let eseq = ep.tag === 'sequence' ? ep : k(ep, 'sequence')[0];
    let etr = k(k(k(eseq, 'media')[0], 'video')[0], 'track')[0];
    const ecs = k(etr, 'clipitem');
    const etxt = fs.readFileSync(expect, 'utf8');
    const g2 = (ci, t) => { const n = k(ci, t)[0]; return n ? etxt.slice(n.contentStart, n.contentEnd).trim() : ''; };
    const esegs = ecs.map(ci => ({
        st: g2(ci, 'start'), en: g2(ci, 'end'), inV: g2(ci, 'in'),
        outV: g2(ci, 'out'), nm: g2(ci, 'name')
    }));
    const mine = segs.map(sg => { const ci = cis.find(c => +g(c, 'start') === sg.st); return { st: g(ci, 'start'), en: g(ci, 'end'), inV: g(ci, 'in'), outV: g(ci, 'out'), nm: g(ci, 'name') }; });
    let same = 0;
    const n = Math.min(mine.length, esegs.length);
    for (let i = 0; i < n; i++) {
        const a = mine[i], b = esegs[i];
        if (a.st === b.st && a.en === b.en && a.inV === b.inV && a.outV === b.outV && a.nm === b.nm) same++;
    }
    check('逐段全字段一致', same === n && mine.length === esegs.length,
        `${same}/${n} (我 ${mine.length} 段 / 期望 ${esegs.length} 段)`);
}

console.log('\n%s', fails === 0 ? '全部通过 ✓' : (fails + ' 项失败 ✗'));
process.exit(fails === 0 ? 0 : 1);
