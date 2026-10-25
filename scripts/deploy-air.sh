#!/usr/bin/env bash
# Copy t3-pad to the Mac that runs T3 ($T3PAD_REMOTE, see scripts/remote-env.sh) and install it there.
# Not needed when you run T3 on this Mac: use scripts/install.sh directly.
#   scripts/deploy-air.sh [--link-target]
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/remote-env.sh
DEST='Library/Application Support/t3-pad'
"${SSH[@]}" "$T3PAD_REMOTE" "mkdir -p \"\$HOME/$DEST\""
rsync -a --delete -e "${SSH[*]}" --exclude .git --exclude docs --exclude node_modules --exclude .env.local ./ "$T3PAD_REMOTE:${DEST// /\\ }/"
"${SSH[@]}" "$T3PAD_REMOTE" "bash \"\$HOME/$DEST/scripts/install.sh\" ${1:-}"
