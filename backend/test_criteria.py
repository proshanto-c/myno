"""
Exercises the criteria rules directly: no server, no database, no network.

Run:  python -m pytest backend/test_criteria.py -q
      python backend/test_criteria.py          (no pytest needed)
"""
import criteria as cr

ADULT = {
    "age": 28, "hasMenarche": True, "yearsPostMenarche": 15, "onContraception": False,
    "cyclesObserved": 6, "minCycle": 26, "maxCycle": 31, "avgCycle": 28, "cyclesPerYear": 12,
    "mfgScore": None, "hirsutismDaysPct": 3, "hairLossDaysPct": 2, "persistentAcne": False,
}
def case(**over):
    return {**ADULT, **over}


# ---- criterion 1: cycles ---------------------------------------------------
def test_regular_adult_cycles_are_clear():
    a = cr.assess(case())
    assert a["cycles"]["state"] == "clear"
    assert a["recommendation"]["key"] == "none"

def test_long_cycle_meets_the_adult_limit():
    a = cr.assess(case(maxCycle=45))
    assert a["cycles"]["state"] == "met"
    assert a["recommendation"]["key"] == "book"

def test_short_cycle_counts_too():
    assert cr.assess(case(minCycle=19))["cycles"]["state"] == "met"

def test_too_few_cycles_in_a_year():
    assert cr.assess(case(cyclesPerYear=6))["cycles"]["state"] == "met"

def test_cycles_per_year_only_applies_from_three_years():
    # the same count inside the 1-3y band is not a finding
    a = cr.assess(case(age=14, yearsPostMenarche=2, cyclesPerYear=6))
    assert a["cycles"]["state"] == "clear"

def test_teen_band_allows_longer_cycles():
    # 42 days is irregular for an adult, expected 1-3 years after menarche
    assert cr.assess(case(age=14, yearsPostMenarche=1.5, maxCycle=42))["cycles"]["state"] == "clear"
    assert cr.assess(case(maxCycle=42))["cycles"]["state"] == "met"

def test_first_year_after_menarche_is_never_a_finding():
    a = cr.assess(case(age=13, yearsPostMenarche=0.5, maxCycle=60))
    assert a["cycles"]["state"] == "unknown"
    assert "first year" in a["cycles"]["reasons"][0]

def test_contraception_blocks_the_whole_criterion():
    a = cr.assess(case(onContraception=True, maxCycle=50))
    assert a["cycles"]["state"] == "unknown"
    assert "contraception" in a["cycles"]["reasons"][0]

def test_not_enough_cycles_to_judge():
    assert cr.assess(case(cyclesObserved=1))["cycles"]["state"] == "unknown"

def test_missing_menarche_age_falls_back_to_adult_limits():
    clear = cr.assess(case(yearsPostMenarche=None))
    assert clear["cycles"]["state"] == "clear"
    assert any("adult limits" in r for r in clear["cycles"]["reasons"])
    # the note must not be mistaken for a finding
    assert cr.assess(case(yearsPostMenarche=None, maxCycle=50))["cycles"]["state"] == "met"


# ---- things that escalate on their own -------------------------------------
def test_single_very_long_cycle_escalates():
    a = cr.assess(case(maxCycle=95))
    assert a["recommendation"]["key"] == "soon"
    assert "90 days" in a["recommendation"]["why"][0]

def test_no_menarche_by_fifteen_escalates():
    a = cr.assess(case(age=16, hasMenarche=False))
    assert a["recommendation"]["key"] == "soon"

def test_no_menarche_below_the_age_does_not_escalate():
    a = cr.assess(case(age=13, hasMenarche=False))
    assert a["recommendation"]["key"] == "unknown"


def test_logged_periods_imply_menarche_without_the_profile_field():
    # menarche age is a profile field people leave blank; period logs are facts
    class P: age = None; menarche_age = None; acne = False
    summary = {"loggedDays": 121, "cycleCount": 4, "cycleMin": 27, "cycleMax": 29, "avgCycleDays": 28}
    x = cr.derive_inputs(P(), [{"period": True, "birthControl": ""}], summary)
    assert x["hasMenarche"] is True
    assert x["yearsPostMenarche"] is None
    assert cr.assess(x)["cycles"]["state"] == "clear"


# ---- criterion 2: clinical hyperandrogenism --------------------------------
def test_mfg_score_at_the_cutoff_is_met():
    assert cr.assess(case(mfgScore=4))["androgen"]["state"] == "met"
    assert cr.assess(case(mfgScore=3))["androgen"]["state"] == "clear"

def test_mfg_score_overrides_the_day_count_fallback():
    # an explicit score is trusted over the "% of days" proxy, in both directions
    assert cr.assess(case(mfgScore=1, hirsutismDaysPct=80))["androgen"]["state"] == "clear"
    assert cr.assess(case(mfgScore=9, hirsutismDaysPct=0))["androgen"]["state"] == "met"

def test_day_count_fallback_when_no_score():
    assert cr.assess(case(hirsutismDaysPct=30))["androgen"]["state"] == "met"

def test_hair_loss_and_acne_count():
    assert cr.assess(case(hairLossDaysPct=12))["androgen"]["state"] == "met"
    assert cr.assess(case(persistentAcne=True))["androgen"]["state"] == "met"


# ---- what a clinician has already established ------------------------------
class Profile:
    age = 28; menarche_age = 13; acne = False
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)

def _from(profile, **summary):
    base = {"loggedDays": 200, "cycleCount": 4, "cycleMin": 26, "cycleMax": 31, "avgCycleDays": 28}
    return cr.derive_inputs(profile, [{"period": True}], {**base, **summary})

def test_a_hirsutism_diagnosis_settles_the_androgen_criterion():
    a = cr.assess(case(conditions=["hirsutism"], mfgScore=0, hirsutismDaysPct=0))
    assert a["androgen"]["state"] == "met"
    assert "already on your record" in a["androgen"]["reasons"][0]

def test_other_conditions_do_not_settle_it():
    assert cr.assess(case(conditions=["infertility", "diabetes2"]))["androgen"]["state"] == "clear"

def test_the_mfg_sheet_totals_the_nine_areas():
    x = _from(Profile(mfg={"chin": 3, "upperLip": 2, "thighs": 1}))
    assert x["mfgScore"] == 6
    assert _from(Profile(mfg={}))["mfgScore"] is None      # unfilled, not zero
    assert cr.assess(x)["androgen"]["state"] == "met"

def test_thyroid_conditions_are_named_as_another_explanation():
    a = cr.assess(case(conditions=["hypothyroidism"], maxCycle=50))
    assert a["cycles"]["state"] == "met"                   # the finding stands
    assert any("Hypothyroidism" in n for n in a["context"])
    assert cr.assess(case())["context"] == []

def test_the_pill_under_drug_therapy_blocks_the_cycle_criterion():
    x = _from(Profile(drugs=["ocp"]), cycleMax=50)
    assert x["onContraception"] is True
    assert cr.assess(x)["cycles"]["state"] == "unknown"

def test_other_drug_therapy_leaves_the_cycle_readable():
    for drug in ("glp1", "letrozole"):
        assert _from(Profile(drugs=[drug]))["onContraception"] is False, drug


# ---- the recommendation ----------------------------------------------------
def test_self_reported_signs_alone_only_earn_a_mention():
    a = cr.assess(case(mfgScore=6))
    assert a["recommendation"]["key"] == "mention"
    assert a["recommendation"]["met"] == 1

def test_measured_cycles_alone_earn_a_booking():
    assert cr.assess(case(maxCycle=50))["recommendation"]["key"] == "book"

def test_both_criteria_met():
    a = cr.assess(case(mfgScore=6, maxCycle=50))
    assert a["recommendation"]["met"] == 2
    assert a["recommendation"]["key"] == "book"

def test_alerts_outrank_everything():
    a = cr.assess(case(mfgScore=6, maxCycle=95))
    assert a["recommendation"]["key"] == "soon"

def test_a_formal_diagnosis_stops_the_screening_question():
    a = cr.assess(case(diagnosed=True, maxCycle=50))
    assert a["recommendation"]["key"] == "diagnosed"
    assert a["diagnosed"] is True
    assert "already on your record" in a["recommendation"]["why"][0]
    # the criteria are still worked out — a review runs on them
    assert a["cycles"]["state"] == "met" and a["recommendation"]["met"] == 1

def test_a_diagnosis_does_not_silence_an_alert():
    a = cr.assess(case(diagnosed=True, maxCycle=95))
    assert a["recommendation"]["key"] == "soon"

def test_the_diagnosis_comes_from_its_own_field_not_the_conditions():
    class P: age = 28; menarche_age = 13; acne = False; pmos_diagnosed = True
    x = cr.derive_inputs(P(), [{"period": True}], {"loggedDays": 200, "cycleCount": 4,
                                                   "cycleMin": 26, "cycleMax": 31, "avgCycleDays": 28})
    assert x["diagnosed"] is True and x["conditions"] == []
    assert cr.assess(case())["diagnosed"] is False

def test_morphology_is_never_assessed():
    assert cr.assess(case())["axes"]["morphology"]["met"] is None


# ---- rule overrides (the experiment panel) ---------------------------------
def test_threshold_override_changes_the_verdict():
    strict = cr.merge_rules({"cycleBands": [{}, {"longDays": 30}]})
    assert cr.assess(case(maxCycle=31), strict)["cycles"]["state"] == "met"
    assert cr.assess(case(maxCycle=31))["cycles"]["state"] == "clear"

def test_overrides_do_not_mutate_the_defaults():
    cr.merge_rules({"singleCycleDays": 10, "cycleBands": [{"longDays": 1}]})
    assert cr.RULES["singleCycleDays"] == 90
    assert cr.RULES["cycleBands"][0]["longDays"] == 45

def test_unknown_override_keys_are_ignored():
    assert "nonsense" not in cr.merge_rules({"nonsense": 1})


# ---- contraception: only hormonal methods hide the cycle -------------------
def _inputs(bc_type=None, bc=None):
    class P: age = 28; menarche_age = 13; acne = False
    logs = [{"period": True, "birthControl": bc, "birthControlType": bc_type}]
    return cr.derive_inputs(P(), logs, {"loggedDays": 200, "cycleCount": 4,
                                        "cycleMin": 26, "cycleMax": 31, "avgCycleDays": 28})

def test_hormonal_contraception_blocks_the_cycle_criterion():
    assert _inputs("hormonal")["onContraception"] is True
    assert cr.assess(_inputs("hormonal"))["cycles"]["state"] == "unknown"

def test_barrier_and_natural_methods_leave_cycles_readable():
    for method in ("mechanical", "natural"):
        x = _inputs(method)
        assert x["onContraception"] is False, method
        assert cr.assess(x)["cycles"]["state"] == "clear", method

def test_legacy_free_text_methods_are_still_read():
    assert _inputs(None, "the pill")["onContraception"] is True
    assert _inputs(None, "condoms")["onContraception"] is False


if __name__ == "__main__":
    passed = failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); passed += 1
            except AssertionError as e:
                failed += 1; print(f"FAIL {name}: {e or ''}")
    print(f"{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
