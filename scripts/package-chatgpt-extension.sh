#!/bin/zsh

set -euo pipefail

project_root="${0:A:h:h}"
extension_dir="$project_root/browser-extension"
release_dir="$project_root/release"
archive="$release_dir/paperlens-chatgpt-web-extension.zip"

mkdir -p "$release_dir"
rm -f "$archive"
(
  cd "$extension_dir"
  /usr/bin/zip -q -r "$archive" manifest.json background.js content.js paperlens.js icon-16.png icon-48.png icon-128.png
)

printf 'Chrome Web Store package: %s\n' "$archive"
