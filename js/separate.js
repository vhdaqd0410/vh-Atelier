// vh-Atelier 人声分离模块（从 subtitle.js 剥离而来）
// 功能：时间轴选中片段 → ffmpeg 抠音频 → Spleeter 2-stem 分离 → 结果列表（试听 / 拖拽进时间轴 / 导入素材箱）
// 依赖：sherpa-onnx-offline-source-separation（优先本插件 bin/sherpa，回退旧字幕插件目录）
(function () {
    var csInterface = new CSInterface();
    var fs = require('fs');
    var path = require('path');
    var os = require('os');
    var child_process = require('child_process');

    var extRoot = csInterface.getSystemPath(SystemPath.EXTENSION);

    // ---------- 状态 ----------
    var sepVocalsPath = null;
    var sepAccompPath = null;
    var sepBusy = false;
    // （sepResults / sepWs 等在下文就位声明）

    // ---------- DOM ----------
    var el = {
        btnSeparate: document.getElementById('btnSeparate'),
        btnImportVocals: document.getElementById('btnImportVocals'),
        btnSepClear: document.getElementById('btnSepClear'),
        sepResultList: document.getElementById('sepResultList'),
        sepProgressWrap: document.getElementById('sepProgressWrap'),
        sepProgressFill: document.getElementById('sepProgressFill'),
        sepProgressText: document.getElementById('sepProgressText'),
        sepStatus: document.getElementById('sepStatus')
    };

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
    if (el.btnSeparate) el.btnSeparate.addEventListener('click', separateVocals);
    if (el.btnImportVocals) el.btnImportVocals.addEventListener('click', importVocals);
    if (el.btnSepClear) el.btnSepClear.addEventListener('click', clearSepResults);
    renderSepResults();

    // 供其它模块调用（保留扩展点）
    window.__vhSeparate = {
        separate: separateVocals,
        clear: clearSepResults
    };
})();
