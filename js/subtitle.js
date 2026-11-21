// 本地字幕插件 - 前端主逻辑（批量识别版）
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var child_process = require('child_process');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);

    // 状态
    var allSequences = [];       // [{ name, sequenceID, end, active }]
    var currentClips = [];       // 当前查看序列的片段
    var subtitles = [];          // 当前查看序列的字幕
    var currentSeqId = null;     // 当前查看的序列 ID
    var batchResults = [];       // 批量结果 [{ seqId, name, status, count, subtitles }]
    var stopRequested = false;   // 停止标志
    var batchProgressBase = 0;   // 当前序列在总进度里的起点（%）
    var batchProgressSpan = 0;   // 当前序列占用的进度跨度（%）
    var sepVocalsPath = null;    // 人声分离产物：人声
    var sepAccompPath = null;    // 人声分离产物：伴奏
    var sepBusy = false;         // 分离是否进行中

    // DOM 引用
    var el = {
        seqList: document.getElementById('seqList'),
        refreshSeq: document.getElementById('btnRefreshSeq'),
        toggleAll: document.getElementById('btnToggleAll'),
        selLang: document.getElementById('selLang'),
        selRange: document.getElementById('selRange'),
        selModel: document.getElementById('selModel'),
        chkGpu: document.getElementById('chkGpu'),
        batch: document.getElementById('btnBatch'),
        stop: document.getElementById('btnStop'),
        progressWrap: document.getElementById('wsProgressWrap'),
        progressFill: document.getElementById('wsProgressFill'),
        progressText: document.getElementById('wsProgressText'),
        progressTime: document.getElementById('wsProgressTime'),
        status: document.getElementById('wsStatus'),
        resultCard: document.getElementById('resultCard'),
        resultSummary: document.getElementById('resultSummary'),
        list: document.getElementById('subtitleList'),
        writeBack: document.getElementById('btnWriteBack'),
        exportSrt: document.getElementById('btnExportSrt'),
        toCheck: document.getElementById('btnToCheck'),
        translate: document.getElementById('btnTranslate'),
        bilingual: document.getElementById('btnBilingual'),
        btnSeparate: document.getElementById('btnSeparate'),
        btnImportVocals: document.getElementById('btnImportVocals'),
        btnSepClear: document.getElementById('btnSepClear'),
        sepResultList: document.getElementById('sepResultList'),
        sepProgressWrap: document.getElementById('sepProgressWrap'),
        sepProgressFill: document.getElementById('sepProgressFill'),
        sepProgressText: document.getElementById('sepProgressText'),
        sepStatus: document.getElementById('sepStatus')
    };

    function setStatus(msg, type) {
        el.status.textContent = msg || '';
        el.status.className = type || '';
    }

    // ---------- 共享工具（来自 utils.js，避免重复实现）----------
    var U = window.__vhUtils;
    var parseSRT = U.parseSRT;
    var parseTime = U.parseTime;
    var formatTime = U.formatTime;
    var toSRT = U.toSRT;
    var escapeHtml = U.escapeHtml;
    var detectPython = function () { return U.detectPython(extRoot); };

    // ---------- 进度条计时 ----------
    var progressStartMs = null;   // 本次批量开始时刻
    var progressPct = 0;          // 当前百分比（0~100）
    var progressTimer = null;     // 刷新已用/剩余时间的定时器

    function fmtDuration(ms) {
        if (!isFinite(ms) || ms < 0) return '--:--';
        var totalSec = Math.floor(ms / 1000);
        var h = Math.floor(totalSec / 3600);
        var m = Math.floor((totalSec % 3600) / 60);
        var s = totalSec % 60;
        if (h > 0) {
            return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
        }
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function startProgressTimer() {
        progressStartMs = Date.now();
        progressPct = 0;
        el.progressTime.textContent = '已用 0:00 · 预计剩余 --';
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = setInterval(updateProgressTime, 1000);
    }

    function updateProgressTime() {
        if (progressStartMs === null) return;
        var elapsed = Date.now() - progressStartMs;
        var eta;
        if (progressPct > 1) {
            // 线性外推：已用时间 / 完成比例 = 总时间，剩余 = 总 - 已用
            eta = Math.round(elapsed / progressPct * (100 - progressPct));
        } else {
            eta = -1;  // 进度太小，剩余时间不可估
        }
        el.progressTime.textContent = '已用 ' + fmtDuration(elapsed) +
            ' · 预计剩余 ' + (eta >= 0 ? fmtDuration(eta) : '--');
    }

    function stopProgressTimer() {
        if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
        progressStartMs = null;
    }

    function setProgress(pct, text) {
        progressPct = pct;
        if (pct < 0) {
            el.progressFill.className = 'fill indet';
            el.progressText.textContent = text || '';
        } else {
            el.progressFill.className = 'fill';
            el.progressFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
            el.progressText.textContent = text || '';
        }
        updateProgressTime();
    }

    function setBusy(busy) {
        el.batch.disabled = busy;
        el.writeBack.disabled = busy;
        el.refreshSeq.disabled = busy;
        if (busy) {
            el.progressWrap.classList.add('show');
            el.stop.style.display = '';
            startProgressTimer();
        } else {
            el.progressWrap.classList.remove('show');
            el.stop.style.display = 'none';
            stopProgressTimer();
            // 任务结束（成功/失败/停止都会走到这里）：清掉本次产生的中间文件，
            // 否则每个用过的序列都会在临时目录永久留一份 mix_<id>.wav。
            cleanTmpArtifacts();
        }
    }

    // 清理本次识别产生的中间文件（音频/列表/结果），保留目录本身
    // 注意：只在任务收尾时调用；识别过程中不能删（whisper/funasr 还在读）
    function cleanTmpArtifacts() {
        try {
            var d = path.join(os.tmpdir(), 'ws_subtitle');
            if (!fs.existsSync(d)) return;
            var es = fs.readdirSync(d);
            var n = 0, bytes = 0;
            for (var i = 0; i < es.length; i++) {
                var f = es[i];
                // 只删本功能的中间产物，保留意外文件
                if (!/^(mix|funasr_)/.test(f)) continue;
                var fp = path.join(d, f);
                try {
                    var st = fs.statSync(fp);
                    if (st.isDirectory()) continue;
                    bytes += st.size;
                    fs.unlinkSync(fp);
                    n++;
                } catch (e) {}
            }
            if (n > 0 && window.__vhTmp) {
                try {
                    setStatus('已清理临时音频 ' + n + ' 个（' + window.__vhTmp.fmt(bytes) + '）', '');
                } catch (e) {}
            }
        } catch (e) {}
    }

    // ---------- 1. 序列列表 ----------
    function refreshSequences() {
        setStatus('读取序列列表...', '');
        csInterface.evalScript('wsGetAllSequencesStr()', function (result) {
            try {
                var data = JSON.parse(result);
                if (data.error) { setStatus(data.error, 'err'); return; }
                allSequences = data.sequences || [];
                renderSeqList();
                setStatus('共 ' + allSequences.length + ' 个序列，勾选要识别的（默认选中当前活动序列）', 'ok');
            } catch (e) {
                setStatus('解析失败: ' + e.toString() + ' | ' + result, 'err');
            }
        });
    }

    function renderSeqList() {
        el.seqList.innerHTML = '';
        if (allSequences.length === 0) {
            el.seqList.innerHTML = '<div class="hint" style="padding:6px 8px;">项目里没有序列</div>';
            return;
        }
        allSequences.forEach(function (s) {
            var div = document.createElement('div');
            div.className = 'seq-item';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!s.active;   // 默认勾选当前活动序列
            cb.dataset.id = s.sequenceID;
            var nm = document.createElement('span');
            nm.className = 'nm';
            nm.textContent = s.name;
            var dur = document.createElement('span');
            dur.className = 'dur';
            dur.textContent = (s.end || 0).toFixed(1) + 's';
            div.appendChild(cb);
            div.appendChild(nm);
            if (s.active) {
                var badge = document.createElement('span');
                badge.className = 'badge';
                badge.textContent = '当前';
                div.appendChild(badge);
            }
            div.appendChild(dur);
            el.seqList.appendChild(div);
        });
    }

    function getSelectedSeqIds() {
        var ids = [];
        var boxes = el.seqList.querySelectorAll('input[type=checkbox]');
        boxes.forEach(function (cb) { if (cb.checked) ids.push(cb.dataset.id); });
        return ids;
    }

    function toggleAll() {
        var boxes = el.seqList.querySelectorAll('input[type=checkbox]');
        var allChecked = true;
        boxes.forEach(function (cb) { if (!cb.checked) allChecked = false; });
        boxes.forEach(function (cb) { cb.checked = !allChecked; });
    }

    // ---------- 2. 混音参数 ----------
    function buildMixArgs(clips, outWav) {
        var inputs = [];
        var filters = [];
        clips.forEach(function (c, idx) {
            inputs.push('-ss', c.inPoint.toFixed(3));
            inputs.push('-t', c.duration.toFixed(3));
            inputs.push('-i', c.mediaPath);
            var ms = Math.round(c.seqStart * 1000);
            filters.push(
                '[' + idx + ':a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,' +
                'asetpts=PTS-STARTPTS,adelay=' + ms + '[a' + idx + ']'
            );
        });
        var amixInputs = clips.map(function (_, idx) { return '[a' + idx + ']'; }).join('');
        var amix = amixInputs + 'amix=inputs=' + clips.length + ':normalize=0:duration=longest[out]';
        var args = inputs.concat([
            '-filter_complex', filters.join(';') + ';' + amix,
            '-map', '[out]',
            '-ar', '16000', '-ac', '1',
            '-y', outWav
        ]);
        return args;
    }

    // ---------- 3. 批量识别 ----------
    function runBatch() {
        if (stopRequested) { stopRequested = false; return; }
        var ids = getSelectedSeqIds();
        if (ids.length === 0) { setStatus('请先勾选要识别的序列', 'err'); return; }

        var useGpu = el.chkGpu.checked;
        var modelName = el.selModel.value;
        var lang = el.selLang.value;
        var rangeMode = el.selRange.value;   // 'all' | 'inout' | 'selection'

        // 先确认 faster-whisper 模型就位（缺失则提示下载），
        // 避免跑到一半每个序列都失败。FunASR 不需要。
        if (!useFunasrEngine()) {
            // 先补库（66MB 增量包），再补模型（4GB）——顺序不能反
            if (!fwEngineReady(true)) {
                ensureFwEngine(function (e1) {
                    if (e1) { setBusy(false); return; }
                    runBatch();
                });
                return;
            }
            var needModel = fwModelName(lang);
            if (!fwModelReady(needModel)) {
                ensureFwModel(needModel, function (err) {
                    if (err) { setStatus('模型准备失败：' + err.message, 'err'); setBusy(false); return; }
                    setStatus('模型就绪，开始识别…', 'ok');
                    runBatch();       // 下载完重新走一遍
                });
                return;
            }
        }

        var ffmpegPath = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
        // 旧字幕插件 CEP 目录（引擎/模型暂不复制，回退复用）
        var legacyExt = path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions', 'com.zhang.whisper-subtitle');

        // GPU 自动检测：能加载 cuda 库就用 CUDA 版，否则降级纯 CPU 版
        var cudaWhisperPath = path.join(extRoot, 'bin', 'whisper', 'cuda', 'whisper-cli.exe');
        var cpuWhisperPath = path.join(extRoot, 'bin', 'whisper', 'win32-x64', 'whisper-cli.exe');
        var legacyCudaWhisperPath = path.join(legacyExt, 'bin', 'whisper', 'cuda', 'whisper-cli.exe');
        var legacyCpuWhisperPath = path.join(legacyExt, 'bin', 'whisper', 'win32-x64', 'whisper-cli.exe');
        if (!fs.existsSync(cudaWhisperPath)) cudaWhisperPath = legacyCudaWhisperPath;
        if (!fs.existsSync(cpuWhisperPath)) cpuWhisperPath = legacyCpuWhisperPath;
        var cudaOk = detectCudaAvailable(cudaWhisperPath);
        var whisperPath;
        if (cudaOk) {
            whisperPath = cudaWhisperPath;
            if (!useGpu) setStatus('GPU 已禁用，英文将用 CUDA 版跑 CPU 模式', '');
        } else {
            whisperPath = cpuWhisperPath;
            useGpu = false;  // 纯 CPU 版无 GPU 能力
            if (lang !== 'zh') setStatus('未检测到可用 CUDA 环境，英文已降级纯 CPU 模式', 'warn');
        }
        // modelPath 只对 whisper.cpp 有意义（它是 .bin 文件名）。
        // faster-whisper 的模型由它自己按名字去 HuggingFace 缓存里找，
        // 不要把 fw-medium 拼成路径，否则会去找 models/fw-medium 并报"模型缺失"。
        var modelPath = '';
        if (String(modelName).indexOf('fw-') !== 0) {
            modelPath = path.join(extRoot, 'models', modelName);
            if (!fs.existsSync(modelPath)) modelPath = path.join(legacyExt, 'models', modelName);
        }
        var funasrCli = path.join(extRoot, 'py', 'funasr_cli.py');
        var funasrModelDir = path.join(extRoot, 'models', 'funasr');
        if (!fs.existsSync(funasrModelDir)) funasrModelDir = path.join(legacyExt, 'models', 'funasr');

        if (!fs.existsSync(ffmpegPath)) { setStatus('FFmpeg 缺失: ' + ffmpegPath, 'err'); return; }
        // 前置校验改为按「实际要用的引擎」判断。
        // 旧逻辑是「中文→FunASR，其他→whisper.cpp」，不认识 fw-* 新模型值，
        // 会把 fw-medium 当成 whisper 的模型文件名去找文件，报"模型缺失"。
        if (useFunasrEngine()) {
            if (!fs.existsSync(funasrCli)) { setStatus('FunASR 脚本缺失: ' + funasrCli, 'err'); return; }
            if (!fs.existsSync(funasrModelDir)) { setStatus('FunASR 模型缺失: ' + funasrModelDir, 'err'); return; }
        } else {
            // faster-whisper 路径：只需 Python + CLI 脚本，模型由它自己下载/缓存
            var fwEnv = fasterWhisperReady();
            if (!fwEnv.ok) {
                // Python 或脚本缺失时，退回原生 whisper（如果装了）
                if (fs.existsSync(whisperPath) && fs.existsSync(modelPath)) {
                    setStatus('faster-whisper 不可用（' + fwEnv.reason + '），改用 whisper.cpp', 'warn');
                } else {
                    setStatus('识别引擎不可用：' + fwEnv.reason, 'err');
                    return;
                }
            }
        }

        stopRequested = false;
        batchResults = [];
        el.resultCard.style.display = 'none';
        setBusy(true);

        // 明确标识当前引擎，方便一眼判断走的是哪条路
        var engineName = (lang === 'zh') ? 'FunASR（中文·paraformer）' : 'whisper large-v3';
        setStatus('引擎：' + engineName + '，准备识别...', '');

        // 临时目录（英文路径，whisper 对中文路径会崩溃）
        var tmpDir = path.join(os.tmpdir(), 'ws_subtitle');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

        // 先收集所有序列的片段信息
        var seqMetas = [];   // [{ seqId, seqName, clips }]
        var collected = 0;
        setStatus('正在读取 ' + ids.length + ' 个序列的片段信息...', '');
        setProgress(0, '读取序列片段 0/' + ids.length);

        function collectNext(idx) {
            if (stopRequested || idx >= ids.length) {
                if (stopRequested) { setBusy(false); setStatus('已停止', 'warn'); return; }
                startTranscribing();
                return;
            }
            var seqId = ids[idx];
            var evalStr = (rangeMode === 'all')
                ? 'wsGetSequenceClipsStr("' + seqId + '")'
                : 'wsGetSequenceClipsRangeStr("' + seqId + '", "' + rangeMode + '")';
            csInterface.evalScript(evalStr, function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.error) {
                        seqMetas.push({ seqId: seqId, seqName: '序列 ' + seqId.slice(0, 8), clips: [], error: data.error });
                    } else {
                        seqMetas.push({ seqId: seqId, seqName: data.seqName, clips: data.clips || [] });
                    }
                } catch (e) {
                    seqMetas.push({ seqId: seqId, seqName: '序列 ' + seqId.slice(0, 8), clips: [], error: e.toString() });
                }
                collected++;
                setProgress(Math.round(collected / ids.length * 10), '读取序列片段 ' + collected + '/' + ids.length);
                collectNext(idx + 1);
            });
        }

        function startTranscribing() {
            var valid = seqMetas.filter(function (m) { return m.clips && m.clips.length > 0; });
            if (valid.length === 0) {
                setBusy(false);
                stopProgressTimer();
                // 把每条序列的具体错误透出来，便于定位（不再笼统提示）
                var firstErr = null;
                seqMetas.forEach(function (m) { if (m.error && !firstErr) firstErr = m.error; });
                if (firstErr) {
                    setStatus('没有可识别内容：' + firstErr, 'err');
                } else {
                    setStatus('没有可识别的序列（可能都是空序列或无媒体）', 'err');
                }
                return;
            }
            // 计算每个序列的音频时长（识别耗时≈音频时长，进度按此加权才准）
            var totalAudioSec = 0;
            valid.forEach(function (m) {
                var sec = 0;
                m.clips.forEach(function (c) { sec += (c.duration || 0); });
                m.audioSec = sec;
                totalAudioSec += sec;
            });
            totalAudioSec = Math.max(totalAudioSec, 0.001);
            var total = valid.length;
            setProgress(5, '准备识别 ' + total + ' 个序列');

            // 引擎选择：
            //   只有用户在模型下拉里显式选了 funasr-* 才走 FunASR 批量模式；
            //   其余（含中文、自动检测）统一走 faster-whisper
            //   —— 它给词级时间戳 + VAD，气口能正确断开。
            if (useFunasrEngine()) {
                transcribeZhBatch(valid, totalAudioSec);
            } else {
                var doneSec = 0;
                var done = 0;
                function transcribeNext(i) {
                    if (stopRequested || i >= total) {
                        if (stopRequested) { setBusy(false); setStatus('已停止', 'warn'); stopProgressTimer(); }
                        else { finishBatch(); }
                        return;
                    }
                    var meta = valid[i];
                    setStatus('识别中 [' + (i + 1) + '/' + total + '] ' + meta.seqName + '...', '');
                    // 当前序列占 5%→95% 区间中，与它的音频时长成正比的一段
                    batchProgressBase = 5 + Math.round(doneSec / totalAudioSec * 90);
                    batchProgressSpan = Math.max(1, Math.round((meta.audioSec || 0) / totalAudioSec * 90));
                    transcribeOne(meta, function (result) {
                        batchResults.push(result);
                        done++;
                        doneSec += (meta.audioSec || 0);
                        // 按时长加权推进（5%→95%）
                        var base = 5 + Math.round(doneSec / totalAudioSec * 90);
                        setProgress(base, '已完成 ' + done + '/' + total + ' 个序列');
                        transcribeNext(i + 1);
                    });
                }
                transcribeNext(0);
            }
        }

        // 中文批量：先串行混音（快），再一次性 FunASR 识别（模型只加载一次，省 N-1 次 4.6 秒加载）
        function transcribeZhBatch(metas, totalAudioSec) {
            var total = metas.length;
            var mixTaskList = [];  // [{ meta, wavPath }]
            var mixErrors = [];    // [{ meta, error }]
            var mixedSec = 0;      // 已混音完成的音频时长（用于混音阶段加权）

            function mixNext(i) {
                if (stopRequested || i >= total) {
                    if (stopRequested) { setBusy(false); setStatus('已停止', 'warn'); return; }
                    runZhRecognize();
                    return;
                }
                var meta = metas[i];
                var wavPath = path.join(tmpDir, 'mix_' + meta.seqId.slice(0, 8) + '.wav');
                try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (e) {}
                setStatus('混音中 [' + (i + 1) + '/' + total + '] ' + meta.seqName + '...', '');
                setProgress(5 + Math.round(mixedSec / totalAudioSec * 20), '混音 ' + (i + 1) + '/' + total);
                var mixArgs = buildMixArgs(meta.clips, wavPath);
                child_process.execFile(ffmpegPath, mixArgs, {
                    timeout: 300000,
                    maxBuffer: 1024 * 1024 * 20
                }, function (err) {
                    if (err || !fs.existsSync(wavPath)) {
                        mixErrors.push({ meta: meta, error: '混音失败: ' + (err ? err.message : '未生成 wav') });
                    } else {
                        mixTaskList.push({ meta: meta, wavPath: wavPath });
                    }
                    mixedSec += (meta.audioSec || 0);
                    mixNext(i + 1);
                });
            }

            function runZhRecognize() {
                if (mixTaskList.length === 0) {
                    // 全部混音失败
                    mixErrors.forEach(function (e) {
                        batchResults.push({ seqId: e.meta.seqId, name: e.meta.seqName, status: 'err', error: e.error });
                    });
                    finishBatch();
                    return;
                }

                var pythonExe = detectPython();
                if (!pythonExe) {
                    setBusy(false);
                    setStatus('未找到 Python 环境（需安装 Python 3.9+ 并 pip install funasr）', 'err');
                    return;
                }

                var listJsonPath = path.join(tmpDir, 'funasr_list.json');
                var outJsonPath = path.join(tmpDir, 'funasr_out.json');
                var tasks = mixTaskList.map(function (t) {
                    return { id: t.meta.seqId, wav: t.wavPath };
                });
                fs.writeFileSync(listJsonPath, JSON.stringify(tasks), 'utf8');

                setStatus('FunASR 识别中（模型加载约 4.6 秒，之后很快）...', '');
                setProgress(25, 'FunASR 识别 0/' + mixTaskList.length);

                var proc = child_process.execFile(pythonExe, [funasrCli, '--multi', listJsonPath, outJsonPath], {
                    timeout: 1800000,
                    maxBuffer: 1024 * 1024 * 50
                }, function (error, stdout, stderr) {
                    if (stopRequested) { setBusy(false); setStatus('已停止', 'warn'); return; }
                    if (error) {
                        var detail = (stderr || stdout || '').substring(0, 800);
                        setBusy(false);
                        setStatus('FunASR 识别失败: ' + error.message + ' ' + detail, 'err');
                        return;
                    }
                    if (!fs.existsSync(outJsonPath)) {
                        setBusy(false);
                        setStatus('FunASR 未生成结果', 'err');
                        return;
                    }
                    var resultMap;
                    try {
                        resultMap = JSON.parse(fs.readFileSync(outJsonPath, 'utf8'));
                    } catch (e) {
                        setBusy(false);
                        setStatus('FunASR 结果解析失败: ' + e.toString(), 'err');
                        return;
                    }
                    // 组装 batchResults
                    mixTaskList.forEach(function (t) {
                        var subs = resultMap[t.meta.seqId] || [];
                        if (subs.length === 0) {
                            batchResults.push({ seqId: t.meta.seqId, name: t.meta.seqName, status: 'err', error: 'FunASR 未识别到内容' });
                        } else {
                            batchResults.push({ seqId: t.meta.seqId, name: t.meta.seqName, status: 'ok', count: subs.length, subtitles: subs });
                        }
                    });
                    mixErrors.forEach(function (e) {
                        batchResults.push({ seqId: e.meta.seqId, name: e.meta.seqName, status: 'err', error: e.error });
                    });
                    finishBatch();
                });

                // 读取 stderr 里的 PROGRESS 行，更新进度条（按时长加权）
                var recognizedSec = 0;
                proc.stderr.on('data', function (chunk) {
                    var s = chunk.toString();
                    var m = s.match(/PROGRESS\s+(\d+)\/(\d+)/);
                    if (m) {
                        var cur = parseInt(m[1], 10);
                        var tot = parseInt(m[2], 10);
                        // cur 是已完成的 task 数，累加对应序列时长
                        recognizedSec = 0;
                        for (var k = 0; k < cur && k < mixTaskList.length; k++) {
                            recognizedSec += (mixTaskList[k].meta.audioSec || 0);
                        }
                        setProgress(25 + Math.round(recognizedSec / totalAudioSec * 70), 'FunASR 识别 ' + cur + '/' + tot);
                    }
                });
            }

            mixNext(0);
        }

        // 单序列（英文/whisper 用）：混音 → whisper → 解析
        function transcribeOne(meta, cb) {
            var wavPath = path.join(tmpDir, 'mix_' + meta.seqId.slice(0, 8) + '.wav');
            var srtPath = path.join(tmpDir, 'mix_' + meta.seqId.slice(0, 8) + '.srt');
            try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (e) {}
            try { if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath); } catch (e) {}

            var mixArgs = buildMixArgs(meta.clips, wavPath);
            child_process.execFile(ffmpegPath, mixArgs, {
                timeout: 300000,
                maxBuffer: 1024 * 1024 * 20
            }, function (err) {
                if (err) {
                    cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: '混音失败: ' + err.message });
                    return;
                }
                if (!fs.existsSync(wavPath)) {
                    cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: '混音未生成 wav' });
                    return;
                }
                // 改用 faster-whisper：词级时间戳 + VAD，气口能正确断开。
                // 旧的 runWhisper 保留，作为新引擎不可用时的兜底。
                var fw = fasterWhisperReady();
                if (fw.ok) {
                    var outJson = path.join(tmpDir, 'fw_' + meta.seqId.slice(0, 8) + '.json');
                    try { if (fs.existsSync(outJson)) fs.unlinkSync(outJson); } catch (e2) {}
                    // 首次使用要先下载模型：只在第一条序列上做一次
                    var mName = fwModelName(lang);
                    if (!fwModelChecked) { fwModelChecked = true; }
                    runFasterWhisper(meta, wavPath, outJson, {
                        model: mName,
                        lang: (lang === 'zh') ? 'zh' : (lang === 'auto' ? 'auto' : lang),
                        gap: (function () {
                            var g = parseFloat(el.inpGap && el.inpGap.value);
                            if (!isFinite(g) || g <= 0) g = 0.45;
                            if (g < 0.15) g = 0.15;
                            if (g > 2.0) g = 2.0;
                            return g;
                        })(),
                        useGpu: useGpu
                    }, function (res) {
                        // fw-* 模型只能用 faster-whisper 跑；
                        // 退回 whisper.cpp 时 modelPath 是空，必然失败且会掩盖真实原因。
                        // 所以这里直接返回真实错误，不再静默兜底。
                        if (res && res.status === 'err') {
                            var isFwModel = String(modelName).indexOf('fw-') === 0;
                            if (isFwModel) {
                                var why = res.error || '未知错误';
                                try {
                                    if (window.__vhLog && window.__vhLog.err) {
                                        window.__vhLog.err('[subtitle] faster-whisper 失败（不兜底）: ' +
                                            why + ' | py=' + fw.py + ' | model=' + mName +
                                            ' | gpu=' + (useGpu ? 'on' : 'off'));
                                    }
                                } catch (e) {}
                                cb({
                                    seqId: meta.seqId, name: meta.seqName, status: 'err',
                                    error: '识别失败：' + why +
                                           '　（引擎 faster-whisper，设备 ' + (useGpu ? 'GPU' : 'CPU') +
                                           '，模型 ' + mName + '）'
                                });
                                return;
                            }
                            // 非 fw 模型才退回 whisper.cpp
                            runWhisper(meta, wavPath, srtPath, whisperPath, modelPath, lang, useGpu, tmpDir, cb);
                            return;
                        }
                        cb(res);
                    });
                } else {
                    runWhisper(meta, wavPath, srtPath, whisperPath, modelPath, lang, useGpu, tmpDir, cb);
                }
            });
        }

        collectNext(0);
    }

    // 跑 whisper（带进度回调 + GPU 开关 + 停止）
    function runWhisper(meta, wavPath, srtPath, whisperPath, modelPath, lang, useGpu, tmpDir, cb) {
        var args = [
            '-m', modelPath,
            '-l', lang,
            '-t', '4',
            '-osrt',
            '-of', path.join(tmpDir, 'mix_' + meta.seqId.slice(0, 8)),
            '-pp',
            '-nf',              // 禁用 temperature fallback：堵住"听不懂就硬编"的幻觉源头（保留）
            '-sns',             // 抑制非语音 token，减少"(音乐)"这类杂音（保留）
            wavPath
        ];
        if (!useGpu) args.push('-ng');

        var proc = child_process.execFile(whisperPath, args, {
            cwd: path.dirname(whisperPath),
            timeout: 1800000,
            maxBuffer: 1024 * 1024 * 50
        }, function (error, stdout, stderr) {
            if (stopRequested) { cb({ seqId: meta.seqId, name: meta.seqName, status: 'stopped' }); return; }
            if (error) {
                var detail = (stderr || stdout || '').substring(0, 500);
                cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: '识别失败: ' + error.message + ' ' + detail });
                return;
            }
            var srtContent = '';
            try { srtContent = fs.readFileSync(srtPath, 'utf8'); } catch (e) {
                cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: '未生成 srt' });
                return;
            }
            var subs = parseSRT(srtContent);
            cb({ seqId: meta.seqId, name: meta.seqName, status: 'ok', count: subs.length, subtitles: subs });
        });

        // 解析 whisper 进度（progress = XX%），映射到当前序列的加权进度区间
        proc.stderr.on('data', function (chunk) {
            var s = chunk.toString();
            var m = s.match(/progress\s*=\s*(\d+)%/);
            if (m) {
                var p = parseInt(m[1], 10);
                setStatus('识别中 [' + meta.name + '] ' + p + '%...', '');
                var inner = batchProgressBase + Math.round(p / 100 * batchProgressSpan);
                setProgress(Math.min(94, inner), '识别中 [' + meta.name + '] ' + p + '%');
            }
        });
    }

    // ====================================================================
    // faster-whisper 识别（新方案）
    // --------------------------------------------------------------------
    // 为什么用它替换 whisper.cpp：
    //   旧实现直接把 whisper 生成的 SRT 写回时间轴，不做时间轴重建，
    //   结果是字幕首尾相接铺满、气口处也有字。
    //   faster-whisper 能给出**词级时间戳**，配合 VAD 后
    //   在真实停顿处自然断开，气口就留出来了。
    //
    // 中英文都走这条链路：--lang auto 让模型自己判断语种。
    // ====================================================================
    // 语言 → faster-whisper 模型档位
    // medium 对短剧对白够用；要更高准确率可改 large-v3（需先下载模型）
    // 本次识别是否走 FunASR（仅当用户在下拉里显式选了 funasr-zh）
    function useFunasrEngine() {
        try {
            return String(el.selModel && el.selModel.value || '').indexOf('funasr') === 0;
        } catch (e) { return false; }
    }

    // 从模型下拉解析 faster-whisper 档位：fw-medium → medium
    function fwModelName(lang) {
        var v = '';
        try { v = String(el.selModel && el.selModel.value || ''); } catch (e) {}
        if (v.indexOf('fw-') === 0) return v.slice(3);
        return 'medium';
    }

    function fasterWhisperReady() {
        var py = detectPython();
        if (!py) return { ok: false, reason: '未找到 Python' };
        var cli = path.join(extRoot, 'py', 'faster_whisper_cli.py');
        if (!fs.existsSync(cli)) return { ok: false, reason: '缺少 py/faster_whisper_cli.py' };
        return { ok: true, py: py, cli: cli };
    }

    // ---------- 模型就位检查与在线下载 ----------
    // 部署包不带模型（medium 4GB），首次使用现场下载。
    // 国内直连 HuggingFace 常失败，脚本里已内置 hf-mirror 回退。
    function fwModelPath(model) {
        return path.join(extRoot, 'models', 'faster-whisper', model);
    }

    function fwModelReady(model) {
        var need = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'];
        var dir = fwModelPath(model);
        for (var i = 0; i < need.length; i++) {
            var f = path.join(dir, need[i]);
            try { if (!fs.existsSync(f) || fs.statSync(f).size === 0) return false; }
            catch (e) { return false; }
        }
        return true;
    }

    // 预估体积，用于提示用户要下载多大
    function fwModelSizeText(model) {
        var map = { tiny: '约 150MB', base: '约 145MB', small: '约 490MB',
                    medium: '约 1.5GB', 'large-v3': '约 3.1GB' };
        return map[model] || '未知大小';
    }

    // ---------- 识别引擎依赖的自检与增量安装 ----------
    // 老版本用户通过「在线更新」拿不到 runtime/ 下的库（更新机制跳过大目录），
    // 但实际只差 66MB 增量包。这里：一进面板就静默检查，缺了自动补。
    // 判断识别引擎依赖是否可用。
    // 注意：不能用「插件目录下有没有 runtime/」来判断 —— 主版用的是系统 Python，
    // 插件目录里根本没有 runtime/（那是客户版便携 Python 的路径），
    // 那样判断会让主版永远以为缺组件。
    // 正确做法：分两种情况
    //   1) 插件自带 runtime（客户版）-> 查文件
    //   2) 否则（主版）-> 真跑一次 python -c "import faster_whisper"
    var __fwEngineState = null;   // 缓存，避免每次识别都起进程

        function fwEngineReady(force) {
        if (!force && __fwEngineState !== null) return __fwEngineState;

        var bundled = path.join(extRoot, 'runtime', 'python', 'python.exe');
        var py = detectPython();
        var spDir = path.join(extRoot, 'runtime', 'python', 'Lib', 'site-packages');
        var needFiles = [
            path.join(spDir, 'faster_whisper', '__init__.py'),
            path.join(spDir, 'ctranslate2', 'ctranslate2.dll')
        ];

        // 先看插件目录里的库文件在不在 —— 这是"组件已装好"的直接证据，
        // 不该因为缺 python.exe 就否掉（解压成功就是成功）。
        var filesOk = true;
        for (var i = 0; i < needFiles.length; i++) {
            try {
                if (!fs.existsSync(needFiles[i]) || fs.statSync(needFiles[i]).size === 0) {
                    filesOk = false;
                    break;
                }
            } catch (e) { filesOk = false; break; }
        }
        if (filesOk) {
            __fwEngineState = true;
            return true;
        }

        // 插件目录没有库 → 再看能不能用系统 Python（主版走这条）
        if (!py) { __fwEngineState = false; return false; }
        // 有便携 Python 但库不全，说明没装好，直接用系统 Python 也没意义
        if (fs.existsSync(bundled)) {
            __fwEngineState = false;
            return false;
        }
        try {
            var r = child_process.spawnSync(py, ['-c', 'import faster_whisper'], {
                timeout: 20000, windowsHide: true
            });
            __fwEngineState = (r && r.status === 0);
        } catch (e) {
            __fwEngineState = false;
        }
        return __fwEngineState;
    }

    // 详细诊断：失败时告诉用户到底缺什么
    function fwEngineDiag() {
        var spDir = path.join(extRoot, 'runtime', 'python', 'Lib', 'site-packages');
        var out = [];
        var need = [
            ['faster_whisper/__init__.py', path.join(spDir, 'faster_whisper', '__init__.py')],
            ['ctranslate2/ctranslate2.dll', path.join(spDir, 'ctranslate2', 'ctranslate2.dll')]
        ];
        need.forEach(function (it) {
            try {
                if (fs.existsSync(it[1])) {
                    out.push(it[0] + '（' + Math.round(fs.statSync(it[1]).size / 1024) + ' KB）');
                } else {
                    out.push(it[0] + '（缺失）');
                }
            } catch (e) { out.push(it[0] + '（读取失败）'); }
        });
        var pyBundled = fs.existsSync(path.join(extRoot, 'runtime', 'python', 'python.exe'));
        return '插件目录：' + extRoot + '；' + out.join('；') +
               '；便携Python：' + (pyBundled ? '有' : '无');
    }

    // 引擎状态改变后清缓存（装完重查）
    function resetFwEngineState() { __fwEngineState = null; }

    // GPU 加速包（CUDA 运行库）安装：独立于 CPU 组件
    function installFwGpu(onDone) {
        var pyr = detectPython();
        if (!pyr) { onDone(new Error('未找到 Python')); return; }
        var cli = path.join(extRoot, 'py', 'fw_gpu_install.py');
        if (!fs.existsSync(cli)) { onDone(new Error('缺少 py/fw_gpu_install.py')); return; }

        var ct2 = path.join(extRoot, 'runtime', 'python', 'Lib', 'site-packages', 'ctranslate2');
        dlReset('gpu', '正在下载 GPU 加速包（约 550MB）');
        dlProgress(1, '正在连接下载源…', '大文件，按网速约需几分钟');

        function onLine(line) {
            line = String(line || '').trim();
            if (line.indexOf('PROGRESS ') !== 0) return;
            var parts = line.split(' ');
            var stage = parts[1] || '';
            var pct = parseInt(parts[2], 10) || 0;
            var note = parts.slice(3).join(' ');
            if (stage === 'download') {
                var m = note.match(/([\d.]+)\s*([KMG]?B)\s*\/\s*([\d.]+)\s*([KMG]?B)/i);
                var meta = note;
                if (m) {
                    var unit = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
                    var d = parseFloat(m[1]) * (unit[m[2].toUpperCase()] || 1);
                    var t = parseFloat(m[3]) * (unit[m[4].toUpperCase()] || 1);
                    var inf = dlBytes(d, t);
                    pct = inf.pct; meta = inf.meta;
                }
                dlProgress(3 + Math.round(pct * 0.88), '下载 GPU 加速包 ' + Math.round(pct) + '%', meta);
            } else if (stage === 'extract') {
                dlProgress(92 + Math.round(pct * 0.07), '解压 CUDA 库 ' + pct + '%', '解压中');
            } else if (stage === 'retry') {
                dlProgress(2, '重试中…', note);
            } else if (stage === 'source') {
                dlProgress(1, '已连接下载源…', note);
            }
        }

        var proc = child_process.spawn(pyr, [cli, '--install'], {
            cwd: path.dirname(cli), windowsHide: true
        });
        if (proc.stdout) proc.stdout.on('data', function (c) { String(c).split('\n').forEach(onLine); });
        if (proc.stderr) proc.stderr.on('data', function (c) { String(c).split('\n').forEach(onLine); });

        // 体积探针：cublasLt 约 660MB，按它判进度
        var probe = setInterval(function () {
            if (!dlState.active) { clearInterval(probe); return; }
            try {
                var f = path.join(ct2, 'cublasLt64_12.dll');
                if (!fs.existsSync(f)) return;
                var sz = fs.statSync(f).size || 0;
                if (sz > 0) {
                    var p = Math.min(90, 3 + Math.round(sz / (660 * 1024 * 1024) * 87));
                    dlProgress(p, '下载 GPU 加速包 ' + p + '%', '已写入 ' + humanBytes(sz));
                }
            } catch (e) {}
        }, 800);

        proc.on('error', function (e) {
            clearInterval(probe);
            dlFail(e.message || '启动失败', function () { installFwGpu(onDone); });
            onDone(new Error(e.message || '启动失败'));
        });

        proc.on('close', function (code) {
            clearInterval(probe);
            var okFile = fs.existsSync(path.join(ct2, 'cublasLt64_12.dll'));
            if (code === 0 && okFile) {
                dlDone('GPU 加速包已就绪，重新识别将使用 GPU');
                onDone(null, { ok: true });
            } else {
                var msg = code === 0 ? 'CUDA 库不完整' : ('安装进程退出（代码 ' + code + '）');
                dlFail(msg, function () { installFwGpu(onDone); });
                onDone(new Error(msg));
            }
        });

        return proc;
    }

    // 下载并安装增量包，进度打到状态栏
        // 下载并安装增量包（spawn + 双通道进度 + 体积兜底探针）
    function installFwEngine(onDone) {
        var pyr = detectPython();
        if (!pyr) { onDone(new Error('未找到 Python')); return; }
        var cli = path.join(extRoot, 'py', 'fw_engine_install.py');
        if (!fs.existsSync(cli)) { onDone(new Error('缺少 py/fw_engine_install.py')); return; }

        dlReset('engine', '正在补齐识别组件（约 74MB）');
        dlProgress(1, '正在连接下载源…', '若长时间无变化，检查网络或改用网盘');

        var lastPct = 0, lastNote = '';
        function onLine(line) {
            line = String(line || '').trim();
            if (line.indexOf('PROGRESS ') !== 0) return;
            var parts = line.split(' ');
            var stage = parts[1] || '';
            var pct = parseInt(parts[2], 10) || 0;
            var note = parts.slice(3).join(' ');

            function bytesOf(note) {
                var m = note.match(/([\d.]+)\s*([KMG]?B)\s*\/\s*([\d.]+)\s*([KMG]?B)/i);
                if (!m) return null;
                var unit = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
                return {
                    done: parseFloat(m[1]) * (unit[m[2].toUpperCase()] || 1),
                    total: parseFloat(m[3]) * (unit[m[4].toUpperCase()] || 1)
                };
            }

            if (stage === 'download') {
                var b = bytesOf(note);
                var meta = note;
                if (b) { var i = dlBytes(b.done, b.total); pct = i.pct; meta = i.meta; }
                lastPct = pct; lastNote = meta;
                dlProgress(3 + Math.round(pct * 0.82), '下载识别组件 ' + Math.round(pct) + '%', meta);
            } else if (stage === 'extract') {
                lastPct = 85 + Math.round(pct * 0.14);
                dlProgress(lastPct, '解压组件 ' + pct + '%', '解压中，请稍候');
            } else if (stage === 'retry') {
                dlProgress(2, '重试中…', note);
            } else if (stage === 'source') {
                dlProgress(1, '已连接下载源，开始下载…', note);
            }
        }

        // 双通道：stdout 与 stderr 都读
        var proc = child_process.spawn(pyr, [cli, '--install'], {
            cwd: path.dirname(cli),
            windowsHide: true
        });
        if (proc.stdout) proc.stdout.on('data', function (c) { String(c).split('\n').forEach(onLine); });
        if (proc.stderr) proc.stderr.on('data', function (c) { String(c).split('\n').forEach(onLine); });

        // 兜底探针：读不到输出时，用组件目录体积增长刷新界面
        var probe = setInterval(function () {
            if (!dlState.active) { clearInterval(probe); return; }
            try {
                var sp = path.join(extRoot, 'runtime', 'python', 'Lib', 'site-packages');
                var sz = 0;
                ['faster_whisper', 'ctranslate2', 'av'].forEach(function (n) {
                    var d = path.join(sp, n);
                    if (!fs.existsSync(d)) return;
                    var st = fs.statSync(d);
                    sz += st.size || 0;
                });
                if (sz > 0) {
                    // 有动静就说明在工作，给个大致百分比（组件解压后约 230MB）
                    var approx = Math.min(84, 3 + Math.round(sz / (230 * 1024 * 1024) * 80));
                    if (approx > lastPct) {
                        dlProgress(approx, '正在写入组件 ' + approx + '%',
                                   '已写入 ' + humanBytes(sz));
                    }
                }
            } catch (e) {}
        }, 600);

        proc.on('error', function (e) {
            clearInterval(probe);
            dlFail(e.message || '启动失败', function () { installFwEngine(onDone); });
            onDone(new Error(e.message || '启动失败'));
        });

        proc.on('close', function (code) {
            clearInterval(probe);
            if (code === 0) {
                resetFwEngineState();
                if (fwEngineReady(true)) {
                    dlDone('识别组件已就绪，可以开始识别');
                    onDone(null, { ok: true });
                } else {
                    var diag = fwEngineDiag();
                    dlFail('安装完成但关键文件仍缺失。' + diag, function () { installFwEngine(onDone); });
                    onDone(new Error('安装完成但关键文件仍缺失。' + diag));
                }
            } else {
                var msg = '安装进程退出（代码 ' + code + '）';
                dlFail(msg, function () { installFwEngine(onDone); });
                onDone(new Error(msg));
            }
        });

        return proc;
    }


    // ---------- 下载反馈区（模型 / 引擎通用）----------
    var dlState = { active: false, kind: '', startAt: 0, lastBytes: 0, lastAt: 0, speed: 0 };

    function dlEl(id) { return document.getElementById(id); }

    function dlReset(kind, title) {
        dlState.active = true;
        dlState.kind = kind || '';
        dlState.startAt = Date.now();
        dlState.lastBytes = 0;
        dlState.lastAt = Date.now();
        dlState.speed = 0;

        var box = dlEl('dlBox');
        if (!box) return;
        box.style.display = '';
        if (dlEl('dlTitle')) dlEl('dlTitle').textContent = title || '下载中';
        if (dlEl('dlFill')) dlEl('dlFill').style.width = '0%';
        if (dlEl('dlText')) { dlEl('dlText').textContent = '准备中…'; dlEl('dlText').className = ''; }
        if (dlEl('dlMeta')) dlEl('dlMeta').textContent = '';
        if (dlEl('dlResult')) { dlEl('dlResult').style.display = 'none'; dlEl('dlResult').innerHTML = ''; }
        if (dlEl('btnDlRetry')) dlEl('btnDlRetry').style.display = 'none';
        if (dlEl('btnDlClose')) dlEl('btnDlClose').style.display = 'none';
        // 滚到可见
        try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    }

    function dlProgress(pct, text, note) {
        if (!dlState.active) return;
        if (dlEl('dlFill')) dlEl('dlFill').style.width = Math.min(100, Math.max(0, pct)) + '%';
        if (dlEl('dlText') && text) dlEl('dlText').textContent = text;
        if (dlEl('dlMeta') && note !== undefined) dlEl('dlMeta').textContent = note || '';
        // 同步到面板状态区，双通道可见
        setProgress(pct, text || '');
    }

    // 由「已下载字节/总量」算速率与剩余时间
    function dlBytes(done, total) {
        var now = Date.now();
        var dt = (now - dlState.lastAt) / 1000;
        if (dt >= 0.5) {
            var delta = done - dlState.lastBytes;
            if (delta >= 0) dlState.speed = delta / dt;
            dlState.lastBytes = done;
            dlState.lastAt = now;
        }
        var pct = total > 0 ? done / total * 100 : 0;
        var meta = humanBytes(done) + (total > 0 ? ' / ' + humanBytes(total) : '');
        if (dlState.speed > 1024) {
            meta += '　' + humanBytes(dlState.speed) + '/s';
            if (total > 0 && dlState.speed > 0) {
                var left = Math.max(0, (total - done) / dlState.speed);
                meta += '　剩余 ' + fmtLeft(left);
            }
        }
        return { pct: pct, meta: meta };
    }

    function humanBytes(n) {
        if (!n || n < 0) return '0 B';
        var u = ['B', 'KB', 'MB', 'GB'];
        var i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
    }

    function fmtLeft(sec) {
        sec = Math.round(sec);
        if (sec < 60) return sec + ' 秒';
        if (sec < 3600) return Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒';
        return Math.floor(sec / 3600) + ' 时 ' + Math.floor((sec % 3600) / 60) + ' 分';
    }

    function dlDone(msg) {
        dlState.active = false;
        var box = dlEl('dlBox');
        if (!box) return;
        if (dlEl('dlFill')) dlEl('dlFill').style.width = '100%';
        if (dlEl('dlText')) {
            dlEl('dlText').className = 'dl-ok';
            dlEl('dlText').textContent = '✓ ' + (msg || '下载完成');
        }
        if (dlEl('dlMeta')) dlEl('dlMeta').textContent = '';
        if (dlEl('dlResult')) {
            dlEl('dlResult').style.display = '';
            dlEl('dlResult').innerHTML =
                '<span class="dl-badge ok">成功</span><span class="dl-ok">' +
                escapeHtml(msg || '下载完成') + '</span>';
        }
        if (dlEl('btnDlClose')) dlEl('btnDlClose').style.display = '';
        setStatus('✓ ' + (msg || '下载完成'), 'ok');
        setProgress(100, msg || '完成');
        // 成功后 8 秒自动收起，不挡后续操作
        setTimeout(function () {
            var b = dlEl('dlBox');
            if (b && !dlState.active) b.style.display = 'none';
        }, 8000);
    }

    function dlFail(msg, onRetry) {
        dlState.active = false;
        var box = dlEl('dlBox');
        if (!box) return;
        box.style.display = '';
        if (dlEl('dlText')) {
            dlEl('dlText').className = 'dl-err';
            dlEl('dlText').textContent = '✗ 下载失败';
        }
        if (dlEl('dlMeta')) dlEl('dlMeta').textContent = '';
        if (dlEl('dlResult')) {
            dlEl('dlResult').style.display = '';
            dlEl('dlResult').innerHTML =
                '<span class="dl-badge err">失败</span><span class="dl-err">' +
                escapeHtml(msg || '未知错误') + '</span>';
        }
        if (dlEl('btnDlRetry')) {
            dlEl('btnDlRetry').style.display = onRetry ? '' : 'none';
            dlEl('btnDlRetry').onclick = function () {
                if (onRetry) { dlEl('btnDlRetry').style.display = 'none'; onRetry(); }
            };
        }
        if (dlEl('btnDlClose')) dlEl('btnDlClose').style.display = '';
        setStatus('✗ 下载失败：' + (msg || ''), 'err');
        setProgress(-1, '');
    }

    // 确保引擎依赖就位（缺失自动安装），cb(err)
    function ensureFwEngine(cb) {
        if (fwEngineReady(true)) {
            // 已就绪也要给个明确回应，否则用户点了以为没反应
            dlReset('engine', '识别组件检查');
            dlDone('识别组件已就绪，无需下载');
            cb(null);
            return;
        }
        // 静默安装：文案说明清楚，不弹确认框（只 66MB，且不装就用不了）
        setStatus('识别引擎组件缺失，正在自动补齐…', 'warn');
        installFwEngine(function (err) {
            if (err) {
                setStatus('识别引擎补齐失败：' + err.message, 'err');
                cb(err);
                return;
            }
            setStatus('识别引擎已就绪', 'ok');
            cb(null);
        });
    }

    // 启动下载，进度打到状态栏
        // 下载模型（spawn + 双通道进度 + 体积兜底探针）
    function downloadFwModel(model, onDone) {
        var pyr = detectPython();
        if (!pyr) { onDone(new Error('未找到 Python')); return; }
        var cli = path.join(extRoot, 'py', 'fw_model_download.py');
        if (!fs.existsSync(cli)) { onDone(new Error('缺少 py/fw_model_download.py')); return; }

        var modelDir = fwModelPath(model);
        dlReset('model', '正在下载识别模型 ' + model + '（' + fwModelSizeText(model) + '）');
        dlProgress(1, '正在连接下载源…', '若长时间无变化，检查网络');

        function onLine(line) {
            line = String(line || '').trim();
            if (line.indexOf('PROGRESS ') !== 0) return;
            var parts = line.split(' ');
            var stage = parts[1] || '';
            var pct = parseInt(parts[2], 10) || 0;
            var note = parts.slice(3).join(' ');
            if (stage === 'source') {
                dlProgress(2, '已连接下载源，开始下载…', note);
            } else if (stage === 'file') {
                var m = note.match(/([\d.]+)\s*([KMG]?B)\s*\/\s*([\d.]+)\s*([KMG]?B)/i);
                var meta = note;
                if (m) {
                    var unit = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
                    var d = parseFloat(m[1]) * (unit[m[2].toUpperCase()] || 1);
                    var t = parseFloat(m[3]) * (unit[m[4].toUpperCase()] || 1);
                    var inf = dlBytes(d, t);
                    pct = inf.pct; meta = inf.meta;
                }
                dlProgress(4 + Math.round(pct * 0.94), '下载模型 ' + model + '  ' + Math.round(pct) + '%', meta);
            } else if (stage === 'retry') {
                dlProgress(2, '重试中…', note);
            }
        }

        var proc = child_process.spawn(pyr, [cli, '--model', model], {
            cwd: path.dirname(cli),
            windowsHide: true
        });
        if (proc.stdout) proc.stdout.on('data', function (c) { String(c).split('\n').forEach(onLine); });
        if (proc.stderr) proc.stderr.on('data', function (c) { String(c).split('\n').forEach(onLine); });

        // 兜底探针：模型目录体积增长
        var expectBytes = { tiny: 78e6, base: 145e6, small: 490e6, medium: 1530e6, 'large-v3': 3100e6 }[model] || 1530e6;
        var probe = setInterval(function () {
            if (!dlState.active) { clearInterval(probe); return; }
            try {
                if (!fs.existsSync(modelDir)) return;
                var sz = 0;
                fs.readdirSync(modelDir).forEach(function (f) {
                    try { sz += fs.statSync(path.join(modelDir, f)).size || 0; } catch (e) {}
                });
                if (sz > 0) {
                    var p = Math.min(96, 4 + Math.round(sz / expectBytes * 92));
                    dlProgress(p, '下载模型 ' + model + '  ' + p + '%', '已写入 ' + humanBytes(sz));
                }
            } catch (e) {}
        }, 800);

        proc.on('error', function (e) {
            clearInterval(probe);
            dlFail(e.message || '启动失败', function () { downloadFwModel(model, onDone); });
            onDone(new Error(e.message || '启动失败'));
        });

        proc.on('close', function (code) {
            clearInterval(probe);
            if (code === 0 && fwModelReady(model)) {
                dlDone('模型「' + model + '」已就绪，可以开始识别');
                onDone(null, { ok: true, model: model });
            } else {
                var msg = code === 0 ? '下载完成但文件不完整' : ('下载进程退出（代码 ' + code + '）');
                dlFail(msg, function () { downloadFwModel(model, onDone); });
                onDone(new Error(msg));
            }
        });

        return proc;
    }

    // 识别前确保模型就位；缺失时询问并下载
    function ensureFwModel(model, cb) {
        if (fwModelReady(model)) { cb(null); return; }
        // 模型在但运行库不在（从组件面板单独下过模型的情况），先补库
        if (!fwEngineReady(true)) {
            installFwEngine(function (e) {
                if (e) { cb(e); return; }
                ensureFwModel(model, cb);
            });
            return;
        }
        var size = fwModelSizeText(model);
        var ok = confirm('识别模型「' + model + '」还没下载（' + size + '）。\n\n' +
                         '现在下载？需要联网，下载期间请勿关闭 PR。\n' +
                         '（只下载一次，之后直接使用）');
        if (!ok) { cb(new Error('已取消：需要先下载识别模型')); return; }
        downloadFwModel(model, function (err, info) {
            if (err) { cb(err); return; }
            cb(null, info);
        });
    }

    function runFasterWhisper(meta, wavPath, outJson, opts, cb) {
        var env = fasterWhisperReady();
        if (!env.ok) { cb({ seqId: meta.seqId, name: meta.seqName, status: 'err',
                            error: env.reason }); return; }

        var model = (opts && opts.model) || 'medium';
        var lang = (opts && opts.lang) || 'auto';
        var gap = (opts && opts.gap) || 0.45;
        var device = (opts && opts.useGpu) ? 'cuda' : 'cpu';

        var args = [env.cli,
            '--wav', wavPath,
            '--out', outJson,
            '--model', model,
            '--lang', lang,
            '--gap', String(gap),
            '--device', device];

        setStatus('识别中 [' + meta.name + '] 加载模型…', '');
        var proc = child_process.execFile(env.py, args, {
            cwd: path.dirname(env.cli),
            timeout: 3600000,
            maxBuffer: 1024 * 1024 * 80
        }, function (error, stdout, stderr) {
            if (stopRequested) { cb({ seqId: meta.seqId, name: meta.seqName, status: 'stopped' }); return; }
            if (error) {
                var detail = '识别失败: ' + (error.message || '') + ' ' + String(stderr || '').slice(-300);
                // 落盘诊断：下次直接看 collect/error.log 定位，不靠猜
                try {
                    if (window.__vhLog && window.__vhLog.err) {
                        window.__vhLog.err('[subtitle] ' + detail +
                            ' | py=' + env.py + ' | model=' + model +
                            ' | device=' + device + ' | seq=' + meta.seqName);
                    }
                } catch (e) {}
                cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: detail });
                return;
            }
            var data = null;
            try { data = JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch (e) {}
            if (!data || !data.ok) {
                var msg2 = (data && data.error) || '识别结果解析失败';
                try {
                    if (window.__vhLog && window.__vhLog.err) {
                        window.__vhLog.err('[subtitle] ' + msg2 + ' | py=' + env.py +
                            ' | model=' + model + ' | out=' + outJson);
                    }
                } catch (e) {}
                cb({ seqId: meta.seqId, name: meta.seqName, status: 'err', error: msg2 });
                return;
            }
            var subs = data.segments || [];
            cb({ seqId: meta.seqId, name: meta.seqName, status: 'ok',
                 count: subs.length, subtitles: subs,
                 lang: data.lang, device: data.device });
        });

        if (proc && proc.stderr) {
            proc.stderr.on('data', function (chunk) {
                var t = String(chunk);
                var m = t.match(/(\d{1,3})%/);
                if (m) setStatus('识别中 [' + meta.name + '] ' + m[1] + '%…', '');
            });
        }
        return proc;
    }



    // 检测 CUDA 版 whisper 是否可用：关键 DLL 存在 + 能成功执行 --help（验证驱动兼容）
    function detectCudaAvailable(cudaWhisperPath) {
        try {
            var cudaDir = path.dirname(cudaWhisperPath);
            // 关键 CUDA 依赖 DLL 必须都在
            var requiredDlls = [
                'cublas64_12.dll', 'cublasLt64_12.dll', 'ggml-cuda.dll', 'whisper.dll'
            ];
            for (var i = 0; i < requiredDlls.length; i++) {
                if (!fs.existsSync(path.join(cudaDir, requiredDlls[i]))) {
                    return false;
                }
            }
            // 实跑 --help 验证：若驱动不兼容，cublas 加载失败会退出码非 0 或报错
            var r = child_process.spawnSync(cudaWhisperPath, ['--help'], {
                cwd: cudaDir,
                encoding: 'utf8',
                timeout: 15000
            });
            if (r.error) return false;
            var out = (r.stdout || '') + (r.stderr || '');
            // 可靠信号：能打印出 "found N CUDA devices" 说明 cublas/驱动加载成功；
            // usage 文本作为弱兜底（可执行文件本身能跑）
            if (/found\s+\d+\s+CUDA\s+devices/i.test(out)) return true;
            if (/usage/i.test(out) && /--model/i.test(out)) return true;
            return false;
        } catch (e) {
            return false;
        }
    }

    function finishBatch() {
        // 先冻结总耗时（计时器还没停），再收尾
        var totalElapsed = (progressStartMs !== null) ? (Date.now() - progressStartMs) : 0;
        setBusy(false);
        setProgress(100, '完成');
        if (totalElapsed > 0) {
            el.progressTime.textContent = '总耗时 ' + fmtDuration(totalElapsed) + ' · 剩余 0:00';
        }
        var okCount = batchResults.filter(function (r) { return r.status === 'ok'; }).length;
        var totalN = batchResults.length;
        var failList = batchResults.filter(function (r) { return r.status === 'err'; });
        if (failList.length > 0) {
            var firstErr = String(failList[0].error || '').slice(0, 120);
            setStatus('批量完成：成功 ' + okCount + '/' + totalN + ' 个序列' +
                      '　失败 ' + failList.length + ' 个：' + firstErr, 'err');
        } else {
            setStatus('批量完成：成功 ' + okCount + '/' + totalN + ' 个序列', 'ok');
        }
        renderBatchResults();
        el.resultCard.style.display = 'block';
    }

    // ---------- 4. 结果展示 ----------
    function renderBatchResults() {
        el.resultSummary.innerHTML = '';
        batchResults.forEach(function (r, i) {
            var div = document.createElement('div');
            div.className = 'result-item';
            div.dataset.index = i;
            var nm = document.createElement('span');
            nm.className = 'nm';
            nm.textContent = r.name;
            var tag = document.createElement('span');
            if (r.status === 'ok') {
                tag.className = 'ok-tag';
                tag.textContent = '✓ ' + r.count + ' 条';
            } else if (r.status === 'err') {
                tag.className = 'err-tag';
                tag.textContent = '✗ 失败';
                div.title = r.error;
                // 错误原因直接显示，不要只放在 title 里（悬停才见等于看不见）
                var why = document.createElement('div');
                why.className = 'err-why';
                why.style.cssText = 'font-size:11px;color:#ff8f8f;margin-top:4px;' +
                                    'line-height:1.5;word-break:break-all;opacity:.92;';
                why.textContent = String(r.error || '未知错误').slice(0, 260);
                div.appendChild(why);
            } else {
                tag.className = 'err-tag';
                tag.textContent = '已停止';
            }
            div.appendChild(nm);
            div.appendChild(tag);
            div.onclick = function () { selectResult(i); };
            el.resultSummary.appendChild(div);
        });
        // 默认选中第一个成功的
        var firstOk = batchResults.findIndex(function (r) { return r.status === 'ok'; });
        if (firstOk >= 0) selectResult(firstOk);
    }

    function selectResult(i) {
        var r = batchResults[i];
        if (!r || r.status !== 'ok') return;
        currentSeqId = r.seqId;
        subtitles = r.subtitles || [];
        // 高亮
        var items = el.resultSummary.querySelectorAll('.result-item');
        items.forEach(function (it, idx) { it.classList.toggle('sel', idx === i); });
        renderList();
        setStatus('当前查看：' + r.name + '（' + subtitles.length + ' 条）', 'ok');
    }

    // 统一数据同步点：任何改动（手动改字/校对回写）都同步 batchResults + 重渲染
    function syncSubtitles(newSubs) {
        subtitles = newSubs || [];
        // 同步回 batchResults 缓存，避免重选序列后改动丢失
        batchResults.forEach(function (r) {
            if (r.seqId === currentSeqId) {
                r.subtitles = subtitles;
                r.count = subtitles.length;
            }
        });
        renderList();
    }

    // ---------- 渲染字幕列表 ----------
    function renderList() {
        el.list.innerHTML = '';
        subtitles.forEach(function (s, i) {
            var div = document.createElement('div');
            div.className = 'subtitle-item';
            div.dataset.index = i;
            var textHtml;
            if (window.__dictBridge && window.__dictBridge.highlight) {
                textHtml = window.__dictBridge.highlight(s.text);
            } else {
                textHtml = escapeHtml(s.text);
            }
            div.innerHTML =
                '<span class="t">' + formatTime(s.start) + ' → ' + formatTime(s.end) + '</span>' +
                '<span class="x">' + textHtml + '</span>' +
                '<span class="del" title="删除此条">×</span>';
            div.onclick = function () { editSubtitle(i, div); };
            var delBtn = div.querySelector('.del');
            delBtn.onclick = function (e) {
                e.stopPropagation();
                removeSubtitle(i);
            };
            el.list.appendChild(div);
        });
    }

    function removeSubtitle(i) {
        if (i < 0 || i >= subtitles.length) return;
        subtitles.splice(i, 1);
        syncSubtitles(subtitles);
        setStatus('已删除第 ' + (i + 1) + ' 条字幕', 'ok');
    }

    function editSubtitle(i, div) {
        div.classList.add('editing');
        var s = subtitles[i];
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'edit-input';
        input.style.cssText = 'background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:12px;width:100%;';
        input.value = s.text;
        div.appendChild(input);
        input.focus();
        input.select();
        var done = function () {
            s.text = input.value;
            syncSubtitles(subtitles);
        };
        input.onblur = done;
        input.onkeydown = function (e) {
            if (e.key === 'Enter') { input.blur(); }
        };
    }

    // ---------- 回写字幕轨 ----------
    function writeBack() {
        if (!currentSeqId) { setStatus('请先在结果区选择一个序列', 'err'); return; }
        if (subtitles.length === 0) { setStatus('当前序列没有字幕可回写', 'err'); return; }

        var srtContent = toSRT(subtitles);
        // 带上序列名，host 侧用它给 srt 文件命名
        var seqName = '';
        var hit = batchResults.filter(function (r) { return r.seqId === currentSeqId; });
        if (hit.length > 0) seqName = hit[0].name || '';

        var payloadJson = JSON.stringify({ srt: srtContent, seqName: seqName });
        var setScript = 'wsWriteBackPayload = ' + payloadJson + ';';
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('wsWriteBackStr("' + currentSeqId + '")', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setStatus('已回写字幕轨（' + (data.fileName || '') + '）', 'ok');
                    } else {
                        setStatus(data.error || '回写失败', 'err');
                    }
                } catch (e) {
                    setStatus('回写解析失败: ' + result, 'err');
                }
            });
        });
    }

    // ---------- 导出 SRT ----------
    function exportSrt() {
        if (!currentSeqId) { setStatus('请先在结果区选择一个序列', 'err'); return; }
        if (subtitles.length === 0) { setStatus('当前序列没有字幕可导出', 'err'); return; }
        var content = toSRT(subtitles);
        var result;
        try {
            // showSaveDialogEx：同步返回 { err, data }，路径在 data 字段
            result = window.cep.fs.showSaveDialogEx('导出字幕', '', ['.srt'], '', '', '保存', '文件名');
        } catch (e) {
            setStatus('打开保存对话框失败: ' + e.message, 'err');
            return;
        }
        var p = result && result.data;
        if (p) {
            try {
                fs.writeFileSync(p, content, 'utf8');
                setStatus('已导出: ' + p, 'ok');
            } catch (e) {
                setStatus('导出失败: ' + e.message, 'err');
            }
        }
    }

    // ---------- 人声分离（Spleeter 2-stem，本地引擎）----------
    // 关键：sherpa-onnx-offline-source-separation 是纯 C++ 程序，
    // 和 whisper 一样处理不了中文路径（内部 ANSI 代码页），
    // 所以引擎 + 模型 + 输入输出 wav 全部放到英文目录。
    function getSepDir() {
        return path.join(os.homedir(), 'whisper_subtitle_sep');
    }

    function ensureSepAssets(cb) {
        var sepDir = getSepDir();
        var legacyExt = path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions', 'com.zhang.whisper-subtitle');
        // sherpa 引擎与 spleeter 模型：优先本插件目录，回退旧字幕插件 CEP 目录
        function pickLocal(rel) {
            var a = path.join(extRoot, rel);
            if (fs.existsSync(a)) return a;
            var b = path.join(legacyExt, rel);
            return b;
        }
        var needed = [
            { src: pickLocal('bin/sherpa/sherpa-onnx-offline-source-separation.exe'), dst: path.join(sepDir, 'sherpa-onnx-offline-source-separation.exe') },
            { src: pickLocal('bin/sherpa/onnxruntime.dll'), dst: path.join(sepDir, 'onnxruntime.dll') },
            { src: pickLocal('bin/sherpa/onnxruntime_providers_shared.dll'), dst: path.join(sepDir, 'onnxruntime_providers_shared.dll') },
            { src: pickLocal('models/spleeter/sherpa-onnx-spleeter-2stems-fp16/vocals.fp16.onnx'), dst: path.join(sepDir, 'vocals.fp16.onnx') },
            { src: pickLocal('models/spleeter/sherpa-onnx-spleeter-2stems-fp16/accompaniment.fp16.onnx'), dst: path.join(sepDir, 'accompaniment.fp16.onnx') }
        ];
        try {
            if (!fs.existsSync(sepDir)) fs.mkdirSync(sepDir, { recursive: true });
        } catch (e) { return cb('无法创建分离工作目录: ' + e.toString()); }
        var missing = [];
        for (var i = 0; i < needed.length; i++) {
            if (!fs.existsSync(needed[i].src)) {
                missing.push(needed[i].src);
                continue;
            }
            if (!fs.existsSync(needed[i].dst)) {
                try { fs.copyFileSync(needed[i].src, needed[i].dst); } catch (e) {
                    return cb('复制分离组件失败: ' + e.toString());
                }
            }
        }
        if (missing.length > 0) {
            return cb('人声分离组件缺失: ' + missing.join(', '));
        }
        cb(null, sepDir);
    }

    function separateVocals() {
        if (sepBusy) { setSepStatus('分离进行中...', 'warn'); return; }

        setSepBusy(true);
        setSepStatus('正在读取当前活动序列的选中片段...', '');
        var ffmpegPath = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
        if (!fs.existsSync(ffmpegPath)) { setSepBusy(false); setSepStatus('FFmpeg 缺失', 'err'); return; }

        // 传空 seqId → host 端 wsFindSequence('') 实时取当前活动序列，不依赖字幕板块的缓存
        csInterface.evalScript('wsGetSequenceClipsRangeStr("", "selection")', function (result) {
            var data;
            try { data = JSON.parse(result); } catch (e) {
                setSepBusy(false); setSepStatus('解析失败: ' + result, 'err'); return;
            }
            if (data.error || !data.clips || data.clips.length === 0) {
                setSepBusy(false);
                setSepStatus(data.error || '没有选中的片段', 'err');
                return;
            }
            // 取选中的第一个（人声分离通常针对单个素材）
            var clip = data.clips[0];
            if (!clip.mediaPath) { setSepBusy(false); setSepStatus('选中的片段没有媒体路径', 'err'); return; }
            // 来源名：优先片段名，否则媒体文件名（写入结果列表，方便认哪一集）
            var clipName = clip.name || path.basename(clip.mediaPath || '');

            ensureSepAssets(function (err, sepDir) {
                if (err) { setSepBusy(false); setSepStatus(err, 'err'); return; }

                var inputWav = path.join(sepDir, 'input.wav');
                var vocalsWav = path.join(sepDir, 'vocals.wav');
                var accompWav = path.join(sepDir, 'accomp.wav');
                try {
                    if (fs.existsSync(inputWav)) fs.unlinkSync(inputWav);
                    if (fs.existsSync(vocalsWav)) fs.unlinkSync(vocalsWav);
                    if (fs.existsSync(accompWav)) fs.unlinkSync(accompWav);
                } catch (e) {}

                // 输出文件用纯 ASCII 时间戳命名（sherpa 引擎处理不了中文文件名），
                // 后缀 _voice / _music 便于导入后区分人声/伴奏
                var ts = Date.now();
                var outVocals = path.join(sepDir, 'voice_' + ts + '.wav');
                var outAccomp = path.join(sepDir, 'music_' + ts + '.wav');

                // 1. ffmpeg 从素材源切出选中块音频（对齐素材内 in~out）
                var mixArgs = [
                    '-ss', clip.inPoint.toFixed(3),
                    '-t', (clip.outPoint - clip.inPoint).toFixed(3),
                    '-i', clip.mediaPath,
                    '-ac', '2', '-ar', '48000',
                    '-y', inputWav
                ];
                setSepStatus('正在提取选中片段音频...', '');
                child_process.execFile(ffmpegPath, mixArgs, { timeout: 300000, maxBuffer: 1024 * 1024 * 20 }, function (err) {
                    if (err || !fs.existsSync(inputWav)) {
                        setSepBusy(false);
                        setSepStatus('提取音频失败: ' + (err ? err.message : '未生成 wav'), 'err');
                        return;
                    }

                    // 2. 跑 sherpa 分离引擎（英文路径）
                    var exe = path.join(sepDir, 'sherpa-onnx-offline-source-separation.exe');
                    var sepArgs = [
                        '--spleeter-vocals=' + path.join(sepDir, 'vocals.fp16.onnx'),
                        '--spleeter-accompaniment=' + path.join(sepDir, 'accompaniment.fp16.onnx'),
                        '--num-threads=4',
                        '--input-wav=' + inputWav,
                        '--output-vocals-wav=' + outVocals,
                        '--output-accompaniment-wav=' + outAccomp
                    ];
                    setSepStatus('Spleeter 分离中（本地 CPU，很快）...', '');
                    child_process.execFile(exe, sepArgs, { cwd: sepDir, timeout: 1800000, maxBuffer: 1024 * 1024 * 50 }, function (err2) {
                        if (err2 || !fs.existsSync(outVocals)) {
                            setSepBusy(false);
                            setSepStatus('分离失败: ' + (err2 ? err2.message : '未生成人声文件'), 'err');
                            return;
                        }
                        sepVocalsPath = outVocals;
                        sepAccompPath = fs.existsSync(outAccomp) ? outAccomp : null;
                        setSepBusy(false);
                        // 列出结果（可试听 / 拖拽 / 导入），源名取选中片段名
                        addSepResult('vocals', outVocals, clipName, clip.mediaPath);
                        if (sepAccompPath) addSepResult('accomp', sepAccompPath, clipName, clip.mediaPath);
                        setSepStatus('分离完成：结果已列在下方，可试听或直接拖进时间轴', 'ok');
                    });
                });
            });
        });
    }

    function importVocals() {
        importToBin(sepResults.map(function (r) { return r.path; }), '全部分离结果');
    }

    // ---------- 分离结果列表（试听 / 拖拽进时间轴 / 导入素材箱）----------
    var sepResults = [];        // [{ kind, path, name, srcName, srcPath, addedAt }]
    var sepWs = null;           // 当前试听的 WaveSurfer
    var sepWsPath = '';
    var sepWsPlaying = false;

    function sepKindLabel(kind) { return kind === 'vocals' ? '人声' : '伴奏'; }
    function sepKindClass(kind) { return kind === 'vocals' ? 'sep-res-vocals' : 'sep-res-accomp'; }

    function addSepResult(kind, p, srcName, srcPath) {
        if (!p || !fs.existsSync(p)) return;
        // 同路径去重（重跑同一集不重复列）
        var exist = sepResults.filter(function (r) { return r.path === p; })[0];
        if (exist) return;
        sepResults.push({
            kind: kind,
            path: p,
            name: path.basename(p),
            srcName: srcName || '',
            srcPath: srcPath || '',
            addedAt: Date.now()
        });
        renderSepResults();
    }

    function clearSepResults() {
        stopSepPlay();
        sepResults = [];
        sepVocalsPath = null;
        sepAccompPath = null;
        renderSepResults();
        setSepStatus('已清空分离结果列表（磁盘上的文件未删除）', '');
    }

    function renderSepResults() {
        var box = document.getElementById('sepResultList');
        if (!box) return;
        // 同步「全部导入」按钮可用性
        if (el.btnImportVocals) el.btnImportVocals.disabled = sepBusy || sepResults.length === 0;
        if (!sepResults.length) {
            box.innerHTML = '<div class="sep-res-empty">还没有分离结果</div>';
            return;
        }
        box.innerHTML = '';
        sepResults.slice().reverse().forEach(function (r) {
            box.appendChild(buildSepRow(r));
        });
    }

    function buildSepRow(r) {
        var row = document.createElement('div');
        row.className = 'sep-res-item';
        row.setAttribute('data-path', r.path);
        row.setAttribute('draggable', 'true');
        row.title = r.path;

        // 试听
        var playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'sep-res-play';
        playBtn.textContent = (sepWsPath === r.path && sepWsPlaying) ? '⏸' : '▶';
        playBtn.title = '试听';
        playBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            toggleSepPlay(r.path, playBtn);
        });
        row.appendChild(playBtn);

        // 类型标签
        var tag = document.createElement('span');
        tag.className = 'sep-res-tag ' + sepKindClass(r.kind);
        tag.textContent = sepKindLabel(r.kind);
        row.appendChild(tag);

        // 名字 + 来源
        var info = document.createElement('div');
        info.className = 'sep-res-info';
        var nm = document.createElement('div');
        nm.className = 'sep-res-name';
        nm.textContent = r.name;
        var sub = document.createElement('div');
        sub.className = 'sep-res-sub';
        sub.textContent = r.srcName ? ('来源：' + r.srcName) : '';
        info.appendChild(nm);
        info.appendChild(sub);
        row.appendChild(info);

        // 操作
        var imp = document.createElement('button');
        imp.type = 'button';
        imp.className = 'sep-res-btn';
        imp.textContent = '导入';
        imp.title = '导入到「人声分离」素材箱';
        imp.addEventListener('click', function (ev) {
            ev.stopPropagation();
            importToBin([r.path], sepKindLabel(r.kind));
        });
        row.appendChild(imp);

        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'sep-res-btn sep-res-del';
        rm.textContent = '✕';
        rm.title = '从列表移除（不删文件）';
        rm.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (sepWsPath === r.path) stopSepPlay();
            sepResults = sepResults.filter(function (x) { return x.path !== r.path; });
            renderSepResults();
        });
        row.appendChild(rm);

        // 拖拽进 PR 时间轴（CEP 官方 DnD，与音乐库/音效库一致）
        row.addEventListener('dragstart', function (ev) {
            var t = ev.target;
            if (t && t.tagName === 'BUTTON') { ev.preventDefault(); return; }
            ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', r.path);
            ev.dataTransfer.setData('text/plain', r.path);
            ev.dataTransfer.effectAllowed = 'copy';
        });
        row.addEventListener('dragend', function () { stopSepPlay(); });
        // 双击 = 导入素材箱
        row.addEventListener('dblclick', function () { importToBin([r.path], sepKindLabel(r.kind)); });
        return row;
    }

    // 试听：单实例，点同一个暂停，点另一个切换
    // 关键：不能用 ws.load('file:///...') —— CEP 里 file 协议加载常被拦（本机可能碰巧能读，
    //      别的机器就报错）。改用 XHR 读成 Blob 再 loadBlob，与音效库一致，到哪都能播。
    function sepReadAsBlob(filePath, cb) {
        try {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', 'file:///' + String(filePath).replace(/\\/g, '/'), true);
            xhr.responseType = 'blob';
            xhr.onload = function () {
                if (xhr.status === 0 || xhr.status === 200) cb(null, xhr.response);
                else cb(new Error('读取失败 HTTP ' + xhr.status), null);
            };
            xhr.onerror = function () { cb(new Error('无法读取音频文件'), null); };
            xhr.send();
        } catch (e) {
            cb(e, null);
        }
    }

    function toggleSepPlay(p, btn) {
        if (sepWsPath === p && sepWs && sepWsPlaying) { pauseSepPlay(btn); return; }
        stopSepPlay();
        if (!p || !fs.existsSync(p)) { setSepStatus('文件不存在：' + p, 'err'); return; }
        var row = document.querySelector('#sepResultList .sep-res-item[data-path="' + cssEsc(p) + '"]');
        var holder = row ? row.querySelector('.sep-res-wave') : null;
        if (!holder) {
            // 首次：在行内插入波形容器
            holder = document.createElement('div');
            holder.className = 'sep-res-wave';
            var infoEl = row ? row.querySelector('.sep-res-info') : null;
            if (row && infoEl) row.insertBefore(holder, infoEl);
        }
        try {
            if (typeof WaveSurfer === 'undefined') throw new Error('wavesurfer 未加载');
            sepWs = WaveSurfer.create({
                container: holder,
                waveColor: '#8ab0ff',
                progressColor: '#4f8bff',
                cursorColor: '#ffffff',
                height: 26,
                barWidth: 1, barGap: 1, barMinHeight: 1, cursorWidth: 1,
                interact: true,
                hideScrollbar: true
            });
            sepWsPath = p;
            setSepStatus('正在读取音频…', '');
            sepReadAsBlob(p, function (err, blob) {
                if (err || !blob) {
                    sepWsPath = '';
                    setSepStatus('试听失败：' + (err ? err.message : '读取为空') +
                        '　（文件：' + p + '）', 'err');
                    return;
                }
                try {
                    sepWs.loadBlob(blob);
                } catch (e) {
                    setSepStatus('试听失败：' + e.message, 'err');
                    return;
                }
                sepWs.on('ready', function () {
                    try { sepWs.play(); } catch (e) {}
                    sepWsPlaying = true;
                    if (btn) btn.textContent = '⏸';
                    setSepStatus('试听中…', '');
                });
                sepWs.on('finish', function () {
                    sepWsPlaying = false;
                    if (btn) btn.textContent = '▶';
                });
                sepWs.on('error', function (e) {
                    sepWsPlaying = false;
                    if (btn) btn.textContent = '▶';
                    setSepStatus('试听出错：' + (e && e.message ? e.message : '音频解码失败'), 'err');
                });
            });
        } catch (e) {
            setSepStatus('试听失败：' + e.message, 'err');
        }
    }

    function pauseSepPlay(btn) {
        try { if (sepWs) sepWs.pause(); } catch (e) {}
        sepWsPlaying = false;
        if (btn) btn.textContent = '▶';
        renderSepPlayButtons();
    }

    function stopSepPlay() {
        try { if (sepWs) sepWs.stop(); } catch (e) {}
        sepWs = null;
        sepWsPath = '';
        sepWsPlaying = false;
        renderSepPlayButtons();
    }

    // 把所有行的播放按钮同步成当前状态
    function renderSepPlayButtons() {
        var box = document.getElementById('sepResultList');
        if (!box) return;
        var rows = box.querySelectorAll('.sep-res-item');
        for (var i = 0; i < rows.length; i++) {
            var p = rows[i].getAttribute('data-path');
            var b = rows[i].querySelector('.sep-res-play');
            if (b) b.textContent = (sepWsPath === p && sepWsPlaying) ? '⏸' : '▶';
        }
    }

    function cssEsc(s) { return String(s).replace(/(["\\])/g, '\\$1'); }

    // 通用导入：把文件列表放进「人声分离」素材箱，kind 用于提示文案
    function importToBin(files, kind) {
        var validFiles = files.filter(function (f) { return f && fs.existsSync(f); });
        if (validFiles.length === 0) { setSepStatus('请先分离出' + kind, 'err'); return; }
        setSepStatus('正在导入' + kind + '到素材箱...', '');
        var payloadJson = JSON.stringify(validFiles);
        var setScript = 'wsImportToBinPayload = ' + payloadJson + ';';
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('wsImportToBinStr("人声分离")', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setSepStatus('已导入' + kind + '到「人声分离」素材箱：' + data.imported.join('、'), 'ok');
                    } else {
                        setSepStatus(data.error || '导入失败', 'err');
                    }
                } catch (e) {
                    setSepStatus('导入解析失败: ' + result, 'err');
                }
            });
        });
    }

    function setSepStatus(msg, type) {
        el.sepStatus.textContent = msg || '';
        el.sepStatus.className = type || '';
    }

    function setSepBusy(busy) {
        sepBusy = busy;
        if (el.btnSeparate) el.btnSeparate.disabled = busy;
        // 「全部导入」按结果列表里有没有可用文件决定
        if (el.btnImportVocals) el.btnImportVocals.disabled = busy || sepResults.length === 0;
        if (busy) {
            el.sepProgressWrap.classList.add('show');
            el.sepProgressFill.className = 'fill indet';
            el.sepProgressText.textContent = '人声分离进行中...';
        } else {
            el.sepProgressWrap.classList.remove('show');
        }
    }

    // ---------- 事件绑定 ----------
    el.refreshSeq.addEventListener('click', refreshSequences);
    el.toggleAll.addEventListener('click', toggleAll);
    el.batch.addEventListener('click', runBatch);
    el.writeBack.addEventListener('click', writeBack);
    el.exportSrt.addEventListener('click', exportSrt);
    el.toCheck.addEventListener('click', function () {
        if (window.__checkIngest) window.__checkIngest();
        else setStatus('字幕校对板块未加载', 'err');
    });
    el.stop.addEventListener('click', function () {
        stopRequested = true;
        setStatus('正在停止...', 'warn');
    });

    el.btnSeparate.addEventListener('click', separateVocals);
    el.btnImportVocals.addEventListener('click', importVocals);
    if (el.btnSepClear) el.btnSepClear.addEventListener('click', clearSepResults);
    renderSepResults();

    // 语言切换时联动模型框：中文→FunASR（固定，置灰）；英文/其他→whisper large-v3
    function syncModelByLang() {
        var lang = el.selLang.value;
        if (lang === 'zh') {
            // 中文默认也走 faster-whisper（时间轴更准，气口能断开）。
            // funasr 仍保留在模型下拉里，需要时手动选。
            el.selModel.value = 'fw-medium';
            el.selModel.disabled = false;
        } else if (lang === 'auto') {
            el.selModel.value = 'fw-medium';
            el.selModel.disabled = false;
        } else {
            el.selModel.value = 'fw-medium';
            el.selModel.disabled = false;
        }
    }
    el.selLang.addEventListener('change', syncModelByLang);
    syncModelByLang();

    // ---------- 英译中（剧情参考）：调共享翻译引擎 translate.js（MyMemory 免费接口）----------
    var transBusy = false;
    var fwModelChecked = false;

    function translateToChinese() {
        runTranslate('zh');
    }

    function importBilingual() {
        runTranslate('bilingual');
    }

    // mode: 'zh' 只中文 | 'bilingual' 中英双语（同一字幕条，英文在上中文在下）
    function runTranslate(mode) {
        if (transBusy) { setStatus('翻译进行中，请稍候…', 'warn'); return; }
        if (!currentSeqId) { setStatus('请先在结果区选择一个序列', 'err'); return; }
        if (subtitles.length === 0) { setStatus('当前序列没有字幕可翻译', 'err'); return; }
        var bridge = window.__translateBridge;
        if (!bridge) { setStatus('翻译引擎未加载（translate.js）', 'err'); return; }

        var seqName = '';
        var hit = batchResults.filter(function (r) { return r.seqId === currentSeqId; });
        if (hit.length > 0) seqName = hit[0].name || '';

        var targetBtn = mode === 'bilingual' ? el.bilingual : el.translate;
        var suffix = mode === 'bilingual' ? '双语' : '中文';
        var label = mode === 'bilingual' ? '导入双语字幕' : '翻译成中文（剧情参考）';

        transBusy = true;
        targetBtn.disabled = true;
        targetBtn.textContent = '翻译中 0/' + subtitles.length + '…';

        var t = bridge.runTranslate(subtitles, mode, function (done, total) {
            targetBtn.textContent = '翻译中 ' + done + '/' + total + '…';
        }, function (err, res) {
            var cacheHitN = (res && res.cacheHit) || 0;
            if (err) {
                transBusy = false;
                targetBtn.disabled = false;
                targetBtn.textContent = label;
                setStatus('翻译失败: ' + err.message, 'err');
                return;
            }
            var outSubs = res.outSubs;
            var failCount = res.failCount;

            var srtContent = toSRT(outSubs);
            var payloadJson = JSON.stringify({ srt: srtContent, seqName: seqName, nameSuffix: suffix });
            var setScript = 'wsWriteBackPayload = ' + payloadJson + ';';
            setStatus('正在回写' + suffix + '轨...', '');
            csInterface.evalScript(setScript, function () {
                csInterface.evalScript('wsWriteBackStr("' + currentSeqId + '")', function (result) {
                    try {
                        var data = JSON.parse(result);
                        if (data.ok) {
                            var note = failCount > 0 ? '（' + failCount + ' 条失败保留英文）' : '';
                            if (cacheHitN > 0) note += '（复用已有译文 ' + cacheHitN + ' 条）';
                            setStatus('已翻译 ' + outSubs.length + ' 条并回写' + suffix + '轨（' + data.fileName + '）' + note, 'ok');
                        } else {
                            setStatus('翻译完成但回写失败: ' + (data.error || result), 'err');
                        }
                    } catch (e) {
                        setStatus('回写解析失败: ' + result, 'err');
                    }
                    transBusy = false;
                    targetBtn.disabled = false;
                    targetBtn.textContent = label;
                });
            });
        }, { seqName: seqName });
        // 记录当前任务（未来可扩展取消）
        window.__activeTransTask = t;
    }

    el.translate.addEventListener('click', translateToChinese);
    el.bilingual.addEventListener('click', importBilingual);

    // 初始化
    setStatus('就绪。点「刷新序列列表」加载序列，勾选后批量识别', '');
    // 自动刷新一次
    refreshSequences();

    // ---------- 暴露给「字幕校对」板块（跨 tab 共享）----------
    window.__subtitleBridge = {
        getCurrent: function () {
            if (!currentSeqId || subtitles.length === 0) return null;
            var name = '';
            var hit = batchResults.filter(function (r) { return r.seqId === currentSeqId; });
            if (hit.length > 0) name = hit[0].name || '';
            return { seqId: currentSeqId, seqName: name, subtitles: subtitles };
        },
        toSRT: toSRT,
        applySubtitles: function (newSubs) {
            syncSubtitles(newSubs || []);
            return subtitles.length;
        }
    };

    // 切到字幕识别面板时自动刷新序列列表（序列可能在 PR 里新建/改名）
    window.__subtitleOnShow = function () {
        try {
            if (typeof refreshSequences === 'function') refreshSequences();
        } catch (e) {}
    };
    // ---------- 对外接口（供组件面板调用，避免两处各写一份下载）----------
    // 组件面板的「fw-medium / fw-cuda」没有静态 url，走这里的 py 脚本下载。
    window.__vhSubtitleDownloadModel = function (model, onProgress, onDone) {
        // onProgress 期望收到 {pct, text, meta}
        // 注意：模型下载脚本只用标准库，不需要 faster_whisper；
        // 所以必须先补齐运行库，否则会出现「模型下好了但识别说组件缺失」。
        if (!fwEngineReady(true)) {
            installFwEngine(function (e) {
                if (e) { if (onDone) onDone(e); return; }
                downloadFwModel(model, function (err) {
                    if (onDone) onDone(err || null);
                });
            });
        } else {
            downloadFwModel(model, function (err) {
                if (onDone) onDone(err || null);
            });
        }
        // 把下载状态桥接到组件面板的回调
        var t = setInterval(function () {
            if (!dlState.active) { clearInterval(t); return; }
            if (!onProgress) return;
            var fill = document.getElementById('dlFill');
            var txt = document.getElementById('dlText');
            var meta = document.getElementById('dlMeta');
            var pct = 0;
            try { pct = parseFloat(String(fill && fill.style.width || '0').replace('%', '')) || 0; } catch (e) {}
            onProgress({ pct: pct, text: (txt && txt.textContent) || '', meta: (meta && meta.textContent) || '' });
        }, 400);
    };

    window.__vhSubtitleInstallGpu = function (onProgress, onDone) {
        installFwGpu(function (err) { if (onDone) onDone(err || null); });
        var t = setInterval(function () {
            if (!dlState.active) { clearInterval(t); return; }
            if (!onProgress) return;
            var fill = document.getElementById('dlFill');
            var txt = document.getElementById('dlText');
            var meta = document.getElementById('dlMeta');
            var pct = 0;
            try { pct = parseFloat(String(fill && fill.style.width || '0').replace('%', '')) || 0; } catch (e) {}
            onProgress({ pct: pct, text: (txt && txt.textContent) || '', meta: (meta && meta.textContent) || '' });
        }, 400);
    };

    window.__vhSubtitleInstallEngine = function (onProgress, onDone) {
        installFwEngine(function (err) { if (onDone) onDone(err || null); });
        var t = setInterval(function () {
            if (!dlState.active) { clearInterval(t); return; }
            if (!onProgress) return;
            var fill = document.getElementById('dlFill');
            var txt = document.getElementById('dlText');
            var meta = document.getElementById('dlMeta');
            var pct = 0;
            try { pct = parseFloat(String(fill && fill.style.width || '0').replace('%', '')) || 0; } catch (e) {}
            onProgress({ pct: pct, text: (txt && txt.textContent) || '', meta: (meta && meta.textContent) || '' });
        }, 400);
    };

})();
