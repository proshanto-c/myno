/**
 * Speech capture, and — the part that keeps going wrong — its teardown.
 *
 * Two backends: a NeMo streaming socket when one is configured, otherwise the
 * browser's own recogniser. The socket path holds three things that outlive a
 * click if nobody closes them: the WebSocket, the microphone stream, and an
 * AudioContext with a live processor node hanging off it.
 *
 * The rules this file keeps:
 *   - stop() is idempotent and safe at any point in the startup sequence,
 *     including while the microphone permission prompt is still open
 *   - anything created after stop() was called is torn down immediately rather
 *     than left running (the leak: getUserMedia resolves late, and a socket
 *     opens for a session the person already ended)
 *   - "listening" turns off when the teardown finishes, not when it is asked
 *     for, and the socket closing on its own turns it off too
 *
 * Pure enough to test: every browser API it touches can be handed in.
 */
/**
 * Joins two pieces of heard speech without saying anything twice.
 *
 * Recognisers — Chrome on Android above all — hand back what they have already
 * given you: the same phrase again, a longer version of it, or a new piece that
 * begins with the end of the last one. Concatenating those is what turns one
 * sentence into "I'm feeling feeling feeling". So the join is by overlap:
 *
 *   ("I'm feeling", "I'm feeling")        → "I'm feeling"        (the same)
 *   ("I'm", "I'm feeling rough")          → "I'm feeling rough"  (longer)
 *   ("I'm feeling", "feeling rough")      → "I'm feeling rough"  (overlapping)
 *   ("I'm feeling", "and I slept badly")  → both, joined         (new words)
 *
 * Exported for the tests, which is the only reason it is not a closure.
 */
export function mergeSpeech(before, after) {
  const tidy = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
  const a = tidy(before), b = tidy(after);
  if (!a) return b;
  if (!b) return a;
  const A = a.toLowerCase(), B = b.toLowerCase();
  // Somebody can say a short word twice — "no, no" — and mean it. Only a
  // repeat with some substance to it is treated as the recogniser stuttering.
  const enough = (t) => t.length >= 8 || t.split(" ").length >= 2;
  if (A.endsWith(B) && enough(B)) return a;   // already there
  // ... and a "longer version" has to actually be longer, or "no" followed by
  // "no" collapses into one.
  if (B.startsWith(A) && B.length > A.length) return b;
  // ... or the two overlap: keep the shared middle only once. Whole words only,
  // so "in" ending one and "individual" opening the next is not an overlap.
  for (let n = Math.min(A.length, B.length); n > 2; n--) {
    const tail = A.slice(A.length - n), head = B.slice(0, n);
    if (tail !== head) continue;
    const cleanEnd = n === A.length || A[A.length - n - 1] === " ";
    const cleanCut = n === B.length || B[n] === " ";
    if (cleanEnd && cleanCut) return tidy(a + b.slice(n));
  }
  return `${a} ${b}`;
}

/**
 * Plays the answer as it arrives.
 *
 * The Live session sends raw PCM in pieces, not a file — so each piece is
 * scheduled on the end of the last one rather than played on its own, or the
 * sentence comes out in slices with gaps between them. Everything it starts is
 * held so that stopping stops it: a voice that carries on after the person has
 * closed the conversation is the rudest bug in the app.
 */
// How often to ask whether the answer has finished playing, and how long to
// wait for one that never comes before letting go of the microphone anyway.
const DRAIN_TICK = 200;
const NO_ANSWER_MS = 8000;

// How far ahead of real time the answer starts: long enough to absorb a late
// chunk, short enough that nobody feels it — and how far it will go if the
// connection keeps missing.
const LEAD = 0.22;
const MAX_LEAD = 0.6;

class Playback {
  constructor(AudioContextClass) {
    this.AC = AudioContextClass;
    this.ctx = null;
    this.sources = new Set();
    this.at = 0;
    this.lead = LEAD;
    this.underruns = 0;
  }
  /** Seconds of answer still scheduled to play. 0 when it has finished. */
  remaining() {
    if (!this.ctx) return 0;
    const left = this.at - (this.ctx.currentTime || 0);
    return left > 0 ? left : 0;
  }
  play(pcm16, rate) {
    if (!this.AC || !pcm16?.length) return;
    if (!this.ctx) { this.ctx = new this.AC(); this.at = 0; }
    const ctx = this.ctx;
    try { ctx.resume?.(); } catch (e) {}
    const frames = pcm16.length;
    const buffer = ctx.createBuffer(1, frames, rate || 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) channel[i] = pcm16[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    // On the end of the queue, so the pieces meet exactly. The first piece of
    // a sentence waits a moment before starting, because the model sends audio
    // at about the speed it is spoken: a queue with no slack in it is empty
    // whenever the network is late, and audio with holes in it does not sound
    // like a pause, it sounds like a robot.
    //
    // When it does run dry mid-sentence the answer is to hold more of it back,
    // so a bad connection costs a fraction of a second at the start rather
    // than a stutter in every sentence after it.
    const now = ctx.currentTime;
    const midSentence = this.at > 0 && now - this.at < 0.6;
    if (midSentence && this.at <= now) {
      this.underruns++;
      this.lead = Math.min(this.lead + 0.12, MAX_LEAD);
    }
    this.at = this.at > now ? this.at : now + this.lead;
    src.start(this.at);
    this.at += buffer.duration;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); };
  }
  /** Drop what is queued, but stay ready to play more. */
  flush() {
    for (const src of this.sources) {
      try { src.onended = null; src.stop(); } catch (e) {}
      try { src.disconnect(); } catch (e) {}
    }
    this.sources.clear();
    this.at = 0;
  }
  /** Silence now, and nothing left scheduled. */
  stop() {
    for (const src of this.sources) {
      try { src.onended = null; src.stop(); } catch (e) {}
      try { src.disconnect(); } catch (e) {}
    }
    this.sources.clear();
    this.at = 0;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) { try { const p = ctx.close(); if (p?.catch) p.catch(() => {}); } catch (e) {} }
  }
}

export class VoiceController {
  constructor({ endpoint, onPartial, onFinal, onReply, onSpeaking, onMode, onState, onError,
                continuous, conversation, silenceMs, deps = {} }) {
    this.endpoint = endpoint;
    this.onPartial = onPartial; this.onFinal = onFinal;
    this.onReply = onReply;            // what it is saying back, as text
    this.onSpeaking = onSpeaking;      // ... and whether it is still saying it
    this.onMode = onMode;              // which recogniser ended up being used
    this.onState = onState; this.onError = onError;
    this.continuous = !!continuous;
    // A LIVE SESSION IS A CONVERSATION, and the browser's own recogniser is
    // not. The session hears and answers down one connection, so it can keep
    // listening while it speaks — that is how somebody interrupts it, and how
    // they say the next thing without reaching for the button again. The
    // browser recogniser has to take turns: the app says the reply out loud
    // through the speaker the recogniser is listening to, and a microphone
    // left open transcribes the app talking to itself.
    this.conversation = !!conversation;
    this.silenceMs = silenceMs || 2500;
    const g = typeof window === "undefined" ? {} : window;
    this.deps = {
      WebSocket: deps.WebSocket || g.WebSocket,
      getUserMedia: deps.getUserMedia
        || ((c) => g.navigator?.mediaDevices?.getUserMedia(c)),
      AudioContext: deps.AudioContext || g.AudioContext || g.webkitAudioContext,
      SpeechRecognition: deps.SpeechRecognition || g.SpeechRecognition || g.webkitSpeechRecognition,
      setTimeout: deps.setTimeout || ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: deps.clearTimeout || ((t) => clearTimeout(t)),
    };
    this.stopped = false;
    this.heard = false;         // has the server recogniser produced anything?
    this.fellBack = false;
    this.player = new Playback(this.deps.AudioContext);
    this.mode = endpoint ? "nemo" : (this.deps.SpeechRecognition ? "webspeech" : "none");
  }

  available() { return this.mode !== "none"; }

  async start() {
    this.stopped = false;
    this.onMode?.(this.mode);
    if (this.mode === "nemo") return this._nemo();
    if (this.mode === "webspeech") return this._web();
    this.onError?.("Voice isn't available here — please type.");
  }

  /**
   * Close the session once the answer has been heard.
   *
   * Two ways to get this wrong, and the old code managed the first: stop on
   * the transcript, and the sentence is cut off wherever the buffer had got
   * to. Stop on a fixed timer instead and it is cut off somewhere else. So it
   * asks what is actually left to play, and asks again while that keeps
   * growing — audio still arriving pushes the end further out on its own.
   *
   * The cap is for the turn that never gets an answer: a session that hangs
   * should still let go of the microphone.
   */
  _stopWhenSpoken() {
    this.deps.clearTimeout(this.drainTimer);
    let waited = 0, quiet = 0;
    const tick = () => {
      if (this.stopped) return;
      waited += DRAIN_TICK;
      // Two quiet ticks, not one: a chunk arriving late empties the queue for
      // a moment without the sentence being over, and hanging up in that gap
      // is the bug this exists to avoid.
      quiet = this.player.remaining() <= 0.06 ? quiet + 1 : 0;
      const answered = this.heardAudio && quiet >= 2;
      if (answered || waited >= NO_ANSWER_MS) { this.stop(); return; }
      this.drainTimer = this.deps.setTimeout(tick, DRAIN_TICK);
    };
    this.drainTimer = this.deps.setTimeout(tick, DRAIN_TICK);
  }

  /** Safe to call twice, and safe before start() has finished. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.deps.clearTimeout(this.silTimer);
    this.deps.clearTimeout(this.pumpTimer);
    this.deps.clearTimeout(this.quietTimer);
    this.deps.clearTimeout(this.drainTimer);
    this.player.stop();                 // it does not get to finish its sentence
    this.onSpeaking?.(false);
    if (this.mode === "nemo") this._teardown({ flush: true });
    else {
      this.active = false;
      this.deps.clearTimeout(this.silTimer);
      this.deps.clearTimeout(this.restartTimer);
      try { this.rec?.stop(); } catch (e) {}
      this.onState?.(false);
    }
  }

  // ---- NeMo socket --------------------------------------------------------
  async _nemo() {
    let stream;
    try {
      // Echo cancellation is not a nicety here. The microphone stays open
      // while the answer plays out loud so that a person can interrupt it —
      // which means that on a phone held in the hand, with the speaker a few
      // centimetres from the microphone, the model hears ITSELF talking and
      // stops, mid-sentence, believing it has been interrupted. Asking for it
      // explicitly rather than trusting each browser's defaults.
      stream = await this.deps.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      this.onState?.(false);
      this.onError?.("Microphone access was blocked — you can type instead.");
      return;
    }
    // The prompt can sit open for a long time. If they gave up and pressed the
    // button again while it was up, the microphone we just opened is nobody's.
    if (this.stopped) { this._stopTracks(stream); return; }
    this.stream = stream;

    try {
      const ws = new this.deps.WebSocket(this.endpoint);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        if (this.stopped) { this._closeSocket(ws, { flush: false }); return; }
        this.onState?.(true);
      };
      ws.onerror = () => { if (!this.heard) this._fallBackToBrowser(); };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        // Nothing was ever transcribed: the server is not there, or nginx is not
        // passing /asr through. Rather than a dead microphone and a note about
        // Settings, hand over to the recogniser the browser has of its own.
        if (!this.stopped && !this.heard) { this._fallBackToBrowser(); return; }
        // Closed by the server or the network rather than by us — but there
        // may still be seconds of answer sitting in the buffer, and throwing
        // that away is how a sentence gets cut off mid-word. Let it finish
        // speaking; the connection is already gone either way.
        if (!this.stopped) {
          if (this.player.remaining() > 0.06) { this._stopWhenSpoken(); return; }
          this.stopped = true;
          this._teardown({ flush: false });
        }
      };
      // WHO DECIDES A TURN IS OVER.
      //
      // The model does. It is listening to the audio as it arrives and knows a
      // pause when it hears one — so the microphone keeps streaming through
      // silences rather than stopping, because silence is exactly what it is
      // listening for.
      //
      // This used to run a timer of its own and send "end" after a quiet
      // second, which did not end the turn so much as end the stream: the
      // session had nothing left to hear, and the microphone went dead for the
      // rest of the conversation. "end" is now what a person means when they
      // press the button — nothing else sends it.
      let lastPartial = "";
      const b64ToPcm = (b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === "reply") { this.heard = true; this.onReply?.(m.text); return; }
          if (m.type === "audio") {
            // It is answering. The microphone is still open, so the model hears
            // itself and stops when interrupted — which is the point of it.
            this.onSpeaking?.(true);
            this.heardAudio = true;
            try { this.player.play(b64ToPcm(m.pcm), m.rate); } catch (err) {}
            this.deps.clearTimeout(this.quietTimer);
            this.quietTimer = this.deps.setTimeout(() => this.onSpeaking?.(false), 1200);
            return;
          }
          if (m.type === "interrupted") {
            // It stopped talking because it heard something. Whatever is still
            // queued was going to be the rest of a sentence it has abandoned,
            // and playing it now would talk over the person.
            this.player.flush();
            this.onSpeaking?.(false);
            return;
          }
          if (m.type === "error") { this.onError?.(m.message || "The conversation service stopped."); return; }
          if (m.type === "partial") {
            this.heard = true;
            const t = (m.text || "").trim();
            if (t) lastPartial = t;
            this.onPartial?.(m.text);
          } else if (m.type === "final") {
            this.heard = true;
            this.deps.clearTimeout(this.silTimer);
            lastPartial = "";
            const t = (m.text || "").trim();
            if (!t) return;                       // nothing was said; keep listening
            // `spoken` tells the app the answer has already been said out loud
            // by the session, so it does not say one of its own on top.
            this.onFinal?.(t, { spoken: true });
            // A conversation carries straight on: it is still listening while
            // it answers, and the next thing said is the next turn.
            //
            // A single turn ends — but not here. "final" means the person has
            // stopped talking and the answer is on its way; the answer is
            // still being played out of a buffer that stopping would throw
            // away, mid-word. It ends when there is nothing left to say.
            if (!this.conversation) this._stopWhenSpoken();
          }
        } catch (err) {}
      };
      this._pump(stream, ws);
    } catch (e) {
      this.stopped = true;
      this._teardown({ flush: false });
      this.onError?.("Couldn't open the ASR connection.");
    }
  }

  /**
   * The server recogniser could not be reached, and nothing has been heard yet.
   *
   * The browser's own is worse — noticeably so on a phone, where it may be the
   * handset's offline model — but it is there, and a microphone that does
   * nothing is worse than either.
   */
  _fallBackToBrowser() {
    if (this.fellBack || this.stopped) return;
    this.fellBack = true;
    this.deps.clearTimeout(this.pumpTimer);
    this._teardown({ flush: false });
    if (!this.deps.SpeechRecognition) {
      this.onError?.("Couldn't reach the speech server — please type instead.");
      return;
    }
    this.mode = "webspeech";
    this.stopped = false;
    this.onMode?.("webspeech");        // it answers for itself now, and does not speak
    this.onError?.("Using this device's own speech recognition.");
    this._web();
  }

  /** Microphone → 16 kHz PCM → socket. */
  _pump(stream, ws) {
    const AC = this.deps.AudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    // A phone hands back a SUSPENDED context unless it was made inside a tap,
    // and awaiting getUserMedia is enough to lose that. Suspended means
    // onaudioprocess never fires: the microphone light is on, the socket is
    // open, and not one sample is ever sent. Ask for it back.
    try { ctx.resume?.(); } catch (e) {}
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    this.node = node;
    const ratio = ctx.sampleRate / 16000;
    let frames = 0;
    // ... and if it stays asleep, nothing will ever come of this session. Give
    // it a moment, then hand over to the recogniser the browser has of its own.
    this.deps.clearTimeout(this.pumpTimer);
    this.pumpTimer = this.deps.setTimeout(() => {
      if (!this.stopped && !frames) this._fallBackToBrowser();
    }, 2500);
    node.onaudioprocess = (ev) => {
      if (this.stopped || ws.readyState !== 1) return;
      frames += 1;
      const input = ev.inputBuffer.getChannelData(0);
      const out = new Int16Array(Math.floor(input.length / ratio));
      for (let i = 0; i < out.length; i++) {
        const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(out.buffer);
    };
    src.connect(node);
    node.connect(ctx.destination);
  }

  /** Everything the socket path opened, closed once and in order. */
  _teardown({ flush }) {
    this.deps.clearTimeout(this.quietTimer);
    this.player.stop();
    this.onSpeaking?.(false);
    const node = this.node, ctx = this.ctx, stream = this.stream, ws = this.ws;
    this.node = null; this.ctx = null; this.stream = null;
    if (node) {
      node.onaudioprocess = null;            // or the node keeps the graph alive
      try { node.disconnect(); } catch (e) {}
    }
    if (ctx) { try { const p = ctx.close(); if (p?.catch) p.catch(() => {}); } catch (e) {} }
    this._stopTracks(stream);
    if (ws) this._closeSocket(ws, { flush });
    this.onState?.(false);
  }

  _stopTracks(stream) {
    try { stream?.getTracks?.().forEach((t) => t.stop()); } catch (e) {}
  }

  /** Closes at any readyState, and never leaves a timer behind. */
  _closeSocket(ws, { flush }) {
    if (this.ws === ws) this.ws = null;
    const state = ws.readyState;
    if (state === 2 || state === 3) return;      // CLOSING / CLOSED
    if (state === 1 && flush) {
      try { ws.send(JSON.stringify({ type: "end" })); } catch (e) {}
      this.deps.clearTimeout(this.closeTimer);
      this.closeTimer = this.deps.setTimeout(() => { try { ws.close(); } catch (e) {} }, 250);
      return;
    }
    // CONNECTING, or nothing to flush: close now. Closing a connecting socket
    // aborts the handshake, which is what we want.
    try { ws.close(); } catch (e) {}
  }

  // ---- the browser's own recogniser ---------------------------------------
  /**
   * Chrome on Android is the awkward one.
   *
   * It ignores `continuous`, so the session ends after every utterance and this
   * restarts it — and across those restarts it re-delivers results that were
   * already final, sometimes with the index counter back at zero. Appending
   * whatever arrived is what turned one sentence into "I'm feeling feeling
   * feeling".
   *
   * So a final is stored BY ITS INDEX and the text is rebuilt from those slots,
   * never appended to: hearing the same result a second time writes the same
   * slot again and changes nothing. What a finished session heard is banked
   * before the next one starts counting from zero, and an utterance identical
   * to the one just banked is dropped, because that is a redelivery rather than
   * somebody saying it twice.
   */
  _web() {
    const SR = this.deps.SpeechRecognition;
    this.active = true; this.finalText = ""; this._started = false;
    let banked = "";      // what sessions that have already ended heard
    let session = "";     // what this one has heard so far
    const settled = () => mergeSpeech(banked, session);
    const commit = () => {
      this.deps.clearTimeout(this.silTimer);
      const t = settled();
      if (!t) return;                       // nothing said yet → keep waiting
      banked = ""; session = ""; this.finalText = "";
      this.onFinal?.(t);
      if (!this.continuous) { this.active = false; try { this.rec?.stop(); } catch (e) {} }
    };
    const arm = () => {
      this.deps.clearTimeout(this.silTimer);
      this.silTimer = this.deps.setTimeout(commit, this.silenceMs);
    };
    // ONE RECOGNISER AT A TIME.
    //
    // Android's is not the same animal as the desktop's: it ignores
    // `continuous` and ends the session after every utterance, so this restarts
    // it — and a restart is where two of them end up listening to the same
    // person at once, each reporting what it hears into the same handler. That
    // is what "I'm feeling feeling feeling" is: not one recogniser repeating
    // itself, but two of them agreeing.
    //
    // So each one is given a number. Only the newest is listened to, the one
    // before it is unhooked and aborted before the next is built, and anything
    // a stale one has to say afterwards is dropped on the floor.
    let generation = 0;
    const unhook = (rec) => {
      if (!rec) return;
      rec.onresult = rec.onend = rec.onerror = rec.onstart = null;
      try { rec.abort ? rec.abort() : rec.stop(); } catch (e) {}
    };
    const build = () => {
      unhook(this.rec);                       // never two of them listening
      const mine = ++generation;
      const mineAlone = () => mine === generation && this.active && !this.stopped;
      const rec = new SR();
      rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
      rec.onstart = () => { if (!this._started) { this._started = true; this.onState?.(true); } };
      rec.onerror = (ev) => {
        if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
          this.active = false;
          this.deps.clearTimeout(this.silTimer);
          this.onState?.(false);
          this.onError?.("Microphone blocked — type instead.");
        }
      };
      rec.onend = () => {
        if (mine !== generation) return;      // an older one finishing; not ours
        // Bank what this session heard before the next one starts counting from
        // zero. Merged rather than appended: a restart often opens by handing
        // back the end of what it just gave us.
        banked = mergeSpeech(banked, session);
        session = "";
        this.finalText = banked;
        if (this.active && !this.stopped) {
          // A beat before restarting: Android needs the microphone back before
          // it will give it out again, and a tight loop here spins forever.
          // Short, though — this gap sits between two things somebody is saying.
          this.deps.clearTimeout(this.restartTimer);
          this.restartTimer = this.deps.setTimeout(() => {
            if (this.active && !this.stopped) { try { build(); } catch (e) {} }
          }, 120);
        } else { this._started = false; this.onState?.(false); }
      };
      rec.onresult = (ev) => {
        if (!mineAlone()) return;             // a stale recogniser, still talking
        // Rebuilt from the whole list every time, never appended to. `results`
        // is the session so far, so re-reading it is free — and it is the only
        // way to be immune to a recogniser that hands the same thing back.
        let heard = "", interim = "", gotFinal = false;
        for (let i = 0; i < ev.results.length; i++) {
          const r = ev.results[i];
          const t = r?.[0]?.transcript;
          if (!t) continue;
          if (r.isFinal) { heard = mergeSpeech(heard, t); gotFinal = true; }
          else interim = mergeSpeech(interim, t);
        }
        session = heard;
        this.finalText = settled();
        this.onPartial?.(mergeSpeech(settled(), interim));
        if (gotFinal) arm();
        else this.deps.clearTimeout(this.silTimer);
      };
      this.rec = rec;
      try { rec.start(); } catch (e) {}
    };
    build();
  }
}
