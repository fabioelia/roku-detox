// Install or update Detox Home from the extension, like send_to_installer() in roku_detox.py: Roku's developer
// web installer on the TV (developer mode on) takes the app as a form upload, signed in as "rokudev" with HTTP
// digest authentication. The password is used for this one request and never kept.

import { TVError, ValueError } from "./util.js";

// --- MD5 (digest authentication needs it; Web Crypto doesn't have it) -----------------------------------

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** MD5 of a string (as UTF-8), as 32 hex digits. */
export function md5(text) {
  const bytes = new TextEncoder().encode(text);
  const length = ((bytes.length + 8) >>> 6 << 6) + 64;
  const data = new Uint8Array(length);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(data.buffer);
  view.setUint32(length - 8, bits >>> 0, true);
  view.setUint32(length - 4, Math.floor(bits / 2 ** 32), true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let chunk = 0; chunk < length; chunk += 64) {
    const m = Array.from({ length: 16 }, (_, i) => view.getUint32(chunk + i * 4, true));
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const next = d;
      d = c;
      c = b;
      const sum = (a + f + K[i] + m[g]) >>> 0;
      b = (b + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
      a = next;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((word) => Array.from({ length: 4 }, (_, i) => ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

/** The Authorization header answering a Digest challenge (RFC 2617, qop=auth, like urllib's handler). */
export function digestHeader(challenge, method, uri, user, password, cnonce = randomHex(8)) {
  const fields = Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));
  const realm = fields.realm || "";
  const nonce = fields.nonce || "";
  const qop = (fields.qop || "").split(",").map((q) => q.trim()).includes("auth") ? "auth" : "";
  const nc = "00000001";
  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  let header = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (fields.opaque) header += `, opaque="${fields.opaque}"`;
  if (fields.algorithm) header += `, algorithm=${fields.algorithm}`;
  return header;
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The installer's address on the TV (port 80; a pretend TV on this computer answers on its own port). */
export function installerUrl(target) {
  return `http://${target.host}:${target.port === 8060 ? 80 : target.port}/plugin_install`;
}

function formBody(boundary, action, packageBytes) {
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="mysubmit"\r\n\r\n${action}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="archive"; filename="detox-home.zip"\r\nContent-Type: application/zip\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return new Blob([head, packageBytes || new Uint8Array(0), tail]);
}

/**
 * Send Detox Home to the TV's installer (packageBytes), or remove it (null). Same messages as send_to_installer.
 */
export async function sendToInstaller(target, password, packageBytes) {
  if (!password || password.length > 200) throw new ValueError("Type the developer password you chose on the TV.");
  const url = installerUrl(target);
  const uri = new URL(url).pathname;
  const boundary = randomHex(16);
  const action = packageBytes ? "Install" : "Delete";
  const post = (headers) => fetch(url, {
    method: "POST", body: formBody(boundary, action, packageBytes), credentials: "omit", cache: "no-store",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, ...headers },
    signal: AbortSignal.timeout(90000),
  });
  let resp;
  try {
    resp = await post({});
    if (resp.status === 401) {
      const challenge = resp.headers.get("WWW-Authenticate") || "";
      if (!/^Digest/i.test(challenge)) throw new TVError("The TV's installer asked for a kind of sign-in this can't do.");
      resp = await post({ Authorization: digestHeader(challenge, "POST", uri, "rokudev", password) });
    }
  } catch (err) {
    if (err instanceof TVError) throw err;
    throw new ValueError("Developer mode isn't on yet, so the TV has no installer to talk to. See the steps above.");
  }
  if (resp.status === 401) throw new ValueError("The TV didn't accept that password. It's the one you chose when you turned on developer mode.");
  if (!resp.ok) throw new TVError(`The TV's installer refused (error ${resp.status}).`);
  const page = await resp.text();
  const failure = /(Install Failure[^"<\\]*|Delete Failure[^"<\\]*)/.exec(page);
  if (failure) throw new TVError(`The TV said: ${failure[1].trim()}`);
  if (!/Install Success|Identical to previous version|Delete Successful|Application Received/i.test(page)) {
    throw new TVError("The TV's installer answered, but didn't say the install worked.");
  }
}

/** Detox Home as built into this extension (app/detox-home.zip). */
export async function detoxHomePackage() {
  let resp = null;
  try { resp = await fetch(globalThis.chrome.runtime.getURL("app/detox-home.zip")); } catch { /* below */ }
  if (!resp || !resp.ok) throw new TVError("Detox Home isn't in this copy of the extension. Run tools/build_extension.py.");
  return new Uint8Array(await resp.arrayBuffer());
}
