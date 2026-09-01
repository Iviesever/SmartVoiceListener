# 智能语音监听与分段转写系统 (SmartVoiceListener)

基于 **React 19 + TypeScript + Vite** 与 **`sherpa-onnx` (SenseVoice + Silero-VAD)** 的跨平台离线语音监听与自动分段转写系统。

---

## 🌟 核心特性

1. **常驻智能 VAD 监听（开口即录，讲完即转）**：
   - 麦克风低功耗常驻监听，静默状态零算力消耗；
   - 听到人声开口自动触发录音，并向前追溯 0.5s 环形音频缓冲（**绝不吞第一个字**）；
   - 领导讲完停顿 1.2 秒（可调节）自动切出音频片段送入识别。
2. **多模型/双引擎自由热切换框架**：
   - ⚡ **`SenseVoice (sherpa-onnx INT8)`**：毫秒级响应（120ms），CPU 超低功耗日常常驻监听首选；
   - 👑 **`Whisper large-v3 (faster-whisper)`**：直接加载 `D:\resource\AI_WorkSpace\Models\large-v3`，提供顶级转写精度；
   - 🇯🇵 **`Kotoba-v2-faster`**：直接加载 `D:\resource\AI_WorkSpace\Models\kotoba-v2-faster`；
   - 支持在界面顶部下拉选单**一键动态热切换**，无需重启服务。
3. **极简亮色设计语言（无 Emoji / 无毛玻璃）**：
   - 纯净白底与浅灰基调（`#ffffff` / `#f8fafc`），清爽高级；
   - 纯内联矢量 SVG 图标，禁止一切 Emoji；
   - 极简声波动态条形可视化（呼吸与脉动动效）；
   - 流式段落卡片、时间戳、一键复制与 Markdown 格式一键导出。
4. **跨平台支持 (Windows + Android)**：
   - **Windows**：开箱即用，通过 Web Audio API 与本地 Python 8767 服务通信；
   - **Android**：可通过 Capacitor 封装直接调用 `sherpa-onnx` 原生 AAR 库，100% 脱机运行。

---

## 🚀 极速启动指南

### 1. 一键启动 (推荐)
直接双击项目根目录下的 **`start.bat`**，将自动执行：
1. 自动检查并安装前端依赖包（若首次运行）；
2. 自动检查并就绪 `sherpa-onnx` 离线模型；
3. 后台启动 Python 离线语音识别引擎（8767 端口）；
4. 启动 Vite 开发服务器并**自动在浏览器中打开页面**；
5. 按 `Ctrl + C` 退出时**自动关闭前后端子进程**，无孤儿进程残留。

也可以通过 Node.js 启动：
```bash
node scripts/start.mjs
```

### 2. 访问界面
在浏览器中打开：**`http://localhost:5174`**，点击底部的 **“开启常驻监听”** 即可开始体验！

---

## 📁 项目结构

```
D:\program\SmartVoiceListener/
├── src/
│   ├── components/
│   │   ├── AudioVisualizer.tsx       # 极简动态声波（纯净浅绿/浅蓝波形线条）
│   │   ├── StatusHeader.tsx          # 顶部状态栏（极简状态胶囊与健康指示灯）
│   │   ├── TranscriptCard.tsx        # 极简白底卡片（时间戳、段落正文、SVG 复制/删除按钮）
│   │   ├── ControlFloatingBar.tsx    # 底部极简白底控制栏（大圆主控按钮 + 功能 SVG 图标）
│   │   ├── SettingsModal.tsx         # 极简设置弹窗（VAD 灵敏度、停顿判定 1.2s、前缀缓冲）
│   │   └── Icons.tsx                 # 统一管理全部 SVG 矢量图标库 (无 Emoji)
│   ├── hooks/
│   │   └── useVoiceListener.ts       # 核心状态机：常驻监听、自动切片、派发转写
│   ├── services/
│   │   ├── asrService.ts             # 统一 ASR 转写适配器 (多 candidate 探测)
│   │   ├── vadEngine.ts              # Web Audio VAD 能量检测与环形缓冲切片算法
│   │   └── storageService.ts         # 本地历史记录持久化
│   ├── types/
│   │   └── index.ts                  # 全局 TypeScript 类型定义
│   ├── styles/
│   │   └── index.css                 # 极简亮色现代设计系统
│   ├── App.tsx                       # 顶层布局
│   └── main.tsx                      # 入口
├── server/
│   └── asr_server.py                 # Windows 离线转写服务端 (sherpa-onnx + SenseVoice)
├── models/                           # 离线 ONNX 模型 (VAD + SenseVoice)
├── start.bat                         # 一键启动脚本
├── test_engine.py                    # 引擎测试脚本
├── package.json
├── tsconfig.json
└── vite.config.ts
```
