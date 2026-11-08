# Roku Detox for Chrome

The whole Roku Detox page, running inside Chrome, with no program at home. The extension
answers the same requests the Roku Detox program (`roku_detox.py`) answers, so the page
works the same way: remote, apps and inputs, Find a show, rules, clean up, and sending
videos to the TV. See `../ENGINE.md` for how the page and the extension talk.

## Load it

1. From the `roku-detox` folder, make the page copy (do this again whenever `index.html` changes):
   `python3 tools/build_extension.py`
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this `extension` folder.
5. Pin Roku Detox to the toolbar (the puzzle-piece menu). Click it, then **Open Roku Detox**.

The page opens in Chrome's side panel (or in a tab, from the settings page). Type your TV's
address once, or press Find TVs.

## What it does

- **Everything on the page**: the extension talks to the TV on your Wi-Fi (Roku's port 8060),
  reads the show catalog from JustWatch, and keeps your shortcuts, scenes, rules, watch
  history, sites and undo list in Chrome's storage on this computer.
- **Find TVs**: browsers can't use the network "who's there?" call, so the extension finds which
  home range this computer is on and asks each address in it, 16 at a time. TVs it found before are
  tried first, and typing the TV's address (on the TV: Settings, Network, About) is instant. If this
  computer blocks Chrome from the home network (the Mac's Local Network setting, security software),
  it says so instead of searching.
- **Rules** (bedtime, limits, blocked apps, swaps, skip the home screen, night guard, viewing log)
  run while Chrome is open. Chrome wakes the extension every 30 seconds, and it then checks the
  TV every 5 seconds for about 25 seconds. Alerts show as Chrome notifications.
- **Send to TV** (toolbar button): while a video plays in a tab, the extension notes the video
  file the page loads (HLS, DASH, MP4). The button sends the best one to the TV, with the page as
  its referrer. YouTube and Netflix links open in their own apps. Pasting a link on the page works
  too: it uses what the tab played, or reads the page like the Mac does.
- **Right-click menu**: on a video, "Play this video on the TV"; on a link, "Send this link to
  the TV"; on a page, "Send this page's video to the TV"; on selected text, "Search the TV for …".
- **`tv` in the address bar**: type `tv`, a space, then a show (`tv the bear` opens Find a show),
  an app (`tv netflix` opens it on the TV), one of your scenes (`tv game time`), a button
  (`tv pause`, `tv home`, `tv louder`, `tv off`), or a link to send.
- **Toolbar popup**: send this tab's video, a small remote (also arrow keys, Enter and Backspace
  while it's open), what's on the TV, and your favorites and scenes as one-tap buttons.
- **Keyboard shortcuts**, from any tab: play/pause (Control+Shift+P on a Mac, Alt+Shift+P
  elsewhere), send this tab's video (…+S), volume up and down (…+. and …+,), plus mute, home and back
  with no key set. Change them at `chrome://extensions/shortcuts`, where you can also make them work
  when Chrome isn't in front.
- **Ads**: the same ad and tracker hosts the program skips are blocked in every tab
  (`rules/ads.json`, two rules). Pages themselves are never blocked.

### Detox Home (the TV app)

Videos, messages and rule notices open in Detox Home. It runs on its own on the TV (it reads the
TV's apps itself), so each item travels inside the launch link
(`launch/dev?contentId=inline&mediaType=video&url=…&title=…`). Favorites saved on the page and the
TV app options go to it as `contentId=favorites` / `contentId=settings` input events while it's open,
or wait until the extension next sees it open. The extension can't install Detox Home itself: with
developer mode on, open `http://<your TV's address>` in the browser and upload the Detox Home zip there.

### Needs the program at home

These answer with a plain-English explanation (status 501, `needs: "home"`):

- the phone remote and pairing (`/api/phone`, `/api/pair`), and sharing the page with the
  household (`/api/household`)
- installing or removing Detox Home (`/api/tvapp/install`, `/api/tvapp/remove`): use the TV's own
  installer page instead

Rules stop when Chrome is closed. The Mac program keeps them running all the time.

## Use it from a web page

The page can also run from `http://localhost` or `http://127.0.0.1` (any port) and use this
extension instead of the program. Only those addresses can talk to it (`externally_connectable`).
The page has to know the extension's id: the settings page (right-click the toolbar button,
Options) shows it, with the one line to paste into that page's browser console. Published copies
of the page have the id built into `<meta name="roku-detox-extension">`;
`python3 tools/build_extension.py --id <id>` fills it into the extension's own copy.

## Permissions, in plain words

| Permission | Why |
|---|---|
| Access to `http://*/*` and `https://*/*` | To reach your TV on your home network, JustWatch's catalog, and the pages you ask it to find a video on. TV addresses must be private home addresses. |
| `storage` | Keeps your settings, rules, watch history and undo list on this computer. |
| `alarms` | Wakes the extension every 30 seconds so rules can check the TV. |
| `notifications` | Shows rule alerts, like "the TV turned itself on at night". |
| `webRequest` | Notices which video files your tabs load, so Send to TV knows what's playing. It sees addresses and file types only, never page content, and keeps the last 20 per tab until the tab closes. |
| `declarativeNetRequest` | Blocks the ad hosts, drops the browser's `Origin` header on the extension's own requests to the TV (newer Roku software refuses those otherwise), and adds a `Referer` when it reads an embedded video player. |
| `tabs` | Reads the current tab's address and title for Send to TV. With "Look closer" in My sites, opens a site's results page in a hidden, muted tab for a few seconds. |
| `scripting` | Reads that hidden tab's results, then it's closed. |
| `contextMenus` | The "Send to TV" items in the right-click menu. |
| `sidePanel` | Opens Roku Detox in Chrome's side panel. |

Nothing is sent anywhere except to your TV, to JustWatch (your search words and the TV's
country), and to the sites you ask it to read.

## Files

- `manifest.json`, `sw.js` (service worker: message router and listeners)
- `engine/`: `router.js` (the `/api/...` routes), `ecp.js` (TV), `catalog.js` (JustWatch, history),
  `video.js` (video finder, sniffer, My sites), `store.js` (saved data), `discover.js`, `rules.js`,
  `util.js`
- `popup.html/js` (toolbar), `options.html/js` (settings), `ui.css`
- `rules/ads.json`, `icons/` (drawn by `tools/make_icons.py`)
- `app/`: made by `../tools/build_extension.py` from `../index.html`. Extension pages can only run
  script files, so the page's inline script becomes `app/page-1.js`; remote scripts are left out.
  Don't edit `app/` by hand.

## Tests

Start the pretend TV, then run Node's built-in test runner (no installs):

```bash
python3 mock_roku.py --port 9072 &        # from the roku-detox folder
cd extension && node --test --test-concurrency=1 tests/*.test.js
```

The tests compare the ported functions with `roku_detox.py` (through `tests/py_oracle.py`), drive
the pretend TV through the same messages the page sends, play out each rule with a fake clock,
and check Find a show against JustWatch and the video finder against a public page (both need the
internet). A fake `chrome` object (`tests/fake-chrome.js`) stands in for the browser.

To check the extension in a real Chrome (a fresh headless profile with the extension loaded, a
pretend TV, the page, popup and options page, failing on any page error):

```bash
node tools/extension-smoke.mjs     # from the roku-detox folder
```
