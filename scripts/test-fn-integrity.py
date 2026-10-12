# -*- coding: utf-8 -*-
"""静态门禁：面板内「调用了本文件未定义的函数」——防同类同步遗漏导致的空白面板

由来：A 版素材库的 media.js 调用了 renderComputerNav() 但该函数没同步过来，
运行时直接抛异常 → 目录树空白。此类问题静态即可发现，不必等运行时。

在插件目录下运行：python scripts/test-fn-integrity.py
"""
import os, sys, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]):
    D = os.path.abspath(sys.argv[1])
elif os.path.basename(_HERE).lower() == 'scripts':
    D = os.path.dirname(_HERE)
else:
    D = r'F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier'

CHECK = ['js/media.js']

FUNC_PATS = [r'function\s+(\w+)\s*\(',
             r'var\s+(\w+)\s*=\s*function',
             r'(\w+)\s*:\s*function\s*\(',
             r'window\.(\w+)\s*=\s*function']

WHITELIST = set("""
if for while switch catch function return typeof new delete void in of instanceof
addEventListener removeEventListener dispatchEvent
appendChild createElement createTextNode createDocumentFragment insertBefore removeChild
forEach map filter sort push unshift splice slice concat join indexOf lastIndexOf
replace match test search split trim padStart padEnd
parseInt parseFloat isNaN isFinite String Number Boolean Array Object JSON Math Date RegExp Error
setTimeout clearTimeout setInterval clearInterval requestAnimationFrame
require alert confirm prompt
getElementById querySelector querySelectorAll closest contains classList toggle
charAt charCodeAt slice substring substr toLowerCase toUpperCase
getBoundingClientRect offsetWidth offsetHeight clientWidth clientHeight scrollTop scrollHeight
setAttribute getAttribute removeAttribute hasAttribute focus blur select click scrollIntoView
existsSync readdirSync statSync lstatSync readFileSync writeFileSync mkdirSync unlinkSync rmdirSync
copyFileSync renameSync openSync closeSync createReadStream createWriteStream
join dirname basename extname resolve normalize relative isAbsolute
parse stringify keys values assign entries from isArray freeze
then resolve reject all race finally
isDirectory isFile
""".split())

PREFIXES = ('render', 'list', 'show', 'make', 'ensure', 'update', 'load', 'save', 'build',
            'apply', 'fill', 'pick', 'refresh', 'walk', 'expand', 'subCount', 'fileKind',
            'natCmp', 'dirName', 'confirmProject', 'flash', 'setRoot')


def defined_names(src):
    names = set()
    for pat in FUNC_PATS:
        names |= set(re.findall(pat, src))
    return names


fails = []
print('=== 面板函数完整性（静态） ===')
for rel in CHECK:
    p = os.path.join(D, rel.replace('/', os.sep))
    if not os.path.isfile(p):
        print('  [跳过] %s 不存在' % rel)
        continue
    src = open(p, encoding='utf-8', errors='replace').read()
    defined = defined_names(src)
    calls = set(re.findall(r'(?<![\w.$])([A-Za-z_][A-Za-z0-9_]*)\s*\(', src))
    suspects = sorted(c for c in calls
                      if c.startswith(PREFIXES)
                      and c not in defined
                      and c not in WHITELIST)
    if suspects:
        for s in suspects:
            print('  [FAIL] %s 调用了未定义的 %s()' % (rel, s))
            fails.append('%s:%s' % (rel, s))
    else:
        n = len([c for c in calls if c.startswith(PREFIXES)])
        print('  [OK]   %s：%d 个内部调用均有定义' % (rel, n))

print()
if fails:
    print('通过 0 / 失败 %d -> %s' % (len(fails), ', '.join(fails)))
    sys.exit(1)
print('全部通过')
