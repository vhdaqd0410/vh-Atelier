/**
 * vh-Atelier · DaVinci Resolve 版 · 通用右键菜单
 *
 * 【为什么单独做一份】原有实现把菜单 append 进 #sfxContextMenu / #mllibContextMenu，
 * 而那两个容器在 CSS 里是 display:none（用于「关闭菜单」），显示时从未被设回可见，
 * 于是菜单永远看不见 —— 表现就是「右键没反应」。
 *
 * 这里改为：菜单直接挂到 document.body，用 fixed 定位，用完即从 DOM 移除。
 * 不复用任何常驻容器，从根上避免「容器隐藏导致菜单消失」这类问题。
 *
 * 用法：
 *   vhMenu.show(ev, [
 *     { label: '🚫 排除该目录', onClick: fn },
 *     { sep: true },
 *     { label: '查看已排除', onClick: fn, disabled: true }
 *   ]);
 */
(function () {
  'use strict';

  var cur = null;

  function close() {
    if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
    cur = null;
  }

  /**
   * 在事件位置弹出菜单。
   * @param {MouseEvent|{clientX:number,clientY:number,target?:Element}} ev
   * @param {Array<{label?:string,onClick?:Function,disabled?:boolean,sep?:boolean}>} items
   */
  function show(ev, items) {
    close();

    // ⋯ 按钮触发时没有真实坐标 → 用元素位置兜底
    var x = ev && typeof ev.clientX === 'number' ? ev.clientX : 0;
    var y = ev && typeof ev.clientY === 'number' ? ev.clientY : 0;
    if ((!x && !y) && ev && ev.target && ev.target.getBoundingClientRect) {
      try {
        var r0 = ev.target.getBoundingClientRect();
        x = Math.round(r0.left);
        y = Math.round(r0.bottom);
      } catch (e) { /* 忽略 */ }
    }

    var menu = document.createElement('div');
    menu.className = 'vh-ctx-menu';
    menu.style.cssText = 'position:fixed;z-index:99999;min-width:170px;max-width:420px;'
      + 'background:#262626;border:1px solid #4a4a4a;border-radius:7px;padding:4px;'
      + 'box-shadow:0 8px 24px rgba(0,0,0,.6);font-size:12px;color:#ddd;'
      + 'user-select:none;-webkit-user-select:none;';

    (items || []).forEach(function (it) {
      if (!it) return;
      if (it.sep) {
        var hr = document.createElement('div');
        hr.style.cssText = 'height:1px;background:#3d3d3d;margin:4px 6px;';
        menu.appendChild(hr);
        return;
      }
      var disabled = it.disabled === true || typeof it.onClick !== 'function';
      var b = document.createElement('div');
      b.textContent = it.label || '';
      b.title = it.label || '';
      b.style.cssText = 'padding:6px 10px;border-radius:4px;white-space:nowrap;overflow:hidden;'
        + 'text-overflow:ellipsis;cursor:' + (disabled ? 'default' : 'pointer')
        + ';' + (disabled ? 'opacity:.45;' : '');
      if (!disabled) {
        b.addEventListener('mouseenter', function () { b.style.background = '#3a3a3a'; });
        b.addEventListener('mouseleave', function () { b.style.background = ''; });
        b.addEventListener('mousedown', function (e2) { e2.preventDefault(); e2.stopPropagation(); });
        b.addEventListener('click', function (e2) {
          e2.preventDefault();
          e2.stopPropagation();
          close();
          try { it.onClick(); } catch (err) { console.error('[menu]', err); }
        });
      }
      menu.appendChild(b);
    });

    // 先放到视口外量尺寸，再定位，避免闪一下
    menu.style.left = '-9999px';
    menu.style.top = '0px';
    document.body.appendChild(menu);

    var w = menu.offsetWidth, h = menu.offsetHeight;
    var W = window.innerWidth, H = window.innerHeight;
    if (x + w > W - 6) x = Math.max(6, W - w - 6);
    if (y + h > H - 6) y = Math.max(6, y - h);      // 下方不够就翻到上方
    if (x < 6) x = 6;
    if (y < 6) y = 6;
    menu.style.left = Math.round(x) + 'px';
    menu.style.top = Math.round(y) + 'px';

    cur = menu;

    // 点别处 / 滚动 / Esc 关闭。延迟绑定，避免本次右键立刻把自己关掉。
    setTimeout(function () {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('contextmenu', onDocCtx, true);
      window.addEventListener('wheel', close, { passive: true, once: true });
      window.addEventListener('blur', close, { once: true });
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  function onDocDown(e) {
    if (cur && !cur.contains(e.target)) close();
  }
  function onDocCtx(e) {
    // 在菜单外再次右键：关掉当前，让新的自己弹
    if (cur && !cur.contains(e.target)) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  /** 居中弹一个面板（用于「已排除」这类管理视图） */
  function panel(title, bodyEl, actions) {
    close();
    var ov = document.createElement('div');
    ov.className = 'vh-ctx-panel-ov';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.45);';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'background:#242424;border:1px solid #4a4a4a;border-radius:9px;padding:14px;'
      + 'min-width:380px;max-width:min(760px,88vw);max-height:76vh;display:flex;flex-direction:column;'
      + 'box-shadow:0 12px 40px rgba(0,0,0,.65);color:#ddd;';
    var h = document.createElement('div');
    h.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:10px;flex:0 0 auto;';
    h.textContent = title || '';
    wrap.appendChild(h);

    var scroll = document.createElement('div');
    scroll.style.cssText = 'flex:1 1 auto;min-height:0;overflow:auto;';
    scroll.appendChild(bodyEl);
    wrap.appendChild(scroll);

    var foot = document.createElement('div');
    foot.style.cssText = 'flex:0 0 auto;margin-top:12px;display:flex;gap:8px;justify-content:flex-end;';
    (actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'tbtn' + (a.primary ? ' on' : '');
      b.textContent = a.label;
      b.addEventListener('click', function () {
        if (a.onClick) { try { a.onClick(); } catch (e) {} }
        if (a.keepOpen !== true) close();
      });
      foot.appendChild(b);
    });
    var ok = document.createElement('button');
    ok.className = 'tbtn on';
    ok.textContent = '关闭';
    ok.addEventListener('click', close);
    foot.appendChild(ok);
    wrap.appendChild(foot);
    ov.appendChild(wrap);
    document.body.appendChild(ov);
    cur = ov;
    setTimeout(function () {
      document.addEventListener('mousedown', function (e) {
        if (cur === ov && !wrap.contains(e.target)) close();
      }, { once: true });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close();
      }, { once: true });
    }, 0);
    return ov;
  }

  window.vhMenu = { show: show, close: close, panel: panel };
})();
