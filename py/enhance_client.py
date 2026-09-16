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

# ---------- 输出编码修正（重要）----------
# 中文 Windows 控制台默认 GBK(cp936)，直接 print 含 emoji（❌/✅/⚠）的文本会抛
# UnicodeEncodeError；而 out() 会静默忽略异常，导致前端拿不到任何错误信息，
# 只能显示兜底文案「请检查账号密码」，掩盖真实原因。
#
# 用 reconfigure() 原地改编码（不能用 sys.stdout = TextIOWrapper(sys.stdout.buffer)，
# 那样旧 stdout 被 GC 回收时会关掉底层 buffer，后续写入全部失败）。
# 同时保留原对象引用，避免意外回收。
_stdout_orig = sys.stdout
_stderr_orig = sys.stderr
for _stream in (sys.stdout, sys.stderr):
    try:
        enc = (_stream.encoding or '').lower()
        if enc not in ('utf-8', 'utf8') and hasattr(_stream, 'reconfigure'):
            _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

BASE = 'http://subtitle.zztianqiao.com'
# token 缓存放 collect/（插件运行时数据目录，源码同步会排除，不污染 git）
_py_dir = os.path.dirname(os.path.abspath(__file__))
_collect_dir = os.path.join(os.path.dirname(_py_dir), 'collect')
_cfg_dir = _collect_dir if os.path.isdir(_collect_dir) else _py_dir
ACCOUNT_FILE = os.path.join(_cfg_dir, 'enhance_account.json')
TOKEN_FILE = os.path.join(_cfg_dir, '_enhance_token.json')
FOLDER_FILE = os.path.join(_cfg_dir, '_enhance_folder.json')


# ---------- 账号配置（每台机器各自的账号，存 collect/enhance_account.json）----------
def load_account():
    """读用户配置的账号。返回 (user, pwd)；未配置返回 ('', '')"""
    try:
        if os.path.exists(ACCOUNT_FILE):
            j = json.load(open(ACCOUNT_FILE, encoding='utf-8'))
            return str(j.get('user') or ''), str(j.get('pwd') or '')
    except Exception:
        pass
    return '', ''


def save_account(user, pwd):
    """保存账号到本地配置"""
    try:
        os.makedirs(os.path.dirname(ACCOUNT_FILE), exist_ok=True)
        json.dump({'user': user, 'pwd': pwd}, open(ACCOUNT_FILE, 'w', encoding='utf-8'),
                  ensure_ascii=False)
        # 换账号即清掉旧 token，避免串号
        try:
            if os.path.exists(TOKEN_FILE):
                os.remove(TOKEN_FILE)
        except Exception:
            pass
        return True
    except Exception as e:
        return False


def resolve_account(user, pwd):
    """命令行没给账号时，回退到本地配置；都没有则报错"""
    if not user or not pwd:
        u2, p2 = load_account()
        user = user or u2
        pwd = pwd or p2
    if not user or not pwd:
        raise RuntimeError('未配置超分站账号：请在插件「超分」面板点「⚙ 账号」填写自己的账号')
    return user, pwd


def out(*a):
    """打印到 stdout。
    优先 UTF-8；若仍失败（极窄情况），逐级降级，保证前端一定拿得到一行结果。
    """
    msg = ' '.join(str(x) for x in a)
    try:
        print(msg)
        return
    except Exception:
        pass
    # 降级 1：写入底层 buffer（UTF-8 字节）
    try:
        sys.stdout.buffer.write((msg + '\n').encode('utf-8', 'replace'))
        sys.stdout.buffer.flush()
        return
    except Exception:
        pass
    # 降级 2：丢掉无法编码的字符后再试
    try:
        safe = msg.encode(sys.stdout.encoding or 'ascii', 'replace').decode(
            sys.stdout.encoding or 'ascii', 'replace')
        print(safe)
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
        raise RuntimeError('applyUpload 失败: ' + _why(d, st))
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

def report_netcheck():
    """联网自检：逐个测试关键网络点，输出可读报告。
    排查「某台电脑上不了/下载不了」时先跑这个。
    """
    import socket
    import urllib.error
    from urllib.parse import urlparse

    out('===== 超分站联网自检 =====')
    out('')

    # 1) DNS + TCP 到主站
    host = urlparse(BASE).hostname or 'subtitle.zztianqiao.com'
    out('[1] 解析并连接主站 %s' % host)
    try:
        ip = socket.gethostbyname(host)
        out('    DNS 解析: %s' % ip)
    except Exception as e:
        out('    ✗ DNS 解析失败: %s（检查网络 / DNS 设置）' % e)
        return
    try:
        s = socket.create_connection((host, 80), timeout=10)
        s.close()
        out('    ✓ TCP 80 端口可达')
    except Exception as e:
        out('    ✗ TCP 连接失败: %s（可能被防火墙 / 代理拦截）' % e)
        return
    out('')

    # 2) 主站接口可用性
    out('[2] 主站接口')
    try:
        st, d = _req('POST', '/api/base/captcha', {}, timeout=20)
        ok = isinstance(d, dict) and d.get('data')
        out('    %s /api/base/captcha → HTTP %s' % ('✓' if ok else '⚠', st))
    except Exception as e:
        out('    ✗ 接口请求失败: %s' % e)
    out('')

    # 3) 登录态（能登说明账号与主站都通）
    out('[3] 登录')
    try:
        u, p = load_account()
        if not (u and p):
            out('    ⚠ 未配置账号（跳过）')
        else:
            tok = get_token(u, p)
            out('    ✓ 登录成功（账号 %s），token 正常' % u)
            out('')
            # 4) 下载节点可达性（用最近完成的任务试）
            out('[4] 下载节点')
            try:
                tl = list_tasks(u, p, 1, 20)
                done = [t for t in tl if str(t.get('status', '')).lower() in ('succeeded', 'success', 'done')]
                if not done:
                    out('    无已完成任务，跳过下载测试')
                else:
                    tid = done[0].get('ID')
                    st, d = _req('GET', '/api/enhance/getDownloadURL?' + urllib.parse.urlencode({'ID': int(tid)}),
                                 headers_extra={'x-token': tok})
                    url = ((d or {}).get('data') or {}).get('url')
                    if not url:
                        out('    ⚠ 取下载地址失败: %s' % _why(d, st))
                    else:
                        dl_host = urlparse(url).hostname or ''
                        out('    下载地址主机: %s' % dl_host)
                        try:
                            ip2 = socket.gethostbyname(dl_host)
                            out('    DNS 解析: %s' % ip2)
                        except Exception as e:
                            out('    ✗ 下载节点 DNS 解析失败: %s（这是关键问题）' % e)
                        resp, err = _open_url_retry(url, {'User-Agent': 'Mozilla/5.0'}, 20, 1)
                        if resp is None:
                            out('    ✗ 下载地址不可达: %s' % err)
                            out('      → 该机器的网络到不了下载节点，可能是防火墙 / 代理 / 运营商问题')
                        else:
                            try:
                                ct = resp.headers.get('Content-Length') or '?'
                                out('    ✓ 下载地址可达（Content-Length=%s）' % ct)
                            finally:
                                try:
                                    resp.close()
                                except Exception:
                                    pass
            except Exception as e:
                out('    下载节点测试异常: %s' % e)
    except Exception as e:
        out('    ✗ 登录失败: %s' % e)
    out('')
    out('===== 自检结束 =====')


def _open_url_retry(url, headers=None, timeout=60, tries=3, log=None):
    """带重试地打开 URL（应对偶发网络抖动 / 临时限流）。
    返回 (response, None) 或 (None, 错误字符串)。
    注意：403/404 不重试（重试也不会好）。
    """
    import urllib.error
    hdrs = headers or {'User-Agent': 'Mozilla/5.0'}
    last = ''
    for i in range(max(1, tries)):
        try:
            req = urllib.request.Request(url, headers=hdrs)
            return urllib.request.urlopen(req, timeout=timeout), None
        except urllib.error.HTTPError as e:
            # 4xx 一般不重试（签名过期、不存等），5xx 可重试
            detail = ''
            try:
                detail = e.read(300).decode('utf-8', 'replace')
            except Exception:
                pass
            last = 'HTTP %s %s %s' % (e.code, e.reason, detail[:200])
            if 400 <= e.code < 500:
                return None, last
        except Exception as e:
            last = '%s: %s' % (type(e).__name__, e)
        if log:
            log('下载重试 %d/%d（%s）' % (i + 1, tries, last))
        time.sleep(1.5 * (i + 1))
    return None, last or '连接失败'


def _download_to_file(url, dest, progress_cb=None, log=None, timeout=60, tries=3):
    """把 URL 内容下载到 dest。
    关键加固：
      - 先写成 .part，完成且校验通过才改名，避免半截文件被当成成品
      - 返回前比对总长度，不一致则作废
      - 内容明显是错误页（HTML/XML）时直接判失败，不写成品
    """
    import urllib.error
    part = dest + '.part'

    def attempt():
        resp, err = _open_url_retry(url, {'User-Agent': 'Mozilla/5.0'}, timeout, tries, log)
        if resp is None:
            return False, err
        try:
            total = int(resp.headers.get('Content-Length') or 0)
            ctype = (resp.headers.get('Content-Type') or '').lower()
            got = 0
            last_pct = -1
            first = b''
            with open(part, 'wb') as fp:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    if len(first) < 256:
                        first += chunk[:256 - len(first)]
                    fp.write(chunk)
                    got += len(chunk)
                    if progress_cb and total > 0:
                        pct = int(got * 100 / total)
                        if pct != last_pct:
                            last_pct = pct
                            progress_cb(pct)
        finally:
            try:
                resp.close()
            except Exception:
                pass

        # 1) 长度校验
        if total > 0 and got != total:
            return False, '下载不完整：%d / %d 字节' % (got, total)
        if got == 0:
            return False, '下载内容为空'

        # 2) 内容嗅探：错误页 / 非媒体内容
        head = first[:16]
        low = first[:256].lower()
        if head[:1] == b'<' or low.lstrip().startswith(b'<!doctype') or low.lstrip().startswith(b'<?xml'):
            return False, '下载到的是网页/错误页，不是视频（签名可能已过期）：' + \
                   first[:120].decode('utf-8', 'replace')
        if 'text/html' in ctype or 'application/xml' in ctype:
            return False, '响应类型异常（%s），不是视频文件' % ctype
        return True, None

    ok, err = attempt()
    if not ok:
        try:
            if os.path.exists(part):
                os.remove(part)
        except Exception:
            pass
        return None, err
    try:
        if os.path.exists(dest):
            os.remove(dest)
        os.replace(part, dest)
    except Exception as e:
        try:
            if os.path.exists(part):
                os.remove(part)
        except Exception:
            pass
        return None, '保存文件失败：%s' % e
    return dest, None


def download_task(token, task_id, download_dir, save_name='', progress_cb=None):
    """下载超分结果到本地目录，返回保存路径。progress_cb(pct) 可传进度回调。
    下载 URL 是带时效的签名链接，若过期则重新取一次（最多 2 轮）。
    """
    from urllib.parse import urlparse
    os.makedirs(download_dir, exist_ok=True)

    last_err = '未知错误'
    for round_i in range(2):
        st, d = _req('GET', '/api/enhance/getDownloadURL?' + urllib.parse.urlencode({'ID': int(task_id)}),
                     headers_extra={'x-token': token})
        if not isinstance(d, dict) or d.get('code') != 0:
            raise RuntimeError('获取下载地址失败: ' + _why(d, st))
        url = (d.get('data') or {}).get('url')
        if not url:
            raise RuntimeError('接口未返回下载地址（任务可能尚未完成或已过期）')

        fname = save_name or (os.path.basename(urlparse(url).path) or ('result_' + str(task_id) + '.mp4'))
        dest = os.path.join(download_dir, fname)
        got, err = _download_to_file(url, dest, progress_cb)
        if got:
            return got
        last_err = err or '未知错误'
        # 若是签名过期类错误，重新取地址再试一轮
        if round_i == 0 and ('403' in last_err or '过期' in last_err or '错误页' in last_err):
            continue
        break
    raise RuntimeError('下载失败: ' + str(last_err))


def list_folders(username, password):
    token = get_token(username, password)
    st, d = _req('GET', '/api/erase/getFolderList', headers_extra={'x-token': token})
    if not isinstance(d, dict) or d.get('code') != 0:
        raise RuntimeError(_why(d, st))
    return (d.get('data') or {}).get('list') or []

def list_tasks(username, password, page=1, page_size=50):
    token = get_token(username, password)
    st, d = _req('GET', '/api/enhance/getTaskList?' + urllib.parse.urlencode({'page': page, 'pageSize': page_size}),
                 headers_extra={'x-token': token})
    if d.get('code') != 0:
        raise RuntimeError(_why(d, st))
    return (d.get('data') or {}).get('list') or []

# ==================== 去字幕（erase）====================
# 与超分不同：走火山 VOD 点播上传，流程为
#   applyVodUpload(fileName,fileSize)  ← 注意：此接口是 GET（POST 会 404）
#   → PUT https://{uploadHost}/{storeUri}（带 Authorization / Content-CRC32: Ignore）
#   → commitVodUpload({sessionKey}) → 拿 vid（POST）
#   → createTask({folderID,inputVid,sourceFileName})（POST）

def _why(d, http_status=None):
    """把接口失败原因说清楚：msg 为空时回退到 _raw / data / code，避免报出 "None"。"""
    if not isinstance(d, dict):
        return 'HTTP ' + str(http_status) + ' ' + str(d)[:200]
    msg = d.get('msg') or d.get('message') or d.get('error')
    if msg:
        return str(msg)
    if d.get('_raw'):
        return 'HTTP ' + str(http_status) + ' ' + str(d.get('_raw'))
    return 'code=' + str(d.get('code')) + ' 响应=' + json.dumps(d, ensure_ascii=False)[:200]


def erase_apply_upload(token, file_path):
    fname = os.path.basename(file_path)
    fsize = os.path.getsize(file_path)
    # 该接口是 GET（参数走 query），POST 会返回 404
    st, d = _req('GET', '/api/erase/applyVodUpload?' + urllib.parse.urlencode(
        {'fileName': fname, 'fileSize': fsize}), headers_extra={'x-token': token})
    if not isinstance(d, dict) or d.get('code') != 0:
        raise RuntimeError('applyVodUpload 失败: ' + _why(d, st))
    data = d.get('data') or {}
    for k in ('uploadHost', 'storeUri', 'auth', 'sessionKey'):
        if not data.get(k):
            raise RuntimeError('applyVodUpload 未返回 ' + k + ': ' + json.dumps(d, ensure_ascii=False)[:300])
    return data


def erase_put_vod(data, file_path):
    """PUT 直传到火山 VOD。流式读文件，避免整份载入内存。"""
    import urllib.error
    host = str(data['uploadHost']).rstrip('/')
    uri = str(data['storeUri']).lstrip('/')
    url = 'https://' + host + '/' + uri
    ext = os.path.splitext(file_path)[1].lower().lstrip('.')
    ctype = {'mp4': 'video/mp4', 'mov': 'video/quicktime', 'mkv': 'video/x-matroska',
             'avi': 'video/x-msvideo', 'flv': 'video/x-flv', 'wmv': 'video/x-ms-wmv'}.get(
        ext, 'application/octet-stream')
    total = os.path.getsize(file_path)
    headers = {
        'Authorization': str(data['auth']),
        'Content-CRC32': 'Ignore',
        'Content-Type': ctype,
        'Content-Length': str(total),
        'User-Agent': 'Mozilla/5.0',
    }
    fp = open(file_path, 'rb')
    try:
        req = urllib.request.Request(url, data=fp, method='PUT', headers=headers)
        resp = urllib.request.urlopen(req, timeout=3600)
        code = resp.status
        resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError('VOD 上传失败 HTTP ' + str(e.code) + ': ' + e.read(300).decode('utf-8', 'replace'))
    finally:
        fp.close()
    if code not in (200, 201, 204):
        raise RuntimeError('VOD 上传失败 HTTP ' + str(code))
    return code


def erase_commit_upload(token, session_key):
    st, d = _req('POST', '/api/erase/commitVodUpload', {'sessionKey': session_key},
                 headers_extra={'x-token': token})
    if not isinstance(d, dict) or d.get('code') != 0:
        raise RuntimeError('commitVodUpload 失败: ' + _why(d, st))
    vid = (d.get('data') or {}).get('vid')
    if not vid:
        raise RuntimeError('VOD 未返回 Vid')
    return vid


def erase_create_task(token, folder_id, vid, file_name):
    st, d = _req('POST', '/api/erase/createTask',
                 {'folderID': int(folder_id), 'inputVid': vid, 'sourceFileName': file_name},
                 headers_extra={'x-token': token})
    if not isinstance(d, dict) or d.get('code') != 0:
        raise RuntimeError('创建任务失败: ' + _why(d, st))
    return (d.get('data') or {})


def erase_submit(folder_id, file_path, username='', password='', wait=False,
                 poll_interval=20, poll_max=3600, download_to=''):
    """完整去字幕提交：上传 → 提交 VOD → 建任务（可选等结果并下载）"""
    token = get_token(username, password)
    fname = os.path.basename(file_path)
    out('⬆ 申请 VOD 上传凭据：' + fname)
    up = erase_apply_upload(token, file_path)
    mb = round(os.path.getsize(file_path) / 1048576.0, 1)
    out('⬆ 上传中（' + str(mb) + ' MB）…')
    erase_put_vod(up, file_path)
    out('⬆ 上传完成，提交 VOD…')
    vid = erase_commit_upload(token, up['sessionKey'])
    out('✅ VOD 已受理 vid=' + str(vid))
    task = erase_create_task(token, folder_id, vid, fname)
    task_id = task.get('ID') or task.get('id')
    out('✅ 去字幕任务已创建 ID=' + str(task_id))
    if not wait:
        return {'ok': True, 'task_id': task_id}

    deadline = time.time() + poll_max
    while time.time() < deadline:
        time.sleep(poll_interval)
        st, dl = _req('GET', '/api/erase/getTaskList?' + urllib.parse.urlencode({'page': 1, 'pageSize': 30}),
                      headers_extra={'x-token': token})
        for t in (dl.get('data') or {}).get('list') or []:
            if t.get('ID') == task_id:
                status = t.get('status')
                out('  状态: ' + str(status), '进度=' + str(t.get('progress')) + '%')
                if status == 'succeeded':
                    out('✅ 去字幕完成，结果: ' + str(t.get('resultFileName')))
                    if download_to:
                        src_base = os.path.splitext(fname)[0]
                        saved = erase_download(token, task_id, download_to, src_base + '_nosub.mp4')
                        out('已下载: ' + saved)
                        t['downloaded'] = saved
                    return {'ok': True, 'task_id': task_id, 'status': status, 'result': t}
                if status == 'failed':
                    raise RuntimeError('任务失败: ' + str(t.get('errorMessage')))
    raise RuntimeError('等待超时')


def erase_download(token, task_id, download_dir, save_name=''):
    """下载去字幕结果（mode=download）"""
    os.makedirs(download_dir, exist_ok=True)
    fname = save_name or ('erase_' + str(task_id) + '.mp4')
    dest = os.path.join(download_dir, fname)

    last_err = '未知错误'
    for round_i in range(2):
        st, d = _req('GET', '/api/erase/getDownloadURL?' + urllib.parse.urlencode({'ID': int(task_id), 'mode': 'download'}),
                     headers_extra={'x-token': token})
        if not isinstance(d, dict) or d.get('code') != 0:
            raise RuntimeError('获取下载地址失败: ' + _why(d, st))
        url = (d.get('data') or {}).get('url')
        if not url:
            raise RuntimeError('接口未返回下载地址（任务可能尚未完成或已过期）')

        def cb(pct):
            try:
                sys.stderr.write('DLP:%d\n' % pct)
                sys.stderr.flush()
            except Exception:
                pass

        got, err = _download_to_file(url, dest, cb)
        if got:
            return got
        last_err = err or '未知错误'
        if round_i == 0 and ('403' in last_err or '过期' in last_err or '错误页' in last_err):
            continue
        break
    raise RuntimeError('下载失败: ' + str(last_err))


def erase_list_tasks(username, password, page=1, page_size=50):
    token = get_token(username, password)
    st, d = _req('GET', '/api/erase/getTaskList?' + urllib.parse.urlencode({'page': page, 'pageSize': page_size}),
                 headers_extra={'x-token': token})
    if not isinstance(d, dict) or d.get('code') != 0:
        raise RuntimeError(_why(d, st))
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
    ap.add_argument('cmd', choices=['login', 'account', 'upload', 'tasks', 'folders', 'download',
                                    'erase', 'erase-tasks', 'erase-download', 'netcheck'])
    ap.add_argument('--user', default='', help='超分站账号（不传则读本地配置）')
    ap.add_argument('--pwd', default='', help='超分站密码')
    ap.add_argument('--file', default='')
    ap.add_argument('--folder', default='', help='文件夹 ID（不带则用默认 14086）')
    ap.add_argument('--resolution', default='720p', choices=['720p', '1080p', '2k'])
    ap.add_argument('--wait', action='store_true', help='上传后等待完成')
    ap.add_argument('--download-to', default='', help='完成后下载到目录')
    ap.add_argument('--task', default='', help='任务 ID（download 命令用）')
    ap.add_argument('--json', action='store_true', help='folders/tasks 以 JSON 输出（供插件解析）')
    ap.add_argument('--save-name', default='', help='download 命令：结果保存的文件名（默认从 URL 推断）')
    args = ap.parse_args()

    if args.cmd == 'account':
        # 查看 / 设置账号
        if args.file:   # 借用 --file 传新账号（user:pwd 格式）避免加参数
            u, _, p = args.file.partition(':')
            if save_account(u.strip(), p.strip()):
                out('✅ 账号已保存')
            else:
                out('❌ 保存失败')
        else:
            u, p = load_account()
            out(json.dumps({
                'configured': bool(u and p),
                'user': u,
                'pwdLen': len(p),
            }, ensure_ascii=False))
    elif args.cmd == 'login':
        try:
            u, p = resolve_account(args.user, args.pwd)
            tok = login(u, p)
            out('登录成功 token: ' + tok[:30] + '...')
        except Exception as e:
            out('❌ ' + str(e))
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
    elif args.cmd == 'erase':
        if not args.file:
            out('需要 --file'); sys.exit(1)
        folder = args.folder or '14086'
        r = erase_submit(folder, args.file, args.user, args.pwd, wait=args.wait, download_to=args.download_to)
        out(json.dumps(r, ensure_ascii=False, default=str))
    elif args.cmd == 'erase-tasks':
        tl = erase_list_tasks(args.user, args.pwd)
        if args.json:
            out(json.dumps(tl, ensure_ascii=False, default=str))
        else:
            for t in tl:
                out(t.get('ID'), t.get('status'), t.get('sourceFileName'))
    elif args.cmd == 'erase-download':
        if not args.task:
            out('需要 --task'); sys.exit(1)
        tok = get_token(args.user, args.pwd)
        dest = erase_download(tok, args.task, args.download_to or os.getcwd(), args.save_name)
        if args.json:
            out(json.dumps({'ok': True, 'path': dest}, ensure_ascii=False))
        else:
            out('已下载: ' + dest)
    elif args.cmd == 'download':
        if not args.task:
            out('需要 --task'); sys.exit(1)
        tok = get_token(args.user, args.pwd)
        def _cb(pct):
            # 进度行 DLP:xx，供前端 spawn 实时解析；同时 stderr 避免污染 stdout 最终 JSON
            try:
                sys.stderr.write('DLP:%d\n' % pct)
                sys.stderr.flush()
            except Exception:
                pass
        dest = download_task(tok, args.task, args.download_to or os.getcwd(), args.save_name, _cb)
        if args.json:
            out(json.dumps({'ok': True, 'path': dest}, ensure_ascii=False))
        else:
            out('已下载: ' + dest)
    elif args.cmd == 'netcheck':
        # 联网自检：诊断超分站与下载节点是否可达（其他电脑上排查用）
        report_netcheck()

if __name__ == '__main__':
    main()
