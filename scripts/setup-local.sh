#!/bin/zsh

set -euo pipefail

project_root="${0:A:h:h}"
install_codex=1
install_app=1

for argument in "$@"; do
  case "$argument" in
    --no-codex) install_codex=0 ;;
    --no-app) install_app=0 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js >= 22.13 is required. Install it from https://nodejs.org/ and rerun this script.\n' >&2
  exit 1
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  printf 'Node.js >= 22.13 is required; current version is %s.\n' "$(node --version)" >&2
  exit 1
fi

cd "$project_root"
printf 'Installing PaperLens dependencies…\n'
npm ci

if (( install_codex )) && ! command -v codex >/dev/null 2>&1; then
  printf 'Codex CLI is missing; installing @openai/codex globally…\n'
  if ! npm install -g @openai/codex; then
    printf 'Codex installation failed. PaperLens can still use ChatGPT Web Chat; rerun npm install -g @openai/codex later.\n' >&2
  fi
fi

npm run chatgpt-web:package

if [[ "$(uname -s)" == "Darwin" ]] && (( install_app )); then
  npm run app:install
fi

npm run doctor

printf '\nPaperLens setup completed.\n'
printf 'Start with: npm run dev\n'
if [[ "$(uname -s)" == "Darwin" ]] && (( install_app )); then
  printf 'Or open: /Applications/PaperLens.app\n'
fi
printf 'Connect Codex or install the ChatGPT extension from PaperLens > Local AI.\n'
