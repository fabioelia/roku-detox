# Detox Home (Roku dev channel)

A calm home screen for the TV. BrightScript + SceneGraph, FHD. It gets the TV's apps and their icons
and opens them through the TV's own remote-control service (Roku's ECP on port 8060, the same one Roku
Detox uses). Favorites and options are kept on the TV.

Roku OS 12 and later refuse those requests from apps on the TV itself, whatever "Control by mobile apps"
says (Roku's ECP docs: "Support for sending ECP commands from within a Roku app has been discontinued").
There the tiles stay empty and Detox Home explains that; its clock, screensaver, messages and videos
still work, since those are sent in from outside.

Roku Detox only ever sends things in (deep links, below). Nothing on the TV connects out to a computer.

When Roku Detox installs it from a computer it adds `config.json` at the zip root, used once per
install (don't commit one here):

```json
{"seed": "2026-11-08T10:00:00+00:00", "favorites": ["12", "837"], "clock24": false, "simpleMode": false, "tvName": "Living Room TV"}
```

Without it (installed from a browser) the TV starts with no favorites, which can be added on the TV.
`config.json` from Roku Detox before 2.0 (`{"mac", "token", "tv"}`) is ignored.

## Files

| File | What it does |
| --- | --- |
| `manifest` | Title, version (2.0.1; 2.0.0 was the first that asks the TV itself for its apps), icons, splash, `ui_resolutions=fhd`, `supports_input_launch=1`, `screensaver_title=Detox Clock`. |
| `source/main.brs` | `Main(args)`: reads `pkg:/config.json`, shows `HomeScene`, forwards the launch deep link and `roInputEvent`s (ECP `input`) to the scene. `RunScreenSaver()`: shows `ClockSaverScene`. |
| `components/HomeScene.xml/.brs` | Everything on screen: clock, the Favorites / All apps / Inputs rows, focus and remote keys, the * favorites button, "Opening…" overlay, message/notice/video switching. Keeps favorites and options in the registry. |
| `components/EcpTask.xml/.brs` | Task node, one per request to the TV's own ECP (`query/apps`, `query/device-info`, `launch/<id>`). Tries the address that answered last, then each of `roDeviceInfo.GetIPAddrs()`, then 127.0.0.1. 4 s timeout per address. Parses the XML. |
| `components/DetoxTile.xml/.brs` | One tile: app icon with name under it, or an input box with name and port. Draws the focus outline. |
| `components/MessageView.xml/.brs` | Full-screen message (big text, "from", "Press OK to close"). With a title it's the notice screen. |
| `components/VideoView.xml/.brs` | Full-screen `Video` node with the built-in trickplay UI; reports finished / error. |
| `components/ClockSaverScene.xml/.brs` | "Detox Clock" screensaver: black, soft gray clock + date, moves every 60 s. Reads the 12/24-hour choice from the registry. |
| `components/DetoxUtils.brs` | Shared helpers (type-safe JSON reads, fonts, time/date formatting). |
| `images/` | `icon_focus_hd.png` 336x210, `icon_focus_sd.png` 248x140, `splash_fhd.png` 1920x1080. |
| `tools/make_images.py` | Redraws the images (stdlib only): `python3 tools/make_images.py`. Not needed on the TV. |

## Kept on the TV

Registry section `DetoxHome`: `favorites` (JSON list of app ids), `clock24` and `simpleMode` (`"1"`/`"0"`),
`tvName`, and `seedId` (which `config.json` was already used).

## Deep links (Roku Detox -> TV, over ECP)

- App not running: `POST http://<tv>:8060/launch/dev?contentId=...`
- App already in front: `POST http://<tv>:8060/input?contentId=...` (Roku Detox uses this for favorites and
  options, so it never interrupts what's on the TV; if Detox Home isn't open, they wait until it is)

| `contentId` | Other fields | What happens |
| --- | --- | --- |
| `inline` | `mediaType=video`: `url`, `title`, `streamFormat` (`hls`/`mp4`/`dash`/empty), `referer` | Plays the video. Empty `streamFormat`: `.m3u8` -> hls, `.mpd` -> dash, else mp4. A `referer` is sent as a `Referer` header. |
| `inline` | `mediaType=message`: `text`, `from` | Full-screen message. |
| `inline` | `mediaType=notice`: `title`, `text` | Full-screen notice ("Time's up"). |
| `favorites` | `ids=12,837,tvinput.hdmi1` (empty clears them) | Saves the favorites and redraws the home screen. |
| `settings` | `clock24=0\|1`, `simpleMode=0\|1` (either) | Saves and redraws. |

Anything else (or no `contentId`) shows the home screen. OK / Back on a message or notice, Back during a
video, or the video ending all go back to Home. Back on Home exits the app.

## Screens

- **Home**: clock (12-hour unless `clock24`) and date top-left, TV name and a hint about * top-right,
  then Favorites (if any), All apps (everything else, in the TV's order) and Inputs rows (290x218 icons,
  140-high input boxes). Rows scroll up and down. OK opens the app or input; * adds it to favorites or takes it off.
  `simpleMode`: up to 6 favorites, big tiles in 2 rows of 3 (shows the normal rows while there are no favorites).
- If the TV refuses (HTTP 401/403, "Control by mobile apps" set to Limited) the screen says how to change it:
  Settings > System > Advanced system settings > Control by mobile apps > Network access > Default.
- **Message / Notice**: very large text; OK or Back closes.
- **Video**: stock player UI; playback errors show "Couldn't play this video" with the error text.
- **Screensaver**: pick "Detox Clock" in Settings > Theme > Screensaver.
