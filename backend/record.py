"""
The Record screen's schema — what we ask, in what order, under which heading.

This is the backend's list, not the frontend's: the same field names decide what
the voice extractor listens for, which section an insight is filed under, and
what criteria.py can read. Keeping one copy means adding a field is one edit
here rather than three that can drift apart.

Group keys double as the insight categories, so a finding lands under the same
heading the person filled in to produce it.

Field types the client knows how to render:
    bool     yes/no
    select   one of `options`
    scale    0..max slider, `words` labels the ends and middle
    emoji    one of `options`, each {value, emoji, label}
    number   free number, `placeholder` is the unit
    text     free text
    bodymap  tappable front/back body outline, stores a list of pain points

`heading` on a field starts a labelled sub-group above it (the diet macros).

`showIf` is declarative — {"field": ..., "equals": ...} — so it survives JSON.
`liveTrend: False` keeps a numeric field out of the live panel on the Record
screen, while leaving it plottable in Insights.
"""
SCALE_MAX = 10

MOODS = [
    {"value": 1, "emoji": "\U0001F62D", "label": "Awful"},
    {"value": 3, "emoji": "\U0001F61E", "label": "Low"},
    {"value": 5, "emoji": "\U0001F610", "label": "Flat"},
    {"value": 7, "emoji": "\U0001F642", "label": "Good"},
    {"value": 9, "emoji": "\U0001F604", "label": "Great"},
]

# Words for each slider, so a number always has language with it. The first
# word belongs to 0 alone and the last to the top of the scale alone; the ones
# in between share the middle. Anything shorter than five reads badly at 1/10,
# where "none" is plainly wrong.
WORDS = {
    "pain":      ["none", "mild", "moderate", "severe", "extreme"],
    "energy":    ["depleted", "low", "moderate", "high", "very high"],
    "sleep":     ["awful", "poor", "patchy", "good", "great"],
    "brainFog":  ["clear", "slight", "moderate", "heavy", "severe"],
    "sexDrive":  ["none", "low", "moderate", "high", "very high"],
}


# Every macro is answered on the same three-level scale.
LEVELS = ["low", "usual", "high"]


def _scale(key, label):
    return {"key": key, "label": label, "type": "scale", "max": SCALE_MAX, "words": WORDS[key]}


SCHEMA = [
    {"key": "cycle", "group": "Menstrual cycle", "fields": [
        {"key": "period", "label": "Started your period?", "type": "bool"},
        {"key": "flow", "label": "Flow", "type": "select",
         "options": ["none", "spotting", "light", "medium", "heavy"]},
        # Only hormonal methods make a bleed a withdrawal bleed, so the method
        # is what decides whether the cycle criterion can be read at all. The
        # yes/no that used to sit in front of this asked the same thing twice.
        {"key": "birthControlType", "label": "Birth control", "type": "select",
         "options": ["none", "natural", "mechanical", "hormonal"]},
    ]},
    {"key": "wellbeing", "group": "Wellbeing", "fields": [
        {"key": "mood", "label": "Mood", "type": "emoji", "options": MOODS},
        _scale("energy", "Energy"),
        _scale("sleep", "Sleep"),
        _scale("brainFog", "Brain fog"),
    ]},
    {"key": "body", "group": "Body", "fields": [
        _scale("pain", "Pain"),
        {"key": "painPoints", "label": "Where it hurts", "type": "bodymap"},
        {"key": "morningWeight", "label": "Morning weight (kg)", "type": "number", "placeholder": "kg"},
    ]},
    {"key": "lifestyle", "group": "Lifestyle", "fields": [
        # Charted on Insights, which someone opens on purpose, but not in the
        # panel that sits open on screen while they are talking out loud.
        {**_scale("sexDrive", "Sex drive"), "liveTrend": False},
        {"key": "cravings", "label": "Cravings", "type": "bool"},
        {"key": "cravingType", "label": "Craving for", "type": "select",
         "options": ["salty", "sugary"], "showIf": {"field": "cravings", "equals": True}},
        {"key": "exercise", "label": "Exercise", "type": "select",
         "options": ["inactive", "fairly active", "active", "very active"]},
        # One macro per line rather than a single "mostly carbs" choice, so a
        # day can be high protein AND low carb — which is the pattern people
        # actually eat to, and the one a clinician asks about.
        {"key": "dietCarbs", "label": "Carbohydrates", "type": "select", "options": LEVELS,
         "heading": "Diet — how today's eating went"},
        {"key": "dietFats", "label": "Fats", "type": "select", "options": LEVELS},
        {"key": "dietProtein", "label": "Protein", "type": "select", "options": LEVELS},
        {"key": "dietFibre", "label": "Fibre", "type": "select", "options": LEVELS},
    ]},
    {"key": "skin", "group": "Skin & hair", "fields": [
        {"key": "acne", "label": "Acne (new breakouts)", "type": "bool"},
        {"key": "hairGrowth", "label": "Hair growth", "type": "bool"},
        {"key": "hairLoss", "label": "Hair loss", "type": "bool"},
        {"key": "dryPatches", "label": "Dry patches", "type": "bool"},
        {"key": "hyperpigmentation", "label": "Hyperpigmentation", "type": "bool"},
    ]},
]

# Where pain gets reported, as places a person would name out loud, each mapped
# to a point on the body drawing (fractions of its 100x205 box). Speech can't
# give coordinates, so the model returns names from this list and the server
# turns them into markers — the same markers a tap would leave.
PAIN_REGIONS = [
    ("head",          "head",           "front", 0.50, 0.07),
    ("jaw",           "jaw",            "front", 0.50, 0.11),
    ("neck",          "neck",           "front", 0.50, 0.14),
    ("chest",         "chest",          "front", 0.50, 0.28),
    ("breasts",       "breasts",        "front", 0.42, 0.30),
    ("upper abdomen", "upper abdomen",  "front", 0.50, 0.41),
    ("lower abdomen", "lower abdomen",  "front", 0.50, 0.50),
    ("pelvis",        "pelvis",         "front", 0.50, 0.55),
    ("left side",     "left side",      "front", 0.38, 0.44),
    ("right side",    "right side",     "front", 0.62, 0.44),
    ("thighs",        "thighs",         "front", 0.42, 0.65),
    ("knees",         "knees",          "front", 0.43, 0.75),
    ("calves",        "calves",         "front", 0.43, 0.85),
    ("shoulders",     "shoulders",      "back",  0.36, 0.24),
    ("upper back",    "upper back",     "back",  0.50, 0.29),
    ("lower back",    "lower back",     "back",  0.50, 0.46),
    ("hips",          "hips",           "back",  0.38, 0.54),
    ("tailbone",      "tailbone",       "back",  0.50, 0.56),
]
PAIN_NAMES = [key for key, *_ in PAIN_REGIONS]


def pain_points(names):
    """Named areas from speech turned into markers on the drawing."""
    by_name = {key: (view, x, y) for key, _, view, x, y in PAIN_REGIONS}
    out = []
    for raw in (names or []):
        key = str(raw).strip().lower()
        hit = by_name.get(key)
        if hit is None:                       # "my lower tummy" -> lower abdomen
            hit = next((v for k, v in by_name.items() if k in key or key in k), None)
            key = next((k for k in by_name if k in str(raw).lower() or str(raw).lower() in k), key)
        if hit and not any(p["label"] == key for p in out):
            view, x, y = hit
            out.append({"view": view, "x": x, "y": y, "label": key})
    return out[:6]


# ---- views onto the schema, so nothing downstream re-lists the fields --------
CATEGORIES = [(g["key"], g["group"]) for g in SCHEMA]
FIELDS = {g["key"]: [f["key"] for f in g["fields"]] for g in SCHEMA}
FIELD_CATEGORY = {f["key"]: g["key"] for g in SCHEMA for f in g["fields"]}
FIELD_LABEL = {f["key"]: f["label"] for g in SCHEMA for f in g["fields"]}


def field(key):
    return next((f for g in SCHEMA for f in g["fields"] if f["key"] == key), None)


def prompt_lines():
    """The field list as the voice extractor should see it: one line each,
    naming the type and what an answer may be."""
    out = []
    for group in SCHEMA:
        for f in group["fields"]:
            bits = [f["key"], f["type"]]
            if f.get("options"):
                opts = f["options"]
                bits.append("|".join(str(o["value"]) if isinstance(o, dict) else str(o) for o in opts))
            elif f["type"] == "scale":
                bits.append(f"0-{f['max']}")
            out.append(" ".join(bits))
    return out


# Fields the voice extractor can fill. A body map needs taps, not speech.
EXTRACTABLE = [f for g in SCHEMA for f in g["fields"] if f["type"] != "bodymap"]
# Everything answered on the 0..10 axis, which is what the clamp applies to.
SCALE_FIELDS = {f["key"] for f in EXTRACTABLE if f["type"] in ("scale", "emoji")}


def extract_shape():
    """The JSON shape the voice extractor must return, generated from the schema
    so a new field is listened for the moment it is added above."""
    parts = ['"painAreas":[' + "|".join(PAIN_NAMES) + "] (names only, [] if none)"]
    for f in EXTRACTABLE:
        if f["type"] == "bool":
            spec = "true|false|null"
        elif f["type"] == "select":
            spec = '"' + "|".join(f["options"]) + '"|null'
        elif f["type"] in ("scale", "emoji"):
            spec = f"0-{SCALE_MAX}|null"
        elif f["type"] == "number":
            spec = "number|null"
        else:
            spec = "str|null"
        parts.append(f'"{f["key"]}":{spec}')
    return ",".join(parts)
