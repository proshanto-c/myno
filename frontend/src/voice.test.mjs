/**
 * Does the microphone actually let go?
 *
 *   docker run --rm -v "$PWD":/w -w /w node:20-alpine node voice.test.mjs
 *
 * Every browser API is faked, so each test can stop the controller at an exact
 * point in the startup sequence — including while the permission prompt is
 * still open, which is where the real leak was.
 */
import { VoiceController, mergeSpeech } from "./voice.js";

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
  constructor() {
    this.sampleRate = 48000; this.closed = false; this.nodes = [];
    this.currentTime = 0; this.destination = {}; this.played = [];
  }
  resume() {}
  createBuffer(_ch, frames, rate) {
    return { duration: frames / rate, getChannelData: () => new Float32Array(frames) };
  }
  createBufferSource() {
    const src = { buffer: null, onended: null, connect: () => {},
                  start: (at) => { this.played.push(at); }, stop: () => {}, disconnect: () => {} };
    return src;
  }
  createMediaStreamSource() { return { connect: () => {} }; }
  createScriptProcessor() {
    const node = { onaudioprocess: null, disconnected: false,
                   connect: () => {}, disconnect() { this.disconnected = true; } };
    this.nodes.push(node);
    return node;
  }
  close() { this.closed = true; return Promise.resolve(); }
}

function harness({ micDelay = 0, micFails = false, silenceMs, conversation = false } = {}) {
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
    endpoint: "wss://asr.test/stream", deps, silenceMs, conversation,
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
    // One clock at a time: the pause that ends an utterance and the watchdog
    // that gives up on a silent audio pipeline both live in here.
    fire: (ms) => timers.filter((t) => !t.cleared && t.ms === ms).forEach((t) => { t.cleared = true; t.fn(); }),
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
  // A session that was working: something was transcribed before the server
  // went away. (With nothing heard, the controller falls back to the browser
  // instead — the test below.)
  h.socket().onmessage?.({ data: JSON.stringify({ type: "final", text: "cramps today" }) });
  h.socket().serverClose();
  h.c.stop();
  eq(h.state, [true, false]);
});

// ---- the answer coming back, and letting go of it --------------------------
const pcmFrame = (n = 240) => {
  const bytes = new Uint8Array(n * 2);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

test("the reply is played, and stopping stops it mid-sentence", async () => {
  const started = [], stopped = [];
  class FakeBufferSource {
    connect() {} disconnect() {}
    start() { started.push(this); }
    stop() { stopped.push(this); }
  }
  class PlayerCtx {
    constructor() { this.currentTime = 0; this.destination = {}; this.closed = false; }
    createBuffer(ch, frames, rate) { return { duration: frames / rate, getChannelData: () => new Float32Array(frames) }; }
    createBufferSource() { return new FakeBufferSource(); }
    resume() {} close() { this.closed = true; return Promise.resolve(); }
  }
  const speaking = [];
  const h = harness({ silenceMs: 1200 });
  // Only the player's context — the microphone pump needs the harness's own,
  // which knows how to make a stream source. (Overriding both is how this test
  // first "failed": the pump threw, the session tore itself down, and stop()
  // had nothing left to stop.)
  h.c.player.AC = PlayerCtx;
  h.c.onSpeaking = (v) => speaking.push(v);
  h.c.start();
  await settle();
  h.socket().open();
  h.socket().onmessage?.({ data: JSON.stringify({ type: "audio", rate: 24000, pcm: pcmFrame() }) });
  h.socket().onmessage?.({ data: JSON.stringify({ type: "audio", rate: 24000, pcm: pcmFrame() }) });
  eq(started.length, 2, "the answer never played: ");
  h.c.stop();
  eq(stopped.length, 2, "it carried on talking after the conversation ended: ");
  eq(speaking[speaking.length - 1], false, "it still thinks it is speaking: ");
});

test("an error from the session is said out loud, not swallowed", async () => {
  const h = harness({ silenceMs: 1200 });
  h.c.start();
  await settle();
  h.socket().open();
  h.socket().onmessage?.({ data: JSON.stringify({ type: "error", message: "session closed by the model" }) });
  eq(h.errors, ["session closed by the model"]);
});

// ---- knowing when somebody has finished ------------------------------------
// The streaming server transcribes until it is told the utterance is over; it
// has no endpointing of its own. Left to itself it listens forever and nothing
// is ever submitted, which is exactly what it did.
test("a pause does not end the stream — the model decides that", () => {
  // The old client ran its own endpointer and sent "end" after a quiet second.
  // That did not end the turn so much as end the stream: the session had
  // nothing left to hear, and the microphone went dead for the rest of the
  // conversation. Silence is what the model listens for, so silence keeps
  // being sent, and nothing here interrupts it.
  const h = harness({ silenceMs: 1200 });
  h.c.start();
  return settle().then(() => {
    h.socket().open();
    h.socket().onmessage?.({ data: JSON.stringify({ type: "partial", text: "bad cramps" }) });
    h.socket().onmessage?.({ data: JSON.stringify({ type: "partial", text: "bad cramps today" }) });
    h.fire(1200);                                  // a pause, as far as the client can tell
    eq(h.socket().sent.filter((x) => typeof x === "string").length, 0,
       "the client ended the stream behind the model's back: ");
  });
});

// A live session answers WHILE the transcript is being handed up. "final" is
// the end of the question, never the end of the answer — and the answer is
// sitting in a buffer that closing the session would throw away.
const speak = (h, seconds = 1) => {
  const samples = Math.round(24000 * seconds);
  const pcm = Buffer.alloc(samples * 2).toString("base64");
  h.socket().onmessage?.({ data: JSON.stringify({ type: "audio", rate: 24000, pcm }) });
};

test("a turn ends when the answer has been heard, not when the transcript lands", async () => {
  const h = harness();
  const finals = [];
  h.c.onFinal = (t) => finals.push(t);
  h.c.start();
  await settle();
  h.socket().open();
  h.socket().onmessage?.({ data: JSON.stringify({ type: "partial", text: "bad cramps today" }) });
  speak(h, 1);                       // it has started answering
  h.socket().onmessage?.({ data: JSON.stringify({ type: "final", text: "bad cramps today" }) });
  eq(finals, ["bad cramps today"]);

  h.fire(200);                       // ... still a second of answer to play
  eq(h.socket().closed, false, "hung up mid-sentence: ");
  eq(h.c.player.remaining() > 0.5, true, "nothing left to play: ");

  h.ctx().currentTime = 99;          // the answer finishes
  h.fire(200); h.fire(200);
  eq(h.c.stopped, true, "never let go of the microphone: ");
  h.fire(250);                        // the socket closes after its goodbye
  eq(h.socket().closed, true, "socket left open: ");
  eq(h.state[h.state.length - 1], false, "still listening after the answer: ");
});

test("a conversation keeps listening after it has answered", async () => {
  // The session hears and answers down the same connection, so a finished
  // answer is not a finished conversation: closing the microphone here is how
  // somebody ends up pressing the button again to say their second sentence.
  const h = harness({ conversation: true });
  h.c.start();
  await settle();
  h.socket().open();
  speak(h, 1);
  h.socket().onmessage?.({ data: JSON.stringify({ type: "final", text: "bad cramps today" }) });
  h.ctx().currentTime = 99;
  for (let i = 0; i < 5; i++) h.fire(200);
  eq(h.c.stopped, false, "stopped listening after answering: ");
  eq(h.socket().closed, false, "hung up after one turn: ");
});

test("a turn that is never answered still lets go of the microphone", async () => {
  const h = harness();
  h.c.start();
  await settle();
  h.socket().open();
  h.socket().onmessage?.({ data: JSON.stringify({ type: "final", text: "hello" }) });
  for (let i = 0; i < 45 && !h.c.stopped; i++) h.fire(200);
  eq(h.c.stopped, true, "waited forever for an answer that never came: ");
});

test("an empty final is not a turn", async () => {
  const h = harness();
  const finals = [];
  h.c.onFinal = (t) => finals.push(t);
  h.c.start();
  await settle();
  h.socket().open();
  h.socket().onmessage?.({ data: JSON.stringify({ type: "final", text: "   " }) });
  eq(finals, [], "silence was submitted as if it were speech: ");
});

test("an audio pipeline that never starts hands over to the browser", async () => {
  // A phone can hand back a suspended AudioContext: microphone on, socket open,
  // and not one sample ever sent. Waiting forever is the wrong answer.
  const made = [];
  class FakeRec { constructor() { made.push(this); } start() {} stop() {} abort() {} }
  const h = harness({ silenceMs: 1200 });
  h.c.deps.SpeechRecognition = FakeRec;
  h.c.start();
  await settle();
  h.socket().open();
  h.fire(2500);                                             // the watchdog
  eq(made.length, 1, "it sat there with a dead microphone: ");
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

// ---- the browser's own recogniser -----------------------------------------
// Chrome on Android ends the session after every utterance and re-delivers
// results it has already given as final — with the index counter back at zero.
// Appending what arrives turns one sentence into "I'm feeling feeling feeling".
function webHarness({ continuous = false } = {}) {
  const made = [], partials = [], finals = [], timers = [];
  const R = (text, isFinal) => ({ isFinal, 0: { transcript: text } });
  class FakeRec {
    constructor() { made.push(this); this.aborted = false; }
    start() { this.started = true; this.onstart?.(); }
    stop() { this.onend?.(); }
    abort() { this.aborted = true; }
    /** still holding the microphone: hooked up, and never aborted */
    get live() { return !this.aborted && !!this.onresult; }
    /** what Chrome hands over: a growing list, from `resultIndex` onwards */
    hears(list, resultIndex = 0) { this.onresult?.({ resultIndex, results: list.map(([t, f]) => R(t, f)) }); }
    ends() { this.onend?.(); }
  }
  const c = new VoiceController({
    continuous,
    onPartial: (t) => partials.push(t), onFinal: (t) => finals.push(t),
    deps: {
      SpeechRecognition: FakeRec,
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.cleared = true; },
    },
  });
  // Two different clocks matter here: the beat before a restart (250ms) and
  // the pause that ends a turn (silenceMs). Firing them together would commit a
  // sentence that was only waiting for the recogniser to come back.
  const fire = (ms) => timers.filter((t) => !t.cleared && t.ms === ms).forEach((t) => { t.cleared = true; t.fn(); });
  return { c, made, partials, finals, fire, rec: () => made[made.length - 1],
           restart: () => fire(120), silence: () => fire(2500) };
}

test("the same final delivered twice is heard once", async () => {
  const h = webHarness();
  await h.c.start();
  h.rec().hears([["I'm feeling rough", true]]);
  h.rec().hears([["I'm feeling rough", true]]);          // Android, saying it again
  h.silence();
  eq(h.finals, ["I'm feeling rough"]);
});

test("a session that restarts keeps what the last one heard", async () => {
  const h = webHarness();
  await h.c.start();
  h.rec().hears([["cramps since this morning", true]]);
  h.rec().ends();                                        // Android ends after every utterance
  h.rec().hears([["and I barely slept", true]]);         // ... and counts from zero again
  h.silence();
  eq(h.finals, ["cramps since this morning and I barely slept"]);
});

test("an utterance repeated by the restart is not said twice", async () => {
  const h = webHarness();
  await h.c.start();
  h.rec().hears([["I'm feeling rough", true]]);
  h.rec().ends();
  h.rec().hears([["I'm feeling rough", true]]);          // the same one, re-delivered
  h.silence();
  eq(h.finals, ["I'm feeling rough"]);
});

test("interim words are shown but never banked", async () => {
  const h = webHarness();
  await h.c.start();
  h.rec().hears([["bad", false]]);
  h.rec().hears([["bad cramps", false]]);
  h.rec().hears([["bad cramps today", true]]);
  h.silence();
  eq(h.partials[h.partials.length - 1], "bad cramps today");
  eq(h.finals, ["bad cramps today"]);
});

test("a restart never leaves two recognisers listening", async () => {
  const h = webHarness({ continuous: true });
  await h.c.start();
  const first = h.rec();
  h.rec().hears([["cramps today", true]]);
  first.ends();                                  // Android: the session is over
  h.restart();
  eq(h.made.length, 2, "it did not restart: ");
  eq(first.live, false, "the old recogniser is still hooked up: ");
  eq(h.rec().live, true, "the new one is not listening: ");
});

test("a stale recogniser talking to itself is ignored", async () => {
  const h = webHarness({ continuous: true });
  await h.c.start();
  const first = h.rec();
  first.hears([["cramps today", true]]);
  first.ends();
  h.restart();                                   // the new one is built here
  // Android sometimes keeps the old one going for a moment. Whatever it says
  // now belongs to a session that is over.
  first.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "cramps today" } }] });
  h.rec().hears([["and I barely slept", true]]);
  h.silence();
  eq(h.finals, ["cramps today and I barely slept"]);
});

test("a speech server that is not there hands over to the browser", async () => {
  const made = [], finals = [];
  class FakeRec {
    constructor() { made.push(this); }
    start() { this.onstart?.(); }
    stop() { this.onend?.(); }
    abort() {}
  }
  const timers = [];
  const c = new VoiceController({
    endpoint: "wss://asr.test/stream",
    onFinal: (t) => finals.push(t),
    deps: {
      WebSocket: FakeSocket,
      getUserMedia: () => Promise.resolve(fakeStream()),
      AudioContext: function () { return new FakeCtx(); },
      SpeechRecognition: FakeRec,
      setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
      clearTimeout: (t) => { if (t) t.cleared = true; },
    },
  });
  await c.start();
  await settle();
  FakeSocket.made[FakeSocket.made.length - 1].serverClose();     // nothing listening
  eq(made.length, 1, "it did not fall back to the browser: ");
  // ... and the fallback works: a sentence still comes out
  made[0].onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "cramps today" } }] });
  timers.filter((t) => !t.cleared && t.ms === 2500).forEach((t) => t.fn());
  eq(finals, ["cramps today"]);
});

// ---- and none of that at the cost of a browser that behaves ---------------
// Desktop Chrome hands over a growing list: the finals it has settled, then the
// interim it is still working on. Nothing overlaps, and nothing is repeated.
test("a well-behaved browser is left exactly as it was", async () => {
  const h = webHarness();
  await h.c.start();
  h.rec().hears([["bad cramps today", true]]);
  h.rec().hears([["bad cramps today", true], ["and", false]], 1);
  h.rec().hears([["bad cramps today", true], ["and I barely", false]], 1);
  h.rec().hears([["bad cramps today", true], ["and I barely slept", true]], 1);
  h.silence();
  eq(h.finals, ["bad cramps today and I barely slept"]);
});

test("a word said twice on purpose is kept twice", () => {
  eq(mergeSpeech("no", "no"), "no no");
  eq(mergeSpeech("it hurts", "hurts a lot"), "it hurts a lot");
});

test("joining two pieces of speech never says anything twice", () => {
  eq(mergeSpeech("I'm feeling", "I'm feeling"), "I'm feeling");
  eq(mergeSpeech("I'm", "I'm feeling rough"), "I'm feeling rough");
  eq(mergeSpeech("I'm feeling", "feeling rough"), "I'm feeling rough");
  eq(mergeSpeech("I'm feeling rough", "and I slept badly"), "I'm feeling rough and I slept badly");
  eq(mergeSpeech("", "cramps"), "cramps");
  eq(mergeSpeech("cramps", ""), "cramps");
  // a shared fragment that is not a whole word is not an overlap
  eq(mergeSpeech("I ran in", "individual days"), "I ran in individual days");
});

// ---- run it ---------------------------------------------------------------
let passed = 0, failed = 0;
for (const [name, fn] of T) {
  try { await fn(); passed++; }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
