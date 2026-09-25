# -*- coding: utf-8 -*-
"""vh-Atelier 短剧下载 · App 链路（可下全剧，不限前3集）

用途：官网播放页只开放前 3 集，本脚本走红果 App 接口，可下任意集。
用法：
    python hongguo_app_dl.py --vid <vid> --out <输出目录> [--name 剧名] [--ep 集号]
    python hongguo_app_dl.py --series <series_id> --out <目录> --from 4 --count 10
    python hongguo_app_dl.py --register          # 仅注册设备号

输出：JSON 行（每行一个事件），便于上层（Node 服务）解析：
    {"event":"progress","percent":35,"msg":"..."}
    {"event":"done","file":"...","size":123,"height":1080}
    {"event":"error","msg":"..."}
"""
import sys
import os
import io
import re
import json
import time
import ssl
import base64
import shutil
import argparse
import subprocess
import urllib.request
import urllib.parse

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
LIUSHEN = os.path.join(HERE, "liushen")
# 插件内自带依赖目录（用 pip --target 装入），优先于系统 site-packages
LIBS = os.path.join(HERE, "libs")
for p in (LIBS, LIUSHEN):
    if os.path.isdir(p) and p not in sys.path:
        sys.path.insert(0, p)


def _ensure_deps():
    """确保签名所需依赖可用；缺失时尝试自动装到插件内 libs/。"""
    need = []
    for mod, pkg in (("betterproto", "betterproto==1.2.5"),
                     ("gmssl", "gmssl>=3.2,<4"),
                     ("Crypto", "pycryptodome>=3.20,<4")):
        try:
            __import__(mod)
        except Exception:
            need.append(pkg)
    if not need:
        return True
    emit({"event": "progress", "percent": 1, "msg": "首次使用，安装依赖（约 10MB）"})
    try:
        os.makedirs(LIBS, exist_ok=True)
        r = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--target", LIBS,
             "--no-compile", "--quiet"] + need,
            capture_output=True, timeout=600)
        if r.returncode != 0:
            return False
        for p in (LIBS,):
            if p not in sys.path:
                sys.path.insert(0, p)
        # 重新验证
        for mod, _ in (("betterproto", 0), ("gmssl", 0), ("Crypto", 0)):
            try:
                __import__(mod)
            except Exception:
                return False
        return True
    except Exception:
        return False

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

DEVICE_FILE = os.path.join(HERE, "hongguo_device.json")
WEB_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
DEFAULT_UA = ("com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; "
              "Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 "
              "QuicVersion:c67e9834 2025-09-08)")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def find_ffmpeg():
    cands = [
        os.environ.get("FFMPEG"),
        os.path.join(HERE, "..", "bin", "ffmpeg-win32-x64.exe"),
        os.path.join(HERE, "..", "bin", "ffmpeg.exe"),
        r"C:\ffmpeg\bin\ffmpeg.exe",
    ]
    for c in cands:
        if c and os.path.exists(c):
            return c
    return "ffmpeg"


# ── 设备号 ──────────────────────────────────────────────────
def load_device():
    if os.path.exists(DEVICE_FILE):
        try:
            return json.load(open(DEVICE_FILE, encoding="utf-8"))
        except Exception:
            return None
    return None


def save_device(d):
    json.dump(d, open(DEVICE_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)


def register_device():
    """注册一个红果设备号（走 log.snssdk.com）。"""
    import gzip
    from flurl.utils import UUID, generate_android_id, md5, rand_str
    from flurl.ttEncryptorUtil import ttEncrypt
    import http.client

    openudid = generate_android_id()
    cdid = UUID()
    clientudid = UUID()
    DT, OSV = "25053RT47C", "16"
    ua = DEFAULT_UA

    obj = {"magic_tag": "ss_app_log", "header": {
        "update_version_code": 71332, "manifest_version_code": 71332, "aid": 8662,
        "channel": "update_64", "package": "com.phoenix.read", "app_version": "7.1.3.32",
        "version_code": 71332, "sdk_version": "3.7.3-rc.53-douyin-bugfix",
        "sdk_target_version": 29, "os": "android", "os_version": OSV, "os_api": 36,
        "device_model": DT, "device_brand": "Redmi", "device_manufacturer": "Xiaomi",
        "device_category": "phone", "cpu_abi": "arm64-v8a", "release_build": UUID(),
        "density_dpi": 520, "display_density": "mdpi", "resolution": "1280x2772",
        "language": "zh", "timezone": 8, "access": "wifi", "not_request_sender": 0,
        "carrier": "CHINA MOBILE", "mcc_mnc": "46007", "region": "CN",
        "tz_name": "Asia/Shanghai", "tz_offset": 28800, "sim_region": "cn",
        "openudid": openudid, "clientudid": clientudid, "sig_hash": md5(UUID()),
    }, "_gen_time": int(time.time() * 1000)}

    post_data = ttEncrypt(gzip.compress(json.dumps(obj).encode("utf-8")))
    params = {
        "tt_data": "a", "os_api": "36", "device_type": DT, "ssmix": "a",
        "manifest_version_code": "71332", "dpi": "520", "version_name": "7.1.3.32",
        "ts": int(time.time()), "cpu_support64": "true", "app_type": "normal",
        "appTheme": "light", "ac": "wifi", "host_abi": "arm64-v8a",
        "update_version_code": "71332", "channel": "update_64",
        "_rticket": int(time.time() * 1000), "device_platform": "android",
        "version_code": "71332", "cdid": cdid, "os": "android", "is_android_pad": "0",
        "openudid": openudid, "package": "com.phoenix.read", "resolution": "1280*2772",
        "os_version": OSV, "language": "zh", "device_brand": "Redmi",
        "need_personal_recommend": "1", "aid": "8662", "minor_status": "0",
        "app_name": "novelread", "mcc_mnc": "46007",
    }
    path = "/service/2/device_register/?" + urllib.parse.urlencode(params)
    # 该域名 DNS 曾被污染，直连已知 IP
    for host, ip in [("log.snssdk.com", "42.236.78.130"), ("log.snssdk.com", "42.236.93.92")]:
        try:
            conn = http.client.HTTPSConnection(ip, 443, timeout=25, context=CTX)
            conn.request("POST", path, body=post_data, headers={
                "Host": host, "content-type": "application/octet-stream;tt-data=a",
                "accept-encoding": "gzip", "user-agent": ua,
                "content-length": str(len(post_data)),
            })
            r = conn.getresponse()
            raw = r.read()
            if raw[:2] == b"\x1f\x8b":
                raw = gzip.decompress(raw)
            d = json.loads(raw)
            if d.get("device_id") and str(d.get("device_id")) != "0":
                dev = {
                    "device_id": str(d["device_id"]), "install_id": str(d.get("install_id")),
                    "device_type": DT, "ua": ua, "openudid": openudid,
                    "cdid": cdid, "clientudid": clientudid,
                }
                save_device(dev)
                return dev
        except Exception:
            continue
    return None


def ensure_device():
    d = load_device()
    if d and d.get("device_id"):
        return d
    emit({"event": "progress", "percent": 2, "msg": "首次使用，注册设备号"})
    d = register_device()
    if d:
        return d
    raise RuntimeError("设备号注册失败（网络或接口变更）")


# ── 签名请求 ────────────────────────────────────────────────
def fetch_video(dev, vid):
    from flurl.core import core_sixgod

    iid, did = dev["install_id"], dev["device_id"]
    DEV = {
        "device_id": did, "iid": iid, "install_id": iid, "device_brand": "Redmi",
        "device_model": dev.get("device_type", "25053RT47C"),
        "device_type": dev.get("device_type", "25053RT47C"),
        "device_manufacturer": "Xiaomi", "os_version": "16",
        "version_name": "7.1.3.32", "ua": dev.get("ua") or DEFAULT_UA,
    }
    url = ("https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/"
           f"?iid={iid}&device_id={did}&ac=wifi&channel=update_64&aid=8662"
           "&app_name=novelread&version_code=71332&version_name=7.1.3.32"
           "&device_platform=android&os=android&ssmix=a&device_type=" + DEV["device_type"] +
           "&device_brand=Redmi&language=zh&os_api=36&os_version=16"
           "&manifest_version_code=71332&resolution=1280*2772&dpi=520"
           "&update_version_code=71332&host_abi=arm64-v8a&dragon_device_type=phone"
           "&pv_player=71332&compliance_status=0&need_personal_recommend=1"
           "&player_so_load=1&is_android_pad_screen=0")
    hdrs = {
        "User-Agent": DEV["ua"],
        "Accept": "application/json; charset=utf-8,application/x-protobuf",
        "Content-Type": "application/json; charset=UTF-8", "x-xs-from-web": "0",
        "x-ss-req-ticket": str(int(time.time() * 1000)), "x-tt-request-tag": "t=0;n=0",
        "sdk-version": "2", "passport-sdk-version": "50561",
        "x-vc-bdturing-sdk-version": "3.7.2.cn",
    }
    body = {"biz_param": {
        "detail_page_version": 0, "device_level": 3, "disable_digg_stat": False,
        "need_all_video_definition": True, "need_mp4_align": False,
        "use_os_player": False, "use_server_dns": False, "video_platform": 1024,
    }, "mixed_video_id_map": {"1004": [vid]}}
    bb = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    p = urllib.parse.urlsplit(url)
    SH, SU = core_sixgod(
        surl=f"{p.scheme}://{p.netloc}{p.path}",
        params=dict(urllib.parse.parse_qsl(p.query, keep_blank_values=True)),
        data=json.loads(bb), devices=DEV, header=hdrs, log=False)
    req = urllib.request.Request(SU, data=bb, headers=SH, method="POST")
    d = json.loads(urllib.request.urlopen(req, context=CTX, timeout=30).read())
    code = d.get("Code", d.get("code"))
    if code != 0:
        raise RuntimeError(f"接口返回 {code} {d.get('Message') or d.get('message')}")
    vm = list(d["data"].values())[0]["video_model"]
    if isinstance(vm, str):
        vm = json.loads(vm)
    return vm


def derive_content_key(spade_b64):
    s = spade_b64.strip()
    pad = 4 - len(s) % 4
    if pad != 4:
        s += "=" * pad
    raw = base64.b64decode(s)
    v6 = raw[0] ^ raw[1] ^ raw[2]
    v8 = len(raw) - v6 + 47
    if v8 <= 0 or v8 > len(raw) * 2:
        raise ValueError("spade_a 长度异常")
    if 1 + v8 > len(raw):
        v8 = len(raw) - 1
    v13 = bytearray(raw[1:1 + v8])
    vA, vB = 85, 246
    for i in range(v8):
        pc = bin(i).count("1")
        if i & 1:
            v24, vA = vA, v13[i]
        else:
            v24, vB = vB, v13[i]
        v13[i] = ((-21 - pc) + (v24 ^ v13[i])) & 0xFF
    return bytes.fromhex(bytes(v13[1:33]).decode("ascii"))


def pick_best(vlist):
    return max(vlist, key=lambda x: int(x.get("video_meta", {}).get("vheight", 0) or 0))


def download(vid, out_path, dev, retries=2):
    last = None
    for attempt in range(retries + 1):
        try:
            vm = fetch_video(dev, vid)
            item = pick_best(vm.get("video_list") or [])
            meta = item.get("video_meta", {})
            enc = item.get("encrypt_info", {}) or {}
            cmd = [find_ffmpeg(), "-y", "-v", "error"]
            if enc.get("encrypt") and enc.get("spade_a"):
                cmd += ["-decryption_key", derive_content_key(enc["spade_a"]).hex()]
            cmd += ["-i", item.get("main_url") or item.get("backup_url"),
                    "-c", "copy", "-movflags", "+faststart", out_path]
            r = subprocess.run(cmd, capture_output=True)
            if os.path.exists(out_path) and os.path.getsize(out_path) > 10000:
                return os.path.getsize(out_path), int(meta.get("vheight", 0) or 0)
            last = (r.stderr or b"").decode("utf-8", "replace")[-200:]
        except Exception as e:
            last = str(e)
        if attempt < retries:
            time.sleep(1.5)
    raise RuntimeError(f"下载失败: {last}")


def safe_name(s):
    return re.sub(r'[\\/:*?"<>|]', "_", str(s or "video"))[:80]


def get_vid_list(series_id):
    url = f"https://hongguoduanju.com/player/{series_id}/"
    html = urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": WEB_UA}),
        context=CTX, timeout=25).read().decode("utf-8", "replace")
    nm = re.search(r'"series_name":"([^"]*)"', html)
    mv = re.search(r'"vid_list":\[([^\]]+)\]', html)
    vids = re.findall(r'"(\d+)"', mv.group(1)) if mv else []
    return (nm.group(1) if nm else series_id), vids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vid", help="单集 vid")
    ap.add_argument("--series", help="剧 series_id（配合 --from/--count）")
    ap.add_argument("--out", default=".", help="输出目录")
    ap.add_argument("--name", default="", help="剧名（用于文件名）")
    ap.add_argument("--ep", type=int, default=0, help="集号（命名用）")
    ap.add_argument("--from", dest="from_ep", type=int, default=1, help="起始集（1基）")
    ap.add_argument("--count", type=int, default=1, help="集数")
    ap.add_argument("--register", action="store_true", help="仅注册设备号")
    args = ap.parse_args()

    if args.register:
        d = register_device()
        emit({"event": "done", "device": d} if d else {"event": "error", "msg": "注册失败"})
        return 0 if d else 1

    if not _ensure_deps():
        emit({"event": "error",
              "msg": "签名依赖不可用，且自动安装失败。请手动执行：pip install --target \"" + LIBS + "\" betterproto==1.2.5 gmssl pycryptodome"})
        return 1

    os.makedirs(args.out, exist_ok=True)
    dev = ensure_device()
    emit({"event": "progress", "percent": 5, "msg": "设备号就绪"})

    jobs = []   # (vid, ep_no, name)
    if args.vid:
        jobs.append((args.vid, args.ep or 1, args.name))
    elif args.series:
        name, vids = get_vid_list(args.series)
        name = args.name or name
        for i in range(args.count):
            ep = args.from_ep + i
            if ep - 1 >= len(vids):
                break
            jobs.append((vids[ep - 1], ep, name))
    else:
        emit({"event": "error", "msg": "需要 --vid 或 --series"})
        return 1

    if not jobs:
        emit({"event": "error", "msg": "没有可下载的集"})
        return 1

    ok = 0
    for i, (vid, ep, name) in enumerate(jobs):
        pct = 8 + int(i / len(jobs) * 88)
        emit({"event": "progress", "percent": pct,
              "msg": f"[{i+1}/{len(jobs)}] 第 {ep} 集下载中"})
        fn = f"{safe_name(name)}_{('0000'+str(ep))[-4:]}.mp4"
        out = os.path.join(args.out, fn)
        try:
            size, h = download(vid, out, dev)
            ok += 1
            emit({"event": "done", "file": out, "size": size, "height": h, "ep": ep})
        except Exception as e:
            emit({"event": "error", "ep": ep, "msg": str(e)})
    emit({"event": "summary", "ok": ok, "total": len(jobs)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
