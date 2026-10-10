# vh-Atelier A

面向 **AI 漫剧 / 短剧批量制作**的 Adobe Premiere Pro 本地工作台扩展（**精简版**）。

九组工作台，聚焦剪辑与交付主链路。相比全功能版**去掉了进度、待办、字幕识别校对、网盘、调色 XML**，占用更小、面板更清爽，适合只需要剪辑环节的机器。

> **当前版本 v1.47.4** · 分支 `vh-ate` · 扩展 ID `com.vh.ate` · 菜单名 `vh-Atelier A`
>
> 全功能版 **vh-Atelier**（`com.vh.atelier`，分支 `main`）：十一组工作台，另含进度 / 待办 / 字幕识别校对 / 网盘 / 调色 XML。

---

## 与全功能版的区别

| 工作台 | vh-Atelier A | 全功能版 |
|---|---|---|
| 🏠 首页 | ✅（A 版独有） | — |
| 🗂 素材 / ☁ 网盘 | 素材库 · 项目（NAS 拉素材） | 素材浏览 · ☁ 网盘 |
| 📖 剧本 | ✅ | ✅ |
| 进度 | — | ✅ |
| 📝 待办 | — | ✅ |
| ✨ 超分 | ✅ 含本地去字幕 / 本地超分 | ✅ 同 |
| 字幕 | — | ✅ 识别与校对 |
| 声音 | ✅ 人声分离 / 音乐库 / 音效库 / 网易云 / 音乐聚合 / 短剧扒歌 | ✅ 另含语音克隆 |
| 🎬 审片 | ✅ | ✅ |
| 交付 | ✅ 多版本导出 / 视频下载 | ✅ 同 |
| 🔧 工具 | PR 版本转换 | 另含调色 XML / 字体修复 |
| 📮 反馈 | ✅ | ✅ |
| 受权系统 | ✅（A 版独有） | — |
| 文字样式转换 | ✅（A 版独有） | — |

**两版是独立代码库**，各自更新，改一处不会自动传导到另一处。

---

## 核心能力

### 本地去字幕 / 本地超分（免费、不上传）

全部在本机 GPU 上跑，不花云端费用、素材不出本机。

- **本地去字幕**：基于 VSR。支持**截帧可视化框选**字幕区域，框一次可存成**区域预设**跨项目复用；处理完自动做「区域回贴」——只取输出的字幕区，其余像素取自原片，避免整帧重绘造成的画面跳变
- **本地超分**：基于 Real-ESRGAN-ncnn-vulkan（Vulkan 加速，不依赖 CUDA）。默认输出长边 1080，可选 anime / anime4x / photo 三种模型与 2/3/4 倍率

两条链路都带**历史记录**：每条可拖拽进时间轴、导入素材箱、资源管理器定位、播放器打开。

### 多版本交付

一次配置、批量产出。每个版本独立设置导出预设、音轨静音策略、输出目录；整套配置可存为**交付模板**。

渲染通道可选 **AME 队列**（后台跑，PR 不占用）或 **PR 直渲**，AME 模式带版本预检与任务健康检查。

### 项目工作台（A 版独有）

从 NAS 拉取项目素材，直接落到本地并导入 PR。

---

## 安装

### 方式一：一键部署（推荐）

双击部署包里的「**一键部署.bat**」。

### 方式二：手动

1. 把 `com.vh.ate` 复制到 `%APPDATA%\Adobe\CEP\extensions\`
2. 注册表 `HKEY_CURRENT_USER\Software\Adobe\CSXS.6` 新建 `PlayerDebugMode`（字符串）= `1`
3. 重开 Premiere Pro，菜单「**窗口 → 扩展 → vh-Atelier A**」

---

## 目录结构

```
com.vh.ate/
├── CSXS/manifest.xml          扩展清单（panel 主面板 + bg 后台桥）
├── index.html                 主面板 UI
├── version.json               版本与分支信息（更新器读取）
├── changelog.json             版本历史
├── js/                        前端逻辑（按面板拆分）
├── jsx/host.jsx               PR 宿主脚本（ExtendScript / ES3）
├── py/                        Python 引擎调用器
├── bin/                       运行时二进制（ffmpeg / yt-dlp / realesrgan / sherpa）
├── models/                    AI 模型
├── ncm/                       网易云本地服务
├── video/                     yt-dlp 下载服务
└── collect/                   运行时数据（用户数据，升级不覆盖）
```

**关键目录**：`bin/` `models/` 是运行时资源，不进 git、随部署包分发，在线更新会跳过；`collect/` 是用户数据，同步与升级都不会覆盖。

---

## 开发与维护

### 源码目录与安装目录是两份

```
源码：  F:\OH-WorkSpace\plugins\vh-Atelier-A\com.vh.ate\
安装：  %APPDATA%\Adobe\CEP\extensions\com.vh.ate\
```

同步脚本在上一级 `plugins\vh-Atelier-A\`：`python sync-to-pr.py`（`--check` 只报告差异）。

**同步规则**：镜像覆盖，排除 `.git / _tmp / _releases / ncm-server / collect` 与 `.log / .pyc`。`collect/` 绝不镜像覆盖。

### 测试

```
node scripts/test-localsub.js     本地面板（去字幕）
node scripts/test-localup.js      本地面板（超分）
node scripts/test-ame-channel.js  AME 队列通道
node scripts/test-css-scope.js    CSS 作用域
node scripts/test-en-shared.js    公共模块
node scripts/test-srt-sidecar.js  字幕侧车归位
```

### 共享模块

| 模块 | 挂载点 | 职责 |
|---|---|---|
| `js/utils.js` | `window.__vhUtils` | SRT 解析/生成、HTML 转义 |
| `js/translate.js` | `window.__translateBridge` | 英译中 |
| `js/en-shared.js` | `window.__vhClip` | 序列选择 + 时间轴区间读取 |
| `js/en-local.js` | `window.__vhLocal` | 本地面板公共逻辑（历史/输出目录/进度/导入） |
| `js/errorlog.js` | `window.__vhLog` | 错误日志 |

### 已知边界

- **`host.jsx` 与 manifest 只在 PR 启动时加载** —— 改 JSX 或扩展列表必须彻底重启 PR
- **ExtendScript 是 ES3** —— 不能用 `.trim() / .some() / .forEach()`
- **CEP 6 没有 `hideExtension`** —— Modeless 浮窗唯一可靠关闭路径是 `closeExtension()`
- **QE 时间字段是 `.secs` 不是 `.seconds`**

---

## 更新机制

内置更新器（`js/updater.js`）：打开面板自动检查；标题栏「⬆ 更新」手动触发，展示跨版本累积变更；「📋 历史」查看全部版本记录。

**更新只同步代码**，模型、引擎与 `collect/` 用户数据不受影响。涉及 JSX 的更新需重启 PR。

---

## 许可

私有项目，未开源。
