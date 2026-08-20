"""
Insight rules — what counts as a pattern worth showing someone.

Every judgement call is a named constant in RULES below, so the thresholds can
be read and argued with instead of being buried as magic numbers in a loop:
what makes a day "high sugar", how many paired days a correlation needs before
it is worth reporting, how small a weekly drift still counts as a trend.

None of this interprets anything medically — that is criteria.py's job, and
the cycle label here comes from there rather than being decided twice.

No FastAPI, no SQLAlchemy: pure functions of the logs, so they can be exercised
directly (see test_insights.py).
"""
import datetime as dt
import math
import statistics

import record

RULES = {
    # A correlation is only shown when it clears both bars: enough paired days
    # to mean anything, and enough strength to be worth a sentence.
    "minPairsForCorrelation": 8,
    "minAbsR": 0.2,

    # Slider positions that count as "a high day" for the 0–10 metrics.
    "highSugar": 3,
    "severePain": 7,

    # When two stretches of bleeding are one period. Belsey (WHO, 1986), the
    # reference method for bleeding in trials, ends an episode after two
    # bleeding-free days; one free day does not. That assumes a daily diary, so
    # the second number is ours: a day nobody logged is not evidence that
    # bleeding stopped, and splitting on silence invents short cycles.
    "freeDaysEndPeriod": 2,
    "unloggedTolerance": 3,

    # A straight line through fewer points than this is noise, and a drift
    # smaller than this per week is not worth telling anyone about.
    "minPointsForTrend": 8,
    "minTrendPerWeek": 0.05,
    "minCategoryPoints": 3,   # a self-named tracker needs this many readings

    "recentDays": 30,         # how much history the sparklines carry
}

# |r| at or above the cut → the word we use for it.
STRENGTH_BANDS = [(0.8, "very strong"), (0.6, "strong"), (0.4, "moderate"), (0.2, "weak")]

# Insights are grouped the same way the Record screen is, so a finding lands
# under the heading the person filled in to produce it. Both the sections and
# the field-to-section mapping come from the schema rather than a second list.
CATEGORIES = record.CATEGORIES
CATEGORY_LABELS = dict(CATEGORIES)
FIELD_CATEGORY = record.FIELD_CATEGORY


def category_of(key, default="body"):
    return FIELD_CATEGORY.get(key, default)


# The correlations we look for. "pairing" says how the two columns line up:
#   "same"   both readings from the same day
#   "lagged" yesterday's first reading against today's second
#   "flag"   a yes/no flag against a number, from the same day
#   "toflag" a number against tomorrow's yes/no flag
# "category" is where the finding is shown; it is the section the *outcome*
# belongs to, except where a cross-section pattern reads better elsewhere.
# "expect" is the sign of r that CONFIRMS the label: "Less sleep -> more brain
# fog" is confirmed by a negative r, since it pairs sleep against fog. Without
# it a reader sees "r -0.69" under a claim and cannot tell which way it went.
#
# "id" is a foreign key. Dalīl binds a published study to one of these pairs by
# its id, so an id here is constant for ever: renaming one silently detaches
# every citation filed under it.
CORRELATIONS = [
    {"id": "period_pain",      "label": "Period days → higher pain", "expect": "+",       "pairing": "flag",   "a": "period", "b": "pain",      "category": "cycle"},
    {"id": "period_energy",    "label": "Period days → lower energy", "expect": "-",      "pairing": "flag",   "a": "period", "b": "energy",    "category": "cycle"},
    {"id": "sleep_brainfog",   "label": "Less sleep → more brain fog", "expect": "-",     "pairing": "same",   "a": "sleep",  "b": "brainFog",  "category": "wellbeing"},
    {"id": "sleep_energy",     "label": "Less sleep → lower energy", "expect": "+",       "pairing": "same",   "a": "sleep",  "b": "energy",    "category": "wellbeing"},
    {"id": "pain_mood",        "label": "Higher pain → lower mood", "expect": "-",        "pairing": "same",   "a": "pain",   "b": "mood",      "category": "wellbeing"},
    {"id": "sugar_pain",       "label": "Higher sugar → next-day pain", "expect": "+",    "pairing": "lagged", "a": "sugar",  "b": "pain",      "category": "body"},
    {"id": "fooddrive_sugar",  "label": "Higher food drive → higher sugar", "expect": "+","pairing": "same",   "a": "foodDrive", "b": "sugar",  "category": "body"},
    {"id": "sugar_cravings",   "label": "Higher sugar → next-day cravings", "expect": "+","pairing": "toflag", "a": "sugar",  "b": "cravings",  "category": "lifestyle"},
    {"id": "pain_sexdrive",    "label": "Higher pain → lower sex drive", "expect": "-",   "pairing": "same",   "a": "pain",   "b": "sexDrive",  "category": "lifestyle"},
    {"id": "energy_sexdrive",  "label": "Lower energy → lower sex drive", "expect": "+",  "pairing": "same",   "a": "energy", "b": "sexDrive",  "category": "lifestyle"},
    {"id": "sugar_acne",       "label": "Higher sugar → next-day acne", "expect": "+",    "pairing": "toflag", "a": "sugar",  "b": "acne",      "category": "skin"},
]

# The pair is unique across the list, so it is a key in its own right: a claim
# about (sleep, brainFog) finds its correlation without anybody choosing one.
CORRELATION_IDS = [c["id"] for c in CORRELATIONS]
CORRELATION_BY_PAIR = {(c["a"], c["b"]): c["id"] for c in CORRELATIONS}

TRENDED = [("pain", "Pain", "body"), ("sugar", "Sugar", "body"),
           ("mood", "Mood", "wellbeing"), ("energy", "Energy", "wellbeing"),
           ("sleep", "Sleep", "wellbeing"), ("brainFog", "Brain fog", "wellbeing"),
           ("sexDrive", "Sex drive", "lifestyle"), ("morningWeight", "Morning weight", "body")]


# ---- small statistics ------------------------------------------------------
def mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return round(sum(xs) / len(xs), 2) if xs else None


def pearson(pairs, rules=None):
    """Pearson r (point-biserial when one side is a 0/1 flag), or None if the
    sample is too small or one side never varies."""
    R = rules or RULES
    pairs = [(x, y) for x, y in pairs if isinstance(x, (int, float)) and isinstance(y, (int, float))]
    n = len(pairs)
    if n < R["minPairsForCorrelation"]:
        return None
    mx = sum(x for x, _ in pairs) / n
    my = sum(y for _, y in pairs) / n
    cov = sum((x - mx) * (y - my) for x, y in pairs)
    vx = sum((x - mx) ** 2 for x, _ in pairs)
    vy = sum((y - my) ** 2 for _, y in pairs)
    if vx <= 0 or vy <= 0:
        return None
    return {"r": round(cov / math.sqrt(vx * vy), 2), "n": n}


def strength(r):
    a = abs(r)
    for cut, word in STRENGTH_BANDS:
        if a >= cut:
            return word
    return "negligible"


def slope_per_week(ys, rules=None):
    """Least-squares slope over the day index, expressed as units per week."""
    R = rules or RULES
    pts = [(i, y) for i, y in enumerate(ys) if isinstance(y, (int, float))]
    n = len(pts)
    if n < R["minPointsForTrend"]:
        return None
    mx = sum(i for i, _ in pts) / n
    my = sum(y for _, y in pts) / n
    den = sum((i - mx) ** 2 for i, _ in pts)
    if den <= 0:
        return None
    return round(sum((i - mx) * (y - my) for i, y in pts) / den * 7, 2)


# ---- cycles ----------------------------------------------------------------
def cycle_starts(logs, rules=None):
    """The first day of each period.

    Consecutive bleeding days are one period. So are days with a single recorded
    bleeding-free day between them (Belsey), or with a few days nobody logged —
    silence says nothing about whether bleeding stopped.
    """
    R = rules or RULES
    bleeding = sorted({l["date"] for l in logs if l.get("period")})
    logged = {l["date"] for l in logs if l.get("date")}
    starts, prev = [], None
    for d in bleeding:
        day = dt.date.fromisoformat(d)
        if prev is None:
            starts.append(d)
        else:
            between = [prev + dt.timedelta(days=i) for i in range(1, (day - prev).days)]
            recorded_free = sum(1 for b in between if b.isoformat() in logged)
            silent = len(between) - recorded_free
            if recorded_free >= R["freeDaysEndPeriod"] or silent > R["unloggedTolerance"]:
                starts.append(d)
        prev = day
    return starts


def cycle_gaps(logs, rules=None):
    """Days between consecutive period starts.

    Short gaps are kept. A seven-day cycle is not noise to be filtered out, it
    is the short-cycle finding the criteria exist to raise; dropping it here
    would hide it from the person and from their doctor.
    """
    starts = [dt.date.fromisoformat(d) for d in cycle_starts(logs, rules)]
    return [(starts[i] - starts[i - 1]).days for i in range(1, len(starts))]


def average_cycle_days(logs, rules=None):
    gaps = cycle_gaps(logs, rules)
    return round(sum(gaps) / len(gaps)) if gaps else None


def _pairs(logs, kind, a, b):
    if kind == "same":
        return [(l.get(a), l.get(b)) for l in logs]
    if kind == "lagged":
        return [(logs[i - 1].get(a), logs[i].get(b)) for i in range(1, len(logs))]
    if kind == "flag":
        return [(1 if l.get(a) else 0, l.get(b)) for l in logs]
    if kind == "toflag":
        return [(logs[i - 1].get(a), 1 if logs[i].get(b) else 0) for i in range(1, len(logs))]
    raise ValueError(f"unknown pairing {kind!r}")


# ---- the summary -----------------------------------------------------------
def summarise(logs, patient=None, rules=None, cycle_verdict=None, today=None):
    """Everything derived from the logs, in one pass.

    cycle_verdict is criteria.assess_cycles' answer; passing it in keeps this
    module free of the diagnostic rules while still letting the cycle carry the
    one label the whole app agrees on.
    """
    R = rules or RULES
    col = lambda k: [l.get(k) for l in logs if isinstance(l.get(k), (int, float))]

    # pain the day after a high-sugar day, against the day after a low one
    after_high, after_low = [], []
    for i in range(1, len(logs)):
        sugar, pain = logs[i - 1].get("sugar"), logs[i].get("pain")
        if isinstance(sugar, (int, float)) and isinstance(pain, (int, float)):
            (after_high if sugar >= R["highSugar"] else after_low).append(pain)

    gaps = cycle_gaps(logs, R)
    starts = cycle_starts(logs)

    correlations = []
    for c in CORRELATIONS:
        p = pearson(_pairs(logs, c["pairing"], c["a"], c["b"]), R)
        if p and abs(p["r"]) >= R["minAbsR"]:
            correlations.append({"id": c["id"], "label": c["label"], "r": p["r"], "n": p["n"],
                                 "category": c.get("category", category_of(c["b"])),
                                 "strength": strength(p["r"]),
                                 # does the data run the way the label claims?
                                 "holds": (p["r"] > 0) == (c.get("expect", "+") == "+"),
                                 "direction": "positive" if p["r"] > 0 else "negative"})
    correlations.sort(key=lambda c: -abs(c["r"]))

    trends = []
    for key, label, category in TRENDED:
        per_week = slope_per_week([l.get(key) for l in logs], R)
        if per_week is not None and abs(per_week) >= R["minTrendPerWeek"]:
            trends.append({"key": key, "label": label, "category": category,
                           "perWeek": per_week,
                           "direction": "up" if per_week > 0 else "down"})

    # trackers the person named themselves, halved to show then-versus-now
    tracked = {}
    for l in logs:
        for c in (l.get("categories") or []):
            if c.get("scale"):
                slot = tracked.setdefault(c["key"], {"label": c.get("label", c["key"]), "vals": []})
                slot["vals"].append(c["scale"]["value"])
    categories = []
    for key, slot in tracked.items():
        vals = slot["vals"]
        if len(vals) >= R["minCategoryPoints"]:
            half = len(vals) // 2
            categories.append({"key": key, "label": slot["label"], "avg": mean(vals),
                               "earlier": mean(vals[:half]), "recent": mean(vals[half:]),
                               "n": len(vals), "perWeek": slope_per_week(vals, R)})

    cycle = None
    if len(gaps) >= 2:
        m, sd = statistics.mean(gaps), statistics.pstdev(gaps)
        cycle = {"meanDays": round(m, 1), "sdDays": round(sd, 1),
                 "cv": round(sd / m * 100, 1) if m else None,
                 "min": min(gaps), "max": max(gaps), "cycles": len(gaps) + 1,
                 # "Regular" is criteria.py's word, not ours — so this label, the
                 # doctor indicator and the advocacy report always agree.
                 "regular": None, "label": "Cycle length recorded"}

    summary = {
        "loggedDays": len(logs),
        "avgPain": mean(col("pain")), "avgMood": mean(col("mood")), "avgEnergy": mean(col("energy")),
        "avgSleep": mean(col("sleep")), "avgBrainFog": mean(col("brainFog")), "avgSugar": mean(col("sugar")),
        "painAfterHighSugar": mean(after_high), "painAfterLowSugar": mean(after_low),
        "painWithBloating": mean([l.get("pain") for l in logs if l.get("bloating")]),
        "painWithoutBloating": mean([l.get("pain") for l in logs if not l.get("bloating")]),
        "avgCycleDays": mean(gaps), "cycleMin": min(gaps) if gaps else None,
        "cycleMax": max(gaps) if gaps else None, "cycleCount": len(gaps),
        "periodsLogged": len(starts),
        "cycleDay": cycle_day(starts, today),
        "daysSinceSeverePain": _days_since_severe_pain(logs, R),
        "hairGrowthDaysPct": _pct(logs, "hairGrowth"),
        "hairLossDaysPct": _pct(logs, "hairLoss"),
        "correlations": correlations, "cycle": cycle, "trends": trends,
        "categoryTrends": categories,
        "recent": {k: [l.get(k) for l in logs[-R["recentDays"]:]] for k, _, _ in TRENDED},
    }
    summary["byCategory"] = by_category(summary)
    if cycle_verdict:
        label_cycle(summary, cycle_verdict)
    return summary


def by_category(summary):
    """The findings regrouped under the Record sections, each with the handful of
    averages that belong to it, so a section is never an empty heading."""
    if not summary.get("loggedDays"):
        # 0% and "0 days since" are arithmetic on nothing, not facts about anyone
        return [{"key": k, "label": l, "correlations": [], "trends": [], "facts": [], "count": 0}
                for k, l in CATEGORIES]
    facts = {
        "cycle": [("Average cycle", summary.get("avgCycleDays"), "days"),
                  ("Cycles logged", summary.get("cycleCount") or None, ""),
                  ("Day of cycle", summary.get("cycleDay"), "")],
        "wellbeing": [("Average mood", summary.get("avgMood"), "/10"),
                      ("Average energy", summary.get("avgEnergy"), "/10"),
                      ("Average sleep", summary.get("avgSleep"), "/10"),
                      ("Average brain fog", summary.get("avgBrainFog"), "/10")],
        "body": [("Average pain", summary.get("avgPain"), "/10"),
                 ("Days since severe pain", summary.get("daysSinceSeverePain"), ""),
                 ("Average sugar", summary.get("avgSugar"), "/10")],
        "lifestyle": [("Pain after high-sugar days", summary.get("painAfterHighSugar"), "/10"),
                      ("Pain after low-sugar days", summary.get("painAfterLowSugar"), "/10")],
        "skin": [("Days with hair growth", summary.get("hairGrowthDaysPct"), "%"),
                 ("Days with hair loss", summary.get("hairLossDaysPct"), "%")],
    }
    out = []
    for key, label in CATEGORIES:
        group = {
            "key": key, "label": label,
            "correlations": [c for c in summary["correlations"] if c.get("category") == key],
            "trends": [t for t in summary["trends"] if t.get("category") == key],
            "facts": [{"label": l, "value": v, "unit": u} for l, v, u in facts[key] if v is not None],
        }
        group["count"] = len(group["correlations"]) + len(group["trends"])
        out.append(group)
    return out


def label_cycle(summary, verdict):
    """Stamp criteria.py's verdict onto the cycle block. Kept here so the shape
    of the cycle dict is defined in one place, but the judgement stays theirs."""
    cycle = summary.get("cycle")
    if not cycle:
        return summary
    state = verdict["state"]
    cycle["regular"] = None if state == "unknown" else state != "met"
    cycle["label"] = {"met": "Irregular", "clear": "Regular", "unknown": "Not assessable"}[state]
    cycle["why"] = verdict["reasons"]
    return summary


def _pct(logs, key):
    return round(100.0 * sum(1 for l in logs if l.get(key)) / len(logs), 1) if logs else 0.0


def cycle_day(starts, today=None):
    """Which day of the cycle today is, counting the first bleeding day as day 1.

    Measured against today rather than the last logged day: someone who stopped
    logging a week ago is still a week further into their cycle. Starts dated
    after today are ignored — a log from the future is not the cycle you are in.
    """
    today = today or dt.date.today()
    past = [s for s in starts if dt.date.fromisoformat(s) <= today]
    if not past:
        return None
    return (today - dt.date.fromisoformat(past[-1])).days + 1


def _days_since_severe_pain(logs, rules=None):
    R = rules or RULES
    for i, l in enumerate(reversed(logs)):
        pain = l.get("pain")
        if isinstance(pain, (int, float)) and pain >= R["severePain"]:
            return i
    return len(logs)
