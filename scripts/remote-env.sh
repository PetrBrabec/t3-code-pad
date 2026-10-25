# Sourced by deploy-air.sh and dev-air.sh. Settings for the Mac that runs T3 (the "remote"):
#   T3PAD_REMOTE   ssh destination of that Mac (host alias or user@host), required
#   T3PAD_SSH_KEY  optional private key for it (adds -i <key> -o IdentitiesOnly=yes)
# Put them in .env.local at the repo root (gitignored), see .env.example.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$ROOT/.env.local" ]] && source "$ROOT/.env.local"
: "${T3PAD_REMOTE:?set T3PAD_REMOTE (ssh host of the Mac running T3), e.g. in .env.local}"
SSH=(ssh)
[[ -n "${T3PAD_SSH_KEY:-}" ]] && SSH+=(-i "${T3PAD_SSH_KEY/#\~/$HOME}" -o IdentitiesOnly=yes)
