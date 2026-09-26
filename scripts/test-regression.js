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
    ok('timeupdate 调 syncEpTimelineCurrent', /if \(!songMode\) syncEpTimelineCurrent\(\);/.test(bgm));
    // 高亮目标从旧 chip 改为 bgmMarkerBar 的子节点
    ok('高亮作用于 bgmMarkerBar 子节点', /var box = \$\('bgmMarkerBar'\)/.test(bgm));

    // 6) 无 BGM 时仍显示纯进度（不是整条隐藏）
    const det = bgm.slice(bgm.indexOf('function drawEpTimeline'));
    ok('无标记时仍显示进度条', /if \(!marks\.length\)[\s\S]{0,200}wrap\.style\.display = ''/.test(det));
}

// ============================================================
console.log('\n=== 附加：改动文件语法自检 ===');{
    const files = ['js/localsvc.js', 'js/errorlog.js', 'js/export.js', 'js/video.js',
                   'js/music.js', 'js/bgm.js', 'js/enhance.js', 'js/media.js', 'js/updater.js'];
    files.forEach(function (f) {
        let err = null;
        try { new Function(read(f)); } catch (e) { err = e.message; }
        ok(f + ' 语法可解析', !err, err || '');
    });
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
