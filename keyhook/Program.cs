// vh_keyhook.exe 源码（多热键版）
// 全局键盘钩子：监听多个可配置热键，每个热键带一个命令 id。
// 命中时把 JSON 打到 stdout，由隐藏 CEP 面板 spawn 读取并广播给 vh-Atelier 面板。
// 用法：vh_keyhook.exe [id=combo] [id=combo] ...
//   每个参数形如 "openSearch=ctrl+f2"；左边是命令 id，右边是组合键表达式。
//   组合键表达式支持: ctrl / shift / alt / win 修饰 + 主键（字母/数字/F1-F12/方向键等）。
//   若参数不含 '='（向后兼容旧版），视为 id=openSearch 的组合键。
//   示例: vh_keyhook.exe "openSearch=ctrl+f2" "applyEffect=ctrl+f3"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

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

        delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x0100;
        const int WM_SYSKEYDOWN = 0x0104;

        static LowLevelKeyboardProc _proc;
        static IntPtr _hook = IntPtr.Zero;

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

            // 一个都没有：给默认 openSearch=alt+space
            if (_hotkeys.Count == 0)
            {
                _hotkeys.Add(ParseCombo("openSearch", "alt+space"));
            }

            Console.OutputEncoding = Encoding.UTF8;

            _proc = HookCallback;
            using (System.Diagnostics.Process cur = System.Diagnostics.Process.GetCurrentProcess())
            using (System.Diagnostics.ProcessModule mod = cur.MainModule)
            {
                _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(mod.ModuleName), 0);
            }

            if (_hook == IntPtr.Zero)
            {
                Console.WriteLine("{\"type\":\"error\",\"msg\":\"hook failed\"}");
                Console.Out.Flush();
                return;
            }

            // 心跳：列出所有已注册热键
            var readyList = new StringBuilder();
            foreach (var hk in _hotkeys)
            {
                if (readyList.Length > 0) readyList.Append(",");
                readyList.Append("\"" + hk.Id + "\":\"" + hk.ComboText + "\"");
            }
            Console.WriteLine("{\"type\":\"ready\",\"hotkeys\":{" + readyList.ToString() + "}}");
            Console.Out.Flush();

            // 消息循环，保持进程存活
            System.Windows.Forms.Application.Run();
            UnhookWindowsHookEx(_hook);
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

        static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN))
            {
                KBDLLHOOKSTRUCT info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                foreach (var hk in _hotkeys)
                {
                    if (info.vkCode == hk.MainKey && ModsDown(hk))
                    {
                        if (!hk.Fired)
                        {
                            hk.Fired = true;
                            Console.WriteLine("{\"type\":\"hotkey\",\"id\":\"" + hk.Id + "\",\"combo\":\"" + hk.ComboText + "\",\"key\":" + info.vkCode + ",\"time\":" + DateTimeOffset.Now.ToUnixTimeMilliseconds() + "}");
                            Console.Out.Flush();
                        }
                    }
                    else
                    {
                        hk.Fired = false;
                    }
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
