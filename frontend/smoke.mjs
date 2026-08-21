/**
 * Does the built app actually run?
 *
 * Serving index.html with a 200 proves nothing, and neither does mounting an
 * empty shell: a component that only renders once data arrives can throw a
 * ReferenceError that no cold check ever reaches. So this runs two passes.
 *
 *   1. cold      — no backend, nothing stored. The welcome flow must render.
 *   2. populated — an onboarded profile and a stubbed backend serving logs, a
 *                  summary and an assessment. Home, the cycle ring, the bar and
 *                  the calendar all have to render without a console error.
 *   3. reel      — nobody at the keyboard. The sign-up drives itself with its
 *                  own pointer, and a minute later Waniyah has to be through
 *                  it and into the app, with the tour already talking: real
 *                  clicks and real input events, on the real controls, in a
 *                  real DOM. Slow on purpose — it runs at the speed a recording
 *                  of it does.
 *   4. guide     — the tour on its own, for someone already signed up: it has
 *                  to be lighting parts of the interface up and talking about
 *                  them, without editing the profile it was given.
 *   5. record    — a sentence said to the Record screen, through the same hooks
 *                  the tour speaks through. What it heard has to appear on the
 *                  "Your day so far" card, marked as heard. That card rendered
 *                  categories the model stopped inventing, so it sat empty for
 *                  good; this is what would catch it happening again.
 *
 *   docker compose build frontend && docker compose up -d frontend
 *   rm -rf /tmp/dist && mkdir -p /tmp/dist
 *   docker cp myno-frontend-1:/usr/share/nginx/html/assets /tmp/dist/assets
 *   cp smoke.mjs /tmp/ && docker run --rm -v /tmp:/t -w /t node:20-alpine \
 *     sh -c "npm i --silent jsdom && node /t/smoke.mjs /t/dist/assets/main-*.js"
 *
 * The whole assets directory, not one file: since the build gained a second
 * entry for the researcher portal, React lives in a chunk both of them import.
 *
 * Run it from the directory holding node_modules — node resolves imports from
 * the script's own location, not the working directory.
 *
 * Exit 0 = every pass rendered, 2 = threw on import, 3 = rendered nothing,
 * 4 = rendered but logged a runtime error, 5 = rendered but a pass's own check
 * failed (the sign-up never signed itself up).
 */
import { JSDOM } from "jsdom";

const bundle = process.argv[2] || "/t/app-bundle.mjs";
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const LOGS = Array.from({ length: 120 }, (_, i) => ({
  date: day(119 - i),
  period: [0, 1, 2, 3, 31, 32, 33, 34, 67, 68, 69, 70, 105, 106, 107, 108].includes(i),
  pain: i % 7, mood: 5, energy: 4, sleep: 5, brainFog: 2, sugar: 3, categories: [],
}));
const SUMMARY = {
  loggedDays: 120, avgCycleDays: 34.5, cycleDay: 12, cycleCount: 3,
  correlations: [], trends: [], byCategory: [], categoryTrends: [], recent: {},
  cycle: { meanDays: 34.5, sdDays: 4.2, cv: 12, min: 31, max: 38, cycles: 4, label: "Irregular", regular: false, why: [] },
};
const ASSESSMENT = {
  cycles: { state: "met", reasons: ["Longest cycle 38 days"], alerts: [], band: { shortDays: 21, longDays: 35, label: "3+ years" } },
  androgen: { state: "clear", reasons: [], alerts: [] }, context: [], diagnosed: false,
  recommendation: { key: "book", headline: "Worth booking an appointment", tone: "elevated", why: [], met: 1 },
  axes: { cycles: { met: true }, androgen: { met: false }, morphology: { met: null } }, inputs: {},
};

// what the model hears in "Bad cramps today, and I barely slept"
const EXTRACT = { pain: 7, sleep: 2, mood: null, energy: null, period: null,
                  painPoints: [{ view: "front", x: 0.5, y: 0.55, label: "pelvis" }],
                  say: "Rough night. Are you on your period, or is this outside of it?" };

function backend(url) {
  const u = String(url), body =
    u.includes("/record/schema") ? { schema: [], categories: [] }
    : u.includes("/criteria/rules") ? { cycleBands: [{ fromYear: 0, toYear: null, label: "adult", shortDays: 21, longDays: 35 }], singleCycleDays: 90 }
    : u.endsWith("/logs") ? LOGS
    : u.includes("/summary") ? SUMMARY
    : u.includes("/assessment") || u.includes("/assess") ? ASSESSMENT
    : u.includes("/insights") ? { stats: SUMMARY, analysis: { summary: "", insights: [] }, categories: [] }
    : u.includes("/suggestions") ? { suggestions: [], refreshing: false }
    : u.includes("/extract") ? EXTRACT
    : u.includes("/advise") ? { headline: "", correlations: [], say: "" }
    : u.includes("/patients") ? { id: 58 }
    : {};
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

async function pass(name, { stored, fetch: fetchImpl, waitMs = 1500, after }) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://localhost/", pretendToBeVisual: true });
  for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "SVGElement",
                   "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
                   "MutationObserver"]) globalThis[k] = dom.window[k];
  if (stored) dom.window.localStorage.setItem("myno:serene:v1", JSON.stringify(stored));
  globalThis.fetch = fetchImpl;

  const errs = [];
  dom.window.addEventListener("error", (e) => errs.push(String(e.error?.stack || e.error || e.message)));
  const realError = console.error;
  console.error = (...a) => {
    const line = a.map(String).join(" ");
    // node's own module-resolution warnings arrive on this channel too; only
    // React's belong in the failure list
    if (!line.includes("[MODULE_TYPELESS_PACKAGE_JSON]")) errs.push(line.slice(0, 400));
  };

  try {
    // cache-bust so the second pass re-evaluates the module top to bottom
    await import(`${bundle}?pass=${encodeURIComponent(name)}`);
  } catch (e) {
    realError(`[${name}] IMPORT THREW: ${e.message}`);
    return 2;
  }
  await new Promise((r) => setTimeout(r, waitMs));
  console.error = realError;

  const html = dom.window.document.getElementById("root").innerHTML;
  console.log(`[${name}] DOM ${html.length} chars`);
  const verdict = async () => {
    if (errs.length) {
      console.log(`[${name}] RUNTIME ERROR:\n${errs.slice(0, 2).join("\n---\n")}`);
      return 4;
    }
    if (html.length < 500) return 3;
    const bad = await after?.(dom, html);
    if (bad) { console.log(`[${name}] ${bad}`); return 5; }
    return 0;
  };
  const code = await verdict();
  // A pass owns its window. Closing it ends the sign-up reel this pass started,
  // which would otherwise still be clicking — into the next pass's document.
  dom.window.close();
  return code;
}

let code = await pass("cold", { fetch: () => Promise.reject(new Error("offline")) });
if (code === 0) {
  code = await pass("populated", {
    stored: {
      profile: { onboarded: true, name: "Test", goals: ["manage"], conditions: [], mfg: {}, drugs: [] },
      // the guided demo has its own pass; this one is about rendering
      settings: { backendUrl: "", patientId: 58, voice: false, blacklist: [], personality: "direct",
                  guide: false },
      logs: [],
    },
    fetch: backend,
  });
}
if (code === 0) {
  // The sign-up filling itself in: no stored profile, no backend, no hands. It
  // is checked through what it left behind rather than what it looked like —
  // the saved profile is the thing the rest of the app runs on.
  code = await pass("reel", {
    fetch: () => Promise.reject(new Error("offline")),
    // The sign-up talks its way through three screens and is in no hurry — and
    // in here every clip fetch fails, so each line is held for the fallback
    // estimate, which is the longest it can ever be. Budget for that.
    waitMs: 115000,
    after: (dom, html) => {
      const raw = dom.window.localStorage.getItem("myno:serene:v1");
      if (!raw) return "nothing was saved: the reel never typed a thing";
      const p = JSON.parse(raw).profile || {};
      if (!p.onboarded) return `the reel stalled at: ${JSON.stringify(p)}`;
      if (p.name !== "Waniyah") return `signed up as ${JSON.stringify(p.name)}, not Waniyah`;
      for (const [k, want] of [["age", "28"], ["menarcheAge", "13"], ["heightCm", "166"], ["weightKg", "74"]])
        if (String(p[k]) !== want) return `${k} came out ${JSON.stringify(p[k])}, not ${want}`;
      if (!p.goals?.includes("whatswrong")) return `no goal was picked: ${JSON.stringify(p.goals)}`;
      if (!p.familyHistory || !p.acne) return "the symptom chips were missed";
      if (p.pmosDiagnosed !== null) return `the diagnosis answer came out ${JSON.stringify(p.pmosDiagnosed)}, not "Not sure"`;
      if ((p.integrations || []).length) return `a wearables screen crept back in: ${JSON.stringify(p.integrations)}`;
      if (html.includes("Let's get to know you")) return "it never left the sign-up";
      // ...and the tour picked up where the sign-up left off
      const settings = JSON.parse(raw).settings || {};
      if (!settings.guide) return "the guide switched itself off without showing anything";
      if (!html.includes("demo-caption")) return "nothing is being said: the tour never started";
      return null;
    },
  });
}
if (code === 0) {
  // The tutorial, on its own: simulation off, tour on, a profile already made.
  // It has to be lighting something up and talking about it, and it must not
  // have typed, tapped or changed a single thing on the way.
  code = await pass("guide", {
    stored: {
      profile: { onboarded: true, name: "Waniyah", age: 28, goals: ["whatswrong"], conditions: [], mfg: {}, drugs: [] },
      settings: { backendUrl: "", patientId: 58, voice: false, blacklist: [], personality: "direct", guide: true },
      logs: [],
    },
    fetch: backend,
    waitMs: 35000,
    after: (dom, html) => {
      if (!html.includes("demo-caption")) return "the tour never said anything";
      if (!html.includes("demo-spot")) return "the tour never lit anything up";
      if (!html.includes("demo-shield")) return "the tour left the screen open to a stray tap";
      const p = JSON.parse(dom.window.localStorage.getItem("myno:serene:v1")).profile || {};
      if (p.name !== "Waniyah") return `the tour rewrote the profile: ${JSON.stringify(p.name)}`;
      return null;
    },
  });
}
if (code === 0) {
  // A sentence said to the Record screen, through the hooks the guide speaks
  // through — the same path a real spoken one takes, without a microphone.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  code = await pass("record", {
    stored: {
      profile: { onboarded: true, name: "Waniyah", age: 28, goals: ["whatswrong"], conditions: [], mfg: {}, drugs: [] },
      settings: { backendUrl: "", patientId: 58, voice: false, blacklist: [], personality: "direct", guide: false },
      logs: [],
    },
    fetch: backend,
    waitMs: 1500,
    after: async (dom) => {
      const doc = dom.window.document;
      const at = (t) => doc.querySelector(`[data-demo="${t}"]`);
      at("nav:record")?.click();
      await wait(600);
      const line = at("rec:line");
      if (!line) return "the Record screen has no way to be spoken to";
      // written the way the browser writes it, so React sees the change
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set
        .call(line, "Bad cramps today, and I barely slept");
      line.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      at("rec:dictate")?.click();
      await wait(4000);                       // the words arrive, then the model answers
      const card = doc.querySelector('[data-demo="rec:tracker"]')?.innerHTML || "";
      if (!card.includes("HEARD")) return `nothing was heard onto the day card: ${card.slice(0, 200)}`;
      if (!/Pain/.test(card)) return `the card filled in without what was said: ${card.slice(0, 200)}`;
      return null;
    },
  });
}
console.log(code === 0 ? "OK" : `FAILED (${code})`);
process.exit(code);
