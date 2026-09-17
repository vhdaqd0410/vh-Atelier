# vh-Atelier A

面向 **AI 漫剧 / 短剧批量制作**的 Adobe Premiere Pro 本地工作台扩展（**精简版**）。

七个工作台，聚焦剪辑与交付主链路：素材导入 → 剧本阅读 → 超分去字幕 → 声音处理 → 审片 → 多版本交付，外加在线反馈。相比全功能版**去掉了进度、待办、字幕**三个工作台，适合只需要剪辑环节的机器，占用更小、面板更清爽。

> 当前版本 **v1.5.0** · 分支 `vh-ate` · 扩展 ID `com.vh.ate` · 菜单名 `vh-Atelier A`
>
> 全功能版 **vh-Atelier**（`com.vh.atelier`，分支 `main`）：九工作台，另含进度 / 待办 / 字幕识别校对。

---

## 与全功能版的区别

| 工作台 | vh-Atelier A | 全功能版 |
|---|---|---|
| 🗂 素材 | ✅ | ✅ |
| 📖 剧本 | ✅ | ✅ |
| 进度 | — | ✅ |
| 📝 待办 | — | ✅ |
| ✨ 超分 | ✅ | ✅ |
| 字幕 | — | ✅ |
| 🎵 声音 | ✅（无人声分离的独立面板，已并入 separate.js） | ✅ + 语音克隆 |
| 🎬 审片 | ✅ | ✅ |
| 📦 交付 | ✅ | ✅ |
| 📮 反馈 | ✅ | ✅ |

> A 版**不含**语音克隆与字幕模块，因此没有 `py/cosyvoice_cli.py`、`py/funasr_cli.py`、`py/subtitle_check.py` 与 `stubs/`。

---

## 工作台总览

| 工作台 | 子功能 | 引擎 / 依赖 | 联网 |
|---|---|---|---|
| **🗂 素材** | 素材浏览 | Node fs + PR 导入 API | 否 |
| **📖 剧本** | 剧本阅读 | Python docx/pdf 解析 | 否 |
| **✨ 超分** | 超分 / 去字幕 | 云端 API（需自备账号） | **是** |
| **🎵 声音** | 人声分离 / 音乐库 / 音效库 / 网易云 | Spleeter / wavesurfer / ncm-server | 网易云需联网 |
| **🎬 审片** | 内嵌分秒帧 | iframe + 内嵌站导航 | **是** |
| **📦 交付** | 多版本导出 / 视频下载 | PR `exportAsMediaDirect` / yt-dlp | 视频下载需联网 |
| **📮 反馈** | 在线反馈 | 自建反馈中心（服务器） | **是** |

**联网项**：超分去字幕、审片（分秒帧）、网易云音乐、视频下载、在线反馈与更新。其余全部本地运行。

---

## 目录结构

```
com.vh.ate/
├── CSXS/manifest.xml        扩展清单（2 个 Extension：panel 主面板 + bg 后台桥）
├── index.html               主面板 UI（工作台导航 + 各功能面板）
├── version.json             版本号与分支信息（更新器读取）
├── changelog.json           版本更新历史（「📋 历史」按钮数据源）
├── js/
│   ├── CSInterface.js       Adobe CEP 桥接库
│   ├── main.js              两级导航切换（工作台 → 子功能）
│   ├── utils.js             共享工具（SRT 解析/生成、HTML 转义、Python 探测）
│   ├── translate.js         共享翻译引擎
│   ├── errorlog.js          错误日志（标题栏日志按钮/红点）
│   ├── updater.js           在线更新 + 更新历史
│   ├── media.js             素材库：浏览 → 多选/文件夹导入 PR
│   ├── script.js            剧本阅读（docx/pdf 解析）
│   ├── enhance.js           超分 / 去字幕（导出 → 上传 → 处理 → 下载 → 导入）
│   ├── separate.js          人声分离（从 subtitle.js 剥离而来）
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
├── py/                      Python 引擎
│   ├── docx_read.py         剧本 docx 解析
│   ├── identify_record.py   识别结果记录
│   └── enhance_client.py    超分/去字幕客户端
├── bg/                      后台桥隐藏面板（拉起网易云本地服务）
├── bin/ffmpeg-win/          ffmpeg（音频处理）
├── video/                   yt-dlp 下载服务
├── ncm/                     网易云本地服务
├── models/                  大模型（不入 git）
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

### ✨ 超分 / 去字幕
- 两种模式：**超分**（放大画质）/ **去字幕**（擦除硬字幕）
- 区间可选：整序列 / 选中片段 / 入点→出点
- 一键导出 → 上传 → 云端处理 → 自动下载 → 导入对应素材箱
- 支持后台排队：提交完即可继续下一个，不必等云端处理完
- 云端账号在面板内配置「⚙ 账号」，每台机器各用各的

### 🎵 声音
- **人声分离**：时间轴选中音频块 → 本地 Spleeter 分离人声/伴奏，结果可试听、可拖拽
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

1. 把 `com.vh.ate` 复制到 `%APPDATA%\Adobe\CEP\extensions\`
2. 注册表 `HKEY_CURRENT_USER\Software\Adobe\CSXS.6` 建 `PlayerDebugMode` = `1`（未签名扩展必需）
3. 重开 Premiere Pro，菜单「**窗口 → 扩展 → vh-Atelier A**」

> 走部署包的话，双击「一键部署.bat」会自动完成上述三步，并配置 Python / Node 引擎路径。

> **注意**：A 版与全功能版的扩展 ID 不同（`com.vh.ate` vs `com.vh.atelier`），**可以同时安装在同一个 PR 里**，菜单会分别显示。

### 改代码后必须同步

源码目录与安装目录是**独立的两份**，改完源码必须同步：

```
源码：  F:\OH-WorkSpace\plugins\vh-Atelier-A\com.vh.ate\
安装：  %APPDATA%\Adobe\CEP\extensions\com.vh.ate\
```

同步规则与全功能版一致：镜像覆盖，**排除 `collect/`（用户数据）**、`.git / _tmp / _releases / ncm-server` 与 `.log / .pyc`；运行中被 PR 占用的 exe/dll 会跳过。方向以源码为准，勿在安装目录里直接改东西。

---

## 开发约定

### 共享模块优先

- `js/utils.js`（挂 `window.__vhUtils`）：SRT 解析/生成、HTML 转义、Python 探测
- `js/translate.js`（挂 `window.__translateBridge`）：共享翻译引擎
- `js/errorlog.js`：错误日志入口
- `js/iframe-nav.js`：内嵌站导航通用模块

### 脚本加载顺序（index.html 底部）

```
CSInterface.js → errorlog.js → updater.js → main.js → utils.js → translate.js →
separate.js → sfx.js → sfx-capture.js → musiclib.js → music.js → export.js →
enhance.js → media.js → video.js → script.js → iframe-nav.js → feedback.js →
feedback-ui.js → feedback-panel.js
```

依赖关系：`utils.js` / `translate.js` 必须先于使用它们的板块；`main.js` 先于各板块（它们调用 `__atSwitchTab`）。

---

## 已知边界与坑（维护备忘）

- **`host.jsx` 与 manifest 是 PR 启动时才加载的**，改 JSX 或扩展列表必须彻底重启 PR；改前端 js/html 只需重开面板
- **ExtendScript 是 ES3**：host.jsx 里不能用 `.trim() / .some() / .forEach()` 等 ES5 方法，去空白用正则
- **同步方向以源码为准**；`collect/` 是用户数据，绝不镜像覆盖
- **缓存有效性**：音效索引缓存非空但内容全空时会导致「永远搜不到」，读取时须做有效性检测
- **CEP 6 没有 `hideExtension` API**：Modeless 浮窗唯一可靠关闭路径是 `closeExtension()`
- **中文路径编码**：PowerShell 处理中文路径需显式 UTF-8
- **多版本导出「浏览…」按钮**依赖 `jsx/folderpicker.ps1`，`-ExecutionPolicy` 参数必须干净 ASCII
- **人声分离结果试听**：改用 Blob 加载（v1.4.0 修复），不要退回 file:// 路径

---

## 更新机制

插件内置更新器（`js/updater.js`）：

- 打开面板时自动检查（走 `version.json` 比对远端）
- 标题栏「**⬆ 更新**」手动触发，与启动检查走同一个弹窗
- 弹窗展示「从当前版本到最新版」的**跨版本累积变更**
- 可选「立即更新 / 稍后」，更新完重开面板生效（涉及 JSX 需重启 PR）
- 标题栏「**📋 历史**」查看全部版本记录（读 `changelog.json`）

**更新只同步代码**，模型、引擎与 `collect/` 用户数据不受影响。

> A 版与全功能版共用同一份 `changelog.json`，但更新源按 `version.json` 里的 `branch` 字段分别走 `vh-ate` / `main` 分支。

---

## 版本历史

| 版本 | 日期 | 说明 |
|---|---|---|
| **1.5.0** | 09-17 | 更新历史（📋）、更新弹窗跨版本变更、启动检测修复、反馈口令确认 |
| 1.4.0 | 09-17 | 反馈中心做进插件（📮 工作台）；修人声分离试听 |
| 1.3.3 | 09-17 | 人声分离试听改 XHR 读 Blob，任何机器都能播 |
| 1.3.2 | 09-17 | 在线反馈改纯自建服务；修区间导出忽略来源 |
| 1.3.0 | 09-17 | 在线反馈（📮）；下载 WinError32 修复 |
| 1.2.0 | 09-16 | 超分/去字幕后台排队；下载加固（重试/校验/错误页识别） |
| 1.1.1 | 09-16 | 采集音效「精确模式」导出假 wav 修复 |
| 1.1.0 | 09-16 | 从时间轴采集音效；超分内嵌站空白修复 |
| 1.0.0 | 09-15 | 首个正式版本：在线更新 + 超分账号配置 |

更早的版本（0.1.x / 0.2.x）为整合前的分板块开发期记录，详见 `changelog.json`。

## 许可

私有项目，未开源。
