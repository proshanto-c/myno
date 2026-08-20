"""
The rubric, tested as arithmetic.

Run:  docker compose exec -T dalil python test_appraise.py

No database, no network, no model call — `appraise.py` is pure, which is the
whole reason it can be tested this way and the reason two runs of the same paper
score the same.
"""
import appraise
import prompts

T = []
test = lambda fn: (T.append((fn.__name__, fn)), fn)[1]


def paper(**kw):
    base = {"title": "Sleep quality in polycystic ovary syndrome", "abstract": "An abstract.",
            "journal": "J Test", "year": 2024, "kind": "article",
            "pub_types": ["Journal Article"], "mesh": ["Polycystic Ovary Syndrome", "Humans", "Female"],
            "coi": "", "retracted": False, "flags": [], "fulltext": "", "licence": ""}
    base.update(kw)
    return base


def model(measurement=12, effect=10, daily=10, confounding=8, n=500, verified=True):
    each = lambda score: {"score": score, "note": "", "quote": "q", "offset": 0 if verified else -1,
                          "verified": verified}
    return {"measurement": each(measurement), "effect": each(effect), "daily": each(daily),
            "confounding": each(confounding),
            "sample": {"n": n, "note": "", "quote": "q", "offset": 0 if verified else -1,
                       "verified": verified}}


# ---- the shape of the rubric -------------------------------------------------
@test
def test_the_weights_sum_to_one_hundred():
    assert sum(m["weight"] for m in appraise.MODULES) == 100


@test
def test_more_than_half_the_score_never_touches_a_model():
    machine = sum(m["weight"] for m in appraise.MODULES if m["basis"] in ("deterministic", "gate"))
    assert machine == 52, machine
    assert sum(appraise.WEIGHTS[k] for k in appraise.MODEL_MODULES) == 48


@test
def test_every_module_key_is_unique_and_appears_in_a_report():
    keys = [m["key"] for m in appraise.MODULES]
    assert len(set(keys)) == len(keys)
    report = appraise.appraise(paper(), model=model())
    assert [r["key"] for r in report["modules"]] == keys, "a report dropped or reordered a module"


@test
def test_a_report_scores_the_same_twice():
    a = appraise.appraise(paper(), model=model(), cited_by=3, year_now=2026)
    b = appraise.appraise(paper(), model=model(), cited_by=3, year_now=2026)
    assert a["score"] == b["score"]
    assert a["modules"] == b["modules"]


# ---- module 1: design --------------------------------------------------------
@test
def test_design_reads_publication_types_and_mesh_alike():
    # "Randomized Controlled Trial" is a publication type…
    assert appraise.design_score(["Randomized Controlled Trial"], [])[0] == 14
    # …while "Cohort Studies" is a MeSH heading, and neither list has both
    assert appraise.design_score(["Journal Article"], ["Cohort Studies"])[0] == 9
    assert appraise.design_score(["Journal Article"], ["Cross-Sectional Studies"])[0] == 6


@test
def test_the_best_design_claimed_is_the_one_that_counts():
    points, _ = appraise.design_score(
        ["Journal Article", "Meta-Analysis", "Review"], ["Cross-Sectional Studies"])
    assert points == 16, "a meta-analysis scored as its weakest label"


@test
def test_each_rung_of_the_ladder_is_reachable():
    seen = {appraise.design_score(list(markers), [])[0] for _, markers, _ in appraise.DESIGN}
    assert seen == {p for p, _, _ in appraise.DESIGN}, "a tier can never be scored"


@test
def test_animal_work_scores_nothing_whatever_else_it_says():
    points, note = appraise.design_score(["Randomized Controlled Trial"], ["Animals"])
    assert points == 0
    assert "animal" in note
    # but a study in both is a study in humans
    assert appraise.design_score(["Randomized Controlled Trial"], ["Animals", "Humans"])[0] == 14


@test
def test_an_unclassified_article_is_neither_credited_nor_punished():
    points, note = appraise.design_score(["Journal Article"], [])
    assert points == 5
    assert "not stated" in note


@test
def test_a_reference_chapter_is_worth_two():
    assert appraise.design_score(["Study Guide"], [])[0] == 2
    assert appraise.design_score([], [], kind="chapter")[0] == 2


# ---- module 2: population ----------------------------------------------------
@test
def test_the_population_ladder():
    assert appraise.population_score(["Polycystic Ovary Syndrome"])[0] == 12
    # not yet indexed, but it says so in the title
    assert appraise.population_score(["Humans"], title="Sleep in PCOS")[0] == 10
    assert appraise.population_score(["Humans", "Adult", "Female"])[0] == 6
    assert appraise.population_score(["Humans"])[0] == 3
    assert appraise.population_score([])[0] == 2
    assert appraise.population_score(["Animals"])[0] == 0


@test
def test_the_new_name_counts_as_the_condition():
    for text in ("polyendocrine metabolic ovarian syndrome", "PMOS", "polycystic ovary"):
        assert appraise.population_score(["Humans"], title=text)[0] == 10, text


# ---- module 6: the gate ------------------------------------------------------
@test
def test_a_retraction_zeroes_the_gate_and_the_verdict():
    report = appraise.appraise(paper(retracted=True), model=model(), cited_by=20, year_now=2024)
    gate = next(m for m in report["modules"] if m["key"] == "integrity")
    assert gate["score"] == 0
    assert "retracted" in report["flags"]
    # and it does not get a good score with a caveat attached
    assert report["verdict"] == "does_not_meet", report["score"]


# ---- module 9: corroboration -------------------------------------------------
@test
def test_corroboration_rises_with_the_library():
    assert appraise.corroboration_score(0)[0] == 0
    assert appraise.corroboration_score(1)[0] == 2
    assert appraise.corroboration_score(4)[0] == 4
    assert appraise.corroboration_score(5)[0] == 6
    assert appraise.corroboration_score(9)[0] == 6
    assert appraise.corroboration_score(10)[0] == 8
    assert appraise.corroboration_score(400)[0] == 8


# ---- module 10: independence and recency -------------------------------------
@test
def test_recency_bands_are_measured_from_the_year_given():
    at = lambda year: appraise.independence_score(year, "", 2026)[0]
    assert at(2026) == 3 + 2
    assert at(2023) == 3 + 2
    assert at(2022) == 2 + 2
    assert at(2019) == 2 + 2
    assert at(2018) == 1 + 2
    assert at(2013) == 0 + 2
    assert at(None) == 0 + 2


@test
def test_a_declared_conflict_costs_more_than_no_statement_at_all():
    declared = appraise.independence_score(2024, "AB has received fees from Novo Nordisk.", 2026)[0]
    silent = appraise.independence_score(2024, "", 2026)[0]
    clean = appraise.independence_score(2024, "The authors declare no competing interests.", 2026)[0]
    assert clean > silent > declared
    for phrasing in ("The authors report no conflicts of interest.", "Nothing to declare.",
                     "None declared.", "The authors declare no conflict of interest."):
        assert appraise.independence_score(2024, phrasing, 2026)[0] == 6, phrasing  # 3 recent + 3 clean


# ---- the model-scored half ---------------------------------------------------
@test
def test_an_unverifiable_quote_scores_nothing_at_all():
    report = appraise.appraise(paper(), model=model(verified=False))
    for key in appraise.MODEL_MODULES:
        row = next(m for m in report["modules"] if m["key"] == key)
        assert row["score"] == 0, f"{key} kept its points on an unfindable quote"
    assert "quote_unverified" in report["flags"]
    assert report["verified"] == {"of": 5, "found": 0}


@test
def test_a_module_cannot_score_above_its_weight():
    over = model(measurement=99, effect=99, daily=99, confounding=99)
    report = appraise.appraise(paper(), model=over)
    for key in ("measurement", "effect", "daily", "confounding"):
        row = next(m for m in report["modules"] if m["key"] == key)
        assert row["score"] == appraise.WEIGHTS[key], key
    assert report["score"] <= 100


@test
def test_the_sample_band_is_arithmetic_not_opinion():
    assert appraise.sample_band(None) == (0, "sample size not stated")
    assert appraise.sample_band(5000)[0] == 8
    assert appraise.sample_band(1000)[0] == 8
    assert appraise.sample_band(999)[0] == 6
    assert appraise.sample_band(300)[0] == 6
    assert appraise.sample_band(299)[0] == 4
    assert appraise.sample_band(100)[0] == 4
    assert appraise.sample_band(99)[0] == 2
    assert appraise.sample_band(30)[0] == 2
    assert appraise.sample_band(29)[0] == 1


@test
def test_a_report_without_a_model_scores_the_deterministic_half_alone():
    report = appraise.appraise(paper(), model=None, cited_by=12, year_now=2026)
    assert report["scored"] == "deterministic only"
    assert report["verified"] is None or report["verified"]["found"] == 0
    # 5 (unstated design) + 12 (population) + 10 (gate) + 8 (cited) + 5 (recent, silent)
    assert report["score"] == 40, report["score"]


# ---- bands -------------------------------------------------------------------
@test
def test_the_band_edges_are_where_the_constants_say():
    assert appraise.band(100) == "meets"
    assert appraise.band(70) == "meets"
    assert appraise.band(69) == "considerations"
    assert appraise.band(45) == "considerations"
    assert appraise.band(44) == "does_not_meet"
    assert appraise.band(0) == "does_not_meet"


@test
def test_a_strong_paper_meets_and_a_weak_one_does_not():
    strong = appraise.appraise(
        paper(pub_types=["Meta-Analysis"], year=2025,
              coi="The authors declare no competing interests."),
        model=model(), cited_by=12, year_now=2026)
    assert strong["verdict"] == "meets", strong["score"]

    weak = appraise.appraise(
        paper(pub_types=["Case Reports"], mesh=["Humans"], year=2004),
        model=model(measurement=0, effect=0, daily=0, confounding=0, n=12), cited_by=0,
        year_now=2026)
    assert weak["verdict"] == "does_not_meet", weak["score"]


# ---- flags -------------------------------------------------------------------
@test
def test_a_protocol_is_flagged_because_it_reports_nothing():
    report = appraise.appraise(paper(pub_types=["Clinical Trial Protocol"]), model=model())
    assert "protocol_only" in report["flags"]


@test
def test_flags_raised_during_harvest_survive_into_the_report():
    report = appraise.appraise(paper(flags=["id_mismatch"]), model=model())
    assert "id_mismatch" in report["flags"]


@test
def test_a_paper_with_no_text_says_so():
    report = appraise.appraise(paper(abstract="", fulltext=""), model=None)
    assert "no_text" in report["flags"]
    assert "no_abstract" not in report["flags"], "one flag, not two, for the same fact"


@test
def test_a_contradiction_is_carried_as_a_flag():
    report = appraise.appraise(paper(), model=model(), contradicts=["sleep->brainFog"])
    assert "contradicts_published:sleep->brainFog" in report["flags"]


# ---- the prompt --------------------------------------------------------------
@test
def test_the_prompt_hash_matches_the_prompt():
    """Editing the prompt without bumping its version fails here, so a corpus
    can never be half-graded under one wording and half under another."""
    import json as _json
    expected = prompts.hash_of(
        prompts.APPRAISE_SYSTEM + _json.dumps(prompts.APPRAISE_TOOL, sort_keys=True))
    assert prompts.APPRAISE_HASH == expected
    assert prompts.APPRAISE_VERSION, "a prompt with no version is not versioned"


# ---- the wire format ---------------------------------------------------------
@test
def test_a_flat_reply_is_reassembled_into_the_shape_a_report_is():
    import model
    out = model.reassemble({
        "measurement_score": 12, "measurement_note": "both loggable", "measurement_quote": "q1",
        "effect_score": 7, "effect_note": "a number", "effect_quote": "q2",
        "daily_score": 10, "daily_note": "varies", "daily_quote": "q3",
        "confounding_score": 4, "confounding_note": "some", "confounding_quote": "q4",
        "sample_n": 412, "sample_note": "stated", "sample_quote": "q5",
        "narrative": "A survey.", "claims": []})
    assert out["measurement"] == {"score": 12, "note": "both loggable", "quote": "q1"}
    assert out["sample"]["n"] == 412
    assert out["narrative"] == "A survey."


@test
def test_a_score_over_its_weight_is_clipped_on_the_way_in():
    import model
    out = model.reassemble({"effect_score": 99, "measurement_score": -4})
    assert out["effect"]["score"] == 10
    assert out["measurement"]["score"] == 0


@test
def test_a_number_written_as_a_sentence_is_still_a_number():
    import model
    for written, want in (("412", 412), ("n = 412", 412), ("1,107", 1107), (None, None),
                          ("not stated", None), (412, 412), (0.31, 0.31)):
        assert model.reassemble({"sample_n": written})["sample"]["n"] == want, written


@test
def test_a_claims_effect_is_gathered_back_up_from_its_flat_parts():
    import model
    out = model.reassemble({"claims": [{
        "claim_text": "Shorter sleep, more fog", "exposure_field": "sleep",
        "outcome_field": "brainFog", "direction": "-", "certainty": "low", "quote": "q",
        "effect_measure": "r", "effect_value": -0.31, "effect_p": 0.001}]})
    claim = out["claims"][0]
    assert claim["effect"] == {"measure": "r", "value": -0.31, "ci_low": None,
                               "ci_high": None, "p": 0.001}
    assert claim["moderator_field"] is None
    assert claim["relation"] == "associated_with", "a missing relation should not be blank"


@test
def test_a_reply_that_is_not_a_dictionary_reassembles_into_an_empty_report():
    import model
    for junk in (None, "a string", [1, 2, 3], 7):
        out = model.reassemble(junk)
        assert out["claims"] == []
        assert all(out[k]["score"] == 0 for k in prompts.MODULE_MAXIMUMS), junk


@test
def test_the_prompt_says_the_things_the_rubric_depends_on():
    text = prompts.APPRAISE_SYSTEM
    for demand in ("character for character", "quote", "tracker_label", "cross-sectional"):
        assert demand in text, f"the prompt no longer says {demand!r}"


@test
def test_the_tool_schema_asks_for_every_module_the_rubric_scores():
    props = prompts.APPRAISE_TOOL["input_schema"]["properties"]
    required = prompts.APPRAISE_TOOL["input_schema"]["required"]
    for key in appraise.MODEL_MODULES:
        want = f"{key}_n" if key == "sample" else f"{key}_score"
        assert want in props, f"the rubric scores {key} but the tool never asks for it"
        assert f"{key}_quote" in required, f"{key} could come back without a quote"
    for key, top in prompts.MODULE_MAXIMUMS.items():
        assert props[f"{key}_score"]["maximum"] == appraise.WEIGHTS[key], key
        assert top == appraise.WEIGHTS[key], f"{key}: the tool and the rubric disagree"


@test
def test_the_schema_stays_flat_because_nesting_did_not_survive_the_round_trip():
    """Opus filled a nested {score, note, quote} by writing
    `"measurement": "<parameter name=\\"score\\">2"` and hoisting the rest to the
    top level, so every module scored zero. Three scalars cannot be flattened."""
    props = prompts.APPRAISE_TOOL["input_schema"]["properties"]
    for key, spec in props.items():
        if key == "claims":
            continue                       # a list of repeated things survives
        assert spec.get("type") != "object", f"{key} is nested again"
    item = props["claims"]["items"]["properties"]
    for key, spec in item.items():
        assert spec.get("type") != "object", f"claims.{key} is nested"


@test
def test_the_hash_covers_the_tool_as_well_as_the_words():
    """The tool is part of the prompt: change its shape and the model answers
    differently, so changing it without a version bump has to fail here too."""
    import copy
    import json as _json
    altered = copy.deepcopy(prompts.APPRAISE_TOOL)
    altered["input_schema"]["properties"]["effect_score"]["maximum"] = 99
    moved = prompts.hash_of(prompts.APPRAISE_SYSTEM + _json.dumps(altered, sort_keys=True))
    assert moved != prompts.APPRAISE_HASH


if __name__ == "__main__":
    passed = failed = 0
    for name, fn in T:
        try:
            fn(); passed += 1
        except AssertionError as e:
            failed += 1; print(f"FAIL {name}: {e}")
        except Exception as e:
            failed += 1; print(f"ERROR {name}: {type(e).__name__}: {e}")
    print(f"{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
