"""
Exercises the login boundary directly. No server, no network.

Run:  docker compose exec -T dalil python test_auth.py

Uses the real database, on throwaway accounts whose emails start with `test:`,
cleaned up at the end — the same convention as backend/test_api.py.
"""
import datetime as dt
import uuid

from fastapi import HTTPException

import auth
from models import Reviewer, Session, SessionRow, init_db

T = []
test = lambda fn: (T.append((fn.__name__, fn)), fn)[1]
PASSWORD = "correct horse battery staple"
_made = []


def new_reviewer(s, *, password=PASSWORD, disabled=False):
    email = f"test:{uuid.uuid4().hex[:12]}@example.invalid"
    r = Reviewer(email=email, name="Test", role="reviewer",
                 password_hash=auth.hash_password(password),
                 disabled_at=dt.datetime.utcnow() if disabled else None)
    s.add(r); s.commit()
    _made.append(r.id)
    return r


# ---- hashing ---------------------------------------------------------------
@test
def test_a_password_verifies_against_its_own_hash():
    stored = auth.hash_password(PASSWORD)
    assert auth.verify_password(PASSWORD, stored)
    assert not auth.verify_password(PASSWORD + " ", stored)
    assert not auth.verify_password("", stored)


@test
def test_the_same_password_hashes_differently_every_time():
    # a shared salt would let one cracked hash unlock every account using it
    assert auth.hash_password(PASSWORD) != auth.hash_password(PASSWORD)


@test
def test_the_cost_travels_inside_the_hash():
    stored = auth.hash_password(PASSWORD, rounds=1000)
    assert stored.startswith("pbkdf2_sha256$1000$")
    # so an old hash still verifies after the default is raised
    assert auth.verify_password(PASSWORD, stored)


@test
def test_a_corrupt_hash_fails_rather_than_raising():
    for junk in ("", "nonsense", "pbkdf2_sha256$x$y$z", "argon2$1$2$3", "a$b$c$d$e"):
        assert auth.verify_password(PASSWORD, junk) is False, junk


# ---- signing in ------------------------------------------------------------
@test
def test_signing_in_returns_a_session_that_resolves():
    s = Session()
    try:
        r = new_reviewer(s)
        token = auth.login(s, r.email, PASSWORD)
        assert auth.resolve(s, token).id == r.id
    finally:
        s.close()


@test
def test_the_token_itself_is_never_stored():
    s = Session()
    try:
        r = new_reviewer(s)
        token = auth.login(s, r.email, PASSWORD)
        rows = s.query(SessionRow).filter(SessionRow.reviewer_id == r.id).all()
        assert rows and all(row.token_sha256 != token for row in rows)
        assert rows[0].token_sha256 == auth.token_fingerprint(token)
    finally:
        s.close()


@test
def test_a_wrong_password_is_refused():
    s = Session()
    try:
        auth.reset_failures()
        r = new_reviewer(s)
        try:
            auth.login(s, r.email, "wrong")
            assert False, "logged in with the wrong password"
        except HTTPException as e:
            assert e.status_code == 401
    finally:
        s.close()


@test
def test_an_unknown_email_looks_the_same_as_a_wrong_password():
    s = Session()
    try:
        auth.reset_failures()
        try:
            auth.login(s, "test:nobody@example.invalid", PASSWORD)
            assert False, "logged in as nobody"
        except HTTPException as e:
            assert e.status_code == 401
            assert "match" in e.detail          # not "no such account"
    finally:
        s.close()


@test
def test_a_disabled_account_cannot_sign_in():
    s = Session()
    try:
        auth.reset_failures()
        r = new_reviewer(s, disabled=True)
        try:
            auth.login(s, r.email, PASSWORD)
            assert False, "a disabled account signed in"
        except HTTPException as e:
            assert e.status_code == 401
    finally:
        s.close()


@test
def test_disabling_an_account_kills_its_live_sessions():
    s = Session()
    try:
        r = new_reviewer(s)
        token = auth.login(s, r.email, PASSWORD)
        assert auth.resolve(s, token) is not None
        r.disabled_at = dt.datetime.utcnow(); s.commit()
        assert auth.resolve(s, token) is None
    finally:
        s.close()


# ---- sessions --------------------------------------------------------------
@test
def test_an_expired_session_does_not_resolve():
    s = Session()
    try:
        r = new_reviewer(s)
        token = auth.login(s, r.email, PASSWORD)
        later = dt.datetime.utcnow() + dt.timedelta(days=auth.SESSION_DAYS + 1)
        assert auth.resolve(s, token, now=later) is None
    finally:
        s.close()


@test
def test_an_active_session_slides_rather_than_expiring_mid_review():
    s = Session()
    try:
        r = new_reviewer(s)
        token = auth.login(s, r.email, PASSWORD)
        row = s.query(SessionRow).filter(
            SessionRow.token_sha256 == auth.token_fingerprint(token)).first()
        before = row.expires_at
        auth.resolve(s, token, now=dt.datetime.utcnow() + dt.timedelta(days=2))
        s.refresh(row)
        assert row.expires_at > before
    finally:
        s.close()


@test
def test_logging_out_revokes_immediately():
    s = Session()
    try:
        r = new_reviewer(s)
        token = auth.login(s, r.email, PASSWORD)
        auth.logout(s, token)
        assert auth.resolve(s, token) is None
    finally:
        s.close()


@test
def test_a_made_up_token_resolves_to_nobody():
    s = Session()
    try:
        assert auth.resolve(s, "") is None
        assert auth.resolve(s, "not-a-real-token") is None
    finally:
        s.close()


# ---- the throttle ----------------------------------------------------------
@test
def test_repeated_failures_are_throttled():
    s = Session()
    try:
        auth.reset_failures()
        r = new_reviewer(s)
        for _ in range(auth.MAX_FAILURES):
            try:
                auth.login(s, r.email, "wrong", ip="10.0.0.1")
            except HTTPException as e:
                assert e.status_code == 401
        try:
            auth.login(s, r.email, "wrong", ip="10.0.0.1")
            assert False, "not throttled"
        except HTTPException as e:
            assert e.status_code == 429
        # and the right password is refused too, while the window is open
        try:
            auth.login(s, r.email, PASSWORD, ip="10.0.0.1")
            assert False, "throttle bypassed by a correct password"
        except HTTPException as e:
            assert e.status_code == 429
    finally:
        auth.reset_failures()
        s.close()


@test
def test_the_throttle_window_reopens():
    s = Session()
    try:
        auth.reset_failures()
        r = new_reviewer(s)
        start = dt.datetime.utcnow()
        for _ in range(auth.MAX_FAILURES):
            try:
                auth.login(s, r.email, "wrong", ip="10.0.0.2", now=start)
            except HTTPException:
                pass
        later = start + auth.FAILURE_WINDOW + dt.timedelta(seconds=1)
        assert auth.login(s, r.email, PASSWORD, ip="10.0.0.2", now=later)
    finally:
        auth.reset_failures()
        s.close()


@test
def test_signing_in_clears_the_count():
    s = Session()
    try:
        auth.reset_failures()
        r = new_reviewer(s)
        for _ in range(3):
            try:
                auth.login(s, r.email, "wrong", ip="10.0.0.3")
            except HTTPException:
                pass
        auth.login(s, r.email, PASSWORD, ip="10.0.0.3")
        assert not auth._failures.get(f"{r.email}|10.0.0.3")
    finally:
        auth.reset_failures()
        s.close()


# ---- the switch ------------------------------------------------------------
@test
def test_sign_in_is_off_by_default_and_says_so():
    import os
    os.environ.pop("DALIL_REQUIRE_AUTH", None)
    assert auth.auth_required() is False
    # and with it off, the gate lets anyone through rather than 401-ing
    class FakeRequest:
        method = "GET"; cookies = {}; headers = {}
    who = auth.require_reviewer(FakeRequest())
    # …as a real account, not as nobody: a review has to have an author, and the
    # standing admin is a truer one than a null column
    assert who["default"] is True
    assert who["id"] and who["email"]


@test
def test_turning_it_on_restores_the_gate():
    import os
    class FakeRequest:
        method = "GET"; cookies = {}; headers = {}
    os.environ["DALIL_REQUIRE_AUTH"] = "1"
    try:
        assert auth.auth_required() is True
        try:
            auth.require_reviewer(FakeRequest())
            assert False, "the gate let an anonymous request through"
        except HTTPException as e:
            assert e.status_code == 401
    finally:
        os.environ.pop("DALIL_REQUIRE_AUTH", None)


# ---- bootstrap -------------------------------------------------------------
@test
def test_bootstrap_does_nothing_once_an_account_exists():
    import os
    s = Session()
    try:
        new_reviewer(s)                      # guarantees at least one
        os.environ["DALIL_BOOTSTRAP"] = "test:boot@example.invalid:hunter2hunter2"
        assert auth.bootstrap(s) == ""
        assert s.query(Reviewer).filter(
            Reviewer.email == "test:boot@example.invalid").first() is None
    finally:
        os.environ.pop("DALIL_BOOTSTRAP", None)
        s.close()


def cleanup():
    s = Session()
    try:
        for rid in _made:
            s.query(SessionRow).filter(SessionRow.reviewer_id == rid).delete()
        s.query(Reviewer).filter(Reviewer.id.in_(_made)).delete(synchronize_session=False)
        s.commit()
    finally:
        s.close()


if __name__ == "__main__":
    init_db()
    passed = failed = 0
    for name, fn in T:
        try:
            fn(); passed += 1
        except AssertionError as e:
            failed += 1; print(f"FAIL {name}: {e}")
        except Exception as e:
            failed += 1; print(f"ERROR {name}: {type(e).__name__}: {e}")
    cleanup()
    print(f"{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
