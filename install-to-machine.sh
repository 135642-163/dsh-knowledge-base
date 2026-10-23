#!/usr/bin/env bash
# dsh-knowledge-wiki 一键接入脚本（在目标电脑上运行）
#
# 用法:
#   ./install-to-machine.sh [插件目录] [知识库根目录]
#   - 插件目录默认为本脚本所在目录
#   - 知识库根目录默认 ~/.dsh/knowledge
#
# 前提: 目标电脑已安装 DeepSeek Harness (dsh 命令可用)，且至少启动过一次
#       web profile（dsh web 后退出即可，用于生成 profiles/node_modules）。
#
# 脚本做三件事:
#   1. 建立软链 ~/.dsh/profiles/node_modules/dsh-knowledge-wiki -> 插件目录
#   2. 把插件注册行写入 ~/.dsh/profiles/web/cordis.patch.yml（保留已有内容）
#   3. （可选）启用 HMR 监视插件源码，编辑代码即热重载
# 完成后重启 dsh web 即可。
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${1:-"$0"}")" && pwd)"
KB_ROOT="${2:-$HOME/.dsh/knowledge}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/web"
MODULES_DIR="$DSH_HOME_DIR/profiles/node_modules"
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"

if ! command -v dsh >/dev/null 2>&1; then
  echo "错误: 未找到 dsh 命令，请先安装 DeepSeek Harness" >&2
  exit 1
fi

if [ ! -d "$PLUGIN_DIR/lib" ] || [ ! -f "$PLUGIN_DIR/package.json" ]; then
  echo "错误: $PLUGIN_DIR 不是 dsh-knowledge-wiki 插件目录" >&2
  exit 1
fi

mkdir -p "$MODULES_DIR" "$PROFILE_DIR"
ln -sfn "$PLUGIN_DIR" "$MODULES_DIR/dsh-knowledge-wiki"

if [ ! -f "$PATCH_FILE" ]; then
  echo "[]" > "$PATCH_FILE"
fi

if grep -q "id: knowledge-wiki" "$PATCH_FILE"; then
  echo "cordis.patch.yml 已包含 knowledge-wiki 注册行，跳过写入（如路径变化请手动修改）"
else
  {
    echo ""
    echo "# dsh-knowledge-wiki 知识库插件（由 install-to-machine.sh 添加，路径: $PLUGIN_DIR）"
    echo "- insert:"
    echo "    - id: knowledge-wiki"
    echo "      name: dsh-knowledge-wiki"
    echo "      config:"
    echo "        kbRoot: $KB_ROOT"
    echo "        defaultKb: default"
    echo "        ocrLang: chi_sim+eng"
    echo "        ocrWorkers: 2"
    echo "        ocrDpi: 200"
    echo ""
    echo "# 监视插件源码目录（编辑插件代码热重载，可整段删除）"
    echo "- id: hmr"
    echo "  disabled: false"
    echo "  config:"
    echo "    root:"
    echo "      - ."
    echo "      - $PLUGIN_DIR"
  } >> "$PATCH_FILE"
fi

cat <<EOF

安装完成:
  插件目录:   $PLUGIN_DIR
  知识库根:   $KB_ROOT
  软链:       $MODULES_DIR/dsh-knowledge-wiki -> $PLUGIN_DIR
  注册配置:   $PATCH_FILE

下一步:
  1. 重启 harness: 在终端重新运行 dsh web
  2. 打开网页，新开对话，说"调用 kb_list"验证（返回“还没有任何知识库”即成功）

提示:
  - OCR 引擎: 未装原生 tesseract 时自动用内置 WASM 引擎（并发按本机 CPU/内存自适应）；
    想要更快可参照 README 在 ~/.dsh/tools 下装 rapidocr-env / tesseract-env。
  - .doc 旧版 Word: macOS 用自带 textutil；Windows 用本机 Word（COM 自动化）；Linux 需 LibreOffice。
  - Windows 请改用 install-to-machine.ps1（目录联接 + 注册，无需管理员权限）。
EOF
