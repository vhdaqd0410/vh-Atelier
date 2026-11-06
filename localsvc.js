'use strict';
/**
 * 本地服务编排（Electron 主进程）
 *
 * 职责：把随包分发的本地二进制（ffmpeg / sherpa 分离引擎）跑起来。
 * 与 PR 版的差异：PR 用「隐藏面板 bg/」拉起服务，这里直接用主进程 spawn，
 * 能拿到 stdout / stderr / 退出码，也不需要额外面板进程。
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 路径解析 ----------

/** 插件根目录（main.js 所在目录） */
function extRoot() {
  return __dirname;
}

/** 找可执行文件：优先插件自带，其次若干历史位置 */
function resolveBin(relCandidates) {
  const roots = [
    extRoot(),
    path.join(extRoot(), '..'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions', 'com.vh.atelier')
  ];
  for (const r of roots) {
    for (const rel of relCandidates) {
      const p = path.join(r, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** ffmpeg 的可执行路径 */
function ffmpegPath() {
  return resolveBin([
    path.join('bin', 'ffmpeg-win32-x64.exe'),
    path.join('bin', 'ffmpeg.exe'),
    'ffmpeg.exe'
  ]);
}

/** 人声分离组件（sherpa 引擎 + spleeter 模型） */
function separationAssets() {
  const exe = resolveBin([path.join('bin', 'sherpa', 'sherpa-onnx-offline-source-separation.exe')]);
  const dll = resolveBin([path.join('bin', 'sherpa', 'onnxruntime.dll')]);
  const shared = resolveBin([path.join('bin', 'sherpa', 'onnxruntime_providers_shared.dll')]);
  const vocals = resolveBin([path.join('models', 'spleeter')]).valueOf && resolveVocals();
  return { exe, dll, shared, vocals: vocals };
}

function resolveVocals() {
  const roots = [extRoot(), path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions', 'com.vh.atelier')];
  for (const r of roots) {
    const p = path.join(r, 'models', 'spleeter', 'sherpa-onnx-spleeter-2stems-fp16', 'vocals.fp16.onnx');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveAccomp() {
  const roots = [extRoot(), path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions', 'com.vh.atelier')];
  for (const r of roots) {
    const p = path.join(r, 'models', 'spleeter', 'sherpa-onnx-spleeter-2stems-fp16', 'accompaniment.fp16.onnx');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 工作目录（放中间产物），随包 collect/ 下，通常不进版本库 */
function workDir(sub) {
  const d = path.join(extRoot(), 'collect', '_sound');
  const target = sub ? path.join(d, sub) : d;
  try { fs.mkdirSync(target, { recursive: true }); } catch (e) { /* 忽略 */ }
  return target;
}

/** 能力探测：前端据此决定哪些按钮可用 */
function capabilities() {
  const ff = ffmpegPath();
  const sepExe = resolveBin([path.join('bin', 'sherpa', 'sherpa-onnx-offline-source-separation.exe')]);
  const vocals = resolveVocals();
  const accomp = resolveAccomp();
  return {
    ffmpeg: ff,
    hasFfmpeg: !!ff,
    separationExe: sepExe,
    vocalsModel: vocals,
    accompanimentModel: accomp,
    hasSeparation: !!(sepExe && vocals && accomp),
    platform: process.platform,
    workDir: workDir()
  };
}

// ---------- 通用执行 ----------

/** 跑一个进程，返回 { code, stdout, stderr }；onLine 可实时拿到输出行 */
function run(file, args, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { cwd: o.cwd || undefined, windowsHide: true });
    } catch (e) {
      reject(new Error('启动失败：' + e.message)); return;
    }
    let out = '', err = '';
    const onLine = o.onLine;
    const splitLines = (buf, isErr) => {
      const s = buf.toString('utf8');
      if (isErr) err += s; else out += s;
      if (onLine) {
        s.split(/\r?\n/).filter(x => x.trim()).forEach(x => onLine(x));
      }
    };
    if (child.stdout) child.stdout.on('data', d => splitLines(d, false));
    if (child.stderr) child.stderr.on('data', d => splitLines(d, true));
    child.on('error', e => reject(new Error('执行失败：' + e.message)));
    child.on('close', code => resolve({ code: code, stdout: out, stderr: err }));
    if (o.timeoutMs) {
      setTimeout(() => { try { child.kill(); } catch (e) {} }, o.timeoutMs);
    }
  });
}

// ---------- 具体任务 ----------

/** 读媒体信息（时长 / 采样率 / 声道） */
async function probe(filePath) {
  const ff = ffmpegPath();
  if (!ff) throw new Error('ffmpeg 不可用');
  if (!fs.existsSync(filePath)) throw new Error('文件不存在：' + filePath);
  // ffmpeg -i 会把信息打到 stderr
  const r = await run(ff, ['-hide_banner', '-i', filePath]);
  const info = { file: filePath, text: r.stderr };
  const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(r.stderr);
  if (m) info.durationSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  const a = /Audio:\s*([^,\n]+),?\s*(\d+)\s*Hz,\s*([^\n,]+)/.exec(r.stderr);
  if (a) { info.audioCodec = a[1].trim(); info.sampleRate = +a[2]; info.channelsRaw = a[3].trim(); }
  const chm = /Audio:.*?Hz,\s*([^,\n]+)/.exec(r.stderr);
  if (chm) {
    const s = chm[1];
    if (/stereo/i.test(s)) info.channels = 2;
    else if (/mono/i.test(s)) info.channels = 1;
  }
  return info;
}

/**
 * 探测音频真实时长（秒）。
 * 优先用 ffmpeg 解析 Duration；失败时按 48k/2ch/16bit 估算兜底。
 * 之所以不用「文件大小 ÷ 码率」单一估算：切片为空、变码率、单声道都会算偏。
 */
async function probeAudioSeconds(file, sizeHint) {
  const ff = ffmpegPath();
  if (!ff) return (Number(sizeHint) || 0) / 192000;
  try {
    const r = await run(ff, ['-hide_banner', '-i', file], { timeoutMs: 20000 });
    const txt = String(r.stderr || '') + String(r.stdout || '');
    const m = txt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const sec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
      if (isFinite(sec) && sec >= 0) return sec;
    }
  } catch (e) { /* 探测失败走估算 */ }
  return (Number(sizeHint) || 0) / 192000;
}

/** 从媒体里切一段音频成 wav（供分离使用） */
async function extractAudio(opts) {
  const o = opts || {};
  const ff = ffmpegPath();
  if (!ff) throw new Error('ffmpeg 不可用');
  if (!o.input) throw new Error('缺少输入文件');
  if (!fs.existsSync(o.input)) throw new Error('输入文件不存在：' + o.input);

  const outDir = o.outDir || workDir('tmp');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* 忽略 */ }
  const out = o.output || path.join(outDir, 'extract_' + Date.now() + '.wav');

  const args = [];
  if (o.startSec !== undefined && o.startSec !== null && o.startSec !== '') {
    args.push('-ss', String(Number(o.startSec)));
  }
  if (o.durationSec !== undefined && o.durationSec !== null && o.durationSec !== '') {
    args.push('-t', String(Number(o.durationSec)));
  }
  args.push('-i', o.input, '-vn', '-ac', '2', '-ar', '48000', '-y', out);

  const r = await run(ff, args, { timeoutMs: 30 * 60 * 1000, onLine: o.onLine });
  if (r.code !== 0 || !fs.existsSync(out)) {
    throw new Error('提取音频失败：' + (r.stderr || '').split('\n').slice(-3).join(' '));
  }
  return { output: out, sizeBytes: fs.statSync(out).size };
}

/**
 * 人声分离（sherpa 引擎 + spleeter 2-stem 模型）。
 * 流程：提取音频 -> 跑分离引擎 -> 产出 vocals / accompaniment 两条 wav。
 */
async function separateVocals(opts) {
  const o = opts || {};
  const caps = capabilities();
  if (!caps.hasSeparation) {
    throw new Error('人声分离组件缺失（需要 bin/sherpa 引擎与 models/spleeter 模型）');
  }
  if (!o.input) throw new Error('缺少输入文件');
  if (!fs.existsSync(o.input)) throw new Error('输入文件不存在：' + o.input);

  const outDir = o.outDir || workDir('separate');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* 忽略 */ }
  const ts = Date.now();
  // 用纯 ASCII 名，引擎处理不了中文文件名
  const outVocals = path.join(outDir, 'voice_' + ts + '.wav');
  const outAccomp = path.join(outDir, 'music_' + ts + '.wav');
  const inputWav = path.join(outDir, 'input_' + ts + '.wav');

  // 1. 提取音频
  if (o.onLine) o.onLine('提取音频…');
  await extractAudio({
    input: o.input,
    startSec: o.startSec,
    durationSec: o.durationSec,
    output: inputWav,
    outDir: outDir
  });

  // 1.5 时长校验：sherpa 引擎对极短音频会整数除零崩溃（0xC0000094），提前拦住。
  //     用真实探测时长（不是按文件大小估算），并把「切出来是空的」与「本来就短」区分开，
  //     否则用户会看到「9 秒的片段提示音频过短」这种误导信息。
  try {
    const st = fs.statSync(inputWav);
    const realSec = await probeAudioSeconds(inputWav, st.size);
    if (realSec < 0.5) {
      const empty = st.size < 4096;
      try { fs.unlinkSync(inputWav); } catch (e) { /* 忽略 */ }
      if (empty) {
        throw new Error('截取区间落在素材之外，没有取到音频。'
          + '请改用「选择文件…」直接指定素材，或清空「起始秒」改为整段处理。');
      }
      throw new Error('音频过短（约 ' + realSec.toFixed(2) + ' 秒），分离至少需要 0.5 秒');
    }
  } catch (e) {
    if (String(e.message).indexOf('音频过短') === 0
        || String(e.message).indexOf('截取区间') === 0) throw e;
    // stat / 探测失败不阻断，继续
  }

  // 2. 跑分离引擎
  if (o.onLine) o.onLine('分离人声与伴奏…');
  const t0 = Date.now();
  const args = [
    '--spleeter-vocals=' + caps.vocalsModel,
    '--spleeter-accompaniment=' + caps.accompanimentModel,
    '--num-threads=4',
    '--input-wav=' + inputWav,
    '--output-vocals-wav=' + outVocals,
    '--output-accompaniment-wav=' + outAccomp
  ];
  const r = await run(caps.separationExe, args, {
    cwd: path.dirname(caps.separationExe),
    timeoutMs: 60 * 60 * 1000,
    onLine: o.onLine
  });
  // 只要产物存在就算成功：引擎把进度日志写在 stdout/stderr，不能当错误内容
  if (!fs.existsSync(outVocals)) {
    const tail = String((r.stderr || '') + '\n' + (r.stdout || ''))
      .split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
    // 0xC0000094 整数除零：引擎在音频过短/异常时崩溃
    if (r.code === 3221225620 || r.code === -1073741676) {
      throw new Error('分离引擎异常退出（音频可能过短或损坏），换一段更长的音频试试');
    }
    throw new Error('分离未产出人声轨（退出码 ' + r.code + '）：' + (tail || '无输出'));
  }

  // 清理输入中间件
  try { fs.unlinkSync(inputWav); } catch (e) { /* 忽略 */ }

  return {
    vocals: outVocals,
    accompaniment: outAccomp,
    vocalsBytes: fs.existsSync(outVocals) ? fs.statSync(outVocals).size : 0,
    accompanimentBytes: fs.existsSync(outAccomp) ? fs.statSync(outAccomp).size : 0,
    seconds: Math.round((Date.now() - t0) / 1000)
  };
}

/** 转成 mp3（导入时间线更通用，体积也小） */
async function toMp3(opts) {
  const o = opts || {};
  const ff = ffmpegPath();
  if (!ff) throw new Error('ffmpeg 不可用');
  if (!o.input || !fs.existsSync(o.input)) throw new Error('输入文件不存在：' + (o.input || ''));
  const out = o.output || o.input.replace(/\.[^.]+$/, '') + '.mp3';
  const r = await run(ff, ['-i', o.input, '-vn', '-b:a', o.bitrate || '192k', '-y', out],
                      { timeoutMs: 30 * 60 * 1000 });
  if (r.code !== 0 || !fs.existsSync(out)) {
    throw new Error('转 mp3 失败：' + (r.stderr || '').split('\n').slice(-3).join(' '));
  }
  return { output: out, sizeBytes: fs.statSync(out).size };
}

module.exports = {
  capabilities,
  probe,
  extractAudio,
  probeAudioSeconds,
  separateVocals,
  toMp3,
  ffmpegPath,
  workDir,
  run
};
