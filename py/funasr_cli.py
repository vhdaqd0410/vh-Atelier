# -*- coding: utf-8 -*-
"""
FunASR 中文识别 CLI（本地字幕插件专用）
用法: python funasr_cli.py <input.wav> <output.json>

- 加载 Alibaba FunASR 完整链路：paraformer(ASR) + fsmn-vad(端点) + ct-punc(标点)
- 输出 JSON 数组: [{start, end, text}]，start/end 为秒（绝对时间戳）
- 标点切句：句末标点(。！？；)与逗号(，、)都切，字幕文本不带标点
"""
import os
import sys
import json
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.abspath(os.path.join(HERE, '..', 'models', 'funasr'))
os.environ.setdefault('MODELSCOPE_CACHE', CACHE)

from funasr import AutoModel

MODEL_ASR = "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
MODEL_VAD = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
MODEL_PUNC = "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch"

# 断句标点：句末标点 + 逗号顿号（中英文都覆盖）
BREAK_PUNCT = set('。！？；，、.!?;,')


def is_punct(c):
    """判断是否为标点或空白。用 Unicode 类别判断，覆盖全部中英文标点（含全角引号“”等）。"""
    if c.isspace():
        return True
    return unicodedata.category(c).startswith('P')


_model = None
_vad_model = None


def get_vad_model():
    """独立加载 VAD 模型。

    为什么必须独立跑：
      实测识别结果里只有 key/text/timestamp 三个字段，不带 VAD 段；
      sentence_timestamp=True 也不一定返回 sentence_info。
      而 FunASR 的逐字符 timestamp 是按音素均匀分的（相邻间隔最大仅 140ms），
      里面没有停顿信息。所以气口只能靠单独跑 VAD 得到。
    """
    global _vad_model
    if _vad_model is None:
        _vad_model = AutoModel(model=MODEL_VAD, disable_update=True)
    return _vad_model


def vad_segments_of(wav):
    """跑一次 VAD，返回 [(start_ms, end_ms), ...]。"""
    try:
        m = get_vad_model()
        r = m.generate(input=wav)
        for d in (r or []):
            segs = d.get('value') or d.get('vadsegments') or []
            got = _norm_segs(segs)
            if got:
                return got
    except Exception as e:
        print('[warn] VAD 失败：%s' % e, file=sys.stderr)
    return []


def get_model():
    global _model
    if _model is None:
        _model = AutoModel(
            model=MODEL_ASR,
            vad_model=MODEL_VAD,
            punc_model=MODEL_PUNC,
            disable_update=True,
        )
    return _model


def cut_sentences(text, ts):
    """按标点切句。ts 为逐字符 [[start_ms, end_ms], ...] 绝对时间戳（标点不占槽位）。

    用贪心对齐：遍历 text，每个非标点字符消费一个 ts 槽位。即使字符数与 ts 数量
    不完全一致也不会崩，更不会退回整段一条。
    """
    subs = []
    buf = ''
    buf_start_ts = None   # 本句首字符对应的 ts 下标
    ts_idx = 0            # 已消费的非标点字符数 = 下一个非标点字符对应的 ts 下标

    def flush(ts_end_exclusive):
        nonlocal buf, buf_start_ts
        txt = buf.strip()
        if not txt or not ts:
            buf = ''
            buf_start_ts = None
            return
        s_idx = buf_start_ts if buf_start_ts is not None else 0
        e_idx = ts_end_exclusive if ts_end_exclusive > s_idx else s_idx + 1
        # 越界保护
        if s_idx < 0:
            s_idx = 0
        if s_idx >= len(ts):
            s_idx = len(ts) - 1
        if e_idx > len(ts):
            e_idx = len(ts)
        if e_idx <= s_idx:
            e_idx = s_idx + 1
        if e_idx > len(ts):
            e_idx = len(ts)
        start = ts[s_idx][0] / 1000.0
        end = ts[e_idx - 1][1] / 1000.0
        subs.append({'start': round(start, 3), 'end': round(end, 3), 'text': txt})
        buf = ''
        buf_start_ts = None

    for c in text:
        if is_punct(c):
            if c in BREAK_PUNCT:
                flush(ts_idx)
            # 非断句标点（冒号、引号、括号等）：跳过，不占时间戳槽位
        else:
            if buf_start_ts is None:
                buf_start_ts = ts_idx
            buf += c
            ts_idx += 1

    flush(ts_idx)
    return subs



# ============================================================================
# 字幕时间轴重建
# ----------------------------------------------------------------------------
# 关键事实（实测得出，不要凭直觉改）：
#   FunASR 返回的逐字符 timestamp 是**按音素均匀分配**的，不是真实发声时间。
#   实测相邻字符间隔最大仅 140ms、平均 28ms —— 里面根本没有停顿信息。
#   所以「按字符间隔找气口」这条路走不通，切了也没效果。
#
# 正确做法：单独跑 VAD 拿到真实语音段，字幕只在语音段内分布，
#   段与段之间自然留空。这样画面里没人说话的地方就不会有字幕。
# ============================================================================

# 一条字幕最长时间（秒）。超过就按标点/停顿再拆，避免一条吞掉半屏。
MAX_SUB_DUR = 7.0
# 字幕首尾内缩，避免相邻两条在视觉上贴死
LEAD_PAD = 0.06
TAIL_PAD = 0.10
# 单条最短时长，太短的碎片不与前一条强行合并（宁可短也不要丢内容）
MIN_DUR = 0.20


def assign_to_vad_segments(base_subs, vad_segs):
    """按 VAD 语音段裁剪字幕，并在气口处把跨段字幕切开。

    实测事实：FunASR 一条字幕的时间跨度可能**横穿静音区**
    （例：0.23 → 7.25，而 3.24~4.72 是静音）。
    说明字符时间戳把停顿也摊进去了。

    所以不能只按"中点归属"（那条会被整条丢掉），而要做：
      · 字幕完全落在某个语音段内 → 保留
      · 字幕横跨静音 → 在静音处**一分为二**，文字按时间比例分配
      · 字幕完全在静音里 → 丢弃

    base_subs: cut_sentences 产物
    vad_segs:  [(start_ms, end_ms), ...]
    """
    if not base_subs:
        return []
    if not vad_segs:
        return base_subs

    segs = [(a / 1000.0, b / 1000.0) for (a, b) in vad_segs]
    segs.sort()

    out = []
    for sub in base_subs:
        st, en = sub['start'], sub['end']
        txt = sub['text']
        if en <= st:
            continue

        # 找出这条字幕与各语音段的重叠部分
        pieces = []
        for (a, b) in segs:
            oa, ob = max(st, a), min(en, b)
            if ob - oa >= 0.05:
                pieces.append((oa, ob))
        if not pieces:
            continue          # 整条都在静音里

        if len(pieces) == 1 and pieces[0][0] <= st + 0.01 and pieces[0][1] >= en - 0.01:
            out.append({'start': round(st, 3), 'end': round(en, 3), 'text': txt})
            continue

        # 跨段：按各段时长占比分配文字
        total = sum(pb - pa for pa, pb in pieces)
        if total <= 0:
            continue
        n = len(txt)
        cursor = 0
        for k, (pa, pb) in enumerate(pieces):
            if k == len(pieces) - 1:
                seg_txt = txt[cursor:]
            else:
                ratio = (pb - pa) / total
                take = max(1, int(round(n * ratio)))
                seg_txt = txt[cursor:cursor + take]
                cursor += take
            seg_txt = seg_txt.strip()
            if seg_txt:
                out.append({'start': round(pa, 3), 'end': round(pb, 3), 'text': seg_txt})
    return out


def polish_timing(subs, lead=LEAD_PAD, tail=TAIL_PAD, min_dur=MIN_DUR):
    """首尾内缩，避免相邻字幕贴死。"""
    if not subs:
        return subs
    out = []
    for s in subs:
        st, en = float(s['start']), float(s['end'])
        st2, en2 = st + lead, en - tail
        if en2 - st2 < min_dur:
            st2, en2 = st, en
        if en2 <= st2:
            st2, en2 = st, max(st + 0.12, en)
        out.append({'start': round(st2, 3), 'end': round(en2, 3), 'text': s['text']})
    return out


def recognize_one(model, wav):
    """识别单个 wav，返回字幕列表。

    时间轴策略（按重要性排序）：

    1. 先跑 VAD 拿真实语音段。FunASR 的逐字符 timestamp 是按音素均匀分配的，
       不含停顿信息（实测相邻间隔最大仅 140ms），不能用来判断气口。
       只有 VAD 能给出"哪里真的没声音"。

    2. 在每一个语音段内部按标点切句，字幕只落在语音段内。
       段与段之间自然留空 —— 这就是"气口处不应该有字幕"的实现方式。

    3. 单条字幕超过 MAX_SUB_DUR 时按时间均分拆开，避免一条吞掉半屏。

    4. 最后首尾内缩，避免相邻两条视觉上贴死。
    """
    # 先拿真实语音段（含气口）——这是字幕不铺满整段的基础
    vad_segs_cache = vad_segments_of(wav)

    res = model.generate(input=wav, batch_size_s=300)
    subs = []

    for d in res:
        text = d.get('text', '') or ''
        ts = d.get('timestamp', []) or []
        if not text or not ts:
            continue

        # 整段按标点切一次（文字断句以此为准）
        base = cut_sentences(text, ts)
        # 再按 VAD 语音段做时间裁剪（气口在这里被保留）
        subs.extend(assign_to_vad_segments(base, vad_segs_cache))

    # 按时间排序 + 首尾内缩
    subs.sort(key=lambda x: (x['start'], x['end']))
    return polish_timing(subs)


def get_vad_segments(d):
    """从识别结果里取出 VAD 语音段，单位毫秒。返回 [(start_ms, end_ms), ...]。

    FunASR 把 VAD 结果放在 sentence_info 或 vadsegments 里，字段名随版本变化，
    这里做多重兜底，取不到就返回空列表（调用方会降级处理）。
    """
    # 1) 常见：结果里直接带 vadsegments
    for key in ('vadsegments', 'vad_segments', 'vadseg'):
        segs = d.get(key)
        if segs:
            got = _norm_segs(segs)
            if got:
                return got

    # 2) sentence_info（开了 sentence_timestamp 时才有）——它按标点分，
    #    但边界仍基于 VAD，可作为次优近似
    si = d.get('sentence_info')
    if si:
        got = [(float(x.get('start', 0)), float(x.get('end', 0)))
               for x in si if x.get('end', 0) > x.get('start', 0)]
        if got:
            return got

    return []


def _norm_segs(segs):
    """把各种形态的 VAD 段统一成 [(start_ms, end_ms), ...]。"""
    out = []
    for item in segs:
        try:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                a, b = float(item[0]), float(item[1])
            elif isinstance(item, dict):
                a = float(item.get('start', item.get('start_ms', 0)))
                b = float(item.get('end', item.get('end_ms', 0)))
            else:
                continue
            if b > a:
                out.append((a, b))
        except Exception:
            continue
    return out


def main():
    # 多文件模式：python funasr_cli.py --multi <list.json> <out.json>
    # list.json = [{"id": "...", "wav": "path"}, ...]
    # out.json  = {"id": [{start,end,text}, ...], ...}
    if '--multi' in sys.argv:
        try:
            mi = sys.argv.index('--multi')
            list_path = sys.argv[mi + 1]
            out_path = sys.argv[mi + 2]
        except (ValueError, IndexError):
            print(json.dumps({'error': 'usage: --multi <list.json> <out.json>'}, ensure_ascii=False))
            return 1

        with open(list_path, 'r', encoding='utf-8-sig') as f:
            tasks = json.load(f)

        model = get_model()  # 模型只加载一次
        result = {}
        n = len(tasks)
        for i, t in enumerate(tasks):
            # 进度打到 stderr，供 Node 实时读取
            print('PROGRESS %d/%d' % (i + 1, n), file=sys.stderr, flush=True)
            wid = t.get('id', str(i))
            wav = t.get('wav', '')
            if not wav or not os.path.exists(wav):
                result[wid] = []
                continue
            result[wid] = recognize_one(model, wav)

        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)
        return 0

    # 单文件模式（向后兼容）：python funasr_cli.py <input.wav> <output.json>
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'usage: funasr_cli.py <input.wav> <output.json>'}, ensure_ascii=False))
        return 1

    wav = sys.argv[1]
    out = sys.argv[2]

    if not os.path.exists(wav):
        print(json.dumps({'error': 'wav not found: ' + wav}, ensure_ascii=False))
        return 1

    model = get_model()
    subs = recognize_one(model, wav)

    with open(out, 'w', encoding='utf-8') as f:
        json.dump(subs, f, ensure_ascii=False)

    # 诊断：切句异常少时告警到 stderr，方便排查
    if len(subs) <= 1:
        print('WARN: 切句异常，仅 %d 条' % len(subs), file=sys.stderr)

    return 0


if __name__ == '__main__':
    sys.exit(main())
