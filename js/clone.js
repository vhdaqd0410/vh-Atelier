// 语音克隆插件 - 前端主逻辑（CosyVoice3 零样本克隆）
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var child_process = require('child_process');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);

    // 状态
    var refWavPath = null;      // 抓取的参考音频（英文路径 wav）
    var refClipMeta = null;     // 参考片段元信息
    var lastOutWav = null;      // 最近一次克隆产物
    var busy = false;
    var audioTracks = [];       // 当前序列音轨列表 [{ index, name, clips }]
    var projectMedia = [];      // 项目素材列表 [{ name, mediaPath, binPath, duration, ext }]

    // DOM 引用
    var el = {
        btnGrab: document.getElementById('btnGrab'),
        refInfo: document.getElementById('refInfo'),
        refText: document.getElementById('refText'),
        btnAutoRef: document.getElementById('btnAutoRef'),
        ttsText: document.getElementById('ttsText'),
        speedRange: document.getElementById('speedRange'),
        speedLabel: document.getElementById('speedLabel'),
        speedVal: document.getElementById('speedVal'),
        modelSel: document.getElementById('modelSel'),
        projectMediaSel: document.getElementById('projectMediaSel'),
        btnRefreshMedia: document.getElementById('btnRefreshMedia'),
        btnGrabFromMedia: document.getElementById('btnGrabFromMedia'),
        mediaStart: document.getElementById('mediaStart'),
        mediaDur: document.getElementById('mediaDur'),
        btnClone: document.getElementById('btnClone'),
        btnPlay: document.getElementById('btnPlay'),
        btnImport: document.getElementById('btnImport'),
        btnRefreshTrack: document.getElementById('btnRefreshTrack'),
        btnInsertTimeline: document.getElementById('btnInsertTimeline'),
        trackSel: document.getElementById('trackSel'),
        colorSel: document.getElementById('colorSel'),
        insertPos: document.getElementById('insertPos'),
        progressWrap: document.getElementById('vcProgressWrap'),
        progressFill: document.getElementById('vcProgressFill'),
        progressText: document.getElementById('vcProgressText'),
        status: document.getElementById('vcStatus'),
        resultInfo: document.getElementById('resultInfo'),
        player: document.getElementById('player'),
        playerPanel: document.getElementById('playerPanel'),
        seekBar: document.getElementById('seekBar'),
        seekFill: document.getElementById('seekFill'),
        playCur: document.getElementById('playCur'),
        playDur: document.getElementById('playDur')
    };

    function setStatus(msg, type) {
        el.status.textContent = msg || '';
        el.status.className = type || '';
    }

    function setBusy(b) {
        busy = b;
        el.btnGrab.disabled = b;
        el.btnClone.disabled = b || !refWavPath;
        el.btnPlay.disabled = b || !lastOutWav;
        el.btnImport.disabled = b || !lastOutWav;
        el.btnInsertTimeline.disabled = b || !lastOutWav;
        el.btnAutoRef.disabled = b || !refWavPath;
        el.btnRefreshTrack.disabled = b;
        el.btnRefreshMedia.disabled = b;
        el.btnGrabFromMedia.disabled = b;
        el.projectMediaSel.disabled = b;
        if (b) {
            el.progressWrap.classList.add('show');
        } else {
            el.progressWrap.classList.remove('show');
        }
    }

    function setProgress(pct, text) {
        if (pct < 0) {
            el.progressFill.className = 'fill indet';
            el.progressText.textContent = text || '';
        } else {
            el.progressFill.className = 'fill';
            el.progressFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
            el.progressText.textContent = text || '';
        }
    }

    // ---------- 探测 Python ----------
    function detectPython() {
        var candidates = [
            path.join(extRoot, 'runtime', 'python.exe'),   // 便携运行时优先（自包含部署）
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'),
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
            'python',
            'py'
        ];
        for (var i = 0; i < candidates.length; i++) {
            var c = candidates[i];
            if (c === 'python' || c === 'py') {
                try {
                    var r = child_process.spawnSync('where', [c], { encoding: 'utf8' });
                    if (r.status === 0 && r.stdout) {
                        var lines = r.stdout.split(/\r?\n/).filter(function (l) { return l.trim(); });
                        for (var j = 0; j < lines.length; j++) {
                            var p = lines[j].trim();
                            if (p.indexOf('WindowsApps') < 0) return p;
                        }
                    }
                } catch (e) {}
            } else if (fs.existsSync(c)) {
                return c;
            }
        }
        return null;
    }

    // ---------- 1. 抓取参考音色 ----------
    function grabRef() {
        if (busy) return;
        setStatus('正在读取时间轴选中的片段...', '');
        csInterface.evalScript('vcGetSelectedClipStr()', function (result) {
            var data;
            try { data = JSON.parse(result); } catch (e) {
                setStatus('解析失败: ' + result, 'err');
                return;
            }
            if (data.error) { setStatus(data.error, 'err'); return; }

            var clip = data.clip;
            var duration = clip.outPoint - clip.inPoint;
            if (duration <= 0) { setStatus('选中片段时长为 0', 'err'); return; }
            if (duration > 30) {
                setStatus('参考音频超过 30 秒（当前 ' + duration.toFixed(1) + ' 秒），CosyVoice3 只支持 30 秒内，请缩短选中片段', 'err');
                return;
            }

            refClipMeta = clip;

            // 用 ffmpeg 抠出参考音频，转 24k 单声道（CosyVoice3 参考音频采样率）
            var tmpDir = path.join(os.tmpdir(), 'vc_clone');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            var refOut = path.join(tmpDir, 'ref_' + Date.now() + '.wav');

            var ffmpegPath = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
            if (!fs.existsSync(ffmpegPath)) {
                setStatus('FFmpeg 缺失: ' + ffmpegPath, 'err');
                return;
            }

            var args = [
                '-ss', clip.inPoint.toFixed(3),
                '-t', duration.toFixed(3),
                '-i', clip.mediaPath,
                '-map', '0:a',
                '-ar', '24000', '-ac', '1',
                '-y', refOut
            ];

            setStatus('正在提取参考音频（' + duration.toFixed(1) + ' 秒）...', '');
            child_process.execFile(ffmpegPath, args, {
                timeout: 120000,
                maxBuffer: 1024 * 1024 * 10
            }, function (err) {
                if (err || !fs.existsSync(refOut)) {
                    setStatus('提取参考音频失败: ' + (err ? err.message : '未生成 wav'), 'err');
                    return;
                }
                refWavPath = refOut;
                el.refInfo.textContent = '✓ ' + (clip.clipName || clip.mediaPath) + '\n时长 ' + duration.toFixed(1) + ' 秒';
                el.refInfo.classList.add('has');
                setBusy(false);
                setStatus('参考音色已就绪。建议点「自动识别」填参考文字', 'ok');
                // 自动识别参考文字
                autoRecognizeRef();
            });
        });
    }

    // ---------- 1c. 从项目素材截取参考音频 ----------
    function refreshProjectMedia() {
        if (busy) return;
        setStatus('正在遍历项目素材...', '');
        csInterface.evalScript('vcListProjectMedia()', function (result) {
            try {
                var data = JSON.parse(result);
                if (data.error) { setStatus(data.error, 'err'); return; }
                projectMedia = data.items || [];
                el.projectMediaSel.innerHTML = '';
                if (projectMedia.length === 0) {
                    var opt0 = document.createElement('option');
                    opt0.value = '';
                    opt0.textContent = '（项目里没有音频/视频素材）';
                    el.projectMediaSel.appendChild(opt0);
                } else {
                    projectMedia.forEach(function (m, idx) {
                        var opt = document.createElement('option');
                        opt.value = String(idx);
                        var durStr = m.duration ? ' · ' + m.duration.toFixed(1) + 's' : '';
                        var binStr = m.binPath ? '[' + m.binPath + '] ' : '';
                        opt.textContent = binStr + m.name + durStr;
                        el.projectMediaSel.appendChild(opt);
                    });
                }
                setStatus('已加载 ' + projectMedia.length + ' 个项目素材，选择一个并填片段范围', 'ok');
            } catch (e) {
                setStatus('素材解析失败: ' + result, 'err');
            }
        });
    }

    function grabFromMedia() {
        if (busy) return;
        var idx = parseInt(el.projectMediaSel.value, 10);
        if (isNaN(idx) || !projectMedia[idx]) { setStatus('请先刷新并选择项目素材', 'err'); return; }
        var media = projectMedia[idx];
        var start = parseFloat(el.mediaStart.value) || 0;
        var dur = parseFloat(el.mediaDur.value);
        if (!dur || dur <= 0) { setStatus('请填写截取时长（秒）', 'err'); return; }
        if (dur > 30) { setStatus('参考音频超过 30 秒，CosyVoice3 只支持 30 秒内', 'err'); return; }

        var ffmpegPath = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
        if (!fs.existsSync(ffmpegPath)) { setStatus('FFmpeg 缺失: ' + ffmpegPath, 'err'); return; }

        var tmpDir = path.join(os.tmpdir(), 'vc_clone');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        var refOut = path.join(tmpDir, 'ref_' + Date.now() + '.wav');

        var args = [
            '-ss', start.toFixed(3),
            '-t', dur.toFixed(3),
            '-i', media.mediaPath,
            '-map', '0:a',
            '-ar', '24000', '-ac', '1',
            '-y', refOut
        ];

        setBusy(true);
        setStatus('正在从项目素材截取参考音频（' + dur.toFixed(1) + ' 秒）...', '');
        child_process.execFile(ffmpegPath, args, {
            timeout: 120000,
            maxBuffer: 1024 * 1024 * 10
        }, function (err) {
            setBusy(false);
            if (err || !fs.existsSync(refOut)) {
                setStatus('截取参考音频失败: ' + (err ? err.message : '未生成 wav'), 'err');
                return;
            }
            refWavPath = refOut;
            refClipMeta = { clipName: media.name, mediaPath: media.mediaPath, inPoint: start, outPoint: start + dur };
            el.refInfo.textContent = '✓ ' + media.name + '\n片段 ' + start.toFixed(1) + 's ~ ' + (start + dur).toFixed(1) + 's';
            el.refInfo.classList.add('has');
            setStatus('参考音色已就绪。建议点「自动识别」填参考文字', 'ok');
            autoRecognizeRef();
        });
    }

    // ---------- 1b. 自动识别参考文字（whisper，复用字幕插件引擎）----------
    // 返回 { whisperPath, modelPath }，优先语音克隆插件自己目录（将来合并），回退字幕插件 CEP 目录
    function locateWhisper() {
        // 合并后：优先本插件目录，回退旧字幕插件 CEP 目录（引擎/模型暂不复制）
        var candidates = [
            path.join(extRoot, 'bin', 'whisper'),
            path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions', 'com.zhang.whisper-subtitle', 'bin', 'whisper')
        ];
        var modelCandidates = [
            path.join(extRoot, 'models'),
            path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions', 'com.zhang.whisper-subtitle', 'models')
        ];
        for (var i = 0; i < candidates.length; i++) {
            var base = candidates[i];
            var cudaExe = path.join(base, 'cuda', 'whisper-cli.exe');
            var cpuExe = path.join(base, 'win32-x64', 'whisper-cli.exe');
            if (fs.existsSync(cudaExe) || fs.existsSync(cpuExe)) {
                var modelPath = '';
                for (var m = 0; m < modelCandidates.length; m++) {
                    var mp = path.join(modelCandidates[m], 'ggml-large-v3-q5_0.bin');
                    if (fs.existsSync(mp)) { modelPath = mp; break; }
                }
                if (!modelPath) {
                    for (var m2 = 0; m2 < modelCandidates.length; m2++) {
                        var mp2 = path.join(modelCandidates[m2], 'ggml-belle-large-v3-turbo-zh-q8_0.bin');
                        if (fs.existsSync(mp2)) { modelPath = mp2; break; }
                    }
                }
                return { base: base, cudaExe: cudaExe, cpuExe: cpuExe, modelPath: modelPath };
            }
        }
        return null;
    }

    function detectCudaAvailable(cudaExe) {
        try {
            var cudaDir = path.dirname(cudaExe);
            var requiredDlls = ['cublas64_12.dll', 'cublasLt64_12.dll', 'ggml-cuda.dll', 'whisper.dll'];
            for (var i = 0; i < requiredDlls.length; i++) {
                if (!fs.existsSync(path.join(cudaDir, requiredDlls[i]))) return false;
            }
            var r = child_process.spawnSync(cudaExe, ['--help'], { cwd: cudaDir, encoding: 'utf8', timeout: 15000 });
            return r.status === 0;
        } catch (e) {
            return false;
        }
    }

    function autoRecognizeRef() {
        if (!refWavPath) return;
        var loc = locateWhisper();
        if (!loc) { setStatus('未找到 whisper 引擎，请手动填写参考文字', 'warn'); return; }
        if (!fs.existsSync(loc.modelPath)) { setStatus('未找到 whisper 模型，请手动填写参考文字', 'warn'); return; }

        var whisperPath = detectCudaAvailable(loc.cudaExe) ? loc.cudaExe : loc.cpuExe;

        // 参考音频转 16k 单声道喂 whisper
        var tmpDir = path.join(os.tmpdir(), 'vc_clone');
        var ref16k = path.join(tmpDir, 'ref16k_' + Date.now() + '.wav');
        var ffmpegPath = path.join(extRoot, 'bin', 'ffmpeg-win32-x64.exe');
        child_process.execFile(ffmpegPath, ['-i', refWavPath, '-ar', '16000', '-ac', '1', '-y', ref16k], {
            timeout: 60000,
            maxBuffer: 1024 * 1024 * 10
        }, function (err) {
            if (err || !fs.existsSync(ref16k)) {
                setStatus('参考音频转码失败，请手动填写参考文字', 'warn');
                return;
            }
            setStatus('whisper 识别参考文字中...', '');
            var srtBase = path.join(tmpDir, 'refsrt_' + Date.now());
            child_process.execFile(whisperPath, [
                '-m', loc.modelPath,
                '-l', 'auto',
                '-t', '4',
                '-osrt',
                '-of', srtBase,
                '-nf', '-sns',
                ref16k
            ], {
                cwd: path.dirname(whisperPath),
                timeout: 300000,
                maxBuffer: 1024 * 1024 * 50
            }, function (err2, stdout, stderr) {
                if (err2) {
                    setStatus('参考文字识别失败，请手动填写', 'warn');
                    return;
                }
                var srtPath = srtBase + '.srt';
                if (!fs.existsSync(srtPath)) {
                    setStatus('参考文字识别未出结果，请手动填写', 'warn');
                    return;
                }
                var content = fs.readFileSync(srtPath, 'utf8');
                var subs = parseSRT(content);
                var text = subs.map(function (s) { return s.text.replace(/\n/g, ''); }).join('');
                if (text) {
                    el.refText.value = text;
                    setStatus('已自动识别参考文字，请核对后使用', 'ok');
                } else {
                    setStatus('参考文字识别为空，请手动填写', 'warn');
                }
            });
        });
    }

    function parseSRT(content) {
        var subs = [];
        var lines = content.replace(/\r\n/g, '\n').split('\n');
        var i = 0;
        while (i < lines.length) {
            while (i < lines.length && lines[i].trim() === '') i++;
            if (i >= lines.length) break;
            if (/^\d+$/.test(lines[i].trim())) i++;
            if (i >= lines.length) break;
            var timeMatch = lines[i].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
            if (!timeMatch) { i++; continue; }
            i++;
            var text = [];
            while (i < lines.length && lines[i].trim() !== '') {
                text.push(lines[i].trim());
                i++;
            }
            subs.push({ text: text.join('\n') });
        }
        return subs;
    }

    // ---------- 2. 克隆 ----------
    function clone() {
        if (busy) return;
        if (!refWavPath) { setStatus('请先抓取参考音色', 'err'); return; }
        var refText = el.refText.value.trim();
        var ttsText = el.ttsText.value.trim();
        if (!refText) { setStatus('请填写参考音频对应文字', 'err'); return; }
        if (!ttsText) { setStatus('请填写要合成的文字', 'err'); return; }
        var speed = parseFloat(el.speedRange.value) || 1.0;
        var modelVariant = el.modelSel.value || 'base';

        var pythonExe = detectPython();
        if (!pythonExe) { setStatus('未找到 Python 环境', 'err'); return; }

        var cliPath = path.join(extRoot, 'py', 'cosyvoice_cli.py');
        if (!fs.existsSync(cliPath)) { setStatus('克隆脚本缺失: ' + cliPath, 'err'); return; }

        var tmpDir = path.join(os.tmpdir(), 'vc_clone');
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        var outWav = path.join(tmpDir, 'clone_' + Date.now() + '.wav');
        var cfgPath = path.join(tmpDir, 'clone_cfg.json');

        var cfg = {
            ref_wav: refWavPath,
            ref_text: refText,
            tts_text: ttsText,
            out_wav: outWav,
            speed: speed,
            model: modelVariant
        };
        fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');

        setBusy(true);
        setProgress(-1, '正在加载模型（约 15 秒）...');
        setStatus('CosyVoice3 克隆中（首次含模型加载，请稍候）...', '');

        var proc = child_process.execFile(pythonExe, [cliPath, cfgPath], {
            timeout: 1800000,
            maxBuffer: 1024 * 1024 * 50
        }, function (error, stdout, stderr) {
            if (error) {
                var detail = (stderr || stdout || '').substring(0, 800);
                setBusy(false);
                setStatus('克隆失败: ' + error.message + ' ' + detail, 'err');
                return;
            }
            var line = (stdout || '').trim().split(/\r?\n/).filter(function (l) { return l.trim().indexOf('{') === 0; }).pop();
            if (!line) {
                setBusy(false);
                setStatus('克隆无有效输出: ' + (stdout || '').substring(0, 300), 'err');
                return;
            }
            var res;
            try { res = JSON.parse(line); } catch (e) {
                setBusy(false);
                setStatus('结果解析失败: ' + line, 'err');
                return;
            }
            if (!res.ok) {
                setBusy(false);
                setStatus('克隆失败: ' + (res.error || '未知错误'), 'err');
                return;
            }
            lastOutWav = res.out;
            setProgress(100, '完成');
            setBusy(false);
            el.playerPanel.classList.add('show');
            el.seekFill.style.width = '0';
            el.playCur.textContent = '0:00';
            el.playDur.textContent = '0:00';
            el.btnPlay.textContent = '▶ 试听';
            el.resultInfo.classList.add('show');
            el.resultInfo.innerHTML =
                '<span class="k">时长</span> ' + res.duration + ' 秒<br>' +
                '<span class="k">语速</span> ' + res.speed + '×<br>' +
                '<span class="k">模型</span> ' + (res.model === 'rl' ? 'RL 强化学习版' : '基础版') + '<br>' +
                '<span class="k">模型加载</span> ' + res.load_sec + ' 秒<br>' +
                '<span class="k">生成耗时</span> ' + res.gen_sec + ' 秒<br>' +
                '<span class="k">RTF</span> ' + res.rtf + '<br>' +
                '<span class="k">产物</span> ' + res.out;
            setStatus('克隆完成，可试听 / 导入素材箱 / 插入时间线', 'ok');
        });

        // 读取 stderr 里的 STAGE 标记，更新进度
        var stagePct = { 'init': 2, 'load-model': 10, 'clone': 40, 'save': 92 };
        proc.stderr.on('data', function (chunk) {
            var s = chunk.toString();
            var lines = s.split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                var m = lines[i].match(/STAGE\s+(\S+)/);
                if (m) {
                    var stage = m[1];
                    var pct = stagePct[stage] || 40;
                    var label = {
                        'init': '初始化运行时...',
                        'load-model': '加载模型（约 15 秒）...',
                        'clone': '零样本克隆中...',
                        'save': '保存音频...'
                    }[stage] || stage;
                    setProgress(pct, label);
                }
            }
        });
    }

    // ---------- 3. 试听（带进度条 + 拖动 seek）----------
    var playing = false;
    var seeking = false;   // 拖动中，暂停 timeupdate 回写，避免拉扯

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) sec = 0;
        sec = Math.floor(sec);
        var m = Math.floor(sec / 60);
        var s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function updateSeekFill() {
        var d = el.player.duration;
        var c = el.player.currentTime;
        if (isFinite(d) && d > 0) {
            el.seekFill.style.width = Math.min(100, c / d * 100) + '%';
        }
        el.playCur.textContent = fmtTime(c);
        el.playDur.textContent = fmtTime(d);
    }

    function play() {
        if (!lastOutWav || !fs.existsSync(lastOutWav)) { setStatus('产物文件不存在', 'err'); return; }
        if (playing) {
            el.player.pause();
            return;
        }
        var buf = fs.readFileSync(lastOutWav);
        var base64 = buf.toString('base64');
        el.player.src = 'data:audio/wav;base64,' + base64;
        el.player.play();
    }

    function seekTo(ratio) {
        if (!isFinite(el.player.duration)) return;
        ratio = Math.max(0, Math.min(1, ratio));
        el.player.currentTime = ratio * el.player.duration;
        updateSeekFill();
    }

    function bindPlayerEvents() {
        el.player.addEventListener('play', function () {
            playing = true;
            el.btnPlay.textContent = '⏸ 暂停';
        });
        el.player.addEventListener('pause', function () {
            playing = false;
            el.btnPlay.textContent = '▶ 试听';
        });
        el.player.addEventListener('ended', function () {
            playing = false;
            el.btnPlay.textContent = '▶ 试听';
            updateSeekFill();
        });
        el.player.addEventListener('timeupdate', function () {
            if (!seeking) updateSeekFill();
        });
        el.player.addEventListener('loadedmetadata', function () {
            updateSeekFill();
        });

        // 拖动 seek：mousedown 进入拖动，mousemove 预览，mouseup 真正跳转
        el.seekBar.addEventListener('mousedown', function (e) {
            seeking = true;
            var rect = el.seekBar.getBoundingClientRect();
            var ratio = (e.clientX - rect.left) / rect.width;
            el.seekFill.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
            var moveHandler = function (ev) {
                var r2 = el.seekBar.getBoundingClientRect();
                var ratio2 = (ev.clientX - r2.left) / r2.width;
                el.seekFill.style.width = Math.max(0, Math.min(100, ratio2 * 100)) + '%';
            };
            var upHandler = function (ev) {
                seeking = false;
                document.removeEventListener('mousemove', moveHandler);
                document.removeEventListener('mouseup', upHandler);
                var r3 = el.seekBar.getBoundingClientRect();
                var ratio3 = (ev.clientX - r3.left) / r3.width;
                seekTo(ratio3);
            };
            document.addEventListener('mousemove', moveHandler);
            document.addEventListener('mouseup', upHandler);
        });
    }

    // ---------- 4. 导入素材箱 ----------
    function importToBin() {
        if (!lastOutWav) return;
        if (!fs.existsSync(lastOutWav)) { setStatus('产物文件不存在: ' + lastOutWav, 'err'); return; }
        setStatus('正在导入素材箱...', '');
        var payloadJson = JSON.stringify([lastOutWav]);
        var setScript = 'vcImportToBinPayload = ' + payloadJson + ';';
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('vcImportToBinStr("语音克隆")', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setStatus('已导入到「语音克隆」素材箱：' + data.imported.join('、'), 'ok');
                    } else {
                        setStatus(data.error || '导入失败', 'err');
                    }
                } catch (e) {
                    setStatus('导入解析失败: ' + result, 'err');
                }
            });
        });
    }

    // ---------- 5. 刷新音轨列表 ----------
    function refreshTracks() {
        csInterface.evalScript('vcGetAudioTracks()', function (result) {
            try {
                var data = JSON.parse(result);
                if (data.error) { setStatus(data.error, 'err'); return; }
                audioTracks = data.tracks || [];
                el.trackSel.innerHTML = '';
                if (audioTracks.length === 0) {
                    var opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = '（无音轨）';
                    el.trackSel.appendChild(opt);
                } else {
                    audioTracks.forEach(function (t, idx) {
                        var opt = document.createElement('option');
                        opt.value = String(t.index);
                        opt.textContent = 'A' + (idx + 1) + ' · ' + t.name + '（' + t.clips + ' 块）';
                        el.trackSel.appendChild(opt);
                    });
                    // 默认选最后一个音轨（最不容易压到已有音频）
                    el.trackSel.selectedIndex = audioTracks.length - 1;
                }
            } catch (e) {
                setStatus('音轨解析失败: ' + result, 'err');
            }
        });
    }

    // ---------- 6. 导入到时间线 ----------
    function insertTimeline() {
        if (!lastOutWav || !fs.existsSync(lastOutWav)) { setStatus('产物文件不存在', 'err'); return; }
        var trackIndex = parseInt(el.trackSel.value, 10);
        if (isNaN(trackIndex)) { setStatus('请先刷新并选择目标音轨', 'err'); return; }
        var colorLabel = parseInt(el.colorSel.value, 10) || 3;
        var posText = el.insertPos.value.trim();
        var positionSec;
        if (posText) {
            positionSec = parseFloat(posText);
            if (isNaN(positionSec)) { setStatus('插入位置需为数字（秒）', 'err'); return; }
        } else {
            // 用播放头位置
            csInterface.evalScript('vcGetPlayerPosition()', function (result) {
                var sec = 0;
                try {
                    var d = JSON.parse(result);
                    if (d.positionSec !== undefined) sec = d.positionSec;
                } catch (e) {}
                doInsertTimeline(trackIndex, colorLabel, sec);
            });
            return;
        }
        doInsertTimeline(trackIndex, colorLabel, positionSec);
    }

    function doInsertTimeline(trackIndex, colorLabel, positionSec) {
        var payload = {
            wavPath: lastOutWav,
            trackIndex: trackIndex,
            positionSec: positionSec,
            colorLabel: colorLabel
        };
        var payloadJson = JSON.stringify(payload);
        var setScript = 'vcInsertPayload = ' + payloadJson + ';';
        setStatus('正在插入时间线...', '');
        csInterface.evalScript(setScript, function () {
            csInterface.evalScript('vcInsertToTimelineStr()', function (result) {
                try {
                    var data = JSON.parse(result);
                    if (data.ok) {
                        setStatus('已插入时间线：A' + (data.trackIndex + 1) + ' 轨 @ ' + data.positionSec.toFixed(2) + ' 秒（已换色）', 'ok');
                    } else {
                        setStatus(data.error || '插入失败', 'err');
                    }
                } catch (e) {
                    setStatus('插入解析失败: ' + result, 'err');
                }
            });
        });
    }

    // ---------- 事件绑定 ----------
    el.btnGrab.addEventListener('click', grabRef);
    el.btnAutoRef.addEventListener('click', autoRecognizeRef);
    el.btnRefreshMedia.addEventListener('click', refreshProjectMedia);
    el.btnGrabFromMedia.addEventListener('click', grabFromMedia);
    el.btnClone.addEventListener('click', clone);
    el.btnPlay.addEventListener('click', play);
    el.btnImport.addEventListener('click', importToBin);
    el.btnRefreshTrack.addEventListener('click', refreshTracks);
    el.btnInsertTimeline.addEventListener('click', insertTimeline);

    el.speedRange.addEventListener('input', function () {
        var v = parseFloat(el.speedRange.value).toFixed(2);
        el.speedLabel.textContent = v + '×';
        el.speedVal.textContent = v;
    });

    bindPlayerEvents();

    // 初始化
    setStatus('就绪。先在时间轴选中要克隆的人声片段，点「抓取」', '');
    refreshTracks();
    refreshProjectMedia();
})();
