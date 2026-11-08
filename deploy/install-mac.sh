#!/bin/sh
# Start Roku Detox automatically when you log in to this Mac, in the background (no Terminal window).
# Run from the roku-detox folder:  sh deploy/install-mac.sh        Undo:  sh deploy/install-mac.sh remove
set -e
LABEL=com.rokudetox.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ "$1" = "remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Roku Detox won't start at login anymore."
  exit 0
fi
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PY="$(command -v python3)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$PY</string><string>-u</string><string>$DIR/roku_detox.py</string><string>--no-browser</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/roku-detox.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/roku-detox.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Roku Detox now starts when you log in. Open http://127.0.0.1:8642"
echo "Log: ~/Library/Logs/roku-detox.log    Undo: sh deploy/install-mac.sh remove"
