#!/usr/bin/env python3
"""Answers what roku_detox.py would answer, so the JavaScript port can be compared with it.

Reads [{"fn": name, "args": [...]}, ...] as JSON on stdin and writes one result per call:
{"value": ...} or {"error": message, "type": exception class}. Network calls are never made:
the TV's answers are passed in (fake ECP), and catalog helpers get JustWatch data as arguments.
"""

import json
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
import roku_detox as rd  # noqa: E402

TARGET = ("127.0.0.1", 9072)


def with_tv(answers, fn):
    """Run fn with the TV's ECP answers {path: [status, body, ctype]}."""
    real = rd.ecp

    def fake(target, path, method="GET", timeout=4.0):
        status, body, ctype = answers.get(path.split("?")[0], [404, "", ""])
        return status, body.encode(), ctype

    rd.ecp = fake
    try:
        return fn()
    finally:
        rd.ecp = real


def read_results(final_url, page, query):
    """search_site() on a results page passed in, instead of fetched."""
    real = rd.fetch_page
    rd.fetch_page = lambda url, referer=None, limit=3_000_000, public_only=False: (final_url, page, "text/html")
    try:
        return rd.search_site({"search": "https://example.com/?q={q}"}, query)
    finally:
        rd.fetch_page = real


CALLS = {
    "read_results": read_results,
    "app_key": rd.app_key,
    "match_app": rd.match_app,
    "parse_link": rd.parse_link,
    "parse_roku_deeplink": rd.parse_roku_deeplink,
    "classify": rd.classify,
    "is_ad_url": rd.is_ad_url,
    "stream_format": rd.stream_format,
    "parse_target": lambda v: list(rd.parse_target(v)),
    "display_address": lambda h, p: rd.display_address((h, p)),
    "video_candidates": rd.video_candidates,
    "pick_video": rd.pick_video,
    "typed_sources": rd.typed_sources,
    "sites_links": rd.sites_links,
    "video_frames": rd.video_frames,
    "page_title": rd.page_title,
    "page_meta": lambda page, *names: rd.page_meta(page, *names),
    "strip_tags": rd.strip_tags,
    "clean_rules": rd.clean_rules,
    "clean_scenes": rd.clean_scenes,
    "clean_sites": rd.clean_sites,
    "clean_favorites": rd.clean_favorites,
    "clean_services": rd.clean_services,
    "clean_history_item": rd.clean_history_item,
    "annotate_offers": rd.annotate_offers,
    "poster_url": rd.poster_url,
    "rules_active": rd.rules_active,
    "in_window": lambda start, end, clock: rd.in_window(start, end, datetime.strptime("2026-11-07 " + clock, "%Y-%m-%d %H:%M")),
    "bedtime_now": lambda rule, when: rd.bedtime_now(rule, datetime.strptime(when, "%Y-%m-%d %H:%M")),
    "limit_today": lambda rules, when: rd.limit_today(rules, "12", datetime.strptime(when, "%Y-%m-%d %H:%M")),
    "clean_bonus": rd.clean_bonus,
    "bonus_minutes": lambda rules, key, when: rd.bonus_minutes(rules, key, datetime.strptime(when, "%Y-%m-%d %H:%M")),
    "total_limit_today": lambda rules, when: rd.total_limit_today(rules, datetime.strptime(when, "%Y-%m-%d %H:%M")),
    "next_bedtime_on": lambda rule, when: rd.next_bedtime_on(rule, datetime.strptime(when, "%Y-%m-%d %H:%M")),
    "is_home": rd.is_home,
    "bounded_int": rd.bounded_int,
    "device_info": lambda answers: with_tv(answers, lambda: rd.device_info(TARGET)),
    "summarize": lambda answers: with_tv(answers, lambda: rd.summarize(TARGET, rd.device_info(TARGET))),
    "list_apps": lambda answers: with_tv(answers, lambda: rd.list_apps(TARGET)),
    "active_app": lambda answers: with_tv(answers, lambda: rd.active_app(TARGET)),
    "now_playing": lambda answers: with_tv(answers, lambda: rd.now_playing(TARGET)),
    "check": lambda status, body: rd.check(status, body.encode()),
}


def main():
    out = []
    for call in json.load(sys.stdin):
        try:
            out.append({"value": CALLS[call["fn"]](*call.get("args", []))})
        except Exception as err:  # the port must fail the same way
            out.append({"error": str(err) or type(err).__name__, "type": type(err).__name__})
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
