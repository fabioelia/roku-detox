#!/usr/bin/env python3
"""Copy the Roku Detox page into the Chrome extension (Python standard library only).

    python3 tools/build_extension.py                 # writes extension/app/
    python3 tools/build_extension.py --id <extension id>

Writes extension/app/index.html from index.html. Extension pages may only run scripts
that are files inside the extension (Manifest V3's content security policy), so:

- each inline <script> becomes extension/app/page-<n>.js, loaded in the same place and order;
- <script src="https://..."> tags are left out (remote code isn't allowed; the page
  already copes without them, like the phone QR code library);
- inline JSON and other non-JavaScript <script> blocks stay as they are.

With --id, the copy's <meta name="roku-detox-extension"> is filled in with that id.
index.html itself is never changed. Run this again whenever index.html changes.
"""

import argparse
import html
import importlib.util
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "index.html")
APP_DIR = os.path.join(ROOT, "extension", "app")
RELAY_SOURCE = os.path.join(ROOT, "relay", "client")
RELAY_DIR = os.path.join(ROOT, "extension", "relay")
ID_RE = re.compile(r"^[a-p]{32}$")
SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script\s*>", re.S | re.I)
JS_TYPES = {"", "text/javascript", "application/javascript", "module", "text/ecmascript"}
META_RE = re.compile(r'<meta\s+name=["\']roku-detox-extension["\'][^>]*>', re.I)


def attr(attrs, name):
    match = re.search(r'\b%s\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))' % name, attrs, re.I)
    if not match:
        return None
    return html.unescape(next(g for g in match.groups() if g is not None))


def build(extension_id=None):
    with open(SOURCE, encoding="utf-8") as f:
        page = f.read()
    os.makedirs(APP_DIR, exist_ok=True)
    for name in os.listdir(APP_DIR):  # scripts from an older copy
        if re.match(r"^page-\d+\.js$", name):
            os.remove(os.path.join(APP_DIR, name))

    written, dropped = [], []

    def replace(match):
        attrs, code = match.group(1), match.group(2)
        src = attr(attrs, "src")
        kind = (attr(attrs, "type") or "").strip().lower()
        if src is not None:
            if re.match(r"^(https?:)?//", src.strip(), re.I):
                dropped.append(src)
                return f"<!-- left out of the extension (remote script): {html.escape(src)} -->"
            return match.group(0)
        if kind not in JS_TYPES:
            return match.group(0)  # JSON or templates: data, not code
        name = f"page-{len(written) + 1}.js"
        with open(os.path.join(APP_DIR, name), "w", encoding="utf-8") as out:
            out.write(code.strip("\n") + "\n")
        written.append(name)
        module = ' type="module"' if kind == "module" else ""
        return f'<script src="{name}"{module}></script>'

    handlers = len(re.findall(r"\son[a-z]+\s*=\s*[\"']", page))  # in the markup and in HTML built by scripts
    page = SCRIPT_RE.sub(replace, page)

    if extension_id:
        tag = f'<meta name="roku-detox-extension" content="{extension_id}">'
        if META_RE.search(page):
            page = META_RE.sub(tag, page, count=1)
        else:
            page = re.sub(r"(<meta\s+charset=[^>]*>)", r"\1\n" + tag, page, count=1, flags=re.I)

    with open(os.path.join(APP_DIR, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)

    print(f"Wrote extension/app/index.html with {len(written)} script file(s): {', '.join(written) or 'none'}.")

    # The phone relay's client code, used by the service worker (engine/relay-host.js).
    os.makedirs(RELAY_DIR, exist_ok=True)
    for name in ("relay-client.js", "relay-crypto.js"):
        shutil.copyfile(os.path.join(RELAY_SOURCE, name), os.path.join(RELAY_DIR, name))
    print("Copied the relay client into extension/relay/.")

    # Detox Home without a Mac link, for "Download Detox Home" in the TV app menu.
    spec = importlib.util.spec_from_file_location("roku_detox", os.path.join(ROOT, "roku_detox.py"))
    roku_detox = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(roku_detox)
    with open(os.path.join(APP_DIR, "detox-home.zip"), "wb") as f:
        f.write(roku_detox.build_package())
    print("Wrote extension/app/detox-home.zip.")
    # The page links a home-screen icon and manifest next to itself (served by the program at home).
    shutil.copyfile(os.path.join(ROOT, "extension", "icons", "128.png"), os.path.join(APP_DIR, "icon.png"))
    with open(os.path.join(APP_DIR, "manifest.webmanifest"), "w", encoding="utf-8") as f:
        json.dump(roku_detox.web_manifest(), f, indent=2)
        f.write("\n")
    for src in dropped:
        print(f"  Left out remote script: {src}")
    if handlers:
        print(f"  Note: {handlers} inline event handler attribute(s) (like onerror=\"...\") won't run in the extension:"
              " Chrome blocks them on extension pages. Use addEventListener instead.")
    if extension_id:
        print(f"  Filled in the extension id {extension_id}.")


def main():
    parser = argparse.ArgumentParser(description="Copy index.html into the Roku Detox Chrome extension.")
    parser.add_argument("--id", help="the extension's id (32 letters a-p), written into the copy's meta tag")
    args = parser.parse_args()
    if args.id and not ID_RE.match(args.id):
        sys.exit("That doesn't look like an extension id (32 letters from a to p).")
    build(args.id)


if __name__ == "__main__":
    main()
