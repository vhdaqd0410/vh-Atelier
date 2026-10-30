// vh-Atelier 客户版 · CosyVoice3 引擎检测与路径管理
//
// 设计背景：
//   CosyVoice3 是第三方整合包，体积 13.45 GB，不能塞进插件包。
//   老用户机器上通常已有 D:\cosyvoice3_V30，要保证「装上就能用」。
//   新用户没有时，要有明确的引导，而不是合成时报一堆 Python 报错。
//
// 三层检测（缺哪层提示哪层，避免让用户看到天书错误）：
//   1. runtime  : _internal 里的 torch 能否 import
//   2. source   : cosyvoice 源码目录在不在
//   3. model    : pretrained_models 里关键权重齐不齐
(function () {
    'use strict';

    var fs, path, childProcess;
    try {
        fs = require('fs');
        path = require('path');
        childProcess = require('child_process');
    } catch (e) {
        window.__vhCosyEngine = { check: function () { return { ok: false, reason: '非 CEP 环境' }; } };
        return;
    }

    var KEY_ROOT = 'vh_cosy_root';

    // 可能的默认位置（按优先级）
    // 第一位是「插件自己的 engine 目录」：自动导入整合包时就是解到这里，
    // 优先查它，客户装完不用手动设置路径。
    var _extRoot = '';
    try { _extRoot = new CSInterface().getSystemPath(SystemPath.EXTENSION) || ''; } catch (e) {}

    var DEFAULT_CANDIDATES = [];
    if (_extRoot) {
        DEFAULT_CANDIDATES.push(path.join(_extRoot, 'engine', 'cosyvoice3_V30'));
        DEFAULT_CANDIDATES.push(path.join(_extRoot, 'engine'));
    }
    // 再回退到常见的独立安装位置（老用户把它们装在别处）
    DEFAULT_CANDIDATES = DEFAULT_CANDIDATES.concat([
        'D:\\cosyvoice3_V30',
        'C:\\cosyvoice3_V30',
        'E:\\cosyvoice3_V30',
        'D:\\CosyVoice3',
        'D:\\cosyvoice'
    ]);

    // 读取引擎根目录。
    // 关键语义：用户「显式设置过」的路径必须如实返回（哪怕它不存在），
    // 否则用户填错路径后检测仍会显示就绪，排查不到问题。
    // 只有在「从未设置过」时才自动探测默认位置。
    function getRoot() {
        var saved = '';
        try { saved = localStorage.getItem(KEY_ROOT); } catch (e) {}
        if (saved !== null && saved !== undefined && saved !== '') {
            return saved;   // 用户设置过，如实返回（可能是错的，交给 check 报错）
        }
        // 从未设置：探测常见位置
        for (var i = 0; i < DEFAULT_CANDIDATES.length; i++) {
            if (fs.existsSync(DEFAULT_CANDIDATES[i])) {
                try { localStorage.setItem(KEY_ROOT, DEFAULT_CANDIDATES[i]); } catch (e) {}
                return DEFAULT_CANDIDATES[i];
            }
        }
        return '';
    }

    // 用户主动清空（恢复自动探测）
    function clearRoot() {
        try { localStorage.removeItem(KEY_ROOT); } catch (e) {}
    }

    function setRoot(p) {
        p = String(p || '').trim().replace(/[\\/]+$/, '');
        try { localStorage.setItem(KEY_ROOT, p); } catch (e) {}
        return p;
    }

    // 模型权重要求（key 文件 + 最小体积，防止空目录误判）
    var MODEL_FILES = [
        { f: 'llm.pt', minMB: 1500, label: 'LLM 主干' },
        { f: 'flow.pt', minMB: 1000, label: 'Flow 声学模型' },
        { f: 'hift.pt', minMB: 50, label: 'HiFiGAN 声码器' },
        { f: 'speech_tokenizer_v3.onnx', minMB: 700, label: '语音 tokenizer' },
        { f: 'campplus.onnx', minMB: 10, label: '说话人嵌入' }
    ];

    function dirSizeMB(p) {
        // 只算目录本身一层（不深搜，避免慢）
        try {
            var total = 0;
            var list = fs.readdirSync(p, { withFileTypes: true });
            for (var i = 0; i < list.length; i++) {
                if (!list[i].isFile()) continue;
                try { total += fs.statSync(path.join(p, list[i].name)).size; } catch (e) {}
            }
            return total / 1024 / 1024;
        } catch (e) {
            return -1;
        }
    }

    // 完整检测
    function check(root) {
        root = root || getRoot();
        var r = {
            ok: false,
            root: root,
            runtime: { ok: false, path: '', msg: '' },
            source: { ok: false, path: '', msg: '' },
            model: { ok: false, path: '', msg: '', missing: [], found: [] },
            python: { ok: false, path: '', msg: '' },
            canRun: false,
            summary: '',
            action: ''      // 'ready' | 'no-root' | 'bad-root' | 'no-runtime' | 'no-source' | 'no-model' | 'no-python'
        };

        if (!root) {
            r.action = 'no-root';
            r.summary = '未配置 CosyVoice3 引擎目录';
            return r;
        }
        if (!fs.existsSync(root)) {
            r.action = 'bad-root';
            r.summary = '目录不存在：' + root;
            return r;
        }

        // 1. 运行时
        var internal = path.join(root, '_internal');
        r.runtime.path = internal;
        if (!fs.existsSync(internal)) {
            r.action = 'no-runtime';
            r.summary = '缺少 _internal 运行时目录';
        } else {
            var torchDir = path.join(internal, 'torch');
            var torchPyd = path.join(torchDir, '_C.cp310-win_amd64.pyd');
            var torchCuda = path.join(torchDir, 'lib', 'torch_cuda.dll');
            if (!fs.existsSync(torchDir)) {
                r.action = 'no-runtime';
                r.summary = '运行时里没有 torch';
            } else if (!fs.existsSync(torchCuda)) {
                r.runtime.ok = false;
                r.runtime.msg = 'torch 存在但缺 CUDA 库（可能是 CPU 版）';
                r.action = 'no-runtime';
                r.summary = '运行时缺少 GPU 组件';
            } else {
                r.runtime.ok = true;
                r.action = '';
                r.summary = '';
            }
        }

        // 2. 源码
        var src = path.join(root, 'cosyvoice');
        r.source.path = src;
        if (!fs.existsSync(path.join(src, 'cli', 'cosyvoice.py'))) {
            if (!r.action) {
                r.action = 'no-source';
                r.summary = '缺少 cosyvoice 源码目录';
            }
        } else {
            r.source.ok = true;
        }

        // 3. 模型
        var models = path.join(root, 'pretrained_models');
        r.model.path = models;
        if (fs.existsSync(models)) {
            var miss = [];
            var found = [];
            for (var i = 0; i < MODEL_FILES.length; i++) {
                var mf = MODEL_FILES[i];
                var fp = path.join(models, mf.f);
                var okFile = false;
                if (fs.existsSync(fp)) {
                    try {
                        var mb = fs.statSync(fp).size / 1024 / 1024;
                        okFile = mb >= mf.minMB;
                    } catch (e) {}
                }
                if (okFile) found.push(mf.label);
                else miss.push(mf.label);
            }
            r.model.found = found;
            r.model.missing = miss;
            if (miss.length === 0) {
                r.model.ok = true;
            } else if (!r.action) {
                r.action = 'no-model';
                r.summary = '模型文件不完整，缺 ' + miss.length + ' 项';
            }
        } else {
            r.model.missing = MODEL_FILES.map(function (x) { return x.label; });
            if (!r.action) {
                r.action = 'no-model';
                r.summary = '缺少 pretrained_models 模型目录';
            }
        }

        // 4. Python（能跑 py 脚本就行，版本 3.10 最佳）
        var py = findPython();
        r.python.path = py || '';
        if (py) {
            r.python.ok = true;
        } else if (!r.action) {
            r.action = 'no-python';
            r.summary = '未找到 Python 3.10 环境';
        }

        r.canRun = r.runtime.ok && r.source.ok && r.model.ok && r.python.ok;
        r.ok = r.canRun;
        if (r.ok) {
            r.action = 'ready';
            r.summary = '引擎就绪';
        }
        return r;
    }

    function findPython() {
        var cands = [
            process.env.VH_PYTHON,
            'C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python310\\python.exe',
            'C:\\Python310\\python.exe'
        ];
        // 用环境变量里的用户名拼（客户机用户名不一定是 Admin）
        try {
            var home = process.env.USERPROFILE || '';
            if (home) {
                cands.splice(1, 0, path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'python.exe'));
            }
        } catch (e) {}
        for (var i = 0; i < cands.length; i++) {
            if (cands[i] && fs.existsSync(cands[i])) return cands[i];
        }
        try {
            var r = childProcess.spawnSync('where', ['python'], { encoding: 'utf8', timeout: 5000 });
            if (r.status === 0 && r.stdout) {
                var first = String(r.stdout).split('\n')[0].trim();
                if (first && fs.existsSync(first)) return first;
            }
        } catch (e) {}
        return '';
    }

    window.__vhCosyEngine = {
        getRoot: getRoot,
        setRoot: setRoot,
        clearRoot: clearRoot,
        check: check,
        findPython: findPython,
        DEFAULT_CANDIDATES: DEFAULT_CANDIDATES,
        MODEL_FILES: MODEL_FILES
    };
})();
