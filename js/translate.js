// vh-Atelier · DaVinci Resolve 版 · 字幕翻译桥
// 与 PR 版 js/translate.js 同源。差异：不依赖 PR 的共享工具模块，
// URL 与清洗逻辑内置，适配 Electron 渲染层直接用 fetch。
// 用法：window.__translateBridge.runTranslate(subs, mode, onProgress, onDone)
//   subs: [{ start, end, text }]
//   mode: 'zh' 只中文 | 'bilingual' 双语
(function () {
  var API = 'https://api.mymemory.translated.net/get';

  function cleanText(s) {
    // 去掉多余空白与换行，避免接口按段落返回错乱
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function translateEnZh(text, cb) {
    var q = cleanText(text);
    if (!q) { cb(null, ''); return; }
    // MyMemory 单次有长度上限，过长的先截断（字幕条一般远低于上限）
    if (q.length > 480) q = q.slice(0, 480);
    var url = API + '?q=' + encodeURIComponent(q) + '&langpair=en%7Czh-CN';
    fetch(url, { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var out = j && j.responseData && j.responseData.translatedText;
        if (out) cb(null, String(out));
        else cb(new Error('空结果' + (j && j.responseDetails ? '：' + j.responseDetails : '')), null);
      })
      .catch(function (e) { cb(e || new Error('网络错误'), null); });
  }

  function runTranslate(subs, mode, onProgress, onDone) {
    if (!subs || !subs.length) { onDone(new Error('没有可翻译的字幕')); return { cancel: function () {} }; }
    var outSubs = [];
    var failCount = 0;
    var i = 0;
    var cancelled = false;

    function next() {
      if (cancelled) return;
      if (i >= subs.length) { onDone(null, { outSubs: outSubs, failCount: failCount }); return; }
      var idx = i;
      var src = subs[idx];
      var text = cleanText(src.text);
      i++;
      if (!text) {
        outSubs[idx] = { start: src.start, end: src.end, text: '' };
        if (onProgress) onProgress(i, subs.length);
        setTimeout(next, 20);
        return;
      }
      translateEnZh(text, function (err, zh) {
        var zhText = err ? text : cleanText(zh);
        if (err) failCount++;
        if (mode === 'bilingual') {
          outSubs[idx] = { start: src.start, end: src.end, text: text + '\n' + zhText };
        } else {
          outSubs[idx] = { start: src.start, end: src.end, text: zhText };
        }
        if (onProgress) onProgress(i, subs.length);
        setTimeout(next, 260);   // 间隔防限流
      });
    }

    next();
    return { cancel: function () { cancelled = true; } };
  }

  window.__translateBridge = { runTranslate: runTranslate, translateEnZh: translateEnZh };
})();
