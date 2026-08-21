"""
Tawaazun — what Dalīl has published, read straight out of the table.

One table, `dalil_published`, and nothing else. No HTTP call, so the app does
not care whether the evidence module is running; no ORM model, because this side
is a reader of somebody else's table and declaring a model here would let
`create_all` bring a half-built version of it into existence before Dalīl ever
starts.

If the table is not there — a database that has never run Dalīl — every function
here returns empty and the app shows what it showed before. That is the intended
behaviour, not a fallback: a correlation with no studies behind it is still a
correlation in someone's own data.
"""
import json
import threading
import time

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

import record

TTL = 60.0                      # Insights is opened repeatedly; the table changes rarely

_lock = threading.Lock()
_cache = {"at": 0.0, "rows": None}

ROWS = text("""
    SELECT correlation_id, field_keys, display_text, grade, citation, tracker, published_by
      FROM dalil_published
     WHERE revoked_at IS NULL
     ORDER BY published_at DESC
""")


def _decode(value):
    """psycopg2 hands JSON back decoded; a text column would not be."""
    if isinstance(value, (dict, list)) or value is None:
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def rows(engine, force: bool = False) -> list:
    with _lock:
        cached, at = _cache["rows"], _cache["at"]
    if cached is not None and not force and time.monotonic() - at < TTL:
        return cached

    found = []
    try:
        # Its own connection, so a missing table cannot poison a transaction the
        # rest of a request is using.
        with engine.connect() as conn:
            for row in conn.execute(ROWS):
                found.append({
                    "correlationId": row[0],
                    "fieldKeys": _decode(row[1]) or [],
                    "displayText": row[2] or "",
                    "grade": row[3] or "",
                    "citation": _decode(row[4]) or {},
                    "tracker": _decode(row[5]),
                    "signed": bool(row[6]),
                })
    except SQLAlchemyError:
        # No Dalīl on this database yet. Cached as empty so the app does not ask
        # again on every render of the Insights page.
        found = []

    with _lock:
        _cache["rows"], _cache["at"] = found, time.monotonic()
    return found


def by_correlation(engine) -> dict:
    """{correlation id: [study, …]} — what the literature says about each pair.

    Deliberately not "the evidence for your correlation": a study is not
    evidence about *their* r, and the heading in the app says so.
    """
    out: dict = {}
    for row in rows(engine):
        if not row["correlationId"]:
            continue
        out.setdefault(row["correlationId"], []).append({
            "text": row["displayText"], "grade": row["grade"],
            "signed": row["signed"], **row["citation"]})
    return out


# Strongest first, for collapsing duplicates.
GRADE_ORDER = {"Strong": 3, "Emerging": 2, "Early": 1, "": 0}


def trackers(engine) -> list:
    """"What else to track", as published claims rather than as a prompt.

    The "not already tracked" rule is computed here instead of being asked of a
    model: anything bound only to fields `record.py` already has is, by
    definition, already tracked.

    One entry per thing to track, not per claim. Two published findings about
    time-restricted eating are two studies about one tracker, and showing
    "Eating window" twice tells a reader nothing except that the list is
    machine-made.
    """
    out = []
    for row in rows(engine):
        payload = row["tracker"] or {}
        label = (payload.get("label") or "").strip()
        if not label:
            continue
        novel = [k for k in row["fieldKeys"] if k not in record.FIELD_CATEGORY]
        if not novel:
            continue
        citation = row["citation"] or {}
        requires_device = bool(payload.get("requiresDevice"))
        out.append({
            "tracker": label,
            "explanation": payload.get("explanation") or row["displayText"],
            "category": payload.get("category", ""),
            "evidence": row["grade"],
            "tracking_method": payload.get("method", ""),
            "requires_device": requires_device,
            "device_needed": payload.get("deviceNeeded"),
            "device_owned": not requires_device,
            # A specific paper, at its own address — not a PubMed search built
            # from words a model chose, which is what used to sit behind this.
            "read_more": citation.get("url", ""),
            "pmid": citation.get("pmid"), "title": citation.get("title"),
            "journal": citation.get("journal"), "year": citation.get("year"),
            "signed": row["signed"],
            "studies": 1,
        })

    collapsed: dict = {}
    for item in out:
        key = item["tracker"].strip().lower()
        seen = collapsed.get(key)
        if seen is None:
            collapsed[key] = item
            continue
        seen["studies"] += 1
        # The card carries one citation, so it should be the strongest one.
        if GRADE_ORDER.get(item["evidence"], 0) > GRADE_ORDER.get(seen["evidence"], 0):
            keep = seen["studies"]
            collapsed[key] = {**item, "studies": keep}

    final = list(collapsed.values())
    final.sort(key=lambda t: (t["requires_device"], not t["device_owned"],
                              -GRADE_ORDER.get(t["evidence"], 0)))
    return final


def reset() -> None:
    with _lock:
        _cache["rows"], _cache["at"] = None, 0.0
