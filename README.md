# SmartVoiceListener

面向长时语音场景的本地离线语音听写与流式文档工作台。基于 Web Audio 持续音频采集、自适应 VAD 静音切句与本地 ASR 离线大模型，将语音输入实时连贯地转录为整篇文档。

---

## 特性

### 1. 流式文档编辑 (CodeMirror 6)
- 采用单页纯白文档视图，替换碎片化卡片设计；
- 语音段落结束后自动换行追加，保持正文自然连贯；
- 支持在文档任意位置自由打字、选词、改错与全选复制；
- ASR 写入不污染用户撤销栈（`addToHistory: false`），保留原生 `Ctrl+Z` / `Ctrl+Y` 历史记录；
- 清空工作区时同步重置编辑器状态，维护文档与底层数据层一致性。

### 2. 输入法与打字保护
- 内置真实 800ms 空闲调度器；
- 在中文拼音输入法（IME）活跃或用户在文末连续打字时，新转录自动排队暂存；
- 待用户停笔满 800ms 后平滑追加，防止输入法候选框断流或文本被切断。

### 3. 智能视口跟随
- 处于文末时，新转录段落自动平滑滚动触底（80px 容差判断）；
- 向上滚动阅读或编辑历史内容时锁定视口，右下角悬浮显示未读段落提示胶囊，点击后平滑跳转触底并归零。

### 4. 本地多模型矩阵与 GPU 加速
- **SenseVoice (sherpa-onnx INT8)**: 低延迟极速识别，普通话与标点表现稳定；
- **Qwen3-ASR 1.7B**: 通义千问端到端语音大模型，支持 NVIDIA RTX 4070 等 CUDA GPU 显存满血加速；
- **Whisper large-v3 / Kotoba**: 支持高精度与多语种识别；
- 顶部导航栏支持运行时一键热切换。

### 5. 持续音频流与自适应 VAD
- 持续环形音频采集，保留开口前约 800ms 前缀缓冲，降低首字丢失概率；
- 80Hz ~ 7500Hz 语音频段带通滤波，削弱低频隆隆声与高频杂音；
- 音频自动峰值响度归一化，提升 ASR 识别率。

### 6. 数据分层与即时持久化
- **分层设计**: 编辑器正文与底层不可变 `TranscriptSegment` 分离，保留原始识别记录与时间戳；
- **即时落盘**: 防抖保存正文与结构化记录，监听 `pagehide` 与 `visibilitychange` 事件，在刷新、关闭或切后台时同步落盘；
- **并发与会话隔离**: 讲话起点绑定会话代数（Epoch），严格防止跨会话状态污染与旧请求复活。

---

## 运行要求

- **Node.js**: >= 18.0
- **Python**: 3.10+（推荐支持 CUDA 12 的 PyTorch 环境）
- **GPU (可选)**: 支持 NVIDIA CUDA 硬件加速

---

## 快速开始

### 1. 安装前端依赖
```bash
npm install
```

### 2. 安装 Python 语音服务依赖
```bash
# 基础依赖 (SenseVoice INT8)
pip install sherpa-onnx soundfile

# 可选 GPU 加速依赖 (Qwen3-ASR / Whisper)
# pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
# pip install qwen-asr faster-whisper
```

### 3. 启动服务
在 Windows 环境下直接运行：
```bat
start.bat
```
或使用 Node 编排脚本启动：
```bash
node scripts/start.mjs
```
服务启动后将自动拉起 Python 后端（8767 端口）与 Vite 前端，并在浏览器中打开 `http://localhost:5174`。

---

## 架构概览

```text
React 19 + TypeScript + Vite
│
├── TopControlBar (模型切换 / 监听控制 / 参数设置)
│
├── DocumentWorkspace
│     └── DocumentEditor (CodeMirror 6 极简纯白内核)
│           ├── Transaction 统一派发 (addToHistory: false)
│           ├── IME / 尾部打字 800ms 空闲调度器
│           └── 80px 容差智能视口与未读悬浮胶囊
│
└── BottomStatusBar (状态指示灯 / 字数统计 / 导出 / 清空)

Audio Pipeline (Web Audio API)
│
├── 持续主音频流采集 (Master Continuous Recording)
├── 800ms 环形前缀缓冲
├── 自适应底噪学习与带通滤波 (80Hz ~ 7500Hz)
└── VAD 静音切句 -> Python 本地 ASR 服务 (127.0.0.1:8767)
```

---

## 环境变量

可通过以下环境变量配置 ASR 后端：

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `SMARTVOICE_HOST` | `127.0.0.1` | 服务监听地址（默认仅本地回环） |
| `SMARTVOICE_PORT` | `8767` | ASR 服务监听端口 |
| `SMARTVOICE_MODELS_DIR` | `D:\resource\AI_WorkSpace\Models` | 外部离线大模型存放目录 |

---

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源。
