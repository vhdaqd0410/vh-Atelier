# -*- coding: utf-8 -*-
"""
字幕校对引擎（vh-Atelier 第 5 板块）
用途：AI 漫剧里，配音是照着剧本念的，字幕（whisper/FunASR 听写）应与剧本台词逐字一致。
本脚本做三件事：
  1. 从剧本 docx 抽取指定集的台词（标准答案）
  2. 解析 SRT 字幕
  3. 全局词级对齐，定位三类差异：
     - replace：字幕听错词（mutinous → mutism）
     - delete ：字幕幻觉重复（同一句连续出现多次）
     - insert ：字幕漏词（剧本有、字幕缺）
输出 JSON 差异清单，每条带「该条字幕修正后的完整文本 fixedText」，
前端据此渲染差异列表、打勾后一键应用。

纯标准库，无第三方依赖。
用法：
  python subtitle_check.py --docx <剧本.docx> --srt <字幕.srt> --episode <第X集> --out <result.json>
"""
import sys
import io
import re
import json
import html as htmlmod
import zipfile
import difflib

# 让 stdout 输出 UTF-8（Windows 下避免 GBK 崩溃）
if sys.version_info[0] >= 3:
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    except Exception:
        pass

# ---------- 中文数字 → 阿拉伯 ----------
CN_NUM = {'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9}

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
        else:
            section = CN_NUM.get(ch, 0)
    total += section
    return total

def parse_episode(user_input):
    """把用户输入的集数（'第一集'/'1'/'第1集'/'01'）规范化为阿拉伯数字"""
    s = user_input.strip()
    m = re.search(r'([一二两三四五六七八九十百零\d]+)', s)
    if not m:
        return None
    return cn_to_int(m.group(1))

# ---------- docx 解析 ----------
def docx_to_lines(path):
    """解出 word/document.xml 的文本行（每段一行）"""
    z = zipfile.ZipFile(path)
    xml = z.read('word/document.xml').decode('utf-8', errors='replace')
    paras = re.findall(r'<w:p[ >].*?</w:p>', xml, re.S)
    lines = []
    for para in paras:
        texts = re.findall(r'<w:t[^>]*>(.*?)</w:t>', para, re.S)
        lines.append(''.join(texts))
    return lines

def extract_dialogues(lines):
    """从剧本文本行抽取台词。台词行格式：中文角色名（动作标注）：英文台词
    跳过纯动作行（△开头）、【字幕：】标注等。
    """
    dialogues = []
    cur_episode = None
    role_line = re.compile(r'^([^\n:：]{1,30}?)[（(][^）)]{0,40}[）)]?\s*[:：]\s*(.+)$')
    role_plain = re.compile(r'^([^\n:：]{1,20})\s*[:：]\s*(.+)$')
    for line in lines:
        raw = htmlmod.unescape(line).strip()
        if not raw:
            continue
        # 集标题
        m = re.match(r'^第([一二两三四五六七八九十百零\d]+)集$', raw)
        if m:
            cur_episode = cn_to_int(m.group(1))
            continue
        # 跳过纯动作/字幕标注行（这些不以角色名开头，role_line/plain 不会匹配，但仍显式排除）
        if raw.startswith('△') or raw.startswith('【'):
            continue
        m = role_line.match(raw) or role_plain.match(raw)
        if not m:
            continue
        role = m.group(1).strip()
        text = m.group(2).strip()
        if not text or not re.match(r'^[A-Za-z\'"“”]', text):
            continue
        # 去掉台词里嵌入的中文全角括号动作标注（如"（兔耳朵向前探）"）
        text = re.sub(r'（[^）]*）', '', text)
        text = text.strip()
        if not text:
            continue
        dialogues.append({'episode': cur_episode, 'role': role, 'raw': text})
    return dialogues

# ---------- 归一化 ----------
_ABBR = {
    "can't":'cannot', "won't":'will not', "don't":'do not', "didn't":'did not',
    "doesn't":'does not', "i'm":'i am', "i've":'i have', "you're":'you are',
    "you've":'you have', "he's":'he is', "she's":'she is', "it's":'it is',
    "that's":'that is', "what's":'what is', "there's":'there is', "we're":'we are',
    "they're":'they are', "i'll":'i will', "we'll":'we will', "he'll":'he will',
    "she'll":'she will', "that'll":'that will', "what'll":'what will',
    "haven't":'have not', "hasn't":'has not', "isn't":'is not', "aren't":'are not',
    "wasn't":'was not', "weren't":'were not', "i'd":'i would', "you'd":'you would',
    "name's":'name is',
}
_NUM = {'zero':'0','one':'1','two':'2','three':'3','four':'4','five':'5','six':'6',
        'seven':'7','eight':'8','nine':'9','ten':'10','twenty':'20','thirty':'30',
        'forty':'40','fifty':'50','sixty':'60','seventy':'70','eighty':'80','ninety':'90'}

def normalize_word(w):
    """把单个英文词归一化（小写、展开缩写、数字统一、去标点）"""
    w = w.lower()
    for k, v in _ABBR.items():
        if w == k:
            return v
    for k, v in _NUM.items():
        if w == k:
            return v
    # 去词内标点（如 "BAM," → "bam"），但保留字母数字
    w = re.sub(r'[^a-z0-9]', '', w)
    return w

def tokenize_rich(s):
    """把一句话按词切分，返回 [{norm, orig, start, end}]。
    norm 为归一化词（可能为空则整词跳过），orig 为原文词，start/end 为字符偏移。
    """
    toks = []
    for m in re.finditer(r"[A-Za-z0-9'’\-]+", s):
        orig = m.group(0)
        norm = normalize_word(orig)
        if not norm:
            continue
        toks.append({'norm': norm, 'orig': orig, 'start': m.start(), 'end': m.end()})
    return toks

# ---------- SRT 解析 ----------
def parse_srt(path):
    content = open(path, encoding='utf-8', errors='replace').read()
    subs = []
    for block in re.split(r'\n\s*\n', content):
        block = block.strip()
        if not block:
            continue
        m = re.search(r'(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})', block)
        if not m:
            continue
        lines_b = block.split('\n')
        text = ' '.join(l.strip() for l in lines_b
                        if not re.match(r'^\d+$', l.strip()) and '-->' not in l).strip()
        subs.append({'start': m.group(1), 'end': m.group(2), 'text': text})
    return subs

# ---------- 主对齐 ----------
def align(ep_dialogues, subs):
    # 字幕侧 token 流（带归属）
    sub_tokens = []   # 扁平 norm 序列
    sub_meta = []     # 每个 token 的 {subIdx, orig, start, end}
    for si, sub in enumerate(subs):
        for t in tokenize_rich(sub['text']):
            sub_tokens.append(t['norm'])
            sub_meta.append({'subIdx': si, 'orig': t['orig'], 'start': t['start'], 'end': t['end']})

    # 剧本侧 token 流（带归属）
    script_tokens = []
    script_meta = []
    for di, d in enumerate(ep_dialogues):
        for t in tokenize_rich(d['raw']):
            script_tokens.append(t['norm'])
            script_meta.append({'dlgIdx': di, 'orig': t['orig']})

    sm = difflib.SequenceMatcher(None, sub_tokens, script_tokens, autojunk=False)
    opcodes = sm.get_opcodes()

    issues = []
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == 'equal':
            continue
        if tag == 'replace':
            # replace 块可能同时混有「听错词」「漏词」「多余词」，
            # 拆分：前 min(a,b) 个词做 1:1 替换，多出的剧本词=漏词，多出的字幕词=多余
            a = i2 - i1   # 字幕侧词数
            b = j2 - j1   # 剧本侧词数
            n = min(a, b)
            # --- 1:1 替换（要求这 n 个字幕词落在同一条字幕内）---
            if n > 0:
                idxs = sorted(set(sub_meta[k]['subIdx'] for k in range(i1, i1 + n)))
                if len(idxs) == 1:
                    si = idxs[0]
                    sub = subs[si]
                    affected = [sub_meta[k] for k in range(i1, i1 + n)]
                    cs = min(x['start'] for x in affected)
                    ce = max(x['end'] for x in affected)
                    correct = [script_meta[k]['orig'] for k in range(j1, j1 + n)]
                    replacement = ' '.join(correct)
                    fixed = sub['text'][:cs] + replacement + sub['text'][ce:]
                    bad_words = ' '.join(x['orig'] for x in affected)
                    issues.append({
                        'type': 'replace',
                        'subIdx': si,
                        'subStart': sub['start'],
                        'subEnd': sub['end'],
                        'subText': sub['text'],
                        'fixedText': fixed,
                        'detail': bad_words + ' → ' + replacement,
                    })
                else:
                    # 替换词跨多条字幕，整段替换兜底
                    correct = [script_meta[k]['orig'] for k in range(j1, j1 + n)]
                    replacement = ' '.join(correct)
                    issues.append({
                        'type': 'replace',
                        'subIdxs': idxs,
                        'subStart': subs[idxs[0]]['start'],
                        'subEnd': subs[idxs[-1]]['end'],
                        'subText': ' | '.join(subs[x]['text'] for x in idxs),
                        'fixedText': replacement,
                        'detail': '整段替换：' + replacement,
                    })
            # --- 多出的剧本词 = 漏词（insert）---
            if b > a:
                missing = ' '.join(script_meta[k]['orig'] for k in range(j1 + n, j2))
                # 判断多余词归属：若其后剧本词与下一字幕词重新对齐（相等），
                # 说明这其实是「下一条字幕的开头漏词」，应 prepend 到下一条
                if (j2 < len(script_tokens) and i2 < len(sub_tokens)
                        and script_tokens[j2] == sub_tokens[i2]):
                    target = sub_meta[i2]['subIdx']
                    sub = subs[target]
                    issues.append({
                        'type': 'insert',
                        'subIdx': target,
                        'subStart': sub['start'],
                        'subEnd': sub['end'],
                        'subText': sub['text'],
                        'fixedText': missing + ' ' + sub['text'],
                        'insertText': missing,
                        'detail': '漏词：' + missing + '（加到下句开头）',
                    })
                else:
                    target = idxs[len(idxs) - 1] if idxs else 0
                    sub = subs[target]
                    issues.append({
                        'type': 'insert',
                        'subIdx': target,
                        'subStart': sub['start'],
                        'subEnd': sub['end'],
                        'subText': sub['text'],
                        'fixedText': sub['text'] + ' ' + missing,
                        'insertText': missing,
                        'detail': '漏词：' + missing + '（加到句尾）',
                    })
            # --- 多出的字幕词 = 多余（delete）---
            if a > b:
                idxs = sorted(set(sub_meta[k]['subIdx'] for k in range(i1 + n, i2)))
                extra = ' '.join(sub_meta[k]['orig'] for k in range(i1 + n, i2))
                issues.append({
                    'type': 'delete',
                    'subIdxs': idxs,
                    'subStart': subs[idxs[0]]['start'],
                    'subEnd': subs[idxs[-1]]['end'],
                    'subText': ' | '.join(subs[x]['text'] for x in idxs),
                    'fixedText': None,
                    'detail': '多余：' + extra[:80],
                })
        elif tag == 'delete':
            # 字幕多出的词（幻觉重复）
            idxs = sorted(set(sub_meta[k]['subIdx'] for k in range(i1, i2)))
            extra = ' '.join(sub_meta[k]['orig'] for k in range(i1, i2))
            issues.append({
                'type': 'delete',
                'subIdxs': idxs,
                'subStart': subs[idxs[0]]['start'],
                'subEnd': subs[idxs[-1]]['end'],
                'subText': ' | '.join(subs[x]['text'] for x in idxs),
                'fixedText': None,
                'detail': '重复/多余（' + str(len(idxs)) + ' 条）：' + extra[:80],
            })
        elif tag == 'insert':
            # 剧本有、字幕漏。插入点 i1：把漏词 prepend 到插入点后第一个词所在的字幕
            if i1 < len(sub_meta):
                target = sub_meta[i1]['subIdx']   # 插入点后第一个词的字幕
            else:
                target = len(subs) - 1             # 词流末尾：追加到最后一条
            missing = ' '.join(script_meta[k]['orig'] for k in range(j1, j2))
            sub = subs[target]
            issues.append({
                'type': 'insert',
                'subIdx': target,
                'subStart': sub['start'],
                'subEnd': sub['end'],
                'subText': sub['text'],
                'fixedText': missing + ' ' + sub['text'],
                'insertText': missing,
                'detail': '漏词：' + missing + '（加到句首）',
            })
    return issues

def main():
    args = {}
    i = 0
    argv = sys.argv[1:]
    while i < len(argv):
        if argv[i].startswith('--') and i + 1 < len(argv):
            args[argv[i]] = argv[i + 1]
            i += 2
        else:
            i += 1

    docx_path = args.get('--docx')
    srt_path = args.get('--srt')
    episode_in = args.get('--episode', '1')
    out_path = args.get('--out')

    if not docx_path or not srt_path:
        print(json.dumps({'ok': False, 'error': '缺少 --docx 或 --srt 参数'}, ensure_ascii=False))
        return

    try:
        ep_num = parse_episode(episode_in)
        if ep_num is None:
            print(json.dumps({'ok': False, 'error': '无法解析集数: ' + episode_in}, ensure_ascii=False))
            return

        lines = docx_to_lines(docx_path)
        dialogues = extract_dialogues(lines)
        ep_dialogues = [d for d in dialogues if d['episode'] == ep_num]
        subs = parse_srt(srt_path)

        if not ep_dialogues:
            print(json.dumps({'ok': False,
                              'error': '剧本中未找到第 ' + str(ep_num) + ' 集的台词',
                              'availableEpisodes': sorted(set(d['episode'] for d in dialogues if d['episode']))},
                             ensure_ascii=False))
            return

        issues = align(ep_dialogues, subs)

        result = {
            'ok': True,
            'episode': '第' + str(ep_num) + '集',
            'dialogueCount': len(ep_dialogues),
            'srtCount': len(subs),
            'issueCount': len(issues),
            'issues': issues,
        }
        txt = json.dumps(result, ensure_ascii=False)
        if out_path:
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(txt)
        print(txt)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
