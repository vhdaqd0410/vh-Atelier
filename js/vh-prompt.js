/**
 * vh-Atelier · DaVinci Resolve 版 · 通用输入弹层
 *
 * 【为什么需要】Electron 默认禁用 window.prompt：调用会返回 null 且不弹窗，
 * 表现为「按钮点了没反应」。这里用插件内自绘弹层替代，行为与 prompt 一致
 * （确认返回字符串，取消返回 null），但支持多行与更宽的输入。
 *
 * 用法：
 *   window.__vhPrompt({ title, value, multiline, placeholder, width }, function (val) {
 *     if (val === null) { 取消 } else { 确认，val 为字符串 }
 *   });
 */
(function () {
  'use strict';

  var cur = null;

  function close(result) {
    if (!cur) return;
    var cb = cur.cb;
    var ov = cur.ov;
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    cur = null;
    if (typeof cb === 'function') cb(result);
  }

  /**
   * @param {object} opts { title, tip, value, multiline, placeholder, width, okText }
   * @param {function(string|null)} cb
   */
  function open(opts, cb) {
    opts = opts || {};
    if (cur) close(null);

    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100200;'
      + 'display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#242424;border:1px solid #4a4a4a;border-radius:9px;'
      + 'padding:14px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;'
      + 'box-shadow:0 12px 40px rgba(0,0,0,.7);color:#ddd;'
      + 'width:' + (opts.width || 560) + 'px;max-width:92vw;max-height:86vh;';

    if (opts.title) {
      var h = document.createElement('div');
      h.style.cssText = 'font-size:13px;font-weight:600;color:#eee;flex:0 0 auto;';
      h.textContent = opts.title;
      box.appendChild(h);
    }
    if (opts.tip) {
      var tip = document.createElement('div');
      tip.style.cssText = 'font-size:11px;color:#9a9a9a;line-height:1.7;'
        + 'flex:0 0 auto;white-space:pre-wrap;';
      tip.textContent = opts.tip;
      box.appendChild(tip);
    }

    var inp;
    if (opts.multiline) {
      inp = document.createElement('textarea');
      inp.style.cssText = 'width:100%;box-sizing:border-box;min-height:260px;resize:vertical;'
        + 'background:#1c1c1c;color:#ddd;border:1px solid #444;border-radius:6px;'
        + 'padding:8px;font-family:Consolas,"Courier New",monospace;font-size:12px;line-height:1.6;'
        + 'flex:1 1 auto;';
    } else {
      inp = document.createElement('input');
      inp.type = 'text';
      inp.style.cssText = 'width:100%;box-sizing:border-box;background:#1c1c1c;color:#ddd;'
        + 'border:1px solid #444;border-radius:6px;padding:7px 9px;font-size:12.5px;flex:0 0 auto;';
    }
    inp.value = (opts.value === undefined || opts.value === null) ? '' : String(opts.value);
    if (opts.placeholder) inp.placeholder = opts.placeholder;
    box.appendChild(inp);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex:0 0 auto;';
    function mkBtn(text, primary) {
      var b = document.createElement('button');
      b.className = 'tbtn' + (primary ? ' on' : '');
      b.textContent = text;
      b.style.cssText = 'padding:5px 16px;font-size:12px;' + (primary ? '' : 'background:#3a3a3a;');
      return b;
    }
    var cancel = mkBtn('取消', false);
    var ok = mkBtn(opts.okText || '确定', true);
    ok.addEventListener('click', function () { close(inp.value); });
    cancel.addEventListener('click', function () { close(null); });
    // Ctrl+Enter / Enter 提交；Esc 取消
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); return; }
      if (e.key === 'Enter' && (!opts.multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault(); e.stopPropagation(); close(inp.value);
      }
    });
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);

    ov.appendChild(box);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(null); });
    document.body.appendChild(ov);

    cur = { ov: ov, cb: cb };
    setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) {} }, 30);
  }

  window.__vhPrompt = open;
  window.__vhPromptClose = function () { close(null); };
})();
