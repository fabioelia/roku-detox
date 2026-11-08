#!/usr/bin/env python3
"""Runs Detox Home's page-reading code (roku-app/components/SiteSearch.brs) on a computer and compares it with
roku_detox.py on saved pages. No network, no TV.   python3 tools/test_site_search.py"""
import json
import os
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import brs_lite  # noqa: E402
import roku_detox as rd  # noqa: E402

failures = []
checks = 0


def same(label, got, want):
    global checks
    checks += 1
    if got != want:
        failures.append(f"{label}\n   TV:      {json.dumps(got, ensure_ascii=False)[:900]}\n   program: {json.dumps(want, ensure_ascii=False)[:900]}")


tv = brs_lite.Interpreter([os.path.join(ROOT, "roku-app/components/SiteSearch.brs"), os.path.join(ROOT, "roku-app/components/DetoxUtils.brs")])

BASE = "https://videos.example.com/search?q=open+movie"
for ref in ["/a/b.mp4", "b.mp4", "../c/d", "./e", "?x=1", "#top", "//cdn.example.org/x.m3u8", "https://other.example.net/p?q=1#f", "ftp://x.example/y",
            "javascript:alert(1)", "/a/../../b", "a//b/../c", "..", ".", "", "/", " /spaced", "/tab\tbed", "https://videos.example.com", "http:/odd", "mailto:a@b.c"]:
    for base in (BASE, "https://videos.example.com/dir/page.html?x=1", "https://videos.example.com"):
        same(f"urljoin({base!r}, {ref!r})", tv.call("ssUrlJoin", base, ref), urllib.parse.urljoin(base, ref))

for url in ["https://www.example.com/video/1/?utm_source=x&id=7&ref=y", "https://Example.com/a?b=1&b=2", "https://example.com/", "https://example.com/x?si=1"]:
    want = rd.result_key(url)
    same(f"result_key {url}", tv.call("ssResultKey", url), want)
for url in ["https://www.example.com/video/1/?id=7&a=2", "https://example.com/", "https://example.com/Watch/abc?z=1&a=2&z=3"]:
    same(f"link_shape {url}", tv.call("ssLinkShape", url), rd.link_shape(url))
for url in ["https://cdn.doubleclick.net/x.mp4", "https://example.com/ads/x.mp4", "https://example.com/video.mp4", "https://example.com/pre-roll.mp4"]:
    same(f"is_ad_url {url}", tv.call("ssIsAdUrl", url), rd.is_ad_url(url))
for text in ["A &amp; B", "&#39;x&#x27;", "&unknownthing; ok", "caf&eacute;", "no entities", "&#0;", "a &lt;b&gt; c"]:
    same(f"strip_tags {text}", tv.call("ssStripTags", f"<b>{text}</b>  more"), rd.strip_tags(f"<b>{text}</b>  more"))
for query in ["open movie", "a b", "Café au lait", "it's  a 4K!"]:
    want = [w for w in __import__("re").findall(r"\w+", query.lower()) if len(w) >= 3] or __import__("re").findall(r"\w+", query.lower())
    same(f"words {query}", tv.call("ssWords", query), want)
for query in ["open movie", "a&b=c", "what's (this)!*", "café ~x"]:
    same(f"quote_plus {query}", tv.call("ssSearchUrl", "https://x.example/s?q={q}", query), "https://x.example/s?q=" + urllib.parse.quote_plus(query))
for search in ["https://{q}.example.com/", "ftp://x/{q}", "https://x.example/a b?q={q}"]:
    same(f"bad search address {search}", tv.call("ssSearchUrl", search, "x"), "")
for link in ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://m.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/channel/abc", "https://www.netflix.com/title/80100172", "https://example.com/watch?v=dQw4w9WgXcQ"]:
    try:
        parsed = rd.parse_link(link)
    except ValueError:
        parsed = None
    same(f"app for {link}", tv.call("ssAppFor", link), parsed["app"] if parsed else "")


def grid(count, query="open movie", shape="/video/{}", image=True):
    return "".join(f'<div><a href="{shape.format(i)}"><img src="https://img.example.com/{i}.jpg" alt="x"><span>Open Movie part {i}</span></a></div>' if image and i % 2
                   else f'<div><a href="{shape.format(i)}">Open Movie part {i}</a></div>' for i in range(count))


NAV = '<nav><a href="/movies/1">Open movie in the menu</a></nav><header><a href="/video/99">Open movie header</a></header>'
PAGES = {
    "a grid of links": f"<html><body>{NAV}{grid(8)}<footer><a href='/about'>About</a></footer></body></html>",
    "a grid and stray links": f'{grid(6)}<a href="/news/open-movie-story">Open movie story</a><a href="/news/other">Other story</a><a href="/x/open"><img src="/rel.jpg">Open thing</a>',
    "tracking and repeats": '<a href="/watch/open?utm_source=a">Open</a><a href="/watch/open?utm_source=b" title="Open Movie, the long title">x</a><a href="/watch/open/"><img data-src="https://i.example.com/a.jpg">y</a>',
    "a menu only": '<a href="/login">Open movie login</a><a href="/category/open">Open movie category</a><a href="/">Open movie home</a>',
    "nothing relevant": '<a href="/page/1">Something else</a><a href="/page/2">Another</a>',
    "entities in links": '<a href="/v/1?a=1&amp;b=2">Open &amp; shut movie</a><a href="/v/2"><img alt="Open movie alt" src="https://i.example.com/z.jpg"></a>',
    "ld+json": '<script type="application/ld+json">{"@type": "VideoObject", "name": "Open Movie one", "url": "https://videos.example.com/watch/1", "thumbnailUrl": ["https://i.example.com/s.jpg", "https://i.example.com/l.jpg"]}</script>',
    "next data": '<script id="__NEXT_DATA__" type="application/json">{"props": {"items": [{"title": "Totally different name", "href": "/show/1", "duration": 90}, {"title": "A menu thing", "href": "/menu/open"}, {"title": "Open movie maybe", "href": "/maybe/1", "image": {"url": "https://i.example.com/m.jpg"}}]}}</script>',
    "script assignment": '<script>window.__DATA__ = {"results": [{"title": "Open Movie assigned", "url": "/watch/assigned", "lengthSeconds": 100}], "padding": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}; var a == {}; var short = {"a":1};</script>',
    "non-ascii before data": '<script>var nom = "café \U0001f600"; x = {"results": [{"title": "Café movie été", "url": "/watch/cafe", "duration": 3}], "padding": "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"};</script>',
    "JSON.parse": '<script>var d = JSON.parse("{\\"results\\":[{\\"title\\":\\"Open parsed\\",\\"url\\":\\"\\\\/watch\\\\/parsed\\",\\"duration\\":5,\\"pad\\":\\"\\x41\\x42zzzzzzzzzzzzzzzzzzzzzzzz\\"}]}");</script>',
    "video ids": '<script>var ytInitialData = {"contents": [{"videoRenderer": {"videoId": "dQw4w9WgXcQ", "title": {"runs": [{"text": "Open "}, {"text": "Movie"}]}, "thumbnail": {"thumbnails": [{"url": "https://i.example.com/1.jpg"}, {"url": "https://i.example.com/2.jpg"}]}}}]};</script>',
    "broken data": '<script type="application/ld+json">{not json</script><script src="/x.js">var a = {"title": "skip this one please it is loaded from elsewhere", "url": "/nope"};</script><a href="/ok/open">Open link</a>',
    "metadata titles": '<script type="application/json">{"item": {"url": "/m/1", "viewCount": 3, "metadata": {"inner": {"title": "Nested Open title"}}}, "list": [{"url": "/m/2", "name": {"simpleText": "Simple open"}, "uploadDate": "x"}]}</script>',
    "assignment with no name before it": '<script>foo("x") = {"results": [{"title": "Open not assigned", "url": "/watch/none", "duration": 1}], "padding": "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}; 9 = {"results": [{"title": "Open digits only", "url": "/watch/digits", "duration": 1}], "padding": "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"};</script><a href="/ok/open">Open link</a>',
    "a picture found on the second copy": '<script type="application/ld+json">{"@type": "VideoObject", "name": "Open Movie data", "url": "https://videos.example.com/watch/7"}</script><a href="/watch/7"><img src="https://i.example.com/seven.jpg">Open Movie link</a>',
    "html in titles": '<a href="/t/1" title="&lt;b&gt;Open&lt;/b&gt; movie">z</a><a href="/t/2"><h3>  Open\n movie   two </h3></a>',
    "too short or long": f'<a href="/t/1">o</a><a href="/t/2">{"Open " * 40}</a><a href="/t/3">Open ok</a>',
    "ads": '<a href="https://videos.example.com/ads/open">Open ad</a><a href="https://other.example.org/open">Open elsewhere</a><a href="/good/open"><img src="https://doubleclick.net/x.jpg">Open good</a>',
}
for label, page in PAGES.items():
    try:
        want = {"results": rd.read_results(BASE, page, "open movie")}
    except ValueError as err:
        want = {"error": str(err)}
    got = tv.call("ssReadResults", BASE, page, "open movie")
    if "error" in want or "error" in got:
        same(f"read_results: {label}", got, want)
        continue
    for item in got["results"]:
        item.pop("app")
    # Results from a page's data can be ordered differently on a TV (sorted keys); links can't.
    if "script" in page or "<scr" in page:
        got_sorted, want_sorted = (sorted(r, key=lambda e: e["url"]) for r in (got["results"], want["results"]))
        same(f"read_results (any order): {label}", got_sorted, want_sorted)
    else:
        same(f"read_results: {label}", got["results"], want["results"])

ORIGIN = "https://example.com/watch/1"
VIDEO_PAGES = [
    '<meta property="og:video" content="https://cdn.example.com/og.mp4"><meta name="twitter:player:stream" content="/tw.m3u8"><title>x</title>',
    '<meta content="https://cdn.example.com/rev.mp4" property="og:video:secure_url"><video src="/a.mp4?x=1&amp;y=2"></video>',
    '<video><source src="https://cdn.example.com/c.webm" type="video/webm"><source src=\'https://cdn.example.com/c.mp4\'></video>',
    '<script>var c = {"contentUrl": "https:\\/\\/cdn.example.com\\/m.m3u8", "x": "https:\\/\\/cdn.example.com\\/o.mpd"};</script>',
    '<script>p.setup({file: "/media/master.m3u8?t=1", image: "/x.jpg", b: \'\\/media\\/low.mp4\', n: "/a.mp4.jpg"});</script>',
    '<video src="/hls/p?t=9" type="application/x-mpegURL"></video><source type="application/dash+xml" src="https://cdn.example.com/dash/m"><source src="/s/plain" type="video/mp4; codecs=x"><source src="/s/w" type="video/webm">',
    '<iframe loading="lazy" data-src="//embed.example.org/v/3"></iframe><iframe src="/player/1"></iframe><iframe src="https://ads.doubleclick.net/x"></iframe>',
    '<script type="application/ld+json">{"embedUrl": "https:\\/\\/player.example.com\\/e\\/7"}</script>',
    '<a href="https://pubads.g.doubleclick.net/vast/ad.mp4">ad</a> https://cdn.example.com/raw/file.mov?token=abc',
    '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe><p>nothing else</p>',
    '<p>nothing</p>',
]
for page in VIDEO_PAGES:
    same(f"video_candidates {page[:60]}", tv.call("ssVideoCandidates", page, ORIGIN), rd.video_candidates(page, ORIGIN))
    same(f"typed_sources {page[:60]}", tv.call("ssTypedSources", page, ORIGIN), rd.typed_sources(page, ORIGIN))
    same(f"video_frames {page[:60]}", tv.call("ssVideoFrames", page, ORIGIN), rd.video_frames(page, ORIGIN))
    want = rd.pick_video(rd.video_candidates(page, ORIGIN), rd.typed_sources(page, ORIGIN))
    got = tv.call("ssPickVideo", tv.call("ssVideoCandidates", page, ORIGIN), tv.call("ssTypedSources", page, ORIGIN))
    same(f"pick_video {page[:60]}", got, {"url": want["url"], "format": want["format"]} if want else None)
    same(f"page_title {page[:60]}", tv.call("ssPageTitle", page), rd.page_title(page))

# On the TV a file beats an embedded YouTube video (it can't open the YouTube app).
files = ["https://www.youtube.com/embed/dQw4w9WgXcQ", "https://cdn.example.com/a.mp4"]
same("a file wins over YouTube on the TV", tv.call("ssPickVideo", files, []), {"url": files[1], "format": "mp4"})
for host, local in [("localhost", True), ("192.168.1.9", True), ("10.1.2.3", True), ("172.20.1.1", True), ("printer.local", True), ("172.32.1.1", False), ("example.com", False)]:
    same(f"local host {host}", tv.call("ssIsLocalHost", host), local)

count, problems = brs_lite.check_folder(os.path.join(ROOT, "roku-app"))
same("every .brs file parses", problems, [])
same("every component's functions and callbacks exist", brs_lite.check_app(os.path.join(ROOT, "roku-app")), [])
for failure in failures:
    print("FAIL", failure)
print(f"{checks} checks, {len(failures)} failed.")
sys.exit(1 if failures else 0)
