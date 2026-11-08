# Roku Detox

Find a Roku TV on your Wi-Fi and clean it up from a web page on your computer.

The page has five menus:

- **Remote**: open any app or input, favorites, scenes, the on-screen remote (arrow buttons or a
  swipe pad), voice search on secure pages, and a sleep timer (15 minutes to 1½ hours) that turns the
  TV off even after you close the page, while this program or the extension is running.
- **Find a show**: search any show or movie, see which of your apps has it, and start it on the TV.
  Listings come from JustWatch's public catalog (unofficial, so it may change). Roku can see which apps
  are installed but not which ones you pay for, so you can untick services under "My services".
  **My sites** searches video sites you add (paste any results page address, like
  `https://www.youtube.com/results?search_query=cats`). Results are read from the page's links and from
  the data many sites tuck inside the page (YouTube, schema.org, Next.js), so no scripts or ads load.
  For sites that only show results after their scripts run, the extension's **Look closer** opens the
  page in a hidden, muted tab for a few seconds, reads it and closes it, and remembers to do that for the site.
  YouTube results open in the YouTube app; other videos play in Detox Home.
- **Rules**: things that run in the background while the program is open on your Mac:
  skip the home screen when the TV turns on, bedtime, daily time limits, blocked apps, swap apps,
  night guard (turns the TV back off when it wakes itself up at night), and a viewing log.
  It checks the TV every 4 seconds and keeps the Mac from sleeping (`caffeinate`) while any rule is on.
  Alerts show as macOS notifications. Includes a connection check with plain-language fixes.
- **Clean up**: remove channels, finish-up checklist, undo list.
- **TV app**: install **Detox Home**, a custom Roku app (in `roku-app/`): a calm home screen with a clock
  and your apps and favorites, rule notices ("Time's up"), messages you send from the Mac or phone, videos from
  web links, and an ad-free "Detox Clock" screensaver. Needs Roku developer mode (Home x3, Up x2,
  Right, Left, Right, Left, Right on the remote); you type the developer password on the page, and it's
  sent only to the TV and never saved. Once installed it runs on its own: it reads the apps from the TV
  itself and opens them through the TV's own remote-control service, so it never connects to the Mac.
  Press * on the remote on a tile to add or remove a favorite; favorites and options chosen on the page
  are sent to it while it's open.
- **Phone**: use your phone as the remote. With the phone remote on, "Set up a shortcut" makes a key
  for Apple's Shortcuts app (or anything that can send a web request): POST `{"do": "pause"}` to
  `http://<this Mac>:8642/api/do` with the header `X-Detox-Key`. Phrases: pause, home, back, louder,
  quieter, mute, on, off, volume up 5, open Netflix, HDMI 2, one of your scene names, sleep 30,
  cancel sleep, search The Bear; anything else searches the TV. The answer is a sentence Siri can read out.

**Send a video link to the TV**: paste a link into the box under the remote, or use the "Send to TV"
bookmark from the TV app menu. YouTube and Netflix links open in their own apps. For other pages the Mac
looks for the video file (direct links, `<video>` tags, page metadata) and plays it in Detox Home. If
[yt-dlp](https://github.com/yt-dlp/yt-dlp) is installed it's used for sites the built-in finder can't read.
Videos locked by DRM (Netflix, Disney+ and most paid services) can't be sent this way.

- Finds Roku TVs on the network automatically, or connect by IP address.
- Shows every channel with its icon, labeled: free-with-ads, made by Roku, or part of the TV (inputs).
- Removes the channels you pick, one at a time. The page opens each channel's store page on the TV,
  you confirm "Remove channel" with the on-screen remote (or your real one), and the page checks it's gone.
- Keeps an undo list (`undo-list.json`). "Add back" reopens the store page so you can re-add a channel.
- On-screen remote, with keyboard shortcuts.
- Shortcuts: one-tap buttons for your favorite apps and every HDMI input, plus scenes
  (several steps in a row, like "turn on, switch to the Nintendo Switch, volume down 5").
  A scene can also run every day at a set time, while this program is running.
- Now playing: which app is on, playing or paused, and how far in.
- One box for searching across all apps (opens Roku's search screen and types for you), pasting a
  YouTube or Netflix link to play it on the TV, or typing into a sign-in field on the TV.
- Phone remote: open the page on your phone over home Wi-Fi. A phone needs a one-time
  6-digit code from the Mac page. Shortcuts, scenes, rules and paired phones are kept in `remote-settings.json`;
  rule activity in `activity-log.json` and the viewing log in `viewing-log.json`.
- A finish-up checklist for the settings Roku only lets you change on the TV itself,
  plus a Restart button that waits for the TV to come back and confirms it started normally.

Not made by Roku. Nothing here touches Roku's system software: removed channels can always be
added back from the Streaming Store.

## Run it

Needs Python 3 (already on most Macs). No installs.

```bash
python3 roku_detox.py
```

Your browser opens http://127.0.0.1:8642. Keep the terminal window open while you use it.

The first time, macOS may ask whether Terminal can find devices on your local network. Choose
Allow, or the page won't be able to reach the TV.

## Ways to run it

The same page works three ways (see `ENGINE.md` for the details):

- **On a phone or any browser, as a plain link** ("lite"): sends commands straight to the TV, which covers
  remote buttons, your apps, inputs, scenes and starting episodes. It can't read the TV, so rules and Find a show need one of the others.
- **With the browser extension** (`extension/`, load it in Chrome): everything, inside the browser.
  Rules run while the browser is open. It also offers "Send to TV" for videos you play and blocks ads while you browse.
- **With this program on an always-on computer**: everything, all the time, for the whole household.
  - Raspberry Pi or Linux: `sudo sh deploy/install-pi.sh`
  - NAS or any Docker host: `docker compose -f deploy/docker-compose.yml up -d`
  - This Mac at login: `sh deploy/install-mac.sh` (undo with `sh deploy/install-mac.sh remove`)

  With `--household`, anyone on your Wi-Fi can open `http://<computer name>.local:8642` with no pairing.
  Add `--pin 1234` so changing rules, the TV app or sites from other devices needs that PIN. Use `--data FOLDER`
  to keep settings and logs somewhere else.

To install Detox Home from a browser without this program: `python3 roku_detox.py --export-tv-app detox-home.zip`,
then open `http://<TV address>` (developer mode on) and upload the zip.

## Let the page use your TV

Roku TVs block other devices by default. On the TV:
Settings > System > Advanced system settings > Control by mobile apps > Network access > **Default**
(some versions say **Enabled**).

While that's on, any device on your Wi-Fi can control the TV. When you're done, set it back to
**Limited**. It's the last step on the page's checklist.

## What it can't do

Roku doesn't allow these from another device, so the page walks you through them instead:
privacy and ad-tracking settings, the home screen, sleep timer, and screensaver. Roku also doesn't
report free memory and has no animation setting.

## Try it without a TV

`mock_roku.py` is a pretend Roku for testing:

```bash
python3 mock_roku.py
```

Then enter `127.0.0.1:9060` as the TV address. Add `--limited` to see what a locked-down TV looks like.
