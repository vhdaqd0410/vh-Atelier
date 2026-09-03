# vh-Atelier

Adobe Premiere Pro 本地工作台扩展。从「字幕识别 + 语音克隆」起步，逐步集成了音效库、多版本导出、字幕校对、音乐、视频下载等能力，形成覆盖剪辑工作流的 7 板块工具台。

| 板块 | 功能 | 引擎 | 联网 |
|------|------|------|------|
| **字幕识别** | 时间轴音频转字幕（中/英/多语言），支持人声分离 | FunASR（中文）+ Whisper large-v3（英文） | 否 |
| **语音克隆** | 参考音色 + 任意文字合成（中英文），可调语速 | CosyVoice3（本机 GPU） | 否 |
| **音效库** | 本地音效扫描/搜索/收藏/拖拽插入时间线，全局热键 `Ctrl+F2` 唤起搜索浮窗 | 内置 ffmpeg | 否 |
| **音乐** | 网易云音乐内嵌：扫码登录/歌单/搜索/试听/下载 | ncm-server 本地代理 | 是 |
| **多版本导出** | 一键批量导出序列的多个交付版本（成片/无字幕/无音乐无字幕） | PR 原生 `exportAsMediaDirect` | 否 |
| **字幕校对** | SRT 与剧本 docx 全局词级对齐，定位听错/漏词/幻觉重复，打勾一键回写 | Python 标准库（difflib） | 否 |
| **字幕翻译**（校对板块内） | 校对后英译中，中文轨或双语轨（英文+中文同条），作剧情理解参考 | MyMemory 免费接口 | 是 |
| **视频下载** | 抖音/B站/YouTube 多平台视频下载，下载并导入一键 | yt-dlp | 是 |

> 联网标注：音乐（网易云）、翻译（MyMemory）、视频下载（yt-dlp）三类功能需要联网；其余本地运行。

全局热键 `Ctrl+F2` 随时唤起音效搜索浮窗（Spotlight 式），Esc 关闭。

---

## 目录结构

```
com.vh.atelier/
├── CSXS/manifest.xml       扩展清单（3 个 Extension：主面板 + 热键桥 + 搜索浮窗）
├── index.html              主面板 UI（7 tab：字幕识别/语音克隆/音效库/音乐/多版本导出/字幕校对/视频下载）
├── js/
│   ├── main.js             主面板入口 + tab 切换
│   ├── utils.js            共享工具（SRT 解析/生成、HTML 转义、Python 探测）
│   ├── translate.js        共享翻译引擎（英译中，识别/校对两板块共用）
│   ├── subtitle.js         字幕识别板块
│   ├── clone.js            语音克隆板块
│   ├── sfx.js              音效库板块（含全局热键设置）
│   ├── export.js           多版本导出板块（从 com.delivery.multiexport 整合而来）
│   ├── check.js            字幕校对板块 + 翻译入口（SRT ↔ 剧本 docx 对齐）
│   ├── music.js            网易云音乐板块
│   ├── video.js            视频下载板块
│   ├── wavesurfer.js       音效波形预览
│   └── CSInterface.js      CEP 桥接库
├── jsx/host.jsx            ExtendScript 宿主脚本（ws/vc/sfx/me/music/video/ck 前缀函数）
├── bg/                     热键桥隐藏面板（spawn 钩子进程 + 广播热键事件）
├── search/                 音效搜索浮窗（Modeless，拖拽插入）
├── keyhook/                全局热键钩子（C# 源码 + 编译产物，不入 git）
├── bin/ffmpeg-win32-x64.exe
├── py/
│   ├── funasr_cli.py       中文识别 CLI
│   ├── cosyvoice_cli.py    语音克隆 CLI
│   └── subtitle_check.py   字幕校对引擎（docx 解析 + 词级对齐）
├── models/                 大模型（不入 git，运行时本地回退）
├── stubs/torio_stub/       torchaudio 精简桩（语音克隆依赖）
├── ncm/                    ncm-server 本地服务（网易云）
├── video/                  yt-dlp 下载服务
└── collect/hotkey.json     命令 → 热键映射（运行时生成）
```

---

## 开发约定（重要）

### 源码目录 vs PR 安装目录

- **源码目录**：`outputs\vh-Atelier\com.vh.atelier\`（开发改这里）
- **安装目录**：`%APPDATA%\Adobe\CEP\extensions\com.vh.atelier\`（PR 实际加载这里）
- 改完源码**必须同步**到安装目录，否则 PR 里看不到改动。一键同步脚本：
  - `sync-to-pr.py`（命令行）或 `sync-to-pr.pyw`（双击弹窗），位于 `outputs\vh-Atelier\`
  - 脚本把 `com.vh.atelier\` 整目录镜像到安装目录，排除 `.git/_tmp/_releases/ncm-server` 与 `.log/.pyc`
  - 运行中被 PR 占用的 exe/dll 会跳过，不影响功能更新
  - **同步方向以源码为准**：安装目录里源码没有的文件会被删除，勿在安装目录里直接改

### 共享模块

- `js/utils.js`（`window.__vhUtils`）：SRT 解析/生成、HTML 转义、Python 探测等纯函数
- `js/translate.js`（`window.__translateBridge`）：英译中翻译引擎，识别/校对两板块共用
- 新增跨板块共享代码时优先放这里；各板块内部函数保持 IIFE 私有

### 脚本加载顺序（index.html 底部）

`CSInterface.js → main.js → utils.js → translate.js → subtitle.js → clone.js → wavesurfer.js → sfx.js → music.js → export.js → check.js → video.js`

依赖关系：utils/translate 必须先于使用它们的板块加载。

### 安装与调试

1. 把 `com.vh.atelier` 复制到 `%APPDATA%\Adobe\CEP\extensions\`
2. 注册表 `HKEY_CURRENT_USER\Software\Adobe\CSXS.6` 建 `PlayerDebugMode` = `1`（未签名扩展必需）
3. **改 JSX 必须彻底重启 PR**（host.jsx 是 PR 启动时才加载）；改前端 js/html 重开面板即可

---

## 各功能说明

### 1. 字幕识别

选序列（可多选）→ 批量识别。中文用 FunASR（paraformer，断句细、抗噪强，纯 CPU 已比实时快 30 倍），英文/其他用 Whisper large-v3（支持 NVIDIA GPU 加速）。识别后可直接校对或导出 SRT。

### 2. 语音克隆

参考音色来源：① 时间轴选片段抓取；② 项目素材列表截取。合成中英文，可调语速 0.5~2.0×。模型变体：基础版（音色稳定）与 RL 版（准确度更高）。

### 3. 音效库

选根目录 → 扫描 → 搜索/收藏/子目录过滤 → 点击导入 / 拖拽插入时间线。虚拟列表 + 波形预览，上万文件不卡。热键可在板块内改（默认 `Ctrl+F2`）。

### 4. 音乐（网易云）

扫码登录 → 歌单/搜索 → 试听/下载 → 可选导入素材箱。走本地 ncm-server 代理。

### 5. 多版本导出

选序列 → 配置交付版本（可增删，每个版本独立：名称/导出预设/音轨静音策略/输出目录）→ 一键串行导出 → 生成交付清单 CSV。默认三个版本：成片（有字幕）、无字幕版、无音乐无字幕版。

### 6. 字幕校对 + 翻译

- 选 SRT（识别板块联动或独立选文件）+ 剧本 docx + 集数 → 开始校对
- 全局词级对齐（剧本台词词流 ↔ 字幕词流），归一化减小假阳性
- 三类差异：听错/漏词/多余，带时间戳逐条打勾
- 一键应用：改写听错词、补齐漏词、删除重复，回写字幕轨
- **翻译**：校对后逐条英译中（MyMemory 免费接口），可选「翻译成中文」单语轨或「导入双语字幕」中英同条轨，作剧情理解参考，不进成片。翻译也支持在识别板块直接对识别结果使用，无需先校对。

### 7. 视频下载

粘贴链接（支持抖音/B站分享文案自动提取）→ 解析 → 下载 → 可一键导入 PR。内置 yt-dlp，批量下载 + 历史记录。

---

## 全局热键机制

```
PR 启动 → bg 隐藏面板加载（AutoVisible=false, StartOn=ApplicationInitialized）
       → spawn keyhook/vh_keyhook.exe → stdout 输出 JSON（ready/hotkey/error）
       → bg 收到 hotkey → requestOpenExtension 唤起搜索浮窗
```

- 钩子用 `WH_KEYBOARD_LL` + 前台窗口门控（仅 PR/CEPHtmlEngine 前台时响应）
- 回调不做同步 IO：事件进 `ConcurrentQueue`，独立线程负责 stdout，避免阻塞低级钩子链
- 命令 → 热键映射存 `collect/hotkey.json`，格式 `{ "map": { "openSearch": "ctrl+f2" } }`

---

## 构建 keyhook.exe

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe ^
  /target:exe /optimize /codepage:65001 ^
  /out:keyhook\vh_keyhook.exe keyhook\Program.cs ^
  /r:System.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll
```

编译产物不入 git。

---

## 已知边界与坑（维护备忘）

- **host.jsx 是 PR 启动时才加载的**，改 JSX 必须彻底重启 PR
- **同步脚本方向以源码为准**，勿在安装目录直接改代码
- **缓存有效性**：音效索引缓存非空但内容全空时会导致「永远搜不到」，读取时必须做有效性检测
- **CEP 6 没有 `hideExtension` API**：Modeless 浮窗唯一可靠的关闭路径是 `closeExtension()`（真卸载）
- **git 命令在沙箱中的问题**：PowerShell 的 `$host` 是保留变量；git 输出在沙箱被吞，需用 Python subprocess + workdir 执行；push 偶发 TLS 错误时加 `-c http.proxy= -c https.proxy=` 绕过代理直连
- **中文路径编码**：PowerShell `Get-Content` 默认编码读 UTF-8 文件会乱码，处理中文路径需显式 UTF-8
- **多版本导出「浏览…」按钮**：依赖 `jsx/folderpicker.ps1`，PowerShell 命令里 `-ExecutionPolicy` 参数必须是干净 ASCII

---

## 版本

- **0.2.1**（当前）：翻译引擎收拢为共享模块（translate.js），识别/校对两板块统一并补齐双语轨；新增 utils.js 共享工具（消重复）；manifest 版本与功能对齐；README 重写
- 0.2.0：网易云音乐板块（扫码登录/歌单/试听/下载）；此前含字幕校对 v0.1.8 系列优化
- 0.1.6：新增字幕校对板块
- 0.1.5：多版本导出板块（从 com.delivery.multiexport 整合）
- 0.1.4：字幕识别 + 语音克隆 + 音效库；全局热键浮窗

## 许可

私有项目，未开源。
