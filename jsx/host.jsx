// vh-Atelier 整合插件 - ExtendScript 宿主脚本
// 板块一：字幕识别（ws 前缀）+ 板块二：语音克隆（vc 前缀）

// ==================== 板块一：字幕识别 ====================
// ---------- 序列定位 ----------
function wsFindSequence(seqId) {
    try {
        if (!seqId) return app.project.activeSequence;
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var s = app.project.sequences[i];
            if (s.sequenceID === seqId) return s;
        }
        return null;
    } catch (e) { return null; }
}

// ---------- 获取项目所有序列 ----------
function wsGetAllSequences() {
    try {
        var arr = [];
        var num = app.project.sequences.numSequences;
        var activeId = '';
        try { if (app.project.activeSequence) activeId = app.project.activeSequence.sequenceID; } catch (e) {}
        for (var i = 0; i < num; i++) {
            var s = app.project.sequences[i];
            arr.push({
                name: s.name,
                sequenceID: s.sequenceID,
                end: s.end.seconds,
                active: s.sequenceID === activeId
            });
        }
        return JSON.stringify({ sequences: arr });
    } catch (e) {
        return JSON.stringify({ error: '读取序列列表失败: ' + e.toString() });
    }
}

// ---------- 读取某个序列的音频片段信息 ----------
function wsGetSequenceClips(seqId) {
    try {
        var seq = wsFindSequence(seqId);
        if (!seq) return JSON.stringify({ error: '找不到序列' });

        var clips = [];
        var i, j;
        var audioClips = [];
        var videoClips = [];

        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            var atr = seq.audioTracks[i];
            for (j = 0; j < atr.clips.numItems; j++) {
                var aclip = atr.clips[j];
                var aMediaPath = getClipMediaPath(aclip);
                if (aMediaPath) {
                    audioClips.push({
                        mediaPath: aMediaPath,
                        seqStart: aclip.start.seconds,
                        inPoint: aclip.inPoint.seconds,
                        outPoint: aclip.outPoint.seconds,
                        duration: aclip.outPoint.seconds - aclip.inPoint.seconds,
                        trackType: 'audio',
                        clipName: aclip.name
                    });
                }
            }
        }

        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            var vtr = seq.videoTracks[i];
            for (j = 0; j < vtr.clips.numItems; j++) {
                var vclip = vtr.clips[j];
                var vMediaPath = getClipMediaPath(vclip);
                if (vMediaPath) {
                    videoClips.push({
                        mediaPath: vMediaPath,
                        seqStart: vclip.start.seconds,
                        inPoint: vclip.inPoint.seconds,
                        outPoint: vclip.outPoint.seconds,
                        duration: vclip.outPoint.seconds - vclip.inPoint.seconds,
                        trackType: 'video',
                        clipName: vclip.name
                    });
                }
            }
        }

        if (audioClips.length > 0) clips = audioClips;
        else clips = videoClips;

        if (clips.length === 0) return JSON.stringify({ error: '序列里没有可识别的音视频片段' });

        return JSON.stringify({
            clips: clips,
            seqName: seq.name,
            seqEnd: seq.end.seconds,
            sourceTrack: audioClips.length > 0 ? 'audio' : 'video'
        });
    } catch (e) {
        return JSON.stringify({ error: '读取序列失败: ' + e.toString() });
    }
}

// 获取 clip 的媒体路径，拿不到返回空
function getClipMediaPath(clip) {
    try {
        var pi = clip.projectItem;
        if (pi) {
            if (pi.getMediaPath) return pi.getMediaPath();
            if (pi.mediaItem && pi.mediaItem.file) return pi.mediaItem.file.fsName;
        }
    } catch (e) {}
    return '';
}

// ---------- 回写字幕轨 ----------
// 关键：importFiles 返回的是 Boolean（成功与否），不是 ProjectItem 数组！
// 必须用 findItemsMatchingMediaPath 按文件路径找回刚导入的 ProjectItem，
// 否则 createCaptionTrack 收到布尔值会报 "illegal parameter type"。
function wsWriteBack(seqId) {
    try {
        var payload = wsWriteBackPayload;
        if (!payload) return JSON.stringify({ error: '无回写数据' });

        var seq = wsFindSequence(seqId);
        if (!seq) return JSON.stringify({ error: '找不到序列' });

        var srtContent = payload.srt;
        var seqName = payload.seqName || seq.name || 'subtitle';

        // 1. 写 srt 到临时文件，文件名用「序列名 + 时间戳」，导入后一眼能认出是哪个序列的
        // 用 split/join 逐个替换非法字符，避免正则字面量在 ExtendScript(ES3) 里解析失败
        var safeName = seqName;
        var illegalChars = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
        for (var ci = 0; ci < illegalChars.length; ci++) {
            var ch = illegalChars[ci];
            while (safeName.indexOf(ch) >= 0) {
                safeName = safeName.split(ch).join('_');
            }
        }
        var ts = new Date();
        function pad2(n) { n = '' + n; return n.length < 2 ? '0' + n : n; }
        var stamp = ts.getFullYear() + pad2(ts.getMonth() + 1) + pad2(ts.getDate()) + '_' + pad2(ts.getHours()) + pad2(ts.getMinutes()) + pad2(ts.getSeconds());
        // 可选后缀（字幕校对回写时带「修正」，方便在项目面板区分校对过的 srt）
        var suffix = payload.nameSuffix || '';
        if (suffix) {
            for (var si = 0; si < illegalChars.length; si++) {
                var sch = illegalChars[si];
                while (suffix.indexOf(sch) >= 0) {
                    suffix = suffix.split(sch).join('_');
                }
            }
        }
        var fileName = safeName + (suffix ? '_' + suffix : '') + '_' + stamp + '.srt';
        var tmpFile = new File(Folder.temp.fsName + '/' + fileName);
        tmpFile.encoding = 'UTF-8';
        tmpFile.open('w');
        tmpFile.write(srtContent);
        tmpFile.close();

        // 2. 导入到项目（返回 boolean）
        var ok = app.project.importFiles([tmpFile.fsName], true, app.project.rootItem, false);
        if (!ok) {
            return JSON.stringify({ error: '导入 srt 失败（importFiles 返回 false）' });
        }

        // 3. 按路径找回刚导入的 ProjectItem
        var projectItem = null;
        try {
            var found = app.project.rootItem.findItemsMatchingMediaPath(tmpFile.fsName, 1);
            if (found && found.length !== undefined && found.length > 0) {
                projectItem = found[0];
            } else if (found && found.length === undefined) {
                projectItem = found;
            }
        } catch (e) {}
        if (!projectItem) {
            return JSON.stringify({ error: '导入成功但未找到 ProjectItem（findItemsMatchingMediaPath 无结果）' });
        }

        // 4. 创建字幕轨（整序列混音后时间已对齐，startAtTime 恒为 0.0）
        // 若目标序列非当前激活，先打开它（caption track 创建依赖序列处于激活状态）
        try {
            if (app.project.activeSequence && app.project.activeSequence.sequenceID !== seq.sequenceID) {
                app.project.openSequence(seq.sequenceID);
            }
        } catch (e) {}
        var result = seq.createCaptionTrack(projectItem, 0.0);
        return JSON.stringify({ ok: true, result: String(result), fileName: fileName });
    } catch (e) {
        return JSON.stringify({ error: '回写失败: ' + e.toString() });
    }
}

// ---------- 读取序列片段（三种识别基准）----------
// mode: 'all' 整轴 | 'inout' 出入点区间 | 'selection' 选中块
function wsGetSequenceClipsRange(seqId, mode) {
    try {
        var seq = wsFindSequence(seqId);
        if (!seq) return JSON.stringify({ error: '找不到序列' });

        var clips = [];
        var i, j;

        if (mode === 'selection') {
            var sel = seq.getSelection();
            if (!sel || sel.length === 0) {
                return JSON.stringify({ error: '当前序列没有选中的片段，请先在时间轴选中音频/视频块' });
            }
            for (i = 0; i < sel.length; i++) {
                var sc = sel[i];
                var sp = getClipMediaPath(sc);
                if (!sp) continue;
                var sip = sc.inPoint ? sc.inPoint.seconds : 0;
                var sop = sc.outPoint ? sc.outPoint.seconds : 0;
                clips.push({
                    mediaPath: sp,
                    seqStart: sc.start ? sc.start.seconds : 0,
                    inPoint: sip,
                    outPoint: sop,
                    duration: sop - sip,
                    trackType: 'audio',
                    clipName: sc.name || ''
                });
            }
            if (clips.length === 0) return JSON.stringify({ error: '选中的片段没有可用的媒体路径' });
            return JSON.stringify({
                clips: clips,
                seqName: seq.name,
                seqEnd: seq.end.seconds,
                sourceTrack: 'audio',
                mode: 'selection'
            });
        }

        // all / inout
        var inSec = -1, outSec = -1;
        if (mode === 'inout') {
            // getInPoint()/getOutPoint() 正常返回 Real（秒），但个别版本可能返回 Time 对象或 -1，做双重兜底
            try { inSec = seq.getInPoint(); } catch (e) { inSec = -1; }
            if (typeof inSec !== 'number' || inSec < 0) {
                try { var ipt = seq.getInPointAsTime(); if (ipt && ipt.seconds !== undefined) inSec = ipt.seconds; } catch (e2) {}
            }
            try { outSec = seq.getOutPoint(); } catch (e) { outSec = -1; }
            if (typeof outSec !== 'number' || outSec < 0) {
                try { var opt = seq.getOutPointAsTime(); if (opt && opt.seconds !== undefined) outSec = opt.seconds; } catch (e2) {}
            }
            if (inSec < 0 || outSec <= inSec) {
                return JSON.stringify({ error: '无法读取序列出入点（in=' + inSec + ', out=' + outSec + '），请先在时间轴设置入点(I)和出点(O)' });
            }
        }

        var audioClips = [], videoClips = [];
        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            var atr = seq.audioTracks[i];
            for (j = 0; j < atr.clips.numItems; j++) {
                var aclip = atr.clips[j];
                var aMediaPath = getClipMediaPath(aclip);
                if (!aMediaPath) continue;
                var ast = aclip.start.seconds;
                var adur = aclip.outPoint.seconds - aclip.inPoint.seconds;
                if (mode === 'inout' && (ast + adur <= inSec || ast >= outSec)) continue;
                audioClips.push({
                    mediaPath: aMediaPath,
                    seqStart: ast,
                    inPoint: aclip.inPoint.seconds,
                    outPoint: aclip.outPoint.seconds,
                    duration: adur,
                    trackType: 'audio',
                    clipName: aclip.name
                });
            }
        }
        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            var vtr = seq.videoTracks[i];
            for (j = 0; j < vtr.clips.numItems; j++) {
                var vclip = vtr.clips[j];
                var vMediaPath = getClipMediaPath(vclip);
                if (!vMediaPath) continue;
                var vst = vclip.start.seconds;
                var vdur = vclip.outPoint.seconds - vclip.inPoint.seconds;
                if (mode === 'inout' && (vst + vdur <= inSec || vst >= outSec)) continue;
                videoClips.push({
                    mediaPath: vMediaPath,
                    seqStart: vst,
                    inPoint: vclip.inPoint.seconds,
                    outPoint: vclip.outPoint.seconds,
                    duration: vdur,
                    trackType: 'video',
                    clipName: vclip.name
                });
            }
        }

        if (audioClips.length > 0) clips = audioClips;
        else clips = videoClips;

        if (clips.length === 0) {
            if (mode === 'inout') return JSON.stringify({ error: '出入点区间内没有可识别的音视频片段' });
            return JSON.stringify({ error: '序列里没有可识别的音视频片段' });
        }

        return JSON.stringify({
            clips: clips,
            seqName: seq.name,
            seqEnd: seq.end.seconds,
            sourceTrack: audioClips.length > 0 ? 'audio' : 'video',
            mode: mode
        });
    } catch (e) {
        return JSON.stringify({ error: '读取序列失败: ' + e.toString() });
    }
}

// ---------- 导入文件到指定素材箱（从全局变量读文件列表，避开 evalScript 转义地狱）----------
function wsImportToBinStr(binName) {
    try {
        var files = wsImportToBinPayload;
        if (!files || files.length === 0) return JSON.stringify({ error: '没有要导入的文件' });
        var root = app.project.rootItem;
        var bin = null;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            try {
                if (c.name === binName) { bin = c; break; }
            } catch (e) {}
        }
        if (!bin) {
            try { bin = root.createBin(binName); } catch (e) {
                return JSON.stringify({ error: '创建素材箱失败: ' + e.toString() });
            }
        }
        var imported = [];
        for (var j = 0; j < files.length; j++) {
            var f = new File(files[j]);
            if (!f.exists) { imported.push(f.name + '(不存在)'); continue; }
            var ok = app.project.importFiles([f.fsName], true, bin, false);
            if (ok) imported.push(f.name);
            else imported.push(f.name + '(失败)');
        }
        return JSON.stringify({ ok: true, bin: binName, imported: imported });
    } catch (e) {
        return JSON.stringify({ error: '导入素材箱失败: ' + e.toString() });
    }
}

function wsGetAllSequencesStr() { return wsGetAllSequences(); }
function wsGetSequenceClipsStr(seqId) { return wsGetSequenceClips(seqId); }
function wsGetSequenceClipsRangeStr(seqId, mode) { return wsGetSequenceClipsRange(seqId, mode); }
function wsWriteBackStr(seqId) { return wsWriteBack(seqId); }


// ==================== 板块二：语音克隆 ====================
// ---------- 序列定位 ----------
function vcFindSequence(seqId) {
    try {
        if (!seqId) return app.project.activeSequence;
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var s = app.project.sequences[i];
            if (s.sequenceID === seqId) return s;
        }
        return null;
    } catch (e) { return null; }
}

// ---------- 获取项目所有序列 ----------
function vcGetAllSequences() {
    try {
        var arr = [];
        var num = app.project.sequences.numSequences;
        var activeId = '';
        try { if (app.project.activeSequence) activeId = app.project.activeSequence.sequenceID; } catch (e) {}
        for (var i = 0; i < num; i++) {
            var s = app.project.sequences[i];
            arr.push({
                name: s.name,
                sequenceID: s.sequenceID,
                end: s.end.seconds,
                active: s.sequenceID === activeId
            });
        }
        return JSON.stringify({ sequences: arr });
    } catch (e) {
        return JSON.stringify({ error: '读取序列列表失败: ' + e.toString() });
    }
}

// ---------- 获取当前序列选中的音频片段信息（用于抠参考音频）----------
function vcGetSelectedClip() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: '没有激活的序列' });

        var sel = seq.getSelection();
        if (!sel || sel.length === 0) {
            return JSON.stringify({ error: '当前序列没有选中的片段，请先在时间轴选中一个音频/视频块作为参考音色' });
        }

        // 优先取选中项里的音频块；没有音频块则取视频块
        var target = null;
        for (var i = 0; i < sel.length; i++) {
            var it = sel[i];
            var t = '';
            try { t = it.type; } catch (e) {}
            if (t === 'audio') { target = it; break; }
        }
        if (!target) target = sel[0];

        var mediaPath = getVcClipMediaPath(target);
        if (!mediaPath) {
            return JSON.stringify({ error: '选中片段的媒体路径拿不到（可能未链接源文件）' });
        }

        var clip = {
            mediaPath: mediaPath,
            clipName: target.name || '',
            seqStart: target.start ? target.start.seconds : 0,
            inPoint: target.inPoint ? target.inPoint.seconds : 0,
            outPoint: target.outPoint ? target.outPoint.seconds : 0,
            seqName: seq.name,
            seqEnd: seq.end.seconds
        };
        return JSON.stringify({ clip: clip });
    } catch (e) {
        return JSON.stringify({ error: '读取选中片段失败: ' + e.toString() });
    }
}

// 获取 clip 的媒体路径
function getVcClipMediaPath(clip) {
    try {
        var pi = clip.projectItem;
        if (pi) {
            if (pi.getMediaPath) return pi.getMediaPath();
            if (pi.mediaItem && pi.mediaItem.file) return pi.mediaItem.file.fsName;
        }
    } catch (e) {}
    return '';
}

// ---------- 导入文件到素材箱（从全局变量读文件列表，避开 evalScript 转义地狱）----------
function vcImportToBinStr(binName) {
    try {
        var files = vcImportToBinPayload;
        if (!files || files.length === 0) return JSON.stringify({ error: '没有要导入的文件' });
        var root = app.project.rootItem;
        var bin = null;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            try {
                if (c.name === binName) { bin = c; break; }
            } catch (e) {}
        }
        if (!bin) {
            try { bin = root.createBin(binName); } catch (e) {
                return JSON.stringify({ error: '创建素材箱失败: ' + e.toString() });
            }
        }
        var imported = [];
        for (var j = 0; j < files.length; j++) {
            var f = new File(files[j]);
            if (!f.exists) { imported.push(f.name + '(不存在)'); continue; }
            var ok = app.project.importFiles([f.fsName], true, bin, false);
            if (ok) imported.push(f.name);
            else imported.push(f.name + '(失败)');
        }
        return JSON.stringify({ ok: true, bin: binName, imported: imported });
    } catch (e) {
        return JSON.stringify({ error: '导入素材箱失败: ' + e.toString() });
    }
}

function vcGetAllSequencesStr() { return vcGetAllSequences(); }
function vcGetSelectedClipStr() { return vcGetSelectedClip(); }

// ---------- 获取当前序列音轨列表（供导入时间线选择目标轨）----------
function vcGetAudioTracks() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: '没有激活的序列' });
        var tracks = [];
        for (var i = 0; i < seq.audioTracks.numTracks; i++) {
            var t = seq.audioTracks[i];
            tracks.push({ index: i, name: t.name, clips: t.clips.numItems });
        }
        return JSON.stringify({ tracks: tracks, seqName: seq.name });
    } catch (e) {
        return JSON.stringify({ error: '读取音轨列表失败: ' + e.toString() });
    }
}

// ---------- 导入 wav 到时间轴（插入语义，不覆盖后续片段）+ 换色 ----------
// 从全局变量 vcInsertPayload 读 { wavPath, trackIndex, positionSec, colorLabel }
function vcInsertToTimelineStr() {
    try {
        var payload = vcInsertPayload;
        if (!payload) return JSON.stringify({ error: '无插入数据' });
        var wavPath = payload.wavPath;
        var trackIndex = payload.trackIndex;
        var positionSec = payload.positionSec || 0;
        var colorLabel = payload.colorLabel || 9;

        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: '没有激活的序列' });

        // 1. 导入 wav 到项目（返回 boolean）
        var f = new File(wavPath);
        if (!f.exists) return JSON.stringify({ error: 'wav 不存在: ' + wavPath });
        var ok = app.project.importFiles([f.fsName], true, app.project.rootItem, false);
        if (!ok) return JSON.stringify({ error: '导入 wav 失败（importFiles 返回 false）' });

        // 2. 按路径找回刚导入的 ProjectItem
        var projectItem = null;
        try {
            var found = app.project.rootItem.findItemsMatchingMediaPath(f.fsName, 1);
            if (found && found.length !== undefined && found.length > 0) {
                projectItem = found[0];
            } else if (found && found.length === undefined) {
                projectItem = found;
            }
        } catch (e) {}
        if (!projectItem) return JSON.stringify({ error: '导入成功但未找到 ProjectItem' });

        // 3. 换色（必须在插入之前设，否则已插入的 trackItem 不更新）
        try { projectItem.setColorLabel(colorLabel); } catch (e) {}

        // 4. 计算 ticks（254016000000 ticks/秒）
        var ticks = String(Math.round(positionSec * 254016000000));

        // 5. insertClip：插入语义，把后续片段往后推、不覆盖
        var aTrackIndex = trackIndex;
        if (typeof aTrackIndex !== 'number' || aTrackIndex < 0 || aTrackIndex >= seq.audioTracks.numTracks) {
            aTrackIndex = 0;
        }
        seq.audioTracks[aTrackIndex].insertClip(projectItem, ticks, -1, aTrackIndex);

        return JSON.stringify({ ok: true, trackIndex: aTrackIndex, positionSec: positionSec, colorLabel: colorLabel });
    } catch (e) {
        return JSON.stringify({ error: '导入时间线失败: ' + e.toString() });
    }
}

// ---------- 获取播放头位置（秒），插入点默认用它 ----------
function vcGetPlayerPosition() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: '没有激活的序列' });
        var pos = seq.getPlayerPosition();
        var sec = 0;
        if (pos) {
            try { sec = pos.seconds; } catch (e) {}
            if (typeof sec !== 'number' || isNaN(sec)) sec = 0;
        }
        return JSON.stringify({ positionSec: sec });
    } catch (e) {
        return JSON.stringify({ positionSec: 0 });
    }
}

// ---------- 遍历项目素材列表（供参考音频「项目选素材」）----------
// 递归遍历项目树，把带媒体的素材（音频/视频）列出来，含路径、时长、所在素材箱
function vcListProjectMedia() {
    try {
        var root = app.project.rootItem;
        var list = [];
        var visited = {};

        function getMediaPath(pi) {
            try {
                if (pi.getMediaPath) return pi.getMediaPath();
                if (pi.mediaItem && pi.mediaItem.file) return pi.mediaItem.file.fsName;
            } catch (e) {}
            return '';
        }

        function getDuration(pi) {
            // 尝试取 in/out point 的差值，否则用 media 时长
            try {
                if (pi.getInPoint && pi.getOutPoint) {
                    var d = pi.getOutPoint().seconds - pi.getInPoint().seconds;
                    if (d > 0) return d;
                }
            } catch (e) {}
            try {
                if (pi.getMediaTimecode && pi.getDuration) {
                    return pi.getDuration().seconds;
                }
            } catch (e) {}
            return 0;
        }

        function walk(item, binPath) {
            if (!item) return;
            try {
                var id = item.nodeId || item.name;
                if (visited[id]) return;
                visited[id] = true;
            } catch (e) {}

            var t = '';
            try { t = item.type; } catch (e) {}

            if (t === 'BIN' || t === 'ROOT') {
                var children = item.children;
                if (children && children.numItems !== undefined) {
                    for (var i = 0; i < children.numItems; i++) {
                        var childName = '';
                        try { childName = children[i].name; } catch (e) {}
                        var childBinPath = binPath ? binPath + '/' + childName : childName;
                        walk(children[i], childBinPath);
                    }
                }
            } else {
                // CLIP / FILE 等媒体项
                var mp = getMediaPath(item);
                if (!mp) return;
                var ext = '';
                try { ext = mp.toLowerCase().split('.').pop(); } catch (e) {}
                // 只收常见音频/视频格式
                var audioExts = ['wav','mp3','aac','m4a','aiff','flac','ogg','wma'];
                var videoExts = ['mp4','mov','avi','mkv','mxf','mts','m2ts'];
                var isMedia = audioExts.indexOf(ext) >= 0 || videoExts.indexOf(ext) >= 0;
                if (!isMedia) return;
                list.push({
                    name: item.name,
                    mediaPath: mp,
                    binPath: binPath || '',
                    duration: getDuration(item),
                    ext: ext
                });
            }
        }

        walk(root, '');
        return JSON.stringify({ ok: true, items: list, count: list.length });
    } catch (e) {
        return JSON.stringify({ error: '遍历项目素材失败: ' + e.toString() });
    }
}

// ---------- 按名称取项目素材的媒体路径（供「项目选素材」直接指定）----------
function vcGetMediaByPath(pathStr) {
    try {
        var found = app.project.rootItem.findItemsMatchingMediaPath(pathStr, 1);
        var pi = null;
        if (found && found.length !== undefined && found.length > 0) pi = found[0];
        else if (found && found.length === undefined) pi = found;
        if (!pi) return JSON.stringify({ error: '未找到该素材' });
        var dur = 0;
        try {
            if (pi.getOutPoint && pi.getInPoint) dur = pi.getOutPoint().seconds - pi.getInPoint().seconds;
        } catch (e) {}
        if (dur <= 0) {
            try { if (pi.getDuration) dur = pi.getDuration().seconds; } catch (e) {}
        }
        return JSON.stringify({ ok: true, name: pi.name, mediaPath: pathStr, duration: dur });
    } catch (e) {
        return JSON.stringify({ error: '读取素材失败: ' + e.toString() });
    }
}


// ==================== 板块三：音效库 ====================
// 获取当前序列播放头位置（秒），音效插入默认用它
function sfxGetPlayerPosition() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: '没有激活的序列' });
        var pos = seq.getPlayerPosition();
        var sec = 0;
        if (pos) {
            try { sec = pos.seconds; } catch (e) {}
            if (typeof sec !== 'number' || isNaN(sec)) sec = 0;
        }
        return JSON.stringify({ positionSec: sec });
    } catch (e) {
        return JSON.stringify({ positionSec: 0 });
    }
}

// 把一个音效文件插入到激活序列（插入语义，不覆盖后续片段）
// 从全局变量 sfxInsertPayload 读 { path, positionSec }

// 通用：导入文件并插入当前序列（素材面板用）——按扩展名选轨
// payload: { path, positionSec?, seqName? }  seqName 可选（缺省用激活序列）
function meInsertMediaToTimeline() {
    try {
        var pl = meInsertPayload;
        if (!pl || !pl.path) return JSON.stringify({ error: '无插入数据' });
        var filePath = pl.path;
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: '没有激活的序列' });
        var f = new File(filePath);
        if (!f.exists) return JSON.stringify({ error: '文件不存在: ' + filePath });

        // 1. 导入项目根
        var ok = app.project.importFiles([f.fsName], true, app.project.rootItem, false);
        if (!ok) return JSON.stringify({ error: '导入失败' });
        // 2. 找回 ProjectItem
        var projectItem = null;
        try {
            var found = app.project.rootItem.findItemsMatchingMediaPath(f.fsName, 1);
            if (found && found.length !== undefined && found.length > 0) projectItem = found[0];
            else if (found && found.length === undefined) projectItem = found;
        } catch (e) {}
        if (!projectItem) return JSON.stringify({ error: '未找到 ProjectItem' });

        var lower = filePath.toLowerCase();
        var isAudio = /\.(wav|mp3|aiff|aac|flac|ogg|m4a|wma)$/i.test(lower);
        var isVideo = /\.(mp4|mov|mxf|avi|m4v|webm|mts|m2ts)$/i.test(lower);
        var trackIndex = -1;
        var ticks = Math.round((pl.positionSec || 0) * 254016000000);
        if (isAudio) {
            if (seq.audioTracks.numTracks < 1) return JSON.stringify({ error: '序列没有音轨' });
            trackIndex = seq.audioTracks.numTracks - 1;   // 默认最末音轨
            seq.audioTracks[trackIndex].insertClip(projectItem, String(ticks), -1, trackIndex);
            return JSON.stringify({ ok: true, trackIndex: trackIndex, trackType: 'audio', positionSec: pl.positionSec || 0, name: f.name });
        }
        // 视频/图片：找第一个可用的视频轨（优先有片段的最后一条，否则第一条）
        if (isVideo || /\.(png|jpg|jpeg)$/i.test(lower)) {
            if (seq.videoTracks.numTracks < 1) return JSON.stringify({ error: '序列没有视频轨' });
            // 用最后一条视频轨（多数项目 V1 在最底，最末可能 V3/V4 空轨）——选最底非锁定视频轨：从 0 向上找有素材的，否则用 0
            trackIndex = 0;
            seq.videoTracks[trackIndex].insertClip(projectItem, String(ticks), -1, trackIndex);
            return JSON.stringify({ ok: true, trackIndex: trackIndex, trackType: 'video', positionSec: pl.positionSec || 0, name: f.name });
        }
        return JSON.stringify({ error: '不支持的文件类型（需音/视频）: ' + filePath });
    } catch (e) { return JSON.stringify({ error: '插入时间线失败: ' + e }); }
}

function sfxInsertToTimelineStr() {
    try {
        var payload = sfxInsertPayload;
        if (!payload || !payload.path) return JSON.stringify({ error: '无插入数据' });
        var filePath = payload.path;
        var positionSec = payload.positionSec || 0;

        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: '没有激活的序列' });

        // 1. 导入到项目（返回 boolean）
        var f = new File(filePath);
        if (!f.exists) return JSON.stringify({ error: '文件不存在: ' + filePath });
        var ok = app.project.importFiles([f.fsName], true, app.project.rootItem, false);
        if (!ok) return JSON.stringify({ error: '导入失败（importFiles 返回 false）' });

        // 2. 按路径找回刚导入的 ProjectItem
        var projectItem = null;
        try {
            var found = app.project.rootItem.findItemsMatchingMediaPath(f.fsName, 1);
            if (found && found.length !== undefined && found.length > 0) projectItem = found[0];
            else if (found && found.length === undefined) projectItem = found;
        } catch (e) {}
        if (!projectItem) return JSON.stringify({ error: '导入成功但未找到 ProjectItem' });

        // 3. 计算 ticks（254016000000 ticks/秒），插入到最末一条音轨
        var ticks = String(Math.round(positionSec * 254016000000));
        var aTrackIndex = seq.audioTracks.numTracks - 1;
        if (aTrackIndex < 0) aTrackIndex = 0;
        seq.audioTracks[aTrackIndex].insertClip(projectItem, ticks, -1, aTrackIndex);

        return JSON.stringify({ ok: true, trackIndex: aTrackIndex, positionSec: positionSec, name: f.name });
    } catch (e) {
        return JSON.stringify({ error: '插入时间线失败: ' + e.toString() });
    }
}

// 导入一个音效文件到「音效库」素材箱（从全局变量 sfxImportPayload 读文件列表）
function sfxImportToBinStr() {
    try {
        var files = sfxImportPayload;
        if (!files || files.length === 0) return JSON.stringify({ error: '没有要导入的文件' });
        var root = app.project.rootItem;
        var bin = null;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            try {
                if (c.name === '音效库') { bin = c; break; }
            } catch (e) {}
        }
        if (!bin) {
            try { bin = root.createBin('音效库'); } catch (e) {
                return JSON.stringify({ error: '创建素材箱失败: ' + e.toString() });
            }
        }
        var imported = [];
        for (var j = 0; j < files.length; j++) {
            var f = new File(files[j]);
            if (!f.exists) { imported.push(f.name + '(不存在)'); continue; }
            var ok = app.project.importFiles([f.fsName], true, bin, false);
            if (ok) imported.push(f.name);
            else imported.push(f.name + '(失败)');
        }
        return JSON.stringify({ ok: true, bin: '音效库', imported: imported });
    } catch (e) {
        return JSON.stringify({ error: '导入音效失败: ' + e.toString() });
    }
}

// 导入音乐文件到「音乐」素材箱（从全局变量 musicImportPayload 读文件列表）
// 与 sfxImportToBinStr 同构，仅目标素材箱不同；供「音乐」板块下载后一键导入 PR 用
function musicImportToBinStr() {
    try {
        var files = musicImportPayload;
        if (!files || files.length === 0) return JSON.stringify({ error: '没有要导入的文件' });
        var root = app.project.rootItem;
        var bin = null;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            try {
                if (c.name === '音乐') { bin = c; break; }
            } catch (e) {}
        }
        if (!bin) {
            try { bin = root.createBin('音乐'); } catch (e) {
                return JSON.stringify({ error: '创建素材箱失败: ' + e.toString() });
            }
        }
        var imported = [];
        for (var j = 0; j < files.length; j++) {
            var f = new File(files[j]);
            if (!f.exists) { imported.push(f.name + '(不存在)'); continue; }
            var ok = app.project.importFiles([f.fsName], true, bin, false);
            if (ok) imported.push(f.name);
            else imported.push(f.name + '(失败)');
        }
        return JSON.stringify({ ok: true, bin: '音乐', imported: imported });
    } catch (e) {
        return JSON.stringify({ error: '导入音乐失败: ' + e.toString() });
    }
}

// 导入视频文件到「视频」素材箱（从全局变量 videoImportPayload 读文件列表）
// 与 musicImportToBinStr 同构，仅目标素材箱不同；供「视频下载」板块下载后一键导入 PR 用
function videoImportToBinStr() {
    try {
        var files = videoImportPayload;
        if (!files || files.length === 0) return JSON.stringify({ error: '没有要导入的文件' });
        var root = app.project.rootItem;
        var bin = null;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            try {
                if (c.name === '视频') { bin = c; break; }
            } catch (e) {}
        }
        if (!bin) {
            try { bin = root.createBin('视频'); } catch (e) {
                return JSON.stringify({ error: '创建素材箱失败: ' + e.toString() });
            }
        }
        var imported = [];
        for (var j = 0; j < files.length; j++) {
            var f = new File(files[j]);
            if (!f.exists) { imported.push(f.name + '(不存在)'); continue; }
            var ok = app.project.importFiles([f.fsName], true, bin, false);
            if (ok) imported.push(f.name);
            else imported.push(f.name + '(失败)');
        }
        return JSON.stringify({ ok: true, bin: '视频', imported: imported });
    } catch (e) {
        return JSON.stringify({ error: '导入视频失败: ' + e.toString() });
    }
}


// ==================== 板块五：字幕校对 ====================
// 列出项目里所有 .srt 字幕素材（供校对选择字幕）
// 注意：item.type 是数字（1=bin/2=clip/3=file/4=root），不能当字符串比较；
// 改用「有无 children」判断是否容器，更健壮。
function ckListProjectSrt() {
    try {
        var root = app.project.rootItem;
        var list = [];
        var visited = {};
        var debug = [];

        function getMediaPath(pi) {
            try {
                if (pi.getMediaPath) {
                    var p = pi.getMediaPath();
                    if (p) return p;
                }
            } catch (e) {}
            try {
                if (pi.mediaItem && pi.mediaItem.file) return pi.mediaItem.file.fsName;
            } catch (e) {}
            return '';
        }

        // 注意：与 vcListProjectMedia 内的同名 walk 是不同用途（本版遍历 srt + 收集诊断），勿合并
        function walk(item, binPath) {
            if (!item) return;
            try {
                var id = item.nodeId || item.name;
                if (visited[id]) return;
                visited[id] = true;
            } catch (e) {}

            // 有 children 就当容器递归（bin/root 都有 children）
            var children = null;
            try { children = item.children; } catch (e) {}
            if (children && children.numItems !== undefined && children.numItems > 0) {
                for (var i = 0; i < children.numItems; i++) {
                    var child = null;
                    try { child = children[i]; } catch (e) {}
                    var childName = '';
                    try { childName = child ? child.name : ''; } catch (e) {}
                    var childBinPath = binPath ? binPath + '/' + childName : childName;
                    walk(child, childBinPath);
                }
                return;
            }

            // 叶子：收集诊断信息（最多 200 条，防爆）
            var nm = '';
            try { nm = item.name; } catch (e) {}
            var mp = getMediaPath(item);
            var t = '';
            try { t = String(item.type); } catch (e) {}
            if (debug.length < 200) {
                var mpShort = mp;
                if (mp && mp.length > 60) mpShort = '...' + mp.substring(mp.length - 57);
                debug.push({ name: nm, type: t, ext: (mp || '').toLowerCase().split('.').pop(), hasMediaPath: mp ? 1 : 0, mediaPath: mpShort || '' });
            }

            // 只收 .srt：优先看媒体路径后缀，其次看名字后缀
            var ext = '';
            if (mp) { try { ext = mp.toLowerCase().split('.').pop(); } catch (e) {} }
            if (ext !== 'srt') {
                var nameLower = nm.toLowerCase();
                if (nameLower.substring(nameLower.length - 4) === '.srt') ext = 'srt';
            }
            if (ext !== 'srt') return;

            list.push({
                name: nm,
                mediaPath: mp,
                binPath: binPath || ''
            });
        }

        walk(root, '');
        return JSON.stringify({ ok: true, items: list, count: list.length, debug: debug });
    } catch (e) {
        return JSON.stringify({ error: '遍历项目字幕失败: ' + e.toString() });
    }
}

// 按项目面板选中的 srt 素材路径取媒体路径（供校对直接指定）
function ckGetSrtByPath(pathStr) {
    try {
        var found = app.project.rootItem.findItemsMatchingMediaPath(pathStr, 1);
        var pi = null;
        if (found && found.length !== undefined && found.length > 0) pi = found[0];
        else if (found && found.length === undefined) pi = found;
        if (!pi) return JSON.stringify({ error: '未找到该字幕素材' });
        return JSON.stringify({ ok: true, name: pi.name, mediaPath: pathStr });
    } catch (e) {
        return JSON.stringify({ error: '读取字幕素材失败: ' + e.toString() });
    }
}

// 读取项目面板当前选中的素材（方案 B：用户选中哪个 srt，就读哪个）
// 返回尽可能多的诊断字段，方便确认 caption 素材是否能拿到磁盘路径
function ckGetSelectedSrt() {
    try {
        var sel = null;
        try { sel = app.getCurrentProjectViewSelection(); } catch (e) {}
        if (!sel) return JSON.stringify({ error: '没有选中的素材（请在项目面板点选一个字幕素材）' });
        var arr = sel;
        // 可能返回单个对象或数组
        var item = null;
        if (sel.length !== undefined) {
            if (sel.length === 0) return JSON.stringify({ error: '没有选中的素材' });
            item = sel[0];
        } else {
            item = sel;
        }
        if (!item) return JSON.stringify({ error: '选中项为空' });

        var name = '';
        try { name = item.name; } catch (e) {}
        var type = '';
        try { type = String(item.type); } catch (e) {}
        var mp = '';
        try { if (item.getMediaPath) mp = item.getMediaPath(); } catch (e) {}
        if (!mp) {
            try { if (item.mediaItem && item.mediaItem.file) mp = item.mediaItem.file.fsName; } catch (e) {}
        }
        var treePath = '';
        try { treePath = item.treePath || ''; } catch (e) {}

        return JSON.stringify({
            ok: true,
            name: name,
            type: type,
            mediaPath: mp,
            treePath: treePath
        });
    } catch (e) {
        return JSON.stringify({ error: '读取选中素材失败: ' + e.toString() });
    }
}

// 定位播放头：把指定序列的播放头跳到指定秒数（供字幕校对差异项点击定位）
// 参数：seqId（序列 ID）、seconds（秒，浮点）。PR 播放头是 ticks 字符串，254016000000 ticks = 1 秒。
function ckSeekToStr(seqId, seconds) {
    try {
        var seq = wsFindSequence(seqId);
        if (!seq) return JSON.stringify({ error: '找不到序列' });
        var sec = parseFloat(seconds);
        if (isNaN(sec)) return JSON.stringify({ error: '时间无效' });
        // 激活序列，让 PR 界面跟着跳
        try { app.project.activeSequence = seq; } catch (e) {}
        var ticks = Math.round(sec * 254016000000);
        try { seq.setPlayerPosition(String(ticks)); } catch (e) {
            return JSON.stringify({ error: '定位失败: ' + e.toString() });
        }
        return JSON.stringify({ ok: true, positionSec: sec });
    } catch (e) {
        return JSON.stringify({ error: '定位失败: ' + e.toString() });
    }
}

// 从独立插件 com.delivery.multiexport 整合而来（me 前缀）
// 核心 API（已验证）：
//   sequence.exportAsMediaDirect(outputPath, presetPath, exportType)
//   track.setMute(1/0)   静音 / 恢复 音频轨
function meVersion() { return "3.3.0"; }

// 列出项目里所有序列
function meListSequences() {
    try {
        var seqs = [];
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            seqs.push({ name: app.project.sequences[i].name, id: i });
        }
        return "OK:" + JSON.stringify(seqs);
    } catch (e) { return "ERR:" + e; }
}

// 激活指定序列（按名字）
// 容错：去首尾空白、忽略大小写、全角空格→半角、忽略所有空格后比较
function meActivateSequence(name) {
    try {
        var target = String(name == null ? "" : name);
        function norm(s) {
            return String(s == null ? "" : s)
                .replace(/\u3000/g, " ")
                .replace(/^\s+|\s+$/g, "")
                .toLowerCase();
        }
        function compact(s) { return norm(s).replace(/\s+/g, ""); }
        var tn = norm(target), tc = compact(target);
        var exact = null, loose = null, avail = [];
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var sq = app.project.sequences[i];
            var sn = String(sq.name == null ? "" : sq.name);
            avail.push(sn);
            if (sn === target) { exact = sq; break; }
            if (!loose && (norm(sn) === tn || compact(sn) === tc)) { loose = sq; }
        }
        var hit = exact || loose;
        if (hit) {
            app.project.activeSequence = hit;
            return "OK:" + hit.name;
        }
        return "ERR:未找到序列 [" + target + "]；当前项目可用序列（" + avail.length + "）：" + avail.join(" | ");
    } catch (e) { return "ERR:" + e; }
}

// 列出活动序列的所有音频轨（含名称）
function meListAudioTracks() {
    try {
        var s = app.project.activeSequence;
        if (!s) return "ERR:没有活动序列";
        var tracks = [];
        for (var i = 0; i < s.audioTracks.numTracks; i++) {
            var nm = "";
            try { nm = s.audioTracks[i].name; } catch (_) {}
            tracks.push({ index: i, name: nm });
        }
        return "OK:" + JSON.stringify(tracks);
    } catch (e) { return "ERR:" + e; }
}

// 静音所有「不在保留列表内」的音频轨
// keepListStr: 逗号分隔的 0-based 索引字符串，如 "0,1"
function meMuteExcept(keepListStr) {
    try {
        var s = app.project.activeSequence;
        if (!s) return "ERR:没有活动序列";
        var parts = String(keepListStr).split(',');
        var keepSet = {};
        for (var k = 0; k < parts.length; k++) {
            var idx = parseInt(parts[k], 10);
            if (!isNaN(idx)) keepSet[String(idx)] = true;
        }
        var n = s.audioTracks.numTracks;
        var muted = [];
        var kept = [];
        for (var i = 0; i < n; i++) {
            var keep = (keepSet[String(i)] === true);
            s.audioTracks[i].setMute(keep ? 0 : 1);
            if (keep) kept.push(i + 1); else muted.push(i + 1);
        }
        return "OK:" + JSON.stringify({ muted: muted, kept: kept, total: n });
    } catch (e) { return "ERR:" + e; }
}

// 取消所有音频轨静音（逐个处理，单个失败不中断整体）
function meUnmuteAll() {
    try {
        var s = app.project.activeSequence;
        if (!s) return "ERR:没有活动序列";
        var n = s.audioTracks.numTracks;
        var failed = 0;
        for (var i = 0; i < n; i++) {
            try { s.audioTracks[i].setMute(0); } catch (e) { failed++; }
        }
        if (failed > 0) return "ERR:" + failed + " 条轨道恢复失败";
        return "OK:";
    } catch (e) { return "ERR:" + e; }
}

// 用指定预设导出活动序列
// exportType: 0 = 整个序列, 1 = 入点到出点
function meExport(outputPath, presetPath, exportType) {
    try {
        var s = app.project.activeSequence;
        if (!s) return "ERR:没有活动序列";

        var preset = new File(presetPath);
        if (!preset.exists) return "ERR:找不到预设 " + presetPath;

        var output = new File(outputPath);
        var parent = output.parent;
        if (parent && !parent.exists) parent.create();

        var ok = s.exportAsMediaDirect(output.fsName, preset.fsName, exportType || 0);
        if (!ok) return "ERR:exportAsMediaDirect 返回失败";
        return "OK:" + output.fsName;
    } catch (e) { return "ERR:" + e; }
}

// ==================== 选中片段：去字幕/超分 按片段导出 ====================
// 读取时间轴当前选中的视频片段信息（只读，用于面板显示）
// 返回 { seqName, startSec, endSec, durationSec, clipCount }
function meGetSelectedClipInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "ERR:没有激活的序列";
        var sel = seq.getSelection();
        if (!sel || sel.length === 0) return "ERR:当前序列没有选中的片段，请先在时间轴选中视频片段";

        var ticksPerSec = 254016000000;
        var startSec = -1, endSec = -1, n = 0;
        for (var i = 0; i < sel.length; i++) {
            var it = sel[i];
            var t = '';
            try { t = it.type; } catch (e) {}
            if (t !== 'video') continue;   // 只认视频片段（去字幕/超分都要画面）
            var st = 0, du = 0;
            try { st = it.start.seconds; } catch (e2) { continue; }
            try { du = it.outPoint.seconds - it.inPoint.seconds; } catch (e3) { du = 0; }
            if (du <= 0) continue;
            var en = st + du;
            if (startSec < 0 || st < startSec) startSec = st;
            if (endSec < 0 || en > endSec) endSec = en;
            n++;
        }
        if (n === 0) return "ERR:选中的不是视频片段（可能选到了音频轨），请选中视频轨上的片段";
        if (endSec <= startSec) return "ERR:片段时长无效";
        return "OK:" + JSON.stringify({
            seqName: seq.name,
            startSec: Math.round(startSec * 1000) / 1000,
            endSec: Math.round(endSec * 1000) / 1000,
            durationSec: Math.round((endSec - startSec) * 1000) / 1000,
            clipCount: n
        });
    } catch (e) { return "ERR:" + e.toString(); }
}

// 导出指定区间：把入出点设为 [startSec, endSec] → 导出 → 还原原入出点
// 从全局变量 meRangePayload 读 { seqName, startSec, endSec, outPath, presetPath }
function meExportRangeStr() {
    try {
        var pl = meRangePayload;
        if (!pl || !pl.outPath || !pl.presetPath) return "ERR:缺少导出参数";
        var seq = app.project.activeSequence;
        if (!seq) return "ERR:没有激活的序列";
        // 序列名不一致时先激活（容错去空白/大小写）
        if (pl.seqName && seq.name !== pl.seqName) {
            var act = meActivateSequence(pl.seqName);
            if (act.indexOf('OK:') !== 0) return "ERR:激活序列失败：" + act;
            seq = app.project.activeSequence;
        }
        var ticksPerSec = 254016000000;
        var inTicks = String(Math.round((pl.startSec || 0) * ticksPerSec));
        var outTicks = String(Math.round((pl.endSec || 0) * ticksPerSec));

        // 备份原入出点（-1 = 原本未设置）
        var oldIn = -1, oldOut = -1;
        try { oldIn = seq.getInPoint(); } catch (e) { oldIn = -1; }
        if (typeof oldIn !== 'number') oldIn = -1;
        try { oldOut = seq.getOutPoint(); } catch (e) { oldOut = -1; }
        if (typeof oldOut !== 'number') oldOut = -1;

        // 设入出点（PR 需要 ticks 字符串）
        var okSet = true;
        try {
            if (!seq.setInPoint) okSet = false;
            else seq.setInPoint(inTicks);
            if (!seq.setOutPoint) okSet = false;
            else seq.setOutPoint(outTicks);
        } catch (e4) { okSet = false; }
        if (!okSet) {
            return "ERR:NOSETINOUT:当前 PR 版本的 setInPoint/setOutPoint 不可用，请先在时间轴上按 I/O 手动设好入出点，再用「整集」方式导出";
        }

        var output = new File(pl.outPath);
        var preset = new File(pl.presetPath);
        if (!preset.exists) return "ERR:导出预设不存在：" + pl.presetPath;
        // exportType: 1 = 入点到出点
        var ok = seq.exportAsMediaDirect(output.fsName, preset.fsName, 1);

        // 还原入出点（不管导出成败）
        try {
            if (oldIn >= 0) seq.setInPoint(String(Math.round(oldIn * ticksPerSec)));
            else if (seq.clearInPoint) seq.clearInPoint();
        } catch (e5) {}
        try {
            if (oldOut >= 0) seq.setOutPoint(String(Math.round(oldOut * ticksPerSec)));
            else if (seq.clearOutPoint) seq.clearOutPoint();
        } catch (e6) {}

        if (!ok) return "ERR:exportAsMediaDirect 返回失败（入点 " + pl.startSec + "s / 出点 " + pl.endSec + "s）";
        return "OK:" + output.fsName;
    } catch (e) { return "ERR:" + e.toString(); }
}

// 获取活动序列的时长（秒）与帧尺寸，供交付清单使用
function meSeqInfo() {
    try {
        var s = app.project.activeSequence;
        if (!s) return "ERR:没有活动序列";
        var dur = 0, w = 0, h = 0;
        try { w = s.frameSizeHorizontal; } catch (_) {}
        try { h = s.frameSizeVertical; } catch (_) {}
        try {
            var ticksPerSec = 254016000000;
            var endTicks = parseFloat(s.end);
            var zeroTicks = parseFloat(s.zeroPoint);
            if (!isNaN(endTicks) && !isNaN(zeroTicks)) dur = (endTicks - zeroTicks) / ticksPerSec;
        } catch (_) {}
        return "OK:" + JSON.stringify({ durationSec: Math.round(dur * 100) / 100, width: w, height: h });
    } catch (e) { return "ERR:" + e; }
}

// 获取当前 PR 工程对应“项目根目录”（超分结果落位）
// 逻辑：工程文件通常位于 <项目根>/工程文件/xxx.prproj；
// 若工程目录的父目录含 01原素材/剧本 等项目特征目录，返回父目录（项目根），否则返回工程目录本身。
function meProjectDir() {
    try {
        var p = app.project;
        if (!p) return "ERR:无打开工程";
        var dir = "";
        try { dir = p.path; } catch (e) {}
        if (!dir) {
            try { if (p.document && p.document.path) dir = p.document.path; } catch (e) {}
        }
        if (!dir) return "OK:";
        // 防御：若 path 返回的是工程文件全路径（含 .prproj），取其所在目录
        if (/\.prproj$/i.test(dir)) {
            var psep = -1, pi;
            for (pi = dir.length - 1; pi >= 0; pi--) {
                if (dir.charAt(pi) === "/" || dir.charAt(pi) === "\\") { psep = pi; break; }
            }
            if (psep > 0) dir = dir.slice(0, psep);
        }
        // 工程文件通常在 <项目根>/工程文件 下；父目录含项目特征目录则视为项目根
        try {
            var sep = -1, i;
            for (i = dir.length - 1; i >= 0; i--) {
                if (dir.charAt(i) === "/" || dir.charAt(i) === "\\") { sep = i; break; }
            }
            if (sep > 0) {
                var up = dir.slice(0, sep);
                var fso = new Folder(up);
                if (fso.exists) {
                    var entries = fso.getFiles();
                    var hasSig = false;
                    for (i = 0; i < entries.length; i++) {
                        var nm = entries[i].name;
                        if (nm.indexOf("01原素材") >= 0 || nm.indexOf("剧本") >= 0 || nm.indexOf("工程文件") >= 0) { hasSig = true; break; }
                    }
                    if (hasSig) return "OK:" + up;
                }
            }
        } catch (e) {}
        return "OK:" + dir;
    } catch (e) { return "ERR:" + e; }
}

// 获取当前工程信息（供导入前确认目标工程，避免多工程误导入）
function meProjectInfo() {
    try {
        var p = app.project;
        if (!p) return JSON.stringify({ error: '无打开工程' });
        var name = '', dir = '', saved = false, seqName = '';
        try { name = p.name; } catch (e) {}
        try { dir = p.path; } catch (e) {}
        try { saved = p.saved; } catch (e) {}
        try { if (app.project.activeSequence) seqName = app.project.activeSequence.name; } catch (e) {}
        return JSON.stringify({ name: name, dir: dir, saved: !!saved, seq: seqName });
    } catch (e) { return JSON.stringify({ error: e.toString() }); }
}

// 递归导入文件夹（保留目录层级结构到 targetBin）
// 入参：folderPath(绝对路径), binName(目标素材箱名)，通过全局 meImportPayload 传路径
function meImportFolderTreeStr() {
    try {
        var pl = meImportPayload;
        if (!pl || !pl.folderPath || !pl.binName) return JSON.stringify({ error: '缺参数' });
        var root = app.project.rootItem;
        var srcDir = new Folder(pl.folderPath);
        if (!srcDir.exists) return JSON.stringify({ error: '源目录不存在: ' + pl.folderPath });
        // 建目标 bin
        var bin = null;
        for (var bi = 0; bi < root.children.numItems; bi++) {
            var cc = root.children[bi];
            try { if (cc.name === pl.binName) { bin = cc; break; } } catch (e) {}
        }
        if (!bin) { try { bin = root.createBin(pl.binName); } catch (e) { return JSON.stringify({ error: '创建素材箱失败: ' + e }); } }

        var imported = [];
        var failed = [];
        var stats = { files: 0, ok: 0, fail: 0 };

        // 递归：目标 bin 下建同名子目录层级
        function importDir(srcF, dstBin) {
            var entries = srcF.getFiles();
            for (var i = 0; i < entries.length; i++) {
                var ent = entries[i];
                if (ent instanceof Folder) {
                    // 子文件夹：在 dstBin 下建同名 bin（若没有），递归
                    var sub = null;
                    for (var sbi = 0; sbi < dstBin.children.numItems; sbi++) {
                        var sc = dstBin.children[sbi];
                        try { if (sc.name === ent.name) { sub = sc; break; } } catch (e) {}
                    }
                    if (!sub) { try { sub = dstBin.createBin(ent.name); } catch (e) { sub = null; } }
                    if (sub) importDir(ent, sub);
                } else if (ent instanceof File) {
                    var f = new File(ent.fsName);
                    stats.files++;
                    try {
                        var ok = app.project.importFiles([f.fsName], true, dstBin, false);
                        if (ok) { stats.ok++; imported.push(ent.name); }
                        else { stats.fail++; failed.push(ent.name + '(导入失败)'); }
                    } catch (e) { stats.fail++; failed.push(ent.name + '(异常:' + e + ')'); }
                }
            }
        }
        importDir(srcDir, bin);
        return JSON.stringify({ ok: true, bin: pl.binName, imported: imported, failed: failed, stats: stats });
    } catch (e) { return JSON.stringify({ error: '导入异常: ' + e }); }
}

// 单个/多个文件导入目标 bin（带逐文件进度回报到 stderr 不可行，ExtendScript 无流；
// 改为前端分批调用：每次导入一批，进度由前端控制）

// 按前端算好的目录树 plan 导入（目录名/文件路径由 JS 端 UTF-8 提供，绕开 ExtendScript 中文目录读取编码坑）
// plan: { binName, groups: [ { relPath: [dir1, dir2...], files: [abs路径...] }, ... ] }
function meImportTreePlanStr() {
    try {
        var pl = meImportPayload;
        if (!pl || !pl.binName || !pl.groups) return JSON.stringify({ error: '缺参数' });
        var root = app.project.rootItem;
        var bin = null;
        for (var bi = 0; bi < root.children.numItems; bi++) {
            var cc = root.children[bi];
            try { if (cc.name === pl.binName) { bin = cc; break; } } catch (e) {}
        }
        if (!bin) { try { bin = root.createBin(pl.binName); } catch (e) { return JSON.stringify({ error: '创建素材箱失败: ' + e }); } }

        var stats = { files: 0, ok: 0, fail: 0 };
        var failed = [];

        function findOrCreateBin(parentBin, name) {
            var target = null;
            for (var i = 0; i < parentBin.children.numItems; i++) {
                var c = parentBin.children[i];
                try { if (c.name === name) { target = c; break; } } catch (e) {}
            }
            if (!target) { try { target = parentBin.createBin(name); } catch (e) { target = null; } }
            return target;
        }

        for (var gi = 0; gi < pl.groups.length; gi++) {
            var g = pl.groups[gi];
            var cur = bin;
            // 沿 relPath 建/找 bin 层级
            var rel = g.relPath || [];
            var okPath = true;
            for (var rj = 0; rj < rel.length; rj++) {
                var sub = findOrCreateBin(cur, rel[rj]);
                if (!sub) { okPath = false; break; }
                cur = sub;
            }
            if (!okPath) continue;
            // 导入该层文件
            var files = g.files || [];
            for (var fj = 0; fj < files.length; fj++) {
                var fp = files[fj];
                var fobj = new File(fp);
                stats.files++;
                if (!fobj.exists) { stats.fail++; failed.push(fp + '(不存在)'); continue; }
                try {
                    var ok = app.project.importFiles([fobj.fsName], true, cur, false);
                    if (ok) stats.ok++; else { stats.fail++; failed.push(fobj.name + '(失败)'); }
                } catch (e) { stats.fail++; failed.push(fobj.name + '(异常:' + e + ')'); }
            }
        }
        return JSON.stringify({ ok: true, bin: pl.binName, stats: stats, failed: failed });
    } catch (e) { return JSON.stringify({ error: '导入异常: ' + e }); }
}

function meImportFilesToBinStr() {
    try {
        var pl = meImportPayload;
        if (!pl || !pl.files || !pl.binName) return JSON.stringify({ error: '缺参数' });
        var root = app.project.rootItem;
        var bin = null;
        for (var i = 0; i < root.children.numItems; i++) {
            var c = root.children[i];
            try { if (c.name === pl.binName) { bin = c; break; } } catch (e) {}
        }
        if (!bin) { try { bin = root.createBin(pl.binName); } catch (e) { return JSON.stringify({ error: '创建素材箱失败: ' + e }); } }
        var imported = [], failed = [];
        for (var j = 0; j < pl.files.length; j++) {
            var f = new File(pl.files[j]);
            if (!f.exists) { failed.push(pl.files[j] + '(不存在)'); continue; }
            try {
                var ok = app.project.importFiles([f.fsName], true, bin, false);
                if (ok) imported.push(f.name); else failed.push(f.name + '(失败)');
            } catch (e) { failed.push(f.name + '(异常:' + e + ')'); }
        }
        return JSON.stringify({ ok: true, bin: pl.binName, imported: imported, failed: failed });
    } catch (e) { return JSON.stringify({ error: '导入异常: ' + e }); }
}
