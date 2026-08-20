"""
The trust boundary, tested as one.

Run:  docker compose exec -T dalil python test_review.py

The test that matters most is the last one: a claim carrying a unique nonce is
created and not published, and the nonce is then looked for in the table the
patient app reads. The boundary is a table rather than a promise, so it can be
proved rather than asserted.
"""
import datetime as dt

from sqlalchemy.orm import sessionmaker

import claims as claims_mod
import review
import vocab
from models import (Claim, ClaimField, Published, Report, Reviewer, Source,
                    engine, init_db)

T = []
test = lambda fn: (T.append((fn.__name__, fn)), fn)[1]

init_db()
connection = engine.connect()
outer = connection.begin()
_Scoped = sessionmaker(bind=connection, join_transaction_mode="create_savepoint")
_open = []
_n = [0]


def Scoped():
    s = _Scoped()
    _open.append(s)
    return s


def park_everyone(s):
    """Disable whoever is already in the table, inside this test's savepoint.

    Deleting them is not available: sessions and reviews point at these rows, so
    a DELETE is a foreign-key violation rather than a clean slate. Disabling is
    also the truer setup — "nobody is available to sign" is the state being
    tested, not "the table is empty".
    """
    s.query(Reviewer).update({Reviewer.disabled_at: dt.datetime.utcnow()},
                             synchronize_session=False)
    s.commit()


def a_reviewer(s, disabled=False):
    _n[0] += 1
    r = Reviewer(email=f"test:rev{_n[0]}@example.invalid", name="Ada", password_hash="x",
                 disabled_at=dt.datetime.utcnow() if disabled else None)
    s.add(r)
    s.commit()
    return r


def a_claim(s, *, exposure="sleep", outcome="brainFog", direction="-", score=72,
            display="Shorter sleep tracks with more brain fog", state="accepted",
            pub_types=("Randomized Controlled Trial",), proposed=(), tracker=None,
            claim_text="Shorter sleep, more brain fog"):
    _n[0] += 1
    source = Source(pmid=f"9903{_n[0]:04d}", title=f"A study {_n[0]}", journal="J Test",
                    year=2024, kind="article", pub_types=list(pub_types),
                    mesh=["Polycystic Ovary Syndrome", "Humans"], abstract="An abstract.",
                    record_hash=f"h{_n[0]}")
    s.add(source)
    s.flush()
    report = Report(source_id=source.id, score=score, verdict="meets", modules=[], flags=[])
    s.add(report)
    s.flush()
    claim = Claim(source_id=source.id, report_id=report.id, state=state,
                  claim_text=claim_text, direction=direction, quote="a real sentence",
                  quote_verified=True, quote_offset=10, display_text=display, tracker=tracker)
    s.add(claim)
    s.flush()
    s.add(ClaimField(claim_id=claim.id, field_key=exposure, role="exposure",
                     proposed=exposure in proposed))
    s.add(ClaimField(claim_id=claim.id, field_key=outcome, role="outcome",
                     proposed=outcome in proposed))
    s.commit()
    return claim, report, source


# ---- the ordinary path -------------------------------------------------------
@test
def test_a_reviewer_accepts_then_publishes_and_both_are_recorded():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, source = a_claim(s, state="extracted")

    assert review.act(s, who, claim, "accept", note="reads correctly")["ok"] is True
    assert claim.state == "accepted"

    out = review.act(s, who, claim, "publish")
    assert out["ok"] is True, out["problems"]
    assert claim.state == "published"

    row = s.query(Published).filter(Published.claim_id == claim.id).one()
    assert row.published_by == who.id, "an unsigned publication"
    assert row.correlation_id == "sleep_brainfog", row.correlation_id
    assert row.field_keys == ["sleep", "brainFog"]
    assert row.citation["pmid"] == source.pmid
    assert row.citation["url"].endswith(f"/{source.pmid}/")

    from models import Review as Audit
    audit = s.query(Audit).filter(Audit.claim_id == claim.id).order_by(Audit.id).all()
    assert [a.action for a in audit] == ["accept", "publish"]
    assert audit[0].note == "reads correctly"
    assert audit[0].reviewer_id == who.id
    s.rollback()


@test
def test_an_edit_records_what_it_said_before():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s, state="extracted", display="Original wording")

    review.act(s, who, claim, "edit", changes={"display_text": "Clearer wording"},
               note="plainer English")
    assert claim.display_text == "Clearer wording"
    assert claim.state == "edited"

    from models import Review as Audit
    row = s.query(Audit).filter(Audit.claim_id == claim.id).one()
    assert row.before["display_text"] == "Original wording"
    assert row.after["display_text"] == "Clearer wording"
    s.rollback()


@test
def test_the_evidence_cannot_be_edited():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s, state="extracted")
    try:
        review.act(s, who, claim, "edit", changes={"quote": "something better"})
    except ValueError as e:
        assert "reject the claim instead" in str(e)
    else:
        raise AssertionError("a reviewer rewrote the paper")
    s.rollback()


@test
def test_an_edited_claim_can_go_straight_to_published():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s, state="extracted")
    review.act(s, who, claim, "edit", changes={"display_text": "Shorter sleep, more fog"})
    assert review.act(s, who, claim, "publish")["ok"] is True
    s.rollback()


# ---- the moves that are not allowed ------------------------------------------
@test
def test_an_unreviewed_claim_cannot_be_published():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s, state="extracted")
    out = review.act(s, who, claim, "publish")
    assert out["ok"] is False
    # refused by the state machine before the gate is even consulted, which is
    # the right order: there is no path from `extracted` to `published`
    assert out["problems"] == ["a claim in 'extracted' cannot become 'published'"], out["problems"]
    assert s.query(Published).filter(Published.claim_id == claim.id).count() == 0
    s.rollback()


@test
def test_a_rejected_claim_cannot_be_published_without_being_reopened():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s, state="extracted")
    review.act(s, who, claim, "reject", note="the population is wrong")
    out = review.act(s, who, claim, "publish")
    assert out["ok"] is False
    assert "rejected" in out["problems"][0]
    assert review.act(s, who, claim, "reopen")["ok"] is True
    s.rollback()


@test
def test_a_made_up_action_is_refused_rather_than_guessed_at():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s)
    out = review.act(s, who, claim, "approve")     # not one of the five
    assert out["ok"] is False
    assert "not something a reviewer does" in out["problems"][0]
    s.rollback()


@test
def test_a_low_scoring_paper_needs_a_written_reason():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s, score=30)
    refused = review.act(s, who, claim, "publish")
    assert refused["ok"] is False
    assert any("written reason" in p for p in refused["problems"])

    allowed = review.act(s, who, claim, "publish",
                         override_reason="the only trial in this population")
    assert allowed["ok"] is True
    from models import Review as Audit
    row = s.query(Audit).filter(Audit.claim_id == claim.id,
                                Audit.action == "publish").one()
    assert "only trial" in row.note, "an override with no recorded reason is not an override"
    s.rollback()


@test
def test_a_disabled_account_cannot_publish():
    s = Scoped()
    who = a_reviewer(s, disabled=True)
    claim, _, _ = a_claim(s)
    out = review.act(s, who, claim, "publish")
    assert out["ok"] is False
    assert any("disabled" in p for p in out["problems"])
    s.rollback()


@test
def test_with_sign_in_off_a_review_is_signed_by_the_standing_admin():
    """The module's claim is "a named person checked this". Rather than let that
    be false while sign-in is off, the work is attributed to the admin account
    that is already there."""
    import auth
    s = Scoped()
    admin = a_reviewer(s)
    admin.role = "admin"
    s.commit()

    who = auth.default_reviewer(s)
    assert who.disabled_at is None
    claim, _, _ = a_claim(s)
    out = review.act(s, auth.as_dict(who, default=True), claim, "publish")
    assert out["ok"] is True
    row = s.query(Published).filter(Published.claim_id == claim.id).one()
    assert row.published_by == who.id, "published with nobody's name on it"
    s.rollback()


@test
def test_the_standing_admin_is_preferred_over_an_ordinary_reviewer():
    import auth
    s = Scoped()
    park_everyone(s)
    ordinary = a_reviewer(s)
    ordinary.role = "reviewer"
    admin = a_reviewer(s)
    admin.role = "admin"
    s.commit()
    assert auth.default_reviewer(s).id == admin.id
    s.rollback()


@test
def test_a_disabled_account_is_never_the_default():
    import auth
    s = Scoped()
    park_everyone(s)
    a_reviewer(s, disabled=True)
    who = auth.default_reviewer(s)
    assert who.disabled_at is None, "signed a review as a disabled account"
    assert who.email == auth.LOCAL_EMAIL
    s.rollback()


@test
def test_the_local_account_is_revived_rather_than_duplicated():
    """Its email is unique, so a second insert would fail — and once there are
    two of them, "who signed this" has two answers."""
    import auth
    s = Scoped()
    park_everyone(s)
    first = auth.default_reviewer(s)
    park_everyone(s)
    second = auth.default_reviewer(s)
    assert second.id == first.id
    assert s.query(Reviewer).filter(Reviewer.email == auth.LOCAL_EMAIL).count() == 1
    s.rollback()


@test
def test_with_nobody_available_a_local_account_nobody_can_log_into_is_made():
    import auth
    s = Scoped()
    park_everyone(s)
    who = auth.default_reviewer(s)
    assert who.email == auth.LOCAL_EMAIL
    assert who.role == "admin"
    # the password is random and thrown away — the account owns reviews, it is
    # not a way in once sign-in is turned on
    assert not auth.verify_password("", who.password_hash)
    assert not auth.verify_password(auth.LOCAL_EMAIL, who.password_hash)
    s.rollback()


# ---- grades ------------------------------------------------------------------
@test
def test_a_grade_belongs_to_the_pair_and_moves_for_everything_under_it():
    s = Scoped()
    who = a_reviewer(s)
    first, _, _ = a_claim(s, pub_types=("Randomized Controlled Trial",))
    review.act(s, who, first, "publish")
    row = s.query(Published).filter(Published.claim_id == first.id).one()
    assert row.grade == "Emerging", row.grade

    second, _, _ = a_claim(s, pub_types=("Randomized Controlled Trial",))
    review.act(s, who, second, "publish")
    s.refresh(row)
    assert row.grade == "Strong", "the first claim kept a badge the pair had outgrown"
    s.rollback()


@test
def test_one_meta_analysis_is_enough_for_strong():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s, pub_types=("Meta-Analysis",))
    review.act(s, who, claim, "publish")
    assert s.query(Published).filter(Published.claim_id == claim.id).one().grade == "Strong"
    s.rollback()


@test
def test_withdrawing_one_study_regrades_the_rest():
    s = Scoped()
    who = a_reviewer(s)
    trial, _, _ = a_claim(s, pub_types=("Meta-Analysis",))
    cohort, _, _ = a_claim(s, pub_types=("Journal Article",))
    review.act(s, who, trial, "publish")
    review.act(s, who, cohort, "publish")
    survivor = s.query(Published).filter(Published.claim_id == cohort.id).one()
    assert survivor.grade == "Strong"

    review.act(s, who, trial, "unpublish", note="retracted")
    s.refresh(survivor)
    assert survivor.grade == "Early", "kept a grade the withdrawn study was carrying"
    s.rollback()


@test
def test_unpublishing_revokes_rather_than_deletes():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s)
    review.act(s, who, claim, "publish")
    review.act(s, who, claim, "unpublish", note="a second look")

    row = s.query(Published).filter(Published.claim_id == claim.id).one()
    assert row.revoked_at is not None
    assert row.revoked_reason == "a second look"
    assert claim.state == "unpublished"
    s.rollback()


# ---- the loops back into the app ---------------------------------------------
@test
def test_a_pair_the_app_does_not_correlate_becomes_a_candidate():
    s = Scoped()
    a_claim(s, exposure="dietFibre", outcome="acne", state="accepted")
    a_claim(s, exposure="dietFibre", outcome="acne", state="accepted")
    a_claim(s, exposure="sleep", outcome="brainFog", state="accepted")

    found = {(c["exposure"], c["outcome"]): c["claims"] for c in review.candidates(s)}
    assert found.get(("dietFibre", "acne")) == 2
    assert ("sleep", "brainFog") not in found, "an existing correlation is not a candidate"
    s.rollback()


@test
def test_a_field_the_app_does_not_record_is_listed_for_a_human_to_add():
    s = Scoped()
    a_claim(s, outcome="hotFlushes", proposed=("hotFlushes",),
            tracker={"label": "Hot flushes"})
    listed = review.proposed_fields(s)
    assert listed and listed[0]["key"] == "hotFlushes"
    assert listed[0]["labels"] == ["Hot flushes"]
    s.rollback()


@test
def test_the_queue_puts_the_strongest_paper_first():
    s = Scoped()
    weak, _, _ = a_claim(s, score=48, state="extracted")
    strong, _, _ = a_claim(s, score=91, state="extracted")
    middle, _, _ = a_claim(s, score=70, state="extracted")
    # relative order, not absolute position: the queue also holds whatever the
    # corpus already had waiting, which is the whole point of a queue
    order = [c.id for c, _, _ in review.queue(s, limit=200)]
    at = lambda claim: order.index(claim.id)
    assert at(strong) < at(middle) < at(weak), [at(strong), at(middle), at(weak)]
    s.rollback()


@test
def test_the_queue_holds_only_what_is_still_open():
    s = Scoped()
    who = a_reviewer(s)
    claim, _, _ = a_claim(s, state="extracted")
    assert claim.id in [c.id for c, _, _ in review.queue(s)]
    review.act(s, who, claim, "reject", note="not usable")
    assert claim.id not in [c.id for c, _, _ in review.queue(s)]
    s.rollback()


# ---- the boundary itself -----------------------------------------------------
@test
def test_an_unpublished_claim_is_invisible_in_the_table_patients_read():
    """dalil_published is the only table the patient app reads, so this is the
    whole boundary: if the nonce is not in it, no patient can see it."""
    s = Scoped()
    nonce = "nonce-7c1a-unpublished"
    claim, _, _ = a_claim(s, state="accepted", claim_text=f"A claim about {nonce}",
                          display=f"Something about {nonce}")
    s.commit()

    live = s.query(Published).filter(Published.revoked_at.is_(None)).all()
    assert not any(nonce in (p.display_text or "") for p in live)
    assert not any(nonce in str(p.citation or {}) for p in live)

    # and once published, it is there — so the test proves a boundary, not an
    # empty table
    who = a_reviewer(s)
    assert review.act(s, who, claim, "publish")["ok"] is True
    live = s.query(Published).filter(Published.revoked_at.is_(None)).all()
    assert any(nonce in (p.display_text or "") for p in live)
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
