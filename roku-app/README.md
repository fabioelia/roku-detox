# Detox Home (Roku dev channel)

A calm home screen for the TV. Roku apps can't open other apps, so Detox Home asks the
Roku Detox program on the Mac to do it over the home network. BrightScript + SceneGraph, FHD.

The Mac program zips this folder and adds `config.json` at the zip root (don't commit one here):

```json
{"mac": "http://192.168.1.10:8642", "token": "<random string>", "tv": "192.168.1.50"}
```

If it's missing or unreadable the TV shows "Open Roku Detox on your Mac and press Install on TV again."

## Files

| File | What it does |
| --- | --- |
| `manifest` | Title, version, icons, splash, `ui_resolutions=fhd`, `supports_input_launch=1`, `screensaver_title=Detox Clock`. |
| `source/main.brs` | `Main(args)`: reads `pkg:/config.json`, shows `HomeScene`, forwards the launch deep link and `roInputEvent`s (ECP `input`) to the scene. `RunScreenSaver()`: shows `ClockSaverScene`. |
| `components/HomeScene.xml/.brs` | Everything on screen: clock, favorites and inputs rows, focus and remote keys, "Opening…" overlay, "Can't reach" banner, the 30 s config refresh, message/notice/video switching. |
| `components/DetoxTile.xml/.brs` | One tile: app icon with name under it, or an input box with name and port. Draws the focus outline. |
| `components/HttpTask.xml/.brs` | Task node, one per request: `roUrlTransfer` with the CA bundle, `X-Detox-Device` header, async GET/POST, 8 s timeout, JSON parsing. Also saves the 12/24-hour choice for the screensaver. |
| `components/MessageView.xml/.brs` | Full-screen message (big text, "from", "Press OK to close"). With a title it's the notice screen. |
| `components/VideoView.xml/.brs` | Full-screen `Video` node with the built-in trickplay UI; reports finished / error. |
| `components/ClockSaverScene.xml/.brs` | "Detox Clock" screensaver: black, soft gray clock + date, moves every 60 s. No network. |
| `components/DetoxUtils.brs` | Shared helpers (type-safe JSON reads, fonts, time/date formatting). |
| `images/` | `icon_focus_hd.png` 336x210, `icon_focus_sd.png` 248x140, `splash_fhd.png` 1920x1080. |
| `tools/make_images.py` | Redraws the images (stdlib only): `python3 tools/make_images.py`. Not needed on the TV. |

## Deep links (Mac -> TV, over ECP)

- App not running: `POST http://<tv>:8060/launch/dev?contentId=<item id>&mediaType=<kind>`
- App already in front: `POST http://<tv>:8060/input?contentId=<item id>&mediaType=<kind>`

`kind` is `video`, `message` or `notice`. The app shows "Loading…", fetches
`/api/tv/item?id=<item id>` and shows it. No `contentId` means the home screen.
OK / Back on a message or notice, Back during a video, or the video ending all go back to Home.
Back on Home exits the app.

## HTTP (TV -> Mac)

Every request sends `X-Detox-Device: <token>` and expects JSON. Timeout 8 s.

- `GET {mac}/api/tv/config` ->
  `{"tvName": str, "simpleMode": bool, "clock24": bool,
    "favorites": [{"id", "name", "icon"}], "inputs": [{"id", "name", "port"}]}`
  `icon` URLs are loaded directly by `Poster` nodes (no headers), so they must carry the token (`?k=...`).
  Fetched at start and every 30 s; the screen is only rebuilt when the answer changes.
- `POST {mac}/api/tv/launch` body `{"id": "<app or input id>"}` -> `{"ok": true}` or `{"error": "..."}`.
  Shows "Opening Netflix…"; Roku closes this app when the other app opens.
- `GET {mac}/api/tv/item?id=<item id>` -> one of
  - `{"kind": "video", "title", "url", "streamFormat": "hls"|"mp4"|"dash"|"", "referer"}`
    (empty `streamFormat`: `.m3u8` -> hls, `.mpd` -> dash, else mp4; non-empty `referer` is sent as a `Referer` header)
  - `{"kind": "message", "text", "from"}`
  - `{"kind": "notice", "title", "text"}`

When the Mac can't be reached (no answer, timeout) the home screen shows
"Can't reach Roku Detox on your Mac" and keeps the clock running. HTTP 401/403 shows
"Roku Detox on your Mac didn't accept this TV". An `{"error": "..."}` from `item` is shown as a notice.

## Screens

- **Home**: clock (12-hour unless `clock24`) and date top-left, TV name top-right, "Your apps"
  (290x218 icons) and "Inputs" rows. `simpleMode`: up to 6 favorites, big tiles in 2 rows of 3, no inputs.
- **Message / Notice**: very large text; OK or Back closes.
- **Video**: stock player UI; playback errors show "Couldn't play this video" with the error text.
- **Screensaver**: pick "Detox Clock" in Settings > Theme > Screensaver.
