/**
 * The sign-up typing itself in.
 *
 *   docker run --rm -v "$PWD":/w -w /w node:20-alpine node demofill.test.mjs
 *
 * The clock is injected, so a nine-second animation is tested in no time at all
 * and without a single real timer.
 */
import { PEOPLE, autoFill, isEmpty, keystrokes, pick, TYPE_MS, FIELD_GAP_MS } from "./demofill.js";

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
    run(limit = 10000) {
      for (let i = 0; i < limit; i++) if (!this.step(1)) return;
      throw new Error("the animation never finished");
    },
  };
}

// ---- what gets typed -------------------------------------------------------
test("a person is typed one character at a time, field by field", () => {
  const person = { name: "Ada", age: 27, menarcheAge: 13, heightCm: 165, weightKg: 71 };
  eq(keystrokes(person, ["name", "age"]),
     [["name", "A"], ["name", "Ad"], ["name", "Ada"], ["age", "2"], ["age", "27"]]);
});

test("every person in the pool is plausible for the criteria that judge them", () => {
  for (const p of PEOPLE) {
    eq(typeof p.name === "string" && p.name.length > 1, true, `${p.name}: `);
    eq(p.age >= 16 && p.age <= 45, true, `${p.name} age ${p.age}: `);
    // menarche has to be before the age, or yearsPostMenarche goes negative
    eq(p.menarcheAge < p.age, true, `${p.name}: menarche after their age`);
    eq(p.age - p.menarcheAge >= 3, true, `${p.name}: inside the 1-3y band, which is not assessable`);
    eq(p.goals.length > 0, true, `${p.name}: no goal, so the first step cannot advance`);
  }
});

test("picking is stable when the randomness is", () => {
  eq(pick(() => 0).name, PEOPLE[0].name);
  eq(pick(() => 0.999).name, PEOPLE[PEOPLE.length - 1].name);
});

// ---- the animation ---------------------------------------------------------
test("it ends with the whole person in the form", () => {
  const clock = fakeClock();
  const form = {};
  const person = PEOPLE[0];
  autoFill(person, (k, v) => { form[k] = v; }, { rand: () => 0.5, timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(form.name, person.name);
  eq(form.age, String(person.age));
  eq(form.weightKg, String(person.weightKg));
});

test("it calls set once per character, not once per field", () => {
  const clock = fakeClock();
  let calls = 0;
  const person = PEOPLE[0];
  autoFill(person, () => { calls += 1; }, { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.run();
  eq(calls, keystrokes(person).length);
});

test("it finishes inside the length of a shot", () => {
  const clock = fakeClock();
  autoFill(PEOPLE[4], () => {}, { rand: () => 1, timer: clock.timer, clear: clock.clear });
  clock.run();
  // worst case: longest person, slowest jitter — still short enough to record
  eq(clock.now() < 9000, true, `took ${clock.now()}ms`);
});

test("there is a pause between fields and a quicker beat within one", () => {
  const clock = fakeClock();
  const at = [];
  autoFill({ name: "Al", age: 27 }, (k) => at.push([k, clock.now()]),
    { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.run();
  const withinName = at[1][1] - at[0][1];
  const betweenFields = at[2][1] - at[1][1];
  eq(withinName, TYPE_MS);
  eq(betweenFields, FIELD_GAP_MS);
  eq(betweenFields > withinName, true);
});

test("the finished callback carries the person, for the chips and goals", () => {
  const clock = fakeClock();
  let done = null;
  autoFill(PEOPLE[2], () => {}, { rand: () => 0, timer: clock.timer, clear: clock.clear,
    onDone: (who) => { done = who; } });
  clock.run();
  eq(done.name, PEOPLE[2].name);
  eq(done.chips.length > 0, true);
});

// ---- getting out of the way ------------------------------------------------
test("cancelling stops it mid-word and nothing more is typed", () => {
  const clock = fakeClock();
  const form = {};
  let calls = 0;
  const cancel = autoFill(PEOPLE[0], (k, v) => { form[k] = v; calls += 1; },
    { rand: () => 0, timer: clock.timer, clear: clock.clear });
  clock.step(3);        // three characters land, then a person starts typing
  const typedSoFar = calls;
  cancel();
  clock.run();
  eq(calls, typedSoFar, "kept typing after being cancelled: ");
  eq(form.name.length < PEOPLE[0].name.length + 1, true);
});

test("cancelling twice is harmless", () => {
  const clock = fakeClock();
  const cancel = autoFill(PEOPLE[0], () => {}, { rand: () => 0, timer: clock.timer, clear: clock.clear });
  cancel(); cancel();
  clock.run();
});

test("a form with anything in it is left alone", () => {
  eq(isEmpty({}), true);
  eq(isEmpty({ name: "", age: "" }), true);
  eq(isEmpty({ name: "Ada" }), false);
  eq(isEmpty({ name: " ", age: "27" }), false);
  eq(isEmpty({ name: "   " }), true, "whitespace is not an answer: ");
});

// ---- run it ----------------------------------------------------------------
let passed = 0, failed = 0;
for (const [name, fn] of T) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
