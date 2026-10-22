#!/usr/bin/env node
/**
 * 打安装包：dist/workassistant-<版本>.tar.gz（+ .sha256）
 *
 * 包里是一个版本目录（安装后放在 WorkAssistant/versions/<版本>/）：
 *   src/  extension/  scripts/（启动器、开机自启、宿主注册；bin/ 是安装目录 bin/ 下固定入口的模板，Mac 与 Windows 的都在）  package.json  package-lock.json
 *   node_modules/（只含运行依赖；没有原生模块，Mac / Windows / Linux 通用）
 *   .wa-package（标记：脚本据此认出安装版目录结构；记录版本和需要的 Node 版本）
 * Node 运行环境不在包里，由安装器按系统和芯片单独下载。自动更新不换 Node：
 * 新版本需要更高的 Node 时，后台会提示重新运行安装命令。
 *
 * 版本号以 package.json 为准，打包时同步到 extension/manifest.json。
 * 签名另外做：node scripts/sign-package.mjs dist/workassistant-<版本>.tar.gz（发版流水线自动完成）。
 *
 * 用法：node scripts/build-package.mjs [--out dist]
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { syncVersion } from './sync-version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : join(ROOT, 'dist');

// 安装版需要的脚本（其余开发、测试脚本不打包）
const SCRIPTS = [
  'common.sh', 'backend-launcher.sh',
  'install-launchagent.sh', 'uninstall-launchagent.sh',
  'install-native-host.sh', 'uninstall-native-host.sh'
];

// 版本号以 package.json 为准，同步到扩展（manifest.json、newtab.html）
const { version, changed } = syncVersion();
if (changed.length) console.log(`已把版本号同步为 ${version}：${changed.join('、')}`);

// 安装器自带的 Node 版本：写进 .wa-package，自动更新时据此判断能不能直接换
const NODE_VERSION = (readFileSync(join(ROOT, 'installer', 'install-mac.sh'), 'utf8').match(/^NODE_VERSION="([\d.]+)"/m) || [])[1];
if (!NODE_VERSION) throw new Error('installer/install-mac.sh 里找不到 NODE_VERSION');
const NODE_VERSION_WIN = (readFileSync(join(ROOT, 'installer', 'install.ps1'), 'utf8').match(/^\$NodeVersion = '([\d.]+)'/m) || [])[1];
if (NODE_VERSION_WIN !== NODE_VERSION) throw new Error(`两个安装器自带的 Node 版本不一致：install-mac.sh ${NODE_VERSION}，install.ps1 ${NODE_VERSION_WIN}`);

const name = `workassistant-${version}`;
const stage = join(OUT, 'stage', name);
rmSync(join(OUT, 'stage'), { recursive: true, force: true });
mkdirSync(join(stage, 'scripts'), { recursive: true });

cpSync(join(ROOT, 'src'), join(stage, 'src'), { recursive: true });
cpSync(join(ROOT, 'extension'), join(stage, 'extension'), { recursive: true, filter: (p) => !/\/\.DS_Store$/.test(p) });
for (const f of SCRIPTS) cpSync(join(ROOT, 'scripts', f), join(stage, 'scripts', f));
cpSync(join(ROOT, 'scripts', 'bin'), join(stage, 'scripts', 'bin'), { recursive: true });
cpSync(join(ROOT, 'package.json'), join(stage, 'package.json'));
cpSync(join(ROOT, 'package-lock.json'), join(stage, 'package-lock.json'));
writeFileSync(join(stage, '.wa-package'), JSON.stringify({ app: 'workassistant', version, node: NODE_VERSION, builtAt: new Date().toISOString() }, null, 2) + '\n');

// 只装运行依赖（不跑依赖的安装脚本：本项目的依赖都是纯 JS）
console.log('安装运行依赖…');
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: stage, stdio: 'inherit' });
const native = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.node')) native.push(p);
  }
};
walk(join(stage, 'node_modules'));
if (native.length) throw new Error(`运行依赖里出现了原生模块，安装包不能跨系统通用：${native.join(', ')}`);

mkdirSync(OUT, { recursive: true });
const tarball = join(OUT, `${name}.tar.gz`);
rmSync(tarball, { force: true });
execFileSync('tar', ['-czf', tarball, '-C', join(OUT, 'stage'), name], { stdio: 'inherit' });
const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
writeFileSync(`${tarball}.sha256`, `${sha}  ${name}.tar.gz\n`);
rmSync(join(OUT, 'stage'), { recursive: true, force: true });

const size = (readFileSync(tarball).length / 1024 / 1024).toFixed(1);
console.log(`\n✅ ${tarball}（${size} MB）\n   sha256 ${sha}`);
if (!existsSync(tarball)) process.exit(1);
