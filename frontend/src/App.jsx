import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Home, SquarePen, BarChart3, MessageCircle, Settings as Cog, Leaf, Plus,
  ChevronRight, Mic, MicOff, Volume2, Sparkles, Check, Lock, ArrowLeft, ArrowRight,
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

// ---- speaker: NeMo TTS via backend, else browser speechSynthesis -----------
function useSpeaker(settings) {
  const [speaking, setSpeaking] = useState(false);
  const queueRef = useRef([]); const audioRef = useRef(null);
  const stop = useCallback(() => { queueRef.current = []; try { audioRef.current?.pause(); } catch (e) {} try { window.speechSynthesis?.cancel(); } catch (e) {} setSpeaking(false); }, []);
  const playNext = useCallback(async () => {
    const q = queueRef.current; if (!q.length) { setSpeaking(false); return; }
    setSpeaking(true); const text = q.shift(); const base = settings.backendUrl;
    if (base) { try {
      const res = await fetch(`${base.replace(/\/$/, "")}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const blob = await res.blob(); const a = new Audio(URL.createObjectURL(blob)); audioRef.current = a;
      a.onended = () => playNext(); a.onerror = () => playNext(); await a.play(); return;
    } catch (e) {} }
    if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; u.onend = () => playNext(); u.onerror = () => playNext(); window.speechSynthesis.speak(u); }
    else playNext();
  }, [settings.backendUrl]);
  const speak = useCallback((text) => {
    if (!settings.voice || !text) return;
    queueRef.current = (text.match(/[^.!?]+[.!?]*\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);
    if (!speaking) playNext();
  }, [settings.voice, speaking, playNext]);
  useEffect(() => () => stop(), [stop]);
  return { speak, stop, speaking };
}

// ---- chat: backend orchestrator if configured, else Claude direct ----------
async function chatTurn({ settings, message, history, system }) {
  const base = settings.backendUrl;
  if (base && settings.patientId) { try {
    const res = await fetch(`${base.replace(/\/$/, "")}/patients/${settings.patientId}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
    const j = await res.json(); return { reply: j.reply, learned: j.learned || [] };
  } catch (e) {} }
  const api = history.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
  api.push({ role: "user", content: message });
  const reply = await callClaude({ apiKey: settings.apiKey, system, messages: api });
  return { reply, learned: [] };
}

// ---- voice capture: NeMo streaming WS, else Web Speech ---------------------
class VoiceController {
  constructor({ endpoint, onPartial, onFinal, onState, onError }) {
    this.endpoint = endpoint; this.onPartial = onPartial; this.onFinal = onFinal; this.onState = onState; this.onError = onError;
    this.mode = endpoint ? "nemo" : ((window.SpeechRecognition || window.webkitSpeechRecognition) ? "webspeech" : "none");
  }
  available() { return this.mode !== "none"; }
  async start() { if (this.mode === "nemo") return this._nemo(); if (this.mode === "webspeech") return this._web(); this.onError?.("Voice isn't available here — please type."); }
  stop() { if (this.mode === "nemo") this._stopNemo(); else if (this.mode === "webspeech") { try { this.rec?.stop(); } catch (e) {} } this.onState?.(false); }
  _web() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; const rec = new SR();
    rec.lang = "en-US"; rec.interimResults = true; rec.continuous = false;
    rec.onstart = () => this.onState?.(true);
    rec.onerror = (e) => { this.onState?.(false); this.onError?.(e.error === "not-allowed" ? "Microphone blocked — type instead." : "Didn't catch that — try again."); };
    rec.onend = () => this.onState?.(false);
    rec.onresult = (ev) => { let f = "", p = ""; for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) f += r[0].transcript; else p += r[0].transcript; } if (p) this.onPartial?.(p); if (f) { try { rec.stop(); } catch (e) {} this.onFinal?.(f.trim()); } };
    this.rec = rec; rec.start();
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
function useVoice({ settings, onPartial, onFinal }) {
  const [listening, setListening] = useState(false); const [note, setNote] = useState(""); const ref = useRef(null);
  const toggle = useCallback(() => {
    if (listening) { ref.current?.stop(); return; } setNote("");
    const c = new VoiceController({ endpoint: settings.nemoEndpoint || null, onPartial, onFinal, onState: setListening, onError: setNote });
    ref.current = c; if (!c.available()) { setNote("Voice isn't available here — please type."); return; } c.start();
  }, [listening, settings.nemoEndpoint, onPartial, onFinal]);
  useEffect(() => () => { try { ref.current?.stop(); } catch (e) {} }, []);
  return { listening, note, toggle };
}

// ---- synthetic data + insights + scoring (carried over) --------------------
function genSyntheticLogs() {
  const logs = [], today = new Date(); const cyc = () => 38 + Math.floor(Math.random() * 8); let since = 3, cur = cyc();
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i); const date = d.toISOString().slice(0, 10);
    const sugar = Math.floor(Math.random() * 5); const prev = logs.length ? logs[logs.length - 1].sugar : 0; const isP = since === 0;
    let pain = 1 + Math.round(Math.random()); if (isP || since === 1) pain += 4; pain += Math.round(prev * 0.9); pain = Math.max(0, Math.min(10, pain));
    const pre = since > cur - 3; const mood = Math.max(0, Math.min(4, 3 - (pre ? 2 : 0) - (pain > 6 ? 1 : 0) + Math.round(Math.random() - 0.5)));
    const energy = Math.max(0, Math.min(4, 3 - (pain > 6 ? 1 : 0) + Math.round(Math.random() - 0.5)));
    logs.push({ date, period: isP, pain, sugar, mood, energy, hairGrowth: Math.random() < 0.28, hairLoss: Math.random() < 0.14, bloating: pain > 5 || Math.random() < 0.2, cravings: prev > 2 || Math.random() < 0.2, note: "" });
    since++; if (since >= cur) { since = 0; cur = cyc(); }
  }
  return logs;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function computeInsights(logs) {
  const periods = logs.filter((l) => l.period).map((l) => l.date); const gaps = [];
  for (let i = 1; i < periods.length; i++) gaps.push(Math.round((new Date(periods[i]) - new Date(periods[i - 1])) / 86400000));
  const avgGap = gaps.length ? Math.round(mean(gaps)) : null;
  const hiNext = [], loNext = []; for (let i = 1; i < logs.length; i++) (logs[i - 1].sugar >= 3 ? hiNext : loNext).push(logs[i].pain);
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
  const [settings, setSettings] = useState({ apiKey: "", nemoEndpoint: "", backendUrl: "", voice: true, blacklist: [], patientId: null });
  const vw = useViewport();
  const wide = vw >= 1024;

  useEffect(() => { (async () => { const s = await loadState();
    if (s) { setProfile(s.profile || BLANK); setLogs(s.logs?.length ? s.logs : genSyntheticLogs()); setSettings({ apiKey: "", nemoEndpoint: "", backendUrl: "", voice: true, blacklist: [], patientId: null, ...(s.settings || {}) }); }
    else setLogs(genSyntheticLogs()); setReady(true); })(); }, []);
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
    {tab === "prepare" && <PrepareScreen {...ctx} />}
    {tab === "clinician" && <ClinicianScreen {...ctx} />}
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

  const contentMax = { home: 1140, insights: 1140, clinician: 940, prepare: 880, chat: 720, record: 620, settings: 640 }[tab] || 1080;
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
  const items = [["home", "Home"], ["record", "Record"], ["insights", "Insights"], ["chat", "Chat"], ["prepare", "Prepare"], ["clinician", "Clinician"]];
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
  const setPeriod = (v) => { const e = { date: todayStr, period: v, pain: today?.pain ?? 0, sugar: today?.sugar ?? 2, mood: today?.mood ?? 2, energy: today?.energy ?? 2, hairGrowth: today?.hairGrowth || false, hairLoss: today?.hairLoss || false, bloating: today?.bloating || false, cravings: today?.cravings || false, note: today?.note || "" }; setLogs([...logs.filter((l) => l.date !== todayStr), e].sort((a, b) => a.date.localeCompare(b.date))); };
  const now = new Date(); const phase = ins.dayN == null ? "—" : ins.dayN <= 5 ? "Menstrual" : ins.dayN <= 13 ? "Follicular" : ins.dayN <= 16 ? "Ovulatory" : "Luteal";
  const chips = []; if (today) { if (today.pain >= 6) chips.push("High pain"); else if (today.pain > 0) chips.push("Mild pain"); if (today.hairGrowth || today.hairLoss) chips.push("Hair health"); if (today.bloating) chips.push("Bloating"); if (today.cravings) chips.push("Cravings"); if (today.mood <= 1) chips.push("Low mood"); }

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
    <Card onClick={() => setTab("prepare")} style={{ display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
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
function RecordScreen({ logs, setLogs, settings, setTab }) {
  const [mode, setMode] = useState("quiz");
  const todayStr = new Date().toISOString().slice(0, 10);
  const existing = logs.find((l) => l.date === todayStr);
  const [e, setE] = useState(existing || { date: todayStr, period: existing?.period ?? null, pain: 0, sugar: 2, mood: 2, energy: 2, hairGrowth: false, hairLoss: false, bloating: false, cravings: false, note: "" });
  const [saved, setSaved] = useState(false);
  const set = (k, v) => { setE((p) => ({ ...p, [k]: v })); setSaved(false); };
  const save = () => { setLogs([...logs.filter((l) => l.date !== e.date), e].sort((a, b) => a.date.localeCompare(b.date))); setSaved(true); };

  return (<div>
    <div style={{ display: "flex", justifyContent: "center", margin: "8px 0 20px" }}><ModeToggle mode={mode} setMode={setMode} /></div>
    {mode === "quiz" ? (<>
      <H size={26} style={{ marginBottom: 4 }}>Record your day</H>
      <p style={{ color: C.inkVar, marginBottom: 20 }}>However your body is today — no judgement.</p>
      {!fieldBlocked(settings, "pain") && (<Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}><span style={{ fontFamily: head, fontWeight: 600, fontSize: 17 }}>Rate pain</span><span style={{ fontFamily: head, fontWeight: 700, fontSize: 22, color: C.teal }}>{e.pain}<span style={{ fontSize: 13, color: C.outline }}>/10</span></span></div>
        <Slider value={e.pain} max={10} onChange={(v) => set("pain", v)} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.outline, marginTop: 8 }}><span>None</span><span>Severe</span></div></Card>)}
      <Card style={{ marginBottom: 14, display: "grid", gap: 16 }}>
        {!fieldBlocked(settings, "mood") && <ScaleRow label="Mood" value={e.mood} onChange={(v) => set("mood", v)} words={["very low", "low", "okay", "good", "great"]} />}
        <ScaleRow label="Energy" value={e.energy} onChange={(v) => set("energy", v)} words={["drained", "low", "okay", "good", "high"]} />
        {!fieldBlocked(settings, "sugar") && <ScaleRow label="Sugary food" value={e.sugar} onChange={(v) => set("sugar", v)} words={["none", "a little", "some", "a lot", "loads"]} />}
      </Card>
      <Card style={{ marginBottom: 18 }}>
        <Label color={C.inkVar}>Symptoms today</Label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
          {!fieldBlocked(settings, "hairGrowth") && <Chip active={e.hairGrowth} onClick={() => set("hairGrowth", !e.hairGrowth)}>Hair growth</Chip>}
          {!fieldBlocked(settings, "hairLoss") && <Chip active={e.hairLoss} onClick={() => set("hairLoss", !e.hairLoss)}>Hair loss</Chip>}
          <Chip active={e.bloating} onClick={() => set("bloating", !e.bloating)}>Bloating</Chip>
          {!fieldBlocked(settings, "cravings") && <Chip active={e.cravings} onClick={() => set("cravings", !e.cravings)}>Cravings</Chip>}
        </div></Card>
      <Pill onClick={save} style={{ width: "100%" }}>{saved ? <><Check size={18} /> Saved</> : <><Plus size={18} /> Save today</>}</Pill>
    </>) : (<RecordConvo settings={settings} entry={e} setE={setE} onSave={(merged) => { setLogs([...logs.filter((l) => l.date !== merged.date), merged].sort((a, b) => a.date.localeCompare(b.date))); }} />)}
  </div>);
}
function ModeToggle({ mode, setMode }) {
  return (<div style={{ display: "inline-flex", background: C.container, borderRadius: 9999, padding: 4 }}>
    {["quiz", "convo"].map((m) => (<button key={m} onClick={() => setMode(m)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, letterSpacing: "0.05em", textTransform: "uppercase", padding: "10px 28px", borderRadius: 9999, cursor: "pointer", border: "none", background: mode === m ? C.teal : "transparent", color: mode === m ? "#fff" : C.inkVar }}>{m}</button>))}</div>);
}
function ScaleRow({ label, value, onChange, words }) {
  return (<div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><span style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>{label}</span><span style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, color: C.teal }}>{words[value]}</span></div><Slider value={value} max={4} onChange={onChange} /></div>);
}
function RecordConvo({ settings, entry, setE, onSave }) {
  const [partial, setPartial] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false); const [text, setText] = useState("");
  const ingest = async (said) => {
    setPartial(""); setBusy(true); const note = (entry.note ? entry.note + " " : "") + said;
    let merged = { ...entry, note };
    try {
      const sys = `Extract PCOS daily-log fields from the user's spoken day. ONLY JSON: {"period":true|false|null,"pain":0-10|null,"mood":0-4|null,"energy":0-4|null,"sugar":0-4|null,"hairGrowth":bool,"hairLoss":bool,"bloating":bool,"cravings":bool}. Only set what's clearly implied.`;
      const out = await callClaude({ apiKey: settings.apiKey, maxTokens: 400, messages: [{ role: "user", content: `${sys}\n\nThey said: "${said}"` }] });
      const f = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
      merged = { ...merged, period: f.period ?? merged.period, pain: f.pain ?? merged.pain, mood: f.mood ?? merged.mood, energy: f.energy ?? merged.energy, sugar: f.sugar ?? merged.sugar, hairGrowth: f.hairGrowth || merged.hairGrowth, hairLoss: f.hairLoss || merged.hairLoss, bloating: f.bloating || merged.bloating, cravings: f.cravings || merged.cravings };
    } catch (err) {}
    setE(merged); onSave(merged); setBusy(false); setDone(true); setTimeout(() => setDone(false), 2500);
  };
  const voice = useVoice({ settings, onPartial: setPartial, onFinal: (t) => ingest(t) });
  return (<div style={{ minHeight: 420, display: "flex", flexDirection: "column" }}>
    <div style={{ fontFamily: head, fontWeight: 800, fontSize: 30, color: C.tealFixedDim, lineHeight: 1.05, marginBottom: 24 }}>Talk to<br />Myno</div>
    <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}><span style={{ background: C.container, color: C.inkVar, fontFamily: bodyf, fontWeight: 600, fontSize: 12, letterSpacing: "0.05em", padding: "7px 16px", borderRadius: 9999 }}>{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }).toUpperCase()}</span></div>
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 16 }}><LeafMark size={44} /><div style={{ background: C.surface, borderRadius: 20, borderTopLeftRadius: 4, padding: "16px 18px", boxShadow: SH, fontSize: 17, lineHeight: 1.4 }}>How have your symptoms been today?</div></div>
    {(partial || busy || done) && (<div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}><div style={{ background: C.tealFixed, color: C.onTealFixed, borderRadius: 18, padding: "11px 15px", fontSize: 15, maxWidth: "82%" }}>{partial ? <i>{partial}…</i> : busy ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Loader2 size={13} className="spin" /> noting it down…</span> : <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Check size={14} /> Saved to today</span>}</div></div>)}
    <div style={{ flex: 1 }} />
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>{["Better than yesterday", "Feeling some pain", "No changes"].map((c) => (<button key={c} onClick={() => ingest(c)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, padding: "11px 16px", borderRadius: 9999, background: C.surface, border: `1.5px solid ${C.outlineVar}`, color: C.ink, cursor: "pointer", boxShadow: SH_SM }}>{c}</button>))}</div>
    <div style={{ display: "flex", gap: 10, alignItems: "center", background: C.surface, borderRadius: 9999, padding: 6, boxShadow: SH }}>
      <input value={text} onChange={(ev) => setText(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter" && text.trim()) { ingest(text.trim()); setText(""); } }} placeholder={voice.listening ? "Listening…" : "Say it or type it…"} style={{ flex: 1, border: "none", outline: "none", fontFamily: bodyf, fontSize: 16, padding: "8px 14px", background: "transparent" }} />
      <MicBtn listening={voice.listening} onClick={voice.toggle} />
    </div>
    {voice.note && <p style={{ fontSize: 12, color: C.error, textAlign: "center", marginTop: 10 }}>{voice.note}</p>}
  </div>);
}
function MicBtn({ listening, onClick, size = 46 }) {
  return (<button onClick={onClick} style={{ width: size, height: size, borderRadius: "50%", border: "none", cursor: "pointer", display: "grid", placeItems: "center", flexShrink: 0, background: listening ? C.roseOn : C.teal, color: "#fff", boxShadow: listening ? `0 0 0 5px ${C.rose}` : "none", animation: listening ? "pulse 1.4s infinite" : "none" }}>{listening ? <MicOff size={size * 0.42} /> : <Mic size={size * 0.42} />}</button>);
}

// ---- INSIGHTS (twin) -------------------------------------------------------
function InsightsScreen({ ins, logs, settings, wide }) {
  const filters = ["Pain", "Acne", "Hair Growth", "Mood"].filter((f) => !(f === "Mood" && isBlocked(settings, "mood")));
  const [filter, setFilter] = useState("Pain");
  const painDelta = ins.painHi - ins.painLo;
  const series = logs.slice(-30).map((l) => l.pain);
  const sugarCorr = Math.min(99, Math.round((painDelta / Math.max(0.1, ins.painHi)) * 100 + 40));
  const bloatCorr = Math.min(99, Math.round(((ins.bloatPain - ins.noBloatPain) / Math.max(0.1, ins.bloatPain)) * 100 + 45));

  const patternCard = !isBlocked(settings, "diet") && painDelta > 0.8 && (<div style={{ background: C.tealC, borderRadius: 22, padding: 22, boxShadow: SH }}>
    <div style={{ display: "flex", gap: 12, marginBottom: 14 }}><span style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(255,255,255,0.18)", display: "grid", placeItems: "center", flexShrink: 0 }}><Sparkles size={18} color="#fff" /></span>
      <div><div style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, color: C.tealFixed, marginBottom: 4 }}>I've noticed a pattern</div>
        <p style={{ color: "#fff", fontSize: 15, lineHeight: 1.5, margin: 0 }}>On days you record a high intake of sugar, your pain tends to spike about a day later — around {painDelta.toFixed(1)} points higher. Want to track meals more closely this week?</p></div></div>
    <div style={{ display: "flex", gap: 10 }}><Pill variant="filled" style={{ background: "#fff", color: C.teal, flex: 1 }}>Yes, track it</Pill><Pill variant="outline" style={{ background: "transparent", color: "#fff", borderColor: "rgba(255,255,255,0.5)", flex: 1 }}>Maybe later</Pill></div></div>);
  const trendsCard = (<Card>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
      <div><div style={{ fontFamily: head, fontWeight: 600, fontSize: 17 }}>{filter} trends</div><div style={{ fontSize: 13, color: C.inkVar }}>Past 30 days · avg {ins.avgPain.toFixed(1)}/10</div></div>
      <div style={{ textAlign: "right", color: C.teal, fontFamily: bodyf, fontWeight: 600, fontSize: 14 }}>{series[series.length - 1] <= series[0] ? "↘ lower" : "↗ higher"}</div></div>
    <Sparkline series={series} />
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.outline, marginTop: 6 }}><span>30d ago</span><span>Today</span></div></Card>);
  const correlations = (<div>
    <Label color={C.inkVar}>Correlations</Label>
    <div style={{ display: "grid", gap: 12, marginTop: 10 }}>
      {!isBlocked(settings, "diet") && <CorrCard icon={Droplet} bg={C.rose} on={C.roseOn} habit="High sugar intake" symptom="Next-day pain" pct={sugarCorr} note="Correlation" />}
      <CorrCard icon={Activity} bg={C.tealFixed} on={C.tealDark} habit="Bloating days" symptom="Pain levels" pct={bloatCorr} note="Co-occurrence" />
    </div></div>);
  const highlights = (<Card style={{ background: C.low, boxShadow: "none" }}>
    <Label color={C.inkVar}>Historical highlights</Label>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
      <div style={{ background: C.surface, borderRadius: 14, padding: 16 }}><Microscope size={18} color={C.teal} /><div style={{ fontFamily: head, fontWeight: 700, fontSize: 24, marginTop: 8 }}>{ins.highPainGap} days</div><div style={{ fontSize: 12, color: C.inkVar }}>since last high-pain episode</div></div>
      <div style={{ background: C.surface, borderRadius: 14, padding: 16 }}><Heart size={18} color={C.roseOn} /><div style={{ fontFamily: head, fontWeight: 700, fontSize: 24, marginTop: 8 }}>{ins.loggedDays} days</div><div style={{ fontSize: 12, color: C.inkVar }}>consistent logging</div></div>
    </div></Card>);
  const disclaimer = (<div style={{ padding: 14, background: C.surface, borderRadius: 14, fontSize: 12, color: C.inkVar, lineHeight: 1.5, display: "flex", gap: 8 }}>
    <Info size={15} color={C.teal} style={{ flexShrink: 0, marginTop: 2 }} />These are associations from your own logs, not certainties — and a roadmap feature uses federated learning to sharpen them across the community while your raw data stays on your device.</div>);
  const chipsRow = (<div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 6, marginBottom: 18 }}>{filters.map((f) => (
    <button key={f} onClick={() => setFilter(f)} style={{ flexShrink: 0, fontFamily: bodyf, fontWeight: 600, fontSize: 14, padding: "9px 18px", borderRadius: 9999, cursor: "pointer", border: "none", background: filter === f ? C.teal : C.container, color: filter === f ? "#fff" : C.inkVar }}>{f}</button>))}</div>);

  if (wide) return (<div>
    <H size={28} style={{ marginBottom: 16 }}>Insights</H>{chipsRow}
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
      <div style={{ display: "grid", gap: 18 }}>{patternCard}{trendsCard}</div>
      <div style={{ display: "grid", gap: 18 }}>{correlations}{highlights}</div>
    </div>
    <div style={{ marginTop: 20 }}>{disclaimer}</div>
  </div>);

  return (<div>
    <H size={28} style={{ margin: "8px 0 14px" }}>Insights</H>{chipsRow}
    {patternCard && <div style={{ marginBottom: 18 }}>{patternCard}</div>}
    <div style={{ marginBottom: 18 }}>{trendsCard}</div>
    <div style={{ marginBottom: 18 }}>{correlations}</div>
    {highlights}
    <div style={{ marginTop: 16 }}>{disclaimer}</div>
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
function CorrCard({ icon: Ico, bg, on, habit, symptom, pct, note }) {
  return (<Card style={{ display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
    <span style={{ width: 46, height: 46, borderRadius: 14, background: bg, display: "grid", placeItems: "center", flexShrink: 0 }}><Ico size={20} color={on} /></span>
    <div style={{ flex: 1 }}><div style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 15 }}>{habit}</div><div style={{ fontSize: 13, color: C.inkVar }}>{symptom}</div></div>
    <div style={{ textAlign: "right" }}><div style={{ fontFamily: head, fontWeight: 700, fontSize: 22, color: C.teal }}>{pct}%</div><div style={{ fontSize: 11, color: C.outline }}>{note}</div></div>
  </Card>);
}

// ---- CHAT (convo mode + voice mode + TTS) ----------------------------------
function ChatScreen({ profile, settings, ins }) {
  const greeting = `Hi${profile.name ? " " + profile.name : ""} — I'm here whenever something's on your mind. I can't diagnose you, but I can help you understand things and prepare. What's going on?`;
  const [msgs, setMsgs] = useState([{ role: "assistant", text: greeting }]);
  const [text, setText] = useState(""); const [loading, setLoading] = useState(false); const [partial, setPartial] = useState("");
  const [voiceMode, setVoiceMode] = useState(false); const [learned, setLearned] = useState([]);
  const scroller = useRef(); const speaker = useSpeaker(settings); const vmRef = useRef(false);
  useEffect(() => { vmRef.current = voiceMode; }, [voiceMode]);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [msgs, loading, partial]);

  const buildSys = () => { const blocked = blockedLabels(settings); return `You are Myno, a warm voice companion for someone navigating possible or diagnosed PCOS. Acknowledge feelings in their own words, then ask ONE relevant next question.
You know PCOS: Rotterdam criteria (2 of 3 — irregular ovulation; clinical/biochemical hyperandrogenism; polycystic morphology on ultrasound), exclude mimics (thyroid, prolactin, CAH, Cushing's); links to insulin resistance, type 2 diabetes, cardiovascular and mood risks. Goals: ${profile.goals.join(", ") || "not set"}. Tracked cycle ~${ins.avgGap ?? "?"} days.
NEVER ask about or volunteer anything blocked: ${blocked.length ? blocked.join(", ") : "none"}. NEVER diagnose; a clinician decides — offer to help prepare. No drug doses.${settings.voice ? " Spoken aloud — keep under ~45 words." : " Under 130 words."}`; };

  const send = async (t) => {
    const q = (t || text).trim(); if (!q || loading) return;
    setPartial(""); const history = [...msgs, { role: "user", text: q }]; setMsgs(history); setText(""); setLoading(true); speaker.stop();
    try { const { reply, learned: lrn } = await chatTurn({ settings, message: q, history: msgs, system: buildSys() });
      const r = reply || "I'm here — could you say a little more?"; setMsgs([...history, { role: "assistant", text: r }]);
      if (lrn?.length) setLearned((p) => [...lrn, ...p].slice(0, 6)); speaker.speak(r);
      if (vmRef.current) setTimeout(() => { if (vmRef.current && !voice.listening) voice.toggle(); }, 600);
    } catch (e) { setMsgs([...history, { role: "assistant", text: "I couldn't reach my words just now — try again in a moment." }]); }
    finally { setLoading(false); }
  };
  const voice = useVoice({ settings, onPartial: setPartial, onFinal: (t) => send(t) });
  useEffect(() => { if (voiceMode) { speaker.speak(msgs[msgs.length - 1]?.text || greeting); setTimeout(() => { if (vmRef.current && !voice.listening) voice.toggle(); }, 1400); } else { speaker.stop(); if (voice.listening) voice.toggle(); } }, [voiceMode]);

  if (voiceMode) return (<div style={{ textAlign: "center", paddingTop: 10, minHeight: 500 }}>
    <div style={{ fontFamily: head, fontWeight: 800, fontSize: 30, color: C.tealFixedDim, lineHeight: 1.05, textAlign: "left", marginBottom: 30 }}>Convo<br />mode</div>
    <div style={{ display: "grid", placeItems: "center", marginBottom: 18 }}>
      <div style={{ width: 140, height: 140, borderRadius: "50%", display: "grid", placeItems: "center", background: voice.listening ? C.rose : speaker.speaking ? C.tealFixed : C.surface, border: `2px solid ${voice.listening ? C.roseOn : speaker.speaking ? C.teal : C.outlineVar}`, boxShadow: SH, animation: (voice.listening || speaker.speaking) ? "pulse 1.6s infinite" : "none" }}>
        {speaker.speaking ? <Volume2 size={46} color={C.teal} /> : voice.listening ? <Mic size={46} color={C.roseOn} /> : <MicOff size={42} color={C.outline} />}</div>
      <div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", color: C.inkVar, marginTop: 14 }}>{speaker.speaking ? "MYNO IS SPEAKING" : voice.listening ? "LISTENING…" : loading ? "THINKING…" : "TAP TO SPEAK"}</div>
    </div>
    <Card style={{ minHeight: 90, textAlign: "left", boxShadow: SH }}><div style={{ fontSize: 16, lineHeight: 1.5 }}>{partial ? <i style={{ color: C.inkVar }}>{partial}…</i> : msgs[msgs.length - 1]?.text}</div></Card>
    <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 22 }}>
      <Pill variant={voice.listening ? "rose" : "filled"} onClick={voice.toggle}>{voice.listening ? <><MicOff size={16} /> Stop</> : <><Mic size={16} /> Speak</>}</Pill>
      <Pill variant="soft" onClick={() => setVoiceMode(false)}>Exit</Pill></div>
    {voice.note && <p style={{ fontSize: 12, color: C.error, marginTop: 12 }}>{voice.note}</p>}
  </div>);

  return (<div style={{ display: "flex", flexDirection: "column", minHeight: 520 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "6px 0 14px" }}>
      <H size={26}>Talk to Myno</H><Pill variant="outline" onClick={() => setVoiceMode(true)} style={{ padding: "10px 16px", fontSize: 14 }}><Volume2 size={15} /> Voice</Pill></div>
    <div ref={scroller} style={{ flex: 1, overflowY: "auto", display: "grid", gap: 12, paddingBottom: 10, maxHeight: 380 }}>
      {msgs.map((m, i) => (<div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
        {m.role === "assistant" && <LeafMark size={36} />}
        <div style={{ maxWidth: "80%", padding: "13px 16px", borderRadius: 20, fontSize: 15, lineHeight: 1.45, boxShadow: m.role === "user" ? "none" : SH_SM,
          background: m.role === "user" ? C.teal : C.surface, color: m.role === "user" ? "#fff" : C.ink, borderTopRightRadius: m.role === "user" ? 4 : 20, borderTopLeftRadius: m.role === "user" ? 20 : 4 }}>{m.text}</div></div>))}
      {partial && <div style={{ display: "flex", justifyContent: "flex-end" }}><div style={{ background: C.tealFixed, color: C.onTealFixed, borderRadius: 18, padding: "11px 15px", fontSize: 15, fontStyle: "italic" }}>{partial}…</div></div>}
      {loading && <div style={{ display: "flex", gap: 8, alignItems: "center", color: C.inkVar, fontSize: 13 }}><LeafMark size={36} /><Loader2 size={14} className="spin" /> thinking…</div>}
    </div>
    {msgs.length <= 1 && (<div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "4px 0 12px" }}>{["I'm scared this is PCOS", "Why are my periods irregular?", "How do I bring this up with my GP?"].map((c) => (<button key={c} onClick={() => send(c)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: 9999, background: C.surface, border: `1.5px solid ${C.outlineVar}`, color: C.ink, cursor: "pointer" }}>{c}</button>))}</div>)}
    {learned.length > 0 && (<div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10, fontSize: 12, color: C.inkVar }}><Sparkles size={13} color={C.roseOn} /> Learning your words:{learned.map((d, i) => (<span key={i} style={{ padding: "3px 9px", borderRadius: 12, background: C.rose, color: C.roseOn }}>{d.concept}: "{d.phrase}"</span>))}</div>)}
    <div style={{ display: "flex", gap: 10, alignItems: "center", background: C.surface, borderRadius: 9999, padding: 6, boxShadow: SH }}>
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={voice.listening ? "Listening…" : "Say it or type it…"} style={{ flex: 1, border: "none", outline: "none", fontFamily: bodyf, fontSize: 16, padding: "8px 14px", background: "transparent" }} />
      <MicBtn listening={voice.listening} onClick={voice.toggle} />
    </div>
    {voice.note && <p style={{ fontSize: 12, color: C.error, textAlign: "center", marginTop: 10 }}>{voice.note}</p>}
  </div>);
}

// ---- PREPARE ---------------------------------------------------------------
function PrepareScreen({ profile, ins, flags, score, decision, axes, settings, setTab }) {
  const [summary, setSummary] = useState(""); const [loading, setLoading] = useState(false);
  const bandColor = decision.abstain ? "#a9772a" : decision.band === "elevated" ? C.roseOn : C.teal;
  const bandBg = decision.abstain ? "#f6ecd8" : decision.band === "elevated" ? C.rose : C.tealFixed;
  const flagList = [flags.irregularCycle && `Cycles averaging ${ins.avgGap} days (irregular)`,
    !isBlocked(settings, "hair_skin") && (flags.mfgHigh || flags.selfHirsutism) && "Excess hair growth",
    !isBlocked(settings, "hair_skin") && flags.alopecia && "Scalp hair thinning", flags.acne && "Persistent acne",
    !isBlocked(settings, "weight") && flags.weightGain && "Difficult weight gain",
    !isBlocked(settings, "diet") && !isBlocked(settings, "pain") && (ins.painHi - ins.painLo) > 1 && "Pain rising after high-sugar days"].filter(Boolean);
  const questions = ["Could my symptoms be PCOS, and what else could explain them?", "Which blood tests and scans do I need, and when?",
    (profile.goals.includes("conceive") && !isBlocked(settings, "fertility")) ? "How does this affect my chances of conceiving?" : "What can I do about my most bothersome symptom?"];
  const gen = async () => { setLoading(true); try {
    const findings = { age: profile.age, avgCycle: ins.avgGap, band: decision.abstain ? "uncertain" : decision.band, ovulatory: axes.ovulatory.met, androgen: axes.androgen.met, flags: flagList, goals: profile.goals };
    const out = await callClaude({ apiKey: settings.apiKey, maxTokens: 500, messages: [{ role: "user", content: `Write a short neutral plain-language PCOS pre-screen summary. Never diagnose; only use these findings; under 85 words; warm.\n${JSON.stringify(findings)}` }] });
    setSummary(out); } catch (e) {} setLoading(false); };
  return (<div>
    <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 14px" }}>
      <button onClick={() => setTab("home")} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkVar }}><ArrowLeft size={22} /></button><H size={24}>Prepare</H></div>
    <Card style={{ marginBottom: 14 }}>
      <Label>Where things stand</Label>
      <div style={{ display: "flex", justifyContent: "center", margin: "8px 0" }}><Triad axes={axes} /></div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 14, borderRadius: 14, background: bandBg }}>
        {decision.abstain ? <AlertTriangle size={18} color={bandColor} style={{ flexShrink: 0, marginTop: 2 }} /> : <Info size={18} color={bandColor} style={{ flexShrink: 0, marginTop: 2 }} />}
        <span style={{ fontSize: 14, lineHeight: 1.45, color: decision.band === "elevated" ? C.roseOn : C.onTealFixed }}>{decision.abstain ? "Your signs are genuinely on the line — Myno won't guess. A clinician can run what it can't." : decision.band === "elevated" ? "Several signs line up with PCOS. Not a diagnosis — a strong reason to be assessed." : "Few PCOS signs stand out today. Keep tracking; bring this if symptoms persist."}</span></div>
    </Card>
    <Card style={{ marginBottom: 14 }}><Label color={C.inkVar}>Symptoms to flag</Label>
      {flagList.length ? <ul style={{ margin: "10px 0 0", paddingLeft: 18, display: "grid", gap: 7 }}>{flagList.map((f) => (<li key={f} style={{ fontSize: 15 }}>{f}</li>))}</ul> : <p style={{ fontSize: 14, color: C.inkVar, marginTop: 8 }}>Nothing notable yet — keep tracking.</p>}</Card>
    <Card style={{ marginBottom: 14 }}><Label color={C.inkVar}>Questions to ask</Label><ul style={{ margin: "10px 0 0", paddingLeft: 18, display: "grid", gap: 7 }}>{questions.map((q) => (<li key={q} style={{ fontSize: 15 }}>{q}</li>))}</ul></Card>
    {summary && <Card style={{ marginBottom: 14, background: C.tealFixed, boxShadow: "none" }}><Label color={C.tealDark}>Plain-language summary</Label><p style={{ fontSize: 14, lineHeight: 1.6, margin: "8px 0 0", color: C.onTealFixed }}>{summary}</p></Card>}
    <div style={{ display: "flex", gap: 10 }}>
      <Pill variant="outline" onClick={gen} disabled={loading} style={{ flex: 1 }}>{loading ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />} Summary</Pill>
      <Pill onClick={() => window.print()} style={{ flex: 1 }}><Printer size={16} /> Print</Pill></div>
  </div>);
}

// ---- CLINICIAN -------------------------------------------------------------
function ClinicianScreen({ profile, ins, flags, score, decision, axes, setTab }) {
  const [dec, setDec] = useState(null); const bmi = flags.bmi ? flags.bmi.toFixed(1) : "—";
  const tests = [(flags.mfgHigh || flags.selfHirsutism || flags.acne || flags.alopecia) && "Total & free testosterone, SHBG, FAI",
    "TSH + prolactin — exclude thyroid / hyperprolactinaemia", "17-OHP — exclude non-classic CAH",
    (flags.irregularCycle || flags.longCycle) && "Pelvic ultrasound — antral follicle count",
    (flags.highBMI || flags.acanthosis) && "HbA1c / OGTT + fasting lipids"].filter(Boolean);
  return (<div>
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 4px" }}>
      <button onClick={() => setTab("settings")} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkVar }}><ArrowLeft size={22} /></button>
      <div><Label>Clinician view</Label><H size={22}>{profile.name || "Patient"} · longitudinal</H></div></div>
    <p style={{ color: C.inkVar, fontSize: 14, margin: "8px 0 16px" }}>Three months of patient-reported tracking, the twin's associations, and a flagged model read you can override.</p>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
      <Mini label="Avg cycle" value={`${ins.avgGap ?? "—"}d`} flag={ins.avgGap > 35} />
      <Mini label="BMI" value={bmi} flag={flags.bmi >= 30} />
      <Mini label="Avg pain" value={`${ins.avgPain.toFixed(1)}/10`} flag={ins.avgPain > 5} />
      <Mini label="Model read" value={`${(score * 100).toFixed(0)}%`} flag={decision.band === "elevated"} amber={decision.abstain} />
    </div>
    <Card style={{ marginBottom: 14 }}><Label color={C.inkVar}>Rotterdam mapping</Label>
      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        {[["Oligo/anovulation", axes.ovulatory.met, axes.ovulatory.note], ["Hyperandrogenism", axes.androgen.met, axes.androgen.note], ["Polycystic morphology", null, "Ultrasound required"]].map(([k, met, note]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 11, padding: "3px 9px", borderRadius: 8, background: met == null ? C.high : met ? C.rose : C.tealFixed, color: met == null ? C.outline : met ? C.roseOn : C.tealDark }}>{met == null ? "PENDING" : met ? "PRESENT" : "ABSENT"}</span>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 14 }}>{k}</div><div style={{ fontSize: 12, color: C.inkVar }}>{note}</div></div></div>))}</div>
      {decision.abstain && <div style={{ marginTop: 10, padding: "8px 12px", background: "#f6ecd8", borderRadius: 10, fontSize: 13, display: "flex", gap: 8, color: "#7a5a1e" }}><AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 2 }} /> Conformal layer abstained (score in [{LO},{HI}]). Indeterminate.</div>}</Card>
    <Card style={{ marginBottom: 14, background: C.tealC, boxShadow: SH }}><div style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, color: C.tealFixed }}>Twin association</div>
      <p style={{ color: "#fff", fontSize: 15, lineHeight: 1.5, margin: "6px 0 0" }}>Pain averages {(ins.painHi - ins.painLo).toFixed(1)} pts higher the day after high-sugar intake — consider metabolic workup.</p></Card>
    <Card style={{ marginBottom: 14 }}><Label color={C.inkVar}>Suggested tests · linked to insights</Label>
      <div style={{ display: "grid", gap: 7, marginTop: 10 }}>{tests.map((t) => (<label key={t} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 14, padding: "9px 12px", background: C.low, borderRadius: 10, cursor: "pointer" }}><input type="checkbox" style={{ accentColor: C.teal, width: 16, height: 16 }} /> {t}</label>))}</div></Card>
    <Card><Label color={C.inkVar}>Clinician decision (you lead)</Label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>{["Refer for ultrasound + bloods", "Manage as likely PCOS", "Unlikely — reassure", "Reassess in 3 months"].map((o) => (
        <button key={o} onClick={() => setDec(o)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: 9999, cursor: "pointer", border: `1.5px solid ${dec === o ? C.teal : C.outlineVar}`, background: dec === o ? C.tealFixed : C.surface, color: dec === o ? C.tealDark : C.ink }}>{o}</button>))}</div>
      {dec && <p style={{ marginTop: 12, fontSize: 13, color: C.teal, display: "flex", gap: 6, alignItems: "center" }}><Check size={15} /> Logged: "{dec}" — overrides the model read.</p>}</Card>
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
    <Card style={{ marginBottom: 14, display: "grid", gap: 16 }}>
      <Field label="Anthropic API key"><input style={input} type="password" value={settings.apiKey} onChange={(e) => set("apiKey", e.target.value)} placeholder="sk-ant-..." />
        <p style={{ fontSize: 11, color: C.inkVar, marginTop: 5 }}>For chat & summaries. In production, proxy via your backend.</p></Field>
      <Field label="NeMo streaming ASR endpoint"><input style={input} value={settings.nemoEndpoint} onChange={(e) => set("nemoEndpoint", e.target.value)} placeholder="wss://asr.yourdomain.com/asr" /></Field>
      <Field label="Backend URL (database · TTS · orchestration)"><input style={input} value={settings.backendUrl} onChange={(e) => set("backendUrl", e.target.value)} placeholder="/api  or  https://…/api" /></Field>
      <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}><input type="checkbox" checked={settings.voice} onChange={(e) => set("voice", e.target.checked)} style={{ accentColor: C.teal, width: 18, height: 18 }} /><span style={{ fontSize: 15 }}>Speak replies aloud</span></label>
    </Card>
    <Card style={{ marginBottom: 14 }}>
      <Label color={C.inkVar}>Block topics — Myno won't ask about or use these</Label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>{Object.entries(FEATURES).map(([k, f]) => { const on = (settings.blacklist || []).includes(k); return (
        <button key={k} onClick={() => set("blacklist", on ? settings.blacklist.filter((x) => x !== k) : [...(settings.blacklist || []), k])} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: 9999, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7, background: on ? C.rose : C.surface, color: on ? C.roseOn : C.inkVar, border: `1.5px solid ${on ? C.rose : C.outlineVar}` }}>{on ? <Lock size={13} /> : <Check size={13} color={C.outlineVar} />} {f.label}</button>); })}</div>
      <p style={{ fontSize: 11, color: C.inkVar, marginTop: 10 }}>Blocked topics vanish from your daily tracker and are never raised in conversation — enforced in-app and on the server.</p>
    </Card>
    <Card onClick={() => setTab("clinician")} style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
      <span style={{ width: 42, height: 42, borderRadius: 12, background: C.tealFixed, display: "grid", placeItems: "center" }}><Stethoscope size={20} color={C.tealDark} /></span>
      <div style={{ flex: 1 }}><div style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>Clinician dashboard</div><div style={{ fontSize: 13, color: C.inkVar }}>The double-sided view for your appointment</div></div><ChevronRight size={20} color={C.outline} /></Card>
    <Pill variant="soft" onClick={() => setLogs(genSyntheticLogs())} style={{ width: "100%" }}>Regenerate demo data</Pill>
    <p style={{ fontFamily: bodyf, fontSize: 11, color: C.outline, textAlign: "center", marginTop: 18 }}>MYNO · DECISION SUPPORT, NOT A DIAGNOSIS · PROTOTYPE</p>
  </div>);
}
