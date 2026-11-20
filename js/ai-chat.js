// ==========================================================================
// vh-Atelier · AI 助手（对话）
// --------------------------------------------------------------------------
// 只做一件事：在插件面板里和一个可配置的大模型聊天。
//
// 设计要点：
//   1. 密钥不放在页面里。CEP 页面是可读的，密钥写进 JS 等于公开。
//      配置存 collect/ai_config.json，请求走 Node 直连。
//   2. 走 OpenAI 兼容协议（/chat/completions + stream），
//      DeepSeek、中转站、其他兼容服务换地址即可用。
//   3. 历史存本机 collect/ai_history.json，只保留最近若干轮，
//      不自动上传任何素材内容。
//   4. 断网、密钥错、额度不足都给可读提示，不甩原始堆栈。
//
// 对外：window.__vhAI.onShow()  —— 切到该面板时调用
// ==========================================================================
(function () {
    'use strict';

    var el = {};
    var state = {
        cfg: { base: '', key: '', model: '', temp: 0.7 },
        messages: [],          // {role, content}
        streaming: false,
        abort: null
    };

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function setStatus(text, cls) {
        if (!el.status) return;
        el.status.textContent = text || '';
        el.status.className = 'ai-status' + (cls ? ' ' + cls : '');
    }

    // 简易 Markdown：代码块、行内代码、加粗、换行。不引第三方库。
    function renderMd(text) {
        var s = esc(text);
        var fences = [];
        s = s.replace(/```([\w+-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
            fences.push('<pre class="ai-code"><code>' + code.replace(/\n$/, '') + '</code></pre>');
            return '\u0000F' + (fences.length - 1) + '\u0000';
        });
        s = s.replace(/`([^`\n]+)`/g, '<code class="ai-ic">$1</code>');
        s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/\n{2,}/g, '</p><p>');
        s = s.replace(/\n/g, '<br>');
        s = s.replace(/\u0000F(\d+)\u0000/g, function (_, i) { return fences[+i]; });
        return '<p>' + s + '</p>';
    }

    function nearBottom() {
        if (!el.msgs) return true;
        return el.msgs.scrollHeight - el.msgs.scrollTop - el.msgs.clientHeight < 80;
    }
    function scrollBottom(force) {
        if (!el.msgs) return;
        if (force || nearBottom()) el.msgs.scrollTop = el.msgs.scrollHeight;
    }

    // ---------------- 本地文件读写 ----------------
    function fsMod() { try { return require('fs'); } catch (e) { return null; } }
    function pathMod() { try { return require('path'); } catch (e) { return null; } }

    function rootDir() {
        var fs = fsMod(), path = pathMod();
        if (!fs || !path) return '';
        try {
            if (typeof CSInterface !== 'undefined') {
                var r = new CSInterface().getSystemPath('extension');
                if (r && fs.existsSync(r)) return r;
            }
        } catch (e) {}
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (e) {}
        return '';
    }
    function cfgPath() {
        var path = pathMod(), root = rootDir();
        return (path && root) ? path.join(root, 'collect', 'ai_config.json') : '';
    }
    function histPath() {
        var path = pathMod(), root = rootDir();
        return (path && root) ? path.join(root, 'collect', 'ai_history.json') : '';
    }
    function readJson(p) {
        var fs = fsMod();
        try { if (fs && p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
        return null;
    }
    function writeJson(p, obj) {
        var fs = fsMod(), path = pathMod();
        try {
            if (!fs || !p) return false;
            var dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
            return true;
        } catch (e) { return false; }
    }

    function loadCfg() {
        var c = readJson(cfgPath()) || {};
        state.cfg = {
            base: String(c.base || ''),
            key: String(c.key || ''),
            model: String(c.model || ''),
            temp: (typeof c.temp === 'number') ? c.temp : 0.7
        };
        paintCfg();
    }
    function loadHistory() {
        var h = readJson(histPath());
        state.messages = (h && Array.isArray(h.messages)) ? h.messages : [];
    }
    function saveHistory() {
        writeJson(histPath(), { messages: state.messages.slice(-40), savedAt: Date.now() });
    }

    function cfgReady() { return !!(state.cfg.base && state.cfg.key && state.cfg.model); }

    function paintCfg() {
        if (el.modelLabel) {
            el.modelLabel.textContent = state.cfg.model || '未配置';
            el.modelLabel.classList.toggle('ai-model-warn', !cfgReady());
        }
        if (el.cfgBase) el.cfgBase.value = state.cfg.base;
        if (el.cfgKey) el.cfgKey.value = state.cfg.key;
        if (el.cfgModel) el.cfgModel.value = state.cfg.model;
        if (el.cfgTemp) el.cfgTemp.value = String(state.cfg.temp);
    }

    // ---------------- 渲染 ----------------
    function bubble(role, content) {
        var isUser = role === 'user';
        return '<div class="ai-msg ' + (isUser ? 'me' : 'bot') + '">' +
            '<div class="ai-av">' + (isUser ? '我' : 'AI') + '</div>' +
            '<div class="ai-bub">' +
            (isUser ? '<p>' + esc(content).replace(/\n/g, '<br>') + '</p>' : renderMd(content)) +
            '</div></div>';
    }

    function renderAll() {
        if (!el.msgs) return;
        if (!state.messages.length) {
            el.msgs.innerHTML = emptyHtml();
            bindEmpty();
            return;
        }
        el.msgs.innerHTML = state.messages.map(function (m) {
            return bubble(m.role, m.content);
        }).join('');
        scrollBottom(true);
    }

    function emptyHtml() {
        return '<div class="ai-empty" id="aiEmpty">' +
            '<div class="ai-empty-ico">💬</div>' +
            '<div class="ai-empty-t">有什么想问的？</div>' +
            '<div class="ai-empty-d">剪辑、剧本、字幕、导出相关都可以问。也可以让我帮你理思路、写文案。</div>' +
            '<div class="ai-chips">' +
            '<button data-ask="剪辑一场对白戏，节奏上要注意什么？">对白戏的节奏</button>' +
            '<button data-ask="短剧前3秒怎么留住观众？">前 3 秒留人</button>' +
            '<button data-ask="帮我把这句话改写得更口语化：">改写台词</button>' +
            '</div></div>';
    }

    function bindEmpty() {
        if (!el.msgs) return;
        el.msgs.querySelectorAll('[data-ask]').forEach(function (b) {
            b.onclick = function () {
                if (el.input) {
                    el.input.value = b.getAttribute('data-ask');
                    autoGrow();
                    el.input.focus();
                }
            };
        });
    }

    function appendBubble(role, content) {
        var e = el.msgs.querySelector('#aiEmpty');
        if (e && e.parentNode) e.parentNode.removeChild(e);
        el.msgs.insertAdjacentHTML('beforeend', bubble(role, content));
        scrollBottom();
        return el.msgs.lastElementChild;
    }

    // ---------------- 网络请求（Node 直连，避开 CEP 跨域） ----------------
    function endpoint(base) {
        var b = String(base || '').trim().replace(/\/+$/, '');
        if (/\/chat\/completions$/.test(b)) return b;
        if (/\/v1$/.test(b)) return b + '/chat/completions';
        return b + '/v1/chat/completions';
    }

    function httpPost(url, headers, bodyText, onChunk, onDone) {
        var http, https;
        try { http = require('http'); https = require('https'); }
        catch (e) { return onDone(new Error('当前环境取不到 Node 模块，无法发起请求')); }

        var u;
        try { u = new URL(url); } catch (e) { return onDone(new Error('接口地址格式不对：' + url)); }

        var mod = (u.protocol === 'https:') ? https : http;
        var payload = Buffer.from(bodyText, 'utf8');
        var h = Object.assign({}, headers, { 'Content-Length': payload.length });

        var req = mod.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + (u.search || ''),
            method: 'POST',
            headers: h,
            timeout: 120000
        }, function (res) {
            var status = res.statusCode || 0;
            if (status >= 400) {
                var eb = '';
                res.on('data', function (d) { eb += d.toString('utf8'); });
                res.on('end', function () {
                    var msg = eb;
                    try {
                        var j = JSON.parse(eb);
                        msg = (j.error && (j.error.message || j.error)) || j.message || eb;
                    } catch (e2) {}
                    onDone(new Error('HTTP ' + status + '：' + String(msg).slice(0, 300)));
                });
                return;
            }
            var buf = '';
            res.on('data', function (d) {
                // 只在完整行（以 \n 结尾）上解析：网络分片可能把一行 JSON 切成两半，
                // 若把残片也当行处理，会丢失该条内容。
                buf += d.toString('utf8');
                var cut = buf.lastIndexOf('\n');
                if (cut < 0) return;
                var ready = buf.slice(0, cut + 1);
                buf = buf.slice(cut + 1);
                var lines = ready.split('\n');
                lines.forEach(function (line) {
                    line = line.trim();
                    if (!line || line.indexOf('data:') !== 0) return;
                    var data = line.slice(5).trim();
                    if (data === '[DONE]') return;
                    try { onChunk(JSON.parse(data)); } catch (e3) {}
                });
            });
            res.on('end', function () {
                // 收尾：处理最后一段没有换行结尾的数据
                if (buf.trim()) {
                    var last = buf.trim();
                    if (last.indexOf('data:') === 0) {
                        var data = last.slice(5).trim();
                        if (data && data !== '[DONE]') {
                            try { onChunk(JSON.parse(data)); } catch (e) {}
                        }
                    }
                }
                onDone(null);
            });
            res.on('error', function (e4) { onDone(e4); });
        });

        state.abort = function () { try { req.destroy(); } catch (e) {} };

        req.on('timeout', function () {
            try { req.destroy(); } catch (e) {}
            onDone(new Error('请求超时（120 秒）'));
        });
        req.on('error', function (e5) {
            var msg = e5.message || String(e5);
            if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) msg = '域名解析失败，检查接口地址或网络';
            else if (/ECONNREFUSED/i.test(msg)) msg = '连接被拒绝，检查地址和端口';
            else if (/CERT|SSL/i.test(msg)) msg = '证书校验失败：' + msg;
            onDone(new Error(msg));
        });

        req.write(payload);
        req.end();
    }

    // ---------------- 发送 ----------------
    function send() {
        if (state.streaming) return;
        var text = (el.input && el.input.value || '').trim();
        if (!text) return;
        if (!cfgReady()) {
            setStatus('请先在「⚙ 设置」里填写接口地址、密钥和模型', 'err');
            openCfg();
            return;
        }

        state.messages.push({ role: 'user', content: text });
        appendBubble('user', text);
        el.input.value = '';
        autoGrow();
        saveHistory();

        state.streaming = true;
        setStatus('思考中…', 'busy');
        if (el.send) el.send.style.display = 'none';
        if (el.stop) el.stop.style.display = '';

        var node = appendBubble('assistant', '');
        var bodyEl = node.querySelector('.ai-bub');
        var acc = '';
        var started = false;

        var body = {
            model: state.cfg.model,
            messages: state.messages.slice(-20).map(function (m) {
                return { role: m.role, content: m.content };
            }),
            stream: true
        };
        if (state.cfg.temp !== null && state.cfg.temp !== undefined) body.temperature = state.cfg.temp;

        httpPost(endpoint(state.cfg.base), {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + state.cfg.key,
            'Accept': 'text/event-stream'
        }, JSON.stringify(body), function (j) {
            var d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message);
            var piece = d && d.content;
            if (piece) {
                if (!started) { started = true; setStatus('生成中…', 'busy'); }
                acc += piece;
                bodyEl.innerHTML = renderMd(acc) + '<span class="ai-caret"></span>';
                scrollBottom();
            }
        }, function (err) {
            state.streaming = false;
            state.abort = null;
            if (el.send) el.send.style.display = '';
            if (el.stop) el.stop.style.display = 'none';

            if (err) {
                if (acc) {
                    bodyEl.innerHTML = renderMd(acc);
                    state.messages.push({ role: 'assistant', content: acc });
                    saveHistory();
                } else {
                    bodyEl.innerHTML = '<p class="ai-err">' + esc(err.message) + '</p>';
                }
                setStatus(err.message, 'err');
                return;
            }
            if (!acc) {
                bodyEl.innerHTML = '<p class="ai-err">模型没有返回内容。</p>';
                setStatus('没有返回内容', 'err');
                return;
            }
            bodyEl.innerHTML = renderMd(acc);
            state.messages.push({ role: 'assistant', content: acc });
            saveHistory();
            setStatus('');
            scrollBottom();
        });
    }

    function stop() {
        if (state.abort) state.abort();
        state.abort = null;
        state.streaming = false;
        if (el.send) el.send.style.display = '';
        if (el.stop) el.stop.style.display = 'none';
        setStatus('已停止', '');
    }

    // ---------------- 设置 ----------------
    function openCfg() {
        if (!el.cfgMask) return;
        paintCfg();
        el.cfgMask.style.display = 'flex';
        cfgMsg('');
        setTimeout(function () { if (el.cfgBase) el.cfgBase.focus(); }, 60);
    }
    function closeCfg() { if (el.cfgMask) el.cfgMask.style.display = 'none'; cfgMsg(''); }
    function cfgMsg(t, cls) {
        if (!el.cfgMsg) return;
        el.cfgMsg.textContent = t || '';
        el.cfgMsg.className = 'ai-cfg-msg' + (cls ? ' ' + cls : '');
    }

    function saveCfg() {
        var base = (el.cfgBase && el.cfgBase.value || '').trim();
        var key = (el.cfgKey && el.cfgKey.value || '').trim();
        var model = (el.cfgModel && el.cfgModel.value || '').trim();
        var temp = Number(el.cfgTemp && el.cfgTemp.value);
        if (!base) return cfgMsg('请填写接口地址', 'err');
        if (!/^https?:\/\//i.test(base)) return cfgMsg('接口地址要以 http:// 或 https:// 开头', 'err');
        if (!key) return cfgMsg('请填写 API 密钥', 'err');
        if (!model) return cfgMsg('请填写模型名', 'err');
        if (!isFinite(temp) || temp < 0 || temp > 2) temp = 0.7;

        state.cfg = { base: base, key: key, model: model, temp: temp };
        var ok = writeJson(cfgPath(), state.cfg);
        paintCfg();
        // 无论落盘成功与否都关闭弹层：否则弹层会挡住面板，用户以为界面卡死。
        // 写入失败时在状态栏说明，本次配置仍可在当前会话内使用。
        closeCfg();
        setStatus(ok ? '' : '配置已应用，但未能写入 collect 目录（重启后会丢失）', ok ? '' : 'warn');
    }

    function testCfg() {
        var base = (el.cfgBase && el.cfgBase.value || '').trim();
        var key = (el.cfgKey && el.cfgKey.value || '').trim();
        var model = (el.cfgModel && el.cfgModel.value || '').trim();
        if (!base || !key || !model) return cfgMsg('三项都要填', 'err');
        cfgMsg('测试中…', '');
        var body = JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: 'ping' }],
            stream: false,
            max_tokens: 8
        });
        var done = false;
        var timer = setTimeout(function () {
            if (!done) { done = true; cfgMsg('超时：15 秒内没响应，检查地址或网络', 'err'); }
        }, 15000);
        httpPost(endpoint(base), {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + key
        }, body, function () {}, function (err) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (err) cfgMsg('失败：' + err.message, 'err');
            else cfgMsg('连接正常，可以用了', 'ok');
        });
    }

    function autoGrow() {
        if (!el.input) return;
        el.input.style.height = 'auto';
        el.input.style.height = Math.min(140, el.input.scrollHeight) + 'px';
    }

    function newChat() {
        if (state.streaming) stop();
        if (state.messages.length && !confirm('开始新对话？当前记录会被清空。')) return;
        state.messages = [];
        saveHistory();
        renderAll();
        setStatus('');
        if (el.input) el.input.focus();
    }

    // ---------------- 初始化 ----------------
    function pick() {
        el.modelLabel = $('aiModelLabel');
        el.status = $('aiStatus');
        el.msgs = $('aiMsgs');
        el.input = $('aiInput');
        el.send = $('aiSend');
        el.stop = $('aiStop');
        el.newChat = $('aiNewChat');
        el.cfgBtn = $('aiCfgBtn');
        el.cfgMask = $('aiCfgMask');
        el.cfgBase = $('aiCfgBase');
        el.cfgKey = $('aiCfgKey');
        el.cfgModel = $('aiCfgModel');
        el.cfgTemp = $('aiCfgTemp');
        el.cfgSave = $('aiCfgSave');
        el.cfgTest = $('aiCfgTest');
        el.cfgClose = $('aiCfgClose');
        el.cfgMsg = $('aiCfgMsg');
    }

    function bind() {
        if (!el.msgs) return;
        if (el.send) el.send.onclick = send;
        if (el.stop) el.stop.onclick = stop;
        if (el.newChat) el.newChat.onclick = newChat;
        if (el.cfgBtn) el.cfgBtn.onclick = openCfg;
        if (el.cfgClose) el.cfgClose.onclick = closeCfg;
        if (el.cfgSave) el.cfgSave.onclick = saveCfg;
        if (el.cfgTest) el.cfgTest.onclick = testCfg;
        if (el.cfgMask) el.cfgMask.onclick = function (e) { if (e.target === el.cfgMask) closeCfg(); };
        if (el.input) {
            el.input.addEventListener('input', autoGrow);
            el.input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            });
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && el.cfgMask && el.cfgMask.style.display !== 'none') closeCfg();
        });
    }

    function init() {
        pick();
        if (!el.msgs) return;
        bind();
        loadCfg();
        loadHistory();
        renderAll();
        if (!cfgReady()) setStatus('首次使用请点右上角「⚙ 设置」配置模型', 'warn');
    }

    window.__vhAI = {
        onShow: function () {
            if (!el.msgs) return;
            loadCfg();
            if (!state.streaming) {
                setStatus(cfgReady() ? '' : '请先配置模型', cfgReady() ? '' : 'warn');
            }
            setTimeout(function () { if (el.input) el.input.focus(); }, 80);
        },
        reset: newChat
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
