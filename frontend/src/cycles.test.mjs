/**
 * Exercises the cycle rules directly: no React, no network, no clock.
 *
 *   docker run --rm -v "$PWD":/w -w /w node:20-alpine node cycles.test.mjs
 *
 * Every case is written as dates a person could actually tap into the calendar.
 */
import {
  periodRuns, cyclesFrom, currentCycle, pastLengths,
  phaseSpans, phaseAt, ringLength, daysBetween, typicalBleed,
} from "./cycles.js";

const TODAY = "2026-08-20";
const log = (date) => ({ date, period: true });
const logs = (...dates) => dates.map(log);
// n consecutive bleeding days from `from`
const run = (from, n) => {
  const out = [];
  const d = new Date(`${from}T00:00:00`);
  for (let i = 0; i < n; i++) {
    const x = new Date(d.getTime() + i * 86400000);
    out.push(log(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`));
  }
  return out;
};

const T = [];
const test = (name, fn) => T.push([name, fn]);
const eq = (got, want, msg = "") => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`${msg}expected ${b}, got ${a}`);
};

// ---- runs: what one period is --------------------------------------------
test("a single tapped day is one run", () => {
  eq(periodRuns(logs("2026-08-14"), TODAY), [["2026-08-14"]]);
});

test("consecutive days are one run, not several", () => {
  eq(periodRuns(run("2026-08-14", 4), TODAY), [["2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17"]]);
});

test("a one-day gap splits the run", () => {
  eq(periodRuns(logs("2026-08-14", "2026-08-16"), TODAY), [["2026-08-14"], ["2026-08-16"]]);
});

test("runs come back oldest first however the logs arrive", () => {
  eq(periodRuns(logs("2026-08-16", "2026-07-01", "2026-08-15"), TODAY),
     [["2026-07-01"], ["2026-08-15", "2026-08-16"]]);
});

test("the same day logged twice is still one day", () => {
  eq(periodRuns(logs("2026-08-14", "2026-08-14"), TODAY), [["2026-08-14"]]);
});

test("a run crossing a month boundary stays one run", () => {
  eq(periodRuns(run("2026-07-30", 4), TODAY).length, 1);
});

test("a run crossing a year boundary stays one run", () => {
  eq(periodRuns(run("2025-12-30", 4), "2026-01-05").length, 1);
});

test("a run across a leap day stays one run", () => {
  eq(periodRuns(run("2028-02-28", 3), "2028-03-05")[0],
     ["2028-02-28", "2028-02-29", "2028-03-01"]);
});

test("days after today are ignored", () => {
  eq(periodRuns(logs("2026-08-14", "2026-09-01"), TODAY), [["2026-08-14"]]);
});

test("logs without period are not runs", () => {
  eq(periodRuns([{ date: "2026-08-14", period: false }, { date: "2026-08-15" }], TODAY), []);
});

test("no logs, no runs", () => {
  eq(periodRuns([], TODAY), []);
  eq(periodRuns(null, TODAY), []);
});

// ---- cycles: runs plus the gap between them -------------------------------
test("one run is one open cycle counting from its first day", () => {
  eq(cyclesFrom(run("2026-08-14", 4), TODAY),
     [{ start: "2026-08-14", bleed: 4, days: 7, open: true }]);
});

test("bleeding today is day 1, not day 0", () => {
  eq(currentCycle(logs(TODAY), TODAY).days, 1);
});

test("two runs give one finished cycle measured start to start", () => {
  const l = [...run("2026-07-01", 4), ...run("2026-08-01", 5)];
  eq(cyclesFrom(l, TODAY), [
    { start: "2026-07-01", bleed: 4, days: 31, open: false },
    { start: "2026-08-01", bleed: 5, days: 20, open: true },
  ]);
});

test("cycle length is start to start, not end to start", () => {
  const l = [...run("2026-07-01", 7), ...run("2026-08-01", 2)];
  eq(pastLengths(l, TODAY), [31]);
});

test("finished lengths exclude the cycle still running", () => {
  const l = [...run("2026-05-01", 4), ...run("2026-06-01", 4), ...run("2026-07-05", 4)];
  eq(pastLengths(l, TODAY), [31, 34]);
});

test("a period logged only in the future leaves no current cycle", () => {
  eq(currentCycle(logs("2026-09-01"), TODAY), null);
});

// ---- phases: the spans ----------------------------------------------------
test("the four phases tile the cycle with no gaps or overlaps", () => {
  for (const cyc of [21, 24, 28, 31, 35, 41, 60]) {
    for (const bleed of [1, 3, 5, 8]) {
      const spans = phaseSpans(cyc, bleed);
      eq(spans[0].a, 0, `cyc ${cyc} bleed ${bleed}: `);
      eq(spans[spans.length - 1].b, cyc, `cyc ${cyc} bleed ${bleed}: `);
      for (let i = 1; i < spans.length; i++) {
        eq(spans[i].a, spans[i - 1].b, `cyc ${cyc} bleed ${bleed}: span ${i} `);
      }
    }
  }
});

test("every day of every cycle length lands in exactly one phase", () => {
  for (let cyc = 15; cyc <= 60; cyc++) {
    for (const bleed of [1, 2, 4, 6, 10]) {
      for (let day = 1; day <= cyc; day++) {
        const spans = phaseSpans(cyc, bleed);
        const hits = spans.filter((p) => day > p.a && day <= p.b);
        eq(hits.length, 1, `cyc ${cyc} bleed ${bleed} day ${day}: `);
      }
    }
  }
});

test("bleeding days are the menstrual phase", () => {
  for (const bleed of [1, 3, 5, 7]) {
    for (let day = 1; day <= bleed; day++) {
      eq(phaseAt(day, 28, bleed), "menstrual", `bleed ${bleed} day ${day}: `);
    }
  }
});

test("the day after bleeding stops is follicular", () => {
  eq(phaseAt(5, 28, 4), "follicular");
  eq(phaseAt(2, 28, 1), "follicular");
});

test("ovulation sits about fourteen days before the end, wherever the end is", () => {
  eq(phaseAt(14, 28, 4), "ovulatory");     // 28-day cycle: mid at 14
  eq(phaseAt(21, 35, 4), "ovulatory");     // 35-day cycle: mid at 21
  eq(phaseAt(12, 26, 4), "ovulatory");     // 26-day cycle: mid at 12
});

test("the last stretch of the cycle is luteal", () => {
  for (const cyc of [24, 28, 32, 41]) {
    eq(phaseAt(cyc, cyc, 4), "luteal", `cyc ${cyc}: `);
    eq(phaseAt(cyc - 1, cyc, 4), "luteal", `cyc ${cyc}: `);
  }
});

test("a cycle running past its length stays luteal instead of wrapping", () => {
  eq(phaseAt(46, ringLength(46, 31), 4), "luteal");
  eq(phaseAt(90, ringLength(90, 28), 4), "luteal");
});

test("a long bleed cannot swallow the whole cycle", () => {
  // 14 bleeding days logged in a 24-day cycle: menstrual is capped at 30%
  const spans = phaseSpans(24, 14);
  eq(spans[0].b <= Math.round(24 * 0.3), true, "menstrual capped: ");
  eq(phaseAt(12, 24, 14) !== "menstrual", true, "day 12 is past the cap: ");
});

test("a short cycle still has all four phases", () => {
  eq(phaseSpans(21, 4).map((p) => p.key), ["menstrual", "follicular", "ovulatory", "luteal"]);
});

test("phase is null before anything is logged", () => {
  eq(phaseAt(null, 28, 4), null);
  eq(phaseAt(0, 28, 4), null);
});

// ---- the complaint: is it always follicular? ------------------------------
test("a 28-day cycle passes through all four phases across its days", () => {
  const seen = new Set();
  for (let day = 1; day <= 28; day++) seen.add(phaseAt(day, 28, 4));
  eq([...seen].sort(), ["follicular", "luteal", "menstrual", "ovulatory"]);
});

test("no phase swallows more than half of a normal cycle", () => {
  for (const cyc of [24, 28, 32, 35]) {
    const counts = {};
    for (let day = 1; day <= cyc; day++) counts[phaseAt(day, cyc, 4)] = (counts[phaseAt(day, cyc, 4)] || 0) + 1;
    for (const [key, n] of Object.entries(counts)) {
      eq(n <= cyc / 2, true, `cyc ${cyc}: ${key} covers ${n}/${cyc} days — `);
    }
  }
});

test("tapping one day, then checking each following day, walks the phases", () => {
  // one day logged, then a week of no logs: the phase must move on
  const start = "2026-08-01";
  const got = [];
  for (const today of ["2026-08-01", "2026-08-03", "2026-08-10", "2026-08-19", "2026-08-28"]) {
    const cur = currentCycle(logs(start), today);
    got.push(phaseAt(cur.days, ringLength(cur.days, 28), cur.bleed));
  }
  // day 19 of a 28-day cycle is already luteal — ovulation is placed at 14
  eq(got, ["menstrual", "follicular", "follicular", "luteal", "luteal"]);
});

test("marking today as a period day puts you back in menstrual", () => {
  const cur = currentCycle([...run("2026-07-20", 4), log(TODAY)], TODAY);
  eq(cur.days, 1);
  eq(phaseAt(cur.days, ringLength(cur.days, 28), cur.bleed), "menstrual");
});

// ---- typical bleed: why the phases must not follow the run in progress ----
test("the typical bleed is the median of finished periods", () => {
  const l = [...run("2026-05-01", 3), ...run("2026-06-01", 5), ...run("2026-07-01", 4), ...run("2026-08-14", 1)];
  eq(typicalBleed(l, TODAY), 4);
});

test("with nothing finished it uses what there is, then falls back to five", () => {
  eq(typicalBleed(run("2026-08-14", 6), TODAY), 6);
  eq(typicalBleed([], TODAY), 5);
});

test("one tapped day does not shrink the menstrual phase to a single day", () => {
  // four cycles of 4-day bleeds, then today's single tap
  const history = [...run("2026-05-01", 4), ...run("2026-06-01", 4), ...run("2026-07-01", 4)];
  const withTap = [...history, log("2026-08-18")];
  const typical = typicalBleed(withTap, TODAY);
  eq(typical, 4);
  // day 3 of the new cycle is still menstrual, because they usually bleed 4 days
  eq(phaseAt(3, 28, typical), "menstrual");
  // taking the run in progress instead would have called it follicular
  eq(phaseAt(3, 28, 1), "follicular");
});

// ---- the ring's scale -----------------------------------------------------
test("the ring uses the average until the cycle outgrows it", () => {
  eq(ringLength(7, 31), 31);
  eq(ringLength(31, 31), 32);
  eq(ringLength(46, 31), 47);
});

test("the ring falls back to 28 days with no average", () => {
  eq(ringLength(7, null), 28);
  eq(ringLength(7, 0), 28);
});

test("the marker never laps: today is always inside the ring", () => {
  for (const [day, avg] of [[1, 28], [28, 28], [46, 31], [120, 26], [7, null]]) {
    eq(day < ringLength(day, avg), true, `day ${day} avg ${avg}: `);
  }
});

// ---- run it ---------------------------------------------------------------
let passed = 0, failed = 0;
for (const [name, fn] of T) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
