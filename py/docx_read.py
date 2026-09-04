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
    类型：ep_title 集标题 / scene 场次 / cast 人物表 / action 动作(△) /
          dialogue 台词(角色名: 英文) / caption 字幕标注 / plain 其他
    """
    out = []
    cur = None
    for l in lines:
        m = re.match(r'^第\s*([0-9一二两三四五六七八九十百千]+)\s*集', l)
        if m:
            cur = cn_to_int(m.group(1))
        out.append({'text': l, 'episode': cur, 'type': classify_line(l)})
    return out


def classify_line(l):
    """判断一行属于哪种类型"""
    t = l.strip()
    if not t:
        return 'plain'
    # 集标题
    if re.match(r'^第\s*[0-9一二两三四五六七八九十百千]+\s*集', t):
        return 'ep_title'
    # 场景标题：数字-数字 开头（场次）
    if re.match(r'^\d+[-_]\d+', t):
        return 'scene'
    # 人物表
    if t.startswith('人物') or t.startswith('人物：') or t.startswith('演员'):
        return 'cast'
    # 动作/旁白：△ 开头
    if t.startswith('△') or t.startswith('▲') or t.startswith('【') or t.startswith('（旁白）') or t.startswith('(旁白)'):
        return 'action'
    # 字幕标注：字幕：xxx
    if t.startswith('字幕') or t.startswith('字幕：') or t.startswith('【字幕'):
        return 'caption'
    # 台词：角色名(:中文动作)：英文台词 或 角色名: 台词
    # 特征：行首是角色名（大写字母/中文名/含括号标注），后跟冒号，冒号后有大写英文
    dlg = re.match(r'^([^:：]{1,40}?)[（(][^）)]{0,50}[）)]?\s*[:：]\s*(.+)$', t)
    if dlg:
        role = dlg.group(1).strip()
        speech = dlg.group(2).strip()
        # 角色名特征：全大写英文 / 首字母大写英文词 / 中文名
        role_ok = re.match(r'^[A-Z][A-Za-z \'.\-]{0,30}$', role) or re.match(r'^[\u4e00-\u9fff]{1,6}$', role) or 'VO' in role or 'OS' in role
        if role_ok and speech:
            return 'dialogue'
    # 行首直接英文冒号（如 LORIEL: xxx）
    dlg2 = re.match(r'^([A-Z][A-Za-z \'.]{1,30})\s*[:：]\s*(.+)$', t)
    if dlg2:
        return 'dialogue'
    return 'plain'


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
