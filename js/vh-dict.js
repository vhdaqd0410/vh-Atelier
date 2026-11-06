/**
 * vh-Atelier · DaVinci Resolve 版 · 替换字典编辑器（左原 / 右新 两列）
 *
 * 【为什么单独做一个】原来的通用弹层让用户直接编辑 JSON 文本，不符合「逐条维护替换规则」
 * 的实际操作心智：用户要的是「左边填要替换掉的内容，右边填替换成什么」，一行一条。
 *
 * 用法：
 *   window.__vhDictEditor({ title, dict, tip }, function (result) {
 *     if (result === null) { 取消 } else { result 是 {原:新} 对象 }
 *   });
 */
(function () {
  'use strict';

  var cur = null;

  function close(res) {
    if (!cur) return;
    var cb = cur.cb, ov = cur.ov;
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    cur = null;
    if (typeof cb === 'function') cb(res);
  }

  /**
   * @param {object} opts { title, tip, dict }
   * @param {function(object|null)} cb
   */
  function open(opts, cb) {
    opts = opts || {};
    if (cur) close(null);

    var rows = [];   // [{ k, v }]
    var d = opts.dict || {};
    Object.keys(d).forEach(function (k) { rows.push({ k: k, v: String(d[k]) }); });
    if (!rows.length) rows.push({ k: '', v: '' });

    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100200;'
      + 'display:flex;align-items:center;justify-content:center;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#242424;border:1px solid #4a4a4a;border-radius:9px;'
      + 'padding:14px;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;'
      + 'box-shadow:0 12px 40px rgba(0,0,0,.7);color:#ddd;'
      + 'width:640px;max-width:94vw;max-height:86vh;';

    var h = document.createElement('div');
    h.style.cssText = 'font-size:13px;font-weight:600;color:#eee;flex:0 0 auto;';
    h.textContent = opts.title || '替换字典';
    box.appendChild(h);

    var tip = document.createElement('div');
    tip.style.cssText = 'font-size:11px;color:#9a9a9a;line-height:1.7;flex:0 0 auto;';
    tip.textContent = opts.tip || '左边填「要被替换的内容」，右边填「替换成什么」。保存后立即作用于字幕列表与导出。';
    box.appendChild(tip);

    // 表头
    var head = document.createElement('div');
    head.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 30px;gap:6px;'
      + 'font-size:11px;color:#9fb3c8;font-weight:600;flex:0 0 auto;padding:0 2px;';
    head.innerHTML = '<span>替换前（错误写法）</span><span>替换后（正确写法）</span><span></span>';
    box.appendChild(head);

    // 行容器（可滚动）
    var list = document.createElement('div');
    list.style.cssText = 'flex:1 1 auto;min-height:160px;max-height:52vh;overflow:auto;'
      + 'display:flex;flex-direction:column;gap:5px;padding-right:2px;';
    box.appendChild(list);

    function mkInput(val, placeholder) {
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.value = val || '';
      inp.placeholder = placeholder || '';
      inp.style.cssText = 'width:100%;box-sizing:border-box;background:#1c1c1c;color:#ddd;'
        + 'border:1px solid #444;border-radius:5px;padding:5px 8px;font-size:12px;';
      return inp;
    }

    function render() {
      list.innerHTML = '';
      rows.forEach(function (r, i) {
        var row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 30px;gap:6px;align-items:center;';
        var ik = mkInput(r.k, '要替换掉的内容');
        var iv = mkInput(r.v, '替换成');
        ik.addEventListener('input', function () { rows[i].k = ik.value; });
        iv.addEventListener('input', function () { rows[i].v = iv.value; });
        // 回车跳到下一个输入框（末行回车则新增一行，便于连续录入）
        function onEnter(e) {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          var all = list.querySelectorAll('input');
          var pos = Array.prototype.indexOf.call(all, e.target);
          if (pos === all.length - 1) { rows.push({ k: '', v: '' }); render(); focusLast(); }
          else { all[pos + 1].focus(); }
        }
        ik.addEventListener('keydown', onEnter);
        iv.addEventListener('keydown', onEnter);

        var del = document.createElement('button');
        del.type = 'button';
        del.textContent = '✕';
        del.title = '删除这一条';
        del.style.cssText = 'background:#3a2a2a;color:#ff9a9a;border:none;border-radius:5px;'
          + 'height:26px;cursor:pointer;font-size:11px;';
        del.addEventListener('click', function () {
          rows.splice(i, 1);
          if (!rows.length) rows.push({ k: '', v: '' });
          render();
        });

        row.appendChild(ik); row.appendChild(iv); row.appendChild(del);
        list.appendChild(row);
      });
    }
    function focusLast() {
      var all = list.querySelectorAll('input');
      if (all.length) all[all.length - 1].focus();
    }
    render();

    // 底部：新增 + 数量 + 操作
    var foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:8px;align-items:center;flex:0 0 auto;';
    var add = document.createElement('button');
    add.type = 'button';
    add.className = 'tbtn';
    add.textContent = '＋ 新增一条';
    add.style.cssText = 'padding:5px 12px;font-size:12px;';
    add.addEventListener('click', function () { rows.push({ k: '', v: '' }); render(); focusLast(); });
    var cnt = document.createElement('span');
    cnt.className = 'mini';
    cnt.style.cssText = 'font-size:11px;color:#8a8a8a;';
    foot.appendChild(add);
    foot.appendChild(cnt);
    var grow = document.createElement('span');
    grow.style.flex = '1';
    foot.appendChild(grow);

    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'tbtn';
    cancel.textContent = '取消';
    cancel.style.cssText = 'padding:5px 16px;font-size:12px;background:#3a3a3a;';
    cancel.addEventListener('click', function () { close(null); });

    var clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'tbtn';
    clearAll.textContent = '清空全部';
    clearAll.style.cssText = 'padding:5px 12px;font-size:12px;background:#3a3a3a;';
    clearAll.addEventListener('click', function () {
      rows = [{ k: '', v: '' }];
      render();
      cnt.textContent = '已清空';
    });

    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'tbtn on';
    save.textContent = '保存';
    save.style.cssText = 'padding:5px 18px;font-size:12px;';
    save.addEventListener('click', function () {
      var out = {};
      var bad = 0;
      rows.forEach(function (r) {
        var k = String(r.k || '').trim();
        if (!k) return;                     // 空的原值忽略
        out[k] = String(r.v == null ? '' : r.v);
      });
      close(out);
    });

    foot.appendChild(clearAll);
    foot.appendChild(cancel);
    foot.appendChild(save);
    box.appendChild(foot);

    // 计数实时更新
    function tick() {
      var n = rows.filter(function (r) { return String(r.k || '').trim(); }).length;
      cnt.textContent = '共 ' + n + ' 条有效规则';
    }
    list.addEventListener('input', tick);
    list.addEventListener('click', tick);
    add.addEventListener('click', tick);
    tick();

    ov.appendChild(box);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(null); });
    ov.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
    });
    document.body.appendChild(ov);
    cur = { ov: ov, cb: cb };
    setTimeout(function () {
      var first = list.querySelector('input');
      if (first) first.focus();
    }, 40);
  }

  window.__vhDictEditor = open;
})();
