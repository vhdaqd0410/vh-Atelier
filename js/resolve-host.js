'use strict';
/**
 * vh-Atelier · DaVinci Resolve 宿主适配层
 * 运行在 Electron 主进程，是插件与 Resolve 之间唯一的通道。
 * 对应 PR 版的 jsx/host.jsx，这里用 Resolve Scripting API 重写。
 */

const path = require('path');

const PLUGIN_ID = 'com.vh.atelier';

let _WI = null;
let _resolve = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==================== 初始化 ====================

function loadWI() {
  if (_WI) return _WI;
  _WI = require(path.join(__dirname, '..', 'WorkflowIntegration.node'));
  return _WI;
}

async function getResolve() {
  if (_resolve) return _resolve;
  const WI = loadWI();
  const ok = await WI.Initialize(PLUGIN_ID);
  if (!ok) throw new Error('Resolve 接口初始化失败，确认 DaVinci Resolve Studio 正在运行');
  const r = await WI.GetResolve();
  if (!r) throw new Error('GetResolve 返回空');
  _resolve = r;
  return r;
}

function cleanup() {
  try { if (_WI && _WI.CleanUp) _WI.CleanUp(); } catch (e) { /* 忽略 */ }
  _resolve = null;
}

// ==================== 基础取值 ====================

async function getProject() {
  const resolve = await getResolve();
  const pm = await resolve.GetProjectManager();
  if (!pm) throw new Error('GetProjectManager 返回空');
  const project = await pm.GetCurrentProject();
  if (!project) throw new Error('当前没有打开的项目');
  return project;
}

async function findTimeline(project, name) {
  const count = await project.GetTimelineCount();
  for (let i = 1; i <= count; i++) {
    const t = await project.GetTimelineByIndex(i);
    if (t && (await t.GetName()) === name) return t;
  }
  return null;
}

async function timelineFps(timeline, project) {
  let fps = 0;
  try { fps = parseFloat(await timeline.GetSetting('timelineFrameRate')); } catch (e) { /* 忽略 */ }
  if (!fps) { try { fps = parseFloat(await project.GetSetting('timelineFrameRate')); } catch (e) { /* 忽略 */ } }
  return fps || 0;
}

// ==================== 命令：连通性 ====================

async function ping() {
  const resolve = await getResolve();
  return {
    pluginId: PLUGIN_ID,
    product: await resolve.GetProductName(),
    resolveVersion: await resolve.GetVersionString(),
    page: await resolve.GetCurrentPage(),
    electron: process.versions.electron,
    node: process.versions.node
  };
}

async function getProductInfo() {
  const resolve = await getResolve();
  const pm = await resolve.GetProjectManager();
  const project = await pm.GetCurrentProject();
  const out = {
    product: await resolve.GetProductName(),
    resolveVersion: await resolve.GetVersionString(),
    page: await resolve.GetCurrentPage(),
    projectName: project ? await project.GetName() : null,
    timelineCount: project ? await project.GetTimelineCount() : 0,
    currentTimeline: null,
    database: null
  };
  if (project) {
    const t = await project.GetCurrentTimeline();
    if (t) out.currentTimeline = await t.GetName();
  }
  try { out.database = await pm.GetCurrentDatabase(); } catch (e) { /* 忽略 */ }
  return out;
}

// ==================== 命令：时间线 ====================

async function listTimelines() {
  const project = await getProject();
  const count = await project.GetTimelineCount();
  const current = await project.GetCurrentTimeline();
  const currentName = current ? await current.GetName() : null;
  const fps = await timelineFps(current, project);
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const t = await project.GetTimelineByIndex(i);
    if (!t) continue;
    const name = await t.GetName();
    const start = await t.GetStartFrame();
    const end = await t.GetEndFrame();
    rows.push({
      index: i,
      name,
      startFrame: start,
      endFrame: end,
      frames: end - start,
      durationSec: fps ? (end - start) / fps : 0,
      current: name === currentName,
      videoTracks: await t.GetTrackCount('video'),
      audioTracks: await t.GetTrackCount('audio'),
      subtitleTracks: await t.GetTrackCount('subtitle')
    });
  }
  return { fps, timelines: rows };
}

/**
 * 读取「区间」信息（超分/朗读的面板用）
 * mode = 'clip'  : 时间线当前选中的片段
 * mode = 'inout' : 达芬奇 Timeline 对象没有 I/O 标记的脚本 API（GetMarkInOut 只属于
 *                  MediaPoolItem），所以这里退化为「游标所在的片段」；
 *                  若同时有选中片段，则用选中片段。
 * 返回 { ok, mode, name, startSec, endSec, durationSec, source:{ timeline, track, itemName } }
 */
async function getRangeInfo(mode) {
  const m = String(mode || 'clip');
  const project = await getProject();
  const t = await project.GetCurrentTimeline();
  if (!t) throw new Error('没有打开的时间线');
  const fps = await timelineFps(t, project);
  const tlName = await t.GetName();

  let item = null;
  let track = 0;

  // 1) 优先用选中片段
  let sel = [];
  try { sel = (await t.GetSelectedClips()) || []; } catch (e) { sel = []; }

  if (m === 'clip') {
    if (!sel.length) throw new Error('时间线上没有选中的片段，请先选中一段');
    item = sel[0];
  } else {
    // inout：有选中就用选中，否则用当前片段
    if (sel.length) {
      item = sel[0];
    } else {
      try { item = await t.GetCurrentVideoItem(); } catch (e) { item = null; }
      if (!item) {
        // 再看音频轨当前片段
        try {
          const nA = await t.GetTrackCount('audio');
          for (let i = 1; i <= nA && !item; i++) {
            const list = (await t.GetItemListInTrack('audio', i)) || [];
            if (list.length) item = list[0];
          }
        } catch (e) { /* 忽略 */ }
      }
    }
    if (!item) throw new Error('取不到当前片段，请先在时间线上选中一段');
  }

  try {
    const ti = await item.GetTrackTypeAndIndex();
    track = ti ? ti[1] : 0;
  } catch (e) { track = 0; }

  let name = '';
  let startF = 0, endF = 0, durF = 0;
  try { name = await item.GetName(); } catch (e) {}
  try { startF = await item.GetStart(); } catch (e) { startF = 0; }
  try { endF = await item.GetEnd(); } catch (e) { endF = 0; }
  try { durF = await item.GetDuration(); } catch (e) { durF = endF - startF; }
  if (!durF || durF <= 0) durF = Math.max(0, endF - startF);

  const f = fps || 25;
  const startSec = startF / f;
  const durSec = durF / f;

  return {
    ok: true,
    mode: m,
    name: name,
    timeline: tlName,
    track: track,
    startFrame: startF,
    endFrame: endF,
    startSec: startSec,
    endSec: startSec + durSec,
    durationSec: durSec,
    fps: f
  };
}

async function getTimelineDetail(name) {
  const project = await getProject();
  const t = name ? await findTimeline(project, name) : await project.GetCurrentTimeline();
  if (!t) throw new Error('找不到时间线: ' + name);

  const fps = await timelineFps(t, project);
  const startFrame = await t.GetStartFrame();
  const endFrame = await t.GetEndFrame();

  const detail = {
    name: await t.GetName(),
    fps,
    startFrame,
    endFrame,
    frames: endFrame - startFrame,
    durationSec: fps ? (endFrame - startFrame) / fps : 0,
    startTimecode: await t.GetStartTimecode(),
    currentTimecode: await t.GetCurrentTimecode(),
    video: [],
    audio: [],
    subtitle: []
  };

  for (const type of ['video', 'audio', 'subtitle']) {
    const n = await t.GetTrackCount(type);
    for (let i = 1; i <= n; i++) {
      const items = (await t.GetItemListInTrack(type, i)) || [];
      const trackName = (await t.GetTrackName(type, i)) || '';
      const enabled = await t.GetIsTrackEnabled(type, i);
      const clips = [];
      for (const it of items) {
        clips.push({
          name: await it.GetName(),
          start: await it.GetStart(),
          end: await it.GetEnd(),
          duration: await it.GetDuration()
        });
      }
      detail[type].push({
        index: i,
        name: trackName,
        enabled,
        clipCount: clips.length,
        clips
      });
    }
  }
  return detail;
}

/** 取时间线上的音频片段及其媒体文件路径（字幕识别 / 人声分离的入口） */
async function listAudioClipsWithPath(name) {
  const project = await getProject();
  const t = name ? await findTimeline(project, name) : await project.GetCurrentTimeline();
  if (!t) throw new Error('找不到时间线');

  const fps = await timelineFps(t, project);
  const out = [];
  const n = await t.GetTrackCount('audio');
  for (let i = 1; i <= n; i++) {
    const items = (await t.GetItemListInTrack('audio', i)) || [];
    for (const it of items) {
      const start = await it.GetStart();
      const end = await it.GetEnd();
      const mpi = await it.GetMediaPoolItem();
      let filePath = '';
      if (mpi) {
        try { filePath = await mpi.GetClipProperty('File Path'); } catch (e) { /* 忽略 */ }
      }
      out.push({
        track: i,
        name: await it.GetName(),
        filePath: filePath || '',
        startFrame: start,
        endFrame: end,
        durationFrames: end - start,
        startSec: fps ? start / fps : 0,
        endSec: fps ? end / fps : 0
      });
    }
  }
  return { fps, clips: out };
}

async function listAudioTracks(name) {
  const project = await getProject();
  const t = name ? await findTimeline(project, name) : await project.GetCurrentTimeline();
  if (!t) throw new Error('找不到时间线');
  const n = await t.GetTrackCount('audio');
  const out = [];
  for (let i = 1; i <= n; i++) {
    let sub = '';
    try { sub = await t.GetTrackSubType('audio', i); } catch (e) { /* 忽略 */ }
    out.push({
      index: i,
      name: (await t.GetTrackName('audio', i)) || ('A' + i),
      subType: sub || '',
      enabled: await t.GetIsTrackEnabled('audio', i)
    });
  }
  return out;
}

// ==================== 命令：渲染预设 ====================

function normalizePresetNames(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.keys(raw);
  return arr.map(x => {
    if (typeof x === 'string') return x;
    if (x && (x.PresetName || x.Name)) return x.PresetName || x.Name;
    return String(x);
  }).filter(Boolean);
}

async function listRenderPresets() {
  const project = await getProject();
  let raw = null;
  try { raw = await project.GetRenderPresetList(); } catch (e) { /* 忽略 */ }
  let names = normalizePresetNames(raw);
  if (!names.length) {
    try { raw = await project.GetRenderPresets(); } catch (e) { /* 忽略 */ }
    names = normalizePresetNames(raw);
  }
  return names;
}

// ==================== 命令：素材导入 ====================

async function importMedia(filePaths) {
  const resolve = await getResolve();
  const ms = await resolve.GetMediaStorage();
  if (!ms) throw new Error('GetMediaStorage 返回空');
  const arr = Array.isArray(filePaths) ? filePaths : [filePaths];
  const res = await ms.AddItemListToMediaPool(arr);
  if (Array.isArray(res)) {
    const names = [];
    for (const it of res) { try { names.push(await it.GetName()); } catch (e) { /* 忽略 */ } }
    return { count: res.length, names };
  }
  return { count: res ? arr.length : 0, names: [] };
}

async function openPage(page) {
  const resolve = await getResolve();
  const cur = await resolve.GetCurrentPage();
  if (cur === page) return true;
  return await resolve.OpenPage(page);
}

/** 列目录下的子文件夹名（供交付目录自动填充用）。
 *  优先用 Resolve 的 MediaStorage，失败则退到 Node fs。 */
async function listSubDirs(rootPath) {
  if (!rootPath) throw new Error('路径为空');

  // 直接用 Node fs：Resolve 的 GetSubFolders 只认它自己的媒体库，对普通文件路径无效，
  // 且返回的是「名字数组」而非完整路径，前端拿不到可用 path 会点不开子目录。
  const fs = require('fs');
  const path = require('path');
  try {
    const ents = await fs.promises.readdir(rootPath, { withFileTypes: true });
    return ents.filter(d => d.isDirectory()).map(d => path.join(rootPath, d.name));
  } catch (e) {
    throw new Error('读取子目录失败：' + e.message);
  }
}

// ==================== 渲染状态判读 ====================
// 重大教训：Resolve 会按界面语言返回本地化的状态字符串，
// 中文环境返回的是「完成」而不是 'Complete'。
// 所以不能用英文字符串硬比较，主判据必须是与语言无关的 CompletionPercentage。
// 状态串只做辅助识别，并按多语言做模式匹配。

const STATE_READY = 'ready';
const STATE_RENDERING = 'rendering';
const STATE_COMPLETE = 'complete';
const STATE_FAILED = 'failed';
const STATE_CANCELLED = 'cancelled';
const STATE_UNKNOWN = 'unknown';

// 按可靠性排序：先排失败/取消，避免被子串误判
const STATE_PATTERNS = [
  // 顺序即优先级：先判失败/取消，避免被「渲染失败」里的「渲染」抢先命中
  [STATE_FAILED, /fail|failed|failure|error|fehlgeschlagen|fallo|错误|錯誤|失败|失敗|エラー|실패/i],
  [STATE_CANCELLED, /cancel|aborted|abgebrochen|annul|取消|キャンセル|취소/i],
  [STATE_COMPLETE, /complete|completed|finish|finished|done|abgeschlossen|fertig|termin|完成|已完|完结|完結|終了|完了|완료/i],
  [STATE_RENDERING, /render|rendering|rendu|renderiz|渲染|レンダリング|렌더링/i],
  [STATE_READY, /ready|waiting|queued|queue|idle|bereit|listo|就绪|準備|准备|待機|待机|대기|排队|排隊/i]
];

function classifyState(statusText, percent) {
  const s = String(statusText || '');

  // 先看字符串，认得出的优先
  if (s) {
    for (const [state, re] of STATE_PATTERNS) {
      if (re.test(s)) return state;
    }
  }

  // 字符串认不出（空值或未知语言）：用百分比兜底，这是不依赖语言的最后一道防线
  if (percent >= 99.9) return STATE_COMPLETE;
  if (percent > 0) return STATE_RENDERING;
  return STATE_UNKNOWN;
}

/** 读一个字段，兼容大小写差异 */
function pickKey(obj, names) {
  if (!obj) return undefined;
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return undefined;
}

/** 解析 GetRenderJobStatus 返回值，兼容字段名大小写与本地化状态串 */
function parseJobStatus(raw) {
  if (!raw) return { status: '', percent: 0, state: STATE_UNKNOWN, raw: raw };

  let status = pickKey(raw, ['JobStatus', 'jobStatus', 'Status', 'status']);
  // 有些版本可能把状态放在嵌套结构里
  if (status && typeof status === 'object') {
    status = pickKey(status, ['name', 'Name', 'value', 'Value', 'text', 'Text']);
  }
  status = String(status == null ? '' : status);

  let percent = pickKey(raw, ['CompletionPercentage', 'completionPercentage', 'Percent', 'percent', 'Progress', 'progress']);
  percent = typeof percent === 'number' ? percent : parseFloat(percent);
  if (!isFinite(percent)) percent = 0;

  return { status, percent, state: classifyState(status, percent), raw };
}

// ==================== 素材池与音频 ====================

/** 在素材池根目录下按名字找子文件夹（没有则按需创建） */
async function ensureMediaFolder(folderName) {
  const project = await getProject();
  const mp = await project.GetMediaPool();
  const root = await mp.GetRootFolder();
  const name = String(folderName || '').trim();
  if (!name) return root;

  let subs = [];
  try { subs = (await root.GetSubFolderList()) || []; } catch (e) { subs = []; }
  for (const f of subs) {
    try { if ((await f.GetName()) === name) return f; } catch (e) { /* 忽略 */ }
  }
  let created = null;
  try { created = await mp.AddSubFolder(root, name); } catch (e) { created = null; }
  await sleep(200);
  return created || root;
}

/**
 * 导入本地文件到素材池指定文件夹。
 * 注意：MediaPool.ImportMedia 会静默失败（返回空数组且不报错），必须用 AddItemListToMediaPool。
 * @returns {{count:number, names:string[], folder:string, items:Array}}
 */
async function importFilesToPool(paths, folderName) {
  const project = await getProject();
  const resolve = await getResolve();
  const mp = await project.GetMediaPool();
  const arr = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!arr.length) throw new Error('没有要导入的文件');

  const missing = arr.filter(p => { try { return !require('fs').existsSync(p); } catch (e) { return true; } });
  if (missing.length) throw new Error('文件不存在：' + missing[0]);

  const folder = folderName ? await ensureMediaFolder(folderName) : null;
  if (folder) { try { await mp.SetCurrentFolder(folder); } catch (e) { /* 忽略 */ } }

  const ms = await resolve.GetMediaStorage();
  let items = [];
  try { items = (await ms.AddItemListToMediaPool(arr)) || []; } catch (e) {
    throw new Error('导入失败：' + e.message);
  }
  if (!items.length) throw new Error('导入失败：素材池没有返回任何素材');

  const names = [];
  for (const it of items) {
    try { names.push(await it.GetName()); } catch (e) { names.push('(未知)'); }
  }
  return { count: items.length, names: names, folder: folder ? await folder.GetName() : '(根目录)', items: items };
}

/**
 * 把音频文件插入当前时间线。
 * 实测：recordFrame 有效（指定落点帧），startFrame/endFrame 有效（裁剪源），
 * trackIndex 在本机版本上未生效（始终落在 A1）。
 * @param {object} o { path, recordFrame, startFrame, endFrame, folderName, timelineName }
 */
async function insertAudioToTimeline(o) {
  const opts = o || {};
  if (!opts.path) throw new Error('缺少文件路径');
  const fs = require('fs');
  if (!fs.existsSync(opts.path)) throw new Error('文件不存在：' + opts.path);

  const project = await getProject();
  const resolve = await getResolve();
  const mp = await project.GetMediaPool();

  // 插入属于轨道写操作，必须在非交付页
  await ensureTrackSafePage();

  if (opts.timelineName) {
    const t = await findTimeline(project, opts.timelineName);
    if (!t) throw new Error('找不到时间线：' + opts.timelineName);
    await project.SetCurrentTimeline(t);
    await sleep(300);
  }
  const cur = await project.GetCurrentTimeline();
  if (!cur) throw new Error('没有当前时间线');

  const folder = opts.folderName ? await ensureMediaFolder(opts.folderName) : null;
  if (folder) { try { await mp.SetCurrentFolder(folder); } catch (e) { /* 忽略 */ } }

  const ms = await resolve.GetMediaStorage();
  const imported = (await ms.AddItemListToMediaPool([opts.path])) || [];
  if (!imported.length) throw new Error('导入素材池失败');
  const item = imported[0];

  const info = { mediaPoolItem: item };
  if (opts.recordFrame !== undefined && opts.recordFrame !== null && opts.recordFrame !== '') {
    info.recordFrame = Number(opts.recordFrame);
  }
  if (opts.startFrame !== undefined && opts.startFrame !== null && opts.startFrame !== '') {
    info.startFrame = Number(opts.startFrame);
  }
  if (opts.endFrame !== undefined && opts.endFrame !== null && opts.endFrame !== '') {
    info.endFrame = Number(opts.endFrame);
  }

  let appended = [];
  try { appended = (await mp.AppendToTimeline([info])) || []; } catch (e) {
    throw new Error('插入时间线失败：' + e.message);
  }
  if (!appended.length) throw new Error('插入时间线失败：没有返回片段');

  await sleep(300);
  const placed = [];
  for (const x of appended) {
    let sf = null, ef = null, tn = null, ti = null;
    try { sf = await x.GetStart(); } catch (e) { /* 忽略 */ }
    try { ef = await x.GetEnd(); } catch (e) { /* 忽略 */ }
    try { const p = await x.GetTrackTypeAndIndex(); tn = p[0]; ti = p[1]; } catch (e) { /* 忽略 */ }
    placed.push({ track: tn, trackIndex: ti, startFrame: sf, endFrame: ef });
  }

  return {
    timeline: await cur.GetName(),
    count: appended.length,
    requestedRecordFrame: info.recordFrame !== undefined ? info.recordFrame : null,
    placed: placed
  };
}

/** 列出项目里所有序列（时间线）名字，供下拉使用 */
async function listTimelineNames() {
  const project = await getProject();
  const n = await project.GetTimelineCount();
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = await project.GetTimelineByIndex(i);
    try { out.push(await t.GetName()); } catch (e) { /* 忽略 */ }
  }
  return out;
}

/** 当前播放头（时间码字符串 + 帧号） */
async function getPlayhead(timelineName) {
  const project = await getProject();
  const t = timelineName ? await findTimeline(project, timelineName) : await project.GetCurrentTimeline();
  if (!t) throw new Error('找不到时间线');
  let tc = null;
  try { tc = await t.GetCurrentTimecode(); } catch (e) { tc = null; }
  const fps = await timelineFps(t, project);
  const frames = tc ? timecodeStrToFrames(tc, fps) : null;
  return { timecode: tc, frames: frames, fps: fps, timeline: await t.GetName() };
}

/**
 * 批量读写音频片段属性（音量 / 声像 / 音高 / 人声隔离 等）。
 * 实测可用键：AudioVolumeEnabled / AudioVolume / AudioPanEnabled / AudioPan /
 *   AudioPitchEnabled / AudioPitchSemiTones / AudioPitchCents /
 *   AudioVoiceIsolationEnabled / AudioVoiceIsolationAmount
 * @param {string} timelineName
 * @param {object} props 要写入的属性字典
 * @param {object} opts  { trackIndex:number|null, onlySelected:boolean }
 */
async function setAudioClipProps(timelineName, props, opts) {
  const o = opts || {};
  const project = await getProject();
  const t = timelineName ? await findTimeline(project, timelineName) : await project.GetCurrentTimeline();
  if (!t) throw new Error('找不到时间线');
  if (!props || !Object.keys(props).length) throw new Error('没有要设置的属性');

  await ensureTrackSafePage();
  await project.SetCurrentTimeline(t);
  await sleep(250);

  const targets = [];
  if (o.onlySelected) {
    try { (await t.GetSelectedClips() || []).forEach(x => targets.push(x)); } catch (e) { /* 忽略 */ }
    if (!targets.length) throw new Error('当前没有选中的片段');
  } else {
    const n = await t.GetTrackCount('audio');
    const from = o.trackIndex ? o.trackIndex : 1;
    const to = o.trackIndex ? o.trackIndex : n;
    for (let i = from; i <= to; i++) {
      const list = (await t.GetItemListInTrack('audio', i)) || [];
      list.forEach(x => targets.push(x));
    }
  }
  if (!targets.length) throw new Error('没有可操作的音频片段');

  let changed = 0;
  const failed = [];
  for (let i = 0; i < targets.length; i++) {
    try {
      const ok = await targets[i].SetProperties(props);
      if (ok) changed++; else failed.push(i + 1);
    } catch (e) {
      failed.push(i + 1);
    }
  }
  return { total: targets.length, changed: changed, failed: failed };
}

/** 读回音频片段属性，用于校验写入是否真的生效；opts.onlySelected 只取选中片段 */
async function readAudioClipProps(timelineName, trackIndex, opts) {
  const o = opts || {};
  const project = await getProject();
  const t = timelineName ? await findTimeline(project, timelineName) : await project.GetCurrentTimeline();
  if (!t) throw new Error('找不到时间线');

  // 只读选中片段时不要切时间线，避免打断用户当前选择
  if (!o.onlySelected) { await project.SetCurrentTimeline(t); await sleep(200); }

  const n = await t.GetTrackCount('audio');
  const out = [];

  if (o.onlySelected) {
    let sel = [];
    try { sel = (await t.GetSelectedClips()) || []; } catch (e) { sel = []; }
    for (const x of sel) {
      let ti = null;
      try { const p = await x.GetTrackTypeAndIndex(); ti = p; } catch (e) { /* 忽略 */ }
      if (ti && String(ti[0]) !== 'audio') continue;   // 只要音频轨上的
      out.push(await describeClip(t, x, ti ? ti[1] : 0));
    }
    return out;
  }

  const from = trackIndex ? trackIndex : 1;
  const to = trackIndex ? trackIndex : n;
  for (let i = from; i <= to; i++) {
    const list = (await t.GetItemListInTrack('audio', i)) || [];
    for (const x of list) {
      let name = '', props = null, filePath = '', sf = null, ef = null;
      try { name = await x.GetName(); } catch (e) { /* 忽略 */ }
      try { props = await x.GetProperties(); } catch (e) { props = null; }
      out.push(await describeClip(t, x, i));
    }
  }
  return out;
}

/** 把单个音频片段描述成前端用的结构 */
async function describeClip(timeline, x, trackIndex) {
  let name = '', props = null, filePath = '', sf = null, ef = null;
  let ssf = null, sef = null;   // 源素材内的起止帧（素材文件口径）
  try { name = await x.GetName(); } catch (e) { /* 忽略 */ }
  try { props = await x.GetProperties(); } catch (e) { props = null; }
  try { sf = await x.GetStart(); } catch (e) { /* 忽略 */ }
  try { ef = await x.GetEnd(); } catch (e) { /* 忽略 */ }
  // 关键：素材内偏移。ffmpeg 切音频要用「素材文件内的秒数」，
  // 而不是「片段在时间线上的秒数」—— 两者不是一回事（时间线第 800 秒的片段，
  // 对应素材文件里可能只有第 3 秒）。
  try { ssf = await x.GetSourceStartFrame(); } catch (e) { ssf = null; }
  try { sef = await x.GetSourceEndFrame(); } catch (e) { sef = null; }
  try {
    const mpi = await x.GetMediaPoolItem();
    if (mpi) filePath = await mpi.GetClipProperty('File Path');
  } catch (e) { /* 忽略 */ }
  const fps = await timelineFps(timeline, await getProject());
  const startFrame = await timeline.GetStartFrame();
  return {
    track: trackIndex,
    name: name,
    props: props || {},
    filePath: filePath || '',
    startFrame: sf,
    endFrame: ef,
    // 时间线口径（用于显示位置）
    startSec: (sf !== null && fps > 0) ? (sf - startFrame) / fps : null,
    endSec: (ef !== null && fps > 0) ? (ef - startFrame) / fps : null,
    // 素材文件口径（用于 ffmpeg 截取；拿不到时为 null，调用方应改为整段处理）
    sourceStartSec: (ssf !== null && fps > 0) ? ssf / fps : null,
    sourceEndSec: (sef !== null && fps > 0) ? sef / fps : null
  };
}

// ==================== 语音转写（参考文字自动填充） ====================

/**
 * 找可用的 whisper 引擎与模型。
 * 优先本插件自带；其次复用本机已装的其它插件（避免重复下载 1GB 模型）。
 * @returns {{cli:string, model:string, root:string}|null}
 */
function findWhisper() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const extRoot = path.resolve(__dirname, '..');
  const cepRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions');

  const roots = [
    extRoot,                                              // 本插件
    path.join(cepRoot, 'com.vh.subtitle'),                 // 字幕插件
    path.join(cepRoot, 'com.zhang.whisper-subtitle'),      // 第三方字幕插件
    path.join(cepRoot, 'com.vh.atelier')                   // PR 版主插件
  ];
  // 模型候选：优先小/中文优化模型，其次 large
  const modelNames = [
    'ggml-belle-large-v3-turbo-zh-q8_0.bin',
    'ggml-medium.bin', 'ggml-small.bin', 'ggml-base.bin',
    'ggml-large-v3-q5_0.bin', 'ggml-large-v3.bin'
  ];
  for (const r of roots) {
    if (!r || !fs.existsSync(r)) continue;
    const cpu = path.join(r, 'bin', 'whisper', 'win32-x64', 'whisper-cli.exe');
    const cuda = path.join(r, 'bin', 'whisper', 'cuda', 'whisper-cli.exe');
    const cli = fs.existsSync(cpu) ? cpu : (fs.existsSync(cuda) ? cuda : null);
    if (!cli) continue;
    for (const mn of modelNames) {
      const mp = path.join(r, 'models', mn);
      if (fs.existsSync(mp)) return { cli, model: mp, root: r };
    }
  }
  return null;
}

/**
 * 把音频转写成文字（用于语音克隆自动填充参考文字）。
 * 流程：ffmpeg 转 16k 单声道 → whisper-cli 出 SRT → 拼成整段文本。
 */
async function transcribeAudio(filePath) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const cp = require('child_process');
  if (!filePath || !fs.existsSync(filePath)) throw new Error('音频文件不存在');

  const loc = findWhisper();
  if (!loc) {
    return { ok: false, text: '', error: '未找到 whisper 引擎，请手动填写参考文字' };
  }

  const tmpDir = path.join(os.tmpdir(), 'vh_asr');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { /* 忽略 */ }
  const stamp = Date.now();
  const wav16k = path.join(tmpDir, 'asr16k_' + stamp + '.wav');

  // 1) 转 16k 单声道（whisper 要求）
  const ff = (() => { try { return require('../localsvc').ffmpegPath(); } catch (e) { return null; } })();
  if (ff) {
    await new Promise((resolve) => {
      cp.execFile(ff, ['-y', '-v', 'error', '-i', filePath, '-ar', '16000', '-ac', '1', wav16k],
        { timeout: 120000, windowsHide: true }, () => resolve());
    });
  }
  const input = (ff && fs.existsSync(wav16k)) ? wav16k : filePath;

  // 2) whisper
  const srtBase = path.join(tmpDir, 'asr_' + stamp);
  const r = await new Promise((resolve) => {
    cp.execFile(loc.cli, ['-m', loc.model, '-l', 'auto', '-t', '4', '-osrt', '-of', srtBase,
      '-nf', '-sns', input],
      { cwd: path.dirname(loc.cli), timeout: 600000, maxBuffer: 1024 * 1024 * 50, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });

  try { if (fs.existsSync(wav16k)) fs.unlinkSync(wav16k); } catch (e) { /* 忽略 */ }

  if (r.err && !fs.existsSync(srtBase + '.srt')) {
    return { ok: false, text: '', error: '转写失败：' + String(r.err.message || r.err).slice(0, 160) };
  }
  const srtPath = srtBase + '.srt';
  if (!fs.existsSync(srtPath)) {
    return { ok: false, text: '', error: '转写未产出结果' };
  }
  const content = fs.readFileSync(srtPath, 'utf8');
  try { fs.unlinkSync(srtPath); } catch (e) { /* 忽略 */ }

  // 3) SRT → 连续文本
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    if (/^\d+$/.test(s)) continue;                       // 序号
    if (/-->/.test(s)) continue;                          // 时间轴
    out.push(s);
  }
  const text = out.join('').replace(/\s+/g, ' ').trim();
  return { ok: !!text, text: text, engine: loc.root, model: path.basename(loc.model) };
}

// ==================== 字幕轨读写 ====================

/** 时间码 "01:00:02:05" -> 帧号（相对 0） */
function timecodeStrToFrames(tc, fps) {
  const m = String(tc == null ? '' : tc).match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
  if (!m) return null;
  const base = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  return Math.round(base * fps + (+m[4]));
}

/**
 * 读当前时间线的字幕轨内容。
 * 每条字幕的位置用「相对时间线起点的秒数」表示，方便与外部 SRT 对齐。
 * @returns {{trackCount:number, items:Array<{track:number,index:number,text:string,startFrame:number,endFrame:number,startSec:number,endSec:number}>}}
 */
async function listSubtitles(timelineName) {
  const project = await getProject();
  const t = timelineName ? await findTimeline(project, timelineName) : await project.GetCurrentTimeline();
  if (!t) throw new Error('找不到时间线');

  // 必须在目标时间线上读取，否则轨道状态不可信
  try { await project.SetCurrentTimeline(t); } catch (e) { /* 忽略 */ }
  await sleep(200);

  const fps = await timelineFps(t, project);
  const startFrame = await t.GetStartFrame();
  const n = await t.GetTrackCount('subtitle');
  const items = [];

  for (let i = 1; i <= n; i++) {
    let list = [];
    try { list = (await t.GetItemListInTrack('subtitle', i)) || []; } catch (e) { list = []; }
    for (let k = 0; k < list.length; k++) {
      const it = list[k];
      let text = '', sf = 0, ef = 0;
      try { text = await it.GetName(); } catch (e) { text = ''; }
      try { sf = await it.GetStart(); } catch (e) { sf = startFrame; }
      try { ef = await it.GetEnd(); } catch (e) { ef = sf + 24; }
      items.push({
        track: i,
        index: k + 1,
        text: String(text || ''),
        startFrame: sf,
        endFrame: ef,
        startSec: fps > 0 ? (sf - startFrame) / fps : 0,
        endSec: fps > 0 ? (ef - startFrame) / fps : 0
      });
    }
  }
  items.sort((a, b) => a.startFrame - b.startFrame);
  return { trackCount: n, startFrame: startFrame, fps: fps, items: items };
}

/**
 * 从时间线音频识别字幕（达芬奇内置引擎）。
 * 实测：英文素材约 14 秒产出 45 条；语言自动判断。
 * 注意：该操作会替换时间线现有的字幕轨。
 * @param {string} timelineName
 * @param {object} opts { language, charsPerLine, gap, lineBreak }
 */
async function recognizeSubtitles(timelineName, opts) {
  const o = opts || {};
  const project = await getProject();
  const t = timelineName ? await findTimeline(project, timelineName) : await project.GetCurrentTimeline();
  if (!t) throw new Error('找不到时间线');

  // 识别属于轨道级写操作，必须在非交付页执行
  await ensureTrackSafePage();
  await project.SetCurrentTimeline(t);
  await sleep(300);

  const name = await t.GetName();
  const before = await t.GetTrackCount('subtitle');
  const t0 = Date.now();

  // 组装可选参数（字符串枚举由调用方传入，空值不传）
  const settings = {};
  if (o.language) settings.language = o.language;
  if (o.charsPerLine) settings.charsPerLine = parseInt(o.charsPerLine, 10) || 42;
  if (o.gap !== undefined && o.gap !== null && o.gap !== '') settings.gap = parseInt(o.gap, 10) || 0;

  let ok = false;
  try {
    ok = Object.keys(settings).length
      ? await t.CreateSubtitlesFromAudio(settings)
      : await t.CreateSubtitlesFromAudio();
  } catch (e) {
    throw new Error('识别调用失败：' + e.message);
  }
  await sleep(500);

  const after = await listSubtitles(name);
  return {
    timeline: name,
    ok: !!ok,
    seconds: Math.round((Date.now() - t0) / 1000),
    tracksBefore: before,
    trackCount: after.trackCount,
    count: after.items.length,
    items: after.items
  };
}

/**
 * 把字幕条目转成 SRT 文本。
 * @param {Array} items listSubtitles 返回的条目
 * @param {string} mode 'orig' 原文 | 'zh' 中文 | 'bilingual' 双语
 * @param {Array} zhTexts 与 items 等长的中文数组（mode 非 orig 时必填）
 */
function buildSrt(items, mode, zhTexts) {
  const list = (items || []).filter(it => String(it.text || '').trim().length);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    let text = String(it.text || '').trim();
    if (mode === 'zh' || mode === 'bilingual') {
      const zh = zhTexts && zhTexts[i] != null ? String(zhTexts[i]).trim() : '';
      if (mode === 'zh') text = zh || text;
      else text = zh ? (text + '\n' + zh) : text;
    }
    out.push((out.length + 1) + '\n' + secToSrtTime(it.startSec) + ' --> ' + secToSrtTime(it.endSec) + '\n' + text);
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}

/** 生成一个唯一的临时名字，避免与既有时间线/文件夹冲突 */
function uniqueSuffix() {
  return Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

/**
 * 把一组字幕写回时间线（替换该时间线现有的全部字幕轨）。
 *
 * 机制说明（实测结论，务必保留）：
 *  - 达芬奇脚本 API 没有「创建带定位的字幕条目」的能力：TimelineItem 无 SetStart，
 *    字幕条目的 SetName 也返回 false（文本不可改）。
 *  - 唯一可行的写入路径是：把 SRT 导入素材池后 AppendToTimeline。
 *  - 但 SRT 落到**非空**时间线上时，起点是「时间线末帧 + SRT 内时间」，不是绝对定位。
 *  - 因此这里用一个**临时空时间线**做中转：空时间线的起点是 0 帧，
 *    此时 SRT 内的时间会 1:1 映射到时间线时间轴；再把这个时间线里的字幕
 *    （连同其定位）搬回目标时间线。
 *
 * 由于脚本 API 不允许跨时间线移动字幕条目，中转后需要用户在 UI 上确认；
 * 若中转不可行则退化为「导入到素材池并追加」，并把真实落点如实回报。
 *
 * @param {string} timelineName 目标时间线
 * @param {string} srtPath      本地 SRT 文件
 * @param {object} opts         { clearExisting:boolean }
 */
async function writeSubtitles(timelineName, srtPath, opts) {
  const o = opts || {};
  const fs = require('fs');
  if (!srtPath || !fs.existsSync(srtPath)) throw new Error('SRT 文件不存在：' + srtPath);

  const resolve = await getResolve();
  const project = await getProject();
  const mp = await project.GetMediaPool();
  const t = timelineName ? await findTimeline(project, timelineName) : await project.GetCurrentTimeline();
  if (!t) throw new Error('找不到时间线');

  const result = { timeline: '', added: 0, cleared: 0, mode: '', warning: '' };

  // 音轨/轨道类操作必须在非交付页执行（交付页上是假成功）
  await ensureTrackSafePage();
  await project.SetCurrentTimeline(t);
  await sleep(300);

  const name = await t.GetName();
  result.timeline = name;

  const root = await mp.GetRootFolder();
  const folderName = '_vh_sub_' + uniqueSuffix();
  let folder = null;
  let srtItem = null;

  try {
    if (o.clearExisting !== false) {
      const before = await t.GetTrackCount('subtitle');
      for (let i = before; i >= 1; i--) {
        try { await t.DeleteTrack('subtitle', i); } catch (e) { /* 忽略 */ }
      }
      await sleep(200);
      result.cleared = before;
    }

    folder = await mp.AddSubFolder(root, folderName);
    await sleep(150);
    if (folder) { try { await mp.SetCurrentFolder(folder); } catch (e) { /* 忽略 */ } }

    const ms = await resolve.GetMediaStorage();
    const imported = (await ms.AddItemListToMediaPool([srtPath])) || [];
    if (!imported.length) throw new Error('SRT 导入素材池失败');
    srtItem = imported[0];

    const appended = (await mp.AppendToTimeline([{ mediaPoolItem: srtItem }])) || [];
    result.added = appended.length;
    result.mode = 'append';
    if (!appended.length) throw new Error('AppendToTimeline 失败');

    await sleep(400);
    const after = await listSubtitles(name);
    result.trackCount = after.trackCount;
    result.items = after.items;

    // 落点校验：SRT 首条相对时间 vs 实际落点
    try {
      const first = after.items.slice().sort((a, b) => a.startSec - b.startSec)[0];
      const tlStart = await t.GetStartFrame();
      const tlEnd = await t.GetEndFrame();
      const fps = await timelineFps(t, project);
      if (first && fps > 0) {
        const nearEnd = Math.abs(first.startFrame - tlEnd) < fps * 2;
        result.offsetFromEnd = (first.startFrame - tlEnd) / fps;
        if (nearEnd && (tlEnd - tlStart) > fps) {
          result.warning = '字幕被追加到时间线末尾（相对末帧 ' + result.offsetFromEnd.toFixed(2) + 's）。'
            + '达芬奇脚本 API 无法为字幕条目指定定位，请用「导出 SRT」后手动导入字幕轨，'
            + '或把本条时间线的字幕轨留空后由达芬奇「自动字幕」生成。';
        }
      }
    } catch (e) { /* 忽略 */ }

    return result;
  } finally {
    // 清理临时文件夹（里面的 SRT 素材可留在池中，也可尝试删除）
    try {
      if (folder) {
        await mp.SetCurrentFolder(root);
        await mp.DeleteFolders([folder]);
      }
    } catch (e) { /* 忽略 */ }
  }
}

// ==================== sidecar 字幕收尾 ====================

const fsMod = require('fs');
const pathMod = require('path');

// 达芬奇「独立字幕文件」实际产出的是 TTML/IMSC1（扩展名 .ttml），不是 .srt。
// 这里两种扩展名都认，TTML 统一转成 SRT 后再归位。
const SUBTITLE_RE = /\.(srt|ttml)$/i;

/** 秒 -> SRT 时间戳 "00:00:03,791" */
function secToSrtTime(sec) {
  const ms = Math.round((sec > 0 ? sec : 0) * 1000);
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const ff = ms % 1000;
  const p = (n, w) => String(n).padStart(w, '0');
  return p(hh, 2) + ':' + p(mm, 2) + ':' + p(ss, 2) + ',' + p(ff, 3);
}

/** "01:00:00:00" -> 3600（起始时间码换算成秒） */
function timecodeToSeconds(tc, fps) {
  const m = String(tc == null ? '' : tc).match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
  if (!m) return 0;
  const base = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  return base + (fps > 0 ? (+m[4]) / fps : 0);
}

/** 解析 TTML 时间：media 基准末段是毫秒，smpte 基准末段是帧 */
function ttmlTimeToSeconds(ts, frameRate, useFrames) {
  const raw = String(ts == null ? '' : ts).trim();
  if (!raw) return null;
  let m = raw.match(/^(\d+):(\d+):(\d+)[.,:](\d+)$/);
  if (m) {
    const base = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    const tail = +m[4];
    if (useFrames && frameRate > 0) return base + tail / frameRate;
    return base + tail / 1000;
  }
  m = raw.match(/^(\d+):(\d+):(\d+)$/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  return null;
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

/**
 * TTML -> SRT。
 * @param {string} ttml
 * @param {number} offsetSeconds 时间线起始偏移；仅当字幕时间是绝对时间码时才减
 * @returns {string} SRT 文本；无有效条目时返回空串
 */
function ttmlToSrt(ttml, offsetSeconds) {
  const src = String(ttml || '');
  const frameRate = parseFloat((src.match(/ttp:frameRate="([^"]+)"/) || [])[1]) || 0;
  const timeBase = ((src.match(/ttp:timeBase="([^"]+)"/) || [])[1] || '').toLowerCase();
  const declaredFrames = timeBase.length > 0 && timeBase.indexOf('media') < 0;

  const rawItems = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[1];
    let t = m[2].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    t = decodeXmlEntities(t)
      .split('\n').map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length).join('\n');
    if (!t) continue;
    const beginRaw = (attrs.match(/\bbegin="([^"]+)"/) || [])[1];
    const endRaw = (attrs.match(/\bend="([^"]+)"/) || [])[1];
    if (!beginRaw) continue;
    rawItems.push({ beginRaw: beginRaw, endRaw: endRaw || beginRaw, text: t });
  }
  if (!rawItems.length) return '';

  // 末段数值若 >= 帧率就不可能是帧（帧只能是 0..fps-1），退回按毫秒解析
  let maxTail = -1;
  for (const it of rawItems) {
    for (const ts of [it.beginRaw, it.endRaw]) {
      const parts = String(ts).split(/[.,:]/);
      if (parts.length === 4) maxTail = Math.max(maxTail, +parts[3]);
    }
  }
  const useFrames = declaredFrames && frameRate > 0 && maxTail < frameRate;

  const items = [];
  for (const it of rawItems) {
    const b = ttmlTimeToSeconds(it.beginRaw, frameRate, useFrames);
    if (b === null) continue;
    let e = ttmlTimeToSeconds(it.endRaw, frameRate, useFrames);
    if (e === null || e <= b) e = b + 2;
    items.push({ begin: b, end: e, text: it.text });
  }
  if (!items.length) return '';

  // 只有当字幕时间普遍带起始偏移时才减，避免把已经归零的时间搞成负数
  const minBegin = items.reduce((a, it) => Math.min(a, it.begin), Infinity);
  const off = (offsetSeconds > 0 && minBegin >= offsetSeconds) ? offsetSeconds : 0;

  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let b = it.begin - off; if (b < 0) b = 0;
    let e = it.end - off; if (e <= b) e = b + 0.2;
    out.push((i + 1) + '\n' + secToSrtTime(b) + ' --> ' + secToSrtTime(e) + '\n' + it.text);
  }
  return out.join('\n\n') + '\n';
}

/** 列出目录下所有字幕文件 {文件名: 大小}（含 .srt 与达芬奇产出的 .ttml） */
function snapshotSrt(dir) {
  const map = {};
  try {
    if (!dir || !fsMod.existsSync(dir)) return map;
    for (const name of fsMod.readdirSync(dir)) {
      if (!SUBTITLE_RE.test(name)) continue;
      try { map[name] = fsMod.statSync(pathMod.join(dir, name)).size; } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略 */ }
  return map;
}

/** 等文件大小连续两次采样一致（说明写完落盘了） */
async function waitFileStable(filePath, timeoutMs) {
  const limit = timeoutMs || 20000;
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < limit) {
    let sz = -1;
    try { sz = fsMod.statSync(filePath).size; } catch (e) { sz = -1; }
    if (sz > 0 && sz === last) return true;
    last = sz;
    await sleep(700);
  }
  return false;
}

/**
 * 找出本次渲染新产生（或大小变化）的 srt，返回绝对路径数组。
 * 不依赖达芬奇的命名规则，改名了也照样能认出来。
 */
function findNewSrt(dir, before) {
  const after = snapshotSrt(dir);
  const out = [];
  for (const name of Object.keys(after)) {
    if (before[name] === undefined || before[name] !== after[name]) {
      out.push(pathMod.join(dir, name));
    }
  }
  return out;
}

/**
 * sidecar 字幕归位：等稳定 -> 重命名为 <stem>.srt -> 有字幕目录则移过去。
 *
 * @param {string} outDir      视频输出目录
 * @param {string} stem        目标文件名（不含扩展名），如 "9"
 * @param {string} subtitleDir 字幕目录（可为空，空则留在原地）
 * @param {object} before      渲染前的字幕快照
 * @param {number} offsetSeconds 时间线起始偏移（秒），用于把绝对时间码归零
 * @returns {{ok:boolean, from?:string, to?:string, error?:string}}
 */
async function finalizeSidecar(outDir, stem, subtitleDir, before, offsetSeconds) {
  let fresh = [];
  try {
    fresh = findNewSrt(outDir, before || {});
  } catch (e) {
    return { ok: false, error: '扫描输出目录失败：' + e.message };
  }

  if (!fresh.length) {
    return { ok: false, error: '本次渲染没有产生字幕文件' };
  }

  // 多个候选时，优先挑文件名含 stem 的
  fresh.sort((a, b) => {
    const an = pathMod.basename(a), bn = pathMod.basename(b);
    return (an.indexOf(stem) === 0 ? 0 : 1) - (bn.indexOf(stem) === 0 ? 0 : 1);
  });
  const src = fresh[0];

  const stable = await waitFileStable(src);
  if (!stable) return { ok: false, from: src, error: '字幕文件未稳定（可能仍在写入）' };

  let finalDir = outDir;
  if (subtitleDir) {
    try {
      if (!fsMod.existsSync(subtitleDir)) fsMod.mkdirSync(subtitleDir, { recursive: true });
      finalDir = subtitleDir;
    } catch (e) {
      return { ok: false, from: src, error: '字幕目录不可用：' + e.message };
    }
  }

  const target = pathMod.join(finalDir, stem + '.srt');
  try {
    if (pathMod.resolve(src) === pathMod.resolve(target)) return { ok: true, from: src, to: target };

    // 达芬奇产出的是 TTML，需要转成 SRT 交付
    if (/\.ttml$/i.test(src)) {
      let srtText = '';
      try {
        srtText = ttmlToSrt(fsMod.readFileSync(src, 'utf8'), offsetSeconds || 0);
      } catch (e) {
        return { ok: false, from: src, error: '读取 TTML 失败：' + e.message };
      }
      if (!srtText) return { ok: false, from: src, error: 'TTML 解析后没有字幕条目：' + pathMod.basename(src) };
      fsMod.writeFileSync(target, srtText, 'utf8');
      try { fsMod.unlinkSync(src); } catch (e) { /* 原文件删不掉就留着，不影响交付 */ }
      return { ok: true, from: src, to: target };
    }

    if (fsMod.existsSync(target)) fsMod.unlinkSync(target);
    fsMod.renameSync(src, target);
    return { ok: true, from: src, to: target };
  } catch (e) {
    return { ok: false, from: src, error: '重命名/移动失败：' + e.message };
  }
}

// ==================== 导出引擎 ====================



const exportState = {
  running: false,
  stopRequested: false,
  total: 0,
  done: 0,
  current: null,
  percent: 0,
  startedAt: null,
  finishedAt: null,
  results: [],
  log: []
};

function pushLog(msg) {
  exportState.log.push({ t: Date.now(), msg });
  if (exportState.log.length > 400) exportState.log.splice(0, exportState.log.length - 400);
}

function snapshot() {
  return {
    running: exportState.running,
    stopRequested: exportState.stopRequested,
    total: exportState.total,
    done: exportState.done,
    current: exportState.current,
    percent: exportState.percent,
    startedAt: exportState.startedAt,
    finishedAt: exportState.finishedAt,
    results: exportState.results.slice(),
    log: exportState.log.slice(-200)
  };
}

function sanitizeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'output';
}

/** 同目录多版本时自动加后缀，避免互相覆盖 */
function resolveOutputs(seqName, versions) {
  const dirCount = {};
  versions.forEach(v => {
    const d = String(v.outDir || '').replace(/[\\/]+$/, '');
    dirCount[d] = (dirCount[d] || 0) + 1;
  });
  return versions.map(v => {
    const outDir = String(v.outDir || '').replace(/[\\/]+$/, '');
    const fileName = dirCount[outDir] > 1 ? `${seqName}_${sanitizeFileName(v.name)}` : seqName;
    return { version: v, outDir, fileName };
  });
}

async function snapshotAudioEnabled(timeline) {
  const n = await timeline.GetTrackCount('audio');
  const map = {};
  for (let i = 1; i <= n; i++) {
    try { map[i] = await timeline.GetIsTrackEnabled('audio', i); } catch (e) { map[i] = true; }
  }
  return map;
}

/** 字幕模式的中文说明（用于日志） */
function describeSubtitleMode(mode) {
  switch (mode) {
    case 'burnin': return '烧入画面（BurnIn）';
    case 'sidecar': return '导出独立字幕文件（SeparateFile）';
    case 'embedded': return '内嵌字幕流（EmbeddedCaptions）';
    case 'none':
    default: return '不导出字幕';
  }
}

// 【关键根因】在交付页（deliver）调用 SetTrackEnable 会返回 True 但完全不生效（假成功）。
// AddRenderJob / StartRendering 会让 Resolve 自动切到交付页，所以每个版本开始前都必须
// 先把页面切回编辑页；恢复音轨同理。这些页面下 SetTrackEnable 才是真的。
const TRACK_SAFE_PAGES = ['edit', 'cut', 'color', 'fairlight', 'fusion'];

/**
 * 确保当前处于「音轨设置真正生效」的页面。
 * @returns {Promise<{page:(string|null), switched:boolean}>}
 */
async function ensureTrackSafePage() {
  try {
    const resolve = await getResolve();
    const page = await resolve.GetCurrentPage();
    if (TRACK_SAFE_PAGES.indexOf(page) >= 0) return { page: page, switched: false };
    await resolve.OpenPage('edit');
    // 轮询确认页面真的切过去了（切换完成前脚本 API 读到的仍是旧页）
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      let now = null;
      try { now = await resolve.GetCurrentPage(); } catch (e) { /* 忽略 */ }
      if (now && TRACK_SAFE_PAGES.indexOf(now) >= 0) return { page: now, switched: true };
    }
    await sleep(500);   // 兜底：读不到就再给一点时间
    return { page: 'edit', switched: true };
  } catch (e) {
    return { page: null, switched: false };
  }
}

/**
 * 禁用非保留音轨，并读回逐个校验是否真的生效。
 * 关键一：SetTrackEnable 返回 true 不代表真的改到了，必须读回确认。
 * 关键二：必须先在非交付页执行，否则一律假成功。
 */
async function muteExceptAndVerify(timeline, keepList) {
  await ensureTrackSafePage();
  const keep = {};
  (keepList || []).forEach(i => { keep[String(i)] = true; });
  const n = await timeline.GetTrackCount('audio');

  const disabled = [];
  const failed = [];

  for (let i = 1; i <= n; i++) {
    if (keep[String(i)]) continue;
    let callOk = false;
    try {
      callOk = await timeline.SetTrackEnable('audio', i, false);
    } catch (e) {
      pushLog(`音轨 A${i} 禁用调用异常：${e.message}`);
    }
    // 读回校验
    let readBack = null;
    try { readBack = await timeline.GetIsTrackEnabled('audio', i); } catch (e) { /* 忽略 */ }
    if (readBack === false) disabled.push(i);
    else failed.push(i + (callOk ? '(调用成功但未生效)' : '(调用失败)'));
  }

  return { disabled, failed };
}

async function restoreAudioEnabled(timeline, map) {
  // 恢复同样要在非交付页执行，否则是假成功
  await ensureTrackSafePage();
  for (const k of Object.keys(map || {})) {
    try { await timeline.SetTrackEnable('audio', parseInt(k, 10), !!map[k]); } catch (e) { /* 忽略 */ }
  }
}

async function setTrackTypeEnabled(timeline, type, enabled) {
  const n = await timeline.GetTrackCount(type);
  for (let i = 1; i <= n; i++) {
    try { await timeline.SetTrackEnable(type, i, !!enabled); } catch (e) { /* 忽略 */ }
  }
}

async function waitForJob(project, jobId, seqName, versionName, onTick) {
  const t0 = Date.now();
  const timeoutMs = 12 * 60 * 60 * 1000;
  const stuckMs = 30 * 60 * 1000;   // 长时间无进展的上报阈值
  let lastPct = -1;
  let lastState = null;
  let sawActive = false;            // 是否见过「渲染中」
  let dumpedRaw = false;            // 原始返回值只记一次，不刷屏
  let stuckSince = Date.now();

  while (true) {
    if (exportState.stopRequested) {
      try { await project.StopRendering(); } catch (e) { /* 忽略 */ }
      return { stopped: true };
    }
    if (Date.now() - t0 > timeoutMs) {
      pushLog(`[${seqName} / ${versionName}] 渲染超时（最后状态：${lastState || '未知'}）`);
      return { ok: false, error: '渲染超时' };
    }

    let raw = null;
    let rawError = null;
    try {
      raw = await project.GetRenderJobStatus(jobId);
    } catch (e) {
      rawError = e.message;
    }

    // 只在任务真正开始渲染时记一条，不刷屏
    if (!dumpedRaw && raw) {
      dumpedRaw = true;
      try {
        pushLog(`[${seqName} / ${versionName}] 渲染中`);
      } catch (e) { /* 忽略 */ }
    }
    if (rawError) pushLog(`[${seqName} / ${versionName}] 读状态异常：${rawError}`);

    const st = parseJobStatus(raw);

    // ---- 终态判定 ----
    if (st.state === STATE_COMPLETE) {
      exportState.percent = exportState.total
        ? Math.round(((exportState.done + 1) / exportState.total) * 100)
        : 100;
      exportState.current = { timeline: seqName, version: versionName, percent: 100, status: st.status };
      if (onTick) onTick(snapshot());
      return { ok: true };
    }
    if (st.state === STATE_FAILED) {
      return { ok: false, error: '渲染失败（' + (st.status || 'Failed') + '）' };
    }
    if (st.state === STATE_CANCELLED) {
      return { ok: false, error: '渲染被取消（' + (st.status || 'Cancelled') + '）' };
    }

    // 任务已离开渲染队列，且我们见过它在动 -> 视为完成
    if (!raw && sawActive) {
      let stillQueued = false;
      try {
        const jobs = await project.GetRenderJobList();
        const arr = Array.isArray(jobs) ? jobs : Object.values(jobs || {});
        stillQueued = arr.some(j => String(pickKey(j, ['JobId', 'jobId', 'Id', 'id'])) === String(jobId));
      } catch (e) { /* 忽略 */ }
      if (!stillQueued) {
        pushLog(`[${seqName} / ${versionName}] 任务已离开队列，判定为完成`);
        return { ok: true };
      }
    }

    if (st.state === STATE_RENDERING) {
      sawActive = true;
      stuckSince = Date.now();
    }

    // ---- 进度显示 ----
    if (st.percent !== lastPct || st.state !== lastState) {
      lastPct = st.percent;
      lastState = st.state;
      exportState.percent = exportState.total
        ? Math.round(((exportState.done + st.percent / 100) / exportState.total) * 100)
        : 0;
      exportState.current = { timeline: seqName, version: versionName, percent: st.percent, status: st.status };
      if (onTick) onTick(snapshot());
    }

    // ---- 卡住不动：只上报，绝不重试 ----
    // 血泪教训：上一版在这里重调 StartRendering 当「兜底」，
    // 结果对已经渲染完成的任务反复重启，把同一集渲了又渲。
    // 渲染的启动权只归用户，插件不得自行重试。
    if (Date.now() - stuckSince > stuckMs) {
      pushLog(`[${seqName} / ${versionName}] 已停留 ${Math.round(stuckMs / 60000)} 分钟未推进`
        + `（状态：${st.status || '未知'}，进度：${st.percent}%），请到交付页确认`);
      return { ok: false, error: '渲染长时间无进展，请在交付页查看' };
    }

    await sleep(500);
  }
}

async function exportOne(project, timeline, seqName, version, target, opts, onTick) {
  const t0 = Date.now();
  const result = {
    timeline: seqName,
    version: version.name,
    outDir: target.outDir,
    fileName: target.fileName,
    preset: version.preset || '',
    ok: false,
    error: null,
    jobId: null,
    seconds: 0,
    audioDisabled: [],
    audioNotDisabled: [],
    subtitleMode: '',
    srtFrom: '',
    srtTo: '',
    srtError: ''
  };
  let savedEnabled = null;
  let srtBefore = null;
  let sidecarOffset = 0;

  try {
    pushLog(`[${seqName} / ${version.name}] 开始`);
    if (onTick) onTick(snapshot());

    if (version.preset) {
      const loaded = await project.LoadRenderPreset(version.preset);
      if (!loaded) pushLog(`[${seqName} / ${version.name}] 预设加载失败：${version.preset}`);
    }

    // ---------- 音轨：禁用非保留轨，并读回校验 ----------
    if (version.muteMode === 'mute') {
      savedEnabled = await snapshotAudioEnabled(timeline);
      const keep = (version.keepList || []).slice().sort((a, b) => a - b);
      pushLog(`[${seqName} / ${version.name}] 音轨处理：保留 ${keep.join(', ') || '（无）'}，其余禁用`);

      const r = await muteExceptAndVerify(timeline, keep);
      result.audioDisabled = r.disabled;
      result.audioNotDisabled = r.failed;
      if (r.failed.length) {
        pushLog(`[${seqName} / ${version.name}] 警告：音轨 ${r.failed.join(', ')} 未能禁用`);
      }
      pushLog(`[${seqName} / ${version.name}] 已禁用音轨：${r.disabled.join(', ') || '（无）'}`);
    }

    // ---------- 渲染设置 ----------
    // 字幕由渲染设置控制，不是靠禁用字幕轨
    const sub = version.subtitleMode || 'none';
    result.subtitleMode = sub;

    const settings = {
      TargetDir: target.outDir,
      CustomName: target.fileName,
      SelectAllFrames: true
    };

    // 区间渲染（超分/朗读的「读取区间」用）：
    // 官方文档：SelectAllFrames=true 时 MarkIn/MarkOut 被忽略，
    // 所以要渲染指定区间必须设为 false 并给出帧号。
    var rangeInfo = (target.version && target.version.range) || (version && version.range) || null;
    if (rangeInfo && (rangeInfo.durationSec > 0 || rangeInfo.endFrame > rangeInfo.startFrame)) {
      try {
        const fps2 = await timelineFps(timeline, project);
        const tlStart = await timeline.GetStartFrame();
        let inF, outF;
        if (rangeInfo.startFrame !== undefined && rangeInfo.endFrame !== undefined) {
          inF = Math.round(rangeInfo.startFrame);
          outF = Math.round(rangeInfo.endFrame);
        } else {
          inF = Math.round(tlStart + (rangeInfo.startSec || 0) * fps2);
          outF = inF + Math.round((rangeInfo.durationSec || 0) * fps2);
        }
        if (outF > inF) {
          settings.MarkIn = inF;
          settings.MarkOut = outF;
          settings.SelectAllFrames = false;
          pushLog(`[${seqName} / ${version.name}] 渲染区间：${inF} → ${outF} 帧`);
        }
      } catch (e) {
        pushLog(`[${seqName} / ${version.name}] 区间设置失败，退回整条：${e.message}`);
      }
    }
    if (sub === 'none') {
      settings.ExportSubtitle = false;
    } else if (sub === 'burnin') {
      settings.ExportSubtitle = true;
      settings.SubtitleFormat = 'BurnIn';
    } else if (sub === 'sidecar') {
      settings.ExportSubtitle = true;
      settings.SubtitleFormat = 'SeparateFile';
    } else if (sub === 'embedded') {
      settings.ExportSubtitle = true;
      settings.SubtitleFormat = 'EmbeddedCaptions';
    }

    // 独立字幕文件：渲染前先拍快照，渲染后比对找出新产出的那个
    if (sub === 'sidecar') {
      srtBefore = snapshotSrt(target.outDir);
      try {
        const fps = await timelineFps(timeline, project);
        const tc = await timeline.GetStartTimecode();
        sidecarOffset = timecodeToSeconds(tc, fps);
      } catch (e) { sidecarOffset = 0; }
    }

    const setOk = await project.SetRenderSettings(settings);
    if (!setOk) throw new Error('SetRenderSettings 失败，检查输出目录是否存在');
    pushLog(`[${seqName} / ${version.name}] 字幕：${describeSubtitleMode(sub)}`);

    const jobId = await project.AddRenderJob();
    if (!jobId) throw new Error('AddRenderJob 返回空');
    result.jobId = jobId;

    const started = await project.StartRendering([jobId]);
    if (!started) throw new Error('StartRendering 失败');

    const wait = await waitForJob(project, jobId, seqName, version.name, onTick);
    if (wait.stopped) result.error = '已手动停止';
    else if (!wait.ok) result.error = wait.error;
    else result.ok = true;

    if (opts.deleteJob !== false) {
      try { await project.DeleteRenderJob(jobId); } catch (e) { /* 忽略 */ }
    }

    // ---------- 收尾：独立字幕文件重命名 + 归位 ----------
    if (result.ok && sub === 'sidecar') {
      const stem = target.fileName;
      const sd = (version.subtitleDir || '').trim();
      pushLog(`[${seqName} / ${version.name}] 正在归位字幕文件…`);
      const sc = await finalizeSidecar(target.outDir, stem, sd, srtBefore, sidecarOffset);
      if (sc.ok) {
        result.srtFrom = sc.from || '';
        result.srtTo = sc.to || '';
        pushLog(`[${seqName} / ${version.name}] 字幕已归位：${sc.to}`);
      } else {
        result.srtError = sc.error || '未知原因';
        pushLog(`[${seqName} / ${version.name}] 字幕归位失败：${result.srtError}`);
      }
    }

    pushLog(`[${seqName} / ${version.name}] ${result.ok ? '完成' : '失败：' + result.error}`);
  } catch (e) {
    result.error = String(e && e.message ? e.message : e);
    pushLog(`[${seqName} / ${version.name}] 异常：${result.error}`);
  } finally {
    // finally 里的任何异常都不得逸出，否则会中断整批导出
    if (savedEnabled) {
      try { await restoreAudioEnabled(timeline, savedEnabled); }
      catch (e) { pushLog(`[${seqName} / ${version.name}] 恢复音轨失败：${e.message}`); }
    }
    result.seconds = Math.round((Date.now() - t0) / 1000);
  }
  return result;
}

async function startExport(payload, onTick) {
  if (exportState.running) throw new Error('已有导出任务在运行');

  const project = await getProject();
  const opts = {
    deleteJob: !(payload && payload.deleteJob === false),
    openDeliver: !(payload && payload.openDeliver === false)
  };

  const groups = ((payload && payload.items) || [])
    .map(it => ({
      timeline: it.timeline,
      versions: (it.versions || []).filter(v => v.enabled !== false)
    }))
    .filter(g => g.timeline && g.versions.length);

  if (!groups.length) throw new Error('没有启用的版本');

  const total = groups.reduce((n, g) => n + g.versions.length, 0);

  exportState.running = true;
  exportState.stopRequested = false;
  exportState.total = total;
  exportState.done = 0;
  exportState.current = null;
  exportState.percent = 0;
  exportState.startedAt = Date.now();
  exportState.finishedAt = null;
  exportState.results = [];
  exportState.log = [];
  if (onTick) onTick(snapshot());

  // 注意：调 AddRenderJob / StartRendering 时 Resolve 会自动切到交付页，
  // 所以 openDeliver 无法阻止跳转。这里只在用户没勾选时尝试切回原页。
  let originPage = null;
  try { originPage = await (await getResolve()).GetCurrentPage(); } catch (e) { /* 忽略 */ }

  try {
    for (const group of groups) {
      if (exportState.stopRequested) break;

      // 每条时间线独立保护，任何异常不得中断整批
      let timeline = null;
      try {
        timeline = await findTimeline(project, group.timeline);
      } catch (e) {
        pushLog(`读取时间线失败：${group.timeline} · ${e.message}`);
      }
      if (!timeline) {
        pushLog(`跳过（找不到时间线）：${group.timeline}`);
        for (const v of group.versions) {
          exportState.results.push({
            timeline: group.timeline, version: v.name, outDir: v.outDir || '',
            fileName: '', preset: v.preset || '', ok: false, error: '找不到时间线', jobId: null, seconds: 0
          });
          exportState.done += 1;
        }
        exportState.percent = Math.round((exportState.done / exportState.total) * 100);
        if (onTick) onTick(snapshot());
        continue;
      }

      let seqName = group.timeline;
      let targets = [];
      try {
        await project.SetCurrentTimeline(timeline);
        seqName = await timeline.GetName();
        targets = resolveOutputs(seqName, group.versions);
      } catch (e) {
        pushLog(`准备时间线失败：${group.timeline} · ${e.message}`);
        continue;
      }

      for (const target of targets) {
        if (exportState.stopRequested) break;
        exportState.current = { timeline: seqName, version: target.version.name, percent: 0, status: '准备' };
        if (onTick) onTick(snapshot());

        // 最内层再包一层：即使 exportOne 自身穿透抛错，也只损失这一个任务
        let res;
        try {
          res = await exportOne(project, timeline, seqName, target.version, target, opts, onTick);
        } catch (e) {
          res = {
            timeline: seqName, version: target.version.name, outDir: target.outDir,
            fileName: target.fileName, preset: target.version.preset || '',
            ok: false, error: '未捕获异常：' + e.message, jobId: null, seconds: 0
          };
          pushLog(`[${seqName} / ${target.version.name}] 未捕获异常：${e.message}`);
        }
        exportState.results.push(res);
        exportState.done += 1;
        exportState.percent = Math.round((exportState.done / exportState.total) * 100);
        if (onTick) onTick(snapshot());
      }
    }
  } finally {
    exportState.running = false;
    exportState.stopRequested = false;
    exportState.finishedAt = Date.now();
    exportState.current = null;

    // 用户没要求停在交付页时，尝试切回原页
    if (!opts.openDeliver && originPage && originPage !== 'deliver') {
      try { await (await getResolve()).OpenPage(originPage); } catch (e) { /* 忽略 */ }
    }
    if (onTick) onTick(snapshot());
  }

  return snapshot();
}

async function stopExport() {
  if (!exportState.running) return { stopped: false, reason: '没有正在运行的导出' };
  exportState.stopRequested = true;
  pushLog('收到停止请求，正在中断当前渲染…');
  return { stopped: true };
}

function getExportState() {
  return snapshot();
}

// ==================== 导出 ====================

module.exports = {
  getRangeInfo,
  transcribeAudio,
  findWhisper,
  PLUGIN_ID,
  ping,
  getProductInfo,
  listTimelines,
  getTimelineDetail,
  listAudioClipsWithPath,
  listAudioTracks,
  listSubtitles,
  writeSubtitles,
  ensureMediaFolder,
  importFilesToPool,
  insertAudioToTimeline,
  listTimelineNames,
  getPlayhead,
  setAudioClipProps,
  readAudioClipProps,
  recognizeSubtitles,
  buildSrt,
  listRenderPresets,
  importMedia,
  openPage,
  listSubDirs,
  snapshotSrt,
  findNewSrt,
  ttmlToSrt,
  timecodeToSeconds,
  startExport,
  stopExport,
  getExportState,
  cleanup,

  // 以下为纯逻辑，仅供测试使用
  __test: {
    parseJobStatus,
    classifyState,
    resolveOutputs,
    sanitizeFileName,
    snapshotSrt,
    findNewSrt,
    ttmlToSrt,
    timecodeStrToFrames,
    buildSrt,
    listSubtitles,
    ensureMediaFolder,
    importFilesToPool,
    insertAudioToTimeline,
    getPlayhead,
    setAudioClipProps,
    readAudioClipProps,
    timecodeToSeconds,
    secToSrtTime,
    SUBTITLE_RE,
    ensureTrackSafePage,
    muteExceptAndVerify,
    TRACK_SAFE_PAGES,
    finalizeSidecar,
    STATE_READY,
    STATE_RENDERING,
    STATE_COMPLETE,
    STATE_FAILED,
    STATE_CANCELLED,
    STATE_UNKNOWN
  }
};
