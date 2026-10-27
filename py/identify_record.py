# -*- coding: utf-8 -*-
"""vh-Atelier 听歌识曲：WASAPI loopback 录音（抓系统正在播放的声音）
用法: python identify_record.py <out.wav> [duration秒]
依赖: pyaudiowpatch（pip install pyaudiowpatch）

v2 修复（相对 v1）：
  1. 声道数不再写死为 1，改用设备真实 maxInputChannels（loopback 设备通常是 2 声道）。
  2. 采样率封顶 48kHz：过高采样率（如板载 Realtek 的 192kHz）会让 loopback 读流卡死，
     而指纹识别只需 8kHz，降采样前 48kHz 足够。
  3. 输出附带所有输出设备的 loopback 名称，供诊断「抓错设备」问题（多声卡机器常见）。
"""
import sys
import os
import io
import struct
import wave
import json

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
except Exception:
    pass

import pyaudiowpatch as pyaudio


def json_out(obj):
    return json.dumps(obj, ensure_ascii=False)


def _loopback_of_default(p):
    wasapi_info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
    default_speakers = p.get_device_info_by_index(wasapi_info['defaultOutputDevice'])
    if not default_speakers['isLoopbackDevice']:
        for lp in p.get_loopback_device_info_generator():
            if default_speakers['name'] in lp['name']:
                default_speakers = lp
                break
        else:
            default_speakers = next(p.get_loopback_device_info_generator())
    return default_speakers


def record(out_path, duration=8):
    p = pyaudio.PyAudio()
    try:
        default_speakers = _loopback_of_default(p)

        rate = int(default_speakers['defaultSampleRate'])
        if rate > 48000:
            rate = 48000
        channels = int(default_speakers['maxInputChannels'])
        if channels <= 0:
            channels = 2

        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=default_speakers['index'],
            frames_per_buffer=1024,
        )

        frames = []
        total_frames = int(rate / 1024 * duration)
        for _ in range(total_frames):
            try:
                frames.append(stream.read(1024, exception_on_overflow=False))
            except Exception:
                break
        stream.stop_stream()
        stream.close()

        raw = b''.join(frames)
        n = len(raw) // 2
        samples = struct.unpack('<%dh' % n, raw[:n * 2]) if n >= 2 else (0,)
        peak = max(abs(s) for s in samples) if samples else 0
        rms = (sum(s * s for s in samples) / n) ** 0.5 if n else 0

        wf = wave.open(out_path, 'wb')
        wf.setnchannels(channels)
        wf.setsampwidth(p.get_sample_size(pyaudio.paInt16))
        wf.setframerate(rate)
        wf.writeframes(raw)
        wf.close()

        # 列出所有输出设备 loopback，供诊断
        all_devs = [d['name'] for d in p.get_loopback_device_info_generator()]

        print(json_out({
            'ok': True, 'out': out_path, 'bytes': os.path.getsize(out_path),
            'peak': peak, 'rms': round(rms, 1), 'rate': rate, 'channels': channels,
            'device': default_speakers['name'], 'silent': peak < 300,
            'allOutputDevices': all_devs,
        }))
    finally:
        p.terminate()


def main():
    if len(sys.argv) < 2:
        print(json_out({'ok': False, 'error': '用法: identify_record.py <out.wav> [duration]'}))
        return 1
    out_path = sys.argv[1]
    duration = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
    try:
        record(out_path, duration)
    except Exception as e:
        print(json_out({'ok': False, 'error': str(e)}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
