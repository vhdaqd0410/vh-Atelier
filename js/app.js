'use strict';
/**
 * vh-Atelier · DaVinci Resolve 版 — 渲染层
 * 只通过 window.vhHost 与主进程通信。
 *
 * v0.1.3 变更：
 *   - 字幕控制改用渲染设置（ExportSubtitle / SubtitleFormat），不再靠禁用字幕轨
 *   - 交付根目录 + 一键自动填充各版本路径（按文件夹数字前缀匹配）
 *   - 日志可读性重做：按类型着色、关键信息前置
 *   - 结果里展示实际禁用的音轨（读回校验的真实结果）
 */

const H = window.vhHost;

const CFG_KEY = 'vh_atelier_resolve_versions_v1';
const DIR_KEY = 'vh_atelier_resolve_lastdir_v1';

const state = {
  sub: { timeline: '', items: [], zh: [], dict: {}, dirty: false },
  snd: { sfxRoot: '', sfx: [], sfxSel: new Set(), sep: null, caps: null },
  timelines: [],
  presets: [],
  versions: [],
  selected: new Set(),
  files: [],
  exporting: false,
  unsubProgress: null
};

// ==================== 工具 ====================

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDur(sec) {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

let toastTimer = null;
function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3200);
}

function logTo(boxId, msg, kind) {
  const box = $(boxId);
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = '[' + fmtTime(Date.now()) + '] ' + msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function uid() {
  return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 路径拼接：优先用主进程给的分隔符习惯，这里按 Windows 处理
function joinPath(dir, name) {
  if (!dir) return name;
  const d = String(dir).replace(/[\\/]+$/, '');
  return d + '\\' + name;
}

// ==================== 宿主调用封装 ====================

async function call(fn, ...args) {
  const res = await fn(...args);
  if (!res || typeof res !== 'object') throw new Error('宿主返回异常');
  if (!res.ok) throw new Error(res.error || '未知错误');
  return res.data;
}

// ==================== 配置持久化 ====================

// 字幕模式：none / burnin / sidecar / embedded
// 默认三版本：成片（烧入）/ 无字幕版 / 无音乐无字幕版（带独立字幕文件）
function defaultVersions() {
  return [
    { id: uid(), name: '成片', preset: '', muteMode: 'none', keepList: [],
      subtitleMode: 'burnin', subtitleDir: '', folderKey: '0', outDir: '', enabled: true },
    { id: uid(), name: '无字幕版', preset: '', muteMode: 'none', keepList: [],
      subtitleMode: 'none', subtitleDir: '', folderKey: '1', outDir: '', enabled: true },
    { id: uid(), name: '无音乐无字幕版', preset: '', muteMode: 'mute', keepList: [1, 2],
      subtitleMode: 'sidecar', subtitleDir: '', folderKey: '2', outDir: '', enabled: true }
  ];
}

/** 按版本名推断目录数字前缀 */
function inferFolderKey(name) {
  const n = String(name || '');
  if (n.includes('无音乐') || /bgm/i.test(n)) return '2';
  if (n.includes('无字幕')) return '1';
  if (n.includes('成片')) return '0';
  if (n.includes('字幕')) return '3';
  return '';
}

/** 按版本名推断默认字幕模式 */
function inferSubtitleMode(name) {
  const n = String(name || '');
  if (n.includes('无字幕')) return 'none';
  if (n.includes('成片')) return 'burnin';
  return 'none';
}

function normalizeVersion(v) {
  const name = v.name || '未命名版本';
  return {
    id: v.id || uid(),
    name,
    preset: v.preset || '',
    muteMode: v.muteMode === 'mute' ? 'mute' : 'none',
    keepList: Array.isArray(v.keepList) ? v.keepList : [],
    subtitleMode: v.subtitleMode || inferSubtitleMode(name),
    subtitleDir: v.subtitleDir || '',
    folderKey: v.folderKey || inferFolderKey(name),
    outDir: v.outDir || '',
    enabled: v.enabled !== false
  };
}

function loadVersions() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return defaultVersions();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return defaultVersions();
    return arr.map(normalizeVersion);
  } catch (e) {
    return defaultVersions();
  }
}

function saveVersions() {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(state.versions)); } catch (e) { /* 忽略 */ }
}

function getLastDir() {
  try { return localStorage.getItem(DIR_KEY) || ''; } catch (e) { return ''; }
}
function setLastDir(d) {
  try { localStorage.setItem(DIR_KEY, d || ''); } catch (e) { /* 忽略 */ }
}

// ==================== 顶部上下文 ====================

async function refreshContext() {
  return refreshContextImpl();
}

async function refreshContextImpl() {
  const dot = $('connDot');
  const setDot = (state, title) => {
    if (!dot) return;
    dot.className = 'conn-dot ' + state;   // 只使用 ok / err / warn 三种，与 CSS 对齐
    dot.title = title;
  };
  try {
    const info = await call(H.productInfo);
    setDot('ok', 'Resolve 已连接');
    $('subLine').textContent = ((info.product || 'DaVinci Resolve') + ' ' + (info.resolveVersion || '')).trim()
      + ' · ' + (info.projectName ? ('项目：' + info.projectName) : '未打开项目')
      + ' · ' + (info.currentTimeline ? ('时间线：' + info.currentTimeline) : '无时间线');
    return info;
  } catch (e) {
    setDot('err', 'Resolve 未连接：' + (e && e.message ? e.message : e));
    $('subLine').textContent = '未连接到 DaVinci Resolve（' + (e && e.message ? e.message : e) + '）';
    throw e;
  }
}

// ==================== 时间线列表 ====================

async function loadTimelines(opts) {
  const preferCurrent = !!(opts && opts.preferCurrent);
  const box = $('timelineList');
  box.innerHTML = '<div class="empty">读取中…</div>';
  try {
    const data = await call(H.listTimelines);
    state.timelines = data.timelines || [];

    // 保留之前的选择，剔除已不存在的时间线
    const prev = state.selected;
    state.selected = new Set([...prev].filter(n => state.timelines.some(t => t.name === n)));

    // 首次进入：默认勾选名字是纯数字的（分集命名）
    if (!state.selected.size) {
      state.timelines.forEach(t => { if (/^\d+$/.test(t.name)) state.selected.add(t.name); });
    }

    renderTimelines(data.fps);
    const picked = fillSubTimelineSelect(preferCurrent);
    if (preferCurrent) {
      const curTl = state.timelines.filter(t => t.current)[0];
      if (curTl) {
        // 让它也进入批量勾选，避免「选中了却没参与导出」
        state.selected.add(curTl.name);
        renderTimelines(data.fps);
      }
      state.subTimelinePick = picked || '';
    }
  } catch (e) {
    box.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>';
  }
}

function renderTimelines(fps) {
  const box = $('timelineList');
  if (!state.timelines.length) {
    box.innerHTML = '<div class="empty">当前项目没有时间线</div>';
    $('tlCount').textContent = '';
    return;
  }

  box.innerHTML = state.timelines.map(t => {
    const meta = t.frames + 'f · ' + fmtDur(t.durationSec) + ' · V' + t.videoTracks
      + '/A' + t.audioTracks + (t.subtitleTracks ? '/S' + t.subtitleTracks : '');
    return '<label class="tl-row' + (t.current ? ' cur' : '') + '">'
      + '<input type="checkbox" class="tl-cb" data-name="' + esc(t.name) + '"'
      + (state.selected.has(t.name) ? ' checked' : '') + '>'
      + '<span class="tl-name" title="' + esc(t.name) + '">' + esc(t.name) + '</span>'
      + (t.current ? '<span class="badge-cur">当前</span>' : '')
      + '<span class="tl-meta">' + esc(meta) + '</span>'
      + '</label>';
  }).join('');

  fillSubTimelineSelect();
  fillSoundTimelineSelect();
  $('tlCount').textContent = state.timelines.length + ' 条' + (fps ? ' · ' + fps + 'fps' : '');

  box.querySelectorAll('.tl-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const n = cb.dataset.name;
      if (cb.checked) state.selected.add(n); else state.selected.delete(n);
      $('chkAllTimelines').checked = false;
      updateExportSummary();
    });
  });
}

// ==================== 版本卡片 ====================

const SUBTITLE_OPTIONS = [
  ['burnin', '烧入画面（成片用）'],
  ['none', '不导出字幕（无字幕版）'],
  ['sidecar', '独立字幕文件（自动转 SRT）'],
  ['embedded', '内嵌字幕流（部分版本不支持）'],
  ['', '跟随预设不改动']
];

function renderVersions() {
  const box = $('versionList');
  if (!state.versions.length) {
    box.innerHTML = '<div class="empty">还没有版本，点下方「添加版本」</div>';
    $('verCount').textContent = '';
    updateExportSummary();
    return;
  }

  const presetOpts = (cur) => {
    const list = state.presets.slice();
    let html = '<option value="">（跟随当前预设）</option>';
    if (cur && list.indexOf(cur) < 0) list.unshift(cur);
    html += list.map(p =>
      '<option value="' + esc(p) + '"' + (p === cur ? ' selected' : '') + '>' + esc(p) + '</option>'
    ).join('');
    return html;
  };

  const subOpts = (cur) => SUBTITLE_OPTIONS.map(o =>
    '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'
  ).join('');

  box.innerHTML = state.versions.map(v => {
    const keep = (v.keepList || []).slice().sort((a, b) => a - b).join(', ');
    return '<div class="ver-card' + (v.enabled ? '' : ' dis') + '" data-id="' + v.id + '">'
      + '<div class="ver-top">'
      + '<label class="chk" title="勾选才参与导出"><input type="checkbox" class="v-enabled"' + (v.enabled ? ' checked' : '') + '></label>'
      + '<input class="input name v-name" value="' + esc(v.name) + '" placeholder="版本名">'
      + '<span class="ver-folder" title="目录数字前缀">#' + esc(v.folderKey || '-') + '</span>'
      + '<button class="icon-btn v-del" title="删除此版本">✕</button>'
      + '</div>'
      + '<div class="ver-body">'
      + '<span class="k">预设</span>'
      + '<select class="input v-preset">' + presetOpts(v.preset) + '</select>'

      + '<span class="k">音轨</span>'
      + '<select class="input v-mute">'
      + '<option value="none"' + (v.muteMode === 'none' ? ' selected' : '') + '>保留全部音轨</option>'
      + '<option value="mute"' + (v.muteMode === 'mute' ? ' selected' : '') + '>仅保留勾选音轨（去音乐）</option>'
      + '</select>'

      + '<span class="k">字幕</span>'
      + '<select class="input v-sub">' + subOpts(v.subtitleMode) + '</select>'

      + (v.subtitleMode === 'sidecar'
        ? '<span class="k">字幕目录</span><div class="dir-cell">'
          + '<input class="input wide v-subdir" value="' + esc(v.subtitleDir || '') + '" placeholder="留空则与视频同目录">'
          + '<button class="btn v-browse-sub">浏览…</button></div>'
        : '')

      + (v.muteMode === 'mute'
        ? '<span class="k">保留</span><div class="ver-keep v-keep"></div>'
        : '<span class="k"></span><div class="mini">（当前保留全部音轨）</div>')

      + '<span class="k">输出到</span>'
      + '<div class="dir-cell">'
      + '<input class="input wide v-dir" value="' + esc(v.outDir) + '" placeholder="选择输出目录…">'
      + '<button class="btn v-browse">浏览…</button>'
      + '</div>'
      + '</div>'
      + '</div>';
  }).join('');

  $('verCount').textContent = state.versions.filter(v => v.enabled).length + '/'
    + state.versions.length + ' 启用';

  renderKeepLists();
  updateExportSummary();
  saveVersions();
}

function renderKeepLists() {
  document.querySelectorAll('.ver-card').forEach(card => {
    const v = findVersion(card.dataset.id);
    if (!v) return;
    const wrap = card.querySelector('.v-keep');
    if (!wrap) return;

    // 用当前选中时间线里最大的音轨数决定选项数量
    let maxTracks = 2;
    const firstSelected = state.timelines.find(t => state.selected.has(t.name));
    if (firstSelected && firstSelected.audioTracks) maxTracks = Math.max(maxTracks, firstSelected.audioTracks);
    state.versions.forEach(x => (x.keepList || []).forEach(i => { maxTracks = Math.max(maxTracks, i); }));

    let html = '';
    for (let i = 1; i <= maxTracks; i++) {
      html += '<label class="chk"><input type="checkbox" class="keep-cb" data-i="' + i + '"'
        + (v.keepList.indexOf(i) >= 0 ? ' checked' : '') + '><span>A' + i + '</span></label>';
    }
    wrap.innerHTML = html;

    wrap.querySelectorAll('.keep-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const i = parseInt(cb.dataset.i, 10);
        const list = v.keepList.filter(x => x !== i);
        if (cb.checked) list.push(i);
        v.keepList = list.sort((a, b) => a - b);
        saveVersions();
      });
    });
  });
}

function findVersion(id) {
  for (const v of state.versions) if (v.id === id) return v;
  return null;
}

function addVersion() {
  state.versions.push(normalizeVersion({
    name: '新版本', preset: '', muteMode: 'none', keepList: [],
    outDir: '', enabled: true
  }));
  saveVersions();
  renderVersions();
}

function removeVersion(id) {
  state.versions = state.versions.filter(v => v.id !== id);
  saveVersions();
  renderVersions();
}

function resetVersions() {
  state.versions = defaultVersions();
  saveVersions();
  renderVersions();
}

function bindVersionEvents() {
  const box = $('versionList');

  box.addEventListener('input', (e) => {
    const card = e.target.closest('.ver-card');
    if (!card) return;
    const v = findVersion(card.dataset.id);
    if (!v) return;
    if (e.target.classList.contains('v-name')) {
      v.name = e.target.value;
      // 名字变了，数字前缀跟着推断（用户可感知，写在卡片上）
      v.folderKey = inferFolderKey(v.name);
      const tag = card.querySelector('.ver-folder');
      if (tag) tag.textContent = '#' + (v.folderKey || '-');
      saveVersions();
    }
    if (e.target.classList.contains('v-dir')) {
      v.outDir = e.target.value;
      saveVersions();
      updateExportSummary();
    }
    if (e.target.classList.contains('v-subdir')) {
      v.subtitleDir = e.target.value;
      saveVersions();
    }
  });

  box.addEventListener('change', (e) => {
    const card = e.target.closest('.ver-card');
    if (!card) return;
    const v = findVersion(card.dataset.id);
    if (!v) return;
    const t = e.target;

    if (t.classList.contains('v-enabled')) {
      v.enabled = t.checked;
      card.classList.toggle('dis', !v.enabled);
      $('verCount').textContent = state.versions.filter(x => x.enabled).length + '/'
        + state.versions.length + ' 启用';
      saveVersions();
      updateExportSummary();
    }
    if (t.classList.contains('v-preset')) { v.preset = t.value; saveVersions(); }
    if (t.classList.contains('v-sub')) {
      v.subtitleMode = t.value;
      saveVersions();
      renderVersions();   // 字幕目录输入框要跟着显示/隐藏
    }
    if (t.classList.contains('v-mute')) {
      v.muteMode = t.value;
      saveVersions();
      renderVersions();   // 保留列表要跟着显示/隐藏
    }
  });

  box.addEventListener('click', async (e) => {
    const card = e.target.closest('.ver-card');
    if (!card) return;
    const v = findVersion(card.dataset.id);
    if (!v) return;

    if (e.target.classList.contains('v-del')) { removeVersion(v.id); return; }

    if (e.target.classList.contains('v-browse')) {
      const start = v.outDir || getLastDir() || '';
      try {
        const dir = await call(H.pickFolder, start);
        if (!dir) return;
        v.outDir = dir;
        setLastDir(dir);
        card.querySelector('.v-dir').value = dir;
        saveVersions();
        updateExportSummary();
      } catch (err) {
        toast('选择目录失败：' + err.message, 'err');
      }
    }

    if (e.target.classList.contains('v-browse-sub')) {
      const start = v.subtitleDir || getLastDir() || '';
      try {
        const dir = await call(H.pickFolder, start);
        if (!dir) return;
        v.subtitleDir = dir;
        setLastDir(dir);
        card.querySelector('.v-subdir').value = dir;
        saveVersions();
      } catch (err) {
        toast('选择字幕目录失败：' + err.message, 'err');
      }
    }
  });
}

function updateExportSummary() {
  const evs = state.versions.filter(v => v.enabled);
  const total = state.selected.size * evs.length;
  $('exportSummary') && ($('exportSummary').textContent =
    state.selected.size + ' 条时间线 × ' + evs.length + ' 个版本 = ' + total + ' 个任务');
  $('btnStartExport').disabled = state.exporting || total === 0;
}

// ==================== 交付目录自动填充 ====================

/** 扫描交付根目录的子文件夹，按数字前缀匹配到各版本 */
async function autofillFromRoot() {
  const root = ($('deliveryRoot').value || '').trim();
  if (!root) { toast('请先选择交付根目录', 'err'); return; }

  let subs = [];
  try {
    subs = await call(H.listSubDirs, root);
  } catch (e) {
    toast('读取根目录失败：' + e.message, 'err');
    return;
  }

  if (!subs || !subs.length) {
    toast('该目录下没有子文件夹', 'err');
    return;
  }

  // 提取数字前缀："1.无字幕版本" -> 1
  const prefixOf = (name) => {
    const m = String(name).match(/^(\d+)\s*[.、_\-\s]?/);
    return m ? parseInt(m[1], 10) : null;
  };

  const pick = (key, kw) => {
    // 先按数字前缀
    if (key) {
      const want = parseInt(key, 10);
      if (!isNaN(want)) {
        const hit = subs.find(s => prefixOf(s) === want);
        if (hit) return hit;
      }
    }
    // 再按关键词
    if (kw) return subs.find(s => String(s).indexOf(kw) >= 0) || null;
    return null;
  };

  let matched = 0;
  const missed = [];

  // 字幕目录：优先数字前缀 3，其次名字含「字幕」
  const srtHit = subs.find(s => prefixOf(s) === 3)
    || subs.find(s => String(s).indexOf('字幕') >= 0) || null;

  state.versions.forEach(v => {
    const key = v.folderKey || inferFolderKey(v.name);
    let kw = '';
    if (v.name.includes('无音乐')) kw = '无音乐';
    else if (v.name.includes('无字幕')) kw = '无字幕';
    else if (v.name.includes('成片')) kw = '成片';

    const hit = pick(key, kw);
    if (hit) {
      v.outDir = joinPath(root, hit);
      matched++;
    } else {
      missed.push(v.name);
    }

    // 需要独立字幕文件的版本，顺便填上字幕目录
    if (v.subtitleMode === 'sidecar' && srtHit) {
      v.subtitleDir = joinPath(root, srtHit);
    }
  });

  saveVersions();
  setLastDir(root);
  renderVersions();

  if (matched) toast('已填充 ' + matched + ' 个版本路径' + (srtHit ? ' + 字幕目录' : ''), 'ok');
  if (missed.length) toast('未匹配到目录：' + missed.join('、'), 'err');
}

// ==================== 导出 ====================

function classifyLogKind(msg) {
  if (/失败|异常|错误|警告|未能/.test(msg)) return 'err';
  if (/完成|已禁用音轨/.test(msg)) return 'ok';
  if (/开始|渲染中|字幕：/.test(msg)) return 'info';
  return '';
}

function renderProgress(snap) {
  const bar = $('progBar');
  const pct = snap.percent || 0;
  bar.style.width = pct + '%';

  const btnStart = $('btnStartExport');
  const btnStop = $('btnStopExport');

  if (snap.running) {
    const cur = snap.current;
    $('progText').textContent = cur
      ? (snap.done + ' / ' + snap.total + ' · ' + cur.timeline + ' / ' + cur.version
         + (cur.status ? ' · ' + cur.status : ''))
      : (snap.done + ' / ' + snap.total + ' · 准备中');
    if (snap.startedAt && pct > 2) {
      const elapsed = (Date.now() - snap.startedAt) / 1000;
      const remain = Math.max(0, elapsed / pct * (100 - pct));
      $('progEta').textContent = remain > 60
        ? ('预计剩余 ' + Math.floor(remain / 60) + ' 分 ' + Math.floor(remain % 60) + ' 秒')
        : ('预计剩余 ' + Math.ceil(remain) + ' 秒');
    } else {
      $('progEta').textContent = '';
    }
  } else if (snap.finishedAt) {
    const secs = Math.round((snap.finishedAt - snap.startedAt) / 1000);
    const ok = (snap.results || []).filter(r => r.ok).length;
    const total = (snap.results || []).length;
    $('progText').textContent = '已结束 · 成功 ' + ok + '/' + total + ' · 用时 ' + fmtDur(secs);
    $('progEta').textContent = '';
  } else {
    $('progText').textContent = '待命';
    $('progEta').textContent = '';
  }

  const evs = state.versions.filter(v => v.enabled);
  btnStart.disabled = snap.running || (state.selected.size * evs.length) === 0;
  btnStop.disabled = !snap.running;

  // 日志：整体重绘，保证顺序与着色一致
  const box = $('exportLog');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const logs = snap.log || [];
  const seen = box.dataset.count ? parseInt(box.dataset.count, 10) : -1;
  if (logs.length !== seen) {
    box.innerHTML = logs.map(l => {
      const kind = classifyLogKind(l.msg);
      return '<div' + (kind ? ' class="' + kind + '"' : '') + '>'
        + '<span class="lt">' + fmtTime(l.t) + '</span> ' + esc(l.msg) + '</div>';
    }).join('');
    box.dataset.count = String(logs.length);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  if (snap.results && snap.results.length) renderResults(snap.results);
}

function renderResults(results) {
  $('resultCard').style.display = '';
  $('resultList').innerHTML = results.map(r => {
    const audioInfo = r.audioDisabled && r.audioDisabled.length
      ? ('禁用音轨 ' + r.audioDisabled.join(','))
      : (r.audioNotDisabled && r.audioNotDisabled.length ? '音轨未禁用' : '');
    const warn = (r.audioNotDisabled && r.audioNotDisabled.length)
      ? '<div class="res-warn">音轨 ' + esc(r.audioNotDisabled.join('、')) + ' 未能禁用</div>' : '';
    const srtLine = r.srtTo
      ? '<div class="res-path">字幕 → ' + esc(r.srtTo) + '</div>'
      : (r.srtError ? '<div class="res-warn">字幕归位：' + esc(r.srtError) + '</div>' : '');
    return '<div class="res-row">'
      + '<span class="res-tag ' + (r.ok ? 'ok' : 'err') + '">' + (r.ok ? '成功' : '失败') + '</span>'
      + '<span class="res-name">' + esc(r.timeline) + ' / ' + esc(r.version) + '</span>'
      + '<span class="res-meta">' + (audioInfo ? esc(audioInfo) + ' · ' : '')
      + (r.subtitleMode !== undefined ? '字幕:' + esc(describeSub(r.subtitleMode)) + ' · ' : '')
      + r.seconds + 's</span>'
      + '</div>'
      + '<div class="res-path" title="' + esc(joinPath(r.outDir, r.fileName)) + '">'
      + esc(joinPath(r.outDir, r.fileName)) + '</div>'
      + srtLine
      + warn
      + (r.ok ? '' : '<div class="res-warn">' + esc(r.error || '') + '</div>');
  }).join('');
}

function describeSub(mode) {
  switch (mode) {
    case 'burnin': return '烧入';
    case 'sidecar': return '独立 SRT';
    case 'embedded': return '内嵌';
    case 'none': return '无';
    default: return '跟随预设';
  }
}

async function startExport() {
  const evs = state.versions.filter(v => v.enabled);
  if (!state.selected.size) { toast('请至少勾选一条时间线', 'err'); return; }
  if (!evs.length) { toast('请至少启用一个版本', 'err'); return; }

  const items = state.timelines
    .filter(t => state.selected.has(t.name))
    .map(t => ({
      timeline: t.name,
      versions: evs.map(v => ({
        name: v.name,
        preset: v.preset,
        muteMode: v.muteMode,
        keepList: v.keepList,
        subtitleMode: v.subtitleMode,
        subtitleDir: v.subtitleDir || '',
        outDir: v.outDir,
        enabled: true
      }))
    }));

  const missing = [];
  items.forEach(it => it.versions.forEach(v => {
    if (!v.outDir) missing.push(it.timeline + ' / ' + v.name);
  }));
  if (missing.length) {
    toast('这些任务还没设输出目录：' + missing.slice(0, 3).join('，') + (missing.length > 3 ? ' 等' : ''), 'err');
    return;
  }

  const box = $('exportLog');
  box.innerHTML = '';
  box.dataset.count = '0';
  $('resultCard').style.display = 'none';
  state.exporting = true;
  updateExportSummary();

  try {
    await call(H.exportStart, {
      items,
      openDeliver: $('chkOpenDeliver').checked,
      deleteJob: true
    });
    toast('导出任务已提交', 'ok');
  } catch (e) {
    toast('启动失败：' + e.message, 'err');
    state.exporting = false;
    updateExportSummary();
  }
}

async function stopExport() {
  try {
    await call(H.exportStop);
    toast('已请求停止，等待当前渲染中断…');
  } catch (e) {
    toast('停止失败：' + e.message, 'err');
  }
}

// ==================== 素材导入 ====================

function renderFiles() {
  const box = $('fileList');
  if (!box) return;   // 素材面板已由 js/media.js 接管
  box.innerHTML = state.files.length
    ? state.files.map(f => esc(f)).join('\n')
    : '<div class="empty">未选择文件</div>';
  $('btnDoImport').disabled = !state.files.length;
}

async function pickFiles() {
  try {
    const paths = await call(H.pickFiles);
    if (!paths || !paths.length) return;
    const merged = new Set(state.files.concat(paths));
    state.files = [...merged];
    renderFiles();
  } catch (e) {
    toast('选择文件失败：' + e.message, 'err');
  }
}

async function doImport() {
  if (!state.files.length) return;
  const logBox = $('mediaLog');
  if (logBox) logBox.innerHTML = '';
  if (!$('fileList')) return;   // 旧素材面板已移除
  const folderEl = $('mediaFolderName');
  const folder = folderEl ? folderEl.value.trim() : '';
  try {
    logTo('mediaLog', '开始导入 ' + state.files.length + ' 个文件…');
    const r = await call(H.importFilesToPool, state.files, folder);
    logTo('mediaLog', '导入完成：' + r.count + ' 个素材 → ' + r.folder + '（' + (r.names || []).join(', ') + '）', 'ok');
    toast('已导入 ' + r.count + ' 个素材', 'ok');
    state.files = [];
    renderFiles();
  } catch (e) {
    logTo('mediaLog', '导入失败：' + e.message, 'err');
    toast('导入失败：' + e.message, 'err');
  }
}

// ==================== 字幕面板 ====================

const SUB_DICT_KEY = 'pr_me_subdict_v1';

/** 加载替换字典：{ 错误写法: 正确写法 } */
function loadSubDict() {
  try {
    const raw = localStorage.getItem(SUB_DICT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function saveSubDict(d) {
  try { localStorage.setItem(SUB_DICT_KEY, JSON.stringify(d || {})); } catch (e) { /* 忽略 */ }
}

/** 按字典对整段文本做替换（长词优先，避免短词把长词切碎） */
function applyDictToText(text, dict) {
  let out = String(text || '');
  const keys = Object.keys(dict || {}).filter(k => k).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const v = dict[k];
    if (v === undefined || v === null) continue;
    out = out.split(k).join(v);
  }
  return out;
}

function setSubStatus(msg, kind) {
  $('subStatus').textContent = msg;
  if (kind) logTo('subLog', msg, kind);
}

/**
 * 填充「时间线」下拉框。
 * @param {boolean} preferCurrent 为真时，优先选中 Resolve 当前焦点所在的时间线
 *        （刷新场景用；用户手动选过的情况下不传，保持其选择）
 */
function fillSubTimelineSelect(preferCurrent) {
  const sel = $('subTimeline');
  if (!sel) return;
  const prev = sel.value;
  // Resolve 当前焦点时间线（listTimelines 里带 current 标记）
  const curTl = state.timelines.filter(t => t.current)[0];
  let pick = prev;
  if (preferCurrent) {
    pick = curTl ? curTl.name : prev;
  } else if (!prev && curTl) {
    pick = curTl.name;   // 首次填充：直接落在当前时间线
  }
  sel.innerHTML = state.timelines.map(t =>
    '<option value="' + esc(t.name) + '"' + (t.name === pick ? ' selected' : '') + '>'
    + esc(t.name) + '</option>').join('') || '<option value="">（无时间线）</option>';
  sel.value = pick || '';
  return pick;
}

function renderSubList() {
  const box = $('subList');
  const items = state.sub.items || [];
  const dual = $('chkSubDual').checked;
  $('subCount').textContent = items.length + ' 条';
  $('btnExportSrt').disabled = !items.length;
  $('btnWriteBack').disabled = !items.length;

  if (!items.length) {
    box.innerHTML = '<div class="empty">尚未读取字幕。先选时间线，点「开始识别」或「读取现有字幕」。</div>';
    return;
  }
  box.innerHTML = items.map((it, i) => {
    const zh = state.sub.zh[i] || '';
    const text = applyDictToText(it.text, state.sub.dict);
    const zhOut = zh ? applyDictToText(zh, state.sub.dict) : '';
    const edited = it.__edited ? ' sub-edited' : '';
    return '<div class="sub-row' + edited + '" data-sub-i="' + i + '">'
      + '<span class="sub-idx">' + (i + 1) + '</span>'
      + '<span class="sub-tc">' + fmtSecTc(it.startSec) + ' → ' + fmtSecTc(it.endSec) + '</span>'
      + '<span class="sub-text" contenteditable="true" data-sub-edit="' + i + '"'
      + ' title="点击可直接修改这条字幕">' + esc(text) + '</span>'
      + (dual && zhOut ? '<span class="sub-zh" contenteditable="true" data-sub-edit-zh="' + i + '"'
          + ' title="点击可修改译文">' + esc(zhOut) + '</span>' : '')
      + '</div>';
  }).join('');
}

/** 秒 -> "分:秒.厘秒"，用于字幕时间轴显示（区别于日志用的 fmtTime） */
function fmtSecTc(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return String(m).padStart(2, '0') + ':' + (r < 10 ? '0' : '') + r.toFixed(2);
}

async function loadSubtitles(silent) {
  const name = $('subTimeline').value;
  if (!name) { toast('请先选择时间线', 'err'); return; }
  $('subList').innerHTML = '<div class="empty">读取中…</div>';
  try {
    const r = await call(H.listSubtitles, name);
    state.sub.timeline = name;
    state.sub.items = r.items || [];
    state.sub.zh = new Array(state.sub.items.length).fill('');
    renderSubList();
    if (!silent) {
      setSubStatus('已读取 ' + state.sub.items.length + ' 条字幕（' + (r.trackCount || 0) + ' 条字幕轨）', 'ok');
    } else {
      $('subStatus').textContent = state.sub.items.length + ' 条';
    }
  } catch (e) {
    $('subList').innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>';
    if (!silent) toast('读取失败：' + e.message, 'err');
  }
}

async function recognizeSubtitles() {
  const name = $('subTimeline').value;
  if (!name) { toast('请先选择时间线', 'err'); return; }
  const btn = $('btnRecognize');
  btn.disabled = true;
  $('subLog').innerHTML = '';
  setSubStatus('识别中…这可能需要十几秒到几分钟', 'info');
  try {
    const r = await call(H.recognizeSubtitles, name, {
      charsPerLine: $('subCharsPerLine').value,
      gap: $('subGap').value
    });
    state.sub.timeline = name;
    state.sub.items = r.items || [];
    state.sub.zh = new Array(state.sub.items.length).fill('');
    renderSubList();
    setSubStatus('识别完成：' + r.count + ' 条 · 用时 ' + r.seconds + 's', 'ok');
    toast('已识别 ' + r.count + ' 条字幕', 'ok');
  } catch (e) {
    setSubStatus('识别失败：' + e.message, 'err');
    toast('识别失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function translateSubtitles() {
  const items = state.sub.items || [];
  if (!items.length) { toast('没有可翻译的字幕', 'err'); return; }
  if (!window.__translateBridge) { toast('翻译模块未加载', 'err'); return; }

  const btn = $('btnSubTranslate');
  btn.disabled = true;
  const dict = state.sub.dict || {};
  const payload = items.map(it => ({ start: it.startSec, end: it.endSec, text: applyDictToText(it.text, dict) }));

  window.__translateBridge.runTranslate(
    payload, 'zh',
    (done, total) => { setSubStatus('翻译中 ' + done + '/' + total, 'info'); },
    (err, res) => {
      btn.disabled = false;
      if (err) { setSubStatus('翻译失败：' + err.message, 'err'); toast('翻译失败', 'err'); return; }
      state.sub.zh = res.outSubs.map(s => (s && s.text) || '');
      renderSubList();
      const msg = res.failCount
        ? ('翻译完成，' + res.failCount + ' 条失败（已保留原文）')
        : '翻译完成';
      setSubStatus(msg, res.failCount ? 'warn' : 'ok');
    }
  );
}

/** 打开一个简单的字典编辑弹层（用 prompt 收集，够用且零依赖） */
function editSubDict() {
  // 用「左原 / 右新」两列编辑器：一行一条替换规则，符合逐条维护的心智。
  // （之前是直接编辑 JSON 文本，容易写错；也不该用 window.prompt，Electron 禁用。）
  if (!window.__vhDictEditor) {
    toast('字典编辑器未加载（请重启插件）', 'err');
    return;
  }
  window.__vhDictEditor({
    title: '替换字典',
    dict: state.sub.dict || {},
    tip: '左边填「要被替换的内容」，右边填「替换成什么」。保存后立即作用于字幕列表与导出。'
  }, function (result) {
    if (result === null) return;      // 取消
    state.sub.dict = result || {};
    saveSubDict(state.sub.dict);
    renderSubList();
    toast('字典已保存（' + Object.keys(state.sub.dict).length + ' 条）', 'ok');
  });
}

async function exportSubtitleSrt() {
  const items = state.sub.items || [];
  if (!items.length) { toast('没有可导出的字幕', 'err'); return; }
  const bilingual = $('chkSubBilingual').checked;
  const dict = state.sub.dict || {};

  const list = items
    .map((it, i) => ({ text: applyDictToText(it.text, dict), zh: applyDictToText(state.sub.zh[i] || '', dict),
                       startSec: it.startSec, endSec: it.endSec }))
    .filter(it => String(it.text || '').trim().length);

  const srt = buildSrtLocal(list, bilingual);
  const name = ($('subTimeline').value || 'subtitle') + (bilingual ? '.bilingual' : '') + '.srt';
  const dir = state.sub.outDir || getLastDir() || '';
  try {
    const saved = await call(H.saveSrt, dir, name, srt);
    if (!saved) return;
    state.sub.outDir = saved.replace(/[\\/][^\\/]*$/, '');
    setLastDir(state.sub.outDir);
    setSubStatus('已导出：' + saved, 'ok');
    toast('字幕已导出', 'ok');
  } catch (e) {
    setSubStatus('导出失败：' + e.message, 'err');
    toast('导出失败：' + e.message, 'err');
  }
}

/** 本地 SRT 组装（与宿主层 buildSrt 同构，避免额外 IPC 往返） */
function buildSrtLocal(list, bilingual) {
  const pad = (n, w) => String(n).padStart(w, '0');
  const tc = (sec) => {
    const ms = Math.round(Math.max(0, sec) * 1000);
    return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms % 3600000 / 60000), 2)
      + ':' + pad(Math.floor(ms % 60000 / 1000), 2) + ',' + pad(ms % 1000, 3);
  };
  const out = [];
  for (const it of list) {
    let text = it.text;
    if (bilingual) text = it.zh ? (it.text + '\n' + it.zh) : it.text;
    out.push((out.length + 1) + '\n' + tc(it.startSec) + ' --> ' + tc(it.endSec) + '\n' + text);
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}

async function writeBackSubtitles() {
  const items = state.sub.items || [];
  if (!items.length) { toast('没有可写回的字幕', 'err'); return; }
  const name = $('subTimeline').value;
  if (!name) { toast('请先选择时间线', 'err'); return; }
  if (!window.confirm('写回会【清空该时间线现有字幕轨】，然后用 SRT 重新导入。\n\n'
    + '注意：达芬奇脚本 API 无法指定字幕定位，导入结果会落在时间线末尾，需人工调整。\n'
    + '确认继续？')) return;

  const dict = state.sub.dict || {};
  const list = items.map((it, i) => ({ text: applyDictToText(it.text, dict), zh: applyDictToText(state.sub.zh[i] || '', dict),
                                       startSec: it.startSec, endSec: it.endSec }));
  const srt = buildSrtLocal(list, $('chkSubBilingual').checked);

  $('writeLog').innerHTML = '';
  try {
    logTo('writeLog', '准备 SRT…', 'info');
    const tmp = await call(H.saveSrt, state.sub.outDir || getLastDir() || '', '_writetmp.srt', srt);
    if (!tmp) { logTo('writeLog', '已取消', 'warn'); return; }
    logTo('writeLog', '导出临时 SRT：' + tmp, 'info');

    const r = await call(H.writeSubtitles, name, tmp, { clearExisting: true });
    logTo('writeLog', '已清空原有字幕轨：' + (r.cleared || 0) + ' 条', 'info');
    logTo('writeLog', '已写入：' + r.added + ' 条', 'ok');
    if (r.warning) logTo('writeLog', r.warning, 'warn');
    toast('已写回字幕轨', 'ok');
    await loadSubtitles(true);
  } catch (e) {
    logTo('writeLog', '写回失败：' + e.message, 'err');
    toast('写回失败：' + e.message, 'err');
  }
}

function bindSubtitle() {
  $('btnRecognize').addEventListener('click', recognizeSubtitles);
  $('btnLoadSubs').addEventListener('click', () => loadSubtitles(false));
  // 刷新时间线：重新读项目→时间线列表，并保留当前选择
  const _btnRT = $('btnRefreshSubTl');
  if (_btnRT) _btnRT.addEventListener('click', async () => {
    _btnRT.disabled = true;
    const old = _btnRT.textContent;
    _btnRT.textContent = '↻ 刷新中…';
    try {
      await refreshContext();                     // 重读项目 / 当前焦点时间线
      await loadTimelines({ preferCurrent: true }); // 重读列表并自动选中当前时间线
      const cur = state.timelines.filter(t => t.current)[0];
      toast(cur ? ('已刷新 · 已选中当前时间线：' + cur.name)
                : ('已刷新：' + state.timelines.length + ' 条时间线（未识别到当前时间线）'),
            cur ? 'ok' : 'warn');
    } catch (e) {
      toast('刷新失败：' + (e && e.message ? e.message : e), 'err');
    } finally {
      _btnRT.disabled = false;
      _btnRT.textContent = old;
    }
  });
  $('btnSubTranslate').addEventListener('click', translateSubtitles);
  $('btnApplyDict').addEventListener('click', editSubDict);
  $('btnExportSrt').addEventListener('click', exportSubtitleSrt);
  $('btnWriteBack').addEventListener('click', writeBackSubtitles);
  $('chkSubDual').addEventListener('change', renderSubList);

  // 字幕文本编辑：失焦或回车即写回（导出/写回时用的是 state.sub.items）
  (function bindSubEditing() {
    const box = $('subList');
    if (!box || box.__editBound) return;
    box.__editBound = true;

    function commit(el, isZh) {
      const i = Number(isZh ? el.getAttribute('data-sub-edit-zh') : el.getAttribute('data-sub-edit'));
      if (!Number.isFinite(i)) return;
      const val = (el.textContent || '').replace(/\u00a0/g, ' ').trim();
      if (isZh) {
        if (!state.sub.zh) state.sub.zh = [];
        if (state.sub.zh[i] === val) return;
        state.sub.zh[i] = val;
      } else {
        const it = (state.sub.items || [])[i];
        if (!it || it.__raw === val) return;
        // 存原始文本；显示层会再套字典，所以这里保留用户输入原样
        it.text = val;
        it.__edited = true;
        it.__raw = val;
      }
      toast('已修改第 ' + (i + 1) + ' 条', 'ok');
    }

    box.addEventListener('blur', function (e) {
      const el = e.target;
      if (!el || !el.getAttribute) return;
      if (el.getAttribute('data-sub-edit') !== null) commit(el, false);
      else if (el.getAttribute('data-sub-edit-zh') !== null) commit(el, true);
    }, true);

    box.addEventListener('keydown', function (e) {
      const el = e.target;
      if (!el || !el.getAttribute) return;
      const isEdit = (el.getAttribute('data-sub-edit') !== null)
        || (el.getAttribute('data-sub-edit-zh') !== null);
      if (!isEdit) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        el.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        renderSubList();     // 放弃本次编辑
      }
    });
  })();
  $('subTimeline').addEventListener('change', () => {
    state.sub.items = []; state.sub.zh = []; renderSubList();
  });
  state.sub.dict = loadSubDict();
}

// ==================== 声音面板 ====================

const SFX_ROOT_KEY = 'pr_me_sfxroot_v1';

function fmtMB(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// ---------- 本地引擎自检 ----------

function setSepStatus(msg, kind) {
  $('sepStatus').textContent = msg;
  if (kind) logTo('sepLog', msg, kind);
}

async function pickSepInput() {
  try {
    const paths = await call(H.pickFiles, getLastDir(), [
      { name: '音频 / 视频', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'mkv'] }
    ]);
    if (!paths || !paths.length) return;
    $('sepInput').value = paths[0];
  } catch (e) {
    toast('选择失败：' + e.message, 'err');
  }
}

/** 用当前时间线选中的音频片段作为输入 */
async function useSelectedClip() {
  try {
    // 不依赖下拉元素：留空让宿主用「当前时间线」
    const name = '';
    const props = await call(H.readAudioClipProps, name, null, { onlySelected: true });
    if (!props.length) { toast('当前没有选中的音频片段（请在时间线上选中一个）', 'err'); return; }
    const first = props[0];
    if (!first.filePath) {
      toast('该片段取不到文件路径（可能是生成器，请改用「选择文件…」）', 'err');
      return;
    }
    $('sepInput').value = first.filePath;
    // 注意：这里必须填「素材文件内偏移」，不是「时间线位置」。
    // 原实现用了 startSec（时间线口径），当片段位于时间线靠后位置时会切出空文件，
    // 表现为「明明是 9 秒的片段却提示音频过短」。
    if (first.sourceStartSec !== null && first.sourceStartSec !== undefined) {
      var segDur = (first.sourceEndSec !== null && first.sourceEndSec !== undefined)
        ? Math.max(0, first.sourceEndSec - first.sourceStartSec)
        : ((first.endSec !== null && first.startSec !== null) ? Math.max(0, first.endSec - first.startSec) : 0);
      $('sepStart').value = first.sourceStartSec.toFixed(3);
      $('sepDur').value = segDur.toFixed(3);
      toast('已填入：' + first.name + '（素材内 ' + first.sourceStartSec.toFixed(2) + 's 起，约 '
        + segDur.toFixed(1) + 's）', 'ok');
    } else {
      // 拿不到素材内偏移 → 不裁剪，整段素材处理（避免切空）
      $('sepStart').value = '';
      $('sepDur').value = '';
      toast('已填入：' + first.name + '（取不到素材内偏移，将处理整个素材）', 'warn');
    }
  } catch (e) {
    toast('读取失败：' + e.message, 'err');
  }
}

async function runSeparation() {
  const input = ($('sepInput').value || '').trim();
  if (!input) { toast('请先选择输入文件', 'err'); return; }
  const btn = $('btnSepRun');
  btn.disabled = true;
  $('sepLog').innerHTML = '';
  $('sepResults').innerHTML = '';
  setSepStatus('分离中…', 'info');
  try {
    const r = await call(H.svcSeparateVocals, {
      input: input,
      startSec: $('sepStart').value,
      durationSec: $('sepDur').value
    });
    setSepStatus('分离完成 · 用时 ' + r.seconds + 's', 'ok');
    renderSepResults(r);
  } catch (e) {
    setSepStatus('分离失败：' + e.message, 'err');
    toast('分离失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function renderSepResults(r) {
  const rows = [
    { label: '人声', path: r.vocals, size: r.vocalsBytes, color: '#7fd68b' },
    { label: '伴奏', path: r.accompaniment, size: r.accompanimentBytes, color: '#7fb3d9' }
  ];
  const box = $('sepResults');
  box.innerHTML = '';
  rows.forEach(x => {
    if (!x.path) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'padding:8px 10px;margin-bottom:8px;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
    head.innerHTML = '<span class="res-tag ok">' + esc(x.label) + '</span>'
      + '<span class="res-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;'
      + 'white-space:nowrap;font-size:11.5px;" title="' + esc(x.path) + '">' + esc(x.path) + '</span>'
      + '<span class="res-meta">' + fmtMB(x.size) + '</span>';
    card.appendChild(head);

    // 波形 + 试听（拖 ⠿ 可拖到时间线）
    const waveHost = document.createElement('div');
    waveHost.style.cssText = 'margin-bottom:6px;';
    card.appendChild(waveHost);

    const bar = document.createElement('div');
    bar.className = 'row';
    bar.style.cssText = 'margin:0;gap:6px;flex-wrap:wrap;';
    bar.innerHTML =
      '<button class="btn" data-sep-import="' + escAttr(x.path) + '">导入素材池</button>'
      + '<button class="btn" data-sep-insert="' + escAttr(x.path) + '">插入播放头</button>'
      + '<button class="btn ghost" data-sep-reveal="' + escAttr(x.path) + '">定位</button>';
    card.appendChild(bar);
    box.appendChild(card);

    if (window.vhWave) {
      try {
        window.vhWave.mount(waveHost, x.path, { color: x.color, height: 54 });
      } catch (e) { console.warn('[sep] wave', e); }
    }
  });
}
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

// ---------- 音频片段属性 ----------

/** 声音面板不再有独立时间线下拉；保留占位避免复用时报错 */
function fillSoundTimelineSelect() {
  return;
}


// ==================== 本地引擎自检 ====================

async function loadSoundCaps() {
  const box = $('sndCaps');
  const detail = $('sndCapsDetail');
  if (!box) return;
  try {
    const c = await call(H.svcCapabilities);
    const ready = c.hasFfmpeg && c.hasSeparation;
    box.textContent = ready ? '就绪' : '部分缺失';
    box.className = 'mini' + (ready ? '' : ' warn');
    const lines = [];
    lines.push('ffmpeg：' + (c.hasFfmpeg ? '已就绪' : '★缺失'));
    lines.push('人声分离：' + (c.hasSeparation ? '已就绪' : '★缺失（需要 sherpa 引擎与 spleeter 模型）'));
    if (!c.hasFfmpeg && !c.hasSeparation) {
      lines.push('把 PR 版插件目录里的 bin/ 与 models/spleeter/ 复制到达芬奇版对应目录即可。');
    }
    lines.push('工作目录：' + c.workDir);
    detail.innerHTML = lines.map(l => esc(l)).join('<br>');
    const run = $('btnSepRun');
    if (run && !c.hasSeparation) run.disabled = true;
  } catch (e) {
    box.textContent = '检测失败';
    detail.textContent = e.message;
  }
}

// ==================== 人声分离绑定 ====================

function bindSeparate() {
  const pick = $('btnSepPick');
  if (pick) pick.addEventListener('click', pickSepInput);
  const fromSel = $('btnSepFromSel');
  if (fromSel) fromSel.addEventListener('click', useSelectedClip);
  const run = $('btnSepRun');
  if (run) run.addEventListener('click', runSeparation);

  const box = $('sepResults');
  if (box) {
    box.addEventListener('click', async (e) => {
      const t = e.target;
      const play = t.getAttribute && t.getAttribute('data-sep-play');
      const imp = t.getAttribute && t.getAttribute('data-sep-import');
      const ins = t.getAttribute && t.getAttribute('data-sep-insert');
      const rev = t.getAttribute && t.getAttribute('data-sep-reveal');
      if (play) { await previewSfxLocal(play); return; }
      if (rev) { await call(H.revealFile, rev).catch(() => {}); return; }
      if (imp) {
        try {
          const r = await call(H.importFilesToPool, [imp], '人声分离');
          toast('已导入：' + (r.names || []).join(', '), 'ok');
        } catch (e2) { toast('导入失败：' + e2.message, 'err'); }
        return;
      }
      if (ins) {
        try {
          const ph = await call(H.getPlayhead, '');
          await call(H.insertAudioToTimeline, { path: ins, recordFrame: ph.frames, folderName: '人声分离' });
          toast('已插入播放头 ' + (ph.timecode || ''), 'ok');
        } catch (e2) { toast('插入失败：' + e2.message, 'err'); }
      }
    });
  }
  loadSoundCaps();
}

/** 试听本地文件（分离产物用），与音效库同机制 */
async function previewSfxLocal(filePath) {
  try {
    const r = await call(H.readAudioDataUrl, filePath);
    const url = r && r.dataUrl ? r.dataUrl : (r && r.data && r.data.dataUrl);
    if (!url) throw new Error('无法读取音频');
    const a = new Audio(url);
    a.volume = 0.8;
    a.play();
    toast('试听：' + String(filePath).split(/[\\/]/).pop(), 'ok');
  } catch (e) {
    toast('试听失败：' + e.message, 'err');
  }
}

// ==================== 关于 ====================

async function showAbout() {
  const body = $('aboutBody');
  body.textContent = '读取中…';
  $('aboutOverlay').style.display = 'flex';
  try {
    const info = await call(H.appInfo);
    const ping = await call(H.ping).catch(e => ({ error: e.message }));
    body.textContent = [
      '插件：vh-Atelier (DaVinci Resolve 版)',
      '版本：' + info.pluginVersion,
      '插件目录：' + info.pluginDir,
      '',
      '— 运行环境 —',
      'Electron：' + info.electron,
      'Node：' + info.node,
      'Chromium：' + info.chrome,
      '平台：' + info.platform + ' / ' + info.arch,
      '',
      '— Resolve 连接 —',
      JSON.stringify(ping, null, 2)
    ].join('\n');
  } catch (e) {
    body.textContent = '诊断失败：' + e.message;
  }
}

// ==================== 在线更新 ====================

function updMsg(text) {
  const body = $('aboutBody');
  if (body) body.textContent = text;
}

/** 检查更新：有新版本则询问是否升级 */
async function checkUpdateFlow(silent) {
  const D = function (m) { try { window.__vhDiagLog && window.__vhDiagLog(m); } catch (e) {} };
  // 防抖：自动检查 + 按钮点击可能同时触发，会弹多个窗互相覆盖
  if (window.__updRunning) {
    D('[更新] 已有检查在进行，忽略');
    return;
  }
  window.__updRunning = true;
  setTimeout(function () { window.__updRunning = false; }, 10000);

  D('[更新] 进入 checkUpdateFlow silent=' + silent);

  if (!silent) updMsg('正在检查更新…');

  const H = window.vhHost;
  D('[更新] vhHost=' + (H ? 'ok' : '缺失') + ' updateCheck=' + (H ? typeof H.updateCheck : 'N/A'));
  if (!H || !H.updateCheck) {
    if (!silent) updMsg('宿主桥不支持在线更新（vhHost.updateCheck 缺失）');
    D('[更新] 中止：updateCheck 不存在');
    return;
  }

  D('[更新] 调用 H.updateCheck()');
  let r;
  try {
    r = await H.updateCheck();
    D('[更新] updateCheck 返回 ok=' + (r && r.ok));
  } catch (e) {
    D('[更新] updateCheck 抛错: ' + (e.message || e));
    if (!silent) {
      try { await showUpdConfirm({ kind: 'error', local: '', remote: '', error: (e.message || String(e)) }); }
      catch (e2) { updMsg('检查更新失败：' + (e.message || e)); }
    }
    return;
  }

  if (!r || !r.ok) {
    const errMsg = (r && r.error) || '未知错误';
    D('[更新] 失败: ' + errMsg);
    if (!silent) {
      try { await showUpdConfirm({ kind: 'error', local: '', remote: '', error: errMsg }); }
      catch (e) { updMsg('检查失败：' + errMsg); }
    }
    return;
  }

  const d = r.data || {};
  D('[更新] local=' + d.local + ' remote=' + d.remote + ' newer=' + d.newer);

  if (!d.newer) {
    D('[更新] 已是最新，弹窗告知');
    if (!silent) {
      try { await showUpdConfirm({ kind: 'latest', local: d.local, remote: d.remote }); }
      catch (e) { updMsg('已是最新版本：' + d.local); }
    }
    return;
  }

  // 自动检查（silent）只在有新版本时才弹窗，避免每次启动都打扰；
  // 手动检查（点按钮）任何结果都弹。
  if (silent) {
    D('[更新] 自动检查发现有新版本，弹窗');
  }
  D('[更新] 弹确认窗');
  let ok = false;
  try {
    ok = await showUpdConfirm(d);
    D('[更新] 用户选择: ' + ok);
  } catch (e) {
    D('[更新] 弹窗异常: ' + (e.message || e));
    if (!silent) updMsg('弹窗失败：' + (e.message || e));
    return;
  }

  if (!ok) { if (!silent) updMsg('已取消更新'); return; }

  D('[更新] 开始下载安装');
  updMsg('正在下载并安装更新…\n\n请稍候，不要关闭插件。');

  let r2;
  try {
    r2 = await H.updateRun(d);
    D('[更新] updateRun 返回 ok=' + (r2 && r2.ok));
  } catch (e) {
    D('[更新] updateRun 抛错: ' + (e.message || e));
    updMsg('更新调用失败：' + (e.message || e));
    return;
  }

  if (!r2 || !r2.ok) {
    updMsg('更新失败：' + ((r2 && r2.error) || '未知错误') + '\n\n可重启 Resolve 后重试，或用部署包覆盖安装。');
    D('[更新] 失败');
    return;
  }

  const d2 = r2.data || {};
  if (d2.ok === false) {
    updMsg('更新失败：' + (d2.error || '服务端返回失败') + '\n\n可重启 Resolve 后重试，或用部署包覆盖安装。');
    D('[更新] 内层失败: ' + (d2.error || ''));
    return;
  }

  D('[更新] 完成，文件数 ' + d2.count);
  updMsg(
    '✅ 更新完成\n\n' +
    '已更新 ' + (d2.count || 0) + ' 个文件\n' +
    '新版本：' + (d2.version || d.remote) + '\n' +
    (d2.failedCount ? ('\n⚠ ' + d2.failedCount + ' 个文件写入失败（可能被占用）\n') : '') +
    '\n请关闭插件面板并重新打开（或重启 Resolve）以生效。'
  );
}

// showPanel 也挂全局（顶部反馈按钮要跳转）
try { window.showPanel = showPanel; } catch (e) {}

// 暴露给顶部按钮（topbar.js）调用
window.checkUpdateFlow = checkUpdateFlow;

/** 自绘更新确认弹窗（统一 UI，替代原生 confirm） */
function showUpdConfirm(d) {
  var D = function (m) { try { window.__vhDiagLog && window.__vhDiagLog(m); } catch (e) {} };
  // kind: 'update' 有更新 | 'latest' 已是最新 | 'error' 检查失败
  var kind = d.kind || 'update';
  return new Promise(function (resolve) {
    D('[弹窗] 开始创建');
    var old = document.getElementById('updConfirmMask');
    if (old && old.parentNode) old.parentNode.removeChild(old);

    // 与「版本更新历史」弹窗完全一致的视觉与结构
    var mask = document.createElement('div');
    mask.id = 'updConfirmMask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:100600;'
      + 'display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#1e2229;border:1px solid #39414d;border-radius:10px;'
      + 'width:640px;max-width:100%;max-height:78vh;display:flex;flex-direction:column;'
      + 'box-shadow:0 16px 50px rgba(0,0,0,.7);';

    box.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;padding:12px 15px;'
      + 'border-bottom:1px solid #2b3340;">'
      + '<span style="font-size:13.5px;font-weight:600;color:#e6eef6;">'
      + (kind === 'latest' ? '已是最新版本' : (kind === 'error' ? '检查更新失败' : '发现新版本')) + '</span>'
      + '<span style="font-size:11px;color:#7d8794;">'
      + (kind === 'latest'
          ? ('v' + (d.remote || d.local || '?'))
          : ('v' + (d.local || '?') + ' → v' + (d.remote || '?'))) + '</span>'
      + '<button id="updClose" class="secondary mini" style="margin-left:auto;">关闭</button>'
      + '</div>'
      + '<div id="updBody" style="padding:10px 15px;overflow:auto;flex:1;'
      + 'font-size:11.5px;color:#c3cfdb;line-height:1.7;"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;padding:10px 15px 13px;'
      + 'border-top:1px solid #2b3340;">'
      + (kind === 'update'
          ? '<button id="updCancel" class="secondary mini">稍后</button>'
            + '<button id="updOk" class="primary mini">立即更新</button>'
          : '<button id="updOk" class="primary mini">知道了</button>')
      + '</div>';

    mask.appendChild(box);
    document.body.appendChild(mask);

    // 内容区
    var body = document.getElementById('updBody');
    var html = '';

    if (kind === 'latest') {
      html = '<div style="color:#8a97a5;padding:6px 0;">当前已是最新版本，无需更新。</div>';
      if (body) body.innerHTML = html;
      D('[弹窗] 已是最新');
    } else if (kind === 'error') {
      html = '<div style="color:#ff9a9a;padding:6px 0;">' + (d.error || '未知错误') + '</div>'
           + '<div style="font-size:10.5px;color:#7d8794;margin-top:10px;">'
           + '可检查网络后重试；多次失败可用部署包覆盖安装。</div>';
      if (body) body.innerHTML = html;
      D('[弹窗] 检查失败');
    } else {
    if (d.buildTime) {
      html += '<div style="font-size:11px;color:#6f7c8a;margin-bottom:8px;">发布时间 '
           + d.buildTime + '</div>';
    }
    if (d.notes) {
      var lines = String(d.notes).split(/[\uff1b;\n]/).filter(function (x) { return x.trim(); });
      html += '<div style="margin-bottom:6px;">更新内容</div>';
      html += '<ul style="margin:0;padding-left:16px;">';
      lines.forEach(function (l) {
        html += '<li style="margin:3px 0;">' + l.trim() + '</li>';
      });
      html += '</ul>';
    } else {
      html += '<div style="color:#8a97a5;">本次更新未提供说明。</div>';
    }
    html += '<div style="margin-top:12px;font-size:10.5px;color:#7d8794;">'
         + '更新约需 1 分钟，完成后需重新打开插件面板。</div>';
    if (body) body.innerHTML = html;
    }

    D('[弹窗] 已挂到页面, mask=' + !!document.getElementById('updConfirmMask')
      + ' bodyLen=' + (body ? body.innerHTML.length : 0));

    function close(v) {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      D('[弹窗] 关闭, 返回值=' + v);
      resolve(v);
    }
    var bOk = document.getElementById('updOk');
    var bCancel = document.getElementById('updCancel');
    var bClose = document.getElementById('updClose');
    if (bOk) bOk.addEventListener('click', function () { close(true); });
    if (bCancel) bCancel.addEventListener('click', function () { close(false); });
    if (bClose) bClose.addEventListener('click', function () { close(false); });
    mask.addEventListener('click', function (ev) { if (ev.target === mask) close(false); });
  });
}

// 登录成功后默认停在「账号」页（用户要求）
(function () {
  function goAccount() {
    try {
      if (typeof showPanel === 'function') showPanel('account');
    } catch (e) {}
  }
  function watch() {
    var UI = window.__vhLicenseUI;
    if (!UI) { setTimeout(watch, 400); return; }
    if (UI.onUnlock) {
      UI.onUnlock(function () { setTimeout(goAccount, 200); });
    }
    // 已经解锁（本地有效）：直接切
    try {
      if (UI.isUnlocked && UI.isUnlocked()) setTimeout(goAccount, 300);
    } catch (e) {}
  }
  window.__firstAfterLogin = true;
  setTimeout(watch, 300);
})();

// ==================== 初始化 ====================
// 启动后静默检查一次更新（不打扰用户，只在有新版本时提示）
setTimeout(function () { try { checkUpdateFlow(true); } catch (e) {} }, 6000);


/** 显示指定面板（panel-<tab>），同步子标签行与一级分组的选中态 */
function showPanel(tab) {
  // 0) 内嵌浏览器视图是「覆盖层」，不属于 DOM，必须显式销毁，
  //    否则切到别的面板后它仍盖在最上面（表现为整片白/黑）。
  if (window.__embedShownTab && window.__embedShownTab !== tab) {
    try {
      if (tab !== 'shenpian' && window.__spPanel && window.__spPanel.hide) window.__spPanel.hide();
    } catch (e) {}
  }
  window.__embedShownTab = tab;
  // 1) 面板
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.style.display = (p.id === 'panel-' + tab) ? '' : 'none';
  });
  // 2) 子标签行：只显示包含该 tab 的那一行
  let ownerGroup = null;
  document.querySelectorAll('.ws-subtabs').forEach(g => {
    const has = g.querySelector('.tab[data-tab="' + tab + '"]');
    g.style.display = has ? '' : 'none';
    if (has) ownerGroup = g.dataset.group;
  });
  // 3) 子标签选中态
  document.querySelectorAll('.tabs .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  // 4) 一级分组高亮：跟随所属分组（避免与子标签不同步）
  if (ownerGroup) {
    document.querySelectorAll('.ws-group').forEach(b => {
      b.classList.toggle('active', b.dataset.group === ownerGroup);
    });
  }
  // 面板按需初始化
  if (tab === 'subtitle') { fillSubTimelineSelect(); }
  if (tab === 'separate' || tab === 'sfx' || tab === 'musiclib') { fillSoundTimelineSelect(); }
  if (tab === 'sfx' && window.__sfxPanel) { try { window.__sfxPanel.init(); } catch (e) {} }
  if (tab === 'musiclib' && window.__mllibPanel) { try { window.__mllibPanel.init(); } catch (e) {} }
  if (tab === 'media' && window.__mediaPanel) { try { window.__mediaPanel.init(); } catch (e) {} }
  if (tab === 'script' && window.__scriptPanel) { try { window.__scriptPanel.init(); } catch (e) {} }
  if (tab === 'ncm' && window.__ncmPanel) { try { window.__ncmPanel.init(); } catch (e) {} }
  if (tab === 'bgm' && window.__bgmPanel) { try { window.__bgmPanel.init(); } catch (e) {} }
  if (tab === 'breeze' && window.__bzPanel) { try { window.__bzPanel.init(); } catch (e) {} }
  if (tab === 'shenpian' && window.__spPanel) { try { window.__spPanel.init(); } catch (e) {} }
  if (tab === 'upscale' && window.__upscalePanel) { try { window.__upscalePanel.init(); } catch (e) {} }
  if (tab === 'feedback' && window.__feedbackPanelOnShow) { try { window.__feedbackPanelOnShow(); } catch (e) {} }
  if (tab === 'account') {
    try {
      if (window.__accountOnShow) window.__accountOnShow();
    } catch (e) {}
  }
}
// 导航：一级工作台分组 + 二级子标签（对齐 PR 版）
function bindNav() {
  document.querySelectorAll('.ws-group').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.dataset.group;
      // 交给 showPanel 统一同步：分组的第一个子标签即该组的默认面板
      const bar = document.querySelector('.ws-subtabs[data-group="' + group + '"]');
      const first = bar ? bar.querySelector('.tab') : null;
      if (first) showPanel(first.dataset.tab);
      else {
        // 该组没有子标签（异常情况），至少保证高亮正确
        document.querySelectorAll('.ws-group').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });
  document.querySelectorAll('.tabs .tab').forEach(t => {
    t.addEventListener('click', () => {
      if (t.dataset.tab) showPanel(t.dataset.tab);
    });
  });
}

function bindTop() {
  $('btnRefreshTop').addEventListener('click', async () => {
    try {
      await refreshContext();
      await loadTimelines({ preferCurrent: true });
      renderVersions();
      const cur = state.timelines.filter(t => t.current)[0];
      toast(cur ? ('已刷新 · 当前时间线：' + cur.name) : '已刷新', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  $('btnAbout').addEventListener('click', showAbout);
  const _bcu = $('btnCheckUpdate');
  if (_bcu) _bcu.addEventListener('click', function () { checkUpdateFlow(false); });
  const _vb = $('verBadge');
  if (_vb) {
    _vb.style.cursor = 'pointer';
    _vb.title = '当前插件版本 · 点击检查更新';
    _vb.addEventListener('click', function () { checkUpdateFlow(false); });
  }
  $('btnCloseAbout').addEventListener('click', () => { $('aboutOverlay').style.display = 'none'; });
  $('aboutOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'aboutOverlay') $('aboutOverlay').style.display = 'none';
  });
}

function bindExport() {
  $('btnAddVersion').addEventListener('click', addVersion);
  $('btnResetVersions').addEventListener('click', () => {
    resetVersions();
    toast('已恢复默认三版本');
  });
  $('btnStartExport').addEventListener('click', startExport);
  $('btnStopExport').addEventListener('click', stopExport);

  $('chkAllTimelines').addEventListener('change', (e) => {
    state.selected.clear();
    if (e.target.checked) state.timelines.forEach(t => state.selected.add(t.name));
    renderTimelines(state.timelines.length ? undefined : undefined);
    const fpsEl = $('tlCount').textContent.match(/(\d+(?:\.\d+)?)fps/);
    updateExportSummary();
  });

  $('btnBrowseRoot').addEventListener('click', async () => {
    const start = ($('deliveryRoot').value || '').trim() || getLastDir();
    try {
      const dir = await call(H.pickFolder, start);
      if (!dir) return;
      $('deliveryRoot').value = dir;
      setLastDir(dir);
    } catch (e) {
      toast('选择目录失败：' + e.message, 'err');
    }
  });

  $('btnAutofill').addEventListener('click', autofillFromRoot);

  $('btnCopyResult').addEventListener('click', async () => {
    const rows = [...document.querySelectorAll('#resultList .res-row, #resultList .res-path')]
      .map(el => el.textContent.trim());
    const text = rows.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制结果', 'ok');
    } catch (e) {
      toast('复制失败', 'err');
    }
  });

  bindVersionEvents();
}

function bindMedia() {
  // 素材面板已由 js/media.js 接管；这里只在旧控件存在时兜底绑定
  const pf = $('btnPickFiles'); if (pf) pf.addEventListener('click', pickFiles);
  const cf = $('btnClearFiles'); if (cf) cf.addEventListener('click', () => { state.files = []; renderFiles(); });
  const di = $('btnDoImport'); if (di) di.addEventListener('click', doImport);
}

/** 单步容错：某一步失败不影响其它步骤与整体初始化 */
function safeStep(name, fn) {
  try { fn(); } catch (e) {
    console.warn('[init] ' + name + ' 失败：' + (e && e.message ? e.message : e));
  }
}

async function init() {
  try { bindTopButtonsSafe(); } catch (e) {}
  // 每一步独立容错，避免一处失败导致后续（尤其是连接状态）不执行
  safeStep('bindNav', bindNav);
  safeStep('bindTop', bindTop);
  safeStep('bindExport', bindExport);
  safeStep('bindMedia', bindMedia);
  safeStep('bindSubtitle', bindSubtitle);
  safeStep('bindSeparate', bindSeparate);

  state.versions = loadVersions();
  safeStep('renderVersions', renderVersions);
  safeStep('renderFiles', renderFiles);

  const lastRoot = getLastDir();
  if (lastRoot) $('deliveryRoot').value = lastRoot;

  try {
    state.unsubProgress = H.onExportProgress((snap) => {
      state.exporting = !!snap.running;
      renderProgress(snap);
    });
  } catch (e) { console.warn('[init] 进度订阅失败：' + e.message); }

  // 连接状态优先建立，失败也明确可见
  // 版本徽标：优先用 sys:version（含构建时间），拿不到则退回 appInfo
  try {
    const v = await call(H.getVersion);
    const badge = $('verBadge');
    if (badge) {
      const bt = v && v.buildTime ? new Date(v.buildTime) : null;
      const hhmm = bt ? (' · ' + String(bt.getHours()).padStart(2, '0') + ':' + String(bt.getMinutes()).padStart(2, '0')) : '';
      badge.textContent = 'v' + (v && v.version || '?') + hhmm;
      badge.title = '插件版本 ' + (v && v.version) + '\n页面构建时间：' + (bt ? bt.toLocaleString() : '未知')
        + '\n（若版本号与预期不符，说明 Resolve 未重新加载插件）';
      badge.className = 'ver-badge ok';
    }
  } catch (e) {
    const badge = $('verBadge');
    if (badge) { badge.textContent = 'v?'; badge.className = 'ver-badge bad'; badge.title = '读取版本失败：' + e.message; }
  }

  try {
    await refreshContext();
  } catch (e) {
    toast('未连接到 DaVinci Resolve：' + e.message, 'err');
  }

  try {
    await loadTimelines();
  } catch (e) { /* 已在内部提示 */ }

  try {
    state.presets = await call(H.renderPresets);
    renderVersions();
  } catch (e) { /* 预设读不到不阻塞 */ }

  // 默认落在「交付 / 多版本导出」
  try { showPanel('export'); } catch (e) { console.warn('[init] showPanel 失败：' + e.message); }
  // 音效库/音乐库的骨架已随 HTML 载入，这里只做一次轻量初始化
  if (window.__sfxPanel) { try { window.__sfxPanel.init(); } catch (e) {} }
  if (window.__mllibPanel) { try { window.__mllibPanel.init(); } catch (e) {} }
  if (window.__mediaPanel) { try { window.__mediaPanel.init(); } catch (e) {} }
  if (window.__scriptPanel) { try { window.__scriptPanel.init(); } catch (e) {} }
  if (window.__bzPanel) { try { window.__bzPanel.init(); } catch (e) {} }
  // 两个列表在无数据时显示空状态提示
  try {
    var s = window.__sfxPanel, sp = $('sfxEmpty');
    if (sp && !(s && s.hasData)) sp.style.display = '';
    var mm = window.__mllibPanel, mp = $('mllibEmpty');
    if (mp && !(mm && mm.hasData)) mp.style.display = '';
  } catch (e) {}
}

// 顶部按钮独立绑定（双保险：topbar.js 失效时仍可用）
// ==================== 诊断浮层（临时，用于定位 Resolve 内点击问题）====================
(function () {
  if (window.__vhDiagInstalled) return;
  window.__vhDiagInstalled = true;

  var box = null;
  var lines = [];
  window.__vhDiagLog = function (msg) {
    var t = new Date().toLocaleTimeString();
    lines.push(t + ' ' + msg);
    if (lines.length > 12) lines.shift();
    if (!box) {
      box = document.createElement('div');
      box.id = 'vhDiagBox';
      box.style.cssText = 'position:fixed;right:6px;bottom:6px;z-index:2147483600;'
        + 'background:rgba(0,0,0,.86);border:1px solid #4a5a6a;border-radius:6px;'
        + 'padding:6px 8px;font:10px/1.5 Consolas,monospace;color:#9fe0a0;'
        + 'max-width:420px;max-height:160px;overflow:auto;pointer-events:none;'
        + 'white-space:pre-wrap;word-break:break-all;';
      document.body.appendChild(box);
    }
    box.textContent = lines.join('\n');
  };

  // 核心：给顶部按钮加捕获阶段监听，记录是否真的收到点击
  function watch() {
    ['btnSite', 'btnHistory', 'btnUpdate', 'btnFeedback', 'btnAbout'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el || el.__diagWatched) return;
      el.__diagWatched = true;
      el.addEventListener('click', function (ev) {
        window.__vhDiagLog('[点击] ' + id + ' 已触发');
        // 检查是否被遮挡
        try {
          var r = el.getBoundingClientRect();
          var hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (hit !== el) {
            window.__vhDiagLog('  ⚠ 该位置命中 ' + (hit ? (hit.tagName + (hit.id ? '#' + hit.id : '')) : 'null'));
          }
        } catch (e) {}
      }, true);
    });

    // 全局点击探针：记录用户到底点到了什么
    if (!window.__diagGlobal) {
      window.__diagGlobal = true;
      document.addEventListener('click', function (ev) {
        var t = ev.target;
        var name = t ? (t.tagName + (t.id ? '#' + t.id : '') + (t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : '')) : 'null';
        // 只记录顶部区域的点击（y < 60）
        if (t && t.getBoundingClientRect && t.getBoundingClientRect().y < 60) {
          window.__vhDiagLog('[顶部点击] ' + name);
        }
      }, true);
    }
  }

  function init() {
    watch();
    window.__vhDiagLog('诊断已启动 v2.16');
    // 记录环境信息
    setTimeout(function () {
      var bu = document.getElementById('btnUpdate');
      if (bu) {
        var r = bu.getBoundingClientRect();
        window.__vhDiagLog('btnUpdate @ ' + Math.round(r.x) + ',' + Math.round(r.y)
          + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      }
      window.__vhDiagLog('窗口 ' + window.innerWidth + 'x' + window.innerHeight
        + ' dpr=' + (window.devicePixelRatio || 1));
      var mask = document.getElementById('licMask');
      window.__vhDiagLog('licMask=' + (mask ? '存在' : '无'));
    }, 1200);
    setTimeout(watch, 2500);
  }

  if (document.readyState === 'complete') setTimeout(init, 500);
  else window.addEventListener('load', function () { setTimeout(init, 500); });
})();

// 内联 onclick 的全局入口（最底层兜底，不依赖事件绑定）
window.vhTopUpdate = function () {
  try { window.__vhDiagLog && window.__vhDiagLog('[onclick] 更新'); } catch (e) {}
  try { checkUpdateFlow(false); return; } catch (e) {
    try { window.__vhDiagLog && window.__vhDiagLog('[onclick] checkUpdateFlow 异常: ' + e.message); } catch (e2) {}
  }
  var H = window.vhHost;
  if (H && H.updateCheck) {
    H.updateCheck().then(function (r) {
      var d = (r && r.ok && r.data) ? r.data : {};
      alert(d.newer ? ('发现新版本 ' + d.local + ' → ' + d.remote) : ('已是最新 ' + (d.local || '')));
    }).catch(function (e) { alert('检查失败：' + (e.message || e)); });
    return;
  }
  alert('更新功能不可用：宿主桥缺失');
};

window.vhTopAbout = function () {
  try { showAbout(); } catch (e) {
    var ov = document.getElementById('aboutOverlay');
    if (ov) { ov.style.display = 'flex'; return; }
    alert('关于弹窗不可用：' + (e.message || e));
  }
};

function bindTopButtonsSafe() {
  try {
    // 更新
    var bu = document.getElementById('btnUpdate');
    if (bu && !bu.__bound) {
      bu.__bound = true;
      bu.addEventListener('click', function () {
        try { checkUpdateFlow(false); }
        catch (e) { alert('更新出错：' + (e.message || e)); }
      });
    }
    // 历史
    var bh = document.getElementById('btnHistory');
    if (bh && !bh.__bound) {
      bh.__bound = true;
      bh.addEventListener('click', function () {
        try {
          if (window.__vhTopBar && window.__vhTopBar.showHistory) window.__vhTopBar.showHistory();
        } catch (e) { alert('历史打开失败：' + (e.message || e)); }
      });
    }
    // 官网
    var bs = document.getElementById('btnSite');
    if (bs && !bs.__bound) {
      bs.__bound = true;
      bs.addEventListener('click', function () {
        var H = window.vhHost;
        var url = 'http://47.122.108.231:8888/';
        if (H && H.openExternal) { try { H.openExternal(url); return; } catch (e) {} }
        try { window.open(url, '_blank'); } catch (e) {}
      });
    }
    // 反馈
    var bf = document.getElementById('btnFeedback');
    if (bf && !bf.__bound) {
      bf.__bound = true;
      bf.addEventListener('click', function () {
        try { showPanel('feedback'); } catch (e) {}
      });
    }
  } catch (e) { console.log('[topbtn] ' + e.message); }
}

window.addEventListener('DOMContentLoaded', init);
