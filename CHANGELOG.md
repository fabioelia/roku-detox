# Changes

Newest first. The extension's version is in `extension/manifest.json`; after pulling, reload it on
`chrome://extensions`. The program has no version: restart `python3 roku_detox.py`.

## Extension 1.2.0 (November 2026)

### New

- **Pause all rules** for 1 hour, 3 hours or until 7 AM (Rules menu), or say "pause rules" /
  "resume rules". Viewing time still counts, and the rules come back on by themselves.
- **Bedtime on the nights you pick**: Sun to Sat buttons, "School nights" (Sunday to Thursday) and
  "Every night". A night counts from its start time; a start after midnight or in the morning belongs to
  the night before (so "school nights" with 00:30 means early Monday to early Friday).
- **Weekend limits**: a daily time limit can have a different amount on Saturdays and Sundays
  ("60 minutes a day, 120 on weekends"); leave it empty for the same every day.
- **Ask the TV** (Siri, the popup, `tv …` in Chrome's address bar): "what's on", "screen time",
  "time left". The answer is a sentence ("Netflix is on, playing, 12 minutes in, 36 minutes to go.").
- **Share sheet**: with a Shortcuts key, a YouTube or Netflix link sent as `do` plays on the TV, so a
  shortcut in the iPhone share sheet sends those links straight to the TV.
- **Keyboard**: press `?` on the page for every shortcut (and Chrome's, in the extension). Holding an
  arrow key no longer keeps the TV moving after you let go.
- **Screen time** compares the past week with the week before. Activity shows "Today / 2:08 AM".
- **Find a show** keeps recent searches under the box (this browser only), one tap to run again.
- **Household PIN** prompt on the page: with `--household --pin`, other devices are asked for the PIN
  the first time a change needs it.

### Phone layout

- Every menu in view at once (rows of three, two by two on the lite page) instead of a strip that hid
  some off the edge; the footer goes last; pause choices are chips. The page check now opens every menu
  at 320, 390 and 650 px and fails on cut-off buttons or sideways scrolling.

### Security

Seven rounds of independent review; everything they confirmed is fixed:

- Pages on this computer (`http://localhost`, any port) can use the extension only after "Let pages on
  this computer use it" is turned on in its settings (off by default). Neither those pages nor phones on
  the relay can add or search My sites or use Look closer (which reads pages with your sign-ins).
- Links sent from phones, the relay or web pages can't make this computer open addresses on the home
  network or itself: the program checks the address each connection actually reaches (IPv4 only, before
  any TLS hello), every redirect (http and https only), skips yt-dlp for them, and searches sites added
  from a phone with the same checks for good. Through the extension's relay, a phone sends YouTube and
  Netflix links or direct video files; the browser opens no other pages for it.
- TV addresses on the home network must use Roku's port 8060 (other ports only for a pretend TV on
  127.0.0.1, and only from this computer's own pages).
- `#do=` home-screen links never play links and never pause or resume rules (the server refuses it).
- Household PIN: 0 to 9 only; pairing is checked first; five wrong tries lock that device out for 10
  minutes and 20 from all devices lock out the rest (the Mac never); sent only with changes that need
  it; forgotten after an hour without one.
- Household mode: phones can open the `http://<name>.local:8642` address the program prints (the Mac's
  Bonjour name).
- My sites: a search address must be plain `https://host/...` with `{q}` after the host (checked on the text
  the same way in both engines), and sites added from a phone stay marked for good, so they're always
  searched with the checks above. Links or addresses with spaces or control characters get a plain error.

### Fixes

- Bedtime warns again (a full minute) when a pause ends instead of turning the TV off at once; night
  guard starts a fresh idle count; a skip-home under way when rules are paused doesn't relaunch an app
  an hour later.
- Saving rules from the page can't undo or bring back a pause, "15 more minutes" or "skip next time".
- The Remote menu and the popup don't show time-left or bedtime notes while rules are paused.
- The home screen's time never counts as viewing on TVs that give the home screen an app id.
- The extension no longer gets the bedtime night wrong after a clock change.
- The popup plays a pasted link.
- Weekend limits: each check uses one moment for the day and its limit (no stray "time's up" at midnight
  into Monday); the page and popup show today's amounts as the program or extension counts them (its
  clock, not the browser's); turning limits off clears the weekend amounts too.
