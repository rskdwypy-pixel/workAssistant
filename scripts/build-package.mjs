#!/usr/bin/env node
/**
 * 打安装包：dist/workassistant-<版本>.tar.gz（+ .sha256）
 *
 * 包里是一个版本目录（安装后放在 WorkAssistant/versions/<版本>/）：
 *   src/  extension/  scripts/（启动器、开机自启、宿主注册）  package.json  package-lock.json
 *   node_modules/（只含运行依赖；没有原生模块，Mac / Windows / Linux 通用）
 *   .wa-package（标记：脚本据此认出安装版目录结构）
 * Node 运行环境不在包里，由安装器按系统和芯片单独下载。
 *
 * 版本号以 package.json 为准，打包时同步到 extension/manifest.json。
 *
 * 用法：node scripts/build-package.mjs [--out dist]
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? process.argv[outArg + 1] : join(ROOT, 'dist');

// 安装版需要的脚本（其余开发、测试脚本不打包）
const SCRIPTS = [
  'common.sh', 'backend-launcher.sh',
  'install-launchagent.sh', 'uninstall-launchagent.sh',
  'install-native-host.sh', 'uninstall-native-host.sh'
];

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json 的版本号不合法：${version}`);

// 扩展版本号与 package.json 保持一致
const manifestPath = join(ROOT, 'extension', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.version !== version) {
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`已把 extension/manifest.json 的版本号同步为 ${version}`);
}
if (!manifest.key) throw new Error('extension/manifest.json 缺少 key（固定扩展 ID 需要）');

const name = `workassistant-${version}`;
const stage = join(OUT, 'stage', name);
rmSync(join(OUT, 'stage'), { recursive: true, force: true });
mkdirSync(join(stage, 'scripts'), { recursive: true });

cpSync(join(ROOT, 'src'), join(stage, 'src'), { recursive: true });
cpSync(join(ROOT, 'extension'), join(stage, 'extension'), { recursive: true, filter: (p) => !/\/\.DS_Store$/.test(p) });
for (const f of SCRIPTS) cpSync(join(ROOT, 'scripts', f), join(stage, 'scripts', f));
cpSync(join(ROOT, 'package.json'), join(stage, 'package.json'));
cpSync(join(ROOT, 'package-lock.json'), join(stage, 'package-lock.json'));
writeFileSync(join(stage, '.wa-package'), JSON.stringify({ app: 'workassistant', version, builtAt: new Date().toISOString() }, null, 2) + '\n');

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
