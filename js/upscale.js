// vh-Atelier 达芬奇版 · 去字幕 / 超分（云端站 subtitle.zztianqiao.com）
// 完整链路：选时间线 → Resolve 渲染导出无字幕底版 → Python 上传 → 轮询任务 → 下载 → 导入媒体池
// 与 PR 版差异：
//   1. 渲染走宿主桥 exportStart（Resolve 渲染 API），不是 meExport JSX
//   2. Python 调用走主进程 svcPyRun（渲染进程无 child_process）
(function () {
    'use strict';
    if (window.__upscalePanel && window.__upscalePanel.init) return;

    var H = null;
    var el = {};
    var busy = false;
    var pollTimer = null;
    var curTask = null;      // { file, taskId }
    var lastExportPath = '';
    var exportStartedAt = 0;   // 导出开始时间，用于筛出本次产物
    var folderList = [];

    function $(id) { return document.getElementById(id); }

    function bindEls() {
        ['enSeqList', 'enRefSeq', 'enPreset', 'enFolder', 'enRes', 'enMode',
         'enGrabClip', 'enClipSrc', 'enClipInfo', 'enPreset', 'enSettings', 'enSiteBtn',
         'enGo', 'enStop', 'enAccount', 'enAccHint', 'enProgWrap', 'enProgFill',
         'enProgText', 'enProgPct', 'enActHint', 'enTaskList', 'enTaskHint',
         'enTaskRefresh', 'enTaskDlSel', 'enTaskPickAll', 'enLogList', 'enLogClear'
        ].forEach(function (k) { el[k] = $(k); });
    }

    function log(msg) {
        var box = el.enLogList;
        if (!box) return;
        var d = document.createElement('div');
        d.className = 'en-log-line';
        d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
        box.appendChild(d);
        box.scrollTop = box.scrollHeight;
    }

    function setProg(pct, text) {
        if (el.enProgWrap) el.enProgWrap.style.display = 'block';
        if (el.enProgFill && pct >= 0) el.enProgFill.style.width = Math.min(100, pct) + '%';
        if (el.enProgText) el.enProgText.textContent = text || '';
        if (el.enProgPct && pct >= 0) el.enProgPct.textContent = Math.round(pct) + '%';
    }
    function hideProg() { if (el.enProgWrap) el.enProgWrap.style.display = 'none'; }

    // ---------- 时间线列表 ----------
    function loadTimelines() {
        if (!H) return;
        H.listTimelines().then(function (r) {
            var box = el.enSeqList;
            if (!box) return;
            box.innerHTML = '';
            if (!r || !r.ok) {
                box.innerHTML = '<div class="hint" style="padding:6px;">读取失败：' +
                    ((r && r.error) || '未知') + '</div>';
                return;
            }
            // resolve-host 返回 { fps, timelines: [...] }，不是裸数组
            var d = r.data || {};
            var list = Array.isArray(d) ? d : (d.timelines || []);
            if (!list.length) {
                box.innerHTML = '<div class="hint" style="padding:6px;">工程里没有时间线</div>';
                return;
            }
            var anyCurrent = false;
            list.forEach(function (t) {
                var name = (typeof t === 'string') ? t : (t.name || '');
                if (!name) return;
                var isCur = !!(t && t.current);
                if (isCur) anyCurrent = true;
                var lab = document.createElement('label');
                lab.className = 'en-seq';
                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = name;
                cb.checked = isCur;
                var sp = document.createElement('span');
                sp.textContent = name + (isCur ? '  · 当前' : '');
                lab.appendChild(cb);
                lab.appendChild(sp);
                box.appendChild(lab);
            });
            // 没有标 current 的，默认选第一条
            if (!anyCurrent) {
                var first = box.querySelector('input');
                if (first) first.checked = true;
            }
        }).catch(function (e) {
            var box = el.enSeqList;
            if (box) box.innerHTML = '<div class="hint" style="padding:6px;">异常：' + (e.message || e) + '</div>';
        });
    }

    function pickedSeqs() {
        if (!el.enSeqList) return [];
        return Array.prototype.slice.call(el.enSeqList.querySelectorAll('input:checked'))
            .map(function (x) { return x.value; });
    }

    // ---------- 账号（对齐 PR：打开面板自动检测 + 自动登录）----------
    // check 子命令会：读本地账号 → 真正调登录接口 → 验证 token 可用
    function checkAccount(silent) {
        if (!H || !H.pyEnhance) return;
        if (!silent && el.enAccHint) el.enAccHint.textContent = '正在检查账号…';

        H.pyEnhance(['check']).then(function (r) {
            var hint = el.enAccHint;
            if (!r || !r.ok) {
                if (hint) hint.innerHTML = '⚠ 账号检测失败：' + ((r && r.error) || '未知') + '，点「⚙ 账号」重设';
                return;
            }
            var d = r.data || {};
            if (!d.configured) {
                if (hint) hint.innerHTML = '⚠ 未配置超分站账号，点「⚙ 账号」设置（否则无法提交任务）';
                return;
            }
            if (d.logged) {
                // 成功：显示昵称/余额（PR 同款信息）
                var extra = [];
                var nm = d.nickName || d.nickname || d.userName;
                if (nm) extra.push(nm);
                if (d.balance !== undefined && d.balance !== null) extra.push('余额 ' + d.balance);
                else if (d.score !== undefined && d.score !== null) extra.push('积分 ' + d.score);
                if (hint) {
                    hint.innerHTML = '✅ 账号 <b style="color:#d6e2ee;">' + esc(d.user || '') + '</b>' +
                        (extra.length ? ' · ' + esc(extra.join(' · ')) : '') + ' · 登录正常';
                }
                // 登录成功才去拉文件夹
                loadFolders();
            } else {
                if (hint) {
                    hint.innerHTML = '⚠ 账号 <b>' + esc(d.user || '') + '</b> 登录失败：' +
                        esc(d.msg || '请检查账号密码') + '，点「⚙ 账号」重设';
                }
            }
        }).catch(function (e) {
            if (el.enAccHint) el.enAccHint.textContent = '⚠ 检测异常：' + (e.message || e);
        });
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 账号配置：自绘弹层（window.prompt 在 Electron 被禁用，会返回 null 且不弹窗）
    function openAccountDialog() {
        if (!H || !H.pyEnhance) return;

        // 先读已保存的账号，回填
        H.pyEnhance(['account', '--json']).then(function (r) {
            var saved = (r && r.ok && r.data) ? r.data : {};
            showAccountForm(saved.user || '');
        }).catch(function () { showAccountForm(''); });
    }

    function showAccountForm(savedUser) {
        // 移除旧弹层
        var old = document.getElementById('enAccMask');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var mask = document.createElement('div');
        mask.id = 'enAccMask';
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100300;'
            + 'display:flex;align-items:center;justify-content:center;';

        var box = document.createElement('div');
        box.style.cssText = 'background:#242424;border:1px solid #4a4a4a;border-radius:9px;'
            + 'padding:16px;width:330px;box-shadow:0 10px 40px rgba(0,0,0,.6);';

        box.innerHTML =
            '<div style="font-size:13px;font-weight:600;color:#eee;margin-bottom:4px;">超分站账号</div>' +
            '<div style="font-size:11px;color:#8a97a5;margin-bottom:12px;line-height:1.6;">' +
              '站点：subtitle.zztianqiao.com<br>每台机器填自己的账号，任务与余额互不影响。<br>只存本地，不会外传。' +
            '</div>' +
            '<div style="font-size:11px;color:#9fb4c7;margin-bottom:3px;">账号</div>' +
            '<input id="enAccUser" type="text" style="width:100%;height:28px;background:#0e1116;'
              + 'border:1px solid #2b3440;border-radius:4px;color:#d6e2ee;font-size:12px;padding:0 7px;'
              + 'box-sizing:border-box;margin-bottom:9px;" placeholder="手机号或账号">' +
            '<div style="font-size:11px;color:#9fb4c7;margin-bottom:3px;">密码</div>' +
            '<input id="enAccPwd" type="password" style="width:100%;height:28px;background:#0e1116;'
              + 'border:1px solid #2b3440;border-radius:4px;color:#d6e2ee;font-size:12px;padding:0 7px;'
              + 'box-sizing:border-box;margin-bottom:10px;" placeholder="密码">' +
            '<div id="enAccMsg" style="font-size:11px;color:#ff9a9a;min-height:15px;margin-bottom:8px;"></div>' +
            '<div style="display:flex;gap:7px;justify-content:flex-end;">' +
              '<button id="enAccOpen" class="secondary mini">打开网站</button>' +
              '<button id="enAccCancel" class="secondary mini">取消</button>' +
              '<button id="enAccOk" class="primary mini">保存并登录</button>' +
            '</div>';

        mask.appendChild(box);
        document.body.appendChild(mask);

        var iu = document.getElementById('enAccUser');
        var ip = document.getElementById('enAccPwd');
        var msg = document.getElementById('enAccMsg');
        if (iu) { iu.value = savedUser || ''; setTimeout(function () { try { (savedUser ? ip : iu).focus(); } catch (e) {} }, 30); }

        function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }

        document.getElementById('enAccCancel').addEventListener('click', close);
        document.getElementById('enAccOpen').addEventListener('click', function () {
            if (H && H.openExternal) H.openExternal('http://subtitle.zztianqiao.com');
        });
        document.getElementById('enAccOk').addEventListener('click', function () {
            var u = (iu.value || '').trim();
            var pw = ip.value || '';
            if (!u || !pw) { msg.textContent = '账号和密码都要填'; return; }
            msg.style.color = '#8a97a5';
            msg.textContent = '正在保存并登录…';
            // 关键：account 子命令保存账号用的是 --file "user:pass"，
            // 传 --user/--pwd 会被忽略（表现为"提示成功但仍显示未配置"）。
            var spec = u + ':' + pw;
            H.pyEnhance(['account', '--file', spec]).then(function (r1) {
                if (!r1 || !r1.ok) throw new Error('保存失败：' + ((r1 && r1.error) || ''));
                // 保存后用 check 做真实登录验证（PR 同逻辑）
                return H.pyEnhance(['check']);
            }).then(function (r) {
                var d = (r && r.ok && r.data) ? r.data : {};
                if (d.logged) {
                    msg.style.color = '#7ddc9a';
                    msg.textContent = '✅ 已保存并登录成功';
                    setTimeout(function () { close(); checkAccount(true); }, 700);
                } else {
                    msg.style.color = '#ff9a9a';
                    msg.textContent = '登录失败：' + (d.msg || '请检查账号密码');
                }
            }).catch(function (e) {
                msg.style.color = '#ff9a9a';
                msg.textContent = '出错：' + (e.message || e);
            });
        });
        mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    }

    // ---------- 文件夹 ----------
    function loadFolders() {
        if (!H || !H.pyEnhance) return;
        if (el.enFolder) el.enFolder.innerHTML = '<option value="">加载中…</option>';
        var cur = el.enFolder ? el.enFolder.value : '';

        H.pyEnhance(['folders', '--json']).then(function (r) {
            if (!el.enFolder) return;
            // 宿主包装 {ok,data}；data 可能是数组，也可能是 {ok:false,error}
            var arr = [];
            if (r && r.ok) {
                var d = r.data;
                if (Array.isArray(d)) arr = d;
                else if (d && Array.isArray(d.list)) arr = d.list;
            }
            if (!arr.length) {
                el.enFolder.innerHTML = '<option value="14086">超分（默认）</option>';
                if (r && r.data && r.data.error) {
                    log('文件夹读取失败：' + r.data.error);
                }
                return;
            }
            folderList = arr;
            el.enFolder.innerHTML = '';
            arr.forEach(function (f) {
                var id = String(f.ID != null ? f.ID : (f.id != null ? f.id : ''));
                var o = document.createElement('option');
                o.value = id;
                var desc = f.description ? (' - ' + f.description) : '';
                o.textContent = (f.name || ('文件夹 ' + id)) + desc + '（ID ' + id + '）';
                if (id === cur || id === '14086') o.selected = true;
                el.enFolder.appendChild(o);
            });
            if (!el.enFolder.value && arr.length) {
                el.enFolder.value = String(arr[0].ID != null ? arr[0].ID : arr[0].id);
            }
            log('已加载 ' + arr.length + ' 个上传文件夹');
            loadTasks();
        }).catch(function (e) {
            if (el.enFolder) el.enFolder.innerHTML = '<option value="14086">超分（默认）</option>';
            log('文件夹异常：' + (e.message || e));
        });
    }

    // ---------- 任务列表 ----------
    // ---------- 任务显示辅助（对齐 PR）----------
    function taskStateLabel(st, mode) {
        var base = { pending: '待处理', queued: '排队中', running: (mode === 'erase' ? '处理中' : '超分中'),
                     succeeded: '✅ 完成', failed: '❌ 失败' };
        return base[st] || st || '';
    }
    function taskColor(st) {
        if (st === 'succeeded') return '#7fd68b';
        if (st === 'failed') return '#ff9a9a';
        if (st === 'running') return '#ffd76a';
        if (st === 'queued' || st === 'pending') return '#9a9a9a';
        return '#9a9a9a';
    }
    function fmtTime(iso) {
        try {
            var d = new Date(String(iso || '').replace('T', ' ').replace(/\+08:00$/, ''));
            if (isNaN(d.getTime())) return iso ? String(iso).slice(5, 16) : '';
            function p2(x) { return x < 10 ? '0' + x : '' + x; }
            return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
        } catch (e) { return ''; }
    }
    function prettyName(fn) {
        var n = String(fn || '');
        n = n.replace(/_nosub\.mp4$/i, '.mp4');
        return n;
    }

    function loadTasks() {
        if (!H || !H.pyEnhance) return;
        var mode = el.enMode ? el.enMode.value : 'enhance';
        var cmd = (mode === 'erase') ? ['erase-tasks', '--json'] : ['tasks', '--json'];

        H.pyEnhance(cmd).then(function (r) {
            var box = el.enTaskList;
            if (!box) return;
            var list = [];
            if (r && r.ok) {
                var d = r.data;
                if (Array.isArray(d)) list = d;
                else if (d && Array.isArray(d.list)) list = d.list;
            }
            if (!list.length) {
                box.innerHTML = '<div class="hint" style="padding:8px;">暂无任务</div>';
                if (el.enTaskHint) el.enTaskHint.textContent = '';
                return;
            }
            var doneCount = list.filter(function (t) { return t.status === 'succeeded'; }).length;
            if (el.enTaskHint) {
                el.enTaskHint.textContent = '共 ' + list.length + ' 条 · 已完成 ' + doneCount;
            }
            box.innerHTML = '';
            list.forEach(function (t) {
                var id = String(t.ID != null ? t.ID : (t.id != null ? t.id : ''));
                var st = String(t.status || '');
                var done = (st === 'succeeded');

                // 文件夹名映射
                var fmap = null;
                var fid = (t.folderId !== undefined && t.folderId !== null) ? t.folderId
                        : (t.folderID !== undefined ? t.folderID : '');
                for (var fi = 0; fi < folderList.length; fi++) {
                    if (String(folderList[fi].ID) === String(fid)) { fmap = folderList[fi]; break; }
                }

                var row = document.createElement('div');
                row.className = 'en-task';

                // ---- 主行：勾选 + 文件名 + 状态 + 下载 ----
                var mainRow = document.createElement('div');
                mainRow.className = 'en-task-mainrow';

                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'task-cb';
                cb.value = id;
                if (!done) cb.disabled = true;
                mainRow.appendChild(cb);

                var nm = document.createElement('span');
                nm.className = 'en-task-name';
                nm.textContent = prettyName(t.sourceFileName || t.outputFileName || t.name || ('任务 ' + id));
                nm.title = (t.sourceFileName || '') + ' · 任务ID ' + id +
                           (t.resultFileName ? ('\n结果: ' + t.resultFileName) : '');
                mainRow.appendChild(nm);

                var stEl = document.createElement('span');
                stEl.className = 'en-task-state';
                var stColor = taskColor(st);
                stEl.style.color = stColor;
                stEl.style.border = '1px solid ' + stColor + '44';
                stEl.style.background = stColor + '18';
                stEl.textContent = taskStateLabel(st, mode);
                mainRow.appendChild(stEl);

                if (done) {
                    var btn = document.createElement('button');
                    btn.className = 'secondary mini en-task-dl';
                    btn.textContent = '⬇ 下载';
                    btn.title = '下载到本地并导入媒体池';
                    btn.addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        downloadTask(id);
                    });
                    mainRow.appendChild(btn);
                }
                row.appendChild(mainRow);

                // ---- meta 行：时间 · 文件夹 · 分辨率 · 花费 · 时长 ----
                var meta = document.createElement('div');
                meta.className = 'en-task-meta';

                var tm = document.createElement('span');
                tm.textContent = '🕐 ' + fmtTime(t.CreatedAt);
                meta.appendChild(tm);

                var fd = document.createElement('span');
                fd.className = 'en-task-folder';
                fd.textContent = '📁 ' + (fmap ? fmap.name : ('文件夹' + fid));
                fd.title = fmap ? ((fmap.name || '') + ' ' + (fmap.description || '')) : '';
                meta.appendChild(fd);

                if (t.resolution) {
                    var rs = document.createElement('span');
                    rs.textContent = '🎚 ' + t.resolution;
                    meta.appendChild(rs);
                }
                if (t.costCents) {
                    var cs = document.createElement('span');
                    cs.textContent = '💰 ¥' + (t.costCents / 100).toFixed(2);
                    meta.appendChild(cs);
                }
                if (t.outputDurationSeconds) {
                    var ds = document.createElement('span');
                    ds.textContent = '⏱ ' + Math.round(t.outputDurationSeconds) + 's';
                    meta.appendChild(ds);
                }
                if (!done && t.progress !== undefined && t.progress !== null && t.progress > 0) {
                    var pg = document.createElement('span');
                    pg.textContent = '进度 ' + t.progress + '%';
                    pg.style.color = '#ffd76a';
                    meta.appendChild(pg);
                }
                row.appendChild(meta);

                // 未完成的任务显示细进度条
                if (!done && t.progress > 0 && t.progress < 100) {
                    var pb = document.createElement('div');
                    pb.className = 'en-task-progress';
                    var pi = document.createElement('i');
                    pi.style.width = Math.min(100, t.progress) + '%';
                    pb.appendChild(pi);
                    row.appendChild(pb);
                }

                box.appendChild(row);
            });
        }).catch(function (e) {
            var box = el.enTaskList;
            if (box) box.innerHTML = '<div class="hint" style="padding:8px;">读取失败：' + (e.message || e) + '</div>';
        });
    }

    // ---------- 下载 ----------
    function downloadTask(taskId) {
        if (!H || !H.pyEnhance) return;
        setProg(-1, '正在下载…');
        log('下载任务 ' + taskId);
        ensureDownloadDir().then(function (dir) {
            if (!dir) { hideProg(); return; }
            return H.pyEnhance(['download', '--task', String(taskId), '--download-to', dir, '--json'])
                .then(function (r) {
                    hideProg();
                    if (r && r.ok && r.data && r.data.path) {
                        log('下载完成：' + r.data.path);
                        if (H.importFilesToPool) H.importFilesToPool([r.data.path]);
                        if (el.enActHint) el.enActHint.textContent = '已下载并导入：' + r.data.path;
                    } else {
                        log('下载失败：' + ((r && r.error) || ''));
                    }
                });
        }).catch(function (e) { hideProg(); log('下载异常：' + e.message); });
    }

    // ---------- 输出目录设置（记住上次选择，不用每次手动选）----------
    var DIR_KEY = 'vh_upscale_dirs_v1';

    function loadDirs() {
        try {
            var raw = localStorage.getItem(DIR_KEY);
            if (!raw) return { temp: '', download: '' };
            var o = JSON.parse(raw);
            return { temp: o.temp || '', download: o.download || '' };
        } catch (e) { return { temp: '', download: '' }; }
    }
    function saveDirs(o) {
        try { localStorage.setItem(DIR_KEY, JSON.stringify(o || {})); } catch (e) {}
    }

    function openSettings() {
        var cur = loadDirs();
        var old = document.getElementById('enSetMask');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var mask = document.createElement('div');
        mask.id = 'enSetMask';
        mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100300;'
            + 'display:flex;align-items:center;justify-content:center;';

        var box = document.createElement('div');
        box.style.cssText = 'background:#242424;border:1px solid #4a4a4a;border-radius:9px;'
            + 'padding:16px;width:400px;box-shadow:0 10px 40px rgba(0,0,0,.6);';

        box.innerHTML =
            '<div style="font-size:13px;font-weight:600;color:#eee;margin-bottom:4px;">超分设置</div>' +
            '<div style="font-size:11px;color:#8a97a5;margin-bottom:12px;">设定一次即可，之后不再每次询问。</div>' +
            '<div style="font-size:11px;color:#9fb4c7;margin-bottom:3px;">导出临时目录</div>' +
            '<div style="display:flex;gap:5px;margin-bottom:10px;">' +
              '<input id="enSetTemp" type="text" style="flex:1;height:26px;background:#0e1116;border:1px solid #2b3440;' +
              'border-radius:4px;color:#d6e2ee;font-size:11px;padding:0 6px;" placeholder="留空则每次询问">' +
              '<button id="enSetTempPick" class="secondary mini">浏览…</button>' +
            '</div>' +
            '<div style="font-size:11px;color:#9fb4c7;margin-bottom:3px;">任务下载目录</div>' +
            '<div style="display:flex;gap:5px;margin-bottom:12px;">' +
              '<input id="enSetDl" type="text" style="flex:1;height:26px;background:#0e1116;border:1px solid #2b3440;' +
              'border-radius:4px;color:#d6e2ee;font-size:11px;padding:0 6px;" placeholder="留空则每次询问">' +
              '<button id="enSetDlPick" class="secondary mini">浏览…</button>' +
            '</div>' +
            '<div style="display:flex;gap:7px;justify-content:flex-end;">' +
              '<button id="enSetCancel" class="secondary mini">取消</button>' +
              '<button id="enSetOk" class="primary mini">保存</button>' +
            '</div>';

        mask.appendChild(box);
        document.body.appendChild(mask);

        var it = document.getElementById('enSetTemp');
        var idd = document.getElementById('enSetDl');
        it.value = cur.temp || '';
        idd.value = cur.download || '';

        function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }

        document.getElementById('enSetTempPick').addEventListener('click', function () {
            H.pickFolder('选择导出临时目录').then(function (d) { if (d) it.value = d; });
        });
        document.getElementById('enSetDlPick').addEventListener('click', function () {
            H.pickFolder('选择下载目录').then(function (d) { if (d) idd.value = d; });
        });
        document.getElementById('enSetCancel').addEventListener('click', close);
        document.getElementById('enSetOk').addEventListener('click', function () {
            saveDirs({ temp: (it.value || '').trim(), download: (idd.value || '').trim() });
            close();
            log('设置已保存');
        });
        mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
    }

    // 取导出目录：优先用设置里的，没设置才弹选择框
    function ensureTempDir() {
        var d = loadDirs();
        if (d.temp) return Promise.resolve(d.temp);
        return H.pickFolder('选择超分导出临时目录').then(function (dir) {
            if (!dir) throw new Error('未选择导出目录');
            // 顺手记住，下次不问了
            d.temp = dir;
            saveDirs(d);
            return dir;
        });
    }
    function ensureDownloadDir() {
        var d = loadDirs();
        if (d.download) return Promise.resolve(d.download);
        return H.pickFolder('选择保存目录').then(function (dir) {
            if (!dir) return '';
            d.download = dir;
            saveDirs(d);
            return dir;
        });
    }

    // ---------- 渲染预设 ----------
    function loadPresets() {
        if (!H || !H.renderPresets) return;
        H.renderPresets().then(function (r) {
            if (!el.enPreset) return;
            var list = [];
            if (r && r.ok) list = Array.isArray(r.data) ? r.data : [];
            el.enPreset.innerHTML = '<option value="">自动（首个预设）</option>';
            list.forEach(function (name) {
                var o = document.createElement('option');
                o.value = name;
                o.textContent = name;
                el.enPreset.appendChild(o);
            });
        }).catch(function () {});
    }

    // ---------- 读取区间（片段 / 游标）----------
    var rangeInfo = null;   // { mode, name, startSec, durationSec, timeline }

    function grabRange() {
        if (!H || !H.rangeInfo) {
            if (el.enClipInfo) el.enClipInfo.textContent = '宿主桥不支持读取区间';
            return;
        }
        var mode = el.enClipSrc ? el.enClipSrc.value : 'clip';
        if (el.enClipInfo) {
            el.enClipInfo.className = 'en-clip-info';
            el.enClipInfo.textContent = '正在读取…';
        }
        H.rangeInfo(mode).then(function (r) {
            if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
            var d = r.data || {};
            rangeInfo = d;
            if (el.enClipInfo) {
                el.enClipInfo.className = 'en-clip-info en-clip-ok';
                el.enClipInfo.textContent = '✅ ' + (d.name || '片段') + ' · ' +
                    (d.durationSec || 0).toFixed(2) + ' 秒 · @' +
                    (d.startSec || 0).toFixed(2) + 's' +
                    (d.timeline ? (' · ' + d.timeline) : '');
                el.enClipInfo.title = el.enClipInfo.textContent;
            }
            log('读取区间：' + (d.name || '') + ' ' + (d.durationSec || 0).toFixed(2) + ' 秒');
        }).catch(function (e) {
            rangeInfo = null;
            if (el.enClipInfo) {
                el.enClipInfo.className = 'en-clip-info';
                el.enClipInfo.textContent = '⚠ ' + (e.message || e);
                el.enClipInfo.title = el.enClipInfo.textContent;
            }
        });
    }

    // ---------- 导出 + 上传主流程 ----------
    function runOne(seqName) {
        var mode = el.enMode ? el.enMode.value : 'enhance';
        var res = el.enRes ? el.enRes.value : '720p';
        var folder = el.enFolder ? el.enFolder.value : '';

        // 若已读取区间且属于这条时间线，只渲染该区间
        var useRange = rangeInfo && rangeInfo.timeline === seqName;
        var tag = useRange
            ? (seqName + ' [' + (rangeInfo.startSec || 0).toFixed(2) + 's + ' +
               (rangeInfo.durationSec || 0).toFixed(2) + 's]')
            : seqName;

        setProg(0, '准备导出 ' + tag + '…');
        log('开始处理：' + tag + '（' + mode + ' / ' + res + '）');

        return ensureTempDir().then(function (dir) {
            var outDir = dir + '/_upscale_src';
            setProg(2, '正在渲染导出…');
            exportStartedAt = Date.now();
            var presetName = (el.enPreset && el.enPreset.value) || '';
            var ver = { name: seqName, outDir: outDir, preset: presetName, enabled: true };
            if (useRange) {
                ver.range = { startSec: rangeInfo.startSec || 0, durationSec: rangeInfo.durationSec || 0 };
            }
            return H.exportStart({
                items: [{ timeline: seqName, versions: [ver] }],
                deleteJob: true,
                openDeliver: false
            });
        }).then(function (r) {
            if (!r || !r.ok) throw new Error('导出失败：' + ((r && r.error) || ''));
            log('导出任务已提交，等待渲染完成…');
            return waitExport();
        }).then(function (dirs) {
            if (!dirs.length) throw new Error('导出没有产出文件');
            // 扫目录找真实产物（导出不返回完整路径）
            var d0 = dirs[0];
            return H.findLatestVideo(d0.dir, exportStartedAt).then(function (f) {
                if (!f || !f.ok) throw new Error('导出目录里没找到视频文件：' + d0.dir);
                return f.data || f;
            });
        }).then(function (info) {
            lastExportPath = info.path;
            log('导出完成：' + info.path + '（' + (info.size ? Math.round(info.size / 1048576) + 'MB' : '') + '）');
            setProg(20, '正在上传到超分站…');
            var args = mode === 'erase'
                ? ['erase', '--file', lastExportPath, '--folder', folder]
                : ['upload', '--file', lastExportPath, '--folder', folder, '--resolution', res];
            return H.pyEnhance(args);
        }).then(function (r) {
            if (!r || !r.ok) throw new Error('上传失败：' + ((r && r.error) || ''));
            var d = r.data || {};
            curTask = { file: lastExportPath, taskId: d.taskId || d.ID || d.id || '' };
            log('已提交任务：' + (curTask.taskId || '(未知ID)'));
            setProg(45, '已提交，等待云端处理…');
            loadTasks();
            return curTask;
        });
    }

    // 轮询导出状态直到完成
    function waitExport() {
        return new Promise(function (resolve, reject) {
            var t0 = Date.now();
            function tick() {
                if (!busy) { reject(new Error('已取消')); return; }
                H.exportState().then(function (r) {
                    if (!r || !r.ok) { setTimeout(tick, 1500); return; }
                    var s = r.data || {};
                    var pct = s.percent || 0;
                    setProg(2 + pct * 0.18, '渲染中 ' + Math.round(pct) + '%');
                    if (!s.running) {
                        var results = s.results || [];
                        var ok = results.filter(function (x) { return x.ok; });
                        // 导出结果只有 outDir + fileName（fileName 常无扩展名），
                        // 所以返回目录，交给后面扫真实产物文件。
                        var out = [];
                        ok.forEach(function (x) {
                            if (x.outDir) out.push({ dir: x.outDir, base: x.fileName || '' });
                        });
                        resolve(out);
                        return;
                    }
                    if (Date.now() - t0 > 3 * 3600 * 1000) { reject(new Error('导出超时')); return; }
                    setTimeout(tick, 1500);
                }).catch(function () { setTimeout(tick, 2000); });
            }
            setTimeout(tick, 1200);
        });
    }

    function startBatch() {
        if (busy) return;
        var seqs = pickedSeqs();
        if (!seqs.length) { alert('请先勾选要处理的时间线'); return; }
        busy = true;
        if (el.enGo) el.enGo.disabled = true;
        if (el.enStop) el.enStop.disabled = false;

        var i = 0;
        function next() {
            if (!busy || i >= seqs.length) {
                busy = false;
                if (el.enGo) el.enGo.disabled = false;
                if (el.enStop) el.enStop.disabled = true;
                setProg(100, '全部完成（' + i + '/' + seqs.length + '）');
                log('批量结束');
                return;
            }
            var name = seqs[i];
            runOne(name).then(function () {
                i++;
                loadTasks();
                next();
            }).catch(function (e) {
                log('失败：' + name + ' · ' + (e.message || e));
                i++;
                next();
            });
        }
        next();
    }

    function stopAll() {
        busy = false;
        if (H && H.exportStop) H.exportStop().catch(function () {});
        if (el.enStop) el.enStop.disabled = true;
        if (el.enGo) el.enGo.disabled = false;
        setProg(0, '已停止');
        log('用户停止');
    }

    function bind() {
        if (el.enRefSeq) el.enRefSeq.addEventListener('click', loadTimelines);
        if (el.enGrabClip) el.enGrabClip.addEventListener('click', grabRange);
        if (el.enSettings) el.enSettings.addEventListener('click', openSettings);
        if (el.enSiteBtn) {
            el.enSiteBtn.addEventListener('click', function () {
                var u = 'http://47.122.108.231:8888/';
                if (H && H.openExternal) { try { H.openExternal(u); return; } catch (e) {} }
                try { window.open(u, '_blank'); } catch (e) {}
            });
        }
        if (el.enGo) el.enGo.addEventListener('click', startBatch);
        if (el.enStop) el.enStop.addEventListener('click', stopAll);
        if (el.enAccount) el.enAccount.addEventListener('click', openAccountDialog);
        if (el.enTaskRefresh) el.enTaskRefresh.addEventListener('click', loadTasks);
        if (el.enMode) {
            el.enMode.addEventListener('change', function () { loadTasks(); });
        }
        if (el.enLogClear) el.enLogClear.addEventListener('click', function () {
            if (el.enLogList) el.enLogList.innerHTML = '';
        });
        if (el.enTaskDlSel) {
            el.enTaskDlSel.addEventListener('click', function () {
                var ids = Array.prototype.slice.call(
                    (el.enTaskList || document).querySelectorAll('.task-cb:checked'))
                    .map(function (x) { return x.value; });
                ids.forEach(function (id, k) { setTimeout(function () { downloadTask(id); }, k * 800); });
            });
        }
    }

    function init() {
        H = window.vhHost;
        bindEls();
        bind();
        loadTimelines();
        loadPresets();
        initSiteFrame();
        checkAccount();
        loadFolders();
        loadTasks();
    }

    // ==================== 内嵌超分站（折叠 / 展开 / 拖拽）====================
    // 与 PR 版一致：导航条 + iframe + 可拖拽高度 + 展开占满面板
    // 该站无 X-Frame-Options，可直接 iframe 内嵌
    var SITE_HOME = 'http://subtitle.zztianqiao.com';

    function initSiteFrame() {
        var panel = document.getElementById('panel-upscale');
        var frame = document.getElementById('upscaleFrame');
        var splitter = document.getElementById('upSplitter');
        var expandBtn = document.getElementById('upExpand');
        if (!panel || !frame || !splitter) return;

        var STORE_H = 'vh_upscale_frame_h';
        var STORE_X = 'vh_upscale_expanded';
        var DEFAULT_H = 240;
        var MIN_TOP = 110;
        var MIN_FRAME = 80;

        var stack = [], idx = -1;

        function clampH(h) {
            var total = panel.clientHeight || 600;
            var max = Math.max(MIN_FRAME, total - MIN_TOP);
            if (h < MIN_FRAME) h = MIN_FRAME;
            if (h > max) h = max;
            return Math.round(h);
        }
        function applyH(h, save) {
            h = clampH(h);
            frame.style.flex = '0 0 ' + h + 'px';
            frame.style.height = h + 'px';
            if (save) { try { localStorage.setItem(STORE_H, String(h)); } catch (e) {} }
            return h;
        }
        function isExpanded() { return panel.classList.contains('en-expanded'); }
        function setExpanded(on, save) {
            if (on) {
                panel.classList.add('en-expanded');
                if (expandBtn) { expandBtn.textContent = '⤡'; expandBtn.title = '还原：恢复操作区'; }
            } else {
                panel.classList.remove('en-expanded');
                if (expandBtn) { expandBtn.textContent = '⤢'; expandBtn.title = '展开：内嵌站占满整个面板'; }
                var saved = parseInt(localStorage.getItem(STORE_H) || DEFAULT_H, 10);
                applyH(isNaN(saved) ? DEFAULT_H : saved, false);
            }
            if (save) { try { localStorage.setItem(STORE_X, on ? '1' : '0'); } catch (e) {} }
        }

        function syncUrl(u) {
            var inp = document.getElementById('upUrl');
            if (inp && u) inp.value = u;
        }
        function go(u, record) {
            var url = String(u || '').trim();
            if (!url) return;
            if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
            frame.src = url;
            syncUrl(url);
            if (record !== false) {
                stack = stack.slice(0, idx + 1);
                stack.push(url);
                idx = stack.length - 1;
            }
        }
        function loadHome() { go(SITE_HOME); }

        // 首次加载
        loadHome();
        // 恢复高度与展开态
        var savedH = parseInt(localStorage.getItem(STORE_H) || DEFAULT_H, 10);
        applyH(isNaN(savedH) ? DEFAULT_H : savedH, false);
        if (localStorage.getItem(STORE_X) === '1') setExpanded(true, false);

        // 拖拽
        var dragging = false, startY = 0, startH = 0;
        function onDown(e) {
            if (isExpanded()) return;
            dragging = true;
            startY = e.clientY;
            startH = frame.getBoundingClientRect().height;
            splitter.classList.add('active');
            document.body.style.cursor = 'row-resize';
            try { e.preventDefault(); } catch (_) {}
            frame.style.pointerEvents = 'none';
        }
        function onMove(e) {
            if (!dragging) return;
            applyH(startH + (startY - e.clientY), false);
            try { e.preventDefault(); } catch (_) {}
        }
        function onUp() {
            if (!dragging) return;
            dragging = false;
            splitter.classList.remove('active');
            document.body.style.cursor = '';
            frame.style.pointerEvents = '';
            try { localStorage.setItem(STORE_H, String(Math.round(frame.getBoundingClientRect().height))); } catch (_) {}
        }
        splitter.addEventListener('mousedown', onDown);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        splitter.addEventListener('dblclick', function () { applyH(DEFAULT_H, true); });

        if (expandBtn) {
            expandBtn.addEventListener('click', function () { setExpanded(!isExpanded(), true); });
        }

        // 导航按钮
        var bBack = document.getElementById('upBack');
        var bFwd = document.getElementById('upFwd');
        var bReload = document.getElementById('upReload');
        var bHome = document.getElementById('btnUpscaleHome');
        var bExt = document.getElementById('upExternal');
        var urlInp = document.getElementById('upUrl');

        if (bBack) bBack.addEventListener('click', function () {
            if (idx > 0) { idx--; frame.src = stack[idx]; syncUrl(stack[idx]); }
        });
        if (bFwd) bFwd.addEventListener('click', function () {
            if (idx < stack.length - 1) { idx++; frame.src = stack[idx]; syncUrl(stack[idx]); }
        });
        if (bReload) bReload.addEventListener('click', function () {
            try { frame.contentWindow.location.reload(); } catch (e) { frame.src = frame.src; }
        });
        if (bHome) bHome.addEventListener('click', loadHome);
        if (bExt) bExt.addEventListener('click', function () {
            var u = (urlInp && urlInp.value) || SITE_HOME;
            if (H && H.openExternal) { try { H.openExternal(u); return; } catch (e) {} }
            try { window.open(u, '_blank'); } catch (e) {}
        });
        if (urlInp) {
            urlInp.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') { ev.preventDefault(); go(urlInp.value); }
            });
        }
    }

    window.__upscalePanel = { init: init };
    window.__upscaleAutoLoad = function () { try { init(); } catch (e) { console.log('[upscale] init 失败', e); } };
})();
