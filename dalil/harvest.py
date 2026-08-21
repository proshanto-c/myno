"""
Dalīl — turning searches into a corpus.

Three jobs, kept apart because they fail differently:

  `advance()`   pulls a search down from the History server, a batch at a time,
                committing the cursor after each one. That is the whole
                resumability story: a restart resumes at `retstart`.
  `enrich()`    asks the two per-article questions — licence and retraction —
                and, for the Open Access subset only, stores full text.
  `sweep()`     re-reads retraction status and revokes anything published from
                a paper that has since been withdrawn.

A note on seeds. The bare term returns 28,374 records, which is not a corpus
anybody can review; every seed here is anchored on the MeSH descriptor and
narrowed to one part of what the app actually asks people to record, and says
in `informs` which fields it exists for. Alongside them, and better than any of
them, is citation chaining: a reference work's bibliography has already been
screened by a domain expert, so `promote_citations()` on NBK459251 is the
highest-yield seed in the module.
"""
from __future__ import annotations

import datetime as dt
import re

from sqlalchemy import func

import ncbi
from models import (Citation, Claim, ClaimField, Published, Query, Report,
                    Review, Run, Source)

now = dt.datetime.utcnow

# Anchored on the descriptor, plus the name the condition was renamed to, which
# has no MeSH heading of its own yet and so has to be matched as text.
PMOS = ('("Polycystic Ovary Syndrome"[MeSH Terms] '
        'OR "polyendocrine metabolic ovarian syndrome"[tiab] OR "PMOS"[tiab])')

# Keeps unindexed records — a plain `humans[MeSH]` filter silently drops
# everything published in the last few months, which is the half most worth having.
NOT_ANIMAL_ONLY = 'NOT (animals[MeSH Terms] NOT humans[MeSH Terms])'


# How far back the corpus goes. The condition was renamed in 2026 and the
# guideline it is assessed against is the 2023 one, so anything older is being
# read through two revisions of the definition. Moving this moves every seed,
# and `ensure_seeds` retunes the stored queries to match.
MIN_YEAR = 2024


def _seed(name, clause, informs, min_year=None):
    min_year = min_year or MIN_YEAR
    return {"name": name,
            "term": f"{PMOS} AND ({clause}) AND ({min_year}:3000[dp]) {NOT_ANIMAL_ONLY}",
            "informs": informs, "min_year": min_year}


YEAR_FLOOR = re.compile(r"\((\d{4}):3000\[dp\]\)")


def retune(term: str, min_year: int = None):
    """The term with its year floor moved, or None if it has no year floor.

    Narrow on purpose. A stored query is otherwise never rewritten — a corpus
    has to stay reproducible — but the window the corpus covers is a decision
    about the whole library, not about one seed, and leaving twelve queries
    disagreeing with it would be worse than editing them.
    """
    min_year = min_year or MIN_YEAR
    moved = YEAR_FLOOR.sub(f"({min_year}:3000[dp])", term or "")
    return moved if moved != term else None


# Each seed exists to inform particular record.py fields, and says which.
SEEDS = [
    _seed("sleep", '"sleep"[MeSH Terms] OR sleep[tiab] OR insomnia[tiab] OR "sleep apnea"[tiab]',
          ["sleep", "energy", "brainFog"]),
    _seed("mood", '"depression"[MeSH Terms] OR "anxiety"[MeSH Terms] OR mood[tiab] '
                  'OR "quality of life"[tiab]', ["mood", "energy"]),
    _seed("cognition", 'cognition[tiab] OR "brain fog"[tiab] OR memory[tiab] OR fatigue[tiab]',
          ["brainFog", "energy"]),
    _seed("pain", '"dysmenorrhea"[MeSH Terms] OR "pelvic pain"[MeSH Terms] OR pain[tiab]',
          ["pain", "painPoints"]),
    _seed("skin", '"acne vulgaris"[MeSH Terms] OR "hirsutism"[MeSH Terms] OR "alopecia"[MeSH Terms] '
                  'OR "acanthosis nigricans"[MeSH Terms]',
          ["acne", "hairGrowth", "hairLoss", "hyperpigmentation", "dryPatches"]),
    _seed("diet", '"diet"[MeSH Terms] OR "glycemic index"[MeSH Terms] OR "dietary carbohydrates"[MeSH Terms] '
                  'OR "dietary fiber"[MeSH Terms]',
          ["dietCarbs", "dietFats", "dietProtein", "dietFibre", "sugar"]),
    _seed("appetite", '"food cravings"[tiab] OR appetite[tiab] OR "binge eating"[MeSH Terms] '
                      'OR "insulin resistance"[MeSH Terms]', ["cravings", "cravingType", "foodDrive", "sugar"]),
    _seed("exercise", '"exercise"[MeSH Terms] OR "physical activity"[tiab]', ["exercise", "energy"]),
    _seed("weight", '"body weight"[MeSH Terms] OR "body mass index"[MeSH Terms] OR "weight loss"[MeSH Terms]',
          ["morningWeight"]),
    _seed("cycle", '"menstrual cycle"[MeSH Terms] OR "oligomenorrhea"[MeSH Terms] '
                   'OR "menstruation disturbances"[MeSH Terms] OR "cycle regularity"[tiab]',
          ["period", "flow"]),
    _seed("contraception", '"contraceptives, oral, hormonal"[MeSH Terms] OR "letrozole"[MeSH Terms] '
                           'OR "metformin"[MeSH Terms] OR "glucagon-like peptide-1"[tiab]',
          ["birthControlType", "period", "flow"]),
    _seed("sexual function", '"sexual dysfunction, physiological"[MeSH Terms] OR "sexual behavior"[MeSH Terms] '
                             'OR libido[tiab]', ["sexDrive"]),
]

# The chapter this product takes the condition's name from. Seeded by id rather
# than by search, because its bibliography is the thing we are actually after.
ANCHOR_PMIDS = ["29083730"]          # StatPearls NBK459251


# ---- keeping one row per paper ----------------------------------------------
def _matches(s, rec: ncbi.Record):
    """Every existing row this record could be. More than one means a duplicate
    pair that was only linked once both ids were known."""
    found, seen = [], set()
    for column, value in ((Source.pmid, rec.pmid), (Source.pmcid, rec.pmcid),
                          (Source.nbk, rec.nbk), (func.lower(Source.doi), rec.doi)):
        if not value:
            continue
        for row in s.query(Source).filter(column == value, Source.merged_into.is_(None)).all():
            if row.id not in seen:
                seen.add(row.id)
                found.append(row)
    return found


def merge(s, keep: Source, drop: Source) -> None:
    """Fold one row into another. The older row wins, so ids already handed out
    — to a report, a claim, a published row — keep pointing at something."""
    # Release the identifiers before claiming them. One row per id is a partial
    # unique index, so a flush that has both rows holding the same DOI — even
    # for the instant between two UPDATEs — is a constraint violation.
    taken = {field: getattr(drop, field) for field in ("pmid", "pmcid", "doi", "nbk")}
    for field in taken:
        setattr(drop, field, None)
    drop.merged_into = keep.id
    s.flush()

    for field, value in taken.items():
        if value and not getattr(keep, field):
            setattr(keep, field, value)
    for field in ("fulltext", "passages", "abstract", "title"):
        if not getattr(keep, field) and getattr(drop, field):
            setattr(keep, field, getattr(drop, field))
    s.query(Citation).filter(Citation.source_id == drop.id).update({"source_id": keep.id})
    s.query(Claim).filter(Claim.source_id == drop.id).update({"source_id": keep.id})


APPLY = ("kind", "title", "abstract", "journal", "book_title", "publisher", "year",
         "authors", "pub_types", "mesh")


def upsert(s, rec: ncbi.Record):
    """One record in, one row out. Returns (row, created)."""
    rows = _matches(s, rec)
    row = rows[0] if rows else None
    if row is None:
        row = Source(first_seen=now())
        s.add(row)
    else:
        for other in rows[1:]:
            merge(s, row, other)

    fresh = rec.hash() != (row.record_hash or "")
    row.last_fetched = now()
    if not fresh:
        return row, False

    for field in APPLY:
        value = getattr(rec, field)
        if value not in ("", None, []):
            setattr(row, field, value)
    # Identifiers are only ever added, never overwritten: a row that already
    # carries a PMID and gains a different one is two papers, not one edit.
    for field in ("pmid", "pmcid", "doi", "nbk"):
        if getattr(rec, field) and not getattr(row, field):
            setattr(row, field, getattr(rec, field))

    if rec.retracted:
        row.retracted = True
    created = row.record_hash in ("", None)
    row.record_hash = rec.hash()
    if row.screen_state in ("", None, "new"):
        row.screen_state, row.screen_reason = auto_screen(rec)

    s.flush()
    _store_citations(s, row, rec)
    return row, created


def _store_citations(s, row: Source, rec: ncbi.Record) -> None:
    if not rec.citations:
        return
    have = s.query(Citation).filter(Citation.source_id == row.id).count()
    if have == len(rec.citations):
        return
    s.query(Citation).filter(Citation.source_id == row.id, Citation.promoted.is_(False)).delete()
    for ref in rec.citations:
        s.add(Citation(source_id=row.id, cited_pmid=ref["pmid"] or None,
                       cited_doi=ref["doi"] or None, raw=ref["raw"]))


def in_window(rec: ncbi.Record, min_year: int = None) -> bool:
    """Is this record inside the corpus window?

    Applied on the way in as well as by `prune_older_than`, and with the same
    two carve-outs, because they have to agree: a search is bounded by its term,
    but citation chaining is not, and a bibliography full of 2015 papers would
    otherwise put back everything a prune had just taken out.
    """
    min_year = min_year or MIN_YEAR
    if rec.kind in KEEP_KINDS or rec.year is None:
        return True
    return rec.year >= min_year


def auto_screen(rec: ncbi.Record):
    """The exclusions a machine can make without judgement, and no others.

    Anything arguable stays `new` and waits for a person — the queue is meant to
    be short, not empty.

    An empty abstract is deliberately not among them. The 2018 international
    guideline — the direct ancestor of the thresholds `criteria.py` cites —
    arrives from PubMed with no abstract and one publication type, "Journal
    Article", and an earlier version of this function threw it out for it. A
    missing abstract is a fact about PubMed's metadata, not about the paper.
    """
    if rec.retracted:
        return "excluded", "retracted"
    lowered = {m.lower() for m in rec.mesh}
    if "animals" in lowered and "humans" not in lowered:
        return "excluded", "animal study"
    return "new", ""


def screen_for_text(source: Source) -> None:
    """After enrichment: is there anything here to appraise at all?

    A source with neither abstract nor full text is not excluded — it is
    `needs_text`, which is a different statement. Excluded means judged and
    rejected; this means the machine has nothing to read and a person has to
    decide whether the paper is worth getting hold of.
    """
    if source.screen_state not in ("new", "", None):
        return
    if not (source.abstract or "").strip() and not (source.fulltext or "").strip():
        source.screen_state = "needs_text"
        source.screen_reason = "no abstract and no open full text"


# ---- pulling a search down --------------------------------------------------
def ensure_seeds(s) -> dict:
    """Adds any seed the database has not seen, and moves the year floor on the
    ones it already has. Nothing else about a stored term is rewritten."""
    added = retuned = 0
    for seed in SEEDS:
        row = s.query(Query).filter(Query.name == seed["name"]).first()
        if row is None:
            s.add(Query(name=seed["name"], term=seed["term"], informs=seed["informs"],
                        min_year=seed["min_year"]))
            added += 1
            continue
        if row.min_year == MIN_YEAR:
            continue
        moved = retune(row.term)
        if moved is None:
            continue
        # The window changed, so what the query has already covered is coverage
        # of a different question. Start again rather than claim it.
        row.term, row.min_year, row.high_water = moved, MIN_YEAR, ""
        retuned += 1
    s.commit()
    return {"added": added, "retuned": retuned}


def _today() -> str:
    return dt.date.today().strftime("%Y/%m/%d")


def start(s, client: ncbi.Client, query: Query, today=_today) -> Run:
    """Searches, and records where the answer is being held.

    Incremental by entry date: a query that has run before asks only for what
    was added since, which is what keeps a nightly sync cheap.
    """
    mindate = query.high_water or ""
    edat_to = today()
    search = client.esearch(query.term, mindate=mindate, maxdate=edat_to if mindate else "")
    run = Run(query_id=query.id, state="running", webenv=search.webenv,
              query_key=search.query_key, total=search.count,
              edat_from=mindate, edat_to=edat_to)
    s.add(run)
    s.commit()
    return run


def _resume_search(s, client: ncbi.Client, run: Run) -> ncbi.Search:
    """The History server does not hold a result forever. When it has let go,
    re-run the search and keep the cursor — the ordering is stable, so the
    records already taken are the same ones."""
    query = run.query or s.get(Query, run.query_id)
    search = client.esearch(query.term, mindate=run.edat_from,
                            maxdate=run.edat_to if run.edat_from else "")
    run.webenv, run.query_key, run.total = search.webenv, search.query_key, search.count
    s.commit()
    return search


def advance(s, client: ncbi.Client, run: Run, batches: int = 1, batch: int = ncbi.BATCH) -> dict:
    """Fetch, store, commit the cursor. Repeat. Stop when the run is done."""
    stats = {"fetched": 0, "added": 0, "batches": 0}
    search = ncbi.Search(webenv=run.webenv, query_key=run.query_key, count=run.total)
    target = wanted(run)

    for _ in range(batches):
        if run.cursor >= target:
            run.state, run.finished_at = "done", now()
            _mark_covered(s, run)
            s.commit()
            break
        # Never ask for more than is still wanted. Without this a cap of 40 still
        # pulls a full batch of 200 and stores all of them, which makes "a look
        # at 40 of 1,200" a false description of what just happened.
        take = min(batch, target - run.cursor)
        try:
            xml = client.efetch_history(search, run.cursor, take)
        except ncbi.NcbiUnavailable:
            run.state, run.error = "paused", "NCBI unavailable"
            s.commit()
            raise
        except ncbi.NcbiError:
            search = _resume_search(s, client, run)
            xml = client.efetch_history(search, run.cursor, take)

        records = ncbi.parse_records(xml)
        added = 0
        for rec in records:
            if not in_window(rec):
                continue
            _, created = upsert(s, rec)
            added += int(created)
        # Advance by what was asked for, not by what came back: a window
        # containing deleted citations returns fewer records than requested, and
        # advancing by the count would fetch that window for ever.
        run.cursor = min(run.cursor + take, target)
        run.fetched = (run.fetched or 0) + len(records)
        run.added = (run.added or 0) + added
        stats["fetched"] += len(records)
        stats["added"] += added
        stats["batches"] += 1
        s.commit()

    return stats


def wanted(run: Run) -> int:
    """How many of the run's results we mean to take. A capped run is a look at
    a seed, not a harvest of it."""
    return min(run.total or 0, run.cap) if run.cap else (run.total or 0)


def _mark_covered(s, run: Run) -> None:
    """A finished run moves the query's high-water mark, so the next one asks
    only for what has appeared since.

    A capped run must not: it stopped early by choice, and moving the mark past
    records nobody fetched would lose them silently and for good.
    """
    if run.cap and run.cap < (run.total or 0):
        return
    query = run.query or s.get(Query, run.query_id)
    if query is not None and run.edat_to:
        query.high_water = run.edat_to


def harvest(s, client: ncbi.Client, query: Query, max_records: int | None = None,
            batch: int = ncbi.BATCH) -> Run:
    """One query, start to finish. `max_records` caps a first look at a seed."""
    run = start(s, client, query)
    if max_records is not None:
        run.cap = max_records
        s.commit()
    while run.state == "running":
        advance(s, client, run, batches=1, batch=batch)
    return run


def harvest_ids(s, client: ncbi.Client, ids, batch: int = ncbi.BATCH) -> dict:
    """Fetch particular records by id — the anchor chapter, or a promoted
    reference list."""
    ids = [i for i in ids if i]
    stats = {"fetched": 0, "added": 0, "outsideWindow": 0}
    for start_at in range(0, len(ids), batch):
        chunk = ids[start_at:start_at + batch]
        for rec in ncbi.parse_records(client.efetch_ids(chunk)):
            stats["fetched"] += 1
            if not in_window(rec):
                stats["outsideWindow"] += 1
                continue
            _, created = upsert(s, rec)
            stats["added"] += int(created)
        s.commit()
    return stats


def promote_citations(s, client: ncbi.Client, source: Source, limit: int = 100) -> dict:
    """Pull what a source cites into the corpus.

    Higher-yield and lower-noise than any keyword sweep, because somebody with
    the expertise already decided these were the papers worth citing.
    """
    rows = (s.query(Citation)
            .filter(Citation.source_id == source.id, Citation.promoted.is_(False),
                    Citation.cited_pmid.isnot(None))
            .limit(limit).all())
    stats = harvest_ids(s, client, [r.cited_pmid for r in rows])
    for row in rows:
        row.promoted = True   # tried, whether or not it landed inside the window
    s.commit()
    stats["promoted"] = len(rows)
    return stats


# ---- licence, full text, retraction ------------------------------------------
def _words(text: str):
    return [w for w in re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower()).split() if len(w) > 2]


def titles_match(a: str, b: str, threshold: float = 0.6) -> bool:
    """Is the document we just fetched the one we asked for?

    Checked at the moment of use rather than at the moment of storage, because
    the harm from a wrong cross-reference is attaching one paper's text to
    another paper's row — and that happens here, not in the id list.
    """
    first, second = set(_words(a)), set(_words(b))
    if not first or not second:
        return False
    overlap = len(first & second) / min(len(first), len(second))
    return overlap >= threshold


def _flag(row: Source, name: str) -> None:
    flags = list(row.flags or [])
    if name not in flags:
        flags.append(name)
        row.flags = flags


def enrich(s, client: ncbi.Client, source: Source, want_fulltext: bool = True) -> str:
    """Licence and retraction for one source, plus full text if we may store it.

    Returns what happened, in a word, so a run can be summarised without
    re-reading the rows.
    """
    outcome = _enrich(client, source, want_fulltext)
    screen_for_text(source)
    s.commit()
    return outcome


def _enrich(client: ncbi.Client, source: Source, want_fulltext: bool) -> str:
    source.oa_checked_at = now()
    if not source.pmcid:
        source.is_oa = False
        return "no-pmcid"

    record = client.oa(source.pmcid)
    if record is None:
        # Not in the Open Access subset. Metadata and a link, and never more:
        # PMC's terms allow retrieval only through their own services, and this
        # one has just told us it will not serve this paper.
        source.is_oa = False
        return "not-oa"

    source.is_oa = True
    source.licence = record["licence"]
    if record["retracted"]:
        source.retracted = True
    if not want_fulltext or source.fulltext:
        return "metadata"

    try:
        text, passages = client.bioc(source.pmcid)
    except ncbi.NcbiError as e:
        # Being in the OA subset does not mean BioC holds a machine-readable
        # copy; it answers for those it does not with a plain-text error. The
        # licence and the retraction status are what we came for, and we have
        # them, so this is an outcome rather than a failure.
        _flag(source, "no_bioc")
        source.screen_reason = str(e)[:200]
        return "no-fulltext"
    heading = next((text[p["offset"]:p["offset"] + p["len"]]
                    for p in passages if p["section"] == "TITLE"), "")
    if heading and not titles_match(heading, source.title):
        _flag(source, "id_mismatch")
        source.screen_reason = f"PMC text titled {heading[:80]!r}"
        return "id-mismatch"

    source.fulltext, source.passages = text, passages
    return "fulltext"


def sweep(s, client: ncbi.Client, limit: int = 500, batch: int = ncbi.BATCH) -> dict:
    """Re-read retraction status across the corpus, and un-publish what it costs.

    A retraction after publication is the failure this module exists to avoid
    being slow about, so revocation is automatic and the reviewer is told after
    the fact rather than asked first.
    """
    rows = (s.query(Source)
            .filter(Source.pmid.isnot(None), Source.merged_into.is_(None),
                    Source.retracted.is_(False))
            .order_by(Source.last_fetched.asc()).limit(limit).all())
    by_pmid = {r.pmid: r for r in rows}
    found, revoked = [], 0

    ids = list(by_pmid)
    for start_at in range(0, len(ids), batch):
        chunk = ids[start_at:start_at + batch]
        for rec in ncbi.parse_records(client.efetch_ids(chunk)):
            row = by_pmid.get(rec.pmid)
            if row is None:
                continue
            row.last_fetched = now()
            if rec.retracted and not row.retracted:
                row.retracted = True
                row.screen_state, row.screen_reason = "excluded", "retracted"
                revoked += revoke_published(s, row, f"retracted (notice {rec.retraction_pmid})")
                found.append(row.pmid)
        s.commit()

    return {"checked": len(ids), "retracted": found, "revoked": revoked}


# A guideline is not a study, and this product is built on one: `criteria.py`
# quotes the 2023 international guideline for every threshold it applies. A
# window that removed it would leave the evidence module unable to show the
# document the patient app cites. Chapters are kept for the same reason — the
# corpus is anchored on one.
KEEP_KINDS = ("guideline", "chapter")


def prune_older_than(s, min_year: int = None, confirm: bool = False,
                     keep_kinds=KEEP_KINDS) -> dict:
    """Drop studies published before the corpus window, and everything hanging
    off them.

    Deleting rather than excluding, because "excluded" is a judgement about a
    paper and this is a decision about the library: a 2019 study is not a bad
    study, it is outside what this corpus covers. Defaults to a dry run — the
    count comes back before anything goes.

    Undated records are left alone. An absent year is a gap in PubMed's
    metadata, and deleting on missing metadata is the mistake that threw out the
    2018 guideline once already.
    """
    min_year = min_year or MIN_YEAR
    rows = (s.query(Source)
            .filter(Source.year.isnot(None), Source.year < min_year,
                    Source.kind.notin_(keep_kinds) if keep_kinds else True).all())
    ids = [r.id for r in rows]
    undated = s.query(Source).filter(Source.year.is_(None)).count()
    claim_ids = [c.id for c in s.query(Claim.id).filter(Claim.source_id.in_(ids or [0])).all()]

    spared = (s.query(Source)
              .filter(Source.year.isnot(None), Source.year < min_year,
                      Source.kind.in_(keep_kinds)).count() if keep_kinds else 0)
    plan = {"sources": len(ids), "claims": len(claim_ids), "undatedKept": undated,
            "keptAsReference": spared, "keepKinds": list(keep_kinds or ()),
            "published": s.query(Published).filter(
                Published.claim_id.in_(claim_ids or [0])).count(),
            "minYear": min_year, "confirmed": bool(confirm)}
    if not confirm or not ids:
        return plan

    # Children first: these are plain foreign keys with no cascade behind them.
    s.query(Published).filter(Published.claim_id.in_(claim_ids or [0])).delete(synchronize_session=False)
    s.query(Review).filter(Review.claim_id.in_(claim_ids or [0])).delete(synchronize_session=False)
    s.query(Review).filter(Review.source_id.in_(ids)).delete(synchronize_session=False)
    s.query(ClaimField).filter(ClaimField.claim_id.in_(claim_ids or [0])).delete(synchronize_session=False)
    s.query(Claim).filter(Claim.source_id.in_(ids)).delete(synchronize_session=False)
    s.query(Report).filter(Report.source_id.in_(ids)).delete(synchronize_session=False)
    s.query(Citation).filter(Citation.source_id.in_(ids)).delete(synchronize_session=False)
    s.query(Source).filter(Source.id.in_(ids)).delete(synchronize_session=False)
    s.commit()
    return plan


def revoke_published(s, source: Source, reason: str) -> int:
    """Take a source's claims off the patient side. One update, no HTTP call —
    the app reads the table, so a revocation is live the moment it commits."""
    claim_ids = [c.id for c in s.query(Claim.id).filter(Claim.source_id == source.id).all()]
    if not claim_ids:
        return 0
    rows = (s.query(Published)
            .filter(Published.claim_id.in_(claim_ids), Published.revoked_at.is_(None)).all())
    for row in rows:
        row.revoked_at = now()
        row.revoked_reason = reason
    return len(rows)
