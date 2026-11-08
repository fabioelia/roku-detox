#!/bin/sh
# Install Roku Detox on a Raspberry Pi (or any Linux computer with systemd and Python 3.9+).
# Run from the roku-detox folder:  sudo sh deploy/install-pi.sh
set -e
[ "$(id -u)" = 0 ] || { echo "Run this with sudo."; exit 1; }
command -v python3 >/dev/null || { echo "Python 3 is needed: sudo apt install python3"; exit 1; }
id rokudetox >/dev/null 2>&1 || useradd --system --home /var/lib/roku-detox --shell /usr/sbin/nologin rokudetox
mkdir -p /opt/roku-detox /var/lib/roku-detox
cp roku_detox.py index.html /opt/roku-detox/
rm -rf /opt/roku-detox/roku-app && cp -r roku-app /opt/roku-detox/roku-app
chown -R rokudetox /var/lib/roku-detox
cp deploy/roku-detox.service /etc/systemd/system/roku-detox.service
systemctl daemon-reload
systemctl enable --now roku-detox
sleep 2
echo
echo "Roku Detox is running. On any phone or computer on your Wi-Fi, open:"
echo "  http://$(hostname).local:8642   or   http://$(hostname -I | awk '{print $1}'):8642"
echo "To update later: run this script again. To stop it: sudo systemctl disable --now roku-detox"
