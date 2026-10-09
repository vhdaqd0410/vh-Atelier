'use strict';
/**
 * 回归测试：锁定 vh-Atelier 累计踩过的坑。
 *
 * 覆盖本文件建立时（2026-09-26）新修的问题：
 *   坑 1：changelog.json 缺 version 字段 → 更新弹窗跨版本变更整段不显示
 *   坑 2：gmssl/sm2.py 硬依赖 Cryptodome → 该包无法精简
 *   坑 3：本地服务管理在三个板块各写一份 → 抽取 js/localsvc.js
 *   坑 4：关键链路失败只写界面不落盘 → 关掉面板就查不到原因
 *
 * 用法: node test-regression.js
 */

const fs = require('fs');
const path = require('path');
// scripts/ 下运行，上一级即插件根
const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  [OK]   ' + name); }
    else { fail++; console.log('  [FAIL] ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

// ============================================================
console.log('=== 坑 1：changelog 的 version 字段 ===');
{
    const cl = JSON.parse(read('changelog.json'));
    const vs = cl.versions || [];
    ok('changelog.json 可解析', Array.isArray(vs) && vs.length > 0, vs.length);

    // 版本比较函数与 updater.js 里 verGt 同源，用于验证 changelog 能被正确筛选
    function verNum(v) {
        return String(v || '0').replace(/^v/i, '').split('.').map(function (x) {
            const n = parseInt(x, 10); return isNaN(n) ? 0 : n;
        });
    }
    function verGt(a, b) {
        const A = verNum(a), B = verNum(b);
        const len = Math.max(A.length, B.length);
        for (let i = 0; i < len; i++) {
            const x = A[i] || 0, y = B[i] || 0;
            if (x > y) return true;
            if (x < y) return false;
        }
        return false;
    }

    const missing = vs.filter(function (v) { return !v.version; });
    ok('所有条目都有 version', missing.length === 0,
       '缺失 ' + missing.length + ' 条：' + missing.slice(0, 3).map(function (v) { return v.title; }).join(', '));

    const noDate = vs.filter(function (v) { return !v.date; });
    ok('所有条目都有 date', noDate.length === 0, '缺失 ' + noDate.length + ' 条');

    // 这台真因：version 为 undefined 时，verGt 会把它当 [0]，永远筛不出来，
    // 于是「从当前版本到最新版」的变更列表整段为空。
    const bad = vs.filter(function (v) { return verGt(v.version, '1.0.0') === false && verGt('9.9.9', v.version) === false; });
    ok('不存在被 verGt 静默漏掉的版本', bad.length === 0,
       '漏掉 ' + bad.length + ' 条');

    // 声明顺序应从新到旧（updater 依赖 readChangelog 的顺序做展示）
    const first = vs[0].version, last = vs[vs.length - 1].version;
    ok('首条版本高于末条', verGt(first, last), first + ' vs ' + last);

    // 每个条目必须有 title 与 items，否则弹窗渲染会出空块
    const broken = vs.filter(function (v) {
        return !v.title || !Array.isArray(v.items) || v.items.length === 0;
    });
    ok('每条都有 title 和 items', broken.length === 0, broken.length + ' 条不完整');

    // items 的 kind 必须是约定值（impro 为历史写法，渲染端已兼容）
    const KINDS = ['feat', 'fix', 'impr', 'impro', 'note'];
    const badKind = [];
    vs.forEach(function (v) {
        (v.items || []).forEach(function (it) {
            if (KINDS.indexOf(it.kind) < 0) badKind.push(v.version + ':' + it.kind);
        });
    });
    ok('items.kind 取值合法', badKind.length === 0, badKind.slice(0, 3).join(', '));
}

// ============================================================
console.log('\n=== 坑 1b：version.json 与 manifest 版本号一致 ===');
{
    const vj = JSON.parse(read('version.json'));
    const mf = read('CSXS/manifest.xml');
    const m = mf.match(/ExtensionBundleVersion="([^"]*)"/);
    ok('version.json 有 version', !!vj.version, vj.version);
    ok('manifest 有 ExtensionBundleVersion', !!m, m && m[1]);
    ok('两者一致', m && vj.version === m[1], (vj.version || '?') + ' vs ' + (m ? m[1] : '?'));
    ok('两个 Extension 条目都带版本号',
       (mf.match(/<Extension Id="[^"]+" Version="[^"]*"\/>/g) || []).length === 2);
    ok('CEP 版本未被误改', mf.indexOf('Version="6.0"') >= 0);
    ok('PPRO Host 版本未被误改', mf.indexOf('Version="12.0"') >= 0);
}

// ============================================================
console.log('\n=== 坑 2：gmssl/sm2.py 不硬依赖 Cryptodome ===');
{
    const p = path.join(ROOT, 'py', 'libs', 'gmssl', 'sm2.py');
    ok('sm2.py 存在', fs.existsSync(p));
    if (fs.existsSync(p)) {
        const s = fs.readFileSync(p, 'utf8');
        // 不能出现「裸的」Cryptodome 导入（必须包在 try/except 里或优先 Crypto）
        const naked = /^\s*from Cryptodome\./m.test(s) && !/try:\s*\n\s*from Crypto\./.test(s);
        ok('sm2.py 非裸导入 Cryptodome', !naked);
        ok('sm2.py 优先使用 Crypto', /try:\s*\n\s*from Crypto\.Util\.asn1/.test(s));
    }
    // 插件自有代码不应 import Cryptodome（flurl 走 Crypto.*）
    const flurlDir = path.join(ROOT, 'py', 'liushen', 'flurl');
    let bad = [];
    if (fs.existsSync(flurlDir) && fs.statSync(flurlDir).isDirectory()) {
        fs.readdirSync(flurlDir).filter(function (f) { return f.endsWith('.py'); }).forEach(function (f) {
            const s = fs.readFileSync(path.join(flurlDir, f), 'utf8');
            if (/^\s*(from|import)\s+Cryptodome/m.test(s)) bad.push(f);
        });
    }
    ok('flurl 不依赖 Cryptodome', bad.length === 0, bad.join(', '));
    // Cryptodome 包应已移出（重复副本）
    ok('冗余 Cryptodome 副本已移除',
       !fs.existsSync(path.join(ROOT, 'py', 'libs', 'Cryptodome')));
}

// ============================================================
console.log('\n=== 坑 3：本地服务管理共用 js/localsvc.js ===');
{
    const lp = path.join(JS, 'localsvc.js');
    ok('localsvc.js 存在', fs.existsSync(lp));
    const idx = read('index.html');
    ok('index.html 已引入 localsvc.js', idx.indexOf('js/localsvc.js') >= 0);

    // 加载顺序：localsvc 必须在三个使用方之前
    const order = ['js/localsvc.js', 'js/music.js', 'js/bgm.js', 'js/video.js']
        .map(function (s) { return idx.indexOf(s); });
    ok('localsvc 先于 music/bgm/video 加载',
       order[0] >= 0 && order[0] < order[1] && order[0] < order[2] && order[0] < order[3],
       JSON.stringify(order));

    // 三个板块应委托到共享模块
    ['bgm.js', 'music.js', 'video.js'].forEach(function (f) {
        const s = fs.readFileSync(path.join(JS, f), 'utf8');
        ok(f + ' 调用 __vhLocalSvc.create', /__vhLocalSvc\.create\(/.test(s));
        ok(f + ' api 委托 svc.api', /return svc\.api\(/.test(s));
        ok(f + ' ensureServer 委托', /return svc\.ensureServer\(/.test(s));
        // 不应再各自实现探活重试（旧实现里有 spawnXxx() + setTimeout 的固定组合）
        ok(f + ' 不再各自实现探活重试',
           !/return api\('\/health'\)\.then/.test(s));
    });

    const lv = fs.readFileSync(lp, 'utf8');
    ok('localsvc 导出 findNode 与 create',
       /window\.__vhLocalSvc\s*=\s*\{\s*findNode:\s*findNode,\s*create:\s*create/.test(lv));
    ok('localsvc 支持 healthTimeout 单独配置', /healthTimeout/.test(lv));
    ok('localsvc 支持 emptyAsObject 配置', /emptyAsObject/.test(lv));
    ok('localsvc 支持自定义错误文案', /errorStatusMessage/.test(lv) && /errorNetMessage/.test(lv));
}

// ============================================================
console.log('\n=== 附加：更新弹窗 kind 兼容 ===');
{
    const up = read('js/updater.js');
    // 与 changelog 里的 kind 约定保持一致：两种写法都要有标签与配色
    ['feat', 'fix', 'impr', 'impro', 'note'].forEach(function (k) {
        const inLabel = new RegExp(k + ": '").test(up);
        ok('KIND_LABEL 含 ' + k, inLabel);
    });
}

// ============================================================
console.log('\n=== 坑 4：关键链路失败落盘 ===');
{
    const el = read('js/errorlog.js');
    ok('errorlog 提供 bindUI', /bindUI:\s*function/.test(el));
    ok('bindUI 只在 err/warn 落盘', /errLevels\.indexOf/.test(el) && /warnLevels\.indexOf/.test(el));

    // 各关键板块应把失败写入 __vhLog
    const targets = [
        ['export.js', /__vhLog\.err\('\[export\]/, '导出'],
        ['video.js', /__vhLog\.err\('\[video\]/, '视频下载'],
        ['enhance.js', /__vhLog\.err\('\[enhance\]/, '超分/去字幕'],
        ['media.js', /__vhLog\.err\('\[media\]/, '素材导入'],
        ['bgm.js', /__vhLog\.err\('\[bgm\]/, '短剧扒歌']
    ];
    targets.forEach(function (t) {
        const s = fs.readFileSync(path.join(JS, t[0]), 'utf8');
        ok(t[2] + ' 失败落盘', t[1].test(s));
    });
}

// ============================================================
console.log('\n=== 坑 5：短剧扒歌播放器（反馈与控件）===');
{
    const idx = read('index.html');
    const bgm = read('js/bgm.js');

    // 1) 播放器不得再用原生 controls（与自制控制条重复，两套控件干同一件事）
    const videoTag = (idx.match(/<video[^>]*id="bgmV"[^>]*>/) || [''])[0];
    ok('bgmV 不再带原生 controls', videoTag !== '' && !/\bcontrols\b/.test(videoTag), videoTag.slice(0, 80));
    ok('bgmV 存在', videoTag !== '');

    // 2) 就绪前遮罩的四个必需元素
    ['bgmBuf', 'bgmBufMsg', 'bgmBufBarWrap', 'bgmBufFill', 'bgmBufSub', 'bgmBufCancel'].forEach(function (id) {
        ok('遮罩元素 ' + id + ' 存在', new RegExp('id="' + id + '"').test(idx));
    });

    // 3) 遮罩必须在播放器画面区内（否则盖不住视频）
    const stageIdx = idx.indexOf('bgm-player-stage');
    const bufIdx = idx.indexOf('id="bgmBuf"');
    const barIdx = idx.indexOf('id="bgmBar"');
    ok('bgmBuf 在 bgm-player-stage 内', stageIdx >= 0 && bufIdx > stageIdx && bufIdx < barIdx, `${stageIdx}/${bufIdx}/${barIdx}`);

    // 4) 控制条已挪入播放器，且带全屏按钮
    ok('bgmBar 已挪入播放器（在 bgmBuf 之后）', barIdx > bufIdx);
    ok('控制条含全屏按钮', /id="btnBgmBarFull"/.test(idx));
    ['btnBgmBarPlay', 'bgmBarVol', 'btnBgmBarPrev', 'btnBgmBarNext', 'btnBgmBarPick', 'btnBgmBarFull']
        .forEach(function (id) {
            ok('控制条含 ' + id, new RegExp('id="' + id + '"').test(idx));
        });
    // 进度条只有一条（画面下方那条），控制条内不再重复放进度条
    ok('控制条内无重复进度条', !/id="bgmBarSeek"/.test(idx));
    ok('控制条内无停止按钮（已并入播放/暂停）', !/id="btnBgmBarStop"/.test(idx));

    // 5) CSS 必须定义了遮罩与旋转动画
    const css = read('css/atelier.css');
    ok('CSS 有 .bgm-buf', /\.bgm-buf\s*\{/.test(css));
    ok('CSS 有旋转动画 keyframes', /@keyframes\s+bgm-buf-rotate/.test(css));
    ok('CSS 有 .bgm-buf-fill 进度色', /\.bgm-buf-fill\s*\{/.test(css));
    ok('CSS 有 .bgm-player-bar 覆盖', /\.bgm-player-bar\s*\{/.test(css));

    // 6) JS：关键行为必须存在
    ok('有 bufShow', /function bufShow\s*\(/.test(bgm));
    ok('有 bufHide', /function bufHide\s*\(/.test(bgm));
    ok('有 waitCanPlay（不再静默黑屏）', /function waitCanPlay\s*\(/.test(bgm));
    ok('waitCanPlay 监听 canplay', /addEventListener\('canplay'/.test(bgm));
    ok('waitCanPlay 监听 error', /addEventListener\('error'/.test(bgm));
    ok('有加载超时兜底', /加载超时|setTimeout\(function \(\) \{\s*\n\s*done\(false/.test(bgm));

    // 7) 关键回归：playLocal 不得再“load+play 一把梭、错误被吞”
    ok('playLocal 不再直接 load+play 吞错误', !/v\.load\(\); v\.play\(\)\.catch\(function \(\) \{\}\);/.test(bgm));
    // playLocal 应通过 waitCanPlay 接管就绪
    const pl = bgm.slice(bgm.indexOf('function playLocal'));
    ok('playLocal 调用 waitCanPlay', /waitCanPlay\(v, ep/.test(pl.slice(0, 2000)));

    // 7) 高亮 bug 防复发（曾经的坑）：重画色块后必须重置高亮缓存，
    //    否则 syncEpTimelineCurrent 会因缓存提前 return，新色块永远不亮。
    ok('drawEpTimeline 重画后重置 epTlCurId', /重建色块后必须重置高亮缓存/.test(bgm));
    ok('高亮态有放大效果（scaleY）', /\.bgm-mark\.is-current[\s\S]{0,300}scaleY/.test(css));
    ok('高亮态有白边+发光', /\.bgm-mark\.is-current[\s\S]{0,400}box-shadow[^;]*0 0 0 2px/.test(css));
    ok('容差为双向（前后都算）', /var TOL = 1\.5/.test(bgm) && /t < a\) \? \(a - t\)/.test(bgm));

    // 7) 气泡提示（代替原先盖在画面上的常驻信息块）
    ok('气泡元素存在', /id="bgmNowSong"/.test(idx));
    ok('气泡带 bgm-nsbub 类', /id="bgmNowSong" class="bgm-nsbub"/.test(idx));
    ok('气泡在进度条容器内', idx.indexOf('id="bgmNowSong"') > idx.indexOf('id="bgmProgWrap"'));
    ok('气泡在 foot（不在画面区）', idx.indexOf('id="bgmNowSong"') > idx.indexOf('bgm-player-foot'));
    ok('CSS 有 .bgm-nsbub', /\.bgm-nsbub\s*\{/.test(css));
    ok('气泡有入场态 is-in', /\.bgm-nsbub\.is-in/.test(css));
    ok('气泡有 transition 动画', /\.bgm-nsbub\s*\{[\s\S]{0,900}transition:/.test(css));
    ok('气泡默认收起（opacity 0）', /\.bgm-nsbub\s*\{[\s\S]{0,600}opacity:\s*0/.test(css));
    ok('旧 #bgmNowSong 常驻样式已清', !/#bgmNowSong\s*\{[^}]*border-left-width/.test(css));
    ok('tickOverlay 控制 is-in', /tickOverlay[\s\S]{0,2000}classList\.add\('is-in'\)/.test(bgm));
    ok('tickOverlay 播完收回', /classList\.remove\('is-in'\)/.test(bgm));
    ok('气泡靠右时改右对齐', /rightSide \? 'auto' : pct/.test(bgm));

    // 8) 点播放历史继续 -> 自动播放
    ok('resumeInto 有 autoPlay 参数', /function resumeInto\(ep, pos, autoPlay\)/.test(bgm));
    ok('点历史继续传 autoPlay=true', /resumeInto\(wantEp, wantPos, true\)/.test(bgm));
    ok('重开面板恢复不传 autoPlay（不自动播）', /resumeInto\(wantEp, st\.pos \|\| 0\);/.test(bgm));

    // 10) 剧集收藏
    ok('榜单行有收藏标签', /id="bgmFavTab"[^>]*data-kind="fav"/.test(idx));
    ok('JS 有 FAV_KEY', /var FAV_KEY = 'vh_bgm_fav_series'/.test(bgm));
    ok('JS 有 toggleFavSeries', /function toggleFavSeries\s*\(/.test(bgm));
    ok('JS 有 isFavSeries', /function isFavSeries\s*\(/.test(bgm));
    ok('JS 有 renderFavGrid', /function renderFavGrid\s*\(/.test(bgm));
    ok('JS 有 refreshFavCards', /function refreshFavCards\s*\(/.test(bgm));
    ok('loadHot 支持 fav 走本地', /hotKind === 'fav'/.test(bgm));
    ok('卡片渲染带 data-sid', /el\.setAttribute\('data-sid'/.test(bgm));
    ok('卡片渲染色含星标', /bgm-card-fav/.test(bgm));
    ok('星标点击不冒泡到卡片', /st\.addEventListener\('click'[\s\S]{0,120}stopPropagation/.test(bgm));
    ok('上限 200 条', /FAV_MAX = 200/.test(bgm));
    ok('CSS 有 .bgm-card-fav', /\.bgm-card-fav\s*\{/.test(css));
    ok('CSS 有已收藏金色态', /\.bgm-card-fav\.is-on/.test(css));

    // 11) 已下载页 + 剧集右键菜单
    ok('榜单行有已下载标签', /id="bgmDlTab"[^>]*data-kind="downloaded"/.test(idx));
    ok('JS 有 rebuildDlSeries（文件名反推聚合）', /function rebuildDlSeries\s*\(/.test(bgm));
    ok('聚合按 _<4位集号> 约定', /\/\^\(\.\*\)_\(\\d\{4\}\)/.test(bgm));
    ok('JS 有 dlEpsOf', /function dlEpsOf\s*\(/.test(bgm));
    ok('JS 有 renderDlGrid', /function renderDlGrid\s*\(/.test(bgm));
    ok('JS 有 delDlFiles', /function delDlFiles\s*\(/.test(bgm));
    ok('删除走 /local-delete', /post\('\/local-delete'/.test(bgm));
    ok('删除有二次确认', /function delDlFiles[\s\S]{0,300}confirm\(/.test(bgm));
    ok('JS 有 playDlEp', /function playDlEp\s*\(/.test(bgm));
    ok('JS 有 showSeriesMenu', /function showSeriesMenu\s*\(/.test(bgm));
    ok('卡片挂 contextmenu', /el\.addEventListener\('contextmenu'/.test(bgm));
    ok('菜单含下载该剧', /⬇ 下载该剧/.test(bgm));
    ok('JS 有 downloadWholeSeries', /function downloadWholeSeries\s*\(/.test(bgm));
    ok('下载该剧自动跳过已下载', /dlEpsOf\(info\.name/.test(bgm));
    ok('CSS 有 .bgm-dl-series', /\.bgm-dl-series\s*\{/.test(css));
    ok('CSS 有 .bgm-dl-ep', /\.bgm-dl-ep\s*\{/.test(css));
    // 服务端安全约束
    var srv = '';
    try { srv = read('bgm/server.js'); } catch (e) {}
    ok('服务端有 /local-delete', /p === '\/local-delete'/.test(srv));
    ok('服务端删除前校验路径在下载目录内', /insideVideoDir/.test(srv));
    ok('服务端拒绝目录外路径', /路径不在下载目录内/.test(srv));

    // 12) 弹窗 UI + 下载进度
    ok('有统一弹窗 bgmDialog', /var bgmDialog = \(function/.test(bgm));
    ok('弹窗有 confirm', /confirm: function \(opt\)/.test(bgm));
    ok('弹窗有 alert', /alert: function \(opt\)/.test(bgm));
    ok('不再用原生 confirm', !/[^.]\bconfirm\('确定删除/.test(bgm) && !/window\.confirm/.test(bgm));
    ok('CSS 有 .bgm-dlg-mask', /\.bgm-dlg-mask\s*\{/.test(css));
    ok('CSS 有 .bgm-dlg-btn.is-primary', /\.bgm-dlg-btn\.is-primary/.test(css));
    ok('CSS 有危险态', /\.bgm-dlg\.is-danger/.test(css));
    ok('CSS 有 toast 胶囊', /\.bgm-toast\s*\{/.test(css));
    ok('toast 有入场态', /\.bgm-toast\.is-in/.test(css));
    ok('flash 改用 toast host', /bgm-toast-host/.test(bgm));
    // 下载任务登记
    ok('有 dlJobs 登记表', /var dlJobs = \{\}/.test(bgm));
    ok('有 dlJobStart', /function dlJobStart\s*\(/.test(bgm));
    ok('有 dlJobProgress', /function dlJobProgress\s*\(/.test(bgm));
    ok('有 dlJobFinish', /function dlJobFinish\s*\(/.test(bgm));
    ok('有 seriesTotalOf', /function seriesTotalOf\s*\(/.test(bgm));
    // 进度汇总文案
    ok('进度含「第 N / 共 M 集」', /第 ' \+ ep \+ ' \/ 共 ' \+ ctx\.total \+ ' 集/.test(bgm));
    ok('进度含本集百分比', /本集 ' \+ pct \+ '%/.test(bgm));
    ok('副文案含已完成数', /已完成 ' \+ ctx\.done \+ ' \/ ' \+ ctx\.total/.test(bgm));
    ok('已下载页支持下载中卡片', /downloading\.forEach/.test(bgm));
    ok('下载中卡片有进度条', /bgm-dl-prog/.test(bgm) && /\.bgm-dl-prog/.test(css));
    ok('已下载显示 X/总 Y 集', /已下载 ' \+ item\.eps\.length \+ ' \/ ' \+ totalCnt/.test(bgm));

    // 13) 已下载页改封面卡片 + 详情视图
    ok('已下载用首页同款卡片类', /el\.className = 'bgm-grid-card'/.test(bgm));
    ok('卡片带 data-dlname', /el\.setAttribute\('data-dlname'/.test(bgm));
    ok('有封面占位块', /bgm-cover-ph/.test(bgm) && /\.bgm-cover-ph/.test(css));
    ok('有下载中徽标', /bgm-card-badge/.test(bgm) && /\.bgm-card-badge/.test(css));
    ok('有已下载标记', /bgm-card-dl-mark/.test(bgm) && /\.bgm-card-dl-mark/.test(css));
    ok('有剧元数据缓存', /var META_KEY = 'vh_bgm_series_meta'/.test(bgm));
    ok('有 rememberSeriesMeta', /function rememberSeriesMeta\s*\(/.test(bgm));
    ok('打开剧集页时记封面', /rememberSeriesMeta\(r\.data\.name, r\.data\)/.test(bgm));
    ok('下载时记封面', /rememberSeriesMeta\(info\.name \|\| it\.name, info\)/.test(bgm));
    ok('收藏时记封面', /rememberSeriesMeta\(it\.name, it\)/.test(bgm));
    // 详情视图
    ok('有详情容器 bgmDlDetail', /id="bgmDlDetail"/.test(idx));
    ok('JS 有 showDlDetail', /function showDlDetail\s*\(/.test(bgm));
    ok('JS 有 closeDlDetail', /function closeDlDetail\s*\(/.test(bgm));
    ok('点卡片进详情', /showDlDetail\(n\)/.test(bgm));
    ok('详情页有返回按钮', /id="btnBgmDlBack"/.test(idx));
    ok('详情页有删除该剧', /id="btnBgmDlDelAll"/.test(idx));
    ok('切标签时收起详情', /hotKind !== 'downloaded'[\s\S]{0,200}bgmDlDetail/.test(bgm));

    // 14) 详情页全集列表 + 勾选下载
    ok('有通用下载函数 downloadEps', /function downloadEps\s*\(/.test(bgm));
    ok('有选取下载 downloadPickedEps', /function downloadPickedEps\s*\(/.test(bgm));
    ok('有补全剧集信息 fillSeriesInfo', /function fillSeriesInfo\s*\(/.test(bgm));
    ok('整剧下载复用 downloadEps', /downloadEps\(info, miss\)/.test(bgm));
    ok('列表按总集数列出', /for \(var ep = 1; ep <= showTotal; ep\+\+\)/.test(bgm));
    ok('已下载行标记 is-have', /is-have/.test(bgm) && /\.bgm-dl-ep\.is-have/.test(css));
    ok('未下载行标记 is-missing', /is-missing/.test(bgm) && /\.bgm-dl-ep\.is-missing/.test(css));
    ok('集列表用紧凑格子（非一集一行）', /bgm-dl-grid/.test(bgm) && /\.bgm-dl-grid\s*\{/.test(css));
    ok('格子是数字网格布局', /grid-template-columns: repeat\(auto-fill/.test(css));
    ok('未下载格子可勾选', /is-picked/.test(bgm) && /\.bgm-dl-cell\.is-picked/.test(css));
    ok('已下载/未下载格子样式不同', /\.bgm-dl-cell\.is-have/.test(css) && /\.bgm-dl-cell\.is-missing/.test(css));
    ok('格子上有右键菜单', /function showCellMenu\s*\(/.test(bgm));
    ok('详情页不再用行式列表', !/bgm-dl-epno/.test(bgm.slice(bgm.indexOf('function showDlDetail'), bgm.indexOf('function downloadPickedEps'))));
    ok('有工具栏', /bgm-dl-toolbar/.test(bgm) && /\.bgm-dl-toolbar\s*\{/.test(css));
    ok('有「选未下载」', /bgmDlPickMissing/.test(bgm));
    ok('有「下载选中」', /bgmDlDownloadPicked/.test(bgm));
    ok('有「一键下载未下载」', /bgmDlDownloadMissing/.test(bgm));
    ok('下载前与本地比对（跳过已下载）', /have\.indexOf\(e\) >= 0[\s\S]{0,120}skipped\.push/.test(bgm));
    ok('比对后提示跳过数', /已下载，自动跳过/.test(bgm));

    // 15) 网盘板块（CloudDrive2 中转）
    ok('有网盘标签', /data-tab="netdisk"/.test(idx));
    ok('有网盘面板', /id="panel-netdisk"/.test(idx));
    ok('引入 netdisk.js', /js\/netdisk\.js/.test(idx));
    ok('main.js 接懒加载', /__netdiskOnShow/.test(read('js/main.js')));
    var nd = read('js/netdisk.js');
    ok('网盘走中转服务', /17896/.test(nd));
    ok('网盘有列目录', /\/list\?path=/.test(nd));
    ok('网盘有文件流', /\/file\?path=/.test(nd));
    ok('网盘下载到本地再导入', /downloadBatch/.test(nd) && /__mediaImportList/.test(nd));
    ok('网盘可插入时间线', /__mediaInsertToTimeline/.test(nd));
    ok('网盘按类型分素材箱', /kindOf/.test(nd) && /视频/.test(nd) && /音乐/.test(nd));
    ok('网盘有右键菜单', /showFileMenu/.test(nd));
    ok('复用素材的目录选择器', /__mediaPickFolder/.test(nd));
    ok('网盘可预览', /function openPreview/.test(nd));
    ok('预览用中转流地址', /\/stream\?path=/.test(nd));
    ok('预览按类型选元素', /nd-prev-video/.test(nd) && /nd-prev-img/.test(nd) && /nd-prev-audio/.test(nd));
    ok('双击预览', /dblclick/.test(nd));
    ok('网盘可拖拽', /dragstart/.test(nd) && /com\.adobe\.cep\.dnd\.file\.0/.test(nd));
    ok('未缓存时先下载再拖', /dragCache/.test(nd) && /首次拖拽需先下载/.test(nd));
    ok('CSS 有预览遮罩', /\.nd-prev-mask\s*\{/.test(css));
    ok('工具栏有预览按钮', /id="ndPreview"/.test(idx));

    // 8a) 网盘面板的 .md-* 布局规则必须与素材面板共享（否则树/文件区塌陷）
    ok('md- 规则对网盘生效', /:is\(#panel-media,#panel-netdisk\)/.test(css));
    ok('网盘工具条允许换行', /#panel-netdisk \.md-bar \{ flex-wrap: wrap/.test(css));
    ok('网盘树有最小宽度保护', /#panel-netdisk \.md-tree \{ min-width/.test(css));
    ok('网盘工具条提示不挤压按钮', /#panel-netdisk \.nd-hint/.test(css) && /nd-hint/.test(idx));

    // 8b) 网盘 = 树形（对齐素材浏览）
    ok('网盘为树形结构', /id="ndTree"/.test(idx) && /id="ndFList"/.test(idx));
    ok('网盘面板有左树右文件布局', /ndTree/.test(idx) && /ndFHead/.test(idx) && /ndDetail/.test(idx));
    ok('网盘树懒加载子节点', /function renderChildren/.test(nd) && /childrenCache/.test(nd));
    ok('网盘树可展开收起', /expanded\[/.test(nd) && /caret/.test(nd));
    ok('网盘单击选中/Ctrl多选', /ctrlKey/.test(nd) && /selFiles/.test(nd));
    ok('网盘点文件夹进列表', /selectDir\(it\.path/.test(nd));
    ok('网盘按类型分素材箱', /'视频'/.test(nd) && /'音乐'/.test(nd) && /'图片'/.test(nd));
    ok('网盘复用素材导入接口', /__mediaImportList/.test(nd) && /__mediaInsertToTimeline/.test(nd));
    ok('网盘管理界面走 iframe-nav', /ndManageWrap/.test(idx) && /id="ndFrame"/.test(idx));
    ok('网盘展开状态持久化', /vh_netdisk_expanded/.test(nd));

    // 8d) 歌曲色点必须在通用作用域（曾误锁进 .bgm-mini 导致正常模式不可见）
    ok('列表色点通用样式', /\.bgm-dot\s*\{/.test(css));
    ok('色点未被锁进小窗作用域', !/^\s*#bgmPlayerWrap\.bgm-mini \.bgm-dot\s*\{[\s\S]{0,60}width/s.test(css.replace(/^[^\n]*\n/m, '')));
    ok('色点有尺寸与圆形', /\.bgm-dot\s*\{[\s\S]{0,120}width:\s*8px[\s\S]{0,120}border-radius:\s*50%/.test(css));
    ok('列表色点用 songColor', /bgm-dot[\s\S]{0,80}songColor\(/.test(bgm));
    ok('进度条色块用 songColor', /bgm-mark[\s\S]{0,200}songColor\(|songColor\([^)]*\)[\s\S]{0,160}bgm-mark/.test(bgm) || /background[^\n]*songColor\(/.test(bgm));

    // 8c) 试听条独立（不再借视频播放器的进度条）
    ok('试听条独立于视频播放器', /id="bgmSongBar"/.test(idx));
    ok('试听条有进度与时间', /bgmSongFill/.test(idx) && /bgmSongCur/.test(idx) && /bgmSongDur/.test(idx));
    ok('试听条有播放/上下首/音量/收起', /btnBgmSongPlay/.test(idx) && /btnBgmSongNext/.test(idx) && /bgmSongVol/.test(idx) && /btnBgmSongClose/.test(idx));
    ok('syncSongBar 只驱动试听条', /function syncSongBar/.test(bgm) && /e\.fill\.style\.width/.test(bgm));
    ok('curMedia 只返回视频', /function curMedia\(\) \{\s*return \$\(.bgmV.\);/.test(bgm));
    ok('已无 songMode 双归属', !/songMode\s*=\s*(true|false)\s*;/.test(bgm));
    ok('试听条拖拽绑定', /function bindSongBarUI/.test(bgm) && /bgmSongProgHit/.test(bgm));
    ok('试听条上下首切换', /function songStep/.test(bgm));
    ok('试听条定位到视频', /btnBgmSongLoc/.test(idx) && /locateInVideo/.test(bgm));
    ok('CSS 有试听条样式', /\.bgm-songbar\s*\{/.test(css));

    // 9) 恢复播放进度（关面板后重开回到原位置）
    ok('saveUiState 存 playerOpen', /st\.playerOpen = /.test(bgm));
    ok('saveUiState 存 pos', /st\.pos = /.test(bgm));
    ok('currentTime 不可读时用 lastPlayPos 兜底', /st\.pos = ct > 1 \? ct : \(lastPlayPos \|\| 0\)/.test(bgm));
    ok('有 lastPlayPos 变量', /var lastPlayPos = 0/.test(bgm));
    ok('timeupdate 写 lastPlayPos', /lastPlayPos = v\.currentTime \|\| 0/.test(bgm));
    ok('写盘节流（不每帧写 localStorage）', /if \(now - lastPosSaveAt > 3000\)/.test(bgm));
    ok('restoreUiState 读 playerOpen', /st\.playerOpen && wantEp/.test(bgm));
    ok('restore 走 resumeInto', /resumeInto\(wantEp, st\.pos \|\| 0\)/.test(bgm));
    ok('有 resumeInto', /function resumeInto\s*\(/.test(bgm));
    ok('playLocal 支持 startAtPos/noAutoPlay', /function playLocal\(ep, startAtPos, noAutoPlay\)/.test(bgm));
    ok('恢复时不自动播（noAutoPlay 分支）', /if \(!noAutoPlay\)/.test(bgm));
    ok('closePlayer 清恢复标记', /closePlayer[\s\S]{0,900}lastPlayPos = 0/.test(bgm));
    ok('beforeunload 落盘兜底', /beforeunload[\s\S]{0,600}saveUiState/.test(bgm));
    ok('转码也透传位置', /startTranscodeFor\(ep, loc, startAtPos, noAutoPlay\)/.test(bgm));

    // 10) 播放历史（首页「接着看」）
    ok('首页有播放历史区', /id="bgmPlayHistWrap"/.test(idx) && /id="bgmPlayHist"/.test(idx));
    ok('播放历史在首页（bgmHome）内', idx.indexOf('id="bgmPlayHistWrap"') > idx.indexOf('id="bgmHome"'));
    ok('有清空按钮', /id="bgmPlayHistClear"/.test(idx));
    ok('CSS 有 .bgm-ph-item', /\.bgm-ph-item\s*\{/.test(css));
    ok('CSS 有进度条样式', /\.bgm-ph-prog/.test(css));
    ok('JS 有 PLAY_HIST_KEY', /var PLAY_HIST_KEY = 'vh_bgm_play_hist'/.test(bgm));
    ok('JS 有 addPlayHist', /function addPlayHist\s*\(/.test(bgm));
    ok('JS 有 updatePlayHistPos（不重排）', /function updatePlayHistPos\s*\(/.test(bgm));
    ok('JS 有 renderPlayHist', /function renderPlayHist\s*\(/.test(bgm));
    ok('JS 有 openPlayHist', /function openPlayHist\s*\(/.test(bgm));
    ok('上限 30 条', /PLAY_HIST_MAX = 30/.test(bgm));
    ok('播放时记历史', /addPlayHist\(\{[\s\S]{0,300}series_id: curSeries/.test(bgm));
    ok('进度节流更新历史', /updatePlayHistPos\(playEp, lastPlayPos/.test(bgm));
    ok('onShow 渲染历史', /renderPlayHist\(\);/.test(bgm));
    ok('清空按钮已绑定', /on\('bgmPlayHistClear'/.test(bgm));

    // 8) 点播未下载时要先亮遮罩
    const pe = bgm.slice(bgm.indexOf('function playEpisode'));
    ok('playEpisode 未下载时亮遮罩', /bufShow\('正在下载第 /.test(pe.slice(0, 700)));

    // 9) 死引用已清（bgmBarTitle 元素已随旧控制条移除）
    ok('无 bgmBarTitle 残留引用', !/bgmBarTitle/.test(bgm));
}

// ============================================================
console.log('\n=== 坑 6：扒歌播放器体验（交互与布局）===');
{
    const idx = read('index.html');
    const bgm = read('js/bgm.js');
    const css = read('css/atelier.css');

    // 1) 点击视频播放/暂停
    ok('绑定 video click 切换播放', /stage\.addEventListener\('click'/.test(bgm));

    // 2) BGM 时间轴叠在视频上
    ['bgmProgWrap', 'bgmPbarHit', 'bgmPbarFill', 'bgmPbarKnob', 'bgmPbarCur', 'bgmPbarDur', 'bgmMarkerBar']
        .forEach(function (id) {
            ok('进度条元素 ' + id + ' 存在', new RegExp('id="' + id + '"').test(idx));
        });
    // 进度条在画面下方（foot），不在画面之上 —— 用户明确要求去掉盖住画面的遮罩
    ok('进度条在 bgm-player-foot 内', idx.indexOf('id="bgmProgWrap"') > idx.indexOf('bgm-player-foot'));
    ok('视频上不再有叠加遮罩', !/id="bgmEpTimeline"/.test(idx));
    ok('CSS 有 .bgm-pbar', /\.bgm-pbar\s*\{/.test(css));
    ok('CSS 有已播填充', /\.bgm-pbar-fill\s*\{/.test(css));
    ok('CSS 有播放头', /\.bgm-pbar-knob/.test(css));
    ok('JS 有 drawEpTimeline', /function drawEpTimeline\s*\(/.test(bgm));
    ok('JS 有 syncEpTimelineCurrent', /function syncEpTimelineCurrent\s*\(/.test(bgm));
    ok('按真实区间定位（用 at/duration）', /\(\(m\.at \|\| 0\) \/ dur\) \* 100/.test(bgm));
    ok('timeupdate 同步高亮', /syncEpTimelineCurrent\(\);/.test(bgm));

    // 3) 下载后不抢焦点（视觉留在播放器）
    ok('renderSeries 支持下 noFocus 参数', /function renderSeries\(opt\)/.test(bgm));
    ok('renderSeriesNow 尊重 noFocus', /if \(!\(opt && opt\.noFocus\)\) focusSeries\(\)/.test(bgm));
    // 下载完成后的刷新必须传 noFocus
    const doneSection = bgm.slice(bgm.indexOf('剧集下载（含 file 的结果）'), bgm.indexOf('if (jobKind === \'batch\')'));
    ok('下载完成刷新不聚焦', /renderSeries\(\{ noFocus: true \}\)/.test(doneSection));
    ok('批量完成刷新不聚焦', /refreshLocal\(\)\.then\(function \(\) \{ if \(curSeries\) renderSeries\(\{ noFocus: true \}\)/.test(bgm));

    // 4) 选集按钮与浮层
    ok('控制条有选集按钮', /id="btnBgmBarPick"/.test(idx));
    ok('有选集浮层', /id="bgmEpPicker"/.test(idx) && /id="bgmEpPickerGrid"/.test(idx));
    ok('JS 有 toggleEpPicker', /function toggleEpPicker\s*\(/.test(bgm));
    ok('JS 有 renderEpPicker', /function renderEpPicker\s*\(/.test(bgm));
    ok('CSS 有 .bgm-eppick', /\.bgm-eppick\s*\{/.test(css));
    ok('CSS 有已下载/当前集态', /\.bgm-eppick-item\.is-local/.test(css) && /\.bgm-eppick-item\.is-cur/.test(css));

    // 5) 预加载下一集
    ok('JS 有 preloadNext', /function preloadNext\s*\(/.test(bgm));
    ok('预加载在就绪后触发', /setTimeout\(preloadNext/.test(bgm));
    ok('预加载只下不转（防争抢）', !/preloadNext[\s\S]{0,600}requestTranscode/.test(bgm.slice(bgm.indexOf('function preloadNext'))));

    // 6) playNav 改走遮罩，不再只靠 flash
    ok('playNav 改调 jumpToEp', /function playNav[\s\S]{0,400}jumpToEp\(ep\)/.test(bgm));
    ok('有 jumpToEp', /function jumpToEp\s*\(/.test(bgm));
    ok('jumpToEp 未下载时亮遮罩', /jumpToEp[\s\S]{0,600}bufShow\('正在下载第 /.test(bgm));
}

// ============================================================
console.log('\n=== 坑 7：播放进度条（合一：进度 + BGM 色块）===');
{
    const idx = read('index.html');
    const bgm = read('js/bgm.js');
    const css = read('css/atelier.css');

    // 1) 进度条是一整条（填充 + 色块层 + 播放头）
    ok('进度条含已播填充', /id="bgmPbarFill"/.test(idx));
    ok('进度条含色块层', /id="bgmMarkerBar"/.test(idx));
    ok('进度条含播放头', /id="bgmPbarKnob"/.test(idx));
    ok('进度条含左右时间', /id="bgmPbarCur"/.test(idx) && /id="bgmPbarDur"/.test(idx));

    // 2) updateBarFill 驱动新进度条
    const uf = bgm.slice(bgm.indexOf('function updateBarFill'));
    ok('updateBarFill 驱动 bgmPbarFill', /bgmPbarFill/.test(uf.slice(0, 700)));
    ok('updateBarFill 驱动播放头', /bgmPbarKnob/.test(uf.slice(0, 700)));

    // 3) 点击/拖动跳转接到新进度条
    ok('拖拽绑定在 bgmPbarHit', /var sk = \$\('bgmPbarHit'\)/.test(bgm));
    ok('不再引用旧 bgmBarSeek', !/bgmBarSeek/.test(bgm));

    // 4) 色块高亮（与旧叠加层一致的视觉）
    ok('色块有 is-current 高亮', /\.bgm-mark\.is-current/.test(css));
    ok('色块高亮用放大', /\.bgm-mark\.is-current[\s\S]{0,200}scaleY/.test(css));
    ok('色块高亮用白边发光', /\.bgm-mark\.is-current[\s\S]{0,300}box-shadow/.test(css));

    // 5) 高亮同步挂在 timeupdate
    ok('timeupdate 调 syncEpTimelineCurrent', /timeupdate[\s\S]{0,900}syncEpTimelineCurrent\(\);/.test(bgm) && !/!songMode\) syncEpTimelineCurrent/.test(bgm));
    // 高亮目标从旧 chip 改为 bgmMarkerBar 的子节点
    ok('高亮作用于 bgmMarkerBar 子节点', /var box = \$\('bgmMarkerBar'\)/.test(bgm));

    // 6) 无 BGM 时仍显示纯进度（不是整条隐藏）
    const det = bgm.slice(bgm.indexOf('function drawEpTimeline'));
    ok('无标记时仍显示进度条', /if \(!marks\.length\)[\s\S]{0,200}wrap\.style\.display = ''/.test(det));

    console.log('\n=== 坑 8：导出 AME 队列通道（不占用 PR 渲染）===');
    var expjs = read('js/export.js');
    var hostjsx = read('jsx/host.jsx');
    ok('AME 队列通道存在', /exportSequencesViaAme/.test(expjs));
    ok('逐版本「静音→入队」', /meMuteExcept[\s\S]{0,900}meEnqueueAME/.test(expjs));
    ok('全部入队后才开渲', /await exportOneSequence[\s\S]{0,1400}meStartBatch/.test(expjs));
    ok('AME 流程不调用 meExport', !/exportSequencesViaAme[\s\S]{0,2000}meExport\(/.test(expjs));
    ok('入队后恢复音轨', /meEnqueueAME[\s\S]{0,400}await unmute\(\)/.test(expjs));
    ok('宿主 encodeSequence 只入队', /encodeSequence\([^;]*(,\s*1|REMOVE_AFTER)\s*,\s*false\)/.test(hostjsx));
    ok('宿主有 meStartBatch', /function meStartBatch/.test(hostjsx));
    ok('宿主有 meLaunchEncoder', /function meLaunchEncoder/.test(hostjsx));
    ok('AME 事件经 CSXSEvent 派发', /new CSXSEvent\(\)/.test(hostjsx) && /com\.vh\.ameJob/.test(hostjsx));
    ok('面板监听 AME 事件', /addEventListener\('com\.vh\.ameJob'/.test(expjs));
    ok('AME 完成有文件兜底', /waitAmeJob/.test(expjs) && /'file'/.test(expjs));
    ok('渲染通道可切换', /id="rnd-ame"/.test(idx) && /id="rnd-pr"/.test(idx));
    ok('通道选择持久化', /vh_export_channel/.test(expjs));
    ok('PR 直渲仍保留', /meExport\(/.test(expjs) && /exportAsMediaDirect/.test(hostjsx));
    ok('CSS 有通道选择器', /\.rnd-opt\s*\{/.test(css));
    ok('默认走 AME', /localStorage\.getItem\(CH_KEY\) === 'pr' \? 'pr' : 'ame'/.test(expjs));
    ok('默认勾选 ame 单选', /id="rnd-ame"[^>]*checked/.test(idx));
    ok('ME 完成后保留历史', /REMOVE_AFTER = 0/.test(hostjsx) && /wa, REMOVE_AFTER, false/.test(hostjsx));
    ok('进度有心跳（已用时间自走）', /startProgTicker/.test(expjs) && /stopProgTicker/.test(expjs));
    ok('入队阶段不虚占进度', /var ENQ_END = 5;/.test(expjs) && /var RND_END = 99;/.test(expjs));
    ok('剩余时间按任务均速估算', /function estRemain/.test(expjs));
    ok('进度量纲自适应', /raw > 0 && raw <= 1\) \? raw \* 100 : raw/.test(expjs));

    console.log('\n=== 坑 9：素材浏览「我的电脑」盘符可展开 ===');
    var mjs = read('js/media.js');
    ok('盘符支持展开子目录', /ensureChildren\(node\)\.forEach\(walk\)/.test(mjs));
    ok('盘符树按 expandedSet 展开', /if \(expandedSet\[abs\]\)/.test(mjs));
    ok('盘符点击展开并刷右栏', /expandedSet\[abs\] = true;[\s\S]{0,240}renderFilePanel\(abs\)/.test(mjs));
    ok('盘符卷标有缓存', /_driveLabelsCache/.test(mjs));
    ok('卷标缓存命中不重跑', /if \(_driveLabelsCache\) \{ applyDriveLabels\(rows\); return; \}/.test(mjs));
    ok('卷标并发去重', /_driveLabelsPending/.test(mjs));
    ok('ensureChildren 支持 COMPUTER', /node\.abs === 'COMPUTER'/.test(mjs));

    console.log('\n=== 坑 10：扒歌下载可选保存目录（与音乐库同一弹窗）===');
    var bgmSel = read('js/bgm.js');
    var musSel = read('js/music.js');
    var srvSel = read('bgm/server.js');
    ok('有 pickSongDir', /function pickSongDir/.test(bgmSel));
    ok('起始目录取音乐库', /localStorage\.getItem\('mllibDir'\)/.test(bgmSel));
    ok('复用音乐库选择器', /window\.__vhPickDir/.test(bgmSel));
    ok('选择器已抽出公用', /function pickDirDialog/.test(musSel) && /window\.__vhPickDir = pickDirDialog/.test(musSel));
    ok('音乐库原行为保留', /function chooseDlDir\(cb\) \{\s*pickDirDialog/.test(musSel));
    ok('单个下载先选目录', /pickSongDir\(function \(dir\)/.test(bgmSel) && /doDownloadOneSong/.test(bgmSel));
    ok('批量下载先选目录', /downloadSelectedSongs[\s\S]{0,500}pickSongDir/.test(bgmSel));
    ok('下载请求带 dir', /body\.dir = dir/.test(bgmSel));
    ok('用户取消则中止', /if \(dir === null\) return;/.test(bgmSel));
    ok('服务端支持 dir', /paramDir \|\| musicDir\(\)/.test(srvSel));
    ok('服务端返回实际目录', /wantDir \|\| musicDir\(\)/.test(srvSel));

    console.log('\n=== 坑 11：含 iframe 面板切走不黑屏 ===');
    var mjs2 = read('js/main.js');
    ok('有 IFRAME_PANELS 名单', /IFRAME_PANELS/.test(mjs2));
    ok('名单含审片/超分/反馈/管理台', /shenpian: 1[\s\S]{0,90}upscale: 1[\s\S]{0,90}feedback: 1[\s\S]{0,90}admin: 1/.test(mjs2));
    ok('bgm 不在名单（小窗要常驻）', !/IFRAME_PANELS = \{[^}]*bgm/.test(mjs2));
    ok('iframe 面板切走保留布局', /IFRAME_PANELS\[key\][\s\S]{0,320}visibility = 'hidden'/.test(mjs2));
    ok('iframe 面板切走移出可视区', /left = '-99999px'/.test(mjs2));
    ok('普通面板仍 display:none', /display = 'none';/.test(mjs2) && /at-pane-hidden/.test(mjs2));
    ok('普通面板分支存在（无 iframe）', /el\.style\.display = 'none';/.test(mjs2));
    ok('切回时清隐藏态', /classList\.remove\('at-pane-hidden'\)/.test(mjs2));
    ok('切回后触发重排', /at-pane-hidden[\s\S]{0,900}dispatchEvent\(new Event\('resize'\)\)/.test(mjs2));
    ok('CSS 有 at-pane-hidden', /\.tab-panel\.at-pane-hidden/.test(css));

    console.log('\n=== 坑 12：影视板块已移除（改为红果短剧）===');
    var mj = read('js/main.js');
    var idx2 = read('index.html');
    ok('index.html 无影视面板 DOM', !/id="panel-movie"/.test(idx2));
    ok('index.html 无影视组按钮', !/data-group="movie"/.test(idx2));
    ok('index.html 无影视子tab', !/data-tab="movie"/.test(idx2));
    ok('index.html 无直播子tab', !/data-tab="mvlive"/.test(idx2));
    ok('index.html 不再引入 hls.js', !/hls\.light\.min\.js/.test(idx2));
    ok('index.html 不再引入 movie.js', !/js\/movie\.js/.test(idx2));
    ok('main.js 未注册影视面板', !/panel-movie/.test(mj));
    ok('main.js 未注册直播面板', !/panel-mvlive/.test(mj));
    ok('main.js 无影视分组', !/members:\s*\['movie'/.test(mj));
    ok('CSS 无影视样式', !/\.mv-card\s*\{/.test(css) && !/\.mv-catbar\s*\{/.test(css));
    ok('js/movie.js 已移除', !fs.existsSync(path.join(ROOT, 'js/movie.js')));
    ok('js/movie-sites.js 已移除', !fs.existsSync(path.join(ROOT, 'js/movie-sites.js')));
    ok('js/movie-live.js 已移除', !fs.existsSync(path.join(ROOT, 'js/movie-live.js')));
    ok('js/movie-tvbox.js 已移除', !fs.existsSync(path.join(ROOT, 'js/movie-tvbox.js')));
}

console.log('\n=== 坑 14：语音克隆三模式 + 音色库 ==='); {
    var cjs = read('js/clone.js');
    var cidx = read('index.html');
    var ccss = read('css/atelier.css');
    var ccli = read('py/cosyvoice_cli.py');
    // 三模式
    ok('有模式切换行', /id="modeRow"/.test(cidx));
    ok('三个模式按钮', (cidx.match(/class="vc-mode/g) || []).length >= 3);
    ok('JS 有模式状态机', /var mode = 'clone'/.test(cjs) && /function setMode/.test(cjs));
    ok('JS 传递 mode 给 CLI', /mode: mode,/.test(cjs));
    ok('cross 模式不传 ref_text', /mode === 'cross'\) \? '' : refText/.test(cjs));
    ok('指令输入框存在', /id="instructText"/.test(cidx));
    ok('指令常用词条', /id="instructChips"/.test(cidx) && /\.vc-chip/.test(ccss));
    ok('instruct 模式才显指令框', /instructWrap\.style\.display = \(mode === 'instruct'\)/.test(cjs));
    ok('cross 模式有提示块', /id="crossWrap"/.test(cidx));
    // 音色库
    ok('音色库下拉存在', /id="voiceLibSel"/.test(cidx));
    ok('保存/使用/删除按钮', /id="btnSaveVoice"/.test(cidx) && /id="btnUseVoice"/.test(cidx) && /id="btnDelVoice"/.test(cidx));
    ok('音色库存 localStorage', /vh_clone_voices/.test(cjs));
    ok('音色文件落到 collect/voices', /'collect', 'voices'/.test(cjs));
    ok('有保存/载入/删除实现', /function saveCurrentVoice/.test(cjs) && /function useVoice/.test(cjs) && /function delVoice/.test(cjs));
    ok('按钮可用性按模式算', /function updateCloneEnabled/.test(cjs));
    // CLI
    ok('CLI 支持三模式常量', /MODES = \('clone', 'instruct', 'cross'\)/.test(ccli));
    ok('CLI 有 instruct 分支', /inference_instruct2/.test(ccli));
    ok('CLI 有 cross 分支', /inference_cross_lingual/.test(ccli));
    ok('CLI 有 clone 分支', /inference_zero_shot/.test(ccli));
    // 关键：不使用 spk_id（实测会污染缓存 / 让 instruct 忽略指令）
    var cliCalls = ccli.split('\n').filter(function (l) { return /inference_/.test(l) && l.indexOf('#') !== 0 && l.indexOf('*') < 0; });
    ok('CLI 调用不传 zero_shot_spk_id', cliCalls.length > 0 && cliCalls.every(function (l) { return l.indexOf('zero_shot_spk_id') < 0; }), cliCalls.join(' | '));
    // 关键：指令必须包成官方格式，否则指令会被念出来
    ok('CLI 有官方指令前缀常量', /SYS_PREFIX\s*=\s*'You are a helpful assistant\.\s*'/.test(ccli));
    ok('CLI 有 endofprompt 标记', /EO_PROMPT\s*=\s*'<\|endofprompt\|>'/.test(ccli));
    ok('instruct 拼接前缀+标记', /SYS_PREFIX \+ instruct_text \+ EO_PROMPT/.test(ccli));
    ok('cross 拼接前缀+标记', /SYS_PREFIX \+ EO_PROMPT \+ tts_text/.test(ccli));
    ok('CSS 有模式按钮样式', /\.vc-mode\s*\{/.test(ccss) && /\.vc-mode\.active/.test(ccss));
}

// ============================================================
console.log('\n=== 坑 15：语音克隆结果行（波形/试听/拖拽/导入/插入）==='); {
    var rjs = read('js/clone.js');
    var ridx = read('index.html');
    var rcss = read('css/atelier.css');
    ok('有结果列表容器', /id="vcResultList"/.test(ridx));
    ok('结果列表复用 sep-res 外观', /class="sep-res-list"/.test(ridx));
    ok('行可拖拽', /row\.setAttribute\('draggable', 'true'\)/.test(rjs));
    ok('拖拽用 CEP DnD 协议', /com\.adobe\.cep\.dnd\.file\.0/.test(rjs));
    ok('试听按钮存在', /sep-res-play/.test(rjs) && /toggleVcPlay/.test(rjs));
    ok('波形用 wavesurfer', /WaveSurfer\.create/.test(rjs));
    ok('试听走 Blob 不用 file://', /vcReadAsBlob/.test(rjs) && /loadBlob/.test(rjs));
    ok('波形容器 sep-res-wave', /sep-res-wave/.test(rjs));
    ok('双击导入素材箱', /addEventListener\('dblclick'/.test(rjs));
    ok('生成后入列', /vcResults\.unshift/.test(rjs));
    ok('结果上限 30 条', /vcResults\.length > 30/.test(rjs));
    // 重构：不再有旧播放器元素
    ok('已移除旧试听按钮', !/id="btnPlay"/.test(ridx));
    ok('已移除旧 seekBar', !/id="seekBar"/.test(ridx));
    ok('无旧的 playerPanel 可见面板', /id="playerPanel" style="display:none;"/.test(ridx));
    ok('无 bindPlayerEvents', !/bindPlayerEvents/.test(rjs));
    ok('无 el.btnPlay 死引用', !/el\.btnPlay/.test(rjs));
    ok('无 el.btnImport 死引用', !/el\.btnImport\b/.test(rjs));
    // 重构：折叠区降低噪声
    ok('有折叠区 vc-fold', /class="vc-fold"/.test(ridx));
    ok('有分隔线 vc-sep', /class="vc-sep"/.test(ridx));
    ok('CSS 有 vc-fold 样式', /\.vc-fold/.test(rcss));
    ok('CSS 有 vc-sep 样式', /\.vc-sep/.test(rcss));
    ok('CSS 结果行兼容克隆面板', /:is\(#panel-sep, #panel-clone\) \.sep-res-/.test(rcss));
}

// ============================================================
console.log('\n=== 坑 16：音乐聚合（lxserver）集成 ==='); {
    var ajs = read('js/musicagg.js');
    var aui = read('js/musicagg-ui.js');
    var aidx = read('index.html');
    var amj = read('js/main.js');
    var aup = read('js/updater.js');
    var agi = read('.gitignore');
    var avj = read('version.json');
    ok('有音乐聚合面板 DOM', /id="panel-musicagg"/.test(aidx));
    ok('有音乐聚合子tab', /data-tab="musicagg"/.test(aidx));
    ok('面板内嵌 iframe', /id="maFrame"/.test(aidx));
    ok('引入两个模块', /js\/musicagg\.js/.test(aidx) && /js\/musicagg-ui\.js/.test(aidx));
    ok('main.js 注册面板', /musicagg: document\.getElementById\('panel-musicagg'\)/.test(amj));
    ok('归入声音组', /members: \['separate', 'clone', 'sfx', 'musiclib', 'music', 'musicagg', 'bgm'\]/.test(amj));
    ok('进 iframe 面板名单（切走不卸载）', /musicagg: 1/.test(amj));
    ok('懒加载钩子', /__musicAggOnShow/.test(amj));
    // 服务管理要点
    ok('端口 17899（避开 ncm/扒歌/视频下载）', /17899/.test(ajs));
    ok('用 node http/https 探活', /function probeUrl/.test(ajs) && /require\('https'\)/.test(ajs));
    ok('启动前清掉系统代理', /'HTTP_PROXY'/.test(ajs) && /delete env\[k\]/.test(ajs));
    ok('依赖缺失自动 npm install', /'install', '--omit=dev'/.test(ajs));
    ok('依赖判定用 module-alias/needle', /'module-alias'/.test(ajs) && /'needle'/.test(ajs));
    ok('播放器地址为根路径', /playerUrl: function \(\)/.test(ajs) && /return b \+ '\/'/.test(ajs));
    ok('暴露 __musicAgg', /window\.__musicAgg/.test(ajs));
    // 更新通道：node_modules/data/cache 不下发（防覆盖用户音源 + 防撑大更新包）
    ok('updater SKIP 含 node_modules', /'node_modules'/.test(aup));
    ok('updater SKIP 含 data', /'data'/.test(aup));
    ok('updater SKIP 含 cache', /'cache'/.test(aup));
    ok('gitignore 排除依赖', /lxserver\/node_modules\//.test(agi));
    ok('gitignore 排除用户数据', /lxserver\/data\//.test(agi));
    ok('skipDirs 含 node_modules', /"node_modules"/.test(avj));
    // 服务素材就位
    ok('lxserver 入口存在', fs.existsSync(path.join(ROOT, 'lxserver/index.js')));
    ok('lxserver 播放器存在', fs.existsSync(path.join(ROOT, 'lxserver/public/music/index.html')));
    ok('lxserver 服务端存在', fs.existsSync(path.join(ROOT, 'lxserver/server/server/server.js')));
    // 本地/服务器切换
    ok('有来源切换下拉', /id="maTarget"/.test(aidx));
    ok('有服务器地址输入', /id="maServerUrl"/.test(aidx));
    ok('支持 localStorage 记目标', /vh_musicagg_target/.test(ajs));
    ok('支持 localStorage 记服务器地址', /vh_musicagg_server/.test(ajs));
    ok('server 模式下不本地拉起', /target === 'server'/.test(ajs) || /t === 'server'/.test(ajs));
    // 状态小点：就绪变绿
    ok('状态点有 id', /id="maDot"/.test(aidx));
    ok('状态点 ok 变绿', /\.ma-dot\.ok/.test(read('css/atelier.css')));
    ok('状态点 err 变红', /\.ma-dot\.err/.test(read('css/atelier.css')));
    ok('JS 会切状态点样式', /dot\.className = 'ma-dot'/.test(aui));
    // 深色模式
    ok('有主题同步按钮', /id="btnMaTheme"/.test(aidx));
    ok('有主题探测与注入', /function isDark/.test(aui) && /vh-set-theme/.test(aui));
    // 音源包：导出 / 一键导入（本地模式）
    ok('有导出按钮', /id="btnMaExportSrc"/.test(aidx));
    ok('有导入按钮', /id="btnMaImportSrc"/.test(aidx));
    ok('JS 有导出实现', /function exportLocal/.test(ajs) && /function doExport/.test(ajs));
    ok('JS 有导入实现', /function importLocal/.test(ajs) && /function importServer/.test(ajs) && /function doImport/.test(ajs));
    ok('导入只收 js 脚本且同名不覆盖', /\.js/i.test(ajs) && /skipped/.test(ajs));
    ok('导入解压走 Expand-Archive', /Expand-Archive/.test(ajs));
    ok('导出走 Compress-Archive', /Compress-Archive/.test(ajs));
    ok('音源包暴露给 UI', /exportSources: doExport/.test(ajs) && /importSources: doImport/.test(ajs));
    ok('音源包两种模式都显示', /rowSrc\.style\.display = ''/.test(aui));
    ok('显示音源数量', /refreshSrcCount/.test(aui));
    // 服务器模式：导入走 upload 接口 + 需管理口令
    ok('有管理口令输入', /id="maAdminPwd"/.test(aidx));
    ok('口令由 localStorage 持久化', /vh_musicagg_admin/.test(ajs));
    ok('服务器导入走 custom-source/upload', /custom-source\/upload/.test(ajs));
    ok('服务器导入带 x-frontend-auth', /x-frontend-auth/.test(ajs));
    ok('服务器模式导出给明确指引', /网页/.test(ajs));
    ok('导入结果统计失败项', /failed\.push/.test(ajs));
}

// ============================================================
console.log('\n=== 坑 18：短剧扒歌下载选目录改用系统对话框 ==='); {
    var gjs = read('js/bgm.js');
    var gsrv = read('bgm/server.js');
    // 之前用音乐库树形弹窗（root 锁定，无法回上层）；现改系统原生文件夹选择器
    ok('/pick-dir 支持 desc 参数', /VHBGM_DESC/.test(gsrv));
    ok('/pick-dir 支持 startDir 初始目录', /VHBGM_START/.test(gsrv) && /Test-Path -LiteralPath \$env:VHBGM_START/.test(gsrv));
    ok('选歌曲目录走 /pick-dir', /pickSongDir[\s\S]{0,700}\/pick-dir/.test(gjs));
    ok('选歌曲目录默认音乐库', /musicLibStartDir\(\)[\s\S]{0,300}startDir/.test(gjs));
    ok('仍保留树形选择器作兜底', /__vhPickDir\(\{/.test(gjs));
}

// ============================================================
console.log('\n=== 坑 19：音源导入后默认启用 ==='); {
    var ssrv = read('lxserver/server/server/customSourceHandlers.js');
    var sag = read('js/musicagg.js');
    var sidx = read('index.html');
    ok('服务端上传即启用（不再默认禁用）', /enabled: true/.test(ssrv) && !/enabled: false, \/\/ 默认禁用/.test(ssrv));
    ok('导入后自动启用', /function enableRemote/.test(sag));
    ok('有「启用全部」按钮', /id="btnMaEnableAll"/.test(sidx));
    ok('启用全部实现（区分本地/服务器）', /function enableAllSources/.test(sag) && /listSourceIds/.test(sag));
    ok('本地走改 sources.json', /sources\.json/.test(sag));
    ok('服务器走 toggle 接口', /custom-source\/toggle/.test(sag));
}

// ============================================================
console.log('\n=== 坑 20：音乐聚合原生面板（简洁模式）==='); {
    var njs = read('js/musicagg-native.js');
    var nagg = read('js/musicagg.js');
    var nidx = read('index.html');
    var nui = read('js/musicagg-ui.js');
    var ncss = read('css/atelier.css');
    ok('有原生面板容器', /id="maNative"/.test(nidx));
    ok('有搜索框与按钮', /id="mv2Query"/.test(nidx) && /id="btnMv2Search"/.test(nidx));
    ok('有平台筛选', /id="mv2Platforms"/.test(nidx) && /mv2-pf/.test(nidx));
    ok('有结果列表', /id="mv2List"/.test(nidx));
    ok('有播放器（复用网易云控件）', /id="mv2Player"/.test(nidx) && /class="music-player/.test(nidx));
    ok('引入原生面板脚本', /js\/musicagg-native\.js/.test(nidx));
    ok('搜索走 search 接口', /\/api\/music\/search/.test(njs));
    ok('取直链走 url 接口', /\/api\/music\/url/.test(njs));
    ok('试听用 audio + 音频代理', /getAudio\(\)/.test(njs) && /proxyUrl/.test(njs));
    ok('下载走 download 接口', /\/api\/music\/download/.test(njs));
    ok('插入时间轴复用 vcInsert', /vcInsertToTimelineStr/.test(njs));
    ok('下载默认音乐库目录', /mllibDir/.test(njs));
    ok('有视图切换（简洁/播放器）', /id="maView"/.test(nidx) && /function setView/.test(nui));
    ok('视图选择持久化', /vh_musicagg_view/.test(nui));
    ok('切播放器才加载 iframe', /else loadPlayer\(false\)/.test(nui));
    ok('CSS 有原生面板样式', /\.mv2-wrap/.test(ncss) && /\.mv2-pf/.test(ncss) && /\.mv2-row/.test(ncss));
    // 首页：推荐歌单 + 榜单 + 热搜
    ok('有首页加载', /function loadHome/.test(njs));
    ok('首页拉榜单', /leaderboard\/boards/.test(njs));
    ok('首页拉歌单', /songList\/list/.test(njs));
    ok('首页拉热搜', /hotSearch/.test(njs));
    ok('榜单详情用 bangid', /leaderboard\/list\?source=[\s\S]{0,60}bangid=/.test(njs));
    ok('歌单详情接口', /songList\/detail/.test(njs));
    // 搜索类型
    ok('支持搜索类型切换', /id="mv2Type"/.test(nidx) && /curType === 'playlist'/.test(njs));
    ok('歌单搜索去重', /seen\[key\]/.test(njs));
    // 播放控件复用了网易云那套
    ok('播放器复用 music-player 结构', /class="music-player/.test(nidx) && /mp-ctrl/.test(nidx) && /mp-bar/.test(nidx));
    ok('播放器带音量/下载/插入', /id="mv2Vol"/.test(nidx) && /id="btnMv2Download"/.test(nidx) && /id="btnMv2Insert"/.test(nidx));
    ok('播放走音频代理', /function proxyUrl/.test(njs));
    ok('有播放队列与模式', /var playlist = \[\]/.test(njs) && /playMode/.test(njs));
    // 下载：选目录 + 记忆 + 资源管理器 + 拖拽
    ok('下载前选目录', /function pickDir/.test(njs) && /pick-dir/.test(njs));
    ok('目录记忆到 localStorage', /vh_musicagg_dl_dir/.test(njs));
    ok('可在资源管理器显示', /explorer\.exe.*\/select,/.test(njs));
    ok('可更改保存目录', /function moveFile/.test(njs));
    ok('下载完可拖进 PR', /com\.adobe\.cep\.dnd\.file\.0/.test(njs));
    ok('有行右键菜单', /function showRowMenu/.test(njs));
    // 命名
    ok('视图名为「简洁」无括号备注', /<option value="native">简洁<\/option>/.test(nidx));
    // 本轮修复：歌单点开一直加载中
    ok('歌曲渲染显式传容器（修加载中）', /function renderSongRows\(list, title, targetEl, options\)/.test(njs));
    ok('不再按 curType 猜容器', !/curType === 'playlist'\) \? \$\(mv2List\)/.test(njs));
    // 歌词
    ok('有歌词悬浮层', /id="mv2LyricFloat"/.test(nidx) && /id="mv2LyricBody"/.test(nidx));
    ok('有 LRC 解析', /function parseLrc/.test(njs));
    ok('歌词接口调用', /api\/music\/lyric/.test(njs));
    ok('歌词跟随进度高亮', /function syncLyric/.test(njs) && /syncLyric\(a.currentTime\)/.test(njs));
    ok('有歌词按钮', /id="btnMv2Lyric"/.test(nidx));
    // 播放列表
    ok('有播放列表面板', /id="mv2QueueBox"/.test(nidx) && /id="mv2Queue"/.test(nidx));
    ok('有队列渲染', /function renderQueue/.test(njs));
    ok('有队列按钮', /id="btnMv2Queue"/.test(nidx));
    // 目录选择统一为树形
    ok('选目录优先树形选择器', /__vhPickDir/.test(njs) && /typeof window\.__vhPickDir === 'function'/.test(njs));
    ok('CSS 有歌词样式', /\.mv2-lyric-line/.test(ncss));
    ok('CSS 有队列样式', /\.mv2-q-item/.test(ncss));
    // 本轮：返回 / 多选 / 整单下载 / 歌词悬浮 / 频谱
    ok('有返回按钮', /id="btnMv2Back"/.test(nidx) && /function goBack/.test(njs));
    ok('返回恢复上次搜索结果', /lastSearch/.test(njs));
    ok('切平台用每平台独立现场', /viewByPlatform/.test(njs) && /function snapshotView/.test(njs) && /function restoreView/.test(njs));
    ok('歌单行可多选', /id="mv2SheetList"/.test(nidx) && /pickable: true/.test(njs) && /function pickedSongs/.test(njs));
    ok('有全选', /function togglePickAll/.test(njs));
    ok('有下载选中', /id="btnMv2DlSel"/.test(nidx));
    ok('有下载整个歌单', /id="btnMv2DlAll"/.test(nidx) && /function downloadList/.test(njs));
    ok('整单下载串行且可停', /batchCancel/.test(njs) && /⏹ 停止/.test(njs));
    ok('歌词改悬浮层', /id="mv2LyricFloat"/.test(nidx) && /function toggleLyricFloat/.test(njs));
    ok('歌词层可关闭', /id="btnMv2LyricClose"/.test(nidx));
    ok('有频谱波形', /id="mv2WaveCanvas"/.test(nidx) && /function drawWave/.test(njs));
    ok('波形用 AudioContext 分析', /createAnalyser/.test(njs) && /getByteFrequencyData/.test(njs));
    // 本轮：进度条重排 + 毛玻璃歌词 + 封面大图 + 搜索历史 + 每平台独立现场
    ok('频谱与进度条同行', /class="mp-bar mv2-bar2"/.test(nidx) && /class="mv2-seekwrap"/.test(nidx));
    ok('封面可点击放大', /class="mp-cover" alt="" title=/.test(nidx) && /cov\.addEventListener\('click'/.test(njs));
    ok('歌词层左图右词', /mv2-lyric-left/.test(nidx) && /mv2-lyric-right/.test(nidx) && /id="mv2BigCover"/.test(nidx));
    // 毛玻璃：断言"两层都有 backdrop-filter"（不锁死具体数值，数值是可调的设计参数）
    ok('歌词层毛玻璃',
        /\.mv2-lyric-float\s*\{[^}]*backdrop-filter:\s*blur\(/.test(ncss) &&
        /\.mv2-lyric-card\s*\{[^}]*backdrop-filter:\s*blur\(/.test(ncss) &&
        /\.mv2-lyric-float\s*\{[^}]*webkit-backdrop-filter/.test(ncss));
    // 本轮：铺满面板 / 播放栏歌词 / 拖拽 / 音源导入登记 / 歌单平台能力
    // 浮层定位：改为按「面板矩形 − 播放器高度」实测设定（不再猜固定留白，
    // 固定留白对不上播放器随内容流变化的实际位置，就是之前错位的原因）
    ok('浮层位置由实测几何驱动',
        /function layoutLyricFloat/.test(njs) &&
        /getElementById\('panel-musicagg'\)/.test(njs) &&
        /getBoundingClientRect/.test(njs));
    ok('底部让出播放器高度（用渲染高度判定可见）',
        /r\.bottom - pr\.top/.test(njs) && /getComputedStyle\(player\)\.display/.test(njs));
    ok('不再用行内 style.display 判断播放器可见',
        !/player\.style\.display !== 'none'/.test(njs));
    ok('歌词区上下留白由 JS 按高度设 px',
        /lyr\.style\.paddingTop/.test(njs) && /lyr\.style\.paddingBottom/.test(njs));
    ok('CSS 不再用百分比 padding（按宽度解析会挤空歌词）',
        !/\.mv2-lyric-right\s+\.mv2-lyric\s*\{[^}]*padding:\s*45%/.test(ncss));
    // 窄面板适配：CEP 面板宽度下左右分栏会把歌词挤到 100 余像素
    ok('窄面板改上下布局', /\.mv2-lyric-float\.narrow \.mv2-lyric-card\s*\{[^}]*flex-direction:\s*column/.test(ncss));
    ok('窄面板左栏收到顶部一行', /\.mv2-lyric-float\.narrow \.mv2-lyric-left\s*\{[^}]*flex-direction:\s*row/.test(ncss));
    ok('按面板宽度决定是否窄布局', /needNarrow/.test(njs) && /classList\.add\('narrow'\)/.test(njs));
    // 播放器布局：窄面板按职责分四行，用 order 固定顺序
    ok('播放器分行且顺序固定', /\.mv2-player-box\s*\{[^}]*flex-wrap:\s*wrap/.test(ncss) && /order:\s*1/.test(ncss));
    ok('进度波形独占整行', /\.mv2-player-box \.mv2-bar2\s*\{[^}]*flex:\s*1 1 100%/.test(ncss));
    ok('行3音量与图标铺满对齐', /\.mv2-player-box \.mp-side\s*\{[^}]*flex:\s*1 1 100%/.test(ncss));
    // 歌词位置：放在歌名/专辑右侧（不再独占底部整行）
    ok('歌词在歌名右侧（不占整行）',
        /id="mv2BarLyric"/.test(nidx) &&
        !/mv2-barlyric-row/.test(nidx) &&
        /class="mp-meta"[\s\S]{0,500}?id="mv2BarLyric"/.test(nidx) &&
        /\.mp-lyric/.test(ncss));
    ok('歌名限宽避免挤掉歌词', /\.mv2-player-box \.mp-meta\s*\{[^}]*max-width:\s*40%/.test(ncss));
    ok('歌词吃剩余宽度', /\.mv2-player-box \.mp-lyric\s*\{[^}]*flex:\s*1 1 auto/.test(ncss));
    ok('歌词与歌名有分隔线', /\.mv2-player-box \.mp-lyric::after/.test(ncss));
    ok('播放栏歌词已放大', /\.mp-lyric\s*\{[^}]*font-size:\s*1[5-9]px/.test(ncss));
    ok('窗口变化时浮层重排', /addEventListener\('resize'[\s\S]{0,160}?layoutLyricFloat/.test(njs));
    ok('歌词区显式清除 max-height（否则被 168px 钉住）',
        /\.mv2-lyric-right\s+\.mv2-lyric\s*\{[^}]*max-height:\s*none/.test(ncss));
    ok('卡片可垂直撑满', /\.mv2-lyric-card\s*\{[^}]*min-height:\s*0/.test(ncss));
    ok('播放栏歌词容器存在', /id="mv2BarLyric"/.test(nidx) && /\.mp-lyric/.test(ncss));
    ok('播放栏歌词有开关按钮', /id="btnMv2BarLyric"/.test(nidx) && /function setBarLyric/.test(njs));
    ok('播放栏歌词开关持久化', /vh_musicagg_barlyric/.test(njs));
    ok('切歌即拉歌词（播放栏依赖）',
        /function updateNow[\s\S]{0,1400}?loadLyric\(s\);/.test(njs));
    ok('播放栏歌词只取首行（双语不撑高）',
        /function renderBarLyric[\s\S]{0,600}?\.split\(.{0,8}\)\[0\]/.test(njs));
    // 本轮：播放栏歌词动画与配色
    ok('播放栏歌词有渐变色', /\.mp-lyric\s*\{[^}]*background-clip:\s*text/.test(ncss));
    ok('播放栏歌词有换句动画', /@keyframes mpLyricSwap/.test(ncss) && /\.mp-lyric\.swap/.test(ncss));
    ok('播放栏歌词有呼吸竖条', /mpLyricPulse/.test(ncss));
    ok('换句才重播动画（同句不闪）', /var changed = \(text !== el\.textContent\)/.test(njs));
    // 本轮：歌单分享链接直接打开
    ok('可解析歌单分享链接', /function parsePlaylistInput/.test(njs) && /function extractPlaylistId/.test(njs));
    ok('覆盖各平台域名',
        /LINK_SOURCE_RULES/.test(njs) && /163cn/.test(njs) && /kugou/.test(njs) &&
        /kuwo/.test(njs) && /migu/.test(njs) && /qq/.test(njs));
    ok('歌单类型下链接直接打开', /var asList = \(\$\('mv2Type'\)/.test(njs) && /openSheet\(\{ id: parsed\.id/.test(njs));
    ok('支持分享文案里夹链接（正则抽链接）',
        njs.indexOf('s.match(/https?:\\/\\/[^\\s]+/i)') >= 0);
    // 本轮：搜索类型不随平台切换而变
    ok('切平台不改搜索类型', !/已切回单曲/.test(njs));
    ok('切平台读当前类型下拉', /curType = \(\$\('mv2Type'\) && \$\('mv2Type'\)\.value\) \|\| curType/.test(njs));
    ok('恢复现场不覆写类型下拉',
        /function restoreView[\s\S]{0,700}?var viewType = v\.type \|\| 'song'[\s\S]{0,300}?curType = \(ty0 && ty0\.value\)/.test(njs));
    ok('下载行创建即 draggable', /function attachRowDrag/.test(njs) && /row\.setAttribute\('draggable', 'true'\)/.test(njs));
    ok('拖拽查本地路径映射表', /function localPathOf/.test(njs) && /com\.adobe\.cep\.dnd\.file\.0/.test(njs));
    ok('下载完成写映射表（单首+批量）',
        (njs.match(/downloadedMap\[songKey\(s\)\] = saved/g) || []).length >= 2);
    ok('导入音源登记 sources.json（否则服务端扫不到）',
        /function extractScriptMeta/.test(njs) && /registered\(it\.name\)/.test(njs) ||
        /function extractScriptMeta/.test(nagg) && /registered\(it\.name\)/.test(nagg));
    ok('导入的音源默认启用', /enabled: true/.test(nagg));
    ok('歌单平台能力表', /PLAYLIST_OK/.test(njs) && /function platformSupportsPlaylist/.test(njs));
    ok('不支持歌单的平台给中文提示', /不支持歌单搜索/.test(njs));
    ok('有搜索历史', /id="mv2HistList"/.test(nidx) && /function addSearchHist/.test(njs));
    ok('历史可点击复搜', /doSearch\(kw\)/.test(njs));
    ok('历史可清空', /id="mv2HistClear"/.test(nidx) && /function clearHist/.test(njs));
    ok('每平台缓存上限', /MAX_VIEW_CACHE/.test(njs));
    ok('切新平台按当前输入词搜索', /var typed = .*mv2Query/.test(njs) && /doSearch\(typed\)/.test(njs));
    ok('清空输入框不被回填', /输入框是用户的现场/.test(njs) && !/q\.value = v\.kw/.test(njs));
}

// ============================================================
console.log('\n=== 附加：改动文件语法自检 ===');{
    const files = ['js/localsvc.js', 'js/errorlog.js', 'js/export.js', 'js/video.js',
                   'js/music.js', 'js/bgm.js', 'js/enhance.js', 'js/media.js', 'js/updater.js',
                   'js/progress.js', 'js/clone.js', 'js/musicagg.js', 'js/musicagg-ui.js'];
    files.forEach(function (f) {
        let err = null;
        try { new Function(read(f)); } catch (e) { err = e.message; }
        ok(f + ' 语法可解析', !err, err || '');
    });
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
