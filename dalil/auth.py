"""
Who is reviewing, and how we know.

The whole module's value rests on "a named person checked this", so identity is
not decoration here — it is the product. Three decisions:

  - Passwords use stdlib pbkdf2_hmac at 600,000 iterations. No argon2, no
    passlib: this needs no compiled dependency and the parameters are visible
    in the stored string, so they can be raised later without guessing.
  - Sessions are rows, not signed tokens. Only the sha256 of the token is
    stored, so a database dump is not a set of live logins, and revoking one is
    an UPDATE rather than a key rotation.
  - The gate is a router dependency, applied once. Per-route decorators fail by
    omission, and the one you forget is the one that matters.
"""
import base64
import datetime as dt
import hashlib
import hmac
import os
import secrets

from fastapi import Depends, HTTPException, Request, Response

from models import Reviewer, Session, SessionRow

# Cost, not a secret. Named so raising it later is a one-line change with a
# migration path: the iteration count travels inside every stored hash.
PBKDF2_ROUNDS = 600_000
SESSION_DAYS = 14
SESSION_REFRESH_AFTER = dt.timedelta(days=1)   # slide the expiry at most daily
COOKIE = "dalil_session"

# A brute-force floor. One uvicorn worker, so an in-memory counter is correct
# here rather than a compromise.
MAX_FAILURES = 10
FAILURE_WINDOW = dt.timedelta(minutes=15)
_failures: dict = {}


def hash_password(password: str, *, rounds: int = PBKDF2_ROUNDS, salt: bytes = b"") -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, rounds)
    b64 = lambda raw: base64.b64encode(raw).decode()
    return f"pbkdf2_sha256${rounds}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt_b64, digest_b64 = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(rounds))
    except Exception:
        return False
    return hmac.compare_digest(actual, expected)


def token_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---- the throttle -----------------------------------------------------------
def _too_many(key: str, now: dt.datetime) -> bool:
    hits = [t for t in _failures.get(key, []) if now - t < FAILURE_WINDOW]
    _failures[key] = hits
    return len(hits) >= MAX_FAILURES


def _record_failure(key: str, now: dt.datetime) -> None:
    _failures.setdefault(key, []).append(now)


def reset_failures() -> None:
    _failures.clear()


# ---- logging in and out -----------------------------------------------------
def login(s, email: str, password: str, *, ip: str = "", now: dt.datetime = None) -> str:
    """Returns the session token. Raises 401 for anything that failed, without
    saying which part — a wrong email and a wrong password look identical."""
    now = now or dt.datetime.utcnow()
    key = f"{(email or '').lower()}|{ip}"
    if _too_many(key, now):
        raise HTTPException(429, "Too many attempts. Try again in fifteen minutes.")

    reviewer = s.query(Reviewer).filter(Reviewer.email == (email or "").lower().strip()).first()
    ok = reviewer is not None and reviewer.disabled_at is None \
        and verify_password(password or "", reviewer.password_hash)
    if not ok:
        _record_failure(key, now)
        raise HTTPException(401, "Those details don't match an account.")

    token = secrets.token_urlsafe(32)
    s.add(SessionRow(reviewer_id=reviewer.id, token_sha256=token_fingerprint(token),
                     created_at=now, last_seen=now,
                     expires_at=now + dt.timedelta(days=SESSION_DAYS)))
    s.commit()
    _failures.pop(key, None)
    return token


def logout(s, token: str, *, now: dt.datetime = None) -> None:
    now = now or dt.datetime.utcnow()
    row = s.query(SessionRow).filter(SessionRow.token_sha256 == token_fingerprint(token)).first()
    if row and row.revoked_at is None:
        row.revoked_at = now
        s.commit()


def resolve(s, token: str, *, now: dt.datetime = None):
    """The session's reviewer, or None. Slides the expiry at most once a day so
    an active reviewer is not logged out mid-review."""
    now = now or dt.datetime.utcnow()
    if not token:
        return None
    row = s.query(SessionRow).filter(SessionRow.token_sha256 == token_fingerprint(token)).first()
    if row is None or row.revoked_at is not None or row.expires_at <= now:
        return None
    reviewer = s.get(Reviewer, row.reviewer_id)
    if reviewer is None or reviewer.disabled_at is not None:
        return None
    if now - row.last_seen > SESSION_REFRESH_AFTER:
        row.last_seen = now
        row.expires_at = now + dt.timedelta(days=SESSION_DAYS)
        s.commit()
    return reviewer


def set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, secure=True,
        samesite="strict", path="/",
    )


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/")


# ---- the gate ---------------------------------------------------------------
def auth_required() -> bool:
    """Off while the portal is being built, on with one environment variable.

    Turned off, the portal is open to anyone who reaches /research/ — which is
    only the corpus metadata, all of it already public on PubMed. It has to go
    back on before anything is *published*, because an unsigned review is not a
    review: "a named person checked this" is the whole claim the module makes.
    """
    return os.environ.get("DALIL_REQUIRE_AUTH", "0").lower() in ("1", "true", "yes")


OPEN_REVIEWER = {"id": None, "email": "", "name": "Signed out", "role": "open"}


def require_reviewer(request: Request):
    """Applied once, on the router. Every research route is behind this."""
    if not auth_required():
        return dict(OPEN_REVIEWER)
    s = Session()
    try:
        reviewer = resolve(s, request.cookies.get(COOKIE, ""))
        if reviewer is None:
            raise HTTPException(401, "Sign in to continue.")
        # SameSite=strict already covers CSRF; this header makes a cross-site
        # form post impossible to construct even if a browser gets that wrong.
        if request.method not in ("GET", "HEAD") and request.headers.get("x-dalil") != "1":
            raise HTTPException(403, "Missing X-Dalil header.")
        return {"id": reviewer.id, "email": reviewer.email,
                "name": reviewer.name, "role": reviewer.role}
    finally:
        s.close()


def bootstrap(s) -> str:
    """Create the first account from DALIL_BOOTSTRAP=email:password, and only
    while there are none. Self-disabling, so leaving it set is harmless."""
    spec = os.environ.get("DALIL_BOOTSTRAP", "")
    if not spec or ":" not in spec:
        return ""
    if s.query(Reviewer).count() > 0:
        return ""
    email, password = spec.split(":", 1)
    email = email.lower().strip()
    s.add(Reviewer(email=email, name=email.split("@")[0], role="admin",
                   password_hash=hash_password(password)))
    s.commit()
    return email
