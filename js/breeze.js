// vh-Atelier · Breeze 语音合成面板（原生实现，直调 breeze-cli）
// 设计要点：
//   1. 不用 iframe、不用本地 HTTP 服务生成 —— 每次生成起一个 cli 子进程
//   2. 进度从 cli 的 stderr/stdout 实时解析 "generated N.NN s"
//   3. 停止 = taskkill 进程树，彻底释放显存，不会卡在"正在生成"
//   4. 音色库复用 Breeze 的 /v1/voices（需 engine 服务在线）→ 改为读 voices 目录
(function () {
    'use strict';

    var cs = null;
    try { cs = new CSInterface(); } catch (e) {}

    var fs = null, path = null, os = null, childProcess = null;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        childProcess = require('child_process');
    } catch (e) { console.log('[breeze] Node 不可用'); }

    var extRoot = (cs && cs.getSystemPath) ? cs.getSystemPath(SystemPath.EXTENSION) : '';
    var BZ_DIR = extRoot ? path.join(extRoot, 'breeze') : '';
    var ENGINE_DIR = BZ_DIR ? path.join(BZ_DIR, 'engine') : '';
    var MODEL_DIR = BZ_DIR ? path.join(BZ_DIR, 'models') : '';
    // 输出目录不再写死：由 js/audio-out.js 统一管理（可在设置里自定义）。
    // 保留 DEFAULT_OUTPUT_DIR 作为兜底，audio-out 模块没加载时仍能工作。
    var DEFAULT_OUTPUT_DIR = BZ_DIR ? path.join(BZ_DIR, 'output') : '';
    function outputDir() {
        try {
            if (window.__vhAudioOut && window.__vhAudioOut.getDir) {
                var d = window.__vhAudioOut.getDir();
                if (d) return d;
            }
        } catch (e) {}
        return DEFAULT_OUTPUT_DIR;
    }
    // 兼容旧代码里 OUTPUT_DIR 的读法（生成时 recomputeOutputDir 会更新它）
    var OUTPUT_DIR = outputDir();
    function recomputeOutputDir() {
        OUTPUT_DIR = outputDir();
        return OUTPUT_DIR;
    }
    var VOICES_DIR = ENGINE_DIR ? path.join(ENGINE_DIR, 'voices') : '';

    var CLI = ENGINE_DIR ? path.join(ENGINE_DIR, 'breeze-cli.exe') : '';
    var MODEL = MODEL_DIR ? path.join(MODEL_DIR, 'breeze-tts-2-q4_k-dd2.gguf') : '';

    // ---------- 状态 ----------
    var busy = false;
    var genProc = null;          // 当前生成的 cli 进程
    var stopRequested = false;
    var genStartAt = 0;
    var genTick = null;
    var genLines = [];           // 收集 cli 输出用于诊断
    var lastOutWav = null;       // 最近生成的 wav（供「送到时间轴」用）
    var currentResultWav = null; // 结果区当前显示的那个文件（与 lastOutWav 应对齐）
    var refWavPath = null;       // 当前参考音频
    var refDuration = 0;
    var mode = 'design';
    var waveInst = null, resultWaveInst = null;
    var voiceMap = {};           // 中文名映射

    // ---------- DOM ----------
    function $(id) { return document.getElementById(id); }
    var el = {};

    function initEl() {
        el.modelCard = $('bzModelCard');
        el.modelBar = $('bzModelBar');
        el.modelStat = $('bzModelStat');
        el.btnDlModel = $('bzBtnDlModel');

        el.voiceSel = $('bzVoiceSel');
        el.btnUseVoice = $('bzBtnUseVoice');
        el.btnRefreshVoice = $('bzBtnRefreshVoice');
        el.voiceHint = $('bzVoiceHint');

        el.srcSel = $('bzSrcSel');
        el.btnGrab = $('bzBtnGrab');
        el.grabHint = $('bzGrabHint');
        el.inOutRow = $('bzInOutRow');
        el.trackSel = $('bzTrackSel');
        el.btnRefreshTrack = $('bzBtnRefreshTrack');
        el.presetSel = $('bzPresetSel');
        el.btnRefreshPreset = $('bzBtnRefreshPreset');

        el.refInfo = $('bzRefInfo');
        el.waveBox = $('bzWaveBox');
        el.refText = $('bzRefText');
        el.btnAsr = $('bzBtnAsr');
        el.asrHint = $('bzAsrHint');

        el.modeRow = $('bzModeRow');
        el.modeHint = $('bzModeHint');
        el.text = $('bzText');
        el.designWrap = $('bzDesignWrap');
        el.directWrap = $('bzDirectWrap');
        el.instruction = $('bzInstruction');
        el.directText = $('bzDirectText');
        el.cfg = $('bzCfg');
        el.cfgVal = $('bzCfgVal');
        el.seed = $('bzSeed');
        el.btnDice = $('bzBtnDice');

        el.saveWrap = $('bzSaveWrap');
        el.saveName = $('bzSaveName');
        el.btnSaveVoice = $('bzBtnSaveVoice');

        el.progWrap = $('bzProgWrap');
        el.progBar = $('bzProgBar');
        el.progText = $('bzProgText');
        el.btnGen = $('bzBtnGen');
        el.btnStop = $('bzBtnStop');

        el.resultWrap = $('bzResultWrap');
        el.resultInfo = $('bzResultInfo');
        el.resultWave = $('bzResultWave');
        el.btnInsert = $('bzBtnInsert');
        el.insertHint = $('bzInsertHint');
    }

    // ---------- 工具 ----------
    function setProgress(pct, text, indet) {
        if (!el.progWrap) return;
        el.progWrap.style.display = '';
        if (indet) {
            el.progBar.className = 'indet';
        } else {
            el.progBar.className = '';
            el.progBar.style.width = Math.min(100, Math.max(0, pct)) + '%';
        }
        if (text != null) el.progText.textContent = text;
    }

    function hideProgress() {
        if (el.progWrap) el.progWrap.style.display = 'none';
        if (el.progBar) { el.progBar.style.width = '0%'; el.progBar.className = ''; }
    }

    function setBusy(b) {
        busy = b;
        if (el.btnGen) el.btnGen.disabled = b;
        if (el.btnStop) el.btnStop.disabled = !b;
        if (el.btnGrab) el.btnGrab.disabled = b;
        if (el.btnAsr) el.btnAsr.disabled = b;
        if (el.btnSaveVoice) el.btnSaveVoice.disabled = b;
        if (el.btnUseVoice) el.btnUseVoice.disabled = b || !el.voiceSel.value;
        if (el.btnDlModel) el.btnDlModel.disabled = b;
    }

    function fmtSec(s) {
        s = Math.max(0, Number(s) || 0);
        var m = Math.floor(s / 60);
        var ss = (s % 60).toFixed(1);
        return m > 0 ? (m + '分' + ss + '秒') : (ss + '秒');
    }

    function evalJsx(code, cb) {
        if (!cs) { if (cb) cb('ERR:CSInterface 不可用'); return; }
        try {
            cs.evalScript(code, function (r) { if (cb) cb(String(r == null ? '' : r)); });
        } catch (e) { if (cb) cb('ERR:' + e.message); }
    }

    function parseHost(r) {
        var s = String(r == null ? '' : r).trim();
        if (!s) return { ok: false, msg: '宿主无返回' };
        if (s.indexOf('ERR:') === 0) return { ok: false, msg: s.slice(4) };
        var js = (s.indexOf('OK:') === 0) ? s.slice(3) : s;
        var d = null;
        try { d = JSON.parse(js); } catch (e) { return { ok: false, msg: s.slice(0, 150) }; }
        if (d && d.error) return { ok: false, msg: String(d.error), data: d };
        return { ok: true, data: d };
    }

    // ---------- 模型状态 ----------
    var PORT = 17892;

    function checkModel() {
        var ready = false;
        try {
            if (fs.existsSync(MODEL)) {
                var st = fs.statSync(MODEL);
                if (st.size > 1500 * 1024 * 1024) {
                    var fd = fs.openSync(MODEL, 'r');
                    var buf = Buffer.alloc(4);
                    fs.readSync(fd, buf, 0, 4, 0);
                    fs.closeSync(fd);
                    ready = buf.toString('ascii') === 'GGUF';
                }
            }
        } catch (e) {}

        if (el.modelCard) el.modelCard.style.display = ready ? 'none' : '';

        if (!ready) {
            // 从 Node 服务读下载进度（如果有）
            fetch('http://127.0.0.1:' + PORT + '/api/model/status')
                .then(function (r) { return r.json(); })
                .then(function (j) {
                    if (j.ready) { if (el.modelCard) el.modelCard.style.display = 'none'; return; }
                    if (el.modelBar) el.modelBar.style.width = (j.percent || 0) + '%';
                    if (el.modelStat) {
                        if (j.active) {
                            el.modelStat.textContent = j.percent.toFixed(1) + '% · '
                                + (j.done / 1024 / 1024).toFixed(0) + ' / '
                                + (j.total / 1024 / 1024).toFixed(0) + ' MB · '
                                + j.speed.toFixed(1) + ' MB/s';
                        } else if (j.done > 0) {
                            el.modelStat.textContent = '已下载 ' + (j.done / 1024 / 1024).toFixed(0) + ' MB，点「继续下载」';
                        } else {
                            el.modelStat.textContent = '尚未开始（约 2.3 GB）';
                        }
                    }
                    if (el.btnDlModel) el.btnDlModel.disabled = !!j.active;
                })
                .catch(function () {
                    if (el.modelStat) el.modelStat.textContent = '需要先启动一次 Breeze 服务才能下载';
                });
        }
        return ready;
    }

    function downloadModel() {
        if (el.btnDlModel) { el.btnDlModel.disabled = true; el.btnDlModel.textContent = '启动中…'; }
        fetch('http://127.0.0.1:' + PORT + '/api/model/download', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function () {
                if (el.btnDlModel) el.btnDlModel.textContent = '下载中…';
                setTimeout(checkModel, 1000);
            })
            .catch(function (e) {
                if (el.btnDlModel) { el.btnDlModel.disabled = false; el.btnDlModel.textContent = '重试'; }
                if (el.modelStat) el.modelStat.textContent = '下载请求失败：' + e.message;
            });
    }

    // ---------- 音色库（直接读 engine/voices 目录）----------
    function loadVoices() {
        if (!el.voiceSel) return;
        var list = [];
        try {
            if (fs.existsSync(VOICES_DIR)) {
                var files = fs.readdirSync(VOICES_DIR);
                files.forEach(function (f) {
                    if (!/\.breeze$/i.test(f)) return;
                    var id = f.replace(/\.breeze$/i, '');
                    list.push({ id: id, file: path.join(VOICES_DIR, f) });
                });
            }
        } catch (e) { console.log('[breeze] 读音色目录失败: ' + e.message); }

        // 同时尝试从 Node 服务拿（带秒数和逐字稿）
        var fill = function (arr) {
            el.voiceSel.innerHTML = '<option value="">（用下方参考音频）</option>';
            arr.forEach(function (v) {
                var o = document.createElement('option');
                o.value = v.id;
                var cn = voiceMap[v.id] || v.name || v.id;
                o.textContent = cn + (v.seconds ? '（' + v.seconds.toFixed(1) + 's）' : '');
                el.voiceSel.appendChild(o);
            });
            if (el.btnUseVoice) el.btnUseVoice.disabled = busy || !el.voiceSel.value;
            if (el.voiceHint) {
                el.voiceHint.textContent = arr.length
                    ? ('共 ' + arr.length + ' 个音色，选中后点「使用」')
                    : '还没有保存的音色。抓取参考音频后可在下方「保存当前参考音频为音色」。';
            }
        };

        fetch('http://127.0.0.1:' + PORT + '/v1/voices')
            .then(function (r) { return r.json(); })
            .then(function (arr) {
                if (Array.isArray(arr) && arr.length) {
                    var saved = arr.filter(function (v) { return v.saved; });
                    fill(saved.length ? saved : arr);
                } else {
                    fill(list);
                }
            })
            .catch(function () { fill(list); });
    }

    function useVoice() {
        var id = el.voiceSel ? el.voiceSel.value : '';
        if (!id) return;

        setRefAudio(null, '音色库：' + (voiceMap[id] || id), 0);

        // 从 Node 服务拿逐字稿
        fetch('http://127.0.0.1:' + PORT + '/v1/voices')
            .then(function (r) { return r.json(); })
            .then(function (arr) {
                var v = (arr || []).filter(function (x) { return x.id === id; })[0];
                if (v && v.ref_text && el.refText) {
                    el.refText.value = v.ref_text;
                    if (el.asrHint) el.asrHint.textContent = '已从音色库带入逐字稿';
                }
            })
            .catch(function () {});

        if (el.refInfo) {
            el.refInfo.textContent = '✓ 音色库「' + (voiceMap[id] || id) + '」';
            el.refInfo.classList.add('has');
        }
        if (el.refText) el.refText.placeholder = '音色已带逐字稿，可留空';
        console.log('[breeze] 使用音色: ' + id);
    }

    // ---------- 参考音频 ----------
    function setRefAudio(wavPath, label, duration) {
        refWavPath = wavPath;
        refDuration = duration || 0;

        if (el.refInfo) {
            el.refInfo.textContent = label || (wavPath ? path.basename(wavPath) : '尚未选择参考音频');
            if (wavPath) el.refInfo.classList.add('has');
            else el.refInfo.classList.remove('has');
        }

        destroyWave();
        if (!wavPath || !fs.existsSync(wavPath)) {
            if (el.waveBox) el.waveBox.style.display = 'none';
            return;
        }

        if (el.waveBox) el.waveBox.style.display = '';
        if (window.vhWave && el.waveBox) {
            try {
                waveInst = window.vhWave.mount(el.waveBox, wavPath, {
                    height: 40, color: '#8ab4ff', bg: 'rgba(0,0,0,.25)'
                });
            } catch (e) {
                el.waveBox.innerHTML = '<div class="hint">波形加载失败</div>';
            }
        }
    }

    function destroyWave() {
        try { if (waveInst && waveInst.destroy) waveInst.destroy(); } catch (e) {}
        waveInst = null;
    }

    function destroyResultWave() {
        try { if (resultWaveInst && resultWaveInst.destroy) resultWaveInst.destroy(); } catch (e) {}
        resultWaveInst = null;
    }

    // ---------- 取材 ----------
    function refreshTracks() {
        evalJsx('vcGetAudioTracks()', function (r) {
            var p = parseHost(r);
            var sel = el.trackSel;
            if (!sel) return;
            sel.innerHTML = '<option value="auto">自动（最完整）</option>';
            var arr = p.ok ? ((p.data && p.data.tracks) || (Array.isArray(p.data) ? p.data : null)) : null;
            if (arr && arr.length) {
                arr.forEach(function (t, i) {
                    var idx = (t.index != null) ? t.index : i;
                    var o = document.createElement('option');
                    o.value = String(idx);
                    o.textContent = 'A' + (idx + 1) + ' · ' + (t.name || '音频轨');
                    sel.appendChild(o);
                });
            }
        });
    }

    function refreshPresets() {
        var lib = window.__vhAudioPreset;
        if (!lib || !el.presetSel) return;
        var list = [];
        try { list = lib.scanAudioPresets() || []; } catch (e) {}
        el.presetSel.innerHTML = '';
        if (!list.length) {
            el.presetSel.innerHTML = '<option value="">（没找到音频预设）</option>';
            return;
        }
        list.forEach(function (p) {
            var o = document.createElement('option');
            o.value = p.full;
            o.textContent = p.name;
            el.presetSel.appendChild(o);
        });
        try {
            var saved = localStorage.getItem('vh_bz_preset') || '';
            var pick = lib.pickAudioPreset({ saved: saved, list: list });
            if (pick && pick.full) el.presetSel.value = pick.full;
        } catch (e) {}
    }

    function doGrab() {
        var src = el.srcSel ? el.srcSel.value : 'clip';
        if (src === 'clip') grabClip();
        else grabInOut();
    }

    function grabClip() {
        setProgress(-1, '正在抓取选中片段…', true);
        evalJsx('vcGetSelectedClipStr()', function (r) {
            var p = parseHost(r);
            if (!p.ok) { hideProgress(); alert('抓取失败：' + p.msg); return; }

            var root = p.data || {};
            var d = root.clip || root;
            var mediaPath = d.mediaPath || d.path || '';
            if (!mediaPath) { hideProgress(); alert('请先在时间轴选中一个音频片段'); return; }

            var ffmpeg = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
            if (!fs.existsSync(ffmpeg)) { hideProgress(); alert('找不到 ffmpeg'); return; }

            var inP = Number(d.inPoint || 0);
            var outP = Number(d.outPoint || 0);
            var dur = (outP > inP) ? Math.min(outP - inP, 30) : 30;

            var tmp = path.join(os.tmpdir(), 'bz_ref_' + Date.now() + '.wav');
            var args = ['-y', '-v', 'error'];
            if (inP > 0) args.push('-ss', String(inP));
            args.push('-t', String(dur), '-i', mediaPath, '-vn', '-map', '0:a',
                      '-ar', '24000', '-ac', '1', tmp);

            childProcess.execFile(ffmpeg, args, { timeout: 120000 }, function (err) {
                hideProgress();
                if (err || !fs.existsSync(tmp)) {
                    alert('截取失败：' + (err ? err.message : '未生成'));
                    return;
                }
                var secs = fs.statSync(tmp).size / 2 / 24000;
                setRefAudio(tmp, '时间轴片段：' + (d.clipName || '') + '（' + secs.toFixed(1) + '秒）', secs);
                if (el.asrHint) el.asrHint.textContent = '已抓取 ' + secs.toFixed(1) + ' 秒';
                autoRecognizeRef();
            });
        });
    }

    function grabInOut() {
        var preset = el.presetSel ? el.presetSel.value : '';
        if (!preset) { alert('请先选择导出预设（点 ↻ 加载）'); return; }

        setProgress(-1, '正在读取入出点…', true);
        evalJsx('vcGetInOutRangeStr()', function (r) {
            var p = parseHost(r);
            if (!p.ok) { hideProgress(); alert('读取失败：' + p.msg); return; }

            var d = p.data || {};
            if (!d.hasRange) { hideProgress(); alert('请先设置入点和出点（I / O）'); return; }

            var inSec = Number(d.inSec || 0);
            var outSec = Number(d.outSec || 0);
            if (outSec - inSec > 30) { hideProgress(); alert('区间超过 30 秒，请收紧'); return; }

            var tmpDir = path.join(os.tmpdir(), 'bz_range');
            try { if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}
            var rawOut = path.join(tmpDir, 'r_' + Date.now() + '.wav');

            var payload = {
                seqName: d.seqName || '',
                startSec: inSec,
                endSec: outSec,
                outPath: rawOut,
                presetPath: preset
            };

            setProgress(-1, '正在渲染区间…', true);
            evalJsx('meRangePayload = ' + JSON.stringify(payload) + ';', function () {
                evalJsx('meExportRangeStr()', function (r2) {
                    var s2 = String(r2 || '');
                    if (s2.indexOf('OK:') !== 0) {
                        hideProgress();
                        alert('渲染失败：' + s2.replace(/^ERR:/, ''));
                        return;
                    }
                    var out = s2.slice(3);
                    if (!fs.existsSync(out)) { hideProgress(); alert('渲染未产出文件'); return; }

                    var fin = function (wav) {
                        hideProgress();
                        var secs = fs.statSync(wav).size / 2 / 24000;
                        setRefAudio(wav, '入出点 ' + inSec.toFixed(1) + '~' + outSec.toFixed(1) + 's', secs);
                        if (el.asrHint) el.asrHint.textContent = '已抓取 ' + secs.toFixed(1) + ' 秒';
                        autoRecognizeRef();
                    };

                    if (/\.wav$/i.test(out)) { fin(out); return; }

                    var ffmpeg = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
                    var wavOut = out.replace(/\.[^.]+$/, '') + '_24k.wav';
                    childProcess.execFile(ffmpeg,
                        ['-y', '-v', 'error', '-i', out, '-vn', '-map', '0:a',
                         '-ar', '24000', '-ac', '1', wavOut],
                        { timeout: 120000 }, function (err) {
                            if (err || !fs.existsSync(wavOut)) { hideProgress(); alert('转码失败'); return; }
                            fin(wavOut);
                        });
                });
            });
        });
    }

    // ---------- 自动识别 ----------

    // ---------- whisper 中文路径规避 ----------
    // 实测：whisper-cli 在路径含中文时直接崩溃（退出码 3221226505）。
    // 引擎目录和模型文件都不能在中文路径下，音频文件不受影响。
    // 所以当插件装在中文路径（用户名是中文很常见）时，
    // 把引擎和模型镜像到 C:\ProgramData（纯 ASCII 且普通用户可写）再调用。
    //
    // 判断依据：路径里只要有一个非 ASCII 字符就要镜像。

    function hasNonAscii(s) {
        try {
            return /[^\x00-\x7F]/.test(String(s || ''));
        } catch (e) { return false; }
    }

    // 找一个可写的纯 ASCII 根目录
    function asciiRoot() {
        var cands = [
            'C:\\ProgramData\\vh-atelier\\whisper',
            'C:\\Windows\\Temp\\vh-atelier-whisper'
        ];
        for (var i = 0; i < cands.length; i++) {
            try {
                if (!fs.existsSync(cands[i])) fs.mkdirSync(cands[i], { recursive: true });
                // 试写确认
                var probe = path.join(cands[i], '.w');
                fs.writeFileSync(probe, 'ok');
                fs.unlinkSync(probe);
                return cands[i];
            } catch (e) {}
        }
        return '';
    }

    // 把 src 镜像到 dst（只在大小不同或不存在时复制）
    function mirrorFile(src, dst) {
        try {
            if (!fs.existsSync(src)) return false;
            var ss = fs.statSync(src).size;
            if (fs.existsSync(dst)) {
                try { if (fs.statSync(dst).size === ss) return true; } catch (e) {}
            }
            var dir = path.dirname(dst);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.copyFileSync(src, dst);
            return true;
        } catch (e) { return false; }
    }

    function mirrorDir(srcDir, dstDir) {
        try {
            if (!fs.existsSync(srcDir)) return;
            if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
            fs.readdirSync(srcDir).forEach(function (n) {
                var s = path.join(srcDir, n);
                var d = path.join(dstDir, n);
                var st;
                try { st = fs.statSync(s); } catch (e) { return; }
                if (st.isDirectory()) mirrorDir(s, d);
                else mirrorFile(s, d);
            });
        } catch (e) {}
    }

    // 给定引擎目录 + 模型路径，返回真正可用的 { exe, model, cuda }
    // 若路径含中文，会自动镜像到 ASCII 目录
    function prepareWhisper(engineBase, modelPath) {
        var cpuExe = path.join(engineBase, 'win32-x64', 'whisper-cli.exe');
        var cudaExe = path.join(engineBase, 'cuda', 'whisper-cli.exe');

        var needMirror = hasNonAscii(engineBase) || hasNonAscii(modelPath);

        if (!needMirror) {
            return { cpu: cpuExe, cuda: cudaExe, model: modelPath, mirrored: false };
        }

        var root = asciiRoot();
        if (!root) {
            // 找不到可写的 ASCII 目录，只能原样返回（大概率会崩，但至少不静默）
            console.log('[whisper] 无法创建 ASCII 中转目录，中文路径下可能崩溃');
            return { cpu: cpuExe, cuda: cudaExe, model: modelPath, mirrored: false, failed: true };
        }

        // 引擎：整个目录镜像过去（含 DLL）
        var mCpu = path.join(root, 'engine', 'win32-x64');
        var mCuda = path.join(root, 'engine', 'cuda');
        if (fs.existsSync(cpuExe)) mirrorDir(path.dirname(cpuExe), mCpu);
        if (fs.existsSync(cudaExe)) mirrorDir(path.dirname(cudaExe), mCuda);

        // 模型
        var mModel = path.join(root, 'models', path.basename(modelPath));
        mirrorFile(modelPath, mModel);

        return {
            cpu: path.join(mCpu, 'whisper-cli.exe'),
            cuda: path.join(mCuda, 'whisper-cli.exe'),
            model: mModel,
            mirrored: true,
            root: root
        };
    }

    function locateWhisper() {
        var hd = os.homedir();
        var cands = [
            path.join(extRoot, 'bin', 'whisper'),
            path.join(hd, 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions',
                      'com.zhang.whisper-subtitle', 'bin', 'whisper')
        ];
        var modelCands = [
            path.join(extRoot, 'models'),
            path.join(hd, 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions',
                      'com.zhang.whisper-subtitle', 'models')
        ];
        for (var i = 0; i < cands.length; i++) {
            var base = cands[i];
            var cu = path.join(base, 'cuda', 'whisper-cli.exe');
            var cp = path.join(base, 'win32-x64', 'whisper-cli.exe');
            if (!fs.existsSync(cu) && !fs.existsSync(cp)) continue;
            var mp = '';
            for (var m = 0; m < modelCands.length; m++) {
                var t = path.join(modelCands[m], 'ggml-large-v3-q5_0.bin');
                if (fs.existsSync(t)) { mp = t; break; }
            }
            if (!mp) {
                for (var m2 = 0; m2 < modelCands.length; m2++) {
                    var t2 = path.join(modelCands[m2], 'ggml-belle-large-v3-turbo-zh-q8_0.bin');
                    if (fs.existsSync(t2)) { mp = t2; break; }
                }
            }
            if (mp) return { cuda: cu, cpu: cp, model: mp, base: path.dirname(path.dirname(cp)) };
        }
        return null;
    }

    function detectCudaAvailable(cudaExe) {
        try {
            if (!cudaExe || !fs.existsSync(cudaExe)) return false;
            var cudaDir = path.dirname(cudaExe);
            var requiredDlls = ['cublas64_12.dll', 'cublasLt64_12.dll', 'ggml-cuda.dll', 'whisper.dll'];
            for (var i = 0; i < requiredDlls.length; i++) {
                if (!fs.existsSync(path.join(cudaDir, requiredDlls[i]))) return false;
            }
            var r = childProcess.spawnSync(cudaExe, ['--help'], {
                cwd: cudaDir, encoding: 'utf8', timeout: 15000
            });
            return r.status === 0;
        } catch (e) {
            return false;
        }
    }

    // 抓取完成后自动识别参考文字
    function autoRecognizeRef() {
        if (!refWavPath) return;
        setTimeout(function () { runAsr(true); }, 150);
    }

    function runAsr(isAuto) {
        if (!refWavPath) {
            if (!isAuto) alert('请先抓取参考音频或选择音色');
            return;
        }

        var w = locateWhisper();
        if (!w) {
            if (isAuto && el.asrHint) el.asrHint.textContent = '未找到 whisper 引擎，请手动填写文字';
            else alert('未找到 whisper 引擎；可手动填写文字');
            return;
        }

        // 中文路径规避：引擎/模型在含中文的路径下会让 whisper 崩溃，
        // 需要时先镜像到 C:\ProgramData 再调用（音频路径不受影响）。
        var prep = prepareWhisper(w.base || path.dirname(path.dirname(w.cpu || w.cuda)), w.model);
        var exe = detectCudaAvailable(prep.cuda) ? prep.cuda : prep.cpu;
        var modelPath = prep.model;

        var tmp = path.join(os.tmpdir(), 'bz_asr_' + Date.now());
        var wav16 = tmp + '_16k.wav';
        var ffmpeg = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');

        if (el.btnAsr) el.btnAsr.disabled = true;
        if (!isAuto) setProgress(-1, 'whisper 识别中（约 10-30 秒）…', true);
        if (el.asrHint) el.asrHint.textContent = isAuto ? '正在自动识别参考文字…' : '识别中…';

        childProcess.execFile(ffmpeg, ['-y', '-v', 'error', '-i', refWavPath,
                                       '-ar', '16000', '-ac', '1', wav16],
            { timeout: 60000 }, function (e1) {
                if (e1 || !fs.existsSync(wav16)) {
                    if (!isAuto) hideProgress();
                    if (el.btnAsr) el.btnAsr.disabled = false;
                    if (el.asrHint) el.asrHint.textContent = '音频转码失败，请手动填写';
                    return;
                }
                childProcess.execFile(exe,
                    ['-m', modelPath, '-l', 'auto', '-t', '4', '-osrt',
                     '-of', tmp, '-nf', '-sns', wav16],
                    { cwd: path.dirname(exe), timeout: 300000, maxBuffer: 50 * 1024 * 1024 },
                    function (e2) {
                        if (!isAuto) hideProgress();
                        if (el.btnAsr) el.btnAsr.disabled = false;
                        try { fs.unlinkSync(wav16); } catch (e) {}

                        var srt = tmp + '.srt';
                        if (e2 || !fs.existsSync(srt)) {
                            if (el.asrHint) el.asrHint.textContent = '识别失败，可手动填写';
                            return;
                        }

                        var content = '';
                        try { content = fs.readFileSync(srt, 'utf8'); } catch (e) {}

                        var subs = [];
                        var blocks = content.replace(/\r\n/g, '\n').split(/\n\n+/);
                        blocks.forEach(function (b) {
                            var lines = b.split('\n');
                            var idx = -1;
                            for (var k = 0; k < lines.length; k++) {
                                if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(lines[k])) { idx = k; break; }
                            }
                            if (idx < 0) return;
                            var t = lines.slice(idx + 1).join('').trim();
                            if (t) subs.push(t);
                        });

                        var text = subs.join('');
                        if (!text) {
                            if (el.asrHint) el.asrHint.textContent = '识别结果为空，可手动填写';
                            return;
                        }
                        if (el.refText) el.refText.value = text;
                        if (el.asrHint) el.asrHint.textContent = '✓ 已识别 ' + text.length + ' 字，请核对错字';
                    });
            });
    }

    // ---------- 保存音色 ----------
    function saveVoice() {
        if (!refWavPath || !fs.existsSync(refWavPath)) {
            alert('请先抓取参考音频'); return;
        }
        var text = (el.refText && el.refText.value || '').trim();
        if (!text) { alert('请先填写参考音频对应的文字'); return; }

        var name = (el.saveName && el.saveName.value || '').trim();
        if (!name) { alert('请填写音色名称'); if (el.saveName) el.saveName.focus(); return; }

        // Breeze 音色名只能是字母数字下划线横线
        var id = toVoiceId(name);

        if (el.btnSaveVoice) { el.btnSaveVoice.disabled = true; el.btnSaveVoice.textContent = '保存中…'; }
        setProgress(-1, '保存音色中…', true);

        // 走 Node 服务的 /v1/voices
        try {
            var buf = fs.readFileSync(refWavPath);
            var bnd = '----BZ' + Date.now();
            var parts = [];
            parts.push(Buffer.from('--' + bnd + '\r\nContent-Disposition: form-data; name="ref_audio"; filename="ref.wav"\r\nContent-Type: audio/wav\r\n\r\n', 'utf8'));
            parts.push(buf);
            parts.push(Buffer.from('\r\n', 'utf8'));
            parts.push(Buffer.from('--' + bnd + '\r\nContent-Disposition: form-data; name="ref_text"\r\n\r\n' + text + '\r\n', 'utf8'));
            parts.push(Buffer.from('--' + bnd + '\r\nContent-Disposition: form-data; name="name"\r\n\r\n' + id + '\r\n', 'utf8'));
            parts.push(Buffer.from('--' + bnd + '--\r\n', 'utf8'));
            var body = Buffer.concat(parts);

            var xhr = new XMLHttpRequest();
            xhr.open('POST', 'http://127.0.0.1:' + PORT + '/v1/voices', true);
            xhr.setRequestHeader('Content-Type', 'multipart/form-data; boundary=' + bnd);
            xhr.timeout = 120000;
            xhr.onload = function () {
                hideProgress();
                if (el.btnSaveVoice) { el.btnSaveVoice.disabled = false; el.btnSaveVoice.textContent = '保存'; }
                var ok = false;
                try { ok = JSON.parse(xhr.responseText).saved !== undefined || JSON.parse(xhr.responseText).id; } catch (e) {}
                if (ok) {
                    if (el.asrHint) el.asrHint.textContent = '✓ 音色「' + name + '」已保存';
                    if (el.saveName) el.saveName.value = '';
                    loadVoices();
                } else {
                    alert('保存失败：' + String(xhr.responseText).slice(0, 150));
                }
            };
            xhr.onerror = function () {
                hideProgress();
                if (el.btnSaveVoice) { el.btnSaveVoice.disabled = false; el.btnSaveVoice.textContent = '保存'; }
                alert('保存失败：Breeze 服务未启动');
            };
            xhr.send(body);
        } catch (e) {
            hideProgress();
            if (el.btnSaveVoice) { el.btnSaveVoice.disabled = false; el.btnSaveVoice.textContent = '保存'; }
            alert('保存异常：' + e.message);
        }
    }

    var MAP_KEY = 'breeze_voice_cn';
    function loadMap() {
        try { voiceMap = JSON.parse(localStorage.getItem(MAP_KEY) || '{}'); }
        catch (e) { voiceMap = {}; }
    }
    function saveMap() {
        try { localStorage.setItem(MAP_KEY, JSON.stringify(voiceMap)); } catch (e) {}
    }
    function toVoiceId(cn) {
        for (var k in voiceMap) { if (voiceMap[k] === cn) return k; }
        var id = 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        voiceMap[id] = cn;
        saveMap();
        return id;
    }

    // ---------- 生成 ----------
    function startGenTick(label) {
        stopGenTick();
        genStartAt = Date.now();
        genTick = setInterval(function () {
            var s = ((Date.now() - genStartAt) / 1000).toFixed(0);
            if (el.progText) {
                var cur = el.progText.textContent || '';
                // 保留已生成秒数，只更新时间
                el.progText.textContent = cur.replace(/\s·\s已用 \d+ 秒$/, '') + ' · 已用 ' + s + ' 秒';
            }
        }, 1000);
    }
    function stopGenTick() {
        if (genTick) { try { clearInterval(genTick); } catch (e) {} genTick = null; }
    }

    function stopGen() {
        if (!busy) return;
        stopRequested = true;
        if (el.btnStop) { el.btnStop.disabled = true; el.btnStop.textContent = '停止中…'; }

        var p = genProc;
        if (p && p.pid) {
            try {
                childProcess.execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'],
                    { windowsHide: true }, function () {});
            } catch (e) {}
        }
        // 兜底
        setTimeout(function () {
            if (busy && stopRequested) {
                genProc = null;
                stopGenTick();
                setBusy(false);
                setProgress(0, '已停止（若显存仍占用请重启 PR）', false);
                if (el.btnStop) el.btnStop.textContent = '停止';
            }
        }, 8000);
    }

    function generate() {
        if (busy) return;

        if (!checkModel()) { alert('请先下载语音模型'); return; }

        var text = (el.text && el.text.value || '').trim();
        if (!text) { alert('请先输入要朗读的文字'); return; }

        var voiceId = (el.voiceSel && el.voiceSel.value || '').trim();

        var args = [MODEL, '--text', text];
        var cfg = parseFloat(el.cfg ? el.cfg.value : '4') || 4;
        var seed = parseInt(el.seed ? el.seed.value : '42', 10);
        if (isFinite(seed)) args.push('--seed', String(seed));
        args.push('--cfg-scale', String(cfg));

        // 三种模式
        if (mode === 'design') {
            var ins = (el.instruction && el.instruction.value || '').trim();
            if (ins) args.push('--instruction', ins);
        } else {
            // 克隆 / 导演
            if (voiceId) {
                args.push('--voice', voiceId);
            } else {
                if (!refWavPath || !fs.existsSync(refWavPath)) {
                    alert('请抓取参考音频，或从音色库选一个音色');
                    return;
                }
                var refText = (el.refText && el.refText.value || '').trim();
                if (!refText) { alert('请填写参考音频对应的文字'); return; }
                args.push('--ref-audio', refWavPath);
                args.push('--ref-text', refText);
            }
            if (mode === 'direct') {
                var dt = (el.directText && el.directText.value || '').trim();
                if (!dt) { alert('请填写语气指令'); return; }
                args.push('--instruction', dt);
            }
        }

        // 每次生成都重新取目录：用户可能刚在设置里改过。
        // 同时用统一模块的 ensure 做「存在 + 可写」校验，
        // 目录不可用时在启动引擎之前就报出来，不白跑一轮生成。
        recomputeOutputDir();
        if (!OUTPUT_DIR) {
            setProgress(0, '输出目录不可用（扩展根路径没取到）', false);
            return;
        }
        var chk = { ok: true, msg: '' };
        try {
            if (window.__vhAudioOut && window.__vhAudioOut.ensure) {
                chk = window.__vhAudioOut.ensure();
            } else {
                if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
                var probe = path.join(OUTPUT_DIR, '.write_test_' + Date.now());
                fs.writeFileSync(probe, 'ok');
                fs.unlinkSync(probe);
            }
        } catch (e) {
            chk = { ok: false, msg: '输出目录不可写：' + (e.message || e) };
        }
        if (!chk.ok) {
            setProgress(0, '无法使用输出目录\n' + (chk.msg || '') + '\n路径：' + OUTPUT_DIR, false);
            return;
        }
        OUTPUT_DIR = chk.dir || OUTPUT_DIR;

        var outWav = path.join(OUTPUT_DIR, 'bz_' + Date.now() + '.wav');
        args.push('--output', outWav);

        // 开始
        stopRequested = false;
        genLines = [];
        setBusy(true);
        if (el.resultWrap) el.resultWrap.style.display = 'none';
        destroyResultWave();

        setProgress(-1, '启动引擎…', true);

        console.log('[breeze] 生成参数: ' + args.join(' '));

        try {
            genProc = childProcess.spawn(CLI, args, {
                cwd: ENGINE_DIR,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (e) {
            setBusy(false);
            setProgress(0, '启动失败：' + e.message, false);
            return;
        }

        startGenTick();

        var lastGenSec = 0;
        var loaded = false;

        function handleLine(line) {
            var l = String(line || '').trim();
            if (!l) return;
            genLines.push(l);

            // 加载阶段
            if (!loaded && /loading |backend:/i.test(l)) {
                setProgress(-1, '正在加载模型…', true);
                return;
            }

            // 生成进度：「generated 1.52 s」
            var m = /generated\s+([\d.]+)\s*s/i.exec(l);
            if (m) {
                if (!loaded) {
                    loaded = true;
                    setProgress(2, '模型已加载，开始生成…', false);
                }
                lastGenSec = parseFloat(m[1]) || 0;
                // 粗估：按文字长度估算目标时长（中文约 4.5 字/秒）
                var est = Math.max(2, text.length / 4.5);
                var pct = Math.min(95, (lastGenSec / est) * 100);
                setProgress(pct, '正在生成… 已完成 ' + lastGenSec.toFixed(2) + ' 秒音频', false);
                return;
            }

            // 完成
            if (/^wrote /i.test(l)) {
                setProgress(98, '正在写入文件…', false);
                return;
            }

            // 错误
            if (/error|failed/i.test(l) && !/vulkan/i.test(l)) {
                console.log('[breeze] cli 报错: ' + l);
            }
        }

        if (genProc.stdout) {
            genProc.stdout.on('data', function (chunk) {
                String(chunk).split(/\r?\n/).forEach(handleLine);
            });
        }
        if (genProc.stderr) {
            genProc.stderr.on('data', function (chunk) {
                String(chunk).split(/\r?\n/).forEach(handleLine);
            });
        }

        genProc.on('error', function (err) {
            stopGenTick();
            genProc = null;
            setBusy(false);
            setProgress(0, '启动失败：' + err.message, false);
        });

        genProc.on('close', function (code) {
            stopGenTick();
            var wasStop = stopRequested;
            genProc = null;
            stopRequested = false;
            if (el.btnStop) el.btnStop.textContent = '停止';

            if (wasStop) {
                setBusy(false);
                setProgress(0, '已停止', false);
                return;
            }

            if (code !== 0) {
                setBusy(false);
                var tail = genLines.slice(-6).join(' | ');
                // 写盘失败单独说清楚：这类问题重试没用，是目录/权限问题。
                if (/failed to write|cannot write|permission denied|ENOENT|EACCES/i.test(tail)) {
                    setProgress(0, '生成失败：无法写入音频文件\n' +
                        '输出目录：' + OUTPUT_DIR + '\n' +
                        '请确认该目录存在且可写（或磁盘已满）。\n' + tail, false);
                    return;
                }
                setProgress(0, '生成失败（code=' + code + '）：' + tail, false);
                return;
            }

            if (!fs.existsSync(outWav)) {
                setBusy(false);
                setProgress(0, '生成失败：未产出文件', false);
                return;
            }

            var secs = fs.statSync(outWav).size / 2 / 24000;
            lastOutWav = outWav;
            setBusy(false);
            setProgress(100, '✓ 完成，' + secs.toFixed(2) + ' 秒音频', false);
            showResult(outWav, secs);
        });
    }

    function showResult(wav, secs) {
        currentResultWav = wav;
        if (el.resultWrap) el.resultWrap.style.display = '';
        if (el.resultInfo) {
            el.resultInfo.textContent = '✓ ' + fmtSec(secs) + ' · ' + path.basename(wav);
            el.resultInfo.classList.add('has');
        }
        destroyResultWave();
        if (window.vhWave && el.resultWave) {
            try {
                resultWaveInst = window.vhWave.mount(el.resultWave, wav, {
                    height: 44, color: '#7fd68b', bg: 'rgba(0,0,0,.25)'
                });
            } catch (e) {
                el.resultWave.innerHTML = '<div class="hint">波形加载失败</div>';
            }
        }

        // 波形拖拽进时间轴：必须每次重新绑到当前 wav 上。
        // 之前完全没实现（提示语却写着能拖），CEP 拖拽拿不到新路径，
        // 结果拖进去的是上一次的音频。
        bindWaveDrag(el.resultWave, wav);

        if (el.btnInsert) el.btnInsert.disabled = false;
        if (el.insertHint) el.insertHint.textContent = '点「送到时间轴」插入播放头位置，或直接拖波形到时间轴。';
    }

    // 给结果波形绑定 CEP 原生拖拽。
    // 关键：用闭包捕获本次的 path，而不是读全局 lastOutWav —— 后者在
    // 多次生成后可能已被改写，导致拖出来的是别的文件。
    function bindWaveDrag(host, filePath) {
        if (!host) return;
        var p = String(filePath || '');
        if (!p) return;

        host.setAttribute('draggable', 'true');
        host.style.cursor = 'grab';

        // 先清掉旧的监听（重复挂会让一次拖拽触发多次 setData）
        if (host.__vhDragStart) {
            host.removeEventListener('dragstart', host.__vhDragStart);
            host.removeEventListener('dragend', host.__vhDragEnd);
        }

        host.__vhDragStart = function (ev) {
            // 点在试听按钮上时不启动拖拽，避免误拖
            var t = ev.target;
            if (t && t.tagName === 'BUTTON') {
                ev.preventDefault();
                return;
            }
            try {
                if (!fs.existsSync(p)) {
                    ev.preventDefault();
                    setProgress(0, '音频文件不存在，可能已被移动或删除：' + p, false);
                    return;
                }
            } catch (e) {}
            try {
                ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', p);
                ev.dataTransfer.setData('text/plain', p);
                ev.dataTransfer.effectAllowed = 'copy';
            } catch (e) {
                console.log('[breeze] 设置拖拽数据失败: ' + (e && e.message));
            }
        };
        host.__vhDragEnd = function () {
            host.style.cursor = 'grab';
        };

        host.addEventListener('dragstart', host.__vhDragStart);
        host.addEventListener('dragend', host.__vhDragEnd);
    }

    // ---------- 送时间轴 ----------
    function insertToTimeline() {
        if (!lastOutWav || !fs.existsSync(lastOutWav)) {
            alert('还没有生成音频'); return;
        }
        // 防插错：确认要插入的就是当前结果区显示的那个文件。
        // 曾经出现过「波形是新的、插进去是旧的」，排查后是路径没同步。
        if (currentResultWav && currentResultWav !== lastOutWav) {
            var useCur = confirm(
                '检测到结果文件不一致：\n' +
                '当前显示：' + path.basename(currentResultWav) + '\n' +
                '将插入：' + path.basename(lastOutWav) + '\n\n' +
                '是否改插入当前显示的这个？');
            if (useCur) lastOutWav = currentResultWav;
        }

        setProgress(100, '正在插入时间轴…', false);

        var payload = { wavPath: lastOutWav, trackIndex: 0, positionSec: -1, colorLabel: 9 };
        evalJsx('vcInsertPayload = ' + JSON.stringify(payload) + ';', function () {
            evalJsx('vcInsertToTimelineStr()', function (r) {
                var p = parseHost(r);
                if (p.ok) {
                    var d = p.data || {};
                    setProgress(100, '✓ 已插入 A' + ((d.trackIndex || 0) + 1) + ' 轨', false);
                    return;
                }
                // 换 A2 再试
                var p2 = { wavPath: lastOutWav, trackIndex: 1, positionSec: -1, colorLabel: 9 };
                evalJsx('vcInsertPayload = ' + JSON.stringify(p2) + ';', function () {
                    evalJsx('vcInsertToTimelineStr()', function (r2) {
                        var q = parseHost(r2);
                        if (q.ok) {
                            setProgress(100, '✓ 已插入 A2 轨', false);
                        } else {
                            setProgress(0, '插入失败：' + (q.msg || p.msg), false);
                        }
                    });
                });
            });
        });
    }

    // ---------- 绑定 ----------
    // 启动即确保输出目录存在：不等到点生成才建，
    // 避免用户第一次使用就撞 "failed to write"。
    function ensureOutputDir() {
        recomputeOutputDir();
        if (!OUTPUT_DIR) return false;
        try {
            if (window.__vhAudioOut && window.__vhAudioOut.ensure) {
                var r = window.__vhAudioOut.ensure();
                return !!r.ok;
            }
            if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
            return true;
        } catch (e) {
            console.log('[breeze] 创建输出目录失败: ' + (e.message || e));
            return false;
        }
    }

    function bind() {
        ensureOutputDir();
        initEl();
        loadMap();

        if (el.btnDlModel) el.btnDlModel.addEventListener('click', downloadModel);

        if (el.btnRefreshVoice) el.btnRefreshVoice.addEventListener('click', loadVoices);
        if (el.btnUseVoice) el.btnUseVoice.addEventListener('click', useVoice);
        if (el.voiceSel) el.voiceSel.addEventListener('change', function () {
            if (el.btnUseVoice) el.btnUseVoice.disabled = !el.voiceSel.value || busy;
        });

        if (el.srcSel) el.srcSel.addEventListener('change', function () {
            var v = el.srcSel.value;
            if (el.inOutRow) el.inOutRow.style.display = (v === 'inout') ? '' : 'none';
            if (el.grabHint) {
                el.grabHint.textContent = (v === 'inout')
                    ? '先按 I / O 设好起止（≤30 秒）。'
                    : '先在时间轴选中一段人声（≤30 秒）。';
            }
            if (v === 'inout') { refreshTracks(); refreshPresets(); }
        });

        if (el.btnGrab) el.btnGrab.addEventListener('click', doGrab);
        if (el.btnRefreshTrack) el.btnRefreshTrack.addEventListener('click', refreshTracks);
        if (el.btnRefreshPreset) el.btnRefreshPreset.addEventListener('click', refreshPresets);
        if (el.presetSel) el.presetSel.addEventListener('change', function () {
            try { localStorage.setItem('vh_bz_preset', el.presetSel.value); } catch (e) {}
        });

        if (el.btnAsr) el.btnAsr.addEventListener('click', function () { runAsr(false); });
        if (el.btnSaveVoice) el.btnSaveVoice.addEventListener('click', saveVoice);

        // 模式切换
        if (el.modeRow) {
            el.modeRow.addEventListener('click', function (e) {
                var b = e.target.closest('.vc-mode');
                if (!b) return;
                mode = b.dataset.mode;
                Array.prototype.forEach.call(el.modeRow.querySelectorAll('.vc-mode'), function (x) {
                    x.classList.toggle('active', x === b);
                });
                if (el.designWrap) el.designWrap.style.display = (mode === 'design') ? '' : 'none';
                if (el.directWrap) el.directWrap.style.display = (mode === 'direct') ? '' : 'none';
                if (el.modeHint) {
                    el.modeHint.textContent = {
                        design: '声音设计：不需要参考音频，用一句话描述想要的嗓音。',
                        clone: '声音克隆：用参考音频复刻音色，说出新内容。',
                        direct: '语气导演：保留音色，用指令控制语气、情绪、语速。'
                    }[mode];
                }
            });
        }

        // 语气快捷 chips
        document.querySelectorAll('.vc-chip').forEach(function (c) {
            c.addEventListener('click', function () {
                if (el.directText) el.directText.value = c.dataset.v || c.textContent;
            });
        });

        // 贴合度
        if (el.cfg) {
            el.cfg.addEventListener('input', function () {
                if (el.cfgVal) el.cfgVal.textContent = el.cfg.value;
            });
        }

        // 随机种子
        if (el.btnDice) {
            el.btnDice.addEventListener('click', function () {
                if (el.seed) el.seed.value = String(Math.floor(Math.random() * 999999) + 1);
            });
        }

        if (el.btnGen) el.btnGen.addEventListener('click', generate);
        if (el.btnStop) el.btnStop.addEventListener('click', stopGen);
        if (el.btnInsert) el.btnInsert.addEventListener('click', insertToTimeline);

        // 面板切到时刷新状态
        var tab = document.querySelector('.tab[data-tab="breeze"]');
        if (tab) {
            tab.addEventListener('click', function () {
                setTimeout(function () {
                    checkModel();
                    loadVoices();
                }, 80);
            });
        }

        // 初始
        setTimeout(function () {
            var ready = checkModel();
            if (ready) loadVoices();
            else {
                var t = setInterval(function () {
                    if (checkModel()) { clearInterval(t); loadVoices(); }
                }, 3000);
            }
        }, 300);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    window.__vhBreeze = { generate: generate, stop: stopGen };
})();
