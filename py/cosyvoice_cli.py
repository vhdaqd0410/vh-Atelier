# -*- coding: utf-8 -*-
"""
CosyVoice3 语音克隆 CLI（独立语音克隆插件专用，方案 B：单次调用）

用法: python cosyvoice_cli.py <config.json>

支持三种合成模式（mode 字段）：
  clone     零样本克隆：参考音频说什么语言，就合成什么语言（原行为）
  instruct  情绪/指令控制：额外用一句自然语言指令控制语气（如「愤怒地大声喊」）
  cross     跨语言：参考音频说中文，合成文本写英文，用中文音色说外语

config.json 结构:
{
  "mode": "clone",          // clone | instruct | cross，默认 clone
  "ref_wav": "参考音频 wav 绝对路径（<=30s）",
  "ref_text": "参考音频对应的文字（clone/instruct 需要；cross 可留空）",
  "tts_text": "要合成的文字",
  "instruct_text": "语气指令（仅 instruct 模式用，如「用四川话说这句话」）",
  "out_wav": "输出 wav 绝对路径",
  "speed": 1.0,             // 语速 0.5~2.0
  "model": "base",          // base=llm.pt / rl=llm.rl.pt

  // 引擎路径（可省略，用默认值）：
  "internal": "D:\\cosyvoice3_V30\\_internal",
  "matcha": "D:\\cosyvoice3_V30\\third_party\\Matcha-TTS",
  "model_dir": "D:\\cosyvoice3_V30\\pretrained_models",
  "torio_stub": "插件 stubs 目录下的 torio_stub"
}

另有两个管理动作（不需要 ref_wav/tts_text）：
  "action": "warmup"   仅加载模型后退出（预热点，用于提前把模型读进磁盘缓存）
  "action": "check"    仅回报运行时与模型是否可用

输出: stdout 打印 JSON {ok, out, duration, load_sec, gen_sec, rtf, mode}
进度: stderr 打 STAGE 标记（init / load-model / gen / save）

设计要点：
- 复用 CosyVoice3 工具 exe 内的 GPU torch 2.7.0+cu128 和 cosyvoice 源码，不重新下载模型
- 三种模式均**不注册/不使用 zero_shot_spk_id**：实测带 spk_id 时 instruct2 会忽略指令文本
  （frontend_instruct2 走缓存分支，prompt_text 取的是缓存里的参考文字），且 cross_lingual
  会 del 掉缓存 dict 的键、污染同一音色 ID。直接传参考音频最稳，也避免跨模式互相污染。
- **指令格式必须是官方格式**：instruct 用 `You are a helpful assistant. {指令}<|endofprompt|>`，
  cross 用 `You are a helpful assistant.<|endofprompt|>{文本}`。`<|endofprompt|>` 之前是给 LLM 的
  指令、之后才是要念的内容。漏了这个标记，指令会被当成正文念出来
  （实测转写：'用愤怒的语气大声喊出来,你给我滚出去'）。
- 输出采样率 24000（CosyVoice3 原生）
- 路径注入必须在 import torch 之前完成，故 import 放在 main 内部
"""

import os
import sys
import json
import time

# 默认引擎路径（用户机器上的 CosyVoice3 工具安装位置）
DEFAULT_INTERNAL = r"D:\cosyvoice3_V30\_internal"
DEFAULT_MATCHA = r"D:\cosyvoice3_V30\third_party\Matcha-TTS"
DEFAULT_MODEL_DIR = r"D:\cosyvoice3_V30\pretrained_models"

MODES = ('clone', 'instruct', 'cross')

# CosyVoice3 的指令前缀与分隔标记。
# 官方 example.py 的 instruct / cross_lingual 用法：
#   inference_instruct2(tts, 'You are a helpful assistant. {指令}<|endofprompt|>', wav)
#   inference_cross_lingual('You are a helpful assistant.<|endofprompt|>{文本}', wav)
# <|endofprompt|> 之前是给 LLM 的指令，之后才是要念的内容。
# 实测：不加这个格式，LLM 会把指令也当成正文念出来
# （转写验证：'用愤怒的语气大声喊出来,你给我滚出去'）。
SYS_PREFIX = 'You are a helpful assistant. '
EO_PROMPT = '<|endofprompt|>'


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

    action = (cfg.get('action') or '').strip().lower()
    mode = (cfg.get('mode') or 'clone').strip().lower()
    if mode not in MODES:
        mode = 'clone'

    ref_wav = cfg.get('ref_wav', '')
    ref_text = cfg.get('ref_text', '')
    instruct_text = (cfg.get('instruct_text') or '').strip()
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

    # 校验：管理动作不需要文本；合成动作按模式校验
    if action not in ('warmup', 'check'):
        if not tts_text:
            emit_result({'ok': False, 'error': '合成文本为空'})
            return 1
        if mode == 'cross':
            # 跨语言不需要参考文字，但必须有参考音频
            if not ref_wav or not os.path.exists(ref_wav):
                emit_result({'ok': False, 'error': '参考音频不存在: %s' % ref_wav})
                return 1
        else:
            if not ref_wav or not os.path.exists(ref_wav):
                emit_result({'ok': False, 'error': '参考音频不存在: %s' % ref_wav})
                return 1
            if not ref_text:
                emit_result({'ok': False, 'error': '参考文本为空（参考音频对应的文字）'})
                return 1
        if mode == 'instruct' and not instruct_text:
            emit_result({'ok': False, 'error': '情绪/指令模式需要填写语气指令'})
            return 1

    # 引擎路径（config 可覆盖，缺省用默认）
    internal = cfg.get('internal', DEFAULT_INTERNAL)
    matcha = cfg.get('matcha', DEFAULT_MATCHA)
    model_dir = cfg.get('model_dir', DEFAULT_MODEL_DIR)
    torio_stub = cfg.get('torio_stub', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'stubs', 'torio_stub'))

    if out_wav:
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

    # 管理动作：加载完即返回
    if action in ('warmup', 'check'):
        emit_result({'ok': True, 'action': action, 'load_sec': round(load_sec, 1),
                     'sample_rate': model.sample_rate, 'model': model_variant})
        return 0

    emit_stage('gen')
    t1 = time.time()
    try:
        chunks = []
        if mode == 'instruct':
            # 情绪/指令控制：指令必须包成官方格式，否则指令会被当成正文念出来。
            # 不传 spk_id（否则指令会被忽略）
            instruct_full = SYS_PREFIX + instruct_text + EO_PROMPT
            gen = model.inference_instruct2(tts_text, instruct_full, ref_wav,
                                            stream=False, speed=speed)
        elif mode == 'cross':
            # 跨语言：同样需要官方前缀分隔，否则前缀会被念出
            gen = model.inference_cross_lingual(SYS_PREFIX + EO_PROMPT + tts_text, ref_wav,
                                                stream=False, speed=speed)
        else:
            # 零样本克隆（原行为）
            gen = model.inference_zero_shot(tts_text, ref_text, ref_wav,
                                            stream=False, speed=speed)
        for out in gen:
            chunks.append(out['tts_speech'])
        speech = torch.cat(chunks, dim=1)
    except Exception as e:
        emit_result({'ok': False, 'error': '合成失败(%s): %s' % (mode, str(e))})
        return 1
    gen_sec = time.time() - t1

    duration = speech.shape[1] / model.sample_rate

    emit_stage('save')
    try:
        import torchaudio
        torchaudio.save(out_wav, speech.cpu(), model.sample_rate)
    except Exception as e:
        emit_result({'ok': False, 'error': '保存音频失败: %s' % str(e)})
        return 1

    emit_result({
        'ok': True,
        'out': out_wav,
        'mode': mode,
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
