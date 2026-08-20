/**
 * Does the front door work?
 *
 * The third entry, and the one every visitor sees first — so it gets the same
 * treatment as the other two. The checks are about content rather than pixels:
 * both doors present, both wordmarks, the shared mark drawn on each side, and
 * PMOS named on both cards, because who this is for is the page's whole job.
 *
 *   docker cp myno-frontend-1:/usr/share/nginx/html/assets /tmp/dist/assets
 *   cp landing-smoke.mjs /tmp/ && docker run --rm -v /tmp:/t -w /t node:20-alpine \
 *     sh -c "npm i --silent jsdom && node /t/landing-smoke.mjs /t/dist/assets/landing-*.js"
 *
 * Exit 0 = fine, 2 = threw on import, 3 = a check failed, 4 = console error.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "https://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "SVGElement",
                 "localStorage", "getComputedStyle", "requestAnimationFrame",
                 "cancelAnimationFrame", "MutationObserver"]) globalThis[k] = dom.window[k];

const errs = [];
const realError = console.error;
console.error = (...a) => {
  const line = a.map(String).join(" ");
  if (!line.includes("[MODULE_TYPELESS_PACKAGE_JSON]")) errs.push(line.slice(0, 300));
};

try {
  await import(process.argv[2]);
} catch (e) {
  realError("IMPORT THREW:", e.message);
  process.exit(2);
}
await new Promise((r) => setTimeout(r, 700));
console.error = realError;

const html = dom.window.document.getElementById("root").innerHTML;
const has = (s) => html.includes(s);
const checks = [
  ["both doors lead somewhere", has('href="/tawaazun/"') && has('href="/dalil/"')],
  ["both wordmarks in Arabic", has("توازن") && has("دليل")],
  ["the shared mark is drawn on each", (html.match(/M53\.33,76\.42/g) || []).length === 2],
  ["PMOS is named on both cards", (html.match(/PMOS/g) || []).length >= 2],
  ["it speaks to someone who only suspects it", has("wondering if you are")],
  ["Dalīl is placed as the engine behind the app", has("research engine") && has("Tawaazun")],
];

console.log(`DOM ${html.length} chars`);
let bad = 0;
for (const [what, ok] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) bad += 1;
}
if (errs.length) { console.log("RUNTIME ERROR:", errs[0]); process.exit(4); }
process.exit(bad || html.length < 800 ? 3 : 0);
