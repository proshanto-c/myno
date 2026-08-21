/**
 * Tawaazun showing itself.
 *
 * Three reels, in the order a first visit meets them:
 *
 *   signUp()    Waniyah signing herself up — a pointer walks on, picks the
 *               goal, types her into the boxes and lets her in.
 *   showcase()  her account, shown off: she drives it and explains it in the
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

/**
 * Waniyah. It is her account: she signs herself up at the start and everything
 * after that is her own screen, which is why she can say "my cycle" and mean
 * it. Her numbers sit inside the bands criteria.py actually judges, so the reel
 * ends on an app with something to say rather than a shrug.
 */
export const WANIYAH = {
  name: "Waniyah", age: 18, menarcheAge: 16, heightCm: 160, weightKg: 60,
  goals: ["whatswrong"],           // she is here to find out what is wrong
  chips: ["familyHistory", "acne"],
  diagnosis: "unsure",             // ... so "Not sure" is the honest answer
  conditions: ["hirsutism"],       // told to her by a clinician, and it settles a criterion
};

/** The basics step, in the order the boxes are laid out. */
export const FIELDS = ["name", "age", "menarcheAge", "heightCm", "weightKg"];

/**
 * Pace. An advert, not a manual — but a demo nobody can follow sells nothing,
 * so every screen is given long enough to be looked at and every line long
 * enough to be finished. Typing stays uneven, because an even one reads as a
 * machine.
 */
export const TYPE_MS = 26;
export const JITTER_MS = 18;
export const FIELD_GAP_MS = 140;
export const PRESS_MS = 180;      // the click itself, and the ring it leaves
export const BEAT_MS = 320;       // after a click, before moving off
export const STEP_MS = 600;       // a new step needs a moment before it is worked
export const OPEN_MS = 900;       // ... and the first screen needs longer
export const SCROLL_MS = 380;     // a smooth scroll, settling
export const SCREEN_MS = 650;     // a whole screen changing under the pointer
export const LINE_GAP_MS = 300;   // a breath between two spoken lines

/** How long the pointer takes to cross a gap: a floor so short hops still read
 *  as movement, a ceiling so a long one never turns into a wait. */
export const TRAVEL_MIN = 240;
export const TRAVEL_MAX = 700;
export const TRAVEL_PER_PX = 0.48;
export const travelMs = (dx, dy) => {
  const d = Math.hypot(dx, dy);
  return Math.round(Math.min(TRAVEL_MAX, TRAVEL_MIN + d * TRAVEL_PER_PX));
};

/** How long a line takes to say. Neither voice will tell us in advance, so the
 *  reel budgets for it: 420ms a word is what the cloned voice actually runs at,
 *  floored so a short line still lands and capped so a long one cannot strand
 *  the pointer. Captions are on screen for exactly the same stretch. */
export const SAY_PER_WORD_MS = 560;
export const SAY_MIN_MS = 1600;
export const SAY_MAX_MS = 12000;
export const sayMs = (text) => {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.round(Math.min(SAY_MAX_MS, Math.max(SAY_MIN_MS, 350 + words * SAY_PER_WORD_MS)));
};

/**
 * Every line the reels say, in order, deduplicated — what there is to warm.
 *
 * A whole line at a time. One clip per line means the pause between two
 * sentences is the speaker's own, rather than a gap while the next request
 * comes back — which is what made the voice sound spliced.
 */
export function spokenLines(person = WANIYAH) {
  const seen = new Set();
  for (const list of [signUp(person), showcase()])
    for (const b of list)
      if ((b.do === "say" || b.do === "spot") && b.text) seen.add(b.text);
  return [...seen];
}

/** The lines one reel says, in the order it will say them. */
export const linesOf = (list) =>
  [...new Set(list.filter((b) => (b.do === "say" || b.do === "spot") && b.text).map((b) => b.text))];

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
 *   spot   — light the target up and explain it, held the same way
 *   dictate — say a line into a control at the same moment it is pressed
 *   until  — hold until the app itself says it is ready
 *   dim    — put the lights back
 *   wait   — let the screen be read
 *
 * Targets are `data-demo` names, resolved when the beat plays rather than when
 * it is written: most of them belong to screens that do not exist yet.
 */
function reel(pace = {}) {
  // The tour and the sign-up want different rhythms. A tour is watched; a form
  // being filled in is glanced at, and every pause in it reads as a stall.
  const { beat = BEAT_MS, step = STEP_MS, gap = FIELD_GAP_MS, key = null } = pace;
  const beats = [];
  const api = {
    beats,
    pace,
    wait: (ms) => (beats.push({ do: "wait", ms }), api),
    /** Always held to the end of the line. Narration that ran underneath the
     *  next few beats sounded quicker, and was cut off mid-word every time the
     *  beats ran short — which they mostly did. */
    say: (text) => (beats.push({ do: "say", text }), api),
    to: (target) => (beats.push({ do: "reveal", target }, { do: "move", target }), api),
    tap: (target) => (api.to(target), beats.push({ do: "press", target }, { do: "wait", ms: beat }), api),
    /** a whole screen arrives after this one, so give it time to */
    open: (target) => (api.tap(target), beats.push({ do: "wait", ms: SCREEN_MS }), api),
    /** the beat between two steps of the same form */
    step: () => (beats.push({ do: "wait", ms: step }), api),
    write: (target, value) => {
      api.to(target);
      beats.push({ do: "press", target });        // a box has to be clicked before it is typed into
      const full = String(value);
      for (let i = 1; i <= full.length; i++)
        beats.push({ do: "key", target, value: full.slice(0, i), ...(key ? { ms: key } : {}) });
      beats.push({ do: "wait", ms: gap });
      return api;
    },
    /** one value straight in — a slider's position, not a typed word */
    set: (target, value) => (api.to(target), beats.push({ do: "key", target, value: String(value) },
                                                       { do: "wait", ms: BEAT_MS }), api),
    enter: (target) => (beats.push({ do: "enter", target }, { do: "wait", ms: beat }), api),
    /** Say a line and press in the same instant — for talking to a microphone,
     *  where the words have to arrive while the voice is saying them. */
    dictate: (target, text) => (api.to(target), beats.push({ do: "dictate", target, text }), api),
    spot: (target, text) => (api.to(target), beats.push({ do: "spot", target, text }), api),
    /** Wait on the app, not on the clock: `until("talking")` holds until it has
     *  started answering, `until("quiet")` until it has finished. `max` is the
     *  longest it will wait before giving up and carrying on regardless. */
    until: (what, max) => (beats.push({ do: "until", what, max }), api),
    dim: () => (beats.push({ do: "dim" }), api),
  };
  return api;
}

/**
 * THE SIGN-UP, SIGNING ITSELF UP.
 *
 * Waniyah signs herself up while she talks you through it. The words are hers,
 * verbatim — this file only decides where in the screen each line lands, and
 * what the pointer is doing while she says it.
 */
export function signUp(person = WANIYAH) {
  // Brisk: this is a form being filled in, and the hand doing it knows the
  // answers. Nothing here is waiting to be admired.
  const s = reel({ beat: 190, step: 300, gap: 90, key: 22 });
  s.wait(250);
  s.say("Hi, I'm Waniyah, and welcome to Tawaazun. Let me sign myself up.");
  for (const g of person.goals) s.tap(`goal:${g}`);
  s.say("It asks what brings you here. For me, it's about finally figuring out what's going on with my body.");
  s.tap("next").step();

  s.say("Then the basic information.");
  for (const f of FIELDS) s.write(`field:${f}`, person[f]);
  for (const c of person.chips) s.tap(`chip:${c}`);
  s.tap("next").step();

  s.tap(`dx:${person.diagnosis}`);
  s.to("cond:hirsutism");
  s.say("My doctor mentioned hirsutism, so that goes in — and it opens the scoring sheet.");
  for (const c of person.conditions || []) s.tap(`cond:${c}`);
  s.tap("fg:chin:3").tap("fg:upperLip:2");
  s.tap("next");
  return s.beats;
}

/**
 * THE SHOWCASE — her own account, shown the way you would show a friend.
 *
 * Home, then a day recorded by talking, then the history read back, then the
 * part she takes to an appointment. Everything it changes, it changes back.
 * Two beats are deliberately silent — the app answering her out loud, and the
 * end-of-conversation form — because something is happening there worth
 * hearing and watching rather than being talked over.
 */
export function showcase() {
  const s = reel();
  // Straight in. The sign-up has just closed behind her, so the first thing
  // that happens is the app arriving, not a pause and a sentence about it.
  s.wait(150);
  s.open("nav:home");
  s.say("Now, let me show you what Tawaazun actually does when you use it.");

  // HOME — the calendar, the ring, and what she is taking
  s.spot("cal:grid", "I just tap the day my cycle started, and that's it. The whole process is incredibly simple.");
  s.tap("cal:today");
  s.spot("home:ring", "It catches up immediately.");
  s.say("It shows exactly where I am in my cycle and predicts the next one based on my actual data, not just a generic monthly average.");
  s.tap("cal:today");
  s.spot("home:drugs", "Everything I take is pinned right here, ensuring my symptoms are always read with my medications in context.");
  s.dim();
  s.say("So — let's do my daily check-in.");

  // RECORD — she talks, it answers, the trends move
  s.open("go:record");
  s.spot("rec:mic", "This next bit is my absolute favorite. You don't have to fill out endless, tedious forms — you just talk to it!");
  // Heard, not just typed: the clip plays as the words stream into the
  // transcript, so she is talking to the microphone rather than miming at it.
  s.write("rec:line", "Bad cramps today, and I barely slept");
  s.dictate("rec:dictate", "Bad cramps today, and I barely slept");
  // Then it thinks, and answers in its own voice. She waits for both — talking
  // over the app's reply is the one overlap a demo can't explain away.
  s.until("talking", 12000);
  s.until("quiet", 25000);
  s.spot("rec:tracker", "Listen to this — it answers back, transcribes my words, and automatically fills out the log for me. I didn't type a single thing.");
  s.spot("rec:insights", "As I'm talking, you can see the trend graphs moving and placing today's entry right into my overall pattern.");
  s.dim();

  // ... and the form behind the conversation: one stop per section, each lit
  // as it is named, which is what walks the sheet down. Short lines on purpose
  // — this is a list of what is in there, not a tour of it.
  s.open("rec:end");
  s.spot("log:group:cycle", "And here's the whole form. Your cycle.");
  s.spot("log:group:wellbeing", "How you're feeling.");
  s.spot("log:group:body", "Your body.");
  s.spot("log:group:lifestyle", "Your habits.");
  s.spot("log:group:skin", "Your skin and hair — all of it already filled in with whatever it heard.");
  s.dim();
  s.tap("log:keep");

  // INSIGHTS — her history, handed back
  s.open("nav:insights");
  s.spot("ins:summary", "The Insights tab hands your history right back to you.");
  s.spot("ins:cat:cycle", "Every daily check-in feeds this. It keeps a diary of my history, and writes an analysis of my own numbers back to me.");
  s.to("charts").wait(1100);
  s.dim();

  // ADVOCACY — the part that speaks for her.
  // Straight there from Insights: on the wide layout Advocacy is a tab of its
  // own, so the detour through Home was a wasted screen.
  s.open("go:advocacy");
  s.spot("adv:triad", "This is the part that truly advocates for you. There are three criteria used for PMOS, and Tawaazun helps me track two of them myself.");
  s.spot("adv:indicator", "It shows exactly where my data stands against those clinical benchmarks.");
  s.spot("adv:points", "It tells me what symptoms to raise, how to phrase them, and what tests to ask for.");
  s.spot("adv:print", "I just print the summary out and take it directly to my appointment.");
  s.dim();
  s.say("With Tawaazun, I'm not starting from scratch, and I'm no longer spending years being told my symptoms are just “normal.”");
  s.say("That's Tawaazun. Go ahead and jump in — it's all yours!");
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
    else if (b.do === "key") { io.key?.(b.target, b.value); gap = b.ms ?? (TYPE_MS + rand() * JITTER_MS); }
    else if (b.do === "enter") { io.enter?.(b.target); gap = PRESS_MS; }
    else if (b.do === "say") gap = io.say?.(b.text) ?? sayMs(b.text);
    else if (b.do === "spot") gap = io.spot?.(b.target, b.text) ?? sayMs(b.text);
    else if (b.do === "dictate") gap = io.dictate?.(b.target, b.text) ?? sayMs(b.text);
    else if (b.do === "until") {
      // io says how long to leave it before asking again, or nothing when the
      // wait is over. Asking again means replaying this same beat.
      const again = io.until?.(b.what, b.max);
      if (again) { index -= 1; gap = again; } else gap = BEAT_MS;
    }
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
