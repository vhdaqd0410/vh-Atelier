# -*- coding: utf-8 -*-
"""
CosyVoice3 零样本语音克隆 CLI（独立语音克隆插件专用，方案 B：单次调用）
用法: python cosyvoice_cli.py <config.json>

config.json 结构:
{
  "ref_wav": "参考音频 wav 绝对路径（英文路径，<=30s）",
  "ref_text": "参考音频对应的文字（中英文均可，建议和音频内容一致）",
  "tts_text": "要合成的文字",
  "out_wav": "输出 wav 绝对路径（英文路径）",
  "speed": 1.0,        // 语速 0.5~2.0，默认 1.0（仅非 stream 模式生效）
  "model": "base",     // 模型变体：base=llm.pt（基础版） / rl=llm.rl.pt（强化学习版）

  // 以下为引擎路径，可省略（用默认值）：
  "internal": "D:\\cosyvoice3_V30\\_internal",          // exe 内冻结的 torch/cosyvoice 源码
  "matcha": "D:\\cosyvoice3_V30\\third_party\\Matcha-TTS",
  "model_dir": "D:\\cosyvoice3_V30\\pretrained_models",
  "torio_stub": "插件 stubs 目录下的 torio_stub"
}

输出: stdout 打印 JSON {ok, out, duration, load_sec, gen_sec, rtf}
进度: stderr 打 STAGE 标记（init / load-model / clone / save）

设计要点：
- 复用 CosyVoice3 工具 exe 内的 GPU torch 2.7.0+cu128 和 cosyvoice 源码，不重新下载模型
- 中英文由 frontend 自动判别，无需显式指定语言
- 输出采样率 24000（CosyVoice3 原生）
- 路径注入必须在 import torch 之前完成，故 import 放在 main 内部
"""

import os
import sys
import json
import time

# 默认引擎路径：优先找插件目录内 engine/cosyvoice3_V30（自包含部署）；
# 退回本机 D:\cosyvoice3_V30（开发机现状）
_here = os.path.dirname(os.path.abspath(__file__))
_ext_root = os.path.abspath(os.path.join(_here, '..'))
_candidates = [
    os.path.join(_ext_root, 'engine', 'cosyvoice3_V30'),
    r"D:\cosyvoice3_V30",
]
def _find_engine():
    for p in _candidates:
        if p and os.path.isdir(os.path.join(p, '_internal')):
            return p
    return _candidates[0]
_ENGINE = _find_engine()
DEFAULT_INTERNAL = os.path.join(_ENGINE, '_internal')
DEFAULT_MATCHA = os.path.join(_ENGINE, 'third_party', 'Matcha-TTS')
DEFAULT_MODEL_DIR = os.path.join(_ENGINE, 'pretrained_models')


def emit_stage(stage):
    print('STAGE %s' % stage, file=sys.stderr, flush=True)


def emit_result(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def ascii_path(p):
    """把输出/临时路径强制转到纯英文目录，避免 C++ 引擎和 torchaudio 对中文路径的兼容问题。"""
    p = os.path.abspath(p)
    try:
        p.encode('ascii')
        return p
    except UnicodeEncodeError:
        pass
    base = os.path.join(os.path.expanduser('~'), 'whisper_subtitle_sep', 'clone')
    os.makedirs(base, exist_ok=True)
    name = os.path.basename(p)
    ascii_name = ''.join(c if ord(c) < 128 else '_' for c in name)
    if not ascii_name or ascii_name == '_' * len(name):
        ascii_name = 'clone_%d.wav' % int(time.time() * 1000)
    return os.path.join(base, ascii_name)


def inject_runtime(internal, matcha, torio_stub):
    """在 import torch 之前，把引擎路径注入 sys.path。"""
    for _p in (torio_stub, internal, matcha):
        if _p and os.path.isdir(_p) and _p not in sys.path:
            sys.path.insert(0, _p)
    _torch_lib = os.path.join(internal, 'torch', 'lib')
    if os.path.isdir(_torch_lib) and _torch_lib not in sys.path:
        sys.path.insert(0, _torch_lib)
    if hasattr(os, 'add_dll_directory'):
        try:
            os.add_dll_directory(_torch_lib)
        except Exception:
            pass


def main():
    if len(sys.argv) < 2:
        emit_result({'ok': False, 'error': 'usage: cosyvoice_cli.py <config.json>'})
        return 1

    cfg_path = sys.argv[1]
    try:
        with open(cfg_path, 'r', encoding='utf-8-sig') as f:
            cfg = json.load(f)
    except Exception as e:
        emit_result({'ok': False, 'error': '读取配置失败: %s' % str(e)})
        return 1

    ref_wav = cfg.get('ref_wav', '')
    ref_text = cfg.get('ref_text', '')
    tts_text = cfg.get('tts_text', '')
    out_wav = cfg.get('out_wav', '')
    speed = cfg.get('speed', 1.0)
    model_variant = (cfg.get('model', 'base') or 'base').lower()
    if model_variant not in ('base', 'rl'):
        model_variant = 'base'
    try:
        speed = float(speed)
    except (TypeError, ValueError):
        speed = 1.0
    if speed < 0.5 or speed > 2.0:
        emit_result({'ok': False, 'error': '语速参数超出范围（0.5~2.0）: %s' % speed})
        return 1

    if not ref_wav or not os.path.exists(ref_wav):
        emit_result({'ok': False, 'error': '参考音频不存在: %s' % ref_wav})
        return 1
    if not tts_text:
        emit_result({'ok': False, 'error': '合成文本为空'})
        return 1
    if not ref_text:
        emit_result({'ok': False, 'error': '参考文本为空（参考音频对应的文字）'})
        return 1

    # 引擎路径（config 可覆盖，缺省用默认）
    internal = cfg.get('internal', DEFAULT_INTERNAL)
    matcha = cfg.get('matcha', DEFAULT_MATCHA)
    model_dir = cfg.get('model_dir', DEFAULT_MODEL_DIR)
    torio_stub = cfg.get('torio_stub', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'stubs', 'torio_stub'))

    # 输出路径 ASCII 化
    out_wav = ascii_path(out_wav)

    emit_stage('init')
    inject_runtime(internal, matcha, torio_stub)
    try:
        import torch
        from cosyvoice.cli.cosyvoice import CosyVoice3
    except Exception as e:
        emit_result({'ok': False, 'error': '运行时初始化失败（import torch/cosyvoice）: %s' % str(e)})
        return 1

    emit_stage('load-model')
    t0 = time.time()
    try:
        model = CosyVoice3(model_dir, fp16=True)
        # 模型变体切换：默认 base 用 llm.pt，rl 用 llm.rl.pt（两文件结构一致，可直接切换）
        # 只覆盖 llm 权重（flow/hift 两个变体共用，避免重复加载）
        if model_variant == 'rl':
            rl_llm = os.path.join(model_dir, 'llm.rl.pt')
            if not os.path.exists(rl_llm):
                emit_result({'ok': False, 'error': 'RL 模型不存在: %s' % rl_llm})
                return 1
            device = model.model.device
            model.model.llm.load_state_dict(torch.load(rl_llm, map_location=device), strict=True)
            model.model.llm.to(device).eval()
    except Exception as e:
        emit_result({'ok': False, 'error': '模型加载失败: %s' % str(e)})
        return 1
    load_sec = time.time() - t0

    emit_stage('clone')
    t1 = time.time()
    try:
        chunks = []
        for out in model.inference_zero_shot(tts_text, ref_text, ref_wav, stream=False, speed=speed):
            chunks.append(out['tts_speech'])
        speech = torch.cat(chunks, dim=1)
    except Exception as e:
        emit_result({'ok': False, 'error': '克隆失败: %s' % str(e)})
        return 1
    gen_sec = time.time() - t1

    duration = speech.shape[1] / model.sample_rate

    emit_stage('save')
    import torchaudio
    torchaudio.save(out_wav, speech.cpu(), model.sample_rate)

    emit_result({
        'ok': True,
        'out': out_wav,
        'duration': round(duration, 3),
        'load_sec': round(load_sec, 1),
        'gen_sec': round(gen_sec, 1),
        'rtf': round(gen_sec / duration, 3) if duration > 0 else 0,
        'speed': speed,
        'model': model_variant,
    })
    return 0


if __name__ == '__main__':
    sys.exit(main())
