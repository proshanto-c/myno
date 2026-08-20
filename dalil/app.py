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

import auth
from models import Reviewer, Session, Source, init_db

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
            "started_at": STARTED_AT.isoformat()}


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
    s = Session()
    try:
        reviewer = auth.resolve(s, request.cookies.get(auth.COOKIE, ""))
        if reviewer is None:
            return {"signedIn": False}
        return {"signedIn": True, "email": reviewer.email,
                "name": reviewer.name, "role": reviewer.role}
    finally:
        s.close()


# ---- everything else --------------------------------------------------------
research = APIRouter(dependencies=[Depends(auth.require_reviewer)])


@research.get("/corpus")
def corpus(reviewer=Depends(auth.require_reviewer)):
    s = Session()
    try:
        rows = s.query(Source).order_by(Source.first_seen.desc()).limit(200).all()
        return {"sources": [{
            "id": r.id, "pmid": r.pmid, "pmcid": r.pmcid, "nbk": r.nbk, "kind": r.kind,
            "title": r.title, "journal": r.journal or r.book_title, "year": r.year,
            "isOa": r.is_oa, "licence": r.licence, "retracted": r.retracted,
            "screenState": r.screen_state,
        } for r in rows]}
    finally:
        s.close()


app.include_router(public)
app.include_router(research)
