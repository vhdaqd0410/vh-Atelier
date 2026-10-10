# vh-Atelier

面向 **AI 漫剧 / 短剧批量制作**的 Adobe Premiere Pro 本地工作台扩展。

十一组工作台覆盖从素材整理到成片交付的完整链路，AI 引擎本地运行、随包分发、装完即用。

> **当前版本 v1.75.3** · 分支 `main` · 扩展 ID `com.vh.atelier` · 菜单名 `vh-Atelier`
>
> 另有精简版 **vh-Atelier A**（`com.vh.ate`，分支 `vh-ate`，菜单名 `vh-Atelier A`）：
> 面向只需要剪辑与交付环节的机器，占用更小。详见 [精简版说明](#精简版-vh-atelier-a)。

---

## 为什么是它

短剧 / 漫剧量产的核心痛点不是剪辑本身，而是**同一件事重复几十遍**：几十集素材逐个导入、字幕逐个识别校对、成品逐版本导出、音效音乐反复找。

vh-Atelier 把这些收进 PR 面板，全部在本机跑：不打断剪辑流、不上传素材、不依赖第三方云服务（少数功能需联网，见下方标注）。

---

## 工作台总览

| 工作台 | 子功能 | 引擎 / 依赖 | 联网 |
|---|---|---|---|
| **🗂 素材** | 素材浏览 · ☁ 网盘 | Node fs + PR 导入 API / 百度网盘 | 网盘需联网 |
| **📖 剧本** | 剧本阅读 | Python docx/pdf 解析 | 否 |
| **进度** | 项目进度 | 视频工作台 API（`127.0.0.1:8089`） | 本机 |
| **📝 待办** | 今日待办 | 本地文件存储 | 否 |
| **✨ 超分** | 去字幕 / 超分（云端）· **本地去字幕** · **本地超分** | 云端 API（自备账号）/ VSR + Real-ESRGAN | 云端需联网 |
| **字幕** | 字幕识别 · 字幕校对 | FunASR + Whisper / Python difflib | 否 |
| **声音** | 人声分离 · 语音克隆 · 音乐库 · 音效库 · 网易云 · 音乐聚合 · 短剧扒歌 | Spleeter / CosyVoice3 / wavesurfer / ncm | 部分需联网 |
| **🎬 审片** | 内嵌分秒帧 | iframe + 内嵌站导航 | **是** |
| **交付** | 多版本导出 · 视频下载 | PR 导出 API / yt-dlp | 下载需联网 |
| **🔧 工具** | PR 版本转换 · 调色 XML · 字体修复 | 纯本地 | 否 |
| **📮 反馈** | 在线反馈 | 自建反馈中心（服务器） | **是** |

**联网项**：云端去字幕/超分、网盘、审片（分秒帧）、网易云音乐、音乐聚合、视频下载、在线反馈与更新。
**其余全部本地运行**，含本地去字幕、本地超分、字幕识别校对、人声分离、语音克隆。

---

## 核心能力

### 本地去字幕 / 本地超分（免费、不上传）

这两个是本版本的重点，全部在本机 GPU 上跑，不花云端费用、素材不出本机。

- **本地去字幕**：基于 VSR（STTN / LaMa / ProPainter 等算法）。支持**截帧可视化框选**字幕区域，框一次可存成**区域预设**跨项目复用；处理完自动做「区域回贴」——只取输出的字幕区，其余像素取自原片，避免整帧重绘造成的画面跳变
- **本地超分**：基于 Real-ESRGAN-ncnn-vulkan（Vulkan 加速，不依赖 CUDA）。默认输出长边 1080，可选 anime / anime4x / photo 三种模型与 2/3/4 倍率

两条链路都带**历史记录**：每条可拖拽进时间轴、导入素材箱、资源管理器定位、播放器打开。

### 多版本交付

一次配置、批量产出。每个版本独立设置导出预设、音轨静音策略、输出目录；整套配置可存为**交付模板**，多项目一键切换。

渲染通道可选 **AME 队列**（交给 Media Encoder 后台跑，PR 不占用）或 **PR 直渲**。AME 模式带版本预检与任务健康检查，版本不配套会明确告警而非静默。

### AI 引擎全部本地

| 引擎 | 用途 |
|---|---|
| **FunASR**（~1.2GB） | 中文语音识别 |
| **Whisper** | 多语言语音识别 |
| **Spleeter**（37MB） | 人声 / 伴奏分离 |
| **CosyVoice3** | 语音克隆合成 |
| **VSR** | 本地去字幕 |
| **Real-ESRGAN**（44MB） | 本地超分 |
| **Sherpa-ONNX** | 离线声源分离 |
| **ffmpeg / yt-dlp** | 音频处理 / 视频下载 |

---

## 安装

### 方式一：一键部署（推荐）

双击部署包里的「**一键部署.bat**」，自动完成：复制扩展目录 → 写 CEP 调试模式注册表 → 配置引擎路径。

### 方式二：手动

1. 把 `com.vh.atelier` 复制到 `%APPDATA%\Adobe\CEP\extensions\`
2. 注册表 `HKEY_CURRENT_USER\Software\Adobe\CSXS.6` 新建 `PlayerDebugMode`（字符串）= `1`
3. 重开 Premiere Pro，菜单「**窗口 → 扩展 → vh-Atelier**」

> 未签名扩展必须开 `PlayerDebugMode`，否则 PR 里看不到菜单项。

---

## 目录结构

```
com.vh.atelier/
├── CSXS/manifest.xml          扩展清单（panel 主面板 + bg 后台桥）
├── index.html                 主面板 UI（工作台导航 + 各功能面板）
├── version.json               版本与分支信息（更新器读取）
├── changelog.json             版本历史（「📋 历史」数据源）
├── js/                        前端逻辑（按面板拆分，见下）
├── jsx/host.jsx               PR 宿主脚本（ExtendScript / ES3）
├── py/                        Python 引擎调用器（由面板 spawn）
├── bg/                        后台桥隐藏面板（拉起本地服务）
├── bin/                       运行时二进制（ffmpeg / yt-dlp / realesrgan / sherpa）
├── models/                    AI 模型（funasr 1.2GB / spleeter 37MB）
├── ncm/                       网易云本地服务
├── video/                     yt-dlp 下载服务
└── collect/                   运行时数据（用户数据，升级不覆盖）
```

**关键目录说明**：
- `bin/` `models/` 是**运行时资源**，不进 git、随部署包分发；在线更新会跳过它们
- `collect/` 是**用户数据**（替换字典、历史记录、区域预设、账号、索引、日志），升级与同步都不会覆盖

---

## 开发与维护

### 源码目录与安装目录是两份

```
源码：  F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier\
安装：  %APPDATA%\Adobe\CEP\extensions\com.vh.atelier\
```

改完源码必须同步（脚本在仓库上一级 `plugins\vh-Atelier\`）：

```
python sync-to-pr.py           镜像同步
python sync-to-pr.py --check   只报告差异
sync-to-pr.pyw                 双击运行的 GUI 版
```

**同步规则**：镜像覆盖，排除 `.git / _tmp / _releases / ncm-server / collect` 与 `.log / .pyc`。
`collect/` 是用户数据，**绝不镜像覆盖**，否则用户积累会被源码样板冲掉。

提交后自动同步：仓库 `tools/hook/post-commit` 已配置，新机器执行 `python tools/install-hook.py` 安装。

### 测试

```
python scripts/run-tests.py          跑全部
python scripts/run-tests.py --list   列出会跑哪些
```

覆盖：回归（628 项，锁历史坑）、本地面板（去字幕 76 项 / 超分 42 项）、AME 通道（32 项）、CSS 作用域（12 项）、公共模块、字幕侧车归位、调色 XML、音乐聚合（含真实渲染）等。

### 共享模块

面板间通过全局对象通信，改这些模块会影响多个面板：

| 模块 | 挂载点 | 职责 |
|---|---|---|
| `js/utils.js` | `window.__vhUtils` | SRT 解析/生成、HTML 转义、Python 探测 |
| `js/translate.js` | `window.__translateBridge` | 英译中（识别/校对共用） |
| `js/en-shared.js` | `window.__vhClip` | 序列选择 + 时间轴区间读取 |
| `js/en-local.js` | `window.__vhLocal` | 本地面板公共逻辑（历史/输出目录/进度/导入） |
| `js/errorlog.js` | `window.__vhLog` | 错误日志 |
| `js/iframe-nav.js` | — | 内嵌站导航 |

### 已知边界

- **`host.jsx` 与 manifest 只在 PR 启动时加载** —— 改 JSX 或扩展列表必须彻底重启 PR；改前端 js/html 只需重开面板
- **ExtendScript 是 ES3** —— `host.jsx` 里不能用 `.trim() / .some() / .forEach()`，去空白用正则
- **CEP 6 没有 `hideExtension`** —— Modeless 浮窗唯一可靠关闭路径是 `closeExtension()`
- **QE 时间字段是 `.secs` 不是 `.seconds`**
- **中文路径编码** —— PowerShell 处理中文路径需显式 UTF-8

---

## 精简版 vh-Atelier A

面向只需要剪辑与交付环节的机器，**去掉进度 / 待办 / 字幕识别校对 / 网盘 / 调色 XML**，占用更小、面板更清爽。

**独有能力**（主版没有）：🏠 首页、项目工作台（NAS 拉素材）、语音授权系统、文字样式转换。

| | vh-Atelier（主版） | vh-Atelier A |
|---|---|---|
| 扩展 ID | `com.vh.atelier` | `com.vh.ate` |
| 分支 | `main` | `vh-ate` |
| 工作台数 | 11 | 9 |
| 进度 / 待办 / 字幕 | ✅ | — |

两版是**独立代码库**，各自更新，改一处不会自动传导到另一处。

---

## 更新机制

插件内置更新器（`js/updater.js`）：

- 打开面板时自动检查（读 `version.json` 比对远端）
- 标题栏「**⬆ 更新**」手动触发，展示跨版本累积变更
- 标题栏「**📋 历史**」查看全部版本记录

**更新只同步代码**（几百 KB），模型、引擎与 `collect/` 用户数据不受影响。
涉及 JSX 的更新需重启 PR。

---

## 许可

私有项目，未开源。
