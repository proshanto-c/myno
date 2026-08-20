/**
 * Tawaazun showing itself: the sign-up reel, the simulation and the tutorial.
 *
 *   docker run --rm -v "$PWD":/w -w /w node:20-alpine node demoreel.test.mjs
 *
 * The clock, the randomness, the voice and the browser are all injected, so
 * minutes of pointer animation and narration are checked in no time at all,
 * without a real timer, a real element, a real click or a real utterance.
 */
import { HAANIYAH, FIELDS, signUp, showcase, runReel, keystrokes, isEmpty,
         firstPhase, afterPhase, travelMs, sayMs, TYPE_MS, FIELD_GAP_MS, PRESS_MS, BEAT_MS,
         TRAVEL_MIN, TRAVEL_MAX, SAY_MIN_MS, SAY_MAX_MS } from "./demoreel.js";

const T = [];
const test = (name, fn) => T.push([name, fn]);
const eq = (got, want, msg = "") => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`${msg}expected ${b}, got ${a}`);
};

/** Runs every queued callback in order, tracking the simulated time. */
function fakeClock() {
  const queue = [];
  let now = 0, id = 0;
  return {
    now: () => now,
    timer: (fn, ms) => { const t = { id: ++id, at: now + ms, fn, live: true }; queue.push(t); return t; },
    clear: (t) => { if (t) t.live = false; },
    /** Fire the next `count` timers, or all of them. */
    step(count = 1) {
      for (let i = 0; i < count; i++) {
        const next = queue.filter((t) => t.live).sort((a, b) => a.at - b.at)[0];
        if (!next) return false;
        next.live = false; now = next.at; next.fn();
      }
      return true;
    },
    run(limit = 100000) {
      for (let i = 0; i < limit; i++) if (!this.step(1)) return;
      throw new Error("the reel never finished");
    },
  };
}

/** A browser that is only a log: clicks land in `clicked`, characters in `form`. */
function fakeBrowser({ missing = [], moveMs = 300, revealMs = 0, sayEvery = null } = {}) {
  const b = {
    clicked: [], form: {}, at: [], said: [], lit: [], ended: false, dimmed: 0, entered: [],
    io: {
      reveal: (t) => (missing.includes(t) ? 0 : revealMs),
      move: (t) => { if (missing.includes(t)) return 0; b.at.push(t); return moveMs; },
      press: (t) => { if (!missing.includes(t)) b.clicked.push(t); },
      key: (t, v) => { if (!missing.includes(t)) b.form[t.replace(/^field:/, "")] = v; },
      enter: (t) => { if (!missing.includes(t)) b.entered.push(t); },
      say: (text) => { b.said.push(text); return sayEvery ?? sayMs(text); },
      spot: (t, text) => { b.lit.push([t, text]); return sayEvery ?? sayMs(text); },
      dim: () => { b.dimmed += 1; },
      end: () => { b.ended = true; },
    },
  };
  return b;
}

const REELS = [["sign-up", signUp(HAANIYAH)], ["showcase", showcase()]];
const kinds = (list, kind) => list.filter((x) => x.do === kind);
const targets = (list, kind) => kinds(list, kind).map((b) => b.target);
const count = (list, kind, target) => targets(list, kind).filter((t) => t === target).length;

// ---- who signs up ----------------------------------------------------------
test("she signs up as herself, and her numbers are ones the criteria can judge", () => {
  eq(HAANIYAH.name, "Haaniyah");
  eq(HAANIYAH.age >= 16 && HAANIYAH.age <= 45, true, `age ${HAANIYAH.age}: `);
  // menarche has to be before her age, or yearsPostMenarche goes negative
  eq(HAANIYAH.menarcheAge < HAANIYAH.age, true, "menarche after her age: ");
  eq(HAANIYAH.age - HAANIYAH.menarcheAge >= 3, true, "inside the 1-3y band, which is not assessable: ");
  eq(HAANIYAH.goals.length > 0, true, "no goal, so the first step cannot advance: ");
});

test("a person is typed one character at a time, field by field", () => {
  eq(keystrokes({ name: "Ada", age: 27 }, ["name", "age"]),
     [["name", "A"], ["name", "Ad"], ["name", "Ada"], ["age", "2"], ["age", "27"]]);
});

// ---- what every reel has to obey -------------------------------------------
for (const [name, list] of REELS) {
  test(`${name}: nothing is touched before the pointer has been taken to it`, () => {
    let last = null;
    for (const b of list) {
      if (b.do === "move") last = b.target;
      if (b.do === "press") eq(b.target, last, "clicked without moving there first: ");
      if (b.do === "key") eq(b.target, last, "typed into a box the pointer is not on: ");
      if (b.do === "spot") eq(b.target, last, "lit something the pointer is not resting on: ");
    }
  });

  test(`${name}: nothing is pointed at before it has been scrolled into view`, () => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].do !== "move") continue;
      const before = list[i - 1];
      eq(before && before.do === "reveal" && before.target === list[i].target, true,
         `${list[i].target} is pointed at without a reveal: `);
    }
  });

  test(`${name}: every line it says is a line worth hearing`, () => {
    for (const b of [...kinds(list, "say"), ...kinds(list, "spot")]) {
      eq(typeof b.text === "string" && b.text.trim().length > 12, true, `thin line: ${JSON.stringify(b.text)}: `);
      // a closing quote may follow the full stop — “normal.” ends a sentence too
      eq(/[.!?]["'”’]?$/.test(b.text.trim()), true, `unfinished sentence: ${JSON.stringify(b.text)}: `);
    }
  });
}

// ---- the sign-up -----------------------------------------------------------
test("it works the three steps in order and lets itself in at the end", () => {
  eq(targets(signUp(HAANIYAH), "press"),
     ["goal:whatswrong", "next",
      ...FIELDS.map((f) => `field:${f}`), "chip:familyHistory", "chip:acne", "next",
      "dx:unsure", "cond:hirsutism", "fg:chin:3", "fg:upperLip:2", "next"]);
});

test("the sign-up never asks for a device", () => {
  const said = [...kinds(signUp(HAANIYAH), "say")].map((b) => b.text).join(" ");
  eq(targets(signUp(HAANIYAH), "press").some((t) => t.startsWith("app:")), false, "the wearables screen is back: ");
  eq(/fitbit|oura|apple health/i.test(said), false, `a device is still pitched: ${said}`);
});

test("it ends with the whole of her in the form", () => {
  const clock = fakeClock();
  const b = fakeBrowser();
  runReel(signUp(HAANIYAH), b.io, { rand: () => 0.5, timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(b.form.name, HAANIYAH.name);
  eq(b.form.age, String(HAANIYAH.age));
  eq(b.form.menarcheAge, String(HAANIYAH.menarcheAge));
  eq(b.form.heightCm, String(HAANIYAH.heightCm));
  eq(b.form.weightKg, String(HAANIYAH.weightKg));
  eq(b.ended, true, "the pointer was never dismissed: ");
});

test("it types once per character, not once per field", () => {
  const clock = fakeClock();
  let calls = 0;
  const b = fakeBrowser();
  runReel(signUp(HAANIYAH), { ...b.io, key: () => { calls += 1; } },
    { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(calls, keystrokes(HAANIYAH).length);
});

test("there is a pause between fields and a quicker beat within one", () => {
  const clock = fakeClock();
  const at = [];
  const b = fakeBrowser();
  runReel(signUp({ ...HAANIYAH, name: "Al", age: 27, menarcheAge: "", heightCm: "", weightKg: "",
                   goals: [], chips: [], integrations: [] }),
    { ...b.io, key: (t) => at.push([t, clock.now()]) },
    { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.run();
  const withinName = at[1][1] - at[0][1];
  const betweenFields = at[2][1] - at[1][1];
  eq(withinName, TYPE_MS);
  eq(betweenFields >= FIELD_GAP_MS + PRESS_MS, true, `moved on too fast (${betweenFields}ms): `);
});

// ---- the showcase ----------------------------------------------------------
test("the showcase visits the four screens that make the case", () => {
  const clicked = targets(showcase(), "press");
  for (const tab of ["nav:home", "go:record", "nav:insights", "go:advocacy"])
    eq(clicked.includes(tab), true, `never went to ${tab}: `);
  // Settings is where you switch things off, which is nobody's reason to want
  // the app — the tour leaves it out.
  eq(clicked.includes("nav:settings"), false, "the tour detoured through Settings: ");
});

test("the showcase drives and explains in the same pass", () => {
  const list = showcase();
  eq(kinds(list, "spot").length >= 5, true, "it never lights anything up: ");
  eq(kinds(list, "press").length >= 10, true, "it never actually uses the app: ");
  // whatever it lights up it is also hovering — the shared invariant above
  // checks the pointer is on the target of every spot
  const lastSpot = list.map((b) => b.do).lastIndexOf("spot");
  const lastDim = list.map((b) => b.do).lastIndexOf("dim");
  eq(lastDim > lastSpot, true, "it ends with the lights still on: ");
});

test("everything the showcase changes, it changes back", () => {
  const list = showcase();
  // The sign-up's answers are hers and stay put. These are the tour's own
  // taps, on somebody else's screen, and every one of them is undone.
  for (const t of ["cal:today", "cal:range", "block:mood", "adv:lab", "cond:hirsutism"])
    eq(count(list, "press", t) % 2, 0, `${t} was left toggled: `);
});

test("the sign-up records the hirsutism a clinician already found, and scores it", () => {
  const clicks = targets(signUp(HAANIYAH), "press");
  eq(clicks.includes("cond:hirsutism"), true, "the condition is never entered: ");
  eq(new Set(clicks.filter((t) => t.startsWith("fg:"))).size >= 2, true, "too little of the sheet is scored: ");
  // ... and the tour later shows what that settled, on the screen that says so
  eq(targets(showcase(), "spot").includes("adv:triad"), true, "the criteria are never shown: ");
});

test("the showcase never touches what it has no business touching", () => {
  // the microphone asks the browser for permission, printing opens a dialog,
  // and switching the voice off mid-sentence would silence the narrator
  // the microphone would ask a stranger's browser for permission, printing
  // opens a dialog, and the settings switches are not the tour's to touch
  const off = ["rec:mic", "adv:print", "set:voice", "set:sounds", "set:guide", "log:done"];
  for (const t of targets(showcase(), "press"))
    eq(off.includes(t), false, `pressed ${t}: `);
});

test("the showcase says its line to the microphone, not into the box", () => {
  const list = showcase();
  const typed = kinds(list, "key").filter((b) => b.target === "rec:line");
  eq(typed.length > 10, true, "nothing was said to the Record screen: ");
  eq(typed.length < 60, true, "the line is too long to sit through: ");
  eq(typed[typed.length - 1].value.endsWith("slept"), true, `line came out ${typed[typed.length - 1].value}: `);
  // written to the hidden line, then spoken — never typed into the visible box
  const clicks = targets(list, "press");
  eq(clicks.indexOf("rec:dictate") > -1, true, "the line is never spoken: ");
  eq(clicks.includes("rec:type"), false, "it typed into the box instead of talking: ");
});

test("the showcase ends the conversation and shows the form behind it", () => {
  const clicks = targets(showcase(), "press");
  eq(clicks.includes("rec:end"), true, "the sheet is never opened: ");
  eq(clicks.indexOf("log:keep") > clicks.indexOf("rec:end"), true, "the sheet is never closed again: ");
});

test("she introduces herself once, at the start, and never again", () => {
  const hellos = [...kinds(signUp(HAANIYAH), "say"), ...kinds(showcase(), "say"), ...kinds(showcase(), "spot")]
    .filter((b) => /I'm Haaniyah/.test(b.text));
  eq(hellos.length, 1, "she introduced herself more than once: ");
  eq(kinds(signUp(HAANIYAH), "say")[0].text.includes("I'm Haaniyah"), true,
     "the introduction is not the first thing said: ");
  // ... and the tour opens by saying what it is about to do
  eq(/Tawaazun/.test(showcase().find((b) => b.text)?.text || ""), true,
     "the tour opens without saying what it is showing: ");
});

test("the showcase talks the whole way through", () => {
  const list = showcase();
  const spoken = [...kinds(list, "say"), ...kinds(list, "spot")];
  eq(spoken.length >= 10, true, `only ${spoken.length} lines: `);
  eq(kinds(list, "say").every((b) => b.hold !== false), true, "a line is left to be cut off mid-word: ");
  // A line is one clip and one caption, so a paragraph in a single beat would
  // both outrun the caption bar and leave the pointer standing still.
  const longest = Math.max(...spoken.map((b) => b.text.split(/\s+/).length));
  eq(longest <= 28, true, `a ${longest}-word line: `);
});

// ---- the tutorial ----------------------------------------------------------
// ---- running them ----------------------------------------------------------
test("a line is held for exactly as long as the voice says it takes", () => {
  const clock = fakeClock();
  const b = fakeBrowser();
  const list = [{ do: "say", text: "first." }, { do: "say", text: "second." }, { do: "wait", ms: 0 }];
  const at = [];
  // the browser reports what the clip actually runs to; the reel waits for it
  runReel(list, { ...b.io, say: (t) => { at.push(clock.now()); return 4000; } },
    { timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(at[1] - at[0], 4000, "the next line started before the last had finished: ");
});

test("it waits on the app, and carries on when the app says it is done", () => {
  const clock = fakeClock();
  const b = fakeBrowser();
  let asked = 0;
  const list = [{ do: "until", what: "quiet", max: 9000 }, { do: "say", text: "after it stopped." }];
  runReel(list, { ...b.io, until: () => (++asked < 4 ? 250 : 0) },
    { timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(asked, 4, "it stopped asking too early: ");
  eq(b.said, ["after it stopped."], "it spoke before the app had finished: ");
});

test("the showcase lets the app finish answering before she speaks again", () => {
  const list = showcase();
  const untils = list.filter((x) => x.do === "until").map((x) => x.what);
  eq(untils, ["talking", "quiet"], "it goes back to talking on a stopwatch: ");
  // ... and neither wait can hang the reel for good
  for (const u of list.filter((x) => x.do === "until"))
    eq(typeof u.max === "number" && u.max > 0 && u.max <= 30000, true, `no deadline on ${u.what}: `);
  // the line before the microphone hands over to it
  const said = kinds(list, "say").map((x) => x.text);
  eq(said.some((t) => /check-in|record my day/i.test(t)), true, "it walks into Record without a word: ");
});

test("a target that isn't there costs a beat, not the reel", () => {
  const clock = fakeClock();
  const b = fakeBrowser({ missing: ["goal:whatswrong"] });
  runReel(signUp(HAANIYAH), b.io, { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(b.clicked.includes("goal:whatswrong"), false);
  eq(b.clicked.filter((c) => c === "next").length, 3, "the reel gave up: ");
  eq(b.form.name, HAANIYAH.name);
});

test("every reel finishes, and none of them outstays its welcome", () => {
  // Seconds, worst case: every hop the slowest it can be. An advert that runs
  // past these is not an advert any more.
  const limits = { "sign-up": 105, showcase: 230 };
  for (const [name, list] of REELS) {
    const clock = fakeClock();
    const b = fakeBrowser({ moveMs: TRAVEL_MAX, revealMs: 420 });     // every hop the slowest it can be
    runReel(list, b.io, { rand: () => 1, timer: clock.timer, clear: clock.clear });
    clock.run();
    eq(b.ended, true, `${name} never reached the end: `);
    eq(clock.now() / 1000 < limits[name], true,
       `${name} took ${Math.round(clock.now() / 1000)}s, over its ${limits[name]}s budget`);
  }
});

// ---- how far the pointer travels, how long a line takes --------------------
test("a hop is never instant and never a wait", () => {
  eq(travelMs(0, 0), TRAVEL_MIN);
  eq(travelMs(4000, 0), TRAVEL_MAX);
  eq(travelMs(300, 0) > travelMs(60, 0), true, "distance buys no time: ");
});

test("a line is given about as long as it takes to say", () => {
  eq(sayMs(""), SAY_MIN_MS, "an empty line still pauses: ");
  eq(sayMs("Two words.") >= SAY_MIN_MS, true);
  eq(sayMs(new Array(400).fill("word").join(" ")), SAY_MAX_MS, "a long line is capped: ");
  eq(sayMs("one two three four five six seven eight nine ten eleven twelve") > sayMs("one two three."), true,
     "length buys no time: ");
});

// ---- which reel is due -----------------------------------------------------
const ON = { guide: true };

test("a first visit is signed up, then shown around", () => {
  eq(firstPhase({ ready: true, onboarded: false, empty: true, settings: ON }), "signup");
  eq(afterPhase("signup").next, "show");
  eq(afterPhase("show").next, null);
});

test("nothing plays before the app is ready", () => {
  eq(firstPhase({ ready: false, onboarded: false, empty: true, settings: ON }), null);
});

test("switched off, nothing plays at all", () => {
  eq(firstPhase({ ready: true, onboarded: true, settings: { guide: false } }), null);
  eq(firstPhase({ ready: true, onboarded: false, empty: true, settings: {} }), null);
});

test("someone already onboarded is shown around rather than signed up again", () => {
  eq(firstPhase({ ready: true, onboarded: true, settings: ON }), "show");
});

test("a half-filled sign-up is left alone", () => {
  eq(firstPhase({ ready: true, onboarded: false, empty: false, settings: ON }), null);
});

test("the guide is spent once it has played, and once it has been skipped", () => {
  eq(afterPhase("show").off, "guide");
  eq(afterPhase("signup").off, null, "the sign-up spent the switch before the tour ran: ");
  eq(afterPhase("signup", { byHand: true }), { next: null, off: "guide" },
     "skipping the sign-up led straight into the tour: ");
  eq(afterPhase("show", { byHand: true }).off, "guide");
});

// ---- getting out of the way ------------------------------------------------
test("cancelling stops it mid-word and nothing more happens", () => {
  const clock = fakeClock();
  const b = fakeBrowser();
  const cancel = runReel(signUp(HAANIYAH), b.io, { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.step(6);                  // a few beats in, then a person takes over
  const clicksSoFar = b.clicked.length;
  cancel();
  clock.run();
  eq(b.clicked.length, clicksSoFar, "kept clicking after being cancelled: ");
  eq(b.ended, false, "ran to the end anyway: ");
  eq(String(b.form.name || "").length < HAANIYAH.name.length, true, "typed the whole name anyway: ");
});

test("cancelling twice is harmless", () => {
  const clock = fakeClock();
  const b = fakeBrowser();
  const cancel = runReel(showcase(), b.io, { rand: () => 0, timer: clock.timer, clear: clock.clear });
  cancel(); cancel();
  clock.run();
  eq(b.clicked.length, 0);
  eq(b.said.length, 0, "kept talking to an empty room: ");
});

test("a form with anything in it is left alone", () => {
  eq(isEmpty({}), true);
  eq(isEmpty({ name: "", age: "" }), true);
  eq(isEmpty({ name: "Ada" }), false);
  eq(isEmpty({ name: " ", age: "27" }), false);
  eq(isEmpty({ name: "   " }), true, "whitespace is not an answer: ");
  eq(isEmpty({ goals: ["conceive"] }), false, "a goal already picked is a person's: ");
});

// ---- run it ----------------------------------------------------------------
let passed = 0, failed = 0;
for (const [name, fn] of T) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
