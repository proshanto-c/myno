/**
 * Does the built app actually run?
 *
 * Serving index.html with a 200 proves nothing: a module-scope mistake — a const
 * read before its own line, a name that isn't defined — throws at import and
 * leaves a blank page behind a perfectly healthy web server. This loads the
 * built bundle into a DOM and checks something rendered.
 *
 *   docker compose build frontend
 *   BUNDLE=$(curl -sk https://localhost/ | grep -o '/assets/[^"]*\.js' | head -1)
 *   curl -sk "https://localhost$BUNDLE" -o /tmp/app-bundle.mjs
 *   docker run --rm -v /tmp:/t -v "$PWD":/w -w /t node:20-alpine \
 *     sh -c "npm i --silent jsdom && node /w/smoke.mjs /t/app-bundle.mjs"
 *
 * Exit 0 = it mounted, 2 = it threw on import, 3 = it rendered nothing.
 */
import { JSDOM } from "jsdom";

const bundle = process.argv[2] || "/t/app-bundle.mjs";
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: "https://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "SVGElement",
                 "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
                 "MutationObserver"]) globalThis[k] = dom.window[k];
// no backend in the smoke test: the app must still render its shell
globalThis.fetch = () => Promise.reject(new Error("offline in smoke test"));

const errs = [];
dom.window.addEventListener("error", (e) => errs.push(String(e.error || e.message)));
try {
  await import(bundle);
} catch (e) {
  console.log("IMPORT THREW:", e.message);
  process.exit(2);
}
await new Promise((r) => setTimeout(r, 800));
const html = dom.window.document.getElementById("root").innerHTML;
console.log("mounted DOM length:", html.length);
console.log("has brand:", /توازن|Tawazzun/.test(html));
if (errs.length) console.log("runtime errors:", errs.slice(0, 3));
process.exit(html.length > 500 ? 0 : 3);
