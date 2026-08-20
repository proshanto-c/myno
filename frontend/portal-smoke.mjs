/**
 * Does Dalīl's portal actually run?
 *
 * The patient app has smoke.mjs; this is the same idea for the second entry.
 * It matters at least as much here, because the portal is a separate bundle
 * that no one looks at while working on the patient app — a break in it would
 * sit unnoticed until a researcher opened it.
 *
 *   docker cp myno-frontend-1:/usr/share/nginx/html/assets /tmp/dist/assets
 *   cp portal-smoke.mjs /tmp/ && docker run --rm -v /tmp:/t -w /t node:20-alpine \
 *     sh -c "npm i --silent jsdom && node /t/portal-smoke.mjs /t/dist/assets/dalil-*.js"
 *
 * The whole assets directory is needed, not just the entry: the portal shares a
 * vendor chunk with the patient app.
 *
 * Exit 0 = it rendered, 2 = threw on import, 3 = rendered nothing, 4 = console error.
 */
import { JSDOM } from "jsdom";

const bundle = process.argv[2];
const SOURCES = [
  { id: 1, pmid: "29083730", nbk: "NBK459251", kind: "chapter",
    title: "Polyendocrine Metabolic Ovarian Syndrome", journal: "StatPearls",
    year: 2025, isOa: false, licence: "CC BY-NC-ND", retracted: false, screenState: "included",
    hasFulltext: false, flags: [], pubTypes: ["Study Guide"], authors: ["Shukla A"] },
  { id: 2, pmid: "27664216", kind: "article", title: "The prevalence and phenotypic features of PCOS",
    journal: "Hum Reprod", year: 2016, isOa: true, licence: "CC BY", retracted: false,
    screenState: "new", hasFulltext: true, flags: ["id_mismatch"], pubTypes: [], authors: [] },
];
const SUMMARY = { total: 56, byState: { new: 53, excluded: 2, needs_text: 1 }, openAccess: 20,
  fulltext: 20, retracted: 0, unchecked: 0, citations: 2299, unpromoted: 2135 };
const QUERIES = [{ id: 3, name: "sleep", term: "…", informs: ["sleep", "brainFog"], enabled: true,
  highWater: "2026/08/20", lastRun: { added: 12, fetched: 40 } }];
const RUNS = [{ id: 7, queryId: 3, state: "done", total: 271, cap: 200, cursor: 200, fetched: 198,
  added: 12, edatFrom: "", edatTo: "2026/08/20", startedAt: "2026-08-20T21:00:00" }];
// One module that verified and one that did not: the report has to show the
// difference, because a score with no findable sentence behind it is the thing
// the module exists to replace.
const REPORTS = [{ id: 4, sourceId: 2, score: 56, verdict: "considerations",
  title: "The prevalence and phenotypic features of PCOS", pmid: "27664216",
  journal: "Hum Reprod", year: 2016, flags: ["quote_unverified"], narrative: "A survey.",
  rubricVersion: "1", promptVersion: "1", model: "claude-sonnet-4-6",
  tokensIn: 12000, tokensOut: 900, createdAt: "2026-08-20T22:00:00",
  verified: { of: 5, found: 4 },
  modules: [
    { key: "design", label: "Study design", weight: 16, basis: "deterministic", score: 6,
      note: "cross-sectional", quote: "", offset: -1, section: "" },
    { key: "effect", label: "Effect clarity", weight: 10, basis: "model", score: 7,
      note: "a number and a direction", quote: "prevalence was 11.9%", offset: 400, section: "RESULTS" },
    { key: "daily", label: "Daily-tracking applicability", weight: 10, basis: "model", score: 0,
      note: "no quote that could be found in the text", quote: "invented sentence", offset: -1, section: "" },
  ]}];
const CLAIMS = [{ id: 9, sourceId: 2, state: "extracted", claimText: "Shorter sleep goes with more brain fog",
  relation: "associated_with", direction: "-", population: "women with PCOS", certainty: "low",
  effect: { measure: "r", value: -0.31, p: 0.001 }, quote: "shorter sleep was associated with fog",
  quoteSection: "RESULTS", quoteOffset: 512, quoteVerified: true, displayText: "",
  fields: [{ key: "sleep", role: "exposure", proposed: false },
           { key: "brainFog", role: "outcome", proposed: false }] }];

async function pass(name, { authRequired, signedIn, hash = "", check }) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: `https://localhost/dalil/${hash}`, pretendToBeVisual: true });
  for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "SVGElement",
                   "localStorage", "getComputedStyle", "requestAnimationFrame",
                   "cancelAnimationFrame", "MutationObserver"]) globalThis[k] = dom.window[k];

  const seen = [];
  globalThis.fetch = (url, opts = {}) => {
    const u = String(url);
    seen.push(`${opts.method || "GET"} ${u}`);
    const body =
      u.includes("/auth/whoami") ? (signedIn
        ? { signedIn: true, authRequired, email: "ada@example.ac.uk", name: "Ada", role: "admin" }
        : { signedIn: false, authRequired })
      : u.includes("/corpus") ? { sources: SOURCES, summary: SUMMARY }
      : u.includes("/queries") ? { queries: QUERIES, seeded: 12 }
      : u.includes("/runs") ? { runs: RUNS }
      : u.includes("/reports") ? { reports: REPORTS }
      : u.includes("/report/") ? { source: SOURCES[1], report: REPORTS[0], claims: CLAIMS, citedBy: 4 }
      : u.includes("/jobs") ? { current: null, past: [] }
      : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };

  const errs = [];
  const realError = console.error;
  // node's own module warnings arrive on this channel; only React's do here
  console.error = (...a) => {
    const line = a.map(String).join(" ");
    if (!line.includes("[MODULE_TYPELESS_PACKAGE_JSON]")) errs.push(line.slice(0, 300));
  };

  try {
    await import(`${bundle}?pass=${encodeURIComponent(name)}`);
  } catch (e) {
    realError(`[${name}] IMPORT THREW: ${e.message}`);
    return 2;
  }
  await new Promise((r) => setTimeout(r, 900));
  console.error = realError;

  let html = dom.window.document.getElementById("root").innerHTML;
  const asked = seen.some((c) => c.includes("/dalil/api/auth/whoami"));
  const loaded = seen.some((c) => c.includes("/dalil/api/corpus"));
  console.log(`[${name}] DOM ${html.length} chars · asked whoami: ${asked} · fetched corpus: ${loaded}`);

  if (errs.length) { console.log(`[${name}] RUNTIME ERROR:\n${errs[0]}`); return 4; }
  if (html.length < 300) return 3;

  if (check) {
    const problem = await check(dom);
    if (problem) { console.log(`[${name}] ${problem}`); return 3; }
    html = dom.window.document.getElementById("root").innerHTML;
  }

  // the checks that actually mean something
  if (authRequired && !signedIn) {
    if (!html.includes("Sign in")) { console.log(`[${name}] no sign-in form behind the gate`); return 3; }
  } else if (hash === "#reports") {
    for (const want of ["Verdict", "Considerations", "Study design", "prevalence was 11.9%",
                        "not found in the text", "Shorter sleep goes with more brain fog",
                        "rubric 1", "exposure: sleep"]) {
      if (!html.includes(want)) { console.log(`[${name}] the report omits ${JSON.stringify(want)}`); return 3; }
    }
  } else {
    if (!html.includes("Corpus")) { console.log(`[${name}] the corpus never rendered`); return 3; }
    if (!html.includes("Polyendocrine")) { console.log(`[${name}] the rows never rendered`); return 3; }
    if (!loaded) { console.log(`[${name}] never asked for the corpus`); return 3; }
    // the summary is the shape of the library, and the first thing read
    if (!html.includes("2,299") && !html.includes("2299")) {
      console.log(`[${name}] the summary never rendered`); return 3;
    }
    // a source carrying a flag has to say so in the row, not only in the panel
    if (!html.includes("id mismatch")) { console.log(`[${name}] flags are not shown`); return 3; }
  }
  // the lockup has to name both products, in Arabic, with the mark between them
  if (!html.includes("دليل")) { console.log(`[${name}] no دليل wordmark`); return 3; }
  if (!html.includes("توازن")) { console.log(`[${name}] the attribution to توازن is missing`); return 3; }
  if (!html.includes("M53.33,76.42")) { console.log(`[${name}] the shared mark is not drawn`); return 3; }
  // ...but the patient app's palette must not come with it
  if (/ffe2e2|9e4f5e|5c4b7d/i.test(html)) { console.log(`[${name}] patient tokens leaked in`); return 3; }
  return 0;
}

/** Open the first report in the list, the way a person would. */
const openFirstReport = async (dom) => {
  const row = dom.window.document.querySelector("tbody tr");
  if (!row) return "no report rows to open";
  row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 700));
  return null;
};

let code = await pass("open", { authRequired: false, signedIn: true });
if (code === 0) code = await pass("gated", { authRequired: true, signedIn: false });
if (code === 0) code = await pass("signed-in", { authRequired: true, signedIn: true });
if (code === 0) code = await pass("report", { authRequired: false, signedIn: true,
                                              hash: "#reports", check: openFirstReport });
console.log(code === 0 ? "OK" : `FAILED (${code})`);
process.exit(code);
