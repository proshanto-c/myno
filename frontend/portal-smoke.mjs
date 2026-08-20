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
    year: 2025, isOa: false, licence: "CC BY-NC-ND", retracted: false, screenState: "included" },
  { id: 2, pmid: "27664216", kind: "article", title: "The prevalence and phenotypic features of PCOS",
    journal: "Hum Reprod", year: 2016, isOa: true, licence: "CC BY", retracted: false, screenState: "new" },
];

async function pass(name, { authRequired, signedIn }) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://localhost/research/", pretendToBeVisual: true });
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
      : u.includes("/corpus") ? { sources: SOURCES }
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

  const html = dom.window.document.getElementById("root").innerHTML;
  const asked = seen.some((c) => c.includes("/dalil/api/auth/whoami"));
  const loaded = seen.some((c) => c.includes("/dalil/api/corpus"));
  console.log(`[${name}] DOM ${html.length} chars · asked whoami: ${asked} · fetched corpus: ${loaded}`);

  if (errs.length) { console.log(`[${name}] RUNTIME ERROR:\n${errs[0]}`); return 4; }
  if (html.length < 300) return 3;

  // the checks that actually mean something
  if (authRequired && !signedIn) {
    if (!html.includes("Sign in")) { console.log(`[${name}] no sign-in form behind the gate`); return 3; }
  } else {
    if (!html.includes("Corpus")) { console.log(`[${name}] the corpus never rendered`); return 3; }
    if (!html.includes("Polyendocrine")) { console.log(`[${name}] the rows never rendered`); return 3; }
    if (!loaded) { console.log(`[${name}] never asked for the corpus`); return 3; }
  }
  // the lockup has to name both products, in Arabic, with the mark between them
  if (!html.includes("دليل")) { console.log(`[${name}] no دليل wordmark`); return 3; }
  if (!html.includes("توازن")) { console.log(`[${name}] the attribution to توازن is missing`); return 3; }
  if (!html.includes("M53.33,76.42")) { console.log(`[${name}] the shared mark is not drawn`); return 3; }
  // ...but the patient app's palette must not come with it
  if (/ffe2e2|9e4f5e|5c4b7d/i.test(html)) { console.log(`[${name}] patient tokens leaked in`); return 3; }
  return 0;
}

let code = await pass("open", { authRequired: false, signedIn: true });
if (code === 0) code = await pass("gated", { authRequired: true, signedIn: false });
if (code === 0) code = await pass("signed-in", { authRequired: true, signedIn: true });
console.log(code === 0 ? "OK" : `FAILED (${code})`);
process.exit(code);
