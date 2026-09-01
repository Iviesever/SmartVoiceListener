import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// ANSI 颜色格式化
const cyan = text => `\x1b[36m${text}\x1b[0m`;
const green = text => `\x1b[32m${text}\x1b[0m`;
const yellow = text => `\x1b[33m${text}\x1b[0m`;
const red = text => `\x1b[31m${text}\x1b[0m`;
const bold = text => `\x1b[1m${text}\x1b[0m`;

console.log(cyan('========================================================'));
console.log(bold(yellow('  智能语音监听与分段转写系统 (SmartVoiceListener)')));
console.log(cyan('  架构: Dual-Pass Streaming ASR (Paraformer + SenseVoice/Qwen3)'));
console.log(cyan('========================================================\n'));

const isWin = process.platform === 'win32';

// 1. 检查 node_modules
const nodeModulesPath = resolve(rootDir, 'node_modules');
if (!existsSync(nodeModulesPath)) {
  console.log(yellow('[提示] 未检测到前端依赖包 (node_modules)，正在自动安装...'));
  const cmd = isWin ? 'cmd.exe' : 'npm';
  const args = isWin ? ['/c', 'npm', 'install'] : ['install'];
  const installRes = spawnSync(cmd, args, { cwd: rootDir, stdio: 'inherit' });

  if (installRes.status !== 0) {
    console.log(red('\n[错误] npm install 执行失败，请检查 Node.js 与网络环境！'));
    process.exit(1);
  }
  console.log(green('[成功] 前端依赖安装完成！\n'));
}

// 2. 检查模型文件完整性 (流式 Paraformer 与本地 SenseVoiceSmall 均为系统启动底座)
const modelsDir = resolve(rootDir, 'models');
const paraformerDir = resolve(modelsDir, 'sherpa-onnx-streaming-paraformer-bilingual-zh-en');
const paraformerEncoder = existsSync(resolve(paraformerDir, 'encoder.int8.onnx'));
const paraformerDecoder = existsSync(resolve(paraformerDir, 'decoder.int8.onnx'));
const paraformerTokens = existsSync(resolve(paraformerDir, 'tokens.txt'));
const streamingReady = paraformerEncoder && paraformerDecoder && paraformerTokens;

const localSenseVoiceDir = 'D:\\resource\\AI_WorkSpace\\Models\\SenseVoiceSmall';
const localSenseVoiceReady =
  existsSync(localSenseVoiceDir) &&
  existsSync(resolve(localSenseVoiceDir, 'model.pt')) &&
  existsSync(resolve(localSenseVoiceDir, 'config.yaml'));

if (!streamingReady) {
  console.log(yellow('[提示] 检测到流式 Paraformer 模型不完整，正在自动补全/拉取模型...'));
  const pyCmd = isWin ? 'python' : 'python3';
  const dlRes = spawnSync(pyCmd, ['download_models.py'], { cwd: rootDir, stdio: 'inherit' });
  if (dlRes.status !== 0) {
    console.log(red('[错误] download_models.py 执行失败，请检查网络连接！'));
    process.exit(1);
  }
}

const paraformerReadyAfter =
  existsSync(resolve(paraformerDir, 'encoder.int8.onnx')) &&
  existsSync(resolve(paraformerDir, 'decoder.int8.onnx')) &&
  existsSync(resolve(paraformerDir, 'tokens.txt'));

if (!paraformerReadyAfter) {
  console.log(red('\n[错误] Streaming Paraformer 模型缺失，流式服务无法启动！'));
  process.exit(1);
}

if (!localSenseVoiceReady) {
  console.log(yellow(`\n[警告] 本地 SenseVoiceSmall 未在 ${localSenseVoiceDir} 找到，可能影响该模型定稿。`));
}
console.log(green('[✓] 核心流式与定稿模型全部就绪！\n'));

// 3. 查找支持 GPU (CUDA) 的最佳 Python 解释器
const condaPy = 'D:\\resource\\miniconda3\\envs\\auto-sub\\python.exe';
const pyCmd = existsSync(condaPy) ? condaPy : (isWin ? 'python' : 'python3');

console.log(green(`[后端] 正在启动 Python 离线语音识别引擎 (8767 端口)...`));
console.log(cyan(`[环境] 使用解释器: ${pyCmd}`));
const asrProcess = spawn(pyCmd, ['server/asr_server.py'], {
  cwd: rootDir,
  stdio: 'inherit',
});

asrProcess.on('error', (err) => {
  console.log(red(`[警告] Python ASR 服务启动失败: ${err.message}`));
});

// 退出时自动清理子进程
const cleanup = () => {
  console.log(yellow('\n[*] 正在停止语音识别与前端服务...'));
  try {
    if (asrProcess && !asrProcess.killed) {
      if (isWin) {
        spawnSync('taskkill', ['/pid', asrProcess.pid.toString(), '/f', '/t']);
      } else {
        asrProcess.kill('SIGTERM');
      }
    }
  } catch {
    // ignore
  }
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// 4. 启动 Vite 开发服务器并自动打开浏览器
console.log(green('[前端] 正在启动 Vite 极简亮色 React 界面并自动打开浏览器...'));
console.log(cyan('[地址] http://localhost:5174/\n'));

const cmd = isWin ? 'cmd.exe' : 'npm';
const args = isWin ? ['/c', 'npm', 'run', 'dev', '--', '--open'] : ['run', 'dev', '--', '--open'];
const viteProcess = spawn(cmd, args, { cwd: rootDir, stdio: 'inherit' });

viteProcess.on('exit', () => {
  cleanup();
});
