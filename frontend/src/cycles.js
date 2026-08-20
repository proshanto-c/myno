/**
 * What a cycle is, in one place.
 *
 * Pure functions of the logs and a date — no React, no fetch, no clock unless
 * you pass one in. That is what makes them testable (see cycles.test.mjs), and
 * it is why "today" is always an argument with a default rather than a call to
 * Date.now() buried three levels down.
 *
 * The vocabulary, once:
 *   run    consecutive bleeding days — one period
 *   cycle  a run plus the days until the next run starts
 *   day    which day of the current cycle today is; the first bleeding day is 1
 */
export const DAY_MS = 86400000;

export const dayOf = (iso) => new Date(`${iso}T00:00:00`);
export const isoOf = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const todayISO = () => isoOf(new Date());
export const daysBetween = (a, b) => Math.round((dayOf(b) - dayOf(a)) / DAY_MS);

/** Consecutive bleeding days grouped into runs, oldest first.
 *  Days after `today` are dropped: a log dated tomorrow has not happened, so it
 *  cannot open the cycle you are in. Duplicates and unsorted input are fine. */
export function periodRuns(logs, today = todayISO()) {
  const dates = [...new Set((logs || [])
    .filter((l) => l && l.period && l.date && l.date <= today)
    .map((l) => l.date))].sort();
  const runs = [];
  for (const d of dates) {
    const run = runs[runs.length - 1];
    const prev = run && run[run.length - 1];
    if (prev && daysBetween(prev, d) === 1) run.push(d);
    else runs.push([d]);
  }
  return runs;
}

/** Each run with the cycle it opened. The last one is still running, so it
 *  carries how far in it is (today included) rather than a finished length. */
export function cyclesFrom(logs, today = todayISO()) {
  const runs = periodRuns(logs, today);
  return runs.map((run, i) => {
    const next = runs[i + 1];
    return {
      start: run[0],
      bleed: run.length,
      days: next ? daysBetween(run[0], next[0]) : daysBetween(run[0], today) + 1,
      open: !next,
    };
  });
}

/** The cycle in progress, or null if nothing has been logged. */
export function currentCycle(logs, today = todayISO()) {
  const all = cyclesFrom(logs, today);
  return all.length ? all[all.length - 1] : null;
}

/** Finished cycle lengths, oldest first. */
export function pastLengths(logs, today = todayISO()) {
  return cyclesFrom(logs, today).filter((c) => !c.open).map((c) => c.days);
}

/** How long this person's periods usually last: the median finished run, or 5
 *  days if there is nothing to go on. Used instead of the run in progress, so
 *  the phase boundaries don't lurch every time a bleeding day is added — one
 *  tapped day should not shrink the menstrual phase to a single day. */
export function typicalBleed(logs, today = todayISO()) {
  const runs = periodRuns(logs, today);
  const finished = runs.slice(0, -1).map((r) => r.length);
  const pool = finished.length ? finished : runs.map((r) => r.length);
  if (!pool.length) return 5;
  const sorted = [...pool].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export const PHASE_KEYS = ["menstrual", "follicular", "ovulatory", "luteal"];

/**
 * Where the four phases fall in a cycle of `cyc` days that bled for `bleed`.
 *
 * The luteal phase is the steady one — about 14 days — so ovulation is placed
 * that far back from the end and everything else follows. This is an estimate:
 * the app cannot see ovulation, and for an irregular cycle the estimate moves
 * with the length. Boundaries are half-open: day d belongs to the span with
 * a < d <= b, so day 1 is menstrual and day `cyc` is the last luteal day.
 */
export function phaseSpans(cyc, bleed = 5) {
  const len = Math.max(4, Math.round(cyc || 28));
  // A long bleed shouldn't swallow the cycle, and a missing one assumes 5 days.
  const bleedEnd = Math.max(1, Math.min(Math.round(bleed) || 5, Math.round(len * 0.3)));
  const ovuMid = Math.max(bleedEnd + 3, len - 14);
  const spans = [
    { key: "menstrual", a: 0, b: bleedEnd },
    { key: "follicular", a: bleedEnd, b: Math.max(bleedEnd, ovuMid - 2) },
    { key: "ovulatory", a: Math.max(bleedEnd, ovuMid - 2), b: Math.min(len, ovuMid + 2) },
    { key: "luteal", a: Math.min(len, ovuMid + 2), b: len },
  ];
  return spans.filter((p) => p.b > p.a);
}

/** Which phase day `day` falls in. A cycle that has run past its expected
 *  length stays in the last phase rather than wrapping to the start. */
export function phaseAt(day, cyc, bleed = 5) {
  if (day == null || !(day > 0)) return null;
  const spans = phaseSpans(cyc, bleed);
  return (spans.find((p) => day > p.a && day <= p.b) || spans[spans.length - 1]).key;
}

/** The length the ring is drawn against: their average, stretched if this cycle
 *  has already run past it so the marker never laps back to twelve o'clock. */
export function ringLength(day, avg) {
  return Math.max(Math.round(avg || 28), (day || 0) + 1);
}
