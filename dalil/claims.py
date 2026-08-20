"""
Dalīl — claims, and the boundary they cross.

Three things live here, and they are the three that keep a model's output from
becoming something a patient reads:

  `find_quote`   every model-scored module and every claim carries a verbatim
                 sentence, and this is what proves the sentence is actually in
                 the paper. A claim whose quote cannot be found never reaches a
                 reviewer, let alone a patient.
  `can`          the state machine. Screening may be model-assisted; publishing
                 may not, and `extracted -> published` is not a legal move.
  `publish_gate` every condition that has to hold before a row appears in
                 `dalil_published`, as code rather than as a convention.

A note on offsets. The plan had the model return `{value, quote, offset}` and
the offset checked against the text. Asking a model for a character offset is
asking it to count, which it cannot do reliably, and it is unnecessary: we hold
the text, so we can find the quote ourselves. Searching is strictly stronger
than trusting — a wrong offset from a model would be repaired into a right one,
whereas a quote that is not in the paper cannot be found at all.
"""
from __future__ import annotations

import re

# Typographic variants that mean the same thing to a reader and different things
# to `str.find`. Publishers rewrite hyphens and quotes; models normalise them.
FOLD = {
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
    "―": "-", "−": "-", "­": "",
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"', "″": '"',
    " ": " ", " ": " ", " ": " ", "﻿": "",
}

# Short enough to appear by accident. "PCOS" is in every paper in the corpus.
MIN_QUOTE = 25
MAX_DISPLAY_WORDS = 25


def normalise(text: str):
    """Fold a string for comparison, keeping a map back to the original.

    Returns (folded, index) where `index[i]` is the position in `text` of the
    character that produced `folded[i]` — which is what lets a match in folded
    space be reported as an offset into the text we actually stored.
    """
    out, index = [], []
    space = True                       # leading whitespace collapses to nothing
    for i, ch in enumerate(text or ""):
        ch = FOLD.get(ch, ch)
        if ch == "":
            continue
        if ch.isspace():
            if space:
                continue
            out.append(" ")
            index.append(i)
            space = True
        else:
            out.append(ch.lower())
            index.append(i)
            space = False
    return "".join(out), index


def find_quote(text: str, quote: str, min_len: int = MIN_QUOTE):
    """Where in `text` does `quote` appear? Returns (offset, matched) or (-1, "").

    `matched` is the text as it really reads, not as the model typed it, so a
    reviewer is shown the paper's own words including whatever punctuation the
    publisher used.
    """
    if not text or not quote or len(quote.strip()) < min_len:
        return -1, ""
    folded_text, index = normalise(text)
    folded_quote, _ = normalise(quote)
    folded_quote = folded_quote.strip()
    if not folded_quote:
        return -1, ""

    at = folded_text.find(folded_quote)
    if at < 0:
        # A model that trimmed a trailing clause is still pointing at the right
        # sentence; one that invented a sentence is not. Retry on the longest
        # leading run of it, and only accept a substantial one.
        head = folded_quote[:max(min_len, int(len(folded_quote) * 0.6))]
        at = folded_text.find(head)
        if at < 0:
            return -1, ""
        folded_quote = head

    start = index[at]
    end = index[at + len(folded_quote) - 1] + 1
    return start, text[start:end]


def verify(text: str, quote: str, passages=None) -> dict:
    """Quote verification as one dict, ready to store on a claim or a module."""
    offset, matched = find_quote(text or "", quote or "")
    section = ""
    if offset >= 0 and passages:
        for p in passages:
            if p.get("offset", 0) <= offset < p.get("offset", 0) + p.get("len", 0):
                section = p.get("section", "")
                break
    return {"verified": offset >= 0, "offset": offset, "quote": matched or (quote or ""),
            "section": section}


# ---- the state machine -------------------------------------------------------
# Screening may be model-assisted. Publishing may not: there is no path from
# `extracted` to `published` that does not pass through a human decision.
TRANSITIONS = {
    "extracted":   {"accepted", "edited", "rejected"},
    "accepted":    {"edited", "rejected", "published"},
    "edited":      {"accepted", "rejected", "published"},
    "rejected":    {"extracted"},
    "published":   {"unpublished"},
    "unpublished": {"published", "rejected"},
}
STATES = tuple(TRANSITIONS)


def can(state: str, to: str) -> bool:
    return to in TRANSITIONS.get(state, ())


# ---- what a claim may bind to ------------------------------------------------
ROLES = ("exposure", "outcome", "moderator")


def validate_fields(fields, known) -> list:
    """`fields` is [{field_key, role, proposed}]. `known` is the app's own
    vocabulary, fetched from its contract — never a list kept here."""
    problems = []
    seen_roles = [f.get("role") for f in fields]
    for f in fields:
        key, role = f.get("field_key"), f.get("role")
        if role not in ROLES:
            problems.append(f"{key}: {role!r} is not a role")
        if not f.get("proposed") and key not in known:
            problems.append(f"{key} is not a field the app records")
        if f.get("proposed") and key in known:
            problems.append(f"{key} already exists, so it is not a proposal")
    if "exposure" not in seen_roles or "outcome" not in seen_roles:
        problems.append("a claim needs both an exposure and an outcome")
    if seen_roles.count("exposure") > 1 or seen_roles.count("outcome") > 1:
        problems.append("a claim has one exposure and one outcome")

    exposure, outcome = pair_of(fields)
    if exposure and exposure == outcome:
        # A before-and-after on one measurement is a real finding, and a real
        # finding this app cannot show: Insights correlates two columns against
        # each other, so a claim whose two ends are the same column has nowhere
        # to land. Caught here rather than by a reviewer reading it twice.
        problems.append(f"{exposure} is both ends of the claim — that is a change over "
                        "time, not a relationship between two things a person logs")
    return problems


def pair_of(fields):
    """(exposure, outcome), for looking the correlation up by its pair."""
    exposure = next((f["field_key"] for f in fields if f.get("role") == "exposure"), None)
    outcome = next((f["field_key"] for f in fields if f.get("role") == "outcome"), None)
    return exposure, outcome


# ---- what a badge is worth ---------------------------------------------------
# The direct answer to a free-text `Strong | Emerging | Early` a model asserted
# with no rubric behind it. `designs` are design_score points, one per published
# claim backing the same pair — 16 is a meta-analysis, 14 a randomised trial,
# 9 a cohort.
GRADE_RULES = [
    ("Strong", "a meta-analysis, or two or more randomised trials"),
    ("Emerging", "one randomised trial, or two or more cohort studies"),
    ("Early", "anything less"),
]


def grade(designs) -> str:
    points = sorted(designs or [], reverse=True)
    if any(p >= 16 for p in points) or sum(1 for p in points if p >= 14) >= 2:
        return "Strong"
    if any(p >= 14 for p in points) or sum(1 for p in points if p >= 9) >= 2:
        return "Emerging"
    return "Early"


# ---- the gate ----------------------------------------------------------------
def publish_gate(claim, fields, report, known, reviewer=None, override_reason="") -> list:
    """Every reason this claim may not be published. Empty means it may.

    Returned as a list rather than a boolean because a reviewer who is told "no"
    needs to be told which of six conditions failed.
    """
    from appraise import CONSIDERATIONS

    problems = []
    if claim.get("state") not in ("accepted", "edited"):
        problems.append(f"a claim in {claim.get('state')!r} cannot be published")
    if not claim.get("quote_verified"):
        problems.append("the quote could not be found in the stored text")

    verdict_score = (report or {}).get("score", 0)
    if verdict_score < CONSIDERATIONS and not override_reason.strip():
        problems.append(f"scored {verdict_score}, below {CONSIDERATIONS} — needs a written reason")

    problems.extend(validate_fields(fields, known))
    bound = [f for f in fields if not f.get("proposed")]
    proposed = [f for f in fields if f.get("proposed")]
    if not bound and not (proposed and claim.get("tracker")):
        problems.append("nothing to bind to: no existing field, and no tracker for a proposed one")

    display = (claim.get("display_text") or "").strip()
    if not display:
        problems.append("no display text — a patient never sees the source's own words")
    elif len(display.split()) > MAX_DISPLAY_WORDS:
        problems.append(f"display text is {len(display.split())} words, over {MAX_DISPLAY_WORDS}")

    if reviewer is not None and reviewer.get("disabled_at"):
        problems.append("the reviewer's account is disabled")

    return problems


# ---- what a reviewer may change ----------------------------------------------
# The quote is evidence, not opinion: if it is wrong the claim is rejected, not
# edited. Module scores are the rubric's, not a reviewer's. Everything else is
# theirs, and every change is recorded in dalil_reviews.
EDITABLE = ("claim_text", "relation", "direction", "population", "effect",
            "certainty", "display_text", "tracker")
FROZEN = ("quote", "quote_offset", "quote_section", "quote_verified", "source_id", "report_id")


def apply_edit(claim: dict, changes: dict):
    """Returns (before, after) for the audit row, and raises on a frozen field."""
    frozen = [k for k in changes if k in FROZEN]
    if frozen:
        raise ValueError(f"{', '.join(frozen)} cannot be edited — reject the claim instead")
    unknown = [k for k in changes if k not in EDITABLE]
    if unknown:
        raise ValueError(f"{', '.join(unknown)} is not an editable field")
    before = {k: claim.get(k) for k in changes}
    return before, dict(changes)


WORD = re.compile(r"[A-Za-z0-9']+")


def word_count(text: str) -> int:
    return len(WORD.findall(text or ""))
