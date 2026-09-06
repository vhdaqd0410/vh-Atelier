# -*- coding: utf-8 -*-
"""vh-Atelier 听歌识曲：WASAPI loopback 录音（抓系统正在播放的声音）
用法: python identify_record.py <out.wav> [duration秒]
依赖: pyaudiowpatch（pip install pyaudiowpatch）
"""
import sys
import os
import io
import struct
import wave

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
except Exception:
    pass

import pyaudiowpatch as pyaudio


def record(out_path, duration=8):
    p = pyaudio.PyAudio()
    try:
        wasapi_info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
        default_speakers = p.get_device_info_by_index(wasapi_info['defaultOutputDevice'])

        if not default_speakers['isLoopbackDevice']:
            for loopback in p.get_loopback_device_info_generator():
                if default_speakers['name'] in loopback['name']:
                    default_speakers = loopback
                    break
            else:
                gen = p.get_loopback_device_info_generator()
                default_speakers = next(gen)

        rate = int(default_speakers['defaultSampleRate'])
        stream = p.open(
            format=pyaudio.paInt16,
            channels=1,
            rate=rate,
            input=True,
            input_device_index=default_speakers['index'],
            frames_per_buffer=1024,
        )

        frames = []
        total_frames = int(rate / 1024 * duration)
        for _ in range(total_frames):
            data = stream.read(1024, exception_on_overflow=False)
            frames.append(data)
        stream.stop_stream()
        stream.close()

        wf = wave.open(out_path, 'wb')
        wf.setnchannels(1)
        wf.setsampwidth(p.get_sample_size(pyaudio.paInt16))
        wf.setframerate(rate)
        wf.writeframes(b''.join(frames))
        wf.close()

        # 音量检测：判断是否有声音
        raw = b''.join(frames)
        samples = struct.unpack('<%dh' % (len(raw) // 2), raw) if len(raw) >= 2 else (0,)
        peak = max(abs(s) for s in samples) if samples else 0
        print(json_out({'ok': True, 'out': out_path, 'bytes': os.path.getsize(out_path),
                        'peak': peak, 'rate': rate, 'device': default_speakers['name'],
                        'silent': peak < 300}))
    finally:
        p.terminate()


def json_out(obj):
    import json
    return json.dumps(obj, ensure_ascii=False)


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
