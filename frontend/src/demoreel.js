/**
 * Tawaazun showing itself.
 *
 * Three reels, in the order a first visit meets them:
 *
 *   signUp()    the sign-up signing itself up — a pointer walks on, picks the
 *               goal, types Sara into the boxes and lets itself in.
 *   showcase()  the app shown off: Haaniyah drives it and explains it in the
 *               same pass, in English, with whatever she is talking about lit
 *               up and hovered under the pointer while she says it.
 *
 * None of it is a mock-up. Every beat ends in a real click, a real input event
 * or a real key on the real control, so what the screen does is what a person
 * doing the same thing would get, all the way down to the backend.
 *
 * Three rules keep it out of a real person's way:
 *   - the sign-up reel only starts on an empty form
 *   - it can be switched off in Settings, and switches itself off when it
 *     reaches the end, so nothing ever hijacks a second visit
 *   - the first real click, tap or keystroke ends the reel that is running
 *
 * A reel is a flat list of beats and a runner that walks it. Both are pure —
 * the clock, the randomness, the voice and everything that touches the DOM are
 * arguments — so minutes of animation are tested in no time at all, and without
 * a single real timer, element or utterance. See demoreel.test.mjs.
 */

/** Sara. Her numbers sit inside the bands criteria.py actually judges, so the
 *  reel ends on an app with something to say rather than a shrug. */
export const SARA = {
  name: "Sara", age: 28, menarcheAge: 13, heightCm: 166, weightKg: 74,
  goals: ["whatswrong"],                    // she is here to find out what is wrong
  chips: ["familyHistory", "acne"],
  diagnosis: "unsure",                      // ... so "Not sure" is the honest answer
  conditions: [],
};

/** The basics step, in the order the boxes are laid out. */
export const FIELDS = ["name", "age", "menarcheAge", "heightCm", "weightKg"];

/**
 * Pace. This is an advert, not a manual: the hand moves at the speed of someone
 * who already knows where everything is, and never waits on a screen it has
 * finished with. Typing stays uneven, because an even one reads as a machine.
 */
export const TYPE_MS = 34;
export const JITTER_MS = 26;
export const FIELD_GAP_MS = 200;
export const PRESS_MS = 150;      // the click itself, and the ring it leaves
export const BEAT_MS = 200;       // after a click, before moving off
export const STEP_MS = 420;       // a new step needs a moment before it is worked
export const OPEN_MS = 700;       // ... and the first screen needs longer
export const SCROLL_MS = 300;     // a smooth scroll, settling
export const SCREEN_MS = 550;     // a whole screen changing under the pointer

/** How long the pointer takes to cross a gap: a floor so short hops still read
 *  as movement, a ceiling so a long one never turns into a wait. */
export const TRAVEL_MIN = 190;
export const TRAVEL_MAX = 600;
export const TRAVEL_PER_PX = 0.40;
export const travelMs = (dx, dy) => {
  const d = Math.hypot(dx, dy);
  return Math.round(Math.min(TRAVEL_MAX, TRAVEL_MIN + d * TRAVEL_PER_PX));
};

/** How long a line takes to say. Neither voice will tell us in advance, so the
 *  reel budgets for it: 420ms a word is what the cloned voice actually runs at,
 *  floored so a short line still lands and capped so a long one cannot strand
 *  the pointer. Captions are on screen for exactly the same stretch. */
export const SAY_PER_WORD_MS = 420;
export const SAY_MIN_MS = 1100;
export const SAY_MAX_MS = 9000;
export const sayMs = (text) => {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.round(Math.min(SAY_MAX_MS, Math.max(SAY_MIN_MS, 250 + words * SAY_PER_WORD_MS)));
};

/**
 * A line, split the way it is spoken: one sentence per request, so the first
 * words start while the rest are still being made. The backend caches what it
 * has said before, keyed on the exact text — which is why this split has to be
 * the same everywhere. scripts/warm-voice.sh fills that cache from here, and a
 * different split would miss every key.
 */
export const sentences = (text) =>
  (String(text ?? "").match(/[^.!?]+[.!?]*\s*/g) || [String(text ?? "")])
    .map((x) => x.trim()).filter(Boolean);

/** Every line the reels say, in order, deduplicated — what there is to warm. */
export function spokenLines(person = SARA) {
  const seen = new Set();
  for (const list of [signUp(person), showcase()])
    for (const b of list)
      if ((b.do === "say" || b.do === "spot") && b.text)
        for (const one of sentences(b.text)) seen.add(one);
  return [...seen];
}

/** The keystrokes for one person, in order: [field, valueSoFar] pairs. */
export function keystrokes(person, fields = FIELDS) {
  const out = [];
  for (const field of fields) {
    const full = String(person[field] ?? "");
    for (let i = 1; i <= full.length; i++) out.push([field, full.slice(0, i)]);
  }
  return out;
}

/**
 * A reel, written the way it reads.
 *
 *   reveal — scroll the target into view, if it isn't
 *   move   — take the pointer to it
 *   press  — click it
 *   key    — put a value in the box under the pointer (one character, or a
 *            slider's new position)
 *   enter  — the return key, for a box that submits on it
 *   say    — speak a line, and hold until it has been said
 *   over   — speak a line and carry on moving while it is said
 *   spot   — light the target up and explain it
 *   dim    — put the lights back
 *   wait   — let the screen be read
 *
 * Targets are `data-demo` names, resolved when the beat plays rather than when
 * it is written: most of them belong to screens that do not exist yet.
 */
function reel() {
  const beats = [];
  const api = {
    beats,
    wait: (ms) => (beats.push({ do: "wait", ms }), api),
    say: (text) => (beats.push({ do: "say", text }), api),
    /** narration that runs underneath the next few beats instead of stopping them */
    over: (text) => (beats.push({ do: "say", text, hold: false }), api),
    to: (target) => (beats.push({ do: "reveal", target }, { do: "move", target }), api),
    tap: (target) => (api.to(target), beats.push({ do: "press", target }, { do: "wait", ms: BEAT_MS }), api),
    /** a whole screen arrives after this one, so give it time to */
    open: (target) => (api.tap(target), beats.push({ do: "wait", ms: SCREEN_MS }), api),
    write: (target, value) => {
      api.to(target);
      beats.push({ do: "press", target });        // a box has to be clicked before it is typed into
      const full = String(value);
      for (let i = 1; i <= full.length; i++) beats.push({ do: "key", target, value: full.slice(0, i) });
      beats.push({ do: "wait", ms: FIELD_GAP_MS });
      return api;
    },
    /** one value straight in — a slider's position, not a typed word */
    set: (target, value) => (api.to(target), beats.push({ do: "key", target, value: String(value) },
                                                       { do: "wait", ms: BEAT_MS }), api),
    enter: (target) => (beats.push({ do: "enter", target }, { do: "wait", ms: BEAT_MS }), api),
    spot: (target, text) => (api.to(target), beats.push({ do: "spot", target, text }), api),
    dim: () => (beats.push({ do: "dim" }), api),
  };
  return api;
}

/**
 * THE SIGN-UP, SIGNING ITSELF UP.
 *
 * Haaniyah hosts all three reels. She is a person showing you round Tawaazun,
 * not the app talking about itself, and she talks the way someone does when
 * they like the thing they are showing you: short sentences, no manual.
 */
export function signUp(person = SARA) {
  const s = reel();
  s.wait(OPEN_MS);
  s.over(`Hi, I'm Haaniyah. Welcome to Tawaazun — I'll sign ${person.name} up, so you can see how quick it is.`);
  for (const g of person.goals) s.tap(`goal:${g}`);
  s.over("First, what brings you here.");
  s.tap("next").wait(STEP_MS);

  s.over("Then the basics. Every one of them feeds a rule a clinician would use.");
  for (const f of FIELDS) s.write(`field:${f}`, person[f]);
  for (const c of person.chips) s.tap(`chip:${c}`);
  s.tap("next").wait(STEP_MS);

  s.over("And anything a clinician has already told you.");
  s.tap(`dx:${person.diagnosis}`);
  for (const c of person.conditions || []) s.tap(`cond:${c}`);
  s.say("That's it. Three screens, and nothing to buy.");
  s.tap("next");
  return s.beats;
}

/**
 * THE SHOWCASE — the highlights, at the speed of an advert.
 *
 * One reel, not two: Haaniyah drives the app and explains it in the same pass,
 * so the thing she is talking about is lit up under her pointer while she says
 * it. Not every feature either — the four moments that make someone want this:
 * a period marked in one tap, a day recorded by talking, a history read back,
 * and the hair-growth sheet settling a criterion that usually costs a blood
 * test. Everything it changes, it changes back.
 */
export function showcase() {
  const s = reel();
  s.wait(SCREEN_MS);
  s.over("Hi, I'm Haaniyah. Welcome to Tawaazun — here are the good bits.");

  // HOME — one tap, and everything catches up
  s.open("nav:home");
  s.spot("cal:grid", "This is your cycle, as you actually live it.");
  s.tap("cal:today");
  s.over("A period is one tap.");
  s.spot("home:ring", "The ring, your phase, the date it expects next — all of it catches up.");
  s.tap("cal:today");
  s.dim();

  // RECORD — you talk, it writes
  s.open("go:record");
  s.spot("rec:mic", "Then you just talk about your day.");
  s.write("rec:type", "Bad cramps today and I barely slept");
  s.enter("rec:type");
  s.over("It listens, answers, and fills the tracker in as you talk.");
  s.wait(3500);                            // its own voice, over the top of nobody
  s.spot("rec:tracker", "In your words. Not somebody else's list of symptoms.");
  s.dim();

  // INSIGHTS — the patterns nobody has time to find
  s.open("nav:insights");
  s.spot("ins:summary", "And it reads your history back — the patterns nobody has time to find.");
  s.dim();

  // SETTINGS — what it will and won't ask, and the one that settles a criterion
  s.open("nav:settings");
  s.spot("set:block", "Anything you'd rather it never asked about, switch off here.");
  s.over("A clinician already found something? It goes in here.");
  s.tap("cond:hirsutism");
  s.tap("fg:chin:3").tap("fg:upperLip:2");
  s.say("Score the hair-growth sheet, and a criterion is settled — no blood test.");

  // ADVOCACY — the payoff
  s.open("go:advocacy");
  s.spot("adv:triad", "And this is what you take to the appointment, with the words for it.");
  s.dim();

  // ... and back exactly as it was
  s.open("nav:settings");
  s.over("Off as easily as on.");
  s.tap("fg:chin:3").tap("fg:upperLip:2").tap("cond:hirsutism");
  s.spot("set:guide", "That's my off switch, whenever you like.");
  s.dim();
  s.say("Tawaazun. It's yours.");
  return s.beats;
}

/**
 * WHICH REEL IS DUE, AND WHAT IT LEAVES BEHIND.
 *
 * The order is fixed — sign up, be shown around, be taught the interface — but
 * each mode is its own switch, so any of them can be missing. Two rules decide
 * everything else:
 *
 *   a mode that has played is switched off, so a second visit is the person's;
 *   a mode that was interrupted is switched off too, because taking the mouse
 *   back is how someone says they would rather do it themselves.
 *
 * The sign-up and the simulation share the simulation switch: somebody who does
 * not want to be shown around does not want their sign-up filled in either.
 */
export function firstPhase({ ready, onboarded, empty, settings = {} }) {
  if (!ready || !settings.guide) return null;
  if (!onboarded) return empty ? "signup" : null;    // a half-filled form is theirs
  return "show";
}

/** What happens when a reel stops: which one is next, and whether it is spent. */
export function afterPhase(phase, { byHand = false } = {}) {
  if (phase === "show") return { next: null, off: "guide" };
  if (phase === "signup") return byHand ? { next: null, off: "guide" } : { next: "show", off: null };
  return { next: null, off: null };
}

/**
 * Walks the beats, one timer at a time. Returns a cancel function.
 *
 * `io` does everything the browser part of this owns:
 *   reveal(target) → ms to settle      move(target) → ms of travel
 *   press(target)                      key(target, value)
 *   enter(target)                      say(text) → ms it will take
 *   spot(target, text) → ms            dim()
 *   end()
 *
 * A beat that cannot find its element costs a beat and the reel carries on — a
 * screen that changed under it should not strand the pointer for good.
 */
export function runReel(list, io, { timer = setTimeout, clear = clearTimeout, rand = Math.random } = {}) {
  let index = 0, handle = null, stopped = false;

  const beat = () => {
    if (stopped) return;
    if (index >= list.length) { io.end?.(); return; }
    const b = list[index];
    index += 1;
    let gap = 0;
    if (b.do === "wait") gap = b.ms;
    else if (b.do === "reveal") gap = io.reveal?.(b.target) || 0;
    else if (b.do === "move") gap = io.move?.(b.target) || 0;
    else if (b.do === "press") { io.press?.(b.target); gap = PRESS_MS; }
    else if (b.do === "key") { io.key?.(b.target, b.value); gap = TYPE_MS + rand() * JITTER_MS; }
    else if (b.do === "enter") { io.enter?.(b.target); gap = PRESS_MS; }
    else if (b.do === "say") { const ms = io.say?.(b.text) ?? sayMs(b.text); gap = b.hold === false ? BEAT_MS : ms; }
    else if (b.do === "spot") gap = io.spot?.(b.target, b.text) ?? sayMs(b.text);
    else if (b.do === "dim") { io.dim?.(); gap = BEAT_MS; }
    handle = timer(beat, gap);
  };

  handle = timer(beat, 0);
  return () => { stopped = true; clear(handle); };
}

/** Nothing typed yet — a form with anything in it is a person's, not ours. */
export const isEmpty = (profile, fields = FIELDS) =>
  fields.every((f) => !String(profile?.[f] ?? "").trim())
  && !(profile?.goals || []).length;
