# vh-Atelier

面向 **AI 漫剧 / 短剧批量制作**的 Adobe Premiere Pro 本地工作台扩展。

九个工作台覆盖从素材整理到成片交付的完整链路：素材导入 → 剧本拆解 → 粗剪 → 超分去字幕 → 声音处理 → 字幕识别校对 → 审片 → 多版本交付，外加进度查看、待办与在线反馈。AI 引擎（FunASR / Whisper / Spleeter / CosyVoice3）随包分发，本地运行，装完即用。

> 当前版本 **v1.5.0** · 分支 `main` · 扩展 ID `com.vh.atelier` · 菜单名 `vh-Atelier`
>
> 另有精简版 **vh-Atelier A**（`com.vh.ate`，分支 `vh-ate`）：去掉进度 / 待办 / 字幕，保留七工作台，用于只需要剪辑环节的机器。

---

## 工作台总览

| 工作台 | 子功能 | 引擎 / 依赖 | 联网 |
|---|---|---|---|
| **🗂 素材** | 素材浏览 | Node fs + PR 导入 API | 否 |
| **📖 剧本** | 剧本阅读 | Python docx/pdf 解析 | 否 |
| **进度** | 项目进度 | 视频工作台 Flask API（`127.0.0.1:8089`） | 本机 |
| **📝 待办** | 今日待办 | 本地模板 + 文件存储 | 否 |
| **✨ 超分** | 超分 / 去字幕 | 云端 API（需自备账号） | **是** |
| **字幕** | 字幕识别 / 字幕校对 | FunASR + Whisper / Python difflib | 否 |
| **🎵 声音** | 人声分离 / 语音克隆 / 音乐库 / 音效库 / 网易云 | Spleeter / CosyVoice3 / wavesurfer / ncm-server | 网易云需联网 |
| **🎬 审片** | 内嵌分秒帧 | iframe + 内嵌站导航 | **是** |
| **📦 交付** | 多版本导出 / 视频下载 | PR `exportAsMediaDirect` / yt-dlp | 视频下载需联网 |
| **📮 反馈** | 在线反馈 | 自建反馈中心（服务器） | **是** |

**联网项**：超分去字幕、审片（分秒帧）、网易云音乐、视频下载、在线反馈与更新。其余全部本地运行。

---

## 目录结构

```
com.vh.atelier/
├── CSXS/manifest.xml        扩展清单（2 个 Extension：panel 主面板 + bg 后台桥）
├── index.html               主面板 UI（工作台导航 + 各功能面板）
├── version.json             版本号与分支信息（更新器读取）
├── changelog.json           版本更新历史（「📋 历史」按钮数据源）
├── js/
│   ├── CSInterface.js       Adobe CEP 桥接库
│   ├── main.js              两级导航切换（工作台 → 子功能）
│   ├── utils.js             共享工具（SRT 解析/生成、HTML 转义、Python 探测）
│   ├── translate.js         共享翻译引擎（英译中，识别/校对两板块共用）
│   ├── errorlog.js          错误日志（捕获运行时异常 + 标题栏日志按钮/红点）
│   ├── updater.js           在线更新 + 更新历史
│   ├── media.js             素材库：浏览 → 多选/文件夹导入 PR
│   ├── script.js            剧本阅读（docx/pdf 解析、角色场景识别）
│   ├── progress.js          项目进度（联动视频工作台，只读）
│   ├── todo.js              今日待办（跨天结转、当日总结）
│   ├── enhance.js           超分 / 去字幕（导出 → 上传 → 处理 → 下载 → 导入）
│   ├── subtitle.js          字幕识别（批量，中/英/多语言）
│   ├── check.js             字幕校对（SRT ↔ 剧本词级对齐）
│   ├── clone.js             语音克隆（CosyVoice3）
│   ├── sfx.js               音效库（本地素材浏览器）
│   ├── sfx-capture.js       从时间轴采集音效为 wav
│   ├── musiclib.js          音乐库（本地音乐浏览器）
│   ├── music.js             网易云音乐
│   ├── export.js            多版本导出（交付模板 + 版本列表 + 清单 CSV）
│   ├── video.js             视频下载（yt-dlp）
│   ├── iframe-nav.js        内嵌站导航（后退/前进/刷新/外开）
│   ├── feedback.js          在线反馈（自建反馈中心）
│   ├── feedback-ui.js       在线反馈界面
│   ├── feedback-panel.js    反馈中心面板（内嵌显示）
│   └── wavesurfer.js        波形渲染库
├── jsx/
│   └── host.jsx             PR 宿主脚本（ExtendScript，ES3）
├── py/                      Python 引擎（由面板 spawn 调用）
│   ├── funasr_cli.py        中文识别
│   ├── subtitle_check.py    字幕校对引擎（词级对齐）
│   ├── cosyvoice_cli.py     语音克隆
│   ├── docx_read.py         剧本 docx 解析
│   ├── identify_record.py   识别结果记录
│   └── enhance_client.py    超分/去字幕客户端
├── bg/                      后台桥隐藏面板（拉起网易云本地服务）
├── bin/ffmpeg-win/          ffmpeg（音频处理）
├── video/                   yt-dlp 下载服务
├── ncm/                     网易云本地服务
├── models/                  大模型（不入 git，运行时本地回退）
├── stubs/torio_stub/        torchaudio 精简桩（语音克隆依赖）
├── tools/                   开发辅助（安装/卸载同步钩子）
└── collect/                 运行时数据（替换字典/日志/索引，**用户数据**）
```

---

## 各工作台功能

### 🗂 素材
- 按目录层级浏览本地素材目录，勾选文件或整个文件夹批量导入 PR 素材箱
- 导入前校验目标素材箱，避免重复入库；大批量导入显示实时进度

### 📖 剧本
- 直接读 docx / pdf 剧本正文与人物小传
- 自动提取角色、场景、集数，支持关键词定位
- 选集只做滚动定位，可连续滚动阅读相邻集

### 进度
- 读视频工作台（`127.0.0.1:8089`）的 `/api/projects`，展示本月概览与组内进行中项目
- 按工作流状态排序（剪辑中 → 审核中 → 修改中 → …），可筛选状态
- 每项目「在工作台打开」→ 视频工作台自动跳转并高亮（SSE jump 通道）
- 数据只读不改；依赖视频工作台桌面版运行

### 📝 待办
- 逐条记待办 → 打勾完成 → 生成当日工作总结（本地模板，无网络依赖）
- 待办可挂到具体项目与负责人，数据源联动视频工作台
- 未完成项自动顺延到次日；凌晨时段归前一天
- 数据存本地并带备份

### ✨ 超分 / 去字幕
- 两种模式：**超分**（放大画质）/ **去字幕**（擦除硬字幕）
- 区间可选：整序列 / 选中片段 / 入点→出点
- 一键导出 → 上传 → 云端处理 → 自动下载 → 导入对应素材箱
- 支持后台排队：提交完即可继续下一个，不必等云端处理完
- 云端账号在面板内配置「⚙ 账号」，每台机器各用各的

### 字幕
- **识别**：选序列（多选）→ 批量识别。中文 FunASR，英文 Whisper（GPU 可选）；可导出 SRT
- **校对**：SRT ↔ 剧本 docx 词级对齐，定位听错 / 漏词 / 幻觉重复，打勾一键回写
- **全局替换字典**：`collect/replace_dict.json`，应用校对时自动生效，支持备份
- **翻译**：英译中，可选中文单语轨或中英双语轨，作剧情理解参考，不进成片

### 🎵 声音
- **人声分离**：时间轴选中音频块 → 本地 Spleeter 分离人声/伴奏，结果可试听、可拖拽
- **语音克隆**：参考音色 + 任意文字合成（CosyVoice3），可导入时间轴
- **音效库**：本地音效扫描 / 收藏 / 试听 / 拖拽插入；支持从时间轴采集音效
- **音乐库**：本地音乐浏览器（Resonic 式）
- **网易云**：扫码登录 / 歌单 / 搜索 / 试听 / 下载（本地 ncm 服务，由后台桥拉起）

### 🎬 审片
- 分秒帧完整内嵌进面板，配后退 / 前进 / 刷新 / 外开导航
- 从项目卡片可一键跳到该项目的分秒帧审核页
- 看批注不用切出 PR

### 📦 交付
- **多版本导出**：版本可增删，每版独立配预设 / 音轨静音策略 / 输出目录
- **交付模板**：整套配置存为模板，多项目一键切换
- 序列多选批量串行导出，自动生成交付清单 CSV
- **视频下载**：抖音 / B站 / YouTube / 小红书等链接解析下载，一键导入

### 📮 反馈
- 标题栏「📮 反馈」一键提交，自动附带插件版本、系统信息与最近日志
- 面板内直接查看反馈中心，支持筛选 / 搜索 / 投票
- 数据存自建服务器，不依赖第三方

---

## 安装

1. 把 `com.vh.atelier` 复制到 `%APPDATA%\Adobe\CEP\extensions\`
2. 注册表 `HKEY_CURRENT_USER\Software\Adobe\CSXS.6` 建 `PlayerDebugMode` = `1`（未签名扩展必需）
3. 重开 Premiere Pro，菜单「**窗口 → 扩展 → vh-Atelier**」

> 走部署包的话，双击「一键部署.bat」会自动完成上述三步，并配置 Python / Node 引擎路径。

### 改代码后必须同步

源码目录与安装目录是**独立的两份**，改完源码必须同步：

```
源码：  F:\OH-WorkSpace\plugins\vh-Atelier\com.vh.atelier\
安装：  %APPDATA%\Adobe\CEP\extensions\com.vh.atelier\
```

同步脚本在仓库**上一级**（`plugins\vh-Atelier\`）：

- `python sync-to-pr.py` — 镜像同步
- `python sync-to-pr.py --check` — 只报告差异，不改文件
- `sync-to-pr.pyw` — 双击运行的 GUI 版

**同步规则**：
- 镜像覆盖，排除 `.git / _tmp / _releases / ncm-server / collect` 与 `.log / .pyc`
- **`collect/` 是用户数据**（替换字典、索引、日志），绝不镜像覆盖，否则用户积累会被源码样板冲掉
- 运行中被 PR 占用的 exe/dll 会跳过，不影响功能更新
- **方向以源码为准**：安装目录里源码没有的文件会被删除，勿在安装目录里直接改东西

### 提交后自动同步（已配置）

- 钩子 `tools/hook/post-commit` 在每次 `git commit` 后自动跑同步
- 新机器安装：`python tools/install-hook.py`
- 临时跳过：设环境变量 `VH_SKIP_SYNC=1`

---

## 开发约定

### 共享模块优先

- `js/utils.js`（挂 `window.__vhUtils`）：SRT 解析/生成、HTML 转义、Python 探测
- `js/translate.js`（挂 `window.__translateBridge`）：英译中，识别/校对共用
- `js/errorlog.js`：错误日志入口
- `js/iframe-nav.js`：内嵌站导航通用模块

### 脚本加载顺序（index.html 底部）

```
CSInterface.js → errorlog.js → updater.js → main.js → utils.js → translate.js →
subtitle.js → clone.js → sfx.js → sfx-capture.js → musiclib.js → music.js →
export.js → enhance.js → media.js → check.js → video.js → script.js → progress.js →
todo.js → iframe-nav.js → feedback.js → feedback-ui.js → feedback-panel.js
```

依赖关系：`utils.js` / `translate.js` 必须先于使用它们的板块；`main.js` 先于各板块（它们调用 `__atSwitchTab`）。
板块间通过全局对象通信，例如 `window.__vhProgress.setStatus()` / `window.__vhScript.openScriptForProject()`。

---

## 已知边界与坑（维护备忘）

- **`host.jsx` 与 manifest 是 PR 启动时才加载的**，改 JSX 或扩展列表必须彻底重启 PR；改前端 js/html 只需重开面板
- **ExtendScript 是 ES3**：host.jsx 里不能用 `.trim() / .some() / .forEach()` 等 ES5 方法，去空白用正则
- **同步方向以源码为准**；`collect/` 是用户数据，绝不镜像覆盖
- **缓存有效性**：音效索引缓存非空但内容全空时会导致「永远搜不到」，读取时须做有效性检测
- **CEP 6 没有 `hideExtension` API**：Modeless 浮窗唯一可靠关闭路径是 `closeExtension()`
- **QE 时间字段是 `.secs` 不是 `.seconds`**（若做 QE 相关开发注意差异）
- **中文路径编码**：PowerShell 处理中文路径需显式 UTF-8
- **多版本导出「浏览…」按钮**依赖 `jsx/folderpicker.ps1`，`-ExecutionPolicy` 参数必须干净 ASCII
- **git 在沙箱中**：用 Python subprocess + workdir 执行；push 偶发 TLS 错误时切换代理开关（`-c http.proxy=` 绕过，或反之）

---

## 更新机制

插件内置更新器（`js/updater.js`）：

- 打开面板时自动检查（走 `version.json` 比对远端）
- 标题栏「**⬆ 更新**」手动触发，与启动检查走同一个弹窗
- 弹窗展示「从当前版本到最新版」的**跨版本累积变更**
- 可选「立即更新 / 稍后」，更新完重开面板生效（涉及 JSX 需重启 PR）
- 标题栏「**📋 历史**」查看全部版本记录（读 `changelog.json`）

**更新只同步代码**，模型、引擎与 `collect/` 用户数据不受影响。

---

## 版本历史

| 版本 | 日期 | 说明 |
|---|---|---|
| **1.5.0** | 09-17 | 更新历史（📋）、更新弹窗跨版本变更、启动检测修复、反馈口令确认 |
| 1.4.0 | 09-17 | 反馈中心做进插件（📮 工作台）；修人声分离试听 |
| 1.3.3 | 09-17 | 人声分离试听改 XHR 读 Blob，任何机器都能播 |
| 1.3.2 | 09-17 | 在线反馈改纯自建服务；修区间导出忽略来源 |
| 1.3.1 | 09-17 | 区间来源对「导出并超分」生效；反馈走中转 |
| 1.3.0 | 09-17 | 在线反馈（📮）；下载 WinError32 修复；去字幕支持入点→出点 |
| 1.2.0 | 09-16 | 超分/去字幕后台排队；下载加固（重试/校验/错误页识别） |
| 1.2.1 | 09-16 | 下载占用改用带序号新文件名；.part 唯一名 |
| 1.1.2 | 09-16 | 下载自动重试；先写 .part 校验通过才改名 |
| 1.1.1 | 09-16 | 采集音效「精确模式」导出假 wav 修复 |
| 1.1.0 | 09-16 | 从时间轴采集音效；超分内嵌站空白修复 |
| 1.0.2 | 09-15 | 更新说明展示、弹窗美化、启动自动检查 |
| 1.0.1 | 09-15 | 标题栏「ℹ 序列信息」（帧率/时长/分辨率） |
| 1.0.0 | 09-15 | 首个正式版本：在线更新 + 超分账号配置 |

更早的版本（0.1.x / 0.2.x）为整合前的分板块开发期记录，详见 `changelog.json`。

## 许可

私有项目，未开源。
