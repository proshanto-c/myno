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
from sqlalchemy import func

import auth
import harvest
import ncbi
import vocab
from jobs import jobs
from models import Citation, Query, Reviewer, Run, Session, Source, init_db

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
        added = harvest.ensure_seeds(s)
        if added:
            print(f"[dalil] added {added} seed queries", flush=True)
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
        return {"signedIn": True, "authRequired": False, **auth.OPEN_REVIEWER}
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
        return {"sources": [_source_row(r) for r in rows],
                "summary": {
                    "total": live.count(),
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
                    outcome = harvest.enrich(s, client, row)
                    tally[outcome] = tally.get(outcome, 0) + 1
                return {"checked": len(rows), "outcomes": tally, "requests": client.requests}
        finally:
            s.close()

    return jobs.start("enrich", work, detail=f"up to {limit}")


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


app.include_router(public)
app.include_router(research)
