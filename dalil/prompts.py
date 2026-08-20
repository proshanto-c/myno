"""
Dalīl — the prompt text, versioned.

Kept in a module rather than a directory of files because the image copies
`*.py` flat, and kept apart from the code that sends it because the version and
the hash are the point: `test_appraise.py` asserts the recorded hash matches
the live text, so editing a prompt without bumping its version fails the tests.
That is the same forcing function `test_api.py` already applies to the guideline
thresholds — a prompt that quietly changed would silently re-grade a corpus.
"""
import hashlib
import json

APPRAISE_VERSION = "2"


def hash_of(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


APPRAISE_SYSTEM = """\
You appraise health research for one particular purpose, and that purpose \
decides every judgement you make.

Tawaazun is a tracker for polyendocrine metabolic ovarian syndrome (PMOS, until \
recently called polycystic ovary syndrome). People record a short list of things \
about each day, by talking, and the app looks for patterns across those days. A \
study is useful here exactly to the extent that a claim from it could be shown \
beside a pattern in somebody's own daily log. A flawless randomised trial of an \
ultrasound measurement scores badly on this rubric, because nobody can log an \
ultrasound every morning.

You are given a paper's text. You return five module scores and any claims it \
supports.

## Rules that are not negotiable

1. Every module score and every claim carries `quote`: a span copied character \
for character out of the text you were given. Do not paraphrase it, do not join \
two sentences with an ellipsis, do not tidy a typo, do not translate. The quote \
is checked against the stored text by exact search. A quote that cannot be found \
scores zero and its claim is destroyed before any human sees it, so an invented \
quote costs you the point you were trying to win.
2. If the text does not support a module, score it 0 and say why in `note`. A \
guess is worth less than a zero, because a zero is honest.
3. Claims bind to the field keys you are given and to nothing else. If a paper \
is about something the app does not record, use a short camelCase key of your \
own for that side and give a `tracker_label` naming what a person would have to \
log; it is stored as a proposal for a human to accept or ignore.
4. `relation` states what the study design establishes, not what its authors \
hope. A cross-sectional survey supports `associated_with`. It never supports \
`increases` or `reduces`, whatever the discussion section says.
5. Prefer no claim to a weak one. Two well-evidenced claims beat nine thin ones; \
a reviewer's time is the scarce thing here.

## The modules

**measurement** (0-12) — Could both sides of the finding be recorded by somebody \
answering a few questions about their day? 12 when both map onto fields in the \
list. 8 when one side needs a cheap home device such as a scale. 4 when it needs \
a blood test or a scan. 0 when it is not self-reportable at all.

**effect** (0-10) — Is there a stated effect with a number, a direction that \
cannot be read two ways, and an interval or a p-value? 10 for all three. 5 for a \
direction and a number without precision. 0 for "was associated with" and \
nothing else.

**daily** (0-10) — Does the thing vary day to day, so a daily log could see it? \
10 for sleep, pain, mood, cravings. 5 for something that moves over weeks, like \
weight. 0 for a fixed trait, a diagnosis, or a once-in-a-lifetime outcome.

**confounding** (0-8) — Did they adjust for the obvious — BMI, age, insulin \
status, medication? 8 for adjusted analyses named in the text. 4 for some \
adjustment. 0 for none, and 0 as well if they use causal language on \
cross-sectional data, which is a failure of honesty rather than of method.

**sample** (n) — Report the number of participants the analysis was actually run \
on as `n`, or null if the text does not say. Do not score this one; the banding \
is arithmetic and happens outside you. Quote the sentence the number is in.

## Claims

A claim is one relationship between two things a person could record, stated so \
plainly that somebody with the condition and no training could tell whether it \
matches their own data. `claim_text` is yours to write; `quote` is the paper's.
"""

# The schema is flat on purpose, and this is not a style preference.
#
# The first version nested each module as {score, note, quote}. Opus filled it
# by emitting `"measurement": "\n<parameter name=\"score\">2"` and hoisting
# `note` and `quote` to the top level — the nesting was flattened on the way
# out, and every module scored zero as a result. Three scalars per module
# cannot be flattened wrongly, because there is nothing left to flatten.
#
# `claims` stays an array of objects: a list of repeated things is a shape that
# survives, and there is no fixed number of claims to flatten it into. Its own
# effect numbers are flat inside each item for the same reason as above.
MODULE_MAXIMUMS = {"measurement": 12, "effect": 10, "daily": 10, "confounding": 8}


def _module_props():
    props = {}
    for key, top in MODULE_MAXIMUMS.items():
        props[f"{key}_score"] = {"type": "integer", "minimum": 0, "maximum": top}
        props[f"{key}_note"] = {"type": "string"}
        props[f"{key}_quote"] = {"type": "string",
                                 "description": "copied character for character from the text"}
    return props


APPRAISE_TOOL = {
    "name": "appraisal",
    "description": "Return the module scores and any claims this paper supports.",
    "input_schema": {
        "type": "object",
        "properties": {
            **_module_props(),
            "sample_n": {"type": ["integer", "null"],
                         "description": "participants the analysis was run on, or null"},
            "sample_note": {"type": "string"},
            "sample_quote": {"type": "string"},
            "narrative": {"type": "string",
                          "description": "Three or four sentences a reviewer reads first: "
                                         "what the paper found, and what it is worth here."},
            "claims": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "claim_text": {"type": "string"},
                        "relation": {"type": "string",
                                     "enum": ["associated_with", "predicts", "increases",
                                              "reduces", "no_effect"]},
                        "direction": {"type": "string", "enum": ["+", "-", "0"]},
                        "population": {"type": "string"},
                        "exposure_field": {"type": "string"},
                        "outcome_field": {"type": "string"},
                        "moderator_field": {"type": ["string", "null"]},
                        "tracker_label": {"type": ["string", "null"]},
                        "effect_measure": {"type": "string"},
                        "effect_value": {"type": ["number", "null"]},
                        "effect_ci_low": {"type": ["number", "null"]},
                        "effect_ci_high": {"type": ["number", "null"]},
                        "effect_p": {"type": ["number", "null"]},
                        "certainty": {"type": "string",
                                      "enum": ["high", "moderate", "low", "very_low"]},
                        "quote": {"type": "string"},
                    },
                    "required": ["claim_text", "relation", "direction", "population",
                                 "exposure_field", "outcome_field", "certainty", "quote"]},
            },
        },
        "required": [*_module_props(), "sample_n", "sample_note", "sample_quote",
                     "claims", "narrative"],
    },
}

# The tool is part of the prompt: change its shape and the model answers
# differently, so the version has to move with it.
APPRAISE_HASH = hash_of(APPRAISE_SYSTEM + json.dumps(APPRAISE_TOOL, sort_keys=True))
