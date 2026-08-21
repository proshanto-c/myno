"""
Dalīl (دليل) — the researcher service.

Separate from the patient API on purpose: harvesting and appraisal are long
jobs, the patient app runs a single uvicorn worker, and this side needs its own
lock. It shares the database and nothing else, and it publishes no host port —
nginx is the only way in.

Two routers:
  /auth/*      unauthenticated: signing in, and nothing else
  /*           everything else, behind require_reviewer applied at the router
"""
import datetime as dt
import os

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import String, cast, func, or_

import httpx

import auth
import harvest
import model
import ncbi
import reports
import review
import vocab
from jobs import jobs
from models import (Citation, Claim, ClaimField, Published, Query, Report,
                    Review, Reviewer, Run, Session, Source, init_db)

app = FastAPI(title="Dalīl")

# The vocabulary comes from the patient app's public contract, not from a copied
# file — the same GET /record/schema the frontend already consumes.
APP_URL = os.environ.get("APP_URL", "http://backend:8080")

STARTED_AT = dt.datetime.utcnow()


@app.on_event("startup")
def _startup():
    init_db()
    s = Session()
    try:
        created = auth.bootstrap(s)
        if created:
            print(f"[dalil] bootstrapped the first reviewer: {created}", flush=True)
        seeds = harvest.ensure_seeds(s)
        if seeds["added"] or seeds["retuned"]:
            print(f"[dalil] seeds: {seeds['added']} added, {seeds['retuned']} "
                  f"retuned to {harvest.MIN_YEAR}+", flush=True)
    finally:
        s.close()


@app.get("/healthz")
def healthz():
    s = Session()
    try:
        reviewers = s.query(Reviewer).count()
        sources = s.query(Source).count()
    finally:
        s.close()
    return {"status": "ok", "reviewers": reviewers, "sources": sources,
            "authRequired": auth.auth_required(), "started_at": STARTED_AT.isoformat()}


# ---- signing in -------------------------------------------------------------
public = APIRouter(prefix="/auth")


class LoginIn(BaseModel):
    email: str
    password: str


@public.post("/login")
def login(body: LoginIn, request: Request, response: Response):
    s = Session()
    try:
        token = auth.login(s, body.email, body.password,
                           ip=(request.client.host if request.client else ""))
        reviewer = auth.resolve(s, token)
        auth.set_cookie(response, token)
        return {"email": reviewer.email, "name": reviewer.name, "role": reviewer.role}
    finally:
        s.close()


@public.post("/logout")
def logout(request: Request, response: Response):
    s = Session()
    try:
        auth.logout(s, request.cookies.get(auth.COOKIE, ""))
    finally:
        s.close()
    auth.clear_cookie(response)
    return {"ok": True}


@public.get("/whoami")
def whoami(request: Request):
    """Deliberately on the public router: the portal asks this on load to decide
    whether to show the login form, so it must answer without a session."""
    if not auth.auth_required():
        s = Session()
        try:
            return {"signedIn": True, "authRequired": False,
                    **auth.as_dict(auth.default_reviewer(s), default=True)}
        finally:
            s.close()
    s = Session()
    try:
        reviewer = auth.resolve(s, request.cookies.get(auth.COOKIE, ""))
        if reviewer is None:
            return {"signedIn": False, "authRequired": True}
        return {"signedIn": True, "authRequired": True, "email": reviewer.email,
                "name": reviewer.name, "role": reviewer.role}
    finally:
        s.close()


# ---- everything else --------------------------------------------------------
research = APIRouter(dependencies=[Depends(auth.require_reviewer)])


def _source_row(r: Source) -> dict:
    return {"id": r.id, "pmid": r.pmid, "pmcid": r.pmcid, "nbk": r.nbk, "kind": r.kind,
            "title": r.title, "journal": r.journal or r.book_title, "year": r.year,
            "authors": (r.authors or [])[:3], "pubTypes": r.pub_types or [],
            "isOa": r.is_oa, "licence": r.licence, "retracted": r.retracted,
            "hasFulltext": bool(r.fulltext), "flags": r.flags or [],
            "screenState": r.screen_state, "screenReason": r.screen_reason,
            "firstSeen": r.first_seen.isoformat() if r.first_seen else None}


@research.get("/corpus")
def corpus(limit: int = 200, state: str = "", q: str = ""):
    s = Session()
    try:
        rows = s.query(Source).filter(Source.merged_into.is_(None))
        if state:
            rows = rows.filter(Source.screen_state == state)
        if q:
            rows = rows.filter(Source.title.ilike(f"%{q}%"))
        rows = rows.order_by(Source.first_seen.desc()).limit(min(limit, 500)).all()

        counts = dict(s.query(Source.screen_state, func.count(Source.id))
                      .filter(Source.merged_into.is_(None))
                      .group_by(Source.screen_state).all())
        live = s.query(Source).filter(Source.merged_into.is_(None))
        # When PubMed was last asked, rather than when a row last changed: a
        # corpus that has not been synced for a week is stale even if nothing
        # in it has moved.
        synced = (s.query(func.max(Run.finished_at))
                  .filter(Run.state == "done").scalar())
        return {"sources": [_source_row(r) for r in rows],
                "summary": {
                    "total": live.count(),
                    "lastSync": synced.isoformat() if synced else None,
                    "byState": counts,
                    "openAccess": live.filter(Source.is_oa.is_(True)).count(),
                    "fulltext": live.filter(Source.fulltext.isnot(None)).count(),
                    "retracted": live.filter(Source.retracted.is_(True)).count(),
                    "unchecked": live.filter(Source.oa_checked_at.is_(None)).count(),
                    "citations": s.query(Citation).count(),
                    "unpromoted": s.query(Citation).filter(
                        Citation.promoted.is_(False), Citation.cited_pmid.isnot(None)).count(),
                }}
    finally:
        s.close()


@research.get("/source/{source_id}")
def source(source_id: int):
    s = Session()
    try:
        row = s.get(Source, source_id)
        if row is None:
            raise HTTPException(404, "no such source")
        refs = (s.query(Citation).filter(Citation.source_id == row.id).limit(200).all())
        return {**_source_row(row), "abstract": row.abstract,
                "mesh": row.mesh or [], "authors": row.authors or [],
                "fulltextChars": len(row.fulltext or ""),
                "passages": (row.passages or [])[:200],
                "citations": [{"pmid": c.cited_pmid, "doi": c.cited_doi,
                               "raw": c.raw, "promoted": c.promoted} for c in refs]}
    finally:
        s.close()


@research.get("/queries")
def queries():
    s = Session()
    try:
        out = []
        for row in s.query(Query).order_by(Query.name).all():
            last = (s.query(Run).filter(Run.query_id == row.id)
                    .order_by(Run.started_at.desc()).first())
            out.append({"id": row.id, "name": row.name, "term": row.term,
                        "informs": row.informs or [], "enabled": row.enabled,
                        "highWater": row.high_water,
                        "lastRun": _run_row(last) if last else None})
        return {"queries": out, "seeded": len(harvest.SEEDS)}
    finally:
        s.close()


def _run_row(r: Run) -> dict:
    return {"id": r.id, "queryId": r.query_id, "state": r.state, "total": r.total,
            "cap": r.cap, "cursor": r.cursor, "fetched": r.fetched, "added": r.added,
            "edatFrom": r.edat_from, "edatTo": r.edat_to, "error": r.error,
            "startedAt": r.started_at.isoformat() if r.started_at else None,
            "finishedAt": r.finished_at.isoformat() if r.finished_at else None}


@research.get("/runs")
def runs(limit: int = 25):
    s = Session()
    try:
        rows = s.query(Run).order_by(Run.started_at.desc()).limit(min(limit, 100)).all()
        return {"runs": [_run_row(r) for r in rows]}
    finally:
        s.close()


@research.get("/jobs")
def job_status():
    return jobs.status()


@research.get("/vocabulary")
def vocabulary():
    """What a claim may bind to, straight from the app's own contract."""
    try:
        return {"fields": vocab.field_keys(), "labels": vocab.field_labels(),
                "categories": vocab.categories(), "correlations": vocab.correlations()}
    except vocab.VocabUnavailable as e:
        raise HTTPException(503, str(e))


# ---- the long jobs ----------------------------------------------------------
class SeedIn(BaseModel):
    queryId: int | None = None
    max: int | None = 200
    force: bool = False


@research.post("/jobs/anchor")
def job_anchor():
    """The chapter this product takes its name from, and everything it cites.

    A bibliography somebody with the expertise already screened beats any
    keyword sweep, so this is the first thing to run against an empty corpus.
    """
    def work():
        s = Session()
        try:
            with ncbi.Client() as client:
                out = harvest.harvest_ids(s, client, harvest.ANCHOR_PMIDS)
                chained = {"promoted": 0, "added": 0, "fetched": 0}
                for pmid in harvest.ANCHOR_PMIDS:
                    row = s.query(Source).filter(Source.pmid == pmid).first()
                    if row is None:
                        continue
                    got = harvest.promote_citations(s, client, row)
                    for key in chained:
                        chained[key] += got.get(key, 0)
                return {"anchor": out, "chained": chained, "requests": client.requests}
        finally:
            s.close()

    return jobs.start("anchor", work, detail=", ".join(harvest.ANCHOR_PMIDS))


@research.post("/jobs/seed")
def job_seed(body: SeedIn):
    s = Session()
    try:
        harvest.ensure_seeds(s)
        row = (s.get(Query, body.queryId) if body.queryId
               else s.query(Query).filter(Query.enabled.is_(True))
                     .order_by(Query.high_water.asc(), Query.id.asc()).first())
        if row is None:
            raise HTTPException(404, "no query to run")
        query_id, name = row.id, row.name
    finally:
        s.close()

    cap = body.max
    if cap is None and not body.force and not ncbi.bulk_window_ok():
        # NCBI asks that large jobs run "either weekends or between 9:00 PM and
        # 5:00 AM Eastern". A capped look is small enough to be no trouble.
        raise HTTPException(409, "an uncapped run belongs in the quiet hours; "
                                 "pass a max, or force it")

    def work():
        s = Session()
        try:
            with ncbi.Client() as client:
                run = harvest.harvest(s, client, s.get(Query, query_id), max_records=cap)
                return {**_run_row(run), "requests": client.requests}
        finally:
            s.close()

    return jobs.start("seed", work, detail=name)


@research.post("/jobs/enrich")
def job_enrich(limit: int = 50):
    """Licence and retraction, and full text for the Open Access subset only."""
    def work():
        s = Session()
        try:
            rows = (s.query(Source)
                    .filter(Source.merged_into.is_(None), Source.oa_checked_at.is_(None))
                    .order_by(Source.first_seen.asc()).limit(min(limit, 200)).all())
            tally: dict = {}
            with ncbi.Client() as client:
                for row in rows:
                    # One awkward record must not cost the other fifty-nine: the
                    # cheapest thing a batch can do is keep going and say what
                    # went wrong at the end.
                    try:
                        outcome = harvest.enrich(s, client, row)
                    except ncbi.NcbiUnavailable:
                        tally["stopped"] = tally.get("stopped", 0) + 1
                        break
                    except Exception as e:
                        s.rollback()
                        outcome = f"error: {type(e).__name__}"
                    tally[outcome] = tally.get(outcome, 0) + 1
                return {"checked": len(rows), "outcomes": tally, "requests": client.requests}
        finally:
            s.close()

    return jobs.start("enrich", work, detail=f"up to {limit}")


@research.post("/jobs/prune")
def job_prune(minYear: int = 0, confirm: bool = False):
    """Drop everything published before the corpus window. Dry run by default —
    it answers with what it would remove before it removes anything."""
    s = Session()
    try:
        return harvest.prune_older_than(s, min_year=minYear or None, confirm=confirm)
    finally:
        s.close()


@research.post("/jobs/sweep")
def job_sweep(limit: int = 200):
    """Re-read retraction status, and un-publish what it costs."""
    def work():
        s = Session()
        try:
            with ncbi.Client() as client:
                out = harvest.sweep(s, client, limit=min(limit, 1000))
                return {**out, "requests": client.requests}
        finally:
            s.close()

    return jobs.start("sweep", work, detail=f"oldest {limit}")


class AppraiseIn(BaseModel):
    sourceId: int | None = None
    limit: int = 5
    force: bool = False
    useModel: bool = True


# Appraisal is the only thing here that costs money, so it never runs from a
# timer. Harvesting is automatic; appraising is asked for, in batches, under a
# cap that a mistake in a loop cannot spend past.
BATCH_CAP = 20
DAILY_CAP = 120


def _appraisable(s, limit: int):
    """Sources worth spending a call on: something to read, not yet appraised."""
    rows = (s.query(Source)
            .filter(Source.merged_into.is_(None), Source.retracted.is_(False),
                    Source.screen_state.in_(("new", "included")))
            .order_by(Source.fulltext.isnot(None).desc(), Source.year.desc().nullslast())
            .limit(limit * 4).all())
    out = []
    for row in rows:
        if not (row.abstract or row.fulltext):
            continue
        out.append(row)
        if len(out) >= limit:
            break
    return out


@research.post("/jobs/appraise")
def job_appraise(body: AppraiseIn):
    limit = max(1, min(body.limit, BATCH_CAP))

    def work():
        s = Session()
        try:
            spent_today = (s.query(Report)
                           .filter(Report.created_at >= dt.datetime.utcnow().replace(
                               hour=0, minute=0, second=0, microsecond=0)).count())
            room = max(0, DAILY_CAP - spent_today)
            if room == 0:
                return {"appraised": 0, "note": f"the daily cap of {DAILY_CAP} is spent"}

            targets = ([s.get(Source, body.sourceId)] if body.sourceId
                       else _appraisable(s, min(limit, room)))
            targets = [t for t in targets if t is not None]
            vocabulary = {"fields": vocab.field_keys(), "labels": vocab.field_labels()}

            done, claims_kept, claims_dropped, tokens = [], 0, 0, 0
            with httpx.Client(timeout=model.TIMEOUT) as http:
                for row in targets:
                    report, made, stats = reports.appraise_source(
                        s, row, vocabulary, use_model=body.useModel, http=http, force=body.force)
                    claims_kept += stats.get("kept", 0)
                    claims_dropped += stats.get("dropped", 0)
                    tokens += (report.tokens_in or 0) + (report.tokens_out or 0)
                    done.append({"sourceId": row.id, "pmid": row.pmid, "score": report.score,
                                 "verdict": report.verdict, "made": made,
                                 "kept": stats.get("kept", 0), "dropped": stats.get("dropped", 0)})
            return {"appraised": len(done), "claims": claims_kept, "discarded": claims_dropped,
                    "tokens": tokens, "results": done, "capLeft": room - len(done)}
        finally:
            s.close()

    return jobs.start("appraise", work, detail=f"{limit} source(s)")


def _report_row(r: Report) -> dict:
    return {"id": r.id, "sourceId": r.source_id, "score": r.score, "verdict": r.verdict,
            "modules": r.modules or [], "flags": r.flags or [], "narrative": r.narrative or "",
            "model": r.model, "rubricVersion": r.rubric_version,
            "promptVersion": r.prompt_version, "tokensIn": r.tokens_in, "tokensOut": r.tokens_out,
            "createdAt": r.created_at.isoformat() if r.created_at else None}


def _claim_row(s, c: Claim) -> dict:
    bound = s.query(ClaimField).filter(ClaimField.claim_id == c.id).all()
    return {"id": c.id, "sourceId": c.source_id, "state": c.state, "claimText": c.claim_text,
            "relation": c.relation, "direction": c.direction, "population": c.population,
            "effect": c.effect or {}, "certainty": c.certainty,
            "quote": c.quote, "quoteSection": c.quote_section, "quoteOffset": c.quote_offset,
            "quoteVerified": c.quote_verified, "displayText": c.display_text,
            "tracker": c.tracker,
            "fields": [{"key": f.field_key, "role": f.role, "proposed": f.proposed} for f in bound]}


SORTS = {"recent": Report.created_at.desc(),
         "score": Report.score.desc(),
         "weakest": Report.score.asc()}


@research.get("/reports")
def report_list(limit: int = 50, q: str = "", verdict: str = "", flagged: bool = False,
                sort: str = "recent"):
    """Filtered on the server, because the list is capped: filtering the page
    after it arrives would search fifty of four hundred reports and call the
    answer none."""
    s = Session()
    try:
        rows = s.query(Report, Source).join(Source, Source.id == Report.source_id)
        if verdict:
            rows = rows.filter(Report.verdict == verdict)
        if flagged:
            # `flags` is a JSON column; comparing its text is exact and does not
            # care which JSON functions this Postgres has.
            rows = rows.filter(cast(Report.flags, String).notin_(("[]", "null")))
        if q.strip():
            like = f"%{q.strip()}%"
            # Title, journal and PMID are the three a researcher types; the
            # narrative is there so a half-remembered finding is findable.
            rows = rows.filter(or_(Source.title.ilike(like), Source.journal.ilike(like),
                                   Source.pmid.ilike(like), Report.narrative.ilike(like)))

        total = rows.count()
        found = rows.order_by(SORTS.get(sort, SORTS["recent"])).limit(min(limit, 200)).all()
        counted = dict(s.query(Claim.report_id, func.count(Claim.id))
                       .filter(Claim.report_id.in_([r.id for r, _ in found] or [0]))
                       .group_by(Claim.report_id).all())
        return {"reports": [{**_report_row(r), "title": src.title, "pmid": src.pmid,
                             "journal": src.journal or src.book_title, "year": src.year,
                             "claims": counted.get(r.id, 0)}
                            for r, src in found],
                "total": total,
                "verdicts": dict(s.query(Report.verdict, func.count(Report.id))
                                 .group_by(Report.verdict).all())}
    finally:
        s.close()


@research.get("/report/{source_id}")
def report_for(source_id: int):
    s = Session()
    try:
        row = s.get(Source, source_id)
        if row is None:
            raise HTTPException(404, "no such source")
        report = (s.query(Report).filter(Report.source_id == source_id)
                  .order_by(Report.created_at.desc()).first())
        found = (s.query(Claim).filter(Claim.source_id == source_id)
                 .order_by(Claim.id.asc()).all())
        return {"source": _source_row(row),
                "report": _report_row(report) if report else None,
                "claims": [_claim_row(s, c) for c in found],
                "citedBy": reports.cited_by(s, row)}
    finally:
        s.close()


# ---- review -----------------------------------------------------------------
class ReviewIn(BaseModel):
    action: str
    changes: dict | None = None
    note: str = ""
    overrideReason: str = ""


def _queue_row(s, claim: Claim, report: Report, source: Source) -> dict:
    return {**_claim_row(s, claim),
            "source": {"id": source.id, "title": source.title, "pmid": source.pmid,
                       "journal": source.journal or source.book_title, "year": source.year,
                       "licence": source.licence, "retracted": source.retracted},
            "report": {"id": report.id, "score": report.score, "verdict": report.verdict,
                       "flags": report.flags or []} if report else None}


@research.get("/queue")
def review_queue(limit: int = 50, state: str = "", reviewer=Depends(auth.require_reviewer)):
    s = Session()
    try:
        rows = review.queue(s, limit=limit, state=state)
        return {"claims": [_queue_row(s, c, r, src) for c, r, src in rows],
                "open": s.query(Claim).filter(Claim.state.in_(review.OPEN_STATES)).count(),
                "published": s.query(Published).filter(Published.revoked_at.is_(None)).count(),
                "signedIn": auth.auth_required(), "reviewer": reviewer.get("email")}
    finally:
        s.close()


@research.post("/claim/{claim_id}/review")
def review_claim(claim_id: int, body: ReviewIn, reviewer=Depends(auth.require_reviewer)):
    s = Session()
    try:
        claim = s.get(Claim, claim_id)
        if claim is None:
            raise HTTPException(404, "no such claim")
        try:
            out = review.act(s, reviewer, claim, body.action, changes=body.changes,
                             note=body.note, override_reason=body.overrideReason)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {**out, "claim": _claim_row(s, claim)}
    finally:
        s.close()


@research.get("/claim/{claim_id}/audit")
def claim_audit(claim_id: int):
    s = Session()
    try:
        rows = (s.query(Review).filter(Review.claim_id == claim_id)
                .order_by(Review.created_at.asc()).all())
        names = {r.id: r.email for r in s.query(Reviewer).all()}
        return {"audit": [{"id": r.id, "action": r.action, "note": r.note,
                           "before": r.before, "after": r.after,
                           "by": names.get(r.reviewer_id) or "unsigned",
                           "at": r.created_at.isoformat() if r.created_at else None}
                          for r in rows]}
    finally:
        s.close()


@research.get("/published")
def published(limit: int = 200):
    s = Session()
    try:
        rows = (s.query(Published).filter(Published.revoked_at.is_(None))
                .order_by(Published.published_at.desc()).limit(min(limit, 500)).all())
        names = {r.id: r.email for r in s.query(Reviewer).all()}
        return {"published": [{
            "id": r.id, "claimId": r.claim_id, "correlationId": r.correlation_id,
            "fieldKeys": r.field_keys or [], "displayText": r.display_text, "grade": r.grade,
            "citation": r.citation or {}, "tracker": r.tracker,
            # No `published_by` means sign-in was off when this was published.
            # An unsigned row is not a review somebody put their name to, and
            # saying so here is cheaper than discovering it later.
            "signed": bool(r.published_by), "by": names.get(r.published_by) or "unsigned",
            "at": r.published_at.isoformat() if r.published_at else None}
            for r in rows]}
    finally:
        s.close()


@research.get("/candidates")
def candidate_pairs():
    """Two feedback loops into the app: pairs worth correlating, and fields
    worth recording. Neither is applied automatically."""
    s = Session()
    try:
        return {"correlations": review.candidates(s), "fields": review.proposed_fields(s)}
    finally:
        s.close()


app.include_router(public)
app.include_router(research)
