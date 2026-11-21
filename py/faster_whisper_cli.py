# -*- coding: utf-8 -*-
"""
faster-whisper 字幕识别 CLI（vh-Atelier 专用）

为什么换掉原来的 whisper.cpp：
  旧实现直接把 whisper 生成的 SRT 写回时间轴，不做任何后处理。
  结果是字幕首尾相接铺满整段，画面里没人说话的地方也有字。

本实现的关键：用 word_timestamps 拿到**每个词的真实起止时间**，
再按"沉默间隙"把词重新组织成字幕。这样：
  · 有停顿的地方自然断开
  · 每条字幕的起止贴合真实发声
  · 语速快也不会挤成一条

用法：
  python faster_whisper_cli.py --wav <音频> --out <结果.json>
          [--model medium] [--lang en|zh|auto]
          [--gap 0.45] [--max-dur 7.0] [--max-chars 42]
          [--device auto] [--compute-type float16|int8]

输出 JSON：
  {"ok":true,"lang":"en","segments":[{start,end,text}...],"words":[...]}
"""
import argparse
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))


def emit_result(args, obj):
    """统一出口：成功失败都写 --out 文件，保证 JS 侧一定能读到原因。"""
    try:
        out = getattr(args, "out", "") or ""
        if out:
            d = os.path.dirname(os.path.abspath(out))
            if d and not os.path.isdir(d):
                os.makedirs(d, exist_ok=True)
            with open(out, "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False)
    except Exception as e:
        log("[warn] 写输出文件失败：%s" % e)
    try:
        print(json.dumps(obj, ensure_ascii=False))
    except Exception:
        pass


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def normalize_text(s):
    """压掉多余空白，保持原文（不做翻译、不做大小写改写）。"""
    s = re.sub(r"[ \t]+", " ", str(s or "")).strip()
    # 去掉首尾的孤立标点空格
    s = re.sub(r"\s+([,.;:!?])", r"\1", s)
    return s


# 句末/断句标点：英文和中文都要
SENT_END = set(".!?。！？…")
SOFT_BREAK = set(",;:，、；：")


def build_segments(words, gap=0.45, max_dur=7.0, max_chars=42, soft_gap=0.28):
    """把词序列重新组织成字幕。

    分组规则（按优先级）：
      1. 与上一个词的间隔 >= gap          → 强制断句（这是气口）
      2. 一句话已经很长（时长或字符数超限）→ 在标点处断，否则在最近处断
      3. 遇到句末标点                      → 断句
      4. 软停顿（>= soft_gap）且已经够长   → 断句

    这样既尊重真实停顿，又保证不会出现超长条。
    """
    segments = []
    cur = []

    def flush():
        if not cur:
            return
        text = normalize_text(" ".join(w["word"] for w in cur))
        if text:
            segments.append({
                "start": round(cur[0]["start"], 3),
                "end": round(cur[-1]["end"], 3),
                "text": text,
            })
        cur.clear()

    for i, w in enumerate(words):
        if cur:
            prev = cur[-1]
            silence = w["start"] - prev["end"]
            cur_dur = prev["end"] - cur[0]["start"]
            cur_chars = sum(len(x["word"]) for x in cur)

            # 1) 真实气口：足够长的静音，直接断开
            if silence >= gap:
                flush()

            # 2) 超长：时长或字符数到上限
            elif cur_dur >= max_dur or cur_chars >= max_chars:
                flush()

            # 3) 软停顿 + 已经偏长
            elif silence >= soft_gap and (cur_dur >= max_dur * 0.6 or cur_chars >= max_chars * 0.6):
                flush()

        cur.append(w)

        # 4) 句末标点：断句
        wd = (w["word"] or "").strip()
        if wd and wd[-1] in SENT_END:
            flush()

    flush()
    return segments


def merge_tiny(segments, min_dur=0.35, min_chars=2):
    """把过短的碎片并入相邻条（不跨气口）。

    短到一闪而过的字幕没有阅读价值，合并比保留更合理；
    但如果前后有真实气口，就不合并，避免把气口吃掉。
    """
    if not segments:
        return segments
    out = []
    for seg in segments:
        if (out and
                (seg["end"] - seg["start"]) < min_dur and
                len(seg["text"]) < min_chars and
                (seg["start"] - out[-1]["end"]) < 0.25):
            # 并到上一条
            prev = out[-1]
            prev["end"] = seg["end"]
            prev["text"] = normalize_text(prev["text"] + " " + seg["text"])
        else:
            out.append(dict(seg))
    return out


def fallback_from_segments(raw_segments):
    """没有词级时间戳时的退化路径：直接用句级结果。"""
    out = []
    for s in raw_segments:
        text = normalize_text(s.get("text"))
        if text:
            out.append({
                "start": round(float(s.get("start", 0)), 3),
                "end": round(float(s.get("end", 0)), 3),
                "text": text,
            })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="medium")
    ap.add_argument("--lang", default="auto")
    ap.add_argument("--gap", type=float, default=0.45, help="静音断句阈值（秒）")
    ap.add_argument("--max-dur", type=float, default=7.0, help="单条最长时长（秒）")
    ap.add_argument("--max-chars", type=int, default=42, help="单条最长字符数")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute-type", default="")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        emit_result(args, {"ok": False, "error": "faster-whisper 未安装：%s" % e,
                           "hint": "组件未装好，请在「组件」面板点在线下载，或检查 site-packages"})
        return

    # 模型路径：优先用插件自带目录（models/faster-whisper/<model>），
    # 其次才让 faster-whisper 自己去全局缓存找。
    # 这样整个插件目录可以搬走，也便于离线分发。
    local_model = os.path.join(HERE, "..", "models", "faster-whisper", args.model)
    local_model = os.path.abspath(local_model)
    model_ref = local_model if os.path.isdir(local_model) else args.model

    # 设备与精度：有 GPU 就用 float16，否则 int8（CPU 上快很多）
    device = args.device
    compute_type = args.compute_type
    if device == "auto":
        device = "cuda"
    if not compute_type:
        compute_type = "float16" if device == "cuda" else "int8"

    # 先探测 CUDA 能不能真用。
    # 踩过的坑：cublas64_12.dll 缺失时，异常发生在构造模型之前，
    # 只 try 住 WhisperModel(...) 捕获不到，会直接失败而不是降级。
    if device == "cuda":
        cuda_ok, cuda_why = False, ""
        try:
            import ctranslate2 as _ct2
            n = _ct2.get_cuda_device_count()
            if n <= 0:
                cuda_why = "未检测到可用 CUDA 设备"
            else:
                cuda_ok = True
        except Exception as e:
            cuda_why = str(e)[:160]
        if not cuda_ok:
            log("[warn] CUDA 不可用（%s），自动改用 CPU" % cuda_why)
            print(json.dumps({"info": "cuda_unavailable", "reason": cuda_why,
                              "fallback": "cpu"}, ensure_ascii=False))
            device, compute_type = "cpu", "int8"

    try:
        model = WhisperModel(model_ref, device=device, compute_type=compute_type)
    except Exception as e:
        if device != "cpu":
            # GPU 加载失败就退回 CPU
            log("[warn] %s 加载失败：%s，改用 CPU int8" % (device, e))
            print(json.dumps({"info": "load_fallback", "reason": str(e)[:160],
                              "fallback": "cpu"}, ensure_ascii=False))
            device, compute_type = "cpu", "int8"
            model = WhisperModel(model_ref, device=device, compute_type=compute_type)
        else:
            emit_result(args, {"ok": False, "error": "模型加载失败：%s" % e,
                               "model": model_ref})
            return

    lang = None if args.lang in ("auto", "", None) else args.lang

    try:
        segments_iter, info = model.transcribe(
            args.wav,
            language=lang,
            word_timestamps=True,          # 关键：要词级时间
            vad_filter=True,               # 关键：用 VAD 切掉静音
            vad_parameters=dict(
                min_silence_duration_ms=int(args.gap * 1000),
                speech_pad_ms=100,
            ),
            beam_size=5,
            condition_on_previous_text=False,   # 防幻觉
        )
        raw = list(segments_iter)
    except Exception as e:
        emsg = str(e)
        # 显存不足 / CUDA 库问题：降级 CPU 再试一次，不要直接失败
        gpu_related = any(k in emsg.lower() for k in
                          ["cuda", "cublas", "cudnn", "out of memory", "gpu", "device"])
        if device != "cpu" and gpu_related:
            log("[warn] GPU 推理失败（%s），改用 CPU 重试" % emsg[:120])
            print(json.dumps({"info": "transcribe_fallback", "reason": emsg[:160],
                              "fallback": "cpu"}, ensure_ascii=False))
            device, compute_type = "cpu", "int8"
            try:
                model = WhisperModel(model_ref, device="cpu", compute_type="int8")
                segments_iter, info = model.transcribe(
                    args.wav, language=lang, word_timestamps=True, vad_filter=True,
                    vad_parameters=dict(
                        min_silence_duration_ms=int(args.gap * 1000),
                        speech_pad_ms=100),
                    beam_size=5, condition_on_previous_text=False)
                raw = list(segments_iter)
            except Exception as e2:
                emit_result(args, {"ok": False,
                                   "error": "识别失败（CPU 重试也失败）：%s" % e2})
                return
        else:
            emit_result(args, {"ok": False, "error": "识别失败：%s" % e,
                               "device": device})
            return

    # 收集词级时间
    words = []
    for seg in raw:
        for w in (getattr(seg, "words", None) or []):
            wd = (w.word or "").strip()
            if not wd:
                continue
            words.append({
                "word": wd,
                "start": float(w.start),
                "end": float(w.end),
            })

    if words:
        segments = build_segments(words, gap=args.gap,
                                  max_dur=args.max_dur, max_chars=args.max_chars)
        segments = merge_tiny(segments)
    else:
        segments = fallback_from_segments([{"start": s.start, "end": s.end, "text": s.text}
                                           for s in raw])

    result = {
        "ok": True,
        "lang": getattr(info, "language", "") or "",
        "device": device,
        "computeType": compute_type,
        "model": args.model,
        "count": len(segments),
        "wordCount": len(words),
        "gapThreshold": args.gap,
        "segments": segments,
    }
    emit_result(args, result)
    print(json.dumps({"ok": True, "count": len(segments), "lang": result["lang"],
                      "device": device}, ensure_ascii=False))


if __name__ == "__main__":
    main()
