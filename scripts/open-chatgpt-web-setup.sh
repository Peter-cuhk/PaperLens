#!/bin/zsh

set -euo pipefail

project_root="${0:A:h:h}"
extension_dir="$project_root/browser-extension"

open -a "Google Chrome" "chrome://extensions"
open "$extension_dir"

printf 'Chrome 扩展页和 PaperLens 扩展目录已打开。\n'
printf '请打开“开发者模式”，点击“加载已解压的扩展程序”，并选择：%s\n' "$extension_dir"
