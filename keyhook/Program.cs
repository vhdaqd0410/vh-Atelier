// vh_keyhook.exe 源码
// 全局键盘钩子：监听一个可配置热键（默认 Alt+Space），按下时把 JSON 打到 stdout。
// 由隐藏 CEP 面板 spawn 并读取 stdout，再广播给 vh-Atelier 面板。
// 用法：vh_keyhook.exe [组合键表达式]  [appName]
//   组合键表达式支持: ctrl / shift / alt / win 修饰 + 主键
//   示例: "alt+space"  "ctrl+f9"  "ctrl+shift+k"
//   参数省略时默认 alt+space
//   appName 仅用于输出展示，可省略
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

        static int _mainKey = 0x20;                 // 默认 space
        static List<int> _modKeys = new List<int>();
        static string _comboText = "alt+space";
        static bool _fired = false;

        static void Main(string[] args)
        {
            if (args.Length >= 1 && !string.IsNullOrEmpty(args[0]))
            {
                try { ParseCombo(args[0]); } catch { /* 解析失败用默认 */ }
            }

            string appName = args.Length >= 2 ? args[1] : "";
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

            // 心跳，让宿主知道钩子已就绪
            Console.WriteLine("{\"type\":\"ready\",\"combo\":\"" + _comboText + "\"}");
            Console.Out.Flush();

            // 消息循环，保持进程存活
            System.Windows.Forms.Application.Run();
            UnhookWindowsHookEx(_hook);
        }

        static void ParseCombo(string s)
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
            if (main == 0) throw new Exception("no main key");
            _mainKey = main;
            _modKeys = mods;
            var sb = new StringBuilder();
            foreach (var m in mods)
            {
                if (sb.Length > 0) sb.Append("+");
                sb.Append(m == 0xA2 ? "ctrl" : m == 0xA0 ? "shift" : m == 0xA4 ? "alt" : "win");
            }
            if (sb.Length > 0) sb.Append("+");
            sb.Append(mainName);
            _comboText = sb.ToString();
        }

        static bool ModsDown()
        {
            foreach (var m in _modKeys)
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
                if (info.vkCode == _mainKey && ModsDown())
                {
                    if (!_fired)
                    {
                        _fired = true;
                        Console.WriteLine("{\"type\":\"hotkey\",\"combo\":\"" + _comboText + "\",\"key\":" + info.vkCode + ",\"time\":" + DateTimeOffset.Now.ToUnixTimeMilliseconds() + "}");
                        Console.Out.Flush();
                    }
                }
                else
                {
                    _fired = false;
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
