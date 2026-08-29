#!/bin/zsh

set -euo pipefail

project_root="${0:A:h:h}"
source_script="$project_root/scripts/PaperLens.applescript"
source_icon="$project_root/public/app-icon.svg"
target_app="/Applications/PaperLens.app"
build_root="$(mktemp -d)"
iconset="$build_root/PaperLens.iconset"
compiled_app="$build_root/PaperLens.app"
generated_script="$build_root/PaperLens.applescript"
node_path="$(command -v node)"

escape_sed() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

project_replacement="$(escape_sed "$project_root")"
node_replacement="$(escape_sed "$node_path")"
sed -e "s|__PROJECT_PATH__|$project_replacement|g" -e "s|__NODE_PATH__|$node_replacement|g" "$source_script" > "$generated_script"

mkdir -p "$iconset"
qlmanage -t -s 1024 -o "$build_root" "$source_icon" >/dev/null 2>&1
base_icon="$build_root/app-icon.svg.png"

sips -z 16 16 "$base_icon" --out "$iconset/icon_16x16.png" >/dev/null
sips -z 32 32 "$base_icon" --out "$iconset/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$base_icon" --out "$iconset/icon_32x32.png" >/dev/null
sips -z 64 64 "$base_icon" --out "$iconset/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$base_icon" --out "$iconset/icon_128x128.png" >/dev/null
sips -z 256 256 "$base_icon" --out "$iconset/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$base_icon" --out "$iconset/icon_256x256.png" >/dev/null
sips -z 512 512 "$base_icon" --out "$iconset/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$base_icon" --out "$iconset/icon_512x512.png" >/dev/null
cp "$base_icon" "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o "$build_root/PaperLens.icns"

osacompile -o "$compiled_app" "$generated_script"
cp "$build_root/PaperLens.icns" "$compiled_app/Contents/Resources/applet.icns"
if /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$compiled_app/Contents/Info.plist" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.paperlens.local" "$compiled_app/Contents/Info.plist"
else
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.paperlens.local" "$compiled_app/Contents/Info.plist"
fi
if /usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$compiled_app/Contents/Info.plist" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName PaperLens" "$compiled_app/Contents/Info.plist"
else
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string PaperLens" "$compiled_app/Contents/Info.plist"
fi
/usr/bin/touch "$compiled_app"
/usr/bin/codesign --force --deep --sign - "$compiled_app"

/usr/bin/ditto "$compiled_app" "$target_app"
/usr/bin/touch "$target_app"

printf 'Installed %s\n' "$target_app"
