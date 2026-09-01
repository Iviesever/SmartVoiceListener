# SmartVoiceListener 🎙️

> **本地离线、私密安全的 AI 智能语音听写与流式文档工作台**。  
> 结合持续音频采集、智能静音断句与多模型离线推理，将讲话内容自然连贯地转写成整篇文档。

---

## ✨ 核心特性

- 📝 **流式文档工作区（CodeMirror 6 内核）**  
  告别碎卡片设计，采用一整块纯白极简备忘录文档视图。讲话停顿自动换行追加，支持随时在任意位置自由打字、改错、选词与复制。

- 🛡️ **IME 输入法与尾部打字防干扰**  
  内置 800ms 真实闲置调度器。当用户正在中文拼音打字或在文末编辑时，新转录自动安全排队，绝不打碎输入法候选框或把正在输入的句子劈断。

- 🎯 **智能视口跟随与未读胶囊**  
  处于文末时新文字自动平滑滚动触底；当向上翻阅或编辑历史内容时，视口稳固锁定不抢滚动条，并在右下方优雅浮现 `↓ 有 N 条新听写` 快捷胶囊。

- 🚀 **多模型离线矩阵 & GPU 硬件加速**  
  - **SenseVoice (sherpa-onnx INT8)**：~100ms 极速响应，口语与普通话标点极佳；
  - **Qwen3-ASR 1.7B**：通义千问 2024 端到端语音大模型，满血吃满 NVIDIA RTX 4070 (8GB) CUDA 张量核心；
  - **Whisper large-v3 / Kotoba**：OpenAI 旗舰与多语种特化支持；
  - 顶部下拉框支持一键无缝热切换。

- 🎤 **自适应 VAD 与 0.8s 深度前缀回溯**  
  根据环境噪音动态调整拾音门限，开口瞬间自动回溯抓取前 800ms 音频，消除首字吞音；带通滤波过滤电流麦杂音，自动峰值响度归一化。

- 💾 **零延迟防丢持久化**  
  正文与底层 Segments 自动防抖保存，同时深度监听 `pagehide` 与 `visibilitychange`，页面刷新、关闭或切后台时即时同步落盘。

- 🎨 **极简亮色设计系统**  
  纯白底色，无毛玻璃特效，全内联纯 SVG 矢量图标，响应轻快利落，支持移动端窄屏自适应响应式布局。

---

## 🚀 极速上手

### 1. 环境准备
- **Node.js** (>= 18.0)
- **Python** (3.10+，推荐配备 CUDA 12+ 的 PyTorch 环境以启用 GPU 加速)

### 2. 安装依赖
```bash
# 安装前端依赖
npm install

# 安装 Python 离线语音依赖
pip install sherpa-onnx soundfile
# (可选) 启用 Qwen3-ASR 或 Whisper GPU 加速：
# pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
# pip install qwen-asr faster-whisper
```

### 3. 一键启动
在 Windows 下直接双击运行：
```bat
start.bat
```
或者通过 Node 编排脚本启动：
```bash
node scripts/start.mjs
```
启动后系统将自动拉起 Python 后端与 Vite 开发服务器，并在浏览器自动打开 **`http://localhost:5174`**。

---

## 🛠️ 技术架构

```text
React 19 + TypeScript + Vite
│
├── TopControlBar (模型热切换 / 启动停止 / 参数设置)
│
├── DocumentWorkspace
│     └── DocumentEditor (CodeMirror 6 纯白备忘录内核)
│           ├── Transaction 统一派发 (addToHistory: false)
│           ├── IME / 尾部打字 800ms 闲置调度器
│           └── 80px 容差智能视口与未读悬浮胶囊
│
└── BottomStatusBar (实时呼吸状态灯 / 字数统计 / 导出 / 清空)

Audio Pipeline (Web Audio API)
│
├── 持续主音频流采集 (Master Continuous Recording)
├── 800ms 环形前缀缓冲 (防吞字回溯)
├── 自适应底噪学习与带通滤波 (80Hz ~ 7500Hz)
└── VAD 静音切句 ➔ Python 本地 ASR 服务 (8767 端口)
```

---

## ⚙️ 环境变量配置（可选）

可通过环境变量按需自定义 ASR 服务端：

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SMARTVOICE_HOST` | `127.0.0.1` | 服务绑定地址（默认仅本地回环，保障私密安全） |
| `SMARTVOICE_PORT` | `8767` | ASR 服务端监听端口 |
| `SMARTVOICE_MODELS_DIR` | `D:\resource\AI_WorkSpace\Models` | 外部离线模型存放主目录 |

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
