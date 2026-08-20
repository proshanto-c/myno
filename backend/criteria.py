"""
Diagnostic criteria — rules in, a recommendation out. Never a diagnosis.

Of the criteria a clinician weighs, only two can be approached from what
somebody tracks themselves, and one of those only as a screening signal:

    Irregular cycles    ASSESSABLE   logged period dates + age at menarche
    Clinical HA         SCREENING    self-scored hirsutism, hair loss, acne
    Biochemical HA      CLINIC ONLY  total & free testosterone, A4, DHEAS
    Ovarian morphology  CLINIC ONLY  ultrasound follicle count, or serum AMH

A diagnosis needs two of three AND thyroid, prolactin, CAH and Cushing's ruled
out — none of which can happen here. So nothing in this module concludes
anything about a condition. It answers one question: is this worth a visit?

This is the single definition of "irregular" in the codebase. The insight
summary's cycle label and the advocacy rules both read it, so the indicator,
the trend labels and the talking points cannot contradict each other.

No FastAPI, no SQLAlchemy: everything here is a pure function of its inputs,
so it can be exercised directly (see test_criteria.py).
"""

RULES = {
    # Cycle-length limits by years since menarche. Year one is deliberately
    # absent: erratic cycles are the expected pubertal transition, not a finding.
    "cycleBands": [
        {"fromYear": 1, "toYear": 3, "shortDays": 21, "longDays": 45, "label": "1–3 years after menarche"},
        {"fromYear": 3, "toYear": None, "shortDays": 21, "longDays": 35, "label": "3+ years after menarche"},
    ],
    "singleCycleDays": 90,   # any one cycle this long stands on its own
    "minCyclesPerYear": 8,   # fewer than this in a year reads as irregular (3y+)
    "amenorrheaAge": 15,     # no first period by this age
    "mfgHirsutism": 4,       # modified Ferriman–Gallwey, self-scored 0–36
    "hirsutismDaysPct": 25,  # no mFG score? fall back to % of days hair was flagged
    "hairLossDaysPct": 10,
    "minCyclesToJudge": 2,   # below this, say "not enough yet" instead of guessing
}

# What the indicator can say, and how loudly.
ADVICE = {
    "diagnosed": {"headline": "You already have a diagnosis", "tone": "calm"},
    "soon":    {"headline": "Worth booking an appointment soon", "tone": "urgent"},
    "book":    {"headline": "Worth booking an appointment", "tone": "elevated"},
    "mention": {"headline": "Worth mentioning at your next visit", "tone": "mild"},
    "none":    {"headline": "Nothing here says you need an appointment", "tone": "calm"},
    "unknown": {"headline": "Not enough tracked yet to say", "tone": "muted"},
}


def merge_rules(overrides):
    """Caller-supplied thresholds on top of the defaults (the experiment panel)."""
    r = {**RULES, "cycleBands": [dict(b) for b in RULES["cycleBands"]]}
    for k, v in (overrides or {}).items():
        if k == "cycleBands" and isinstance(v, list):
            for i, band in enumerate(v):
                if i < len(r["cycleBands"]) and isinstance(band, dict):
                    r["cycleBands"][i].update(band)
        elif k in r:
            r[k] = v
    return r


# The modified Ferriman-Gallwey sheet: nine areas, each scored 0-4, so the
# total runs 0-36. Self-scored here, which is why it stays a screening signal.
MFG_AREAS = [
    ("upperLip", "Upper lip"), ("chin", "Chin"), ("chest", "Chest"),
    ("upperAbdomen", "Upper abdomen"), ("lowerAbdomen", "Lower abdomen"),
    ("upperArms", "Upper arms"), ("thighs", "Thighs"),
    ("upperBack", "Upper back"), ("lowerBack", "Lower back"),
]

def mfg_total(scores):
    """Sum of the nine areas, or None when the sheet has not been filled in."""
    if not scores:
        return None
    vals = [scores.get(key) for key, _ in MFG_AREAS]
    vals = [v for v in vals if isinstance(v, (int, float))]
    return sum(vals) if vals else None


# Drug therapy that hides the cycle. Letrozole and GLP-1s do not: they change
# what the cycle does, which is exactly what we still want to read.
HORMONAL_DRUGS = {"ocp", "oral contraceptive pill", "combined pill", "the pill"}

def is_hormonal_drug(name):
    key = str(name).strip().lower()
    return key in HORMONAL_DRUGS or "contracept" in key


def _band_for(years, rules):
    if years is None:
        return None
    for b in rules["cycleBands"]:
        if years >= b["fromYear"] and (b["toYear"] is None or years < b["toYear"]):
            return b
    return None


# ---- criterion 1 — irregular cycles ----------------------------------------
def assess_cycles(x, rules=None):
    """state is "met" (irregular by the guideline) | "clear" | "unknown".

    alerts are findings that warrant a visit on their own merit, whatever the
    rest of the picture looks like.
    """
    R = rules or RULES
    reasons, alerts = [], []
    age, years = x.get("age"), x.get("yearsPostMenarche")

    if not x.get("hasMenarche"):
        if age is not None and age >= R["amenorrheaAge"]:
            alerts.append(f"No first period by {age} — that is assessed in its own right.")
        return {"state": "unknown", "reasons": ["No periods logged yet."], "alerts": alerts}

    # A withdrawal bleed is scheduled by the method, not by ovulation: regular by
    # construction, and silent about the thing this criterion actually measures.
    if x.get("onContraception"):
        return {"state": "unknown", "alerts": alerts, "reasons": [
            "Cycles can't be read on hormonal contraception — the bleed is scheduled by the method, not by ovulation."]}
    if years is not None and years < 1:
        return {"state": "unknown", "alerts": alerts, "reasons": [
            "Within the first year after menarche, irregular cycles are expected."]}

    observed = x.get("cyclesObserved") or 0
    if observed < R["minCyclesToJudge"]:
        return {"state": "unknown", "alerts": alerts, "reasons": [
            f"Only {observed} full cycle(s) logged — {R['minCyclesToJudge']} are needed."]}

    lo, hi = x.get("minCycle"), x.get("maxCycle")

    # One very long cycle counts whatever the average says.
    if hi is not None and hi > R["singleCycleDays"]:
        alerts.append(f"A {hi}-day cycle — anything over {R['singleCycleDays']} days is worth raising by itself.")

    band = _band_for(years, R) or R["cycleBands"][-1]
    notes = [] if years is not None else ["Age at first period not set — using adult limits."]

    # Only these three count towards the criterion; notes above are context.
    if lo is not None and lo < band["shortDays"]:
        reasons.append(f"Shortest cycle {lo} days — under {band['shortDays']} ({band['label']}).")
    if hi is not None and hi > band["longDays"]:
        reasons.append(f"Longest cycle {hi} days — over {band['longDays']} ({band['label']}).")
    per_year = x.get("cyclesPerYear")
    if band["fromYear"] >= 3 and per_year is not None and per_year < R["minCyclesPerYear"]:
        reasons.append(f"{per_year} cycles in the past year — fewer than {R['minCyclesPerYear']}.")

    met = bool(reasons)
    in_range = f"Cycles {lo}–{hi} days sit inside {band['shortDays']}–{band['longDays']} ({band['label']})."
    return {"state": "met" if met else "clear", "band": band, "alerts": alerts,
            "reasons": (reasons if met else [in_range]) + notes}


# ---- criterion 2 — clinical hyperandrogenism -------------------------------
def assess_androgen(x, rules=None):
    """Self-report, so this is a screening signal and never more than that: a
    clinician scores hirsutism by examination and confirms with bloods."""
    R = rules or RULES
    reasons = []
    conditions = [str(c).lower() for c in (x.get("conditions") or [])]
    if "hirsutism" in conditions:
        # already assessed by a clinician — no need to infer it from day counts
        return {"state": "met", "alerts": [], "reasons": ["Hirsutism is already on your record."]}
    mfg = x.get("mfgScore")
    hair_pct = x.get("hirsutismDaysPct") or 0
    if mfg is not None:
        if mfg >= R["mfgHirsutism"]:
            reasons.append(f"Self-scored hirsutism {mfg}/36 — at or over {R['mfgHirsutism']}.")
    elif hair_pct >= R["hirsutismDaysPct"]:
        reasons.append(f"Coarse hair growth on {round(hair_pct)}% of logged days.")

    loss_pct = x.get("hairLossDaysPct") or 0
    if loss_pct >= R["hairLossDaysPct"]:
        reasons.append(f"Scalp hair thinning on {round(loss_pct)}% of logged days.")
    if x.get("persistentAcne"):
        reasons.append("Persistent acne.")

    return {"state": "met" if reasons else "clear", "alerts": [],
            "reasons": reasons or ["No hair or skin signs standing out."]}


# ---- the indicator ---------------------------------------------------------
def recommend(cycles, androgen, diagnosed=False):
    """Blunt on purpose. Alerts outrank everything; then it comes down to how
    many of the two assessable criteria are met — and which one, since cycles
    are measured while hair and skin signs are self-reported."""
    alerts = list(cycles["alerts"]) + list(androgen["alerts"])
    met = [c for c in (cycles, androgen) if c["state"] == "met"]
    why = [r for c in met for r in c["reasons"]]

    if alerts:
        return {"key": "soon", **ADVICE["soon"], "why": alerts, "met": len(met)}
    # Screening someone who has already been diagnosed answers a question they
    # no longer have. The tracking still stands — it is what a review runs on.
    if diagnosed:
        return {"key": "diagnosed", **ADVICE["diagnosed"], "met": len(met), "why": [
            "PMOS is already on your record, so this isn't a question of whether to get checked.",
            "What you log here is what a review appointment runs on — bring it with you."] + why}
    if len(met) == 2:
        return {"key": "book", **ADVICE["book"], "why": why, "met": 2}
    if cycles["state"] == "met":
        return {"key": "book", **ADVICE["book"], "why": why, "met": 1}
    if androgen["state"] == "met":
        return {"key": "mention", **ADVICE["mention"], "why": why, "met": 1}
    if cycles["state"] == "unknown":
        return {"key": "unknown", **ADVICE["unknown"], "why": cycles["reasons"], "met": 0}
    return {"key": "none", **ADVICE["none"], "why": cycles["reasons"] + androgen["reasons"], "met": 0}


# Thyroid disease causes irregular cycles in its own right, so a criterion met
# on top of one means less than it looks like. We say so rather than adjusting
# the verdict — deciding what explains what is the clinician's job.
CONFOUNDERS = {
    "hypothyroidism": "Hypothyroidism can itself lengthen or stop cycles.",
    "hyperthyroidism": "Hyperthyroidism can itself shorten or stop cycles.",
}

def context_notes(x):
    have = [str(c).lower() for c in (x.get("conditions") or [])]
    return [note for key, note in CONFOUNDERS.items() if key in have]


def assess(x, rules=None):
    R = rules or RULES
    cycles = assess_cycles(x, R)
    androgen = assess_androgen(x, R)
    diagnosed = bool(x.get("diagnosed"))
    return {
        "context": context_notes(x),
        "diagnosed": diagnosed,
        "cycles": cycles,
        "androgen": androgen,
        "recommendation": recommend(cycles, androgen, diagnosed),
        "inputs": x,
        # The third circle stays locked: morphology is not ours to assess.
        "axes": {
            "ovulatory": {"met": cycles["state"] == "met", "note": cycles["reasons"][0] if cycles["reasons"] else ""},
            "androgen": {"met": androgen["state"] == "met", "note": androgen["reasons"][0] if androgen["reasons"] else ""},
            "morphology": {"met": None, "note": "Ultrasound or AMH — a clinician only"},
        },
    }


# ---- what the app measured, before anyone plays with it --------------------
def derive_inputs(patient, logs, summary):
    """Fold a patient row, their logs and the computed insight summary into the
    flat input set the rules read."""
    age = getattr(patient, "age", None)
    menarche = getattr(patient, "menarche_age", None)
    # Only hormonal methods turn a period into a withdrawal bleed. Condoms and
    # cycle tracking leave ovulation — and so the criterion — perfectly readable.
    last = logs[-1] if logs else {}
    method = str(last.get("birthControlType") or "").strip().lower()
    # A pill listed under drug therapy is still hormonal contraception, whether
    # or not the person thinks of it that way when logging a day.
    if any(is_hormonal_drug(d) for d in (getattr(patient, "drugs", None) or [])):
        method = "hormonal"
    if not method and last.get("birthControl"):
        # older logs stored a free-text method; read it the same way
        method = "hormonal" if any(w in str(last["birthControl"]).lower()
                                   for w in ("pill", "hormon", "implant", "injection", "patch", "ring", "mirena", "iud")) else "other"
    days = summary.get("loggedDays") or 0
    observed = summary.get("cycleCount") or 0

    def pct(key):
        if not logs:
            return 0.0
        return 100.0 * sum(1 for l in logs if l.get(key)) / len(logs)

    return {
        "age": age,
        # Having had a first period is a fact about the logs; the age it
        # happened at is a profile field people often leave blank.
        "hasMenarche": bool(menarche) or any(l.get("period") for l in logs),
        "yearsPostMenarche": (age - menarche) if (age and menarche) else None,
        "onContraception": method == "hormonal",
        "cyclesObserved": observed,
        "minCycle": summary.get("cycleMin"),
        "maxCycle": summary.get("cycleMax"),
        "avgCycle": summary.get("avgCycleDays"),
        # "cycles per year" only means anything with about a year of logs behind it
        "cyclesPerYear": (observed + 1) if days >= 330 else None,
        "mfgScore": mfg_total(getattr(patient, "mfg", None)),
        "conditions": list(getattr(patient, "conditions", None) or []),
        # a formal diagnosis is its own fact, not one of the conditions above
        "diagnosed": bool(getattr(patient, "pmos_diagnosed", False)),
        "hirsutismDaysPct": pct("hairGrowth"),
        "hairLossDaysPct": pct("hairLoss"),
        "persistentAcne": bool(getattr(patient, "acne", False)),
    }
