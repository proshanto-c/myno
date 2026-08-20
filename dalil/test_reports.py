"""
The whole pipeline, without a model and without a network.

Run:  docker compose exec -T dalil python test_reports.py

The model call is injected, so these run the real verification, the real
scoring, the real claim storage and the real database — everything except the
one step that costs money and cannot be made deterministic. What is being tested
is the step the plan calls the anti-hallucination guard: that it is code.
"""
import datetime as dt

from sqlalchemy.orm import sessionmaker

import appraise
import claims as claims_mod
import prompts
import reports
from models import (Claim, ClaimField, Published, Report, Reviewer, Source,
                    engine, init_db)

T = []
test = lambda fn: (T.append((fn.__name__, fn)), fn)[1]

TEXT = (
    "Sleep quality in polycystic ovary syndrome: a cross-sectional study\n\n"
    "Women with PCOS reported significantly shorter sleep duration than controls "
    "(6.2 vs 7.1 hours, p < 0.001), and shorter sleep was associated with higher "
    "self-reported cognitive difficulty in 412 participants.\n\n"
    "Analyses were adjusted for age, body mass index and insulin resistance."
)
PASSAGES = [{"offset": 0, "len": 66, "section": "TITLE", "type": "front"},
            {"offset": 68, "len": len(TEXT) - 68, "section": "RESULTS", "type": "paragraph"}]

VOCAB = {"fields": {"sleep": "wellbeing", "brainFog": "wellbeing", "energy": "wellbeing",
                    "morningWeight": "body", "pain": "body"},
         "labels": {"sleep": "Sleep", "brainFog": "Brain fog", "energy": "Energy",
                    "morningWeight": "Morning weight", "pain": "Pain"}}

REAL_QUOTE = "shorter sleep was associated with higher self-reported cognitive difficulty"
INVENTED = "Sleep deprivation is the direct and proven cause of this condition in every case."


def answer(claims=None, quotes=None, n=412):
    """What the model would have said. `quotes` overrides the module quotes."""
    quotes = quotes or {}
    each = lambda key, score: {"score": score, "note": f"{key} note",
                               "quote": quotes.get(key, REAL_QUOTE)}
    out = {"measurement": each("measurement", 12), "effect": each("effect", 7),
           "daily": each("daily", 10), "confounding": each("confounding", 8),
           "sample": {"n": n, "note": "stated in the results",
                      "quote": quotes.get("sample", REAL_QUOTE)},
           "narrative": "A cross-sectional survey of sleep and cognition in PCOS.",
           "claims": claims if claims is not None else [one_claim()]}
    return {"out": out, "model": "test-model", "promptVersion": prompts.APPRAISE_VERSION,
            "promptHash": prompts.APPRAISE_HASH, "tokensIn": 1234, "tokensOut": 567}


def one_claim(**kw):
    base = {"claim_text": "Shorter sleep goes with more brain fog in women with PCOS",
            "relation": "associated_with", "direction": "-", "population": "women with PCOS",
            "exposure_field": "sleep", "outcome_field": "brainFog", "moderator_field": None,
            "effect": {"measure": "r", "value": -0.31, "p": 0.001},
            "certainty": "low", "quote": REAL_QUOTE}
    base.update(kw)
    return base


def caller(reply):
    return lambda source, fields, labels, http=None: reply


# ---- the transaction everything runs in -------------------------------------
# One outer transaction rolled back at the end keeps the real database clean,
# and one savepoint per test keeps the tests clean of each other. Both are
# needed: a `session.rollback()` after a `session.commit()` undoes nothing, so
# without the savepoint a published row from one test contradicts a claim in
# the next — which is exactly how this was found.
init_db()
connection = engine.connect()
outer = connection.begin()
Scoped = sessionmaker(bind=connection, join_transaction_mode="create_savepoint")

_open = []
_n = [0]


def Scoped_():
    s = Scoped()
    _open.append(s)
    return s


def a_source(s, *, fulltext=TEXT, abstract="An abstract about sleep.", **kw):
    _n[0] += 1
    row = Source(pmid=f"9902{_n[0]:04d}", title="Sleep quality in polycystic ovary syndrome",
                 abstract=abstract, journal="J Test", year=2024, kind="article",
                 pub_types=["Journal Article"], mesh=["Polycystic Ovary Syndrome", "Humans"],
                 fulltext=fulltext, passages=PASSAGES if fulltext else None,
                 record_hash=f"hash-{_n[0]}", screen_state="new", **kw)
    s.add(row)
    s.commit()
    return row


# ---- the guard ---------------------------------------------------------------
@test
def test_a_verified_claim_is_stored_with_where_it_came_from():
    s = Scoped_()
    row = a_source(s)
    report, made, stats = reports.appraise_source(s, row, VOCAB, call=caller(answer()))
    assert made is True
    assert stats["kept"] == 1 and stats["dropped"] == 0

    claim = s.query(Claim).filter(Claim.source_id == row.id).one()
    assert claim.quote_verified is True
    assert claim.quote_offset >= 0
    assert TEXT[claim.quote_offset:claim.quote_offset + len(claim.quote)] == claim.quote
    assert claim.quote_section == "RESULTS", claim.quote_section
    assert claim.state == "extracted", "a stored claim starts unreviewed"
    bound = {f.role: f.field_key for f in
             s.query(ClaimField).filter(ClaimField.claim_id == claim.id).all()}
    assert bound == {"exposure": "sleep", "outcome": "brainFog"}
    s.rollback()


@test
def test_a_claim_quoting_a_sentence_the_paper_does_not_contain_is_destroyed():
    s = Scoped_()
    row = a_source(s)
    nonce = "wombat-nonce-9f3a"
    fabricated = one_claim(quote=f"{INVENTED} {nonce}", claim_text=f"Invented claim {nonce}")
    _, _, stats = reports.appraise_source(s, row, VOCAB, call=caller(answer(claims=[fabricated])))

    assert stats["dropped"] == 1 and stats["kept"] == 0
    assert s.query(Claim).filter(Claim.source_id == row.id).count() == 0, \
        "an unverifiable claim was stored for a reviewer to waste time on"
    # and nothing anywhere carries the text of it
    leaked = s.query(Claim).filter(Claim.claim_text.like(f"%{nonce}%")).count()
    assert leaked == 0
    s.rollback()


@test
def test_a_module_quoting_nothing_findable_scores_zero_and_says_so():
    s = Scoped_()
    row = a_source(s)
    report, _, _ = reports.appraise_source(
        s, row, VOCAB, call=caller(answer(quotes={"effect": INVENTED, "daily": INVENTED})))

    by_key = {m["key"]: m for m in report.modules}
    assert by_key["effect"]["score"] == 0, "kept its points on a sentence that is not there"
    assert by_key["daily"]["score"] == 0
    assert by_key["measurement"]["score"] == 12, "a good quote was punished for its neighbours"
    assert "quote_unverified" in report.flags
    s.rollback()


@test
def test_the_verified_fraction_is_recorded_the_way_the_report_shows_it():
    s = Scoped_()
    row = a_source(s)
    report, _, stats = reports.appraise_source(
        s, row, VOCAB, call=caller(answer(quotes={"sample": INVENTED})))
    assert stats["verified"] == {"of": 5, "found": 4}
    s.rollback()


@test
def test_a_module_that_comes_back_the_wrong_shape_scores_zero_rather_than_raising():
    """A tool schema is guidance, not a guarantee. This happened on the first
    live run: one module arrived as something `dict()` could not build, and the
    exception took the whole batch of four with it."""
    s = Scoped_()
    row = a_source(s)
    reply = answer()
    reply["out"]["measurement"] = "12 — both sides are loggable"     # a string
    reply["out"]["effect"] = ["something", "else"]                   # a list
    reply["out"]["daily"] = None

    report, made, _ = reports.appraise_source(s, row, VOCAB, call=caller(reply))
    assert made is True
    by_key = {m["key"]: m for m in report.modules}
    for key in ("measurement", "effect", "daily"):
        assert by_key[key]["score"] == 0, key
        assert "not an object" in by_key[key]["note"], by_key[key]["note"]
    assert by_key["confounding"]["score"] == 8, "a well-formed module was punished too"
    s.rollback()


@test
def test_a_reply_with_nothing_usable_in_it_still_makes_a_report():
    s = Scoped_()
    row = a_source(s)
    report, made, stats = reports.appraise_source(
        s, row, VOCAB, call=caller({"out": "the whole thing is a string", "model": "m",
                                    "tokensIn": 1, "tokensOut": 1}))
    assert made is True
    assert stats["kept"] == 0
    assert report.score > 0, "the deterministic half is unaffected by a bad reply"
    assert "quote_unverified" in report.flags
    s.rollback()


@test
def test_a_claim_that_is_not_an_object_is_dropped_not_stored():
    s = Scoped_()
    row = a_source(s)
    reply = answer(claims=["a bare string", None, one_claim()])
    _, _, stats = reports.appraise_source(s, row, VOCAB, call=caller(reply))
    assert stats["kept"] == 1 and stats["dropped"] == 2
    s.rollback()


# ---- bindings ----------------------------------------------------------------
@test
def test_a_field_the_app_does_not_record_becomes_a_proposal():
    s = Scoped_()
    row = a_source(s)
    novel = one_claim(outcome_field="hotFlushes", tracker_label="Hot flushes")
    _, _, stats = reports.appraise_source(s, row, VOCAB, call=caller(answer(claims=[novel])))
    assert stats["kept"] == 1

    claim = s.query(Claim).filter(Claim.source_id == row.id).one()
    bound = {f.field_key: f.proposed for f in
             s.query(ClaimField).filter(ClaimField.claim_id == claim.id).all()}
    assert bound == {"sleep": False, "hotFlushes": True}
    assert claim.tracker == {"label": "Hot flushes"}, claim.tracker
    s.rollback()


@test
def test_a_claim_with_one_field_at_both_ends_never_reaches_the_queue():
    s = Scoped_()
    row = a_source(s)
    circular = one_claim(exposure_field="morningWeight", outcome_field="morningWeight")
    _, _, stats = reports.appraise_source(s, row, VOCAB, call=caller(answer(claims=[circular])))
    assert stats["kept"] == 0 and stats["dropped"] == 1
    s.rollback()


# ---- scoring against the real corpus -----------------------------------------
@test
def test_the_deterministic_half_uses_the_corpus_it_is_in():
    s = Scoped_()
    row = a_source(s)
    report, _, _ = reports.appraise_source(s, row, VOCAB, call=caller(answer()))
    corroboration = next(m for m in report.modules if m["key"] == "corroboration")
    assert corroboration["score"] == 0, "nothing cites it yet"

    from models import Citation
    other = a_source(s)
    for _ in range(5):
        s.add(Citation(source_id=other.id, cited_pmid=row.pmid))
    s.commit()
    again, _, _ = reports.appraise_source(s, row, VOCAB, force=True, call=caller(answer()))
    corroboration = next(m for m in again.modules if m["key"] == "corroboration")
    assert corroboration["score"] == 6, corroboration
    s.rollback()


@test
def test_a_source_does_not_corroborate_itself():
    s = Scoped_()
    row = a_source(s)
    from models import Citation
    s.add(Citation(source_id=row.id, cited_pmid=row.pmid))     # a self-citation in its own refs
    s.commit()
    assert reports.cited_by(s, row) == 0
    s.rollback()


# ---- not doing the same work twice -------------------------------------------
@test
def test_the_same_paper_under_the_same_rubric_is_not_appraised_again():
    s = Scoped_()
    row = a_source(s)
    calls = {"n": 0}

    def counting(source, fields, labels, http=None):
        calls["n"] += 1
        return answer()

    reports.appraise_source(s, row, VOCAB, call=counting)
    report, made, stats = reports.appraise_source(s, row, VOCAB, call=counting)
    assert made is False and stats["reused"] is True
    assert calls["n"] == 1, "paid for the same paper twice"
    assert s.query(Report).filter(Report.source_id == row.id).count() == 1
    s.rollback()


@test
def test_forcing_it_adds_a_report_rather_than_overwriting_one():
    s = Scoped_()
    row = a_source(s)
    first, _, _ = reports.appraise_source(s, row, VOCAB, call=caller(answer()))
    second, made, _ = reports.appraise_source(s, row, VOCAB, force=True, call=caller(answer()))
    assert made is True
    assert second.id != first.id
    assert s.query(Report).filter(Report.source_id == row.id).count() == 2, \
        "a report a human may already have read was overwritten"
    s.rollback()


@test
def test_new_text_for_the_same_paper_earns_a_new_report():
    s = Scoped_()
    row = a_source(s, fulltext="")
    reports.appraise_source(s, row, VOCAB, call=caller(answer()))
    row.fulltext, row.passages, row.record_hash = TEXT, PASSAGES, "hash-changed"
    s.commit()
    _, made, _ = reports.appraise_source(s, row, VOCAB, call=caller(answer()))
    assert made is True, "full text arrived and nothing was re-read"
    s.rollback()


# ---- contradiction -----------------------------------------------------------
@test
def test_a_finding_that_runs_against_a_published_one_is_flagged():
    s = Scoped_()
    settled = a_source(s)
    reviewer = Reviewer(email=f"test:{_n[0]}@example.invalid", password_hash="x")
    s.add(reviewer)
    s.flush()

    agreed = Claim(source_id=settled.id, state="published", direction="-",
                   claim_text="less sleep, more fog", quote_verified=True)
    s.add(agreed)
    s.flush()
    s.add(ClaimField(claim_id=agreed.id, field_key="sleep", role="exposure"))
    s.add(ClaimField(claim_id=agreed.id, field_key="brainFog", role="outcome"))
    s.add(Published(claim_id=agreed.id, correlation_id="sleep_brainfog",
                    field_keys=["sleep", "brainFog"], display_text="Shorter sleep, more fog",
                    published_by=reviewer.id))
    s.commit()

    row = a_source(s)
    against = one_claim(direction="+", claim_text="less sleep, less fog")
    report, _, _ = reports.appraise_source(s, row, VOCAB, call=caller(answer(claims=[against])))
    assert any(f.startswith("contradicts_published:sleep->brainFog") for f in report.flags), report.flags
    s.rollback()


@test
def test_agreeing_with_a_published_finding_is_not_a_flag():
    s = Scoped_()
    settled = a_source(s)
    reviewer = Reviewer(email=f"test:agree{_n[0]}@example.invalid", password_hash="x")
    s.add(reviewer)
    s.flush()
    agreed = Claim(source_id=settled.id, state="published", direction="-", quote_verified=True)
    s.add(agreed)
    s.flush()
    s.add(ClaimField(claim_id=agreed.id, field_key="sleep", role="exposure"))
    s.add(ClaimField(claim_id=agreed.id, field_key="brainFog", role="outcome"))
    s.add(Published(claim_id=agreed.id, field_keys=["sleep", "brainFog"],
                    display_text="x", published_by=reviewer.id))
    s.commit()

    row = a_source(s)
    report, _, _ = reports.appraise_source(s, row, VOCAB, call=caller(answer()))
    assert not any("contradicts" in f for f in report.flags), report.flags
    s.rollback()


@test
def test_a_revoked_publication_no_longer_contradicts_anything():
    s = Scoped_()
    settled = a_source(s)
    reviewer = Reviewer(email=f"test:rev{_n[0]}@example.invalid", password_hash="x")
    s.add(reviewer)
    s.flush()
    old = Claim(source_id=settled.id, state="unpublished", direction="-", quote_verified=True)
    s.add(old)
    s.flush()
    s.add(ClaimField(claim_id=old.id, field_key="sleep", role="exposure"))
    s.add(ClaimField(claim_id=old.id, field_key="brainFog", role="outcome"))
    s.add(Published(claim_id=old.id, field_keys=["sleep", "brainFog"], display_text="x",
                    published_by=reviewer.id, revoked_at=dt.datetime.utcnow(),
                    revoked_reason="retracted"))
    s.commit()

    row = a_source(s)
    report, _, _ = reports.appraise_source(
        s, row, VOCAB, call=caller(answer(claims=[one_claim(direction="+")])))
    assert not any("contradicts" in f for f in report.flags), report.flags
    s.rollback()


# ---- without a model ---------------------------------------------------------
@test
def test_a_deterministic_pass_costs_nothing_and_makes_no_claims():
    s = Scoped_()
    row = a_source(s)
    calls = {"n": 0}

    def never(*a, **kw):
        calls["n"] += 1
        raise AssertionError("the model was called on a deterministic pass")

    report, made, stats = reports.appraise_source(s, row, VOCAB, use_model=False, call=never)
    assert calls["n"] == 0
    assert made is True
    assert report.tokens_in == 0 and report.tokens_out == 0
    assert s.query(Claim).filter(Claim.source_id == row.id).count() == 0
    assert report.score > 0, "the deterministic half still scores something"
    s.rollback()


@test
def test_appraising_moves_the_source_on_and_records_what_it_cost():
    s = Scoped_()
    row = a_source(s)
    report, _, _ = reports.appraise_source(s, row, VOCAB, call=caller(answer()))
    assert row.screen_state == "appraised"
    assert report.tokens_in == 1234 and report.tokens_out == 567
    assert report.model == "test-model"
    assert report.rubric_version == appraise.RUBRIC_VERSION
    assert report.prompt_version == prompts.APPRAISE_VERSION
    assert report.narrative.startswith("A cross-sectional survey")
    s.rollback()


@test
def test_a_paper_with_nothing_to_read_is_scored_but_not_sent():
    s = Scoped_()
    row = a_source(s, fulltext="", abstract="")
    calls = {"n": 0}

    def never(*a, **kw):
        calls["n"] += 1
        return answer()

    report, _, _ = reports.appraise_source(s, row, VOCAB, call=never)
    assert calls["n"] == 0, "sent an empty paper to the model"
    assert "no_text" in report.flags
    s.rollback()


if __name__ == "__main__":
    passed = failed = 0
    for name, fn in T:
        mark = connection.begin_nested()
        try:
            fn(); passed += 1
        except AssertionError as e:
            failed += 1; print(f"FAIL {name}: {e}")
        except Exception as e:
            failed += 1; print(f"ERROR {name}: {type(e).__name__}: {e}")
        finally:
            while _open:
                _open.pop().close()
            mark.rollback()
    outer.rollback()
    connection.close()
    print(f"{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
