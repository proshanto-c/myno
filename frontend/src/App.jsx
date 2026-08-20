import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Home, SquarePen, BarChart3, MessageCircle, Settings as Cog, Plus,
  ChevronRight, Mic, MicOff, Volume2, VolumeX, Sparkles, Check, Lock, ArrowLeft, ArrowRight,
  Printer, Stethoscope, AlertTriangle, Info, Heart, Moon, Loader2, X, Target,
  Brain, HeartPulse, Microscope, Droplet, Activity, ChevronLeft, Pill as Pill2
} from "lucide-react";

/* ===========================================================================
   Tawazzun — a PMOS digital twin.  UI: "Blush Calm" (Manrope / Hanken Grotesk,
   soft blush + lilac on warm rose-white, soft tactile minimalism).
   Logic carried over: voice (NeMo streaming / browser fallback), TTS that
   speaks + shows text, personalised associations, feature blacklist, and an
   optional DB-backed backend. Decision support — not a diagnosis.
   =========================================================================== */

// ---- Blush Calm tokens ----------------------------------------------------
const C = {
  bg: "#fbefef", surface: "#ffffff",
  low: "#ffe2e2", container: "#f9d6d6", high: "#f5cbcb", highest: "#edbdbd",
  ink: "#2a2331", inkVar: "#4c4257", outline: "#736688", outlineVar: "#d9c7dc",
  plum: "#5c4b7d", plumC: "#74619a", plumDark: "#3e3159",
  lilac: "#c5b3d3", lilacDim: "#b3a0c4", onLilac: "#2b2140",
  rose: "#ffe2e2", roseOn: "#9e4f5e", roseFixed: "#ffe9e9", roseDeep: "#dfa3a8",
  error: "#b3261e",
};
const GRAD = "radial-gradient(circle at top right, #f3e8f6 0%, #fbefef 45%, #ffe2e2 100%)";
const SH = "0 8px 30px rgba(92,75,125,0.10)";
const SH_SM = "0 4px 16px rgba(92,75,125,0.07)";
const head = "'Manrope', 'Noto Kufi Arabic', system-ui, sans-serif";
const bodyf = "'Hanken Grotesk', 'Noto Kufi Arabic', system-ui, sans-serif";
const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Hanken+Grotesk:wght@400;500;600&family=Noto+Kufi+Arabic:wght@400;600;700&display=swap');
*{ -webkit-font-smoothing:antialiased; box-sizing:border-box; }
.spin{ animation:spin 1s linear infinite; }
@keyframes spin{ to{ transform:rotate(360deg); } }
@keyframes pulse{ 0%,100%{ opacity:1 } 50%{ opacity:.45 } }
@keyframes rise{ from{ opacity:0; transform:translateY(8px) } to{ opacity:1; transform:none } }
input[type=range].slider{ -webkit-appearance:none; appearance:none; width:100%; height:10px; border-radius:9999px; outline:none; }
input[type=range].slider::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:30px; height:30px; border-radius:50%; background:#fff; border:4px solid ${C.plum}; box-shadow:0 2px 8px rgba(92,75,125,.28); cursor:pointer; margin-top:-1px; }
input[type=range].slider::-moz-range-thumb{ width:30px; height:30px; border-radius:50%; background:#fff; border:4px solid ${C.plum}; cursor:pointer; }
.cal-day{ transition:box-shadow .15s ease, transform .12s ease; }
.cal-day:hover{ box-shadow:0 0 0 2px ${C.plum}; transform:scale(1.06); }
.cal-day:active{ transform:scale(.93); }
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
const EXTRACT_SYS = `You are Tawazzun, a warm voice companion helping someone log their PMOS day by talking. From the WHOLE conversation and what they just said: (1) "say" — reply briefly and directly: note what you heard in a few words and move on, warm but matter-of-fact (skip heavy empathy, reassurance, exclamations); INFER ratings/severities yourself and never ask for numbers or 1-to-10 ratings; ask a short clarifying question only when genuinely needed (never about numbers), else just acknowledge (spoken, under ~25 words, never diagnose); (2) "categories" — a small evolving set (max 6) of what THIS person actually talks about, in THEIR words, e.g. {"key":"brain_fog","label":"Brain fog","value":"heavy this morning"}; reuse stable lower_snake_case keys, add new ones they raise, build on the categories given. When a category is naturally a rating/severity/amount, ALSO include "scale":{"value":int,"max":10} where value is 0-10; KEEP a user-set scale value unless they clearly change it; omit scale for qualitative ones; (3) the standard tracking fields ONLY when clearly implied. ONLY JSON: {"period":true|false|null,"flow":"none|spotting|light|medium|heavy"|null,"birthControl":str|null,"pain":0-10|null,"mood":0-10|null,"energy":0-10|null,"sleep":0-10|null,"brainFog":0-10|null,"sexDrive":0-10|null,"sugar":0-10|null,"foodDrive":0-10|null,"dietExercise":str|null,"painMap":str|null,"morningWeight":number|null,"hairGrowth":bool,"hairLoss":bool,"acne":bool,"skinPatches":bool,"hyperpigmentation":bool,"bloating":bool,"cravings":bool,"diagnoses":str|null,"categories":[{"key":str,"label":str,"value":str,"scale":{"value":int,"max":10}}],"say":str}. null/false for fields not mentioned; omit scale where it doesn't fit.`;
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
// Fallback wording if the backend schema hasn't loaded. The first word belongs
// to 0 alone and the last to the top of the scale alone — see scaleWord.
const scaleLabels = {
  pain: ["none", "mild", "moderate", "severe", "extreme"],
  mood: ["very low", "low", "mixed", "good", "very good"],
  energy: ["depleted", "low", "moderate", "high", "very high"],
  sleep: ["awful", "poor", "patchy", "good", "great"],
  brainFog: ["clear", "slight", "moderate", "heavy", "severe"],
  sexDrive: ["none", "low", "moderate", "high", "very high"],
  sugar: ["none", "a little", "some", "a lot", "constant"],
  foodDrive: ["no appetite", "low", "normal", "high", "ravenous"],
};
const clampScale = (value, fallback = 0, max = SCALE_MAX) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.round(n)));
};
// The ends of a scale mean something exact: "none" is 0, not 0-to-3, and the
// top word is the top of the scale. Only the words in between share the range.
const scaleWord = (v, max, words) => {
  if (!Array.isArray(words) || words.length < 2) return "";
  if (words.length === max + 1) return words[v];
  if (v <= 0) return words[0];
  if (v >= max) return words[words.length - 1];
  const inner = words.slice(1, -1);
  if (!inner.length) return v * 2 <= max ? words[0] : words[1];
  return inner[Math.min(inner.length - 1, Math.floor(((v - 1) / (max - 1)) * inner.length))];
};
const scaleDisplay = (value, max = SCALE_MAX, words = null) => {
  const v = clampScale(value, 0, max);
  const word = scaleWord(v, max, words);
  return word ? `${v}/${max} ${word}` : `${v}/${max}`;
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
// The questions themselves live in the backend (record.py) and arrive from
// GET /record/schema, so the app, the voice extractor and the insight
// categories can never drift apart. This copy is only what we draw while that
// request is in flight, or if there is no backend to ask.
const LEVELS = ["low", "usual", "high"];
const FALLBACK_SCHEMA = [
  { key: "cycle", group: "Menstrual cycle", fields: [
    { key: "period", label: "Started your period?", type: "bool" },
    { key: "flow", label: "Flow", type: "select", options: ["none", "spotting", "light", "medium", "heavy"] },
    { key: "birthControl", label: "On birth control?", type: "bool" },
    { key: "birthControlType", label: "Type", type: "select", options: ["natural", "mechanical", "hormonal"],
      showIf: { field: "birthControl", equals: true } },
  ] },
  { key: "wellbeing", group: "Wellbeing", fields: [
    { key: "mood", label: "Mood", type: "emoji", options: [
      { value: 1, emoji: "😭", label: "Awful" }, { value: 3, emoji: "😞", label: "Low" },
      { value: 5, emoji: "😐", label: "Flat" }, { value: 7, emoji: "🙂", label: "Good" },
      { value: 9, emoji: "😄", label: "Great" }] },
    { key: "energy", label: "Energy", type: "scale", max: SCALE_MAX, words: scaleLabels.energy },
    { key: "sleep", label: "Sleep", type: "scale", max: SCALE_MAX, words: scaleLabels.sleep },
    { key: "brainFog", label: "Brain fog", type: "scale", max: SCALE_MAX, words: scaleLabels.brainFog },
  ] },
  { key: "body", group: "Body", fields: [
    { key: "pain", label: "Pain", type: "scale", max: SCALE_MAX, words: scaleLabels.pain },
    { key: "painPoints", label: "Where it hurts", type: "bodymap" },
    { key: "morningWeight", label: "Morning weight (kg)", type: "number", placeholder: "kg" },
    { key: "sugar", label: "Sugar", type: "scale", max: SCALE_MAX, words: scaleLabels.sugar },
    { key: "foodDrive", label: "Food drive", type: "scale", max: SCALE_MAX, words: scaleLabels.foodDrive },
  ] },
  { key: "lifestyle", group: "Lifestyle", fields: [
    { key: "sexDrive", label: "Sex drive", type: "scale", max: SCALE_MAX, words: scaleLabels.sexDrive },
    { key: "cravings", label: "Cravings", type: "bool" },
    { key: "cravingType", label: "Craving for", type: "select", options: ["salty", "sugary"],
      showIf: { field: "cravings", equals: true } },
    { key: "exercise", label: "Exercise", type: "select", options: ["inactive", "fairly active", "active", "very active"] },
    { key: "dietCarbs", label: "Carbohydrates", type: "select", options: LEVELS, heading: "Diet — how today's eating went" },
    { key: "dietFats", label: "Fats", type: "select", options: LEVELS },
    { key: "dietProtein", label: "Protein", type: "select", options: LEVELS },
    { key: "dietFibre", label: "Fibre", type: "select", options: LEVELS },
  ] },
  { key: "skin", group: "Skin & hair", fields: [
    { key: "acne", label: "Acne (new breakouts)", type: "bool" },
    { key: "hairGrowth", label: "Hair growth", type: "bool" },
    { key: "hairLoss", label: "Hair loss", type: "bool" },
    { key: "dryPatches", label: "Dry patches", type: "bool" },
    { key: "hyperpigmentation", label: "Hyperpigmentation", type: "bool" },
  ] },
];
const SCHEMA_CACHE = "myno:record-schema:v2";

// One fetch at boot, remembered between visits so a slow or missing backend
// never leaves the Record screen blank.
function useRecordSchema(settings) {
  const [schema, setSchema] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SCHEMA_CACHE)) || FALLBACK_SCHEMA; }
    catch (e) { return FALLBACK_SCHEMA; }
  });
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const r = await fetch(`${API(settings)}/record/schema`);
        if (!r.ok) return;
        const body = await r.json();
        if (stale || !Array.isArray(body.schema) || !body.schema.length) return;
        setSchema(body.schema);
        try { localStorage.setItem(SCHEMA_CACHE, JSON.stringify(body.schema)); } catch (e) {}
      } catch (e) { /* keep the cached questions */ }
    })();
    return () => { stale = true; };
  }, [settings.backendUrl]);
  return schema;
}

const SCHEMA_DEFAULTS = { pain: 0, mood: 5, energy: 5, sugar: 5, flow: null, birthControl: null, birthControlType: null,
  sleep: 5, brainFog: 0, sexDrive: 5, painPoints: [], morningWeight: null, foodDrive: 5, cravings: null, cravingType: null,
  exercise: null, dietCarbs: null, dietFats: null, dietProtein: null, dietFibre: null, acne: false, hairGrowth: false, hairLoss: false, dryPatches: false, hyperpigmentation: false };

// ---- the body map ----------------------------------------------------------
// Tap the drawing to drop a marker where it hurts; tap a marker to take it off.
// Points are stored normalised (0–1) with the view they belong to, so they
// survive any size the drawing is rendered at.
const BODY_OUTLINE = "M50.0,29.0 C50.8,29.4 55.4,30.9 57.0,32.0 C58.6,33.0 62.5,36.2 64.0,38.0 C65.5,39.8 69.1,44.1 70.0,47.0 C70.9,49.9 71.7,58.6 72.0,63.0 C72.3,67.4 73.0,80.1 73.0,85.0 C73.0,89.9 72.3,101.3 72.0,105.0 C71.7,108.7 70.7,115.5 70.0,117.0 C69.3,118.5 66.7,120.0 66.0,118.0 C65.3,116.0 64.3,104.4 64.0,100.0 C63.6,95.6 63.4,84.7 63.0,80.0 C62.6,75.3 61.7,59.5 61.0,60.0 C60.3,60.5 56.8,78.9 57.0,84.0 C57.2,89.1 62.1,100.0 63.0,104.0 C63.9,108.0 65.1,112.9 65.0,118.0 C64.9,123.1 62.6,141.7 62.0,148.0 C61.4,154.3 60.5,166.8 60.0,172.0 C59.5,177.2 58.9,190.4 58.0,193.0 C57.1,195.6 52.6,199.0 52.0,194.0 C51.4,189.0 53.0,158.2 53.0,150.0 C53.0,141.8 52.4,128.0 52.0,124.0 C51.6,120.0 50.2,116.9 50.0,116.0 C49.8,115.1 50.2,115.1 50.0,116.0 C49.8,116.9 48.4,120.0 48.0,124.0 C47.6,128.0 47.0,141.8 47.0,150.0 C47.0,158.2 48.6,189.0 48.0,194.0 C47.4,199.0 42.9,195.6 42.0,193.0 C41.1,190.4 40.5,177.2 40.0,172.0 C39.5,166.8 38.6,154.3 38.0,148.0 C37.4,141.7 35.1,123.1 35.0,118.0 C34.9,112.9 36.1,108.0 37.0,104.0 C37.9,100.0 42.8,89.1 43.0,84.0 C43.2,78.9 39.7,60.5 39.0,60.0 C38.3,59.5 37.4,75.3 37.0,80.0 C36.6,84.7 36.4,95.6 36.0,100.0 C35.6,104.4 34.7,116.0 34.0,118.0 C33.3,120.0 30.7,118.5 30.0,117.0 C29.3,115.5 28.4,108.7 28.0,105.0 C27.6,101.3 27.0,89.9 27.0,85.0 C27.0,80.1 27.6,67.4 28.0,63.0 C28.4,58.6 29.1,49.9 30.0,47.0 C30.9,44.1 34.5,39.8 36.0,38.0 C37.5,36.2 41.4,33.0 43.0,32.0 C44.6,30.9 49.2,29.4 50.0,29.0 C50.8,28.6 49.2,28.6 50.0,29.0Z";
function BodyMap({ value, onChange }) {
  const [view, setView] = useState("front");
  const points = Array.isArray(value) ? value : [];
  const add = (ev) => {
    const box = ev.currentTarget.getBoundingClientRect();
    const x = (ev.clientX - box.left) / box.width, y = (ev.clientY - box.top) / box.height;
    onChange([...points, { view, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }]);
  };
  const drop = (i) => (ev) => { ev.stopPropagation(); onChange(points.filter((_, j) => j !== i)); };
  const here = points.map((p, i) => ({ ...p, i })).filter((p) => p.view === view);
  return (<div>
    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
      {["front", "back"].map((v) => <Chip key={v} active={view === v} onClick={() => setView(v)}>{v}</Chip>)}
      {points.length > 0 && <button onClick={() => onChange([])} style={{ marginLeft: "auto", background: "none", border: "none",
        cursor: "pointer", fontFamily: bodyf, fontSize: 12.5, color: C.outline }}>clear {points.length}</button>}
    </div>
    <svg viewBox="0 0 100 205" onClick={add} style={{ width: "100%", maxWidth: 168, display: "block", margin: "0 auto",
      cursor: "crosshair", touchAction: "manipulation" }}>
      <g fill={C.rose} stroke={C.lilacDim} strokeWidth={1.3} strokeLinejoin="round">
        <circle cx="50" cy="15" r="11" /><path d={BODY_OUTLINE} />
      </g>
      {view === "back" && <path d="M50 42 v60" fill="none" stroke={C.lilacDim} strokeWidth={1.5} strokeLinecap="round" strokeDasharray="3 4" />}
      {here.map((p) => (
        <circle key={p.i} cx={p.x * 100} cy={p.y * 205} r={6} fill={C.roseOn} fillOpacity={0.55}
          stroke={C.roseOn} strokeWidth={1.5} style={{ cursor: "pointer" }} onClick={drop(p.i)} />
      ))}
    </svg>
    <div style={{ textAlign: "center", fontSize: 11.5, color: C.outline, marginTop: 4 }}>
      {points.length ? "tap a marker to remove it" : "tap where it hurts"}</div>
  </div>);
}

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
const ADVISE_SYS = `You are Tawazzun, a warm, practical PMOS companion. Combine the person's tracked history (history_summary) with what they're telling you now to surface ONE clear insight — a trend or correlation grounded in THEIR data — plus brief, actionable, non-diagnostic advice. Never diagnose or give drug doses. ONLY JSON: {"headline":str (<=8 words), "correlations":[{"label":str,"strength":0-100}] (0-3), "say":str (<=45 words of warm advice)}.`;
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
// ---- diagnostic criteria ---------------------------------------------------
// The rules live in backend/criteria.py — thresholds, bands, the lot — so the
// indicator, the cycle labels and the advocacy talking points cannot drift
// apart, and the rules can be unit-tested. The client only renders verdicts.
const API = (settings) => (settings.backendUrl || "/api").replace(/\/$/, "");

// ---- UI atoms --------------------------------------------------------------
const Card = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{ background: C.surface, borderRadius: 20, padding: 20, boxShadow: SH_SM, ...style }}>{children}</div>
);
const Label = ({ children, color = C.plum }) => (
  <div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color }}>{children}</div>
);
const H = ({ children, size = 26, style }) => (
  <h1 style={{ fontFamily: head, fontWeight: 700, fontSize: size, lineHeight: 1.12, letterSpacing: "-0.01em", margin: 0, color: C.ink, ...style }}>{children}</h1>
);
function Pill({ children, onClick, variant = "filled", disabled, style }) {
  const v = { filled: { background: C.plum, color: "#fff", border: "none" },
    outline: { background: C.surface, color: C.plum, border: `1.5px solid ${C.plum}` },
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
// The mark: the single-line uterus logo, traced from brand-logo-source.svg into
// one even-odd path so it stays crisp at any size and takes the colour it's given.
const MARK = "M53.33,76.42 46.67,76.42 46.08,76.06 45.09,75.07 44.73,74.54 44.13,73.28 42.63,68.48 40.11,62.79 39.63,61.29 39.28,59.74 39.04,57.76 39.04,54.7 39.22,52.97 39.57,50.93 39.63,48.95 39.16,46.61 38.8,45.6 37.9,43.68 36.76,41.76 34.54,38.41 33.82,37.15 32.74,34.93 31.91,32.59 31.61,31.46 30.89,27.86 30.65,26.06 30.05,23.55 29.39,21.75 28.49,20.19 27.83,19.35 26.72,18.24 24.69,16.75 17.74,13.09 14.74,11.65 11.98,10.75 10.13,10.46 9.47,10.46 8.51,10.64 7.49,10.99 6.83,11.41 6.2,12.04 5.72,12.88 5.54,13.48 5.54,14.14 6.08,15.58 6.5,16.18 7.13,16.81 8.09,17.41 9.23,17.77 14.26,17.77 15.16,17.94 16.6,18.54 17.26,19.02 18.0,19.83 18.36,20.67 18.39,21.48 19.29,21.78 20.79,22.56 21.93,23.4 22.74,24.21 23.7,25.58 24.12,26.48 24.36,27.38 24.42,29.96 24.3,30.74 24.06,31.46 23.58,32.29 22.89,33.1 22.17,33.7 21.09,34.3 20.07,34.66 18.69,34.9 15.64,34.9 13.66,34.54 12.16,34.0 11.2,33.52 9.41,32.26 8.24,31.1 7.04,29.3 6.56,28.1 6.26,26.6 6.26,24.15 6.5,23.07 4.79,22.56 3.89,22.14 2.58,21.3 1.11,19.95 0.45,19.05 -0.03,18.15 -0.03,10.07 0.39,9.17 1.05,8.15 2.7,6.5 3.83,5.78 4.85,5.3 6.77,4.76 8.69,4.58 11.5,4.64 13.0,4.88 15.22,5.54 17.02,6.26 20.91,8.06 22.17,8.48 24.33,8.96 25.82,8.96 28.28,8.36 30.26,7.46 32.06,6.38 36.43,3.33 37.87,2.43 39.9,1.35 41.58,0.63 42.84,0.21 43.74,-0.03 56.56,-0.03 58.3,0.51 59.5,0.99 61.41,1.95 63.69,3.33 67.71,6.14 69.62,7.28 71.72,8.24 73.88,8.84 74.6,8.96 75.73,8.96 77.47,8.6 79.45,7.94 83.16,6.2 85.74,5.24 87.72,4.76 89.69,4.58 92.57,4.64 93.89,4.88 95.15,5.3 96.23,5.78 97.24,6.44 98.47,7.61 99.07,8.33 99.97,9.95 99.97,18.15 99.07,19.65 97.54,21.18 96.88,21.66 95.45,22.44 93.5,23.07 93.74,24.03 93.74,26.78 93.44,28.16 92.9,29.42 92.0,30.8 90.59,32.26 89.69,32.98 88.02,33.94 85.98,34.66 84.42,34.9 80.95,34.84 79.81,34.6 78.37,34.0 77.77,33.64 76.78,32.77 75.88,31.28 75.58,29.78 75.58,27.92 75.7,27.08 75.94,26.3 76.36,25.46 77.26,24.21 78.07,23.4 79.21,22.56 80.59,21.84 81.67,21.48 81.7,20.43 81.82,20.13 82.17,19.59 83.22,18.66 84.18,18.18 85.8,17.77 90.77,17.77 91.91,17.41 92.93,16.75 93.8,15.76 94.34,14.62 94.52,13.84 94.28,12.88 93.98,12.28 93.11,11.35 92.27,10.87 91.55,10.64 90.59,10.46 89.93,10.46 88.08,10.75 85.44,11.59 82.26,13.09 81.25,13.69 77.05,15.79 75.07,16.93 73.52,18.06 72.47,19.05 71.57,20.13 70.61,21.81 70.01,23.43 69.59,25.04 68.63,30.62 68.15,32.53 67.62,34.09 67.08,35.41 66.18,37.21 65.04,39.13 62.28,43.38 61.26,45.48 60.67,47.33 60.37,49.07 60.37,50.27 60.96,54.52 60.96,57.94 60.67,60.22 60.25,61.77 59.41,64.05 57.85,67.41 57.13,69.26 56.47,71.54 55.75,73.58 55.33,74.42 54.79,75.19 53.92,76.06 53.33,76.42ZM45.27,68.18 45.33,65.61 45.63,64.23 45.99,63.15 46.88,61.35 48.32,59.2 47.06,57.28 46.52,56.2 46.17,55.18 45.93,53.86 45.93,51.95 46.17,50.51 46.58,49.37 47.66,47.45 48.38,46.43 47.54,45.18 46.58,43.32 45.75,41.1 44.91,37.75 44.25,33.49 43.77,31.1 42.99,28.46 42.27,26.78 41.73,25.82 40.77,24.57 39.96,23.76 39.01,22.98 37.45,21.96 33.91,19.98 32.65,19.14 31.43,17.97 30.89,17.02 30.77,16.6 30.77,14.56 31.19,13.66 31.7,13.21 32.06,13.03 33.07,12.73 36.31,12.73 37.09,12.85 39.36,13.51 45.18,15.97 47.33,16.57 49.91,16.93 52.07,16.69 54.1,16.21 56.14,15.49 60.34,13.63 62.67,12.91 63.75,12.73 66.45,12.67 67.53,12.85 68.42,13.27 68.93,13.78 69.17,14.2 69.23,16.66 68.99,17.32 68.51,18.03 67.77,18.78 66.09,19.98 62.85,21.78 60.99,22.98 59.41,24.39 58.69,25.22 57.97,26.3 57.07,28.22 56.47,30.14 55.75,33.61 55.03,38.23 54.25,41.16 53.42,43.32 52.58,44.94 51.62,46.43 53.18,48.89 53.89,50.69 54.07,51.77 54.07,54.04 53.89,55.06 53.18,56.86 51.68,59.26 52.52,60.4 53.42,61.89 54.31,63.93 54.79,66.21 54.82,68.15 55.87,65.37 57.07,62.85 57.85,60.87 58.21,59.74 58.69,57.58 58.81,56.2 58.15,51.41 58.15,47.87 58.33,46.55 58.75,44.88 59.35,43.26 60.07,41.82 63.54,36.37 64.5,34.63 65.22,33.07 65.88,31.28 66.36,29.48 67.2,24.63 67.8,21.99 68.57,19.89 69.41,18.45 71.06,16.57 71.96,15.79 73.7,14.59 80.41,11.05 82.74,9.92 85.2,8.96 87.06,8.48 89.28,8.24 92.03,8.3 93.53,8.6 94.67,9.14 95.84,10.19 96.26,10.84 96.49,11.44 96.73,12.64 96.73,15.1 96.49,16.18 96.02,17.32 95.48,18.09 94.73,18.84 94.31,19.14 92.81,19.8 91.37,20.04 88.86,20.04 87.42,19.92 85.98,20.28 84.81,20.91 85.8,20.82 89.51,20.82 91.37,21.06 93.29,20.52 94.55,19.92 95.39,19.38 96.67,18.21 97.63,16.9 98.29,15.22 98.41,14.62 98.41,13.66 97.99,11.98 97.51,10.96 96.91,10.01 95.75,8.78 94.55,7.94 93.11,7.28 91.37,6.86 90.17,6.8 88.44,7.1 86.46,7.7 83.58,8.9 81.49,9.92 78.61,10.87 76.63,11.17 73.7,11.17 72.32,10.99 69.8,10.28 67.65,9.26 66.03,8.3 61.23,5.0 58.6,3.51 57.52,3.03 55.6,2.31 53.33,1.77 51.53,1.53 49.67,1.47 47.69,1.65 45.84,2.01 44.28,2.43 42.36,3.15 40.38,4.1 38.59,5.18 34.39,8.12 32.35,9.38 30.5,10.28 28.7,10.87 26.84,11.17 23.37,11.17 21.45,10.87 19.35,10.22 15.28,8.36 13.3,7.58 11.92,7.16 9.95,6.8 9.11,6.8 8.33,6.92 6.95,7.28 5.93,7.7 4.91,8.3 4.13,8.9 3.15,9.95 2.13,11.68 1.65,13.24 1.53,14.26 1.71,15.28 2.07,16.36 3.15,18.09 4.25,19.14 5.87,20.16 7.19,20.7 8.57,21.06 10.37,20.82 15.13,20.85 14.26,20.34 12.64,19.92 11.74,19.92 10.96,20.04 8.57,20.04 7.01,19.74 5.33,18.9 4.58,18.21 3.86,17.14 3.51,16.24 3.27,14.92 3.33,12.16 3.74,10.84 4.4,9.95 4.97,9.38 5.63,8.96 6.71,8.54 8.03,8.3 10.72,8.24 12.94,8.48 14.86,8.96 17.32,9.92 25.04,13.87 26.72,14.83 28.64,16.27 29.81,17.44 30.59,18.45 31.61,20.25 32.32,22.35 32.92,25.04 32.92,25.46 33.52,28.82 34.12,31.16 34.9,33.31 35.86,35.29 36.82,36.97 37.72,38.23 39.93,41.82 40.89,43.86 41.37,45.24 41.73,46.85 41.85,47.87 41.85,51.59 41.25,55.66 41.25,56.68 41.49,58.42 42.27,61.17 42.87,62.49 42.87,62.67 43.11,63.03 43.47,63.99 44.19,65.43 45.27,68.18ZM50.06,43.86 51.14,41.94 52.22,39.19 53.06,35.65 53.59,31.94 54.31,28.52 55.03,26.3 55.93,24.45 57.31,22.59 58.48,21.48 60.04,20.34 65.07,17.41 66.36,16.3 66.72,15.88 66.84,15.52 66.39,15.19 65.79,14.95 65.37,14.89 64.65,15.01 63.75,15.19 62.13,15.73 57.28,17.83 55.78,18.36 54.58,18.66 53.03,18.96 51.83,19.08 48.23,19.08 46.32,18.84 44.28,18.36 42.0,17.53 38.23,15.85 36.25,15.19 34.69,14.89 34.03,15.01 33.61,15.19 33.16,15.58 33.16,15.7 34.21,16.87 35.77,17.94 39.01,19.74 41.1,21.12 42.69,22.59 43.35,23.37 44.01,24.39 44.97,26.36 45.69,28.58 46.17,30.62 47.06,36.13 47.78,39.13 48.98,42.18 49.76,43.62 49.97,43.89 50.06,43.86ZM17.29,32.71 18.51,32.5 19.95,31.91 20.79,31.31 21.66,30.32 22.14,29.18 22.14,28.64 21.54,27.2 20.82,26.18 20.01,25.37 19.05,24.66 17.56,23.88 16.18,23.4 14.08,23.16 11.74,23.1 11.08,23.22 10.01,23.22 9.35,23.52 8.9,24.03 8.72,24.39 8.48,25.16 8.48,25.58 8.72,26.6 9.2,27.68 10.22,29.18 11.38,30.35 12.94,31.43 13.9,31.91 15.22,32.38 16.6,32.68 17.29,32.71ZM83.01,32.71 83.88,32.62 84.84,32.38 86.64,31.67 88.32,30.59 89.78,29.18 90.8,27.68 91.16,26.9 91.52,25.7 91.52,25.1 91.34,24.51 91.04,23.97 90.65,23.52 90.23,23.28 88.08,23.1 86.88,23.1 84.18,23.34 82.56,23.82 80.95,24.66 79.87,25.49 79.12,26.24 78.22,27.62 77.86,28.7 77.98,29.54 78.34,30.26 79.0,31.1 79.87,31.79 81.19,32.38 82.14,32.62 83.01,32.71ZM50.06,56.74 50.78,55.66 51.44,54.34 51.8,53.21 51.8,52.61 51.38,51.29 50.03,48.86 49.46,49.67 48.62,51.29 48.14,52.91 48.5,54.16 48.8,54.82 49.64,56.32 49.88,56.68 50.06,56.74ZM50.06,71.72 50.51,71.57 51.05,71.21 51.5,70.76 51.98,70.04 52.46,68.72 52.58,68.06 52.58,67.35 52.1,65.31 51.74,64.47 51.02,63.09 49.97,61.56 48.74,63.51 48.14,64.77 47.6,66.51 47.42,67.88 47.6,68.9 47.84,69.62 48.38,70.58 49.13,71.33 49.79,71.69 50.06,71.72ZM50.24,74.84 50.99,74.63 51.71,74.27 52.64,73.46 52.13,73.73 51.35,73.97 49.13,74.03 48.35,73.91 47.3,73.4 48.11,74.15 48.71,74.51 49.79,74.87 50.24,74.84Z";
function Uterus({ size = 22, color = "#fff", style }) {
  return (
    <svg width={size} height={size * 0.7645} viewBox="0 0 100 76.45" aria-hidden="true" style={{ display: "block", ...style }}>
      <path fill={color} fillRule="evenodd" d={MARK} />
    </svg>);
}
function BrandMark({ size = 34 }) {
  // The drawing's weight sits in the fundus and tubes, so a box-centred mark
  // reads top-heavy in the disc — nudge it down onto its optical centre.
  return (<span style={{ width: size, height: size, borderRadius: "50%", background: C.plum, display: "grid", placeItems: "center", flexShrink: 0 }}>
    <Uterus size={size * 0.66} style={{ transform: "translateY(10%)" }} /></span>);
}
// The wordmark. inline-block isolates the RTL word from the surrounding LTR
// sentence, so neighbouring punctuation isn't reordered by the bidi algorithm.
const Brand = ({ style }) => (
  <span dir="rtl" style={{ display: "inline-block", fontFamily: head, fontWeight: 700, ...style }}>توازن</span>);
const Field = ({ label, children }) => (
  <label style={{ display: "block" }}><div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", color: C.inkVar, marginBottom: 6, textTransform: "uppercase" }}>{label}</div>{children}</label>
);
const input = { width: "100%", padding: "13px 15px", borderRadius: 12, border: `1.5px solid ${C.outlineVar}`, fontFamily: bodyf, fontSize: 16, color: C.ink, background: C.surface, outline: "none" };
function Slider({ value, max, onChange }) {
  const pct = (value / max) * 100;
  return (<input type="range" className="slider" min={0} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))}
    style={{ background: `linear-gradient(90deg, ${C.plum} ${pct}%, ${C.high} ${pct}%)` }} />);
}

// ---- the doctor indicator --------------------------------------------------
// One card, one question answered. The criteria breakdown sits underneath so
// the verdict is never a black box — every line of it is traceable to a rule.
const TONE = {
  urgent:   { fg: C.roseOn, bg: C.rose, Icon: AlertTriangle },
  elevated: { fg: C.plumDark, bg: C.lilac, Icon: Stethoscope },
  mild:     { fg: C.plum, bg: C.low, Icon: Info },
  calm:     { fg: C.plum, bg: C.low, Icon: Check },
  muted:    { fg: C.outline, bg: C.container, Icon: Info },
};
const STATE_TEXT = { met: "Criterion met", clear: "Not met", unknown: "Can't assess" };

function CriterionRow({ title, source, result }) {
  const dot = result.state === "met" ? C.roseOn : result.state === "unknown" ? C.outline : C.plumC;
  return (
    <div style={{ padding: "12px 0", borderTop: `1px solid ${C.high}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, flexShrink: 0 }} />
        <span style={{ fontFamily: head, fontWeight: 600, fontSize: 14.5 }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, color: dot }}>{STATE_TEXT[result.state]}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.outline, margin: "2px 0 0 16px" }}>{source}</div>
      <ul style={{ margin: "6px 0 0", paddingLeft: 30, color: C.inkVar, fontSize: 13, lineHeight: 1.5 }}>
        {result.reasons.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </div>);
}

// A section that can be folded away. The advocacy report is long, and most of
// it is only wanted at the moment you're preparing for the appointment.
function Collapsible({ title, count, children, defaultOpen = true, style }) {
  const [open, setOpen] = useState(defaultOpen);
  return (<Card style={{ marginBottom: 14, ...style }}>
    <button onClick={() => setOpen((o) => !o)} style={{ background: "none", border: "none", padding: 0, width: "100%",
      cursor: "pointer", display: "flex", alignItems: "center", gap: 8, textAlign: "left" }}>
      <Label>{title}</Label>
      {count != null && <span style={{ fontFamily: bodyf, fontSize: 11.5, fontWeight: 700, color: C.plum,
        background: C.low, borderRadius: 9999, padding: "3px 9px" }}>{count}</span>}
      <ChevronRight size={18} color={C.outline} style={{ marginLeft: "auto",
        transform: open ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
    </button>
    {open && <div style={{ marginTop: 12 }}>{children}</div>}
  </Card>);
}

function DoctorIndicator({ assessment }) {
  const [open, setOpen] = useState(true);
  const { recommendation: rec, cycles, androgen, context } = assessment;
  const tone = TONE[rec.tone]; const Icon = tone.Icon;
  return (<Card style={{ marginBottom: 14 }}>
    <button onClick={() => setOpen(!open)} style={{ background: "none", border: "none", padding: 0, width: "100%",
      cursor: "pointer", display: "flex", alignItems: "center", gap: 8, textAlign: "left" }}>
      <Label>Should you see a doctor?</Label>
      <ChevronRight size={18} color={C.outline} style={{ marginLeft: "auto", transform: open ? "rotate(90deg)" : "none", transition: "transform .2s" }} />
    </button>
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: 14, borderRadius: 14, background: tone.bg, margin: "10px 0 4px" }}>
      <Icon size={20} color={tone.fg} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>
        <div style={{ fontFamily: head, fontWeight: 700, fontSize: 16, color: tone.fg }}>{rec.headline}</div>
        {open && <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13.5, lineHeight: 1.5, color: tone.fg }}>
          {rec.why.map((w, i) => <li key={i}>{w}</li>)}
        </ul>}
      </div>
    </div>
    {open && <>
      <CriterionRow title="Irregular cycles" source="From your logged period dates" result={cycles} />
      <CriterionRow title="Hair & skin signs" source="Self-reported — a clinician confirms by examination" result={androgen} />
      {(context || []).length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", marginBottom: 12,
          borderRadius: 12, background: C.low, fontSize: 12.5, lineHeight: 1.5, color: C.inkVar }}>
          <Info size={14} color={C.plum} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{context.join(" ")} Worth mentioning either way — untangling the two is the clinic's job.</span>
        </div>)}
      <div style={{ padding: "12px 0 0", borderTop: `1px solid ${C.high}`, fontSize: 12, lineHeight: 1.5, color: C.outline }}>
        This is not a diagnosis. Blood androgens and ovarian imaging or AMH can only be assessed in a
        clinic, and thyroid, prolactin, CAH and Cushing's have to be ruled out before anyone can name
        a condition.
      </div>
    </>}
  </Card>);
}

// ---- the lab ---------------------------------------------------------------
// Every number the rules read, exposed. Change one and the indicator above
// recomputes — which is the point: it makes the rules arguable.
const labNum = { width: "100%", padding: "8px 10px", borderRadius: 10, border: `1.5px solid ${C.outlineVar}`,
  fontFamily: bodyf, fontSize: 13.5, outline: "none", background: C.surface, color: C.ink };

function LabNumber({ label, value, onChange, suffix, edited }) {
  return (<label style={{ display: "block" }}>
    <div style={{ fontSize: 11, fontWeight: 600, color: edited ? C.plum : C.outline, marginBottom: 4 }}>
      {label}{suffix ? ` (${suffix})` : ""}{edited ? " •" : ""}</div>
    <input type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      style={{ ...labNum, borderColor: edited ? C.plum : C.outlineVar }} />
  </label>);
}
function LabToggle({ label, value, onChange, edited }) {
  return (<button onClick={() => onChange(!value)} style={{ ...labNum, cursor: "pointer", textAlign: "left",
    borderColor: edited ? C.plum : C.outlineVar, display: "flex", alignItems: "center", gap: 8 }}>
    <span style={{ width: 14, height: 14, borderRadius: 4, flexShrink: 0, display: "grid", placeItems: "center",
      background: value ? C.plum : C.surface, border: `1.5px solid ${value ? C.plum : C.outlineVar}` }}>
      {value && <Check size={10} color="#fff" />}</span>
    <span style={{ fontSize: 12.5, color: C.inkVar }}>{label}</span>
  </button>);
}

function CriteriaLab({ derived, lab, setLab, rules, labRules, setLabRules, open, setOpen }) {
  const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))", gap: 10, marginTop: 10 };
  const val = (k) => (k in lab ? lab[k] : derived[k]);
  const set = (k) => (v) => setLab({ ...lab, [k]: v });
  // thresholds are the server's defaults with the panel's overrides on top
  const rule = (k) => (k in labRules ? labRules[k] : rules[k]);
  const setRule = (k) => (v) => setLabRules({ ...labRules, [k]: v });
  const band = (i, k) => (labRules.cycleBands?.[i]?.[k] ?? rules.cycleBands[i][k]);
  const setBand = (i, k) => (v) => setLabRules({ ...labRules,
    cycleBands: rules.cycleBands.map((b, j) => ({ ...(labRules.cycleBands?.[j] || {}), ...(j === i ? { [k]: v } : {}) })) });
  if (!rules) return null;

  return (<Card style={{ marginBottom: 14 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Microscope size={16} color={C.plum} />
      <span style={{ fontFamily: head, fontWeight: 600, fontSize: 15 }}>Experiment with the factors</span>
      <span style={{ marginLeft: "auto", fontSize: 12, color: C.outline }}>
        {Object.keys(lab).length + Object.keys(labRules).length ? `${Object.keys(lab).length + Object.keys(labRules).length} overridden` : "prototype"}</span>
      <button onClick={() => setOpen(false)} title="Close" style={{ background: "none", border: "none", cursor: "pointer", color: C.outline, display: "grid" }}><X size={16} /></button>
    </div>
    {(<div style={{ marginTop: 6 }}>
      <p style={{ fontSize: 12.5, color: C.inkVar, lineHeight: 1.5, margin: "6px 0 0" }}>
        These start from your own tracked data. Change anything and the indicator above recomputes —
        nothing here is saved to your logs.
      </p>

      <div style={{ marginTop: 14 }}><Label color={C.inkVar}>Your data</Label></div>
      <div style={grid}>
        <LabNumber label="Age" value={val("age")} onChange={set("age")} edited={"age" in lab} />
        <LabNumber label="Years since menarche" value={val("yearsPostMenarche")} onChange={set("yearsPostMenarche")} edited={"yearsPostMenarche" in lab} />
        <LabNumber label="Shortest cycle" suffix="days" value={val("minCycle")} onChange={set("minCycle")} edited={"minCycle" in lab} />
        <LabNumber label="Longest cycle" suffix="days" value={val("maxCycle")} onChange={set("maxCycle")} edited={"maxCycle" in lab} />
        <LabNumber label="Average cycle" suffix="days" value={val("avgCycle")} onChange={set("avgCycle")} edited={"avgCycle" in lab} />
        <LabNumber label="Cycles logged" value={val("cyclesObserved")} onChange={set("cyclesObserved")} edited={"cyclesObserved" in lab} />
        <LabNumber label="Cycles in past year" value={val("cyclesPerYear")} onChange={set("cyclesPerYear")} edited={"cyclesPerYear" in lab} />
        <LabNumber label="mFG hirsutism score" suffix="0–36" value={val("mfgScore")} onChange={set("mfgScore")} edited={"mfgScore" in lab} />
        <LabNumber label="Hair growth days" suffix="%" value={Math.round(val("hirsutismDaysPct") || 0)} onChange={set("hirsutismDaysPct")} edited={"hirsutismDaysPct" in lab} />
        <LabNumber label="Hair thinning days" suffix="%" value={Math.round(val("hairLossDaysPct") || 0)} onChange={set("hairLossDaysPct")} edited={"hairLossDaysPct" in lab} />
        <LabToggle label="Already diagnosed with PMOS" value={!!val("diagnosed")} onChange={set("diagnosed")} edited={"diagnosed" in lab} />
        <LabToggle label="Has had first period" value={!!val("hasMenarche")} onChange={set("hasMenarche")} edited={"hasMenarche" in lab} />
        <LabToggle label="On hormonal contraception" value={!!val("onContraception")} onChange={set("onContraception")} edited={"onContraception" in lab} />
        <LabToggle label="Persistent acne" value={!!val("persistentAcne")} onChange={set("persistentAcne")} edited={"persistentAcne" in lab} />
      </div>

      <div style={{ marginTop: 16 }}><Label color={C.inkVar}>Rule thresholds</Label></div>
      <div style={grid}>
        {rules.cycleBands.map((b, i) => (<React.Fragment key={i}>
          <LabNumber label={`${b.label} — short`} suffix="days" value={band(i, "shortDays")} onChange={setBand(i, "shortDays")} edited={labRules.cycleBands?.[i]?.shortDays != null} />
          <LabNumber label={`${b.label} — long`} suffix="days" value={band(i, "longDays")} onChange={setBand(i, "longDays")} edited={labRules.cycleBands?.[i]?.longDays != null} />
        </React.Fragment>))}
        <LabNumber label="Single-cycle alert" suffix="days" value={rule("singleCycleDays")} onChange={setRule("singleCycleDays")} edited={"singleCycleDays" in labRules} />
        <LabNumber label="Min cycles per year" value={rule("minCyclesPerYear")} onChange={setRule("minCyclesPerYear")} edited={"minCyclesPerYear" in labRules} />
        <LabNumber label="No menarche by age" value={rule("amenorrheaAge")} onChange={setRule("amenorrheaAge")} edited={"amenorrheaAge" in labRules} />
        <LabNumber label="mFG hirsutism cut-off" value={rule("mfgHirsutism")} onChange={setRule("mfgHirsutism")} edited={"mfgHirsutism" in labRules} />
        <LabNumber label="Hair growth days cut-off" suffix="%" value={rule("hirsutismDaysPct")} onChange={setRule("hirsutismDaysPct")} edited={"hirsutismDaysPct" in labRules} />
        <LabNumber label="Cycles needed to judge" value={rule("minCyclesToJudge")} onChange={setRule("minCyclesToJudge")} edited={"minCyclesToJudge" in labRules} />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <Pill variant="outline" onClick={() => setLab({})}>Reset to my data</Pill>
        <Pill variant="outline" onClick={() => setLabRules({})}>Reset thresholds</Pill>
      </div>
    </div>)}
  </Card>);
}

// ---- the three criteria ----------------------------------------------------
// A real Venn: the three centres sit on an equilateral triangle one radius
// apart, so every pair overlaps and all three share a middle. That middle is
// the point — a diagnosis needs two of the three, and the third can only be
// assessed in a clinic, so it is drawn dashed and never filled.
const TRIAD = (() => {
  const r = 52, side = 52, cx = 120, cy = 104, R = side / Math.sqrt(3), h = Math.cos(Math.PI / 6);
  const at = [[cx, cy - R], [cx - side / 2, cy + R / 2], [cx + side / 2, cy + R / 2]];
  const out = [[0, -1], [-h, 0.5], [h, 0.5]];
  return { r, at, label: at.map(([x, y], i) => [x + out[i][0] * r * 0.44, y + out[i][1] * r * 0.44 + 3]) };
})();

function Triad({ axes }) {
  if (!axes) return null;
  const parts = [{ key: "ovulatory", text: "CYCLES" }, { key: "androgen", text: "ANDROGEN" }, { key: "morphology", text: "OVARIES" }];
  const skin = (met) => met === null
    ? { fill: "rgba(115,102,136,0.05)", stroke: C.outline, width: 1.5, dash: "5 5" }
    : met ? { fill: "rgba(223,163,168,0.30)", stroke: C.roseDeep, width: 2.5, dash: "none" }
          : { fill: "rgba(92,75,125,0.08)", stroke: C.plumC, width: 1.5, dash: "none" };
  return (<svg viewBox="0 0 240 205" width="100%" style={{ maxWidth: 260 }}>
    {parts.map(({ key }, i) => {
      const k = skin(axes[key].met), [x, y] = TRIAD.at[i];
      return <circle key={key} cx={x} cy={y} r={TRIAD.r} fill={k.fill} stroke={k.stroke} strokeWidth={k.width} strokeDasharray={k.dash} />;
    })}
    {parts.map(({ key, text }, i) => {
      const [x, y] = TRIAD.label[i];
      return <text key={key} x={x} y={y} textAnchor="middle" style={{ fontFamily: bodyf, fontSize: 8.5, fontWeight: 700, letterSpacing: "0.02em",
        fill: axes[key].met === null ? C.outline : C.ink }}>{text}</text>;
    })}
    <text x="120" y="196" textAnchor="middle" style={{ fontFamily: bodyf, fontSize: 8.5, fill: C.outline }}>
      two of three — the third needs a clinic</text>
  </svg>);
}

// ============================================================================
//  APP
// ============================================================================
const BLANK = { onboarded: false, name: "", age: "", menarcheAge: "", heightCm: "", weightKg: "", familyHistory: false, acne: false, skinDarkening: false, weightGain: false, goals: [], integrations: [], conditions: [], mfg: {}, drugs: [], pmosDiagnosed: null, pmosDiagnosedYear: "" };

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
  const schema = useRecordSchema(settings);

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

  // The profile is edited in the browser but read by the rules in the backend —
  // conditions, the mFG sheet and drug therapy all feed criteria.py. Sync it,
  // then bump `synced` so the indicator is re-asked with the new facts.
  const [synced, setSynced] = useState(0);
  useEffect(() => {
    const pid = settings.patientId; if (!ready || !pid) return;
    const num = (v) => (v === "" || v == null ? null : Number(v));
    const body = {
      name: profile.name || "", age: num(profile.age), menarche_age: num(profile.menarcheAge),
      height_cm: num(profile.heightCm), weight_kg: num(profile.weightKg),
      family_history: !!profile.familyHistory, acne: !!profile.acne,
      skin_darkening: !!profile.skinDarkening, weight_gain: !!profile.weightGain,
      goals: profile.goals || [], integrations: profile.integrations || [],
      conditions: profile.conditions || [], mfg: profile.mfg || {}, drugs: profile.drugs || [],
      pmos_diagnosed: profile.pmosDiagnosed === true, pmos_diagnosed_year: num(profile.pmosDiagnosedYear),
    };
    let stale = false;
    const t = setTimeout(() => {
      fetch(`${API(settings)}/patients/${pid}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) }).then(() => { if (!stale) setSynced((n) => n + 1); }).catch(() => {});
    }, 400);
    return () => { stale = true; clearTimeout(t); };
  }, [ready, settings.patientId, settings.backendUrl, profile]);

  // Derived stats come from the backend (insights.py) so the client and the
  // model never work from two different sets of numbers.
  const [ins, setIns] = useState({ loggedDays: 0 });
  useEffect(() => {
    const pid = settings.patientId; if (!pid) return;
    let stale = false;
    (async () => {
      try {
        const r = await fetch(`${API(settings)}/patients/${pid}/summary`);
        if (r.ok && !stale) setIns(await r.json());
      } catch (e) { /* keep the last good summary */ }
    })();
    return () => { stale = true; };
  }, [settings.patientId, settings.backendUrl, logs, synced]);
  // The verdict is the backend's to give. `lab` holds hypothetical inputs and
  // thresholds; when it is non-empty we ask /assess instead of the patient's
  // own assessment, so the panel can bend the rules without touching the logs.
  const [assessment, setAssessment] = useState(null);
  const [derived, setDerived] = useState({});
  const [rules, setRules] = useState(null);
  const [lab, setLab] = useState({});
  const [labRules, setLabRules] = useState({});

  useEffect(() => { (async () => {
    try {
      const r = await fetch(`${API(settings)}/criteria/rules`);
      if (r.ok) setRules(await r.json());
    } catch (e) { /* the panel just stays closed */ }
  })(); }, [settings.backendUrl]);

  useEffect(() => {
    const pid = settings.patientId; if (!pid) return;
    const base = API(settings);
    const hypothetical = Object.keys(lab).length || Object.keys(labRules).length;
    const go = async () => {
      try {
        const r = hypothetical
          ? await fetch(`${base}/assess`, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ inputs: { ...derived, ...lab }, rules: labRules }) })
          : await fetch(`${base}/patients/${pid}/assessment`);
        if (!r.ok) return;
        const a = await r.json();
        setAssessment(a);
        if (!hypothetical) setDerived(a.inputs);   // the measured baseline the lab starts from
      } catch (e) { /* indicator stays as it was */ }
    };
    // debounced so typing in the lab doesn't fire a request per keystroke
    const t = setTimeout(go, hypothetical ? 150 : 0);
    return () => clearTimeout(t);
  }, [settings.patientId, settings.backendUrl, logs, lab, labRules, synced]);

  const axes = assessment?.axes;
  const ctx = { profile, setProfile, logs, setLogs, settings, setSettings, ins, assessment, axes,
    derived, lab, setLab, rules, labRules, setLabRules, setTab, wide, schema };

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

  if (!ready) return mobileShell(<div style={{ display: "grid", placeItems: "center", height: "100vh" }}><Loader2 className="spin" color={C.plum} /></div>, false);
  if (!profile.onboarded) return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: bodyf, color: C.ink, display: "flex", justifyContent: "center", backgroundImage: GRAD }}>
      <style>{FONTS}</style>
      <div style={{ width: "100%", maxWidth: 560 }}><Onboarding profile={profile} setProfile={setProfile} /></div>
    </div>);

  const contentMax = { home: 1140, insights: 1140, advocacy: 900, clinician: 940, prepare: 880, chat: 760, record: 1180, settings: 640 }[tab] || 1080;
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
    <header style={{ position: "sticky", top: 0, zIndex: 20, background: "rgba(251,239,239,0.88)", backdropFilter: "blur(10px)", borderBottom: `1px solid ${C.high}` }}>
      <div style={{ maxWidth: 1140, margin: "0 auto", padding: "12px 40px", display: "flex", alignItems: "center", gap: 8 }}>
        <button onClick={() => setTab("home")} style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", cursor: "pointer", marginRight: 18 }}>
          <BrandMark size={32} /><span dir="rtl" style={{ fontFamily: head, fontWeight: 700, fontSize: 25, color: C.plum }}>توازن</span>
        </button>
        <nav style={{ display: "flex", gap: 2 }}>
          {items.map(([id, label]) => { const on = tab === id; return (
            <button key={id} onClick={() => setTab(id)} style={{ fontFamily: bodyf, fontSize: 15, fontWeight: on ? 600 : 500, padding: "9px 16px", borderRadius: 9999, cursor: "pointer", border: "none",
              background: on ? C.lilac : "transparent", color: on ? C.plumDark : C.inkVar }}>{label}</button>); })}
        </nav>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <button onClick={() => setTab("settings")} style={{ background: "none", border: "none", cursor: "pointer", color: tab === "settings" ? C.plum : C.inkVar, display: "grid", placeItems: "center" }}><Cog size={22} /></button>
          <span style={{ width: 34, height: 34, borderRadius: "50%", background: C.lilac, color: C.plumDark, display: "grid", placeItems: "center", fontFamily: head, fontWeight: 700, fontSize: 15 }}>{(profile.name || "Y")[0].toUpperCase()}</span>
        </div>
      </div>
    </header>);
}

// ---- header + bottom nav ---------------------------------------------------
function Header({ profile, onSettings }) {
  return (<div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px 10px" }}>
    <BrandMark size={32} />
    <span dir="rtl" style={{ fontFamily: head, fontWeight: 700, fontSize: 25, color: C.plum }}>توازن</span>
    <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
      <button onClick={onSettings} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkVar, display: "grid", placeItems: "center" }}><Cog size={22} /></button>
      <span style={{ width: 34, height: 34, borderRadius: "50%", background: C.lilac, color: C.plumDark, display: "grid", placeItems: "center", fontFamily: head, fontWeight: 700, fontSize: 15 }}>{(profile.name || "Y")[0].toUpperCase()}</span>
    </div>
  </div>);
}
function BottomNav({ tab, setTab }) {
  const items = [["home", "Home", Home], ["record", "Record", SquarePen], ["insights", "Insights", BarChart3], ["chat", "Chat", MessageCircle], ["settings", "Settings", Cog]];
  return (<div className="no-print" style={{ position: "fixed", bottom: 0, left: 0, right: 0, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
    <div style={{ width: "100%", maxWidth: 460, background: "rgba(251,239,239,0.92)", backdropFilter: "blur(10px)", borderTop: `1px solid ${C.high}`, display: "flex", padding: "8px 6px 10px", pointerEvents: "auto" }}>
      {items.map(([id, label, Ico]) => { const on = tab === id; return (
        <button key={id} onClick={() => setTab(id)} style={{ flex: 1, background: "none", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
          <span style={{ padding: "5px 16px", borderRadius: 9999, background: on ? C.lilac : "transparent", display: "grid", placeItems: "center", transition: "all .15s" }}><Ico size={20} color={on ? C.plumDark : C.outline} /></span>
          <span style={{ fontFamily: bodyf, fontSize: 11, fontWeight: on ? 600 : 500, color: on ? C.plum : C.outline }}>{label}</span>
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
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 30 }}><BrandMark /><span dir="rtl" style={{ fontFamily: head, fontWeight: 700, fontSize: 30, color: C.plum }}>توازن</span></div>
    <Card style={{ borderRadius: 24, padding: 24, boxShadow: SH }}>
      {step === 0 && (<><Label>Welcome</Label><H size={26} style={{ margin: "10px 0 8px" }}>Let's build your digital twin</H>
        <p style={{ color: C.inkVar, lineHeight: 1.5, marginBottom: 20 }}><Brand /> learns your patterns, helps you make sense of them, and gets you ready for the clinician. What brings you here?</p>
        <div style={{ display: "grid", gap: 10 }}>{GOALS.map(([id, l, Ico]) => { const on = profile.goals.includes(id); return (
          <button key={id} onClick={() => tog("goals", id)} style={{ textAlign: "left", padding: 16, borderRadius: 16, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, background: on ? C.lilac : C.low, border: `1.5px solid ${on ? C.plum : "transparent"}` }}>
            <Ico size={22} color={C.plum} /><span style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>{l}</span>{on && <Check size={18} color={C.plum} style={{ marginLeft: "auto" }} />}</button>); })}</div></>)}
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
      {step === 2 && (<><Label>Your health</Label><H size={24} style={{ margin: "10px 0 8px" }}>Anything already diagnosed?</H>
        <p style={{ color: C.inkVar, lineHeight: 1.5, marginBottom: 16 }}>Only what a clinician has told you. It changes how we read your tracking — and you can change it any time in Settings.</p>
        <div style={{ padding: 14, borderRadius: 16, background: C.low, marginBottom: 16 }}>
          <div style={{ fontFamily: head, fontWeight: 600, fontSize: 15, marginBottom: 10 }}>Have you been diagnosed with PMOS?</div>
          <DiagnosisPanel profile={profile} setProfile={setProfile} />
        </div>
        <ConditionsPanel profile={profile} setProfile={setProfile} compact /></>)}
      {step === 3 && (<><Label>Connect your data</Label><H size={24} style={{ margin: "10px 0 8px" }}>Bring it together</H>
        <p style={{ color: C.inkVar, lineHeight: 1.5, marginBottom: 16 }}>Fold in cycles, sleep, and activity you already log (demo connections).</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{APPS.map((a) => (<Chip key={a} active={profile.integrations.includes(a)} onClick={() => tog("integrations", a)}>{a}</Chip>))}</div>
        <div style={{ marginTop: 16, padding: 14, background: C.lilac, borderRadius: 14, fontSize: 14, color: C.onLilac, lineHeight: 1.5 }}>We've pre-loaded three months of sample tracking so your twin has something to learn from right away.</div></>)}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
        <Pill variant="soft" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} style={{ padding: "13px 18px" }}><ArrowLeft size={16} /> Back</Pill>
        <Pill onClick={() => step < 3 ? setStep(step + 1) : set("onboarded", true)} disabled={step === 0 && profile.goals.length === 0}>{step < 3 ? "Continue" : <>Enter <Brand /></>} <ArrowRight size={16} /></Pill>
      </div>
    </Card>
  </div>);
}

// ---- HOME (dashboard) ------------------------------------------------------
// soft donut showing where you are in your cycle (pastel phase arcs + a marker)
function arcPath(cx, cy, rO, rI, a0, a1) {
  const pt = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const large = (a1 - a0) > Math.PI ? 1 : 0;
  const [x0, y0] = pt(rO, a0), [x1, y1] = pt(rO, a1), [x2, y2] = pt(rI, a1), [x3, y3] = pt(rI, a0);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${rO},${rO} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${rI},${rI} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
}
const PHASE_COLORS = [["Menstrual", C.roseDeep], ["Follicular", C.lilacDim], ["Ovulatory", "#e6be8a"], ["Luteal", C.plumC]];
function CyclePhaseRing({ dayN, cycleLen }) {
  const cyc = cycleLen && cycleLen > 0 ? Math.round(cycleLen) : 28;
  const day = dayN == null ? null : Math.max(0, Math.min(cyc, dayN));
  const ovuMid = Math.max(8, cyc - 14);
  const segs = [
    { name: "Menstrual", a: 0, b: Math.min(5, cyc), color: C.roseDeep },
    { name: "Follicular", a: Math.min(5, cyc), b: Math.max(6, ovuMid - 2), color: C.lilacDim },
    { name: "Ovulatory", a: Math.max(6, ovuMid - 2), b: Math.min(cyc, ovuMid + 2), color: "#e6be8a" },
    { name: "Luteal", a: Math.min(cyc, ovuMid + 2), b: cyc, color: C.plumC },
  ].filter((s) => s.b > s.a);
  const S = 196, cx = S / 2, cy = S / 2, rO = 86, rI = 62, gap = 0.03;
  const ang = (d) => (d / cyc) * 2 * Math.PI;
  const phase = day == null ? null : (segs.find((s) => day >= s.a && day < s.b) || segs[segs.length - 1]);
  const mAng = day == null ? 0 : ang(day); const mr = (rO + rI) / 2;
  const mx = cx + mr * Math.sin(mAng), my = cy - mr * Math.cos(mAng);
  return (<svg viewBox={`0 0 ${S} ${S}`} width="100%" style={{ maxWidth: 216, display: "block" }}>
    {segs.map((s, i) => { const active = phase && phase.name === s.name; return (
      <path key={i} d={arcPath(cx, cy, rO, rI, ang(s.a) + gap, ang(s.b) - gap)} fill={s.color} fillOpacity={active ? 0.85 : 0.3} style={{ transition: "fill-opacity .5s ease" }} />); })}
    {day != null && <circle cx={mx} cy={my} r={7} fill="#fff" stroke={C.plum} strokeWidth={3} />}
    <text x={cx} y={cy - 5} textAnchor="middle" style={{ fontFamily: head, fontWeight: 700, fontSize: 30, fill: C.ink }}>{day == null ? "—" : `Day ${day}`}</text>
    <text x={cx} y={cy + 16} textAnchor="middle" style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, fill: C.inkVar }}>{phase ? phase.name : "Start tracking"}</text>
  </svg>);
}

function HomeScreen({ profile, setProfile, logs, setLogs, ins, assessment, setTab, wide, settings }) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = logs.find((l) => l.date === todayStr);
  // Marking period days from the calendar. Each date keeps whatever else was
  // logged that day; only `period` moves, and the day is persisted as it is set.
  const setPeriodDays = (dates, value) => {
    const touched = new Set(dates);
    const kept = logs.filter((l) => !touched.has(l.date));
    const entries = dates.map((date) => ({
      ...(logs.find((l) => l.date === date) || { date, pain: 0, sugar: 2, mood: 5, energy: 5,
        hairGrowth: false, hairLoss: false, cravings: false, note: "", categories: [] }),
      date, period: value,
    }));
    setLogs([...kept, ...entries].sort((a, b) => a.date.localeCompare(b.date)));
    const pid = settings?.patientId;
    if (pid) {
      const b = API(settings);
      entries.forEach((entry) => fetch(`${b}/patients/${pid}/logs`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry) }).catch(() => {}));
    }
  };
  const now = new Date(); const phase = ins.cycleDay == null ? "—" : ins.cycleDay <= 5 ? "Menstrual" : ins.cycleDay <= 13 ? "Follicular" : ins.cycleDay <= 16 ? "Ovulatory" : "Luteal";
  const chips = []; if (today) { if (today.pain >= 6) chips.push("High pain"); else if (today.pain > 0) chips.push("Mild pain"); if (today.hairGrowth || today.hairLoss) chips.push("Hair health"); if (today.bloating) chips.push("Bloating"); if (today.cravings) chips.push("Cravings"); if (today.mood <= 3) chips.push("Low mood"); }

  const calendarBlock = (
    <div>
      <Label>{now.toLocaleString(undefined, { month: "long", year: "numeric" })}</Label>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
        <H size={24}>Your Cycle</H>
        <button onClick={() => setTab("insights")} style={{ background: "none", border: "none", color: C.plum, fontFamily: bodyf, fontWeight: 600, fontSize: 14, cursor: "pointer", display: "inline-flex", gap: 3, alignItems: "center" }}>View history <ChevronRight size={15} /></button>
      </div>
      <Card style={{ marginTop: 12, padding: 16, background: C.low, boxShadow: "none" }}>
        <CycleCalendar logs={logs} onSet={setPeriodDays} /></Card>
    </div>);
  const drugCard = <DrugTherapy profile={profile} setProfile={setProfile} />;
  const phaseTiles = (
    <Card style={{ padding: 20, boxShadow: SH_SM }}>
      <div style={{ display: "flex", justifyContent: "center" }}><CyclePhaseRing dayN={ins.cycleDay} cycleLen={ins.avgCycleDays} /></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center", marginTop: 8 }}>
        {PHASE_COLORS.map(([n, col]) => (<span key={n} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: bodyf, fontSize: 11.5, color: C.inkVar }}><span style={{ width: 9, height: 9, borderRadius: "50%", background: col, opacity: 0.65 }} /> {n}</span>))}
      </div>
      <div style={{ textAlign: "center", fontSize: 12.5, color: C.inkVar, marginTop: 10 }}>{ins.avgCycleDays ? `~${ins.avgCycleDays}-day cycle · ${ins.avgCycleDays > 35 ? "irregular" : "stable"}` : "Log a few periods to map your cycle"}</div>
    </Card>);
  const recordCTA = (
    <button onClick={() => setTab("record")} style={{ width: "100%", background: C.plum, color: "#fff", border: "none", borderRadius: 18, padding: "22px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: SH }}>
      <span style={{ fontFamily: head, fontWeight: 700, fontSize: 22 }}>Record your day</span>
      <span style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(255,255,255,0.18)", display: "grid", placeItems: "center" }}><Plus size={20} color="#fff" /></span>
    </button>);
  const trackedToday = chips.length > 0 && (
    <div><Label color={C.inkVar}>Tracked today</Label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>{chips.map((c) => (<span key={c} style={{ fontFamily: bodyf, fontSize: 13, fontWeight: 500, padding: "8px 14px", borderRadius: 9999, background: C.surface, border: `1px solid ${C.outlineVar}`, color: C.inkVar }}>{c}</span>))}</div></div>);
  // The verdict rides on the card that leads to it, so it is visible on landing.
  const rec = assessment?.recommendation, recTone = rec ? TONE[rec.tone] : TONE.muted;
  const prepareCard = (
    <Card onClick={() => setTab("advocacy")} style={{ display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
      <span style={{ width: 42, height: 42, borderRadius: 12, background: recTone.bg, display: "grid", placeItems: "center", flexShrink: 0 }}>
        <recTone.Icon size={20} color={recTone.fg} /></span>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>{rec ? rec.headline : "Prepare for your appointment"}</div>
        <div style={{ fontSize: 13, color: C.inkVar }}>{rec?.met ? `${rec.met} of 2 trackable criteria met — see what's behind it` : "See what's behind it, and prepare for a visit"}</div>
      </div>
      <ChevronRight size={20} color={C.outline} />
    </Card>);

  if (wide) return (<div>
    <H size={30} style={{ marginBottom: 22 }}>{profile.name ? `Welcome back, ${profile.name}` : "Welcome back"}</H>
    <div style={{ display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 24, alignItems: "start" }}>
      <div style={{ display: "grid", gap: 20 }}>{calendarBlock}{drugCard}</div>
      <div style={{ display: "grid", gap: 18 }}>{phaseTiles}{recordCTA}{trackedToday}{prepareCard}</div>
    </div>
  </div>);

  return (<div>
    <div style={{ marginTop: 6 }}>{calendarBlock}</div>
    <div style={{ marginTop: 18 }}>{phaseTiles}</div>
    <div style={{ marginTop: 18 }}>{recordCTA}</div>
    <div style={{ marginTop: 18 }}>{drugCard}</div>
    {trackedToday && <div style={{ marginTop: 20 }}>{trackedToday}</div>}
    <div style={{ marginTop: 20 }}>{prepareCard}</div>
  </div>);
}
// Tap a day to log it as a period day, tap it again to take it off. "Range"
// marks a whole bleed in two taps, which is how most people remember it: the
// day it started and the day it stopped.
function CycleCalendar({ logs, onSet }) {
  const now = new Date();
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [range, setRange] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [hover, setHover] = useState(null);
  const [drag, setDrag] = useState(null);
  const skipClick = useRef(false);
  const { y, m } = month;
  // Built from the local date, never toISOString — that shifts a day either side
  // of UTC and would mark the wrong square.
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  // day 0 is the last of the previous month and days+1 the first of the next,
  // so a bleed that crosses a month boundary still joins up.
  const iso = (d) => fmt(new Date(y, m, d));
  const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
  const isThisMonth = y === now.getFullYear() && m === now.getMonth();
  const todayD = isThisMonth ? now.getDate() : null;
  const periodSet = new Set(logs.filter((l) => l.period).map((l) => l.date));
  const marked = (d) => periodSet.has(iso(d));
  const step = (n) => { setAnchor(null); setMonth(({ y: yy, m: mm }) => {
    const d = new Date(yy, mm + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; }); };
  const span = (a, b) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return Array.from({ length: hi - lo + 1 }, (_, i) => iso(lo + i));
  };
  const tap = (d) => {
    if (!onSet) return;
    if (skipClick.current) { skipClick.current = false; return; }
    if (!range) return onSet([iso(d)], !periodSet.has(iso(d)));
    if (!anchor) return setAnchor(d);
    onSet(span(anchor, d), true);
    setAnchor(null);
  };

  // Dragging across days marks the whole stretch in one go, and the highlight
  // flows under the cursor as you go rather than appearing a day at a time.
  // Mouse only: claiming touch drags here would stop the page scrolling.
  const startDrag = (d) => (ev) => {
    if (!onSet || range || ev.pointerType !== "mouse") return;
    setDrag({ from: d, value: !periodSet.has(iso(d)) });
    setHover(d);
  };
  const endDrag = () => {
    if (!drag) return;
    const to = hover == null ? drag.from : hover;
    if (to !== drag.from) { onSet(span(drag.from, to), drag.value); skipClick.current = true; }
    setDrag(null);
  };
  useEffect(() => {
    if (!drag) return;
    const up = () => endDrag();
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  });

  // What the grid should look like right now, including a stretch being dragged
  // or a range half-chosen — so the run reads as one shape before it is saved.
  const preview = drag && hover != null ? [Math.min(drag.from, hover), Math.max(drag.from, hover), drag.value]
    : range && anchor ? [Math.min(anchor, hover == null ? anchor : hover),
                         Math.max(anchor, hover == null ? anchor : hover), true]
    : null;
  const inPreview = (d) => preview && d >= preview[0] && d <= preview[1];
  const shown = (d) => (inPreview(d) ? preview[2] : marked(d));
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  // The most recent bleed, said in words — the grid shows the run, this says
  // which dates it ran between and how long it lasted.
  // Every bleed, so a run can say how long after the previous one it began —
  // start-to-start is the cycle length, and it is what makes two bleeds read as
  // two cycles rather than one broken stretch.
  const runs = (() => {
    const dates = [...new Set(logs.filter((l) => l.period).map((l) => l.date))].sort();
    const out = [];
    for (const d of dates) {
      const run = out[out.length - 1], prev = run && run[run.length - 1];
      if (prev && new Date(d) - new Date(prev) === 86400000) run.push(d);
      else out.push([d]);
    }
    return out;
  })();
  const lastRun = runs.length ? runs[runs.length - 1] : null;
  const gapDays = runs.length > 1
    ? Math.round((new Date(runs[runs.length - 1][0]) - new Date(runs[runs.length - 2][0])) / 86400000)
    : null;
  const pretty = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const runLine = lastRun && (() => {
    const a = lastRun[0], b = lastRun[lastRun.length - 1], n = lastRun.length;
    const ongoing = (Date.now() - new Date(`${b}T00:00:00`)) < 2 * 86400000;
    const head = ongoing
      ? `Bleeding since ${pretty(a)} · day ${n}`
      : `Last period ${n > 1 ? `${pretty(a)} – ${pretty(b)}` : pretty(a)} · ${n} day${n > 1 ? "s" : ""}`;
    return gapDays ? `${head} · ${gapDays} days after the one before` : head;
  })();
  const navBtn = (dir, Ico) => (
    <button onClick={() => step(dir)} style={{ background: "none", border: "none", cursor: "pointer", color: C.plum,
      display: "grid", placeItems: "center", padding: 4 }}><Ico size={16} /></button>);
  return (<div>
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
      {navBtn(-1, ChevronLeft)}
      <span style={{ flex: 1, textAlign: "center", fontFamily: head, fontWeight: 600, fontSize: 14, color: C.ink }}>
        {new Date(y, m, 1).toLocaleString(undefined, { month: "long", year: "numeric" })}</span>
      {navBtn(1, ChevronRight)}
      {onSet && <button onClick={() => { setRange((r) => !r); setAnchor(null); }}
        style={{ fontFamily: bodyf, fontSize: 11.5, fontWeight: 600, padding: "5px 10px", borderRadius: 9999,
          cursor: "pointer", background: range ? C.plum : C.surface, color: range ? "#fff" : C.plum,
          border: `1.5px solid ${range ? C.plum : C.outlineVar}` }}>Range</button>}
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", columnGap: 0, marginBottom: 6 }}>
      {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (<div key={i} style={{ textAlign: "center", fontFamily: bodyf, fontSize: 11, fontWeight: 600, color: C.inkVar }}>{d}</div>))}</div>
    <div onPointerLeave={() => !drag && setHover(null)}
      style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", columnGap: 0, rowGap: 2 }}>{cells.map((d, i) => {
      const isToday = d === todayD, isPeriod = d && shown(d);
      const isDraft = d && isPeriod && inPreview(d) && !marked(d);
      // One bleed is drawn as one capsule: days that touch are joined, so the
      // rounded ends are where it started and where it stopped. A lone day is
      // just a circle. Bleeds that cross a Saturday cap at the row edge — the
      // line under the grid is what states the real dates.
      const linkPrev = isPeriod && shown(d - 1), linkNext = isPeriod && shown(d + 1);
      const startsRun = isPeriod && !linkPrev;
      return (<div key={i} style={{ position: "relative", aspectRatio: "1", display: "grid", placeItems: "center" }}>
        {isPeriod && <span style={{ position: "absolute", top: "50%", height: 34, transform: "translateY(-50%)",
          // only the outer ends of a run are rounded; a joined end is square, or
          // the two rounded caps meet in a pinch and the bar looks scalloped
          borderRadius: `${linkPrev ? 0 : 17}px ${linkNext ? 0 : 17}px ${linkNext ? 0 : 17}px ${linkPrev ? 0 : 17}px`,
          background: isDraft ? C.roseDeep : C.roseOn,
          left: linkPrev ? -1 : "calc(50% - 17px)", right: linkNext ? -1 : "calc(50% - 17px)" }} />}
        {d && <span onClick={() => tap(d)} className={onSet ? "cal-day" : undefined}
          onPointerDown={startDrag(d)} onPointerEnter={() => setHover(d)}
          style={{ width: 34, height: 34, borderRadius: "50%", display: "grid",
            placeItems: "center", fontFamily: bodyf, fontSize: 14, fontWeight: isToday || isPeriod ? 700 : 500,
            cursor: onSet ? "pointer" : "default", userSelect: "none", position: "relative",
            background: isPeriod ? "transparent" : C.surface,
            border: isToday ? `2px solid ${isPeriod ? "#fff" : C.plum}`
                            : isPeriod ? "2px solid transparent" : `1px solid ${C.outlineVar}`,
            color: isPeriod ? "#fff" : isToday ? C.plum : C.ink }}>{d}</span>}
        {startsRun && <span title="cycle starts" style={{ position: "absolute", top: "calc(50% + 9px)", left: "50%",
          transform: "translateX(-50%)", width: 5, height: 5, borderRadius: 9999,
          background: "rgba(255,255,255,0.95)", pointerEvents: "none" }} />}
      </div>); })}</div>
    {runLine && <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
      marginTop: 10, fontFamily: bodyf, fontSize: 12.5, color: C.roseOn }}>
      <span style={{ width: 24, height: 11, borderRadius: 9999, background: C.roseOn, flexShrink: 0 }} />
      {runLine}</div>}
    {onSet && <div style={{ textAlign: "center", fontFamily: bodyf, fontSize: 11.5, color: C.outline, marginTop: 6 }}>
      {range ? (anchor ? `Started ${anchor} ${new Date(y, m, 1).toLocaleString(undefined, { month: "short" })} — now tap the last day`
                       : "Tap the first day of the bleed")
             : runs.length
               ? "Tap a day, or drag across several · a dot marks where a cycle starts"
               : "Tap a day, or drag across several, to mark them"}</div>}
  </div>);
}

// ---- RECORD (quiz / convo) -------------------------------------------------
function PersonalityPicker({ value, onChange }) {
  const [open, setOpen] = useState(false); const ref = useRef(null);
  useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const cur = PERSONALITIES.find(([k]) => k === (value || "direct")) || PERSONALITIES[0];
  return (<div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
    <button onClick={() => setOpen((o) => !o)} title="Personality" style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, padding: "0 14px", height: 48, borderRadius: 9999, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8, background: C.surface, color: C.plum, border: `1.5px solid ${C.plum}` }}>
      <Sparkles size={15} /> {cur[1]} <ChevronRight size={15} style={{ transform: `rotate(${open ? -90 : 90}deg)`, transition: "transform .2s ease" }} />
    </button>
    {open && (<div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 40, background: C.surface, borderRadius: 16, boxShadow: SH, padding: 6, width: 220 }}>
      {PERSONALITIES.map(([k, lbl, desc]) => { const on = k === (value || "direct"); return (
        <button key={k} onClick={() => { onChange(k); setOpen(false); }} style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: 10, textAlign: "left", padding: "10px 12px", borderRadius: 12, border: "none", cursor: "pointer", background: on ? C.lilac : "transparent" }}>
          <span><div style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 14, color: on ? C.onLilac : C.ink }}>{lbl}</div><div style={{ fontFamily: bodyf, fontSize: 12, color: on ? C.plumDark : C.inkVar }}>{desc}</div></span>
          {on && <Check size={16} color={C.plum} style={{ flexShrink: 0 }} />}
        </button>); })}
    </div>)}
  </div>);
}
function RecordScreen({ logs, setLogs, settings, setSettings, setTab, wide, ins, schema }) {
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
  const [ended, setEnded] = useState(false); const [modal, setModal] = useState(false); const [spoken, setSpoken] = useState({});  // schema fields Tawazzun heard from speech
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
    const wrap = { padding: "10px 12px", borderRadius: 12, background: on ? C.lilac : "transparent", transition: "background-color .3s ease" };
    const labelEl = (<span style={{ fontFamily: bodyf, fontSize: 14, color: C.ink, display: "inline-flex", alignItems: "center", gap: 6 }}>{f.label}{on && <span style={{ fontFamily: bodyf, fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: C.plum, background: "#fff", borderRadius: 9999, padding: "2px 7px" }}>HEARD</span>}</span>);
    // a field can depend on another answer (birth-control type, craving type)
    if (f.showIf && e[f.showIf.field] !== f.showIf.equals) return null;
    // ...and can open a labelled sub-group, so the three macros read as "Diet"
    const withHeading = (el) => !f.heading ? el : (<React.Fragment key={f.key}>
      <div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em",
        textTransform: "uppercase", color: C.outline, margin: "12px 0 2px", padding: "0 12px" }}>{f.heading}</div>
      {el}</React.Fragment>);
    if (f.type === "emoji") {
      return withHeading(<div key={f.key} style={wrap}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>{labelEl}
          <span style={{ fontFamily: head, fontWeight: 700, fontSize: 13, color: C.plum }}>
            {(f.options.find((o) => o.value === v) || {}).label || ""}</span></div>
        <div style={{ display: "flex", gap: 6, justifyContent: "space-between" }}>
          {f.options.map(({ emoji: face, value: val, label: word }) => (
            <button key={val} onClick={() => set(f.key, val)} title={word} style={{ flex: 1, cursor: "pointer",
              fontSize: 24, lineHeight: 1.1, padding: "6px 0", borderRadius: 12, background: v === val ? C.lilac : C.low,
              border: `1.5px solid ${v === val ? C.plum : "transparent"}`, filter: v === val ? "none" : "grayscale(0.6)",
              opacity: v === val ? 1 : 0.75, transition: "all .15s ease" }}>{face}</button>))}
        </div></div>);
    }
    if (f.type === "bodymap") {
      return withHeading(<div key={f.key} style={wrap}>
        <div style={{ marginBottom: 8 }}>{labelEl}</div>
        <BodyMap value={v} onChange={(pts) => set(f.key, pts)} /></div>);
    }
    if (f.type === "scale") {
      const max = f.max || SCALE_MAX; const disp = scaleDisplay(v ?? 0, max, f.words);
      return withHeading(<div key={f.key} style={wrap}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>{labelEl}<span style={{ fontFamily: head, fontWeight: 700, fontSize: 14, color: C.plum }}>{disp}</span></div>
        <Slider value={clampScale(v, 0, max)} max={max} onChange={(val) => set(f.key, clampScale(val, 0, max))} /></div>);
    }
    const control = f.type === "bool" ? (<div style={{ display: "flex", gap: 6 }}>{[["No", false], ["Yes", true]].map(([lbl, val]) => <Chip key={lbl} active={v === val} onClick={() => set(f.key, v === val ? null : val)}>{lbl}</Chip>)}</div>)
      : f.type === "select" ? (<div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>{f.options.map((o) => <Chip key={o} active={v === o} onClick={() => set(f.key, v === o ? null : o)}>{o}</Chip>)}</div>)
      : f.type === "number" ? (<input type="number" value={v ?? ""} onChange={(ev) => set(f.key, ev.target.value === "" ? null : Number(ev.target.value))} placeholder={f.placeholder || ""} style={{ ...input, width: 120, padding: "9px 11px", fontSize: 14 }} />)
      : (<input value={v || ""} onChange={(ev) => set(f.key, ev.target.value)} placeholder={f.placeholder || ""} style={{ ...input, width: 210, padding: "9px 11px", fontSize: 14 }} />);
    return withHeading(<div key={f.key} style={{ ...wrap, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>{labelEl}<div style={{ flexShrink: 0 }}>{control}</div></div>);
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
      // Merge whatever the schema asks for, rather than a hand-kept list that
      // silently drops any field added to the backend since it was written.
      const next = { ...base };
      const fields = schema.flatMap((g) => g.fields).filter((fd) => fd.type !== "bodymap");
      for (const fd of fields) {
        const k = fd.key;
        if (fd.type === "scale" || fd.type === "emoji") next[k] = scaleValue(k);
        else if (fd.type === "bool") next[k] = f[k] ?? base[k];        // false is an answer
        else next[k] = f[k] ?? base[k];
      }
      // which of them actually came from speech, so those rows can flash
      const heard = fields.map((fd) => fd.key).filter((k) => f[k] != null && f[k] !== false);
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
    // Mic stays OFF through transcription, inference, and Tawazzun's spoken reply —
    // it only comes back on for the next turn (hands-free).
    const resume = () => { if (convoRef.current) voice.start(); };
    if (say) { setReply(say); speaker.speak(say, resume); } else resume();
    if (insRef.current) runAdvise();  // refresh live insights in the background
  };
  const voice = useVoice({ settings, onPartial: setPartial, onFinal: (t) => ingest(t), continuous: false, silenceMs: 1100 });
  const micTap = () => { if (voice.listening) { convoRef.current = false; voice.stop(); } else { convoRef.current = true; voice.start(); } };
  const endConvo = () => { convoRef.current = false; voice.stop(); setEnded(true); setModal(true); };
  const status = busy ? "noting it down…" : voice.listening ? "listening…" : "tap to speak";

  // PRIMARY — the conversation
  const speakBlock = (
    <div style={{ background: C.plumC, borderRadius: 24, padding: 22, boxShadow: SH, textAlign: "center", color: "#fff" }}>
      <div style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 16, lineHeight: 1.4, marginBottom: 16, opacity: 0.95 }}>How has your body been today?</div>
      <div style={{ display: "grid", placeItems: "center", marginBottom: 12 }}>
        <button onClick={micTap} disabled={busy} style={{ width: 96, height: 96, borderRadius: "50%", border: "none", cursor: busy ? "default" : "pointer", display: "grid", placeItems: "center", background: voice.listening ? C.roseOn : "#fff", color: voice.listening ? "#fff" : C.plum, boxShadow: voice.listening ? "0 0 0 6px rgba(255,255,255,0.3)" : SH, animation: voice.listening ? "pulse 1.5s infinite" : "none", opacity: busy ? 0.7 : 1 }}>
          {voice.listening ? <MicOff size={38} /> : <Mic size={38} />}</button></div>
      <div style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", minHeight: 18 }}>{busy ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Loader2 size={13} className="spin" /> {status}</span> : status}</div>
      <div style={{ minHeight: 24, marginTop: 10, fontSize: 15 }}>{partial ? <i style={{ opacity: 0.92 }}>{partial}…</i> : null}</div>
      {reply && (<div style={{ display: "flex", gap: 10, alignItems: "flex-start", textAlign: "left", background: "rgba(255,255,255,0.16)", borderRadius: 16, padding: "12px 14px", marginTop: 12 }}>
        <BrandMark size={32} />
        <div style={{ flex: 1, fontSize: 15, lineHeight: 1.45 }}>{reply}</div>
        {speaker.speaking && <button onClick={speaker.stop} title="Stop speaking" style={{ background: "rgba(255,255,255,0.2)", border: "none", borderRadius: 9999, width: 30, height: 30, display: "grid", placeItems: "center", cursor: "pointer", color: "#fff", flexShrink: 0 }}><VolumeX size={15} /></button>}
      </div>)}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginTop: 12 }}>{["Some pain today", "Tired and bloated", "Feeling good"].map((c) => (<button key={c} onClick={() => ingest(c)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "8px 14px", borderRadius: 9999, background: "rgba(255,255,255,0.16)", border: "1.5px solid rgba(255,255,255,0.35)", color: "#fff", cursor: "pointer" }}>{c}</button>))}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", background: "rgba(255,255,255,0.14)", borderRadius: 9999, padding: 5, marginTop: 12 }}>
        <input value={text} onChange={(ev) => setText(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter" && text.trim()) { ingest(text.trim()); setText(""); } }} placeholder="…or type it" style={{ flex: 1, border: "none", outline: "none", fontFamily: bodyf, fontSize: 15, padding: "8px 12px", background: "transparent", color: "#fff" }} />
      </div>
      <button onClick={endConvo} style={{ marginTop: 10, width: "100%", fontFamily: bodyf, fontWeight: 700, fontSize: 14, padding: "12px", borderRadius: 9999, background: "#fff", color: C.plum, border: "none", cursor: "pointer" }}>End conversation</button>
      {voice.note && <p style={{ fontSize: 12, color: "#fff", marginTop: 10, opacity: 0.9 }}>{voice.note}</p>}
      {err && <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", marginTop: 12, padding: "10px 14px", borderRadius: 12, background: "rgba(255,255,255,0.16)", color: "#fff", fontSize: 13, fontWeight: 600 }}><AlertTriangle size={15} style={{ flexShrink: 0 }} /> {err}</div>}
    </div>);

  // SIDE — the personalized tracker Tawazzun builds from the conversation. New and
  // changed categories rise in and flash a plum "updated" notification.
  const cats = e.categories || [];
  // Literature → form: research-backed trackers the user can add; each is saved
  // as a category on the entry, so it flows into the tracker, trends and JSON.
  const EVL = { Strong: [C.lilac, C.onLilac], Emerging: [C.rose, C.roseOn], Early: [C.container, C.inkVar] };
  const litKey = (s) => "lit_" + String(s.tracker || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const catVal = (key) => { const c = (e.categories || []).find((x) => x.key === key); return c && c.scale ? c.scale.value : undefined; };
  const setLitCat = (s, v) => {
    const key = litKey(s); const cats = (eRef.current.categories || []).slice();
    const cat = { key, label: s.tracker, value: `${v}/10`, scale: { value: v, max: 10 } };
    const idx = cats.findIndex((c) => c.key === key); if (idx >= 0) cats[idx] = cat; else cats.push(cat);
    const n = { ...eRef.current, categories: cats }; setE(n); eRef.current = n; persist(n); setSaved(true);
  };

  // Remove a single tracker category (literature-based or Tawazzun-built).
  const removeCat = (key) => {
    const cats = (eRef.current.categories || []).filter((c) => c.key !== key);
    const n = { ...eRef.current, categories: cats }; setE(n); eRef.current = n; persist(n); setSaved(true);
  };
  // Toggling Literature off also clears the literature-based categories it added.
  const toggleLit = () => {
    const nv = !litOn; setLitOn(nv);
    if (!nv) {
      const cats = (eRef.current.categories || []).filter((c) => !String(c.key).startsWith("lit_"));
      if (cats.length !== (eRef.current.categories || []).length) {
        const n = { ...eRef.current, categories: cats }; setE(n); eRef.current = n; persist(n); setSaved(true);
      }
    }
  };

  const dayBlock = (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <Label color={C.inkVar}>Your day so far</Label>
        <button onClick={() => setModal(true)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, color: C.plum, background: "none", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}><SquarePen size={14} /> Details</button>
      </div>
      {cats.length === 0 ? (
        <Card style={{ color: C.inkVar, fontSize: 14, lineHeight: 1.5 }}><Sparkles size={16} color={C.roseOn} /> &nbsp;As you talk, <Brand /> builds a tracker here — in your own words.</Card>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {cats.map((c) => { const on = !!flash[c.key]; const sc = normalizedScale(c.scale); return (
            <div key={c.key} style={{ position: "relative", background: on ? C.lilac : C.surface, boxShadow: on ? `0 0 0 3px ${C.plum}` : SH_SM, borderRadius: 16, padding: "13px 16px", transition: "box-shadow .35s ease, background-color .35s ease", animation: on ? "rise .3s ease" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: bodyf, fontWeight: 600, fontSize: 14, color: C.inkVar }}>{c.label}
                  {on && <span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 10, letterSpacing: "0.06em", color: C.onLilac, background: "#fff", borderRadius: 9999, padding: "3px 8px", animation: "pulse 1s ease infinite" }}>UPDATED</span>}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  {c.value && <span style={{ fontFamily: head, fontWeight: 700, fontSize: 14, color: C.plum, textAlign: "right" }}>{String(c.value)}</span>}
                  <button onClick={() => removeCat(c.key)} title="Remove this tracker" style={{ background: "none", border: "none", cursor: "pointer", color: C.outline, display: "grid", placeItems: "center", padding: 2 }}><X size={15} /></button>
                </span>
              </div>
              {sc && <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
                <div style={{ flex: 1 }}><Slider value={sc.value} max={sc.max} onChange={(v) => setCatScale(c.key, v)} /></div>
                <span style={{ fontFamily: head, fontWeight: 700, fontSize: 13, color: C.outline, minWidth: 36, textAlign: "right" }}>{sc.value}/{sc.max}</span>
              </div>}
            </div>); })}
        </div>
      )}
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
    <Card style={{ padding: 16, position: wide ? "sticky" : "static", top: 88, boxShadow: metricBlink ? `0 0 0 3px ${C.plum}` : SH_SM, transition: "box-shadow .3s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><Label color={C.inkVar}>Live trends</Label>{metricBlink && <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.plum, animation: "pulse 0.8s ease infinite" }} />}</span>
        {advising && <Loader2 size={13} className="spin" color={C.outline} />}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>{METRICS.map(([k, lbl]) => (
        <button key={k} onClick={() => setMetric(k)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 12, padding: "5px 11px", borderRadius: 9999, cursor: "pointer", border: "none", background: mSel === k ? C.plum : C.container, color: mSel === k ? "#fff" : C.inkVar, animation: (metricBlink && mSel === k) ? "pulse 0.9s ease 2" : "none" }}>{lbl}</button>))}</div>
      {series.length > 1 && (<><Sparkline series={series} /><div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.outline, marginTop: 4 }}><span>30d ago</span><span>today</span></div></>)}
      {advice?.headline && <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 14, fontFamily: head, fontWeight: 700, fontSize: 14, lineHeight: 1.3, color: C.plum }}><Sparkles size={14} color={C.roseOn} style={{ flexShrink: 0, marginTop: 1 }} /> {advice.headline}</div>}
      {advice?.correlations?.length > 0 && (<div style={{ display: "grid", gap: 8, marginTop: 10 }}>{advice.correlations.map((c, i) => (
        <div key={i}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: C.inkVar, marginBottom: 3 }}><span>{c.label}</span><span style={{ fontWeight: 700, color: C.plum }}>{Math.round(c.strength)}%</span></div>
          <div style={{ height: 6, borderRadius: 9999, background: C.high }}><div style={{ width: `${Math.max(0, Math.min(100, c.strength))}%`, height: "100%", borderRadius: 9999, background: C.plum, transition: "width .5s ease" }} /></div>
        </div>))}</div>)}
      {advice?.say ? (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, background: C.lilac, color: C.onLilac, borderRadius: 14, padding: "11px 12px" }}>
          <div style={{ flex: 1, fontSize: 13, lineHeight: 1.4 }}>{advice.say}</div>
          <button onClick={() => speaker.speak(advice.say)} title="Hear it" style={{ background: "rgba(92,75,125,0.10)", border: "none", borderRadius: 9999, width: 26, height: 26, display: "grid", placeItems: "center", cursor: "pointer", color: C.plum, flexShrink: 0 }}><Volume2 size={13} /></button>
        </div>
      ) : (!advising && <p style={{ fontSize: 12, color: C.inkVar, marginTop: 12 }}>Keep talking — patterns from your history &amp; today show up here.</p>)}
    </Card>);

  // The "End conversation" sheet — fill the standard schema fields by hand.
  const fieldsModal = modal ? (
    <div onClick={() => setModal(false)} style={{ position: "fixed", inset: 0, background: "rgba(42,35,49,0.45)", zIndex: 100, display: "grid", placeItems: "center", padding: 16 }}>
      <div onClick={(ev) => ev.stopPropagation()} style={{ background: C.surface, borderRadius: 24, boxShadow: SH, width: "100%", maxWidth: 520, maxHeight: "86vh", overflowY: "auto", padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <H size={22}>Fill in your day</H>
          <button onClick={() => setModal(false)} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkVar }}><X size={22} /></button>
        </div>
        <p style={{ color: C.inkVar, fontSize: 14, marginBottom: 14 }}>Optional — add anything you didn't say out loud. You can keep talking after.</p>
        {schema.map((g) => (<div key={g.key || g.group} style={{ marginBottom: 14 }}>
          <Label color={C.inkVar}>{g.group}</Label>
          <div style={{ marginTop: 4 }}>{g.fields.map(field)}</div>
        </div>))}
        {litOn && (<div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}><Microscope size={14} color={C.plum} /><Label color={C.inkVar}>From the literature · research-backed</Label></div>
          {(lit === null || lit.length === 0) ? <p style={{ fontSize: 12, color: C.outline, marginTop: 6 }}>Scanning recent PMOS research…</p> : (
            <div style={{ marginTop: 4 }}>{lit.slice(0, 8).map((s, i) => { const key = litKey(s); const v = catVal(key); const [bg, fg] = EVL[s.evidence] || [C.container, C.inkVar]; return (
              <div key={i} style={{ padding: "10px 0", borderTop: i ? `1px solid ${C.high}` : "none" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: bodyf, fontSize: 14, color: C.ink }}>{s.tracker}<span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 9, padding: "2px 6px", borderRadius: 9999, background: bg, color: fg }}>{s.evidence}</span></span>
                  <span style={{ fontFamily: head, fontWeight: 700, fontSize: 13, color: v == null ? C.outline : C.plum }}>{v == null ? "—" : `${v}/10`}</span>
                </div>
                <p style={{ fontSize: 11.5, color: C.outline, lineHeight: 1.45, margin: "3px 0 6px" }}>{s.explanation} <a href={s.read_more} target="_blank" rel="noopener noreferrer" style={{ color: C.plum, fontWeight: 600 }}>research →</a></p>
                <Slider value={v ?? 0} max={10} onChange={(val) => setLitCat(s, val)} />
              </div>); })}</div>)}
        </div>)}
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
        <Pill variant={litOn ? "filled" : "outline"} onClick={toggleLit} style={{ padding: "10px 16px", fontSize: 14, flexShrink: 0 }}><Microscope size={15} /> Literature</Pill>
      </div>
    </div>
    <p style={{ color: C.inkVar, marginBottom: 18 }}>Just talk — <Brand /> listens, talks back, and builds your personal tracker as you go.</p>
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
  return (<div style={{ borderRadius: 12, padding: 8, margin: -8, transition: "background-color .35s ease", background: flash ? C.lilac : "transparent" }}>
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><span style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>{label}</span><span style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, color: flash ? C.plumDark : C.plum }}>{scaleDisplay(v, SCALE_MAX, words)}</span></div>
    <Slider value={v} max={SCALE_MAX} onChange={(next) => onChange(clampScale(next))} /></div>);
}
function MicBtn({ listening, onClick, size = 46 }) {
  return (<button onClick={onClick} style={{ width: size, height: size, borderRadius: "50%", border: "none", cursor: "pointer", display: "grid", placeItems: "center", flexShrink: 0, background: listening ? C.roseOn : C.plum, color: "#fff", boxShadow: listening ? `0 0 0 5px ${C.rose}` : "none", animation: listening ? "pulse 1.4s infinite" : "none" }}>{listening ? <MicOff size={size * 0.42} /> : <Mic size={size * 0.42} />}</button>);
}

// ---- INSIGHTS (twin) -------------------------------------------------------
function InsightsScreen({ ins, logs, settings, wide }) {
  // metric list = standard fields + personalized categories that carry a slider
  const STD = [["pain", "Pain"], ["mood", "Mood"], ["energy", "Energy"], ["sleep", "Sleep"], ["brainFog", "Brain fog"], ["sugar", "Sugar"]]
    .filter(([k]) => !(k === "mood" && isBlocked(settings, "mood")) && !(k === "sugar" && isBlocked(settings, "diet"))).map(([k, l]) => [k, l, false]);
  const seen = {}; logs.forEach((l) => (l.categories || []).forEach((c) => { if (c && c.scale && typeof c.scale.value === "number" && c.key) seen[c.key] = c.label || c.key; }));
  const used = new Set([...STD.map(([k]) => k), ...STD.map(([, l]) => l.toLowerCase())]);
  // "Pain & cramps" is the pain slider under another name. A self-named tracker
  // that shares a word with a standard metric is the same thing said twice, so
  // it doesn't earn a second chip — exact-label matching alone missed these.
  const stdWords = new Set(STD.flatMap(([k, l]) => [k.toLowerCase(), ...l.toLowerCase().split(/[^a-z]+/)]).filter(Boolean));
  const catList = [];
  for (const [k, l] of Object.entries(seen)) {
    const n = String(l).toLowerCase();
    if (used.has(n) || n.split(/[^a-z]+/).filter(Boolean).some((w) => stdWords.has(w))) continue;
    used.add(n); catList.push([k, l, true]);
  }
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
  const exChip = (lbl, sel, on) => (<button key={lbl} onClick={on} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 12, padding: "5px 10px", borderRadius: 9999, border: "none", cursor: "pointer", background: sel ? C.plum : C.container, color: sel ? "#fff" : C.inkVar }}>{lbl}</button>);

  // Claude analysis + computed statistics over the DB logs
  const [analysis, setAnalysis] = useState(null); const [stats, setStats] = useState(null); const [loadingA, setLoadingA] = useState(false);
  const [errA, setErrA] = useState("");
  useEffect(() => { (async () => {
    const pid = settings.patientId; if (!pid) return; setLoadingA(true);
    setErrA("");
    try {
      const b = (settings.backendUrl || "/api").replace(/\/$/, "");
      const r = await fetch(`${b}/patients/${pid}/insights`, { method: "POST" });
      if (r.ok) { const j = await r.json(); setAnalysis(j.analysis); setStats(j.stats); }
      // A failure here used to fall through silently and show the "keep logging"
      // empty state, which reads as "not enough data" — say what actually broke.
      else setErrA((await r.json().catch(() => ({}))).detail || `Analysis failed (${r.status}).`);
    } catch (e) { setErrA("Can't reach the backend — make sure it's running."); }
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

  const summaryCard = (<Card>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: head, fontWeight: 600, fontSize: 17 }}><Sparkles size={18} color={C.roseOn} /> Analysis from <Brand /></span>
      {loadingA && <Loader2 size={14} className="spin" color={C.outline} />}
    </div>
    {analysis?.summary ? <p style={{ fontSize: 14, lineHeight: 1.5, color: C.ink, margin: 0 }}>{analysis.summary}</p>
      : errA ? (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, lineHeight: 1.45, color: C.roseOn }}>
          <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} /><span>{errA}</span></div>
      ) : (!loadingA && <p style={{ fontSize: 13, color: C.inkVar, margin: 0 }}>Keep logging — <Brand /> analyses your trends here.</p>)}
  </Card>);

  // Everything found in the data, filed under the section of the Record screen
  // it came from — so an insight sits where the question that produced it was.
  const SECTION_ICONS = { cycle: Droplet, wellbeing: Heart, body: Activity, lifestyle: HeartPulse, skin: Sparkles };
  const sectionCards = (stats?.byCategory || []).map((g) => {
    const Ico = SECTION_ICONS[g.key] || Info;
    const mine = (analysis?.insights || []).filter((it) => it.category === g.key);
    const empty = !mine.length && !g.correlations.length && !g.trends.length && !g.facts.length;
    return (<Card key={g.key}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, background: C.lilac, display: "grid", placeItems: "center" }}>
          <Ico size={16} color={C.plumDark} /></span>
        <span style={{ fontFamily: head, fontWeight: 600, fontSize: 17 }}>{g.label}</span>
        {g.count > 0 && <span style={{ marginLeft: "auto", fontFamily: bodyf, fontSize: 11.5, fontWeight: 700, color: C.plum, background: C.low, borderRadius: 9999, padding: "3px 9px" }}>{g.count} found</span>}
      </div>
      {empty && <p style={{ fontSize: 13, color: C.outline, margin: 0 }}>Nothing to report here yet — a few more logged days and this fills in.</p>}
      {mine.map((it, i) => (<div key={`ai${i}`} style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
          <span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 14, color: C.plum }}>{it.title}</span>
          <span style={{ fontFamily: head, fontWeight: 700, fontSize: 13, color: C.plum }}>{Math.round(it.strength ?? 0)}%</span></div>
        <div style={{ height: 6, borderRadius: 9999, background: C.high, marginBottom: 6 }}>
          <div style={{ width: `${Math.max(0, Math.min(100, it.strength ?? 0))}%`, height: "100%", borderRadius: 9999, background: C.plum }} /></div>
        <p style={{ fontSize: 13, lineHeight: 1.45, color: C.inkVar, margin: 0 }}>{it.detail}</p>
      </div>))}
      {g.correlations.map((c, i) => { const a = Math.abs(c.r); return (
        <div key={`c${i}`} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13.5, color: C.ink }}>{c.label}</span>
            <span style={{ fontFamily: head, fontWeight: 700, fontSize: 13, color: C.plum }}>r {c.r > 0 ? "+" : ""}{c.r.toFixed(2)}</span></div>
          <div style={{ height: 6, borderRadius: 9999, background: C.high }}>
            <div style={{ width: `${Math.round(a * 100)}%`, height: "100%", borderRadius: 9999, background: a >= 0.6 ? C.plum : C.plumC }} /></div>
          <div style={{ fontSize: 11.5, color: c.holds === false ? C.roseOn : C.outline, marginTop: 3 }}>
            {c.strength} correlation · {c.n} days{c.holds === false ? " · runs the other way in your data" : ""}</div>
        </div>); })}
      {g.trends.length > 0 && (<div style={{ display: "grid", gap: 6, marginTop: g.correlations.length ? 4 : 0 }}>
        {g.trends.map((t, i) => (<div key={`t${i}`} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
          <span style={{ color: C.ink }}>{t.label} over time</span>
          <span style={{ fontFamily: head, fontWeight: 700, color: t.direction === "down" ? C.plum : C.roseOn }}>{t.direction === "up" ? "↑" : "↓"} {Math.abs(t.perWeek)}/wk</span>
        </div>))}</div>)}
      {g.facts.length > 0 && (<div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
        {g.facts.map((f, i) => (<span key={`f${i}`} style={{ fontFamily: bodyf, fontSize: 12, color: C.inkVar, background: C.low, borderRadius: 10, padding: "7px 11px" }}>
          {f.label} <b style={{ color: C.plum }}>{f.value}{f.unit}</b></span>))}</div>)}
    </Card>);
  });

  // Cycle variability: mean ± SD and coefficient of variation
  const cy = stats?.cycle;
  const cycleCard = cy && (<Card>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <Label color={C.inkVar}>Cycle regularity</Label>
      <span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 12, padding: "4px 10px", borderRadius: 9999, background: cy.regular ? C.lilac : C.rose, color: cy.regular ? C.onLilac : C.roseOn }}>{cy.label}</span>
    </div>
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 12 }}>
      <span style={{ fontFamily: head, fontWeight: 700, fontSize: 32, color: C.plum }}>{cy.meanDays}</span>
      <span style={{ fontSize: 14, color: C.inkVar }}>± {cy.sdDays} days (mean ± SD)</span>
    </div>
    <div style={{ fontSize: 13, color: C.inkVar, marginTop: 8 }}>Range {cy.min}–{cy.max} days across {cy.cycles} cycles · variability (CV) {cy.cv}%</div>
    {gaps.length > 0 && <div style={{ marginTop: 12 }}><CycleBars gaps={gaps} /></div>}
    <div style={{ fontSize: 11.5, color: C.outline, marginTop: 10, lineHeight: 1.5 }}>Typical adult cycles run 21–35 days. Consistently longer or highly variable cycles are a common PMOS sign — worth raising with a clinician.</div>
  </Card>);

  // The one place someone can ask their own question of their own data, so it
  // gets a header that says so, controls in plain words, and the answer stated
  // rather than tucked under the chart as a footnote.
  const exBand = exR == null ? null
    : Math.abs(exR) >= 0.6 ? { bg: C.lilac, fg: C.onLilac }
    : Math.abs(exR) >= 0.4 ? { bg: C.low, fg: C.plum }
    : { bg: C.container, fg: C.inkVar };
  const exControls = (<div style={{ display: "grid", gap: 10 }}>
    <div>
      <div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 700, color: C.inkVar, marginBottom: 6 }}>Compare</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{NUM.map(([k, lbl]) => exChip(lbl, xKey === k, () => setXKey(k)))}</div>
    </div>
    <div>
      <div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 700, color: C.inkVar, marginBottom: 6 }}>against</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{NUM.map(([k, lbl]) => exChip(lbl, yKey === k, () => setYKey(k)))}</div>
    </div>
    <div>
      <div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 700, color: C.inkVar, marginBottom: 6 }}>on</div>
      <div style={{ display: "flex", gap: 6 }}>{exChip("the same day", !lagDay, () => setLagDay(false))}{exChip("the day after", lagDay, () => setLagDay(true))}</div>
    </div>
  </div>);
  const exAnswer = exR != null ? (
    <div style={{ padding: "12px 14px", borderRadius: 14, background: exBand.bg, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontFamily: head, fontWeight: 700, fontSize: 24, color: exBand.fg }}>{exR > 0 ? "+" : ""}{exR.toFixed(2)}</span>
        <span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 14, color: exBand.fg }}>{exS}</span>
        <span style={{ fontFamily: bodyf, fontSize: 12, color: exBand.fg, marginLeft: "auto" }}>{exPoints.length} days</span>
      </div>
      <div style={{ fontFamily: bodyf, fontSize: 12.5, lineHeight: 1.5, color: exBand.fg, marginTop: 4 }}>
        {xMeta[1]}{lagDay ? " one day, " : " and "}{lagDay ? `then ${yMeta[1].toLowerCase()} the next` : yMeta[1].toLowerCase()} move
        {exR > 0 ? " together" : " in opposite directions"} — Pearson r, where ±1 is a perfect line and 0 is none.
      </div>
    </div>
  ) : (
    <div style={{ padding: "12px 14px", borderRadius: 14, background: C.container, marginTop: 12,
      fontFamily: bodyf, fontSize: 12.5, color: C.inkVar }}>
      Not enough days where both were logged — pick another pair, or keep logging.
    </div>);
  const explorerCard = (<Card style={{ border: `2px solid ${C.lilac}` }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 11, background: C.plum, display: "grid", placeItems: "center", flexShrink: 0 }}>
        <Activity size={18} color="#fff" /></span>
      <div>
        <div style={{ fontFamily: head, fontWeight: 700, fontSize: 18 }}>Ask your own question</div>
        <div style={{ fontFamily: bodyf, fontSize: 13, color: C.inkVar }}>Put any two things you track against each other</div>
      </div>
    </div>
    <div style={{ display: wide ? "grid" : "block", gridTemplateColumns: wide ? "minmax(0,1fr) minmax(0,1fr)" : undefined, gap: 18, alignItems: "start" }}>
      <div>{exControls}{wide && exAnswer}</div>
      <div style={{ marginTop: wide ? 0 : 14 }}>
        <Scatter points={exPoints} xMax={xMeta[2]} yMax={yMeta[2]} xLabel={`${xMeta[1]}${lagDay ? " (prev day)" : ""}`} yLabel={yMeta[1]} />
        {exPoints.length >= 4 && <div style={{ textAlign: "center", fontFamily: bodyf, fontSize: 11.5, color: C.outline, marginTop: 2 }}>each dot is a day · the line is the best fit</div>}
      </div>
    </div>
    {!wide && exAnswer}
  </Card>);

  const statsLoading = loadingA && !stats;
  const loadingCard = (<Card style={{ display: "flex", alignItems: "center", gap: 10, color: C.inkVar, fontSize: 14 }}><Loader2 size={16} className="spin" color={C.plum} /> Computing your stats &amp; correlations…</Card>);

  // research-backed "what else to track" suggestions
  const EV = { Strong: [C.lilac, C.onLilac], Emerging: [C.rose, C.roseOn], Early: [C.container, C.inkVar] };
  const badge = (txt, bg, fg) => <span style={{ fontFamily: bodyf, fontWeight: 700, fontSize: 10, letterSpacing: "0.03em", padding: "3px 8px", borderRadius: 9999, background: bg, color: fg, whiteSpace: "nowrap" }}>{txt}</span>;
  const suggestionsCard = (<Card>
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <Microscope size={18} color={C.plum} /><span style={{ fontFamily: head, fontWeight: 600, fontSize: 17 }}>What else to track</span>
      {(sugg === null || sugg.length === 0) && <Loader2 size={14} className="spin" color={C.outline} style={{ marginLeft: "auto" }} />}
    </div>
    <p style={{ fontSize: 13, color: C.inkVar, lineHeight: 1.5, margin: "0 0 12px" }}>Research-backed ideas from recent PMOS literature (2022–2025), based on what you already track. Regenerated daily.</p>
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
          {s.requires_device && <div style={{ fontSize: 12, color: s.device_owned ? C.plum : C.outline, marginTop: 2 }}>{s.device_owned ? `✓ works with your ${s.device_needed}` : `needs ${s.device_needed}`}</div>}
          <a href={s.read_more} target="_blank" rel="noopener noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, fontWeight: 600, color: C.plum, marginTop: 7, textDecoration: "none" }}>Read the research →</a>
        </div>); })}</div>
    )}
  </Card>);

  const chipsRow = (<div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 6, marginBottom: 14 }}>{METRICS.map(([k, lbl]) => (
    <button key={k} onClick={() => setMetric(k)} style={{ flexShrink: 0, fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "7px 14px", borderRadius: 9999, cursor: "pointer", border: "none", background: mSel === k ? C.plum : C.container, color: mSel === k ? "#fff" : C.inkVar }}>{lbl}</button>))}</div>);
  const trendsCard = (<Card>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
      <div><div style={{ fontFamily: head, fontWeight: 600, fontSize: 17 }}>Track one thing over time</div><div style={{ fontSize: 13, color: C.inkVar }}>{mLbl} · past 30 days · avg {sAvg.toFixed(1)}</div></div>
      <div style={{ textAlign: "right", color: C.plum, fontFamily: bodyf, fontWeight: 600, fontSize: 14 }}>{series[series.length - 1] <= series[0] ? "↘ lower" : "↗ higher"}</div></div>
    {chipsRow}
    <Sparkline series={series} />
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.outline, marginTop: 6 }}><span>30d ago</span><span>Today</span></div>
    <div style={{ marginTop: 16 }}><div style={{ fontFamily: bodyf, fontSize: 12, fontWeight: 600, color: C.inkVar, marginBottom: 6 }}>Daily intensity · last 12 weeks</div><Heatmap days={heatDays} valueOf={heatVal} max={heatMax} /></div></Card>);
  const highlights = (<Card style={{ background: C.low, boxShadow: "none" }}>
    <Label color={C.inkVar}>Historical highlights</Label>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
      <div style={{ background: C.surface, borderRadius: 14, padding: 16 }}><Microscope size={18} color={C.plum} /><div style={{ fontFamily: head, fontWeight: 700, fontSize: 24, marginTop: 8 }}>{ins.daysSinceSeverePain} days</div><div style={{ fontSize: 12, color: C.inkVar }}>since last high-pain episode</div></div>
      <div style={{ background: C.surface, borderRadius: 14, padding: 16 }}><Heart size={18} color={C.roseOn} /><div style={{ fontFamily: head, fontWeight: 700, fontSize: 24, marginTop: 8 }}>{ins.loggedDays} days</div><div style={{ fontSize: 12, color: C.inkVar }}>consistent logging</div></div>
    </div></Card>);
  const disclaimer = (<div style={{ padding: 14, background: C.surface, borderRadius: 14, fontSize: 12, color: C.inkVar, lineHeight: 1.5, display: "flex", gap: 8 }}>
    <Info size={15} color={C.plum} style={{ flexShrink: 0, marginTop: 2 }} />These are associations from your own logs, not certainties — and a roadmap feature uses federated learning to sharpen them across the community while your raw data stays on your device.</div>);
  const SUBVIEWS = [["insights", "Insights"], ["track", "What to track"]];
  const subNav = (<div style={{ display: "inline-flex", gap: 4, padding: 4, background: C.container, borderRadius: 9999, marginBottom: 18 }}>
    {SUBVIEWS.map(([id, lbl]) => { const on = view === id; return (
      <button key={id} onClick={() => setView(id)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 14, padding: "8px 18px", borderRadius: 9999, cursor: "pointer", border: "none", background: on ? C.surface : "transparent", color: on ? C.plum : C.inkVar, boxShadow: on ? SH_SM : "none" }}>{lbl}</button>); })}
  </div>);


  // Everything you read comes first — the overview, then your five sections
  // with the cycle detail under the cycle one, then the highlights. The charts
  // are a block at the end: you go looking for them, they don't lead.
  const readCards = [];
  (stats?.byCategory || []).forEach((g, i) => {
    readCards.push(sectionCards[i]);
    if (g.key === "cycle" && cycleCard) readCards.push(cycleCard);
  });
  const chartCards = [explorerCard, trendsCard];
  const stack = (cards, gap) => cards.filter(Boolean).map((card, i) => (
    <div key={i} style={{ marginBottom: gap }}>{card}</div>));
  const grid = (cards, cols) => (
    <div style={{ display: "grid", gridTemplateColumns: cols, gap: 18, alignItems: "start" }}>
      {cards.filter(Boolean).map((card, i) => <div key={i}>{card}</div>)}</div>);
  // Sections differ a lot in height — a two-column grid would leave a ragged
  // hole under the short ones, so they flow into columns and pack instead.
  const packed = (cards) => (
    <div style={{ columnCount: 2, columnGap: 18 }}>
      {cards.filter(Boolean).map((card, i) => (
        <div key={i} style={{ breakInside: "avoid", marginBottom: 18 }}>{card}</div>))}</div>);
  const chartHeading = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "26px 0 12px" }}>
      <BarChart3 size={17} color={C.plum} /><Label>Charts</Label></div>);

  if (wide) return (<div>
    <H size={28} style={{ marginBottom: 16 }}>Insights</H>{subNav}
    {view === "track" ? (
      <div style={{ maxWidth: 760 }}>{suggestionsCard}<div style={{ marginTop: 20 }}>{disclaimer}</div></div>
    ) : (<>
      {stack([summaryCard, statsLoading && loadingCard, highlights], 18)}
      {packed(readCards)}
      {chartHeading}
      {stack([explorerCard], 18)}
      {grid([trendsCard], "1fr")}
      <div style={{ marginTop: 20 }}>{disclaimer}</div>
    </>)}
  </div>);

  return (<div>
    <H size={28} style={{ margin: "8px 0 14px" }}>Insights</H>{subNav}
    {view === "track" ? (<>
      {suggestionsCard}
      <div style={{ marginTop: 16 }}>{disclaimer}</div>
    </>) : (<>
      {stack([summaryCard, statsLoading && loadingCard, highlights, ...readCards], 18)}
      {chartHeading}
      {stack(chartCards, 18)}
      <div style={{ marginTop: 16 }}>{disclaimer}</div>
    </>)}
  </div>);
}
function Sparkline({ series }) {
  const w = 300, h = 90, max = Math.max(...series, 1), min = Math.min(...series, 0);
  const pts = series.map((v, i) => [(i / (series.length - 1)) * w, h - ((v - min) / Math.max(1, max - min)) * (h - 12) - 6]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${d} L${w},${h} L0,${h} Z`;
  return (<svg viewBox={`0 0 ${w} ${h}`} width="100%" preserveAspectRatio="none"
    style={{ display: "block", maxWidth: 420, margin: "0 auto" }}>
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.plumC} stopOpacity="0.25" /><stop offset="100%" stopColor={C.plumC} stopOpacity="0" /></linearGradient></defs>
    <path d={area} fill="url(#g)" /><path d={d} fill="none" stroke={C.plum} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
    <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="4" fill="#fff" stroke={C.plum} strokeWidth="2.5" />
  </svg>);
}
// 7×N calendar heatmap of a daily metric (columns = weeks)
function Heatmap({ days, valueOf, max, color = C.plum }) {
  const cell = 13, gap = 3, rows = 7;
  const cols = Math.ceil(days.length / rows) || 1;
  const w = cols * (cell + gap), h = rows * (cell + gap);
  return (<svg viewBox={`0 0 ${w} ${h}`} width="100%" preserveAspectRatio="xMinYMin meet" style={{ display: "block", maxWidth: w, margin: "0 auto" }}>
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
  return (<svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block", maxWidth: 400, margin: "0 auto" }}>
    <rect x={padL} y={Y(hi)} width={w - padL} height={Y(lo) - Y(hi)} fill={C.lilac} fillOpacity={0.5} />
    {[lo, hi].map((v) => (<g key={v}><line x1={padL} y1={Y(v)} x2={w} y2={Y(v)} stroke={C.lilacDim} strokeDasharray="3 3" /><text x={0} y={Y(v) + 3} style={{ fontSize: 8, fill: C.outline }}>{v}</text></g>))}
    {gaps.length > 1 && <path d={line} fill="none" stroke={C.outlineVar} strokeWidth={1.5} />}
    {pts.map((p, i) => { const ok = gaps[i] >= lo && gaps[i] <= hi; return (<g key={i}>
      <circle cx={p[0]} cy={p[1]} r={4.5} fill={ok ? C.plum : C.roseOn} />
      <text x={p[0]} y={p[1] - 8} textAnchor="middle" style={{ fontSize: 9, fontWeight: 700, fill: ok ? C.plum : C.roseOn }}>{gaps[i]}</text></g>); })}
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
  return (<svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block", maxWidth: 400, margin: "0 auto" }}>
    <line x1={pad} y1={h - pad} x2={w - 4} y2={h - pad} stroke={C.outlineVar} />
    <line x1={pad} y1={8} x2={pad} y2={h - pad} stroke={C.outlineVar} />
    {points.map((p, i) => { const jx = ((i % 5) - 2) * 0.07, jy = (((i * 3) % 5) - 2) * 0.07;
      return <circle key={i} cx={px(p.x + jx)} cy={py(p.y + jy)} r={3} fill={C.plum} fillOpacity={0.4} />; })}
    <line x1={px(0)} y1={py(Math.max(0, Math.min(yMax, intc)))} x2={px(xMax)} y2={py(Math.max(0, Math.min(yMax, intc + slope * xMax)))} stroke={C.roseOn} strokeWidth={2.5} />
    <text x={(w + pad) / 2} y={h - 6} textAnchor="middle" style={{ fontSize: 9, fill: C.inkVar }}>{xLabel}</text>
    <text x={11} y={(h - pad) / 2 + 4} textAnchor="middle" transform={`rotate(-90 11 ${(h - pad) / 2 + 4})`} style={{ fontSize: 9, fill: C.inkVar }}>{yLabel}</text>
  </svg>);
}
function CorrCard({ icon: Ico, bg, on, habit, symptom, pct, note }) {
  return (<Card style={{ display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
    <span style={{ width: 46, height: 46, borderRadius: 14, background: bg, display: "grid", placeItems: "center", flexShrink: 0 }}><Ico size={20} color={on} /></span>
    <div style={{ flex: 1 }}><div style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 15 }}>{habit}</div><div style={{ fontSize: 13, color: C.inkVar }}>{symptom}</div></div>
    <div style={{ textAlign: "right" }}><div style={{ fontFamily: head, fontWeight: 700, fontSize: 22, color: C.plum }}>{pct}%</div><div style={{ fontSize: 11, color: C.outline }}>{note}</div></div>
  </Card>);
}

// ---- CHAT: an advisory conversation. The backend grounds Tawazzun's guidance in
// the patient's own tracked insights (trends + correlations from their logs)
// plus their personal vocabulary and adaptation state, so the chat can advise
// rather than just gather information.
function ChatScreen({ profile, settings }) {
  const base = (settings.backendUrl || "/api").replace(/\/$/, "");
  const pid = settings.patientId;
  const opening = `Hi${profile.name ? " " + profile.name : ""} — I'm here to talk things through. I can see your tracked patterns, so tell me what's on your mind and I'll give you grounded, practical guidance.`;
  const starters = ["How are my cycles looking?", "What should I focus on this week?", "Why might my pain be flaring?"];

  const [turns, setTurns] = useState([{ role: "assistant", text: opening }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [learned, setLearned] = useState([]);
  const scroller = useRef();
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [turns, busy]);

  const send = async (t) => {
    const q = (t || text).trim(); if (!q || busy) return;
    if (!pid) { setError("No patient is set up yet — open the app from Home so توازن can connect to the backend."); return; }
    setError(""); const prior = turns.slice(-20); const next = [...turns, { role: "user", text: q }];
    setTurns(next); setText(""); setBusy(true);
    try {
      const res = await fetch(`${base}/chatbox/patients/${pid}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: q, turns: prior }) });
      let data = {}; try { data = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error(data.detail || `Chat request failed (${res.status}).`);
      setTurns([...next, { role: "assistant", text: data.reply || "" }]);
      if (data.learned?.length) setLearned((p) => [...data.learned, ...p].slice(0, 6));
    } catch (e) {
      setError(e?.message || "Couldn't reach توازن.");
      setTurns([...next, { role: "assistant", text: e?.message || "Something went wrong.", err: true }]);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 520 }}>
      <H size={26} style={{ margin: "6px 0 14px" }}>Talk to <Brand /></H>
      <div ref={scroller} style={{ flex: 1, overflowY: "auto", display: "grid", gap: 12, paddingBottom: 10, maxHeight: 460 }}>
        {turns.map((m, i) => (<div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
          {m.role === "assistant" && <BrandMark size={36} />}
          <div style={{ maxWidth: "80%", padding: "13px 16px", borderRadius: 20, fontSize: 15, lineHeight: 1.45, boxShadow: m.role === "user" ? "none" : SH_SM,
            background: m.role === "user" ? C.plum : m.err ? C.rose : C.surface, color: m.role === "user" ? "#fff" : m.err ? C.error : C.ink, borderTopRightRadius: m.role === "user" ? 4 : 20, borderTopLeftRadius: m.role === "user" ? 20 : 4 }}>{m.text}</div></div>))}
        {busy && <div style={{ display: "flex", gap: 8, alignItems: "center", color: C.inkVar, fontSize: 13 }}><BrandMark size={36} /><Loader2 size={14} className="spin" /> thinking…</div>}
      </div>
      {turns.length <= 1 && (<div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "4px 0 12px" }}>{starters.map((c) => (<button key={c} onClick={() => send(c)} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: 9999, background: C.surface, border: `1.5px solid ${C.outlineVar}`, color: C.ink, cursor: "pointer" }}>{c}</button>))}</div>)}
      {learned.length > 0 && (<div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "10px 0", fontSize: 12, color: C.inkVar }}><Sparkles size={13} color={C.roseOn} /> Learning your words:{learned.map((d, i) => (<span key={i} style={{ padding: "3px 9px", borderRadius: 12, background: C.rose, color: C.roseOn }}>{d.concept}: "{d.phrase}"</span>))}</div>)}
      <div style={{ display: "flex", gap: 10, alignItems: "center", background: C.surface, borderRadius: 9999, padding: 6, boxShadow: SH, marginTop: 10 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="Ask توازن anything…" disabled={busy} style={{ flex: 1, border: "none", outline: "none", fontFamily: bodyf, fontSize: 16, padding: "8px 14px", background: "transparent" }} />
        <button onClick={() => send()} disabled={busy || !text.trim()} style={{ width: 44, height: 44, borderRadius: "50%", border: "none", background: C.plum, color: "#fff", display: "grid", placeItems: "center", cursor: busy || !text.trim() ? "not-allowed" : "pointer", opacity: busy || !text.trim() ? 0.5 : 1 }}><ArrowRight size={20} /></button>
      </div>
      {error && <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, padding: "10px 14px", borderRadius: 12, background: C.rose, color: C.error, fontSize: 13, fontWeight: 600 }}><AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} /> {error}</div>}
    </div>
  );
}

// ---- PREPARE ---------------------------------------------------------------
// ---- ADVOCACY (Prepare + Clinician merged) ---------------------------------
function AdvocacyScreen({ profile, ins, assessment, axes, derived, lab, setLab, rules, labRules, setLabRules, settings, setTab }) {
  const [rep, setRep] = useState(null); const [loadingR, setLoadingR] = useState(false);
  useEffect(() => { (async () => {
    const pid = settings.patientId; if (!pid) return; setLoadingR(true);
    try { const b = (settings.backendUrl || "/api").replace(/\/$/, ""); const r = await fetch(`${b}/patients/${pid}/advocacy`, { method: "POST" }); if (r.ok) { const j = await r.json(); setRep(j.report); } } catch (e) { }
    setLoadingR(false);
  })(); }, [settings.patientId]);

  const [labOpen, setLabOpen] = useState(false);
  const standCard = (<>
    {/* opened from the cog below — it leads, so the effect of an edit is
        visible in the criteria and the indicator right under it */}
    {labOpen && rules && <CriteriaLab derived={derived} lab={lab} setLab={setLab} rules={rules}
      labRules={labRules} setLabRules={setLabRules} open={labOpen} setOpen={setLabOpen} />}
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Label>The three criteria</Label>
        <button onClick={() => setLabOpen((o) => !o)} title="Experiment with the factors"
          style={{ marginLeft: "auto", background: labOpen ? C.lilac : "none", border: "none", borderRadius: 9,
            width: 30, height: 30, display: "grid", placeItems: "center", cursor: "pointer", color: C.plum }}>
          <Cog size={17} /></button>
      </div>
      <div style={{ display: "flex", justifyContent: "center", margin: "4px 0 0" }}><Triad axes={axes} /></div>
    </Card>
    {assessment
      ? <DoctorIndicator assessment={assessment} />
      : <Card style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "center", color: C.inkVar, fontSize: 14 }}>
          <Loader2 size={15} className="spin" color={C.outline} /> Checking your tracked data against the criteria…</Card>}
  </>);

  // FOR ME — the advocacy report (data-driven talking points)
  const meView = (<>
    {standCard}
    {(loadingR && !rep) && <Card style={{ display: "flex", alignItems: "center", gap: 10, color: C.inkVar, fontSize: 14, marginBottom: 14 }}><Loader2 size={16} className="spin" color={C.plum} /> Preparing your talking points from your data…</Card>}
    {(rep?.trends_summary || rep?.flagged_patterns?.length > 0) && (
      <Collapsible title="What your tracking shows">
        {rep?.trends_summary && (<div style={{ marginBottom: rep?.flagged_patterns?.length ? 16 : 0 }}>
          <Label color={C.inkVar}>Your trends</Label>
          <p style={{ fontSize: 14.5, lineHeight: 1.55, margin: "8px 0 0" }}>{rep.trends_summary}</p></div>)}
        {rep?.flagged_patterns?.length > 0 && (<div>
          <Label color={C.inkVar}>Patterns worth flagging</Label>
          <ul style={{ margin: "10px 0 0", paddingLeft: 18, display: "grid", gap: 7 }}>
            {rep.flagged_patterns.map((f, i) => <li key={i} style={{ fontSize: 14.5 }}>{f}</li>)}</ul></div>)}
      </Collapsible>)}
    {(rep?.talking_points || []).length > 0 && (
      <Collapsible title="To raise with the doctor" count={rep.talking_points.length}>
        {rep.talking_points.map((t, i) => (<div key={i} style={{ paddingTop: i ? 14 : 0, marginTop: i ? 14 : 0,
          borderTop: i ? `1px solid ${C.high}` : "none" }}>
      <div style={{ fontFamily: head, fontWeight: 600, fontSize: 15.5, lineHeight: 1.45 }}>{t.clinical_framing}</div>
      {t.keywords_phrases?.length > 0 && (<div style={{ marginTop: 12 }}><Label color={C.plum}>Say it like this</Label><ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>{t.keywords_phrases.map((k, j) => <li key={j} style={{ fontSize: 14, lineHeight: 1.45 }}>{k}</li>)}</ul></div>)}
      {t.questions_to_ask?.length > 0 && (<div style={{ marginTop: 12 }}><Label color={C.roseOn}>Ask</Label><ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 6 }}>{t.questions_to_ask.map((q, j) => <li key={j} style={{ fontSize: 14, lineHeight: 1.45 }}>{q}</li>)}</ul></div>)}
        </div>))}
      </Collapsible>)}
    {rep?.documentation_request_text && <Card style={{ marginBottom: 14, background: C.lilac, boxShadow: "none" }}><Label color={C.plumDark}>Before you leave</Label><p style={{ fontSize: 14, lineHeight: 1.6, margin: "8px 0 0", color: C.onLilac }}>{rep.documentation_request_text}</p></Card>}
    {rep && <div className="no-print"><Pill onClick={() => window.print()} style={{ width: "100%" }}><Printer size={16} /> Print to bring along</Pill></div>}
  </>);

  return (<div>
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 16px" }}>
      <button className="no-print" onClick={() => setTab("home")} style={{ background: "none", border: "none", cursor: "pointer", color: C.inkVar }}><ArrowLeft size={22} /></button><H size={24}>Advocacy</H></div>
    {meView}
  </div>);
}
function Mini({ label, value, flag, amber }) {
  const c = amber ? "#8f631e" : flag ? C.roseOn : C.plum;
  return (<Card style={{ padding: 16 }}><div style={{ fontFamily: bodyf, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", color: C.inkVar, textTransform: "uppercase" }}>{label}</div><div style={{ fontFamily: head, fontWeight: 700, fontSize: 26, color: c }}>{value}</div></Card>);
}

// ---- conditions, the mFG sheet, and drug therapy ---------------------------
// Keys are the backend's: criteria.py reads "hirsutism" as clinical
// hyperandrogenism already established, and treats the thyroid ones as
// alternative explanations worth naming.
const CONDITIONS = [
  ["infertility", "Infertility", "Trying to conceive without success"],
  ["hirsutism", "Hirsutism", "Diagnosed excess hair growth"],
  ["diabetes1", "Diabetes type 1", "Autoimmune — the body makes little or no insulin"],
  ["diabetes2", "Diabetes type 2", "The body resists its own insulin"],
  ["hypothyroidism", "Hypothyroidism", "Underactive thyroid"],
  ["hyperthyroidism", "Hyperthyroidism", "Overactive thyroid"],
];

// The nine areas of the modified Ferriman-Gallwey sheet, each scored 0-4, with
// where each one sits on the drawing and how big its marker is — the two on the
// face share a head 11 units across, so they take a smaller dot to fit.
// Same keys as criteria.MFG_AREAS.
const FG_AREAS = [
  ["upperLip", "Upper lip", "front", 50, 14, 3.5],
  ["chin", "Chin", "front", 50, 21.5, 3.5],
  ["chest", "Chest", "front", 50, 58, 5.5],
  ["upperAbdomen", "Upper abdomen", "front", 50, 84, 5.5],
  ["lowerAbdomen", "Lower abdomen", "front", 50, 104, 5.5],
  ["upperArms", "Upper arms", "front", 33, 66, 4.2],
  ["thighs", "Thighs", "front", 42, 133, 4.5],
  ["upperBack", "Upper back", "back", 50, 60, 5.5],
  ["lowerBack", "Lower back", "back", 50, 95, 5.5],
];
const FG_MAX = 4;
const FG_WORDS = ["none", "a few hairs", "scattered", "spread", "thick"];
const fgTotal = (mfg) => FG_AREAS.reduce((t, [k]) => t + (Number(mfg?.[k]) || 0), 0);
const fgScored = (mfg) => FG_AREAS.filter(([k]) => mfg?.[k] != null).length;

function FerrimanGallwey({ value, onChange, threshold = 4 }) {
  const mfg = value || {};
  const [focus, setFocus] = useState(null);
  const set = (k, v) => onChange({ ...mfg, [k]: mfg[k] === v ? undefined : v });
  const total = fgTotal(mfg), scored = fgScored(mfg);
  const shade = (v) => (v ? `rgba(158,79,94,${0.25 + 0.18 * v})` : "rgba(255,255,255,0.85)");
  const figure = (view) => (
    <svg key={view} viewBox="0 0 100 205" style={{ width: "48%", maxWidth: 130, display: "block" }}>
      <g fill={C.rose} stroke={C.lilacDim} strokeWidth={1.3} strokeLinejoin="round">
        <circle cx="50" cy="15" r="11" /><path d={BODY_OUTLINE} />
      </g>
      {FG_AREAS.filter(([, , w]) => w === view).map(([k, label, , x, y, r]) => {
        const v = Number(mfg[k]) || 0, on = focus === k;
        return (<g key={k} onClick={() => setFocus(k)} style={{ cursor: "pointer" }}>
          <title>{label}</title>
          <circle cx={x} cy={y} r={on ? r + 1 : r} fill={shade(v)} stroke={on ? C.plum : C.roseOn}
            strokeWidth={on ? 2 : 1.2} />
          <text x={x} y={y + r * 0.48} textAnchor="middle" fontSize={r * 1.28} fontWeight={700}
            fill={v ? "#fff" : C.outline} style={{ pointerEvents: "none", fontFamily: bodyf }}>{v}</text>
        </g>);
      })}
      <text x="50" y="203" textAnchor="middle" fontSize={7} fill={C.outline} style={{ fontFamily: bodyf }}>{view}</text>
    </svg>);
  return (<div>
    <div style={{ display: "flex", justifyContent: "center", gap: 10 }}>{figure("front")}{figure("back")}</div>
    <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
      {FG_AREAS.map(([k, label]) => {
        const v = mfg[k], on = focus === k;
        return (<div key={k} onMouseEnter={() => setFocus(k)} style={{ display: "flex", alignItems: "center", gap: 8,
          padding: "5px 8px", borderRadius: 10, background: on ? C.lilac : "transparent" }}>
          <span style={{ flex: 1, fontFamily: bodyf, fontSize: 13, color: on ? C.onLilac : C.inkVar }}>{label}</span>
          {Array.from({ length: FG_MAX + 1 }, (_, n) => (
            <button key={n} onClick={() => { setFocus(k); set(k, n); }} title={FG_WORDS[n]}
              style={{ width: 26, height: 26, borderRadius: 8, cursor: "pointer", fontFamily: bodyf, fontSize: 12.5,
                fontWeight: v === n ? 700 : 500, background: v === n ? C.plum : C.low,
                color: v === n ? "#fff" : C.inkVar, border: `1px solid ${v === n ? C.plum : C.outlineVar}` }}>{n}</button>))}
        </div>);
      })}
    </div>
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 12, padding: "10px 12px",
      borderRadius: 12, background: C.low }}>
      <span style={{ fontFamily: head, fontWeight: 700, fontSize: 20, color: C.plum }}>{total}</span>
      <span style={{ fontFamily: bodyf, fontSize: 12.5, color: C.inkVar }}>
        out of 36 · {scored}/9 areas scored{scored < 9 ? " (unscored areas count as 0)" : ""}</span>
      <span style={{ marginLeft: "auto", fontFamily: bodyf, fontSize: 12, color: total >= threshold ? C.roseOn : C.outline }}>
        {total >= threshold ? `at or above ${threshold}` : `below ${threshold}`}</span>
    </div>
    <p style={{ fontFamily: bodyf, fontSize: 12, color: C.outline, lineHeight: 1.5, marginTop: 8 }}>
      Score each area for how much coarse, dark hair grows there: 0 none, 4 thick. Scored by you, so it is a
      screening signal a clinician would repeat, not a measurement.</p>
  </div>);
}

// A formal diagnosis is not one of the conditions above: it is the answer to
// the question this whole app is otherwise trying to help someone ask. When it
// is set, the indicator stops screening and starts helping them prepare.
function DiagnosisPanel({ profile, setProfile }) {
  const said = profile.pmosDiagnosed;
  const set = (v) => setProfile({ ...profile, pmosDiagnosed: v, ...(v ? {} : { pmosDiagnosedYear: "" }) });
  return (<div>
    <div style={{ display: "flex", gap: 8 }}>
      {[["Yes", true], ["No", false], ["Not sure", null]].map(([lbl, val]) => (
        <button key={lbl} onClick={() => set(val)} style={{ flex: 1, padding: "11px 0", borderRadius: 12,
          cursor: "pointer", fontFamily: bodyf, fontWeight: 600, fontSize: 14,
          background: said === val ? C.plum : C.low, color: said === val ? "#fff" : C.inkVar,
          border: `1.5px solid ${said === val ? C.plum : "transparent"}` }}>{lbl}</button>))}
    </div>
    {said === true && (<div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
      <span style={{ fontFamily: bodyf, fontSize: 13.5, color: C.inkVar }}>What year?</span>
      <input type="number" placeholder="e.g. 2021" value={profile.pmosDiagnosedYear || ""}
        onChange={(e) => setProfile({ ...profile, pmosDiagnosedYear: e.target.value })}
        style={{ ...input, width: 120, padding: "9px 11px", fontSize: 14 }} />
    </div>)}
    {said === true && <p style={{ fontFamily: bodyf, fontSize: 12, color: C.outline, lineHeight: 1.5, marginTop: 10 }}>
      Then the app stops asking whether to get checked. Your tracking becomes what a review appointment
      runs on instead.</p>}
  </div>);
}

function ConditionsPanel({ profile, setProfile, compact }) {
  const have = profile.conditions || [];
  const toggle = (k) => setProfile({ ...profile, conditions: have.includes(k) ? have.filter((x) => x !== k) : [...have, k] });
  return (<div style={{ display: "grid", gap: 8 }}>
    {CONDITIONS.map(([k, label, note]) => { const on = have.includes(k); return (
      <React.Fragment key={k}>
        <button onClick={() => toggle(k)} style={{ textAlign: "left", padding: compact ? "11px 14px" : 14,
          borderRadius: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
          background: on ? C.lilac : C.low, border: `1.5px solid ${on ? C.plum : "transparent"}` }}>
          <span style={{ flex: 1 }}>
            <div style={{ fontFamily: head, fontWeight: 600, fontSize: 15, color: on ? C.onLilac : C.ink }}>{label}</div>
            {note && <div style={{ fontFamily: bodyf, fontSize: 12, color: on ? C.plumDark : C.inkVar }}>{note}</div>}
          </span>
          {on && <Check size={17} color={C.plum} />}
        </button>
        {/* the sheet scores the condition above it, so it belongs under that row */}
        {k === "hirsutism" && on && (
          <div style={{ padding: 14, borderRadius: 16, border: `1.5px solid ${C.outlineVar}` }}>
            <Label>Ferriman-Gallwey score</Label>
            <FerrimanGallwey value={profile.mfg} onChange={(mfg) => setProfile({ ...profile, mfg })} />
          </div>)}
      </React.Fragment>); })}
  </div>);
}

// Ongoing treatment. Kept on the profile, not the daily log: it is a course
// someone is on, and the pill also tells the cycle criterion what it is reading.
const DRUGS = [
  ["glp1", "GLP-1", "e.g. semaglutide, liraglutide"],
  ["letrozole", "Letrozole", "ovulation induction"],
  ["ocp", "Oral contraceptive pill", ""],
];

function DrugTherapy({ profile, setProfile }) {
  const on = profile.drugs || [];
  const toggle = (k) => setProfile({ ...profile, drugs: on.includes(k) ? on.filter((x) => x !== k) : [...on, k] });
  return (<Card style={{ padding: 20, boxShadow: SH_SM }}>
    <Label>Drug therapy</Label>
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "4px 0 12px" }}>
      <H size={20}>What you're taking</H>
      <span style={{ fontFamily: bodyf, fontSize: 12.5, color: C.inkVar, marginLeft: "auto" }}>
        {on.length ? `${on.length} active` : "none logged"}</span>
    </div>
    <div style={{ display: "grid", gap: 8 }}>
      {DRUGS.map(([k, label, note]) => { const active = on.includes(k); return (
        <button key={k} onClick={() => toggle(k)} style={{ textAlign: "left", padding: "12px 14px", borderRadius: 14,
          cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
          background: active ? C.lilac : C.low, border: `1.5px solid ${active ? C.plum : "transparent"}` }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, background: active ? C.plum : C.surface,
            display: "grid", placeItems: "center", flexShrink: 0 }}>
            <Pill2 size={15} color={active ? "#fff" : C.outline} /></span>
          <span style={{ flex: 1 }}>
            <div style={{ fontFamily: head, fontWeight: 600, fontSize: 15, color: active ? C.onLilac : C.ink }}>{label}</div>
            {note && <div style={{ fontFamily: bodyf, fontSize: 12, color: active ? C.plumDark : C.inkVar }}>{note}</div>}
          </span>
          {active && <Check size={17} color={C.plum} />}
        </button>); })}
    </div>
  </Card>);
}

// ---- SETTINGS --------------------------------------------------------------
function SettingsScreen({ settings, setSettings, setLogs, profile, setProfile, setTab }) {
  const set = (k, v) => setSettings({ ...settings, [k]: v });
  const have = profile.conditions || [];
  return (<div>
    <H size={28} style={{ margin: "8px 0 16px" }}>Settings</H>
    <Card style={{ marginBottom: 14 }}>
      <Label color={C.inkVar}>PMOS diagnosis</Label>
      <p style={{ fontSize: 12.5, color: C.inkVar, margin: "8px 0 12px", lineHeight: 1.5 }}>
        Has a clinician formally diagnosed you with PMOS?</p>
      <DiagnosisPanel profile={profile} setProfile={setProfile} />
    </Card>
    <Card style={{ marginBottom: 14 }}>
      <Label color={C.inkVar}>Conditions — what a clinician has already diagnosed</Label>
      <p style={{ fontSize: 12, color: C.inkVar, margin: "8px 0 12px", lineHeight: 1.5 }}>
        These change how your tracking is read: a hirsutism diagnosis already settles one of the criteria, and
        thyroid conditions can explain irregular cycles on their own.</p>
      <ConditionsPanel profile={profile} setProfile={setProfile} compact />
      {have.length === 0 && <p style={{ fontSize: 11.5, color: C.outline, marginTop: 10 }}>Nothing selected — leave it empty if none apply.</p>}
    </Card>
    <Card style={{ marginBottom: 14 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}><input type="checkbox" checked={settings.voice} onChange={(e) => set("voice", e.target.checked)} style={{ accentColor: C.plum, width: 18, height: 18 }} /><span style={{ fontSize: 15 }}>Speak replies aloud</span></label>
    </Card>
    <Card style={{ marginBottom: 14 }}>
      <Label color={C.inkVar}>Block topics — <Brand /> won't ask about or use these</Label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>{Object.entries(FEATURES).map(([k, f]) => { const on = (settings.blacklist || []).includes(k); return (
        <button key={k} onClick={() => set("blacklist", on ? settings.blacklist.filter((x) => x !== k) : [...(settings.blacklist || []), k])} style={{ fontFamily: bodyf, fontWeight: 600, fontSize: 13, padding: "9px 14px", borderRadius: 9999, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7, background: on ? C.rose : C.surface, color: on ? C.roseOn : C.inkVar, border: `1.5px solid ${on ? C.rose : C.outlineVar}` }}>{on ? <Lock size={13} /> : <Check size={13} color={C.outlineVar} />} {f.label}</button>); })}</div>
      <p style={{ fontSize: 11, color: C.inkVar, marginTop: 10 }}>Blocked topics vanish from your daily tracker and are never raised in conversation — enforced in-app and on the server.</p>
    </Card>
    <Card onClick={() => setTab("advocacy")} style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 14, cursor: "pointer" }}>
      <span style={{ width: 42, height: 42, borderRadius: 12, background: C.lilac, display: "grid", placeItems: "center" }}><Stethoscope size={20} color={C.plumDark} /></span>
      <div style={{ flex: 1 }}><div style={{ fontFamily: head, fontWeight: 600, fontSize: 16 }}>Advocacy &amp; appointment prep</div><div style={{ fontSize: 13, color: C.inkVar }}>Your talking points and the clinician view</div></div><ChevronRight size={20} color={C.outline} /></Card>
    <p style={{ fontFamily: bodyf, fontSize: 11, color: C.outline, textAlign: "center", marginTop: 18 }}><Brand /> · DECISION SUPPORT, NOT A DIAGNOSIS · PROTOTYPE</p>
  </div>);
}
