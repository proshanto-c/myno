/**
 * The sign-up filling itself in.
 *
 * For recording: the fields type themselves, character by character, so a
 * demo does not need a hand on the keyboard. It is not a fake — every value
 * goes through the same setProfile the keyboard would, so the profile that
 * comes out the other side is a real one.
 *
 * Two rules keep it out of a real person's way:
 *   - it only starts on an empty form
 *   - the first real keystroke cancels it and it never comes back
 *
 * Pure enough to test: the clock and the randomness are both arguments.
 */

// Plausible people. Ages and cycle histories sit inside the bands criteria.py
// actually judges, so a demo shows the app working rather than shrugging.
export const PEOPLE = [
  { name: "Amara",  age: 27, menarcheAge: 13, heightCm: 165, weightKg: 71,
    goals: ["whatswrong"], chips: ["familyHistory", "acne"] },
  { name: "Sofia",  age: 31, menarcheAge: 12, heightCm: 170, weightKg: 78,
    goals: ["conceive"],   chips: ["weightGain"] },
  { name: "Priya",  age: 24, menarcheAge: 14, heightCm: 158, weightKg: 64,
    goals: ["manage"],     chips: ["acne", "skinDarkening"] },
  { name: "Noor",   age: 19, menarcheAge: 15, heightCm: 162, weightKg: 59,
    goals: ["whatswrong"], chips: ["familyHistory"] },
  { name: "Elena",  age: 34, menarcheAge: 11, heightCm: 173, weightKg: 83,
    goals: ["prepare"],    chips: ["weightGain", "familyHistory"] },
];

/** Typing feels human when it is uneven; a fixed interval reads as a machine. */
export const TYPE_MS = 55;
export const JITTER_MS = 45;
export const FIELD_GAP_MS = 320;

export const pick = (rand = Math.random) => PEOPLE[Math.floor(rand() * PEOPLE.length)];

/** The keystrokes for one person, in order: [field, valueSoFar] pairs. */
export function keystrokes(person, fields = ["name", "age", "menarcheAge", "heightCm", "weightKg"]) {
  const out = [];
  for (const field of fields) {
    const full = String(person[field] ?? "");
    for (let i = 1; i <= full.length; i++) out.push([field, full.slice(0, i)]);
  }
  return out;
}

/**
 * Types `person` into the form. Returns a cancel function.
 *
 * `set(field, value)` is called once per character — the same call a keypress
 * makes — so nothing downstream can tell the difference.
 */
export function autoFill(person, set, { onDone, rand = Math.random,
                                        timer = setTimeout, clear = clearTimeout } = {}) {
  const steps = keystrokes(person);
  let index = 0, handle = null, stopped = false;

  const next = () => {
    if (stopped || index >= steps.length) {
      if (!stopped) onDone?.(person);
      return;
    }
    const [field, value] = steps[index];
    index += 1;
    set(field, value);
    // The pause belongs before the NEXT character, so it has to look forward:
    // comparing with the previous field puts the beat one keystroke late, at
    // the start of the new box rather than between the two.
    const upcoming = steps[index] ? steps[index][0] : null;
    const gap = upcoming && upcoming !== field ? FIELD_GAP_MS : TYPE_MS + rand() * JITTER_MS;
    handle = timer(next, gap);
  };

  handle = timer(next, FIELD_GAP_MS);
  return () => { stopped = true; clear(handle); };
}

/** Nothing typed yet — a form with anything in it is a person's, not ours. */
export const isEmpty = (profile, fields = ["name", "age", "menarcheAge", "heightCm", "weightKg"]) =>
  fields.every((f) => !String(profile?.[f] ?? "").trim());
