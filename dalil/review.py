"""
Dalīl — the trust boundary, worked.

Screening may be model-assisted. Publishing may not: a row appears in
`dalil_published` because a named person put it there, and `dalil_reviews`
records who, when, and what it said before.

The queue is ordered by what the rubric thought of the paper, so a reviewer
spends their first hour on the strongest evidence rather than on whatever was
harvested most recently. Everything a reviewer does goes through `act()`, which
is the only function that writes an audit row — one door, so there is no second
path that forgets to.
"""
from __future__ import annotations

import datetime as dt

import appraise
import claims as claims_mod
import vocab
from models import Claim, ClaimField, Published, Report, Review, Source

now = dt.datetime.utcnow

OPEN_STATES = ("extracted", "accepted", "edited")


def _id(reviewer):
    """A reviewer arrives as a row from the database or as the dict
    `auth.require_reviewer` hands back. With sign-in off there is no id at all,
    and a published row with no `published_by` is what "unsigned" means — the
    portal and the API both say so rather than letting it pass for a review
    somebody put their name to."""
    if reviewer is None:
        return None
    if isinstance(reviewer, dict):
        return reviewer.get("id")
    return getattr(reviewer, "id", None)


def _disabled(reviewer):
    if isinstance(reviewer, dict):
        return reviewer.get("disabled_at")
    return getattr(reviewer, "disabled_at", None)


def _link(source: Source) -> str:
    if source.pmid:
        return f"https://pubmed.ncbi.nlm.nih.gov/{source.pmid}/"
    if source.nbk:
        return f"https://www.ncbi.nlm.nih.gov/books/{source.nbk}/"
    if source.doi:
        return f"https://doi.org/{source.doi}"
    return ""


def citation_of(source: Source) -> dict:
    """What a patient is shown when they ask where a claim came from: a specific
    paper, with a link to that paper — never a search for words a model chose."""
    return {"pmid": source.pmid, "pmcid": source.pmcid, "nbk": source.nbk,
            "title": source.title, "journal": source.journal or source.book_title,
            "year": source.year, "url": _link(source)}


def fields_of(s, claim: Claim) -> list:
    return [{"field_key": f.field_key, "role": f.role, "proposed": f.proposed}
            for f in s.query(ClaimField).filter(ClaimField.claim_id == claim.id)
            .order_by(ClaimField.id).all()]


def report_of(s, claim: Claim):
    if claim.report_id:
        return s.get(Report, claim.report_id)
    return (s.query(Report).filter(Report.source_id == claim.source_id)
            .order_by(Report.created_at.desc()).first())


def design_points(source: Source) -> int:
    points, _ = appraise.design_score(source.pub_types, source.mesh, source.kind or "article")
    return points


def queue(s, limit: int = 50, state: str = "") -> list:
    """Score-ordered, because a reviewer's time is the scarce thing here."""
    q = (s.query(Claim, Report, Source)
         .join(Source, Source.id == Claim.source_id)
         .outerjoin(Report, Report.id == Claim.report_id)
         .filter(Claim.state.in_((state,) if state else OPEN_STATES))
         .order_by(Report.score.desc().nullslast(), Claim.id.asc())
         .limit(min(limit, 200)))
    return [(claim, report, source) for claim, report, source in q.all()]


def act(s, reviewer, claim: Claim, action: str, *, changes=None, note: str = "",
        override_reason: str = "") -> dict:
    """Every reviewer decision, and the only place an audit row is written.

    Returns {ok, problems, state, publishedId}. A refusal is data rather than an
    exception, because the caller has to show a reviewer which condition failed.
    """
    changes = changes or {}
    before, after = {}, {}

    if action == "edit":
        before, after = claims_mod.apply_edit(_as_dict(claim), changes)
        for key, value in after.items():
            setattr(claim, key, value)
        target = "edited"
    elif action in ("accept", "reject", "unpublish", "reopen"):
        target = {"accept": "accepted", "reject": "rejected",
                  "unpublish": "unpublished", "reopen": "extracted"}[action]
    elif action == "publish":
        target = "published"
    else:
        return {"ok": False, "problems": [f"{action!r} is not something a reviewer does"],
                "state": claim.state}

    if not claims_mod.can(claim.state, target):
        return {"ok": False, "state": claim.state,
                "problems": [f"a claim in {claim.state!r} cannot become {target!r}"]}

    published_id = None
    if action == "publish":
        problems, published_id = _publish(s, reviewer, claim, override_reason)
        if problems:
            return {"ok": False, "problems": problems, "state": claim.state}
    elif action == "unpublish":
        _unpublish(s, claim, note or "withdrawn by a reviewer")

    before.setdefault("state", claim.state)
    after.setdefault("state", target)
    claim.state = target

    s.add(Review(reviewer_id=_id(reviewer), claim_id=claim.id,
                 source_id=claim.source_id, action=action, before=before, after=after,
                 note=note or override_reason))
    s.commit()
    return {"ok": True, "problems": [], "state": claim.state, "publishedId": published_id}


def _as_dict(claim: Claim) -> dict:
    return {k: getattr(claim, k) for k in claims_mod.EDITABLE}


def _publish(s, reviewer, claim: Claim, override_reason: str):
    source = s.get(Source, claim.source_id)
    report = report_of(s, claim)
    fields = fields_of(s, claim)
    known = vocab.field_keys()

    problems = claims_mod.publish_gate(
        {"state": claim.state, "quote_verified": claim.quote_verified,
         "display_text": claim.display_text, "tracker": claim.tracker},
        fields, {"score": getattr(report, "score", 0)}, known,
        reviewer={"disabled_at": _disabled(reviewer)} if reviewer else None,
        override_reason=override_reason)
    if problems:
        return problems, None

    pair = claims_mod.pair_of(fields)
    row = Published(claim_id=claim.id,
                    correlation_id=vocab.correlation_by_pair().get(pair),
                    field_keys=[f["field_key"] for f in fields],
                    display_text=claim.display_text.strip(),
                    citation=citation_of(source), tracker=claim.tracker,
                    published_by=_id(reviewer))
    s.add(row)
    s.flush()
    regrade(s, pair)
    return [], row.id


def _unpublish(s, claim: Claim, reason: str) -> None:
    rows = (s.query(Published)
            .filter(Published.claim_id == claim.id, Published.revoked_at.is_(None)).all())
    pairs = set()
    for row in rows:
        row.revoked_at = now()
        row.revoked_reason = reason
        keys = row.field_keys or []
        if len(keys) >= 2:
            pairs.add((keys[0], keys[1]))
    s.flush()
    for pair in pairs:
        regrade(s, pair)


def regrade(s, pair) -> str:
    """A grade belongs to the pair, not to one study.

    Publishing a second randomised trial upgrades everything already standing
    under "Less sleep → more brain fog", so the badge moves for all of them or
    it is a lie about the one that did not move.
    """
    rows = live_for(s, pair)
    designs = []
    for _, source in rows:
        designs.append(design_points(source))
    badge = claims_mod.grade(designs)
    for published, _ in rows:
        published.grade = badge
    s.flush()
    return badge


def live_for(s, pair) -> list:
    """Every live published row bound to (exposure, outcome), with its source."""
    exposure, outcome = pair
    if not exposure or not outcome:
        return []
    out = []
    rows = (s.query(Published, Claim, Source)
            .join(Claim, Claim.id == Published.claim_id)
            .join(Source, Source.id == Claim.source_id)
            .filter(Published.revoked_at.is_(None)).all())
    for published, claim, source in rows:
        bound = {f.role: f.field_key for f in
                 s.query(ClaimField).filter(ClaimField.claim_id == claim.id).all()}
        if (bound.get("exposure"), bound.get("outcome")) == (exposure, outcome):
            out.append((published, source))
    return out


def candidates(s, limit: int = 50) -> list:
    """Pairs claims keep arriving about that Insights does not yet correlate.

    A feedback loop into insights.py rather than a dead end: if the literature
    keeps pairing two things the app records, that is an argument for the app to
    start pairing them too.
    """
    by_pair = vocab.correlation_by_pair()
    counts: dict = {}
    rows = (s.query(Claim).filter(Claim.state.in_(OPEN_STATES + ("published",))).all())
    for claim in rows:
        bound = {f.role: f.field_key for f in
                 s.query(ClaimField).filter(ClaimField.claim_id == claim.id).all()}
        pair = (bound.get("exposure"), bound.get("outcome"))
        if not pair[0] or not pair[1] or pair in by_pair:
            continue
        counts[pair] = counts.get(pair, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])[:limit]
    return [{"exposure": a, "outcome": b, "claims": n} for (a, b), n in ranked]


def proposed_fields(s, limit: int = 50) -> list:
    """Things the literature says people should track that the app does not ask.

    Dalīl never edits record.py. Adopting one of these is a human commit, which
    is the rule that keeps anything worth tracking a real field rather than a
    row in a table nobody renders.
    """
    counts: dict = {}
    rows = (s.query(ClaimField, Claim)
            .join(Claim, Claim.id == ClaimField.claim_id)
            .filter(ClaimField.proposed.is_(True)).all())
    for field, claim in rows:
        entry = counts.setdefault(field.field_key, {"key": field.field_key, "claims": 0,
                                                    "labels": set()})
        entry["claims"] += 1
        if claim.tracker and claim.tracker.get("label"):
            entry["labels"].add(claim.tracker["label"])
    out = [{"key": v["key"], "claims": v["claims"], "labels": sorted(v["labels"])}
           for v in counts.values()]
    return sorted(out, key=lambda e: -e["claims"])[:limit]
