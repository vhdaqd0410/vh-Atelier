# 本地去字幕（VSR）· 使用与部署

插件「超分去字幕」面板里的 **🧹 本地去字幕（VSR）** 走本地开源方案
[video-subtitle-remover](https://github.com/YaoFANGUK/video-subtitle-remover)，
免费、不上传，需要一块 NVIDIA 显卡。

## 和云端「去字幕」的区别

| | 云端（火山 VOD） | 本地（VSR） |
|---|---|---|
| 费用 | 按量付费 | 免费 |
| 隐私 | 需上传 | 全本地 |
| 速度 | 快（云端算力） | 看显卡；4060Ti 8G 可用 |
| 部署 | 无需部署 | 需装一次环境（约 4 GB） |

两套并存：赶时间/要求极致效果用云端，量大/在意隐私用本地。

## 安装（一次性）

本机路径：`F:\OH-WorkSpace\tools\VSR\video-subtitle-remover-main`

已完成的步骤（脚本化，可重跑）：

1. 下载源码（含预训练模型，约 754 MB）
   ```
   https://github.com/YaoFANGUK/video-subtitle-remover/archive/refs/heads/main.zip
   ```
2. 建独立 venv（**不要**用插件自带的 Python 环境，那里是 CPU 版 torch，会冲突）
   ```
   <Python313>\python.exe -m venv <VSR>\venv
   ```
3. 装依赖（顺序重要）
   ```
   venv\Scripts\python.exe -m pip install torch==2.7.0 torchvision==0.22.0 --index-url https://download.pytorch.org/whl/cu126
   venv\Scripts\python.exe -m pip install paddlepaddle-gpu==3.0.0 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
   venv\Scripts\python.exe -m pip install -r requirements.txt
   ```

> 显卡与 CUDA 版本对应：40 系用 `cu126`；30 系以下可用 `cu118`；无 N 卡改用 CPU 版
> （`https://download.pytorch.org/whl/cpu`），但速度会慢很多。

## 在插件里用

面板 → 超分去字幕 → **🧹 本地去字幕（VSR）**：

1. 点 **🔧 自检**，确认显示「✅ 本地引擎就绪 · 显卡名（CUDA 加速）」
2. 选算法（默认 `STTN 自动`）
3. 选字幕区域：
   - **底部固定区**（默认）：覆盖底部 22%，适合竖屏短剧/漫剧
   - **自定义比例**：手动填 y/x 起止（0–1）
   - **全片自动检测**：不指定区域，让 VSR 自己找（慢，但适配未知片源）
4. 点 **🧹 本地去字幕**（自动导出当前序列的无字幕底版再处理），
   或 **📁 选文件…** 直接处理已存在的视频

结果默认落在插件目录 `collect/vsr_results/`。

## 算法怎么选

| 算法 | 适用 | 说明 |
|---|---|---|
| `sttn-auto` | 真人视频、漫剧通用 | 默认；可跳检测，快 |
| `sttn-det` | 需要更准 | 每帧检测，稍慢 |
| `lama` | 动画/漫剧 | 单帧修复质量高 |
| `propainter` | 剧烈运动镜头 | 显存占用大（8G 吃紧） |
| `opencv` | 只求快 | 效果一般 |

**漫剧建议**：字幕位置固定时用「底部固定区 + `sttn-auto`」，最快最稳；
画面有复杂运动时换 `lama` 对比效果。

## 排障

- **自检报「未找到 VSR 目录」**：确认 `tools\VSR\video-subtitle-remover-main\backend\main.py` 存在；
  也可用环境变量 `VH_VSR_ROOT` 指向它。
- **报 `ModuleNotFoundError: No module named 'cv2'`**：requirements 没装完，重跑第 3 步。
- **提示未启用 CUDA**：torch 装成了 CPU 版，按第 3 步重装 `cu126` 版。
- **处理很慢**：确认自检里 GPU 名称正确显示；显存不足时换 `sttn-auto` 或 `opencv`。

## 技术实现

- 插件侧 `js/vsr.js`：子进程调用 + 进度事件转发
- 面板逻辑 `js/vsr-ui.js`：界面绑定
- 调用器 `py/vsr_client.py`：环境自检 / 探测视频 / 执行去字幕，输出统一 JSON 行
- 关键点：**插件不引 torch/paddle**，全部交给 VSR 自己的 venv，避免污染插件 Python 环境
