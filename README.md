# SmartVoiceListener

SmartVoiceListener 是一个面向长时间对话场景的**本地离线语音监听与自动分段转写**项目。

当前版本以 **Windows + React 19 + TypeScript + Vite + Python + sherpa-onnx** 为主要可运行链路：麦克风持续监听，在检测到讲话后自动录制，在停顿达到阈值时切出语音片段，并交给本地 ASR 模型转写。

> 当前实现是 **VAD 自动分段 + 低延迟整段 ASR**，还不是“边说边逐字出现”的真正 streaming ASR。Android 原生常驻版本也仍在开发路线中。README 会明确区分“已实现”和“计划实现”。

---

## 当前已实现

### 常驻监听与自动分段

- 浏览器麦克风持续监听，无需手动反复开始/停止录音；
- 自适应 RMS 能量检测，根据环境底噪动态调整起说阈值；
- 默认保留开口前约 **0.8 秒**环形缓冲，降低吞首字概率；
- 默认检测到 **1.5 秒**连续静音后自动结束当前语音段；
- 单段最长默认 **90 秒**，即使连续讲话没有静音也会强制切段；
- 支持在运行中修改 VAD 阈值、停顿时长、前缀缓冲等参数。

> 仓库中会下载 `silero_vad.onnx`，但当前浏览器主链路仍使用自适应 RMS VAD；Silero VAD 尚未接入正式运行路径。

### Windows 本地离线 ASR

默认模型：

- **SenseVoice INT8 / sherpa-onnx**：默认低延迟本地识别路径；
- **Whisper large-v3 / faster-whisper**：可选高精度模型；
- **Kotoba-v2-faster**：可选日文/双语模型；
- **Qwen3-ASR 1.7B**：可选大模型后端。

模型通过统一的 `ModelManager` 管理，可由前端切换。Whisper 与 Qwen 相关 Python 包改为**按需导入**，只使用 SenseVoice 时不再要求先安装全部可选引擎。

### 本地运行安全

ASR 服务默认仅监听：

```text
127.0.0.1:8767
```

不会默认暴露到局域网。

可通过环境变量覆盖：

```text
SMARTVOICE_HOST
SMARTVOICE_PORT
SMARTVOICE_MODELS_DIR
```

其中 `SMARTVOICE_MODELS_DIR` 用于指定 Whisper / Kotoba / Qwen 等外部模型目录。

### 前端

- React 19 + TypeScript + Vite；
- 监听/讲话/停顿/转写状态展示；
- 声音强度可视化；
- 转录历史、复制、删除、清空；
- Markdown 导出；
- 多模型选择；
- Blob 音频 URL 在删除记录、清空记录及页面卸载时主动释放，降低长时间运行造成的内存泄漏风险。

---

## 当前工作流

```text
Microphone
   ↓
Web Audio API
   ↓
Adaptive RMS VAD
   ↓
Prefix ring buffer
   ↓
Speech segment
   ↓
PCM → WAV
   ↓
HTTP POST /api/asr
   ↓
Local ASR
   ↓
Final transcript
```

这意味着当前字幕会在一个语音段结束后返回，例如：

```text
讲话中……
讲话中……
停顿 1.5 秒
↓
“我觉得下一阶段应该先把核心功能做完。”
```

而不是目前尚未实现的：

```text
“我觉得▌”
“我觉得下一阶段▌”
“我觉得下一阶段应该先把核心功能▌”
```

---

## 启动

### 一键启动

Windows 下直接运行：

```text
start.bat
```

或：

```bash
node scripts/start.mjs
```

启动流程会：

1. 检查前端依赖；
2. 检查/准备本地 SenseVoice 模型；
3. 启动本地 Python ASR 服务；
4. 启动 Vite；
5. 打开浏览器界面。

默认访问：

```text
http://localhost:5174
```

ASR 服务默认：

```text
http://127.0.0.1:8767
```

---

## 项目结构

```text
SmartVoiceListener/
├── src/
│   ├── components/
│   │   ├── AudioVisualizer.tsx
│   │   ├── StatusHeader.tsx
│   │   ├── TranscriptCard.tsx
│   │   ├── ControlFloatingBar.tsx
│   │   ├── SettingsModal.tsx
│   │   └── Icons.tsx
│   ├── hooks/
│   │   └── useVoiceListener.ts
│   ├── services/
│   │   ├── asrService.ts
│   │   ├── vadEngine.ts
│   │   └── storageService.ts
│   ├── types/
│   │   └── index.ts
│   ├── styles/
│   │   └── index.css
│   ├── App.tsx
│   └── main.tsx
├── server/
│   └── asr_server.py
├── models/
├── scripts/
├── start.bat
├── test_engine.py
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 已知限制

### 1. 还不是真正的 Streaming ASR

SenseVoice 当前通过 `sherpa_onnx.OfflineRecognizer` 对 VAD 切出的完整语音段做识别。

下一阶段计划加入：

```text
Streaming Zipformer / OnlineRecognizer
        ↓
partial transcript
        ↓
SenseVoice / Whisper / Qwen final correction
```

最终形成 `partial + final` 双轨字幕。

### 2. 浏览器音频仍使用 ScriptProcessorNode

当前 MVP 为兼容现有实现仍使用 `ScriptProcessorNode`。正式 Windows 客户端计划迁移至 **AudioWorklet**，避免依赖已废弃 API。

### 3. Android 原生版本尚未落库

当前仓库没有完整的 Android 原生运行链路。

目标架构：

```text
React / TypeScript UI
        ↓
Capacitor native bridge
        ↓
Android Foreground Service
        ↓
AudioRecord
        ↓
Silero VAD
        ↓
sherpa-onnx AAR
        ↓
Streaming ASR
```

Foreground Service 用于在切后台、锁屏等场景下维持用户明确开启的持续转录任务。

### 4. 历史文字使用 localStorage

当前文字记录保存在 localStorage，音频 Blob 只在当前运行时有效。后续计划迁移到 IndexedDB / SQLite，以支持真正的长时间会议历史与音频持久化。

---

## 下一阶段优先级

1. Windows `ScriptProcessorNode` → `AudioWorklet`；
2. 接入 sherpa-onnx streaming Zipformer / `OnlineRecognizer`；
3. 建立 `partial` / `final` transcript 数据模型；
4. 接入真正的 Silero VAD；
5. Android：Capacitor + Foreground Service + AudioRecord + sherpa-onnx AAR；
6. IndexedDB / SQLite 持久化；
7. 长时间运行、内存、丢帧和后台生命周期测试。

---

## 目标

SmartVoiceListener 最终希望成为一个：

> **Windows + Android、本地优先、可长时间常驻、真正实时的跨平台语音转录工具。**
