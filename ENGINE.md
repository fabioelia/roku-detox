# Engines: one page, three ways to reach the TV

`index.html` is the only UI. It runs on top of one of three **engines**. Every engine speaks
the same API: the `/api/...` routes that `roku_detox.py` already serves, with the same request
fields and the same JSON response shapes. `roku_detox.py` is the reference implementation:
when in doubt, read its `Handler` routes and the functions they call.

| Engine | Where the page runs | How it reaches the TV | What works |
|---|---|---|---|
| **server** | served by `roku_detox.py` (Mac/Pi) | `fetch("/api/...")` to that program | everything |
| **extension** | `chrome-extension://<id>/app/index.html`, or a normal page when the extension is installed | `chrome.runtime.sendMessage` to the extension's service worker | everything except always-on rules (rules run while the browser is open) |
| **lite** | any plain `http://` page (phones) | direct `fetch(..., {mode: "no-cors"})` to `http://<tv>:8060` | send-only: buttons, apps, inputs, deep links, scenes |

## Choosing the engine (in the page, at startup)

1. `location.protocol === "chrome-extension:"` → **extension** (local: `chrome.runtime.sendMessage(msg)`).
2. URL has `?engine=lite` → **lite** (for testing the phone version from any server).
3. `GET /api/device?tv=` style probe: `fetch("/api/log", {headers: {"X-Detox": "1"}})` returns JSON → **server** (today's behavior).
4. The Roku Detox extension answers a ping (`chrome.runtime.sendMessage(EXTENSION_ID, {type: "ping"})`,
   only possible when the page's origin is listed in the extension's `externally_connectable`) → **extension** (remote).
5. Otherwise → **lite**.

`EXTENSION_ID` is read from `<meta name="roku-detox-extension" content="...">` in index.html (empty until published;
unpacked installs can set it from the extension's options page, saved in localStorage `detox.extensionId`).

## Message format (extension engine)

Request: `{type: "api", method: "GET" | "POST", path: "/api/apps", query: {tv: "192.168.1.50"}, body: {...} | null}`
Response: `{status: 200, data: {...}}` exactly like the HTTP status and JSON body the Python server returns
(errors: non-2xx status, `data.error` in plain English, plus `blocked: true` / `pair: true` flags where the server sets them).
Ping: `{type: "ping"}` → `{ok: true, version: "1.0.0", engine: "extension"}`.

## Icons

Pages never hard-code `/api/icon`. They call `engine.iconSrc(tv, appId)` which returns a value for `<img src>`:
- server: `/api/icon?tv=..&id=..`
- extension: the page renders `<img data-icon-tv=".." data-icon-id="..">` and an icon loader asks the engine
  (`{type: "icon", tv, id}` → `{dataUrl: "data:image/...;base64,..."}`, cached), then sets `src`.
- lite: `http://<tv>:8060/query/icon/<id>` directly (images don't need CORS; works on `http://` pages).

## Lite engine: what it implements itself (in the page)

- `POST /api/key`, `/api/type` (Lit_ per character), `/api/launch`, `/api/watch`, `/api/restart`, `/api/scene`
  → no-cors POSTs to the TV (`keypress/..`, `launch/..?contentId=..&mediaType=..`). Responses can't be read; report `{ok: true}`.
- `POST /api/link` → YouTube/Netflix links parsed in the page (same rules as `parse_link` in roku_detox.py) and launched;
  any other link → 501 `{error: "Sending videos from other sites needs the Roku Detox extension or the home program.", needs: "engine"}`.
- `GET /api/apps` → probe icons of a built-in list of well-known Roku app ids (and `tvinput.hdmi1..4`, `tvinput.dtv`,
  `tvinput.cvbs`) with `new Image()`: loads → installed. Same app shape as the server (`id, type, name, version: "", group, subscription`).
- `GET /api/device` → `{device: {address, name: "Roku TV", model: "", software: "", accessMode: "", uptime: 0, ...}, control: true}`
  (it can't read the TV; the TV's address is typed once and saved in localStorage).
- `GET/POST /api/settings` → localStorage (`detox.lite.settings.<tv>`), same shape as the server.
- Everything else → 501 `{error: "<feature> needs the Roku Detox extension or the home program.", needs: "engine"}`;
  the page shows these features greyed out with that sentence, never broken.

## Extension: files (all under `extension/`)

- `manifest.json` (MV3): `host_permissions` for `http://*/*` and `https://*/*` (TV on the LAN + catalog + sites),
  permissions `storage`, `alarms`, `notifications`, `webRequest`, `declarativeNetRequest`, `tabs`, `sidePanel`,
  `externally_connectable.matches` for `http://localhost/*`, `http://127.0.0.1/*` (and the future hosted lite origin).
- `sw.js` service worker: message router → handler modules in `engine/` (ES modules, `"type": "module"`).
- `engine/*.js`: `ecp.js` (TV requests, XML parsed with small regex helpers: no DOMParser in service workers),
  `catalog.js` (JustWatch, seasons, next episode, history), `video.js` (find a page's video, ad hosts, sniffed media),
  `store.js` (chrome.storage.local: settings, undo list, history, sites), `discover.js` (probe common home address ranges
  for `:8060/query/device-info`), `rules.js` (chrome.alarms every 30 s; same rule shapes as roku_detox.py).
- `sniffer`: `chrome.webRequest.onResponseStarted` notes media URLs (m3u8, mpd, mp4, mime `video/*`, `application/vnd.apple.mpegurl`)
  per tab, skipping ad hosts; the toolbar popup shows "Send to TV" for the current tab's best video.
- `POST /api/sites/look` `{siteId, q}` → `{group}` (extension only): "Look closer". Opens the site's results page in a
  hidden, muted tab (`chrome.tabs` + `chrome.scripting`), waits for its links to settle, reads the live page including
  shadow DOM, closes the tab, and marks the site `deep: true` so later searches read it that way. Search groups carry
  `canLookCloser` (plain read found nothing) and `lookedCloser`.
- `rules/ads.json`: declarativeNetRequest static rules blocking the same ad hosts as `AD_HOSTS` in roku_detox.py.
- `app/index.html`: a copy of `roku-detox/index.html`, made by `tools/build_extension.py` (never edited by hand).

## Detox Home (TV app)

Detox Home (2.0 and later) never connects to a computer, whichever engine installed it. It lists the TV's apps
and opens them through the TV's own ECP, and keeps favorites and options on the TV. Every engine only sends
things in, as deep links (`roku-app/README.md` has the full list):

- Items travel inside the link: `launch/dev?contentId=inline&mediaType=video&url=<encoded>&title=<encoded>`
  (or `mediaType=message&text=..`, `mediaType=notice&title=..&text=..`); `input?...` instead when Detox Home is in front.
- Favorites: `contentId=favorites&ids=12,837`. Options: `contentId=settings&clock24=0|1&simpleMode=0|1`.
  These go only as `input?...` while Detox Home is in front, so they never interrupt the TV. Otherwise they wait
  and are handed over the next time the engine sees Detox Home in front (any active-app check).
- `GET /api/tvapp` adds `detoxHome` (the dev app is Detox Home), `version`, and `outdated` (older than 2.0,
  which still asked the Mac for everything); `linked` now just means `detoxHome`.
- `POST /api/tvapp/options` answers `{options, delivered}` (delivered: on the TV now).
