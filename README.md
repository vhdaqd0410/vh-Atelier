# vh-Atelier

Adobe Premiere Pro 本地工作台扩展，集成三大能力，全部本地运行、无需联网：

| 板块 | 功能 | 引擎 |
|------|------|------|
| **字幕识别** | 时间轴音频转字幕（中文/英文/多语言），支持人声分离 | FunASR（中文）+ Whisper large-v3（英文） |
| **语音克隆** | 零样本音色克隆，参考音色合成任意文字 | CosyVoice3 |
| **音效库** | 本地音效扫描 / 搜索 / 试听 / 收藏 / 拖拽插入时间线 | 内置 ffmpeg |

全局热键 `Ctrl+F2` 随时唤起音效搜索浮窗（Spotlight 式），Esc 关闭。

---

## 目录结构

```
com.vh.atelier/
├── CSXS/manifest.xml       扩展清单（3 个 Extension：主面板 + 热键桥 + 搜索浮窗）
├── index.html              主面板 UI（三 tab：字幕识别 / 语音克隆 / 音效库）
├── js/
│   ├── main.js             主面板入口 + tab 切换
│   ├── subtitle.js         字幕识别板块
│   ├── clone.js            语音克隆板块
│   ├── sfx.js              音效库板块（含全局热键设置）
│   ├── wavesurfer.js       音效波形预览
│   └── CSInterface.js      CEP 桥接（Adobe 官方）
├── jsx/host.jsx            ExtendScript 宿主脚本（PR 启动时加载，QE API 桥）
├── bg/                     「热键桥」隐藏面板，spawn 钩子进程 + 广播热键事件
├── search/                 音效搜索浮窗（Modeless，Spotlight 式）
├── keyhook/
│   ├── Program.cs          全局热键钩子源码（C#，.NET Framework 4.x）
│   └── vh_keyhook.exe      编译产物（不入 git，见 .gitignore）
├── bin/ffmpeg-win32-x64.exe
├── py/
│   ├── funasr_cli.py       中文识别 CLI
│   └── cosyvoice_cli.py    语音克隆 CLI
├── models/                 大模型（不入 git，运行时本地回退）
├── stubs/torio_stub/       torchaudio 精简桩（语音克隆依赖）
└── collect/hotkey.json     命令 → 热键映射（运行时写入）
```

---

## 安装与部署

1. 把 `com.vh.atelier` 整个目录复制到：
   `C:\Users\<用户名>\AppData\Roaming\Adobe\CEP\extensions\`
2. 启用开发者调试模式（未签名扩展加载必需）：
   - `regedit` → `HKEY_CURRENT_USER\Software\Adobe\CSXS.6`（无则新建）
   - 新建 `字符串值`，名称 `PlayerDebugMode`，值 `1`
3. 彻底重启 Premiere Pro（`host.jsx` 是 PR 启动时才加载的，改代码必须重启 PR 才生效）。

---

## 三大功能说明

### 1. 字幕识别

- 选择序列（可多选）→ 选语言/识别基准/模型 → 批量识别 → 回写时间轴或导出 SRT
- **中文**用 FunASR（paraformer，断句细、抗噪强，纯 CPU 已比实时快约 30 倍）
- **英文/其他**用 Whisper large-v3（支持 NVIDIA GPU 加速）
- 附带 **人声分离**（Spleeter 本地引擎，无需联网）

### 2. 语音克隆

- 参考音色来源两种：① 时间轴选片段抓取；② 项目素材列表截取片段
- 零样本克隆（CosyVoice3），合成中英文，可调语速 0.5~2.0×
- 模型变体：基础版（音色稳定）/ RL 版（内容准确度更高，官方 CER 0.81 vs 1.21）
- 生成后可试听、导入素材箱、或插入时间线指定轨道（新片段后移、不覆盖）

### 3. 音效库

- 选择音效根目录 → 扫描 → 搜索 / 试听 / 收藏 / 拖拽插入时间线
- 波形预览（wavesurfer），支持子目录过滤
- 全局热键设置：在音效库板块可改「音效搜索」热键（默认 `Ctrl+F2`）

---

## 全局热键机制

```
PR 启动
  └─ bg 隐藏面板加载（AutoVisible=false, StartOn=ApplicationInitialized）
       └─ spawn keyhook/vh_keyhook.exe
            └─ stdout 输出 JSON（ready / hotkey / error）
                 └─ bg.js 解析 → dispatch 命令 → requestOpenExtension 唤起搜索浮窗
```

- 命令 → 热键映射存 `collect/hotkey.json`，格式 `{ "map": { "openSearch": "ctrl+f2" } }`
- 主面板保存新热键后广播 `reload`，bg 换键重启钩子进程

### 热键实现要点（架构记录）

- 钩子用 `WH_KEYBOARD_LL` 低级钩子 + **前台窗口门控**（仅 PR/CEPHtmlEngine 前台时响应，避免在其他程序里误触发）
- 回调内**不做同步 IO**：钩子回调只把事件丢进 `ConcurrentQueue`，由独立 `OutputLoop` 线程负责 `Console.WriteLine`（stdout 供 CEP 读取），避免阻塞低级钩子链、拖累其他挂同类钩子的插件
- 热键默认 `Ctrl+F2`，与第三方 Excalibur 的 `Ctrl+Space` 错开

---

## 构建 keyhook.exe

钩子源码 `keyhook/Program.cs`，用系统自带 csc.exe 编译（.NET Framework 4.x，无第三方依赖）：

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /target:exe /optimize /codepage:65001 ^
  /out:keyhook\vh_keyhook.exe keyhook\Program.cs ^
  /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll
```

> `/target:exe`（console）保证 stdout 可被 CEP 读取；编译产物不入 git。

---

## 后端依赖（本地环境要求）

| 引擎 | 位置 | 说明 |
|------|------|------|
| FunASR | `models/funasr/` | 首次运行自动下载（paraformer + VAD + 标点，约 1.2GB），模型缓存走 `MODELSCOPE_CACHE` |
| Whisper large-v3 | `models/*.bin` 或本机部署 | 英文/多语言识别，可选 GPU |
| CosyVoice3 | `D:\cosyvoice3_V30\` | 复用本机 CosyVoice3 工具内的 GPU torch 与模型（路径见 `py/cosyvoice_cli.py` 的 DEFAULT_*） |
| Spleeter | `models/spleeter/` | 人声分离 |
| Python | 系统 PATH 中的 python | 需装 funasr / modelscope 等依赖 |

---

## 已知边界与坑（维护备忘）

- **host.jsx 是 PR 启动时才加载的**，改 JSX 代码必须彻底重启 PR
- **缓存有效性**：音效索引缓存非空但内容全空时会导致「永远搜不到」，读取时必须做有效性检测
- **CEP 6 没有 `hideExtension` API**：Modeless 浮窗唯一可靠的关闭路径是 `closeExtension()`（真卸载），没有「隐藏不卸载」的接口
- **git 命令在沙箱中的问题**：PowerShell 的 `$host` 是保留变量；git 输出在沙箱被吞，需用 Python subprocess + workdir 执行；push 偶发 TLS 错误时加 `-c http.proxy= -c https.proxy=` 绕过代理直连
- **中文路径编码**：PowerShell `Get-Content` 默认编码读 UTF-8 文件会乱码，处理中文路径需显式指定 UTF-8

---

## 版本

- **0.1.4**（当前）：字幕识别 + 语音克隆 + 音效库三板块；全局热键音效搜索浮窗；移除特效/转场功能（由 Excalibur 承担）

## 许可

私有项目，未开源。
