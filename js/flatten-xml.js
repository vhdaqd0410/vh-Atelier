/* vh-Atelier · 调色 XML 清理与合轨
 * ==========================================================================
 * 做什么：把剪辑完成的序列导出的 FCP XML，清理成「只给调色用」的单轨 XML
 *
 * 背景（从用户真实样本反推 + 逐段验证，非推测）：
 *   原始序列常有 11 条视频轨 + 18 条音频轨，其中包含水印、调整图层(LUT)、
 *   转场素材、叠加图片，以及大量被禁用的备用镜头。
 *   手工「简化序列 + 逐轨向 V1 覆盖」后得到 1 条视频轨、0 个音频片段。
 *
 * 规则（样本验证：61 段全字段 100% 一致）：
 *   1. 删除 enabled=FALSE 的片段（"没用到的镜头"）
 *   2. 跳过装饰轨（水印/调整图层/转场/叠加图片）——由用户在界面上指定
 *   3. 清空所有音频轨的片段
 *   4. 合轨：从最高轨往下，取「未被上层覆盖的部分」，按帧偏移线性裁剪 in/out
 *      · 片段是原子单位，不会被下层轨道的边界切碎
 *      · 部分被覆盖时：in += 偏移，out = in + 新时长
 *      · pproTicksIn/Out 同步重算（实测 = 帧号 × 每帧 ticks）
 *   5. 其余视频轨清空
 *
 * 保真度：直接搬运原始 XML 文本块，不回写不重排，
 *         片段自带的效果、file 引用、pproTicks 等原样保留。
 */
(function () {
    'use strict';

    var fs = null;
    try { fs = require('fs'); } catch (e) {}

    // ==================== 极简 XML 解析（保留原始文本偏移） ====================
    // 只需要元素结构 + 每个元素的原始文本范围，够用且不引入依赖。
    // 不支持：DTD 实体展开、命名空间（FCP XML 用不到）。

    function parseAttrs(s) {
        var o = {};
        var re = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        var m;
        while ((m = re.exec(s))) o[m[1]] = m[2] !== undefined ? m[2] : m[3];
        return o;
    }

    function parse(src) {
        var root = null;
        var stack = [];
        var i = 0, n = src.length;

        while (i < n) {
            var lt = src.indexOf('<', i);
            if (lt < 0) break;

            // 注释
            if (src.substr(lt, 4) === '<!--') {
                var ce = src.indexOf('-->', lt);
                i = ce < 0 ? n : ce + 3;
                continue;
            }
            // CDATA
            if (src.substr(lt, 9) === '<![CDATA[') {
                var cde = src.indexOf(']]>', lt);
                i = cde < 0 ? n : cde + 3;
                continue;
            }
            // DOCTYPE / 处理指令
            if (src.charAt(lt + 1) === '!' || src.charAt(lt + 1) === '?') {
                var de = src.indexOf('>', lt);
                i = de < 0 ? n : de + 1;
                continue;
            }
            // 闭合标签
            if (src.charAt(lt + 1) === '/') {
                var gt = src.indexOf('>', lt);
                if (gt < 0) break;
                var nd = stack.pop();
                if (nd) {
                    nd.contentEnd = lt;      // 内容到闭合标签前
                    nd.rawEnd = gt + 1;
                }
                if (!stack.length && nd) root = nd;
                i = gt + 1;
                continue;
            }

            // 开标签
            var m = /^<([^\s\/>]+)/.exec(src.slice(lt, lt + 300));
            if (!m) { i = lt + 1; continue; }
            var tag = m[1];

            // 找标签结束 '>'（跳过引号内的）
            var j = lt + 1 + tag.length;
            var q = null;
            while (j < n) {
                var ch = src.charAt(j);
                if (q) { if (ch === q) q = null; }
                else if (ch === '"' || ch === "'") q = ch;
                else if (ch === '>') break;
                j++;
            }
            if (j >= n) break;

            var selfClose = src.charAt(j - 1) === '/';
            var node = {
                tag: tag,
                attrs: parseAttrs(src.slice(lt + 1 + tag.length, selfClose ? j - 1 : j)),
                rawStart: lt,
                contentStart: j + 1,
                contentEnd: j + 1,
                rawEnd: j + 1,
                children: []
            };

            if (stack.length) stack[stack.length - 1].children.push(node);
            else if (!selfClose) { /* 根节点压栈 */ }

            if (selfClose) {
                if (!stack.length) root = node;
            } else {
                stack.push(node);
            }
            i = j + 1;
        }
        return root;
    }

    function kids(node, tag) {
        var out = [];
        if (!node) return out;
        for (var i = 0; i < node.children.length; i++)
            if (node.children[i].tag === tag) out.push(node.children[i]);
        return out;
    }
    function kid(node, tag) { return kids(node, tag)[0] || null; }

    function innerText(src, node) {
        if (!node) return '';
        return src.slice(node.contentStart, node.contentEnd).replace(/^\s+|\s+$/g, '');
    }
    function num(src, node) {
        var v = parseInt(innerText(src, node), 10);
        return isNaN(v) ? 0 : v;
    }

    // 元素的「整块文本」= 行首缩进 + 元素本身（不含末尾换行）
    function block(src, node) {
        var ls = src.lastIndexOf('\n', node.rawStart - 1);
        var start = ls < 0 ? 0 : ls + 1;
        return src.slice(start, node.rawEnd);
    }

    // ==================== 结构定位 ====================
    function locate(src) {
        var root = parse(src);
        if (!root) return null;
        var seq = root.tag === 'sequence' ? root : kid(root, 'sequence');
        if (!seq) return null;
        var media = kid(seq, 'media');
        if (!media) return null;
        return {
            root: root,
            seq: seq,
            media: media,
            video: kid(media, 'video'),
            audio: kid(media, 'audio')
        };
    }

    function timebase(src, seq) {
        var r = kid(seq, 'rate');
        var tb = r ? num(src, kid(r, 'timebase')) : 0;
        return tb > 0 ? tb : 25;
    }

    // 每帧 ticks：优先用「未变速」样本反推（变速片段的 pproTicks 与 in 不同域）
    var TICKS_PER_SEC = 254016000000;
    function ticksPerFrameOf(src, seq, tracks) {
        for (var i = 0; i < tracks.length; i++) {
            var cis = kids(tracks[i], 'clipitem');
            for (var j = 0; j < cis.length; j++) {
                var ci = cis[j];
                if (hasTimeRemap(src, ci)) continue;   // 变速片段跳过
                var inV = num(src, kid(ci, 'in'));
                var pt = num(src, kid(ci, 'pproTicksIn'));
                if (inV > 0 && pt > 0) {
                    var r = pt / inV;
                    if (r > 1e7 && r < 1e12) return r;
                }
            }
        }
        return TICKS_PER_SEC / timebase(src, seq);
    }

    // 是否含变速（Time Remap）
    function hasTimeRemap(src, ci) {
        var fs = kids(ci, 'filter');
        for (var i = 0; i < fs.length; i++) {
            var e = kid(fs[i], 'effect');
            if (e && innerText(src, kid(e, 'name')) === 'Time Remap') return true;
        }
        return false;
    }

    // ==================== 负值边界（-1）解析 ====================
    // PR 导出的 XML 里，当片段边界与「同轨转场」重合时，会把该边界写成 -1：
    //   end=-1   → 真实 end   = 同轨相邻转场的 end
    //   start=-1 → 真实 start = 同轨相邻转场的 start
    // （实测 51.xml 四组全部命中，误差 0 帧）
    // 若没有转场，则用「out−in」推算时长；静帧（图片）则贴到序列边界。
    // 不处理这个，-1 会被当成真实帧号（永远排最前），导致合轨时错误覆盖。

    function pickTransition(trans, anchor, forEnd) {
        // forEnd: 找 t.end 最接近且 >= anchor 的转场
        // !forEnd: 找 t.start 最接近且 <= anchor 的转场
        var best = null, bestD = 1e18;
        for (var i = 0; i < trans.length; i++) {
            var t = trans[i];
            var d;
            if (forEnd) {
                if (t.end < anchor - 2) continue;
                d = Math.abs(t.end - anchor);
            } else {
                if (t.start > anchor + 2) continue;
                d = Math.abs(anchor - t.start);
            }
            if (d < bestD) { bestD = d; best = t; }
        }
        return best;
    }

    function resolveClip(src, ci, trans, seqStart, seqEnd) {
        var inf = clipInfo(src, ci);
        var rawS = innerText(src, kid(ci, 'start'));
        var rawE = innerText(src, kid(ci, 'end'));
        var sNeg = rawS.charAt(0) === '-';
        var eNeg = rawE.charAt(0) === '-';
        inf.rStart = inf.start;
        inf.rEnd = inf.end;
        inf.fixed = sNeg || eNeg;
        if (!inf.fixed) return inf;

        // dur = out − in，实测即使变速也是【时间轴帧】单位（与 start/end 同域）
        var dur = inf.outV - inf.inV;

        // 静帧（图片/叠加层）：无转场时贴序列边界
        if (inf.isImage) {
            inf.rStart = sNeg ? seqStart : inf.start;
            inf.rEnd = eNeg ? seqEnd : inf.end;
            return inf;
        }

        if (eNeg) {
            var t1 = pickTransition(trans, inf.start, true);
            inf.rEnd = t1 ? t1.end : (dur > 0 ? inf.start + dur : inf.start);
            inf.rStart = inf.start;
            return inf;
        }
        if (sNeg) {
            var t2 = pickTransition(trans, inf.end, false);
            inf.rStart = t2 ? t2.start : (dur > 0 ? inf.end - dur : inf.end);
            inf.rEnd = inf.end;
            return inf;
        }
        return inf;
    }

    // ==================== 片段信息 ====================
    var IMG_RE = /\.(png|jpe?g|tif|tiff|psd|gif|bmp|webp)$/i;

    function clipInfo(src, ci) {
        var nm = innerText(src, kid(ci, 'name'));
        var en = innerText(src, kid(ci, 'enabled'));
        return {
            node: ci,
            name: nm,
            start: num(src, kid(ci, 'start')),
            end: num(src, kid(ci, 'end')),
            inV: num(src, kid(ci, 'in')),
            outV: num(src, kid(ci, 'out')),
            ptIn: num(src, kid(ci, 'pproTicksIn')),
            ptOut: num(src, kid(ci, 'pproTicksOut')),
            remap: hasTimeRemap(src, ci),
            enabled: !(en === 'FALSE' || en === 'FAL' || en === '0' || en === 'NO'),
            isImage: IMG_RE.test(nm)
        };
    }

    // 判断一条轨是不是「装饰轨」（供界面给默认值，不是最终决策）
    function guessDecor(name, clips, wholeLen) {
        if (!clips.length) return { decor: false, why: '' };
        var imgN = 0, longN = 0;
        for (var i = 0; i < clips.length; i++) {
            var c = clips[i];
            if (c.isImage) imgN++;
            if (wholeLen > 0 && (c.end - c.start) >= wholeLen * 0.9) longN++;
        }
        if (imgN > 0) return { decor: true, why: '含图片素材' };
        if (longN > 0 && clips.length <= 2) return { decor: true, why: '单片段铺满全片' };
        if (/水印|调整图层|叠加|转场|transition|adjustment|watermark|overlay/i.test(name))
            return { decor: true, why: '名称特征' };
        return { decor: false, why: '' };
    }

    // ==================== 扫描（供界面展示） ====================
    function scan(text) {
        var L = locate(text);
        if (!L) return { error: '不是有效的 FCP XML（找不到 sequence/media）' };
        if (!L.video) return { error: 'XML 里没有 video 轨道' };

        var tracks = kids(L.video, 'track');
        var fps = timebase(text, L.seq);

        // 全片范围
        var wholeEnd = 0;
        for (var i = 0; i < tracks.length; i++) {
            var cs = kids(tracks[i], 'clipitem');
            for (var j = 0; j < cs.length; j++) {
                var e = num(text, kid(cs[j], 'end'));
                if (e > wholeEnd) wholeEnd = e;
            }
        }

        var out = [];
        for (var t = 0; t < tracks.length; t++) {
            var cis = kids(tracks[t], 'clipitem');
            var infos = [];
            for (var k = 0; k < cis.length; k++) infos.push(clipInfo(text, cis[k]));

            // 该轨的代表性名字：取出现次数最多的
            var cnt = {};
            for (var z = 0; z < infos.length; z++) {
                var nm = infos[z].name || '(无名)';
                cnt[nm] = (cnt[nm] || 0) + 1;
            }
            var topName = '', topC = -1;
            for (var key in cnt) if (cnt[key] > topC) { topC = cnt[key]; topName = key; }

            var disN = 0;
            for (var d = 0; d < infos.length; d++) if (!infos[d].enabled) disN++;

            var g = guessDecor(topName, infos, wholeEnd);

            out.push({
                index: t,
                label: 'V' + (t + 1),
                clipCount: infos.length,
                disabled: disN,
                sample: topName,
                sampleCount: topC,
                duration: infos.length ? (infos[infos.length - 1].end - infos[0].start) : 0,
                decor: g.decor,
                decorWhy: g.why,
                transitionCount: kids(tracks[t], 'transitionitem').length
            });
        }

        // 音频轨概况
        var aTracks = L.audio ? kids(L.audio, 'track') : [];
        var aClips = 0;
        for (var a = 0; a < aTracks.length; a++) aClips += kids(aTracks[a], 'clipitem').length;

        return {
            fps: fps,
            duration: wholeEnd,
            seqName: innerText(text, kid(L.seq, 'name')),
            tracks: out,
            audioTracks: aTracks.length,
            audioClips: aClips
        };
    }

    // ==================== 合轨核心 ====================
    // 语义（客户手工「逐轨向 V1 覆盖」的等价实现）：
    //   从最高轨往下，取「未被【上层轨】覆盖的部分」。
    //   关键：同一轨内的兄弟片段互不裁剪（转场处本就重叠，那是 PR 的表示方式）。
    // 返回 [{start,end,inV,outV,name,node,clipped,sentinel}]
    function merge(text, tracks, keepIdx, ctx) {
        // 优先权：轨道序号大的在上层
        var order = keepIdx.slice().sort(function (a, b) { return b - a; });
        var upper = [];        // 仅累积「更上层」的占用区间
        var res = [];

        function overlap(a1, b1, a2, b2) { return !(b1 <= a2 || a1 >= b2); }

        for (var oi = 0; oi < order.length; oi++) {
            var ti = order[oi];
            var infos = resolveTrackClips(text, tracks[ti], ctx);
            var mine = [];     // 本轨占用区间

            for (var i = 0; i < infos.length; i++) {
                var inf = infos[i];
                if (!inf.enabled) continue;          // 规则1：跳过禁用片段

                var cs0 = inf.rStart, ce0 = inf.rEnd;
                if (ce0 <= cs0) continue;

                // 减去已被【上层】覆盖的部分
                var segs = [[cs0, ce0]];
                for (var c = 0; c < upper.length; c++) {
                    var us = upper[c][0], ue = upper[c][1];
                    var nxt = [];
                    for (var s = 0; s < segs.length; s++) {
                        var a = segs[s][0], b = segs[s][1];
                        if (!overlap(a, b, us, ue)) { nxt.push([a, b]); continue; }
                        if (a < us) nxt.push([a, us]);
                        if (b > ue) nxt.push([ue, b]);
                    }
                    segs = nxt;
                    if (!segs.length) break;
                }

                for (var g = 0; g < segs.length; g++) {
                    var sa = segs[g][0], sb = segs[g][1];
                    if (sb <= sa) continue;
                    var trimmed = (sa !== cs0 || sb !== ce0);
                    // 前缀被上层裁掉多少帧 → in/out 同步平移（时间轴帧域）
                    var off = sa - cs0;
                    var newIn = inf.inV + off;
                    var newOut = newIn + (sb - sa);
                    res.push({
                        start: sa,
                        end: sb,
                        srcStart: cs0,
                        srcEnd: ce0,
                        inV: trimmed ? newIn : inf.inV,
                        outV: trimmed ? newOut : inf.outV,
                        origIn: inf.inV,
                        origOut: inf.outV,
                        ptIn: inf.ptIn,
                        ptOut: inf.ptOut,
                        name: inf.name,
                        node: inf.node,
                        clipped: trimmed,
                        sentinel: inf.fixed,
                        needWrite: trimmed || inf.fixed
                    });
                }
                mine.push([cs0, ce0]);
            }
            // 本轨区间并入「上层集合」，供更低轨使用
            for (var m = 0; m < mine.length; m++) upper.push(mine[m]);
        }
        res.sort(function (x, y) {
            if (x.start !== y.start) return x.start - y.start;
            return x.end - y.end;
        });
        return res;
    }

    // 解析一条轨上所有片段的真实边界（展开 -1 占位符）
    function resolveTrackClips(text, track, ctx) {
        var cis = kids(track, 'clipitem');
        var trans = [];
        var tts = kids(track, 'transitionitem');
        for (var i = 0; i < tts.length; i++) {
            trans.push({
                start: num(text, kid(tts[i], 'start')),
                end: num(text, kid(tts[i], 'end'))
            });
        }
        var out = [];
        for (var j = 0; j < cis.length; j++) {
            out.push(resolveClip(text, cis[j], trans, ctx.seqStart, ctx.seqEnd));
        }
        // 部分交的 -1 需要依据「同轨邻居」补齐：
        // 若 end=-1 但没找到转场，用下一个片段的 start 作为边界
        for (var k = 0; k < out.length; k++) {
            var c = out[k];
            if (!c.fixed) continue;
            var rawE = innerText(text, kid(c.node, 'end'));
            var rawS = innerText(text, kid(c.node, 'start'));
            if (rawE.charAt(0) === '-') {
                // 找同轨上 start 大于本片段 start 的紧邻片段
                var nx = null;
                for (var q = 0; q < out.length; q++) {
                    if (out[q] === c) continue;
                    if (out[q].rStart > c.rStart) {
                        if (!nx || out[q].rStart < nx.rStart) nx = out[q];
                    }
                }
                if (c.rEnd <= c.rStart && nx) c.rEnd = nx.rStart;
            }
            if (rawS.charAt(0) === '-') {
                if (c.rEnd <= c.rStart) c.rStart = 0;
            }
        }
        return out;
    }

    // 改写片段块。
    // 边界展开（只改 start/end）：用于 -1 占位符，源映射不变
    // 裁剪重算：in/out 按偏移平移，pproTicks 用【片段自身源帧速率】换算
    //   （变速片段每帧 ticks 与常规不同，不能用统一值）
    function writeBounds(blk, start, end) {
        blk = blk.replace(/<start>(-?\d+)<\/start>/, '<start>' + start + '</start>');
        blk = blk.replace(/<end>(-?\d+)<\/end>/, '<end>' + end + '</end>');
        return blk;
    }

    function writeTrim(blk, start, end, inV, outV, ptIn, ptOut, oldIn, oldOut) {
        blk = writeBounds(blk, start, end);
        blk = blk.replace(/<in>(-?\d+)<\/in>/, '<in>' + inV + '</in>');
        blk = blk.replace(/<out>(-?\d+)<\/out>/, '<out>' + outV + '</out>');

        // 片段自身的「每源帧 ticks」（变速时与时间轴帧率不同）
        var rate = 0;
        if (oldOut > oldIn && ptOut > ptIn) rate = (ptOut - ptIn) / (oldOut - oldIn);
        if (!(rate > 0)) rate = 0;

        if (rate > 0 && ptIn > 0) {
            blk = blk.replace(/<pproTicksIn>(-?\d+)<\/pproTicksIn>/,
                '<pproTicksIn>' + Math.round(ptIn + (inV - oldIn) * rate) + '</pproTicksIn>');
            blk = blk.replace(/<pproTicksOut>(-?\d+)<\/pproTicksOut>/,
                '<pproTicksOut>' + Math.round(ptIn + (outV - oldIn) * rate) + '</pproTicksOut>');
        }
        return blk;
    }

    // ==================== 主流程 ====================
    // opts: { skipTracks: [0-based 轨索引], dropTransitions: bool }
    function flatten(text, opts) {
        opts = opts || {};
        var skip = opts.skipTracks || [];
        var skipSet = {};
        for (var s = 0; s < skip.length; s++) skipSet[skip[s]] = true;

        var L = locate(text);
        if (!L) return { ok: false, msg: '不是有效的 FCP XML' };
        if (!L.video) return { ok: false, msg: 'XML 里没有 video 轨道' };

        var tracks = kids(L.video, 'track');
        if (!tracks.length) return { ok: false, msg: '没有视频轨' };

        var tpf = ticksPerFrameOf(text, L.seq, tracks);
        var fps = timebase(text, L.seq);

        // 参与合轨的轨
        var keepIdx = [];
        for (var i = 0; i < tracks.length; i++) if (!skipSet[i]) keepIdx.push(i);
        if (!keepIdx.length) return { ok: false, msg: '至少要保留一条视频轨才能合轨' };

        // 序列时间范围（供静帧/无转场的 -1 贴边）
        var seqStart = 0, seqEnd = 0;
        for (var st = 0; st < tracks.length; st++) {
            var scs = kids(tracks[st], 'clipitem');
            for (var sj = 0; sj < scs.length; sj++) {
                var sv = num(text, kid(scs[sj], 'end'));
                if (sv > seqEnd) seqEnd = sv;
            }
        }
        var ctx = { seqStart: seqStart, seqEnd: seqEnd };

        var merged = merge(text, tracks, keepIdx, ctx);

        // 统计被删的禁用片段
        var droppedDisabled = 0, droppedClips = 0, keptTransitions = 0;
        for (var t = 0; t < tracks.length; t++) {
            var cis = kids(tracks[t], 'clipitem');
            for (var c = 0; c < cis.length; c++) {
                var inf = clipInfo(text, cis[c]);
                if (!inf.enabled) { droppedDisabled++; continue; }
                if (skipSet[t]) droppedClips++;
            }
        }

        // ---- 重建 video ----
        var vOpen = text.slice(L.video.rawStart, L.video.contentStart);
        var vClose = text.slice(L.video.contentEnd, L.video.rawEnd);

        // video 里非 track 的子元素（format 等）原样保留
        var videoHead = '';
        for (var vi = 0; vi < L.video.children.length; vi++) {
            var ch = L.video.children[vi];
            if (ch.tag === 'track') continue;
            videoHead += '\n' + block(text, ch);
        }

        var newTracks = '';
        // V1（第一条轨）承载合轨结果
        var t0 = tracks[0];
        var t0Open = text.slice(t0.rawStart, t0.contentStart);
        var t0Close = text.slice(t0.contentEnd, t0.rawEnd);

        var body = '';
        for (var mi = 0; mi < merged.length; mi++) {
            var m = merged[mi];
            var blk = block(text, m.node);
            if (m.clipped) {
                // 被上层裁剪：in/out 按偏移平移，pproTicks 按源帧速率重算
                blk = writeTrim(blk, m.start, m.end, m.inV, m.outV,
                    m.ptIn, m.ptOut, m.origIn, m.origOut);
            } else if (m.sentinel) {
                // -1 占位符展开：只写回真实边界（源映射不变）
                blk = writeBounds(blk, m.start, m.end);
            }
            body += '\n' + blk;
        }

        // 参与轨上的转场原样保留（按时间插入）
        var transBlocks = '';
        if (!opts.dropTransitions) {
            for (var ki = 0; ki < keepIdx.length; ki++) {
                var tt = kids(tracks[keepIdx[ki]], 'transitionitem');
                for (var x = 0; x < tt.length; x++) transBlocks += '\n' + block(text, tt[x]);
                keptTransitions += tt.length;
            }
        }

        // 轨内非 clipitem/transitionitem 的子元素（enabled/locked 等）保留
        var t0Rest = '';
        for (var r = 0; r < t0.children.length; r++) {
            var rc = t0.children[r];
            if (rc.tag === 'clipitem' || rc.tag === 'transitionitem') continue;
            t0Rest += '\n' + block(text, rc);
        }

        newTracks += '\n' + t0Open + body + (transBlocks ? transBlocks : '') + t0Rest + '\n' + t0Close;

        // 其余轨：清空片段，保留外壳与非片段子元素
        for (var ti = 1; ti < tracks.length; ti++) {
            var tr = tracks[ti];
            var open = text.slice(tr.rawStart, tr.contentStart);
            var close = text.slice(tr.contentEnd, tr.rawEnd);
            var rest = '';
            for (var q = 0; q < tr.children.length; q++) {
                var qc = tr.children[q];
                if (qc.tag === 'clipitem' || qc.tag === 'transitionitem') continue;
                rest += '\n' + block(text, qc);
            }
            newTracks += '\n' + open + rest + '\n' + close;
        }

        var newVideo = vOpen + videoHead + newTracks + '\n' +
            text.slice(L.video.contentEnd, L.video.rawEnd).replace(/^\s*/, '');

        // 用偏移替换（从后往前替换，避免偏移错乱）
        var text1 = text.slice(0, L.video.rawStart) + newVideo +
            text.slice(L.video.rawEnd);

        // ---- 清空音频（规则3）----
        var droppedAudio = 0;
        var L2 = locate(text1);
        if (L2 && L2.audio) {
            var aTracks = kids(L2.audio, 'track');
            var newAudio = text1.slice(L2.audio.rawStart, L2.audio.contentStart);
            for (var ai = 0; ai < L2.audio.children.length; ai++) {
                var ac = L2.audio.children[ai];
                if (ac.tag !== 'track') { newAudio += '\n' + block(text1, ac); continue; }
                var ao = text1.slice(ac.rawStart, ac.contentStart);
                var acl = text1.slice(ac.contentEnd, ac.rawEnd);
                var arest = '';
                for (var aq = 0; aq < ac.children.length; aq++) {
                    var aqc = ac.children[aq];
                    if (aqc.tag === 'clipitem' || aqc.tag === 'transitionitem') {
                        if (aqc.tag === 'clipitem') droppedAudio++;
                        continue;
                    }
                    arest += '\n' + block(text1, aqc);
                }
                newAudio += '\n' + ao + arest + '\n' + acl;
            }
            newAudio += '\n' + text1.slice(L2.audio.contentEnd, L2.audio.rawEnd).replace(/^\s*/, '');
            text1 = text1.slice(0, L2.audio.rawStart) + newAudio + text1.slice(L2.audio.rawEnd);
        }

        // ---- 重算 sequence duration（规则5 附带）----
        var L3 = locate(text1);
        if (L3) {
            var dNode = kid(L3.seq, 'duration');
            if (dNode) {
                var newDur = merged.length ? merged[merged.length - 1].end : 0;
                if (newDur > 0) {
                    var old = text1.slice(dNode.contentStart, dNode.contentEnd);
                    var replaced = text1.slice(0, dNode.contentStart) + newDur +
                        text1.slice(dNode.contentEnd);
                    text1 = replaced;
                    var _ = old;
                }
            }
        }

        // ---- 修复悬空素材引用（必须在所有结构改动之后）----
        var fx = fixDanglingFiles(text1, text);
        text1 = fx.text;

        return {
            ok: true,
            text: text1,
            fps: fps,
            stats: {
                mergedSegments: merged.length,
                droppedDisabled: droppedDisabled,
                droppedFromSkippedTracks: droppedClips,
                droppedAudio: droppedAudio,
                keptTracks: keepIdx.map(function (x) { return 'V' + (x + 1); }),
                skippedTracks: skip.map(function (x) { return 'V' + (x + 1); }),
                transitions: keptTransitions,
                duration: merged.length ? merged[merged.length - 1].end : 0,
                fixedFileRefs: fx.fixed,
                danglingLeft: fx.remaining
            }
        };
    }

    // ==================== 悬空素材引用修复 ====================
    // PR 的 XML 里同一素材「首次出现写完整定义，之后用 <file id="x"/> 引用」。
    // 若某素材的首个完整定义恰好在被删掉的轨上，保留轨上的引用就成了悬空引用，
    // 达芬奇会找不到素材。这里把悬空引用补全为完整定义（取自原始文档）。
    function extractFileDefs(src) {
        var defs = {};
        var re = /<file\s+id="([^"]+)"\s*>/g;
        var m;
        while ((m = re.exec(src))) {
            var id = m[1];
            if (defs[id]) continue;
            var close = src.indexOf('</file>', m.index);
            if (close < 0) continue;
            defs[id] = { start: m.index, end: close + 7 };
        }
        return defs;
    }

    // 把文本块重排缩进（首行去空白，其余行按公共缩进对齐到 indent）
    function reindent(blockTxt, indent) {
        var lines = blockTxt.split('\n');
        var min = -1;
        for (var i = 1; i < lines.length; i++) {
            if (!lines[i].replace(/[\s]/g, '')) continue;
            var l = lines[i].length - lines[i].replace(/^[ \t]*/, '').length;
            if (min < 0 || l < min) min = l;
        }
        if (min < 0) min = 0;
        var out = [lines[0].replace(/^[ \t]*/, '')];
        for (var j = 1; j < lines.length; j++) {
            if (!lines[j].replace(/[\s]/g, '')) { out.push(''); continue; }
            out.push(indent + lines[j].slice(min));
        }
        return out.join('\n');
    }

    function fixDanglingFiles(outText, origText) {
        var outDefs = {};
        var re = /<file\s+id="([^"]+)"\s*>/g;
        var m;
        while ((m = re.exec(outText))) outDefs[m[1]] = true;

        var origDefs = extractFileDefs(origText);

        var refs = [];
        var re2 = /<file\s+id="([^"]+)"\s*\/>/g;
        while ((m = re2.exec(outText))) {
            refs.push({ id: m[1], index: m.index, len: m[0].length });
        }

        var seen = {}, todo = [];
        for (var i = 0; i < refs.length; i++) {
            var r = refs[i];
            if (outDefs[r.id] || seen[r.id]) continue;
            seen[r.id] = true;
            if (!origDefs[r.id]) continue;
            todo.push(r);
        }

        var fixed = 0;
        for (var j = todo.length - 1; j >= 0; j--) {
            var t = todo[j];
            var od = origDefs[t.id];
            if (!od) continue;
            var blk = origText.slice(od.start, od.end);
            var ls = outText.lastIndexOf('\n', t.index - 1);
            var indent = ls < 0 ? '' : outText.slice(ls + 1, t.index);
            if (!/^[ \t]*$/.test(indent)) indent = '';
            blk = reindent(blk, indent);
            outText = outText.slice(0, t.index) + blk + outText.slice(t.index + t.len);
            fixed++;
        }

        var still = 0;
        var outDefs2 = {};
        re.lastIndex = 0;
        while ((m = re.exec(outText))) outDefs2[m[1]] = true;
        re2.lastIndex = 0;
        while ((m = re2.exec(outText))) if (!outDefs2[m[1]]) still++;

        return { text: outText, fixed: fixed, remaining: still };
    }

    // ==================== 文件级入口 ====================
    function convertFile(srcFile, outFile, opts) {
        if (!fs) return { ok: false, msg: '当前环境没有文件系统权限' };
        try {
            if (!fs.existsSync(srcFile)) return { ok: false, msg: '源文件不存在' };
            var raw = fs.readFileSync(srcFile, 'utf8');
            var r = flatten(raw, opts);
            if (!r.ok) return r;
            if (!outFile) {
                outFile = srcFile.replace(/\.xml$/i, '') + '_调色.xml';
            }
            fs.writeFileSync(outFile, r.text, 'utf8');
            return { ok: true, out: outFile, stats: r.stats, fps: r.fps };
        } catch (e) {
            return { ok: false, msg: e.message || String(e) };
        }
    }

    var API = {
        parse: parse,
        scan: scan,
        flatten: flatten,
        convertFile: convertFile,
        version: '1.0.0'
    };

    if (typeof window !== 'undefined') window.__vhFlatten = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
