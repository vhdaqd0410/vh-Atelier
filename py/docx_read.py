# -*- coding: utf-8 -*-
"""
剧本阅读器（vh-Atelier 剧本页）
输入 docx，输出段落 JSON 到 stdout，供前端渲染「原剧本」阅读视图。
结构: { ok, lines: [ {text, episode} ] }  episode 为该段所属集数（第X集），无则 null
用法: python docx_read.py --docx <path> [--out <json>]
"""
import sys, re, json, zipfile, html as htmlmod

if sys.version_info[0] >= 3:
    try:
        sys.stdout = __import__('io').TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    except Exception:
        pass

CN_NUM = {'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
          '百':100,'千':1000}


def cn_to_int(s):
    s = s.strip()
    if s.isdigit():
        return int(s)
    total = 0
    section = 0
    for ch in s:
        if ch == '十':
            if section == 0:
                section = 1
            total += section * 10
            section = 0
        elif ch == '百':
            total += (section or 1) * 100
            section = 0
        elif ch == '千':
            total += (section or 1) * 1000
            section = 0
        else:
            section = CN_NUM.get(ch, 0)
    total += section
    return total


def docx_to_lines(path):
    z = zipfile.ZipFile(path)
    xml = z.read('word/document.xml').decode('utf-8', errors='replace')
    # 段落 + 段内行（w:br 分出的可视行也拆开，接近原排版）
    paras = re.findall(r'<w:p[ >].*?</w:p>', xml, re.S)
    lines = []
    for para in paras:
        # 段内按 <w:br/> 拆成多行（用分两组的 findall，文本组可能无内容）
        parts = []
        buf = ''
        # 按 br 或 t 顺序扫描
        for m in re.finditer(r'<w:br[ \t\r\n]*/>|<w:t(?=[ >])[^>]*>(.*?)</w:t>', para, re.S):
            if m.group(0).startswith('<w:br'):
                parts.append(buf)
                buf = ''
            else:
                buf += m.group(1) or ''
        parts.append(buf)
        for seg in parts:
            seg = htmlmod.unescape(seg).strip()
            # 过滤域代码/XML 残留（目录页的 <w:tab> 等）和纯控制内容
            if not seg or '<' in seg and '>' in seg:
                continue
            if seg.startswith('<') or seg.endswith('>'):
                continue
            lines.append(seg)
    return lines


def parse(lines):
    """给每段标注所属集数 + 行类型（供前端易读排版）
    两遍扫描：先收集角色名（cast 行），再用角色名识别台词行，中英文剧都适用。
    类型：ep_title 集标题 / scene 场次 / cast 人物表 / action 动作(△) /
          dialogue 台词 / caption 字幕标注 / plain 其他
    """
    out = []
    cur = None
    # 第一遍：集数 + 基础类型，同时收集角色名
    roles = []
    for l in lines:
        m = re.match(r'^第\s*([0-9一二两三四五六七八九十百千]+)\s*集', l)
        if m:
            cur = cn_to_int(m.group(1))
        tp = classify_basic(l)
        if tp == 'ep_title':
            cur = cn_to_int(re.match(r'^第\s*([0-9一二两三四五六七八九十百千]+)\s*集', l).group(1))
        # 从 cast 行收集角色
        if tp == 'cast':
            names = re.findall(r'[\u4e00-\u9fff]{2,6}|[A-Z][A-Za-z \'.-]{2,30}', l)
            for nm in names:
                nm = nm.strip()
                if len(nm) >= 2 and nm not in roles:
                    roles.append(nm)
        out.append({'text': l, 'episode': cur, 'type': tp})
    # 第二遍：用角色名把台词行标出来
    for item in out:
        if item['type'] != 'plain':
            continue
        if is_dialogue(item['text'], roles):
            item['type'] = 'dialogue'
    return out


def classify_basic(l):
    """基础分类（不含台词识别，台词由角色名二次判定）"""
    t = l.strip()
    if not t:
        return 'plain'
    if re.match(r'^第\s*[0-9一二两三四五六七八九十百千]+\s*集', t):
        return 'ep_title'
    if re.match(r'^\d+[-_]\d+', t):
        return 'scene'
    if t.startswith('人物') or t.startswith('人物：') or t.startswith('演员'):
        return 'cast'
    if t.startswith('△') or t.startswith('▲') or t.startswith('【') or t.startswith('（旁白）') or t.startswith('(旁白)') or t.startswith('字幕：') or t.startswith('【字幕'):
        if t.startswith('字幕') or t.startswith('【字幕'):
            return 'caption'
        return 'action'
    return 'plain'


def is_dialogue(t, roles):
    """判断一行是否台词：行首附近出现已知角色名，且其后有冒号+内容"""
    # 英文/中文剧本：角色名（可能带 (VO)/(OS)/（动作）标注）后跟冒号 + 内容
    # 角色名 = 英文大写名 或 纯中文名，后可选 半角/全角括号 动作标注
    if re.match(r'^[A-Z][A-Za-z \'\.]{1,40}?(?:\([^)]*\)|（[^）]*）)?\s*[:：]\s*.+', t):
        return True
    # 纯中文名 + 可选动作括号 + 冒号
    if re.match(r'^[\u4e00-\u9fff]{1,8}(?:\([^)]*\)|（[^）]*）)?\s*[:：]\s*.+', t):
        return True
    # 角色名 + 中文动作描述 + ：台词（如「何飞惊恐连忙挂断电话：你疯了？」）
    for r in roles:
        if len(r) < 2:
            continue
        head = t[:24]
        if r in head and '：' in t[:60]:
            return True
    return False


def main():
    args = {}
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        if argv[i].startswith('--') and i + 1 < len(argv):
            args[argv[i]] = argv[i + 1]
            i += 2
        else:
            i += 1
    docx_path = args.get('--docx')
    out_path = args.get('--out')
    if not docx_path:
        print(json.dumps({'ok': False, 'error': '缺少 --docx'}, ensure_ascii=False))
        return
    try:
        lines = docx_to_lines(docx_path)
        parsed = parse(lines)
        # 集数清单
        eps = sorted(set(x['episode'] for x in parsed if x['episode'] is not None))
        result = {'ok': True, 'fileName': docx_path.split('\\')[-1], 'episodes': eps, 'lines': parsed}
        txt = json.dumps(result, ensure_ascii=False)
        if out_path:
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(txt)
        else:
            print(txt)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
