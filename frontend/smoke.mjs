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
 *
 *   docker compose build frontend && docker compose up -d frontend
 *   BUNDLE=$(curl -sk https://localhost/ | grep -o '/assets/[^"]*\.js' | head -1)
 *   curl -sk "https://localhost$BUNDLE" -o /tmp/app-bundle.mjs
 *   cp smoke.mjs /tmp/ && docker run --rm -v /tmp:/t -w /t node:20-alpine \
 *     sh -c "npm i --silent jsdom && node /t/smoke.mjs /t/app-bundle.mjs"
 *
 * Run it from the directory holding node_modules — node resolves imports from
 * the script's own location, not the working directory.
 *
 * Exit 0 = both passes rendered, 2 = threw on import, 3 = rendered nothing,
 * 4 = rendered but logged a runtime error.
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

function backend(url) {
  const u = String(url), body =
    u.includes("/record/schema") ? { schema: [], categories: [] }
    : u.includes("/criteria/rules") ? { cycleBands: [{ fromYear: 0, toYear: null, label: "adult", shortDays: 21, longDays: 35 }], singleCycleDays: 90 }
    : u.endsWith("/logs") ? LOGS
    : u.includes("/summary") ? SUMMARY
    : u.includes("/assessment") || u.includes("/assess") ? ASSESSMENT
    : u.includes("/insights") ? { stats: SUMMARY, analysis: { summary: "", insights: [] }, categories: [] }
    : u.includes("/suggestions") ? { suggestions: [], refreshing: false }
    : u.includes("/patients") ? { id: 58 }
    : {};
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

async function pass(name, { stored, fetch: fetchImpl }) {
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
  console.error = (...a) => errs.push(a.map(String).join(" ").slice(0, 400));

  try {
    // cache-bust so the second pass re-evaluates the module top to bottom
    await import(`${bundle}?pass=${encodeURIComponent(name)}`);
  } catch (e) {
    realError(`[${name}] IMPORT THREW: ${e.message}`);
    return 2;
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.error = realError;

  const html = dom.window.document.getElementById("root").innerHTML;
  console.log(`[${name}] DOM ${html.length} chars`);
  if (errs.length) {
    console.log(`[${name}] RUNTIME ERROR:\n${errs.slice(0, 2).join("\n---\n")}`);
    return 4;
  }
  if (html.length < 500) return 3;
  return 0;
}

let code = await pass("cold", { fetch: () => Promise.reject(new Error("offline")) });
if (code === 0) {
  code = await pass("populated", {
    stored: {
      profile: { onboarded: true, name: "Test", goals: ["manage"], conditions: [], mfg: {}, drugs: [] },
      settings: { backendUrl: "", patientId: 58, voice: false, blacklist: [], personality: "direct" },
      logs: [],
    },
    fetch: backend,
  });
}
console.log(code === 0 ? "OK" : `FAILED (${code})`);
process.exit(code);
