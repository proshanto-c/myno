/**
 * Exercises the cycle rules directly: no React, no network, no clock.
 *
 *   docker run --rm -v "$PWD":/w -w /w node:20-alpine node cycles.test.mjs
 *
 * Every case is written as dates a person could actually tap into the calendar.
 */
import {
  periodRuns, cyclesFrom, currentCycle, pastLengths,
  phaseSpans, phaseAt, ringLength, daysBetween, typicalBleed, addDays,
  cycleRuns, FREE_DAYS_END_PERIOD, UNLOGGED_TOLERANCE,
} from "./cycles.js";

const TODAY = "2026-08-20";
const log = (date) => ({ date, period: true });
const logs = (...dates) => dates.map(log);
// n consecutive bleeding days from `from`
const run = (from, n) => Array.from({ length: n }, (_, i) => log(addDays(from, i)));

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
     [{ start: "2026-08-14", bleed: 4, gapDays: 0, days: 7, open: true }]);
});

test("bleeding today is day 1, not day 0", () => {
  eq(currentCycle(logs(TODAY), TODAY).days, 1);
});

test("two runs give one finished cycle measured start to start", () => {
  const l = [...run("2026-07-01", 4), ...run("2026-08-01", 5)];
  eq(cyclesFrom(l, TODAY), [
    { start: "2026-07-01", bleed: 4, gapDays: 0, days: 31, open: false },
    { start: "2026-08-01", bleed: 5, gapDays: 0, days: 20, open: true },
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

// ---- one period, by Belsey and by what was actually written down --------
const free = (date) => ({ date, period: false });          // a recorded dry day

test("one recorded free day keeps the period open (Belsey)", () => {
  const l = [...run("2026-08-01", 2), free("2026-08-03"), ...run("2026-08-04", 2)];
  const cycles = cyclesFrom(l, TODAY);
  eq(cycles.length, 1);
  eq(cycles[0].bleed, 4);
});

test("two recorded free days end it (Belsey)", () => {
  const l = [...run("2026-08-01", 2), free("2026-08-03"), free("2026-08-04"), ...run("2026-08-05", 2)];
  eq(cyclesFrom(l, TODAY).length, 2);
  eq(pastLengths(l, TODAY), [4]);       // reported as the short cycle it is
});

test("days nobody logged are not evidence that bleeding stopped", () => {
  const l = [...run("2026-08-01", 2), ...run("2026-08-06", 2)];   // three silent days
  eq(cyclesFrom(l, TODAY).length, 1);
  eq(cyclesFrom(l, TODAY)[0].gapDays, 3);
});

test("but silence has a limit", () => {
  const l = [...run("2026-08-01", 2), ...run("2026-08-07", 2)];   // four silent days
  eq(cyclesFrom(l, TODAY).length, 2);
});

test("a recorded dry day counts even when other days are silent", () => {
  const one = [...run("2026-08-01", 2), free("2026-08-03"), ...run("2026-08-05", 2)];
  eq(cyclesFrom(one, TODAY).length, 1);
  const two = [...run("2026-08-01", 2), free("2026-08-03"), free("2026-08-05"), ...run("2026-08-06", 2)];
  eq(cyclesFrom(two, TODAY).length, 2);
});

test("bleeding a week later is a short cycle, not something to absorb", () => {
  const l = [...run("2026-08-01", 3), ...run("2026-08-10", 3)];
  eq(cyclesFrom(l, TODAY).length, 2);
  eq(pastLengths(l, TODAY), [9]);
});

test("the thresholds are what the comments claim", () => {
  eq(FREE_DAYS_END_PERIOD, 2);
  eq(UNLOGGED_TOLERANCE, 3);
});

test("cycle starts are the merged periods, not every run", () => {
  const l = [...run("2026-06-01", 4), ...run("2026-06-06", 1), ...run("2026-07-05", 4)];
  eq(cycleRuns(l, TODAY).map((c) => c.start), ["2026-06-01", "2026-07-05"]);
  eq(cycleRuns(l, TODAY)[0].bleed, 5);
});

// ---- typical bleed: why the phases must not follow the run in progress ----
test("the typical bleed is the median of finished periods", () => {
  const l = [...run("2026-05-01", 3), ...run("2026-06-01", 5), ...run("2026-07-01", 4), ...run("2026-08-14", 1)];
  eq(typicalBleed(l, TODAY), 4);
});

test("a period still in progress is a floor, not a length", () => {
  // one day tapped today: assume the usual five, not a one-day period
  eq(typicalBleed(logs(TODAY), TODAY), 5);
  eq(typicalBleed(run("2026-08-14", 6), TODAY), 6);   // already longer than five
  eq(typicalBleed([], TODAY), 5);
});

test("a first period ever logged still gets a full menstrual phase", () => {
  const cur = currentCycle(logs(TODAY), TODAY);
  const bleed = Math.max(cur.bleed, typicalBleed(logs(TODAY), TODAY));
  eq(phaseAt(1, 28, bleed), "menstrual");
  eq(phaseAt(3, 28, bleed), "menstrual");     // was follicular before
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

// ---- clocks: daylight saving, far-flung timezones, leap years ------------
// These run under whatever TZ the process was given; the runner sweeps several.
test("a run through a spring-forward night stays one run", () => {
  // 29 Mar 2026 is the European clock change; 8 Mar 2026 the American one
  eq(periodRuns(run("2026-03-28", 4), "2026-04-10")[0].length, 4);
  eq(periodRuns(run("2026-03-07", 4), "2026-04-10")[0].length, 4);
});

test("a run through a fall-back night stays one run", () => {
  eq(periodRuns(run("2026-10-24", 4), "2026-11-10")[0].length, 4);
  eq(periodRuns(run("2026-11-01", 3), "2026-11-10")[0].length, 3);
});

test("cycle length across a clock change is still whole days", () => {
  const l = [...run("2026-03-01", 3), ...run("2026-04-01", 3)];
  eq(pastLengths(l, "2026-04-20"), [31]);
  const back = [...run("2026-10-01", 3), ...run("2026-11-01", 3)];
  eq(pastLengths(back, "2026-11-20"), [31]);
});

test("a cycle spanning a leap day counts the extra day", () => {
  const l = [...run("2028-02-01", 3), ...run("2028-03-01", 3)];
  eq(pastLengths(l, "2028-03-20"), [29]);
});

test("a cycle spanning new year counts across it", () => {
  const l = [...run("2025-12-15", 3), ...run("2026-01-14", 3)];
  eq(pastLengths(l, "2026-02-01"), [30]);
});

test("today's own date is never excluded by the future filter", () => {
  eq(periodRuns(logs(TODAY), TODAY), [[TODAY]]);
});

// ---- rubbish in --------------------------------------------------------
test("malformed entries are skipped rather than thrown on", () => {
  const junk = [null, undefined, {}, { period: true }, { date: "", period: true },
                { date: "2026-08-14", period: true }];
  eq(periodRuns(junk, TODAY), [["2026-08-14"]]);
});

test("a cycle with no logs at all has no current cycle and no lengths", () => {
  eq(currentCycle([], TODAY), null);
  eq(pastLengths([], TODAY), []);
  eq(typicalBleed([], TODAY), 5);
});

test("phase maths survives nonsense lengths", () => {
  for (const cyc of [0, 1, 3, -5, NaN, null, undefined]) {
    const spans = phaseSpans(cyc, 4);
    eq(spans.length > 0, true, `cyc ${cyc}: `);
    eq(spans[0].a, 0, `cyc ${cyc}: `);
    eq(spans[spans.length - 1].b > 0, true, `cyc ${cyc}: `);
  }
});

test("phase maths survives nonsense bleeds", () => {
  for (const bleed of [0, -3, NaN, null, undefined, 999]) {
    const key = phaseAt(3, 28, bleed);
    eq(typeof key === "string", true, `bleed ${bleed}: `);
  }
});

test("ringLength copes with a missing day", () => {
  eq(ringLength(null, 30), 30);
  eq(ringLength(undefined, null), 28);
});

// ---- long silences -----------------------------------------------------
test("a year without a period is one very long open cycle", () => {
  const cur = currentCycle(run("2025-08-20", 4), TODAY);
  eq(cur.days, 366);        // 2026 is not a leap year; 2025-08-20 to 2026-08-20
  eq(cur.open, true);
});

test("a long silence stays in the last phase rather than wrapping", () => {
  const cur = currentCycle(run("2025-08-20", 4), TODAY);
  eq(phaseAt(cur.days, ringLength(cur.days, 30), 4), "luteal");
});

test("two periods a day apart are one run, not a one-day cycle", () => {
  eq(pastLengths(run("2026-08-01", 2), TODAY), []);
  eq(currentCycle(run("2026-08-01", 2), TODAY).bleed, 2);
});

test("back-to-back short cycles are still counted separately", () => {
  const l = [...run("2026-08-01", 2), ...run("2026-08-12", 2)];
  eq(pastLengths(l, TODAY), [11]);
});

// ---- scale --------------------------------------------------------------
test("five years of daily logs stay fast and correct", () => {
  const many = Array.from({ length: 1826 }, (_, i) => ({ date: addDays("2021-08-20", i), period: i % 30 < 4 }));
  const t0 = Date.now();
  const cycles = cyclesFrom(many, "2026-08-20");
  const ms = Date.now() - t0;
  eq(cycles.length, 61);
  eq(cycles.filter((c) => !c.open).every((c) => c.days === 30), true, "every gap is 30 days: ");
  eq(cycles.every((c) => c.gapDays === 0), true, "no run merged: ");
  eq(ms < 400, true, `took ${ms}ms: `);
});

test("adding days walks the calendar, not the millisecond count", () => {
  eq(addDays("2026-10-24", 1), "2026-10-25");     // 25-hour night in Europe
  eq(addDays("2026-10-25", 1), "2026-10-26");
  eq(addDays("2026-03-29", 1), "2026-03-30");     // 23-hour night
  eq(addDays("2026-02-28", 1), "2026-03-01");     // not a leap year
  eq(addDays("2028-02-28", 1), "2028-02-29");     // leap year
  eq(addDays("2026-12-31", 1), "2027-01-01");
  eq(addDays("2026-01-01", -1), "2025-12-31");
  eq(addDays("2026-08-20", 0), "2026-08-20");
});

test("a month of consecutive days built with addDays is one unbroken run", () => {
  eq(periodRuns(run("2026-10-20", 20), "2026-11-30")[0].length, 20);
  eq(periodRuns(run("2026-03-25", 10), "2026-04-30")[0].length, 10);
});

// ---- run it ---------------------------------------------------------------
let passed = 0, failed = 0;
for (const [name, fn] of T) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
