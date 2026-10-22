#!/usr/bin/env bash
# 旧的安装方式（从仓库目录运行后台）已停用，转到新的安装器：
# 安装 GitHub 上的最新版本到 ~/Library/Application Support/WorkAssistant，注册开机自启、自动更新；
# 会认出并停掉以前从仓库目录启动的后台，把仓库里的 .env 和 data/ 迁移过去（仓库目录不动）。
#
# 推荐直接运行：curl -fsSL https://github.com/rskdwypy-pixel/workAssistant/releases/latest/download/install.sh | bash
# Windows 见 README。
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/installer/install-mac.sh" "$@"
