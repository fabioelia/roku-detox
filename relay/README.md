# Roku Detox relay

Lets a phone with nothing installed use the household computer's **Roku Detox extension** to control
the TV, from anywhere with internet, not just the home Wi-Fi.

The extension keeps one connection open to a small cloud relay. The phone opens a link the extension
made (`https://<relay host>/#k=<household key>`). Every button press is locked on the phone, passed
through the relay, unlocked by the extension, run against the TV, and the answer comes back locked
the same way. The relay only passes sealed envelopes between the two; it can't open them.

```
phone page ──POST /room/<roomId>/request──▶ relay (Worker + Durable Object) ──WebSocket──▶ extension ──▶ TV
           ◀─────────── {id, iv, ct} ────────                                ◀── {id, iv, ct} ──
```

## Privacy model

- **The household key never leaves the phone and the computer.** It's in the link's `#fragment`,
  which browsers never send to any server. The extension makes it (32 random bytes).
- **What the relay sees:** the room id (a one-way hash of the key: `base64url(SHA-256(key))`, first
  22 characters), how big each message is, when messages are sent, and, like any web server, the
  IP addresses of the phone and the computer.
- **What it never sees:** which buttons were pressed, which apps or shows, the TV's address, settings,
  rules, or anything the TV sends back. Every body is AES-256-GCM encrypted with a key derived from the
  household key (HKDF-SHA-256, info `roku-detox-relay-v1`), a random 12-byte IV, and the room id as
  additional data.
- **The relay can't fake or replay anything.** Each sealed message carries its request id, its direction
  and a timestamp. The phone rejects answers that were changed, swapped between requests or sent the wrong
  way; the extension rejects requests that were changed, and runs each request at most once (a copy sent
  again within the 5-minute window is ignored; older ones are refused).
- **Someone who learns the room id but not the key** can't read or send commands. At most they can send
  junk (rate limited, and the extension refuses it) or pretend to be the computer (the phone rejects
  their answers).
- **Someone who has the link has the remote.** If a phone is lost, make a new link in the extension:
  a new key means a new room, and old links stop working.
- **Nothing is stored.** No database, no logs written by the relay. A room is just the computer's open
  connection; a room nobody has used in 30 days is simply empty. (If Cloudflare's optional Workers Logs
  are turned on, they record request URLs, so room ids and status codes, never message contents.)
- Phones may only send `api`, `ping` and `icon` messages (the same ones the page sends the extension
  locally); anything else is refused by the extension.

## API

All bodies are JSON. `roomId` is exactly 22 base64url characters.

| Route | Who | What |
|---|---|---|
| `GET /room/<roomId>/host` (WebSocket upgrade) | extension | Receives request frames `{id, iv, ct}` as text messages and sends reply frames `{id, iv, ct}` back. Sends `"ping"` every 20 s, gets `"pong"` (answered by Cloudflare without waking the room). If it can't open a request it sends `{id, error: "unreadable"}`. Newest connection gets the requests; at most 4 computers per room. |
| `POST /room/<roomId>/request` | phone | Body `{id, iv, ct}` (≤ 64 KB, any content type; the client sends `text/plain` so there is no CORS preflight). Waits up to 15 s for the computer's reply. |
| `OPTIONS /room/<roomId>/request` | browsers | CORS preflight: any origin. |
| `GET /` | anyone | The phone page if static assets are configured, otherwise `{ok: true, service: "roku-detox-relay"}`. |

`/request` answers:

| Status | Body |
|---|---|
| 200 | the computer's reply frame `{id, iv, ct}` |
| 400 | `{error}`: not JSON, or not a frame |
| 409 | `{error}`: a request with that id is already waiting |
| 413 | `{error}`: body over 64 KB |
| 429 | `{error, retryAfter}` + `Retry-After` header: over the per-minute limit (30 per room by default, `RATE_LIMIT_PER_MINUTE` in `wrangler.toml`) |
| 502 | `{error}`: the computer couldn't open the request (wrong key or changed on the way) |
| 503 | `{error: "The computer with Roku Detox isn't online."}`, or it went offline before answering |
| 504 | `{error: "The computer with Roku Detox didn't answer in time."}` |

Frame fields: `id` = 16 to 64 base64url characters (the client uses 16 random bytes), `iv` = 12 bytes
base64url (16 characters), `ct` = AES-GCM ciphertext + tag, base64url. Replies use the request's `id`
and may be up to 1 MB. Inside the encryption (only the two ends see it):
`{v: 1, id, kind: "req" | "res", ts, body}`, where `body` is an ENGINE.md message:
`{type: "api", method, path, query, body}` → `{status, data}`, `{type: "ping"}` → `{ok, version, engine}`,
`{type: "icon", tv, id}` → `{dataUrl}`. Calls made within a few milliseconds of each other are sent as one
`{type: "batch", messages: [...]}` request and answered as `{type: "batch", results: [...]}`;
`RelayHost` unpacks these itself, so the extension's handler never sees them.

## Files

- `src/worker.js`: the Worker (routing, CORS, size checks) and the `Room` Durable Object (WebSocket
  hibernation API, pending requests with timeouts).
- `src/relay-core.js`: the relay logic with no Cloudflare APIs (frame checks, rate limit, matching
  replies to requests), so it can be tested in Node.
- `client/relay-crypto.js`: key, room id, encrypt/decrypt and phone-link helpers. WebCrypto only; used by
  the page and the extension.
- `client/relay-client.js`: `RelayEngine` (page) and `RelayHost` (extension).
- `test/`: `node --test relay/test/` (from the project folder) or `npm test` here. No installs needed.

## Using it from the page (index.html)

The page has to be on `https://` (WebCrypto needs a secure page). Simplest: the relay serves it (see the
commented `[assets]` block in `wrangler.toml`), so the phone link opens the page directly.

```js
const { RelayEngine } = await import("./relay/relay-client.js");
const relay = RelayEngine.fromLocation();    // null unless the URL has #k=<key>
if (relay) {
  // Engine choice: a #k= in the URL means "relay", checked before falling back to lite.
  // Optional: keep the key and tidy the address bar so it isn't shared by accident.
  localStorage.setItem("detox.relayKey", relay.key);
  history.replaceState(null, "", location.pathname + location.search);
}
// Later: new RelayEngine({ key: localStorage.getItem("detox.relayKey") }) (relay defaults to location.origin).

await relay.api(`/api/apps?tv=${enc(tv)}`);  // same contract as api(): GET when body is undefined
await relay.api("/api/key", { tv, key: "Home" });
// Errors: Error with .status, .blocked, .needs, .pair (like api()), plus .offline (503: computer not
// online, or the phone has no internet) and .retryAfter (429).
await relay.ping();                           // {ok, version, engine} from the extension
const src = await relay.icon(tv, appId);      // "data:image/...;base64,..." or null (cached)
```

The relay allows 30 requests per minute per household by default. Calls made together are batched into
one request, but the page currently polls `/api/now` and `/api/phone` every 5 s; in relay mode it should
poll every 15 s or more (or only while visible), or the limit should be raised in `wrangler.toml`.

## Using it from the extension (service worker)

```js
import { RelayHost } from "./relay/relay-client.js";
import { newHouseholdKey } from "./relay/relay-crypto.js";

const RELAY = "roku-detox-relay.<account>.workers.dev";
let host = null;

function startRelay() {             // safe to call often
  if (host) return host.start();
  chrome.storage.local.get("relayKey").then(({ relayKey }) => {
    const key = relayKey || newHouseholdKey();
    if (!relayKey) chrome.storage.local.set({ relayKey: key });
    host = new RelayHost({
      relay: RELAY,
      key,
      handle: (msg) => routeMessage(msg),     // the same router chrome.runtime.onMessage uses
      onStatus: (status) => { /* "connecting" | "online" | "offline" | "stopped": show in the popup */ },
    });
    host.start();
  });
}
startRelay();                                    // top level: runs every time the service worker wakes
chrome.alarms.onAlarm.addListener(startRelay);   // e.g. the existing 30 s rules alarm
// Phone link / QR for the options page: host.link() → https://<relay>/#k=<key>
// New link (cut off old phones): host.stop(); save newHouseholdKey(); create a new RelayHost.
```

Chrome keeps an MV3 service worker alive while its WebSocket is active, which the 20 s ping takes care
of. If the worker is stopped anyway (browser closed, computer asleep), phones get the "isn't online" message
until it's back. Service workers can't use top-level `await`, hence the `.then()` above.

## Deploying (later, by the owner)

Not deployed, and no account was created. Whoever runs it needs their own free Cloudflare account and
must decide to do it:

```sh
cd relay
npx wrangler login     # opens Cloudflare in the browser
npx wrangler deploy    # prints the relay address, e.g. roku-detox-relay.<account>.workers.dev
```

Then put that address in the extension (`RELAY` above). Free plan limits are far above one household's use.
