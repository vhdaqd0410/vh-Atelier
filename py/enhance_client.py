# -*- coding: utf-8 -*-
"""
超分站 (subtitle.zztianqiao.com) Python 客户端
- 自动登录（验证码 ddddocr 识别 + token 缓存）
- 上传视频（火山 TOS 直传）并创建超分任务
- 查询任务状态/结果

用法：
  python enhance_client.py login                 # 手动登录，缓存 token
  python enhance_client.py upload --file x.mp4 --folder 14086 --resolution 720p [--wait]
  python enhance_client.py tasks [--page 1 --pageSize 10]
  python enhance_client.py folders
"""
import io, sys, json, os, time, base64, argparse, urllib.request, urllib.parse

BASE = 'http://subtitle.zztianqiao.com'
# token 缓存放 collect/（插件运行时数据目录，源码同步会排除，不污染 git）
_py_dir = os.path.dirname(os.path.abspath(__file__))
_collect_dir = os.path.join(os.path.dirname(_py_dir), 'collect')
_cfg_dir = _collect_dir if os.path.isdir(_collect_dir) else _py_dir
TOKEN_FILE = os.path.join(_cfg_dir, '_enhance_token.json')
FOLDER_FILE = os.path.join(_cfg_dir, '_enhance_folder.json')

def out(*a):
    try:
        print(*a)
    except Exception:
        pass

# ---------- HTTP ----------
def _req(method, path, obj=None, headers_extra=None, timeout=120, raw_body=None):
    headers = {'User-Agent': 'Mozilla/5.0'}
    if obj is not None:
        data = json.dumps(obj).encode()
        headers['Content-Type'] = 'application/json'
    elif raw_body is not None:
        data = raw_body
    else:
        data = None
    if headers_extra:
        headers.update(headers_extra)
    full = path if (path.startswith('http://') or path.startswith('https://')) else BASE + path
    req = urllib.request.Request(full, data=data, method=method, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        body = resp.read()
        ct = resp.headers.get('Content-Type', '')
        if 'json' in ct or body[:1] in (b'{', b'['):
            try:
                return resp.status, json.loads(body)
            except Exception:
                return resp.status, body
        return resp.status, body
    except urllib.error.HTTPError as e:
        b = e.read(600)
        try:
            return e.code, json.loads(b)
        except Exception:
            return e.code, {'_raw': b[:300].decode('utf-8', 'replace')}

# ---------- 验证码 OCR ----------
def _get_captcha():
    st, d = _req('POST', '/api/base/captcha', {})
    data = d.get('data') or {}
    pic = str(data.get('picPath') or '')
    b64 = pic.split(',', 1)[1] if ',' in pic else pic
    return data.get('captchaId'), int(data.get('captchaLength') or 6), base64.b64decode(b64)

def _ocr_digits(raw, length):
    try:
        import ddddocr
        ocr = ddddocr.DdddOcr(show_ad=False)
        code = ocr.classification(raw)
    except ImportError:
        # 无 ddddocr 时：提示需要安装
        raise RuntimeError('需要 ddddocr：pip install ddddocr')
    code = ''.join(c for c in str(code) if c.isdigit())
    if len(code) != length:
        return None
    return code

def login(username, password, max_tries=10):
    """登录，返回 token；失败抛异常"""
    last_err = '未知错误'
    for i in range(max_tries):
        try:
            cid, length, raw = _get_captcha()
            code = _ocr_digits(raw, length)
            if not code:
                last_err = '验证码识别位数不符'
                continue
            st, d = _req('POST', '/api/base/login', {
                'username': username, 'password': password,
                'captcha': code, 'captchaId': cid, 'openCaptcha': True,
            })
            if d.get('code') == 0:
                tok = (d.get('data') or {}).get('token')
                if tok:
                    json.dump({'token': tok, 'ts': time.time()}, open(TOKEN_FILE, 'w', encoding='utf-8'))
                    return tok
                last_err = '登录返回无 token'
            else:
                last_err = str(d.get('msg') or d)
        except Exception as e:
            last_err = str(e)
        time.sleep(0.4)
    raise RuntimeError('登录失败: ' + last_err)

def get_token(username, password):
    """读缓存 token（10 小时内有效）否则重新登录"""
    try:
        c = json.load(open(TOKEN_FILE, encoding='utf-8'))
        if c.get('token') and time.time() - c.get('ts', 0) < 10 * 3600:
            # 验证有效性
            st, d = _req('GET', '/api/user/getUserInfo', headers_extra={'x-token': c['token']})
            if d.get('code') == 0:
                return c['token']
    except Exception:
        pass
    return login(username, password)

# ---------- 业务 ----------
def upload_and_create(folder_id, file_path, resolution='720p', username='', password='', wait=False, poll_interval=20, poll_max=3600, download_to=''):
    token = get_token(username, password)
    hx = {'x-token': token}
    fname = os.path.basename(file_path)

    st, d = _req('GET', '/api/enhance/applyUpload?' + urllib.parse.urlencode({'fileName': fname}), headers_extra=hx)
    if d.get('code') != 0:
        raise RuntimeError('applyUpload 失败: ' + str(d.get('msg')))
    upload_url = (d.get('data') or {}).get('uploadUrl')
    object_key = (d.get('data') or {}).get('objectKey')
    if not upload_url or not object_key:
        raise RuntimeError('applyUpload 未返回 uploadUrl/objectKey: ' + json.dumps(d, ensure_ascii=False))

    # PUT 直传
    with open(file_path, 'rb') as fp:
        fdata = fp.read()
    ext = os.path.splitext(fname)[1].lower()
    ctype = {'mp4': 'video/mp4', 'mov': 'video/quicktime', 'mkv': 'video/x-matroska',
             'avi': 'video/x-msvideo', 'flv': 'video/x-flv', 'wmv': 'video/x-ms-wmv'}.get(ext, 'application/octet-stream')
    st, resp = _req('PUT', upload_url, headers_extra={'Content-Type': ctype}, raw_body=fdata, timeout=3600)
    if st not in (200, 201, 204):
        raise RuntimeError('上传失败 HTTP ' + str(st) + ': ' + str(resp)[:200])

    # createTask
    st, d2 = _req('POST', '/api/enhance/createTask', {
        'folderID': int(folder_id), 'objectKey': object_key,
        'sourceFileName': fname, 'resolution': resolution,
    }, headers_extra=hx)
    if d2.get('code') != 0:
        raise RuntimeError('createTask 失败: ' + str(d2.get('msg')))
    task = d2.get('data') or {}
    task_id = task.get('ID')
    out('✅ 任务已创建 ID=' + str(task_id), '状态=' + str(task.get('status')))

    if not wait:
        return {'ok': True, 'task_id': task_id}

    # 轮询
    deadline = time.time() + poll_max
    while time.time() < deadline:
        time.sleep(poll_interval)
        st, dl = _req('GET', '/api/enhance/getTaskList?' + urllib.parse.urlencode({'page': 1, 'pageSize': 20}), headers_extra=hx)
        for t in (dl.get('data') or {}).get('list') or []:
            if t.get('ID') == task_id:
                status = t.get('status')
                out('  状态: ' + str(status), '进度=' + str(t.get('progress')) + '%')
                if status == 'succeeded':
                    out('✅ 超分完成，结果: ' + str(t.get('resultFileName')), 'cost=' + str(t.get('costCents')) + '分')
                    if download_to:
                        try:
                            # 保存名 = 源文件名_720p.mp4（如 1.mp4 → 1_720p.mp4），方便对应集数
                            src_base = os.path.splitext(os.path.basename(file_path))[0]
                            save_name = src_base + '_720p.mp4'
                            saved = download_task(token, task_id, download_to, save_name)
                            out('已下载: ' + saved)
                            t['downloaded'] = saved
                        except Exception as de:
                            out('⚠ 下载失败: ' + str(de))
                    return {'ok': True, 'task_id': task_id, 'status': status, 'result': t}
                if status == 'failed':
                    raise RuntimeError('任务失败: ' + str(t.get('errorMessage')))
    raise RuntimeError('等待超时')

def download_task(token, task_id, download_dir, save_name=''):
    """下载超分结果到本地目录，返回保存路径"""
    import urllib.error
    st, d = _req('GET', '/api/enhance/getDownloadURL?' + urllib.parse.urlencode({'ID': int(task_id)}), headers_extra={'x-token': token})
    if d.get('code') != 0:
        raise RuntimeError('getDownloadURL 失败: ' + str(d.get('msg')))
    url = (d.get('data') or {}).get('url')
    if not url:
        raise RuntimeError('未返回下载 URL')
    from urllib.parse import urlparse
    fname = save_name or (os.path.basename(urlparse(url).path) or ('result_' + str(task_id) + '.mp4'))
    os.makedirs(download_dir, exist_ok=True)
    dest = os.path.join(download_dir, fname)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=3600) as r, open(dest, 'wb') as fp:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            fp.write(chunk)
    return dest


def list_folders(username, password):
    token = get_token(username, password)
    st, d = _req('GET', '/api/erase/getFolderList', headers_extra={'x-token': token})
    if d.get('code') != 0:
        raise RuntimeError(str(d.get('msg')))
    return (d.get('data') or {}).get('list') or []

def list_tasks(username, password, page=1, page_size=50):
    token = get_token(username, password)
    st, d = _req('GET', '/api/enhance/getTaskList?' + urllib.parse.urlencode({'page': page, 'pageSize': page_size}),
                 headers_extra={'x-token': token})
    if d.get('code') != 0:
        raise RuntimeError(str(d.get('msg')))
    return (d.get('data') or {}).get('list') or []

# ---------- CLI ----------
def main():
    # stdout 统一 UTF-8（Windows 控制台默认 GBK，管道场景 JS 解析需 UTF-8）
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    except Exception:
        pass
    ap = argparse.ArgumentParser(description='超分站客户端')
    ap.add_argument('cmd', choices=['login', 'upload', 'tasks', 'folders', 'download'])
    ap.add_argument('--user', default='张大强')
    ap.add_argument('--pwd', default='tianqiao123')
    ap.add_argument('--file', default='')
    ap.add_argument('--folder', default='', help='文件夹 ID（不带则用默认 14086）')
    ap.add_argument('--resolution', default='720p', choices=['720p', '1080p', '2k'])
    ap.add_argument('--wait', action='store_true', help='上传后等待完成')
    ap.add_argument('--download-to', default='', help='完成后下载到目录')
    ap.add_argument('--task', default='', help='任务 ID（download 命令用）')
    ap.add_argument('--json', action='store_true', help='folders/tasks 以 JSON 输出（供插件解析）')
    ap.add_argument('--save-name', default='', help='download 命令：结果保存的文件名（默认从 URL 推断）')
    args = ap.parse_args()

    if args.cmd == 'login':
        tok = login(args.user, args.pwd)
        out('登录成功 token: ' + tok[:30] + '...')
    elif args.cmd == 'folders':
        fl = list_folders(args.user, args.pwd)
        if args.json:
            out(json.dumps(fl, ensure_ascii=False, default=str))
        else:
            for f in fl:
                out(f.get('ID'), f.get('name'), f.get('description'), f.get('ownerName'))
    elif args.cmd == 'tasks':
        tl = list_tasks(args.user, args.pwd)
        if args.json:
            out(json.dumps(tl, ensure_ascii=False, default=str))
        else:
            for t in tl:
                out(t.get('ID'), t.get('status'), t.get('sourceFileName'), 'cost=' + str(t.get('costCents')))
    elif args.cmd == 'upload':
        if not args.file:
            out('需要 --file'); sys.exit(1)
        folder = args.folder or '14086'
        r = upload_and_create(folder, args.file, args.resolution, args.user, args.pwd, wait=args.wait, download_to=args.download_to)
        out(json.dumps(r, ensure_ascii=False, default=str))
    elif args.cmd == 'download':
        if not args.task:
            out('需要 --task'); sys.exit(1)
        tok = get_token(args.user, args.pwd)
        dest = download_task(tok, args.task, args.download_to or os.getcwd(), args.save_name)
        if args.json:
            out(json.dumps({'ok': True, 'path': dest}, ensure_ascii=False))
        else:
            out('已下载: ' + dest)

if __name__ == '__main__':
    main()
