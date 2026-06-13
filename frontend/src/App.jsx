import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Home, SquarePen, BarChart3, MessageCircle, Settings as Cog, Leaf, Plus,
  ChevronRight, Mic, MicOff, Volume2, VolumeX, Sparkles, Check, Lock, ArrowLeft, ArrowRight,
  Printer, Stethoscope, AlertTriangle, Info, Heart, Moon, Loader2, X, Target,
  Brain, HeartPulse, Microscope, Droplet, Activity
} from "lucide-react";

/* ===========================================================================
   Myno — a PCOS digital twin.  UI: "Serene Care" (Manrope / Hanken Grotesk,
   muted teal + dusty rose on warm off-white, soft tactile minimalism).
   Logic carried over: voice (NeMo streaming / browser fallback), TTS that
   speaks + shows text, personalised associations, feature blacklist, and an
   optional DB-backed backend. Decision support — not a diagnosis.
   =========================================================================== */

// ---- Serene Care tokens ----------------------------------------------------
const C = {
  bg: "#fbf9f8", surface: "#ffffff",
  low: "#f5f3f3", container: "#efeded", high: "#eae8e7", highest: "#e4e2e2",
  ink: "#1b1c1c", inkVar: "#404849", outline: "#707979", outlineVar: "#c0c8c8",
  teal: "#366366", tealC: "#4f7c7f", tealDark: "#1f4d50",
  tealFixed: "#bcebee", tealFixedDim: "#a0cfd2", onTealFixed: "#002022",
  rose: "#fbd7d7", roseOn: "#775c5c", roseFixed: "#fedada", roseDeep: "#c98a93",
  error: "#ba1a1a",
};
const GRAD = "radial-gradient(circle at top right, #f4ffff 0%, #fbf9f8 100%)";
const SH = "0 8px 30px rgba(54,99,102,0.07)";
const SH_SM = "0 4px 16px rgba(54,99,102,0.05)";
const head = "'Manrope', system-ui, sans-serif";
const bodyf = "'Hanken Grotesk', system-ui, sans-serif";
const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Hanken+Grotesk:wght@400;500;600&display=swap');
*{ -webkit-font-smoothing:antialiased; box-sizing:border-box; }
.spin{ animation:spin 1s linear infinite; }
@keyframes spin{ to{ transform:rotate(360deg); } }
@keyframes pulse{ 0%,100%{ opacity:1 } 50%{ opacity:.45 } }
@keyframes rise{ from{ opacity:0; transform:translateY(8px) } to{ opacity:1; transform:none } }
input[type=range].slider{ -webkit-appearance:none; appearance:none; width:100%; height:10px; border-radius:9999px; outline:none; }
input[type=range].slider::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:30px; height:30px; border-radius:50%; background:#fff; border:4px solid ${C.teal}; box-shadow:0 2px 8px rgba(54,99,102,.25); cursor:pointer; margin-top:-1px; }
input[type=range].slider::-moz-range-thumb{ width:30px; height:30px; border-radius:50%; background:#fff; border:4px solid ${C.teal}; cursor:pointer; }
@media print{ .no-print{ display:none !important } body{ background:#fff !important } }
`;

// ---- persistence -----------------------------------------------------------
const KEY = "myno:serene:v1";
async function loadState() { try { const r = await window.storage.get(KEY); return r?.value ? JSON.parse(r.value) : null; } catch (e) { return null; } }
async function saveState(s) { try { await window.storage.set(KEY, JSON.stringify(s)); } catch (e) {} }

// ---- Claude (key from settings; falls back to keyless sandbox) --------------
async function callClaude({ system, messages, apiKey, maxTokens = 1000 }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) { headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; headers["anthropic-dangerous-direct-browser-access"] = "true"; }
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers,
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, system, messages }) });
  const j = await res.json();
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// ---- feature blacklist -----------------------------------------------------
const FEATURES = {
  mood: { label: "Mood & mental health", fields: ["mood"] },
  diet: { label: "Diet & sugar", fields: ["sugar", "cravings"] },
  hair_skin: { label: "Hair & skin", fields: ["hairGrowth", "hairLoss"] },
  weight: { label: "Weight & BMI", fields: [] },
  fertility: { label: "Fertility & conception", fields: [] },
  pain: { label: "Pain", fields: ["pain"] },
};
const isBlocked = (s, k) => (s.blacklist || []).includes(k);
const fieldBlocked = (s, f) => Object.keys(FEATURES).some((k) => isBlocked(s, k) && FEATURES[k].fields.includes(f));
const blockedLabels = (s) => (s.blacklist || []).map((k) => FEATURES[k]?.label).filter(Boolean);

// Prefer a gentle, natural en voice for the browser speechSynthesis fallback.
function pickSoftVoice() {
  const vs = window.speechSynthesis?.getVoices?.() || [];
  const find = (re) => vs.find((v) => re.test(v.name));
  return find(/Samantha|Karen|Moira|Tessa|Serena|Allison|Ava|Fiona/i)
    || find(/Google UK English Female|Google US English|Microsoft Aria|Microsoft Jenny/i)
    || vs.find((v) => /^en/i.test(v.lang) && /female/i.test(v.name))
    || vs.find((v) => /^en/i.test(v.lang))
    || null;
}

// ---- speaker: NeMo TTS via backend, else browser speechSynthesis -----------
function useSpeaker(settings) {
  const [speaking, setSpeaking] = useState(false);
  const queueRef = useRef([]); const audioRef = useRef(null); const doneRef = useRef(null);
  const stop = useCallback(() => { queueRef.current = []; doneRef.current = null; try { audioRef.current?.pause(); } catch (e) {} try { window.speechSynthesis?.cancel(); } catch (e) {} setSpeaking(false); }, []);
  const playNext = useCallback(async () => {
    const q = queueRef.current; if (!q.length) { setSpeaking(false); const d = doneRef.current; doneRef.current = null; if (d) d(); return; }
    setSpeaking(true); const text = q.shift(); const base = settings.backendUrl || "/api";
    if (base) { try {
      const res = await fetch(`${base.replace(/\/$/, "")}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const blob = await res.blob(); const a = new Audio(URL.createObjectURL(blob)); audioRef.current = a;
      a.onended = () => playNext(); a.onerror = () => playNext(); await a.play(); return;
    } catch (e) {} }
    if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(text); const v = pickSoftVoice(); if (v) u.voice = v; u.rate = 0.94; u.pitch = 0.88; u.volume = 0.92; u.onend = () => playNext(); u.onerror = () => playNext(); window.speechSynthesis.speak(u); }
    else playNext();
  }, [settings.backendUrl]);
  const speak = useCallback((text, onDone) => {
    if (!settings.voice || !text) { onDone?.(); return; }
    doneRef.current = onDone || null;
    queueRef.current = (text.match(/[^.!?]+[.!?]*\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);
    if (!speaking) playNext();
  }, [settings.voice, speaking, playNext]);
  useEffect(() => () => stop(), [stop]);
  return { speak, stop, speaking };
}

// ---- chat: backend orchestrator if configured, else Claude direct ----------
async function chatTurn({ settings, message, history, system }) {
  const base = settings.backendUrl;
  // A backend is configured: it owns the model. If it's down or erroring,
  // surface that instead of silently falling back — the caller shows the error.
  if (base && settings.patientId) {
    let res;
    try {
      res = await fetch(`${base.replace(/\/$/, "")}/patients/${settings.patientId}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
    } catch (e) {
      throw new Error("Can't reach the backend — make sure it's running.");
    }
    if (!res.ok) {
      let detail = ""; try { detail = (await res.json())?.detail || ""; } catch (e) {}
      throw new Error(`Backend error ${res.status}${detail ? ` — ${detail}` : ""}.`);
    }
    const j = await res.json();
    if (!j.reply) throw new Error("The model returned an empty reply.");
    return { reply: j.reply, learned: j.learned || [] };
  }
  // No backend configured → direct-to-Claude demo path (key from Settings).
  const api = history.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
  api.push({ role: "user", content: message });
  const reply = await callClaude({ apiKey: settings.apiKey, system, messages: api });
  return { reply, learned: [] };
}

// ---- voice → daily-log fields. Server-side via the backend (no key in the
// browser; avoids the CORS "Failed to fetch"); direct-Claude only as a demo
// fallback when a key is set and the backend can't be reached. -----------------
const EXTRACT_SYS = `You are Myno, a warm voice companion helping someone log their PCOS day by talking. From the WHOLE conversation and what they just said: (1) "say" — reply briefly and directly: note what you heard in a few words and move on, warm but matter-of-fact (skip heavy empathy, reassurance, exclamations); INFER ratings/severities yourself and never ask for numbers or 1-to-10 ratings; ask a short clarifying question only when genuinely needed (never about numbers), else just acknowledge (spoken, under ~25 words, never diagnose); (2) "categories" — a small evolving set (max 6) of what THIS person actually talks about, in THEIR words, e.g. {"key":"brain_fog","label":"Brain fog","value":"heavy this morning"}; reuse stable lower_snake_case keys, add new ones they raise, build on the categories given. When a category is naturally a rating/severity/amount, ALSO include "scale":{"value":int,"max":10} where value is 0-10; KEEP a user-set scale value unless they clearly change it; omit scale for qualitative ones; (3) the standard tracking fields ONLY when clearly implied. ONLY JSON: {"period":true|false|null,"flow":"none|spotting|light|medium|heavy"|null,"birthControl":str|null,"pain":0-10|null,"mood":0-10|null,"energy":0-10|null,"sleep":0-10|null,"brainFog":0-10|null,"sexDrive":0-10|null,"sugar":0-10|null,"foodDrive":0-10|null,"dietExercise":str|null,"painMap":str|null,"morningWeight":number|null,"hairGrowth":bool,"hairLoss":bool,"acne":bool,"skinPatches":bool,"hyperpigmentation":bool,"bloating":bool,"cravings":bool,"diagnoses":str|null,"categories":[{"key":str,"label":str,"value":str,"scale":{"value":int,"max":10}}],"say":str}. null/false for fields not mentioned; omit scale where it doesn't fit.`;
// Selectable conversation personalities (only the spoken-reply tone changes).
const PERSONALITIES = [["direct", "Direct", "Brief and to the point"], ["warm", "Warm", "Gentle and caring"], ["coach", "Coach", "Encouraging, action-first"], ["clinical", "Clinical", "Calm and factual"], ["friend", "Friend", "Casual and relatable"]];
const PSTYLE = {
  direct: "Be brief and matter-of-fact; skip heavy empathy, reassurance and exclamations.",
  warm: "Be gentle and empathetic; acknowledge how they feel in a caring way, then move on.",
  coach: "Be encouraging and action-oriented; affirm their effort and nudge one small step.",
  clinical: "Be precise and neutral like a calm clinician; factual, no emotional language.",
  friend: "Be casual and conversational like a supportive friend; relaxed and relatable.",
};
const pstyle = (p) => PSTYLE[p] || PSTYLE.direct;
const SCALE_MAX = 10;
const scaleLabels = {
  pain: ["none", "moderate", "extreme"],
  mood: ["very low", "mixed", "very good"],
  energy: ["depleted", "moderate", "very high"],
  sleep: ["awful", "moderate", "great"],
  brainFog: ["none", "moderate", "severe"],
  sexDrive: ["none", "moderate", "very high"],
  sugar: ["none", "moderate", "extreme"],
  foodDrive: ["none", "moderate", "intense"],
};
const clampScale = (value, fallback = 0, max = SCALE_MAX) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.round(n)));
};
const scaleDisplay = (value, max = SCALE_MAX, words = null) => {
  const v = clampScale(value, 0, max);
  if (Array.isArray(words) && words.length === max + 1 && words[v]) return `${v}/${max} ${words[v]}`;
  if (Array.isArray(words) && words.length >= 3) {
    const i = v <= Math.floor(max / 3) ? 0 : v >= Math.ceil((max * 2) / 3) ? 2 : 1;
    return `${v}/${max} ${words[i]}`;
  }
  return `${v}/${max}`;
};
const normalizedScale = (scale) => {
  if (!scale || typeof scale.value !== "number") return null;
  const oldMax = Number(scale.max) > 0 ? Number(scale.max) : SCALE_MAX;
  const value = oldMax === SCALE_MAX ? scale.value : Math.round((scale.value / oldMax) * SCALE_MAX);
  return { ...scale, value: clampScale(value), max: SCALE_MAX };
};
const normalizedCategory = (cat) => {
  const scale = normalizedScale(cat.scale);
  if (!scale) {
    const { scale: _scale, ...rest } = cat;
    return rest;
  }
  return { ...cat, scale };
};

// The saved daily log is JSON shaped by this schema. Speech fills what it can;
// the rest is filled in the "End conversation" sheet. Users can also add their
// own free-form categories on top (entry.categories).
const LOG_SCHEMA = [
  { group: "Period tracker", fields: [
    { key: "period", label: "Started your period?", type: "bool" },
    { key: "flow", label: "Flow", type: "select", options: ["none", "spotting", "light", "medium", "heavy"] },
    { key: "birthControl", label: "Birth control", type: "text", placeholder: "pill, IUD, none…" },
  ] },
  { group: "Wellbeing", fields: [
    { key: "mood", label: "Mood", type: "scale", max: SCALE_MAX, words: scaleLabels.mood },
    { key: "energy", label: "Energy", type: "scale", max: SCALE_MAX, words: scaleLabels.energy },
    { key: "sleep", label: "Sleep", type: "scale", max: SCALE_MAX, words: scaleLabels.sleep },
    { key: "brainFog", label: "Brain fog", type: "scale", max: SCALE_MAX, words: scaleLabels.brainFog },
    { key: "sexDrive", label: "Sex drive", type: "scale", max: SCALE_MAX, words: scaleLabels.sexDrive },
  ] },
  { group: "Body", fields: [
    { key: "pain", label: "Pain", type: "scale", max: SCALE_MAX, words: scaleLabels.pain },
    { key: "painMap", label: "Where it hurts", type: "text", placeholder: "lower back, pelvis…" },
    { key: "morningWeight", label: "Morning weight (kg)", type: "number", placeholder: "kg" },
    { key: "cravings", label: "Cravings", type: "bool" },
    { key: "sugar", label: "Sugar / cravings", type: "scale", max: SCALE_MAX, words: scaleLabels.sugar },
    { key: "foodDrive", label: "Food drive", type: "scale", max: SCALE_MAX, words: scaleLabels.foodDrive },
    { key: "dietExercise", label: "Diet & exercise", type: "text", placeholder: "from Health app or notes" },
  ] },
  { group: "Skin & hair", fields: [
    { key: "acne", label: "Acne (new breakouts)", type: "bool" },
    { key: "hairGrowth", label: "Hair growth", type: "bool" },
    { key: "hairLoss", label: "Hair loss", type: "bool" },
    { key: "skinPatches", label: "Skin patches", type: "bool" },
    { key: "hyperpigmentation", label: "Hyperpigmentation", type: "bool" },
  ] },
  { group: "About you", fields: [
    { key: "diagnoses", label: "Existing diagnoses", type: "text", placeholder: "PCOS, thyroid… (optional)" },
  ] },
];
const SCHEMA_DEFAULTS = { pain: 0, mood: 5, energy: 5, sugar: 5, flow: null, birthControl: "", sleep: 5, brainFog: 0, sexDrive: 5, painMap: "", morningWeight: null, foodDrive: 5, dietExercise: "", acne: false, skinPatches: false, hyperpigmentation: false, diagnoses: "" };
async function extractFields({ settings, text, context = "", blocked = [], categories = [], personality = "direct" }) {
  const base = (settings.backendUrl || "/api").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, context, blocked, categories, personality }) });
    if (res.ok) return await res.json();
    throw new Error(`extract ${res.status}`);
  } catch (e) {
    if (settings.apiKey) {
      const ctx = context ? `Conversation so far: ${context}\n` : "";
      const out = await callClaude({ apiKey: settings.apiKey, maxTokens: 500, messages: [{ role: "user", content: `${EXTRACT_SYS}\nTone for "say": ${pstyle(personality)}\n\n${ctx}Current categories: ${JSON.stringify(categories)}\n\nThey just said: "${text}"` }] });
      return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    }
    throw e;
  }
}

// ---- live insights: blend tracked history with the running conversation -------
const ADVISE_SYS = `You are Myno, a warm, practical PCOS companion. Combine the person's tracked history (history_summary) with what they're telling you now to surface ONE clear insight — a trend or correlation grounded in THEIR data — plus brief, actionable, non-diagnostic advice. Never diagnose or give drug doses. ONLY JSON: {"headline":str (<=8 words), "correlations":[{"label":str,"strength":0-100}] (0-3), "say":str (<=45 words of warm advice)}.`;
async function extractAdvise({ settings, note, categories = [], summary = {}, blocked = [], personality = "direct" }) {
  const base = (settings.backendUrl || "/api").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/advise`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note, categories, summary, blocked, personality }) });
    if (res.ok) return await res.json();
    throw new Error(`advise ${res.status}`);
  } catch (e) {
    if (settings.apiKey) {
      const out = await callClaude({ apiKey: settings.apiKey, maxTokens: 500, messages: [{ role: "user", content: `${ADVISE_SYS}\n\n${JSON.stringify({ today_conversation: note, categories, history_summary: summary })}` }] });
      return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    }
    throw e;
  }
}

// ---- voice capture: NeMo streaming WS, else Web Speech ---------------------
class VoiceController {
  constructor({ endpoint, onPartial, onFinal, onState, onError, continuous, silenceMs }) {
    this.endpoint = endpoint; this.onPartial = onPartial; this.onFinal = onFinal; this.onState = onState; this.onError = onError;
    this.continuous = !!continuous; this.silenceMs = silenceMs || 2500;
    this.mode = endpoint ? "nemo" : ((window.SpeechRecognition || window.webkitSpeechRecognition) ? "webspeech" : "none");
  }
  available() { return this.mode !== "none"; }
  async start() { if (this.mode === "nemo") return this._nemo(); if (this.mode === "webspeech") return this._web(); this.onError?.("Voice isn't available here — please type."); }
  stop() { if (this.mode === "nemo") this._stopNemo(); else if (this.mode === "webspeech") { this.active = false; clearTimeout(this.silTimer); try { this.rec?.stop(); } catch (e) {} } this.onState?.(false); }
  // Browser Web Speech. Patient on both ends: waits indefinitely for you to
  // start, and tolerates long mid-sentence pauses — it only commits the turn
  // after `silenceMs` of real silence, so it never cuts you off too early.
  _web() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.active = true; this.finalText = ""; this._started = false;
    const commit = () => {
      clearTimeout(this.silTimer);
      const t = (this.finalText || "").trim();
      if (!t) return;                       // nothing said yet → keep waiting patiently
      this.finalText = "";
      this.onFinal?.(t);
      if (!this.continuous) { this.active = false; try { this.rec?.stop(); } catch (e) {} }
    };
    // Only commit a turn after real silence FOLLOWING actual speech — armed by
    // final segments, not every interim flicker, so turns are consistent.
    const arm = () => { clearTimeout(this.silTimer); this.silTimer = setTimeout(commit, this.silenceMs); };
    const build = () => {
      const rec = new SR();
      rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
      rec.onstart = () => { if (!this._started) { this._started = true; this.onState?.(true); } };  // fire once; survive internal restarts
      rec.onerror = (ev) => { if (ev.error === "not-allowed" || ev.error === "service-not-allowed") { this.active = false; clearTimeout(this.silTimer); this.onState?.(false); this.onError?.("Microphone blocked — type instead."); } };
      rec.onend = () => { if (this.active) { try { build(); } catch (e) { setTimeout(() => { if (this.active) build(); }, 300); } } else { this._started = false; this.onState?.(false); } };
      rec.onresult = (ev) => {
        let interim = "", gotFinal = false;
        for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) { this.finalText += r[0].transcript + " "; gotFinal = true; } else interim += r[0].transcript; }
        this.onPartial?.((this.finalText + interim).trim());
        if (gotFinal) arm();                // start the silence countdown only once a phrase is finalized
        else clearTimeout(this.silTimer);   // still mid-utterance → don't count silence yet
      };
      this.rec = rec; try { rec.start(); } catch (e) {}
    };
    build();
  }
  async _nemo() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } }); this.stream = stream;
      const ws = new WebSocket(this.endpoint); ws.binaryType = "arraybuffer"; this.ws = ws;
      ws.onopen = () => this.onState?.(true);
      ws.onerror = () => this.onError?.("Couldn't reach the ASR server — check Settings.");
      ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.type === "partial") this.onPartial?.(m.text); else if (m.type === "final") this.onFinal?.(m.text); } catch (err) {} };
      const ctx = new (window.AudioContext || window.webkitAudioContext)(); this.ctx = ctx;
      const src = ctx.createMediaStreamSource(stream); const node = ctx.createScriptProcessor(4096, 1, 1); this.node = node;
      const ratio = ctx.sampleRate / 16000;
      node.onaudioprocess = (ev) => { if (ws.readyState !== 1) return; const input = ev.inputBuffer.getChannelData(0); const out = new Int16Array(Math.floor(input.length / ratio)); for (let i = 0; i < out.length; i++) { const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } ws.send(out.buffer); };
      src.connect(node); node.connect(ctx.destination);
    } catch (e) { this.onState?.(false); this.onError?.("Microphone access was blocked — you can type instead."); }
  }
  _stopNemo() { try { this.ws?.send(JSON.stringify({ type: "end" })); } catch (e) {} try { this.node?.disconnect(); } catch (e) {} try { this.ctx?.close(); } catch (e) {} try { this.stream?.getTracks().forEach((t) => t.stop()); } catch (e) {} setTimeout(() => { try { this.ws?.close(); } catch (e) {} }, 300); }
}
function useVoice({ settings, onPartial, onFinal, continuous, silenceMs }) {
  const [listening, setListening] = useState(false); const [note, setNote] = useState(""); const ref = useRef(null); const onRef = useRef(false);
  const setL = (v) => { onRef.current = v; setListening(v); };
  const start = useCallback(() => {
    if (onRef.current) return; setNote("");
    const c = new VoiceController({ endpoint: settings.nemoEndpoint || null, onPartial, onFinal, onState: setL, onError: setNote, continuous, silenceMs });
    ref.current = c; if (!c.available()) { setNote("Voice isn't available here — please type."); return; } c.start();
  }, [settings.nemoEndpoint, onPartial, onFinal, continuous, silenceMs]);
  const stop = useCallback(() => { ref.current?.stop(); }, []);
  const toggle = useCallback(() => { if (onRef.current) stop(); else start(); }, [start, stop]);
  useEffect(() => () => { try { ref.current?.stop(); } catch (e) {} }, []);
  return { listening, note, toggle, start, stop };
}

// ---- synthetic data + insights + scoring (carried over) --------------------
function genSyntheticLogs() {
  const logs = [], today = new Date(); const cyc = () => 38 + Math.floor(Math.random() * 8); let since = 3, cur = cyc();
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i); const date = d.toISOString().slice(0, 10);
    const sugar = Math.floor(Math.random() * 11); const prev = logs.length ? logs[logs.length - 1].sugar : 0; const isP = since === 0;
    let pain = 1 + Math.round(Math.random()); if (isP || since === 1) pain += 4; pain += Math.round(prev * 0.9); pain = Math.max(0, Math.min(10, pain));
    const pre = since > cur - 3; const mood = Math.max(0, Math.min(10, 7 - (pre ? 4 : 0) - (pain > 6 ? 2 : 0) + Math.round((Math.random() - 0.5) * 2)));
    const energy = Math.max(0, Math.min(10, 7 - (pain > 6 ? 2 : 0) + Math.round((Math.random() - 0.5) * 2)));
    logs.push({ date, period: isP, pain, sugar, mood, energy, hairGrowth: Math.random() < 0.28, hairLoss: Math.random() < 0.14, bloating: pain > 5 || Math.random() < 0.2, cravings: prev > 6 || Math.random() < 0.2, note: "" });
    since++; if (since >= cur) { since = 0; cur = cyc(); }
  }
  return logs;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function computeInsights(logs) {
  const periods = logs.filter((l) => l.period).map((l) => l.date); const gaps = [];
  for (let i = 1; i < periods.length; i++) gaps.push(Math.round((new Date(periods[i]) - new Date(periods[i - 1])) / 86400000));
  const avgGap = gaps.length ? Math.round(mean(gaps)) : null;
  const hiNext = [], loNext = []; for (let i = 1; i < logs.length; i++) (logs[i - 1].sugar >= 7 ? hiNext : loNext).push(logs[i].pain);
  const painHi = mean(hiNext), painLo = mean(loNext);
  const bloatPain = mean(logs.filter((l) => l.bloating).map((l) => l.pain)); const noBloatPain = mean(logs.filter((l) => !l.bloating).map((l) => l.pain));
  const last = logs[logs.length - 1]; let lastP = null; for (let i = logs.length - 1; i >= 0; i--) if (logs[i].period) { lastP = logs[i].date; break; }
  const dayN = lastP ? Math.round((new Date(last.date) - new Date(lastP)) / 86400000) : null;
  let highPainGap = 0; for (let i = logs.length - 1; i >= 0; i--) { if (logs[i].pain >= 7) break; highPainGap++; }
  return { avgGap, minGap: gaps.length ? Math.min(...gaps) : null, maxGap: gaps.length ? Math.max(...gaps) : null, gaps,
    painHi, painLo, bloatPain, noBloatPain, hairGrowthRate: mean(logs.map((l) => l.hairGrowth ? 1 : 0)), hairLossRate: mean(logs.map((l) => l.hairLoss ? 1 : 0)),
    avgPain: mean(logs.map((l) => l.pain)), avgMood: mean(logs.map((l) => l.mood)), periodsLogged: periods.length, dayN, highPainGap, loggedDays: logs.length };
}
const W = { irregularCycle: 1.7, longCycle: 0.9, mfgHigh: 1.6, selfHirsutism: 0.6, acne: 0.5, alopecia: 0.5, acanthosis: 0.8, highBMI: 0.7, familyHistory: 0.5, weightGain: 0.4, earlyMenarche: 0.3 };
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
function buildFlags(p, ins) {
  const bmi = p.heightCm && p.weightKg ? p.weightKg / Math.pow(p.heightCm / 100, 2) : null;
  return { bmi, irregularCycle: ins.avgGap != null && (ins.avgGap > 35 || (ins.maxGap - ins.minGap) > 12), longCycle: ins.avgGap != null && ins.avgGap > 35, absentCycle: ins.avgGap != null && ins.avgGap > 60,
    mfgHigh: ins.hairGrowthRate > 0.3, selfHirsutism: ins.hairGrowthRate > 0.12, acne: !!p.acne, alopecia: ins.hairLossRate > 0.1, acanthosis: !!p.skinDarkening,
    highBMI: bmi != null && bmi >= 30, familyHistory: !!p.familyHistory, weightGain: !!p.weightGain, earlyMenarche: p.menarcheAge && Number(p.menarcheAge) < 11, mfg: Math.round(ins.hairGrowthRate * 22) };
}
function riskScore(f) { let z = -2.4; if (f.irregularCycle) z += W.irregularCycle; if (f.longCycle) z += W.longCycle; if (f.mfgHigh) z += W.mfgHigh; else if (f.selfHirsutism) z += W.selfHirsutism; if (f.acne) z += W.acne; if (f.alopecia) z += W.alopecia; if (f.acanthosis) z += W.acanthosis; if (f.highBMI) z += W.highBMI; if (f.familyHistory) z += W.familyHistory; if (f.weightGain) z += W.weightGain; if (f.earlyMenarche) z += W.earlyMenarche; return sigmoid(z); }
const LO = 0.30, HI = 0.62;
function conformal(s) { if (s < LO) return { band: "low", abstain: false }; if (s > HI) return { band: "elevated", abstain: false }; return { band: "uncertain", abstain: true }; }
function rotterdam(f) { return {
  ovulatory: { met: f.irregularCycle || f.longCycle, note: f.absentCycle ? "Periods often absent" : f.longCycle ? "Long, irregular cycles" : "Cycles regular" },
  androgen: { met: f.mfgHigh || f.selfHirsutism || f.acne || f.alopecia, note: f.mfgHigh ? "Excess hair noted often" : (f.selfHirsutism || f.acne || f.alopecia) ? "Some androgen signs" : "None evident" },
  morphology: { met: null, note: "Ultrasound only — not assessable in-app" } }; }

// ---- UI atoms --------------------------------------------------------------
const Card = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{ background: C.surface, borderRadius: 20, padding: 20, boxShadow: SH_SM, ...style }}>{children}</div>
);
const Label = ({ children, color = C.teal }) => (
  <div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color }}>{children}</div>
);
const H = ({ children, size = 26, style }) => (
  <h1 style={{ fontFamily: head, fontWeight: 700, fontSize: size, lineHeight: 1.12, letterSpacing: "-0.01em", margin: 0, color: C.ink, ...style }}>{children}</h1>
);
function Pill({ children, onClick, variant = "filled", disabled, style }) {
  const v = { filled: { background: C.teal, color: "#fff", border: "none" },
    outline: { background: C.surface, color: C.teal, border: `1.5px solid ${C.teal}` },
    soft: { background: C.low, color: C.inkVar, border: "none" },
    rose: { background: C.roseFixed, color: C.roseOn, border: "none" } }[variant];
  return (<button onClick={onClick} disabled={disabled} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 15, padding: "13px 22px", borderRadius: 9999,
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, minHeight: 48, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, ...v, ...style }}>{children}</button>);
}
function Chip({ children, active, onClick, icon: Ico }) {
  return (<button onClick={onClick} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, padding: "9px 16px", borderRadius: 9999, cursor: "pointer",
    display: "inline-flex", alignItems: "center", gap: 7, transition: "all .15s",
    background: active ? C.rose : C.surface, color: active ? C.roseOn : C.inkVar, border: `1.5px solid ${active ? C.rose : C.outlineVar}` }}>
    {Ico && <Ico size={15} />} {children}</button>);
}
function LeafMark({ size = 34 }) {
  return (<span style={{ width: size, height: size, borderRadius: "50%", background: C.teal, display: "grid", placeItems: "center", flexShrink: 0 }}><Leaf size={size * 0.5} color="#fff" /></span>);
}
const Field = ({ label, children }) => (
  <label style={{ display: "block" }}><div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", color: C.inkVar, marginBottom: 6, textTransform: "uppercase" }}>{label}</div>{children}</label>
);
const input = { width: "100%", padding: "13px 15px", borderRadius: 12, border: `1.5px solid ${C.outlineVar}`, fontFamily: bodyf, fontSize: 16, color: C.ink, background: C.surface, outline: "none" };
function Slider({ value, max, onChange }) {
  const pct = (value / max) * 100;
  return (<input type="range" className="slider" min={0} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))}
    style={{ background: `linear-gradient(90deg, ${C.teal} ${pct}%, ${C.high} ${pct}%)` }} />);
}

// ---- Rotterdam triad (Prepare/Clinician) -----------------------------------
function Triad({ axes }) {
  const s = 220, r = 54, cx = s / 2; const p1 = { x: cx, y: s * 0.36 }, p2 = { x: cx - r * 0.78, y: s * 0.6 }, p3 = { x: cx + r * 0.78, y: s * 0.6 };
  const circ = (p, met, locked) => (<circle cx={p.x} cy={p.y} r={r} fill={locked ? "rgba(112,121,121,0.05)" : met ? "rgba(201,138,147,0.22)" : "rgba(54,99,102,0.07)"} stroke={locked ? C.outline : met ? C.roseDeep : C.tealC} strokeWidth={met ? 2.5 : 1.5} strokeDasharray={locked ? "5 5" : "none"} />);
  return (<svg viewBox={`0 0 ${s} ${s}`} width="100%" style={{ maxWidth: 240 }}>
    {circ(p1, axes.ovulatory.met)}{circ(p2, axes.androgen.met)}{circ(p3, axes.morphology.met, true)}
    <text x={p1.x} y={p1.y - r * 0.3} textAnchor="middle" style={{ fontFamily: bodyf, fontSize: 9, fontWeight: 600, fill: C.ink }}>OVULATION</text>
    <text x={p2.x} y={p2.y + r * 0.5} textAnchor="middle" style={{ fontFamily: bodyf, fontSize: 9, fontWeight: 600, fill: C.ink }}>ANDROGEN</text>
    <text x={p3.x} y={p3.y + r * 0.42} textAnchor="middle" style={{ fontFamily: bodyf, fontSize: 9, fontWeight: 600, fill: C.outline }}>MORPHOLOGY</text>
    <Lock x={p3.x - 6} y={p3.y + r * 0.52} width={12} height={12} color={C.outline} />
  </svg>);
}

// ============================================================================
//  APP
// ============================================================================
const BLANK = { onboarded: false, name: "", age: "", menarcheAge: "", heightCm: "", weightKg: "", familyHistory: false, acne: false, skinDarkening: false, weightGain: false, goals: [], integrations: [] };

function useViewport() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  return w;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("home");
  const [profile, setProfile] = useState(BLANK);
  const [logs, setLogs] = useState([]);
  const [settings, setSettings] = useState({ apiKey: "", nemoEndpoint: "", backendUrl: "", voice: true, blacklist: [], patientId: null, personality: "direct" });
  const vw = useViewport();
  const wide = vw >= 1024;

  useEffect(() => { (async () => {
    const s = await loadState();
    const profile0 = s?.profile || BLANK;
    const settings0 = { apiKey: "", nemoEndpoint: "", backendUrl: "", voice: true, blacklist: [], patientId: null, personality: "direct", ...(s?.settings || {}) };
    setProfile(profile0); setSettings(settings0);
    // DB-backed logs: provision a patient, seed realistic history, load it.
    const base = (settings0.backendUrl || "/api").replace(/\/$/, "");
    let dbLogs = null, pid = settings0.patientId;
    try {
      if (!pid) { const r = await fetch(`${base}/patients`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: profile0.name || "" }) }); if (r.ok) pid = (await r.json()).id; }
      if (pid) {
        await fetch(`${base}/patients/${pid}/seed`, { method: "POST" }).catch(() => {});
        const lr = await fetch(`${base}/patients/${pid}/logs`);
        if (lr.ok) { const arr = await lr.json(); if (Array.isArray(arr) && arr.length) dbLogs = arr; }
        setSettings((p) => ({ ...p, patientId: pid }));
      }
    } catch (e) { /* backend unreachable → fall back to local synthetic data */ }
    setLogs(dbLogs || (s?.logs?.length ? s.logs : genSyntheticLogs()));
    setReady(true);
  })(); }, []);
  useEffect(() => { if (ready) saveState({ profile, logs, settings }); }, [profile, logs, settings, ready]);

  const ins = useMemo(() => computeInsights(logs), [logs]);
  const flags = useMemo(() => buildFlags(profile, ins), [profile, ins]);
  const score = useMemo(() => riskScore(flags), [flags]);
  const decision = useMemo(() => conformal(score), [score]);
  const axes = useMemo(() => rotterdam(flags), [flags]);
  const ctx = { profile, setProfile, logs, setLogs, settings, setSettings, ins, flags, score, decision, axes, setTab, wide };

  const screen = () => (<>
    {tab === "home" && <HomeScreen {...ctx} />}
    {tab === "record" && <RecordScreen {...ctx} />}
    {tab === "insights" && <InsightsScreen {...ctx} />}
    {tab === "chat" && <ChatScreen {...ctx} />}
    {tab === "settings" && <SettingsScreen {...ctx} />}
    {(tab === "advocacy" || tab === "prepare" || tab === "clinician") && <AdvocacyScreen {...ctx} />}
  </>);

  // --- mobile shell (centered phone column + bottom nav) ---
  const mobileShell = (children, pad = true) => (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: bodyf, color: C.ink, display: "flex", justifyContent: "center" }}>
      <style>{FONTS}</style>
      <div style={{ width: "100%", maxWidth: 460, minHeight: "100vh", position: "relative", paddingBottom: pad ? 96 : 0, background: GRAD }}>{children}</div>
    </div>);

  if (!ready) return mobileShell(<div style={{ display: "grid", placeItems: "center", height: "100vh" }}><Loader2 className="spin" color={C.teal} /></div>, false);
  if (!profile.onboarded) return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: bodyf, color: C.ink, display: "flex", justifyContent: "center", backgroundImage: GRAD }}>
      <style>{FONTS}</style>
      <div style={{ width: "100%", maxWidth: 560 }}><Onboarding profile={profile} setProfile={setProfile} /></div>
    </div>);

  const contentMax = { home: 1140, insights: 1140, advocacy: 900, clinician: 940, prepare: 880, chat: 1100, record: 1180, settings: 640 }[tab] || 1080;
  // --- desktop / web shell (top navigation bar + wide content — the website view) ---
  if (wide) return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: bodyf, color: C.ink, backgroundImage: GRAD }}>
      <style>{FONTS}</style>
      <TopNav tab={tab} setTab={setTab} profile={profile} />
      <main style={{ maxWidth: contentMax, margin: "0 auto", padding: "32px 40px 64px", animation: "rise .25s ease" }} key={tab}>{screen()}</main>
    </div>);

  // --- mobile ---
  return mobileShell(<>
    <Header profile={profile} onSettings={() => setTab("settings")} />
    <div style={{ padding: "0 20px", animation: "rise .25s ease" }} key={tab}>{screen()}</div>
    <BottomNav tab={tab} setTab={setTab} />
  </>);
}

// ---- desktop top navigation (website view) ---------------------------------
function TopNav({ tab, setTab, profile }) {
  const items = [["home", "Home"], ["record", "Record"], ["insights", "Insights"], ["chat", "Chat"], ["advocacy", "Advocacy"]];
  return (
    <header style={{ position: "sticky", top: 0, zIndex: 20, background: "rgba(251,249,248,0.9)", backdropFilter: "blur(10px)", borderBottom: `1px solid ${C.high}` }}>
      <div style={{ maxWidth: 1140, margin: "0 auto", padding: "12px 40px", display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => setTab("home")} style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", cursor: "pointer", marginRight: 18 }}>
          <LeafMark size={32} /><span style={{ fontFamily: head, fontWeight: 800, fontSize: 22, color: C.teal, letterSpacing: "-0.01em" }}>Myno</span>
        </button>
        <nav style={{ display: "flex", gap: 2 }}>
          {items.map(([id, label]) => { const on = tab === id; return (
            <button key={id} onClick={() => setTab(id)} style={{ fontFamily: bodyf, fontSize: 15, fontWeight: on ? 600 : 500, padding: "9px 16px", borderRadius: 9999, cursor: "pointer", border: "none",
              background: on ? C.tealFixed : "transparent", color: on ? C.tealDark : C.inkVar }}>{label}</button>); })}
        </nav>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setTab("settings")} style={{ background: "none", border: "none", cursor: "pointer", color: tab === "settings" ? C.teal : C.inkVar, display: "grid", placeItems: "center" }}><Cog size={22} /></button>
          <span style={{ width: 34, height: 34, borderRadius: "50%", background: C.tealFixed, color: C.tealDark, display: "grid", placeItems: "center", fontFamily: head, fontWeight: 700, fontSize: 15 }}>{(profile.name || "Y")[0].toUpperCase()}</span>
        </div>
      </div>
    </header>);
}

// ---- header + bottom nav ---------------------------------------------------
function Header({ profile, onSettings }) {
  return (<div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px 10px" }}>
    <LeafMark size={32} />
    <span style={{ fontFamily: head, fontWeight: 800, fontSize: 22, color: C.teal, letterSpacing: "-0.01em" }}>Myno</span>
    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
      <button onClick={onSettings} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkVar, display: "grid", placeItems: "center" }}><Cog size={22} /></button>
      <span style={{ width: 34, height: 34, borderRadius: "50%", background: C.tealFixed, color: C.tealDark, display: "grid", placeItems: "center", fontFamily: head, fontWeight: 700, fontSize: 15 }}>{(profile.name || "Y")[0].toUpperCase()}</span>
    </div>
  </div>);
}
function BottomNav({ tab, setTab }) {
  const items = [["home", "Home", Home], ["record", "Record", SquarePen], ["insights", "Insights", BarChart3], ["chat", "Chat", MessageCircle], ["settings", "Settings", Cog]];
  return (<div className="no-print" style={{ position: "fixed", bottom: 0, left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
    <div style={{ width: "100%", maxWidth: 460, background: "rgba(251,249,248,0.94)", backdropFilter: "blur(10px)", borderTop: `1px solid ${C.high}`, display: "flex", padding: "8px 6px 10px", pointerEvents: "auto" }}>
      {items.map(([id, label, Ico]) => { const on = tab === id; return (
        <button key={id} onClick={() => setTab(id)} style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <span style={{ padding: "5px 16px", borderRadius: 9999, background: on ? C.tealFixed : "transparent", display: "grid", placeItems: "center", transition: "all .15s" }}><Ico size={20} color={on ? C.tealDark : C.outline} /></span>
          <span style={{ fontFamily: bodyf, fontSize: 11, fontWeight: on ? 600 : 500, color: on ? C.teal : C.outline }}>{label}</span>
        </button>); })}
    </div>
  </div>);
}

// ---- onboarding ------------------------------------------------------------
function Onboarding({ profile, setProfile }) {
  const [step, setStep] = useState(0); const set = (k, v) => setProfile({ ...profile, [k]: v });
  const tog = (k, v) => set(k, profile[k].includes(v) ? profile[k].filter((x) => x !== v) : [...profile[k], v]);
  const GOALS = [["conceive", "Trying to conceive", Target], ["whatswrong", "Figure out what's wrong", Brain], ["manage", "Manage my symptoms", HeartPulse], ["prepare", "Prepare for an appointment", Stethoscope]];
  const APPS = ["Apple Health", "Google Fit", "Oura", "Fitbit", "Clue / Flo"];
  return (<div style={{ padding: "60px 24px", minHeight: "100vh" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 30 }}><LeafMark /><span style={{ fontFamily: head, fontWeight: 800, fontSize: 26, color: C.teal }}>Myno</span></div>
    <Card style={{ borderRadius: 24, padding: 24, boxShadow: SH }}>
      {step === 0 && (<><Label>Welcome</Label><H size={26} style={{ margin: "10px 0 8px" }}>Let's build your digital twin</H>
        <p style={{ color: C.inkVar, lineHeight: 1.5, marginBottom: 20 }}>Myno learns your patterns, helps you make sense of them, and gets you ready for the clinician. What brings you here?</p>
        <div style={{ display: "grid", gap: 10 }}>{GOALS.map(([id, l, Ico]) => { const on = profile.goals.includes(id); return (
          <button key={id} onClick={() => tog("goals", id)} style={{ textAlign: "left", padding: 16, borderRadius: 16, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, background: on ? C.tealFixed : C.low, border: `1.5px solid ${on ? C.teal : "transparent"}` }}>
            <Ico size={22} color={C.teal} /><span style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>{l}</span>{on && <Check size={18} color={C.teal} style={{ marginLeft: "auto" }} />}</button>); })}</div></>)}
      {step === 1 && (<><Label>About you</Label><H size={24} style={{ margin: "10px 0 18px" }}>The basics</H>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="First name"><input style={input} value={profile.name} onChange={(e) => set("name", e.target.value)} placeholder="optional" /></Field>
          <Field label="Age"><input style={input} type="number" value={profile.age} onChange={(e) => set("age", e.target.value)} /></Field>
          <Field label="Age at first period"><input style={input} type="number" value={profile.menarcheAge} onChange={(e) => set("menarcheAge", e.target.value)} placeholder="e.g. 13" /></Field>
          <Field label="Height (cm)"><input style={input} type="number" value={profile.heightCm} onChange={(e) => set("heightCm", e.target.value)} /></Field>
          <Field label="Weight (kg)"><input style={input} type="number" value={profile.weightKg} onChange={(e) => set("weightKg", e.target.value)} /></Field>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
          {[["familyHistory", "Family history"], ["acne", "Persistent acne"], ["skinDarkening", "Skin darkening"], ["weightGain", "Weight gain"]].map(([k, l]) => (
            <Chip key={k} active={profile[k]} onClick={() => set(k, !profile[k])}>{l}</Chip>))}</div></>)}
      {step === 2 && (<><Label>Connect your data</Label><H size={24} style={{ margin: "10px 0 8px" }}>Bring it together</H>
        <p style={{ color: C.inkVar, lineHeight: 1.5, marginBottom: 16 }}>Fold in cycles, sleep, and activity you already log (demo connections).</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{APPS.map((a) => (<Chip key={a} active={profile.integrations.includes(a)} onClick={() => tog("integrations", a)}>{a}</Chip>))}</div>
        <div style={{ marginTop: 16, padding: 14, background: C.tealFixed, borderRadius: 14, fontSize: 14, color: C.onTealFixed, lineHeight: 1.5 }}>We've pre-loaded three months of sample tracking so your twin has something to learn from right away.</div></>)}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
        <Pill variant="soft" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} style={{ padding: "13px 18px" }}><ArrowLeft size={16} /> Back</Pill>
        <Pill onClick={() => step < 2 ? setStep(step + 1) : set("onboarded", true)} disabled={step === 0 && profile.goals.length === 0}>{step < 2 ? "Continue" : "Enter Myno"} <ArrowRight size={16} /></Pill>
      </div>
    </Card>
  </div>);
}

// ---- HOME (dashboard) ------------------------------------------------------
function HomeScreen({ profile, logs, setLogs, ins, setTab, wide }) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = logs.find((l) => l.date === todayStr);
  const setPeriod = (v) => { const e = { date: todayStr, period: v, pain: today?.pain ?? 0, sugar: today?.sugar ?? 5, mood: today?.mood ?? 5, energy: today?.energy ?? 5, hairGrowth: today?.hairGrowth || false, hairLoss: today?.hairLoss || false, bloating: today?.bloating || false, cravings: today?.cravings || false, note: today?.note || "" }; setLogs([...logs.filter((l) => l.date !== todayStr), e].sort((a, b) => a.date.localeCompare(b.date))); };
  const now = new Date(); const phase = ins.dayN == null ? "—" : ins.dayN <= 5 ? "Menstrual" : ins.dayN <= 13 ? "Follicular" : ins.dayN <= 16 ? "Ovulatory" : "Luteal";
  const chips = []; if (today) { if (today.pain >= 6) chips.push("High pain"); else if (today.pain > 0) chips.push("Mild pain"); if (today.hairGrowth || today.hairLoss) chips.push("Hair health"); if (today.bloating) chips.push("Bloating"); if (today.cravings) chips.push("Cravings"); if (today.mood <= 3) chips.push("Low mood"); }

  const periodCard = (
    <Card style={{ borderRadius: 20, padding: 24, boxShadow: SH }}>
      <H size={22} style={{ textAlign: "center", marginBottom: 18 }}>Did you start your period today?</H>
      <div style={{ display: "flex", gap: 12 }}>
        <Pill variant={today?.period === true ? "filled" : "outline"} onClick={() => setPeriod(true)} style={{ flex: 1 }}>Yes</Pill>
        <Pill variant={today?.period === false ? "filled" : "outline"} onClick={() => setPeriod(false)} style={{ flex: 1, borderColor: today?.period === false ? "transparent" : C.outlineVar, color: today?.period === false ? "#fff" : C.inkVar }}>No</Pill>
      </div>
    </Card>);
  const calendarBlock = (
    <div>
      <Label>{now.toLocaleString(undefined, { month: "long", year: "numeric" })}</Label>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
        <H size={24}>Your Cycle</H>
        <button onClick={() => setTab("insights")} style={{ background: "none", border: "none", color: C.teal, fontFamily: bodyf, fontWeight: 600, fontSize: 14, cursor: "pointer", display: "inline-flex", gap: 3, alignItems: "center" }}>View history <ChevronRight size={15} /></button>
      </div>
      <Card style={{ marginTop: 12, padding: 16, background: C.low, boxShadow: "none" }}><CycleCalendar logs={logs} /></Card>
    </div>);
  const phaseTiles = (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div style={{ background: C.tealFixed, borderRadius: 18, padding: 18, minHeight: 120, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <Droplet size={22} color={C.tealDark} />
        <div><div style={{ fontFamily: head, fontWeight: 700, fontSize: 26, color: C.onTealFixed }}>{ins.dayN != null ? `Day ${ins.dayN}` : "—"}</div><div style={{ fontSize: 13, color: C.tealDark }}>{phase} phase</div></div>
      </div>
      <div style={{ background: C.highest, borderRadius: 18, padding: 18, minHeight: 120, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <Activity size={22} color={C.inkVar} />
        <div><div style={{ fontFamily: head, fontWeight: 700, fontSize: 26, color: C.ink }}>{ins.avgGap > 35 ? "Irregular" : "Stable"}</div><div style={{ fontSize: 13, color: C.inkVar }}>Cycle pattern</div></div>
      </div>
    </div>);
  const recordCTA = (
    <button onClick={() => setTab("record")} style={{ width: "100%", background: C.teal, color: "#fff", border: "none", borderRadius: 18, padding: "22px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: SH }}>
      <span style={{ fontFamily: head, fontWeight: 700, fontSize: 22 }}>Record your day</span>
      <span style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(255,255,255,0.18)", display: "grid", placeItems: "center" }}><Plus size={20} color="#fff" /></span>
    </button>);
  const trackedToday = chips.length > 0 && (
    <div><Label color={C.inkVar}>Tracked today</Label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>{chips.map((c) => (<span key={c} style={{ fontFamily: bodyf, fontSize: 13, fontWeight: 500, padding: "8px 14px", borderRadius: 9999, background: C.surface, border: `1px solid ${C.outlineVar}`, color: C.inkVar }}>{c}</span>))}</div></div>);
  const prepareCard = (
    <Card onClick={() => setTab("advocacy")} style={{ display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
      <span style={{ width: 42, height: 42, borderRadius: 12, background: C.rose, display: "grid", placeItems: "center", flexShrink: 0 }}><Stethoscope size={20} color={C.roseOn} /></span>
      <div style={{ flex: 1 }}><div style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>Prepare for your appointment</div><div style={{ fontSize: 13, color: C.inkVar }}>A clinician-ready summary from your tracking</div></div>
      <ChevronRight size={20} color={C.outline} />
    </Card>);

  if (wide) return (<div>
    <H size={30} style={{ marginBottom: 22 }}>{profile.name ? `Welcome back, ${profile.name}` : "Welcome back"}</H>
    <div style={{ display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 24, alignItems: "start" }}>
      <div style={{ display: "grid", gap: 20 }}>{periodCard}{calendarBlock}</div>
      <div style={{ display: "grid", gap: 18 }}>{phaseTiles}{recordCTA}{trackedToday}{prepareCard}</div>
    </div>
  </div>);

  return (<div>
    <div style={{ marginTop: 6 }}>{periodCard}</div>
    <div style={{ marginTop: 22 }}>{calendarBlock}</div>
    <div style={{ marginTop: 18 }}>{phaseTiles}</div>
    <div style={{ marginTop: 18 }}>{recordCTA}</div>
    {trackedToday && <div style={{ marginTop: 20 }}>{trackedToday}</div>}
    <div style={{ marginTop: 20 }}>{prepareCard}</div>
  </div>);
}
function CycleCalendar({ logs }) {
  const now = new Date(); const y = now.getFullYear(), m = now.getMonth(); const first = new Date(y, m, 1).getDay(); const days = new Date(y, m + 1, 0).getDate(); const todayD = now.getDate();
  const periodSet = new Set(logs.filter((l) => l.period).map((l) => { const d = new Date(l.date); return d.getFullYear() === y && d.getMonth() === m ? d.getDate() : null; }).filter(Boolean));
  const cells = []; for (let i = 0; i < first; i++) cells.push(null); for (let d = 1; d <= days; d++) cells.push(d);
  return (<div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, marginBottom: 6 }}>{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (<div key={i} style={{ textAlign: "center", fontFamily: bodyf, fontSize: 11, fontWeight: 600, color: C.outline }}>{d}</div>))}</div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>{cells.map((d, i) => {
      const isToday = d === todayD, isPeriod = periodSet.has(d);
      return (<div key={i} style={{ aspectRatio: "1", display: "grid", placeItems: "center" }}>
        {d && <span style={{ width: 34, height: 34, borderRadius: "50%", display: "grid", placeItems: "center", fontFamily: bodyf, fontSize: 14, fontWeight: isToday ? 700 : 500,
          background: isToday ? C.teal : isPeriod ? C.rose : "transparent", color: isToday ? "#fff" : isPeriod ? C.roseOn : C.ink }}>{d}</span>}
      </div>); })}</div>
  </div>);
}

// ---- RECORD (quiz / convo) -------------------------------------------------
function PersonalityPicker({ value, onChange }) {
  const [open, setOpen] = useState(false); const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const cur = PERSONALITIES.find(([k]) => k === (value || "direct")) || PERSONALITIES[0];
  return (<div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
    <button onClick={() => setOpen((o) => !o)} title="Myno's personality" style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, padding: "0 14px", height: 48, borderRadius: 9999, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8, background: C.surface, color: C.teal, border: `1.5px solid ${C.teal}` }}>
      <Sparkles size={15} /> {cur[1]} <ChevronRight size={15} style={{ transform: `rotate(${open ? -90 : 90}deg)`, transition: "transform .2s ease" }} />
    </button>
    {open && (<div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 40, background: C.surface, borderRadius: 16, boxShadow: SH, padding: 6, width: 220 }}>
      {PERSONALITIES.map(([k, lbl, desc]) => { const on = k === (value || "direct"); return (
        <button key={k} onClick={() => { onChange(k); setOpen(false); }} style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 10, textAlign: "left", padding: "10px 12px", borderRadius: 12, border: "none", cursor: "pointer", background: on ? C.tealFixed : "transparent" }}>
          <span><div style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 14, color: on ? C.onTealFixed : C.ink }}>{lbl}</div><div style={{ fontFamily: bodyf, fontSize: 12, color: on ? C.tealDark : C.inkVar }}>{desc}</div></span>
          {on && <Check size={16} color={C.teal} style={{ flexShrink: 0 }} />}
        </button>); })}
    </div>)}
  </div>);
}
function RecordScreen({ logs, setLogs, settings, setSettings, setTab, wide, ins }) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const existing = logs.find((l) => l.date === todayStr);
  const [e, setE] = useState(existing ? { ...SCHEMA_DEFAULTS, ...existing } : { date: todayStr, period: null, pain: 0, sugar: 5, mood: 5, energy: 5, hairGrowth: false, hairLoss: false, bloating: false, cravings: false, note: "", categories: [], ...SCHEMA_DEFAULTS });
  const eRef = useRef(e); useEffect(() => { eRef.current = e; }, [e]);
  const convoRef = useRef(false);  // hands-free intent: auto-resume the mic between turns
  const [saved, setSaved] = useState(false);
  const [partial, setPartial] = useState(""); const [busy, setBusy] = useState(false); const [text, setText] = useState(""); const [err, setErr] = useState("");
  const [reply, setReply] = useState(""); const speaker = useSpeaker(settings);
  const [flash, setFlash] = useState({}); const timers = useRef({});
  const [insOn, setInsOn] = useState(true); const [advice, setAdvice] = useState(null); const [advising, setAdvising] = useState(false); const [metric, setMetric] = useState("pain"); const [metricBlink, setMetricBlink] = useState(false);
  const [ended, setEnded] = useState(false); const [modal, setModal] = useState(false); const [spoken, setSpoken] = useState({});  // schema fields Myno heard from speech
  const [litOn, setLitOn] = useState(false); const [lit, setLit] = useState(null);  // opt-in literature-review insights
  const insRef = useRef(false); useEffect(() => { insRef.current = insOn; }, [insOn]);
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  // When the user turns Literature on, pull research-backed items (poll while generating).
  useEffect(() => {
    if (!litOn) return; const pid = settings.patientId; if (!pid) return;
    let stop = false, tries = 0; const b = (settings.backendUrl || "/api").replace(/\/$/, "");
    const load = async () => {
      try { const r = await fetch(`${b}/patients/${pid}/suggestions`); if (!r.ok || stop) return; const j = await r.json();
        if (stop) return; setLit(j.suggestions || []);
        if ((j.refreshing || !(j.suggestions || []).length) && tries < 15) { tries++; setTimeout(load, 6000); }
      } catch (e) { }
    };
    load(); return () => { stop = true; };
  }, [litOn, settings.patientId]);

  // Live insights run in the BACKGROUND (mic stays enabled) — they can take a
  // while, so they never block the conversation.
  const runAdvise = async () => {
    setAdvising(true);
    try {
      const cur = eRef.current;
      const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
      const summary = {
        avgPain: r1(ins?.avgPain), avgMood: r1(ins?.avgMood), avgCycleDays: ins?.avgGap,
        painAfterHighSugar: r1(ins?.painHi), painAfterLowSugar: r1(ins?.painLo),
        painWithBloating: r1(ins?.bloatPain), painWithoutBloating: r1(ins?.noBloatPain),
        loggedDays: ins?.loggedDays,
        recentPain: logs.slice(-14).map((l) => l.pain), recentMood: logs.slice(-14).map((l) => l.mood),
        recentEnergy: logs.slice(-14).map((l) => l.energy), recentSugar: logs.slice(-14).map((l) => l.sugar),
        today: { pain: cur.pain, mood: cur.mood, energy: cur.energy, sugar: cur.sugar, bloating: cur.bloating, categories: cur.categories },
      };
      const a = await extractAdvise({ settings, note: cur.note || "", categories: cur.categories || [], summary, blocked: blockedLabels(settings), personality: settings.personality });
      if (a && (a.say || a.headline)) setAdvice(a);
    } catch (e) { /* insights are best-effort; the panel just stays as-is */ }
    setAdvising(false);
  };
  useEffect(() => { runAdvise(); }, []);  // trends are on by default — populate once on open

  const persist = (entry) => setLogs([...logs.filter((l) => l.date !== entry.date), entry].sort((a, b) => a.date.localeCompare(b.date)));
  const saveToDb = (entry) => { const pid = settings.patientId; if (!pid) return; const b = (settings.backendUrl || "/api").replace(/\/$/, ""); fetch(`${b}/patients/${pid}/logs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) }).catch(() => {}); };
  const set = (k, v) => { const n = { ...eRef.current, [k]: v }; setE(n); eRef.current = n; persist(n); setSaved(true); };
  // The user can override an inferred category slider; their value is kept.
  const setCatScale = (key, v) => {
    const cats = (eRef.current.categories || []).map((c) => c.key === key ? { ...c, scale: { ...(normalizedScale(c.scale) || {}), value: clampScale(v), max: SCALE_MAX } } : c);
    const n = { ...eRef.current, categories: cats }; setE(n); eRef.current = n; persist(n); setSaved(true);
  };
  // Render one schema field as an input for the "End conversation" sheet.
  const field = (f) => {
    const v = e[f.key]; const on = !!spoken[f.key];
    const wrap = { padding: "10px 12px", borderRadius: 12, background: on ? C.tealFixed : "transparent", transition: "background-color .3s ease" };
    const labelEl = (<span style={{ fontFamily: bodyf, fontSize: 14, color: C.ink, display: "inline-flex", alignItems: "center", gap: 6 }}>{f.label}{on && <span style={{ fontFamily: bodyf, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: C.teal, background: "#fff", borderRadius: 9999, padding: "2px 7px" }}>HEARD</span>}</span>);
    if (f.type === "scale") {
      const max = f.max || SCALE_MAX; const disp = scaleDisplay(v ?? 0, max, f.words);
      return (<div key={f.key} style={wrap}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>{labelEl}<span style={{ fontFamily: head, fontWeight: 700, fontSize: 14, color: C.teal }}>{disp}</span></div>
        <Slider value={clampScale(v, 0, max)} max={max} onChange={(val) => set(f.key, clampScale(val, 0, max))} /></div>);
    }
    const control = f.type === "bool" ? (<div style={{ display: "flex", gap: 6 }}>{[["No", false], ["Yes", true]].map(([lbl, val]) => <Chip key={lbl} active={v === val} onClick={() => set(f.key, v === val ? null : val)}>{lbl}</Chip>)}</div>)
      : f.type === "select" ? (<div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>{f.options.map((o) => <Chip key={o} active={v === o} onClick={() => set(f.key, v === o ? null : o)}>{o}</Chip>)}</div>)
      : f.type === "number" ? (<input type="number" value={v ?? ""} onChange={(ev) => set(f.key, ev.target.value === "" ? null : Number(ev.target.value))} placeholder={f.placeholder || ""} style={{ ...input, width: 120, padding: "9px 11px", fontSize: 14 }} />)
      : (<input value={v || ""} onChange={(ev) => set(f.key, ev.target.value)} placeholder={f.placeholder || ""} style={{ ...input, width: 210, padding: "9px 11px", fontSize: 14 }} />);
    return (<div key={f.key} style={{ ...wrap, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>{labelEl}<div style={{ flexShrink: 0 }}>{control}</div></div>);
  };

  // Light up whichever fields just changed, then fade the highlight out.
  const lightUp = (keys) => {
    if (!keys.length) return;
    setFlash((f) => { const n = { ...f }; keys.forEach((k) => (n[k] = true)); return n; });
    keys.forEach((k) => { clearTimeout(timers.current[k]); timers.current[k] = setTimeout(() => setFlash((f) => { const n = { ...f }; delete n[k]; return n; }), 1700); });
  };

  // Speech → Claude updates the personalized tracker + analytics fields + a spoken
  // reply. The categories are invented from the whole conversation, so they're
  // unique to this person; whatever changed flashes.
  const ingest = async (said) => {
    if (!said) return; setPartial(""); setErr(""); setBusy(true);
    const base = { ...eRef.current, note: (eRef.current.note ? eRef.current.note + " " : "") + said };
    let merged = base; let say = ""; let focus = null;
    try {
      const f = await extractFields({ settings, text: said, context: eRef.current.note || "", blocked: blockedLabels(settings), categories: eRef.current.categories || [], personality: settings.personality });
      const scaleValue = (key) => f[key] == null ? base[key] : clampScale(f[key], base[key] ?? 0);
      const next = { ...base,
        period: f.period ?? base.period, flow: f.flow || base.flow, birthControl: f.birthControl || base.birthControl,
        pain: scaleValue("pain"), mood: scaleValue("mood"), energy: scaleValue("energy"),
        sleep: scaleValue("sleep"), brainFog: scaleValue("brainFog"), sexDrive: scaleValue("sexDrive"),
        sugar: scaleValue("sugar"), foodDrive: scaleValue("foodDrive"),
        dietExercise: f.dietExercise || base.dietExercise, painMap: f.painMap || base.painMap, morningWeight: f.morningWeight ?? base.morningWeight,
        hairGrowth: f.hairGrowth || base.hairGrowth, hairLoss: f.hairLoss || base.hairLoss, acne: f.acne || base.acne,
        skinPatches: f.skinPatches || base.skinPatches, hyperpigmentation: f.hyperpigmentation || base.hyperpigmentation,
        bloating: f.bloating || base.bloating, cravings: f.cravings || base.cravings, diagnoses: f.diagnoses || base.diagnoses };
      // remember which schema fields actually came from speech (to highlight them)
      const heard = ["period", "flow", "birthControl", "pain", "mood", "energy", "sleep", "brainFog", "sexDrive", "sugar", "foodDrive", "dietExercise", "painMap", "morningWeight", "hairGrowth", "hairLoss", "acne", "skinPatches", "hyperpigmentation", "bloating", "cravings", "diagnoses"].filter((k) => { const x = f[k]; return x !== null && x !== undefined && x !== false && x !== ""; });
      if (heard.length) setSpoken((p) => { const n = { ...p }; heard.forEach((k) => (n[k] = true)); return n; });
      if (Array.isArray(f.categories)) {
        const prevMap = Object.fromEntries((base.categories || []).map((c) => [c.key, JSON.stringify([c.value, c.scale?.value])]));
        const clean = f.categories.filter((c) => c && c.key && c.label).slice(0, 6).map(normalizedCategory);
        const changed = clean.filter((c) => prevMap[c.key] !== JSON.stringify([c.value, c.scale?.value])).map((c) => c.key);
        lightUp(changed);
        next.categories = clean;
        // most relevant changed category that has a graphable slider (highest severity)
        const scaled = clean.filter((c) => changed.includes(c.key) && c.scale && typeof c.scale.value === "number" && c.scale.max > 0);
        if (scaled.length) focus = scaled.reduce((a, b) => (b.scale.value / b.scale.max > a.scale.value / a.scale.max ? b : a)).key;
      }
      if (!focus) { const std = ["pain", "mood", "energy", "sugar"].filter((k) => next[k] != null && next[k] !== base[k]); if (std.length) focus = std.includes("pain") ? "pain" : std[0]; }
      merged = next; say = f.say || "";
    } catch (e) { setErr("Couldn't reach the model to read that — is the backend up?"); }
    setE(merged); eRef.current = merged; persist(merged); setSaved(true); setBusy(false);
    // Surface the trend the user just talked about, with a blink to draw the eye.
    if (focus) { setMetric(focus); setMetricBlink(true); clearTimeout(timers.current._blink); timers.current._blink = setTimeout(() => setMetricBlink(false), 1700); }
    // Mic stays OFF through transcription, inference, and Myno's spoken reply —
    // it only comes back on for the next turn (hands-free).
    const resume = () => { if (convoRef.current) voice.start(); };
    if (say) { setReply(say); speaker.speak(say, resume); } else resume();
    if (insRef.current) runAdvise();  // refresh live insights in the background
  };
  const voice = useVoice({ settings, onPartial: setPartial, onFinal: (t) => ingest(t), continuous: false, silenceMs: 1500 });
  const micTap = () => { if (voice.listening) { convoRef.current = false; voice.stop(); } else { convoRef.current = true; voice.start(); } };
  const endConvo = () => { convoRef.current = false; voice.stop(); setEnded(true); setModal(true); };
  const status = busy ? "noting it down…" : voice.listening ? "listening…" : "tap to speak";

  // PRIMARY — the conversation
  const speakBlock = (
    <div style={{ background: C.tealC, borderRadius: 24, padding: 22, boxShadow: SH, textAlign: "center", color: "#fff" }}>
      <div style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 16, lineHeight: 1.4, marginBottom: 16, opacity: 0.95 }}>How has your body been today?</div>
      <div style={{ display: "grid", placeItems: "center", marginBottom: 12 }}>
        <button onClick={micTap} disabled={busy} style={{ width: 96, height: 96, borderRadius: "50%", border: "none", cursor: busy ? "default" : "pointer", display: "grid", placeItems: "center", background: voice.listening ? C.roseOn : "#fff", color: voice.listening ? "#fff" : C.teal, boxShadow: voice.listening ? "0 0 0 6px rgba(255,255,255,0.3)" : SH, animation: voice.listening ? "pulse 1.5s infinite" : "none", opacity: busy ? 0.7 : 1 }}>
          {voice.listening ? <MicOff size={38} /> : <Mic size={38} />}</button></div>
      <div style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", minHeight: 18 }}>{busy ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Loader2 size={13} className="spin" /> {status}</span> : status}</div>
      <div style={{ minHeight: 24, marginTop: 10, fontSize: 15 }}>{partial ? <i style={{ opacity: 0.92 }}>{partial}…</i> : null}</div>
      {reply && (<div style={{ display: "flex", gap: 10, alignItems: "flex-start", textAlign: "left", background: "rgba(255,255,255,0.16)", borderRadius: 16, padding: "12px 14px", marginTop: 12 }}>
        <LeafMark size={28} />
        <div style={{ flex: 1, fontSize: 15, lineHeight: 1.45 }}>{reply}</div>
        {speaker.speaking && <button onClick={speaker.stop} title="Stop speaking" style={{ background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 9999, width: 30, height: 30, display: "grid", placeItems: "center", cursor: "pointer", color: "#fff", flexShrink: 0 }}><VolumeX size={15} /></button>}
      </div>)}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 12 }}>{["Some pain today", "Tired and bloated", "Feeling good"].map((c) => (<button key={c} onClick={() => ingest(c)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "8px 14px", borderRadius: 9999, background: "rgba(255,255,255,0.16)", border: "1.5px solid rgba(255,255,255,0.35)", color: "#fff", cursor: "pointer" }}>{c}</button>))}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", background: "rgba(255,255,255,0.14)", borderRadius: 9999, padding: 5, marginTop: 12 }}>
        <input value={text} onChange={(ev) => setText(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter" && text.trim()) { ingest(text.trim()); setText(""); } }} placeholder="…or type it" style={{ flex: 1, border: "none", outline: "none", fontFamily: bodyf, fontSize: 15, padding: "8px 12px", background: "transparent", color: "#fff" }} />
      </div>
      <button onClick={endConvo} style={{ marginTop: 10, width: "100%", fontFamily: bodyf, fontWeight: 700, fontSize: 14, padding: "12px", borderRadius: 9999, background: "#fff", color: C.teal, border: "none", cursor: "pointer" }}>End conversation</button>
      {voice.note && <p style={{ fontSize: 12, color: "#fff", marginTop: 10, opacity: 0.9 }}>{voice.note}</p>}
      {err && <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", marginTop: 12, padding: "10px 14px", borderRadius: 12, background: "rgba(255,255,255,0.16)", color: "#fff", fontSize: 13, fontWeight: 600 }}><AlertTriangle size={15} style={{ flexShrink: 0 }} /> {err}</div>}
    </div>);

  // SIDE — the personalized tracker Myno builds from the conversation. New and
  // changed categories rise in and flash a teal "updated" notification.
  const cats = e.categories || [];
  // Literature insights, shown in BOTH panels when the toggle is on.
  const EVL = { Strong: [C.tealFixed, C.onTealFixed], Emerging: [C.rose, C.roseOn], Early: [C.container, C.inkVar] };
  const litSection = (max) => (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.high}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}><Microscope size={15} color={C.teal} /><span style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: C.inkVar }}>From the literature</span>{(lit === null || lit.length === 0) && <Loader2 size={12} className="spin" color={C.outline} style={{ marginLeft: "auto" }} />}</div>
      {(lit === null || lit.length === 0) ? <p style={{ fontSize: 12, color: C.outline }}>Scanning recent PCOS research…</p> : (
        <div style={{ display: "grid", gap: 10 }}>{lit.slice(0, max).map((s, i) => { const [bg, fg] = EVL[s.evidence] || [C.container, C.inkVar]; return (
          <div key={i}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}><span style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13.5 }}>{s.tracker}</span><span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 9, padding: "2px 7px", borderRadius: 9999, background: bg, color: fg, whiteSpace: "nowrap" }}>{s.evidence}</span></div>
            <p style={{ fontSize: 12, color: C.inkVar, lineHeight: 1.45, margin: "3px 0 2px" }}>{s.explanation}</p>
            <a href={s.read_more} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, fontWeight: 600, color: C.teal, textDecoration: "none" }}>Read the research →</a>
          </div>); })}</div>)}
    </div>);

  const dayBlock = (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <Label color={C.inkVar}>Your day so far</Label>
        <button onClick={() => setModal(true)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, color: C.teal, background: "none", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}><SquarePen size={14} /> Details</button>
      </div>
      {cats.length === 0 ? (
        <Card style={{ color: C.inkVar, fontSize: 14, lineHeight: 1.5 }}><Sparkles size={16} color={C.roseOn} /> &nbsp;As you talk, Myno builds a tracker here — in your own words.</Card>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {cats.map((c) => { const on = !!flash[c.key]; const sc = normalizedScale(c.scale); return (
            <div key={c.key} style={{ position: "relative", background: on ? C.tealFixed : C.surface, boxShadow: on ? `0 0 0 3px ${C.teal}` : SH_SM, borderRadius: 16, padding: "13px 16px", transition: "box-shadow .35s ease, background-color .35s ease", animation: on ? "rise .3s ease" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: bodyf, fontWeight: 600, fontSize: 14, color: C.inkVar }}>{c.label}
                  {on && <span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 10, letterSpacing: "0.06em", color: C.onTealFixed, background: "#fff", borderRadius: 9999, padding: "3px 8px", animation: "pulse 1s ease infinite" }}>UPDATED</span>}</span>
                {c.value && <span style={{ fontFamily: head, fontWeight: 700, fontSize: 14, color: C.teal, textAlign: "right" }}>{String(c.value)}</span>}
              </div>
              {sc && <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                <div style={{ flex: 1 }}><Slider value={sc.value} max={sc.max} onChange={(v) => setCatScale(c.key, v)} /></div>
                <span style={{ fontFamily: head, fontWeight: 700, fontSize: 13, color: C.outline, minWidth: 36, textAlign: "right" }}>{sc.value}/{sc.max}</span>
              </div>}
            </div>); })}
        </div>
      )}
      {litOn && litSection(6)}
    </div>
  );

  // OPT-IN — live trends, correlations & advice from history + this conversation
  const toggleIns = () => { const nv = !insOn; setInsOn(nv); if (nv) runAdvise(); };
  // Trend metrics = the standard analytics fields PLUS any personalized
  // categories that carry a slider value (they earn their own line as the days
  // of logging accumulate; today reflects live slider edits and speech).
  const STD_KEYS = new Set(["pain", "mood", "energy", "sugar"]);
  const seenCats = {};  // keyed by category key → last label wins (no key dupes)
  logs.slice(-30).concat([e]).forEach((l) => (l?.categories || []).forEach((c) => { if (c && normalizedScale(c.scale) && c.key && !STD_KEYS.has(c.key)) seenCats[c.key] = c.label || c.key; }));
  const usedLabels = new Set(["pain", "mood", "energy", "sugar"]);  // also dedupe by display label
  const catEntries = [];
  for (const [k, l] of Object.entries(seenCats)) { const n = String(l).trim().toLowerCase(); if (usedLabels.has(n)) continue; usedLabels.add(n); catEntries.push([k, l, true]); }
  const METRICS = [["pain", "Pain"], ["mood", "Mood"], ["energy", "Energy"], ["sugar", "Sugar"]]
    .filter(([k]) => !(k === "mood" && isBlocked(settings, "mood")) && !(k === "sugar" && isBlocked(settings, "diet")))
    .map(([k, l]) => [k, l, false])
    .concat(catEntries.slice(0, 4));
  const mEntry = METRICS.find(([k]) => k === metric) || METRICS[0] || ["pain", "Pain", false];
  const mSel = mEntry[0]; const mIsCat = mEntry[2];
  const series = mIsCat
    ? (() => { let last = 0; return logs.slice(-30).map((l) => { const c = (l.categories || []).find((x) => x.key === mSel); const scale = normalizedScale(c?.scale); if (scale) last = scale.value; return last; }); })()
    : logs.slice(-30).map((l) => Number(l[mSel] ?? 0));
  const insightsPanel = (
    <Card style={{ padding: 16, position: wide ? "sticky" : "static", top: 88, boxShadow: metricBlink ? `0 0 0 3px ${C.teal}` : SH_SM, transition: "box-shadow .3s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Label color={C.inkVar}>Live trends</Label>{metricBlink && <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.teal, animation: "pulse 0.8s ease infinite" }} />}</span>
        {advising && <Loader2 size={13} className="spin" color={C.outline} />}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>{METRICS.map(([k, lbl]) => (
        <button key={k} onClick={() => setMetric(k)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 12, padding: "5px 11px", borderRadius: 9999, cursor: "pointer", border: "none", background: mSel === k ? C.teal : C.container, color: mSel === k ? "#fff" : C.inkVar, animation: (metricBlink && mSel === k) ? "pulse 0.9s ease 2" : "none" }}>{lbl}</button>))}</div>
      {series.length > 1 && (<><Sparkline series={series} /><div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.outline, marginTop: 4 }}><span>30d ago</span><span>today</span></div></>)}
      {advice?.headline && <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 14, fontFamily: head, fontWeight: 700, fontSize: 14, lineHeight: 1.3, color: C.teal }}><Sparkles size={14} color={C.roseOn} style={{ flexShrink: 0, marginTop: 1 }} /> {advice.headline}</div>}
      {advice?.correlations?.length > 0 && (<div style={{ display: "grid", gap: 8, marginTop: 10 }}>{advice.correlations.map((c, i) => (
        <div key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: C.inkVar, marginBottom: 3 }}><span>{c.label}</span><span style={{ fontWeight: 700, color: C.teal }}>{Math.round(c.strength)}%</span></div>
          <div style={{ height: 6, borderRadius: 9999, background: C.high }}><div style={{ width: `${Math.max(0, Math.min(100, c.strength))}%`, height: "100%", borderRadius: 9999, background: C.teal, transition: "width .5s ease" }} /></div>
        </div>))}</div>)}
      {advice?.say ? (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, background: C.tealFixed, color: C.onTealFixed, borderRadius: 14, padding: "11px 12px" }}>
          <div style={{ flex: 1, fontSize: 13, lineHeight: 1.4 }}>{advice.say}</div>
          <button onClick={() => speaker.speak(advice.say)} title="Hear it" style={{ background: "rgba(0,0,0,0.06)", border: "none", borderRadius: 9999, width: 26, height: 26, display: "grid", placeItems: "center", cursor: "pointer", color: C.teal, flexShrink: 0 }}><Volume2 size={13} /></button>
        </div>
      ) : (!advising && <p style={{ fontSize: 12, color: C.inkVar, marginTop: 12 }}>Keep talking — patterns from your history &amp; today show up here.</p>)}
      {litOn && litSection(3)}
    </Card>);

  // The "End conversation" sheet — fill the standard schema fields by hand.
  const fieldsModal = modal ? (
    <div onClick={() => setModal(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 100, display: "grid", placeItems: "center", padding: 16 }}>
      <div onClick={(ev) => ev.stopPropagation()} style={{ background: C.surface, borderRadius: 24, boxShadow: SH, width: "100%", maxWidth: 520, maxHeight: "86vh", overflowY: "auto", padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <H size={22}>Fill in your day</H>
          <button onClick={() => setModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkVar }}><X size={22} /></button>
        </div>
        <p style={{ color: C.inkVar, fontSize: 14, marginBottom: 14 }}>Optional — add anything you didn't say out loud. You can keep talking after.</p>
        {LOG_SCHEMA.map((g) => (<div key={g.group} style={{ marginBottom: 14 }}>
          <Label color={C.inkVar}>{g.group}</Label>
          <div style={{ marginTop: 4 }}>{g.fields.map(field)}</div>
        </div>))}
        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <Pill variant="soft" onClick={() => setModal(false)} style={{ flex: 1 }}>Keep talking</Pill>
          <Pill onClick={() => { persist(e); saveToDb(e); setSaved(true); setModal(false); if (setTab) setTab("home"); }} style={{ flex: 1 }}><Check size={16} /> {saved ? "Saved" : "Done"}</Pill>
        </div>
      </div>
    </div>
  ) : null;

  return (<div>
    {fieldsModal}
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
      <H size={26}>Record your day</H>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
        <PersonalityPicker value={settings.personality} onChange={(p) => setSettings((s) => ({ ...s, personality: p }))} />
        <Pill variant={insOn ? "filled" : "outline"} onClick={toggleIns} style={{ padding: "10px 16px", fontSize: 14, flexShrink: 0 }}><BarChart3 size={15} /> Trends</Pill>
        <Pill variant={litOn ? "filled" : "outline"} onClick={() => setLitOn((v) => !v)} style={{ padding: "10px 16px", fontSize: 14, flexShrink: 0 }}><Microscope size={15} /> Literature</Pill>
      </div>
    </div>
    <p style={{ color: C.inkVar, marginBottom: 18 }}>Just talk — Myno listens, talks back, and builds your personal tracker as you go.</p>
    {wide ? (
      <div style={{ display: "grid", gridTemplateColumns: insOn ? "minmax(240px, 280px) minmax(0, 1fr) minmax(280px, 340px)" : "minmax(0, 1fr) minmax(300px, 380px)", gap: 20, alignItems: "start" }}>
        {insOn && insightsPanel}{speakBlock}{dayBlock}</div>
    ) : (
      <div>{insOn && <div style={{ marginBottom: 22 }}>{insightsPanel}</div>}<div style={{ marginBottom: 22 }}>{speakBlock}</div>{dayBlock}</div>
    )}
  </div>);
}
function ScaleRow({ label, value, onChange, words, flash }) {
  const v = clampScale(value);
  return (<div style={{ borderRadius: 12, padding: 8, margin: -8, transition: "background-color .35s ease", background: flash ? C.tealFixed : "transparent" }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><span style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>{label}</span><span style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, color: flash ? C.tealDark : C.teal }}>{scaleDisplay(v, SCALE_MAX, words)}</span></div>
    <Slider value={v} max={SCALE_MAX} onChange={(next) => onChange(clampScale(next))} /></div>);
}
function MicBtn({ listening, onClick, size = 46 }) {
  return (<button onClick={onClick} style={{ width: size, height: size, borderRadius: "50%", border: "none", cursor: "pointer", display: "grid", placeItems: "center", flexShrink: 0, background: listening ? C.roseOn : C.teal, color: "#fff", boxShadow: listening ? `0 0 0 5px ${C.rose}` : "none", animation: listening ? "pulse 1.4s infinite" : "none" }}>{listening ? <MicOff size={size * 0.42} /> : <Mic size={size * 0.42} />}</button>);
}

// ---- INSIGHTS (twin) -------------------------------------------------------
function InsightsScreen({ ins, logs, settings, wide }) {
  // metric list = standard fields + personalized categories that carry a slider
  const STD = [["pain", "Pain"], ["mood", "Mood"], ["energy", "Energy"], ["sleep", "Sleep"], ["brainFog", "Brain fog"], ["sugar", "Sugar"]]
    .filter(([k]) => !(k === "mood" && isBlocked(settings, "mood")) && !(k === "sugar" && isBlocked(settings, "diet"))).map(([k, l]) => [k, l, false]);
  const seen = {}; logs.forEach((l) => (l.categories || []).forEach((c) => { if (c && c.scale && typeof c.scale.value === "number" && c.key) seen[c.key] = c.label || c.key; }));
  const used = new Set([...STD.map(([k]) => k), ...STD.map(([, l]) => l.toLowerCase())]);
  const catList = []; for (const [k, l] of Object.entries(seen)) { const n = String(l).toLowerCase(); if (used.has(n)) continue; used.add(n); catList.push([k, l, true]); }
  const METRICS = STD.concat(catList.slice(0, 5));
  const [metric, setMetric] = useState("pain");
  const [view, setView] = useState("insights"); // sub-view within Insights: "insights" | "track"
  const [xKey, setXKey] = useState("sugar"); const [yKey, setYKey] = useState("pain"); const [lagDay, setLagDay] = useState(true);
  const mEntry = METRICS.find(([k]) => k === metric) || METRICS[0] || ["pain", "Pain", false];
  const mSel = mEntry[0], mLbl = mEntry[1], mIsCat = mEntry[2];
  const series = mIsCat
    ? (() => { let last = 0; return logs.slice(-30).map((l) => { const c = (l.categories || []).find((x) => x.key === mSel); if (c && c.scale && typeof c.scale.value === "number") last = c.scale.value; return last; }); })()
    : logs.slice(-30).map((l) => Number(l[mSel] ?? 0));
  const sAvg = series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0;
  // chart data
  const heatVal = (l) => mIsCat ? (() => { const c = (l.categories || []).find((x) => x.key === mSel); return c && c.scale ? c.scale.value : null; })() : (typeof l[mSel] === "number" ? l[mSel] : null);
  const heatMax = mIsCat ? 10 : (mSel === "pain" ? 10 : 4);
  const heatDays = logs.slice(-84);
  const periodDates = logs.filter((l) => l.period).map((l) => l.date);
  const gaps = []; for (let i = 1; i < periodDates.length; i++) { const g = Math.round((new Date(periodDates[i]) - new Date(periodDates[i - 1])) / 86400000); if (g > 10) gaps.push(g); }
  // relationship explorer: pick X, Y and same/next-day → scatter + live Pearson r
  const NUM = [["sugar", "Sugar", 4], ["pain", "Pain", 10], ["mood", "Mood", 4], ["energy", "Energy", 4], ["sleep", "Sleep", 4], ["brainFog", "Brain fog", 4]]
    .filter(([k]) => !(k === "sugar" && isBlocked(settings, "diet")) && !(k === "mood" && isBlocked(settings, "mood")));
  const xMeta = NUM.find(([k]) => k === xKey) || NUM[0]; const yMeta = NUM.find(([k]) => k === yKey) || NUM[0];
  const off = lagDay ? 1 : 0; const exPoints = [];
  for (let i = off; i < logs.length; i++) { const x = logs[i - off][xMeta[0]], y = logs[i][yMeta[0]]; if (typeof x === "number" && typeof y === "number") exPoints.push({ x, y }); }
  const exR = (() => { const n = exPoints.length; if (n < 8) return null; const mx = exPoints.reduce((a, p) => a + p.x, 0) / n, my = exPoints.reduce((a, p) => a + p.y, 0) / n; const cov = exPoints.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0); const vx = exPoints.reduce((a, p) => a + (p.x - mx) ** 2, 0), vy = exPoints.reduce((a, p) => a + (p.y - my) ** 2, 0); if (vx <= 0 || vy <= 0) return null; return cov / Math.sqrt(vx * vy); })();
  const exS = exR == null ? "" : (Math.abs(exR) >= 0.6 ? "strong" : Math.abs(exR) >= 0.4 ? "moderate" : Math.abs(exR) >= 0.2 ? "weak" : "negligible");
  const exChip = (lbl, sel, on) => (<button key={lbl} onClick={on} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 12, padding: "5px 10px", borderRadius: 9999, border: "none", cursor: "pointer", background: sel ? C.teal : C.container, color: sel ? "#fff" : C.inkVar }}>{lbl}</button>);

  // Claude analysis + computed statistics over the DB logs
  const [analysis, setAnalysis] = useState(null); const [stats, setStats] = useState(null); const [loadingA, setLoadingA] = useState(false);
  useEffect(() => { (async () => {
    const pid = settings.patientId; if (!pid) return; setLoadingA(true);
    try { const b = (settings.backendUrl || "/api").replace(/\/$/, ""); const r = await fetch(`${b}/patients/${pid}/insights`, { method: "POST" }); if (r.ok) { const j = await r.json(); setAnalysis(j.analysis); setStats(j.stats); } } catch (e) { }
    setLoadingA(false);
  })(); }, [settings.patientId]);

  // research-backed tracker suggestions (generated daily in the background; poll while generating)
  const [sugg, setSugg] = useState(null);
  useEffect(() => {
    const pid = settings.patientId; if (!pid) return;
    let stop = false, tries = 0; const b = (settings.backendUrl || "/api").replace(/\/$/, "");
    const load = async () => {
      try { const r = await fetch(`${b}/patients/${pid}/suggestions`); if (!r.ok || stop) return; const j = await r.json();
        if (stop) return; setSugg(j.suggestions || []);
        if ((j.refreshing || !(j.suggestions || []).length) && tries < 15) { tries++; setTimeout(load, 6000); }
      } catch (e) { }
    };
    load();
    return () => { stop = true; };
  }, [settings.patientId]);

  const analysisCard = (<Card>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: head, fontWeight: 600, fontSize: 17 }}><Sparkles size={18} color={C.roseOn} /> Myno's analysis</span>
      {loadingA && <Loader2 size={14} className="spin" color={C.outline} />}
    </div>
    {analysis?.summary && <p style={{ fontSize: 14, lineHeight: 1.5, color: C.ink, margin: "0 0 12px" }}>{analysis.summary}</p>}
    {analysis?.insights?.length > 0 ? (<div style={{ display: "grid", gap: 12 }}>{analysis.insights.map((it, i) => (
      <div key={i}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}><span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 14, color: C.teal }}>{it.title}</span><span style={{ fontFamily: head, fontWeight: 700, fontSize: 13, color: C.teal }}>{Math.round(it.strength ?? 0)}%</span></div>
        <div style={{ height: 6, borderRadius: 9999, background: C.high, marginBottom: 6 }}><div style={{ width: `${Math.max(0, Math.min(100, it.strength ?? 0))}%`, height: "100%", borderRadius: 9999, background: C.teal }} /></div>
        <p style={{ fontSize: 13, lineHeight: 1.45, color: C.inkVar, margin: 0 }}>{it.detail}</p>
      </div>))}</div>
    ) : (!loadingA && <p style={{ fontSize: 13, color: C.inkVar }}>Keep logging — Myno analyses your trends here.</p>)}
  </Card>);

  // Real Pearson correlations computed over the DB logs
  const correlationsCard = stats?.correlations?.length > 0 && (<Card>
    <Label color={C.inkVar}>Correlations in your data</Label>
    <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
      {stats.correlations.slice(0, 4).map((c, i) => { const a = Math.abs(c.r); return (
        <div key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 14, color: C.ink }}>{c.label}</span>
            <span style={{ fontFamily: head, fontWeight: 700, fontSize: 13, color: C.teal }}>r {c.r > 0 ? "+" : ""}{c.r.toFixed(2)}</span>
          </div>
          <div style={{ height: 6, borderRadius: 9999, background: C.high }}><div style={{ width: `${Math.round(a * 100)}%`, height: "100%", borderRadius: 9999, background: a >= 0.6 ? C.teal : C.tealC }} /></div>
          <div style={{ fontSize: 11.5, color: C.outline, marginTop: 3 }}>{c.strength} correlation · {c.n} days</div>
        </div>); })}
    </div>
    <div style={{ fontSize: 11.5, color: C.outline, marginTop: 12, lineHeight: 1.5 }}>Pearson r ranges −1 to +1; |r| ≥ 0.6 is strong, 0.4–0.6 moderate. Association, not proof of cause.</div>
  </Card>);

  // Cycle variability: mean ± SD and coefficient of variation
  const cy = stats?.cycle;
  const cycleCard = cy && (<Card>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <Label color={C.inkVar}>Cycle regularity</Label>
      <span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 12, padding: "4px 10px", borderRadius: 9999, background: cy.regular ? C.tealFixed : C.rose, color: cy.regular ? C.onTealFixed : C.roseOn }}>{cy.label}</span>
    </div>
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 12 }}>
      <span style={{ fontFamily: head, fontWeight: 700, fontSize: 32, color: C.teal }}>{cy.meanDays}</span>
      <span style={{ fontSize: 14, color: C.inkVar }}>± {cy.sdDays} days (mean ± SD)</span>
    </div>
    <div style={{ fontSize: 13, color: C.inkVar, marginTop: 8 }}>Range {cy.min}–{cy.max} days across {cy.cycles} cycles · variability (CV) {cy.cv}%</div>
    {gaps.length > 0 && <div style={{ marginTop: 12 }}><CycleBars gaps={gaps} /></div>}
    <div style={{ fontSize: 11.5, color: C.outline, marginTop: 10, lineHeight: 1.5 }}>Typical adult cycles run 21–35 days. Consistently longer or highly variable cycles are a common PCOS sign — worth raising with a clinician.</div>
  </Card>);

  const trendCard = stats?.trends?.length > 0 && (<Card>
    <Label color={C.inkVar}>Direction over time</Label>
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>{stats.trends.map((t, i) => (
      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
        <span style={{ color: C.ink }}>{t.label}</span>
        <span style={{ fontFamily: head, fontWeight: 700, color: t.direction === "down" ? C.teal : C.roseOn }}>{t.direction === "up" ? "↑" : "↓"} {Math.abs(t.perWeek)}/wk</span>
      </div>))}</div>
    <div style={{ fontSize: 11.5, color: C.outline, marginTop: 10 }}>Least-squares slope over your logged days.</div>
  </Card>);

  const explorerCard = (<Card>
    <Label color={C.inkVar}>Explore a relationship</Label>
    <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><span style={{ fontSize: 12, color: C.inkVar, fontWeight: 700, width: 14 }}>X</span>{NUM.map(([k, lbl]) => exChip(lbl, xKey === k, () => setXKey(k)))}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><span style={{ fontSize: 12, color: C.inkVar, fontWeight: 700, width: 14 }}>Y</span>{NUM.map(([k, lbl]) => exChip(lbl, yKey === k, () => setYKey(k)))}</div>
      <div style={{ display: "flex", gap: 6 }}>{exChip("same day", !lagDay, () => setLagDay(false))}{exChip("X → next-day Y", lagDay, () => setLagDay(true))}</div>
    </div>
    <div style={{ marginTop: 12 }}><Scatter points={exPoints} xMax={xMeta[2]} yMax={yMeta[2]} xLabel={`${xMeta[1]}${lagDay ? " (prev day)" : ""}`} yLabel={yMeta[1]} /></div>
    {exR != null ? <div style={{ fontSize: 13, color: C.inkVar, marginTop: 6 }}>Pearson <b style={{ color: C.teal }}>r = {exR > 0 ? "+" : ""}{exR.toFixed(2)}</b> · {exS} · {exPoints.length} days · red line = best fit</div>
      : <div style={{ fontSize: 12, color: C.outline, marginTop: 6 }}>Not enough overlapping days.</div>}
  </Card>);

  const statsLoading = loadingA && !stats;
  const loadingCard = (<Card style={{ display: "flex", alignItems: "center", gap: 10, color: C.inkVar, fontSize: 14 }}><Loader2 size={16} className="spin" color={C.teal} /> Computing your stats &amp; correlations…</Card>);

  // research-backed "what else to track" suggestions
  const EV = { Strong: [C.tealFixed, C.onTealFixed], Emerging: [C.rose, C.roseOn], Early: [C.container, C.inkVar] };
  const badge = (txt, bg, fg) => <span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 10, letterSpacing: "0.03em", padding: "3px 8px", borderRadius: 9999, background: bg, color: fg, whiteSpace: "nowrap" }}>{txt}</span>;
  const suggestionsCard = (<Card>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <Microscope size={18} color={C.teal} /><span style={{ fontFamily: head, fontWeight: 600, fontSize: 17 }}>What else to track</span>
      {(sugg === null || sugg.length === 0) && <Loader2 size={14} className="spin" color={C.outline} style={{ marginLeft: "auto" }} />}
    </div>
    <p style={{ fontSize: 13, color: C.inkVar, lineHeight: 1.5, margin: "0 0 12px" }}>Research-backed ideas from recent PCOS literature (2022–2025), based on what you already track. Regenerated daily.</p>
    {(sugg === null || sugg.length === 0) ? (
      <p style={{ fontSize: 13, color: C.outline }}>Scanning the latest research for you…</p>
    ) : (
      <div style={{ display: "grid", gap: 14 }}>{sugg.map((s, i) => { const [bg, fg] = EV[s.evidence] || [C.container, C.inkVar]; return (
        <div key={i} style={{ paddingTop: i ? 14 : 0, borderTop: i ? `1px solid ${C.high}` : "none" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: head, fontWeight: 700, fontSize: 15 }}>{s.tracker}</span>
            <span style={{ display: "flex", gap: 6 }}>{badge(s.category, C.low, C.inkVar)}{badge(s.evidence, bg, fg)}</span>
          </div>
          <p style={{ fontSize: 13.5, lineHeight: 1.5, color: C.inkVar, margin: "6px 0 6px" }}>{s.explanation}</p>
          <div style={{ fontSize: 12, color: C.outline, lineHeight: 1.5 }}>How: {s.tracking_method}</div>
          {s.requires_device && <div style={{ fontSize: 12, color: s.device_owned ? C.teal : C.outline, marginTop: 2 }}>{s.device_owned ? `✓ works with your ${s.device_needed}` : `needs ${s.device_needed}`}</div>}
          <a href={s.read_more} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, fontWeight: 600, color: C.teal, marginTop: 7, textDecoration: "none" }}>Read the research →</a>
        </div>); })}</div>
    )}
  </Card>);

  const trendsCard = (<Card>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
      <div><div style={{ fontFamily: head, fontWeight: 600, fontSize: 17 }}>{mLbl} trends</div><div style={{ fontSize: 13, color: C.inkVar }}>Past 30 days · avg {sAvg.toFixed(1)}</div></div>
      <div style={{ textAlign: "right", color: C.teal, fontFamily: bodyf, fontWeight: 600, fontSize: 14 }}>{series[series.length - 1] <= series[0] ? "↘ lower" : "↗ higher"}</div></div>
    <Sparkline series={series} />
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.outline, marginTop: 6 }}><span>30d ago</span><span>Today</span></div>
    <div style={{ marginTop: 16 }}><div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 600, color: C.inkVar, marginBottom: 6 }}>Daily intensity · last 12 weeks</div><Heatmap days={heatDays} valueOf={heatVal} max={heatMax} /></div></Card>);
  const highlights = (<Card style={{ background: C.low, boxShadow: "none" }}>
    <Label color={C.inkVar}>Historical highlights</Label>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
      <div style={{ background: C.surface, borderRadius: 14, padding: 16 }}><Microscope size={18} color={C.teal} /><div style={{ fontFamily: head, fontWeight: 700, fontSize: 24, marginTop: 8 }}>{ins.highPainGap} days</div><div style={{ fontSize: 12, color: C.inkVar }}>since last high-pain episode</div></div>
      <div style={{ background: C.surface, borderRadius: 14, padding: 16 }}><Heart size={18} color={C.roseOn} /><div style={{ fontFamily: head, fontWeight: 700, fontSize: 24, marginTop: 8 }}>{ins.loggedDays} days</div><div style={{ fontSize: 12, color: C.inkVar }}>consistent logging</div></div>
    </div></Card>);
  const disclaimer = (<div style={{ padding: 14, background: C.surface, borderRadius: 14, fontSize: 12, color: C.inkVar, lineHeight: 1.5, display: "flex", gap: 8 }}>
    <Info size={15} color={C.teal} style={{ flexShrink: 0, marginTop: 2 }} />These are associations from your own logs, not certainties — and a roadmap feature uses federated learning to sharpen them across the community while your raw data stays on your device.</div>);
  const SUBVIEWS = [["insights", "Insights"], ["track", "What to track"]];
  const subNav = (<div style={{ display: "inline-flex", gap: 4, padding: 4, background: C.container, borderRadius: 9999, marginBottom: 18 }}>
    {SUBVIEWS.map(([id, lbl]) => { const on = view === id; return (
      <button key={id} onClick={() => setView(id)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, padding: "8px 18px", borderRadius: 9999, cursor: "pointer", border: "none", background: on ? C.surface : "transparent", color: on ? C.teal : C.inkVar, boxShadow: on ? SH_SM : "none" }}>{lbl}</button>); })}
  </div>);
  const chipsRow = (<div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 6, marginBottom: 18 }}>{METRICS.map(([k, lbl]) => (
    <button key={k} onClick={() => setMetric(k)} style={{ flexShrink: 0, fontFamily: bodyf, fontWeight: 600, fontSize: 14, padding: "9px 18px", borderRadius: 9999, cursor: "pointer", border: "none", background: mSel === k ? C.teal : C.container, color: mSel === k ? "#fff" : C.inkVar }}>{lbl}</button>))}</div>);

  if (wide) return (<div>
    <H size={28} style={{ marginBottom: 16 }}>Insights</H>{subNav}
    {view === "track" ? (
      <div style={{ maxWidth: 760 }}>{suggestionsCard}<div style={{ marginTop: 20 }}>{disclaimer}</div></div>
    ) : (<>
      {chipsRow}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
        <div style={{ display: "grid", gap: 18 }}>{analysisCard}{trendsCard}{explorerCard}</div>
        <div style={{ display: "grid", gap: 18 }}>{statsLoading && loadingCard}{cycleCard}{correlationsCard}{trendCard}{highlights}</div>
      </div>
      <div style={{ marginTop: 20 }}>{disclaimer}</div>
    </>)}
  </div>);

  return (<div>
    <H size={28} style={{ margin: "8px 0 14px" }}>Insights</H>{subNav}
    {view === "track" ? (<>
      {suggestionsCard}
      <div style={{ marginTop: 16 }}>{disclaimer}</div>
    </>) : (<>
      {chipsRow}
      <div style={{ marginBottom: 18 }}>{analysisCard}</div>
      {statsLoading && <div style={{ marginBottom: 18 }}>{loadingCard}</div>}
      <div style={{ marginBottom: 18 }}>{trendsCard}</div>
      {cycleCard && <div style={{ marginBottom: 18 }}>{cycleCard}</div>}
      {correlationsCard && <div style={{ marginBottom: 18 }}>{correlationsCard}</div>}
      <div style={{ marginBottom: 18 }}>{explorerCard}</div>
      {trendCard && <div style={{ marginBottom: 18 }}>{trendCard}</div>}
      {highlights}
      <div style={{ marginTop: 16 }}>{disclaimer}</div>
    </>)}
  </div>);
}
function Sparkline({ series }) {
  const w = 300, h = 90, max = Math.max(...series, 1), min = Math.min(...series, 0);
  const pts = series.map((v, i) => [(i / (series.length - 1)) * w, h - ((v - min) / Math.max(1, max - min)) * (h - 12) - 6]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${d} L${w},${h} L0,${h} Z`;
  return (<svg viewBox={`0 0 ${w} ${h}`} width="100%" preserveAspectRatio="none" style={{ display: "block" }}>
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.tealC} stopOpacity="0.25" /><stop offset="100%" stopColor={C.tealC} stopOpacity="0" /></linearGradient></defs>
    <path d={area} fill="url(#g)" /><path d={d} fill="none" stroke={C.teal} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
    <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="4" fill="#fff" stroke={C.teal} strokeWidth="2.5" />
  </svg>);
}
// 7×N calendar heatmap of a daily metric (columns = weeks)
function Heatmap({ days, valueOf, max, color = C.teal }) {
  const cell = 13, gap = 3, rows = 7;
  const cols = Math.ceil(days.length / rows) || 1;
  const w = cols * (cell + gap), h = rows * (cell + gap);
  return (<svg viewBox={`0 0 ${w} ${h}`} width="100%" preserveAspectRatio="xMinYMin meet" style={{ display: "block", maxWidth: w }}>
    {days.map((l, i) => { const c = Math.floor(i / rows), r = i % rows; const v = valueOf(l);
      const op = v == null ? 1 : Math.max(0.1, Math.min(1, v / max));
      return <rect key={i} x={c * (cell + gap)} y={r * (cell + gap)} width={cell} height={cell} rx={3} fill={v == null ? C.high : color} fillOpacity={op} />; })}
  </svg>);
}
// cycle lengths over time as dots, with the normal 21–35 day band + reference lines
function CycleBars({ gaps, lo = 21, hi = 35 }) {
  if (!gaps.length) return null;
  const w = 300, h = 124, padL = 22, padB = 16, padT = 14;
  const maxV = Math.max(hi + 8, ...gaps);
  const X = (i) => padL + (gaps.length === 1 ? (w - padL - 10) / 2 : (i / (gaps.length - 1)) * (w - padL - 12));
  const Y = (v) => padT + (1 - v / maxV) * (h - padT - padB);
  const pts = gaps.map((g, i) => [X(i), Y(g)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return (<svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
    <rect x={padL} y={Y(hi)} width={w - padL} height={Y(lo) - Y(hi)} fill={C.tealFixed} fillOpacity={0.5} />
    {[lo, hi].map((v) => (<g key={v}><line x1={padL} y1={Y(v)} x2={w} y2={Y(v)} stroke={C.tealFixedDim} strokeDasharray="3 3" /><text x={0} y={Y(v) + 3} style={{ fontSize: 8, fill: C.outline }}>{v}</text></g>))}
    {gaps.length > 1 && <path d={line} fill="none" stroke={C.outlineVar} strokeWidth={1.5} />}
    {pts.map((p, i) => { const ok = gaps[i] >= lo && gaps[i] <= hi; return (<g key={i}>
      <circle cx={p[0]} cy={p[1]} r={4.5} fill={ok ? C.teal : C.roseOn} />
      <text x={p[0]} y={p[1] - 8} textAnchor="middle" style={{ fontSize: 9, fontWeight: 700, fill: ok ? C.teal : C.roseOn }}>{gaps[i]}</text></g>); })}
    <text x={w} y={h - 3} textAnchor="end" style={{ fontSize: 8, fill: C.outline }}>each cycle, over time →</text>
  </svg>);
}
// scatter with ordinary-least-squares regression line
function Scatter({ points, xMax, yMax, xLabel, yLabel }) {
  if (points.length < 4) return null;
  const w = 300, h = 150, pad = 28;
  const px = (x) => pad + (x / xMax) * (w - pad - 8);
  const py = (y) => h - pad - (y / yMax) * (h - pad - 10);
  const n = points.length, mx = points.reduce((a, p) => a + p.x, 0) / n, my = points.reduce((a, p) => a + p.y, 0) / n;
  const den = points.reduce((a, p) => a + (p.x - mx) ** 2, 0) || 1;
  const slope = points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / den, intc = my - slope * mx;
  return (<svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
    <line x1={pad} y1={h - pad} x2={w - 4} y2={h - pad} stroke={C.outlineVar} />
    <line x1={pad} y1={8} x2={pad} y2={h - pad} stroke={C.outlineVar} />
    {points.map((p, i) => { const jx = ((i % 5) - 2) * 0.07, jy = (((i * 3) % 5) - 2) * 0.07;
      return <circle key={i} cx={px(p.x + jx)} cy={py(p.y + jy)} r={3} fill={C.teal} fillOpacity={0.4} />; })}
    <line x1={px(0)} y1={py(Math.max(0, Math.min(yMax, intc)))} x2={px(xMax)} y2={py(Math.max(0, Math.min(yMax, intc + slope * xMax)))} stroke={C.roseOn} strokeWidth={2.5} />
    <text x={(w + pad) / 2} y={h - 6} textAnchor="middle" style={{ fontSize: 9, fill: C.inkVar }}>{xLabel}</text>
    <text x={11} y={(h - pad) / 2 + 4} textAnchor="middle" transform={`rotate(-90 11 ${(h - pad) / 2 + 4})`} style={{ fontSize: 9, fill: C.inkVar }}>{yLabel}</text>
  </svg>);
}
function CorrCard({ icon: Ico, bg, on, habit, symptom, pct, note }) {
  return (<Card style={{ display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
    <span style={{ width: 46, height: 46, borderRadius: 14, background: bg, display: "grid", placeItems: "center", flexShrink: 0 }}><Ico size={20} color={on} /></span>
    <div style={{ flex: 1 }}><div style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 15 }}>{habit}</div><div style={{ fontSize: 13, color: C.inkVar }}>{symptom}</div></div>
    <div style={{ textAlign: "right" }}><div style={{ fontFamily: head, fontWeight: 700, fontSize: 22, color: C.teal }}>{pct}%</div><div style={{ fontSize: 11, color: C.outline }}>{note}</div></div>
  </Card>);
}

// ---- CHAT: text-first daily check-in. Myno gathers patient-specific detail
// (the backend pulls the patient's descriptors, history, adaptation state and
// tracked cycle from the DB), then infers the day's tracking markers, which the
// patient reviews in the side panel and saves to today's log.
function ChatScreen({ profile, settings, setLogs, logs, wide }) {
  const today = new Date().toISOString().slice(0, 10);
  const base = (settings.backendUrl || "/api").replace(/\/$/, "");
  const pid = settings.patientId;
  const opening = `Hi${profile.name ? " " + profile.name : ""} — let's do today's check-in. Did your period start or continue today, and how have you been feeling so far?`;

  const baseEntry = () => ({ date: today, period: null, pain: 0, mood: 5, energy: 5, sugar: 5, hairGrowth: false, hairLoss: false, bloating: false, cravings: false, note: "", categories: [] });
  const fromLog = (l) => l ? { period: l.period ?? null, pain: l.pain ?? 0, mood: l.mood ?? 5, energy: l.energy ?? 5, sugar: l.sugar ?? 5, hairGrowth: !!l.hairGrowth, hairLoss: !!l.hairLoss, bloating: !!l.bloating, cravings: !!l.cravings, note: l.note || "", categories: Array.isArray(l.categories) ? l.categories : [] } : {};

  const [turns, setTurns] = useState([{ role: "assistant", text: opening }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [learned, setLearned] = useState([]);
  const [entry, setEntry] = useState(() => ({ ...baseEntry(), ...fromLog(logs.find((l) => l.date === today)) }));
  const [ended, setEnded] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [status, setStatus] = useState("Waiting");
  const scroller = useRef();
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [turns, busy]);

  const SLIDERS = [
    { key: "pain", label: "Pain", words: scaleLabels.pain },
    { key: "mood", label: "Mood", words: scaleLabels.mood },
    { key: "energy", label: "Energy", words: scaleLabels.energy },
    { key: "sugar", label: "Sugar / cravings", words: scaleLabels.sugar },
  ].filter((m) => !fieldBlocked(settings, m.key));
  const BOOLS = [
    { key: "hairGrowth", label: "Hair growth" },
    { key: "hairLoss", label: "Hair loss" },
    { key: "bloating", label: "Bloating" },
    { key: "cravings", label: "Cravings" },
  ].filter((m) => !fieldBlocked(settings, m.key));

  const cleanCategories = (cats) => (Array.isArray(cats) ? cats : [])
    .filter((c) => c && c.key && c.label).slice(0, 6)
    .map((c) => { const scale = normalizedScale(c.scale); return { key: String(c.key).slice(0, 48), label: String(c.label).slice(0, 80), value: c.value ? String(c.value).slice(0, 160) : "", ...(scale ? { scale } : {}) }; });

  const applyFields = (e, f) => {
    const next = { ...e };
    const set = (k, v, scale) => { if (v === null || v === undefined || fieldBlocked(settings, k)) return; next[k] = scale ? clampScale(v, k === "pain" ? 0 : 5) : v; };
    set("period", f.period);
    set("pain", f.pain, true); set("mood", f.mood, true); set("energy", f.energy, true); set("sugar", f.sugar, true);
    set("hairGrowth", f.hairGrowth || e.hairGrowth); set("hairLoss", f.hairLoss || e.hairLoss);
    set("bloating", f.bloating || e.bloating); set("cravings", f.cravings || e.cravings);
    if (Array.isArray(f.categories)) next.categories = cleanCategories(f.categories);
    return next;
  };

  const send = async (t) => {
    const q = (t || text).trim(); if (!q || busy || ended) return;
    if (!pid) { setError("No patient is set up yet — open the app from Home so Myno can connect to the backend."); return; }
    setError(""); const prior = turns.slice(-20); const next = [...turns, { role: "user", text: q }];
    setTurns(next); setText(""); setBusy(true);
    try {
      const res = await fetch(`${base}/chatbox/patients/${pid}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: q, turns: prior }) });
      let data = {}; try { data = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error(data.detail || `Chat request failed (${res.status}).`);
      setTurns([...next, { role: "assistant", text: data.reply || "" }]);
      if (data.learned?.length) setLearned((p) => [...data.learned, ...p].slice(0, 6));
    } catch (e) {
      setError(e?.message || "Couldn't reach Myno.");
      setTurns([...next, { role: "assistant", text: e?.message || "Something went wrong.", err: true }]);
    } finally { setBusy(false); }
  };

  const saveLog = async (e) => {
    const body = { ...e, date: today };
    if (pid) {
      const res = await fetch(`${base}/patients/${pid}/logs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("Could not save today's log.");
    }
    setLogs([...logs.filter((l) => l.date !== today), body].sort((a, b) => a.date.localeCompare(b.date)));
  };

  const endChat = async () => {
    if (busy) return;
    if (!turns.some((t) => t.role === "user" && t.text.trim())) { setError("Answer at least one question first, then Myno can infer your markers."); return; }
    setError(""); setBusy(true); setStatus("Inferring");
    try {
      const transcript = turns.map((t) => `${t.role === "user" ? "Patient" : "Myno"}: ${t.text}`).join("\n");
      const res = await fetch(`${base}/chatbox/extract`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: transcript, context: entry.note || "", blocked: blockedLabels(settings), categories: entry.categories || [] }) });
      let f = {}; try { f = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error(f.detail || "Marker inference failed.");
      setEntry((e) => applyFields(e, f));
      setEnded(true); setReviewPending(true); setStatus("Review & save");
      const say = f.say ? `${f.say} ` : "";
      setTurns((t0) => [...t0, { role: "assistant", text: `${say}I've inferred today's markers from our chat. Review the panel, adjust anything that feels off, then save your log.` }]);
    } catch (e) {
      setError(e?.message || "I couldn't infer the markers."); setStatus("Failed");
    } finally { setBusy(false); }
  };

  const confirmLog = async () => {
    if (busy) return;
    setBusy(true); setStatus("Saving");
    try { await saveLog(entry); setReviewPending(false); setStatus("Saved"); setTurns((t0) => [...t0, { role: "assistant", text: "Saved today's log with your confirmed markers." }]); }
    catch (e) { setError(e?.message || "Save failed."); setStatus("Save failed"); }
    finally { setBusy(false); }
  };

  const markerEdit = (patch) => { setEntry((e) => ({ ...e, ...patch })); if (ended) setReviewPending(true); };

  const panel = (
    <div style={{ display: "grid", gap: 14 }}>
      <Card style={{ padding: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          <Label>Daily markers</Label>
          <span style={{ fontFamily: bodyf, fontSize: 12, color: C.inkVar }}>{status}</span>
        </div>
        <p style={{ fontSize: 12, color: C.inkVar, margin: "0 0 14px" }}>Inferred from your chat. Adjust anything, then save to today's log.</p>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: bodyf, fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 8 }}>Period today</div>
          <div style={{ display: "flex", gap: 8 }}>
            {[["Yes", true], ["No", false]].map(([l, v]) => (
              <button key={l} onClick={() => markerEdit({ period: v })} style={{ flex: 1, fontFamily: bodyf, fontWeight: 600, fontSize: 14, padding: "10px 0", borderRadius: 12, cursor: "pointer", border: `1.5px solid ${entry.period === v ? C.teal : C.outlineVar}`, background: entry.period === v ? C.tealFixed : C.surface, color: entry.period === v ? C.tealDark : C.inkVar }}>{l}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          {SLIDERS.map((m) => (
            <div key={m.key}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
                <span style={{ fontWeight: 600, color: C.ink }}>{m.label}</span>
                <span style={{ color: C.teal, fontWeight: 600 }}>{scaleDisplay(entry[m.key], 10, m.words)}</span>
              </div>
              <Slider value={clampScale(entry[m.key])} max={10} onChange={(v) => markerEdit({ [m.key]: v })} />
            </div>
          ))}
        </div>

        {BOOLS.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontFamily: bodyf, fontSize: 13, fontWeight: 600, color: C.ink, marginBottom: 8 }}>Other signals</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {BOOLS.map((m) => { const on = !!entry[m.key]; return (
                <button key={m.key} onClick={() => markerEdit({ [m.key]: !on })} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "8px 14px", borderRadius: 9999, cursor: "pointer", border: `1.5px solid ${on ? C.rose : C.outlineVar}`, background: on ? C.rose : C.surface, color: on ? C.roseOn : C.inkVar }}>{m.label}</button>); })}
            </div>
          </div>
        )}

        <Pill onClick={confirmLog} disabled={busy} style={{ width: "100%", marginTop: 16 }}>
          {busy && status === "Saving" ? <Loader2 size={16} className="spin" /> : <Check size={16} />} {status === "Saved" && !reviewPending ? "Saved — update log" : "Save today's log"}
        </Pill>
      </Card>

      <Card style={{ padding: 18 }}>
        <Label>Personal markers</Label>
        <p style={{ fontSize: 12, color: C.inkVar, margin: "4px 0 12px" }}>In your own words, from what you mention in the chat.</p>
        {(entry.categories || []).length === 0 ? (
          <p style={{ fontSize: 13, color: C.inkVar, margin: 0 }}>These appear when you mention symptoms, patterns, or body signals.</p>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {entry.categories.map((c, i) => { const scale = normalizedScale(c.scale); return (
              <div key={c.key || i}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: scale ? 6 : 0 }}>
                  <span style={{ fontWeight: 600, color: C.ink }}>{c.label || c.key}</span>
                  <span style={{ color: scale ? C.teal : C.inkVar, fontWeight: 600 }}>{scale ? `${scale.value}/10` : (c.value || "noted")}</span>
                </div>
                {scale && <Slider value={clampScale(scale.value)} max={10} onChange={(v) => markerEdit({ categories: entry.categories.map((x) => x.key === c.key ? { ...x, scale: { value: clampScale(v), max: 10 } } : x) })} />}
                {scale && c.value && <div style={{ fontSize: 12, color: C.inkVar, marginTop: 4 }}>{c.value}</div>}
              </div>
            ); })}
          </div>
        )}
      </Card>
    </div>
  );

  const chat = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 520 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "6px 0 14px", gap: 12 }}>
        <H size={26}>Daily check-in</H>
        <Pill variant="outline" onClick={endChat} disabled={busy || ended} style={{ padding: "10px 16px", fontSize: 14 }}>{ended ? <><Check size={15} /> Chat ended</> : "End chat & infer markers"}</Pill>
      </div>
      <div ref={scroller} style={{ flex: 1, overflowY: "auto", display: "grid", gap: 12, paddingBottom: 10, maxHeight: 420 }}>
        {turns.map((m, i) => (<div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
          {m.role === "assistant" && <LeafMark size={36} />}
          <div style={{ maxWidth: "80%", padding: "13px 16px", borderRadius: 20, fontSize: 15, lineHeight: 1.45, boxShadow: m.role === "user" ? "none" : SH_SM,
            background: m.role === "user" ? C.teal : m.err ? C.rose : C.surface, color: m.role === "user" ? "#fff" : m.err ? C.error : C.ink, borderTopRightRadius: m.role === "user" ? 4 : 20, borderTopLeftRadius: m.role === "user" ? 20 : 4 }}>{m.text}</div></div>))}
        {busy && !ended && <div style={{ display: "flex", gap: 8, alignItems: "center", color: C.inkVar, fontSize: 13 }}><LeafMark size={36} /><Loader2 size={14} className="spin" /> thinking…</div>}
      </div>
      {learned.length > 0 && (<div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "10px 0", fontSize: 12, color: C.inkVar }}><Sparkles size={13} color={C.roseOn} /> Learning your words:{learned.map((d, i) => (<span key={i} style={{ padding: "3px 9px", borderRadius: 12, background: C.rose, color: C.roseOn }}>{d.concept}: "{d.phrase}"</span>))}</div>)}
      {!ended && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", background: C.surface, borderRadius: 9999, padding: 6, boxShadow: SH, marginTop: 10 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Answer Myno…" disabled={busy} style={{ flex: 1, border: "none", outline: "none", fontFamily: bodyf, fontSize: 16, padding: "8px 14px", background: "transparent" }} />
          <button onClick={() => send()} disabled={busy || !text.trim()} style={{ width: 44, height: 44, borderRadius: "50%", border: "none", background: C.teal, color: "#fff", display: "grid", placeItems: "center", cursor: busy || !text.trim() ? "not-allowed" : "pointer", opacity: busy || !text.trim() ? 0.5 : 1 }}><ArrowRight size={20} /></button>
        </div>
      )}
      {error && <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, padding: "10px 14px", borderRadius: 12, background: C.rose, color: C.error, fontSize: 13, fontWeight: 600 }}><AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} /> {error}</div>}
    </div>
  );

  return (
    <div style={{ display: wide ? "grid" : "block", gridTemplateColumns: wide ? "minmax(0,1fr) 340px" : undefined, gap: 22, alignItems: "start" }}>
      {chat}
      <div style={{ marginTop: wide ? 0 : 22, position: wide ? "sticky" : "static", top: 88 }}>{panel}</div>
    </div>
  );
}

// ---- PREPARE ---------------------------------------------------------------
// ---- ADVOCACY (Prepare + Clinician merged) ---------------------------------
function AdvocacyScreen({ profile, ins, flags, score, decision, axes, settings, setTab }) {
  const [rep, setRep] = useState(null); const [loadingR, setLoadingR] = useState(false);
  useEffect(() => { (async () => {
    const pid = settings.patientId; if (!pid) return; setLoadingR(true);
    try { const b = (settings.backendUrl || "/api").replace(/\/$/, ""); const r = await fetch(`${b}/patients/${pid}/advocacy`, { method: "POST" }); if (r.ok) { const j = await r.json(); setRep(j.report); } } catch (e) { }
    setLoadingR(false);
  })(); }, [settings.patientId]);

  const bandColor = decision.abstain ? "#a9772a" : decision.band === "elevated" ? C.roseOn : C.teal;
  const bandBg = decision.abstain ? "#f6ecd8" : decision.band === "elevated" ? C.rose : C.tealFixed;
  const standCard = (<Card style={{ marginBottom: 14 }}>
    <Label>Where things stand</Label>
    <div style={{ display: "flex", justifyContent: "center", margin: "8px 0" }}><Triad axes={axes} /></div>
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 14, borderRadius: 14, background: bandBg }}>
      {decision.abstain ? <AlertTriangle size={18} color={bandColor} style={{ flexShrink: 0, marginTop: 2 }} /> : <Info size={18} color={bandColor} style={{ flexShrink: 0, marginTop: 2 }} />}
      <span style={{ fontSize: 14, lineHeight: 1.45, color: decision.band === "elevated" ? C.roseOn : C.onTealFixed }}>{decision.abstain ? "Your signs are genuinely on the line — Myno won't guess. A clinician can run what it can't." : decision.band === "elevated" ? "Several signs line up with PCOS. Not a diagnosis — a strong reason to be assessed." : "Few PCOS signs stand out today. Keep tracking; bring this if symptoms persist."}</span></div>
  </Card>);

  // FOR ME — the advocacy report (data-driven talking points)
  const meView = (<>
    {standCard}
    {(loadingR && !rep) && <Card style={{ display: "flex", alignItems: "center", gap: 10, color: C.inkVar, fontSize: 14, marginBottom: 14 }}><Loader2 size={16} className="spin" color={C.teal} /> Preparing your talking points from your data…</Card>}
    {rep?.trends_summary && <Card style={{ marginBottom: 14 }}><Label color={C.inkVar}>Your trends</Label><p style={{ fontSize: 14.5, lineHeight: 1.55, margin: "8px 0 0" }}>{rep.trends_summary}</p></Card>}
    {rep?.flagged_patterns?.length > 0 && <Card style={{ marginBottom: 14 }}><Label color={C.inkVar}>Patterns worth flagging</Label><ul style={{ margin: "10px 0 0", paddingLeft: 18, display: "grid", gap: 7 }}>{rep.flagged_patterns.map((f, i) => <li key={i} style={{ fontSize: 14.5 }}>{f}</li>)}</ul></Card>}
    {(rep?.talking_points || []).map((t, i) => (<Card key={i} style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: head, fontWeight: 600, fontSize: 15.5, lineHeight: 1.45 }}>{t.clinical_framing}</div>
      {t.keywords_phrases?.length > 0 && (<div style={{ marginTop: 12 }}><Label color={C.teal}>Say it like this</Label><ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>{t.keywords_phrases.map((k, j) => <li key={j} style={{ fontSize: 14, lineHeight: 1.45 }}>{k}</li>)}</ul></div>)}
      {t.questions_to_ask?.length > 0 && (<div style={{ marginTop: 12 }}><Label color={C.roseOn}>Ask</Label><ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>{t.questions_to_ask.map((q, j) => <li key={j} style={{ fontSize: 14, lineHeight: 1.45 }}>{q}</li>)}</ul></div>)}
    </Card>))}
    {rep?.documentation_request_text && <Card style={{ marginBottom: 14, background: C.tealFixed, boxShadow: "none" }}><Label color={C.tealDark}>Before you leave</Label><p style={{ fontSize: 14, lineHeight: 1.6, margin: "8px 0 0", color: C.onTealFixed }}>{rep.documentation_request_text}</p></Card>}
    {rep && <div className="no-print"><Pill onClick={() => window.print()} style={{ width: "100%" }}><Printer size={16} /> Print to bring along</Pill></div>}
  </>);

  return (<div>
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 16px" }}>
      <button className="no-print" onClick={() => setTab("home")} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkVar }}><ArrowLeft size={22} /></button><H size={24}>Advocacy</H></div>
    {meView}
  </div>);
}
function Mini({ label, value, flag, amber }) {
  const c = amber ? "#a9772a" : flag ? C.roseOn : C.teal;
  return (<Card style={{ padding: 16 }}><div style={{ fontFamily: bodyf, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", color: C.inkVar, textTransform: "uppercase" }}>{label}</div><div style={{ fontFamily: head, fontWeight: 700, fontSize: 26, color: c }}>{value}</div></Card>);
}

// ---- SETTINGS --------------------------------------------------------------
function SettingsScreen({ settings, setSettings, setLogs, profile, setTab }) {
  const set = (k, v) => setSettings({ ...settings, [k]: v });
  return (<div>
    <H size={28} style={{ margin: "8px 0 16px" }}>Settings</H>
    <Card style={{ marginBottom: 14 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}><input type="checkbox" checked={settings.voice} onChange={(e) => set("voice", e.target.checked)} style={{ accentColor: C.teal, width: 18, height: 18 }} /><span style={{ fontSize: 15 }}>Speak replies aloud</span></label>
    </Card>
    <Card style={{ marginBottom: 14 }}>
      <Label color={C.inkVar}>Block topics — Myno won't ask about or use these</Label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>{Object.entries(FEATURES).map(([k, f]) => { const on = (settings.blacklist || []).includes(k); return (
        <button key={k} onClick={() => set("blacklist", on ? settings.blacklist.filter((x) => x !== k) : [...(settings.blacklist || []), k])} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: 9999, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7, background: on ? C.rose : C.surface, color: on ? C.roseOn : C.inkVar, border: `1.5px solid ${on ? C.rose : C.outlineVar}` }}>{on ? <Lock size={13} /> : <Check size={13} color={C.outlineVar} />} {f.label}</button>); })}</div>
      <p style={{ fontSize: 11, color: C.inkVar, marginTop: 10 }}>Blocked topics vanish from your daily tracker and are never raised in conversation — enforced in-app and on the server.</p>
    </Card>
    <Card onClick={() => setTab("advocacy")} style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
      <span style={{ width: 42, height: 42, borderRadius: 12, background: C.tealFixed, display: "grid", placeItems: "center" }}><Stethoscope size={20} color={C.tealDark} /></span>
      <div style={{ flex: 1 }}><div style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>Advocacy &amp; appointment prep</div><div style={{ fontSize: 13, color: C.inkVar }}>Your talking points and the clinician view</div></div><ChevronRight size={20} color={C.outline} /></Card>
    <p style={{ fontFamily: bodyf, fontSize: 11, color: C.outline, textAlign: "center", marginTop: 18 }}>MYNO · DECISION SUPPORT, NOT A DIAGNOSIS · PROTOTYPE</p>
  </div>);
}
