# -*- coding: utf-8 -*-
"""
火山引擎豆包语音合成 2.0 CLI（供插件调用）

用法: python volc_tts_cli.py <config.json>

config.json:
{
  "speaker": "zh_female_vv_uranus_bigtts",
  "text": "要合成的文字",
  "out_wav": "输出 wav 绝对路径",
  "speed": 0,              // 语速 [-50,100]，0 为正常
  "pitch": 0               // 音调 [-12,12]
}

凭据从 collect/volc_config.json 读取（不存在则报错）：
{
  "app_id": "...",
  "app_key": "...",        // X-Api-App-Key
  "access_key": "...",     // X-Api-Access-Key
  "resource_id": "seed-tts-2.0"
}

输出 stdout: {"ok":true,"out":"...","duration":3.2,"engine":"volc2"}
"""
import sys
import os
import json
import base64
import time

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.dirname(HERE)
CONF = os.path.join(EXT, 'collect', 'volc_config.json')

API = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
FFMPEG = r'C:\ffmpeg\bin\ffmpeg.exe'


def emit(o):
    print(json.dumps(o, ensure_ascii=False), flush=True)


def load_conf():
    if not os.path.exists(CONF):
        return None
    try:
        c = json.load(open(CONF, encoding='utf-8'))
    except Exception:
        return None
    if not c.get('app_id') or not c.get('access_key'):
        return None
    c.setdefault('app_key', '')
    c.setdefault('resource_id', 'seed-tts-2.0')
    return c


def synth(conf, speaker, text, out_wav, speed=0, pitch=0):
    import urllib.request
    import urllib.error

    body = {
        "user": {"uid": "vh_atelier"},
        "req_params": {
            "text": text,
            "speaker": speaker,
            "audio_params": {
                "format": "mp3",
                "sample_rate": 24000,
                "speech_rate": speed,
            },
        },
    }
    if pitch:
        body["req_params"]["additions"] = json.dumps({"post_process": {"pitch": pitch}})

    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(API, data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('X-Api-App-Id', str(conf['app_id']))
    req.add_header('X-Api-App-Key', str(conf['app_key']))
    req.add_header('X-Api-Access-Key', str(conf['access_key']))
    req.add_header('X-Api-Resource-Id', str(conf['resource_id']))

    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8', 'replace')[:300]
        except Exception:
            pass
        return None, 'HTTP %s: %s' % (e.code, detail)
    except Exception as e:
        return None, '请求失败: %s' % str(e)

    # 解析 JSON 行流，提取 base64 音频
    chunks = []
    err = ''
    for line in raw.decode('utf-8', 'replace').split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            j = json.loads(line)
        except Exception:
            continue
        hdr = j.get('header') or {}
        if hdr.get('message'):
            err = hdr['message']
        if j.get('message') and j.get('code') not in (0, None, 20000000):
            err = j['message']
        d = j.get('data')
        if isinstance(d, str) and len(d) > 100:
            try:
                chunks.append(base64.b64decode(d))
            except Exception:
                pass

    if not chunks:
        return None, err or '未返回音频（该音色可能未在账号授权）'

    mp3 = b''.join(chunks)
    tmp_mp3 = out_wav + '.tmp.mp3'
    open(tmp_mp3, 'wb').write(mp3)

    # 转 wav（24kHz 单声道，和 CosyVoice 输出格式一致）
    try:
        import subprocess
        r = subprocess.run([FFMPEG, '-y', '-v', 'error', '-i', tmp_mp3,
                            '-ar', '24000', '-ac', '1', out_wav],
                           capture_output=True, timeout=120)
        if r.returncode != 0 or not os.path.exists(out_wav):
            return None, '转码失败: %s' % (r.stderr or b'').decode('utf-8', 'replace')[:200]
    except Exception as e:
        return None, '转码异常: %s' % str(e)
    finally:
        try:
            os.remove(tmp_mp3)
        except Exception:
            pass

    # 取时长
    dur = 0.0
    try:
        import subprocess
        r = subprocess.run([r'C:\ffmpeg\bin\ffprobe.exe', '-v', 'error',
                            '-show_entries', 'format=duration', '-of',
                            'default=noprint_wrappers=1:nokey=1', out_wav],
                           capture_output=True, text=True, timeout=30)
        dur = float(r.stdout.strip() or 0)
    except Exception:
        pass

    return out_wav, None


def main():
    if len(sys.argv) < 2:
        emit({'ok': False, 'error': 'usage: volc_tts_cli.py <config.json>'})
        return 1

    try:
        cfg = json.load(open(sys.argv[1], encoding='utf-8'))
    except Exception as e:
        emit({'ok': False, 'error': '读取配置失败: %s' % str(e)})
        return 1

    speaker = cfg.get('speaker', '')
    text = (cfg.get('text') or '').strip()
    out_wav = cfg.get('out_wav', '')
    speed = int(cfg.get('speed', 0) or 0)
    pitch = int(cfg.get('pitch', 0) or 0)

    if not speaker:
        emit({'ok': False, 'error': '缺少 speaker'})
        return 1
    if not text:
        emit({'ok': False, 'error': '合成文本为空'})
        return 1
    if not out_wav:
        emit({'ok': False, 'error': '缺少 out_wav'})
        return 1

    conf = load_conf()
    if not conf:
        emit({'ok': False, 'error': '未配置火山凭据。请在插件目录 collect/volc_config.json 填写 app_id / app_key / access_key'})
        return 1

    t0 = time.time()
    out, err = synth(conf, speaker, text, out_wav, speed, pitch)
    if err:
        emit({'ok': False, 'error': err})
        return 1

    dur = 0.0
    try:
        import subprocess
        r = subprocess.run([r'C:\ffmpeg\bin\ffprobe.exe', '-v', 'error',
                            '-show_entries', 'format=duration', '-of',
                            'default=noprint_wrappers=1:nokey=1', out],
                           capture_output=True, text=True, timeout=30)
        dur = float(r.stdout.strip() or 0)
    except Exception:
        pass

    emit({'ok': True, 'out': out, 'duration': round(dur, 2),
          'gen_sec': round(time.time() - t0, 1), 'engine': 'volc2',
          'speaker': speaker})
    return 0


if __name__ == '__main__':
    sys.exit(main())
