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
export class VoiceController {
  constructor({ endpoint, onPartial, onFinal, onState, onError, continuous, silenceMs, deps = {} }) {
    this.endpoint = endpoint;
    this.onPartial = onPartial; this.onFinal = onFinal;
    this.onState = onState; this.onError = onError;
    this.continuous = !!continuous;
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
    this.mode = endpoint ? "nemo" : (this.deps.SpeechRecognition ? "webspeech" : "none");
  }

  available() { return this.mode !== "none"; }

  async start() {
    this.stopped = false;
    if (this.mode === "nemo") return this._nemo();
    if (this.mode === "webspeech") return this._web();
    this.onError?.("Voice isn't available here — please type.");
  }

  /** Safe to call twice, and safe before start() has finished. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.mode === "nemo") this._teardown({ flush: true });
    else {
      this.active = false;
      this.deps.clearTimeout(this.silTimer);
      try { this.rec?.stop(); } catch (e) {}
      this.onState?.(false);
    }
  }

  // ---- NeMo socket --------------------------------------------------------
  async _nemo() {
    let stream;
    try {
      stream = await this.deps.getUserMedia({ audio: { channelCount: 1 } });
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
      ws.onerror = () => this.onError?.("Couldn't reach the ASR server — check Settings.");
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        // closed by the server or the network rather than by us
        if (!this.stopped) { this.stopped = true; this._teardown({ flush: false }); }
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === "partial") this.onPartial?.(m.text);
          else if (m.type === "final") this.onFinal?.(m.text);
        } catch (err) {}
      };
      this._pump(stream, ws);
    } catch (e) {
      this.stopped = true;
      this._teardown({ flush: false });
      this.onError?.("Couldn't open the ASR connection.");
    }
  }

  /** Microphone → 16 kHz PCM → socket. */
  _pump(stream, ws) {
    const AC = this.deps.AudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    this.node = node;
    const ratio = ctx.sampleRate / 16000;
    node.onaudioprocess = (ev) => {
      if (this.stopped || ws.readyState !== 1) return;
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
  _web() {
    const SR = this.deps.SpeechRecognition;
    this.active = true; this.finalText = ""; this._started = false;
    const commit = () => {
      this.deps.clearTimeout(this.silTimer);
      const t = (this.finalText || "").trim();
      if (!t) return;                       // nothing said yet → keep waiting
      this.finalText = "";
      this.onFinal?.(t);
      if (!this.continuous) { this.active = false; try { this.rec?.stop(); } catch (e) {} }
    };
    const arm = () => {
      this.deps.clearTimeout(this.silTimer);
      this.silTimer = this.deps.setTimeout(commit, this.silenceMs);
    };
    const build = () => {
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
        if (this.active && !this.stopped) {
          try { build(); } catch (e) { this.deps.setTimeout(() => { if (this.active && !this.stopped) build(); }, 300); }
        } else { this._started = false; this.onState?.(false); }
      };
      rec.onresult = (ev) => {
        let interim = "", gotFinal = false;
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) { this.finalText += r[0].transcript + " "; gotFinal = true; }
          else interim += r[0].transcript;
        }
        this.onPartial?.((this.finalText + interim).trim());
        if (gotFinal) arm();
        else this.deps.clearTimeout(this.silTimer);
      };
      this.rec = rec;
      try { rec.start(); } catch (e) {}
    };
    build();
  }
}
