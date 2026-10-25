#!/usr/bin/env bash
# Install / update t3-pad on THIS Mac (the Mac that runs T3; deploy-air.sh calls it over SSH).
#   scripts/install.sh                 build helper if changed, (re)load the LaunchAgent
#   scripts/install.sh --link-target   also set T3's "browser link target" to the in-app preview
#                                      (quits and relaunches T3)
#   scripts/install.sh --uninstall
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$HOME/Applications/T3Pad.app"
HELPER="$APP_DIR/Contents/MacOS/t3pad-helper"
LABEL="com.petr.t3pad"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/t3-pad.log"
NODE="$(command -v node)"
T3_APP="T3 Code (Beta)"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$APP_DIR" "$HOME/Library/Application Support/t3-pad-bin"
  echo "uninstalled (T3 keeps running; relaunch it normally to drop the debug port)"
  exit 0
fi

# 1. Helper bundle. Rebuild only when the Swift source changes: an ad-hoc signature is tied to the
#    binary hash, so every rebuild needs the Accessibility grant to be given again.
STAMP="$APP_DIR/Contents/Resources/source.sha256"
SUM="$(shasum -a 256 "$ROOT/helper/main.swift" "$ROOT/helper/Info.plist" | shasum -a 256 | cut -d' ' -f1)"
if [[ ! -x "$HELPER" || "$(cat "$STAMP" 2>/dev/null)" != "$SUM" ]]; then
  echo "building helper…"
  mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
  cp "$ROOT/helper/Info.plist" "$APP_DIR/Contents/Info.plist"
  swiftc -O -o "$HELPER" "$ROOT/helper/main.swift" -framework AppKit -framework ApplicationServices
  echo "$SUM" > "$STAMP"
  codesign --force --sign - --identifier "$LABEL" "$APP_DIR"
  echo "helper rebuilt: Accessibility must be (re)granted to T3Pad"
else
  echo "helper unchanged"
fi

# 1b. Touchpad reader: a plain binary next to (not inside) T3Pad.app, so building it never touches
#     the helper's signature or its Accessibility grant. GameController needs no permission.
TOUCH_DIR="$HOME/Library/Application Support/t3-pad-bin"
TOUCH_BIN="$TOUCH_DIR/t3pad-touch"
TOUCH_SUM="$(shasum -a 256 "$ROOT/touch/main.swift" | cut -d' ' -f1)"
if [[ ! -x "$TOUCH_BIN" || "$(cat "$TOUCH_DIR/source.sha256" 2>/dev/null)" != "$TOUCH_SUM" ]]; then
  echo "building touch reader…"
  mkdir -p "$TOUCH_DIR"
  swiftc -O -o "$TOUCH_BIN" "$ROOT/touch/main.swift" -framework GameController -framework Foundation
  codesign --force --sign - "$TOUCH_BIN"
  echo "$TOUCH_SUM" > "$TOUCH_DIR/source.sha256"
else
  echo "touch reader unchanged"
fi

# 2. LaunchAgent: helper -> node sidecar.
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HELPER</string>
    <string>$NODE</string>
    <string>$ROOT/sidecar/sidecar.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

# 3. Optional: links open in T3's preview pane instead of the system browser.
if [[ "${1:-}" == "--link-target" ]]; then
  SETTINGS="$HOME/.t3/userdata/client-settings.json"
  if [[ -f "$SETTINGS" ]] && ! grep -q '"browserLinkTarget": *"app"' "$SETTINGS"; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    "$NODE" "$ROOT/sidecar/sidecar.mjs" --quit
    /usr/bin/python3 - "$SETTINGS" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["browserLinkTarget"] = "app"
json.dump(d, open(p, "w"), indent=2)
print("browserLinkTarget = app")
PY
    "$NODE" "$ROOT/sidecar/sidecar.mjs" --launch
  fi
fi

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the service is gone; bootstrapping too early fails with "5: Input/output
# error" and leaves t3-pad unloaded, so retry for a few seconds.
for i in 1 2 3 4 5 6 7 8 9 10; do
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then break; fi
  sleep 1
done
launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || { echo "LaunchAgent failed to load" >&2; exit 1; }
echo "LaunchAgent loaded; log: $LOG"
