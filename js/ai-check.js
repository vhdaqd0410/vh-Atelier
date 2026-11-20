// ==========================================================================
// vh-Atelier · AI 复核（字幕 × 剧本）
// --------------------------------------------------------------------------
// 定位：不是替代 py/subtitle_check.py，而是在它之上补一层「语义判断」。
//
// 分工：
//   subtitle_check.py  → 词级对齐，找 听错词 / 漏词 / 多余词（确定性，准）
//   AI 复核            → 只在规则结果之上判断：
//                        · 这句读起来是否通顺（同音字、口误）
//                        · 语气是否符合该角色的说法
//                        · 断句是否合理（一行太长、断在词中间）
//   两者结果合并进同一个 issues 列表，复用现有的勾选/应用/写回序列。
//
// 设计约束：
//   1. 不重新解析 docx/srt —— 用的是内存里已解析好的句子对。
//   2. 分批送，每批带前后一条上下文；不整集塞进去。
//   3. 强制返回 JSON；解析失败就明确报错，不猜。
//   4. 只给「建议」，不自动应用。人工确认后才写入。
//   5. 术语表（人名/地名）来自本地 collect/ai_terms.json，模型必须遵守。
//
// 对外：window.__vhAICheck = { run(ctx, cfg, onProgress) -> Promise<items> }
// ==========================================================================
(function () {
    'use strict';

    var BATCH = 24;          // 每批处理的字幕条数
    var MAX_RETRY = 1;       // 单批解析失败重试次数

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ---------- 读取 AI 配置（与 ai-chat 共用同一份）----------
    function readConfig() {
        try {
            var fs = require('fs'), path = require('path');
            var root = '';
            try {
                if (typeof CSInterface !== 'undefined') {
                    var r = new CSInterface().getSystemPath('extension');
                    if (r && fs.existsSync(r)) root = r;
                }
            } catch (e) {}
            if (!root) {
                try {
                    var d = (typeof __dirname !== 'undefined') ? __dirname : '';
                    if (d) root = (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
                } catch (e2) {}
            }
            if (!root) return null;
            var p = path.join(root, 'collect', 'ai_config.json');
            if (!fs.existsSync(p)) return null;
            var c = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!c || !c.base || !c.key || !c.model) return null;
            return c;
        } catch (e3) { return null; }
    }

    // ---------- 术语表（可选）----------
    function readTerms() {
        try {
            var fs = require('fs'), path = require('path');
            var root = '';
            try {
                if (typeof CSInterface !== 'undefined') {
                    var r = new CSInterface().getSystemPath('extension');
                    if (r && fs.existsSync(r)) root = r;
                }
            } catch (e) {}
            if (!root) return [];
            var p = path.join(root, 'collect', 'ai_terms.json');
            if (!fs.existsSync(p)) return [];
            var j = JSON.parse(fs.readFileSync(p, 'utf8'));
            return Array.isArray(j) ? j : (Array.isArray(j.terms) ? j.terms : []);
        } catch (e) { return []; }
    }

    // ---------- 一次性请求（非流式，要结构化 JSON 更稳）----------
    function chatOnce(cfg, messages, onDone) {
        var http, https;
        try { http = require('http'); https = require('https'); }
        catch (e) { return onDone(new Error('当前环境取不到 Node 模块')); }

        var base = String(cfg.base || '').trim().replace(/\/+$/, '');
        var url = /\/chat\/completions$/.test(base) ? base
            : (/\/v1$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions');
        var u;
        try { u = new URL(url); } catch (e2) { return onDone(new Error('接口地址格式不对：' + url)); }

        var body = JSON.stringify({
            model: cfg.model,
            messages: messages,
            stream: false,
            temperature: 0.2          // 校正类任务要稳，不要发散
        });
        var payload = Buffer.from(body, 'utf8');
        var mod = (u.protocol === 'https:') ? https : http;
        var req = mod.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + (u.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + cfg.key,
                'Content-Length': payload.length
            },
            timeout: 120000
        }, function (res) {
            var buf = '';
            res.on('data', function (d) { buf += d.toString('utf8'); });
            res.on('end', function () {
                if ((res.statusCode || 0) >= 400) {
                    var msg = buf;
                    try {
                        var j = JSON.parse(buf);
                        msg = (j.error && (j.error.message || j.error)) || j.message || buf;
                    } catch (e3) {}
                    return onDone(new Error('HTTP ' + res.statusCode + '：' + String(msg).slice(0, 240)));
                }
                var text = '';
                try {
                    var jj = JSON.parse(buf);
                    var c = jj.choices && jj.choices[0];
                    text = (c && ((c.message && c.message.content) || c.text)) || '';
                } catch (e4) {
                    return onDone(new Error('模型返回不是合法 JSON'));
                }
                onDone(null, text);
            });
        });
        req.on('timeout', function () { try { req.destroy(); } catch (e) {} onDone(new Error('请求超时')); });
        req.on('error', function (e5) { onDone(new Error(e5.message || String(e5))); });
        req.write(payload);
        req.end();
    }

    // ---------- 从模型回复里抠出 JSON 数组 ----------
    function extractJSONArray(text) {
        if (!text) return null;
        var s = String(text).trim();
        // 去掉 ```json ``` 包裹
        s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        var i = s.indexOf('[');
        var j = s.lastIndexOf(']');
        if (i < 0 || j <= i) return null;
        try {
            var arr = JSON.parse(s.slice(i, j + 1));
            return Array.isArray(arr) ? arr : null;
        } catch (e) { return null; }
    }

    // ---------- 组装 prompt ----------
    function buildMessages(pairs, terms, mode) {
        var sys = [
            '你是短剧字幕校对助手。用户给你一批「字幕条目」和对应的「剧本台词」。',
            '你的任务是找出字幕里**规则校对查不出**的问题，只报这三类：',
            '1. ASR：同音字、口误、语音识别听错导致的错字。',
            '2. FLUENCY：语句不通顺、明显缺字多字。',
            '3. SPLIT：断句不合理（一行过长、断在词中间）。',
            '',
            '严格要求：',
            '- 只针对「确实有问题」的条目返回，没问题的不要返回。',
            '- 改写必须最小化：只改出错的部分，不要重写整句，不要润色。',
            '- 不得改动人名、地名、专有名词。术语表如下（若提供则必须严格遵守）：',
            terms && terms.length ? JSON.stringify(terms) : '（无）',
            '- 如果字幕和剧本本来就是同义不同说法（演员改词、口语化），**不要**报问题。',
            mode === 'script-strict'
                ? '- 当前模式：以剧本为准，字幕应向剧本靠拢。'
                : '- 当前模式：只修错别字与不通顺，不按剧本改台词。',
            '',
            '返回格式：只返回 JSON 数组，不要任何解释文字。每个元素：',
            '{"idx": 条目编号, "type": "ASR|FLUENCY|SPLIT", "reason": "简短原因", "suggest": "修正后的完整字幕文本"}',
            '没有问题时返回 []。'
        ].join('\n');

        var lines = pairs.map(function (p) {
            return '#' + p.idx + '\n字幕：' + p.sub + '\n剧本：' + (p.script || '（无对应剧本行）');
        }).join('\n\n');

        return [
            { role: 'system', content: sys },
            { role: 'user', content: '以下是待校对条目：\n\n' + lines }
        ];
    }

    // ---------- 主入口 ----------
    // ctx: { pairs: [{idx, sub, script}], mode: 'script-strict'|'typo-only' }
    // onProgress(done, total, note)
    function run(ctx, onProgress, cb) {
        cb = cb || function () {};
        onProgress = onProgress || function () {};

        var cfg = readConfig();
        if (!cfg) { cb(new Error('还没配置 AI 模型。请到「🤖 AI 助手 → ⚙ 设置」里填好接口地址、密钥和模型。')); return; }

        var pairs = (ctx && ctx.pairs) || [];
        if (!pairs.length) { cb(null, []); return; }

        var terms = readTerms();
        var mode = (ctx && ctx.mode) || 'typo-only';
        var batches = [];
        for (var i = 0; i < pairs.length; i += BATCH) batches.push(pairs.slice(i, i + BATCH));

        var results = [];
        var done = 0;
        var stopped = false;

        function next(bi) {
            if (stopped) return;
            if (bi >= batches.length) { cb(null, results); return; }

            var batch = batches[bi];
            var msgs = buildMessages(batch, terms, mode);
            onProgress(done, pairs.length, '正在复核第 ' + (bi + 1) + '/' + batches.length + ' 批');

            chatOnce(cfg, msgs, function (err, text) {
                if (err) { cb(err); return; }

                var arr = extractJSONArray(text);
                if (!arr && MAX_RETRY > 0) {
                    // 模型偶尔会加解释文字，重试一次并要求纯 JSON
                    var retryMsgs = msgs.concat([
                        { role: 'user', content: '只返回 JSON 数组，不要任何其它文字。' }
                    ]);
                    chatOnce(cfg, retryMsgs, function (err2, text2) {
                        if (err2) { cb(err2); return; }
                        var arr2 = extractJSONArray(text2);
                        if (!arr2) { cb(new Error('模型没有返回可解析的 JSON（第 ' + (bi + 1) + ' 批）')); return; }
                        consume(arr2, batch, bi);
                    });
                    return;
                }
                if (!arr) { cb(new Error('模型没有返回可解析的 JSON（第 ' + (bi + 1) + ' 批）')); return; }
                consume(arr, batch, bi);
            });
        }

        function consume(arr, batch, bi) {
            var byIdx = {};
            batch.forEach(function (p) { byIdx[p.idx] = p; });
            arr.forEach(function (it) {
                if (!it || typeof it !== 'object') return;
                var idx = Number(it.idx);
                var p = byIdx[idx];
                if (!p) return;                                // 模型给了不存在的编号，丢弃
                var suggest = String(it.suggest == null ? '' : it.suggest).trim();
                if (!suggest || suggest === String(p.sub).trim()) return; // 没实际改动，丢弃
                results.push({
                    idx: idx,
                    type: String(it.type || 'FLUENCY').toUpperCase(),
                    reason: String(it.reason || '').slice(0, 120),
                    before: String(p.sub),
                    after: suggest,
                    source: 'ai'
                });
            });
            done += batch.length;
            onProgress(done, pairs.length, '');
            next(bi + 1);
        }

        window.__vhAICheck.stop = function () { stopped = true; };
        next(0);
    }

    window.__vhAICheck = {
        run: run,
        readConfig: readConfig,
        readTerms: readTerms,
        extractJSONArray: extractJSONArray,
        buildMessages: buildMessages
    };
})();
