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

RULES = {
    # A correlation is only shown when it clears both bars: enough paired days
    # to mean anything, and enough strength to be worth a sentence.
    "minPairsForCorrelation": 8,
    "minAbsR": 0.2,

    # Slider positions that count as "a high day" for the 0–10 metrics.
    "highSugar": 3,
    "severePain": 7,

    # Bleeding runs several days; anything closer together than this is the
    # same period, not a new cycle. Without it a 5-day bleed looks like four
    # one-day cycles and drags the average to nonsense.
    "minCycleGapDays": 10,

    # A straight line through fewer points than this is noise, and a drift
    # smaller than this per week is not worth telling anyone about.
    "minPointsForTrend": 8,
    "minTrendPerWeek": 0.05,
    "minCategoryPoints": 3,   # a self-named tracker needs this many readings

    "recentDays": 30,         # how much history the sparklines carry
}

# |r| at or above the cut → the word we use for it.
STRENGTH_BANDS = [(0.8, "very strong"), (0.6, "strong"), (0.4, "moderate"), (0.2, "weak")]

# The correlations we look for, and how each pairs its two columns:
#   "same"   both readings from the same day
#   "lagged" yesterday's first reading against today's second
#   "flag"   a yes/no flag against a number, from the same day
#   "toflag" a number against tomorrow's yes/no flag
CORRELATIONS = [
    ("Higher sugar → next-day pain",     "lagged", "sugar",    "pain"),
    ("Less sleep → more brain fog",      "same",   "sleep",    "brainFog"),
    ("Less sleep → lower energy",        "same",   "sleep",    "energy"),
    ("Higher pain → lower mood",         "same",   "pain",     "mood"),
    ("Bloating days → higher pain",      "flag",   "bloating", "pain"),
    ("Higher sugar → next-day cravings", "toflag", "sugar",    "cravings"),
]

TRENDED = [("pain", "Pain"), ("mood", "Mood"), ("energy", "Energy"),
           ("sleep", "Sleep"), ("brainFog", "Brain fog")]


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
def cycle_starts(logs):
    """The first day of each bleed. A period day whose day before was also one
    continues the same period; it does not start a new cycle."""
    days = sorted({l["date"] for l in logs if l.get("period")})
    starts, prev = [], None
    for d in days:
        day = dt.date.fromisoformat(d)
        if prev is None or (day - prev).days > 1:
            starts.append(d)
        prev = day
    return starts


def cycle_gaps(logs, rules=None):
    """Days between consecutive cycle starts, with same-period runs dropped."""
    R = rules or RULES
    starts = [dt.date.fromisoformat(d) for d in cycle_starts(logs)]
    gaps = [(starts[i] - starts[i - 1]).days for i in range(1, len(starts))]
    return [g for g in gaps if g >= R["minCycleGapDays"]]


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
def summarise(logs, patient=None, rules=None, cycle_verdict=None):
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
    for label, kind, a, b in CORRELATIONS:
        p = pearson(_pairs(logs, kind, a, b), R)
        if p and abs(p["r"]) >= R["minAbsR"]:
            correlations.append({"label": label, "r": p["r"], "n": p["n"],
                                 "strength": strength(p["r"]),
                                 "direction": "positive" if p["r"] > 0 else "negative"})
    correlations.sort(key=lambda c: -abs(c["r"]))

    trends = []
    for key, label in TRENDED:
        per_week = slope_per_week([l.get(key) for l in logs], R)
        if per_week is not None and abs(per_week) >= R["minTrendPerWeek"]:
            trends.append({"key": key, "label": label, "perWeek": per_week,
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
        "cycleDay": _days_since(starts[-1], logs) if starts else None,
        "daysSinceSeverePain": _days_since_severe_pain(logs, R),
        "hairGrowthDaysPct": _pct(logs, "hairGrowth"),
        "hairLossDaysPct": _pct(logs, "hairLoss"),
        "correlations": correlations, "cycle": cycle, "trends": trends,
        "categoryTrends": categories,
        "recent": {k: [l.get(k) for l in logs[-R["recentDays"]:]] for k, _ in TRENDED},
    }
    if cycle_verdict:
        label_cycle(summary, cycle_verdict)
    return summary


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


def _days_since(start, logs):
    """Where in the current cycle the last logged day falls."""
    if not logs:
        return None
    last = logs[-1].get("date")
    return (dt.date.fromisoformat(last) - dt.date.fromisoformat(start)).days if last else None


def _days_since_severe_pain(logs, rules=None):
    R = rules or RULES
    for i, l in enumerate(reversed(logs)):
        pain = l.get("pain")
        if isinstance(pain, (int, float)) and pain >= R["severePain"]:
            return i
    return len(logs)
