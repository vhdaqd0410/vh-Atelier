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
function meActivateSequence(name) {
    try {
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            if (app.project.sequences[i].name === name) {
                app.project.activeSequence = app.project.sequences[i];
                return "OK:" + name;
            }
        }
        return "ERR:未找到序列 " + name;
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
