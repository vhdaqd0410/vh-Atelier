/**
 * vh-Atelier · DaVinci Resolve 版 · 剧本模块
 *
 * 阅读器逐行移植自 PR 版 js/script.js（整段照搬，保留其全部内联样式与交互：
 * 彩色字体、选中即弹复制菜单、双击复制、逐行/整集翻译、换剧本、搜索、集数导航）。
 * 只替换宿主相关层：文件选择 / 解析 / 切组 / 复制。
 *
 * 对外接口：window.__scriptPanel
 */
(function () {
  'use strict';

  var RECENT_KEY = 'vh_script_recent';   // [{ path, name, project, t }]
  var READ_KEY = 'vh_script_reading';    // { path, ep }

  function baseName(p) {
    return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setStatus(msg) {
    var s = document.getElementById('SCR-status');
    if (s) s.textContent = msg || '待命';
  }
  function toast(m, k) {
    if (window.__vhToast) window.__vhToast(m, k); else console.log('[script] ' + m);
  }
  function switchToScriptGroup() {
    var g = document.querySelector('.ws-group[data-group="script"]');
    if (g) g.click();
    var t = document.querySelector('.tabs.ws-subtabs[data-group="script"] .tab[data-tab="script"]');
    if (t) t.click();
  }

  // ---------- 复制 / 轻提示（模块级，阅读器与其它面板共用） ----------
  window.__copyFlash = function (msg) {
    var tip = document.createElement('span');
    tip.textContent = msg || '✓ 已复制';
    var bad = String(msg || '').indexOf('失败') >= 0;
    tip.style.cssText = 'position:fixed;left:50%;top:40%;transform:translateX(-50%);background:'
      + (bad ? '#3a2a2a' : '#2a3a2a') + ';color:' + (bad ? '#ff9090' : '#7fd68b')
      + ';padding:6px 14px;border-radius:6px;font-size:12px;z-index:1001;pointer-events:none;';
    document.body.appendChild(tip);
    setTimeout(function () { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 1400);
  };
  window.__copyText = function (text) {
    var done = false;
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      done = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { done = false; }
    if (!done) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text); done = true;
        }
      } catch (e2) { done = false; }
    }
    window.__copyFlash && window.__copyFlash(done ? '已复制' : '复制失败，请手动选中复制');
  };

  // ---------- 最近阅读 / 在读位置 ----------
  function loadRecentScripts() {
    try {
      var raw = localStorage.getItem(RECENT_KEY);
      if (raw) { var a = JSON.parse(raw); if (Array.isArray(a)) return a; }
    } catch (e) {}
    return [];
  }
  function saveRecentScripts(a) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(a)); } catch (e) {}
  }
  function pushRecentScript(docxPath, projectName) {
    try {
      var arr = loadRecentScripts().filter(function (r) { return r.path !== docxPath; });
      arr.unshift({ path: docxPath, name: baseName(docxPath), project: projectName || '', t: Date.now() });
      if (arr.length > 30) arr = arr.slice(0, 30);
      saveRecentScripts(arr);
    } catch (e) {}
  }
  function saveReading(path, ep) {
    try { localStorage.setItem(READ_KEY, JSON.stringify({ path: path, ep: ep })); } catch (e) {}
  }
  function clearReading() { try { localStorage.removeItem(READ_KEY); } catch (e) {} }
  function loadReading() {
    try {
      var raw = localStorage.getItem(READ_KEY);
      if (raw) { var o = JSON.parse(raw); if (o && o.path) return o; }
    } catch (e) {}
    return null;
  }

  // ==================== 剧本库首页 ====================
  function showScriptHome() {
    var hostPanel = document.getElementById('panel-script');
    if (!hostPanel) return;
    hostPanel.innerHTML = '';
    var box = document.createElement('div');
    box.id = 'scriptHomeBox';
    box.style.cssText = 'flex:1;height:auto;display:flex;flex-direction:column;overflow:hidden;'
      + 'background:var(--panel,#181818);border-radius:8px;border:1px solid #3a3a3a;padding:14px 16px;overflow-y:auto;';

    var h = document.createElement('div');
    h.style.cssText = 'font-size:14px;font-weight:600;color:#e8e8e8;margin-bottom:4px;';
    h.textContent = '📖 剧本库';
    box.appendChild(h);
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:var(--muted);margin-bottom:14px;';
    sub.textContent = '直接打开本地剧本阅读 · 解析在本机完成，不上传任何内容';
    box.appendChild(sub);

    var openBtn = document.createElement('button');
    openBtn.textContent = '📂  打开剧本文件…';
    openBtn.style.cssText = 'display:block;width:100%;padding:12px;font-size:13px;font-weight:600;'
      + 'background:var(--accent,#537d96);color:#fff;border:none;border-radius:8px;cursor:pointer;margin-bottom:14px;';
    openBtn.addEventListener('click', function () { pickScript(); });
    box.appendChild(openBtn);

    function itemRow(p, metaRight) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;background:#242424;border:1px solid #333;'
        + 'border-radius:6px;padding:7px 10px;margin-bottom:6px;cursor:pointer;';
      row.addEventListener('click', function () { openScript(p); });
      var ic = document.createElement('span');
      ic.textContent = '📄';
      row.appendChild(ic);
      var nm = document.createElement('span');
      nm.style.cssText = 'flex:1;font-size:12px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      nm.textContent = baseName(p);
      nm.title = p;
      row.appendChild(nm);
      if (metaRight) {
        var mt = document.createElement('span');
        mt.style.cssText = 'flex:0 0 auto;font-size:10px;color:var(--muted);';
        mt.textContent = metaRight;
        row.appendChild(mt);
      }
      return row;
    }

    var recents = loadRecentScripts().filter(function (r) {
      try { return window.vhHost.fsSync.exists(r.path); } catch (e) { return false; }
    });
    if (recents.length > 0) {
      var st = document.createElement('div');
      st.style.cssText = 'font-size:11px;color:#9fb3c8;font-weight:600;margin:6px 0;';
      st.textContent = '最近阅读';
      box.appendChild(st);
      recents.slice(0, 15).forEach(function (r) {
        var when = '';
        try {
          var d = new Date(r.t), now = new Date();
          var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
          when = (d.toDateString() === now.toDateString())
            ? '今天 ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
            : (d.getMonth() + 1) + '/' + d.getDate();
        } catch (e) {}
        box.appendChild(itemRow(r.path, when));
      });
    } else {
      var tip = document.createElement('div');
      tip.style.cssText = 'padding:18px;text-align:center;font-size:12px;color:var(--muted);'
        + 'background:#202020;border:1px dashed #3a3a3a;border-radius:8px;line-height:1.8;';
      tip.innerHTML = '还没有剧本记录。<br>点上方「📂 打开剧本文件…」选一个 docx / pdf / txt 开始。<br><br>'
        + '打开过的会自动出现在「最近阅读」，下次直接点。';
      box.appendChild(tip);
    }
    hostPanel.appendChild(box);
    setStatus('共 ' + recents.length + ' 份记录');
  }

  // ==================== 解析并打开 ====================
  function openScript(filePath, restoreEp) {
    if (!filePath) return;
    if (!window.vhHost || !window.vhHost.scriptParse) { toast('解析接口不可用', 'err'); return; }
    setStatus('解析中：' + baseName(filePath) + '…');
    window.vhHost.scriptParse(filePath).then(function (r) {
      var d = r && r.data ? r.data : r;
      if (!d || d.ok === false) {
        var msg = (d && d.error) || '未知错误';
        if (String(filePath).toLowerCase().endsWith('.pdf')) {
          msg += '\n\n（PDF 需为文字版；扫描图片版暂不支持）';
        }
        toast('解析失败：' + msg, 'err');
        setStatus('解析失败');
        return;
      }
      openScriptReader(d, filePath, '', restoreEp);
    }).catch(function (e) {
      toast('解析失败：' + (e && e.message || e), 'err');
      setStatus('解析失败');
    });
  }

  function pickScript() {
    if (!window.vhHost || !window.vhHost.pickScript) { toast('文件选择不可用', 'err'); return; }
    window.vhHost.pickScript().then(function (r) {
      var p = r && r.data ? r.data : r;
      if (Array.isArray(p)) p = p[0];
      if (p) openScript(p);
    }).catch(function (e) { toast('选择失败：' + (e.message || e), 'err'); });
  }

  // 供素材面板等按路径直接打开
  window.__openDocxByPath = function (docxPath) {
    try {
      if (!docxPath || !window.vhHost.fsSync.exists(docxPath)) return false;
      openScript(docxPath);
      return true;
    } catch (e) { return false; }
  };

    function openScriptReader(data, docxPath, projectName, restoreEp) {
        // 剧本阅读作为独立面板（panel-script + 顶部「剧本」组），不遮挡其它板块
        var hostPanel = document.getElementById('panel-script');
        if (!hostPanel) return;
        // 记录最近阅读（跨项目，供剧本库首页）
        if (docxPath) pushRecentScript(docxPath, projectName);
        // 记为「在读」：点剧本组自动续读；关闭时清除
        saveReading(docxPath, restoreEp != null ? restoreEp : null);
        hostPanel.innerHTML = '';
        var box = document.createElement('div');
        box.id = 'scriptReaderBox';
        box.style.cssText = 'flex:1;height:auto;display:flex;flex-direction:column;overflow:hidden;background:var(--panel,#181818);border-radius:8px;border:1px solid #3a3a3a;';

        // ---------- 头部 ----------
        var head = document.createElement('div');
        head.style.cssText = 'padding:6px 12px;border-bottom:1px solid #2e2e2e;display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:#222;border-radius:8px 8px 0 0;';
        var title = document.createElement('span');
        title.style.cssText = 'font-size:12.5px;font-weight:600;color:#e8e8e8;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;';
        title.textContent = '📖 ' + (projectName || '') + (docxPath ? ' · ' + baseName(docxPath) : '');
        title.title = docxPath;
        head.appendChild(title);
        // 搜索框
        var searchInp = document.createElement('input');
        searchInp.type = 'text';
        searchInp.placeholder = '🔍 输入集号（如 3）或关键词…';
        searchInp.style.cssText = 'flex:1;min-width:150px;background:#242424;color:#ddd;border:1px solid #444;border-radius:4px;padding:5px 8px;font-size:12px;';
        head.appendChild(searchInp);
        var searchState = document.createElement('span');
        searchState.style.cssText = 'font-size:11px;color:#c9a86a;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        head.appendChild(searchState);
        // 命中定位：上一条 / 下一条 / 只看命中
        var hitPrev = document.createElement('button');
        hitPrev.textContent = '↑';
        hitPrev.title = '上一个命中';
        hitPrev.style.cssText = 'background:#2a2a2a;color:#c9a86a;border:1px solid #4a4a2a;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px;display:none;';
        head.appendChild(hitPrev);
        var hitNext = document.createElement('button');
        hitNext.textContent = '↓';
        hitNext.title = '下一个命中';
        hitNext.style.cssText = hitPrev.style.cssText;
        head.appendChild(hitNext);
        var onlyHitBtn = document.createElement('button');
        onlyHitBtn.textContent = '只看命中';
        onlyHitBtn.title = '切换：只列出命中行 / 保留原文并定位';
        onlyHitBtn.style.cssText = 'background:#2a2a2a;color:#888;border:1px solid #444;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px;display:none;';
        head.appendChild(onlyHitBtn);
        // 翻译
        var transBtn = document.createElement('button');
        transBtn.textContent = '🌐 翻译台词';
        transBtn.style.cssText = 'background:#1e3a2a;color:#7fd68b;border:1px solid #2a5a3a;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;';
        head.appendChild(transBtn);
        var transState = document.createElement('span');
        transState.style.cssText = 'font-size:11px;color:#888;';
        head.appendChild(transState);
        var mailBtn = document.createElement('button');
        mailBtn.textContent = '📮';
        mailBtn.title = '设置翻译邮箱（MyMemory 提额 10 倍）';
        mailBtn.style.cssText = 'background:#2a2a2a;color:#c9a86a;border:1px solid #4a4a2a;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:12px;';
        head.appendChild(mailBtn);
        // 换一个剧本：回剧本库首页（不关闭面板）
        var switchBtn = document.createElement('button');
        switchBtn.textContent = '📂 换剧本';
        switchBtn.title = '回到剧本库，换一个剧本';
        switchBtn.style.cssText = 'background:#1e3a2a;color:#7fd68b;border:1px solid #2a5a3a;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px;flex:0 0 auto;';
        switchBtn.addEventListener('click', function () {
            document.removeEventListener('keydown', escHandler);
            clearReading();   // 主动换剧本：不再续读当前这本
            if (hostPanel) hostPanel.innerHTML = '';
            showScriptHome();
            switchToScriptGroup();
        });
        head.appendChild(switchBtn);
        var close = document.createElement('button');
        close.textContent = '✕ 关闭剧本';
        close.title = '关闭剧本阅读，返回进度';
        close.style.cssText = 'background:#4a2a2a;color:#ff9a9a;border:none;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:12px;flex:0 0 auto;';
        head.appendChild(close);
        box.appendChild(head);

        // ---------- 主体：左列表 + 右内容 ----------
        var main = document.createElement('div');
        main.style.cssText = 'flex:1;display:flex;overflow:hidden;min-height:0;';
        // 左栏：集数列表
        var sidebar = document.createElement('div');
        sidebar.style.cssText = 'width:150px;flex:0 0 150px;border-right:1px solid #2a2a2a;overflow-y:auto;background:#141414;padding:6px 0;';
        main.appendChild(sidebar);
        // 右栏：内容
        var body = document.createElement('div');
        body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 18px 40px;font-size:13.5px;line-height:1.8;color:#ddd;word-break:break-word;';
        main.appendChild(body);
        box.appendChild(main);
        hostPanel.appendChild(box);
        // 显示「剧本」组并切换过去
        switchToScriptGroup();

        // ---------- 状态 ----------
        var eps = data.episodes || [];
        // 恢复上次阅读的集：restoreEp 存在且在该剧本集数内才定位；否则 null=全部
        var curEp = null;
        if (restoreEp != null && eps.indexOf(restoreEp) >= 0) curEp = restoreEp;
        var curEpKey = curEp != null ? String(curEp) : 'all';
        var translating = false;
        var transMap = {};           // 批量翻译缓存：'__'+epkey -> {台词行:译文}
        var lineTransMap = {};       // 单句翻译缓存
        var searchKeyword = '';      // 关键词搜索（非集号时）
        var searchHits = [];         // 当前命中的 <mark> 元素列表
        var hitIdx = -1;             // 当前定位到第几个命中（0 基）
        var onlyHits = false;        // false=保留全文并定位到第一个命中；true=只列出命中行
        var pendingScrollEp = null;  // 渲染后需要滚动到的集（选集/跳集时置位）
        var viewEp = null;           // 当前视口顶部所在的集（随右栏滚动变化，驱动左栏高亮）
        var epMarks = [];            // [[集号, 标题元素], ...] 渲染后缓存，供滚动同步快速取用
        var epMarksDirty = true;

        function epLines(ep) {
            return (data.lines || []).filter(function (x) { return ep ? x.episode === ep : true; });
        }
        function extractEnglish(line) {
            var t = line || '';
            var m = t.match(/^[^:：]*[:：]\s*(.*)$/);
            if (m) t = m[1];
            t = t.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/g, ' ').replace(/\s+/g, ' ').trim();
            return t;
        }
        function isEnglish(s) { return /[A-Za-z]{3,}/.test(s); }
        function translateLine(text, cb) {
            var U = window.__vhUtils || {};
            var url = (U.myMemoryUrl ? U.myMemoryUrl(text) :
                'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en%7Czh-CN');
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.timeout = 15000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                try {
                    var j = JSON.parse(xhr.responseText);
                    var out = j && j.responseData && j.responseData.translatedText;
                    cb(null, out || '');
                } catch (e) { cb(e); }
            };
            xhr.onerror = function () { cb(new Error('网络错误')); };
            xhr.ontimeout = function () { cb(new Error('超时')); };
            xhr.send();
        }

        // ---------- 左栏集数列表（全量渲染下：点击 = 滚动定位 + 高亮）----------
        // 左栏项按集号存起来，右栏滚动时只切样式不重建 DOM（避免闪烁与开销）
        var sidebarMap = {};   // 'all' 或 String(ep) -> element
        var SIDE_NORMAL = 'padding:5px 12px;font-size:12px;color:#aaa;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:2px solid transparent;';
        var SIDE_ACTIVE = 'padding:5px 12px;font-size:12px;color:#8fc0e8;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:2px solid #537d96;background:#22303c;';

        // 高亮指定集（并保证它在左栏可视区内）
        function updateSidebarActive(ep) {
            var key = (ep != null ? String(ep) : 'all');
            Object.keys(sidebarMap).forEach(function (k) {
                var el2 = sidebarMap[k];
                if (!el2 || !el2.parentNode) return;
                el2.style.cssText = (k === key) ? SIDE_ACTIVE : SIDE_NORMAL;
            });
            var cur = sidebarMap[key];
            if (!cur) return;
            // 左栏自身滚动，让高亮项居中可见
            try {
                var top = cur.offsetTop;
                var h = cur.offsetHeight || 24;
                var viewTop = sidebar.scrollTop;
                var viewBottom = viewTop + sidebar.clientHeight;
                if (top < viewTop + 4 || top + h > viewBottom - 4) {
                    sidebar.scrollTop = Math.max(0, top - sidebar.clientHeight / 2 + h / 2);
                }
            } catch (e) {}
        }

        function renderSidebar() {
            sidebar.innerHTML = '';
            sidebarMap = {};
            function addItem(label, ep) {
                var it = document.createElement('div');
                var isActive = (viewEp != null) ? (ep === viewEp) : (curEp === ep);
                it.style.cssText = isActive ? SIDE_ACTIVE : SIDE_NORMAL;
                it.textContent = label;
                sidebarMap[ep != null ? String(ep) : 'all'] = it;
                it.addEventListener('click', function () {
                    curEp = ep;
                    curEpKey = curEp != null ? String(curEp) : 'all';
                    viewEp = ep;
                    searchKeyword = '';
                    searchInp.value = '';
                    searchState.textContent = '';
                    searchHits = []; hitIdx = -1;
                    pendingScrollEp = ep;   // 全量渲染后滚到该集
                    saveReading(docxPath, curEp);   // 记住读到第几集
                    renderSidebar();
                    render();
                });
                sidebar.appendChild(it);
            }
            addItem('📄 全部', null);
            eps.forEach(function (e) { addItem('第 ' + e + ' 集', e); });
            // 渲染完把高亮项滚到左栏可视区（点开续读时直接定位）
            var key = (viewEp != null) ? String(viewEp) : ((curEp != null) ? String(curEp) : 'all');
            var act = sidebarMap[key];
            if (act) {
                try {
                    var top = act.offsetTop, h = act.offsetHeight || 24;
                    if (top < sidebar.scrollTop || top + h > sidebar.scrollTop + sidebar.clientHeight) {
                        sidebar.scrollTop = Math.max(0, top - sidebar.clientHeight / 2 + h / 2);
                    }
                } catch (e2) {}
            }
        }

        // ---------- 台词渲染 ----------
        function renderDialogue(text, ep) {
            var m = text.match(/^([^:：]{1,50}?)[：:]\s*(.*)$/);
            if (!m) return '<div class="scr-dlg">' + escHtml(text) + '</div>';
            var rolePart = m[1], speech = m[2];
            var zhCount = (speech.match(/[\u4e00-\u9fff]/g) || []).length;
            var enCount = (speech.match(/[A-Za-z]/g) || []).length;
            var isZhMain = zhCount > enCount && zhCount > 2;
            var roleHtml = escHtml(rolePart);
            roleHtml = roleHtml.replace(/([（(][^）)]*[）)])/g, '<span style="color:#9a8a8a;font-weight:400;">$1</span>');
            var speechHtml;
            if (isZhMain) {
                speechHtml = escHtml(speech).replace(/([（(][^）)]*[）)])/g, '<span style="color:#9a8a8a;font-size:12px;">$1</span>');
            } else {
                speechHtml = escHtml(speech).replace(/([\u4e00-\u9fff]+)/g, '<span style="color:#9a9a9a;font-size:12px;">$1</span>');
            }
            // 关键词高亮
            if (searchKeyword) {
                var kw = searchKeyword;
                speechHtml = hlText(speechHtml, kw);
                roleHtml = hlText(roleHtml, kw);
            }
            var spColor = isZhMain ? '#ff9090' : '#ff6b6b';
            var cachedZh = lineTransMap[text];
            var zhHtml = '';
            if (cachedZh) zhHtml = '<div class="scr-zh">' + escHtml(cachedZh) + '</div>';
            else {
                // 批量翻译缓存（整集翻译按钮）：按该行自己的集号取，全量渲染下也能命中
                var bk = (ep != null ? String(ep) : curEpKey);
                if (bk && transMap['__' + bk] && transMap['__' + bk][text]) {
                    zhHtml = '<div class="scr-zh">' + escHtml(transMap['__' + bk][text]) + '</div>';
                }
            }
            var en = extractEnglish(text);
            return '<div class="scr-dlg" data-role="' + escHtml(rolePart) + '" data-speech="' + escHtml(speech) + '">'
                + '<span class="scr-role" style="color:#ffb347;font-weight:700;">' + roleHtml + '</span>'
                + '<span style="color:#8a7a6a;"> : </span>'
                + '<span class="scr-sp" style="color:' + spColor + ';">' + speechHtml + '</span>'
                + '<span class="scr-copy" data-copy="' + escHtml(speech) + '" title="复制台词（也可直接选中文字）">⧉</span>'
                + '<span class="scr-trn" data-line="' + escHtml(text) + '" data-en="' + escHtml(en) + '" title="翻译本句">译</span>'
                + zhHtml + '</div>';
        }
        // 在已转义 HTML 上做关键词高亮（简单：大小写不敏感子串包 <mark>）—— 因 HTML 已含标签，仅在纯文本段操作有风险；改为渲染前对原文高亮。
        function hlText(escapedHtml, kw) { return escapedHtml; } // 占位，实际用 render 层高亮

        // 渲染右栏（全量渲染所有集：选集只做滚动定位，上下滚可连续阅读相邻集）
        function render() {
            var lines = data.lines || [];
            var html = '';
            epMarks = [];   // [集号, 元素] 缓存，避免滚动时反复查询 DOM
            for (var li = 0; li < lines.length; li++) {
                var x = lines[li];
                var t = x.text || '';
                var tp = x.type || 'plain';
                // 关键词：默认保留全文（看得到上下文），切到「只看命中」时才过滤
                if (searchKeyword && onlyHits) {
                    if (t.toLowerCase().indexOf(searchKeyword) < 0) continue;
                }
                var disp = escHtml(t);
                if (searchKeyword) {
                    disp = hlOnPlain(t);
                }
                if (tp === 'ep_title') {
                    html += '<div class="scr-ept" data-ep="' + (x.episode != null ? x.episode : '') + '" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                    epMarks.push(x.episode);
                } else if (tp === 'scene') {
                    html += '<div class="scr-scene" data-raw="' + escHtml(t) + '">🎬 ' + disp + '</div>';
                } else if (tp === 'cast') {
                    html += '<div class="scr-cast" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'action') {
                    html += '<div class="scr-action" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'caption') {
                    html += '<div class="scr-caption" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                } else if (tp === 'dialogue') {
                    html += renderDialogue(t, x.episode);
                } else {
                    html += '<div class="scr-plain" data-raw="' + escHtml(t) + '">' + disp + '</div>';
                }
            }
            var emptyHtml = '<div style="color:#888;padding:30px;text-align:center;">' +
                (searchKeyword ? (onlyHits ? '没有匹配「' + escHtml(searchKeyword) + '」的内容' : '剧本暂无内容')
                               : '剧本暂无内容') + '</div>';
            body.innerHTML = html || emptyHtml;
            epMarksDirty = true;
            applyHighlight();
            refreshHitUI();
            // 选集模式：渲染后滚动到目标集（仅当没有在定位搜索命中时）
            if (pendingScrollEp != null && !searchKeyword) {
                scrollToEp(pendingScrollEp);
                if (viewEp !== pendingScrollEp) { viewEp = pendingScrollEp; updateSidebarActive(viewEp); }
                pendingScrollEp = null;
            } else {
                // 普通重渲染：按当前滚动位置回填左栏高亮
                onBodyScroll();
            }
        }

        // 滚动到指定集的标题行（顶部对齐）
        function scrollToEp(ep) {
            if (ep == null) return;
            var node = body.querySelector('.scr-ept[data-ep="' + ep + '"]');
            if (!node) return;
            try {
                var bodyRect = body.getBoundingClientRect();
                var elRect = node.getBoundingClientRect();
                body.scrollTop += (elRect.top - bodyRect.top) - 6;
            } catch (e) {}
        }

        // 集标题缓存：每次 render 后标记失效，首次滚动时惰性重建
        function buildEpMarks() {
            if (!epMarksDirty) return;
            epMarks = [];
            var nodes = body.querySelectorAll('.scr-ept[data-ep]');
            for (var i = 0; i < nodes.length; i++) {
                var v = nodes[i].getAttribute('data-ep');
                if (v === '' || v == null) continue;
                epMarks.push([v, nodes[i]]);
            }
            epMarksDirty = false;
        }

        // 右栏滚动 → 算出当前视口顶部对应的集，同步左栏高亮 + 左栏自动滚动
        var syncRaf = null;
        function readVisibleEp() {
            buildEpMarks();
            if (!epMarks.length) return null;
            var bodyTop = body.getBoundingClientRect().top;
            var cur = null;
            for (var i = 0; i < epMarks.length; i++) {
                // 标题顶端已到达（或越过）视口顶部的，就是当前集；取最后一个
                if (epMarks[i][1].getBoundingClientRect().top - bodyTop <= 8) cur = epMarks[i][0];
                else break;
            }
            if (cur == null) cur = epMarks[0][0];   // 还没到任何集标题，算作第一集
            return cur != null ? parseInt(cur, 10) : null;
        }
        function onBodyScroll() {
            if (syncRaf) return;
            syncRaf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
                syncRaf = null;
                var ep = readVisibleEp();
                if (ep != null && ep !== viewEp) {
                    viewEp = ep;
                    curEp = ep;                       // 滚动也算「读到这一集」，翻译/记录对齐当前视口
                    curEpKey = String(ep);
                    updateSidebarActive(ep);
                    saveReading(docxPath, ep);        // 读到哪记到哪
                }
            });
        }
        body.addEventListener('scroll', onBodyScroll);

        // 收集所有命中标记（渲染后调用，dialogue 行的高亮由 applyHighlight 补，故必须在其后）
        function collectHits() {
            searchHits = [];
            if (!searchKeyword) return;
            var all = body.querySelectorAll('mark.scr-hl');
            for (var i = 0; i < all.length; i++) searchHits.push(all[i]);
        }

        // 跳到第 idx 个命中：高亮当前项并滚动到可视区中部
        function gotoHit(idx) {
            if (searchHits.length === 0) { hitIdx = -1; updateHitUI(); return; }
            if (idx < 0) idx = searchHits.length - 1;
            if (idx >= searchHits.length) idx = 0;
            for (var i = 0; i < searchHits.length; i++) searchHits[i].classList.remove('scr-hl-cur');
            hitIdx = idx;
            var el = searchHits[idx];
            el.classList.add('scr-hl-cur');
            try {
                var bodyRect = body.getBoundingClientRect();
                var elRect = el.getBoundingClientRect();
                body.scrollTop += (elRect.top - bodyRect.top) - body.clientHeight / 3;
            } catch (e) {}
            updateHitUI();
        }

        // 刷新命中计数与按钮显隐
        function updateHitUI() {
            var has = !!searchKeyword;
            hitPrev.style.display = has ? '' : 'none';
            hitNext.style.display = has ? '' : 'none';
            onlyHitBtn.style.display = has ? '' : 'none';
            if (!has) { searchState.textContent = ''; return; }
            if (searchHits.length === 0) { searchState.textContent = '无命中'; return; }
            searchState.textContent = '第 ' + (hitIdx + 1) + '/' + searchHits.length + ' 处';
        }

        // 重新收集 + 定位到第一个
        function refreshHitUI() {
            if (!searchKeyword) { searchHits = []; hitIdx = -1; updateHitUI(); return; }
            collectHits();
            if (searchHits.length > 0) gotoHit(0);
            else updateHitUI();
        }
        // 纯文本关键词高亮（在转义前的原文上做，避免破坏 HTML）
        function hlOnPlain(raw) {
            var kw = searchKeyword;
            if (!kw) return escHtml(raw);
            var out = '';
            var lower = raw.toLowerCase();
            var i = 0;
            while (true) {
                var idx = lower.indexOf(kw, i);
                if (idx < 0) { out += escHtml(raw.slice(i)); break; }
                out += escHtml(raw.slice(i, idx)) + '<mark class="scr-hl">' + escHtml(raw.slice(idx, idx + kw.length)) + '</mark>';
                i = idx + kw.length;
            }
            return out;
        }
        // 渲染后把 dialogue 行内的关键词也高亮（dialogue 走了 renderDialogue 未处理搜索词，用 DOM 补）
        function applyHighlight() {
            if (!searchKeyword) return;
            var kw = searchKeyword;
            var dlgEls = body.querySelectorAll('.scr-dlg');
            for (var i = 0; i < dlgEls.length; i++) {
                var el = dlgEls[i];
                if (el.getAttribute('data-hl')) continue;
                walkHighlight(el, kw);
                el.setAttribute('data-hl', '1');
            }
        }
        function walkHighlight(el, kw) {
            // 遍历文本节点，命中包 mark
            var nodes = el.childNodes;
            var toReplace = [];
            for (var i = 0; i < nodes.length; i++) {
                var n = nodes[i];
                if (n.nodeType === 3) {
                    var txt = n.nodeValue;
                    var lower = txt.toLowerCase();
                    if (lower.indexOf(kw) >= 0) toReplace.push(n);
                } else if (n.nodeType === 1 && n.tagName !== 'MARK' && n.tagName !== 'SPAN') {
                    walkHighlight(n, kw);
                } else if (n.nodeType === 1 && n.tagName === 'SPAN') {
                    walkHighlight(n, kw);
                }
            }
            toReplace.forEach(function (n) {
                var txt = n.nodeValue;
                var lower = txt.toLowerCase();
                var frag = document.createDocumentFragment();
                var i = 0;
                while (true) {
                    var idx = lower.indexOf(kw, i);
                    if (idx < 0) { frag.appendChild(document.createTextNode(txt.slice(i))); break; }
                    frag.appendChild(document.createTextNode(txt.slice(i, idx)));
                    var mk = document.createElement('mark');
                    mk.className = 'scr-hl';
                    mk.textContent = txt.slice(idx, idx + kw.length);
                    frag.appendChild(mk);
                    i = idx + kw.length;
                }
                n.parentNode.replaceChild(frag, n);
            });
        }

        // 样式
        var st = document.createElement('style');
        st.textContent = '.scr-dlg{margin:3px 0;padding:2px 4px;position:relative;} .scr-dlg:hover{background:#242020;} .scr-dlg .scr-copy,.scr-dlg .scr-trn{visibility:hidden;display:inline;color:#888;cursor:pointer;font-size:11px;padding:0 4px;margin-left:4px;border-radius:3px;vertical-align:middle;} .scr-dlg:hover .scr-copy,.scr-dlg:hover .scr-trn{visibility:visible;} .scr-dlg .scr-copy:hover{color:#ffb347;background:#2a2a2a;} .scr-dlg .scr-trn:hover{color:#7fd68b;background:#1e2a1e;} .scr-zh{margin-top:2px;padding-left:8px;border-left:2px solid #4a6b4a;color:#9fe0a8;font-size:12.5px;} .scr-ept{margin:16px 0 8px;padding:5px 12px;background:#22303c;border-left:4px solid #537d96;border-radius:3px;font-weight:700;font-size:14px;color:#8fc0e8;} .scr-scene{margin:10px 0 3px;padding:2px 8px;color:#7fb3d9;font-weight:600;font-size:12.5px;} .scr-cast{color:#999;font-size:12px;padding:1px 8px;} .scr-action{color:#9a9a9a;font-style:italic;font-size:12.5px;padding:1px 8px;border-left:2px solid #3a3a3a;margin:2px 0;} .scr-caption{color:#c9a86a;font-size:12px;padding:1px 8px;} .scr-plain{padding:1px 8px;} mark.scr-hl{background:#5a4a1e;color:#ffd76a;padding:0 1px;border-radius:2px;} mark.scr-hl-cur{background:#ffb347;color:#1a1a1a;outline:1px solid #ffd76a;}.scr-selmenu{position:fixed;z-index:10060;overflow-y:auto;background:#242428;border:1px solid #4a4a52;border-radius:7px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.6);min-width:110px;max-width:520px;}.scr-selmenu .it{display:block;width:100%;text-align:left;background:none;border:none;color:#ddd;font-size:12px;padding:5px 8px;border-radius:4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:inherit;}.scr-selmenu .it:hover{background:#3a3a44;color:#fff;}.scr-selmenu .it .k{color:#ffb347;font-weight:600;margin-right:5px;}.scr-selmenu .hd{font-size:10px;color:#8a8a95;padding:3px 8px 4px;border-bottom:1px solid #3a3a42;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.scr-selmenu .sp{height:1px;background:#3a3a42;margin:3px 0;}.scr-selmenu .it.long .t{color:#ffd0d0;}.scr-selmenu .t{color:#a9d3ff;}.scr-selmenu .subh{font-size:10.5px;color:#8a8a95;margin:0;}.scr-dlg .scr-copy{cursor:pointer;}';
        document.head.appendChild(st);


    // ---------- 选中即弹复制菜单（台词复制增强） ----------
    // 设计：选中剧本里的任意文字 → 在选区旁浮出菜单；
    //       菜单里既有「复制选中」，也把选段/整句按标点断好的句子列出来，点一下即复制。
    var selMenuEl = null;

    function closeSelMenu() {
        if (selMenuEl && selMenuEl.parentNode) selMenuEl.parentNode.removeChild(selMenuEl);
        selMenuEl = null;
    }

    // 取当前选择所在「台词行的 speech 文本」（不含角色名），以及选中的片段
    function currentSelectionInfo() {
        var sel = window.getSelection && window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
        var txt = String(sel.toString() || '');
        if (!txt.trim()) return null;
        var node = sel.anchorNode;
        var el = node && (node.nodeType === 1 ? node : node.parentNode);
        var dlg = el && el.closest ? el.closest('.scr-dlg') : null;
        var speech = '';
        var role = '';
        if (dlg) {
            speech = dlg.getAttribute('data-speech') || '';
            role = dlg.getAttribute('data-role') || '';
            // 没有带上 data 属性（旧渲染）时，从 DOM 兜底提取
            if (!speech) {
                var sp = dlg.querySelector('.scr-sp');
                speech = sp ? String(sp.textContent || '') : '';
            }
            if (!role) {
                var rl = dlg.querySelector('.scr-role');
                role = rl ? String(rl.textContent || '') : '';
            }
        }
        return { selected: txt, speech: speech, role: role, dlg: dlg };
    }

    function buildSelMenu(info) {
        var menu = document.createElement('div');
        menu.className = 'scr-selmenu';
        var sel = String(info.selected || '').trim();
        var speech = String(info.speech || '').trim();

        function item(label, key, text, cls) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'it' + (cls ? ' ' + cls : '');
            if (key) {
                var kEl = document.createElement('span');
                kEl.className = 'k';
                kEl.textContent = key;
                b.appendChild(kEl);
            }
            var tEl = document.createElement('span');
            tEl.className = 't';
            tEl.textContent = label;
            b.appendChild(tEl);
            b.title = text;
            b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
            b.addEventListener('click', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                window.__copyText && window.__copyText(text);
                closeSelMenu();
            });
            return b;
        }

        var hd = document.createElement('div');
        hd.className = 'hd';
        hd.textContent = '复制：' + (sel.length > 26 ? sel.slice(0, 26) + '…' : sel);
        menu.appendChild(hd);

        // 1) 复制选中（原样）
        menu.appendChild(item('复制选中', '⎘', sel));

        // 2) 选中片段按标点断句
        var U = window.__vhUtils;
        var parts = (U && U.splitSentences) ? U.splitSentences(sel) : [];
        if (parts.length > 1) {
            menu.appendChild(divider());
            var cap = document.createElement('div');
            cap.className = 'hd subh';
            cap.textContent = '选中的后半句 / 前半句（按标点断）';
            menu.appendChild(cap);
            parts.forEach(function (p, i) {
                menu.appendChild(item(p.text, String(i + 1) + '.', p.text));
            });
        }

        // 3) 以选中位置为界，取整句的前半/后半
        if (speech && U && U.halfAround) {
            var at = speech.indexOf(sel);
            var half = U.halfAround(speech, at >= 0 ? at + Math.ceil(sel.length / 2) : -1);
            if (half && (half.hasHead || half.hasTail)) {
                menu.appendChild(divider());
                var cap2 = document.createElement('div');
                cap2.className = 'hd subh';
                cap2.textContent = '整句的前半 / 后半';
                menu.appendChild(cap2);
                if (half.hasHead) menu.appendChild(item(shorten(half.head), '前半', half.head));
                if (half.hasTail) menu.appendChild(item(shorten(half.tail), '后半', half.tail));
            }
        }

        // 4) 整句（该行台词全部）
        if (speech && speech !== sel) {
            menu.appendChild(divider());
            var cap3 = document.createElement('div');
            cap3.className = 'hd subh';
            cap3.textContent = '整句 / 整行';
            menu.appendChild(cap3);
            menu.appendChild(item(shorten(speech), '整句', speech));
            if (info.role) {
                menu.appendChild(item(shorten(info.role + '：' + speech), '整行', info.role + '：' + speech));
            }
        }
        return menu;
    }

    function divider() {
        var d = document.createElement('div');
        d.className = 'sp';
        return d;
    }
    function shorten(s) {
        s = String(s || '');
        return s.length > 34 ? s.slice(0, 34) + '…' : s;
    }

    // 在选区附近显示菜单
    function showSelMenu() {
        var info = currentSelectionInfo();
        if (!info) { closeSelMenu(); return; }
        closeSelMenu();
        var menu = buildSelMenu(info);
        menu.style.visibility = 'hidden';
        document.body.appendChild(menu);
        selMenuEl = menu;
        var sel = window.getSelection();
        var r = sel.getRangeAt(0).getBoundingClientRect();
        // 关键：菜单挂到「整条台词行」外面（不是在选中的几个字旁边），
        // 否则会把正在读的后半句盖住 —— 用户要复制的恰恰是没被选中的那部分。
        var anchor = null;
        var node = sel.anchorNode;
        var el0 = node && (node.nodeType === 1 ? node : node.parentNode);
        if (el0 && el0.closest) anchor = el0.closest('.scr-dlg');
        var rect = anchor ? anchor.getBoundingClientRect() : r;
        var W = window.innerWidth, H = window.innerHeight;
        // 三档避让，目标只有一个：菜单绝不覆盖当前台词行（用户要看的就是这行）
        //   ① 行下方有空间 → 挂该行下方
        //   ② 行右侧有空间 → 挂该行右侧（同一水平带，落在那行文字之后）
        //   ③ 都不够 → 挂视口内该行之外的最大空区，并限高滚动
        var below = H - rect.bottom - 8;          // 下方可用高
        var right = W - rect.right - 8;           // 行尾右侧可用宽
        menu.style.overflowY = 'auto';
        var mw0 = menu.offsetWidth;
        var mh0 = menu.offsetHeight;
        var x, y, maxH;

        if (below >= Math.min(mh0, 90)) {
            // ① 下方
            maxH = below;
            menu.style.maxHeight = Math.min(maxH, H - 24) + 'px';
            x = rect.left;
            y = rect.bottom + 6;
        } else if (right >= mw0 + 8) {
            // ② 行右侧（不压字）
            menu.style.maxHeight = Math.min(H - 24, Math.max(160, H - 16)) + 'px';
            x = rect.right + 10;
            y = Math.max(8, rect.top);
        } else {
            // ③ 都不够：挑离该行最远的空区（上方或下方），并限高
            var above = rect.top - 8;
            if (above > below) {
                maxH = above;
                menu.style.maxHeight = Math.min(maxH, H - 24) + 'px';
                var mh2 = Math.min(menu.offsetHeight, maxH);
                y = Math.max(8, rect.top - mh2 - 6);
            } else {
                maxH = below;
                menu.style.maxHeight = Math.min(maxH, H - 24) + 'px';
                y = rect.bottom + 6;
            }
            x = rect.left;
        }
        if (x + menu.offsetWidth > W - 8) x = Math.max(8, W - menu.offsetWidth - 8);
        if (x < 8) x = 8;
        if (y < 8) y = 8;
        menu.style.left = Math.round(x) + 'px';
        menu.style.top = Math.round(y) + 'px';
        menu.style.visibility = 'visible';
    }

    // 绑定：鼠标抬起 / 双击后若存在选区即弹菜单；点别处或按 Esc 关闭
    // 双击台词行 → 直接复制该行台词（不经菜单，最快路径）
    function bindDblCopy() {
        if (window.__scrDblCopyBound) return;
        window.__scrDblCopyBound = true;
        document.addEventListener('dblclick', function (e) {
            var el2 = e.target;
            var dlg = el2 && el2.closest ? el2.closest('.scr-dlg') : null;
            if (!dlg) return;
            // 双击在复制/翻译按钮上时不接管
            if (el2.closest && (el2.closest('.scr-copy') || el2.closest('.scr-trn'))) return;
            var speech = String(dlg.getAttribute('data-speech') || '');
            if (!speech) {
                var sp = dlg.querySelector('.scr-sp');
                speech = sp ? String(sp.textContent || '') : '';
            }
            if (!speech.trim()) return;
            e.preventDefault();
            closeSelMenu();
            window.__copyText && window.__copyText(speech.trim());
        });
    }

    function bindSelMenu() {
        if (window.__scrSelMenuBound) return;
        window.__scrSelMenuBound = true;
        bindDblCopy();
        document.addEventListener('mouseup', function (e) {
            if (selMenuEl && selMenuEl.contains(e.target)) return;   // 点菜单本身不重开
            setTimeout(function () {
                var info = currentSelectionInfo();
                if (info && info.dlg) showSelMenu();
                else closeSelMenu();
            }, 0);
        });
        document.addEventListener('mousedown', function (e) {
            if (selMenuEl && !selMenuEl.contains(e.target)) closeSelMenu();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeSelMenu();
        });
        window.addEventListener('scroll', closeSelMenu, true);
    }

        // 事件委托：复制 + 单句翻译
        if (!window.__copyDelegateBound) {
            window.__copyDelegateBound = true;
            document.body.addEventListener('click', function (e) {
                var el2 = e.target.closest ? e.target.closest('.scr-copy') : null;
                if (el2 && el2.getAttribute('data-copy')) window.__copyText(el2.getAttribute('data-copy'));
            });
        }
        bindSelMenu();

        body.addEventListener('click', function (e) {
            var trn = e.target.closest ? e.target.closest('.scr-trn') : null;
            if (!trn) return;
            var line = trn.getAttribute('data-line');
            var en = trn.getAttribute('data-en') || '';
            var dlg = trn.closest('.scr-dlg');
            if (!dlg || !line) return;
            if (lineTransMap[line]) { ensureZh(dlg, lineTransMap[line]); return; }
            if (!en || !isEnglish(en)) { trn.textContent = '本句非英文'; return; }
            trn.textContent = '译中…';
            translateLine(en, function (err, zh) {
                if (err || !zh) { trn.textContent = '译'; window.__copyFlash && window.__copyFlash('翻译失败'); return; }
                lineTransMap[line] = zh;
                trn.textContent = '译';
                ensureZh(dlg, zh);
            });
        });
        function ensureZh(dlg, zh) {
            if (!zh) return;
            var olds = dlg.querySelectorAll('.scr-zh');
            for (var oi = 0; oi < olds.length; oi++) olds[oi].parentNode.removeChild(olds[oi]);
            var d = document.createElement('div');
            d.className = 'scr-zh';
            d.textContent = zh;
            dlg.appendChild(d);
        }

        // 命中导航：上一条 / 下一条 / 只看命中
        hitPrev.addEventListener('click', function () { gotoHit(hitIdx - 1); });
        hitNext.addEventListener('click', function () { gotoHit(hitIdx + 1); });
        onlyHitBtn.addEventListener('click', function () {
            onlyHits = !onlyHits;
            onlyHitBtn.textContent = onlyHits ? '保留原文' : '只看命中';
            onlyHitBtn.style.color = onlyHits ? '#c9a86a' : '#888';
            onlyHitBtn.style.borderColor = onlyHits ? '#4a4a2a' : '#444';
            render();
        });

        // 搜索框：纯数字 → 集号跳转；否则关键词检索
        searchInp.addEventListener('input', function () {
            var v = searchInp.value.trim();
            if (!v) { searchKeyword = ''; curEp = null; curEpKey = 'all'; renderSidebar(); render(); return; }
            // 数字 → 集号
            var numM = v.match(/^\s*(\d+)\s*$/);
            if (numM) {
                var n = parseInt(numM[1], 10);
                if (eps.indexOf(n) >= 0) {
                    curEp = n;
                    curEpKey = String(n);
                    searchKeyword = '';
                    searchState.textContent = '已跳转 第' + n + ' 集';
                    pendingScrollEp = n;
                    saveReading(docxPath, curEp);   // 跳集也算在读位置
                    renderSidebar();
                    render();
                    return;
                }
            }
            // 第X集 形式
            var epM = v.match(/^第\s*(\d+)\s*集$/);
            if (epM) {
                var n2 = parseInt(epM[1], 10);
                if (eps.indexOf(n2) >= 0) {
                    curEp = n2;
                    curEpKey = String(n2);
                    searchKeyword = '';
                    searchState.textContent = '已跳转 第' + n2 + ' 集';
                    saveReading(docxPath, curEp);
                    renderSidebar(); render(); return;
                }
            }
            // 关键词：全文（所有集）检索
            curEp = null;
            curEpKey = 'all';
            searchKeyword = v.toLowerCase();
            renderSidebar();
            render();
        });
        // Enter：清空搜索回全部
        searchInp.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { searchInp.value = ''; searchKeyword = ''; curEp = null; curEpKey = 'all'; searchState.textContent = ''; renderSidebar(); render(); e.stopPropagation(); }
        });

        // 整集翻译
        function doTranslate() {
            if (translating) return;
            var key = curEp ? String(curEp) : 'all';
            if (transMap['__' + key]) { curEpKey = key; render(); transState.textContent = '（已翻译）'; return; }
            var targets = [];
            epLines(curEp).forEach(function (x) {
                if (x.type !== 'dialogue') return;
                var en = extractEnglish(x.text);
                if (en && isEnglish(en)) targets.push(x.text);
            });
            if (targets.length === 0) { transState.textContent = '该范围没有可翻译的英文台词'; return; }
            translating = true;
            transBtn.disabled = true;
            transState.textContent = '翻译中 0/' + targets.length + '…';
            var i = 0;
            var results = {};
            function next() {
                if (i >= targets.length) {
                    transMap['__' + key] = results;
                    translating = false;
                    transBtn.disabled = false;
                    transState.textContent = '已翻译 ' + targets.length + ' 条';
                    curEpKey = key;
                    render();
                    return;
                }
                var line = targets[i];
                i++;
                transState.textContent = '翻译中 ' + i + '/' + targets.length + '…';
                translateLine(extractEnglish(line), function (err, zh) {
                    results[line] = (err || !zh) ? '' : zh;
                    setTimeout(next, 200);
                });
            }
            next();
        }

        transBtn.addEventListener('click', doTranslate);
        mailBtn.addEventListener('click', function () {
            var U = window.__vhUtils || {};
            var cur = U.getTranslateEmail ? U.getTranslateEmail() : '';
            var ov = document.createElement('div');
            ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1002;display:flex;align-items:center;justify-content:center;';
            var b2 = document.createElement('div');
            b2.style.cssText = 'background:#1e1e1e;border:1px solid #444;border-radius:8px;padding:16px;max-width:420px;width:90%;';
            b2.innerHTML = '<div style="font-size:13px;font-weight:600;color:#eee;margin-bottom:6px;">翻译邮箱（MyMemory 提额）</div>' +
                '<div style="font-size:11px;color:#9a9a9a;line-height:1.6;margin-bottom:8px;">填一个邮箱后，翻译额度从每天约 5000 字提升到 50000 字（官方支持）。填一次全局生效。</div>';
            var inp = document.createElement('input');
            inp.type = 'email'; inp.value = cur; inp.placeholder = 'your@email.com';
            inp.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #444;border-radius:4px;background:#2a2a2a;color:#ddd;font-size:13px;margin-bottom:10px;';
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
            var save = document.createElement('button'); save.textContent = '保存'; save.style.cssText = 'background:var(--accent,#537d96);color:#fff;border:none;border-radius:4px;padding:5px 16px;cursor:pointer;font-size:12px;';
            var clearB = document.createElement('button'); clearB.textContent = '清除'; clearB.style.cssText = 'background:#3a3a3a;color:#aaa;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;';
            var cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.style.cssText = 'background:#3a3a3a;color:#aaa;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;';
            row.appendChild(clearB); row.appendChild(cancel); row.appendChild(save);
            b2.appendChild(inp); b2.appendChild(row); ov.appendChild(b2);
            document.body.appendChild(ov);
            function close2() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
            save.addEventListener('click', function () {
                var v = inp.value.trim();
                if (v && U.setTranslateEmail) U.setTranslateEmail(v);
                close2();
                window.__copyFlash && window.__copyFlash(v ? '已保存邮箱（提额生效）' : '已清除邮箱');
            });
            clearB.addEventListener('click', function () { if (U.setTranslateEmail) U.setTranslateEmail(''); inp.value = ''; });
            cancel.addEventListener('click', close2);
            inp.focus();
        });

        pendingScrollEp = curEp;   // 打开时定位到上次读到的集（全量渲染，可上下滚看相邻集）
        renderSidebar();
        render();
        // 关闭当前剧本：清空面板 → 显示剧本库首页（留在剧本组）；清除在读记录（下次进剧本组回首页）
        function closeReader() {
            document.removeEventListener('keydown', escHandler);
            clearReading();
            if (hostPanel) hostPanel.innerHTML = '';
            showScriptHome();
        }
        close.addEventListener('click', closeReader);
        function escHandler(e) {
            if (e.key === 'Escape') closeReader();
        }
        document.addEventListener('keydown', escHandler);
        // 打开下一个剧本前若面板被其它路径清空，监听会随 hostPanel.innerHTML='' 一起失效；此处仅保留引用避免 GC 误伤
    }


  // ==================== 初始化 ====================
  function init() {
    var hostPanel = document.getElementById('panel-script');
    if (!hostPanel) return;
    if (!hostPanel.querySelector('#scriptReaderBox') && !hostPanel.querySelector('#scriptHomeBox')) {
      var reading = loadReading();
      if (reading && reading.path) {
        var exist = true;
        try { exist = window.vhHost.fsSync.exists(reading.path); } catch (e) {}
        if (exist) { openScript(reading.path, reading.ep); return; }
        clearReading();
      }
      showScriptHome();
    }
  }

  window.__scriptPanel = {
    init: init,
    openScript: openScript,
    showHome: showScriptHome,
    pickScript: pickScript
  };
})();
