# vh-Atelier

Adobe Premiere Pro 本地工作台扩展。按「进度 / 字幕 / 声音 / 交付」四个工作台组织，覆盖 AI 漫剧/短剧制作的剪辑主流程：字幕识别 → 校对 → 翻译参考、声音素材处理、多版本交付、项目进度总览。

## 工作台总览

| 工作台 | 子功能 | 引擎 | 联网 |
|--------|--------|------|------|
| **进度** | 联动「视频工作台」实时看项目集数进度、状态筛选、一键跳转定位 | 视频工作台 Flask API | 是（本机） |
| **字幕** | 识别（中/英/多语言）/ 校对（SRT↔剧本词级对齐）/ 翻译（中文轨/双语轨） | FunASR + Whisper / Python difflib / MyMemory | 翻译需联网 |
| **声音** | 人声分离 / 语音克隆 / 音效库 / 音乐 | Spleeter / CosyVoice3 / ffmpeg / ncm-server | 音乐需联网 |
| **交付** | 多版本导出（模板化）/ 视频下载 | PR 原生 exportAsMediaDirect / yt-dlp | 视频下载需联网 |

> 联网项：字幕翻译（MyMemory）、音乐（网易云）、视频下载（yt-dlp）、进度（本机视频工作台）。其余本地运行。

---

## 目录结构

```
com.vh.atelier/
├── CSXS/manifest.xml       扩展清单（2 个 Extension：主面板 + 后台桥）
├── index.html              主面板 UI（4 工作台导航 + 各功能面板）
├── js/
│   ├── main.js             两级导航切换（工作台 → 子功能）
│   ├── utils.js            共享工具（SRT 解析/生成、HTML 转义、Python 探测）
│   ├── translate.js        共享翻译引擎（英译中，识别/校对两板块共用）
│   ├── subtitle.js         字幕识别 + 人声分离
│   ├── check.js            字幕校对 + 翻译入口
│   ├── clone.js            语音克隆
│   ├── sfx.js              音效库
│   ├── music.js            网易云音乐
│   ├── export.js           多版本导出（含交付模板）
│   ├── video.js            视频下载
│   ├── progress.js         项目进度（视频工作台联动）
│   ├── wavesurfer.js       波形预览
│   └── CSInterface.js      CEP 桥接库
├── jsx/host.jsx            ExtendScript 宿主（ws/vc/sfx/me/music/video/ck 前缀函数）
├── bg/                     后台桥隐藏面板（负责拉起网易云本地服务）
├── keyhook/                全局热键钩子源码（已退役，无代码引用，保留备用）
├── bin/ffmpeg-win32-x64.exe
├── py/
│   ├── funasr_cli.py       中文识别 CLI
│   ├── cosyvoice_cli.py    语音克隆 CLI
│   └── subtitle_check.py   字幕校对引擎（docx 解析 + 词级对齐）
├── models/                 大模型（不入 git，运行时本地回退）
├── stubs/torio_stub/       torchaudio 精简桩（语音克隆依赖）
├── ncm/                    网易云本地服务
├── video/                  yt-dlp 下载服务
└── collect/                运行时数据（替换字典/日志等，用户数据，勿镜像覆盖）
```

---

## 开发约定（重要）

### 源码目录 vs PR 安装目录

- **源码目录**：`outputs\vh-Atelier\com.vh.atelier\`（开发改这里）
- **安装目录**：`%APPDATA%\Adobe\CEP\extensions\com.vh.atelier\`（PR 实际加载这里）
- 改完源码**必须同步**到安装目录，否则 PR 里看不到改动。一键同步脚本：
  - `sync-to-pr.py`（命令行）或 `sync-to-pr.pyw`（双击弹窗），位于 `outputs\vh-Atelier\`
  - 镜像同步，排除 `.git/_tmp/_releases/ncm-server/collect` 与 `.log/.pyc`
  - **collect/ 是运行时用户数据**（替换字典等），绝不镜像覆盖，否则用户数据会被源码样板冲掉
  - 运行中被 PR 占用的 exe/dll 会跳过，不影响功能更新
  - **同步方向以源码为准**：安装目录里源码没有的文件会被删除，勿在安装目录直接改代码

### 共享模块

- `js/utils.js`（`window.__vhUtils`）：SRT 解析/生成、HTML 转义、Python 探测等纯函数
- `js/translate.js`（`window.__translateBridge`）：英译中翻译引擎，识别/校对两板块共用
- 新增跨板块共享代码时优先放这里；各板块内部函数保持 IIFE 私有

### 脚本加载顺序（index.html 底部）

`CSInterface.js → main.js → utils.js → translate.js → subtitle.js → clone.js → wavesurfer.js → sfx.js → music.js → export.js → check.js → video.js → progress.js`

依赖关系：utils/translate 必须先于使用它们的板块加载；main.js 先于各板块（它们调用 `__atSwitchTab`）。

### 安装与调试

1. 把 `com.vh.atelier` 复制到 `%APPDATA%\Adobe\CEP\extensions\`
2. 注册表 `HKEY_CURRENT_USER\Software\Adobe\CSXS.6` 建 `PlayerDebugMode` = `1`（未签名扩展必需）
3. **改 JSX 必须彻底重启 PR**（host.jsx 是 PR 启动时才加载）；改前端 js/html 重开面板即可

---

## 各工作台功能

### 进度

- 读视频工作台（`127.0.0.1:8089`）的 `/api/projects`，展示本月概览 + 组内进行中项目
- 项目按工作流状态排序（剪辑中→审核中→修改中→…），可筛选状态/只看有进度
- 每项目「在工作台打开」→ 视频工作台自动跳转并高亮该项目（SSE jump 通道）
- 视频工作台未运行时提供一键启动；数据只读不改
- 依赖视频工作台桌面版运行（Flask 服务随其进程存活）

### 字幕

- **识别**：选序列（多选）→ 批量识别。中文 FunASR，英文 Whisper（GPU 可选）。识别后可校对/翻译/导出
- **校对**：SRT ↔ 剧本 docx 词级对齐，定位听错/漏词/幻觉重复，打勾一键回写。全局替换字典（collect/replace_dict.json）
- **翻译**：校对后或识别结果直接英译中，可选中文单语轨或双语轨（英文+中文同条），作剧情理解参考，不进成片

### 声音

- **人声分离**：时间轴选中含人声+伴奏的音频块 → 分离（Spleeter 本地）。实时读当前活动序列
- **语音克隆**：参考音色 + 任意文字合成（CosyVoice3）
- **音效库**：本地音效扫描/收藏/试听/拖拽插入
- **音乐**：网易云扫码登录/歌单/搜索/试听/下载（本地 ncm 服务，由后台桥拉起）

### 交付

- **多版本导出**：交付模板（命名模板存整套配置，多项目一键切换）+ 版本列表/预设/音轨静音策略/输出目录 + 串行导出 + 清单 CSV
- **视频下载**：抖音/B站/YouTube 下载并一键导入（yt-dlp）

---

## 已知边界与坑（维护备忘）

- **host.jsx 是 PR 启动时才加载的**，改 JSX 必须彻底重启 PR；manifest 改动同理（扩展列表启动时读取）
- **同步脚本方向以源码为准**；collect/ 是用户数据，绝不镜像覆盖
- **缓存有效性**：音效索引缓存非空但内容全空时会导致「永远搜不到」，读取时须做有效性检测
- **CEP 6 没有 `hideExtension` API**：Modeless 浮窗唯一可靠关闭路径是 `closeExtension()`
- **ExtendScript 是 ES3**：host.jsx 里不能用 `.trim()/.some()/.forEach()` 等 ES5 方法，去空白用正则
- **QE 时间字段是 `.secs` 不是 `.seconds`**：若未来再做 QE 相关开发，注意此差异（PR 26）
- **git 命令在沙箱中**：PowerShell `$host` 是保留变量；git 输出在沙箱被吞，用 Python subprocess + workdir 执行；push 偶发 TLS 错误加 `-c http.proxy= -c https.proxy=` 绕过代理
- **中文路径编码**：PowerShell 处理中文路径需显式 UTF-8
- **多版本导出「浏览…」按钮**：依赖 `jsx/folderpicker.ps1`，`-ExecutionPolicy` 参数必须干净 ASCII

---

## 版本

- **0.2.1**（当前）：翻译收拢共享模块 + utils.js 消重复；四工作台导航成型（进度/字幕/声音/交付）；人声分离迁入声音组；进度联动视频工作台；移除全局音效搜索浮窗（避免与 Excalibur 钩子冲突）
- 0.2.0：网易云音乐板块
- 0.1.6：字幕校对板块
- 0.1.5：多版本导出（整合自 com.delivery.multiexport）
- 0.1.4：字幕识别 + 语音克隆 + 音效库

## 许可

私有项目，未开源。
