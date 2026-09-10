// vh-Atelier 待办板块：逐条列待办 → 打勾完成 → 生成当日工作总结（本地模板，无网络依赖）
// 数据落在 collect/todo.json（用户数据区，不进 git、同步脚本不覆盖）
// 数据结构：
// {
//   version: 2,
//   rollover: true,
//   days: {
//     'YYYY-MM-DD': {
//       todos: [{
//         id, text, done, createdAt, doneAt,
//         project: '',      // 关联项目名（来自视频工作台）
//         assignee: '',     // 负责/剪辑师（来自工作台人员配置）
//         pinned: false,    // 置顶
//         urgent: false,    // 加急
//         carried: false    // 由前一天结转而来
//       }],
//       memo: '', summary: ''
//     }
//   }
// }
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
    var DB = { version: 2, rollover: true, days: {} };
    var curKey = '';

    function emptyTodo(o) {
        return {
            id: (o && o.id) || uid(),
            text: (o && o.text) || '',
            done: !!(o && o.done),
            createdAt: (o && o.createdAt) || Date.now(),
            doneAt: (o && o.doneAt) || 0,
            project: (o && o.project) || '',
            assignee: (o && o.assignee) || '',
            pinned: !!(o && o.pinned),
            urgent: !!(o && o.urgent),
            carried: !!(o && o.carried)
        };
    }
    function emptyDay() { return { todos: [], memo: '', summary: '' }; }

    function load() {
        try {
            if (DATA_FILE && fs.existsSync(DATA_FILE)) {
                var o = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                if (o && typeof o === 'object') {
                    DB.version = 2;
                    DB.rollover = (o.rollover === undefined) ? true : !!o.rollover;
                    DB.days = (o.days && typeof o.days === 'object') ? o.days : {};
                }
            }
        } catch (e) {
            try { window.__vhLog && window.__vhLog.err('待办数据读取失败', e); } catch (_) {}
            DB.days = DB.days || {};
        }
        // 清洗 + v1→v2 迁移（补全新字段）
        Object.keys(DB.days).forEach(function (k) {
            var d = DB.days[k];
            if (!d || typeof d !== 'object') { DB.days[k] = emptyDay(); return; }
            if (!Array.isArray(d.todos)) d.todos = [];
            d.todos = d.todos.filter(function (t) { return t && typeof t === 'object'; }).map(emptyTodo);
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
        saveTimer = setTimeout(doWrite, 600);
    }

    // ---------- 日期 ----------
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function keyToDate(k) {
        var p = String(k).split('-');
        return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    }
    function todayKey() {
        var now = new Date();
        if (DB.rollover) return keyOf(new Date(now.getTime() - 4 * 3600 * 1000));
        return keyOf(now);
    }
    function prevKey(k) {
        var d = keyToDate(k); d.setDate(d.getDate() - 1); return keyOf(d);
    }
    var WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    function niceDate(k) {
        var d = keyToDate(k);
        return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + WD[d.getDay()];
    }
    function day(k) { if (!DB.days[k]) DB.days[k] = emptyDay(); return DB.days[k]; }

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
        ['tdDate','tdRollover','tdProgFill','tdProgTxt','tdInput','tdAdd','tdList','tdCarry',
         'tdCarryTxt','tdCarryBtn','tdMemo','tdGen','tdCopy','tdSave','tdSummary','tdHistory',
         'tdBackToday','tdProjBtn','tdProjVal','tdProjPanel','tdProjSearch','tdProjList','tdProjRefresh',
         'tdAsgBtn','tdAsgVal','tdAsgPanel','tdAsgSearch','tdAsgList','tdGroupSum'
        ].forEach(function (id) { el[id] = document.getElementById(id); });
    }

    // ---------- 视频工作台数据源 ----------
    var WB_PORT = 8089;
    var WB_BASE = 'http://127.0.0.1:' + WB_PORT;
    var WB_CFG_PATH = 'C:\\Users\\Admin\\Desktop\\视频工作台\\backend\\config.yaml';
    var WB_CFG_MEM = 'vh_todo_wb_cfg';
    var wbProjects = [];     // [{name, status, cur, total, done}]
    var wbMembers = [];      // [{name, role, title, department}]
    var wbLoadedAt = 0;
    var projFilter = '';
    var asgFilter = '';

    function readSecret() {
        var p = WB_CFG_PATH;
        try { p = localStorage.getItem(WB_CFG_MEM) || WB_CFG_PATH; } catch (e) {}
        try {
            if (!fs.existsSync(p)) return null;
            var raw = fs.readFileSync(p, 'utf8');
            var m = raw.match(/api_secret\s*:\s*["']?([A-Za-z0-9_\-]+)/);
            return m ? m[1] : null;
        } catch (e) { return null; }
    }

    function wbGet(sub, cb) {
        var secret = readSecret();
        if (!secret) { cb(new Error('读不到视频工作台 api_secret')); return; }
        var url = WB_BASE + sub + (sub.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(secret);
        var XH = (typeof XMLHttpRequest !== 'undefined') ? XMLHttpRequest : null;
        if (!XH) { cb(new Error('当前环境不支持网络请求')); return; }
        var xhr = new XH();
        xhr.open('GET', url, true);
        xhr.timeout = 12000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
                try { cb(null, JSON.parse(xhr.responseText)); }
                catch (e) { cb(new Error('解析失败')); }
            } else if (xhr.status === 401) { cb(new Error('鉴权失败，请重启视频工作台')); }
            else { cb(new Error('HTTP ' + xhr.status)); }
        };
        xhr.onerror = function () { cb(new Error('连不上视频工作台（8089）')); };
        xhr.ontimeout = function () { cb(new Error('视频工作台超时')); };
        try { xhr.send(); } catch (e) { cb(new Error('请求失败：' + e.message)); }
    }

    // 已完成/交付态判定
    function isFinishedStatus(st) {
        st = String(st || '');
        return /已完成|已交付|交付完成|完成/.test(st);
    }

    function loadWorkbench(force, cb) {
        var now = Date.now();
        if (!force && wbProjects.length && (now - wbLoadedAt) < 60000) { if (cb) cb(null); return; }
        wbGet('/api/projects', function (err, j) {
            if (err) { if (cb) cb(err); return; }
            var seen = {}, out = [];
            function push(p, isDone) {
                if (!p || !p.name) return;
                var nm = String(p.name);
                if (seen[nm]) return;
                seen[nm] = 1;
                out.push({
                    name: nm,
                    status: p.custom_status || (isDone ? '已完成' : ''),
                    cur: p.current_episodes || 0,
                    total: p.total_episodes || 0,
                    done: !!isDone
                });
                // 存下 episode_plan：选项时能推出「这个项目有哪些剪辑师」
                if (p.episode_plan) projPlans[nm] = p.episode_plan;
            }
            // 先进行中（优先展示），再已完成
            (j.group_all || []).forEach(function (p) { push(p, false); });
            (j.group_completed || []).forEach(function (p) { push(p, true); });
            // 兜底：sections 里补充（历史/待同步项目，供搜索）
            (j.sections || []).forEach(function (s) {
                (s.projects || []).forEach(function (p) {
                    push(p, /completed/.test(String(s.key || '')));
                });
            });
            wbProjects = out;
            wbLoadedAt = Date.now();
            if (cb) cb(null);
        });
    }

    function loadMembers(force, cb) {
        if (!force && wbMembers.length) { if (cb) cb(null); return; }
        wbGet('/api/team/members', function (err, j) {
            if (err) { if (cb) cb(err); return; }
            var arr = (j && j.members) || [];
            wbMembers = arr.filter(function (m) { return m && m.name; }).map(function (m) {
                return { name: String(m.name), role: m.role || '', title: m.title || '', department: m.department || '' };
            });
            if (cb) cb(null);
        });
    }

    // 取某项目的剪辑师名单（episode_plan：集号 → 剪辑师）
    // 返回 [] 表示没有名单或拿不到
    function membersOfProject(projName) {
        if (!projName) return [];
        var raw = projPlans[projName];
        if (!raw) return [];
        try {
            var ep = JSON.parse(raw);
            var set = {};
            Object.keys(ep).forEach(function (k) { if (ep[k]) set[String(ep[k])] = 1; });
            return Object.keys(set);
        } catch (e) { return []; }
    }
    var projPlans = {};   // 项目名 -> episode_plan 原始 JSON 字符串

    // ---------- 渲染 ----------
    var today = '';

    function renderAll() {
        today = todayKey();
        renderHead();
        renderList();
        renderCarry();
        renderMemo();
        renderSummary();
        renderGroupSum();
        renderHistory();
    }
    function isToday() { return curKey === today; }

    function renderHead() {
        if (el.tdDate) {
            var txt = niceDate(curKey);
            if (DB.rollover && curKey !== keyOf(new Date())) txt += '（含凌晨）';
            if (!isToday()) txt += ' · 往期';
            el.tdDate.textContent = txt;
        }
        if (el.tdRollover) el.tdRollover.checked = !!DB.rollover;
        if (el.tdBackToday) el.tdBackToday.style.display = isToday() ? 'none' : '';
        var ro = !isToday();
        if (el.tdInput) { el.tdInput.disabled = ro; el.tdInput.placeholder = ro ? '往期只能查看，不能新增' : '加一条待办，回车即可'; }
        if (el.tdAdd) el.tdAdd.disabled = ro;
        if (el.tdProjBtn) el.tdProjBtn.disabled = ro;
        if (el.tdAsgBtn) el.tdAsgBtn.disabled = ro;
        if (el.tdMemo) el.tdMemo.disabled = ro;
        if (ro) closePickers();
    }

    // 排序：置顶 > 加急 > 未完成 > 已完成；同档保持原序
    function orderTodos(list) {
        var idx = {};
        list.forEach(function (t, i) { idx[t.id] = i; });
        return list.slice().sort(function (a, b) {
            if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
            if (!!b.urgent !== !!a.urgent) return b.urgent ? 1 : -1;
            if (!!a.done !== !!b.done) return a.done ? 1 : -1;
            return idx[a.id] - idx[b.id];
        });
    }

    function renderList() {
        if (!el.tdList) return;
        var d = day(curKey);
        var total = d.todos.length;
        var done = d.todos.filter(function (t) { return t.done; }).length;

        if (el.tdProgFill) el.tdProgFill.style.width = (total ? Math.round(done * 100 / total) : 0) + '%';
        if (el.tdProgTxt) {
            el.tdProgTxt.textContent = total ? ('完成 ' + done + ' / ' + total + (done === total ? ' · 全部完成' : '')) : '还没有待办';
            el.tdProgTxt.style.color = (total && done === total) ? 'var(--fg-ok-soft)' : 'var(--muted)';
        }

        if (!total) {
            el.tdList.innerHTML = '<div class="td-empty">' + (isToday() ? '今天还没有待办，上面加一条' : '这天没有待办') + '</div>';
            return;
        }

        var html = '';
        orderTodos(d.todos).forEach(function (t) {
            var badges = '';
            if (t.project) badges += '<span class="td-tag td-tag-proj" title="项目：' + esc(t.project) + '">' + esc(shortProj(t.project)) + '</span>';
            if (t.assignee) badges += '<span class="td-tag td-tag-asg" title="负责人：' + esc(t.assignee) + '">' + esc(t.assignee) + '</span>';
            if (t.carried) badges += '<span class="td-tag td-tag-carry" title="由前一天结转">结转</span>';
            html += '<div class="td-item' + (t.done ? ' done' : '') + (t.pinned ? ' pinned' : '') + (t.urgent ? ' urgent' : '') + '" data-id="' + t.id + '">' +
                '<span class="td-cb" data-act="toggle" role="checkbox" aria-checked="' + (t.done ? 'true' : 'false') + '" tabindex="0" title="' + (t.done ? '标记未完成' : '标记完成') + '">' + (t.done ? '✓' : '') + '</span>' +
                '<span class="td-tx" data-act="edit" title="双击编辑">' + esc(t.text) + '</span>' +
                (badges ? '<span class="td-badges">' + badges + '</span>' : '') +
                '<span class="td-flags">' +
                    '<span class="td-flag' + (t.pinned ? ' on' : '') + '" data-act="pin" title="' + (t.pinned ? '取消置顶' : '置顶') + '">⬆</span>' +
                    '<span class="td-flag td-flag-urgent' + (t.urgent ? ' on' : '') + '" data-act="urgent" title="' + (t.urgent ? '取消加急' : '标记加急') + '">!</span>' +
                    '<span class="td-del" data-act="del" title="删除">✕</span>' +
                '</span>' +
                '</div>';
        });
        el.tdList.innerHTML = html;
    }

    function shortProj(n) {
        var s = String(n || '');
        // 去掉编号前缀，保留书名号内容，太长则截断
        var m = s.match(/《([^》]+)》/);
        if (m) s = m[1];
        return s.length > 14 ? s.slice(0, 13) + '…' : s;
    }

    function renderCarry() {
        if (!el.tdCarry) return;
        if (!isToday()) { el.tdCarry.style.display = 'none'; return; }
        var pd = DB.days[prevKey(curKey)];
        if (!pd || !Array.isArray(pd.todos)) { el.tdCarry.style.display = 'none'; return; }
        var openPrev = pd.todos.filter(function (t) { return !t.done; });
        if (!openPrev.length) { el.tdCarry.style.display = 'none'; return; }
        el.tdCarry.style.display = '';
        el.tdCarryTxt.textContent = niceDate(prevKey(curKey)) + ' 还有 ' + openPrev.length + ' 条未完成';
    }

    function renderMemo() {
        if (el.tdMemo && el.tdMemo.value !== day(curKey).memo) el.tdMemo.value = day(curKey).memo || '';
    }

    function renderSummary() {
        if (!el.tdSummary) return;
        var s = day(curKey).summary || '';
        if (s) { el.tdSummary.textContent = s; el.tdSummary.classList.remove('td-sum-placeholder'); }
        else { el.tdSummary.textContent = '点「生成」按这天的待办与备忘生成总结'; el.tdSummary.classList.add('td-sum-placeholder'); }
    }

    // 按项目 / 负责人分组统计（右侧小卡）
    function groupStats() {
        var d = day(curKey);
        var byP = {}, byA = {};
        d.todos.forEach(function (t) {
            var p = t.project || '未关联项目';
            var a = t.assignee || '未指定';
            if (!byP[p]) byP[p] = { done: 0, total: 0 };
            if (!byA[a]) byA[a] = { done: 0, total: 0 };
            byP[p].total++; byA[a].total++;
            if (t.done) { byP[p].done++; byA[a].done++; }
        });
        return { byP: byP, byA: byA };
    }

    function renderGroupSum() {
        if (!el.tdGroupSum) return;
        var g = groupStats();
        function block(title, obj) {
            var keys = Object.keys(obj);
            if (!keys.length) return '';
            // 未完成的排前面
            keys.sort(function (x, y) {
                var ax = obj[x].total - obj[x].done, ay = obj[y].total - obj[y].done;
                if (ax !== ay) return ay - ax;
                return x < y ? -1 : 1;
            });
            var rows = keys.map(function (k) {
                var o = obj[k];
                var all = o.done === o.total;
                return '<div class="td-gsrow' + (all ? ' all' : '') + '">' +
                    '<span class="td-gsk">' + esc(k) + '</span>' +
                    '<span class="td-gsv">' + o.done + '/' + o.total + '</span></div>';
            }).join('');
            return '<div class="td-gsblock"><div class="td-gstitle">' + title + '</div>' + rows + '</div>';
        }
        var html = block('按项目', g.byP) + block('按负责人', g.byA);
        el.tdGroupSum.innerHTML = html || '<div class="td-empty">还没有可汇总的数据</div>';
    }

    function renderHistory() {
        if (!el.tdHistory) return;
        var keys = Object.keys(DB.days).sort().reverse().slice(0, 30);
        var rows = [];
        keys.forEach(function (k) {
            var d = DB.days[k];
            var total = (d.todos || []).length;
            var done = (d.todos || []).filter(function (t) { return t.done; }).length;
            if (!total && !d.memo && !d.summary) return;
            rows.push('<div class="td-hrow' + (k === curKey ? ' cur' : '') + '" data-k="' + k + '">' +
                '<span class="td-hd">' + niceDate(k) + '</span>' +
                '<span class="td-hs">' + (total ? '完成 ' + done + '/' + total : '—') + '</span>' +
                (d.memo ? '<span class="td-hm" title="有备忘">备忘</span>' : '') +
                (d.summary ? '<span class="td-hm" title="有总结">总结</span>' : '') +
                '</div>');
        });
        el.tdHistory.innerHTML = rows.length ? rows.join('') : '<div class="td-empty">还没有历史记录</div>';
    }

    // ---------- 总结（本地模板） ----------
    function genSummary() {
        var d = day(curKey);
        var ordered = orderTodos(d.todos);      // 与列表一致的排序：置顶 > 加急 > 未完成 > 已完成
        var done = ordered.filter(function (t) { return t.done; });
        var open = ordered.filter(function (t) { return !t.done; });
        var L = [];
        L.push('# ' + niceDate(curKey) + ' 工作总结');
        L.push('');
        if (d.todos.length) {
            L.push('完成 ' + done.length + ' / ' + d.todos.length + (done.length === d.todos.length && d.todos.length ? '（全部完成）' : ''));
            L.push('');
        }
        function line(t) {
            var bits = [];
            if (t.pinned) bits.push('置顶');
            if (t.urgent) bits.push('加急');
            var tail = '';
            if (t.project || t.assignee) {
                var pp = t.project ? ('项目：' + t.project) : '';
                var aa = t.assignee ? ('负责人：' + t.assignee) : '';
                tail = '（' + [pp, aa].filter(Boolean).join('，') + '）';
            }
            return '- ' + (bits.length ? '[' + bits.join('/') + '] ' : '') + t.text + tail;
        }
        L.push('## 已完成' + (done.length ? '（' + done.length + '）' : ''));
        if (done.length) done.forEach(function (t) { L.push(line(t)); }); else L.push('- （无）');
        L.push('');
        L.push('## 未完成' + (open.length ? '（' + open.length + '）' : ''));
        if (open.length) open.forEach(function (t) { L.push(line(t)); }); else L.push('- （无）');

        // 按项目 / 负责人汇总
        var g = groupStats();
        function sumBlock(title, obj) {
            var keys = Object.keys(obj);
            if (keys.length <= 1 && keys[0] === '未关联项目') return '';
            if (keys.length <= 1 && keys[0] === '未指定') return '';
            var out = ['', '## ' + title];
            keys.sort(function (x, y) { return (obj[y].total - obj[y].done) - (obj[x].total - obj[x].done); });
            keys.forEach(function (k) {
                var o = obj[k];
                out.push('- ' + k + '：' + o.done + '/' + o.total);
            });
            return out.join('\n');
        }
        var pb = sumBlock('按项目', g.byP);
        if (pb) L.push(pb);
        var ab = sumBlock('按负责人', g.byA);
        if (ab) L.push(ab);

        if (d.memo && d.memo.trim()) { L.push(''); L.push('## 备忘'); L.push(d.memo.trim()); }
        return L.join('\n');
    }

    // ---------- 选择器（项目 / 负责人）----------
    function closePickers() {
        if (el.tdProjPanel) el.tdProjPanel.style.display = 'none';
        if (el.tdAsgPanel) el.tdAsgPanel.style.display = 'none';
    }
    function togglePicker(which) {
        var panel = which === 'proj' ? el.tdProjPanel : el.tdAsgPanel;
        var other = which === 'proj' ? el.tdAsgPanel : el.tdProjPanel;
        if (!panel) return;
        if (other) other.style.display = 'none';
        var willShow = panel.style.display === 'none';
        panel.style.display = willShow ? '' : 'none';
        if (!willShow) return;
        var search = which === 'proj' ? el.tdProjSearch : el.tdAsgSearch;
        if (search) setTimeout(function () { try { search.focus(); search.select(); } catch (e) {} }, 0);
        if (which === 'proj') renderProjList(); else renderAsgList();
    }

    function renderProjList() {
        if (!el.tdProjList) return;
        var kw = String(projFilter || '').toLowerCase();
        var arr = wbProjects.filter(function (p) {
            if (!kw) return true;
            return p.name.toLowerCase().indexOf(kw) >= 0 || String(p.status || '').toLowerCase().indexOf(kw) >= 0;
        });
        // 未完成优先
        arr.sort(function (a, b) {
            if (a.done !== b.done) return a.done ? 1 : -1;
            return 0;
        });
        var cap = arr.slice(0, 200);
        var html = '<div class="td-pk-item" data-name="">不限</div>';
        cap.forEach(function (p) {
            var meta = p.done ? '已完成' : (p.status || '进行中');
            var prog = (p.total ? (' ' + p.cur + '/' + p.total) : '');
            html += '<div class="td-pk-item' + (p.done ? ' done' : '') + '" data-name="' + esc(p.name) + '" title="' + esc(p.name) + '">' +
                '<span class="td-pk-nm">' + esc(p.name) + '</span>' +
                '<span class="td-pk-meta">' + esc(meta + prog) + '</span></div>';
        });
        if (!cap.length) html = '<div class="td-pk-empty">没有匹配的项目</div>' + (wbProjects.length ? '' : '<div class="td-pk-empty">未取到项目，点 ↻ 重试</div>');
        el.tdProjList.innerHTML = html;
    }

    function renderAsgList() {
        if (!el.tdAsgList) return;
        var kw = String(asgFilter || '').toLowerCase();
        // 已选项目时：该项目相关的剪辑师置顶（从 episode_plan 推）
        var related = {};
        if (pendingProj) membersOfProject(pendingProj).forEach(function (n) { related[n] = 1; });
        var arr = wbMembers.filter(function (m) {
            if (!kw) return true;
            return (m.name + ' ' + m.title + ' ' + m.department).toLowerCase().indexOf(kw) >= 0;
        });
        arr.sort(function (a, b) {
            var ra = related[a.name] ? 0 : 1, rb = related[b.name] ? 0 : 1;
            if (ra !== rb) return ra - rb;
            return 0;
        });
        var html = '<div class="td-pk-item" data-name="">不限</div>';
        arr.forEach(function (m) {
            var meta = [m.title, m.department].filter(Boolean).join(' · ');
            if (related[m.name]) meta = '本项目 · ' + (meta || '');
            html += '<div class="td-pk-item" data-name="' + esc(m.name) + '">' +
                '<span class="td-pk-nm">' + esc(m.name) + '</span>' +
                (meta ? '<span class="td-pk-meta">' + esc(meta) + '</span>' : '') + '</div>';
        });
        if (!arr.length) html += '<div class="td-pk-empty">没有匹配的人员</div>';
        el.tdAsgList.innerHTML = html;
    }

    function setPick(which, name) {
        if (which === 'proj') {
            pendingProj = name || '';
            if (el.tdProjVal) el.tdProjVal.textContent = name ? shortProj(name) : '不限';
            if (el.tdProjVal) el.tdProjVal.title = name || '';
            if (el.tdProjBtn) el.tdProjBtn.classList.toggle('has', !!name);
        } else {
            pendingAsg = name || '';
            if (el.tdAsgVal) el.tdAsgVal.textContent = name || '不限';
            if (el.tdAsgBtn) el.tdAsgBtn.classList.toggle('has', !!name);
        }
        closePickers();
    }
    var pendingProj = '';
    var pendingAsg = '';

    function bindPickers() {
        if (el.tdProjBtn) el.tdProjBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            togglePicker('proj');
            if (el.tdProjPanel && el.tdProjPanel.style.display !== 'none') {
                loadWorkbench(false, function (err) {
                    if (err) {
                        if (el.tdProjList) el.tdProjList.innerHTML = '<div class="td-pk-empty">' + esc(err.message) + '</div>';
                        return;
                    }
                    renderProjList();
                });
            }
        });
        if (el.tdProjRefresh) el.tdProjRefresh.addEventListener('click', function (e) {
            e.stopPropagation();
            wbProjects = []; wbMembers = [];
            if (el.tdProjList) el.tdProjList.innerHTML = '<div class="td-pk-empty">加载中…</div>';
            loadWorkbench(true, function (err) {
                if (err) { if (el.tdProjList) el.tdProjList.innerHTML = '<div class="td-pk-empty">' + esc(err.message) + '</div>'; return; }
                renderProjList();
            });
        });
        if (el.tdProjSearch) {
            el.tdProjSearch.addEventListener('input', function () { projFilter = el.tdProjSearch.value; renderProjList(); });
            el.tdProjSearch.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePickers(); } });
        }
        if (el.tdProjList) el.tdProjList.addEventListener('click', function (e) {
            var it = e.target.closest ? e.target.closest('.td-pk-item') : null;
            if (!it) return;
            setPick('proj', it.getAttribute('data-name') || '');
        });

        if (el.tdAsgBtn) el.tdAsgBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            togglePicker('asg');
            if (el.tdAsgPanel && el.tdAsgPanel.style.display !== 'none') {
                loadMembers(false, function (err) {
                    if (err) { if (el.tdAsgList) el.tdAsgList.innerHTML = '<div class="td-pk-empty">' + esc(err.message) + '</div>'; return; }
                    renderAsgList();
                });
            }
        });
        if (el.tdAsgSearch) {
            el.tdAsgSearch.addEventListener('input', function () { asgFilter = el.tdAsgSearch.value; renderAsgList(); });
            el.tdAsgSearch.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePickers(); } });
        }
        if (el.tdAsgList) el.tdAsgList.addEventListener('click', function (e) {
            var it = e.target.closest ? e.target.closest('.td-pk-item') : null;
            if (!it) return;
            setPick('asg', it.getAttribute('data-name') || '');
        });

        // 点击面板外收起
        document.addEventListener('click', function (e) {
            var inProj = el.tdProjPanel && el.tdProjPanel.contains && el.tdProjPanel.contains(e.target);
            var inAsg = el.tdAsgPanel && el.tdAsgPanel.contains && el.tdAsgPanel.contains(e.target);
            var onBtn = (e.target.closest && (e.target.closest('#tdProjBtn') || e.target.closest('#tdAsgBtn')));
            if (!inProj && !inAsg && !onBtn) closePickers();
        });
    }

    // 可选：按项目拉取该项目相关剪辑师（在 renderAsgList 里置顶，无需单独请求）
    function loadAssigneesForProject() { /* 保留空实现：前置逻辑已并入 renderAsgList */ }

    // ---------- 事件 ----------
    function bind() {
        if (el.tdAdd) el.tdAdd.addEventListener('click', addTodo);
        if (el.tdInput) {
            el.tdInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); addTodo(); }
            });
        }

        if (el.tdList) {
            el.tdList.addEventListener('click', function (e) {
                var t = e.target.closest ? e.target.closest('.td-item') : null;
                if (!t) return;
                var id = t.getAttribute('data-id');
                var act = e.target.getAttribute && e.target.getAttribute('data-act');
                if (act === 'toggle') toggleTodo(id);
                else if (act === 'del') delTodo(id);
                else if (act === 'pin') toggleFlag(id, 'pinned');
                else if (act === 'urgent') toggleFlag(id, 'urgent');
                else if (act === 'edit') startEdit(t, id);
            });
            el.tdList.addEventListener('keydown', function (e) {
                if (e.key !== ' ' && e.key !== 'Enter') return;
                var cb = e.target.closest ? e.target.closest('.td-cb') : null;
                if (!cb) return;
                e.preventDefault();
                var t = cb.closest('.td-item');
                if (t) toggleTodo(t.getAttribute('data-id'));
            });
        }

        if (el.tdCarryBtn) {
            el.tdCarryBtn.addEventListener('click', function () {
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
                    if (exist[t.text]) return;
                    td.todos.unshift(emptyTodo({
                        text: t.text, project: t.project, assignee: t.assignee,
                        pinned: t.pinned, urgent: t.urgent, carried: true
                    }));
                    n++;
                });
                save(true);
                if (curKey === today) renderAll();
                toast('已结转 ' + n + ' 条到 ' + niceDate(today));
            });
        }

        if (el.tdMemo) {
            el.tdMemo.addEventListener('input', function () {
                day(curKey).memo = el.tdMemo.value;
                save();
                if (!isToday()) renderHistory();
            });
        }

        if (el.tdRollover) {
            el.tdRollover.addEventListener('change', function () {
                DB.rollover = !!el.tdRollover.checked;
                save(true);
                today = todayKey();
                curKey = today;
                renderAll();
            });
        }

        if (el.tdGen) {
            el.tdGen.addEventListener('click', function () {
                var s = genSummary();
                day(curKey).summary = s;
                save(true);
                renderSummary();
                renderHistory();
                toast('已生成总结');
            });
        }

        if (el.tdCopy) {
            el.tdCopy.addEventListener('click', function () {
                var txt = day(curKey).summary;
                if (!txt) { txt = genSummary(); day(curKey).summary = txt; save(true); renderSummary(); }
                copyText(txt);
            });
        }

        if (el.tdSave) {
            el.tdSave.addEventListener('click', function () {
                var txt = day(curKey).summary || genSummary();
                day(curKey).summary = txt;
                save(true);
                renderSummary();
                pickFolder(function (picked) {
                    var dir = picked || path.join(os.homedir(), 'Desktop');
                    var file = path.join(dir, '工作总结_' + curKey + '.md');
                    try { fs.writeFileSync(file, txt, 'utf8'); toast('已保存：' + path.basename(file)); }
                    catch (e) { toast('保存失败：' + e.message); }
                });
            });
        }

        if (el.tdHistory) {
            el.tdHistory.addEventListener('click', function (e) {
                var r = e.target.closest ? e.target.closest('.td-hrow') : null;
                if (!r) return;
                curKey = r.getAttribute('data-k');
                renderAll();
            });
        }

        if (el.tdBackToday) {
            el.tdBackToday.addEventListener('click', function () { curKey = today; renderAll(); });
        }

        bindPickers();
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

    // 目录选择：复用插件已有的 folderpicker.ps1（-Ini 传 JSON、-Out 写结果）
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
                        p = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').trim();
                        try { fs.unlinkSync(outFile); } catch (_) {}
                    }
                } catch (_) {}
                if (p && fs.existsSync(p)) { try { localStorage.setItem('vh_todo_lastdir', p); } catch (_) {} }
                cb(p || '');
            });
        } catch (e) { cb(''); }
    }

    // ---------- 待办操作 ----------
    function addTodo() {
        if (!isToday()) { toast('往期不能新增'); return; }
        var v = (el.tdInput.value || '').replace(/^\s+|\s+$/g, '');
        if (!v) return;
        day(curKey).todos.push(emptyTodo({ text: v, project: pendingProj, assignee: pendingAsg }));
        el.tdInput.value = '';
        // 项目/负责人不自动清空（同一批通常同项目同人），但提示当前值仍生效
        save();
        renderList();
        renderGroupSum();
        renderHistory();
        el.tdInput.focus();
    }

    function findTodo(id) {
        var d = day(curKey);
        for (var i = 0; i < d.todos.length; i++) if (d.todos[i].id === id) return d.todos[i];
        return null;
    }

    function toggleTodo(id) {
        var t = findTodo(id);
        if (!t) return;
        t.done = !t.done;
        t.doneAt = t.done ? Date.now() : 0;
        save(); renderList(); renderGroupSum(); renderHistory();
    }

    function toggleFlag(id, flag) {
        var t = findTodo(id);
        if (!t) return;
        t[flag] = !t[flag];
        save(); renderList();
    }

    function delTodo(id) {
        var d = day(curKey);
        d.todos = d.todos.filter(function (t) { return t.id !== id; });
        save(true); renderList(); renderGroupSum(); renderHistory();
    }

    function startEdit(itemEl, id) {
        if (!isToday()) { toast('往期不能编辑'); return; }
        var t = findTodo(id);
        if (!t) return;
        var tx = itemEl.querySelector('.td-tx');
        if (!tx) return;
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'td-edit';
        inp.value = t.text;
        tx.replaceWith(inp);
        inp.focus(); inp.select();
        var finished = false;
        function commit(ok) {
            if (finished) return;
            finished = true;
            var nv = (inp.value || '').replace(/^\s+|\s+$/g, '');
            if (ok && nv) t.text = nv;
            save(); renderList();
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
        if (!el.tdList) return;
        load();
        curKey = todayKey();
        today = curKey;
        bind();
        renderAll();
        // 后台预热工作台数据（失败静默，不影响面板本身）
        warmWorkbench();
    }

    // 预热：任何异常都不能影响待办面板
    function warmWorkbench() {
        try { loadWorkbench(false, function () {}); } catch (e) {}
        try { loadMembers(false, function () {}); } catch (e) {}
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.__todoOnShow = function () {
        var t = todayKey();
        if (t !== today) { today = t; curKey = t; }
        renderAll();
        warmWorkbench();
    };

    window.__vhTodo = {
        today: function () { return todayKey(); },
        stats: function (k) {
            var d = day(k || todayKey());
            var total = d.todos.length;
            var done = d.todos.filter(function (t) { return t.done; }).length;
            return { total: total, done: done, open: total - done, memo: d.memo || '' };
        },
        // 供其它模块查工作台数据（已缓存）
        projects: function () { return wbProjects.slice(); },
        members: function () { return wbMembers.slice(); }
    };
})();
