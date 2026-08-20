"""
The boundary a claim has to cross.

Run:  docker compose exec -T dalil python test_claims.py

Quote verification gets the most attention here, because it is the one thing
standing between a model's fluent sentence and a health claim on somebody's
screen. Everything else in the module is a rule; this is a proof.
"""
import claims

T = []
test = lambda fn: (T.append((fn.__name__, fn)), fn)[1]

PAPER = (
    "Sleep quality in polycystic ovary syndrome\n\n"
    "Women with PCOS reported significantly shorter sleep duration than controls "
    "(6.2 vs 7.1 hours, p < 0.001), and shorter sleep was associated with higher "
    "self-reported cognitive difficulty.\n\n"
    "We adjusted for age, body mass index and insulin resistance."
)

KNOWN = {"sleep": "wellbeing", "brainFog": "wellbeing", "energy": "wellbeing",
         "pain": "body", "morningWeight": "body", "acne": "skin"}


def fields(exposure="sleep", outcome="brainFog", moderator=None, proposed=()):
    out = [{"field_key": exposure, "role": "exposure", "proposed": exposure in proposed},
           {"field_key": outcome, "role": "outcome", "proposed": outcome in proposed}]
    if moderator:
        out.append({"field_key": moderator, "role": "moderator", "proposed": moderator in proposed})
    return out


# ---- finding a quote ---------------------------------------------------------
@test
def test_a_quote_that_is_there_is_found_where_it_is():
    quote = "shorter sleep was associated with higher self-reported cognitive difficulty"
    offset, matched = claims.find_quote(PAPER, quote)
    assert offset >= 0
    assert PAPER[offset:offset + len(matched)] == matched
    assert matched.lower().startswith("shorter sleep was associated")


@test
def test_a_quote_that_is_not_there_is_not_found():
    invented = "Sleep deprivation directly causes polycystic ovary syndrome in all women."
    offset, matched = claims.find_quote(PAPER, invented)
    assert offset == -1
    assert matched == ""


@test
def test_publisher_punctuation_does_not_break_a_true_quote():
    # the model normalises an en dash and curly quotes; the paper does not
    text = "Women with PCOS slept 6.2–7.1 hours — the “short sleep” group."
    quote = 'Women with PCOS slept 6.2-7.1 hours - the "short sleep" group.'
    offset, matched = claims.find_quote(text, quote)
    assert offset == 0, (offset, matched)
    assert matched == text, "the reviewer should be shown the paper's own punctuation"


@test
def test_whitespace_and_case_are_not_differences():
    quote = "WOMEN  with   PCOS\n reported significantly shorter sleep duration"
    offset, _ = claims.find_quote(PAPER, quote)
    assert offset >= 0


@test
def test_a_line_break_inside_the_paper_does_not_hide_a_quote():
    text = "Women with PCOS reported\nshorter sleep than controls in every model tested."
    offset, matched = claims.find_quote(text, "Women with PCOS reported shorter sleep than controls")
    assert offset == 0
    assert "\n" in matched, "the match should span the original text, newline and all"


@test
def test_a_quote_trimmed_at_the_end_still_points_at_its_sentence():
    quote = ("Women with PCOS reported significantly shorter sleep duration than controls "
             "in a way the paper never actually says")
    offset, matched = claims.find_quote(PAPER, quote)
    assert offset >= 0, "a real sentence with an invented tail lost its anchor"
    assert "never actually says" not in matched, "the invented tail was stored as evidence"


@test
def test_a_fragment_too_short_to_mean_anything_is_refused():
    for fragment in ("PCOS", "sleep", "", "   ", "p < 0.001"):
        offset, _ = claims.find_quote(PAPER, fragment)
        assert offset == -1, f"{fragment!r} was accepted as evidence"


@test
def test_verification_names_the_section_a_quote_came_from():
    passages = [{"offset": 0, "len": 41, "section": "TITLE"},
                {"offset": 43, "len": len(PAPER) - 43, "section": "RESULTS"}]
    out = claims.verify(PAPER, "shorter sleep was associated with higher self-reported", passages)
    assert out["verified"] is True
    assert out["section"] == "RESULTS"
    assert out["offset"] > 43


@test
def test_verification_of_something_absent_says_so_without_raising():
    out = claims.verify(PAPER, "The moon is made of cheese and this is well established.")
    assert out["verified"] is False
    assert out["offset"] == -1
    assert out["section"] == ""


@test
def test_an_empty_document_verifies_nothing():
    assert claims.verify("", "anything at all, at length, and convincingly")["verified"] is False


# ---- the state machine -------------------------------------------------------
@test
def test_a_model_cannot_publish():
    assert claims.can("extracted", "published") is False, "the whole point of the module"
    assert claims.can("extracted", "accepted") is True
    assert claims.can("accepted", "published") is True
    assert claims.can("edited", "published") is True


@test
def test_the_legal_moves_are_exactly_these():
    legal = {(a, b) for a, tos in claims.TRANSITIONS.items() for b in tos}
    for pair in [("extracted", "accepted"), ("extracted", "rejected"), ("accepted", "rejected"),
                 ("published", "unpublished"), ("unpublished", "published"),
                 ("rejected", "extracted")]:
        assert pair in legal, pair
    for pair in [("extracted", "published"), ("rejected", "published"), ("published", "edited"),
                 ("published", "rejected"), ("accepted", "extracted")]:
        assert pair not in legal, pair


@test
def test_every_state_leads_somewhere_and_is_reachable():
    for state in claims.STATES:
        assert claims.TRANSITIONS[state], f"{state} is a dead end"
    reachable = {b for tos in claims.TRANSITIONS.values() for b in tos} | {"extracted"}
    assert reachable == set(claims.STATES), set(claims.STATES) - reachable


# ---- bindings ----------------------------------------------------------------
@test
def test_a_claim_binds_to_the_apps_own_vocabulary():
    assert claims.validate_fields(fields(), KNOWN) == []
    problems = claims.validate_fields(fields(outcome="vibes"), KNOWN)
    assert problems and "vibes" in problems[0]


@test
def test_a_field_the_app_does_not_record_may_be_proposed():
    assert claims.validate_fields(fields(outcome="hotFlushes", proposed=["hotFlushes"]), KNOWN) == []
    # …but proposing one that already exists is a mistake, not a proposal
    problems = claims.validate_fields(fields(outcome="brainFog", proposed=["brainFog"]), KNOWN)
    assert problems and "already exists" in problems[0]


@test
def test_a_claim_needs_both_ends():
    only_one = [{"field_key": "sleep", "role": "exposure", "proposed": False}]
    assert any("exposure and an outcome" in p for p in claims.validate_fields(only_one, KNOWN))
    two_outcomes = fields() + [{"field_key": "energy", "role": "outcome", "proposed": False}]
    assert any("one exposure and one outcome" in p for p in claims.validate_fields(two_outcomes, KNOWN))


@test
def test_one_field_cannot_be_both_ends_of_a_claim():
    """A real appraisal produced this: "weight two years after stopping the drug
    versus weight at baseline", bound as morningWeight → morningWeight. It is a
    genuine finding and one Insights can never show, because it correlates two
    columns and this has only one."""
    problems = claims.validate_fields(fields(exposure="morningWeight", outcome="morningWeight"), KNOWN)
    assert any("both ends" in p for p in problems), problems
    # …but the same field as a moderator alongside a real pair is fine
    assert claims.validate_fields(fields(moderator="morningWeight"), KNOWN) == []


@test
def test_a_moderator_is_allowed_and_a_fourth_role_is_not():
    assert claims.validate_fields(fields(moderator="morningWeight"), KNOWN) == []
    bad = fields() + [{"field_key": "pain", "role": "confounder", "proposed": False}]
    assert any("is not a role" in p for p in claims.validate_fields(bad, KNOWN))


@test
def test_the_pair_is_read_off_the_roles():
    assert claims.pair_of(fields()) == ("sleep", "brainFog")
    assert claims.pair_of(fields(moderator="pain")) == ("sleep", "brainFog"), \
        "a moderator is not one end of the pair"
    assert claims.pair_of([]) == (None, None)


# ---- what a badge is worth ---------------------------------------------------
@test
def test_the_grades_are_earned_rather_than_asserted():
    assert claims.grade([16]) == "Strong"                # one meta-analysis
    assert claims.grade([14, 14]) == "Strong"            # two randomised trials
    assert claims.grade([14, 9]) == "Emerging"
    assert claims.grade([14]) == "Emerging"
    assert claims.grade([9, 9]) == "Emerging"            # two cohorts
    assert claims.grade([9]) == "Early"
    assert claims.grade([6, 6, 6, 6]) == "Early"         # any number of cross-sections
    assert claims.grade([]) == "Early"


@test
def test_every_grade_rule_is_written_down():
    names = [name for name, _ in claims.GRADE_RULES]
    assert names == ["Strong", "Emerging", "Early"]
    for _, why in claims.GRADE_RULES:
        assert why.strip(), "a grade with no stated rule is the thing this replaced"


# ---- the gate ----------------------------------------------------------------
def ready(**kw):
    claim = {"state": "accepted", "quote_verified": True, "tracker": None,
             "display_text": "Shorter sleep tracks with more brain fog the next day"}
    claim.update(kw)
    return claim


@test
def test_a_ready_claim_passes():
    assert claims.publish_gate(ready(), fields(), {"score": 72}, KNOWN) == []


@test
def test_an_unreviewed_claim_cannot_be_published():
    problems = claims.publish_gate(ready(state="extracted"), fields(), {"score": 72}, KNOWN)
    assert any("cannot be published" in p for p in problems)


@test
def test_an_unverified_quote_cannot_be_published_at_any_score():
    problems = claims.publish_gate(ready(quote_verified=False), fields(), {"score": 99}, KNOWN)
    assert any("quote could not be found" in p for p in problems)


@test
def test_a_low_score_needs_a_written_reason_and_then_passes():
    problems = claims.publish_gate(ready(), fields(), {"score": 30}, KNOWN)
    assert any("needs a written reason" in p for p in problems)
    assert claims.publish_gate(ready(), fields(), {"score": 30}, KNOWN,
                               override_reason="Small but the only trial in this population") == []


@test
def test_a_patient_never_sees_nothing_and_never_sees_an_essay():
    assert any("no display text" in p
               for p in claims.publish_gate(ready(display_text="  "), fields(), {"score": 80}, KNOWN))
    essay = " ".join(["word"] * (claims.MAX_DISPLAY_WORDS + 1))
    problems = claims.publish_gate(ready(display_text=essay), fields(), {"score": 80}, KNOWN)
    assert any("over 25" in p for p in problems)
    exact = " ".join(["word"] * claims.MAX_DISPLAY_WORDS)
    assert claims.publish_gate(ready(display_text=exact), fields(), {"score": 80}, KNOWN) == []


@test
def test_a_proposed_field_needs_a_tracker_to_be_publishable():
    proposed = fields(outcome="hotFlushes", proposed=["hotFlushes"])
    only_proposed = [f for f in proposed if f["proposed"]] + \
                    [{"field_key": "hotFlushDays", "role": "exposure", "proposed": True}]
    problems = claims.publish_gate(ready(), only_proposed, {"score": 80}, KNOWN)
    assert any("nothing to bind to" in p for p in problems)
    ok = claims.publish_gate(ready(tracker={"label": "Hot flushes"}), only_proposed,
                             {"score": 80}, KNOWN)
    assert ok == [], ok


@test
def test_a_disabled_reviewer_cannot_publish():
    problems = claims.publish_gate(ready(), fields(), {"score": 80}, KNOWN,
                                   reviewer={"disabled_at": "2026-01-01"})
    assert any("disabled" in p for p in problems)


@test
def test_the_gate_reports_every_failure_not_just_the_first():
    problems = claims.publish_gate(ready(state="extracted", quote_verified=False, display_text=""),
                                   fields(outcome="vibes"), {"score": 10}, KNOWN)
    assert len(problems) >= 5, problems


# ---- what a reviewer may change ----------------------------------------------
@test
def test_a_reviewer_may_rewrite_the_claim_but_not_the_evidence():
    claim = {"claim_text": "old", "display_text": "old", "quote": "the paper's words"}
    before, after = claims.apply_edit(claim, {"claim_text": "new", "display_text": "clearer"})
    assert before == {"claim_text": "old", "display_text": "old"}
    assert after == {"claim_text": "new", "display_text": "clearer"}

    for frozen in ("quote", "quote_offset", "quote_verified", "source_id"):
        try:
            claims.apply_edit(claim, {frozen: "anything"})
        except ValueError as e:
            assert "reject the claim instead" in str(e)
        else:
            raise AssertionError(f"{frozen} was editable")


@test
def test_a_field_nobody_named_cannot_be_edited_in_sideways():
    try:
        claims.apply_edit({}, {"score": 100})
    except ValueError as e:
        assert "not an editable field" in str(e)
    else:
        raise AssertionError("an unknown field was accepted")


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
