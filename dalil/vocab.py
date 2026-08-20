"""
Dalīl — the app's vocabulary, borrowed rather than copied.

A claim is only useful if it binds to something the app actually records, so
this module is the list of things it records. It comes from `GET /record/schema`
— the same public contract the patient frontend consumes — rather than from a
copy of `record.py`, because two copies of a vocabulary drift and only one of
them is the one patients see.

Cached, with the last good answer kept indefinitely: the vocabulary changes
about once a month, and a reviewer should not be blocked because the other
container is restarting.
"""
from __future__ import annotations

import os
import threading
import time

import httpx

APP_URL = os.environ.get("APP_URL", "http://backend:8080")
TTL = 300.0
TIMEOUT = 10.0

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "record": None, "correlations": None}


class VocabUnavailable(RuntimeError):
    """The app has never answered, so there is no vocabulary to validate against."""


def _fetch(path: str, key: str, force: bool = False):
    with _lock:
        cached, at = _cache[key], _cache["at"]
    if cached is not None and not force and time.monotonic() - at < TTL:
        return cached
    try:
        reply = httpx.get(f"{APP_URL}{path}", timeout=TIMEOUT)
        reply.raise_for_status()
        data = reply.json()
    except Exception as e:
        if cached is not None:
            return cached          # a stale vocabulary beats no vocabulary
        raise VocabUnavailable(f"{APP_URL}{path}: {e}") from e
    with _lock:
        _cache[key] = data
        _cache["at"] = time.monotonic()
    return data


def record_schema(force: bool = False) -> dict:
    return _fetch("/record/schema", "record", force)


def correlations(force: bool = False) -> list:
    """The pairs the app already looks for in someone's own data."""
    return _fetch("/insights/correlations", "correlations", force).get("correlations", [])


def field_keys(force: bool = False) -> dict:
    """{field key: category key} — the closed vocabulary a claim may bind to."""
    return {f["key"]: group["key"]
            for group in record_schema(force)["schema"] for f in group["fields"]}


def field_labels(force: bool = False) -> dict:
    return {f["key"]: f.get("label", f["key"])
            for group in record_schema(force)["schema"] for f in group["fields"]}


def categories(force: bool = False) -> list:
    return record_schema(force).get("categories", [])


def correlation_by_pair(force: bool = False) -> dict:
    """{(exposure, outcome): id}. The eleven pairs are unique, so the pair is a
    key and a reviewer never has to pick a correlation from a second dropdown."""
    return {(c["a"], c["b"]): c["id"] for c in correlations(force)}


def reset() -> None:
    """Forget everything — for tests, and for a portal that wants a fresh read."""
    with _lock:
        _cache.update(at=0.0, record=None, correlations=None)
