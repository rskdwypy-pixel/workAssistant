#!/usr/bin/env bash
# 后端启动相关脚本的公共定义（被 source，不单独执行）
#
#   install-native-host.sh / install-launchagent.sh / backend-launcher.sh
# 共用同一套 node 路径解析、日志路径和 launchd 标签，避免三处各写一份、行为不一致。

WA_LABEL="com.workassistant.backend"
WA_PORT="${WORKASSISTANT_PORT:-3721}"

# 日志放用户目录（/tmp 全员可读且会被系统定期清理），目录 700、文件 600
WA_LOG_DIR="$HOME/Library/Logs/WorkAssistant"
WA_LOG_FILE="$WA_LOG_DIR/backend.log"

wa_prepare_log_dir() {
  mkdir -p "$WA_LOG_DIR"
  chmod 700 "$WA_LOG_DIR" 2>/dev/null || true
  touch "$WA_LOG_FILE"
  chmod 600 "$WA_LOG_FILE" 2>/dev/null || true
}

# node 主版本是否满足要求（>= 18）
wa_node_ok() {
  local bin="$1" major
  [[ -n "$bin" && -x "$bin" ]] || return 1
  major="$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 18 ))
}

# 安装时选用的 node：优先固定路径，避开 nvm 等版本管理器的目录
#   nvm 的路径带版本号（~/.nvm/versions/node/v20.x/bin/node），卸载/升级该版本后
#   开机自启会直接启动失败。只有找不到别的 node 时才退而使用它。
# 顺序：WORKASSISTANT_NODE > Homebrew(Apple 芯片) > /usr/local/bin > PATH 里的 node
wa_resolve_node_for_install() {
  local c fallback=""
  for c in "${WORKASSISTANT_NODE:-}" /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
    wa_node_ok "$c" || continue
    case "$c" in
      */.nvm/*|*/.fnm/*|*/.volta/*|*/.asdf/*|*/n/versions/*)
        [[ -z "$fallback" ]] && fallback="$c"
        continue
        ;;
    esac
    echo "$c"
    return 0
  done
  if [[ -n "$fallback" ]]; then
    echo "$fallback"
    return 0
  fi
  return 1
}

# 安装版目录结构（一条命令安装的）：
#   WorkAssistant/versions/<版本>/   程序（本脚本所在目录的上一级；打包时写入 .wa-package 标记）
#   WorkAssistant/runtime/node/      自带的 node
#   WorkAssistant/bin/               固定入口（workassistant-run、native-host），切换版本不用改登录项和宿主注册
#   WorkAssistant/data/              数据与配置（.env），更新不碰
#   WorkAssistant/current.txt        当前版本
# 是安装版时输出 WorkAssistant 目录；在仓库里开发时返回失败
wa_install_home() {
  local project_dir="$1" home
  [[ -f "$project_dir/.wa-package" ]] || return 1
  home="$(cd "$project_dir/../.." 2>/dev/null && pwd)" || return 1
  [[ -f "$home/current.txt" ]] || return 1
  echo "$home"
}

# 运行时使用的 node：安装版用自带的；开发时安装时固化的 scripts/.node-path 优先（浏览器/launchd 不继承 shell 环境）
wa_resolve_node_for_run() {
  local project_dir="$1" saved="" home=""
  if home="$(wa_install_home "$project_dir")" && wa_node_ok "$home/runtime/node/bin/node"; then
    echo "$home/runtime/node/bin/node"
    return 0
  fi
  if [[ -f "$project_dir/scripts/.node-path" ]]; then
    saved="$(cat "$project_dir/scripts/.node-path")"
    if wa_node_ok "$saved"; then
      echo "$saved"
      return 0
    fi
  fi
  wa_resolve_node_for_install
}

# 后端是否已在端口上服务（并且是本项目的后端，不是别的程序）
wa_backend_alive() {
  curl -s -m 2 "http://127.0.0.1:${WA_PORT}/health" 2>/dev/null | grep -q '"app":"workassistant"'
}

# XML 转义（写 plist 时路径里可能有 & < > 等字符）
wa_xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  s="${s//\"/&quot;}"
  printf '%s' "$s"
}
