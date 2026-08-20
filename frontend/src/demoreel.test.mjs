/**
 * Tawaazun showing itself: the sign-up reel, the simulation and the tutorial.
 *
 *   docker run --rm -v "$PWD":/w -w /w node:20-alpine node demoreel.test.mjs
 *
 * The clock, the randomness, the voice and the browser are all injected, so
 * minutes of pointer animation and narration are checked in no time at all,
 * without a real timer, a real element, a real click or a real utterance.
 */
import { SARA, FIELDS, signUp, simulation, tutorial, runReel, keystrokes, isEmpty,
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

const REELS = [["sign-up", signUp(SARA)], ["simulation", simulation()], ["tutorial", tutorial()]];
const kinds = (list, kind) => list.filter((x) => x.do === kind);
const targets = (list, kind) => kinds(list, kind).map((b) => b.target);
const count = (list, kind, target) => targets(list, kind).filter((t) => t === target).length;

// ---- who signs up ----------------------------------------------------------
test("the reel is Sara, and Sara is plausible for the criteria that judge her", () => {
  eq(SARA.name, "Sara");
  eq(SARA.age >= 16 && SARA.age <= 45, true, `age ${SARA.age}: `);
  // menarche has to be before her age, or yearsPostMenarche goes negative
  eq(SARA.menarcheAge < SARA.age, true, "menarche after her age: ");
  eq(SARA.age - SARA.menarcheAge >= 3, true, "inside the 1-3y band, which is not assessable: ");
  eq(SARA.goals.length > 0, true, "no goal, so the first step cannot advance: ");
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
      eq(/[.!?]$/.test(b.text.trim()), true, `unfinished sentence: ${JSON.stringify(b.text)}: `);
    }
  });
}

// ---- the sign-up -----------------------------------------------------------
test("it works the three steps in order and lets itself in at the end", () => {
  eq(targets(signUp(SARA), "press"),
     ["goal:whatswrong", "next",
      ...FIELDS.map((f) => `field:${f}`), "chip:familyHistory", "chip:acne", "next",
      "dx:unsure", "next"]);
});

test("the sign-up never asks for a device", () => {
  const said = [...kinds(signUp(SARA), "say")].map((b) => b.text).join(" ");
  eq(targets(signUp(SARA), "press").some((t) => t.startsWith("app:")), false, "the wearables screen is back: ");
  eq(/fitbit|oura|apple health/i.test(said), false, `a device is still pitched: ${said}`);
});

test("it ends with the whole of Sara in the form", () => {
  const clock = fakeClock();
  const b = fakeBrowser();
  runReel(signUp(SARA), b.io, { rand: () => 0.5, timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(b.form.name, SARA.name);
  eq(b.form.age, String(SARA.age));
  eq(b.form.menarcheAge, String(SARA.menarcheAge));
  eq(b.form.heightCm, String(SARA.heightCm));
  eq(b.form.weightKg, String(SARA.weightKg));
  eq(b.ended, true, "the pointer was never dismissed: ");
});

test("it types once per character, not once per field", () => {
  const clock = fakeClock();
  let calls = 0;
  const b = fakeBrowser();
  runReel(signUp(SARA), { ...b.io, key: () => { calls += 1; } },
    { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(calls, keystrokes(SARA).length);
});

test("there is a pause between fields and a quicker beat within one", () => {
  const clock = fakeClock();
  const at = [];
  const b = fakeBrowser();
  runReel(signUp({ ...SARA, name: "Al", age: 27, menarcheAge: "", heightCm: "", weightKg: "",
                   goals: [], chips: [], integrations: [] }),
    { ...b.io, key: (t) => at.push([t, clock.now()]) },
    { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.run();
  const withinName = at[1][1] - at[0][1];
  const betweenFields = at[2][1] - at[1][1];
  eq(withinName, TYPE_MS);
  eq(betweenFields >= FIELD_GAP_MS + PRESS_MS, true, `moved on too fast (${betweenFields}ms): `);
});

// ---- the simulation --------------------------------------------------------
test("the simulation visits every tab", () => {
  const clicked = targets(simulation(), "press");
  for (const tab of ["nav:home", "go:record", "nav:insights", "go:advocacy", "nav:settings"])
    eq(clicked.includes(tab), true, `never went to ${tab}: `);
});

test("everything the simulation changes, it changes back", () => {
  const list = simulation();
  for (const t of ["cal:today", "cal:range", "block:mood", "adv:lab", "cond:hirsutism"])
    eq(count(list, "press", t) % 2, 0, `${t} was left toggled: `);
  // a Ferriman-Gallwey score left behind would go on settling a criterion long
  // after the demo — the same button twice is how the sheet clears one
  for (const t of new Set(targets(list, "press").filter((t) => t.startsWith("fg:"))))
    eq(count(list, "press", t) % 2, 0, `${t} was left scored: `);
});

test("the simulation shows what hirsutism settles, and where it shows up", () => {
  const list = simulation();
  const clicks = targets(list, "press");
  eq(clicks.includes("cond:hirsutism"), true, "the sheet is never opened: ");
  eq(clicks.filter((t) => t.startsWith("fg:")).length >= 8, true, "too little of the sheet is scored: ");
  // scoring it has to be followed by the screen where it changes the verdict
  const scored = clicks.findIndex((t) => t.startsWith("fg:"));
  eq(clicks.indexOf("go:advocacy", scored) > scored, true, "it scores the sheet and never shows the effect: ");
});

test("the simulation never touches what it has no business touching", () => {
  // the microphone asks the browser for permission, printing opens a dialog,
  // and switching the voice off mid-sentence would silence the narrator
  const off = ["rec:mic", "rec:end", "adv:print", "set:voice", "set:sounds", "set:tour", "set:sim", "log:done"];
  for (const t of targets(simulation(), "press"))
    eq(off.includes(t), false, `pressed ${t}: `);
});

test("the simulation holds a conversation by typing, and submits it", () => {
  const list = simulation();
  const typed = kinds(list, "key").filter((b) => b.target === "rec:type");
  eq(typed.length > 10, true, "nothing was said to the Record screen: ");
  eq(targets(list, "enter"), ["rec:type"]);
  // the last keystroke is the whole line, and the return key follows it
  eq(typed[typed.length - 1].value.endsWith("slept"), true, `line came out ${typed[typed.length - 1].value}: `);
});

test("the simulation talks the whole way through", () => {
  const spoken = kinds(simulation(), "say");
  eq(spoken.length >= 15, true, `only ${spoken.length} lines: `);
  eq(spoken.some((b) => b.hold === false), true, "nothing is ever said while it moves: ");
});

// ---- the tutorial ----------------------------------------------------------
test("the tutorial changes nothing", () => {
  const list = tutorial();
  eq(kinds(list, "key").length, 0, "the tutorial typed something: ");
  eq(kinds(list, "enter").length, 0, "the tutorial submitted something: ");
  for (const t of targets(list, "press"))
    eq(t.startsWith("nav:"), true, `pressed ${t}, which is not navigation: `);
});

test("the tutorial lights up something on every tab, and puts the lights back", () => {
  const list = tutorial();
  eq(kinds(list, "spot").length >= 8, true, "too little of the interface is explained: ");
  eq(kinds(list, "dim").length >= 1, true, "the last highlight is never cleared: ");
  const lastSpot = list.map((b) => b.do).lastIndexOf("spot");
  const lastDim = list.map((b) => b.do).lastIndexOf("dim");
  eq(lastDim > lastSpot, true, "it ends with the lights still on: ");
});

// ---- running them ----------------------------------------------------------
test("a line that is spoken holds the reel; one spoken over the top does not", () => {
  const clock = fakeClock();
  const b = fakeBrowser({ sayEvery: 4000 });
  const list = [{ do: "say", text: "held." }, { do: "wait", ms: 0 },
                { do: "say", text: "over the top.", hold: false }, { do: "wait", ms: 0 }];
  const at = [];
  runReel(list, { ...b.io, say: (t) => { at.push(clock.now()); return 4000; } },
    { timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(at[1] - at[0], 4000, "a held line did not hold: ");
  eq(clock.now() - at[1], BEAT_MS, "a line said over the top stopped everything: ");
});

test("a target that isn't there costs a beat, not the reel", () => {
  const clock = fakeClock();
  const b = fakeBrowser({ missing: ["goal:whatswrong"] });
  runReel(signUp(SARA), b.io, { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(b.clicked.includes("goal:whatswrong"), false);
  eq(b.clicked.filter((c) => c === "next").length, 4, "the reel gave up: ");
  eq(b.form.name, SARA.name);
});

test("every reel finishes, and none of them outstays its welcome", () => {
  const limits = { "sign-up": 60, simulation: 420, tutorial: 300 };   // seconds, worst case
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
const ON = { simulation: true, tutorial: true };

test("a first visit is signed up, shown around, then taught", () => {
  eq(firstPhase({ ready: true, onboarded: false, empty: true, settings: ON }), "signup");
  eq(afterPhase("signup", { settings: ON }).next, "sim");
  eq(afterPhase("sim", { settings: ON }).next, "tour");
  eq(afterPhase("tour", { settings: ON }).next, null);
});

test("nothing plays before the app is ready", () => {
  eq(firstPhase({ ready: false, onboarded: false, empty: true, settings: ON }), null);
});

test("a switched-off mode never starts, and the other one still does", () => {
  eq(firstPhase({ ready: true, onboarded: true, settings: { simulation: false, tutorial: true } }), "tour");
  eq(firstPhase({ ready: true, onboarded: true, settings: { simulation: true, tutorial: false } }), "sim");
  eq(firstPhase({ ready: true, onboarded: true, settings: {} }), null);
  eq(afterPhase("sim", { settings: { tutorial: false } }).next, null, "the tutorial ran anyway: ");
});

test("a half-filled sign-up is left alone, and so is a returning visit", () => {
  eq(firstPhase({ ready: true, onboarded: false, empty: false, settings: ON }), null);
  eq(firstPhase({ ready: true, onboarded: true, settings: { simulation: false, tutorial: false } }), null);
});

test("a mode that has played is spent, and so is one that was interrupted", () => {
  eq(afterPhase("sim", { settings: ON }).off, "simulation");
  eq(afterPhase("tour", { settings: ON }).off, "tutorial");
  eq(afterPhase("signup", { settings: ON }).off, null, "the sign-up spent the switch before the tour ran: ");
  eq(afterPhase("signup", { byHand: true, settings: ON }).off, "simulation");
  eq(afterPhase("sim", { byHand: true, settings: ON }), { next: null, off: "simulation" },
     "taking over led straight into the tutorial: ");
  eq(afterPhase("tour", { byHand: true, settings: ON }).off, "tutorial");
});

// ---- getting out of the way ------------------------------------------------
test("cancelling stops it mid-word and nothing more happens", () => {
  const clock = fakeClock();
  const b = fakeBrowser();
  const cancel = runReel(signUp(SARA), b.io, { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.step(6);                  // a few beats in, then a person takes over
  const clicksSoFar = b.clicked.length;
  cancel();
  clock.run();
  eq(b.clicked.length, clicksSoFar, "kept clicking after being cancelled: ");
  eq(b.ended, false, "ran to the end anyway: ");
  eq(String(b.form.name || "").length < SARA.name.length, true, "typed the whole name anyway: ");
});

test("cancelling twice is harmless", () => {
  const clock = fakeClock();
  const b = fakeBrowser();
  const cancel = runReel(simulation(), b.io, { rand: () => 0, timer: clock.timer, clear: clock.clear });
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
