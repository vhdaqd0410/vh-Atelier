// vh-Atelier 达芬奇版 · Breeze 朗读面板
// 与 PR 版差异：
//   1. 渲染进程 contextIsolation，不能 require / spawn
//      所有子进程调用走 window.vhHost.breezeRun / breezeStop
//   2. 进度由主进程 push 'breeze:progress' 事件，这里订阅
//   3. 时间轴取材走达芬奇宿主桥（audioClips + extractAudio）
(function () {
    'use strict';

    if (window.__bzPanel && window.__bzPanel.init) return;   // 防重复

    var H = null;   // window.vhHost
    var el = {};
    var mode = 'design';
    var busy = false;
    var refWavPath = null;
    var refDuration = 0;
    var lastOutWav = null;
    var refWaveInst = null;      // 参考音频波形实例
    var resWaveInst = null;      // 结果波形实例
    var offProg = null;
    var genStartAt = 0;
    var genTick = null;

    function $(id) { return document.getElementById(id); }

    function bindEls() {
        ['bzModelCard', 'bzModelBar', 'bzModelStat', 'bzBtnDlModel',
         'bzVoiceSel', 'bzBtnRefreshVoice', 'bzBtnUseVoice', 'bzVoiceHint',
         'bzSrcSel', 'bzBtnGrab', 'bzGrabHint', 'bzInOutRow',
         'bzTrackSel', 'bzBtnRefreshTrack', 'bzPresetSel', 'bzBtnRefreshPreset',
         'bzRefInfo', 'bzWaveBox', 'bzRefText', 'bzBtnAsr', 'bzAsrHint',
         'bzModeRow', 'bzModeHint', 'bzText', 'bzDesignWrap', 'bzInstruction',
         'bzDirectWrap', 'bzDirectText', 'bzCfg', 'bzCfgVal', 'bzSeed',
         'bzBtnDice', 'bzSaveWrap', 'bzSaveName', 'bzBtnSaveVoice',
         'bzProgWrap', 'bzProgBar', 'bzProgText',
         'bzBtnGen', 'bzBtnStop', 'bzResultWrap', 'bzResultInfo',
         'bzResultWave', 'bzBtnInsert', 'bzInsertHint'
        ].forEach(function (k) { el[k] = $(k); });
    }

    function setProg(pct, text) {
        if (el.bzProgWrap) el.bzProgWrap.style.display = 'block';
        if (el.bzProgBar) el.bzProgBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
        if (el.bzProgText) el.bzProgText.textContent = text || '';
    }
    function hideProg() { if (el.bzProgWrap) el.bzProgWrap.style.display = 'none'; }

    function setBusy(b) {
        busy = b;
        if (el.bzBtnGen) el.bzBtnGen.disabled = b;
        if (el.bzBtnStop) { el.bzBtnStop.disabled = !b; el.bzBtnStop.textContent = '停止'; }
    }

    function startTick() {
        genStartAt = Date.now();
        stopTick();
        genTick = setInterval(function () {
            if (!busy) return;
            var s = Math.floor((Date.now() - genStartAt) / 1000);
            if (el.bzProgText) {
                var cur = el.bzProgText.textContent || '';
                el.bzProgText.textContent = cur.replace(/\s·\s已用 \d+ 秒$/, '') + ' · 已用 ' + s + ' 秒';
            }
        }, 1000);
    }
    function stopTick() { if (genTick) { clearInterval(genTick); genTick = null; } }

    // ---------- 环境 / 音色 ----------
    function refreshEnv() {
        if (!H || !H.breezeEnv) return;
        H.breezeEnv().then(function (r) {
            if (!r || !r.ok) return;
            var d = r.data;
            if (el.bzModelCard) el.bzModelCard.style.display = d.ok ? 'none' : 'block';
            if (el.bzModelStat && !d.ok) {
                el.bzModelStat.textContent = d.error || ('模型 ' + d.modelSizeMB + ' MB');
            }
            renderVoices(d.voices || []);
        }).catch(function () {});
    }

    function renderVoices(list) {
        if (!el.bzVoiceSel) return;
        var cur = el.bzVoiceSel.value;
        el.bzVoiceSel.innerHTML = '<option value="">（用下方参考音频）</option>';
        list.forEach(function (v) {
            var o = document.createElement('option');
            o.value = v.id;
            o.textContent = v.name;
            el.bzVoiceSel.appendChild(o);
        });
        if (cur) el.bzVoiceSel.value = cur;
    }

    // ---------- 抓取时间轴音频（含波形 + 自动识别）----------
    function grabAudio() {
        if (!H) return;
        setProg(-1, '正在抓取时间轴音频…');
        var task = H.cloneGrabSelection
            ? H.cloneGrabSelection()
            : Promise.reject(new Error('宿主桥不支持抓取片段'));

        task.then(function (r) {
            if (!r || !r.ok) throw new Error((r && r.error) || '抓取失败');
            var d = r.data || {};
            refWavPath = d.path;
            refDuration = d.seconds || 0;
            if (el.bzRefInfo) {
                el.bzRefInfo.textContent = (d.name || '参考音频') + ' · ' + refDuration.toFixed(2) + ' 秒';
            }
            if (el.bzGrabHint) el.bzGrabHint.textContent = '已抓取 ' + refDuration.toFixed(1) + ' 秒';
            hideProg();
            // 对齐 PR：抓取后立刻画波形
            mountRefWave();
            // 对齐 PR：抓取后自动识别参考音频文字
            autoRecognizeRef();
        }).catch(function (e) {
            hideProg();
            if (el.bzGrabHint) el.bzGrabHint.textContent = '抓取失败：' + (e.message || e);
        });
    }

    // 参考音频波形（用共享组件 window.vhWave，与音效库同一套）
    function mountRefWave() {
        if (!el.bzWaveBox || !refWavPath) return;
        el.bzWaveBox.style.display = 'block';
        el.bzWaveBox.innerHTML = '';
        destroyRefWave();
        if (window.vhWave && window.vhWave.mount) {
            try {
                refWaveInst = window.vhWave.mount(el.bzWaveBox, refWavPath, { height: 54 });
            } catch (e) { refWaveInst = null; }
        } else {
            el.bzWaveBox.innerHTML = '<div class="hint" style="padding:4px;">波形组件未加载</div>';
        }
    }
    function destroyRefWave() {
        if (refWaveInst) {
            try { refWaveInst.destroy && refWaveInst.destroy(); } catch (e) {}
            refWaveInst = null;
        }
    }

    // 自动识别参考音频的文字（Whisper）
    function autoRecognizeRef() {
        if (!H || !refWavPath) return;
        if (!H.transcribeAudio) {
            if (el.bzAsrHint) el.bzAsrHint.textContent = '宿主桥不支持语音识别';
            return;
        }
        if (el.bzAsrHint) el.bzAsrHint.textContent = '正在识别参考音频文字…';
        if (el.bzBtnAsr) el.bzBtnAsr.disabled = true;

        H.transcribeAudio(refWavPath).then(function (r) {
            if (el.bzBtnAsr) el.bzBtnAsr.disabled = false;
            // 注意：宿主 ok 与转写 ok 是两层。宿主 ok=true 但转写失败时 data.ok=false
            if (!r || !r.ok) {
                if (el.bzAsrHint) el.bzAsrHint.textContent = '识别失败：' + ((r && r.error) || '未知') + '，可手动填写';
                return;
            }
            // 兼容两种结构：宿主包装 {ok,data:{text}} 或裸 {ok,text}
            var d = (r.data && typeof r.data === 'object') ? r.data : r;
            var text = d.text || d.transcript || d.srt || '';
            // 如果返回的是 SRT，抽纯文本
            if (text && /^\s*\d+\s*\n\d\d:\d\d/.test(text)) {
                text = text.split(/\r?\n/)
                    .filter(function (l) {
                        return l.trim() && !/^\d+$/.test(l.trim()) && l.indexOf('-->') < 0;
                    })
                    .join('');
            }
            text = String(text).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (!text) {
                if (el.bzAsrHint) el.bzAsrHint.textContent = '识别结果为空，请手动填写';
                return;
            }
            if (el.bzRefText) el.bzRefText.value = text;
            if (el.bzAsrHint) el.bzAsrHint.textContent = '已自动识别（' + text.length + ' 字），请核对错字';
        }).catch(function (e) {
            if (el.bzBtnAsr) el.bzBtnAsr.disabled = false;
            if (el.bzAsrHint) el.bzAsrHint.textContent = '识别失败：' + (e.message || e);
        });
    }

    // ---------- 生成 ----------
    function generate() {
        if (busy || !H) return;
        var text = (el.bzText && el.bzText.value || '').trim();
        if (!text) { alert('请先输入要朗读的文字'); return; }

        var cfg = {
            text: text,
            mode: mode,
            cfgScale: el.bzCfg ? el.bzCfg.value : 4,
            seed: el.bzSeed ? el.bzSeed.value : 42
        };
        if (mode === 'design') {
            cfg.instruction = (el.bzInstruction && el.bzInstruction.value || '').trim();
        } else {
            var voice = (el.bzVoiceSel && el.bzVoiceSel.value || '').trim();
            if (voice) cfg.voice = voice;
            else {
                if (!refWavPath) { alert('请抓取参考音频，或从音色库选一个音色'); return; }
                cfg.refAudio = refWavPath;
                cfg.refText = (el.bzRefText && el.bzRefText.value || '').trim();
                if (!cfg.refText) { alert('请填写参考音频对应的文字'); return; }
            }
            if (mode === 'direct') {
                cfg.directText = (el.bzDirectText && el.bzDirectText.value || '').trim();
                if (!cfg.directText) { alert('请填写语气指令'); return; }
            }
        }

        setBusy(true);
        setProg(-1, '启动引擎…');
        startTick();
        if (el.bzResultWrap) el.bzResultWrap.style.display = 'none';

        H.breezeRun(cfg).then(function (r) {
            if (!r || !r.ok) throw new Error((r && r.error) || '合成失败');
            var d = r.data || {};
            lastOutWav = d.path;
            setProg(100, '完成 · ' + (d.seconds || 0).toFixed(2) + ' 秒音频');
            if (el.bzResultWrap) el.bzResultWrap.style.display = 'block';
            mountResultWave();
            if (el.bzResultInfo) {
                el.bzResultInfo.textContent = (d.seconds || 0).toFixed(2) + ' 秒 · ' +
                    Math.round((d.size || 0) / 1024) + ' KB · 用时 ' + (d.spent || 0).toFixed(1) + ' 秒';
            }
            if (el.bzInsertHint) el.bzInsertHint.textContent = d.path || '';
        }).catch(function (e) {
            setProg(0, '失败：' + (e.message || e));
        }).then(function () {
            setBusy(false);
            stopTick();
        });
    }

    function stopGen() {
        if (!busy || !H) return;
        if (el.bzBtnStop) { el.bzBtnStop.disabled = true; el.bzBtnStop.textContent = '停止中…'; }
        H.breezeStop().then(function () {
            setBusy(false);
            stopTick();
            setProg(0, '已停止');
        }).catch(function () { setBusy(false); stopTick(); });
    }

    // 结果音频波形
    function mountResultWave() {
        if (!el.bzResultWave || !lastOutWav) return;
        el.bzResultWave.innerHTML = '';
        if (resWaveInst) { try { resWaveInst.destroy && resWaveInst.destroy(); } catch (e) {} resWaveInst = null; }
        if (window.vhWave && window.vhWave.mount) {
            try { resWaveInst = window.vhWave.mount(el.bzResultWave, lastOutWav, { height: 54 }); } catch (e) {}
        }
    }

    // ---------- 送到时间轴 ----------
    function insertToTimeline() {
        if (!lastOutWav || !H) return;
        var fn = H.insertAudioToTimeline || H.importMedia;
        if (!fn) { alert('宿主桥不支持送入时间轴'); return; }
        fn(lastOutWav).then(function (r) {
            if (el.bzInsertHint) {
                el.bzInsertHint.textContent = (r && r.ok) ? '已送入时间轴' : ('失败：' + ((r && r.error) || ''));
            }
        }).catch(function (e) {
            if (el.bzInsertHint) el.bzInsertHint.textContent = '失败：' + (e.message || e);
        });
    }

    // ---------- 模式切换 ----------
    function setMode(m) {
        mode = m;
        if (el.bzModeRow) {
            Array.prototype.forEach.call(el.bzModeRow.querySelectorAll('.vc-mode'), function (b) {
                b.classList.toggle('active', b.getAttribute('data-mode') === m);
            });
        }
        if (el.bzDesignWrap) el.bzDesignWrap.style.display = (m === 'design') ? 'block' : 'none';
        if (el.bzDirectWrap) el.bzDirectWrap.style.display = (m === 'direct') ? 'block' : 'none';
        var tips = {
            design: '声音设计：不需要参考音频，用一句话描述想要的嗓音。',
            clone: '声音克隆：抓取一段参考音频（≤30 秒），复刻它的音色。',
            direct: '语气导演：用参考音色，再给一句语气指令。'
        };
        if (el.bzModeHint) el.bzModeHint.textContent = tips[m] || '';
    }

    function bind() {
        if (el.bzBtnGen) el.bzBtnGen.addEventListener('click', generate);
        if (el.bzBtnStop) el.bzBtnStop.addEventListener('click', stopGen);
        if (el.bzBtnGrab) el.bzBtnGrab.addEventListener('click', grabAudio);
        if (el.bzBtnAsr) {
            el.bzBtnAsr.addEventListener('click', function () {
                if (!refWavPath) { alert('请先抓取参考音频'); return; }
                autoRecognizeRef();
            });
        }
        if (el.bzBtnInsert) el.bzBtnInsert.addEventListener('click', insertToTimeline);
        if (el.bzBtnRefreshVoice) el.bzBtnRefreshVoice.addEventListener('click', refreshEnv);
        if (el.bzModeRow) {
            Array.prototype.forEach.call(el.bzModeRow.querySelectorAll('.vc-mode'), function (b) {
                b.addEventListener('click', function () { setMode(b.getAttribute('data-mode') || 'design'); });
            });
        }
        if (el.bzCfg && el.bzCfgVal) {
            el.bzCfg.addEventListener('input', function () { el.bzCfgVal.textContent = el.bzCfg.value; });
        }
        if (el.bzBtnDice && el.bzSeed) {
            el.bzBtnDice.addEventListener('click', function () {
                el.bzSeed.value = Math.floor(Math.random() * 100000);
            });
        }
        // 取材方式目前只有「选中片段」可用，入出点待宿主桥支持后开放
        if (el.bzSrcSel) {
            Array.prototype.forEach.call(el.bzSrcSel.querySelectorAll('option'), function (o) {
                if (o.value === 'inout') o.disabled = true;
            });
        }
    }

    function init() {
        H = window.vhHost;
        bindEls();
        bind();
        setMode('design');
        refreshEnv();
        if (offProg) { try { offProg(); } catch (e) {} }
        if (H && H.onBreezeProgress) {
            offProg = H.onBreezeProgress(function (d) {
                if (!busy || !d) return;
                var l = String(d.line || '');
                if (/loading |backend:/i.test(l)) { setProg(-1, '正在加载模型…'); return; }
                var m = /generated\s+([\d.]+)\s*s/i.exec(l);
                if (m) {
                    var sec = parseFloat(m[1]) || 0;
                    var txt = (el.bzText && el.bzText.value || '');
                    var est = Math.max(2, txt.length / 4.5);
                    setProg(Math.min(95, (sec / est) * 100),
                        '正在生成… 已完成 ' + sec.toFixed(2) + ' 秒音频');
                }
            });
        }
    }

    window.__bzPanel = { init: init };
    window.__breezeAutoLoad = function () { try { init(); } catch (e) { console.log('[breeze] init 失败', e); } };
})();
