#!/usr/bin/env python3
"""Roku Detox: find a Roku TV on your Wi-Fi and clean it up from a web page.

    python3 roku_detox.py                 # opens http://127.0.0.1:8642
    python3 roku_detox.py --no-browser --port 9000

Standard library only. Talks to the TV through Roku's External Control
Protocol (ECP) on port 8060. Removed channels can always be added back from
the Roku Streaming Store, and every removal is written to undo-list.json.
Shortcuts, scenes and paired phones are kept in remote-settings.json.
"""

import argparse
import hashlib
import hmac
import html as html_module
import http.client
import io
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX_PATH = os.path.join(HERE, "index.html")
LOG_PATH = os.path.join(HERE, "undo-list.json")
SETTINGS_PATH = os.path.join(HERE, "remote-settings.json")
ACTIVITY_PATH = os.path.join(HERE, "activity-log.json")
USAGE_PATH = os.path.join(HERE, "viewing-log.json")

ECP_PORT = 8060
STORE_APP_ID = "11"  # Roku's Streaming Store; launch/11?contentID=<id> opens a channel's page
SSDP_ADDR = ("239.255.255.250", 1900)

KEYS = {
    "Home", "Back", "Select", "Up", "Down", "Left", "Right", "Info",
    "InstantReplay", "Rev", "Play", "Fwd", "Search", "Backspace", "Enter",
    "VolumeUp", "VolumeDown", "VolumeMute", "Power", "PowerOn", "PowerOff",
    "ChannelUp", "ChannelDown", "InputTuner", "InputAV1",
    "InputHDMI1", "InputHDMI2", "InputHDMI3", "InputHDMI4",
}
# Roku's built-in remote shortcut for a system restart.
RESTART_SEQUENCE = ["Home"] * 5 + ["Up", "Rev", "Rev", "Fwd", "Fwd"]

# Name fragments of free, ad-supported channels. Only used to label tiles.
FREE_WITH_ADS = (
    "pluto", "tubi", "xumo", "crackle", "plex", "freevee", "local now",
    "haystack", "redbox", "filmrise", "popcornflix", "fawesome", "vix",
    "shout! tv", "freestream", "samsung tv plus", "lg channels",
)
ROKU_OWNED_IDS = {"151908", "2213"}  # The Roku Channel, Roku Media Player

APP_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MAX_BODY = 64 * 1024
# Changes that need the household PIN (when one is set) from phones and other computers.
PIN_PATHS = ("/api/rules", "/api/tvapp", "/api/sites", "/api/phone", "/api/household")


class TVError(Exception):
    """The TV couldn't be reached or gave an unexpected answer."""


class Blocked(TVError):
    """The TV refused because 'Control by mobile apps' is set to Limited."""

    def __init__(self):
        super().__init__(
            "The TV is blocking this. On the TV, set Settings > System > "
            "Advanced system settings > Control by mobile apps > Network access "
            "to Default."
        )


# --- Talking to the TV -------------------------------------------------------

def parse_target(value):
    """'192.168.1.50' or '192.168.1.50:8060' -> ('192.168.1.50', 8060).

    Only private and loopback addresses are accepted, so this program can't be
    used to reach anything outside the home network.
    """
    if not value or not isinstance(value, str):
        raise ValueError("No TV address given.")
    host, _, port = value.strip().partition(":")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        raise ValueError("Enter the TV's IP address, like 192.168.1.20.") from None
    if ip.version != 4 or not (ip.is_private or ip.is_loopback) or ip.is_unspecified:
        raise ValueError("That address isn't on your home network.")
    port = int(port) if port.isdigit() else ECP_PORT
    if not 0 < port < 65536:
        raise ValueError("That port number isn't valid.")
    return str(ip), port


def display_address(target):
    host, port = target
    return host if port == ECP_PORT else f"{host}:{port}"


def ecp(target, path, method="GET", timeout=4.0):
    host, port = target
    req = urllib.request.Request(
        f"http://{host}:{port}/{path}",
        method=method,
        data=b"" if method == "POST" else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as err:
        return err.code, err.read(), ""
    except (urllib.error.URLError, OSError) as err:
        raise TVError(
            "The TV didn't answer. Check it's turned on and on the same Wi-Fi."
        ) from err


def is_blocked(status, body):
    return status in (401, 403) or b"not allowed" in body.lower()


def check(status, body):
    if is_blocked(status, body):
        raise Blocked()
    if status >= 300:
        raise TVError(f"The TV refused the request (error {status}).")


def device_info(target):
    status, body, _ = ecp(target, "query/device-info")
    check(status, body)
    root = ET.fromstring(body)
    if root.tag != "device-info":
        raise TVError("That device didn't answer like a Roku.")
    return {child.tag: (child.text or "").strip() for child in root}


def summarize(target, info):
    return {
        "address": display_address(target),
        "name": info.get("user-device-name")
        or info.get("friendly-device-name")
        or info.get("default-device-name")
        or "Roku",
        "model": info.get("friendly-model-name", ""),
        "modelNumber": info.get("model-number", ""),
        "vendor": info.get("vendor-name", ""),
        "software": info.get("software-version", ""),
        "isTv": info.get("is-tv") == "true",
        "screenSize": info.get("screen-size", ""),
        "uptime": int(info.get("uptime") or 0),
        "powerMode": info.get("power-mode", ""),
        "accessMode": info.get("ecp-setting-mode", ""),
        "country": info.get("country", ""),
        "serial": info.get("serial-number", ""),
    }


def classify(app):
    name = app["name"].lower()
    if app["type"] == "tvin":
        return "input"
    if app["type"] != "appl":
        return "system"
    if app["id"] in ROKU_OWNED_IDS or name.startswith(("roku ", "the roku ")) or "roku channel" in name:
        return "roku"
    if any(fragment in name for fragment in FREE_WITH_ADS):
        return "free"
    return "app"


def list_apps(target):
    status, body, _ = ecp(target, "query/apps")
    check(status, body)
    root = ET.fromstring(body)
    apps = []
    for node in root.iter("app"):
        app = {
            "id": node.get("id", ""),
            "type": node.get("type", ""),
            "version": node.get("version", ""),
            "name": (node.text or "").strip(),
        }
        app["group"] = classify(app)
        app["subscription"] = app["id"] in SUBSCRIPTION_APPS
        apps.append(app)
    return apps


def can_control(target):
    try:
        status, body, _ = ecp(target, "query/apps")
    except TVError:
        return False
    return status == 200 and not is_blocked(status, body)


def active_app(target, deliver=True):
    status, body, _ = ecp(target, "query/active-app")
    check(status, body)
    node = ET.fromstring(body).find("app")
    if node is None:
        return {"id": "", "name": ""}
    app = {"id": node.get("id", ""), "name": (node.text or "").strip()}
    # Detox Home is open and favorites or options changed while it wasn't: hand them over now.
    if deliver and app["id"] == "dev" and TV_APP_PENDING.get(target):
        deliver_pending(target, app)
    return app


def press(target, key):
    if key.startswith("Lit_") and len(key) == 5:
        path = "keypress/Lit_" + urllib.parse.quote(key[4:], safe="")
    elif key in KEYS:
        path = "keypress/" + key
    else:
        raise ValueError("Unknown remote button.")
    status, body, _ = ecp(target, path, "POST")
    check(status, body)


def press_sequence(target, keys, delay=0.35):
    for key in keys:
        press(target, key)
        time.sleep(delay)


def open_store_page(target, app_id):
    quoted = urllib.parse.quote(app_id, safe="")
    status, body, _ = ecp(target, f"launch/{STORE_APP_ID}?contentID={quoted}", "POST")
    if status < 300:
        return
    if is_blocked(status, body):
        raise Blocked()
    # Older Roku OS versions only support the install command.
    status, body, _ = ecp(target, f"install/{quoted}", "POST")
    check(status, body)


def launch(target, app_id, params=None):
    path = f"launch/{urllib.parse.quote(app_id, safe='')}"
    if params:
        path += "?" + urllib.parse.urlencode(params)
    status, body, _ = ecp(target, path, "POST")
    check(status, body)


def fetch_icon(target, app_id):
    status, body, ctype = ecp(target, f"query/icon/{urllib.parse.quote(app_id, safe='')}")
    if status != 200 or not ctype.startswith("image/"):
        return None, None
    return body, ctype


def now_playing(target):
    """What's on screen, and if something is playing, how far in it is."""
    status, body, _ = ecp(target, "query/media-player")
    check(status, body)
    root = ET.fromstring(body)
    plugin = root.find("plugin")

    def millis(tag):
        match = re.match(r"\s*(\d+)", root.findtext(tag) or "")
        return int(match.group(1)) if match else None

    return {
        "state": root.get("state", ""),
        "appId": plugin.get("id", "") if plugin is not None else "",
        "app": plugin.get("name", "") if plugin is not None else "",
        "position": millis("position"),
        "duration": millis("duration"),
        "live": (root.findtext("is_live") or "").strip() == "true",
        "screen": active_app(target),
    }


def search(target, keyword):
    """Open Roku's search screen and type the words in.

    Roku removed the ECP search command in Roku OS 12, so this does what the
    Roku phone app does: press the Search button, then type.
    """
    press(target, "Search")
    time.sleep(1.5)
    press_sequence(target, ["Lit_" + ch for ch in keyword], delay=0.08)


# --- Show and movie search (JustWatch catalog) ---------------------------------

JUSTWATCH_URL = "https://apis.justwatch.com/graphql"
JUSTWATCH_QUERY = """
query Find($country: Country!, $filter: TitleFilter, $first: Int!, $language: Language!) {
  popularTitles(country: $country, filter: $filter, first: $first) {
    edges { node {
      id objectType
      content(country: $country, language: $language) { title originalReleaseYear posterUrl shortDescription }
      offers(country: $country, platform: ROKU_OS) {
        monetizationType retailPrice(language: $language)
        package { clearName technicalName }
        deeplinkURL(platform: ROKU_OS)
      }
    } }
  }
}"""
JUSTWATCH_OFFERS = """offers(country: $country, platform: ROKU_OS) {
        monetizationType retailPrice(language: $language)
        package { clearName technicalName }
        deeplinkURL(platform: ROKU_OS)
      }"""
JUSTWATCH_SHOW_QUERY = """
query Show($id: ID!, $country: Country!, $language: Language!) {
  node(id: $id) {
    id __typename
    ... on Show {
      content(country: $country, language: $language) { title originalReleaseYear posterUrl }
      seasons(sortDirection: ASC) { id totalEpisodeCount content(country: $country, language: $language) { seasonNumber title } }
    }
  }
}"""
JUSTWATCH_SEASON_QUERY = """
query Season($id: ID!, $country: Country!, $language: Language!) {
  node(id: $id) {
    id __typename
    ... on Season {
      content(country: $country, language: $language) { seasonNumber title }
      %(offers)s
      show { id %(offers)s }
      episodes {
        id
        content(country: $country, language: $language) { episodeNumber title shortDescription runtime }
        %(offers)s
      }
    }
  }
}""" % {"offers": JUSTWATCH_OFFERS}
CATALOG_ID_RE = re.compile(r"^[a-z]{1,4}\d{1,12}$")  # ts22138 (show), tss27124 (season), tse520068, tm...
SHOW_MEDIA_TYPES = {"show", "series", "season"}  # deep links that open a show's page, not one episode
MAX_EPISODES = 500
FIND_CACHE = {}
NODE_CACHE = {}  # ("Show" or "Season", id, country) -> JustWatch answer
CACHE_LOCK = threading.Lock()
FIND_CACHE_SECONDS = 600
ADDON_MARKERS = ("amazon channel", "roku premium channel", "apple tv channel")
KINDS = {"FLATRATE": "included", "FREE": "free", "ADS": "free", "FAST": "free", "RENT": "rent", "BUY": "buy"}
KIND_ORDER = {"free": 0, "included": 1, "rent": 2, "buy": 3}
# Subscription apps, so the page can ask "do you pay for this?". Everything else counts as free.
SUBSCRIPTION_APPS = {
    "12", "13", "2285", "291097", "61322", "593099", "31440", "551012", "298229", "123132",
    "46041", "195316", "43465", "196460", "65067", "808732", "34376", "2595",
}


def app_key(name):
    """'Tubi - Free Movies & TV' and 'Tubi TV' both become 'tubi'."""
    base = re.split(r"\s+[-\u2013|]\s+|:\s", name, maxsplit=1)[0].lower().replace("+", " plus")
    words = re.findall(r"[a-z0-9]+", base)
    if "".join(words).startswith("youtubetv"):
        return "youtubetv"
    skip = {"the", "plus", "premium", "with", "ads", "app", "standard", "basic", "essential", "free", "tv", "streaming"}
    return "".join(w for w in words if w not in skip)


def match_app(service, apps):
    key = app_key(service)
    if len(key) < 3:
        return None
    best = None
    for app in apps:
        other = app_key(app["name"])
        if len(other) < 3:
            continue
        if key == other:
            return app
        if "youtubetv" in (key, other):  # YouTube TV is a separate paid service
            continue
        if key.startswith(other) or key.endswith(other) or other.startswith(key):
            if best is None or len(app_key(best["name"])) < len(other):
                best = app
    return best


def parse_roku_deeplink(link):
    """JustWatch gives Roku links like 'launch/12?contentID=82939566&MediaType=show'."""
    match = re.match(r"^launch/([A-Za-z0-9._-]{1,64})(?:\?(.*))?$", link or "")
    if not match:
        return None
    params = dict(urllib.parse.parse_qsl(match.group(2) or ""))
    content_id = params.get("contentID") or params.get("contentId")
    if content_id and len(content_id) > 500:
        return None
    return {"appId": match.group(1), "contentId": content_id, "mediaType": params.get("MediaType") or params.get("mediaType")}


def cache_get(cache, key):
    with CACHE_LOCK:
        hit = cache.get(key)
    if hit and time.time() - hit[0] < FIND_CACHE_SECONDS:
        return hit[1]
    return None


def cache_put(cache, key, value):
    """Remember a catalog answer for a while, and forget the expired ones."""
    now = time.time()
    with CACHE_LOCK:
        for old in [k for k, (at, _) in cache.items() if now - at >= FIND_CACHE_SECONDS]:
            del cache[old]
        cache[key] = (now, value)


def justwatch_post(operation, query, variables):
    payload = json.dumps({"operationName": operation, "query": query, "variables": variables}).encode()
    req = urllib.request.Request(JUSTWATCH_URL, data=payload, method="POST", headers={
        "Content-Type": "application/json", "User-Agent": "RokuDetox/1.0",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as err:
        raise TVError("Couldn't reach the show catalog (JustWatch). Check your internet connection.") from err
    if not isinstance(data, dict):
        raise TVError("The show catalog (JustWatch) sent an answer this program doesn't understand.")
    return data


def justwatch_search(query, country):
    key = (query.lower(), country)
    titles = cache_get(FIND_CACHE, key)
    if titles is not None:
        return titles
    data = justwatch_post("Find", JUSTWATCH_QUERY, {
        "country": country, "language": "en", "first": 10, "filter": {"searchQuery": query},
    })
    if data.get("errors"):
        raise TVError("The show catalog (JustWatch) didn't accept the search. It may have changed.")
    edges = ((data.get("data") or {}).get("popularTitles") or {}).get("edges") or []
    titles = [edge["node"] for edge in edges if edge.get("node")]
    cache_put(FIND_CACHE, key, titles)
    return titles


def catalog_country(target):
    """The TV's country, since what's streaming where differs by country."""
    country = device_info(target).get("country") or "US"
    return country if re.match(r"^[A-Z]{2}$", country) else "US"


def catalog_context(target):
    """The TV's country and the channels installed on it."""
    country = catalog_country(target)
    try:
        apps = [a for a in list_apps(target) if a["type"] == "appl"]
    except TVError:
        apps = []
    return country, apps


def poster_url(path):
    if not path:
        return None
    return "https://images.justwatch.com" + path.replace("{profile}", "s166").replace("{format}", "webp")


def annotate_offers(raw_offers, apps):
    """JustWatch offers -> one per service and kind, marking which ones this TV can play."""
    installed = {a["id"]: a for a in apps}
    offers = {}
    for offer in raw_offers or []:
        kind = KINDS.get(offer.get("monetizationType"))
        package = offer.get("package") or {}
        service = package.get("clearName") or ""
        if not kind or not service:
            continue
        link = parse_roku_deeplink(offer.get("deeplinkURL"))
        app = installed.get(link["appId"]) if link else match_app(service, apps)
        app_id = (link or {}).get("appId") or (app or {}).get("id")
        entry = {
            "service": service,
            "kind": kind,
            "price": offer.get("retailPrice"),
            "appId": app_id,
            "appName": app["name"] if app else None,
            "installed": bool(app),
            "addon": any(marker in service.lower() for marker in ADDON_MARKERS),
            "subscription": app_id in SUBSCRIPTION_APPS,
            "contentId": (link or {}).get("contentId"),
            "mediaType": (link or {}).get("mediaType"),
        }
        dedupe = (package.get("technicalName") or service, kind)
        if dedupe not in offers or (entry["contentId"] and not offers[dedupe]["contentId"]):
            offers[dedupe] = entry
    return sorted(offers.values(), key=lambda o: (KIND_ORDER[o["kind"]], not o["installed"], o["service"]))


def find_titles(target, query):
    """Search the catalog and mark which offers this TV can play."""
    country, apps = catalog_context(target)
    results = []
    for node in justwatch_search(query, country):
        content = node.get("content") or {}
        results.append({
            "id": node.get("id"),
            "type": "Movie" if node.get("objectType") == "MOVIE" else "Show",
            "title": content.get("title") or "",
            "year": content.get("originalReleaseYear"),
            "description": (content.get("shortDescription") or "")[:300],
            "poster": poster_url(content.get("posterUrl")),
            "offers": annotate_offers(node.get("offers"), apps),
        })
    return {"country": country, "results": results}


# Seasons and episodes. Episodes on Peacock, Hulu, Prime Video, The Roku Channel, Apple TV
# and Fandango have their own Roku links; Netflix only links to the show, Disney+ to nothing.

def catalog_id(value, what):
    value = str(value or "")
    if not CATALOG_ID_RE.match(value):
        raise ValueError(f"Bad {what} id.")
    return value


def justwatch_node(node_id, kind, query, country):
    """One show or season from the catalog. kind is 'Show' or 'Season'."""
    key = (kind, node_id, country)
    node = cache_get(NODE_CACHE, key)
    if node is not None:
        return node
    data = justwatch_post(kind, query, {"id": node_id, "country": country, "language": "en"})
    node = (data.get("data") or {}).get("node")
    if not node:
        problems = " ".join(str(e.get("message", "")) for e in data.get("errors") or [] if isinstance(e, dict))
        if data.get("errors") and not any(word in problems for word in ("no merge target", "unknown prefix")):
            raise TVError("The show catalog (JustWatch) didn't answer properly. Try again in a minute.")
        raise ValueError(f"The show catalog doesn't have that {kind.lower()}.")
    if node.get("__typename") != kind:
        raise ValueError(f"That isn't a {kind.lower()}.")
    cache_put(NODE_CACHE, key, node)
    return node


def season_summary(season):
    content = season.get("content") or {}
    return {
        "id": season.get("id"),
        "number": content.get("seasonNumber"),
        "title": content.get("title") or "",
        "episodeCount": season.get("totalEpisodeCount") or 0,
    }


def by_number(item):
    return (item["number"] is None, item["number"] or 0)


def show_details(show_id, country):
    node = justwatch_node(show_id, "Show", JUSTWATCH_SHOW_QUERY, country)
    content = node.get("content") or {}
    seasons = [season_summary(s) for s in node.get("seasons") or [] if s and s.get("id")]
    return {
        "id": node.get("id"),
        "title": content.get("title") or "",
        "year": content.get("originalReleaseYear"),
        "poster": poster_url(content.get("posterUrl")),
        "seasons": sorted((s for s in seasons if s["number"] or s["episodeCount"]), key=by_number),
    }


def inherited_offers(raw_offers, apps):
    """Season or show offers for an episode that has none: they open the right app, but
    a link that plays one particular episode would play the wrong one, so drop it."""
    offers = annotate_offers(raw_offers, apps)
    for offer in offers:
        offer["showLevel"] = True
        if (offer["mediaType"] or "").lower() not in SHOW_MEDIA_TYPES:
            offer["contentId"] = offer["mediaType"] = None
    return offers


def episode_offers(episode, season, apps):
    offers = annotate_offers(episode.get("offers"), apps)
    for offer in offers:  # Netflix's "episode" links open the show's page
        if (offer["mediaType"] or "").lower() in SHOW_MEDIA_TYPES:
            offer["showLevel"] = True
    if offers:
        return offers
    return (inherited_offers(season.get("offers"), apps)
            or inherited_offers((season.get("show") or {}).get("offers"), apps))


def season_details(season_id, country, apps):
    node = justwatch_node(season_id, "Season", JUSTWATCH_SEASON_QUERY, country)
    content = node.get("content") or {}
    episodes = []
    for episode in (node.get("episodes") or [])[:MAX_EPISODES]:
        if not episode or not episode.get("id"):
            continue
        about = episode.get("content") or {}
        episodes.append({
            "id": episode["id"],
            "number": about.get("episodeNumber"),
            "title": about.get("title") or "",
            "description": (about.get("shortDescription") or "")[:300],
            "runtime": about.get("runtime") or None,
            "offers": episode_offers(episode, node, apps),
        })
    return {
        "id": node.get("id"),
        "number": content.get("seasonNumber"),
        "title": content.get("title") or "",
        "showId": (node.get("show") or {}).get("id"),
        "episodes": sorted(episodes, key=by_number),
    }


def season_summary_of(season):
    """The short form of a season_details() answer, the same shape as show_details' seasons."""
    return {"id": season["id"], "number": season["number"], "title": season["title"],
            "episodeCount": len(season["episodes"])}


def find_show(target, show_id):
    return show_details(show_id, catalog_country(target))


def find_season(target, season_id):
    country, apps = catalog_context(target)
    return season_details(season_id, country, apps)


def find_next(target, show_id, season_id, number):
    """The episode after this one: next in the season, else the first of the next season."""
    country, apps = catalog_context(target)
    season = season_details(season_id, country, apps)
    if season["showId"] and season["showId"] != show_id:
        raise ValueError("That season belongs to a different show.")
    later = [e for e in season["episodes"] if e["number"] is not None and e["number"] > number]
    if later:
        return {"season": season_summary_of(season), "episode": later[0]}
    seasons = show_details(show_id, country)["seasons"]
    position = next((i for i, s in enumerate(seasons) if s["id"] == season_id), None)
    if position is None:
        raise ValueError("That season belongs to a different show.")
    for upcoming in seasons[position + 1:]:
        if not upcoming["episodeCount"]:
            continue
        following = season_details(upcoming["id"], country, apps)
        if following["episodes"]:
            return {"season": season_summary_of(following), "episode": following["episodes"][0]}
    return {"done": True}


# "Continue watching": what was opened from search, kept per TV in remote-settings.json
# under tvs[address]["findHistory"], newest first.

HISTORY_MAX = 30
HISTORY_PINS_MAX = 20  # so there's always room for what's being watched now
POSTER_RE = re.compile(r"""^https://images\.justwatch\.com/[^\s"'<>\\()]{1,300}$""")


def whole_number(value, low, high, message):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(message)
    return value


def short_text(value, limit, message, required=True):
    if not isinstance(value, str) or len(value.strip()) > limit or (required and not value.strip()):
        raise ValueError(message)
    return value.strip()


def clean_history_season(raw):
    if not isinstance(raw, dict):
        raise ValueError("Bad season.")
    return {"id": catalog_id(raw.get("id"), "season"),
            "number": whole_number(raw.get("number"), 0, 100000, "Bad season number.")}


def clean_history_episode(raw):
    if not isinstance(raw, dict):
        raise ValueError("Bad episode.")
    return {"id": catalog_id(raw.get("id"), "episode"),
            "number": whole_number(raw.get("number"), 0, 100000, "Bad episode number."),
            "title": short_text(raw.get("title", ""), 200, "Episode titles can be up to 200 characters.", required=False)}


def clean_history_item(raw):
    """One watch history entry from the page. 'at' and 'pinned' are filled in by the caller."""
    if not isinstance(raw, dict):
        raise ValueError("Bad watch history entry.")
    kind, year, poster = raw.get("type"), raw.get("year"), raw.get("poster")
    season, episode, app_id, app_name = raw.get("season"), raw.get("episode"), raw.get("appId"), raw.get("appName")
    if kind not in ("Show", "Movie"):
        raise ValueError("Say whether it's a show or a movie.")
    if poster is not None and not (isinstance(poster, str) and POSTER_RE.match(poster)):
        raise ValueError("Bad poster address.")
    if kind == "Movie" and (season is not None or episode is not None):
        raise ValueError("A movie doesn't have seasons or episodes.")
    if episode is not None and season is None:
        raise ValueError("Say which season the episode is in.")
    if app_id is not None and not (isinstance(app_id, str) and APP_ID_RE.match(app_id)):
        raise ValueError("Bad channel id.")
    return {
        "id": catalog_id(raw.get("id"), "show"),
        "title": short_text(raw.get("title"), 200, "Give a title of up to 200 characters."),
        "type": kind,
        "year": None if year is None else whole_number(year, 1870, 2100, "Bad year."),
        "poster": poster,
        "season": None if season is None else clean_history_season(season),
        "episode": None if episode is None else clean_history_episode(episode),
        "appId": app_id,
        "appName": None if app_name is None else short_text(app_name, 100, "Bad channel name.", required=False) or None,
    }


def stored_history(tv):
    items, seen = [], set()
    raw_items = tv.get("findHistory") if isinstance(tv.get("findHistory"), list) else []
    for raw in raw_items[:HISTORY_MAX + HISTORY_PINS_MAX]:
        try:
            item = clean_history_item(raw)
        except ValueError:
            continue
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        item["at"] = raw["at"] if isinstance(raw.get("at"), str) and len(raw["at"]) <= 40 else ""
        item["pinned"] = raw.get("pinned") is True
        items.append(item)
    return items


def trim_history(items):
    """Keep every pinned item, and the newest others up to HISTORY_MAX in all."""
    room = HISTORY_MAX - sum(item["pinned"] for item in items)
    kept = []
    for item in items:
        if item["pinned"] or room > 0:
            kept.append(item)
            room -= not item["pinned"]
    return kept


def history_view(items):
    return {"items": sorted(items, key=lambda item: not item["pinned"])}  # pinned first, then newest


def find_history(address):
    with SETTINGS_LOCK:
        tv = read_settings().get("tvs", {}).get(address, {})
    return history_view(stored_history(tv))


def change_history(address, edit):
    """Read, edit and save one TV's watch history in one locked step. edit(items) -> items."""
    result = {"items": []}

    def change(data):
        tvs = data.setdefault("tvs", {})
        items = edit(stored_history(tvs.get(address, {})))
        if items or address in tvs:
            tvs.setdefault(address, {})["findHistory"] = items
        result["items"] = items

    update_settings(change)
    return history_view(result["items"])


def pins_full(items):
    return sum(item["pinned"] for item in items) >= HISTORY_PINS_MAX


def record_history(address, raw):
    """Add or refresh an entry and move it to the front. Keeps its pin unless 'pinned' is given."""
    item = clean_history_item(raw)
    pinned = raw.get("pinned")

    def edit(items):
        old = next((i for i in items if i["id"] == item["id"]), None)
        rest = [i for i in items if i["id"] != item["id"]]
        item["at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        item["pinned"] = pinned if isinstance(pinned, bool) else bool(old and old["pinned"])
        if item["pinned"] and pins_full(rest):
            raise ValueError(f"You can pin up to {HISTORY_PINS_MAX}. Unpin one first.")
        return trim_history([item] + rest)

    return change_history(address, edit)


def forget_history(address, item_id):
    item_id = catalog_id(item_id, "show")
    return change_history(address, lambda items: [i for i in items if i["id"] != item_id])


def pin_history(address, item_id, pinned):
    item_id = catalog_id(item_id, "show")
    if not isinstance(pinned, bool):
        raise ValueError("Say whether to pin it (true or false).")

    def edit(items):
        item = next((i for i in items if i["id"] == item_id), None)
        if not item:
            raise ValueError("That isn't in the watch history anymore.")
        if pinned and not item["pinned"] and pins_full(items):
            raise ValueError(f"You can pin up to {HISTORY_PINS_MAX}. Unpin one first.")
        item["pinned"] = pinned
        return trim_history(items)

    return change_history(address, edit)



def watch(target, app_id, content_id=None, media_type=None):
    if not APP_ID_RE.match(app_id):
        raise ValueError("Bad channel id.")
    params = {}
    if content_id:
        if len(content_id) > 500:
            raise ValueError("Bad content id.")
        params["contentId"] = content_id
        if media_type:
            if not re.match(r"^[A-Za-z]{1,20}$", media_type):
                raise ValueError("Bad media type.")
            params["mediaType"] = media_type
    launch(target, app_id, params or None)


YOUTUBE_HOSTS = {"youtube.com", "youtu.be", "music.youtube.com", "youtube-nocookie.com"}
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def parse_link(link):
    """A YouTube or Netflix link -> the app and deep-link parameters to open it."""
    url = urllib.parse.urlparse(link.strip())
    if url.scheme not in ("http", "https"):
        raise ValueError("Paste the whole link, starting with https://")
    host = (url.hostname or "").lower()
    for prefix in ("www.", "m."):
        if host.startswith(prefix):
            host = host[len(prefix):]
    parts = [p for p in url.path.split("/") if p]

    if host in YOUTUBE_HOSTS:
        video = None
        if host == "youtu.be" and parts:
            video = parts[0]
        elif parts[:1] == ["watch"]:
            video = urllib.parse.parse_qs(url.query).get("v", [""])[0]
        elif len(parts) >= 2 and parts[0] in ("shorts", "live", "embed", "v"):
            video = parts[1]
        if video and YOUTUBE_ID_RE.match(video):
            return {"app": "YouTube", "appId": "837", "params": {"contentId": video, "mediaType": "live"}}
        raise ValueError("That YouTube link doesn't point to a single video.")

    if host == "netflix.com":
        if len(parts) >= 2 and parts[-2] in ("title", "watch") and parts[-1].isdigit():
            media_type = "movie" if parts[-2] == "watch" else "series"
            return {"app": "Netflix", "appId": "12", "params": {"contentId": parts[-1], "mediaType": media_type}}
        raise ValueError("That Netflix link doesn't point to a show or movie.")

    return None


# --- Finding TVs ---------------------------------------------------------------

def ssdp_search(wait=2.5):
    """Ask the network 'any Rokus here?' and collect the replies."""
    message = (
        "M-SEARCH * HTTP/1.1\r\n"
        "HOST: 239.255.255.250:1900\r\n"
        'MAN: "ssdp:discover"\r\n'
        "MX: 2\r\n"
        "ST: roku:ecp\r\n\r\n"
    ).encode()
    found = set()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP) as sock:
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        sock.settimeout(0.25)
        start = time.monotonic()
        sends = 0
        while time.monotonic() - start < wait:
            if sends < 3 and time.monotonic() - start >= sends * 0.6:
                try:
                    sock.sendto(message, SSDP_ADDR)
                except OSError:
                    pass
                sends += 1
            try:
                data, _ = sock.recvfrom(2048)
            except (socket.timeout, OSError):
                continue
            for line in data.decode(errors="replace").split("\r\n"):
                if line.lower().startswith("location:"):
                    url = urllib.parse.urlparse(line.split(":", 1)[1].strip())
                    if url.hostname:
                        found.add(f"{url.hostname}:{url.port or ECP_PORT}")
    return found


def local_ipv4():
    # Connecting a UDP socket sends nothing; it just picks the outgoing interface.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        try:
            sock.connect(("10.254.254.254", 1))
            return sock.getsockname()[0]
        except OSError:
            return None


def scan_subnet(timeout=0.4):
    """Fallback when SSDP is blocked: look for port 8060 on this computer's /24."""
    ip = local_ipv4()
    if not ip or not ipaddress.ip_address(ip).is_private:
        return set()
    network = ipaddress.ip_network(f"{ip}/24", strict=False)

    def probe(host):
        try:
            with socket.create_connection((str(host), ECP_PORT), timeout=timeout):
                return f"{host}:{ECP_PORT}"
        except OSError:
            return None

    with ThreadPoolExecutor(64) as pool:
        return {hit for hit in pool.map(probe, network.hosts()) if hit}


def discover():
    candidates = ssdp_search()
    if not candidates:
        candidates = scan_subnet()

    def describe(address):
        try:
            target = parse_target(address)
            return summarize(target, device_info(target))
        except (TVError, ET.ParseError, ValueError):
            return None

    with ThreadPoolExecutor(16) as pool:
        tvs = [tv for tv in pool.map(describe, sorted(candidates)) if tv]
    return sorted(tvs, key=lambda tv: tv["name"].lower())


# --- Undo list -----------------------------------------------------------------

LOG_LOCK = threading.Lock()


def read_log():
    try:
        with open(LOG_PATH, encoding="utf-8") as f:
            entries = json.load(f)
        return entries if isinstance(entries, list) else []
    except FileNotFoundError:
        return []
    except json.JSONDecodeError:
        # Keep the damaged file instead of overwriting it.
        os.replace(LOG_PATH, LOG_PATH + f".damaged-{int(time.time())}")
        return []


def append_log(raw):
    action = raw.get("action")
    if action not in ("removed", "reinstalled"):
        raise ValueError("Unknown undo-list action.")
    app_id = str(raw.get("id", ""))
    if not APP_ID_RE.match(app_id):
        raise ValueError("Bad channel id.")
    entry = {
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "action": action,
        "id": app_id,
        "name": str(raw.get("name", ""))[:200],
        "version": str(raw.get("version", ""))[:64],
        "tv": str(raw.get("tv", ""))[:200],
        "address": display_address(parse_target(raw.get("address"))),
    }
    with LOG_LOCK:
        entries = read_log()
        entries.append(entry)
        tmp = LOG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entries, f, indent=2)
        os.replace(tmp, LOG_PATH)
    return entry


# --- Shortcuts, scenes and phone pairing (remote-settings.json) ------------------

SETTINGS_LOCK = threading.Lock()
SCENE_STEPS = {"power_on", "power_off", "open", "volume_up", "volume_down", "mute", "wait"}
SCENE_ID_RE = re.compile(r"^[a-z0-9]{1,16}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def read_settings():
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        os.replace(SETTINGS_PATH, SETTINGS_PATH + f".damaged-{int(time.time())}")
        return {}


def update_settings(change):
    """Read, change and save the settings file in one locked step."""
    with SETTINGS_LOCK:
        data = read_settings()
        change(data)
        tmp = SETTINGS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, SETTINGS_PATH)


def tv_settings(address):
    with SETTINGS_LOCK:
        tv = read_settings().get("tvs", {}).get(address, {})
    return {
        "favorites": tv.get("favorites", []),
        "scenes": tv.get("scenes", []),
        "services": tv.get("services", {}),
    }


def save_tv_settings(address, **changes):
    def change(data):
        tv = data.setdefault("tvs", {}).setdefault(address, {})
        tv.update({key: value for key, value in changes.items() if value is not None})
    update_settings(change)


def clean_services(raw):
    """{app id: True/False} for 'I pay for this service'."""
    if not isinstance(raw, dict) or len(raw) > 100:
        raise ValueError("Bad services list.")
    services = {}
    for app_id, has_it in raw.items():
        if not APP_ID_RE.match(str(app_id)):
            raise ValueError("Bad channel id.")
        services[str(app_id)] = bool(has_it)
    return services


def bounded_int(value, low, high):
    try:
        return max(low, min(int(value), high))
    except (TypeError, ValueError):
        return low


def clean_favorites(raw):
    if not isinstance(raw, list):
        raise ValueError("Bad shortcut list.")
    favorites = []
    for app_id in raw[:24]:
        app_id = str(app_id)
        if not APP_ID_RE.match(app_id):
            raise ValueError("Bad channel id.")
        if app_id not in favorites:
            favorites.append(app_id)
    return favorites


def clean_scenes(raw):
    if not isinstance(raw, list) or len(raw) > 20:
        raise ValueError("Bad scene list.")
    scenes = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("Bad scene.")
        name = str(item.get("name", "")).strip()[:40]
        if not name:
            raise ValueError("Give each scene a name.")
        steps = []
        for step in (item.get("steps") or [])[:20]:
            action = step.get("do") if isinstance(step, dict) else None
            if action not in SCENE_STEPS:
                raise ValueError("Unknown scene step.")
            clean = {"do": action}
            if action == "open":
                app_id = str(step.get("target", ""))
                if not APP_ID_RE.match(app_id):
                    raise ValueError(f'Pick what to open in "{name}".')
                clean["target"] = app_id
            elif action in ("volume_up", "volume_down"):
                clean["n"] = bounded_int(step.get("n"), 1, 50)
            elif action == "wait":
                clean["n"] = bounded_int(step.get("n"), 1, 30)
            steps.append(clean)
        if not steps:
            raise ValueError(f'"{name}" needs at least one step.')
        at = item.get("at") or None
        if at is not None and not TIME_RE.match(str(at)):
            raise ValueError("Write times like 22:30.")
        scene_id = str(item.get("id") or "")
        if not SCENE_ID_RE.match(scene_id):
            scene_id = secrets.token_hex(4)
        scenes.append({"id": scene_id, "name": name, "steps": steps, "at": at})
    return scenes


def run_scene(target, scene):
    for step in scene["steps"]:
        action = step["do"]
        if action == "power_on":
            press(target, "PowerOn")
            time.sleep(4)  # give the TV time to wake up
        elif action == "power_off":
            press(target, "PowerOff")
        elif action == "open":
            launch(target, step["target"])
            time.sleep(2)
        elif action == "volume_up":
            press_sequence(target, ["VolumeUp"] * step["n"], delay=0.15)
        elif action == "volume_down":
            press_sequence(target, ["VolumeDown"] * step["n"], delay=0.15)
        elif action == "mute":
            press(target, "VolumeMute")
        elif action == "wait":
            time.sleep(step["n"])


def scheduler():
    """Runs scenes that have a daily time. Only works while this program is running."""
    last_run = {}
    while True:
        now = datetime.now()
        minute = now.strftime("%Y-%m-%d %H:%M")
        with SETTINGS_LOCK:
            tvs = read_settings().get("tvs", {})
        for address, tv in tvs.items():
            for scene in tv.get("scenes", []):
                key = (address, scene.get("id"))
                if scene.get("at") == now.strftime("%H:%M") and last_run.get(key) != minute:
                    last_run[key] = minute
                    threading.Thread(target=run_scheduled, args=(address, scene), daemon=True).start()
        time.sleep(15)


def run_scheduled(address, scene):
    try:
        run_scene(parse_target(address), scene)
        print(f"Ran scheduled scene \"{scene['name']}\" on {address}.")
    except (TVError, ValueError) as err:
        print(f"Scheduled scene \"{scene['name']}\" didn't finish: {err}")


# --- Rules and the background watcher ---------------------------------------------

RULES_DEFAULT = {
    "autopilot": {"enabled": False, "target": "", "skipNext": False},
    "bedtime": {"enabled": False, "start": "21:00", "end": "06:30", "extendUntil": 0},
    "nightGuard": {"enabled": False, "start": "00:30", "end": "06:00", "idleMinutes": 3},
    "limits": {},      # app id -> minutes per day
    "blocked": [],     # app ids sent back to the home screen
    "redirects": {},   # app id -> app id to open instead
    "log": False,      # keep a viewing log even with no other rules on
}
POLL_SECONDS = 4
ACTION_COOLDOWN = 6


def clean_rules(raw):
    if not isinstance(raw, dict):
        raise ValueError("Bad rules.")

    def clock(value, fallback):
        value = str(value or fallback)
        if not TIME_RE.match(value):
            raise ValueError("Write times like 21:30.")
        return value

    def app_id(value, allow_empty=False):
        value = str(value or "")
        if allow_empty and not value:
            return ""
        if not APP_ID_RE.match(value):
            raise ValueError("Pick an app or input.")
        return value

    autopilot = raw.get("autopilot") or {}
    bedtime = raw.get("bedtime") or {}
    night = raw.get("nightGuard") or {}
    limits = raw.get("limits") or {}
    redirects = raw.get("redirects") or {}
    if not isinstance(limits, dict) or not isinstance(redirects, dict) or len(limits) > 50 or len(redirects) > 50:
        raise ValueError("Bad rules.")
    enabled_autopilot = bool(autopilot.get("enabled"))
    target = app_id(autopilot.get("target"), allow_empty=True)
    if enabled_autopilot and not target:
        raise ValueError("Pick what the TV should open when it turns on.")
    rules = {
        "autopilot": {"enabled": enabled_autopilot, "target": target, "skipNext": bool(autopilot.get("skipNext"))},
        "bedtime": {
            "enabled": bool(bedtime.get("enabled")),
            "start": clock(bedtime.get("start"), "21:00"),
            "end": clock(bedtime.get("end"), "06:30"),
            "extendUntil": bounded_int(bedtime.get("extendUntil"), 0, 4_102_444_800),
        },
        "nightGuard": {
            "enabled": bool(night.get("enabled")),
            "start": clock(night.get("start"), "00:30"),
            "end": clock(night.get("end"), "06:00"),
            "idleMinutes": bounded_int(night.get("idleMinutes", 3), 1, 30),
        },
        "limits": {app_id(k): bounded_int(v, 1, 720) for k, v in limits.items()},
        "blocked": sorted({app_id(a) for a in (raw.get("blocked") or [])[:50]}),
        "redirects": {app_id(k): app_id(v) for k, v in redirects.items() if k != v},
        "log": bool(raw.get("log")),
    }
    # Refuse rules that would fight each other.
    for source, dest in rules["redirects"].items():
        if rules["redirects"].get(dest) == source:
            raise ValueError("Two swaps point at each other, so the TV would flip back and forth.")
        if dest in rules["blocked"]:
            raise ValueError("A swap opens a blocked app. Unblock it or change the swap.")
    if rules["autopilot"]["enabled"] and (rules["autopilot"]["target"] in rules["blocked"] or rules["autopilot"]["target"] in rules["redirects"]):
        raise ValueError("The app set to open when the TV turns on is blocked or swapped. Pick another one.")
    return rules


def tv_rules(address):
    with SETTINGS_LOCK:
        raw = read_settings().get("tvs", {}).get(address, {}).get("rules")
    if not raw:
        return json.loads(json.dumps(RULES_DEFAULT))
    try:
        return clean_rules(raw)
    except ValueError:
        return json.loads(json.dumps(RULES_DEFAULT))


def rules_active(rules):
    return bool(
        (rules["autopilot"]["enabled"] and rules["autopilot"]["target"])
        or rules["bedtime"]["enabled"] or rules["nightGuard"]["enabled"]
        or rules["limits"] or rules["blocked"] or rules["redirects"] or rules["log"]
    )


def in_window(start, end, moment):
    """Is moment (a datetime) inside start-end, where end may be after midnight?"""
    now = moment.strftime("%H:%M")
    return start <= now < end if start <= end else (now >= start or now < end)


HOME_NAMES = {"roku", "roku dynamic menu", "home"}


def is_home(app):
    """Roku's home screen reports as 'Roku' with no id, or on newer TVs as 'Roku Dynamic Menu'."""
    return not app.get("id") or (app.get("name") or "").strip().lower() in HOME_NAMES


def notify_mac(message):
    """A macOS notification, so alerts aren't missed when the page is closed."""
    script = f'display notification {json.dumps(message)} with title "Roku Detox"'
    try:
        subprocess.run(["osascript", "-e", script], timeout=5, capture_output=True)
    except (OSError, subprocess.SubprocessError):  # never let a notification break the watcher
        pass


class TVWatch:
    """What the watcher remembers about one TV between checks."""

    def __init__(self):
        self.power = None          # "on", "standby", "off", or None before the first check
        self.reachable = None
        self.control = None
        self.app = {"id": "", "name": ""}
        self.on_since = None
        self.autopilot = None      # None, "pending", or ("verify", started, tries)
        self.home_polls = 0
        self.idle_since = None
        self.bedtime_warned = None
        self.last_action = 0
        self.last_seen = 0
        self.unreachable_since = None
        self.alerted = set()
        self.said = {}             # message key -> last time, to avoid repeating
        self.usage_day = None
        self.usage = {}
        self.last_tick = None
        self.last_saved = 0


class Watcher:
    def __init__(self):
        self.tvs = {}
        self.lock = threading.Lock()
        self.events = self.load_events()
        self.awake = None
        self.last_round = 0

    # Persistence

    @staticmethod
    def load_events():
        try:
            with open(ACTIVITY_PATH, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (FileNotFoundError, json.JSONDecodeError):
            return []

    def save_events(self):
        tmp = ACTIVITY_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.events[-300:], f, indent=1)
        os.replace(tmp, ACTIVITY_PATH)

    def event(self, address, message, kind="action", key=None, every=600):
        """Record something the watcher did or noticed. key+every stop repeats."""
        state = self.tvs.get(address)
        if key and state:
            last = state.said.get(key, 0)
            if time.time() - last < every:
                return
            state.said[key] = time.time()
        entry = {"time": datetime.now(timezone.utc).isoformat(timespec="seconds"), "tv": address, "kind": kind, "message": message}
        with self.lock:
            self.events.append(entry)
            self.events = self.events[-300:]
            self.save_events()
        print(f"[{datetime.now():%H:%M}] {message}")
        if kind == "alert":
            notify_mac(message)

    @staticmethod
    def load_usage(address, day):
        try:
            with open(USAGE_PATH, encoding="utf-8") as f:
                return dict(json.load(f).get(address, {}).get(day, {}))
        except (FileNotFoundError, json.JSONDecodeError, AttributeError):
            return {}

    def save_usage(self, address, day, usage):
        with SETTINGS_LOCK:
            try:
                with open(USAGE_PATH, encoding="utf-8") as f:
                    data = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                data = {}
            days = data.setdefault(address, {})
            days[day] = {k: int(v) for k, v in usage.items()}
            for old in sorted(days)[:-14]:  # keep two weeks
                del days[old]
            tmp = USAGE_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=1)
            os.replace(tmp, USAGE_PATH)

    # Keeping the Mac awake

    def keep_awake(self, wanted):
        if wanted == (self.awake is not None):
            return
        if wanted:
            try:
                self.awake = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
            except OSError:
                self.awake = None
        elif self.awake:
            self.awake.terminate()
            self.awake = None

    # The loop

    def run(self):
        while True:
            started = time.time()
            with SETTINGS_LOCK:
                addresses = list(read_settings().get("tvs", {}))
            active = {}
            for address in addresses:
                rules = tv_rules(address)
                if rules_active(rules):
                    active[address] = rules
            self.keep_awake(bool(active))
            for address, rules in active.items():
                try:
                    self.check(address, rules)
                except (TVError, ValueError, ET.ParseError) as err:
                    self.event(address, f"Rules hit a problem: {err}", kind="info", key="problem", every=900)
            for address in list(self.tvs):
                if address not in active:
                    self.tvs.pop(address)
            self.last_round = time.time()
            time.sleep(max(1, POLL_SECONDS - (time.time() - started)))

    def act(self, state, fn):
        if time.time() - state.last_action < ACTION_COOLDOWN:
            return False
        state.last_action = time.time()
        fn()
        return True

    def check(self, address, rules):
        target = parse_target(address)
        state = self.tvs.setdefault(address, TVWatch())
        now = time.time()
        local = datetime.now()

        try:
            info = device_info(target)
        except TVError:
            if state.power == "on":
                state.on_since = None
            state.power = "off"
            state.reachable = False
            state.unreachable_since = state.unreachable_since or now
            if now - state.unreachable_since > 180 and (rules["bedtime"]["enabled"] or rules["limits"] or rules["blocked"]):
                self.event(address, "Can't reach the TV. If it's on, rules aren't working. Check it's on the same Wi-Fi, and that Fast TV start is on.", kind="alert", key="unreachable", every=3600)
            return
        state.reachable = True
        state.unreachable_since = None
        state.last_seen = now

        mode = info.get("ecp-setting-mode", "")
        state.control = mode not in ("limited", "disabled")
        if not state.control:
            self.event(address, "The TV's remote access was switched to Limited, so rules can't run. Set it back: Settings > System > Advanced system settings > Control by mobile apps > Network access > Default.", kind="alert", key="limited", every=3600)
            return
        state.said.pop("limited", None)

        powered = info.get("power-mode") == "PowerOn"
        was = state.power
        state.power = "on" if powered else "standby"
        if not powered:
            state.on_since = None
            state.autopilot = None
            state.idle_since = None
            state.bedtime_warned = None
            self.tick_usage(address, state, None, now)
            return

        app = active_app(target)
        state.app = app
        if was in ("standby", "off"):  # it just turned on
            state.on_since = now
            state.home_polls = 0
            state.autopilot = "pending"
            self.event(address, f"TV turned on ({'home screen' if is_home(app) else plain_name(app)}).", kind="info")
        elif was is None:
            state.on_since = now  # already on when we started watching

        self.tick_usage(address, state, app, now)

        if self.bedtime(address, rules, state, target, local, now):
            return
        if self.night_guard(address, rules, state, target, local, now):
            return
        self.autopilot(address, rules, state, target, app, now)
        self.app_rules(address, rules, state, target, app)

    # Individual rules

    def tick_usage(self, address, state, app, now):
        day = datetime.now().strftime("%Y-%m-%d")
        if state.usage_day != day:
            if state.usage_day and state.usage:
                self.save_usage(address, state.usage_day, state.usage)
            state.usage_day = day
            state.usage = self.load_usage(address, day)
            state.last_tick = None
        if app is not None and state.last_tick is not None:
            key = app.get("id") or "home"
            state.usage[key] = state.usage.get(key, 0) + min(now - state.last_tick, POLL_SECONDS * 3)
        state.last_tick = now if app is not None else None
        if now - state.last_saved > 60:
            state.last_saved = now
            self.save_usage(address, day, state.usage)

    def bedtime(self, address, rules, state, target, local, now):
        rule = rules["bedtime"]
        if not rule["enabled"] or not in_window(rule["start"], rule["end"], local) or now < rule["extendUntil"]:
            state.bedtime_warned = None
            return False
        if state.bedtime_warned is None:
            state.bedtime_warned = now
            friendly_notice(target, "Bedtime", "The TV turns off in 1 minute.")
            self.event(address, "It's bedtime. The TV turns off in 1 minute.", kind="info", key="bedtime-warn", every=120)
            return True
        grace = 15 if state.said.get("bedtime-off", 0) > now - 6 * 3600 else 60
        if now - state.bedtime_warned >= grace:
            if self.act(state, lambda: press(target, "PowerOff")):
                state.bedtime_warned = None
                state.said["bedtime-off"] = now
                self.event(address, "Bedtime. Turned the TV off.")
        return True

    def night_guard(self, address, rules, state, target, local, now):
        rule = rules["nightGuard"]
        if not rule["enabled"] or not in_window(rule["start"], rule["end"], local) or not state.on_since:
            state.idle_since = None
            return False
        if not in_window(rule["start"], rule["end"], datetime.fromtimestamp(state.on_since)):
            return False  # it was already on before the quiet hours began
        try:
            playing = now_playing(target)["state"] == "play"
        except TVError:
            playing = False
        if playing and not is_home(state.app):
            state.idle_since = None
            return False
        state.idle_since = state.idle_since or now
        if now - state.idle_since >= rule["idleMinutes"] * 60:
            if self.act(state, lambda: press(target, "PowerOff")):
                when = datetime.fromtimestamp(state.on_since).strftime("%-I:%M %p")
                self.event(address, f"The TV turned on by itself at {when} and nothing was playing. Turned it back off.", kind="alert")
                state.idle_since = None
            return True
        return False

    def autopilot(self, address, rules, state, target, app, now):
        rule = rules["autopilot"]
        if not rule["enabled"] or not rule["target"] or not state.autopilot:
            return
        if state.autopilot == "pending":
            if now - state.on_since > 45:
                state.autopilot = None
                return
            if not is_home(app):
                state.autopilot = None
                if app.get("id", "").startswith("tvinput."):
                    self.event(address, f"TV turned on to {plain_name(app)}, so it was left alone.", kind="info")
                return
            state.home_polls += 1
            if state.home_polls < 2:
                return  # wait for a second check, in case it's still switching inputs
            if rule["skipNext"]:
                state.autopilot = None
                def consume(data):
                    data["tvs"][address]["rules"]["autopilot"]["skipNext"] = False
                update_settings(consume)
                self.event(address, "Skipped opening an app this time, as asked.", kind="info")
                return
            if self.act(state, lambda: launch(target, rule["target"])):
                state.autopilot = ("verify", now, 1)
            return
        _, started, tries = state.autopilot
        if now - started < 6:
            return
        name = app_label(target, rule["target"])
        if app.get("id") == rule["target"]:
            self.event(address, f"TV turned on. Opened {name} instead of the home screen.")
            state.autopilot = None
        elif tries < 2 and is_home(app):
            if self.act(state, lambda: launch(target, rule["target"])):
                state.autopilot = ("verify", time.time(), tries + 1)
        else:
            state.autopilot = None
            if is_home(app):
                self.event(address, f"Couldn't open {name} after the TV turned on. It's on the home screen.", kind="alert")

    def app_rules(self, address, rules, state, target, app):
        app_id = app.get("id")
        if not app_id:
            return
        name = plain_name(app)
        if app_id in rules["blocked"]:
            if self.act(state, lambda: friendly_notice(target, "Not on this TV", f"{name} is blocked.") or press(target, "Home")):
                self.event(address, f"{name} is blocked. Closed it.", key=f"blocked-{app_id}", every=300)
            return
        limit = rules["limits"].get(app_id)
        if limit is not None and state.usage.get(app_id, 0) >= limit * 60:
            if self.act(state, lambda: friendly_notice(target, "Time's up", f"{name} is done for today.") or press(target, "Home")):
                self.event(address, f"Time's up for {name} today ({limit} minute{'s' if limit != 1 else ''}). Closed it.", key=f"limit-{app_id}", every=900)
            return
        instead = rules["redirects"].get(app_id)
        if instead:
            if self.act(state, lambda: launch(target, instead)):
                self.event(address, f"{name} opened, so opened {app_label(target, instead)} instead.", key=f"redirect-{app_id}", every=120)

    # For the page

    def status(self, address):
        state = self.tvs.get(address)
        rules = tv_rules(address)
        day = datetime.now().strftime("%Y-%m-%d")
        usage = state.usage if state and state.usage_day == day else self.load_usage(address, day)
        with self.lock:
            events = [e for e in self.events if e["tv"] == address][-40:]
        return {
            "rules": rules,
            "active": rules_active(rules),
            "watching": bool(state) and time.time() - self.last_round < POLL_SECONDS * 4,
            "awake": self.awake is not None,
            "power": state.power if state else None,
            "app": state.app if state else None,
            "bedtimeNow": rules["bedtime"]["enabled"] and in_window(rules["bedtime"]["start"], rules["bedtime"]["end"], datetime.now()),
            "usage": {k: int(v) for k, v in usage.items()},
            "events": events[::-1],
        }


def plain_name(app):
    return (app.get("name") or app.get("id") or "the app").replace(" ", " ")


APP_NAMES = {}


def app_label(target, app_id):
    """A channel's name for messages, looked up once per TV."""
    names = APP_NAMES.get(target)
    if names is None or app_id not in names:
        try:
            names = {a["id"]: a["name"].replace(" ", " ") for a in list_apps(target)}
            APP_NAMES[target] = names
        except TVError:
            names = names or {}
    return names.get(app_id, app_id)


def save_rules(address, rules):
    save_tv_settings(address, rules=rules)


def extend_bedtime(address, minutes):
    rules = tv_rules(address)
    start = max(time.time(), rules["bedtime"]["extendUntil"])
    rules["bedtime"]["extendUntil"] = int(start + minutes * 60)
    save_rules(address, rules)
    return rules


def doctor(target):
    """Plain-language checks for why control might not work."""
    checks = []
    address = display_address(target)
    try:
        info = device_info(target)
    except TVError:
        moved = None
        with SETTINGS_LOCK:
            serial = read_settings().get("tvs", {}).get(address, {}).get("serial")
        if serial:
            moved = next((tv for tv in discover() if tv.get("serial") == serial and tv["address"] != address), None)
        checks.append({"ok": False, "title": "The TV isn't answering",
                       "fix": (f"Your TV moved to {moved['address']}. Pick it in the TV list at the top." if moved else
                               "Check it's plugged in and on the same Wi-Fi as this Mac. If the TV is off, turn on Fast TV start (Settings > System > Power) so this page can wake it.")})
        return {"checks": checks, "moved": moved}
    if info.get("serial-number"):
        update_settings(lambda data: data.setdefault("tvs", {}).setdefault(address, {}).update(serial=info["serial-number"]))
    checks.append({"ok": True, "title": "The TV answers on your Wi-Fi", "fix": ""})
    mode = info.get("ecp-setting-mode", "")
    limited = mode in ("limited", "disabled")
    checks.append({"ok": not limited, "title": "Remote access is on" if not limited else "Remote access is set to Limited",
                   "fix": "" if not limited else "Settings > System > Advanced system settings > Control by mobile apps > Network access > Default."})
    wakes = info.get("supports-wake-on-wlan") == "true"
    checks.append({"ok": True, "title": "Turning the TV on from here",
                   "fix": "Works while Fast TV start is on (Settings > System > Power). If it's off, the TV disappears from the network when it's turned off." + ("" if wakes else " This TV may not support waking over Wi-Fi.")})
    mode_name = {"default": "Default", "enabled": "Enabled", "permissive": "Permissive"}.get(mode)
    if mode_name == "Permissive":
        checks.append({"ok": False, "title": "Remote access is set to Permissive",
                       "fix": "Default is enough for this page and lets in fewer devices."})
    return {"checks": checks, "moved": None}


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def household():
    """{"open": bool, "pin": sha256 hex or ""}: anyone on the Wi-Fi may use the page when open."""
    with SETTINGS_LOCK:
        info = read_settings().get("household") or {}
    return {"open": bool(info.get("open")), "pin": str(info.get("pin") or "")}


def set_household(open_access=None, pin=None):
    def change(data):
        info = data.setdefault("household", {"open": False, "pin": ""})
        if open_access is not None:
            info["open"] = bool(open_access)
        if pin is not None:
            digits = str(pin).strip()
            if digits and not re.match(r"^\d{4,8}$", digits):
                raise ValueError("Use 4 to 8 digits for the household PIN.")
            info["pin"] = token_hash(digits) if digits else ""
    update_settings(change)


def local_name():
    """This computer's Bonjour name (like my-mac.local), if it has one."""
    name = socket.gethostname().strip().lower()
    if not name or name == "localhost":
        return None
    return name if name.endswith(".local") else name.split(".")[0] + ".local"


class PhoneAccess:
    """A second web server on the home network: for paired phones, and for the Detox Home TV app.

    It runs while the phone remote is on, or while a TV has Detox Home installed.
    Phones get in with a one-time code; the TV app gets in with a token baked into its install.
    """

    def __init__(self, port, icon_cache):
        self.port = port
        self.icon_cache = icon_cache
        self.server = None
        self.url = None
        self.code = None
        self.phone_on = False
        self.failures = 0
        self.locked_until = 0
        self.lock = threading.Lock()

    def status(self):
        with SETTINGS_LOCK:
            paired = len(read_settings().get("phoneTokens", []))
        return {"enabled": self.phone_on, "url": self.url, "code": self.code if self.phone_on else None, "paired": paired}

    def new_code(self):
        self.code = f"{secrets.randbelow(1_000_000):06d}"

    def listen(self):
        """Make sure the home-network server is running. Returns its address."""
        with self.lock:
            if self.server:
                return self.url
            ip = local_ipv4()
            if not ip or not ipaddress.ip_address(ip).is_private:
                raise ValueError("This Mac doesn't seem to be on a home network.")
            try:
                server = ThreadingHTTPServer((ip, self.port), Handler)
            except OSError as err:
                raise ValueError(f"Couldn't open port {self.port} on your home network ({err.strerror}).") from None
            server.allowed_hosts = {f"{ip}:{self.port}"}
            server.icon_cache = self.icon_cache
            server.phone = self
            server.lan = True
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.server = server
            self.url = f"http://{ip}:{self.port}"
            return self.url

    def stop_listening_if_unused(self):
        with SETTINGS_LOCK:
            legacy_tv_app = legacy_tv_apps(read_settings())
        with self.lock:
            if self.server and not self.phone_on and not legacy_tv_app and not household()["open"]:
                self.server.shutdown()
                self.server.server_close()
                self.server = self.url = None

    def start(self):
        self.listen()
        with self.lock:
            self.phone_on = True
            self.new_code()
        update_settings(lambda data: data.update(phone=True))

    def stop(self, forget=False):
        with self.lock:
            self.phone_on = False
            self.code = None

        def change(data):
            data["phone"] = False
            if forget:
                data["phoneTokens"] = []
        update_settings(change)
        self.stop_listening_if_unused()

    def pair(self, code):
        """Check a code typed on a phone. Returns a new login token."""
        with self.lock:
            if not self.phone_on:
                raise ValueError("The phone remote is turned off on the Mac.")
            if time.time() < self.locked_until:
                raise ValueError("Too many wrong codes. Wait a minute, then use the new code on your Mac.")
            if not self.code or not hmac.compare_digest(str(code).strip(), self.code):
                self.failures += 1
                if self.failures >= 5:
                    self.failures = 0
                    self.locked_until = time.time() + 60
                    self.new_code()
                raise ValueError("That code didn't match. Check the code on your Mac.")
            self.failures = 0
            self.new_code()  # each code works once
        token = secrets.token_urlsafe(32)
        update_settings(lambda data: data.setdefault("phoneTokens", []).append(token_hash(token)))
        return token

    def is_paired(self, token):
        if not token or not self.phone_on:
            return False
        with SETTINGS_LOCK:
            known = read_settings().get("phoneTokens", [])
        digest = token_hash(token)
        return any(hmac.compare_digest(digest, k) for k in known)

    @staticmethod
    def tv_for_device(token):
        """The TV address a Detox Home install belongs to, or None."""
        if not token:
            return None
        digest = token_hash(token)
        with SETTINGS_LOCK:
            apps = read_settings().get("tvApps") or {}
        for address, info in apps.items():
            if hmac.compare_digest(digest, info.get("token", "")):
                return address
        return None


# --- Detox Home (the custom Roku app) ----------------------------------------------

APP_DIR = os.path.join(HERE, "roku-app")
TV_APP_SEEN = {}       # target -> (checked at, installed?)
# Favorites / options changed on this page while Detox Home wasn't open: {target: {"favorites": params, ...}}.
# Handed over the next time it's seen in front (active_app), so the TV never has to ask for them.
TV_APP_PENDING = {}
TV_APP_PENDING_LOCK = threading.Lock()
TV_APP_REQUIRED = [
    "manifest", "source/main.brs", "components/HomeScene.xml",
    "images/icon_focus_hd.png", "images/icon_focus_sd.png", "images/splash_fhd.png",
]


def legacy_tv_apps(settings):
    """Copies of Detox Home from before 2.0, which reach this Mac over Wi-Fi with a device token."""
    return [address for address, info in (settings.get("tvApps") or {}).items() if (info or {}).get("token")]


def tv_app_present(target, max_age=60):
    """Is Detox Home (Roku's 'dev' app slot) installed on this TV?"""
    checked = TV_APP_SEEN.get(target)
    if checked and time.time() - checked[0] < max_age:
        return checked[1]
    try:
        present = any(a["id"] == "dev" for a in list_apps(target))
    except TVError:
        return bool(checked and checked[1])
    TV_APP_SEEN[target] = (time.time(), present)
    return present


def tv_app_in_front(target):
    try:
        return active_app(target, deliver=False).get("id") == "dev"
    except TVError:
        return False


def send_to_tv_app(target, params, open_it=True):
    """Hand Detox Home a deep link. It's an ECP input event when the app is already open (nothing
    restarts); otherwise the app is opened with it, or (open_it=False) nothing is sent.
    Returns True if it was sent."""
    if tv_app_in_front(target):
        status, body, _ = ecp(target, "input?" + urllib.parse.urlencode(params), "POST")
        check(status, body)
        return True
    if not open_it:
        return False
    launch(target, "dev", params)
    return True


def show_on_tv(target, kind, item):
    """Open Detox Home on the TV showing a video, message or notice. The item travels inside the
    link itself (contentId=inline), so the TV never has to reach this computer."""
    if not tv_app_present(target):
        raise ValueError("Detox Home isn't on this TV yet. Install it from the TV app menu first.")
    params = {"contentId": "inline", "mediaType": kind}
    params.update({key: str(value) for key, value in item.items() if value not in (None, "")})
    send_to_tv_app(target, params)


def favorites_link(address):
    favorites = [f for f in tv_settings(address)["favorites"] if f != "dev"]
    return {"contentId": "favorites", "ids": ",".join(favorites)}


def settings_link(options):
    return {"contentId": "settings", "clock24": "1" if options.get("clock24") else "0",
            "simpleMode": "1" if options.get("simpleMode") else "0"}


def push_to_tv_app(target, kind, params):
    """Give Detox Home new favorites or options without interrupting the TV: now if it's open,
    otherwise the next time it's seen open. Returns True if it's on the TV now."""
    with TV_APP_PENDING_LOCK:
        TV_APP_PENDING.setdefault(target, {})[kind] = params
    try:
        return tv_app_present(target, max_age=300) and deliver_pending(target)
    except (TVError, ET.ParseError):
        return False   # it's still waiting; it goes the next time Detox Home is seen open


def deliver_pending(target, app=None):
    """Send what's waiting for Detox Home, if it's in front. Returns True if everything went."""
    with TV_APP_PENDING_LOCK:
        waiting = dict(TV_APP_PENDING.get(target) or {})
    if not waiting:
        return True
    in_front = (app.get("id") == "dev") if app is not None else tv_app_in_front(target)
    if not in_front:
        return False
    for kind, params in waiting.items():
        try:
            status, body, _ = ecp(target, "input?" + urllib.parse.urlencode(params), "POST")
            check(status, body)
        except TVError:
            return False
        with TV_APP_PENDING_LOCK:
            if (TV_APP_PENDING.get(target) or {}).get(kind) == params:
                TV_APP_PENDING[target].pop(kind)
    return True


def friendly_notice(target, title, text):
    """Show a rule's notice on the TV if Detox Home is installed. Returns True if shown."""
    try:
        if not tv_app_present(target):
            return False
        show_on_tv(target, "notice", {"title": title, "text": text})
        return True
    except (TVError, ValueError):
        return False


def build_package(config=None):
    """Zip the roku-app folder. Detox Home needs nothing else: it reads its apps from the TV.

    config (from tv_seed) becomes config.json, what a fresh install starts with: favorites,
    clock24, simpleMode, tvName, and a seed id so the TV uses it once per install.
    """
    missing = [f for f in TV_APP_REQUIRED if not os.path.exists(os.path.join(APP_DIR, f))]
    if missing:
        raise ValueError("Detox Home isn't finished being built yet. Try again in a few minutes.")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for root, dirs, files in os.walk(APP_DIR):
            dirs[:] = sorted(d for d in dirs if d != "tools" and not d.startswith("."))
            for name in sorted(files):
                if name.startswith(".") or name in ("README.md", "config.json"):
                    continue
                path = os.path.join(root, name)
                archive.write(path, os.path.relpath(path, APP_DIR))
        if config:
            archive.writestr("config.json", json.dumps(config))
    return buffer.getvalue()


def installer_url(target):
    host, port = target
    return f"http://{host}:{80 if port == ECP_PORT else port}/plugin_install"


def send_to_installer(target, password, package=None):
    """Talk to Roku's developer web installer. package=None removes the app."""
    boundary = secrets.token_hex(16)
    fields = [("mysubmit", "Install" if package else "Delete")]
    body = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        for name, value in fields
    )
    body += f'--{boundary}\r\nContent-Disposition: form-data; name="archive"; filename="detox-home.zip"\r\nContent-Type: application/zip\r\n\r\n'.encode()
    body += (package or b"") + f"\r\n--{boundary}--\r\n".encode()
    url = installer_url(target)
    passwords = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    passwords.add_password(None, url, "rokudev", password)
    opener = urllib.request.build_opener(urllib.request.HTTPDigestAuthHandler(passwords))
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with opener.open(req, timeout=90) as resp:
            page = resp.read().decode(errors="replace")
    except urllib.error.HTTPError as err:
        if err.code == 401:
            raise ValueError("The TV didn't accept that password. It's the one you chose when you turned on developer mode.") from None
        raise TVError(f"The TV's installer refused (error {err.code}).") from None
    except (urllib.error.URLError, OSError):
        raise ValueError("Developer mode isn't on yet, so the TV has no installer to talk to. See the steps above.") from None
    failure = re.search(r"(Install Failure[^\"<\\]*|Delete Failure[^\"<\\]*)", page)
    if failure:
        raise TVError(f"The TV said: {failure.group(1).strip()}")
    if not re.search(r"Install Success|Identical to previous version|Delete Successful|Application Received", page, re.I):
        raise TVError("The TV's installer answered, but didn't say the install worked.")


def tv_app_options(address):
    with SETTINGS_LOCK:
        info = (read_settings().get("tvApps") or {}).get(address) or {}
    options = info.get("options") or {}
    return {"simpleMode": bool(options.get("simpleMode")), "clock24": bool(options.get("clock24"))}


def tv_seed(target):
    """What a fresh Detox Home starts with (its config.json). After that the TV keeps its own copy."""
    address = display_address(target)
    try:
        name = summarize(target, device_info(target))["name"]
    except TVError:
        name = ""
    return {"seed": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "favorites": [f for f in tv_settings(address)["favorites"] if f != "dev"],
            **tv_app_options(address), "tvName": name}


def install_tv_app(phone, target, password):
    if not password or len(password) > 200:
        raise ValueError("Type the developer password you chose on the TV.")
    address = display_address(target)
    options = tv_app_options(address)
    send_to_installer(target, password, build_package(tv_seed(target)))

    def change(data):
        apps = data.setdefault("tvApps", {})
        apps[address] = {"options": options, "installedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    update_settings(change)
    TV_APP_SEEN.pop(target, None)
    with TV_APP_PENDING_LOCK:
        TV_APP_PENDING.pop(target, None)   # the new copy starts with them
    phone.stop_listening_if_unused()       # older copies reached this Mac over Wi-Fi; this one doesn't


def remove_tv_app(phone, target, password):
    if not password:
        raise ValueError("Type the developer password you chose on the TV.")
    send_to_installer(target, password, None)
    address = display_address(target)
    update_settings(lambda data: (data.get("tvApps") or {}).pop(address, None))
    TV_APP_SEEN.pop(target, None)
    phone.stop_listening_if_unused()


# Detox Home before 2.0 asked this Mac for everything over Wi-Fi.
TV_APP_STANDALONE_VERSION = 2


def tv_app_status(target):
    address = display_address(target)
    with SETTINGS_LOCK:
        info = (read_settings().get("tvApps") or {}).get(address)
    host, port = target
    try:
        with socket.create_connection((host, 80 if port == ECP_PORT else port), timeout=1.5):
            dev_mode = True
    except OSError:
        dev_mode = False
    try:
        dev = next((a for a in list_apps(target) if a["id"] == "dev"), None)
        installed = dev is not None
        TV_APP_SEEN[target] = (time.time(), installed)
    except TVError:
        dev, installed = None, tv_app_present(target)
    ours = bool(dev) and dev["name"] == "Detox Home"
    major = re.match(r"\d+", (dev or {}).get("version", ""))
    return {
        "installed": installed,
        # Any copy of Detox Home works on its own now; nothing links it to this Mac.
        "linked": ours,
        "detoxHome": ours,
        "version": (dev or {}).get("version", ""),
        "outdated": ours and (int(major.group()) if major else 0) < TV_APP_STANDALONE_VERSION,
        "devMode": dev_mode,
        "options": tv_app_options(address),
        "installedAt": (info or {}).get("installedAt"),
        "ytdlp": bool(shutil.which("yt-dlp")),
        "appReady": all(os.path.exists(os.path.join(APP_DIR, f)) for f in TV_APP_REQUIRED),
    }


def save_tv_app_options(target, raw):
    """Save Detox Home's options and send them to the TV. Returns {options, delivered}."""
    address = display_address(target)
    options = {"simpleMode": bool(raw.get("simpleMode")), "clock24": bool(raw.get("clock24"))}

    def change(data):
        info = data.setdefault("tvApps", {}).setdefault(address, {})
        info["options"] = options
    update_settings(change)
    return {"options": options, "delivered": push_to_tv_app(target, "settings", settings_link(options))}


def tv_config(address, base, token):
    """What Detox Home shows on its home screen."""
    target = parse_target(address)
    settings = tv_settings(address)
    with SETTINGS_LOCK:
        options = ((read_settings().get("tvApps") or {}).get(address) or {}).get("options", {})
    try:
        apps = list_apps(target)
        name = summarize(target, device_info(target))["name"]
    except TVError:
        apps, name = [], "Your TV"
    by_id = {a["id"]: a for a in apps}
    key = urllib.parse.quote(token, safe="")
    favorites = [
        {"id": app_id, "name": by_id[app_id]["name"].replace(" ", " "),
         "icon": f"{base}/api/tv/icon?id={urllib.parse.quote(app_id)}&k={key}"}
        for app_id in settings["favorites"] if app_id in by_id and app_id != "dev"
    ]
    inputs = [
        {"id": a["id"], "name": a["name"].replace(" ", " "),
         "port": (re.sub(r"^tvinput\.hdmi(\d+)$", r"HDMI \1", a["id"]) if a["id"].startswith("tvinput.hdmi")
                  else {"tvinput.dtv": "Antenna", "tvinput.cvbs": "AV"}.get(a["id"], ""))}
        for a in apps if a["type"] == "tvin"
    ]
    return {"tvName": name, "simpleMode": bool(options.get("simpleMode")), "clock24": bool(options.get("clock24")),
            "favorites": favorites, "inputs": inputs}


# --- Sending a web page's video to the TV --------------------------------------------

BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 "
              "(KHTML, like Gecko) Version/17.0 Safari/605.1.15")
VIDEO_URL_RE = re.compile(r"""https?:(?:\\?/){2}[^\s"'<>]+?\.(?:m3u8|mp4|m4v|mov|mpd)(?:\?[^\s"'<>]*)?""", re.I)
FORMAT_SCORE = {"hls": 3, "mp4": 2, "dash": 1}
YTDLP_FORMAT = ("best[protocol^=m3u8][vcodec!=none][acodec!=none]/best[ext=mp4][vcodec!=none][acodec!=none]/"
                "best[vcodec!=none][acodec!=none]")


def stream_format(url):
    path = urllib.parse.urlparse(url).path.lower()
    if path.endswith(".m3u8"):
        return "hls"
    if path.endswith(".mpd"):
        return "dash"
    return "mp4"


# Ad and tracker hosts. Videos from these are never picked, and their pages are never opened,
# so a pre-roll ad doesn't get sent to the TV in place of the real video.
AD_HOSTS = (
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "imasdk.googleapis.com",
    "adservice.google", "amazon-adsystem.com", "adnxs.com", "moatads.com", "taboola.com",
    "outbrain.com", "popads.net", "popcash.net", "propellerads", "pubmatic.com", "rubiconproject.com",
    "criteo.", "advertising.com", "adform.net", "smartadserver.com", "spotxchange.com",
    "springserve.com", "teads.tv", "exoclick.com", "juicyads.com", "trafficjunky", "adsterra",
    "hilltopads", "onclickads", "admaven", "revcontent.com", "mgid.com", "openx.net",
    "casalemedia.com", "indexww.com", "sharethrough.com", "media.net", "adsystem", "adserver",
)
AD_PATH_RE = re.compile(r"(^|[/_.-])(ads?|adserver|preroll|pre-roll|vast|vpaid|sponsor(ed)?)([/_.-]|$)", re.I)
PLAYABLE_RE = re.compile(r"\.(m3u8|mp4|m4v|mov|mpd)$", re.I)


def is_ad_url(url):
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    return any(marker in host for marker in AD_HOSTS) or bool(AD_PATH_RE.search(parsed.path))


def fetch_page(url, referer=None, limit=3_000_000):
    """Read a page's HTML only: no scripts, images or ads are loaded.

    Returns (final url, html), or (final url, None, content type) for a video file.
    """
    headers = {"User-Agent": BROWSER_UA, "Accept": "text/html,*/*"}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            ctype = resp.headers.get("Content-Type", "")
            final_url = resp.geturl()
            if ctype.startswith("video/") or "mpegurl" in ctype:
                return final_url, None, ctype
            charset = resp.headers.get_content_charset() or "utf-8"
            try:
                raw = resp.read(limit)
            except http.client.IncompleteRead as partial:  # some sites cut the connection; use what arrived
                raw = partial.partial
            return final_url, raw.decode(charset, errors="replace"), ctype
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as err:
        raise TVError("Couldn't open that page from this Mac. Check the link and your internet connection.") from err


def page_meta(page, *names):
    for name in names:
        match = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]*content=["\']([^"\']+)' % re.escape(name), page, re.I) \
            or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']%s["\']' % re.escape(name), page, re.I)
        if match:
            return html_module.unescape(match.group(1))
    return None


def page_title(page):
    title = page_meta(page, "og:title", "twitter:title")
    if not title:
        match = re.search(r"<title[^>]*>([^<]+)</title>", page, re.I)
        title = html_module.unescape(match.group(1)).strip() if match else ""
    return title


def video_candidates(page, base_url):
    """Every video address a page mentions, as absolute URLs, ads left out."""
    found = [v for v in (page_meta(page, "og:video:secure_url", "og:video:url", "og:video"), page_meta(page, "twitter:player:stream")) if v]
    found += re.findall(r'<(?:video|source)[^>]+src=["\']([^"\']+)', page, re.I)
    found += re.findall(r'"contentUrl"\s*:\s*"([^"]+)"', page)
    found += VIDEO_URL_RE.findall(page)
    candidates = []
    for raw in found:
        clean = html_module.unescape(raw).replace("\\/", "/").replace("\\u002F", "/").replace("\\u0026", "&")
        absolute = urllib.parse.urljoin(base_url, clean)
        if absolute.startswith(("http://", "https://")) and absolute not in candidates and not is_ad_url(absolute):
            candidates.append(absolute)
    return candidates


def pick_video(candidates):
    """An embedded YouTube video, or the best playable file, or None."""
    for candidate in candidates:
        try:
            if parse_link(candidate):
                return {"url": candidate, "format": "app", "how": "an embedded YouTube video"}
        except ValueError:
            pass
    playable = [c for c in candidates if PLAYABLE_RE.search(urllib.parse.urlparse(c).path)]
    if not playable:
        return None
    best = max(playable, key=lambda c: FORMAT_SCORE[stream_format(c)])
    return {"url": best, "format": stream_format(best), "how": "the page"}


def find_video(page_url, direct=None):
    """Find a playable video file for a web page. Returns {url, title, format, how, referer}."""
    if direct and direct.startswith(("http://", "https://")) and len(direct) < 4000 and not is_ad_url(direct):
        return {"url": direct, "title": "", "format": stream_format(direct), "how": "the page's video player", "referer": page_url}
    url = urllib.parse.urlparse(page_url)
    if url.scheme not in ("http", "https") or not url.hostname:
        raise ValueError("Paste the whole link, starting with https://")
    if PLAYABLE_RE.search(url.path):
        return {"url": page_url, "title": os.path.basename(url.path), "format": stream_format(page_url), "how": "a direct video link", "referer": ""}

    fetched = fetch_page(page_url)
    final_url, page = fetched[0], fetched[1]
    if page is None:
        ctype = fetched[2]
        return {"url": final_url, "title": "", "format": "hls" if "mpegurl" in ctype else "mp4", "how": "a direct video link", "referer": ""}
    title = page_title(page)

    found = pick_video(video_candidates(page, final_url))
    if found:
        return {**found, "title": title, "referer": final_url}

    # Many sites put the player in an embedded frame. Look one level in (never into ad frames).
    frames = []
    for src in re.findall(r'<iframe[^>]+src=["\']([^"\']+)', page, re.I):
        absolute = urllib.parse.urljoin(final_url, html_module.unescape(src))
        if absolute.startswith(("http://", "https://")) and not is_ad_url(absolute) and absolute not in frames:
            frames.append(absolute)
    for frame in frames[:3]:
        try:
            frame_url, frame_page = fetch_page(frame, referer=final_url)[:2]
        except TVError:
            continue
        if frame_page is None:
            return {"url": frame_url, "title": title, "format": stream_format(frame_url), "how": "the page's video player", "referer": final_url}
        found = pick_video(video_candidates(frame_page, frame_url))
        if found:
            return {**found, "title": title, "how": "the page's video player", "referer": frame_url}

    ytdlp = shutil.which("yt-dlp")
    if ytdlp:
        try:
            result = subprocess.run([ytdlp, "-J", "--no-playlist", "--no-warnings", "-f", YTDLP_FORMAT, page_url],
                                    capture_output=True, text=True, timeout=60)
            info = json.loads(result.stdout or "{}")
            if info.get("url") and not is_ad_url(info["url"]):
                return {"url": info["url"], "title": info.get("title") or title,
                        "format": "hls" if "m3u8" in (info.get("protocol") or "") else stream_format(info["url"]),
                        "how": "yt-dlp", "referer": (info.get("http_headers") or {}).get("Referer", page_url)}
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            pass

    if re.search(r"widevine|fairplay|playready|\bdrm\b", page, re.I):
        raise ValueError("This site locks its videos (DRM), so they can't be sent to the TV. If it has a Roku app, use Find a show instead.")
    raise ValueError("Couldn't find a video on that page. Some sites load their videos in ways this can't see"
                     + ("." if ytdlp else ". Installing yt-dlp would help with many more sites."))


# --- My sites: search sites you choose, then send a result's video to the TV ----------

SITE_ID_RE = re.compile(r"^[a-z0-9]{1,16}$")
NAV_PATH_RE = re.compile(
    r"(^|/)(login|log-in|signin|sign-in|signup|sign-up|register|account|profile|privacy|terms|contact|about|"
    r"faq|help|dmca|cookie|cookies|legal|advertise|careers|genre|genres|category|categories|tag|tags|search|"
    r"feed|rss|sitemap|cart|subscribe|donate|share)(/|$)", re.I)
NAV_QUERY_RE = re.compile(r"(^|&)(page|sort|filter|lang|order|ref)=", re.I)


def site_list():
    with SETTINGS_LOCK:
        sites = read_settings().get("sites") or []
    return sites if isinstance(sites, list) else []


def clean_sites(raw):
    if not isinstance(raw, list) or len(raw) > 20:
        raise ValueError("You can add up to 20 sites.")
    sites = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("Bad site.")
        name = str(item.get("name", "")).strip()[:40]
        search = str(item.get("search", "")).strip()[:500]
        parsed = urllib.parse.urlparse(search.replace("{q}", "x"))
        if not name:
            raise ValueError("Give each site a name.")
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise ValueError(f'The search address for "{name}" needs to start with https://')
        if "{q}" not in search:
            raise ValueError(f'Put {{q}} in the search address for "{name}" where your search words go.')
        site_id = str(item.get("id") or "")
        if not SITE_ID_RE.match(site_id):
            site_id = secrets.token_hex(4)
        site = {"id": site_id, "name": name, "search": search}
        if item.get("deep") is True:  # the extension reads it in a hidden tab ("Look closer" worked)
            site["deep"] = True
        sites.append(site)
    return sites


def strip_tags(fragment):
    return re.sub(r"\s+", " ", html_module.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


# Many sites build their results with scripts, but still ship them inside the page as data
# (YouTube's ytInitialData, Next.js __NEXT_DATA__, schema.org JSON-LD...). Reading that data finds
# results with no scripts run, so ads and pop-ups still never load.
JSON_SCRIPT_RE = re.compile(r'<script\b[^>]*\btype=["\']application/(?:ld\+json|json)["\'][^>]*>(.*?)</script>', re.S | re.I)
SCRIPT_RE = re.compile(r'<script\b([^>]*)>(.*?)</script>', re.S | re.I)
ASSIGN_RE = re.compile(r'[A-Za-z_$][\w$]*\s*=\s*(?=[\[{])')
JSON_PARSE_RE = re.compile(r'JSON\.parse\(\s*"((?:\\.|[^"\\])*)"\s*\)', re.S)
URL_KEYS = ("url", "href", "link", "permalink", "canonicalUrl", "canonical_url", "webpageUrl", "webpage_url",
            "watchUrl", "watch_url", "shareUrl", "share_url", "pageUrl", "page_url", "path")
TITLE_KEYS = ("title", "headline", "name")
IMAGE_KEYS = ("thumbnail", "thumbnails", "thumbnailUrl", "thumbnail_url", "image", "images", "poster", "posterUrl",
              "poster_url", "cover", "coverImage", "cover_image", "contentImage", "artwork", "picture", "img", "still")
# Data that is clearly a video, show or movie, not a menu entry.
MEDIA_TYPES = {"videoobject", "movie", "tvseries", "tvepisode", "episode", "tvseason", "clip", "musicvideoobject",
               "creativework", "listitem"}
MEDIA_KEYS = ("duration", "lengthSeconds", "length_seconds", "runtime", "uploadDate", "upload_date", "releaseDate",
              "release_date", "episodeNumber", "seasonNumber", "viewCount", "view_count")
DROP_PARAMS = {"ref", "ref_src", "fbclid", "gclid", "si", "pp", "feature", "source", "from"}
MAX_DATA_BYTES = 6_000_000
MAX_DATA_NODES = 300_000
MAX_RESULTS = 20
MIN_GRID = 5  # this many links of the same shape (like /video/<id>) are the page's list of results


def scan_json(text, start):
    """End of the JSON object or array starting at text[start] (balanced brackets, strings skipped), or -1."""
    closers = {"{": "}", "[": "]"}
    stack = []
    i, n = start, min(len(text), start + MAX_DATA_BYTES)
    while i < n:
        ch = text[i]
        if ch == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
        elif ch in closers:
            stack.append(closers[ch])
        elif ch in "}]":
            if not stack or stack.pop() != ch:
                return -1
            if not stack:
                return i + 1
        i += 1
    return -1


def page_data(page):
    """JSON found in a page's scripts, in page order."""
    blobs, used = [], 0

    def add(text):
        nonlocal used
        text = text.strip()
        if len(text) < 2 or used + len(text) > MAX_DATA_BYTES or len(blobs) >= 40:
            return
        try:
            blobs.append(json.loads(text))
            used += len(text)
        except ValueError:
            pass

    for match in JSON_SCRIPT_RE.finditer(page):
        add(re.sub(r"^\s*(?:<!--|<!\[CDATA\[)|(?:-->|\]\]>)\s*$", "", match.group(1)))
    for script in SCRIPT_RE.finditer(page):
        attrs, body = script.group(1), script.group(2)
        if re.search(r"\bsrc=|application/(?:ld\+json|json)", attrs, re.I):
            continue  # scripts loaded from elsewhere aren't read; data scripts were read above
        for assign in ASSIGN_RE.finditer(body):
            stop = scan_json(body, assign.end())
            if stop - assign.end() >= 64:
                add(body[assign.end():stop])
        for parsed in JSON_PARSE_RE.finditer(body):
            if len(parsed.group(1)) >= 64:
                try:
                    add(json.loads('"' + re.sub(r"\\x([0-9a-fA-F]{2})", r"\\u00\1", parsed.group(1)) + '"'))
                except ValueError:
                    pass
    return blobs


def data_text(value):
    """Text from the shapes sites use for a title: "x", {"simpleText": "x"}, {"content": "x"}, {"runs": [{"text": "x"}]}."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("simpleText", "content", "text"):
            if isinstance(value.get(key), str):
                return value[key]
        runs = value.get("runs")
        if isinstance(runs, list):
            return "".join(run["text"] for run in runs if isinstance(run, dict) and isinstance(run.get("text"), str))
    return ""


def data_title(node, depth=0):
    for key in TITLE_KEYS:
        text = strip_tags(data_text(node.get(key)))
        if text:
            return text
    metadata = node.get("metadata")
    if depth < 3 and isinstance(metadata, dict):
        title = data_title(metadata, depth + 1)
        if title:
            return title
        for value in metadata.values():
            if isinstance(value, dict):
                title = data_title(value, depth + 1)
                if title:
                    return title
    return ""


def data_image(value, depth=0):
    """The first picture address in a value: a string, {"url": ..}, or a list (the last, usually largest)."""
    if depth > 5:
        return None
    if isinstance(value, str):
        return value if value.startswith(("https://", "http://", "//", "/")) else None
    if isinstance(value, list):
        for item in reversed(value):
            found = data_image(item, depth + 1)
            if found:
                return found
        return None
    if isinstance(value, dict):
        for key in ("url", "src", "contentUrl"):
            if isinstance(value.get(key), str):
                found = data_image(value[key], depth + 1)
                if found:
                    return found
        for item in value.values():
            if isinstance(item, (dict, list)):
                found = data_image(item, depth + 1)
                if found:
                    return found
    return None


def result_key(url):
    """A result's address without tracking bits, so the same video found twice counts once."""
    parsed = urllib.parse.urlparse(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in DROP_PARAMS]
    return ((parsed.hostname or "").lower().removeprefix("www.") + parsed.path.rstrip("/")
            + ("?" + urllib.parse.urlencode(query) if query else ""))


def link_shape(url):
    """Links in a results list look alike: same first folder, same depth, same query names."""
    parsed = urllib.parse.urlparse(url)
    parts = [part for part in parsed.path.split("/") if part]
    names = sorted({k for k, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)})
    return "|".join([(parsed.hostname or "").lower(), parts[0].lower() if parts else "", str(len(parts)), ",".join(names)])


def usable_link(absolute, final_url, base_root):
    parsed = urllib.parse.urlparse(absolute)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host.endswith(base_root) or is_ad_url(absolute):
        return False
    if parsed.path.strip("/") == "" or NAV_PATH_RE.search(parsed.path) or NAV_QUERY_RE.search(parsed.query):
        return False
    return absolute.rstrip("/") != final_url.rstrip("/")


def usable_image(url, final_url):
    if not url:
        return None
    url = urllib.parse.urljoin(final_url, html_module.unescape(url))
    return url if url.startswith("https://") and not is_ad_url(url) else None


def data_results(page, final_url, base_root):
    """[(result, sure)] from the page's data. sure: clearly a video or show, so it's kept even when its
    title doesn't repeat the search words (a search engine's own ranking is better than ours)."""
    youtube_page = base_root == "youtube.com"
    out = []
    budget = MAX_DATA_NODES
    for blob in page_data(page):
        stack = [blob]
        while stack and budget > 0:
            node = stack.pop()
            budget -= 1
            if isinstance(node, list):
                stack.extend(reversed(node))
                continue
            if not isinstance(node, dict):
                continue
            stack.extend(reversed([v for v in node.values() if isinstance(v, (dict, list))]))
            entry = None
            video_id = node.get("videoId")
            if not isinstance(video_id, str) and "VIDEO" in str(node.get("contentType", "")).upper():
                video_id = node.get("contentId")
            if isinstance(video_id, str) and YOUTUBE_ID_RE.match(video_id):
                title = data_title(node)
                if title:
                    image = None
                    for key in IMAGE_KEYS:
                        if key in node:
                            image = usable_image(data_image(node[key]), final_url)
                            if image:
                                break
                    entry = ({"title": title, "url": f"https://www.youtube.com/watch?v={video_id}", "image": image}, youtube_page)
            if entry is None:
                link = next((node[k] for k in URL_KEYS if isinstance(node.get(k), str) and node[k]), None)
                title = data_title(node) if link else ""
                if link and title:
                    absolute = urllib.parse.urljoin(final_url, html_module.unescape(link))
                    if usable_link(absolute, final_url, base_root):
                        kind = node.get("@type")
                        kinds = [k.lower() for k in (kind if isinstance(kind, list) else [kind]) if isinstance(k, str)]
                        sure = any(k in MEDIA_TYPES for k in kinds) or any(k in node for k in MEDIA_KEYS)
                        image = None
                        for key in IMAGE_KEYS:
                            if key in node:
                                image = usable_image(data_image(node[key]), final_url)
                                if image:
                                    break
                        entry = ({"title": title, "url": absolute, "image": image}, sure)
            if entry and 2 <= len(entry[0]["title"]) <= 140:
                out.append(entry)
    return out


def read_results(final_url, page, query):
    """Pick out the results on a search results page: from the page's data first, then from its links."""
    base_host = (urllib.parse.urlparse(final_url).hostname or "").lower()
    base_root = ".".join(base_host.split(".")[-2:])
    from_data = data_results(page, final_url, base_root)
    # Menus, headers and footers are never results.
    page = re.sub(r"<(script|style|noscript|svg|header|nav|footer|aside)\b.*?</\1>", " ", page, flags=re.S | re.I)
    words = [w for w in re.findall(r"\w+", query.lower()) if len(w) >= 3] or re.findall(r"\w+", query.lower())
    links, seen = [], {}
    for match in re.finditer(r'<a\b([^>]*?)href=["\']([^"\'#]+)["\']([^>]*)>(.*?)</a>', page, re.S | re.I):
        attrs, href, inner = match.group(1) + match.group(3), match.group(2), match.group(4)
        absolute = urllib.parse.urljoin(final_url, html_module.unescape(href))
        if not usable_link(absolute, final_url, base_root):
            continue
        image = re.search(r'<img[^>]+(?:data-src|data-original|data-lazy-src|src)=["\']([^"\']+)', inner, re.I)
        alt = re.search(r'<img[^>]+alt=["\']([^"\']+)', inner, re.I)
        title_attr = re.search(r'\btitle=["\']([^"\']+)', attrs, re.I)
        title = strip_tags((title_attr.group(1) if title_attr else "") or strip_tags(inner) or (alt.group(1) if alt else ""))
        if not 2 <= len(title) <= 140:
            continue
        image_url = usable_image(image.group(1), final_url) if image else None
        key = result_key(absolute)
        if key in seen:
            entry = seen[key]
            entry["image"] = entry["image"] or image_url
            if len(title) > len(entry["title"]):
                entry["title"] = title
            continue
        entry = {"title": title, "url": absolute, "image": image_url}
        seen[key] = entry
        links.append(entry)

    # Links (and data that may be a menu) must mention the search words; rank by how many, then by having a picture.
    def score(entry):
        haystack = (entry["title"] + " " + urllib.parse.unquote(urllib.parse.urlparse(entry["url"]).path)).lower()
        return sum(1 for w in words if w in haystack)
    # The biggest set of look-alike links that mentions the search words at least once is the
    # results list: kept whole, in the site's order (a menu of look-alike links never mentions them).
    shapes = {}
    for entry in links:
        shapes.setdefault(link_shape(entry["url"]), []).append(entry)
    grid = []
    for group in shapes.values():
        if len(group) >= MIN_GRID and len(group) > len(grid) and any(score(entry) > 0 for entry in group):
            grid = group
    in_grid = {id(entry) for entry in grid}
    sure = [entry for entry, certain in from_data if certain] + grid
    maybe = [entry for entry in [e for e, certain in from_data if not certain] + links
             if id(entry) not in in_grid and score(entry) > 0]
    maybe.sort(key=lambda r: (-score(r), r["image"] is None))
    results, keys = [], {}
    for entry in sure + maybe:
        key = result_key(entry["url"])
        if key in keys:
            keys[key]["image"] = keys[key]["image"] or entry["image"]
            continue
        keys[key] = entry
        results.append(entry)
    if not results:
        raise ValueError("No results could be read from this page. The site may build its results with scripts.")
    return results[:MAX_RESULTS]


def search_site(site, query):
    """Read a site's search results page and pick out the results."""
    url = site["search"].replace("{q}", urllib.parse.quote_plus(query))
    final_url, page = fetch_page(url, limit=3_000_000)[:2]
    if page is None:
        return []
    return read_results(final_url, page, query)


def search_sites(query):
    sites = site_list()
    if not sites:
        return []

    def one(site):
        try:
            return {"site": site["name"], "siteId": site["id"], "results": search_site(site, query)}
        except (TVError, ValueError) as err:
            return {"site": site["name"], "siteId": site["id"], "results": [], "error": str(err)}

    with ThreadPoolExecutor(min(8, len(sites))) as pool:
        return list(pool.map(one, sites))


def cast(target, page_url, direct=None, title=None):
    link = parse_link(page_url)
    if link:  # YouTube and Netflix have their own apps
        launch(target, link["appId"], link["params"])
        return {"app": link["app"], "title": title or ""}
    found = find_video(page_url, direct)
    if found["format"] == "app":
        link = parse_link(found["url"])
        launch(target, link["appId"], link["params"])
        return {"app": link["app"], "title": found["title"]}
    name = (title or found["title"] or urllib.parse.urlparse(page_url).hostname or "Video")[:200]
    show_on_tv(target, "video", {"title": name, "url": found["url"], "streamFormat": found["format"],
                                 "referer": found.get("referer", page_url)})
    return {"app": "Detox Home", "title": name, "how": found["how"]}


# --- Web server ----------------------------------------------------------------

def app_id_from(body):
    app_id = str(body.get("id", ""))
    if not APP_ID_RE.match(app_id):
        raise ValueError("Bad channel id.")
    return app_id


class Handler(BaseHTTPRequestHandler):
    server_version = "RokuDetox"

    def log_message(self, fmt, *args):
        pass

    # Responses

    def send(self, status, body, ctype="application/json", extra_headers=None):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (extra_headers or {"Cache-Control": "no-store"}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def fail(self, status, message, **extra):
        self.send(status, {"error": message, **extra})

    # Guards against other websites, DNS rebinding, and unpaired phones.

    def host_ok(self):
        return self.headers.get("Host", "") in self.server.allowed_hosts

    def from_our_page(self):
        return self.headers.get("X-Detox") == "1"

    @property
    def on_lan(self):
        return getattr(self.server, "lan", False)

    def paired(self):
        if not self.on_lan or household()["open"]:
            return True
        cookies = dict(
            part.strip().split("=", 1)
            for part in self.headers.get("Cookie", "").split(";")
            if "=" in part
        )
        return self.server.phone.is_paired(cookies.get("detox_token"))

    def run(self, fn):
        try:
            fn()
        except Blocked as err:
            self.fail(409, str(err), blocked=True)
        except TVError as err:
            self.fail(502, str(err))
        except ET.ParseError:
            self.fail(502, "The TV sent an answer this program doesn't understand.")
        except ValueError as err:
            self.fail(400, str(err))

    def do_GET(self):
        if not self.host_ok():
            return self.fail(403, "Open this page at the address Roku Detox printed.")
        url = urllib.parse.urlparse(self.path)
        query = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}

        if url.path in ("/", "/index.html"):
            with open(INDEX_PATH, "rb") as f:
                return self.send(200, f.read(), "text/html; charset=utf-8")
        if url.path.startswith("/api/tv/"):  # requests from Detox Home on the TV
            return self.run(lambda: self.from_tv_app(url.path, query, None))
        if not self.paired():
            return self.fail(401, "Enter the code from your Mac first.", pair=True)
        if url.path == "/api/icon":  # loaded by <img>, which can't send headers
            return self.run(lambda: self.icon(query))
        if not self.from_our_page():
            return self.fail(403, "Missing request header.")

        def target():
            return parse_target(query.get("tv"))

        routes = {
            "/api/discover": lambda: self.send(200, {"tvs": discover()}),
            "/api/device": lambda: self.device(query),
            "/api/apps": lambda: self.send(200, {"apps": list_apps(target())}),
            "/api/active": lambda: self.send(200, {"app": active_app(target())}),
            "/api/now": lambda: self.send(200, {"now": now_playing(target())}),
            "/api/find": lambda: self.find(query),
            "/api/find/show": lambda: self.send(200, find_show(target(), catalog_id(query.get("id"), "show"))),
            "/api/find/season": lambda: self.send(200, find_season(target(), catalog_id(query.get("id"), "season"))),
            "/api/find/next": lambda: self.next_episode(query),
            "/api/find/history": lambda: self.send(200, find_history(display_address(target()))),
            "/api/rules": lambda: self.send(200, WATCHER.status(display_address(target()))),
            "/api/doctor": lambda: self.send(200, doctor(target())),
            "/api/tvapp": lambda: self.send(200, tv_app_status(target())),
            "/api/sites": lambda: self.send(200, {"sites": site_list()}),
            "/api/sites/search": lambda: self.sites_search(query),
            "/api/log": lambda: self.send(200, {"entries": read_log()}),
            "/api/settings": lambda: self.send(200, tv_settings(display_address(target()))),
            "/api/phone": self.phone_status,
            "/api/household": self.household_status,
        }
        route = routes.get(url.path)
        if not route:
            return self.fail(404, "Not found.")
        self.run(route)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        tv_app = path.startswith("/api/tv/") and self.headers.get("X-Detox-Device")
        if not self.host_ok() or not (self.from_our_page() or tv_app):
            return self.fail(403, "Forbidden.")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self.fail(413, "Request too large.")
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self.fail(400, "Bad request.")

        if tv_app:
            return self.run(lambda: self.from_tv_app(path, {}, body))
        if path.startswith(PIN_PATHS) and not self.pin_ok():
            return self.fail(403, "Enter the household PIN to change this.", pin=True)
        if path == "/api/pair":
            return self.run(lambda: self.pair(body))
        if not self.paired():
            return self.fail(401, "Enter the code from your Mac first.", pair=True)

        def target():
            return parse_target(body.get("tv"))

        def address():
            return display_address(target())

        routes = {
            "/api/key": lambda: self.ok(press(target(), str(body.get("key", "")))),
            "/api/type": lambda: self.type_text(body),
            "/api/search": lambda: self.search(body),
            "/api/link": lambda: self.play_link(body),
            "/api/watch": lambda: self.ok(watch(
                target(), str(body.get("appId", "")),
                str(body["contentId"]) if body.get("contentId") else None,
                str(body["mediaType"]) if body.get("mediaType") else None,
            )),
            "/api/store": lambda: self.ok(open_store_page(target(), app_id_from(body))),
            "/api/launch": lambda: self.ok(launch(target(), app_id_from(body))),
            "/api/restart": lambda: self.ok(press_sequence(target(), RESTART_SEQUENCE)),
            "/api/log": lambda: self.send(200, {"entry": append_log(body)}),
            "/api/settings": lambda: self.save_settings(body),
            "/api/scene": lambda: self.scene(body),
            "/api/rules": lambda: self.save_rules(body),
            "/api/rules/extend": lambda: self.rules_extend(body),
            "/api/rules/skip": lambda: self.rules_skip(body),
            "/api/tvapp/install": lambda: self.mac_only(lambda: (install_tv_app(self.server.phone, target(), str(body.get("password", ""))), self.send(200, tv_app_status(target())))),
            "/api/tvapp/remove": lambda: self.mac_only(lambda: (remove_tv_app(self.server.phone, target(), str(body.get("password", ""))), self.send(200, tv_app_status(target())))),
            "/api/tvapp/options": lambda: self.send(200, save_tv_app_options(target(), body)),
            "/api/tv-message": lambda: self.tv_message(body),
            "/api/sites": lambda: self.save_sites(body),
            "/api/phone": lambda: self.phone_switch(body),
            "/api/household": lambda: self.household_switch(body),
            "/api/find/history": lambda: self.send(200, record_history(address(), body.get("item"))),
            "/api/find/history/remove": lambda: self.send(200, forget_history(address(), body.get("id"))),
            "/api/find/history/pin": lambda: self.send(200, pin_history(address(), body.get("id"), body.get("pinned"))),
        }
        route = routes.get(path)
        if not route:
            return self.fail(404, "Not found.")
        self.run(route)

    # Handlers

    def ok(self, _=None):
        self.send(200, {"ok": True})

    def device(self, query):
        target = parse_target(query.get("tv"))
        info = summarize(target, device_info(target))
        self.send(200, {"device": info, "control": can_control(target)})

    def icon(self, query):
        target = parse_target(query.get("tv"))
        app_id = query.get("id", "")
        if not APP_ID_RE.match(app_id):
            raise ValueError("Bad channel id.")
        cache = self.server.icon_cache
        key = (target, app_id)
        body, ctype = cache.get(key) or fetch_icon(target, app_id)
        if body is None:
            return self.fail(404, "No icon.")
        cache[key] = (body, ctype)
        self.send(200, body, ctype, {
            "Cache-Control": "private, max-age=86400",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        })

    def type_text(self, body):
        text = str(body.get("text", ""))
        if not 0 < len(text) <= 200:
            raise ValueError("Type between 1 and 200 characters.")
        press_sequence(parse_target(body.get("tv")), ["Lit_" + ch for ch in text], delay=0.08)
        self.ok()

    def search(self, body):
        keyword = str(body.get("text", "")).strip()
        if not 0 < len(keyword) <= 100:
            raise ValueError("Type something to search for.")
        search(parse_target(body.get("tv")), keyword)
        self.ok()

    def play_link(self, body):
        result = cast(parse_target(body.get("tv")), str(body.get("url", ""))[:4000],
                      str(body.get("video") or "")[:4000] or None, str(body.get("title") or "")[:200] or None)
        self.send(200, result)

    def find(self, query):
        words = str(query.get("q", "")).strip()
        if not 0 < len(words) <= 100:
            raise ValueError("Type a show or movie name.")
        self.send(200, find_titles(parse_target(query.get("tv")), words))

    def next_episode(self, query):
        number = str(query.get("episode", ""))
        if not re.match(r"^\d{1,6}$", number):
            raise ValueError("Bad episode number.")
        target = parse_target(query.get("tv"))
        show_id = catalog_id(query.get("show"), "show")
        season_id = catalog_id(query.get("season"), "season")
        self.send(200, find_next(target, show_id, season_id, int(number)))

    def save_settings(self, body):
        address = display_address(parse_target(body.get("tv")))
        save_tv_settings(
            address,
            favorites=clean_favorites(body["favorites"]) if "favorites" in body else None,
            scenes=clean_scenes(body["scenes"]) if "scenes" in body else None,
            services=clean_services(body["services"]) if "services" in body else None,
        )
        if "favorites" in body:  # Detox Home keeps its own copy: send it the new list
            push_to_tv_app(parse_target(address), "favorites", favorites_link(address))
        self.send(200, tv_settings(address))

    def sites_search(self, query):
        words = str(query.get("q", "")).strip()
        if not 0 < len(words) <= 100:
            raise ValueError("Type something to search for.")
        self.send(200, {"groups": search_sites(words)})

    def save_sites(self, body):
        sites = clean_sites(body.get("sites"))
        update_settings(lambda data: data.update(sites=sites))
        self.send(200, {"sites": sites})

    def pin_ok(self):
        """The Mac itself never needs the PIN; others do when one is set."""
        pin = household()["pin"]
        if not self.on_lan or not pin:
            return True
        given = self.headers.get("X-Detox-Pin", "")
        return bool(given) and hmac.compare_digest(token_hash(given), pin)

    def household_status(self):
        if self.on_lan:
            return self.fail(403, "Change this on the computer running Roku Detox.")
        info = household()
        phone = self.server.phone
        name = local_name()
        self.send(200, {"open": info["open"], "hasPin": bool(info["pin"]), "url": phone.url,
                        "localUrl": f"http://{name}:{phone.port}" if name else None})

    def household_switch(self, body):
        if self.on_lan:
            return self.fail(403, "Change this on the computer running Roku Detox.")
        set_household(body.get("open") if "open" in body else None, body.get("pin") if "pin" in body else None)
        if household()["open"]:
            self.server.phone.listen()
        else:
            self.server.phone.stop_listening_if_unused()
        self.household_status()

    def mac_only(self, fn):
        if self.on_lan:
            return self.fail(403, "Do this on your Mac.")
        fn()

    def tv_message(self, body):
        text = str(body.get("text", "")).strip()
        if not 0 < len(text) <= 200:
            raise ValueError("Type a message of up to 200 characters.")
        sender = "Sent from a phone" if self.on_lan else "Sent from the Mac"
        show_on_tv(parse_target(body.get("tv")), "message", {"text": text, "from": sender})
        self.ok()

    def from_tv_app(self, path, query, body):
        """Detox Home's own requests. Its token only reaches these few endpoints."""
        token = self.headers.get("X-Detox-Device") or (query.get("k") if path == "/api/tv/icon" else None)
        address = PhoneAccess.tv_for_device(token)
        if not address:
            return self.fail(401, "This copy of Detox Home isn't linked anymore. Install it again from the Mac.")
        target = parse_target(address)
        if body is None and path == "/api/tv/config":
            return self.send(200, tv_config(address, f"http://{self.headers.get('Host')}", token))
        if body is None and path == "/api/tv/item":  # items now travel inside the link itself
            return self.fail(404, "Install Detox Home again from the Mac to see this.")
        if body is None and path == "/api/tv/icon":
            return self.icon({"tv": address, "id": query.get("id", "")})
        if body is not None and path == "/api/tv/launch":
            launch(target, app_id_from(body))
            return self.ok()
        self.fail(404, "Not found.")

    def save_rules(self, body):
        address = display_address(parse_target(body.get("tv")))
        save_rules(address, clean_rules(body.get("rules")))
        self.send(200, WATCHER.status(address))

    def rules_extend(self, body):
        address = display_address(parse_target(body.get("tv")))
        extend_bedtime(address, bounded_int(body.get("minutes"), 5, 120))
        self.send(200, WATCHER.status(address))

    def rules_skip(self, body):
        address = display_address(parse_target(body.get("tv")))
        rules = tv_rules(address)
        rules["autopilot"]["skipNext"] = True
        save_rules(address, rules)
        self.send(200, WATCHER.status(address))

    def scene(self, body):
        target = parse_target(body.get("tv"))
        scenes = tv_settings(display_address(target))["scenes"]
        scene = next((s for s in scenes if s["id"] == body.get("id")), None)
        if not scene:
            raise ValueError("That scene doesn't exist anymore.")
        run_scene(target, scene)
        self.ok()

    # Phone access is switched on and off from the Mac only.

    def phone_status(self):
        if self.on_lan:
            return self.fail(403, "Change phone access on your Mac.")
        self.send(200, self.server.phone.status())

    def phone_switch(self, body):
        if self.on_lan:
            return self.fail(403, "Change phone access on your Mac.")
        phone = self.server.phone
        if body.get("enabled"):
            phone.start()
        else:
            phone.stop(forget=bool(body.get("forget")))
        self.send(200, phone.status())

    def pair(self, body):
        if not self.on_lan:
            return self.ok()
        token = self.server.phone.pair(body.get("code", ""))
        self.send(200, {"ok": True}, extra_headers={
            "Set-Cookie": f"detox_token={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000",
            "Cache-Control": "no-store",
        })


WATCHER = Watcher()


def main():
    parser = argparse.ArgumentParser(description="Find a Roku TV and clean it up from your browser.")
    parser.add_argument("--port", type=int, default=8642, help="port for the web page (default 8642)")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser automatically")
    parser.add_argument("--data", metavar="FOLDER", help="keep settings and logs in this folder (default: next to this file)")
    parser.add_argument("--household", action="store_true",
                        help="let anyone on your Wi-Fi open the page without pairing (for an always-on Pi or NAS)")
    parser.add_argument("--pin", metavar="DIGITS", help="household PIN needed from other devices to change rules, the TV app or sites")
    parser.add_argument("--export-tv-app", metavar="ZIP",
                        help="write Detox Home as a zip for installing from the TV's own installer page, then exit")
    args = parser.parse_args()
    if args.data:
        global LOG_PATH, SETTINGS_PATH, ACTIVITY_PATH, USAGE_PATH
        os.makedirs(args.data, exist_ok=True)
        LOG_PATH, SETTINGS_PATH, ACTIVITY_PATH, USAGE_PATH = (
            os.path.join(args.data, os.path.basename(path)) for path in (LOG_PATH, SETTINGS_PATH, ACTIVITY_PATH, USAGE_PATH))
        WATCHER.events = WATCHER.load_events()
    if args.household or args.pin:
        set_household(True if args.household else None, args.pin)
    if args.export_tv_app:
        with open(args.export_tv_app, "wb") as f:
            f.write(build_package())
        print(f"Wrote {args.export_tv_app}. Install it at http://<your TV's address> (developer mode must be on).")
        return

    icon_cache = {}
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.allowed_hosts = {f"127.0.0.1:{args.port}", f"localhost:{args.port}"}
    server.icon_cache = icon_cache
    server.phone = PhoneAccess(args.port, icon_cache)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Roku Detox is running at {url}")
    startup = read_settings()
    if household()["open"]:
        try:
            lan = server.phone.listen()
            name = local_name()
            print(f"Anyone on your Wi-Fi can open {f'http://{name}:{args.port}' if name else lan} (or {lan})")
        except ValueError as err:
            print(f"Household mode couldn't start: {err}")
    if startup.get("phone") or legacy_tv_apps(startup):
        try:
            if startup.get("phone"):
                server.phone.start()
                print(f"Phone remote is on at {server.phone.url}/ (code is shown on the Mac page)")
            else:
                server.phone.listen()
            if legacy_tv_apps(startup):
                print(f"An older Detox Home on the TV reaches this Mac at {server.phone.url}. Install it again to drop that.")
        except ValueError as err:
            print(f"The home-network connection couldn't start: {err}")
    print("Keep this window open while you use it. Press Ctrl+C to stop.")
    threading.Thread(target=scheduler, daemon=True).start()
    threading.Thread(target=WATCHER.run, daemon=True).start()
    if not args.no_browser:
        threading.Timer(0.6, webbrowser.open, (url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
