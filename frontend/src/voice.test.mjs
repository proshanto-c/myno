/**
 * Does the microphone actually let go?
 *
 *   docker run --rm -v "$PWD":/w -w /w node:20-alpine node voice.test.mjs
 *
 * Every browser API is faked, so each test can stop the controller at an exact
 * point in the startup sequence — including while the permission prompt is
 * still open, which is where the real leak was.
 */
import { VoiceController } from "./voice.js";

const T = [];
const test = (name, fn) => T.push([name, fn]);
const eq = (got, want, msg = "") => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${msg}expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};

// ---- fakes ----------------------------------------------------------------
const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

class FakeSocket {
  static made = [];
  constructor(url) {
    this.url = url; this.readyState = CONNECTING; this.sent = []; this.closed = false;
    FakeSocket.made.push(this);
  }
  send(data) {
    if (this.readyState !== OPEN) throw new Error("not open");
    this.sent.push(data);
  }
  close() { this.closed = true; this.readyState = CLOSED; this.onclose?.(); }
  open() { this.readyState = OPEN; this.onopen?.(); }          // the server accepted
  serverClose() { this.readyState = CLOSED; this.onclose?.(); }
}

const fakeTrack = () => ({ stopped: false, stop() { this.stopped = true; } });
const fakeStream = () => { const t = [fakeTrack(), fakeTrack()]; return { tracks: t, getTracks: () => t }; };

class FakeCtx {
  constructor() { this.sampleRate = 48000; this.closed = false; this.nodes = []; }
  createMediaStreamSource() { return { connect: () => {} }; }
  createScriptProcessor() {
    const node = { onaudioprocess: null, disconnected: false,
                   connect: () => {}, disconnect() { this.disconnected = true; } };
    this.nodes.push(node);
    return node;
  }
  close() { this.closed = true; return Promise.resolve(); }
}

function harness({ micDelay = 0, micFails = false } = {}) {
  FakeSocket.made = [];
  const state = [], errors = [], timers = [];
  let ctx = null, stream = null, release = null;
  const mic = new Promise((res, rej) => { release = { res, rej }; });
  const deps = {
    WebSocket: FakeSocket,
    getUserMedia: () => {
      if (micFails) return Promise.reject(new Error("denied"));
      if (micDelay === "manual") return mic;
      stream = fakeStream();
      return Promise.resolve(stream);
    },
    AudioContext: function () { ctx = new FakeCtx(); return ctx; },
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  };
  const c = new VoiceController({
    endpoint: "wss://asr.test/stream", deps,
    onState: (v) => state.push(v), onError: (e) => errors.push(e),
  });
  return {
    c, state, errors, timers,
    socket: () => FakeSocket.made[FakeSocket.made.length - 1],
    sockets: () => FakeSocket.made,
    ctx: () => ctx,
    stream: () => stream,
    grantMic: () => { stream = fakeStream(); release.res(stream); return stream; },
    runTimers: () => timers.filter((t) => !t.cleared).forEach((t) => t.fn()),
  };
}

const settle = () => new Promise((r) => setImmediate(r));

// ---- the leak -------------------------------------------------------------
test("stopping while the permission prompt is open opens nothing", async () => {
  const h = harness({ micDelay: "manual" });
  h.c.start();
  h.c.stop();                       // pressed again before granting
  const late = h.grantMic();        // the prompt resolves afterwards
  await settle();
  eq(h.sockets().length, 0, "no socket: ");
  eq(late.tracks.every((t) => t.stopped), true, "microphone released: ");
});

test("stopping mid-handshake closes the socket", async () => {
  const h = harness();
  h.c.start();
  await settle();
  eq(h.socket().readyState, CONNECTING);
  h.c.stop();
  eq(h.socket().closed, true, "closed: ");
  eq(h.socket().readyState, CLOSED);
});

test("a socket that opens after a stop is closed at once", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.c.stop();
  h.socket().readyState = OPEN;     // server accepts after we gave up
  h.socket().onopen?.();
  eq(h.socket().closed, true);
  eq(h.state.includes(true), false, "never announced listening: ");
});

// ---- the ordinary path ----------------------------------------------------
test("stopping an open session flushes, then closes", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.socket().open();
  eq(h.state, [true]);
  h.c.stop();
  eq(h.socket().sent, ['{"type":"end"}'], "sent the end marker: ");
  eq(h.socket().closed, false, "not closed until the flush timer: ");
  h.runTimers();
  eq(h.socket().closed, true, "closed after it: ");
});

test("everything the session opened is released", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.socket().open();
  const stream = h.stream(), ctx = h.ctx();
  h.c.stop();
  eq(stream.tracks.every((t) => t.stopped), true, "microphone: ");
  eq(ctx.closed, true, "audio context: ");
  eq(ctx.nodes[0].disconnected, true, "processor disconnected: ");
  eq(ctx.nodes[0].onaudioprocess, null, "and its handler dropped: ");
  eq(h.state, [true, false], "listening turned off: ");
});

test("listening only goes false once, however many times you stop", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.socket().open();
  h.c.stop(); h.c.stop(); h.c.stop();
  eq(h.state, [true, false]);
  eq(h.sockets().length, 1);
});

test("audio stops being sent the moment stop is called", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.socket().open();
  const node = h.ctx().nodes[0];
  const frame = { inputBuffer: { getChannelData: () => new Float32Array(4096) } };
  node.onaudioprocess(frame);
  eq(h.socket().sent.length, 1, "sending while open: ");
  const handler = node.onaudioprocess;
  h.c.stop();
  handler(frame);                    // a frame already in flight
  eq(h.socket().sent.length, 2, "only the end marker followed: ");
  eq(h.socket().sent[1], '{"type":"end"}');
});

// ---- closed from the other end -------------------------------------------
test("the server hanging up turns listening off and releases the microphone", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.socket().open();
  const stream = h.stream(), ctx = h.ctx();
  h.socket().serverClose();
  eq(h.state, [true, false]);
  eq(stream.tracks.every((t) => t.stopped), true, "microphone: ");
  eq(ctx.closed, true, "audio context: ");
});

test("stopping after the server hung up does nothing further", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.socket().open();
  h.socket().serverClose();
  h.c.stop();
  eq(h.state, [true, false]);
});

// ---- restarting -----------------------------------------------------------
test("starting again opens exactly one new socket", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.socket().open();
  h.c.stop();
  h.runTimers();
  h.c.start();
  await settle();
  eq(h.sockets().length, 2);
  eq(h.sockets()[0].closed, true, "the first is closed: ");
  eq(h.sockets()[1].readyState, CONNECTING);
});

test("a refused microphone leaves nothing open and says so", async () => {
  const h = harness({ micFails: true });
  h.c.start();
  await settle();
  eq(h.sockets().length, 0);
  eq(h.state, [false]);
  eq(h.errors.length, 1);
});

test("the flush timer is never left behind", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.socket().open();
  h.c.stop();
  h.c.stop();                        // a second stop must not queue another
  eq(h.timers.filter((t) => !t.cleared).length, 1);
});

// ---- run it ---------------------------------------------------------------
let passed = 0, failed = 0;
for (const [name, fn] of T) {
  try { await fn(); passed++; }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
