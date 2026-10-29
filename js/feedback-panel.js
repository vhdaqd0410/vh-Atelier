// vh-Atelier 客户版 · 反馈中心（原生界面）
//
// 与原版区别：
//   · 不再内嵌整个反馈网站（那里有管理入口、改状态、删除等客户端用不到的功能）
//   · 只做两件事：提交反馈、看自己提交过的反馈进度
//   · 提交按钮做得显眼，占位提示告诉用户该怎么写
//
// 「我的反馈」怎么定位到自己：
//   服务端 /api/list 是公开列表且不含提交者标识，无法按 IP 过滤（客户版也不该看别人的反馈）。
//   所以提交成功后把返回的 id 存进本地 localStorage，列表只渲染这些 id 对应的条目。
//   换机器或清缓存会丢失本地记录，这是接受的代价。
//
// 依赖：js/feedback.js 提供 submitFeedback / cfg / ping
(function () {
    'use strict';

    var FB = window.__vhFeedback;
    if (!FB) { console.log('[fb] feedback.js 未加载'); return; }

    var STORE_KEY = 'vh_fb_mine_v1';
    var MAX_STORE = 100;

    function $(id) { return document.getElementById(id); }
    var el = {};
    var curKind = 'bug';
    var busy = false;

    function initEl() {
        el.panel = $('panel-feedback');
        el.formWrap = $('fbFormWrap');
        el.kinds = $('fbKinds');
        el.title = $('fbTitle');
        el.titleCount = $('fbTitleCount');
        el.detail = $('fbDetail');
        el.detailCount = $('fbDetailCount');
        el.contact = $('fbContact');
        el.withLogs = $('fbWithLogs');
        el.btnSubmit = $('fbBtnSubmit');
        el.msg = $('fbMsg');
        el.historyWrap = $('fbHistoryWrap');
        el.histList = $('fbHistList');
        el.btnHistory = $('fbBtnHistory');
        el.btnBack = $('fbBtnBack');
        el.btnRefreshList = $('fbBtnRefreshList');
    }

    function msg(t, cls) {
        if (!el.msg) return;
        el.msg.textContent = t || '';
        el.msg.className = 'fb-msg' + (cls ? ' ' + cls : '');
    }

    function setBusy(b) {
        busy = b;
        if (el.btnSubmit) {
            el.btnSubmit.disabled = b;
            var t = el.btnSubmit.querySelector('.fb-submit-t');
            if (t) t.textContent = b ? '提交中…' : '提交反馈';
        }
    }

    // ---------- 本地记录 ----------
    function readStore() {
        try {
            var raw = localStorage.getItem(STORE_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    }

    function writeStore(arr) {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(arr.slice(0, MAX_STORE)));
        } catch (e) {}
    }

    function addStore(rec) {
        var arr = readStore();
        // 去重（同 id 覆盖）
        arr = arr.filter(function (x) { return x && x.id !== rec.id; });
        arr.unshift(rec);
        writeStore(arr);
    }

    // ---------- 字数统计 ----------
    function bindCount(input, counter, max) {
        if (!input || !counter) return;
        function upd() {
            var n = (input.value || '').length;
            counter.textContent = n;
            var box = counter.parentNode;
            if (box) box.className = 'fb-counter' + (n > max * 0.9 ? ' warn' : '');
        }
        input.addEventListener('input', upd);
        upd();
    }

    // ---------- 类型切换 ----------
    function bindKinds() {
        if (!el.kinds) return;
        el.kinds.addEventListener('click', function (ev) {
            var b = ev.target.closest ? ev.target.closest('.fb-kind') : null;
            if (!b) return;
            curKind = b.dataset.kind || 'bug';
            Array.prototype.forEach.call(el.kinds.querySelectorAll('.fb-kind'), function (x) {
                x.classList.toggle('active', x === b);
            });
        });
    }

    // ---------- 提交 ----------
    function doSubmit() {
        if (busy) return;

        var title = (el.title && el.title.value || '').trim();
        var detail = (el.detail && el.detail.value || '').trim();
        var contact = (el.contact && el.contact.value || '').trim();

        if (!title) {
            msg('请填写「一句话说明」，简单描述问题或建议', 'err');
            if (el.title) el.title.focus();
            return;
        }
        if (title.length < 4) {
            msg('说明太短了，请至少写 4 个字', 'err');
            if (el.title) el.title.focus();
            return;
        }
        if (!detail) {
            msg('请填写「详细描述」，写清操作步骤和现象', 'err');
            if (el.detail) el.detail.focus();
            return;
        }

        // 联系方式追加到 detail 末尾（服务端没有独立字段）
        var fullDetail = detail;
        if (contact) fullDetail += '\n\n---\n联系方式：' + contact;

        setBusy(true);
        msg('正在提交…');

        var opts = { withLogs: !!(el.withLogs && el.withLogs.checked) };

        FB.submitFeedback(curKind, title, fullDetail, opts, function (err, res) {
            setBusy(false);
            if (err) {
                var m = String(err.message || err);
                if (/超时|不可达|ENOTFOUND|ECONNREFUSED|network/i.test(m)) {
                    msg('提交失败：连不上反馈服务器\n' + m +
                        '\n\n可以稍后重试，或把问题直接发给管理员。', 'err');
                } else {
                    msg('提交失败：' + m, 'err');
                }
                return;
            }

            // 记到本地，供「我的反馈」查看进度
            var id = (res && (res.id || res.number)) || null;
            if (id) {
                addStore({
                    id: String(id),
                    kind: curKind,
                    title: title,
                    createdAt: Date.now()
                });
            }

            msg('✓ 提交成功！感谢反馈，我们会尽快处理。', 'ok');

            if (el.title) el.title.value = '';
            if (el.detail) el.detail.value = '';
            if (el.contact) el.contact.value = '';
            bindCount(el.title, el.titleCount, 200);
            bindCount(el.detail, el.detailCount, 15000);

            setTimeout(function () {
                if (el.msg && el.msg.textContent.indexOf('提交成功') >= 0) {
                    msg('✓ 提交成功。点右上角「我的反馈」可以查看处理进度', 'ok');
                }
            }, 2600);
        });
    }

    // ---------- 我的反馈列表 ----------
    var KIND_T = { bug: '问题', idea: '建议', other: '其他' };
    var STATUS_T = { pending: '待处理', done: '已解决', replied: '已回复', closed: '已关闭', fixed: '已修复' };

    function fmtTime(ts) {
        if (!ts) return '';
        try {
            var d = new Date(ts);
            var now = Date.now();
            var diff = (now - d.getTime()) / 1000;
            if (diff < 60) return '刚刚';
            if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
            if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
            if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
            return (d.getMonth() + 1) + '-' + String(d.getDate()).padStart(2, '0');
        } catch (e) { return ''; }
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function loadHistory() {
        if (!el.histList) return;

        var mine = readStore();
        if (!mine.length) {
            el.histList.innerHTML = '<div class="fb-empty">还没有提交过反馈<br>回到上一个页面填写并提交吧</div>';
            return;
        }

        el.histList.innerHTML = '<div class="fb-empty">加载中…</div>';

        var cfg = {};
        try { cfg = FB.cfg ? FB.cfg() : {}; } catch (e) {}
        var base = (cfg && cfg.base) || 'http://47.122.108.231:17893';

        var done = false;
        var xhr = new XMLHttpRequest();
        function finish(err, items) {
            if (done) return;
            done = true;
            renderHistory(err, items);
        }

        try {
            xhr.open('GET', base + '/api/list', true);
            xhr.timeout = 15000;
            xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return;
                if (xhr.status === 0) return finish(new Error('网络不可用'), null);
                if (xhr.status !== 200) return finish(new Error('HTTP ' + xhr.status), null);
                try {
                    var j = JSON.parse(xhr.responseText || '{}');
                    finish(null, (j && j.items) || []);
                } catch (e) {
                    finish(new Error('返回格式异常'), null);
                }
            };
            xhr.onerror = function () { finish(new Error('网络错误'), null); };
            xhr.ontimeout = function () { finish(new Error('请求超时'), null); };
            xhr.send();
        } catch (e) {
            finish(e, null);
        }
    }

    function renderHistory(err, all) {
        if (!el.histList) return;

        var mine = readStore();
        // 服务端不可达时，至少把本地提交记录显示出来（状态未知）
        var byId = {};
        if (all) {
            all.forEach(function (it) { if (it && it.id) byId[String(it.id)] = it; });
        }

        var rows = mine.map(function (m) {
            var s = byId[String(m.id)];
            return {
                id: m.id,
                kind: (s && s.kind) || m.kind || 'other',
                title: (s && s.title) || m.title || '(无标题)',
                detail: (s && s.detail) || '',
                createdAt: (s && s.createdAt) || m.createdAt,
                status: (s && s.status) || '',
                replies: (s && s.replies) || []
            };
        });

        if (!rows.length) {
            el.histList.innerHTML = '<div class="fb-empty">还没有提交过反馈</div>';
            return;
        }

        var offline = '';
        if (err) {
            offline = '<div class="fb-empty" style="padding:10px 0 14px;">' +
                '⚠ 暂时拿不到处理进度（' + esc(err.message || err) + '）<br>' +
                '下面是你提交过的记录，可以稍后点 ↻ 重试</div>';
        }

        var html = offline;
        rows.forEach(function (it) {
            var statusHtml = it.status
                ? '<span class="fb-hist-status ' + esc(it.status) + '">' + esc(STATUS_T[it.status] || it.status) + '</span>'
                : '<span class="fb-hist-status pending">已提交</span>';

            var replyHtml = '';
            if (it.replies && it.replies.length) {
                it.replies.forEach(function (r) {
                    var txt = (typeof r === 'string') ? r : (r.text || r.body || '');
                    if (!txt) return;
                    replyHtml += '<div class="fb-hist-reply">管理员回复：' + esc(txt) + '</div>';
                });
            }

            html += '<div class="fb-hist-item">' +
                '<div class="fb-hist-top">' +
                    '<span class="fb-hist-kind ' + esc(it.kind) + '">' + esc(KIND_T[it.kind] || '其他') + '</span>' +
                    '<span class="fb-hist-title-t">' + esc(it.title) + '</span>' +
                    '<span class="fb-hist-time">' + esc(fmtTime(it.createdAt)) + '</span>' +
                '</div>' +
                '<div class="fb-hist-top" style="margin-bottom:4px;">' + statusHtml + '</div>' +
                (it.detail ? ('<div class="fb-hist-detail">' + esc(String(it.detail).slice(0, 200)) + '</div>') : '') +
                replyHtml +
            '</div>';
        });

        el.histList.innerHTML = html;
    }

    // ---------- 视图切换 ----------
    function showForm() {
        if (el.formWrap) el.formWrap.style.display = '';
        if (el.historyWrap) el.historyWrap.style.display = 'none';
    }

    function showHistory() {
        if (el.formWrap) el.formWrap.style.display = 'none';
        if (el.historyWrap) el.historyWrap.style.display = 'flex';
        loadHistory();
    }

    // ---------- 初始化 ----------
    function bind() {
        initEl();
        if (!el.panel) return;

        bindKinds();
        bindCount(el.title, el.titleCount, 200);
        bindCount(el.detail, el.detailCount, 15000);

        if (el.btnSubmit) el.btnSubmit.addEventListener('click', doSubmit);
        if (el.btnHistory) el.btnHistory.addEventListener('click', showHistory);
        if (el.btnBack) el.btnBack.addEventListener('click', showForm);
        if (el.btnRefreshList) el.btnRefreshList.addEventListener('click', loadHistory);

        // Ctrl+Enter 快速提交
        [el.title, el.detail].forEach(function (x) {
            if (!x) return;
            x.addEventListener('keydown', function (ev) {
                if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                    ev.preventDefault();
                    doSubmit();
                }
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }

    // 每次切到反馈面板：回到表单视图并探一次服务器
    window.__feedbackPanelOnShow = function () {
        showForm();
        if (FB.ping) {
            FB.ping(function (err) {
                if (err) {
                    msg('⚠ 反馈服务器暂时连不上，提交可能失败：' + (err.message || ''), 'warn');
                } else if (el.msg && el.msg.textContent.indexOf('连不上') >= 0) {
                    msg('');
                }
            });
        }
    };

    window.__vhFeedbackPanel = {
        showForm: showForm,
        showHistory: showHistory,
        store: readStore
    };
})();
