"""
Dalīl — from a source to a report a person can argue with.

The order here is the whole safety story:

  1. score the deterministic half from PubMed's metadata and the corpus
  2. ask the model for the other half, and for any claims
  3. **search the stored text for every quote it gave back**
  4. anything unfound scores zero, and its claim is discarded here — before a
     reviewer ever sees it, let alone a patient
  5. store the report, and the claims that survived

Step 3 is code, not an instruction in a prompt, which is the difference between
hoping a model quoted accurately and knowing whether it did.
"""
from __future__ import annotations

import datetime as dt
import hashlib

from sqlalchemy import func

import appraise
import claims as claims_mod
import model as model_mod
import prompts
from models import Citation, Claim, ClaimField, Published, Report, Source

now = dt.datetime.utcnow


def text_of(source: Source) -> str:
    """What a quote is checked against: everything we hold, in one string."""
    return (source.fulltext or source.abstract or "")


def as_dict(source: Source) -> dict:
    return {"pmid": source.pmid, "pmcid": source.pmcid, "nbk": source.nbk, "kind": source.kind,
            "title": source.title or "", "abstract": source.abstract or "",
            "journal": source.journal or "", "book_title": source.book_title or "",
            "year": source.year, "pub_types": source.pub_types or [], "mesh": source.mesh or [],
            "coi": "", "retracted": bool(source.retracted), "flags": source.flags or [],
            "fulltext": source.fulltext or "", "licence": source.licence or ""}


def cited_by(s, source: Source) -> int:
    """How many sources already held cite this one.

    Distinct sources, not citation rows: a bibliography that lists the same
    paper twice is one source citing it, and the module's own note says
    "cited by N sources".
    """
    if not source.pmid:
        return 0
    return (s.query(func.count(func.distinct(Citation.source_id)))
            .filter(Citation.cited_pmid == source.pmid,
                    Citation.source_id != source.id).scalar() or 0)


def contradictions(s) -> dict:
    """{(exposure, outcome): direction} for every live published claim.

    Looked up once per report rather than once per claim: the published set is
    small, and a query per claim would be a query per finding.
    """
    rows = (s.query(Claim, Published)
            .join(Published, Published.claim_id == Claim.id)
            .filter(Published.revoked_at.is_(None)).all())
    out: dict = {}
    for claim, _ in rows:
        bound = {f.role: f.field_key for f in
                 s.query(ClaimField).filter(ClaimField.claim_id == claim.id).all()}
        key = (bound.get("exposure"), bound.get("outcome"))
        if key[0] and key[1] and claim.direction:
            out.setdefault(key, set()).add(claim.direction)
    return out


def _module_from(value):
    """A tool schema is guidance, not a guarantee.

    Everything that comes back from the model is untrusted input, and a module
    that arrives as a string or a list used to raise on `dict(value)` and take
    the whole batch with it. It scores zero and says what it was instead — which
    is the same treatment an unverifiable quote gets, for the same reason.
    """
    if isinstance(value, dict):
        return dict(value)
    return {"score": 0, "quote": "",
            "note": f"the model returned {type(value).__name__}, not an object"}


def _verify_modules(out: dict, text: str, passages) -> dict:
    """Attach a verdict to each module the model scored."""
    verified = {}
    out = out if isinstance(out, dict) else {}
    for key in appraise.MODEL_MODULES:
        got = _module_from(out.get(key))
        quote = got.get("quote")
        check = claims_mod.verify(text, quote if isinstance(quote, str) else "", passages)
        got.update(check)
        verified[key] = got
    return verified


def inputs_hash(source: Source) -> str:
    """Changes when the paper's text changes, so a re-appraisal of the same
    words under the same rubric is recognisable as a no-op."""
    return hashlib.sha256("\x1f".join([
        source.record_hash or "", str(len(source.fulltext or "")),
        prompts.APPRAISE_HASH, appraise.RUBRIC_VERSION]).encode()).hexdigest()


def existing_report(s, source: Source):
    return (s.query(Report)
            .filter(Report.source_id == source.id,
                    Report.prompt_version == prompts.APPRAISE_VERSION,
                    Report.rubric_version == appraise.RUBRIC_VERSION)
            .order_by(Report.created_at.desc()).first())


def appraise_source(s, source: Source, vocabulary: dict, *, use_model: bool = True,
                    http=None, force: bool = False, year_now: int | None = None,
                    call=None):
    """Appraise one source and store the report. Returns (Report, made, stats).

    `call` is the model call, injected so the tests can run the whole pipeline —
    verification, scoring, claim storage — without a network or an API key.
    """
    if not force:
        already = existing_report(s, source)
        if already is not None and already.inputs_hash == inputs_hash(source):
            return already, False, {"kept": 0, "dropped": 0, "reused": True}

    text = text_of(source)
    passages = source.passages or []
    known = vocabulary.get("fields") or {}
    labels = vocabulary.get("labels") or {}

    answer, verified, meta, narrative = None, None, {}, ""
    if use_model and text.strip():
        answer = (call or model_mod.appraise)(as_dict(source), known, labels, http=http)
        meta = {k: v for k, v in answer.items() if k != "out"}
        verified = _verify_modules(answer.get("out"), text, passages)
        said = answer.get("out") if isinstance(answer.get("out"), dict) else {}
        narrative = said.get("narrative") if isinstance(said.get("narrative"), str) else ""

    scored = appraise.appraise(as_dict(source), model=verified,
                               cited_by=cited_by(s, source),
                               year_now=year_now or dt.date.today().year)

    row = Report(source_id=source.id, prompt_version=prompts.APPRAISE_VERSION,
                 rubric_version=appraise.RUBRIC_VERSION, score=scored["score"],
                 verdict=scored["verdict"], modules=scored["modules"], flags=scored["flags"],
                 narrative=narrative, model=meta.get("model", ""),
                 inputs_hash=inputs_hash(source), tokens_in=meta.get("tokensIn", 0),
                 tokens_out=meta.get("tokensOut", 0))
    s.add(row)
    s.flush()

    stats = {"kept": 0, "dropped": 0, "reused": False,
             "verified": scored["verified"], "score": scored["score"],
             "verdict": scored["verdict"]}
    if answer is not None:
        kept, dropped, contradicting = store_claims(
            s, source, row, said.get("claims") or [], text, passages,
            known, contradictions(s))
        stats.update(kept=kept, dropped=dropped)
        if contradicting:
            row.flags = list(row.flags or []) + [f"contradicts_published:{p}" for p in contradicting]

    source.screen_state = "appraised"
    s.commit()
    return row, True, stats


def store_claims(s, source: Source, report: Report, proposed_claims, text: str,
                 passages, known: dict, published: dict):
    """Store what survived verification, and say what did not.

    A claim whose quote cannot be found in the stored text is not stored at all.
    It is not stored-and-flagged, or stored-for-review: a finding attributed to a
    sentence the paper does not contain has no value to anybody, and leaving it
    in the queue only costs a reviewer the time to work that out again.
    """
    kept = dropped = 0
    contradicting = set()

    for item in (proposed_claims if isinstance(proposed_claims, list) else []):
        if not isinstance(item, dict):
            dropped += 1
            continue
        quote = item.get("quote")
        check = claims_mod.verify(text, quote if isinstance(quote, str) else "", passages)
        if not check["verified"]:
            dropped += 1
            continue

        fields = []
        for role, key in (("exposure", item.get("exposure_field")),
                          ("outcome", item.get("outcome_field")),
                          ("moderator", item.get("moderator_field"))):
            if not key:
                continue
            fields.append({"field_key": key, "role": role, "proposed": key not in known})
        if claims_mod.validate_fields(fields, known):
            dropped += 1
            continue

        pair = claims_mod.pair_of(fields)
        direction = item.get("direction", "")
        if direction and direction != "0":
            other = published.get(pair) or set()
            if other and direction not in other:
                contradicting.add(f"{pair[0]}->{pair[1]}")

        claim = Claim(source_id=source.id, report_id=report.id, state="extracted",
                      claim_text=item.get("claim_text", ""),
                      relation=item.get("relation", "associated_with"),
                      direction=direction, population=item.get("population", ""),
                      effect=item.get("effect") or {},
                      certainty=item.get("certainty", ""),
                      quote=check["quote"], quote_section=check["section"],
                      quote_offset=check["offset"], quote_verified=True,
                      tracker=({"label": item.get("tracker_label")} if item.get("tracker_label") else None),
                      extracted_by=report.model or "model")
        s.add(claim)
        s.flush()
        for f in fields:
            s.add(ClaimField(claim_id=claim.id, field_key=f["field_key"],
                             role=f["role"], proposed=f["proposed"]))
        kept += 1

    return kept, dropped, sorted(contradicting)
