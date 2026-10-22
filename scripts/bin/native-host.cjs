/**
 * 浏览器宿主程序（Windows；Mac 上是 scripts/backend-launcher.sh）
 *
 * 插件调用 connectNative() 时由浏览器拉起，只做一件事：确保后台在跑，按 Native Messaging 协议回报后退出。
 *   1. 后台已在跑 → {type:"ready", reused:true}
 *   2. 否则拉起守护进程（bin\workassistant.vbs，隐藏窗口）→ 等端口就绪 → {type:"ready", startedBy:"supervisor"}
 *   3. 15 秒内没就绪 → {type:"error", reason}
 *
 * 守护进程通过 WMI（Win32_Process.Create）创建，不作为本进程的子进程：浏览器结束宿主时会连同它拉起的
 * 子进程一起结束，后台就跟着浏览器退出了。WMI 不可用时退回普通的分离启动。
 * stdout 是给浏览器的消息通道，只能写 Native Messaging 帧；诊断信息写 stderr。
 */
const { execFile, spawn } = require('child_process');
const http = require('http');
const path = require('path');

const WA_HOME = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.WORKASSISTANT_PORT || '3721', 10);
const VBS = path.join(__dirname, 'workassistant.vbs');

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

function alive() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1500 }, (res) => {
      let s = '';
      res.on('data', d => { s += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(s).app === 'workassistant'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 去掉 PSModulePath：从 PowerShell 7 里拉起的浏览器会带着 7 的模块路径，Windows PowerShell 5.1 继承后加载不上自带命令
function psEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.PSModulePath;
  return env;
}

function startViaWmi() {
  return new Promise((resolve) => {
    const script = '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = (\'wscript.exe "\' + $env:WA_VBS + \'"\'); CurrentDirectory = $env:WA_HOME }; exit $r.ReturnValue';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      timeout: 15000,
      env: psEnv({ WA_VBS: VBS, WA_HOME })
    }, (err) => resolve(!err));
  });
}

function startDetached() {
  spawn('wscript.exe', [VBS], { cwd: WA_HOME, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function main() {
  if (await alive()) {
    process.stderr.write('workassistant-backend: 后台已在运行，复用\n');
    return send({ type: 'ready', reused: true });
  }
  if (!(await startViaWmi())) {
    process.stderr.write('workassistant-backend: WMI 启动失败，改用分离启动\n');
    startDetached();
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await alive()) return send({ type: 'ready', startedBy: 'supervisor' });
  }
  send({ type: 'error', reason: `后台 15 秒内未就绪，详见日志 ${path.join(WA_HOME, 'logs', 'backend.log')}` });
  process.exitCode = 1;
}

main();
