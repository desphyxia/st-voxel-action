/**
 * The wire over a WebRTC data channel (#95), and the codes two players pass
 * each other to open one.
 *
 * DECISIONS §7 names Steam Networking as the transport the game ships on. The
 * browser build is the test harness, and a data channel is how it plays between
 * two homes before there is a Steam build: the same three methods as the
 * loopback and the two-window link (src/net/transport.mjs), so the session
 * above it cannot tell them apart.
 *
 * The channel is **unordered and unreliable** — `CHANNEL` below — because
 * that is what the session is written for: a late snapshot is ignored, inputs
 * are queued by sequence and ride the next few messages, and the handshake
 * repeats until it is answered. A reliable channel would buy nothing but
 * head-of-line blocking, which is a stall exactly when the network is worst.
 *
 * **No server.** A connection needs each side's description — its keys and
 * the addresses it can be reached at — to reach the other. The host makes an
 * *invite*, the guest pastes it and makes a *reply*, the host pastes that, and
 * they are connected. A code is the browser's own session description,
 * compressed: rebuilding one from a few fields is shorter, but it is a guess
 * at another browser's format, and this is the part that has to work in
 * browsers this sandbox cannot run.
 *
 * STUN, from public servers, finds each side's address as the internet sees
 * it. There is no TURN relay: two networks that refuse a direct link cannot
 * play in the browser, which is recorded in DECISIONS §7.
 *
 * DOM-free apart from what it is handed: a channel, a peer connection, and
 * CompressionStream where the engine has it (every current browser and node
 * 18+). Nothing here reads the clock the simulation runs on.
 */

/** Where STUN is asked. Two operators, so one being down does not stop play. */
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** The data channel: unordered, no retransmits — see above. */
export const CHANNEL = { ordered: false, maxRetransmits: 0 };

/** Past this much queued in the channel, a message is dropped rather than
    queued behind it: late state is worse than missing state. */
export const MAX_BUFFER = 256 * 1024;

/** How long to wait for addresses before sending the invite with what there is. */
export const GATHER_MS = 4000;

/**
 * A transport over a data channel, or anything shaped like one:
 * `send(string)`, `readyState`, `bufferedAmount`, `close()`, and `message`
 * events carrying `data`.
 */
export function channelTransport(ch) {
  const handlers = [];
  const stat = { sent: 0, skipped: 0, received: 0, bad: 0, bytes: 0 };
  const onData = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch (err) { stat.bad++; return; }
    stat.received++;
    for (const fn of handlers) fn(m);
  };
  if (ch.addEventListener) ch.addEventListener('message', onData);
  else ch.onmessage = onData;
  return {
    stat,
    get open() { return ch.readyState === 'open'; },
    send(msg) {
      if (ch.readyState !== 'open') { stat.skipped++; return; }
      if (ch.bufferedAmount > MAX_BUFFER) { stat.skipped++; return; }
      const s = JSON.stringify(msg);
      stat.sent++; stat.bytes += s.length;
      try { ch.send(s); } catch (err) { stat.skipped++; }
    },
    onMessage(fn) { handlers.push(fn); },
    close() { try { ch.close(); } catch (err) { /* already gone */ } },
  };
}

/* ---------- codes ----------
   `I` or `R` — invite or reply — then the description, deflated and in URL-safe
   base64, so it survives a chat app, an email and a URL fragment alike. A code
   that does not start with one of the two letters is refused, which is what
   catches a reply pasted where an invite goes. */

const CODE_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function b64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += CODE_ABC[(n >> 18) & 63] + CODE_ABC[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += CODE_ABC[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += CODE_ABC[n & 63];
  }
  return out;
}

export function unb64url(s) {
  const out = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = CODE_ABC.indexOf(ch);
    if (v < 0) throw new Error('not a code');
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 255); }
  }
  return new Uint8Array(out);
}

async function codeBytes(bytes, stream) {
  const r = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(r).arrayBuffer());
}

/** An invite (`offer`) or reply (`answer`) description, as a code. */
export async function packCode(desc) {
  const kind = desc.type === 'offer' ? 'I' : desc.type === 'answer' ? 'R' : null;
  if (!kind) throw new Error('not an offer or an answer');
  const raw = new TextEncoder().encode(desc.sdp);
  if (typeof CompressionStream === 'undefined') return kind + '0' + b64url(raw);
  return kind + 'Z' + b64url(await codeBytes(raw, new CompressionStream('deflate-raw')));
}

/**
 * A code back into a description. Forgiving about what a person pastes —
 * spaces, line breaks, a whole link with the code after `#join=` — and strict
 * about what it is: `want` is `'offer'` or `'answer'`, and the other kind is
 * refused with a message that says which was pasted.
 */
export async function unpackCode(text, want) {
  let s = String(text || '').trim();
  const at = s.indexOf('#join=');
  if (at >= 0) s = s.slice(at + 6);
  s = s.replace(/\s+/g, '');
  const kind = s[0], enc = s[1], body = s.slice(2);
  const type = kind === 'I' ? 'offer' : kind === 'R' ? 'answer' : null;
  if (!type || (enc !== 'Z' && enc !== '0') || !body) throw new Error('that is not a code from this game');
  if (want && type !== want) {
    throw new Error(type === 'answer' ? 'that is a reply — it goes to the host, who made the invite'
                                      : 'that is an invite — the host needs the reply made from it');
  }
  const damaged = 'that code is damaged — copy it again, all of it';
  let sdp;
  try {
    const bytes = unb64url(body);
    const raw = enc === 'Z' ? await codeBytes(bytes, new DecompressionStream('deflate-raw')) : bytes;
    sdp = new TextDecoder().decode(raw);
  } catch (err) { throw new Error(damaged); }
  if (sdp.indexOf('v=0') !== 0 || sdp.indexOf('a=fingerprint:') < 0) throw new Error(damaged);
  return { type, sdp };
}

/**
 * Resolves once `pc` has found its addresses, or after `ms` with whatever it
 * has. A description is only worth sending with its candidates in it, since
 * there is no server to trickle the rest through; and a STUN server that never
 * answers must not keep the invite from being made at all.
 */
export function gathered(pc, ms, later) {
  const wait = later || setTimeout;
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(true); return; }
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') finish(true);
    });
    wait(() => finish(false), ms === undefined ? GATHER_MS : ms);
  });
}

/** What kinds of address a description offers — for the player, when it fails. */
export function candidateKinds(sdp) {
  const kinds = {};
  for (const line of String(sdp).split(/\r?\n/)) {
    const m = /^a=candidate:.* typ (\w+)/.exec(line);
    if (m) kinds[m[1]] = (kinds[m[1]] || 0) + 1;
  }
  return kinds;
}
