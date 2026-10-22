#!/usr/bin/env bash
# 注册 Native Messaging 宿主，让浏览器在插件请求时自动拉起后端
#
# 背景：MV3 扩展无法直接启动本地进程（无 child_process、service worker 会被回收）。
# 浏览器官方的解决方案是 Native Messaging：插件调用 chrome.runtime.connectNative()
# 时，浏览器会自动启动这里注册的宿主进程。
#
# 关键设计（踩过坑才这么写）：
#   1. 注册目录由「浏览器的产品标识」决定，不是「装没装 Chrome」。
#      Chrome 读 ~/Library/Application Support/Google/Chrome/，
#      Edge 读 .../Microsoft Edge/，Helium 读 .../net.imput.helium/（用的是 bundle id）。
#      早期版本把 6 个 Chrome 路径写死，换台没装 Chrome 的电脑（比如用 Edge /
#      Brave / Helium）就完全失效。本脚本改为自动探测本机所有浏览器。
#   2. 宿主注册文件在扩展沙箱之外，插件自己写不了，必须由用户执行一次。
#   3. 浏览器启动宿主时不继承 shell 环境变量，node 绝对路径必须落盘。
#   4. allowed_origins 必须写扩展的真实 ID。unpacked 扩展（manifest.json 无 key 字段）
#      的 ID 由「安装路径的 SHA-256」派生，换机/换路径都会变，且 Chromium 官方文档
#      明确 allowed_origins 不支持通配符——所以不能写死 ID，也不能用 chrome-extension://*/。
#      本脚本按当前仓库路径自动计算，并允许 --extension-id / WORKASSISTANT_EXT_ID 覆盖。
#
# 用法：
#   bash scripts/install-native-host.sh                    # 注册到所有已探测到的浏览器
#   bash scripts/install-native-host.sh --detect           # 只探测不写入，用于排查
#   bash scripts/install-native-host.sh --browser "Helium" # 只注册指定浏览器
#   bash scripts/install-native-host.sh --extension-id ID  # 手动指定扩展 ID

set -euo pipefail

HOST_NAME="com.workassistant.backend"
HOST_DESC="工作助手本地后端服务"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="$PROJECT_DIR/scripts/backend-launcher.sh"
NODE_PATH_FILE="$PROJECT_DIR/scripts/.node-path"
# shellcheck source=common.sh
source "$PROJECT_DIR/scripts/common.sh"
# Firefox 扩展 ID（about:debugging 中可见）；不提供则跳过 Firefox，避免写一个必然连不上的空授权清单
FIREFOX_EXT_ID="${WORKASSISTANT_FIREFOX_EXT_ID:-}"

DETECT_ONLY=0
ONLY_BROWSER=""
EXT_ID_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --detect|--dry-run|-n)
      DETECT_ONLY=1
      shift
      ;;
    --browser|-b)
      ONLY_BROWSER="${2:-}"
      shift 2 || shift
      ;;
    --extension-id|-e)
      EXT_ID_OVERRIDE="${2:-}"
      shift 2 || shift
      ;;
    -h|--help)
      sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数: $1（用 --help 查看用法）"
      exit 1
      ;;
  esac
done

# ─────────────────────────────────────────────────────────────
# 浏览器识别表
#
# Chromium 系：注册目录 = Application Support 下的一个子目录，
#   不同发行版命名规则不同（Google 用 "Google/Chrome"，多数第三方用 bundle id）。
# Firefox 系：目录固定为 Mozilla/NativeMessagingHosts，且 JSON 字段不同
#   （allowed_extensions 而非 allowed_origins），必须单独生成。
# ─────────────────────────────────────────────────────────────

# bundle_id|显示名|Application Support 相对目录|类型
# 类型：chromium | firefox
BROWSER_TABLE="
com.google.Chrome|Google Chrome|Google/Chrome|chromium
com.google.Chrome.beta|Google Chrome Beta|Google/Chrome Beta|chromium
com.google.Chrome.canary|Google Chrome Canary|Google/Chrome Canary|chromium
com.google.Chrome.for.testing|Google Chrome for Testing|Google/Chrome for Testing|chromium
com.google.Chrome.headless|Google Chrome-headless|Google/Chrome-headless|chromium
org.chromium.Chromium|Chromium|Chromium|chromium
com.microsoft.edgemac|Microsoft Edge|Microsoft Edge|chromium
com.brave.Browser|Brave Browser|BraveSoftware/Brave-Browser|chromium
net.imput.helium|Helium|net.imput.helium|chromium
company.thebrowser.Browser|Arc|Arc/User Data|chromium
com.vivaldi.Vivaldi|Vivaldi|Vivaldi|chromium
com.operasoftware.Opera|Opera|com.operasoftware.Opera|chromium
com.operasoftware.OperaNext|Opera GX|com.operasoftware.OperaNext|chromium
org.mozilla.firefox|Firefox|Mozilla/NativeMessagingHosts|firefox
org.mozilla.firefoxdeveloperedition|Firefox Developer Edition|Mozilla/NativeMessagingHosts|firefox
"

# 从 Info.plist 读值（不依赖 PlistBuddy，兼容老系统）
read_plist_value() {
  local plist="$1" key="$2"
  /usr/libexec/PlistBuddy -c "Print :$key" "$plist" 2>/dev/null || true
}

# 输出已安装浏览器的 TSV：bundle_id<TAB>显示名<TAB>目录<TAB>类型<TAB>app路径
detect_browsers() {
  local app_dirs=("/Applications" "$HOME/Applications")
  local entry app plist bid name rel type found

  while IFS='|' read -r bid name rel type; do
    [[ -z "$bid" ]] && continue
    found=""
    for d in "${app_dirs[@]}"; do
      # bundle id 反查 app 名很麻烦，改为遍历 app 目录后比对 plist
      :
    done

    for d in "${app_dirs[@]}"; do
      [[ -d "$d" ]] || continue
      for app in "$d"/*.app; do
        [[ -d "$app" ]] || continue
        plist="$app/Contents/Info.plist"
        [[ -f "$plist" ]] || continue
        # 快速过滤：路径里含浏览器关键字才读 plist，减少开销
        case "$app" in
          *Chrome*|*Chromium*|*Edge*|*Brave*|*Helium*|*Arc*|*Vivaldi*|*Opera*|*Firefox*)
            ;;
          *)
            continue
            ;;
        esac
        name_found="$(read_plist_value "$plist" CFBundleIdentifier)"
        if [[ "$name_found" == "$bid" ]]; then
          found="$app"
          break 2
        fi
      done
    done

    if [[ -n "$found" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\n' "$bid" "$name" "$rel" "$type" "$found"
    fi
  done <<< "$BROWSER_TABLE"
}

# ─────────────────────────────────────────────────────────────
# 扩展 ID 计算
#
# unpacked 扩展（manifest.json 无 "key" 字段）的 ID 不是随机值：
# Chromium 取「扩展目录绝对路径的 SHA-256」前 32 个十六进制字符，
# 再按 0-9→a-j、a-f→k-p 映射成 32 位字母，即 chrome://extensions 上显示的 ID。
# 因此：
#   - 换了安装路径（仓库搬家等）ID 会变，重跑本脚本即可同步；
#   - 这里算出的值必须和浏览器扩展管理页里显示的完全一致，
#     不一致时（例如从副本目录加载）用 --extension-id 手动指定。
# ─────────────────────────────────────────────────────────────
compute_extension_id() {
  local ext_dir="$1" hex=""
  if command -v shasum >/dev/null 2>&1; then
    hex="$(printf '%s' "$ext_dir" | shasum -a 256 | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    hex="$(printf '%s' "$ext_dir" | openssl dgst -sha256 | awk '{print $NF}')"
  fi
  [[ ${#hex} -ge 32 ]] || { echo ""; return 1; }
  printf '%s' "${hex:0:32}" | tr '0-9a-f' 'a-p'
}

# 生成宿主 JSON
#   $1=类型 chromium|firefox
#   $2=目标目录
write_host_file() {
  local kind="$1" target_dir="$2"

  mkdir -p "$target_dir"

  if [[ "$kind" == "firefox" ]]; then
    # Firefox 的 native messaging 清单格式不同：用 allowed_extensions（Firefox 扩展 ID）
    cat > "$target_dir/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "$HOST_DESC",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_extensions": ["$FIREFOX_EXT_ID"]
}
JSON
  else
    # Chromium 系：allowed_origins 不支持通配符（官方文档明令禁止），
    # 只能列出真实扩展 ID；unpacked 扩展的 ID 由安装路径派生，故按当前
    # 仓库路径动态计算，换机/换路径重跑本脚本即可保持同步。
    cat > "$target_dir/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "$HOST_DESC",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
JSON
  fi
}

# ─────────────────────────────────────────────────────────────
# 开始
# ─────────────────────────────────────────────────────────────

if [[ ! -f "$LAUNCHER" ]]; then
  echo "❌ 找不到启动器: $LAUNCHER"
  exit 1
fi

chmod +x "$LAUNCHER"

NODE_BIN="$(wa_resolve_node_for_install || true)"

# ── 解析扩展 ID（Chromium 系授权必需；Firefox 分支不使用） ──
if [[ -n "$EXT_ID_OVERRIDE" ]]; then
  EXTENSION_ID="$EXT_ID_OVERRIDE"
elif [[ -n "${WORKASSISTANT_EXT_ID:-}" ]]; then
  EXTENSION_ID="$WORKASSISTANT_EXT_ID"
else
  EXTENSION_ID="$(compute_extension_id "$PROJECT_DIR/extension")"
fi

echo "════════════════════════════════════════════"
echo "  工作助手 · 后端自动启动宿主注册"
echo "════════════════════════════════════════════"
echo "  项目目录: $PROJECT_DIR"
echo ""

if [[ -z "$EXTENSION_ID" ]]; then
  echo "❌ 无法计算扩展 ID（需要 shasum 或 openssl）"
  echo ""
  echo "   请手动指定（ID 在浏览器扩展管理页可见）："
  echo "     bash scripts/install-native-host.sh --extension-id <扩展ID>"
  echo ""
  exit 1
fi

echo "  扩展 ID:  $EXTENSION_ID"
echo "    （unpacked 扩展 ID 由安装路径派生；若浏览器扩展管理页显示的 ID"
echo "      与此不同，请用 --extension-id <ID> 重新执行本脚本）"
echo ""

DETECTED="$(detect_browsers)"

if [[ -z "$DETECTED" ]]; then
  echo "⚠️  未探测到任何受支持的浏览器"
  echo ""
  echo "   已查找: /Applications 与 ~/Applications 下的"
  echo "           Chrome / Edge / Chromium / Brave / Helium / Arc / Vivaldi / Opera / Firefox"
  echo ""
  echo "   如果你用的是其他浏览器，或浏览器装在非标准位置，"
  echo "   可以手动注册（把 <目录> 换成浏览器实际读取的路径）："
  echo ""
  echo "     mkdir -p \"\$HOME/Library/Application Support/<目录>/NativeMessagingHosts\""
  echo "     # 然后把本文件内容写成 com.workassistant.backend.json"
  echo "     # （allowed_origins 换成浏览器扩展管理页里显示的真实扩展 ID，不支持通配符）："
  echo "     {\"name\":\"$HOST_NAME\",\"path\":\"$LAUNCHER\",\"type\":\"stdio\","
  echo "      \"allowed_origins\":[\"chrome-extension://<扩展ID>/\"]}"
  echo ""
  echo "   💡 但其实不必依赖浏览器 —— 后端本质是常驻服务（日报定时任务需要它一直跑），"
  echo "      用开机自启更省心，且与用哪个浏览器无关："
  echo ""
  echo "        npm run setup:auto-start"
  echo ""
  exit 0
fi

echo "  探测到以下浏览器："
echo ""

APP_SUPPORT="$HOME/Library/Application Support"
REGISTERED=0
SKIPPED=0

while IFS=$'\t' read -r bid name rel kind app; do
  [[ -z "$bid" ]] && continue
  if [[ -n "$ONLY_BROWSER" && "$name" != *"$ONLY_BROWSER"* ]]; then
    continue
  fi

  if [[ "$kind" == "firefox" ]]; then
    target_dir="$APP_SUPPORT/$rel"
    # Firefox 的 rel 已是完整相对路径（含 NativeMessagingHosts）
    if [[ "$rel" == */NativeMessagingHosts ]]; then
      target_dir="$APP_SUPPORT/$rel"
    fi
  else
    target_dir="$APP_SUPPORT/$rel/NativeMessagingHosts"
  fi

  exists_mark="  "
  if [[ -d "$target_dir" ]]; then
    exists_mark="✓ "
  fi

  printf '    %s%-30s %s\n' "$exists_mark" "$name" "$bid"

  if [[ $DETECT_ONLY -eq 1 ]]; then
    printf '        → %s\n' "$target_dir/$HOST_NAME.json"
    continue
  fi

  if [[ "$kind" == "firefox" && -z "$FIREFOX_EXT_ID" ]]; then
    echo "        ⏭  跳过：Firefox 需要扩展 ID 才能授权，设置 WORKASSISTANT_FIREFOX_EXT_ID=<ID> 后重跑"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  write_host_file "$kind" "$target_dir"
  REGISTERED=$((REGISTERED + 1))
done <<< "$DETECTED"

echo ""

if [[ $DETECT_ONLY -eq 1 ]]; then
  echo "🔍 仅探测模式，未写入任何文件（去掉 --detect 执行注册）"
  echo ""
  exit 0
fi

# 固化 node 路径：浏览器启动宿主时不继承 shell 环境变量，
# 启动器必须能从文件读到 node 的绝对路径。
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "⚠️  找不到可用的 node（需要 18 及以上版本），未固化路径"
  echo "   宿主将回退用 PATH 查找，换机后可能失败。"
  echo "   如 node 不在 PATH 中，请执行："
  echo "     WORKASSISTANT_NODE=/path/to/node bash scripts/install-native-host.sh"
  echo ""
else
  echo "$NODE_BIN" > "$NODE_PATH_FILE"
  echo "  ✅ node 路径已固化: $NODE_BIN"
fi

echo ""
echo "✅ 已注册 $REGISTERED 个浏览器"
echo ""

if [[ $REGISTERED -eq 0 ]]; then
  echo "⚠️  没有匹配到指定浏览器（--browser ${ONLY_BROWSER}）"
  exit 1
fi

echo "接下来："
echo "  1. 在浏览器的扩展管理页重新加载插件"
echo "     Chrome/Edge: chrome://extensions   Edge: edge://extensions"
echo "  2. 打开新标签页，后端会自动在 127.0.0.1:3721 启动"
echo ""
echo "启动/停止：插件「设置 → 本地服务」里有「启动服务 / 停止服务」按钮"
echo "命令行停止：curl -X POST http://127.0.0.1:3721/api/admin/shutdown"
echo ""
echo "💡 若浏览器启动后端仍不生效，改用开机自启（与浏览器无关，最稳）："
echo "     npm run setup:auto-start"
