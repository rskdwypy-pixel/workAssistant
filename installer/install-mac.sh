#!/usr/bin/env bash
#
# 禅道助手 · Mac 一条命令安装 / 升级 / 卸载
#
#   安装 / 升级：curl -fsSL https://gitee.com/iTreeNewBee/work-assistant/releases/latest/download/install.sh | bash
#   （Gitee 连不上时换成 https://github.com/rskdwypy-pixel/workAssistant/... 的地址）
#   卸载：       bash install.sh --uninstall          （保留数据）
#                bash install.sh --uninstall --purge  （连数据一起删）
#
# 不问任何问题：禅道账号在插件的登录卡片里填，AI 在设置里配（或在插件里导入加密配置文件）。
#
# 安装后的目录（与程序分开存放数据，更新和回滚不碰数据）：
#   ~/Library/Application Support/WorkAssistant/
#     runtime/node/        自带的 Node（不需要另装 Node / Homebrew）
#     versions/<版本>/     程序（保留上一个版本，用于回滚）
#     current.txt          当前版本
#     extension/           浏览器加载的扩展（位置固定，更新时替换里面的文件）
#     bin/                 固定入口：workassistant-run（开机自启）、native-host（浏览器拉起后台）
#     data/                配置（.env）、任务、报告、附件
#     backups/             迁移 / 升级前的备份
#
# 参数（一般用不到）：
#   --package <文件或地址>  使用指定的安装包（默认下载 GitHub 上的最新版本）
#   --no-service            只安装文件，不注册开机自启 / 宿主程序、不启动服务（测试用）
#   --migrate-from <目录>   从旧的仓库目录迁移配置和数据（默认自动识别旧的开机自启项）
#   --uninstall [--purge]   卸载（--purge 连数据一起删）
#
set -euo pipefail

# 整个脚本包在 main 里、最后一行才调用：通过 curl … | bash 运行时脚本是边下载边执行的，
# 先读完整个脚本再执行，子命令也就不会误读走还没执行的脚本内容（下面把标准输入接到 /dev/null）
main() {
exec </dev/null

# 发布源：默认先 Gitee（国内 / 内网更稳），连不上再回退 GitHub
RELEASE_BASES=(
  "https://gitee.com/iTreeNewBee/work-assistant/releases/latest/download"
  "https://github.com/rskdwypy-pixel/workAssistant/releases/latest/download"
)
NODE_VERSION="22.20.0"
LABEL="com.workassistant.backend"
PORT="${WORKASSISTANT_PORT:-3721}"
WA_HOME="${WA_HOME:-$HOME/Library/Application Support/WorkAssistant}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

PACKAGE=""
NO_SERVICE=0
UNINSTALL=0
PURGE=0
MIGRATE_FROM=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package) PACKAGE="${2:-}"; shift 2 ;;
    --no-service) NO_SERVICE=1; shift ;;
    --migrate-from) MIGRATE_FROM="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（--help 查看用法）"; exit 1 ;;
  esac
done

step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "这个安装脚本只支持 macOS（Windows 请用 install.ps1）"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

download() {
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 --progress-bar -o "$2" "$1"
}

backend_alive() {
  curl -s -m 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null | grep -q '"app":"workassistant"'
}

stop_launch_agent() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 40); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
    sleep 0.25
  done
}

# 端口上正在监听的进程（查不到返回空；末尾的 || true 不能省：set -e + pipefail 下，
# 没有进程时 lsof 返回失败，`X="$(port_pid)"` 这样的赋值会让整个脚本静默退出）
port_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
proc_cwd() { lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true; }
proc_cmd() { ps -o command= -p "$1" 2>/dev/null || true; }

# 是不是旧方式（从仓库目录用 nohup / start.sh / npm start）启动的工作助手后台：
# node 进程，工作目录里是工作助手的代码。旧版本的 /health 不带 "app":"workassistant"，只看健康检查认不出来
is_old_workassistant() {
  local pid="$1" cwd
  proc_cmd "$pid" | grep -q node || return 1
  cwd="$(proc_cwd "$pid")"
  [[ -n "$cwd" && -f "$cwd/package.json" && -f "$cwd/src/index.js" ]] || return 1
  grep -q '"name": *"work-assistant"' "$cwd/package.json"
}

# 安装失败时把排查信息直接打出来（日志末尾、端口占用），不用再去翻日志
diagnose() {
  local log="$HOME/Library/Logs/WorkAssistant/backend.log" pid
  echo ""
  echo "  —— 排查信息 ——"
  pid="$(port_pid)"
  if [[ -n "$pid" ]]; then
    echo "  端口 $PORT 被占用：PID $pid  $(proc_cmd "$pid" | cut -c1-120)"
    echo "    工作目录：$(proc_cwd "$pid")"
  else
    echo "  端口 $PORT 没有程序在监听"
  fi
  echo "  开机自启：$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E '^[[:space:]]*(state|last exit code)' | tr -s ' ' | tr '\n' ';' || true)"
  if [[ -f "$log" ]]; then
    echo "  日志末尾（${log}）："
    tail -n 15 "$log" | sed 's/^/    /'
  fi
}

# ==================== 卸载 ====================
if [[ "$UNINSTALL" == "1" ]]; then
  step "卸载禅道助手"
  stop_launch_agent
  rm -f "$PLIST"
  ok "已移除开机自启"
  if [[ -f "$WA_HOME/current.txt" ]]; then
    CUR="$(cat "$WA_HOME/current.txt")"
    [[ -x "$WA_HOME/versions/$CUR/scripts/uninstall-native-host.sh" ]] && bash "$WA_HOME/versions/$CUR/scripts/uninstall-native-host.sh" >/dev/null 2>&1 || true
    ok "已移除浏览器宿主注册"
  fi
  if [[ "$PURGE" == "1" ]]; then
    rm -rf "$WA_HOME"
    ok "已删除 ${WA_HOME}（含数据）"
  else
    rm -rf "$WA_HOME/runtime" "$WA_HOME/versions" "$WA_HOME/bin" "$WA_HOME/extension" "$WA_HOME/downloads" "$WA_HOME/current.txt" "$WA_HOME/previous.txt" "$WA_HOME/update-pending" "$WA_HOME/update-bad.txt"
    ok "程序已删除；数据和配置保留在 $WA_HOME/data（重新安装后自动使用）"
  fi
  echo ""
  echo "  别忘了在浏览器扩展页移除「禅道助手」扩展。"
  exit 0
fi

mkdir -p "$WA_HOME"/{runtime,versions,bin,data,backups}
chmod 700 "$WA_HOME/data" "$WA_HOME/backups"

# ==================== 1. Node 运行环境 ====================
step "准备 Node 运行环境（v${NODE_VERSION}）"
if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then ARCH="arm64"; else ARCH="x64"; fi
NODE_DIR="$WA_HOME/runtime/node"
# 仅供自动测试：用本机现成的 node，不下载
if [[ -n "${WA_TEST_NODE:-}" ]]; then
  mkdir -p "$NODE_DIR/bin"
  ln -sf "$WA_TEST_NODE" "$NODE_DIR/bin/node"
  NODE_VERSION="$("$WA_TEST_NODE" -v | sed 's/^v//')"
fi
if [[ -x "$NODE_DIR/bin/node" && "$("$NODE_DIR/bin/node" -v 2>/dev/null)" == "v$NODE_VERSION" ]]; then
  ok "已就绪（${ARCH}）"
else
  NODE_TGZ="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
  GOT=""
  # 官方源优先，连不上时用国内镜像；两边都用官方发布的 SHASUMS256 校验
  for BASE in "https://nodejs.org/dist" "https://npmmirror.com/mirrors/node"; do
    echo "  下载 $BASE/v$NODE_VERSION/$NODE_TGZ"
    if download "$BASE/v$NODE_VERSION/$NODE_TGZ" "$TMP/$NODE_TGZ" && download "$BASE/v$NODE_VERSION/SHASUMS256.txt" "$TMP/SHASUMS256.txt"; then
      EXPECT="$(grep " $NODE_TGZ\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
      ACTUAL="$(shasum -a 256 "$TMP/$NODE_TGZ" | awk '{print $1}')"
      if [[ -n "$EXPECT" && "$EXPECT" == "$ACTUAL" ]]; then GOT=1; break; fi
      warn "校验不通过，换一个下载源"
    fi
  done
  [[ -n "$GOT" ]] || die "Node 运行环境下载失败（请检查网络后重试）"
  tar -xzf "$TMP/$NODE_TGZ" -C "$TMP"
  rm -rf "$NODE_DIR"
  mv "$TMP/node-v$NODE_VERSION-darwin-$ARCH" "$NODE_DIR"
  ok "已安装（${ARCH}，已校验）"
fi
NODE="$NODE_DIR/bin/node"

# ==================== 2. 程序 ====================
step "安装禅道助手"
if [[ -n "$PACKAGE" && -f "$PACKAGE" ]]; then
  # 指定了本地安装包
  PKG_FILE="$PACKAGE"
  [[ -f "$PACKAGE.sha256" ]] && PKG_SHA="$(awk '{print $1}' "$PACKAGE.sha256")" || PKG_SHA=""
elif [[ -n "$PACKAGE" ]]; then
  # 指定了下载地址
  PKG_FILE="$TMP/workassistant.tar.gz"
  echo "  下载 $PACKAGE"
  download "$PACKAGE" "$PKG_FILE" || die "安装包下载失败（请检查网络后重试）"
  download "$PACKAGE.sha256" "$TMP/pkg.sha256" || die "安装包校验文件下载失败"
  PKG_SHA="$(awk '{print $1}' "$TMP/pkg.sha256")"
else
  # 默认：Gitee 优先，连不上回退 GitHub
  PKG_FILE="$TMP/workassistant.tar.gz"
  GOT=""
  for B in "${RELEASE_BASES[@]}"; do
    SRC_HOST="$(printf '%s' "$B" | awk -F/ '{print $3}')"
    echo "  下载安装包（${SRC_HOST}）"
    if download "$B/workassistant.tar.gz" "$PKG_FILE" && download "$B/workassistant.tar.gz.sha256" "$TMP/pkg.sha256"; then
      PKG_SHA="$(awk '{print $1}' "$TMP/pkg.sha256")"
      GOT="1"; break
    fi
    warn "${SRC_HOST} 下载失败，换下一个源"
  done
  [[ -n "$GOT" ]] || die "安装包下载失败（Gitee 和 GitHub 都连不上，请检查网络或用 --package 指定本地包）"
fi
if [[ -n "${PKG_SHA:-}" ]]; then
  [[ "$(shasum -a 256 "$PKG_FILE" | awk '{print $1}')" == "$PKG_SHA" ]] || die "安装包校验不通过（文件不完整或被改动）"
  ok "安装包已校验"
fi
mkdir -p "$TMP/pkg"
tar -xzf "$PKG_FILE" -C "$TMP/pkg"
PKG_DIR="$(find "$TMP/pkg" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -f "$PKG_DIR/.wa-package" ]] || die "不是禅道助手的安装包"
VERSION="$("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$PKG_DIR/.wa-package")"
PREVIOUS="$(cat "$WA_HOME/current.txt" 2>/dev/null || true)"

rm -rf "$WA_HOME/versions/$VERSION"
mv "$PKG_DIR" "$WA_HOME/versions/$VERSION"
chmod +x "$WA_HOME/versions/$VERSION/scripts/"*.sh
printf '%s\n' "$VERSION" > "$WA_HOME/current.txt"
if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$VERSION" ]]; then
  printf '%s\n' "$PREVIOUS" > "$WA_HOME/previous.txt"
fi
# 只保留当前和上一个版本
KEEP_PREV="$(cat "$WA_HOME/previous.txt" 2>/dev/null || true)"
for d in "$WA_HOME/versions"/*; do
  [[ -d "$d" ]] || continue
  v="$(basename "$d")"
  [[ "$v" == "$VERSION" || "$v" == "$KEEP_PREV" ]] || rm -rf "$d"
done
if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$VERSION" ]]; then
  ok "版本 ${VERSION}（上一个版本 $PREVIOUS 保留，可回滚）"
elif [[ "$PREVIOUS" == "$VERSION" ]]; then
  ok "版本 ${VERSION}（重新安装）"
else
  ok "版本 $VERSION"
fi

# 扩展放在固定位置：更新时替换里面的文件，浏览器里不用重新加载另一个目录
mkdir -p "$WA_HOME/extension"
rsync -a --checksum --delete "$WA_HOME/versions/$VERSION/extension/" "$WA_HOME/extension/"
ok "扩展文件：$WA_HOME/extension"

# 固定入口：切换版本只改 current.txt，开机自启和浏览器宿主注册都不用改（模板在安装包的 scripts/bin/，自动更新时同样会刷新）
cp "$WA_HOME/versions/$VERSION/scripts/bin/workassistant-run" "$WA_HOME/versions/$VERSION/scripts/bin/native-host" "$WA_HOME/bin/"
rm -f "$WA_HOME/update-pending"
chmod +x "$WA_HOME/bin/workassistant-run" "$WA_HOME/bin/native-host"

# ==================== 3. 数据与配置 ====================
step "数据与配置"
if [[ -f "$WA_HOME/data/.env" || -f "$WA_HOME/data/tasks.json" ]]; then
  ok "沿用已有数据：$WA_HOME/data"
else
  # 从旧的仓库目录迁移：显式指定，或由旧的开机自启项认出（WorkingDirectory 指向仓库目录），
  # 或由正在运行的旧后台认出（旧版 install.sh / start.sh 用 nohup 启动，不经过开机自启）
  if [[ -z "$MIGRATE_FROM" && -f "$PLIST" ]]; then
    OLD_DIR="$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST" 2>/dev/null || true)"
    if [[ -n "$OLD_DIR" && "$OLD_DIR" != "$WA_HOME"* && -f "$OLD_DIR/src/index.js" ]]; then MIGRATE_FROM="$OLD_DIR"; fi
  fi
  if [[ -z "$MIGRATE_FROM" ]]; then
    OLD_PID="$(port_pid)"
    if [[ -n "$OLD_PID" ]] && is_old_workassistant "$OLD_PID"; then
      OLD_DIR="$(proc_cwd "$OLD_PID")"
      # 安装版（目录里有 .wa-package）的数据在它自己的 data/ 里，不是从仓库目录迁移的对象
      [[ "$OLD_DIR" != "$WA_HOME"* && ! -f "$OLD_DIR/.wa-package" ]] && MIGRATE_FROM="$OLD_DIR"
    fi
  fi
  if [[ -n "$MIGRATE_FROM" ]]; then
    [[ -d "$MIGRATE_FROM" ]] || die "找不到要迁移的目录：$MIGRATE_FROM"
    STAMP="$(date +%Y%m%d-%H%M%S)"
    BACKUP="$WA_HOME/backups/before-migrate-$STAMP.tar.gz"
    ITEMS=()
    [[ -f "$MIGRATE_FROM/.env" ]] && ITEMS+=(".env")
    [[ -d "$MIGRATE_FROM/data" ]] && ITEMS+=("data")
    if [[ ${#ITEMS[@]} -gt 0 ]]; then
      tar -czf "$BACKUP" -C "$MIGRATE_FROM" "${ITEMS[@]}"
      chmod 600 "$BACKUP"
      [[ -f "$MIGRATE_FROM/.env" ]] && cp "$MIGRATE_FROM/.env" "$WA_HOME/data/.env"
      [[ -d "$MIGRATE_FROM/data" ]] && cp -R "$MIGRATE_FROM/data/." "$WA_HOME/data/"
      ok "已从 $MIGRATE_FROM 迁移配置和数据（迁移前的完整备份：${BACKUP}；原目录未改动）"
    else
      warn "$MIGRATE_FROM 里没有配置和数据，按全新安装处理"
    fi
  else
    ok "全新安装：打开插件后在登录卡片里登录禅道即可"
  fi
fi
[[ -f "$WA_HOME/data/.env" ]] && chmod 600 "$WA_HOME/data/.env"

# ==================== 4. 开机自启、浏览器宿主、启动 ====================
if [[ "$NO_SERVICE" == "1" ]]; then
  step "跳过开机自启和启动（--no-service）"
else
  step "注册开机自启并启动后台服务"
  stop_launch_agent
  for _ in $(seq 1 20); do [[ -z "$(port_pid)" ]] && break; sleep 0.25; done
  # 端口还被占着：旧方式启动的禅道助手后台就停掉它；别的程序不动它，说清楚是谁
  PID_ON_PORT="$(port_pid)"
  if [[ -n "$PID_ON_PORT" ]]; then
    if is_old_workassistant "$PID_ON_PORT"; then
      OLD_DIR="$(proc_cwd "$PID_ON_PORT")"
      # 由 PM2 托管的会被自动拉起，先让 PM2 放手
      if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q '"name":"work-assistant"'; then
        pm2 delete work-assistant >/dev/null 2>&1 || true
      fi
      kill "$PID_ON_PORT" 2>/dev/null || true
      for _ in $(seq 1 20); do [[ -z "$(port_pid)" ]] && break; sleep 0.25; done
      [[ -n "$(port_pid)" ]] && kill -9 "$(port_pid)" 2>/dev/null || true
      sleep 0.5
      ok "已停止旧方式启动的禅道助手后台（${OLD_DIR}）"
    else
      die "端口 $PORT 被另一个程序占用：PID $PID_ON_PORT  $(proc_cmd "$PID_ON_PORT" | cut -c1-120)。请关闭它后重新安装"
    fi
  fi
  [[ -n "$(port_pid)" ]] && { diagnose; die "端口 $PORT 仍被占用，无法启动后台服务"; }
  bash "$WA_HOME/versions/$VERSION/scripts/install-launchagent.sh" >/dev/null
  ok "开机自启已注册"
  bash "$WA_HOME/versions/$VERSION/scripts/install-native-host.sh" >/dev/null && ok "浏览器宿主已注册（插件可按需拉起后台）" || warn "浏览器宿主注册失败（不影响使用，开机自启会拉起后台）"
  for _ in $(seq 1 120); do backend_alive && break; sleep 0.5; done
  backend_alive || { diagnose; die "后台服务 60 秒内没有启动（排查信息见上，日志：~/Library/Logs/WorkAssistant/backend.log）"; }
  RUNNING="$(curl -s -m 2 "http://127.0.0.1:${PORT}/health" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version||"")}catch{console.log("")}})')"
  [[ "$RUNNING" == "$VERSION" ]] || { diagnose; die "后台服务版本是 ${RUNNING:-未知}，应为 ${VERSION}（日志：~/Library/Logs/WorkAssistant/backend.log）"; }
  ok "后台服务已启动（版本 ${VERSION}）"
fi

# ==================== 5. 加载浏览器扩展 ====================
step "加载浏览器扩展"
if [[ "$NO_SERVICE" != "1" ]]; then
  printf '%s' "$WA_HOME/extension" | pbcopy 2>/dev/null && ok "扩展目录已复制到剪贴板"
fi
BROWSER=""
for app in "Google Chrome" "Microsoft Edge" "Brave Browser" "Helium" "Arc" "Vivaldi" "Chromium"; do
  if [[ -d "/Applications/$app.app" || -d "$HOME/Applications/$app.app" ]]; then BROWSER="$app"; break; fi
done
if [[ "$NO_SERVICE" != "1" && -n "$BROWSER" ]]; then
  open -a "$BROWSER" "chrome://extensions/" 2>/dev/null || true
fi
cat <<GUIDE

  在浏览器的扩展页（${BROWSER:-Chrome / Edge 等，地址 chrome://extensions}）：
    1. 打开右上角「开发者模式」（只需一次）
    2. 如果以前加载过「工作助手」或「禅道助手」，先把旧的移除
    3. 点「加载已解压的扩展程序」，按 ⌘⇧G 粘贴目录（已在剪贴板）：
       $WA_HOME/extension
  然后打开一个新标签页：登录禅道，或在登录卡片上导入加密配置文件。

GUIDE
ok "安装完成：禅道助手 $VERSION"
}

main "$@"
