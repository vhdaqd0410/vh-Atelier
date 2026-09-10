// vh-Atelier 待办板块：逐条列待办 → 打勾完成 → 生成当日工作总结（本地模板，无网络依赖）
// 数据落在 collect/todo.json（用户数据区，不进 git、同步脚本不覆盖）
// 数据结构：{ version:1, rollover:true, days: { 'YYYY-MM-DD': { todos:[{id,text,done,createdAt,doneAt}], memo:'', summary:'' } } }
(function () {
    var fs, path, os;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
    } catch (e) { return; }

    var csInterface = (typeof CSInterface !== 'undefined') ? new CSInterface() : null;

    // ---------- 路径 ----------
    function extRoot() {
        var r = '';
        try { if (csInterface) r = csInterface.getSystemPath('extension'); } catch (_) {}
        if (r && fs.existsSync(r)) return r;
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (_) {}
        return '';
    }
    var ROOT = extRoot();
    var DATA_FILE = ROOT ? path.join(ROOT, 'collect', 'todo.json') : '';
    var BACKUP_DIR = ROOT ? path.join(ROOT, 'collect', 'backup') : '';

    // ---------- 数据 ----------
    var DB = { version: 1, rollover: true, days: {} };
    var curKey = '';      // 当前查看的日期（预览往期时不是今天）

    function emptyDay() { return { todos: [], memo: '', summary: '' }; }

    function load() {
        try {
            if (DATA_FILE && fs.existsSync(DATA_FILE)) {
                var o = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                if (o && typeof o === 'object') {
                    DB.version = 1;
                    DB.rollover = (o.rollover === undefined) ? true : !!o.rollover;
                    DB.days = (o.days && typeof o.days === 'object') ? o.days : {};
                }
            }
        } catch (e) {
            try { window.__vhLog && window.__vhLog.err('待办数据读取失败', e); } catch (_) {}
            DB.days = DB.days || {};
        }
        // 清洗：保证每天的结构完整
        Object.keys(DB.days).forEach(function (k) {
            var d = DB.days[k];
            if (!d || typeof d !== 'object') { DB.days[k] = emptyDay(); return; }
            if (!Array.isArray(d.todos)) d.todos = [];
            if (typeof d.memo !== 'string') d.memo = '';
            if (typeof d.summary !== 'string') d.summary = '';
        });
    }

    var saveTimer = null;
    function save(now) {
        if (!DATA_FILE) return;
        function doWrite() {
            saveTimer = null;
            try {
                var dir = path.dirname(DATA_FILE);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                // 写前备份上一版（保留最近 20 份，防手滑/程序错写）
                try {
                    if (fs.existsSync(DATA_FILE)) {
                        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
                        var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                        fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, 'todo_' + stamp + '.json'));
                        var olds = fs.readdirSync(BACKUP_DIR).filter(function (f) { return /^todo_.*\.json$/.test(f); }).sort();
                        while (olds.length > 20) { try { fs.unlinkSync(path.join(BACKUP_DIR, olds.shift())); } catch (_) {} }
                    }
                } catch (_) {}
                fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 1), 'utf8');
            } catch (e) {
                try { window.__vhLog && window.__vhLog.err('待办数据保存失败', e); } catch (_) {}
            }
        }
        if (now) { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } doWrite(); return; }
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(doWrite, 600);   // 输入类改动防抖落盘
    }

    // ---------- 日期 ----------
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function keyToDate(k) {
        var p = String(k).split('-');
        return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    }
    // 今天：rollover 开启时，凌晨 4 点前算前一天（夜班友好）
    function todayKey() {
        var now = new Date();
        if (DB.rollover) {
            var shifted = new Date(now.getTime() - 4 * 3600 * 1000);
            return keyOf(shifted);
        }
        return keyOf(now);
    }
    function prevKey(k) {
        var d = keyToDate(k);
        d.setDate(d.getDate() - 1);
        return keyOf(d);
    }
    var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    function niceDate(k) {
        var d = keyToDate(k);
        return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + WD[d.getDay()];
    }

    function day(k) {
        if (!DB.days[k]) DB.days[k] = emptyDay();
        return DB.days[k];
    }

    // ---------- 工具 ----------
    function uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }
    function toast(msg) { if (window.__copyFlash) window.__copyFlash(msg); }

    // ---------- DOM ----------
    var el = {};
    function grab() {
        el.date = document.getElementById('tdDate');
        el.roll = document.getElementById('tdRollover');
        el.progFill = document.getElementById('tdProgFill');
        el.progTxt = document.getElementById('tdProgTxt');
        el.input = document.getElementById('tdInput');
        el.add = document.getElementById('tdAdd');
        el.list = document.getElementById('tdList');
        el.carry = document.getElementById('tdCarry');
        el.carryTxt = document.getElementById('tdCarryTxt');
        el.carryBtn = document.getElementById('tdCarryBtn');
        el.memo = document.getElementById('tdMemo');
        el.gen = document.getElementById('tdGen');
        el.copy = document.getElementById('tdCopy');
        el.save = document.getElementById('tdSave');
        el.summary = document.getElementById('tdSummary');
        el.hist = document.getElementById('tdHistory');
        el.backToday = document.getElementById('tdBackToday');
    }

    // ---------- 渲染 ----------
    var today = '';

    function renderAll() {
        today = todayKey();
        renderHead();
        renderList();
        renderCarry();
        renderMemo();
        renderSummary();
        renderHistory();
    }

    function isToday() { return curKey === today; }

    function renderHead() {
        if (el.date) {
            var txt = niceDate(curKey);
            if (DB.rollover && curKey !== keyOf(new Date())) txt += '（含凌晨）';
            if (!isToday()) txt += ' · 往期';
            el.date.textContent = txt;
        }
        if (el.roll) el.roll.checked = !!DB.rollover;
        if (el.backToday) el.backToday.style.display = isToday() ? 'none' : '';
        // 输入区只在今天可用
        var ro = !isToday();
        if (el.input) { el.input.disabled = ro; el.input.placeholder = ro ? '往期只能查看，不能新增' : '加一条待办，回车即可'; }
        if (el.add) el.add.disabled = ro;
        if (el.memo) el.memo.disabled = ro;
        if (el.gen) el.gen.disabled = false;
    }

    function renderList() {
        if (!el.list) return;
        var d = day(curKey);
        var total = d.todos.length;
        var done = d.todos.filter(function (t) { return t.done; }).length;
        // 排序：未完成在前（保持原序），已完成沉底
        var open = d.todos.filter(function (t) { return !t.done; });
        var closed = d.todos.filter(function (t) { return t.done; });
        var ordered = open.concat(closed);

        if (el.progFill) el.progFill.style.width = (total ? Math.round(done * 100 / total) : 0) + '%';
        if (el.progTxt) {
            el.progTxt.textContent = total ? ('完成 ' + done + ' / ' + total + (done === total ? ' · 全部完成' : '')) : '还没有待办';
            el.progTxt.style.color = (total && done === total) ? 'var(--fg-ok-soft)' : 'var(--muted)';
        }

        if (!total) {
            el.list.innerHTML = '<div class="td-empty">' + (isToday() ? '今天还没有待办，上面加一条' : '这天没有待办') + '</div>';
            return;
        }

        var html = '';
        ordered.forEach(function (t) {
            html += '<div class="td-item' + (t.done ? ' done' : '') + '" data-id="' + t.id + '">' +
                '<span class="td-cb" data-act="toggle" role="checkbox" aria-checked="' + (t.done ? 'true' : 'false') + '" tabindex="0" title="' + (t.done ? '标记未完成' : '标记完成') + '">' + (t.done ? '✓' : '') + '</span>' +
                '<span class="td-tx" data-act="edit" title="双击编辑">' + esc(t.text) + '</span>' +
                '<span class="td-del" data-act="del" title="删除">✕</span>' +
                '</div>';
        });
        el.list.innerHTML = html;
    }

    function renderCarry() {
        if (!el.carry) return;
        if (!isToday()) { el.carry.style.display = 'none'; return; }
        var pk = prevKey(curKey);
        var pd = DB.days[pk];
        if (!pd || !Array.isArray(pd.todos)) { el.carry.style.display = 'none'; return; }
        var openPrev = pd.todos.filter(function (t) { return !t.done; });
        if (!openPrev.length) { el.carry.style.display = 'none'; return; }
        el.carry.style.display = '';
        el.carryTxt.textContent = niceDate(pk) + ' 还有 ' + openPrev.length + ' 条未完成';
    }

    function renderMemo() {
        if (!el.memo) return;
        if (el.memo.value !== day(curKey).memo) el.memo.value = day(curKey).memo || '';
    }

    function renderSummary() {
        if (!el.summary) return;
        var s = day(curKey).summary || '';
        if (s) {
            el.summary.textContent = s;
            el.summary.classList.remove('td-sum-placeholder');
        } else {
            el.summary.textContent = '点「生成」按这天的待办与备忘生成总结';
            el.summary.classList.add('td-sum-placeholder');
        }
    }

    function renderHistory() {
        if (!el.hist) return;
        var keys = Object.keys(DB.days).sort().reverse().slice(0, 30);
        var rows = [];
        keys.forEach(function (k) {
            var d = DB.days[k];
            var total = (d.todos || []).length;
            var done = (d.todos || []).filter(function (t) { return t.done; }).length;
            if (!total && !d.memo && !d.summary) return;   // 空白日不列
            rows.push('<div class="td-hrow' + (k === curKey ? ' cur' : '') + '" data-k="' + k + '">' +
                '<span class="td-hd">' + niceDate(k) + '</span>' +
                '<span class="td-hs">' + (total ? '完成 ' + done + '/' + total : '—') + '</span>' +
                (d.memo ? '<span class="td-hm" title="有备忘">备忘</span>' : '') +
                (d.summary ? '<span class="td-hm" title="有总结">总结</span>' : '') +
                '</div>');
        });
        el.hist.innerHTML = rows.length ? rows.join('') : '<div class="td-empty">还没有历史记录</div>';
    }

    // ---------- 总结（本地模板） ----------
    function genSummary() {
        var d = day(curKey);
        var done = d.todos.filter(function (t) { return t.done; });
        var open = d.todos.filter(function (t) { return !t.done; });
        var L = [];
        L.push('# ' + niceDate(curKey) + ' 工作总结');
        L.push('');
        if (d.todos.length) {
            L.push('完成 ' + done.length + ' / ' + d.todos.length + (done.length === d.todos.length && d.todos.length ? '（全部完成）' : ''));
            L.push('');
        }
        L.push('## 已完成' + (done.length ? '（' + done.length + '）' : ''));
        if (done.length) done.forEach(function (t) { L.push('- ' + t.text); });
        else L.push('- （无）');
        L.push('');
        L.push('## 未完成' + (open.length ? '（' + open.length + '）' : ''));
        if (open.length) open.forEach(function (t) { L.push('- ' + t.text); });
        else L.push('- （无）');
        if (d.memo && d.memo.trim()) {
            L.push('');
            L.push('## 备忘');
            L.push(d.memo.trim());
        }
        return L.join('\n');
    }

    // ---------- 事件 ----------
    function bind() {
        if (el.add) el.add.addEventListener('click', addTodo);
        if (el.input) {
            el.input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); addTodo(); }
            });
        }

        if (el.list) {
            el.list.addEventListener('click', function (e) {
                var t = e.target.closest ? e.target.closest('.td-item') : null;
                if (!t) return;
                var id = t.getAttribute('data-id');
                var act = e.target.getAttribute && e.target.getAttribute('data-act');
                if (act === 'toggle') toggleTodo(id);
                else if (act === 'del') delTodo(id);
                else if (act === 'edit') startEdit(t, id);
            });
            el.list.addEventListener('keydown', function (e) {
                if (e.key !== ' ' && e.key !== 'Enter') return;
                var cb = e.target.closest ? e.target.closest('.td-cb') : null;
                if (!cb) return;
                e.preventDefault();
                var t = cb.closest('.td-item');
                if (t) toggleTodo(t.getAttribute('data-id'));
            });
        }

        if (el.carryBtn) {
            el.carryBtn.addEventListener('click', function () {
                var pk = prevKey(today);
                var pd = DB.days[pk];
                if (!pd) return;
                var open = pd.todos.filter(function (t) { return !t.done; });
                if (!open.length) { toast('没有可结转到今天的项'); return; }
                var td = day(today);
                var exist = {};
                td.todos.forEach(function (t) { exist[t.text] = 1; });
                var n = 0;
                open.forEach(function (t) {
                    if (exist[t.text]) return;   // 同名不重复带过来
                    td.todos.unshift({ id: uid(), text: t.text, done: false, createdAt: Date.now(), doneAt: 0, carried: true });
                    n++;
                });
                save(true);
                if (curKey === today) renderAll();
                toast('已结转 ' + n + ' 条到 ' + niceDate(today));
            });
        }

        if (el.memo) {
            el.memo.addEventListener('input', function () {
                day(curKey).memo = el.memo.value;
                save();
                if (!isToday()) renderHistory();
            });
        }

        if (el.roll) {
            el.roll.addEventListener('change', function () {
                DB.rollover = !!el.roll.checked;
                save(true);
                var oldCur = curKey;
                today = todayKey();
                if (oldCur === curKey || !isToday()) curKey = today;   // 规则变了，"今天"可能变，切回今天
                renderAll();
            });
        }

        if (el.gen) {
            el.gen.addEventListener('click', function () {
                var s = genSummary();
                day(curKey).summary = s;
                save(true);
                renderSummary();
                renderHistory();
                toast('已生成总结');
            });
        }

        if (el.copy) {
            el.copy.addEventListener('click', function () {
                var txt = day(curKey).summary;
                if (!txt) { txt = genSummary(); day(curKey).summary = txt; save(true); renderSummary(); }
                copyText(txt);
            });
        }

        if (el.save) {
            el.save.addEventListener('click', function () {
                var txt = day(curKey).summary || genSummary();
                day(curKey).summary = txt;
                save(true);
                renderSummary();
                pickFolder(function (picked) {
                    var dir = picked || path.join(os.homedir(), 'Desktop');
                    var file = path.join(dir, '工作总结_' + curKey + '.md');
                    try {
                        fs.writeFileSync(file, txt, 'utf8');
                        toast('已保存：' + path.basename(file));
                    } catch (e) {
                        toast('保存失败：' + e.message);
                    }
                });
            });
        }

        if (el.hist) {
            el.hist.addEventListener('click', function (e) {
                var r = e.target.closest ? e.target.closest('.td-hrow') : null;
                if (!r) return;
                curKey = r.getAttribute('data-k');
                renderAll();
            });
        }

        if (el.backToday) {
            el.backToday.addEventListener('click', function () { curKey = today; renderAll(); });
        }
    }

    function copyText(t) {
        try {
            var ta = document.createElement('textarea');
            ta.value = t;
            document.body.appendChild(ta);
            ta.select();
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            toast(ok ? '已复制到剪贴板' : '复制失败');
        } catch (e) { toast('复制失败'); }
    }

    // 目录选择：复用插件已有的 folderpicker.ps1（-Ini 传 JSON、-Out 写结果，UTF-8 文件交互）
    // 选完/取消都回一个目录字符串（拿不到返回空，由调用方退到桌面）
    function pickFolder(cb) {
        try {
            var psPath = ROOT ? path.join(ROOT, 'jsx', 'folderpicker.ps1') : '';
            if (!psPath || !fs.existsSync(psPath)) { cb(''); return; }
            var rnd = Date.now() + '_' + Math.floor(Math.random() * 1e6);
            var inFile = path.join(os.tmpdir(), 'cep_td_in_' + rnd + '.txt');
            var outFile = path.join(os.tmpdir(), 'cep_td_out_' + rnd + '.txt');
            var lastDir = '';
            try { lastDir = localStorage.getItem('vh_todo_lastdir') || ''; } catch (_) {}
            var init = (lastDir && fs.existsSync(lastDir)) ? lastDir : os.homedir();
            fs.writeFileSync(inFile, JSON.stringify({ path: init, title: '选择工作总结保存目录' }), 'utf8');
            var cmd = 'powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' + psPath + '" -Ini "' + inFile + '" -Out "' + outFile + '"';
            require('child_process').exec(cmd, { windowsHide: true }, function (err) {
                try { fs.unlinkSync(inFile); } catch (_) {}
                var p = '';
                try {
                    if (fs.existsSync(outFile)) {
                        p = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, "").trim();
                        try { fs.unlinkSync(outFile); } catch (_) {}
                    }
                } catch (_) {}
                if (p && fs.existsSync(p)) {
                    try { localStorage.setItem('vh_todo_lastdir', p); } catch (_) {}
                }
                cb(p || '');
            });
        } catch (e) { cb(''); }
    }

    // ---------- 待办操作 ----------
    function addTodo() {
        if (!isToday()) { toast('往期不能新增'); return; }
        var v = (el.input.value || '').replace(/^\s+|\s+$/g, '');
        if (!v) return;
        day(curKey).todos.push({ id: uid(), text: v, done: false, createdAt: Date.now(), doneAt: 0 });
        el.input.value = '';
        save();
        renderList();
        renderHistory();
        el.input.focus();
    }

    function toggleTodo(id) {
        var d = day(curKey);
        for (var i = 0; i < d.todos.length; i++) {
            if (d.todos[i].id === id) {
                d.todos[i].done = !d.todos[i].done;
                d.todos[i].doneAt = d.todos[i].done ? Date.now() : 0;
                break;
            }
        }
        save();
        renderList();
        renderHistory();
    }

    function delTodo(id) {
        var d = day(curKey);
        d.todos = d.todos.filter(function (t) { return t.id !== id; });
        save(true);
        renderList();
        renderHistory();
    }

    function startEdit(itemEl, id) {
        if (!isToday()) { toast('往期不能编辑'); return; }
        var d = day(curKey);
        var t = null;
        for (var i = 0; i < d.todos.length; i++) if (d.todos[i].id === id) { t = d.todos[i]; break; }
        if (!t) return;
        var tx = itemEl.querySelector('.td-tx');
        if (!tx) return;
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'td-edit';
        inp.value = t.text;
        tx.replaceWith(inp);
        inp.focus();
        inp.select();
        var finished = false;
        function commit(ok) {
            if (finished) return;
            finished = true;
            var nv = (inp.value || '').replace(/^\s+|\s+$/g, '');
            if (ok && nv) t.text = nv;
            save();
            renderList();
        }
        inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') commit(true);
            else if (e.key === 'Escape') commit(false);
        });
        inp.addEventListener('blur', function () { commit(true); });
    }

    // ---------- 启动 ----------
    function init() {
        grab();
        if (!el.list) return;   // 面板不存在
        load();
        curKey = todayKey();
        today = curKey;
        bind();
        renderAll();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // 切到待办面板时刷新（跨天/外部改动后回来能看到最新）
    window.__todoOnShow = function () {
        var t = todayKey();
        if (t !== today) { today = t; if (curKey !== '' && !isToday()) curKey = t; }
        renderAll();
    };

    // 供其它模块取当天数据（后续可扩展）
    window.__vhTodo = {
        today: function () { return todayKey(); },
        stats: function (k) {
            var d = day(k || todayKey());
            var total = d.todos.length;
            var done = d.todos.filter(function (t) { return t.done; }).length;
            return { total: total, done: done, open: total - done, memo: d.memo || '' };
        }
    };
})();
