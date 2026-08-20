/**
 * Tawaazun showing itself.
 *
 * Three reels, in the order a first visit meets them:
 *
 *   signUp()      the sign-up signing itself up — a pointer walks on, picks the
 *                 goal, types Sara into the boxes and lets itself in.
 *   simulation()  the app demonstrating every tab: it speaks in English, moves
 *                 the pointer, taps, types, and goes where it says it is going.
 *   tutorial()    the quieter one that follows: nothing is changed, each part of
 *                 the interface is lit up in turn and explained.
 *
 * None of it is a mock-up. Every beat ends in a real click, a real input event
 * or a real key on the real control, so what the screen does is what a person
 * doing the same thing would get, all the way down to the backend.
 *
 * Three rules keep it out of a real person's way:
 *   - the sign-up reel only starts on an empty form
 *   - either mode can be switched off in Settings, and switches itself off when
 *     it reaches the end, so nothing ever hijacks a second visit
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

/** Typing feels human when it is uneven; a fixed interval reads as a machine. */
export const TYPE_MS = 55;
export const JITTER_MS = 45;
export const FIELD_GAP_MS = 320;
export const PRESS_MS = 190;      // the click itself, and the ring it leaves
export const BEAT_MS = 300;       // after a click, before moving off
export const STEP_MS = 700;       // a new step needs a moment before it is worked
export const OPEN_MS = 900;       // ... and the first screen needs longer
export const SCROLL_MS = 420;     // a smooth scroll, settling
export const SCREEN_MS = 900;     // a whole screen changing under the pointer

/** How long the pointer takes to cross a gap: a floor so short hops still read
 *  as movement, a ceiling so a long one never turns into a wait. */
export const TRAVEL_MIN = 260;
export const TRAVEL_MAX = 820;
export const TRAVEL_PER_PX = 0.55;
export const travelMs = (dx, dy) => {
  const d = Math.hypot(dx, dy);
  return Math.round(Math.min(TRAVEL_MAX, TRAVEL_MIN + d * TRAVEL_PER_PX));
};

/** How long a line takes to say. The voice is the browser's or the backend's
 *  and neither will tell us in advance, so the reel budgets for it: roughly
 *  reading pace, floored so a short line still lands and capped so a long one
 *  cannot strand the pointer. Captions are on screen for the same stretch. */
export const SAY_PER_WORD_MS = 360;
export const SAY_MIN_MS = 1500;
export const SAY_MAX_MS = 15000;
export const sayMs = (text) => {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.round(Math.min(SAY_MAX_MS, Math.max(SAY_MIN_MS, 500 + words * SAY_PER_WORD_MS)));
};

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
 * The sign-up, signing itself up — and talking while it does.
 *
 * The narration is deliberately about the questions rather than about the
 * demo: what the form is asking for and why it is asked, so a recording of
 * this stands on its own as an explanation of the sign-up.
 */
export function signUp(person = SARA) {
  const s = reel();
  s.wait(OPEN_MS);                                        // welcome
  s.over(`Hello. I'm Tawaazun. Let me set this up — I'll sign ${person.name} up while I explain it.`);
  for (const g of person.goals) s.tap(`goal:${g}`);
  s.say("What you're here for changes what the app leads with, and you can pick more than one.");
  s.tap("next").wait(STEP_MS);

  s.over("Then the basics: your age, when your periods started, and your height and weight. Every one of them feeds a rule a clinician would use.");
  for (const f of FIELDS) s.write(`field:${f}`, person[f]); // the basics
  for (const c of person.chips) s.tap(`chip:${c}`);
  s.say("Family history, acne, weight changes — the things people mention only when asked.");
  s.tap("next").wait(STEP_MS);

  s.over("If a clinician has already told you what this is, it goes here. Sara isn't sure yet — most people aren't.");
  s.tap(`dx:${person.diagnosis}`);                        // anything already diagnosed?
  for (const c of person.conditions || []) s.tap(`cond:${c}`);
  s.wait(BEAT_MS);
  s.say("That's the whole sign-up — three screens, and none of them asked for a device. Let's go in.");
  s.tap("next");                                          // ... and in
  return s.beats;
}

/**
 * SIMULATION — the app demonstrating itself, tab by tab.
 *
 * It says what it is about to do, then does it: taps the calendar, holds a
 * conversation on the Record screen by typing into it, opens the charts, bends
 * the criteria in the lab, blocks a topic and unblocks it. Everything it
 * changes, it changes back, so it hands over a screen nobody has to tidy up.
 */
export function simulation() {
  const s = reel();
  s.wait(SCREEN_MS);
  s.say("This is Tawaazun. I'll show you around — you don't have to touch anything.");

  // HOME — where am I in my cycle?
  s.open("nav:home");
  s.over("Home answers one question: where am I right now?");
  s.to("home:ring").wait(1400);
  s.say("The ring is built from your own averages, not a stock twenty-eight days. The phase is an estimate, and it says so underneath.");
  s.over("Marking a period is one tap.");
  s.tap("cal:today").wait(900);
  s.say("That day is a period day now, and the ring, the calendar and the next date all recalculate from it.");
  s.tap("cal:today");
  s.over("Tap it again and it's gone. Range marks a whole bleed in two taps instead.");
  s.tap("cal:range").wait(900).tap("cal:range");
  s.to("home:next").wait(600);
  s.say("When the next period is likely comes from the gaps between your own bleeds, so it sharpens the more you log.");

  // RECORD — the conversation
  s.open("go:record");
  s.say("Record is a conversation. You talk, it listens, it answers, and it fills your tracker in as you go.");
  s.to("rec:mic").wait(1000);
  s.over("That's the microphone. I'll type instead, so nothing has to listen to me.");
  s.write("rec:type", "Bad cramps since this morning and I barely slept");
  s.over("It reads that into the fields, flashes whatever it heard, and answers in its own voice — so I'll be quiet a moment.");
  s.enter("rec:type").wait(9000);          // the app is talking now; two voices at once is nobody's demo
  s.to("rec:tracker").wait(900);
  s.say("The tracker on this side is built from your own words, not a fixed list of symptoms.");
  s.over("The tone it answers in is yours to pick.");
  s.tap("rec:personality").wait(700).tap("pers:warm");
  s.say("Warm, direct, clinical, coach or friend — only the way it talks back changes.");
  s.open("rec:details");
  s.say("And anything you didn't say out loud, you can still fill in by hand.");
  s.set("log:pain", 6).wait(700);
  s.tap("log:keep");

  // INSIGHTS — what is in the data
  s.open("nav:insights");
  s.say("Insights is everything the app has found in your data, filed under the part of the form it came from.");
  s.to("ins:summary").wait(1600);
  s.open("sub:track");
  s.say("What to track is the research read for you — things worth logging that you aren't logging yet.");
  s.open("sub:insights");
  s.over("The charts are folded away, because most people don't come here for charts.");
  s.open("charts");
  s.say("Opened, they let you put any two things you track against each other, on the same day or the day after.");
  s.tap("x:sugar").tap("y:pain").tap("lag:next").wait(1200);
  s.say("Sugar one day against pain the next — that's your own data answering your own question.");

  // ADVOCACY — what you take to the appointment
  s.open("nav:home");
  s.open("go:advocacy");
  s.say("Advocacy is what you take to the clinician: the criteria, what your tracking meets, and the words to say it in.");
  s.to("adv:triad").wait(1500);
  s.over("The thresholds can be bent, to see what would change.");
  s.open("adv:lab");
  s.wait(1200);
  s.say("Nothing here touches your data — it only asks what if. There's a printable version at the bottom for the appointment itself.");
  s.tap("adv:lab");

  // SETTINGS — and the way out
  s.open("nav:settings");
  s.say("Everything is yours to switch off. A blocked topic vanishes from the tracker and is never raised again, in the app or on the server.");
  s.tap("block:mood").wait(900).tap("block:mood");

  // HIRSUTISM — the one condition that settles a criterion by itself, so the
  // sheet behind it is worth showing rather than describing.
  s.over("This is where a diagnosis a clinician has already made goes. Hirsutism is the one that changes the most.");
  s.tap("cond:hirsutism").wait(900);
  s.say("Ticking it opens the modified Ferriman-Gallwey sheet — nine areas, each scored none to thick.");
  s.tap("fg:upperLip:2");
  s.tap("fg:chin:3");
  s.tap("fg:lowerAbdomen:2");
  s.tap("fg:thighs:1").wait(900);
  s.say("Eight out of thirty-six, from four areas. At or above the threshold, that is clinical hyperandrogenism — and it settles one of the three criteria without a blood test.");
  s.open("go:advocacy");
  s.to("adv:triad").wait(1500);
  s.say("Which is why the middle of the triad has just changed, and the indicator underneath it with it.");
  s.open("nav:settings");
  s.over("Tapping a score again takes it off, and unticking the condition puts the sheet away.");
  s.tap("fg:upperLip:2").tap("fg:chin:3").tap("fg:lowerAbdomen:2").tap("fg:thighs:1");
  s.tap("cond:hirsutism").wait(900);
  s.say("Nothing this demo touched is left behind — it is your record, not the app's opinion of you.");
  s.to("set:sim").wait(700);
  s.say("And this is where the guided demo lives: the simulation you have been watching, and the tutorial that comes next. Both stop here.");
  s.say("That's the tour. I'll get out of your way.");
  return s.beats;
}

/**
 * TUTORIAL — the same interface, explained rather than driven.
 *
 * It changes nothing. Each part is lit in turn, with the pointer resting on it,
 * so what is being talked about is never in doubt.
 */
export function tutorial() {
  const s = reel();
  s.wait(SCREEN_MS);
  s.say("A quick tour of where everything is. Nothing here will change your data.");
  s.open("nav:home");
  s.spot("home:ring", "Where you are in this cycle. The phases are worked out from your own history.");
  s.spot("cal:grid", "The calendar. Tap a day to mark a period, drag across several, or use Range for a whole bleed in two taps.");
  s.spot("home:next", "When to expect the next one — and how rough a guide that is, in your own numbers.");
  s.spot("go:record", "Recording your day is the one habit this app asks for. Everything else is built from it.");
  s.open("nav:record");
  s.spot("rec:mic", "Tap to talk. It listens, answers out loud, and stops listening while it thinks.");
  s.spot("rec:type", "Or type, if speaking isn't an option right now.");
  s.spot("rec:tracker", "What it hears becomes your tracker, in the words you used.");
  s.spot("rec:trends", "Trends turns on a live view of what's moving while you talk.");
  s.open("nav:insights");
  s.spot("sub:track", "What to track: research-backed suggestions for what to log next.");
  s.spot("charts", "And the charts, for when you want to go digging yourself.");
  s.open("nav:settings");
  s.spot("set:block", "Anything you don't want asked about goes here, and stays unasked.");
  s.spot("set:sim", "This is the switch for the simulation and for this tutorial. Both end on their own once they've finished.");
  s.dim();
  s.say("That's everything. It's yours now.");
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
  if (!ready) return null;
  if (settings.simulation && !onboarded && empty) return "signup";
  if (!onboarded) return null;                       // a half-filled form is theirs
  if (settings.simulation) return "sim";
  if (settings.tutorial) return "tour";
  return null;
}

/** What happens when a reel stops: which one is next, and which switch is spent. */
export function afterPhase(phase, { byHand = false, settings = {} } = {}) {
  if (phase === "tour") return { next: null, off: "tutorial" };
  if (phase === "sim") return { next: byHand || !settings.tutorial ? null : "tour", off: "simulation" };
  if (phase === "signup") return byHand ? { next: null, off: "simulation" } : { next: "sim", off: null };
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
