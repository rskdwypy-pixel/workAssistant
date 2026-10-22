/**
 * 与系统有关的提示文字：安装命令、日志位置、终端名称（Mac / Windows）
 * 新标签页和 background.js（importScripts）共用。
 */
const WA_IS_WINDOWS = /^win/i.test((typeof navigator !== 'undefined'
  && ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform)) || '');
const WA_RELEASE_URL = 'https://github.com/rskdwypy-pixel/workAssistant/releases/latest/download';
const WA_INSTALL_COMMAND = WA_IS_WINDOWS
  ? `curl.exe -fsSL -o "$env:TEMP\\wa-install.ps1" ${WA_RELEASE_URL}/install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\wa-install.ps1"`
  : `curl -fsSL ${WA_RELEASE_URL}/install.sh | bash`;
const WA_LOG_PATH = WA_IS_WINDOWS ? '%LOCALAPPDATA%\\WorkAssistant\\logs\\backend.log' : '~/Library/Logs/WorkAssistant/backend.log';
const WA_TERMINAL = WA_IS_WINDOWS ? 'PowerShell' : '终端';
const WA_OS_NAME = WA_IS_WINDOWS ? 'Windows' : 'macOS';
