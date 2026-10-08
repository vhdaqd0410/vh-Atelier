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
    var mode = 'clone';         // 合成模式：clone | instruct | cross

    // 音色库：命名保存，下次直接复用
    // 存储：元数据存 localStorage；参考音频文件拷到插件目录 collect\voices\ 下，
    //       以免临时目录被清理后音色失效。
    var VOICE_KEY = 'vh_clone_voices';
    function voicesDir() {
        var d = path.join(extRoot, 'collect', 'voices');
        try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
        return d;
    }
    function loadVoices() {
        try { return JSON.parse(localStorage.getItem(VOICE_KEY) || '[]'); } catch (e) { return []; }
    }
    function saveVoices(list) {
        try { localStorage.setItem(VOICE_KEY, JSON.stringify(list.slice(0, 60))); } catch (e) {}
    }
    function renderVoiceLib() {
        if (!el.voiceLibSel) return;
        var list = loadVoices();
        el.voiceLibSel.innerHTML = '';
        if (!list.length) {
            var o = document.createElement('option');
            o.value = ''; o.textContent = '（还没有保存的音色）';
            el.voiceLibSel.appendChild(o);
            el.btnUseVoice.disabled = true;
            el.btnDelVoice.disabled = true;
            if (el.voiceLibHint) el.voiceLibHint.textContent = '音色 = 参考音频 + 参考文字，保存后下次直接选，不用重新抓。';
            return;
        }
        list.forEach(function (v, i) {
            var o = document.createElement('option');
            o.value = String(i);
            var ok = v.wav && fs.existsSync(v.wav);
            o.textContent = v.name + (ok ? '' : '（音频已丢失）');
            el.voiceLibSel.appendChild(o);
        });
        syncVoiceBtns();
    }
    function syncVoiceBtns() {
        var idx = parseInt(el.voiceLibSel.value, 10);
        var list = loadVoices();
        var ok = !isNaN(idx) && list[idx];
        el.btnUseVoice.disabled = !ok || busy;
        el.btnDelVoice.disabled = !ok || busy;
        if (ok) {
            var v = list[idx];
            if (el.voiceLibHint) {
                el.voiceLibHint.textContent = '参考文字：' + (v.ref_text || '（无）').slice(0, 40)
                    + (v.ref_text && v.ref_text.length > 40 ? '…' : '');
            }
        }
    }
    function saveCurrentVoice() {
        if (!refWavPath || !fs.existsSync(refWavPath)) { setStatus('请先抓取参考音频', 'err'); return; }
        var text = el.refText.value.trim();
        if (!text) { setStatus('请先填写参考音频对应的文字', 'err'); return; }
        var name = prompt('给这个音色起个名字（如：沈母 / 男主旁白）', '');
        if (name === null) return;
        name = String(name).trim();
        if (!name) { setStatus('名字不能为空', 'err'); return; }
        try {
            var dir = voicesDir();
            var safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
            var dst = path.join(dir, safe + '_' + Date.now() + '.wav');
            fs.copyFileSync(refWavPath, dst);
            var list = loadVoices();
            // 同名覆盖（避免堆积）
            list = list.filter(function (v) { return v.name !== name; });
            list.unshift({ name: name, wav: dst, ref_text: text, at: Date.now() });
            saveVoices(list);
            renderVoiceLib();
            el.voiceLibSel.value = '0';
            syncVoiceBtns();
            setStatus('已保存音色「' + name + '」，下次可直接从列表选用', 'ok');
        } catch (e) {
            setStatus('保存音色失败: ' + e.message, 'err');
        }
    }
    function useVoice() {
        var idx = parseInt(el.voiceLibSel.value, 10);
        var list = loadVoices();
        var v = !isNaN(idx) ? list[idx] : null;
        if (!v) { setStatus('请选择一个音色', 'err'); return; }
        if (!v.wav || !fs.existsSync(v.wav)) { setStatus('该音色的音频文件已丢失，请重新保存', 'err'); return; }
        refWavPath = v.wav;
        refClipMeta = { clipName: v.name, mediaPath: v.wav };
        el.refInfo.textContent = '✓ 音色库「' + v.name + '」';
        el.refInfo.classList.add('has');
        el.refText.value = v.ref_text || '';
        el.btnSaveVoice.disabled = busy;
        updateCloneEnabled();
        setStatus('已载入音色「' + v.name + '」，填好要说的文字即可生成', 'ok');
    }
    function delVoice() {
        var idx = parseInt(el.voiceLibSel.value, 10);
        var list = loadVoices();
        var v = !isNaN(idx) ? list[idx] : null;
        if (!v) return;
        if (!confirm('删除音色「' + v.name + '」？此操作不可撤销。')) return;
        try { if (v.wav && fs.existsSync(v.wav)) fs.unlinkSync(v.wav); } catch (e) {}
        list.splice(idx, 1);
        saveVoices(list);
        renderVoiceLib();
        setStatus('已删除音色「' + v.name + '」', 'ok');
    }

    // 按模式切换 UI 显隐
    var MODE_HINT = {
        clone: '克隆：参考音频说什么语言，就合成什么语言。',
        instruct: '情绪指令：用一句自然语言描述语气/口音，如「用四川话说这句话」。',
        cross: '跨语言：参考音频说中文、文字写英文即可，用中文音色说外语。'
    };
    function setMode(m) {
        mode = (m === 'instruct' || m === 'cross') ? m : 'clone';
        Array.prototype.forEach.call(el.modeRow.querySelectorAll('.vc-mode'), function (b) {
            b.classList.toggle('active', b.dataset.mode === mode);
        });
        if (el.instructWrap) el.instructWrap.style.display = (mode === 'instruct') ? '' : 'none';
        if (el.crossWrap) el.crossWrap.style.display = (mode === 'cross') ? '' : 'none';
        if (el.modeHint) el.modeHint.textContent = MODE_HINT[mode] || '';
        if (el.ttsText) {
            el.ttsText.placeholder = (mode === 'cross')
                ? '输入要合成的话（写英文即可，用中文音色说外语）'
                : '输入要合成的话，中英文均可';
        }
        updateCloneEnabled();
    }
    // 合成按钮启用条件随模式变化
    function updateCloneEnabled() {
        if (busy) { el.btnClone.disabled = true; return; }
        var hasVoice = refWavPath && fs.existsSync(refWavPath || '');
        var refText = (el.refText.value || '').trim();
        var tts = (el.ttsText.value || '').trim();
        var instr = (el.instructText && el.instructText.value || '').trim();
        var ok = hasVoice && tts;
        if (mode !== 'cross') ok = ok && !!refText;
        if (mode === 'instruct') ok = ok && !!instr;
        el.btnClone.disabled = !ok;
    }

    // DOM 引用
    var el = {
        btnGrab: document.getElementById('btnGrab'),
        refInfo: document.getElementById('refInfo'),
        refText: document.getElementById('refText'),
        btnAutoRef: document.getElementById('btnAutoRef'),
        btnSaveVoice: document.getElementById('btnSaveVoice'),
        voiceLibSel: document.getElementById('voiceLibSel'),
        btnUseVoice: document.getElementById('btnUseVoice'),
        btnDelVoice: document.getElementById('btnDelVoice'),
        voiceLibHint: document.getElementById('voiceLibHint'),
        modeRow: document.getElementById('modeRow'),
        modeHint: document.getElementById('modeHint'),
        instructWrap: document.getElementById('instructWrap'),
        instructText: document.getElementById('instructText'),
        instructChips: document.getElementById('instructChips'),
        crossWrap: document.getElementById('crossWrap'),
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
        vcResultList: document.getElementById('vcResultList')
    };

    function setStatus(msg, type) {
        el.status.textContent = msg || '';
        el.status.className = type || '';
    }

    function setBusy(b) {
        busy = b;
        el.btnGrab.disabled = b;
        el.btnClone.disabled = b || !refWavPath;
        if (el.btnInsertTimeline) el.btnInsertTimeline.disabled = b;
        el.btnAutoRef.disabled = b || !refWavPath;
        el.btnRefreshTrack.disabled = b;
        el.btnRefreshMedia.disabled = b;
        el.btnGrabFromMedia.disabled = b;
        el.projectMediaSel.disabled = b;
        if (el.btnSaveVoice) el.btnSaveVoice.disabled = b || !refWavPath;
        if (el.btnUseVoice) el.btnUseVoice.disabled = b || !el.voiceLibSel.value;
        if (el.btnDelVoice) el.btnDelVoice.disabled = b || !el.voiceLibSel.value;
        if (b) {
            el.progressWrap.classList.add('show');
        } else {
            el.progressWrap.classList.remove('show');
            // 松手后按当前模式重算按钮可用性（比 at 未 busy && refWavPath 更准）
            try { updateCloneEnabled(); } catch (e) {}
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

    // ---------- 2. 合成（克隆 / 情绪指令 / 跨语言）----------
    function clone() {
        if (busy) return;
        if (!refWavPath) { setStatus('请先抓取参考音色', 'err'); return; }
        var refText = el.refText.value.trim();
        var ttsText = el.ttsText.value.trim();
        var instructText = (el.instructText && el.instructText.value || '').trim();
        if (!ttsText) { setStatus('请填写要合成的文字', 'err'); return; }
        if (mode !== 'cross' && !refText) { setStatus('请填写参考音频对应文字', 'err'); return; }
        if (mode === 'instruct' && !instructText) { setStatus('情绪指令模式需要填写语气指令（或点下方词条）', 'err'); return; }
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
            mode: mode,
            ref_wav: refWavPath,
            ref_text: (mode === 'cross') ? '' : refText,
            tts_text: ttsText,
            out_wav: outWav,
            speed: speed,
            model: modelVariant
        };
        if (mode === 'instruct') cfg.instruct_text = instructText;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');

        var modeName = { clone: '克隆', instruct: '情绪指令', cross: '跨语言' }[mode] || '克隆';
        setBusy(true);
        setProgress(-1, '正在加载模型（约 15 秒）...');
        setStatus('CosyVoice3 ' + modeName + '中（首次含模型加载，请稍候）...', '');

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
            // 入结果列表（同一路径去重，最多留 30 条）
            vcResults = vcResults.filter(function (x) { return x.path !== res.out; });
            vcResults.unshift({
                path: res.out,
                name: (res.mode === 'cross' ? '跨语言' : (res.mode === 'instruct' ? '情绪指令' : '克隆'))
                    + '_' + new Date().toTimeString().slice(0, 5).replace(':', ''),
                mode: res.mode || 'clone',
                dur: res.duration,
                at: Date.now(),
            });
            if (vcResults.length > 30) vcResults = vcResults.slice(0, 30);
            vcSelected = res.out;
            renderVcResults();
            el.btnInsertTimeline.disabled = false;
            el.resultInfo.innerHTML =
                '<span class="k">模式</span> ' + ({ clone: '零样本克隆', instruct: '情绪指令', cross: '跨语言' }[res.mode] || '克隆') + '<br>' +
                '<span class="k">时长</span> ' + res.duration + ' 秒<br>' +
                '<span class="k">语速</span> ' + res.speed + '×<br>' +
                '<span class="k">模型</span> ' + (res.model === 'rl' ? 'RL 强化学习版' : '基础版') + '<br>' +
                '<span class="k">模型加载</span> ' + res.load_sec + ' 秒<br>' +
                '<span class="k">生成耗时</span> ' + res.gen_sec + ' 秒<br>' +
                '<span class="k">RTF</span> ' + res.rtf + '<br>' +
                '<span class="k">产物</span> ' + res.out;
            setStatus(modeName + '完成 —— 可点结果行的 ▶ 试听，或直接拖进时间轴', 'ok');
        });

        // 读取 stderr 里的 STAGE 标记，更新进度
        var stagePct = { 'init': 2, 'load-model': 10, 'gen': 40, 'save': 92 };
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
                        'gen': modeName + '中...',
                        'save': '保存音频...'
                    }[stage] || stage;
                    setProgress(pct, label);
                }
            }
        });
    }

    // ---------- 3. 结果列表（与人声分离一致：波形 + 试听 + 拖拽 + 导入 + 插入）----------
    // 每次生成入列（最多保留 30 条），行内可直接拖进 PR 时间轴。
    var vcResults = [];        // [{ path, name, mode, dur, at }]
    var vcSelected = '';       // 当前选中的结果（供「插入选中的结果」用）
    var vcWs = null;           // wavesurfer 实侧（单实例）
    var vcWsPath = '';
    var vcWsPlaying = false;
    var vcWsTimer = null;      // 波形显示进度用的定时器（wavesurfer 会自动画，这里只同步按钮）

    var MODE_LABEL = { clone: '克隆', instruct: '情绪指令', cross: '跨语言' };
    var MODE_CLS = { clone: 'sep-res-vocals', instruct: 'sep-res-accomp', cross: 'sep-res-accomp' };

    function renderVcResults() {
        var box = el.vcResultList;
        if (!box) return;
        if (!vcResults.length) {
            box.innerHTML = '<div class="sep-res-empty">还没有生成结果</div>';
            return;
        }
        box.innerHTML = '';
        vcResults.slice().forEach(function (r) { box.appendChild(buildVcRow(r)); });
    }

    function buildVcRow(r) {
        var row = document.createElement('div');
        row.className = 'sep-res-item' + (vcSelected === r.path ? ' vc-sel' : '');
        row.setAttribute('data-path', r.path);
        row.setAttribute('draggable', 'true');
        row.title = r.path + '\n直接拖进时间轴即可';

        // 试听
        var playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'sep-res-play';
        playBtn.textContent = (vcWsPath === r.path && vcWsPlaying) ? '⏸' : '▶';
        playBtn.title = '试听';
        playBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            toggleVcPlay(r.path, playBtn);
        });
        row.appendChild(playBtn);

        // 模式标签
        var tag = document.createElement('span');
        tag.className = 'sep-res-tag ' + (MODE_CLS[r.mode] || 'sep-res-accomp');
        tag.textContent = MODE_LABEL[r.mode] || '克隆';
        row.appendChild(tag);

        // 名字 + 时长
        var info = document.createElement('div');
        info.className = 'sep-res-info';
        var nm = document.createElement('div');
        nm.className = 'sep-res-name';
        nm.textContent = r.name;
        var sub = document.createElement('div');
        sub.className = 'sep-res-sub';
        sub.textContent = (r.dur ? r.dur + ' 秒' : '') + (r.at ? ' · ' + new Date(r.at).toLocaleTimeString() : '');
        info.appendChild(nm);
        info.appendChild(sub);
        row.appendChild(info);

        // 导入素材箱
        var imp = document.createElement('button');
        imp.type = 'button';
        imp.className = 'sep-res-btn';
        imp.textContent = '导入';
        imp.title = '导入到「语音克隆」素材箱';
        imp.addEventListener('click', function (ev) {
            ev.stopPropagation();
            importToBin(r.path);
        });
        row.appendChild(imp);

        // 插入时间线
        var ins = document.createElement('button');
        ins.type = 'button';
        ins.className = 'sep-res-btn';
        ins.textContent = '插入';
        ins.title = '插入到选中音轨（位置用下面的输入框 / 默认播放头）';
        ins.addEventListener('click', function (ev) {
            ev.stopPropagation();
            vcSelected = r.path;
            insertTimeline(r.path);
        });
        row.appendChild(ins);

        // 移除（不删文件）
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'sep-res-btn sep-res-del';
        rm.textContent = '✕';
        rm.title = '从列表移除（不删文件）';
        rm.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (vcWsPath === r.path) stopVcPlay();
            vcResults = vcResults.filter(function (x) { return x.path !== r.path; });
            renderVcResults();
        });
        row.appendChild(rm);

        // 点行 = 选中（给「插入选中的结果」用）
        row.addEventListener('click', function () {
            vcSelected = r.path;
            lastOutWav = r.path;
            renderVcResults();
        });
        // 双击 = 导入素材箱
        row.addEventListener('dblclick', function () { importToBin(r.path); });

        // 拖拽进 PR 时间轴（CEP 官方 DnD，与音乐库/音效库/人声分离一致）
        row.addEventListener('dragstart', function (ev) {
            var t = ev.target;
            if (t && t.tagName === 'BUTTON') { ev.preventDefault(); return; }
            ev.dataTransfer.setData('com.adobe.cep.dnd.file.0', r.path);
            ev.dataTransfer.setData('text/plain', r.path);
            ev.dataTransfer.effectAllowed = 'copy';
        });
        row.addEventListener('dragend', function () { stopVcPlay(); });
        return row;
    }

    // 波形试听：不能用 file:// 直接 load（CEP 里常被拦），走 XHR 读 Blob —— 与人声分离同源做法
    function vcReadAsBlob(filePath, cb) {
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
        } catch (e) { cb(e, null); }
    }

    function toggleVcPlay(p, btn) {
        if (vcWsPath === p && vcWs && vcWsPlaying) { pauseVcPlay(btn); return; }
        stopVcPlay();
        if (!p || !fs.existsSync(p)) { setStatus('文件不存在：' + p, 'err'); return; }
        var row = document.querySelector('#vcResultList .sep-res-item[data-path="' + cssEsc(p) + '"]');
        var holder = row ? row.querySelector('.sep-res-wave') : null;
        if (!holder && row) {
            holder = document.createElement('div');
            holder.className = 'sep-res-wave';
            var infoEl = row.querySelector('.sep-res-info');
            if (infoEl) row.insertBefore(holder, infoEl); else row.appendChild(holder);
        }
        if (!holder) return;
        try {
            if (typeof WaveSurfer === 'undefined') throw new Error('wavesurfer 未加载');
            vcWs = WaveSurfer.create({
                container: holder,
                waveColor: '#c9b6ff', progressColor: '#8b5cf6', cursorColor: '#ffffff',
                height: 26, barWidth: 1, barGap: 1, barMinHeight: 1, cursorWidth: 1,
                interact: true, hideScrollbar: true
            });
            vcWsPath = p;
            setStatus('正在读取音频…', '');
            vcReadAsBlob(p, function (err, blob) {
                if (err || !blob) { vcWsPath = ''; setStatus('试听失败：' + (err ? err.message : '读取为空'), 'err'); return; }
                try { vcWs.loadBlob(blob); } catch (e) { setStatus('试听失败：' + e.message, 'err'); return; }
                vcWs.on('ready', function () {
                    try { vcWs.play(); } catch (e) {}
                    vcWsPlaying = true;
                    if (btn) btn.textContent = '⏸';
                    setStatus('试听中…', '');
                });
                vcWs.on('finish', function () { vcWsPlaying = false; if (btn) btn.textContent = '▶'; });
                vcWs.on('error', function (e) {
                    vcWsPlaying = false; if (btn) btn.textContent = '▶';
                    setStatus('试听出错：' + (e && e.message ? e.message : '音频解码失败'), 'err');
                });
            });
        } catch (e) { setStatus('试听失败：' + e.message, 'err'); }
    }

    function pauseVcPlay(btn) {
        try { if (vcWs) vcWs.pause(); } catch (e) {}
        vcWsPlaying = false;
        if (btn) btn.textContent = '▶';
        syncVcPlayButtons();
    }

    function stopVcPlay() {
        try { if (vcWs) vcWs.stop(); } catch (e) {}
        vcWs = null; vcWsPath = ''; vcWsPlaying = false;
        syncVcPlayButtons();
    }

    function syncVcPlayButtons() {
        var box = el.vcResultList;
        if (!box) return;
        var rows = box.querySelectorAll('.sep-res-item');
        for (var i = 0; i < rows.length; i++) {
            var p = rows[i].getAttribute('data-path');
            var b = rows[i].querySelector('.sep-res-play');
            if (b) b.textContent = (vcWsPath === p && vcWsPlaying) ? '⏸' : '▶';
        }
    }

    function cssEsc(s) { return String(s).replace(/(["\\])/g, '\\$1'); }

    // ---------- 4. 导入素材箱 ----------
    function importToBin(filePath) {
        var f = filePath || vcSelected || lastOutWav;
        if (!f) { setStatus('请先生成或选一个结果', 'err'); return; }
        if (!fs.existsSync(f)) { setStatus('产物文件不存在: ' + f, 'err'); return; }
        setStatus('正在导入素材箱...', '');
        var payloadJson = JSON.stringify([f]);
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
    function insertTimeline(filePath) {
        var f = filePath || vcSelected || lastOutWav;
        if (!f || !fs.existsSync(f)) { setStatus('产物文件不存在', 'err'); return; }
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
                doInsertTimeline(f, trackIndex, colorLabel, sec);
            });
            return;
        }
        doInsertTimeline(f, trackIndex, colorLabel, positionSec);
    }

    function doInsertTimeline(wavPath, trackIndex, colorLabel, positionSec) {
        var payload = {
            wavPath: wavPath,
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
    el.btnRefreshTrack.addEventListener('click', refreshTracks);
    el.btnInsertTimeline.addEventListener('click', function () { insertTimeline(); });

    // 音色库
    if (el.btnSaveVoice) el.btnSaveVoice.addEventListener('click', saveCurrentVoice);
    if (el.btnUseVoice) el.btnUseVoice.addEventListener('click', useVoice);
    if (el.btnDelVoice) el.btnDelVoice.addEventListener('click', delVoice);
    if (el.voiceLibSel) el.voiceLibSel.addEventListener('change', syncVoiceBtns);

    // 模式切换
    if (el.modeRow) {
        Array.prototype.forEach.call(el.modeRow.querySelectorAll('.vc-mode'), function (b) {
            b.addEventListener('click', function () { setMode(b.dataset.mode); });
        });
    }
    // 指令词条：点一下填进输入框
    if (el.instructChips) {
        Array.prototype.forEach.call(el.instructChips.querySelectorAll('.vc-chip'), function (c) {
            c.addEventListener('click', function () {
                if (el.instructText) { el.instructText.value = c.dataset.v || ''; }
                updateCloneEnabled();
            });
        });
    }
    // 文本变化 → 重算按钮可用性
    if (el.ttsText) el.ttsText.addEventListener('input', updateCloneEnabled);
    if (el.refText) el.refText.addEventListener('input', updateCloneEnabled);
    if (el.instructText) el.instructText.addEventListener('input', updateCloneEnabled);

    el.speedRange.addEventListener('input', function () {
        var v = parseFloat(el.speedRange.value).toFixed(2);
        el.speedLabel.textContent = v + '×';
        el.speedVal.textContent = v;
    });

    // 初始化
    setMode('clone');
    renderVoiceLib();
    renderVcResults();
    updateCloneEnabled();
    setStatus('就绪。选音色后填好要说的文字即可生成', '');
    refreshTracks();
    refreshProjectMedia();
})();
