// vh-Atelier · 缺失字体安装（PR 版本转换配套）
// ==========================================================================
// 背景：PR 2021 不支持可变字体（Variable Font）。
//   Windows 自带的 Bahnschrift 是可变字体，PR2025 能把它的 15 个实例
//   展开成一个列表供选择；PR2021 只认「一个字体文件 = 一个字体」。
//   所以高版本样式里存的 "Bahnschrift-Bold" 在 PR2021 里找不到 → 报缺失。
//
// 解法：从可变字体里「固化」出 Bold 那一档，做成独立的静态字体装上。
//   字体已随插件附带（assets/fonts/Bahnschrift-Bold.ttf），
//   目标机器只需拷贝 + 注册，不需要 fontTools、不需要联网。
//
// 安装位置：用户级字体目录（免管理员）
//   %LOCALAPPDATA%\Microsoft\Windows\Fonts\ + HKCU 注册表
//
// 注意：字体会在 PR 重启后生效（PR 只在启动时扫描字体表）。
(function () {
    var fs, path, os, cp;
    try {
        fs = require('fs');
        path = require('path');
        os = require('os');
        cp = require('child_process');
    } catch (e) { return; }

    var csInterface = (typeof CSInterface !== 'undefined') ? new CSInterface() : null;

    function extRoot() {
        try {
            if (csInterface) {
                var r = csInterface.getSystemPath('extension');
                if (r && fs.existsSync(r)) return r;
            }
        } catch (e) {}
        try {
            var d = (typeof __dirname !== 'undefined') ? __dirname : '';
            if (d) return (path.basename(d).toLowerCase() === 'js') ? path.dirname(d) : d;
        } catch (e) {}
        return '';
    }

    var ROOT = extRoot();

    // 随插件附带的字体（文件名固定）
    var FONT_ASSET = ROOT ? path.join(ROOT, 'assets', 'fonts', 'Bahnschrift-Bold.ttf') : '';
    // 安装后的文件名
    var FONT_FILE = 'BahnschriftBold-Custom.ttf';
    // 注册表里显示的名字（必须与字体内部 Family 名一致，Windows 才能正确识别）
    var REG_NAME = 'Bahnschrift Bold (TrueType)';

    function userFontDir() {
        var la = process.env.LOCALAPPDATA || '';
        if (!la) la = path.join(os.homedir(), 'AppData', 'Local');
        return path.join(la, 'Microsoft', 'Windows', 'Fonts');
    }

    function installedPath() {
        return path.join(userFontDir(), FONT_FILE);
    }

    function regKey() {
        return 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';
    }

    // ---------- 状态查询 ----------
    function status() {
        var p = installedPath();
        var out = { hasAsset: false, installed: false, file: p, reg: false, asset: FONT_ASSET };
        try { out.hasAsset = !!(FONT_ASSET && fs.existsSync(FONT_ASSET)); } catch (e) {}
        try { out.installed = fs.existsSync(p); } catch (e) {}
        try {
            var r = cp.spawnSync('reg', ['query', regKey(), '/v', REG_NAME],
                                 { windowsHide: true, encoding: 'buffer' });
            out.reg = (r.status === 0);
        } catch (e) {}
        return out;
    }

    function regAdd(value) {
        try {
            var r = cp.spawnSync('reg', ['add', regKey(), '/v', REG_NAME,
                                         '/t', 'REG_SZ', '/d', value, '/f'],
                                 { windowsHide: true, encoding: 'buffer' });
            return r.status === 0;
        } catch (e) { return false; }
    }

    function regDel() {
        try {
            var r = cp.spawnSync('reg', ['delete', regKey(), '/v', REG_NAME, '/f'],
                                 { windowsHide: true, encoding: 'buffer' });
            return r.status === 0;
        } catch (e) { return false; }
    }

    // 让字体尽快生效（New-Process 免重启不一定成功，多数应用仍需重启）
    // 这里用 PowerShell 调 Win32 API：AddFontResourceW + PostMessage 广播
    // 注意：广播必须用 PostMessage（异步），SendMessage 会等待所有窗口而卡死
    function notifyFontChange(file) {
        var ps = [
            'Add-Type -TypeDefinition @"',
            'using System;',
            'using System.Runtime.InteropServices;',
            'public static class VhFont {',
            '  [DllImport("gdi32.dll", CharSet=CharSet.Unicode)]',
            '  public static extern int AddFontResourceW(string p);',
            '  [DllImport("user32.dll", CharSet=CharSet.Unicode)]',
            '  public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);',
            '}',
            '"@',
            '$n = [VhFont]::AddFontResourceW("' + file.replace(/"/g, '""') + '")',
            '[VhFont]::PostMessageW([IntPtr]0xFFFF, 0x001D, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null',
            'Write-Output $n'
        ].join('\n');
        try {
            var r = cp.spawnSync('powershell', ['-NoProfile', '-Command', ps],
                                 { windowsHide: true, encoding: 'buffer', timeout: 30000 });
            var t = (r.stdout || Buffer.alloc(0)).toString('latin1').trim();
            return { ok: r.status === 0, n: t };
        } catch (e) {
            return { ok: false, n: '', err: e.message };
        }
    }

    // ---------- 安装 ----------
    function install() {
        if (!FONT_ASSET || !fs.existsSync(FONT_ASSET)) {
            return { ok: false, msg: '插件里没找到字体文件：' + (FONT_ASSET || '(路径未知)') };
        }
        var dir = userFontDir();
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
            return { ok: false, msg: '无法创建字体目录：' + e.message };
        }
        var dst = installedPath();
        try {
            fs.copyFileSync(FONT_ASSET, dst);
        } catch (e) {
            return { ok: false, msg: '拷贝字体失败：' + e.message };
        }
        var regOk = regAdd(dst);
        var notify = notifyFontChange(dst);
        return {
            ok: true,
            file: dst,
            reg: regOk,
            notify: notify.ok ? '已通知系统刷新' : '已装（刷新通知失败，重启后照样生效）',
            msg: '字体已安装：Bahnschrift Bold'
        };
    }

    // ---------- 卸载 ----------
    function uninstall() {
        var dst = installedPath();
        var removed = false;
        try {
            if (fs.existsSync(dst)) { fs.unlinkSync(dst); removed = true; }
        } catch (e) {
            return { ok: false, msg: '删除字体文件失败（PR 可能正在使用）：' + e.message };
        }
        regDel();
        return { ok: true, removed: removed, msg: '已卸载 Bahnschrift Bold（重启后彻底生效）' };
    }

    window.__vhFont = {
        status: status,
        install: install,
        uninstall: uninstall,
        assetPath: function () { return FONT_ASSET; },
        installPath: installedPath
    };
})();
