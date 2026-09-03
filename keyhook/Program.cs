// vh_keyhook.exe 源码
// 全局键盘钩子：监听可配置热键，但仅在 Adobe Premiere Pro（或其 CEP 面板）处于前台时才响应。
// 命中时消息通过独立输出线程写入 stdout，钩子回调内不做任何阻塞 IO，
// 避免拖慢系统输入链、干扰 spell_win.exe 等其他全局钩子（根治白屏 / Ex 呼不出）。
// 用法：vh_keyhook.exe [id=combo] [id=combo] ...
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace VhKeyHook
{
    class Program
    {
        // ---- Win32 API ----
        [DllImport("user32.dll")]
        static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll")]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        static extern uint GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x0100;
        const int WM_SYSKEYDOWN = 0x0104;

        static LowLevelKeyboardProc _proc;
        static IntPtr _hook = IntPtr.Zero;

        // ---- 输出线程：钩子回调只入队，这里才写 stdout，杜绝输入线程阻塞 ----
        static ConcurrentQueue<string> _outQueue = new ConcurrentQueue<string>();
        static AutoResetEvent _outSignal = new AutoResetEvent(false);
        static volatile bool _outputRunning = true;

        // ---- 前台窗口进程缓存：只在 PR 主窗口前台时响应（CEP 面板不算，避免干扰其他钩子） ----
        static IntPtr _lastFg = IntPtr.Zero;
        static bool _lastInPr = false;
        static HashSet<string> _prProcessNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Adobe Premiere Pro"
            // 注意：CEPHtmlEngine（CEP 面板）不在此列，这样搜索浮窗打开时全局钩子不响应，
            // 避免与 Excalibur/Spellbook 等其他全局键盘钩子冲突。
        };

        // 修饰键 / 主键映射
        static Dictionary<string, int> modifiers = new Dictionary<string, int>()
        {
            { "ctrl", 0xA2 }, { "control", 0xA2 }, { "shift", 0xA0 }, { "alt", 0xA4 }, { "win", 0x5B }, { "cmd", 0x5B }
        };

        static Dictionary<string, int> keys = new Dictionary<string, int>()
        {
            { "space", 0x20 }, { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 },
            { "f5", 0x74 }, { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 },
            { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B }, { "enter", 0x0D }, { "tab", 0x09 },
            { "esc", 0x1B }, { "backspace", 0x08 }, { "delete", 0x2E }, { "home", 0x24 }, { "end", 0x23 },
            { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 }, { "pgup", 0x21 }, { "pgdn", 0x22 }
        };

        // 单个热键定义
        class Hotkey
        {
            public string Id;
            public int MainKey;
            public List<int> ModKeys = new List<int>();
            public string ComboText;
            public bool Fired;
        }

        static List<Hotkey> _hotkeys = new List<Hotkey>();

        static void Main(string[] args)
        {
            // 解析参数：每个参数 "id=combo"；不含 '=' 的参数视为 openSearch
            if (args != null && args.Length >= 1)
            {
                foreach (var a in args)
                {
                    if (string.IsNullOrEmpty(a)) continue;
                    string id, comboExpr;
                    int eq = a.IndexOf('=');
                    if (eq >= 0)
                    {
                        id = a.Substring(0, eq).Trim();
                        comboExpr = a.Substring(eq + 1).Trim();
                    }
                    else
                    {
                        id = "openSearch";
                        comboExpr = a.Trim();
                    }
                    if (id.Length == 0 || comboExpr.Length == 0) continue;
                    Hotkey hk = ParseCombo(id, comboExpr);
                    if (hk != null) _hotkeys.Add(hk);
                }
            }

            // 一个都没有：给默认 openSearch=ctrl+f2
            if (_hotkeys.Count == 0)
            {
                _hotkeys.Add(ParseCombo("openSearch", "ctrl+f2"));
            }

            try { Console.OutputEncoding = Encoding.UTF8; } catch (Exception) { }

            // 启动独立输出线程
            Thread outThread = new Thread(OutputLoop);
            outThread.IsBackground = true;
            outThread.Start();

            _proc = HookCallback;
            using (System.Diagnostics.Process cur = System.Diagnostics.Process.GetCurrentProcess())
            using (System.Diagnostics.ProcessModule mod = cur.MainModule)
            {
                _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(mod.ModuleName), 0);
            }

            if (_hook == IntPtr.Zero)
            {
                Enqueue("{\"type\":\"error\",\"msg\":\"hook failed\"}");
                Thread.Sleep(200);
                _outputRunning = false;
                _outSignal.Set();
                return;
            }

            // 心跳：列出所有已注册热键
            var readyList = new StringBuilder();
            foreach (var hk in _hotkeys)
            {
                if (readyList.Length > 0) readyList.Append(",");
                readyList.Append("\"" + hk.Id + "\":\"" + hk.ComboText + "\"");
            }
            Enqueue("{\"type\":\"ready\",\"hotkeys\":{" + readyList.ToString() + "}}");

            // 消息循环，保持进程存活
            System.Windows.Forms.Application.Run();
            UnhookWindowsHookEx(_hook);
            _outputRunning = false;
            _outSignal.Set();
        }

        // 输出线程：从队列取消息写 stdout，避免钩子回调阻塞
        static void OutputLoop()
        {
            while (_outputRunning)
            {
                _outSignal.WaitOne(200);
                string msg;
                while (_outQueue.TryDequeue(out msg))
                {
                    try
                    {
                        Console.WriteLine(msg);
                        Console.Out.Flush();
                    }
                    catch (Exception) { }
                }
            }
        }

        static void Enqueue(string msg)
        {
            _outQueue.Enqueue(msg);
            _outSignal.Set();
        }

        static Hotkey ParseCombo(string id, string s)
        {
            var parts = s.ToLower().Split('+');
            var mods = new List<int>();
            int main = 0;
            string mainName = "";
            foreach (var p in parts)
            {
                var t = p.Trim();
                if (t.Length == 0) continue;
                if (modifiers.ContainsKey(t)) mods.Add(modifiers[t]);
                else if (keys.ContainsKey(t)) { main = keys[t]; mainName = t; }
                else if (t.Length == 1) { main = (int)char.ToUpper(t[0]); mainName = t.ToUpper(); }
            }
            if (main == 0) return null;

            var hk = new Hotkey();
            hk.Id = id;
            hk.MainKey = main;
            hk.ModKeys = mods;

            var sb = new StringBuilder();
            foreach (var m in mods)
            {
                if (sb.Length > 0) sb.Append("+");
                sb.Append(m == 0xA2 ? "ctrl" : m == 0xA0 ? "shift" : m == 0xA4 ? "alt" : "win");
            }
            if (sb.Length > 0) sb.Append("+");
            sb.Append(mainName);
            hk.ComboText = sb.ToString();
            return hk;
        }

        static bool ModsDown(Hotkey hk)
        {
            foreach (var m in hk.ModKeys)
            {
                if (!IsDown(m)) return false;
            }
            return true;
        }

        static bool IsDown(int vk)
        {
            return (GetAsyncKeyState(vk) & 0x8000) != 0;
        }

        // 判断前台窗口是否属于 PR / CEP 面板
        static bool ForegroundIsPremiere()
        {
            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero) return false;
            if (fg == _lastFg) return _lastInPr;

            uint pid;
            GetWindowThreadProcessId(fg, out pid);
            bool inPr = false;
            try
            {
                using (var p = Process.GetProcessById((int)pid))
                {
                    inPr = _prProcessNames.Contains(p.ProcessName);
                }
            }
            catch (Exception) { inPr = false; }

            _lastFg = fg;
            _lastInPr = inPr;
            return inPr;
        }

        static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN))
            {
                // 非 PR 前台：直接放行，不做任何处理（也不复位 Fired），让全局钩子保持轻量
                if (ForegroundIsPremiere())
                {
                    KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    foreach (var hk in _hotkeys)
                    {
                        if (info.vkCode == hk.MainKey && ModsDown(hk))
                        {
                            if (!hk.Fired)
                            {
                                hk.Fired = true;
                                Enqueue("{\"type\":\"hotkey\",\"id\":\"" + hk.Id + "\",\"combo\":\"" + hk.ComboText + "\",\"key\":" + info.vkCode + ",\"time\":" + DateTimeOffset.Now.ToUnixTimeMilliseconds() + "}");
                            }
                        }
                        else
                        {
                            hk.Fired = false;
                        }
                    }
                }
                else
                {
                    // 前台切换出去时，复位所有 Fired 标记，回来才能再次触发
                    foreach (var hk in _hotkeys) hk.Fired = false;
                }
            }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KBDLLHOOKSTRUCT
        {
            public int vkCode;
            public int scanCode;
            public int flags;
            public int time;
            public IntPtr dwExtraInfo;
        }
    }
}
