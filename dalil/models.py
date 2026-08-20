"""
Dalīl (دليل) — the tables behind the evidence module.

Everything here is prefixed `dalil_` and lives in the same Postgres as the
patient app, in its own tables. The patient app reads exactly one of them —
`dalil_published` — and never the working tables, so a half-reviewed claim
cannot reach a person by accident.

Creation follows the house pattern (see backend/main.py:98): `create_all` for a
fresh database, then a forward-only block of statements for an existing one. No
Alembic. Additive only.
"""
import datetime as dt
import os

from sqlalchemy import (JSON, Boolean, Column, DateTime, ForeignKey, Integer,
                        String, Text, create_engine, text)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql+psycopg2://myno:myno@db:5432/myno")

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
Session = sessionmaker(bind=engine, autoflush=False)
Base = declarative_base()

now = dt.datetime.utcnow


# ---- who reviews ------------------------------------------------------------
class Reviewer(Base):
    """A named person. Reviews are signed, which is the point of the module."""
    __tablename__ = "dalil_reviewers"
    id = Column(Integer, primary_key=True)
    email = Column(String, unique=True, nullable=False)
    name = Column(String, default="")
    password_hash = Column(String, nullable=False)
    role = Column(String, default="reviewer")        # reviewer | admin
    created_at = Column(DateTime, default=now)
    disabled_at = Column(DateTime, nullable=True)


class SessionRow(Base):
    """A login. Only the sha256 of the token is stored, so a database dump is
    not a set of live sessions."""
    __tablename__ = "dalil_sessions"
    id = Column(Integer, primary_key=True)
    reviewer_id = Column(Integer, ForeignKey("dalil_reviewers.id"))
    token_sha256 = Column(String, unique=True, nullable=False)
    created_at = Column(DateTime, default=now)
    last_seen = Column(DateTime, default=now)
    expires_at = Column(DateTime, nullable=False)
    revoked_at = Column(DateTime, nullable=True)
    reviewer = relationship("Reviewer")


# ---- what we searched for, and what came back -------------------------------
class Query(Base):
    """A search strategy, kept as an object so a corpus is reproducible."""
    __tablename__ = "dalil_queries"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    term = Column(Text, nullable=False)
    db = Column(String, default="pubmed")
    informs = Column(JSON, default=list)             # record.py field keys this seed exists for
    min_year = Column(Integer, nullable=True)
    enabled = Column(Boolean, default=True)
    high_water = Column(String, default="")          # last edat covered, YYYY/MM/DD
    created_at = Column(DateTime, default=now)


class Run(Base):
    """One execution of a query. `cursor` is committed after every batch, which
    is the whole resumability story: a restart picks up where it stopped."""
    __tablename__ = "dalil_runs"
    id = Column(Integer, primary_key=True)
    query_id = Column(Integer, ForeignKey("dalil_queries.id"))
    state = Column(String, default="running")        # running | done | failed | paused
    webenv = Column(String, default="")
    query_key = Column(String, default="")
    total = Column(Integer, default=0)
    cursor = Column(Integer, default=0)
    fetched = Column(Integer, default=0)
    added = Column(Integer, default=0)
    edat_from = Column(String, default="")
    edat_to = Column(String, default="")
    started_at = Column(DateTime, default=now)
    finished_at = Column(DateTime, nullable=True)
    error = Column(Text, default="")
    query = relationship("Query")


class Source(Base):
    """A paper, a chapter or a guideline.

    `fulltext` is populated only for the PMC Open Access Subset. Everything else
    keeps abstract and metadata, because the licence does not permit more and
    because PMC's terms allow retrieval only through their own services.
    """
    __tablename__ = "dalil_sources"
    id = Column(Integer, primary_key=True)
    pmid = Column(String, nullable=True)
    pmcid = Column(String, nullable=True)
    doi = Column(String, nullable=True)
    nbk = Column(String, nullable=True)              # Bookshelf accession, e.g. NBK459251
    kind = Column(String, default="article")         # article | chapter | guideline

    title = Column(Text, default="")
    abstract = Column(Text, default="")
    journal = Column(String, default="")
    book_title = Column(String, default="")
    publisher = Column(String, default="")
    year = Column(Integer, nullable=True)
    authors = Column(JSON, default=list)
    pub_types = Column(JSON, default=list)
    mesh = Column(JSON, default=list)

    is_oa = Column(Boolean, default=False)
    licence = Column(String, default="")
    retracted = Column(Boolean, default=False)
    oa_checked_at = Column(DateTime, nullable=True)

    fulltext = Column(Text, nullable=True)           # OA subset only
    passages = Column(JSON, nullable=True)           # [{offset, section_type, len}]

    record_hash = Column(String, default="")
    first_seen = Column(DateTime, default=now)
    last_fetched = Column(DateTime, default=now)

    screen_state = Column(String, default="new")     # new | included | excluded | appraised
    screen_reason = Column(String, default="")
    merged_into = Column(Integer, nullable=True)     # set when deduped into another row


class Citation(Base):
    """A reference a source cites. A reference work's bibliography is the best
    corpus seed there is — a domain expert already did the screening."""
    __tablename__ = "dalil_citations"
    id = Column(Integer, primary_key=True)
    source_id = Column(Integer, ForeignKey("dalil_sources.id"))
    cited_pmid = Column(String, nullable=True)
    cited_doi = Column(String, nullable=True)
    raw = Column(Text, default="")
    promoted = Column(Boolean, default=False)        # pulled into the corpus as its own source


# ---- what we made of them ---------------------------------------------------
class Report(Base):
    """One appraisal of one source under one rubric. Unique on
    (source, prompt_version, rubric_version), so a rubric change adds a report
    rather than overwriting one a human already reviewed."""
    __tablename__ = "dalil_reports"
    id = Column(Integer, primary_key=True)
    source_id = Column(Integer, ForeignKey("dalil_sources.id"))
    prompt_version = Column(String, default="")
    rubric_version = Column(String, default="")
    score = Column(Integer, default=0)
    verdict = Column(String, default="")             # meets | considerations | does_not_meet
    modules = Column(JSON, default=list)             # [{key, weight, score, basis, quote}]
    flags = Column(JSON, default=list)
    narrative = Column(Text, default="")
    model = Column(String, default="")
    inputs_hash = Column(String, default="")
    tokens_in = Column(Integer, default=0)
    tokens_out = Column(Integer, default=0)
    created_at = Column(DateTime, default=now)
    source = relationship("Source")


class Claim(Base):
    """One finding, bound to the app's vocabulary and carrying the verbatim
    sentence it came from. A claim whose quote cannot be found in the stored
    text never reaches a reviewer."""
    __tablename__ = "dalil_claims"
    id = Column(Integer, primary_key=True)
    source_id = Column(Integer, ForeignKey("dalil_sources.id"))
    report_id = Column(Integer, ForeignKey("dalil_reports.id"), nullable=True)
    state = Column(String, default="extracted")      # extracted|accepted|edited|rejected|published|unpublished

    claim_text = Column(Text, default="")
    relation = Column(String, default="associated_with")
    direction = Column(String, default="")           # + | - | 0
    population = Column(Text, default="")
    effect = Column(JSON, default=dict)              # {measure, value, ci_low, ci_high, p}
    certainty = Column(String, default="")           # high | moderate | low | very_low

    quote = Column(Text, default="")
    quote_section = Column(String, default="")       # ABSTRACT, RESULTS, …
    quote_offset = Column(Integer, default=-1)
    quote_verified = Column(Boolean, default=False)

    display_text = Column(Text, default="")          # the reviewer's own words, shown to patients
    tracker = Column(JSON, nullable=True)            # a proposed thing to track, if any
    extracted_by = Column(String, default="")
    created_at = Column(DateTime, default=now)
    source = relationship("Source")


class ClaimField(Base):
    """Which of record.py's field keys a claim touches, and how. A join rather
    than two columns, because a claim can carry a moderator as well."""
    __tablename__ = "dalil_claim_fields"
    id = Column(Integer, primary_key=True)
    claim_id = Column(Integer, ForeignKey("dalil_claims.id"))
    field_key = Column(String, nullable=False)
    role = Column(String, default="exposure")        # exposure | outcome | moderator
    proposed = Column(Boolean, default=False)        # not in record.py yet


class Review(Base):
    """Append-only. Current state lives on the row; who changed what, when, and
    what it said before lives here."""
    __tablename__ = "dalil_reviews"
    id = Column(Integer, primary_key=True)
    reviewer_id = Column(Integer, ForeignKey("dalil_reviewers.id"))
    claim_id = Column(Integer, ForeignKey("dalil_claims.id"), nullable=True)
    source_id = Column(Integer, ForeignKey("dalil_sources.id"), nullable=True)
    action = Column(String, nullable=False)
    before = Column(JSON, default=dict)
    after = Column(JSON, default=dict)
    note = Column(Text, default="")
    created_at = Column(DateTime, default=now)
    reviewer = relationship("Reviewer")


class Published(Base):
    """The trust boundary, as a table.

    The patient app reads this and nothing else from Dalīl. A row exists here
    only because a named person put it here.
    """
    __tablename__ = "dalil_published"
    id = Column(Integer, primary_key=True)
    claim_id = Column(Integer, ForeignKey("dalil_claims.id"))
    correlation_id = Column(String, nullable=True)   # insights.CORRELATIONS id, when the pair matches one
    field_keys = Column(JSON, default=list)
    display_text = Column(Text, default="")
    grade = Column(String, default="")               # Strong | Emerging | Early
    citation = Column(JSON, default=dict)            # {pmid, title, journal, year, url}
    tracker = Column(JSON, nullable=True)
    published_by = Column(Integer, ForeignKey("dalil_reviewers.id"))
    published_at = Column(DateTime, default=now)
    revoked_at = Column(DateTime, nullable=True)
    revoked_reason = Column(String, default="")


# ---- creation and forward-only migrations -----------------------------------
# Partial unique indexes are written by hand: a NULL pmid must not collide with
# another NULL pmid, which a plain unique constraint would allow but a unique
# index over the whole column would make confusing to reason about.
MIGRATIONS = [
    "CREATE UNIQUE INDEX IF NOT EXISTS dalil_sources_pmid_uq  ON dalil_sources (pmid)  WHERE pmid  IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS dalil_sources_pmcid_uq ON dalil_sources (pmcid) WHERE pmcid IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS dalil_sources_doi_uq   ON dalil_sources (lower(doi)) WHERE doi IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS dalil_sources_nbk_uq   ON dalil_sources (nbk)   WHERE nbk   IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS dalil_published_corr_idx ON dalil_published (correlation_id)",
    "CREATE INDEX IF NOT EXISTS dalil_claims_source_idx  ON dalil_claims (source_id)",
]


def init_db():
    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        for statement in MIGRATIONS:
            conn.execute(text(statement))
