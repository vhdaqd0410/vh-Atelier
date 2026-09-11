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
        btnImportAccomp: document.getElementById('btnImportAccomp'),
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
        }
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
        var modelPath = path.join(extRoot, 'models', modelName);
        if (!fs.existsSync(modelPath)) modelPath = path.join(legacyExt, 'models', modelName);
        var funasrCli = path.join(extRoot, 'py', 'funasr_cli.py');
        var funasrModelDir = path.join(extRoot, 'models', 'funasr');
        if (!fs.existsSync(funasrModelDir)) funasrModelDir = path.join(legacyExt, 'models', 'funasr');

        if (!fs.existsSync(ffmpegPath)) { setStatus('FFmpeg 缺失: ' + ffmpegPath, 'err'); return; }
        if (lang === 'zh') {
            if (!fs.existsSync(funasrCli)) { setStatus('FunASR 脚本缺失: ' + funasrCli, 'err'); return; }
            if (!fs.existsSync(funasrModelDir)) { setStatus('FunASR 模型缺失: ' + funasrModelDir, 'err'); return; }
        } else {
            if (!fs.existsSync(whisperPath)) { setStatus('Whisper 缺失: ' + whisperPath, 'err'); return; }
            if (!fs.existsSync(modelPath)) { setStatus('模型缺失: ' + modelPath, 'err'); return; }
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

            // 中文走 FunASR 批量模式：先全部混音，再一次性识别（模型只加载一次）
            if (lang === 'zh') {
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
                runWhisper(meta, wavPath, srtPath, whisperPath, modelPath, lang, useGpu, tmpDir, cb);
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
        setStatus('批量完成：成功 ' + okCount + '/' + batchResults.length + ' 个序列', 'ok');
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
                        el.btnImportVocals.disabled = false;
                        if (sepAccompPath) el.btnImportAccomp.disabled = false;
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

    function importAccomp() {
        importToBin([sepAccompPath], '伴奏');
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
    function toggleSepPlay(p, btn) {
        if (sepWsPath === p && sepWs && sepWsPlaying) { pauseSepPlay(btn); return; }
        stopSepPlay();
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
            sepWs.load('file:///' + String(p).replace(/\\/g, '/'));
            sepWs.on('ready', function () {
                try { sepWs.play(); } catch (e) {}
                sepWsPlaying = true;
                if (btn) btn.textContent = '⏸';
            });
            sepWs.on('finish', function () { sepWsPlaying = false; if (btn) btn.textContent = '▶'; });
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
        el.btnSeparate.disabled = busy;
        // 「全部导入」按结果列表里有没有可用文件决定
        el.btnImportVocals.disabled = busy || sepResults.length === 0;
        el.btnImportAccomp.disabled = busy || !sepAccompPath;
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
    el.btnImportAccomp.addEventListener('click', importAccomp);
    if (el.btnSepClear) el.btnSepClear.addEventListener('click', clearSepResults);
    renderSepResults();

    // 语言切换时联动模型框：中文→FunASR（固定，置灰）；英文/其他→whisper large-v3
    function syncModelByLang() {
        var lang = el.selLang.value;
        if (lang === 'zh') {
            el.selModel.value = 'funasr-zh';
            el.selModel.disabled = true;
        } else {
            el.selModel.value = 'ggml-large-v3-q5_0.bin';
            el.selModel.disabled = false;
        }
    }
    el.selLang.addEventListener('change', syncModelByLang);
    syncModelByLang();

    // ---------- 英译中（剧情参考）：调共享翻译引擎 translate.js（MyMemory 免费接口）----------
    var transBusy = false;

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
        });
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
})();
