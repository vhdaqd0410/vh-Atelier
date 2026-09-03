// vh-Atelier 共享翻译引擎（英译中，剧情参考用）
// 调 MyMemory 免费接口：零 key、国内直连、CORS 放行（Access-Control-Allow-Origin: *）。
// 字幕识别板块与字幕校对板块共用这一份翻译循环，避免双份实现分叉。
// 用法：window.__translateBridge.runTranslate(subs, mode, onProgress, onDone)
//   subs: [{ start, end, text }] 需要翻译的英文字幕
//   mode: 'zh' 只中文 | 'bilingual' 中英双语（同一字幕条，英文在上中文在下）
//   onProgress(done, total): 进度回调（每条翻完触发）
//   onDone(null, { outSubs, failCount }) 成功 | onDone(err)
(function () {
    // 单条英译中
    function translateEnZh(text, cb) {
        var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
            '&langpair=en%7Czh-CN';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = 15000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            try {
                var j = JSON.parse(xhr.responseText);
                var out = j && j.responseData && j.responseData.translatedText;
                if (out) cb(null, out);
                else cb(new Error('空结果' + (j && j.responseDetails ? '：' + j.responseDetails : '')), null);
            } catch (e) { cb(new Error('解析失败'), null); }
        };
        xhr.onerror = function () { cb(new Error('网络错误'), null); };
        xhr.ontimeout = function () { cb(new Error('超时'), null); };
        xhr.send();
    }

    // 串行翻译循环（带 250ms 间隔防限流）
    function runTranslate(subs, mode, onProgress, onDone) {
        if (!subs || subs.length === 0) { onDone(new Error('没有可翻译的字幕')); return; }
        var outSubs = [];
        var failCount = 0;
        var i = 0;
        var cancelled = false;

        function next() {
            if (cancelled) return;
            if (i >= subs.length) {
                onDone(null, { outSubs: outSubs, failCount: failCount });
                return;
            }
            var idx = i;
            var src = subs[idx];
            var text = (src.text || '').trim();
            i++;
            if (!text) {
                outSubs[idx] = { start: src.start, end: src.end, text: '' };
                if (onProgress) onProgress(i, subs.length);
                setTimeout(next, 30);
                return;
            }
            translateEnZh(text, function (err, zh) {
                var zhText = err ? text : String(zh).trim();
                if (err) failCount++;
                if (mode === 'bilingual') {
                    outSubs[idx] = { start: src.start, end: src.end, text: text + '\n' + zhText };
                } else {
                    outSubs[idx] = { start: src.start, end: src.end, text: zhText };
                }
                if (onProgress) onProgress(i, subs.length);
                setTimeout(next, 250);
            });
        }

        next();

        // 允许外部中断（如用户切走板块）
        return {
            cancel: function () { cancelled = true; }
        };
    }

    window.__translateBridge = {
        runTranslate: runTranslate,
        translateEnZh: translateEnZh
    };
})();
