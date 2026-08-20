"""
Dalīl — the rubric.

Ten modules, weights summing to 100, scoring a paper for one particular purpose:
*is this usable as evidence behind a claim shown to somebody tracking their own
days?* That is a narrower question than "is this good research", and modules 3
and 5 are the ones that make it this product's rubric rather than a generic
appraisal checklist — a perfect randomised trial of an ultrasound finding scores
badly here, because nobody can log it.

**52 of the 100 points never touch a model.** Study design, population, the
integrity gate, corroboration and recency are all read from PubMed's own
metadata and from the corpus, so two runs of the same paper score identically
and a reviewer arguing with a score is arguing with a rubric rather than with a
sampling temperature. The other 48 are model-scored, and every one of them has
to carry a verbatim quote that `claims.find_quote` can locate in the stored
text — a module whose quote cannot be found scores zero.

Pure: no database, no network, no model call. Everything it needs arrives as an
argument, which is why it can be tested against fixtures.
"""
from __future__ import annotations

import re

RUBRIC_VERSION = "1"

# Bands. A rubric is not a law: below CONSIDERATIONS the portal blocks
# publishing, while the database permits it with a written `override_reason`,
# and the override is recorded.
MEETS = 70
CONSIDERATIONS = 45

MODULES = [
    {"key": "design",        "label": "Study design",                 "weight": 16, "basis": "deterministic"},
    {"key": "population",    "label": "Population match",             "weight": 12, "basis": "deterministic"},
    {"key": "measurement",   "label": "Measurement compatibility",    "weight": 12, "basis": "model"},
    {"key": "effect",        "label": "Effect clarity",               "weight": 10, "basis": "model"},
    {"key": "daily",         "label": "Daily-tracking applicability", "weight": 10, "basis": "model"},
    {"key": "integrity",     "label": "Integrity gate",               "weight": 10, "basis": "gate"},
    {"key": "sample",        "label": "Sample and power",             "weight": 8,  "basis": "model"},
    {"key": "confounding",   "label": "Confounding honesty",          "weight": 8,  "basis": "model"},
    {"key": "corroboration", "label": "Corroboration in corpus",      "weight": 8,  "basis": "deterministic"},
    {"key": "independence",  "label": "Independence and recency",     "weight": 6,  "basis": "deterministic"},
]
WEIGHTS = {m["key"]: m["weight"] for m in MODULES}
MODEL_MODULES = [m["key"] for m in MODULES if m["basis"] == "model"]


# ---- module 1: study design --------------------------------------------------
# Publication types and MeSH descriptors both carry design, and neither carries
# all of it: "Cohort Studies" is a MeSH heading, "Randomized Controlled Trial" is
# a publication type. Both are read, and the best match wins.
DESIGN = [
    (16, {"meta-analysis", "systematic review"}, "systematic review or meta-analysis"),
    (14, {"randomized controlled trial"}, "randomised controlled trial"),
    (13, {"guideline", "practice guideline", "consensus statement",
          "consensus development conference"}, "consensus guideline — synthesis, not primary evidence"),
    (12, {"clinical trial", "controlled clinical trial"}, "non-randomised clinical trial"),
    (11, {"prospective studies"}, "prospective cohort"),
    (9,  {"cohort studies", "longitudinal studies", "follow-up studies",
          "retrospective studies"}, "cohort"),
    (8,  {"case-control studies"}, "case-control"),
    (6,  {"cross-sectional studies", "observational study"}, "cross-sectional or unspecified observational"),
    (4,  {"review"}, "narrative review"),
    (3,  {"case reports"}, "case report or series"),
    (2,  {"study guide"}, "reference chapter or study guide"),
]


def design_score(pub_types, mesh, kind="article"):
    terms = {t.lower() for t in list(pub_types or []) + list(mesh or [])}
    if "animals" in terms and "humans" not in terms:
        return 0, "animal or in-vitro work"
    for points, markers, note in DESIGN:
        if terms & markers:
            return points, note
    if kind == "chapter":
        return 2, "reference chapter or study guide"
    # "Journal Article" and nothing else. Not a reason to score it as weak
    # evidence, but not a reason to credit a design the record does not claim.
    return 5, "design not stated in the record"


# ---- module 2: population ----------------------------------------------------
ADULT_FEMALE = {"adult", "young adult", "middle aged", "adolescent", "female"}
PMOS_TEXT = re.compile(r"polycystic ovar|polyendocrine metabolic ovarian|\bpcos\b|\bpmos\b", re.I)


def population_score(mesh, title="", abstract=""):
    terms = {m.lower() for m in mesh or []}
    if "animals" in terms and "humans" not in terms:
        return 0, "not a human population"
    if "polycystic ovary syndrome" in terms:
        return 12, "indexed as a study of the condition itself"
    if PMOS_TEXT.search(f"{title} {abstract}"):
        # Recent records are often not yet MeSH-indexed, and the newest papers
        # are the half most worth having — see the human filter in harvest.py.
        return 10, "names the condition, not yet MeSH-indexed"
    if terms & ADULT_FEMALE:
        return 6, "women of reproductive age, but not this condition"
    if "humans" in terms:
        return 3, "a human population, otherwise unrelated"
    return 2, "population not stated"


# ---- module 6: the gate ------------------------------------------------------
def integrity_score(retracted):
    return (0, "retracted") if retracted else (10, "no retraction on record")


# ---- module 9: corroboration -------------------------------------------------
def corroboration_score(cited_by):
    """How many sources already in the corpus cite this one.

    A paper that a dozen of our own sources lean on is load-bearing in this
    literature; one nothing cites may still be right, but it is on its own.
    Rises as the library grows, which is the intended behaviour.
    """
    for threshold, points in ((10, 8), (5, 6), (2, 4), (1, 2)):
        if cited_by >= threshold:
            return points, f"cited by {cited_by} sources already held"
    return 0, "nothing else in the corpus cites it"


# ---- module 10: independence and recency -------------------------------------
NO_CONFLICT = re.compile(
    r"no (conflict|competing|potential conflict|financial)|nothing to disclose|"
    r"nothing to declare|none declared|declare no", re.I)


def independence_score(year, coi, year_now):
    age = None if not year else max(0, year_now - year)
    if age is None:
        recency, why = 0, "undated"
    elif age <= 3:
        recency, why = 3, f"{age}y old"
    elif age <= 7:
        recency, why = 2, f"{age}y old"
    elif age <= 12:
        recency, why = 1, f"{age}y old"
    else:
        recency, why = 0, f"{age}y old"

    text = (coi or "").strip()
    if not text:
        # Unstated is not the same as clean, and not the same as conflicted.
        independence, note = 2, "no conflict statement"
    elif NO_CONFLICT.search(text):
        independence, note = 3, "declares no conflict"
    else:
        independence, note = 1, "declares a conflict"
    return recency + independence, f"{why}, {note}"


# ---- flags -------------------------------------------------------------------
PROTOCOL = {"clinical trial protocol"}
PREPRINT = {"preprint"}


def flags_for(source, verified_fraction, contradicts=()):
    """Red regardless of score. `contradicts_published` is the one a reviewer
    most needs and no model can be trusted to raise, so it is computed by
    looking for a published claim on the same pair running the other way."""
    out = []
    types = {t.lower() for t in source.get("pub_types") or []}
    if source.get("retracted"):
        out.append("retracted")
    if types & PROTOCOL:
        out.append("protocol_only")          # a protocol reports no findings at all
    if types & PREPRINT:
        out.append("preprint")
    if not (source.get("abstract") or "").strip() and not (source.get("fulltext") or "").strip():
        out.append("no_text")
    elif not (source.get("abstract") or "").strip():
        out.append("no_abstract")
    if verified_fraction is not None and verified_fraction < 1.0:
        out.append("quote_unverified")
    for flag in source.get("flags") or []:
        if flag not in out:
            out.append(flag)                 # id_mismatch, raised during harvest
    for pair in contradicts:
        out.append(f"contradicts_published:{pair}")
    return out


# ---- putting it together ------------------------------------------------------
def band(score):
    if score >= MEETS:
        return "meets"
    return "considerations" if score >= CONSIDERATIONS else "does_not_meet"


def sample_band(n):
    """The model reads the number; the banding is arithmetic."""
    if n is None:
        return 0, "sample size not stated"
    for threshold, points in ((1000, 8), (300, 6), (100, 4), (30, 2)):
        if n >= threshold:
            return points, f"n = {n:,}"
    return 1, f"n = {n:,} — small"


def appraise(source, model=None, cited_by=0, year_now=2026, contradicts=()):
    """One source in, one report out.

    `model` is whatever `model.appraise()` returned, already quote-verified —
    each entry `{score, note, quote, offset, verified}`. Passing None scores the
    deterministic half alone, which is what a corpus-wide first pass does before
    anybody spends a token.
    """
    model = model or {}
    rows = []

    points, note = design_score(source.get("pub_types"), source.get("mesh"), source.get("kind", "article"))
    rows.append(_row("design", points, note))

    points, note = population_score(source.get("mesh"), source.get("title", ""),
                                    source.get("abstract", ""))
    rows.append(_row("population", points, note))

    points, note = integrity_score(source.get("retracted"))
    rows.append(_row("integrity", points, note))

    points, note = corroboration_score(cited_by)
    rows.append(_row("corroboration", points, note))

    points, note = independence_score(source.get("year"), source.get("coi"), year_now)
    rows.append(_row("independence", points, note))

    for key in MODEL_MODULES:
        got = model.get(key) or {}
        weight = WEIGHTS[key]
        if key == "sample" and got.get("n") is not None and got.get("verified"):
            points, note = sample_band(got["n"])
        elif not got.get("verified"):
            # An unverifiable quote is not a low score, it is no score: the
            # module claimed something the paper does not say where it says it.
            points = 0
            note = got.get("note") or "no quote that could be found in the text"
        else:
            points = max(0, min(weight, int(round(got.get("score", 0)))))
            note = got.get("note", "")
        rows.append(_row(key, points, note, quote=got.get("quote", ""),
                         offset=got.get("offset", -1), section=got.get("section", "")))

    order = [m["key"] for m in MODULES]
    rows.sort(key=lambda r: order.index(r["key"]))

    asked = [r for r in rows if WEIGHTS[r["key"]] and r["basis"] == "model"]
    verified = [r for r in asked if r.get("offset", -1) >= 0]
    fraction = (len(verified) / len(asked)) if asked else None

    total = sum(r["score"] for r in rows)
    # The gate is a gate: a retracted paper does not get a score with a caveat.
    verdict = "does_not_meet" if source.get("retracted") else band(total)

    return {"rubricVersion": RUBRIC_VERSION, "score": total, "verdict": verdict,
            "modules": rows, "flags": flags_for(source, fraction, contradicts),
            "verified": {"of": len(asked), "found": len(verified)},
            "scored": "full" if model else "deterministic only"}


def _row(key, score, note, quote="", offset=-1, section=""):
    module = next(m for m in MODULES if m["key"] == key)
    return {"key": key, "label": module["label"], "weight": module["weight"],
            "basis": module["basis"], "score": score, "note": note,
            "quote": quote, "offset": offset, "section": section}
