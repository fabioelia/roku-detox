#!/usr/bin/env python3
"""A pretend Roku for trying Roku Detox without touching a real TV.

    python3 mock_roku.py              # remote access on, port 9060
    python3 mock_roku.py --limited    # acts like a TV set to Limited

In Roku Detox, type 127.0.0.1:9060 as the TV address.
Removing: after the page opens a channel's store page, press OK twice.
Adding back: after it opens the store page, press OK once.
Restart shortcut (Home x5, Up, Rewind x2, Fast forward x2) takes it offline for 8 seconds.
"""

import argparse
import hashlib
import io
import re
import json
import threading
import time
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.sax.saxutils import escape

RESTART_SEQUENCE = ["Home"] * 5 + ["Up", "Rev", "Rev", "Fwd", "Fwd"]
ALL_APPS = [
    ("tvinput.dtv", "tvin", "Live TV"),
    ("tvinput.hdmi1", "tvin", "HDMI 1"),
    ("tvinput.hdmi2", "tvin", "Xbox"),
    ("tvinput.cvbs", "tvin", "AV"),
    ("12", "appl", "Netflix"),
    ("837", "appl", "YouTube"),
    ("13", "appl", "Prime Video"),
    ("2285", "appl", "Hulu"),
    ("291097", "appl", "Disney Plus"),
    ("151908", "appl", "The Roku Channel"),
    ("74519", "appl", "Pluto TV - It's Free TV"),
    ("41468", "appl", "Tubi - Free Movies & TV"),
    ("635764", "appl", "Xumo Play"),
    ("46041", "appl", "Sling TV"),
    ("2213", "appl", "Roku Media Player"),
    ("593099", "appl", "Peacock TV"),
]


class Fake:
    def __init__(self, limited):
        self.limited = limited
        self.installed = {app_id for app_id, _, _ in ALL_APPS}
        self.booted = time.time() - 245000
        self.offline_until = 0
        self.store_page = None
        self.selects = 0
        self.recent = []
        self.active = ("", "Roku")
        self.playing_since = None
        self.power = "PowerOn"
        self.dev_password = "testpass"   # pretend developer-mode password
        self.dev_app = None              # size of the installed Detox Home zip
        self.dev_version = "1.0.1"       # from the installed zip's manifest
        self.dev_config = None           # its config.json, if any
        self.last_dev_params = None
        self.lock = threading.Lock()

    def press(self, key):
        self.recent = (self.recent + [key])[-len(RESTART_SEQUENCE):]
        if self.recent == RESTART_SEQUENCE:
            print("  restart shortcut received; going offline for 8 seconds")
            self.offline_until = time.time() + 8
            self.booted = time.time() + 8
            self.store_page = None
            self.active = ("", "Roku")
            self.recent = []
            return
        if key in ("PowerOff", "Power") and self.power == "PowerOn":
            self.power, self.active, self.playing_since, self.store_page = "DisplayOff", ("", "Roku"), None, None
            print("  powered off")
            return
        if key in ("PowerOn", "Power"):
            if self.power != "PowerOn":
                self.power, self.active = "PowerOn", ("", "Roku")
                print("  powered on")
            return
        if key == "Home":
            self.store_page, self.active, self.playing_since = None, ("", "Roku"), None
        if key == "Select" and self.store_page:
            self.selects += 1
            app_id = self.store_page
            if app_id in self.installed and self.selects >= 2:
                self.installed.discard(app_id)
                print(f"  removed {app_id}")
                self.store_page = None
            elif app_id not in self.installed:
                self.installed.add(app_id)
                print(f"  added back {app_id}")
                self.store_page = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("  " + fmt % args)

    def reply(self, status, body, ctype="text/xml; charset=utf-8"):
        body = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def installer(self):
        """Roku's developer web installer, with real digest-password checking."""
        realm, nonce = "rokudev", "abc123"
        auth = self.headers.get("Authorization", "")
        fields = dict(re.findall(r'(\w+)="?([^",]+)"?', auth))
        if auth.startswith("Digest") and fields.get("username") == "rokudev":
            ha1 = hashlib.md5(f"rokudev:{realm}:{fake.dev_password}".encode()).hexdigest()
            ha2 = hashlib.md5(f"POST:{fields.get('uri')}".encode()).hexdigest()
            expect = hashlib.md5(f"{ha1}:{fields.get('nonce')}:{fields.get('nc')}:{fields.get('cnonce')}:{fields.get('qop')}:{ha2}".encode()).hexdigest()
            if fields.get("response") == expect:
                length = int(self.headers.get("Content-Length") or 0)
                data = self.rfile.read(length)
                if b'name="mysubmit"\r\n\r\nDelete' in data:
                    fake.dev_app = None
                    print("  Detox Home removed")
                    return self.reply(200, "<html>Delete Successful</html>", "text/html")
                if b"manifest" not in data:
                    return self.reply(200, '<html>Install Failure: No manifest</html>', "text/html")
                fake.dev_app = length
                fake.dev_version, fake.dev_config = read_package(data)
                print(f"  Detox Home {fake.dev_version} installed ({length} bytes)")
                return self.reply(200, "<html>Install Success.</html>", "text/html")
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        self.send_response(401)
        self.send_header("WWW-Authenticate", f'Digest realm="{realm}", nonce="{nonce}", qop="auth"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    def offline(self):
        if time.time() < fake.offline_until:
            self.close_connection = True
            return True
        return False

    def do_GET(self):
        if self.offline():
            return
        path = urllib.parse.urlparse(self.path).path
        with fake.lock:
            if path == "/query/device-info":
                return self.reply(200, device_info())
            if fake.limited and path in ("/query/apps", "/query/active-app") or path.startswith("/query/icon/") and fake.limited:
                return self.reply(403, "ECP command not allowed in Limited mode.", "text/plain")
            if path == "/query/apps":
                rows = "".join(
                    f'\t<app id="{i}" type="{t}" version="1.0.0">{escape(n)}</app>\n'
                    for i, t, n in ALL_APPS if i in fake.installed
                ) + (f'\t<app id="dev" type="appl" version="{fake.dev_version}">Detox Home</app>\n' if fake.dev_app else "")
                return self.reply(200, f'<?xml version="1.0" encoding="UTF-8" ?>\n<apps>\n{rows}</apps>\n')
            if path == "/query/active-app":
                app_id, name = fake.active
                return self.reply(200, f'<?xml version="1.0" encoding="UTF-8" ?>\n<active-app>\n\t<app id="{app_id}">{escape(name)}</app>\n</active-app>\n')
            if path == "/query/media-player":
                if not fake.playing_since:
                    return self.reply(200, '<?xml version="1.0" encoding="UTF-8" ?>\n<player state="close" error="false" />\n')
                app_id, name = fake.active
                pos = int((time.time() - fake.playing_since) * 1000)
                return self.reply(200, f'''<?xml version="1.0" encoding="UTF-8" ?>
<player state="play" error="false">
\t<plugin id="{app_id}" name="{escape(name)}" />
\t<position>{pos} ms</position>
\t<duration>600000 ms</duration>
\t<is_live>false</is_live>
</player>
''')
            if path.startswith("/query/icon/"):
                return self.reply(200, icon(path.rsplit("/", 1)[1]), "image/svg+xml")
        self.reply(404, "")

    def do_POST(self):
        if self.offline():
            return
        url = urllib.parse.urlparse(self.path)
        with fake.lock:
            if fake.limited:
                return self.reply(403, "ECP command not allowed in Limited mode.", "text/plain")
            if url.path.startswith("/keypress/"):
                fake.press(urllib.parse.unquote(url.path[len("/keypress/"):]))
                return self.reply(200, "")
            if url.path == "/launch/11":
                fake.store_page = urllib.parse.parse_qs(url.query).get("contentID", [None])[0]
                fake.selects = 0
                fake.active = ("11", "Streaming Store")
                return self.reply(200, "")
            if url.path == "/plugin_install":
                return self.installer()
            if url.path == "/launch/dev" or url.path == "/input":
                if url.path == "/launch/dev" and not fake.dev_app:
                    return self.reply(404, "")
                fake.active = ("dev", "Detox Home")
                fake.last_dev_params = dict(urllib.parse.parse_qsl(url.query))
                print(f"  Detox Home got {url.path} {fake.last_dev_params}")
                return self.reply(200, "")
            if url.path.startswith("/launch/"):
                app_id = urllib.parse.unquote(url.path.rsplit("/", 1)[1])
                name = next((n for i, _, n in ALL_APPS if i == app_id), None)
                if name is None or app_id not in fake.installed:
                    return self.reply(404, "")
                fake.active = (app_id, name)
                fake.playing_since = time.time() if url.query else None
                print(f"  launched {name} {url.query}")
                return self.reply(200, "")
            if url.path == "/test/last-dev":
                return self.reply(200, json.dumps(fake.last_dev_params or {}), "application/json")
            if url.path == "/test/dev-config":  # the installed Detox Home's config.json
                return self.reply(200, json.dumps(fake.dev_config), "application/json")
            if url.path == "/test/wake":  # pretend the TV turned itself on
                to = urllib.parse.parse_qs(url.query).get("to", [""])[0]
                name = next((n for i, _, n in ALL_APPS if i == to), None)
                fake.power = "PowerOn"
                fake.active = (to, name) if name else ("", "Roku")
                fake.playing_since = None
                print(f"  woke up on {fake.active[1]}")
                return self.reply(200, "")
            if url.path == "/search/browse":
                fake.active = ("", "Search")
                print(f"  search {url.query}")
                return self.reply(200, "")
        self.reply(404, "")


def read_package(form):
    """(version, config.json) from the zip inside the installer's form upload."""
    start = form.find(b"PK\x03\x04")
    end = form.rfind(b"\r\n--")
    try:
        archive = zipfile.ZipFile(io.BytesIO(form[start:end]))
        manifest = dict(line.split("=", 1) for line in archive.read("manifest").decode().splitlines() if "=" in line)
        version = ".".join(manifest.get(k, "0") for k in ("major_version", "minor_version", "build_version"))
        config = json.loads(archive.read("config.json")) if "config.json" in archive.namelist() else None
        return version, config
    except (zipfile.BadZipFile, KeyError, ValueError):
        return "1.0.1", None


def device_info():
    mode = "limited" if fake.limited else "default"
    uptime = max(0, int(time.time() - fake.booted))
    return f"""<?xml version="1.0" encoding="UTF-8" ?>
<device-info>
\t<vendor-name>Pretend</vendor-name>
\t<model-name>MOCK1</model-name>
\t<model-number>M100X</model-number>
\t<is-tv>true</is-tv>
\t<screen-size>50</screen-size>
\t<friendly-device-name>Pretend Roku TV</friendly-device-name>
\t<friendly-model-name>Pretend Roku TV</friendly-model-name>
\t<user-device-name>Test TV (pretend)</user-device-name>
\t<software-version>15.3.4</software-version>
\t<uptime>{uptime}</uptime>
\t<power-mode>{fake.power}</power-mode>
\t<ecp-setting-mode>{mode}</ecp-setting-mode>
\t<network-type>wifi</network-type>
\t<wifi-mac>02:00:00:00:00:01</wifi-mac>
\t<supports-wake-on-wlan>true</supports-wake-on-wlan>
</device-info>
"""


def icon(app_id):
    name = next((n for i, _, n in ALL_APPS if i == app_id), "?")
    hue = int(hashlib.md5(app_id.encode()).hexdigest()[:2], 16) * 360 // 256
    letters = escape("".join(w[0] for w in name.split()[:2]).upper())
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 290 218">'
        f'<rect width="290" height="218" fill="hsl({hue} 55% 38%)"/>'
        f'<text x="145" y="128" font-family="sans-serif" font-size="64" font-weight="700" '
        f'fill="#fff" text-anchor="middle">{letters}</text></svg>'
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Pretend Roku for testing Roku Detox.")
    parser.add_argument("--port", type=int, default=9060)
    parser.add_argument("--limited", action="store_true", help="refuse channels and remote like Limited mode")
    args = parser.parse_args()
    fake = Fake(args.limited)
    print(f"Pretend Roku on 127.0.0.1:{args.port} ({'limited' if args.limited else 'remote access on'})")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
