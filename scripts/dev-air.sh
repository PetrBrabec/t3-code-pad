#!/usr/bin/env bash
# Dev loop: sync this checkout to ~/t3-pad-dev on $T3PAD_REMOTE and run a command there.
#   scripts/dev-air.sh 'node scripts/inject-once.mjs'
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/remote-env.sh
rsync -a -e "${SSH[*]}" --exclude .git --exclude docs --exclude .env.local ./ "$T3PAD_REMOTE:t3-pad-dev/"
"${SSH[@]}" "$T3PAD_REMOTE" "export PATH=/opt/homebrew/bin:\$PATH; cd ~/t3-pad-dev && $1"
